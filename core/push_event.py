"""
Normalize EventBridge events from various AWS sources into a single shape
the push pipeline can dedupe + render + dispatch uniformly.

One normalizer per source. Each returns a `PushEvent` dataclass or None
to signal "skip this event" (filtered out by category / severity / etc).

The push handler iterates source dispatchers in order and stops at the
first match. Adding a new source = new normalizer + entry in `NORMALIZERS`.
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from typing import Callable

logger = logging.getLogger(__name__)


@dataclass
class PushEvent:
    source: str                 # human label: "CloudWatch Alarm" / "GuardDuty" ...
    title: str                  # one-line summary, ≤120 chars
    severity: str               # "info" | "warn" | "critical" — drives card color
    resource: str               # primary ARN / id; "" when account-level
    region: str = ""
    account: str = ""
    description: str = ""       # multi-line context (sent to agent + shown on card)
    dedupe_key: str = ""        # opaque string; same → suppress duplicates within window
    dispatch_query: str = ""    # text to send to DevOps Agent for follow-up investigation
    console_url: str = ""       # optional: deep link to view this event in console
    raw_event_excerpt: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Severity & color helpers
# ---------------------------------------------------------------------------
SEVERITY_TO_COLOR = {
    "info": "blue",
    "warn": "orange",
    "critical": "red",
}


def _hash_key(*parts: str) -> str:
    # SHA1 used for short dedup-key generation only (not security).
    return hashlib.sha1("|".join(p or "" for p in parts).encode("utf-8"),
                        usedforsecurity=False).hexdigest()[:16]


# ---------------------------------------------------------------------------
# 1. CloudWatch Alarm
# ---------------------------------------------------------------------------
def from_cloudwatch_alarm(event: dict) -> PushEvent | None:
    """`aws.cloudwatch` source, 'CloudWatch Alarm State Change' detail-type.
    Skip transitions to OK/INSUFFICIENT_DATA — only ALARM is push-worthy."""
    detail = event.get("detail") or {}
    new_state = (detail.get("state") or {}).get("value", "")
    if new_state != "ALARM":
        return None
    alarm_name = detail.get("alarmName", "")
    region = event.get("region", "")
    account = event.get("account", "")
    reason = (detail.get("state") or {}).get("reason", "")
    metric_name = (detail.get("configuration", {}).get("metrics") or [{}])[0]
    metric_label = ""
    try:
        metric_label = (
            f"{metric_name['metricStat']['metric']['namespace']}/"
            f"{metric_name['metricStat']['metric']['metricName']}"
        )
    except (KeyError, TypeError):
        pass

    arn = ""
    for r in event.get("resources") or []:
        if "alarm" in r:
            arn = r
            break

    title = f"🚨 CloudWatch Alarm · {alarm_name}"
    # English-only description / dispatch_query — push events have no
    # per-user context (they fire automatically from EventBridge), so
    # we use English as the universal language. AWS technical content
    # is also more standard in English.
    description = (
        f"Alarm `{alarm_name}` entered the **ALARM** state.\n"
        f"- Region: {region}\n"
        f"- Account: {account}\n"
        f"- Metric: {metric_label or '(unknown)'}\n"
        f"- Reason: {reason}\n"
        f"- ARN: {arn}\n"
    )
    console_url = (
        f"https://{region}.console.aws.amazon.com/cloudwatch/home?region={region}"
        f"#alarmsV2:alarm/{alarm_name}"
    ) if alarm_name and region else ""

    return PushEvent(
        source="CloudWatch Alarm",
        title=title[:120],
        severity="critical",
        resource=arn or alarm_name,
        region=region,
        account=account,
        description=description,
        dedupe_key=_hash_key("cw_alarm", account, region, alarm_name),
        dispatch_query=(
            f"CloudWatch alarm '{alarm_name}' in {region} entered ALARM. "
            f"Reason: {reason}. Investigate the affected resource(s) "
            f"using metrics and logs from the last 1 hour, identify the "
            f"root cause, and suggest a fix."
        ),
        console_url=console_url,
        raw_event_excerpt={"alarmName": alarm_name, "newState": new_state,
                           "reason": reason},
    )


# ---------------------------------------------------------------------------
# 2. AWS Health
# ---------------------------------------------------------------------------
def from_aws_health(event: dict) -> PushEvent | None:
    """`aws.health` source. Three sub-types matter:
       - issue              : an actual outage / impact
       - scheduledChange    : planned maintenance customers should prep for
       - accountNotification: account-level changes (TOS, deprecations)
    """
    detail = event.get("detail") or {}
    category = detail.get("eventTypeCategory", "")
    type_code = detail.get("eventTypeCode", "")
    description = detail.get("eventDescription") or []
    desc_text = ""
    if isinstance(description, list) and description:
        first = description[0]
        if isinstance(first, dict):
            desc_text = first.get("latestDescription", "")
    affected = detail.get("affectedEntities") or []
    affected_summary = ", ".join(
        e.get("entityValue", "") for e in affected[:3]
        if isinstance(e, dict)
    )
    region = event.get("region", "")
    account = event.get("account", "")

    severity = {
        "issue": "critical",
        "scheduledChange": "warn",
        "accountNotification": "info",
        "investigation": "warn",
    }.get(category, "info")
    icon = {"issue": "🚨", "scheduledChange": "📅",
            "accountNotification": "📢", "investigation": "🔍"}.get(category, "ℹ️")

    title = f"{icon} AWS Health · {type_code}"
    body = (
        f"**Category** · {category}\n"
        f"**Region** · {region}\n"
        f"**Affected** · {affected_summary or '(account-wide)'}\n\n"
        f"{(desc_text or '')[:600]}"
    )

    return PushEvent(
        source="AWS Health",
        title=title[:120],
        severity=severity,
        resource=affected_summary or "(account)",
        region=region,
        account=account,
        description=body,
        dedupe_key=_hash_key("health", account, region, type_code,
                             detail.get("eventArn", "")),
        dispatch_query=(
            f"AWS Health event {type_code} (category={category}) "
            f"affecting region {region}. Affected resources: "
            f"{affected_summary or 'account-wide'}. Assess the actual "
            f"impact on this account's workloads and suggest mitigations."
        ),
        raw_event_excerpt={"eventTypeCode": type_code, "category": category},
    )


# ---------------------------------------------------------------------------
# 3. AWS Backup — Job state changes
# ---------------------------------------------------------------------------
def from_aws_backup(event: dict) -> PushEvent | None:
    """`aws.backup` source. We only care about FAILED / EXPIRED state — backup
    SUCCESS doesn't need a push."""
    detail = event.get("detail") or {}
    state = (detail.get("state") or detail.get("status") or "").upper()
    if state not in ("FAILED", "EXPIRED", "ABORTED"):
        return None
    job_id = detail.get("backupJobId", "")
    resource_arn = detail.get("resourceArn", "")
    resource_type = detail.get("resourceType", "")
    vault = detail.get("backupVaultName", "")
    status_message = detail.get("statusMessage", "")
    region = event.get("region", "")
    account = event.get("account", "")

    title = f"💾 AWS Backup · {state} · {resource_type}"
    body = (
        f"**Resource** · `{resource_arn}`\n"
        f"**Vault** · {vault}\n"
        f"**Job** · `{job_id}`\n"
        f"**Region** · {region}\n\n"
        f"{(status_message or '')[:500]}"
    )

    return PushEvent(
        source="AWS Backup",
        title=title[:120],
        severity="critical",
        resource=resource_arn,
        region=region,
        account=account,
        description=body,
        dedupe_key=_hash_key("backup", account, region, resource_arn, state),
        dispatch_query=(
            f"AWS Backup job for {resource_arn} ({resource_type}) in "
            f"vault {vault} transitioned to {state}. Status message: "
            f"{status_message[:200]}. Confirm whether RPO/RTO is "
            f"impacted and suggest a remediation."
        ),
        raw_event_excerpt={"state": state, "resourceArn": resource_arn,
                           "resourceType": resource_type},
    )


