#!/usr/bin/env bash
# 一键部署（Launch Stack）的**发布产物构建**脚本 —— 维护者用，不面向客户。
#
# 产出这些东西，一起挂到一个 GitHub Release 上（对客说明见 docs/DEPLOYMENT_ONECLICK.md）：
#
#   bff.zip                       Web Chat BFF 的 Lambda 代码（含 node_modules）
#   chat-dist.zip                 前端构建产物（index.html / assets/… 在 zip 根）
#   web-notif.zip                 「通知」生产端 Lambda（AWS 事件 → Web 收件箱）
#   im-code.zip                   IM（飞书/Slack/钉钉）Lambda 的业务代码（只取 IM 运行时那几个包，见 build_im_zips.py）
#   im-layer.zip                  IM 依赖层（lark-oapi + slack-sdk + boto3，manylinux2014）
#   cost-mcp-code.zip             自建成本 MCP server 的 Lambda 代码（只含 cost_mcp/）
#   cost-mcp-layer.zip            自建成本 MCP server 的依赖层（带预编译 .pyc）
#   cur-provisioner.zip           CUR 自建（ProvisionCur=yes）：阶段一 custom resource + 阶段二 finalizer
#   agent-code.zip                AgentCore Runtime 的 CodeZip（含 linux/aarch64 依赖，~144MB）
#   SHA256SUMS                    上面那些 zip 的校验和（清单见 scripts/artifacts.py）
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
# 各产物为什么这样打（清单与顺序见 scripts/artifacts.py）：
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
# 产物名从 scripts/artifacts.py 派生（唯一真源）—— 这里曾经是一份手抄的清单，
# 漏一个的症状是「上一轮的旧 zip 被这一轮的 SHA256SUMS 一起算进去」。
ARTIFACT_NAMES="$(python3 "$(dirname "$0")/artifacts.py" all)"
for _a in $ARTIFACT_NAMES; do rm -f "$OUT_DIR/$_a"; done
rm -f "$OUT_DIR/SHA256SUMS" "$TEMPLATE_OUT"

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

# ── 2d. 自建成本 MCP server → cost-mcp-code.zip + cost-mcp-layer.zip ─────────
# 与 IM 同构地分成 code + layer：依赖层解压 ~64MB，与 1902 行业务代码放一起会让每次
# 改 Python 都重传整包；而且 Lambda「代码 + 层」解压合计上限 250MB，层是共享依赖的机制。
# ⚠️ 层必须用 scripts/build_cost_layer.sh 打 —— 它带 manylinux2014 + cp314 的平台参数，
# 并逐个校验原生扩展的 ABI。直接 pip install 会装成本机（macOS）二进制，
# 部署成功、Lambda 上 import 崩。
step "cost mcp code + deps layer -> cost-mcp-code.zip / cost-mcp-layer.zip"
bash scripts/build_cost_layer.sh
# mtime 钉死成 1980-01-01，让同一份源码每次打出**逐字节相同**的 zip（sha256 可复现）。
python3 - "$OUT_DIR" <<'PYZIP'
import os, sys, zipfile
out_dir = sys.argv[1]
FIXED = (1980, 1, 1, 0, 0, 0)

def write_zip(zip_path, root, arc_prefix="", keep_pyc=True, skip_dirs=()):
    names = []
    for base, dirs, files in os.walk(root):
        # skip_dirs:相对 root 的目录，整棵不打（层的 `python/bin`，理由见下面调用处）
        dirs[:] = [d for d in dirs if os.path.relpath(os.path.join(base, d), root) not in skip_dirs]
        # ⚠️ 代码 zip（keep_pyc=False）必须剪掉 __pycache__ —— 本机跑过 py_compile / 测试之后 cost_mcp/
        # 下会有它，实测第一版打出来是 13 个文件而不是 7 个。层（keep_pyc=True）则**刻意保留**：
        # 预编译是冷启动能低于 10s 的唯一决定性因素（见 build_cost_layer.sh），而 .pyc 恰好**全在**
        # __pycache__ 里。原来这里不分青红皂白地剪 → 发出去的 cost-mcp-layer.zip 一个 .pyc 都没有
        # （2026-10-10 发版前审查实测：914 个 .py / 0 个 .pyc），与方式 B 的 fromAsset 不对等。
        dirs[:] = sorted(d for d in dirs if keep_pyc or d != "__pycache__")
        for f in sorted(files):
            if f.endswith(".DS_Store"):
                continue
            if keep_pyc is False and f.endswith(".pyc"):
                continue
            full = os.path.join(base, f)
            arc = os.path.join(arc_prefix, os.path.relpath(full, root))
            names.append((full, arc))
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for full, arc in sorted(names, key=lambda x: x[1]):
            zi = zipfile.ZipInfo(arc, date_time=FIXED)
            zi.external_attr = 0o644 << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            with open(full, "rb") as fh:
                z.writestr(zi, fh.read())
    return len(names)


