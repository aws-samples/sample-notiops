#!/usr/bin/env bash
# 部署 NotiOps Web Chat 的 AgentCore Runtime（Strands agent）。
#
# 由 setup.sh 调用（也可单独跑）。流程：
#   1. 确保 agentcore CLI 可用（公共 npm 包 @aws/agentcore）。
#   2. （可选）provision web-search Gateway 并把 URL 注入 agentcore.json 的 envVars。
#   3. agentcore deploy（CodeZip 构建，无需 docker/finch）。
#   4. 从 CloudFormation 输出捕获 Runtime ARN，打印 + 写入 $AGENT_ARN_OUT（若设了）。
#
# 输入（env）：
#   DEPLOY_REGION         必填，部署区域（agentcore runtime 区）。
#   PROJECT_ROOT          仓库根（默认脚本上级目录）。
#   ENABLE_WEBSEARCH      "true"(默认) 则 provision web-search Gateway 并注入 URL；
#                         "false" 则跳过（agent 仍可用 Exa 兜底联网搜索）。
#   AGENT_ARN_OUT         可选，把捕获到的 Runtime ARN 写到这个文件路径。
#
# 退出码非 0 表示失败；setup.sh 据此决定是否回退 echo BFF。
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AGENT_DIR="$PROJECT_ROOT/agent-build/NotiOpsWebChat"
REGION="${DEPLOY_REGION:?DEPLOY_REGION required}"
ENABLE_WEBSEARCH="${ENABLE_WEBSEARCH:-true}"
STACK="AgentCore-NotiOpsWebChat-default"

if [ ! -d "$AGENT_DIR" ]; then
  echo "  ⚠ 未找到 agent 工程目录 $AGENT_DIR，跳过 agent 部署。" >&2
  exit 1
fi

# ── 1. agentcore CLI ──
if ! command -v agentcore >/dev/null 2>&1; then
  echo "  安装 AgentCore CLI（@aws/agentcore）..."
  npm install -g @aws/agentcore >/dev/null 2>&1 || {
    echo "  ❌ 无法安装 agentcore CLI；请手动 'npm install -g @aws/agentcore' 后重试。" >&2
    exit 1
  }
fi

export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" CDK_DEFAULT_REGION="$REGION"
[ -n "${AWS_PROFILE:-}" ] && export AWS_PROFILE

# ── 2. Web Search Gateway（可选）──
# AgentCore web search 仅 us-east-1。非该区时自动跳过（不阻断；agent 用 Exa 兜底）。
GATEWAY_URL=""
if [ "$ENABLE_WEBSEARCH" = "true" ] && [ "$REGION" = "us-east-1" ]; then
  echo "  provision AgentCore Web Search Gateway..."
  # 脚本打印形如 "  <url>/mcp"；抓最后一个 https://...mcp。
  if GW_OUT=$(AWS_REGION="$REGION" bash "$PROJECT_ROOT/scripts/provision_websearch_gateway.sh" 2>&1); then
    GATEWAY_URL=$(printf '%s\n' "$GW_OUT" | grep -oE 'https://[^ ]+/mcp' | tail -1)
    echo "$GW_OUT" | sed 's/^/    /'
  else
    echo "$GW_OUT" | sed 's/^/    /'
    echo "  ⚠ Gateway provision 失败 —— agent 仍会用 Exa 兜底联网搜索，不阻断部署。" >&2
  fi
elif [ "$ENABLE_WEBSEARCH" = "true" ]; then
  echo "  （AgentCore Web Search 仅 us-east-1 可用，当前 $REGION 跳过；agent 用 Exa 兜底。）"
fi

# 注入 env 占位符到 agentcore.json：
#  - __WEBSEARCH_GATEWAY_URL__：web-search Gateway（空串 → agent 用 Exa 兜底）
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
python3 - "$AGENTCORE_JSON" "$GATEWAY_URL" "$SKILLS_BUCKET" "$DEVOPS_AGENT_SPACE_ID" "$REPORTS_CDN_DOMAIN" <<'PY'
import json, sys
path, url, skills_bucket, da_space = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
reports_cdn = sys.argv[5] if len(sys.argv) > 5 else ""
d = json.load(open(path))
for rt in d.get("runtimes", []):
    for ev in rt.get("envVars", []):
        if ev.get("name") == "AGENTCORE_WEBSEARCH_GATEWAY_URL":
            ev["value"] = url  # 空串=未启用，agent 用 Exa 兜底
        elif ev.get("name") == "SKILLS_BUCKET":
            ev["value"] = skills_bucket  # 空串=skills 读取关闭（不阻断）
        elif ev.get("name") == "DEVOPS_AGENT_SPACE_ID":
            ev["value"] = da_space  # 空串=运行时 ListAgentSpaces 自动发现
        elif ev.get("name") == "REPORTS_CDN_DOMAIN":
            ev["value"] = reports_cdn  # 空串=reports.py 回退 presigned(12h)
        elif ev.get("name") == "NOTIOPS_ALLOW_CROSS_ACCOUNT":
            import os as _os
            ev["value"] = _os.environ.get("NOTIOPS_ALLOW_CROSS_ACCOUNT", "")  # org 模式传 1 = 放开跨账号闸门
