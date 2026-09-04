"""`notiops-inspection` 表的键前缀与键构造（R14.1b）。

## 为什么单独一个模块

前缀散落在各个 repository 里写字符串字面量，迟早出现两个前缀互为前缀的组合。
早期设计就踩过：

```
insp#<account>#<service>#<instance>     序列库
insp#scope#high                         排除清单
insp#target#idle                        巡检范围
```

三者都落在 `begins_with("insp#")` 这一个范围里。任何按前缀扫序列的查询都会顺带
扫出排除清单行 —— 而 `<account>` 是数字、`scope` / `target` 是字母，
靠肉眼看不出冲突，只有在 scan 结果里混进几行奇怪的东西时才会发现，
而那通常发生在生产上。

`assert_prefixes_disjoint()` 把这个约束变成一条会失败的测试：
加新前缀时如果与既有前缀互为前缀，测试立刻挂。

⚠️ 现在这七个前缀之所以安全，是因为**公共词根 `insp` 后面不接分隔符**
（`inspseries#` 而不是 `insp#series#`）。所以未来最现实的踩雷方式是
「给既有前缀再加一层」，例如想把派发状态分出去写成 `inspfind#dispatch#`
—— 那一刻 `begins_with("inspfind#")` 就会把它一起扫出来。
真要分子空间，SHALL 另起一个平级前缀（`inspdispatch#`）而不是嵌套。
"""

from __future__ import annotations

from datetime import date
from enum import Enum

SEP = "#"


class Prefix(str, Enum):
    """全部 PK 前缀。**加新前缀 SHALL 加在这里**，不在 repository 里写字面量。"""

    SERIES = "inspseries#"
    """序列库（缓存 + 审计，非序列的唯一来源）。"""

    RUN = "insprun#"
    """run 记录。"""

    FINDING = "inspfind#"
    """finding 状态机的行。"""

    SCOPE = "inspscope#"
    """排除清单。两份：`inspscope#high` / `inspscope#idle`。"""

    TARGET = "insptarget#"
    """巡检范围（存 ID，不存展开结果）。"""

    CHAT = "inspchat#"
    """推送目标。"""

    BACKFILL = "inspbf#"
    """补齐重投的次数账本（R13.15）。SK = `account_id`。

    🔴 **必须独立于 run 分区。** 第一版把它写在 run 行上
    （`insprun#<type>#<date>` / SK=account_id）用 `update_item` —— 而
    `missing_row` 的场景**就是那行不存在**，于是 DynamoDB 建出一条只有
    `backfill_attempts` 与 `last_backfill_run_id`、**没有 `status`** 的桩行。
    后果三连，全部静默：

    ```
    try_acquire_run_lock  三段条件在缺失属性上一律判假 → 那个账号当天
                          再也抢不到锁（而 due_runs 照样每 tick 重派）
    audit_coverage        只判 `row is None`，桩行让缺行缺口下一小时消失，
                          `checked` 反而 +1 → CoverageMissingRows 从 1 掉回 0
    MAX_BACKFILL_ATTEMPTS 缺口不再被检测 → attempt 永远停在 1，到不了 2
    ```

    净效果是那个账号整天没有巡检，而三条信号全绿。独立前缀让计数怎么写
    都不会碰到 run 分区的任何读者。
    """

    PUSH = "insppush#"
    """每条 finding 的**推送状态**（上次推了没、推了几次、下次什么时候，R11b.5）。

    🔴 **必须是独立前缀，不能放在 finding 行上。** `apply_transitions()` 用的是
    `put_item` **整行覆盖**（store.py，R6.8 的条件写就挂在那上面）——
    推送字段写在 finding 行里，第二天的巡检轮会把它们**整片抹掉**。
    表现是 CRITICAL 的退避重推永远停在第 1 档（`push_count` 天天归零），
    也就是「1/2/4/7 天退避」退化成「每天推」，而那正是 R11b.5 要防的：
    一条挂 3 周的 finding 推 21 次，第 3 次之后客户即免疫。

    ⚠️ 也不能写成 `inspfind#<acct>#push` —— 那会让
    `begins_with("inspfind#")` 把推送行一起扫出来，于是 `load_findings()`
    返回的 dict 里混进几条没有 `state` 的记录（本模块 docstring 里预言的
    那个雷）。SK = finding_id，与 finding 行同 SK，便于对照。"""

    SKILL_NOTE = "inspnote#"
    """客户对判读 skill 的补充说明（R5.3b）。两份：
    `inspnote#inspection-high-load` / `inspnote#inspection-cost-idle`。

    ⚠️ 只存**客户写的那一段**。SKILL.md 本体（输入契约 + 五条硬边界 + 输出信封）
    在仓库里由 CI 逐字校验，SHALL NOT 落库 —— 落库就意味着可以被绕过 CI 修改，
    而边界失守没有任何运行时信号。"""

    CONFIG_VERSION = "cfgver#"
    """配置版本，append-only 不可变。"""
    SCHEDULE = "inspsched#"
    """定时配置。**单个 PK 两行**（SK = `high` / `idle`）——
    R11.1 明写「按类型全局配置，不按账号」。
    做成 `inspsched#<account>` 会让 UI 上出现「给每个账号单独设时间」的入口，
    而那与「一天一轮、一份报告」的产品形态冲突。"""
    DISPATCH = "inspdispatch#"
    """`task_id` → 这个 task 里装了哪些 finding（R5.5a / 7.4b）。

    ⚠️ **平级前缀而不是 `inspfind#dispatch#`** —— 本模块 docstring 里预言的
    那个雷就是后者：嵌套会让 `begins_with("inspfind#")` 把派发行一起扫出来，
    于是 `load_findings()` 返回的 dict 里混进几条根本不是 finding 的记录。

    ⚠️ 这张表是**回拼的唯一锚点**。DA 的判读结果通过 callback 回来时，
    事件里只有 `task_id`；而一个 task 因为装箱（R5.4）可能含最多 6 条 finding。
    没有这张映射，判读文本就只能整段挂在 task 上，无法回到各自的 finding 行 ——
    表现是报告里有一大段分析，但每条 finding 旁边都是空的。"""

    DATA_BATCH = "inspbatch#"
    """「某账号某天有可复用序列数据」的索引。

    ⚠️ 这张索引不是冗余：序列行的 PK 是
    `inspseries#<acct>#<region>#<service>#<instance>`，date 在 SK 里 ——
    想问「这个账号有哪些天的数据」得跨全部实例 PK 扫，那是 Scan。
    `reuse` 每次手动触发都要问一次，Scan 不可接受。"""