# ---------------------------------------------------------------------------
# 4. GuardDuty — high-severity findings only
# ---------------------------------------------------------------------------
def from_guardduty(event: dict, min_severity: float = 7.0) -> PushEvent | None:
    """`aws.guardduty` source. Severity in 0.0-10.0; we filter < min_severity.
    GuardDuty also emits low-severity recon findings that aren't worth waking
    a chat on."""
    detail = event.get("detail") or {}
    severity_score = float(detail.get("severity") or 0)
    if severity_score < min_severity:
        return None
    finding_type = detail.get("type", "")
    title_field = detail.get("title", finding_type)
    description_field = detail.get("description", "")
    finding_id = detail.get("id", "")
    region = event.get("region", "")
    account = event.get("account", "")
    resource = (detail.get("resource") or {})
    res_type = resource.get("resourceType", "")

    sev_label = ("critical" if severity_score >= 8.0
                 else "warn")
    icon = "🚨" if sev_label == "critical" else "⚠️"
    title = f"{icon} GuardDuty · {title_field}"
    body = (
        f"**Type** · `{finding_type}`\n"
        f"**Severity** · {severity_score}/10\n"
        f"**Resource type** · {res_type}\n"
        f"**Region** · {region}\n\n"
        f"{(description_field or '')[:600]}"
    )
    console_url = (
        f"https://{region}.console.aws.amazon.com/guardduty/home?region={region}"
        f"#/findings?fId={finding_id}"
    ) if finding_id and region else ""

    return PushEvent(
        source="GuardDuty",
        title=title[:120],
        severity=sev_label,
        resource=finding_id,
        region=region,
        account=account,
        description=body,
        dedupe_key=_hash_key("gd", account, region, finding_type,
                             resource.get("instanceDetails", {}).get("instanceId", "")
                             or resource.get("accessKeyDetails", {}).get("userName", "")),
        dispatch_query=(
            f"GuardDuty reported {finding_type} (severity {severity_score}). "
            f"{description_field[:200]}. Assess the actual risk level "
            f"and recommend a response."
        ),
        console_url=console_url,
        raw_event_excerpt={"type": finding_type, "severity": severity_score,
                           "id": finding_id},
    )


