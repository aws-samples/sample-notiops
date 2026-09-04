"""`CreateBacklogTask` 请求的组装（R5.2 / R5.5 / R5.7）。

纯函数层：把「一批 finding 载荷」变成「一个 API 请求 dict」，不发请求。

## API 硬限（2026-08-19 从 botocore `devops-agent` service model 逐项核，不凭记忆）

```
agentSpaceId   必填   pattern [a-zA-Z0-9-]{1,64}
taskType       必填   enum INVESTIGATION | EVALUATION | RELEASE_READINESS_REVIEW
                           | RELEASE_TESTING
title          必填   min 1  max 400
description    可选   min 0  max 10000
priority       必填   enum CRITICAL | HIGH | MEDIUM | LOW | MINIMAL
clientToken    可选   idempotencyToken
reference      可选   —— 但 4 个成员必填：system / referenceId /
                        referenceUrl / associationId
```

## 为什么 SHALL NOT 传 `reference`

2026-08-19 真发 task 到本账号 agent space 实测：

```
四字段齐全 + system="notiops"  ❌ ValidationException
                                 Unknown data plane service name: 'notiops'
四字段齐全 + system="aws"       ❌ 同上（连内建的 aws 都不接受）
完全不传 reference              ✅ 成功
```

`system` 必须是已注册的 data plane service，而 `RegisterService` 的枚举只有
14 个第三方类型，**没有「自定义外部系统」**；`ListServices` 在本账号返回 0 条。

即使能注册，`referenceId` 的 pattern `[a-zA-Z0-9_.-]+` 也装不下带 `#` 的
`finding_id`（实测 `111122223333#us-east-1#rds#db-1#gp2_volume#-` 不匹配）。

⇒ `finding_id` 只能**内联进 description 的载荷里**，这是 7.1 把
`finding_id` 放进每条 finding 的原因。

## 装箱与截断的不对称

```
title        超 400 → **截断**。它是给人看的一行摘要，截掉尾巴不丢信息。
description  超 10000 → **绝不截断**，改为少装一条 finding。
             截断会把最后那条 finding 的 JSON 截半 → DA 解析失败 →
             整批判读丢失，而 API 返回 200。
```
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from inspection.domain import payload as pl
from inspection.domain.dto import Severity
from inspection.domain.schedule import RunType

TASK_TYPE = "INVESTIGATION"
"""四种 taskType 里只有它是「让 agent 去查」。

`EVALUATION` 是评估已有结论、两个 RELEASE_* 是发布相关，都不是巡检要的。
"""

TITLE_MAX = 400
"""`title` 的 API 硬限。"""

DESCRIPTION_MAX = pl.DESCRIPTION_LIMIT
"""`description` 的 API 硬限（10000）。与 payload 模块同一个常量。"""

# Severity（我们 4 档）→ priority（DA 5 档）。
#
# ⚠️ 必须**穷尽** Severity 的全部取值。漏一个会在那一档上 KeyError，
#    而那是派发路径上的异常 —— 整批 finding 一条都发不出去。
# ⚠️ INFO → MINIMAL 而不是 LOW：R7.7 下 INFO 本来就不该被派发
#    （`Tier.allows` 会挡掉），万一漏到这里也不该占用 LOW 那一档的注意力。
_PRIORITY_BY_SEVERITY: Mapping[Severity, str] = {
    Severity.CRITICAL: "CRITICAL",
    Severity.HIGH: "HIGH",
    Severity.MEDIUM: "MEDIUM",
    Severity.INFO: "MINIMAL",
}

VALID_PRIORITIES = frozenset(
    {"CRITICAL", "HIGH", "MEDIUM", "LOW", "MINIMAL"})
"""API 的 priority 枚举，用于本地预校验。"""


class TaskBuildError(RuntimeError):
    """组装阶段的失败。"""


def priority_for(severity: Severity | str) -> str:
    """严重度 → DA priority。"""
    sev = Severity.coerce(severity)
    try:
        return _PRIORITY_BY_SEVERITY[sev]
    except KeyError as e:                      # pragma: no cover - 枚举已穷尽
        raise TaskBuildError(f"没有为 {sev} 定义 priority 映射") from e


def batch_priority(payloads: Sequence[Mapping[str, Any]]) -> str:
    """一批 finding 的 priority = 其中**最严重**的那一条。

    ⚠️ 不用平均值或最多数。装箱把 6 条 finding 合成一个 task，
    里面只要有一条 CRITICAL，这个 task 就该按 CRITICAL 排队 ——
    取平均会让「1 条 CRITICAL + 5 条 MEDIUM」被排到 MEDIUM，
    而 DA 的调度顺序真的看这个字段。
    """
    if not payloads:
        raise TaskBuildError("空批次没有 priority")
    best = min(
        (Severity.coerce(str(p.get("severity", "INFO"))) for p in payloads),
        key=lambda s: s.order,
    )
    return priority_for(best)


def client_token(*, finding_ids: Sequence[str], run_id: str) -> str:
    """幂等键 `hash(finding_id#run_id)`（R5.2 / R5.5）。

    ⚠️ 用 sha256 不用内置 `hash()`：后者带 `PYTHONHASHSEED` 随机化，
    每个 Lambda 冷启动算出的值都不同 → 重投时 API 认不出这是同一次请求
    → **同一批 finding 被派两次**，额度翻倍，而且完全不报错。

    ⚠️ `finding_ids` 先排序：装箱顺序的抖动不该产生新的幂等键。
    """
    if not run_id:
        raise TaskBuildError("client_token 需要 run_id")
    body = "|".join(sorted(set(finding_ids))) + "#" + run_id
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# 7.6 按 run 类型路由到对应 skill
# ---------------------------------------------------------------------------

_ROUTING_HEADER: Mapping[RunType, str] = {
    RunType.HIGH: (
        "资源巡检 · 高负载判读请求。以下是确定性规则算出的越线结果，"
        "请判断每条是真实风险还是预期行为，并给出可执行的处置建议。"
    ),
    RunType.IDLE: (
        "资源巡检 · 闲置与成本判读请求。以下是确定性规则算出的闲置与结构性结果，"
        "请判断每条是真闲置还是有理由地闲着，并给出明确的处置结论。"
    ),
}
"""task description 的开头。

