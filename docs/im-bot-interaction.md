# IM 机器人交互方式说明

> ℹ️ **入口定位**:NotiOps 的**主入口是浏览器里的 Web Chat 网页控制台**(见 `USER_GUIDE.md §12`);飞书 / Slack 等 IM 是必要但**次要的补充入口**。本文档只讲 **IM 补充入口**的交互方式与配置。

> ⚠️ **NotiOps bot 是只读机器人**:它只做**查询**(读 DynamoDB 报告)和**发起调查**(派发给 DevOps Agent),**绝不代用户执行任何变更 / 数据采集等写操作**。

## 飞书交互方式

只需要创建 1 个飞书企业自建应用（机器人），所有运维人员共用这一个机器人。

### 整体流程

```mermaid
graph TB
    subgraph Feishu["飞书工作台"]
        Bot["🤖 NotiOps<br/>（企业自建应用）"]

        subgraph Users["运维团队（共用同一个机器人）"]
            User1["👤 张三"]
            User2["👤 李四"]
            User3["👤 王五"]
        end
    end

    subgraph Interaction["两种对话方式"]
        DM["方式一：私聊机器人<br/>1对1 对话"]
        Group["方式二：群聊 @机器人<br/>在运维群里 @NotiOps"]
    end

    subgraph AWS["AWS（系统部署账号）"]
        ECS["ECS Fargate Bot<br/>（飞书 lark-oapi 长连接，无公网入站）"]
        DDB["DynamoDB<br/>（巡检 / 闲置 / 成本 / 调查记录）"]
        Investigate["shared/devops_agent.create_investigation<br/>（嵌入 &lt;!--notiops:&lt;id&gt;--&gt; 调查标记）"]
        Report["devops_agent_callback → report_handler<br/>单 S3 报告管线"]
    end

    User1 --> DM
    User1 --> Group
    User2 --> DM
    User2 --> Group
    User3 --> Group

    DM -->|长连接| ECS
    Group -->|长连接| ECS
    ECS -->|"查询（只读）"| DDB
    ECS -->|"派发调查"| Investigate
    Investigate -->|EventBridge 回调| Report
    Report -->|"一张最终报告卡回贴发起线程"| ECS
```

### 方式一：私聊机器人

```mermaid
sequenceDiagram
    participant User as 👤 张三
    participant Bot as 🤖 NotiOps（ECS）
    participant DDB as DynamoDB
    participant Agent as DevOps Agent

    Note over User,Bot: 在飞书里找到"NotiOps"，直接发消息
    User->>Bot: 今天的 RDS 巡检报告
    Bot->>DDB: 读巡检报告（只读查询）
    DDB-->>Bot: 报告数据
    Bot-->>User: 📊 RDS 巡检报告（消息卡片）

    Note over User,Bot: 发起一次调查（read-only：bot 只是派发，不自己动手改资源）
    User->>Bot: 帮我调查 db-prod-03 的连接异常
    Bot-->>User: 🚀 启动调查编辑卡（details / 调查起点 / 日志片段 三个输入框 + 💡 LLM 维度提示）
    User->>Bot: 填好字段 → 点「🚀 派发调查」
    Bot->>Agent: create_investigation(incident_id=feishu-<event_id>)
    Bot-->>User: ✅ 已派发，⏳ 调查启动中
    Agent-->>Bot: （EventBridge 回调）调查完成
    Bot-->>User: 📝 Report Summary + 📊 查看完整报告（按钮）
```

### 方式二：群聊 @机器人

