"""一键部署（方式 A）与 `setup.sh`（方式 B）的 web 功能必须**逐条一致**。

为什么需要这条断言
------------------
两条部署路径落地的是**同一个** agent：同一份 `agent-build/.../app` 代码、同一个前端。
它们的差别应该只在「谁把资源建出来」——方式 B 是 `agentcore deploy` + 多个 CDK 栈，
方式 A 是一个 CloudFormation 单栈。可 agent 能做什么，取决于两件运行期事实：

    ① runtime 执行角色有哪些授权
    ② runtime 拿到哪些环境变量

这两件事在两条路径上各写了一份，没有任何一处能 import 另一处：

    ① 方式 B：agent-build/NotiOpsWebChat/agentcore/cdk/lib/cdk-stack.ts 的 NotiOps 段
       方式 A：infra/lib/notiops-webchat-standalone-stack.ts 的 AgentCore Runtime 段
    ② 方式 B：agent-build/NotiOpsWebChat/agentcore/agentcore.json 的 runtimes[].envVars
       方式 A：同上那个栈里 AgentRuntime 的 EnvironmentVariables

漂移的后果**不是**「功能没做」，而是「界面上有开关、点了静默失败」——
UI 上那些开关（联网搜索 / FinOps / 深度调查）绝大多数是**无条件**渲染的
（frontend/chat-app/src/components/Composer.tsx），前端并不知道后端少了一条 IAM。
于是客户看到的是「这个产品时好时坏」，而排查要一路走到 CloudTrail 的 AccessDenied。

已知且**有意**的差异（不体现在本断言比较的两个维度里，故不需要 allowlist）
------------------------------------------------------------------------
  · AgentCore Memory：方式 A 不建 Memory 资源。方式 B 那条授权来自 agentcore CLI 生成的
    默认策略（不在本文件扫的那份源码里），且 grep 过 core/ 与 agent/，没有任何代码读
    MEMORY_* 环境变量 —— 两条路径上都是死权限。
  · 跨账号 AssumeRole：方式 A 把它放进带 Condition 的独立 Policy（只有 MultiAccount 模式
    才存在），方式 B 无条件给。本断言比较的是**动作集合**而非条件，所以两者视作一致 ——
    方式 A 更紧，且单账号模式下本来就没有可 assume 的对象。
  · 联网搜索 Gateway：只有 us-east-1 有这个 API，方式 A 用 CfnCondition 整块跳过。
    `bedrock-agentcore:InvokeGateway` 那条授权两条路径都**无条件**给（授权本身无副作用），
    所以在这里对得上。

Run from repo root::

    python3 scripts/test_oneclick_parity.py

不触网、不读 AWS、不 synth。纯源码断言。
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

PASS = "✅"
FAIL = "❌"
_failed = 0

ONECLICK = "infra/lib/notiops-webchat-standalone-stack.ts"
SETUP_CDK = "agent-build/NotiOpsWebChat/agentcore/cdk/lib/cdk-stack.ts"
SETUP_AGENTCORE_JSON = "agent-build/NotiOpsWebChat/agentcore/agentcore.json"

# 两条路径给同一条授权起了不同的 Sid。不改源码去凑名字（两边的名字在各自上下文里都更贴切），
# 而是在这里显式记一笔：**别名表要带理由**，否则下一个人分不清「别名」和「真的少了一条」。
SID_ALIASES = {
    # 方式 B 的名字 → 方式 A 的名字
    # 都是「到成员账号的 DevOps Agent trigger 角色」，见 core/devops_agent.py `_assume_client`。
    "NotiOpsDevOpsAgentAssume": "AssumeMemberDevOpsAgentTriggerRole",
    # 都是「读 notiops-config」。方式 B 的名字带 ForCrossAccount 是历史包袱：这条授权同时
    # 服务模型目录 / RBAC 读取，并不只为跨账号，所以方式 A 的名字才是对的。
    "ReadNotiOpsConfigForCrossAccount": "ReadNotiOpsConfig",
}

# runtime 执行角色的授权段。两个 marker 都是文件里的章节注释 —— 挑它们而不是行号，
# 是因为行号会随任何编辑漂移，而章节注释改动时提取器会**失败**（见 main 的兜底）。
ONECLICK_IAM_SCOPE = ("// ══ AgentCore Runtime（同栈资源）", "// ══ Web Chat 主体")
SETUP_IAM_SCOPE = ("// ── NotiOps：给所有 runtime 执行角色授予", "// Create AgentCoreMcp")


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


def _scope(rel: str, start: str, end: str) -> str:
    src = _read(rel)
    i = src.find(start)
    if i < 0:
        raise AssertionError(f"{rel}: could not find scope start {start!r}")
    j = src.find(end, i)
    if j < 0:
        raise AssertionError(f"{rel}: could not find scope end {end!r} after the start marker")
    return src[i:j]


def _strip_comments(text: str) -> str:
    """剥掉注释。必须剥：注释里会引用动作名和 Sid（本文件自己就是例子），
    不剥就会把「解释得清楚」当成「多给了权限」。"""
    out = []
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith(("//", "*", "/*")):
            continue
        out.append(re.sub(r"//.*$", "", line))
    return "\n".join(out)


# 只认**带引号**的 `service:Action` —— 裸文本匹配会把注释里的动作名也捞进来。
_ACTION_RE = re.compile(r"""['"]([a-z0-9-]+:[A-Za-z*]+)['"]""")
_SID_RE = re.compile(r"""sid:\s*['"]([A-Za-z0-9]+)['"]""")


