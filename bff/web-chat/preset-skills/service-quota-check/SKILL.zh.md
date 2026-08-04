# 服务配额使用率检查

你正在对 AWS 服务配额（Service Quotas）执行一次**只读**审查，以发现即将耗尽的配额。
这是一个报告/建议类技能——它绝不会发起配额提升申请。

> 注意：本技能改编自开源项目
> `aws-samples/sample-devops-agent-tools` 中的 `service-quota-check` 技能，
> 已移除其中两个会产生变更的操作（RequestServiceQuotaIncrease / CreateSupportCase），
> 以保持严格只读。

## 何时使用
- 用户询问服务配额 / limit、是否即将触及某个 limit、限流风险、容量余量，
  或正在规划一次上线或扩容。

## 步骤

1. **确定范围。** 如果用户指定了某个服务（如 "EC2"、"Lambda"），则聚焦该服务。否则覆盖
   常见高风险配额：EC2 运行中按需 vCPU（按实例族）、EBS 存储/卷、
   VPC（ENI、安全组、VPC 数量）、Lambda 并发执行数、RDS 数据库实例、IAM 角色。
2. **读取配额。** 对范围内的每个服务，列出其配额及已应用/生效的取值
   （`servicequotas:ListServices`、`ListServiceQuotas`、`GetServiceQuota`）。标注哪些配额
   可调整、哪些是硬性上限。
3. **读取当前用量。** 对于关联了 CloudWatch 用量指标（`AWS/Usage`）的配额，读取近期的
   `GetMetricData` / `GetMetricStatistics` 以计算
   **使用率 = 当前用量 ÷ 配额**。若某配额没有用量指标，则通过相应的 describe/list API
   直接统计资源数量（例如统计运行中实例的 vCPU 数）。
4. **按使用率标记风险：**
   - **≥ 90%** → HIGH（限流 / 上线失败迫在眉睫）。
   - **80–90%** → MEDIUM（应尽快申请提升）。
   - **< 80%** → OK。
5. **是否有进行中的提升申请？** 列出已提交的提升申请
   （`servicequotas:ListRequestedServiceQuotaChangeHistory*`），以免重复建议一个
   已在处理中的申请。

## 报告格式

| 严重程度 | 服务 · 配额 | 用量 / limit | 使用率 | 是否可调整？ | 建议 |
|---|---|---|---|---|---|
| HIGH / MEDIUM / OK | EC2 · Running On-Demand Standard vCPUs | 460 / 512 | 90% | Yes | 上线前申请提升至 ≥ 768 |

先给出结论（有多少个配额处于 HIGH/MEDIUM 风险），再给出表格，最后给出首要行动项。

## 护栏
- **只读。不要调用 `RequestServiceQuotaIncrease`，也不要开支持工单**——只
  报告使用率并建议一个目标值。如果用户明确希望提升某个配额，
  请告知其在 Service Quotas 控制台自行操作（或联系其管理员），因为 NotiOps 保持
  只读。
- 每个使用率数字都要引用配额取值 + 用量来源（CloudWatch 指标或资源计数）。
  若某个配额的用量无法确定，应如实说明，而不要臆断其无风险。
- 配额按 Region 划分——请说明每个数字对应哪个 Region。
