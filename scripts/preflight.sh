#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# NotiOps 部署前环境自检 / pre-deployment environment self-check
#
# 用法 / Usage:
#   bash scripts/preflight.sh              # 自动按 $LANG 选中/英文
#   bash scripts/preflight.sh --lang=zh    # 强制中文
#   bash scripts/preflight.sh --lang=en    # 强制英文
#
# 退出码 / Exit codes:  0 = 全部必检项通过   1 = 有必检项不满足
#
# 只读:本脚本**不安装、不修改任何文件**,只调两个只读 AWS API
# (sts:GetCallerIdentity / bedrock:ListFoundationModels)。可以放心在生产账号跑。
#
# ⚠️ 两处有意与 setup.sh 相反的设计,别"顺手改回去":
#
#   1. **没有 `set -e`**。setup.sh 是「一步错就停」,本脚本是「一次列全所有问题」——
#      客户最不想要的体验是修一条、重跑、又冒一条。所以每条检查各自记账,
#      最后统一汇总退出。加上 set -e 会让第一条 ❌ 之后的检查全部不跑。
#
#   2. **一处 `read` 都没有**。本脚本的价值之一恰恰是替客户检出「stdin 不是终端」
#      这件事(setup.sh 有 14 处无保护的 `read -p`,非交互运行时会静默 exit 1)。
#      自检脚本自己如果也要交互,就必须能在 CI / 管道 / nohup 下跑完才有意义。
# ─────────────────────────────────────────────────────────────────────────────

UI_LANG=""
for arg in "$@"; do
  case "$arg" in
    --lang=*) UI_LANG="${arg#--lang=}" ;;
    --lang)   UI_LANG="next" ;;
    en|zh)    [ "$UI_LANG" = "next" ] && UI_LANG="$arg" ;;
  esac
done
# 语言检测与 setup.sh 逐字一致:--lang 显式 > $LC_ALL/$LANG 含 zh > 默认英文。
if [ "$UI_LANG" != "en" ] && [ "$UI_LANG" != "zh" ]; then
  case "${LC_ALL:-${LANG:-}}" in
    zh_*|zh|*zh_CN*|*zh_TW*|*zh_HK*) UI_LANG="zh" ;;
    *) UI_LANG="en" ;;
  esac
