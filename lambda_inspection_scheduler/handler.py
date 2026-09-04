"""巡检调度器 Lambda（Phase 5：）。

每 15 分钟被一条 EventBridge Rule 唤醒，回答一个问题：
**这一刻该给哪些 (类型 × 账号) 派巡检**，然后 fan-out 到 SQS。

```
EventBridge (rate 15 min)
   │
   ├─ 读定时配置（DDB，不是每客户一条 Rule）      R11.1a
   ├─ due_runs()  本 tick 该跑谁 + 补跑           5.2
   ├─ 查 DA 额度 → Tier                          5.6
   ├─ 快照配置 → config_version                  5.4
   ├─ 抢 run 锁（条件写，抢不到就跳过）            5.3
   └─ SendMessageBatch fan-out → 执行 Lambda      5.7
```

## 为什么不给每个客户建一条 Rule

老系统把 cron **写死在 CDK** 里（5 条 Rule：`notiops-daily-collection` 00:00 /
`-health-check` 00:30 / `-elasticache-health-check` 01:00 / `-cost-analysis` 01:15 /
`-notification` 02:00 UTC）→ 客户改巡检时间必须改代码重新部署。

代价是调度粒度 = 15 分钟，所以 UI 必须把可选时刻限制成 15 分钟整数倍。
让客户填 `02:07` 会得到一个**永远不被精确命中**的配置 ——
它只会靠 `catch_up` 在 02:15 那个 tick 被补跑，看起来「慢了 8 分钟」。

## 这个入口的两个调用来源

```
EventBridge 定时     detail-type 缺省 → 走 due_runs()
手动触发（5.8）      事件带 manual_trigger → 走 ManualTrigger 的 source × mode
```
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Mapping, Sequence
from datetime import date, datetime, timedelta, timezone
from typing import Any

from inspection.adapters import metrics, switches
from inspection.adapters.accounts import enabled_accounts
from inspection.adapters.store import (
    RUN_STATUS_FAILED,
    InspectionStore,
    StoreError,
)
from inspection.domain.budget import BudgetState, Tier, combine_agent_spaces
from inspection.domain.fanout import (
    FanoutError,
    InspectionMessage,
    build_messages,
    chunk_batches,
    failed_entry_ids,
    should_inline_config,
)
from inspection.domain.schedule import (
    DataSource,
    DueRun,
    ManualTrigger,
    ReuseUnavailable,
    RunMode,
    RunType,
    ScheduleConfig,
    due_runs,
    resolve_reuse_date,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

AIDEVOPS_NAMESPACE = "AWS/AIDevOps"
"""2026-08-19 实测：这个命名空间只有 3 个指标，维度均为 `AgentSpaceUUID`。"""

CONSUMED_METRIC = "ConsumedInvestigationTime"
"""单位 `Seconds`。⚠️ 统计量必须用 `Sum` —— `Maximum` 是单次调查最长耗时。"""


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def _clients(region: str = "") -> dict[str, Any]:
    """建 AWS 客户端。

    ⚠️ `import boto3` **在函数内**，不在模块顶层。
    顶层导入会让 `tests/test_inspection_scheduler.py` 在 CI 的
    `inspection-tests` job 里直接 collection error —— 那个 job 只装
    `pytest hypothesis botocore`，故意不装 boto3（巡检判定层是纯函数，
    不该为了跑单测拉整个 SDK）。而本机 venv 有 boto3，所以这个错
    **只在 CI 上出现**。
    """
    import boto3

    region = region or _env("AWS_REGION", "ap-northeast-1")
    return {
        "ddb": boto3.resource("dynamodb", region_name=region),
        "sqs": boto3.client("sqs", region_name=region),
        "cw": boto3.client("cloudwatch", region_name=region),
    }


# ---------------------------------------------------------------------------
# 额度（5.6）
# ---------------------------------------------------------------------------


def consumed_seconds_this_month(
    cw: Any, *, agent_space_ids: Sequence[str], now: datetime,
) -> float:
    """本月至今的 DA 用量（秒），**跨全部 agent space 求和**。

    ⚠️ 一个 space 一条曲线（维度 `AgentSpaceUUID`）。只读巡检那个会把 pace
    系统性低估 → 一直判「用得太慢」→ 一直放宽派发 → 月中把额度打光。
    而分母（credits）是账号级的。

    ⚠️ `Statistics=["Sum"]`。实测同一天 `Sum=1412` 但 `Maximum=499` ——
    后者是单次调查最长耗时，拿它当累计用量会低估约 3 倍。
    """
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    per_space: dict[str, float] = {}
    for space_id in agent_space_ids:
        if not space_id:
            continue
        try:
            r = cw.get_metric_statistics(
                Namespace=AIDEVOPS_NAMESPACE,
                MetricName=CONSUMED_METRIC,
                Dimensions=[{"Name": "AgentSpaceUUID", "Value": space_id}],
                StartTime=start, EndTime=now,
                Period=86400, Statistics=["Sum"],
            )
        except Exception as e:                     # noqa: BLE001
            # ⚠️ 拿不到用量 → 记 0 并继续。判 CRITICAL_ONLY 会让一次
            # CloudWatch 抖动把整轮巡检掐停，那比额度超支更糟。
            logger.warning("读 %s 用量失败（按 0 计）: %s", space_id, e)
            per_space[space_id] = 0.0
            continue
        per_space[space_id] = sum(float(d["Sum"]) for d in r.get("Datapoints", []))
    return combine_agent_spaces(per_space)


def resolve_budget(cw: Any, *, agent_space_ids: Sequence[str], now: datetime,
                   monthly_limit_seconds: float) -> BudgetState:
    """本轮的预算状态（`tier` 之外还带 `used_ratio` / `consumed_seconds`）。

    ⚠️ 与 `resolve_tier` 分开而不是改它的返回类型：那个函数有既有单测按
    `Tier` 断言，改签名会让「本轮档位判定」的回归保护一起消失，
    而档位判错的表现是额度被提前打光或该派的不派 —— 两者都不报错。
    """
    consumed = consumed_seconds_this_month(
        cw, agent_space_ids=agent_space_ids, now=now)
    state = BudgetState(consumed_seconds=consumed,
                        monthly_limit_seconds=monthly_limit_seconds,
                        today=now.date())
    logger.info("额度: 已用 %.0f 秒 ($%.2f) pace=%.2f → %s",
                consumed, state.consumed_usd, state.pace, state.tier.value)
    return state


def resolve_tier(cw: Any, *, agent_space_ids: Sequence[str], now: datetime,
                 monthly_limit_seconds: float) -> Tier:
    """本轮的派发档位。"""
    return resolve_budget(cw, agent_space_ids=agent_space_ids, now=now,
                          monthly_limit_seconds=monthly_limit_seconds).tier


# ---------------------------------------------------------------------------
# 配置快照（5.4 / 5.5）
# ---------------------------------------------------------------------------


def snapshot_config(
    store: InspectionStore, *, run_type: RunType, config: Mapping[str, Any],
    now: datetime, changed_by: str = "scheduler",
) -> tuple[str, Mapping[str, Any] | None]:
    """快照配置，返回 `(config_version, config_inline)`。

    `config_version` **总是有值**；`config_inline` 只在配置小到能内联时有值
    （省执行侧一次读）。大配置只下发版本号，执行侧按它回读不可变表。

    ⚠️ 内联的那份也要**写进版本表**。只在超限时才写会让「当天为什么这么判」
    在小配置的日子查不到依据 —— 而那是绝大多数日子。

    🔴 **`config_version` 曾经在内联时返回空串**（契约写的是「恰好一个有值」）。
    后果是 R6.9 整条失效：

    ```
    executor   rule_version = task.config_version = ""
    lifecycle  if rule_version and rec.rule_version and rec.rule_version != rule_version
               → 第一个条件就是假 → _force_resolve 永不触发
    ⇒ 客户调高阈值之后，本该被 resolve 的旧 finding 一直挂着，
      而新阈值下它压根不该存在。且完全静默。
    ```

    阈值配置一定是小配置（30 个字段撑不到 SQS 上限的 1/4），也就是说
    **生产上走的恒是内联那条分支** —— 那个空串等于让规则变更检测彻底不存在。
    """
    version = store.put_config_version(
        service="inspection", rule_type=run_type.value,
        config=config, changed_by=changed_by, now=now)
    if should_inline_config(config):
        return version, dict(config)
    logger.info("配置快照超内联预算 → 只下发 config_version=%s", version)
    return version, None


# ---------------------------------------------------------------------------
# fan-out（5.7）
# ---------------------------------------------------------------------------


def _account_of(entry: Mapping[str, Any]) -> str:
    """从批条目里取回 account_id，用于把失败落到具体账号上。"""
    try:
        return str(json.loads(str(entry["MessageBody"]))["account_id"])
    except (KeyError, ValueError, TypeError):
        return ""


def send_messages(sqs: Any, *, queue_url: str,
                  messages: Sequence[InspectionMessage]) -> tuple[int, list[str]]:
    """批量投递。返回 `(成功条数, 失败的 account_id 列表)`。

    ⚠️ **HTTP 200 也可能部分失败**（API 文档原文）。不查 `Failed`
    会让漏掉的账号这一天静默没有巡检，而对账只能看到「缺账号行」。
    """
    sent = 0
    failed_accounts: list[str] = []
    for batch in chunk_batches(messages):
        by_id = {e["Id"]: e for e in batch.entries}
        try:
            resp = sqs.send_message_batch(
                QueueUrl=queue_url, Entries=list(batch.entries))
        except Exception as e:                     # noqa: BLE001
            # 整批失败：全部条目都算没送出去。
            # ⚠️ 不重新抛 —— 一批失败不该让其他批也不发。
            logger.exception("整批投递失败: %s", e)
            failed_accounts.extend(_account_of(entry) for entry in batch.entries)
            continue
        bad = set(failed_entry_ids(resp))
        sent += len(batch.entries) - len(bad)
        # 🔴 把 SQS 给的 Code/Message 一起记下来。此前只记 account_id，
        #    于是「投递失败的账号: [...]」是唯一线索 —— 而真因
        #    （标准队列拒收 MessageGroupId，InvalidParameterValue）
        #    只存在于这个响应里，日志没有它就只能靠猜。
        #    东京那次为定位它花掉的时间，全部是这行缺失的代价。
        for f in (resp.get("Failed") or []):
            if isinstance(f, Mapping):
                logger.error(
                    "投递条目失败: id=%s code=%s senderFault=%s msg=%s",
                    f.get("Id"), f.get("Code"), f.get("SenderFault"),
                    str(f.get("Message", ""))[:300])
        for eid in bad:
            entry = by_id.get(eid)
            if entry is not None:
                failed_accounts.append(_account_of(entry))
    if failed_accounts:
        logger.error("投递失败的账号: %s", failed_accounts)
    return sent, failed_accounts


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def _parse_manual(event: Mapping[str, Any]) -> ManualTrigger | None:
    """手动触发事件 → `ManualTrigger`（5.8）。缺省即定时轮。"""
    raw = event.get("manual_trigger")
    if not isinstance(raw, Mapping):
        return None
    accounts = tuple(str(a) for a in (raw.get("account_ids") or []))
    if not accounts:
        raise FanoutError("手动触发缺 account_ids")
    return ManualTrigger(
        run_type=RunType(str(raw.get("run_type", "high"))),
        account_ids=accounts,
        source=DataSource(str(raw.get("source", DataSource.REUSE.value))),
        mode=RunMode(str(raw.get("mode", RunMode.DRY_RUN.value))),
        requested_by=str(raw.get("requested_by", "")),
    )


def _data_dates(
    store: InspectionStore, *, source: DataSource, accounts: Sequence[str],
    today: date,
) -> dict[str, date]:
    """逐账号定 `data_date`（R11.4a）。

    ```
    refetch  → 本轮现拉，data_date = today
    reuse    → 被复用批次的**真实日期**，找不到就抛（R11.4b：不静默降级）
    ```

    ⚠️ `reuse` 写 today 会让 `consecutive_high_days` 凭空 +1，
    慢性高位判定被反复 reuse 污染 —— 而 `dry_run` 不能替代这条约束，
    它只是不写状态机，报告上的日期照样给客户看。
    """
    if source is DataSource.REFETCH:
        return {a: today for a in accounts}
    out: dict[str, date] = {}
    for acct in accounts:
        available = store.available_data_dates(acct)
        out[acct] = resolve_reuse_date(available=available, today=today)
    return out


def handler(event: Mapping[str, Any], context: Any = None) -> dict[str, Any]:
    """Lambda 入口。"""
    now = datetime.now(timezone.utc)
    table_name = _env("INSPECTION_TABLE")
    queue_url = _env("INSPECTION_QUEUE_URL")
    missing = [k for k, v in (("INSPECTION_TABLE", table_name),
                              ("INSPECTION_QUEUE_URL", queue_url),
                              ("CONFIG_TABLE", _env("CONFIG_TABLE"))) if not v]
    if missing:
        # ⚠️ 直接抛。返回 {"dispatched": 0} 会让「env 漏配」看起来和
        # 「本 tick 确实没有要跑的」一模一样 —— 前者要人来修，后者是常态。
        raise RuntimeError(f"缺环境变量: {', '.join(missing)}")

    c = _clients()
    store = InspectionStore(c["ddb"].Table(table_name))
    cfg_table = c["ddb"].Table(_env("CONFIG_TABLE"))

    # ── kill switch（R11c.1）
    #
    # 🔴 放在**手动触发解析之前**。放到 `due_runs` 里只挡定时轮，而手动触发
    #    走的是另一条分支（`_parse_manual` 完全绕过 due_runs）—— 那意味着
    #    开关拉停之后，管理页上的「立即巡检」按钮照样能跑起来一整轮。
    #    出事时那正是有人会去点的按钮。
    if not switches.is_enabled(cfg_table, switches.Switch.INSPECTION):
        logger.warning("巡检已被 kill switch 停用（%s / %s），本 tick 不派发",
                       switches.PK, switches.Switch.INSPECTION.value)
        return {"dispatched": 0, "disabled_by": switches.Switch.INSPECTION.value,
                "tick": now.isoformat()}

    manual = _parse_manual(event)
    if manual is not None:
        source, mode = manual.source, manual.mode
        configs_used = [manual.run_type]
        due = [DueRun(manual.run_type, a, now.date()) for a in manual.account_ids]
        trigger_id = f"{now.isoformat()}#{manual.requested_by or 'manual'}"
        logger.info("手动触发: %s × %d 账号 source=%s mode=%s",
                    manual.run_type.value, len(due), source.value, mode.value)
    else:
        source, mode = DataSource.REFETCH, RunMode.OFFICIAL
        trigger_id = ""
        schedules = store.load_schedules()
        accounts = enabled_accounts(cfg_table)
        completed: dict[tuple[str, str, date], str] = {}
        for cfg in schedules:
            completed.update(store.completed_runs(
                run_type=cfg.run_type.value, run_date=now.date()))
        due = due_runs(now=now, configs=schedules, accounts=accounts,
                       completed=completed)
        configs_used = sorted({r.run_type for r in due}, key=lambda t: t.value)
        if not due:
            logger.info("本 tick 无需派发")
            return {"dispatched": 0, "tick": now.isoformat()}
        logger.info("本 tick 该派 %d 条（补跑 %d）",
                    len(due), sum(1 for r in due if r.catch_up))

    monthly_limit = float(_env("MONTHLY_LIMIT_SECONDS", "-1") or -1)
    budget = resolve_budget(
        c["cw"],
        agent_space_ids=[_env("DEVOPS_AGENT_SPACE_ID"),
                         _env("INSPECT_AGENT_SPACE_ID")],
        now=now,
        monthly_limit_seconds=monthly_limit,
    )
    tier = budget.tier
    # R11c.3 的 P3 数据源。⚠️ 分母未知时只发 `DaQuotaLimitUnknown` ——
    # 照发 ratio 会得到一个永远绿的告警，而那正是当前所有部署的状态
    # （`MONTHLY_LIMIT_SECONDS` 默认 -1，Phase 0 的 0.4b 还没结论）。
    try:
        metrics.emit_quota(
            used_ratio=budget.used_ratio,
            monthly_limit_seconds=monthly_limit,
            consumed_seconds=budget.consumed_seconds)
    except Exception:                          # noqa: BLE001
        logger.exception("额度打点失败（不影响本 tick）")

    total_sent = 0
    all_failed: list[str] = []
    for run_type in configs_used:
        locked = [r for r in due if r.run_type is run_type]
        # 🔴 **这里不抢 run 锁。** 锁归 executor。
        #
        # 此前 scheduler 也调 `try_acquire_run_lock`，与 executor 抢的是
        # 同一个键 `(run_type, run_date, account_id)`。后果是整套巡检
        # **永不执行**：
        #
        # ```
        # scheduler  抢到锁 → status=running → 发 SQS 消息
        # executor   抢同一把锁 → 被 scheduler 占着 → 条件不放行
        #            → 「已有 run 在跑，跳过」→ 消息删除、不进 DLQ
        #            → run 行停在 running 直到 lock_until 6 小时后过期
        # ```
        #
        # 东京的验证账号实测：executor 的 log group 一条流都没有，
        # 而 run 行、cfgver 行都正常写着 —— 看板显示「本轮未发现风险」。
        #
        # 为什么锁该归 executor：
        #   · 它才是真正执行的一方，锁必须保护「执行」这个动作
        #   · SQS 是 at-least-once，消费侧必须幂等（executor 的锁注释
        #     写的就是这个意图）
        #   · scheduler 侧防重复派发**已经有判据** —— `due_runs()` 的
        #     `completed` 参数排掉了当天已有 running / success 的组合
        #
        # 移除后多派一条消息的代价：executor 抢锁时一个成功一个跳过，
        # 那正是它的幂等锁设计要处理的情形。多花一次 SQS 请求，可忽略。
        owner = getattr(context, "aws_request_id", "") or ""
        if not locked:
            continue

        accounts = [r.account_id for r in locked]
        try:
            data_date_for = _data_dates(
                store, source=source, accounts=accounts, today=now.date())
        except ReuseUnavailable as e:
            # R11.4b：明确失败，不静默降级成 refetch
            logger.error("%s: reuse 不可用 → 本轮放弃: %s", run_type.value, e)
            # ⚠️ 必须先 claim 再 finish。scheduler 不再预抢锁（见上），
            #    所以这时那些 run 行**还不存在** —— 而 `finish_run` 走的是
            #    `update_item`，对不存在的行会建出一个**没有 status** 的桩行。
            #    那种行的后果是三连静默：占死当天的锁 / 缺行缺口从指标里消失 /
            #    重投上限永远到不了。（同一个坑在补齐计数那里踩过一次。）
            #
            #    claim 失败说明 executor 已经在跑同一账号 —— 那种情况下这条
            #    reuse 失败与它无关，不该把它的行改成 failed。
            for r in locked:
                if store.try_acquire_run_lock(
                        r.run_type.value, r.run_date, r.account_id,
                        owner=owner, now=now):
                    store.finish_run(
                        run_type=r.run_type.value, run_date=r.run_date,
                        account_id=r.account_id, status=RUN_STATUS_FAILED,
                        now=now, error=f"reuse 不可用: {e}")
            continue

        cfg_version, cfg_inline = snapshot_config(
            store, run_type=run_type,
            config=store.load_rule_config(run_type.value), now=now)

        messages = build_messages(
            due=locked, data_date_for=data_date_for, tier=tier,
            source=source, mode=mode,
            config_version=cfg_version, config_inline=cfg_inline,
            trigger_id=trigger_id,
            requested_by=(manual.requested_by if manual else ""),
        )
        sent, failed = send_messages(
            c["sqs"], queue_url=queue_url, messages=messages)
        total_sent += sent
        all_failed.extend(failed)

        # ⚠️ 投递失败的账号要**立刻**落 failed —— 不落的话这一天既没有巡检
        #    也没有失败记录。
        #
        # 🔴 但必须**先 claim 再 finish**，与上面 ReuseUnavailable 分支同构
        #    （2026-09-04 交叉 review 抓到两条路径一对一错）。scheduler 不再
        #    预抢锁（见上），此时 run 行**还不存在**，而 `finish_run` 走
        #    `update_item` —— 对不存在的行会建出一个只有 status/finished_at
        #    的**桩行**：无 stats → `audit_coverage` 的 `expected=0` →
        #    completeness 算不出 → 既不进 `missing_row` 也不进
        #    `low_completeness` → **8.4 的自动补齐不触发**；且无 ttl，永不过期。
        #    原注释「锁已经抢到了」是过期陈述（抢锁早已移交 executor）。
        #
        # ⚠️ 用 `r.run_date` 而不是 `now.date()`：补跑（catch-up）的 run 行
        #    日期是被补的那天 —— claim 与 finish 必须落在**同一行**上，
        #    否则又是「锁 A 行、写 B 行」。
        #
        # ⚠️ claim 失败不写：executor 可能已经在跑同一账号（部分投递成功的
        #    形态），那时它的行不该被我们改成 failed。就算误标了 failed，
        #    锁条件对 failed 行放行，executor 到场后会重新 claim 并覆盖 ——
        #    自愈方向是安全的。
        failed_set = set(failed)
        for r in locked:
            if r.account_id not in failed_set:
                continue
            if store.try_acquire_run_lock(
                    r.run_type.value, r.run_date, r.account_id,
                    owner=owner, now=now):
                store.finish_run(
                    run_type=r.run_type.value, run_date=r.run_date,
                    account_id=r.account_id, status=RUN_STATUS_FAILED,
                    now=now, error="SQS 投递失败")

    return {
        "dispatched": total_sent,
        "failed": all_failed,
        "tier": tier.value,
        "source": source.value,
        "mode": mode.value,
        "tick": now.isoformat(),
    }
