#!/usr/bin/env bash
#
# 构建 IM Lambda 依赖层（lambda_layer_im/）—— IM 重构 M1。
#
# 为什么单独一层，而不是塞进 lambda_layer/：
#   lambda_layer/ 挂在后端那 8 个 Lambda 上，加 lark_oapi（解包后 ~40MB）会让**每一个**
#   后端函数的冷启动都变慢，而它们一行飞书 SDK 都不用。Lambda 层有 250MB 解包上限，
#   两边分开也留出余量。
#
# 为什么必须 --platform manylinux2014_x86_64：
#   在 Mac（arm64 / macOS wheel）上直接 pip install -t，装进去的是 macOS 二进制，
#   Lambda 上 import 直接 ImportError。这不是"慢一点"，是完全跑不起来。
#   --implementation cp --only-binary=:all: 一起用，才能让 pip 拒绝退回源码构建
#   （退回源码构建 = 又装成本机平台，静默失败）。
#
# 版本钉死（不许 >=）：SDK 小版本会改事件模型的字段名与 EventDispatcherHandler 的
# 内部行为（ingress 的验签就依赖 `_verify_sign` 的具体形状，见
# platforms/feishu/lambda_ingress.py 文件头「硬约束 A」）。漂一个版本可能让验签静默失效。
#
# 用法：
#   bash scripts/build_im_layer.sh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

DEST="lambda_layer_im/python"

# 钉死版本 —— 与 platforms/feishu/requirements.txt 保持一致。
LARK_VERSION="1.6.5"
# slack-sdk（M3）—— 只要 `WebClient`。**不装 slack-bolt**：
#   1. Lambda 路径根本不用它（ingress 的验签是 stdlib HMAC 手写的，见
#      platforms/slack/lambda_ingress.py 文件头「与飞书的四处硬差异 #1」）；
#   2. 装了反而危险 —— bolt 在 import 期就能把 `platforms/slack/app/main.py` 那条
#      `App(token=...)` + `_wait_for_credentials()`（while True: sleep(3600)）拉活，
#      在 Lambda 上是必然超时。少一个包 = 少一条误 import 的路。
# 钉死理由同 lark：层是构建期产物，不钉版本等于每次重建都可能换一个 SDK
# （「依赖必钉版本」）。platforms/slack/requirements.txt 里写的是 `>=3.27`（Fargate
# 时代的宽松约束），层这边取一个具体版本作为唯一事实来源。
SLACK_SDK_VERSION="3.33.5"
# boto3/botocore 与 lambda_layer/ 同版本：IM worker 走 core/devops_agent.py，
# 它靠 botocore 自带的 devops-agent 服务模型做自动发现。旧 botocore 里没有这个模型，
# 客户端构造直接 UnknownServiceError（见 setup.sh 里同一处钉版本的说明）。
BOTO_VERSION="1.43.65"

PLAT_ARGS="--platform manylinux2014_x86_64 --implementation cp --only-binary=:all:"

echo "[im-layer] 清理 $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"

# 中途失败必须把半成品**删干净**。否则留下一个空的（或只装了一半的）$DEST，
# 下一次 `cdk deploy ImStack` 会拿它当成"层已就绪"部署上去 —— Lambda 上
# `import lark_oapi` 崩，飞书侧只看到超时，排查成本极高。
# （im-stack.ts 那边也加了"必须含 lark_oapi/slack_sdk/botocore"的硬校验兜底，
#   两道一起 —— 这里是不留脏状态，那里是不信任脏状态。）
cleanup_on_fail() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "[im-layer] ❌ 构建失败（exit $rc）—— 删除半成品 $DEST，避免被误当成可用层部署" >&2
    rm -rf "$DEST"
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

# 本机 python 的 major.minor 必须与 Lambda 运行时一致 —— 下面要用它预编译字节码，
# 而 .pyc 的 magic number 是**按 minor 版本**绑定的：3.13 编出来的 .pyc 在 3.14 上
# 直接被忽略，CPython 静默退回源码编译。表现就是"层大了一倍、冷启动一秒没快"，
# 而且没有任何报错（正是「不许静默降级」要挡的那种）。所以在这里就拦住，
# 而不是等部署完看 INIT_REPORT。
# 这个 3.14 与 infra/lib/constructs/im-core.ts 的 `lambda.Runtime.PYTHON_3_14`
# 是一处契约，升级运行时要同时改。
RUNTIME_MV="3.14"
PY_MV=$(python -c 'import sys; print("%d.%d" % sys.version_info[:2])')
if [ "$PY_MV" != "$RUNTIME_MV" ]; then
  echo "[im-layer] ❌ .venv 是 python $PY_MV，Lambda 运行时是 python $RUNTIME_MV。" >&2
  echo "           字节码按 minor 版本绑定，版本不一致的 .pyc 会被**静默忽略**（冷启动退回 >10s）。" >&2
  echo "           解法：用 python$RUNTIME_MV 重建虚拟环境 ——" >&2
  echo "             rm -rf .venv && python$RUNTIME_MV -m venv .venv && bash scripts/build_im_layer.sh" >&2
  exit 1