def all_prefixes() -> tuple[str, ...]:
    return tuple(p.value for p in Prefix)


def assert_prefixes_disjoint() -> None:
    """R14.1b 的元断言：任何两个前缀都不得互为前缀。

    ⚠️ 不是「不相等」而是「不互为前缀」—— `insp#` 与 `insp#scope#` 并不相等，
    但 `begins_with("insp#")` 会同时命中两者，这才是那个 bug 的形状。
    """
    prefixes = all_prefixes()
    for a in prefixes:
        for b in prefixes:
            if a is b or a == b:
                continue
            if a.startswith(b) or b.startswith(a):
                raise AssertionError(
                    f"键前缀 {a!r} 与 {b!r} 互为前缀 —— "
                    f"begins_with 查询会互相串行。见 R14.1b"
                )


# ---------------------------------------------------------------------------
# 键构造
# ---------------------------------------------------------------------------
#
# ⚠️ 全部含 region。资源 ID 只在区域内唯一 —— 不含 region 的键会让
# 东京的 `prod-cache` 与弗吉尼亚的 `prod-cache` 共用一行。


def series_pk(account_id: str, region: str, service: str, instance_id: str) -> str:
    return Prefix.SERIES.value + SEP.join((account_id, region, service, instance_id))


def series_sk(metric: str, stat: str, data_date: date) -> str:
    """⚠️ `data_date` 是**数据窗口日期**，不是执行日期（R13.10）。

    用执行日期会让同一天的重跑写出两行，且回填的历史数据落在回填当天。
    """
    return SEP.join((metric, stat, data_date.isoformat()))


def run_pk(run_type: str, run_date: date) -> str:
    return Prefix.RUN.value + SEP.join((run_type, run_date.isoformat()))


def finding_pk(account_id: str) -> str:
    return Prefix.FINDING.value + account_id