json.dump(d, open(path, "w"), indent=2, ensure_ascii=False)
print(f"    agentcore.json 已写入 gateway URL: {url or '(空，用 Exa 兜底)'}; "
      f"SKILLS_BUCKET: {skills_bucket or '(空)'}; "
      f"DEVOPS_AGENT_SPACE_ID: {da_space or '(空，运行时自动发现)'}; "
      f"REPORTS_CDN_DOMAIN: {reports_cdn or '(空，回退 presigned)'}")
PY

# ── 3. 部署 ──
# agentcore deploy 底层用 CDK，需要账号已 bootstrap。setup.sh 的 bootstrap 在更后面，
# 故这里先幂等 bootstrap 一次（已 bootstrap 则秒过），避免新账号首次部署失败。
ACCT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")"
if [ -n "$ACCT" ]; then
  npx --yes cdk bootstrap "aws://$ACCT/$REGION" >/dev/null 2>&1 || true
fi

echo "  agentcore deploy（CodeZip，约 5-10 分钟）..."
# agentcore deploy 内部调 tsc 编译 CDK TypeScript，但不走 npx，要求 PATH 里有 tsc。
# 这里确保 cdk/ 已装依赖，再把其 node_modules/.bin 临时加入 PATH（不污染用户全局环境）。
( cd "$AGENT_DIR/agentcore/cdk" && npm install --silent 2>/dev/null )
export PATH="$AGENT_DIR/agentcore/cdk/node_modules/.bin:$PATH"
# aws-targets.json 必须指向当前账户（不能 hardcode），否则 CDK 会尝试 AssumeRole 到错误账户。
python3 -c "
import json, sys
path = sys.argv[1]
targets = [{'name': 'default', 'account': sys.argv[2], 'region': sys.argv[3]}]
json.dump(targets, open(path, 'w'), indent=2)
" "$AGENT_DIR/agentcore/aws-targets.json" "$ACCT" "$REGION"
( cd "$AGENT_DIR" && agentcore deploy -y )

# 部署已读取注入后的 agentcore.json；这里**还原为占位符**，保持 git 跟踪文件干净
# （避免把本部署账号的 gateway URL / 桶名提交进仓库；客户每次部署时脚本会重新注入）。
python3 - "$AGENTCORE_JSON" <<'PY'
import json, sys
path = sys.argv[1]
d = json.load(open(path))
for rt in d.get("runtimes", []):
    for ev in rt.get("envVars", []):
        if ev.get("name") == "AGENTCORE_WEBSEARCH_GATEWAY_URL":
            ev["value"] = "__WEBSEARCH_GATEWAY_URL__"
        elif ev.get("name") == "SKILLS_BUCKET":
            ev["value"] = "__SKILLS_BUCKET__"
        elif ev.get("name") == "DEVOPS_AGENT_SPACE_ID":
            ev["value"] = "__DEVOPS_AGENT_SPACE_ID__"
        elif ev.get("name") == "REPORTS_CDN_DOMAIN":
            ev["value"] = "__REPORTS_CDN_DOMAIN__"
json.dump(d, open(path, "w"), indent=2, ensure_ascii=False)
print("    agentcore.json 已还原为占位符（git 跟踪文件保持干净）")
PY

# ── 4. 捕获 Runtime ARN（CloudFormation 输出最稳）──
ARN=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?contains(OutputKey,'RuntimeArn')].OutputValue | [0]" \
  --output text 2>/dev/null || echo "")
if [ -z "$ARN" ] || [ "$ARN" = "None" ]; then
  echo "  ❌ 未能从 $STACK 捕获 Runtime ARN。" >&2
  exit 1
