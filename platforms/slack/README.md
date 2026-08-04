# NotiOps — Slack Adapter

让 Slack 用户通过 `@NotiOps <自然语言>` 触发 DevOps Agent 调查、管理 AWS Support 案例,结果回到原 channel/thread。

**Socket Mode 长连接**:Slack 进程跑在 ECS Fargate,主动 WebSocket 连 `slack.com`,**不开放任何公网 endpoint**。

平台无关业务逻辑在 [`../../core/`](../../core/) 与飞书 / 钉钉等其他平台共享。本目录只放 Slack 专属代码(基础设施由仓库根 CDK 的 `BotStack` 统一定义)。

## 与飞书的功能对等

✅ `@bot 自然语言` 触发调查,确认派发,报告回 thread,带 next-step 按钮
✅ 多轮上下文("再查一下它的安全组")
✅ 创建 / 列出 / 查看 / 回复 / 关闭案例
✅ 升级到 AWS Support(报告 → 🆘 → Modal)
✅ 创建案例时同时启动 Agent 调查
✅ 调查报告 → "📎 同步到 Case" 按钮
✅ 主动观察(CloudWatch Alarm / Health / Backup / GuardDuty / Cost / Trusted Advisor)推送

## 架构

```
Slack channel: @NotiOps 帮我列出 IAD 所有 EC2
         │ (Socket Mode WebSocket, outbound only)
         ▼
┌──────────────────────────────────────────┐
│ ECS Fargate Task (1 replica)             │
│  app/main.py — slack_bolt SocketMode     │
│  - app_mention → bedrock 分类 → 派发卡片 │
│  - block_actions → 确认/取消/case 等     │
│  - view_submission → 表单提交            │
│  共用 core.{webhook_dispatch, ddb_state, │
│           bedrock_intent, support_logic, │
│           case_management, chat_history} │
└──────────────────────────────────────────┘
         │
         ▼
   DevOps Agent investigates
         │
         ▼
┌──────────────────────────────────────────┐
│ report-handler Lambda                    │
│  (shared/report_delivery/)               │
│  按 DDB 行的 platform 字段路由           │
│  → slack sender(slack_sender.py)        │
│    把报告投回 Slack channel              │
└──────────────────────────────────────────┘
```

## Slack App 一次性配置

在 https://api.slack.com/apps → **Create New App** → **From scratch**:

### 1. Socket Mode

`Settings → Socket Mode → Enable`,生成 **App-Level Token**(scope: `connections:write`),记下 `xapp-...`。

### 2. Bot Token Scopes

`OAuth & Permissions → Scopes → Bot Token Scopes`,添加:

| Scope | 用途 |
|---|---|
| `app_mentions:read` | 接收 @bot 消息 |
| `chat:write` | 发消息到 channel |
| `chat:write.public` | 给未邀请的 channel 发消息(可选) |
| `commands` | 注册 slash 命令 |
| `im:history` `im:read` `im:write` | 私信(DM)模式 |
| `users:read` | 读 sender 显示名 |

### 3. Event Subscriptions

`Event Subscriptions → Subscribe to bot events`,订阅:

- `app_mention`
- `message.im`(可选,启用 DM 私聊)

### 4. Interactivity & Shortcuts

启用 `Interactivity`(让 Block Kit 按钮 / Modal 走 Socket Mode)。
**不需要填 Request URL** —— Socket Mode 自动接管。

### 5. Slash Commands(可选)

`Slash Commands → Create New Command`:

- Command: `/devops`
- Short description: `Talk to NotiOps`
- Usage hint: `<自然语言指令>`

### 6. Install to Workspace

`Install App → Install to Workspace` → 同意权限。安装后:
- **Bot Token** `xoxb-...` 在 `OAuth & Permissions` 页面
- **App-Level Token** `xapp-...` 在 `Basic Information → App-Level Tokens`

### 7. 把 bot 邀请进目标 channel

