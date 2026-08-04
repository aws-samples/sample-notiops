---
name: cost-anomaly-detector
description: AWS 成本异常分诊器 V2.4 — 逐账号分析近 30 天摊销成本，基于多因子评分 + 周期性基线 + 账号体量感知动态识别真正值得关注的异常；支持置信度分级和预计继续影响估算；增强排查模块可选，默认关闭。
allowed_tools:
  - call_aws
  - use_aws
license: Apache-2.0
---

# AWS 成本异常分诊器 V2.4

## 概述

> 📋 **适用范围说明**：本规格描述的是**交互式 agent skill**（按需分诊，报告展示阈值 70）。
> 项目里的 **Lambda5 定时（cron）路径**复用同一套评分数学，但落库策略不同：它在阈值 **40**
> 持久化所有候选异常，并按 **≥80 高优先级 / ≥60 中优先级 / 其余观察项** 分类
> （见 `lambda5_cost_analyzer/handler.py` 的 `_ANOMALY_SCORE_THRESHOLD` 与 `_classify_anomaly_type`）。
> 评分公式两者一致，仅阈值/分级口径不同。

从 AWS Cost Explorer 拉取近 30 天的按服务维度的每日摊销成本数据，按账号分别分析服务成本变化，通过多因子评分框架动态识别真正值得关注的成本异常，并基于最合适的维度进行下钻，帮助客户快速定位"哪个账号、哪个服务、哪个使用类型或操作在驱动成本增长"。

本技能默认按"逐账号执行、最后汇总"的方式运行。
不依赖 AWS Organizations 管理账号视角，不依赖 Tag；适用于客户只能逐个账号提供访问凭证的场景。
优先使用跨账号 IAM Role + STS AssumeRole 获取临时凭证；若客户无法提供 Role，则允许使用该账号独立的 AK/SK。
增强排查模块（第 15 节）为可选功能，默认关闭。

**设计原则：** 本技能面向每日发送场景。没有异常就不展开，有异常才输出卡片。宁可漏报一个小波动，也不要用噪音消耗客户信任。

为进一步降低误报，本技能默认启用：
1. **周期性验证**：若发现近 30 天存在明显周周期或批处理周期，则优先与"相似日"比较，而非只与整体均值比较。
2. **候选池旁路**：除 Top 20 服务外，若某服务为"新增成本"或近 3 天绝对增量超过固定门槛，也必须纳入异常候选池，避免漏掉小而新的真实异常。
3. **置信度分级**：每个异常卡片必须输出高 / 中 / 低置信度。
4. **预计继续影响**：每个异常卡片必须估算"若当前速率持续 7 天，预计额外增加多少成本"。

## 执行目标

**账号 → 服务 → 主驱动维度 → 次驱动维度 → 建议动作**

在无 Tag 前提下，能够明确指出某个账号中的某个服务、某个 UsageType / InstanceType / Operation / Region 正在驱动成本增长。

## 输入要求

**必填输入：**

账号列表，每个账号至少包含：
- account_id
- account_name
- auth_type，取值为 `role` 或 `access_key`
- role_arn，当 auth_type=role 时必填
- external_id，可选
- access_key_id / secret_access_key / session_token，当 auth_type=access_key 时使用

**可选输入：**
- lag_days，默认 2
- window_days，默认 30（agent 可根据需要扩展到 60 或 90 天）
- top_n_services，默认 20
- top_n_drivers，默认 5
- min_service_daily_avg，默认 3 USD（日均低于此值的服务不参与常规异常检测）
- new_cost_candidate_3d_avg_threshold，默认 10 USD（Top 20 之外的新出现服务，若近 3 天日均超过该值，必须进入候选池）
- absolute_delta_candidate_threshold，默认 20 USD（Top 20 之外的服务，若近 3 天日均增量超过该值，必须进入候选池）
- currency，默认 USD
- anomaly_score_threshold，默认 70（满分 100，低于此分不报）
- investigation_mode，默认 `off`，可选值：`off` / `on_demand` / `auto`
- max_services_to_investigate_per_account，默认 3
- max_followup_calls_per_service，默认 5
- stop_on_permission_error，默认 `true`

