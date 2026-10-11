#!/usr/bin/env bash
#
# 构建成本 MCP server 的依赖层（lambda_layer_cost/）。
#
# 为什么单独一层，而不是塞进 lambda_layer/ 或 lambda_layer_im/：
#   lambda_layer/ 挂在后端那 8 个 Lambda 上，lambda_layer_im/ 挂在 3 个 IM Lambda 上。
#   成本 MCP 这一层带 mcp/starlette/pydantic-core/cryptography（解包 ~60MB），而那 11 个
#   函数一行都不用。三层分开各自留出 250MB 余量。
#
# 为什么必须 --platform manylinux2014_x86_64（与 scripts/build_im_layer.sh 同一条理由）：
#   在 Mac 上直接 pip install -t 装进去的是 macOS 二进制，Lambda 上 import 直接
#   ImportError —— 不是"慢一点"，是完全跑不起来。`--implementation cp
#   --only-binary=:all:` 一起用，才能让 pip 拒绝退回源码构建（退回源码构建 = 又装成
#   本机平台，**静默**失败）。
#
# 版本来源：cost_mcp/requirements.txt —— **全等值钉死的 36 个包**，唯一事实源。
#   这里不再内联任何版本号（IM 那份脚本内联是历史原因）。
#
# ⚠️ 上游交来的是一份**解开的 Lambda 部署包**（66MB vendored + 4 个 .so），其中三个 .so
#   是 cp311 版本锁死的，而本仓所有 Lambda 都是 PYTHON_3_14 —— 直接拿来用会 ImportError。
#   所以我们**不复用**那份 vendored 树，全部按下面的参数重装。
#
# 用法：
#   bash scripts/build_cost_layer.sh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

DEST="lambda_layer_cost/python"
REQ="cost_mcp/requirements.txt"

# 与 infra 里 `lambda.Runtime.PYTHON_3_14` 成契约，升级运行时要同时改这里。
RUNTIME_MV="3.14"
PLAT_ARGS="--platform manylinux2014_x86_64 --implementation cp --only-binary=:all:"

[ -f "$REQ" ] || { echo "[cost-layer] ❌ 找不到 $REQ" >&2; exit 1; }

echo "[cost-layer] 清理 $DEST"
rm -f -r "$DEST"
mkdir -p "$DEST"

# 中途失败必须把半成品删干净（同 build_im_layer.sh 的理由）：留下一个装了一半的 $DEST，
# 下一次 cdk deploy 会拿它当"层已就绪"部上去，Lambda 上 import 崩，而客户侧只看到超时。
cleanup_on_fail() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "[cost-layer] ❌ 构建失败（exit ${rc}）—— 删除半成品 ${DEST}" >&2
    rm -f -r "$DEST"
  fi
  return "$rc"
}
trap cleanup_on_fail EXIT

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip --quiet

# 本机 python 的 major.minor 必须与 Lambda 运行时一致 —— 下面要预编译字节码，而 .pyc 的
# magic number 按 minor 版本绑定：版本不一致的 .pyc 会被 CPython **静默忽略**，表现是
# "层大了一倍、冷启动一秒没快"，没有任何报错。
PY_MV=$(python -c 'import sys; print("%d.%d" % sys.version_info[:2])')
if [ "$PY_MV" != "$RUNTIME_MV" ]; then
  echo "[cost-layer] ❌ .venv 是 python ${PY_MV}，Lambda 运行时是 python ${RUNTIME_MV}。" >&2
  echo "           解法：rm -f -r .venv && python$RUNTIME_MV -m venv .venv && bash scripts/build_cost_layer.sh" >&2
  exit 1
fi

echo "[cost-layer] 按 $REQ 安装（$(grep -c '^[a-z]' "$REQ") 个钉死的包）"
# shellcheck disable=SC2086
pip install -r "$REQ" -t "$DEST" --quiet --upgrade $PLAT_ARGS

deactivate

# ─── 预编译字节码 ───────────────────────────────────────────────────────────
# 理由与收益见 scripts/build_im_layer.sh 里那一大段（IM 侧实测 3.3 倍）。这一层的模块数
# 远小于 lark_oapi，但 pydantic + starlette 的 import 图也不小，且**层是只读的**、
# CPython 写不出 __pycache__，不预编译就是每次冷启动重编一遍。
# `--invalidation-mode unchecked-hash` 是必须的：打包会把 mtime 钉死，timestamp 模式下
# 每个 .pyc 都会被判失效 —— 白编译一场，而且是静默的。
echo "[cost-layer] 预编译字节码（python $PY_MV, unchecked-hash）"
.venv/bin/python -m compileall -q -j 4 --invalidation-mode unchecked-hash "$DEST"

