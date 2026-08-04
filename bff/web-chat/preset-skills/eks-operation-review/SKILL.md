---
name: eks-operation-review
name-en: EKS Operation Review
name-zh: EKS 运维审查
description-en: Comprehensive best-practice review of an Amazon EKS cluster across reliability, security, cost, networking, and scalability — control-plane and node-group config, add-on and Kubernetes version currency, workload health (pods/deployments/events), autoscaling, and IAM/IRSA posture. Publishing to AWS DevOps Agent unlocks in-cluster deep review.
description-zh: 对 Amazon EKS 集群进行覆盖可靠性、安全、成本、网络与可扩展性的最佳实践审查——控制面与节点组配置、插件与 Kubernetes 版本时效性、工作负载健康（Pod/Deployment/事件）、自动扩缩容，以及 IAM/IRSA 权限态势。发布到 AWS DevOps Agent 可解锁集群内部的深度审查。
description: Comprehensive best-practice review of an Amazon EKS cluster across reliability, security, cost, networking, and scalability — control-plane and node-group configuration, add-on and Kubernetes version currency, workload health (pods/deployments/events), autoscaling, and IAM/IRSA posture. Use when the user asks about EKS or Kubernetes cluster health, whether a cluster follows best practices, why pods are failing, cluster reliability/security, or an EKS operational concern. Publishing to AWS DevOps Agent unlocks in-cluster deep review.
---

# EKS Operation Review

You are performing a **read-only** best-practice review of an Amazon EKS cluster spanning
reliability, security, cost, networking, and scalability.

> Adapted for NotiOps from the open-source `aws-samples/sample-devops-agent-tools`
> `eks-operation-review` skill. This skill runs locally like any other, but a thorough EKS review
> also needs live Kubernetes state (pods, deployments, events, node pressure) beyond the AWS
> control plane. NotiOps' local read-only tools can only see the EKS control plane — so for the
> deepest review, **publish this skill to AWS DevOps Agent** and run it with the DevOps Agent
> switch on, which lets a deep investigation reach into the cluster itself.

## When to use
- The user asks about EKS / Kubernetes cluster health, best practices, pod failures, cluster
  reliability or security, or an EKS operational concern.

## Review dimensions

1. **Control plane & versions.** EKS cluster version vs the currently supported window; flag
   versions near or past end-of-support. Managed add-ons (VPC CNI, CoreDNS, kube-proxy) present
   and up to date. Control-plane logging (api, audit, authenticator) enabled.
2. **Node groups & compute.** Managed vs self-managed node groups; instance types and capacity
   type (On-Demand / Spot); desired/min/max and whether Cluster Autoscaler or Karpenter is in
   place. Nodes spread across ≥ 2 AZs for resiliency. Right-sizing from node CPU/memory pressure.
3. **Workload health.** Pods in CrashLoopBackOff / Pending / Evicted; deployments with unavailable
   replicas; recent warning events; missing resource requests/limits; single-replica critical
   workloads; PodDisruptionBudgets for HA.
4. **Networking.** VPC CNI IP exhaustion risk; security groups and their exposure; public vs
   private API endpoint; ingress/load-balancer configuration.
5. **Security / IAM.** IRSA (IAM Roles for Service Accounts) vs node-role over-permissioning;
   `aws-auth` / access-entry review; secrets encryption (KMS) enabled; least-privilege posture.
6. **Cost.** Idle / over-provisioned node groups; Spot opportunities for fault-tolerant workloads;
   unused persistent volumes.

## Report format

Give the cluster an overall grade, then findings ranked by severity:

| Severity | Dimension | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| CRITICAL / HIGH / MEDIUM / LOW | Reliability / Security / Cost / Networking / Scalability | … | control-plane config, K8s object state, or metric | … |

Severity guide: **CRITICAL** = active outage risk (single-AZ nodes for prod, EOL cluster version,
IP exhaustion imminent). **HIGH** = public API endpoint without restriction, node-role
over-permissioning, no autoscaling on a bursty cluster. **MEDIUM** = missing resource limits,
add-ons behind. **LOW** = cosmetic/informational.

Close with the top 3 actions.

## Guardrails
- **Read-only**: describe, assess, and recommend only — never apply a manifest, scale, or change
  cluster/IAM configuration.
- Every severity call cites the specific config field, Kubernetes object state, or metric it is
  based on. If in-cluster state is unavailable, say so rather than assuming workloads are healthy.
