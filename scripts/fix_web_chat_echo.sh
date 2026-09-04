#!/usr/bin/env bash
# 一键修复「部署成功了,但 Web Chat 一提问只把我的话回显回来」。
# One-shot repair for "the deployment succeeded but Web Chat only echoes my question".
#
# 症状 / Symptom:
#   Got it — you said: "…"
#   (Echo — AGENT_RUNTIME_ARN not set; deploy the agent runtime to enable the real agent.)
#
# 这个症状永远只有一个直接原因:**AgentCore Runtime 没上线**,于是 BFF 的
# AGENT_RUNTIME_ARN 是空串,只能回显。而 agent 上不了线在客户侧实测有两条路径:
#   ① 机器上没有 uv —— agentcore 打 Python 包时无条件调 `uv pip install`,必失败。
#   ② agentcore CLI 版本漂了 —— 该包约每周发一版。更新版的 `agentcore deploy` 有一步
#      "Sync CDK dependencies",会**擅自改写仓库里已入库的** agentcore/cdk/package.json
#      (把 @aws/agentcore-cdk 顶到新版),而入库的 lib/cdk-stack.ts 是钉住那版生成的
#      → tsc 编译报错(例:TS2561 connectorName → connector)→ deploy 十几秒即挂。
#      **被改写的 package.json 会留在工作树里,重跑不会自愈,光把 CLI 降级也不够。**
# 两条路径的共同点是"失败是静默的":栈没建、没有 Runtime ARN,而 web 端照常部署完、
# Chat URL 照常打印。本脚本把这两条都查一遍、修掉,然后把 agent 重新拉起并注入 BFF。
#
# 全部动作只在**本机文件 + 本账号已有的 NotiOps 部署**上进行:先做一遍只读体检并打印
# 结论,要动手之前会停下来让你确认(-y 跳过)。不删任何 AWS 资源。
#
# 用法 / Usage:
#   bash scripts/fix_web_chat_echo.sh                  # 体检 → 确认 → 修
#   bash scripts/fix_web_chat_echo.sh -y               # 不问,直接修
#   bash scripts/fix_web_chat_echo.sh --diagnose        # 只体检,什么都不改
#   bash scripts/fix_web_chat_echo.sh --region ap-northeast-1
#   UI_LANG=zh bash scripts/fix_web_chat_echo.sh       # 中文输出(默认英文)
set -euo pipefail

export UI_LANG="${UI_LANG:-en}"
t() { if [ "$UI_LANG" = "zh" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
say() { printf '%s\n' "$1"; }
hr() { printf '%s\n' "────────────────────────────────────────────────────────────────"; }

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$PROJECT_ROOT/agent-build/NotiOpsWebChat"
CDK_HARNESS_DIR="$AGENT_DIR/agentcore/cdk"
BFF_FN="notiops-web-chat-bff"
AGENT_STACK="AgentCore-NotiOpsWebChat-default"
ARN_OUT="${TMPDIR:-/tmp}/notiops-agent-arn.txt"

ASSUME_YES=0
DIAGNOSE_ONLY=0
REGION_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)       ASSUME_YES=1 ;;
    --diagnose|--dry-run) DIAGNOSE_ONLY=1 ;;
    --region)       REGION_ARG="${2:-}"; shift ;;
    --region=*)     REGION_ARG="${1#--region=}" ;;
    -h|--help)      sed -n '2,/^set -/{/^set -/d;p;}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "$(t "未知参数: $1（-h 看用法）" "Unknown argument: $1 (see -h)")" >&2; exit 2 ;;
  esac
  shift
done

# ── 权威版本号:只从 scripts/deploy_agent.sh 读,不在这里复制字面量 ──
# 复制一份就会漂:哪天升级了 pin,这个脚本会把客户指去装错的版本。
DEPLOY_AGENT_SH="$PROJECT_ROOT/scripts/deploy_agent.sh"
if [ ! -f "$DEPLOY_AGENT_SH" ]; then
  echo "$(t "❌ 找不到 $DEPLOY_AGENT_SH —— 请在 NotiOps 仓库根目录下跑本脚本。" \
            "❌ $DEPLOY_AGENT_SH not found — run this script from inside the NotiOps repo.")" >&2
  exit 1
