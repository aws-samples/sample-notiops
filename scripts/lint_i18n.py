#!/usr/bin/env python3
"""i18n correctness lint — run on every commit / PR.

WHY THIS EXISTS
This bot ships in zh + en (`core/i18n.py`). It's easy for a developer
adding a new feature to forget one of:
  1. Add a new user-facing string to `core/i18n.py` with BOTH
     `zh` AND `en` values.
  2. Reach for `i18n.t(key, locale)` instead of inlining a literal.
  3. Plumb `locale` through helpers / cards / Bedrock prompts.

This script catches those drifts BEFORE merge so the project's
"customer never sees a language they don't speak" promise can't
quietly bit-rot.

CHECKS
  C1  i18n table integrity — every key in `_TRANSLATIONS` MUST have
      both "zh" and "en" entries (no defaulting to en silently).
  C2  Forbidden CJK literals — no Chinese characters in *.py / *.yaml
      anywhere outside of the i18n table itself, comments / docstrings
      excepted (and a small allowlist of files like tests).
  C3  Hardcoded user-facing strings in chat-output call sites
      (`reply_text`, `chat_postMessage`, `_reply`, `_send_card`,
      `client.views_open` …) — they MUST receive an `i18n.t(...)` /
      `_build_*` result, not a bare string literal.

USAGE
  $ python scripts/lint_i18n.py             # check whole repo
  $ python scripts/lint_i18n.py path1 path2 # check specific files
  $ python scripts/lint_i18n.py --update-baseline
                                            # snapshot current
                                            # violations as the
                                            # accepted baseline; only
                                            # NEW violations fail
                                            # subsequent runs.
  Exit 0 = clean (or matches baseline), exit 1 = new violations.

BASELINE — pragmatic existing-debt handling
The repo had ~560 untranslated literals when lint was introduced
(case_flow.py, push_event.py, progress_sender.py — all P3 areas).
Demanding a full rewrite before merging anything
would block all work. Instead, `i18n_baseline.txt` holds a snapshot
of the at-introduction violations; lint only fails on additions
above the baseline (or on issues that don't appear there).

To pay down the debt, fix violations in those legacy files and run
`--update-baseline` to shrink the snapshot. The number-of-baseline-
violations is a treadmill: it can only go down, never up.

INTEGRATION
  - .github/workflows/lint.yml runs this on every PR.
  - .git/hooks/pre-commit (installed via scripts/install_hooks.sh)
    runs it on staged files for fast local feedback.
"""
from __future__ import annotations

import ast
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Configuration — what to scan, what to skip.
# ---------------------------------------------------------------------------

# Anywhere we look for Python source. Extend as new top-level dirs land.
PY_DIRS = ["core", "platforms", "lambda", "scripts"]

