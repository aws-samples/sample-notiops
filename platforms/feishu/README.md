# NotiOps — Feishu (Lark) Adapter

让飞书用户通过 `@NotiOps <自然语言>` 触发 DevOps Agent 调查，结果回到原对话/原话题。

**长连接架构**：长连接进程跑在 ECS Fargate，主动连飞书开放平台 WebSocket，**不开放任何公网 endpoint**。
平台无关的业务逻辑在 [`../../core/`](../../core/) 共享给其他 IM 适配器；本目录只放飞书专属代码(基础设施由仓库根 CDK 的 `BotStack` 统一定义)。

## 架构

```
飞书: @NotiOps 帮我列出 IAD 所有 EC2
         │ (WebSocket, outbound)
         ▼
┌──────────────────────────────────────────┐
│ ECS Fargate Task (1 replica)             │
│  app/main.py                             │
│  - lark_oapi.ws.Client                   │
│  - 收 im.message.receive_v1:             │
│     1. event_id 去重 (DDB conditional)   │
│     2. reply "🤔 正在理解…"              │
│     3. core.bedrock_intent 总结意图      │
│     4. 发 interactive card +             │
│        [✅ 确认派发] [❌ 取消]           │
│  - 收 card.action.trigger:               │
│     1. core.webhook_dispatch → Agent     │
│     2. core.ddb_state 写 incident 映射   │
│     3. update_card "✅ 已派发"           │
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
│  → feishu sender 把报告投回飞书          │
└──────────────────────────────────────────┘
```

## 飞书开放平台一次性配置

在 https://open.feishu.cn → 你的企业自建应用：

### 1. 启用机器人
**应用功能 → 机器人 → 启用**。设置机器人名（用户 @ 时显示的）。

### 2. 拿凭证
**凭证与基础信息 → App ID / App Secret** 复制下来。

### 3. 启用长连接 + 订阅事件
**事件与回调 → 事件配置 → 长连接** → 启用（替代 HTTP 回调）。

**订阅事件**（点添加事件）：
- `im.message.receive_v1`（接收消息）
- `card.action.trigger`（卡片回调）

注：长连接模式下不需要配置回调 URL、Verification Token、Encrypt Key。

### 4. 申请权限
**权限管理** → 添加：
- `im:message`（读消息）
- `im:message:send_as_bot`（发消息）
- `im:message:reply`（回复消息）
- `im:chat`（读群信息）

### 5. 发布版本
**版本管理与发布** → 创建新版本 → 申请发布 → 管理员审批。
（自建应用如果你是 admin 可以自动通过）

### 6. 把机器人拉进群
群里 → `+` → 添加机器人。

## 部署

