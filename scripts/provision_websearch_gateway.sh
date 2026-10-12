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

# ── 用「够新的 botocore」跑一段 Python（$1 = .py 文件路径）──
# 本机 botocore（以及 AWS CLI 自带的服务模型）可能太旧：web-search connector target 要
# botocore>=1.43.36；老模型还把 create-gateway 的 authorizerConfiguration 标成必填（客户现场
# 2026-10，见下面 create-gateway 那段）。过旧就装一份新的进临时目录，在全新子进程里跑。
py_with_new_botocore() {
WORK_PY="$1" python3 - <<'PY'
import os, sys, subprocess, tempfile, shutil

# 要跑的 Python 在 $WORK_PY 指向的文件里。始终在【全新子进程】里跑（见下），这样 botocore
# 需要升级时，干净进程会从头 import 新版 boto3/botocore；绝不在本进程删 sys.modules 再 import
# （旧写法那样会拿到半初始化模块，报 "module 'boto3' has no attribute 'client'"）。

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

def _boto_is_healthy(tgt, quiet=False):
    """在【全新子进程】里从 tgt 验证 boto3 真能用（有 .client）且 botocore 够新（>=1.43.36）。
    绝不在本进程 import，避免污染/半初始化。健康返回 True。"""
    if not os.path.isdir(tgt):
        return False
    probe = ("import boto3, botocore, sys; "
             "v = tuple(int(x) for x in botocore.__version__.split('.')[:3]); "
             "sys.exit(0 if hasattr(boto3, 'client') and v >= (1, 43, 36) else 1)")
    e = dict(os.environ)
    e["PYTHONPATH"] = tgt + os.pathsep + e.get("PYTHONPATH", "")
    out = subprocess.DEVNULL if quiet else None
    return subprocess.call([sys.executable, "-c", probe], env=e, stdout=out, stderr=out) == 0

if need_upgrade:
    tgt = os.path.join(os.environ.get("TMPDIR", "/tmp"), "notiops-botocore-newer")
    # 先看上一次（或本次部署里前一次调用）装好的那份还能不能用：健康而且够新就直接复用。
    # 🔴 2026-10-12 现网实测：这里原来每次调用都清空重装约 31 MB，到 PyPI 慢的机器上一次就是
    # 2 分 54 秒；一次首装部署要调两次（建 Gateway + 建 target），就是两遍。复用前的体检就是
    # 下面同一个 _boto_is_healthy —— 半装、损坏、版本旧的一律不复用，照旧清空重装。
    if not _boto_is_healthy(tgt, quiet=True):
        _install_newer_boto(tgt)
    # 自愈：万一装出来仍不健康（网络中断/并发/磁盘满等半成品），再清一次重装；仍不行才报错。
    if not _boto_is_healthy(tgt):
        _install_newer_boto(tgt)
        if not _boto_is_healthy(tgt):
            sys.exit("boto3/botocore install into %s is unusable (no boto3.client) after retry" % tgt)
    env["PYTHONPATH"] = tgt + os.pathsep + env.get("PYTHONPATH", "")

subprocess.check_call([sys.executable, os.environ["WORK_PY"]], env=env)
PY
}

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
  # ⚠️ stderr 单独接住再判：客户现场（2026-10，us-east-1）报的是
  #    `aws: [ERROR]: the following arguments are required: --authorizer-configuration`。
  #    那是**本机 AWS CLI 的服务模型太旧** —— 早期模型把这个参数标成必填，而现行 API
  #    只在 CUSTOM_JWT 时才要它，AWS_IAM 根本用不上。原样透出那行 argparse 报错，客户
  #    只会以为是我们漏传了参数。
  _GW_ERR="$(mktemp)"
  if ! GW_ID="$(aws bedrock-agentcore-control create-gateway --region "$REGION" \
      --name "$GW_NAME" --role-arn "$ROLE_ARN" --protocol-type MCP --authorizer-type AWS_IAM \
      --description "NotiOps web search (us-east-1)" --tags auto-delete=no,project=notiops \
      --query gatewayId --output text 2>"$_GW_ERR")"; then
    if grep -q -- '--authorizer-configuration' "$_GW_ERR"; then
      # 本机 CLI 的服务模型太旧（botocore 1.40.x 的模型里 authorizerConfiguration 还是必填，
      # 1.43.x 已不是）。不必让客户先去升级 CLI：换用新版 botocore 在子进程里建同一个 Gateway。
      echo "$(t "⚠ 本机 AWS CLI 太旧（$(aws --version 2>&1 | awk '{print $1}')），它把 --authorizer-configuration 标成了必填；改用新版 boto3 创建 Gateway…" \
                "⚠ Local AWS CLI is too old ($(aws --version 2>&1 | awk '{print $1}')); it marks --authorizer-configuration as required. Creating the Gateway with a newer boto3 instead…")" >&2
      _GW_PY="$(mktemp)"
      cat > "$_GW_PY" <<'PY'
import os, boto3
c = boto3.client("bedrock-agentcore-control", region_name=os.environ["REGION"])
r = c.create_gateway(
    name=os.environ["GW_NAME"], roleArn=os.environ["ROLE_ARN"],
    protocolType="MCP", authorizerType="AWS_IAM",
    description="NotiOps web search (us-east-1)",
    tags={"auto-delete": "no", "project": "notiops"})
print("GATEWAY_ID=" + r["gatewayId"])
PY
      GW_ID="$(REGION="$REGION" GW_NAME="$GW_NAME" ROLE_ARN="$ROLE_ARN" \
        py_with_new_botocore "$_GW_PY" 2>>"$_GW_ERR" | sed -n 's/^GATEWAY_ID=//p' | tail -1 || true)"
      rm -f "$_GW_PY"
    fi
    if [ -z "$GW_ID" ] || [ "$GW_ID" = "None" ]; then
      cat "$_GW_ERR" >&2
      if grep -q -- '--authorizer-configuration' "$_GW_ERR"; then
        echo "" >&2
        echo "$(t "❌ 本机 AWS CLI 太旧（把 --authorizer-configuration 标成了必填，AWS_IAM 鉴权的 Gateway 其实不需要它），" \
                  "❌ Your local AWS CLI is too old (it marks --authorizer-configuration as required; an AWS_IAM gateway does not need it),")" >&2
        echo "$(t "   改用新版 boto3 建也没成功，原因见上面的输出（装不上新版 boto3 时多半是本机连不上 PyPI）。" \
                  "   and the newer-boto3 fallback failed too; see the output above (if installing boto3 failed, the machine likely cannot reach PyPI).")" >&2
        echo "   $(t "当前版本：" "Current version: ")$(aws --version 2>&1)" >&2
        echo "$(t "   处理：把 AWS CLI v2 升到最新版，再重跑 ./setup.sh（已部署的栈走更新，不重建）。" \
                  "   Fix: upgrade AWS CLI v2 to the latest release, then re-run ./setup.sh (deployed stacks are updated, not recreated).")" >&2
        echo "     macOS (Homebrew): brew upgrade awscli" >&2
        echo "     macOS (pkg) / Linux: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" >&2
      fi
      rm -f "$_GW_ERR"
      exit 1
    fi
  fi
  rm -f "$_GW_ERR"
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
_TGT_PY="$(mktemp)"
cat > "$_TGT_PY" <<'PY'
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
PY
GW_ID="$GW_ID" REGION="$REGION" TARGET_NAME="$TARGET_NAME" py_with_new_botocore "$_TGT_PY" \
  || { rm -f "$_TGT_PY"; exit 1; }
rm -f "$_TGT_PY"

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
