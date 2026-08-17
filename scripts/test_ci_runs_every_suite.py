"""CI 必须真的执行 `scripts/` 下的每一套自检脚本。

为什么需要这条断言
------------------
`.gitlab-ci.yml` 里的 job **逐个点名**要跑哪些脚本，没有任何 glob 兜底。于是「写一套
测试」和「这套测试会被执行」是两件独立的事，而两者的差别在本地完全不可见 —— 本地
`for s in ...; do python3 scripts/test_$s.py; done` 一路全绿，CI 也全绿，但 CI 跑的是
另一个子集。

这不是假设。一次交叉 review 发现有 **5 套**脚本写了却从未在 CI 执行过，其中两套的缺席
直接改变了当时的风险判断：

  · `test_secret_grants_scoped.py` —— 曾有一个决定：**不做** call_aws 子进程降权，
    理由是「改为加一条 CI 断言守住 Secret 授权必须按资源收窄」。那条补偿性控制没进 CI，
    于是那次「风险可接受」的结论建立在一个不存在的前提上。
  · `test_openai_responses_sanitizer.py` —— 2026-06-05 协议碎片与赌博垃圾词泄漏到用户
    眼前那次事故的回归防线。

一套写好却不执行的测试比没有测试更糟：它让人以为这件事有人守着。

例外机制
--------
确有理由不进 CI 的脚本（需要真实 AWS 凭证、需要网络、跑得特别久）登记进 `_EXEMPT`，
**并写明原因**。空着理由不算登记 —— 那和忘了加是一样的。

Run from repo root::

    PYTHONPATH=. python3 scripts/test_ci_runs_every_suite.py

不触网。纯源码断言。
"""
from __future__ import annotations

import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

PASS = "✅"
FAIL = "❌"
_failed = 0

CI_FILE = os.path.join(ROOT, ".gitlab-ci.yml")
SCRIPTS_DIR = os.path.join(ROOT, "scripts")

# 允许不在 CI 里的脚本 → 原因。原因为空视为未登记。
_EXEMPT: dict[str, str] = {
    # 本文件自身：它断言的对象是 CI 配置，加进 CI 会形成自指但无害；仍然登记，
    # 免得「本文件不在 CI 里」被当成它要报的那种缺失。
    "test_ci_runs_every_suite.py":
        "元断言，由 llm-catalog-tests 显式调用；见下方 _check_self_is_wired",
    # 需要真实 AWS 凭证 + 网络（打 Bedrock / MCP 端点），CI 容器里没有。
    "test_aws_docs_mcp.py":
        "需要真实网络访问 AWS 文档 MCP 端点；已由 docs job 单独调用",
}


