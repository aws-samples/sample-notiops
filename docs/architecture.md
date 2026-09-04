# 系统架构

> 本文是资源清单视角的系统架构。组件模型与数据流的权威说明见 [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md)。

NotiOps 以 **只读 Web Chat 控制台** 为主入口:浏览器里直接和 AWS 运维 agent(Strands / Bedrock **AgentCore Runtime**)对话,做调查 / FinOps / 案例 / Skills,经 **BFF Lambda + Function URL(SSE 流式)** 驱动,状态落 `notiops-web-chat` DynamoDB 单表,配 notif 收件箱 handler 与 **Cognito Identity Pool** 鉴权。作为必要补充,NotiOps 同时把 **AWS DevOps Agent**(`aidevops` API)接入企业 IM(飞书 / Slack / 钉钉),让用户在告警群里 `@bot 一句话` 也能调起调查、看实时进度、收本地化报告。系统还附带一条 **闲置资源 / 健康 / 成本** 的后台巡检流水线和一个 Web Dashboard。

数据层 **全部使用 DynamoDB**(后台 3 张核心表,另加 Web Chat 的 `notiops-web-chat` 单表),**没有任何 RDS / PostgreSQL / SQL**。**IM 机器人** 走 **API Gateway HTTP API + Lambda webhook**(`ImStack`:每平台一个 HTTP API + ingress + worker,worker 直接 `import core/`;旧的 ECS Fargate 长连接容器已于 2026-09-03(M2)退役、只作为源码级回滚路径留在仓库里),这条 IM 路径**不使用** AgentCore Runtime / Agent 容器;**Web Chat 主入口则相反** —— 它跑在 Bedrock **AgentCore Runtime** 上,经 BFF Lambda + Function URL(SSE)对外(见下方「部署栈」的 WebChatStack)。

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
│  EventBridge (5 条定时规则)                           ▼                                      │
│    ├─ 00:00 UTC ─▶ Lambda1-Collector (512MB/15min) ──异步──▶ Lambda2-Analyzer (512MB/15min) │
│    ├─ 00:30 UTC ─▶ Lambda3-HealthChecker (RDS)                                              │
│    ├─ 01:00 UTC ─▶ Lambda3-HealthChecker (ElastiCache)                                      │
│    ├─ 01:15 UTC ─▶ Lambda5-CostAnalyzer (512MB/15min)                                       │
│    └─ 02:00 UTC ─▶ Lambda4-Notifier ──▶ 飞书群(notify_chat_ids)                             │
│                                                                                              │
│  Lambda1/2/3/5 结果 ──▶ DynamoDB notiops-metrics / notiops-config              │
│  各 Lambda 的 AI 分析走 shared/llm_provider.py(Bedrock ↔ LiteLLM,SSM 切换)                │
│                                                                                              │
│  ── 路径 B：AWS Health 事件转发（PHD）──                                                     │
│                                                                                              │
│  EventBridge (aws.health) ──▶ SNS Topic ──▶ phd_event_forwarder Lambda (128MB/90s)          │
│  (可选跨账号) Linked Account EventBridge ──▶ 同一 SNS Topic                                  │
│  phd_event_forwarder ──LLM 翻译(shared/llm_provider)──▶ 飞书群(notify_chat_ids)            │
│                                                                                              │
│  ── 路径 C：IM 机器人（HTTP API + Lambda webhook，ImStack）──                                            │
│                                                                                              │
│  飞书 ──webhook──┐   ingress λ（验签+去重+异步投递）                                          │
│  Slack ──webhook─┤──▶ ─────────────────────────▶ worker λ (import core/)                     │
│  钉钉 ⏳ Phase 2（M2 拆掉 Fargate 后需要补 webhook 适配）│                                    │
│                           ├─ core.nl_router       确定性意图路由（0 token）                  │
│                           ├─ core.bedrock_intent  意图分类(只剩案例路径用)                  │
│                           ├─ core.bedrock_chat    通用对话 + AWS Docs MCP（仅回滚路径）      │
│                           ├─ core.webhook_dispatch HMAC 签名派发 DevOps Agent generic webhook│
│                           ├─ notiops-im-progress λ 轮询 aidevops:ListJournalRecords          │
│                           ├─ core.case_management  Support case 增删改查 + case_analyze      │
│                           ├─ core.ddb_state        读写 notiops-devops-conversations 表    │
│                           └─ MCP sidecar(127.0.0.1) ──▶ awslabs pricing / cost MCP server   │
│                                                                                              │
│  ── 路径 D：DevOps Agent 调查回调 ──                                                         │
│                                                                                              │
│  各业务账户：独立 AgentSpace + EventBridge Rule（跨账户 PutEvents）                          │
│                ──▶ 系统账户 Custom Event Bus: notiops-devops-events                    │
│                        └──▶ devops_agent_callback Lambda (256MB/120s)                        │
│                                ├─ AssumeRole 跨账户拉一次 long_report（ListJournalRecords）   │
│                                ├─ shared/report_delivery::build_investigation_report          │
│                                │    写 S3: investigations/<task_id>/report.md|html|trace.html │
│                                │    Bedrock 精简成 summary_card                               │
│                                └─ UPSERT notiops-config(invst#<task_id>)               │
│                                     只存 summary_card + S3 指针,不内联 summary_raw           │
│                                （报告卡发回发起会话的线程;调查类事件不推 notify_chat_ids）   │
│                                                                                              │
│  ── 路径 E：Web Dashboard ──                                                                 │
│                                                                                              │
│  React SPA (CloudFront + S3) ──▶ API Gateway ──▶ api Lambda (256MB/30s)                     │
│    └─ Cognito JWT 认证                                                                       │
│                                                                                              │
│  ── 路径 F：MCP Server（外部 Agent 集成）──                                                  │
│                                                                                              │
│  外部 Agent ──stdio──▶ mcp_server/server.py（21 工具：11 只读 + 2 触发 + 8 写）             │
│                                    └──HTTP──▶ API Gateway ──▶ api Lambda                    │
│                                                                                              │
│  ── 共享基础设施 ──                                                                          │
│                                                                                              │
│  DynamoDB × 3 │ S3（报告 + 前端 + Onboarding 模板）│ Secrets Manager │ SSM Parameter Store   │
│  SNS │ SQS DLQ │ Cognito User Pool │ Custom Event Bus                                       │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 部署栈

| Stack | 内容 |
|-------|------|
| `WebChatStack`(主入口) | Web Chat:Strands / Bedrock **AgentCore Runtime** agent + BFF Lambda(`notiops-web-chat-bff`)+ Function URL(`AWS_IAM`,SSE 流式)+ DynamoDB 单表 `notiops-web-chat` + notif 收件箱 handler + Cognito Identity Pool |
| `NotiOpsBackendStack` | 后台 Lambda(8 个业务 Lambda)+ DynamoDB × 3 + S3 + EventBridge + SNS/SQS + Cognito + API Gateway + Custom Event Bus + Onboarding 资源 |
| `ImStack`(选了 IM 才建) | **IM 的正式运行路径**:每平台一个 **API Gateway HTTP API**(公网入口,`$default` catch-all,阶段级限流 50 rps)+ 一对 Lambda —— ingress(平台签名校验 + `reservedConcurrentExecutions=10`)+ worker(900s)、共用依赖 Layer、事件去重表、进度轮询 Lambda。Outputs 里的 `FeishuWebhookUrl` / `SlackWebhookUrl` 就是要填进 IM 平台控制台的请求地址 |
| ~~`BotStack`~~ | ❌ **2026-09-03(M2)已退役,不再部署**。原来是 IM 的长连接实现:VPC + ECS Fargate Cluster + ECR(bot 镜像)+ 每平台一个 Fargate Service + MCP sidecar。`infra/bin/app.ts` 不再实例化它;`infra/lib/bot-stack.ts` 与三个 Dockerfile **故意留在仓库里**当源码级回滚路径(回滚要重建 VPC/ECS + 重新构建镜像,~20 分钟,见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §1.6)。它**没有任何 CFN Export**,所以删掉不会影响别的栈 |

部署唯一入口是 `./setup.sh`(交互式,内部编排 AgentCore Runtime 部署 + `cdk deploy --all`)。**没有 SAM,`deploy.sh` 已下线。**

## CDK 自动创建的资源

### 数据库（DynamoDB only）

| 表 | 键 | 说明 |
|------|------|------|
| `notiops-devops-conversations` | PK = `lookup_key` | IM ↔ DevOps Agent ↔ Lambda 的跨链路状态(event# / incident# / task# / progress# / push_dedup# / locale#…),TTL 自动清理,DeletionPolicy: Retain |
| `notiops-metrics` | PK / SK + GSI1 | 闲置 / 低利用率 / 健康巡检的指标与判定结果,TTL 自动清理 |
| `notiops-config` | PK / SK + GSI1 + GSI2 | 单表多业务配置与结果,DeletionPolicy: Retain |

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
| API Gateway HTTP API (ImStack) | IM webhook 的公网入口(每平台一个),`$default` catch-all + 未鉴权 + 平台签名校验;阶段级限流 50 rps / burst 100,ingress 侧 `reservedConcurrentExecutions=10`;详见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §4 |

> 后台 Lambda 与 IM 的 ingress / worker 都不入 VPC(直接走 AWS API),数据层是 DynamoDB,无需隔离子网托管数据库。

### 安全与认证

| 资源 | 说明 |
|------|------|
| Secrets Manager | IM 平台凭据(飞书 / Slack / 钉钉)+ DevOps Agent webhook secret + Bedrock API Key / LiteLLM 配置。DevOps Agent 业务账户配置存在 DynamoDB `da#<account_id>` 行,不用 Secret |
| Cognito User Pool | `notiops-users`,禁止自注册 |
| 跨账户锁定 | `shared/account_scope.py` 用 `LOCKED_ACCOUNT_ID = cdk.Aws.ACCOUNT_ID` 把后台采集 / 调查锁死在部署账户;AssumeRole 还校验 `trigger_role_arn` 账号 == 目标账号 |

### 计算

| 资源 | 说明 |
|------|------|
| Lambda — Collector (`lambda1_collector`) | 512MB / 15min,四阶段采集 + EC2 Trusted Advisor |
| Lambda — Analyzer (`lambda2_analyzer`) | 512MB / 15min,深度分析与判定 |
| Lambda — HealthChecker (`lambda3_health_checker`) | RDS + ElastiCache AI 巡检(Bedrock / LiteLLM) |
| Lambda — Notifier (`lambda4_notifier`) | 定时推送 + 健康巡检 critical 按账号触发调查（PHD 事件由独立的 PHD Forwarder 处理，不在此） |
| Lambda — CostAnalyzer (`lambda5_cost_analyzer`) | 512MB / 15min,每日 Cost Explorer 异常分析 |
| Lambda — API (`api`) | 256MB / 30s,Dashboard / MCP 后端路由分发 |
| Lambda — DevOps Callback (`devops_agent_callback`) | 256MB / 120s,跨账户拉一次长报告 → S3 + Bedrock 精简 summary_card → 入 `invst#` 行 |
| Lambda — PHD Forwarder (`phd_event_forwarder`) | 128MB / 90s,AWS Health 事件 LLM 翻译,SNS 触发 |
| Lambda — IM ingress (`platforms/{feishu,slack}/lambda_ingress.py`) | 128MB / 短超时,只验签 + 幂等去重 + 异步 invoke worker;由 HTTP API 触发,`reservedConcurrentExecutions=10` |
| Lambda — IM worker (`platforms/{feishu,slack}/lambda_worker.py`) | 900s,真正处理消息 / 卡片回调,import `core/` |
| Lambda — IM progress (`notiops-im-progress`) | 调查进度卡刷新 |
| ~~ECS Fargate — IM bots (`platforms/{feishu,slack,dingtalk}/app/`)~~ | ❌ 2026-09-03(M2)退役,不再创建。应用代码(`app/main.py`)与 Dockerfile 保留在仓库里作回滚路径;dingtalk 仍是 Phase 2,且 M2 之后接钉钉需要先写 webhook 适配 |

> 另有 CDK 自管的 Custom Resource Lambda(如 seed-data 初始化配置)。

### DevOps Agent 集成

| 资源 | 说明 |
|------|------|
| Custom Event Bus | `notiops-devops-events`,接收业务账户跨账户转发的 `aws.aidevops` 事件(允许清单 + source 条件双重校验) |
| EventBridge (Callback) | Custom Bus → `devops_agent_callback` Lambda(带 DLQ + 重试) |
| SQS DLQ | DevOps Agent Callback 投递失败队列 |
| S3 (Onboarding) | 业务账户 onboarding CFN 模板托管（桶已就绪；模板自动生成功能本期 deferred，当前用手工回填流程） |

> 每个业务账户独立部署一个 AgentSpace(`AccountType=monitor`),不采用官方系统账户单一 AgentSpace 模式。这是刻意的架构决策:让每个业务账户各自持有 Agent 服务角色与信任边界,跨账户只经允许清单校验的事件回调聚合,避免单一共享 AgentSpace 成为跨账户权限的集中风险点。IM bot 与调查回调这条路径不依赖 AgentCore Runtime / Memory / Gateway(Web Chat 主入口则运行在 AgentCore Runtime 上)。

### API 与调度

| 资源 | 说明 |
|------|------|
| API Gateway REST API | Dashboard + MCP 后端,Cognito JWT 认证 |
| EventBridge × 5 | 00:00 采集 / 00:30 RDS 巡检 / 01:00 ElastiCache 巡检 / 01:15 成本分析 / 02:00 通知 |
| EventBridge (Health) | `aws.health` 事件规则 → PHD SNS Topic |
| SNS Topic | 闲置告警 / PHD 事件聚合(支持跨账号 Publish) |

### 前端托管

| 资源 | 说明 |
|------|------|
| S3 + CloudFront | React SPA,HTTPS CDN |

### 服务清单

| AWS 服务 | 用途 |
|----------|------|
| DynamoDB × 3 | `notiops-devops-conversations`(对话 / 跨链路状态)+ `notiops-metrics`(巡检指标)+ `notiops-config`(配置 / 调查 / 成本 / 健康单表) |
| Lambda × 8 | 业务计算:Collector / Analyzer / HealthChecker / Notifier / CostAnalyzer / API / DevOpsCallback / PHDForwarder,另有 CDK 自管的 Custom Resource Lambda |
| Lambda — IM (ImStack) | 每平台 ingress + worker 一对 + 进度轮询;ingress 由 HTTP API 触发收 webhook |
| ~~ECS Fargate + ECR~~ | ❌ 2026-09-03(M2)退役 —— IM 已全量走 Lambda,pricing/cost MCP sidecar 也随之下线(IM Lambda 侧显式 `AWS_MCP_PRICING_ENABLED=false` / `AWS_MCP_COST_ENABLED=false`) |
| API Gateway | Dashboard / MCP 后端入口 |
| Cognito | Dashboard 认证 |
| S3 + CloudFront | 前端托管 |
| S3 | 调查报告(`investigations/<task_id>/report.md\|report.html\|trace.html`)+ Onboarding 模板 |
| EventBridge | 定时调度(5)+ Health 事件路由(1)+ DevOps Agent Callback(1) |
| SNS | 闲置告警 + PHD 事件聚合 |
| Custom Event Bus | DevOps Agent 跨账户事件聚合(`notiops-devops-events`) |
| SQS | DevOps Agent Callback DLQ |
| Secrets Manager | IM 凭据 + webhook secret + Bedrock/LiteLLM 配置 |
| SSM Parameter Store | LLM Provider 切换(`/notiops/llm/provider`)等 |
| Bedrock / LiteLLM Proxy | AI 分析(Lambda3/4/5/PHD/Callback + bot 对话);通过 `shared/llm_provider.py` 跟随 SSM `/notiops/llm/provider` 切换 |
| AWS Knowledge MCP | bot 对话引用官方文档,hosted host `knowledge-mcp.global.api.aws` |

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | Python (Lambda) + boto3 |
| 数据层 | Amazon DynamoDB(3 表,单表设计 + GSI) |
| IM 机器人 | API Gateway HTTP API + Lambda webhook(每个平台一个 HTTP API + ingress/worker 一对,`ImStack`)。ECS Fargate 长连接(飞书 lark-oapi / Slack slack_bolt / 钉钉 Stream Mode)已于 2026-09-03 退役,只留源码 |
| 前端 | React + TypeScript + Cloudscape |
| IaC | AWS CDK (TypeScript),2 个 Stack(WebChatStack + NotiOpsBackendStack);选了 IM 平台再多一个 ImStack。**不需要 finch / docker** —— 唯一依赖容器构建的 `BotStack` 已退役 |
| 认证 | Amazon Cognito |
| AI | Amazon Bedrock(Converse API)+ LiteLLM Proxy(OpenAI 兼容,可选),`shared/llm_provider.py` 切换 |
| MCP | hosted AWS Knowledge MCP + `sidecars/` 下 pricing/cost MCP sidecar;`mcp_server/` 对外暴露 21 工具 |
| 测试 | pytest + Hypothesis |

## 项目结构

```
.
├── core/                         # 平台无关共享代码（意图分类、对话、case、进度、i18n、MCP、ddb_state）
├── platforms/                    # IM 平台适配：lambda_ingress/lambda_worker（现役）+ app/ 长连接容器（已退役，留作回滚）
├── sidecars/                     # ⚠️ 已退役：ECS sidecar 镜像（随 BotStack 一起下线，留作回滚）
├── api/                          # API Lambda（Dashboard / MCP 后端路由分发）
├── lambda1_collector/            # 四阶段采集 + EC2 Trusted Advisor
├── lambda2_analyzer/             # 深度分析与判定
├── lambda3_health_checker/       # RDS / ElastiCache AI 巡检（Bedrock/LiteLLM）
├── lambda4_notifier/             # 定时推送 + 健康事件触发调查
├── lambda5_cost_analyzer/        # 每日成本异常分析（Cost Explorer）
├── shared/                       # 公共模块
│   ├── queries/                  #   DynamoDB 单表读写（metrics / config 各业务）
│   ├── report_delivery/          #   S3 单源报告管道 + 跨平台 sender（report_handler / push_handler）
│   ├── llm_provider.py           #   Bedrock ↔ LiteLLM 切换
│   ├── account_scope.py          #   跨账户锁定守卫（LOCKED_ACCOUNT_ID）
│   └── devops_agent.py           #   DevOps Agent 跨账户调用
├── devops_agent_callback/        # DevOps Agent 调查结果回调 Lambda
├── phd_event_forwarder/          # AWS Health 事件 LLM 翻译转发 Lambda
├── mcp_server/                   # MCP Server（server.py，21 个工具）
├── frontend/frontend-app/        # React Dashboard
├── infra/                        # CDK 基础设施（infra/lib：notiops-backend-stack.ts + bot-stack.ts + web-chat-stack.ts）
├── scripts/                      # 工具脚本（i18n lint / pre-commit 等）
├── docs/                         # 详细文档
└── tests/                        # 测试
```
