"""`setup.sh`（方式 B）绝不允许"部署成功但 Web Chat 只回显"。

为什么需要这条断言
------------------
2026-08-26 一位客户用 public GitHub 上的 `setup.sh` 部署完,提问只拿到:

    Got it — you said: "开案例".
    (Echo — AGENT_RUNTIME_ARN not set; deploy the agent runtime to enable the real agent.)

链条是这样的（任何一环断掉都落到同一个终点）::

    scripts/deploy_agent.sh 失败/被跳过
      → ${TMPDIR}/notiops-agent-arn.txt 空
      → setup.sh 不传 -c agentRuntimeArn
      → WebChatStack 的 AGENT_RUNTIME_ARN=""
      → bff/web-chat/index.mjs 走 echo 回退

而**根因是一个没写进任何客户文档的前置依赖**:`agentcore deploy` 打 Python CodeZip 时
无条件调 `uv pip install`（@aws/agentcore 的 dist/lib/packaging/python.js →
`ensureBinaryAvailable('uv', …)`）。客户机器上没有 uv,那一步必失败 —— 而 setup.sh 当时
只打一行 ⚠ 就继续把 web 端部署完、照常打印 Chat URL,最后还写着"登录后即可直接用"。
客户得到的是一个**看起来部署成功、其实产品价值全不在**的环境。

这类缺陷的特征是"没有报错的失败",所以它防不住靠人自觉;这里把五件事钉死:

  ① uv 是 fail-fast 的前置检查（preflight,不是二十分钟后）
  ② `@aws/agentcore` 的版本必须钉住（它约每周发一版;不钉 = 客户装到哪个版本取决于
     他跑脚本的日期,而我们验证过的是另一个版本）
  ③ agent 部署的每个失败/跳过分支都必须留下痕迹,并在**最终总结**里大声说一次
  ④ agent 的 Python 依赖必须有上界（同 ② 的道理:`uv pip install -r pyproject.toml`
     不读 uv.lock,裸 `>=` 就是"装当天的最新版"）
  ⑤ 客户读得到的前置条件清单里必须有 uv（内部 + 公开 README + 部署手册,双语）

Run from repo root::

    python3 scripts/test_setup_agent_gate.py

不触网、不读 AWS。纯源码断言。
"""
from __future__ import annotations

import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

PASS = "✅"
FAIL = "❌"
_failed = 0

SETUP = "setup.sh"
DEPLOY_AGENT = "scripts/deploy_agent.sh"
BFF = "bff/web-chat/index.mjs"
AGENT_PYPROJECT = "agent-build/NotiOpsWebChat/app/NotiOpsWebChat/pyproject.toml"

# 客户读得到前置条件的**所有**地方。少一处,下一个客户还是会踩同一个坑 ——
# 而"公开 README 没写"正是这次事故能出现在 public GitHub 上的直接原因。
PREREQ_DOCS = [
    "README.md",                      # 内部
    "publish/README.public.zh.md",    # 对客（中）
    "publish/README.public.en.md",    # 对客（英）
    "docs/DEPLOYMENT.md",             # 部署手册（中）
    "docs/DEPLOYMENT.en.md",          # 部署手册（英）
]


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


def _code(rel: str) -> str:
    """剥掉整行注释。必须剥:注释里会**引用**命令原文(本次修复的说明就引了那条裸
    `npm install -g @aws/agentcore`),不剥就会把"解释清楚了"读成"代码还这么写"。"""
    return "\n".join(l for l in _read(rel).splitlines() if not l.lstrip().startswith("#"))


