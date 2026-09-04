#!/usr/bin/env bash
# 一键部署（Launch Stack）的**发布产物构建**脚本 —— 维护者用，不面向客户。
#
# 产出这些东西，一起挂到一个 GitHub Release 上（对客说明见 docs/DEPLOYMENT_ONECLICK.md）：
#
#   bff.zip                       Web Chat BFF 的 Lambda 代码（含 node_modules）
#   chat-dist.zip                 前端构建产物（index.html / assets/… 在 zip 根）
#   web-notif.zip                 「通知」生产端 Lambda（AWS 事件 → Web 收件箱）
#   im-code.zip                   IM（飞书/Slack）三个 Lambda 的业务代码
#   im-layer.zip                  IM 依赖层（lark-oapi + slack-sdk + boto3，manylinux2014）
#   agent-code.zip                AgentCore Runtime 的 CodeZip（含 linux/aarch64 依赖，~144MB）
#   SHA256SUMS                    上面六个 zip 的校验和
#   notiops-webchat.template.json 客户点 "Launch Stack" 打开的那份模板
#
# 模板与产物是**一对一绑死**的：tag 进 S3 key、sha256 进模板里的产物清单。
# 所以这些文件必须**同一次运行**产出、一起发布；混搭两次运行的产物 =
# StagerFn 校验 sha256 不通过 = 客户侧开栈失败（这正是我们要的失败方式）。
#
# 两个 im-*.zip **必须始终产出**，与客户选不选装 IM 无关：`InstallOption` 是**部署期**
# 参数（客户在参数页下拉框里选 web / web+feishu / web+slack），发布时不知道他会选什么。
# 客户选「只装 web」时 StagerFn 按 `im-` 前缀跳过下载（infra/lambda/stager/index.py），
# 所以不装 IM 的客户不为这两个 zip 付流量。
#
# 六个产物为什么各自这样打：
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
#   · web-notif.zip 由 scripts/build_web_notif_zip.py 从 **import 闭包**算出来打，
#     不是 zip 一个写死的文件清单。理由见那个脚本的文件头（清单会静默过期）。
#   · im-code.zip / im-layer.zip 由 scripts/build_im_zips.py 按
#     infra/im-code-exclude.txt 打 —— 那份排除清单**方式B（infra/lib/im-stack.ts）
#     读的是同一个文件**，所以两条路径的 IM 代码不可能漂（2026-09-01 拿现网
#     notiops-im-worker-feishu 的代码包对过，差集只有 6 个点文件，已在清单里补掉）。
#     代码与依赖层分开：层只在依赖升版时变，没必要每次发布重传 26MiB。
#     ⚠️ 打层需要 lambda_layer_im/ 已构建（bash scripts/build_im_layer.sh）；缺包
#     直接失败，不做"跳过 IM"的降级 —— 那会静默发布一个装不上 IM 的 Release。
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
# 于是"清单里混着上一轮的产物"这种状态要到客户开栈时才暴露。
rm -f "$OUT_DIR/bff.zip" "$OUT_DIR/chat-dist.zip" "$OUT_DIR/web-notif.zip" \
      "$OUT_DIR/im-code.zip" "$OUT_DIR/im-layer.zip" \
      "$OUT_DIR/agent-code.zip" "$OUT_DIR/SHA256SUMS" "$TEMPLATE_OUT"

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

# ── 2b. 「通知」生产端 → web-notif.zip ────────────────────────────────────────
step "web notification handler -> web-notif.zip"
python3 scripts/build_web_notif_zip.py --out "$OUT_DIR/web-notif.zip"

# ── 2c. IM（飞书 / Slack）加装项 → im-code.zip + im-layer.zip ─────────────────
step "im code + deps layer -> im-code.zip / im-layer.zip"
python3 scripts/build_im_zips.py --out-dir "$OUT_DIR"

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
# 六个 zip 都是"内容错了也照样能上传、要等客户开栈甚至打开页面才暴露"的类型。
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

# web-notif.zip —— handler 是 shared/report_delivery/web_push_handler.py，且它 import 的
# core/push_event.py 必须在包里（少了它 = 客户账号里 ImportError，症状是"通知页面一直空着"）。
# 每层包的 __init__.py 也必须在（少一个就是 ModuleNotFoundError）。
notif = names("web-notif.zip")
check("web-notif.zip has the handler module",
      "shared/report_delivery/web_push_handler.py" in notif)
check("web-notif.zip bundles core/push_event.py", "core/push_event.py" in notif)
check("web-notif.zip has every package __init__.py",
      {"core/__init__.py", "shared/__init__.py", "shared/report_delivery/__init__.py"} <= set(notif))
check("web-notif.zip carries only python sources",
      all(n.endswith(".py") for n in notif),
      "unexpected non-.py entries: " + ", ".join(n for n in notif if not n.endswith(".py")))

