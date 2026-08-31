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
    ⑥ 建 Agent Space 时有没有把 Operator App（web app）一并开好
    ⑦ AgentCore Memory（长期记忆）建没建、四个 namespace 对不对
    ⑧ 首次登录交付：部署者拿到临时密码时，是不是同时拿到了 Web Chat 地址

①②④ 是运行期行为，③ 是部署期数据 —— 三者在两条路径上各写了一份，没有任何一处能
import 另一处；⑤ 反过来：它现在**只有一份**，两个栈 import 同一个模块，本文件断言的
是「没有人把它抄回栈里」（见那一节的注释）。⑥ 比前五条还多一条路径：成员账号那份
StackSet payload（`infra/member-devops-agent.yaml`）也自己建 space，三处都得开。
⑦ 有第三方参与：写入端（strategy 的 namespace）和读取端（`memory/session.py` 的
retrieval_config）必须逐字对上，对不上时**不报错**，只是永远检索不到东西。
⑧ 是唯一**机制天生不同**的一条（方式 B 有终端可打印，方式 A 只有一封邮件），所以断言的
是不变量「密码与地址同时到手」，不是"两边写法一样"。

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
    ⑥ 方式 B：notiops-backend-stack.ts 的 DevOpsAgentSpace 段
       方式 A：notiops-webchat-standalone-stack.ts 的 DevOpsAgentSpace 段
       成员账号：infra/member-devops-agent.yaml 的 AgentSpace 资源
    ⑦ 方式 B：agentcore.json 的 memories[]（AgentCore CLI 建资源 + 注入 memory id）
       方式 A：notiops-webchat-standalone-stack.ts 的 AgentCore Memory 段
       读取端（两条路径共用）：agent-build/…/memory/session.py 的 retrieval_config
    ⑧ 方式 B：setup.sh 建 admin（`--message-action SUPPRESS`）+ 部署总结那块打印
       方式 A：notiops-webchat-standalone-stack.ts 的 Cognito 邀请邮件模板

漂移的后果**不是**「功能没做」，而是「界面上有开关、点了静默失败」——
UI 上那些开关（联网搜索 / FinOps / 深度调查）绝大多数是**无条件**渲染的
（frontend/chat-app/src/components/Composer.tsx），前端并不知道后端少了一条 IAM。
于是客户看到的是「这个产品时好时坏」，而排查要一路走到 CloudTrail 的 AccessDenied。

