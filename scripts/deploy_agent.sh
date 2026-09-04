#!/usr/bin/env bash
# 部署 NotiOps Web Chat 的 AgentCore Runtime（Strands agent）。
#
# 由 setup.sh 调用（也可单独跑）。流程：
#   0. 确保 uv 可用（agentcore 打 Python 包的硬依赖，缺它必失败 → 静默退化成 echo）。
#   1. 确保 agentcore CLI 可用（公共 npm 包 @aws/agentcore，版本钉在 AGENTCORE_CLI_VERSION）。
#   2. （可选）provision web-search Gateway 并把 URL 注入 agentcore.json 的 envVars。
#   3. agentcore deploy（CodeZip 构建，无需 docker/finch）。
#   4. 从 CloudFormation 输出捕获 Runtime ARN，打印 + 写入 $AGENT_ARN_OUT（若设了）。
#
# 输入（env）：
#   DEPLOY_REGION         必填，部署区域（agentcore runtime 区）。
#   PROJECT_ROOT          仓库根（默认脚本上级目录）。
#   ENABLE_WEBSEARCH      "true"(默认) 则 provision web-search Gateway 并注入 URL；
#                         "false" 则跳过 —— **本部署就没有联网搜索能力**（2026-08 起没有
#                         第三方兜底），界面开关按无能力处理。
#   AGENT_ARN_OUT         可选，把捕获到的 Runtime ARN 写到这个文件路径。
#   AGENTCORE_CLI_VERSION 可选，覆盖钉住的 @aws/agentcore 版本（默认见下方）。
#   NOTIOPS_ALLOW_CROSS_ACCOUNT
#                         跨账号闸门（默认安全）。"1" = 放开多账号（setup.sh --multi-account
#                         时传入）；空/未设 = 仅部署账号。**必须显式传空**而非省略，因为
#                         §5 的回填是 merge-patch：不传就保留 runtime 上的旧值，会让
#                         org→单账号回退时闸门一直留在开启态（fail-open）。
#   COST_AGENT_MCP_URL    可选，客户自建 cost-agent MCP（CUR 行级明细）的 Lambda Function
#                         URL。空/未设 = 本部署无客户 CUR 能力（core/cost_agent_mcp.py 不挂载
#                         工具，agent 回答成本问题时走 CE / aws-api 兜底）。与上面同理**必须
#                         显式传空**：§5 回填是 merge-patch，不传就留着 runtime 上的旧 URL。
#
# 退出码非 0 表示失败；setup.sh 据此决定是否回退 echo BFF。
set -euo pipefail

# 跨账号闸门取值：单独跑本脚本时可能未设（set -u 下需给默认值）。空串 = 默认关闭。
ALLOW_CROSS_ACCOUNT="${NOTIOPS_ALLOW_CROSS_ACCOUNT:-}"
# 客户 CUR 数据源（cost-agent MCP 的 Lambda Function URL）。空串 = 本部署没有这个能力，
# 不是错误：agent 侧 get_tools() 返回空、web 侧能力节点被 requiresEnv 摘掉，成本问题
# 由 CE / aws-api 兜底回答。末尾斜杠统一去掉（拼 /mcp 时不出现双斜杠）。
COST_AGENT_MCP_URL="${COST_AGENT_MCP_URL:-}"
COST_AGENT_MCP_URL="${COST_AGENT_MCP_URL%/}"
# 同一个 Lambda 的**函数 ARN**。Function URL 里不含 ARN，而 `lambda:InvokeFunctionUrl`
# 必须按资源授权 —— 所以 runtime 执行角色那条语句（cdk/lib/cdk-stack.ts 的
# `InvokeCostAgentMcp`）只能从这里拿到目标。**export**：`agentcore deploy` 会 fork 出
# cdk synth 子进程，不 export 就读不到，于是权限授到一个不存在的函数上、调用恒 403。
export COST_AGENT_FN_ARN="${COST_AGENT_FN_ARN:-}"