def _check(label: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {label}")
    else:
        _failed += 1
        print(f"  {FAIL} {label}{(' :: ' + detail) if detail else ''}")


def _ci_text() -> str:
    with open(CI_FILE, encoding="utf-8") as fh:
        return fh.read()


def _ci_invoked() -> set[str]:
    """CI 里真正被**执行**的脚本名。

    只认 `- python3 scripts/test_x.py` 这种 script 行；`rules.changes` 下面的
    `scripts/test_*.py` 是**触发条件**，决定 job 跑不跑，不决定跑什么 —— 把它当成
    「已覆盖」正是当初漏掉 5 套的原因。
    """
    invoked: set[str] = set()
    for line in _ci_text().splitlines():
        stripped = line.strip()
        if not stripped.startswith("-"):
            continue
        m = re.search(r"python3?\s+(?:-m\s+\S+\s+)?scripts/(test_[a-z0-9_]+\.py)", stripped)
        if m:
            invoked.add(m.group(1))
    return invoked


def _local_suites() -> set[str]:
    return {f for f in os.listdir(SCRIPTS_DIR)
            if f.startswith("test_") and f.endswith(".py")}


def test_every_suite_is_invoked() -> None:
    print("test_every_suite_is_invoked")
    local = _local_suites()
    invoked = _ci_invoked()
    _check("CI invokes a non-trivial number of suites", len(invoked) >= 15,
           f"found {len(invoked)}")

    missing = sorted(local - invoked - set(_EXEMPT))
    _check("every scripts/test_*.py is invoked by CI (or exempted with a reason)",
           not missing,
           "written but never executed in CI: " + ", ".join(missing))

    # 登记了但没写原因 = 没登记
    blank = sorted(k for k, v in _EXEMPT.items() if not (v or "").strip())
    _check("every exemption states a reason", not blank, str(blank))

    # 登记了却其实不存在的脚本 → 清理掉，免得豁免名单变成垃圾场
    stale = sorted(set(_EXEMPT) - local)
    _check("no exemption points at a missing file", not stale, str(stale))


def test_exempt_suites_are_not_silently_broken() -> None:
    """豁免的脚本至少要能 import —— 否则它连"手动能跑"都不成立。"""
    print("test_exempt_suites_are_not_silently_broken")
    import ast
    for name in sorted(_EXEMPT):
        path = os.path.join(SCRIPTS_DIR, name)
        if not os.path.exists(path):
            continue                       # 上面那条已经报了
        try:
            with open(path, encoding="utf-8") as fh:
                ast.parse(fh.read())
            ok, detail = True, ""
        except SyntaxError as e:            # noqa: PERF203
            ok, detail = False, str(e)
        _check(f"{name} parses", ok, detail)


def test_node_suites_are_wired() -> None:
    """`bff/web-chat/tests/*.test.mjs` 必须被 package.json 的 test 脚本执行。

    与上面同一类缺陷，只是换了语言：`npm test` 也是**逐个点名**（`node tests/a.mjs &&
    node tests/b.mjs && ...`），没有 glob 兜底。新写一个 .test.mjs 忘了加进去，本地
    单独跑全绿、CI 也全绿 —— 因为 CI 根本没跑它。

    真实来由：把三条 BFF 断言从 Python 的 `subprocess.run(["node", ...])` 搬回 node
    侧时（CI 的 python:3.12-slim 里没有 node，那几条一直在 FileNotFoundError），新建了
    llmcfg_disabled.test.mjs。若漏了改 package.json，那三条就从"崩掉 job"变成"静默
    消失" —— 后者更糟。
    """
    print("test_node_suites_are_wired")
    tests_dir = os.path.join(ROOT, "bff", "web-chat", "tests")
    pkg = os.path.join(ROOT, "bff", "web-chat", "package.json")
    if not os.path.isdir(tests_dir) or not os.path.exists(pkg):
        _check("bff/web-chat tests dir and package.json exist", False,
               "layout changed; update this assertion")
        return
    import json as _json
    with open(pkg, encoding="utf-8") as fh:
        script = (_json.load(fh).get("scripts") or {}).get("test") or ""
    local = sorted(f for f in os.listdir(tests_dir) if f.endswith(".test.mjs"))
    _check("a non-trivial number of node suites exist", len(local) >= 4,
           f"found {len(local)}")
    missing = [f for f in local if f not in script]
    _check("every bff/web-chat/tests/*.test.mjs is in the npm test script",
           not missing,
           "written but never executed by `npm test`: " + ", ".join(missing))


def test_self_is_wired() -> None:
    """本文件必须被 CI 显式调用，否则这条元断言自己也是"写了不跑"。"""
    print("test_self_is_wired")
    _check("CI invokes this meta-assertion",
           "test_ci_runs_every_suite.py" in _ci_invoked(),
           "add `- python3 scripts/test_ci_runs_every_suite.py` to .gitlab-ci.yml")


def main() -> int:
    print("=" * 72)
    print("CI 是否真的执行每一套自检脚本")
    print("=" * 72)
    test_every_suite_is_invoked()
    test_exempt_suites_are_not_silently_broken()
    test_node_suites_are_wired()
    test_self_is_wired()
    print("\n" + "=" * 72)
    if _failed:
        print(f"{FAIL} {_failed} 项失败")
        return 1
    print(f"{PASS} 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