# Files we deliberately exempt from the CJK-literal check. Reason given
# inline so reviewers see why.
CJK_ALLOWLIST = {
    # The translation table itself — by definition contains Chinese.
    "core/i18n.py",
    # The 0-token IM intent router. Its CJK literals are INPUT-matching
    # regexes (matching what the user typed: 「开案例」「深度调查」…), not
    # user-facing OUTPUT text — they cannot route through i18n.t any more than
    # core/i18n.py's own `_NL_LANGUAGE_SWITCH_PATTERNS` can (same reason that
    # module is allowlisted). All OUTPUT this router produces goes through
    # i18n.t (help.*, router.*).
    "core/nl_router.py",
    # DevOps 对话直连 —— IM 端口自 bff/web-chat/devops_chat.mjs（现网踩过 bug 之后
    # 长成现在这样，见 §13.2）。CJK 字面量与事件流处理紧耦合、只在这一条路径出现，
    # 拆成 20 个 i18n key 会让"和 JS 端逐行对照"不再可能 —— 语义偏差就出来了。
    "core/devops_chat.py",
    # 变更请求/prompt-injection 二道门。CJK 字面量是**输入匹配正则**（匹配用户键入
    # 的「删除实例」「忽略以上指令」），不是输出文案 —— 与 core/nl_router.py 同源
    # 同理。输出（拒绝话术）走 i18n.t('out_of_scope.change_request', locale)。
    "platforms/common/router.py",
    # IM 端 markdown 降级器（标题 → 粗体、GFM 表格 → 带标签的列表）。它**不产出
    # 任何自己的文案** —— 只做结构变换，一个字都不新增；唯一的 CJK 字面量是
    # `_EMPTY_CELLS` 里的「无」，那是**输入匹配**（认出模型填的空占位格好丢掉，
    # 与 "-" / "n/a" 并列），与 core/nl_router.py / platforms/common/router.py
    # 同源同理。表格的**标签**取自模型自己写的表头文字，所以译文天然跟随原文的
    # 语言；搬进 core/i18n.py 反而会把中文表头硬配上英文标签。见 §3.48。
    "platforms/common/im_markdown.py",
    # Bedrock prompts that are deliberately bilingual / CJK-aware
    # (semantic detection rules need Chinese examples). The OUTPUT
    # language is controlled separately via _locale_directive().
    "core/bedrock_intent.py",
    "core/bedrock_chat.py",
    # Case classifier — an internal LLM helper, output is structured
    # JSON not free text.
    "core/case_classifier.py",
    # Next-step generator system prompt — bilingual examples.
    "core/next_steps.py",
    # Progress card thinking translator — talks in Chinese for a
    # specific zh-locale render path.
    "core/progress_card.py",
    # case_management — server-shape labels mostly already routed
    # through other layers. Whitelist for this MVP, revisit later.
    "core/case_management.py",
    # 资源巡检的端到端测试驱动器。里面的 CJK 全是**断言标签与失效说明**
    # （"coverage 不足时不判定（不是判成健康）"），只出现在开发者跑测试时的
    # 终端输出里，不进任何用户界面、报告或 IM 消息。
    #
    # ⚠️ 把它们搬进 core/i18n.py 是有害的：那张表是**产品文案**的单一来源，
    # 混进几百条测试断言会让真正要翻译的条目被淹掉，而这些标签的价值恰恰
    # 在于「一句话说清这条失败意味着什么」—— 那需要写得长、写得具体，
    # 与 UI 文案的要求正好相反。
    #
    # ⚠️ 这里原本写着「同理 `scripts/upload_inspection_skills.py` 选择全英文
    # 输出」—— **那句话与代码不符**（2026-08-25 核对）：那个脚本从第一版起
    # 就是中文输出的，而且它压根不在这份清单里，于是 15 条违规一直挂在
    # NEW 里。项目规范是「交互均使用中文」，所以按中文留，
    # 把它加进清单（下面那一项），并把这句错的注释改掉。
    "scripts/inspection_e2e.py",
    # 判读 skill 的上传工具。输出是给中文维护者看的部署日志。
    "scripts/upload_inspection_skills.py",
    # 同一类：巡检的**真实资源**验证工具，只在开发者终端里跑。
    #
    #   inspection_testbed.py         建/查/删一批验证用的 RDS/Aurora/EC
    #   inspection_verify_collect.py  拿那批资源验采集层（API → ResourceAttrs）
    #
    # 后者的 CJK 全是断言标签，与 `inspection_e2e.py` 同理 ——
    # 「🔴 Aurora MySQL 走 5ms 档（不是社区版的 15ms）」这种话的价值就在于
    # 长且具体，搬进产品文案表会把真要翻译的条目淹掉。
    #
    # ⚠️ 前者（testbed）里的中文还有一层作用：那几段 `🔴 保留删除保护关闭
    # 是刻意的` / `⚠️ 不要把这行抄到真实环境的模板里` 是**给人看的护栏**，
    # 必须紧贴代码。
    "scripts/inspection_testbed.py",
    "scripts/inspection_verify_collect.py",
    # 触发一轮真实巡检并逐层核对落库。与上面两个同类 —— 断言标签，
    # 只在开发者终端里出现（「🔴 dispatched == mapped（taskId 接住了）」
    # 这种话的价值就在于长且具体）。
    "scripts/inspection_verify_live.py",
    # 接线检查（domain 层算好了但调用方没取）。与上面三个同类：**开发者工具**，
    # 输出只在终端与 CI 日志里出现，客户永远看不到。
    #
    # ⚠️ 它的输出必须长且具体才有用 —— 一句「seams: 1 violation」等于没说。
    #    真正有价值的是「`evaluable` 的 docstring 写着『调用方 SHALL 用它』，
    #    而调用方零读点 —— 那个判据算了没人取」这一整句：它同时给出了症状、
    #    判据来源和为什么这是缺陷。搬进 core/i18n.py 会让这类话被压成键名。
    "scripts/lint_seams.py",
    # 一次性数据迁移：给存量 finding 补 GSI 索引键（跨账号统一视图）。
    # 同上 —— **运维工具**，运维自己在终端里跑，输出只有他看。
    #
    # ⚠️ 它有一段中文是**护栏**，必须紧贴代码：这台机器的 shell 里
    #    `AWS_REGION=us-east-1` 而表在东京，脚本会先拦一次并把正确命令原样
    #    打出来。搬进 core/i18n.py 之后那行命令就成了一个 `.replace()` 模板，
    #    而它的全部价值就在于能直接复制粘贴。
    "scripts/backfill_finding_gsi.py",
    # 一次性探针：验 `ArnLike aws:PrincipalArn` 在 event bus 资源策略上的形态
    # （iam 还是 sts）以及保留前缀 source 能不能被跨账号转发。
    # 同上 —— **开发者工具**，只在终端里跑一次，客户永远看不到。
    #
    # ⚠️ 它的中文有两处是护栏，必须紧贴代码：
    #    ① 「不能用手工 put-events 验」的理由（那时 aws:PrincipalArn 是发起人
    #      自己的，必然不匹配，而不匹配分不清是策略写错还是测试方法错）
    #    ② 「B 段是反面对照」—— 只验 A 到了不够，两种都到说明 Condition 整个
    #      没起作用、A 的绿是假的
    #    搬进 core/i18n.py 之后这两条会被压成键名，而它们的价值就在于原地可读。
    "scripts/probe_arnlike_bus_policy.py",
    # ── WEB-CHAT AGENT-side core modules (whole group) ──────────────────────
    # These run INSIDE the Bedrock AgentCore Runtime (mirrored under
    # agent-build/NotiOpsWebChat/app/NotiOpsWebChat/core/, where there is NO
    # core/i18n.py). The web-chat agent controls its OUTPUT language via the
    # prompt layer (lang/date directives + topic focus + tool docstrings), NOT
    # via i18n.t — same pattern as the already-allowlisted bedrock_chat.py /
    # next_steps.py. The CJK in them is tool result labels / report headings /
    # progress lines / error messages the agent relays; routing through i18n.t
    # would require a `locale` the runtime doesn't thread. Verified: none of
    # these are imported by platforms/ (the IM side that DOES use i18n) —
    # `grep -rE "from core import <mod>|core\.<mod>" platforms/` is empty for all.
    #
    # MAINTENANCE: when you add a NEW core/*.py that is used ONLY by the web-chat
    # agent (imported in agent-build/.../main.py, not by platforms/), add it here.
    # This is why the same CJK-literal CI failure kept recurring per-file; listing
    # the whole group fixes it once. Do NOT add IM-shared modules here.
    "core/whats_new.py",
    "core/reports.py",
    "core/report_html.py",
    "core/aws_api_mcp.py",
    "core/devops_agent.py",
    "core/finops_mcp.py",
    "core/investigation_mcp.py",
    # mcp_snapshot.py 同组（web-chat agent 专用，上面三个 MCP 模块共用的启动解耦层）。
    # 它的 CJK 全在注释/docstring 里；唯一面向模型的字符串 `_UNAVAILABLE` 是英文
    # （给 LLM 看的改道指令，不是给用户看的文案）。
    "core/mcp_snapshot.py",
    "core/aws_docs_mcp.py",
    "core/resources.py",
    "core/support_cases.py",
    "core/web_search.py",
    # agentcore_search.py 同组（web-chat agent 专用）。它的 CJK 是**匹配用的 fixture**：
    # `_NOISE_MARKERS` 里那几个串（"正在加载" / "跳至主要内容"）用来识别 JS 占位页、
    # 把这类没有正文的命中丢掉。它们是拿去 `in` 比对的模式，不是输出给谁看的文案 ——
    # 翻译它们只会让判别失效（Exa 移除后这段从 web_search.py 搬来，那边本就在本名单里）。
    "core/agentcore_search.py",
    # support_logic — language picker LABELS contain native names
    # (中文 / 日本語 / 한국어) by design, since customers choose what
    # language AWS engineers should respond in regardless of bot UI
    # locale. Severity labels use severity_label(code, locale) helper
    # which IS i18n-aware.
    "core/support_logic.py",
    # Slack push event helpers — heads-up cards are zh-only for now,
    # tracked as P3 work.
    # (Add specific files when you locate them.)
    # The lint script + tests can mention Chinese for assertions.
    "scripts/lint_i18n.py",
    "scripts/test_aws_docs_mcp.py",
    # 两份**人工** UI 回归文档的账号占位号一致性判据。与 `lint_seams.py` /
    # `inspection_verify_live.py` 同类：**开发者/CI 工具**，输出只在终端与 CI
    # 日志里，客户永远看不到。
    #
    # ⚠️ 它的 CJK 有两种，都必须留在原地：
    #   ① **正则本身**含中文（`成员账号 \*\*(号) \(workload-prod\)\*\*`）——
    #      被检查的文档是中文写的，正则不可能不含中文。搬进 i18n 表更是荒谬：
    #      那是判据的一部分，不是给人读的文案。
    #   ② **失败说明**要长且具体才有用。「短号对不上」等于没说；有价值的是
    #      「文档里写的是 X。正文用短号 444 指代它 —— 只改长号不改短号，照这份
    #      文档做验收的人会卡住（2026-09-03 就是这么坏的）」——
    #      症状 + 判据 + 为什么是缺陷。压成键名就没了。
    "scripts/test_ui_doc_account_consistency.py",
    # 冷启动延迟探针 —— **开发/运维自用工具，不在任何客户路径上**。它的 CJK 是
    # argparse help、终端表头（"ttfb (首帧)"）和一句探针 prompt（"你好"）。没有客户会
    # 看到这些字，也没有 locale 可以 thread：它是本地手工跑的一次性度量脚本
    # （scripts/measure_cold_start.py --runs 5），产出是 stdout 表格和一个 json 文件。
    # 其中那句 prompt 甚至是**参数**（--prompt），默认值只是选了句最短的中文寒暄，
    # 目的是量首字延迟而不触发任何工具调用。
    "scripts/measure_cold_start.py",
    # Sanitizer self-test asserts on the exact CJK spam tokens that
    # GPT leaked in the 2026-06-05 incident. The strings ARE the
    # regression fixtures; routing them through i18n would defeat
    # the test.
    "scripts/test_openai_responses_sanitizer.py",
    # DingTalk handler smoke test — uses CJK fixture text in mock
    # return values ("什么是 EKS", "EKS 是托管的 Kubernetes 服务。",
    # "中文") to drive the handler's locale + reply branches. They
    # are test fixtures, not user-facing strings.
    "scripts/test_dingtalk_handler.py",
    # DingTalk sender smoke test — calls `reply_text(...)` with
    # English fixture strings to verify the sender's no-op contract.
    # Test fixtures, not user-facing.
    "scripts/test_dingtalk_sender.py",
    # Intent force-investigate predicate test — uses CJK fixture
    # strings (e.g. "使用 devops agent 查本月成本") as INPUT to the
    # regex predicates being tested. They are not user-facing
    # strings; routing them through i18n would defeat the test.
    "scripts/test_intent_force_investigate.py",
    # Case-analyze intent test — uses CJK fixture strings (e.g.
    # "分析 case 1234567890" / "case xxx 应该回什么") as INPUT to
    # the bedrock_intent classifier. They're testing that those
    # phrases route to case_analyze, not user-facing strings; routing
    # them through i18n would defeat the test.
    "scripts/test_case_analyze_intent.py",
    # Mantle backend-task test — CJK strings are (a) console section
    # headings for the developer running the suite and (b) prompt /
    # response fixtures fed to the stubbed endpoint. Nothing here is
    # emitted to an end user, so bilingual routing would only make the
    # assertions harder to read.
    "scripts/test_llm_provider_mantle.py",
    # Secret-grant scope guard — CJK is the console section heading and the
    # rationale in assertion labels, for the developer running the suite.
    # Nothing here reaches an end user.
    "scripts/test_secret_grants_scoped.py",
    # Mantle region-list consistency guard — CJK is the suite heading and the
    # failure hint telling the developer to update the extractors rather than
    # delete the assertion. Developer-facing only; never reaches an end user.
    "scripts/test_mantle_regions_consistent.py",
    # "is every suite actually run by CI" meta-assertion — CJK is the suite
    # heading plus the exemption reasons, which exist to be read by whoever is
    # about to add an exemption. Developer-facing only.
    "scripts/test_ci_runs_every_suite.py",
    # 流事件过滤测试 —— CJK 是测试标题/断言标签，以及**事故复现用的 fixture**
    # （Grok 加密思考链泄漏时用户看到的那串正文）。Developer-facing only。
    "scripts/test_stream_event_filter.py",
    # dd1 token-savings test — asserts the trimmed prompt block no longer
    # contains topic-specific wording ("本主题只读工具"). The CJK literal is
    # an assertion about ABSENCE from a prompt, i.e. a fixture, not output.
    # (It was first written as a \uXXXX escape to dodge this check; the linter
    # decodes escapes, so allowlisting is the honest fix.)
    "scripts/test_devops_deep_token_savings.py",
    # 一键部署模板的判据测试 —— CJK 分两类，都不是产品输出：断言标签/失败提示
    # （给下一个撞上判据的维护者看的），以及**故意造的坏模板 fixture**。后者尤其
    # 不能翻译：那条判据本身就是「客户可见文案里不许有非 ASCII」（CFN 会把它们换成
    # `?`），反例必须真的是中文/破折号才撞得上它。Developer-facing only。
    "scripts/test_postprocess_template.py",
    # 两条部署路径的 web 功能一致性判据 —— CJK 是套件标题和失败提示（「新增 web 功能时
    # 两条路径都要落地」/「别把断言删掉，去更新提取器」），写给下一个撞上它的维护者。
    # Developer-facing only；断言本身比对的是源码里的 IAM 动作名与环境变量键，全是 ASCII。
    "scripts/test_oneclick_parity.py",
    # 一键部署的 IM zip 打包器 —— **维护者切版本时在自己机器上跑的构建脚本**
    # （scripts/package_artifacts.sh 调它产出 im-code.zip / im-layer.zip），不在任何
    # 客户路径上、也没有 locale 可以 thread。它的 CJK 全是 argparse help 和写给维护者的
    # **失败诊断**：排除清单没读全、层里缺模块、解压体积逼近 Lambda 250 MB 上限、
    # zip 里混进了 dist/ —— 每一条都对应一次"方式 A 装出来直接 ImportModuleError 而
    # 方式 B 完全正常"的事故，翻成英文只会让下一个维护者更难对上号。Developer-facing only。
    "scripts/build_im_zips.py",
    # 「setup.sh 不许部署成功但只回显」门禁 —— CJK 是套件标题、断言标签和失败提示
    # （告诉维护者为什么这条判据存在:客户 2026-08-26 那次静默降级）。其中还引用了
    # 客户实际看到的那句回显文案作为 fixture。Developer-facing only。
    "scripts/test_setup_agent_gate.py",
    # Sanitizer denylist — internal blocklist of OpenAI ChatML
    # protocol fragments + Chinese SEO/gambling spam tokens that
    # must NEVER reach end users. These strings are pattern fixtures,
    # not user-facing text; bilingual translation is meaningless
    # (they're literals to match against).
    "core/openai_responses_client.py",
    # DingTalk case_flow recognises CJK cancel keywords (`取消` /
    # `停止`) as user INPUT to abort the multi-turn case-create
    # flow. They're matched against incoming text, not emitted to
    # the user — the user-facing messages all come from i18n.t.
    "platforms/dingtalk/app/case_flow.py",
}

