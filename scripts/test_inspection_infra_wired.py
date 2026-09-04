#!/usr/bin/env python3
"""Meta-assertions on the synthesized CloudFormation template for inspection.

Run this after `cdk synth` to confirm the scheduler wiring survived edits.
Each check below corresponds to a failure mode that produces **no error at
runtime** -- only missing or duplicated inspection runs.

Usage:
    cd infra && npx cdk synth NotiOpsBackendStack --quiet -o /tmp/synth
    PYTHONPATH=. ./.venv/bin/python scripts/test_inspection_infra_wired.py /tmp/synth
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

TEMPLATE = "NotiOpsBackendStack.template.json"

QUEUE_NAME = "notiops-inspection-tasks"
DLQ_NAME = "notiops-inspection-dlq"
SCHEDULER_NAME = "notiops-inspection-scheduler"
EXECUTOR_NAME = "notiops-inspection-executor"
RECONCILER_NAME = "notiops-inspection-reconciler"
PUSH_NAME = "notiops-inspection-push"
PUSH_RULE_NAME = "notiops-inspection-push"
RULE_NAME = "notiops-inspection-scheduler"
RECONCILER_RULE_NAME = "notiops-inspection-reconciler"

REQUIRED_ENV = (
    "INSPECTION_TABLE",
    "INSPECTION_QUEUE_URL",
    "CONFIG_TABLE",
    # Both agent spaces: pace must be summed across them (R12.5c).
    # CloudWatch dimension is AgentSpaceUUID -- one curve per space -- while
    # credits are account-level. Reading only one systematically underestimates
    # pace, which relaxes dispatch until the monthly budget is gone by mid-month.
    "DEVOPS_AGENT_SPACE_ID",
    "INSPECT_AGENT_SPACE_ID",
    # R12.2 的分母。缺了它 `_env(..., "-1")` 恒取兜底值 -> 预算护栏在所有
    # 部署里都是关着的，而没有任何信号说明这一点（tier 恒 NORMAL）。
    "MONTHLY_LIMIT_SECONDS",
)

OPS_TOPIC_NAME = "notiops-inspection-ops-alerts"
CUSTOMER_TOPIC_NAME = "notiops-alerts"
OPS_ALARM_PREFIX = "notiops-inspection-"

EXPECTED_ALARMS = {
    # alarm name suffix -> (metric name, statistic, treat-missing-data)
    "all-accounts-failed": ("RunSucceeded", "Sum", "breaching"),
    "zero-output": ("RunZeroOutput", "Sum", "notBreaching"),
    "low-completeness": ("Completeness", "Minimum", "notBreaching"),
    "dispatch-failure-ratio": ("DispatchFailureRatio", "Maximum", "notBreaching"),
    "dispatch-unmapped": ("DispatchUnmapped", "Sum", "notBreaching"),
    "da-quota-high": ("DaQuotaUsedRatio", "Maximum", "missing"),
}

failures: list[str] = []
checks = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global checks
    checks += 1
    if ok:
        print(f"  OK   {label}")
    else:
        print(f"  FAIL {label}" + (f" -- {detail}" if detail else ""))
        failures.append(label)


def by_type(resources: dict, type_name: str) -> dict:
    return {k: v for k, v in resources.items()
            if v.get("Type") == type_name}


def main(out_dir: str) -> int:
    path = pathlib.Path(out_dir) / TEMPLATE
    if not path.exists():
        print(f"template not found: {path}")
        print("run `cd infra && npx cdk synth NotiOpsBackendStack -o <dir>` first")
        return 2
    tpl = json.loads(path.read_text())
    res = tpl.get("Resources", {})
    outputs = tpl.get("Outputs", {})

    queues = {
        p.get("QueueName"): p
        for p in (v.get("Properties", {}) for v in by_type(res, "AWS::SQS::Queue").values())
    }

    print("SQS")
    q = queues.get(QUEUE_NAME)
    check(q is not None, f"queue {QUEUE_NAME} exists")
    check(DLQ_NAME in queues, f"queue {DLQ_NAME} exists")

    if q:
        redrive = q.get("RedrivePolicy") or {}
        check(bool(redrive), "task queue has a RedrivePolicy",
              "without a DLQ a poison message is redelivered forever")
        check(redrive.get("maxReceiveCount") == 3,
              "maxReceiveCount is 3",
              f"got {redrive.get('maxReceiveCount')}")
        # Must be >= the executor Lambda timeout (15 min). Smaller values make
        # an in-flight message visible again -> the same account gets inspected
        # concurrently. The DDB run lock stops the second one, but only after it
        # has already paid for a full GetMetricData sweep.
        vis = q.get("VisibilityTimeout")
        check(isinstance(vis, int) and vis >= 900,
              "VisibilityTimeout >= 900s (executor timeout)",
              f"got {vis}")

    dlq = queues.get(DLQ_NAME)
    if dlq:
        check(dlq.get("MessageRetentionPeriod") == 1209600,
              "DLQ retention is 14 days (SQS max)",
              f"got {dlq.get('MessageRetentionPeriod')}")
        check("RedrivePolicy" not in dlq,
              "DLQ itself has no RedrivePolicy")

    print("\nQueue policy (transport)")
    ssl_denies = 0
    for name, v in by_type(res, "AWS::SQS::QueuePolicy").items():
        if "Inspection" not in json.dumps(v.get("Properties", {}).get("Queues")):
            continue
        for stmt in v["Properties"]["PolicyDocument"]["Statement"]:
            if stmt.get("Effect") == "Deny":
                ssl_denies += 1
    check(ssl_denies >= 2, "both queues deny non-TLS requests (enforceSSL)",
          f"found {ssl_denies} deny statements")

    print("\nScheduler Lambda")
    fns = {
        p.get("FunctionName"): p
        for p in (v.get("Properties", {})
                  for v in by_type(res, "AWS::Lambda::Function").values())
    }
    fn = fns.get(SCHEDULER_NAME)
    check(fn is not None, f"function {SCHEDULER_NAME} exists")
    if fn:
        check(fn.get("Handler") == "lambda_inspection_scheduler.handler.handler",
              "handler path matches the module layout",
              str(fn.get("Handler")))
        env = fn.get("Environment", {}).get("Variables", {})
        for key in REQUIRED_ENV:
            check(key in env, f"env {key} is present")

    print("\nExecutor Lambda")
    ex = fns.get(EXECUTOR_NAME)
    check(ex is not None, f"function {EXECUTOR_NAME} exists")
    if ex:
        check(ex.get("Handler") == "lambda_inspection_executor.handler.handler",
              "handler path matches the module layout", str(ex.get("Handler")))
        env = ex.get("Environment", {}).get("Variables", {})
        for key in ("INSPECTION_TABLE", "CONFIG_TABLE"):
            check(key in env, f"env {key} is present")

    print("\nSQS event source mapping")
    esms = [v.get("Properties", {})
            for v in by_type(res, "AWS::Lambda::EventSourceMapping").values()
            if "Inspection" in json.dumps(v.get("Properties", {}))]
    check(len(esms) == 1, "exactly one mapping for the executor",
          f"found {len(esms)}")
    if esms:
        m = esms[0]
        # One message = one full account inspection (up to 15 min). Pulling more
        # per batch only guarantees everything after the first one times out.
        check(m.get("BatchSize") == 1, "BatchSize is 1", str(m.get("BatchSize")))
        # Without ReportBatchItemFailures, a thrown exception makes the WHOLE
        # batch visible again -- including messages that already completed.
        # That means paying for GetMetricData twice and dispatching DA twice.
        check("ReportBatchItemFailures" in (m.get("FunctionResponseTypes") or []),
              "ReportBatchItemFailures is enabled",
              str(m.get("FunctionResponseTypes")))
        # DA custom agent concurrency is 1; dispatching more just queues, and
        # queued inspections push the customer's interactive investigation back.
        check((m.get("ScalingConfig") or {}).get("MaximumConcurrency") == 3,
              "MaximumConcurrency is 3", str(m.get("ScalingConfig")))

    print("\nCross-resource invariants")
    if ex and q:
        # A Lambda timeout >= visibility timeout makes an in-flight message
        # visible again -> the same account gets inspected concurrently. The DDB
        # run lock stops the second one, but only after a full paid metric sweep.
        check(int(ex.get("Timeout", 0)) < int(q.get("VisibilityTimeout", 0)),
              "executor timeout < queue VisibilityTimeout",
              f"{ex.get('Timeout')}s vs {q.get('VisibilityTimeout')}s")

    print("\nEventBridge Rule")
    rules = {
        p.get("Name"): p
        for p in (v.get("Properties", {})
                  for v in by_type(res, "AWS::Events::Rule").values())
    }
    rule = rules.get(RULE_NAME)
    check(rule is not None, f"rule {RULE_NAME} exists")
    if rule:
        # A single rule for every customer (R11.1a). The old system hardcoded
        # five cron rules in CDK, so changing a schedule required a redeploy.
        check(rule.get("ScheduleExpression") == "rate(15 minutes)",
              "fires every 15 minutes",
              str(rule.get("ScheduleExpression")))
        check(rule.get("State") in (None, "ENABLED"),
              "rule is enabled")
        check(len(rule.get("Targets") or []) == 1,
              "exactly one target (the scheduler)")

    # There must be exactly one **scheduling** rule -- a second one would
    # double every tick, and the run lock would hide it until the lock itself
    # fails.
    #
    # ⚠️ Count by exact name, not by the "inspection" substring. The substring
    # form also matched the hourly reconciler rule
    # (`notiops-inspection-reconciler`), so adding that rule made this check
    # fail for a reason unrelated to what it guards. Widening it to "at most
    # two inspection rules" would have been worse: it would then pass with two
    # *scheduler* rules, which is precisely the failure mode.
    scheduler_rules = [n for n in rules if n == RULE_NAME]
    check(scheduler_rules == [RULE_NAME],
          "exactly one inspection schedule rule",
          str([n for n in rules if n and "inspection" in n]))

    print("\nOutputs")
    for key in ("InspectionQueueUrl", "InspectionAgentSpaceId", "AgentSpaceId"):
        check(key in outputs, f"output {key} is present")

    check_callback_detail_types(res)
    check_reconciler(res)
    check_push(res)
    check_collector_permissions(res)
    rc_alarms = check_alarms(res)

    print(f"\n{checks - len(failures)}/{checks} checks passed")
    if failures:
        print("failed: " + ", ".join(failures))
        return 1
    return rc_alarms


CALLBACK_DETAIL_TYPES = {
    "Investigation Created",
    "Investigation Completed",
    "Investigation Failed",
    "Investigation Timed Out",
    "Investigation Cancelled",
    "Investigation Linked",
    # . Reachable in practice: inspection uploads its own skills, and
    # a skill can define skip criteria.
    "Investigation Skipped",
}


def check_callback_detail_types(res: dict) -> None:
    """Both callback rules must forward every detail-type the handler maps.

    A rule that omits a detail-type does not fail -- the event simply never
    arrives. For `Investigation Skipped` that means the terminal state is only
    discovered by the hourly reconciler, and until then the finding shows
    "analysis missing (unknown reason)".

    The mirror failure is just as quiet: a detail-type in the rule that the
    handler does not map invokes the Lambda for every such event and returns
    `unknown_detail_type`. So the two sets must match exactly.
    """
    print("\ncallback detail-types ")
    rules = [v.get("Properties", {}) for v in
             by_type(res, "AWS::Events::Rule").values()
             if str((v.get("Properties", {}).get("EventPattern") or {})
                    .get("source") or []) == "['aws.aidevops']"]
    check(len(rules) == 2,
          "both callback rules exist (custom bus + default bus)",
          str(len(rules)))
    for p in rules:
        got = set((p.get("EventPattern") or {}).get("detail-type") or [])
        name = str(p.get("Name") or "?")
        check(got == CALLBACK_DETAIL_TYPES, f"{name} forwards exactly the mapped set",
              f"missing={sorted(CALLBACK_DETAIL_TYPES - got)} "
              f"extra={sorted(got - CALLBACK_DETAIL_TYPES)}")


def check_reconciler(res: dict) -> None:
    """对账 Lambda 的接线（R13.13）。

    没有它的表现是**完全静默**：判读派出去没回来时，finding 上永远是空的，
    而 run 记录说这一轮 success。看板上那条 finding 看起来只是「还没分析」。
    """
    print("\ninspection reconciler (R13.13)")
    fns = [v for v in by_type(res, "AWS::Lambda::Function").values()
           if v.get("Properties", {}).get("FunctionName") == RECONCILER_NAME]
    check(len(fns) == 1, f"{RECONCILER_NAME} exists", str(len(fns)))
    if fns:
        env = (fns[0]["Properties"].get("Environment") or {}).get("Variables") or {}
        for key in ("INSPECTION_TABLE", "CONFIG_TABLE", "INSPECT_AGENT_SPACE_ID"):
            check(key in env, f"reconciler has {key} env",
                  "missing -- it cannot probe GetBacklogTask")

    rules = [v.get("Properties", {}) for v in
             by_type(res, "AWS::Events::Rule").values()
             if v.get("Properties", {}).get("Name") == RECONCILER_RULE_NAME]
    check(len(rules) == 1, f"rule {RECONCILER_RULE_NAME} exists", str(len(rules)))
    for p in rules:
        expr = str(p.get("ScheduleExpression") or "")
        # R13.13 说的是每小时。改成每天会让「判读回不来」最长晚一天才被发现，
        # 而巡检报告是当天要交付的。
        check("rate(1 hour)" in expr, "reconciler runs hourly", expr)

    # 🔴 巡检两个 Lambda 用的是共享 lambdaRole（不是 triggerRole），而
    # `create_backlog_task` 的 AccessDenied 被调用点的 `except ... continue`
    # 吞掉 —— 表现是 dispatched_tasks=0 而 run 状态是 success，
    # 也就是「判读一条都派不出去且零报错」。这两条是巡检能工作的前提。
    needed = {"aidevops:CreateBacklogTask", "aidevops:GetBacklogTask"}
    lambda_role_actions: set[str] = set()
    for pol in by_type(res, "AWS::IAM::Policy").values():
        props = pol.get("Properties", {})
        roles = json.dumps(props.get("Roles") or [])
        # 共享执行角色的逻辑 ID 前缀（CDK 生成）。
        if "LambdaExecutionRole" not in roles:
            continue
        for st in (props.get("PolicyDocument") or {}).get("Statement", []) or []:
            acts = st.get("Action")
            acts = acts if isinstance(acts, list) else [acts]
            lambda_role_actions.update(str(a) for a in acts if a)
    missing = sorted(needed - lambda_role_actions)
    check(not missing,
          "the shared Lambda role can dispatch AND probe DevOps Agent tasks",
          f"missing: {missing} -- dispatch fails silently (AccessDenied is "
          f"swallowed, run status stays success)")


def check_push(res: dict) -> None:
    """Push Lambda wiring (R11b.1~R11b.10).

    Without it the inspection pipeline computes everything and writes it to the
    table, and NOBODY EVER SEES IT -- the push is the only product of this
    system the customer actually perceives. The failure mode is completely
    silent: dashboard has data, run records say success, and the customer says
    "I thought you were going to tell me about problems".
    """
    print("\ninspection push (R11b)")
    fns = [v for v in by_type(res, "AWS::Lambda::Function").values()
           if v.get("Properties", {}).get("FunctionName") == PUSH_NAME]
    check(len(fns) == 1, f"{PUSH_NAME} exists", str(len(fns)))
    if fns:
        props = fns[0]["Properties"]
        check(props.get("Handler") == "lambda_inspection_push.handler.handler",
              "push handler path is correct", str(props.get("Handler")))
        env = (props.get("Environment") or {}).get("Variables") or {}
        for key in ("INSPECTION_TABLE", "CONFIG_TABLE"):
            check(key in env, f"push has {key} env",
                  "missing -- it cannot read findings or the kill switch")
        # 🔴 Both IM credentials must be present. `is_configured()` keys off
        #    these env vars, and when it returns False the sender silently
        #    no-ops -- the whole platform goes quiet with zero errors.
        check("FEISHU_SECRET_ARN" in env, "push has the Feishu credential env",
              "missing -- feishu_sender.is_configured() is False and every "
              "Feishu delivery silently no-ops")
        check("SLACK_BOT_TOKEN_ARN" in env, "push has the Slack credential env",
              "missing -- slack_sender.is_configured() is False and every "
              "Slack delivery silently no-ops")
        # WEB_BASE_URL may be empty (deep links are then omitted), but the key
        # itself must exist -- otherwise there is no way to fill it in without
        # editing the stack.
        check("WEB_BASE_URL" in env, "push has the WEB_BASE_URL env key",
              "missing -- deep links (R11b.7) can never be configured")

    rules = [v.get("Properties", {}) for v in
             by_type(res, "AWS::Events::Rule").values()
             if v.get("Properties", {}).get("Name") == PUSH_RULE_NAME]
    check(len(rules) == 1, f"rule {PUSH_RULE_NAME} exists", str(len(rules)))
    for p in rules:
        expr = str(p.get("ScheduleExpression") or "")
        # ⚠️ The rule is coarse (every 15 min); the real time window lives in
        #    `push_policy.in_push_window` so operators can change the push time
        #    without redeploying. A daily cron here would hard-code it.
        check("rate(15 minutes)" in expr, "push rule ticks every 15 minutes",
              expr)
        targets = p.get("Targets") or []
        check(len(targets) == 1, "push rule has exactly one target",
              str(len(targets)))

    # 🔴 The push Lambda must NOT be wired to the inspection SQS queue --
    #    that would make it run once per account fan-out message, while the
    #    delivery model is "one summary per chat" (R11b.3).
    for v in by_type(res, "AWS::Lambda::EventSourceMapping").values():
        fn_ref = json.dumps(v.get("Properties", {}).get("FunctionName") or "")
        check("InspectionPushLambda" not in fn_ref,
              "push Lambda is not driven by the inspection queue",
              "it would fire once per account fan-out message")


def check_alarms(res: dict) -> int:
    """告警接线（R11c.2 / R11c.3）。

    每一条都对着一种**假绿灯**：告警存在、控制台上是绿的，而它其实什么都没在看。
    这类缺陷在运行时零信号 —— 恰恰因为「没有告警」和「告警没在工作」
    在界面上长得一模一样。
    """
    print("\ninspection alarms (R11c.3)")
    alarms = {}
    for r in by_type(res, "AWS::CloudWatch::Alarm").values():
        p = r.get("Properties", {})
        name = str(p.get("AlarmName") or "")
        alarms[name] = p

    # ── ops 通道必须与客户通道分开（R11c.2）
    sns_by_logical = {lid: str((r.get("Properties") or {}).get("TopicName") or "")
                      for lid, r in by_type(res, "AWS::SNS::Topic").items()}
    topics = {name: lid for lid, name in sns_by_logical.items() if name}
    check(OPS_TOPIC_NAME in topics,
          f"ops alarm topic {OPS_TOPIC_NAME} exists",
          f"topics present: {sorted(t for t in topics if t)}")
    check(OPS_TOPIC_NAME != CUSTOMER_TOPIC_NAME
          and CUSTOMER_TOPIC_NAME in topics,
          "ops channel is a DIFFERENT topic from the customer one (R11c.2)")

    # ── 六条告警各自的判据
    for suffix, (metric_name, statistic, missing) in EXPECTED_ALARMS.items():
        full = f"{OPS_ALARM_PREFIX}{suffix}"
        p = alarms.get(full)
        check(p is not None, f"alarm {full} exists",
              f"present: {sorted(alarms)}")
        if p is None:
            continue
        check(p.get("MetricName") == metric_name,
              f"{suffix} watches {metric_name}", str(p.get("MetricName")))
        check(p.get("Statistic") == statistic,
              f"{suffix} uses the {statistic} statistic", str(p.get("Statistic")))
        # 🔴 statistic 写错是**静默**的：`low-completeness` 用 Average 会把一个
        #    60% 的账号稀释进十个 100% 里，于是那条告警永远不响。
        check(p.get("TreatMissingData") == missing,
              f"{suffix} treats missing data as {missing}",
              str(p.get("TreatMissingData")))
        # 🔴 不能带维度：打点侧发的是「空 DimensionSet + (RunType,Surface)」两条，
        #    带了维度的 Alarm 只会去查后者，而它按 run_type 拆开 ——
        #    于是「有没有任何一轮出事」这个问题查不出来，表现是无数据。
        check("Dimensions" not in p,
              f"{suffix} carries no dimensions (matches the empty DimensionSet)",
              str(p.get("Dimensions")))
        check(p.get("Namespace") == "NotiOps/Inspection",
              f"{suffix} namespace is correct", str(p.get("Namespace")))
        # 没有 action 的告警只会在控制台变红，而「没人看控制台」正是
        # R11c.3 存在的原因。
        actions = p.get("AlarmActions") or []
        check(bool(actions), f"{suffix} has an alarm action")
        # 🔴 光有 action 不够 —— 必须指向 **ops** topic。
        #    指向客户那个 `notiops-alerts` 就是 R11c.2 的违反本身，
        #    而模板里两者都是一个 `Ref`，长得一模一样。
        #    实测：只断言「有 action」时，把 action 换成客户 topic 照样通过。
        targets_ops = all(
            sns_by_logical.get(str((a or {}).get("Ref") or "")) == OPS_TOPIC_NAME
            for a in actions if isinstance(a, dict) and "Ref" in a
        ) and any(isinstance(a, dict) and "Ref" in a for a in actions)
        check(targets_ops,
              f"{suffix} notifies the OPS topic, not the customer one (R11c.2)",
              json.dumps(actions)[:160])

    # ── 指标名必须与打点侧的清单一致（跨语言常量）
    #
    # 🔴 改了 Python 侧的指标名而 CDK 没跟 → 那条 Alarm 永远无数据 → 假绿灯。
    try:
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
        from inspection.adapters.metrics import ALL_METRICS, NAMESPACE
        cdk_metrics = {m for m, _, _ in EXPECTED_ALARMS.values()}
        check(cdk_metrics <= set(ALL_METRICS),
              "every CDK metric name is in the emitter's ALL_METRICS",
              f"unknown: {sorted(cdk_metrics - set(ALL_METRICS))}")
        check(NAMESPACE == "NotiOps/Inspection",
              "emitter and CDK agree on the namespace", NAMESPACE)
    except ImportError as e:                   # pragma: no cover
        check(False, "can import the emitter for the cross-language check", str(e))

    # ── 客户通道必须排除我们自己的运维告警（R11c.2）
    #
    # 🔴 这是 R11c.2 在本仓的**实际**泄漏点：我们的 Alarm 状态变更发出的正是
    #    `aws.cloudwatch` / `CloudWatch Alarm State Change`，与既有的
    #    notiops-push-* / notiops-web-notif-* 规则逐字匹配。
    #    换 SNS topic 只管住 alarmActions 那条路径，管不住 EventBridge 这条。
    alarm_rules = []
    for r in by_type(res, "AWS::Events::Rule").values():
        p = r.get("Properties", {})
        pat = p.get("EventPattern") or {}
        if pat.get("source") == ["aws.cloudwatch"]:
            alarm_rules.append((str(p.get("Name") or ""), pat))
    check(len(alarm_rules) >= 2,
          "found the customer-facing CloudWatch Alarm rules", str(len(alarm_rules)))
    for name, pat in alarm_rules:
        blob = json.dumps(pat.get("detail") or {})
        check("anything-but" in blob and OPS_ALARM_PREFIX in blob,
              f"{name} excludes our own {OPS_ALARM_PREFIX}* ops alarms",
              blob[:160] or "no detail filter at all")

    if failures:
        return 1
    return 0


BFF_NAME = "notiops-web-chat-bff"
INSPECTION_TABLE_NAME = "notiops-inspection"
WRITE_VERBS = ("Put", "Update", "Delete", "BatchWrite")

# 「一次调用能删掉多行、而且删掉的内容进不了 CloudWatch Logs」的那批 API。
# 判据只关心这个性质,不关心名字里有没有 "Batch":
#   BatchWriteItem        —— 25 条起,ReturnValues 根本没有 ALL_OLD
#   TransactWriteItems    —— 最多 100 条 Delete,同样不回旧值
#   BatchExecuteStatement —— PartiQL 批量,同上
#   DeleteTable           —— 一次清空整张表(连同审计对象本身)
BULK_DELETE_APIS = (
    "dynamodb:BatchWriteItem",
    "dynamodb:TransactWriteItems",
    "dynamodb:BatchExecuteStatement",
    "dynamodb:DeleteTable",
)


def _iam_matches_any(pattern: str, apis) -> bool:
    """把一条 IAM action 当 pattern,判它是否覆盖 apis 里任何一个。

    只翻译 IAM 真支持的两个通配符(`*` 任意长度、`?` 单字符),其余字符一律
    转义 —— 不能直接用 fnmatch:fnmatch 还会把 `[...]` 当字符集,而 IAM 里
    方括号是**字面量**,那样会把一条其实不授权的 action 判成授权(假红)。
    IAM 的 action 匹配大小写不敏感,所以用 re.I。
    """
    rx = "".join(".*" if c == "*" else "." if c == "?" else re.escape(c)
                 for c in str(pattern))
    prog = re.compile("^" + rx + "$", re.I)
    return any(prog.match(api) for api in apis)


def check_webchat(out_dir: str) -> int:
    """The dashboard half: the BFF must be able to READ the inspection table.

    Why this belongs in CI and not only in a unit test -- the failure mode is
    invisible everywhere else. `inspection.mjs` falls back to the literal table
    name, so a missing env var does NOT break the table name; what breaks is
    IAM. The six endpoints then return AccessDenied and the dashboard shows six
    cards spinning and then blank. tsc passes, the backend synth passes, and the
    BFF unit tests pass -- none of them touch IAM.
    """
    path = pathlib.Path(out_dir) / "WebChatStack.template.json"
    if not path.exists():
        print(f"\nWebChatStack template not found: {path} -- skipping BFF checks")
        print("run `cd infra && npx cdk synth WebChatStack -o <dir>` to enable them")
        return 0
    tpl = json.loads(path.read_text())
    res = tpl.get("Resources", {})

    print("\nWebChat BFF (inspection dashboard)")
    fns = [v for v in by_type(res, "AWS::Lambda::Function").values()
           if v.get("Properties", {}).get("FunctionName") == BFF_NAME]
    check(len(fns) == 1, f"{BFF_NAME} exists", str(len(fns)))
    if fns:
        env = (fns[0]["Properties"].get("Environment") or {}).get("Variables") or {}
        check("INSPECTION_TABLE" in env,
              "BFF has INSPECTION_TABLE env",
              "missing -- the dashboard cannot name the table")

    # The statement must exist AND must not grant writes. Writes would mean
    # "anyone who can see the dashboard can drop a production DB out of the
    # inspection scope" -- an action with no runtime signal at all.
    stmts = []
    for pol in by_type(res, "AWS::IAM::Policy").values():
        doc = pol.get("Properties", {}).get("PolicyDocument", {})
        for st in doc.get("Statement", []) or []:
            if st.get("Sid") == "InspectionDashboardReadOnly":
                stmts.append(st)
    check(len(stmts) == 1, "BFF has the InspectionDashboardReadOnly statement",
          str(len(stmts)))
    for st in stmts:
        actions = st.get("Action")
        actions = actions if isinstance(actions, list) else [actions]
        writes = [a for a in actions if any(w in str(a) for w in WRITE_VERBS)]
        check(not writes, "the statement grants no write actions", str(writes))
        blob = json.dumps(st.get("Resource"))
        check(INSPECTION_TABLE_NAME in blob,
              f"the statement targets {INSPECTION_TABLE_NAME}", blob[:120])

    # The write half . Deliberately a SEPARATE statement so
    # that "the dashboard is read-only" stays verifiable in IAM at a glance.
    #
    # 🔴 这里原本断言的是「**没有** DeleteItem」,理由是 R1.4 要让到期的排除项
    #    「留记录但不生效」,靠的就是不给删除权限。2026-09-01 产品侧刻意加了
    #    `dynamodb:DeleteItem`(`infra/lib/constructs/web-chat-core.ts` 那条
    #    statement 上面写着完整的改动理由):客户手滑把一台生产库排除之后
    #    **没有任何位置能撤销**,只能等 30 天过期 —— 而那 30 天里「没有告警」
    #    会被读成「一切正常」。所以断言的方向反过来了,现在查的是它**在**。
    #
    # ⚠️ 这条断言原来就写错了对象,不是"为了变绿放宽":R1.4 防的是**批量清理**
    #    把审计痕迹一起清掉,而 DeleteItem 本身只能逐行删,并且 BFF 的
    #    `deleteExclusion` 用 `ReturnValues: "ALL_OLD"` 把被删的整行打进
    #    CloudWatch Logs(`bff/web-chat/inspection.mjs`)。真正要在 IAM 上守住的
    #    是下面第二条:**不给 BatchWriteItem、也不给 dynamodb:\* 通配** ——
    #    那才是「清理已过期」按钮唯一能落地的权限,一给就是一次 25 条起的
    #    批量删除,而且 ALL_OLD 在 BatchWriteItem 上根本不存在(审计静默丢失)。
    #    同一份判据另外两处也在守:`infra/test/fixtures/web-chat-stack.golden.json`
    #    的 golden(infra-tests)与 `frontend/chat-app/src/inspection.test.ts`
    #    都要求 DeleteItem 在 —— 把产品侧改回去会让那两个 job 红。
    wstmts = []
    for pol in by_type(res, "AWS::IAM::Policy").values():
        doc = pol.get("Properties", {}).get("PolicyDocument", {})
        for st in doc.get("Statement", []) or []:
            if st.get("Sid") == "InspectionScopeAndScheduleWrite":
                wstmts.append(st)
    check(len(wstmts) == 1, "BFF has the InspectionScopeAndScheduleWrite statement",
          str(len(wstmts)))
    for st in wstmts:
        actions = st.get("Action")
        actions = actions if isinstance(actions, list) else [actions]
        acts = {str(a) for a in actions}
        check("dynamodb:PutItem" in acts, "write statement grants PutItem", str(acts))
        check("dynamodb:UpdateItem" in acts,
              "write statement grants UpdateItem (renew uses update, not put)",
              str(acts))
        # 单行撤销:没有它,误排除的唯一出路是等 30 天(前端只会显示「操作失败」)。
        check("dynamodb:DeleteItem" in acts,
              "write statement grants DeleteItem (single-row undo of a mis-click)",
              str(acts))
        # 批量删除这条门才是 R1.4 的守卫:BatchWriteItem / dynamodb:* 一给,
        # 「清理已过期」按钮就能落地,而 ALL_OLD 审计在批量写上不存在。
        #
        # ⚠️ 必须按 **IAM 的通配语义**判,不能按字面列表判。第一版写成
        #    `a in ("dynamodb:BatchWriteItem", "dynamodb:*", "*")`,于是
        #    `dynamodb:Batch*` / `dynamodb:*Item` / `dynamodb:BatchWriteItem*`
        #    三种都放行 —— 它们授的权限一模一样,只是拼法不同。一道只认字面量的
        #    权限闸门等于没有闸门:下一次谁图省事写个前缀通配,判据照绿。
        #    所以把 statement 里的每条 action 当 pattern,去 match 下面这批
        #    **真能绕过逐行审计**的 API(IAM 的 action 匹配大小写不敏感)。
        bulk = {a for a in acts if _iam_matches_any(a, BULK_DELETE_APIS)}
        check(not bulk,
              "write statement grants NO bulk delete (R1.4 keeps expired records)",
              str(sorted(bulk)) if bulk else str(acts))
        blob = json.dumps(st.get("Resource"))
        check(INSPECTION_TABLE_NAME in blob and '"*"' not in blob,
              f"write statement is scoped to {INSPECTION_TABLE_NAME}", blob[:160])

    # ⚠️ 采集权限属于 **NotiOpsBackendStack**，不在这里查 ——
    #    WebChatStack 里没有 LambdaExecutionRole / IdleDetectionRole，
    #    放这里必然报 missing（第一版就插错了位置）。它在 main() 里调。

    print(f"\n{checks - len(failures)}/{checks} checks passed")
    if failures:
        print("failed: " + ", ".join(failures))
        return 1
    return 0


def check_collector_permissions(res: dict) -> None:
    """★ 采集侧的 AWS 只读权限。

    🔴 真实事故（东京 111122223333）：角色只有 `rds:DescribeDBInstances`，
    缺 `rds:DescribeDBClusters`。后果是整轮巡检**成功结束、零错误码**：

    ```
    describe_db_clusters → AccessDenied（只是一行 WARNING）
        → loaded 0 RDS attrs
        → 范围: 0 台资源
        → 看板「本轮未发现风险」
    ```

    Aurora 用的是集群而不是实例，所以缺这一条等于「有 Aurora 的账号
    一台都巡检不到」。而且 rollup 的分母也退化 —— 集群成员展开失败后
    覆盖率按已评估数算，于是「漏了一半」显示成 100% 完整。

    `DescribeEvents` 是变更事件抑制（R2.5）用的：缺它不会让巡检失败，
    但抑制条件恒不成立 → 客户在维护窗口后第一天收到一批本该压掉的告警。
    """
    need = {
        "rds:DescribeDBInstances", "rds:DescribeDBClusters", "rds:DescribeEvents",
        # 引擎 EOL 判定。缺它 `loaded 0 engine major-version lifecycles`，
        # 结构性风险里那一整类 finding 永远为空 —— 而页面上与「没有 EOL
        # 风险」无法区分（东京实测，四个引擎各报一次 AccessDenied 后静静算完）。
        "rds:DescribeDBMajorEngineVersions",
        # CA 证书到期规则。缺它 load_ca_certs 返回空表 → 那条规则永远不命中，
        # 与「没有证书风险」无法区分（东京 2026-08-22 实测报 AccessDenied）。
        "rds:DescribeCertificates",
        "elasticache:DescribeCacheClusters",
        "elasticache:DescribeReplicationGroups",
        "elasticache:DescribeEvents",
        "cloudwatch:GetMetricData",
    }
    # 两个角色都要：lambdaRole 是部署账号那侧，idleDetectionRole 是成员账号
    # 那侧被 assume 的角色。只补一个会让「本账号巡检得到、成员账号巡检不到」，
    # 而两边的表现都是「本轮未发现风险」。
    # ⚠️ 按**角色**聚合，不是按单个 Policy 资源。CDK 把 addToPolicy 的多次
    #    调用合并进一个 DefaultPolicy，但里面是**多条 statement** ——
    #    cloudwatch:GetMetricData 与 rds:Describe* 就在不同 statement 里。
    #    第一版要求单条 statement 同时含全部，于是权限明明齐了却报 missing。
    for role_hint in ("LambdaExecutionRole", "IdleDetectionRole"):
        granted: set[str] = set()
        for name, v in res.items():
            if v.get("Type") != "AWS::IAM::Policy":
                continue
            # Policy 的 logical id 形如 `<Role>DefaultPolicy<hash>`；
            # 同时核对 Roles 里真的引用了那个角色，避免同名前缀误配。
            roles_blob = json.dumps(v.get("Properties", {}).get("Roles", []))
            if role_hint not in name and role_hint not in roles_blob:
                continue
            for st in v.get("Properties", {}).get("PolicyDocument", {}).get(
                    "Statement", []):
                act = st.get("Action")
                for a in ([act] if isinstance(act, str) else (act or [])):
                    if isinstance(a, str):
                        granted.add(a)
        missing = sorted(need - granted)
        check(not missing, f"{role_hint} grants every collector read action",
              f"missing: {missing}")


if __name__ == "__main__":
    backend_dir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/synth"
    rc = main(backend_dir)
    # 第二个参数给了就一并查 WebChatStack；没给只查后端（向后兼容既有调用）。
    if len(sys.argv) > 2:
        rc = check_webchat(sys.argv[2]) or rc
    sys.exit(rc)