def write_zip_into(zip_path, root, arc_prefix="", keep_pyc=True):
    """把第二个目录**追加**进一个已存在的 zip（同一份 mtime / 权限口径）。

    给 cur-provisioner.zip 用：它要同时装 `cur_provisioner/` 和 `lambda6_cur_finalizer/`
    两个包（两个 handler 共用一个产物）。
    ⚠️ 用 `"a"` 而不是重新打开写 —— `"w"` 会把前一半截掉，而且不会报错。
    """
    names = []
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if keep_pyc or d != "__pycache__")   # 同 write_zip
        for f in sorted(files):
            if f.endswith(".DS_Store"):
                continue
            if keep_pyc is False and f.endswith(".pyc"):
                continue
            full = os.path.join(base, f)
            names.append((full, os.path.join(arc_prefix, os.path.relpath(full, root))))
    with zipfile.ZipFile(zip_path, "a", zipfile.ZIP_DEFLATED) as z:
        for full, arc in sorted(names, key=lambda x: x[1]):
            zi = zipfile.ZipInfo(arc, date_time=FIXED)
            zi.external_attr = 0o644 << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            with open(full, "rb") as fh:
                z.writestr(zi, fh.read())
    return len(names)

n1 = write_zip(os.path.join(out_dir, "cost-mcp-code.zip"), "cost_mcp", "cost_mcp", keep_pyc=False)
# ⚠️ `python/bin` 不打：pip 装出来的 console-script 包装器第一行是**构建机 venv 的绝对路径**（从主检出
# 打包时就是本机用户名 + 目录结构），而这个 zip 公开发布；在 Lambda 里它们也毫无用处。IM 层同理
# （scripts/build_im_zips.py::collect_layer）。末尾的 check_artifacts_no_local_paths.py 是兜底判据。
n2 = write_zip(os.path.join(out_dir, "cost-mcp-layer.zip"), "lambda_layer_cost", skip_dirs=("python/bin",))
# 层必须带预编译字节码（与 build_im_layer.sh 对 IM 层的断言同一口径）：.pyc 少于 .py = 方式 A 的
# 成本 MCP 每次冷启动都要在只读的 /opt 上把整层重新编译一遍。
with zipfile.ZipFile(os.path.join(out_dir, "cost-mcp-layer.zip")) as _z:
    _n = _z.namelist()
    _py = sum(1 for x in _n if x.endswith(".py")); _pyc = sum(1 for x in _n if x.endswith(".pyc"))
if _pyc < _py:
    sys.exit(f"cost-mcp-layer.zip: {_py} .py but only {_pyc} .pyc -- the layer must ship precompiled "
             "bytecode (re-run scripts/build_cost_layer.sh; never prune __pycache__ from a layer)")
print(f"  cost-mcp-code.zip: {n1} files | cost-mcp-layer.zip: {n2} files")

# ── CUR 自建（方式 A 的 ProvisionCur=yes）→ cur-provisioner.zip ────────────────
# 两个 handler 打在**同一个 zip** 里：
#   · `cur_provisioner.custom_resource.handler` = 阶段一（建桶 + 桶策略 + ReportDefinition）
#   · `lambda6_cur_finalizer.handler.handler`   = 阶段二（AWS 首次交付后部署官方 Athena 集成）
# 合起来不到 40 KB，拆成两个产物只会让发布清单和 stager 多两条要维护的东西。
# ⚠️ 没有依赖层：这两段只用 boto3（Lambda 运行时自带）+ 标准库。
n3 = write_zip(os.path.join(out_dir, "cur-provisioner.zip"), "cur_provisioner",
               "cur_provisioner", keep_pyc=False)