## 前置检查

对每个账号执行分析前，先检查以下条件：

1. 该账号的 Cost Explorer 已启用。
2. 当前身份具备 Cost Explorer 查询权限。
3. 如果使用 Role 方式访问，则先调用 `sts assume-role` 获取临时凭证。

若任一条件不满足，则跳过该账号，并在结果中明确返回失败原因。

## 1. 确定日期范围

- 结束日期 = 今天往前推 lag_days 天。
- AWS Cost Explorer 时间区间规则：Start 包含当天，End 不包含当天，因此 API End = 结束日期 + 1 天。
- 开始日期 = 结束日期往前推 window_days 天。
- 若 agent 在分析中发现疑似周期性波动，可自动扩展到 60 天验证。

**为什么 lag_days 默认为 2（从前天开始查）：**
AWS Cost Explorer 的成本数据有 24~48 小时延迟。今天和昨天的数据通常不完整（金额偏低），如果纳入分析会导致误判（如把不完整的昨天数据当成"成本骤降"）。因此默认跳过最近 2 天，确保分析窗口内的每一天都是完整数据。

**用户询问"今天"或"昨天"成本时的处理：**
- 如实告知 Cost Explorer 数据有 24~48 小时延迟，今天和昨天的数据可能不完整。
- 如果用户坚持要看，可以将 lag_days 设为 0 查询，但必须在输出中标注"⚠️ 今天/昨天数据为部分日，金额可能偏低，不纳入趋势判断和异常评分"。

## 2. 一级查询：按服务获取每日摊销成本

对每个账号调用 `aws ce get-cost-and-usage`，查询近 30 天每日摊销成本。

固定参数：
- `--granularity DAILY`
- `--metrics AmortizedCost`
- `--group-by Type=DIMENSION,Key=SERVICE`
- `--filter` 使用统一的 RECORD_TYPE 排除规则

排除规则：
```json
{
  "Not": {
    "Dimensions": {
      "Key": "RECORD_TYPE",
      "Values": [
        "Credit",
        "Refund",
        "SavingsPlanNegation",
        "Discount",
        "BundledDiscount",
        "Enterprise Discount Program Discount"
      ]
    }
  }
}
```

说明：
- AmortizedCost 用于将 RI / Savings Plans 的预付费用分摊到受益期。
- 一级分组使用 SERVICE。
- 若返回结果包含 NextPageToken，则必须继续翻页直至取完全部数据。

**API 限流与退避策略：**
- Cost Explorer API 限流为每秒 5 次请求。多账号场景下（N 个账号 × 每账号 1 次一级查询 + M 次下钻查询），总调用量可能较高。
- 每次 CE API 调用之间至少间隔 200ms。
- 遇到 `LimitExceededException` 或 `ThrottlingException` 时，采用指数退避：首次等待 1 秒，之后每次翻倍，最多重试 3 次。
- 多账号执行时按顺序逐账号处理，不并发调用 CE API。
- 若单账号下钻查询超过 10 次，agent 应在该账号完成后额外等待 2 秒再处理下一个账号。

## 3. 汇总与基础统计

对一级查询结果，计算每个服务的：
- 30 天总计
- 30 天日均
- 30 天标准差
- 变异系数（CV = 标准差 / 日均）
- 近 7 天均值
- 近 3 天均值
- 近 3 天日均增量（= 近 3 天均值 - 基线日均）

同时计算账号级指标：
- 账号 30 天日均总成本

**周期性检测：**
- 若近 30 天中同星期几之间的偏差明显小于整体偏差，则判定该服务存在周周期。
- 若存在周周期，则优先使用"最近 4 个相同星期几的均值"作为比较基线。
- 若不存在明显周期性，则继续使用 30 天整体均值作为基线。