```mermaid
sequenceDiagram
    participant User1 as 👤 张三
    participant User2 as 👤 李四
    participant Group as 💬 运维群
    participant Bot as 🤖 NotiOps（ECS）
    participant Agent as DevOps Agent

    Note over Group: 运维群里有多个人 + 机器人
    User1->>Group: @NotiOps 生产账户有多少闲置资源？
    Group->>Bot: 触发机器人（user=张三）
    Bot-->>Group: 📊 闲置资源概览（只读查询，群里所有人可见）

    User2->>Group: @NotiOps 帮我调查这个 CloudWatch 告警
    Group->>Bot: 触发机器人（user=李四）
    Bot-->>Group: 🚀 启动调查编辑卡（三个输入框）
    User2->>Group: 点「🚀 派发调查」
    Bot->>Agent: create_investigation(incident_id=feishu-<event_id>)
    Agent-->>Bot: （EventBridge 回调）调查完成
    Bot-->>Group: 📝 Report Summary + 📊 查看完整报告（回贴到发起线程）
```

### 关键点

```mermaid
graph LR
    subgraph Key["核心理解"]
        A["1个机器人<br/>= 1个飞书企业自建应用"]
        B["5个人共用<br/>机器人通过 user_id 区分谁在说话"]
        C["群聊共享 Session<br/>同一群的所有用户共享对话上下文"]
        D["私聊独立 Session<br/>每个用户有独立的对话记忆"]
        E["只读机器人<br/>只查询 + 派发调查，不代执行写操作"]
    end
```

## 钉钉交互方式

> ⏳ **钉钉为 Phase 2（v1 默认不启用）**：适配代码 + sender 完整保留（`platforms/dingtalk/`），但 v1 `setup.sh` 不开放钉钉选项 → 钉钉 ECS task `desiredCount=0`，不启动、不计费。按 USER_GUIDE §9.5：启用后**对话 / 调查派发 / 报告回贴属 Phase 1 能力**，而**进度卡 / Push 主动观察 / case 管理属 Phase 2**（尚未 GA）。

钉钉的逻辑与飞书一致：创建 1 个钉钉企业内部机器人（Stream 模式），所有人共用。

```mermaid
graph TB
    subgraph DingTalk["钉钉（⏳ Phase 2）"]
        DBot["🤖 NotiOps<br/>（企业内部机器人，Stream 模式）"]
        DUser1["👤 用户A"] --> DBot
        DUser2["👤 用户B"] --> DBot
    end

    subgraph AWS2["AWS（同一套后端）"]
        DECS["ECS Fargate Bot<br/>（钉钉 task，v1 desiredCount=0）"]
        DInvestigate["create_investigation"]
    end

    DBot -->|Stream 长连接| DECS
    DECS --> DInvestigate
```

## 飞书 vs 钉钉 对比

| 项目 | 飞书 | 钉钉 |
|------|------|------|
| 机器人类型 | 企业自建应用 | 企业内部机器人 |
| 创建位置 | 飞书开放平台 | 钉钉开放平台 |
| 当前状态 | ✅ v1 GA | ⏳ v1 默认不启用（task `desiredCount=0`）；启用后对话/派发可用 |
| 连接方式 | lark-oapi 长连接（无公网入站）| Stream 模式长连接 |
| 私聊 | ✅ 支持 | ✅ Phase 1（启用后）|
| 群聊 @ | ✅ 支持 | ✅ Phase 1（启用后）|
| 定时日报推送 | ✅ 支持（Lambda4，配置 `notify_chat_ids`）| ⏳ Phase 2 |
| 调查结果返回 | ✅ 回贴发起线程（一张最终报告卡 summary_card + 「查看完整报告」）| ✅ Phase 1（markdown 回贴，需操作员在群里加自定义机器人）|
| 进度卡 / Push / case 管理 | ✅ 支持 | ⏳ Phase 2 |
| 后端 | ECS Fargate bot + `create_investigation` | 共用同一套后端 |

## 总结

