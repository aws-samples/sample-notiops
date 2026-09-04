"""skill 加载门禁与判读质量降级（R9.6）。

## 为什么必须有这道门禁

DA 对 investigation 加载 skill 的方式是**对 description 做模型匹配**，
不是显式挂载。所以「没加载上」是个常态可能，而且：

```
skill 没加载  → 报告照样出，只是内容退化成 DA 的通用发挥
              → **从外面完全看不出来**
```

实测手段：journal 的 `utilization` 记录里有

```json
"skills": {"metadata": {"utilization": 1.3}, "bundles": []}
```

`bundles` 为空 = 那次调查没有加载任何 skill 正文。

## 三种要打 degraded 的情形，各自的含义不同

```
skill_not_loaded    判读方法论完全没生效 —— 结论不可信，等于通用 LLM 发挥
wrong_skill         加载了另一份（high 轮加载了 cost-idle）—— 措辞路由写偏了
compaction          context window 被压缩过，这批判读有精度损失（§11.3）
parse_failed        DA 的输出解析不出来（R9.6）—— 存原文，不丢
```

⚠️ 合成一个 `degraded` 布尔会让「方法论没生效」与「有点精度损失」
在报告上长一个样，而前者该重跑、后者可以照用。
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

SKILL_HIGH_LOAD = "inspection-high-load"
SKILL_COST_IDLE = "inspection-cost-idle"

EXPECTED_SKILL: Mapping[str, str] = {
    "high": SKILL_HIGH_LOAD,
    "idle": SKILL_COST_IDLE,
}
"""每类巡检该加载哪份 skill。键是 `RunType` 的值。"""


class Degradation(str, Enum):
    """判读质量的降级原因。**每种都要能在报告上说清楚。**"""

    SKILL_NOT_LOADED = "skill_not_loaded"
    """一份 skill 都没加载 → 结论等于通用 LLM 发挥，**不可信**。"""
    WRONG_SKILL = "wrong_skill"
    """加载了另一份判读 skill → task description 的措辞路由写偏了（7.6）。"""
    COMPACTION = "compaction"
    """context window 被压缩过 → 这批判读有精度损失。"""
    PARSE_FAILED = "parse_failed"
    """DA 输出解析失败（R9.6）→ 存原文，不丢。"""
    NO_JOURNAL = "no_journal"
    """读不到 journal → **无法证明** skill 加载过。

    ⚠️ 这一档不能当成「没问题」。读不到的原因可能是调查还在跑（正常）、
    也可能是权限不足（我们的问题）。当成没问题就等于把门禁关掉了 ——
    而门禁的全部意义在于「不可证明就不该当成可信」。
    """
    NO_DATA_ACCESS = "no_data_access"
    """🔴 DA 拿不到这个账号的数据 —— agent space 少了账号关联。

    ★ **2026-08-20 实测出来的**，原先完全没想到这一档。
    在一个刚建好、**没有账号关联**的 agent space 上派 task：

    ```
    task status          COMPLETED        ← 看起来一切正常
    我们的 skill         已加载 ✅
    finding 记录         **0 条**
    investigation_gap    1 条，id=gap-account-access
                         「AWS 账户 … 未在此 Agent Space 的已启用关联中配置。
                           无法访问必需的 AWS API：RDS DescribeDBInstances、
                           DescribeEvents，CloudWatch GetMetricData，
                           CloudTrail LookupEvents」
    investigation_summary_md 照样产出一份格式完好的报告
    ```

    ⚠️ **`status=COMPLETED` 没有任何信号价值。** 缺关联时调查正常完成、
    报告正常产出、只是里面一条真实分析都没有。客户会读到一份
    「症状：CPU 持续高位」然后「Findings: 无」的报告，
    看不出这是因为我们的基础设施配错了。

    ⇒ CDK 里的 `InspectionAgentSpaceAssociation` 不是可选项。
      这一档就是它漏配时唯一的运行时信号。
    """
    EXTRA_SKILL = "extra_skill"
    """我们的 skill 加载了，但**同时**还命中了别的判读类 skill。

    ★ **2026-08-20 实测发现这是真实风险，不是假想。**
    同一条巡检载荷在两个 space 里命中了不同的东西：

    ```
    排障 space（有 6 个客户 skill）  bundles=('rds-health-review',)
                                    ← 命中了一个语义相近的**真实** skill
    排障 space（另一条措辞）         bundles=('understanding-agent-space',)
    探针 space（只有我们的两份）      bundles=('inspection-high-load',)  ✅
    ```

    ⇒ 措辞路由确实在起作用（不是碰巧命中），但**同一个 space 里语义相近的
      其他 skill 会一起被激活**。客户装了自己的 RDS 巡检类 skill 时，
      判读会被两套方法论同时影响 —— 输出格式可能仍然合规，
      而结论的依据已经混了。

    ⚠️ 这一档**不判为不可信**：我们的方法论确实生效了，只是有干扰。
    判为不可信会让「客户装了任何相关 skill」变成整轮报废，那是过度反应。
    但要记下来，让「同一条 finding 昨天今天结论不同」有个可查的解释。

    ⚠️ 这也是 R12.5c 要拆独立 agent space 的一条**新增**理由 ——
    原先列的四条理由里没有这条（并发、skill 误加载、SKIPPED 外溢、分流判据），
    而它是实测出来的。
    """
    ANALYSIS_GAP = "analysis_gap"
    """DA 报告了 `investigation_gap` 但仍产出了 finding。

    ⚠️ 与 `NO_DATA_ACCESS` 分开：实测**有**账号关联的那次也报了 1 条 gap，
    同时产出 3 条 finding —— 那是「部分证据拿不到」而非「什么都拿不到」。
    合成一档会让前者被当成致命错误，于是正常的部分成功报告被整批丢掉。
    """


BENIGN_BUILTIN_SKILLS = frozenset({
    "understanding-agent-space",
})
"""DA 自带、与判读方法论无关的 skill —— 它们一起被加载不算干扰。

