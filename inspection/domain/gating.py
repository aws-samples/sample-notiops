"""派发闸门：这条 finding 要不要花额度调 DA（R5.11 / R5.12）。

两条独立的闸门放在同一模块，因为**报告必须解释为什么没调 DA** ——
「为什么这条没有 AI 分析」的说明词汇散成两处，就会出现两种口径。

```
finding
   │
   ├─ ① playbook 命中？   R5.11  → 给确定性结论，不调 DA
   ├─ ② N 天内同情形？     R5.12  → 沿用上次结论 + 标注增量
   ├─ ③ Tier 放行？       R12.2  → budget.Tier.allows()
   └─ 都过 → 派发
```

顺序有意义：playbook 在最前。它是**免费且更准**的路径 ——
「FreeStorageSpace 在降」这件事，「表 X 增长 40GB、binlog 20GB」是确定性可查的，
让 LLM 去猜只会得到一段更委婉的同样结论，还要花钱。

## 「同一情形」的定义（R5.12，v1）

```
形态哈希 = sha256(hit_reason 集合 已排序 | severity 档位)
```

⚠️ **不含指标数值。** 含了的话 CPU 从 91% 变 92% 就成了「新情形」，
复用永远不触发 —— 而那两天的判读结论逐字相同。

⚠️ **含 severity 档位。** 不含的话 MEDIUM 升到 CRITICAL 会被当成同一情形而复用
旧结论，于是「情况恶化了」这件事在报告上完全看不出来。
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from enum import Enum
from typing import Any

from inspection.domain.budget import Tier
from inspection.domain.dto import Severity

CONCLUSION_REUSE_DAYS = 7
"""R5.12：同一情形在 N 天内不重复调 DA。与 requirements 的配置表同值。"""

DETERMINISTIC_RUN_TYPES: frozenset[str] = frozenset({"idle"})
"""判定全程确定性完成、设计上不派发 DA 的轮次（值取 `schedule.RunType`）。

## 为什么闲置轮在这里

闲置的整条链路已经是确定性的：

```
候选门槛(AND)  →  六维加权评分  →  双否决  →  成本核算  →  排序
cpu_avg<2%        cpu .40           峰值 CPU     monthly_cost
connections<5     connections .30   隐形负载      savings
                  storage .20                    downsize_target
                  iops .10
```

派发 DA 只会让它把 `downsize_target` 换一种说法重复一遍，而误判代价
本身也不对称：

```
闲置误判   →  建议了一个不该降的  →  客户驳回，损失一次沟通
高负载误判 →  漏了一个要挂的      →  故障
```

只有后者值得花额度。

