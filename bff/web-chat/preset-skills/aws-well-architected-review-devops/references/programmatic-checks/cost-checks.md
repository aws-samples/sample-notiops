# Cost Optimization Pillar — Programmatic Checks

> Record findings with severity: CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## COST-01: Cost Explorer Anomaly Detection

```bash
aws ce get-anomaly-monitors --query 'AnomalyMonitors[].{Name:MonitorName,Type:MonitorType}' --output json 2>/dev/null
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| No monitors | MEDIUM | No Cost Anomaly Detection — unexpected spend won't be caught  `aws ce create-anomaly-monitor --anomaly-monitor MonitorName=service-anomaly,MonitorType=DIMENSIONAL,MonitorDimension=SERVICE` |
| Monitors active | INFO | Cost Anomaly Detection active ✅  — |

---

## COST-02: Idle EC2 Instances (Low CPU)

```bash
# Check for instances with <5% avg CPU over 14 days
for inst in $(aws ec2 describe-instances --filters Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId' --output text); do
  cpu=$(aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization \
    --dimensions Name=InstanceId,Value=$inst --start-time $(date -d '14 days ago' -u +%Y-%m-%dT%H:%M:%S) \
    --end-time $(date -u +%Y-%m-%dT%H:%M:%S) --period 86400 --statistics Average \
    --query 'Datapoints | sort_by(@, &Timestamp) | [-1].Average' --output text 2>/dev/null)
  if [ "$cpu" != "None" ] && [ "$(echo "$cpu < 5" | bc -l 2>/dev/null)" = "1" ]; then
    echo "IDLE: $inst avg_cpu=${cpu}%"
  fi
done
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Instances < 5% CPU avg | HIGH | {count} potentially idle EC2 instances (avg CPU < 5%)  `# ⚠️ verify before run: aws ec2 stop-instances --instance-ids {id}` then evaluate termination after 7 days idle |
| All utilized | INFO | No idle instances detected ✅  — |

---

## COST-03: Unattached EBS Volumes

```bash
aws ec2 describe-volumes --filters Name=status,Values=available \
  --query 'Volumes[].{VolumeId:VolumeId,Size:Size,Type:VolumeType,CreateTime:CreateTime}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Unattached volumes | MEDIUM | {count} unattached EBS volumes ({total_gb} GB) — wasting ${est_monthly}/mo  `# snapshot first: aws ec2 create-snapshot --volume-id {vol} --description 'pre-deletion'; aws ec2 delete-volume --volume-id {vol}` |
| No unattached | INFO | No unattached EBS volumes ✅  — |

---

## COST-04: Elastic IPs Not Associated

```bash
aws ec2 describe-addresses --query 'Addresses[?AssociationId==null].{PublicIp:PublicIp,AllocationId:AllocationId}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Unassociated EIPs | LOW | {count} unassociated Elastic IPs ($3.65/mo each)  `aws ec2 release-address --allocation-id {alloc-id}` |
| All associated | INFO | All Elastic IPs associated ✅  — |

---

## COST-05: Old Generation Instances (Cost Angle)

```bash
# Reuse PERF-01 data — old gen instances cost more per vCPU
aws ec2 describe-instances --filters Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[?starts_with(InstanceType, `t2`) || starts_with(InstanceType, `m4`) || starts_with(InstanceType, `c4`) || starts_with(InstanceType, `r4`)].{Id:InstanceId,Type:InstanceType}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Old gen instances | MEDIUM | {count} old-gen instances — newer generations offer 20-40% better price/perf  Stop+modify: `aws ec2 modify-instance-attribute --instance-id {id} --instance-type '{Value=m6i.large}'`. Save 10-20% |
| All current gen | INFO | All instances on cost-efficient current gen ✅  — |

---

## COST-06: Savings Plans / Reserved Instances Coverage

```bash
aws ce get-savings-plans-coverage --time-period Start=$(date -d '30 days ago' -u +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --query 'SavingsPlansCoverages[-1].CoveragePercentage' --output json 2>/dev/null
aws ce get-reservation-coverage --time-period Start=$(date -d '30 days ago' -u +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --query 'Total.CoverageHours.CoverageHoursPercentage' --output text 2>/dev/null
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Coverage < 50% | HIGH | Savings Plans/RI coverage at {pct}% — significant savings opportunity  `aws ce get-savings-plans-purchase-recommendation --savings-plans-type COMPUTE_SP --term-in-years ONE_YEAR --payment-option NO_UPFRONT --lookback-period-in-days SIXTY_DAYS` then commit |
| Coverage 50-80% | MEDIUM | Savings Plans/RI coverage at {pct}% — room for improvement  Increase commit per Cost Explorer recommendation; aim for 70%+ baseline |
| Coverage > 80% | INFO | Good Savings Plans/RI coverage at {pct}% ✅  — |

---

## COST-07: NAT Gateway Data Transfer

```bash
aws ec2 describe-nat-gateways --filter Name=state,Values=available \
  --query 'NatGateways[].{Id:NatGatewayId,SubnetId:SubnetId,VpcId:VpcId}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Multiple NAT GWs | LOW | {count} NAT Gateways — review if all needed ($32/mo each + data transfer)  Add VPC Gateway endpoint for S3 (free): `aws ec2 create-vpc-endpoint --vpc-id {vpc} --service-name com.amazonaws.{region}.s3 --route-table-ids {rt}`; Interface endpoints for chatty services |
| Single NAT GW | INFO | NAT Gateway configuration noted  — |

---

## COST-08: S3 Storage Classes

```bash
aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | head -20 | while read b; do
  lc=$(aws s3api get-bucket-lifecycle-configuration --bucket "$b" 2>/dev/null)
  if [ $? -ne 0 ]; then echo "NO_LIFECYCLE: $b"; fi
done
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Buckets without lifecycle | MEDIUM | {count} S3 buckets without lifecycle rules — no automatic tiering  `aws s3api put-bucket-lifecycle-configuration --bucket {bucket} --lifecycle-configuration file://lifecycle.json` (transition >30d to IA, >90d to Glacier IR) |
| All with lifecycle | INFO | All S3 buckets have lifecycle policies ✅  — |

---

## COST-09: Orphan EBS Snapshots

```bash
# Find snapshots owned by this account whose source volume no longer exists
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ACTIVE_VOLS=$(aws ec2 describe-volumes --query 'Volumes[].VolumeId' --output text | tr '\t' '\n' | sort)
aws ec2 describe-snapshots --owner-ids "$ACCOUNT_ID" --query 'Snapshots[].{SnapshotId:SnapshotId,VolumeId:VolumeId,StartTime:StartTime,VolumeSize:VolumeSize}' --output json | \
  jq --argjson vols "$(echo "$ACTIVE_VOLS" | jq -R -s 'split("\n") | map(select(. != ""))')" \
  '[.[] | select(.VolumeId as $v | $vols | index($v) | not)]'
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Orphan snapshots found | MEDIUM | {count} EBS snapshots ({total_gb} GB) from deleted volumes — ~${est}/mo wasted  `# verify not needed for AMI: aws ec2 describe-images --filters Name=block-device-mapping.snapshot-id,Values={snap}; aws ec2 delete-snapshot --snapshot-id {snap}` |
| No orphan snapshots | INFO | No orphan EBS snapshots ✅  — |

---

## Summary

| Check | ID | Key Question |
|-------|----|-------------|
| Cost Anomaly | COST-01 | Spend monitoring active? |
| Idle EC2 | COST-02 | Unused compute resources? |
| Unattached EBS | COST-03 | Orphaned storage? |
| Unused EIPs | COST-04 | Idle IP addresses? |
| Old Gen Instances | COST-05 | Outdated instance types? |
| SP/RI Coverage | COST-06 | Commitment discounts? |
| NAT Gateways | COST-07 | Data transfer costs? |
| S3 Lifecycle | COST-08 | Storage tiering? |
| Orphan Snapshots | COST-09 | Stale snapshot costs? |

**Total checks: 9** | Expected time: ~4-6 minutes