# Functions whose first / "text" argument MUST be an i18n.t(...) call
# rather than a string literal. Keys are the function names as they
# appear in the source (NOT fully-qualified). Values are the kwargs we
# guard — `None` for "the first positional or `text=`/`content=` arg".
USER_FACING_CALLS: dict[str, set[str]] = {
    # Slack — bolt's `say()` and chat.postMessage / chat.update / etc.
    "say": {"text"},
    "chat_postMessage": {"text"},
    "chat_postEphemeral": {"text"},
    "chat_update": {"text"},
    "respond": {"text"},
    # Feishu helpers
    "_reply": {None},          # _reply(msg, text)
    "_toast": {None},          # _toast("...")
    "reply_text": {None},      # feishu_utils.reply_text(msg_id, text)
    # bedrock_chat itself produces user-facing replies — the outer call
    # site already enforces locale, but anyone wrapping it must too.
    "respond_chat": {None},
}

# Regex for CJK Unified Ideographs (U+4E00–U+9FFF). Conservative —
# leaves CJK punctuation / fullwidth digits alone.
CJK_RE = re.compile(r"[一-鿿]")


# ---------------------------------------------------------------------------
# C1 — i18n table integrity
# ---------------------------------------------------------------------------
def check_i18n_table() -> list[str]:
    """Return a list of violation strings. Empty list = clean."""
    out: list[str] = []
    path = REPO / "core" / "i18n.py"
    src = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(src, filename=str(path))
    except SyntaxError as e:
        return [f"{path.relative_to(REPO)}: cannot parse: {e}"]

    table = None
    for node in ast.walk(tree):
        # `_TRANSLATIONS = {...}` (Assign) or
        # `_TRANSLATIONS: dict[...] = {...}` (AnnAssign).
        if (isinstance(node, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == "_TRANSLATIONS"
                        for t in node.targets)
                and isinstance(node.value, ast.Dict)):
            table = node.value
            break
        if (isinstance(node, ast.AnnAssign)
                and isinstance(node.target, ast.Name)
                and node.target.id == "_TRANSLATIONS"
                and isinstance(node.value, ast.Dict)):
            table = node.value
            break
    if table is None:
        return ["core/i18n.py: _TRANSLATIONS dict not found"]

    for key_node, value_node in zip(table.keys, table.values):
        if not isinstance(key_node, ast.Constant) or not isinstance(key_node.value, str):
            out.append(f"core/i18n.py: non-string key at line {key_node.lineno}")
            continue
        key = key_node.value
        if not isinstance(value_node, ast.Dict):
            out.append(f"core/i18n.py: key {key!r} value is not a dict (line {value_node.lineno})")
            continue
        locales = set()
        for sub_k in value_node.keys:
            if isinstance(sub_k, ast.Constant) and isinstance(sub_k.value, str):
                locales.add(sub_k.value)
        missing = {"zh", "en"} - locales
        if missing:
            out.append(
                f"core/i18n.py: key {key!r} missing locale(s) "
                f"{sorted(missing)} (line {value_node.lineno})")
    return out