fi
CLI_PIN="$(grep -oE 'AGENTCORE_CLI_VERSION:-[0-9]+\.[0-9]+\.[0-9]+' "$DEPLOY_AGENT_SH" | head -1 | cut -d- -f2- || true)"
HARNESS_PIN="$(grep -oE 'HARNESS_PIN_EXPECTED="[^"]+"' "$DEPLOY_AGENT_SH" | head -1 | cut -d'"' -f2 || true)"
if [ -z "$CLI_PIN" ] || [ -z "$HARNESS_PIN" ]; then
  echo "$(t "❌ 无法从 scripts/deploy_agent.sh 读出钉住的版本号（CLI='$CLI_PIN' harness='$HARNESS_PIN'）。" \
            "❌ Could not read the pinned versions out of scripts/deploy_agent.sh (CLI='$CLI_PIN' harness='$HARNESS_PIN').")" >&2
  exit 1
fi

# ── 区域 ──
REGION="${REGION_ARG:-${DEPLOY_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}}"
[ -n "$REGION" ] || REGION="$(aws configure get region 2>/dev/null || true)"
if [ -z "$REGION" ]; then
  echo "$(t "❌ 没解析出区域。用 --region <region> 指定（NotiOps 部署在哪个区就写哪个）。" \
            "❌ No region resolved. Pass --region <region> (the region NotiOps was deployed into).")" >&2
  exit 1
fi
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" DEPLOY_REGION="$REGION"

say ""
hr
say "$(t "NotiOps — 修复「部署成功但 Web Chat 只回显」" "NotiOps — repair \"deployed but Web Chat only echoes\"")"
hr
say "$(t "仓库:" "Repo:   ") $PROJECT_ROOT"
say "$(t "区域:" "Region: ") $REGION"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
if [ -z "$ACCOUNT" ] || [ "$ACCOUNT" = "None" ]; then
  echo "$(t "❌ 拿不到 AWS 身份。先确认凭证可用：aws sts get-caller-identity" \
            "❌ Cannot resolve an AWS identity. Check your credentials first: aws sts get-caller-identity")" >&2
  exit 1
fi
say "$(t "账号:" "Account:") $ACCOUNT"

# NotiOps 本体必须已经部署过,否则这不是"回显"问题,而是"还没装"。
if ! aws cloudformation describe-stacks --region "$REGION" --stack-name NotiOpsBackendStack \
     >/dev/null 2>&1; then
  echo "" >&2
  echo "$(t "❌ 在 $REGION 找不到 NotiOpsBackendStack。" "❌ NotiOpsBackendStack does not exist in $REGION.")" >&2
  echo "$(t "   要么区域填错了（用 --region 指定），要么这个账号还没部署过 NotiOps（先跑 ./setup.sh）。" \
            "   Either the region is wrong (pass --region) or NotiOps was never deployed here (run ./setup.sh first).")" >&2
  exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════
# 一、只读体检
# ═══════════════════════════════════════════════════════════════════════════
say ""
say "$(t "① 体检（只读，什么都不改）" "① Diagnosis (read-only, changes nothing)")"
hr

NEED_UV=0 NEED_CLI=0 NEED_HARNESS=0 NEED_AGENT=0 NEED_INJECT=0

# --- uv ---
if ! command -v uv >/dev/null 2>&1; then
  for d in "$HOME/.local/bin" "$HOME/.cargo/bin"; do
    [ -x "$d/uv" ] && { PATH="$d:$PATH"; export PATH; break; }
  done
fi
if command -v uv >/dev/null 2>&1; then
  say "  ✓ uv                $(uv --version 2>/dev/null | head -1)"
else
  NEED_UV=1
  say "  ✗ uv                $(t "缺失 —— agentcore 打 Python 包必须用它" "missing — the agentcore CLI needs it to package the Python deps")"
fi

# --- node ---
NODE_V="$(node --version 2>/dev/null || true)"
NODE_MAJOR="$(printf '%s' "$NODE_V" | sed -E 's/^v([0-9]+).*/\1/')"
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
  say "  ✓ node              $NODE_V"
