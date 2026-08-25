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
- §3 [注册 IM 应用](#3-注册-im-应用)(飞书 / Slack)
- §4 [配置项与 IM 凭据](#4-配置项与-im-凭据)
- §5 [一键部署 `setup.sh`](#5-一键部署-setupsh)
- §6 [冒烟测试](#6-冒烟测试)
- §7 [开启 / 调整 Push 模式](#7-开启--调整-push-模式)
- §8 [日常运维](#8-日常运维)
- §9 [回滚策略](#9-回滚策略)
- §10 [Top 5 部署常见错误](#10-top-5-部署常见错误)
- §11 [完整参数参考](#11-完整参数参考)
- **§12 [Web Chat 部署](#12-web-chat-部署)** — agentic AI 助手(浏览器端),独立于 IM bot
- **§13 [CUR + Athena FinOps 数据源](#13-cur--athena-finops-数据源)** — FinOps 仪表盘的成本明细数据源(可选;复用既有 CUR 即时,新建 CUR ~24h)

---

## 0. 快速部署 TL;DR

> 适合"先快速跑起来,细节后看"。所有命令都假设你已经走完 §2 前置条件。Web 端(浏览器聊天控制台)默认部署,是产品主入口;IM(飞书 / Slack)是可选补充,只有你想启用时才需要走 §3 注册 IM 应用。

> 💡 **只想先试试 Web Chat?** 那这篇整个都不用读。[DEPLOYMENT_ONECLICK.md](DEPLOYMENT_ONECLICK.md)
> 是一条**不需要本地装任何东西、也不需要 access key** 的路径:从 Release 下一个
> CloudFormation 模板、在控制台上传、~4.5 分钟开完栈。代价是它**只部署 Web Chat** ——
> 没有 IM bot、没有每日巡检、没有管理仪表盘。想要这些就回来走本篇的 `setup.sh`
> (两条路径的管理员用户名都是 `admin`,先后走不冲突)。

### 0.1 一键部署

```bash
./setup.sh
```

首次运行会**交互式引导**:确认 AWS 账号 + region →(可选)PHD 事件转发 → **选 IM 平台(默认 `0` 暂不部署,只上 web 端;想启用飞书 / Slack 才选)**→ 构建前端(admin 控制台 + chat-app)→ 部署 Web Chat Agent(AgentCore Runtime)→ 走 CDK bootstrap → CDK synth → CDK deploy `--all`。**Web Chat + 后端 agent 默认就会部署**;IM 凭据**不在此处采集**——CDK 只创建**空的** Secret,部署完成后再按结尾提示填(见 §4 / §5)。

> **关于钉钉**:`bot-stack.ts` 仍然定义了 DingtalkBotService(代码完整保留),但 v1 `setup.sh` 不显示这个选项 → `enabledPlatforms` 默认不含 `dingtalk` → 钉钉 task `desiredCount=0`,不启动不计费。v2 会开放钉钉的双 robot 凭据流程。

部署的三栈(`cdk deploy --all` 一次部到位):
- `NotiOpsBackendStack`:共享后端(DDB、Lambda5 个、S3 报告 bucket、EventBridge rules)
- `BotStack`:IM bot 平台栈(VPC、ECS Cluster、每个被勾选平台一个 Fargate Service + ECR;每个 task 内含 pricing + cost MCP sidecar)。**未选任何 IM 时该栈仍部署,但所有 bot `desiredCount=0`,不起容器、不计费**
- `WebChatStack`:浏览器端 agentic AI 助手(**默认部署**;BFF Lambda + Function URL、DDB 单表 `notiops-web-chat`、静态前端、通知 handler)

后续重跑 `./setup.sh` 只补差异部分(已存在的 stack 走 `cdk diff` 增量更新,镜像有改动才重 build)。

### 0.1.1 部署完成后:哪些开箱即用,哪些还要配一步

`setup.sh` 跑完后,请分清两类功能 —— **别把"仅巡检需要"的配置误当成"整个产品必需":**

| | 整个产品**开箱即用**(无需额外配置) | **仅**这些功能需要额外配一步 |
|---|---|---|
| **功能** | Web Chat:AWS 问答 · 故障调查 · 成本分析 · Support 案例 · Skills · 通知(Health/告警推送) | 闲置资源检测 + 成本**自动巡检**(notiops 每日扫描) |
| **默认操作对象** | **部署账号本身**,登录即用 | 需在 Dashboard「目标账户管理」填 `账户ID + Role ARN + Region` |
| **不配的后果** | — | 巡检**空转**(无账户可扫),但 **Web Chat 完全不受影响** |

> 一句话:**只用 Web Chat 聊天 → 登录就能用,什么都不用配**;要用**闲置/成本自动巡检**(或将来的主动化哨兵跨账号定时巡检)→ 才需要在「目标账户管理」加账户。跨账号巡检还需目标账号预建只读 `notiops-idle-detection-role` —— Organizations 场景用 `./setup.sh --multi-account` 经 StackSets 自动下发(含 DevOps/PHD 事件转发),或在控制台「账户接入 (Organizations)」页一键接入;非组织场景在目标账号手动部署 [`infra/member-account-onboarding.yaml`](../infra/member-account-onboarding.yaml)。

### 0.1.2 部署模式:单账号(默认) vs 多账号 `--multi-account`

**先决定用哪种模式再跑 `setup.sh`** —— 这决定 CDK 在部署时如何写死跨账号闸门,**部署后要切换必须重新部署**(不是运行时开关)。

| | **单账号模式(默认)** | **多账号模式** `./setup.sh --multi-account` |
|---|---|---|
| **怎么触发** | 直接 `./setup.sh` | `./setup.sh --multi-account`,且需在**组织管理账号**,或已在管理账号注册为 **CloudFormation StackSets 委派管理员**的成员账号上运行 |
| **面向谁** | 只在**本账号**用 NotiOps(绝大多数试用 / 单账号客户) | 用 Organizations 管理一堆账号,想**跨成员账号**巡检 / 调查 / 转发事件 |
| **跨账号闸门** | 锁定到部署账号(`LOCKED_ACCOUNT_ID` = 本账号);Web 控制台的多账号选择器只列本账号 | 解锁闸门(`LOCKED_ACCOUNT_ID` 置空,改用 `aws:PrincipalOrgID` 整组放行);控制台可接入 / 切换成员账号 |
| **成员账号资源** | 不下发 | 经 **StackSets** 自动向成员账号下发只读 role + DevOps/PHD 事件转发 |
| **影响的功能** | Web Chat 全部功能对**本账号**开箱即用 | 额外解锁:跨账号**闲置/成本巡检**、跨账号**故障调查**、跨账号 **PHD/DevOps 事件转发**、控制台「账户接入 (Organizations)」页 |

**为什么不默认开多账号?** 多账号模式要求当前身份是 **Organizations 管理账号**(或其 **StackSets 委派管理员**)、要动 StackSets 并向成员账号下发资源 —— 对只想在单账号里试用的绝大多数用户是多余且更高权限的操作。默认单账号是最小权限、最快跑通的路径,所以**默认关**;需要时显式加 `--multi-account` 才启用。

**已经单账号部署过、后来想要多账号怎么办?** 在 Organizations 管理账号(或 StackSets 委派管理员账号)重跑 `./setup.sh --multi-account` 即可(CDK 增量更新会重写闸门 + 补下发成员账号资源)。若你在 Web 控制台看到「当前部署未启用 Organizations 多账号模式。请在组织管理账号(或 StackSets 委派管理员账号)用 `./setup.sh --multi-account` 重新部署」——正是提示你当前是单账号部署,需要用管理账号(或委派管理员)加 `--multi-account` 重跑,**这一步无法在控制台里点开关切换**。

> 不确定选哪个?**先按默认单账号跑通**,验证 Web Chat 能用;之后确有跨账号需求再用管理账号(或委派管理员)重跑 `--multi-account`。两者不冲突,后者是前者的超集。

### 0.2 验证

**主验证 —— 打开 Web Chat(唯一主入口)**:部署结束时脚本会打印 Web Chat 地址 + `admin` 用户和临时密码(称其为"唯一主入口")。浏览器打开该地址,用 `admin` / 临时密码登录(首次登录需改密码),随便问一句(例:"列出本账号 EC2")能得到回复即成功。

```
浏览器打开脚本结尾打印的 Web Chat 地址 → 用 admin / 临时密码登录 → 发一句问答
```

**仅当你启用了 IM 平台**(飞书 / Slack)时,再在群里 @bot 验证:

```bash
# 在飞书 / Slack 群里 @bot 一句话(需先填好该平台凭据,见 §4 / §5):
@NotiOps 你好
```

期望几秒内回复。如果没反应 → §6 冒烟测试 / §10 排查。

✅ **完事**。

---

## 1. 部署架构

CDK 部署三个栈,`./setup.sh` 走 `cdk deploy --all` 一次部到位。**Web Chat(浏览器端主入口)与承载它的 AgentCore agent 默认就会部署** —— `setup.sh` 会先构建 chat-app 前端、跑 `scripts/deploy_agent.sh` 部署 agent,再 `cdk deploy --all`:

| 栈(CDK 名) | 必选 | 部署内容 |
|---|---|---|
| **`notiops-*`** | ✅ 必选 | Lambda × 5(collector / analyzer / health-checker / notifier / cost-analyzer)、共享 DDB 表、S3 报告 bucket、EventBridge rules(5 条 IM push 规则 + 10 条 web 通知规则 + notiops schedules)、agent-trigger Role(供 STS AssumeRole) |
| **`WebChatStack`** | ✅ 默认部署 | 浏览器端 agentic AI 助手(**产品主入口**):BFF Lambda(`notiops-web-chat-bff`)+ Function URL(`AWS_IAM`)、DDB 单表 `notiops-web-chat`(会话/消息 + 通知收件箱)、静态前端(chat-app)、通知 handler。BFF 通过 `-c agentRuntimeArn` 注入上一步 agent 的 Runtime ARN |
| **`BotStack`** | ✅ 部署(IM 可选) | VPC + Public Subnets、ECS Cluster(512 CPU / 1024 MB per task)、ECR repo、被勾选的 IM 平台 Fargate Service(v1: 飞书 / Slack)、**每个 task 内含 pricing + cost MCP sidecar**、Task Role、Security Group。**未选任何 IM 时该栈仍部署,但所有 bot `desiredCount=0`,不起容器、不计费** |

**部署顺序**(`./setup.sh` 自动处理):
```
./setup.sh(交互式选 region / 可选 PHD /【默认跳过 IM】)
   → 构建前端(admin 控制台 + chat-app) → 部署 Web Chat Agent → cdk deploy --all
(可选)想启用 IM 时:先 §3 注册 IM 应用,再重跑 setup.sh 选对应平台
```

凭据流向:`setup.sh` **不采集 IM 凭据**——它只根据你选的平台设置 `enabledPlatforms` 开关。CDK 会创建**空的** Secret(`notiops/im-bot-feishu` / `notiops/slack-bot-token` / `notiops/slack-app-token`),部署完成后由你在 Web Chat admin 控制台「通知设置」填,或直接改 Secrets Manager 再强制重启对应 ECS 服务(见 §4)。CDK 栈始终通过 ARN 引用这些 secret,本地不留任何凭据文件。

---

## 2. 前置条件

### 2.1 必装工具

| 项 | 要求 | 检查 |
|---|---|---|
| AWS CLI v2 | ≥ 2.13(支持 Bedrock) | `aws --version` |
| ~~AWS SAM CLI~~ | ~~≥ 1.100~~ | ~~`sam --version`~~ *(已废弃 — CDK 部署不需要 SAM CLI)* |
| Node.js | ≥ 22 | `node --version` *(CDK 依赖)* |
| 容器构建工具 | finch(推荐) / docker | `finch version` |
| jq | 任意版本 | `jq --version` |
| Python 3.12+(本地编译) | — | `python3 --version` |

### 2.2 AWS 账号准备

- **AWS 账号**:有 admin 或同等权限
- **VPC**:任何能跑 ECS Fargate 的 VPC + ≥ 2 个 AZ 的 public subnet(**仅当你启用 IM bot 时需要** —— Fargate task 出公网调 IM API;只用 web 端可忽略)
- **AWS DevOps Agent**:已开通(深度调查功能需要)。**无需自备 Agent Space** —— CDK 会在你账号下自动新建一个 `notiops-devops-<account>` space(详见 §5.3.4),你不用先手动创建或提供 space id
- **Bedrock**:`us.anthropic.claude-sonnet-4-6` 推理 profile 在你的 region 已 enable(Bedrock 控制台 → Model access)

### 2.3 Region 选择

不同组件对 region 的要求不同 —— 部署前规划清楚:

| 组件 | 可选 region | 备注 |
|---|---|---|
| **AWS DevOps Agent 服务** | **`us-east-1` 仅此一个** | AWS 当前服务限制(预览阶段单 region) |
| **共享后端 Lambda 栈** | **强烈推荐 `us-east-1`** | 要调 DevOps Agent journal API,跨 region 增加延迟和 IAM 复杂度 |
| **飞书 / Slack ECS bot 栈** | 任何 AWS region | 没有强制限制;就近选择降延迟 |
| **Bedrock** | 任何启用了 `claude-sonnet-4-6` 的 region | 通过 `BedrockRegion` 参数覆盖,可与运行 region 不同 |
| **DDB / S3 / ECR** | 跟 Lambda / ECS 同 region | CFN 自动落到 stack 所在 region |

**最简单的部署**:`setup.sh` 的 region 菜单默认选 `1) ap-northeast-1`(东京);直接回车即用该 region。DevOps Agent 服务相关能力仍以 `us-east-1` 为准(见上表)。

**多 region 场景**:bot ECS 选离用户近的 region(比如 `ap-southeast-1`),Lambda + DevOps Agent 留在 `us-east-1`。各栈跨 region 调用,DevOps Agent journal 通过 IAM Resource ARN 中的 `DevOpsAgentRegion` 参数指定(默认 `us-east-1`)。

### 2.4 IAM 部署权限

部署的 IAM 用户 / 角色需要:
- `cloudformation:*`(部署 / 回滚)
- `iam:*` + `ecr:*` + `ecs:*` + `lambda:*`(创建栈资源)
- `secretsmanager:*`(创建 secret)
- `dynamodb:CreateTable`、`s3:CreateBucket`、`events:PutRule`

> 💡 **生产安全**:本项目所有 AWS 资源默认带 `auto-delete=no` 标签,避免被自动清理任务误删。

---

## 3. 注册 IM 应用

> 跳过对应的子节,如果你只部署其中一个平台。

### 3.1 飞书企业自建应用

1. 访问 [飞书开放平台](https://open.feishu.cn/) → 用企业管理员账号登录
2. **开发者后台 → 创建企业自建应用** → 填名称(例:NotiOps)
3. **应用功能 → 机器人 → 启用**,设 bot 显示名
4. **事件与回调 → 长连接** → **启用长连接模式**(无需公网 endpoint)
5. **订阅事件**(点 + 添加):
   - `im.message.receive_v1` — 接收用户消息
   - `card.action.trigger` — 卡片按钮点击回调
6. **权限管理 → 添加权限**:
   - `im:message` / `im:message:send_as_bot` / `im:message:reply` / `im:chat` / `im:chat:readonly`
7. **版本管理与发布 → 创建新版本** → 申请发布(自建应用 admin 可自批)
8. **保存** App ID + App Secret ——`setup.sh` **不会**问你要凭据;部署完成后,在 **Web Chat admin 控制台「通知设置」**填入(或直接改 Secret `notiops/im-bot-feishu` 再强制重启 ECS 服务),详见 §4 / §5
9. **把 bot 拉进群**。如果你想让主动推送(Health / 告警等)发到某个群,先拿到目标群的 `chat_id`:

```bash
# 先拿 tenant_access_token
curl -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"'$FEISHU_APP_ID'","app_secret":"'$FEISHU_APP_SECRET'"}'

# 列群,记下目标群的 chat_id(以 oc_ 开头)
curl 'https://open.feishu.cn/open-apis/im/v1/chats' \
  -H 'Authorization: Bearer <tenant_access_token>' | jq '.data.items[]'
```
这个 `chat_id` 之后填进飞书 Secret 的 `notify_chat_ids`(或在 Web Chat admin「通知设置」里配),**不是** `setup.sh` 的交互项(可选,留空 = 关 push)。

### 3.2 Slack App

1. 访问 [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**
2. **Settings → Socket Mode** → 打开,生成 App-Level Token(scope `connections:write`)
3. **OAuth & Permissions → Bot Token Scopes** → 添加:
   - `app_mentions:read` / `channels:history` / `channels:read` / `chat:write` / `chat:write.public`
   - `groups:history` / `im:history` / `im:write` / `users:read`
4. **Event Subscriptions → Enable Events: ON** → **Subscribe to bot events**:
   - `app_mention` / `message.channels` / `message.groups` / `message.im`
5. **Install App → Install to Workspace**,拿 Bot Token(`xoxb-...`)
6. **保存** Bot Token + App Token ——`setup.sh` **不会**问你要凭据;部署完成后,在 **Web Chat admin 控制台「通知设置」**填入(或直接改 Secret `notiops/slack-bot-token` / `notiops/slack-app-token` 再强制重启 ECS 服务),详见 §4 / §5
7. 在目标 channel 中 `/invite @YourBot`,channel 设置面板查 **Channel ID**(`C...`)。想开主动推送时,把这个 Channel ID 配进通知设置(**不是** `setup.sh` 的交互项)

### 3.3 钉钉(DingTalk)企业内部应用 — **v2 才开放**

> ⏳ **v1 不开放钉钉**。`setup.sh` 选项里没有钉钉,即使你按下面流程注册了应用,凭据也无处粘贴。下面的步骤保留作为 v2 的预读参考。
>
> 钉钉适配代码 + sender 完整保留在 `platforms/dingtalk/` + `shared/report_delivery/dingtalk_sender.py`,v2 解锁的是 `setup.sh` 交互式凭据采集 + 双 robot 配置自动化。

1. 访问 [open-dev.dingtalk.com](https://open-dev.dingtalk.com/) → 选择企业 → **应用开发 → 钉钉应用**
2. **创建应用**:类型选 **企业内部应用 - H5 微应用**(不要选"自定义机器人 - webhook 模式" —— 那是单向的,bot 收不到回复)
3. 在应用详情页:
   - **凭证与基础信息** → 复制 **AppKey** / **AppSecret**(⏳ v2 才开放:届时在手动创建的钉钉 Secret 里填;v1 `setup.sh` 不采集任何 IM 凭据)
   - **应用能力 → 机器人** → 启用 → 配置消息接收模式:**Stream 模式**
   - **权限管理** → 至少添加:`Robot 接收消息` / `Robot 主动发送消息` / `IM 群消息读写`
4. **发布应用**(企业内可见即可,不用上架到企业生态市场)
5. 把机器人**加进目标群**:在群里 → 群设置 → 群机器人 → 添加机器人 → 选刚发布的应用
6. **(可选,Phase 2a 起需要)如果你想让 Lambda 把调查报告 / 主动观察 push 事件推回钉钉群**:再加一个**自定义机器人**,与上面的 H5-app 机器人**共存**:
   - 在目标群:**群设置 → 群机器人 → 添加机器人 → 自定义**
   - 安全设置选 **加签**(推荐)— 复制生成的 secret
   - 复制 webhook URL + (推荐)加签 secret,部署时 `./setup.sh` 会问你这两个值,直接粘贴即可(⏳ v2 才开放;v2 会写进手动创建的钉钉 Secret)
   - 跳过这一步的后果:Phase 1 对话 / 调查派发依旧可用,**但调查结束后报告不会回贴到钉钉群**,客户需要去 Operator Home 主动查
   - 为什么需要两个机器人:钉钉把入站和出站分到两个机器人类:**H5-app Stream Mode 机器人**收消息回消息(用每条消息自带的 session_webhook),**自定义机器人**接收来自 AWS Lambda 的服务端推送(用它独立的 webhook URL)。两者都加进同一个群,从用户视角看就是一个 bot

> 钉钉机器人**不需要任何公网入站**,跟飞书 / Slack 一样:Stream Mode 是 bot ECS 主动出站长连接,IT 安全友好。

---

## 4. 配置项与 IM 凭据

CDK 部署不需要 `bootstrap.env` —— `./setup.sh` 第一次跑会**交互式**问你部署参数(账号 / region / 是否 PHD / 选不选 IM 平台)。**注意:`setup.sh` 不采集任何 IM 凭据** —— CDK 只创建**空的** IM Secret,部署完成后你再填(见 §4.2)。

### 4.1 你会被 setup.sh 问到的项

| 类别 | 项 | 说明 |
|---|---|---|
| **AWS Profile** | 部署用 Profile | 从本地 `~/.aws` 的 profile 列表里选,或保持当前 |
| **AWS** | Account ID | `aws sts get-caller-identity` 自动检测,确认即可 |
| | Region | 6 个选项(`ap-northeast-1`【默认】/ `us-east-1` / `us-west-2` / `eu-west-1` / `ap-southeast-1` / 自定义输入),DevOps Agent 服务侧能力以 `us-east-1` 为准,其余栈任选 |
| **Push (PHD)** | 是否部署 PHD 事件转发 | 默认 `Y` 部署;`--phd` 标志走 linked account 侧转发 |
| **Multi-account** | 业务账号白名单 | `--multi-account` 标志单独走;默认单账号 |
| **IM 平台**(可选,默认跳过) | 选项 | `0` 暂不部署(默认,只上 web 端)/ `1` 飞书 / `2` Slack(可多选)。**只设 `enabledPlatforms` 开关,不问凭据** |

> **Agent Space id 不是交互项** —— CDK 自动新建 `notiops-devops-<account>`(见 §5.3.4),你无需提供。

### 4.2 IM 凭据存哪 / 什么时候填

`setup.sh` 部署时,CDK 会**创建空的** IM Secret;凭据在**部署完成后**填,两种方式(脚本结尾横幅也会提示):
- **填法一(推荐)**:登录 Web Chat(admin) → 左侧「更多 → 巡检 & 报告」打开控制台 →「设置 → 通知设置」填入
- **填法二**:直接更新下表的 Secret,再强制重启对应 ECS 服务加载新凭据:
  `aws ecs update-service --cluster <BotStack-cluster> --service <service> --force-new-deployment`

CDK 栈始终通过 ARN 引用这些 secret,**本地不落任何凭据文件**。

| Secret 名(自动建,初始为空) | 用途 |
|---|---|
| `notiops/im-bot-feishu` | 飞书机器人凭证(单个 Secret,JSON:`app_id` / `app_secret` / `verification_token` / `encrypt_key` / `notify_chat_ids`) |
| `notiops/slack-bot-token` | Slack bot token(`xoxb-`) |
| `notiops/slack-app-token` | Slack app-level token(`xapp-`,Socket Mode) |
| `notiops/bedrock-api-key` | Bedrock API Key(跨账号模型调用认证;部署后手动填充,留空则走 IAM) |
| `notiops/litellm-config` | LiteLLM 凭据(JSON:`base_url` / `api_key` / `default_model`;用 LiteLLM 才需要) |

> 钉钉 Secret(`notiops/dingtalk-app-key` / `notiops/dingtalk-app-secret`)**不由 CDK 创建** —— bot-stack 引用但需手动 `create-secret`(⏳ v2 才走 `setup.sh` 自动采集)。**不存在 `bot-stack-*/` 前缀的 Secret,也不存在 `notiops/devops-agent-config`**(Agent Space id 等元数据走 DDB onboard 记录 + CDK context,不落 Secret)。

### 4.3 可选 override(改默认行为)

直接编辑 `infra/cdk.json` 或在执行 `cdk deploy` 时 `-c` 传 context:

| Context | 默认 | 说明 |
|---|---|---|
| `bedrockModelId` | `us.anthropic.claude-sonnet-4-6` | LLM 推理 profile |
| `agenticChatMode` | `enabled` | `disabled` / `qa_only` / `enabled` |
| `awsMcpMode` | `docs_only` | `disabled` / `docs_only` |
| `enableMcpPricing` | `true` | Pricing MCP sidecar 总开关 |
| `defaultLocale` | `en` | `zh` / `en` |
| `defaultLlmProvider` | `claude` | `claude` / `nova` / `gpt` |
| `allowedOrigins` | (空 = 所有来源) | CORS 可信域名白名单,逗号分隔,如 `https://d123.cloudfront.net` |

> **⚠️ CORS 收窄(生产建议)**：REST API 与 Web Chat Function URL 的每个端点都已由
> Cognito / AWS_IAM(SigV4)鉴权,浏览器 CORS 不是主要信任边界;因此**默认回退到
> 所有来源**(`*`),以便示例仓库无需预知部署期才生成的 CloudFront 域名即可开箱可用。
> 生产部署应显式收窄:`cdk deploy ... -c allowedOrigins=https://<你的前端域名>`。
> 未传时,`cdk synth`/`deploy` 会打印一条告警提示你收窄——这是纵深防御的推荐做法,
> 不影响功能。

---

## 5. 一键部署 `setup.sh`

```bash
./setup.sh
```

走完前置准备(§2;想启用 IM 才需 §3 注册 IM 应用)后,这一行命令就够了。

### 5.1 setup.sh 都做了什么

1. 依赖检查:`node` ≥ 22 / `npm` / `npx cdk` / `aws` / `jq` / `python3`。**容器构建工具(`finch` 或 `docker`)是可选的** —— 只有你选了要部署 IM 平台时才强制要求(IM bot 的 ECS 镜像本地构建);只上 web 端不需要
2. 让你从本地 `~/.aws` profile 列表选部署 Profile(或保持当前)
3. 调 `aws sts get-caller-identity` 检测账号,要你确认
4. 让你从 6 个选项里选 deploy region(默认 `ap-northeast-1`;含"自定义输入")
5. (可选)问是否部署 PHD 事件转发功能(默认 `Y`)
6. 让你选要部署哪些 IM 平台(**默认 `0` 暂不部署,只上 web 端**;`1` 飞书 / `2` Slack 可多选)。**只设 `enabledPlatforms` 开关,不采集凭据**
7. **`[1/4]` 构建前端** —— admin 控制台(`frontend/frontend-app`)**和** Web Chat 前端(`frontend/chat-app`)都构建
8. **部署 Web Chat Agent** —— 跑 `scripts/deploy_agent.sh`,把 Strands agent 部署到 AgentCore Runtime,拿到 Runtime ARN(经 `-c agentRuntimeArn` 注入 WebChatStack;`SKIP_AGENT=true` 可跳过,BFF 回退 echo)
9. **`[2/4]` 安装 Lambda 依赖**(boto3 / powertools / jinja2,`--platform manylinux2014_x86_64` 装 Linux 二进制)
10. CDK bootstrap(如果该账号 + region 还没 bootstrap 过;已 bootstrap 且健康则复用)
11. **`[3/4]`** CDK synth → IAM 一致性检查 → **CDK deploy `--all`**(`NotiOpsBackendStack` + `BotStack` + **`WebChatStack`**;选了 IM 时才触发 Docker build 把 bot 镜像 push 到 ECR)
12. **CUR + Athena FinOps 数据源**引导(检测 / 复用 / 新建,详见 §13)
13. **创建 Cognito `admin` 用户 + 临时密码**(首次部署),并把它加进 admin 组
14. **`[4/4]`** 把 outputs 写到 `cdk-outputs.json`,并打印**以 Web Chat 为主入口**的完成横幅(Web Chat 地址 + `admin` 登录凭据在最上方)

总耗时:首次 ~10-15 分钟(主要在 CDK deploy + agent 部署;选了 IM 再加镜像 build)。重跑只补差异 ~3-5 分钟。

### 5.2 单独流程(不需要全量 deploy 时)

| 任务 | 命令 |
|---|---|
| 部署 PHD 跨账号转发 stack(linked account 上跑) | `./setup.sh --phd` |
| 删除上面的 PHD stack | `./setup.sh --phd --remove` |
| 配置多账号白名单(让 bot 跨账号调查) | `./setup.sh --multi-account` |

直接用 CDK 命令的常用场景:

```bash
cd infra

# 改了 cdk.json context 后只 redeploy(不 rebuild 镜像)
npx cdk deploy --all

# 单独 redeploy 一个栈
npx cdk deploy NotiOpsBackendStack
npx cdk deploy BotStack

# Diff 看会变什么
npx cdk diff --all
```

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
| **跨账号 onboarding**(调查别的业务账号资源) | ✅ 影响 | 业务账号需要部署 `notiops-agent-trigger-<account_id>` IAM role + 在 NotiOps 这边的 DDB 注册业务账号(用 `./setup.sh --multi-account` 或控制台「账户接入」页) |
| **AWS 原生服务 ReadOnly**(EC2 / RDS / Lambda / CloudWatch 等) | ❌ 不影响 | `AIDevOpsAgentAccessPolicy` 已自动授权,开箱即用 |

#### 5.3.3 推荐的最小验证流程

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

#### 5.3.4 为什么不复用你已有的 space

CDK 模板默认 `CfnAgentSpace` 是 **CREATE 一个新的**,理由:

- ✅ **零配置**:新部署的客户 `setup.sh` 一跑,Agent Space + Trigger Role + Association 全自动 wire 好
- ❌ **副作用**:已有 space 的客户需要在新 space 里重做配置(本节)

后续规划里有一项 "支持复用已有 Agent Space" 的能力,会让 `setup.sh` 交互式问"你已有 Agent Space 想复用吗?"。当前版本 **不支持**。

---

## 6. 冒烟测试

> 💡 **怎么找你这次部署出来的实际资源名**:
> ```bash
> # ECS cluster / service
> aws ecs list-clusters --region $AWS_REGION
> aws ecs list-services --cluster <cluster-arn> --region $AWS_REGION
>
> # CloudWatch log group(以 /ecs/ 或 /aws/lambda/ 开头)
> aws logs describe-log-groups --region $AWS_REGION \
>   --query 'logGroups[?contains(logGroupName, `bot`) || contains(logGroupName, `notiops`)].logGroupName'
>
> # CloudFormation stack outputs(也写到了 cdk-outputs.json)
> cat infra/cdk-outputs.json
> ```
> 下文示例命令里的 `<cluster>` / `<service>` / `<log-group>` 都是占位符,替换成上面查到的真名即可。

部署完成后立刻验:

### 6.0 Web Chat 控制台(主入口 —— 先验这个)

> Web Chat 是产品主入口,默认部署;这是**最重要的一步**。IM(§6.1-6.3)只在你启用了对应平台时才需要验。

1. 浏览器打开脚本结尾横幅打印的 **Web Chat 地址**(也可 `jq -r '.WebChatStack.ChatUrl' infra/cdk-outputs.json`)
2. 用 `admin` / 脚本打印的临时密码登录(首次登录需改密码)
3. 左侧导航能看到:通知 / 调查 / FinOps / 案例 / Skills / 更多
4. 发一句问答或调查请求(例:"帮我调查 IAD 的 EC2"),几秒内有响应即成功

更完整的 Web Chat 冒烟见 §12.6。

### 6.1 ECS task 跑起来了(仅当启用了 IM)

> §6.1-6.3 **只在你启用了 IM 平台(飞书 / Slack)时适用**。只上 web 端时 BotStack 的 bot `desiredCount=0`,以下命令会显示 `0 0`,属正常。


```bash
aws ecs describe-services --region $AWS_REGION \
  --cluster <cluster> \
  --services <service> \
  --query 'services[0].deployments[0].[runningCount,desiredCount,rolloutState]' \
  --output text
# 期望:1   1   COMPLETED
```

### 6.2 长连接 / Socket Mode 已建立

```bash
aws logs tail <log-group> --region $AWS_REGION --since 5m | \
  grep -E "Lark connected|Bolt app is running"
```

### 6.3 端到端

在群里 @ bot:
```
@NotiOps 帮我列出 IAD 所有 EC2
```

期望:
1. 几秒内出 **🚀 启动调查** 编辑卡片(三个输入框 + 💡 LLM 维度提示)
2. 点 **🚀 派发调查** → 卡片更新成 **✅ 已派发,⏳ 调查启动中**
3. 几秒后 **🔭 调查已开始** 卡片 + 进度更新
4. 1-3 分钟后 **📝 Report Summary** + **✅ Report** 头部卡到达原群

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

> **Push 模式** = AWS 服务事件自动触发调查,bot 推送结果到群。**默认 Push 模式 lambda 部署后不发卡片**(`PushTargetChatId` 留空),需要显式打开。

### 7.1 启用 push(把 chat ID 填进去)

`setup.sh` **不问** push target chat id(它只问是否部署 PHD 事件转发功能)。要开 push,部署后设置目标 chat id:

```bash
# 编辑 infra/cdk.json,把 pushTargetChatIds.<platform> 设成对应的 chat id
$EDITOR infra/cdk.json
cd infra && npx cdk deploy NotiOpsBackendStack
```

> 飞书还可把目标群写进 Secret `notiops/im-bot-feishu` 的 `notify_chat_ids`,或在 Web Chat admin「通知设置」里配。

### 7.2 调整 push 事件源

6 个独立开关,**默认 3 个开 / 3 个关**:

| 参数 | 默认 | 说明 |
|---|---|---|
| `EnableCloudWatchAlarmPush` | ✅ `true` | CloudWatch alarm 状态变 ALARM |
| `EnableHealthPush` | ✅ `true` | AWS Health 事件 |
| `EnableBackupPush` | ✅ `true` | Backup job FAILED / EXPIRED / ABORTED |
| `EnableGuardDutyPush` | `false` | GuardDuty finding(severity ≥ `GuardDutyMinSeverity`,默认 7) |
| `EnableCostAnomalyPush` | `false` | Cost Anomaly Detection(需先建 monitor) |
| `EnableTrustedAdvisorPush` | `false` | TA ERROR-status 变更(需 Business+ Support) |

改 `infra/cdk.json` 里对应的 boolean,然后:

```bash
# 例:打开 GuardDuty + 阈值 8
# infra/cdk.json:
#   "enableGuardDutyPush": true,
#   "guardDutyMinSeverity": 8
cd infra && npx cdk deploy NotiOpsBackendStack

# 例:关掉 Health 推送
# infra/cdk.json: "enableHealthPush": false
cd infra && npx cdk deploy NotiOpsBackendStack
```

### 7.3 完全静默(不发卡片但仍记录事件)

把 `pushTargetChatIds` 全部设成空字符串:

```bash
# infra/cdk.json:
#   "pushTargetChatIds": { "feishu": "", "slack": "" }
cd infra && npx cdk deploy NotiOpsBackendStack
# Lambda 收到事件 short-circuit 不发卡;EventBridge rule 仍存在,日志可观察事件量
```

### 7.4 测试 push

```bash
aws events put-events --region $AWS_REGION --entries '[{
  "Source": "aws.cloudwatch",
  "DetailType": "CloudWatch Alarm State Change",
  "Detail": "{\"alarmName\":\"deploy-test\",\"state\":{\"value\":\"ALARM\",\"reason\":\"smoke test\"}}"
}]'
# 期望:几秒内群里收到 ⚠️ 主动观察 卡片
```

---

## 8. 日常运维

### 8.1 配置变更速查(无需 rebuild 镜像)

改 `infra/cdk.json` 里对应 context,跑 `npx cdk deploy` 单栈,~2 分钟生效(走 ECS rolling update,不重 build 镜像):

| 改什么 | 改哪个 context | 部哪个栈 |
|---|---|---|
| 切换 chitchat 模式 | `agenticChatMode` | `bot-stack` |
| 切换 MCP 模式 | `awsMcpMode` | `bot-stack` |
| 改默认语言 | `defaultLocale` | `bot-stack` |
| 改 chat_id 白名单 | `allowedChatIds`(JSON 数组) | `bot-stack` |
| 改默认 LLM | `defaultLlmProvider` | `bot-stack` |
| 开关单个 push 事件源 | `enable*Push` 系列 | `notiops` |

### 8.2 部署新代码

```bash
git pull
./setup.sh            # 重新 build 镜像 + cdk deploy --all
```

`setup.sh` 在重跑时会跳过已经存在 + 不变的资源,只更新差异部分。

### 8.3 强制重启 task(不改任何配置)

```bash
aws ecs update-service --region $AWS_REGION \
  --cluster <cluster> \
  --service <service> \
  --force-new-deployment
```

资源真名查法见 §6 顶部提示。

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

---

## 9. 回滚策略

| 级别 | 操作 | 影响 |
|---|---|---|
| **L1 关闭单个功能** | 改 `infra/cdk.json`(如 `enableHealthPush: false`)→ `cdk deploy NotiOpsBackendStack` | 单个事件源,~2 分钟 |
| **L2 关闭整个对话档位** | 改 `agenticChatMode: "disabled"` → `cdk deploy BotStack` | chitchat / general_qa 路径 |
| **L3 回到上一个镜像** | `cdk deploy BotStack`(CDK 会用上次 build 的 ECR digest 触发滚动)| 单平台,~2 分钟 |
| **L4 关闭整个 bot** | `aws ecs update-service --desired-count 0 ...` | 单平台,瞬时 |
| **L5 删栈** | `cd infra && npx cdk destroy <stack-name>` | 整个 stack |

> ⚠️ 删栈会清掉 ECR / IAM / SG / ECS 相关资源。**DDB 表和 S3 报告 bucket 不会被自动删**(`removalPolicy: RETAIN`),需要手动清理。本项目所有 AWS 资源默认带 `auto-delete=no` 标签,避免被自动清理任务误删。

---

## 10. Top 5 部署常见错误

| 现象 | 可能原因 | 排查 / 修 |
|---|---|---|
| **Secrets Manager 报 access denied** —— CDK deploy 建空 Secret 时,或事后填 IM 凭据时 | 部署用户缺 Secrets Manager 权限 | `aws iam attach-user-policy --policy-arn arn:aws:iam::aws:policy/SecretsManagerReadWrite` |
| **CDK deploy 报 `CannotPullContainerError`** | 主 app 镜像 build 失败 / ECR 没 push 完整 | `cd infra && npx cdk deploy BotStack` 重跑(CDK Asset 会重新 build + push)|
| **bot 不响应 @ — ECS 日志显示 `auth failed`** | IM 凭据错 / Secret 内容错 | `aws secretsmanager get-secret-value --secret-id <name>` 比对凭据原值,改对了重跑 `setup.sh` |
| **bot 派发成功但报告不回群** | report-handler Lambda 没拿到 IM 凭据 | 检查 Lambda 环境变量里的 Secret ARN 与 Bot Stack 是否一致;重跑 `cdk deploy NotiOpsBackendStack` |
| **`Bedrock InvokeModel` AccessDeniedException** | task role 缺权限 / region 没 enable model | IAM 加 `bedrock-runtime:InvokeModel`,或 Bedrock 控制台 → Model access |

---

## 11. 完整 CDK Context 参考

所有可调参数在 `infra/cdk.json` 的 `context` 块。改完后 `cd infra && npx cdk deploy <stack>`。

### 11.1 BotStack(IM bot 平台栈)

| context key | 默认 | 说明 |
|---|---|---|
| `bedrockModelId` | `us.anthropic.claude-sonnet-4-6` | Bedrock 推理 profile |
| `bedrockRegion` | (deploy region) | Bedrock 调用 region(可与运行 region 不同) |
| `agenticChatMode` | `enabled` | `disabled` / `qa_only` / `enabled` |
| `defaultLlmProvider` | `claude` | 默认 LLM 别名:`claude` / `nova` / `gpt`。任何用户可在群里 `@bot model <alias>` 切换(无 admin 控制)。详见 [USER_GUIDE.md §7](USER_GUIDE.md#7-模型选择切换-llm) |
| `gptRegion` | `us-east-2` | 当 `gpt` 别名生效时,Bedrock Mantle Responses 端点所在 region(可选 `us-east-2` / `us-west-2` / `us-gov-west-1`) |
| `awsMcpMode` | `docs_only` | `disabled` / `docs_only` |
| `enableMcpPricing` | `true` | Pricing MCP sidecar |
| `defaultLocale` | `en` | `zh` / `en` resolver 兜底语言 |
| `allowedChatIds` | `[]` | chat_id 白名单(空数组 = 不限制) |
| `enabledPlatforms` | `feishu` | 启用的 IM 平台(逗号分隔,如 `feishu,slack`)。未列出的平台 ECS Service `desiredCount=0`,不启动 |

### 11.2 NotiOpsBackendStack(共享后端 + push)

| context key | 默认 | 说明 |
|---|---|---|
| `agentSpaceId` | (自动) | DevOps Agent space id。**无需手动提供** —— CDK 自动新建 `notiops-devops-<account>`(见 §5.3.4);此 context 仅供高级覆盖 |
| `devOpsAgentRegion` | `us-east-1` | DevOps Agent 服务所在 region(用于 IAM Resource ARN),目前只有 `us-east-1` |
| `pushTargetChatIds` | `{}` | 每平台一个 chat id,留空 = Lambda short-circuit 不发卡 |
| `enableCloudWatchAlarmPush` | `true` | CloudWatch alarm |
| `enableHealthPush` | `true` | AWS Health |
| `enableBackupPush` | `true` | Backup |
| `enableGuardDutyPush` | `false` | GuardDuty |
| `guardDutyMinSeverity` | `7` | severity 阈值 |
| `enableCostAnomalyPush` | `false` | Cost Anomaly |
| `enableTrustedAdvisorPush` | `false` | Trusted Advisor |
| `reportUrlExpirationSeconds` | `604800` | 预签 URL TTL(7 天) |

> 报告 bucket 自动创建(命名 `notiops-report-${AccountId}-${Region}`,私有 + KMS 加密,无需配置)。

---

## 12. Web Chat 部署

> **Web Chat** 是 NotiOps 的浏览器端 agentic AI 助手,与上文的 IM bot **相互独立**:你可以只部署 IM bot、只部署 Web Chat,或两者都部署。Web Chat 复用 notiops 的 Cognito user pool 做鉴权,并复用共享后端(config 表、`core/push_event` 归一化、DevOps Agent)。

### 12.1 Web Chat 架构

| 组件 | 说明 |
|---|---|
| **Agent Runtime** | Bedrock AgentCore Runtime,承载 Strands agent(默认模型 Claude Sonnet 4.6)。由 `scripts/deploy_agent.sh` 以 CodeZip 方式部署,产出一个 **Runtime ARN** |
| **BFF Lambda** | Node 20 Lambda(`notiops-web-chat-bff`),挂 **Function URL**(`AuthType=AWS_IAM`),以 **SSE 流式**响应前端;调 Agent Runtime,并直接处理确定性操作(建案 `/actions/execute`、`/support/services` 目录等) |
| **前端** | React / Vite 单页应用,静态托管 |
| **鉴权** | Cognito(复用 notiops 的 user pool)+ Identity Pool,前端拿临时凭据对 Function URL 做 **SigV4** 签名 |
| **数据** | CDK `WebChatStack` 建 DDB 单表 `notiops-web-chat`(会话/消息 + 持久化通知收件箱 `notif#` 段,90 天 TTL,账号级共享) |

数据面全程沿用后端的**严格只读**约束(三层防御),Web Chat 不放宽这些限制。

### 12.2 部署顺序

Web Chat 分两步,由 `setup.sh` 编排,也可手动:

```
scripts/deploy_agent.sh    # 1) agentcore deploy CodeZip → 打印 Agent Runtime ARN
        │
        ▼  (把 ARN 传给 CDK)
cd infra && npx cdk deploy WebChatStack -c agentRuntimeArn=<上一步的 ARN>
```

1. **`scripts/deploy_agent.sh`** —— 用 `agentcore deploy` 把 agent 打成 **CodeZip** 上传,创建 / 更新 AgentCore Runtime,输出 **Runtime ARN**。
2. **CDK `WebChatStack`** —— 用 `-c agentRuntimeArn=<ARN>` 注入上一步的 ARN,建 BFF Lambda + Function URL + DDB 表 + 通知 handler。
3. **前端 `config.json`** —— 部署后把 BFF Function URL 等写进前端(见 §12.4)。

### 12.3 关键环境变量(BFF Lambda / handler)

| env | 说明 |
|---|---|
| `WEB_CHAT_TABLE` | DDB 单表名(`notiops-web-chat`),会话 / 消息 / 通知收件箱共用 |
| `AGENT_RUNTIME_ARN` | `deploy_agent.sh` 产出的 AgentCore Runtime ARN(经 `-c agentRuntimeArn` 注入) |
| `SKILLS_BUCKET` | Skills 存储 S3 bucket(`skills/` 前缀,与 IM 端共享) |
| `DEVOPS_AGENT_SPACE_ID` | DevOps Agent Space id(深度调查用) |
| `REPORTS_CDN_DOMAIN` | 在线报告 CloudFront 域名(HTML 报告落 S3,CloudFront 7 天;presigned URL 12h 兜底) |
| `CONFIG_TABLE` | notiops 的 config 表(`notiops-config`),复用其配置 / 通知源开关 |
| `NOTIOPS_CROSS_ACCOUNT_ROLE` | 跨账号只读角色名(v1 默认锁定部署账号) |
| `LOCKED_ACCOUNT_ID` | v1 锁定的部署账号 id(多账号选择器默认此账号) |

### 12.4 前端 config.json 注入项

前端构建产物需要一个 `config.json`(部署时注入,不硬编码):

| key | 来源 |
|---|---|
| `chatApiBase` | BFF Function URL(`WebChatStack` output) |
| `cognito` | 复用 notiops 的 user pool id / app client id / region |
| `identityPoolId` | Identity Pool id(签发临时凭据供 SigV4) |

### 12.5 通知事件源(持久化收件箱)

Web Chat「通知」主题的**持久化收件箱**由 EventBridge → `notiops-web-notif-handler`(复用 `core/push_event` 归一化,5 分钟去重)→ 写 `notiops-web-chat` 表 `notif#` 段。事件源开关:

- **默认开**(5 个,运维价值最高、噪音可控):AWS Health / CloudWatch Alarm / Cost Anomaly / Trusted Advisor / GuardDuty
- **默认关**(5 个,按需 `-c webNotif<Id>=on` 打开):Backup / EC2 Spot / Auto Scaling / RDS / Config
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
> 不需要就 `-c webNotifCostAnomaly=off -c webNotifTrustedAdvisor=off` 关掉,警告随之消失。

> 通知近实时,靠前端 **60s 轮询**(非 WebSocket,最长约 60s 延迟);左侧红点只统计**收件箱未读**。「通知」主题另有一块 **AWS Health Dashboard 实时视图**,由 BFF 实时查 Health API(不落库),需 **Business+ / Enterprise Support** 计划;无该计划时优雅降级为控制台链接,且 Health 未处理数**不叠进**红点。

### 12.6 冒烟测试

> **登录凭据从哪来**:首次部署时 `setup.sh` 会创建一个 Cognito `admin` 用户并打印**临时密码**(部署完成横幅里 `👤 登录: admin / <临时密码>`),这是进入 Web 控制台的入口账号。首次登录需改密码。若横幅没显示密码,说明 admin 用户已存在(密码未变更)。

```
1. 浏览器打开 Web Chat 前端 URL → 用 admin / 临时密码 Cognito 登录(首次改密码)
2. 左侧导航能看到:通知 / 调查 / FinOps / 案例 / Skills / 更多
3. 发一句调查请求(如"帮我调查 IAD 的 EC2"):
   → 主聊天出现「查看调查过程」入口,右侧「调查过程」停靠面板实时增长
   → 结束后主聊天给 root cause 结论 + HTML 在线报告链接
4. 建案:进「案例」主题,用可编辑卡片选服务 / 类别 / 案例类型 → 预览 → 确认
   (执行走确定性 /actions/execute,不经 LLM)
```

> **FinOps Agent 深度分析:即将上线,当前置灰禁用**。「调查」和「FinOps」两个主题都显示 DevOps Agent 开关(FinOps 里默认关、调查里默认开);FinOps Agent 深度分析开关目前**置灰不可用**,提示"即将上线",冒烟测试时不要指望它工作。

### 12.7 常见坑

| 现象 | 原因 / 修 |
|---|---|
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
  │     └─ 有 → 询问复用还是新建；无 → 直接新建
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
2. 无记录 → 用 `cur:describe-report-definitions` 检测账号是否已有符合条件(Hourly + Resource IDs)的既有 CUR
   - 有 → 提示用户选择:**0) 新建专用**(默认,官方推荐) / **1) 复用既有**
   - 无 → 直接新建
3. 复用路径(选 1):**同步 invoke `lambda6_cur_finalizer`**(数据已就绪 → 动态发现/建 Athena 表 → 写 `READY`，无需等 24h)
4. 新建路径:创建 S3 桶(含 CUR 服务写入的桶策略)→ `cur put-report-definition` → 写 DDB `PENDING` → `scheduler create-schedule`(一次性,`action-after-completion=DELETE`)

### 13.3 涉及的新增 AWS 资源

| 资源 | 用途 |
|---|---|
| S3 桶 `notiops-cur-<account_id>-<region>` | CUR 报告专用交付桶(Parquet 格式) |
| CUR ReportDefinition `notiops-cur-report` | Hourly + Resource IDs + Athena 集成 |
| Lambda `notiops-cur-finalizer`(`lambda6_cur_finalizer`) | 一次性:检测模板交付、部署 Athena 集成 CFN 栈 |
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

执行 `setup.sh` 的 IAM 身份需要额外具备:`cur:PutReportDefinition` / `cur:DescribeReportDefinitions`、`s3:CreateBucket`、`scheduler:CreateSchedule`、`iam:PassRole`(传给 `notiops-cur-finalizer-scheduler-role`);以及配置 Athena FinOps 保存查询所需的 `athena:GetWorkGroup` / `athena:UpdateWorkGroup`(给 primary workgroup 设结果输出位置)+ `athena:ListNamedQueries` / `athena:BatchGetNamedQuery` / `athena:CreateNamedQuery`。CDK 部署的 `notiops-cur-finalizer-role`(见 §13.3)与 Web Chat BFF role(含查 CUR 所需的 `athena:*Query*` + `athena:ListNamedQueries`/`BatchGetNamedQuery`/`GetNamedQuery`(Cost Deep Dive 取保存查询)、`glue:Get*`、CUR 桶只读,结果桶的 `s3:GetBucketLocation` + `s3:GetObject`/`s3:PutObject`(`GetObject` 供 Deep Dive CSV 下载重签);Cost Deep Dive 的 AI 洞察需 `bedrock:InvokeModel`(Claude Sonnet 推理档),当天结果缓存需 `dynamodb:PutItem`(`notiops-config` 表)——缺 `GetBucketLocation` 时 Athena 会报 "Unable to verify/create the output bucket")无需手动授权。

CUR 就绪后(复用既有 CUR 时几分钟内),`setup.sh` 自动:① 给 primary workgroup 设结果输出位置(`s3://notiops-data-<account>-<region>/athena-results/`,已有则不覆盖)② 用【动态发现的库/表名】幂等创建 **6 条** Athena 保存查询——`NotiOps - DevOps Agent Usage & Credit`(与仪表盘 credit 卡同口径)、`NotiOps - EDP Commitment Attainment`(改 `params` 里年度承诺额 + 合同起止即可直接跑),以及 4 条 **Cost Deep Dive** 明细查询:`CloudWatch cost by usage type` / `Data Transfer by service` / `EC2 cost by instance type` / `S3 cost by storage class`(供仪表盘"成本深挖"卡按需运行)。仪表盘 Commitments & Programs 卡的"在 Athena 查看 SQL"链接即指向这里;Cost Deep Dive 各场景的 SQL 也从这些保存查询取(单一真源,可在 Athena 控制台直接改),BFF 跑完后把真实结果行交给 Bedrock 出图表+洞察,并把当天结果缓存到 `notiops-config` 表(同一天再点只重签 CSV 下载链接,不重复跑 SQL/调 AI)。