# ─── UI 语言（双语输出）───
# 继承 setup.sh 导出的 UI_LANG（zh/en）；单独跑本脚本时默认英文，面向全球客户。
# t "<中文>" "<English>"：按 UI_LANG 输出对应语言。
# export：让内嵌的 python3 heredoc 子进程也能读到 UI_LANG（standalone 跑时也生效）。
export UI_LANG="${UI_LANG:-en}"
t() { if [ "$UI_LANG" = "zh" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AGENT_DIR="$PROJECT_ROOT/agent-build/NotiOpsWebChat"
REGION="${DEPLOY_REGION:?DEPLOY_REGION required}"
ENABLE_WEBSEARCH="${ENABLE_WEBSEARCH:-true}"
STACK="AgentCore-NotiOpsWebChat-default"

if [ ! -d "$AGENT_DIR" ]; then
  echo "  $(t "⚠ 未找到 agent 工程目录 $AGENT_DIR，跳过 agent 部署。" "⚠ Agent project dir $AGENT_DIR not found; skipping agent deployment.")" >&2
  exit 1
fi

# ── 0. uv（agentcore 打 Python 包的硬依赖）──
# @aws/agentcore 的 Python CodeZip packager 无条件调 uv：
#   dist/lib/packaging/python.js → ensureBinaryAvailable('uv', UV_INSTALL_HINT)
#   → uv pip install -r pyproject.toml --target <staging> --python-version 3.13 --only-binary :all:
# 没有 uv 这一步必失败，而失败的**后果是静默的**：setup.sh 只打一行 ⚠ 就继续把 web 端部署
# 完，BFF 因为拿不到 AGENT_RUNTIME_ARN 回退 echo —— 客户看到"部署成功但只回显"。
# setup.sh 已在 preflight 拦一次；这里再拦一次，因为本脚本也支持单独跑。
if ! command -v uv >/dev/null 2>&1; then
  for _uv_dir in "$HOME/.local/bin" "$HOME/.cargo/bin"; do
    [ -x "$_uv_dir/uv" ] && { PATH="$_uv_dir:$PATH"; export PATH; break; }
  done
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "  $(t "❌ 缺少 uv —— agentcore 打 Python 依赖包必须用它，部署无法继续。" "❌ uv is missing — the agentcore CLI needs it to package the Python dependencies; cannot continue.")" >&2
  echo "     curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  echo "  $(t "     或: brew install uv / pipx install uv；文档 " "     or: brew install uv / pipx install uv; docs ")https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
fi

# ── 1. agentcore CLI ──
# 版本**必须钉住**。这个包发版约每周一次（0.24.2 → 0.28.0 只隔一个月），而原先的
# `npm install -g @aws/agentcore` 不带版本：客户装到的是"当天的 latest"，我们验证过的是
# 另一个版本 —— 一次部署到底能不能成，取决于客户跑脚本的**日期**。那不是可支持的产品。
# 升级流程：先在验证账号跑一次完整的 setup.sh（agent 必须真起来、能回答），再改这里的默认值。
# 客户要试新版：AGENTCORE_CLI_VERSION=x.y.z bash scripts/deploy_agent.sh。
AGENTCORE_CLI_VERSION="${AGENTCORE_CLI_VERSION:-0.24.2}"
if ! command -v agentcore >/dev/null 2>&1; then
  echo "  $(t "安装 AgentCore CLI（@aws/agentcore@$AGENTCORE_CLI_VERSION）..." "Installing AgentCore CLI (@aws/agentcore@$AGENTCORE_CLI_VERSION)...")"
  npm install -g "@aws/agentcore@$AGENTCORE_CLI_VERSION" >/dev/null 2>&1 || {
    echo "  $(t "❌ 无法安装 agentcore CLI；请手动 'npm install -g @aws/agentcore@$AGENTCORE_CLI_VERSION' 后重试。" "❌ Failed to install agentcore CLI; run 'npm install -g @aws/agentcore@$AGENTCORE_CLI_VERSION' manually and retry.")" >&2
    exit 1
  }
else
  # 版本不一致 = **硬停**。这里最初只打了一行"ℹ 提示差异"，2026-08-26 一位客户就是这样
  # 挂掉的：他装到当天的 latest(0.28.0)，而 agentcore deploy 的 "Sync CDK dependencies"
  # 步骤会**擅自改写仓库里已入库的** agentcore/cdk/package.json，把
  # @aws/agentcore-cdk 0.1.0-alpha.45 顶到 alpha.49；而入库的 lib/cdk-stack.ts 是
  # 0.24.2 生成的（还写着已被改名的 connectorName 属性）→ tsc TS2561 → deploy 10 秒即挂。
  # 后果对客户是不可见的：栈没建、没有 Runtime ARN、web 端照常部署完 → Web Chat 只回显。
  # 也就是说"新 CLI + 入库的旧 harness"是一个**必然失败**的组合,不是"可能失败",
  # 所以只能硬停。逃生口留给知情的人：AGENTCORE_CLI_ALLOW_MISMATCH=1。
  HAVE_CLI="$(agentcore --version 2>/dev/null | tr -d '[:space:]' || echo '?')"
  if [ "$HAVE_CLI" != "$AGENTCORE_CLI_VERSION" ] && [ "${AGENTCORE_CLI_ALLOW_MISMATCH:-}" != "1" ]; then
    echo "  $(t "❌ agentcore CLI 版本不匹配：当前 $HAVE_CLI，NotiOps 验证过的是 $AGENTCORE_CLI_VERSION。" "❌ agentcore CLI version mismatch: found $HAVE_CLI, NotiOps validated $AGENTCORE_CLI_VERSION.")" >&2
    echo "  $(t "   更新的 CLI 会改写仓库里入库的 agentcore/cdk/package.json（@aws/agentcore-cdk 版本），" "   A newer CLI rewrites the in-repo agentcore/cdk/package.json (@aws/agentcore-cdk version),")" >&2
    echo "  $(t "   与入库的 lib/cdk-stack.ts 不匹配 → tsc 编译失败 → agent 上不了线（Web Chat 只回显）。" "   which no longer matches the in-repo lib/cdk-stack.ts → tsc fails → the agent never deploys (Web Chat only echoes).")" >&2
    echo "     npm install -g @aws/agentcore@$AGENTCORE_CLI_VERSION" >&2
    echo "  $(t "   若之前已被更新的 CLI 改写过 harness，一并还原：" "   If a newer CLI already rewrote the harness, restore it too:")" >&2
    echo "     git checkout -- agent-build/NotiOpsWebChat/agentcore/cdk/package.json agent-build/NotiOpsWebChat/agentcore/cdk/package-lock.json" >&2
    echo "  $(t "   或者一条命令自动搞定（体检 → 降级 → 还原 → 重新部署 → 注入 BFF）：" "   Or fix it all with one command (diagnose → pin → restore → redeploy → inject into the BFF):")" >&2
    echo "     bash scripts/fix_web_chat_echo.sh --region $REGION" >&2
    echo "  $(t "   明知风险仍要继续：AGENTCORE_CLI_ALLOW_MISMATCH=1 重跑本脚本。" "   To proceed anyway: re-run this script with AGENTCORE_CLI_ALLOW_MISMATCH=1.")" >&2
    exit 1
  elif [ "$HAVE_CLI" != "$AGENTCORE_CLI_VERSION" ]; then
    echo "  $(t "⚠ agentcore CLI $HAVE_CLI ≠ 验证版本 $AGENTCORE_CLI_VERSION，已按 AGENTCORE_CLI_ALLOW_MISMATCH=1 放行。" "⚠ agentcore CLI $HAVE_CLI != validated $AGENTCORE_CLI_VERSION; proceeding because AGENTCORE_CLI_ALLOW_MISMATCH=1.")" >&2
  fi
fi

export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" CDK_DEFAULT_REGION="$REGION"

# ── 2. Web Search Gateway（可选）──
# AgentCore web search 仅 us-east-1。非该区时自动跳过（不阻断部署，但该部署没有联网搜索）。
GATEWAY_URL=""
if [ "$ENABLE_WEBSEARCH" = "true" ] && [ "$REGION" = "us-east-1" ]; then
  echo "  $(t "正在 provision AgentCore Web Search Gateway…" "Provisioning AgentCore Web Search Gateway...")"
  # 脚本打印形如 "  <url>/mcp"；抓最后一个 https://...mcp。
  if GW_OUT=$(AWS_REGION="$REGION" bash "$PROJECT_ROOT/scripts/provision_websearch_gateway.sh" 2>&1); then
    GATEWAY_URL=$(printf '%s\n' "$GW_OUT" | grep -oE 'https://[^ ]+/mcp' | tail -1)
    echo "$GW_OUT" | sed 's/^/    /'
  else
    echo "$GW_OUT" | sed 's/^/    /'
    echo "  $(t "⚠ Gateway provision 失败 —— 不阻断部署，但本部署将没有联网搜索能力（界面开关按无能力处理）。" "⚠ Gateway provisioning failed — deployment continues, but this deployment will have no web-search capability (the UI toggle is treated as unavailable).")" >&2
  fi
elif [ "$ENABLE_WEBSEARCH" = "true" ]; then
  echo "  $(t "（AgentCore Web Search 仅 us-east-1 可用，当前 $REGION 跳过；本部署没有联网搜索能力。）" "(AgentCore Web Search is only available in us-east-1; skipping in $REGION — this deployment has no web-search capability.)")"
fi

# 注入 env 占位符到 agentcore.json：
#  - __WEBSEARCH_GATEWAY_URL__：web-search Gateway（空串 → 本部署无联网搜索能力）
#  - __SKILLS_BUCKET__：Skills 共享数据桶（notiops-data-<account>-<region>）
#  - __DEVOPS_AGENT_SPACE_ID__：部署账号 DevOps Agent Space（NotiOpsBackendStack 的 AgentSpaceId 输出）
ACCT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo '')"
SKILLS_BUCKET=""
[ -n "$ACCT_ID" ] && SKILLS_BUCKET="notiops-data-${ACCT_ID}-${REGION}"
# DevOps Agent Space ID：从 NotiOpsBackendStack 的 CfnOutput 读（部署账号自动创建的 Agent Space）。
# 读不到（NotiOpsBackendStack 还没部署 / 无该输出）→ 空串，agent 运行时回退 ListAgentSpaces 自动发现。
DEVOPS_AGENT_SPACE_ID="$(aws cloudformation describe-stacks --region "$REGION" \
  --stack-name NotiOpsBackendStack \
  --query "Stacks[0].Outputs[?OutputKey=='AgentSpaceId'].OutputValue | [0]" \
  --output text 2>/dev/null || echo '')"
[ "$DEVOPS_AGENT_SPACE_ID" = "None" ] && DEVOPS_AGENT_SPACE_ID=""
# 报告分发 CDN 域名：从 NotiOpsBackendStack 的 ReportsCdnDomain 输出读（CloudFront+OAC，只暴露 reports/*）。
# 读不到 → 空串，reports.py 回退到 presigned URL（12h 有效）。
REPORTS_CDN_DOMAIN="$(aws cloudformation describe-stacks --region "$REGION" \
  --stack-name NotiOpsBackendStack \
  --query "Stacks[0].Outputs[?OutputKey=='ReportsCdnDomain'].OutputValue | [0]" \
  --output text 2>/dev/null || echo '')"
[ "$REPORTS_CDN_DOMAIN" = "None" ] && REPORTS_CDN_DOMAIN=""
AGENTCORE_JSON="$AGENT_DIR/agentcore/agentcore.json"
python3 - "$AGENTCORE_JSON" "$GATEWAY_URL" "$SKILLS_BUCKET" "$DEVOPS_AGENT_SPACE_ID" "$REPORTS_CDN_DOMAIN" "$ALLOW_CROSS_ACCOUNT" "$COST_AGENT_MCP_URL" <<'PY'
import json, sys
path, url, skills_bucket, da_space = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
reports_cdn = sys.argv[5] if len(sys.argv) > 5 else ""
allow_cross = sys.argv[6] if len(sys.argv) > 6 else ""
cost_mcp = sys.argv[7] if len(sys.argv) > 7 else ""
d = json.load(open(path))
for rt in d.get("runtimes", []):
    for ev in rt.get("envVars", []):
        if ev.get("name") == "AGENTCORE_WEBSEARCH_GATEWAY_URL":
            ev["value"] = url  # 空串=未启用，本部署无联网搜索能力
        elif ev.get("name") == "SKILLS_BUCKET":
            ev["value"] = skills_bucket  # 空串=skills 读取关闭（不阻断）
        elif ev.get("name") == "DEVOPS_AGENT_SPACE_ID":
            ev["value"] = da_space  # 空串=运行时 ListAgentSpaces 自动发现
        elif ev.get("name") == "REPORTS_CDN_DOMAIN":
            ev["value"] = reports_cdn  # 空串=reports.py 回退 presigned(12h)
        elif ev.get("name") == "NOTIOPS_ALLOW_CROSS_ACCOUNT":
            ev["value"] = allow_cross  # org 模式传 1 = 放开跨账号闸门；空 = 仅部署账号
        elif ev.get("name") == "COST_AGENT_MCP_URL":
            ev["value"] = cost_mcp  # 空串=不挂 CUR 工具，成本问题走 CE / aws-api 兜底
json.dump(d, open(path, "w"), indent=2, ensure_ascii=False)
import os as _os
_zh = _os.environ.get("UI_LANG") == "zh"
if _zh:
    print(f"    agentcore.json 已写入 gateway URL: {url or '(空，本部署无联网搜索)'}; "
          f"SKILLS_BUCKET: {skills_bucket or '(空)'}; "
          f"DEVOPS_AGENT_SPACE_ID: {da_space or '(空，运行时自动发现)'}; "
          f"REPORTS_CDN_DOMAIN: {reports_cdn or '(空，回退 presigned)'}; "
          f"跨账号闸门: {'开启（多账号模式）' if allow_cross else '关闭（仅部署账号）'}; "
          f"客户 CUR 数据源: {'已配置' if cost_mcp else '(空，成本问题走 CE / aws-api)'}")
else:
    print(f"    agentcore.json written — gateway URL: {url or '(empty, no web search)'}; "
          f"SKILLS_BUCKET: {skills_bucket or '(empty)'}; "
          f"DEVOPS_AGENT_SPACE_ID: {da_space or '(empty, auto-discovered at runtime)'}; "
          f"REPORTS_CDN_DOMAIN: {reports_cdn or '(empty, presigned fallback)'}; "
          f"cross-account gate: {'ON (multi-account mode)' if allow_cross else 'OFF (deploy account only)'}; "
          f"customer CUR source: {'configured' if cost_mcp else '(empty, cost questions fall back to CE / aws-api)'}")
PY

# ── 3. 部署 ──
# agentcore deploy 底层用 CDK，需要账号已 bootstrap。setup.sh 的 bootstrap 在更后面，
# 故这里先幂等 bootstrap 一次（已 bootstrap 则秒过），避免新账号首次部署失败。
ACCT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")"
if [ -n "$ACCT" ]; then
  npx --yes cdk bootstrap "aws://$ACCT/$REGION" >/dev/null 2>&1 || true
fi

echo "  $(t "agentcore deploy（CodeZip，约 5-10 分钟）..." "agentcore deploy (CodeZip, ~5-10 min)...")"
# harness 依赖版本必须和入库的 lib/cdk-stack.ts 对得上。更新的 CLI 跑过一次就会把这里
# 顶到新版（见 §1 的注释），而 package.json 是入库文件 —— 客户的工作树会被留在
# "package.json 是新版、cdk-stack.ts 是旧版"的必挂状态，且下次重跑不会自愈。
HARNESS_PIN_EXPECTED="0.1.0-alpha.45"
HARNESS_PIN_ACTUAL="$(python3 -c "
import json,sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get('dependencies', {}).get('@aws/agentcore-cdk', ''))
except Exception:
    print('')