else
  say "  ✗ node              ${NODE_V:-$(t "缺失" "missing")} $(t "（@aws/agentcore 要求 >= 20）" "(@aws/agentcore requires >= 20)")"
  echo "$(t "❌ 先把 node 升到 20 以上再跑本脚本。" "❌ Upgrade node to >= 20 before running this script.")" >&2
  exit 1
fi

# --- agentcore CLI ---
HAVE_CLI="$(agentcore --version 2>/dev/null | tr -d '[:space:]' || true)"
if [ "$HAVE_CLI" = "$CLI_PIN" ]; then
  say "  ✓ agentcore CLI     $HAVE_CLI"
else
  NEED_CLI=1
  say "  ✗ agentcore CLI     ${HAVE_CLI:-$(t "未安装" "not installed")} → $(t "应为" "expected") $CLI_PIN"
fi

# --- CDK harness 依赖 pin(这次事故的关键项:被更新版 CLI 改写过就必挂,且不自愈)---
HARNESS_ACTUAL=""
if [ -f "$CDK_HARNESS_DIR/package.json" ]; then
  HARNESS_ACTUAL="$(python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1])).get('dependencies',{}).get('@aws/agentcore-cdk',''))
except Exception: print('')
" "$CDK_HARNESS_DIR/package.json" 2>/dev/null || true)"
fi
if [ "$HARNESS_ACTUAL" = "$HARNESS_PIN" ]; then
  say "  ✓ @aws/agentcore-cdk $HARNESS_ACTUAL $(t "（入库的 package.json）" "(in-repo package.json)")"
else
  NEED_HARNESS=1
  say "  ✗ @aws/agentcore-cdk ${HARNESS_ACTUAL:-?} → $(t "应为" "expected") $HARNESS_PIN"
  say "    $(t "入库的 agentcore/cdk/package.json 被改写过（几乎一定是更新版 agentcore CLI 干的）。" \
              "The in-repo agentcore/cdk/package.json was rewritten (almost certainly by a newer agentcore CLI).")"
fi
# 已装到 node_modules 里的那份也要对得上 —— package.json 还原了但 node_modules 还是旧的一样挂。
INSTALLED_HARNESS="$(node -p "require('$CDK_HARNESS_DIR/node_modules/@aws/agentcore-cdk/package.json').version" 2>/dev/null || true)"
if [ -n "$INSTALLED_HARNESS" ] && [ "$INSTALLED_HARNESS" != "$HARNESS_PIN" ]; then
  NEED_HARNESS=1
  say "  ✗ node_modules      @aws/agentcore-cdk $INSTALLED_HARNESS → $(t "应为" "expected") $HARNESS_PIN"
fi
# 生成的 cdk-stack.ts 若也被改动过,一起还原(它是 CLI 生成物,HEAD 那份才配得上钉住的 pin)。
DIRTY_GENERATED=""
if git -C "$PROJECT_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  DIRTY_GENERATED="$(git -C "$PROJECT_ROOT" status --porcelain -- \
    "agent-build/NotiOpsWebChat/agentcore/cdk/package.json" \
    "agent-build/NotiOpsWebChat/agentcore/cdk/package-lock.json" \
    "agent-build/NotiOpsWebChat/agentcore/cdk/lib/cdk-stack.ts" 2>/dev/null | awk '{print $2}' || true)"
fi

# --- AWS 侧现状 ---
AGENT_ARN="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$AGENT_STACK" \
  --query "Stacks[0].Outputs[?contains(OutputKey,'RuntimeArn')].OutputValue | [0]" \
  --output text 2>/dev/null || true)"
[ "$AGENT_ARN" = "None" ] && AGENT_ARN=""
if [ -n "$AGENT_ARN" ]; then
  say "  ✓ $AGENT_STACK"
  say "    $AGENT_ARN"
else
  NEED_AGENT=1
  say "  ✗ $AGENT_STACK  $(t "不存在 —— agent 从来没上线" "does not exist — the agent was never deployed")"
fi

BFF_ARN="$(aws lambda get-function-configuration --region "$REGION" --function-name "$BFF_FN" \
  --query 'Environment.Variables.AGENT_RUNTIME_ARN' --output text 2>/dev/null || true)"
[ "$BFF_ARN" = "None" ] && BFF_ARN=""
if [ -n "$BFF_ARN" ]; then
  say "  ✓ BFF AGENT_RUNTIME_ARN  $(t "已注入" "set")"