# ---------------------------------------------------------------------------
# C2 — CJK literals outside the i18n table
# ---------------------------------------------------------------------------
def check_cjk_literals(files: list[Path]) -> list[str]:
    """Walk each file's AST. Flag string literals containing CJK chars
    UNLESS the file is in the allowlist OR the literal lives inside a
    docstring (the very first statement of a module / function / class)."""
    out: list[str] = []
    for path in files:
        rel = str(path.relative_to(REPO))
        if rel in CJK_ALLOWLIST:
            continue
        if path.suffix not in (".py",):
            continue
        try:
            src = path.read_text(encoding="utf-8")
            tree = ast.parse(src, filename=str(path))
        except SyntaxError as e:
            out.append(f"{rel}: parse error: {e}")
            continue

        # Collect docstring node ids so we don't flag them. Module +
        # FunctionDef + AsyncFunctionDef + ClassDef.
        docstring_node_ids: set[int] = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef,
                                  ast.AsyncFunctionDef, ast.ClassDef)):
                body = getattr(node, "body", [])
                if (body and isinstance(body[0], ast.Expr)
                        and isinstance(body[0].value, ast.Constant)
                        and isinstance(body[0].value.value, str)):
                    docstring_node_ids.add(id(body[0].value))

        for node in ast.walk(tree):
            if (isinstance(node, ast.Constant)
                    and isinstance(node.value, str)
                    and id(node) not in docstring_node_ids
                    and CJK_RE.search(node.value)):
                snippet = node.value.strip().splitlines()[0][:80]
                out.append(
                    f"{rel}:{node.lineno}: CJK literal {snippet!r} — "
                    f"move to core/i18n.py and call i18n.t(...) with "
                    f"both zh and en values")
    return out


