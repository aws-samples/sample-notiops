# 接口参考

> 本文档描述 commit `6132f96` 时的接口面。
>
> 这里列的都是 NotiOps 的**内部**接口（浏览器 ↔ 后端、IM 平台 ↔ 后端），**不承诺稳定性**：
> 路由、请求体字段、响应形状都可能随任意一次发布变更，没有弃用期，也没有版本号。
> 它存在的目的是让运维和二次开发的人知道「哪个页面在打哪条路由」，
> 不是让外部系统照着集成。

## 0. 全景

NotiOps **没有 API Gateway REST API**。可达的接口面一共三处，另有三处非 HTTP 的事件入口：

| # | 接口面 | 载体 | 调用方 | 鉴权 |
|---|---|---|---|---|
| 1 | Web Chat BFF | **Lambda Function URL**（响应流式），函数 `notiops-web-chat-bff` | 浏览器里的 `frontend/chat-app` | Function URL `AuthType=AWS_IAM`（SigV4）**＋** Cognito id token，两道都必须过 |
| 2 | IM Webhook | **API Gateway HTTP API** + ingress Lambda，每个启用的平台一个 | 飞书 / Slack 平台侧回调 | API Gateway 层不鉴权；签名 / 加密校验在 ingress Lambda 内 |
| 3 | Agent Runtime | Bedrock AgentCore `InvokeAgentRuntime` | 仅 BFF，不对外暴露 | IAM |
| 4 | CUR 看板预热 | EventBridge cron → 直接 invoke BFF 函数 | EventBridge | IAM（不经 Function URL） |
| 5 | DevOps Agent 调查回调 | EventBridge 事件（`source = aws.aidevops`）→ `notiops-devops-callback` | AWS DevOps Agent | IAM（不是 HTTP webhook） |
| 6 | AWS 服务事件 → 通知收件箱 | EventBridge 规则（10 条，出厂开 5 条）→ `notiops-web-notif-handler` | AWS Health / CloudWatch / Cost Anomaly / Trusted Advisor / GuardDuty 等 AWS 服务 | IAM（不是 HTTP webhook） |

注意 #2 是 API Gateway **HTTP** API，与 REST API 是两个不同的产品；本仓库没有任何 REST API。

另有两个 CloudFront 分发属于**静态**面，不是 API：`ChatCDN`（发 `frontend/chat-app` 的构建产物
与运行时 `config.json`）、`ReportsCDN`（只放 `reports/*`，一个 viewer-request
CloudFront Function 把其它前缀一律 403）。

---

## 1. Web Chat BFF

### 1.1 端点形态与鉴权

- 实现：`bff/web-chat/index.mjs`（`awslambda.streamifyResponse`），各能力分散在同目录的 `*.mjs`。
- 运行时 nodejs24.x，超时 15 分钟（`infra/lib/constructs/web-chat-core.ts`）。
- 端点是 **Lambda Function URL**：`AuthType=AWS_IAM`、`InvokeMode=RESPONSE_STREAM`。不是 API Gateway。
- 鉴权两道，缺一不可：
  1. **SigV4** —— 前端用 Cognito Identity Pool 换到的临时凭证签名（`aws4fetch`，`service=lambda`）；
     调用方还需要 `lambda:InvokeFunctionUrl`。手点这个 URL 只会拿到 403。
  2. **Cognito id token** —— 放在 `x-notiops-id-token` 头（缺省时回落 `Authorization: Bearer …`），
     由 `bff/web-chat/jwt.mjs` 用 user pool 的 JWKS 验签，并校验 `exp` / `iss` / `token_use=id`。
