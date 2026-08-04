# Security Pillar — Programmatic Checks

> Execute these checks in order. Each check uses AWS CLI (read-only).
> Record findings with severity: CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## SEC-01: GuardDuty Status

**WA Mapping**: SEC04.BP04 (Initiate remediation for non-compliant resources / Detect threats)

```bash
aws guardduty list-detectors --query 'DetectorIds' --output json
# If empty → CRITICAL: GuardDuty not enabled
# If found → check each detector:
aws guardduty get-detector --detector-id {id} --query '{Status:Status,FindingPublishingFrequency:FindingPublishingFrequency}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| No detectors | CRITICAL | GuardDuty not enabled — no threat detection  `aws guardduty create-detector --enable --finding-publishing-frequency FIFTEEN_MINUTES` |
| Status=DISABLED | CRITICAL | GuardDuty detector disabled  `aws guardduty update-detector --detector-id {id} --enable` |
| Status=ENABLED | INFO | GuardDuty active ✅  — |

---

## SEC-02: Security Hub Status

**WA Mapping**: SEC04.BP04 (Initiate remediation for non-compliant resources)

```bash
aws securityhub describe-hub --output json 2>/dev/null
# If error → Security Hub not enabled
aws securityhub get-findings --filters '{"SeverityLabel":[{"Value":"CRITICAL","Comparison":"EQUALS"}]}' --max-items 5 --query 'Findings[].{Title:Title,Severity:Severity.Label,Resource:Resources[0].Id}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Not enabled | HIGH | Security Hub not enabled — no centralized security view  `aws securityhub enable-security-hub --enable-default-standards` |
| Enabled, CRITICAL findings | HIGH | {count} unresolved CRITICAL Security Hub findings | Manual: triage in Security Hub console; for each finding follow its `Remediation.Recommendation.Url`. Bulk update via `aws securityhub batch-update-findings` after fix |
| Enabled, no CRITICAL | INFO | Security Hub active, no critical findings ✅  — |

---

## SEC-03: CloudTrail Status

**WA Mapping**: SEC04.BP01 (Configure service and application logging)

```bash
aws cloudtrail describe-trails --query 'trailList[].{Name:Name,IsMultiRegion:IsMultiRegionTrail,IsLogging:HasCustomEventSelectors,S3Bucket:S3BucketName}' --output json
aws cloudtrail get-trail-status --name {trail-name} --query '{IsLogging:IsLogging,LatestDeliveryTime:LatestDeliveryTime}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| No trails | CRITICAL | CloudTrail not configured — no API audit logging  `aws cloudtrail create-trail --name org-trail --s3-bucket-name {bucket} --is-multi-region-trail --enable-log-file-validation && aws cloudtrail start-logging --name org-trail` |
| Trail exists but not logging | HIGH | CloudTrail trail exists but logging stopped  `aws cloudtrail start-logging --name {trail}` |
| Multi-region trail active | INFO | CloudTrail active with multi-region ✅  — |

---

## SEC-04: IAM Password Policy

**WA Mapping**: SEC02.BP01 (Use strong sign-in mechanisms)

```bash
aws iam get-account-password-policy --output json 2>/dev/null
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| No policy set | MEDIUM | No IAM password policy — weak password risk  `aws iam update-account-password-policy --minimum-password-length 14 --require-symbols --require-numbers --require-uppercase-characters --require-lowercase-characters --max-password-age 90 --password-reuse-prevention 24` |
| MinPasswordLength < 14 | MEDIUM | Password minimum length below 14 characters  `aws iam update-account-password-policy --minimum-password-length 14 --require-symbols --require-numbers --require-uppercase-characters --require-lowercase-characters --max-password-age 90 --password-reuse-prevention 24` |
| RequireSymbols=false | LOW | Password policy does not require symbols  `aws iam update-account-password-policy --require-symbols --require-numbers` |
| All strong | INFO | Password policy meets best practices ✅  — |

---

## SEC-05: IAM Access Keys Age

**WA Mapping**: SEC02.BP05 (Audit and rotate credentials periodically)

```bash
aws iam generate-credential-report >/dev/null 2>&1; sleep 2
aws iam get-credential-report --query 'Content' --output text | base64 -d | awk -F',' 'NR>1 && $9!="N/A" {split($9,a,"T"); if (systime()-mktime(gensub(/-/," ","g",a[1])" 0 0 0") > 7776000) print $1": key age > 90 days"}'
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Keys > 90 days | HIGH | {count} IAM users with access keys older than 90 days  `# rotate: aws iam create-access-key --user-name {user}` then `aws iam update-access-key --access-key-id {old} --status Inactive --user-name {user}` |
| Keys > 180 days | CRITICAL | {count} IAM users with access keys older than 180 days  `# ⚠️ verify before run: aws iam delete-access-key --access-key-id {key} --user-name {user}` |
| All < 90 days | INFO | All access keys within rotation policy ✅  — |

---

## SEC-06: Root Account MFA

**WA Mapping**: SEC01.BP02 (Secure account root user and properties)

