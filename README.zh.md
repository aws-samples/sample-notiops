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
即可发起调查,并直接在告警落地的地方读报告。除了即时提问,它还能对六类 AWS 信号源
做**主动推送**(CloudWatch、AWS Health、Backup、GuardDuty、成本异常、Trusted Advisor)。

所有模型都通过 **Amazon Bedrock** 接入(托管的安全、合规与成本管控),可按会话切换
模型,并自动做中英文本地化。**只读承诺**由三层防线(入站过滤 → 系统提示 → 出站审计)
强制保障:助手只读取、只推理,绝不改动你的云环境 —— 因此可放心交给 on-call 工程师
使用,而无需授予写权限。

---

## 快速链接

| 文档 | 用途 |
|---|---|
| 🛠 [部署指南](docs/DEPLOYMENT.md) | 从 `./setup.sh` 到首次冒烟测试的分步指南(Web 控制台 + 可选 IM) |
| 👤 [用户指南](docs/USER_GUIDE.md) | 终端用户手册 + 对话示例 + FAQ |
| 🏗 [技术设计](docs/TECHNICAL_DESIGN.md) | 模块边界 / 数据流 / 安全 / 三层防线 |
| 🧑‍💻 [贡献指南](CONTRIBUTING.md) | 约定(i18n / 安全 / PR 流程) |

---

## 功能

- 🖥️ **网页控制台(只读)**:浏览器聊天应用,支持事件调查、成本 / FinOps 分析、
  资源健康巡检、AWS Support 工单管理 —— 大白话进,带引用的答案出
- 🔍 **即时调查**:一句话提问,拿到完整报告(markdown 摘要 + HTML + trace)——
  内部测试中通常约 1-3 分钟(随问题复杂度、账号规模与模型而变)
- 🛎️ **主动观测**:6 类 EventBridge 信号源(CloudWatch / Health / Backup /
  GuardDuty / Cost / Trusted Advisor),可独立开关
- 📋 **完整 AWS Support 工单管理**:创建 / 列表 / 查看 / 回复 /
  **智能分析**(对工单会话做 LLM 归纳) / 解决
- 💬 **AWS 概念问答**:Bedrock + Knowledge MCP 检索官方文档,答案带 📚 来源引用
- 🤖 **多模型切换**:按会话保存模型偏好,全部通过 **Amazon Bedrock** 接入
  (托管的安全、合规与成本管控)
- 🌍 **双语**:中 / 英自动识别 + 显式切换
- 🛡 **只读承诺**:三层防线(入站正则 / 系统提示 / 出站审计)—— 助手绝不改动你的云
- 💬 **IM 渠道**:Slack / 飞书 全功能

---

## 快速开始

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

### 部署模式:单账号(默认) vs 多账号

在跑 `setup.sh` 前先定 —— 模式在部署时写死,之后切换需要重新部署。

- **单账号(默认)** —— `./setup.sh`。NotiOps 只在部署账号内运行。最小权限、
  最快跑通,适合绝大多数试用与单账号用户。
- **多账号** —— `./setup.sh --multi-account`。在 AWS Organizations 内增加跨成员
  账号的巡检 / 调查 / 事件转发。在**组织管理账号**,或已注册为
  **CloudFormation StackSets 委派管理员**的成员账号上运行即可(**不必**是管理
  账号)。成员账号资源经 StackSets 自动下发。

完整的部署到你自己 AWS 账号的步骤(含模式对比与如何切换)见
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | ECS Fargate(IM 机器人)+ AWS Lambda(report / push handler + notiops Lambdas) |
| 状态 | DynamoDB(单表多前缀)+ S3(报告,短 TTL) |
| LLM | Amazon Bedrock —— 按会话切换,按模型限制输出 token |
| MCP | AWS Knowledge MCP(托管)+ Pricing / Cost MCP |
| IM SDK | `lark-oapi`(飞书)+ `slack_bolt`(Slack) |
| IaC | AWS CDK |
| 容器 | Docker(linux/amd64,兼容 Fargate) |

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
        AWS 调查              EventBridge × 6
        (via STS AssumeRole)  (CloudWatch / Health / Backup /
                               GuardDuty / Cost Anomaly / TA)
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