def test_uv_is_a_preflight_dependency() -> None:
    """uv 必须在 preflight 就拦住,而不是让部署跑到一半再静默降级。"""
    print("test_uv_is_a_preflight_dependency")
    src = _read(SETUP)

    # 位置很重要:必须在 agent 部署那一步**之前**。二十分钟后才发现缺依赖,客户已经
    # 建了一堆资源,而那正是当时的实际行为。
    i_check = src.find("command -v uv")
    i_agent = src.find('bash "$PROJECT_ROOT/scripts/deploy_agent.sh"')
    _check("setup.sh probes for uv", i_check > 0,
           "缺 uv 时 agentcore 打包必失败,而失败的形态是静默降级成 echo")
    _check("the probe runs before the agent deployment", 0 < i_check < i_agent,
           f"uv 检查在第 {i_check} 字节,agent 部署在第 {i_agent} 字节 —— 检查必须更早")

    # 前置检查必须真的**退出**。打印一行警告然后继续 = 回到原来那个缺陷。
    block = src[i_check:i_agent] if 0 < i_check < i_agent else ""
    _check("a missing uv aborts the run", re.search(r"\bexit 1\b", block) is not None,
           "只打印警告不退出,等于把 echo 模式重新放回可能性里")

    # SKIP_AGENT=true 是有意只部署 web 端的路径,不该被 uv 卡住。
    _check("the check is skipped when SKIP_AGENT=true",
           re.search(r'SKIP_AGENT:-false\}" != "true".*\n(.|\n){0,400}?command -v uv', src)
           is not None or "SKIP_AGENT" in src[max(0, i_check - 600):i_check],
           "SKIP_AGENT=true 是「只上 web 端」的正当路径,不该被 uv 前置卡死")

    # 客户拿到的必须是**能直接照做**的修复动作,而不是"请安装 uv"。
    _check("the error message tells the customer how to install uv",
           "astral.sh/uv/install.sh" in block,
           "报错要给出可直接粘贴的安装命令,否则客户只能去搜")

    # 单独跑 deploy_agent.sh 的路径同样要拦。
    agent_src = _read(DEPLOY_AGENT)
    _check("deploy_agent.sh checks uv too (it can be run standalone)",
           "command -v uv" in agent_src and re.search(r"exit 1", agent_src) is not None,
           f"{DEPLOY_AGENT} 支持单独执行,不能只依赖 setup.sh 的 preflight")


def test_agentcore_cli_version_is_pinned() -> None:
    """`@aws/agentcore` 不许裸装 latest。"""
    print("test_agentcore_cli_version_is_pinned")
    src = _code(DEPLOY_AGENT)

    installs = re.findall(r"npm install -g\s+\"?@aws/agentcore(@[^\"\s]*)?\"?", src)
    _check("deploy_agent.sh still installs the agentcore CLI", bool(installs),
           "提取器失配 —— 安装那行改了形态,请更新本断言,别删")
    bare = [m for m in installs if not m]
    _check("no install of @aws/agentcore without a version", not bare,
           "裸 `npm install -g @aws/agentcore` 装到的是「当天的 latest」(该包约每周发一版):"
           "部署成不成取决于客户跑脚本的日期,而我们验证过的是另一个版本")

    m = re.search(r'^AGENTCORE_CLI_VERSION="\$\{AGENTCORE_CLI_VERSION:-([0-9][^}"]*)\}"',
                  src, re.M)
    _check("the pinned version comes from one overridable variable", m is not None,
           "版本要收在一处(带 env 覆盖的逃生口),否则升级时会漏改其中一处")
    if m:
        _check("the pin is an exact version, not a range",
               re.fullmatch(r"\d+\.\d+\.\d+", m.group(1)) is not None,
               f"钉的是 {m.group(1)!r} —— `^`/`~`/`latest` 都会重新引入不确定性")

        # setup.sh 的失败提示里要印这个版本号。它是**读**上面这个权威值的,只有读不到时
        # 才回退到一个字面量 —— 那个回退值必须和权威值一致,否则总结里会告诉客户装错版本。
        fb = re.search(r'AGENTCORE_CLI_VERSION_EXPECTED="([0-9][^"]*)"', _code(SETUP))
        _check("setup.sh's fallback version matches the authoritative pin",
               fb is not None and fb.group(1) == m.group(1),
               f"deploy_agent.sh 钉 {m.group(1)!r},setup.sh 的回退值是 "
               f"{(fb.group(1) if fb else None)!r} —— 两处漂了,客户会被指去装错的版本")

    # 版本不一致必须**硬停**。2026-08-26 的事故就是"只提示不阻断":客户装到 0.28.0,
    # 而更新的 CLI 会改写入库的 agentcore/cdk/package.json(@aws/agentcore-cdk 版本),
    # 与入库的 lib/cdk-stack.ts 不匹配 → tsc TS2561 → deploy 10 秒即挂 → echo 模式。
    # 这是**必然失败**的组合,不是"可能失败",所以不能只打印一行提示。
    i_mismatch = src.find('"$HAVE_CLI" != "$AGENTCORE_CLI_VERSION"')
    block = src[i_mismatch:i_mismatch + 2500] if i_mismatch > 0 else ""
    _check("a CLI version mismatch aborts instead of warning",
           re.search(r"\bexit 1\b", block) is not None,
           "版本漂移必挂在 tsc 上,继续跑只是把失败推迟到客户看不见的地方")
    _check("the mismatch abort keeps an escape hatch for people who know why",
           "AGENTCORE_CLI_ALLOW_MISMATCH" in src,
           "硬停要留一个显式逃生口,否则想试新版的人只能改脚本")