fi
t() { if [ "$UI_LANG" = "zh" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

FAIL=0
WARN=0
ok()   { printf '  \033[32m[ OK ]\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m[FAIL]\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
warn() { printf '  \033[33m[WARN]\033[0m %s\n' "$1"; WARN=$((WARN + 1)); }
hint() { printf '         %s\n' "$1"; }

# ge <实测版本> <最低版本> —— 只比前两段(x.y),纯 awk。
# 为什么不用 `sort -V`:BSD sort(macOS)与 GNU sort 的 -V 行为不完全一致,
# 而 awk 在两边都一样。为什么不用 python3:python3 本身就是被检查对象之一,
# 它缺失或版本不对时这个函数还得能用。
ge() {
  awk -v a="$1" -v b="$2" 'BEGIN{
    split(a, x, "."); split(b, y, ".");
    am = x[1] + 0; an = x[2] + 0; bm = y[1] + 0; bn = y[2] + 0;
    exit !(am > bm || (am == bm && an >= bn))
  }'
}

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

echo "============================================"
echo "  $(t "NotiOps 部署前环境自检" "NotiOps pre-deployment check")"
echo "============================================"
echo "$(t "仓库目录: " "Repository: ")$REPO_ROOT"
if [ ! -f setup.sh ] || [ ! -f requirements.txt ]; then
  bad "$(t "这里看起来不是 NotiOps 仓库根目录(缺 setup.sh 或 requirements.txt)" \
          "This does not look like the NotiOps repository root (setup.sh or requirements.txt missing)")"
  hint "$(t "先 cd 到仓库根目录再跑本脚本。" "cd into the repository root first, then re-run.")"
  echo ""
  printf '\033[31m%s\033[0m\n' "$(t "✗ 自检中止。" "✗ Check aborted.")"
  exit 1
fi

echo ""
echo "── 1/5 $(t "本地工具链" "Local toolchain") ──"

# ── python3:版本下限是 3.10,不是"有就行" ────────────────────────────────
# setup.sh 打 Lambda 层时用 pip 下载 boto3 的 Linux wheel,pip 会拿 wheel 的
# Requires-Python(>= 3.10)与**当前解释器**比对 —— 所以 3.9 在那一步就直接失败,
# 与 boto3 装在哪儿无关。macOS 自带的 /usr/bin/python3 至今仍是 3.9.x。
PY_OK=false
if ! command -v python3 >/dev/null 2>&1; then
  bad "$(t "python3 未安装" "python3 not installed")"
  hint "macOS: brew install python@3.12   |   Amazon Linux 2023: sudo dnf install -y python3.12"
else
  PYV=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)
  PYWHERE=$(command -v python3)
  if [ -z "$PYV" ]; then
    bad "$(t "python3 存在但无法执行" "python3 present but not runnable")  ($PYWHERE)"
  elif ! ge "$PYV" 3.10; then
    bad "python3 = $PYV  ($PYWHERE) — $(t "低于最低要求 3.10" "below the 3.10 minimum")"
    hint "$(t "构建 Lambda 依赖层时 pip 会因 Requires-Python 直接失败(与 boto3 装在哪儿无关)。" \
            "pip fails on Requires-Python while building the Lambda dependency layer (regardless of where boto3 lives).")"
    hint "$(t "macOS 自带的 /usr/bin/python3 就是 3.9.x —— 需要:" "macOS ships 3.9.x at /usr/bin/python3 — do this:")"
    hint "  brew install python@3.12"
    hint "$(t "然后确认 'command -v python3' 指向 /opt/homebrew/bin/python3 而不是 /usr/bin/python3。" \
            "Then confirm 'command -v python3' points at /opt/homebrew/bin/python3, not /usr/bin/python3.")"
  elif ! ge "$PYV" 3.12; then
    PY_OK=true
    warn "python3 = $PYV  ($PYWHERE) — $(t "能跑,但文档要求 3.12+" "works, but the docs ask for 3.12+")"
  else
    PY_OK=true
    ok "python3 = $PYV  ($PYWHERE)"
  fi
fi

# ── node / npm / jq / git ───────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  bad "$(t "Node.js 未安装(CDK 要求 ≥ 22)" "Node.js not installed (CDK needs >= 22)")"
  hint "https://nodejs.org/  |  macOS: brew install node"
else
  NV=$(node -v 2>/dev/null | tr -d 'v')
  if ge "$NV" 22.0; then ok "node = $NV"
  else
    bad "node = $NV — $(t "低于 CDK 要求的 22" "below the CDK minimum of 22")"
    hint "macOS: brew install node   |   $(t "或用 nvm: nvm install 22" "or via nvm: nvm install 22")"
  fi
fi
if command -v npm >/dev/null 2>&1; then ok "npm = $(npm -v 2>/dev/null)"
else bad "$(t "npm 未安装(通常随 Node.js 一起装)" "npm not installed (normally ships with Node.js)")"; fi
if command -v jq >/dev/null 2>&1; then ok "jq = $(jq --version 2>/dev/null)"
else
  bad "$(t "jq 未安装" "jq not installed")"
  hint "macOS: brew install jq   |   Amazon Linux 2023: sudo dnf install -y jq"
fi
if command -v git >/dev/null 2>&1; then ok "git = $(git --version 2>/dev/null | awk '{print $3}')"
else warn "$(t "git 未安装(克隆仓库需要;已拿到源码则不影响部署)" "git not installed (needed to clone; not needed if you already have the sources)")"; fi

# ── AWS CLI:v2 且 ≥ 2.13 ───────────────────────────────────────────────────
if ! command -v aws >/dev/null 2>&1; then
  bad "$(t "AWS CLI 未安装(需 v2 ≥ 2.13)" "AWS CLI not installed (needs v2 >= 2.13)")"
  hint "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
else
  AV=$(aws --version 2>&1 | awk '{print $1}' | cut -d/ -f2)
  if ge "$AV" 2.13; then ok "aws = $AV"
  else
    bad "aws = $AV — $(t "低于 2.13(Bedrock 子命令支持)" "below 2.13 (Bedrock subcommand support)")"
    hint "$(t "v1 一律不支持,必须升到 v2。" "v1 is never supported; upgrade to v2.")"
  fi
fi

# ── uv:agent 打包的硬前置。缺它的后果是静默降级,不是报错停下 ───────────────
if ! command -v uv >/dev/null 2>&1; then
  for _d in "$HOME/.local/bin" "$HOME/.cargo/bin"; do
    [ -x "$_d/uv" ] && { PATH="$_d:$PATH"; export PATH; break; }
  done
fi
if command -v uv >/dev/null 2>&1; then
  ok "uv = $(uv --version 2>&1 | awk '{print $2}')"
else
  bad "$(t "uv 未安装 —— 这一项不是可选的" "uv not installed -- this one is not optional")"
  hint "$(t "agentcore 打 agent 的 Python 依赖时无条件调 uv。缺它不会报错停下,而是**静默降级**:" \
          "agentcore invokes uv unconditionally to package the agent deps. Missing it does not stop the deploy -- it SILENTLY DEGRADES:")"
  hint "$(t "agent 部署失败 → 拿不到 Runtime ARN → 网页照常打开,但一提问只把你的话回显回来。" \
          "the agent deploy fails -> no Runtime ARN -> the web UI opens fine but every question just echoes your message back.")"
  hint "curl -LsSf https://astral.sh/uv/install.sh | sh"
  hint "$(t "或 brew install uv。装完**新开一个终端**(官方安装器装到 ~/.local/bin,常不在 PATH)。" \
          "or brew install uv. Open a NEW shell afterwards (the installer targets ~/.local/bin, often not on PATH).")"
fi

# ── 2/5 boto3 ───────────────────────────────────────────────────────────────
# 最容易漏的一项,而 setup.sh 目前**不检查**它。
# setup.sh 会为 Lambda 层下载 Linux 版 boto3(--platform manylinux2014_x86_64),
# 那份**不能**给本机用;而部署尾段有三个脚本要在**本机**import boto3。
echo ""
echo "── 2/5 boto3 ──"
VENV_PY="$REPO_ROOT/.venv/bin/python"
BOTO_FIX_ZH="处方(在仓库根目录,跑 setup.sh 之前):
           python3 -m venv .venv
           .venv/bin/pip install -r requirements.txt
           source .venv/bin/activate      # ← 这一行不能省
           ./setup.sh"
BOTO_FIX_EN="Fix (in the repository root, BEFORE running setup.sh):
           python3 -m venv .venv
           .venv/bin/pip install -r requirements.txt
           source .venv/bin/activate      # <- do not skip this line
           ./setup.sh"
if [ -x "$VENV_PY" ] && "$VENV_PY" -c 'import boto3, botocore' 2>/dev/null; then
  ok ".venv boto3 = $("$VENV_PY" -c 'import boto3; print(boto3.__version__)' 2>/dev/null)"
  if [ -n "$VIRTUAL_ENV" ]; then
    ok "$(t "venv 已激活 —— 裸 python3 也能用" "venv is active -- a bare python3 resolves into it too")"
  else
    warn "$(t "venv 里有 boto3,但当前 shell 没激活它。" "boto3 is in .venv but the current shell has not activated it.")"
    hint "$(t "部署尾段有两个脚本用的是裸 python3,不激活就仍然缺。跑 setup.sh 前先:" \
            "Two of the post-deploy scripts call a bare python3, which would still be missing. Before setup.sh, run:")"
    hint "source .venv/bin/activate"
  fi
elif [ -x "$VENV_PY" ]; then
  bad "$(t ".venv 存在但里面没有 boto3" ".venv exists but has no boto3 in it")"
  hint ".venv/bin/pip install -r requirements.txt"
  hint "source .venv/bin/activate"
elif [ "$PY_OK" = true ] && python3 -c 'import boto3, botocore' 2>/dev/null; then
  bad "$(t "只有系统 python3 有 boto3 —— 这样**不够**。" "Only the system python3 has boto3 -- that is NOT enough.")"
  hint "$(t "setup.sh 建 .venv 时不带 --system-site-packages,所以系统里的 boto3 进不去那个 venv。" \
          "setup.sh creates .venv without --system-site-packages, so a system-level boto3 is invisible inside it.")"
  hint "$(t "$BOTO_FIX_ZH" "$BOTO_FIX_EN")"
else
  bad "$(t "setup.sh 会用到的解释器 import 不了 boto3。" "The interpreter setup.sh will use cannot import boto3.")"
  hint "$(t "后果:部署会一路跑到最后并打印「部署完成!」,但尾段三个脚本各自崩在 ModuleNotFoundError 上" \
          "Consequence: the deploy runs all the way to \"Deployment complete!\" while three post-deploy scripts each die on ModuleNotFoundError")"
  hint "$(t "(巡检 skill 上传 / 巡检索引回填 / 模型目录初始化),而退出码仍然是 0。" \
          "(inspection skill upload / inspection index backfill / model-catalogue seeding) -- and the exit code is still 0.")"
  hint "$(t "$BOTO_FIX_ZH" "$BOTO_FIX_EN")"