# ---------------------------------------------------------------------------
# C3 — user-facing call sites must use i18n.t(...) / a builder, not literals
# ---------------------------------------------------------------------------
def _arg_is_safe(arg: ast.expr) -> bool:
    """Whitelist of expression shapes we allow as the user-visible
    `text` argument:
      - i18n.t(...)
      - any Call (assume it's a properly-i18n'd builder; reviewer can
        chase the function definition)
      - Name (variable holding text — assume composed elsewhere)
      - JoinedStr (f-string) — common for "{intent}" style with
        already-translated bits; reviewer can chase down
      - dict/list/None
    Forbid:
      - bare Constant that isn't an empty string
    """
    if isinstance(arg, ast.Constant):
        if isinstance(arg.value, str) and arg.value == "":
            return True
        if not isinstance(arg.value, str):
            return True
        return False
    return True


def check_call_sites(files: list[Path]) -> list[str]:
    out: list[str] = []
    for path in files:
        rel = str(path.relative_to(REPO))
        if rel in CJK_ALLOWLIST:
            continue
        if path.suffix not in (".py",):
            continue
        try:
            src = path.read_text(encoding="utf-8")
            tree = ast.parse(src, filename=str(path))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func_name = None
            if isinstance(node.func, ast.Attribute):
                func_name = node.func.attr
            elif isinstance(node.func, ast.Name):
                func_name = node.func.id
            if not func_name or func_name not in USER_FACING_CALLS:
                continue
            guarded = USER_FACING_CALLS[func_name]
            for kw in node.keywords:
                if kw.arg in guarded and not _arg_is_safe(kw.value):
                    val = (getattr(kw.value, "value", "") or "")
                    snippet = str(val).strip().splitlines()[0][:80]
                    out.append(
                        f"{rel}:{node.lineno}: {func_name}({kw.arg}=...) "
                        f"got hard-coded literal {snippet!r} — "
                        f"use i18n.t(key, locale, **kw)")
            # Positional first arg path — only triggers when guarded
            # set contains None (i.e. function takes text positionally).
            if None in guarded and node.args:
                # Heuristic: many of these helpers have signature
                # (msg, text) or (text). The text arg is the LAST
                # positional that's a string-shape; check all positional
                # args to be safe.
                for pos_idx, a in enumerate(node.args):
                    if isinstance(a, ast.Constant) and isinstance(a.value, str) and a.value:
                        snippet = a.value.strip().splitlines()[0][:80]
                        out.append(
                            f"{rel}:{node.lineno}: {func_name}() got "
                            f"hard-coded string at arg {pos_idx} "
                            f"({snippet!r}) — use i18n.t(...)")
                        break
    return out


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------
def collect_files(args: list[str]) -> list[Path]:
    if args:
        out = [Path(a).resolve() for a in args]
    else:
        out = []
        for d in PY_DIRS:
            for p in (REPO / d).rglob("*.py"):
                # Skip __pycache__ + .aws-sam build artefacts.
                if "__pycache__" in p.parts or ".aws-sam" in p.parts:
                    continue
                out.append(p)
    return [p for p in out if p.is_file()]


