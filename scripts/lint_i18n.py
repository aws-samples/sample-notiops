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
    "core/aws_docs_mcp.py",
    "core/resources.py",
    "core/support_cases.py",
    "core/web_search.py",
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
    # dd1 token-savings test — asserts the trimmed prompt block no longer
    # contains topic-specific wording ("本主题只读工具"). The CJK literal is
    # an assertion about ABSENCE from a prompt, i.e. a fixture, not output.
    # (It was first written as a \uXXXX escape to dodge this check; the linter
    # decodes escapes, so allowlisting is the honest fix.)
    "scripts/test_devops_deep_token_savings.py",
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


def main(argv: list[str]) -> int:
    update_baseline = "--update-baseline" in argv[1:]
    explicit_files = [a for a in argv[1:] if not a.startswith("--")]
    files = collect_files(explicit_files)
    violations: list[str] = []
    violations += check_i18n_table()
    violations += check_cjk_literals(files)
    violations += check_call_sites(files)

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
