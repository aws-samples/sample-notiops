#!/usr/bin/env python3
"""巡检判读 skill 的共用段同步与校验。

两份 skill（high-load / cost-idle）的「输入契约 + 五条硬边界 + 输出信封 + Guardrails」
必须逐字相同 —— 它们是保证数据一致的约束，不是风格偏好：

    边界①「不重新分级」失守 → 同一条 finding 在看板与报告正文里两个严重度（R9.1 禁止）
    边界③「禁预测措辞」失守 → 客户在成本报告里读到「预计 12 天后撞线」，当成承诺
    边界⑤「不判读载荷外资源」失守 → 客户明确排除的实例照样出现在报告里

复制两份必然漂移，而漂移**没有任何运行时信号** —— 报告照样生成，只是内容不再受约束。
所以单一来源放 `inspection/skills/_shared/GUARDRAILS.md`，两份 SKILL.md 里以
BEGIN/END 标记包住一份拷贝，由本脚本保证一致。

用法：
    python3 scripts/sync_inspection_skills.py            检查（CI 用，不一致退出码 1）
    python3 scripts/sync_inspection_skills.py --write    把 _shared 写回两份 SKILL.md

⚠️ SHALL NOT 直接编辑 SKILL.md 里 BEGIN/END 之间的内容 —— 改 `_shared/GUARDRAILS.md`
   再跑 `--write`。直接改会被 CI 拦下（这正是它的目的）。
"""

from __future__ import annotations

import difflib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL_DIR = ROOT / "inspection" / "skills"
SHARED = SKILL_DIR / "_shared" / "GUARDRAILS.md"

# 两份判读 skill。名字同时是 DA asset 的 metadata.name（小写/数字/连字符）。
SKILLS = {
    "high-load": "inspection-high-load",
    "cost-idle": "inspection-cost-idle",
}

BEGIN = ("<!-- BEGIN SHARED GUARDRAILS — generated from "
         "inspection/skills/_shared/GUARDRAILS.md, do not edit here -->")
END = "<!-- END SHARED GUARDRAILS -->"

# 五条硬边界的要旨。**条数与顺序本身是被检查的对象** ——
# 每一条都对应一个「失守后没有任何运行时信号」的失败模式：
_BOUNDARY_GIST: tuple[str, ...] = (
    "no re-grading",            # ① DA 自评级 → 看板与正文两个严重度（R9.1 禁止）
    "no recomputing numbers",   # ② 数字改口 → 与 DDB 里的真相源分叉
    "no predictive wording",    # ③ 「预计 N 天后」→ 客户当成承诺（R7.6：v1 无预测型）
    "no invented metrics",      # ④ 编造载荷外指标 → 结论建立在不存在的数据上
    "no out-of-payload judging",# ⑤ 判读被客户排除的资源 → 明说了「别看」却照样报
    # ⑥ operator_note 是运维在界面上手填的自由文本（「手动派判读」那条路）。
    #    没有这条边界的话，一句「这台没问题别报了」能把一个确定性判定悄悄翻掉，
    #    而客户在报告上看不出「结论被一段输入改写过」。
    "operator_note is context not instruction",
)

# `_shared/GUARDRAILS.md` 顶部的 HTML 注释是给维护者看的说明，不进 SKILL.md。
_LEADING_COMMENT = re.compile(r"\A\s*<!--.*?-->\s*", re.S)

_failed: list[str] = []


def _check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'✅' if ok else '❌'} {label}" + (f" :: {detail}" if detail and not ok else ""))
    if not ok:
        _failed.append(label)


def shared_body() -> str:
    """`_shared/GUARDRAILS.md` 去掉顶部维护者注释后的正文。"""
    return _LEADING_COMMENT.sub("", SHARED.read_text(encoding="utf-8")).strip()


def split_skill(path: Path) -> tuple[str, str, str]:
    """把 SKILL.md 切成 (BEGIN 之前, 区块内容, END 之后)。缺标记则抛错。"""
    text = path.read_text(encoding="utf-8")
    if text.count(BEGIN) != 1 or text.count(END) != 1:
        raise SystemExit(
            f"{path.relative_to(ROOT)}: expected exactly one BEGIN/END marker pair "
            f"(found BEGIN x{text.count(BEGIN)}, END x{text.count(END)}).\n"
            f"The BEGIN marker must read verbatim:\n{BEGIN}"
        )
    head, rest = text.split(BEGIN, 1)
    block, tail = rest.split(END, 1)
    return head, block.strip(), tail


