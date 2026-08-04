# Operational Excellence Pillar — Programmatic Checks

> Execute these checks in order. Record findings with severity: CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## OPS-01: AWS Config Status

```bash
aws configservice describe-configuration-recorders --query 'ConfigurationRecorders[].{Name:name,Recording:recordingGroup.allSupported}' --output json
aws configservice describe-configuration-recorder-status --query 'ConfigurationRecordersStatus[].{Name:name,Recording:recording,LastStatus:lastStatus}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| No recorder | HIGH | AWS Config not enabled — no configuration drift detection  `aws configservice put-configuration-recorder --configuration-recorder name=default,roleARN={role-arn} --recording-group allSupported=true,includeGlobalResourceTypes=true && aws configservice put-delivery-channel --delivery-channel name=default,s3BucketName={bucket} && aws configservice start-configuration-recorder --configuration-recorder-name default` |
| Recorder not recording | HIGH | AWS Config recorder stopped  `aws configservice start-configuration-recorder --configuration-recorder-name default` |
| Recording, allSupported=true | INFO | AWS Config active, recording all resources ✅  — |

---

## OPS-02: CloudWatch Alarms

```bash
aws cloudwatch describe-alarms --state-value ALARM --query 'MetricAlarms[].{Name:AlarmName,Metric:MetricName,State:StateValue}' --output json
aws cloudwatch describe-alarms --query 'MetricAlarms | length(@)' --output text
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Zero alarms configured | HIGH | No CloudWatch alarms — no proactive monitoring  Create baseline: CPU, status check, billing, error rate per service via CloudFormation/CDK |
| Active ALARM state alarms | MEDIUM | {count} alarms currently in ALARM state | Investigate root cause: `aws cloudwatch describe-alarms --state-value ALARM --query 'MetricAlarms[].{Name:AlarmName,Reason:StateReason}'` then fix underlying metric source |
| Alarms configured, none firing | INFO | CloudWatch alarms healthy ✅  — |

---

## OPS-03: CloudWatch Log Groups Retention

```bash
aws logs describe-log-groups --query 'logGroups[?retentionInDays==null].{Name:logGroupName,StoredBytes:storedBytes}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Groups with no retention | MEDIUM | {count} log groups with no retention policy (unlimited storage cost)  `aws logs put-retention-policy --log-group-name {name} --retention-in-days 90` (adjust 30/90/365 per compliance) |
| All have retention | INFO | All log groups have retention policies ✅  — |

---

## OPS-04: Systems Manager Patch Compliance

```bash
aws ssm describe-instance-patch-states --query 'InstancePatchStates[?MissingCount>`0`].{InstanceId:InstanceId,Missing:MissingCount,Failed:FailedCount}' --output json 2>/dev/null
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Instances with missing patches | MEDIUM | {count} instances with missing patches  `aws ssm send-command --document-name AWS-RunPatchBaseline --targets Key=instanceids,Values={id} --parameters Operation=Install` |
| No SSM data | LOW | SSM patch compliance not configured  Install SSM Agent (Amazon Linux/Ubuntu pre-installed); attach `AmazonSSMManagedInstanceCore` to instance role |
| All compliant | INFO | All instances patch compliant ✅  — |

---

## OPS-05: CloudFormation Stack Health

```bash
aws cloudformation list-stacks --stack-status-filter ROLLBACK_COMPLETE UPDATE_ROLLBACK_COMPLETE CREATE_FAILED --query 'StackSummaries[].{Name:StackName,Status:StackStatus,Time:LastUpdatedTimestamp}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Failed/rollback stacks | MEDIUM | {count} CloudFormation stacks in failed state  Investigate: `aws cloudformation describe-stack-events --stack-name {name}`; fix root cause then `aws cloudformation continue-update-rollback` |
| No failed stacks | INFO | All CloudFormation stacks healthy ✅  — |

---

## OPS-06: Trusted Advisor Open Checks

```bash
aws support describe-trusted-advisor-checks --language en --query 'checks[].{Id:id,Name:name,Category:category}' --output json 2>/dev/null
# Note: Requires Business/Enterprise support plan
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Not available (Basic plan) | LOW | Trusted Advisor limited — consider upgrading support plan  Upgrade to Business support tier (>$100/mo) for full TA checks |
| Open warnings | MEDIUM | {count} Trusted Advisor warnings  Manual: review and address each TA warning |
| All green | INFO | Trusted Advisor all green ✅  — |

---

## OPS-07: EventBridge Rules

```bash
aws events list-rules --query 'Rules | length(@)' --output text
aws events list-rules --query 'Rules[?State==`DISABLED`].{Name:Name,State:State}' --output json
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| No rules | LOW | No EventBridge rules — limited event-driven automation  Define event-driven rules: `aws events put-rule --name {name} --event-pattern '{...}' --state ENABLED` |
| Disabled rules | LOW | {count} disabled EventBridge rules  `aws events enable-rule --name {name}` after verifying still needed, otherwise `aws events delete-rule` |
| Active rules | INFO | EventBridge automation active ✅  — |

---

## OPS-08: AWS Health Events

```bash
aws health describe-events --filter 'eventStatusCodes=open,upcoming' --query 'events[].{Service:service,Type:eventTypeCode,Status:statusCode,Region:region}' --output json 2>/dev/null
```

| Result | Severity | Finding  | Remediation |
|--------|----------|----------------------|
| Open/upcoming events | MEDIUM | {count} active AWS Health events affecting your account  Manual: review Health Dashboard; act on scheduled changes (RDS minor versions etc.) before forced window |
| No events | INFO | No active AWS Health events ✅  — |

---

## Summary

| Check | ID | Key Question |
|-------|----|-------------|
| AWS Config | OPS-01 | Is configuration drift tracked? |
| CloudWatch Alarms | OPS-02 | Is monitoring proactive? |
| Log Retention | OPS-03 | Are logs managed cost-effectively? |
| Patch Compliance | OPS-04 | Are systems patched? |
| CFN Stack Health | OPS-05 | Is IaC deployment healthy? |
| Trusted Advisor | OPS-06 | Are AWS recommendations addressed? |
| EventBridge | OPS-07 | Is event automation in place? |
| Health Events | OPS-08 | Are there active AWS issues? |

**Total checks: 8** | Expected time: ~2-3 minutes