⚠️ 实测 `understanding-agent-space` 在**每一次**调查里都出现
（三次调查都有它）。不把它排除会让 `EXTRA_SKILL` 恒触发，
于是每份报告都带一条无意义的降级说明。

⚠️ 这个名单要保守：只放确认无害的。把客户自己的 RDS 巡检类 skill
（实测命中过 `rds-health-review`）放进来才是真的把信号丢掉。
"""

GAP_ACCOUNT_ACCESS_HINTS = ("account-access", "account_access")
"""`investigation_gap.id` 里表示「账号没关联」的片段。

⚠️ 匹配 **`id`** 而不是 `title` / `description`：后两者是**本地化文本**
（实测返回的是中文，因为 `locale` 传了 zh），跟着客户的语言变。
拿它们做判据会让英文客户的同一个问题检测不到。
`id` 实测是 DA 自己生成的英文 slug（`gap-account-access`）。
"""


@dataclass(frozen=True)
class JournalVerdict:
    """一次调查的 journal 判读结果。"""

    bundles: tuple[str, ...] = ()
    compaction_count: int = 0
    degradations: tuple[Degradation, ...] = ()
    finding_count: int = 0
    gap_ids: tuple[str, ...] = ()
    """DA 报的 `investigation_gap` 的 id 列表。报告要能说清缺了什么证据。"""

    @property
    def degraded(self) -> bool:
        return bool(self.degradations)

    @property
    def trustworthy(self) -> bool:
        """结论能不能当成「按我们的方法论判出来的」。

        ⚠️ `COMPACTION` 与 `ANALYSIS_GAP` **不影响可信性** ——
        前者是精度损失、后者是部分证据缺失，都不是方法论失效。
        把它们算进来会让长载荷 / 部分成功的正常判读被整批丢掉，
        而那恰恰是信息最多的那些。
        """
        blocking = {Degradation.SKILL_NOT_LOADED, Degradation.WRONG_SKILL,
                    Degradation.NO_JOURNAL, Degradation.NO_DATA_ACCESS}
        return not (set(self.degradations) & blocking)


def utilization_payload(record: Mapping[str, Any]) -> Mapping[str, Any]:
    """把一条 journal 记录解成 utilization 的 `data` 段。

    ★ **真实形状**（2026-08-20 从真账号 `ListJournalRecords` 抓的原文）：

    ```
    record = {
      "recordId": "...", "recordType": "utilization", "createdAt": ...,
      "content": '{"metadata":{"version":"0.1"},'
                 '"data":{"context_window":{"utilization":20.9,'
                 '"compaction_count":0},'
                 '"agents_md":{"utilization":0.0},'
                 '"skills":{"metadata":{"utilization":1.5},'
                 '"bundles":[{"name":"understanding-agent-space",'
                 '"utilization":2.0}]},'
                 '"subagents":[...],"tools":[]}}'
    }
    ```

    三个我一开始都搞错的地方：

    ```
    ① content 是**JSON 字符串**，不是 dict —— 必须 json.loads
    ② 有 metadata / data 两层信封，真正的内容在 data 里
       （tasks 里早前记的形状缺了这一层）
    ③ ListJournalRecords 的响应字段是 `records`，不是 journalRecords / items
    ```

    ⚠️ 这三处任一搞错，门禁都会**恒判「没加载」** —— 于是每份报告都带
    degraded 警告。警告一多就没人看了，真出问题时也救不回来。
    """
    ct = record.get("content")
    if isinstance(ct, str):
        try:
            ct = json.loads(ct)
        except (ValueError, TypeError):
            return {}
    if not isinstance(ct, Mapping):
        # 兜底：早期形状把 utilization 直接挂在记录顶层
        u = record.get("utilization")
        return u if isinstance(u, Mapping) else {}
    data = ct.get("data")
    if isinstance(data, Mapping):
        return data
    # 没有 data 信封时把 content 本身当 data（形状演进的兜底）
    return ct


def extract_bundles(records: Iterable[Mapping[str, Any]]) -> tuple[str, ...]:
    """取出全部已加载 skill 的名字（`data.skills.bundles[].name`）。

    ⚠️ `bundles` 的元素实测是**对象** `{"name": ..., "utilization": ...}`，
    但也兼容纯字符串 —— 只处理一种会让门禁在另一种形状下恒判「没加载」。
    """
    out: list[str] = []
    for rec in records:
        data = utilization_payload(rec)
        skills = data.get("skills") or {}
        if not isinstance(skills, Mapping):
            continue
        for b in skills.get("bundles") or ():
            if isinstance(b, str):
                out.append(b)
            elif isinstance(b, Mapping):
                name = b.get("name") or b.get("skill_id") or b.get("id")
                if name:
                    out.append(str(name))
    # 去重但保序
    seen: set[str] = set()
    return tuple(x for x in out if not (x in seen or seen.add(x)))


def extract_compaction_count(records: Iterable[Mapping[str, Any]]) -> int:
    """`utilization.context_window.compaction_count` 的最大值。

    ⚠️ 取**最大**而不是求和：同一次调查的多条 journal 记录会各自带一份
    当时的累计值，求和会把它算成好几倍。
    """
    best = 0
    for rec in records:
        data = utilization_payload(rec)
        cw = data.get("context_window") or {}
        if not isinstance(cw, Mapping):
            continue
        raw = cw.get("compaction_count")
        try:
            best = max(best, int(raw))
        except (TypeError, ValueError):
            continue
    return best


def _record_content(record: Mapping[str, Any]) -> Mapping[str, Any]:
    """把任意 journal 记录的 `content` 解成 dict。"""
    ct = record.get("content")
    if isinstance(ct, str):
        try:
            ct = json.loads(ct)
        except (ValueError, TypeError):
            return {}
    return ct if isinstance(ct, Mapping) else {}


def extract_gap_ids(records: Iterable[Mapping[str, Any]]) -> tuple[str, ...]:
    """`investigation_gap` 记录的 id 列表。"""
    out: list[str] = []
    for rec in records:
        if str(rec.get("recordType") or "") != "investigation_gap":
            continue
        gid = _record_content(rec).get("id")
        if gid:
            out.append(str(gid))
    seen: set[str] = set()
    return tuple(x for x in out if not (x in seen or seen.add(x)))


def count_findings(records: Iterable[Mapping[str, Any]]) -> int:
    """DA 自己产出的 `finding` 记录条数。

    ⚠️ 这不是我们的 finding —— 我们的在载荷里。这是 DA 判读的产物。
    实测：有账号关联那次 3 条，没关联那次 **0 条**，而两次 status 都是 COMPLETED。
    """
    return sum(1 for r in records
               if str(r.get("recordType") or "") == "finding")


def looks_like_no_data_access(gap_ids: Sequence[str]) -> bool:
    """gap 里有没有「账号没关联」这一条。"""
    return any(h in gid.lower() for gid in gap_ids
               for h in GAP_ACCOUNT_ACCESS_HINTS)


def evaluate_journal(
    records: Sequence[Mapping[str, Any]] | None,
    *,
    run_type: str,
    parse_failed: bool = False,
) -> JournalVerdict:
    """判定这次调查的判读质量（7.9a 的门禁本体）。

    ⚠️ `records` 为空与 `records is None` 是**两回事**：
    前者是「有 journal 但没有 utilization 记录」，后者是「读不到 journal」。
    都判 `NO_JOURNAL` 是保守的正确选择 —— 门禁的意义在于
    「不可证明就不该当成可信」。
    """
    degradations: list[Degradation] = []
    if not records:
        degradations.append(Degradation.NO_JOURNAL)
        if parse_failed:
            degradations.append(Degradation.PARSE_FAILED)
        return JournalVerdict(degradations=tuple(degradations))

    bundles = extract_bundles(records)
    compaction = extract_compaction_count(records)

    want = EXPECTED_SKILL.get(run_type)
    ours = set(EXPECTED_SKILL.values()) & set(bundles)
    if want and want in bundles:
        # 正是该用的那份。但要看有没有**别的**判读类 skill 一起被激活 ——
        # 实测同一条载荷在排障 space 里命中了 `rds-health-review`，
        # 说明语义相近的客户 skill 会一起上来。
        others = [b for b in bundles
                  if b not in EXPECTED_SKILL.values()
                  and b not in BENIGN_BUILTIN_SKILLS]
        if others:
            degradations.append(Degradation.EXTRA_SKILL)
    elif ours:
        # 加载了**另一份判读 skill** → task description 的措辞路由写偏了
        degradations.append(Degradation.WRONG_SKILL)
    else:
        # ⚠️ 判据是「我们的两份判读 skill 一份都不在」，**不是「bundles 为空」**。
        #    实测真实调查里 bundles 是
        #    `[{"name": "understanding-agent-space", ...}]` —— DA 的内建 skill。
        #    按「bundles 非空就算加载了」判会让每次调查都通过门禁，
        #    而我们的判读方法论其实压根没生效。
        degradations.append(Degradation.SKILL_NOT_LOADED)

    if compaction > 0:
        degradations.append(Degradation.COMPACTION)

    # ── 数据访问维度（与 skill 维度正交，两个都要查）
    gap_ids = extract_gap_ids(records)
    findings = count_findings(records)
    if looks_like_no_data_access(gap_ids):
        # 🔴 agent space 少了账号关联。实测这时 status=COMPLETED、报告格式完好、
        #    但 finding 一条都没有 —— 客户看不出是我们的基础设施配错了。
        degradations.append(Degradation.NO_DATA_ACCESS)
    elif gap_ids:
        # 部分证据缺失。实测有关联那次也报了 1 条 gap 却产出 3 条 finding。
        degradations.append(Degradation.ANALYSIS_GAP)

    if parse_failed:
        degradations.append(Degradation.PARSE_FAILED)

    return JournalVerdict(bundles=bundles, compaction_count=compaction,
                          degradations=tuple(degradations),
                          finding_count=findings, gap_ids=gap_ids)


# ---------------------------------------------------------------------------
# 7.12 额度耗尽检测（R12.3）
# ---------------------------------------------------------------------------

DETAIL_CREATED = "Investigation Created"
DETAIL_CANCELLED = "Investigation Cancelled"
DETAIL_COMPLETED = "Investigation Completed"


def looks_like_quota_exhaustion(detail_types: Sequence[str]) -> bool:
    """`Created` 紧接 `Cancelled` 且无 `Completed` → 判为额度耗尽（R12.3）。

    打到月度限额时 investigation 返回 200 随即被取消 —— 这是**静默失败**，
    从 `CreateBacklogTask` 的响应完全看不出来。

    ⚠️ 与 R13.13b 的 `SKIPPED` **不是同一回事，不可合并**：
    `SKIPPED` 是 DA 主动判定「这个 task 不需要调查」，是正常业务结果；
    额度耗尽是我们该降级并告警的运维事件。合并会让前者也触发告警。

    ⚠️ 判据里「无 `Completed`」这一半不能省：正常调查也会经过
    `Created`，而一次成功的调查最后有 `Completed`。只看
    「有 Cancelled」会把客户主动取消的调查也判成额度耗尽。
    """
    seq = [str(d) for d in detail_types]
    if DETAIL_COMPLETED in seq:
        return False
    if DETAIL_CREATED not in seq or DETAIL_CANCELLED not in seq:
        return False
    return seq.index(DETAIL_CANCELLED) > seq.index(DETAIL_CREATED)
