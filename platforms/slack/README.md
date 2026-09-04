# NotiOps — Slack Adapter

让 Slack 用户通过 `@NotiOps <自然语言>`、DM、`/devops` 斜杠命令、Block Kit 按钮触发
DevOps Agent 调查、管理 AWS Support 案例,结果回到原 channel/thread。

**Webhook + Lambda 架构**:Slack 把事件 POST 到 API Gateway HTTP API → ingress Lambda 秒回
ACK(Slack 的 3s 硬超时)→ 异步投给 worker Lambda 干活。

平台无关业务逻辑在 [`../../core/`](../../core/) 与 [`../common/`](../common/) 里与飞书 /
钉钉共享。本目录只放 Slack 专属代码(基础设施由仓库根 CDK 的 `ImStack` 统一定义,
见 [`infra/lib/constructs/im-core.ts`](../../infra/lib/constructs/im-core.ts))。

> ℹ️ **2026-09-03(IM 重构 M2)之前**这里跑的是 ECS Fargate 上的 `slack_bolt` Socket Mode
> 长连接进程(`app/main.py`),由 `BotStack` 部署。那条路径**已退役**:`infra/bin/app.ts`
> 不再实例化 `BotStack`。`infra/lib/bot-stack.ts`、本目录的 `Dockerfile` 和 `app/main.py`
> **故意留在仓库里**当回滚路径(回滚步骤见
> [`../../docs/IM_WEBHOOK_SETUP.md`](../../docs/IM_WEBHOOK_SETUP.md) §1.6)。
> 切到 webhook 之后**不再需要** App-Level Token(`xapp-...`)。

## 与飞书的功能对等

✅ `@bot 自然语言` / DM / `/devops` 触发,答案回 thread
✅ 确定性双语路由(0 token):`help` / `language` / `model` / `investigate` / `case` / `chat`
✅ 多轮上下文("再查一下它的安全组")
✅ 创建 / 列出 / 查看 / 回复 / 关闭案例(案例表单带案例类型 + 服务名称)
✅ 升级到 AWS Support(报告 → 🆘 → Modal)
✅ 创建案例时同时启动 Agent 调查(与飞书同一条 `core.devops_agent` 路径)
✅ 调查报告 → "📎 同步到 Case" 按钮
✅ 主动观察(CloudWatch Alarm / Health / Backup / GuardDuty / Cost / Trusted Advisor)推送

## 架构

```
Slack channel: @NotiOps 帮我列出 IAD 所有 EC2
         │ (HTTPS POST — Events API / Interactivity / Slash 都发同一个地址)
         ▼
┌──────────────────────────────────────────────┐
│ API Gateway HTTP API($default catch-all)     │
│  未鉴权 —— 靠 Slack 签名(v0 HMAC)校验        │
└──────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────┐
│ notiops-im-ingress-slack (Lambda)            │
│  lambda_ingress.py                           │
│  1. 验签 + url_verification challenge        │
│  2. 异步投 worker(InvocationType=Event)      │
│  3. 再给用户那条消息加 👀 表情(顺序不可颠倒) │
│  → 秒回 ACK(Slack 3s 硬超时)                 │
└──────────────────────────────────────────────┘
         │ (async invoke)
         ▼
┌──────────────────────────────────────────────┐
│ notiops-im-worker-slack (Lambda, 900s)       │
│  lambda_worker.py                            │
│  1. event_id 幂等去重(ddb_state)             │
│  2. locale 解析                              │
│  3. 规范化成 ImMessage →                     │
│     platforms.common.router.dispatch         │
│     → platforms.slack.caps.SlackCaps         │
│  4. block_actions / view_submission:交给     │
│     case_flow / support_flow                 │
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
│  → slack sender(slack_sender.py)             │
│    把报告投回 Slack channel                  │
└──────────────────────────────────────────────┘
```

## Slack App 一次性配置

