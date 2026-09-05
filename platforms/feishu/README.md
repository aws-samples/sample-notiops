# NotiOps — Feishu (Lark) Adapter

让飞书用户通过 `@NotiOps <自然语言>`、私聊、`/命令`、卡片按钮触发 DevOps Agent 调查与
AWS Support 案例操作，结果回到原对话/原话题。

**Webhook + Lambda 架构**：飞书把事件 POST 到 API Gateway HTTP API → ingress Lambda 秒回
ACK → 异步投给 worker Lambda 干活。平台无关的业务逻辑在
[`../../core/`](../../core/) 与 [`../common/`](../common/) 里共享给其他 IM 适配器；本目录
只放飞书专属代码（基础设施由仓库根 CDK 的 `ImStack` 统一定义，
见 [`infra/lib/constructs/im-core.ts`](../../infra/lib/constructs/im-core.ts)）。

> ℹ️ **2026-09-03（IM 重构 M2）之前**这里跑的是 ECS Fargate 上的 `lark_oapi` 长连接进程
> （`app/main.py`），由 `BotStack` 部署。那条路径**已退役**：`infra/bin/app.ts` 不再实例化
> `BotStack`。`infra/lib/bot-stack.ts`、本目录的 `Dockerfile` 和 `app/main.py`
> **故意留在仓库里**当回滚路径（回滚步骤见
> [`../../docs/IM_WEBHOOK_SETUP.md`](../../docs/IM_WEBHOOK_SETUP.md) §1.6）。

## 架构

```
飞书: @NotiOps 帮我列出 IAD 所有 EC2
         │ (HTTPS POST, 事件订阅 / 回调订阅同一个地址)
         ▼
┌──────────────────────────────────────────────┐
│ API Gateway HTTP API（$default catch-all）   │
│  未鉴权 —— 验签/解密全靠 lark_oapi SDK       │
└──────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────┐
│ notiops-im-ingress-feishu (Lambda)           │
│  lambda_ingress.py                           │
│  1. SDK 解密 + 验签 + URL challenge          │
│  2. 异步投 worker（InvocationType=Event）    │
│  3. 再给用户那条消息加 👀 表情（顺序不可颠倒）│
│  → 秒回 ACK（飞书对回调有 ~3s 硬超时）       │
└──────────────────────────────────────────────┘
         │ (async invoke)
         ▼
┌──────────────────────────────────────────────┐
│ notiops-im-worker-feishu (Lambda, 900s)      │
│  lambda_worker.py                            │
│  1. event_id 幂等去重（ddb_state）           │
│  2. locale 解析（命令类不自动检测）          │
│  3. 规范化成 ImMessage →                     │
│     platforms.common.router.dispatch         │
│     → platforms.feishu.caps.FeishuCaps       │
│  4. card_action：解码成 SDK 对象后交给        │
│     case_flow / support_flow / skill_commands│
└──────────────────────────────────────────────┘
         │
         ▼
   DevOps Agent investigates
         │
         ▼
┌──────────────────────────────────────────────┐
│ report-handler Lambda                        │
│  (shared/report_delivery/)                   │
│  按 DDB 行的 platform 字段路由               │
│  → feishu sender 把报告投回飞书              │
└──────────────────────────────────────────────┘
```

**路由是确定性的、0 token**：`core/nl_router.py` 用正则把消息分到
`help` / `language` / `model` / `investigate` / `case` / `chat` 六条路，只有「案例」那条
会调一次 LLM 抽标题/正文。详见 [`../common/router.py`](../common/router.py) 文件头。

## 飞书开放平台一次性配置

在 https://open.feishu.cn → 你的企业自建应用。**权威、带顺序和排错的版本在
[`../../docs/IM_WEBHOOK_SETUP.md`](../../docs/IM_WEBHOOK_SETUP.md) §1**（请求地址必须等
`ImStack` 部署完、两把钥匙写进 Secret 之后再填），下面只是速查。

### 1. 启用机器人
**应用功能 → 机器人 → 启用**。设置机器人名（用户 @ 时显示的）。

### 2. 拿凭证
**凭证与基础信息 → App ID / App Secret** 复制下来。

### 3. 拿两把钥匙（webhook 模式必需）
**事件与回调 → 加密策略** → **Encrypt Key**（自己填随机串，`openssl rand -hex 24`）+
**Verification Token**（这一页直接给）。webhook 模式下这两个是**唯一**的请求鉴权手段，
ingress 冷启动时硬校验，任一为空直接崩（故意的）。

### 4. 订阅事件 + 回调
- **事件与回调 → 事件配置** → 订阅方式选「**将事件发送至开发者服务器**」，事件加
  `im.message.receive_v1`。
- **事件与回调 → 回调配置** → 同样选「将回调发送至开发者服务器」，回调加
  `card.action.trigger`（卡片按钮全靠它）。