- 飞书 v1 GA；钉钉适配代码保留，Phase 2 才启动（v1 task `desiredCount=0`）
- 所有用户共用机器人，通过 user_id 区分身份
- bot 是 **ECS Fargate 长连接服务**（无公网入站）；**read-only**，只做查询 + 派发调查
- **调查派发链路**：编辑卡 3 字段 `details / starting_point / log_snippet` → `core/dispatch_compose.compose_edited` → `shared/devops_agent.create_investigation(incident_id=...)`（在 description 末尾嵌入 `<!--notiops:<id>-->` 标记）→ EventBridge → `devops_agent_callback` → `report_handler` 单 S3 报告管线 → **一张最终报告卡回贴发起线程**（summary_card + 「📊 查看完整报告」按钮）
- 报告单一 S3 来源：`investigations/<task_id>/report.md|report.html|trace.html`；DDB 调查行 = summary_card + S3 指针（**不再内联 summary_raw**）
- **调查事件不推送 `notify_chat_ids`**（`_notify_im` 已从 `devops_agent_callback/handler.py` 删除）；`notify_chat_ids` 只用于 Lambda4 每日 02:00 UTC 日报（+ PHD）
- 系统每天 02:00 UTC 推送一份日报（巡检 + 闲置 + 成本异常 + 昨日调查）到配置了 `notify_chat_ids` 的群

## 飞书机器人配置步骤

### 前置条件

- 系统已通过 `./setup.sh` 部署完成
- 飞书 ECS bot 用 **lark-oapi 长连接（WebSocket）**模式，与 webhook 模式互斥 —— **无需公网 endpoint**

### 完整操作顺序

#### 第 1 步：获取飞书应用凭证