# ---------------------------------------------------------------------------
# 5. Cost Anomaly Detection
# ---------------------------------------------------------------------------
def from_cost_anomaly(event: dict) -> PushEvent | None:
    """`aws.costexplorer` source, 'AWS Anomaly Detection' or similar."""
    detail = event.get("detail") or {}
    impact = (detail.get("impact") or {})
    total_cost = impact.get("totalImpact", 0)
    monitor_arn = detail.get("monitorArn", "")
    anomaly_id = detail.get("anomalyId", "")
    root_causes = detail.get("rootCauses") or []
    rc_summary = "; ".join(
        f"{r.get('service','')} ({r.get('region','')})"
        for r in root_causes[:3] if isinstance(r, dict)
    )
    account = event.get("account", "")

    title = f"💰 Cost Anomaly · ~${total_cost:.2f} impact"
    body = (
        f"**Anomaly** · `{anomaly_id}`\n"
        f"**Monitor** · `{monitor_arn}`\n"
        f"**Estimated impact** · ${total_cost:.2f}\n"
        f"**Root causes** · {rc_summary or '(unknown)'}\n"
    )

    return PushEvent(
        source="Cost Anomaly",
        title=title[:120],
        severity="warn",
        resource=anomaly_id,
        region="",
        account=account,
        description=body,
        dedupe_key=_hash_key("costanom", account, anomaly_id),
        dispatch_query=(
            f"AWS Cost Anomaly Detection flagged ${total_cost:.2f} of "
            f"unexpected spend. Root-cause service/region: "
            f"{rc_summary or 'unknown'}. Identify which resources drove "
            f"the anomaly and suggest cost-control / optimization steps."
        ),
        raw_event_excerpt={"anomalyId": anomaly_id,
                           "totalImpact": total_cost},
    )