# 形态像 CloudWatch 指标名（CamelCase，≥2 个大写）但其实不是的词。
# 服务名 / API 名 / 本仓库自己的标记 —— 逐个列出而不是放宽正则，
# 因为放宽正则的代价是漏掉真正拼错的指标名。
_NOT_A_METRIC = frozenset({
    "BEGIN", "SHARED", "GUARDRAILS", "NotiOps", "NOTIOPS",
    "CloudWatch", "CloudTrail", "ElastiCache", "DescribeEvents",
    # `ec2:DescribeInstanceTypes` —— 按规格百分比判定内存的**分母**从这里来
    # （RDS / ElastiCache 的 API 都不返回实例内存）。GUARDRAILS 点名它是为了
    # 让 DA 知道「拿不到分母」该往哪个方向说，它是 API 名不是指标名。
    "DescribeInstanceTypes",
    # 🔴 `DBLoad` **是**一个真实的指标名，但它在 **Performance Insights**
    #    而不是 CloudWatch —— 所以它不在 `metrics_meta`（我们采不到），
    #    skill 里点名它正是为了让 DA **自己去 PI 取**。
    #    ⚠️ 不要因为这条检查报错就把它加进 metrics_meta：那会让采集侧
    #    去 `AWS/RDS` namespace 找一个不存在的指标，每台实例每天一条缺口。
    "DBLoad",
    # RDS 参数组公式里的变量（`{DBInstanceClassMemory*3/4}`）。GUARDRAILS 引用
    # 它来解释「为什么健康的 MySQL 可用内存只有 10%」。
    "DBInstanceClassMemory",
    # `/proc/meminfo` 的字段名 —— `FreeableMemory` 的官方定义就是它。
    # 引用它是为了说清「buffer pool 是私有匿名内存，不计入可用内存」。
    "MemAvailable",
    # IAM 错误码。GUARDRAILS 用它说明「跨账号时那些主动查证的调用会失败」——
    # `resource_reachable: false` 那一档要 DA 说清「我到不了那个账号」而不是
    # 退回「客户没开 PI」（那是对一台明明开了 PI 的库说假话）。
    "AccessDenied",
    # Performance Insights 的 API 名（`pi:GetResourceMetrics`）。与 DBLoad 成对：
    # 那个指标在 PI 而不是 CloudWatch，所以要点名 DA 该调哪个 API 去取。
    "GetResourceMetrics",
    # ── describe API 的**字段名** —— `attrs.resource_role` 的三个来源 ──────────
    #
    # 🔴 GUARDRAILS 必须点名它们，理由是一次真实的 P0（2026-09-01）：
    #    判读侧当时没有权威角色字段，于是拿「ReplicationLag 有数据」当身份信号，
    #    把一台单节点 Redis primary 判成 standby。修法是把角色做成 describe
    #    事实下发，而要让 DA 相信「这一行是事实、别再自己猜」，
    #    就得说清事实是从**哪个字段**读的。
    #
    # ⚠️ 它们是 describe 响应的字段名，不是 CloudWatch 指标 ——
    #    加进 `metrics_meta` 会让采集侧去 `AWS/RDS` 找六个不存在的指标。
    "ReadReplicaSourceDBInstanceIdentifier",
    "DBClusterMembers",
    "IsClusterWriter",
    "NodeGroups",
    "NodeGroupMembers",
    "CurrentRole",
    # V2 skill 让 DA 在 `resource_reachable=true` 且角色左右删/留结论时，
    # 用这三个 describe API 实名核验角色 —— 它们是 API 名，不是指标。
    "DescribeDBInstances",
    "DescribeDBClusters",
    "DescribeReplicationGroups",
    # MySQL 复制状态变量（`ReplicaLag == -1` 的语义解释引用它）。
    # 8.0.22+ 的官方名，不是指标。
    "Seconds_Behind_Source",
    "Average", "Maximum", "Minimum",          # 统计量，不是指标
    "SHALL", "NOT",                           # spec 措辞（SHALL / SHALL NOT）
    # 引擎与存储引擎名。判读线索里会点名它们（如「MySQL 复制不支持 MyISAM」），
    # 它们长得像指标名（驼峰 + 多个大写字母）但不是。
    "MySQL", "MariaDB", "MyISAM", "InnoDB", "PostgreSQL", "Valkey", "Memcached",
    "Aurora", "AuroraMySQL", "AuroraPostgreSQL",
    # Redis/Valkey commands and diagnostics the cues name by hand. They look like
    # metric names (CamelCase / all-caps) but are things the engineer runs, not
    # series we collect.
    "SLOWLOG", "UNLINK", "KEYS", "SMEMBERS", "SDIFF", "SUNION",
})