# im-code.zip —— 三个 handler 的模块路径与 infra/lib/constructs/im-core.ts 的
# `handler:` 逐字对应；混进 node_modules / dist 说明排除清单没读到
# （build_im_zips.py 自己也查这两条，这里是发布前最后一道，防的是"有人绕过那个脚本"）。
im_code = names("im-code.zip")
check("im-code.zip has the Feishu ingress handler", "platforms/feishu/lambda_ingress.py" in im_code)
check("im-code.zip has the Feishu worker handler", "platforms/feishu/lambda_worker.py" in im_code)
check("im-code.zip has the Slack ingress handler", "platforms/slack/lambda_ingress.py" in im_code)
check("im-code.zip has the Slack worker handler", "platforms/slack/lambda_worker.py" in im_code)
check("im-code.zip has the progress poller handler", "platforms/common/lambda_progress.py" in im_code)
check("im-code.zip has the deterministic router", "platforms/common/router.py" in im_code)
check("im-code.zip has core/devops_agent.py", "core/devops_agent.py" in im_code)
check("im-code.zip carries no node_modules / dist / infra",
      not any(n.startswith(("node_modules/", "dist/", "infra/", "frontend/")) or "/node_modules/" in n
              for n in im_code),
      "the exclude list (infra/im-code-exclude.txt) did not apply")

# im-layer.zip —— LayerVersion 要求依赖躺在 zip 根的 `python/` 下，且必须是
# manylinux 的 wheel（Mac 上装的那份在 Lambda 上 import 直接炸）。
im_layer = names("im-layer.zip")
check("im-layer.zip puts deps under python/", any(n.startswith("python/") for n in im_layer))
check("im-layer.zip bundles lark_oapi", any(n.startswith("python/lark_oapi/") for n in im_layer))
check("im-layer.zip bundles slack_sdk", any(n.startswith("python/slack_sdk/") for n in im_layer))
check("im-layer.zip bundles botocore", any(n.startswith("python/botocore/") for n in im_layer))
# 原生扩展必须是 **Linux x86_64 的 ELF**。不按文件名判（pycryptodome 装出来的是
# `_raw_aes.abi3.so`，名字里没有架构，Mac 上装的那份长得一模一样），直接读 ELF 头：
# e_ident 魔数 + e_machine==0x3E。Mac wheel 是 Mach-O（魔数 0xcffaedfe），
# 症状是 Lambda 上 `import lark_oapi` 直接崩，而飞书侧只看到超时。
so_names = sorted(n for n in im_layer if n.endswith(".so"))
check("im-layer.zip has native extensions at all", bool(so_names))
if so_names:
    with zipfile.ZipFile(out / "im-layer.zip") as zf:
        head = zf.read(so_names[0])[:20]
    check("im-layer.zip native extensions are Linux x86_64 ELF",
          head[:4] == b"\x7fELF" and head[18:20] == b"\x3e\x00",
          f"{so_names[0]} is not an x86_64 ELF (magic={head[:4]!r}, e_machine={head[18:20]!r}) — "
          "rebuild with scripts/build_im_layer.sh (--platform manylinux2014_x86_64)")

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
(cd "$OUT_DIR" && shasum -a 256 bff.zip chat-dist.zip web-notif.zip \
    im-code.zip im-layer.zip agent-code.zip > SHA256SUMS)
cat "$OUT_DIR/SHA256SUMS"

# ── 6. 后处理模板 ─────────────────────────────────────────────────────────────
step "postprocess template"
POST_ARGS=(--in "$SYNTH_DIR/NotiOps.template.json" --out "$TEMPLATE_OUT"
           --release-tag "$RELEASE_TAG" --sha256 "$OUT_DIR/SHA256SUMS")
[ -n "$BASE_URL" ] && POST_ARGS+=(--base-url "$BASE_URL")
python3 scripts/postprocess_template.py "${POST_ARGS[@]}"

# ── 7. 收尾 ──────────────────────────────────────────────────────────────────
step "done"
(cd "$OUT_DIR" && ls -lh bff.zip chat-dist.zip web-notif.zip im-code.zip im-layer.zip \
    agent-code.zip SHA256SUMS notiops-webchat.template.json)
cat <<EOF

Publish these eight files together (they are cryptographically bound to each other):
  $OUT_DIR

Next:
  1. Upload the six zips + SHA256SUMS as assets of release $RELEASE_TAG
     (or to the S3 prefix you passed as --base-url).
  2. Upload notiops-webchat.template.json to S3 and deploy via --template-url
     (it is larger than CloudFormation's 51,200-byte --template-body limit).
  3. aws cloudformation validate-template --template-url <url>
EOF