**候选池规则：**
- **常规候选池**：按 30 天总计降序取 Top 20 服务。
- **旁路候选池**：满足以下任一条件的服务，即使不在 Top 20，也必须纳入候选池：
  - 过去 23 天接近 $0，最近 7 天出现持续费用（新增成本）
  - 近 3 天日均 >= new_cost_candidate_3d_avg_threshold
  - 近 3 天日均增量 >= absolute_delta_candidate_threshold

## 4. 波动率分级

根据变异系数（CV）对每个服务自动分级：

| 波动率等级 | CV 范围 | 典型服务 | σ 倍数要求 |
|-----------|---------|---------|-----------|
| 极低波动 | < 2% | EBS 固定卷、RI 摊销、NAT GW Hours | 2σ |
| 低波动 | 2%~10% | EC2 Compute（稳定集群）、RDS | 2.5σ |
| 中波动 | 10%~25% | DataTransfer、S3 API、Lambda | 3σ |
| 高波动 | > 25% | Bedrock、Athena、Glue（按需任务型） | 3σ + 连续 2 天以上超阈值 |

## 5. 多因子异常评分

对候选池中日均 >= min_service_daily_avg 的服务，计算 anomaly_score（满分 100）。

### 5.1 评分因子

| 因子 | 权重 | 计算方式 | 说明 |
|------|------|---------|------|
| 统计偏离度 | 30% | 相对所选基线（整体均值或周期性基线）的偏离程度，映射到 0~100 分：<2σ=0, 2σ=40, 3σ=70, 4σ+=100 | 超出自身正常波动多少 |
| 账号影响力 | 30% | 近 3 天日均增量 / 账号日均总成本，映射到 0~100 分：<0.5%=0, 1%=30, 3%=60, 5%+=100 | 对客户总账单的影响 |
| 持续性 | 25% | 连续超出基线阈值的天数，映射到 0~100 分：1天=10, 2天=30, 3天=50, 5天=80, 7天=100 | 连续 1 天 vs 连续 5 天意义不同 |
| 加速度 | 15% | 近 3 天日环比增长是否递增，映射到 0~100 分：递减=0, 持平=30, 递增=70, 加速递增=100 | 增长是否在加速 |

### 5.2 评分公式

```
anomaly_score = 0.30 × 统计偏离度得分
             + 0.30 × 账号影响力得分
             + 0.25 × 持续性得分
             + 0.15 × 加速度得分
```

### 5.3 判定规则

| anomaly_score | 状态 | 处理 |
|---------------|------|------|
| >= 80 | 🔴 高优异常 | 必须下钻 + 输出卡片 |
| 60~79 | 🔶 中优异常 | 下钻 + 输出卡片 |
| 40~59 | 🟡 观察 | 仅在报告末尾简要提及，不展开 |
| < 40 | ✅ 正常 | 不输出 |

### 5.4 置信度规则

每个异常必须附带 confidence_level：
- **High**：满足以下至少 2 项 — 统计偏离显著（>=3σ）、账号影响力显著（>=1%）、下钻驱动项贡献 >= 60%
- **Medium**：满足以上任意 1 项，且有明确驱动项
- **Low**：仅检测到偏离，但驱动项分散、周期性不清晰或证据不足

Low 置信度异常默认不进入"优先处理列表"，仅在账号明细中简要展示。

### 5.5 预计继续影响

每个 anomaly_score >= 60 的服务，必须估算：
```
projected_7d_extra_cost = max(近 3 天均值 - 基线日均, 0) × 7
```

若 projected_7d_extra_cost < 20 USD，则即使评分偏高，也默认降一级处理，避免小额噪音。

### 5.6 特殊情况处理

- **新增成本**：过去 23 天日均接近 $0，最近 7 天突然出现持续费用 → 不适用标准差判定，标记为 🆕 新增成本，评分按以下规则动态计算：
  ```
  base_score = 65
  amount_bonus = min((近3天日均 / 50) × 15, 25)   # 日均$50得15分，$100+封顶25分
  impact_bonus = min((近3天日均 / 账号日均总成本 × 100) × 3, 10)  # 占比越高加分越多，封顶10分
  anomaly_score = min(base_score + amount_bonus + impact_bonus, 100)
  ```
  示例：日均 $10 的新增服务 → 约 68 分（🔶 中优）；日均 $200 的新增服务 → 约 95 分（🔴 高优）。