def statements(rel: str, scope: tuple[str, str]) -> dict[str, set[str]]:
    """Sid → 动作集合。按 `sid:` 切段：段内引号里的 `service:Action` 都算这条语句的动作。

    没有 Sid 的语句（两条路径各有几条基础授权，方式 B 那几条还根本不在这份源码里 ——
    它们由 agentcore CLI 生成）无法配对，直接忽略。这条断言守的是**我们自己写的**那些
    带 Sid 的语句，那也正是历史上漂移过的地方。
    """
    text = _strip_comments(_scope(rel, *scope))
    parts = _SID_RE.split(text)
    if len(parts) < 3:
        raise AssertionError(f"{rel}: no sid'd policy statements found in scope — did the shape change?")
    out: dict[str, set[str]] = {}
    for i in range(1, len(parts), 2):
        sid, body = parts[i], parts[i + 1]
        # 同名 Sid 出现两次就是 bug（IAM 里 Sid 必须唯一），合并而不是覆盖，让差异暴露出来。
        out.setdefault(sid, set()).update(_ACTION_RE.findall(body))
    return out


def _covers(granted: set[str], action: str) -> bool:
    """`granted` 是否覆盖 `action` —— 通配符感知。

    两条路径写法不完全一样：一边写 `ce:List*`，另一边把 `ce:ListCostAllocationTags` 单列。
    按字面比较会把这种**等价**写法报成差异，那种噪音一多，断言就会被人关掉。
    """
    return any(fnmatch.fnmatchcase(action, pattern) for pattern in granted)


def _env_keys_oneclick() -> set[str]:
    """AgentRuntime 的 `EnvironmentVariables` 里的键。按花括号深度取第一层，
    不依赖缩进（缩进会随重构变，而这条断言不该因为格式化而挂）。"""
    src = _read(ONECLICK)
    i = src.find("EnvironmentVariables: {")
    if i < 0:
        raise AssertionError(f"{ONECLICK}: no EnvironmentVariables block on the AgentRuntime resource")
    start = src.index("{", i)
    depth, end = 0, None
    for k in range(start, len(src)):
        if src[k] == "{":
            depth += 1
        elif src[k] == "}":
            depth -= 1
            if depth == 0:
                end = k
                break
    if end is None:
        raise AssertionError(f"{ONECLICK}: unterminated EnvironmentVariables block")

    keys: set[str] = set()
    depth = 0
    for line in _strip_comments(src[start:end]).splitlines():
        if depth == 1:
            m = re.match(r"\s*([A-Z][A-Z0-9_]*)\s*:", line)
            if m:
                keys.add(m.group(1))
        depth += line.count("{") - line.count("}")
    return keys


