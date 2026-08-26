# NotiOps — 使用指南

> 🌐 **Language**: [中文](USER_GUIDE.md) · [English](USER_GUIDE.en.md)
>
> **目标读者**:使用 NotiOps 的 SRE / DevOps 工程师 / 应用开发者。**主入口是浏览器里的 Web Chat 网页控制台**;飞书 / Slack 等 IM 是必要但**次要的补充入口**。
>
> **读完之后你能**:在网页版 Web Chat 控制台里高效查看告警通知、调查 AWS 资源、做成本咨询、管理 AWS Support case、问 AWS 概念问题、调用自建 Skills;并在飞书 / Slack 里用 bot 完成同类调查与告警配合。
>
> **入口**:**Web Chat 网页控制台为主入口**(见 §12)。IM 端 v1 支持飞书 / Slack 作为补充;钉钉适配代码已在仓库,但凭据双 robot 配置流程在 v2 开放,v1 不向客户暴露(`setup.sh` 不显示)。

**版本**:v1.3 · 2026-06-10(case_analyze 智能分析 + Pricing/Cost MCP 默认部署;主入口为 Web Chat 网页控制台,IM 补充支持飞书 / Slack)

> 💡 **从这里开始**:NotiOps 的**主入口是网页版 Web Chat 控制台**——在浏览器登录后,即可用自然语言完成通知查看、故障调查、成本咨询、Support 建案与自建 Skills 调用。本指南 §1–§11 以 IM(飞书 / Slack)交互为主线讲解各项能力,这些能力在 Web Chat 里同样可用、体验更集中;完整的 Web Chat 操作说明见 **§12**。

---

## 目录