BASELINE_FILE = REPO / "scripts" / "i18n_baseline.txt"


def _normalize_violation(v: str) -> str:
    """Strip line numbers so the baseline survives unrelated edits.

    `core/foo.py:123: CJK literal 'x'` → `core/foo.py:CJK literal 'x'`
    Line numbers shift on every edit; if we keyed on them the baseline
    would go stale immediately. Path + violation kind + content is
    stable enough to detect re-emergence after a "fix".
    """
    parts = v.split(":", 2)
    if len(parts) >= 3 and parts[1].strip().isdigit():
        return parts[0] + ":" + parts[2].strip()
    return v


def _load_baseline() -> set[str]:
    if not BASELINE_FILE.exists():
        return set()
    return {
        line.strip()
        for line in BASELINE_FILE.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    }


def _save_baseline(violations: list[str]) -> None:
    body = ["# Auto-generated by scripts/lint_i18n.py --update-baseline.",
            "# Number-of-lines is a treadmill — it can only go down.",
            "# Each line is a normalized violation (no line numbers,",
            "# so baselined entries survive unrelated edits to the file)."]
    body.extend(sorted({_normalize_violation(v) for v in violations}))
    BASELINE_FILE.write_text("\n".join(body) + "\n", encoding="utf-8")


def check_frontend_keys() -> list[str]:
    """前端 `t("a.b.c")` 引用的键必须在 `frontend/*/src/i18n.ts` 里存在。

    🔴 2026-08-26：`admin.accounts.noOneClick` 漏加了，页面上直接印出
    ``admin.accounts.noOneClick`` 这一串原文给客户看 —— 而这个脚本原来只查
    ``core/i18n.py``（Python 侧），前端的键**从来没被检查过**。

    ``t()`` 找不到键就返回键名本身：不抛、不告警、不进日志。所以这一类缺陷
    只能靠客户截图发现，而它长得像「系统坏了」。

    ⚠️ 只认**字面量**调用 ``t("literal")``。动态键（``t(`x.${v}`)`` 或
       ``t(someVar)``）跳过 —— 静态查不了，硬报会全是假阳性。
    """
    import re

    out: list[str] = []
    for i18n_file in sorted(REPO.glob("frontend/*/src/i18n.ts")):
        root = i18n_file.parent
        src = i18n_file.read_text(encoding="utf-8")
        # 形如   "a.b.c": {      /      'a.b.c': {
        defined = set(re.findall(
            r'^\s*["\']([\w.\-]+)["\']\s*:\s*\{', src, re.M))
        if not defined:
            out.append(f"{i18n_file.relative_to(REPO)}: 解析不出任何 i18n 键 —— "
                       "键的写法变了？这个检查会静默失效，先修解析")
            continue
        for f in sorted(root.rglob("*.ts*")):
            if f.name == "i18n.ts":
                continue
            text = f.read_text(encoding="utf-8")
            for m in re.finditer(r'\bt\(\s*["\']([\w.\-]+)["\']', text):
                key = m.group(1)
                if key in defined:
                    continue
                line = text[:m.start()].count("\n") + 1
                out.append(
                    f"{f.relative_to(REPO)}:{line}: t({key!r}) —— 这个键在 "
                    f"{i18n_file.relative_to(REPO).name} 里不存在，页面上会"
                    f"直接显示键名本身")
    return out


