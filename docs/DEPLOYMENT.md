# NotiOps — 部署手册

> ⚠️ **免责声明 / Disclaimer**:这是示例代码(sample code),仅供学习与参考,**非生产就绪产品**。正式部署或承载生产工作负载前,请与贵组织的安全与法务团队一起,按你们的安全、监管与合规要求对其进行充分测试、加固与优化。
> _This is sample code, for non-production usage. You should work with your security and legal teams to meet your organizational security, regulatory and compliance requirements before deployment._

> 🌐 **Language**: [中文](DEPLOYMENT.md) · [English](DEPLOYMENT.en.md)
>
> **目标读者**:首次部署本系统的运维 / DevOps 工程师。
>
> **预期完成时间**:**走 §0 快速部署 ~30 分钟** / 完整深入 ~2 小时。
>
> **配套文档**:
> - [USER_GUIDE.md](USER_GUIDE.md) — 终端用户使用指南
> - [DEPLOYMENT_ONECLICK.md](DEPLOYMENT_ONECLICK.md) — **另一条路径**:只要 Web Chat、且不想在本地装工具链时看这篇

**版本**:v3.0 · 2026-06-09(post-fusion CDK rewrite)

> 部署入口:`./setup.sh`(交互式 CDK 部署)。原 `deploy.sh` / SAM 流程已下线。

---

## 目录

