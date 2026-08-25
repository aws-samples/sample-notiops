#!/usr/bin/env bash
# 一键部署（Launch Stack）的**发布产物构建**脚本 —— 维护者用，不面向客户。
#
# 产出四个东西，一起挂到一个 GitHub Release 上（对客说明见 docs/DEPLOYMENT_ONECLICK.md）：
#
#   bff.zip                       Web Chat BFF 的 Lambda 代码（含 node_modules）
#   chat-dist.zip                 前端构建产物（index.html / assets/… 在 zip 根）
#   agent-code.zip                AgentCore Runtime 的 CodeZip（含 linux/aarch64 依赖，~144MB）
#   SHA256SUMS                    上面三个的校验和
#   notiops-webchat.template.json 客户点 "Launch Stack" 打开的那份模板
#
# 模板与产物是**一对一绑死**的：tag 进 S3 key、sha256 进模板里的产物清单。
# 所以这四个文件必须**同一次运行**产出、一起发布；混搭两次运行的产物 =
# StagerFn 校验 sha256 不通过 = 客户侧开栈失败（这正是我们要的失败方式）。
#
# 三个产物为什么各自这样打：
#
#   · agent-code.zip 用 `agentcore package` 而不是自己 pip vendoring。
#     AgentCore 托管运行时**不做 pip install**（Step 1 PoC 实测），zip 里必须已经躺着
#     linux/aarch64 + cp313 的 wheel。手搓 `pip install --platform` 那套极易出现
#     「本地能跑、云上 ImportError」，而 CLI 已经把这件事做对了。
#   · bff.zip 从 **CDK 暂存出来的资产目录**打，不是直接 zip bff/web-chat。
#     CDK 认定的资产内容 = 模板里那个 hash 所声明的内容；自己 zip 源目录会把 CDK
#     排除掉的东西（构建缓存、editor 垃圾）一起发出去，且发的与模板声称的不是一回事。
#   · chat-dist.zip 从 dist 目录**内部**打（`cd dist && zip -r`），因为 StagerFn 把 zip
#     里的路径原样当 S3 key 用 —— 多一层 `dist/` 前缀，客户打开就是 404。
#
# 用法：
#   scripts/package_artifacts.sh --release-tag v1.0.11
#   scripts/package_artifacts.sh --release-tag v0.0.1-test \
#       --base-url https://my-bucket.s3.us-east-1.amazonaws.com/notiops/v0.0.1-test
#
# 选项：
#   --release-tag <tag>   必填。进 S3 key 与模板 Mappings，客户升级靠它区分版本。
#   --out <dir>           产物目录，默认 dist/oneclick。
#   --base-url <url>      产物下载根地址，默认 GitHub Release。测试时指向自己的 S3 镜像。
#   --no-install          跳过 npm ci（树已就绪时用，省几分钟）。发布**不要**用。
#   --reuse-agent         复用已有的 agentcore/NotiOpsWebChat.zip，跳过重新打包（几分钟）。
#                         只在这一轮已经打过、且 agent 源码未改时用。
#
# 环境变量：
#   NPM_REGISTRY          npm ci 用的 registry，默认公网 registry.npmjs.org。
#                         **刻意不用环境里的 npm config** —— 开发机常指向内网
#                         CodeArtifact 镜像，其 token 会过期（E401），发布构建卡在
#                         认证上比一开始就说清楚从哪拉更糟；而且 lockfile 本身钉的
#                         就是公网 registry 的解析结果，发出去的东西应当来自那里。
#
# 退出码非 0 = 没有产出任何可发布的东西（脚本 set -e，且每一步都自检）。
set -euo pipefail

RELEASE_TAG=""
OUT_DIR=""
BASE_URL=""
DO_INSTALL=1
REUSE_AGENT=0
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"