" "$AGENT_DIR/agentcore/cdk/package.json" 2>/dev/null || echo '')"
if [ -n "$HARNESS_PIN_ACTUAL" ] && [ "$HARNESS_PIN_ACTUAL" != "$HARNESS_PIN_EXPECTED" ]; then
  echo "  $(t "❌ CDK harness 依赖被改动：@aws/agentcore-cdk = $HARNESS_PIN_ACTUAL（应为 $HARNESS_PIN_EXPECTED）。" "❌ The CDK harness dependency was modified: @aws/agentcore-cdk = $HARNESS_PIN_ACTUAL (expected $HARNESS_PIN_EXPECTED).")" >&2
  echo "  $(t "   几乎一定是更新版的 agentcore CLI 改写过它 —— 与入库的 lib/cdk-stack.ts 不兼容，tsc 会失败。还原：" "   Almost certainly rewritten by a newer agentcore CLI — incompatible with the in-repo lib/cdk-stack.ts; tsc will fail. Restore it:")" >&2
  echo "     git checkout -- agent-build/NotiOpsWebChat/agentcore/cdk/package.json agent-build/NotiOpsWebChat/agentcore/cdk/package-lock.json" >&2
  echo "     rm -rf agent-build/NotiOpsWebChat/agentcore/cdk/node_modules && (cd agent-build/NotiOpsWebChat/agentcore/cdk && npm ci)" >&2
  echo "  $(t "   或者一条命令自动搞定：" "   Or fix it all with one command:")" >&2
  echo "     bash scripts/fix_web_chat_echo.sh --region $REGION" >&2
  exit 1