- 授权（RBAC）：`bff/web-chat/authz.mjs` 按 `capabilities.json` 里每个能力节点声明的
  `{method, pattern}` 逐路由判定；两道判定都认不出的路由 fail-closed 403。
  「登录即可」有**两条来路，不是一条**：
  1. 命中带 `alwaysOn` 的能力节点。今天只有 `nav:chat` 是这一类，于是它名下的
     `/stream`、`/warmup`、`/features/deep-investigation` 对任何登录用户放行。
  2. 没有**任何**能力节点覆盖，才落到 `authz.mjs` 的 `LOGIN_ONLY` 后缀清单：
     `/conversations`、`/conversations/{id}`、`/accounts`、`/me/capabilities`、`/models`。
  顺序是刻意的 ——「先反查能力节点、找不到才查清单」。反过来的话，`/models$` 这条后缀
  会让 `DELETE /admin/roles/models` 一类**尾段碰撞**把特权路由遮蔽掉（`authz.mjs` 里
  记着这个实际发生过的案例；`$` 锚点只挡路径中段匹配，对尾段碰撞无效）。
  也因为这个顺序，`LOGIN_ONLY` 里那条 `/features/deep-investigation` 实际走不到 ——
  它已被 `nav:chat` 节点先接走，留着只是纵深。
  账号级可见性紧接着在 `index.mjs` 的同一道门里用 `account_visibility.mjs` 的
  `isAccountVisible()` 再收一次：`?account=`、`body.account_id`、`body.account`、
  `body.accounts`（数组）、以及 `body.key` 首段那 12 位账号号，**逐个**校验
  （不是 `||` 取第一个真值），任一不可见即 403。
- 基址：前端从运行时 `config.json` 的 `chatApiBase` 读，值就是 Function URL
  （形如 `https://<id>.lambda-url.<region>.on.aws/`）。`/api/chat` 只是本地开发时
  `VITE_CHAT_API_BASE` 未设置的回落值，部署产物里不会出现。
- **路由匹配是路径后缀**（`path.endsWith(...)`）加少量锚定正则，不是前缀路由表。
  所以下表列的是**后缀**，实际 URL = `chatApiBase` + 后缀。

### 1.2 对话与会话

| 方法 | 路径后缀 | 说明 |
|------|------|------|
| POST | `/stream` | 核心。SSE 流式对话；也承载「深度调查（直连）」与「DevOps 对话」两条 0-token 直连路径 |
| POST | `/warmup` | 预热 agent runtime（0 token，不写任何会话数据）。必须传与随后那一轮**相同**的 `conversation_id` |
| GET | `/conversations` | 我的会话列表（按当前可见账号集过滤） |
| GET | `/conversations/{id}` | 取会话消息 |
| PATCH | `/conversations/{id}` | `body.title` 重命名 / `body.pinned` 置顶 |
| DELETE | `/conversations/{id}` | 删除会话（含全部消息） |
| GET | `/me/capabilities` | 当前用户的可见能力子树 |
| GET | `/accounts` | 可见的 AWS 账号列表 + 部署信息 |
| GET | `/models` | 可选模型清单（`?surface=`，缺省 `webchat`） |
| GET | `/features/deep-investigation` | 深度调查开关可用性：必有 `available`；`false` 时附 `reason`，`true` 时附 `scope` 或（探测本身失败、按可用放行时）`probe_error` |

`POST /stream` 请求体（JSON）字段：`text`、`conversation_id`、`model`、`locale`（`zh` / `en`）、
`topic`、`account_id`、`web_search`、`finops_agent`、`devops_agent`、`deep_investigate_direct`、
`devops_chat_direct`、`skill_id`、`skill_version`。
`devops_agent` / `deep_investigate_direct` / `devops_chat_direct` 这三个开关前端是单选，
服务端再兜一层（防手搓请求同时开两个）：优先级 `deep_investigate_direct` >
`devops_chat_direct` > `devops_agent`，推导见 `index.mjs` 里的 `chatDirect` /
`directInvestigate`。唯一例外是「转人工支持」那个 followup ——
它会让本轮从直连退回计费的 agent 路径，并强制打开 `devops_agent`。

`model` 只当**意向**，服务端以 DDB 模型目录的启用集为准，被换掉时先发一条
`model_substituted`。

### 1.3 SSE 事件类型（`/stream` 响应）