⚠️ 用字符串集合而不是 import `schedule.RunType`：`domain/schedule.py`
不属于这一层的依赖，为一个枚举值引入模块依赖会让 gating 从"纯决策"
变成"知道调度怎么排"。字符串值由 `assemble.apply_gates` 传入。
"""

_IDLE_NOTE = (
    "闲置判定由评分链路确定性完成：多维加权评分（CPU / 连接数 / 存储 / IOPS）"
    "+ 峰值与隐形负载双否决 + 成本核算。结论与降配目标见本条的评分明细，"
    "无需 AI 判读。"
)
_CAPACITY_NOTE = (
    "超配判定由容量审计确定性算出：实测占用与规格的比值 + CPU 峰值否决，"
    "降配目标与预计节省见本条明细，无需 AI 判读。"
)
_STRUCTURAL_NOTE = (
    "结构性规则按资源配置直接判定（describe 结果即可确定），"
    "不依赖指标推理，因此无需 AI 判读。"
)

_CAPACITY_REASONS = frozenset({"oversized_storage", "oversized_memory"})


def deterministic_conclusion(reasons: Iterable[str]) -> str:
    """`DETERMINISTIC` 档在报告上的说明，按 finding 类别分档。

    🔴 **不能只写一段。** 闲置轮里跑的是**三类**判定
    （日志原话：「结构性 4 + 容量 1 + 闲置 1」），而三者的"结论在哪"
    是不同的答案：

    ```
    idle                 → 六维评分明细 + 成本
    oversized_*          → 容量审计的占用比值 + downsize_target
    gp2_volume / eol /   → describe 出来的配置事实，压根没有指标
    single_az / ...
    ```

    第一版只写了闲置那一段，于是一条 `gp2_volume` 的 finding 上会挂着
    「六维加权评分（CPU / 连接数 / 存储 / IOPS）」—— 那条规则跟 CPU
    毫无关系。客户照着这句话去找评分明细，找不到。

    ⚠️ **必须有说明。** 没有 conclusion 的 `dispatch=False` 在报告上是
    **空的**（见 `Decision.has_conclusion`），而空白与「分析失败」长得一样。
    """
    rs = set(reasons)
    if "idle" in rs:
        return _IDLE_NOTE
    if rs & _CAPACITY_REASONS:
        return _CAPACITY_NOTE
    return _STRUCTURAL_NOTE


class SkipReason(str, Enum):
    """没有派发 DA 的原因。**每一种都要能在报告上说清楚。**

    ⚠️ 缺任何一种都会退化成「这条没有 AI 分析」这句无信息的话，
    而客户接着就会问「是坏了还是省钱」—— 那是两个完全不同的答案。
    """

    DETERMINISTIC = "deterministic"
    """这一轮的判定全程确定性完成，设计上就不调 DA。

    闲置轮属于这一类：六维加权评分 + 双否决 + 成本核算全在
    `inspection/domain/scoring/` 里跑完，「能不能降配」的答案是
    利用率与金额，不是根因推理。

    ⚠️ **不能并进 `PLAYBOOK`。** 两者在报告上是不同的话：
    playbook 是「这个**具体形态**我们有确定性答案」（一条一条命中的），
    DETERMINISTIC 是「这**整轮**本来就不需要 AI」。混在一起会让客户
    以为闲置报告里那些没有 AI 段落的条目是"碰巧命中了模板"，
    进而怀疑剩下的是不是漏了分析。

    ⚠️ 也不能并进 `BUDGET`。那一档的表述是「因额度未分析」——
    在这里是假的，会把一个设计选择说成资源不足。
    """
    PLAYBOOK = "playbook"
    """命中已知模式，给了确定性结论（R5.11）。**比 DA 更准，不是降级。**"""
    REUSED = "reused"
    """N 天内同情形，沿用上次结论（R5.12）。"""
    BUDGET = "budget"
    """本轮额度档位不放行这个 severity（R12.2）。"""
    QUOTA = "quota"
    """本轮派发条数配额已用满（R12.6）。"""
    ROLLUP_MEMBER = "rollup_member"
    """同一集群同一指标已有一条集群级结论覆盖它（R12.6a ①）。

    🔴 **不能并进 `QUOTA` 或 `BUDGET`。** 那两档的表述是「资源不够所以没分析」，
    而这一档是「已经分析过了，结论在集群那条上」—— 客户读到「因额度未分析」
    会以为自己漏看了什么。

    ⚠️ 这一档必须带 `conclusion`（指向覆盖它的那条），否则报告上是空白 ——
    见 `Decision.has_conclusion` 的说明。
    """
    KILL_SWITCH = "kill_switch"
    """`da_enabled` 开关被人拉停了（R11c.1）。

    ⚠️ **不能并进 `BUDGET`。** 那一档对客户的表述是「按严重度排序靠后」——
    在开关场景下那句话是假的：拉停是全量停，与 severity 无关。
    客户读到「我这条不够严重」，而真相是我们整体停了判读。
    """


@dataclass(frozen=True)
class Decision:
    """一条 finding 的派发决定。"""

    dispatch: bool
    reason: SkipReason | None = None
    conclusion: str = ""
    """`PLAYBOOK` 时是确定性结论；`REUSED` 时是沿用的旧结论。"""
    reused_from: date | None = None
    """`REUSED` 时上次结论的日期。**必须写出来** —— 报告上「7 天前的结论」
    与「今天的结论」对读者是不同的东西。"""
    delta_note: str = ""
    """`REUSED` 时的增量说明（R5.12 要求「标注增量」）。"""

    @property
    def has_conclusion(self) -> bool:
        """有没有可展示的结论。

        ⚠️ `dispatch=False` 且没有结论 = 这条 finding 在报告上是**空的**。
        只有 BUDGET / QUOTA 是那种情况，且它们必须显式告诉客户
        「因额度未分析」而不是留白。
        """
        return bool(self.conclusion)


# ---------------------------------------------------------------------------
# ① 已知模式 playbook（R5.11）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PlaybookRule:
    """一条已知模式。

    匹配上就给确定性结论 —— **这是升级不是降级**：
    「binlog 占了 20GB，`binlog_expire_logs_seconds` 是 7 天」这种话
    LLM 说不出比它更准的版本，只会说得��委婉。
    """

    rule_id: str
    metric: str
    hit_reasons: frozenset[str]
    """必须**全部**出现才算命中。空集表示不看 hit_reason。"""
    conclusion: str
    """确定性结论。支持 `{instance_id}` / `{value}` / `{threshold}` 占位。"""
    services: frozenset[str] = frozenset()
    """限定服务（`rds` / `elasticache`）。空集表示不限。"""
    max_severity: Severity = Severity.HIGH
    """严重度上限。**超过它就不再走 playbook，交给 DA。**

    ⚠️ 必须有这条。CRITICAL 意味着 MTTR 已经压到很短
    （生产库两天内撑不住），那时客户要的是「现在怎么办」的具体建议，
    而 playbook 只能给通用话术。省这一次额度换来一条没人敢照做的结论。
    """

    def matches(self, *, metric: str, service: str, reasons: Iterable[str],
                severity: Severity) -> bool:
        if metric != self.metric:
            return False
        if self.services and service not in self.services:
            return False
        if severity.order < self.max_severity.order:
            # order 越小越严重 → 比上限更严重
            return False
        if self.hit_reasons and not self.hit_reasons.issubset(set(reasons)):
            return False
        return True


DEFAULT_PLAYBOOK: tuple[PlaybookRule, ...] = (
    PlaybookRule(
        rule_id="storage_growth_deterministic",
        metric="FreeStorageSpace",
        hit_reasons=frozenset({"threshold_high"}),
        services=frozenset({"rds"}),
        conclusion=(
            "磁盘可用空间越线（当前 {value}，阈值 {threshold}）。"
            "这类问题的成因是确定性可查的，按顺序核对即可："
            "① `SELECT table_schema, table_name, "
            "ROUND((data_length+index_length)/1024/1024/1024,1) AS gb "
            "FROM information_schema.tables ORDER BY gb DESC LIMIT 10` "
            "找出最大的表；② `SHOW BINARY LOGS` 看 binlog 总量，"
            "并核对 `binlog_expire_logs_seconds`（默认 30 天，通常可降到 3~7 天）；"
            "③ 若开了慢查询日志或 general log，检查是否写在数据卷上。"
            "确认后再决定是扩容还是清理 —— 扩容不可逆（RDS 存储只能加不能减）。"
        ),
    ),
    # 🔴 **这条规则目前是死的**，而且不能靠提 `max_severity` 修（2026-08-26 查证）。
    #
    # ## 两层原因
    #
    # ① chronic-only 的 severity **恒为 HIGH**，而这里写 MEDIUM
    #    → `PlaybookRule.matches` 的 `severity.order < max_severity.order`
    #      永不成立。实测三个慢性可命中指标都是 HIGH：
    #      `severity_for_verdict` 给 chronic-only 的基线 headroom 是
    #      `MEDIUM_HEADROOM = 0.35`，而 `METRIC_FIX_ACTION` 里那些指标的 MTTR
    #      要么 ≥5 天（→ HIGH），要么 <5 但被慢性升档抬到 HIGH（cap=HIGH）。
    #
    # ② 提到 HIGH 之后它开始匹配**真的越线** finding —— 那比死规则糟得多。
    #    因为 `payload_hit_reasons` 按 R2.6.2 **总是**给慢性单独命中补上
    #    `threshold_high`（见那个函数的 docstring），所以：
    #
    #    ```
    #    慢性单独命中     hit_reasons = ["threshold_high", "chronic_high"]
    #    真越线 + 慢性    hit_reasons = ["threshold_high", "chronic_high"]   ← 一样
    #    ```
    #
    #    `hit_reasons` 这个维度**无法区分**两者。提 max_severity 的后果是一条
    #    真的 CPU 越线被回「这是容量规划信号而非故障，不需要立即处理」。
    #    （`test_different_hit_reasons_are_not_reused` 抓住了这一点。）
    #
    # ## 要修得先给 gating 一个「当天到底越没越线」的信号
    #
    # 那个信息在 `InstanceVerdict.hit` 上，而 `decide()` 收到的只有
    # `hit_reasons` / `severity` / `metric`。补一个 `breached: bool` 是可行的，
    # 但那是 gating 的入参契约变更（要动 `PlaybookRule` 的匹配语义、
    # `assemble.apply_gates` 的调用、以及 R5.11 的判据表述），
    # 值不值得取决于「省一次 LLM 判读」对额度的实际贡献 —— 留给做决定的人。
    #
    # ⚠️ **保持 MEDIUM**。死规则的代价是每条 chronic-only 多买一次判读（钱）；
    #    错规则的代价是把真越线说成「不需要处理」（信任）。两害取轻。
    # （历史说明见上）
    # 这条规则原来写 `max_severity=Severity.MEDIUM`，而 chronic-only 的 severity
    # **恒为 HIGH** —— 于是 `PlaybookRule.matches` 的
    # `severity.order < max_severity.order → return False` 永不成立，
    # 这条规则是**死的**。实测（三个慢性可命中指标各来一遍）：
    #
    # ```
    # chronic-only CPUUtilization  → Severity.HIGH   playbook 不命中
    # chronic-only FreeableMemory  → Severity.HIGH   playbook 不命中
    # chronic-only ReadLatency     → Severity.HIGH   playbook 不命中
    # ```
    #
    # 为什么恒 HIGH：`severity_for_verdict` 给 chronic-only 的基线 headroom 是
    # `MEDIUM_HEADROOM = 0.35`，而 `METRIC_FIX_ACTION` 里那些指标的 MTTR 要么
    # ≥5 天（`0.35 <= 0.35 且 mttr >= 5` → HIGH），要么 <5 但被慢性升档抬到
    # HIGH（cap=HIGH）。
    #
    # 后果：每条 chronic-only finding 都去买一次 LLM 判读，而这条规则本来就是
    # 为了省掉那一次（「CPU 长期高位但未越线」是容量规划信号，确定性可答）。
    #
    # ⚠️ 提到 HIGH 而不是去改 `severity_for_verdict`：那个基线是按真实分布
    #    校准过的（「不是今晚就炸，但处在压力平衡点上」），动它会牵动排序与推送。
    #    这里要表达的是「**这个形态**不管多严重都有确定性答案」。
    PlaybookRule(
        rule_id="chronic_only_no_breach",
        metric="CPUUtilization",
        hit_reasons=frozenset({"chronic_high"}),
        conclusion=(
            "CPU 长期处于高位但未越过告警阈值（当前 {value}）。"
            "这是容量规划信号而非故障：先看业务是否处在自然增长期，"
            "再决定是升配还是优化查询。**不需要立即处理**。"
        ),
        max_severity=Severity.MEDIUM,
    ),
)
"""内置 playbook。