```bash
aws iam get-account-summary --query 'SummaryMap.AccountMFAEnabled' --output text
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| 0 | CRITICAL | Root account MFA not enabled  Manual: sign in as root → IAM console → My security credentials → Assign virtual MFA. CLI cannot enable root MFA. |
| 1 | INFO | Root account MFA enabled ✅  — |

---

## SEC-07: S3 Public Access

**WA Mapping**: SEC03.BP07 (Analyze public and cross-account access)

```bash
aws s3control get-public-access-block --account-id $(aws sts get-caller-identity --query Account --output text) --output json 2>/dev/null
# Per-bucket check:
aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | while read b; do
  result=$(aws s3api get-public-access-block --bucket "$b" 2>/dev/null)
  if [ $? -ne 0 ]; then echo "WARN: $b — no public access block"; fi
done
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Account-level block disabled | HIGH | Account-level S3 public access block not enabled  `aws s3control put-public-access-block --account-id {account} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true` |
| Buckets without block | MEDIUM | {count} S3 buckets without public access block  `aws s3api put-public-access-block --bucket {bucket} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true` |
| All blocked | INFO | S3 public access blocked at account level ✅  — |

---

## SEC-08: EBS Encryption Default

**WA Mapping**: SEC08.BP02 (Enforce encryption at rest)

```bash
aws ec2 get-ebs-encryption-by-default --query 'EbsEncryptionByDefault' --output text
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| false | MEDIUM | EBS encryption by default not enabled  `aws ec2 enable-ebs-encryption-by-default --region {region}` |
| true | INFO | EBS encryption by default enabled ✅  — |

---

## SEC-09: Security Groups — Public Ingress

**WA Mapping**: SEC05.BP02 (Control traffic at all layers)

```bash
aws ec2 describe-security-groups --filters Name=ip-permission.cidr,Values=0.0.0.0/0 --query 'SecurityGroups[].{GroupId:GroupId,GroupName:GroupName,Rules:IpPermissions[?IpRanges[?CidrIp==`0.0.0.0/0`]].{Proto:IpProtocol,FromPort:FromPort,ToPort:ToPort}}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| SG allows 0.0.0.0/0 to SSH (22) | CRITICAL | Security Group {id} allows SSH from internet  `# ⚠️ verify before run: aws ec2 revoke-security-group-ingress --group-id {sg} --protocol tcp --port 22 --cidr 0.0.0.0/0` then add restricted CIDR or use SSM Session Manager |
| SG allows 0.0.0.0/0 to RDP (3389) | CRITICAL | Security Group {id} allows RDP from internet  `# ⚠️ verify before run: aws ec2 revoke-security-group-ingress --group-id {sg} --protocol tcp --port 3389 --cidr 0.0.0.0/0` then use SSM/bastion |
| SG allows 0.0.0.0/0 to all ports | CRITICAL | Security Group {id} allows all traffic from internet | `# ⚠️ verify before run: aws ec2 revoke-security-group-ingress --group-id {sg} --ip-permissions IpProtocol=-1,IpRanges='[{CidrIp=0.0.0.0/0}]'` then add restricted rules per service |
| SG allows 0.0.0.0/0 to 443/80 only | LOW | Security Group {id} allows HTTP/HTTPS from internet (may be intentional)  Acceptable for ALB/CloudFront origins; for direct EC2 add WAF or restrict to ALB SG |
| No public ingress | INFO | No security groups with unrestricted public ingress ✅  — |

---

## SEC-10: RDS Encryption

**WA Mapping**: SEC08.BP02 (Enforce encryption at rest)

```bash
aws rds describe-db-instances --query 'DBInstances[].{DBId:DBInstanceIdentifier,Encrypted:StorageEncrypted,Engine:Engine}' --output json
aws rds describe-db-clusters --query 'DBClusters[].{ClusterId:DBClusterIdentifier,Encrypted:StorageEncrypted,Engine:Engine}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Unencrypted instances | HIGH | {count} RDS instances without encryption at rest  Snapshot+restore: `aws rds create-db-snapshot --db-instance-identifier {id} --db-snapshot-identifier {id}-pre`; `aws rds copy-db-snapshot --source-db-snapshot-identifier {id}-pre --target-db-snapshot-identifier {id}-enc --kms-key-id alias/aws/rds`; `aws rds restore-db-instance-from-db-snapshot --db-instance-identifier {id}-new --db-snapshot-identifier {id}-enc` |
| All encrypted | INFO | All RDS instances encrypted ✅  — |

---

## SEC-11: VPC Flow Logs

**WA Mapping**: SEC04.BP01 (Configure service and application logging)

```bash
aws ec2 describe-vpcs --query 'Vpcs[].VpcId' --output text | tr '\t' '\n' | while read vpc; do
  logs=$(aws ec2 describe-flow-logs --filter Name=resource-id,Values=$vpc --query 'FlowLogs[0].FlowLogId' --output text)
  if [ "$logs" = "None" ]; then echo "WARN: $vpc — no flow logs"; fi