`token`、`reasoning`、`thinking_step`、`progress`、`investigation_step`、`sources`、
`actions`、`followups`、`model_substituted`、`via`、`usage`、`done`。
语义与前端落点见 [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md) §2.4.4。

两点容易踩：

- 流里还有**注释行** `: ka`（每 10s 一次的保活）。按 `event:` / `data:` 取字段的解析器会自然忽略它；
  自己写解析器时不要把它当数据行。
- **没有 `error` 事件**。模型侧失败会作为普通 `token` 发一段带下一步建议的文案回来
  （原始报文只进 CloudWatch，不进界面，见 [LOGGING_STANDARD.md](LOGGING_STANDARD.md)）。

### 1.4 确定性数据端点（不经 LLM）

| 分组 | 方法与路径后缀 |
|---|---|
| 通知收件箱 | `GET /notifications`、`GET /notifications/unread`、`POST /notifications/read` |
| AWS Health | `GET /health/dashboard`、`GET /health/dashboard/count`、`GET /health/event?arn=` |
| FinOps | `GET /finops/dashboard`、`GET /finops/deep-dive?scenario=`、`GET /finops/tag-keys`、`GET /finops/tag-values`、`GET /finops/tag-cost` |
| CUR 看板 | `GET /cur-dash/cube`、`GET /cur-dash/credit`、`GET /cur-dash/extended-support`、`GET /cur-dash/sp` |
| 安全 | `GET /security/dashboard`、`GET /security/org-summary`、`GET /security/guardduty`、`GET /security/ta-check/{checkId}/resources` |
| 备份 / 告警 | `GET /investigate/backup`、`GET /investigate/alarms`、`GET /investigate/alarms/org-summary` |
| 生命周期 | `GET /lifecycle/eos`、`GET /lifecycle/eos/org-summary` |
| Support Case | `GET /cases/summary`、`GET /cases/org-summary`、`GET /cases/dashboard`、`GET /cases/trends`、`GET /support/services?language=`、`POST /actions/execute`（执行用户已确认的建案 / 回复 / 关单，严格按确认参数，不经 LLM） |

绝大多数端点接 `?account=` 选择目标成员账号，缺省 = 部署账号。

### 1.5 资源巡检

读侧：

| 方法 | 路径后缀 | 说明 |
|------|------|------|
| GET | `/inspection/overview` | 运行状态 + KPI；`?all=1` = 跨账号统一视图 |
| GET | `/inspection/findings` | 列表；`?kind=` 同时是**权限维度**（三个子页分权），故无默认值 |
| GET | `/inspection/finding` | 单条详情（`?id=`）；按 finding 自己的 kind 再复核一次授权 |
| GET | `/inspection/series` | 指标时序（`?region=&service=&instance=&metric=&stat=`） |
| GET | `/inspection/scope` | 排除清单 |
| GET | `/inspection/resources` | 资源清单（给排除清单勾选用） |
| GET | `/inspection/config` | 巡检配置（定时 + 判定阈值） |

写侧走独立的 `action:inspection:*` 能力，**不搭在** `nav:inspection` 上：

| 方法 | 路径后缀 | 说明 |
|------|------|------|
| POST | `/inspection/scope/{high\|idle}` | 加一条排除 |
| POST | `/inspection/scope/{high\|idle}/renew` | 续期（`body.key` + `body.days`） |
| POST | `/inspection/scope/{high\|idle}/delete` | 移出排除清单（用 POST 而非 DELETE：key 里带 `#`） |
| PUT | `/inspection/schedule/{high\|idle}` | 改巡检时刻 |
| PUT | `/inspection/rules/{high\|idle}` | 改判定阈值（与改时刻**分开**授权） |
| POST | `/inspection/run` | 手动跑一轮 |
| POST | `/inspection/judge` | 给一条 finding 单独派一次 DevOps Agent 判读 |

`/inspection/run` 与 `/inspection/judge` 是这一节里**两条直接花客户自己 DevOps Agent 额度**的端点，
所以它们共用同一个能力键 `action:inspection:run`（`capabilities.json` 里那个节点登记了两条 pattern）。
其余写端点只改配置，不触发判读。