```
/invite @notiops-devops
```

## 部署

> ℹ️ 本目录**不再单独部署**。Slack 适配器是融合系统的一部分,由仓库根的 CDK
> 一并部署 —— 入口是 [`../../setup.sh`](../../setup.sh)(交互式 CDK 部署)。
> 原先的 SAM / CloudFormation 单栈流程(`template.yaml` + `samconfig.toml`)已下线。
> 完整流程、前置条件与排查见 [`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md)(权威文档),下面只讲 Slack 相关的关键点。

### 由哪个栈部署

`./setup.sh` 走 `cdk deploy --all`,一次部署三个栈;Slack bot 在 **`BotStack`** 里:

- `BotStack` 定义了飞书 / Slack 的 Fargate Service(`infra/lib/bot-stack.ts`)。镜像由 CDK
  用 `platforms/slack/Dockerfile` 直接构建(**build context = 仓库根**,因为镜像里需要
  `core/` + `shared/` 共享模块),推到 CDK 自建的 ECR,你**无需手动 `finch build` / `ecr push`**。
- 是否拉起 Slack task 由 `enabledPlatforms` 开关决定:`setup.sh` 选了 Slack → `desiredCount=1`;
  没选 → task 存在但 `desiredCount=0`,不起容器、不计费。

### Slack tokens 怎么填(关键)

`setup.sh` **不采集任何 IM 凭据**。CDK 只创建两个**空的** Secret
`notiops/slack-bot-token`(`xoxb-...`)和 `notiops/slack-app-token`(`xapp-...`,
`connections:write`);部署完成后再填,两种方式:

1. **(推荐)** 登录 Web Chat(admin)→「通知设置」填入 Slack tokens。
2. 直接更新两个 Secret 再强制重启 Slack ECS 服务加载新凭据:
   ```bash
   aws ecs update-service \
     --cluster <BotStack 的 ECS cluster> \
     --service <Slack service 名> \
     --force-new-deployment
   ```

CDK 栈始终通过 ARN 引用这两个 Secret,**本地不落任何凭据文件**。DevOps Agent 的
webhook / HMAC secret、共享 DDB 表、S3 报告 bucket 都由 `NotiOpsBackendStack`
拥有并自动创建,Slack 栈无需手动传 DDB 名 / ARN。

### 报告回贴的凭据

报告回路(`shared/report_delivery/` 里的 report-handler Lambda + slack sender)用**同一个**
`notiops/slack-bot-token` 发 `chat.postMessage` 把报告投回 channel —— 上面填一次即可,
**没有单独的 report-handler 凭据步骤**。

## 测试

把 bot 邀请进 channel,channel 里发:

```
@NotiOps 帮我列出 IAD 所有 EC2 信息
```

预期:
1. bot 立即 thread 回 "🤔 正在理解你的指令…"
2. 紧接着发出意图确认 message,带 *✅ 确认派发* / *❌ 取消* 按钮
3. 点确认 → 卡片更新成 "✅ 已派发 (by @你)"
4. 几分钟后 DevOps Agent 完成 → Summary + 完整报告 / Trace 链接 + next-step 按钮 + "🆘 升级到 AWS Support" 按钮回到原 thread

**测试案例流程:**

```
@NotiOps 创建案例 关于 RDS 慢查询
```
- 应答带 "🆘 打开创建表单" 按钮(Slack @mention 不能直接弹 modal,需要用户再点一下)
- 点按钮 → modal 弹出 → 填表单 → 选择 "🤖 创建 + 启动 Agent 调查" → 提交
- 几分钟后报告回 thread,带 "📎 同步到 Case `<id>`" 按钮

```
@NotiOps 我的 case
```
- 列表 Block Kit message,5 行案例,每行 4 按钮,底部带快速过滤 + "🔍 在控制台查看全部案例"

## 排查

> ECS cluster / service / log-group 名由 CDK(`BotStack`)生成,先用下面的命令查到实际名字,
> 或直接在 ECS 控制台看 Slack service。

```bash
# 查 Slack service 的实际名字(BotStack 的 cluster / service)
aws ecs list-clusters
aws ecs list-services --cluster <BotStack 的 cluster>

# 实时日志(streamPrefix=slack-bot;日志组名以 ECS 控制台显示为准)
aws logs tail <Slack task 的 log group> --follow

# 只想重启 task(不改镜像 / 不改配置):
aws ecs update-service \
  --cluster <BotStack 的 cluster> \
  --service <Slack service 名> \
  --force-new-deployment

# 改了 Slack 适配器代码后重新部署(镜像由 CDK 构建,在仓库根执行):
cd ../.. && cdk deploy BotStack
```

## 与飞书的隔离关系

CDK 把飞书 / Slack / 钉钉都收进**同一个 `BotStack`、同一个 ECS Cluster**(`infra/lib/bot-stack.ts`),
但每个平台是**独立的 Task Definition + Fargate Service + Task Role**,互不影响:

| 维度 | Slack | 飞书 |
|---|---|---|
| Fargate Service / TaskDef | `SlackBotService` / `SlackBotTask` | `FeishuBotService` / `FeishuBotTask` |
| Task Role(IAM) | 独立 | 独立 |
| 日志 stream 前缀 | `slack-bot` | `feishu-bot` |
| 起停开关 | `enabledPlatforms` 含 `slack` → `desiredCount=1` | 含 `feishu` → `desiredCount=1` |
| **共用** | 同一个 `BotStack` + `BotCluster` + VPC;同一个共享 DDB 表(行带 `platform` 字段隔离)+ 同一个 webhook secret + 同一个 report-handler |

某个平台没勾选(`desiredCount=0`)或 task 崩溃,**不影响**另一个平台的 Service。

## 文件结构

平台特定(本目录):

> ECS / ECR / IAM / VPC 等基础设施**不在本目录**,由仓库根 CDK 的 `BotStack`
> (`infra/lib/bot-stack.ts`)统一定义。本目录只有 Slack 专属的容器与应用代码。

| 文件 | 作用 |
|---|---|
| [Dockerfile](Dockerfile) | python:3.12-slim,**build context 必须是仓库根**(CDK 用它构建镜像) |
| [requirements.txt](requirements.txt) | `slack-bolt` + `slack-sdk` + `boto3` |
| [app/main.py](app/main.py) | 主进程: slack-bolt Socket Mode handler + 路由 |
| [app/blocks.py](app/blocks.py) | 通用 Block Kit 组件(section / button / modal / input 等) |
| [app/support_flow.py](app/support_flow.py) | "升级到 Support" Modal + 提交处理 |
| [app/case_flow.py](app/case_flow.py) | 案例 CRUD UI(列表 / 详情 / 创建 / 回复 / 关闭) |

平台无关 (`../../core/` 共享):

| 文件 | 作用 |
|---|---|
| [../../core/bedrock_intent.py](../../core/bedrock_intent.py) | Bedrock 意图分类 + 多轮上下文 |
| [../../core/case_classifier.py](../../core/case_classifier.py) | AWS Support service/category 分类器 |
| [../../core/case_management.py](../../core/case_management.py) | Support API 5 个操作 |
| [../../core/chat_history.py](../../core/chat_history.py) | 滚动会话上下文 |
| [../../core/ddb_state.py](../../core/ddb_state.py) | DynamoDB 共享状态表 |
| [../../core/next_steps.py](../../core/next_steps.py) | 报告后 next-step 按钮 |
| [../../core/push_event.py](../../core/push_event.py) | EventBridge 推送事件归一化 |
| [../../core/support_logic.py](../../core/support_logic.py) | Support case 创建逻辑 |
| [../../core/webhook_dispatch.py](../../core/webhook_dispatch.py) | HMAC 派发到 DevOps Agent |