- **数据不足**：服务出现不足 7 天 → 标准差不可靠，仅做简要提及，不做评分判定。
- **极低波动服务突变**：CV < 2% 的服务突然偏离 → 即使绝对金额不大，也可能意味着配置变更，agent 应在卡片中注明。

### 5.7 跨服务关联检测

在单账号内完成所有异常服务评分后，agent 必须检查是否存在多服务联动：

**检测规则：**
- 若同一账号内有 2 个及以上异常服务（anomaly_score >= 60），且它们的异常起始时间（首次超出基线的日期）相差不超过 1 天，则标记为"疑似关联"。

**常见关联模式：**

| 关联组 | 典型场景 |
|--------|----------|
| EC2 Compute + EC2 Other (EBS) | 扩容事件：新实例同时带来新 EBS 卷 |
| EC2 Compute + Data Transfer | 扩容或流量增长 |
| Lambda + API Gateway + DynamoDB | 业务流量整体上涨 |
| RDS + EC2 Compute | 数据库扩容伴随应用层扩容 |
| S3 + Data Transfer + CloudFront | 数据分发量增长 |
| Bedrock + CloudWatch Logs | 模型调用增加导致日志量同步增长 |

**输出要求：**
- 检测到关联时，在异常卡片中增加一行：`🔗 关联服务：<服务列表>，疑似同一事件驱动`
- 在跨账号优先处理列表中，关联服务合并为一行展示，避免同一根因重复占位。
- agent 应在建议动作中统一指向可能的共同根因，而非对每个服务分别给出独立建议。

## 6. 异常服务下钻分析

仅对 anomaly_score >= 60 的服务进行下钻。
下钻查询使用同一时间范围，filter 组合 RECORD_TYPE 排除 + SERVICE 过滤。

下钻 filter 模板：
```json
{
  "And": [
    {
      "Not": {
        "Dimensions": {
          "Key": "RECORD_TYPE",
          "Values": [
            "Credit",
            "Refund",
            "SavingsPlanNegation",
            "Discount",
            "BundledDiscount",
            "Enterprise Discount Program Discount"
          ]
        }
      }
    },
    {
      "Dimensions": {
        "Key": "SERVICE",
        "Values": ["<CE 返回的服务名原文>"]
      }
    }
  ]
}
```

## 7. 服务下钻维度映射

| 服务 | 主维度 | 辅维度 | 关注点 |
|------|--------|--------|--------|
| Amazon S3 | USAGE_TYPE | OPERATION | Region、存储层、操作增长 |
| EC2 - Compute / EC2 - Instances | INSTANCE_TYPE | USAGE_TYPE | 实例类型/族增长 |
| EC2 - Other | USAGE_TYPE | — | NAT、EBS、Data Transfer、EIP |
| Amazon RDS | INSTANCE_TYPE | USAGE_TYPE | 实例规格、存储、备份、PIOPS |
| Amazon DocumentDB | INSTANCE_TYPE | USAGE_TYPE | 实例类型、存储、I/O |
| Amazon ElastiCache | INSTANCE_TYPE | USAGE_TYPE | 节点类型、引擎、备份、跨 AZ |
| Amazon MSK | USAGE_TYPE | — | Broker 小时、存储、跨 AZ 传输 |
| Amazon OpenSearch | INSTANCE_TYPE | USAGE_TYPE | 节点类型、EBS、Warm/Cold |
| Amazon Bedrock | USAGE_TYPE | OPERATION | 模型、Token 类别 |
| Amazon Redshift | INSTANCE_TYPE | USAGE_TYPE | 节点规格、Serverless RPU |
| AWS DMS | INSTANCE_TYPE | USAGE_TYPE | 复制实例、存储、传输 |
| Amazon EKS | USAGE_TYPE | — | 集群小时、Fargate |
| Amazon VPC | USAGE_TYPE | — | NAT GW、VPC Endpoint、VPN |
| AWS Lambda | USAGE_TYPE | OPERATION | GB-秒、请求数、预置并发 |
| Amazon DynamoDB | USAGE_TYPE | OPERATION | 读写容量、存储、流 |
| CloudWatch | USAGE_TYPE | OPERATION | Logs、指标、告警 |
| API Gateway | USAGE_TYPE | OPERATION | API 调用、传输、缓存 |
| Secrets Manager | USAGE_TYPE | — | Secret 数量、API 调用 |
| CloudFront | USAGE_TYPE | — | 数据传输、请求数 |
| SQS / SNS | USAGE_TYPE | OPERATION | 请求量变化 |
| 默认（其他服务） | USAGE_TYPE | — | 通用 UsageType 分解 |

