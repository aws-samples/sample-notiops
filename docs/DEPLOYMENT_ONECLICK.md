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
> - [DEPLOYMENT.md](DEPLOYMENT.md) — 完整部署手册（`setup.sh` 路径：IM bot、巡检及其看板后端、CUR/Athena 全量功能）
> - [USER_GUIDE.md](USER_GUIDE.md) — 部署完之后怎么用

---

## 0. 先搞清楚：两条部署路径，这篇讲哪一条

仓库里有**两条**部署路径，功能范围不同。这篇只讲第二条。

| | **`setup.sh`**（完整版，见 [DEPLOYMENT.md](DEPLOYMENT.md)） | **本篇：一键部署** |
|---|---|---|
| 你要准备什么 | git、Node、Python、uv、AWS CDK + 一份能部署的 AWS 凭证(**不需要 Docker/finch** —— IM 侧 2026-09-03 / M2 之后走 Lambda Layer,不再构建镜像) | **只要一个能登进 AWS 控制台的浏览器** |
| 怎么开始 | clone 仓库 → `./setup.sh` | 从 Release 下一个模板文件 → 在 CloudFormation 控制台上传 |
| 部署内容 | Web Chat + IM bot（飞书/Slack）+ 每日巡检（含巡检看板的写侧）+ CUR/Athena FinOps 数据源 | **Web Chat**（聊天界面 + BFF + agent + DevOps Agent Agent Space；可选多账号）**+ 可选一个 IM 机器人**（飞书/Lark 或 Slack，见 [§2.11](#211-加装-im-机器人飞书lark-或-slack)） |
| 适合 | 长期使用、要 IM 推送和自动巡检 | 先试用 / 演示 / 只要浏览器里那个只读运维助手（想在群里 @ 它也可以） |

**两条路径可以先后走**：先一键部署试用（需要 IM 机器人的话直接在参数页选上，见 [§2.11](#211-加装-im-机器人飞书lark-或-slack)），之后想要自动巡检、主动推送、以及让巡检看板真的有数据，再按 [DEPLOYMENT.md](DEPLOYMENT.md) 跑 `setup.sh`（两边建的管理员用户名都是 `admin`，不会打架）。

### 0.1 一键部署**不包含**什么

说清楚比事后惊讶好。下面这些**这条路径不部署**，需要 `setup.sh`：

- **往 IM 主动推送**：每日巡检报告、告警推到飞书/Slack 群。IM 机器人本身**可以装**（见 [§2.11](#211-加装-im-机器人飞书lark-或-slack)：你在群里 @ 它、它回你），但那是**被动应答**；主动推送要 `setup.sh` 那条路径的报告流水线。（同样这 10 类信号源**会**进浏览器里的「通知」收件箱，见 [§2.9](#29-通知收件箱)；不进的只是 IM 群。）
- **钉钉**机器人（飞书/Lark 和 Slack 都支持）。
- **每日自动巡检**（闲置资源检测、成本异常扫描）与它那 4 个 Lambda(`notiops-inspection-scheduler` / `-executor` / `-reconciler` / `-push`)以及成本异常扫描器 `notiops-cost-analyzer`。
- **巡检的写侧(所以也是「巡检看板 / 阈值配置 / 扫描范围 / 目标账户管理」这几个页面的数据)**：
  这些页面本身是 chat-app 的一部分,**两条路径都在**,但一键部署不建 `notiops-inspection` 表,
  点进去会加载失败(BFF 返回 `ddb_error`)。要让它们真的有数据,得走 `setup.sh`。
  (**Skills 管理界面不在此列** —— 一键部署照样建 Skills 存储桶,那个页面能用。)
- **CUR + Athena 成本明细数据源**：FinOps 提问仍可用 Cost Explorer 口径，但没有账单明细级下钻。
- **跨账号的自动巡检与事件推送**：一键部署可以做**跨账号只读排查/调查/开案例**（`DeployMode=MultiAccount`，见 [§2.6](#26-可选多账号组织内跨账号)），但成员账号侧的 **CloudWatch OAM Sink** 与 **跨账号事件转发**（Health / DevOps Agent 调查事件回流）不在这条路径里 —— 那两样要 `setup.sh`。

（**DevOps Agent 深度调查**、**联网搜索**、**「通知」收件箱**都**不**在此列 —— 这三样都由这个栈自动建好，分别见 [§2.7](#27-深度调查aws-devops-agent)、[§2.8](#28-联网搜索agentcore-web-search)、[§2.9](#29-通知收件箱)。**IM 机器人**也不在此列，它是参数页上的一个选项，见 [§2.11](#211-加装-im-机器人飞书lark-或-slack)。）

---

## 1. 前置条件（三条，都要满足）

### 1.1 一个能开栈的 AWS 账号 + 控制台权限

你的身份需要能创建 CloudFormation 栈以及栈里的资源（IAM 角色、Lambda、DynamoDB、S3、CloudFront、Cognito、Bedrock AgentCore）。**没有 `AdministratorAccess` 也能做**，但权限太窄会在开栈中途失败；如果不确定，先用一个测试账号。

> 开栈时必须勾选 **"I acknowledge that AWS CloudFormation might create IAM resources"** ——
> 这个栈要为 agent 和 BFF 建角色。

### 1.2 选好区域，并在该区域开通 Bedrock 模型访问

agent 跑在 **Amazon Bedrock** 上。**先去 Bedrock 控制台 → Model access，确认你要用的模型在这个区域是「Access granted」**，再来开栈。

- **默认模型是 xAI 的 Grok 4.6**（`global.xai.grok-4.6`）—— 这一个必须开通，否则装完不能用。
- 想用别的模型（Claude Sonnet 5 / Opus 5 / Haiku 4.5、Amazon Nova Pro、DeepSeek、GLM 5、GPT-5.6 系列）就把对应的也一起开通；用户在聊天页右上角可以按会话切换。
- 推荐 **us-east-1** 或 **us-west-2**（Bedrock AgentCore 与模型覆盖最全）。
- 没开通模型访问时，栈会**开成功**、页面能打开、登录也没问题，但一提问就报 `AccessDeniedException`。这是最常见的"部署完了不能用"。

### 1.3 这个账号要能访问 GitHub（或者准备一个私有镜像）

部署过程中，栈里的一个 Lambda 会去 **GitHub Release** 下产物（前端、BFF、「通知」生产端、agent 代码，共 4 个；选装了 IM 机器人再多 2 个）搬进你自己的 S3 桶。Lambda 默认不在 VPC 里、走 AWS 托管的公网出口，**绝大多数账号天然满足**。

企业环境如果**出口白名单不含 github.com**，不必放弃这条路径 —— 见 [§7 无公网出口：用私有 S3 镜像](#7-无公网出口用私有-s3-镜像)。

---

## 2. 部署（5 步）

### 2.1 下模板

打开 [Releases](https://github.com/aws-samples/sample-notiops/releases) 页，从最新的 release 里下载：

```
notiops-webchat.template.json
```

同一个 release 里还有六个产物（`bff.zip` / `chat-dist.zip` / `web-notif.zip` / `im-code.zip` / `im-layer.zip` / `agent-code.zip`）——**不用下**，模板会让你的账号自己去取。模板里写死了这六个文件的 SHA256，下载后当场校验，不匹配就让开栈失败。

> 两个 `im-*.zip` 只有你在参数页选了带 IM 的安装选项时才会被下载（[§2.11](#211-加装-im-机器人飞书lark-或-slack)）；默认的「只装 web」会跳过它们，不为这 ~28 MB 付流量和存储。

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
| **Administrator email** | 你的邮箱。栈开完后 Cognito 会往这里发一封邮件，里面有**登录地址（ChatUrl）+ 用户名 + 临时密码**。必须是真实可收的邮箱 —— **这是唯一的入口**。 |

其余都有安全的默认值，第一次部署**建议全部不动**：

| 参数 | 默认 | 什么时候才需要改 |
|---|---|---|
| **What to install** | `web` | 下拉三选一：`web`（只装浏览器里的聊天界面）/ `web+feishu`（再加一个飞书/Lark 机器人）/ `web+slack`（再加一个 Slack 机器人）。**三个选项都装 web** —— IM 是加装项，不是替代项。选了带 IM 的还要在 IM 平台侧配几步，见 [§2.11](#211-加装-im-机器人飞书lark-或-slack)。**部署完也能改**（update 栈换个值即可，见 §2.11）。 |
| **Give the agent account-wide read-only access?** | `Yes` | 选 `Yes` 会给 agent 挂上 AWS 托管的 `ReadOnlyAccess`，于是它能回答这个账号里任何资源的问题。选 `No` 则只保留精选的只读授权（成本、日志、指标、RDS/EC2 describe），有些问题会答不了并明确告诉你缺哪条 action。**两种选择都不给任何写权限。** |
| **CORS allowed origins** | `*` | 接口本身已经是 `AWS_IAM`（SigV4）鉴权，`*` 不构成越权。想再收一层，可以在第一次部署完之后 update 栈、把它设成 `ChatUrl` 那个地址。 |
| **IM chat/channel allow list (optional)** | 空 | 只有装了 IM 才有意义（[§2.11](#211-加装-im-机器人飞书lark-或-slack)），只装 web 可以完全不管。填逗号分隔的飞书 chat id（`oc_...`）或 Slack channel id（`C...`），**不能有空格**；留空 = 不限制，机器人被拉进的任何群都答。它是 IM 入口的一道纵深防御（[§8](#8-安全说明值得知道的几条) 里的第 ③ 道）：即使验签被绕过，来自清单外会话的消息也会在**任何模型调用之前**被丢弃。**正常节奏是先留空部署 → 建群拿到 chat id → 再 update 栈填进去**，所以它归在 `Security` 组、不在必填项里。与 `setup.sh` 路径的 `-c imAllowedChatIds=…` 等价。 |
| **On stack delete** | `KeepData` | 决定删栈时你的数据怎么办。见 [§6 删除](#6-删除这个栈)——**改这个值有个坑，删栈前先读那一节**。 |
| **Deployment mode** | `SingleAccount` | 想让它同时看组织里**其它**账号，就选 `MultiAccount` 并填下面的 org id。有前置条件，见 [§2.6](#26-可选多账号组织内跨账号)。 |
| **AWS Organizations id (MultiAccount only)** | 空 | 只有选了 `MultiAccount` 才填（`o-` 开头）。**只填一半不生效**（选了 MultiAccount 但 org id 留空 = 仍是单账号），Outputs 的 `DeployModeStatus` 会告诉你。 |
| **Enable AWS DevOps Agent features (deep investigation, DevOps Chat)?** | `Yes` | 一个开关管**四样**能力，见 [§2.7](#27-深度调查aws-devops-agent)。闲置不计费，所以默认开着；不想要就选 `No`（那四样会置灰）。 |
| **Artifact base URL override** / **Artifact mirror bucket name (s3:// only)** | 空 | 只有拿不到 GitHub 时才填，见 [§7](#7-无公网出口用私有-s3-镜像)。 |

### 2.4 勾 IAM 确认框，开栈

**Next** → 到最后一页勾上 **"I acknowledge that AWS CloudFormation might create IAM resources"** → **Submit**。

**实测耗时约 4.5 分钟**（两次独立测量：4m16s / 4m25s，us-east-1，默认的「只装 web」）。中途你会看到栈在等两个
`Custom::NotiOpsStager…` 资源 —— 那是它在把 ~165 MB 产物从 GitHub 搬进你的 S3 桶、
解压前端、写运行时配置、建管理员用户。选了带 IM 的安装选项会再多搬 ~28 MB、多建 3 个 Lambda（半分钟量级）。

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
| **FeishuWebhookUrl** | 只有选了 `web+feishu` 才有：要粘到飞书开放平台的请求地址（[§2.11](#211-加装-im-机器人飞书lark-或-slack)）。 |
| **SlackWebhookUrl** | 只有选了 `web+slack` 才有：要粘到 Slack App 的三处 Request URL（[§2.11](#211-加装-im-机器人飞书lark-或-slack)）。 |
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

### 2.10 会话记忆（AgentCore Memory）

**没有参数，栈自动建好。** 栈里有一个 **Bedrock AgentCore Memory**，作用只有一个：把**当前这个会话**的消息按 `sessionId` 存下来、下一轮再读回去。**不跨会话** —— 新开一个会话就是干净的一页。

- **它不是"对话历史"**：历史在 DynamoDB 里、界面上一直看得见；Memory 决定的是**模型还记不记得**。没有它，你在同一个会话里切模型 / 切主题 / 隔一小时再回来，界面上历史还在，但模型是"新人"。所以这一层不是可选项，栈里**无条件**建。
- **不做跨会话记忆**（2026-09-01 产品决策）。以前这里挂着四个抽取 strategy，把"你说过的偏好""关于你环境的事实"写到不带会话号的命名空间（`/users/<actor>/…`），下一个会话还能检索到。现在 **strategy 数为 0**，那条路整块关闭：抽取不跑、检索不发。
  - 少一份跨会话的数据留存，行为也更可预期（"它为什么突然这么答"不会来自你早就忘了的某句话）。想让它一直知道的事，写进 Skill / 系统提示这类**显式**配置。
  - ⚠️ **从 v1.0.18 / v1.0.19 升上来的部署**：栈更新会删掉那四个 strategy，**已经抽取出来的记录随之删除**（原先那个 `<actor>` 还是整个部署共用的一个身份，即 A 说过的偏好会影响 B 得到的回答 —— 这也是取消它的原因之一）。
- **事件 30 天后自动过期**（同一个会话隔天接着聊仍能接上；聊天记录本身另存在 `notiops-web-chat` 表里）。
- **删栈时随栈删除**，会话消息一起消失。
- 计费按用量（写入/读取的事件），量级远小于提问本身的 Bedrock token；去掉抽取之后这一项还会更小。

### 2.11 加装 IM 机器人（飞书/Lark 或 Slack）

参数页第一组里那个 **What to install** 下拉框：

| 选项 | 装出来是什么 |
|---|---|
| `web`（默认） | 只有浏览器里的聊天界面。 |
| `web+feishu` | Web Chat **加**一个飞书/Lark 机器人：群里 @ 它、或者私聊它。 |
| `web+slack` | Web Chat **加**一个 Slack 机器人：`/notiops` 斜杠命令、@ 提及、私聊。 |

**三个选项都装 web** —— IM 是加装项，不是替代项。栈只装**一个** IM 平台；两个都要就走 [DEPLOYMENT.md](DEPLOYMENT.md) 的 `setup.sh`（`-c enabledPlatforms=feishu,slack`）。

**IM 侧和网页侧是同一个后端**：同一个只读的 AWS DevOps Agent、同一套 Skills、同一份配置表。所以你在网页里问的那些（成本、故障调查、Support 案例）在群里问是同一个答案。

**它不烧 token**：进来的每条消息先走确定性路由（正则 + 关键词，中英文都认），命中「查资源 / 发起调查 / 看进度 / 切模型 / 切语言」这些直接调 API，**一个 token 都不花**。只有**案例流程**（要把你的描述写成案例正文）才真的走大模型。

**群里发起的深度调查会把报告送回群里**：调查跑完（通常几分钟），栈里那个回调函数把 HTML 报告写进数据桶的 `investigations/` 前缀，再往群里发一张卡片，带一条**限时的公网下载链接** —— 收报告的人不需要有这个 AWS 账号的权限。链接背后是本栈自己那个只放行报告路径的 CloudFront distribution。

> ⚠️ 这条链路是**异步**的（EventBridge → Lambda），所以它坏掉的时候**没有任何报错**：
> 进度卡照样走到 100%（那是另一个函数轮询任务状态画的），然后报告就是不来。
> 真遇到就按这个顺序查：`aws lambda get-function --function-name <栈名>-devops-callback`
> 在不在 → 它的日志组（名字是 CFN 生成的随机名，按逻辑 ID 前缀
> `DevOpsCallbackLogs` 解析，命令形状见 [§4](#4-出问题了怎么办) 那张排障表）里
> 有没有 `account_not_configured` →
> `aws s3 ls s3://<数据桶>/investigations/` 有没有本次调查的对象。
> 三样都在还不来，看那个函数的死信队列（DLQ）。

**部署后还差两步**，两步都做完机器人才会说话（Outputs 里的 `ImNextSteps` 也会提醒你）：

1. **凭证进 Secrets Manager** —— 机器人要有钥匙才能验签和回消息。
   - **飞书/Lark**：`notiops/im-bot-feishu`，四个键：`app_id` / `app_secret` / `encrypt_key` / `verification_token`。
     **推荐直接在网页里填**：登录后 **管理控制台 → 集成 IM**，四个凭证在同一张表单上，点保存即写进这个 secret —— 不用装 CLI、不用另开凭证。那一页还带飞书那一半的四步速览和「查看详细配置步骤」侧边栏。
   - **Slack**：两个 secret，`notiops/slack-bot-token`（`xoxb-` 开头）和 `notiops/slack-signing-secret`，各存一个纯字符串。⚠️ Slack 这两个目前**只能**在 Secrets Manager 控制台建（管理控制台那一页现在只管飞书）。
2. **请求地址填回 IM 平台** —— 就是 Outputs 里的 `FeishuWebhookUrl` / `SlackWebhookUrl`。

> ⚠️ **顺序不能反**：先写凭证，再填请求地址。飞书/Slack 在你保存请求地址时会**立刻**发一次校验请求，那时凭证还没有的话入口函数会直接失败，而 IM 平台上显示的是「校验失败」—— 看起来像地址填错了。

**每一步点哪里、填什么，见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md)**（飞书 §1、Slack §2；那份文档两条部署路径通用，secret 名字和请求地址的用法完全一样）。

**装完之后想改**：update 栈、把 **What to install** 换成另一个值即可。

- `web` → `web+feishu`：新建 IM 那套资源（~30 秒），然后照上面两步配。
- `web+feishu` → `web`：删掉 IM 那套。⚠️ **两张 IM 的 DynamoDB 表（会话与用量）也会被删** —— 里面是群会话的上下文和调查任务状态，删了就没了。
- `web+feishu` → `web+slack`：删飞书那套、建 Slack 那套。飞书那个 HTTP API 的地址**不会**保留，改回去时是一个新地址，得重新填一遍飞书后台。
- **凭证不随栈走**：那三个 secret 是栈外资源，换选项、删栈（`KeepData`）都留着。只有 `TeardownMode=DeleteEverything` 的删栈才会连它们一起删（见 [§6](#6-删除这个栈)）。

---

### 2.12 （可选）接自己的 CUR 数据源

参数页 **Optional: your own CUR data source** 那一组，两个参数，**默认都空 = 不启用**：

| 参数 | 填什么 |
|---|---|
| `CostAgentMcpUrl` | 你自己那个 cost-agent MCP Lambda 的 **Function URL**（`https://<id>.lambda-url.<region>.on.aws`） |
| `CostAgentFunctionArn` | **同一个 Lambda 的函数 ARN** |

这一项接的是**别的账号/多 payer 的 CUR 表**（行级明细，TAM 场景），不是本账号自己的成本数据 —— 本账号那份是 FinOps 页默认就有的，不需要这两个参数。启用后多出：FinOps 页 4 个 CUR sheet（费用趋势 / Credit / 扩展支持 / Savings Plans）+ 聊天里直接问客户费用。

⚠️ **两个必须一起填**。Function URL 里**不含**函数 ARN，而调用授权（`lambda:InvokeFunctionUrl`）只能按资源给 —— 只填 URL 会部署出一个「看起来装好了、每次调用 403」的数据源。所以模板里有一条参数校验规则（`CostAgentArnRequiredWithUrl`）：只填一半会在**开栈之前**就被拒掉，不会先建出半个东西来。

- **不填**：这项能力按设计不存在 —— 那 4 个 sheet 的导航节点直接不出现（不会有点了没反应的菜单），聊天里也不挂对应工具。其余功能不受影响。
- **先部署后再加**：update 栈、填上这两个参数即可，不用重建。
- **还差一步在你那侧**：那个 Lambda 的 **resource policy** 要允许本栈的两个角色（BFF 与 agent runtime）调它的 Function URL —— 那是你自己的部署，模板碰不到。
- **MCP 挂了不会拖垮整个工具**：仪表盘只有那 4 张表显示「暂时不可用」；聊天会自动降级到 Cost Explorer、再到 AWS 只读 API，并**明确告诉你换了数据源**（口径不同，别拿去直接对账）。

**这个 Lambda 怎么部署、45 个工具的口径注意事项、以及降级链的完整说明，见 [DEPLOYMENT.md §14](DEPLOYMENT.md#14-客户-cur-仪表盘--cost-agent-mcp可选)**（那一节两条部署路径通用）。

---

## 3. 这个栈建了什么

默认参数下 **68 个**资源，都在你自己的账号里（部署在 us-east-1 会再多 3 个 —— 联网搜索那套；关掉深度调查少 5 个；选上多账号多 3 个；**选带 IM 的安装选项多 16 个**）：

| 类别 | 资源 |
|---|---|
| 前端 | S3 网站桶 + CloudFront distribution + CloudWatch RUM；报告下载走另一个 CloudFront distribution（带一个只放行报告路径的 CloudFront Function） |
| 接口 | 1 个 Lambda（BFF）+ Function URL（`AWS_IAM` 鉴权，流式返回） |
| Agent | 1 个 Bedrock AgentCore Runtime + 1 个 AgentCore Memory（会话记忆，见 [§2.10](#210-会话记忆agentcore-memory)） |
| 登录 | Cognito User Pool + Client + Identity Pool + 8 个用户组（角色） |
| 数据 | DynamoDB `notiops-config`、`notiops-web-chat`；1 个数据桶（报告等） |
| 部署辅助 | 1 个 staging 桶（放搬进来的产物）+ 1 个内联的部署 Lambda + 2 个自定义资源 |
| 权限 | 6 个 IAM 角色 + 5 个内联策略（其中 AgentCore Memory 的执行角色**一条策略都没有** —— 它只是给服务用来信任的壳） |
| 「通知」收件箱（见 [§2.9](#29-通知收件箱)） | **10 条 EventBridge 规则**（5 条 ENABLED / 5 条 DISABLED）+ 1 个 Lambda + 它的日志组 + 1 个角色（+ 策略）+ 1 条 Lambda 调用许可 = 15 个 |
| 深度调查（默认开） | 1 个 DevOps Agent Agent Space（**含自动开好的 Operator App**）+ 1 个只读关联 + 1 个被 DevOps Agent 假设的角色（+ 它的策略）+ 1 个 Operator App 角色 = 5 个 |
| 联网搜索（仅 us-east-1） | 1 个自定义资源（去建 AgentCore Gateway）+ 1 个 Gateway 服务角色 + 1 个内联策略 |
| 多账号（可选） | 1 个自定义资源（去建两个成员账号 StackSet）+ 2 个内联策略 |
| IM 机器人（可选，见 [§2.11](#211-加装-im-机器人飞书lark-或-slack)） | 3 个 Lambda（入口 / 干活 / 进度刷新）+ 3 个日志组 + 1 个 **API Gateway HTTP API**（公网入口，见下；连它的路由 / 集成 / 阶段一共 4 个资源）+ 3 条调用许可（HTTP API→入口、保活规则→入口、进度规则→进度刷新）+ 1 个依赖层 + 2 张 DynamoDB 表（群会话、用量）+ 2 条 EventBridge 规则（每分钟刷调查进度、每 4 分钟保活入口）+ 1 个角色（+ 策略）= 20 个 |

**成本量级**（空闲时）：CloudFront + S3 + DynamoDB 按量、Lambda 不调用不计费、AgentCore Runtime 空闲不计费 —— 不用的时候基本只有几毛钱的存储。真正花钱的是**提问时的 Bedrock token**。staging 桶里每个 release 约 **165 MB**（装了 IM 再多 ~28 MB；S3 标准存储 ≈ $0.004/月），升级不会自动清掉旧版本，见 [§5](#5-升级到新版本)。IM 那套同理**空闲零成本**（三个 Lambda 不调用不计费，两张表按量，每分钟那条进度规则只在有调查在跑时才真的做事）。

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

### 4.5 装了 IM，但机器人在群里不说话

这是**静默失败**，几乎总是 [§2.11](#211-加装-im-机器人飞书lark-或-slack) 那两步里漏了一步：

| 先查什么 | 怎么判断 |
|---|---|
| 凭证有没有写全 | Secrets Manager 里那个 secret 存在吗、键齐吗（飞书要四个键）。入口函数是**故意**在缺钥匙时冷启动就失败的 —— 宁可起不来，也不开一个谁都能伪造请求的公网入口。 |
| 请求地址填了吗 | 飞书要填**两处**（事件配置 + 回调配置），Slack 要填**三处**（Events / Interactivity / Slash Commands），都是同一个 URL。 |
| 日志 | ⚠️ 一键部署的**日志组名是 CloudFormation 生成的随机名**（`<栈名>-FeishuIngressLogs<hash>-<随机>`），**没有** `/aws/lambda/` 前缀，拿栈名拼不出来（理由与解析命令见 [IM_WEBHOOK_SETUP.md §1.5](IM_WEBHOOK_SETUP.md#15-验证)）。查名字：`aws cloudformation describe-stack-resources --stack-name <栈名> --region <区域> --query "StackResources[?starts_with(LogicalResourceId,'FeishuIngressLogs')].PhysicalResourceId" --output text`（worker 换 `FeishuWorkerLogs`、Slack 换 `SlackIngressLogs` / `SlackWorkerLogs`、进度刷新换 `ImProgressLogs`）。**函数名**倒是可以拼：`<栈名>-im-ingress-feishu` / `<栈名>-im-worker-feishu` / `<栈名>-im-progress`。入口函数里能看到验签失败、或者干脆没有任何日志（= IM 平台根本没打过来，说明地址没填对）。 |

排查步骤和每个报错的含义在 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) 里。

### 4.6 想用命令行而不是控制台

可以，但有两个坑：

```bash
# 模板 200 KB 出头（随资源数逐版增长），远超 --template-body 的 51,200 字节上限 ⇒ 必须先传 S3、用 --template-url
aws s3 cp notiops-webchat.template.json s3://<你的桶>/notiops-webchat.template.json
aws cloudformation create-stack --stack-name notiops \
  --template-url https://<你的桶>.s3.<区域>.amazonaws.com/notiops-webchat.template.json \
  --capabilities CAPABILITY_IAM \
  --parameters ParameterKey=AdminEmail,ParameterValue=you@example.com
# 多账号：再加两个参数（缺一不生效，见 §2.6）
#   ParameterKey=DeployMode,ParameterValue=MultiAccount \
#   ParameterKey=OrganizationId,ParameterValue=o-xxxxxxxxxx
# 加装 IM 机器人（见 §2.11）：web / web+feishu / web+slack
#   ParameterKey=InstallOption,ParameterValue=web+feishu
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

> **staging 桶会累积**：每个装过的 release 留 ~165 MB（装了 IM 再多 ~28 MB）。想清理就手工删 staging 桶里
> `agent/<旧tag>/`、`frontend/<旧tag>/`、`im/<旧tag>/` 前缀下的对象 —— **别删当前 release 的**，
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
| 其他一切（前端、CloudFront、Lambda、agent、**Cognito 用户池**，以及装了 IM 的话那 16 个资源含两张 IM 表） | 删除 | 删除 |
| IM 凭证（`notiops/im-bot-feishu` 等 Secrets Manager secret，栈外资源） | **保留** | 删除（不可恢复） |

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

删栈过程中，栈里的部署 Lambda 会先把网站桶和 staging 桶**清空**（非空的桶删不掉，会把整个删栈卡住），然后按 `TeardownMode` 决定要不要删那两张表和数据桶。实测两种模式都是**零 `DELETE_FAILED`**。

### 6.4 会留下的东西（孤儿），要不要管

| 留下的 | 为什么 | 建议 |
|---|---|---|
| `/aws/vendedlogs/RUMService_<栈名>-web-chat<hash>` 日志组 | CloudWatch RUM 自己建的，不属于这个栈 | **可以不管**：实测 0 字节，30 天后自动过期。想清就在 CloudWatch 里按这个**完整名字**删（别按前缀批量删） |
| `KeepData` 下的两张表 + 数据桶 | 这是 `KeepData` 的**本意** | 不再用了就手工删（桶要先清空）。**想在这个账号里重新部署就必须先删** —— 见 §6.1 的第二条警告 |
| CloudFront 的访问日志（如果你自己开过） | 不由这个栈管理 | 按需 |
| **装过 IM 的话**：`notiops/im-bot-feishu` / `notiops/slack-bot-token` / `notiops/slack-signing-secret` 这几个 Secrets Manager secret | 它们不是栈内资源（飞书那个由管理控制台按需创建、Slack 那两个你手建），所以 `KeepData` 不会动它们 | `DeleteEverything` 会**连它们一起删**（不可恢复）。`KeepData` 下想清就自己删；留着的话下次重装同名 secret 会被直接复用 |
| **多账号模式下**：`notiops-member-onboarding` / `notiops-member-devops-agent` 两个 StackSet，以及 Organizations 对 StackSets 的信任访问 | **故意留的。** ① StackSet 要先删掉全部 stack instance 才删得掉，而那等于抹掉各成员账号里的跨账号角色 —— 这种跨账号的破坏性动作不该由"删一个栈"隐式触发；② 信任访问是**组织级**开关，删我们的栈就把它关掉会打断组织里别人的 StackSets 部署。 | 确实不要了：先在 CloudFormation → StackSets 里 **Delete stacks from StackSet**（删实例），再删 StackSet 本身。信任访问除非你确认没别人在用，否则别关。 |

**没有**其他孤儿：agent 的日志组、BFF 的日志组、「通知」函数的日志组、部署 Lambda 的日志组、IAM 角色、Cognito 用户池、RUM app monitor、AgentCore Runtime、网站桶、staging 桶 —— 实测全部随栈删除。深度调查建的 Agent Space 与关联也随栈删除（它是栈里的普通资源）。会话记忆的 AgentCore Memory（[§2.10](#210-会话记忆agentcore-memory)）同理 —— 它是栈里的普通资源、**没有**保留策略，随栈删除，里面存的会话消息一起消失（这条是按模板声明说的，还没像上面那串一样删栈实测过）。联网搜索的 AgentCore Gateway 分两种：**这个栈建出来的**随栈删除；**它复用的别人的**（同账号里已经存在的 `notiops-websearch-gw`，比如 `setup.sh` 建的）留着不动 —— 删一个栈不该顺手拆掉另一条部署路径还在用的东西。

---

## 7. 无公网出口：用私有 S3 镜像

如果你的账号出不了公网（或企业策略不允许从 github.com 拉可执行代码），可以把产物**先镜像到一个 S3 桶**，让栈从那里取。桶**可以完全私有**（Block Public Access 全开）——部署 Lambda 用它自己的角色签名去读，走的是 S3 API，不需要公网。

**一次性准备**（由一个有凭证的人做，之后所有账号/团队都能复用这一份镜像）：

```bash
# 从 release 下产物，放进一个桶（桶要和你开栈的区域同区）
aws s3 cp bff.zip        s3://my-mirror/notiops/v1.2.3/
aws s3 cp chat-dist.zip  s3://my-mirror/notiops/v1.2.3/
aws s3 cp web-notif.zip  s3://my-mirror/notiops/v1.2.3/
aws s3 cp agent-code.zip s3://my-mirror/notiops/v1.2.3/
# 只有要装 IM 机器人（§2.11）时才需要这两个；只装 web 的话栈不会来取
aws s3 cp im-code.zip    s3://my-mirror/notiops/v1.2.3/
aws s3 cp im-layer.zip   s3://my-mirror/notiops/v1.2.3/
```

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
6. **装了 IM 就多一个公网入口**（[§2.11](#211-加装-im-机器人飞书lark-或-slack)）——那个 **API Gateway HTTP API** 必须是**未鉴权**的，因为飞书/Slack 不会给你签 SigV4（2026-09-01 之前这里是 Lambda Function URL，为什么换、以及被否掉的两个替代方案，见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §4.1）。五道边界：① **验签**（飞书用 Encrypt Key + Verification Token，Slack 用 signing secret，缺钥匙就冷启动失败，不存在"没配好也能进"）；② **两层限流** —— HTTP API 阶段级 50 req/s、突发 100（超出的请求由 API Gateway 直接 429，**不进 Lambda**），入口函数上再叠**并发上限 10**，这是公网未鉴权入口的花费天花板；③ 可选的**群允许清单**（只让指定群里的消息生效，见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §3）；④ **幂等去重**（同一个事件重复投递只处理一次）；⑤ 到了后端仍然是**同一个只读 agent**，没有任何写权限 —— 即使有人伪造了一条消息，最坏结果也是读到只读信息。凭证一律放 Secrets Manager，不进环境变量、不打印在日志里。还剩下的风险如实列在 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §4.3。

---

## 9. 接下来

- [USER_GUIDE.md](USER_GUIDE.md) — 界面怎么用、有哪些主题（成本、故障调查、Support 案例、Skills…）
- [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) — 装了 IM 机器人（[§2.11](#211-加装-im-机器人飞书lark-或-slack)）之后，在飞书/Slack 那边要点什么
- [DEPLOYMENT.md](DEPLOYMENT.md) — 想要自动巡检、往 IM 主动推送、以及让巡检看板真的有数据时，走完整版部署
- [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md) — 架构与设计取舍