else
  NEED_INJECT=1
  say "  ✗ BFF AGENT_RUNTIME_ARN  $(t "空 —— 这就是只回显的直接原因" "empty — this is exactly why it only echoes")"
fi
# ARN 对不上(agent 重建过但 BFF 还指着老的)也要重新注入。
if [ -n "$AGENT_ARN" ] && [ -n "$BFF_ARN" ] && [ "$AGENT_ARN" != "$BFF_ARN" ]; then
  NEED_INJECT=1
  say "  ✗ BFF $(t "指向的是另一个 ARN（agent 重建过），需要重新注入" "points at a different ARN (the agent was rebuilt); needs re-injection")"
fi

# --- 上一次失败的真实原因就在 CLI 自己的日志里 ---
LAST_LOG="$(ls -t "$AGENT_DIR/agentcore/.cli/logs/deploy/"*.log 2>/dev/null | head -1 || true)"
if [ -n "$LAST_LOG" ] && [ "$NEED_AGENT" = "1" ]; then
  say ""
  say "  $(t "上次 agentcore deploy 的日志（真正的报错只在这里）:" "The last agentcore deploy log (the real error only exists here):")"
  say "    $LAST_LOG"
  grep -iE 'error|failed|FAILED' "$LAST_LOG" 2>/dev/null | tail -6 | sed 's/^/      /' || true
fi

if [ "$NEED_UV$NEED_CLI$NEED_HARNESS$NEED_AGENT$NEED_INJECT" = "00000" ]; then
  say ""
  say "$(t "✅ 没查出问题:agent 已上线、BFF 也拿到了 ARN。" "✅ Nothing wrong here: the agent is up and the BFF has its ARN.")"
  say "$(t "   若页面仍在回显,浏览器强刷一次（Cmd/Ctrl+Shift+R）再试；仍旧回显请把 BFF 的 CloudWatch 日志发出来。" \
            "   If the UI still echoes, hard-refresh (Cmd/Ctrl+Shift+R) and retry; if it persists, share the BFF's CloudWatch logs.")"
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════
# 二、修复计划 + 确认
# ═══════════════════════════════════════════════════════════════════════════
say ""
say "$(t "② 将要做的事" "② What this script will do")"
hr
[ "$NEED_UV"      = "1" ] && say "  1. $(t "安装 uv 到 ~/.local/bin（astral 官方安装脚本）" "install uv into ~/.local/bin (astral's official installer)")"
[ "$NEED_CLI"     = "1" ] && say "  2. npm install -g @aws/agentcore@$CLI_PIN"
[ "$NEED_HARNESS" = "1" ] && say "  3. $(t "还原入库的 agentcore/cdk 依赖到 ${HARNESS_PIN}，删掉 node_modules/dist/cdk.out 后 npm ci" \
                                            "restore the in-repo agentcore/cdk deps to $HARNESS_PIN, wipe node_modules/dist/cdk.out and npm ci")"
[ "$NEED_AGENT"   = "1" ] && say "  4. $(t "重跑 scripts/deploy_agent.sh 把 AgentCore Runtime 拉起来（约 5-10 分钟）" \
                                            "re-run scripts/deploy_agent.sh to bring the AgentCore Runtime up (~5-10 min)")"
say "  5. $(t "把 Runtime ARN 注入 BFF（cdk deploy WebChatStack --exclusively）" "inject the Runtime ARN into the BFF (cdk deploy WebChatStack --exclusively)")"
say "  6. $(t "复验 BFF 环境变量" "re-verify the BFF's environment variable")"
say ""
say "$(t "不会做:不删除任何 AWS 资源，不动 NotiOpsBackendStack / BotStack，不碰前端桶里的 config.json。" \
          "Will NOT do: delete any AWS resource, touch NotiOpsBackendStack / BotStack, or touch config.json in the frontend bucket.")"

if [ "$DIAGNOSE_ONLY" = "1" ]; then
  say ""
  say "$(t "（--diagnose：到此为止，什么都没改。去掉这个参数即开始修复。）" \
            "(--diagnose: stopping here, nothing was changed. Drop the flag to actually repair.)")"
  exit 0
fi
if [ "$ASSUME_YES" != "1" ]; then
  if [ ! -t 0 ]; then
    echo "$(t "❌ 非交互环境无法确认；确认要修就加 -y 重跑。" \
              "❌ Cannot prompt in a non-interactive shell; re-run with -y to proceed.")" >&2
    exit 1
  fi
  say ""
  printf '%s' "$(t "继续? [y/N] " "Proceed? [y/N] ")"
  read -r reply
  case "$reply" in [yY]|[yY][eE][sS]) ;; *) say "$(t "已取消。" "Aborted.")"; exit 130 ;; esac
