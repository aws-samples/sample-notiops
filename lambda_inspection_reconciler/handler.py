"""巡检对账 Lambda（R13.13 / R13.13a / R13.13b）。

每小时被一条 EventBridge Rule 唤醒，回答一个问题：
**已派发的判读任务，主路径的事件是不是丢了。**

```
EventBridge (rate 1 hour)
   │
   ├─ 逐账号 Query「已派发但判读没回来」的 finding      8.1
   ├─ 按 task_id 去重 → 读派发映射拿 dispatched_at
   ├─ 超 2h 仍非终态 → GetBacklogTask 核实            8.2
   ├─ 终态 → 把降级原因挂到该 task 覆盖的每条 finding   8.2 / 8.2a
   └─ EMF 打点（对账了多少 / 补齐多少 / 多少还在等）
```

## ⚠️ 设计写的「扩展既有对账 Lambda（不新建）」前提是错的

本仓**没有**对账 Lambda。全部 EventBridge Rule 都是每日 cron 或事件驱动，
没有任何 `rate(1 hour)` 的调度；`devops_agent_callback` 是纯事件驱动、没有
定时触发。早期设计里画的「对账 Lambda（每小时，扩展既有实现）」指向一个
不存在的组件。⇒ 这里新建。

## 🔴 这个 Lambda 绝不因「跑得久」判死任何任务

判死重投一条排队中的任务 → 队列更长 → 更多任务排队 → 更多被判死重投，
**正反馈**，额度烧光且永不收敛。全部判定都在
`inspection/domain/dispatch_recon.py`（纯函数、有单测），本文件只做 IO。
理由与五个长期非终态的清单见那个模块的 docstring。

## 幂等

对账把降级原因写进 finding 行的 `da_parse_status`（与 callback 走同一个字段，
经 `attach_judgment`）。同一条被对两次的结果一样，所以不需要额外的锁 ——
`attach_judgment` 本身带 `attribute_exists(PK)` 条件，行不在就跳过。
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any

from inspection.adapters.store import InspectionStore
from inspection.domain.dispatch_recon import needs_probe, verdict_of

logger = logging.getLogger()
logger.setLevel(logging.INFO)

MAX_PROBES_PER_RUN = 200
"""单次对账最多问多少个 task。