def _check_v2_structure(body: str) -> None:
    """V2 新增结构的存在性检查。每一条都对应一次**真实的判读事故**。

    ⚠️ 与六条边界同理：这些约束失守没有任何运行时信号 —— 报告照样生成，
    只是那一类事故会复发。所以结构本身要被钉住。
    """
    # ① 证据信任阶梯 —— P0 的根修：角色是 Describe 事实，不是指标推断。
    #    删掉这一节，「ReplicationLag 有数据 ⇒ 它是 replica」就会回来。
    _check("shared block has the 'Evidence trust order' section",
           "## Evidence trust order" in body,
           "the trust ladder is the fix for the 2026-09-01 P0 "
           "(a single-node Redis primary judged as standby); do not remove it")
    _check("trust order: role is a fact, not an inference",
           "Role is a fact, not an inference" in body)
    _check("trust order: memory is never decisive for destructive advice",
           "never decisive evidence for a" in body,
           "the rank-5 rule (Agent Space memory / internal docs) is missing — "
           "a real sample used an internal testbed doc as delete evidence")

    # ② 输出纪律 —— 客户拒读冗长输出的那一批样本。
    _check("shared block has the 'Output discipline' section",
           "### Output discipline" in body,
           "without it the per-finding caps and the no-checklist rule are gone")
    _check("output discipline forbids the ruled-out checklist",
           "checklist of hypotheses you ruled out" in body)

    # ③ insufficient_evidence 三条件门 —— 成员账号样本把「拿不到指标」
    #    直接判成证据不足，而 attrs 里的事实其实够判。
    _check("missing-data section carries the three-condition rule",
           "only when **all three** hold" in body,
           "without the gate, any unavailable metric becomes insufficient_evidence")

    # ③b 机器解析行必须被显式点明**并给出反例**。
    #
    # 🔴 2026-09-02 隔离验证实测：V2 首版把输出契约拆成「共享段的信封 + skill
    #    末尾的附加字段」，中间隔着大量散文，结果 DA 写出了叙述体 ——
    #    标题用 `*<id>*`（斜体）而不是 `## <id>`，`verdict:` 整行没有。
    #    两条都不匹配 `report_parse` 的正则 ⇒ parse_failed + da_verdict 空
    #    ⇒ **判读花了钱，一个字都进不了 finding 行**，而 task 状态是 COMPLETED。
    #
    # ⚠️ 只写「请按这个格式」不够（V1 就是那样写的，V2 照抄了同一份信封）。
    #    必须写明「这两行是机器读的、错了整条丢弃」并给出会失败的具体写法 ——
    #    模型需要知道后果与反例，不只是模板。
    _check("output envelope flags the machine-parsed lines",
           "parsed by a machine" in body,
           "the heading and verdict: lines must be marked as machine-parsed, "
           "with the consequence spelled out — a prose-only verdict is dropped silently")
    _check("output envelope shows what a rejected heading looks like",
           "bold/italic instead of" in body,
           "give the concrete failing forms; 2026-09-02 the model emitted "
           "*<finding_id>* in italics and the whole review was discarded")
    # 开场白禁令。实测两跑都出现：「根据技能文件，我将…」——
    # 既是禁用措辞（引用 skill 自身），又在解释自己选了哪个格式分支。
    # 解析不受影响（标题前的文字被忽略），但它是输出纪律的第一道破口：
    # 允许一句开场白，下一次就是三段。
    _check("output envelope forbids a preamble before the first heading",
           "The first character of your reply" in body,
           "without it the model narrates its formatting choices before the envelope")

    # ③c 两份 skill 各自要有一个**完整可抄的**输出模板 + 实例。
    #    拆成「信封在一处、附加字段在另一处」是上面那次事故的直接成因。
    for d in SKILLS:
        p = SKILL_DIR / d / "SKILL.md"
        if not p.is_file():
            continue
        t = p.read_text(encoding="utf-8")
        _check(f"{p.relative_to(ROOT)} carries one complete copyable output template",
               "## Output — copy this shape exactly" in t,
               "split output contracts produced narrative output that the parser "
               "could not read (2026-09-02)")
        _check(f"{p.relative_to(ROOT)} shows a worked example of the envelope",
               "Worked example" in t and "## 444455556666#" in t,
               "a template alone was not enough; the example is what pins the shape")

    # ④ 消毒白名单必须覆盖全部顶级节名 —— 漏一节客户就能在笔记里伪造它。
    upload_src = (ROOT / "inspection" / "adapters" / "skill_upload.py")
    if upload_src.is_file():
        src = upload_src.read_text(encoding="utf-8")
        m = re.search(r"_IMPERSONATION_RE\s*=\s*re\.compile\(\s*(.*?)\s*,\s*re\.I",
                      src, re.S)
        joined = m.group(1) if m else ""
        # ⚠️ 跳过 fenced code block —— 输出信封示例里的 `## <finding_id>`
        #    是给 DA 看的输出格式，不是文档分节。
        in_fence = False
        headings: list[str] = []
        for ln in body.splitlines():
            if ln.startswith("```"):
                in_fence = not in_fence
            elif not in_fence and ln.startswith("## "):
                headings.append(ln[3:].strip())
        missing = [h for h in headings if h not in joined]
        _check("every top-level section is covered by the note sanitizer",
               not missing,
               f"headings not in skill_upload._IMPERSONATION_RE: {missing} — "
               "a customer note could forge that section and override it")

    # ⑤ cost-idle 的第四档 disposition 与反例 —— verify_owner 是
    #    「技术证据够、业务授权缺」的唯一诚实出口。
    ci = SKILL_DIR / "cost-idle" / "SKILL.md"
    if ci.is_file():
        text = ci.read_text(encoding="utf-8")
        _check("cost-idle declares the verify_owner disposition",
               "verify_owner" in text,
               "without the fourth disposition the skill is forced to choose "
               "between delete (too aggressive), leave_alone (contradicts the "
               "evidence) and insufficient_evidence (a false statement)")
        _check("cost-idle keeps the mandatory counterexamples",
               "## Mandatory counterexamples" in text)
        _check("cost-idle forbids delete without an approval window",
               "`approval_or_window: no`" in text)
    hl = SKILL_DIR / "high-load" / "SKILL.md"
    if hl.is_file():
        text = hl.read_text(encoding="utf-8")
        _check("high-load keeps the mandatory counterexamples",
               "## Mandatory counterexamples" in text)
        _check("high-load keeps the memcached exclusion rule",
               "written for the wrong engine" in text,
               "a real memcached sample discussed EngineCPUUtilization and "
               "replication — neither exists on memcached")