**判定阈值不再有独立的配置 API**，由这里的 `/inspection/config` + `/inspection/rules/{kind}` 承载；
算法口径见 [pipeline-and-algorithms.md](pipeline-and-algorithms.md) 与
[cost-anomaly-algorithm.md](cost-anomaly-algorithm.md)。

### 1.6 Skills

| 方法 | 路径后缀 | 说明 |
|------|------|------|
| GET | `/skills` | 列表 |
| POST | `/skills` | 新建 / 覆盖（`skill_id` / `name` / `description` / `body` / `mode`） |
| GET | `/skills/{id}` | 取正文（`?version=` 指定版本，`?locale=` 取本地化正文） |
| DELETE | `/skills/{id}` | 删除 |
| GET | `/skills/{id}/exists` | 重名预检 |
| GET | `/skills/{id}/versions` | 版本列表 |
| POST | `/skills/{id}/rollback` | 回滚到指定版本 |
| POST | `/skills/import` | zip 导入（`body.zip_base64`） |
| GET | `/skills/devops-agent/targets` | 可发布的目标（本账号 + 已接入的成员账号） |
| POST | `/skills/{id}/devops-agent` | 发布到 DevOps Agent 的 Agent Space |
| DELETE | `/skills/{id}/devops-agent` | 从 DevOps Agent 撤下（`?account_id=`） |

格式规范见 [SKILL_FORMAT.md](SKILL_FORMAT.md)。

### 1.7 管理端（`/admin/*`）

整段由门禁要求管理能力。

**RBAC 与模块开关**

| 方法 | 路径后缀 |
|------|------|
| GET | `/admin/capabilities` |
| GET / POST | `/admin/roles` |
| DELETE | `/admin/roles/{name}` |
| GET / POST | `/admin/users` |
| PUT / DELETE | `/admin/users/{username}` |
| GET / POST | `/admin/groups` |
| PUT / DELETE | `/admin/groups/{name}` |
| GET / POST | `/admin/groups/{name}/members` |
| DELETE | `/admin/groups/{name}/members/{username}` |
| GET / PUT | `/admin/modules` |
| GET / PUT | `/admin/eol` |

**账号可见性**

| 方法 | 路径后缀 |
|------|------|
| GET | `/admin/account-access` |
| GET / PUT / DELETE | `/admin/account-access/{user\|group}/{id}` |

**成员账号接入**（`{accountId}` 必须是 12 位数字，否则路由不匹配）

| 方法 | 路径后缀 | 说明 |
|------|------|------|
| GET / POST | `/admin/member-accounts` | 列表（含 `orgListable` / `oneClickOnboard` 两个能力位）/ 一键接入 |
| GET | `/admin/member-accounts/status/{token}` | 接入进度 |
| GET | `/admin/member-accounts/da-status/{token}` | DevOps Agent 关联进度 |
| POST | `/admin/member-accounts/{accountId}/devops-agent` | 关联 DevOps Agent |
| PUT | `/admin/member-accounts/{accountId}/regions` | 只改采集 region，**不**下发 StackSet |
| PUT | `/admin/member-accounts/{accountId}/alias` | 只改显示名 |
| POST | `/admin/member-accounts/{accountId}/enable` / `/disable` | 启用 / 停用 |
| DELETE | `/admin/member-accounts/{accountId}` | 摘除 |
| GET | `/admin/member-accounts/{accountId}/inspection` | 跨账号巡检的前置状态 |
| POST | `/admin/member-accounts/{accountId}/inspection/launch-stack` | 采集角色模板的 Launch Stack URL |
| POST | `/admin/member-accounts/{accountId}/inspection/verify-role` | 真 AssumeRole 一次并在通过时登记 |
| POST | `/admin/member-accounts/{accountId}/inspection/associate` | 关联为巡检 space 的辅助来源 |
| POST | `/admin/member-accounts/{accountId}/launch-stack` | 跨 payer 接入模板（建 agent space + trigger role，与上面那个模板**不是**同一个） |
| PUT | `/admin/member-accounts/{accountId}/payload` | 跨 payer 手工回填 |
| POST | `/admin/member-accounts/{accountId}/test-connection` | 测试连接（可在保存前测） |

