# NotiOps — 一键部署（CloudFormation，无需本地环境）

> ⚠️ **免责声明 / Disclaimer**：这是示例代码(sample code)，仅供学习与参考，**非生产就绪产品**。正式部署或承载生产工作负载前，请与贵组织的安全与法务团队一起，按你们的安全、监管与合规要求对其进行充分测试、加固与优化。
> _This is sample code, for non-production usage. You should work with your security and legal teams to meet your organizational security, regulatory and compliance requirements before deployment._

> 🌐 **Language**: [中文](DEPLOYMENT_ONECLICK.md) · [English](DEPLOYMENT_ONECLICK.en.md)
>
> **目标读者**：想先把 Web Chat 跑起来看看的人。**不需要**本地装任何东西，**不需要**创建 IAM 用户和 access key。
>
> **预期完成时间**：**~10 分钟**（其中开栈本身实测 ~4.5 分钟）。
>
> **配套文档**：
> - [DEPLOYMENT.md](DEPLOYMENT.md) — 完整部署手册（`setup.sh` 路径：IM bot、巡检及其看板、CUR/Athena 全量功能）
> - [USER_GUIDE.md](USER_GUIDE.md) — 部署完之后怎么用

---

## 0. 先搞清楚：两条部署路径，这篇讲哪一条

仓库里有**两条**部署路径，功能范围不同。这篇只讲第二条。