- **§0 [快速部署 TL;DR](#0-快速部署-tldr)** — 不想细读直接跑这一节
- §1 [部署架构](#1-部署架构)
- §2 [前置条件](#2-前置条件)
- §3 [注册 IM 应用](#3-注册-im-应用)(飞书 / Slack / 钉钉)
- §4 [配置项与 IM 凭据](#4-配置项与-im-凭据)
- §5 [一键部署 `setup.sh`](#5-一键部署-setupsh)
- §6 [冒烟测试](#6-冒烟测试)
- §7 [开启 / 调整 Push 模式](#7-开启--调整-push-模式)
- §8 [日常运维](#8-日常运维)
- §9 [回滚策略](#9-回滚策略)
- §10 [Top 5 部署常见错误](#10-top-5-部署常见错误)
- §11 [完整 CDK Context 参考](#11-完整-cdk-context-参考)
- **§12 [Web Chat 部署](#12-web-chat-部署)** — agentic AI 助手(浏览器端),独立于 IM bot
- **§13 [CUR + Athena FinOps 数据源](#13-cur--athena-finops-数据源)** — FinOps 仪表盘的成本明细数据源(可选;复用既有 CUR 即时,新建 CUR ~24h)
- **§14 [客户 CUR 仪表盘 + cost-agent MCP](#14-客户-cur-仪表盘--cost-agent-mcp可选)** — 让聊天和 4 个仪表盘 sheet 按行级明细查一张 CUR 表（可选；成本 MCP server 由 NotiOps 替你部，或指向你已有的那个）

---

## 0. 快速部署 TL;DR

> 适合"先快速跑起来,细节后看"。所有命令都假设你已经走完 §2 前置条件。Web 端(浏览器聊天控制台)默认部署,是产品主入口;IM(飞书 / Slack / 钉钉)是可选补充,只有你想启用时才需要走 §3 注册 IM 应用。

> 💡 **只想先试试 Web Chat?** 那这篇整个都不用读。[DEPLOYMENT_ONECLICK.md](DEPLOYMENT_ONECLICK.md)
> 是一条**不需要本地装任何东西、也不需要 access key** 的路径:从 Release 下一个
> CloudFormation 模板、在控制台上传、~4.5 分钟开完栈。代价是它**只部署 Web Chat**(外加最多一个
> 可选的 IM 机器人,只做被动应答)—— 没有每日巡检、没有巡检后端,也没有往 IM 的主动推送;
> Web Chat「更多」里的「巡检」在那条路上**根本不出现**(不是点进去加载失败)。完整清单见那篇的 §0.1。
> 想要这些就回来走本篇的 `setup.sh`。⚠️ 同一账号同一区域里两条路径用的是同一套表 / 桶名,不能同时存在:
> 先把一键部署的栈按 `DeleteEverything` 删掉(数据不会带过去,删法见那篇的
> [§6](DEPLOYMENT_ONECLICK.md#6-删除这个栈)),或者把 `setup.sh` 装到另一个区域。

### 0.1 一键部署

```bash
./setup.sh
```

首次运行会**交互式引导**:确认 AWS 账号 + region →(可选)PHD 事件转发 → **选 IM 平台(`1` 飞书 / `2` Slack / `3` 钉钉,可多选如 `1,3`;首装默认 `0` 暂不部署,只上 web 端。**重跑**时默认是「原样保留现网已启用的平台」,回车不会把正在跑的 bot 停更 —— 详见 §4.1)**→ 构建前端(只有一个:Web Chat 的 `frontend/chat-app`)→ 部署 Web Chat Agent(AgentCore Runtime)→ 走 CDK bootstrap → CDK synth → CDK deploy `--all`。**Web Chat + 后端 agent 默认就会部署**;IM 凭据**不在此处采集**——CDK 只创建**空的** Secret,部署完成后再按结尾提示填(见 §4 / §5)。

> **关于钉钉**:钉钉自 2026-09-08 起**两条部署路径都支持**,与飞书 / Slack 同一个 Lambda webhook 形态(`setup.sh` 选项 `3`;一键部署 `InstallOption=web+dingtalk`)。没选它时 `enabledPlatforms` 不含 `dingtalk` → `ImStack` 不为钉钉创建任何 Lambda / webhook,不计费。钉钉与飞书 / Slack 有几处**真实的平台能力差异**(卡片按钮只能是链接、已发出的消息改不了、机器人不能贴表情、主动推送要另配一个地址),完整对比表在 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §3.6;另外钉钉控制台保存消息接收地址时不做任何校验 —— 见 §3.3。

部署的两栈(`cdk deploy --all` 一次部到位;选了 IM 平台时多一个 `ImStack`,共三栈):
- `NotiOpsBackendStack`:共享后端(DDB、8 个 Lambda、S3 报告 bucket、EventBridge rules)
- `ImStack`(选了 IM 才建):**IM 的运行路径(唯一一条)** —— 每个平台一个 API Gateway HTTP API + 一对 Lambda(ingress + worker)+ 进度 Lambda + 依赖 Layer + 去重表。部署后要把它输出的 webhook 地址填进 IM 平台控制台,见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md)
- `WebChatStack`:浏览器端 agentic AI 助手(**默认部署**;BFF Lambda + Function URL、DDB 单表 `notiops-web-chat`、静态前端、通知 handler)

> ℹ️ **`BotStack`(ECS Fargate 长连接)已于 2026-09-03 退役**(IM 重构 M2),`infra/bin/app.ts`
> 不再实例化它 —— 所以**不再需要 VPC,也不再需要 finch / docker**。
> `infra/lib/bot-stack.ts` 与三个 Dockerfile 仍留在仓库里作长连接回滚路径(不被任何 app 引用);
> `teardown.sh` 仍按名字删 `BotStack`,让 M2 之前装机的账号能清干净。

后续重跑 `./setup.sh` 只补差异部分(已存在的 stack 走 `cdk diff` 增量更新,镜像有改动才重 build)。

### 0.1.1 部署完成后:哪些开箱即用,哪些还要配一步

`setup.sh` 跑完后,请分清两类功能 —— **别把"接入成员账号"这一步误当成"整个产品必需":**

| | 整个产品**开箱即用**(无需额外配置) | **仅**这些功能需要额外配一步 |
|---|---|---|
| **功能** | Web Chat:AWS 问答 · 故障调查 · 成本分析 · Support 案例 · Skills · 通知(Health/告警推送)· 资源巡检(高负载 / 闲置与成本) | 把**成员账号**(部署账号以外的账号)也纳入巡检 |
| **默认操作对象** | **部署账号本身**,登录即用;巡检也自动覆盖它(默认扫全部 region,每天 UTC 02:00 跑) | 在 Web Chat 左侧「更多 → 管理」→「账户」→「成员账号接入」逐个接入 |
| **不配的后果** | — | 巡检只覆盖部署账号,**Web Chat 完全不受影响** |

> 一句话:**只用 Web Chat 聊天 → 登录就能用,什么都不用配**;部署账号的资源巡检也是装完就按计划跑,结果在「更多 → 巡检」里看(执行时刻在同一处的「配置 → 阈值与定时」改;不想等也可以在看板上直接点「跑高负载 / 跑闲置」拿首轮结果)。要把**别的账号**也纳入巡检 → 才需要去「更多 → 管理」→「账户」接入,两种部署模式下都行(接进来的账号也能在 Web 上用「深度调查」/「DevOps 对话」去查);要让 IM、Web Chat 里 NotiOps 模型的对话、Support 案例和每日成本异常扫描也跨到别的账号,或者收成员账号的 PHD 事件,这些才和部署模式有关,见 §0.1.2。成员账号里的采集角色(`notiops-cross-account-role-<部署账号>`;只读,默认另带 Support 工单的开 / 回复 / 关闭权限,模板参数 `EnableSupportCaseWrite=false` 可关)**不用手建**,接入时由模板一并创建:多账号模式部署(`./setup.sh --multi-account`)下,组织内账号在「成员账号接入」里**一键接入**(StackSets 下发,含 DevOps/PHD 事件转发);其余情况(账号不在本组织、你没有管理账号权限,或没有按多账号模式部署)用同页的「手动接入账号」—— 输入账号 ID →「生成链接」→ 把 Launch Stack 链接发给那个账号的管理员,让他用**那个账号**登录部署 → 把 Stack Outputs 里的 `AgentSpaceId` / `TriggerRoleArn` / `InspectionAgentSpaceId` 回填 →「测试连接」→「保存并激活」,全程不需要 Organizations 权限。每个账号扫哪些 region 在「账户」页该账号那一行的「巡检范围」里改(填 `*` = 全部 region);不想扫的资源在「更多 → 巡检」→「配置 → 巡检范围」里加排除。
>
> ⚠ 2026-10 之前接入的成员账号里,这个角色叫 `notiops-idle-detection-role-<部署账号>`(老 idle-detector 遗留名)。不用手工迁移:系统把两代名字当别名;成员栈更新、角色换成新名之后,下一次跨账号访问会自动把登记改成新名。

### 0.1.2 部署模式:单账号(默认) vs 多账号 `--multi-account`

**先决定用哪种模式再跑 `setup.sh`** —— 这决定 CDK 在部署时如何写死跨账号闸门,**部署后要切换必须重新部署**(不是运行时开关)。

| | **单账号模式(默认)** | **多账号模式** `./setup.sh --multi-account` |
|---|---|---|
| **怎么触发** | 直接 `./setup.sh` | `./setup.sh --multi-account`,在**组织管理账号(payer)**或**已注册的 StackSets 委派管理员**成员账号上运行 —— 见下面 |
| **面向谁** | 只在**本账号**用 NotiOps(绝大多数试用 / 单账号客户) | 用 Organizations 管理一堆账号,想**跨成员账号**巡检 / 调查 / 转发事件 |
| **跨账号闸门** | 锁定到部署账号(`LOCKED_ACCOUNT_ID` = 本账号)。这道闸门管的是 IM、Web Chat 里 NotiOps 模型的对话、「案例」里的 Support 工单和每日成本异常扫描 —— 它们只碰部署账号;**资源巡检**和 Web 上**直连 DevOps Agent** 的「深度调查」/「DevOps 对话」不经过它,所以用「手动接入账号」接进来的账号在这个模式下照样会被巡检、也能用这两样去查 | 解锁闸门(`LOCKED_ACCOUNT_ID` 置空,改用 `aws:PrincipalOrgID` 整组放行):左边那几条路也能覆盖到已接入的成员账号 |
| **成员账号资源** | 不下发(要接别的账号,用「手动接入账号」让那个账号自己部一个栈,见 §0.1.1) | 经 **StackSets** 自动向成员账号下发采集角色(只读,默认另带 Support 工单写权限,见 §0.1.1)+ DevOps/PHD 事件转发 |
| **影响的功能** | Web Chat 全部功能对**本账号**开箱即用;手动接入的账号能被巡检、能在 Web 上深度调查 | 额外解锁:Web Chat「更多 → 管理」→「账户」→「成员账号接入」里的组织内**一键接入**(StackSets 下发采集角色 + DevOps/PHD 事件转发,第二步 DevOps Agent 关联随后自动完成)、跨账号 **PHD 事件转发**、IM 与 NotiOps 模型对话里的**跨账号排查**、跨账号 **Support 案例**、覆盖成员账号的每日成本异常扫描 |

#### 硬性前置:管理账号,或 StackSets 委派管理员

> `--multi-account` 接受**两种**部署身份,二者之一即可:
> 1. **AWS Organizations 管理账号(payer)**;
> 2. 一个已在管理账号里注册成 **CloudFormation StackSets 委派管理员**的成员账号(linked account)。
>
> **不用加任何开关来区分** —— `setup.sh` 自己探测(`detect_stackset_call_as`),认出委派管理员后把
> `CallAs=DELEGATED_ADMIN` 一路带到全部 StackSets 调用(建 / 更新两个 StackSet、下发实例,
> 以及 `teardown.sh` 的盘点与删除),并把 `stackSetCallAs` / `orgManagementAccountId` 传进 CDK,
> 让运行期 `bff/web-chat/member_accounts.mjs` 的一键接入也带上它。

跑 `--multi-account` 之前先对一下(几秒钟):

```bash
aws organizations describe-organization --query 'Organization.[Id,MasterAccountId]' --output text
aws sts get-caller-identity --query Account --output text
```

第一条的**第二列**(`MasterAccountId`)等于第二条的输出 ⇒ 这是管理账号,可以跑。
两者不等 ⇒ 这是成员账号,再查一下它是否已经是 StackSets 委派管理员:

```bash
aws organizations list-delegated-administrators \
  --service-principal member.org.stacksets.cloudformation.amazonaws.com \
  --query 'DelegatedAdministrators[].Id' --output text
```

输出里**有**本账号号 ⇒ 可以跑。没有 ⇒ 三条路:让管理账号注册一次(见下)、换到管理账号上跑、
或者先用默认单账号模式(Web / IM / 深度调查 / 开案例全都照常,只是没有一键接入,跨账号能力也少一截 —— 见上表)。
⚠️ 这条命令**必须带 `--service-principal`**:不带会列出组织里**所有**服务
(GuardDuty / Config / Security Hub …)的委派管理员,那些账号也有 Organizations 只读权限但
**操作不了 StackSet**,照着那份清单判断会得到"应该行",然后在建 StackSet 时才 `AccessDenied`。
第一条报 `AWSOrganizationsNotInUseException` ⇒ 这个账号根本不在组织里,只能单账号。

**注册委派管理员(一次性动作,在管理账号里跑;官方步骤见 [Register a delegated administrator member account](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-orgs-delegated-admin.html)):**

```bash
aws organizations register-delegated-administrator \
  --service-principal member.org.stacksets.cloudformation.amazonaws.com \
  --account-id <要用来部署 NotiOps 的成员账号号>
```

反向是 `aws organizations deregister-delegated-administrator`(同样两个参数)。
注册完直接在那个成员账号里重跑 `./setup.sh --multi-account`,**没有额外参数**。

**开这条路之前要知道的四件事:**

1. ⚠️ **委派管理员对全组织有完整部署权限。** AWS 明确说明:管理账号**无法**把它收窄到某几个 OU
   或某几类操作 —— 一旦注册,这个成员账号就能往组织里**任何**账号下发 StackSet(不只是 NotiOps
   这两个)。这是 AWS StackSets 的模型,不是 NotiOps 的实现选择。
2. **可信访问必须先由管理账号开好。** `enable-aws-service-access` 与
   `activate-organizations-access` 这两个 API **只有管理账号能调**,所以委派管理员这条路上
   `setup.sh` **跳过**它们(不是"调了忽略错误" —— 后者会让现场以为脚本已经帮它开好了),
   只用 `describe-organizations-access --call-as DELEGATED_ADMIN` 验一遍并在没开时把那两条
   命令打出来,让你回管理账号跑。
3. **一个组织最多同时注册 5 个 StackSets 委派管理员**(AWS 的限制,见上面的官方文档;这个上限按服务各算各的,别的服务有自己的上限)。
4. **StackSet 实体存放在管理账号里**,即使是委派管理员创建的。所以在**部署账号**的
   CloudFormation 控制台里看不到 `notiops-member-onboarding` / `notiops-member-devops-agent`
   (要看得加 `--call-as DELEGATED_ADMIN`);`teardown.sh` 也一样带这个参数,不会因此漏删。

> 🔴 **一条与身份无关的硬限制**:CloudFormation **从不**把 service-managed StackSet 下发到
> **组织管理账号本身** —— 即使把它所在的 OU 设成目标,`CreateStackInstances` 也会返回 SUCCEEDED
> 而什么都不建(静默的假成功)。实际只有**委派管理员部署**会碰到它:管理账号在成员列表里是普通一行,
> 但一键接入对它不可用。要让 NotiOps 查它,**只用**「手动接入账号」一条路:「生成链接」→ 用管理账号
> 登录部署那个栈 → 回填 Stack Outputs →「测试连接」→「保存并激活」,采集角色由这个栈一并建好。
> **别再**手工部 `infra/member-account-onboarding.yaml`:它建的是同名采集角色,两个都部会
> `EntityAlreadyExists`、整栈回滚;那个账号里已经部过它的话,在 quick-create 页上把
> `CreateCollectionRole` 改成 `no`;那个栈建了事件转发的话(它的 `DevOpsEventBusArn` 参数非空),
> 同一页上的 `DevOpsEventBusArn` 也清空 —— 两个栈的转发规则名字不同、不会报错,但会同时转发,
> 每个调查事件投两次。从管理账号本身部署时什么都不用做 —— 那时它就是部署账号,
> 装完自动登记、自动被巡检。

不满足条件时 `setup.sh` **在 `cdk deploy` 之前就停下并 `exit 1`**(不静默降级成单账号),
把上面那三条出路和注册命令原样打出来。一键部署那侧的对应说明见
[DEPLOYMENT_ONECLICK.md §2.6.1](DEPLOYMENT_ONECLICK.md#261-硬性前置管理账号或-stacksets-委派管理员)。

**为什么不默认开多账号?** 多账号模式要求当前身份是 **Organizations 管理账号或 StackSets 委派管理员**、要动 StackSets 并向成员账号下发资源 —— 对只想在单账号里试用的绝大多数用户是多余且更高权限的操作。默认单账号是最小权限、最快跑通的路径,所以**默认关**;需要时显式加 `--multi-account` 才启用。

**已经单账号部署过、后来想要多账号怎么办?** 在管理账号(或已注册的委派管理员账号)重跑 `./setup.sh --multi-account` 即可(CDK 增量更新会重写闸门 + 补下发成员账号资源)。单账号部署的「更多 → 管理」→「账户」页顶上会有一段提示「一键接入不可用 —— 它要 CloudFormation StackSets,只有以多账号模式部署才有…」——说的正是这件事:要一键接入,就得加 `--multi-account` 重跑,**这一步无法在控制台里点开关切换**。不想重新部署的话,同一页的「手动接入账号」现在就能用(接进来的账号能被巡检、能在 Web 上深度调查;IM 与 NotiOps 模型对话里的跨账号排查仍要多账号模式)。

> 不确定选哪个?**先按默认单账号跑通**,验证 Web Chat 能用;之后确有跨账号需求再重跑 `--multi-account`。两者不冲突,后者是前者的超集。

### 0.2 验证

**主验证 —— 打开 Web Chat(唯一主入口)**:部署结束时脚本会打印 Web Chat 地址 + `admin` 用户和临时密码(称其为"唯一主入口")。浏览器打开该地址,用 `admin` / 临时密码登录(首次登录需改密码),随便问一句(例:"列出本账号 EC2")能得到回复即成功。

```
浏览器打开脚本结尾打印的 Web Chat 地址 → 用 admin / 临时密码登录 → 发一句问答
```

**仅当你启用了 IM 平台**(飞书 / Slack / 钉钉)时,再在群里 @bot 验证:

```bash
# 在飞书 / Slack / 钉钉群里 @bot 一句话(需先填好该平台凭据,见 §4 / §5):
@NotiOps 你好
```

期望几秒内回复。如果没反应 → §6 冒烟测试 / §10 排查。

✅ **完事**。

---

## 1. 部署架构

CDK 部署三个栈(选了 IM 平台时是四个,多一个 `ImStack`),`./setup.sh` 走 `cdk deploy --all` 一次部到位。**Web Chat(浏览器端主入口)与承载它的 AgentCore agent 默认就会部署** —— `setup.sh` 会先构建 chat-app 前端、跑 `scripts/deploy_agent.sh` 部署 agent,再 `cdk deploy --all`:

| 栈(CDK 名) | 必选 | 部署内容 |
|---|---|---|
| **`notiops-*`** | ✅ 必选 | Lambda × 8(`notiops-inspection-scheduler` / `-executor` / `-reconciler` / `-push`、`notiops-cost-analyzer`、`notiops-notifier`、`notiops-push-handler`、`notiops-phd-forwarder`)、共享 DDB 表、S3 报告 bucket、EventBridge rules(5 条 IM push 规则 + 10 条 web 通知规则 + notiops schedules)、agent-trigger Role(供 STS AssumeRole) |
| **`WebChatStack`** | ✅ 默认部署 | 浏览器端 agentic AI 助手(**产品主入口**):BFF Lambda(`notiops-web-chat-bff`)+ Function URL(`AWS_IAM`)、DDB 单表 `notiops-web-chat`(会话/消息 + 通知收件箱)、静态前端(chat-app)、通知 handler。BFF 通过 `-c agentRuntimeArn` 注入上一步 agent 的 Runtime ARN |
| **`ImStack`** | 选了 IM 才建 | **IM 的正式运行路径**:每个平台一个 **API Gateway HTTP API**(公网入口,`$default` catch-all)+ 一对 Lambda —— ingress(只验签 + 异步投递,`reservedConcurrentExecutions=10`)+ worker(真正干活,900s)、共用的依赖 Layer、去重表。Outputs 里的 `FeishuWebhookUrl` / `SlackWebhookUrl` / `DingtalkWebhookUrl` 就是你要填进 IM 平台控制台的请求地址(见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md)) |
| ~~**`BotStack`**~~ | ❌ **已退役(2026-09-03)** | 曾经是:VPC + Public Subnets、ECS Cluster(512 CPU / 1024 MB per task)、ECR repo、每个被勾选平台一个 Fargate Service、每个 task 内含 pricing + cost MCP sidecar、Task Role、Security Group。IM 重构 M2 之后 `infra/bin/app.ts` **不再实例化它**,所以新装机不会有 VPC / ECS / ECR,也不需要 finch / docker。源码(`infra/lib/bot-stack.ts` + 三个 Dockerfile)故意保留在仓库里当长连接回滚路径 —— 真要回滚就重新 `new BotStack(...)`,比从头重建 VPC/ECS + 重写镜像便宜。M2 之前装过的账号里这个栈还在:`teardown.sh` 仍按名字删它,也可以单独 `aws cloudformation delete-stack --stack-name BotStack`(它**没有任何 CFN Export**,不会被别的栈引用) |

**部署顺序**(`./setup.sh` 自动处理):
```
./setup.sh(交互式选 region / 可选 PHD /【默认跳过 IM】)
   → 构建前端(只有一个:`frontend/chat-app`) → 部署 Web Chat Agent → cdk deploy --all
(可选)想启用 IM 时:先 §3 注册 IM 应用,再重跑 setup.sh 选对应平台
```

凭据流向:`setup.sh` **不采集 IM 凭据**——它只根据你选的平台设置 `enabledPlatforms` 开关。CDK 会创建**占位** Secret(`notiops/im-bot-feishu` / `notiops/im-bot-dingtalk` / `notiops/slack-bot-token` / `notiops/slack-signing-secret`),部署完成后**三个平台都在 Web Chat 左侧「更多 → 管理 → 集成 IM」的对应分页里填**:飞书四个凭证同一张表单、钉钉一张、Slack 分页填 **Bot User OAuth Token**(`xoxb-`)+ **Signing Secret** 两个。也可以直接改 Secrets Manager(见 §4.2 —— webhook 模式**不需要**重启任何服务)。CDK 栈始终通过 ARN 引用这些 secret,本地不留任何凭据文件。

> ⚠️ 两个 Slack secret 存的是**纯字符串**(不是 JSON),而且 CDK 建出来的占位值是**随机字符**不是空串 —— 所以「忘了填」看起来像「填错了」(`invalid_auth` / 验签 401)。「集成 IM」页的「已配置」徽标按**值的形状**判断,占位值只会显示「未配置」;填完点「测试凭证」会把 workspace / bot 名字和**缺的 scope 逐条**报出来。

---

## 2. 前置条件

> ✅ **一条命令查完本节全部条目:`bash scripts/preflight.sh`**(只读,不装任何东西)。
> 每一项不满足的**具体后果**和**逐项处方**,以及 `setup.sh` 自己**不检查**的那几项
> (boto3 / 版本下限 / 交互式终端 / Bedrock 模型访问),都在
> **[PREREQUISITES.md](PREREQUISITES.md)**。本节是速查表,那份是展开版。

### 2.1 必装工具

| 项 | 要求 | 检查 |
|---|---|---|
| AWS CLI v2 | ≥ 2.13(支持 Bedrock) | `aws --version` |
| ~~AWS SAM CLI~~ | ~~≥ 1.100~~ | ~~`sam --version`~~ *(已废弃 — CDK 部署不需要 SAM CLI)* |
| Node.js | ≥ 22 | `node --version` *(CDK 依赖)* |
| ~~容器构建工具~~ | ~~finch(推荐) / docker~~ | — *(2026-09-03 起**不再需要** — 见下方说明)* |
| jq | 任意版本 | `jq --version` |
| Python | **≥ 3.10**(推荐 3.12+) | `python3 --version` |
| **uv** | 任意版本 | `uv --version` |
| **boto3** | 装在 setup.sh 会用的解释器里 | `python3 -c "import boto3"` — [处方](PREREQUISITES.md#3-boto3最容易漏的一项) |

> ⚠️ **`setup.sh` 只检查命令在不在,不比版本。** 上表的版本下限都是真实运行要求,但 preflight
> 用的是 `command -v` —— 版本不够会照样往下跑,失败发生在部署中段(云上资源已建一半)。
> `scripts/preflight.sh` 补的正是这一层。Python 下限是 **3.10**(不是"有就行"):打 Lambda 依赖层时
> `pip` 会拿 wheel 的 `Requires-Python` 比**当前解释器**,而 macOS 自带的 `/usr/bin/python3` 至今是 3.9.x。

> ⚠️ **uv 不是可选的**（`curl -LsSf https://astral.sh/uv/install.sh \| sh`，或 `brew install uv`）。
> `agentcore deploy` 打 agent 的 Python 依赖包时**无条件**调 `uv pip install`。缺它的后果不是
> "报错停下",而是**静默降级**:agent 部署失败 → 拿不到 Runtime ARN → BFF 回退 echo,而 web 端
> 照常部署成功、脚本照常打印 Chat URL。客户体验是「部署成功了,但一提问只把我的话回显回来」。
> `setup.sh` 现在会在 preflight 就拦住这种情况(除非 `SKIP_AGENT=true`)。
> 注意 uv 官方安装器装到 `~/.local/bin`,非交互式 shell 常常不在 PATH —— 装完新开一个终端。

> ℹ️ **容器构建工具(finch / docker)自 2026-09-03 起不再需要**,包括部署 IM。
> 唯一需要它的地方是老 `BotStack` 里那 5 处 `ContainerImage.fromAsset("../")`(ECS Fargate
> 长连接容器),而 IM 侧已于 IM 重构 M2 全量切到 Webhook + Lambda(`ImStack`),`infra/bin/app.ts`
> 不再实例化 `BotStack`。IM 的 Python 依赖层由 `scripts/build_im_layer.sh` 用
> `pip --platform manylinux2014_x86_64 --only-binary=:all:` 交叉下载,不需要容器。
> 顺带的收益:`cdk synth` 不再把整个仓库根当 Docker build context 算 hash(实测 594s → 12s)。
> ⚠️ 将来若又引入 Docker 资产,这一行、`setup.sh` 的 preflight、`scripts/preflight.sh`
> (它现在**完全没有**容器这一项)、[前置条件页](PREREQUISITES.md)的「容器运行时」那一行
> (现在写的是**不需要**)、以及仓库根那两份 README(中英各一)要一起改回来。

### 2.2 AWS 账号准备

- **AWS 账号**:有 admin 或同等权限
- ~~**VPC**~~:**不再需要** —— IM 侧走 Webhook + Lambda(`ImStack`),没有 ECS Fargate task,也就不需要 VPC / public subnet(2026-09-03,IM 重构 M2)。只有走 `infra/lib/bot-stack.ts` 长连接回滚路径时才需要
- **AWS DevOps Agent**:已开通(深度调查功能需要)。**无需自备 Agent Space** —— CDK 会在你账号下自动新建一个 `notiops-devops-<account>` space(详见 §5.3.5),你不用先手动创建或提供 space id
- **Bedrock**:模型目录里**默认模型**对应的 model 在你的 region 已 enable(Bedrock 控制台 → Model access)。当前默认是 **Moonshot Kimi K3**(`global.moonshotai.kimi-k3`);想让用户能切别的(Grok 4.7、GLM 5.3、Claude Sonnet 5.5 / Opus 5.5、DeepSeek、GPT-5.6 / GPT-6 Sol)就把对应的一并 enable。⚠️ Claude Sonnet 5.5 / Opus 5.5 和 GPT-6 Sol 需要**每个账号单独接受一次 AWS Marketplace 协议**:有的账号里 Sonnet 5 能用、5.5 还没开通。最省事的是在那个账号里把协议接受一次。不接受的话:在 Admin「模型」页把 `claude-sonnet-5` / `claude-opus-5` 重新启用**只修好 Web** —— IM 的别名 `claude` / `opus` 挂在 5.5 那两条上,所以还要**同时停用** `claude-sonnet-5-5` / `claude-opus-5-5`,再让 IM 用户改用 `@bot model claude-sonnet-5` / `@bot model claude-opus-5`(停用之后,已经设成 `claude` / `opus` 的 IM 偏好回落到默认模型)。`gpt_sol` 同理,它挂在 GPT-6 Sol(`gpt-6-sol`)上:不接受它的协议就把这一条停用(已经设成 `gpt_sol` 的偏好回落到默认模型)

### 2.3 Region 选择

`setup.sh` 把**所有栈都部到同一个 region**(region 菜单里选的那个,即 `DEPLOY_REGION`),没有「某个栈单独放到别的 region」的参数。所以选的这一个 region 要同时满足下面几条:

| 组件 | 对部署 region 的要求 | 备注 |
|---|---|---|
| **AWS DevOps Agent 服务** | **必须是支持 DevOps Agent 的 region** | 主栈在部署 region 直接建两个 Agent Space(排障 + 巡检),这个 region 没有 DevOps Agent 时建不出来,部署失败。一键模板里内置的清单是 `us-east-1` / `us-west-2` / `ca-central-1` / `sa-east-1` / `ap-south-1` / `ap-southeast-1` / `ap-southeast-2` / `ap-northeast-1` / `eu-central-1` / `eu-west-1` / `eu-west-2`;以 AWS DevOps Agent 文档的 Supported Regions 为准 |
| **IM 栈(`ImStack`;飞书 / Slack / 钉钉)** | 同部署 region | webhook 用的 API Gateway HTTP API 就建在这里 |
| **Bedrock** | 同部署 region | 没有单独的 Bedrock region 参数:模型调用从部署 region 发起(GPT-5.6 Terra / Luna 例外,固定走 `us-east-2`)。默认模型 Kimi K3 用的是 `global.` 跨区推理配置文件,模型访问的要求见 §2.2 |
| **DDB / S3** | 同部署 region | CFN 自动落到 stack 所在 region |

**最简单的部署**:`setup.sh` 的 region 菜单默认选 `1) us-east-1`(弗吉尼亚),直接回车即用该 region,它在上面那份 DevOps Agent 清单里,联网搜索也只有这个 region 可用。以前装在东京(`ap-northeast-1`)的部署,重跑升级时要选 `2)` —— 直接回车而 us-east-1 里还没有部署时,setup.sh 会先问一句再继续。选「自定义输入」之前先对一下这份清单。

### 2.4 IAM 部署权限

`setup.sh` 的权限需求分**三段**。与方式A(一键 CFN,见 [DEPLOYMENT_ONECLICK.md §1.1](DEPLOYMENT_ONECLICK.md#11-一个能开栈的-aws-账号--控制台权限))的实质差别只在**第三段**。

#### ① `cdk bootstrap` —— 每个账号 + 区域一次

`setup.sh` 在部署前跑 `npx cdk bootstrap`(不传 `--cloudformation-execution-policies`),开一个叫 `CDKToolkit` 的栈,建出:产物桶 `cdk-hnb659fds-assets-<账号>-<区域>` + KMS key、ECR 仓库 `cdk-hnb659fds-container-assets-…`、五个角色 `cdk-hnb659fds-{deploy,cfn-exec,file-publishing,image-publishing,lookup}-role-<账号>-<区域>`、一个记 bootstrap 版本的 SSM 参数。

这一步你的身份要有:`cloudformation:*`(建 CDKToolkit 栈)、`iam:CreateRole` / `PutRolePolicy` / `AttachRolePolicy`、`s3:CreateBucket` + `PutBucketPolicy`、`kms:CreateKey`、`ecr:CreateRepository`、`ssm:PutParameter`。

> ⚠️ **这一步就把管理员权限固化进账号里了。** 我们不传 `--cloudformation-execution-policies`,所以 CDK 用它的默认值 `arn:aws:iam::aws:policy/AdministratorAccess`,挂在 `cdk-hnb659fds-cfn-exec-role` 上。之后每一次 `cdk deploy` 都是那个角色在建资源。想收窄:得自己先手工 bootstrap 并传一个更窄的策略 ARN —— 但窄策略我们**没有验证过**,大概率装不全,不推荐。

#### ② `cdk deploy --all` —— 建三个栈

这一步**不需要**你对各个服务有写权限。`setup.sh` 不传 `--role-arn`,`cdk deploy` 会去 assume ① 建出来的 bootstrap 角色,真正建资源的是挂着 AdministratorAccess 的 `cdk-hnb659fds-cfn-exec-role`。你的身份只要能:

| 动作 | 资源 |
|---|---|
| `sts:AssumeRole` | `arn:aws:iam::<账号>:role/cdk-hnb659fds-*` |
| `cloudformation:DescribeStacks` / `GetTemplate` 等只读 | `*` |
| `ssm:GetParameter` | `/cdk-bootstrap/hnb659fds/version` |

栈内资源的服务范围与方式A基本同构,列表见 [DEPLOYMENT_ONECLICK.md §1.1 ②](DEPLOYMENT_ONECLICK.md#11-一个能开栈的-aws-账号--控制台权限)。

> **不需要 `ecs:*`**,也不需要 docker / finch:唯一需要容器构建的老 `BotStack` 已于 2026-09-03 退役,正常部署里不会推送任何镜像资产。`ecr:CreateRepository` 只在 bootstrap 资产被账外删除、需要自愈修复时才会用到。

#### ③ `setup.sh` 自己直接调的 AWS API —— **这段用的是你的凭证**

这是与方式A**最大的差别**:同样这些活,方式A交给栈里的 `StagerOrgSetup` Lambda 用它自己的执行角色去做(所以那条路的安装者不需要这些权限);`setup.sh` 是在你的终端里直接调的,**你的身份必须有**。

无条件都会调:

| 服务 | 动作 | 干什么 |
|---|---|---|
| `sts` | `GetCallerIdentity` | 确认账号 / 身份 |
| `cloudformation` | `DescribeStacks` / `ListStackResources` / `GetTemplate` / `DeleteStack` | 状态检查、退役旧栈 |
| `s3` | `CreateBucket` / `HeadBucket` / `PutBucketTagging` / `PutBucketPolicy` / `PutObject` | 产物桶;把成员账号接入模板同步到 `notiops-data-*` |
| `lambda` | `Invoke` / `GetFunctionConfiguration` | 部署后自检 |
| `dynamodb` | `GetItem` / `PutItem` | 写 `notiops-config` |
| `cognito-idp` | `ListUsers` / `AdminCreateUser` / `AdminAddUserToGroup` | 建第一个管理员 |
| `secretsmanager` | `DescribeSecret` / `DeleteSecret` | IM 凭证 secret 的检查与退役清理 |
| `ssm` | `GetParameter` | 读 bootstrap 版本 |
| `events` | `DescribeEventBus` | 事件总线检查 |
| `sns` | `GetTopicAttributes` | 告警主题检查 |
| `iam` | `GetRole` / `ListRolePolicies` / `ListAttachedRolePolicies` / `GetRolePolicy` / `DetachRolePolicy` / `DeleteRolePolicy` / `DeleteRole` / `ListInstanceProfilesForRole` / `RemoveRoleFromInstanceProfile` | 清理退役栈留下的角色 |

按开关才会调 —— **下面这几组就是方式A不需要、方式B需要的部分**:

| 触发条件 | 服务 | 动作 |
|---|---|---|
| `--multi-account`(组织内跨账号) | `organizations` | `DescribeOrganization` / `ListAccounts` / `EnableAWSServiceAccess` / `RegisterDelegatedAdministrator` / `ListDelegatedAdministrators` |
| 同上(用 StackSets 下发成员栈) | `cloudformation` | `CreateStackSet` / `UpdateStackSet` / `DescribeStackSet` / `CreateStackInstances` / `ActivateOrganizationsAccess` / `DescribeOrganizationsAccess` |
| 同上(复用已有 OAM Sink) | `oam` | `ListSinks` |
| 安全巡检的组织视图 | `securityhub` | `EnableOrganizationAdminAccount` / `CreateFindingAggregator` |
| 账单明细(CUR + Athena) | `cur` | `PutReportDefinition` / `DescribeReportDefinitions` |
| 同上(T+25h 一次性收尾任务) | `scheduler` | `CreateSchedule` |

> 用 IAM Identity Center 登录时还会跑 `aws sso login` —— 那是本地凭证获取,不需要账号内的 IAM 权限。

> ⚠️ **和方式A一样:这条路的安装者实际上等于账号管理员。** ① 里的 `iam:CreateRole` 加上 `cdk-hnb659fds-cfn-exec-role` 上那个 AdministratorAccess,合起来等价于权限提升。这里的「最小权限」只能是**收窄服务范围**,不可能做到「让一个非管理员来安装」。装完之后**日常使用 NotiOps 不需要任何 AWS 权限** —— 用户只在 Cognito 里登录,所以可以用一个临时安装身份装完再回收。

> 💡 **生产安全**:本项目所有 AWS 资源默认带 `auto-delete=no` 标签,避免被自动清理任务误删。

---

## 3. 注册 IM 应用

> 跳过对应的子节,如果你只部署其中一个平台。

### 3.1 飞书企业自建应用

> **注意配置顺序**:请求地址(Request URL)**必须等部署完成后才能填** —— 那个地址是
> `ImStack` 部署出来的,现在还不存在。所以这一节只做「建应用 + 配权限 + 拿钥匙」,
> 填地址那两步在 **[IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §1**(部署后执行)。
> 顺序反了的症状:飞书保存地址时会立刻发一次校验请求,钥匙还没写进 Secret 就会
> 显示「校验失败」,看起来像地址填错了。

1. 访问 [飞书开放平台](https://open.feishu.cn/) → 用企业管理员账号登录
2. **开发者后台 → 创建企业自建应用** → 填名称(例:NotiOps)
3. **应用功能 → 机器人 → 启用**,设 bot 显示名
4. **权限管理 → 批量导入/导出权限** → 导入下面这段 JSON。**前 11 条一条都不能少**
   ——`cardkit:*` 三条是卡片(进度卡、案例卡、按钮)用的,漏了的症状是消息能收、
   卡片发不出;`im:message.group_at_msg:readonly` 漏了则群里 @bot 收不到正文。
   最后那条 `im:message.reaction:write` 是**可选**的(见下面的说明):

   ```json
   {
     "scopes": {
       "tenant": [
         "cardkit:card:read",
         "cardkit:card:write",
         "cardkit:template:read",
         "im:chat",
         "im:chat.access_event.bot_p2p_chat:read",
         "im:message",
         "im:message.group_at_msg:readonly",
         "im:message.p2p_msg:readonly",
         "im:message:readonly",
         "im:message:send_as_bot",
         "im:resource",
         "im:message.reaction:write"
       ],
       "user": []
     }
   }
   ```

   ℹ️ `im:message.reaction:write`(2026-09-03 加的)只用来在「正在思考」卡片**之前**先给
   用户那条消息加一个 👀 表情,把"收到了"的反馈提前到毫秒级。**不加也能用** ——
   调用会返回非零码,ingress 日志里留一条 WARNING,答案不受任何影响,只是少了那个即时
   反馈。权限是随版本下发的:补权限之后必须回到第 8 步**重新发一个版本**。

5. **事件与回调 → 加密策略** → 拿到两把钥匙(webhook 模式下这是**唯一**的鉴权手段,
   两个都必须有值):
   - **Encrypt Key**:自己填一串随机字符串,建议 ≥32 位 —— `openssl rand -hex 24`
   - **Verification Token**:这一页直接给出,**复制下来**
6. **事件与回调 → 事件配置** → 订阅方式选 **「将事件发送至开发者服务器」**,
   订阅事件加 `im.message.receive_v1`(接收用户消息)。
   **请求地址先留空**,部署完再填(见上面的顺序提示)
7. **事件与回调 → 回调配置** → 订阅方式同样选 **「将回调发送至开发者服务器」**,
   订阅回调加 `card.action.trigger`(卡片按钮全靠它,漏了按钮点了没反应)。
   请求地址同样部署后再填,**与第 6 步填同一个地址**
8. **版本管理与发布 → 创建新版本** → 申请发布(自建应用 admin 可自批)
9. **保存** App ID + App Secret + 第 5 步那两把钥匙 ——`setup.sh` **不会**问你要凭据;
   部署完成后,在 **Web Chat 左侧「更多 → 管理 → 集成 IM」**填入 —— 四个凭证
   (App ID / App Secret / Encrypt Key / Verification Token)都在同一张表单上,
   保存即写进 Secret `notiops/im-bot-feishu`(也可以直接改那个 Secret,见 §5)。
   详见 §4 / §5 与 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md)
10. **把 bot 拉进群**。如果你想让每日运维通知和 AWS Health 事件(只有 `setup.sh` 部署才有,只发飞书,见 §7.1)发到某个群,先拿到目标群的 `chat_id`:

```bash
# 先拿 tenant_access_token
curl -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"'$FEISHU_APP_ID'","app_secret":"'$FEISHU_APP_SECRET'"}'

# 列群,记下目标群的 chat_id(以 oc_ 开头)
curl 'https://open.feishu.cn/open-apis/im/v1/chats' \
  -H 'Authorization: Bearer <tenant_access_token>' | jq '.data.items[]'
```
这个 `chat_id` 之后填进飞书 Secret 的 `notify_chat_ids`(或在 Web Chat「更多 → 管理 → 集成 IM」飞书分页的「推送群组 Chat ID」里配),**不是** `setup.sh` 的交互项(可选,留空 = 不发这两样)。调查结果回贴发起调查的那个会话,不用登记在这里;告警类实时事件推送这一版不投 IM(见 §7)。

### 3.2 Slack App

> 同 §3.1:**Request URL 要等部署完成后才填**,那三处地址在
> [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §2。

1. 访问 [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**
2. ⚠️ **不要开 Socket Mode** —— 它与 webhook **互斥**,开了 Slack 就不再往 Request URL
   发请求,bot 表现为完全没反应。也**不需要** App-Level Token(`xapp-...`)
3. **OAuth & Permissions → Bot Token Scopes** → 添加:
   - `app_mentions:read` / `channels:history` / `channels:read` / `chat:write` / `chat:write.public`
   - `groups:history` / `im:history` / `im:write` / `users:read`
   - `commands` — 斜杠命令(`/devops`、`/case` 等);漏了的症状是 `dispatch_failed`
   - `reactions:write` — **可选**,提问后先加一个 👀 表情(即时反馈)。漏了只是没有表情,
     答案不受影响;日志里是 `reactions.add error=missing_scope`
4. **Basic Information → App Credentials → Signing Secret** → 复制下来。webhook 模式下
   它是**唯一**的请求鉴权手段(取代 Socket Mode 时代的 App Token)
5. **Event Subscriptions → Enable Events: ON** → **Subscribe to bot events**:
   - `app_mention` / `message.channels` / `message.groups` / `message.im`
   - Request URL 部署后再填
6. **Install App → Install to Workspace**,拿 Bot Token(`xoxb-...`)
7. **保存** Bot Token + Signing Secret ——`setup.sh` **不会**问你要凭据;部署完成后填进
   **Web Chat 左侧「更多 → 管理 → 集成 IM」→ Slack 分页**(那一页右上角「查看详细配置步骤」把 1~8 步
   全列了,每步都能只在浏览器里做完),后端会写进 Secret `notiops/slack-bot-token` /
   `notiops/slack-signing-secret`。也可以自己改 Secrets Manager,详见 §4 / §5 与
   [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §2
8. 在目标 channel 中 `/invite @YourBot`。主动推送里目前**只有巡检推送**支持 Slack(每日通知、Health / 告警等其余主动推送不投 Slack),但本版本**还没有**把 Slack channel 登记成巡检推送目标的途径:没有网页入口(「集成 IM」的 Slack 分页只收 Bot Token 和 Signing Secret),`setup.sh` 不问,发布包里也没有对应的工具。所以这一版的 Slack 只用来和 bot 对话,巡检结果在 Web Chat「更多 → 巡检」里看。channel 设置面板里的 **Channel ID**(`C...`)只在你想限定 bot 只在某几个 channel 可用时才用得到(群允许清单,见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §4)

### 3.3 钉钉(DingTalk)企业内部应用

> 与飞书 / Slack 同一条形态:**Lambda webhook**(2026-09-08 起两条部署路径都支持)。
> `setup.sh` 的 IM 平台选项里是 `3) 钉钉 (DingTalk)`,一键部署路径对应
> `InstallOption=web+dingtalk`。同 §3.1:**消息接收地址要等部署完成后才填**。
>
> 完整步骤(地址从哪拿、怎么排错)在 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §3 ——
> 那一节**每一步都能只在浏览器里做完**:Web Chat 左侧「更多 → 管理 → 集成 IM」→ 钉钉分页 →
> 右上角「查看详细配置步骤」。

1. 访问 [open-dev.dingtalk.com](https://open-dev.dingtalk.com/) → **应用开发 → 企业内部应用 → 创建应用**。填名称和简介即可,**不需要**填服务器出口 IP
2. 左侧 **机器人** → 开启机器人能力,填机器人名称与图标 → 保存。钉钉**不需要**像飞书那样逐条勾权限 —— 收发消息走机器人能力自带的通道,与飞书那批 `im:` / `cardkit:` scope 不是一回事
3. 左侧 **凭证与基础信息** → 复制 **AppKey** / **AppSecret**(AppSecret 点一下才显示)。
   ⚠️ 钉钉**只有这一个 Secret**:AppSecret 同时用来换 access token、以及校验入站请求头里的
   `sign`。所以**没有**飞书那样的 Encrypt Key / Verification Token —— 表单上少两个输入框是
   **故意**的,不是漏了
4. **消息接收模式 → 选「HTTP 模式」**(钉钉默认是 **Stream 模式**,**必须改**)。
   ⚠️ 留在 Stream 模式下,钉钉不会往我们的地址发任何请求,机器人表现为一句话不回 ——
   这是这条路上最贵的一步。**消息接收地址**填部署输出的 `DingtalkWebhookUrl`
   (**结尾的 `/` 要保留**),部署完成后再回来填
5. **版本管理与发布 → 发布一个版本** —— 不发布的话机器人加不进群
6. 群设置 → **智能群助手 → 添加机器人** → 选刚发布的那个应用机器人
7. **保存** AppKey + AppSecret ——`setup.sh` **不会**问你要凭据;部署完成后在
   **Web Chat 左侧「更多 → 管理 → 集成 IM」→ 钉钉分页**填入,保存即写进 Secret
   `notiops/im-bot-dingtalk`(两条部署路径的 Secret 名完全一致;也可以直接改那个 Secret,
   见 §5)。⚠️ 顺序**很重要**:**先把凭证存进去,再去填消息接收地址** —— ingress 冷启动会
   硬校验这两个值,缺任一就直接起不来(宁可入口起不来,也不要开一个谁都能伪造请求的公网地址)
8. **(可选)自定义机器人推送地址**:在群里再加一个**自定义机器人**(群设置 → 群机器人 →
   添加机器人 → 自定义),把它的 webhook URL 填进同一个 Secret 的 `webhook_url` 键(网页上就是
   「集成 IM」钉钉分页的「自定义机器人推送地址」)。这一版只有两处用它:调查报告按会话回贴失败时的
   兜底,以及巡检推送(只有 `setup.sh` 部署才有,而且要先把群登记成巡检推送目标 —— 本版本还没有这一步
   的途径);每日通知、Health 和实时事件推送都不投钉钉(见 §7)。⚠️ **这一版里,自定义机器人的三种
   安全设置(钉钉要求至少选一种)哪一种都保证不了投递**:「加签」要一个签名密钥,而两条部署路径都没有
   地方保存它,我们发出去的消息不带签名,会被钉钉拒收(「测试凭证」会显示推送地址拒收了那条消息);
   「自定义关键词」要求每条消息都含那个词,而我们发出的报告不保证含有 ——「测试凭证」那条测试消息里有
   `NotiOps`,所以它通过**不**代表真实报告也能投进去;「IP 地址(段)」要固定的出口 IP,而这些 Lambda
   没有。这个地址只管上面那两处兜底与推送(后者本版本还配不起来),所以**这一步可以跳过**。
   ⚠️ 它与第 4 步的「消息接收地址」**方向相反**,同名很容易搞混:前者是我们**往钉钉发**
   (是凭证),后者是钉钉**往我们发**(是公开入口地址)。跳过这一步,对话和调查派发不受影响

> ⚠️ **钉钉保存消息接收地址时什么都不校验** —— 没有飞书那种 URL challenge,不会当场变绿,
> 也不会报错。所以**地址填错一个字符**和**凭证还没保存**,表现完全一样:机器人一句话不回。
> 唯一可靠的排错入口是两条日志(`notiops-im-ingress-dingtalk` /
> `notiops-im-worker-dingtalk`),见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §3.5 ——
> 入口有没有收到请求,一眼就把「钉钉没发出来」和「我们没认出来」分开。
>
> 钉钉这条路**需要公网入站**(API Gateway HTTP API),与飞书 / Slack 相同。老部署里那条
> 「Stream Mode 出站长连接、不需要公网入站」的形态(`BotStack` 的 ECS task)已于
> 2026-09-03 退役。

---

## 4. 配置项与 IM 凭据

CDK 部署不需要 `bootstrap.env` —— `./setup.sh` 第一次跑会**交互式**问你部署参数(账号 / region / 是否 PHD / 选不选 IM 平台)。**注意:`setup.sh` 不采集任何 IM 凭据** —— CDK 只创建**空的** IM Secret,部署完成后你再填(见 §4.2)。

### 4.1 你会被 setup.sh 问到的项

| 类别 | 项 | 说明 |
|---|---|---|
| **AWS Profile** | 部署用 Profile | 从本地 `~/.aws` 的 profile 列表里选,或保持当前 |
| **AWS** | Account ID | `aws sts get-caller-identity` 自动检测,确认即可 |
| | Region | 6 个选项(`us-east-1`【默认】/ `ap-northeast-1` / `us-west-2` / `eu-west-1` / `ap-southeast-1` / 自定义输入)。所有栈都部到这一个 region,它必须支持 AWS DevOps Agent(见 §2.3) |
| **Push (PHD)** | 是否部署 PHD 事件转发 | 默认 `Y` 部署;`--phd` 标志走 linked account 侧转发 |
| **Multi-account** | 业务账号允许清单 | `--multi-account` 标志单独走;默认单账号 |
| **IM 平台**(可选) | 选项 | `1` 飞书 / `2` Slack / `3` 钉钉(可多选,如 `1,3`)/ `0` 暂不部署(**仅首装**默认,只上 web 端)。**重跑**时默认 = 原样保留现网已启用的平台(`keep`);读不到现网状态又没有 TTY 时**直接报错退出**,不会按默认值继续。**只设 `enabledPlatforms` 开关,不问凭据** |

> **Agent Space id 不是交互项** —— CDK 自动新建 `notiops-devops-<account>`(见 §5.3.5),你无需提供。

### 4.2 IM 凭据存哪 / 什么时候填

`setup.sh` 部署时,CDK 会**创建空的** IM Secret;凭据在**部署完成后**填,两种方式(脚本结尾横幅也会提示):
- **填法一(推荐)**:登录 Web Chat(admin) → 左侧「更多 → 管理」→「集成 IM」填入
- **填法二**:直接更新下表的 Secret。**不需要重启任何东西** —— IM 走 Lambda,
  凭据在冷启动时读,改完 Secret 下一次冷启动就生效(想立刻生效就等几分钟或改一次
  Lambda 环境变量强制换实例)。⚠️ 旧文档里那条
  `aws ecs update-service --force-new-deployment` 只对**回滚用的** `BotStack` 长连接容器
  有意义,webhook 模式下对它做什么都不影响。

CDK 栈始终通过 ARN 引用这些 secret,**本地不落任何凭据文件**。

| Secret 名(自动建,初始为空) | 用途 |
|---|---|
| `notiops/im-bot-feishu` | 飞书机器人凭证(单个 Secret,JSON:`app_id` / `app_secret` / `verification_token` / `encrypt_key` / `notify_chat_ids`)。⚠️ webhook 模式下 `encrypt_key` 与 `verification_token` **两个都必填**,少一个 ingress 冷启动就崩(见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §1.2) |
| `notiops/slack-bot-token` | Slack bot token(`xoxb-`) |
| `notiops/slack-signing-secret` | Slack signing secret —— **webhook 模式下唯一的请求鉴权手段**,必填 |
| `notiops/slack-app-token` | Slack app-level token(`xapp-`,Socket Mode)。webhook 模式**用不到**,只有切回 `BotStack` 长连接回滚时才需要 |
| `notiops/im-bot-dingtalk` | 钉钉机器人凭证(单个 Secret,JSON:`app_key` / `app_secret` / `webhook_url`)。`app_key` / `app_secret` **必填**,少一个 ingress 冷启动就崩;`webhook_url`(群里自定义机器人的地址)**可选**,只用于调查报告按会话回贴失败时的兜底和巡检推送(后者本版本还配不起来,见 §3.3 第 8 步);定时日报、Health 和实时事件推送都不投钉钉 |
| `notiops/bedrock-api-key` | Bedrock API Key(跨账号模型调用认证;部署后手动填充,留空则走 IAM) |
| `notiops/litellm-config` | OpenAI 兼容网关(LiteLLM、New API 等)的地址与 Key(JSON:`base_url` / `api_key`)。在 Web「更多 → 管理 → 模型」里填,不用手动改;不用网关就留空(见 [USER_GUIDE §6.5](USER_GUIDE.md#65-模型)) |

> 钉钉的 Secret 就是上表那条 `notiops/im-bot-dingtalk`,**和飞书 / Slack 同一套机制** —— CDK 自动创建(建成空的),部署完成后填 JSON,**不需要手动 `create-secret`**。**不存在 `bot-stack-*/` 前缀的 Secret,也不存在 `notiops/devops-agent-config`**(Agent Space id 等元数据走 DDB onboard 记录 + CDK context,不落 Secret)。

### 4.3 可选 override(改默认行为)

这些都是合成期读的 CDK context。`setup.sh` 每次都用 `-c` 传它管的那几个(`organizationId` /
`agentRuntimeArn` / `costAgentMcpUrl` 等,由它的开关和环境变量决定);它**不传**的(比如 `allowedOrigins`),
写进 `infra/cdk.json` 的 `context` 段,再重跑 `./setup.sh`。别在手工 `cdk deploy` 时 `-c` 传:下一次
`./setup.sh` 不会带上它,只部一个栈还会丢掉 `setup.sh` 平时传的那些(见 §8.1)。

| Context | 默认 | 说明 |
|---|---|---|
| `allowedOrigins` | (空 = 所有来源) | CORS 可信域名允许清单,逗号分隔,如 `https://d123.cloudfront.net` |
| `organizationId` | (空) | 非空 = 多账号(Organizations)模式。由 `./setup.sh --multi-account` 传,别手填 |
| `inspectionReportLocale` | (空 = 跟随 `DEFAULT_LOCALE`) | 巡检**判读正文**的语言,全局单值(`setup.sh` 从 `$INSPECTION_REPORT_LOCALE` 转成它) |
| `monthlyLimitSeconds` | `-1`(= 不限) | 巡检执行器的月度秒数预算护栏 |
| `opsAlertEmail` | (空) | 运维告警邮箱(SNS 订阅) |
| `webBaseUrl` | (空) | 巡检推送正文里「查看详情 / 查看全部」深链的站点根;空 = 不带深链 |
| `reportsCdnDomain` | (空) | 报告下载走自有 CDN 域名;空 = 回退 presigned URL(12h 后失效) |
| `skipPhd` | `false` | `true` = 不建 PHD 转发器。默认建 —— `setup.sh` 不再问这一项,想关就 `ENABLE_PHD=false ./setup.sh`(见下方说明) |
| `phdLinkedAccounts` | (空) | PHD 要关注的成员账号(逗号分隔) |
| `oamSinkArn` | (空) | 复用已有 OAM sink,而不是新建一个 |
| `costAgentMcpUrl` / `costAgentFunctionArn` | (空) | 「外接」模式:指向你**自己在跑**的 cost-agent MCP(两个必须成对),作 FinOps 里四张 CUR 报表的数据源。想让 NotiOps 替你部这个 server(推荐),用 `COST_MCP_SELF_HOST=true ./setup.sh`,不用这两个 —— 见 §14.2。两种都不配时这四个入口整个不出现(见 `requiresEnv`) |
| `agentRuntimeArn` | (空) | 已部署好的 Web Chat AgentCore Runtime ARN。`setup.sh` 部署完 agent 后自动传 |
| `operatorAppAlreadyEnabled` | `false` | ⚠️ **不要手工传** —— 传 `true` 会让栈以为 Operator App 已启用而跳过启用步骤 |
| `mfaMode` | `OPTIONAL` | Web 登录两步验证(验证器 App):`OFF` / `OPTIONAL` / `REQUIRED`(`OPTIONAL` 时每个人在菜单里自己开、「管理」页要求先开;`REQUIRED` 时所有人下次登录必须绑定)。由 `setup.sh` 从 `$MFA_MODE` 转成它:**没设 `MFA_MODE` 时保留上次的选择**(读 `NotiOpsBackendStack` 的 `WebMfaMode` 输出),第一次装、或从 v1.0.33 及更早升级上来时是 `OPTIONAL`。例:`MFA_MODE=REQUIRED ./setup.sh`。管理员丢了手机的重置办法见 [DEPLOYMENT_ONECLICK.md §8](DEPLOYMENT_ONECLICK.md#8-安全说明值得知道的几条) 第 7 条(两条路径一样) |

IM 侧的 `enabledPlatforms` / `imAllowedChatIds` 见 §11.1 的 `ImStack` context 表。
`infra/cdk.json` 的 `context` 段里默认**没有**这些 key 的条目,要用就自己加进去,再重跑 `./setup.sh`
(`enabledPlatforms` 除外 —— 它由 `setup.sh` 里 IM 平台那一问决定,见 §8.1)。

**AWS Health 事件转发(PHD)默认启用,`setup.sh` 不提问。**

| | |
|---|---|
| 它做什么 | 把 AWS Health 事件经 Bedrock 摘要后**额外**推一条到飞书群 |
| 没配飞书时 | 什么都不推,而且**不调 Bedrock**(转发器在摘要之前先判 `notify_chat_ids`),成本只剩一次 Lambda 调用 |
| 与 Web 通知收件箱的关系 | **无关**。Health 事件本来就会进 Web Chat 的通知收件箱,那条路不受这个开关影响 |
| 怎么关 | `ENABLE_PHD=false ./setup.sh`,而且以后每次重跑都要带上(`setup.sh` 默认建它,不带就会建回来) |
| 目前支持的 IM | 只有飞书(`phd_event_forwarder/notifier.py` 走 `shared.feishu_sender`);钉钉 / Slack 尚未接 |
| 部署路径 | 只有**方式 B**(`setup.sh` / CDK)有这个转发器;方式 A(一键 CloudFormation)不含 PHD |

旧版本会在选完区域后问一句「是否额外把 AWS Health 事件推送到飞书 IM 群?」——
那个问题排在「选 IM 平台」**之前**,客户在那个位置无法回答,已删除。

> 🔴 **这张表以前列的 7 个 key 里有 6 个压根不存在**(`bedrockModelId` /
> `agenticChatMode` / `awsMcpMode` / `enableMcpPricing` / `defaultLocale` /
> `defaultLlmProvider`),而且 `bedrockModelId` 写的默认值 `us.anthropic.claude-sonnet-4-6`
> 也早就不是现在的默认模型(现在是 `global.moonshotai.kimi-k3`,且真值走 DDB 模型目录而不是
> 部署参数)。它们是 M2 之前喂 `BotStack` Fargate 容器的老 key,那个栈已退役 ——
> 判据:`git grep -n <key> -- infra/` 全部 0 命中。详见 §11.1 那条同名警告。

> **⚠️ CORS 收窄(生产建议)**：Web Chat Function URL 的每个端点都已由
> Cognito / AWS_IAM(SigV4)鉴权,浏览器 CORS 不是主要信任边界;因此**默认回退到
> 所有来源**(`*`),以便示例仓库无需预知部署期才生成的 CloudFront 域名即可开箱可用。
> 生产部署应显式收窄:在 `infra/cdk.json` 的 `context` 里加
> `"allowedOrigins": "https://<你的前端域名>"`(就是 `WebChatStack` 输出的 `ChatUrl`),再重跑 `./setup.sh`。
> `setup.sh` 不传这个 key,所以只在一次手工 `cdk deploy` 里 `-c` 传的话,下一次 `./setup.sh` 就回到 `*`(见 §8.1)。
> 未设置时,`cdk synth`/`deploy` 会打印一条告警提示你收窄——这是纵深防御的推荐做法,
> 不影响功能。

---

## 5. 一键部署 `setup.sh`

```bash
./setup.sh
```

走完前置准备(§2;想启用 IM 才需 §3 注册 IM 应用)后,这一行命令就够了。

### 5.1 setup.sh 都做了什么

1. 依赖检查:`node` ≥ 22 / `npm` / `npx cdk` / `aws` / `jq` / `python3` / `uv`(**缺 uv 直接退出** —— 否则 agent 部署失败会让 Web Chat 静默退化成回显;`SKIP_AGENT=true` 时不检查)。**已经完全不需要容器构建工具** —— 2026-09-03(IM 重构 M2)起 `finch` / `docker` 都不再是前置条件,见 §2.1
2. 让你从本地 `~/.aws` profile 列表选部署 Profile(或保持当前)
3. 调 `aws sts get-caller-identity` 检测账号,要你确认
4. 让你从 6 个选项里选 deploy region(默认 `us-east-1`;含"自定义输入")
5. (可选)问是否部署 PHD 事件转发功能(默认 `Y`)
6. 让你选要部署哪些 IM 平台(`1` 飞书 / `2` Slack / `3` 钉钉,可多选如 `1,3`;`0` 暂不部署 —— **仅首装**时是默认值)。**重跑**时默认 = 原样保留现网已启用的平台,回车不会让正在跑的 bot 停更在旧代码上。**只设 `enabledPlatforms` 开关,不采集凭据**
7. **`[1/4]` 构建前端** —— 只构建 Web Chat 前端(`frontend/chat-app`)。老 admin 控制台(`frontend/frontend-app`)连同它背后的老 REST API 已于 2026-09-04 随本版退役,目录在仓库里已不存在,`setup.sh` 不再构建它。这一步还会把 `config/capabilities.json` / `config/eol-dates.json` 复制进 `bff/web-chat/`(能力清单单一真源在 `config/`,而 Lambda 只打包 `bff/web-chat/`)并装 BFF 依赖(`npm ci --omit=dev`)
8. **部署 Web Chat Agent** —— 跑 `scripts/deploy_agent.sh`,把 Strands agent 部署到 AgentCore Runtime,拿到 Runtime ARN(经 `-c agentRuntimeArn` 注入 WebChatStack;`SKIP_AGENT=true` 可跳过,BFF 回退 echo)
9. **`[2/4]` 安装 Lambda 依赖**(boto3 / powertools / jinja2,`--platform manylinux2014_x86_64` 装 Linux 二进制)。**选了 IM 时**还会跑 `scripts/build_im_layer.sh` 构建 IM 依赖 Layer(`lark-oapi` / `slack-sdk` / `boto3`,同样是 manylinux 轮子);这一步失败会**当场中断**而不是静默跳过 —— Layer 里缺包时 `ImStack` synth 就直接报错
10. CDK bootstrap(如果该账号 + region 还没 bootstrap 过;已 bootstrap 且健康则复用)
11. **`[3/4]`** CDK synth → IAM 一致性检查 → **CDK deploy `--all`**(`NotiOpsBackendStack` + **`WebChatStack`**;选了 IM 时再加 **`ImStack`**)。**不再有任何镜像 build** —— `BotStack` 已退役(见 §0.1)
12. **CUR + Athena FinOps 数据源**引导(检测 / 复用 / 新建,详见 §13)
13. **创建 Cognito `admin` 用户 + 临时密码**(首次部署),并把它加进 admin 组
14. **`[4/4]`** 把 outputs 写到 `cdk-outputs.json`,并打印**以 Web Chat 为主入口**的完成横幅(Web Chat 地址 + `admin` 登录凭据在最上方)

总耗时:首次 ~10-15 分钟(主要在 CDK deploy + agent 部署;选了 IM 再加上面第 9 步的 IM 依赖层构建 —— `pip --platform manylinux2014_x86_64 --only-binary=:all:` 交叉下载轮子,**不是镜像 build**)。重跑只补差异 ~3-5 分钟。

### 5.2 单独流程(不需要全量 deploy 时)

| 任务 | 命令 |
|---|---|
| 部署 PHD 跨账号转发 stack(linked account 上跑) | `./setup.sh --phd` |
| 删除上面的 PHD stack | `./setup.sh --phd --remove` |
| 配置多账号允许清单(让 bot 跨账号调查) | `./setup.sh --multi-account` |

直接用 CDK 命令的常用场景:

```bash
cd infra

# 改了 cdk.json 的 context 之后,正确做法是回仓库根重跑 ./setup.sh(见 §8.1);
# 下面这几条是不经 setup.sh 的裸 CDK 命令,先读完下方那条警告再用
npx cdk deploy --all

# 单独 redeploy 一个栈
npx cdk deploy NotiOpsBackendStack
npx cdk deploy ImStack       # IM 侧(飞书 / Slack / 钉钉 webhook + Lambda)

# Diff 看会变什么
npx cdk diff --all
```

> ⚠️ 这几条命令只带你自己给的 `-c`,`setup.sh` 平时传的那些一个都不会有 —— 照抄之前先看 §8.1 末尾那条警告。

### 5.3 ⚠️ 部署后必读 — Agent Space 重新配置

`./setup.sh` 跑完后,CDK **在你账号下新建了一个 Agent Space**(命名:`notiops-devops-<account_id>`)。这个 space 是**全新的、空的**,bot 派发调查时**只用这一个 space**,与你账号下其他已有 space **完全隔离**。

#### 5.3.1 影响

如果你账号已经有别的 Agent Space(手动建的、给别的项目用的),它们的配置 **不会** 被 NotiOps 自动继承。**新 space 默认只能调查 AWS 原生服务**(EC2 / RDS / Lambda / CloudWatch / Logs / IAM,通过 `AIDevOpsAgentAccessPolicy`),其他全部要重配。

#### 5.3.2 你可能需要重新配置的内容

按你现有 space 的复杂度,逐项 check:

| 类别 | 是否影响 | 如何在新 space 里重配 |
|---|---|---|
| **第三方 MCP server**(Grafana / Datadog / Splunk / PagerDuty / Slack / Jira / GitHub / 自建) | ✅ 影响 | DevOps Agent Console → Agent Spaces → 选 `notiops-devops-<account_id>` → MCP Servers → Add → 重新填 endpoint + 凭据 |
| **自定义 Skill / Playbook**(你编排的诊断步骤) | ✅ 影响 | 同上 → Skills → Import / 重新创建 |
| **IAM 数据源扩展**(数据库 ReadOnly / S3 ReadOnly / 自建 service ReadOnly) | ✅ 影响 | 找 `notiops-agent-primary-<account_id>` 这个 IAM Role → 加 inline policy 给所需 ReadOnly 权限 |
| **跨 region 资源访问** | ✅ 影响 | Primary role 默认只覆盖部署 region 的服务,其他 region 需自行验证 |
| **跨账号 onboarding**(调查别的业务账号资源) | ✅ 影响 | 业务账号里要有 NotiOps 的 trigger role(`notiops-agent-trigger-<业务账号>-m<部署账号>`)+ 在 NotiOps 这边的 DDB 登记该账号 —— 两件事都在 Web Chat「更多 → 管理」→「账户」里完成:多账号模式部署(`./setup.sh --multi-account`)下,组织内账号点「一键接入」(成功后会自动接着做「第二步: DevOps Agent」关联;徽章没走到「调查能力已启用」、旁边出现「一键关联」按钮时,再点它重试);其余情况(账号不在本组织、没有管理账号权限,或没有按多账号模式部署)用同页「手动接入账号」(见 §0.1.1)。⚠️ 没有按多账号模式部署时,这样接进来的账号要调查只能用 Web 上直连 DevOps Agent 的「深度调查」/「DevOps 对话」;IM 与 NotiOps 模型的对话仍只看部署账号,要跨账号得用 `--multi-account` 重新部署(见 §0.1.2) |
| **AWS 原生服务 ReadOnly**(EC2 / RDS / Lambda / CloudWatch 等) | ❌ 不影响 | `AIDevOpsAgentAccessPolicy` 已自动授权,开箱即用 |

#### 5.3.3 Web 应用(Operator App)已自动开好 — 不需要手点

控制台上那一步「Agent Space → Access → Operator access → **Configure web app**」(API 是 `aidevops:EnableOperatorApp`)**由 CDK 在建 space 的同时完成**,你不需要去点。为此栈里多了一个角色 `notiops-agent-webapp-<account_id>`(信任 `aidevops.amazonaws.com`、挂 AWS 托管策略 `AIDevOpsOperatorAppAccessPolicy`),删栈时随 space 一起关闭并删除。多账号模式下,成员账号那份 StackSet(`infra/member-devops-agent.yaml`)同样自动开 —— 否则接 N 个账号就要登进 N 个成员账号的控制台各点一次。⚠️ 2026-08 之前接入、当时在成员账号控制台里手动开过 web app 的存量实例:更新到新模板时服务端会报 `Operator App … is already enabled`、实例回滚(巡检 space 也就建不出来,管理页那一行显示「待更新栈」)。对这类实例按实例覆盖参数 `OperatorAppAlreadyEnabled=yes` 再更新:`aws cloudformation update-stack-instances --stack-set-name notiops-member-devops-agent --accounts <成员账号> --regions <区> --parameter-overrides ParameterKey=OperatorAppAlreadyEnabled,ParameterValue=yes`;覆盖值记在实例上,之后重跑 `./setup.sh --multi-account` 也不会丢。别改 StackSet 级的值 —— 新接入的账号要靠模板开 web app。

**没开过它的症状**:发起调查 / 连接调查 / DevOps 对话 / 发布 Skill 一律报 `Invalid or unregistered domain`(错误信息完全不指向"少点了一个按钮")。现在还能撞上这个报错的只有两种 space:**本版本之前建的老 space**,和你**自己手工建的 space** —— 这两种进控制台点一次 Configure web app 即可。

> ⚠️ **老部署升级到本版本时**(space 已存在、当初是在控制台手点开的 web app):模板里这条属性从"没有"变成"有",CloudFormation 会去 Enable 一次,而服务侧其实已经是 enabled。**这一情形尚未实测**(幂等 or 报冲突)。若 `NotiOpsBackendStack` 更新因此失败,先 `aws devops-agent disable-operator-app --agent-space-id <space id> --region <region>` 再重跑 `./setup.sh` —— web app 域名由 space id 派生,关掉重开**不会换 URL**。

#### 5.3.4 推荐的最小验证流程

```bash
# 1. 进 DevOps Agent Console,找你的新 space
#    https://console.aws.amazon.com/aidevops/home#/agent-spaces
#    名字以 `notiops-devops-` 开头的就是 NotiOps 新建的

# 2. @bot 一句最简单的 AWS 原生调查请求,验证开箱权限
#    @NotiOps 列出 IAD 所有 EC2 实例
#    几秒收到调查派发卡 = 部署账号侧 wire 通

# 3. 如果你之前在别的 space 里配了 Grafana / 自定义 skill,
#    重复一次: console → 新 space → 重新 add
```

#### 5.3.5 为什么不复用你已有的 space

CDK 模板默认 `CfnAgentSpace` 是 **CREATE 一个新的**,理由:

- ✅ **零配置**:新部署的客户 `setup.sh` 一跑,Agent Space + Trigger Role + Association 全自动 wire 好
- ❌ **副作用**:已有 space 的客户需要在新 space 里重做配置(本节)

后续规划里有一项 "支持复用已有 Agent Space" 的能力,会让 `setup.sh` 交互式问"你已有 Agent Space 想复用吗?"。当前版本 **不支持**。

### 5.4 升级已装环境:跨栈 Export 退役预检(setup.sh 自动做)

**只有升级会遇到,首装不会。** 已经装过老版本、现在重跑 `./setup.sh` 升级时,可能撞上这个:

```
Export NotiOpsBackendStack:ExportsOutputFnGetAttFrontendCDNF4E135DEDomainNameBF02A209
cannot be deleted as it is in use by WebChatStack
```

随后 `NotiOpsBackendStack` 变成 `UPDATE_ROLLBACK_COMPLETE`、`WebChatStack` / `ImStack` 全部 SKIPPED。

**为什么会这样**:方式 B 是三个栈(主栈 + WebChatStack + ImStack),栈之间传值(Cognito 池 id、报告 CDN 域名等)由 CDK 自动生成 **CFN Export**。某一版退掉一个跨栈传参时(本版退掉了随老控制台一起下线的 `idleConsoleUrl`),主栈这一版就要**删**那条 export;而你机器上已装的**老** WebChatStack 还持有 `Fn::ImportValue`,CloudFormation 硬拒。`cdk deploy --all` 先更主栈,所以先撞的就是这一堵墙。

**⚠️ 关键点:平淡重跑不会自愈。** CloudFormation 把 `UPDATE_ROLLBACK_COMPLETE` 视为一个正常的稳定态,CDK 也不会 delete-and-recreate,所以再跑十遍 `--all` 都是同一个错。

**你要做什么:什么都不用做 —— 重跑 `./setup.sh` 就行。** 本版起 `setup.sh` 在 `cdk deploy --all` 之前会自动跑一次预检([scripts/export_retire_plan.py](../scripts/export_retire_plan.py),只读 `describe-stacks` + 本地合成产物,不改任何资源),四种结论:

| 预检结论 | 含义 | setup.sh 的动作 |
|---|---|---|
| `SKIP` | 首装,或本版不删除任何已部署的 export(**绝大多数升级**) | 照常 `--all`,行为与旧版逐字节一致 |
| `REORDER <栈>…` | 本版要退役 export | **先**单独 `cdk deploy <消费者栈> --exclusively` 把引用放开,**再** `--all` |
| `WAIT <状态>` | 主栈正在变更中(`UPDATE_IN_PROGRESS` 等) | 中止并让你等它结束再重跑 —— 此时任何判断都会过期 |
| `FALLTHROUGH …` | 同一版**既退役又新增** export,消费者要用新增那条 | 大声告警后按常规顺序继续(见下) |

**已经卡在 `UPDATE_ROLLBACK_COMPLETE` 了怎么办**:直接重跑 `./setup.sh` —— 预检会识别出来并自动重排。想手工做也可以:

```bash
cd infra
# 1. 先单独更新消费者栈,让它不再 import 那条要被删的 export
#    ⚠️ --exclusively 必须带:否则 CDK 会先去部它的依赖(主栈),等于又走一遍出问题的顺序
#    ⚠️ -c 要带全(照 setup.sh 那一行抄),少一个就会 synth 出另一份模板
npx cdk deploy WebChatStack --exclusively --require-approval never <setup.sh 那一行的全部 -c>
# 2. 再全量 —— 同样要带全套 -c;最省事的是直接重跑 ./setup.sh
npx cdk deploy --all <setup.sh 那一行的全部 -c>
```

**`FALLTHROUGH` 怎么办**:这种版本无法用重排救(先部消费者会 `No export named … found`,先部主栈会撞 export 删除失败)。正确做法是**拆两次发布**:先发只退役的那一版,再发新增的那一版。仓库侧有一道 CI 闸门(`cfn-export-gate` + [infra/exports.golden.json](../infra/exports.golden.json))在代码进 main 之前就把这种版本拦下来,所以你作为部署者基本不会看到它。

> 📌 **方式 A(一键部署)不受影响**:它是**单栈**(`NotiOps`),没有任何跨栈引用,也就没有 CFN Export —— 结构上不存在这个失败模式,所以方式 A 侧不需要对应的预检步骤。这不是功能缺口(两条路径的 **web 功能**仍然完全一致)。

---

## 6. 冒烟测试

> 💡 **怎么找你这次部署出来的实际资源名**:
> ```bash
> # Lambda 函数(IM 是 notiops-im-*,Web Chat BFF 是 notiops-web-chat-bff;没有 ECS 了,见 §6.1)
> aws lambda list-functions --region $AWS_REGION \
>   --query 'Functions[?starts_with(FunctionName, `notiops-`)].FunctionName'
>
> # CloudWatch log group(这些函数的日志组是 /aws/lambda/<函数名>)
> aws logs describe-log-groups --region $AWS_REGION \
>   --query 'logGroups[?contains(logGroupName, `notiops`)].logGroupName'
>
> # CloudFormation stack outputs(也写到了 cdk-outputs.json)
> cat infra/cdk-outputs.json
> ```
> 下文示例命令里的 `<log-group>` 是占位符,替换成上面查到的真名即可。

部署完成后立刻验:

### 6.0 Web Chat 控制台(主入口 —— 先验这个)

> Web Chat 是产品主入口,默认部署;这是**最重要的一步**。IM(§6.1-6.3)只在你启用了对应平台时才需要验。

1. 浏览器打开脚本结尾横幅打印的 **Web Chat 地址**(也可 `jq -r '.WebChatStack.ChatUrl' infra/cdk-outputs.json`)
2. 用 `admin` / 脚本打印的临时密码登录(首次登录需改密码)
3. 左侧导航能看到:通知 / 调查 / 成本 / 案例 / **更多**(展开是 巡检 / 技能 / 管理),**没有**「安全」—— 安全看板从「调查」输入框上方的「安全态势」胶囊进
4. 发一句问答或调查请求(例:"帮我调查 IAD 的 EC2"),几秒内有响应即成功

更完整的 Web Chat 冒烟见 §12.6。

### 6.1 Webhook 入口活着(仅当启用了 IM)

> §6.1-6.3 **只在你启用了 IM 平台(飞书 / Slack / 钉钉)时适用**。只上 web 端时这几条都不用看。

IM 走的是 **API Gateway HTTP API + Lambda webhook**,没有常驻容器可看,判据是「地址存在 + 有日志」:

```bash
# 地址(这就是要填到飞书 / Slack / 钉钉控制台的那个)
aws cloudformation describe-stacks --stack-name ImStack --region $AWS_REGION \
  --query 'Stacks[0].Outputs[?OutputKey==`FeishuWebhookUrl`||OutputKey==`SlackWebhookUrl`||OutputKey==`DingtalkWebhookUrl`]' \
  --output table
```

> ℹ️ **没有容器了**:`BotStack` 那套 ECS Fargate 长连接容器已于 2026-09-03(IM 重构 M2)退役,
> 新装机不会创建 VPC / ECS / ECR。要回滚到长连接,得先在 `infra/bin/app.ts` 里把
> `new BotStack(...)` 加回来、`cdk deploy BotStack`,再把 IM 平台控制台的订阅方式改回
> 「长连接 / Socket Mode」。M2 之前装机的账号里 `BotStack` 可能还在(`desiredCount=1`,起着、计费),
> 想省钱可以直接删掉整个栈,或先缩到 0:
>
> ```bash
> aws ecs update-service --cluster <BotStack 的 cluster> \
>   --service <FeishuBotService> --desired-count 0 --region $AWS_REGION
> ```

### 6.2 收到并处理了消息

在群里 @bot 一句话,然后看两个 Lambda 的日志(以飞书为例;Slack / 钉钉把 `feishu` 换成 `slack` / `dingtalk`):

```bash
aws logs tail /aws/lambda/notiops-im-ingress-feishu --region $AWS_REGION --since 5m
aws logs tail /aws/lambda/notiops-im-worker-feishu  --region $AWS_REGION --since 5m
```

| 症状 | 说明 |
|---|---|
| 两个都有日志 | ✅ 正常 |
| ingress 有、worker 没有 | 验签过了但异步投递失败 —— 看 ingress 的报错 |
| ingress 里有 `401 (signature/token)` | 两把钥匙与控制台不一致,回 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §1.2 |
| 两个都没日志 | 平台根本没发出来 —— 飞书 / Slack:订阅方式是不是还停在长连接 / Socket Mode;钉钉:消息接收模式是不是还停在 Stream 模式(默认值,必须改成 HTTP 模式) |

### 6.3 端到端

在群里 @ bot:
```
@NotiOps 帮我列出 IAD 所有 EC2
```

期望:
1. 几秒内出 **🚀 启动调查** 编辑卡片(三个输入框 + 💡 LLM 维度提示)
2. 点 **🚀 派发调查** → 卡片更新成 **✅ 已派发,⏳ 调查启动中**
3. 几秒后 **🔭 调查已开始** 卡片 + 进度更新
4. 1-3 分钟后**一张** **✅ NotiOps 报告** 卡到达原群（顶部是「🎯 调查目标 · <你问的那句>」，
   底下三颗按钮：📊 查看完整报告 / 🔍 调查过程 Trace / 🆘 升级到 AWS Support
   —— 报告卡上**不该有**「🔬 查看本次调查」，那颗只在进度卡上）

再验一条**不是调查**的普通提问(走 DevOps 对话,例:`@NotiOps 帮我列出所有 S3 桶的名称和其大小`):

5. **1-2 秒内**出一张 **🤔 思考中 · 已用时 N 秒** 卡片(这是判据 —— 立刻有卡)
6. 同一张卡上正文、⚙️ 过程逐步刷新,标题秒数一直在涨(前 30 秒约 2 秒一刷,之后变慢,见
   [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §7.2)
7. 跑完(可能几分钟)卡片定版为答案 + 两颗按钮

> ℹ️ **钉钉的验收判据不一样(平台能力差异,不是没做完)**:钉钉改不了已发出的消息、卡片按钮只能是链接,
> 所以**没有** 🚀 启动调查编辑卡、也**没有**「派发调查」按钮 —— 直接说一句就派发;进度也**不是**同一张卡
> 原地刷新,而是**最多追加 2 条**「还在跑」的新消息(硬上限)。钉钉这边的判据是:发完立刻有一条 ack →
> 0-2 条进度 → 最后一条是答案 / 报告。对比表见 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §3.6。

⚠️ 「跑了几分钟才出答案」**不是**故障 —— 判据只有一条:**发完问题有没有立刻出那张思考卡**。
用户可见口径在 [IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §7,别把它当回归报上来。

如果失败 → §10 [Top 5 部署常见错误](#10-top-5-部署常见错误)。

### 6.4 验证语言切换

```
language        # 查看当前语言
language en     # 切到英文
language zh     # 切回中文
请帮我切换到英文  # 自然语切换也支持
```

---

## 7. 开启 / 调整 Push 模式

> ⚠️ **先说清楚:这一版里,AWS 服务事件的实时推送(CloudWatch 告警 / Backup / GuardDuty /
> Cost Anomaly / Trusted Advisor)飞书、Slack、钉钉都收不到,打开规则也不会出卡片。**
> 推送 Lambda `notiops-push-handler` 开不开只看它自己的环境变量(`PUSH_TARGET_PLATFORM` /
> `PUSH_TARGET_CHAT_ID`,钉钉还认 `DINGTALK_PUSH_WEBHOOK_URL`),**不读**飞书 Secret 的
> `notify_chat_ids`,也不读钉钉 Secret 的 `webhook_url`;而两条部署路径都不设这些变量 ——
> 所以即使把 `notiops-push-*` 规则打开,它收到事件也只记一行 `Push disabled` 就返回。
> 这类事件请在 Web Chat 左侧「通知」里看(两条部署路径都有,见 §12.5)。

### 7.1 现在真正会推到 IM 群的(都只有 `setup.sh` 部署才有)

| 推送 | 发到哪 | 目标从哪来 |
|---|---|---|
| **每日运维通知**(`notiops-notifier`,每天 02:00 UTC:资源巡检 + 成本异常 + 过去 24h 的调查) | 只发飞书 | 飞书 Secret `notiops/im-bot-feishu` 的 `notify_chat_ids`,也就是 Web Chat「更多 → 管理 → 集成 IM」飞书分页的「推送群组 Chat ID」;留空 = 不发 |
| **AWS Health 事件**(PHD 转发器 `notiops-phd-forwarder`,默认部署,见 §4.3) | 只发飞书 | 同上;留空 = 不推,也不调 Bedrock |
| **巡检推送**(`notiops-inspection-push`) | 飞书 / 钉钉 / Slack | 要先把群登记成巡检推送目标 —— 本版本**还没有**这一步的途径(没有网页入口、`setup.sh` 不问、发布包里也没有对应的工具),所以这一版实际配不起来;巡检结果在 Web Chat「更多 → 巡检」里看 |

`setup.sh` **不问**推送目标(它只问是否部署 PHD 事件转发)。调查结果回贴发起调查的那个会话,不走
`notify_chat_ids`。钉钉 Secret 里的 `webhook_url`(群里自定义机器人的地址,见 §3.3 第 8 步)只用在两处:
调查报告按会话回贴失败时的兜底,以及上表的巡检推送;每日通知和 Health 事件都不投钉钉。

<!-- ⚠️ 2026-09-06 订正:此前这一节教人改 infra/cdk.json 里的一组 push 开关 key ——
     那些 key 代码里**从来不读**(全仓 grep 只有文档命中),照做静默无效。
     真实机制是下面的 EventBridge 规则开关。tests/test_docs_no_phantom_config.py 盯着别写回来。 -->
<!-- ⚠️ 2026-10-11 再订正:规则开关是真的,但规则后面的 notiops-push-handler 只认环境变量
     PUSH_TARGET_CHAT_ID / PUSH_TARGET_PLATFORM(shared/report_delivery/push_handler.py 的
     _push_configured),而哪个栈都不设 ⇒ 打开规则也不投递。这一节以前把 notify_chat_ids
     写成它的目标群、把钉钉 webhook_url 写成它的推送目标,都不对。 -->

### 7.2 `notiops-push-*` 规则(本版本不投递 IM)

后端栈里有 5 条 EventBridge 规则(`notiops-push-<源>`),**全部默认 DISABLED**。开关就是在 EventBridge 上
enable / disable 那一条,但打开之后只是让 `notiops-push-handler` 被调用,照上面那条说明记一行
`Push disabled` 就返回 —— **不会**往任何 IM 群发卡片:

| 规则名 | 事件源 |
|---|---|
| `notiops-push-cloudwatchalarm` | CloudWatch alarm 状态变更(已排除 NotiOps 自身运维告警) |
| `notiops-push-backupjob` | Backup job 状态变更 |
| `notiops-push-guardduty` | GuardDuty finding |
| `notiops-push-costanomaly` | Cost Anomaly Detection(需先建 monitor;全局服务,只在 us-east-1 发事件) |
| `notiops-push-trustedadvisor` | Trusted Advisor 检查项变更(需 Business+ Support;同上只在 us-east-1) |

> 真正在投递的是 Web 端「通知」收件箱那**另一组**规则(`notiops-web-notif-*`,10 条、默认开 5 条),
> 与上面这 5 条互不影响:方式 B 在 `infra/cdk.json` 的 `context` 里写 `"webNotif<Id>": "on"` 或 `"off"`,
> 再重跑 `./setup.sh`(见 §8.1);方式 A 直接在 EventBridge 控制台开关(见 §12.5)。

### 7.3 完全静默

想让飞书群不再收每日运维通知和 Health 事件:把飞书 Secret 里的 `notify_chat_ids`(即「集成 IM」飞书分页的
「推送群组 Chat ID」)清空即可 —— 两个 Lambda 照常运行,只是不发。只想停 Health 那一条,用
`ENABLE_PHD=false ./setup.sh`(见 §4.3)。`notiops-push-*` 规则本来就不往群里发,不用管。

### 7.4 测试推送

每日运维通知不用等到 02:00 UTC,手动调一次 `notiops-notifier` 即可 —— 事件里不带 `report_date` 时它按当天出报告,与定时触发时一样:

```bash
aws lambda invoke --function-name notiops-notifier --region $AWS_REGION \
  --cli-binary-format raw-in-base64-out --payload '{}' /tmp/notiops-notifier-out.json
cat /tmp/notiops-notifier-out.json
```

- `"status": "completed"` 且 `"notifications_sent"` ≥ 1 → 飞书群里会收到一条「每日运维通知」。
- `"notifications_sent": 0` → `notify_chat_ids` 是空的,或者发送失败(看 `/aws/lambda/notiops-notifier` 日志)。
- `"status": "skipped"`(`"reason": "no_data"`)→ 今天确实没东西可报(巡检没跑、没有未关闭的发现、没有成本异常、
  过去 24h 没有调查),不是故障。

---

## 8. 日常运维

### 8.1 配置变更速查

`setup.sh` 每次都在命令行上 `-c` 传它管的那几个 context(`enabledPlatforms` / `agentRuntimeArn` /
`organizationId` 等);它**不传**的 key(比如下表前两行)要写进 `infra/cdk.json` 的 `context`,以后每次重跑
`./setup.sh` 才会一直带上:

| 改什么 | 怎么改 |
|---|---|
| 改 chat_id 允许清单 | `infra/cdk.json` 的 `context` 里加 `"imAllowedChatIds": "oc_xxx,C0123ABC"`(逗号分隔),然后重跑 `./setup.sh` |
| 开关 Web「通知」收件箱的单个事件源 | 同上,加 `"webNotif<Id>": "on"` 或 `"off"`(见 §12.5)。IM 的 `notiops-push-*` 规则不是 context,而且本版本不投递(见 §7) |
| 增删 IM 平台 | 重跑 `./setup.sh`,在 IM 平台那一问里重新选(它传的 `-c enabledPlatforms=…` 会盖过 `cdk.json` 里的同名值;`none` = 整个 IM 侧不部署) |

> ⚠️ **别只部一个栈**:`npx cdk deploy ImStack` 不带 `--exclusively` 时会先把它依赖的 `NotiOpsBackendStack`
> 也部一遍,而两个栈都只拿到你这一次给的 `-c` —— `setup.sh` 平时传的那些一个都没有,于是按默认值合成
> (`enabledPlatforms` 回到 `feishu`、`agentRuntimeArn` 变空、多账号部署的跨账号闸门被重新锁上)。
> 这与 §5.4 是同一个坑。真要手工单部,带上 `--exclusively` 并把 `setup.sh` 那一行的 `-c` 全部照抄。

> ⚠️ **不再走 context 的项**(M2 / 2026-09-03 起):chitchat 模式、MCP 模式、默认语言、默认 LLM。
> 原来那几个 key(`agenticChatMode` / `awsMcpMode` / `defaultLocale` / `defaultLlmProvider`)只喂过
> `BotStack` 的 Fargate 容器,栈退役后**传了也不生效**(静默无效)。现在:
> 模式类在 `infra/lib/constructs/im-core.ts` 里写死;**默认语言**在群里 `@bot 中文` / `@bot english`
> 按会话切(`core/locale_resolver.py`);**默认 LLM** 由 admin 在 Web 控制台的模型目录里设
> `default_model`,用户可 `@bot model <alias>` 单会话覆盖(`core/llm_pref_resolver.py`)。
> 完整口径见 §11.1。

### 8.2 部署新代码

```bash
git pull
./setup.sh            # cdk deploy --all（不再有镜像 build）
```

`setup.sh` 在重跑时会跳过已经存在 + 不变的资源,只更新差异部分。

### 8.3 强制换一批 Lambda 实例(不改任何配置)

IM 走 Lambda,**没有"重启 task"这回事** —— 改完 Secret 等下一次冷启动就生效。想立刻换掉所有
活着的实例(比如刚改了凭据要马上验),改一次环境变量即可(改任意值都会让 Lambda 换新实例):

```bash
aws lambda update-function-configuration --region $AWS_REGION \
  --function-name notiops-im-worker-feishu \
  --environment "Variables={FORCE_ROLL=$(date +%s)}"
```

⚠️ 这条命令会**覆盖**整个环境变量表 —— 先 `get-function-configuration` 读出现有的 `Variables`
再整份带上,别只传一个 key。别拿 `cdk deploy ImStack` 代替它:模板没变时它什么都不部署、换不了实例,
而且只带你这一次给的 `-c`(见 §8.1 末尾那条警告)。
(老装机上还有 ECS 时的做法是 `aws ecs update-service --force-new-deployment`。)

### 8.4 看日志

```bash
# 实时跟踪
aws logs tail <log-group> --since 5m --follow

# 定向搜索常用关键字
aws logs tail <log-group> --since 1h --filter-pattern "intent_classify"   # 意图分类
aws logs tail <log-group> --since 1h --filter-pattern "change-request"    # 变更请求拦截
aws logs tail <log-group> --since 1h --filter-pattern "progress tick"     # 进度轮询
aws logs tail <log-group> --since 1h --filter-pattern "locale="           # 语言解析
```

### 8.5 DDB 状态查询

`./setup.sh` 部署的 DDB 表名以 CDK outputs 为准(详见 §6 顶部 `cdk-outputs.json`)。下面假设你已查到真名为 `<conv-table>`:

```bash
# 查 event 状态
aws dynamodb get-item --table-name <conv-table> \
  --key '{"lookup_key":{"S":"event#<event_id>"}}'

# 清掉 stale DM lock(用户切语言"看似不生效"时)
aws dynamodb delete-item --table-name <conv-table> \
  --key '{"lookup_key":{"S":"locale#dm#feishu:<user_id>"}}'
```

### 8.6 定时任务的总开关

「更多 → 定时任务」由 WebChatStack 里一条每 5 分钟一次的 EventBridge 规则 `notiops-routines-tick` 触发 BFF 派发（使用说明见 [USER_GUIDE.md](USER_GUIDE.md) §5.8）。深度调查按秒计费，出事时可以一条命令停掉所有派发（进行中的照样收结果），不用重新部署：

```bash
aws dynamodb put-item --region <区域> --table-name notiops-config \
  --item '{"PK":{"S":"appconfig#routines"},"SK":{"S":"enabled"},"config_value":{"S":"0"}}'
```

恢复：把 `config_value` 改成 `"1"`，或者删掉这一行。定时任务的报告在数据桶的 `routine-reports/` 前缀，保留 30 天（报告 CDN 放行这个前缀）。规则和报告前缀都由栈管理，`teardown.sh` 不需要额外处理。

### 8.7 忘记密码与管理员救急

2026-10-30 起(使用说明见 [USER_GUIDE.md](USER_GUIDE.md) §1.7):

- **用户自己**:登录页 **Forgot password?**,验证码发到账号上**已验证**的邮箱(1 小时有效)。没有邮箱的人由管理员在 **管理 → 用户** 点 **重置密码**(一次性临时密码,7 天有效,同时退出他所有设备上的登录;两步验证不变)。
- **新建用户邮箱必填**(「管理 → 用户」)。`setup.sh` 第一次部署时会问 admin 的邮箱(非交互运行用 `ADMIN_EMAIL=you@example.com ./setup.sh`);老部署的 admin 多半没有邮箱,升级时带上 `ADMIN_EMAIL=...` 就替它补上(不动密码和两步验证),或者登录后在左下角菜单 **账户与密码** 自己绑。
- 发信用 Cognito 默认发件人(`no-reply@verificationemail.com`):**每个 AWS 账号每天最多 50 封**,09:00 UTC(北京时间 17:00)重置,不可调。超了当天的验证码发不出去,管理员重置不受影响。
- 用户池只改了三项原地更新的属性(找回只走已验证邮箱、验证邮件文案、换邮箱验证前保留旧邮箱),升级**不替换**用户池、不丢用户。⚠️ 如果在 Cognito 控制台手工改过 `notiops-users` 用户池(比如自己接了 SES、加了 Lambda 触发器),CloudFormation 更新用户池时模板里没有的设置会回到默认值 —— 升级前先记下来。
- **唯一的管理员也忘了密码**:有这个账号权限的人(本机或 CloudShell)跑下面几条。登录后会要求马上设新密码;`read -s` 是为了不让临时密码留在 shell 历史里。手机也丢了,再加一条 `admin-delete-software-token`(见 [DEPLOYMENT_ONECLICK.md §8](DEPLOYMENT_ONECLICK.md#8-安全说明值得知道的几条) 第 7 条)。

```bash
REGION=<区域>
POOL=$(aws cognito-idp list-user-pools --region "$REGION" --max-results 60 \
  --query "UserPools[?Name=='notiops-users'].Id | [0]" --output text)
read -rs -p "临时密码（至少 8 位，含大小写字母和数字）: " PW; echo
aws cognito-idp admin-set-user-password --region "$REGION" --user-pool-id "$POOL" \
  --username admin --password "$PW" --no-permanent
unset PW
aws cognito-idp admin-user-global-sign-out --region "$REGION" --user-pool-id "$POOL" --username admin
```

---

## 9. 回滚策略

| 级别 | 操作 | 影响 |
|---|---|---|
| **L1 关闭单个事件源** | `aws events disable-rule --name notiops-web-notif-<源>`(Web「通知」收件箱,见 §12.5);IM 侧的 `notiops-push-<源>` 本版本本来就不投递(见 §7) | 单个事件源,瞬时,无需部署 |
| ~~**L2 关闭整个对话档位**~~ | **已经没有这个开关**:`agenticChatMode` 自 M2(2026-09-03)起不再被读取(`AGENTIC_CHAT_MODE=enabled` 写死在 `infra/lib/constructs/im-core.ts`),传了也不生效,见 §11.1。要停掉 IM 就用 L4 | — |
| **L3 IM 从 webhook 退回长连接** | ⚠️ **2026-09-03(M2)之后这条不再是"分钟级"** —— `BotStack` 已不再由 `infra/bin/app.ts` 实例化,得先把 `new BotStack(...)` 加回去、装好 finch/docker、`cdk deploy BotStack`(要建 VPC/ECS/ECR + build 镜像),再把飞书 / Slack 控制台的订阅方式改回长连接 / Socket Mode。老装机(栈还在)仍是分钟级:改订阅方式 + `aws ecs update-service --desired-count 1 ...` | 单平台;新装机 ~20 分钟,老装机分钟级([IM_WEBHOOK_SETUP.md](IM_WEBHOOK_SETUP.md) §1.6)|
| **L4 关闭整个 bot** | webhook 模式:`aws lambda put-function-concurrency --reserved-concurrent-executions 0`(ingress 立刻全部 429);长连接模式:`aws ecs update-service --desired-count 0 ...` | 单平台,瞬时 |
| **L5 删栈** | `cd infra && npx cdk destroy <stack-name>` | 整个 stack |

> ⚠️ 删栈会清掉 Lambda / API Gateway / IAM 相关资源(老装机上还有 ECR / SG / ECS)。**四张 DDB 表不会被自动删**(`notiops-config` / `notiops-conversations` / `notiops-web-chat` / `notiops-inspection`,`removalPolicy: RETAIN`),需要手动清理;**数据桶 `notiops-data-<账号>-<区域>` 则相反,删主栈时连同里面的对象一起删掉**(Skills 和长报告都在里面,要留就先导出)。本项目所有 AWS 资源默认带 `auto-delete=no` 标签,避免被自动清理任务误删。
>
> 要**删掉整个环境**(而不是回滚单个栈),别逐个 `cdk destroy` —— 用仓库根目录的
> `./teardown.sh`:它按依赖倒序删栈,并收掉 CDK 之外的尾巴(一次性 EventBridge schedule、
> WebSearch Gateway、secret 的 30 天恢复期)。先 `./teardown.sh --dry-run` 看清单;默认保留
> 四张 RETAIN 表,`--delete-everything` 连这四张表和残留日志组一起删;数据桶两种模式下都会随主栈删掉,所以它默认先把数据桶备份到本地(默认 `~/notiops-teardown-backup-<时间戳>/`,在仓库目录之外,`--backup-dir` 可改;`--no-backup` 跳过)。CUR 相关的(报告定义
> `notiops-cur-report`、交付桶、Athena 集成栈、保存查询)**两种模式下都保留** —— 那是账单历史,
> AWS 不补发;重装时 `setup.sh` 认出留下的 `notiops-cur-report`、不问也不重建,几分钟内接上
> 原来的 Athena 表(见 §13.2)。

---

## 10. Top 5 部署常见错误

| 现象 | 可能原因 | 排查 / 修 |
|---|---|---|
| **Secrets Manager 报 access denied** —— CDK deploy 建空 Secret 时,或事后用 CLI 填 IM 凭据时 | 两种情况被拒的不是同一个身份:CDK deploy 时建 Secret 的是 bootstrap 角色 `cdk-hnb659fds-cfn-exec-role`(见 §2.4 ②),不是你;用 CLI 填凭据时才是你自己的身份缺权限(网页「集成 IM」由 BFF 自己的角色写,不受这一条影响) | CDK deploy 那种:查那个角色的执行策略是不是被换成了更窄的(`setup.sh` 自己 bootstrap 时是 AdministratorAccess,见 §2.4 ①),以及有没有 SCP / 权限边界拦着 Secrets Manager。CLI 那种:给你用的那个 IAM 用户 / 角色 / Identity Center 权限集加一条只限 `arn:aws:secretsmanager:<region>:<账号>:secret:notiops/*` 的 `secretsmanager:DescribeSecret` / `GetSecretValue` / `PutSecretValue`(`setup.sh` 自己还会调 `DescribeSecret` / `DeleteSecret`,见 §2.4 ③)。别为此挂整个 `SecretsManagerReadWrite` |
| **`ImStack` synth 就报错说 Layer 里缺包** | `scripts/build_im_layer.sh` 没跑 / 跑失败 | 重跑 `bash scripts/build_im_layer.sh`(用 `pip --platform manylinux2014_x86_64 --only-binary=:all:` 交叉下载,**不需要容器**)|
| **bot 不响应 @ — worker 日志显示 `auth failed`** | IM 凭据错 / Secret 内容错 | `aws secretsmanager get-secret-value --secret-id <name>` 比对凭据原值,改对了等下一次冷启动(不需要重部)|
| **bot 派发成功但报告不回群** | report-handler Lambda 没拿到 IM 凭据 | 检查 Lambda 环境变量里的 Secret ARN 与 `ImStack` 是否一致;重跑 `./setup.sh`(别单独 `cdk deploy NotiOpsBackendStack`,见 §8.1 末尾那条警告) |
| **`Bedrock InvokeModel` AccessDeniedException** | 部署 region 里这个模型还没开通 / (Claude Sonnet 5.5 / Opus 5.5、GPT-6 Sol)这个账号还没接受它的 AWS Marketplace 协议 / 执行角色缺权限 | Bedrock 控制台 → Model access;Marketplace 协议与不接受时的替代做法见 §2.2;IAM 动作名是 `bedrock:InvokeModel`(不是 `bedrock-runtime:`) |

---

## 11. 完整 CDK Context 参考

下面是各栈**实际读**的 context key。`setup.sh` 自己会在命令行上传其中一部分;它不传的,写进 `infra/cdk.json` 的 `context` 块再重跑 `./setup.sh`(做法与单栈部署的坑见 §8.1)。

### 11.1 ImStack(IM 平台栈)

`ImStack` 实际读的 context **只有四个**(`infra/lib/im-stack.ts`):

| context key | 默认 | 说明 |
|---|---|---|
| `enabledPlatforms` | `feishu` | 启用的 IM 平台(逗号分隔,如 `feishu,slack`)。`none` = 整个 `ImStack` 不实例化(`infra/bin/app.ts`),未列出的平台不创建任何 Lambda / webhook |
| `imAllowedChatIds` | (空) | chat_id 允许清单(逗号分隔;空 = 不限制)。注入 worker 的 `ALLOWED_CHAT_IDS` |
| `organizationId` | (空) | 非空 = 多账号(Organizations)模式,与 `NotiOpsBackendStack` 同口径 |
| `agentRuntimeArn` | (空) | Web Chat 那个 AgentCore Runtime 的 ARN(与 `WebChatStack` 读的是同一个 `-c`)。IM 里 `/agent notiops` 走它;空 = `/agent notiops` 当场被明确拒绝(`agent.not_configured`),不会悄悄退回 DevOps 直连。`setup.sh` 部署完 agent 后自动传 |

> ⚠️ **M2(2026-09-03)之后这些 key 已失效**,别照着老文档传:
> `bedrockModelId` / `bedrockRegion` / `agenticChatMode` / `defaultLlmProvider` / `gptRegion` /
> `awsMcpMode` / `enableMcpPricing` / `defaultLocale` / `allowedChatIds`。
> 它们只喂过 `BotStack` 的 Fargate 容器 environment,而那个栈已退役。现在 IM 侧对应的值是
> **在 `infra/lib/constructs/im-core.ts` 里写死的**(`AGENTIC_CHAT_MODE=enabled`、
> `AWS_MCP_MODE=docs_only`、`AWS_MCP_PRICING_ENABLED=false` / `AWS_MCP_COST_ENABLED=false`
> —— Lambda 里没有 sidecar 可连)。**模型**由运行期决定:群 / DM 的 `@bot model <alias>` →
> DDB 模型目录的 `default_model`(`core/llm_pref_resolver.py`,见
> [USER_GUIDE.md §15](USER_GUIDE.md#15-模型与对话对象));**语言**由 `core/locale_resolver.py`
> 的 user / DM / thread / incident 记录决定,没有记录时兜底 `en`(`DEFAULT_LOCALE` 没被注入)。
> 传这些 `-c` 不会报错、也不会生效 —— 这是**静默无效**,所以特意在这里列清。

### 11.2 NotiOpsBackendStack(共享后端 + push)

`NotiOpsBackendStack` 读的 context 就是 §4.3 那张表里属于它的那几个 —— `organizationId` /
`inspectionReportLocale` / `monthlyLimitSeconds` / `opsAlertEmail` / `webBaseUrl` / `skipPhd` /
`phdLinkedAccounts` / `oamSinkArn` / `operatorAppAlreadyEnabled` / `mfaMode` —— 外加 §12.5 的 `webNotif<Id>`。

> ⚠️ 这里以前列的 `agentSpaceId` / `devOpsAgentRegion` / `reportUrlExpirationSeconds` 三个 key,代码里
> **一个都不读**,传了也不生效:两个 Agent Space 由栈自己新建(见 §5.3.5),DevOps Agent 用的就是部署
> region(见 §2.3)。

> IM push 的目标与事件源开关**不是** CDK context,而且 `notiops-push-*` 这一路本版本不投递 IM;
> 真正会推到 IM 的那几样、以及它们的目标从哪来,见 §7.1。

> 数据桶自动创建:`notiops-data-<账号>-<区域>`(私有、SSE-S3 加密、只接受 TLS,无需配置),Skills、报告等按
> 前缀分区。它**不是** RETAIN 的,删主栈时随栈删掉(见 §9)。

---

## 12. Web Chat 部署

> **Web Chat** 是 NotiOps 的浏览器端 agentic AI 助手,与上文的 IM bot **相互独立**:你可以只部署 IM bot、只部署 Web Chat,或两者都部署。Web Chat 复用 notiops 的 Cognito user pool 做鉴权,并复用共享后端(config 表、`core/push_event` 归一化、DevOps Agent)。

### 12.1 Web Chat 架构

| 组件 | 说明 |
|---|---|
| **Agent Runtime** | Bedrock AgentCore Runtime,承载 Strands agent(默认模型 **Kimi K3**(`global.moonshotai.kimi-k3`),取自模型目录的 `default_model`)。由 `scripts/deploy_agent.sh` 以 CodeZip 方式部署,产出一个 **Runtime ARN** |
| **BFF Lambda** | Node.js 24 Lambda(`notiops-web-chat-bff`),挂 **Function URL**(`AuthType=AWS_IAM`),以 **SSE 流式**响应前端;调 Agent Runtime,并直接处理确定性操作(建案 `/actions/execute`、`/support/services` 目录等) |
| **前端** | React / Vite 单页应用,静态托管 |
| **鉴权** | Cognito(复用 notiops 的 user pool)+ Identity Pool,前端拿临时凭据对 Function URL 做 **SigV4** 签名 |
| **数据** | CDK `WebChatStack` 建 DDB 单表 `notiops-web-chat`(会话/消息 + 持久化通知收件箱 `notif#` 段,90 天 TTL,账号级共享) |

数据面对你的基础设施**严格只读**:硬边界是 IAM 权限 —— 访问你账号用的角色对基础设施只读,改资源的写操作拿不到权限;NotiOps 自身资源之外,唯一的写权限是 AWS Support 工单的建 / 回 / 关(只在你确认预览后执行;成员账号的角色可用模板参数 `EnableSupportCaseWrite=false` 收成严格只读)。之上是工具层只读(`READ_OPERATIONS_ONLY` + 精选只读 MCP 允许清单)+ 命令级 denylist + 只读 system prompt(纵深防线的完整构成见 [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md) §5.3)。Web Chat 不放宽这些限制。

### 12.2 部署顺序

Web Chat 分两步,每次跑 `./setup.sh` 都由它按顺序做完:

```
scripts/deploy_agent.sh    # 1) agentcore deploy CodeZip → 打印 Agent Runtime ARN
        │
        ▼  (setup.sh 把 ARN 作为 -c agentRuntimeArn=<ARN> 交给 CDK)
setup.sh 的 cdk deploy --all    # 2) 与它管的其余 -c 同一条命令,建 / 更新 WebChatStack
```

1. **`scripts/deploy_agent.sh`** —— 用 `agentcore deploy` 把 agent 打成 **CodeZip** 上传,创建 / 更新 AgentCore Runtime,输出 **Runtime ARN**。
2. **CDK `WebChatStack`** —— 用 `-c agentRuntimeArn=<ARN>` 注入上一步的 ARN,建 BFF Lambda + Function URL + DDB 表 + 通知 handler。
3. **前端 `config.json`** —— 部署后把 BFF Function URL 等写进前端(见 §12.4)。

> ⚠️ 想手工做第 2 步,别只带 `-c agentRuntimeArn` 这一个:不加 `--exclusively` 时 CDK 会先按默认值把主栈也部一遍,
> 加了也会丢掉 `setup.sh` 平时传的其余 context(多账号的 `organizationId`、成本 MCP 那几个等,见 §8.1 末尾那条警告)。
> 要么直接重跑 `./setup.sh`,要么带上 `--exclusively` 并把 `setup.sh` 那一行的 `-c` 全部照抄 —— agent 没部成功时,
> `setup.sh` 结尾会把这条完整命令打出来(见 §12.7 第一行)。

### 12.3 关键环境变量(BFF Lambda / handler)

| env | 说明 |
|---|---|
| `WEB_CHAT_TABLE` | DDB 单表名(`notiops-web-chat`),会话 / 消息 / 通知收件箱共用 |
| `AGENT_RUNTIME_ARN` | `deploy_agent.sh` 产出的 AgentCore Runtime ARN(经 `-c agentRuntimeArn` 注入) |
| `SKILLS_BUCKET` | Skills 存储 S3 bucket(`skills/` 前缀,与 IM 端共享) |
| `DEVOPS_AGENT_SPACE_ID` | DevOps Agent Space id(深度调查用) |
| `REPORTS_CDN_DOMAIN` | 在线报告 CloudFront 域名(HTML 报告落 S3,CloudFront 7 天;presigned URL 12h 兜底) |
| `CONFIG_TABLE` | notiops 的 config 表(`notiops-config`),复用其配置 / 通知源开关 |
| `NOTIOPS_CROSS_ACCOUNT_ROLE` | 跨账号采集角色名(只读,默认另带 Support 工单的开 / 回复 / 关闭权限,`EnableSupportCaseWrite=false` 可关;见 §0.1.1) |
| `LOCKED_ACCOUNT_ID` | v1 锁定的部署账号 id(多账号选择器默认此账号) |

### 12.4 前端 config.json 注入项

前端构建产物需要一个 `config.json`(部署时注入,不硬编码):

| key | 来源 |
|---|---|
| `chatApiBase` | BFF Function URL(`WebChatStack` output) |
| `cognito` | 复用 notiops 的 user pool id / app client id / region |
| `identityPoolId` | Identity Pool id(签发临时凭据供 SigV4) |

### 12.5 通知事件源(持久化收件箱)

Web Chat「通知」主题的**持久化收件箱**由 EventBridge → `notiops-web-notif-handler`(复用 `core/push_event` 归一化,去重:同一事件 5 分钟内只记一次,Trusted Advisor 24 小时)→ 写 `notiops-web-chat` 表 `notif#` 段。事件源开关:

> 📌 **这一整套两条部署路径都有,清单同源。** 事件源定义(10 类、默认开关、规则名、规则描述、Lambda 环境变量)在
> [`infra/lib/constructs/web-notif-sources.ts`](../infra/lib/constructs/web-notif-sources.ts),`setup.sh` 的
> `notiops-backend-stack.ts` 与一键部署的 `notiops-webchat-standalone-stack.ts` **import 同一份**
> (`scripts/test_oneclick_parity.py` 的第 ⑤ 项钉住"没有人把清单抄回某个栈里")。
> **唯一的差别是怎么关掉某一源**:本节的 `webNotif<Id>` 是 CDK context(写进 `infra/cdk.json` 的 `context`,
> 见 §8.1),只对 `setup.sh` 有效;一键部署没有 CDK context,改成在 **EventBridge 控制台**上 Disable 那条
> `notiops-web-notif-*` 规则 —— 模板不管规则的启用状态,所以这个手动改动不会被版本升级覆盖回去。
> 一键部署侧的对客说明见 [DEPLOYMENT_ONECLICK.md §2.9](DEPLOYMENT_ONECLICK.md#29-通知收件箱)。

- **默认开**(5 个,运维价值最高、噪音可控):AWS Health / CloudWatch Alarm / Cost Anomaly / Trusted Advisor / GuardDuty
- **默认关**(5 个,按需打开:`infra/cdk.json` 的 `context` 里加 `"webNotif<Id>": "on"`,再重跑 `./setup.sh`,见 §8.1):Backup / EC2 Spot / Auto Scaling / RDS / Config(`<Id>` 依次是 `BackupJob` / `Ec2Spot` / `AutoScalingFail` / `Rds` / `Config`)
  - 关的原因:要么量大易刷屏(Backup 每次作业、Spot、RDS),要么需先开通付费服务且合规类噪音大(Config)

> ⚠️ **默认开的 5 个里有 3 个还依赖客户侧前置条件** —— 规则是开的,但缺前置条件时收不到事件,前端空态会明确说明原因,不会让人误判成 NotiOps 坏了:
>
> | 源 | 前置条件 |
> |---|---|
> | GuardDuty | 账号需已**启用 GuardDuty**(付费)。未启用时没有 detector、不产生任何 finding;规则开着零成本,一旦启用立即生效,无需重新部署 |
> | Cost Anomaly | 需先在 Cost Explorer 建**成本异常监控器**(免费);且只在 `us-east-1` 发事件 |
> | Trusted Advisor | 需 **Business+ / Enterprise / Unified Operations** 支持计划;且只在 `us-east-1` 发事件 |

> ⚠️ **Cost Anomaly 与 Trusted Advisor 是全局服务,只在 `us-east-1` 发 EventBridge 事件**
> (TA 见[官方文档](https://docs.aws.amazon.com/awssupport/latest/user/cloudwatch-events-ta.html);Cost Anomaly 事件在其 home region,通常 `us-east-1`)。
> 若把 NotiOps 部署在别的 region,这两条规则建了也**永不触发** —— `cdk synth/deploy` 会打出明确警告。
> 想收到这两类通知:把 NotiOps 部署在 `us-east-1`,或在 `us-east-1` 建一条跨 region 转发规则把事件送到部署 region。
> 不需要就在 `infra/cdk.json` 的 `context` 里加 `"webNotifCostAnomaly": "off"` 和 `"webNotifTrustedAdvisor": "off"`,
> 再重跑 `./setup.sh`,警告随之消失。

> 通知近实时,靠前端 **60s 轮询**(非 WebSocket,最长约 60s 延迟);左侧红点只统计**收件箱未读**。「通知」主题另有一块 **AWS Health Dashboard 实时视图**,由 BFF 实时查 Health API(不落库),需 **Business+ / Enterprise Support** 计划;无该计划时优雅降级为控制台链接,且 Health 未处理数**不叠进**红点。

### 12.6 冒烟测试

> **登录凭据从哪来**:首次部署时 `setup.sh` 会创建一个 Cognito `admin` 用户并打印**临时密码**(部署完成横幅里 `👤 登录: admin / <临时密码>`),这是进入 Web 控制台的入口账号。首次登录需改密码。若横幅没显示密码,说明 admin 用户已存在(密码未变更)。

```
1. 浏览器打开 Web Chat 前端 URL → 用 admin / 临时密码 Cognito 登录(首次改密码)
2. 左侧导航能看到:通知 / 调查 / 成本 / 案例 / **更多**
   (点开「更多」是 巡检 / 技能 / 管理;当前页在其中时它会自动展开)
   (**也没有「安全」** —— 安全已并入「调查」,看板只从胶囊进)
   (调查 / 成本 / 案例三个主题的输入框**上方**各有一行胶囊,**与聊天框左对齐**、
    行首**没有**「仪表盘」标签:调查 = ⟨运行概览⟩ ⟨安全态势⟩,
    成本 = ⟨支出与优化⟩,案例 = ⟨案例进展⟩,点进去是原来的看板树,左上有返回)
3. 发一句调查请求(如"帮我调查 IAD 的 EC2"):
   → 回复正文上方出现「查看思考过程 · N 步」入口(一条回复只有一个),右侧「思考过程」
     停靠面板在第一步到达时自动弹开并实时增长(手动关过一次面板后不再自动弹,点入口打开)
   → 结束后主聊天给 root cause 结论 + HTML 在线报告链接
4. 建案:进「案例」主题,用可编辑卡片选服务 / 类别 / 案例类型 → 预览 → 确认
   (执行走确定性 /actions/execute,不经 LLM)
```

> **输入框下方的 DevOps Agent 开关**:「调查」主题有「DevOps 对话」和「深度调查」两枚,「成本」主题只有「深度调查」一枚(通用 / 案例 / What's New 一枚都没有),**全部默认关**,点亮才生效。界面上**没有**「FinOps Agent」开关(原来那个置灰的「即将上线」占位已于 2026-09-13 删掉),冒烟测试时不用找它。开关置灰并带「未接入」角标 = 部署账号里没有 Agent Space,或所选账号还没接入 DevOps Agent(tooltip 写明是哪一种)。细节见 [USER_GUIDE.md §4.3](USER_GUIDE.md#43-谁来答答到多深)。

### 12.7 常见坑

| 现象 | 原因 / 修 |
|---|---|
| **提问只得到「收到 —— 你说的是：…」/ `(Echo — AGENT_RUNTIME_ARN not set …)`** | **agent 根本没上线**,BFF 走 echo 回退。链条:`deploy_agent.sh` 失败 → 没有 Runtime ARN → `WebChatStack` 的 `AGENT_RUNTIME_ARN` 是空串 → [bff/web-chat/index.mjs](../bff/web-chat/index.mjs) 回显。**一条命令修完:`bash scripts/fix_web_chat_echo.sh --region <region>`**(只读体检 → 打印结论 → 确认后修:补 uv / 钉 CLI 版本 / 还原 CDK harness / 重新部署 agent / 注入 BFF,并自动沿用现网的 `organizationId`、CORS 允许清单)。⚠️ 成本 MCP server 由 NotiOps 自建的部署(§14.2)上它**拒绝运行** —— 它按「你自带的 server」那样重部,会把自建的那个 server 删掉;分不清是不是自建的时候也拒绝。那种部署改用 `COST_MCP_SELF_HOST=true ./setup.sh`。想手工做:**第一嫌疑是缺 `uv`**(见 §2.1)→ 装 uv → 重跑 `./setup.sh`(它会重新部署 agent,并把 ARN 连同其余 `-c` 一起注入;成本 MCP 自建的部署用 `COST_MCP_SELF_HOST=true ./setup.sh`)。不想整套重跑:`DEPLOY_REGION=<region> bash scripts/deploy_agent.sh`,再把它打印的 ARN 填进上一次 `setup.sh` 结尾打印的那条完整 `cdk deploy WebChatStack --exclusively …` 命令(它带着那次部署的全套 `-c`,含多账号与成本 MCP 那几个)。别自己拼一条只带 `-c agentRuntimeArn` 的:漏掉的 context 会按默认值合成 —— 多账号部署变 `org_mode_disabled`、FinOps 那 4 张 CUR 报表消失、自建的成本 MCP server 被删。核验:`aws lambda get-function-configuration --function-name <web-chat-bff> --query 'Environment.Variables.AGENT_RUNTIME_ARN'` 必须非空 |
| **同上,但机器上有 `uv`** | 第二嫌疑是 **agentcore CLI 版本漂了**。`@aws/agentcore` 约每周发一版,而 `agentcore deploy` 的 "Sync CDK dependencies" 步骤会**擅自改写仓库里已入库的** `agent-build/NotiOpsWebChat/agentcore/cdk/package.json`(把 `@aws/agentcore-cdk` 顶到新版),与入库的 `lib/cdk-stack.ts` 不兼容 → `tsc` 报错 → deploy 十几秒即挂,且**重跑不会自愈**。真正的报错只在 CLI 自己的日志里:`tail -80 "$(ls -t agent-build/NotiOpsWebChat/agentcore/.cli/logs/deploy/*.log \| head -1)"`。修:`npm install -g @aws/agentcore@0.24.2` + `git checkout -- agent-build/NotiOpsWebChat/agentcore/cdk/package.json agent-build/NotiOpsWebChat/agentcore/cdk/package-lock.json` + `rm -rf agent-build/NotiOpsWebChat/agentcore/cdk/node_modules`,再重跑 `deploy_agent.sh` —— 这一整串就是 `bash scripts/fix_web_chat_echo.sh` 干的事。(`deploy_agent.sh` 自 v1.0.15 起会在部署前直接拦住这两种状态) |
| **`deploy_agent.sh` 上传 CodeZip 超时** | agent CodeZip **别把 `.venv` 打进去**(依赖装到几百 MB,S3 上传会超时)。CodeZip 只放源码 + 依赖清单,让 AgentCore 侧装依赖 |
| **两个 stack 并行 synth 冲突 / 产物错乱** | **不要**让 IM bot 栈和 `WebChatStack` **并行 synth 到同一个 `cdk.out/` 目录**;分开跑或用不同 `--output` 目录 |
| **前端 403 / 签名失败** | Function URL 是 `AWS_IAM`;确认前端拿到了 Identity Pool 临时凭据并对请求做了 SigV4 签名,`config.json` 的 `chatApiBase` 指向正确的 Function URL |
| **深度调查跳转后停在错误 tab** | 「去 DevOps Agent 后台生成缓解方案」按钮跳 operator app deep link(新标签);后台无法深链直达 Root cause tab,故文案会提示用户打开后手动切到 Root cause tab |

---

## 13. CUR + Athena FinOps 数据源

> **可选功能**。FinOps 仪表盘的部分卡片(如 DevOps Agent 调用成本——`product_product_name='AWSDevOpsAgent'`)需要 **CUR 明细数据**,Cost Explorer 的聚合 API 查不到这个维度,必须走 **Athena 查询 CUR 表**。本节由 `setup.sh` 在主部署完成后自动引导。

### 13.1 两条路径：复用既有 CUR（即时）vs 新建 CUR（~24h）

> **复用既有 CUR**：若账号已有符合条件的 CUR（数据已交付），setup.sh **同步调用 `lambda6_cur_finalizer`**，动态发现/建好 Athena 表后**几分钟内 `READY`**，无需等 24h。**只有新建 CUR** 才有下面的 ~24h 首次交付延迟。
>
> **动态发现，零 hardcode**：finalizer 用 Glue API 按报告的 S3 路径匹配真实库/表（不再用 `report_name.lower()` 猜库名——实测 AWS 建的库是 `athenacurcfn_<脱敏名>`，猜不准），并据分区键判断结构（结构 B：`year`/`month` 分区，值可能是单位数 `month=7`）。任意客户的既有/新建 CUR 通用。

新建 CUR 时，AWS 官方两阶段流程(见 [官方文档](https://docs.aws.amazon.com/cur/latest/userguide/cur-query-athena.html))是:

```
setup.sh 阶段一(几秒钟)
  │
  ├─ 检测账号是否已有符合条件的 CUR(Hourly + Include Resource IDs + Athena 集成)
  │     └─ 有 → 询问复用还是新建；无 → 直接新建（有两种情况不问，见 §13.2）
  │
  ├─ 新建：cur:PutReportDefinition
  │     · TimeUnit=HOURLY(你要的 hourly 粒度)
  │     · AdditionalSchemaElements=[RESOURCES](include resource ID)
  │     · Format/Compression=Parquet, AdditionalArtifacts=[ATHENA]
  │     · 新建专用 S3 桶 notiops-cur-<account_id>-<region>(AWS 强烈建议不复用已有桶)
  │
  ├─ 写 DDB 状态记录：notiops-config 表,PK=cur-athena-status#<account_id>,status=PENDING
  │
  └─ 调度一次性 EventBridge Scheduler(T+25h)→ lambda6_cur_finalizer
  │
  ⏳ 等待 24 小时 —— AWS 首次交付报告到 S3(硬性延迟,无法绕过)
  │
  ▼
lambda6_cur_finalizer（新建：T+25h 自动触发；复用：被 setup.sh 同步调用）
  │
  ├─ 幂等：先用 Glue API【按 S3 Location 动态发现】是否已有 CUR 表 → 有则直接写 READY，跳过 CFN
  ├─ 失败/回滚态旧栈 → 先删除再重建（保证可重复部署，含 StopCrawler 清理正在运行的 crawler）
  ├─ 部署 AWS crawler-cfn.yml（Glue Database + Crawler + 2 Lambda + S3 通知）→ 跑 crawler
  │     └─ crawler-cfn.yml 尚未交付（仅新建、偶发）→ 状态置 DELAYED，重跑 setup.sh 收尾
  └─ 用 Glue API【动态发现真实 db/table】(不猜库名) → 写 DDB READY
        + athena_database + athena_table + year_month_partitioned
```

**FinOps 仪表盘行为**：`not_configured` 显示"未配置，重跑 setup.sh"；`PENDING`/`DELAYED`（仅新建 CUR 等首次交付时）显示"初始化中"；`READY` 后展示真实 Athena 结果（复用既有 CUR 通常几分钟内 `READY`）；`FAILED` 显示配置失败。

### 13.2 setup.sh 交互流程

主部署(`npx cdk deploy --all`)完成后,`setup.sh` 会:

1. 查 DDB `notiops-config` 表是否已有该账号的 CUR/Athena 状态记录 —— 有则跳过(避免重复创建)
2. 无记录 → 先认两种**不问**的情况,都不是才检测、询问:
   - 账号里还有 NotiOps 自己的 `notiops-cur-report`(删除 NotiOps 时刻意保留,比如 `./teardown.sh --delete-everything` 之后重装)→ **直接复用它**,走下面第 3 步,通常几分钟内 `READY`
   - 这次是 `COST_MCP_SELF_HOST=true` 且没给 `CUR_TABLE` / `CUR_BUCKET_NAME`(§14.2)→ 自建成本 MCP 已按 NotiOps 新建的那份 CUR 授权,**直接新建**
   - 都不是 → 用 `cur:describe-report-definitions` 检测账号是否已有符合条件(Hourly + Resource IDs)的既有 CUR
     - 有 → 提示用户选择:**0) 新建专用**(默认,官方推荐) / **1) 复用既有**
     - 无 → 直接新建
3. 复用路径(选 1,或上面认出了 `notiops-cur-report`):**同步 invoke `lambda6_cur_finalizer`**(数据已就绪 → 动态发现/建 Athena 表 → 写 `READY`，无需等 24h)
4. 新建路径:创建 S3 桶(含 CUR 服务写入的桶策略)→ `cur put-report-definition` → 写 DDB `PENDING` → `scheduler create-schedule`(一次性,`action-after-completion=DELETE`)

### 13.3 涉及的新增 AWS 资源

| 资源 | 用途 |
|---|---|
| S3 桶 `notiops-cur-<account_id>-<region>` | CUR 报告专用交付桶(Parquet 格式) |
| CUR ReportDefinition `notiops-cur-report` | Hourly + Resource IDs + Athena 集成 |
| Lambda `lambda6_cur_finalizer`(函数名由 CDK 生成,日志组固定为 `/aws/lambda/notiops-cur-finalizer`) | 检测首次交付、部署 Athena 集成 CFN 栈;由下面那条一次性 schedule 触发,另有一条常驻的 EventBridge 规则 `notiops-cur-finalizer-selfheal` 每 4 小时兜底一次(没有记录或已 `READY` 时直接返回) |
| IAM Role `notiops-cur-finalizer-role` | Lambda6 执行角色:S3 只读(任意 CUR 桶)+ CFN Create/Delete/DescribeStackResources(限 `notiops-cur-athena-*`)+ Glue 建/删/发现库表·Start/StopCrawler + Lambda 建/删·PutFunctionConcurrency + IAM 建/删 Role(部署 AWS 官方 Athena 模板所需) |
| IAM Role `notiops-cur-finalizer-scheduler-role` | EventBridge Scheduler 调用 Lambda6 的角色 |
| EventBridge Scheduler(一次性,setup.sh 动态创建) | T+25h 触发 Lambda6,完成后自动删除(`action-after-completion=DELETE`) |
| DDB 记录(复用既有 `notiops-config` 表) | `PK=cur-athena-status#<account_id>`,追踪 `PENDING/READY/DELAYED/FAILED` |
| CFN 栈 `notiops-cur-athena-<account_id>`(Lambda6 部署) | AWS 官方生成的 Athena 集成模板:Glue Database + Crawler + 2 Lambda + S3 通知 |

### 13.4 手动排查

若 24 小时后 FinOps 仪表盘仍显示"初始化中":

```bash
# 1. 查 DDB 状态
aws dynamodb get-item --table-name notiops-config --region $AWS_REGION \
  --key '{"PK":{"S":"cur-athena-status#<account_id>"},"SK":{"S":"STATUS"}}'

# 2. 若 status=DELAYED，重跑 setup.sh（会重新检测并调度）
# 3. 若 status=FAILED，查 error 字段 + Lambda6 CloudWatch 日志：
aws logs tail /aws/lambda/notiops-cur-finalizer --region $AWS_REGION --since 2d

# 4. 手动确认 CUR 报告是否已交付（S3 里能看到 crawler-cfn.yml 即代表已交付）：
aws s3 ls s3://<CUR_BUCKET>/<report-prefix>/<report-name>/ --recursive | grep crawler-cfn
```

### 13.5 权限提醒

执行 `setup.sh` 的 IAM 身份需要额外具备:`cur:PutReportDefinition` / `cur:DescribeReportDefinitions`、`s3:CreateBucket`、`scheduler:CreateSchedule`、`iam:PassRole`(传给 `notiops-cur-finalizer-scheduler-role`);以及配置 Athena FinOps 保存查询所需的 `athena:GetWorkGroup` / `athena:UpdateWorkGroup`(给 primary workgroup 设结果输出位置)+ `athena:ListNamedQueries` / `athena:BatchGetNamedQuery` / `athena:CreateNamedQuery`。CDK 部署的 `notiops-cur-finalizer-role`(见 §13.3)与 Web Chat BFF role(含查 CUR 所需的 `athena:*Query*` + `athena:ListNamedQueries`/`BatchGetNamedQuery`/`GetNamedQuery`(Cost Deep Dive 取保存查询)、`glue:Get*`、CUR 桶只读,结果桶的 `s3:GetBucketLocation` + `s3:GetObject`/`s3:PutObject`(`GetObject` 供 Deep Dive CSV 下载重签);Cost Deep Dive 的 AI 洞察需 `bedrock:InvokeModel`(先用 DeepSeek V3.2,这个区没有它或没出结果时回落到默认模型 Kimi K3),当天结果缓存需 `dynamodb:PutItem`(`notiops-config` 表)——缺 `GetBucketLocation` 时 Athena 会报 "Unable to verify/create the output bucket")无需手动授权。

CUR 就绪后(复用既有 CUR 时几分钟内),`setup.sh` 自动:① 给 primary workgroup 设结果输出位置(`s3://notiops-data-<account>-<region>/athena-results/`,已有则不覆盖)② 用【动态发现的库/表名】幂等创建 **6 条** Athena 保存查询——`NotiOps - DevOps Agent Usage & Credit`(与仪表盘 credit 卡同口径)、`NotiOps - EDP Commitment Attainment`(改 `params` 里年度承诺额 + 合同起止即可直接跑),以及 4 条 **Cost Deep Dive** 明细查询:`CloudWatch cost by usage type` / `Data Transfer by service` / `EC2 cost by instance type` / `S3 cost by storage class`(供仪表盘"成本深挖"卡按需运行)。仪表盘 Commitments & Programs 卡的"在 Athena 查看 SQL"链接即指向这里;Cost Deep Dive 各场景的 SQL 也从这些保存查询取(单一真源,可在 Athena 控制台直接改),BFF 跑完后把真实结果行交给 Bedrock 出图表+洞察,并把当天结果缓存到 `notiops-config` 表(同一天再点只重签 CSV 下载链接,不重复跑 SQL/调 AI)。

---

## 14. 客户 CUR 仪表盘 + cost-agent MCP（可选）

> 与 §13 的区别：§13 查的是**本部署账号**的 CUR（NotiOps 自动创建）；本节接入的是**一张 CUR 表**（行级明细）。NotiOps 替你部的 server 只查**部署账号、部署 Region 里**的表（CUR 在另一个账号的情况这一版暂不支持）；CUR 在别的账号（跨账号 / 多 payer）时，用「外接」指向你自己在跑的 server（见 §14.2）。不配置本节，FinOps 页不显示 4 个 CUR sheet、聊天里也不挂载 CUR 工具，其余功能不受影响（fail-closed）。
>
> **这个成本 MCP server 是 NotiOps 自己的实现，就在本仓库里**（`cost_mcp/`，6 个 Python 文件、45 个只读工具）。你**不需要**去别处找代码、也不需要自己写 Lambda —— 给一张 CUR 表，NotiOps 就替你把它部起来（见 §14.2）。如果你**已经**有一个自己在跑的 cost-agent MCP，也可以让 NotiOps 指过去而不新建（§14.2 的「外接」那一行）。

### 14.1 提供什么

| 能力 | 入口 | 说明 |
|---|---|---|
| 4 个 CUR 仪表盘 sheet | FinOps 页：费用趋势（交叉筛选）/ Credit / 扩展支持 / Savings Plans | 数据 BFF 当天缓存，每日预热后秒开 |
| 聊天问客户费用 | 对话页直接问（如"客户 7 月总费用"） | agent 经 2 个元工具（list_cost_tools/call_cost_tool）调 MCP 的 45 个 CUR 工具 |
| 内联图表 | 聊天回答 ≥3 数据点自动附图 | 工具返回值带 `chartable`，前端渲染 ```chart 围栏 |

**45 个工具按用途分组**（完整目录在运行时问一句「列出可用的成本工具」即可，那是唯一权威来源）：

| 组 | 能回答的典型问题 |
|---|---|
| 基础费用 / 趋势 / 归因（7） | 「这个月花了多少」「今年到现在」「Top10 服务」「按账号/region/OS/usage_type 拆」「**XX 为什么涨了**」（两月环比可再下钻到 usage_type / 机型 / 账号） |
| EC2 与算力（8） | 「OD/SP/Spot/RI/CB 各占多少」「日均多少台 / 多少 vCPU」「Graviton 用了多少」「c5 vs c6i vs c7g」 |
| 承诺折扣 SP / RI / ODCR（10） | 「SP 覆盖率 / 利用率 / **浪费了多少钱**」「哪几张合同在浪费」「**90 天内哪些 SP 要到期**」「ODCR 利用率（含最低利用率明细）」 |
| 单服务下钻（9） | 「S3 按 API Operation 拆」「存了多少 PiB、各存储类多少」「EBS 有多少块盘、gp2 还剩多少」「**传了多少 GB 流量**、跨 AZ 多少」「DX 专线端口清单」 |
| 账务 / 对账（5） | 「Credit/Refund/Tax 明细」「**EDP 折扣拿了多少**」「按 payer×charge_type×币种的对账总表（总和≈发票额）」「这个月新增了哪些账号」 |
| AI 成本（2） | 「各模型花了多少」「**消耗了多少百万 token**」 |
| Tag 分摊（1） | 按业务标签拆费用 / 台数 / vCPU |
| 仪表盘专用（3） | 供上面那 4 个 sheet 取数，**聊天里不用** |

> **为什么值得用它而不是只用 Cost Explorer**：这 45 条 SQL 固化了一批 CE 给不出的口径 ——
> 摊销用**行级** `CASE`（`net_unblended` 会被 SavingsPlanNegation 抵消）、`final_service` 把
> EC2 里的 EBS / NAT Gateway / VPC Peering **拆出来**、台数用 `SUM(usage_amount)/24` 配三类
> usage_type + 四类 charge_type（`COUNT DISTINCT` 会差一个数量级）、ARN 判空一律
> `COALESCE`（CTAS 表给 NULL、原生表给空串）。聚合**全部由 SQL 直出**，返回值里带
> `caliber_note` 要求模型照实转述、不许自己加总。

### 14.2 让 NotiOps 替你部一个（推荐），或指向你已有的那个

**三种状态，二选一或都不选**：

| 状态 | 怎么选 | 结果 |
|---|---|---|
| **不启用**（默认） | 什么都不填 | 零新增资源。成本问题走 Cost Explorer，功能不缺一块，只是没有行级明细 |
| **NotiOps 自建**（推荐） | 给一张 **CUR 表**，或者让 NotiOps **连 CUR 一起建** | NotiOps 建一个 Lambda（`cost_mcp/`，本仓库代码）+ 专用 Athena workgroup + 独立结果桶，全部在**你的账号里** |
| **外接**（逃生口） | 给 Function URL + 函数 ARN | 指向你已经在跑的那个 cost-agent MCP，NotiOps 不新建任何东西 |

> 两者**互斥**。同时填会在参数校验阶段被拦（方式 A 的 `CostMcpExclusiveWithExternal`）
> 或 `setup.sh` 前置校验直接停 —— 因为「两个都填时哪个生效」会变成要读代码才知道的事。

#### 自建要给什么

| 值 | 方式 A（一键 CFN 参数） | 方式 B（`setup.sh` 环境变量） | 必填？ |
|---|---|---|---|
| **让 NotiOps 替你建 CUR** | `ProvisionCur=yes` | 不用另给：`COST_MCP_SELF_HOST=true` 又没给表时自动建（见下） | 二选一：没有 CUR 就选它 |
| CUR 的 Glue 表 `库.表` | `CurTable` | `CUR_TABLE`（**能自动带出来**，见下） | 二选一：已有 CUR 就填它 |
| CUR 数据所在 S3 桶 | `CurBucketName` | `CUR_BUCKET_NAME` | 填了表就必填（方式 B 从记录里带出表时，桶也一起带出） |
| 跨账号只读角色 ARN | `CurRoleArn` | `CUR_ROLE_ARN` | **暂不支持，留空**（填了会被拒，见下） |
| 分区形态 | `CurPartitionStyle` | `CUR_PARTITION_STYLE` | 默认 `flat`，**务必核对** |
| CUR schema 版本 | `CurVersion` | `CUR_VERSION` | 默认 `1`（`2` 为实验性） |
| 要按哪些 user tag 拆 | `CurTagKeys` | `CUR_TAG_KEYS` | 可选，逗号分隔、不带空格；填的是**列名后缀**，见下 |
| 单次查询扫描量上限 | `CostMcpScanCapGiB` | `COST_MCP_BYTES_CUTOFF` | 默认 100 GiB（`COST_MCP_BYTES_CUTOFF` 的单位是字节） |

> ⚠️ **表、它的 Glue 库和 CUR 桶都要在部署 NotiOps 的那个账号、那个 Region 里。** server 就在那里跑
> Athena，而 Athena 只认本 Region 的 Glue 目录：表在别的 Region 时部署照样成功，之后每次查询都失败
> （4 个 sheet 显示「暂时不可用」，聊天退回 Cost Explorer）。CUR 的 Athena 集成在别的 Region 时，
> 把 NotiOps 部署到那个 Region，或者让 NotiOps 在部署 Region 新建一份（上表第一行）。

> ⚠️ **CUR 在另一个账号（`CurRoleArn` / `CUR_ROLE_ARN`）这一版暂不支持**，三处都会拒：一键模板的
> `CostMcpCrossAccountNotSupported` 规则、`setup.sh` 的前置检查、CDK synth。原因：查询会跑在 CUR
> 那个账号里，用的却是只存在于 NotiOps 账号的 workgroup，每次都会失败。两个办法：① 把 NotiOps
> 部署在 CUR 所在的账号；② 用「外接」指向你自己的 server（`CostAgentMcpUrl` + `CostAgentFunctionArn`
> / `COST_AGENT_MCP_URL` + `COST_AGENT_FN_ARN`，见 §14.3）。模板里 `CurRoleArn` 这个参数还在，留空即可。

> **`CurTagKeys` / `CUR_TAG_KEYS` 填的不是你在 AWS 里敲的 tag key，而是 CUR 表列名里
> `resource_tags_user_` 后面那段。** 先在 Glue / Athena 里看一眼表的列名：比如 tag `cost-center`
> 通常是 `resource_tags_user_cost_center` 这一列，就填 `cost_center`（多个写成 `team,cost_center`）。
> 只能是字母、数字、下划线，逗号前后不要空格。方式 A 的参数页会拒绝别的字符。方式 B 不预先检查：
> 别的字符（比如 `cost-center`）部署照样成功，但 server 一启动就报错，45 个工具全用不了；带了空格则
> `setup.sh` 停在 CDK synth 那一步，报错里不提 tag key（CDK 说的是 `No stacks match the name(s) …`）。
> 留空 = 不提供任何 tag 维度。

#### 还没有 CUR？两条路径都能替你建

**两条部署路径都可以替你建 CUR**（含官方的 Athena 集成）。你不需要先去 AWS 控制台自己配：

- **方式 A**：参数页把 `ProvisionCur` 选成 `yes`，`CurTable` 留空。
- **方式 B**：`COST_MCP_SELF_HOST=true ./setup.sh`，**跑一次就行**，不用给 `CUR_TABLE`。自建 server
  按 NotiOps 新建的那份 CUR 授权（桶 `notiops-cur-<账号>-<region>`），同一次运行里后面「CUR + Athena」
  那一步（§13）**直接新建、不再问**；账号里还留着 NotiOps 上次装时建的 `notiops-cur-report`（删除
  NotiOps 时刻意保留）的话，就改用它和它的桶，不再新建。

建出来的是一份 **Hourly + Include Resource IDs + Athena/Parquet** 的 CUR（45 个工具要的就是
这个组合，规格与每个字段的理由写在 `cur_provisioner/spec.py`）。

> ⏱ **AWS 首次交付最长 24 小时,这是 AWS 侧的硬延迟,我们绕不过去。**
> 在那之前成本问题走 Cost Explorer；就绪后 NotiOps **自己会切过去**，
> **你不需要回来再部署一次**（NotiOps 每 4 小时检查一次，就绪的那一刻自动接上）。

> 🔒 **删掉 NotiOps 不会删掉你的账单数据。** CUR 报告和它的 S3 桶在栈删除时**原样留下** ——
> 那是你的账单历史，而 AWS **不会补发**过去的月份。不想要了请自己手动删。
> NotiOps 的那个角色**连删除权限都没有**。
> 重装时直接复用：方式 B 的 `setup.sh` 认出留下的 `notiops-cur-report`、不问也不重建，几分钟内
> 接上原来的 Athena 表；方式 A 由每 4 小时一次的检查接上（最长约 4 小时）。

**已经有 CUR 了**：方式 A 让 `ProvisionCur` 保持 `no`，表名填进 `CurTable`、桶名填进 `CurBucketName`。
方式 B 带上 `CUR_TABLE=<库>.<表> CUR_BUCKET_NAME=<桶>` 和与这张表相符的 `CUR_PARTITION_STYLE`，
并且**以后每次跑 `setup.sh` 都带上**。不带时 `setup.sh` 用的是 `notiops-config` 里
`cur-athena-status#<账号>` 那条记录：它记的是 §13 那一步替你建好或接上的那份 CUR（分区形态也按它
推断，推断不出就当 `flat`）—— 你要用的正好是那份，这几个值才可以都不填。**都不带、又没有那条记录**时，
方式 B 会照上面那样替你新建一份，而不是用你已有的那份。两种方式下，这张表都要满足上面
「同账号、同 Region」那一条。

> ⚠️ 两者**互斥**：`ProvisionCur=yes` 同时填 `CurTable` 会在参数校验阶段被拦
> （`ProvisionCurExcludesCurTable`）。否则会白建出第二份 CUR（多一份账单费用），
> 而你以为用的是自己填的那张表。
> 方式 B **没有**这道拦截：带了 `CUR_TABLE`，§13 那一步照样会跑。还没有那条记录时，它会给 FinOps
> 仪表盘接上一份 NotiOps 自己的 CUR（账号里留着上次的 `notiops-cur-report` 就复用它；否则新建 ——
> 没有符合条件的既有 CUR 时直接建、不问，有的话会问，默认答案也是新建，见 §13.2）。之后那条记录记的
> 就是这一份。

**方式 B 重跑**：已经自建过的部署，之后直接 `./setup.sh` 就**保持自建** —— 它认得出自己部的那个
server（WebChatStack 的 `CostMcpUrl` 输出与现网 BFF 里的一致），不用每次都带 `COST_MCP_SELF_HOST=true`；
当初设过的 `CUR_VERSION`、`CUR_TAG_KEYS` 和单次查询扫描上限也从现网沿用。要撤掉自建的 server，用
`COST_MCP_SELF_HOST=false ./setup.sh`（会先打一条警告）；之后 FinOps 里那 4 张 CUR 报表不再出现
（被 `requiresEnv` 摘掉），成本问题改走 Cost Explorer。读不到栈输出、分不清现网那个 server 是不是
NotiOps 部的时候，`setup.sh` 会停下来让你说清楚，而不是猜。

> ⚠️ 有两处它**不会**停下：
> - **表、桶和分区形态不从现网沿用**，而是像上面「已经有 CUR 了」说的那样取自那条记录。用你自己那张表的
>   部署不带它们重跑，会换到另一份 CUR 上。
> - 读不到的若是**现网 BFF 的配置**（警告「⚠️ 读不到现网配置……客户自有 CUR 数据源（cost-agent MCP）」），
>   `setup.sh` 只警告、照常往下跑，也认不出这是自建的 —— 不带开关跑完，这次部署会删掉自建的 server。
>   自建的部署看到这条，请改用 `COST_MCP_SELF_HOST=true ./setup.sh`，并把当初设过的 `CUR_VERSION` /
>   `CUR_TAG_KEYS` / `COST_MCP_BYTES_CUTOFF` 一起带上（这种情况下读不回来）；别照警告里那条外接命令跑。

#### 🔴 花费护栏（这一项请务必看一眼）

Athena **按扫描字节收费**，而且**没有**逐次调用的上限、**被取消的查询照样计费**。所以
NotiOps 给这个 server 建的是一个**专用 workgroup**，把 `BytesScannedCutoffPerQuery` 设成
`CostMcpScanCapGiB`（默认 **100 GiB**）并强制生效 —— 一句话问不出一张天价账单。
CUR 很大、查询总被取消时把它调高；想把"一个问题最多花多少"压得更死就调低。

#### 权限（自建态，NotiOps 自动配好）

执行角色对你的 CUR 数据**一个写动作都没有**：Athena 五个只读动作**限定到那个专用 workgroup**、Glue 目录
只读、CUR 桶只读、结果桶只写自己的结果前缀。CUR 在另一个账号的情况这一版暂不支持（见上）；
**NotiOps 也不会、不支持为此保存长期 access key**。

#### ⚠️ 换一张 CUR 表，答案可能"少一块"——这是正常的，不是故障

CUR 的**列集按账号变化**：AWS 只为你**实际用到**的服务维度输出属性列。所以：

- **没有折扣协议（EDP/PPA）** ⇒ 没有 `*_net_*` 那组"折后"列。server 冷启动会探测到，自动
  改用折前（`unblended`）列，并在**每一次回答里声明**这一点。没有折扣时两者本来就相等；
  有折扣时这句声明很重要 —— 别把折前当折后看。
- **没有 Savings Plan** ⇒ 没有 `savings_plan_*` 那组属性列 ⇒ SP 明细类工具会明确回答
  「你的账单里没有 SP」，**而不是报错、也不是答 0**。
- 同理：没跑过 GPU ⇒ 没有 `product_gpu`；没有 Direct Connect ⇒ 没有 `product_port_speed`。

> 这条纪律叫「**不许静默降级**」：口径变了必须说出来，拿不到的数据必须说拿不到 ——
> 一个看起来正常的错数字，比一句"这项数据你的账单里没有"糟得多。

### 14.3 外接模式的接线（指向你已有的那个 server）

> 自建模式看 §14.2 就够了，本节只讲**外接**。

外接要给的是**两个值**，且必须成对：Function URL 里不含函数 ARN，而 `lambda:InvokeFunctionUrl` 只能按资源授权 —— 只填一半会部署出一个「看起来装好了、每次调用 403」的数据源，而 403 只在 CloudTrail 里看得到。所以两条路径都在**动手之前**拦住这种半配置。

| | 怎么给 | 拦「只填一半」的位置 |
|---|---|---|
| 方式 A（一键 CFN） | 参数页 → *Optional: your own CUR data source* → `CostAgentMcpUrl` + `CostAgentFunctionArn`（可在首次部署后更新栈再填） | `CostAgentArnRequiredWithUrl`（CfnRule，参数校验阶段，栈根本不会创建） |
| 方式 B（setup.sh） | `COST_AGENT_MCP_URL=... COST_AGENT_FN_ARN=... ./setup.sh` | setup.sh 的前置校验（在 20 分钟的 agent 部署**之前**） |

给了以后，两条路径自动落地全部四件（不再有手工步骤）：

1. **Agent（聊天问答）**：runtime 环境变量 `COST_AGENT_MCP_URL` + 执行角色上的两条语句 `InvokeCostAgentMcp`（`lambda:InvokeFunctionUrl`）与 `InvokeCostAgentMcpFn`（`lambda:InvokeFunction`）。
2. **BFF（仪表盘数据）**：同名环境变量 + 同样那两条语句 + 缓存前缀的 S3 读写（`CurDashCache`）。
3. **缓存生命周期**：数据桶 `cur-dash-cache/` 前缀 3 天过期。
4. **每日预热**：EventBridge 规则 `CurDashWarmup`。

> ⚠️ **升级注意**：这些以前是手工配的（v1.0.x 的旧 §14.3/§14.4）。现在 CDK **拥有** BFF 的环境变量与那条规则 —— 下一次部署会用参数值**覆盖**你手工设的 `COST_AGENT_MCP_URL`。所以升级时要把 URL 与函数 ARN 一起传给 setup.sh（或填进一键部署的参数），否则手工配置会被清成空 → 4 个 sheet 静默消失（能力节点被 `requiresEnv` 摘掉）。手工建的 EventBridge 规则请删掉，避免每天预热两次。

**IAM 双向**：identity 侧（上面那两个角色）的授权已入 IaC —— server 与 NotiOps **在同一个账号**时，这就够了。server 在**另一个账号**时，它那一侧（那是你自己的部署，不在本仓库里）的 **resource policy** 还要允许这两个角色调用它，同样**两个动作都要给**。

> 🔴 **外接自己的 server 时，两个动作都要给**：`lambda:InvokeFunctionUrl` **和** `lambda:InvokeFunction`。AWS 在 **2025 年 10 月**改了 Function URL 鉴权，新建的 URL 要求两者齐备（[官方文档](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)开头那条 Note）。只给前一个的表现非常容易误判：签名有效、身份被正确识别、IAM 策略模拟器还会说 `allowed`，但请求在**授权阶段**被拒 → 403，而且**根本不会到达你的函数**（函数日志一片空白，只有 CloudWatch 的 `Url4xxCount` 在涨）。
> ⚠️ 两条语句的 Condition **不一样**：`InvokeFunctionUrl` 用 `lambda:FunctionUrlAuthType = AWS_IAM`；`InvokeFunction` 的授权上下文里**没有**那个键，要用 `lambda:InvokedViaFunctionUrl = true`（照抄上一条会因条件不匹配再次 403）。

### 14.4 数据源挂了会怎样（降级链，绝不阻断整个工具）

这是个**外部**依赖，所以按四层失败安全设计，且降级一律**明说**（静默降级比报错更危险 —— CE 的聚合数字冒充 CUR 的行级数字，会让客户拿错数去对账）：

| 层 | 场景 | 客户看到 |
|---|---|---|
| 部署期 | 没填参数 | 这项能力**按设计不存在**：4 个 `nav:finops:cur-*` 节点被 `requiresEnv` 摘掉（不会出现点了没反应的菜单）；agent 侧一个工具都不挂 |
| BFF | MCP 不可达/超时 | 只有那 4 张表显示「暂时不可用」（HTTP 200 + `available:false`），页面其余部分照常 |
| Agent | MCP 不可达/超时 | 回答照出：**客户 CUR（行级）→ CE MCP（聚合，部署账号）→ `call_aws` / `aws_readonly`**，并明确告知换了数据源与口径 |
| Agent | 连续 2 次传输层失败 | 熔断 10 分钟内直接快速失败（不再每轮干等 300s —— 那才是真正的"整个工具被 block"） |

单个工具的**逻辑错**（参数不对）不计入熔断：数据源还活着，让模型改参数重试。判据：`tests/test_cost_agent_mcp_failsoft.py`、`bff/web-chat/tests/cur_dashboard_failsoft.test.mjs`。

预热动作：BFF 收到 `{"source":"notiops.curdash.warmup"}` 后以默认时间窗（T-33 ~ T-3，CUR 最近 3 天未出全故封窗）并发查 4 个 panel 写入当天缓存；用户白天首次打开即秒出。cron 是 `cron(0 22 * * ? *)`（UTC 22:00 = 北京 6:00）——**缓存 key 的日期基准是 UTC+8**，改时区要两处一起改。验证：手动 `aws lambda invoke --invocation-type Event` 发同一 payload，日志应出现 `curdash warmup: cube:fulfilled credit:fulfilled es:fulfilled sp:fulfilled`，**而且**前面没有 `cur-dash <panel>: source unavailable (…)` 告警 —— 单看那一行不够：取数失败的 panel 已被收敛成「暂时不可用」，在那一行里同样记作 `fulfilled`。

### 14.5 常见问题

| 症状 | 原因 |
|---|---|
| 4 个 sheet 显示"数据源未配置" | BFF 缺 `COST_AGENT_MCP_URL` 或 IAM 未通 |
| 调 MCP 持续 403 | **最常见:只给了 `lambda:InvokeFunctionUrl`,少了 `lambda:InvokeFunction`**(AWS 2025-10 起两个都要);或者 server 在另一个账号、它的 resource policy 没加调用方角色。判据:函数日志里**没有**这次请求、而 `Url4xxCount` 有 —— 说明是授权阶段被拒,不是你的代码 |
| 每天首开仍加载 1-5 分钟 | 预热没跑或时区错位——缓存 key 的日期基准是 UTC+8，EventBridge cron 与之配套；查 BFF 日志的 warmup 行 |
| 4 个 sheet 显示「暂时不可用」，预热那一行却是 4 个 `fulfilled` | 多为 MCP 侧查不了：新建的 CUR 还在等首次交付（最长 24 小时）、表不在部署 Region、`CUR_TAG_KEYS` 写错导致 server 起不来，或外接 server 自己的凭据过期等。取数失败的 panel 已被收敛成「暂时不可用」，在预热那一行里照样记作 `fulfilled`；原因看 BFF 日志里各 panel 的 `cur-dash <panel>: source unavailable (…)` |