fi

# ── 3/5 AWS 凭证 / Bedrock ──────────────────────────────────────────────────
echo ""
echo "── 3/5 $(t "AWS 凭证与模型访问" "AWS credentials and model access") ──"
if ! command -v aws >/dev/null 2>&1; then
  warn "$(t "跳过(AWS CLI 未安装)" "skipped (AWS CLI not installed)")"
elif ! CALLER=$(aws sts get-caller-identity --output json 2>&1); then
  bad "$(t "AWS 凭证无效或已过期" "AWS credentials invalid or expired")"
  hint "$(t "SSO: aws sso login --profile <profile>" "SSO: aws sso login --profile <profile>")"
  hint "$(t "长期密钥: aws configure --profile <profile>,然后 export AWS_PROFILE=<profile>" \
          "Long-term keys: aws configure --profile <profile>, then export AWS_PROFILE=<profile>")"
else
  if command -v jq >/dev/null 2>&1; then
    ok "$(t "账号 " "Account ")$(echo "$CALLER" | jq -r .Account)  $(t "身份 " "Identity ")$(echo "$CALLER" | jq -r .Arn)"
  else
    ok "$(t "凭证有效(装了 jq 才显示账号与身份)" "credentials valid (install jq to see account and identity)")"
  fi
  CHECK_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null)}}"
  if [ -z "$CHECK_REGION" ]; then
    warn "$(t "本机没有默认区域 —— 跳过 Bedrock 可达性检查。" "No default region configured -- skipping the Bedrock reachability check.")"
    hint "$(t "setup.sh 会让你选区域;想现在就查,先 export AWS_REGION=<你要部署的区域> 再重跑本脚本。" \
            "setup.sh will ask you to pick one; to check now, export AWS_REGION=<your target region> and re-run.")"
  elif aws bedrock list-foundation-models --region "$CHECK_REGION" \
        --query 'length(modelSummaries)' --output text >/dev/null 2>&1; then
    ok "$(t "Bedrock API 在 " "Bedrock API reachable in ")$CHECK_REGION$(t " 可达" "")"
    hint "$(t "⚠️ 可达 ≠ 已开通。还要在 Bedrock 控制台 → Model access 为目录里的默认模型开通访问," \
            "⚠️ Reachable is not the same as enabled. You still need Bedrock console -> Model access for the catalogue's default model,")"
    hint "$(t "   否则部署成功但对话第一句就报权限错。" \
            "   otherwise the deploy succeeds and the very first message fails on permissions.")"
  else
    bad "$(t "Bedrock 在 " "Bedrock not reachable in ")$CHECK_REGION$(t " 不可达或无权限" " (or no permission)")"
    hint "$(t "确认该区域提供 Bedrock,且凭证有 bedrock:ListFoundationModels。" \
            "Confirm Bedrock is offered in that region and your credentials have bedrock:ListFoundationModels.")"
  fi