注意：OPERATION 是合法维度名，**禁止使用 API_OPERATION**。

## 8. 下钻查询规则

1. 先按主维度分组；若有辅维度，使用两个 group-by 联合查询。
2. 若结果包含 NextPageToken，必须继续翻页。
3. 仅展示对异常贡献最大的前 top_n_drivers 个维度值。

```bash
aws ce get-cost-and-usage \
  --time-period Start=<start>,End=<end_plus_1> \
  --granularity DAILY \
  --metrics AmortizedCost \
  --group-by Type=DIMENSION,Key=<主维度> Type=DIMENSION,Key=<辅维度> \
  --filter '<service_filter_json>'
```

## 9. USAGE_TYPE 解读规则

- Region 前缀解码：`USE1-` → us-east-1，`EUW1-` → eu-west-1，`APN1-` → ap-northeast-1
- 资源类别识别：`TimedStorage-ByteHrs`、`BoxUsage:m5.xlarge`、`NatGateway-Bytes`
- 存储层识别：S3 Standard、Glacier 等
- 存储类可在标注"估算值"前提下估算 GB 变化；若月费率未知则不估算。

## 10. 输出格式

**核心原则：没有异常就不展开，有异常才输出卡片。**

**用户指定时间范围时的输出聚焦规则：**
当用户明确指定了关注的时间范围（如"近几天"、"这周"、"最近 3 天"），输出应以用户关注的时间段为主体，30 天数据仅作为基线参考简要提及。具体做法：
- 开头直接回答用户关注时间段的结论（如"近 3 天 EC2 用量稳定"）
- 详细展开用户关注时间段内的每日数据和趋势
- 30 天基线数据放在对比参考位置，用一两行带过即可，不要喧宾夺主
- 如果用户没有指定时间范围（如"帮我做成本分析"），则按默认的 30 天全量分析输出

### 10.1 无异常日

一句话摘要，不展开：
```
✅ 账号 <name>（<account_id>）过去 24h 无成本异常。
   30 天日均 $xx,xxx | 最近 3 天日均 $xx,xxx | 偏差 <1%
```

### 10.2 有异常日 — 跨账号优先处理列表

仅列出同时满足以下条件的异常：
- anomaly_score >= anomaly_score_threshold
- confidence_level != Low
- projected_7d_extra_cost >= 20 USD

| 账号 | 服务 | 评分 | 置信度 | 预计7天额外影响 | 异常摘要 | 一句话建议 |
|------|------|------|--------|----------------|----------|-----------|

### 10.3 异常服务卡片

每个异常服务必须包含：
- 服务名 + anomaly_score
- 异常类型（🔴 高优 / 🔶 中优 / 🆕 新增）
- 置信度
- 7 天趋势（见下方趋势符号规则）
- **为什么值得关注**（agent 必须用自然语言解释，不能只说"超过阈值"）
- 关键证据（数值）
- Top 驱动项
- 预计继续影响
- 建议动作
- 观测缺口

**7 天趋势符号规则：**

取最近 7 天每日成本，计算每天相对前一天的变化方向，生成 6 个符号的趋势序列：