在 https://api.slack.com/apps → **Create New App** → **From scratch**。**权威、带顺序和
排错的版本在 [`../../docs/IM_WEBHOOK_SETUP.md`](../../docs/IM_WEBHOOK_SETUP.md) §2**
(Request URL 必须等 `ImStack` 部署完之后再填),下面只是速查。

### 1. ⚠️ 不要开 Socket Mode

Socket Mode 与 webhook **互斥** —— 开了 Slack 就不再往 Request URL 发请求。也不需要
App-Level Token(`xapp-...`),那是长连接时代的东西。

### 2. Bot Token Scopes

`OAuth & Permissions → Scopes → Bot Token Scopes`,添加:

| Scope | 用途 |
|---|---|
| `app_mentions:read` | 接收 @bot 消息 |
| `chat:write` | 发消息 / 更新卡片 |
| `chat:write.public` | 给未邀请的 channel 发消息(可选) |
| `commands` | 注册 slash 命令 |
| `channels:history` `groups:history` | 读频道会话(thread 续聊) |
| `im:history` `im:read` `im:write` | 私信(DM)模式 |
| `users:read` | 读 sender 显示名 |
| `reactions:write` | 提问后先加 👀 表情(**可选**,缺了只是没表情,答案不受影响) |

### 3. Event Subscriptions

`Event Subscriptions` → **Enable Events**,Request URL 填 `ImStack` 输出的
`SlackWebhookUrl`(Slack 保存时会立刻发一次 challenge,所以必须先部署)。
`Subscribe to bot events` 订阅:

- `app_mention`
- `message.im`(可选,启用 DM 私聊)

### 4. Interactivity & Shortcuts

启用 `Interactivity`,Request URL 填**同一个地址**(按钮 / Modal 全靠它)。

### 5. Slash Commands(可选)

`Slash Commands → Create New Command`,Request URL 同样是那个地址:

- Command: `/devops`
- Short description: `Talk to NotiOps`
- Usage hint: `<自然语言指令>`

> ⚠️ Slack 的命令名只允许字母 / 数字 / 连字符 / 下划线,**中文斜杠命令注册不了**
> (飞书那边 `/调查` 可以)。中文用户直接 @bot 说中文即可 —— 路由是双语的。

### 6. Install to Workspace

`Install App → Install to Workspace` → 同意权限。安装后 **Bot Token** `xoxb-...` 在
`OAuth & Permissions` 页面。

### 7. 把 bot 邀请进目标 channel

```
/invite @notiops-devops
```

## 部署