1. 打开 [飞书开放平台](https://open.feishu.cn) → 创建或进入你的企业自建应用
2. 左侧菜单「凭证与基础信息」→ 记下 **App ID** 和 **App Secret**

#### 第 2 步：开启机器人能力

1. 左侧菜单「应用能力 / 添加应用能力」→ 开启「机器人」能力，设置 bot 显示名

#### 第 3 步：事件订阅切「长连接」

1. 左侧菜单「事件与回调 → 事件配置」→ 订阅方式选 **「长连接」**（NOT webhook URL）
2. 添加事件 `im.message.receive_v1`（接收消息）
3. 「事件与回调 → 回调配置」同样选「长连接」，确认 `card.action.trigger` 已订阅（卡片按钮交互必需）

#### 第 4 步：添加权限

1. 左侧菜单「权限管理」→ 添加（或批量导入）：
   - `im:message` / `im:message:send_as_bot` / `im:message:readonly`
   - `im:message.group_at_msg:readonly` / `im:message.p2p_msg:readonly`
   - `im:chat` / `im:resource` / `cardkit:card:read` / `cardkit:card:write`

#### 第 5 步：在 AWS Secrets Manager 中存入凭证（推荐通过 Dashboard）

**方式 A（推荐）**：Dashboard → 设置 → 通知设置（路径 `/settings/notifications`），在飞书配置卡片里填入 App ID / App Secret / `notify_chat_ids`，保存。后端 `PUT /api/notification-config` 会校验格式并写入 Secret。

**方式 B（直接改 Secret）**：找到 `notiops/im-bot-feishu` Secret（ARN 在 setup.sh 部署输出中），填入以下 JSON：

```json
{
  "app_id": "cli_xxxxxxxx",
  "app_secret": "xxxxxxxx",
  "verification_token": "xxxxxxxx",
  "encrypt_key": ""
}
```

> 长连接模式下 `verification_token` / `encrypt_key` 不是必填（它们是 webhook 模式才用到的字段）；页面上为空时 JSON 中填空字符串 `""` 即可。

#### 第 6 步：发布应用

1. 左侧菜单「版本管理与发布」→ 创建应用版本并发布上线（自建应用 admin 可自批）
2. 发布后，运维人员即可在飞书中搜索到该机器人，通过私聊或群聊 @ 的方式使用

### 验证

在飞书中找到机器人，发送一条消息（如「今天的 RDS 巡检报告」），如果收到回复则配置成功。

## 钉钉机器人配置步骤（⏳ Phase 2）

> 钉钉在 v1 不启动（`desiredCount=0`），下面流程作为 Phase 2 预读参考。

1. 在 [钉钉开放平台](https://open-dev.dingtalk.com) 创建企业内部应用（H5 微应用），获取 **AppKey** / **AppSecret**
2. 「应用能力 → 机器人」→ 启用 → 消息接收模式选 **Stream 模式**（长连接，与飞书一样无需公网入站）
3. 钉钉凭证 Secret **由用户手动创建**（CDK 不自动创建）：
   - `notiops/dingtalk-app-key` → 钉钉 AppKey 字符串
   - `notiops/dingtalk-app-secret` → 钉钉 AppSecret 字符串
4. 权限：至少添加 `Robot 接收消息` / `Robot 主动发送消息` / `IM 群消息读写`
5. 发布机器人上线，并把机器人加进目标群

## 定时日报推送（主动通知）

除了用户主动发消息给机器人（被动响应），系统还有一种主动通知：**Lambda4 定时日报** —— 每天 UTC 02:00（北京时间 10:00）汇总前一天的巡检 / 闲置 / 成本异常 / 昨日调查，推送一条日报到配置了 `notify_chat_ids` 的群。

> ℹ️ **调查事件不在这里推送**。DevOps Agent 调查任务的结果通过 `report_handler` **回贴到发起调查的对话线程**（一张最终报告卡），**不会**广播到 `notify_chat_ids`。`_notify_im` 已从 `devops_agent_callback/handler.py` 删除；`notify_chat_ids` 现在只服务 Lambda4 日报（+ PHD）。

### 架构

```mermaid
graph TB
    subgraph EventSource["⏰ 事件源"]
        Rule["EventBridge 每天 02:00 UTC<br/>notiops-daily-notification"]
        DevOpsEvent["DevOps Agent 调查事件<br/>（Custom Event Bus 触发）"]
    end

    subgraph NotifierLambda["📮 Lambda4-Notifier（定时日报）"]
        Query["查询当天数据"]
        Format["格式化 Markdown"]
        Send["调用 notifier 推送"]
    end

    subgraph CallbackLambda["📡 Callback Lambda + report_handler（调查结果）"]
        Handler["处理调查事件<br/>写 DDB 调查行（summary_card + S3 指针）"]
        ReportCard["report_handler<br/>一张最终报告卡 → 发起线程"]
    end

    subgraph DB["💾 DynamoDB"]
        HealthReport["巡检报告（RDS / ElastiCache）"]
        WasteReport["闲置资源报告"]
        CostAnomaly["成本异常摘要"]
        DevOpsInv["DevOps Agent 调查记录"]
    end

    subgraph S3["🗄️ S3 报告 bucket"]
        ReportS3["investigations/&lt;task_id&gt;/<br/>report.md | report.html | trace.html"]
    end

    subgraph IM["💬 IM 平台"]
        FeishuGroup["飞书群<br/>（notify_chat_ids，仅日报）"]
        FeishuThread["飞书发起线程<br/>（调查结果回贴）"]
    end

    subgraph Secrets["🔐 Secrets Manager"]
        FeishuSecret["notiops/im-bot-feishu<br/>含 notify_chat_ids"]
    end

    Rule -->|"触发"| Query
    Query --> HealthReport
    Query --> WasteReport
    Query --> CostAnomaly
    Query --> DevOpsInv
    Query --> Format
    Format --> Send
    Send -->|"读 Secret"| Secrets
    Send --> FeishuGroup

    DevOpsEvent -->|"触发"| Handler
    Handler --> DevOpsInv
    Handler --> ReportS3
    Handler --> ReportCard
    ReportCard --> FeishuThread
```

### 执行时序（定时日报）

| 时间 (UTC) | 事件 | 说明 |
|------------|------|------|
| 00:00 | Lambda1-Collector | 资源采集 + 闲置判定（仅部署账号，跨账号已 locked） |
| 00:30 | Lambda3-HealthChecker (RDS) | RDS AI 智能巡检报告生成 |
| 01:00 | Lambda3-HealthChecker (ElastiCache) | ElastiCache AI 智能巡检报告生成 |
| 01:15 | Lambda5-CostAnalyzer | 成本异常分析 |
| 02:00 | Lambda4-Notifier | 查询当天数据 → 推送日报到飞书 `notify_chat_ids` |

### 调查结果返回（Callback Lambda + report_handler）

DevOps Agent 调查任务状态变更时，通过 EventBridge 跨账户转发到系统账号 Custom Event Bus，Callback Lambda 消费事件：

| Detail-Type | 处理 |
|-------------|------|
| `Investigation Created` | 🔵 新调查已创建（发起线程进度卡）|
| `Investigation Completed` | ✅ 拉报告 → 写 S3（report.md/html）+ DDB 调查行（summary_card + S3 指针）→ 一张最终报告卡回贴发起线程 |
| `Investigation Failed` | ❌ 不拉报告、不写 S3，以失败描述入库 + 失败卡 |
| `Investigation Timed Out` | ⏰ 同失败路径 |
| `Investigation Cancelled` | ⏹ 调查已取消 |
| `Investigation Linked` | 🔗 已关联到其他调查 |

> `report_handler` 通过从 journal 反向 grep `<!--notiops:<id>-->` 标记（双兼容正则同时识别旧的 `<!--notiops-devops:<id>-->`）拿到 incident_id，查 DDB `incident#` row 拿到 chat 上下文，把最终报告卡精准回贴到发起调查的那个线程。

### 通知内容（日报）

每日通知包含：

1. **RDS 巡检报告摘要** — 各账户的实例数、严重/警告/关注数量
2. **ElastiCache 巡检报告摘要** — 各账户的实例数、严重/警告/关注数量
3. **闲置资源概览** — 闲置资源总数、预估月度节省金额
4. **Top 5 高价值闲置资源** — 按月度节省金额降序排列
5. **成本异常检测** — 异常数量、预计额外成本

如果当天没有巡检报告（RDS 和 ElastiCache）、闲置资源数据和成本异常数据，则跳过通知。

### 配置方法（推荐走 Dashboard）

**推荐**：Dashboard 「设置 → 通知设置」页面（路径 `/settings/notifications`）：
- 填入飞书凭证 + `notify_chat_ids`
- 后端通过 `PUT /api/notification-config` 写回 `notiops/im-bot-feishu` Secret，带格式校验（`cli_xxx` / `oc_xxx`）
- 敏感字段（secret / token）在页面上以 `****` 遮罩展示
- `POST /api/notification-config/test` 可发送一条测试通知验证配置
- 通知配置**仅支持飞书**（后端拒绝非 `feishu` platform）

**或直接改 Secret JSON**（绕过校验，仅建议运维排障时使用）：

飞书（`notiops/im-bot-feishu`）：

```json
{
  "app_id": "cli_xxxxxxxx",
  "app_secret": "xxxxxxxx",
  "verification_token": "xxxxxxxx",
  "encrypt_key": "",
  "notify_chat_ids": "oc_xxx,oc_yyy"
}
```

- `notify_chat_ids`：逗号分隔的群 ID 列表
- 飞书群 ID 格式：`oc_xxxxxxxx`（在飞书群设置中查看）
- 不填或留空则**日报跳过**（调查结果仍照常回贴到发起线程，不依赖 `notify_chat_ids`）

### 通知示例

```markdown
📋 **2026-03-20 每日巡检通知**

**🔍 RDS 巡检报告**

- [汇总] 共 15 实例 | 🔴 严重 1 | 🟡 警告 3 | 🔵 关注 5

**🔍 ElastiCache 巡检报告**

- [汇总] 共 8 实例 | 🔴 严重 0 | 🟡 警告 1 | 🔵 关注 2

**💰 闲置资源概览**

- 闲置资源总数: **8** 个
- 预估月度节省: **$1,234.56**

**Top 5 高价值闲置资源：**

1. `prod-rds-unused-01` (RDS) | 123456789012 | ap-northeast-1 | $456.78/月
2. `staging-cache-01` (ElastiCache) | 123456789012 | ap-northeast-1 | $234.56/月
...

---
💡 回复消息可直接与 NotiOps 对话，查看详细报告或发起调查。
```