| 日环比变化 | 符号 |
|-----------|------|
| 增长 > 20% | ⬆ |
| 增长 5%~20% | ↗ |
| 变化 -5%~+5% | → |
| 下降 5%~20% | ↘ |
| 下降 > 20% | ⬇ |

示例：`趋势（近7天）：→ → ↗ ⬆ ⬆ ↗ — 持续恶化`

趋势序列后附一个简短判断词：
- 最后 3 个符号均为 ⬆ 或 ↗ → `持续恶化`
- 最后 3 个符号均为 ⬇ 或 ↘ → `正在收敛`
- 先升后降 → `脉冲式`
- 无明显方向 → `波动中`

示例：
```
🔴 Amazon Bedrock（评分 92）
   置信度：High
   趋势（近7天）：→ → → ↗ ⬆ ⬆ — 持续恶化
   为什么值得关注：该服务过去 28 天几乎无成本，3/10 起突然出现持续高额消费，
   且已占账号日均总成本 3.6%。这不是正常波动，属于突发新增大额消费。
   
   证据：3 天均值 $71.97，基线日均 $4.99，偏离 13.4σ
   驱动项：Claude 4.6 Opus cache-write (ap-northeast-1) 单日 $84.28，贡献 71%
   预计继续影响：若未来 7 天维持当前速率，预计额外增加约 $469
   建议：排查 ap-northeast-1 的 Bedrock Streaming API 调用来源，评估 cache-write 必要性
   观测缺口：仅定位到 UsageType + Operation，未定位到具体调用方
```

### 10.4 观察列表（可选）

对 anomaly_score 40~59 的服务，在报告末尾简要提及：
```
📋 观察列表（暂不需要行动）：
- CloudWatch：近 3 天日均 $0.59，略高于基线 $0.44（评分 45，置信度 Low）
```

## 11. 建议动作生成规则

建议动作必须具体、可执行，避免只写"请检查"。

| 服务 | 建议方向 |
|------|----------|
| S3 | 检查是否新增备份、数据回灌、批量上传、生命周期策略缺失 |
| EC2 | 检查 ASG、实例规格升级、扩容事件、版本发布 |
| RDS | 检查实例规格、Multi-AZ、存储扩容、IOPS 调整 |
| CloudWatch | 检查 debug 日志、日志保留策略、日志爆量来源 |
| Lambda | 检查请求量、执行时长、预置并发 |
| Bedrock | 检查模型调用量、token 用量、prompt caching 写入成本、是否可用更低成本模型替代 |
| ElastiCache | 检查节点规格变更、副本数、引擎版本升级、备份策略 |
| MSK | 检查 broker 数量、存储扩容、跨 AZ 流量 |
| DocumentDB | 检查实例规格、I/O 用量、存储增长 |
| OpenSearch | 检查实例规格、数据节点数、UltraWarm 迁移 |

### 11.1 Savings Plans / Reserved Instances 推荐规则

当用户询问 SP/RI 覆盖率或优化建议时，必须遵守以下规则：

1. **SP 只推荐 Compute Savings Plans，RI 只推荐按需分析不推荐具体购买。** Compute SP 灵活性高（不绑定实例族、Region、OS），适合绝大多数场景。EC2 Instance SP 和 Standard RI 虽然折扣更深，但机型/Region 捆绑严重，一旦业务调整就浪费承诺。除非用户明确要求对比 Instance SP 或 Standard RI，否则不要主动推荐。

2. **不要自行估算折扣率和节省金额。** SP/RI 折扣率因实例类型、Region、付款方式、期限组合不同差异很大，agent 无法准确计算。应引导用户前往 AWS Cost Explorer 查看官方推荐：
   - SP：Cost Explorer → Savings Plans → Recommendations
   - RI：Cost Explorer → Reservations → Recommendations

3. **不要擅自推荐购买金额、覆盖率或具体 RI 数量。** agent 不清楚客户的业务规划（是否即将扩容/缩容、是否有季节性波动、风险偏好如何），不能替客户决定承诺多少。应呈现当前 OD 用量数据，然后询问客户期望的覆盖率目标，或引导客户使用 AWS 官方推荐工具。

