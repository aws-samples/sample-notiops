"""巡检的 CloudWatch 指标打点（EMF） ——  R11c.3 的数据源，。

## 为什么用 EMF 而不是 PutMetricData

抄 `core/llm_config.py` 的既有惯例（那是本仓唯一一处 EMF 实现）：

- 不需要 `cloudwatch:PutMetricData` 权限 —— 巡检两个 Lambda 共用 `lambdaRole`，
  加权限意味着给**所有**采集 Lambda 加，扩大了那个角色的面
- 不增加请求延迟、不占 API 配额
- 巡检 Lambda 已经在往 CloudWatch Logs 写，机制统一

写一行合规 JSON 到 stdout，CloudWatch 自动抽取成指标。
见 https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html

## 零 boto3、零 botocore

打点是**失败路径上最后还能工作的东西**。它只用 stdlib，所以即使 boto3 层挂了
（或者在 CI 的 `inspection-tests` job 里 —— 那个 job 故意不装 boto3）
这一段照样能跑、照样能被测试。

## 🔴 维度基数必须极低

维度只有 `Surface`（scheduler / executor）+ `RunType`（high / idle）
+ 少数枚举。**`account_id` 绝不进维度** ——

R11c.3 写的是「P2 单账号 completeness < 95%」，读起来像要 per-account 指标。
但 CloudWatch 按维度组合计费并生成独立指标：50 个账号 × 2 类型 × 6 个指标
= 600 条曲线，而我们真正要问的问题是「**有没有任何**账号掉到 95% 以下」——
那个用 `Minimum` 统计量就能答，不需要拆维度。

⇒ `account_id` 放在**同一行的非维度字段**里，用 Logs Insights 查是哪个账号。
这也是 `core/llm_config.py` 的 `_emit` docstring 里写明的约束。

## 关掉的方式

`INSPECTION_METRICS=0`。与 `LLMCFG_METRICS` 同形态。
⚠️ 关掉之后**五条告警全部变成假绿灯**（无数据 + treatMissingData 决定状态），
所以这个开关只该用于本地调试，不该出现在部署里。
"""

from __future__ import annotations

import json as _json
import logging
import os
import time
from typing import Any, Mapping

from inspection.domain.observability import RunSignals

logger = logging.getLogger(__name__)

NAMESPACE = os.environ.get("INSPECTION_METRIC_NAMESPACE", "NotiOps/Inspection")
"""对齐 `NotiOps/<模块>` 的既有形态（`NotiOps/LLMConfig`）。"""

_ENABLED = os.environ.get("INSPECTION_METRICS", "1").strip().lower() not in (
    "0", "false", "no", "off",
)
"""⚠️ 归一化后比对。`core/llm_config.py` 用的是字面量三元组
`("0","false","False")`，那种写法下 `FALSE` 会被判成开启 —— 对开关是个坑。
这里不照抄那一处。"""

# 指标名（PascalCase，CloudWatch 惯例）。**改名等于把对应的 Alarm 变成假绿灯**，
# 所以 CDK 侧从同一份清单取，见 `scripts/test_inspection_infra_wired.py` 的元断言。
M_RUN_FINISHED = "RunFinished"
M_RUN_SUCCEEDED = "RunSucceeded"
M_RUN_ZERO_OUTPUT = "RunZeroOutput"
M_COMPLETENESS = "Completeness"
M_DISPATCH_ATTEMPTED = "DispatchAttempted"
M_DISPATCH_FAILED = "DispatchFailed"
M_DISPATCH_FAILURE_RATIO = "DispatchFailureRatio"
M_DISPATCH_UNMAPPED = "DispatchUnmapped"
M_QUOTA_USED_RATIO = "DaQuotaUsedRatio"
M_QUOTA_LIMIT_UNKNOWN = "DaQuotaLimitUnknown"
M_RECON_AWAITING = "ReconcileAwaiting"
M_RECON_PROBED = "ReconcileProbed"
M_RECON_RESOLVED = "ReconcileResolved"
M_RECON_NO_MAPPING = "ReconcileNoMapping"
M_RECON_UNKNOWN_STATUS = "ReconcileUnknownStatus"
M_RECON_PROBE_FAILED = "ReconcileProbeFailed"
M_RECON_DA_TARGET_UNRESOLVED = "ReconcileDaTargetUnresolved"
"""判读目标解析失败的账号数（per-account agent space，2026-08-30）。

🔴 这是「某个成员账号的 assume 一直失败」**唯一**能被看到的信号。
对账兜底对那个账号整条变 no-op，而那条链路的既有约定是「拿不到状态什么都不做」
—— 所以没有任何别的现象。
"""
M_COVERAGE_MISSING_ROWS = "CoverageMissingRows"
M_COVERAGE_LOW = "CoverageLowCompleteness"
M_COVERAGE_MISSING_INSTANCES = "CoverageMissingInstances"
M_PUSH_SENT = "PushSent"
M_PUSH_FAILED = "PushFailed"
M_PUSH_PICKED = "PushPicked"
M_PUSH_NO_TARGETS = "PushNoTargets"