**LLM 配置**

| 方法 | 路径后缀 |
|------|------|
| GET / PUT | `/admin/llm-config` |
| GET | `/admin/llm-config/candidates` |
| PUT | `/admin/llm-config/bedrock-key` |
| POST | `/admin/llm-config/test` |
| POST | `/admin/llm-config/rollback` |
| GET | `/admin/llm-config/audit` |
| GET | `/admin/llm-config/status` |
| GET / PUT | `/admin/llm-config/backend-tasks` |

**其它**

| 方法 | 路径后缀 | 说明 |
|------|------|------|
| GET / PUT | `/admin/notification-config` | 飞书机器人推送配置 |
| POST | `/admin/notification-config/test` | 发一条测试消息 |
| POST | `/admin/skills/seed-presets` | 把 bundle 里的预置 skill 幂等写入 S3 |

> 方法 × 路由的**单一真源**是 `bff/web-chat/index.mjs` 的 handler 主体；
> 权限映射的单一真源是 `config/capabilities.json` —— `setup.sh` 把它 `cp` 进
> `bff/web-chat/capabilities.json`（Lambda 只打包后者），两份必须逐字节一致，
> 由 `tests/test_capabilities_parity.py` 守着。改能力节点要改 `config/` 那份。
> 两处都以代码为准。

---

## 2. IM Webhook（飞书 / Slack）

每个启用的平台建一个 **API Gateway HTTP API**，`$default` 路由 catch-all 打到该平台的
ingress Lambda（定义在 `infra/lib/constructs/im-core.ts`）：

| 平台 | 栈输出 | 端点形状 |
|---|---|---|
| 飞书 | `FeishuWebhookUrl` | `https://<id>.execute-api.<region>.amazonaws.com/` |
| Slack | `SlackWebhookUrl` | 同上 |

- **catch-all 是刻意的**：飞书的「事件订阅」与「卡片回调」、Slack 的 Events API /
  Interactivity / Slash commands 都填**同一个地址**，路径由平台自己决定，
  真正的分派在 `platforms/<platform>/lambda_ingress.py` 里。
- 结尾的 `/` 要保留（`$default` stage 不出现在路径里）。
- API Gateway 层**不做鉴权** —— IM 平台侧不会带 SigV4。校验在 ingress Lambda 内：
  - 飞书：`lark_oapi` 的 `EventDispatcherHandler.do()` 做解密 + 验签 + URL challenge；
    `encrypt_key` / `verification_token` 两把钥匙缺任何一把都会让请求变得可伪造，
    所以冷启动时读不到就直接 crash，绝不降级放行。
  - Slack：stdlib HMAC-SHA256 验 `X-Slack-Signature`，时间戳容忍窗口 5 分钟；
    signing secret 读不到就 `raise`。验签失败 → **401 空 body**（不做错误画像）。
- 公网未鉴权入口的闸门是阶段级限流（`throttlingRateLimit=50` / `throttlingBurstLimit=100`，
  超限直接 429、不进 Lambda）加 ingress 的 `reservedConcurrentExecutions=10`。
- ingress 收下即 ack，重活异步交给 worker Lambda。**飞书与 Slack 对 webhook 都是 ~3s 硬超时**
  （飞书的 `card.action.trigger` 还没有「再点一次」这个补救动作），而 ingress 冷启动会撞穿
  10s init 上限、端到端落到 ~22s（`im-core.ts` 里记着 2026-09-03 的实测值）。因此
  **每个启用的平台各有一条** EventBridge `rate(4 minutes)` 保活规则常驻打它自己的 ingress
  （`FeishuIngressKeepAlive` / `SlackIngressKeepAlive`）。
  progress 则是**两个平台共用一个** `ImProgress` 函数 + 一条 `rate(1 minute)` 规则
  （`ImProgressSchedule`），扫 `imtask#` 行、增量 PATCH 进度卡片。