def test_a_failed_deploy_surfaces_the_clis_own_log() -> None:
    """agentcore CLI 把真正的报错写在自己的日志文件里,失败时必须打出来。

    2026-08-26 那次事故,终端上只有一句"deploy 失败",而 tsc 的真实报错
    (`error TS2561: 'connectorName' does not exist …`)只存在于
    `agentcore/.cli/logs/deploy/deploy-<ts>.log` 里 —— 没人知道要去看它,排查绕了好几轮。
    """
    print("test_a_failed_deploy_surfaces_the_clis_own_log")
    src = _read(DEPLOY_AGENT)
    _check("deploy_agent.sh prints the CLI's deploy log on failure",
           ".cli/logs/deploy/" in src and "tail -" in src,
           "失败时必须把 agentcore 自己的日志 tail 出来,否则真实原因留在文件里没人看")
    _check("setup.sh's summary points at that log too",
           ".cli/logs/deploy/" in _read(SETUP),
           "总结里要给出看日志的命令 —— 客户往回翻几百行日志找不到原因")

    # harness 依赖被更新版 CLI 改写过 = 必挂,要在 deploy 之前就拦住并给出还原命令。
    _check("the CDK harness pin is verified before deploying",
           "@aws/agentcore-cdk" in src and "git checkout --" in src,
           "被改写过的 package.json 不会自愈,重跑多少次都挂在同一个 tsc 错误上")

    # npm install 的报错**不许**被丢进 /dev/null:set -e 下它会让脚本无声退出。
    _check("the harness install does not swallow its own errors",
           not re.search(r"npm (ci|install)[^\n]*2>/dev/null", src),
           "`npm install ... 2>/dev/null` 在 set -e 下失败 = 脚本无声消失,客户拿不到任何原因")


def test_a_failed_agent_deploy_is_impossible_to_miss() -> None:
    """agent 没上线时,最终总结里必须有一整块告警,且不许再说"登录后即可直接用"。"""
    print("test_a_failed_agent_deploy_is_impossible_to_miss")
    src = _read(SETUP)

    assigns = set(re.findall(r'^\s*AGENT_STATUS="([a-z-]+)"', src, re.M))
    # 五个结局:部署成功 / 脚本失败 / 返回 0 但没 ARN / 有意跳过 / 工程目录不存在。
    # 后两个历史上**完全不打印**(elif 只覆盖了 SKIP_AGENT=true),是这次一起补的。
    for state in ("deployed", "failed", "no-arn", "skipped", "missing-dir"):
        _check(f"the agent step records the {state!r} outcome", state in assigns,
               f"AGENT_STATUS 只赋过 {sorted(assigns)} —— 没被记录的分支就是静默分支")

    _check("the final summary branches on the agent outcome",
           re.search(r'if \[ "\$AGENT_STATUS" != "deployed" \]', src) is not None,
           "结局要带到最后的总结里;埋在几百行日志中间那句 ⚠ 客户翻不到")

    # 那句"✅ 登录后即可直接用"在 echo 模式下是**假的**。它必须被同一个条件挡住。
    i_ready = src.find("✅ 登录后即可直接用")
    i_gate = src.find('if [ "$AGENT_STATUS" = "deployed" ]')
    _check("the \"ready to use right after login\" line is gated on the agent being up",
           i_ready > 0 and 0 < i_gate < i_ready,
           "agent 没上线时这句话是假的 —— 客户会拿它当验收依据")

    # 总结里要给出可直接粘贴的修复路径(两条命令),否则客户只能回来问。
    i_loud = src.find('if [ "$AGENT_STATUS" != "deployed" ]')
    loud = src[i_loud:i_ready] if 0 < i_loud < i_ready else ""
    _check("the summary hands over a copy-pasteable fix",
           "scripts/deploy_agent.sh" in loud and "agentRuntimeArn=" in loud,
           "要给「重跑 deploy_agent.sh + cdk deploy WebChatStack -c agentRuntimeArn」两条命令")

    # 反向锚:echo 回退本身仍然存在(它是 Phase 0 的兼容路径,不打算删)。
    # 若哪天真删了它,本文件的前提就变了,应该主动来改这条断言而不是让它悄悄失效。
    _check("the echo fallback still exists in the BFF (this file's premise)",
           "AGENT_RUNTIME_ARN not set" in _read(BFF),
           f"{BFF} 里的 echo 回退不见了 —— 前提变了,回来更新本断言")