# ── 跨账号统一视图（GSI1）────────────────────────────────────────────────
#
# 🔴 巡检看板的语义是**统一视图**：「今天我要处置什么」，跨账号一起排。
#    而主键是 `inspfind#<账号>` —— 每个账号一个分区，读侧必须先选账号。
#    于是账号选择器从「筛选」变成了「决定加载哪个分区」，客户看到的是
#    「一次只能看一个账号」。
#
# GSI1 让一次 Query 拿到全部账号的 finding：
#
# ```
# GSI1PK = "inspfind"                                  所有 finding 一个分区
# GSI1SK = "<严重度序>#<账号>#<finding_id>"              严重度**在最前**
# ```
#
# ⚠️ 严重度放最前是为了**截断时先保住最严重的**。读侧有 5000 条上限
#    （`queryAll`），按 SK 升序取 = CRITICAL 先进来。若把账号放前面，
#    截断会变成「按账号字典序切一刀」—— 账号 ID 小的那几个把配额吃光，
#    而那与严重程度毫无关系。
#
# ⚠️ 这是**稀疏 GSI**：只有 finding 行带 GSI1PK，`insprun#` / `inspseries#` /
#    `cfgver#` 那些不带，所以索引里只有 finding，不会被别的记录类型污染。
#    （表里有 12 种前缀，见本文件其余 `*_pk`。）
#
# ⚠️ **存量行没有 GSI1PK，不会出现在索引里。** 升级后要跑
#    `scripts/backfill_finding_gsi.py` 回填，否则统一视图看不到旧 finding
#    —— 而那个缺失是静默的（查询成功、只是少了行）。
FINDING_GSI1PK = "inspfind"
"""GSI1 里 finding 的分区键。**常量** —— 所有账号共用一个分区。

分区大小：一条 finding 约 1KB，10 个账号各 500 条 = 5MB，远低于 DDB 的
10GB 分区上限。真到那个量级要改成按严重度分区（`inspfind#CRITICAL` 等）。
"""

_SEV_RANK = {"CRITICAL": "0", "HIGH": "1", "MEDIUM": "2", "INFO": "3"}
"""严重度 → 一位排序码。**升序 = 最严重在前**。

⚠️ 用数字而不是直接拿 severity 字符串：字典序下
`CRITICAL < HIGH < INFO < MEDIUM`，INFO 会排到 MEDIUM 前面。
"""


def finding_gsi1sk(severity: str, account_id: str, finding_id: str) -> str:
    """GSI1 的排序键：`<严重度序>#<账号>#<finding_id>`。

    ⚠️ `severity` 认不出来时排到最后（`9`）而不是抛 —— 写侧抛异常会让一条
    finding 落不了库，而「排序位置不对」比「这条风险不存在」轻得多。
    """
    rank = _SEV_RANK.get(str(severity or "").upper(), "9")
    return SEP.join((rank, account_id, finding_id))


def scope_pk(kind: str) -> str:
    """`kind` ∈ {high, idle} —— 两份独立的排除清单（R1.2）。"""
    if kind not in ("high", "idle"):
        raise ValueError(f"排除清单只有 high / idle 两份，收到 {kind!r}")
    return Prefix.SCOPE.value + kind


def target_pk(kind: str) -> str:
    if kind not in ("high", "idle"):
        raise ValueError(f"巡检范围只有 high / idle 两份，收到 {kind!r}")
    return Prefix.TARGET.value + kind


MISSING = "-"
"""缺失段的占位符。**保持段数固定**，否则 DDB 侧按位置解析会错位。"""


def resource_sk(
    account_id: str, region: str, service: str, resource_id: str
) -> str:
    """排除清单与巡检范围共用的 SK 形状。

    与 `scope.ExclusionEntry.key` 必须一致 —— 有测试锁住这一点。
    `region` 为空用 `-` 占位（跨区域生效的老数据）。
    """
    return SEP.join((
        account_id, region or MISSING, service, resource_id
    ))


def chat_pk() -> str:
    return Prefix.CHAT.value + "target"


def chat_sk(platform: str, chat_id: str) -> str:
    """投递目标的 SK：`<platform>#<chat_id>`（R11b.2）。

    ⚠️ `platform` 在**前**。反过来（`<chat_id>#<platform>`）会让
    「列出某平台的全部投递目标」变成整段扫 + 过滤，而广播层每次都要问
    「dingtalk 有几个目标」（≥2 个就得整平台拒掉，见
    `domain/targets.py` 的 `RejectReason.AMBIGUOUS_ROUTING`）。

    ⚠️ `platform` 里 SHALL NOT 含 `#`。三个平台名都是纯字母，
    但拼错成 `feishu#prod` 会让读侧 `split(SEP, 1)` 把
    `prod#oc_xxx` 当成 chat_id —— 那一行永远投不出去且不报错。
    `chat_id` 允许含 `#`（读侧只切第一个分隔符）。
    """
    p = (platform or "").strip()
    cid = (chat_id or "").strip()
    if not p or not cid:
        raise ValueError(
            f"投递目标的 platform 与 chat_id 都不能为空，收到 {platform!r} / {chat_id!r}"
        )
    if SEP in p:
        raise ValueError(f"platform 不能含 {SEP!r}，收到 {platform!r}")
    return SEP.join((p, cid))


