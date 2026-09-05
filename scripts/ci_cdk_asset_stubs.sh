#!/bin/sh
# CI 上跑 `cdk synth` 之前造出三个**资产占位目录**。
#
# 为什么需要这个脚本：这三个目录都在 `.gitignore` 里、仓库里 0 个跟踪文件，
# 所以在**干净 clone**（也就是每一个 CI runner）上必然不存在；而 synth 期对它们
# 全是 **fail-fast 的硬检查**（有意为之：缺层部上去的表现是 Lambda 冷启动
# `ImportError` / INIT timeout，排查成本远高于 synth 期就停）。结果就是：
# 任何在干净 clone 上跑 `cdk synth` 的 job，不加占位一律红。
#
#   · `lambda_layer/`        —— notiops-backend-stack.ts 的 `Code.fromAsset`
#   · `lambda_layer_im/python/{lark_oapi,slack_sdk,botocore}` + `lark_oapi/__pycache__`
#                            —— im-stack.ts 里两处显式 existsSync 检查
#   · `frontend/chat-app/dist/index.html`
#                            —— 缺了 web-chat-core.ts 会改用 `Source.data` 占位页，
#                               模板结构随之不同（infra-tests 的 golden 也依赖它）
#
# ⚠️ 占位内容**故意是空的**：这些 job 只看模板结构（跨栈 export/import 集合、
#    IAM、队列参数），而资产哈希在所有判据里都被归一化。真正的层由
#    `scripts/build_im_layer.sh` 用 manylinux2014_x86_64 wheel 构建 —— 绝不能拿
#    这里的空壳去部署，所以本脚本**只在 CI 里调用**，setup.sh 不碰它。
#
# 🔴 **只创建缺失的东西，绝不覆盖已有内容。** 开发机上这三个目录里装的是真货
#    （真的层、真的前端构建产物）；无条件 `printf > dist/index.html` 会把本地
#    构建好的前端首页悄悄换成一行占位 —— 下一次 `cdk deploy` 就把占位页发上去了。
#    所以每一步都先判存在。
#
# POSIX sh（不是 bash）：CI 用的 node:*-alpine 镜像里没有 bash。
set -eu

cd "$(dirname "$0")/.."

mkdir -p lambda_layer
[ -e lambda_layer/.ci-stub ] || : > lambda_layer/.ci-stub

mkdir -p lambda_layer_im/python/lark_oapi/__pycache__ \
         lambda_layer_im/python/slack_sdk \
         lambda_layer_im/python/botocore

mkdir -p frontend/chat-app/dist
[ -e frontend/chat-app/dist/index.html ] \
  || printf '<!doctype html><title>ci-stub</title>\n' > frontend/chat-app/dist/index.html

echo "[ci-stubs] lambda_layer / lambda_layer_im / frontend dist 占位就绪"
