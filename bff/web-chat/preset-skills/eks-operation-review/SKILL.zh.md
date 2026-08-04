# EKS 运维审查

你正在对一个 Amazon EKS 集群执行**只读**的最佳实践审查，覆盖可靠性、
安全、成本、网络与可扩展性。

> 本 skill 由开源项目 `aws-samples/sample-devops-agent-tools` 的
> `eks-operation-review` skill 改编而来，适配 NotiOps。本 skill 和其它 skill 一样在本地即可运行，
> 但一次彻底的 EKS 审查除了 AWS 控制面之外，还需要读取实时的 Kubernetes 状态（pod、deployment、
> 事件、node 压力）。NotiOps 本地的只读工具只能看到 EKS 控制面，无法看到集群内的工作负载状态——
> 因此若要做最深入的审查，**请将本 skill 发布到 AWS DevOps Agent**，并在打开 DevOps Agent 开关后运行，
> 让深度调查能够深入集群内部。

## 何时使用
- 用户询问 EKS / Kubernetes 集群健康状况、最佳实践、pod 故障、集群
  可靠性或安全，或任何 EKS 运维相关的问题。

## 审查维度

1. **控制面与版本。** EKS 集群版本相对于当前受支持窗口的情况；标记临近或已过
   支持终止期的版本。托管 add-on（VPC CNI、CoreDNS、kube-proxy）是否存在
   且为最新版本。控制面日志（api、audit、authenticator）是否已启用。
2. **节点组与计算。** 托管 vs 自管理 node group；实例类型与容量
   类型（On-Demand / Spot）；desired/min/max 以及是否部署了 Cluster Autoscaler 或 Karpenter。
   node 是否分布在 ≥ 2 个 AZ 以实现弹性。根据 node CPU/内存压力进行合理规格调整。
3. **工作负载健康。** 处于 CrashLoopBackOff / Pending / Evicted 的 pod；存在不可用
   副本的 deployment；近期的 warning 事件；缺失资源 requests/limits；单副本的关键
   工作负载；用于 HA 的 PodDisruptionBudget。
4. **网络。** VPC CNI IP 耗尽风险；security group 及其暴露面；公有 vs
   私有 API 端点；ingress/负载均衡器配置。
5. **安全 / IAM。** IRSA（IAM Roles for Service Accounts）vs node-role 权限过度分配；
   `aws-auth` / access-entry 审查；是否启用 secrets 加密（KMS）；最小权限态势。
6. **成本。** 空闲 / 过度预置的 node group；对容错型工作负载的 Spot 机会；
   未使用的持久卷。

## 报告格式

先给集群一个总体评级，然后列出按严重程度排序的发现项：

| 严重程度 | 维度 | 发现 | 证据 | 建议 |
|---|---|---|---|---|
| CRITICAL / HIGH / MEDIUM / LOW | 可靠性 / 安全 / 成本 / 网络 / 可扩展性 | … | 控制面配置、K8s 对象状态或指标 | … |

严重程度指引：**CRITICAL** = 存在活跃的中断风险（生产环境 node 单 AZ、集群版本 EOL、
IP 即将耗尽）。**HIGH** = 无限制的公有 API 端点、node-role
权限过度分配、突发型集群未配置自动扩缩容。**MEDIUM** = 缺失资源 limits、
add-on 版本落后。**LOW** = 外观性/信息性。

最后给出最重要的 3 项行动。

## 护栏
- **只读**：仅进行描述、评估与建议——绝不应用 manifest、执行扩缩容，或更改
  集群/IAM 配置。
- 每一次严重程度判定都要引用其所依据的具体配置字段、Kubernetes 对象状态或指标。
  如果集群内状态不可用，请如实说明，而不要假定工作负载是健康的。
