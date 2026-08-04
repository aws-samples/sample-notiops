# 流水线与算法

## 四阶段流水线

```
阶段一                    阶段二                    阶段三                    阶段四
资源发现与预过滤           海选采集与全量入库          精选采集                  深度分析与判定
─────────────────────    ─────────────────────    ─────────────────────    ─────────────────────

 DescribeInstances        GetMetricData (批量)      GetMetricData (深度)      峰值否决
       │                        │                        │                     │
       ▼                        ▼                        ▼                     ▼
 全量实例列表              基础指标 (5项RDS/6项EC)    深度指标 + 7天峰值        隐形负载检查
       │                   CPU / 连接数 / 存储         IOPS / 网络 / 驱逐          │
       ▼                   + WriteIOPS / CPUMax       + BytesUsedForCache          ▼
 白名单过滤                + CacheHits/Misses         + SwapUsage             增强版评分
 (Tag + 配置表)            + ReplicationLag                                   idle_score × 规格权重
       │                        │                        │                  × 连续天数因子
       ▼                        ▼                        ▼                     │
 Target_Instance_List      识别 Candidate             补充深度数据              ▼
                          (CPU<阈值 & Conn<阈值)                              路径 A → waste_report
                                                                             路径 B → optimization_report
```

| 阶段 | 执行者 | CloudWatch API |
|------|--------|----------------|
| 一：资源发现 | Lambda1 | 0 次 (仅 Describe) |
| 二：海选采集 | Lambda1 | N×(5~6) 指标查询 |
| 三：精选采集 | Lambda1 | C×(4~7) 指标查询 |
| 四：深度判定 | Lambda2 | 0 次 (纯 DB 分析) |

> N = 目标实例数，C = Candidate 数（通常 < 10% × N）

> RDS / ElastiCache 的四阶段流水线共享同一 Lambda1/Lambda2 代码路径，通过 `resource_type` 参数区分；两类资源都会在阶段四生成 `waste_report`（路径 A）和 `optimization_report`（路径 B）。

## 每日调度时间线

| UTC 时间 | 执行者 | 说明 |
|----------|--------|------|
| 00:00 | Lambda1-Collector → Lambda2-Analyzer（异步） | 四阶段流水线 + EC2 Trusted Advisor |
| 00:30 | Lambda3-HealthChecker（RDS）| RDS AI 智能巡检报告 |
| 01:00 | Lambda3-HealthChecker（ElastiCache）| ElastiCache AI 智能巡检报告（相同 handler，不同 EventBridge payload）|
| 01:15 | Lambda5-CostAnalyzer | Cost Explorer 异常检测 |
| 02:00 | Lambda4-Notifier | 汇总当天各路数据 → 推送飞书群 |

> 调度规则由 CDK 在 `infra/lib/notiops-backend-stack.ts` 声明为 5 条独立 EventBridge Rule。

## EC2 Trusted Advisor 采集

EC2 低利用率检测独立于 RDS/ElastiCache 四阶段流水线，作为 Lambda1-Collector 的附加采集阶段运行。

### 数据源

| 数据源 | Check ID | 提供信息 |
|--------|----------|----------|
| 经典版 Trusted Advisor | `Qch7DwouX1` | CPU 14天平均、网络 I/O、低利用率天数、预估月度节省 |
| Cost Optimization Hub | `c1z7kmr00n` | 推荐优化动作（rightsizing/Graviton 迁移/终止）、预估费用与节省 |

两者以 Instance ID + Region 为联合键 LEFT JOIN 合并。

### 关键设计决策

- Support API 仅在 `us-east-1` 可用，客户端统一在该 Region 创建
- Trusted Advisor 返回跨 Region 汇总数据，按账户级采集
- 超时保护：剩余时间 < 2 分钟时自动跳过
- 错误隔离：单账户失败不影响其他账户

## RDS / ElastiCache AI 智能巡检

基于 Amazon Bedrock 的数据库/缓存健康巡检，由 **Lambda3-HealthChecker** 同一个函数处理两类资源，通过 `resource_type` 参数（`rds` / `elasticache`）区分走哪条分支。

```
手动触发 / EventBridge (00:30 RDS / 01:00 ElastiCache)
       │
       ▼
  API Lambda ──POST /trigger──▶ 创建 generating 占位记录
       │
       └── Lambda.invoke(Event) ──▶ Lambda3-HealthChecker
                                        │
                                        ├── 1. 加载配置（模型 ID / Agent Prompt，分资源类型存 DDB 配置表 `appconfig#rds_health` / `appconfig#elasticache_health`）
                                        ├── 2. 读取监控数据（rds_monitoring_data 或 elasticache_monitoring_data）
                                        ├── 3. 白名单过滤（health_check_whitelist）
                                        ├── 4. 构建 CSV Metrics Payload
                                        ├── 5. 调用 Bedrock Converse API（默认模型 `global.anthropic.claude-opus-4-7`，可通过 DDB 配置表 `appconfig#rds_health` / `appconfig#elasticache_health` 项的 `bedrock_model_id` 覆盖）
                                        ├── 6. 解析报告摘要
                                        └── 7. 存储报告