def _check_cited_metrics_are_collected() -> None:
    """skill 正文里提到的每个 CloudWatch 指标名都必须在采集清单里。

    ⚠️ 这条防的是**静默失效的判读线索**：skill 写「看 ReplicaLag 判断是不是副本」，
    而 `metrics_meta.py` 没采 `ReplicaLag` → 载荷里永远没有它 → 那条线索永远不触发，
    DA 于是按剩下的证据把一个只读副本判成可删。没有任何报错，报告照样生成。

    只做包含性检查（skill ⊆ 采集清单），不反向要求采集清单里每个指标都被 skill 提到 ——
    多数指标是规则引擎自己用的，不需要出现在判读方法论里。
    """
    meta = ROOT / "inspection" / "domain" / "metrics_meta.py"
    if not meta.is_file():
        _check("metrics_meta.py exists", False, str(meta))
        return
    collected = set(re.findall(r'"([A-Z][A-Za-z0-9%]{3,})"', meta.read_text(encoding="utf-8")))

    for d in SKILLS:
        p = SKILL_DIR / d / "SKILL.md"
        if not p.is_file():
            continue
        text = p.read_text(encoding="utf-8")
        cited = {
            w for w in re.findall(r"\b([A-Z][A-Za-z0-9%]{4,})\b", text)
            if sum(c.isupper() for c in w) >= 2 and w not in _NOT_A_METRIC
        }
        missing = sorted(c for c in cited if c not in collected)
        _check(
            f"{p.relative_to(ROOT)} cites only metrics present in metrics_meta.py",
            not missing,
            "not collected, so the cue can never fire: " + ", ".join(missing)
            + " — either add them to metrics_meta.py or drop the cue"
            + " (if one of these is not a metric name, add it to _NOT_A_METRIC)",
        )