while [ $# -gt 0 ]; do
  case "$1" in
    --release-tag) RELEASE_TAG="${2:?--release-tag needs a value}"; shift 2 ;;
    --out)         OUT_DIR="${2:?--out needs a value}"; shift 2 ;;
    --base-url)    BASE_URL="${2:?--base-url needs a value}"; shift 2 ;;
    --no-install)  DO_INSTALL=0; shift ;;
    --reuse-agent) REUSE_AGENT=1; shift ;;
    -h|--help)     sed -n '2,/^# 退出码/p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$RELEASE_TAG" ]; then
  echo "ERROR: --release-tag is required (it goes into the artifact S3 keys)" >&2
  exit 2
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
OUT_DIR="${OUT_DIR:-$PROJECT_ROOT/dist/oneclick}"
case "$OUT_DIR" in /*) ;; *) OUT_DIR="$PROJECT_ROOT/$OUT_DIR" ;; esac

AGENT_DIR="$PROJECT_ROOT/agent-build/NotiOpsWebChat"
SYNTH_DIR="$OUT_DIR/.synth"          # 专用合成目录：/tmp/notiops-cdk-out 里躺着别的栈
                                     # 几十个 asset.*，在那里找"唯一那个资产"是找不准的
TEMPLATE_OUT="$OUT_DIR/notiops-webchat.template.json"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. 前置检查 ────────────────────────────────────────────────────────────────
step "preflight"
for bin in node npm python3 zip shasum; do
  command -v "$bin" >/dev/null 2>&1 || die "$bin not found on PATH"
done
if [ "$REUSE_AGENT" -eq 0 ]; then
  command -v agentcore >/dev/null 2>&1 \
    || die "agentcore CLI not found — 'npm install -g @aws/agentcore' (or pass --reuse-agent)"
fi
[ -d "$AGENT_DIR" ] || die "agent project not found: $AGENT_DIR"
echo "  node $(node --version) / npm $(npm --version) / python3 $(python3 --version | cut -d' ' -f2)"
echo "  registry    : $NPM_REGISTRY"
echo "  release tag : $RELEASE_TAG"
echo "  output dir  : $OUT_DIR"

mkdir -p "$OUT_DIR"
# 上一轮的产物必须清掉：残留的旧 zip 会被下面的 SHA256SUMS 一起算进去，
# 于是"清单里有 4 个产物"这种混搭状态要到客户开栈时才暴露。
rm -f "$OUT_DIR/bff.zip" "$OUT_DIR/chat-dist.zip" "$OUT_DIR/agent-code.zip" \
      "$OUT_DIR/SHA256SUMS" "$TEMPLATE_OUT"

# ── 1. 前端 → chat-dist.zip ───────────────────────────────────────────────────
step "frontend build -> chat-dist.zip"
if [ "$DO_INSTALL" -eq 1 ]; then
  (cd frontend/chat-app && npm ci --no-audit --no-fund --registry "$NPM_REGISTRY")
fi
(cd frontend/chat-app && npm run build)
[ -f frontend/chat-app/dist/index.html ] || die "frontend build produced no dist/index.html"
# `-X` 不写扩展属性（macOS 的 resource fork 在 Linux 侧解出来是垃圾文件）；
# 排除 .DS_Store 同理 —— 它会被当成一个 S3 对象发给客户。
(cd frontend/chat-app/dist && zip -q -X -r "$OUT_DIR/chat-dist.zip" . -x '*.DS_Store')

# ── 2. BFF 依赖 + 合成 standalone 模板 → bff.zip ──────────────────────────────
step "bff deps + standalone synth -> bff.zip"
if [ "$DO_INSTALL" -eq 1 ]; then
  # --omit=dev：devDependencies 不进 Lambda 包（也是 setup.sh 的做法）
  (cd bff/web-chat && npm ci --omit=dev --no-audit --no-fund --registry "$NPM_REGISTRY")
fi
[ -d bff/web-chat/node_modules ] || die "bff/web-chat/node_modules missing (drop --no-install)"
if [ "$DO_INSTALL" -eq 1 ]; then
  (cd infra && npm ci --no-audit --no-fund --registry "$NPM_REGISTRY")
fi

rm -rf "$SYNTH_DIR"
(cd infra && npx cdk synth --app 'npx ts-node bin/standalone.ts' -o "$SYNTH_DIR" NotiOps >/dev/null)
[ -f "$SYNTH_DIR/NotiOps.template.json" ] || die "synth produced no NotiOps.template.json"

# 资产目录从 assets 清单里读，不 glob 目录名：清单是 CDK 自己的记录，且它同时让
# "只能有一个资产"这条判据变得可判定（多一个 = 有人往 standalone 栈里加了
# BucketDeployment / cr.Provider / autoDeleteObjects 之类）。
ASSET_REL="$(python3 - "$SYNTH_DIR/NotiOps.assets.json" <<'PY'
import json, sys
files = json.load(open(sys.argv[1]))["files"]
zips = [v["source"]["path"] for v in files.values() if v["source"].get("packaging") == "zip"]
if len(zips) != 1:
    sys.exit(f"expected exactly 1 zip asset in the standalone synth, found {len(zips)}: {zips}\n"
             "A count > 1 means a new CDK asset crept into the standalone stack; a count of 0 "
             "means the BFF stopped using Code.fromAsset.")
print(zips[0])
PY
)" || die "could not determine the BFF asset directory"
ASSET_DIR="$SYNTH_DIR/$ASSET_REL"
[ -d "$ASSET_DIR" ] || die "asset directory missing: $ASSET_DIR"
echo "  bff asset: $ASSET_REL"
(cd "$ASSET_DIR" && zip -q -X -r "$OUT_DIR/bff.zip" . -x '*.DS_Store')

# ── 3. Agent → agent-code.zip ────────────────────────────────────────────────
step "agentcore package -> agent-code.zip"
AGENT_ZIP="$AGENT_DIR/agentcore/NotiOpsWebChat.zip"
if [ "$REUSE_AGENT" -eq 1 ]; then
  [ -f "$AGENT_ZIP" ] || die "--reuse-agent given but $AGENT_ZIP does not exist"
  echo "  reusing $AGENT_ZIP ($(du -h "$AGENT_ZIP" | cut -f1))"
else
  # 拉 linux/aarch64 + cp313 的 wheel 到本地再打包，几分钟量级。
  (cd "$AGENT_DIR" && agentcore package -d . -r NotiOpsWebChat)
  [ -f "$AGENT_ZIP" ] || die "agentcore package produced no $AGENT_ZIP"
fi
cp "$AGENT_ZIP" "$OUT_DIR/agent-code.zip"

# ── 4. 逐个产物验形状 ─────────────────────────────────────────────────────────
# 三个 zip 都是"内容错了也照样能上传、要等客户开栈甚至打开页面才暴露"的类型。
# 这里在发布前把各自的入口文件钉住。
step "verify artifact shapes"
python3 - "$OUT_DIR" <<'PY'
import sys, zipfile
from pathlib import Path

out = Path(sys.argv[1])
failed = []


def check(label, cond, detail=""):
    print(f"  {'ok  ' if cond else 'FAIL'} {label}" + (f" :: {detail}" if detail and not cond else ""))
    if not cond:
        failed.append(label)


def names(zip_name):
    with zipfile.ZipFile(out / zip_name) as zf:
        return zf.namelist()


# bff.zip —— Lambda handler 是 index.handler，且 node_modules 必须在包里
# （bedrock-agentcore 客户端不在 Lambda 运行时预装集里）。
bff = names("bff.zip")
check("bff.zip has index.mjs at the root", "index.mjs" in bff)
check("bff.zip bundles node_modules", any(n.startswith("node_modules/") for n in bff))
check("bff.zip bundles the bedrock-agentcore client",
      any(n.startswith("node_modules/@aws-sdk/client-bedrock-agentcore/") for n in bff))

# chat-dist.zip —— StagerFn 把 zip 内路径原样当 S3 key，所以入口必须在根。
dist = names("chat-dist.zip")
check("chat-dist.zip has index.html at the root", "index.html" in dist)
check("chat-dist.zip has an assets/ directory", any(n.startswith("assets/") for n in dist))
check("chat-dist.zip has no nested dist/ prefix", not any(n.startswith("dist/") for n in dist),
      "zip was made from the parent dir; every object would land under dist/ and 404")

# agent-code.zip —— 托管运行时不 pip install，所以依赖必须是已经躺在包里的
# linux/aarch64 + cp313 wheel。三条各自对应一种真实的失败：
#   main.py 不在根          → 运行时找不到 EntryPoint
#   没有 aarch64 的 .so     → 云上 ImportError（本地 mac wheel 被打进去了）
#   根上有 requirements.txt → 说明这是"等运行时装依赖"的包法，那个运行时不会装
agent = names("agent-code.zip")
check("agent-code.zip has main.py at the root", "main.py" in agent)
check("agent-code.zip bundles the bedrock_agentcore SDK",
      any(n.startswith("bedrock_agentcore/") for n in agent))
check("agent-code.zip bundles the NotiOps agent code", any(n.startswith("core/") for n in agent))
check("agent-code.zip carries linux/aarch64 cp313 native wheels",
      any(n.endswith(".so") and "aarch64" in n for n in agent),
      "no aarch64 .so — the local (macOS) wheels were packaged instead")
check("agent-code.zip has no root requirements.txt", "requirements.txt" not in agent,
      "the managed runtime does not pip install; deps must already be in the zip")

if failed:
    sys.exit(f"\n{len(failed)} artifact shape check(s) failed")
print("  all artifact shape checks passed")
PY

# ── 5. SHA256SUMS ────────────────────────────────────────────────────────────
step "SHA256SUMS"
(cd "$OUT_DIR" && shasum -a 256 bff.zip chat-dist.zip agent-code.zip > SHA256SUMS)
cat "$OUT_DIR/SHA256SUMS"

# ── 6. 后处理模板 ─────────────────────────────────────────────────────────────
step "postprocess template"
POST_ARGS=(--in "$SYNTH_DIR/NotiOps.template.json" --out "$TEMPLATE_OUT"
           --release-tag "$RELEASE_TAG" --sha256 "$OUT_DIR/SHA256SUMS")
[ -n "$BASE_URL" ] && POST_ARGS+=(--base-url "$BASE_URL")
python3 scripts/postprocess_template.py "${POST_ARGS[@]}"

# ── 7. 收尾 ──────────────────────────────────────────────────────────────────
step "done"
(cd "$OUT_DIR" && ls -lh bff.zip chat-dist.zip agent-code.zip SHA256SUMS \
    notiops-webchat.template.json)
cat <<EOF

Publish these five files together (they are cryptographically bound to each other):
  $OUT_DIR

Next:
  1. Upload the three zips + SHA256SUMS as assets of release $RELEASE_TAG
     (or to the S3 prefix you passed as --base-url).
  2. Upload notiops-webchat.template.json to S3 and deploy via --template-url
     (it is larger than CloudFormation's 51,200-byte --template-body limit).
  3. aws cloudformation validate-template --template-url <url>
EOF