fi
echo "  ✓ Agent Runtime ARN: $ARN"
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
# ARN 形如 arn:aws:bedrock-agentcore:<region>:<acct>:runtime/<RuntimeId>；runtime 前是**冒号**不是斜杠。
# 老写法 's#.*/runtime/##' 要求 runtime 前有 /，匹配不到 → RT_ID 残留为完整 ARN → 后续
# get/update-agent-runtime --agent-runtime-id <ARN> 全部失败 → 轮询超时跳过 idle 回填 → idle 回落 900
# (冷启动"无响应"回归)。这里同时接受 :runtime/ 与 /runtime/，只取末段 RuntimeId。
RT_ID="${ARN##*/}"
echo "  回填 runtime env 真值 + idleRuntimeSessionTimeout=3600s(runtime=$RT_ID)…"
# 时序修复:agentcore deploy 刚结束时 runtime 可能还在 CREATING/UPDATING,get 会取不到配置
# 或 update 被拒。轮询等 runtime 就绪(拿到配置且状态非过渡态)最多 ~1 分钟,再 update;
# update 若因状态过渡失败,再重试几次。避免"未取到配置→跳过→idle 回落 900"的老坑。
CUR=""
for i in $(seq 1 12); do
  CUR=$(aws bedrock-agentcore-control get-agent-runtime --region "$REGION" \
    --agent-runtime-id "$RT_ID" --output json 2>/dev/null || echo "")
  ST=$(printf '%s' "$CUR" | python3 -c "import sys,json;
try: print(json.load(sys.stdin).get('status',''))
except Exception: print('')" 2>/dev/null || echo "")
  # 拿到配置且不在过渡态(CREATING/UPDATING)→ 可以 update
  if [ -n "$CUR" ] && [ "$ST" != "CREATING" ] && [ "$ST" != "UPDATING" ] && [ -n "$ST" ]; then
    break
  fi
  [ "$i" -lt 12 ] && sleep 6
done
if [ -n "$CUR" ] && printf '%s' "$CUR" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  UPD_JSON="${TMPDIR:-/tmp}/notiops-rt-idle-update.json"
  # 把 §3 算好的 4 个 env 真值传进去强制回填(空串保留空串 = 该功能未启用,不是占位符)。
  printf '%s' "$CUR" | python3 - "$UPD_JSON" \
      "$SKILLS_BUCKET" "$REPORTS_CDN_DOMAIN" "$DEVOPS_AGENT_SPACE_ID" "$GATEWAY_URL" <<'PY'
import json, sys
d = json.load(sys.stdin)
skills_bucket, reports_cdn, da_space, gw_url = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
env = dict(d.get("environmentVariables") or {})
# 强制回填部署真值(覆盖 deploy 可能漏注入的占位符);MEMORY_* 等框架注入的 env 原样保留。
env["SKILLS_BUCKET"] = skills_bucket
env["REPORTS_CDN_DOMAIN"] = reports_cdn
env["DEVOPS_AGENT_SPACE_ID"] = da_space
env["AGENTCORE_WEBSEARCH_GATEWAY_URL"] = gw_url
out = {
  "agentRuntimeId": d["agentRuntimeId"],
  "agentRuntimeArtifact": d["agentRuntimeArtifact"],
  "roleArn": d["roleArn"],
  "networkConfiguration": d["networkConfiguration"],
  "environmentVariables": env,
  "metadataConfiguration": d.get("metadataConfiguration", {}),
  "lifecycleConfiguration": {
    "idleRuntimeSessionTimeout": 3600,
    "maxLifetime": d.get("lifecycleConfiguration", {}).get("maxLifetime", 28800),
  },
}
json.dump(out, open(sys.argv[1], "w"))
PY
  IDLE_OK=false
  for j in 1 2 3; do
    if aws bedrock-agentcore-control update-agent-runtime --region "$REGION" \
         --cli-input-json "file://$UPD_JSON" >/dev/null 2>&1; then
      IDLE_OK=true; break
    fi
    [ "$j" -lt 3 ] && sleep 8   # 可能 runtime 又进入 UPDATING,等一下重试
  done
  if [ "$IDLE_OK" = true ]; then
    echo "  ✓ env 真值已回填 + idle 超时已设为 1 小时"
  else
    echo "  ⚠ env 回填/idle 设置失败(不阻断);可稍后手动 update-agent-runtime 回填 env 真值 + idle=3600。" >&2
  fi
  rm -f "$UPD_JSON"

  # ── 部署后核验:runtime env 不得残留 __占位符__(漏注入的最后一道闸)──
  # 等 update 落定后重新 get,发现任何 __FOO__ 值就告警(不阻断,但明确暴露)。
  for j in 1 2 3 4 5; do
    VCUR=$(aws bedrock-agentcore-control get-agent-runtime --region "$REGION" \
      --agent-runtime-id "$RT_ID" --output json 2>/dev/null || echo "")
    VST=$(printf '%s' "$VCUR" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('status',''))
except Exception: print('')" 2>/dev/null || echo "")
    [ "$VST" = "READY" ] && break
    sleep 6
  done
  if [ -n "$VCUR" ]; then
    LEFT=$(printf '%s' "$VCUR" | python3 -c "import sys,json
d=json.load(sys.stdin); env=d.get('environmentVariables') or {}
bad=[k for k,v in env.items() if isinstance(v,str) and v.startswith('__') and v.endswith('__')]
print(','.join(sorted(bad)))" 2>/dev/null || echo "")
    if [ -n "$LEFT" ]; then
      echo "  ⚠ 部署后核验:runtime env 仍有占位符未替换 → $LEFT(报告/skills/联网搜索可能不可用)。" >&2
    else
      echo "  ✓ 部署后核验:runtime env 无残留占位符"
    fi
  fi
else
  echo "  ⚠ 未取到 runtime 当前配置(等待超时),跳过 env 回填/idle 设置(不阻断);可稍后手动设置。" >&2
fi