- 平台控制台里具体填什么：[IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md)
  （English: [IM_WEBHOOK_SETUP.en.md](IM_WEBHOOK_SETUP.en.md)）；
  交互形式见 [im-bot-interaction.md](im-bot-interaction.md)。

钉钉走的是长连接（Fargate 常驻），**没有** webhook 入口；承载它的 `BotStack` 已于
IM 重构 M2 退役、不再实例化（`infra/bin/app.ts`）。当前 IM 侧只有 webhook 这一条路径。

---

## 3. Agent Runtime

不是 HTTP 接口，也不对外暴露。BFF 用 `@aws-sdk/client-bedrock-agentcore` 的
`InvokeAgentRuntimeCommand` 调 Bedrock AgentCore Runtime（`bff/web-chat/agentcore.mjs`）：

- `agentRuntimeArn` 取自 BFF 环境变量 `AGENT_RUNTIME_ARN`（部署时注入）。
  **未配置时 `/stream` 退化成回显**，不是报错 —— 排障时先看这个变量。
- `runtimeSessionId` 由 `conversation_id` 派生（≥33 字符，不足右侧补零）。
  AgentCore 按它路由到具体 microVM ——**预热与随后真实那一轮必须用同一个
  `conversation_id`**，否则预热等于白做。
- payload 是 JSON，响应是流式分片，由 BFF 翻成 §1.3 的 SSE 事件。
- agent 侧实现在 `agent-build/NotiOpsWebChat/app/NotiOpsWebChat/`。

---

## 4. 非 HTTP 的事件入口

这几条不经 Function URL、也不经 API Gateway，但确实是「外部能触发本系统」的入口，
排障时容易被漏掉。

| 入口 | 触发源 | 落点 | 说明 |
|---|---|---|---|
| CUR 看板预热 | EventBridge `cron(0 22 * * ? *)`（= 北京 06:00） | BFF 函数本体 | 事件体里 `source = notiops.curdash.warmup`，BFF 在**鉴权之前**按这个固定字面量分流；外部 HTTP 请求带不进这个字段 |
| DevOps Agent 调查回调 | EventBridge，`source = aws.aidevops` | `devops_agent_callback/handler.py` | 消费 7 个 detail-type（`Investigation Created` / `Completed` / `Failed` / `Timed Out` / `Cancelled` / `Linked` / `Skipped`），拉摘要 → 落 S3 → 回推原会话。清单的单一真源是 `infra/lib/constructs/devops-callback.ts` |
| AWS 服务事件 → 通知收件箱 | EventBridge，10 条规则各盯一个 `source` + `detail-type` | `notiops-web-notif-handler`（`shared.report_delivery.web_push_handler.lambda_handler`） | 写进 DDB 的 `notif#` 段，也就是 §1.4 那三条 `/notifications*` 读的东西。出厂**开** 5 条：Health / CloudWatch 告警 / Cost Anomaly / Trusted Advisor / GuardDuty；**关** 5 条：Backup / EC2 Spot / Auto Scaling / RDS / Config。规则名 `notiops-web-notif-<id 小写>`，清单的单一真源是 `infra/lib/constructs/web-notif-sources.ts` |

`source` / `detail-type` 写错一个字，规则就**永不触发且不报任何错**（这也是那张表必须是
单一真源、不许各栈各抄一份的原因）。两条部署路径共用同一张表，唯一差别是「怎么关掉某个源」：
方式 B 用合成期 `-c webNotif<Id>=off`，方式 A 在 EventBridge 控制台上 Disable 那条规则
（发布出去的静态模板没有 context）—— 默认开哪 5 个、规则叫什么名字，两边逐字相同。

---

## 5. 两条部署路径的接口面

