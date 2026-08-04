# Reliability Pillar — Programmatic Checks

> Record findings with severity: CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## REL-01: Multi-AZ RDS

```bash
aws rds describe-db-instances --query 'DBInstances[].{DBId:DBInstanceIdentifier,MultiAZ:MultiAZ,Engine:Engine,Status:DBInstanceStatus}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Production DB not Multi-AZ | HIGH | RDS instance {id} is single-AZ — no automatic failover  `aws rds modify-db-instance --db-instance-identifier {id} --multi-az --apply-immediately` |
| All Multi-AZ | INFO | All RDS instances are Multi-AZ ✅  — |

---

## REL-02: Auto Scaling Groups

```bash
aws autoscaling describe-auto-scaling-groups --query 'AutoScalingGroups[].{Name:AutoScalingGroupName,Min:MinSize,Max:MaxSize,Desired:DesiredCapacity,AZs:AvailabilityZones}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| ASG in single AZ | HIGH | ASG {name} spans only 1 AZ — no cross-AZ resilience  `aws autoscaling update-auto-scaling-group --auto-scaling-group-name {name} --vpc-zone-identifier {subnet1},{subnet2},{subnet3}` |
| Min=Max=1 | MEDIUM | ASG {name} has min=max=1 — no horizontal scaling  `aws autoscaling update-auto-scaling-group --auto-scaling-group-name {name} --min-size 2 --max-size 6 --desired-capacity 2` |
| ASG spans 2+ AZs | INFO | ASG spans multiple AZs ✅  — |

---

## REL-03: ELB Health Checks