fi
# agentcore deploy 内部调 tsc 编译 CDK TypeScript，但不走 npx，要求 PATH 里有 tsc。
# 这里确保 cdk/ 已装依赖，再把其 node_modules/.bin 临时加入 PATH（不污染用户全局环境）。
# **不要**把这步的 stderr 丢进 /dev/null：它在 set -e 下失败会让整个脚本无声退出
# （客户看到的就是"agent 部署失败"四个字，没有任何原因）。用 npm ci 走锁文件；
# 没有锁文件的场景（客户手动删过）回退 npm install。
if ! ( cd "$AGENT_DIR/agentcore/cdk" \
       && { [ -f package-lock.json ] && npm ci --no-audit --no-fund || npm install --no-audit --no-fund; } ); then
  echo "  $(t "❌ 安装 CDK harness 依赖失败（agentcore/cdk）。上面的 npm 输出就是原因。" "❌ Failed to install the CDK harness dependencies (agentcore/cdk). The npm output above is the reason.")" >&2
  exit 1
fi
export PATH="$AGENT_DIR/agentcore/cdk/node_modules/.bin:$PATH"
# aws-targets.json 必须指向当前账户（不能 hardcode），否则 CDK 会尝试 AssumeRole 到错误账户。
python3 -c "
import json, sys
path = sys.argv[1]
targets = [{'name': 'default', 'account': sys.argv[2], 'region': sys.argv[3]}]
json.dump(targets, open(path, 'w'), indent=2)
" "$AGENT_DIR/agentcore/aws-targets.json" "$ACCT" "$REGION"
# agentcore CLI 自己会把完整的分步日志写到 agentcore/.cli/logs/deploy/deploy-<ts>.log，
# 但失败时终端上往往只剩一句概括。2026-08-26 那次事故里，真正的原因（tsc TS2561）
# 只存在于这份文件里 —— 没人知道去看它，于是排查绕了好几轮。失败即把它打出来。
if ! ( cd "$AGENT_DIR" && agentcore deploy -y ); then
  CLI_LOG="$(ls -t "$AGENT_DIR/agentcore/.cli/logs/deploy/"*.log 2>/dev/null | head -1 || true)"
  echo "" >&2
  echo "  $(t "❌ agentcore deploy 失败。" "❌ agentcore deploy failed.")" >&2
  if [ -n "$CLI_LOG" ]; then
    echo "  $(t "── agentcore CLI 自己的日志（$CLI_LOG，最后 60 行）──" "── The agentcore CLI's own log ($CLI_LOG, last 60 lines) ──")" >&2
    tail -60 "$CLI_LOG" | sed 's/^/    /' >&2
  else
    echo "  $(t "（未找到 CLI 日志：$AGENT_DIR/agentcore/.cli/logs/deploy/）" "(No CLI log found under $AGENT_DIR/agentcore/.cli/logs/deploy/)")" >&2
  fi
  exit 1