fi

# ═══════════════════════════════════════════════════════════════════════════
# 三、修
# ═══════════════════════════════════════════════════════════════════════════

if [ "$NEED_UV" = "1" ]; then
  say ""
  say "$(t "③-1 安装 uv…" "③-1 Installing uv...")"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  for d in "$HOME/.local/bin" "$HOME/.cargo/bin"; do
    [ -x "$d/uv" ] && { PATH="$d:$PATH"; export PATH; break; }
  done
  command -v uv >/dev/null 2>&1 || {
    echo "$(t "❌ uv 装完还是找不到。把它所在目录加进 PATH 后重跑本脚本。" \
              "❌ uv still isn't on PATH after installing. Add its directory to PATH and re-run.")" >&2
    exit 1
  }
  say "    ✓ $(uv --version)"
fi

if [ "$NEED_CLI" = "1" ]; then
  say ""
  say "$(t "③-2 安装 agentcore CLI @${CLI_PIN}…" "③-2 Installing agentcore CLI @$CLI_PIN...")"
  npm install -g "@aws/agentcore@$CLI_PIN" || {
    echo "$(t "❌ 安装失败。若是权限问题：sudo npm install -g @aws/agentcore@$CLI_PIN" \
              "❌ Install failed. If it's a permissions issue: sudo npm install -g @aws/agentcore@$CLI_PIN")" >&2
    exit 1
  }
  HAVE_CLI="$(agentcore --version 2>/dev/null | tr -d '[:space:]' || true)"
  [ "$HAVE_CLI" = "$CLI_PIN" ] || {
    echo "$(t "❌ 装完 agentcore --version 还是 '$HAVE_CLI'（可能 PATH 里有另一个）。which -a agentcore 看看。" \
              "❌ After installing, agentcore --version is still '$HAVE_CLI' (another copy earlier on PATH?). Check: which -a agentcore")" >&2
    exit 1
  }
  say "    ✓ agentcore $HAVE_CLI"
fi

if [ "$NEED_HARNESS" = "1" ]; then
  say ""
  say "$(t "③-3 还原 CDK harness 依赖…" "③-3 Restoring the CDK harness dependencies...")"
  RESTORED=0
  if [ -n "$DIRTY_GENERATED" ]; then
    # 这三个都是入库文件、且 package.json / cdk-stack.ts 都是 CLI 生成物 ——
    # HEAD 那份才是和钉住的 pin 配套的组合,还原不会丢任何人手写的东西。
    say "    $(t "git 还原被改写的入库文件:" "git-restoring the rewritten in-repo files:")"
    printf '%s\n' "$DIRTY_GENERATED" | sed 's/^/      /'
    git -C "$PROJECT_ROOT" checkout -- $DIRTY_GENERATED && RESTORED=1
  fi
  if [ "$RESTORED" != "1" ]; then
    # 不是 git 工作树（或没有改动记录）→ 直接把依赖钉回去。
    say "    $(t "（不是 git 工作树或没有可还原的改动，直接钉依赖版本）" \
                 "(not a git worktree, or nothing to restore — pinning the dependency directly)")"
    ( cd "$CDK_HARNESS_DIR" && npm install --save-exact "@aws/agentcore-cdk@$HARNESS_PIN" --no-audit --no-fund )
  fi
  HARNESS_ACTUAL="$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1])).get('dependencies',{}).get('@aws/agentcore-cdk',''))