fi

# ── 4/5 运行环境:交互式终端 / 磁盘 ──────────────────────────────────────────
echo ""
echo "── 4/5 $(t "运行环境" "Runtime environment") ──"
if [ -t 0 ]; then
  ok "$(t "stdin 是交互式终端" "stdin is an interactive terminal")"
else
  bad "$(t "stdin 不是终端 —— setup.sh 不能这样跑。" "stdin is not a terminal -- setup.sh cannot run this way.")"
  hint "$(t "setup.sh 会交互提问(选区域、确认账号、选 IM 平台)。非交互运行时它会在第一个提问处" \
          "setup.sh asks interactive questions (region, account confirmation, IM platforms). Non-interactively it exits at the first one")"
  hint "$(t "以 exit 1 退出,而且**一个字都不打印** —— 日志里看不出原因。" \
          "with exit 1 and prints NOTHING -- the logs give you no reason.")"
  hint "$(t "不要用:./setup.sh </dev/null、nohup、CI runner、'yes | ./setup.sh' 或任何管道。" \
          "Do not use: ./setup.sh </dev/null, nohup, a CI runner, 'yes | ./setup.sh', or any pipe.")"
  hint "$(t "要免交互/免本地环境部署,请改用一键部署(见 docs/DEPLOYMENT_ONECLICK.md)。" \
          "For a hands-off deploy with no local setup, use the one-click path (see docs/DEPLOYMENT_ONECLICK.en.md).")"