ALL_METRICS = (
    M_RUN_FINISHED, M_RUN_SUCCEEDED, M_RUN_ZERO_OUTPUT, M_COMPLETENESS,
    M_DISPATCH_ATTEMPTED, M_DISPATCH_FAILED, M_DISPATCH_FAILURE_RATIO,
    M_DISPATCH_UNMAPPED, M_QUOTA_USED_RATIO, M_QUOTA_LIMIT_UNKNOWN,
    M_RECON_AWAITING, M_RECON_PROBED, M_RECON_RESOLVED, M_RECON_NO_MAPPING,
    M_RECON_UNKNOWN_STATUS, M_RECON_PROBE_FAILED,
    M_RECON_DA_TARGET_UNRESOLVED,
    M_COVERAGE_MISSING_ROWS, M_COVERAGE_LOW, M_COVERAGE_MISSING_INSTANCES,
    M_PUSH_SENT, M_PUSH_FAILED, M_PUSH_PICKED, M_PUSH_NO_TARGETS,
)

_RECON_METRIC_BY_KEY = {
    "awaiting": M_RECON_AWAITING,
    "probed": M_RECON_PROBED,
    "resolved": M_RECON_RESOLVED,
    "no_mapping": M_RECON_NO_MAPPING,
    "unknown_status": M_RECON_UNKNOWN_STATUS,
    "probe_failed": M_RECON_PROBE_FAILED,
    "da_target_unresolved": M_RECON_DA_TARGET_UNRESOLVED,
}
"""对账 stats 的键 → 指标名。

⚠️ **不是**把 stats 里所有键都打出去。`accounts` / `still_running` /
`attached` 是排障用的上下文，进指标只会增加成本而没人对它们建告警；
它们仍然在 EMF 行的非维度字段里，用 Logs Insights 能查。
"""

_COUNT = "Count"
_PERCENT = "Percent"


def _emit(
    metric: str, value: float, *, unit: str = _COUNT,
    dimensions: Mapping[str, str] | None = None,
    context: Mapping[str, Any] | None = None,
) -> None:
    """发一条 EMF 行。

    `dimensions` 进维度（必须低基数）；`context` 只进同一行的普通字段
    （高基数信息走这里，用 Logs Insights 查）。

    ⚠️ EMF 的三条硬要求，少一条 CloudWatch 就**什么都抽不到**（且不报错）：
      ① metric 名必须同时作为顶层字段存在
      ② 每个维度名也必须作为顶层字段存在
      ③ 单行 —— EMF 按单条 log event 解析，换行会把它切成两条废日志
    """
    if not _ENABLED:
        return
    try:
        dims = {k: str(v) for k, v in (dimensions or {}).items()}
        # 🔴 **两个** DimensionSet，空的那个不能省。
        #
        # EMF 规范：一个 DimensionSet 可以为空，且**每个 DimensionSet 都会生成
        # 一条独立指标**（
        # https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
        # ）。只发带维度的那个，会让 CloudWatch 里**只存在**
        # `(RunType, Surface)` 组合下的指标 —— 于是 CDK 里不带维度的 Alarm
        # 查不到任何数据点，表现是**假绿灯**（无数据 + treatMissingData）。
        #
        # 空集给告警用（跨 run_type 聚合，「有没有任何一轮出事」）；
        # 带维度那个给人看（分类型拆开排障）。
        dim_sets: list[list[str]] = [[]]
        if dims:
            dim_sets.append(sorted(dims))
        payload: dict[str, Any] = {
            "_aws": {
                "Timestamp": int(time.time() * 1000),
                "CloudWatchMetrics": [{
                    "Namespace": NAMESPACE,
                    "Dimensions": dim_sets,
                    "Metrics": [{"Name": metric, "Unit": unit}],
                }],
            },
            **dims,
            **{k: v for k, v in (context or {}).items()},
            metric: value,
        }
        print(_json.dumps(payload, separators=(",", ":"), default=str), flush=True)
    except Exception:                          # noqa: BLE001
        # 观测不得成为新的故障源。
        logger.debug("EMF 打点失败（忽略）: %s", metric, exc_info=True)