PY_COUNT=$(find "$DEST" -name '*.py' | wc -l | tr -d ' ')
PYC_COUNT=$(find "$DEST" -name '*.pyc' | wc -l | tr -d ' ')
if [ "$PYC_COUNT" -lt "$PY_COUNT" ]; then
  echo "[cost-layer] ❌ 预编译不完整：$PY_COUNT 个 .py 只编出 $PYC_COUNT 个 .pyc" >&2
  exit 1
fi
echo "[cost-layer] ✓ 预编译 $PYC_COUNT/$PY_COUNT"

# ─── 平台与 ABI 校验（比 IM 那份更严）─────────────────────────────────────────
# ⚠️ 为什么不能只查 "有没有 macOS 二进制"：上游那份 vendored 树里的 .so **全是 Linux**
# x86_64 的，只是 **cp311** —— 按"没有 darwin 就算过"的判据它能通过，然后在 python3.14 的
# Lambda 上 ImportError。scripts/package_artifacts.sh 现有的检查也只读了第一个 .so 的
# ELF 头，同样看不出 ABI 不匹配。所以这里**逐个** .so 校验 ABI tag。
BAD=$(find "$DEST" -name '*-darwin.so' -o -name '*.dylib' | head -5)
if [ -n "$BAD" ]; then
  echo "[cost-layer] ❌ 检测到 macOS 二进制，层不可用于 Lambda:" >&2
  echo "$BAD" >&2
  exit 1
fi

python3 - "$DEST" "$RUNTIME_MV" <<'PY'
import os, re, sys

dest, runtime_mv = sys.argv[1], sys.argv[2]
tag = "cpython-" + runtime_mv.replace(".", "")      # 例：cpython-314
sos = [os.path.join(r, f) for r, _d, fs in os.walk(dest) for f in fs if f.endswith(".so")]

# ABI 逐个校验。两类合法：
#   1. `*.cpython-314-x86_64-linux-gnu.so` —— 版本锁定，必须正好等于运行时版本
#   2. `*.abi3.so` —— 稳定 ABI，跨 minor 版本通用（cryptography 走这条）
bad = []
for p in sos:
    base = os.path.basename(p)
    if ".abi3." in base:
        continue
    m = re.search(r"cpython-(\d+)", base)
    if m and f"cpython-{m.group(1)}" != tag:
        bad.append((base, m.group(1)))
if bad:
    print(f"[cost-layer] ❌ {len(bad)} 个原生扩展的 ABI 与运行时 python {runtime_mv} 不符：",
          file=sys.stderr)
    for base, got in bad[:8]:
        print(f"             {base}  (cpython-{got}，期望 {tag})", file=sys.stderr)
    print("           这正是上游那份 vendored 树的形态（cp311）—— 必须按 "
          "--python-version 重装。", file=sys.stderr)
    raise SystemExit(1)
print(f"[cost-layer] ✓ {len(sos)} 个原生扩展 ABI 校验通过（{tag} 或 abi3）")

top = sorted(d for d in os.listdir(dest) if not d.endswith(".dist-info") and not d.startswith("_"))
print("[cost-layer] 顶层包:", ", ".join(top[:14]) + ("…" if len(top) > 14 else ""))
# 三个直接依赖必须在；缺了就是 requirements 被改坏了。
for must in ("mcp", "mangum", "boto3", "botocore", "starlette", "pydantic"):
    assert must in top, f"{must} missing from the cost layer"

# Lambda 层解压后 250MB 硬上限（所有层 + 代码合计 262144000 字节）。在这里拦住，
# 而不是等 cdk deploy 走到一半报 `Unzipped size must be smaller than 262144000 bytes`。
LIMIT = 250 * 1024 * 1024
WARN = int(LIMIT * 0.85)
total = sum(os.path.getsize(os.path.join(r, f)) for r, _d, fs in os.walk(dest) for f in fs)
mb = total / 1024 / 1024
if total > LIMIT:
    raise SystemExit(f"[cost-layer] ❌ 解压后 {mb:.0f}MB 超过 250MB 上限")
if total > WARN:
    print(f"[cost-layer] ⚠️  解压后 {mb:.0f}MB，已用掉上限的 {100 * total / LIMIT:.0f}%")
else:
    print(f"[cost-layer] ✓ 解压后 {mb:.0f}MB / 250MB 上限")
PY

SIZE=$(du -sh "$DEST" | cut -f1)
echo "[cost-layer] ✓ 完成 —— $DEST ($SIZE)"