```

> Prompt 模板：内置默认值位于 `lambda3_health_checker/data_loader.py::DEFAULT_AGENT_PROMPT` 和 `ec_data_loader.py::DEFAULT_EC_AGENT_PROMPT`，可通过控制台「巡检设置」或 `/api/{rds,elasticache}-health-check/config` 覆盖到 DDB 配置表（`appconfig#rds_health` / `appconfig#elasticache_health`）。若要自定义,直接以内置默认值为起点改写后写入 DDB 配置表即可。

### 模型选择

默认 `global.anthropic.claude-opus-4-7`（CDK `BEDROCK_MODEL_ID` 环境变量）。如需按数据驻留或成本偏好切换，可在 Dashboard「巡检设置」或直接对 DDB 配置表写入 `appconfig#rds_health` 项的 `bedrock_model_id`（SK=`bedrock_model_id`）：

```bash
aws dynamodb put-item --table-name notiops-config \
  --item '{"PK":{"S":"appconfig#rds_health"},"SK":{"S":"bedrock_model_id"},"config_value":{"S":"<inference-profile-id>"}}'
```

| 前缀 | 含义 | 数据驻留 |
|------|------|----------|
| global | 全球任意区域 | 延迟最低（当前默认）|
| apac  | 亚太区域处理 | 数据不出亚太 |
| jp | 仅日本区域处理 | 数据不出日本 |

> 必须使用推理配置文件 ID（如 `global.anthropic.claude-opus-4-7` 或 `apac.anthropic.claude-sonnet-4-20250514-v1:0`），裸模型 ID 在非 us-east-1 区域会返回 `ValidationException`。

### 报告生成模式

| 模式 | 触发条件 | 说明 |
|------|----------|------|
| 单次模式 | Token 估算 ≤ 100K | 一次调用生成完整报告 |
| 批量模式 | Token 估算 > 100K | 按账户分批调用后合并 |

## 每日成本异常分析（Lambda5-CostAnalyzer）

每日 01:15 UTC 触发，通过 Cost Explorer API 采集各 Linked Account × Service 的日级费用并做多因子评分，识别异常费用增长。结果写入 DDB 配置表供 Dashboard `/cost-anomaly` 和 Lambda4 定时推送使用。

- 数据源：AWS Cost Explorer `GetCostAndUsage`，维度 `LINKED_ACCOUNT` + `SERVICE`
- 打分逻辑：近 N 日滚动基线 + 同比环比 + 绝对金额阈值
- 输出：DDB 配置表 `anomaly#<account_id>#<date>`（按服务的具体异常项，SK=`<service_name>`）+ `anomalysum#<account_id>`（按日报告摘要，SK=`<date>`），见 `shared/queries/cost_anomaly.py`
- 代码入口：`lambda5_cost_analyzer/handler.py`

## 判定算法

```
              Candidate 列表
                   │
                   ▼
        ┌─────────────────────┐
        │    峰值否决 (Veto)   │  peak_cpu_7d > 阈值? → 排除
        └──────────┬──────────┘
                   │ 通过
                   ▼
        ┌─────────────────────┐
        │  隐形负载检查        │  IOPS/WriteIOPS/Evictions/Requests > 阈值? → 排除
        └──────────┬──────────┘
                   │ 通过
                   ▼
        ┌─────────────────────┐
        │  增强版闲置评分      │  idle_score = CPU(40%) + 连接数(30%) + 存储/内存(30%)
        │                     │  value_score = idle_score × 规格权重 × 连续天数因子
        └──────────┬──────────┘
                   │
                   ▼
        ┌─────────────────────┐
        │  生成 waste_report   │  + 月度节省估算 + 精确定价 + 可选 SNS 告警
        └─────────────────────┘
```

规格权重：xlarge+ = 1.5, medium/large = 1.0, small- = 0.5
连续天数因子：1.0 + (consecutive_low_days - 1) × 0.1（最小 1.0，最大约 1.6）

## CloudWatch API 费用估算

| 项目 | 500 实例示例 |
|------|-------------|
| 海选采集（每天） | 2,500~3,000 查询 |
| 精选采集（每天） | 250~350 查询 |
| 月度总查询 | ~100,500 查询 |
| 月度费用 | ≈ $1.01/月 |