fi

# 部署已读取注入后的 agentcore.json；这里**还原为出厂值**，保持 git 跟踪文件干净
# （避免把本部署账号的 gateway URL / 桶名提交进仓库；客户每次部署时脚本会重新注入）。
#
# 注意：还原表必须覆盖 §3 注入的【全部】key，否则该 key 会带着本次部署的真值留在
# git 跟踪文件里 —— 历史上漏了 NOTIOPS_ALLOW_CROSS_ACCOUNT，org 模式部署后它被留成 "1"，
# 一旦误提交，后续任何客户 clone 出来的默认闸门就是【开启】的（安全默认被破坏）。
# NOTIOPS_ALLOW_CROSS_ACCOUNT 出厂值是空串（= 仅部署账号）而非 __占位符__：backfill 脚本
# 的核验会把 __X__ 形态当"未替换"告警，而空串正是这个 key 的合法默认值。
python3 - "$AGENTCORE_JSON" <<'PY'
import json, sys
path = sys.argv[1]
FACTORY = {
    "AGENTCORE_WEBSEARCH_GATEWAY_URL": "__WEBSEARCH_GATEWAY_URL__",
    "SKILLS_BUCKET": "__SKILLS_BUCKET__",
    "DEVOPS_AGENT_SPACE_ID": "__DEVOPS_AGENT_SPACE_ID__",
    "REPORTS_CDN_DOMAIN": "__REPORTS_CDN_DOMAIN__",
    "NOTIOPS_ALLOW_CROSS_ACCOUNT": "",   # 出厂 = 关闭（安全默认）
    "COST_AGENT_MCP_URL": "__COST_AGENT_MCP_URL__",
}
d = json.load(open(path))
for rt in d.get("runtimes", []):
    for ev in rt.get("envVars", []):
        if ev.get("name") in FACTORY:
            ev["value"] = FACTORY[ev["name"]]
