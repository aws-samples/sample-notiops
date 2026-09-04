# 系统架构图

本文用文字导航系统架构的 4 张视图，每张图回答一个具体问题。下面的「四张图导航」与「内容说明」两节完整描述了每张图的用途、读者与关键标注，无需额外的图形源文件即可理解系统架构;资源清单视角另见 [architecture.md](architecture.md),组件模型与数据流的权威说明见 [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md)。

---

## 四张图导航

| Tab | 图名 | 回答什么问题 | 读者 | 节点数 |
|----|------|-------------|------|-------|
| 1 | Executive 总览 | 这是个什么系统？用了哪些核心服务？ | 领导 / 客户 / 运维团队 / 新同事 | 19 |
| 2 | 系统账户逻辑视图 | IM 机器人（webhook + Lambda）与各业务路径如何编排汇聚？ | SA / 架构师 / 后端开发 | 34 |
| 3 | 跨账户拓扑 (IAM + Event) | 三账户之间的信任链和事件如何流动？ | 安全 / 架构师 | 26 |
| 4 | 请求时序图 (修正版) | 一次 IM 对话 / 调查回调从头到尾经过哪些组件？ | 开发 / Debug | 26 lifeline, 42 messages |

---

## 内容说明

### Tab 1: Executive 总览

**用途**：方案介绍开场 / 客户高层汇报。

**信息密度原则**：一眼能看清三账户关系 + 核心 AWS 服务。不展示实现细节（如 Lambda 具体函数、DynamoDB 表名）。

**配套文字说明**：左侧黄色便签解释系统用途和技术栈。

### Tab 2: 系统账户逻辑视图

**用途**：内部技术评审 / 后端编排介绍。

**关键标注**：
- IM 机器人(补充入口)是 **API Gateway HTTP API + ingress/worker Lambda**(`ImStack`,见 `im-core.ts`),worker 直接 `import core/` 处理确定性路由 / 对话,进度由 `notiops-im-progress` Lambda 每分钟刷；**这条 IM 路径不使用 AgentCore Runtime / Memory / Gateway / Agent 容器**。⚠️ 2026-09-03(M2)之前这里是常驻 **ECS Fargate** 进程,已退役、只留源码作回滚路径。主入口 Web Chat 则相反 —— 跑在 Bedrock **AgentCore Runtime** 上,经 BFF Lambda + Function URL(SSE)对外(见 WebChatStack,`web-chat-stack.ts`)
- 对话工具调用：`core.bedrock_chat` 通过 hosted AWS Knowledge MCP（`knowledge-mcp.global.api.aws`）检索官方数据（`sidecars/` 的 pricing / cost MCP 是 Fargate sidecar，随 `BotStack` 于 2026-09-03 一起退役；IM Lambda 侧显式关掉）
- 后台巡检与调查回调走 Lambda，结果落 **DynamoDB**（无 RDS）

**配套文字说明**：左侧黄色便签解释各路径分类（同步 + 异步）和配套资源角色。

### Tab 3: 跨账户拓扑 (IAM + Event)

**用途**：安全评审 / 跨账户架构讨论。

**关键标注**：
- ① System → Target（黄色粗线）：STS AssumeRole 只读采集
- ② System → Business（紫色粗线）：STS AssumeRole 触发调查
- ③ Business → System（紫色粗线）：Forwarder Role 跨账户 PutEvents 回调
- Bus Policy 白名单（红色框）：基于 `aws:SourceAccount` 的业务账户白名单

**架构决策**：每个业务账户独立部署 Agent Space（`AccountType=monitor`），不采用官方 `SourceAws` 共享模式。图中已明确标注此约束。

### Tab 4: 请求时序图 (修正版)

**用途**：开发调试 / 问题排查。

**分三段**：
- Part A（步骤 1-20）：IM 对话流程，含飞书流式卡片伪流式、`core.ddb_state` 条件写幂等去重（`event#` 行）、ingress → worker 的**异步 Lambda 投递**（M2 之前是 ECS 进程内异步）
- Part B（步骤 21-31）：DevOps Agent 调查的**两种触发路径**（IM 机器人 @bot 派发 + Lambda4 每日自动触发）
- Part C（步骤 32-42）：调查完成后的跨账户回调 + 拉一次 long_report → S3 单源（report.md / report.html + trace.html）+ Bedrock 精简 summary_card + 写 DynamoDB `invst#` 行

**当前架构关键点**（参见图右下方蓝色便签）：
1. IM 机器人(补充入口)是 webhook + ingress/worker Lambda(`ImStack`)，worker import `core/`，这条 IM 路径不使用 AgentCore Runtime;主入口 Web Chat 反之运行在 Bedrock AgentCore Runtime 上(WebChatStack)
2. 机器人派发走 `core.webhook_dispatch` → DevOps Agent generic webhook（HMAC 签名）
3. 跨账户调查与采集锁定在部署账户（`shared/account_scope.py`）
4. 飞书流式卡片伪流式 UX
5. Callback 写 DynamoDB `summary_card` + S3 指针，**不内联 summary_raw**；调查类事件**不推** notify_chat_ids（该机制保留给 PHD / Lambda4 日报）
6. Lambda4 定时自动触发分支

---

## 维护指南

日后系统架构发生变化时，按以下代码路径同步图表：

| 图表元素 | 对应代码路径 |
|---------|-------------|
| 各业务路径（定时 + 事件） | `infra/lib/notiops-backend-stack.ts`（EventBridge Rule + Lambda） |
| IM 机器人（webhook + Lambda） | `infra/lib/im-stack.ts` + `infra/lib/constructs/im-core.ts` + `platforms/{feishu,slack}/lambda_{ingress,worker}.py`（已退役的长连接版：`infra/lib/bot-stack.ts` + `platforms/*/app/main.py`） |
| IM Bot 去重/幂等 | `core/ddb_state.py`（`event#` 行条件写）+ 各平台 `lambda_worker.py` |
| 机器人派发 DevOps Agent | `core/webhook_dispatch.py` + `shared/devops_agent.py` |
| 对话工具调用（MCP） | `core/aws_docs_mcp.py` + `core/mcp_http_client.py`（`sidecars/` 已随 `BotStack` 退役） |
| LLM Provider 切换 | `shared/llm_provider.py` + `api/routes/system_config.py`（SSM `/notiops/llm/provider`） |
| 跨账户 AssumeRole + 锁定 | `shared/devops_agent.py::_get_cross_account_credentials` + `shared/account_scope.py`（部署账户锁定） |
| Callback 事件处理 | `devops_agent_callback/handler.py` |
| 报告管道（S3 单源 + summary_card） | `shared/report_delivery/report_handler.py::build_investigation_report` |
| Lambda4 健康告警触发 | `lambda4_notifier/handler.py::_trigger_health_investigations_per_account` |
| 数据存储（DynamoDB × 3） | `shared/queries/*.py` + `infra/lib/notiops-backend-stack.ts`（表定义） |
| 部署账户 AgentSpace / IAM | `infra/lib/notiops-backend-stack.ts`（业务账户 onboarding 模板生成见 `api/routes/devops_agent.py`，本期 deferred） |
| Web Chat（AgentCore Runtime + BFF + 前端） | `infra/lib/web-chat-stack.ts` + agent 运行时代码 + `frontend/chat-app/` |