def split_chat_sk(sk: str) -> tuple[str, str]:
    """`<platform>#<chat_id>` → `(platform, chat_id)`。切**第一个**分隔符。

    ⚠️ 只在行里没有 `platform` / `chat_id` 字段时兜底用（手写的行）。
    正常读侧用行上的字段 —— 以 SK 为准会让「改了字段却没改 SK」的行
    投到旧的 chat 去。
    """
    head, _, tail = (sk or "").partition(SEP)
    return head.strip(), tail.strip()


def backfill_pk(run_type: str, run_date: date) -> str:
    """补齐次数账本的 PK。SK = `account_id`。

    ⚠️ 与 `run_pk` 同维度（类型 × 日期）但**不同前缀** —— 见
    `Prefix.BACKFILL` 的说明：写在 run 分区里会建出占死锁的桩行。
    """
    return Prefix.BACKFILL.value + SEP.join((run_type, run_date.isoformat()))


def push_pk(account_id: str) -> str:
    """推送状态的 PK。SK = `finding_id`（与 finding 行同 SK）。

    ⚠️ 按账号分区而不是一个全局 PK：推送 cron 是逐账号逐目标算的，
    全局 PK 会让每个账号都把**所有**账号的推送状态读回来。
    """
    acct = (account_id or "").strip()
    if not acct:
        raise ValueError(
            "account_id 不能为空 —— 空键会让所有账号的推送状态挤进同一行分区"
        )
    return Prefix.PUSH.value + acct


def config_version_pk(service: str, rule_type: str) -> str:
    return Prefix.CONFIG_VERSION.value + SEP.join((service, rule_type))


# 两份判读 skill 的 asset name（= SKILL.md frontmatter 的 name）。
# ⚠️ 与 `inspection/skills/*/SKILL.md` 里的 name 必须一致 ——
# `scripts/sync_inspection_skills.py` 断言了那一侧，这里的元断言锁住这一侧。
SKILL_NAMES: tuple[str, ...] = ("inspection-high-load", "inspection-cost-idle")


def skill_note_pk(skill_name: str) -> str:
    """客户补充说明的 PK。`skill_name` 必须是两份判读 skill 之一。

    ⚠️ 不放行任意名字：拼错一个字母就会写进一行永远读不到的记录，
    而客户在 UI 上看到「已保存」。
    """
    if skill_name not in SKILL_NAMES:
        raise ValueError(
            f"未知 skill name {skill_name!r}；合法值 {list(SKILL_NAMES)}"
        )
    return Prefix.SKILL_NOTE.value + skill_name


SCHEDULE_PK = Prefix.SCHEDULE.value + "config"
"""定时配置的唯一 PK。SK 是 `RunType` 的值（`high` / `idle`）。

⚠️ 常量而非函数：它不带任何维度。写成 `schedule_pk(account_id)` 会让
「按账号设定时」这个与产品形态冲突的用法看起来是被支持的。
"""


def dispatch_pk(task_id: str) -> str:
    """派发映射的 PK。SK 固定 `meta`（一个 task 一行）。

    ⚠️ 键是 **`task_id`**（AWS 给的）而不是我们的 `client_token` 或 `run_id`：
    callback 事件里能拿到的只有 `task_id`。用别的做键等于回拼时无从查起。

    ⚠️ 不含 account_id：`task_id` 是 AWS 全局唯一的 UUID，
    加上 account 只会让 callback 侧多一个它未必知道的维度
    （callback 拿到的 `account` 是**事件源账号**，跨 payer 时与巡检目标账号不同）。
    """
    tid = (task_id or "").strip()
    if not tid:
        raise ValueError(
            "task_id 不能为空 —— 空键会让所有派发记录挤进同一行互相覆盖，"
            "而回拼时只能找到最后那一条"
        )
    return Prefix.DISPATCH.value + tid


DISPATCH_SK = "meta"
"""派发映射的固定 SK。一个 task 一行，不需要第二维。"""


def data_batch_pk(account_id: str) -> str:
    """「某账号有哪些天的可复用数据」的索引 PK。SK 是 `data_date` 的 ISO 串。"""
    return Prefix.DATA_BATCH.value + account_id