> ℹ️ 本目录**不单独部署**。Slack 适配器是融合系统的一部分,由仓库根的 CDK 一并部署 ——
> 入口是 [`../../setup.sh`](../../setup.sh)(交互式 CDK 部署)。
> 完整流程、前置条件与排查见
> [`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md)(权威文档),下面只讲 Slack 相关的关键点。

### 由哪个栈部署

`./setup.sh` 走 `cdk deploy --all`;Slack bot 在 **`ImStack`** 里
([`infra/lib/im-stack.ts`](../../infra/lib/im-stack.ts) +
[`infra/lib/constructs/im-core.ts`](../../infra/lib/constructs/im-core.ts)):

- `ImStack` 定义 API Gateway HTTP API + ingress / worker / progress Lambda。代码用
  `lambda.Code.fromAsset("../")` 打包,第三方依赖走
  [`scripts/build_im_layer.sh`](../../scripts/build_im_layer.sh) 生成的 Lambda Layer
  (`pip --platform manylinux2014_x86_64 --only-binary=:all:`)—— **不需要 finch / docker**。
- 是否创建 Slack 那套函数由 `enabledPlatforms` 开关决定:`setup.sh` 选了 Slack → 建;
  没选 → 完全不建(`enabledPlatforms=none` 时整个 `ImStack` 都不实例化)。

### Slack tokens 怎么填(关键)

`setup.sh` **不采集任何 IM 凭据**。CDK(`NotiOpsBackendStack`,不是 `ImStack`)只创建**空的**
Secret `notiops/slack-bot-token`(`xoxb-...`)和 `notiops/slack-signing-secret`(验签用);
部署完成后再填,两种方式:

1. **(推荐)** 登录 Web Chat(admin)→「通知设置」填入 Slack 凭据。
2. 直接更新 Secret:
   ```bash
   aws secretsmanager put-secret-value --secret-id notiops/slack-bot-token \
     --secret-string '<从 OAuth & Permissions 页复制的 bot token>' --region <REGION>
   ```
   Lambda 是**冷启动时**读 Secret 的:改完等旧执行环境自然回收即可,急的话改一下 ingress
   的环境变量(任意无害的值)强制换一批执行环境 —— 做法和注意点见
   `docs/DEPLOYMENT.md` §8.2。

> `notiops/slack-app-token`(`xapp-...`)是 Socket Mode 时代的东西,webhook 路径**不读它**。

CDK 栈始终通过 ARN 引用这些 Secret,**本地不落任何凭据文件**。DevOps Agent 的
webhook / HMAC secret、共享 DDB 表、S3 报告 bucket 都由 `NotiOpsBackendStack`
拥有并自动创建,`ImStack` 无需手动传 DDB 名 / ARN。

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
1. 你那条消息上**立刻**出现 👀 表情(没配 `reactions:write` 就没有这一步,不影响后面)
2. 几秒后 thread 里出现「正在思考」消息,并随调查进度自我刷新
3. 完成后收尾成答案 + next-step 按钮 + "🆘 升级到 AWS Support";超过 Block Kit 上限的
   长答案会落成一份 HTML 报告给链接(`platforms/common/long_answer.py`,**不截断**)

**测试案例流程:**

```
@NotiOps 创建案例 关于 RDS 慢查询
```
- 应答带 "🆘 打开创建表单" 按钮(Slack @mention 不能直接弹 modal,需要用户再点一下)
- 点按钮 → modal 弹出 → 填表单(含**案例类型** + **服务名称**)→ 选择
  "🤖 创建 + 启动 Agent 调查" → 提交
- 几分钟后报告回 thread,带 "📎 同步到 Case `<id>`" 按钮

```
@NotiOps 我的 case
```
- 列表 Block Kit message,5 行案例,每行 4 按钮,底部带快速过滤 + "🔍 在控制台查看全部案例"

## 排查

```bash
# ingress(收不到 / Request URL 验证失败 / 500 都先看这个)
aws logs tail /aws/lambda/notiops-im-ingress-slack --region <REGION> --follow

# worker(收到了但没回答 / 回答不对看这个)
aws logs tail /aws/lambda/notiops-im-worker-slack --region <REGION> --follow

# 消息停在「正在思考」不动 —— 看进度轮询
aws logs tail /aws/lambda/notiops-im-progress --region <REGION> --follow

# 改了 Slack 适配器代码后重新部署(在仓库根执行):
cd ../../infra && npx cdk deploy ImStack
```

| 症状 | 常见原因 |
|---|---|
| Request URL 保存时报验证失败 | signing secret 没写进 Secret / 地址取错了栈 |
| 群里 @ 没反应 | 缺 `app_mentions:read`,或 bot 没被 `/invite` 进 channel |
| `/devops` 报 `dispatch_failed` | 缺 `commands` scope,或 Slash Commands 的 Request URL 没填 |
| 一句都发不出 | 缺 `chat:write` / bot token 没写进 Secret |
| 没有 👀 表情 | 缺 `reactions:write`(**只影响表情**);日志里是 `reactions.add error=missing_scope` |
| Slack 完全不发请求 | Socket Mode 还开着 —— 关掉 |

## 与飞书的隔离关系

`ImStack` 把飞书 / Slack 收进**同一个栈**(`infra/lib/constructs/im-core.ts`),
但每个平台是**独立的 ingress / worker Lambda + 独立 IAM Role + 独立 HTTP API**,互不影响:

| 维度 | Slack | 飞书 |
|---|---|---|
| ingress / worker | `notiops-im-ingress-slack` / `notiops-im-worker-slack` | `notiops-im-ingress-feishu` / `notiops-im-worker-feishu` |
| API Gateway HTTP API | 独立 | 独立 |
| 执行角色(IAM) | 独立 | 独立 |
| 起停开关 | `enabledPlatforms` 含 `slack` → 建 | 含 `feishu` → 建 |
| **共用** | 同一个 `ImStack` + 同一个 Lambda Layer + 同一个进度轮询 Lambda;同一个共享 DDB 表(行带 `platform` 字段隔离)+ 同一个 webhook secret + 同一个 report-handler |

某个平台没勾选(不创建)或函数报错,**不影响**另一个平台。

## 文件结构

平台特定(本目录):

> API Gateway / Lambda / IAM 等基础设施**不在本目录**,由仓库根 CDK 的 `ImStack`
> (`infra/lib/constructs/im-core.ts`)统一定义。本目录只有 Slack 专属的应用代码。

| 文件 | 作用 |
|---|---|
| [lambda_ingress.py](lambda_ingress.py) | webhook 入口:验签 + challenge + 异步投 worker + 👀 表情 |
| [lambda_worker.py](lambda_worker.py) | 干活儿的:幂等去重 + locale + 规范化 → `common.router` |
| [caps.py](caps.py) | `SlackCaps` —— 七个能力在 Slack 上的实现 |
| [im_blocks.py](im_blocks.py) | Block Kit 渲染(进度、答案、案例表单) |
| [app/blocks.py](app/blocks.py) | 通用 Block Kit 组件(section / button / modal / input 等) |
| [app/support_flow.py](app/support_flow.py) | "升级到 Support" Modal + 提交处理 |
| [app/case_flow.py](app/case_flow.py) | 案例 CRUD UI(列表 / 详情 / 创建 / 回复 / 关闭) |
| [app/main.py](app/main.py) | ⚠️ **已退役**:Socket Mode 主进程,留作回滚路径 |
| [Dockerfile](Dockerfile) | ⚠️ **已退役**:`BotStack` 用它构建镜像,留作回滚路径 |
| [requirements.txt](requirements.txt) | `slack-bolt` + `slack-sdk` + `boto3`(Lambda Layer 与镜像共用) |

平台无关 (`../common/` 与 `../../core/` 共享):

| 文件 | 作用 |
|---|---|
| [../common/router.py](../common/router.py) | 确定性分发(0 token)+ prompt-injection 二道门 |
| [../common/quick_ack.py](../common/quick_ack.py) | 提问后的 👀 表情(三平台共用,永不抛) |
| [../common/live_card.py](../common/live_card.py) | 自刷新进度卡 |
| [../common/lambda_progress.py](../common/lambda_progress.py) | 进度轮询 Lambda(扫 `imtask#` 行) |
| [../../core/nl_router.py](../../core/nl_router.py) | 双语正则意图路由(六条路) |
| [../../core/bedrock_intent.py](../../core/bedrock_intent.py) | Bedrock 意图总结(只剩案例路径用) |
| [../../core/case_classifier.py](../../core/case_classifier.py) | AWS Support service/category 分类器 |
| [../../core/case_management.py](../../core/case_management.py) | Support API 5 个操作 |
| [../../core/chat_history.py](../../core/chat_history.py) | 滚动会话上下文 |
| [../../core/ddb_state.py](../../core/ddb_state.py) | DynamoDB 共享状态表 |
| [../../core/next_steps.py](../../core/next_steps.py) | 报告后 next-step 按钮 |
| [../../core/push_event.py](../../core/push_event.py) | EventBridge 推送事件归一化 |
| [../../core/support_logic.py](../../core/support_logic.py) | Support case 创建逻辑 |
| [../../core/webhook_dispatch.py](../../core/webhook_dispatch.py) | HMAC 派发到 DevOps Agent |