fi

echo "[im-layer] 安装 lark-oapi==$LARK_VERSION"
# shellcheck disable=SC2086
pip install "lark-oapi==$LARK_VERSION" -t "$DEST" --quiet --upgrade $PLAT_ARGS

echo "[im-layer] 安装 slack-sdk==$SLACK_SDK_VERSION"
# ⚠️ 这里**故意不带** $PLAT_ARGS：slack-sdk 是纯 Python（py3-none-any wheel），
# 没有任何 .so。带上 `--only-binary=:all: --platform manylinux2014_x86_64` 时
# pip 对 none-any wheel 的处理在各版本间有过反复，为了不让层构建卡在一个纯 Python
# 包上，这里直接常规安装 —— 平台校验由下面的 *-darwin.so / *.dylib 扫描兜底。
pip install "slack-sdk==$SLACK_SDK_VERSION" -t "$DEST" --quiet --upgrade

echo "[im-layer] 安装 boto3/botocore==$BOTO_VERSION"
# shellcheck disable=SC2086
pip install "boto3==$BOTO_VERSION" "botocore==$BOTO_VERSION" -t "$DEST" --quiet --upgrade $PLAT_ARGS

deactivate

# ─── 预编译字节码（这是冷启动能不能低于 10s 的**唯一**决定性因素）─────────────
#
# 2026-09-03 定位到的现网故障：`notiops-im-worker-feishu` 与 `notiops-im-ingress-feishu`
# 每一次冷启动都是
#     INIT_REPORT Init Duration: 9999.xx ms  Phase: init  Status: timeout
# Lambda 的 INIT 有一条**与函数 timeout 无关的 10 秒硬上限**；超了就把 init 掐掉、在
# 第一次调用里**重跑一遍** init。ingress 侧实测因此出现 `Phase: invoke` 再花 10~11.7s，
# 其中 3 次直接死在 `Status: error  Error Type: Runtime.Unknown` —— 而 ingress 的
# webhook 只有 ~3 秒（飞书 URL challenge / 卡片按钮），所以这不是"慢一点"，是必然失败。
#
# 根因不是 CPU 也不是网络，是**每次冷启动都要把整个层从 .py 重新编译一遍**：
#   · `import lark_oapi` 会加载 **9128** 个子模块（SDK 的 `__init__.py` 里
#     `from .api import *` 把 54 个业务 namespace 全都 eager import；而我们只用 `im`）；
#   · 层挂在 Lambda 上是**只读**的，CPython 写不出 `__pycache__`，于是**每一次**冷启动
#     都从源码编译这 10967 个 .py；
#   · 而这个脚本以前**主动把 `__pycache__` 删掉**，等于把唯一的解药扔了。
#
# 本机 python 3.14.5 实测（同一台机器、同一份 wheel，只差有没有 .pyc）：
#     无 .pyc：   9538 ~ 12747 ms
#     有 .pyc：   2880 ~  5424 ms      ← 3.3 倍
# 代价只有体积：解压后 87MB → 152MB（Lambda 层上限 250MB，下面会硬校验）。
#
# 为什么必须 `--invalidation-mode unchecked-hash`：
#   默认的 timestamp 模式把「源码 mtime + size」写进 .pyc 头，import 时逐个比对。而
#   `scripts/build_im_zips.py::write_zip` 为了让 zip 可复现，把所有 mtime 钉成
#   1980-01-01；CDK 打资产也会重写。mtime 一变，**每个 .pyc 都被判定失效** → 白编译一场，
#   而且是**静默**的（照样能跑，只是慢回 10 秒）。unchecked-hash 让 CPython 完全不校验，
#   正是只读、不可变产物该用的模式。
#
# 为什么不去精简 lark_oapi（曾经想删 api/corehr、hire 之类"用不到的" namespace）：
#   删不掉——三处都硬 import 全量 namespace：`lark_oapi/api/__init__.py`（54 个）、
#   `lark_oapi/client.py`（54 个 service）、以及 `lark_oapi/event/dispatcher_handler.py`
#   （22 个 processor，而 `EventDispatcherHandler` 正是 ingress 验签 + 解密要用的那个类）。
#   实测把前两处改成 lazy `__getattr__` 只从 9128 降到 6012 个模块（仍 >10s），真要压下去
#   得改 `dispatcher_handler.py` —— 那是安全关键路径（见 lambda_ingress.py 文件头
#   「硬约束 A」）。预编译不动 SDK 一行源码就拿到 3.3 倍，性价比不在一个量级。
echo "[im-layer] 预编译字节码（python $PY_MV, unchecked-hash）"
.venv/bin/python -m compileall -q -j 4 --invalidation-mode unchecked-hash "$DEST"