n3 += write_zip_into(os.path.join(out_dir, "cur-provisioner.zip"), "lambda6_cur_finalizer",
                     "lambda6_cur_finalizer", keep_pyc=False)
print(f"  cur-provisioner.zip: {n3} files")
PYZIP

# ── 3. Agent → agent-code.zip ────────────────────────────────────────────────
step "agentcore package -> agent-code.zip"
AGENT_ZIP="$AGENT_DIR/agentcore/NotiOpsWebChat.zip"
if [ "$REUSE_AGENT" -eq 1 ]; then
  [ -f "$AGENT_ZIP" ] || die "--reuse-agent given but $AGENT_ZIP does not exist"
  echo "  reusing $AGENT_ZIP ($(du -h "$AGENT_ZIP" | cut -f1))"
else
  # 拉 linux/aarch64 + cp313 的 wheel 到本地再打包，几分钟量级。
  # 版本表与 deploy_agent.sh 是同一份（UV_CONSTRAINT，CLI 调的 uv 会读它）：方式 A 的 agent-code.zip
  # 与方式 B 部署装到的依赖逐个同版本 —— 不钉的话，两条路径装到哪个版本取决于各自哪天打包。
  AGENT_CONSTRAINTS="$AGENT_DIR/agent-constraints.txt"
  [ -f "$AGENT_CONSTRAINTS" ] || die "missing $AGENT_CONSTRAINTS (the agent's pinned dependency versions)"
  (cd "$AGENT_DIR" && UV_CONSTRAINT="$AGENT_CONSTRAINTS" agentcore package -d . -r NotiOpsWebChat)
  [ -f "$AGENT_ZIP" ] || die "agentcore package produced no $AGENT_ZIP"
fi
cp "$AGENT_ZIP" "$OUT_DIR/agent-code.zip"
# agent 依赖里 console-script 包装器(bin/*)的第一行由 uv 按构建机写:macOS 交叉打包时是
# `#!/usr/bin/env python3`,Linux 构建机上却是本机 venv 的绝对路径(2026-10-25 在 Linux 上打 v1.0.33-rc1
# 时被末尾的「无本地路径」判据拦下)。统一改写成 env 写法,产物不随构建机变化,在 runtime 里也能直接执行。
python3 scripts/relocatable_shebangs.py "$OUT_DIR/agent-code.zip"

# ── 4. 逐个产物验形状 ─────────────────────────────────────────────────────────
# 这些 zip 都是"内容错了也照样能上传、要等客户开栈甚至打开页面才暴露"的类型。
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
# IM 多账号（`/account`）的两块：`core/im_accounts.py` 读账号注册表 + 算 `allowed_accounts`
# 闸门，`shared/queries/accounts.py` 是它读的那条 GSI1 Query。
# 少了任一个，worker 一收消息就 `No module named …` → **每一条**消息都失败（不只是
# `/account`），因为 `lambda_worker._normalize_message` 每条都要解析当前账号。
check("im-code.zip has core/im_accounts.py", "core/im_accounts.py" in im_code)
check("im-code.zip has the account registry query",
      "shared/queries/accounts.py" in im_code)
# 方式A 的调查结果回调函数与 IM 三个函数**共用这同一个 zip**（方式B 那边是独立资产）。
# 少了它，客户账号里的回调一调就 `No module named 'devops_agent_callback'`，
# 而那条链路是异步的 → 客户只看到「深度调查跑完了，报告和公网 URL 永远不来」。
# 曾经真的漏过：`infra/im-code-exclude.txt` 里有一行把整个包剪掉了（2026-09-04 移除）。
check("im-code.zip has the DevOps Agent callback handler",
      "devops_agent_callback/handler.py" in im_code,
      "infra/im-code-exclude.txt must NOT exclude devops_agent_callback/**")
check("im-code.zip has the report delivery handler",
      "shared/report_delivery/report_handler.py" in im_code)
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

# cost-mcp-code.zip / cost-mcp-layer.zip —— 自建成本 MCP server。
cost_code = names("cost-mcp-code.zip")
check("cost-mcp-code.zip has the Lambda handler module",
      "cost_mcp/lambda_handler.py" in cost_code)