| | **`setup.sh`**（完整版，见 [DEPLOYMENT.md](DEPLOYMENT.md)） | **本篇：一键部署** |
|---|---|---|
| 你要准备什么 | git、Node、Python、uv、AWS CDK + 一份能部署的 AWS 凭证(**不需要 Docker/finch** —— IM 侧 2026-09-03 / M2 之后走 Lambda Layer,不再构建镜像) | **只要一个能登进 AWS 控制台的浏览器** |
| 怎么开始 | clone 仓库 → `./setup.sh` | 从 Release 下一个模板文件 → 在 CloudFormation 控制台上传 |
| 部署内容 | Web Chat + IM bot（飞书/Slack/钉钉，可以同时装多个）+ 每日巡检（含 Web 上的巡检看板）+ CUR/Athena FinOps 数据源 | **Web Chat**（聊天界面 + BFF + agent + DevOps Agent Agent Space；可选多账号）**+ 可选一个 IM 机器人**（飞书/Lark、Slack 或钉钉，见 [§2.11](#211-加装-im-机器人飞书larkslack-或钉钉)）**+ 可选的 CUR/Athena FinOps 数据源**（替你建，或接一张已有的，见 [§2.12](#212-可选接自己的-cur-数据源)） |
| 适合 | 长期使用、要 IM 推送和自动巡检 | 先试用 / 演示 / 只要浏览器里那个只读运维助手（想在群里 @ 它也可以） |

**两条路径可以先后走**：先一键部署试用（需要 IM 机器人的话直接在参数页选上，见 [§2.11](#211-加装-im-机器人飞书larkslack-或钉钉)），之后想要自动巡检（连同巡检看板）和主动推送，再按 [DEPLOYMENT.md](DEPLOYMENT.md) 跑 `setup.sh`。⚠️ 但同一账号同一区域里两条路径用的是同一套表 / 桶名，不能同时存在：要先把这个栈按 `DeleteEverything` 删掉（数据不会带过去，见 [§6](#6-删除这个栈)），或者把 `setup.sh` 装到另一个区域。

### 0.1 一键部署**不包含**什么

说清楚比事后惊讶好。下面这些**这条路径不部署**，需要 `setup.sh`：

- **往 IM 主动推送**：每日运维通知、AWS Health 事件推到飞书群 —— 这两样是 `setup.sh` 那条路径的报告流水线，而且只发飞书（告警类的实时事件推送这一版在两条路径上都不投 IM，见 [DEPLOYMENT.md §7](DEPLOYMENT.md#7-开启--调整-push-模式)）。IM 机器人本身**可以装**（见 [§2.11](#211-加装-im-机器人飞书larkslack-或钉钉)：你在群里 @ 它、它回你），但那是**被动应答**。（这 10 类信号源**会**进浏览器里的「通知」收件箱，见 [§2.9](#29-通知收件箱)；不进的只是 IM 群。）
- **同时装多个 IM 平台**：一键部署一个栈只装**一个**平台（飞书/Lark、Slack、钉钉三选一，见 [§2.11](#211-加装-im-机器人飞书larkslack-或钉钉)）；几个平台同时上要 `setup.sh`（在它的 IM 平台那一问里多选，如 `1,2,3`，即 `-c enabledPlatforms=feishu,slack,dingtalk`）。
- **每日自动巡检**（闲置资源检测、成本异常扫描）与它那 4 个 Lambda(`notiops-inspection-scheduler` / `-executor` / `-reconciler` / `-push`)以及成本异常扫描器 `notiops-cost-analyzer`。
- **巡检看板**（侧栏「更多 → 巡检」：巡检发现 → 高负载 / 闲置与成本；配置 → 巡检范围 / 阈值与定时）：
  页面代码是 chat-app 的一部分、两条路径共用，但一键部署既不建 `notiops-inspection` 表、也没有上面那 4 个巡检 Lambda，
  所以这个入口在一键部署上**根本不出现**（不是"点进去报错"）：`nav:inspection` 声明了 `requiresEnv: INSPECTION_TABLE`，
  一键部署把这个变量置空，「巡检」tab 连同全部子页就从 `/capabilities` 里摘掉了；直接调 `/inspection/*` 接口会拿到明确的 `inspection_not_deployed`。
  于是一键部署上「更多」里只剩你有权限的「技能」/「管理」；两样都没有权限的账号（预置角色里除了管理员和 `role:developer`，其余默认都是）
  连「更多」都看不到 —— 这是预期行为，不是部署坏了。要巡检看板，得走 `setup.sh`。
  （**Skills 管理界面不在此列** —— 一键部署照样建 Skills 存储桶，那个页面能用。）
- **跨账号的自动巡检与事件推送**：一键部署可以做**跨账号只读排查/调查/开案例**（`DeployMode=MultiAccount`，见 [§2.6](#26-可选多账号组织内跨账号)），但成员账号侧的 **CloudWatch OAM Sink** 与 **跨账号事件转发**（Health / DevOps Agent 调查事件回流）不在这条路径里 —— 那两样要 `setup.sh`。

（**DevOps Agent 深度调查**、**联网搜索**、**「通知」收件箱**都**不**在此列 —— 这三样都由这个栈自动建好，分别见 [§2.7](#27-深度调查aws-devops-agent)、[§2.8](#28-联网搜索agentcore-web-search)、[§2.9](#29-通知收件箱)。**IM 机器人**也不在此列，它是参数页上的一个选项，见 [§2.11](#211-加装-im-机器人飞书larkslack-或钉钉)。**CUR + Athena 账单明细**同样不在此列（v1.0.30 起）：参数页把 `ProvisionCur` 选成 `yes`，栈就替你建 CUR 和官方的 Athena 集成（AWS 首次交付最长 24 小时，在那之前成本问题走 Cost Explorer，就绪后自动切过去）；已经有 CUR 的话就接它的 Glue 表（`CurTable`，表要与本栈同账号、同区域）。两种都见 [§2.12](#212-可选接自己的-cur-数据源)。）

---

## 1. 前置条件（三条，都要满足）

### 1.1 一个能开栈的 AWS 账号 + 控制台权限

权限分**两段**看，实际卡住客户的几乎都是第一段（上传模板），不是第二段（开栈）。

#### ① 上传模板 —— 控制台 Create stack 的那一步

控制台会把你上传的模板先存进**你自己账号里**一个叫 `cf-templates-<随机串>-<区域>` 的桶。它不是 AWS 托管的桶，是你账号里的资源，所以这一步就需要建桶 + 写对象的权限：

| 动作 | 资源 | 干什么用 |
|---|---|---|
| `cloudformation:CreateUploadBucket` | `*` | 控制台专用 API，第一次上传时创建那个 `cf-templates-*` 桶 |
| `s3:CreateBucket` | `*` | 同上，桶建在你的账号里 |
| `s3:PutObject` | `*` | 把模板 JSON 写进去 |
| `s3:GetObject` | `*` | CloudFormation 回读模板 |
| `s3:ListBucket` | `*` | 判断桶里已有什么 |

> **这五条只能写 `Resource: "*"`**，别自己收窄到 `arn:aws:s3:::cf-templates-*` —— 桶名里的随机串是按账号 + 区域生成的，你事先写不出来；`CreateUploadBucket` 更是只有控制台会调、也只支持 `*`。
>
> **缺 `s3:PutObject` 时报错长这样**（真实客户反馈）：
> `User: arn:aws:iam::111122223333:user/alice is not authorized to perform: s3:PutObject on resource: "arn:aws:s3:::cf-templates-xxxxxxxx-us-east-1/2026-01-01T000000.000Zabc-notiops-webchat.template.json"`
>
> **不想加这五条权限也有退路**：先把模板传到一个你已有的 S3 桶，Create stack 时选 **Amazon S3 URL** 而不是 **Upload a template file**，填那个对象的 URL。这条路不需要任何新的 S3 权限。模板 430 KB 左右（随资源数逐版增长），远低于 S3 URL 方式的 1 MB 上限。

#### ② 开栈 —— 栈里的资源是用**你自己的身份**建的

这个模板**不带** CloudFormation 服务角色（stack service role）。CloudFormation 不会切换身份：模板里声明了 156 个资源（按参数选装的那些也算在内；默认参数下实际建 76 个，见 [§3](#3-这个栈建了什么)），建出来的每一个都是拿**你当前这个 IAM 身份**去创建的 —— 你的权限就是这个栈能建出来的上限。涉及的服务范围（这就是「服务范围」这个问题的答案；「个数」按模板里声明的算）：

| 服务前缀 | 这个栈要建什么 | 个数 |
|---|---|---|
| `cloudformation` | 栈本身（create / describe / rollback / delete） | 1 个栈 |
| `iam` | 角色 + 内联策略 + 托管策略；**还要 `iam:PassRole`** —— 把执行角色交给 Lambda / EventBridge / AgentCore 的动作也是你的身份在做 | 15 Role + 16 Policy + 1 ManagedPolicy |
| `lambda` | 函数、层、调用权限、Function URL | 15 Function + 2 Layer + 11 Permission + 2 Url |
| `logs` | 日志组；**另外还要 `logs:PutResourcePolicy`（资源写 `*`）** —— RUM 开了写 CloudWatch Logs | 15 LogGroup |
| `events` | 事件规则：「通知」收件箱 10 条事件源 + CUR 仪表盘每日预热；装 IM 时另有调查回调、进度刷新、入口保活（保活三个平台各一条，只建所选的那条）；`ProvisionCur=yes` 时另有 CUR 阶段二定时 | 17 Rule |
| `dynamodb` | 配置表、Web 聊天表（会话、消息与「通知」收件箱）；装 IM 时另有群会话表与用量表 | 4 Table |
| `s3` | 前端站点桶、产物（staging）桶、数据桶（Skills、报告）+ 桶策略；填了 `CurTable` 或选了 `ProvisionCur=yes` 时另有成本 MCP 的 Athena 查询结果桶（与①是同一个服务，但对象不同） | 4 Bucket + 4 BucketPolicy |
| `cloudfront` | 站点分发 + 函数 + OAI / OAC | 2 Distribution + 1 Function + 2 访问身份 |
| `cognito-idp` | 用户池、App client、8 个权限组 | 1 UserPool + 1 Client + 8 Group |
| `cognito-identity` | 身份池 + 角色映射（前端拿临时凭证签 SigV4 用） | 2 IdentityPool + 2 RoleAttachment |
| `apigateway` | IM 机器人的公网入口：每个平台一个 HTTP API，只建所选的那一个（HTTP API 也走 `apigateway:` 前缀） | 3 Api + 3 Integration + 3 Route + 3 Stage |
| `sqs` | 深度调查回调（把群里发起的调查报告送回群）的死信队列 + 队列策略，装 IM 时才建 | 1 Queue + 1 QueuePolicy |
| `rum` | 前端真实用户监控 | 1 AppMonitor |
| `bedrock-agentcore` | agent 运行时 + 会话记忆 | 1 Runtime + 1 Memory |
| `aidevops` | DevOps Agent 的 agent space 与关联（**IAM 前缀是 `aidevops:`**，不是 `devops-agent:`） | 1 AgentSpace + 1 Association |
| `athena` | 成本 MCP 专用的 workgroup（单次查询扫描量上限就设在它上面），填了 `CurTable` 或选了 `ProvisionCur=yes` 时才建 | 1 WorkGroup |

**不需要给你的身份**的服务：`organizations` / `securityhub` / `cur` / `oam` / `glue`。这几样只在多账号、安全态势看板、账单明细这些功能里用到，而且都是栈里的函数拿**它们自己的执行角色**去调的（多账号是 `StagerOrgSetup` 和它下发到成员账号的 StackSet，建 CUR 是 CUR 阶段一 / 阶段二那两个函数，其余是 BFF、agent 与成本 MCP）—— 不是你的身份。（这一点与 `setup.sh` 不同，见 [DEPLOYMENT.md §2.4](DEPLOYMENT.md#24-iam-部署权限)。）

> ⚠️ **说清楚一件事：这条路径的安装者实际上等于账号管理员。**
> 上面那张表里的 `iam:CreateRole` + `iam:PutRolePolicy` + `iam:AttachRolePolicy`（资源只能是 `*`，因为角色名带 CloudFormation 生成的后缀）在安全上等价于权限提升 —— 拿到这三条就能给自己造一个管理员角色。所以这里的「最小权限」只能是**收窄服务范围**（上表 16 个服务，而不是 `*`），**不可能**做到「让一个非管理员来安装」。
> 如果你们的规则不允许长期持有这种权限：用一个临时的安装身份装完，然后把它回收 —— 装完之后**日常使用 NotiOps 完全不需要任何 AWS 权限**，用户只在 Cognito 里登录。

> 开栈时必须勾选 **"I acknowledge that AWS CloudFormation might create IAM resources"** ——
> 这个栈要为 agent 和 BFF 建角色。

### 1.2 选好区域，并在该区域开通 Bedrock 模型访问

agent 跑在 **Amazon Bedrock** 上。**先去 Bedrock 控制台 → Model access，确认你要用的模型在这个区域是「Access granted」**，再来开栈。

- **默认模型是 Moonshot 的 Kimi K3**（`global.moonshotai.kimi-k3`）—— 这一个必须开通，否则装完不能用。
- 想用别的模型（Grok 4.7、GLM 5.3、Claude Sonnet 5.5 / Opus 5.5、DeepSeek、GPT-5.6 / GPT-6 Sol）就把对应的也一起开通；用户在输入框工具栏最右的模型选择器里按会话切换。⚠️ Claude Sonnet 5.5 / Opus 5.5 和 GPT-6 Sol 需要**每个账号单独接受一次 AWS Marketplace 协议**：有的账号里 Sonnet 5 能用、5.5 还没开通。最省事的是在这个账号里把 5.5 的协议接受一次；不接受的话，在 **更多 → 管理 → 模型** 页把 `claude-sonnet-5` / `claude-opus-5` 重新启用 —— **这只修好 Web**。IM 里的别名 `claude` / `opus` 属于 5.5 那两条，所以装了 IM 的话还要把 `claude-sonnet-5-5` / `claude-opus-5-5` 停用，并告诉群里的人用 `@bot model claude-sonnet-5` / `@bot model claude-opus-5` 切过去（已经设成 `claude` / `opus` 的会话届时回到默认模型）。GPT-6 Sol（IM 别名 `gpt_sol` 属于它）没开通的话：要么在这个账号里接受一次它的协议，要么在同一页把 `gpt-6-sol` 停用（已经设成 `gpt_sol` 的会话届时回到默认模型）。
- 推荐 **us-east-1** 或 **us-west-2**（Bedrock AgentCore 与模型覆盖最全）。
- 没开通模型访问时，栈会**开成功**、页面能打开、登录也没问题，但一提问就报 `AccessDeniedException`。这是最常见的"部署完了不能用"。

### 1.3 这个账号要能访问 GitHub（或者准备一个私有镜像）

部署过程中，栈里的一个 Lambda 会去 **GitHub Release** 下产物（前端、BFF、「通知」生产端、agent 代码这 4 个必下；IM 机器人的 2 个、成本 MCP 的 2 个、CUR 自建的 1 个只在选装了对应功能时才下，见 [§2.1](#21-下模板)）搬进你自己的 S3 桶。Lambda 默认不在 VPC 里、走 AWS 托管的公网出口，**绝大多数账号天然满足**。

企业环境如果**出口允许清单不含 github.com**，不必放弃这条路径 —— 见 [§7 无公网出口：用私有 S3 镜像](#7-无公网出口用私有-s3-镜像)。

---

## 2. 部署（5 步）

### 2.1 下模板

打开 [Releases](https://github.com/aws-samples/sample-notiops/releases) 页，从最新的 release 里下载：

```
notiops-webchat.template.json
```

同一个 release 里还有九个产物（`bff.zip` / `chat-dist.zip` / `web-notif.zip` / `agent-code.zip` / `im-code.zip` / `im-layer.zip` / `cost-mcp-code.zip` / `cost-mcp-layer.zip` / `cur-provisioner.zip`）——**不用下**，模板会让你的账号自己去取。模板里写死了这九个文件的 SHA256，下载后当场校验，不匹配就让开栈失败。

> 后五个是**按需下载**的：两个 `im-*.zip` 只有你在参数页选了带 IM 的安装选项时才会被下载（[§2.11](#211-加装-im-机器人飞书larkslack-或钉钉)）；两个 `cost-mcp-*.zip` 只有让本栈自建成本 MCP（填了 `CurTable` 或选了 `ProvisionCur=yes`）时才下载 —— 用 `CostAgentMcpUrl` 外接你自己的 MCP（[§2.12](#212-可选接自己的-cur-数据源)）不算；`cur-provisioner.zip` 只有 `ProvisionCur=yes` 时才下载。全按默认值部署（「只装 web」、`CurTable` 留空、`ProvisionCur=no`）时这五个都会跳过，不为它们付流量和存储。

> **为什么不是"点一下就开栈"的 Launch Stack 链接？** CloudFormation 的 `TemplateURL` 只接受
> S3 上的对象，不接受 GitHub 的 URL。所以这里多两步点击（下载 + 上传），换来的是我们
> **不托管任何东西**：产物只在 GitHub Release 上，代码进你账号的每一步都是你自己的凭证在动。

### 2.2 在 CloudFormation 控制台上传

1. 确认右上角**区域**是你在 §1.2 选好的那个。
2. **CloudFormation** → **Create stack** → **With new resources (standard)**。
3. **Choose an existing template** → **Upload a template file** → 选刚下的 `notiops-webchat.template.json` → **Next**。
   （控制台会把模板存进**你自己账号里**一个 `cf-templates-<随机串>-<区域>` 的桶 —— 它会替你建，但**用的是你的权限**，所以你得有 §1.1 ① 那五条动作。没有的话就改用 **Amazon S3 URL**，见 [§1.1](#11-一个能开栈的-aws-账号--控制台权限)。）

### 2.3 填参数

**Stack name** 填 `notiops`（下面的文档都按这个名字写；换名字也行，DynamoDB 表名固定为 `notiops-config` / `notiops-web-chat`，与栈名无关）。

只有**一个参数必填**：

| 参数 | 说明 |
|---|---|
| **Administrator email** | 你的邮箱。栈开完后 Cognito 会往这里发一封邮件，里面有**登录地址（ChatUrl）+ 用户名 + 临时密码**。必须是真实可收的邮箱 —— **这是唯一的入口**。 |

其余都有安全的默认值，第一次部署**建议全部不动**：

| 参数 | 默认 | 什么时候才需要改 |
|---|---|---|
| **What to install** | `web` | 下拉四选一：`web`（只装浏览器里的聊天界面）/ `web+feishu`（再加一个飞书/Lark 机器人）/ `web+slack`（再加一个 Slack 机器人）/ `web+dingtalk`（再加一个钉钉机器人）。**四个选项都装 web** —— IM 是加装项，不是替代项。选了带 IM 的还要在 IM 平台侧配几步，见 [§2.11](#211-加装-im-机器人飞书larkslack-或钉钉)。**部署完也能改**（update 栈换个值即可，见 §2.11）。 |
| **Give the agent account-wide read-only access?** | `Yes` | 选 `Yes` 会给 agent 挂上 AWS 托管的 `ReadOnlyAccess`，于是它能回答这个账号里任何资源的问题。选 `No` 则只保留精选的只读授权（成本、日志、指标、RDS/EC2 describe），有些问题会答不了并明确告诉你缺哪条 action。**两种选择都不给任何写权限。** |
| **Two-step verification at web sign-in** | `OPTIONAL` | 网页登录的两步验证（验证器 App）：`OPTIONAL` 每个人自己在菜单里开、「管理」页要求先开；`REQUIRED` 所有人下次登录时必须绑定；`OFF` 只用密码。部署完也能改（update 栈换个值），IM 机器人不受影响。见 [§8](#8-安全说明值得知道的几条) 第 7 条。 |
| **CORS allowed origins** | `*` | 接口本身已经是 `AWS_IAM`（SigV4）鉴权，`*` 不构成越权。想再收一层，可以在第一次部署完之后 update 栈、把它设成 `ChatUrl` 那个地址。 |
| **IM chat/channel allow list (optional)** | 空 | 只有装了 IM 才有意义（[§2.11](#211-加装-im-机器人飞书larkslack-或钉钉)），只装 web 可以完全不管。填逗号分隔的飞书 chat id（`oc_...`）、Slack channel id（`C...`）或钉钉 `conversationId`（在群里 @ 一句后从 worker 日志里拿），**不能有空格**；留空 = 不限制，机器人被拉进的任何群都答。三个平台共用这一个参数。它是 IM 入口的一道纵深防御（[§8](#8-安全说明值得知道的几条) 里的第 ③ 道）：清单外会话的消息会在**任何模型调用之前**被丢弃 —— 飞书/Slack 在入口函数就拦（即使验签被绕过也拦得住），钉钉的 `conversationId` 要**验签之后**才解得出来，所以它落在 worker 那一层拦。**正常节奏是先留空部署 → 建群拿到 chat id → 再 update 栈填进去**，所以它归在 `Security` 组、不在必填项里。与 `setup.sh` 路径的 `imAllowedChatIds` 等价（那边写进 `infra/cdk.json` 的 `context`，见 [IM_WEBHOOK_SETUP.md §4](IM_WEBHOOK_SETUP.md#4-群允许清单allowlist可选三个平台都支持)）。 |
| **On stack delete** | `KeepData` | 决定删栈时你的数据怎么办。见 [§6 删除](#6-删除这个栈)——**改这个值有个坑，删栈前先读那一节**。 |
| **Deployment mode** | `SingleAccount` | 想让它同时看组织里**其它**账号，就选 `MultiAccount` 并填下面的 org id。`MultiAccount` 要求这个账号是 **AWS Organizations 管理账号**，或是一个已注册的 **StackSets 委派管理员**成员账号（自动探测，不用填参数）—— 选之前先跑 [§2.6.1](#261-硬性前置管理账号或-stacksets-委派管理员) 那几条命令确认一下。不满足的话栈会在第一分钟内失败并告诉你怎么办。 |
| **AWS Organizations id (MultiAccount only)** | 空 | 只有选了 `MultiAccount` 才填（`o-` 开头）。**只填一半不生效**（选了 MultiAccount 但 org id 留空 = 仍是单账号），Outputs 的 `DeployModeStatus` 会告诉你。填**错**一个合法但不属于本账号的 org id 会被栈里的前置检查当场拦下（否则它会被烧进成员账号信任策略，之后每个账号接入都 AccessDenied 而看不出原因）。 |
| **Enable AWS DevOps Agent features (deep investigation, DevOps Chat)?** | `Yes` | 一个开关管**四样**能力，见 [§2.7](#27-深度调查aws-devops-agent)。闲置不计费，所以默认开着；不想要就选 `No`（那四样会置灰）。 |
| **Optional: your own CUR data source** 那一组 | 空 / `no` | 想要账单明细级的成本分析时才动：`ProvisionCur=yes`（控制台上叫 **Let NotiOps create the CUR for you?**）让栈替你建 CUR；已经有 CUR 就填 `CurTable` + `CurBucketName`（表和桶都要与本栈同账号、同区域）；已经有自己的 cost-agent MCP 就填 `CostAgentMcpUrl` + `CostAgentFunctionArn`。三种只能选一种，见 [§2.12](#212-可选接自己的-cur-数据源)。`CurRoleArn`（CUR 在别的账号）这一版还不支持，留空。 |
| **Artifact base URL override** / **Artifact mirror bucket name (s3:// only)** | 空 | 只有拿不到 GitHub 时才填，见 [§7](#7-无公网出口用私有-s3-镜像)。 |

### 2.4 勾 IAM 确认框，开栈

**Next** → 到最后一页勾上 **"I acknowledge that AWS CloudFormation might create IAM resources"** → **Submit**。

**实测耗时约 4.5 分钟**（两次独立测量：4m16s / 4m25s，us-east-1，默认的「只装 web」）。中途你会看到栈在等两个
`Custom::NotiOpsStager…` 资源 —— 那是它在把 ~165 MB 产物从 GitHub 搬进你的 S3 桶、
解压前端、写运行时配置、建管理员用户。选了带 IM 的安装选项会再多搬两个 IM 产物、多建 4 个 Lambda（入口 / 干活 / 进度刷新 / 调查回调，半分钟量级）。

### 2.5 登录

栈变 **CREATE_COMPLETE** 后，去 **Outputs** 页：

| Output | 是什么 |
|---|---|
| **ChatUrl** | 聊天界面地址（CloudFront）。**打开这个。** |
| **LoginUsername** | 登录用的账号名，固定是 `admin` |
| **LoginPassword** | 初始密码**在哪**（不是密码本身，见下面的说明） |
| **NextSteps** | 一句话的登录指引 |
| **InstalledRelease** | 这个栈当前装的是哪个 release |
| **DataRetentionOnDelete** | 当前 `TeardownMode` 下，删栈会对数据做什么 |
| **WebChatTableName** | 存聊天历史与通知的 DynamoDB 表名（想自己查数据、或删栈后手工清理时用） |
| **DeployModeStatus** | 单账号还是多账号**实际生效**的那个。选了 `MultiAccount` 却忘了填 org id，这里会明说"仍是单账号"。 |
| **DeepInvestigationStatus** | 深度调查是开着、你自己关了、还是**因为这个区域没有 AWS DevOps Agent 被跳过**。 |
| **DevOpsAgentSpaceId** | 深度调查开着时才有：栈给你建的 Agent Space id。 |
| **WebSearchStatus** | 这个区域**支持不支持**联网搜索（不是 us-east-1 就整块跳过，见 [§2.8](#28-联网搜索agentcore-web-search)）。 |
| **WebSearchProvisioning** | 区域支持时才有：Gateway **到底建成了没有**。`enabled` = 开关可用；`unavailable (<错误码>)` = 建失败，开关点了没结果（栈本身照样成功，见 [§2.8](#28-联网搜索agentcore-web-search)）。 |
| **FeishuWebhookUrl** | 只有选了 `web+feishu` 才有：要粘到飞书开放平台的请求地址（[§2.11](#211-加装-im-机器人飞书larkslack-或钉钉)）。 |
| **SlackWebhookUrl** | 只有选了 `web+slack` 才有：要粘到 Slack App 的三处 Request URL（[§2.11](#211-加装-im-机器人飞书larkslack-或钉钉)）。 |
| **DingtalkWebhookUrl** | 只有选了 `web+dingtalk` 才有：要粘到钉钉开放平台「机器人 → 消息接收模式 → HTTP 模式」的消息接收地址（[§2.11](#211-加装-im-机器人飞书larkslack-或钉钉)）。 |
| **ImNextSteps** | 只有装了 IM 才有：一句话说明你还差哪几步（凭证 + 请求地址）。**两步都做完机器人才会说话。** |

邮件里那个链接就是 `ChatUrl`（和上面这张表里的 `ChatUrl` 是同一个地址，不用两边对），用：

- **用户名：`admin`**（不是邮箱；邮箱也能登，它被配成了别名）—— 也就是 Outputs 里的 `LoginUsername`
- **密码**：邮件里的临时密码，首次登录会要求你改成新密码

> 🔒 **为什么 Outputs 里没有初始密码？** 两个原因，都不是"忘了做"：
> 1. **这个栈根本没有这个密码。** 建管理员时它不传 `TemporaryPassword`，密码由 Cognito
>    自己生成并直接邮件下发（`infra/lambda/stager/index.py` 的 `_create_admin`），
>    栈里无处可取。
> 2. **就算取得到也不能放。** CFN 的 Output 是**明文**的：任何拿到
>    `cloudformation:DescribeStacks` 的人（`ReadOnlyAccess` 就含这一条）都能读到，
>    而且会长期留在 CloudFormation 的 API / 控制台历史里 —— 你后来改了密码，那份记录也删不掉。
>
> 所以 `LoginPassword` 这个 Output 给的是**去哪拿**，不是密码本身。
> （`setup.sh` 那条路径在终端里直接打印初始密码是另一回事：那是本地一次性输出，
> 不落任何能被别人查询的 AWS API。）

> 📧 **收不到邮件？** 发件人是 `no-reply@verificationemail.com`（Cognito 默认发信），
> 主题 `Your NotiOps sign-in details`。**企业邮箱常常给它打上 `[EXTERNAL]` 标记或直接丢进垃圾邮件**
> —— 先翻垃圾箱。实测在 us-east-1 从栈完成到收信约 1 分钟。
>
> 真的丢了：Cognito 控制台 → 该 user pool → Users → `admin` → 重设密码。

登录后建议先问一句 `列出这个账号里的 EC2 实例` 之类的，确认 agent 真的能答（顺便验证 §1.2 的模型访问）。

> 🔐 **两步验证**：参数保持默认 `OPTIONAL` 时，第一次点「更多 → 管理」会先要求你开启两步验证（用验证器 App 扫一个二维码、输入 6 位验证码，一分钟的事）。选了 `REQUIRED` 的话，改完初始密码紧接着就要绑定。见 [§8](#8-安全说明值得知道的几条) 第 7 条。

### 2.6 （可选）多账号：组织内跨账号

默认的 `SingleAccount` 只看部署它的这个账号。想让它同时看组织里其它账号，开栈时把 **Deployment mode** 选成 `MultiAccount` 并填 **AWS Organizations id**。

#### 2.6.1 硬性前置：管理账号，或 StackSets 委派管理员

> `MultiAccount` 接受**两种**部署身份，二者之一即可：
> 1. **AWS Organizations 管理账号（payer）**；
> 2. 一个已在管理账号里注册成 **CloudFormation StackSets 委派管理员**的成员账号（linked account）—— 怎么注册见下面 [2.6.2](#262-从成员账号部署注册-stacksets-委派管理员)。
>
> **不用填任何参数来区分这两种身份** —— 栈会自己探测。两种都不是的话，栈会在**第一分钟内**失败，并在失败原因里给出注册命令与管理账号号（不会先建一百多个资源再全量回滚）。

**开栈前先跑这两条**，几秒就能判断这个账号够不够格：

```bash
aws organizations describe-organization \
  --query 'Organization.[Id,MasterAccountId]' --output text
aws sts get-caller-identity --query Account --output text
```

- 第一条的**第二列**（`MasterAccountId`）== 第二条的输出 ⇒ 这就是管理账号，可以选 `MultiAccount`。
- 两者**不等** ⇒ 这是成员账号。那就再跑一条，看它是否已经是 StackSets 的委派管理员：

  ```bash
  aws organizations list-delegated-administrators \
    --service-principal member.org.stacksets.cloudformation.amazonaws.com \
    --query 'DelegatedAdministrators[].Id' --output text
  ```

  输出里**有**本账号号 ⇒ 可以选 `MultiAccount`。没有 ⇒ 三条路：按 [2.6.2](#262-从成员账号部署注册-stacksets-委派管理员) 注册一下、把模板开到管理账号里去、或者本次选 `SingleAccount`（Web / IM / 深度调查 / 开案例全都照常，只是没有一键接入；用「手动接入账号」接进来的账号照样能在 Web 上用「深度调查」/「DevOps 对话」去查，见 [DEPLOYMENT.md §0.1.2](DEPLOYMENT.md#012-部署模式单账号默认-vs-多账号---multi-account)；「生成链接」要先传一份模板，见下面 🔴 那条）。
  ⚠️ 这条命令**必须带 `--service-principal`**。不带的话你会看到组织里**所有**服务（GuardDuty / Config / Security Hub …）的委派管理员，那些账号也拿得到 Organizations 只读权限，但它们**不能**操作 StackSet —— 照着那份清单判断会得到"应该行"然后在建 StackSet 时才 `AccessDenied`。
- 第一条报 `AWSOrganizationsNotInUseException` ⇒ 这个账号根本不在任何组织里，只能 `SingleAccount`。
- 第一条报 `AccessDeniedException` ⇒ 基本是 SCP 拦了 `organizations:DescribeOrganization`；不解掉的话栈里的检查也读不到，同样过不去。

> 🔴 **一条与身份无关的硬限制**：CloudFormation **从不**把 service-managed StackSet 下发到**组织管理账号本身** —— 即使把它所在的 OU 设成目标，`CreateStackInstances` 也会返回 SUCCEEDED 而什么都不建（一次静默的假成功）。实际只有**从委派管理员部署**时会碰到它（从管理账号本身部署时，它就是部署账号，什么都不用做）：管理账号在 Web 的**更多 → 管理 → 账户**页里是普通一行，但没有一键接入按钮。要让 NotiOps 查它，**只用**同一页的「手动接入账号」一条路：「生成链接」→ 用管理账号登录、部署那个栈 → 回填 Stack Outputs →「测试连接」→「保存并激活」；跨账号采集角色（只读，默认另带 Support 工单的开 / 回复 / 关闭权限，由成员模板参数 `EnableSupportCaseWrite` 控制）由这个栈一并建好。
>
> - **别再**手工部 [`infra/member-account-onboarding.yaml`](../infra/member-account-onboarding.yaml)：它建的是同名的采集角色（`notiops-idle-detection-role-<部署账号ID>`），两个都部会 `EntityAlreadyExists`、整栈回滚。管理账号里已经部过它的话，在 quick-create 页上把 `CreateCollectionRole` 改成 `no`；那个栈建了事件转发的话（它的 `DevOpsEventBusArn` 参数非空），同一页上的 `DevOpsEventBusArn` 也清空 —— 两个栈的转发规则名字不同、不会报错，但会同时转发同一批调查事件。
> - ⚠️ 一键部署**不会**把「生成链接」要用的模板放进数据桶，不先传一份的话，点「生成链接」只会报 `template not found`（对任何账号都一样）。在部署账号里，把与栈同一版本（看 Outputs 的 `InstalledRelease`）的 [`infra/member-devops-agent.yaml`](../infra/member-devops-agent.yaml) 传上去：
>
>   ```bash
>   aws s3 cp member-devops-agent.yaml \
>     s3://notiops-data-<账号ID>-<区域>/onboarding-templates/member-devops-agent.yaml
>   ```

**org id 填第一条输出的第一列**（`o-` 开头）。填错的后果特别不直观：它会被烧进成员账号信任策略的 `aws:PrincipalOrgID`，之后每个成员账号接入都 `AccessDenied`，而现场完全看不出是 id 抄错了。所以栈里的检查会**顺手核对**你填的 id 与本账号真实所在组织是否一致，不一致就直接报错并把正确值告诉你。

**两个都要填。** 只选了 `MultiAccount` 但 org id 留空，栈会**照样开成功、但仍是单账号** —— 这是故意的：org id 是跨账号信任策略里 `aws:PrincipalOrgID` 那道收口条件，没有它，成员账号里的角色就只是"信任系统账号 root"而没有组织边界，不如干脆不开。Outputs 的 `DeployModeStatus` 会把这件事说出来。

#### 2.6.2 从成员账号部署：注册 StackSets 委派管理员

很多组织的管理账号是"净空"的（不落业务负载、变更走单独审批）。这种情况下把 NotiOps 开在一个成员账号里、只把**下发成员账号角色**这件事委派给它，比把整套 Web/IM 底座塞进管理账号更现实。

**一次性动作，在管理账号里跑**（`<成员账号号>` 换成你打算用来部署 NotiOps 的那个账号；官方步骤见 [Register a delegated administrator member account](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-orgs-delegated-admin.html)）：

```bash
aws organizations register-delegated-administrator \
  --service-principal member.org.stacksets.cloudformation.amazonaws.com \
  --account-id <成员账号号>
```

验证（同样在管理账号里，也可以在那个成员账号里跑）：

```bash
aws organizations list-delegated-administrators \
  --service-principal member.org.stacksets.cloudformation.amazonaws.com \
  --query 'DelegatedAdministrators[].[Id,Status]' --output text
```

反向操作是 `aws organizations deregister-delegated-administrator`（同样两个参数）。

注册完，直接在那个成员账号里开这个模板、选 `MultiAccount` 即可，**没有额外参数**：栈里的前置检查会依次做 `DescribeOrganization` → `ListDelegatedAdministrators`（按上面那个 service principal 过滤），认出这条身份之后，把 `CallAs=DELEGATED_ADMIN` 一路带到所有 StackSets 调用（建/更新两个 StackSet、下发实例，以及运行期 Web 管理页背后 BFF 的那 9 个 StackSets 调用）。

**开这条路之前，客户要知道的四件事：**

1. ⚠️ **委派管理员对全组织有完整部署权限。** AWS 明确说明：管理账号**无法**把委派管理员的权限收窄到某几个 OU 或某几类操作。也就是说，这个成员账号一旦被注册，就能往组织里**任何**账号下发 StackSet（不只是 NotiOps 这两个）。这是 AWS StackSets 的模型，不是 NotiOps 的实现选择。
2. **可信访问必须先由管理账号开好。** 注册委派管理员本身就要求它已经开着；而 `enable-aws-service-access` 与 `activate-organizations-access` 这两个 API **只有管理账号能调**。所以委派管理员这条路上，栈**不会**替你去开（也开不了），只会用 `describe-organizations-access --call-as DELEGATED_ADMIN` **验一遍**，没开就失败并把那两条命令给出来，让你回管理账号跑。见 [§2.6.3](#263-信任访问两半都得开)。
3. **一个组织最多同时注册 5 个 StackSets 委派管理员**（AWS 的限制，见上面的官方文档；这个上限按服务各算各的，别的服务有自己的上限）。
4. **StackSet 实体存放在管理账号里**，即使它是由委派管理员创建的。所以在管理账号的 CloudFormation 控制台里能看到 `notiops-member-onboarding` / `notiops-member-devops-agent`，而在**部署账号**的控制台里看不到（要看得加 `--call-as DELEGATED_ADMIN`）。`teardown.sh` / `TeardownMode` 也同样带这个参数，不会因此漏删。

#### 2.6.3 信任访问：两半都得开

service-managed StackSet 要求 CloudFormation 与 Organizations 之间的**信任访问**是打开的，而这件事**有两半**，缺一不可：

| 哪一半 | 命令 | 缺了的症状 |
|---|---|---|
| Organizations 侧 | `aws organizations enable-aws-service-access --service-principal member.org.stacksets.cloudformation.amazonaws.com` | — |
| CloudFormation 侧 | `aws cloudformation activate-organizations-access --region <你的区域>` | `CreateStackSet` 报 `ValidationError: You must enable organizations access to operate a service managed stack set` |

**在管理账号里部署时，栈会替你把两半都打开**（前置检查阶段做，只在选了 `MultiAccount` 时才有这段），然后用 `describe-organizations-access` **验一遍**状态确实是 `ENABLED` 才继续。所以正常情况下你什么都不用做。

**从委派管理员（成员账号）部署时，栈只验、不开** —— 上面那两条命令都是管理账号专属的，在成员账号里重试一万次也开不了。这里刻意选了"跳过"而不是"调了忽略错误"：后者会在部署日志里留下一条 `AccessDenied`，让现场以为脚本已经帮它开好了，而真没开时唯一正确的动作是**回管理账号**跑那两条命令。验的时候会带上 `--call-as DELEGATED_ADMIN`（不带的话 CloudFormation 按 `SELF` 解释，读到的是**本账号**命名空间的状态，而这条路上本账号根本没有那个开关 ⇒ 永远 `DISABLED` ⇒ 一个完全合格的环境被判不合格）。

真被 SCP 之类的东西拦住，失败原因里会把上面那两条命令原样给出来（带上你的区域），在管理账号跑完再 update 一次栈即可。这里最误导人的一点是：**Organizations 那半的清单里往往已经有那个 service principal 了**，看起来"已经开了"，但 CloudFormation 那半仍是 `DISABLED`，而 AWS 报的 `ValidationError` 完全不提该去调 `activate-organizations-access`。

**多了什么**：栈会建两个 StackSet（`notiops-member-onboarding`、`notiops-member-devops-agent`），并（管理账号部署时）打开 Organizations 对 StackSets 的信任访问。⚠️ service-managed StackSet **一律存放在组织管理账号里**，即使是委派管理员创建的 —— 所以从成员账号部署时，这两个 StackSet 不会出现在部署账号的 CloudFormation 控制台里。之后在 Web 界面的**更多 → 管理 → 账户**页把成员账号一个个接进来（每个成员账号里会创建一个跨账号采集角色 —— 只读，默认另带 Support 工单的开 / 回复 / 关闭权限，由成员模板参数 `EnableSupportCaseWrite` 控制 —— 外加一个深度调查触发角色）。接进来之后，你就能在聊天界面切换账号做只读排查、深度调查、开案例。

**这条路径**仍然**没有**：成员账号的 CloudWatch OAM Sink、跨账号 Health / 调查事件回流、跨账号定时巡检。那三样要 `setup.sh`。

> ⚠️ **删栈不会删这两个 StackSet**，也不会关掉信任访问。理由见 [§6.4](#64-会留下的东西孤儿要不要管)。

### 2.7 深度调查（AWS DevOps Agent）

**Enable AWS DevOps Agent features**（模板里的参数名仍是 `EnableDeepInvestigation`）默认 `Yes`：栈会顺手建一个 **AWS DevOps Agent Agent Space**（名字 `notiops-oneclick-<账号 id>`）并把本账号以 **monitor（只读）** 身份关联进去。有了它，聊天界面里**所有 DevOps Agent 相关能力**才能用 —— 那是把一个问题交给 AWS 托管的 DevOps Agent 去多轮自主排查，比一次问答挖得深。

具体是这四样，都依赖这同一个 Agent Space（没有它，对应的开关会**置灰并写清原因**）：

| 能力 | 这一轮谁在答 | 说明 |
|---|---|---|
| **深度调查** | DevOps Agent（NotiOps 先把你的问题整理成调查请求） | 多信号根因排查、出 HTML 报告，通常几分钟 |
| **深度调查（直连）** | DevOps Agent（**绕过大模型**直连 API） | 同一个深度调查，**不消耗 token**；代价是调查描述按你的原话透传 |
| **DevOps 对话** | DevOps Agent **直接回答**（通用聊天里选「对话对象 = DevOps Agent」） | 流式问答，体验与 DevOps Agent 自己的页面一致；**NotiOps 侧 0 token**、**免模型配置**（不需要在 Bedrock 开通任何模型），用量计入你自己的 DevOps Agent |
| **把 Skill 发布到 DevOps Agent** | — | 把自建 Skill 推到 Agent Space，供上面「深度调查」那条路径使用 |

> 💡 后两样对**还没在 Bedrock 开通模型**的新部署特别有用：选 DevOps Agent 直答就能先跑起来。

- **不用你去控制台点任何东西**：建 Agent Space 的同时，栈把它的 **Operator App（web app）**一并开好了（控制台上那一步叫「Agent Space → Access → Operator access → **Configure web app**」）。这一步以前必须客户自己手点一次，不点则上面四样**全部**报 `Invalid or unregistered domain` —— 而报错信息完全不指向"你少点了一个按钮"。现在栈替你开：多一个被 DevOps Agent 服务假设的角色（`AIDevOpsOperatorAppAccessPolicy`），删栈时随栈关闭并删除。
  > ⚠️ **只影响从旧版本升级**（[§5](#5-升级到新版本)）：如果你之前用旧版本开的栈、并且**自己在控制台点过** Configure web app，这次 update 会让 CloudFormation 再 Enable 一次，而服务侧已经是 enabled。**这一情形尚未实测**。真因此 update 失败：先 `aws devops-agent disable-operator-app --agent-space-id <space id> --region <region>`（space id 见 Outputs 的 `DevOpsAgentSpaceId`）再 update —— web app 域名由 space id 派生，关掉重开**不换 URL**。全新部署没有这个问题。
- **计费**：按**任务运行的 agent-秒**收费，**闲置的 Agent Space 不收费**。所以默认开着不会给你带来一笔"什么都没做的月费"。
- **区域**：AWS DevOps Agent 只在部分区域可用。**你选的区域没有它，栈不会失败** —— 这一块被静默跳过，其余功能全在，Outputs 的 `DeepInvestigationStatus` 会写明"因为区域跳过"。
- 事后想改主意：update 栈、把这个参数改掉即可。

### 2.8 联网搜索（AgentCore Web Search）

**没有参数，栈自动建好。** 它会创建一个 **Bedrock AgentCore Gateway**（名字 `notiops-websearch-gw`）并挂上 AWS 内建的 `web-search` 连接器 —— 聊天界面输入框上那个**联网搜索**开关靠的就是它。**不需要任何第三方 API key**，搜索请求也**不出 AWS**。

- **计费**：按**搜索次数**计（只有你打开那个开关提问、且 agent 真的决定去搜时才产生），不搜不收费。所以它没有参数可关 —— 关掉的成本收益为零。
- **区域**：AgentCore Web Search 目前**只在 us-east-1** 提供。**部署在别的区栈不会失败** —— 这一块整块跳过，其余功能全在，Outputs 的 `WebSearchStatus` 会写明原因。那种情况下界面上的开关还在（前端不做区域判断），点了不报错，只是搜不到东西。
- **账号里已经有同名 Gateway**（比如你先跑过 `setup.sh`，或者在同一账号里开了第二个栈）：**复用，不重复建**；删栈时也**不会**去删它 —— 只有本栈自己建出来的那个才会被删掉。唯一的例外是那个同名 Gateway 停在 `FAILED` 上：它不会自愈、谁也用不了，栈会删掉它重建一个。
- **建失败不会让栈失败**：联网搜索是可选能力，它挂了不该让整栈回滚（那样你会为了一个开关失去全部其它功能）。所以要看的是 **`WebSearchProvisioning`** 这个 output：`enabled` 才是真的能用，`unavailable (<错误码>)` 表示这个部署没有联网搜索、开关点了没结果。想知道细节就看栈事件里的 `StagerWebSearch` 与 StagerFn 的日志。

---

### 2.9 「通知」收件箱

**没有参数，栈自动建好。** 左侧导航第一项「通知」里那个收件箱，内容由 **10 条 EventBridge 规则** → 一个 Lambda（`notiops-web-notif-handler`，归一化 + 去重：同一事件 5 分钟内只记一次，Trusted Advisor 24 小时）→ 写进 `notiops-web-chat` 表来的。前端 **60s 轮询**一次，所以最长约 1 分钟延迟；左侧红点只统计**未读**。

- **默认开 5 类**（运维价值最高、噪音可控）：AWS Health / CloudWatch 告警 / 成本异常 / Trusted Advisor / GuardDuty
- **默认关 5 类**（量大容易刷屏，或需先开通付费服务）：Backup 作业 / EC2 Spot 中断 / Auto Scaling 失败 / RDS / Config
- **怎么开关**：进 **EventBridge 控制台 → Rules**，规则名前缀 `notiops-web-notif-`，直接 **Enable / Disable** 那一条。这个手动改动**不会被版本升级覆盖回去**（模板不改规则的启用状态）。

> ⚠️ **默认开的 5 类里有 3 类还依赖你账号侧的前置条件** —— 规则是开的，但缺前置条件时收不到事件（界面空态会写明原因，不是 NotiOps 坏了）：
>
> | 源 | 前置条件 |
> |---|---|
> | GuardDuty | 账号需已**启用 GuardDuty**（付费）。未启用时不产生任何 finding；规则开着零成本，启用后立即生效、无需重新部署 |
> | 成本异常 | 需先在 Cost Explorer 建一个**成本异常监控器**（免费）；且只在 `us-east-1` 发事件 |
> | Trusted Advisor | 需 **Business+ / Enterprise / Unified Operations** 支持计划；且只在 `us-east-1` 发事件 |
>
> 成本异常与 Trusted Advisor 是**全局服务，只在 `us-east-1` 发 EventBridge 事件**。把栈部署在别的区，这两条规则建了也**永不触发**（规则描述里写着这句）—— 想收就把 NotiOps 部署在 `us-east-1`，或自己在 `us-east-1` 建一条跨区转发规则。

「通知」主题里另有一块 **AWS Health Dashboard 实时视图**，由 BFF 实时查 Health API（不落库），需 **Business+ / Enterprise** 支持计划；没有该计划时降级为控制台链接，且它的未处理数**不叠进**红点。

**跨账号**：这 10 条规则只收**部署账号自己**的事件。成员账号的事件要回流到这里需要跨账号事件转发，那个不在这条路径里（见 [§0.1](#01-一键部署不包含什么)）。

### 2.10 会话记忆（AgentCore Memory）

**没有参数，栈自动建好。** 栈里有一个 **Bedrock AgentCore Memory**，作用只有一个：把**当前这个会话**的消息按 `sessionId` 存下来、下一轮再读回去。**不跨会话** —— 新开一个会话就是干净的一页。

- **它不是"对话历史"**：历史在 DynamoDB 里、界面上一直看得见；Memory 决定的是**模型还记不记得**。没有它，你在同一个会话里切模型 / 切主题 / 隔一小时再回来，界面上历史还在，但模型是"新人"。所以这一层不是可选项，栈里**无条件**建。
- **不做跨会话记忆**（2026-09-01 产品决策）。以前这里挂着四个抽取 strategy，把"你说过的偏好""关于你环境的事实"写到不带会话号的命名空间（`/users/<actor>/…`），下一个会话还能检索到。现在 **strategy 数为 0**，那条路整块关闭：抽取不跑、检索不发。
  - 少一份跨会话的数据留存，行为也更可预期（"它为什么突然这么答"不会来自你早就忘了的某句话）。想让它一直知道的事，写进 Skill / 系统提示这类**显式**配置。
  - ⚠️ **从 v1.0.18 / v1.0.19 升上来的部署**：栈更新会删掉那四个 strategy，**已经抽取出来的记录随之删除**（原先那个 `<actor>` 还是整个部署共用的一个身份，即 A 说过的偏好会影响 B 得到的回答 —— 这也是取消它的原因之一）。
- **事件 30 天后自动过期**（同一个会话隔天接着聊仍能接上；聊天记录本身另存在 `notiops-web-chat` 表里）。
- **删栈时随栈删除**，会话消息一起消失。
- 计费按用量（写入/读取的事件），量级远小于提问本身的 Bedrock token；去掉抽取之后这一项还会更小。

### 2.11 加装 IM 机器人（飞书/Lark、Slack 或钉钉）

参数页第一组里那个 **What to install** 下拉框：

| 选项 | 装出来是什么 |
|---|---|
| `web`（默认） | 只有浏览器里的聊天界面。 |
| `web+feishu` | Web Chat **加**一个飞书/Lark 机器人：群里 @ 它、或者私聊它。 |
| `web+slack` | Web Chat **加**一个 Slack 机器人：`/notiops` 斜杠命令、@ 提及、私聊。 |
| `web+dingtalk` | Web Chat **加**一个钉钉机器人：群里 @ 它（斜杠命令一步都不用注册，钉钉没有 Slack 那层命令注册表）。 |

**四个选项都装 web** —— IM 是加装项，不是替代项。一个栈只装**一个** IM 平台；几个平台同时要就走 [DEPLOYMENT.md](DEPLOYMENT.md) 的 `setup.sh`（在它的 IM 平台那一问里多选，如 `1,2,3`，即 `-c enabledPlatforms=feishu,slack,dingtalk`）。

**IM 侧和网页侧是同一个后端**：同一个只读的 AWS DevOps Agent、同一套 Skills、同一份配置表。所以你在网页里问的那些（成本、故障调查、Support 案例）在群里问是同一个答案。

**钉钉与另外两个平台的差异，照实说**：能力（只读排查、深度调查、开案例、Skills）和命令入口（`/devops`、`/investigate`、`/case`、`/model`…）三个平台完全一样，但钉钉的平台原语少几样，所以同一件事在钉钉里长得不一样 —— 这是钉钉的限制，不是这条部署路径缩水：

- **要确认的操作靠回复完成，不是点按钮**：钉钉的卡片按钮只能是链接跳转，没有「点一下回传给服务器」这条通道，所以开案例这类需要确认的动作在钉钉里是**回一句关键词**（`/case` 也弹不出表单，取而代之是一张可复制的纯文本模版）。
- **进度是追加，不是原地刷新**：钉钉没有更新已发消息的接口，所以没有飞书/Slack 那种「卡片自己变」的进度条，长任务改成**最多追加两条**进度消息。
- **机器人不会给你的消息贴表情**：收到指令时的即时反馈是一条**文字回执**，不是 👀。
- **消息接收地址只填一处**（飞书两处、Slack 三处），但钉钉**保存地址时不做任何校验**：地址填错一个字符和凭证还没填，表现完全一样 —— 机器人一句话不回。所以钉钉这条路的排错入口是日志，见 [§4.5](#45-装了-im但机器人在群里不说话)。

**默认配置下它不烧 token**：进来的每条消息先走确定性路由（正则 + 关键词，中英文都认），命中「查资源 / 发起调查 / 看进度 / 切模型 / 切语言」这些直接调 API；对话默认走 `/agent devops`，由 DevOps Agent 直接回答。这时 NotiOps 侧**一个 token 都不花**，只有**案例流程**（要把你的描述写成案例正文）才真的走大模型。**有人发了 `/agent notiops` 之后就不一样了**：每个问题都改由 NotiOps agent 回答（就是网页聊天用的那个 AgentCore Runtime，窄工具集主题 `im-chat`），**会**消耗 Bedrock token。这个开关按会话生效 —— 群里任何人切一次，整个群都跟着换；用法见 [IM_WEBHOOK_SETUP.md §2.4](IM_WEBHOOK_SETUP.md#24-斜杠命令清单) 里 `/agent` 那一行。

**群里发起的深度调查会把报告送回群里**：调查跑完（通常几分钟），栈里那个回调函数把 HTML 报告写进数据桶的 `investigations/` 前缀，再往群里发一张卡片，带一条**限时的公网下载链接** —— 收报告的人不需要有这个 AWS 账号的权限。这条链接是回调函数用它自己的**临时凭证**签出来的 **S3 预签名地址**（不走 CloudFront —— 本栈那个报告 CloudFront distribution 只放行 `reports/`，调查报告在 `investigations/`）。这种链接活不过签名用的那份凭证：凭证一过期就打不开，最长约 12 小时，不是 7 天。要长期留档就把报告下载下来。

> ⚠️ 这条链路是**异步**的（EventBridge → Lambda），所以它坏掉的时候**没有任何报错**：
> 进度卡照样走到 100%（那是另一个函数轮询任务状态画的），然后报告就是不来。
> 钉钉上没有那张卡（进度是追加消息），症状换成「最后一条进度消息发了，报告卡不来」，查法一样。
> 真遇到就按这个顺序查：`aws lambda get-function --function-name <栈名>-devops-callback`
> 在不在 → 它的日志组（名字是 CFN 生成的随机名，按逻辑 ID 前缀
> `DevOpsCallbackLogs` 解析，命令形状见 [§4](#4-出问题了怎么办) 那张排障表）里
> 有没有 `account_not_configured` →
> `aws s3 ls s3://<数据桶>/investigations/` 有没有本次调查的对象。
> 三样都在还不来，看那个函数的死信队列（DLQ）。

**部署后还差两步**，两步都做完机器人才会说话（Outputs 里的 `ImNextSteps` 也会提醒你）：

1. **凭证进 Secrets Manager** —— 机器人要有钥匙才能验签和回消息。
   - **飞书/Lark**：`notiops/im-bot-feishu`，四个键：`app_id` / `app_secret` / `encrypt_key` / `verification_token`。
     **推荐直接在网页里填**：登录后左侧 **更多 → 管理 → 集成 IM**，四个凭证在同一张表单上，点保存即写进这个 secret —— 不用装 CLI、不用另开凭证。那一页还带飞书那一半的四步速览和「查看详细配置步骤」侧边栏。
   - **Slack**：两个 secret，`notiops/slack-bot-token`（`xoxb-` 开头）和 `notiops/slack-signing-secret`，各存一个**纯字符串**（不是 JSON —— 数据面直接把整个 SecretString 当值用）。**也在网页里填**：**更多 → 管理 → 集成 IM → Slack** 分页，两个框加保存，secret 不存在时后端替你建；那一页同样有「查看详细配置步骤」抽屉。⚠️ Slack 这两个**都是凭证**（没有飞书 `app_id` / 钉钉 `app_key` 那种明文可核对的字段），所以「我配的是哪个 App」只能靠那一页的「测试凭证」按钮 —— 它会回你 workspace 与机器人的名字，并把**缺的 Bot Token Scopes 逐条报出来**。
   - **钉钉**：`notiops/im-bot-dingtalk`，两个键：`app_key` / `app_secret`（钉钉开放平台「凭证与基础信息」里的 AppKey / AppSecret）。**也在网页里填**：**更多 → 管理 → 集成 IM → 钉钉**分页，两个框加保存，secret 不存在时后端替你建；那一页右上角同样有「查看详细配置步骤」抽屉。⚠️ 钉钉**只有这一个** secret：AppSecret 既换 access token 又验入站请求的 `sign`，所以没有飞书那两个 `encrypt_key` / `verification_token`，界面上少两个框是**故意**的。
2. **请求地址填回 IM 平台** —— 就是 Outputs 里的 `FeishuWebhookUrl` / `SlackWebhookUrl` / `DingtalkWebhookUrl`。

> ⚠️ **顺序不能反**：先写凭证，再填请求地址。飞书/Slack 在你保存请求地址时会**立刻**发一次校验请求，那时凭证还没有的话入口函数会直接失败，而 IM 平台上显示的是「校验失败」—— 看起来像地址填错了。
> 钉钉更需要守这个顺序：它保存地址时**根本不校验**，不变绿也不报错，凭证没写好的唯一表现就是机器人不说话（还要记得改完「消息接收模式」后回「版本管理与发布」再**发布一次**）。

**每一步点哪里、填什么，见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md)**（飞书 §1、Slack §2、钉钉 §3；那份文档两条部署路径通用，secret 名字和请求地址的用法完全一样）。

**装完之后想改**：update 栈、把 **What to install** 换成另一个值即可。

- `web` → 任一个带 IM 的选项：新建 IM 那套资源（~30 秒），然后照上面两步配。
- 任一个带 IM 的选项 → `web`：删掉 IM 那套。⚠️ **两张 IM 的 DynamoDB 表（会话与用量）也会被删** —— 里面是群会话的上下文和调查任务状态，删了就没了。
- 换 IM 平台（`web+feishu` → `web+slack` / `web+dingtalk`，或反过来）：删旧平台那套、建新平台那套。旧平台那个 HTTP API 的地址**不会**保留，改回去时是一个新地址，得重新填一遍那个平台的后台。
- **凭证不随栈走**：那几个 secret（飞书 1 个、Slack 2 个、钉钉 1 个）是栈外资源，换选项、删栈（`KeepData`）都留着。只有 `TeardownMode=DeleteEverything` 的删栈才会连它们一起删（见 [§6](#6-删除这个栈)）。

---

### 2.12 （可选）接自己的 CUR 数据源

默认**不启用**：成本问题照样能答（走 Cost Explorer），只是没有账单明细级的下钻。想要的话有三种接法，**只能选一种**（同时填会在**开栈之前**被参数校验规则 `CostMcpExclusiveWithExternal` / `ProvisionCurExcludesCurTable` 拦下，不会先建出半个东西来）。下面这些参数都在参数页 **Optional: your own CUR data source** 那一组里（`ProvisionCur` 在那一组里显示为 **Let NotiOps create the CUR for you?**）：

| 接法 | 填什么 | 结果 |
|---|---|---|
| **让栈替你建 CUR**（还没有 CUR 时选它） | `ProvisionCur=yes`，`CurTable` 留空 | 建一份按小时、带资源 ID、Parquet 格式的 CUR 和官方的 Athena 集成，再部一个成本 MCP（45 个只读 CUR 工具）。⏱ AWS 首次交付**最长 24 小时**，在那之前成本问题走 Cost Explorer；就绪后自动切过去（每 4 小时检查一次），**不用再部署一次** |
| **接一张已有的 CUR 表** | `CurTable`（`库.表`）+ `CurBucketName`（存 CUR 数据的那个桶） | 同一个成本 MCP，立即可用。表、库和桶都必须与本栈**同账号、同区域**（见表下的三条）。⚠️ 分区形态 `CurPartitionStyle` 默认 `flat`，**务必按你那张表核对**（官方 Glue crawler 建出来的表是 `year-month`） |
| **指向你已经在跑的 cost-agent MCP** | `CostAgentMcpUrl` + `CostAgentFunctionArn` | 栈不新建任何东西，见下面「外接」那段 |

前两种由 NotiOps 自建，全在你的账号里：一个 Lambda（本仓库的 `cost_mcp/`）+ 一个专用的 Athena workgroup（`<栈名>-cost-mcp`）+ 独立的查询结果桶。workgroup 上强制了单次查询的扫描量上限 `CostMcpScanCapGiB`（默认 100 GiB）—— Athena 按扫描字节收费、没有逐次调用的上限，这是真正的花费护栏。🔒 **删栈不会删你的账单数据**：`ProvisionCur=yes` 建的 CUR 报告和它的 S3 桶在任何 `TeardownMode` 下都原样留下（见 [§6.5](#65-删栈停在-delete_failedstagersite怎么办) 末尾）。之后在同一个账号、同一个区域重装（仍选 `ProvisionCur=yes`）会复用这份 CUR，不用再等 24 小时的首次交付；但一键部署要等下一次每 4 小时一次的检查才接上它，也就是**最长约 4 小时**，在那之前成本问题走 Cost Explorer。

**接已有的 CUR 表**时，先核对这三条：

- **同账号、同区域，并且要给桶名**：`CurTable` 那张 Glue 表、它所在的库和 `CurBucketName` 那个桶，都必须在**本栈所在的账号和区域** —— 成本 MCP 就在这里跑 Athena（表不在本区域时，栈照样开得成功，但之后每次查询都会失败）。`CurBucketName` 不能省（不填会被规则 `CostMcpNeedsCurAccess` 拦下）：成本 MCP 只被授权读这一个桶，不会为了省事给它读账号里所有桶的权限。
- **CUR 在别的账号（`CurRoleArn`）这一版还不支持**：这个参数还在，但必须留空，填了会在开栈之前被规则 `CostMcpCrossAccountNotSupported` 拒掉 —— 那种配置下查询会跑在 CUR 所在的账号里，而成本 MCP 的 workgroup 只在本账号里有，每次查询都会失败。CUR 在别的账号或别的区域时：把 NotiOps 部署到那个账号 / 区域，或者用第三种接法（`CostAgentMcpUrl`）指向你自己跑的 server。
- **`CurTagKeys`（按哪些用户标签拆分费用）填的是列名后缀**：也就是 CUR 表列名里 `resource_tags_user_` 后面那一段（只有字母、数字、下划线；多个用逗号分隔、不带空格），**不是**你在 AWS 里敲的那个标签键。比如标签 `cost-center` 在表里通常是 `resource_tags_user_cost_center` 这一列，就填 `cost_center`。先在 Glue / Athena 里看一眼那张表的列名再填。

三种接法启用后多出的东西一样：FinOps 页 4 个 CUR sheet（费用趋势 / Credit / 扩展支持 / Savings Plans）+ 聊天里直接问费用。

**外接**那一种接的通常是**别的账号/多 payer 的 CUR 表**（行级明细，TAM 场景）。⚠️ 那**两个参数必须一起填**。Function URL 里**不含**函数 ARN，而调用授权（`lambda:InvokeFunctionUrl` 与 `lambda:InvokeFunction` 两个动作）只能按函数给 —— 只填 URL 会部署出一个「看起来装好了、每次调用 403」的数据源。所以模板里有一条参数校验规则（`CostAgentArnRequiredWithUrl`）：只填一半会在**开栈之前**就被拒掉。

- **不填**：这项能力按设计不存在 —— 那 4 个 sheet 的导航节点直接不出现（不会有点了没反应的菜单），聊天里也不挂对应工具。其余功能不受影响。
- **先部署后再加**：update 栈、填上对应的参数即可，不用重建。
- **外接的 server 在别的账号时，还差一步在你那侧**：那个 Lambda 的 **resource policy** 要给本栈的两个角色（BFF 与 agent runtime）**同时**放行两个动作 —— `lambda:InvokeFunctionUrl`（条件 `lambda:FunctionUrlAuthType=AWS_IAM`）和 `lambda:InvokeFunction`（条件 `lambda:InvokedViaFunctionUrl=true`）。AWS 2025-10 起 Function URL 要求这两个动作齐备；本栈这一侧的两条授权已经替你建好，那个 Lambda 是你自己的部署，模板碰不到。只放行了前一个的典型症状：请求在那个函数的日志里根本看不到，而它的 `Url4xxCount` 在涨。
- **MCP 挂了不会拖垮整个工具**：仪表盘只有那 4 张表显示「暂时不可用」；聊天会自动降级到 Cost Explorer、再到 AWS 只读 API，并**明确告诉你换了数据源**（口径不同，别拿去直接对账）。

**完整的参数表（含 `CurVersion`）、45 个工具的口径注意事项、以及降级链的完整说明，见 [DEPLOYMENT.md §14](DEPLOYMENT.md#14-客户-cur-仪表盘--cost-agent-mcp可选)**（那一节两条部署路径通用）。

---

## 3. 这个栈建了什么

默认参数下 **76 个**资源，都在你自己的账号里（部署在 us-east-1 会再多 3 个 —— 联网搜索那套；关掉深度调查少 6 个；选上多账号多 8 个；**选带 IM 的安装选项多 26 个**；填了 `CurTable` 或选了 `ProvisionCur=yes` 多 10 个 —— 成本 MCP 那套，选的是 `ProvisionCur=yes` 的话再多 11 个）：

| 类别 | 资源 |
|---|---|
| 前端 | S3 网站桶 + CloudFront distribution + CloudWatch RUM；报告下载走另一个 CloudFront distribution（带一个只放行报告路径的 CloudFront Function） |
| 接口 | 1 个 Lambda（BFF）+ Function URL（`AWS_IAM` 鉴权，流式返回）+ 1 条 EventBridge 规则（每天预热一次 CUR 仪表盘的缓存；没接 CUR 时 BFF 收到就直接返回）+ 它的调用许可 |
| Agent | 1 个 Bedrock AgentCore Runtime + 1 个 AgentCore Memory（会话记忆，见 [§2.10](#210-会话记忆agentcore-memory)） |
| 登录 | Cognito User Pool + Client + Identity Pool + 8 个用户组（角色） |
| 数据 | DynamoDB `notiops-config`、`notiops-web-chat`；1 个数据桶（报告等） |
| 部署辅助 | 1 个 staging 桶（放搬进来的产物）+ 1 个内联的部署 Lambda + 4 个自定义资源（搬产物 / 写前端配置 / **删栈时把 staging 桶清到真的空** / 删栈时等报告 CloudFront 分发删完再删数据桶，只在 `DeleteEverything` 时干活） |
| 权限 | 6 个 IAM 角色 + 6 个内联策略（其中 AgentCore Memory 的执行角色**一条策略都没有** —— 它只是给服务用来信任的壳）+ 1 个托管策略（BFF 角色的授权超出内联策略的长度上限，多出来的那部分放在这里） |
| 「通知」收件箱（见 [§2.9](#29-通知收件箱)） | **10 条 EventBridge 规则**（5 条 ENABLED / 5 条 DISABLED）+ 1 个 Lambda + 它的日志组 + 1 个角色（+ 策略）+ 1 条 Lambda 调用许可 = 15 个 |
| 深度调查（默认开） | 1 个 DevOps Agent Agent Space（**含自动开好的 Operator App**）+ 1 个只读关联 + 1 个被 DevOps Agent 假设的角色（+ 它的策略）+ 1 个 Operator App 角色 + 1 个自定义资源（把部署账号写进深度调查的账号登记）= 6 个 |
| 联网搜索（仅 us-east-1） | 1 个自定义资源（去建 AgentCore Gateway）+ 1 个 Gateway 服务角色 + 1 个内联策略 |
| 多账号（可选） | 2 个自定义资源（① 资格前置检查 ② 去建两个成员账号 StackSet）+ 前置检查自己的 Lambda / 角色 / 策略 / 日志组 + 2 个内联策略 = 8 个 |
| IM 机器人（可选，见 [§2.11](#211-加装-im-机器人飞书larkslack-或钉钉)） | 4 个 Lambda（入口 / 干活 / 进度刷新 / 调查回调 —— 最后这个把群里发起的深度调查报告送回群）+ 4 个日志组 + 1 个 **API Gateway HTTP API**（公网入口，见下；连它的路由 / 集成 / 阶段一共 4 个资源）+ 4 条调用许可（HTTP API→入口、保活规则→入口、进度规则→进度刷新、回调规则→调查回调）+ 1 个依赖层 + 2 张 DynamoDB 表（群会话、用量）+ 3 条 EventBridge 规则（每分钟刷调查进度、每 4 分钟保活入口、调查结束时触发回调）+ 1 个 SQS 死信队列（+ 队列策略：回调没投进去、或回调函数自己出错时，事件落在这里不丢）+ 1 个角色（+ 策略）= 26 个。三个平台是**同一套形状**，只是入口/干活那两个函数换成对应平台的那一对（`web+dingtalk` 时进度刷新函数照样建，但钉钉的进度是追加消息、没有卡片可刷，所以它每分钟扫出来是空的） |
| 成本 MCP（可选：填了 `CurTable` 或选了 `ProvisionCur=yes`，见 [§2.12](#212-可选接自己的-cur-数据源)） | 1 个 Lambda + Function URL + 1 个依赖层 + 日志组 + 1 个角色（+ 策略）+ 1 个 Athena workgroup + 1 个查询结果桶（+ 桶策略）+ 1 条让 agent 能调它的内联策略 = 10 个 |
| CUR 自建（可选：`ProvisionCur=yes`，在成本 MCP 之外再多） | 阶段一：1 个 Lambda + 日志组 + 1 个角色（+ 策略）+ 1 个自定义资源（建交付桶、桶策略和报告定义）；阶段二：1 个 Lambda + 日志组 + 1 个角色（+ 策略）+ 1 条每 4 小时一次的 EventBridge 规则 + 它的调用许可 = 11 个。CUR 报告、交付桶和阶段二部署的 `notiops-cur-athena-<账号>` 栈**不是**这个栈的资源 —— 删栈时它们留着，见 [§6.5](#65-删栈停在-delete_failedstagersite怎么办) 末尾 |

**成本量级**（空闲时）：CloudFront + S3 + DynamoDB 按量、Lambda 不调用不计费、AgentCore Runtime 空闲不计费 —— 不用的时候基本只有几毛钱的存储。真正花钱的是**提问时的 Bedrock token**。staging 桶里每个 release 约 **165 MB**（装了 IM、自建了成本 MCP 的话再多它们各自的代码与依赖层；S3 标准存储 ≈ $0.004/月），升级后旧版本的那份也留着（删栈时一起清掉），见 [§5](#5-升级到新版本)。IM 那套同理**空闲零成本**（四个 Lambda 不调用不计费，两张表按量，每分钟那条进度规则只在有调查在跑时才真的做事）。成本 MCP 也是不调用不计费；自建了它之后真正多出来的花费是每次查询的 **Athena 扫描量**（有上限，见 [§2.12](#212-可选接自己的-cur-数据源)），以及（`ProvisionCur=yes` 时）CUR 交付进 S3 的存储。

**只读设计**：agent 拿到的全是只读授权，产品层面也没有任何"改你资源"的工具。它能做的最大动作是**开一个 AWS Support 案例**（且需要你在对话里确认）。

---

## 4. 出问题了怎么办

### 4.1 栈 ROLLBACK 了 —— 先看是哪个资源失败

Events 页，找第一条 `CREATE_FAILED` / `UPDATE_FAILED`（不是最后一条）。常见的两类：

| 症状 | 原因与处置 |
|---|---|
| `StagerArtifacts` 失败，日志里有超时/连不上 | 这个账号出不了公网、拉不到 GitHub。走 [§7](#7-无公网出口用私有-s3-镜像)。 |
| `StagerArtifacts` 失败，原因是 `failed to stage <你的镜像地址>/<文件名> after 3 attempts`，后面跟着 `AccessDenied` 或 HTTP 404 | 你用的是 [§7](#7-无公网出口用私有-s3-镜像) 的镜像，而镜像里**少了这个文件**。`s3://` 镜像少文件时报的是 `AccessDenied` 而不是"找不到"：部署 Lambda 只有那个桶的 `s3:GetObject`、没有 `s3:ListBucket`，S3 对不存在的 key 就回 403 —— 别被它带去查权限。先把这个文件补进镜像。**开栈**时失败的，再按下面 §4.2 清掉留下的资源、重开；**update** 时失败的（比如后来才打开 IM / 成本选项），栈会自己退回原状（`UPDATE_ROLLBACK_COMPLETE`），表和桶都还在用 —— **别**按 §4.2 删，补好文件再 update 一次即可。 |
| `AgentRuntime` 失败 | 该区域可能不支持 Bedrock AgentCore。换 us-east-1 / us-west-2。 |
| `StagerPreflight` 失败，提到 `needs this account to be either the AWS Organizations management account or a registered ... delegated administrator` | 你选了 `MultiAccount`，但这个账号既不是管理账号、也**还没**注册成 StackSets 委派管理员。失败原因里已经把三条出路和那条注册命令原样给出来了（管理账号号也在里面）。想从这个成员账号部署就按 [§2.6.2](#262-从成员账号部署注册-stacksets-委派管理员) 注册一次再 update 栈。 |
| `StagerPreflight` 失败，提到 `OrganizationId` 不匹配 | org id 抄错了。失败原因里带着**正确**的那个，照着改再开。 |
| `StagerPreflight` 失败，提到 `activate-organizations-access` | 信任访问只开了一半，而且 SCP 拦住了栈自己去开。把失败原因里那两条命令在管理账号跑一遍，再 update 栈。见 [§2.6.3](#263-信任访问两半都得开)。 |
| `StagerOrgSetup` 失败，提到 `management account` 或 `activate-organizations-access` | 同上三条。这是 `MultiAccount` 的第二道闸（前置检查之后才写组织），能走到这里说明前置检查通过了但真正建 StackSet 时还是被拒。 |

详细日志在 CloudWatch 日志组 `/aws/lambda/notiops-stager` 与 `/aws/lambda/notiops-preflight`（把 `notiops` 换成你的栈名）。

> 🩹 **栈停在 `ROLLBACK_FAILED`、`StagingBucket` 报 `DELETE_FAILED`（v1.0.25 及更早）**：回滚时那个**已被取消**的下载 Lambda 还在后台跑，清桶清完之后它又把 144 MiB 的 agent zip 写了进去，于是桶删不掉、栈也删不掉。手动收尾：控制台 → S3 → 那个 `<栈名>-staging-…` 桶 → **Empty**（顺手在「未完成的分段上传」里也清一遍），然后重新 Delete 栈。之后的版本会自己收拾（清桶改成"连续两轮空才收手"，并且额外排了一道在删桶之前必过的闸）。

### 4.2 ⚠️ 失败重试前，必须先删掉三个"留下来的"资源

这是**最容易卡住的一步**。为了保护数据，下面三个资源上带着 `Retain`：

- DynamoDB 表 `notiops-config`
- DynamoDB 表 `notiops-web-chat`
- S3 桶 `notiops-data-<账号ID>-<区域>`

**即使开栈失败回滚，它们也会留下**（Events 里显示 `DELETE_SKIPPED`）。于是你直接重试会撞上
`BucketAlreadyOwnedByYou` / 表已存在。正确顺序：

```
1. 删掉那个失败的栈（DELETE_COMPLETE）
2. 删掉上面两张表和那个 S3 桶（桶要先清空）
3. 再重新开栈
```

第 2 步用命令行更快（把区域和账号 id 换成你的）：

```bash
REGION=us-east-1
ACCT=$(aws sts get-caller-identity --query Account --output text)

aws dynamodb delete-table --table-name notiops-config   --region "$REGION"
aws dynamodb delete-table --table-name notiops-web-chat --region "$REGION"
aws s3 rm "s3://notiops-data-$ACCT-$REGION" --recursive   # 先清空
aws s3 rb "s3://notiops-data-$ACCT-$REGION"
```

（**上面这几个名字不用改，它们不跟栈名走**：两张表固定叫 `notiops-config` / `notiops-web-chat`（写死的常量，栈名换成什么都一样，见 §2.3），数据桶名跟的是**账号 id + 区域**（`notiops-data-<账号 id>-<区域>`）—— 都不含栈名。按栈名改的后果是三步连着错：`delete-table` 报 `ResourceNotFoundException`（那个名字的表根本不存在）→ 你以为表已经删掉了 → 下一次开栈在 `NAME_CONFLICT_VALIDATION` 预检上**整栈失败**，因为真正留下来的那两张表一直在（见 §6.1 的第二条警告）。真正跟栈名走的是 Lambda 函数名和日志组，那是 §4.5 的事。）

⚠️ 这一步**故意没有做成自动检测**：一次全新安装里"表还不存在"是正常的，把"已存在"当成错误去拦，会把每一次头一回部署都拦下来。

（如果第一次部署已经用过、里面有你想留的数据，就**不要**删表/桶 —— 重开栈时它们会被复用。）

> 💡 多账号部署失败时**还会留下**成员账号 StackSet（`notiops-member-onboarding` / `notiops-member-devops-agent`）和 Organizations 的信任访问。这两样是**故意留的**（理由见 [§6.4](#64-会留下的东西孤儿要不要管)），而且**不影响重试** —— 重开栈会复用同名 StackSet。

### 4.3 页面打开是白屏 / 404

CloudFront 分发要几分钟才在全球生效。先等 2–3 分钟、强刷一次。仍然不行：确认 Outputs 里的
`ChatUrl` 是完整的 `https://xxx.cloudfront.net`，并检查网站桶里有 `index.html`、`config.json` 和 `assets/`。

### 4.4 登录成功但提问报错

- `AccessDeniedException` 提到 `bedrock` → §1.2 的模型访问没开。
- 报错提到某个具体 action（比如 `rds:DescribeDBInstances`）→ 你把 **Give the agent account-wide read-only access** 选成了 `No`。要么按提示补授权，要么 update 栈改回 `Yes`。

### 4.5 装了 IM，但机器人在群里不说话

这是**静默失败**，几乎总是 [§2.11](#211-加装-im-机器人飞书larkslack-或钉钉) 那两步里漏了一步：

| 先查什么 | 怎么判断 |
|---|---|
| 凭证有没有写全 | Secrets Manager 里那个 secret 存在吗、键齐吗（飞书要四个键，钉钉要 `app_key` + `app_secret` 两个）。入口函数是**故意**在缺钥匙时冷启动就失败的 —— 宁可起不来，也不开一个谁都能伪造请求的公网入口。 |
| 请求地址填了吗 | 飞书要填**两处**（事件配置 + 回调配置），Slack 要填**三处**（Events / Interactivity / Slash Commands），都是同一个 URL；钉钉只填**一处**（机器人 → 消息接收模式选「HTTP 模式」→ 消息接收地址），但**改完要再发布一次版本**，而且钉钉保存时不校验，填错了没有任何提示。 |
| 日志 | ⚠️ 一键部署的**日志组名是 CloudFormation 生成的随机名**（`<栈名>-FeishuIngressLogs<hash>-<随机>`），**没有** `/aws/lambda/` 前缀，拿栈名拼不出来（理由与解析命令见 [IM_WEBHOOK_SETUP.md §1.5](IM_WEBHOOK_SETUP.md#15-验证)）。查名字：`aws cloudformation describe-stack-resources --stack-name <栈名> --region <区域> --query "StackResources[?starts_with(LogicalResourceId,'FeishuIngressLogs')].PhysicalResourceId" --output text`（worker 换 `FeishuWorkerLogs`、Slack 换 `SlackIngressLogs` / `SlackWorkerLogs`、钉钉换 `DingtalkIngressLogs` / `DingtalkWorkerLogs`、进度刷新换 `ImProgressLogs`）。**函数名**倒是可以拼：`<栈名>-im-ingress-feishu` / `<栈名>-im-worker-feishu`（钉钉是 `-im-ingress-dingtalk` / `-im-worker-dingtalk`）/ `<栈名>-im-progress`。入口函数里能看到验签失败、或者干脆没有任何日志（= IM 平台根本没打过来，说明地址没填对）。 |

排查步骤和每个报错的含义在 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) 里（飞书 §1.5、Slack §2.5、钉钉 §3.5）。

### 4.6 想用命令行而不是控制台

可以，但有两个坑：

```bash
# 模板 430 KB 左右（随资源数逐版增长），远超 --template-body 的 51,200 字节上限 ⇒ 必须先传 S3、用 --template-url
aws s3 cp notiops-webchat.template.json s3://<你的桶>/notiops-webchat.template.json
aws cloudformation create-stack --stack-name notiops \
  --template-url https://<你的桶>.s3.<区域>.amazonaws.com/notiops-webchat.template.json \
  --capabilities CAPABILITY_IAM \
  --parameters ParameterKey=AdminEmail,ParameterValue=you@example.com
# 多账号：再加两个参数（缺一不生效，见 §2.6）
#   ParameterKey=DeployMode,ParameterValue=MultiAccount \
#   ParameterKey=OrganizationId,ParameterValue=o-xxxxxxxxxx
# 加装 IM 机器人（见 §2.11）：web / web+feishu / web+slack / web+dingtalk
#   ParameterKey=InstallOption,ParameterValue=web+feishu
```

漏了 `--capabilities CAPABILITY_IAM` 会被直接拒（栈里有 IAM 角色）。

---

## 5. 升级到新版本

新 release 出来后：**下新版模板 → update 现有栈**（不要新开一个栈）。

1. 从新 release 下 `notiops-webchat.template.json`。
2. CloudFormation → 选中你的栈 → **Update** → **Replace existing template** → **Upload a template file**。
3. 参数保持 **Use existing value**（除了你确实想改的）→ 勾 IAM → Submit。（栈现在是 v1.0.20–v1.0.29、又装了 IM 机器人的话，Submit 之前先读下面 🔴 那一条。）

**实测 ~1 分钟**。升级过程中会发生：新版产物从 GitHub（或你的镜像）搬进 staging 桶（key 里带 release tag）
→ 前端重新发布并清掉上一版残留文件 → CloudFront 缓存失效（`/*`）→ AgentCore Runtime **原地**出一个新版本（ARN 不变，前端配置不用动）。

**升级不会**：重发邀请邮件、改管理员的邮箱或密码、动 `config.json` 里已有的配置、清空你的聊天历史。

**多账号模式**：v1.0.30 起，成员账号的 DevOps Agent StackSet（`notiops-member-devops-agent`）带 `CreateCollectionRole=no` 下发（与 `setup.sh` 一致），不再在成员账号里重复建一个与接入 StackSet 同名的巡检采集角色。以前在 **更多 → 管理 → 账户** 页「第二步: DevOps Agent」点「一键关联」、结果成员栈因 `EntityAlreadyExists` 回滚的账号，这次 update 完之后再关联一次即可 —— 每个 release 的 update 都会把两个 StackSet 重新下发一遍，不用另做什么。

> 🔴 **从 v1.0.20–v1.0.29 升级、装了 IM 机器人（What to install 不是 `web`）、产物走默认的 GitHub 来源（Artifact base URL override 留空）的栈**（看 Outputs 的 `InstalledRelease` 和这两个参数就能判断）：
> 这几个 release 里的 `im-code.zip` 已经从 GitHub Release 上撤下了。这次升级如果**因为任何原因**失败，CloudFormation 的自动回滚会重跑**旧版**模板里的部署 Lambda，它去下旧版的 `im-code.zip` → HTTP 404 → 栈停在 `UPDATE_ROLLBACK_FAILED`（失败的是 `StagerArtifacts`）。v1.0.30 的代码管不到这一步：回滚跑的是旧模板里内联的旧代码和旧的 SHA256 清单。
>
> - **升级前**：在 update 向导的 **Stack failure options** 里选 **Preserve successfully provisioned resources**（命令行是 `aws cloudformation update-stack … --disable-rollback`）。这样升级万一失败，栈停在 `UPDATE_FAILED`、不自动回滚；修掉失败原因后直接再做一次升级到 v1.0.30 的 update —— 这期间**别点** Roll back。
> - **已经停在 `UPDATE_ROLLBACK_FAILED`**：
>
>   ```bash
>   aws cloudformation continue-update-rollback --stack-name <栈名> --region <区域> \
>     --resources-to-skip StagerArtifacts
>   ```
>
>   如果它又停在别的资源上、原因是 `NoSuchKey`，就用 CloudFormation 报 `UPDATE_FAILED` 的那几个逻辑 ID 作为 `--resources-to-skip` 再跑一次。回滚走完后，先修掉让升级失败的那个原因，再重新做一次升级到 v1.0.30 的 update。
>
> 这套恢复步骤是按机制推出来的，还没在真实的旧版 IM 栈上实测过。

**回滚**：用**旧版本的模板**再 update 一次。⚠️ 这不是"切回桶里现成的旧文件"：换了模板版本的 update 会让栈**重新从 GitHub（或你的镜像）下载**那个版本的产物（栈不会去复用桶里已有的），所以前提是那个旧 release 的产物都还在。装了 IM 的栈因此**不能**回滚到 v1.0.20–v1.0.29：那几个 release 的 `im-code.zip` 已经撤下，update 会在 `StagerArtifacts` 上以 HTTP 404 失败（失败后 CloudFormation 会把栈退回当前版本）。

> **staging 桶里的产物一直留着**（v1.0.30 起；v1.0.29 及更早的栈上有一条 7 天后自动删除的生命周期规则 `expire-staged-artifacts-7d`，升级到 v1.0.30 时去掉）。原因：AgentCore Runtime 的每次更新 —— 哪怕只是改了一个参数 —— 都要从这个桶重读一次 agent 包；产物过期后，只改 `EnableDeepInvestigation` / `DeployMode` / `CostAgentMcpUrl` 这类参数的更新会在 `AgentRuntime` 上失败（`S3 object not found in bucket`），回滚又要读同一个包、同样失败，栈停在 `UPDATE_ROLLBACK_FAILED`（2026-10-11 实测）。每个 release 约 165 MB，存储费可以忽略；删栈时这个桶会被清空。
>
> 🔴 **还在 v1.0.29 及更早、距上次安装 / 升级超过 7 天的栈**：别做只改参数的更新，**先升级到 v1.0.30**（换版本会重新下载产物）。已经卡在 `UPDATE_ROLLBACK_FAILED` 的话，先让回滚走完（失败事件里点名的若不是 `AgentRuntime`，就跳过那一个）：
>
> ```bash
> aws cloudformation continue-update-rollback --stack-name <栈名> --resources-to-skip AgentRuntime
> ```
>
> 到 `UPDATE_ROLLBACK_COMPLETE`（实测约半分钟）后升级到 v1.0.30，再改参数。

---

## 6. 删除这个栈

### 6.1 先决定数据怎么办

`TeardownMode` 参数决定删栈时下面三样东西的命运：

| | `KeepData`（默认） | `DeleteEverything` |
|---|---|---|
| `notiops-config` 表（配置） | **保留** | 删除 |
| `notiops-web-chat` 表（聊天历史、通知） | **保留** | 删除 |
| 数据桶 `notiops-data-…`（导出的报告等） | **保留** | 删除 |
| 其他一切（前端、CloudFront、Lambda、agent、**Cognito 用户池**，以及装了 IM 的话那 26 个资源含两张 IM 表） | 删除 | 删除 |
| IM 凭证（`notiops/im-bot-feishu` / `notiops/im-bot-dingtalk` / Slack 那两个 Secrets Manager secret，栈外资源） | **保留** | 删除（不可恢复） |
| `ProvisionCur=yes` 建的 CUR 报告、交付桶与 `notiops-cur-athena-<账号>` 栈（栈外资源） | **保留** | **保留**（有意的：那是你的账单历史，AWS 不会补发；同账号同区域重装时会被复用，最长约 4 小时接上，见 [§2.12](#212-可选接自己的-cur-数据源)） |

> ⚠️ **两种模式下 Cognito 用户池都会被删除** —— 也就是用户和密码都没了。`KeepData` 保的是
> **数据**，不是账号。

> ⚠️ **`KeepData` 不是"留着下次接着用"** —— 保留下来的表和桶会**挡住下一次部署**。
> 表名和桶名是固定的（`notiops-config` / `notiops-web-chat` / `notiops-data-…`），而
> CloudFormation 建栈前会做 `NAME_CONFLICT_VALIDATION` 预检：同名资源已存在就**整栈失败**，
> 约 9 秒，一个资源都不建（2026-08-28 实测，报错是
> `Resource of type 'AWS::DynamoDB::Table' with identifier 'notiops-config' already exists.`；
> 控制台的 Events 里只有一句 "Validation failed with 1 error(s)"，细节得用
> `aws cloudformation describe-events` 才看得到）。
> 所以 `KeepData` 的用途是**留一份数据在原地供你导出/取证**，不是给重新部署续命：
> - 想**重新部署**：先把这三样删掉（桶要先清空），或者干脆一开始就走 §6.2 的
>   `DeleteEverything`；
> - 想**保住数据**：删栈前先自己导出（表用 DynamoDB 的 Export to S3，桶用 `aws s3 sync`），
>   新栈起来后再导回去。栈本身没有"接管已存在的表"这种能力。

### 6.2 ⚠️ 想用 `DeleteEverything`：必须先 update，再 delete

CloudFormation 在删栈时交给自定义资源的是**上一次成功部署时的参数值**，不是你删栈那一刻想要的值。所以「在删栈对话框里改 TeardownMode」这件事**不存在**。正确做法：

```
1. Update 栈，只把 On stack delete 改成 DeleteEverything（实测 ~45 秒）
2. 然后 Delete 栈
```

顺序错了的后果是"沉默的"：栈删掉了，但表和桶还在，你以为清干净了。

### 6.3 删除

CloudFormation → 选中栈 → **Delete**。**实测**：`KeepData` ~**3 分 10 秒**；`DeleteEverything` ~**6 分 47 秒**（多出来的是清空并删掉两个桶 + 两张表那一段）。别照着 3 分钟的预期去等 `DeleteEverything`。

删栈过程中，栈里的部署 Lambda 会先把网站桶、staging 桶和（装了成本 MCP 时的）Athena 查询结果桶**清空**（非空的桶删不掉，会把整个删栈卡住），然后按 `TeardownMode` 决定要不要删那两张表和数据桶。数据桶由单独一步 `DataCleanup` 删，排在报告 CloudFront 分发**删完之后** —— 这个桶就是分发的源站（v1.0.32 及更早先删桶，分发还要再删几分钟，这段时间它指向一个已经不存在的桶名，桶名又是全局的、别人可以抢注）。2026-08 实测两种模式都是**零 `DELETE_FAILED`**。⚠️ 这句话在 v1.0.30 的预发布版上**一度不成立**：装了成本 MCP 的栈，部署 Lambda 缺查询结果桶的权限，删栈停在 `DELETE_FAILED`（2026-10-10 实测，已修；修复后同日重测 `DeleteEverything`：4 分 12 秒删完、零 `DELETE_FAILED`，查询结果桶里放了对象也照样清掉）。卡住了怎么收拾见 [§6.5](#65-删栈停在-delete_failedstagersite怎么办)。

> **聊天界面的 CloudFront 分发偶尔删不掉**：删栈停在 `DELETE_FAILED`，失败的是 `ChatCDN…`，原因是 `The distribution you are trying to delete has not been disabled`（CloudFront 409）。CloudFormation 已经把它禁用了，只是 CloudFront 那边还没同步过来。**再点一次 Delete 就行**（2026-10-25 实测碰到一次，重删 31 秒完成）。这时它的源站桶还在，不会出现分发指向不存在的桶。

### 6.4 会留下的东西（孤儿），要不要管

| 留下的 | 为什么 | 建议 |
|---|---|---|
| `/aws/vendedlogs/RUMService_notiops-web-chat<hash>` 日志组 | CloudWatch RUM 自己建的，不属于这个栈。名字里那段 `notiops-web-chat` 是 **RUM app monitor 的固定名字，不跟栈名走** —— 栈叫别的名字时照样是这一串 | **可以不管**：实测 0 字节，30 天后自动过期。想清就在 CloudWatch 里按这个**完整名字**删（别按前缀批量删） |
| `KeepData` 下的两张表 + 数据桶 | 这是 `KeepData` 的**本意** | 不再用了就手工删（桶要先清空）。**想在这个账号里重新部署就必须先删** —— 见 §6.1 的第二条警告 |
| CloudFront 的访问日志（如果你自己开过） | 不由这个栈管理 | 按需 |
| **装过 IM 的话**：`notiops/im-bot-feishu` / `notiops/im-bot-dingtalk` / `notiops/slack-bot-token` / `notiops/slack-signing-secret` 这几个 Secrets Manager secret | 它们不是栈内资源（三个平台的 secret 都由 Web 上「更多 → 管理 → 集成 IM」那一页按需创建），所以 `KeepData` 不会动它们 | `DeleteEverything` 会**连它们一起删**（不可恢复）。`KeepData` 下想清就自己删；留着的话下次重装同名 secret 会被直接复用 |
| **在「更多 → 管理 → 模型」存过 Bedrock API Key 或网关的话**：`notiops/bedrock-api-key` / `notiops/litellm-config` | 同上：不是栈内资源，由那一页首次保存时按需创建，所以 `KeepData` 不会动它们 | `DeleteEverything` 会**连它们一起删**（不可恢复）。`KeepData` 下想清就自己删；网关的 Key 要彻底作废，请在网关那边吊销 |
| **多账号模式下**：`notiops-member-onboarding` / `notiops-member-devops-agent` 两个 StackSet，以及 Organizations 对 StackSets 的信任访问 | **故意留的。** ① StackSet 要先删掉全部 stack instance 才删得掉，而那等于抹掉各成员账号里的跨账号角色 —— 这种跨账号的破坏性动作不该由"删一个栈"隐式触发；② 信任访问是**组织级**开关，删我们的栈就把它关掉会打断组织里别人的 StackSets 部署。 | 确实不要了：先在 CloudFormation → StackSets 里 **Delete stacks from StackSet**（删实例），再删 StackSet 本身。信任访问除非你确认没别人在用，否则别关。 |

**没有**其他孤儿：agent 的日志组、BFF 的日志组、「通知」函数的日志组、部署 Lambda 的日志组、IAM 角色、Cognito 用户池、RUM app monitor、AgentCore Runtime、网站桶、staging 桶 —— 实测全部随栈删除。⚠️ v1.0.30 预发布版**一度不成立**：新加的成本 MCP、CUR 阶段一 / 阶段二这三个函数没有栈内日志组，首次调用时 Lambda 自建的 `/aws/lambda/<栈名>-CostMcpFunction…` / `…CurProvisionerFn…` / `…CurFinalizerFn…` 不归栈管、删栈后留下、**永不过期**（2026-10-10 一次干净的删栈后实测留下了 `…CurProvisionerFn…`；已修，现在每个函数都写进栈内日志组，由判据逐个核）。这三个函数的执行角色也**不再带** `logs:CreateLogGroup`：Lambda 的日志是异步投递的，删栈时日志组被删掉之后，晚到的那几行原本会借这条权限把日志组重新建出来（同日 RC 往返实测过：删掉 1 秒后它又出现了），现在建不回来了。较早的函数里还有一些带着这条权限，所以仍有一个很窄的口子：某个函数恰好在删栈的最后几秒被调用时，它的日志组可能这样被重新建出来、留在账号里（已知问题）。遇到了就在 CloudWatch 里按完整名字删掉。选了 `ProvisionCur=yes` 的话，账号里还会留着 `notiops-cur-athena-<账号>` 栈里 AWS 官方模板那两个 Lambda 的日志组（`…AWSCURInitializer…` / `…AWSS3CURNotification…`）—— 它们跟着那个栈一起**有意保留**（见 §6.5 末尾），不是这个栈的孤儿。深度调查建的 Agent Space 与关联也随栈删除（它是栈里的普通资源）。会话记忆的 AgentCore Memory（[§2.10](#210-会话记忆agentcore-memory)）同理 —— 它是栈里的普通资源、**没有**保留策略，随栈删除，里面存的会话消息一起消失（这条是按模板声明说的，还没像上面那串一样删栈实测过）。联网搜索的 AgentCore Gateway 分两种：**这个栈建出来的**随栈删除；**它复用的别人的**（同账号里已经存在的 `notiops-websearch-gw`，比如 `setup.sh` 建的）留着不动 —— 删一个栈不该顺手拆掉另一条部署路径还在用的东西。

### 6.5 删栈停在 `DELETE_FAILED`（StagerSite）怎么办

`StagerSite` 就是上面那个「先清空、再按 `TeardownMode` 收尾」的步骤。它失败时，**失败原因里会逐条列出没做成的每一步**（哪个桶 / 表 / secret、哪个 API、什么错误码）—— 先看这一行，再按下面做。`DELETE_FAILED` 的栈**不能再 update**，所以只能把没做完的事手工补上，然后让 CloudFormation 跳过这一步。删数据桶那一步（`DataCleanup`，只在 `DeleteEverything` 时干活）失败时同理：失败原因里同样列出那个桶，第 2 步改成 `--retain-resources DataCleanup`（两步都失败就两个都写上），再按第 3 步把那个桶删掉：

```bash
# 1. 把失败原因里列出的桶清空（只清列出来的那几个）
aws s3 rm s3://<失败原因里列出的桶> --recursive

# 2. 重试删栈，跳过 StagerSite（它是自定义资源，没有对应的实体，跳过它本身无副作用）
aws cloudformation delete-stack --stack-name <栈名> --retain-resources StagerSite
```

⚠️ **跳过 StagerSite 就等于跳过了它的收尾** —— 如果你选的是 `DeleteEverything`，下面这些不会再有人替你删，栈删完之后要自己删：两张表（`notiops-config` / `notiops-web-chat`）、§6.4 表里那几个 `notiops/*` secret（存在的话）、`/aws/bedrock-agentcore/runtimes/` 下这个栈的 agent 日志组。数据桶 `notiops-data-<账号>-<区域>` 不在其中（它归 `DataCleanup`）—— 只有跳过了 `DataCleanup`，或者栈还是 v1.0.32 及更早的版本（那时数据桶也在 StagerSite 里删）时，才要自己删它（先清空；**里面有 Skill 与导出的报告，要留就先导出**）。选的是 `KeepData` 的话，那两张表和数据桶本来就是留下的，不用管。CUR 相关（报告、交付桶、`notiops-cur-athena-<账号>` 栈）任何模式都**保留**，这是有意的。

```bash
# 3. 只在选了 DeleteEverything 时需要：补上被跳过的收尾。不补的话，同账号同区重装会因为同名的表 / 桶
#    在第一步预检就整栈失败（约 9 秒，见 §6.1 的第二条警告）
aws dynamodb delete-table --table-name notiops-config
aws dynamodb delete-table --table-name notiops-web-chat
# 数据桶：只在跳过了 DataCleanup、或栈是 v1.0.32 及更早时需要
aws s3 rb s3://notiops-data-<账号>-<区域> --force   # --force = 先清空再删；要留 Skill / 报告就先导出
aws logs delete-log-group --log-group-name /aws/bedrock-agentcore/runtimes/<runtime id>-DEFAULT
# §6.4 表里那几个 notiops/* secret，存在的才删：
aws secretsmanager delete-secret --secret-id notiops/<名字> --force-delete-without-recovery
```

---

## 7. 无公网出口：用私有 S3 镜像

如果你的账号出不了公网（或企业策略不允许从 github.com 拉可执行代码），可以把产物**先镜像到一个 S3 桶**，让栈从那里取。桶**可以完全私有**（Block Public Access 全开）——部署 Lambda 用它自己的角色签名去读，走的是 S3 API，不需要公网。

**一次性准备**（由一个有凭证的人做，之后所有账号/团队都能复用这一份镜像）：

```bash
# 1. 从 release 下载那九个 zip 和 SHA256SUMS，放进同一个目录。要传哪些以 SHA256SUMS 为准：
#    它一行一个 zip，与仓库里 scripts/artifacts.py 的清单是同一份（python3 scripts/artifacts.py all 打印的那九个）
# 2. 在那个目录里把它们全部传进一个桶（桶要和你开栈的区域同区）
for f in $(awk '{print $2}' SHA256SUMS); do
  aws s3 cp "$f" s3://my-mirror/notiops/v1.2.3/
done
```

**九个都传上去**最省事 —— 栈只取它用得到的那几个，以后打开 IM 或成本选项也不用回来补。只想镜像必需的也行：`bff.zip` / `chat-dist.zip` / `web-notif.zip` / `agent-code.zip` 每次都要；两个 `im-*.zip` 只在装 IM 机器人（§2.11）时要；两个 `cost-mcp-*.zip` 只在让本栈自建成本 MCP（§2.12：填了 `CurTable` 或选了 `ProvisionCur=yes`；用 `CostAgentMcpUrl` 外接的不算）时要；`cur-provisioner.zip` 只在 `ProvisionCur=yes` 时要。少了一个用得到的，栈会在 `StagerArtifacts` 上失败（症状和怎么补见 §4.1）。

**升级时**把新版本传进一个**新的**目录（像上面的 `v1.2.3/` 一样一个版本一个目录），update 时把 **Artifact base URL override** 改成它；旧目录等 update 成功之后再清。update 一旦失败，自动回滚会从旧目录把旧版文件按旧的 SHA256 再取一遍 —— 旧文件没了或被覆盖，栈就停在 `UPDATE_ROLLBACK_FAILED`。

**开栈时填两个参数**：

| 参数 | 填什么 |
|---|---|
| **Artifact base URL override** | `s3://my-mirror/notiops/v1.2.3`（**不要**结尾斜杠；文件名由模板拼） |
| **Artifact mirror bucket name (s3:// only)** | `my-mirror` —— 部署 Lambda 只会被授予**这一个桶**的 `s3:GetObject`，别的什么都没有 |

跨账号也行：桶策略允许部署账号读即可（`Code.S3Bucket` 允许跨账号，但**必须同区域**）。

镜像的完整性照样有保障：模板里每个产物的 SHA256 都是按 release 里的原始文件算的，镜像内容被换过会当场校验失败、栈 CREATE_FAILED。

`https://` 形式也支持（`https://host/path`），但那是**不带任何凭证**的普通 GET —— 对象必须匿名可读。私有场景请用 `s3://`。

---

## 8. 安全说明（值得知道的几条）

1. **只读**：agent 的授权全是只读，产品里也没有修改资源的工具。唯一的对外动作是开 Support 案例，且需要你在对话里确认。
2. **接口有鉴权**：BFF 的 Function URL 是 `AWS_IAM`（SigV4）—— 就算地址泄漏了，没有签名也调不动。上面还叠了一层 Cognito 身份校验。
3. **代码从公网进你的账号**：这是这条部署路径的实质。两条控制措施：① 只从固定 tag 的
   `aws-samples/sample-notiops` release 取；② 每个产物的 SHA256 写死在模板里、下载后当场校验，
   不匹配就删掉已上传的对象并让栈失败。不接受这个前提的话，请走 [§7](#7-无公网出口用私有-s3-镜像) 的私有镜像，或走 `setup.sh`。
4. **管理员密码我们碰不到**：临时密码由 Cognito 生成并直接发给你。部署流程不传、不读、不打印、不放进 Outputs。
5. **你自己的凭证做的所有动作**：整条链路上没有我们的账号、我们的桶、我们的角色。
6. **装了 IM 就多一个公网入口**（[§2.11](#211-加装-im-机器人飞书larkslack-或钉钉)）——那个 **API Gateway HTTP API** 必须是**未鉴权**的，因为飞书/Slack/钉钉都不会给你签 SigV4（2026-09-01 之前这里是 Lambda Function URL，为什么换、以及被否掉的两个替代方案，见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §5.1）。五道边界：① **验签**（飞书用 Encrypt Key + Verification Token，Slack 用 signing secret，钉钉用 AppSecret 校验请求头里的 `sign`（带 1 小时时间窗），缺钥匙就冷启动失败，不存在"没配好也能进"）；② **两层限流** —— HTTP API 阶段级 50 req/s、突发 100（超出的请求由 API Gateway 直接 429，**不进 Lambda**），入口函数上再叠**并发上限 10**，这是公网未鉴权入口的花费天花板；③ 可选的**群允许清单**（只让指定群里的消息生效，见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §4；钉钉这一层落在 worker、在验签之后，因为 `conversationId` 要验签才解得出来）；④ **幂等去重**（同一个事件重复投递只处理一次）；⑤ 到了后端仍然是**同一个只读 agent**，没有任何写权限 —— 即使有人伪造了一条消息，最坏结果也是读到只读信息。凭证一律放 Secrets Manager，不进环境变量、不打印在日志里。还剩下的风险如实列在 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §5.3。
7. **登录两步验证（验证器 App）**：参数 **Two-step verification at web sign-in**（`MfaMode`），三档：`OPTIONAL`（默认：每个人在左下角菜单自己开，「管理」页要求先开）/ `REQUIRED`（所有人下次登录时绑定，之后每次都要 6 位验证码）/ `OFF`（只用密码）。只开验证器 App（TOTP），不开短信 / 邮件验证码（前者要配 SNS、新账号在沙箱里发不出去；后者要把用户池升到付费档并自己配 SES）。二维码在浏览器里生成；绑定和验证码都在浏览器与 Cognito 之间完成，BFF 不经手。IM 机器人不受影响。用户手机丢了：管理员在 **管理 → 用户** 里点 **重置两步验证**（会同时退出他所有会话）。**唯一的管理员自己丢了手机**：有这个账号权限的人用 AWS CLI 删掉他登记的验证器（CLI 要 2.36.33 及以上，`aws --version` 看版本），他再重新绑定：`REQUIRED` 档是下次登录时，`OPTIONAL` 档是打开「管理」页时（`setup.sh` 部署同样适用；用户池 id 在 Cognito 控制台里找名为 `notiops-users` 的那个，或者看 `ChatUrl` 下 `config.json` 里的 `cognitoUserPoolId`）：

   ```bash
   aws cognito-idp admin-delete-software-token --region <区域> --user-pool-id <用户池 id> --username admin
   ```

   只用 `admin-set-user-mfa-preference` 关掉偏好不够：`REQUIRED` 档下 Cognito 照样要丢了的那个验证器的码。

---

## 9. 接下来

- [USER_GUIDE.md](USER_GUIDE.md) — 界面怎么用、有哪些主题（成本、故障调查、Support 案例、Skills…）
- [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) — 装了 IM 机器人（[§2.11](#211-加装-im-机器人飞书larkslack-或钉钉)）之后，在飞书/Slack/钉钉那边要点什么
- [DEPLOYMENT.md](DEPLOYMENT.md) — 想要自动巡检（连同巡检看板）、往 IM 主动推送时，走完整版部署
- [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md) — 架构与设计取舍
