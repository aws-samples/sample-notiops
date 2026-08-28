# NotiOps

> 🌐 **语言**: [English](README.md) · [中文](README.zh.md)

> ⚠️ **免责声明**:本项目为示例代码,面向非生产用途。部署前请与你自己的安全、法务
> 团队一起,确保满足你所在组织的安全、监管与合规要求。本项目仅用于教学 / 参考目的,
> 并非生产就绪产品。

![NotiOps 网页控制台](docs/screenshot-web-zh.png)

**NotiOps** 是一套 AWS 示例代码,提供一个**只读的云运维控制台** —— 一个网页版聊天
应用:工程师用大白话询问自己的 AWS 环境,就能拿到近实时、带来源引用的回答:含根因
分析的事件调查、成本 / FinOps 分析、资源健康巡检,以及完整的 AWS Support 工单管理
—— 全程在网页里完成,无需切到 AWS 控制台。

同一个助手也能**接入团队已在用的聊天工具(Slack / 飞书)**:在告警群里 `@` 机器人
即可发起调查,并直接在告警落地的地方读报告。除了即时提问,它还能对 10 类 AWS 信号源
做**主动推送**(CloudWatch、AWS Health、Backup、GuardDuty、成本异常、Trusted Advisor、
EC2 Spot 中断预警、Auto Scaling 启动失败、RDS、Config),每类可独立开关。

所有模型都通过 **Amazon Bedrock** 接入(托管的安全、合规与成本管控),可按会话切换
模型,并自动做中英文本地化。**只读承诺**由三层防线(入站过滤 → 系统提示 → 出站审计)
强制保障:助手只读取、只推理,绝不改动你的云环境 —— 因此可放心交给 on-call 工程师
使用,而无需授予写权限。

---

## 快速链接

| 文档 | 用途 |
|---|---|
| 🚀 [一键部署](docs/DEPLOYMENT_ONECLICK.md) | 只要一个浏览器:上传一份 CloudFormation 模板,大约 5 分钟拿到 Web Chat(只含 Web Chat) |
| 🛠 [部署指南](docs/DEPLOYMENT.md) | 完整版:从 `./setup.sh` 到首次冒烟测试的分步指南(Web 控制台 + 可选 IM) |
| 👤 [用户指南](docs/USER_GUIDE.md) | 终端用户手册 + 对话示例 + FAQ |
| 🏗 [技术设计](docs/TECHNICAL_DESIGN.md) | 模块边界 / 数据流 / 安全 / 三层防线 |
| 🧑‍💻 [贡献指南](CONTRIBUTING.md) | 约定(i18n / 安全 / PR 流程) |

---

## 功能

- 🖥️ **网页控制台(只读)**:浏览器聊天应用,支持事件调查、成本 / FinOps 分析、
  资源健康巡检、AWS Support 工单管理 —— 大白话进,带引用的答案出
- 🔍 **即时调查**:一句话提问,拿到完整报告(markdown 摘要 + HTML + trace)——
  内部测试中通常约 1-3 分钟(随问题复杂度、账号规模与模型而变)
- 🤝 **两种"谁来回答"**:通用聊天开头可选**对话对象** —— NotiOps 自己的 agent(全局视角:巡检、
  调查、案例、知识库),或**你自己账号里的 AWS DevOps Agent 直答**(深入现场:实时排查)。
  选后者时 **NotiOps 侧 0 token**、**免模型配置**(不需要在 Bedrock 开通任何模型),流式输出
  体验与 DevOps Agent 自己的页面一致。调查主题另有 **深度调查(直连)**:同一个深度调查绕过
  大模型直连 API,同样不耗 token(代价:调查描述按你的原话透传,不做智能改写)
- 🛎️ **主动观测**:10 类 EventBridge 信号源(CloudWatch / Health / 成本异常 /
  Trusted Advisor / GuardDuty / Backup / EC2 Spot 中断预警 / Auto Scaling 启动失败 /
  RDS / Config),每类可独立开关 —— 其中 5 类默认开启
- 📋 **完整 AWS Support 工单管理**:创建 / 列表 / 查看 / 回复 /
  **智能分析**(对工单会话做 LLM 归纳) / 解决
- 💬 **AWS 概念问答**:Bedrock + Knowledge MCP 检索官方文档,答案带 📚 来源引用
- 🤖 **多模型切换**:由运维方管理的模型目录 —— 在 Admin 控制台里勾选本部署对外提供
  哪些模型、设默认模型、指定后端任务用哪个模型,改完即时生效无需重新部署;用户侧
  仍按会话保存自己的模型偏好。所有模型均通过 **Amazon Bedrock** 接入(托管的安全、
  合规与成本管控),凭证可用 IAM 或 Bedrock API Key
