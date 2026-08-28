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
> - [DEPLOYMENT.md](DEPLOYMENT.md) — 完整部署手册（`setup.sh` 路径：IM bot、巡检、仪表盘、CUR/Athena 全量功能）
> - [USER_GUIDE.md](USER_GUIDE.md) — 部署完之后怎么用

---

## 0. 先搞清楚：两条部署路径，这篇讲哪一条

仓库里有**两条**部署路径，功能范围不同。这篇只讲第二条。

| | **`setup.sh`**（完整版，见 [DEPLOYMENT.md](DEPLOYMENT.md)） | **本篇：一键部署** |
|---|---|---|
| 你要准备什么 | git、Node、Python、AWS CDK、Docker/finch + 一份能部署的 AWS 凭证 | **只要一个能登进 AWS 控制台的浏览器** |
| 怎么开始 | clone 仓库 → `./setup.sh` | 从 Release 下一个模板文件 → 在 CloudFormation 控制台上传 |
| 部署内容 | Web Chat + IM bot（飞书/Slack）+ 每日巡检 + 管理仪表盘 + CUR/Athena FinOps 数据源 | **只有 Web Chat**（聊天界面 + BFF + agent + DevOps Agent Agent Space；可选多账号） |
| 适合 | 长期使用、要 IM 推送和自动巡检 | 先试用 / 演示 / 只要浏览器里那个只读运维助手 |

**两条路径可以先后走**：先一键部署试用，之后想要 IM 和巡检，再按 [DEPLOYMENT.md](DEPLOYMENT.md) 跑 `setup.sh`（两边建的管理员用户名都是 `admin`，不会打架）。

### 0.1 一键部署**不包含**什么

说清楚比事后惊讶好。下面这些**这条路径不部署**，需要 `setup.sh`：