⚠️ 刻意**只放两条**。playbook 的价值在于「确定性结论比 LLM 更准」，
而能满足这一条的模式很少。堆一堆半确定的规则进来，效果是把本该
深入分析的 finding 拦在门外，换回一段谁都不会照做的通用话术 ——
而客户看不出这条结论是「查过的」还是「模板」。
"""


def _fill(template: str, ctx: Mapping[str, object]) -> str:
    """填占位符。缺的键保留原样而不是抛 KeyError。

    ⚠️ 抛 KeyError 会让一条模板里的拼写错误干掉整轮巡检；
    保留 `{value}` 字面量至少能让人一眼看出是哪个占位没填上。
    """
    def sub(m: re.Match[str]) -> str:
        k = m.group(1)
        return str(ctx[k]) if k in ctx else m.group(0)

    return re.sub(r"\{(\w+)\}", sub, template)


def match_playbook(
    *, metric: str, service: str, reasons: Iterable[str], severity: Severity,
    context: Mapping[str, object] | None = None,
    playbook: Sequence[PlaybookRule] = DEFAULT_PLAYBOOK,
) -> Decision | None:
    """命中 playbook 就返回确定性结论，否则 None。

    ⚠️ 返回 `None` 而不是 `Decision(dispatch=True)`：
    「没命中 playbook」不等于「该派发」—— 后面还有复用与额度两道闸门。
    让这个函数直接说「派发」会把它变成一个假的总决策点。
    """
    reasons = list(reasons)
    for rule in playbook:
        if rule.matches(metric=metric, service=service, reasons=reasons,
                        severity=severity):
            return Decision(
                dispatch=False,
                reason=SkipReason.PLAYBOOK,
                conclusion=_fill(rule.conclusion, context or {}),
            )
    return None


# ---------------------------------------------------------------------------
# ② 结论复用（R5.12）
# ---------------------------------------------------------------------------


def shape_hash(reasons: Iterable[str], severity: Severity) -> str:
    """「同一情形」的哈希（R5.12，v1 定义）。

    ```
    sha256(hit_reason 集合 已排序 | severity 档位)
    ```

    ⚠️ **不含指标数值。** 含了的话 CPU 从 91% 变 92% 就成了「新情形」，
    复用永远不触发 —— 而那两天的判读结论逐字相同，白花两次额度。

    ⚠️ **含 severity 档位。** 不含的话 MEDIUM 升到 CRITICAL 会被当成同一情形
    而沿用旧结论，于是「情况恶化了」在报告上完全看不出来 ——
    那是比多花一次额度严重得多的错误。

    ⚠️ 用 sha256 不用内置 `hash()`：后者带 `PYTHONHASHSEED` 随机化，
    每个 Lambda 冷启动都不一样 → 复用永远命中不了，而且不报错。
    """
    body = "|".join((",".join(sorted(set(reasons))), severity.value))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


REUSE_DAYS_BY_VERDICT: Mapping[str, int] = {
    "real_degradation": 7,
    "expected_behaviour": 30,
    "warm_up": 3,
    "insufficient_evidence": 0,
}
"""按 DA 的 verdict 分档的复用期（天）。缺省用 `CONCLUSION_REUSE_DAYS`。