done
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| VPC without flow logs | MEDIUM | VPC {id} has no flow logs — limited network visibility  `aws ec2 create-flow-logs --resource-type VPC --resource-ids {vpc} --traffic-type ALL --log-destination-type cloud-watch-logs --log-group-name /aws/vpc/flowlogs --deliver-logs-permission-arn {role-arn}` |
| All VPCs have flow logs | INFO | All VPCs have flow logs enabled ✅  — |

---

## SEC-12: KMS Key Rotation

**WA Mapping**: SEC08.BP01 (Implement secure key management)

```bash
aws kms list-keys --query 'Keys[].KeyId' --output text | tr '\t' '\n' | while read key; do
  mgr=$(aws kms describe-key --key-id "$key" --query 'KeyMetadata.KeyManager' --output text)
  if [ "$mgr" = "CUSTOMER" ]; then
    rot=$(aws kms get-key-rotation-status --key-id "$key" --query 'KeyRotationEnabled' --output text)
    if [ "$rot" = "False" ]; then echo "WARN: $key — rotation disabled"; fi
  fi
done
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Customer keys without rotation | MEDIUM | {count} KMS customer keys without automatic rotation  `aws kms enable-key-rotation --key-id {key-id}` |
| All rotated | INFO | All customer KMS keys have rotation enabled ✅  — |

---

## SEC-13: EC2 IMDSv2 Enforcement

**WA Mapping**: SEC06.BP02 (Protect compute — require IMDSv2 to prevent SSRF credential theft)

```bash
aws ec2 describe-instances --filters Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].{Id:InstanceId,Name:Tags[?Key==`Name`].Value|[0],HttpTokens:MetadataOptions.HttpTokens,HttpEndpoint:MetadataOptions.HttpEndpoint}' --output json
# HttpTokens=optional means IMDSv1 is allowed (vulnerable to SSRF)
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| HttpTokens=optional | HIGH | {count} EC2 instances allow IMDSv1 — SSRF credential theft risk  `aws ec2 modify-instance-metadata-options --instance-id {id} --http-tokens required --http-put-response-hop-limit 2` |
| All HttpTokens=required | INFO | All instances enforce IMDSv2 ✅  — |

---

## SEC-14: IAM Access Analyzer

**WA Mapping**: SEC03.BP07 (Analyze public and cross-account access)

```bash
aws accessanalyzer list-analyzers --query 'analyzers[].{Name:name,Type:type,Status:status}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| No analyzer | HIGH | IAM Access Analyzer not enabled — undetected external access risk  `aws accessanalyzer create-analyzer --analyzer-name account-analyzer --type ACCOUNT` |
| Analyzer with active findings | MEDIUM | Access Analyzer has {count} active findings — external access detected  `aws accessanalyzer list-findings --analyzer-arn {arn} --filter '{"status":{"eq":["ACTIVE"]}}'` then archive or remediate each |
| Analyzer active, no findings | INFO | IAM Access Analyzer active, no external access findings ✅  — |

---

## SEC-15: Secrets Manager Rotation

**WA Mapping**: SEC02.BP05 (Audit and rotate credentials periodically)

```bash
aws secretsmanager list-secrets --query 'SecretList[].{Name:Name,RotationEnabled:RotationEnabled,LastRotated:LastRotatedDate}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Secrets without rotation | MEDIUM | {count} secrets without automatic rotation configured  `aws secretsmanager rotate-secret --secret-id {name} --rotation-lambda-arn {lambda-arn} --rotation-rules AutomaticallyAfterDays=30` |
| Secrets not rotated > 90 days | HIGH | {count} secrets not rotated in over 90 days  Trigger immediate rotation: `aws secretsmanager rotate-secret --secret-id {name}` then verify application connectivity |
| All rotating | INFO | All secrets have automatic rotation ✅  — |

---

## Summary

| Check | ID | Key Question |
|-------|----|-------------|
| GuardDuty | SEC-01 | Is threat detection active? |
| Security Hub | SEC-02 | Is there a centralized security view? |
| CloudTrail | SEC-03 | Are API calls audited? |
| Password Policy | SEC-04 | Are passwords strong? |
| Access Key Age | SEC-05 | Are keys rotated regularly? |
| Root MFA | SEC-06 | Is root protected? |
| S3 Public Access | SEC-07 | Is data exposure prevented? |
| EBS Encryption | SEC-08 | Is storage encrypted by default? |
| Public SGs | SEC-09 | Is network access restricted? |
| RDS Encryption | SEC-10 | Is database data encrypted? |
| VPC Flow Logs | SEC-11 | Is network traffic logged? |
| KMS Rotation | SEC-12 | Are encryption keys rotated? |
| IMDSv2 Enforcement | SEC-13 | Is SSRF credential theft prevented? |
| Access Analyzer | SEC-14 | Is external access detected? |
| Secrets Rotation | SEC-15 | Are secrets rotated automatically? |

**Total checks: 15** | Expected time: ~4-6 minutes
