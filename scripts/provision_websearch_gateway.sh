#!/usr/bin/env bash
# 一键 provision NotiOps 的 AgentCore Web Search 基础设施（GA 2026，仅 us-east-1）。
# 幂等：已存在则复用。完成后打印 AGENTCORE_WEBSEARCH_GATEWAY_URL，填进
# agent-build/.../agentcore/agentcore.json 的 runtime envVars（或 CDK 注入）后重新 agentcore deploy。
#
# 背景：AgentCore web search 没有独立 API，必须经 Gateway + web-search connector target 调用。
# 数据全程不出 AWS（查询文本不发给任何第三方搜索引擎）。agent 经 MCP+SigV4 调 Gateway。
# 这是**唯一**的联网搜索来源：没建 Gateway 的部署就是没有联网搜索能力（无第三方兜底）。
# 详见 memory web-chat-phase1-deploy 的 "AgentCore Web Search" 段。
set -euo pipefail

# ─── UI 语言（双语输出）───
# 继承调用方（deploy_agent.sh / setup.sh）导出的 UI_LANG（zh/en）；单独跑时默认英文。
# t "<中文>" "<English>"：按 UI_LANG 输出对应语言。
# export：让内嵌的 python3 heredoc 子进程也能读到 UI_LANG。
export UI_LANG="${UI_LANG:-en}"
t() { if [ "$UI_LANG" = "zh" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
GW_NAME="${GW_NAME:-notiops-websearch-gw}"
SVC_ROLE="${SVC_ROLE:-notiops-websearch-gateway-role}"
TARGET_NAME="web-search-tool"

if [ "$REGION" != "us-east-1" ]; then
  echo "$(t "⚠️  AgentCore Web Search 目前仅 us-east-1 可用，你设的是 ${REGION}。继续可能失败。" "⚠️  AgentCore Web Search is currently only available in us-east-1; you set ${REGION}. Continuing may fail.")" >&2
fi

# ── 1. Gateway 服务角色（信任 bedrock-agentcore + InvokeGateway/InvokeWebSearch）──
if ! aws iam get-role --role-name "$SVC_ROLE" >/dev/null 2>&1; then
  TRUST=$(cat <<EOF
{"Version":"2012-10-17","Statement":[{"Sid":"GatewayAssumeRolePolicy","Effect":"Allow",
"Principal":{"Service":"bedrock-agentcore.amazonaws.com"},"Action":"sts:AssumeRole",
"Condition":{"StringEquals":{"aws:SourceAccount":"${ACCOUNT}"},
"ArnLike":{"aws:SourceArn":"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:gateway/*"}}}]}
EOF
)
  aws iam create-role --role-name "$SVC_ROLE" --assume-role-policy-document "$TRUST" \
    --description "NotiOps AgentCore Gateway service role for Web Search" \
    --tags Key=auto-delete,Value=no Key=project,Value=notiops >/dev/null
  echo "$(t "✓ 创建服务角色 $SVC_ROLE" "✓ Created service role $SVC_ROLE")"
fi
# 幂等补标签：既有角色（老部署重跑）也补齐项目标签，与 CDK 资源(auto-delete=no + project=notiops)对齐。
aws iam tag-role --role-name "$SVC_ROLE" \
  --tags Key=auto-delete,Value=no Key=project,Value=notiops >/dev/null 2>&1 || true
PERMS=$(cat <<EOF
{"Version":"2012-10-17","Statement":[
{"Sid":"InvokeGateway","Effect":"Allow","Action":"bedrock-agentcore:InvokeGateway",
 "Resource":"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:gateway/*"},
{"Sid":"InvokeWebSearch","Effect":"Allow","Action":"bedrock-agentcore:InvokeWebSearch",
 "Resource":"arn:aws:bedrock-agentcore:${REGION}:aws:tool/web-search.v1"}]}
EOF
)
aws iam put-role-policy --role-name "$SVC_ROLE" --policy-name NotiOpsWebSearchGateway --policy-document "$PERMS"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${SVC_ROLE}"
echo "$(t "✓ 服务角色权限就绪：$ROLE_ARN" "✓ Service role permissions ready: $ROLE_ARN")"

# ── 2. Gateway（AWS_IAM 鉴权，MCP 协议）。已存在则复用；停在 FAILED 的删掉重建。──
gw_status() {
  aws bedrock-agentcore-control get-gateway --region "$REGION" \
    --gateway-identifier "$1" --query status --output text 2>/dev/null || echo "GONE"
}
GW_ID="$(aws bedrock-agentcore-control list-gateways --region "$REGION" \
  --query "items[?name=='${GW_NAME}'].gatewayId | [0]" --output text 2>/dev/null || echo "None")"
# 同名 Gateway 停在 FAILED 上时**不能**复用：它不会自己恢复，而按名字复用会让「第一次建
# 失败」永久化 —— 重跑多少次都是在同一个死 Gateway 上建 target。FAILED 的 Gateway 服务不了
# 任何请求，删掉重建不会毁掉任何还在工作的东西。
if [ -n "$GW_ID" ] && [ "$GW_ID" != "None" ]; then
  case "$(gw_status "$GW_ID")" in
    FAILED|UPDATE_UNSUCCESSFUL)
      echo "$(t "⚠️  已有 Gateway ${GW_ID} 建失败且不会自愈，删掉重建…" "⚠️  Existing Gateway ${GW_ID} failed to build and will not self-heal; replacing it…")" >&2
      # 有 target 时 Gateway 删不掉，先清 target —— 而且删 target 也是**异步**的，
      # DELETE 返回成功只表示"开始删了"。不等它真的消失就删 Gateway，会被服务端以
      # 「还挂着 target」拒掉；这里 `|| true` 又把失败吞了，于是就成了静默失败：
      # 脚本继续往下跑，那个死 Gateway 其实还在。
      for TID in $(aws bedrock-agentcore-control list-gateway-targets --region "$REGION" \
          --gateway-identifier "$GW_ID" --query 'items[].targetId' --output text 2>/dev/null || true); do
        aws bedrock-agentcore-control delete-gateway-target --region "$REGION" \
          --gateway-identifier "$GW_ID" --target-id "$TID" >/dev/null 2>&1 || true
      done
      for _ in $(seq 1 40); do   # 40 × 3s
        REMAINING="$(aws bedrock-agentcore-control list-gateway-targets --region "$REGION" \
          --gateway-identifier "$GW_ID" --query 'length(items)' --output text 2>/dev/null || echo 0)"
        if [ "$REMAINING" = "0" ] || [ "$REMAINING" = "None" ]; then break; fi
        sleep 3
      done
      aws bedrock-agentcore-control delete-gateway --region "$REGION" \
        --gateway-identifier "$GW_ID" >/dev/null 2>&1 || true
      # 删除是异步的，同名并存会让紧接着的 create 撞名字。
      for _ in $(seq 1 40); do
        if [ "$(gw_status "$GW_ID")" = "GONE" ]; then break; fi
        sleep 3
      done
      GW_ID="None"
      ;;
  esac
fi
if [ -z "$GW_ID" ] || [ "$GW_ID" = "None" ]; then
  GW_ID="$(aws bedrock-agentcore-control create-gateway --region "$REGION" \
    --name "$GW_NAME" --role-arn "$ROLE_ARN" --protocol-type MCP --authorizer-type AWS_IAM \
    --description "NotiOps web search (us-east-1)" --tags auto-delete=no,project=notiops \
    --query gatewayId --output text)"
  echo "$(t "✓ 创建 Gateway ${GW_ID}（等待 READY…）" "✓ Created Gateway ${GW_ID} (waiting for READY…)")"
else
  echo "$(t "✓ 复用已有 Gateway $GW_ID" "✓ Reusing existing Gateway $GW_ID")"
fi
# 复用的那个也要等：CREATING 中就去建 target 会失败。
# **等不到 READY 就直接退出**：接着往下走只会打印一个连不通的 Gateway URL，客户拿它配好
# agent，之后每次联网搜索都在超时上等 —— 那比这里当场报错难查得多。
GW_STATUS=""
for _ in $(seq 1 40); do
  GW_STATUS="$(gw_status "$GW_ID")"
  if [ "$GW_STATUS" = "READY" ]; then break; fi
  case "$GW_STATUS" in FAILED|UPDATE_UNSUCCESSFUL|GONE) break ;; esac
  sleep 3