- 🌍 **双语**:中 / 英自动识别 + 显式切换
- 🛡 **只读承诺**:三层防线(入站正则 / 系统提示 / 出站审计)—— 助手绝不改动你的云
- 💬 **IM 渠道**:Slack / 飞书 全功能

---

## 快速开始

两种部署方式,选一种即可。

### 方式 A:一键部署 —— 只要一个浏览器

适合拿不到长期 access key,或不允许在本地装 CDK / 容器运行时的环境:全程在 AWS
控制台里完成,你自己的机器上什么都不用装。

1. 从 [Releases](https://github.com/aws-samples/sample-notiops/releases/latest)
   下载 `notiops-webchat.template.json`;
2. 打开 CloudFormation 控制台 → **Create stack** → **Upload a template file**;
3. 填管理员邮箱(临时密码会发到这个邮箱)、勾选 IAM 能力确认框、创建 —— 实测大约
   5 分钟完成,栈输出里就是 Web Chat 的访问地址。

开栈时有两个可选参数值得知道:**深度调查**(AWS DevOps Agent,默认开,闲置不计费,
区域不支持时自动跳过而不是让栈失败)与**部署模式**(默认单账号;选多账号并填组织 id,
就能跨组织内其它账号做只读排查 —— 需要从组织管理账号或 StackSets 委派管理员账号部署)。

⚠️ 一键部署**只部署 Web Chat**(前端 + BFF + agent),**不含** IM 机器人、定时巡检、
管理仪表盘与 CUR/Athena FinOps —— 要这些请用下面的方式 B。前提条件(区域与 Bedrock
模型开通)、参数逐条说明、资源与成本构成、升级 / 回滚、一键删除,见
[docs/DEPLOYMENT_ONECLICK.md](docs/DEPLOYMENT_ONECLICK.md)。

### 方式 B:`setup.sh` —— 完整版

```bash
# 1. 克隆
git clone https://github.com/aws-samples/sample-notiops.git
cd sample-notiops

# 2. 部署(CDK,一条命令;首次运行为交互式)
./setup.sh
# 首次运行:确认 AWS 账号 → 选区域 → 选 IM 平台(Slack / 飞书,可多选)→
# 逐个粘贴凭证(直接写入 Secrets Manager,绝不落盘)→ CDK bootstrap → synth →
# 容器构建 → cdk deploy --all。重复运行只增量更新。
```

需要本地有 git / Node.js / Python / AWS CDK / 一个容器运行时,以及一份能部署的 AWS 凭证。

#### 部署模式:单账号(默认) vs 多账号

在跑 `setup.sh` 前先定 —— 模式在部署时写死,之后切换需要重新部署。

- **单账号(默认)** —— `./setup.sh`。NotiOps 只在部署账号内运行。最小权限、
  最快跑通,适合绝大多数试用与单账号用户。
- **多账号** —— `./setup.sh --multi-account`。在 AWS Organizations 内增加跨成员
  账号的巡检 / 调查 / 事件转发。在**组织管理账号**,或已注册为
  **CloudFormation StackSets 委派管理员**的成员账号上运行即可(**不必**是管理
  账号)。成员账号资源经 StackSets 自动下发。

完整的部署到你自己 AWS 账号的步骤(含模式对比与如何切换)见
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

### 两种方式的功能对比

| 能力 | 方式 A(一键部署) | 方式 B(`setup.sh`) |
|---|:---:|:---:|
| **前提与耗时** | | |
| 本地要装的东西 | 无(只要浏览器) | git / Node / Python / **uv** / CDK / 容器运行时(仅 IM bot 需要) |
| 需要长期 access key | 不需要 | 需要一份能部署的凭证 |
| 部署耗时 | 大约 5 分钟 | 十几分钟(含本地构建) |
| 一键删除整个环境 | ✅ 删栈时选 `KeepData` / `DeleteEverything` | ✅ `./teardown.sh`(默认保数据 / `--delete-everything` 全删) |
| **聊天与调查** | | |
| 网页 Web Chat(只读问答) | ✅ | ✅ |
| AWS 概念问答(官方文档检索 + 引用) | ✅ | ✅ |
| 资源健康巡检(按需提问) | ✅ | ✅ |
| 故障调查(即时,只读工具) | ✅ | ✅ |
| DevOps Agent 深度调查 | ✅ 见下方注 ¹ | ✅ |
| 深度调查(直连,不耗 token) | ✅ 见下方注 ¹ | ✅ |
| DevOps 对话(通用聊天里让你自己的 DevOps Agent 直答) | ✅ 见下方注 ¹ | ✅ |
| 联网搜索(AgentCore Web Search) | ✅ 见下方注 ² | ✅ 见下方注 ² |
| **成本 / FinOps** | | |
| FinOps 仪表盘(Cost Explorer 口径) | ✅ 仅部署账号 | ✅ 可跨账号 |
| CUR + Athena 账单明细下钻 | ❌ | ✅ |
| **工单与 Skills** | | |
| AWS Support 工单全生命周期 | ✅ | ✅ |
| 11 个预置 Skill + 客户自建 | ✅ | ✅ |
| 把 Skill 发布到 DevOps Agent | ✅ 见下方注 ¹ | ✅ |
| **模型** | | |
| 多模型切换 + 模型目录管理 | ✅ | ✅ |
| 用 Bedrock API Key 作为凭证 | ✅ | ✅ |
| **主动化 / IM** | | |
| IM 渠道(Slack / 飞书) | ❌ | ✅ |
| 主动推送**到 IM**(10 类 EventBridge 信号源) | ❌ | ✅ |
| 每日自动巡检(闲置资源 / 成本异常) | ❌ | ✅ |
| 通知收件箱(同样这 10 类信号源,进 Web 收件箱) | ✅ | ✅ |
| 管理仪表盘(阈值 / 目标账户 / Skills 管理) | ❌ | ✅ |
| **范围** | | |
| 多账号(AWS Organizations 跨账号) | ✅ 开栈时选 `DeployMode=MultiAccount` + 填组织 id | ✅ `--multi-account` |
| 升级 | 换新版模板 update 栈(~1 分钟) | 重跑 `./setup.sh` |

> ¹ **所有 DevOps Agent 相关能力(深度调查、深度调查(直连)、DevOps 对话、把 Skill 发布到
> DevOps Agent)在方式 A 里依赖同一个 Agent Space**:
> 栈会在部署账号里建它,前提是参数 `EnableDeepInvestigation=Yes`(默认值)**且**部署区域
> 在 AWS DevOps Agent 已开服的区域内(`us-east-1` / `us-west-2` / `ca-central-1` /
> `sa-east-1` / `ap-south-1` / `ap-southeast-1` / `ap-southeast-2` / `ap-northeast-1` /
> `eu-central-1` / `eu-west-1` / `eu-west-2`)。别的区域照样开栈成功,只是没有 Agent Space
> —— 界面上相关开关会**置灰并写清原因**,栈输出 `DeepInvestigationStatus` 会说明是你自己
> 关的还是该区域不支持。

> ² **联网搜索只有 `us-east-1`,两条路径都一样。** 用的是 AWS 内建的 AgentCore Web
> Search(不需要任何第三方 API key,搜索请求不出 AWS),两种部署方式都会自动建好那个
> Gateway,你不用配任何东西。部署在别的区域照样成功,只是没有联网搜索 —— 方式 A 的栈
> 输出 `WebSearchStatus` 会写明原因,方式 B 的 `./setup.sh` 会在部署日志里说一句。
> 注意这个开关**不会置灰**(界面不做区域判断),点了不报错,只是搜不到东西。

> 📋 **AWS Support 相关功能(建案 / 查案 / 回复 / 解决)需要账号开通 Business、
> Enterprise On-Ramp 或 Enterprise 支持计划** —— 这是 AWS Support API 本身的要求,
> 与用哪种部署方式无关。Basic / Developer 计划下服务列表会是空的。

**两条路径可以先后走**:先用方式 A 试用,之后想要 IM 推送和自动巡检,再跑方式 B
(两边建的管理员用户名都是 `admin`,不会打架)。

### 升级到新版本 / 删除整个环境

两种方式的升级和卸载步骤**不一样**,请照着你实际用的那一种做。

#### 方式 A(一键部署)

**升级到新版本**(实测约 1 分钟):

1. 从 [Releases](https://github.com/aws-samples/sample-notiops/releases) 下新版本的
   `notiops-webchat.template.json`。
2. CloudFormation 控制台 → 选中你的栈 → **Update** → **Replace existing template** →
   上传刚下的模板。
3. 参数页**什么都不用改**,一路选 **Use existing value** → 下一步到底 → **Submit**。

升级**不会**动这些:不重发邀请邮件、管理员邮箱和密码不变、你在 Admin 里改过的配置不变、
聊天历史不清空。想回退就用**旧版本的模板**再 update 一次。

**删除整个环境** —— 栈有一个 `TeardownMode` 参数,两档:

| | 保留什么 |
|---|---|
| `KeepData`(默认) | 保留配置表、聊天记录表、数据桶(里面有你的 Skill 和报告) |
| `DeleteEverything` | 全删,不留东西 |

⚠️ **两个必须注意的点:**

1. **要删干净,顺序不能错** —— 先做一次 **Update**,把 `TeardownMode` 改成
   `DeleteEverything`(约 45 秒),**然后**再 **Delete stack**(约 3 分钟)。
   在删除对话框里改这个参数是**没有用的**:CloudFormation 用的是最后一次成功部署时的参数值。
   如果直接删,就是按 `KeepData` 删的。
2. **两种模式都会删掉 Cognito 用户池** —— `KeepData` 保的是**数据**,不是**账号**。
   重新装完之后,用户需要重新邀请。

删完之后可能还剩下(不产生费用,想清就手工删):`KeepData` 模式保下来的两张 DynamoDB 表和
数据桶;一个名字像 `/aws/vendedlogs/RUMService_<栈名>-web-chat<随机串>` 的日志组
(0 字节,30 天自动过期)。

#### 方式 B(`setup.sh`)

- **升级**:`git pull` 拉最新代码,**重跑 `./setup.sh`** —— 它是增量的,只更新有变化的部分。
  你之前填进 Secrets Manager 的 IM 凭据不会被覆盖。
- **删除**:跑仓库根目录的 **`./teardown.sh`**,它按依赖倒序把 `setup.sh` 建的东西删干净
  (含 CDK 之外的收尾:CUR 报告定义、一次性 EventBridge Scheduler、WebSearch Gateway、
  Secrets 的 30 天恢复期)。和方式 A 一样是两档语义:

  ```bash
  ./teardown.sh --dry-run          # 先看清单,什么都不删(强烈建议先跑这个)
  ./teardown.sh                    # 保数据:删栈与运行时,保留三张 RETAIN 表
  ./teardown.sh --delete-everything # 全删:连表、CUR 报告 / CUR 桶、Athena 保存查询、残留日志组
  ```

  删除需要输入 12 位账号号码确认(`--delete-everything` 还要再输一次 `DELETE EVERYTHING`)。
  ⚠️ 数据桶 `notiops-data-<账号>-<区域>` 在这条路径上是随栈删除的(Skill 与长报告都在里面),
  所以脚本**默认先把它同步到本地备份目录**,不想备份加 `--no-backup`。
  如果同一个账号+区域里**两种方式都装过**:两边用的是同一套资源名,所以脚本在清空桶 /
  删表前会先问 CloudFormation "这资源属于哪个栈",属于一键部署那个栈的会**自动跳过**
  (要删它请去删那个栈)。
  跨账号的东西脚本**故意不动**,只打印命令让你自己确认:成员账号的两个 StackSet
  (加 `--delete-member-stacksets` 才删)、以及各 linked 账号里的 PHD 转发栈
  (`./setup.sh --phd --remove`)。CDK bootstrap 相关资源(`CDKToolkit` 等)一律不碰。

---

## 架构(高层)

```
网页控制台(浏览器)          客户 IM(Slack / 飞书)
        │                            │
        └──────────────┬─────────────┘
                       ▼
        ┌──────────────────────────────────────┐
        │   NotiOps(本仓库)                    │
        │   · 意图分类                           │
        │   · 三层只读防线                       │
        │   · 工单管理 · 双语 i18n               │
        │   · MCP 文档检索 · Bedrock 路由        │
        │                 │                      │
        │                 ▼                      │
        │   Lambdas(collector / analyzer /      │
        │   health / notifier / cost)+ handlers │
        └──────┬────────────────────┬────────────┘
               ▼                    ▼
        AWS 调查              EventBridge × 10
        (via STS AssumeRole)  (CloudWatch / Health / Cost Anomaly / TA /
                               GuardDuty / Backup / EC2 Spot / ASG /
                               RDS / Config)
```

完整架构见
[docs/architecture-diagram.md](docs/architecture-diagram.md)。

---

## 贡献

请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。要点:

- **所有用户可见字符串必须双语**(中 + 英),经由 `core/i18n.py` 的
  `i18n.t(key, locale)` API —— CI 强制检查
- **不要绕过只读承诺**:助手是只读的;拒绝任何变更请求
- **提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)**

---

## 许可

本项目采用 MIT-0 许可。详见 [LICENSE](LICENSE) 文件。