def check_frontend_orphans() -> list[str]:
    """反方向：`i18n.ts` 里定义了却**没人引用**的键。

    🔴 只查「引用了但没定义」是单向的。反方向的孤儿键会一直堆着，而它们的
    害处不是占空间：

    ```
    · 改文案时会去改一个不生效的键，然后奇怪为什么界面没变
    · 删功能时留下的键让人以为那个功能还在（2026-09-02 清掉 7 个，
      其中 `insp.empty.clean` / `insp.empty.noRun` 是空态重做前的遗留，
      而新空态的判据完全换了一套）
    · 它们会被当成「已有译文」而在下一次改动里被复用，把老语义带回来
    ```

    ⚠️ 判据里 `t("literal")` 之外还要认 `` t(`x.${v}`) `` 这类**动态前缀**：
       动态拼的键静态查不出全名，但前缀能查。漏了它会把
       `insp.sev.CRITICAL`（`t(\\`insp.sev.${sev}\\`)` 拼出来的）报成孤儿 ——
       那是假阳性，而一个会误报的检查等于没有检查。

    ⚠️ 带基线：仓库里已有的孤儿键先记账不报（同这个脚本其它检查的做法），
       否则这条一上线就是上百条噪音，没人会去看。
    """
    import re

    out: list[str] = []
    for i18n_file in sorted(REPO.glob("frontend/*/src/i18n.ts")):
        root = i18n_file.parent
        src = i18n_file.read_text(encoding="utf-8")
        defined = set(re.findall(
            r'^\s*["\']([\w.\-]+)["\']\s*:\s*\{', src, re.M))
        if not defined:
            continue          # 解析失效已由 check_frontend_keys 报过
        used: set[str] = set()
        prefixes: set[str] = set()
        for f in sorted(root.rglob("*.ts*")):
            if f.name == "i18n.ts":
                continue
            # ⚠️ **测试文件不算「被用到」。** 一条断言「这个键存在」不让那个键
            #    在产品里生效 —— 而孤儿键最常见的形态恰恰是「功能删了、
            #    键留着、测试还在断言它」。把测试算进来会让这个检查对那种
            #    形态完全失效（实测：删掉的 `insp.judge.addNote` 加回来
            #    不报，因为测试文件里提到了它）。
            if re.search(r"\.(test|spec)\.tsx?$", f.name):
                continue
            text = f.read_text(encoding="utf-8")
            used.update(re.findall(r'\bt\(\s*["\']([\w.\-]+)["\']', text))
            # 🔴 键名**作为字面量出现在任何地方**都算被用到，不只是
            #    直接写在 `t(...)` 里。实测的假阳性：
            #
            #      types.ts:    { labelKey: "topic.general", … }
            #      Sidebar.tsx: { labelKey: "topic.general", … }
            #      渲染处:       t(section.labelKey)
            #
            #    键经一个字段绕了一圈才进 `t()`，只扫 `t("…")` 会把它报成孤儿。
            #    而一个会误报的检查等于没有检查（人会开始忽略它）。
            used.update(re.findall(r'["\'`]([\w\-]+(?:\.[\w\-]+)+)["\'`]', text))
            # 动态键：`t(`insp.sev.${sev}`)` → 前缀 `insp.sev.`
            prefixes.update(re.findall(r'\bt\(\s*`([\w.\-]+?)\$\{', text))
            # 键名也可能被拼在别处（例如 `insp.precision.` + rank），
            # 所以任何出现过的字面前缀都算「可能被用到」。
            prefixes.update(re.findall(r'["\'`]([\w.\-]+\.)["\'`]', text))
        for key in sorted(defined - used):
            if any(key.startswith(p) for p in prefixes):
                continue
            out.append(
                f"{i18n_file.relative_to(REPO)}: {key!r} 定义了但没有任何"
                f" t() 引用 —— 改它不会生效，留着会让人以为那个功能还在")
    return out