- 两处填**同一个**地址（`ImStack` 输出的 `FeishuWebhookUrl`）。

### 5. 申请权限
**权限管理 → 批量导入/导出权限** → 导入
[`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md) §3.1 第 4 步那段 JSON（11 条必需 +
1 条可选）。可选那条是 `im:message.reaction:write`，只影响提问后那个 👀 表情，
不影响答案。

### 6. 发布版本
**版本管理与发布** → 创建新版本 → 申请发布 → 管理员审批。
（自建应用如果你是 admin 可以自动通过。**权限是随版本下发的** —— 补了权限一定要重发版本。）

### 7. 把机器人拉进群
群里 → `+` → 添加机器人。

## 部署

> ℹ️ 本目录**不单独部署**。飞书适配器是融合系统的一部分，由仓库根的 CDK 一并部署 ——
> 入口是 [`../../setup.sh`](../../setup.sh)（交互式 CDK 部署）。
> 完整流程、前置条件与排查见
> [`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md)（权威文档），下面只讲飞书相关的关键点。

### 由哪个栈部署

`./setup.sh` 走 `cdk deploy --all`；飞书 bot 在 **`ImStack`** 里
（[`infra/lib/im-stack.ts`](../../infra/lib/im-stack.ts) +
[`infra/lib/constructs/im-core.ts`](../../infra/lib/constructs/im-core.ts)）：

- `ImStack` 定义 API Gateway HTTP API + ingress / worker / progress Lambda。代码用
  `lambda.Code.fromAsset("../")` 打包，第三方依赖走
  [`scripts/build_im_layer.sh`](../../scripts/build_im_layer.sh) 生成的 Lambda Layer
  （`pip --platform manylinux2014_x86_64 --only-binary=:all:`）—— **不需要 finch / docker**。
- 是否创建飞书那套函数由 `enabledPlatforms` 开关决定：`setup.sh` 选了飞书 → 建；
  没选 → 完全不建（`enabledPlatforms=none` 时整个 `ImStack` 都不实例化）。

### 飞书凭据怎么填(关键)

`setup.sh` **不采集任何 IM 凭据**。CDK（`NotiOpsBackendStack`，不是 `ImStack`）只创建一个
**空的** Secret `notiops/im-bot-feishu`；
部署完成后再填 App ID / App Secret / Encrypt Key / Verification Token（以及可选的推送目标群
`notify_chat_ids`），两种方式：

1. **(推荐)** 登录 Web Chat(admin)→「通知设置」填入飞书凭据。
2. 直接更新 Secret：
   ```bash
   # Secret 结构见 docs/DEPLOYMENT.md §4。
   aws secretsmanager put-secret-value --secret-id notiops/im-bot-feishu \
     --secret-string '{"app_id":"cli_...","app_secret":"...","encrypt_key":"...","verification_token":"..."}' \
     --region <REGION>
   ```
   Lambda 是**冷启动时**读 Secret 的：改完等旧执行环境自然回收即可，急的话改一下 ingress
   的环境变量（任意无害的值）强制换一批执行环境 —— 做法和注意点见
   `docs/DEPLOYMENT.md` §8.2。

CDK 栈始终通过 ARN 引用该 Secret，**本地不落任何凭据文件**。DevOps Agent 的 webhook /
HMAC secret、共享 DDB 表、S3 报告 bucket 都由 `NotiOpsBackendStack` 拥有并自动创建，
`ImStack` 无需手动传 DDB 名 / ARN。

### 报告回贴的凭据

报告回路(`shared/report_delivery/` 里的 report-handler Lambda + feishu sender)用**同一个**
`notiops/im-bot-feishu` Secret 里的 App 凭据(tenant token)把报告卡片投回飞书 —— 上面填一次即可,
**没有单独的 report-handler 凭据步骤**。

## 测试

把 bot 拉进飞书群，群里发：

```
@NotiOps 帮我列出 IAD 所有 EC2 信息
```

预期：
1. 你那条消息上**立刻**出现 👀 表情（没配 `im:message.reaction:write` 就没有这一步，
   不影响后面）
2. 几秒后出现「正在思考」卡片，并随调查进度自我刷新
3. 完成后卡片收尾成答案；超过卡片上限的长答案会落成一份 HTML 报告，卡片里给链接
   （`platforms/common/long_answer.py`，**不截断**）
4. 案例类消息（「创建案例 …」）会弹案例表单卡片，填完提交才真正建 case

## 排查

```bash
# ingress（收不到 / 验证失败 / 500 都先看这个）
aws logs tail /aws/lambda/notiops-im-ingress-feishu --region <REGION> --follow

# worker（收到了但没回答 / 回答不对看这个）
aws logs tail /aws/lambda/notiops-im-worker-feishu --region <REGION> --follow

# 卡片停在「正在思考」不动 —— 看进度轮询
aws logs tail /aws/lambda/notiops-im-progress --region <REGION> --follow

# 改了飞书适配器代码后重新部署(在仓库根执行):
cd ../../infra && npx cdk deploy ImStack
```