# ---------------------------------------------------------------------------
# 6. Trusted Advisor — only ERROR-status changes in selected categories
# ---------------------------------------------------------------------------
TA_INCLUDE_CATEGORIES_DEFAULT = {"security", "fault_tolerance", "service_limits"}
TA_INCLUDE_STATUSES = {"ERROR"}


def from_trusted_advisor(event: dict,
                         include_categories: set[str] | None = None
                         ) -> PushEvent | None:
    """`aws.trustedadvisor` source.

    We deliberately filter out:
      - 'Trusted Advisor Check Item Refresh Notification' (refresh w/o status change)
      - WARNING / OK statuses (only ERROR push-worthy)
      - cost_optimizing / performance categories by default (too chatty,
        also better surfaced via Cost Anomaly + CW alarms respectively)

    Customers can override include_categories to widen the net.
    """
    detail_type = event.get("detail-type", "")
    if "Status Changed" not in detail_type:
        return None
    detail = event.get("detail") or {}
    status = (detail.get("status") or "").upper()
    if status not in TA_INCLUDE_STATUSES:
        return None
    category = (detail.get("check-category") or detail.get("category") or "").lower()
    cats = include_categories or TA_INCLUDE_CATEGORIES_DEFAULT
    if category not in cats:
        return None
    check_name = detail.get("check-name") or detail.get("checkName") or "(unknown check)"
    flagged = detail.get("flagged-resources") or detail.get("resourcesFlagged") or 0
    account = event.get("account", "")
    region = event.get("region", "")

    title = f"🛡️ Trusted Advisor · {check_name}"
    body = (
        f"**Category** · {category}\n"
        f"**Status** · {status}\n"
        f"**Flagged resources** · {flagged}\n"
        f"**Account** · {account}\n"
    )
    console_url = "https://console.aws.amazon.com/trustedadvisor/home"

    return PushEvent(
        source="Trusted Advisor",
        title=title[:120],
        severity="warn",
        resource=check_name,
        region=region,
        account=account,
        description=body,
        dedupe_key=_hash_key("ta", account, check_name, status),
        dispatch_query=(
            f"Trusted Advisor check '{check_name}' (category={category}) "
            f"transitioned to {status}, flagging {flagged} resources. "
            f"Identify what those resources are, what the risk is, and "
            f"how to fix them."
        ),
        console_url=console_url,
        raw_event_excerpt={"checkName": check_name, "category": category,
                           "status": status, "flagged": flagged},
    )


# ---------------------------------------------------------------------------
# 7. EC2 Spot Instance Interruption Warning
# ---------------------------------------------------------------------------
def from_ec2_spot(event: dict) -> PushEvent | None:
    """`aws.ec2` source, 'EC2 Spot Instance Interruption Warning' detail-type.
    AWS gives a 2-minute heads-up before reclaiming a Spot instance — capacity-
    sensitive workloads want to react (drain, checkpoint, reschedule)."""
    detail = event.get("detail") or {}
    instance_id = detail.get("instance-id", "")
    action = detail.get("instance-action", "")   # terminate / stop / hibernate
    region = event.get("region", "")
    account = event.get("account", "")
    if not instance_id:
        return None

    title = f"⚡ EC2 Spot Interruption · {instance_id}"
    description = (
        f"Spot instance `{instance_id}` will be **{action or 'reclaimed'}** in ~2 minutes.\n"
        f"- Region: {region}\n"
        f"- Account: {account}\n"
        f"- Action: {action or '(unknown)'}\n"
    )
    console_url = (
        f"https://{region}.console.aws.amazon.com/ec2/home?region={region}"
        f"#InstanceDetails:instanceId={instance_id}"
    ) if instance_id and region else ""

    return PushEvent(
        source="EC2 Spot",
        title=title[:120],
        severity="warn",
        resource=instance_id,
        region=region,
        account=account,
        description=description,
        dedupe_key=_hash_key("ec2_spot", account, region, instance_id),
        dispatch_query=(
            f"EC2 Spot instance {instance_id} in {region} is about to be "
            f"{action or 'reclaimed'} in ~2 minutes. Identify what workload runs "
            f"on it and recommend how to drain/reschedule to avoid disruption."
        ),
        console_url=console_url,
        raw_event_excerpt={"instanceId": instance_id, "action": action},
    )