" "$CDK_HARNESS_DIR/package.json")"
  [ "$HARNESS_ACTUAL" = "$HARNESS_PIN" ] || {
    echo "$(t "❌ 还原后 package.json 里仍是 '$HARNESS_ACTUAL'（应为 ${HARNESS_PIN}）。请人工检查 $CDK_HARNESS_DIR/package.json。" \
              "❌ After restoring, package.json still says '$HARNESS_ACTUAL' (expected $HARNESS_PIN). Inspect $CDK_HARNESS_DIR/package.json by hand.")" >&2
    exit 1
  }
  say "    $(t "重装依赖（node_modules / dist / cdk.out 全部重来）…" "Reinstalling dependencies (wiping node_modules / dist / cdk.out)...")"
  rm -rf "$CDK_HARNESS_DIR/node_modules" "$CDK_HARNESS_DIR/dist" "$CDK_HARNESS_DIR/cdk.out"
  ( cd "$CDK_HARNESS_DIR" \
    && { [ -f package-lock.json ] && npm ci --no-audit --no-fund || npm install --no-audit --no-fund; } ) || {
    echo "$(t "❌ npm 安装失败。上面的 npm 输出就是原因。" "❌ npm install failed. The npm output above is the reason.")" >&2
    exit 1
  }
  INSTALLED_HARNESS="$(node -p "require('$CDK_HARNESS_DIR/node_modules/@aws/agentcore-cdk/package.json').version" 2>/dev/null || true)"
  say "    ✓ @aws/agentcore-cdk $INSTALLED_HARNESS"
fi

# ── 跨账号闸门:从现网 BFF 的 ORGANIZATION_ID 反推,别让多账号客户被降级回单账号 ──
# deploy_agent.sh 的 env 回填是 merge-patch:这个 key **必须显式传**(哪怕空串),
# 不传 = 保留 runtime 上的旧值,两个方向都会错(org 模式闸门没开 / 单账号闸门一直开着)。
ORG_ID="$(aws lambda get-function-configuration --region "$REGION" --function-name "$BFF_FN" \
  --query 'Environment.Variables.ORGANIZATION_ID' --output text 2>/dev/null || true)"
[ "$ORG_ID" = "None" ] && ORG_ID=""
ALLOW_CROSS=""
[ -n "$ORG_ID" ] && ALLOW_CROSS="1"