def main(argv: list[str]) -> int:
    update_baseline = "--update-baseline" in argv[1:]
    explicit_files = [a for a in argv[1:] if not a.startswith("--")]
    files = collect_files(explicit_files)
    violations: list[str] = []
    violations += check_i18n_table()
    violations += check_cjk_literals(files)
    violations += check_call_sites(files)
    violations += check_frontend_keys()
    violations += check_frontend_orphans()

    if update_baseline:
        _save_baseline(violations)
        print(f"i18n lint: baselined {len(violations)} existing violation(s) "
              f"into {BASELINE_FILE.relative_to(REPO)}")
        return 0

    baseline = _load_baseline()
    new_violations = [v for v in violations
                      if _normalize_violation(v) not in baseline]
    fixed_count = len(baseline) - len(
        {_normalize_violation(v) for v in violations} & baseline)

    if not new_violations:
        msg = f"i18n lint: clean ({len(files)} files"
        if baseline:
            msg += f", {len(baseline)} baselined"
            if fixed_count > 0:
                msg += f", {fixed_count} now fixed — please run "
                msg += "`--update-baseline` to shrink the snapshot"
        msg += ")"
        print(msg)
        return 0

    print(f"i18n lint: {len(new_violations)} NEW violation(s) "
          f"({len(baseline)} baselined existing)")
    for v in new_violations:
        print(f"  ✗ {v}")
    print()
    print("How to fix:")
    print("  1. Add the string to core/i18n.py with BOTH zh and en values.")
    print("  2. Call site: i18n.t('your.key', locale, **kwargs)")
    print("  3. Plumb `locale` through callers from locale_resolver.")
    print("See CONTRIBUTING.md for the full rulebook.")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