# ---------------------------------------------------------------------------
# 8. Auto Scaling — launch failures (capacity shortfall)
# ---------------------------------------------------------------------------
def from_autoscaling(event: dict) -> PushEvent | None:
    """`aws.autoscaling` source. Only launch/terminate FAILURES are push-worthy;
    a failed launch usually means a capacity shortfall the team should know about.
    Successful scaling activities are noise."""
    detail_type = event.get("detail-type", "")
    if "Unsuccessful" not in detail_type:   # e.g. "EC2 Instance Launch Unsuccessful"
        return None
    detail = event.get("detail") or {}
    asg_name = detail.get("AutoScalingGroupName", "")
    cause = detail.get("Cause", "") or detail.get("StatusMessage", "")
    description_field = detail.get("Description", "")
    region = event.get("region", "")
    account = event.get("account", "")

    is_launch = "Launch" in detail_type
    title = f"📉 Auto Scaling · {'Launch' if is_launch else 'Terminate'} failed · {asg_name}"
    body = (
        f"**ASG** · `{asg_name}`\n"
        f"**Region** · {region}\n"
        f"**Detail** · {description_field or '(none)'}\n\n"
        f"{(cause or '')[:500]}"
    )
    console_url = (
        f"https://{region}.console.aws.amazon.com/ec2/home?region={region}#AutoScalingGroupDetails:id={asg_name}"
    ) if asg_name and region else ""

    return PushEvent(
        source="Auto Scaling",
        title=title[:120],
        severity="critical",
        resource=asg_name,
        region=region,
        account=account,
        description=body,
        dedupe_key=_hash_key("asg", account, region, asg_name, detail_type),
        dispatch_query=(
            f"Auto Scaling group '{asg_name}' in {region} failed to "
            f"{'launch' if is_launch else 'terminate'} an instance. Cause: "
            f"{cause[:200]}. Determine whether this is a capacity/quota/config "
            f"issue and recommend a fix."
        ),
        console_url=console_url,
        raw_event_excerpt={"asg": asg_name, "detailType": detail_type},
    )


# ---------------------------------------------------------------------------
# 9. RDS — DB instance events (failover / storage / maintenance / config)
# ---------------------------------------------------------------------------
# RDS emits many event categories; only these carry operational weight.
RDS_INCLUDE_CATEGORIES = {
    "failover", "failure", "maintenance", "recovery",
    "low storage", "configuration change", "deletion",
}


def from_rds(event: dict) -> PushEvent | None:
    """`aws.rds` source, 'RDS DB Instance Event' (and cluster) detail-type.
    Filter to operationally-significant categories — routine backup/restore
    notifications are noise. Requires no setup: RDS emits these natively."""
    detail = event.get("detail") or {}
    category = (detail.get("EventCategories") or [""])[0] if isinstance(
        detail.get("EventCategories"), list) else (detail.get("EventCategories") or "")
    category = (category or "").lower()
    # Some RDS events put the category in "Categories" or embed it in the message.
    if category and category not in RDS_INCLUDE_CATEGORIES:
        # allow if any listed keyword appears in the message
        msg = (detail.get("Message") or "").lower()
        if not any(k in msg for k in RDS_INCLUDE_CATEGORIES):
            return None
    source_id = detail.get("SourceIdentifier", "")
    message = detail.get("Message", "")
    region = event.get("region", "")
    account = event.get("account", "")

    # failover / failure / deletion → critical; others → warn.
    sev = "critical" if any(k in (category + " " + message.lower())
                            for k in ("failover", "failure", "deletion", "recovery")) else "warn"
    title = f"🗄️ RDS · {source_id} · {category or 'event'}"
    body = (
        f"**Instance** · `{source_id}`\n"
        f"**Category** · {category or '(unspecified)'}\n"
        f"**Region** · {region}\n\n"
        f"{(message or '')[:500]}"
    )
    console_url = (
        f"https://{region}.console.aws.amazon.com/rds/home?region={region}"
        f"#database:id={source_id}"
    ) if source_id and region else ""

    return PushEvent(
        source="RDS",
        title=title[:120],
        severity=sev,
        resource=source_id,
        region=region,
        account=account,
        description=body,
        dedupe_key=_hash_key("rds", account, region, source_id, category, message[:60]),
        dispatch_query=(
            f"RDS instance {source_id} in {region} emitted event "
            f"'{category or message[:60]}'. Assess the impact on availability/"
            f"performance and recommend any action."
        ),
        console_url=console_url,
        raw_event_excerpt={"sourceId": source_id, "category": category},
    )