4. **可以做的事：** 呈现当前 OD vs SP vs RI 的比例、识别用量稳定性（CV 低 = 承诺型折扣利用率高的好信号）、指出哪些实例族/Region 是主要 OD 开支、建议客户查看 AWS 官方 SP/RI Recommendations。

## 12. 错误处理与回退规则

以下情况必须明确返回失败原因，不得输出模糊结论：
- AssumeRole 失败
- 账号凭证无效
- IAM 权限不足
- Cost Explorer 未启用
- 查询结果为空
- 请求被限流
- 返回 NextPageToken 但未能继续翻页
- 数据暂不可用

```
⛔ AccountA：AssumeRole 失败，建议检查目标账号信任策略
⛔ AccountB：无 ce:GetCostAndUsage 权限，建议补充只读 Billing/Cost 权限
```

## 13. 关键规则

- 始终使用 AmortizedCost
- 始终排除 Credit / Refund / Discount / SavingsPlanNegation / BundledDiscount / Enterprise Discount Program Discount
- 所有金额保留 2 位小数
- 所有服务过滤必须使用 CE 返回的服务原文
- 所有维度名必须使用 AWS 官方合法维度名（OPERATION 可用，API_OPERATION 不可用）
- 一次查询最多使用两个 group-by
- 若返回 NextPageToken，必须翻页直到完成
- 异常判定基于多因子评分 + 周期性基线，不使用固定阈值
- agent 必须用自然语言解释"为什么这个异常值得关注"
- Low 置信度异常不进入优先处理列表
- projected_7d_extra_cost < $20 的异常自动降一级
- 第 15 节增强排查模块默认不执行

## 14. 禁止事项

1. 禁止使用 API_OPERATION
2. 禁止省略分页处理
3. 禁止把展示名称当作 SERVICE 过滤值
4. 禁止把多个账号混成一个结果后再倒推账号
5. 禁止在没有足够证据时输出过度确定的根因
6. 禁止在 investigation_mode=off 时执行第 15 节中的增强排查命令
7. 禁止输出大段原始明细，导致客户无法快速识别重点
8. 禁止对正常波动范围内的变动发出提醒

## 15. 可选增强排查模块（默认关闭）

本模块用于在成本异常完成下钻后，进一步调用 CloudTrail、CloudWatch 或服务只读 API 验证可能根因。
默认关闭，只有在 investigation_mode=on_demand 或 auto 时才允许执行。

### 15.1 启用条件

同时满足以下条件才允许触发：
1. investigation_mode 不等于 off
2. 该服务 anomaly_score >= 60
3. 已完成成本下钻，且已识别出明确的异常驱动项
4. 该账号具备所需只读权限
5. 所需日志/事件/监控前提存在；若不存在则记录观测缺口

### 15.2 自动排查触发条件

当 investigation_mode=auto 时，仅对满足以下任一条件的异常服务触发：
- anomaly_score >= 80
- 近 3 天绝对增量 >= 100 USD
- 位列账号内异常优先级前 3
- 用户显式要求"继续定位根因"

### 15.3 执行预算限制

- 每个异常服务最多 max_followup_calls_per_service 次后续命令
- 权限错误且 stop_on_permission_error=true 时立即停止
- 多服务排查时按 anomaly_score 排序优先
- 排查失败不影响基础成本报告输出

### 15.4 成本驱动类型分类

| 驱动类型 | 含义 | 排查核心 |
|----------|------|----------|
| 调用驱动 | 成本与 API 调用量正相关 | CloudTrail：谁在调用、从哪调用 |
| 资源驱动 | 成本与资源规格和运行时长正相关 | describe-* API：什么在跑、什么时候变的 |
| 流量/存储驱动 | 成本与数据量正相关 | CloudWatch Metrics + Logs：量从哪来 |

### 15.5 服务排查映射

#### 调用驱动型

