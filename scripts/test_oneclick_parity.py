"""一键部署（方式 A）与 `setup.sh`（方式 B）的 web 功能必须**逐条一致**。

为什么需要这条断言
------------------
两条部署路径落地的是**同一个** agent：同一份 `agent-build/.../app` 代码、同一个前端。
它们的差别应该只在「谁把资源建出来」——方式 B 是 `agentcore deploy` + 多个 CDK 栈，
方式 A 是一个 CloudFormation 单栈。可客户看到的产品是什么样，取决于这几件事：

    ① runtime 执行角色有哪些授权
    ② runtime 拿到哪些环境变量
    ③ 部署时往 DynamoDB 写了哪些出厂数据（模型目录等）
    ④ runtime 的生命周期设置（保温多久 / 最长活多久）
    ⑤ 「通知」生产端（AWS 事件 → Web 收件箱）建没建、订了哪些事件源

①②④ 是运行期行为，③ 是部署期数据 —— 三者在两条路径上各写了一份，没有任何一处能
import 另一处；⑤ 反过来：它现在**只有一份**，两个栈 import 同一个模块，本文件断言的
是「没有人把它抄回栈里」（见那一节的注释）。

    ① 方式 B：agent-build/NotiOpsWebChat/agentcore/cdk/lib/cdk-stack.ts 的 NotiOps 段
       方式 A：infra/lib/notiops-webchat-standalone-stack.ts 的 AgentCore Runtime 段
    ② 方式 B：agent-build/NotiOpsWebChat/agentcore/agentcore.json 的 runtimes[].envVars
       方式 A：同上那个栈里 AgentRuntime 的 EnvironmentVariables
    ③ 方式 B：setup.sh 里的 `scripts/seed_*.py` 与 `dynamodb put-item`
       方式 A：infra/lambda/stager/index.py 的 Site 阶段
    ④ 方式 B：agentcore.json 的 runtimes[].lifecycleConfig（+ backfill_runtime_env.sh 的
       SET_IDLE 默认值，deploy_agent.sh 部署后靠它强制回填）
       方式 A：同上那个栈里 AgentRuntime 的 LifecycleConfiguration
    ⑤ 两条路径都 import infra/lib/constructs/web-notif-sources.ts
       方式 B：notiops-backend-stack.ts 建 Lambda（复用 IM push 的 asset）+ 10 条规则
       方式 A：notiops-webchat-standalone-stack.ts 建 Lambda（代码走 web-notif.zip 产物）
       + 10 条规则

漂移的后果**不是**「功能没做」，而是「界面上有开关、点了静默失败」——
UI 上那些开关（联网搜索 / FinOps / 深度调查）绝大多数是**无条件**渲染的
（frontend/chat-app/src/components/Composer.tsx），前端并不知道后端少了一条 IAM。
于是客户看到的是「这个产品时好时坏」，而排查要一路走到 CloudTrail 的 AccessDenied。

已知且**有意**的差异（不体现在 ①② 两个维度里，故不需要 allowlist；③ 的排除项
带理由记在 `SEED_CLASSIFICATION` 里）
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


# ─────────────────────────── 第三个维度：部署期数据种子 ───────────────────────────
#
# 前两条断言守的是 **runtime 的能力**（IAM + env）。它们结构上守不到第三类漂移：
# **部署时往 DynamoDB 写的出厂数据**。实测撞到过一次 —— 一键路径从来不写模型目录
# （`PK=llmcfg / SK=meta`），于是方式 A 部署出来的环境里，「管理 → 模型」是一张**空表**，
# 连打包进程序的默认模型都不显示；而聊天照常能用（前端有内置兜底目录），所以
# 这个缺陷不报错、不写日志，只能靠人打开那一页才发现（实测 2026-08-26）。
#
# 这一节的做法是**发现 + 分类**，而不是只写死一张对照表：
#   ① 从 `setup.sh` 里**发现**每一处写 DynamoDB 出厂数据的地方；
#   ② 每一处都必须在下面这张表里被显式分类 —— 要么"一键路径也做了（附机器判据）"，
#      要么"故意不做（附理由）"。新加一个 seed 而不分类 = 本断言直接挂。
# 少了 ② 的话，这张表就会随时间变成一份**看着完整、其实过期**的清单。
SETUP_SH = "setup.sh"
STAGER = "infra/lambda/stager/index.py"

# `aws dynamodb put-item --item "{\"PK\":{\"S\":\"...\"}"` 里的 PK 字面量。
_PUT_ITEM_PK_RE = re.compile(r'dynamodb put-item\b[^\n]*\n?[^\n]*?\\"PK\\":\s*\{\\"S\\":\\"([^\\$#]+)')
# `scripts/seed_*.py` 形式的种子脚本（回显文案里也会命中，无所谓 —— 取的是集合）。
_SEEDER_RE = re.compile(r"scripts/(seed_[a-z0-9_]+\.py)")


def _setup_seeds() -> set[str]:
    src = _read(SETUP_SH)
    found = set(_SEEDER_RE.findall(src)) | set(_PUT_ITEM_PK_RE.findall(src))
    if not found:
        raise AssertionError(
            f"{SETUP_SH}: found no DynamoDB seeds at all — the extractor stopped "
            "matching. Fix the regexes; do not delete the assertion.")
    return found


def _oneclick_seeds_llm_catalog() -> list[str]:
    """一键路径是否真的落地了模型目录种子。返回缺失项的说明列表（空 = 通过）。"""
    stack, stager = _read(ONECLICK), _read(STAGER)
    seeder = _read("scripts/seed_llm_catalog.py")
    gaps = []
    for label, cond in (
        # 模板里内联的必须是**同一份**目录文件 —— 方式 B 的 seeder 读的也是它。
        ("the stack inlines config/llm-model-catalog.json at synth time",
         "llm-model-catalog.json" in stack and "llm-model-catalog.json" in seeder),
        ("the catalogue is passed to the Site phase as LlmCatalog",
         re.search(r"LlmCatalog:\s*llmCatalogJson", stack) is not None),
        ("the Site phase is told which table to write to",
         re.search(r"ConfigTable:\s*base\.configTable\.tableName", stack) is not None),
        ("the stager role may PutItem on the config table",
         re.search(r'sid:\s*"SeedLlmCatalog"', stack) is not None
         and "dynamodb:PutItem" in stack),
        ("the stager defines the seeder", "def _seed_llm_catalog(" in stager),
        # 定义了但没调用 = 静默不生效，正是这一节要防的那类缺陷。
        ("the Site phase actually calls it",
         re.search(r"_seed_llm_catalog\(props\)", _strip_comments(stager)) is not None),
        ("it writes PK=llmcfg / SK=meta", '"PK": "llmcfg"' in stager and '"SK": "meta"' in stager),
        # 条件写：升级一次栈不能把管理员在控制台里改过的目录打回出厂值。
        # 两条路径必须口径一致，否则"升级"在一条路径上是无害的、在另一条是破坏性的。
        ("the write is conditional on both paths",
         "attribute_not_exists(PK)" in stager and "attribute_not_exists(PK)" in seeder),
        # 条件写让「已存在」成为每次升级的常态路径，所以两条路径都必须在那一支里把
        # **后来新增的模型**补上（只增不改，且只在 generation==0 时）。少了这一步，
        # 首次部署之后加进目录的模型永远到不了那个环境 —— 不报错，只是管理台「模型」页
        # 和模型选择器里少一个（2026-08-27 现网的 zai-glm-5 就是这么丢的）。
        # 一条路径补、另一条不补，等于同一个客户换种装法就少几个模型。
        ("both paths top up models added after the first deploy",
         "generation = :zero" in stager and "generation = :zero" in seeder
         and "merge_missing_models" in stager and "merge_missing_models" in seeder),
        # 补的那一步要读+改，一键路径的 stager role 得有对应权限；只给 PutItem 的话
        # 这条分支会以 AccessDenied 让整栈升级失败（比静默少一个模型更响，但同样是缺陷）。
        ("the stager role may read and update the config item too",
         "dynamodb:GetItem" in stack and "dynamodb:UpdateItem" in stack),
    ):
        if not cond:
            gaps.append(label)
    return gaps


# setup.sh 的每个 seed → 它在方式 A 上的落点（带机器判据），或显式的排除理由。
SEED_CLASSIFICATION: dict[str, tuple[str, str]] = {
    "seed_llm_catalog.py": (
        "oneclick",
        "模型目录（PK=llmcfg / SK=meta）→ StagerSite 的 LlmCatalog 属性 + "
        "stager 的 _seed_llm_catalog()",
    ),
    "cur-athena-status": (
        "excluded",
        "CUR-Athena 成本明细**整块不在一键部署范围内**（它要建 CUR 报告、Athena "
        "workgroup、还要排一个 T+25h 的一次性 Scheduler，跨越计费与数据分析两个面）。"
        "这不是漏做：README 对客那句『不含 … CUR-Athena』就是在说它，"
        "所以缺这一条不构成两条路径的功能差异。",
    ),
}


def test_deploy_time_seeds_match() -> None:
    """`setup.sh` 写的每一条出厂数据，一键路径要么也写、要么有明说的理由不写。"""
    print("test_deploy_time_seeds_match")
    found = _setup_seeds()

    unclassified = sorted(found - set(SEED_CLASSIFICATION))
    _check("every seed in setup.sh is classified", not unclassified,
           "这些 seed 没在 SEED_CLASSIFICATION 里登记 —— 一键部署很可能压根没写它们，"
           f"而症状是静默的（页面上是空的，不报错）：{unclassified}")

    stale = sorted(set(SEED_CLASSIFICATION) - found)
    _check("the classification table has no stale entries", not stale,
           f"setup.sh 里已经找不到这些 seed 了，表该清理：{stale}")

    for key, (kind, note) in sorted(SEED_CLASSIFICATION.items()):
        if kind != "oneclick":
            print(f"  ➖ {key}: 故意不做 —— {note}")
            continue
        gaps = _oneclick_seeds_llm_catalog() if key == "seed_llm_catalog.py" else [
            f"no machine check written for {key}"]
        _check(f"{key}: the one-click path seeds it too", not gaps, "; ".join(gaps))


# ──────────────────── 第四个维度：runtime 生命周期（保温时长） ────────────────────
#
# 为什么它单独算一个维度：AgentCore 的 idle 默认值是 **900 秒**，而 NotiOps 要的是
# 1 小时。这个数字不属于 IAM、不属于 env、也不是 DynamoDB 里的数据 —— 前三条断言
# 结构上都看不见它。而它漂移的症状同样是「产品变差但不报错」：用户离开十几分钟回来
# 提问就吃一次冷启动（~30s），只能靠 BFF 那句「再发一次」兜。
#
# 两条路径各写了一份，谁也 import 不了谁：
#   · 方式 B：agentcore.json 的 runtimes[].lifecycleConfig（`agentcore deploy` 读它），
#     外加 scripts/backfill_runtime_env.sh 的 SET_IDLE 默认值（deploy_agent.sh 部署后
#     强制回填走的是这个默认值）。
#   · 方式 A：本栈 AgentRuntime 的 LifecycleConfiguration（原生 CFN 属性，非 createOnly，
#     可原地更新；这条路径部署后**不再**调 update-agent-runtime，模板即最终值）。
# 三处必须是同一个数。
LIFECYCLE_FIELDS = {  # 方式 B 的键（camelCase）→ 方式 A 的键（CFN 的 PascalCase）
    "idleRuntimeSessionTimeout": "IdleRuntimeSessionTimeout",
    "maxLifetime": "MaxLifetime",
}
BACKFILL = "scripts/backfill_runtime_env.sh"


def _lifecycle_oneclick() -> dict[str, int]:
    text = _strip_comments(_read(ONECLICK))
    i = text.find("LifecycleConfiguration: {")
    if i < 0:
        raise AssertionError(
            f"{ONECLICK}: the AgentRuntime has no LifecycleConfiguration — without it "
            "AgentCore falls back to a 900s idle timeout (see the block's comment).")
    body = text[text.index("{", i) : text.index("}", i)]
    out = {}
    for camel, pascal in LIFECYCLE_FIELDS.items():
        m = re.search(rf"\b{pascal}\s*:\s*(\d+)", body)
        if m:
            out[camel] = int(m.group(1))
    return out


def _lifecycle_setup() -> dict[str, int]:
    runtimes = json.loads(_read(SETUP_AGENTCORE_JSON)).get("runtimes") or []
    cfg = (runtimes[0] if runtimes else {}).get("lifecycleConfig")
    if not cfg:
        raise AssertionError(
            f"{SETUP_AGENTCORE_JSON}: runtimes[0].lifecycleConfig is missing — "
            "`agentcore deploy` would then take AgentCore's 900s default.")
    return {k: int(v) for k, v in cfg.items() if k in LIFECYCLE_FIELDS}


def _backfill_default_idle() -> int:
    m = re.search(r'^SET_IDLE="\$\{SET_IDLE-(\d+)\}"', _read(BACKFILL), re.M)
    if m is None:
        raise AssertionError(
            f"{BACKFILL}: could not read the SET_IDLE default — this script is what "
            "deploy_agent.sh relies on to force the idle timeout after deploy.")
    return int(m.group(1))


def test_runtime_lifecycle_matches() -> None:
    """两条路径给 runtime 声明的 idle / 最长寿命必须**逐字段相等**。"""
    print("test_runtime_lifecycle_matches")
    setup, oneclick = _lifecycle_setup(), _lifecycle_oneclick()

    for camel in LIFECYCLE_FIELDS:
        _check(f"both paths declare {camel}",
               camel in setup and camel in oneclick,
               f"setup.sh: {setup.get(camel)!r}, one-click: {oneclick.get(camel)!r}")

    _check("idle / max lifetime are identical on both paths", setup == oneclick,
           f"setup.sh: {setup}, one-click: {oneclick} —— 数字不一样意味着两条路径部署出来的"
           "产品「保温时长」不同：短的那条上，用户离开一会儿回来就多吃一次 ~30s 冷启动。")

    # 方式 B 有两处写这个数（agentcore.json 声明 + 部署后强制回填），它们自己也会漂。
    idle = setup.get("idleRuntimeSessionTimeout")
    _check("setup.sh's post-deploy backfill uses that same idle value",
           _backfill_default_idle() == idle,
           f"{BACKFILL} 的 SET_IDLE 默认值是 {_backfill_default_idle()}，"
           f"而 agentcore.json 声明的是 {idle} —— 回填会把声明值改掉。")

    # 出厂值本身也钉一下：这两条断言只保证「两边一样」，一起被改小也照样通过。
    _check("the shipped idle timeout is still one hour", idle == 3600,
           f"idleRuntimeSessionTimeout={idle}。产品承诺是 1 小时保温；"
           "AgentCore 不显式声明时的默认值是 900s。要改先改这句注释和文档。")


# ───────────────── 第五个维度：「通知」生产端（AWS 事件 → Web 收件箱）─────────────────
#
# 为什么它单独算一个维度：前四条断言全在看 **AgentCore runtime**。「通知」的生产端根本
# 不在 runtime 里 —— 它是一个独立 Lambda + 一堆 EventBridge 规则，前四条断言结构上
# 看不见它。而它曾经真的只有方式 B 有：读端（`notif#` 段、BFF 的 `/notifications*`、
# 侧栏红点）在 `web-chat-core.ts` 里，两条路径自动对等，于是方式 A 部署出来的环境
# 「通知」页面**永远是空的**：不报错、不写日志，客户只会以为这个功能是假的。
#
# 修法不是"两边各写一份再断言相等"，而是把事件源清单/函数名/handler/规则名/环境变量
# 全提到 `infra/lib/constructs/web-notif-sources.ts`，两个栈 import 同一份。所以这个
# 维度断言的是**"没有人把它抄回去"**：谁在某个栈里重新声明一份，这里就失败。
#
# 已知且**有意**的差异：**怎么关掉某一个事件源**。
#   · 方式 B：合成期 `-c webNotif<Id>=off`（模板由客户本地 synth，可以有 context）
#   · 方式 A：EventBridge 控制台上 Disable 那条规则（发布出去的静态模板没有 context，
#     而给 10 个源各开一个 CFN Parameter 会把参数页淹掉）
# 这是机制固有的差异，不是功能差异：默认开哪 5 个、规则叫什么名字，两边逐字相同。
NOTIF_SOURCES_TS = "infra/lib/constructs/web-notif-sources.ts"
SETUP_BACKEND = "infra/lib/notiops-backend-stack.ts"

#: 两个栈都必须从共享模块 import 的东西。少 import 一个 = 那一项在某条路径上被本地
#: 硬编码了（或者干脆没有），而症状是静默的。
NOTIF_SHARED_SYMBOLS = (
    "WEB_NOTIF_FUNCTION_NAME",   # Lambda 物理名：文档/日志排查按这个名字讲
    "WEB_NOTIF_HANDLER",         # handler 路径：写错 = 客户账号里 ImportError
    "WEB_NOTIF_SOURCES",         # 10 个事件源 + 默认开关
    "webNotifRuleName",          # 规则物理名：客户去控制台找的就是这个名字
    "webNotifRuleDescription",   # 控制台上那行说明（含 globalOnly 提示）
    "webNotifEnv",               # 三个环境变量（表名 / 收件箱粒度 / TTL）
)


def _notif_imports(rel: str) -> set[str]:
    """某个栈从 web-notif-sources 里 import 了哪些符号。"""
    src = _read(rel)
    m = re.search(r"import\s*\{([^}]*)\}\s*from\s*\"\./(?:constructs/)?web-notif-sources\";", src)
    if m is None:
        raise AssertionError(
            f"{rel}: no import from ./constructs/web-notif-sources —— 「通知」生产端的定义"
            "必须来自那份共享模块，不能在栈里自己写一份。")
    return {s.strip() for s in m.group(1).split(",") if s.strip()}


def test_web_notif_producer_parity() -> None:
    """两条路径的「通知」生产端必须来自同一份定义，且谁也不许自己再写一份。"""
    print("\ntest_web_notif_producer_parity")

    shared = _read(NOTIF_SOURCES_TS)
    # 事件源那张表**只能**有一份。判据取 `source: "aws.` 的出现次数：共享模块里
    # 10 个（每个源一行），任何一个栈里出现 = 有人抄了一份回去。
    # 判据形状：一条源的定义 = 一个 `{…}` 里既有 `source: "aws.…"` 又有 `on: true|false`
    # （出厂开关）。**不能**只看 `source: "aws.`：同一个后端栈里还有 IM push 的
    # `pushRuleSources`（5 条，同样是 `source: "aws.…"` 但没有 `on:`）—— 那是另一个功能
    # （推到飞书），一键部署整块不含 IM，它本来就不该有方式 A 的对应物，不算漂移。
    def _source_entries(text: str) -> list[str]:
        return [b for b in re.findall(r"\{[^{}]*\}", text, re.S)
                if re.search(r'source:\s*"aws\.', b) and re.search(r"\bon:\s*(?:true|false)\b", b)]

    shared_sources = len(_source_entries(shared))
    _check("事件源清单只在共享模块里有一份", shared_sources == 10,
           f"共享模块里数到 {shared_sources} 个事件源 —— 加/删事件源时"
           "也要更新这条数字判据（和下面那条 5 开 5 关）。")
    for rel in (ONECLICK, SETUP_BACKEND):
        text = _strip_comments(_read(rel))
        _check(f"{os.path.basename(rel)} 没有自己的 web 通知事件源清单",
               not _source_entries(text),
               "栈里出现了带 `on:` 开关的 `source: \"aws.…\"` —— web 通知的事件源被抄回栈里了。"
               "抄一份的代价是：以后加一个源只在一条路径上生效，而症状同样是静默的。")

    for rel in (ONECLICK, SETUP_BACKEND):
        imported = _notif_imports(rel)
        for sym in NOTIF_SHARED_SYMBOLS:
            _check(f"{os.path.basename(rel)} 从共享模块取 {sym}", sym in imported,
                   f"实际 import 到的是 {sorted(imported)}")

    # 出厂默认：5 开 5 关。两条路径都读同一份 `on:`，所以这里钉的是**产品决定**本身 ——
    # 上面那些断言只保证"两边一样"，一起被改掉照样通过。
    on_count = len(re.findall(r"on:\s*true", shared))
    off_count = len(re.findall(r"on:\s*false", shared))
    _check("出厂默认仍是 5 开 5 关", (on_count, off_count) == (5, 5),
           f"数到 {on_count} 开 / {off_count} 关。改默认值要同步 "
           "WEB_NOTIF_FUNCTION_DESCRIPTION（客户在 Lambda 控制台上看到的那句）"
           "与 docs/DEPLOYMENT{,.en}.md 的 §12.5 两份清单。")

    # 方式 A 侧的三件必需品。缺任一件 = 规则建了但收不到 / 函数建了但写不进表。
    oneclick = _strip_comments(_read(ONECLICK))
    _check("方式 A 建了生产端 Lambda（WebNotifFn）", "new lambda.CfnFunction(this, \"WebNotifFn\"" in oneclick)
    _check("方式 A 给 EventBridge 开了 invoke 权限",
           "principal: \"events.amazonaws.com\"" in oneclick,
           "没有 AWS::Lambda::Permission，规则会静默地调不动函数（EventBridge 不报到客户眼前）。")
    _check("方式 A 按 WEB_NOTIF_SOURCES 循环建规则",
           "for (const src of WEB_NOTIF_SOURCES)" in oneclick and "events.CfnRule" in oneclick)
    # 「怎么关一个源」是两条路径唯一的差别，理由写在共享模块的文件头。方式 B 那个
    # context 键必须还在（它是方式 B 客户唯一的关法）。
    _check("方式 B 仍支持 `-c webNotif<Id>=on|off`",
           "webNotif${src.id}" in _read(SETUP_BACKEND) or "`webNotif${src.id}`" in _read(SETUP_BACKEND))


def main() -> int:
    print("=" * 72)
    print("方式 A（一键部署）与方式 B（setup.sh）的 web 功能一致性")
    print("=" * 72)
    try:
        test_runtime_role_grants_match()
        test_runtime_env_keys_match()
        test_deploy_time_seeds_match()
        test_runtime_lifecycle_matches()
        test_web_notif_producer_parity()
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