- **IM bot**（飞书 / Slack / 钉钉）——包括往 IM 推送告警。（同样这 10 类信号源**会**进浏览器里的「通知」收件箱，见 [§2.9](#29-通知收件箱)；不进的只是 IM。）
- **每日自动巡检**（闲置资源检测、成本异常扫描）与它的 5 个 Lambda。
- **管理仪表盘**（阈值配置、目标账户管理、Skills 管理界面）——一键部署只有聊天界面。
- **CUR + Athena 成本明细数据源**：FinOps 提问仍可用 Cost Explorer 口径，但没有账单明细级下钻。
- **跨账号的自动巡检与事件推送**：一键部署可以做**跨账号只读排查/调查/开案例**（`DeployMode=MultiAccount`，见 [§2.6](#26-可选多账号组织内跨账号)），但成员账号侧的 **CloudWatch OAM Sink** 与 **跨账号事件转发**（Health / DevOps Agent 调查事件回流）不在这条路径里 —— 那两样要 `setup.sh`。

（**DevOps Agent 深度调查**、**联网搜索**、**「通知」收件箱**都**不**在此列 —— 这三样都由这个栈自动建好，分别见 [§2.7](#27-深度调查aws-devops-agent)、[§2.8](#28-联网搜索agentcore-web-search)、[§2.9](#29-通知收件箱)。）

---

## 1. 前置条件（三条，都要满足）

### 1.1 一个能开栈的 AWS 账号 + 控制台权限

你的身份需要能创建 CloudFormation 栈以及栈里的资源（IAM 角色、Lambda、DynamoDB、S3、CloudFront、Cognito、Bedrock AgentCore）。**没有 `AdministratorAccess` 也能做**，但权限太窄会在开栈中途失败；如果不确定，先用一个测试账号。

> 开栈时必须勾选 **"I acknowledge that AWS CloudFormation might create IAM resources"** ——
> 这个栈要为 agent 和 BFF 建角色。

### 1.2 选好区域，并在该区域开通 Bedrock 模型访问

agent 跑在 **Amazon Bedrock** 上。**先去 Bedrock 控制台 → Model access，确认你要用的模型在这个区域是「Access granted」**，再来开栈。

- **默认模型是 Anthropic 的 Claude Sonnet 5**（`global.anthropic.claude-sonnet-5`）—— 这一个必须开通，否则装完不能用。
- 想用别的模型（Claude Opus 5 / Haiku 4.5、Amazon Nova Pro、DeepSeek、GLM 5、xAI Grok 4.6、GPT-5.6 系列）就把对应的也一起开通；用户在聊天页右上角可以按会话切换。
- 推荐 **us-east-1** 或 **us-west-2**（Bedrock AgentCore 与模型覆盖最全）。
- 没开通模型访问时，栈会**开成功**、页面能打开、登录也没问题，但一提问就报 `AccessDeniedException`。这是最常见的"部署完了不能用"。

### 1.3 这个账号要能访问 GitHub（或者准备一个私有镜像）

部署过程中，栈里的一个 Lambda 会去 **GitHub Release** 下四个产物（前端、BFF、「通知」生产端、agent 代码）搬进你自己的 S3 桶。Lambda 默认不在 VPC 里、走 AWS 托管的公网出口，**绝大多数账号天然满足**。

企业环境如果**出口白名单不含 github.com**，不必放弃这条路径 —— 见 [§7 无公网出口：用私有 S3 镜像](#7-无公网出口用私有-s3-镜像)。

---

## 2. 部署（5 步）

### 2.1 下模板

打开 [Releases](https://github.com/aws-samples/sample-notiops/releases) 页，从最新的 release 里下载：

```
notiops-webchat.template.json
```

同一个 release 里还有四个产物（`bff.zip` / `chat-dist.zip` / `web-notif.zip` / `agent-code.zip`）——**不用下**，模板会让你的账号自己去取。模板里写死了这四个文件的 SHA256，下载后当场校验，不匹配就让开栈失败。

> **为什么不是"点一下就开栈"的 Launch Stack 链接？** CloudFormation 的 `TemplateURL` 只接受
> S3 上的对象，不接受 GitHub 的 URL。所以这里多两步点击（下载 + 上传），换来的是我们
> **不托管任何东西**：产物只在 GitHub Release 上，代码进你账号的每一步都是你自己的凭证在动。

### 2.2 在 CloudFormation 控制台上传

1. 确认右上角**区域**是你在 §1.2 选好的那个。
2. **CloudFormation** → **Create stack** → **With new resources (standard)**。
3. **Choose an existing template** → **Upload a template file** → 选刚下的 `notiops-webchat.template.json` → **Next**。
   （控制台会自己把模板存进 CFN 托管的 S3，你不需要有桶。）

### 2.3 填参数

**Stack name** 填 `notiops`（下面的文档都按这个名字写；换名字也行，DynamoDB 表名固定为 `notiops-config` / `notiops-web-chat`，与栈名无关）。

只有**一个参数必填**：

| 参数 | 说明 |
|---|---|
| **Administrator email** | 你的邮箱。栈开完后 Cognito 会往这里发一封带**临时密码**的邮件。必须是真实可收的邮箱 —— **这是唯一的入口**。 |

其余都有安全的默认值，第一次部署**建议全部不动**：

| 参数 | 默认 | 什么时候才需要改 |
|---|---|---|
| **Give the agent account-wide read-only access?** | `Yes` | 选 `Yes` 会给 agent 挂上 AWS 托管的 `ReadOnlyAccess`，于是它能回答这个账号里任何资源的问题。选 `No` 则只保留精选的只读授权（成本、日志、指标、RDS/EC2 describe），有些问题会答不了并明确告诉你缺哪条 action。**两种选择都不给任何写权限。** |
| **CORS allowed origins** | `*` | 接口本身已经是 `AWS_IAM`（SigV4）鉴权，`*` 不构成越权。想再收一层，可以在第一次部署完之后 update 栈、把它设成 `ChatUrl` 那个地址。 |
| **On stack delete** | `KeepData` | 决定删栈时你的数据怎么办。见 [§6 删除](#6-删除这个栈)——**改这个值有个坑，删栈前先读那一节**。 |
| **Deployment mode** | `SingleAccount` | 想让它同时看组织里**其它**账号，就选 `MultiAccount` 并填下面的 org id。有前置条件，见 [§2.6](#26-可选多账号组织内跨账号)。 |
| **AWS Organizations id (MultiAccount only)** | 空 | 只有选了 `MultiAccount` 才填（`o-` 开头）。**只填一半不生效**（选了 MultiAccount 但 org id 留空 = 仍是单账号），Outputs 的 `DeployModeStatus` 会告诉你。 |
| **Enable deep investigation (AWS DevOps Agent)?** | `Yes` | 见 [§2.7](#27-深度调查aws-devops-agent)。闲置不计费，所以默认开着；不想要就选 `No`。 |
| **Artifact base URL override** / **Artifact mirror bucket name (s3:// only)** | 空 | 只有拿不到 GitHub 时才填，见 [§7](#7-无公网出口用私有-s3-镜像)。 |

### 2.4 勾 IAM 确认框，开栈

**Next** → 到最后一页勾上 **"I acknowledge that AWS CloudFormation might create IAM resources"** → **Submit**。

**实测耗时约 4.5 分钟**（两次独立测量：4m16s / 4m25s，us-east-1）。中途你会看到栈在等两个
`Custom::NotiOpsStager…` 资源 —— 那是它在把 ~165 MB 产物从 GitHub 搬进你的 S3 桶、
解压前端、写运行时配置、建管理员用户。

### 2.5 登录

栈变 **CREATE_COMPLETE** 后，去 **Outputs** 页：

| Output | 是什么 |
|---|---|
| **ChatUrl** | 聊天界面地址（CloudFront）。**打开这个。** |
| **ChatBffUrl** | 后端接口地址（前端自己会用，你不用管） |
| **NextSteps** | 一句话的登录指引 |
| **InstalledRelease** | 这个栈当前装的是哪个 release |
| **DataRetentionOnDelete** | 当前 `TeardownMode` 下，删栈会对数据做什么 |
| **WebChatTableName** | 存聊天历史与通知的 DynamoDB 表名（想自己查数据、或删栈后手工清理时用） |
| **DeployModeStatus** | 单账号还是多账号**实际生效**的那个。选了 `MultiAccount` 却忘了填 org id，这里会明说"仍是单账号"。 |
| **DeepInvestigationStatus** | 深度调查是开着、你自己关了、还是**因为这个区域没有 AWS DevOps Agent 被跳过**。 |
| **DevOpsAgentSpaceId** | 深度调查开着时才有：栈给你建的 Agent Space id。 |
| **WebSearchStatus** | 这个区域**支持不支持**联网搜索（不是 us-east-1 就整块跳过，见 [§2.8](#28-联网搜索agentcore-web-search)）。 |
| **WebSearchProvisioning** | 区域支持时才有：Gateway **到底建成了没有**。`enabled` = 开关可用；`unavailable (<错误码>)` = 建失败，开关点了没结果（栈本身照样成功，见 [§2.8](#28-联网搜索agentcore-web-search)）。 |

打开 `ChatUrl`，用：

- **用户名：`admin`**（不是邮箱；邮箱也能登，它被配成了别名）
- **密码**：邮件里的临时密码，首次登录会要求你改成新密码

> 📧 **收不到邮件？** 发件人是 `no-reply@verificationemail.com`（Cognito 默认发信），
> 主题 `Your temporary password`。**企业邮箱常常给它打上 `[EXTERNAL]` 标记或直接丢进垃圾邮件**
> —— 先翻垃圾箱。实测在 us-east-1 从栈完成到收信约 1 分钟。
>
> 真的丢了：Cognito 控制台 → 该 user pool → Users → `admin` → 重设密码。

登录后建议先问一句 `列出这个账号里的 EC2 实例` 之类的，确认 agent 真的能答（顺便验证 §1.2 的模型访问）。

### 2.6 （可选）多账号：组织内跨账号

默认的 `SingleAccount` 只看部署它的这个账号。想让它同时看组织里其它账号，开栈时把 **Deployment mode** 选成 `MultiAccount` 并填 **AWS Organizations id**。

**前置条件（不满足就别选）**：

1. 你部署的这个账号是**组织管理账号**，或者是 **StackSets 的委派管理员**（delegated administrator）。这是硬性的 —— 建成员账号 StackSet 需要这个身份。
2. 你知道自己的 org id（`o-` 开头）。控制台 **AWS Organizations** 首页就有，或 `aws organizations describe-organization --query Organization.Id`。

**两个都要填。** 只选了 `MultiAccount` 但 org id 留空，栈会**照样开成功、但仍是单账号** —— 这是故意的：org id 是跨账号信任策略里 `aws:PrincipalOrgID` 那道收口条件，没有它，成员账号里的角色就只是"信任系统账号 root"而没有组织边界，不如干脆不开。Outputs 的 `DeployModeStatus` 会把这件事说出来。

**多了什么**：栈会在你这个账号里建两个 StackSet（`notiops-member-onboarding`、`notiops-member-devops-agent`），并打开 Organizations 对 StackSets 的信任访问。之后在 Web 界面的**管理 → 账户**页把成员账号一个个接进来（每个成员账号里会创建一个跨账号**只读**角色 + 一个深度调查触发角色）。接进来之后，你就能在聊天界面切换账号做只读排查、深度调查、开案例。

**这条路径**仍然**没有**：成员账号的 CloudWatch OAM Sink、跨账号 Health / 调查事件回流、跨账号定时巡检。那三样要 `setup.sh`。

> ⚠️ **删栈不会删这两个 StackSet**，也不会关掉信任访问。理由见 [§6.4](#64-会留下的东西孤儿要不要管)。

### 2.7 深度调查（AWS DevOps Agent）

**Enable deep investigation** 默认 `Yes`：栈会顺手建一个 **AWS DevOps Agent Agent Space**（名字 `notiops-oneclick-<账号 id>`）并把本账号以 **monitor（只读）** 身份关联进去。有了它，聊天界面里**所有 DevOps Agent 相关能力**才能用 —— 那是把一个问题交给 AWS 托管的 DevOps Agent 去多轮自主排查，比一次问答挖得深。

具体是这四样，都依赖这同一个 Agent Space（没有它，对应的开关会**置灰并写清原因**）：

| 能力 | 这一轮谁在答 | 说明 |
|---|---|---|
| **深度调查** | DevOps Agent（NotiOps 先把你的问题整理成调查请求） | 多信号根因排查、出 HTML 报告，通常几分钟 |
| **深度调查（直连）** | DevOps Agent（**绕过大模型**直连 API） | 同一个深度调查，**不消耗 token**；代价是调查描述按你的原话透传 |
| **DevOps 对话** | DevOps Agent **直接回答**（通用聊天里选「对话对象 = DevOps Agent」） | 流式问答，体验与 DevOps Agent 自己的页面一致；**NotiOps 侧 0 token**、**免模型配置**（不需要在 Bedrock 开通任何模型），用量计入你自己的 DevOps Agent |
| **把 Skill 发布到 DevOps Agent** | — | 把自建 Skill 推到 Agent Space，供上面「深度调查」那条路径使用 |

> 💡 后两样对**还没在 Bedrock 开通模型**的新部署特别有用：选 DevOps Agent 直答就能先跑起来。

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

**没有参数，栈自动建好。** 左侧导航第一项「通知」里那个收件箱，内容由 **10 条 EventBridge 规则** → 一个 Lambda（`notiops-web-notif-handler`，归一化 + 5 分钟去重）→ 写进 `notiops-web-chat` 表来的。前端 **60s 轮询**一次，所以最长约 1 分钟延迟；左侧红点只统计**未读**。

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

---

## 3. 这个栈建了什么

默认参数下 **65 个**资源，都在你自己的账号里（部署在 us-east-1 会再多 3 个 —— 联网搜索那套；关掉深度调查少 4 个；选上多账号多 3 个）：

| 类别 | 资源 |
|---|---|
| 前端 | S3 网站桶 + CloudFront distribution + CloudWatch RUM；报告下载走另一个 CloudFront distribution（带一个只放行报告路径的 CloudFront Function） |
| 接口 | 1 个 Lambda（BFF）+ Function URL（`AWS_IAM` 鉴权，流式返回） |
| Agent | 1 个 Bedrock AgentCore Runtime |
| 登录 | Cognito User Pool + Client + Identity Pool + 8 个用户组（角色） |
| 数据 | DynamoDB `notiops-config`、`notiops-web-chat`；1 个数据桶（报告等） |
| 部署辅助 | 1 个 staging 桶（放搬进来的产物）+ 1 个内联的部署 Lambda + 2 个自定义资源 |
| 权限 | 5 个 IAM 角色 + 5 个内联策略 |
| 「通知」收件箱（见 [§2.9](#29-通知收件箱)） | **10 条 EventBridge 规则**（5 条 ENABLED / 5 条 DISABLED）+ 1 个 Lambda + 它的日志组 + 1 个角色（+ 策略）+ 1 条 Lambda 调用许可 = 15 个 |
| 深度调查（默认开） | 1 个 DevOps Agent Agent Space + 1 个只读关联 + 1 个被 DevOps Agent 假设的角色（+ 它的策略） |
| 联网搜索（仅 us-east-1） | 1 个自定义资源（去建 AgentCore Gateway）+ 1 个 Gateway 服务角色 + 1 个内联策略 |
| 多账号（可选） | 1 个自定义资源（去建两个成员账号 StackSet）+ 2 个内联策略 |

**成本量级**（空闲时）：CloudFront + S3 + DynamoDB 按量、Lambda 不调用不计费、AgentCore Runtime 空闲不计费 —— 不用的时候基本只有几毛钱的存储。真正花钱的是**提问时的 Bedrock token**。staging 桶里每个 release 约 **165 MB**（S3 标准存储 ≈ $0.004/月），升级不会自动清掉旧版本，见 [§5](#5-升级到新版本)。

**只读设计**：agent 拿到的全是只读授权，产品层面也没有任何"改你资源"的工具。它能做的最大动作是**开一个 AWS Support 案例**（且需要你在对话里确认）。

---

## 4. 出问题了怎么办

### 4.1 栈 ROLLBACK 了 —— 先看是哪个资源失败

Events 页，找第一条 `CREATE_FAILED`（不是最后一条）。常见的两类：

| 症状 | 原因与处置 |
|---|---|
| `StagerArtifacts` 失败，日志里有超时/连不上 | 这个账号出不了公网、拉不到 GitHub。走 [§7](#7-无公网出口用私有-s3-镜像)。 |
| `AgentRuntime` 失败 | 该区域可能不支持 Bedrock AgentCore。换 us-east-1 / us-west-2。 |
| `StagerOrgSetup` 失败，提到 `management account or a delegated administrator` | 你选了 `MultiAccount`，但这个账号既不是组织管理账号也不是 StackSets 委派管理员。改回 `SingleAccount` 重开，或者换个够格的账号。见 [§2.6](#26-可选多账号组织内跨账号)。 |

详细日志在 CloudWatch 日志组 `/aws/lambda/notiops-stager`（把 `notiops` 换成你的栈名）。

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

（如果第一次部署已经用过、里面有你想留的数据，就**不要**删表/桶 —— 重开栈时它们会被复用。）

### 4.3 页面打开是白屏 / 404

CloudFront 分发要几分钟才在全球生效。先等 2–3 分钟、强刷一次。仍然不行：确认 Outputs 里的
`ChatUrl` 是完整的 `https://xxx.cloudfront.net`，并检查网站桶里有 `index.html`、`config.json` 和 `assets/`。

### 4.4 登录成功但提问报错

- `AccessDeniedException` 提到 `bedrock` → §1.2 的模型访问没开。
- 报错提到某个具体 action（比如 `rds:DescribeDBInstances`）→ 你把 **Give the agent account-wide read-only access** 选成了 `No`。要么按提示补授权，要么 update 栈改回 `Yes`。

### 4.5 想用命令行而不是控制台

可以，但有两个坑：

```bash
# 模板 ~140 KB > --template-body 的 51,200 字节上限 ⇒ 必须先传 S3、用 --template-url
aws s3 cp notiops-webchat.template.json s3://<你的桶>/notiops-webchat.template.json
aws cloudformation create-stack --stack-name notiops \
  --template-url https://<你的桶>.s3.<区域>.amazonaws.com/notiops-webchat.template.json \
  --capabilities CAPABILITY_IAM \
  --parameters ParameterKey=AdminEmail,ParameterValue=you@example.com
# 多账号：再加两个参数（缺一不生效，见 §2.6）
#   ParameterKey=DeployMode,ParameterValue=MultiAccount \
#   ParameterKey=OrganizationId,ParameterValue=o-xxxxxxxxxx
```

漏了 `--capabilities CAPABILITY_IAM` 会被直接拒（栈里有 IAM 角色）。

---

## 5. 升级到新版本

新 release 出来后：**下新版模板 → update 现有栈**（不要新开一个栈）。

1. 从新 release 下 `notiops-webchat.template.json`。
2. CloudFormation → 选中你的栈 → **Update** → **Replace existing template** → **Upload a template file**。
3. 参数保持 **Use existing value**（除了你确实想改的）→ 勾 IAM → Submit。

**实测 ~1 分钟**。升级过程中会发生：新产物搬进 staging 桶（key 里带 release tag，所以旧版本对象仍在）
→ 前端重新发布并清掉上一版残留文件 → CloudFront 缓存失效（`/*`）→ AgentCore Runtime **原地**出一个新版本（ARN 不变，前端配置不用动）。

**升级不会**：重发邀请邮件、改管理员的邮箱或密码、动 `config.json` 里已有的配置、清空你的聊天历史。

**回滚**：用**旧版本的模板**再 update 一次即可（产物按 tag 存在 staging 桶里，旧对象还在）。

> **staging 桶会累积**：每个装过的 release 留 ~165 MB。想清理就手工删 staging 桶里
> `agent/<旧tag>/` 和 `frontend/<旧tag>/` 前缀下的对象 —— **别删当前 release 的**，
> 那会让下一次栈更新找不到代码。

---

## 6. 删除这个栈

### 6.1 先决定数据怎么办

`TeardownMode` 参数决定删栈时下面三样东西的命运：

| | `KeepData`（默认） | `DeleteEverything` |
|---|---|---|
| `notiops-config` 表（配置） | **保留** | 删除 |
| `notiops-web-chat` 表（聊天历史、通知） | **保留** | 删除 |
| 数据桶 `notiops-data-…`（导出的报告等） | **保留** | 删除 |
| 其他一切（前端、CloudFront、Lambda、agent、**Cognito 用户池**） | 删除 | 删除 |

> ⚠️ **两种模式下 Cognito 用户池都会被删除** —— 也就是用户和密码都没了。`KeepData` 保的是
> **数据**，不是账号。重新部署后需要用新收到的临时密码重新登录（数据还在）。

### 6.2 ⚠️ 想用 `DeleteEverything`：必须先 update，再 delete

CloudFormation 在删栈时交给自定义资源的是**上一次成功部署时的参数值**，不是你删栈那一刻想要的值。所以「在删栈对话框里改 TeardownMode」这件事**不存在**。正确做法：

```
1. Update 栈，只把 On stack delete 改成 DeleteEverything（实测 ~45 秒）
2. 然后 Delete 栈
```

顺序错了的后果是"沉默的"：栈删掉了，但表和桶还在，你以为清干净了。

### 6.3 删除

CloudFormation → 选中栈 → **Delete**。**实测 ~3 分 10 秒**（两种模式都一样）。

删栈过程中，栈里的部署 Lambda 会先把网站桶和 staging 桶**清空**（非空的桶删不掉，会把整个删栈卡住），然后按 `TeardownMode` 决定要不要删那两张表和数据桶。实测两种模式都是**零 `DELETE_FAILED`**。

### 6.4 会留下的东西（孤儿），要不要管

| 留下的 | 为什么 | 建议 |
|---|---|---|
| `/aws/vendedlogs/RUMService_<栈名>-web-chat<hash>` 日志组 | CloudWatch RUM 自己建的，不属于这个栈 | **可以不管**：实测 0 字节，30 天后自动过期。想清就在 CloudWatch 里按这个**完整名字**删（别按前缀批量删） |
| `KeepData` 下的两张表 + 数据桶 | 这是 `KeepData` 的**本意** | 不再用了就手工删（桶要先清空） |
| CloudFront 的访问日志（如果你自己开过） | 不由这个栈管理 | 按需 |
| **多账号模式下**：`notiops-member-onboarding` / `notiops-member-devops-agent` 两个 StackSet，以及 Organizations 对 StackSets 的信任访问 | **故意留的。** ① StackSet 要先删掉全部 stack instance 才删得掉，而那等于抹掉各成员账号里的跨账号角色 —— 这种跨账号的破坏性动作不该由"删一个栈"隐式触发；② 信任访问是**组织级**开关，删我们的栈就把它关掉会打断组织里别人的 StackSets 部署。 | 确实不要了：先在 CloudFormation → StackSets 里 **Delete stacks from StackSet**（删实例），再删 StackSet 本身。信任访问除非你确认没别人在用，否则别关。 |

**没有**其他孤儿：agent 的日志组、BFF 的日志组、部署 Lambda 的日志组、IAM 角色、Cognito 用户池、RUM app monitor、AgentCore Runtime、网站桶、staging 桶 —— 实测全部随栈删除。深度调查建的 Agent Space 与关联也随栈删除（它是栈里的普通资源）。联网搜索的 AgentCore Gateway 分两种：**这个栈建出来的**随栈删除；**它复用的别人的**（同账号里已经存在的 `notiops-websearch-gw`，比如 `setup.sh` 建的）留着不动 —— 删一个栈不该顺手拆掉另一条部署路径还在用的东西。

---

## 7. 无公网出口：用私有 S3 镜像

如果你的账号出不了公网（或企业策略不允许从 github.com 拉可执行代码），可以把四个产物**先镜像到一个 S3 桶**，让栈从那里取。桶**可以完全私有**（Block Public Access 全开）——部署 Lambda 用它自己的角色签名去读，走的是 S3 API，不需要公网。

**一次性准备**（由一个有凭证的人做，之后所有账号/团队都能复用这一份镜像）：

```bash
# 从 release 下四个产物，放进一个桶（桶要和你开栈的区域同区）
aws s3 cp bff.zip        s3://my-mirror/notiops/v1.2.3/
aws s3 cp chat-dist.zip  s3://my-mirror/notiops/v1.2.3/
aws s3 cp web-notif.zip  s3://my-mirror/notiops/v1.2.3/
aws s3 cp agent-code.zip s3://my-mirror/notiops/v1.2.3/
```

**开栈时填两个参数**：

| 参数 | 填什么 |
|---|---|
| **Artifact base URL override** | `s3://my-mirror/notiops/v1.2.3`（**不要**结尾斜杠；文件名由模板拼） |
| **Artifact mirror bucket name (s3:// only)** | `my-mirror` —— 部署 Lambda 只会被授予**这一个桶**的 `s3:GetObject`，别的什么都没有 |

跨账号也行：桶策略允许部署账号读即可（`Code.S3Bucket` 允许跨账号，但**必须同区域**）。

镜像的完整性照样有保障：模板里那三个 SHA256 是按 release 里的原始产物算的，镜像内容被换过会当场校验失败、栈 CREATE_FAILED。

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

---

## 9. 接下来

- [USER_GUIDE.md](USER_GUIDE.md) — 界面怎么用、有哪些主题（成本、故障调查、Support 案例、Skills…）
- [DEPLOYMENT.md](DEPLOYMENT.md) — 想要 IM bot、自动巡检、管理仪表盘时，走完整版部署
- [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md) — 架构与设计取舍