**方式 A（一键 CloudFormation 单栈）与方式 B（`./setup.sh` + CDK 多栈）的 web / IM 功能必须一致**
是本项目的铁律，落实手段是两条路径共用同一份 construct：
`infra/lib/constructs/web-chat-core.ts`（BFF + Function URL + ChatCDN）与
`infra/lib/constructs/im-core.ts`（IM 三件套 + HTTP API）。
因此**本文列的每一条路由在两条路径上逐字相同**，不存在「只有某一条路径才有」的路由。

大部分差异只在**部署形态**上，不影响接口：

| 维度 | 方式 A | 方式 B |
|---|---|---|
| IM 平台开关 | 部署期 `CfnCondition`：`InstallOption` 参数**三选一**（`web` / `web+feishu` / `web+slack`） | 合成期布尔：`-c enabledPlatforms=…`（逗号分隔，**可以是 `feishu,slack`**） |
| IM / 回调 Lambda 物理名 | 带 `${AWS::StackName}-` 前缀（同账号可与 setup.sh 部署共存） | 写死 `notiops-im-*` / `notiops-devops-callback` |
| 栈输出 | **不输出** `ChatBffUrl` —— 客户不需要它，前端自己从 `config.json` 的 `chatApiBase` 读同一个值，手点它只会 403 | 输出 `ChatBffUrl`，给运维排障用 |
| DevOps 回调的事件总线 | **只有 default bus 那一条规则**（`DevOpsCallbackDefaultRule`），不建 custom bus | default bus **加** custom bus `notiops-devops-events` 两条规则 |

BFF 函数名两条路径都是 `notiops-web-chat-bff`；`ChatUrl`（Web Chat 前端地址）两条路径都输出。

第一行那个「三选一」有一处真实后果，写清楚而不是含糊过去：**方式 A 的一个栈里最多只有
一个 IM 平台的 HTTP API** —— 想让飞书和 Slack 同时在线，只能走方式 B
（`-c enabledPlatforms=feishu,slack`）。这**不是**「某条路由只有一边有」：两个平台的
ingress 与 webhook 定义都在 `im-core.ts` 里逐字同源，差的只是一次部署能不能把两套一起建。
方式 A 事后换平台的代价见 [DEPLOYMENT_ONECLICK.md](DEPLOYMENT_ONECLICK.md) §2.11
（`web+feishu` → `web+slack` 会删掉飞书那套，HTTP API 地址不保留，得回飞书后台重填）。

最后一行同样不含糊过去，把它的边界写清：本账号的 DevOps Agent 事件本来就发到
**default bus**，所以两条路径上**自己账号**的回调完全一样。custom bus
（`notiops-devops-events`，建在 `notiops-backend-stack.ts`，资源策略只认
`notiops-devops-forwarder-role-*` 且 `events:source = aws.aidevops`）是**成员账号把事件
转发过来**的落点 —— 方式 A 没有它，因此成员账号的调查回调没有落点。

这个缺口**是静默的**，所以必须写在这里：成员账号接入用的是仓里那两份静态模板
（`infra/member-account-onboarding.yaml` / `infra/member-devops-agent.yaml`），其中
`DevOpsEventBusArn` 是模板参数（留空 = 不建转发规则），值由 BFF 推导 ——
`member_accounts.mjs` 把总线名写成常量 `notiops-devops-events` 再拼成 ARN，
而 BFF 代码两条路径同源，推出来的值逐字一样。于是方式 A 下成员账号那条转发规则会指向一个
**不存在**的总线：CFN 建栈成功、EventBridge 侧投递失败，界面上只表现为
「那个账号的判读一直空着」。要跨账号回调就得走方式 B。
判据与理由写在 `infra/lib/constructs/devops-callback.ts` 的文件头
（它是那 7 条 detail-type 的单一真源）。

### 5.1 一处**响应内容**上的差异：每日成本异常卡

路由集合两边相同，但有一个能力节点在方式 A 上**不下发**。这是能力树的 `requiresEnv`
机制今天造成的**唯一**一处路径差异（`config/capabilities.json` 里带 `requiresEnv` 的节点共 5 个，
另外 4 个见本节末尾）。说清楚是哪一个、为什么：