⚠️ **这段措辞就是路由本身。** 两份判读 skill 的激活靠 DA 对 description
做模型匹配（不是显式挂载），措辞写偏会加载到另一份 skill、或两份都不加载
（后者从外面完全看不出来，报告照样出，只是退化成 DA 的通用发挥 —— 见 7.9a）。
"""

_HIT_REASON_GUIDANCE: Mapping[str, str] = {
    pl.HIT_THRESHOLD_HIGH: (
        "`threshold_high`：指标已越过阈值。请判断是真实风险还是预期行为。"
    ),
    pl.HIT_CHRONIC_HIGH: (
        "`chronic_high`：**已持续多日处于风险水位**（每条 finding 的 "
        "`judgment.chronic_days` 是持续天数，`judgment.coverage_days` 是窗口内"
        "有数据的天数）。⚠️ 这类 finding **今天可能并没有越线** —— "
        "请勿只看最新值就判为健康，要判断这是真劣化还是业务本来的水位。"
    ),
    pl.HIT_IDLE: (
        "`idle`：规则判定为闲置。请判断是**真闲置**还是**有理由地闲着**"
        "（灾备、季节性、合规留存），并给出明确的 disposition。"
    ),
    pl.HIT_STRUCTURAL: (
        "`structural`：属性事实（如 gp2 卷、单 AZ、引擎将 EOL）。"
        "这类不需要辩论是非 —— 只判影响面与迁移代价。"
    ),
}
"""每类 hit_reason 的判读要求（R5.7 / 设计的 hit_reason 表）。

