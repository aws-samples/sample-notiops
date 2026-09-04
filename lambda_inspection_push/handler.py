"""巡检推送 Lambda（R11b.1~R11b.10）。

每 15 分钟被一条 EventBridge Rule 唤醒，只在**推送时段窗口**里真的干活。

```
EventBridge (rate 15min)
   │
   ├─ kill switch: inspection.enabled           拉停 → 直接退
   ├─ 读推送时段配置 → kinds_due(now, cfg)       不在窗口 → 直接退（常态）
   ├─ 读投递目标 → resolve_inspection_targets()  R11b.2
   ├─ 逐账号读 finding 原始行 + 推送状态
   ├─ 今天有没有 run 记录                        没有 → 跳过该账号（不推昨天的）
   ├─ 逐目标 select_for_target()                 R11b.3 账号切分 + severity_min
   │                                             R11b.5 节奏 + 退避
   │                                             R11b.7 Top N + 深链
   ├─ 🔴 kill switch: push_enabled              ← 算完之后、投递之前
   ├─ broadcast()                                逐 chat，一个失败不阻断
   └─ mark_pushed()                              只给真投出去的那些
```

## 🔴 为什么推送是独立 cron，不是巡检跑完顺手发

R11b.6：「SHALL NOT 在巡检 cron 完成的凌晨直接推」。挂在巡检末尾的话，
推送时刻 = 巡检完成时刻，而那是配置好的凌晨批处理时间。更麻烦的是
巡检是**逐账号 fan-out**（一个账号一条 SQS 消息），顺手发意味着
50 个账号发 50 次 —— 而 R11b.3 的模型是「一个 chat 一份摘要」。

## 🔴 `push_enabled` 的早退位置

**算完之后、投递之前。** R11c.7 的灰度第 ② 段是「全账号只写库不推送」，
那一段要的正是照常算、照常落库、只是不投。提前到「算之前」等于把第 ② 段
变成「什么都不做」，于是灰度期间根本验证不了推送内容对不对。

⚠️ 拉停期间**不写推送状态**。写了的话开关恢复之后那些 finding 会被当成
「已经推过」而跳过 —— 客户在开关期间的风险从此再也不会被推一次。

## 幂等

同一个窗口被触发两次（EventBridge at-least-once）时，第二次会因为
`ALREADY_PUSHED_TODAY`（`last_pushed_date == today`）把每条都跳掉，
于是 selection 为空、正文为空、`broadcast` 记 `EMPTY_BODY` 不投。
所以不需要额外的锁。

⚠️ 这条幂等**依赖 `mark_pushed` 在投递之后立刻写**。批量攒到最后再写，
中间超时会让那一批第二次全部重投。
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from inspection.adapters import links as dlinks
from inspection.adapters.store import InspectionStore
from inspection.domain import push_policy as pp
from inspection.domain.targets import ChatTarget, resolve_inspection_targets

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def handler(event: Mapping[str, Any], context: Any = None) -> dict[str, Any]:
    """Lambda 入口。"""
    now = datetime.now(timezone.utc)
    table_name = _env("INSPECTION_TABLE")
    config_table = _env("CONFIG_TABLE")
    if not table_name or not config_table:
        # ⚠️ 直接抛。返回 {"sent": 0} 会让「env 漏配」与「不在推送窗口」
        #    长得一模一样 —— 后者是每 15 分钟发生 95 次的常态。
        raise RuntimeError("缺环境变量: INSPECTION_TABLE / CONFIG_TABLE")

    import boto3

    region = _env("AWS_REGION", "ap-northeast-1")
    ddb = boto3.resource("dynamodb", region_name=region)
    store = InspectionStore(ddb.Table(table_name))
    cfg_tbl = ddb.Table(config_table)

    from inspection.adapters import switches

    # 🔴 **窗口判定必须在 kill switch 之前。**
    #
    #    反过来（先判开关）会让拉停期间每 15 分钟打一次点 —— 一天 96 条
    #    `PushSent=0` + 96 条 `PushNoTargets=1`，把「该推却没推」那一次
    #    彻底淹掉，而 `PushNoTargets` 的语义是「装好了但没人收到」，
    #    拉停是运维的显式动作，置 1 本身就是误报。
    #    `outside_window` 那条豁免只保护它自己后面的分支。
    window = pp.push_window_from_item(store.load_push_window())
    # 🔴 摘要账本让「顺延」可判：1 号落周六的月份，月度摘要要延到周一发，
    #    而「延到周一」与「这个月已经发过了」只能靠它区分。
    ledger = _digest_ledger(store)
    kinds = pp.kinds_due(now, window, last_digest=ledger)
    if not kinds:
        # 常态：一天 96 个 tick 里 95 个走这条。**不记 warning** ——
        # 每 15 分钟刷一行会把真信号淹掉。
        #
        # ⚠️ 也**不打点**：这一条一天命中 95 次，打点会让
        # `PushSent=0` 的数据点淹掉真正「该推却没推」的那一次。
        # 其余早退分支都要打点（见 `_bail`）。
        logger.info("不在推送窗口（at_utc=%s weekdays=%s），跳过",
                    window.at_utc, sorted(window.weekdays))
        return {"sent": 0, "skipped": "outside_window"}

    # kill switch 判在窗口**之后** —— 这样拉停期间一天只打一次点而不是 96 次。
    if not switches.is_enabled(cfg_tbl, switches.Switch.INSPECTION):
        logger.warning("巡检已被 kill switch 停用，跳过推送")
        return _bail({"sent": 0, "failed": 0, "picked": 0,
                      # ⚠️ `targets` 不写 0 —— `PushNoTargets` 以它为判据，
                      #    而「被拉停」与「没有投递目标」是两件事。
                      "targets": -1,
                      "disabled_by": switches.Switch.INSPECTION.value})

    resolved = resolve_inspection_targets(store.list_chat_targets())
    for t, reason in resolved.rejected:
        logger.warning("投递目标被跳过: %s —— %s", t.key, reason.value)
    for key, note in resolved.warnings:
        logger.warning("投递目标配置可疑: %s —— %s", key, note)
    if resolved.is_empty:
        # ⚠️ 这一条必须是 WARNING：一个装好了却没有任何投递目标的部署
        #    表现是「巡检在跑但没人收到」，而客户会以为系统坏了。
        #
        # 🔴 **必须打点。** `PushNoTargets` 这条指标存在的唯一目的就是让
        #    这个状态可告警 —— 早退时直接 return 会让它**永远没有数据点**，
        #    于是「装好了但没人收到」这个可以持续数周不被发现的状态，
        #    仍然没有任何自动信号。（这正是本轮 review 抓到的缺陷。）
        logger.warning("没有可用的投递目标 —— 巡检照常算，但没有人会收到推送")
        return _bail({"sent": 0, "failed": 0, "picked": 0, "targets": 0,
                      "skipped": "no_targets",
                      "rejected_targets": len(resolved.rejected)})

    from inspection.adapters.accounts import enabled_accounts

    accounts = enabled_accounts(cfg_tbl)
    base_url = _env("WEB_BASE_URL")
    if not base_url:
        # 不是错误：没配就不放链接（照 devops_investigate.mjs 的先例）。
        logger.info("WEB_BASE_URL 未配置 —— 推送正文里不会有深链")

    # R11c.7 灰度第 ① 段的入口。**env 而不是 DDB 开关** —— 灰度是一次性的
    # 部署期动作（改完就往下走），而 kill switch 是长期存在的止损手段；
    # 混在一起会让「灰度中」与「出事拉停」在事后无法区分。
    dry_run = _env("INSPECTION_PUSH_DRY_RUN", "").strip().lower() in (
        "1", "true", "yes", "on")

    today = now.date()
    stats: dict[str, Any] = {
        "kinds": [k.value for k in kinds],
        "accounts": len(accounts),
        "targets": len(resolved.targets),
        "rejected_targets": len(resolved.rejected),
        "picked": 0, "sent": 0, "failed": 0, "marked": 0,
        "accounts_without_run": 0,
        # `{PushSkip 值: 条数}` —— 进 EMF 的**非维度**字段，用 Logs Insights
        # 查。不进维度：它有 9 档，×run_type×surface 会让维度基数爆掉，
        # 而我们要问的是「今天为什么没推这条」而不是要为每档建告警。
        "skips": {},
    }
    if dry_run:
        # R11c.7 灰度第 ① 段：照常算、**不投递**，用来人工核对误报率。
        # ⚠️ 与 `push_enabled=0`（第 ② 段）不同：那个是运维止损开关，
        #    这个是灰度手段，且**逐次**由 env 控制而不是改 DDB。
        logger.warning("dry_run 模式：本轮照常算但不投递（灰度第 ① 段）")
        stats["dry_run"] = True

    # 逐账号把「原始行 + 推送状态 + 今天有没有 run」读齐。
    # ⚠️ 一次读完再逐目标算，不是逐目标读 —— 后者会让 N 个目标把同一个账号
    #    的 finding 读 N 遍（一个账号几千条），而目标之间只差过滤条件。
    per_account: dict[str, tuple[list[pp.FindingView], dict[str, pp.PushState]]] = {}
    for account_id in accounts:
        if not _has_run_today(store, account_id, today=today):
            stats["accounts_without_run"] += 1
            logger.info("账号 %s 今天还没有 run 记录，跳过（不推昨天的结论）",
                        account_id)
            continue
        views = pp.views_from_items(store.list_finding_items(account_id))
        states = pp.states_from_items(store.load_push_states(account_id))
        per_account[account_id] = (views, states)

    if not per_account:
        logger.info("今天还没有任何账号产出 run 记录，本轮不推")
        return _bail({**stats, "skipped": "no_run_today"})

    push_on = switches.is_enabled(cfg_tbl, switches.Switch.PUSH)
    if dry_run and not push_on:
        # 两个都开着不冲突，但同时出现说明配置有歧义 —— 记一行，
        # 免得事后争论「那天到底是哪个原因没推」。
        logger.warning("dry_run 与 push_enabled=0 同时生效 —— 两者都会阻止投递")

    for kind in kinds:
        bodies, picked_ids, skips = _bodies_for(
            resolved.targets, per_account, today=today, kind=kind,
            base_url=base_url,
        )
        stats["picked"] += sum(len(v) for v in picked_ids.values())
        # 🔴 「今天为什么没推这条」的分布必须进 stats。
        #    `skip_counts()` 算出来却被丢弃是本轮 review 抓到的缺陷 ——
        #    枚举的全部意义就是能计数、能事后回答那个问题，
        #    而它只活在函数局部变量里的时候等于没做。
        for reason, n in skips.items():
            stats["skips"][reason] = stats["skips"].get(reason, 0) + n

        if not push_on:
            # 🔴 早退在这里 —— 上面全算完了、下面才投。
            #    ⚠️ 并且**不写推送状态**（见模块 docstring）。
            logger.warning(
                "push_enabled 已拉停：%s 已算完（%d 个目标有内容）但不投递",
                kind.value, sum(1 for b in bodies.values() if b))
            stats["disabled_by"] = switches.Switch.PUSH.value
            continue

        from inspection.adapters.broadcast import broadcast

        result = broadcast(resolved.targets,
                           body_for=lambda t: bodies.get(t.key, ""),
                           dry_run=dry_run)
        # 🔴 只给**真投出去的那些目标**写状态（review 抓到）。
        #    此前只要有任意一个目标成功就对**全部**目标 picked 的 finding
        #    写状态 —— 某个群 token 过期的那天，只有它能看到的那些 CRITICAL
        #    被记成已推（退避跳到 2 天），而 `resolved` 跃迁会连带写
        #    `resolved_announced=True`，那个群从此**永远**收不到缓解通报。
        delivered_keys = {d.key for d in result.deliveries if d.ok}
        stats["sent"] += result.sent
        stats["failed"] += result.failed
        stats["dry_run_skipped"] = stats.get("dry_run_skipped", 0) + result.skipped
        for d in result.failures:
            logger.warning("投递失败: %s —— %s", d.key, d.reason)

        # ⚠️ `dry_run` 时 `result.sent` 恒为 0，所以这里自然不写推送状态 ——
        #    灰度第 ① 段要能反复跑而不消耗退避配额。
        if delivered_keys:
            # 有内容要投的目标是否**全部**投成功 —— 决定
            # `resolved_announced`（终局判据）能不能置位。
            wanted = {k for k, b in bodies.items() if b.strip()}
            all_delivered = wanted <= delivered_keys
            stats["marked"] += _mark(
                store, per_account,
                {k: v for k, v in picked_ids.items() if k in delivered_keys},
                today=today, kind=kind, all_delivered=all_delivered)
            if not all_delivered:
                logger.warning(
                    "部分目标投递失败（%s）—— 已缓解的条目本轮不标记通报，"
                    "下一轮会重发一次（宁可重复，不要永久静默）",
                    sorted(wanted - delivered_keys))
            # 摘要发出去了就记账本 —— 否则下一个 tick 会认为还没发，
            # 于是整份重发（顺延逻辑靠这条账本收敛）。
            if kind in (pp.PushKind.WEEKLY, pp.PushKind.MONTHLY):
                period = "weekly" if kind is pp.PushKind.WEEKLY else "monthly"
                try:
                    store.mark_digest_sent(period, today)
                except Exception as e:           # noqa: BLE001
                    # 记不上只会让明天再发一次，不该让本轮算失败。
                    logger.error("记摘要账本失败 %s: %s", period, e)

    logger.info("推送完成: %s", stats)
    _emit(stats)
    return stats


def _digest_ledger(store: InspectionStore) -> pp.DigestLedger:
    """读摘要账本。读失败当成「从没发过」。

    ⚠️ 方向是「从没发过」而不是「刚发过」：前者最多多发一份摘要
    （客户看到重复，会说一声），后者会让整月的结构性摘要静默消失。
    """
    from datetime import date as _date

    try:
        item = store.load_digest_ledger() or {}
    except Exception as e:                       # noqa: BLE001
        logger.error("读摘要账本失败，按从没发过处理: %s", e)
        return pp.DigestLedger()

    def _parse(key: str) -> Any:
        raw = str(item.get(key) or "")
        try:
            return _date.fromisoformat(raw) if raw else None
        except ValueError:
            logger.warning("摘要账本 %s=%r 解析失败，按从没发过处理", key, raw)
            return None

    return pp.DigestLedger(weekly=_parse("last_weekly"),
                           monthly=_parse("last_monthly"))


def _has_run_today(store: InspectionStore, account_id: str, *, today: Any) -> bool:
    """今天这个账号有没有任一类型的 run 记录。

    🔴 没有它，把 `at_utc` 配到巡检之前就会每天推**前一天**的结论，
    而正文里的日期是今天 —— 表现是「推送里的数字和看板不一样」，
    两边都不报错。
    """
    from inspection.domain.schedule import RunType

    rows = []
    for run_type in RunType:
        try:
            found = store.runs_for(run_type.value, today)
        except Exception as e:                       # noqa: BLE001
            # ⚠️ 读不到就当**有** —— fail-open。一次 DDB 抖动不该静默吞掉
            #    当天的推送（客户只会以为「今天没有风险」）。
            logger.error("读 run 记录失败，按已跑处理: %s", e)
            return True
        row = found.get(account_id)
        if row:
            rows.append(row)
    return pp.has_run_today(rows, today=today)


def _bodies_for(
    targets: tuple[ChatTarget, ...],
    per_account: Mapping[str, tuple[list[pp.FindingView], dict[str, pp.PushState]]],
    *,
    today: Any,
    kind: pp.PushKind,
    base_url: str,
) -> tuple[dict[str, str], dict[str, list[tuple[str, str, str]]], dict[str, int]]:
    """逐目标算正文。

    返回 `({target.key: markdown}, {target.key: [(acct, fid, sev)]},
    {PushSkip 值: 条数})`。

    ⚠️ 第三个返回值是**跨目标累加**的（同一条 finding 被 3 个目标各跳过一次
    就计 3）。那是有意的：它回答的是「本轮各档判据各拦了多少次」，
    而不是「有多少条 finding 被拦」—— 后者在多目标下没有单一答案。

    🔴 **逐目标逐账号算**（R11b.3 + R11b.10）：一个 chat 只看到自己账号的
    finding，正文语言由该目标的 `locale` 决定。算一次到处发的表现是
    可见性隔离整个不存在。

    ⚠️ 多账号目标（`accounts: ["*"]`）产出**多段**正文，一段一个账号 ——
    合成一段会让「哪台机器在哪个账号」丢失，而跨账号同名实例很常见
    （`prod-cache` 在每个环境账号里都有一台）。
    """
    bodies: dict[str, str] = {}
    picked: dict[str, list[tuple[str, str, str]]] = {}
    skips: dict[str, int] = {}
    caveat_cache: dict[str, str] = {}

    for target in targets:
        sections: list[str] = []
        chosen: list[tuple[str, str, str]] = []
        if target.locale not in caveat_cache:
            caveat_cache[target.locale] = pp.monday_caveat(today, target.locale)
        caveat = caveat_cache[target.locale] if kind is pp.PushKind.DAILY else ""

        for account_id, (views, states) in sorted(per_account.items()):
            if not target.sees(account_id):
                continue
            sel = pp.select_for_target(views, states, target,
                                      today=today, kind=kind)
            # ⚠️ 在 `is_empty` 早退**之前**收 skip 分布 —— 「一条都没挑中」
            #    恰恰是最需要解释的那种情况（客户问「今天怎么没推」），
            #    放在早退之后会让那一次的原因全部丢失。
            for reason, n in pp.skip_counts(sel).items():
                skips[reason] = skips.get(reason, 0) + n
            if sel.is_empty:
                continue
            # ⚠️ 深链必须带 `tab` —— R11b.7 要「一跳到具体 finding，不是跳
            #    列表页让客户自己翻」。不带 tab 会落在总览页，客户还得自己
            #    猜这条属于高负载还是结构性。
            link_map = {
                v.finding_id: dlinks.finding_link(
                    base_url, account_id, v.finding_id,
                    tab=pp.tab_for_rule(v.rule))
                for v in sel.picked
            }
            all_tab = (pp.tab_for_rule(sel.picked[0].rule) if sel.picked else "")
            sections.append(pp.render_selection(
                sel, account_id=account_id, today=today, kind=kind,
                locale=target.locale, links=link_map,
                all_link=dlinks.dashboard_link(base_url, account_id,
                                               tab=all_tab),
                snooze_link=dlinks.scope_link(base_url, account_id),
                caveat=caveat,
            ))
            chosen += [(account_id, v.finding_id, v.severity) for v in sel.picked]
            # 周一那句只在第一段出现 —— 每段都带会让一条提示重复 N 遍。
            caveat = ""

        bodies[target.key] = "\n\n---\n\n".join(sections)
        picked[target.key] = chosen
    return bodies, picked, skips


def _mark(
    store: InspectionStore,
    per_account: Mapping[str, tuple[list[pp.FindingView], dict[str, pp.PushState]]],
    picked_ids: Mapping[str, list[tuple[str, str, str]]],
    *,
    today: Any,
    kind: pp.PushKind,
    all_delivered: bool = True,
) -> int:
    """给真投出去的那些写推送状态。

    ⚠️ 按 **finding** 去重，不是按目标 —— 同一条 finding 被投给三个群
    只算推了一次。按目标计数会让 `push_count` 三倍增长，
    于是 CRITICAL 的退避从 1 天直接跳到 7 天。

    ⚠️ `picked_ids` 由调用侧筛成**只含投递成功的目标** —— 见调用处的
    `delivered_keys`。全部失败还写状态的表现是：今天没人收到，而明天因为
    `BACKOFF_NOT_DUE` 也不会重推。

    🔴 **写完要把内存里的快照一起更新。** `per_account` 的 `states` 在
    handler 里只装载一次，而 `kinds_due` 在月初的周二返回三种 kind，
    循环逐种调本函数。不刷新快照的话每日写的 `push_count+1` 会被紧接着
    的周度按 `prev.push_count` 覆盖回去（`mark_pushed` 是整行 put）——
    CRITICAL 的退避在周二与每月 1 号永不前进。（review 抓到。）
    """
    seen: set[tuple[str, str]] = set()
    written = 0
    is_daily = kind is pp.PushKind.DAILY
    for entries in picked_ids.values():
        for account_id, finding_id, severity in entries:
            if (account_id, finding_id) in seen:
                continue
            seen.add((account_id, finding_id))
            views, states = per_account.get(account_id, ([], {}))
            prev = states.get(finding_id, pp.PushState())
            view = next((v for v in views if v.finding_id == finding_id), None)
            # 🔴 `resolved_announced` 是**终局**判据（`decide()` 见到它直接
            #    返回不推，而 finding 已是终态不会再跃迁）—— 错标一次就是
            #    **永久静默**。所以它只在 `all_delivered` 时才置位。
            #
            #    ⚠️ 与 `push_count` / `last_pushed_date` 的方向刻意不同：
            #    那两个错了最多让某个群晚一两天再看到（可恢复），
            #    而这个错了那个群**再也**收不到这条的缓解通报。
            #    一条 finding 被「总览群（accounts=*）」与「业务群」同时选中
            #    是设计里的常态，那时部分失败必然发生。
            resolved_announced = prev.resolved_announced or (
                all_delivered
                and view is not None and view.transition_kind == "resolved"
            )
            # 摘要类（周度/月度）**不推进退避计数、也不动 `last_pushed_date`**
            # —— 那两份是「保证没有东西静默腐烂」的兜底，让它们消耗
            # CRITICAL 的退避档位（或它的起算点）会让每日重推被周报挤掉。
            nxt = pp.PushState(
                finding_id=finding_id,
                last_pushed_date=today if is_daily else prev.last_pushed_date,
                push_count=prev.push_count + 1 if is_daily else prev.push_count,
                last_pushed_severity=severity or prev.last_pushed_severity,
                last_digest_date=prev.last_digest_date if is_daily else today,
                resolved_announced=resolved_announced,
            )
            try:
                store.mark_pushed(
                    account_id, finding_id,
                    pushed_date=nxt.last_pushed_date,
                    push_count=nxt.push_count,
                    severity=nxt.last_pushed_severity,
                    resolved_announced=nxt.resolved_announced,
                    digest_date=nxt.last_digest_date,
                )
                # 🔴 同一次调用里后面的 kind 要看到这次的结果。
                states[finding_id] = nxt
                written += 1
            except Exception as e:                   # noqa: BLE001
                # 逐条兜住：一条写失败只会让它明天多推一次，
                # 而抛出去会让整轮推送进 DLQ 且已投递的部分无法回滚。
                logger.error("写推送状态失败 %s/%s: %s",
                             account_id, finding_id, e)
    return written


def _bail(stats: dict[str, Any]) -> dict[str, Any]:
    """早退时也打点，然后原样返回 stats。

    🔴 **本轮 review 抓到的缺陷**：早退分支原本直接 `return`，于是
    `_emit` 只在跑到函数末尾那条路径上执行。后果是
    `PushNoTargets` 这条指标**永远没有数据点** —— 而它存在的唯一目的
    就是让「装好了但没有任何投递目标」可告警，那正是一个可以持续数周
    不被发现的状态。

    ⚠️ 唯一**不**打点的早退是 `outside_window`：它一天命中 95 次，
    打点会让 `PushSent=0` 的数据点把真正「该推却没推」的那一次淹掉。
    """
    _emit(stats)
    return stats


def _emit(stats: Mapping[str, Any]) -> None:
    """EMF 打点。失败绝不影响推送结果。"""
    try:
        from inspection.adapters import metrics

        metrics.emit_push(stats)
    except Exception as e:                           # noqa: BLE001
        logger.warning("推送指标打点失败（不影响投递）: %s", e)
