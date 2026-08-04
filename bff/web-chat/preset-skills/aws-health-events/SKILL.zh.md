# AWS Health 事件核查

你正在对 AWS Health 执行一次**只读**核查。当有事件正在调查时，判断是否存在某个 AWS 侧事件
（服务问题、计划维护、账户通知）导致了当前现象、或与之相关。也可按需用它汇总某账号在一段
时间内的 Health 事件。

> 注意：本技能改编自开源项目
> `aws-samples/sample-devops-agent-tools` 中的 `aws-health-events` 技能，
> 已精简并保持严格只读（仅 describe/list —— 绝不修改任何资源、也不开工单）。

## 何时使用
- 正在排查服务降级、错误率升高、延迟尖峰、连接失败、限流或容量问题——想确认是否有
  AWS 侧事件是根因或诱因。
- 用户要一份账号 / 区域 / 某服务在某时间窗内的 AWS Health 汇总报告。

## 前置条件
- AWS **Health API** 需要 **Business / Enterprise / Enterprise On-Ramp** 支持计划。
  若不可用（`support_plan_required` / 拒绝访问），就**如实说明并就此停止**——
  不要臆断具体档位。
- Health API 端点**仅在 us-east-1**——无论受影响资源在哪个区域，都要打到 us-east-1。
  数据仅覆盖**最近 90 天**。
- 只读 IAM：`health:DescribeEvents`、`DescribeEventDetails`、`DescribeAffectedEntities`、
  `DescribeEventTypes`。

## 步骤

1. **收集事件上下文。** 受影响服务、时间窗（ISO 8601）、具体资源 ID、区域/AZ、现象。
   将这些作为下面的过滤条件。
2. **搜索事件**（`DescribeEvents`，us-east-1）。按 `services`、`startTimes`（`from` = 事件开始
   前约 7 天）、`regions`、`eventStatusCodes` `[open, closed]`、`eventTypeCategories`
   `[issue, scheduledChange, accountNotification]` 过滤。跟随 `nextToken` 翻页
   （上限约 500 条，每页 100）。同时纳入 `ACCOUNT_SPECIFIC` 与 `PUBLIC` 事件。
3. **先筛出相关子集**（用已返回的字段，先别急着拉详情）：保留 `service` 命中受影响服务
   （或下方依赖表里的相关服务）、活跃窗口与事件时间窗有重叠、且区域/AZ 匹配的事件。
   除非事件本身属账户级，否则丢弃 `accountNotification`；丢弃在事件开始前 > 2 小时就已
   结束的 `closed` 事件。
4. **拉取详情**（`DescribeEventDetails`，每次 ≤ 10 个 ARN）：取 `latestDescription`、
   时间线（开始/结束/更新）、状态、服务/区域、类型。若有 `failedSet`，报出失败的 ARN，
   并继续处理 `successfulSet`。
5. **受影响实体**——仅对 **ACCOUNT_SPECIFIC** 事件调 `DescribeAffectedEntities`；
   把每个 `entityValue` 与事件里的资源 ID 做精确匹配，并标注实体状态
   （`IMPAIRED` / `UNIMPAIRED` / `UNKNOWN` / `PENDING`）。PUBLIC 事件不返回实体。
6. **关联并打相关性分。** **High** = 服务匹配 + 时间窗重叠 + 资源匹配（无资源 ID 时用
   区域/AZ 匹配）。**Medium** = 服务匹配 + 时间窗重叠。**Low** = 仅服务匹配。任何
   **open** 的 High/Medium 事件都标为**「likely contributing factor（可能诱因）」**。

## 报告格式

先给一句结论——*是否有某个 AWS 侧事件很可能解释本次事件*。然后按类别分组
（**Issues** → **Scheduled changes** → **Account notifications**），组内按 High → Medium → Low、
再按时间倒序：

| 相关性 | 类别 · 服务 | 区域 / AZ | 状态 | 时间窗（起–止） | 摘要 | 是否诱因 |
|---|---|---|---|---|---|---|

若没有任何关联事件，**要明确说明**，列出所用的搜索参数（服务、时间窗、区域），
并建议排查其它方向（近期部署/配置变更、配额耗尽、网络、应用层错误）。当按服务搜索为空时，
先扩展到相关服务和/或把时间窗放宽到 14 天，**再**下「没有事件」的结论。

**服务依赖表**（按服务搜索为空时，扩展到 ≤ 3 个相关服务）：
ELB/ALB/NLB → EC2、VPC、Route 53 · RDS → EC2、EBS · ECS/EKS → EC2、VPC、ELB · Lambda →
VPC、CloudWatch · CloudFront → S3、Route 53 · API Gateway → Lambda、VPC · ElastiCache →
EC2、VPC。

## 护栏
- **只读**：只用 `DescribeEvents` / `DescribeEventDetails` / `DescribeAffectedEntities` /
  `DescribeEventTypes`。绝不修改任何资源、也不开工单。
- Health API **一律打 us-east-1**，无论资源在哪个区域。
- 若账号的支持计划不含 Health API，就精确报出缺哪项支持权益或 IAM action 并**停止**——
  不要臆断档位，也不要回落到其它账号。
- 区分**事实**（来自 Health API）与**推断**（⚠️）。相关不等于因果——只标「可能诱因」，
  不断言因果。
- 只对通过相关性筛选的事件拉详情 / 查受影响实体，以控制 API 调用量。
