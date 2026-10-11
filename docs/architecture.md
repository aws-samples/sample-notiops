# 系统架构

> 本文是资源清单视角的系统架构。组件模型与数据流的权威说明见 [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md)。

NotiOps 以 **只读 Web Chat 控制台** 为主入口:浏览器里直接和 AWS 运维 agent(Strands / Bedrock **AgentCore Runtime**)对话,做调查 / FinOps / 案例 / Skills,经 **BFF Lambda + Function URL(SSE 流式)** 驱动,状态落 `notiops-web-chat` DynamoDB 单表,配 notif 收件箱 handler 与 **Cognito Identity Pool** 鉴权。作为必要补充,NotiOps 同时把 **AWS DevOps Agent**(`aidevops` API)接入企业 IM(飞书 / Slack / 钉钉),让用户在告警群里 `@bot 一句话` 也能调起调查、看实时进度、收本地化报告。系统还附带一条 **资源巡检 / 成本异常 / AWS Health** 的后台流水线(`notiops-inspection-*` 四个 Lambda + SQS `notiops-inspection-tasks` + `notiops-inspection` 表,外加 Lambda4 通知与 Lambda5 成本异常两条 cron),巡检结论可以按投递目标推到 IM 群(本版本还没有登记投递目标的途径,所以实际在 Web Chat 的巡检看板里看),巡检看板与管理页都在 Web Chat 站内。**老的 React 管理控制台和它背后的 API Gateway REST API 已于 2026-09-04 退役。**

数据层 **全部使用 DynamoDB**(后台 4 张核心表:`notiops-conversations` / `notiops-config` / `notiops-inspection` / `notiops-metrics`,另加 Web Chat 的 `notiops-web-chat` 单表),**没有任何 RDS / PostgreSQL / SQL**。**IM 机器人** 走 **API Gateway HTTP API + Lambda webhook**(`ImStack`:每平台一个 HTTP API + ingress + worker,worker 直接 `import core/`;旧的 ECS Fargate 长连接容器已于 2026-09-03(M2)退役、只作为源码级回滚路径留在仓库里),IM 侧自己不跑任何 agent 容器:默认的 `/agent devops` 直连 DevOps Agent、不经 AgentCore Runtime;用户发 `/agent notiops` 切过去之后,worker 经 `bedrock-agentcore:InvokeAgentRuntime` 调用 Web Chat 那**同一个** AgentCore Runtime(窄集主题 `im-chat`,授权在 `infra/lib/constructs/im-core.ts`,两条部署路径共用)。**Web Chat 主入口**则始终跑在 Bedrock **AgentCore Runtime** 上,经 BFF Lambda + Function URL(SSE)对外(见下方「部署栈」的 WebChatStack)。

## 架构图