# ---------------------------------------------------------------------------
# 10. AWS Config — compliance change (NON_COMPLIANT)
# ---------------------------------------------------------------------------
def from_config(event: dict) -> PushEvent | None:
    """`aws.config` source, 'Config Rules Compliance Change' detail-type.
    Only push when a resource turns NON_COMPLIANT (COMPLIANT/insufficient-data
    aren't push-worthy). Requires the customer to have Config rules configured."""
    detail = event.get("detail") or {}
    compliance = ((detail.get("newEvaluationResult") or {})
                  .get("complianceType") or detail.get("complianceType") or "").upper()
    if compliance != "NON_COMPLIANT":
        return None
    rule_name = detail.get("configRuleName", "")
    resource_type = detail.get("resourceType", "")
    resource_id = detail.get("resourceId", "")
    region = event.get("region", "")
    account = event.get("account", "")

    title = f"📋 Config · NON_COMPLIANT · {rule_name}"
    body = (
        f"**Rule** · `{rule_name}`\n"
        f"**Resource** · {resource_type} `{resource_id}`\n"
        f"**Region** · {region}\n"
    )
    console_url = (
        f"https://{region}.console.aws.amazon.com/config/home?region={region}"
        f"#/rules/details?configRuleName={rule_name}"
    ) if rule_name and region else ""

    return PushEvent(
        source="AWS Config",
        title=title[:120],
        severity="warn",
        resource=resource_id or rule_name,
        region=region,
        account=account,
        description=body,
        dedupe_key=_hash_key("config", account, region, rule_name, resource_id),
        dispatch_query=(
            f"AWS Config rule '{rule_name}' flagged {resource_type} "
            f"'{resource_id}' as NON_COMPLIANT in {region}. Explain what the "
            f"rule checks, why the resource failed, and how to remediate."
        ),
        console_url=console_url,
        raw_event_excerpt={"rule": rule_name, "resourceId": resource_id,
                           "compliance": compliance},
    )


# ---------------------------------------------------------------------------
# Source dispatcher — entry point for the push handler
# ---------------------------------------------------------------------------
NORMALIZERS: dict[str, Callable[[dict], PushEvent | None]] = {
    "aws.cloudwatch": from_cloudwatch_alarm,
    "aws.health": from_aws_health,
    "aws.backup": from_aws_backup,
    "aws.guardduty": from_guardduty,
    "aws.costexplorer": from_cost_anomaly,
    "aws.trustedadvisor": from_trusted_advisor,
    "aws.ec2": from_ec2_spot,
    "aws.autoscaling": from_autoscaling,
    "aws.rds": from_rds,
    "aws.config": from_config,
}


def normalize(event: dict) -> PushEvent | None:
    """Single entry point: figure out which source the event came from
    and dispatch to the right normalizer. Returns None if the event was
    filtered out (e.g. severity below threshold) or unrecognized."""
    source = (event.get("source") or "").lower()
    fn = NORMALIZERS.get(source)
    if not fn:
        logger.info("push_event: no normalizer for source=%s", source)
        return None
    try:
        return fn(event)
    except Exception as e:
        logger.exception("push_event normalizer for %s crashed: %s", source, e)
        return None