| 服务 | 排查命令 | 关注字段 |
|------|----------|----------|
| Amazon Bedrock | `aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventSource,AttributeValue=bedrock-runtime.amazonaws.com --start-time <start> --end-time <end> --region <region>` | userIdentity.arn、sourceIPAddress |
| AWS Lambda | `aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventSource,AttributeValue=lambda.amazonaws.com` | userIdentity、functionName |
| Amazon DynamoDB | `aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventSource,AttributeValue=dynamodb.amazonaws.com` | 调用来源；结合 CloudWatch 指标 |
| API Gateway | `aws apigateway get-rest-apis` + CloudWatch Metrics | 哪个 API/stage/path 调用量高 |
| S3 API 飙升 | CloudTrail Data Events（如已开启） | PutObject / GetObject 来源 |

#### 资源驱动型

| 服务 | 排查命令 | 关注点 |
|------|----------|--------|
| EC2 Compute | `aws ec2 describe-instances --filters Name=instance-state-name,Values=running` | 新实例、大规格、LaunchTime |
| Amazon RDS | `aws rds describe-db-instances` | 实例规格、Multi-AZ、存储 |
| Amazon DocumentDB | `aws docdb describe-db-clusters` + `aws docdb describe-db-instances` | 实例规格、读副本、存储/I/O |
| Amazon ElastiCache | `aws elasticache describe-cache-clusters --show-cache-node-info` | 节点类型、数量 |
| Amazon OpenSearch | `aws opensearch describe-domains` | 实例类型、节点数、EBS |
| Amazon MSK | `aws kafka list-clusters-v2` + `aws kafka describe-cluster-v2` | broker 规格、数量、存储 |
| Amazon Redshift | `aws redshift describe-clusters` | 节点类型、数量 |
| AWS DMS | `aws dms describe-replication-instances` | 实例规格 |
| Amazon EKS | `aws eks list-clusters` + `aws eks describe-cluster` | 集群、节点组、Fargate |

#### 流量/存储驱动型

| 服务 | 排查命令 | 关注点 |
|------|----------|--------|
| S3 存储增长 | `aws cloudwatch get-metric-statistics --namespace AWS/S3 --metric-name BucketSizeBytes` + `aws s3api get-bucket-lifecycle-configuration` | 哪个 bucket 在涨，lifecycle 缺失 |
| EC2 - Other (NAT GW) | `aws ec2 describe-nat-gateways` + CloudWatch 指标 | 哪个 NAT GW 流量大 |
| EC2 - Other (EBS) | `aws ec2 describe-volumes --filters Name=status,Values=in-use` | 大卷、高 IOPS |
| CloudWatch Logs | `aws logs describe-log-groups --query 'sort_by(logGroups,&storedBytes)[-5:]'` | 最大 log group、保留策略 |
| VPC 数据传输 | CE USAGE_TYPE + VPC Flow Logs | 跨 AZ / 出 Internet 来源 |
| CloudFront | `aws cloudfront list-distributions` + CloudWatch | 哪个 distribution 异常 |

### 15.6 增强排查执行规则

1. `--region` 必须使用下钻中识别到的异常 region。
2. CloudTrail 时间范围覆盖异常开始前 1 天到异常结束。
3. CloudTrail 或 Data Events 未开启时，写入观测缺口，不伪造来源。
4. 资源驱动型优先展示当前配置，再查变更历史。
5. 排查结果必须与下钻异常维度值对应，形成证据链。
6. investigation_mode=off 时本节所有命令不得执行。

### 15.7 增强排查输出格式

已执行：
```
增强排查结果（可选模块）：
- 状态：已执行
- 排查方式：CloudTrail + describe-instances
- 发现：03-10 由 arn:aws:iam::<account>:role/app-prod-asg-role 触发 RunInstances
- 结论：与 m5.2xlarge 成本上升时间一致，疑似 ASG 扩容
- 置信度：中
```

未执行：
```
增强排查结果（可选模块）：
- 状态：未执行
- 原因：investigation_mode=off
```