def emit_run_signals(sig: RunSignals, *, surface: str = "executor") -> None:
    """一轮 run 结束后打点（R11c.3 的 P1 / P2 数据源）。

    ⚠️ **必须在 `finish_run` 之后调**，且失败也要调 —— 「连续 2 天全账号失败」
    数的是 `RunSucceeded` 的日 Sum 是否为 0，而失败的那些轮如果压根不打点，
    CloudWatch 看到的是「无数据」而不是「0 次成功」。两者的
    `treatMissingData` 语义不同，混起来会让告警在真出事时反而不响。
    """
    dims = {"Surface": surface, "RunType": sig.run_type}
    # 高基数信息只进普通字段，不进维度（见模块 docstring）。
    ctx = {"account_id": sig.account_id, "status": sig.status,
           "dry_run": sig.dry_run}

    _emit(M_RUN_FINISHED, 1, dimensions=dims, context=ctx)
    # 0 也要发。只在成功时发会让「全失败」表现为无数据而不是 0。
    _emit(M_RUN_SUCCEEDED, 1 if sig.succeeded else 0, dimensions=dims, context=ctx)
    _emit(M_RUN_ZERO_OUTPUT, 1 if sig.zero_output else 0,
          dimensions=dims, context=ctx)

    if sig.completeness_pct is not None:
        _emit(M_COMPLETENESS, sig.completeness_pct, unit=_PERCENT,
              dimensions=dims, context=ctx)

    # 🔴 dry_run 整段跳过派发类指标：预演刻意「照常算、不真发」，
    #    built>0 而 dispatched==0 → 失败率 100% → 每次预演误报一次 P2，
    #    而预演正是灰度第 ① 段每天都要做的事（12.4）。
    if sig.dry_run:
        return
    if sig.dispatch_attempted is not None:
        _emit(M_DISPATCH_ATTEMPTED, sig.dispatch_attempted,
              dimensions=dims, context=ctx)
    if sig.dispatch_failed is not None:
        _emit(M_DISPATCH_FAILED, sig.dispatch_failed, dimensions=dims, context=ctx)
    ratio = sig.dispatch_failure_pct
    if ratio is not None:
        _emit(M_DISPATCH_FAILURE_RATIO, ratio, unit=_PERCENT,
              dimensions=dims, context=ctx)
    if sig.dispatch_unmapped is not None:
        _emit(M_DISPATCH_UNMAPPED, sig.dispatch_unmapped,
              dimensions=dims, context=ctx)


def emit_quota(
    *, used_ratio: float, monthly_limit_seconds: float,
    consumed_seconds: float, surface: str = "scheduler",
) -> None:
    """DA 额度用量（R11c.3 的 P3 数据源）。

    🔴 **`monthly_limit_seconds <= 0` 时不发 ratio，改发 `DaQuotaLimitUnknown`。**

    分母未知时 `BudgetState.used_ratio` 恒返回 `0.0`（那是「不启用预算护栏」的
    表达，不是「用了 0%」）。照发 ratio 会得到一个**永远绿的告警** ——
    而当前所有部署都是这个状态：`MONTHLY_LIMIT_SECONDS` 默认 `-1`，
    且 Phase 0 的 0.4b（额度的权威读法）还没有结论。

    ⇒ 让「我们不知道」变成一个**可告警的独立信号**，而不是长得像健康。
    这与 挂起 UI 那张「本月额度使用率」卡片是同一个理由。
    """
    dims = {"Surface": surface}
    ctx = {"consumed_seconds": round(consumed_seconds, 1),
           "monthly_limit_seconds": monthly_limit_seconds}
    if monthly_limit_seconds and monthly_limit_seconds > 0:
        _emit(M_QUOTA_USED_RATIO, max(0.0, min(100.0, used_ratio * 100.0)),
              unit=_PERCENT, dimensions=dims, context=ctx)
        _emit(M_QUOTA_LIMIT_UNKNOWN, 0, dimensions=dims, context=ctx)
        return
    _emit(M_QUOTA_LIMIT_UNKNOWN, 1, dimensions=dims, context=ctx)