def _env_keys_setup() -> set[str]:
    data = json.loads(_read(SETUP_AGENTCORE_JSON))
    keys = {
        ev["name"]
        for rt in data.get("runtimes", [])
        for ev in rt.get("envVars", [])
        if ev.get("name")
    }
    if not keys:
        raise AssertionError(f"{SETUP_AGENTCORE_JSON}: no runtimes[].envVars[].name found")
    return keys


def test_runtime_role_grants_match() -> None:
    """两条路径的 runtime 执行角色，带 Sid 的授权必须**互相覆盖**。"""
    print("test_runtime_role_grants_match")
    setup_raw = statements(SETUP_CDK, SETUP_IAM_SCOPE)
    oneclick = statements(ONECLICK, ONECLICK_IAM_SCOPE)
    # 别名归一到方式 A 的名字（方式 A 是新写的那份，命名也更贴切）。
    setup = {SID_ALIASES.get(sid, sid): actions for sid, actions in setup_raw.items()}

    _check("both paths declare a non-trivial set of sid'd statements",
           len(setup) >= 5 and len(oneclick) >= 5,
           f"setup.sh: {len(setup)}, one-click: {len(oneclick)}")

    missing_in_oneclick = sorted(set(setup) - set(oneclick))
    _check("one-click has every statement setup.sh has",
           not missing_in_oneclick,
           "the one-click deployment is missing these grants entirely "
           f"(UI shows the feature, clicking it fails silently): {missing_in_oneclick}")

    missing_in_setup = sorted(set(oneclick) - set(setup))
    _check("setup.sh has every statement one-click has",
           not missing_in_setup,
           f"only the one-click path grants these: {missing_in_setup}")

    for sid in sorted(set(setup) & set(oneclick)):
        gap_a = sorted(a for a in setup[sid] if not _covers(oneclick[sid], a))
        gap_b = sorted(a for a in oneclick[sid] if not _covers(setup[sid], a))
        _check(f"{sid}: same actions on both paths",
               not gap_a and not gap_b,
               f"only via setup.sh: {gap_a}; only via one-click: {gap_b}")


def test_runtime_env_keys_match() -> None:
    """两条路径注入 runtime 的环境变量**键集合**必须相同。

    只比键、不比值：值本来就该不同（一边是 shell 算出来的字面量，一边是 CFN 的 GetAtt）。
    少一个键的症状同样是静默的 —— agent 侧一律 `os.environ.get(..., "")`，
    于是那个能力就「无声地不存在」（联网搜索、报告 CDN、跨账号闸门都是这么坏过的）。
    """
    print("test_runtime_env_keys_match")
    setup, oneclick = _env_keys_setup(), _env_keys_oneclick()
    _check("env key sets are non-trivial", len(setup) >= 3 and len(oneclick) >= 3,
           f"setup.sh: {sorted(setup)}, one-click: {sorted(oneclick)}")
    _check("one-click injects every env key setup.sh injects",
           not (setup - oneclick),
           f"missing from the one-click runtime: {sorted(setup - oneclick)}")
    _check("setup.sh injects every env key one-click injects",
           not (oneclick - setup),
           f"only in the one-click runtime: {sorted(oneclick - setup)}")


def main() -> int:
    print("=" * 72)
    print("方式 A（一键部署）与方式 B（setup.sh）的 web 功能一致性")
    print("=" * 72)
    try:
        test_runtime_role_grants_match()
        test_runtime_env_keys_match()
    except AssertionError as e:
        # 提取器找不到目标 = 有人改了源码的形态。必须失败而不是静默通过 ——
        # 静默通过的断言比没有断言更糟：它让人以为这件事有人守着。
        print(f"  {FAIL} extractor failed: {e}")
        print("\n提取器依赖那两份源码里的章节注释与声明写法。若你改了它们，"
              "请同步更新本文件的提取器，别把断言删掉。")
        return 1
    print("\n" + "=" * 72)
    if _failed:
        print(f"{FAIL} {_failed} 项失败")
        print("\n新增 web 功能时**两条路径都要落地**。只在一条路径上加，"
              "客户看到的就是「界面有开关、点了没反应」。")
        return 1
    print(f"{PASS} 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