json.dump(d, open(path, "w"), indent=2, ensure_ascii=False)
import os as _os
if _os.environ.get("UI_LANG") == "zh":
    print("    agentcore.json 已还原为占位符（git 跟踪文件保持干净）")
else:
    print("    agentcore.json restored to placeholders (keeps the git-tracked file clean)")
PY

# ── 4. 捕获 Runtime ARN（CloudFormation 输出最稳）──
ARN=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?contains(OutputKey,'RuntimeArn')].OutputValue | [0]" \
  --output text 2>/dev/null || echo "")
if [ -z "$ARN" ] || [ "$ARN" = "None" ]; then
  echo "  $(t "❌ 未能从 $STACK 捕获 Runtime ARN。" "❌ Failed to capture Runtime ARN from $STACK.")" >&2
  exit 1
fi
echo "  $(t "✓ Agent Runtime ARN:" "✓ Agent Runtime ARN:") $ARN"
[ -n "${AGENT_ARN_OUT:-}" ] && printf '%s' "$ARN" > "$AGENT_ARN_OUT"

# ── 5. 强制回填 env 真值 + idle 超时(部署后确定性纠偏,防"占位符上线"回归)──
# 背景:agentcore.json 里 env 出厂是占位符(__SKILLS_BUCKET__ 等),靠本脚本 §3 注入真值后
# 再 `agentcore deploy`。但实测 `agentcore deploy`(managedBy=CDK harness 合成路径)有时**不会**
# 把 envVars/lifecycleConfig 落到 runtime —— 结果 runtime 带着字面占位符上线:
#   · SKILLS_BUCKET=__SKILLS_BUCKET__ → reports.py 拿假桶名 put_object → NoSuchBucket
#     → What's New 完整版 / DevOps 调查在线报告 全都拿不到下载链接("存储桶不存在")。
#   · idleRuntimeSessionTimeout 回落 900 → 冷启动"无响应"。
# 根治:部署后用一次幂等的 update-agent-runtime **强制回填** §3 算好的 4 个 env 真值 + idle=3600,
# 再核验无残留占位符。这样即便 deploy 漏注入,占位符也永远上不了线。
# (代码侧 reports.py/skills.py 的 _env() 还会把漏网占位符降级成"未配置"兜底,双保险。)
#
# 回填/轮询/核验的实现统一收敛到 scripts/backfill_runtime_env.sh(单一权威,避免与
# setup.sh 里"部署后补 AgentSpaceId/ReportsCdnDomain"那处各写一份而漂移)。
# 这里传全部 6 个 env 真值 + idle=3600。注意:此刻 NotiOpsBackendStack 通常尚未部署
# (setup.sh 里 CDK 部署在本脚本之后),故 DEVOPS_AGENT_SPACE_ID / REPORTS_CDN_DOMAIN
# 此时多半为空 → 由 setup.sh 在 `cdk deploy --all` 之后再 merge-patch 补齐(不覆盖此处
# 已设的 gateway/桶)。单独跑本脚本(栈已存在)时,这里就能一次拿到全部真值。
#
# NOTIOPS_ALLOW_CROSS_ACCOUNT **必须**在这里显式回填(哪怕是空串),原因和上面那 4 个一样:
# `agentcore deploy` 有时不落 envVars,而 backfill 是 merge-patch —— 不传这个 key 就等于
# "保留 runtime 上的旧值",于是两个方向都会错:
#   · org 模式首次安装 → 闸门从未被设上 → 跨账号被默认拒绝(功能坏,静默)。
#   · 从 org 模式回退成单账号重跑 → 闸门仍是上次的 "1" → 跨账号一直开着(fail-open,更糟)。
# 显式传值把闸门变成部署模式的确定性函数:--multi-account → "1",否则 → ""。
REGION="$REGION" RT_ARN="$ARN" SET_IDLE=3600 UI_LANG="$UI_LANG" \
  bash "$PROJECT_ROOT/scripts/backfill_runtime_env.sh" \
    "SKILLS_BUCKET=$SKILLS_BUCKET" \
    "REPORTS_CDN_DOMAIN=$REPORTS_CDN_DOMAIN" \
    "DEVOPS_AGENT_SPACE_ID=$DEVOPS_AGENT_SPACE_ID" \
    "AGENTCORE_WEBSEARCH_GATEWAY_URL=$GATEWAY_URL" \
    "NOTIOPS_ALLOW_CROSS_ACCOUNT=$ALLOW_CROSS_ACCOUNT" \
    "COST_AGENT_MCP_URL=$COST_AGENT_MCP_URL" \
  || echo "  $(t "⚠ env 回填/idle 设置未完成(不阻断);可稍后重跑。" "⚠ env backfill / idle setting did not complete (non-blocking); re-run later.")" >&2