> ℹ️ 本目录**不再单独部署**。飞书适配器是融合系统的一部分,由仓库根的 CDK
> 一并部署 —— 入口是 [`../../setup.sh`](../../setup.sh)(交互式 CDK 部署)。
> 原先的 SAM / CloudFormation 单栈流程(`template.yaml` + `samconfig.toml`)已下线。
> 完整流程、前置条件与排查见 [`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md)(权威文档),下面只讲飞书相关的关键点。

### 由哪个栈部署

`./setup.sh` 走 `cdk deploy --all`,一次部署三个栈;飞书 bot 在 **`BotStack`** 里:

- `BotStack` 定义了飞书 / Slack 的 Fargate Service(`infra/lib/bot-stack.ts`)。镜像由 CDK
  用 `platforms/feishu/Dockerfile` 直接构建(**build context = 仓库根**,因为镜像里需要
  `core/` + `shared/` 共享模块),推到 CDK 自建的 ECR,你**无需手动 `finch build` / `ecr push`**。
- 是否拉起飞书 task 由 `enabledPlatforms` 开关决定:`setup.sh` 选了飞书 → `desiredCount=1`;
  没选 → task 存在但 `desiredCount=0`,不起容器、不计费。

### 飞书凭据怎么填(关键)

`setup.sh` **不采集任何 IM 凭据**。CDK 只创建一个**空的** Secret `notiops/im-bot-feishu`;
部署完成后再填 App ID / App Secret(以及可选的推送目标群 `notify_chat_ids`),两种方式:

1. **(推荐)** 登录 Web Chat(admin)→「通知设置」填入飞书凭据。
2. 直接更新 Secret 再强制重启飞书 ECS 服务加载新凭据:
   ```bash
   # Secret 结构见 docs/DEPLOYMENT.md §4;更新后强制重启:
   aws ecs update-service \
     --cluster <BotStack 的 ECS cluster> \
     --service <飞书 service 名> \
     --force-new-deployment
   ```

CDK 栈始终通过 ARN 引用该 Secret,**本地不落任何凭据文件**。DevOps Agent 的 webhook /
HMAC secret、共享 DDB 表、S3 报告 bucket 都由 `NotiOpsBackendStack` 拥有并自动创建,
飞书栈无需手动传 DDB 名 / ARN。

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
1. bot 立即话题回复 "🤔 正在理解你的指令…"
2. 紧接着发出意图确认卡片，带 [✅ 确认派发] [❌ 取消] 按钮
3. 点 ✅ → 卡片更新成 "✅ 已派发（by 你的名字）"，紧跟 thread 提示 "🔍 调查中…"
4. 几分钟后 DevOps Agent 完成 → 报告链接 + 摘要回到原 thread

## 排查

> ECS cluster / service / log-group 名由 CDK(`BotStack`)生成,先用下面的命令查到实际名字,
> 或直接在 ECS 控制台看飞书 service。

```bash
# 查飞书 service 的实际名字(BotStack 的 cluster / service)
aws ecs list-clusters
aws ecs list-services --cluster <BotStack 的 cluster>

# 实时日志(streamPrefix=feishu-bot;日志组名以 ECS 控制台显示为准)
aws logs tail <飞书 task 的 log group> --follow

# 只想重启 task(不改镜像 / 不改配置):
aws ecs update-service \
  --cluster <BotStack 的 cluster> \
  --service <飞书 service 名> \
  --force-new-deployment

# 改了飞书适配器代码后重新部署(镜像由 CDK 构建,在仓库根执行):
cd ../.. && cdk deploy BotStack
```

## 文件结构

平台特定(本目录):

> ECS / ECR / IAM / VPC 等基础设施**不在本目录**,由仓库根 CDK 的 `BotStack`
> (`infra/lib/bot-stack.ts`)统一定义。本目录只有飞书专属的容器与应用代码。

| 文件 | 作用 |
|---|---|
| [Dockerfile](Dockerfile) | python:3.12-slim,**build context 必须是仓库根**(CDK 用它构建镜像) |
| [requirements.txt](requirements.txt) | `lark-oapi` + `boto3` |
| [app/main.py](app/main.py) | 主进程：lark-oapi long-connection client |
| [app/feishu_utils.py](app/feishu_utils.py) | tenant_access_token 缓存、消息/卡片发送 |
| [app/support_flow.py](app/support_flow.py) | "升级到 AWS Support" 飞书 UI 层(表单卡片 + 卡片回调路由) |

平台无关 (`../../core/` 共享):

| 文件 | 作用 |
|---|---|
| [../../core/bedrock_intent.py](../../core/bedrock_intent.py) | Bedrock Claude Haiku 意图总结 |
| [../../core/case_classifier.py](../../core/case_classifier.py) | AWS Support service/category 分类器 |
| [../../core/webhook_dispatch.py](../../core/webhook_dispatch.py) | HMAC 派发 webhook 到 DevOps Agent |
| [../../core/ddb_state.py](../../core/ddb_state.py) | DynamoDB 共享状态表(跨平台，带 `platform` 字段) |
| [../../core/support_logic.py](../../core/support_logic.py) | Support Case 创建业务逻辑(分类 + CreateCase + 幂等锁) |
