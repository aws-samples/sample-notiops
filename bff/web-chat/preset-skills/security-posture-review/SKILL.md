---
name: security-posture-review
name-en: Security Posture Review
name-zh: 安全态势检查
description-en: Review AWS resources for common security misconfigurations — security groups open to the world, publicly accessible databases and storage, unencrypted volumes or databases, and overly permissive network exposure. Produces a severity-ranked findings report; read-only, no changes made.
description-zh: 检查 AWS 资源中常见的安全配置错误——对全网开放的安全组、可公开访问的数据库与存储、未加密的卷或数据库，以及过度宽松的网络暴露。产出按严重程度排序的问题报告；只读，不做任何变更。
description: Review the security posture of AWS resources for common misconfigurations — security groups open to the world, publicly accessible databases and storage, unencrypted volumes or databases, and overly permissive network exposure. Use when the user asks about security, exposure, whether something is publicly accessible, open ports, security group review, or a security best-practice check. Produces a severity-ranked findings report; read-only, no changes made.
---

# Security Posture Review

You are performing a **read-only** security review. You identify exposure and misconfiguration
and recommend remediation — you never change a security group, policy, or resource. Every
finding is backed by a resource attribute returned from a tool.

## When to use
- The user asks about security, "is this exposed", "open ports", "public access", security
  group review, or a general security best-practice check.

## What to check

1. **Security groups open to the world.** Inspect security group ingress rules for
   `0.0.0.0/0` (or `::/0`) on sensitive ports — SSH (22), RDP (3389), database ports
   (3306/5432/1433/6379/27017), and any admin port. World-open admin/DB ports → HIGH/CRITICAL.
2. **Publicly accessible databases.** RDS instances with `PubliclyAccessible=true` → HIGH.
3. **Public storage / snapshots.** Flag S3 buckets or snapshots that appear public where the
   tools expose that attribute.
4. **Unencrypted data at rest.** EBS volumes / RDS storage without encryption → MEDIUM/HIGH
   depending on data sensitivity.
5. **Instance exposure.** EC2 instances with public IPs sitting behind world-open security
   groups → correlate the two into a single high-priority finding.

Use resource-specific tools first; for anything they don't cover, use the general read-only
AWS query capability to describe the resource. Everything stays read-only.

## Report format

| Severity | Finding | Resource | Evidence | Remediation |
|---|---|---|---|---|
| CRITICAL / HIGH / MEDIUM / LOW | … | id/arn | rule/attr from tool | least-privilege fix |

Severity guide: **CRITICAL** = world-open admin/DB port on a reachable resource.
**HIGH** = publicly accessible database, world-open sensitive port. **MEDIUM** = unencrypted
at rest, broad-but-not-world exposure. **LOW** = informational / hardening.

Close with the top 3 fixes (as recommendations, phrased for least privilege) and an offer to
save the full report.

## Guardrails
- Read-only: never modify a security group, policy, or resource. Recommend; don't remediate.
- Cite the exact rule / attribute each finding is based on — no "looks risky" without evidence.
- Remediation guidance follows least privilege (scope to specific CIDRs / prefix lists, not
  just "close the port").
