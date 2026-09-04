#!/usr/bin/env python3
"""Meta-assertion: setup.sh actually wires the inspection skill upload.

Why this needs a test at all
----------------------------
The upload step is *non-blocking by design* -- if it fails, setup.sh prints a
warning and carries on, because a missing skill does not break deployment. That
is the right behaviour, and it is also exactly what makes a wiring mistake
invisible:

    wrong shell variable name  -> empty --account-id  -> DynamoDB lookup misses
                                  -> notes silently dropped
    wrong CDK output key       -> INSPECT_SPACE_ID empty -> whole step skipped
                                  -> "skipping ..." printed, nobody reads it
    step placed before deploy  -> cdk-outputs.json absent -> same skip

In every case `setup.sh` exits 0, the stack deploys fine, inspection reports are
still produced -- just without the judgment methodology, so the conclusions
degrade to generic output. There is no runtime signal.

So the wiring itself is asserted here: the variables must exist before use, the
output key must match what the CDK stack declares, and the ordering must hold.

Output is English on purpose: `scripts/` is inside lint_i18n.py's PY_DIRS.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SETUP = ROOT / "setup.sh"
STACK_TS = ROOT / "infra" / "lib" / "notiops-backend-stack.ts"
UPLOADER = ROOT / "scripts" / "upload_inspection_skills.py"

_failed: list[str] = []


def _check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'OK  ' if ok else 'FAIL'} {label}" + (f" :: {detail}" if detail and not ok else ""))
    if not ok:
        _failed.append(label)


def _setup_text() -> str:
    return SETUP.read_text(encoding="utf-8")


def _line_of(text: str, needle: str) -> int:
    for i, ln in enumerate(text.splitlines(), start=1):
        if needle in ln:
            return i
    return -1


def _commands_naming(text: str, needle: str) -> list[str]:
    """把提到 `needle` 的那几条 shell 命令**整条**取回来（含 `\\` 续行）。

    上传命令的参数在续行上（`… upload_inspection_skills.py \\` 换行后才是
    `--all-accounts --space "$…"`），只看命中那一行的话所有 `--flag "$VAR"`
    都不在视野里 —— 断言会因为「没找到」而恒绿。
    """
    lines = text.splitlines()
    out: list[str] = []
    for i, ln in enumerate(lines):
        if needle not in ln:
            continue
        # 往前吃掉把本行接上来的续行（管道/env 前缀通常在上一行）。
        start = i
        while start > 0 and lines[start - 1].rstrip().endswith("\\"):
            start -= 1
        end = i
        while end < len(lines) - 1 and lines[end].rstrip().endswith("\\"):
            end += 1
        out.append(" ".join(x.rstrip().rstrip("\\").strip()
                            for x in lines[start:end + 1]))
    return out


_IF = re.compile(r"^(?:if|elif)\b")
_FI = re.compile(r"^fi\b")
_ELSE = re.compile(r"^(?:else\b|elif\b)")


def _failure_branch(text: str, needle: str) -> list[str]:
    """切出 `needle` 所在那个 `if` 的 **else 支**（按 if/fi 配平，不看缩进）。

    切不出来就返回空 list —— 调用方必须把它当**断言失败**，绝不能当成
    「没找到所以通过」：这个函数的返回值是下面两条判据的全部视野。
    """
    lines = text.splitlines()
    idx = next((i for i, ln in enumerate(lines) if needle in ln), -1)
    if idx == -1:
        return []
    # 调用体在续行上，`if` 关键字在它上面几行。
    while idx > 0 and lines[idx - 1].rstrip().endswith("\\"):
        idx -= 1
    if not _IF.match(lines[idx].strip()):
        return []
    depth = 0
    else_at = -1
    for i in range(idx, len(lines)):
        s = lines[i].strip()
        if _IF.match(s) and not s.startswith("elif"):
            depth += 1
            continue
        if _FI.match(s):
            depth -= 1
            if depth == 0:
                return lines[else_at + 1:i] if else_at != -1 else []
            continue
        if depth == 1 and else_at == -1 and _ELSE.match(s):
            else_at = i
    return []


def main() -> int:
    print("test_setup_wires_skill_upload")

    if not SETUP.is_file():
        _check("setup.sh exists", False, str(SETUP))
        return 1
    text = _setup_text()

    # --- the step exists at all -------------------------------------------
    _check("setup.sh invokes the uploader",
           "scripts/upload_inspection_skills.py" in text,
           "the two judgment skills would never reach the agent space")
    _check("uploader script exists", UPLOADER.is_file(), str(UPLOADER))

    # --- the CDK output key matches both sides ----------------------------
    # A typo here makes INSPECT_SPACE_ID empty -> the whole step is skipped
    # with a message nobody reads, and setup.sh still exits 0.
    ts = STACK_TS.read_text(encoding="utf-8") if STACK_TS.is_file() else ""
    declared = set(re.findall(r'new cdk\.CfnOutput\(this,\s*"([A-Za-z0-9]+)"', ts))
    used = set(re.findall(r"\.NotiOpsBackendStack\.([A-Za-z0-9]+)", text))
    _check("CDK declares InspectionAgentSpaceId output",
           "InspectionAgentSpaceId" in declared,
           f"declared outputs: {sorted(declared)}")
    _check("setup.sh reads InspectionAgentSpaceId",
           "InspectionAgentSpaceId" in used,
           f"keys read from cdk-outputs.json: {sorted(used)}")
    phantom = sorted(used - declared)
    _check("every cdk-outputs key setup.sh reads is actually declared",
           not phantom,
           f"read but never declared: {phantom} -- these resolve to empty and "
           "silently skip whatever depends on them")

    # --- shell variables are assigned before the step ----------------------
    # `--account-id "$ACCOUNT_ID"` was the first version's bug: that variable
    # does not exist (the real one is DEPLOY_ACCOUNT), so the DynamoDB lookup
    # got an empty account and customer notes were silently dropped.
    step_line = _line_of(text, "scripts/upload_inspection_skills.py")
    for var in ("DEPLOY_ACCOUNT", "DEPLOY_REGION", "PROJECT_ROOT"):
        assign = min(
            (i for i, ln in enumerate(text.splitlines(), start=1)
             if re.match(rf"\s*(export\s+)?{var}=", ln) and i < step_line),
            default=-1,
        )
        _check(f"${var} is assigned before the upload step",
               assign != -1,
               f"used at line {step_line} but never assigned before it")

    # Referencing a variable that is never assigned anywhere is worse: it
    # expands to empty and the failure is silent.
    # ⚠️ 这里原来只盯 `--account-id` / `--space-id` 两个**已经不存在**的参数名
    # （uploader 的 argparse 认的是 `--space` / `--region`），于是这个循环
    # 一次都不进 —— 0 次迭代不会红，只是什么都没查，看起来和查过一样。
    # 参数名不该出现在判据里：现在把上传命令**整条**（含 `\` 续行）取出来，
    # 里面每一个 `--flag "$VAR"` 的变量都必须真被赋过值。
    upload_cmds = _commands_naming(text, "scripts/upload_inspection_skills.py")
    _check("the uploader is invoked with arguments",
           bool(upload_cmds) and any('--' in c for c in upload_cmds),
           "no flag-bearing invocation found -- the loop below would check nothing")
    for var in sorted({m.group(1) for c in upload_cmds
                       for m in re.finditer(r'--[a-z0-9-]+\s+"\$([A-Z_]+)"', c)}):
        _check(f"${var} passed to the uploader is a real variable",
               bool(re.search(rf"^\s*(export\s+)?{var}=", text, re.M)),
               "expands to empty -> lookup silently misses")

    # --- ordering: must run after cdk deploy ------------------------------
    deploy_line = _line_of(text, "npx cdk deploy --all")
    _check("upload step runs after `cdk deploy --all`",
           deploy_line != -1 and step_line > deploy_line,
           f"deploy at {deploy_line}, upload at {step_line} -- "
           "cdk-outputs.json would not exist yet")

    # --- failure must be visible, not swallowed ---------------------------
    # 审计窗口必须**只**是「上传失败」那一支。这个窗口错过两次，两次都让下面
    # 两条 `any(...)` 判据变成恒绿：
    #
    #   锚点  第一版是 `text[text.index("INSPECT_SPACE_ID=")][:2000]`。setup.sh
    #         里**没有** `INSPECT_SPACE_ID=` 这个赋值（那个名字是 executor 侧的
    #         env `INSPECT_AGENT_SPACE_ID`；本步骤的变量叫 `DA_SPACE_FOR_SKILLS`），
    #         `if … else ""` 于是把窗口静默变成空串。
    #   长度  2000 字节的预算会随**注释**增删吞掉/放进不相关的段落。
    #   范围  第二版改成「从上传调用起、到顶格 `fi` 为止」，看着对了，实际把
    #         **成功支**也圈了进来：`--verify` 不一致的那条 ⚠、以及「拿不到
    #         space、跳过」的那条都在窗口里。于是把 SILENT/静默 搬到「校验不
    #         一致」那行、把重跑命令也搬进去，**上传失败支一句话都不剩**，两条
    #         判据照样报 OK —— 恰好是本文件存在的理由被绕过去了。
    #
    # 现在按 if/fi 配平切出上传调用那个 `if` 的 else 支，只审计它，并且只看
    # **真正 echo 出去的行** —— 注释里写「静默」不算数，客户看不到注释。
    # ⚠️ 别为了「宽容一点」把窗口放回整块：那两条断言的视野就是这个 list。
    fail_branch = _failure_branch(text, "scripts/upload_inspection_skills.py")
    _check("the upload-failure branch can be sliced out",
           bool(fail_branch),
           "could not match `if <upload>; then … else … fi` -- the checks below "
           "would audit nothing")
    # 切窗自检：`--verify` 那次调用在**成功**支。它出现在窗口里就说明窗口又
    # 张开到了整块，而成功支自带一条 ⚠ 会替失败支把判据顶绿。
    _check("the sliced window excludes the success path",
           bool(fail_branch) and not any("--verify" in ln for ln in fail_branch),
           "the `--verify` invocation belongs to the success branch; seeing it in "
           "the window means the audit widened back to the whole if/else block")
    echoed = [ln.strip() for ln in fail_branch if ln.strip().startswith("echo ")]

    # (1) 失败时必须给出一条能直接粘的重跑命令，**且命令里的参数真实存在**。
    #     2026-08-24 的第一版栽在这里：警告文案给的重跑命令用 `--space-id` /
    #     `--account-id`，而 argparse 只认 `--space` / `--region` / `--dry-run` /
    #     `--verify` / `--all-accounts` → 粘上去 exit 2「unrecognized arguments」，
    #     把人引到同一个错上。所以参数表从 argparse 现读，而不是在这里写死一个
    #     字面量 —— 写死的那个正是上面那条断言自己变陈旧的原因。
    uploader_src = UPLOADER.read_text(encoding="utf-8") if UPLOADER.is_file() else ""
    real_flags = set(re.findall(r'add_argument\(\s*"(--[a-z0-9-]+)"', uploader_src))
    hints = [ln for ln in echoed if "upload_inspection_skills.py" in ln]
    _check("upload failure prints a pasteable re-run command",
           any(re.search(r"python\S*\s+\S*scripts/upload_inspection_skills\.py", ln)
               for ln in hints),
           "must print the manual re-run command on failure; "
           f"echoed lines naming the uploader: {hints}")
    hinted = {f for ln in hints for f in re.findall(r"--[a-z0-9-]+", ln)}
    bogus = sorted(hinted - real_flags)
    _check("every flag in the printed re-run command exists in the uploader",
           bool(real_flags) and not bogus,
           f"{bogus} not in argparse {sorted(real_flags)} -- pasting the printed "
           "command exits 2 on `unrecognized arguments`, so the one recovery "
           "hint the operator gets sends them to the same dead end")

    # (2) 文案必须点明失败是**静默**的：报告照出、run 仍 success，除了这一行
    #     以外没有任何后续信号（见 lambda_inspection_executor/handler.py 的
    #     `parse_failed` 那段说明）。setup.sh 的文案是中英双语的（`t "zh" "en"`），
    #     所以要求**同一条** ⚠ 消息里两侧都说到 —— 只写一侧等于对另一半客户没写。
    # ⚠️ 这里不能直接写中文字面量 —— `scripts/` 在 lint_i18n.py 的 PY_DIRS 内，
    # CJK 字面量会被拦。用码点构造出要找的那个词，绕开 lint 而不是绕开检查。
    _zh_silent = "".join(chr(c) for c in (0x9759, 0x9ED8))   # "silent" in Chinese
    warnings_ = [ln for ln in echoed if "⚠" in ln]
    _check("warning explains the failure is silent",
           any(("SILENT" in ln) and (_zh_silent in ln) for ln in warnings_),
           "a reader must learn that reports still generate without the skills; "
           "both the zh and en halves of the bilingual message must say so")

    print("=" * 72)
    if _failed:
        print(f"FAILED - {len(_failed)} check(s)")
        return 1
    print("OK - all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
