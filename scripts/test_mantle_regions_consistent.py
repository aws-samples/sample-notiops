"""Bedrock Mantle 区域名单在五处副本之间必须自洽。

为什么需要这条断言
------------------
Mantle 端点按区寻址（`bedrock-mantle.<region>.api.aws`），而「哪些区可用」这件事在本仓库
里被写了五遍，分属三种运行时（Node / Python / TypeScript-CDK）+ 一个 shell 脚本，没有
任何一处能 import 另一处。它们的角色不同，因此约束**不是**「全部相等」：

    ① bff/web-chat/llm_config.mjs::MANTLE_REGIONS
       —— Admin 能**保存**的区域白名单。这是权威集合（取自 Responses API 文档的
          "Supported Regions and Endpoints"），也是本断言的基准。
    ② shared/llm_provider.py::_MANTLE_REGIONS
       —— 后端任务（PHD 翻译 / 报告精简）拼 hostname 前的校验。必须 **== ①**，
          否则出现「这边存得进去、那边调不出去」。
    ③ agent-build/.../agentcore/cdk/lib/cdk-stack.ts::MANTLE_REGIONS
       —— AgentCore runtime 执行角色的 IAM 资源 ARN。必须 **⊇ ①**。
    ④ scripts/grant_mantle_permissions.sh
       —— ③ 的手动补救路径。必须 **== ③**，否则两条部署路径给出不同权限。
    ⑤ 默认区域常量（BFF / Python / 前端各一份）必须同值，且 **∈ ①**。

真实事故（这条断言就是为它写的）
--------------------------------
名单最初只有 us-east-2 / us-west-2。后来 ① 按文档扩到 14 个区，而 ③ ④ 没跟着改，
于是：

    管理员从候选列表加一个 GPT 模型
      → 前端取 `regions[0]`，而扩容后排第一的是 us-east-1（原先是 us-east-2）
      → validateConfig 放行（us-east-1 确实在白名单里）
      → 保存时的连通性探测**也放行** —— 那次探测用的是 **BFF** 的角色，
        而 BFF 那条策略是 resources:["*"]，全区都通
      → 真正发消息时是 **runtime** 的角色在调，它只有 us-east-2/us-west-2 → 403

配置存得进去、调不出去，而且要到用户发消息才暴露。三处各自都「看起来合理」，
错误只存在于它们的**关系**里 —— 所以只能用一条跨文件断言来守。

Run from repo root::

    PYTHONPATH=. python3 scripts/test_mantle_regions_consistent.py

不触网、不读 AWS。纯源码断言。
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

BFF = "bff/web-chat/llm_config.mjs"
PY_PROVIDER = "shared/llm_provider.py"
CDK = "agent-build/NotiOpsWebChat/agentcore/cdk/lib/cdk-stack.ts"
SH = "scripts/grant_mantle_permissions.sh"
FRONTEND = "frontend/chat-app/src/components/AdminPanel.tsx"


def _check(label: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {label}")
    else:
        _failed += 1
        print(f"  {FAIL} {label}{(' :: ' + detail) if detail else ''}")


def _read(rel: str) -> str:
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


# 形如 region 的 token。刻意不接受任意字符串：注释里出现的 "us-east-2" 也会被捞到，
# 所以每个提取器都先把作用域缩到那段字面量里，再在里面找 token。
_REGION_RE = re.compile(r"\b([a-z]{2}(?:-gov)?-[a-z]+-\d)\b")


def _block(src: str, start_pat: str, end: str, what: str) -> str:
    """截取从 `start_pat` 到下一个 `end` 之间的文本（作用域限定，避免捞到注释里的区域名）。"""
    m = re.search(start_pat, src)
    if not m:
        raise AssertionError(f"could not locate {what} (pattern: {start_pat})")
    tail = src[m.end():]
    i = tail.find(end)
    if i < 0:
        raise AssertionError(f"unterminated {what}")
    return tail[:i]


def bff_regions() -> set[str]:
    return set(_REGION_RE.findall(
        _block(_read(BFF), r"const MANTLE_REGIONS = new Set\(\[", "]", "BFF MANTLE_REGIONS")))


def py_regions() -> set[str]:
    return set(_REGION_RE.findall(
        _block(_read(PY_PROVIDER), r"_MANTLE_REGIONS = frozenset\(\{", "}",
               "shared/llm_provider._MANTLE_REGIONS")))


def cdk_regions() -> set[str]:
    return set(_REGION_RE.findall(
        _block(_read(CDK), r"const MANTLE_REGIONS = \[", "]", "CDK MANTLE_REGIONS")))


def sh_regions() -> set[str]:
    """shell 脚本里的 ARN 列表。只取 bedrock-mantle ARN 的 region 段，避开脚本别处的默认区。"""
    return set(re.findall(r"arn:aws:bedrock-mantle:([a-z0-9-]+):", _read(SH)))


def _named_default(src: str, pat: str, what: str) -> str:
    m = re.search(pat, src)
    if not m:
        raise AssertionError(f"could not locate {what}")
    return m.group(1)


def test_allowlist_copies_agree() -> None:
    """① 与 ② 必须逐一相等 —— 两者都是「能不能用这个区」的校验，不是权限。"""
    print("test_allowlist_copies_agree")
    bff, py = bff_regions(), py_regions()
    _check("BFF allowlist is non-trivial", len(bff) >= 3, str(sorted(bff)))
    _check("BFF == shared/llm_provider (save-side vs backend-task side)",
           bff == py,
           f"only in BFF: {sorted(bff - py)}; only in python: {sorted(py - bff)}")


def test_iam_covers_the_whole_allowlist() -> None:
    """③ 必须 ⊇ ①。窄于白名单 = 存得进去、调不出去（且到发消息才暴露）。"""
    print("test_iam_covers_the_whole_allowlist")
    bff, cdk = bff_regions(), cdk_regions()
    missing = sorted(bff - cdk)
    _check("AgentCore runtime IAM covers every saveable region",
           not missing,
           f"admin can save these but the runtime role cannot invoke them: {missing}")


def test_manual_grant_script_matches_cdk() -> None:
    """④ == ③。两条部署路径给出不同权限的话，症状取决于「上次是谁跑的」。"""
    print("test_manual_grant_script_matches_cdk")
    cdk, sh = cdk_regions(), sh_regions()
    _check("grant_mantle_permissions.sh == cdk-stack.ts",
           cdk == sh,
           f"only in CDK: {sorted(cdk - sh)}; only in script: {sorted(sh - cdk)}")


def test_default_region_is_named_and_allowlisted() -> None:
    """⑤ 三处默认区同值且在白名单内；并且**不得**靠下标从名单里取。"""
    print("test_default_region_is_named_and_allowlisted")
    bff_src, fe_src = _read(BFF), _read(FRONTEND)
    bff_def = _named_default(
        bff_src, r'const MANTLE_REGION_DEFAULT = "([a-z0-9-]+)"', "BFF MANTLE_REGION_DEFAULT")
    py_def = _named_default(
        _read(PY_PROVIDER), r'_MANTLE_REGION_DEFAULT = "([a-z0-9-]+)"',
        "python _MANTLE_REGION_DEFAULT")
    fe_def = _named_default(
        fe_src, r'const MANTLE_REGION_FALLBACK = "([a-z0-9-]+)"',
        "frontend MANTLE_REGION_FALLBACK")
    _check("BFF / python / frontend defaults agree",
           bff_def == py_def == fe_def, f"{bff_def} / {py_def} / {fe_def}")
    _check("the default region is itself allowlisted",
           bff_def in bff_regions(), bff_def)

    # 位置依赖是这次事故的直接原因：名单按区域名排序，扩容时谁排第一会变。
    # 扫描前先剥注释：解释「为什么不能用 regions[0]」的注释里必然出现这个串，
    # 裸文本扫描会把它当成违规本身 —— 那等于惩罚把原因写清楚的人。
    code_only = "\n".join(
        line for line in fe_src.splitlines()
        if not line.lstrip().startswith(("//", "*", "/*")))
    _check("frontend does not take the default from regions[0]",
           "regions?.[0]" not in code_only and "regions[0]" not in code_only,
           "AdminPanel still derives a default region positionally")


def main() -> int:
    print("=" * 72)
    print("Bedrock Mantle 区域名单跨文件一致性")
    print("=" * 72)
    try:
        test_allowlist_copies_agree()
        test_iam_covers_the_whole_allowlist()
        test_manual_grant_script_matches_cdk()
        test_default_region_is_named_and_allowlisted()
    except AssertionError as e:
        # 提取器找不到目标 = 有人改了声明形态。必须失败而不是静默通过 ——
        # 静默通过的断言比没有断言更糟：它会让人以为这件事有人守着。
        print(f"  {FAIL} extractor failed: {e}")
        print("\n提取器依赖各文件里那几个声明的字面形态。若你改了声明写法，"
              "请同步更新本文件的提取器，别把断言删掉。")
        return 1
    print("\n" + "=" * 72)
    if _failed:
        print(f"{FAIL} {_failed} 项失败")
        return 1
    print(f"{PASS} 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
