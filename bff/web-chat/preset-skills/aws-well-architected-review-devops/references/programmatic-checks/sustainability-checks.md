# Sustainability Pillar — Programmatic Checks

> Record findings with severity: CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## SUS-01: Graviton (ARM64) Adoption

```bash
aws ec2 describe-instances --filters Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].{Id:InstanceId,Type:InstanceType,Arch:Architecture}' --output json
```

Count instances by architecture. AWS reports Graviton-based instances can use **up to 60% less energy for the same performance** than comparable x86 instances, at better price-performance ([AWS Graviton][graviton], [WA Sustainability pillar][sus]). Figures below are the AWS-published "up to" headlines — actual savings vary by workload.

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| 0% Graviton adoption | MEDIUM | No Graviton instances — significant energy efficiency opportunity  Migrate to Graviton (m7g/c7g/r7g): rebuild ARM-compatible AMIs/containers, then `aws ec2 modify-instance-attribute --instance-id {id} --instance-type '{Value=m7g.large}'`. Better price-performance + lower energy ([source][graviton]). |
| < 30% Graviton | LOW | {pct}% Graviton adoption — room for improvement  Migrate to Graviton (m7g/c7g/r7g): rebuild ARM-compatible AMIs/containers, then `aws ec2 modify-instance-attribute --instance-id {id} --instance-type '{Value=m7g.large}'`. Better price-performance + lower energy ([source][graviton]). |
| > 30% Graviton | INFO | Good Graviton adoption at {pct}% ✅  Migrate remaining x86 to Graviton (m7g/c7g/r7g) where ARM-compatible ([source][graviton]). |

---

## SUS-02: EC2 Instance Utilization

```bash
# Average CPU across all instances over 7 days
for inst in $(aws ec2 describe-instances --filters Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId' --output text | tr '\t' '\n' | head -10); do
  cpu=$(aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization \
    --dimensions Name=InstanceId,Value=$inst --start-time $(date -d '7 days ago' -u +%Y-%m-%dT%H:%M:%S) \
    --end-time $(date -u +%Y-%m-%dT%H:%M:%S) --period 604800 --statistics Average \
    --query 'Datapoints[0].Average' --output text 2>/dev/null)
  echo "$inst: avg_cpu=${cpu}%"
done
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Average CPU < 10% fleet-wide | MEDIUM | Fleet under-utilized — right-sizing reduces energy waste  Right-size aggressively or terminate idle instances |
| Average CPU 10-40% | LOW | Moderate utilization — some right-sizing opportunity  Apply Compute Optimizer right-sizing recommendations |
| Average CPU > 40% | INFO | Fleet well-utilized ✅  — |

---

## SUS-03: Lambda Runtime Efficiency

```bash
aws lambda list-functions --query 'Functions[].{Name:FunctionName,Runtime:Runtime,Arch:Architectures[0],Memory:MemorySize}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Functions on x86_64 | LOW | {count} Lambda functions on x86_64 — arm64/Graviton2 offers better price-performance  `aws lambda update-function-configuration --function-name {name} --architectures arm64` (rebuild deps). AWS: up to 34% better price-performance on arm64 ([Lambda arm64][lambda-arm]) |
| Functions on deprecated runtimes | LOW | {count} functions on older runtimes (less efficient)  `aws lambda update-function-configuration --function-name {name} --runtime python3.12` |
| arm64 + current runtimes | INFO | Lambda using efficient configurations ✅  — |

---

## SUS-04: S3 Intelligent Tiering

```bash
aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | head -20 | while read b; do
  it=$(aws s3api get-bucket-intelligent-tiering-configuration --bucket "$b" --id default 2>/dev/null)
  if [ $? -ne 0 ]; then echo "NO_IT: $b"; fi
done
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Large buckets without intelligent tiering | LOW | {count} buckets without Intelligent Tiering — cold data uses unnecessary storage  `aws s3api put-bucket-intelligent-tiering-configuration --bucket {bucket} --id default --intelligent-tiering-configuration Id=default,Status=Enabled,Tierings=[{Days=90,AccessTier=ARCHIVE_ACCESS},{Days=180,AccessTier=DEEP_ARCHIVE_ACCESS}]` |
| Tiering configured | INFO | S3 Intelligent Tiering in use ✅  — |

---

## SUS-05: Auto Scaling Efficiency

```bash
aws autoscaling describe-auto-scaling-groups --query 'AutoScalingGroups[].{Name:AutoScalingGroupName,Min:MinSize,Max:MaxSize,Desired:DesiredCapacity}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Min == Max (no scaling) | LOW | ASG {name} cannot scale — over-provisioning wastes energy  `aws autoscaling put-scaling-policy --auto-scaling-group-name {name} --policy-name cpu-target --policy-type TargetTrackingScaling --target-tracking-configuration file://policy.json` |
| Dynamic scaling active | INFO | Auto Scaling configured for demand-driven capacity ✅  — |

---

## Summary

| Check | ID | Key Question |
|-------|----|-------------|
| Graviton Adoption | SUS-01 | Using energy-efficient processors? |
| Instance Utilization | SUS-02 | Right-sized compute? |
| Lambda Efficiency | SUS-03 | Efficient serverless config? |
| S3 Tiering | SUS-04 | Optimized storage? |
| Auto Scaling | SUS-05 | Demand-driven capacity? |

**Total checks: 5** | Expected time: ~2-3 minutes

---

## Sources

Quantitative claims above are AWS-published "up to" figures; realized savings
depend on the workload. Cite these when reporting findings:

- [graviton]: AWS Graviton — energy efficiency & price-performance — https://aws.amazon.com/ec2/graviton/
- [sus]: AWS Well-Architected Framework, Sustainability Pillar (SUS05 — hardware & services) — https://docs.aws.amazon.com/wellarchitected/latest/sustainability-pillar/sustainability-pillar.html
- [lambda-arm]: AWS Lambda — arm64 (Graviton2) price-performance — https://docs.aws.amazon.com/lambda/latest/dg/foundation-arch.html

[graviton]: https://aws.amazon.com/ec2/graviton/
[sus]: https://docs.aws.amazon.com/wellarchitected/latest/sustainability-pillar/sustainability-pillar.html
[lambda-arm]: https://docs.aws.amazon.com/lambda/latest/dg/foundation-arch.html