⚠️ 上界不是性能考虑，是**成本与故障放大**的考虑：如果某天有 5000 条
finding 卡住（比如 agent space 配错了），无上界会让这一次对账打 5000 次
`GetBacklogTask`，而每次对账都会重来。有上界时它会分多轮慢慢清，
而 EMF 上的 `ReconcilePending` 会一直高着 —— 那是要人看的信号。
"""


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def handler(event: Mapping[str, Any], context: Any = None) -> dict[str, Any]:
    """Lambda 入口。"""
    now = datetime.now(timezone.utc)
    table_name = _env("INSPECTION_TABLE")
    config_table = _env("CONFIG_TABLE")
    if not table_name or not config_table:
        # ⚠️ 直接抛。返回 {"probed": 0} 会让「env 漏配」看起来和
        #    「本轮没有要对的账」一模一样 —— 前者要人来修，后者是常态。
        raise RuntimeError("缺环境变量: INSPECTION_TABLE / CONFIG_TABLE")

    import boto3

    region = _env("AWS_REGION", "ap-northeast-1")
    ddb = boto3.resource("dynamodb", region_name=region)
    store = InspectionStore(ddb.Table(table_name))
    cfg_tbl = ddb.Table(config_table)

    # kill switch：巡检整体停掉时对账也停 —— 否则它会继续对一批
    # 永远不会有人处理的任务打 API。
    from inspection.adapters import switches

    if not switches.is_enabled(cfg_tbl, switches.Switch.INSPECTION):
        logger.warning("巡检已被 kill switch 停用，跳过本轮对账")
        return {"probed": 0, "disabled_by": switches.Switch.INSPECTION.value}

    from inspection.adapters.accounts import enabled_accounts

    accounts = enabled_accounts(cfg_tbl)

    stats = {"accounts": len(accounts), "awaiting": 0, "probed": 0,
             "resolved": 0, "still_running": 0, "unknown_status": 0,
             "no_mapping": 0, "probe_failed": 0, "attached": 0,
             # 🔴 判读目标解析失败的账号数（改动⑤）。
             #    原来这里是**一个共用** `boto3.client("devops-agent")`，
             #    而成员账号的 space 在它们自己账号里 —— 用部署账号的 client 去
             #    `GetBacklogTask` 会 ResourceNotFoundException，而本模块明确规定
             #    「拿不到状态什么都不做」⇒ 对账兜底整条变 no-op，且完全静默。
             "da_target_unresolved": 0}

    from inspection.adapters import da_client as _da_res

    for account_id in accounts:
        # ⚠️ **按账号解析** client：部署账号用本地，成员账号 assume 进去。
        #    解析失败只跳过这个账号，其余继续（与本模块「单账号失败不影响其余」
        #    的既有约定一致）。
        try:
            _space, da = _da_res.resolve(
                account_id, deploy_account_id=_env("DEPLOY_ACCOUNT_ID"),
                home_region=region, config_table=cfg_tbl,
                env_space_id=_env("INSPECT_AGENT_SPACE_ID"),
                source="inspection-reconcile")
        except Exception as e:                 # noqa: BLE001
            stats["da_target_unresolved"] += 1
            logger.error(
                "account=%s 判读目标解析失败，本轮跳过它的对账: %s", account_id, e)
            continue
        _reconcile_account(store, da, account_id, now=now, stats=stats)
        if stats["probed"] >= MAX_PROBES_PER_RUN:
            logger.warning("本轮 probe 数达上界 %d，剩余留给下一轮",
                           MAX_PROBES_PER_RUN)
            break

    # ── 8.3 采集覆盖对账（缺账号行 / completeness < 95%）
    coverage = _audit_coverage(store, accounts, now=now)
    stats.update(coverage)

    logger.info("对账完成: %s", stats)
    _emit(stats)
    return stats


def _audit_coverage(
    store: InspectionStore, accounts: Sequence[str], *, now: datetime,
) -> dict[str, int]:
    """比对今天该跑的账号与实际的 run 行（R13.13 / R13.14）。

    ⚠️ 判定全在 `inspection/domain/coverage.py`（纯函数、有单测），
    这里只做 IO。

    ⚠️ 对**今天**做。查昨天会在跨 UTC 日界的那一小时里把还没跑的今天
    误报成缺行；而查更早的日子没有意义 —— 那些已经补不回来了，
    对账的作用是让人在当天就知道。
    """
    from inspection.domain.coverage import audit_coverage, to_stats
    from inspection.domain.schedule import RunType

    out = {"coverage_missing_rows": 0, "coverage_low": 0,
           "coverage_missing_instances": 0, "backfill_sent": 0,
           "backfill_skipped": 0}
    today = now.date()
    for run_type in RunType:
        try:
            rows = store.runs_for(run_type.value, today)
        except Exception as e:                 # noqa: BLE001
            logger.exception("读 run 行失败 %s/%s: %s", run_type.value, today, e)
            continue
        # ⚠️ 只有**已经有过任何一行**的类型才做缺行判定。
        #    一个类型今天压根还没到执行时刻（比如闲置轮排在 03:00 而现在
        #    01:00）时，全部账号都「缺行」—— 那不是缺口，是还没到点。
        #    有一行就说明这一轮已经开始派了，那时缺的才是真缺。
        if not rows:
            continue
        report = audit_coverage(
            run_type=run_type.value, run_date=today,
            expected_accounts=list(accounts), rows=rows)
        s = to_stats(report)
        out["coverage_missing_rows"] += s.missing_rows
        out["coverage_low"] += s.low_completeness
        out["coverage_missing_instances"] += s.missing_instances
        if report.gaps:
            logger.warning("%s/%s 采集缺口: 缺行 %d，完整度不足 %d，共缺 %d 台；%s",
                           run_type.value, today, s.missing_rows,
                           s.low_completeness, s.missing_instances, s.accounts)
            # ── 8.4 自动补齐重投（R13.15）
            sent, skipped = _dispatch_backfill(
                store, report.gaps, rows=rows, run_date=today)
            out["backfill_sent"] += sent
            out["backfill_skipped"] += skipped
        try:
            from inspection.adapters import metrics

            metrics.emit_coverage(s, run_type=run_type.value)
        except Exception:                      # noqa: BLE001
            logger.exception("覆盖打点失败（不影响结果）")
    return out


def _dispatch_backfill(
    store: InspectionStore, gaps: Sequence[Any], *,
    rows: Mapping[str, Mapping[str, Any]], run_date: Any,
) -> tuple[int, int]:
    """把采集缺口变成补齐消息发进队列（R13.15）。

    返回 `(发出去几条, 跳过几条)`。**从不抛** —— 补齐是尽力而为，
    它挂了不该让对账的检测与告警一起失效（那两个是更重要的兜底）。

    🔴 走**独立 run_id**，不碰原 run 的锁。原因见
    `inspection/domain/backfill.py` 的模块 docstring：`partial` 既不阻塞
    `due_runs` 也不阻塞 `try_acquire_run_lock`，两处刻意且矛盾，
    重派原消息必然被拒。

    ⚠️ `data_date` 用**缺口那一轮的** `data_date`（从 run 行读），不是今天。
    用今天会让补回来的点落在错误的日期上，而 `series_sk` 用 `data_date`
    做键（R13.10）—— 表现是补齐「成功」了但那天的窗口还是缺。
    """
    queue_url = _env("INSPECTION_QUEUE_URL")
    if not queue_url:
        # 没配队列 URL → 只检测不补齐。**记 warning 而不是静默** ——
        # 否则「为什么缺口一直在」查不到「因为补齐压根没配」。
        logger.warning("INSPECTION_QUEUE_URL 未配置，缺口只告警不自动补齐")
        return 0, len(gaps)

    from inspection.domain.backfill import plan_backfill

    # 每个账号已经补过几次 —— 从**独立账本分区**读（不是 run 行；
    # 写在 run 行上会建出占死锁的桩行，见 `keys.Prefix.BACKFILL`）。
    run_type = str(next(iter(gaps)).run_type) if gaps else ""
    try:
        ledger = store.load_backfill_attempts(run_type, run_date)
    except Exception as e:                     # noqa: BLE001
        # 读不到当「没补过」—— 方向是多补一次而不是不补，而 max_attempts
        # 在下一轮读成功时仍会封住正反馈。
        logger.error("读补齐账本失败，按没补过处理: %s", e)
        ledger = {}
    attempts = {
        (run_type, acct, run_date.isoformat()): row
        for acct, row in ledger.items()
    }
    # 没被评估到的实例清单。run 行的 stats 里若没有就发全量补。
    missing_instances: dict[tuple[str, str], list[str]] = {}
    for acct, r in rows.items():
        stats_blob = r.get("stats") or {}
        ids = stats_blob.get("missing_instance_ids") or r.get(
            "missing_instance_ids") or []
        if ids:
            missing_instances[(str(r.get("run_type") or ""), acct)] = [
                str(i) for i in ids]

    # 🔴 `data_date` 取**缺口那一轮的**，不是今天（R13.10：序列 SK 用数据窗口
    #    日期）。用今天会让补回来的点落在错误日期上 —— 表现是补齐「成功」了
    #    而那天的窗口还是缺。
    #    ⚠️ 本轮 review 抓到的缺陷：这里原本传 `data_date=run_date`（= 今天），
    #    只靠 `_send_backfill` 里另起一路从 run 行重读才侥幸对上。于是
    #    `BackfillPlan.data_date` 字段里装的是**错值**，后人只要改成用
    #    `plan.data_date` 就会静默引入 R13.10 违规。现在两处同源。
    plans = plan_backfill(gaps, data_date=run_date, attempts=attempts,
                          missing_instances=missing_instances,
                          data_date_by_account=_data_dates(rows))
    if not plans:
        return 0, len(gaps)

    import boto3

    sqs = boto3.client("sqs", region_name=_env("AWS_REGION", "ap-northeast-1"))
    sent = 0
    for plan in plans:
        try:
            _send_backfill(sqs, queue_url, store, plan,
                           row=rows.get(plan.account_id) or {})
            sent += 1
        except Exception as e:                 # noqa: BLE001
            # 逐条兜住：一个账号发失败不该让其余的补齐一起没了。
            logger.error("补齐消息发送失败 %s/%s: %s",
                         plan.run_type, plan.account_id, e)
    logger.info("补齐重投: 发出 %d 条（计划 %d 条）", sent, len(plans))
    return sent, len(plans) - sent


def _send_backfill(sqs: Any, queue_url: str, store: InspectionStore,
                   plan: Any, *, row: Mapping[str, Any]) -> None:
    """发一条补齐消息 + 记次数。

    ⚠️ **先发消息再记次数**：反过来（先记次数）时若发送失败，那个账号的
    补齐配额就白扣了一次，而缺口还在。反过来的代价是「发成功但记次数失败」
    会多补一次 —— 多补一次比少补一次好（缺口是要补的，重复补是幂等的：
    序列行按 `data_date` 做键，写第二遍是同样的值）。
    """
    from inspection.domain.fanout import InspectionMessage
    from inspection.domain.schedule import DataSource, RunMode, RunType

    msg = InspectionMessage(
        run_type=RunType(plan.run_type),
        account_id=plan.account_id,
        run_date=plan.run_date,
        # ⚠️ 直接用 `plan.data_date` —— 它已经是原轮那天的（`_data_dates`
        #    喂给 `plan_backfill`）。此前这里另起一路从 `row` 重读，
        #    于是同一个口径有两处实现，而 plan 上那个字段是错的。
        data_date=plan.data_date,
        # 🔴 `REFETCH` 而不是 `REUSE`：缺口的定义就是「那些点没采到」，
        #    复用只会把同一份缺数据再读一遍，补齐必然无效果而且看起来成功。
        source=DataSource.REFETCH,
        mode=RunMode.OFFICIAL,
        tier=_tier_of(row),
        config_version=str(row.get("config_version") or "") or "backfill",
        catch_up=True,
        instance_subset=plan.instance_subset,
        backfill_run_id=plan.backfill_run_id,
    )
    sqs.send_message(QueueUrl=queue_url, MessageBody=msg.to_body(),
                     MessageAttributes={
                         "dedupe_id": {"DataType": "String",
                                       "StringValue": msg.dedupe_id()}})
    store.bump_backfill_attempt(
        plan.run_type, plan.account_id, plan.run_date,
        attempt=plan.attempt, backfill_run_id=plan.backfill_run_id)


def _data_dates(rows: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """`{account_id: 原轮的 data_date}`。解析不了的账号直接不收进来 ——
    `plan_backfill` 那侧会回落到兜底值。

    ⚠️ 不抛：一行日期写坏了不该让整批补齐不发。
    """
    from datetime import date as _date

    out: dict[str, Any] = {}
    for acct, r in rows.items():
        raw = str(r.get("data_date") or "")
        if not raw:
            continue
        try:
            out[acct] = _date.fromisoformat(raw)
        except ValueError:
            logger.warning("run 行的 data_date 解析失败，补齐将用兜底日期: "
                           "account=%s raw=%r", acct, raw)
    return out


def _tier_of(row: Mapping[str, Any]) -> Any:
    """从 run 行读 tier，读不到用 NORMAL。

    ⚠️ 不抛：一行缺 tier 不该让补齐整个不发。
    """
    from inspection.domain.budget import Tier

    try:
        return Tier(str(row.get("tier") or "normal"))
    except ValueError:
        return Tier.NORMAL


def _reconcile_account(
    store: InspectionStore, da: Any, account_id: str, *,
    now: datetime, stats: dict[str, int],
) -> None:
    """对一个账号做对账。**单账号失败不影响其余。**"""
    try:
        rows = store.list_awaiting_judgment(account_id)
    except Exception as e:                     # noqa: BLE001
        logger.exception("读待判读 finding 失败 account=%s: %s", account_id, e)
        return
    if not rows:
        return
    stats["awaiting"] += len(rows)

    # 一个 task 因装箱（R5.4）最多覆盖 6 条 finding —— 按 task 去重，
    # 否则同一个 task 会被问 6 次。
    by_task: dict[str, list[str]] = {}
    for r in rows:
        tid = str(r.get("da_task_id") or "").strip()
        fid = str(r.get("finding_id") or "").strip()
        if tid and fid:
            by_task.setdefault(tid, []).append(fid)

    for task_id in sorted(by_task):
        if stats["probed"] >= MAX_PROBES_PER_RUN:
            return
        _reconcile_task(store, da, account_id, task_id, now=now, stats=stats)


def _reconcile_task(
    store: InspectionStore, da: Any, account_id: str, task_id: str, *,
    now: datetime, stats: dict[str, int],
) -> None:
    try:
        mapping = store.get_dispatch(task_id)
    except Exception as e:                     # noqa: BLE001
        logger.exception("读派发映射失败 task=%s: %s", task_id, e)
        return

    if not mapping:
        # 映射行已被 TTL 清掉（14 天），或压根没落成（7.4b 的那个缺口）。
        # ⚠️ 两者都要计数：前者是正常老化，后者意味着判读永久回不来。
        #    这里分不开，所以只报数 —— 分辨靠 run 记录上
        #    `dispatched_tasks` 与 `mapped_tasks` 的差。
        stats["no_mapping"] += 1
        logger.info("task=%s 没有派发映射（TTL 过期或从未落成）", task_id)
        return

    dispatched_at = mapping.get("dispatched_at")
    if not isinstance(dispatched_at, (int, float)):
        stats["no_mapping"] += 1
        return
    at = datetime.fromtimestamp(float(dispatched_at), tz=timezone.utc)

    # 当前记录的状态：finding 行上没有 DA 的 task status（我们从不缓存它），
    # 所以传空串 —— 空串不在 TERMINAL 里，等价于「未知非终态」。
    # ⚠️ 这是刻意的：缓存一份 status 就会有两个真源，而 `GetBacklogTask`
    #    是权威的那个（R13.13a：终态一律取自 DA）。
    if not needs_probe(status="", dispatched_at=at, now=now):
        stats["still_running"] += 1
        return

    # 🔴 space id 取**派发时落进映射行的那个**，不 fallback 到 env（改动⑤）。
    #
    #    per-account 之后 env 里那个是**部署账号**的 space。fallback 到它会让
    #    「成员账号的映射行没写 space」变成「去部署账号的 space 里找一个不存在
    #    的 task」→ ResourceNotFoundException → 而本模块规定 404 不作处置
    #    ⇒ 那条 finding 永远停在待判读，完全静默。
    space_id = str(mapping.get("agent_space_id") or "")
    if not space_id:
        logger.error(
            "task=%s 的派发映射行上没有 agent_space_id，无法核实。"
            "⚠️ 刻意不 fallback 到 env（那是部署账号的 space，"
            "去它那里找成员账号的 task 只会 404，而 404 不作处置）", task_id)
        stats["probe_failed"] += 1
        return

    stats["probed"] += 1
    try:
        resp = da.get_backlog_task(agentSpaceId=space_id, taskId=task_id)
        status = str((resp.get("task") or {}).get("status") or "")
    except Exception as e:                     # noqa: BLE001
        # ⚠️ 拿不到状态**什么都不做**。特别是不能因为 404 就判死 ——
        #    `ResourceNotFoundException` 也可能是 space_id 传错。
        logger.warning("GetBacklogTask 失败 task=%s: %s", task_id, e)
        stats["probe_failed"] += 1
        return

    v = verdict_of(task_id, status)
    if not v.known:
        # AWS 加了新状态。**不落终态、不重投**，但要吵 —— 见 dispatch_recon。
        logger.error("未知的 task status，本条不动: task=%s status=%r",
                     task_id, status)
        stats["unknown_status"] += 1
        return
    if not v.is_terminal:
        stats["still_running"] += 1
        logger.info("task=%s 仍在 %s，不动", task_id, status)
        return

    reason = v.degraded_reason
    if not reason:
        # COMPLETED：事件丢了但判读内容我们这里拿不到（要 journal + 报告全文，
        # 那是 callback 的活）。**不写降级原因** —— 写了会让一条其实成功的
        # 判读在报告上显示成「判读缺失」。
        logger.warning(
            "task=%s 已 COMPLETED 但判读未回填 —— 事件可能丢了，"
            "需人工重放 callback 或等下一轮巡检", task_id)
        stats["resolved"] += 1
        return

    finding_ids = [str(f) for f in (mapping.get("finding_ids") or [])]
    _attach_reason(store, account_id, finding_ids, task_id=task_id,
                   reason=reason, stats=stats)
    stats["resolved"] += 1


def _attach_reason(
    store: InspectionStore, account_id: str, finding_ids: Sequence[str], *,
    task_id: str, reason: str, stats: dict[str, int],
) -> None:
    """把降级原因挂到该 task 覆盖的**每一条** finding 上。

    ⚠️ 写的是 `da_parse_status` —— 与 callback 同一个字段，因为看板与报告侧
    读的就是它（`reason_from_parse_status`）。另起一个字段会让同一件事
    有两个来源，而 UI 只读一个。

    ⚠️ 只挂第一条会让同一个 task 里其余 finding 永远停在「等判读」，
    于是每轮对账都把它们再问一遍。
    """
    for fid in finding_ids:
        try:
            ok = store.attach_judgment(
                account_id, fid, task_id=task_id, parse_status=reason)
        except Exception as e:                 # noqa: BLE001
            logger.exception("挂降级原因失败 finding=%s: %s", fid, e)
            continue
        if ok:
            stats["attached"] += 1


def _emit(stats: Mapping[str, int]) -> None:
    """对账结果打点。打点失败绝不冒泡。"""
    try:
        from inspection.adapters import metrics

        metrics.emit_reconcile(stats)
    except Exception:                          # noqa: BLE001
        logger.exception("对账打点失败（不影响结果）")