if [ "$NEED_AGENT" = "1" ]; then
  say ""
  say "$(t "③-4 重新部署 AgentCore Runtime（约 5-10 分钟，别中断）…" \
            "③-4 Redeploying the AgentCore Runtime (~5-10 min, don't interrupt)...")"
  hr
  DEPLOY_REGION="$REGION" UI_LANG="$UI_LANG" \
  NOTIOPS_ALLOW_CROSS_ACCOUNT="$ALLOW_CROSS" \
  AGENT_ARN_OUT="$ARN_OUT" \
    bash "$PROJECT_ROOT/scripts/deploy_agent.sh"
  hr
  AGENT_ARN="$(cat "$ARN_OUT" 2>/dev/null || true)"
  [ -n "$AGENT_ARN" ] || {
    echo "$(t "❌ deploy_agent.sh 没产出 Runtime ARN。上面的输出（含 agentcore CLI 日志）就是原因。" \
              "❌ deploy_agent.sh produced no Runtime ARN. The output above (including the agentcore CLI log) is the reason.")" >&2
    exit 1
  }
  say "    ✓ $AGENT_ARN"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 四、把 ARN 注入 BFF
# ═══════════════════════════════════════════════════════════════════════════
say ""
say "$(t "③-5 把 Runtime ARN 注入 BFF…" "③-5 Injecting the Runtime ARN into the BFF...")"

# 这些 -c 都是 **synth 期**才读的:漏传就会把现网配置降级。所以全部从现网反推回来,
# 而不是让使用者记住上次 setup.sh 用了什么参数。
#   organizationId  漏传 → 多账号变 org_mode_disabled
#   allowedOrigins  漏传 → Function URL CORS 回退成 ["*"]（比现状更松）
CDK_CTX=()
if [ -n "$ORG_ID" ]; then
  CDK_CTX+=(-c "organizationId=$ORG_ID")
  say "    $(t "沿用现网多账号配置 organizationId=" "carrying over the live multi-account setting organizationId=")$ORG_ID"
fi
CORS="$(aws lambda get-function-url-config --region "$REGION" --function-name "$BFF_FN" \
  --query 'Cors.AllowOrigins' --output text 2>/dev/null || true)"
if [ -n "$CORS" ] && [ "$CORS" != "None" ] && [ "$CORS" != "*" ]; then
  CORS_CSV="$(printf '%s' "$CORS" | tr '\t' ',')"
  CDK_CTX+=(-c "allowedOrigins=$CORS_CSV")
  say "    $(t "沿用现网 CORS 白名单 allowedOrigins=" "carrying over the live CORS allowlist allowedOrigins=")$CORS_CSV"
fi
REPORTS_CDN="$(aws cloudformation describe-stacks --region "$REGION" --stack-name NotiOpsBackendStack \
  --query "Stacks[0].Outputs[?OutputKey=='ReportsCdnDomain'].OutputValue | [0]" --output text 2>/dev/null || true)"
[ "$REPORTS_CDN" = "None" ] && REPORTS_CDN=""
# 显式传 reportsCdnDomain:不传的话 WebChatStack 会引用主栈的 Export,`--exclusively`
# 就不再是"只动 WebChatStack"（会被迫先 update 主栈，顺带带上主栈上所有未部署的改动）。
[ -n "$REPORTS_CDN" ] && CDK_CTX+=(-c "reportsCdnDomain=$REPORTS_CDN")
# enabledPlatforms=none 只是让 synth 跳过 IM 侧（ImStack）。配合 --exclusively 不会动到
# 已部署的 IM 栈 —— CDK 从不删除"不在 app 里"的栈。
# 历史：M2（2026-09-03）之前这一行的主要作用是跳过 BotStack 那 5 处
# `ContainerImage.fromAsset("../")`（扫整个 repo 当 Docker context，慢十几分钟）。
# BotStack 退役后 synth 本来就快，这一行只是继续少动一个栈。
CDK_CTX+=(-c "enabledPlatforms=none")

[ -d "$PROJECT_ROOT/infra/node_modules" ] || ( cd "$PROJECT_ROOT/infra" && npm ci --no-audit --no-fund )
( cd "$PROJECT_ROOT/infra" && npx cdk deploy WebChatStack --exclusively --require-approval never \
    -c "agentRuntimeArn=$AGENT_ARN" "${CDK_CTX[@]}" )

# ═══════════════════════════════════════════════════════════════════════════
# 五、复验
# ═══════════════════════════════════════════════════════════════════════════
say ""
say "$(t "④ 复验" "④ Verification")"
hr
BFF_ARN="$(aws lambda get-function-configuration --region "$REGION" --function-name "$BFF_FN" \
  --query 'Environment.Variables.AGENT_RUNTIME_ARN' --output text 2>/dev/null || true)"
[ "$BFF_ARN" = "None" ] && BFF_ARN=""
if [ -z "$BFF_ARN" ]; then
  echo "$(t "❌ BFF 的 AGENT_RUNTIME_ARN 还是空的 —— 注入没生效，页面还会回显。请把上面 cdk 的输出发出来。" \
            "❌ The BFF's AGENT_RUNTIME_ARN is still empty — the injection didn't take effect and the UI will still echo. Please share the cdk output above.")" >&2
  exit 1
fi
say "  ✓ BFF AGENT_RUNTIME_ARN = $BFF_ARN"
if [ "$BFF_ARN" != "$AGENT_ARN" ]; then
  say "  ⚠ $(t "BFF 上的 ARN 和刚部署的不一致（${AGENT_ARN}）—— 请人工确认。" \
              "The ARN on the BFF differs from the one just deployed ($AGENT_ARN) — please double-check.")"
fi
CHAT_URL="$(aws cloudformation describe-stacks --region "$REGION" --stack-name WebChatStack \
  --query "Stacks[0].Outputs[?OutputKey=='ChatUrl'].OutputValue | [0]" --output text 2>/dev/null || true)"
say ""
say "$(t "✅ 修好了。" "✅ Fixed.")"
[ -n "$CHAT_URL" ] && [ "$CHAT_URL" != "None" ] && say "   $(t "打开" "Open") $CHAT_URL"
say "   $(t "浏览器强刷一次（Cmd/Ctrl+Shift+R），随便问一句 —— 不应再出现 \"(Echo — …)\"。" \
          "Hard-refresh the page (Cmd/Ctrl+Shift+R) and ask anything — you should no longer see \"(Echo — …)\".")"