```bash
aws elbv2 describe-target-groups --query 'TargetGroups[].{Name:TargetGroupName,HealthCheck:HealthCheckPath,Protocol:Protocol,Port:Port}' --output json
aws elbv2 describe-target-health --target-group-arn {arn} --query 'TargetHealthDescriptions[].{Target:Target.Id,Health:TargetHealth.State}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Unhealthy targets | HIGH | {count} unhealthy targets in target group {name}  Investigate via `aws elbv2 describe-target-health --target-group-arn {arn}`; common fixes: open SG to ALB, fix /health endpoint |
| No health check path | MEDIUM | Target group {name} uses TCP health check (not application-level)  `aws elbv2 modify-target-group --target-group-arn {arn} --health-check-protocol HTTP --health-check-path /health --health-check-interval-seconds 30` |
| All healthy | INFO | All targets healthy ✅  — |

---

## REL-04: AWS Backup Plans

```bash
aws backup list-backup-plans --query 'BackupPlansList[].{Name:BackupPlanName,Id:BackupPlanId}' --output json
aws backup list-protected-resources --query 'Results | length(@)' --output text
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| No backup plans | HIGH | No AWS Backup plans configured — data loss risk  `aws backup create-backup-plan --backup-plan file://backup-plan.json` ([quickstart](https://docs.aws.amazon.com/aws-backup/latest/devguide/create-a-scheduled-backup.html)) |
| Plans exist but few resources | MEDIUM | Only {count} resources protected by AWS Backup  `aws backup create-backup-selection --backup-plan-id {id} --backup-selection file://selection.json` |
| Comprehensive coverage | INFO | AWS Backup protecting {count} resources ✅  — |

---

## REL-05: Route 53 Health Checks

```bash
aws route53 list-health-checks --query 'HealthChecks[].{Id:Id,Type:HealthCheckConfig.Type,FQDN:HealthCheckConfig.FullyQualifiedDomainName}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| No health checks | MEDIUM | No Route 53 health checks — no DNS-level failover  `aws route53 create-health-check --caller-reference $(date +%s) --health-check-config Type=HTTPS,FullyQualifiedDomainName={domain},Port=443,ResourcePath=/health,RequestInterval=30,FailureThreshold=3` |
| Health checks configured | INFO | Route 53 health checks active ✅  — |

---

## REL-06: EKS Node Groups (if EKS present)

```bash
for cluster in $(aws eks list-clusters --query 'clusters[]' --output text); do
  aws eks list-nodegroups --cluster-name "$cluster" --query 'nodegroups[]' --output text | tr '\t' '\n' | while read ng; do
    aws eks describe-nodegroup --cluster-name "$cluster" --nodegroup-name "$ng" \
      --query '{Name:nodegroupName,Min:scalingConfig.minSize,Max:scalingConfig.maxSize,Desired:scalingConfig.desiredSize,Subnets:subnets}' --output json
  done
done
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Single-AZ nodegroup | HIGH | EKS nodegroup {name} in single AZ  Recreate: `aws eks create-nodegroup --cluster-name {cluster} --nodegroup-name v2 --subnets {s1} {s2} {s3} --instance-types m6i.large --scaling-config minSize=2,maxSize=10,desiredSize=3 --node-role {role}` (cannot modify AZs in-place) |
| Min=Desired=1 | MEDIUM | EKS nodegroup {name} has no scaling headroom  `aws eks update-nodegroup-config --cluster-name {cluster} --nodegroup-name {ng} --scaling-config minSize=2,maxSize=10,desiredSize=3` |
| Multi-AZ, scaling configured | INFO | EKS nodegroup properly configured ✅  — |

---

## REL-07: S3 Versioning

```bash
aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | while read b; do
  ver=$(aws s3api get-bucket-versioning --bucket "$b" --query 'Status' --output text)
  if [ "$ver" != "Enabled" ]; then echo "WARN: $b — versioning $ver"; fi
done
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Critical buckets unversioned | MEDIUM | {count} S3 buckets without versioning  `aws s3api put-bucket-versioning --bucket {bucket} --versioning-configuration Status=Enabled` |
| All versioned | INFO | All S3 buckets have versioning ✅  — |

---

## REL-08: DynamoDB Point-in-Time Recovery

```bash
aws dynamodb list-tables --query 'TableNames[]' --output text | tr '\t' '\n' | while read t; do
  pitr=$(aws dynamodb describe-continuous-backups --table-name "$t" --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' --output text)
  if [ "$pitr" != "ENABLED" ]; then echo "WARN: $t — PITR $pitr"; fi
done
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Tables without PITR | MEDIUM | {count} DynamoDB tables without point-in-time recovery  `aws dynamodb update-continuous-backups --table-name {name} --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true` |
| All PITR enabled | INFO | All DynamoDB tables have PITR ✅  — |

---

## REL-09: Lambda Reserved/Provisioned Concurrency

```bash
aws lambda list-functions --query 'Functions[].FunctionName' --output text | tr '\t' '\n' | while read fn; do
  conc=$(aws lambda get-function-concurrency --function-name "$fn" --query 'ReservedConcurrentExecutions' --output text 2>/dev/null)
  echo "$fn: reserved=$conc"
done
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Critical functions unreserved | LOW | Lambda {fn} has no reserved concurrency — throttling risk under load  `aws lambda put-function-concurrency --function-name {name} --reserved-concurrent-executions {N}` |
| Reserved concurrency set | INFO | Lambda concurrency configured ✅  — |

---

## REL-10: RDS Backup Retention Period

```bash
aws rds describe-db-instances --query 'DBInstances[].{DBId:DBInstanceIdentifier,BackupRetention:BackupRetentionPeriod,Engine:Engine}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Retention ≤ 7 days (default) | MEDIUM | RDS {id} backup retention at {days} days — insufficient for production recovery  `aws rds modify-db-instance --db-instance-identifier {id} --backup-retention-period 14 --apply-immediately` |
| Retention 0 (disabled) | HIGH | RDS {id} automated backups disabled — no point-in-time recovery  `aws rds modify-db-instance --db-instance-identifier {id} --backup-retention-period 14 --apply-immediately` |
| Retention ≥ 14 days | INFO | RDS backup retention adequate ✅  — |

---

## REL-11: Service Quotas Utilization

```bash
# Check EC2 On-Demand instance quota utilization
aws service-quotas list-service-quotas --service-code ec2 --query 'Quotas[?UsageMetric!=null].{Name:QuotaName,Value:Value,UsageMetric:UsageMetric}' --output json 2>/dev/null
# Check high-utilization quotas via Trusted Advisor (if available)
aws support describe-trusted-advisor-check-result --check-id eW7HH0l7J9 --language en --query 'result.flaggedResources[].metadata' --output json 2>/dev/null
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Quota > 80% utilized | HIGH | Service quota {name} at {pct}% — capacity exhaustion risk  `aws service-quotas request-service-quota-increase --service-code {svc} --quota-code {code} --desired-value {new_value}` |
| Quota 60-80% utilized | MEDIUM | Service quota {name} at {pct}% — approaching limit  Request proactive increase: `aws service-quotas request-service-quota-increase --service-code {svc} --quota-code {code} --desired-value {new_value}` |
| All quotas < 60% | INFO | Service quotas within safe utilization ✅  — |

---

## Summary

| Check | ID | Key Question |
|-------|----|-------------|
| Multi-AZ RDS | REL-01 | Database failover capability? |
| Auto Scaling | REL-02 | Horizontal scaling + multi-AZ? |
| ELB Health | REL-03 | Are backends healthy? |
| AWS Backup | REL-04 | Is data protected? |
| Route 53 | REL-05 | DNS-level failover? |
| EKS Nodes | REL-06 | Container resilience? |
| S3 Versioning | REL-07 | Object recovery? |
| DynamoDB PITR | REL-08 | Table recovery? |
| Lambda Concurrency | REL-09 | Function throttling protection? |
| RDS Backup Retention | REL-10 | Sufficient backup window? |
| Service Quotas | REL-11 | Capacity headroom adequate? |

**Total checks: 11** | Expected time: ~4-6 minutes