check("cost-mcp-code.zip has the Athena executor", "cost_mcp/athena.py" in cost_code)
check("cost-mcp-code.zip has the SQL template library", "cost_mcp/sql.py" in cost_code)
# 只许有 cost_mcp/ —— 资产范围跑偏过一次：`exclude: ["*"]` 里的 `*` 不匹配点文件,
# 于是 .gitlab-ci.yml / .gitleaks.toml 漏进了会下发到**客户账号**的包里。
check("cost-mcp-code.zip contains nothing outside cost_mcp/",
      all(n.startswith("cost_mcp/") for n in cost_code),
      "unexpected: " + ", ".join(sorted(n for n in cost_code if not n.startswith("cost_mcp/"))[:6]))
check("cost-mcp-code.zip carries no .pyc", not any(n.endswith(".pyc") for n in cost_code))

# cur-provisioner.zip —— CUR 自建（方式 A 的 ProvisionCur=yes）。两个 handler 一个包。
cur_prov = names("cur-provisioner.zip")
check("cur-provisioner.zip has the stage-1 custom resource handler",
      "cur_provisioner/custom_resource.py" in cur_prov)
check("cur-provisioner.zip has the CUR spec (shared with setup.sh)",
      "cur_provisioner/spec.py" in cur_prov)
check("cur-provisioner.zip has the stage-1 provisioner",
      "cur_provisioner/provision.py" in cur_prov)
# ⚠️ 阶段二必须在**同一个** zip 里 —— 一键栈的 CurFinalizerFn 用的就是这个 key,
# 只是 handler 指向 lambda6。漏了它的症状是部署成功、然后 CUR 永远停在 PENDING。
check("cur-provisioner.zip has the stage-2 finalizer",
      "lambda6_cur_finalizer/handler.py" in cur_prov)
check("cur-provisioner.zip has the FinOps saved queries",
      "lambda6_cur_finalizer/athena_saved_queries.py" in cur_prov)
check("cur-provisioner.zip contains nothing else",
      all(n.startswith(("cur_provisioner/", "lambda6_cur_finalizer/")) for n in cur_prov),
      "unexpected: " + ", ".join(sorted(
          n for n in cur_prov if not n.startswith(("cur_provisioner/", "lambda6_cur_finalizer/")))[:6]))
check("cur-provisioner.zip carries no .pyc", not any(n.endswith(".pyc") for n in cur_prov))

cost_layer = names("cost-mcp-layer.zip")
check("cost-mcp-layer.zip puts deps under python/", any(n.startswith("python/") for n in cost_layer))
for pkg in ("mcp", "mangum", "boto3", "botocore", "starlette", "pydantic"):
    check(f"cost-mcp-layer.zip bundles {pkg}", any(n.startswith(f"python/{pkg}/") for n in cost_layer))
# ⚠️ 这里**逐个** .so 校验 ABI，比上面 im-layer 那段严：那段只读了 `so_names[0]` 的 ELF 头,
# 而"是 Linux ELF"与"ABI 版本对得上"是两件事 —— 上游交来的 cost MCP 依赖树里那些 .so
# 全是 Linux x86_64 的，只是 cp311，在 python3.14 的 Lambda 上照样 ImportError。
cost_sos = sorted(n for n in cost_layer if n.endswith(".so"))
check("cost-mcp-layer.zip has native extensions at all", bool(cost_sos))
if cost_sos:
    import re as _re
    with zipfile.ZipFile(out / "cost-mcp-layer.zip") as zf:
        for so in cost_sos:
            head = zf.read(so)[:20]
            check(f"{so.split('/')[-1]} is a Linux x86_64 ELF",
                  head[:4] == b"\x7fELF" and head[18:20] == b"\x3e\x00",
                  f"magic={head[:4]!r} e_machine={head[18:20]!r} — rebuild with scripts/build_cost_layer.sh")
    bad_abi = []
    for so in cost_sos:
        base = so.split("/")[-1]
        if ".abi3." in base:
            continue          # 稳定 ABI，跨 minor 通用（cryptography 走这条）
        m = _re.search(r"cpython-(\d+)", base)
        if m and m.group(1) != "314":
            bad_abi.append(base)
    check("cost-mcp-layer.zip native extensions target cpython-314 (or abi3)",
          not bad_abi,
          "wrong ABI: " + ", ".join(bad_abi[:6]) + " — scripts/build_cost_layer.sh pins "
          "--python-version 3.14; a cp311 wheel deploys fine and then ImportErrors on Lambda")

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