1. [bot 是什么 / 不是什么](#1-bot-是什么--不是什么)
2. [入门:第一次 @ bot](#2-入门第一次--bot)
3. [核心场景一:调查 AWS 资源](#3-核心场景一调查-aws-资源)
4. [核心场景二:AWS Support case 管理](#4-核心场景二aws-support-case-管理)
5. [核心场景三:问 AWS 概念 / 文档](#5-核心场景三问-aws-概念--文档)
6. [被动场景:收到主动告警卡片](#6-被动场景收到主动告警卡片)
7. [模型选择(切换 LLM)](#7-模型选择切换-llm)
8. [语言偏好(中 / 英切换)](#8-语言偏好中--英切换)
9. [常见疑问 FAQ](#9-常见疑问-faq)
10. [对话用语样例库](#10-对话用语样例库)
11. [反馈与求助](#11-反馈与求助)
12. [NotiOps Web Chat(网页版 AI 助手)](#12-notiops-web-chat网页版-ai-助手)

---

## 1. bot 是什么 / 不是什么

### bot 能做什么 ✅

| 类别 | 能力 | 用法 |
|---|---|---|
| **调查 AWS 资源** | 分析 CloudWatch 指标 / 日志 / 资源配置,找异常根因 | `@bot RDS my-db CPU 100% 怎么回事` |
| **管理 Support case** | 创建 / 列出 / 查看 / 回复 / **智能分析** / 关闭 AWS Support case | `@bot 帮我开个 case 处理 RDS 故障` / `@bot 分析 case 12345` |
| **回答 AWS 概念问题** | 引用 AWS 官方文档解释概念、最佳实践、API 用法 | `@bot ALB 和 NLB 有什么区别` |
| **主动观察告警** | CloudWatch / Health / Backup / GuardDuty / Cost / TA 6 类事件源,自动派发调查 | (无需操作,告警自动触发)|
| **多 LLM 切换** | 在管理员启用的模型之间任意切换(默认 **Grok 4.6**,另有 Claude Sonnet 5 / Opus 5 / Haiku 4.5、Amazon Nova Pro、DeepSeek V3.2、GPT-5.6 系列;均经 Amazon Bedrock 访问),per-chat / per-DM 记忆偏好 | `@bot model nova` / `@bot model claude` / `@bot model list` |
| **语言切换** | 中 / 英文切换,记住你的偏好 | `language zh` / `language en` / `请帮我切换到英文` |

### bot 不会做什么 ❌

> 这是产品级硬规则,**不是档位可调项**。

- ❌ **修改你的 AWS 环境**:不会重启 EC2、不会删 S3 对象、不会改 IAM 策略 —— 任何变更类请求都会被拒绝
- ❌ **替你执行 CLI 命令**:你问 "重启 i-0123",bot 会拒绝;你问 "怎么重启 i-0123",bot 会教你怎么做(教程视为只读)
- ❌ **绕过 IAM**:你能调查的资源 = AWS DevOps Agent 角色能读的资源,bot 不会替你越权
- ❌ **存储敏感信息超过 7 天**:聊天历史 DDB TTL 7 天自动清理,locale 偏好 90 天

> 想了解为什么 bot 这么"保守"? 见 [TECHNICAL_DESIGN.md §4.2 三层防御](TECHNICAL_DESIGN.md#42-通用对话--三层防御-bedrock_chat)。

---

## 2. 入门:第一次 @ bot

### 2.1 在群里 @

确保 bot 已经被加进群(管理员负责),然后:

```
@NotiOps 你好
```

bot 通常 1-2 秒内回复一句寒暄,告诉你它能帮什么。这是验证连通性的最简方式。

### 2.2 在私聊(DM)里直接说

如果你只是想自己用,**不需要 @**,直接发消息:

```
你好
```

bot 在 DM 里默认收所有消息(不需要 @ 触发)。

### 2.3 第一次发消息时的"自动语言锁定"

bot 会自动检测你的第一条消息语言,然后**锁定到那个语言**:

- 飞书:DM 锁定 30 天 / 群 thread 锁定 7 天
- Slack:同上

后续你发短消息(`why?` / `继续`)不会因为是英文就突然把整轮调查切到英文 —— **第一条消息决定整轮的语言**。

> 想手动换语言?见 §8。

---

## 3. 核心场景一:调查 AWS 资源

### 3.1 标准调查流程

直接 @ bot 描述问题:

```
@NotiOps 帮我看下 IAD 的 i-0abc123def456 为什么 CPU 这么高
```

bot 会:

1. **解析意图**(后台 1 秒内,`intent_classify` 日志)
2. **直接出"启动调查"卡片**(包含编辑表单)
3. 你可以保留默认值直接点 **🚀 派发调查**,或者改写后再点
4. 派发后,**🔭 调查已开始** 卡片出现,带 deep link 按钮
5. 每 20 秒进度卡更新一次(显示 DevOps Agent 正在调用什么 tool / 当前在思考什么)
6. 通常约 1-3 分钟后(基于内部测试,随查询复杂度/账号规模/模型而变),完整调查报告(👉 markdown 摘要 + HTML 报告 + trace)推到群里

### 3.2 启动调查卡片详解

```
📝 启动调查
─────────────────────
调查内容 *
[ 你的原始问题(LLM 复述后的版本) ]

调查起点 (可选)
[ 比如告警名 / log group / metric / 任何起点 ]

💡 DevOps Agent 通常需要这些维度才能精确定位问题:
  - AWS 账号 ID
  - Region
  - 资源 ARN 或名称

📋 日志 / 错误片段 (可选)
[ 粘贴相关日志 / 错误信息 / JSON ]

[ 🚀 派发调查 ]   [ ❌ 取消 ]
```

**填写策略**:
- **快查**:全部留空,直接点 **🚀 派发调查**
- **更精确**:把 LLM 没问到但你已经有的信息写在 **调查起点**,DevOps Agent 会更快定位
- **复杂问题**:把日志贴在 **日志/错误片段**,bot 会自动用代码块包裹,Agent 解析更顺

### 3.3 进度卡片详解

```
🔭 调查中 · 已用时 45 秒
─────────────────────
💭 当前思路
正在分析 i-0abc123def456 的 CloudWatch 指标过去 1 小时数据,
看 CPUUtilization 是否有异常 spike...

🔧 最近调用
- describe_instances(i-0abc123def456)
- get_metric_statistics(CPUUtilization, 60s)
- describe_log_streams(/aws/ec2/...)

[ 🔬 查看本次调查 ]  [ 🌐 Operator 主页 ]
```

进度卡每 20 秒更新一次,直到 Agent 完成。

### 3.4 报告卡片详解

```
✅ NotiOps Report · COMPLETED
─────────────────────
📝 Report Summary

# i-0abc123def456 CPU 异常分析

## 现象
- 过去 1 小时 CPU 持续 95%+
- 时间窗口:14:30-15:30 UTC
- 主要进程:nginx + php-fpm

## 根因
应用层 CPU bound,nginx 配置 worker_connections=1024 不够用,
导致大量请求排队。

## 建议
1. 把 worker_processes 改成 auto
2. 增加 nginx worker_connections 到 4096
3. 考虑横向扩展(ASG min=2)

[ 📄 查看完整报告 ]   [ 🔬 Trace ]   [ 📋 后续步骤 ]
```

**报告卡片底部有 next-step 建议按钮**,例如 "调查相关 ALB" / "查看 RDS 慢查询",一键派发新一轮调查 —— 会复用本群上下文,新调查报告也回到本群。

### 3.5 调查类样例

| 你想问 | 推荐说法 |
|---|---|
| 某个 EC2 CPU 高 | `i-0abc123def456 在 ap-east-1, 最近 1 小时 CPU 100%` |
| RDS 慢查询 | `RDS my-db 慢查询多, 看下原因` |
| Lambda 报错 | `lambda function-foo 大量 error, 看 cloudwatch logs` |
| ALB 5xx 升高 | `ALB my-alb 503 持续报错 30 分钟` |
| S3 bucket 突然变大 | `s3://my-bucket 上周空间从 100GB 涨到 1TB, 查异常` |
| EKS pod CrashLoop | `eks 集群 prod-cluster pod xyz 一直 CrashLoopBackOff` |
| 跨服务依赖 | `从 ALB 到 EKS 到 RDS 全链路 timeout, 帮我串一下` |

> 💡 **提示**:**带具体资源 ID / region 的提问** = bot 不会问澄清问题,直接进调查。**模糊提问** = bot 可能会在编辑表单的提示里建议你补维度。

---

## 4. 核心场景二:AWS Support case 管理

bot 不仅会调查,还能帮你**管理 AWS Support case**(创建 / 查看 / 回复 / 关闭),省掉每次切控制台。

### 4.1 创建 case

```
@NotiOps 创建一个 case 处理 RDS my-db 频繁重启
```

bot 会出**创建 case 卡片**(飞书 modal / Slack modal),你可以填:

| 字段 | 说明 |
|---|---|
| **Subject** | bot 自动用 LLM 总结的标题(可改) |
| **Body** | 详细描述(可粘贴原始日志) |
| **Severity** | Low / Normal / High / Urgent / Critical |
| **Language** | English / Japanese / Chinese 等(case 在 AWS Support 里的对话语言) |
| **Contact** | 可选,联系方式 |

填完点 **创建** ,bot 会调 AWS Support API 创 case,完成后给你 case ID(`12345...`)。

> 🔥 **创建 + 直接派发调查**:卡片底部有 **创建 + 派发调查** 按钮,会先创 case,再以"调查这个 case 的根因"的角度自动派发一次 DevOps Agent 调查。等于一次操作完成 "提单 + 启动自查"。

### 4.2 列出我的 case

```
@bot 我的 case
@bot 列出我的 case
@bot 需要我处理的 case   # 自动过滤 status=pending_customer
@bot 未解决的 case        # 自动过滤 status≠resolved
@bot AWS 在处理的 case    # 自动过滤 status=work_in_progress
@bot 已解决的 case        # 自动过滤 status=resolved
```

bot 会列出最近的 N 条,带状态、severity、最后回复时间,点 case ID 可展开。

### 4.3 查看某个 case

```
@bot case 177968247000414
@bot 查看 case 177968247000414
@bot 12345 怎么样了
```

bot 返回 case 详情 + 最新回复历史。

### 4.4 给 case 加回复

```
@bot 回复 case 177968247000414 已经把 RDS 升到 r5.large 不再重启
@bot reply 12345 fixed by upgrading instance class
```

> 必须有 case ID,否则 bot 会让你先选一个。

### 4.5 让 bot 智能分析 case(LLM 复盘 + 下一步建议)

需要让 LLM 通读 case 全部交流并给出"现在该怎么办":

```
@bot 分析 case 177968247000414
@bot 总结 case 12345
@bot 复盘 case 12345
@bot 帮我看 case 12345 是什么原因
@bot case 12345 应该回什么
@bot summarize case 12345
@bot analyze case 12345
@bot what's wrong with case 12345
```

bot 会先发"正在分析 case xxx…"提示,5-15 秒后返回**紫色智能分析卡片**,包含 6 个 section:

| Section | 内容 |
|---|---|
| 📝 **现状摘要** | 一句话症状定性 |
| 🔍 **根因推断** | 根据 case 已有信息的最佳判断,证据不足时会明确说"evidence insufficient" |
| 🛠 **AWS 工程师进展** | 工程师当前进展评估(已经回了什么 / 在等什么) |
| ✅ **建议下一步** | 用户应该做的具体动作(优先级排序) |
| 📋 **应补充给 AWS 的信息** | 用户该向 AWS 提供哪些数据 / 日志 / 配置 |
| ✉️ **建议回复模板**(可选) | 一段 ≤300 字的回复草稿,用户可直接复制 |

底部 2 个按钮:**💬 回复 case** / **📋 查看完整 case**。

> ⚠️ **零变更承诺仍生效**:LLM 永远不会建议"删 / 停 / 改"这种变更命令。如果只能通过变更才能解决,bot 会让你**人工执行**,不会替你做。

### 4.6 关闭 case

```
@bot 关闭 case 177968247000414
@bot resolve 12345
@bot 12345 已解决
```

---

## 5. 核心场景三:问 AWS 概念 / 文档

> ⚠️ **前置**:本功能需要部署时 `AgenticChatMode=qa_only` 或 `enabled`(灰度档位,见 [TECHNICAL_DESIGN.md §4.2.7](TECHNICAL_DESIGN.md))。

### 5.1 怎么问

直接 @ bot 提问,bot 自动判断这是"概念问题"而不是"调查请求":

```
@bot ALB 和 NLB 有什么区别
@bot Lambda cold start 是什么意思
@bot CloudWatch alarm 的 evaluation period 是怎么算的
@bot 怎么给 IAM role 加 cross-account trust
```

### 5.2 回答样式

bot 调用 **AWS Knowledge MCP** 检索官方文档,然后用本群当前的对话模型(默认 **Grok 4.6**,见 §7)回答,**附带可验证的来源**:

```
ALB (Application Load Balancer) 工作在 OSI Layer 7,理解 HTTP/HTTPS 协议,
能基于 host / path / header 路由请求。NLB (Network Load Balancer) 工作在
Layer 4,只看 TCP/UDP,不解析应用层。

主要差异:
1. **协议**:ALB 解析 HTTP,NLB 不解析
2. **健康检查**:ALB 可以检查 path,NLB 只 TCP
3. **延迟**:NLB 更低(因为不解析)
4. **静态 IP**:NLB 支持,ALB 不支持
5. **WebSocket**:ALB 原生支持

📚 来源
- [Application Load Balancer overview](https://docs.aws.amazon.com/...)
- [Network Load Balancer overview](https://docs.aws.amazon.com/...)
- [Choose between ALB and NLB](https://docs.aws.amazon.com/...)

🔧 调用的 MCP 工具
- aws_docs_search("ALB vs NLB difference")
- aws_docs_read(...)

By Grok 4.6
```

**重点**:
- **"📚 来源"块** = 实际被 LLM 看过的 URL,不是凭空编的
- **"🔧 调用的 MCP 工具"** = 透明展示 LLM 用了哪些工具
- **"By Grok 4.6"**(署名跟随本群当前模型)= 标明这是模型生成的回答,不是固化的"标准答案"

### 5.3 概念问题样例

| 类别 | 样例 |
|---|---|
| **服务对比** | `ECS vs EKS 怎么选`、`SQS standard 和 FIFO 区别` |
| **API 用法** | `S3 multipart upload 最大可以多大`、`Lambda 并发限制怎么配` |
| **最佳实践** | `IAM role chaining 怎么避免`、`VPC peering 和 transit gateway 怎么选` |
| **错误解读** | `什么是 Throttling exception`、`UnauthorizedOperation 通常什么原因` |
| **配置选项** | `KMS multi-region key 是什么`、`RDS multi-AZ vs read replica` |

### 5.4 何时改派调查 vs 概念问答

bot 会**自动**判断:

| 你的话 | bot 判断 | 走哪个路径 |
|---|---|---|
| `什么是 ALB` | 概念问题 | general_qa(MCP 检索) |
| `查 ALB my-alb 的 5xx` | 调查请求 | investigate(派发 DevOps Agent) |
| `Lambda cold start 怎么解决` | 概念 + 最佳实践 | general_qa |
| `lambda foo cold start 严重, 帮我看下` | 调查 | investigate |

判断依据:**包含具体资源 ID / region / 时间窗口** → 调查;**纯概念 / how-to** → 问答。

---

## 6. 被动场景:收到主动告警卡片

### 6.1 告警自动调查的工作方式

如果你的 AWS 账号开启了 push 模式(管理员配置),bot 会监听 6 类事件:

| 事件源 | 触发条件 |
|---|---|
| CloudWatch Alarm | Alarm 状态变 ALARM |
| AWS Health | 出 issue / scheduled change / account notification |
| AWS Backup | Backup job FAILED / EXPIRED / ABORTED |
| GuardDuty | 新 finding(默认严重性 ≥ 7) |
| Cost Anomaly | 异常费用变化 |
| Trusted Advisor | check status 变 ERROR |

**事件触发后**:

1. push handler Lambda 收到 EventBridge 事件
2. 5 分钟去重(同一资源 5 分钟内只调查一次)
3. **自动派发** DevOps Agent 调查 — 调查请求文本由 bot 根据事件 normalize 生成
4. 群里收到 **⚠️ 主动观察:<事件简要>** 头部卡片
5. 跟手动调查一样的进度卡 → 报告卡片流程

### 6.2 告警卡片样例

```
⚠️ 主动观察 · CloudWatch Alarm
─────────────────────
告警名:high-cpu-prod-rds
状态:ALARM
原因:Threshold Crossed: 1 datapoint [98.5] > 85.0

DevOps Agent 已自动启动调查...
```

后续就和 §3 的报告卡一样。

### 6.3 静默期间

群里某个事件源太吵?管理员可以单独关闭:

```
# 关 GuardDuty(管理员侧,修改 CDK context 后重新部署)
# 编辑 infra/cdk.json 里的 "enableGuardDutyPush": false,然后:
./setup.sh
```

详细配置选项见 [DEPLOYMENT.md §7](DEPLOYMENT.md#7-开启--调整-push-模式)。

---

## 7. 模型选择(切换 LLM)

bot 支持的别名 = 管理员在模型目录里勾选的 IM 启用集(下表列出常用几个),任何用户都可以在群里 / DM 里**随时切换**(无 admin 控制);完整清单用 `@bot model list` 现场查:

| alias | 模型 | 说明 |
|---|---|---|
| `grok` | **Grok 4.6** | **默认值**(模型目录 `default_model`)。Bedrock Converse;⚠️ 不支持显式提示缓存,长会话的 input 成本比 Claude 高 |
| `claude` | **Claude Sonnet 5** | 内部测试中工具调用较稳、中英文都好;支持提示缓存 |
| `nova` | **Amazon Nova Pro** | Bedrock Converse,单价约为 Claude Sonnet 的 1/4(据 Bedrock 公开定价,截至 2026-07),中文够用,合规白名单常见 |
| `gpt` / `gpt_sol` / `gpt_luna` | **GPT-5.6** Terra / Sol / Luna(实验性)| 走 Bedrock Mantle Responses API,工具调用稳定性弱于上面两个,建议仅作尝鲜 |

> ⚠️ **GPT-5.6 当前为实验性档位**。GPT 在 tool-use 场景下偶发把 OpenAI 内部协议片段或低质 token 输出到回复中。bot 已经叠了三层硬防护(token 预算、JSON 错误回喂、输出审计),即便如此仍建议默认使用 `claude` 或 `nova`,把 GPT 当作"我想试试 Open AI 模型"的尝鲜选项。
>
> 注:所有模型均经 Amazon Bedrock 访问(托管的安全、合规监控与成本控制);本项目为示例代码(sample code),用于学习/参考,非生产就绪;正式使用前请按贵组织的安全、合规要求自行完成充分测试与加固。

### 7.1 命令一览

```
@bot model              # 查看本群 / 本 DM 当前模型
@bot model list         # 列出所有可用别名
@bot model nova         # 切到 Nova(整个群从此用 Nova)
@bot model claude       # 切到 Claude Sonnet 5
@bot model default      # 清除偏好,回到管理员设的 default_model(当前 Grok 4.6)
```

### 7.2 切换的范围

- 在**群里**发命令 → **整个群**之后都用这个模型(包括别人的提问)
- 在**私聊**发命令 → **只影响你的 DM**,不影响群

也就是说:某些群可以用 `claude`,对成本敏感的群可以用 `nova`,**同一个 bot 部署服务多个场景**。

### 7.3 切到 GPT 的注意事项(实验性)

GPT-5.6 走 **Bedrock Mantle Responses API**(OpenAI 兼容协议),跟 Claude / Nova / Grok 在 Bedrock InvokeModel / Converse 上不一样:

- **稳定性**:在 tool-use(派调查 / 概念问答)场景下,GPT-5.6 偶发会把 OpenAI 内部协议片段(`to=functions.<tool>`)或低质 token 写到回复里。bot 端已加三层硬防护拦截这种输出 —— 拦截后用户会看到 canned 兜底回复,而不是 garbage,但当下可见的"半灰"概率仍高于 Claude / Nova。**正式使用时优先 `claude` 或 `nova`**,GPT 仅作为尝鲜或对比档位。
- **跨 region 调用**:GPT-5.6 在 `us-east-2`(也支持 `us-west-2` / GovCloud-us-west)。bot 部署在 `us-east-1`,所以选 `gpt` 时会发起一次跨 region HTTPS 调用,延迟比 Claude / Nova 高 ~50ms,但不影响功能。
- **管理员可改 region**:CFN parameter `GptRegion` 默认 `us-east-2`,可改成 `us-west-2` 或 `us-gov-west-1`。
- **Reasoning effort**:GPT-5.x 有显式的"思考深度"档位,默认 `medium`,管理员可通过 `GPT_REASONING_EFFORT` env 改成 `low` / `high`。
- **延迟**:reasoning=high 时单次回复可能 10-30 秒;chitchat 路径推荐保持 `medium`。
- **工具调用**:跟 Claude / Nova 一样支持 MCP 工具(AWS Knowledge MCP / Pricing MCP / Cost MCP),协议自动翻译。

### 7.4 偏好的生效层级

```
1. 群级偏好(@bot model X 在群里)— 30 天 TTL
2. DM 级偏好(@bot model X 在 DM)— 30 天 TTL
3. 部署级默认(DEFAULT_LLM_PROVIDER env)
4. 兜底:claude
```

要永久切换全部群 / 部署默认 → 让管理员改 CFN parameter `DefaultLlmProvider` 重部一次。

---

## 8. 语言偏好(中 / 英切换)

### 8.1 三种触发方式

```
language        # 查看当前语言 + 简短帮助
language zh     # 切到中文(立即生效,90 天偏好)
language en     # 切到英文(立即生效)

请帮我切换到英文     # 自然语切换,等价 language en
切换到英文          # 同上
请用英文回复         # 同上
switch to chinese   # 等价 language zh
```

### 8.2 语言优先级链

bot 决定每条消息回什么语言时,**按这个顺序找答案**:

```
1. 你的显式偏好(language zh|en 或自然语切换设置过)
2. 当前调查锁(派发后,整轮调查锁定一种语言)
3. 当前 thread 锁(群里某条 @bot 之后开的话题)
4. 当前 DM 锁(私聊第一条消息检测后锁定)
5. 自动检测当前消息语言
6. 群组 / 工作区默认语言(管理员配置)
7. 兜底:英文
```

为什么这么复杂? 因为:
- 你不想群里跟同事讨论技术问题时, 一条 `why?` 突然把所有人切到英文
- 你不想刚切到英文,下次发"你好"又被检测成中文
- 你的偏好应该跨群、跨设备稳定

### 8.3 常见困惑

**问题**:我刚 `language zh`,但下条 bot 还是英文?

**原因**:可能是这条消息恰好在某个 thread 里,thread lock 优先级高于 user pref 之外的所有层。

**解决**:**user pref 是最高层**,会盖过所有 lock。如果 `language zh` 写入失败(看 ECS 日志),让管理员清下你的 `locale#user#<uid>` row。

---

## 9. 常见疑问 FAQ

### Q1: 我能让 bot 帮我重启某个 EC2 吗?

**不能**。bot 是 read-only,产品级硬规则,不可绕过。详见 [TECHNICAL_DESIGN.md §5 安全设计](TECHNICAL_DESIGN.md#5-安全设计)。

变通:**问 bot 怎么重启**(教程式),它会教你 CLI 命令,你 review 后自己执行。

### Q2: bot 怎么会知道我的 AWS 资源?

bot 自己**不直接读 AWS API**,所有调查都是派发给 **AWS DevOps Agent** 完成。Agent 用客户授权给它的角色读你的资源。bot 任务角色只有最小权限(发消息、调 Bedrock、写 DDB)。

### Q3: 我的聊天数据存多久?

| 类型 | TTL |
|---|---|
| 聊天事件 / 调查上下文 | 7 天 |
| 调查报告 HTML(S3) | 7 天(预签 URL 也 7 天) |
| 语言偏好 | 90 天 |
| DM 锁 | 30 天 |
| 群 thread 锁 | 7 天 |
| 调查锁 | 24 小时 |
| Push 事件去重 | 5 分钟 |

DDB TTL 自动清理,不需要人工干预。

### Q4: bot 突然不响应了,怎么办?

按 §11 流程让管理员排查。常见原因:
- ECS task 重启中(瞬时,等 30 秒)
- IM 凭据过期(管理员重新录入 Secrets Manager)
- Bedrock 限流(高峰期偶尔)

### Q5: 我能不能把 bot 加到非生产群?

可以,**强烈推荐先在测试群试用 1-2 周**。bot 默认全部 chat 都收,管理员可以用 `AllowedChatIds` 限白名单。

### Q6: bot 回的内容是模型生成的吗?会不会胡编?

- **调查报告**:DevOps Agent 真实读你的资源生成,有 trace.html 可查,不会编
- **概念问答**:Bedrock 上的对话模型(默认 Grok 4.6)+ AWS 官方文档检索(Knowledge MCP),回答附带 📚 来源 URL,可点击验证
- **意图判断 / 进度叙事**:LLM 生成,可能会有偏差,但不影响调查结果本身的真实性

如果 bot 给的概念回答跟你认知不符,**点 📚 来源 URL 自己看 AWS 官方文档**——这是 ground truth。

### Q7: AWS Support case 创建到 bot 这边会扣 Support 费吗?

不会,bot 只是调用你账号已有的 AWS Support API。case 本身不另外计费(Support plan 内的 case 数量都包含)。

### Q8: bot 在调查时,DevOps Agent 会不会跑出"非预期的"操作?

DevOps Agent 是 read-only 设计(用客户授权的角色,该角色应该只挂 ReadOnly policy)。bot 派发时也只传调查请求文本,**不传任何 mutating 指令**。

但**前提是**:你给 DevOps Agent 的 role 没有意外授予了写权限。建议运维定期 audit 这个 role。

---

## 9.5 钉钉(DingTalk)平台特别说明

bot 在飞书 / Slack 上完整可用的功能,在钉钉上**当前处于分阶段交付状态**。本节说清楚哪些已经能用,哪些还在路上。

### 9.5.1 当前可用(Phase 1)

| 功能 | 钉钉可用 |
|---|---|
| @ bot 触发(群)/ DM 直发 | ✅ |
| 调查派发(`查 i-xxx CPU` / `RDS my-db 慢` 等) | ✅ |
| 概念问答(`什么是 EKS` / `ALB 和 NLB 的区别`) | ✅ |
| 模型切换(`@bot model claude/nova/gpt`) | ✅ |
| 语言切换(`language zh/en` / 自然语) | ✅ |
| 调查报告 markdown 回贴 | ✅(需要操作员在群里加自定义机器人,见 [DEPLOYMENT.md §3.3](DEPLOYMENT.md) 第 6 步)|
| 零变更承诺(任何变更类请求都拒绝) | ✅ |

### 9.5.2 暂不可用(Phase 2 计划中)

| 功能 | 钉钉 | 飞书 / Slack |
|---|---|---|
| AWS Support case 创建 / 列表 / 回复 / 关闭 | ⏳ | ✅ |
| 进度卡(20s 实时更新调查状态) | ⏳ | ✅ |
| Skill 选择 / 切换 / 自助上传 | ⏳ | ✅ |
| Push 主动观察(CW Alarm / Health 等 6 类事件) | ⏳ | ✅ |
| Next-step 一键派发按钮 | ⏳ | ✅ |

碰到 Phase 2 功能时,钉钉端会回:`👷 这个意图(...)在钉钉端属于 Phase 2 计划,目前先用飞书或 Slack。`,**不会静默丢失**。

### 9.5.3 钉钉端结构性差异(永久,不是 Phase 问题)

钉钉的 IM 协议跟飞书 / Slack 有几个不可绕过的差异,即使 Phase 2 完成,也是这种形态:

- **没有原生 modal 表单**:飞书 / Slack 的"打开 case 表单填字段"在钉钉无等价物。Phase 2 的 case 创建 / skill 上传将走**对话式补全**:bot 会让你按顺序发消息("先发 Subject 一行,再发 Body 详细描述...")。少几下点击但功能一致。
- **没有 thread 子话题语义**:钉钉群里没有 Slack `thread_ts` 那种"在某条消息下开 thread"。本群一锁就是整个群,跟同事聊技术问题时短消息(`why?`)不会因为是英文就把整轮调查切语言 —— 跟 DM 单聊一样的语义。
- **每条 @ bot 消息都是给 bot 的**:钉钉机器人**默认收不到群里非 @ 自己的普通聊天**,所以 bot 不需要"判断是不是 @ 我了"——只要消息进来就是给它的。简化了交互,但也意味着无法做"thread 内追问免 @"(飞书 / Slack 有的)。

### 9.5.4 切换平台不丢偏好

`@bot model` 和 `language` 偏好按 `(平台, 群 ID)` / `(平台, user ID)` 隔离记录,**飞书的偏好不会带到钉钉,反之亦然**。同一个用户在飞书 DM 用 Claude,在钉钉群用 Nova,各自独立。

---

## 10. 对话用语样例库

### 10.1 中文样例

| 意图 | 推荐说法 |
|---|---|
| 你好 | `你好` / `早上好` / `在吗` |
| 看 EC2 状态 | `查 i-0abc123 的 CPU` |
| 看 RDS 性能 | `RDS my-db 慢查询多, 看下原因` |
| 看 Lambda 错误 | `lambda function-foo 大量 error` |
| 看 S3 异常 | `s3://my-bucket 上周空间暴涨, 查异常` |
| 看跨服务问题 | `从 ALB 到 EKS 到 RDS 全链路超时, 帮我串一下` |
| 创建 case | `创建一个 case 处理 RDS 故障` / `提一个工单` |
| 列出 case | `我的 case` / `未解决的 case` |
| 查 case | `case 177968247000414` |
| 回复 case | `回复 case 12345 已经修好` |
| 关闭 case | `关闭 case 12345` |
| 概念问题 | `ALB 和 NLB 有什么区别` / `什么是 KMS multi-region key` |
| 切语言 | `language en` / `请切换到英文` |

### 10.2 英文样例

| Intent | Recommended phrasing |
|---|---|
| Greeting | `hi` / `hello` / `good morning` |
| EC2 check | `check i-0abc123 CPU usage` |
| RDS performance | `RDS my-db has slow queries, please look` |
| Lambda errors | `lambda function-foo many errors` |
| S3 anomaly | `s3 my-bucket size spiked last week` |
| Cross-service | `ALB → EKS → RDS timeout, help me trace` |
| Create case | `open a case for RDS issue` / `file a ticket` |
| List cases | `my cases` / `unresolved cases` |
| View case | `case 177968247000414` |
| Reply to case | `reply to case 12345 — issue resolved` |
| Close case | `close case 12345` |
| Concept | `what's the difference between ALB and NLB` / `what is KMS multi-region key` |
| Switch language | `language zh` / `switch to chinese` |

---

## 11. 反馈与求助

### 11.1 反馈渠道

直接在群里 @ bot 提反馈:`@bot 我希望你能...`。bot 不会"理解"反馈本身(会判断为 chitchat),但**消息会进 ECS 日志,管理员定期 review 改进 prompt**。

### 11.2 求助路径

| 问题 | 找谁 |
|---|---|
| bot 没回我 | 内部群管理员 / IT 运维 |
| bot 回了但内容明显错 | 截图发 bot 群,管理员看 ECS 日志 |
| 调查报告打不开 | 检查 S3 预签 URL 是否过期(7 天)|
| 我没权限调查这个资源 | 这是 DevOps Agent role 的权限问题,不是 bot 的问题 |
| AWS Support case 创建失败 | 看 bot 返回的错误,大概率是 Support plan 限制或 severity 不允许 |

### 11.3 想了解更多?

- [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md) — 技术设计、模块边界、安全规则
- [DEPLOYMENT.md](DEPLOYMENT.md) — 部署手册(运维同事用)

---

## 12. NotiOps Web Chat(网页版 AI 助手)

除了飞书 / Slack 里的 bot,NotiOps 还提供一个**网页版的 agentic AI 助手 —— Web Chat**。它在浏览器里打开,登录后即可用自然语言完成告警通知查看、故障调查、成本咨询、Support 案例创建与自建 Skills 调用。本节讲清楚**怎么操作、会看到什么**。

> Web Chat 与 IM 端是两套并行的入口,共用后端的只读安全约束(严格只读、三层防御沿用后端)。它不是替代 IM bot,而是一个更适合"坐下来专注调查/建案"的网页工作台。

### 12.1 登录与整体布局

- **登录**:Web Chat 走 Cognito 登录(复用 notiops 用户池)。打开管理员发给你的网址,用你的账号登录即可。
- **左侧导航(主题)**:按顺序是 **通知(Notifications) / 调查(Investigate) / FinOps / 案例(Cases) / Skills / 更多(More)**。点某个主题即进入对应对话场景。
- **默认模型**:新对话默认使用 **Grok 4.6**(具体默认值由管理员在「管理 → 模型」页设定)。
- **右侧 Sources / 调查过程面板**:展示工具调用、出处透传,以及调查主题下的"调查过程"实时面板(见 §12.3)。

顶部/工具区可用的开关:**多账号选择器**、**多模型切换**、**联网搜索开关**(见 §12.7)。

### 12.2 通知(Notifications)主题:Health Dashboard + 收件箱红点

通知主题分**两块**,分别回答"AWS 现在有没有影响我的事件"和"过去发生过哪些事件":

**(A) AWS Health Dashboard 实时视图**
- 进入通知主题即实时查询 AWS Health API(**不落库**,每次现查),分区展示:
  - **服务运行状况**(PUBLIC issue,区域级/服务级公共事件)
  - **您的账户运行状况**(与你账户相关的 issue + 计划的更改)
  - 以及其他通知 / 事件日志 / 状态历史,配控制台链接可跳转查看详情
- **前置条件**:实时 Health 视图需要 **Business+ / Enterprise Support 计划**。若你的账户不满足,会**优雅降级**为直接给出控制台链接(而不是报错)。

**(B) 持久化收件箱(红点来源)**
- 收件箱汇总来自多个事件源的通知(经 EventBridge 采集、5 分钟去重后写入):
  - **默认开启**:CloudWatch Alarm、AWS Health、AWS Backup
  - **默认关闭**(需管理员开启):GuardDuty、Cost Anomaly、Trusted Advisor、RDS、Config
- 通知在收件箱**保留约 90 天**(TTL),按账号级共享。
- **左侧红点** = 收件箱**未读数**,前端每 **60 秒轮询**一次刷新(注意:是轮询,不是实时 WebSocket 推送)。Health Dashboard 的未处理数**不计入**红点。
- **每张通知卡上的操作**:**深入调查**(把这条通知作为起点,转到调查主题发起 DevOps Agent 深度调查)/ **就此提问**(围绕这条通知继续对话)/ **控制台链接**(跳 AWS 控制台看原始事件)。

### 12.3 调查(Investigate)主题:实时过程面板 + 缓解跳后台 + 转人工

调查主题接入 **DevOps Agent 深度调查**,发起后**同步执行 + 实时流式**返回,你能"边看边等"。

**操作与你会看到什么:**
1. 描述你的问题(或从通知卡点"深入调查"带入起点),发起调查。
2. 调查的分析过程(Observation / Finding 等步骤)会实时出现在**右侧「调查过程」停靠面板**里(该面板复用 Sources 栏)。它**不会自动弹出**;主聊天里会给一个 **「查看调查过程」入口按钮**,点开即可看到面板**实时增长**的分析步骤。
3. **主聊天区**只保留**根因(root cause)结论** + **HTML 在线报告**链接(报告存 S3,经 CloudFront 有效期约 7 天,并有 presigned URL 约 12 小时兜底)。这样主对话干净,过程细节在侧面板。
4. 调查结论**末尾有两个按钮**:
   - **「去 DevOps Agent 后台生成缓解方案」** —— 打开 operator app 的深链(新标签页)。注意:后台是纯前端切 tab,**无法深链直达 Root cause 标签页**,所以打开后请**手动切到 Root cause 标签**继续生成缓解方案。
   - **「转人工支持」** —— 一键转向人工/建案路径。转人工建案时,主题按调查问题组织、正文按最佳实践包含背景 + 摘要 + 报告链接。

> Web Chat **忠实透传 DevOps Agent 的内容**,NotiOps 不对调查结论做二次 LLM 加工。

### 12.4 FinOps 主题

- FinOps 主题面向成本 / 用量类问题。
- **DevOps Agent 开关**现在在**调查**和 **FinOps** 两个主题都会显示(在 FinOps 里可用它做成本/用量的深度分析)。**进入 FinOps 时该开关默认关**(只有调查主题默认开)。
- ⚠️ **FinOps Agent 深度分析当前置灰禁用**:该功能尚未完善,界面会提示 **"即将上线"**。当前请不要把它当作已可用功能。

### 12.5 案例(Cases)主题:两种建案方式

Web Chat 提供**两条建案路径,客户二选一**。两种方式都走**确定性执行**(通过 BFF 的 `/actions/execute`,**不经 LLM**),并在真正建案前给你预览确认。

**(1) 可编辑「创建支持案例」卡片**
- 填一张结构化卡片,字段包括:
  - **服务**下拉:选项来自 AWS 真实服务目录(BFF `describe-services`,约 **328** 个服务),**类别随服务联动**。
  - **案例类型**:技术(technical)/ 账单和账户(customer-service)/ 提高服务限制(service-limit-increase)。
  - **严重级别**、**语言**(案例在 AWS Support 里的对话语言)。
- 流程:**填写 → 预览 → 确认**。
- **防非法组合**:如果模型建议的 `service_code` 不在真实目录里,前端会**按 token 匹配纠正或清空**,避免出现非法的服务/类别组合。

**(2) Markdown 模版建案**
- 你会拿到一份 markdown 模版,**填好后发回**。
- Agent 用 `create_case_from_template`,**基于真实服务目录确定性解析** service + category(不让模型自己编),生成一张**只读预览卡** → 你**确认后直接建案**。

> 两种方式都是"提议 → 确认 → 执行"的严谨流程,不会跳过确认直接建案。

### 12.6 Skills(自建技能)

- **Skills 是客户自建的技能**,在左侧有**一级导航入口**,也可通过 **"/" 命令菜单**在对话里调用。
- Skills 存放在 **S3 的 `skills/` 前缀**下(与 IM 端**共享**同一份存储)。
- 支持**版本历史 / 回滚 / zip 导入**,便于管理与复用。

### 12.7 多账号 / 多模型 / 联网搜索 / What's New / "/" 命令

- **多模型切换**:默认 **Grok 4.6**,另可选 **Claude Sonnet 5**、**Claude Opus 5**、**Claude Haiku 4.5**、**Amazon Nova Pro**、**DeepSeek V3.2**、**GPT-5.6(Terra / Sol / Luna)**(均经 Amazon Bedrock 访问,第三方模型非直连厂商 API;实际可选项 = 管理员勾的启用集)。**每会话记忆你的模型偏好**,**每条回复都会署名所用模型**。
- **多账号选择器**:默认使用**部署账号**,团队共享。⚠️ **v1 跨账号默认锁定在部署账号**(尚未开放任意切换到其他账号)。
- **联网搜索开关**:**默认关闭**,需要时手动打开,让助手参考公网信息。用的是 AWS 内建的 AgentCore Web Search(搜索请求不出 AWS)。⚠️ 这个能力**只在 `us-east-1` 提供**:部署在别的区域时开关照样能点,但搜不到东西 —— 这不是故障,问运维方确认部署区域即可。
- **What's New**:查看 AWS 新发布内容。
- **"/" 命令**:在输入框输入 `/` 会弹出命令菜单,可快速调用 Skills 等。
- **Sources 面板**:透传工具调用与出处,便于你核验助手的依据。
- **只读安全**:Web Chat 沿用后端的严格只读约束(三层防御),不会替你变更 AWS 环境。

### 12.8 使用须知(务必知晓)

- **FinOps Agent 深度分析暂禁用**,界面提示"即将上线",当前不可用。
- **v1 跨账号默认锁定部署账号**,暂不能自由切换到其他账号。
- **通知实时性靠 60 秒轮询**(非 WebSocket),红点可能有最多约 1 分钟延迟。
- **Health Dashboard 实时视图需 Business+ / Enterprise Support 计划**,否则降级为控制台链接。