# 编译必须**全覆盖**：漏一个包就等于那个包每次冷启动还在编译，而且没人看得出来。
# 所以这里断言 .pyc 数 == .py 数（不是 ">0"）。
PY_COUNT=$(find "$DEST" -name '*.py' | wc -l | tr -d ' ')
PYC_COUNT=$(find "$DEST" -name '*.pyc' | wc -l | tr -d ' ')
if [ "$PYC_COUNT" -lt "$PY_COUNT" ]; then
  echo "[im-layer] ❌ 预编译不完整：$PY_COUNT 个 .py 只编出 $PYC_COUNT 个 .pyc" >&2
  echo "           少编的那部分会在每次冷启动重新编译（Init > 10s → INIT timeout）。" >&2
  exit 1
fi
echo "[im-layer] ✓ 预编译 $PYC_COUNT/$PY_COUNT"

# 校验：装出来的必须是 Linux 二进制。pydantic/cryptography 之类带 .so 的包如果装成了
# macOS 版本，这里能提前抓住（比在 Lambda 上看 ImportError 便宜得多）。
BAD=$(find "$DEST" -name '*-darwin.so' -o -name '*.dylib' | head -5)
if [ -n "$BAD" ]; then
  echo "[im-layer] ❌ 检测到 macOS 二进制，层不可用于 Lambda:" >&2
  echo "$BAD" >&2
  exit 1
fi

SIZE=$(du -sh "$DEST" | cut -f1)
echo "[im-layer] ✓ 完成 —— $DEST ($SIZE)"
python3 - <<'PY'
import os
dest = "lambda_layer_im/python"
top = sorted(d for d in os.listdir(dest) if not d.endswith(".dist-info"))
print("[im-layer] 顶层包:", ", ".join(top[:12]) + ("…" if len(top) > 12 else ""))
assert "lark_oapi" in top, "lark_oapi missing from layer"
assert "slack_sdk" in top, "slack_sdk missing from layer"
assert "botocore" in top, "botocore missing from layer"
# 明确断言 bolt **不**在层里 —— 见上面 SLACK_SDK_VERSION 处的说明。
assert "slack_bolt" not in top, "slack_bolt must NOT be in the IM layer"

# Lambda 层解压后 250MB 硬上限（所有层 + 代码合计 262144000 字节）。预编译把这一层
# 从 87MB 顶到了 152MB，余量还有 ~40%，但**再往里加包之前必须先看这个数**。
# 在这里拦住，而不是等 `cdk deploy` 走到一半报
# `Unzipped size must be smaller than 262144000 bytes`（那时已经上传完了）。
LIMIT = 250 * 1024 * 1024
WARN = int(LIMIT * 0.85)
total = sum(os.path.getsize(os.path.join(r, f))
            for r, _d, fs in os.walk(dest) for f in fs)
mb = total / 1024 / 1024
if total > LIMIT:
    raise SystemExit(
        f"[im-layer] ❌ 解压后 {mb:.0f}MB 超过 Lambda 层 250MB 上限。\n"
        "           这一层里最大的是 lark_oapi（44MB 源码 + 等量 .pyc）。要瘦身只能\n"
        "           精简 SDK 子包，代价见本文件「为什么不去精简 lark_oapi」那段。")
if total > WARN:
    print(f"[im-layer] ⚠️  解压后 {mb:.0f}MB，已用掉 250MB 上限的 "
          f"{100 * total / LIMIT:.0f}% —— 再加包前先想清楚。")
else:
    print(f"[im-layer] ✓ 解压后 {mb:.0f}MB / 250MB 上限")
PY