一条修好的漂移，留着当教训（判据已经是第 ⑦ 节的真断言）
------------------------------------------------------------------------
  · **AgentCore Memory 曾在方式 A 上整个不存在**（长期记忆静默失效），而本文件曾把它
    列成"有意的差异"，理由写的是「grep 过 core/ 与 agent/，没有任何代码读 MEMORY_*
    环境变量 —— 两条路径上都是死权限」。那次 grep **没覆盖 agent-build/**，而读它的代码
    (`memory/session.py`) 正好只在那里 —— 于是这个漂移躲过了本判据整整多个版本。
    教训一：判断"这个环境变量没人读"时，搜索范围必须包含 **agent-build/**（那才是真正
    跑在 AgentCore Runtime 里的那份源码），不能只搜 core/ 与 agent/。
    教训二：**别把"我查过了"写成"这是有意的"** —— 前者会过期，后者不会有人再查。

已知且**有意**的差异（不体现在 ①② 两个维度里，故不需要 allowlist；③ 的排除项
带理由记在 `SEED_CLASSIFICATION` 里）
------------------------------------------------------------------------
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

# 方式 A 独有的 Sid，但**不是漂移**：方式 B 的同一批授权是 AgentCore CLI 在部署时生成的
# （不在仓库里，所以源码比对看不见它们），且生成的语句**没有 Sid**。
# 值 = 为什么它在这张表里。判据落在别处（见值里写的那一条），不是"就这么算了"。
CLI_GENERATED_SIDS = {
    "NotiOpsMemoryRetrieve":
        "方式 B 由 AgentCore CLI 按 agentcore.json 的 memories[] 生成同等授权（无 Sid）。"
        "两条路径的 Memory 形状本身由 test_agentcore_memory_parity 断言。",
    "NotiOpsMemoryRetrieveByPath": "同上（namespacePath 条件键那半边）。",
    "NotiOpsMemoryEvents": "同上（事件读写那组，无 namespace 条件键可用）。",
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


def _memory_env_key(memory_name: str) -> str:
    """AgentCore CLI 从 memory 名推导 runtime 环境变量名的规则。

    `MEMORY_` + 名字里的字母数字大写 + `_ID`。**这个函数是本文件存在的理由之一**：
    方式 B 的这个键在 `agentcore.json` 里**根本不出现**（CLI 在部署时才算出来注进去），
    所以只比对 `envVars[]` 的话，方式 A 加了这个键会被判成「只有方式 A 有」，
    而方式 A 忘了加又会被判成「两边都没有」—— 两种都是错的结论。
    """
    return "MEMORY_" + re.sub(r"[^A-Za-z0-9]", "", memory_name).upper() + "_ID"


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
    # CLI 隐式注入的那批（见 _memory_env_key）。
    keys |= {_memory_env_key(m["name"]) for m in data.get("memories", []) if m.get("name")}
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

    missing_in_setup = sorted(set(oneclick) - set(setup) - set(CLI_GENERATED_SIDS))
    _check("setup.sh has every statement one-click has",
           not missing_in_setup,
           f"only the one-click path grants these: {missing_in_setup}")
    # 别让 allowlist 变成垃圾桶：列进去的 Sid 必须真的在方式 A 里存在，
    # 否则删掉授权时这张表会替它掩护。
    stale = sorted(set(CLI_GENERATED_SIDS) - set(oneclick))
    _check("CLI_GENERATED_SIDS 里每条都还在方式 A 的角色上",
           not stale,
           f"这些 Sid 已经不在 {ONECLICK} 里了，要么改名了要么被删了：{stale}")

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
# 提问就吃一次冷启动（实测 ~10s），只能靠 BFF 那句「再发一次」兜。
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
           "产品「保温时长」不同：短的那条上，用户离开一会儿回来就多吃一次 ~10s 冷启动。")

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


# ⑥ Operator App（控制台上那一步叫「Agent Space → Access → Operator access →
# Configure web app」，API 是 aidevops:EnableOperatorApp）。
#
# 为什么这条要有断言：**不开它，四样 DevOps Agent 能力全废，而失败信息毫不指向这里**。
# 没开过 web app 的 space 没有 `https://<spaceId>.aidevops.global.app.aws` 域名，
# CreateBacklogTask / CreateChat 一律回 `Invalid or unregistered domain` ——
# 深度调查、深度调查（直连）、DevOps 对话、发布 Skill 一起挂。以前的补救是让客户
# 登控制台手点一次；现在三条路径都在建 space 的同时把它开好。
#
# 比前五条多的那条路径：成员账号。多账号客户要点 N 次（每个成员账号自己的控制台里点
# 一次），所以 `infra/member-devops-agent.yaml` 漏掉的代价最大 —— 它也最容易被漏，
# 因为它既不是方式 A 也不是方式 B。
MEMBER_DA_YAML = "infra/member-devops-agent.yaml"

#: 那个角色的三件必需品。少任一件的症状都是**部署成功、功能报错**：
#:   · session tag（`sts:TagSession`）—— AIDevOpsOperatorAppAccessPolicy 把资源写成
#:     `agentspace/${aws:PrincipalTag/AgentSpaceId}`，session tag 就是授权依据；
#:     少了它 EnableOperatorApp 本身能过，web app 起来后一切 aidevops 调用被拒。
#:   · aidevops.amazonaws.com 信任 —— 服务 assume 不进来。
#:   · AIDevOpsOperatorAppAccessPolicy —— 权限从哪来。
#: 前两件在两种源码里长得不一样：CDK 侧的 session tag 是 `.withSessionTags()`
#: （TS 里**不会**出现 `sts:TagSession` 这个字面量 —— 按字面量断言等于永远失败），
#: raw CFN 侧才是信任策略里的那个 action 字面量。
_OPERATOR_ROLE_MUSTS_TS = (".withSessionTags()", "aidevops.amazonaws.com",
                           "AIDevOpsOperatorAppAccessPolicy")
_OPERATOR_ROLE_MUSTS_CFN = ("sts:TagSession", "aidevops.amazonaws.com",
                            "AIDevOpsOperatorAppAccessPolicy")


def test_operator_app_enabled_everywhere() -> None:
    """凡是建 Agent Space 的地方，都必须同时把 Operator App 开好。"""
    print("\ntest_operator_app_enabled_everywhere")

    # 两个 TS 栈：CDK 属性名是 camelCase 的 `operatorApp: { iam: { operatorAppRoleArn }}`。
    for rel in (ONECLICK, SETUP_BACKEND):
        src = _strip_comments(_read(rel))
        name = os.path.basename(rel)
        _check(f"{name} 建 space 时开了 Operator App",
               re.search(r"operatorApp:\s*\{\s*iam:\s*\{", src) is not None,
               "CfnAgentSpace 少了 `operatorApp: { iam: { operatorAppRoleArn: … } }` —— "
               "客户部署完还得自己登控制台点一次 Configure web app，不点则深度调查/直连/"
               "DevOps 对话/发布 Skill 全报 `Invalid or unregistered domain`。")
        _check(f"{name} 传的是自己建的 Operator App 角色",
               "operatorAppRoleArn:" in src and "DevOpsAgentOperatorAppRole" in src,
               "角色 ARN 不是本栈里那个 DevOpsAgentOperatorAppRole —— 硬编码/外部传入的 ARN "
               "会让删栈留下悬空引用，也无法保证下面那三件必需品。")
        for must in _OPERATOR_ROLE_MUSTS_TS:
            _check(f"{name} 的 Operator App 角色带 {must}", must in src,
                   "见本节注释：这三件少任一件都是「部署成功、功能报错」。"
                   "注意 sts:TagSession 在 CDK 侧就是 `.withSessionTags()` —— 别改成手写 "
                   "`addPropertyOverride(\"AssumeRolePolicyDocument.Statement.0.Action\")`，"
                   "那个依赖语句下标，CDK 换了顺序就静默失效。")

    # 成员账号那份 raw CFN：属性名是 PascalCase。
    member = _read(MEMBER_DA_YAML)
    _check("成员账号 StackSet 建 space 时开了 Operator App",
           re.search(r"OperatorApp:\s*\n\s*Iam:\s*\n\s*OperatorAppRoleArn:", member) is not None,
           "多账号客户要为每个成员账号登进它自己的控制台点一次 —— 这是三条路径里漏掉代价最大的一条。")
    for must in _OPERATOR_ROLE_MUSTS_CFN:
        _check(f"member-devops-agent.yaml 的 Operator App 角色带 {must}", must in member)
    # 成员账号里可能同时存在一套**独立 NotiOps 部署**（无 -m 后缀的同名角色）。
    # 后缀是共存的前提，不是风格问题。
    _check("成员账号的角色名带 -m<SystemAccountId> 后缀",
           re.search(r"RoleName:\s*!Sub\s*\"notiops-agent-webapp-\$\{AWS::AccountId\}-m\$\{SystemAccountId\}\"",
                     member) is not None,
           "少了后缀会和成员账号内自建的 NotiOps 部署撞名，StackSet 实例直接 CREATE_FAILED。")


# ───────────────── 第七个维度：AgentCore Memory（长期记忆） ─────────────────
#
# 为什么单独一节：长期记忆坏掉的样子**完全静默**。BFF 每轮只发 `prompt`
# （bff/web-chat/agentcore.mjs 的 buildRuntimePayload 里没有历史），所以模型接得上上文靠
# 两件事之一 —— 容器里那个 Agent 对象还在 LRU 缓存里，或者 Memory 把历史读回来。
# 没有后者时，缓存那一格一被顶掉（换模型 / 换主题 / 换账号 / 存一次 Admin 配置 / 闲置 1 小时
# / 重新部署 …）模型就当场失忆，而界面上历史还在（历史存 DynamoDB）。
# 客户看到的是「它刚刚还知道，现在突然不认了」，日志里什么都没有。
#
# 这一节比前六节多一个参与方：**读取端**。写入端（strategy 的 namespace）和读取端
# （`memory/session.py` 的 retrieval_config）对不上时也不报错，只是永远检索不到东西。
# 所以这里断言三方一致，而不是两方。
MEMORY_SESSION_PY = "agent-build/NotiOpsWebChat/app/NotiOpsWebChat/memory/session.py"

#: CFN 的 strategy wrapper 键 → agentcore.json 的 `type`。
#: schema 里每个 wrapper 只能带一个 strategy（maxProperties=1），所以键本身就是类型。
_STRATEGY_WRAPPER_TO_TYPE = {
    "SemanticMemoryStrategy": "SEMANTIC",
    "UserPreferenceMemoryStrategy": "USER_PREFERENCE",
    "SummaryMemoryStrategy": "SUMMARIZATION",
    "CustomMemoryStrategy": "CUSTOM",
    "EpisodicMemoryStrategy": "EPISODIC",
}


def _balanced_end(text: str, open_idx: int) -> int:
    """`text[open_idx]` 是一个 `{`，返回与它配对的 `}` 的下标。"""
    if text[open_idx] != "{":
        raise AssertionError(f"_balanced_end: {text[open_idx]!r} is not an opening brace")
    depth = 0
    for k in range(open_idx, len(text)):
        if text[k] == "{":
            depth += 1
        elif text[k] == "}":
            depth -= 1
            if depth == 0:
                return k
    raise AssertionError("_balanced_end: unbalanced braces")


def _memory_setup() -> dict:
    """方式 B：agentcore.json 的 memories[0]。"""
    data = json.loads(_read(SETUP_AGENTCORE_JSON))
    mems = data.get("memories") or []
    if len(mems) != 1:
        raise AssertionError(
            f"{SETUP_AGENTCORE_JSON}: 期望恰好 1 个 memory，实际 {len(mems)} 个 —— "
            "本节的三方对照假设只有一个，多了要先决定 session.py 读哪个")
    m = mems[0]
    strategies = {}
    for s in m.get("strategies", []):
        strategies[s["type"]] = tuple(sorted(s.get("namespaceTemplates", [])))
    return {
        "name": m["name"],
        "expiry": m.get("eventExpiryDuration"),
        "strategies": strategies,
        "reflection": tuple(sorted(
            ns
            for s in m.get("strategies", [])
            for ns in s.get("reflectionNamespaceTemplates", [])
        )),
    }


def _memory_oneclick() -> dict:
    """方式 A：栈里那个 `AWS::BedrockAgentCore::Memory` 资源。

    按花括号深度切出 properties 块再按行取值 —— 和 `_env_keys_oneclick` 同一套办法，
    理由一样：不依赖缩进/行号，但一旦有人把资源整块改写成别的形态，提取器会**失败**
    （抛 AssertionError），不会静默通过。
    """
    src = _strip_comments(_read(ONECLICK))
    i = src.find('type: "AWS::BedrockAgentCore::Memory"')
    if i < 0:
        raise AssertionError(
            f"{ONECLICK}: 找不到 AWS::BedrockAgentCore::Memory 资源 —— "
            "长期记忆在方式 A 上又没了（这正是本节要守的那个漂移）")
    j = src.index("properties: {", i)
    depth, end = 0, None
    for k in range(j, len(src)):
        if src[k] == "{":
            depth += 1
        elif src[k] == "}":
            depth -= 1
            if depth == 0:
                end = k
                break
    if end is None:
        raise AssertionError(f"{ONECLICK}: Memory 的 properties 块没闭合")
    block = src[j:end]

    name_const = re.search(r'const MEMORY_NAME = "([^"]+)"', _read(ONECLICK))
    if not name_const:
        raise AssertionError(f"{ONECLICK}: 找不到 MEMORY_NAME 常量")
    expiry = re.search(r"EventExpiryDuration:\s*(\d+)", block)
    if not expiry:
        raise AssertionError(f"{ONECLICK}: Memory 少了 EventExpiryDuration")

    # 每个 wrapper 一段：从 `{ XxxMemoryStrategy: {` 到下一个 wrapper 之前。
    strategies: dict[str, tuple[str, ...]] = {}
    reflection: list[str] = []
    wrappers = list(re.finditer(r"(\w+MemoryStrategy):\s*\{", block))
    for n, w in enumerate(wrappers):
        seg = block[w.end(): wrappers[n + 1].start() if n + 1 < len(wrappers) else len(block)]
        kind = _STRATEGY_WRAPPER_TO_TYPE.get(w.group(1))
        if kind is None:
            raise AssertionError(f"{ONECLICK}: 未知的 strategy wrapper {w.group(1)!r}")
        # `ReflectionConfiguration` 里也有一个 NamespaceTemplates —— 先把它切出去，
        # 否则反思的 namespace 会被算成 strategy 自己的写入 namespace。
        # 切法必须数括号：namespace 模板里的 `{actorId}` 自带花括号，
        # 用 `\{(.*?)\}` 这种非贪婪匹配会停在 `{actorId` 那个 `}` 上（实测踩过）。
        refl = re.search(r"ReflectionConfiguration:\s*\{", seg)
        if refl:
            refl_end = _balanced_end(seg, refl.end() - 1)
            reflection += re.findall(r'"(/[^"]+)"', seg[refl.end(): refl_end])
            seg = seg[: refl.start()] + seg[refl_end + 1:]
        ns = re.search(r"NamespaceTemplates:\s*\[(.*?)\]", seg, re.S)
        if not ns:
            raise AssertionError(f"{ONECLICK}: {w.group(1)} 少了 NamespaceTemplates")
        strategies[kind] = tuple(sorted(re.findall(r'"(/[^"]+)"', ns.group(1))))
    return {
        "name": name_const.group(1),
        "expiry": int(expiry.group(1)),
        "strategies": strategies,
        "reflection": tuple(sorted(reflection)),
    }


def _memory_namespaces_read() -> set[str]:
    """读取端：`memory/session.py` 的 retrieval_config 里那几个 namespace。

    把 Python 的占位符名归一到 AgentCore 的写法（`{actor_id}` → `{actorId}`）——
    两边指的是同一个东西，只是一个是本地变量名、一个是服务端模板变量。
    """
    src = _read(MEMORY_SESSION_PY)
    i = src.find("retrieval_config = {")
    if i < 0:
        raise AssertionError(f"{MEMORY_SESSION_PY}: 找不到 retrieval_config")
    end = src.index("\n    }", i)
    found = re.findall(r'f"(/[^"]+)"', src[i:end])
    if not found:
        raise AssertionError(f"{MEMORY_SESSION_PY}: retrieval_config 里没解析出 namespace")
    return {ns.replace("{actor_id}", "{actorId}").replace("{session_id}", "{sessionId}")
            for ns in found}


def test_agentcore_memory_parity() -> None:
    """长期记忆：两条路径的 Memory 形状一致，且写入端与读取端的 namespace 对得上。"""
    print("\ntest_agentcore_memory_parity")
    setup, oneclick = _memory_setup(), _memory_oneclick()

    _check("两条路径的 strategy 类型集合相同",
           set(setup["strategies"]) == set(oneclick["strategies"]),
           f"方式 B: {sorted(setup['strategies'])}; 方式 A: {sorted(oneclick['strategies'])}")
    for kind in sorted(set(setup["strategies"]) & set(oneclick["strategies"])):
        _check(f"{kind}: namespace 模板相同",
               setup["strategies"][kind] == oneclick["strategies"][kind],
               f"方式 B: {setup['strategies'][kind]}; 方式 A: {oneclick['strategies'][kind]}")
    _check("EPISODIC 的反思 namespace 相同",
           setup["reflection"] == oneclick["reflection"],
           f"方式 B: {setup['reflection']}; 方式 A: {oneclick['reflection']}")
    _check("事件保留期（天）相同",
           setup["expiry"] == oneclick["expiry"],
           f"方式 B: {setup['expiry']}; 方式 A: {oneclick['expiry']}")

    # 名字**故意不同**（方式 B 的由 CLI 加了应用名前缀，而 Memory 的 Name 是 createOnly
    # 且账号内唯一，同名就没法两条路径共存）。真正必须一致的是**推导出来的环境变量键**。
    key_setup, key_oneclick = _memory_env_key(setup["name"]), _memory_env_key(oneclick["name"])
    _check("两条路径推导出同一个 runtime 环境变量键",
           key_setup == key_oneclick,
           f"方式 B → {key_setup}; 方式 A → {key_oneclick} —— "
           "键不一致时 get_memory_session_manager() 返回 None，长期记忆**静默**失效")
    _check(f"消费方写死读的就是这个键（{key_setup}）",
           key_setup in _read(MEMORY_SESSION_PY),
           f"{MEMORY_SESSION_PY} 读的键和两条路径注入的键不是一个")
    _check("方式 A 真的把这个键注给了 runtime",
           key_oneclick in _env_keys_oneclick(),
           "Memory 资源建了但没注入 id —— 这是最容易漏的一半，且症状与完全没做一模一样")

    # 写入端 ∩ 读取端：strategy 往哪写、session.py 就得从哪读。
    written = {ns for nss in oneclick["strategies"].values() for ns in nss}
    read = _memory_namespaces_read()
    _check("读取端的每个 namespace 都有 strategy 在往里写",
           not (read - written),
           f"session.py 检索这些 namespace，但没有任何 strategy 写它们（永远检索不到）：{sorted(read - written)}")
    _check("每个 strategy 写的 namespace 都有人读",
           not (written - read),
           f"这些 strategy 在抽取、但 session.py 从不检索它们（白花抽取成本）：{sorted(written - read)}")


def _invite_template_oneclick() -> str:
    """方式 A 的 Cognito 邀请邮件那一段源码（地址常量 + `addPropertyOverride` 的模板对象）。

    连地址常量一起截：正文里的地址是那个常量拼出来的，只看模板对象会看不到它从哪来。

    用 `_balanced_end` 而不是正则截断：邮件正文里有 `{username}` / `{####}`，
    非贪婪匹配会停在第一个 `}` 上（`_memory_oneclick` 已经踩过一次同样的坑）。
    这两个占位符各自自带一对括号，所以按深度扫是平衡的。
    """
    text = _read(ONECLICK)
    anchor = '"AdminCreateUserConfig.InviteMessageTemplate"'
    i = text.find(anchor)
    assert i > 0, f"{ONECLICK} 里找不到 {anchor} —— 邀请邮件模板被删了或换了写法"
    j = text.find("{", i)
    assert j > 0, f"{anchor} 之后找不到模板对象"
    url_const = "const chatUrlForEmail"
    k = text.rfind(url_const, 0, i)
    assert k > 0, f"{ONECLICK} 里找不到 `{url_const}` —— 地址常量被改名了，本提取器要跟着改"
    return text[k:_balanced_end(text, j)]


def test_first_login_handoff_parity() -> None:
    """首次登录交付：两条路径都必须让部署者**在拿到临时密码的同时拿到 Web Chat 地址**。

    这一条的机制天生不同，所以不能按"模板要一模一样"来断言：
      · 方式 B 有终端 —— `setup.sh` 用 `--message-action SUPPRESS` 建 admin（**不发邮件**），
        把地址和临时密码一起打印在部署总结里。
      · 方式 A 没有终端 —— 客户手里只有一个 CFN 模板，收到的唯一东西就是 Cognito 那封邮件，
        所以地址必须写进邮件正文（Cognito 只认 `{username}` / `{####}` 两个占位符，
        地址只能由 CFN 在部署期拼成字面量）。
    断言的是**不变量**（密码与地址同时到手），不是实现。
    """
    print("\ntest_first_login_handoff_parity")
    invite = _invite_template_oneclick()

    for ph in ("{username}", "{####}"):
        _check(f"方式 A 的邀请邮件带 {ph}",
               ph in invite,
               "Cognito 硬性要求这两个占位符都出现，缺一个 CFN 直接拒掉整个用户池")
    _check("方式 A 的邀请邮件里带 ChatUrl",
           "distributionDomainName" in invite,
           "邮件里没有引用 ChatCDN 的域名 —— 客户又得回控制台翻 Outputs 才知道去哪登录")
    _check("方式 A 的邮件文案是纯 ASCII",
           invite.isascii(),
           "客户可见文案里的非 ASCII 会被 CFN 收模板时换成 `?`"
           "（scripts/postprocess_template.py 的全局断言同样会拦）")

    setup_sh = _read(SETUP_SH)
    _check("方式 B 建 admin 时明确不发邮件（--message-action SUPPRESS）",
           "--message-action SUPPRESS" in setup_sh,
           "方式 B 改成发邮件了 —— 那它也需要一份带地址的邀请模板，本断言要跟着改")
    _check("方式 B 的部署总结把地址和临时密码一起打印",
           "$CHAT_URL" in setup_sh and "$ADMIN_PASSWORD_MSG" in setup_sh,
           "少了任何一半，方式 B 的部署者就得自己去找另一半")


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
        test_operator_app_enabled_everywhere()
        test_agentcore_memory_parity()
        test_first_login_handoff_parity()
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