# ── 4b. 公开产物里不许有构建机的本地路径 ─────────────────────────────────────────
# §2.3 的 comm 核对只管「来自仓库的文件在不在快照里」，看不见第三方包里被构建过程写进去的东西 ——
# 2026-10-11 发 v1.0.30 前查出：两个依赖层的 console-script 包装器带着构建机 venv 的绝对路径，从主检出
# 打出来的就是本机用户名。这一步扫**全部**产物的全部文件，命中 $HOME 或仓库根的绝对路径就整条失败。
step "no builder-local paths in any artifact"
python3 scripts/check_artifacts_no_local_paths.py "$OUT_DIR"

# ── 5. SHA256SUMS ────────────────────────────────────────────────────────────
step "SHA256SUMS"
# 行序与 release notes 校验和段一致（都取 artifacts.py 的 NOTES_ORDER）——
# 以前两边行序不同，客户对照着看时容易以为漏了一个。shasum -c 对行序不敏感。
# shellcheck disable=SC2086
(cd "$OUT_DIR" && shasum -a 256 $(python3 "$PROJECT_ROOT/scripts/artifacts.py" sums) > SHA256SUMS)
cat "$OUT_DIR/SHA256SUMS"

# ── 5.5 把校验和写进 release notes ─────────────────────────────────────────────
# 客户唯一能自己核对产物的东西就是 Release 正文里那几行 sha256（每个 zip 一行，清单见 scripts/artifacts.py）（模板里烧的是同
# 一份，栈下载后逐个比对）。到 2026-09-04 发 v1.0.20 为止，这一步是纯手抄：上面
# 那个 `cat SHA256SUMS` 打出来，人再贴进 notes。抄错一位不会有任何东西报警，
# 后果出现在**客户账号里**（checksum 不匹配 → 栈 ROLLBACK）。
#
# notes 还没写不是错误（正文常常在打完产物之后才写完），但**必须大声说**该补哪条
# 命令 —— 静默跳过就等于把手抄那一步原样留着。
NOTES="publish/RELEASE_NOTES_$RELEASE_TAG.md"
step "release notes checksums"
if [ -f "$NOTES" ]; then
  python3 scripts/write_release_notes_sums.py --sha256 "$OUT_DIR/SHA256SUMS" --notes "$NOTES"
else
  echo "  ⚠ 还没有 $NOTES —— 校验和**没有**写进任何地方。"
  echo "    正文写好后（范式见发布手册的「校验和段」一节）补跑一次:"
  echo "      python3 scripts/write_release_notes_sums.py \\"
  echo "        --sha256 $OUT_DIR/SHA256SUMS --notes $NOTES"
  echo "    别手抄 —— 抄错一位的报错现场在客户账号里。"
fi

# ── 6. 后处理模板 ─────────────────────────────────────────────────────────────
step "postprocess template"
POST_ARGS=(--in "$SYNTH_DIR/NotiOps.template.json" --out "$TEMPLATE_OUT"
           --release-tag "$RELEASE_TAG" --sha256 "$OUT_DIR/SHA256SUMS")
[ -n "$BASE_URL" ] && POST_ARGS+=(--base-url "$BASE_URL")
python3 scripts/postprocess_template.py "${POST_ARGS[@]}"

# ── 7. 收尾 ──────────────────────────────────────────────────────────────────
step "done"
# 产物清单从 scripts/artifacts.py 派生（唯一真源）；另外两个不是 zip：校验和与模板。
# shellcheck disable=SC2086
(cd "$OUT_DIR" && ls -lh $ARTIFACT_NAMES SHA256SUMS notiops-webchat.template.json)
FILE_COUNT=$(( $(echo "$ARTIFACT_NAMES" | wc -w | tr -d ' ') + 2 ))
cat <<EOF

Publish these $FILE_COUNT files together (they are cryptographically bound to each other):
  $OUT_DIR

Next:
  1. Upload all $(echo "$ARTIFACT_NAMES" | wc -w | tr -d " ") zips + SHA256SUMS as assets of release $RELEASE_TAG
     (or to the S3 prefix you passed as --base-url).
  2. Upload notiops-webchat.template.json to S3 and deploy via --template-url
     (it is larger than CloudFormation's 51,200-byte --template-body limit).
  3. aws cloudformation validate-template --template-url <url>
EOF