常见症状 → 原因对照表在
[`../../docs/IM_WEBHOOK_SETUP.md`](../../docs/IM_WEBHOOK_SETUP.md) §1.5（含
「`INIT_REPORT ... Status: timeout` 是正常的」这条容易误判的）。

## 文件结构

平台特定(本目录):

> API Gateway / Lambda / IAM 等基础设施**不在本目录**,由仓库根 CDK 的 `ImStack`
> (`infra/lib/constructs/im-core.ts`)统一定义。本目录只有飞书专属的应用代码。

| 文件 | 作用 |
|---|---|
| [lambda_ingress.py](lambda_ingress.py) | webhook 入口：解密验签 + URL challenge + 异步投 worker + 👀 表情 |
| [lambda_worker.py](lambda_worker.py) | 干活儿的：幂等去重 + locale + 规范化 → `common.router` |
| [webhook_adapter.py](webhook_adapter.py) | 响应形状收口（不外泄异常文本） |
| [caps.py](caps.py) | `FeishuCaps` —— 七个能力在飞书上的实现 |
| [im_cards.py](im_cards.py) | 飞书卡片（进度卡、答案卡、案例表单） |
| [app/feishu_utils.py](app/feishu_utils.py) | tenant_access_token 缓存、消息/卡片/表情发送 |
| [app/case_flow.py](app/case_flow.py) | 案例 CRUD 的卡片回调处理 |
| [app/support_flow.py](app/support_flow.py) | "升级到 AWS Support" 飞书 UI 层 |
| [app/main.py](app/main.py) | 原 Fargate 长连接主进程（`BotStack` 已于 M2 退役、不再实例化）；文件本身仍在服务：`lambda_worker.py` 惰性 import 它的 `on_card_action` 处理卡片按钮回调 |
| [Dockerfile](Dockerfile) | ⚠️ **已退役**：`BotStack` 用它构建镜像，留作回滚路径 |
| [requirements.txt](requirements.txt) | `lark-oapi` + `boto3`（Lambda Layer 与镜像共用） |

> 老 `query` 命令（读 DDB 里的巡检 / 报告结果渲染成卡片）已随老 idle-detector 系统一起
> 退役：`app/query_handler.py` 已删除（有回归测试盯着，不许它复活）。现在的意图路由
> (`core/nl_router.py` → `platforms/common/router.py`)里**没有** `query` 这条能力 ——
> 写「深挖 / 深度调查 / 根因分析」走 `investigate`；「看下巡检报告」这类问法既不是命令、
> 也不命中深挖措辞，落到兜底的 `chat`（DevOps Agent 直连问答，同样 0 token），
> 不再有**用户主动拉取**巡检报告的卡片路径 —— 新巡检的报告在 Web Chat 的巡检看板里看。
>
> ⚠️ 这只关掉了 pull，**push 仍在线**：每日推送照旧把 DDB 里的巡检结果渲染成飞书交互
> 卡片（`lambda4_notifier/handler.py:99` 读 `notiops-inspection` 表 → `:471`
> `_format_inspection_section` → `:391` `shared/feishu_sender.FeishuSender`，
> `msg_type: interactive`），另一条同构路径是 `inspection/adapters/broadcast.py` →
> `shared/report_delivery/feishu_sender.send_markdown` → `_send_summary_cards`。
> 所以飞书里仍然看得到巡检报告卡片,只是不能再用一句话把它问出来。

平台无关 (`../common/` 与 `../../core/` 共享):

| 文件 | 作用 |
|---|---|
| [../common/router.py](../common/router.py) | 确定性分发（0 token）+ prompt-injection 二道门 |
| [../common/quick_ack.py](../common/quick_ack.py) | 提问后的 👀 表情（三平台共用，永不抛） |
| [../common/live_card.py](../common/live_card.py) | 自刷新进度卡 |
| [../common/lambda_progress.py](../common/lambda_progress.py) | 进度轮询 Lambda（扫 `imtask#` 行） |
| [../../core/nl_router.py](../../core/nl_router.py) | 双语正则意图路由（六条路） |
| [../../core/bedrock_intent.py](../../core/bedrock_intent.py) | Bedrock 意图总结（只剩案例路径用） |
| [../../core/case_classifier.py](../../core/case_classifier.py) | AWS Support service/category 分类器 |
| [../../core/webhook_dispatch.py](../../core/webhook_dispatch.py) | HMAC 派发 webhook 到 DevOps Agent |
| [../../core/ddb_state.py](../../core/ddb_state.py) | DynamoDB 共享状态表(跨平台，带 `platform` 字段) |
| [../../core/support_logic.py](../../core/support_logic.py) | Support Case 创建业务逻辑(分类 + CreateCase + 幂等锁) |