⚠️ `chronic_high` 那条是必须写明的：它可能今天并没越线，
不标注则 DA 看最新值「还行」就判健康 —— 而慢性劣化是唯一能兜住
渐进式劣化的规则（R2.6.3）。
"""


def routing_header(run_type: RunType) -> str:
    if run_type not in _ROUTING_HEADER:
        raise TaskBuildError(f"没有为 {run_type} 定义路由措辞")
    return _ROUTING_HEADER[run_type]


def _expected_skill(run_type: RunType) -> str:
    """这类巡检该加载哪份 skill。取自 `journal_gate.EXPECTED_SKILL`。

    ⚠️ 缺映射就抛，不要退回一个空串或猜一个名字：description 里写着
    `expected_skill:` 后面跟空白，会让 journal 门禁的对照失去意义，
    而那正是加这一行的唯一目的。
    """
    from inspection.domain import journal_gate as jg

    name = jg.EXPECTED_SKILL.get(run_type.value, "")
    if not name:
        raise TaskBuildError(
            f"journal_gate.EXPECTED_SKILL 没有为 {run_type.value!r} 定义 skill —— "
            "新增 run 类型时两处必须一起加"
        )
    return name


def guidance_for(payloads: Sequence[Mapping[str, Any]]) -> list[str]:
    """本批里出现过的 hit_reason 各自的判读要求。

    ⚠️ 只放**本批真的出现过**的那几类。全部塞进去会让 description 里
    大半是与这批无关的说明，挤占 10000 字符的装箱空间，
    也让 DA 去找不存在的 hit_reason。
    """
    seen: set[str] = set()
    for p in payloads:
        for r in p.get("hit_reason", ()) or ():
            seen.add(str(r))
    return [_HIT_REASON_GUIDANCE[r] for r in
            (pl.HIT_THRESHOLD_HIGH, pl.HIT_CHRONIC_HIGH,
             pl.HIT_IDLE, pl.HIT_STRUCTURAL)
            if r in seen]


# ---------------------------------------------------------------------------
# 组装
# ---------------------------------------------------------------------------


def build_title(
    *, run_type: RunType, account_id: str, data_date: date,
    payloads: Sequence[Mapping[str, Any]],
) -> str:
    """一行摘要。超 400 字符**截断**（它是给人看的，截尾不丢数据）。"""
    kind = "高负载" if run_type is RunType.HIGH else "闲置与成本"
    n = len(payloads)
    instances = sorted({str(p.get("instance", "")) for p in payloads if p.get("instance")})
    head = ", ".join(instances[:3])
    more = f" 等 {len(instances)} 台" if len(instances) > 3 else ""
    title = (f"[巡检-{kind}] {account_id} {data_date.isoformat()} "
             f"{n} 条待判读: {head}{more}")
    return title[:TITLE_MAX]


def build_description(
    *, run_type: RunType, payloads: Sequence[Mapping[str, Any]],
    batch_id: str = "",
) -> str:
    """task 的 description —— 载荷**直接内联**，不落 S3（7.2）。

    实测单 finding 载荷 1227~1623 字符、挂 15 个关联指标约 3700，
    上限 10000 → S3 与指针方案都不需要。

    ⚠️ 超限**抛错而不截断**。截断会把最后那条 finding 的 JSON 截半 →
    DA 解析失败 → 整批判读丢失，而 `CreateBacklogTask` 返回 200。
    调用方该做的是少装一条（`payload.pack_payloads` 已按 8500 预留边际）。
    """
    if not payloads:
        raise TaskBuildError("空批次不能组装 description")

    lines = [
        pl.MARKER,
        "",
        # 机器可读的路由声明。
        #
        # 🔴 存在的理由：上面那句 `routing_header` 是**自然语言**，而 skill 的
        #    激活靠 DA 对 description 做语义匹配。措辞写偏会加载到另一份 skill、
        #    或两份都不加载 —— 后者从外面完全看不出来（报告照样出，只是退化成
        #    通用发挥，见 7.9a）。加这两行不是为了替代语义匹配（做不到），
        #    而是为了让**期望值本身**出现在 task 里：
        #
        #    ```
        #    出错时  journal 显示实际加载的 bundle 是 inspection-high-load
        #            而 task 自己写着 expected_skill: inspection-cost-idle
        #            ⇒ journal_gate 判 WRONG_SKILL 时手上有两边可对照的记录
        #    ```
        #
        # ⚠️ 值来自 `journal_gate.EXPECTED_SKILL`，**不在这里另写一份**。
        #    两处各写一份的代价：门禁按 A 期待、task 里写着 B，
        #    而它们永远不会互相校验。
        f"review_type: {run_type.value}",
        f"expected_skill: {_expected_skill(run_type)}",
        "",
        routing_header(run_type),
        "",
    ]
    if batch_id:
        lines += [f"batch_id: {batch_id}", ""]
    guidance = guidance_for(payloads)
    if guidance:
        lines.append("本批出现的判定类型及判读要求：")
        lines += [f"- {g}" for g in guidance]
        lines.append("")
    lines += [
        f"以下是 {len(payloads)} 条 finding 的完整载荷（JSON）：",
        json.dumps(list(payloads), ensure_ascii=False, sort_keys=True,
                   separators=(",", ":")),
    ]
    body = "\n".join(lines)
    if len(body) > DESCRIPTION_MAX:
        raise TaskBuildError(
            f"description {len(body)} 字符超过 API 上限 {DESCRIPTION_MAX} —— "
            "SHALL 少装一条 finding 而不是截断"
        )
    return body


@dataclass(frozen=True)
class TaskRequest:
    """一个 `CreateBacklogTask` 请求。"""

    agent_space_id: str
    title: str
    description: str
    priority: str
    client_token: str
    finding_ids: tuple[str, ...]
    task_type: str = TASK_TYPE

    def to_api_kwargs(self) -> dict[str, Any]:
        """转成 boto3 的入参。

        ⚠️ **不含 `reference`。** 实测传任何 `system` 都报
        `Unknown data plane service name`，而不传就能成功。
        `finding_id` 通过 description 里的载荷内联传递。
        """
        return {
            "agentSpaceId": self.agent_space_id,
            "taskType": self.task_type,
            "title": self.title,
            "description": self.description,
            "priority": self.priority,
            "clientToken": self.client_token,
        }


def build_task(
    *, run_type: RunType, account_id: str, data_date: date, run_id: str,
    agent_space_id: str, payloads: Sequence[Mapping[str, Any]],
    batch_id: str = "",
) -> TaskRequest:
    """一批 finding → 一个 task 请求（7.4：task 与 finding 解耦）。

    ⚠️ task **只是一次判读请求**，不是 finding 的状态容器。
    finding 状态机仍按 (instance, rule, metric) 独立演进 ——
    把状态挂在 task 上会让「6 条 finding 合成一个 task」之后
    它们的生命周期被绑死，而它们本来各自独立地出现和消失。
    """
    if not agent_space_id:
        raise TaskBuildError("缺 agentSpaceId")
    finding_ids = tuple(str(p["finding_id"]) for p in payloads
                        if p.get("finding_id"))
    if len(finding_ids) != len(payloads):
        # 7.1 要求 finding_id 内联进每条 finding —— 缺了就无法回收结论
        raise TaskBuildError("有 finding 缺 finding_id，无法回收判读结论")

    return TaskRequest(
        agent_space_id=agent_space_id,
        title=build_title(run_type=run_type, account_id=account_id,
                          data_date=data_date, payloads=payloads),
        description=build_description(run_type=run_type, payloads=payloads,
                                      batch_id=batch_id),
        priority=batch_priority(payloads),
        client_token=client_token(finding_ids=finding_ids, run_id=run_id),
        finding_ids=finding_ids,
    )


# ---------------------------------------------------------------------------
# 7.4d 零命中 heartbeat
# ---------------------------------------------------------------------------

HEARTBEAT_PRIORITY = "MINIMAL"
"""heartbeat 不该和真 finding 抢调度顺序。"""


def build_heartbeat_task(
    *, run_type: RunType, account_id: str, data_date: date, run_id: str,
    agent_space_id: str, evaluated: int, completeness: float,
    closest: Sequence[Mapping[str, Any]] = (),
) -> TaskRequest:
    """零命中时的 heartbeat task。

    ⚠️ **零命中必须也派一条。** 否则「规则全都没命中」与「判定链路整段坏了」
    在外部表现完全一样：报告上都是「本轮无风险」。heartbeat 的载荷是全量
    健康摘要（评估集合大小、各指标最接近阈值的前几名及其 headroom、
    本轮 completeness），DA 对它的判读能反过来验证我们的阈值是否合理。

    ⚠️ R12.2 的「月末已用 <70% 放宽 top-N」**补不了这个洞** ——
    它放宽的是第 ③ 层截断，而命中数为 0 时无从放宽。
    """
    if not agent_space_id:
        raise TaskBuildError("缺 agentSpaceId")

    kind = "高负载" if run_type is RunType.HIGH else "闲置与成本"
    body = {
        "schema_version": pl.SCHEMA_VERSION,
        "kind": "heartbeat",
        "run_type": run_type.value,
        "account_id": account_id,
        "data_date": data_date.isoformat(),
        "evaluated_instances": evaluated,
        "completeness": round(float(completeness), 4),
        "closest_to_threshold": list(closest),
    }
    lines = [
        pl.MARKER,
        "",
        f"资源巡检 · {kind}轮**零命中**健康摘要。",
        "本轮确定性规则没有产出任何 finding。请核对下面的健康摘要是否合理 ——",
        "若其中有项目你认为应当被报出来，说明我们的阈值需要调整。",
        "⚠️ 这条不是风险告警，SHALL NOT 据此产出处置建议。",
        "",
        json.dumps(body, ensure_ascii=False, sort_keys=True,
                   separators=(",", ":")),
    ]
    description = "\n".join(lines)
    if len(description) > DESCRIPTION_MAX:
        # heartbeat 的 closest 列表是可裁的（它只是抽样），这里给出明确信号
        raise TaskBuildError(
            f"heartbeat description {len(description)} 字符超限 —— "
            "SHALL 减少 closest_to_threshold 的条数"
        )
    title = (f"[巡检-{kind}] {account_id} {data_date.isoformat()} "
             f"零命中健康摘要（已评估 {evaluated} 台）")[:TITLE_MAX]
    return TaskRequest(
        agent_space_id=agent_space_id,
        title=title,
        description=description,
        priority=HEARTBEAT_PRIORITY,
        client_token=client_token(
            finding_ids=[f"heartbeat#{run_type.value}"], run_id=run_id),
        finding_ids=(),
    )