done
if [ "$GW_STATUS" != "READY" ]; then
  echo "$(t "✗ Gateway ${GW_ID} 没到 READY（当前 ${GW_STATUS}）。用 aws bedrock-agentcore-control get-gateway --gateway-identifier ${GW_ID} --region ${REGION} 看 statusReasons；最常见的原因是当前身份缺 bedrock-agentcore:CreateWorkloadIdentity 权限。" "✗ Gateway ${GW_ID} never reached READY (now ${GW_STATUS}). Run aws bedrock-agentcore-control get-gateway --gateway-identifier ${GW_ID} --region ${REGION} and read statusReasons; the most common cause is the calling identity lacking bedrock-agentcore:CreateWorkloadIdentity.")" >&2
  exit 1
fi
# 幂等补标签：既有 Gateway（老部署重跑）也补齐项目标签，与 CDK 资源(auto-delete=no + project=notiops)对齐。
GW_ARN="arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:gateway/${GW_ID}"
aws bedrock-agentcore-control tag-resource --region "$REGION" \
  --resource-arn "$GW_ARN" --tags auto-delete=no,project=notiops >/dev/null 2>&1 || true
GW_URL="$(aws bedrock-agentcore-control get-gateway --region "$REGION" --gateway-identifier "$GW_ID" --query gatewayUrl --output text)"

# ── 3. web-search connector target。已存在则跳过。──
# web-search connector 是很新的 target 类型，需 **botocore>=1.43.36**；老版本（含 AWS CLI
# 自带的）会报 "Unknown parameter ... connector"。这里用 Python boto3 创建，并在 botocore
# 过旧时自动 pip 安装到一个临时目录（不污染系统环境），保证客户机器上也能成功。
GW_ID="$GW_ID" REGION="$REGION" TARGET_NAME="$TARGET_NAME" python3 - <<'PY'
import os, sys, subprocess, tempfile, shutil