def test_agent_python_deps_are_bounded() -> None:
    """agent 的每条 Python 依赖都必须有上界。

    `agentcore deploy` 跑的是 `uv pip install -r pyproject.toml`（**不读 uv.lock**),
    所以这个文件里的约束就是客户实际装到什么版本的唯一闸门。全裸 `>=` 时"客户装到哪个
    版本"等于"他哪天跑 setup.sh" —— 和 agentcore CLI 不钉版本是同一类缺陷。
    (实测:`openai` 的下限是 1.50.0,而今天解析出来的是 3.3.1,跨了两个大版本。)
    """
    print("test_agent_python_deps_are_bounded")
    text = _read(AGENT_PYPROJECT)
    body = re.search(r"^dependencies\s*=\s*\[(.*?)^\]", text, re.S | re.M)
    _check("the agent pyproject still declares dependencies", body is not None,
           "提取器失配 —— dependencies 块改了形态,请更新本断言,别删")
    if not body:
        return

    # 先剥注释行 —— 块内注释里带引号的中文("恰好装到了新版")会被下面的提取器
    # 当成一条依赖,于是断言在一个不存在的依赖上失败。
    lines = [l for l in body.group(1).splitlines() if not l.lstrip().startswith("#")]
    specs = re.findall(r'"([^"]+)"', "\n".join(lines))
    _check("the dependency list is non-empty", bool(specs))
    unbounded = [s for s in specs if "<" not in s and "==" not in s and "~=" not in s]
    _check("every dependency has an upper bound", not unbounded,
           f"没有上界的依赖: {unbounded} —— 客户装到的版本取决于他跑脚本的日期")


def test_uv_is_documented_where_customers_read() -> None:
    """客户读得到的前置条件清单里必须有 uv —— 中英、内部与对外都要有。"""
    print("test_uv_is_documented_where_customers_read")
    for rel in PREREQ_DOCS:
        text = _read(rel)
        # 只认独立单词 uv（避免 "uvicorn" / "value" 之类误命中）。
        _check(f"{rel} lists uv as a prerequisite",
               re.search(r"(?<![A-Za-z0-9_.])uv(?![A-Za-z0-9_-])", text) is not None,
               "这条依赖过去只写在 agent-build/NotiOpsWebChat/README.md 里 —— 客户不会读到那里,"
               "于是缺 uv 变成了一个只在客户机器上才暴露的静默故障")


def main() -> int:
    print("=" * 72)
    print("setup.sh（方式 B）不允许「部署成功但只回显」")
    print("=" * 72)
    try:
        test_uv_is_a_preflight_dependency()
        test_agentcore_cli_version_is_pinned()
        test_a_failed_agent_deploy_is_impossible_to_miss()
        test_a_failed_deploy_surfaces_the_clis_own_log()
        test_agent_python_deps_are_bounded()
        test_uv_is_documented_where_customers_read()
    except (AssertionError, FileNotFoundError) as e:
        print(f"  {FAIL} extractor failed: {e}")
        return 1
    print("\n" + "=" * 72)
    if _failed:
        print(f"{FAIL} {_failed} 项失败")
        print("\n这条门禁守的是客户侧最贵的一种失败:部署全绿、Chat URL 照常打印,"
              "而一提问只把用户的话回显回来。")
        return 1
    print(f"{PASS} 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