def emit_reconcile(
    stats: Mapping[str, Any], *, surface: str = "reconciler",
) -> None:
    """对账结果打点。

    ⚠️ 每个指标都发，**包括 0**。只在非 0 时发会让「本轮没有待对账的」
    与「对账压根没跑」在 CloudWatch 里长得一样（都是无数据），
    而后者意味着判读回不来这件事永远不会被发现。
    """
    dims = {"Surface": surface}
    # 全部 stats 都进非维度字段：排障时要看 accounts / still_running /
    # attached，但它们不值得各占一条指标。
    ctx = {k: v for k, v in stats.items()}
    for key, metric in _RECON_METRIC_BY_KEY.items():
        _emit(metric, float(stats.get(key) or 0), dimensions=dims, context=ctx)


def emit_coverage(
    stats: Any, *, run_type: str, surface: str = "reconciler",
) -> None:
    """采集覆盖缺口打点（R13.14）。

    `stats` 是 `inspection.domain.coverage.CoverageStats`。

    ⚠️ 三个数都发，**包括 0**。只在有缺口时发会让「今天全都齐」与
    「对账没跑」在 CloudWatch 里长得一样，而后者意味着缺口永远不会被发现。

    ⚠️ 账号 ID 进**非维度**字段（`accounts`）。它是高基数：进维度会让
    N 个账号各占一条曲线，而我们要问的是「有没有缺口」而不是
    「哪个账号有缺口」—— 后者用 Logs Insights 查同一行即可。
    """
    dims = {"Surface": surface, "RunType": run_type}
    ctx = {
        "checked": getattr(stats, "checked", 0),
        # dict 会被 json 序列化进同一行，Logs Insights 能直接查。
        "accounts": getattr(stats, "accounts", {}),
    }
    _emit(M_COVERAGE_MISSING_ROWS, float(getattr(stats, "missing_rows", 0)),
          dimensions=dims, context=ctx)
    _emit(M_COVERAGE_LOW, float(getattr(stats, "low_completeness", 0)),
          dimensions=dims, context=ctx)
    _emit(M_COVERAGE_MISSING_INSTANCES,
          float(getattr(stats, "missing_instances", 0)),
          dimensions=dims, context=ctx)


def emit_push(stats: Mapping[str, Any], *, surface: str = "push") -> None:
    """推送结果打点。

    ⚠️ 四个数都发，**包括 0**。`PushSent=0` 与「推送 Lambda 压根没跑」
    在 CloudWatch 里必须区分得开 —— 后者意味着客户从此收不到任何东西，
    而那是这套系统对客户唯一可见的产物。

    🔴 **`PushNoTargets` 是独立指标而不是 stats 里的一个键**：
    「装好了但没有任何投递目标」是一个可以持续数周不被发现的状态
    （巡检在跑、看板有数据、只是没人收到推送）。它值得一条能建告警的曲线。

    ⚠️ `kinds` 不进维度：它是 `["daily"]` / `["daily","weekly"]` 这种组合，
    进维度会让维度基数随组合数增长，而我们只想知道「发出去了几条」。
    """
    dims = {"Surface": surface}
    ctx = {k: v for k, v in stats.items()}
    _emit(M_PUSH_SENT, float(stats.get("sent") or 0), dimensions=dims, context=ctx)
    _emit(M_PUSH_FAILED, float(stats.get("failed") or 0),
          dimensions=dims, context=ctx)
    _emit(M_PUSH_PICKED, float(stats.get("picked") or 0),
          dimensions=dims, context=ctx)
    # ⚠️ `targets < 0` = 「这一轮没走到解析目标那一步」（kill switch 拉停）。
    #    只判 `not targets` 会把拉停也算成「装好了但没人收到」—— 那是运维的
    #    显式动作，不是故障。0 才是真的「一个可用目标都没有」。
    n_targets = stats.get("targets")
    try:
        n_targets = int(n_targets)
    except (TypeError, ValueError):
        n_targets = -1
    _emit(M_PUSH_NO_TARGETS, 1.0 if n_targets == 0 else 0.0,
          dimensions=dims, context=ctx)