```
                                    ┌──────────────────────────────────────────┐
                                    │           目标 AWS 账户 (锁定为部署账户)  │
                                    │                                          │
                                    │  RDS / ElastiCache / EC2 / CloudWatch    │
                                    │  Cost Explorer / Trusted Advisor / Health│
                                    │                    ▲                     │
                                    │  IdleDetectionRole (只读)                │
                                    └──────────────────┼───────────────────────┘
                                                       │ STS AssumeRole
                                                       │ (shared/account_scope.py:
                                                       │  LOCKED_ACCOUNT_ID 守卫)
┌──────────────────────────────────────────────────────┼──────────────────────────────────────┐
│  系统部署账户                                          │                                      │
│                                                       │                                      │
│  ── 路径 A：后台巡检流水线 ──                          │                                      │
│                                                       │                                      │
│  EventBridge (2 条 cron + 4 条 rate 规则)             ▼                                      │
│    ├─ 01:15 UTC ─▶ Lambda5-CostAnalyzer (512MB/15min)                                        │
│    ├─ 02:00 UTC ─▶ Lambda4-Notifier ──▶ 飞书群(notify_chat_ids)                              │
│    ├─ 每 15 分钟 ─▶ notiops-inspection-scheduler ──SQS──▶ notiops-inspection-executor        │
│    ├─ 每 15 分钟 ─▶ notiops-inspection-push(巡检结论投 IM 群)                                │
│    ├─ 每 1 小时  ─▶ notiops-inspection-reconciler(对账超时 / 丢单)                           │
│    └─ 每 4 小时  ─▶ Lambda6-CurFinalizer (256MB/10min,CUR 阶段二自愈)                        │
│                                                                                              │
│  Lambda5 与巡检 4 λ 的结果 ──▶ DynamoDB notiops-inspection / notiops-config                  │
│  巡检的 AI 判读派给 DevOps Agent(CreateBacklogTask);Lambda5 是统计算法,不调模型              │
│                                                                                              │
│  ── 路径 B：AWS Health 事件转发（PHD）──                                                     │
│                                                                                              │
│  EventBridge (aws.health) ──▶ SNS Topic ──▶ phd_event_forwarder Lambda (128MB/90s)          │
│  (可选跨账号) Linked Account EventBridge ──▶ 同一 SNS Topic                                  │
│  phd_event_forwarder ──LLM 翻译(shared/llm_provider)──▶ 飞书群(notify_chat_ids)            │
│                                                                                              │
│  ── 路径 C：IM 机器人（HTTP API + Lambda webhook，ImStack）──                                │
│                                                                                              │
│  飞书 ──webhook──┐   ingress λ（验签+去重+异步投递）                                          │
│  Slack ──webhook─┤──▶ ─────────────────────────▶ worker λ (import core/)                     │
│  钉钉 ──webhook──┘   （三家同形态、各自一套 HTTP API；钉钉须选 HTTP 模式）                   │
│                           ├─ core.nl_router       确定性意图路由（0 token）                  │
│                           ├─ core.devops_chat     默认对话:直连 DevOps Agent(0 token)        │
│                           ├─ core.agent_chat      切到 /agent notiops 后:InvokeAgentRuntime  │
│                           │                       ──▶ 路径 E 那同一个 Runtime(im-chat,走模型)│
│                           ├─ core.devops_agent    深度调查:CreateBacklogTask(0 token)        │
│                           ├─ notiops-im-progress λ 轮询 aidevops:ListJournalRecords          │
│                           ├─ core.case_management  Support case 增删改查 + case_analyze      │
│                           ├─ core.ddb_state        读写 notiops-conversations 表             │
│                           ├─ core.bedrock_intent  旧 LLM 意图分类(现网路由已不用它)          │
│                           ├─ core.bedrock_chat    通用对话 + AWS Docs MCP（仅回滚路径）      │
│                           └─ MCP sidecar 已随 BotStack 退役（IM Lambda 侧显式关闭）          │
│                                                                                              │
│  ── 路径 D：DevOps Agent 调查回调 ──                                                         │
│                                                                                              │
│  各业务账户：独立 AgentSpace + EventBridge Rule（跨账户 PutEvents）                          │
│                ──▶ 系统账户 Custom Event Bus: notiops-devops-events                    │
│                        └──▶ devops_agent_callback Lambda (256MB/120s)                        │
│                                ├─ AssumeRole 跨账户拉一次 long_report（ListJournalRecords）   │
│                                ├─ shared/report_delivery::build_investigation_report          │
│                                │    写 S3: investigations/<task_id>/report.md|html|trace.html │
│                                │    summary_card = DA 报告的确定性切片(0 token,不调 Bedrock)  │
│                                └─ UPSERT notiops-config(invst#<task_id>)               │
│                                     只存 summary_card + S3 指针,不内联 summary_raw           │
│                                （报告卡发回发起会话的线程;调查类事件不推 notify_chat_ids）   │
│                                                                                              │
│  ── 路径 E：Web Chat（主入口）──                                                             │
│                                                                                              │
│  chat-app SPA (CloudFront ChatCDN + S3) ──SigV4──▶ BFF Lambda Function URL (AWS_IAM)         │
│    ├─ Cognito User Pool + Identity Pool（JWT 换临时凭证去签名）                              │
│    ├─ DynamoDB 单表 notiops-web-chat（会话 / 消息 / notif 收件箱）                           │
│    └─ AgentCore Runtime（Strands agent）──SSE──▶ 浏览器                                      │
│                                                                                              │
│  ── 共享基础设施 ──                                                                          │
│                                                                                              │
│  DynamoDB × 5 │ S3（报告 + 前端 + Onboarding 模板）│ Secrets Manager │ SSM Parameter Store   │
│  SNS │ SQS DLQ │ Cognito User Pool │ Custom Event Bus                                       │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 部署栈

| Stack | 内容 |
|-------|------|
| `WebChatStack`(主入口) | Web Chat:Strands / Bedrock **AgentCore Runtime** agent + BFF Lambda(`notiops-web-chat-bff`)+ Function URL(`AWS_IAM`,SSE 流式)+ DynamoDB 单表 `notiops-web-chat`(会话 / 消息 + notif 收件箱段)+ Cognito Identity Pool。收件箱的**写侧** `notiops-web-notif-handler` 不在本栈,在 `NotiOpsBackendStack` |
| `NotiOpsBackendStack` | 后台 Lambda(10~11 个业务 Lambda:Notifier / CostAnalyzer / CurFinalizer / 巡检 4 个 / DevOpsCallback / PushHandler / WebNotifHandler / PHDForwarder(可选))+ DynamoDB × 4(`notiops-conversations` / `notiops-config` / `notiops-inspection` / `notiops-metrics`)+ S3 共用数据桶 + Reports CloudFront(在线报告)+ EventBridge + SNS/SQS + Cognito User Pool + Custom Event Bus + Onboarding 资源。**不再有 API Gateway REST API** —— 随老控制台一起退役(2026-09-04) |
| `ImStack`(选了 IM 才建) | **IM 的正式运行路径**:每平台一个 **API Gateway HTTP API**(公网入口,`$default` catch-all,阶段级限流 50 rps)+ 一对 Lambda —— ingress(平台签名校验 + `reservedConcurrentExecutions=10`)+ worker(900s)、共用依赖 Layer、事件去重表、进度轮询 Lambda。Outputs 里的 `FeishuWebhookUrl` / `SlackWebhookUrl` / `DingtalkWebhookUrl` 就是要填进 IM 平台控制台的请求地址 |
| ~~`BotStack`~~ | ❌ **2026-09-03(M2)已退役,不再部署**。原来是 IM 的长连接实现:VPC + ECS Fargate Cluster + ECR(bot 镜像)+ 每平台一个 Fargate Service + MCP sidecar。`infra/bin/app.ts` 不再实例化它;`infra/lib/bot-stack.ts` 与三个 Dockerfile **故意留在仓库里**当源码级回滚路径(回滚要重建 VPC/ECS + 重新构建镜像,~20 分钟,见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §1.6)。它**没有任何 CFN Export**,所以删掉不会影响别的栈 |

有**两条**部署路径,**Web Chat 侧的功能必须逐条对等**:

- **方式 A —— 一键 CloudFormation(单栈)**:合成入口 `infra/bin/standalone.ts` → `infra/lib/notiops-webchat-standalone-stack.ts`(CDK stack id `NotiOps`,发布成客户下载的 `notiops-webchat.template.json`,部署时的栈名由部署者自选)。**免本地环境、免 access key** —— 在 CloudFormation 控制台上传模板就能开栈。它建的是 Web Chat 那一套(前端 + BFF + AgentCore Runtime agent),外加一份「最小底座」(`notiops-config` 表 / Cognito 用户池 `notiops-users` / 共享数据桶 / ReportsCDN,见 `infra/lib/constructs/minimal-base-core.ts`),以及参数页 `InstallOption` 可选装的一个 IM 机器人(飞书 / Lark、Slack 或钉钉);v1.0.30 起还可以选装成本 MCP(填 `CurTable` 接已有的 CUR 表,或 `ProvisionCur=yes` 让栈连 CUR + 官方 Athena 集成一起建)。详见 [DEPLOYMENT_ONECLICK.md](DEPLOYMENT_ONECLICK.md)。
- **方式 B —— `./setup.sh`(全量)**:交互式,内部编排 AgentCore Runtime 部署 + `cdk deploy --all`,建出上表的 `WebChatStack` 与 `NotiOpsBackendStack`(选了 IM 再加 `ImStack`)。

两条路径跑的是**同一份** agent 代码(`agent-build/NotiOpsWebChat`,`scripts/deploy_agent.sh` 与一键模板的产物打包都指向它)与**同一个**前端(`frontend/chat-app`);Web Chat 的资源都由同一份 `infra/lib/constructs/web-chat-core.ts` 建,IM 三件套(ingress / worker / 进度轮询)都由同一份 `infra/lib/constructs/im-core.ts` 建 —— 方式 A 在**部署期**按 `InstallOption` 选装,方式 B 在**合成期**按 `-c enabledPlatforms` 决定。对等性由 `scripts/test_oneclick_parity.py` 逐条断言(runtime 授权 / 环境变量 / 出厂数据 / 生命周期 / 通知生产端 / Operator App / AgentCore Memory / 首登交付 / IM 加装项 / CUR 仪表盘 / 替客户建 CUR / DevOps 回调 / 阿里云只读凭据)。

差异落在**后台流水线**上。方式 A **不建**这些:每日自动巡检(`notiops-inspection-*` 四个 Lambda + SQS `notiops-inspection-tasks` + 它们的 EventBridge 定时规则,连 `notiops-inspection` 表也不建)、Lambda4 通知与 Lambda5 成本异常这两条 cron、往 IM 群的**主动推送**(装了 IM 也只是群里被动应答)、成员账号侧的 CloudWatch OAM Sink 与跨账号事件回流。逐条清单见 [DEPLOYMENT_ONECLICK.md](DEPLOYMENT_ONECLICK.md) §0.1。CUR + Athena **不在**这张清单里:v1.0.30 起方式 A 也能建(`ProvisionCur=yes`;阶段一是 custom resource `CurProvision`,阶段二是每 4 小时自愈一次的 `CurFinalizerFn`,与方式 B 共用 `cur_provisioner/spec.py` 的报告规格),已有 CUR 则填 `CurTable` 接进来,见 [DEPLOYMENT_ONECLICK.md](DEPLOYMENT_ONECLICK.md) §2.12。

这些缺的后台会在 Web Chat 界面上留下两处**说得清**的差别(不是「功能可能不可用」):

- **FinOps 的「每日异常扫描」这张卡在方式 A 上整个不下发。** 方式 A 没有 `notiops-cost-analyzer`,`infra/lib/constructs/web-chat-core.ts` 因此把 BFF 的 `COST_ANALYZER_FUNCTION` 置成空串;而 `config/capabilities.json` 给 `nav:finops:daily-anomaly` 声明了 `requiresEnv: COST_ANALYZER_FUNCTION`,于是这个节点从 `/capabilities` 树里消失、前端连入口都不渲染。这是刻意收口:留着它会永远显示「近 3 天没有扫描记录(每日 01:15 UTC 跑)」(`frontend/chat-app/src/components/FinopsDashboard.tsx` 里那句),而那条路上没有任何东西在 01:15 UTC 跑。
- **「巡检」整个 tab(`nav:inspection` 连同它的全部子页)在方式 A 上也整个不下发。** 方式 A 既没有 `notiops-inspection` 表也没有那四个 Lambda,`infra/lib/constructs/web-chat-core.ts` 因此把 BFF 的 `INSPECTION_TABLE` 置成空串;而 `config/capabilities.json` 给 `nav:inspection` 声明了 `requiresEnv: INSPECTION_TABLE`,于是这个 tab 从 `/capabilities` 树里消失,子页随它一起被剔除(`bff/web-chat/authz.mjs` 的祖先补全遇到 `requiresEnv` 不满足的父节点就停,子页不会把 tab 补回来),侧栏「更多」里就没有「巡检」这一项。「更多」里于是只剩当前用户有权限的「技能」/「管理」;两样都没有时(预置角色里除 `role:admin` 与 `role:developer` 外默认都是)连「更多」按钮本身都不渲染(`frontend/chat-app/src/components/Sidebar.tsx` 的 `hasMoreItems`)。绕过前端直接打 `/inspection/*` 的请求(脚本、或浏览器里缓存着的旧前端包)由 `bff/web-chat/index.mjs` 里一道门统一挡掉,回 `inspection_not_deployed` 而不是 `ddb_error`,前端认这个码并提示改用方式 B。这道闸门是 2026-09-07 加的;在那之前这组页面两条路径都渲染,方式 A 上点进去是「加载失败 (ddb_error)」。要巡检就走方式 B。

**没有 SAM,`deploy.sh` 已下线。**

## CDK 自动创建的资源

### 数据库（DynamoDB only）

| 表 | 键 | 说明 |
|------|------|------|
| `notiops-conversations` | PK = `lookup_key` | IM ↔ DevOps Agent ↔ Lambda 的跨链路状态(event# / incident# / task# / progress# / push_dedup# / locale#…),TTL 自动清理,DeletionPolicy: Retain |
| `notiops-inspection` | PK / SK + GSI1 | 资源巡检:指标序列 / 轮次 / finding / 排除范围 / 投递目标 / 配置版本等(PK 前缀的唯一来源是 `inspection/adapters/keys.py` 的 `Prefix` 枚举);GSI1 是 finding 的跨账号统一视图(稀疏索引);TTL 自动清理,DeletionPolicy: Retain + PITR |
| `notiops-metrics` | PK / SK + GSI1 | 老 idle 巡检遗留。仍由 CDK 无条件创建、`METRICS_TABLE` 仍注入各 Lambda,但 `shared/queries` 下已**没有**业务模块读写它(只剩 `_client.metrics_table()` 这个表句柄,现在只有 `tests/queries/` 引用) |
| `notiops-config` | PK / SK + GSI1 + GSI2 | 单表多业务配置与结果,DeletionPolicy: Retain。**方式 A 也建这张表**(同名同键同 GSI,见 `infra/lib/constructs/minimal-base-core.ts`) |

> 上表是**方式 B** 的四张后台表(加 `WebChatStack` 的 `notiops-web-chat` 共 5 张)。**方式 A** 建的是:`notiops-config`(同名同键同 GSI)+ `notiops-web-chat`(同名);`notiops-inspection` **不建** —— 那条路径上没有巡检流水线;只有在参数页选装了 IM 时,才会额外建两张**不指定物理名**的表顶替 `notiops-conversations` / `notiops-metrics`(`DeletionPolicy: Delete`,里面只有带 TTL 的去重键 / 在飞的调查行 / 短期会话状态,没有需要保留的数据)。不写死名字是因为同一账号里可能已经有方式 B 建的同名表(RETAIN,删栈也不消失),撞名会让整栈回滚;Python 侧一律从环境变量读表名。见 `infra/lib/notiops-webchat-standalone-stack.ts`。

`notiops-config` 单表前缀(见 `shared/queries/*.py`):

| PK 前缀 | 用途 |
|---------|------|
| `invst#<task_id>` | DevOps Agent 调查记录(summary_card + S3 指针) |
| `da#<account_id>` | DevOps Agent 业务账户配置(agentSpaceId / triggerRoleArn 等) |
| `hreport#<rt>#<date>` + `hlatest#<rt>` | RDS / ElastiCache 健康巡检报告 + 最新指针 |
| `anomaly#<acct>#<date>` + `anomalysum#<acct>` | 成本异常结果 + 汇总 |
| `wl#<ns>#...` | 允许清单(waste / health) |
| `appconfig#devops_agent` / `appconfig#rds_health` / `appconfig#elasticache_health` | 各功能的应用配置(模型 / prompt 等) |
| `threshold#<rt>` | 阈值配置 |

### 网络

| 资源 | 说明 |
|------|------|
| ~~VPC (BotStack)~~ | ❌ 随 `BotStack` 一起退役(2026-09-03 / M2)。**现在整套系统没有 VPC** —— webhook 路径上的 Lambda 直接走 AWS API |
| API Gateway HTTP API (ImStack) | IM webhook 的公网入口(每平台一个),`$default` catch-all + 未鉴权 + 平台签名校验;阶段级限流 50 rps / burst 100,ingress 侧 `reservedConcurrentExecutions=10`;详见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §5 |

> 后台 Lambda 与 IM 的 ingress / worker 都不入 VPC(直接走 AWS API),数据层是 DynamoDB,无需隔离子网托管数据库。

### 安全与认证

| 资源 | 说明 |
|------|------|
| Secrets Manager | IM 平台凭据(飞书 / Slack / 钉钉)+ DevOps Agent webhook secret + Bedrock API Key / LiteLLM 配置。DevOps Agent 业务账户配置存在 DynamoDB `da#<account_id>` 行,不用 Secret |
| Cognito User Pool | `notiops-users`,禁止自注册 |
| 跨账户锁定 | `shared/account_scope.py` 用 `LOCKED_ACCOUNT_ID = cdk.Aws.ACCOUNT_ID` 把后台采集 / 调查锁死在部署账户(单账号模式;`--multi-account` / `-c organizationId` 部署时不注入它 = 解锁,实际覆盖范围由 config 表里启用的账号决定);AssumeRole 还校验 `trigger_role_arn` 账号 == 目标账号 |

### 计算

| 资源 | 说明 |
|------|------|
| Lambda — Inspection Scheduler (`lambda_inspection_scheduler`) | 256MB / 120s(`notiops-inspection-scheduler`),每 15 分钟读 DynamoDB 里的定时配置,判定这一刻该给哪些「类型 × 账号」派巡检 → fan-out 到 SQS `notiops-inspection-tasks`(改巡检时刻不需要重新部署) |
| Lambda — Inspection Executor (`lambda_inspection_executor`) | 1024MB / 15min(`notiops-inspection-executor`),SQS 消费(`batchSize=1`、`maxConcurrency=3`),一条消息 = 一个账号一整轮巡检:采集 → 判定 → finding 落 `notiops-inspection` |
| Lambda — Inspection Reconciler (`lambda_inspection_reconciler`) | 256MB / 5min(`notiops-inspection-reconciler`),每 1 小时对账已派发判读任务的终态(补 EventBridge 事件丢失)并检查采集覆盖缺口 |
| Lambda — Inspection Push (`lambda_inspection_push`) | 512MB / 5min(`notiops-inspection-push`),每 15 分钟醒一次,只在推送时段窗口内把当日巡检结论按投递目标投给各 IM 群(投递目标是 `notiops-inspection` 表里的登记行,本版本还没有面向客户的登记途径:没有网页入口、`setup.sh` 不问) |
| Lambda — Notifier (`lambda4_notifier`) | 256MB / 10min(`notiops-notifier`),定时推送每日汇总(资源巡检段 + 成本异常段 + 过去 24h 调查汇总);PHD 事件由独立的 PHD Forwarder 处理,不在此 |
| Lambda — CostAnalyzer (`lambda5_cost_analyzer`) | 512MB / 15min,每日 Cost Explorer 异常分析 |
| Lambda — CUR Finalizer (`lambda6_cur_finalizer`) | 256MB / 10min,CUR 首次交付后自动部署 Athena 集成。两个触发:`setup.sh` 建的 T+25h 一次性 EventBridge Scheduler(快速路)+ 常驻的 `notiops-cur-finalizer-selfheal` 每 4 小时一次(自愈:交付晚了、crawler 没爬完也能补上;已 `READY` 或根本没建 CUR 时一次 GetItem 就返回) |
| Lambda — Push Handler (`notiops-push-handler`) | 256MB / 60s,`shared.report_delivery.push_handler`,把 AWS 事件规范化后推到 IM 群。⚠️ 本版本推不出任何东西:发不发只看它自己的 `PUSH_TARGET_CHAT_ID`(钉钉是 `PUSH_TARGET_PLATFORM=dingtalk` + `DINGTALK_PUSH_WEBHOOK_URL[_ARN]`),而本栈与 `setup.sh` 都不设,所以每个事件只记一行「Push disabled」就返回(方式 A 根本不建这个函数);同样的事件在 Web 收件箱里照常可见(见下一行) |
| Lambda — Web Notif Handler (`notiops-web-notif-handler`) | 256MB / 60s,`shared.report_delivery.web_push_handler`,把同样的事件写进 `notiops-web-chat` 表的 `notif#` 段(Web Chat 站内收件箱);**两条部署路径都建**,共用 `infra/lib/constructs/web-notif-sources.ts` 这一份事件源定义 |
| Lambda — DevOps Callback (`devops_agent_callback`) | 256MB / 120s,跨账户拉一次长报告 → S3 + summary_card(DA 报告按上限确定性切一段,0 token,2026-09-05 起不调 Bedrock;`CardMode` 那一档的值仍叫 `BEDROCK`,只为兼容已落库的配置)→ 入 `invst#` 行 |
| Lambda — PHD Forwarder (`phd_event_forwarder`) | 128MB / 90s,AWS Health 事件 LLM 翻译,SNS 触发 |
| Lambda — IM ingress (`platforms/{feishu,slack,dingtalk}/lambda_ingress.py`) | 2048MB / 20s,只验签 + 幂等去重 + 异步 invoke worker;由 HTTP API 触发,`reservedConcurrentExecutions=10`。内存给到 2048MB 是为了压住冷启动 —— Lambda 的 INIT 阶段有 10s 硬上限(不受函数 timeout 约束),内存给小了 init 就会超时并挪到首次 invoke 里重跑,见 `infra/lib/constructs/im-core.ts` 里那段实测记录 |
| Lambda — IM worker (`platforms/{feishu,slack,dingtalk}/lambda_worker.py`) | 900s,真正处理消息 / 卡片回调,import `core/` |
| Lambda — IM progress (`notiops-im-progress`) | 512MB / 5min(`platforms.common.lambda_progress.handler`),每 1 分钟被 EventBridge 唤醒刷新调查进度卡 |
| ~~ECS Fargate — IM bots (`platforms/{feishu,slack,dingtalk}/app/`)~~ | ❌ 2026-09-03(M2)退役,不再创建。应用代码(`app/main.py`)与 Dockerfile 保留在仓库里作回滚路径,不被任何 app 引用;三家(含钉钉)现在都走上面那对 webhook Lambda |

> 另有 CDK 自管的 Custom Resource Lambda(如 seed-data 初始化配置)。

### DevOps Agent 集成

| 资源 | 说明 |
|------|------|
| Custom Event Bus | `notiops-devops-events`,接收业务账户跨账户转发的 `aws.aidevops` 事件(允许清单 + source 条件双重校验) |
| EventBridge (Callback) | Custom Bus → `devops_agent_callback` Lambda(带 DLQ + 重试) |
| SQS DLQ | DevOps Agent Callback 投递失败队列 |
| S3 (Onboarding) | 不是单独的桶,是共享数据桶的 `onboarding-templates/` 前缀。Web Chat「更多 → 管理 → 账户」的「手动接入账号」点「生成链接」时,BFF 把成员账号模板(`member-devops-agent.yaml`;跨组织接入另有 `member-account-onboarding.yaml`)按账号写到这个前缀下,再生成一个 12 小时有效的 Launch Stack 链接(`bff/web-chat/member_accounts.mjs::generateLaunchStackUrl`)。组织内的账号走 StackSets(「一键接入」),不经这里。手动接入时还要人做的只有两步:在成员账号里点链接部署,再把栈的 Outputs 回填到页面上 |

> 每个业务账户独立部署一个 AgentSpace(`AccountType=monitor`),不采用官方系统账户单一 AgentSpace 模式。这是刻意的架构决策:让每个业务账户各自持有 Agent 服务角色与信任边界,跨账户只经允许清单校验的事件回调聚合,避免单一共享 AgentSpace 成为跨账户权限的集中风险点。IM bot 默认的 `/agent devops` 与调查回调这条路径不依赖 AgentCore Runtime / Memory / Gateway;用户在 IM 里切到 `/agent notiops` 之后,worker 经 `bedrock-agentcore:InvokeAgentRuntime` 调用 Web Chat 那**同一个** AgentCore Runtime(见文首)。Web Chat 主入口则始终运行在 AgentCore Runtime 上。

### API 与调度

| 资源 | 说明 |
|------|------|
| Lambda Function URL(`notiops-web-chat-bff`) | Web Chat 的对外入口,`AWS_IAM` + SigV4(浏览器经 Cognito Identity Pool 拿临时凭证签名),SSE 流式。**整套系统已经没有 API Gateway REST API** —— 老的 Dashboard / MCP 后端 REST API 已于 2026-09-04 随老控制台一起退役 |
| EventBridge 定时规则 × 6(`NotiOpsBackendStack`) | cron 两条:`notiops-daily-cost-analysis` 01:15 UTC 成本异常分析、`notiops-daily-notification` 02:00 UTC 通知;rate 四条:`notiops-inspection-scheduler` 每 15 分钟、`notiops-inspection-push` 每 15 分钟、`notiops-inspection-reconciler` 每 1 小时、`notiops-cur-finalizer-selfheal` 每 4 小时(CUR 阶段二自愈)—— 具体巡检时刻与推送窗口存 DynamoDB,改时间不用重新部署。`ImStack` 的 ingress 保活(每平台一条,每 4 分钟)、进度轮询(每 1 分钟)与 `WebChatStack` 的 CUR 仪表盘预热(22:00 UTC,配了 CUR 数据源才建)不计在这 6 条里 |
| EventBridge (Health) | `aws.health` 事件规则 → PHD SNS Topic |
| SNS Topic | 闲置告警 / PHD 事件聚合(支持跨账号 Publish) |

### 前端托管

| 资源 | 说明 |
|------|------|
| S3 + CloudFront(`ChatCDN`) | Web Chat 前端 `frontend/chat-app` 的 React SPA,HTTPS CDN;站点桶私有,只经 CloudFront OAI 读(`infra/lib/constructs/web-chat-core.ts`) |
| S3 + CloudFront(`ReportsCDN`) | 在线报告分发。源是共享数据桶,靠一个 CloudFront Function 只放行 `reports/*`(其余前缀一律 403),供长报告与「深度调查」的报告链接用;缺它则退回 presigned URL |

### 服务清单

| AWS 服务 | 用途 |
|----------|------|
| DynamoDB × 5 | 后台 4 张(`NotiOpsBackendStack`):`notiops-conversations`(IM / 跨链路状态)+ `notiops-inspection`(资源巡检)+ `notiops-config`(配置 / 调查 / 成本单表)+ `notiops-metrics`(老 idle 巡检遗留);再加 Web Chat 的 `notiops-web-chat` 单表(`WebChatStack`) |
| Lambda × 10~11 | 业务计算:Notifier / CostAnalyzer / CurFinalizer / 巡检四个(scheduler + executor + reconciler + push)/ DevOpsCallback / PushHandler / WebNotifHandler / PHDForwarder(**默认建**,`-c skipPhd=true` / `ENABLE_PHD=false ./setup.sh` 时不建;没配飞书时它在调 Bedrock 之前就早退),另有 CDK 自管的 Custom Resource Lambda(seed-data / auto-onboard) |
| Lambda — IM (ImStack) | 每平台 ingress + worker 一对 + 进度轮询;ingress 由 HTTP API 触发收 webhook |
| ~~ECS Fargate + ECR~~ | ❌ 2026-09-03(M2)退役 —— IM 已全量走 Lambda,pricing/cost MCP sidecar 也随之下线(IM Lambda 侧显式 `AWS_MCP_PRICING_ENABLED=false` / `AWS_MCP_COST_ENABLED=false`) |
| API Gateway | **只剩 IM webhook 的 HTTP API**(每平台一个;方式 B 在 `ImStack`,方式 A 在单栈里由 `InstallOption` 选装)。老的 REST API(Dashboard / MCP 后端)已于 2026-09-04 退役 |
| Cognito | Web Chat 登录:User Pool `notiops-users`(禁自注册,两条部署路径同名同配置)+ Identity Pool `notiops-web-chat`(拿临时凭证去 SigV4 签 BFF Function URL);另有 `notiops-web-chat-rum` Identity Pool 供前端 RUM |
| S3 + CloudFront | `ChatCDN`:Web Chat 前端(私有桶 + OAI);`ReportsCDN`:在线报告(CloudFront Function 只放行 `reports/*`) |
| S3 | 调查报告(`investigations/<task_id>/report.md\|report.html\|trace.html`)+ Onboarding 模板 |
| EventBridge | **定时**:后台 6 条(巡检 scheduler / push 每 15 分钟 + reconciler 每 1 小时 + 成本分析 01:15 + 通知 02:00 + CUR 阶段二自愈每 4 小时)、CUR 仪表盘预热 1 条(22:00 UTC,配了 CUR 数据源才建)、IM ingress 保活(选了 IM 才建,每平台 1 条 / 每 4 分钟)与调查进度轮询 1 条(每 1 分钟)。**事件路由**:AWS Health → PHD SNS 1 条(**默认建**,`-c skipPhd=true` 可跳过)、DevOps Agent Callback 2 条(Custom Bus 与 default bus 各一条)、IM 主动推送 5 条(默认 **DISABLED**,没有 CDK context 开关、只能在 EventBridge 控制台里开;而且开了也推不出去 —— push handler 没有接推送目标,见上面「计算」表)、Web 通知收件箱 10 条(默认 5 开 5 关,清单见 `infra/lib/constructs/web-notif-sources.ts`) |
| SNS | 闲置告警 + PHD 事件聚合 |
| Custom Event Bus | DevOps Agent 跨账户事件聚合(`notiops-devops-events`) |
| SQS | DevOps Agent Callback DLQ |
| Secrets Manager | IM 凭据 + webhook secret + Bedrock/LiteLLM 配置 |
| SSM Parameter Store | LLM Provider 切换(`/notiops/llm/provider`)等 |
| Bedrock / LiteLLM Proxy | 后台 Lambda 里只有 PHD 翻译调模型(Lambda4 / Lambda5 / Callback 都不调);IM 侧是案例智能分析与建案时的服务分类。这两处都经 `shared/llm_provider.py` 跟随 SSM `/notiops/llm/provider` 切换。`/agent notiops` 的 IM 对话与 Web Chat 走 AgentCore Runtime 里的 agent,不经这一层 |
| AWS Knowledge MCP | bot 对话引用官方文档,hosted host `knowledge-mcp.global.api.aws` |

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | Python (Lambda) + boto3 |
| 数据层 | Amazon DynamoDB(5 表:后台 4 + Web Chat 1,单表设计 + GSI) |
| IM 机器人 | API Gateway HTTP API + Lambda webhook(每个平台一个 HTTP API + ingress/worker 一对,`ImStack`)。ECS Fargate 长连接(飞书 lark-oapi / Slack slack_bolt / 钉钉 Stream Mode)已于 2026-09-03 退役,只留源码 |
| 前端 | React 19 + TypeScript + Vite(`frontend/chat-app`,唯一的 Web 入口);UI 是自研组件,**不依赖 Cloudscape**(它随老 Dashboard 一起退役);图表 recharts,Markdown 渲染 react-markdown |
| IaC | AWS CDK (TypeScript)。**方式 B**(`infra/bin/app.ts`):2 个 Stack(`NotiOpsBackendStack` + `WebChatStack`),选了 IM 平台再多一个 `ImStack`;**方式 A**(`infra/bin/standalone.ts` → `infra/lib/notiops-webchat-standalone-stack.ts`):单栈(CDK stack id `NotiOps`),与 `WebChatStack` import 同一份 `infra/lib/constructs/web-chat-core.ts`,Web Chat 侧功能对等。**不需要 finch / docker** —— 唯一依赖容器构建的 `BotStack` 已退役 |
| 认证 | Amazon Cognito |
| AI | Amazon Bedrock(Converse API)+ LiteLLM Proxy(OpenAI 兼容,可选),`shared/llm_provider.py` 切换 |
| MCP | Web Chat agent 在 AgentCore Runtime 容器里把官方 awslabs MCP server 起成**进程内 stdio 子进程**:aws-pricing + billing-cost-management(`core/finops_mcp.py`)、cloudwatch + cloudtrail(`core/investigation_mcp.py`)、aws-api 只读兜底(`core/aws_api_mcp.py`)。官方文档检索走 hosted AWS Knowledge MCP(streamable HTTP,`core/aws_docs_mcp.py`)。`sidecars/` 下 pricing/cost 的 ECS sidecar 镜像已随 `BotStack` 于 2026-09-03 退役、只留源码作回滚;对外暴露工具的 `mcp_server/` 已随老 REST API 于 2026-09-04 删除 |
| 测试 | pytest + Hypothesis |

## 项目结构

```
.
├── core/                         # 平台无关共享代码（意图分类、对话、case、进度、i18n、MCP、ddb_state）
├── platforms/                    # IM 平台适配：lambda_ingress/lambda_worker（现役）+ app/ 长连接容器（已退役，留作回滚）
├── sidecars/                     # ⚠️ 已退役：ECS sidecar 镜像（随 BotStack 一起下线，留作回滚）
├── agent-build/                  # 现役 Web Chat agent 工程（NotiOpsWebChat：app/ 源码 + agentcore/ 打包配置）
├── agent/                        # Phase 1 的 agent 内核（Strands + AgentCore Runtime 入口 main.py + tools/）；现役部署走上面的 agent-build/
├── bff/web-chat/                 # Web Chat BFF Lambda（Node ESM .mjs，AWS_IAM Function URL + SSE）+ preset-skills/
├── inspection/                   # 资源巡检域逻辑（pipeline.py / domain / adapters / skills / data）
├── lambda_inspection_scheduler/  # 巡检调度（每 15 分钟 → SQS notiops-inspection-tasks）
├── lambda_inspection_executor/   # 巡检执行（SQS 消费，batchSize=1）
├── lambda_inspection_reconciler/ # 巡检对账（每 1 小时核实判读终态 + 查采集覆盖缺口）
├── lambda_inspection_push/       # 巡检结论推送（每 15 分钟醒一次，只在推送窗口投 IM 群）
├── lambda4_notifier/             # 定时推送每日汇总（巡检段 + 成本异常段 + 调查汇总）
├── lambda5_cost_analyzer/        # 每日成本异常分析（Cost Explorer）
├── shared/                       # 公共模块
│   ├── queries/                  #   DynamoDB 单表读写（metrics / config 各业务）
│   ├── report_delivery/          #   S3 单源报告管道 + 跨平台 sender（report_handler / push_handler）
│   ├── llm_provider.py           #   Bedrock ↔ LiteLLM 切换
│   ├── account_scope.py          #   跨账户锁定守卫（LOCKED_ACCOUNT_ID）
│   └── devops_agent.py           #   DevOps Agent 跨账户调用
├── devops_agent_callback/        # DevOps Agent 调查结果回调 Lambda
├── phd_event_forwarder/          # AWS Health 事件 LLM 翻译转发 Lambda
├── lambda6_cur_finalizer/        # CUR 首次交付后自动部署 Athena 集成（T+25h 一次性快速路 + 每 4 小时自愈）
├── frontend/chat-app/            # Web Chat 前端（React 19 + Vite）
├── infra/                        # CDK 基础设施（两条部署路径的栈与共享 construct，见下）
├── scripts/                      # 工具脚本（i18n lint / pre-commit / 部署与对等性断言 等）
├── docs/                         # 详细文档
└── tests/                        # 测试
```

`infra/` 里两条部署路径的落点:

| | 合成入口 | 栈 |
|---|---|---|
| 方式 B | `infra/bin/app.ts` | `lib/notiops-backend-stack.ts` + `lib/web-chat-stack.ts` + `lib/im-stack.ts`(选了 IM 才实例化) |
| 方式 A | `infra/bin/standalone.ts` | `lib/notiops-webchat-standalone-stack.ts`(单栈) |

两条路径共享 `infra/lib/constructs/`:`web-chat-core.ts`(Web Chat 全部资源)、`im-core.ts`(IM 三件套)、`minimal-base-core.ts`(方式 A 的最小底座)、`devops-callback.ts`、`web-notif-sources.ts`(通知事件源清单)。`lib/bot-stack.ts` 已退役、留作源码级回滚。