| | 方式 A（一键 CFN） | 方式 B（setup.sh） |
|---|---|---|
| 能力节点 `nav:finops:daily-anomaly` | 不出现在 `GET /me/capabilities` 树里 | 正常出现 |
| `GET /finops/dashboard` 的 `dailyAnomaly` 顶层字段 | 不在响应里 | 在响应里 |
| 写侧 | 不装 `notiops-cost-analyzer` 及其定时规则 | 装 |

机制：`config/capabilities.json` 给该节点声明了 `"requiresEnv": "COST_ANALYZER_FUNCTION"`，
而 `web-chat-core.ts` 在静态模板（方式 A）路径上把 BFF 的这个环境变量置空 ——
变量为空 → 节点从能力树里消失 → 前端不渲染入口，`filterDashboard` 也把响应里那段摘掉。

这是**刻意的，而不是遗漏**：方式 A 的最小底座里没有任何东西在跑那个每日扫描，
把卡片留着只会让它恒显示「近 3 天没有扫描记录」—— 那才是静默降级。判据与理由写在
`config/capabilities.json` 该节点的 `_note` 里。

注意与它并排的另一张卡 `nav:finops:anomalies`（AWS Cost Anomaly Detection）**两条路径都有** ——
它是两套不同的引擎，只是需要客户自己先建异常监控器。同理，4 张 CUR sheet
（`nav:finops` 下 `requiresEnv: COST_AGENT_MCP_URL` 的那几个）在两条路径上都可用，
它们缺的时候是**客户没配自己的 CUR 数据源**，不是路径差异。

---

## 6. 已退役的接口

老的 idle-detector 管理控制台（`frontend/frontend-app`）及其 REST API（`api/`）已于 2026-09 退役
并从仓库删除，随之退役的还有运行时 `config.json` 里的 `idleConsoleUrl` 键（以及承载它的那条
跨栈传参 —— 它不是栈输出，而是 CDK 自动生成的 CFN Export）、前端 CDN，以及采集分析链
（`lambda1_collector` / `lambda2_analyzer` / `lambda3_health_checker`）与老工具 MCP（`mcp_server`）。

以下前缀**一条都不再存在**，任何仍在引用它们的文档、脚本或代码都是过期的：

`/api/dashboard/*`、`/api/waste-report*`、`/api/optimization-report*`、`/api/whitelist`、
`/api/threshold-config`、`/api/target-accounts`、`/api/ec2-underutilized*`、
`/api/rds-health-check*`、`/api/elasticache-health-check*`、`/api/health-check-whitelist*`、
`/api/pipeline/*`、`/api/notification-config*`、`/api/cost-anomaly/save`、
`/api/agent-config*`、`/api/devops-agent/*`、`/api/system-config/*`。

接替关系：

| 退役的 | 现在在哪 |
|---|---|
| 巡检报告 / 闲置与容量优化 / 阈值配置 | §1.5 资源巡检（`/inspection/*`） |
| 成员账号 / 目标账户 / DevOps Agent 多账户管理 | §1.7 `/admin/member-accounts/*` |
| Agent 模型 / LLM Provider / LiteLLM 配置 | §1.7 `/admin/llm-config*` |
| 定时推送通知配置 | §1.7 `/admin/notification-config*` |
| 成本异常读侧 | §1.4 `/finops/dashboard`（其中每日扫描那一段只在方式 B 下发，见 §5.1） |
| DevOps Agent 调查历史 | 会话内的报告链接（`ReportsCDN`），以及 §4 的回调链路 |

回归测试里有一条机械判据钉住这批目录不许复活（`tests/test_legacy_retired.py` —— `tests/`
不在开源发布清单内，只在内部仓库里）。之所以要专门钉一条：碎片式回归（一次 rebase 选错边、
一个老分支合进来）比整体回归更糟 —— 回来的那半套不会跑，但会重新出现在 import 图、
CI 目录清单和 IAM 面里。