def _check_promised_attrs_are_produced() -> None:
    """输入契约表里 `attrs` 那行承诺的字段，必须真的由 `attrs_section()` 产出。

    防的是**文档说谎**：GUARDRAILS 曾把 `engine_eol` 列进 `attrs`，而
    `attrs_section()` 从不产出它（它是 refdata 查表结果，只作为独立的 structural
    finding 出现）。后果是静默的 —— skill 让 DA「不必自己去查 engine_eol」，
    DA 于是既不查也拿不到，那条线索永远不触发，而报告照样生成。
    """
    body = shared_body()
    row = next((ln for ln in body.splitlines() if ln.startswith("| `attrs`")), None)
    if row is None:
        _check("input contract has an `attrs` row", False,
               "row missing; this check cannot verify anything")
        return

    # 只扫「字段清单」那一段：`attrs` 行的第 2 个单元格，且在第一个句号之前。
    # 句号之后是散文（如「Engine end-of-life is **not** here …」），里面的反引号词
    # 不是承诺 —— 早期版本连散文一起扫，把 `structural` 当成了承诺字段。
    cell = row.split("|")[2] if row.count("|") >= 3 else ""
    promised = set(re.findall(r"`([a-z_][a-z0-9_]*)`", cell.split(".")[0]))
    promised.discard("attrs")

    src = (ROOT / "inspection" / "domain" / "payload.py").read_text(encoding="utf-8")
    m = re.search(r"def attrs_section\(.*?\n    return \{(.*?)\n    \}", src, re.S)
    if not m:
        _check("attrs_section() is parseable", False,
               "could not locate the returned dict in payload.py")
        return
    produced = set(re.findall(r'"([a-z_][a-z0-9_]*)":', m.group(1)))

    phantom = sorted(promised - produced)
    _check("every attrs field promised in the skill is produced by attrs_section()",
           not phantom,
           f"promised but never produced: {phantom} - either add them to "
           "attrs_section() or stop promising them in _shared/GUARDRAILS.md")


def do_write() -> int:
    body = shared_body()
    changed = 0
    for d in SKILLS:
        p = SKILL_DIR / d / "SKILL.md"
        head, block, tail = split_skill(p)
        if block == body:
            print(f"  = {p.relative_to(ROOT)} already in sync")
            continue
        p.write_text(f"{head}{BEGIN}\n{body}\n{END}{tail}", encoding="utf-8")
        print(f"  * {p.relative_to(ROOT)} updated")
        changed += 1
    print(f"\n{changed} file(s) updated.")
    return 0