单一个 7 天对四种 verdict 一视同仁，而它们的"会不会变"差得很远：

```
real_degradation       7 天   问题在演化，隔一周该重新看
expected_behaviour    30 天   「这个形态在这台实例上是正常的」不太会变
warm_up                3 天   预热期短，要尽快复查
insufficient_evidence  0 天   **不复用** —— 数据补齐了就该重判，
                              沿用一句「证据不足」没有任何价值
```

🔴 `expected_behaviour` 那一档是这张表的**全部价值**：它把 DA 的判读结果
喂回抑制，得到自学习降噪。真实例子（2026-08-23 客户数据）：

```
rds-mars-live-rec   可用内存 1.3%、ReadIOPS 0.07/s
  第 1 轮  报出来 → DA 判 expected_behaviour（buffer pool 正常占用）
  之后 30 天  不再打扰客户
rds-mars-messages-s-1  可用内存 1.1%、ReadIOPS 491.7/s
  → DA 判 real_degradation → 7 天后重新判读，持续跟踪
```

⚠️ 0 是合法值且**必须**表示「不复用」，不能被当成「缺省」——
`try_reuse` 里用 `age > reuse_days` 判断，0 天时任何 age ≥ 0 都不复用。
"""


@dataclass(frozen=True)
class PriorConclusion:
    """上一次对同一 (resource, metric) 的 DA 结论。"""

    shape: str
    conclusion: str
    at: date
    severity: Severity
    verdict: str = ""
    """DA 的 verdict，决定复用期（见 `REUSE_DAYS_BY_VERDICT`）。
    空 = 老数据或解析失败 → 落回 `CONCLUSION_REUSE_DAYS`。"""

    def age_days(self, today: date) -> int:
        return (today - self.at).days

    def reuse_window(self, default: int = CONCLUSION_REUSE_DAYS) -> int:
        """这条结论该复用多少天。"""
        return REUSE_DAYS_BY_VERDICT.get(self.verdict, default)


def prior_from_item(item: Mapping[str, Any]) -> PriorConclusion | None:
    """DDB 的 finding 原始行 → `PriorConclusion`。缺任一必需字段返回 None。

    必需的四样：

    ```
    shape          `assemble.to_evidence` 落的形态哈希
                   ⚠️ 重建不出来 —— 行里只有单个 `rule` 段，
                     而 shape 要完整的 hit_reasons 集合
    da_body        判读全文。空的话复用等于沿用一段空话
    da_updated_at  判读时间（epoch 秒）→ 算 age
    severity       严重度升级时不复用（宁可多花一次额度）
    ```

    ⚠️ 用 `da_updated_at` 而**不是** `last_run_date`：前者是判读产生的时刻，
    后者是这条 finding 最后一次被评估的日期。拿后者算 age 会让一条
    「三天前判读、每天都还在命中」的结论看起来是"今天刚判的"，
    于是永远不过期。

    ⚠️ epoch → date 固定按 **UTC**：`data_date` 那一侧也是 UTC
    （R14 的「最后一个完整 UTC 日」），两边用不同时区会让 age 差一天。
    """
    shape = str(item.get("shape") or "").strip()
    body = str(item.get("da_body") or "").strip()
    ts = item.get("da_updated_at")
    if not shape or not body or ts is None:
        return None
    # 🔴 `da_body` 非空 ≠ 「上次拿到了结论」。R9.6 在**解析失败**时会把
    #    DA 回复的**原文**逐条挂到每条 finding 的 `da_body` 上（callback_apply
    #    的注释：「存原文，不丢」）—— 那是整个 task 最多 6 条 finding 的混合
    #    全文。`try_reuse` 的防线 `if not prior.conclusion` 假设的是
    #    「解析失败 → body 为空」，与 R9.6 的落库行为**正好相反**。
    #    不查 parse_status 的后果（2026-09-04 交叉 review 抓到）：
    #
    #    ```
    #    第 1 天  skill 没加载 → parse_failed → da_body = 原文 blob
    #    第 2 天  同形态命中 → try_reuse 命中 → Decision(REUSED,
    #             conclusion=<原文 blob>) → 卡片上出现一段「沿用昨天的分析」
    #             → 其实是含着别的资源分析的未解析原文
    #    且 7 天内不再派发 —— 恰好把 ensure_skills 次日自愈后的重判压住。
    #    ```
    #
    #    白名单 ok / partial：`partial` 时挂到**匹配上的**那几行的 body 是
    #    各自的分节正文（callback 逐节 attach），是真结论；`missing_section` /
    #    `parse_failed` / `empty` / `quota_exhausted` 行的 body 要么是原文
    #    要么是残留的旧值，一律不复用 —— 代价是多派一次判读，换的是
    #    「失败留痕」不被反转成「失败伪装成结论」。
    #
    # ⚠️ 空 parse_status 也拒。attach_judgment 自 R9.6 起每条路径都写
    #    parse_status，空值只能是更早的遗留行 —— 出处不明的 body 不该被
    #    盖上「N 天前的分析结论」的戳复用出去。
    status = str(item.get("da_parse_status") or "").strip()
    if status not in ("ok", "partial"):
        return None
    # ⚠️ 门禁判过**不可信**的判读不复用（D22 落库的 `da_gate_trustworthy`）。
    #    skill_not_loaded / wrong_skill / no_data_access 的结论是通用 LLM
    #    发挥或缺数据的空转 —— `expected_behaviour` 那档 30 天的静默期喂进
    #    这样一条 verdict，代价与复用 parse_failed 原文同型。
    #    判据是 `is False`：`None`（存量行 / 门禁没跑）不拦 —— 「不知道」
    #    不等于「不可信」，拦 None 会让全部存量判读一夜之间失去复用资格。
    if item.get("da_gate_trustworthy") is False:
        return None
    try:
        at = datetime.fromtimestamp(float(ts), tz=timezone.utc).date()
    except (TypeError, ValueError, OSError, OverflowError):
        return None
    try:
        sev = Severity(str(item.get("severity") or "").strip().upper())
    except ValueError:
        return None
    return PriorConclusion(
        shape=shape, conclusion=body, at=at, severity=sev,
        verdict=str(item.get("da_verdict") or "").strip(),
    )


def try_reuse(
    prior: PriorConclusion | None,
    *,
    reasons: Iterable[str],
    severity: Severity,
    today: date,
    reuse_days: int = CONCLUSION_REUSE_DAYS,
    delta_note: str = "",
) -> Decision | None:
    """N 天内同情形 → 沿用上次结论。否则 None。

    ⚠️ 严重度**升级**时不复用，即使形态哈希相同。
    哈希里已含 severity 所以正常情况下会自然失配，
    这里再显式挡一次 —— 那是「宁可多花一次额度」的取舍：
    漏报恶化的代价远大于一次调查的钱。
    """
    if prior is None:
        return None
    if not prior.conclusion:
        # 上次没拿到结论（解析失败 / 超时）→ 不能复用一段空话
        return None
    age = prior.age_days(today)
    if age < 0:
        # 上次结论的日期在未来 —— 数据有问题，不复用
        return None
    # 复用期按 verdict 分档（`REUSE_DAYS_BY_VERDICT`）。
    # ⚠️ 调用方显式传了 `reuse_days` 时它作为**缺省**参与 —— 认得出的
    #    verdict 优先按自己那一档，认不出的（老数据 / 空值）才用传进来的值。
    #    反过来（入参覆盖分档）会让 `expected_behaviour` 的 30 天永远生效不了，
    #    而那一档是整张表的价值所在。
    window = prior.reuse_window(reuse_days)
    # 🔴 0 的语义是「**完全不复用**」，不是「只复用当天的」。
    #    写成 `age > window` 时 `0 > 0` 为假 → 当天的照样被复用，而
    #    `insufficient_evidence` 那一档的全部意义就是"别沿用这句空话"。
    if window <= 0:
        return None
    if age > window:
        return None
    if severity.order < prior.severity.order:
        return None                      # 恶化了，重新分析
    if shape_hash(reasons, severity) != prior.shape:
        return None
    return Decision(
        dispatch=False,
        reason=SkipReason.REUSED,
        conclusion=prior.conclusion,
        reused_from=prior.at,
        delta_note=delta_note or f"沿用 {age} 天前（{prior.at}）的分析结论",
    )


# ---------------------------------------------------------------------------
# 总闸门
# ---------------------------------------------------------------------------


def decide(
    *,
    metric: str,
    service: str,
    reasons: Iterable[str],
    severity: Severity,
    today: date,
    tier: Tier,
    run_type: str = "",
    prior: PriorConclusion | None = None,
    context: Mapping[str, object] | None = None,
    playbook: Sequence[PlaybookRule] = DEFAULT_PLAYBOOK,
    reuse_days: int = CONCLUSION_REUSE_DAYS,
    quota_left: int | None = None,
    da_enabled: bool = True,
) -> Decision:
    """把五道闸门串起来。

    顺序：**确定性轮次** → playbook → 复用 → kill switch → 额度档位 → 配额。

    ⚠️ **确定性轮次在最前。** 闲置轮压根不该走后面任何一道 —— 让它先过
    playbook 会出现「闲置的 FreeStorageSpace finding 命中了存储增长
    playbook」这种事，于是报告上闲置条目挂着一段讲 binlog 清理的话，
    而客户看这条是想知道"能不能删库"。

    ⚠️ `run_type` 留空（默认）时这道闸门不生效 —— 现有调用方不传就是
    原行为。这是刻意的：让漏传表现为「照旧派发」而不是「静默不派发」，
    因为后者会让整轮判读凭空消失且没有任何信号。

    ⚠️ **playbook 必须在额度之前。** 反过来会让额度紧张时连
    「本来免费就能给确定性结论」的那些 finding 也变成空的 ——
    而那是纯粹的损失：不花钱的路径被一个省钱的判据挡掉了。

    ⚠️ 复用也在额度之前，同理。

    ⚠️ **kill switch 也在 playbook / 复用之后**，理由同上：那两条路径压根
    不调 DA，`da_enabled=false` 把它们一起挡掉是白挡 —— 拉开关的人想停的是
    「别再花额度调 DA」，不是「别再给客户结论」。

    ⚠️ 但 kill switch 要在**额度与配额之前**：两者都会被拉停，而报告上
    只能写一个原因。写「为控制额度消耗」会把一次人工止损说成设计好的降速，
    于是没人知道判读是被关掉的。
    """
    # ⚠️ 先 list 化再判闸门：`reasons` 可能是生成器，而 ⓪ 这道闸门要读它
    #    来选结论档位。传生成器进来又在闸门里消耗掉，后面的 playbook
    #    就会拿到一个空序列 —— 那种 bug 只在调用方恰好传生成器时出现。
    reasons = list(reasons)

    # ⓪ 确定性轮次 —— 空 `run_type` 不在集合里，所以不传就是原行为。
    if run_type in DETERMINISTIC_RUN_TYPES:
        return Decision(
            dispatch=False,
            reason=SkipReason.DETERMINISTIC,
            conclusion=deterministic_conclusion(reasons),
        )

    hit = match_playbook(metric=metric, service=service, reasons=reasons,
                         severity=severity, context=context, playbook=playbook)
    if hit is not None:
        return hit

    reused = try_reuse(prior, reasons=reasons, severity=severity, today=today,
                       reuse_days=reuse_days)
    if reused is not None:
        return reused

    if not da_enabled:
        return Decision(dispatch=False, reason=SkipReason.KILL_SWITCH)

    if not tier.allows(severity):
        return Decision(dispatch=False, reason=SkipReason.BUDGET)

    if quota_left is not None and quota_left <= 0:
        return Decision(dispatch=False, reason=SkipReason.QUOTA)

    return Decision(dispatch=True)