# 实际建 target 的逻辑。始终在【全新子进程】里跑（见下），这样 botocore 需要升级时，
# 干净进程会从头 import 新版 boto3/botocore；绝不在本进程删 sys.modules 再 import
# （旧写法那样会拿到半初始化模块，报 "module 'boto3' has no attribute 'client'"）。
WORK = r'''
import os, boto3
_zh = os.environ.get("UI_LANG") == "zh"
region = os.environ["REGION"]; gw = os.environ["GW_ID"]; name = os.environ["TARGET_NAME"]
c = boto3.client("bedrock-agentcore-control", region_name=region)
existing = c.list_gateway_targets(gatewayIdentifier=gw).get("items", [])
if any(t.get("name") == name for t in existing):
    print(f"✓ 复用已有 target {name}" if _zh else f"✓ Reusing existing target {name}")
else:
    r = c.create_gateway_target(
        gatewayIdentifier=gw, name=name,
        targetConfiguration={"mcp": {"connector": {
            "source": {"connectorId": "web-search"},
            "configurations": [{"name": "WebSearch", "parameterValues": {}}]}}},
        credentialProviderConfigurations=[{"credentialProviderType": "GATEWAY_IAM_ROLE"}],
    )
    print(f"✓ 创建 web-search target {r.get('targetId')}" if _zh else f"✓ Created web-search target {r.get('targetId')}")
'''

# web-search connector 是很新的 target 类型，需 botocore>=1.43.36；过旧就装到临时目录
# （不污染系统环境）并把它前置到子进程的 PYTHONPATH。
env = dict(os.environ)
need_upgrade = True
try:
    import botocore
    v = tuple(int(x) for x in botocore.__version__.split(".")[:3])
    need_upgrade = v < (1, 43, 36)
except Exception:
    need_upgrade = True

def _install_newer_boto(tgt):
    """把新版 boto3/botocore 装进一个【全新的空目录】 tgt。
    关键：安装前先 rm -rf 掉旧内容——固定路径复用 + pip --target 不带 --upgrade 时，
    pip 见目录已存在会整包跳过（"Target directory ... already exists"），旧/半装/层叠
    的坏包永远不会被修，最终子进程 import 到一个残缺的 namespace 包（boto3 无 .client）。
    每次装进干净目录，杜绝历史脏状态。"""
    shutil.rmtree(tgt, ignore_errors=True)
    os.makedirs(tgt, exist_ok=True)
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q",
                           "--target", tgt, "botocore>=1.43.36", "boto3>=1.40.36"])

def _boto_is_healthy(tgt):
    """在【全新子进程】里从 tgt 验证 boto3 真能用（有 .client）。绝不在本进程 import，
    避免污染/半初始化。健康返回 True。"""
    probe = ("import boto3, sys; "
             "sys.exit(0 if hasattr(boto3, 'client') else 1)")
    e = dict(os.environ)
    e["PYTHONPATH"] = tgt + os.pathsep + e.get("PYTHONPATH", "")
    return subprocess.call([sys.executable, "-c", probe], env=e) == 0

if need_upgrade:
    tgt = os.path.join(os.environ.get("TMPDIR", "/tmp"), "notiops-botocore-newer")
    _install_newer_boto(tgt)
    # 自愈：万一装出来仍不健康（网络中断/并发/磁盘满等半成品），再清一次重装；仍不行才报错。
    if not _boto_is_healthy(tgt):
        _install_newer_boto(tgt)
        if not _boto_is_healthy(tgt):
            sys.exit("boto3/botocore install into %s is unusable (no boto3.client) after retry" % tgt)
    env["PYTHONPATH"] = tgt + os.pathsep + env.get("PYTHONPATH", "")

# 用临时文件承载 WORK（UTF-8 写入，编码安全），交给全新解释器执行。
with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
    f.write(WORK)
    work_path = f.name
try:
    subprocess.check_call([sys.executable, work_path], env=env)
finally:
    try:
        os.unlink(work_path)
    except OSError:
        pass
PY

# gatewayUrl 可能已含 /mcp 后缀（实测含）；幂等补：缺了才加，避免 /mcp/mcp。
MCP_URL="${GW_URL%/}"
case "$MCP_URL" in
  */mcp) : ;;            # 已以 /mcp 结尾
  *) MCP_URL="$MCP_URL/mcp" ;;
esac
echo ""
echo "$(t "================ 完成 ================" "================ Done ================")"
echo "$(t "Gateway URL（填进 agentcore.json 的 envVars.AGENTCORE_WEBSEARCH_GATEWAY_URL）：" "Gateway URL (set into agentcore.json envVars.AGENTCORE_WEBSEARCH_GATEWAY_URL):")"
echo "  $MCP_URL"
echo "$(t "然后重新 agentcore deploy。" "Then re-run agentcore deploy.")"
echo "$(t "agent 执行角色的 InvokeGateway 权限已在 agentcore 的 CDK(cdk-stack.ts)里授予，无需手动。" "The agent execution role's InvokeGateway permission is already granted in agentcore's CDK (cdk-stack.ts); no manual step needed.")"