def do_check() -> int:
    print("test_shared_guardrails_are_in_sync")
    _check("_shared/GUARDRAILS.md exists", SHARED.is_file(), str(SHARED))
    if not SHARED.is_file():
        return 1
    body = shared_body()
    _check("shared block has the 'What you do not do' section",
           "What you do not do" in body,
           "the section title changed; the five-boundary check below relies on it")
    # ⚠️ 逐条检查，不是只看编号 1。
    # 上一版的谓词是 `body.count("\n1. **Do not") == 1` —— 它只验证「以 1. 开头且只有一处」，
    # 对第 2~5 条一无所知。实测：删掉边界③（禁预测措辞）整段后 `--write`，
    # 这个检查照样绿，而脚本自己的 docstring 恰好把边界③列为它存在的理由之一
    # （客户会把「预计 12 天后撞线」当成承诺）。检查名说五条、实际验一条，
    # 比没有检查更糟 —— 它给人一种被保护的错觉。
    for i, gist in enumerate(_BOUNDARY_GIST, start=1):
        _check(f"boundary {i} present ({gist})",
               f"\n{i}. **Do not" in body,
               f"boundary {i} is missing from _shared/GUARDRAILS.md")
    _check("no sixth boundary snuck in unlisted",
           f"\n{len(_BOUNDARY_GIST) + 1}. **Do not" not in body,
           f"found a boundary #{len(_BOUNDARY_GIST) + 1}; add its gist to _BOUNDARY_GIST "
           "so it is covered by this check too")

    for d, asset_name in SKILLS.items():
        p = SKILL_DIR / d / "SKILL.md"
        rel = str(p.relative_to(ROOT))
        if not p.is_file():
            _check(f"{rel} exists", False, "file missing")
            continue
        head, block, tail = split_skill(p)
        same = block == body
        detail = ""
        if not same:
            diff = list(difflib.unified_diff(
                body.splitlines(), block.splitlines(),
                fromfile="_shared/GUARDRAILS.md", tofile=rel, lineterm="", n=1,
            ))
            detail = ("shared block differs from _shared; fix with "
                      "`python3 scripts/sync_inspection_skills.py --write`\n"
                      + "\n".join("      " + x for x in diff[:24]))
        _check(f"{rel} shared block is byte-identical to _shared", same, detail)

        # frontmatter 的 name 必须与 DA asset name 一致，且符合 Asset API 的命名约束
        # （小写字母/数字/连字符，1-64 字符，首尾非连字符）——否则上传时服务端拒。
        fm = re.match(r"\A---\n(.*?)\n---\n", head, re.S)
        _check(f"{rel} has frontmatter", bool(fm))
        if fm:
            m = re.search(r"^name:\s*(\S+)\s*$", fm.group(1), re.M)
            _check(f"{rel} frontmatter has name", bool(m))
            if m:
                got = m.group(1)
                _check(f"{rel} name == {asset_name}", got == asset_name, f"got {got!r}")
                _check(f"{rel} name matches Asset API naming rules",
                       bool(re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?", got)))
            dm = re.search(r'^description:\s*"(.*)"\s*$', fm.group(1), re.M | re.S)
            _check(f"{rel} description present and <=1024 chars",
                   bool(dm) and 1 <= len(dm.group(1)) <= 1024,
                   f"{len(dm.group(1)) if dm else 0} chars")
            # 载荷 marker 是激活的唯一确定信号（DA 对 investigation 的 skill 激活是
            # 按 description 匹配的模型判断，不是显式挂载）。description 里不提它，
            # 命中就只能靠模糊语义。
            _check(f"{rel} description contains the NOTIOPS_INSPECTION marker",
                   bool(dm) and "NOTIOPS_INSPECTION" in dm.group(1))

        # 两份 skill 的适用范围必须互斥，否则同一个 task 可能加载到错的那份。
        body_all = head + tail
        if d == "high-load":
            _check(f"{rel} declares scope threshold_high / chronic_high only",
                   "threshold_high" in body_all and "chronic_high" in body_all
                   and "inspection-cost-idle" in body_all)
        else:
            _check(f"{rel} declares scope idle / structural only",
                   "idle" in body_all and "structural" in body_all
                   and "inspection-high-load" in body_all)

    # 旧的单份 skill 不能与两份并存 —— 并存时上传三份，DA 可能加载到那份没人维护的。
    _check("legacy inspection-judgment/ has been removed",
           not (SKILL_DIR / "inspection-judgment" / "SKILL.md").is_file())

    _check_v2_structure(body)

    _check_cited_metrics_are_collected()
    _check_promised_attrs_are_produced()

    print("=" * 72)
    if _failed:
        print(f"FAILED - {len(_failed)} check(s)")
        return 1
    print("OK - all checks passed")
    return 0


if __name__ == "__main__":
    if "--write" in sys.argv:
        raise SystemExit(do_write())
    raise SystemExit(do_check())