fi
AVAIL_G=$(df -Pk . 2>/dev/null | awk 'NR==2{print int($4/1048576)}')
if [ -z "$AVAIL_G" ]; then
  warn "$(t "读不到磁盘余量" "could not read free disk space")"
elif [ "$AVAIL_G" -ge 10 ]; then
  ok "$(t "可用磁盘 " "Free disk ")${AVAIL_G}G"
else
  warn "$(t "可用磁盘只有 " "Only ")${AVAIL_G}G$(t ",建议 ≥ 10G" " free; >= 10G recommended")"
  hint "$(t "实测占用:node_modules 约 600M、.venv 约 350M、Lambda 依赖层约 40M," \
          "Measured: node_modules ~600M, .venv ~350M, the Lambda dependency layer ~40M,")"
  hint "$(t "另加每次 CDK 合成的临时目录(实测可达约 430M,合成完可删)。" \
          "plus one CDK synth output directory per run (measured up to ~430M; removable afterwards).")"
fi

# ── 5/5 网络出口 ────────────────────────────────────────────────────────────
# setup.sh 要从 PyPI 拉 Python 依赖、从 npm registry 拉 CDK。企业代理/内网源环境
# 常常两者之一不通,而失败点在部署中段,已经建了云资源。
echo ""
echo "── 5/5 $(t "网络出口" "Network egress") ──"
if ! command -v curl >/dev/null 2>&1; then
  warn "$(t "curl 未安装,跳过网络检查" "curl not installed, skipping network checks")"
else
  for _u in "https://pypi.org/simple/" "https://registry.npmjs.org/"; do
    if curl -sS -o /dev/null -m 15 "$_u" 2>/dev/null; then
      ok "$(t "可达 " "reachable ")$_u"
    else
      bad "$(t "不可达 " "unreachable ")$_u"
      hint "$(t "setup.sh 要用 pip 和 npx cdk。走企业代理或内网镜像源的话,请先配好" \
              "setup.sh needs pip and npx cdk. Behind a corporate proxy or a mirror, configure")"
      hint "$(t "HTTPS_PROXY / pip 的 index-url / npm 的 registry 再重跑。" \
              "HTTPS_PROXY / pip's index-url / npm's registry first, then re-run.")"
    fi
  done
fi

echo ""
echo "============================================"
if [ "$FAIL" -gt 0 ]; then
  printf '\033[31m%s\033[0m\n' "$(t "✗ $FAIL 项不满足、$WARN 项警告 —— 先修完再跑 ./setup.sh。" \
                                   "✗ $FAIL failed, $WARN warnings -- fix these before running ./setup.sh.")"
  echo "$(t "详细说明与逐项处方: docs/PREREQUISITES.md" "Details and per-item fixes: docs/PREREQUISITES.en.md")"
  exit 1
fi
printf '\033[32m%s\033[0m\n' "$(t "✓ 必检项全部通过($WARN 项警告)。可以跑 ./setup.sh 了。" \
                                 "✓ All required checks passed ($WARN warnings). You can run ./setup.sh now.")"
echo "$(t "前置条件完整说明: docs/PREREQUISITES.md" "Full prerequisites reference: docs/PREREQUISITES.en.md")"
exit 0
