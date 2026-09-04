#!/usr/bin/env python3
"""一次性探针：`ArnLike aws:PrincipalArn` 在 **event bus 资源策略**上的确切形态。

per-account agent space 的设计要求动手前先验这一条。它决定 event bus 的资源
策略怎么写，而写错的表现是**事件静默不到**（零错误码）。

## 为什么不能用手工 `aws events put-events` 验

那时 `aws:PrincipalArn` 是发起人自己的（IAM user，或 SSO 的
`assumed-role/AWSReservedSSO_*`），必然不匹配 `...forwarder-role-*` ——
而不匹配无法区分「策略写错」和「测试方法错」。必须让 **EventBridge 自己**
以那个角色去投递，也就是生产形态。

## 为什么建一条独立的探针总线

生产总线 `notiops-devops-events` 今天的 `Policy` 是 `None`（实测），所以理论上
可以直接拿它试。但：

1. 往生产总线加语句 = 改**线上安全边界**，探针失败时可能留下一条放行语句
2. 探针要试**两种**形态（iam 与 sts），其中一种预期不匹配 —— 反复改生产策略
3. 探针需要一个能确定性观察到「到了没」的 target，生产总线上挂新 target
   会与真实 callback 规则混在一起

所以：677 建 `notiops-probe-arnlike-bus` + 一条规则投 SQS；698 建转发角色 + 规则。
全部资源以 `notiops-probe-arnlike` 开头，`--cleanup` 一把删干净。

## 判据

```
iam 形态   arn:aws:iam::*:role/notiops-devops-forwarder-role-*        预期：到
sts 形态   arn:aws:sts::*:assumed-role/notiops-devops-forwarder-role-*/*  预期：不到
```

`sts` 那半是**反面对照**。只验 iam 到了不够 —— 万一策略被别的条件放行（比如
Condition 整个被忽略），两种形态都会「到」，而那时 iam 那条的绿是假的。

顺带验第二件（SA review 标 ❓ 的那条）：`source` 以 `aws.` 开头的自定义
`PutEvents` 会不会被服务端拒。文档只说「不应该」，没说「不能」。

用法：
    AWS_REGION=ap-northeast-1 .venv/bin/python scripts/probe_arnlike_bus_policy.py
    AWS_REGION=ap-northeast-1 .venv/bin/python scripts/probe_arnlike_bus_policy.py --cleanup
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import boto3

REGION = "ap-northeast-1"
SENDER_PROFILE = os.environ.get("SENDER_PROFILE", "default")  # 发送方账号的 profile
PREFIX = "notiops-probe-arnlike"
BUS = f"{PREFIX}-bus"
QUEUE = f"{PREFIX}-q"
RULE_RECV = f"{PREFIX}-to-sqs"
RULE_SEND = f"{PREFIX}-forward"
# 🔴 角色名必须匹配真实模板里的形状（member-account-onboarding.yaml:256），
#    否则验的就不是生产会用的那个 ARN。
ROLE = "notiops-devops-forwarder-role-444455556666"
# 🔴 **不能用 `aws.aidevops` 做发送侧的 source。** 实测（2026-08-29）：
#    PutEvents(Source="aws.aidevops") → NotAuthorizedForSourceException
#    「Not authorized for the source.」——`aws.` 是保留前缀，直接调 API 填不了。
#    （这个错误码连 PutEvents 的官方错误表里都没有，那张表只列了 InternalException。）
#    所以验 ArnLike 形态要用一个**自定义** source，否则 PutEvents 那一步就先失败，
#    根本走不到策略判定。
PROBE_SOURCE = "notiops.probe"
# 保留前缀的 source 由**服务**产生，验它能不能被跨账号转发要另起一段（阶段 C）。
SCHED_RULE = f"{PREFIX}-sched"
# 阶段 D 要用真实的 source 值做条件（而发送侧只能用自定义 source，见上）——
# 所以阶段 D 改成让**定时规则**去投，它产生的 source 是 aws.events。
SOURCE_AIDEVOPS = "aws.events"
STMT = "ProbeArnLike"

IAM_FORM = f"arn:aws:iam::*:role/notiops-devops-forwarder-role-*"
STS_FORM = f"arn:aws:sts::*:assumed-role/notiops-devops-forwarder-role-*/*"


def _c(svc, profile=None):
    s = boto3.Session(profile_name=profile) if profile else boto3.Session()
    return s.client(svc, region_name=REGION)


def _conditions(arn_pattern: str, source_mode: str) -> dict:
    """按 `source_mode` 造 Condition。

    ```
    "arnlike-only"   只有 ArnLike —— 用来让 ArnLike 成为唯一的闸（阶段 A/B）
    "forallvalues"   生产要上的那条：ForAllValues:StringEquals + Null
    "stringequals"   官方跨账号 PutEvents 例子里的写法：普通 StringEquals + Null
    ```

    🔴 **阶段 D 存在的理由**（2026-08-29 review 抓出来的）：本脚本第一版的
    `_bus_policy` docstring 写着「形状与改动② 要写进 CDK 的那条**一致**，
    包括 Null 检查」，而函数体里只有 ArnLike —— docstring 与代码直接矛盾。
    也就是说**生产要上的那条完整 Condition 从没在跨账号转发这条路上跑过**。

    ⚠️ 为什么这不是小事：`events:source` 在 EventBridge 的条件键表里
    Evaluation types 是 `Source, Null`（**单值**），而该页所有
    `ForAllValues` 例子都是 `events:PutRule` 场景（约束 event pattern 里可以列
    多个 source）。官方跨账号 `PutEvents` 的例子一律用普通 `StringEquals`。
    如果规则跨账号投递时请求上下文里**没有** `events:source` 这个键，
    `Null: {"events:source": "false"}` 求值为 false → 语句永不匹配 →
    全部成员账号事件静默不到，零错误码 —— 正好是这条策略号称要防的形态。
    """
    cond: dict = {"ArnLike": {"aws:PrincipalArn": arn_pattern}}
    if source_mode == "forallvalues":
        cond["ForAllValues:StringEquals"] = {"events:source": SOURCE_AIDEVOPS}
        cond["Null"] = {"events:source": "false"}
    elif source_mode == "stringequals":
        cond["StringEquals"] = {"events:source": SOURCE_AIDEVOPS}
        cond["Null"] = {"events:source": "false"}
    return cond


def _bus_policy(principal_arn_pattern: str, bus_arn: str,
                source_mode: str = "arnlike-only") -> str:
    """探针策略。形状与改动② 要写进 CDK 的那条**一致**，包括 Null 检查。

    ⚠️ `ForAllValues` 不配 `Null` 检查时，缺键会在空集上求值并返回 true
    （EventBridge UG `eb-use-conditions.html` 明写可绕过 source 限制）。
    探针里也带上，否则验的形状与要上线的不同。
    """
    return json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": STMT,
            "Effect": "Allow",
            # Principal 元素不支持部分通配，只能 "*" + Condition 收紧
            "Principal": {"AWS": "*"},
            "Action": "events:PutEvents",
            "Resource": bus_arn,
            "Condition": _conditions(principal_arn_pattern, source_mode),
        }],
    })


def setup_receiver(form: str) -> tuple[str, str]:
    ev, sqs, sts = _c("events"), _c("sqs"), _c("sts")
    acct = sts.get_caller_identity()["Account"]

    try:
        bus_arn = ev.create_event_bus(Name=BUS)["EventBusArn"]
        print(f"  建总线 {BUS}")
    except ev.exceptions.ResourceAlreadyExistsException:
        bus_arn = ev.describe_event_bus(Name=BUS)["Arn"]
        print(f"  总线已存在 {BUS}")

    q_url = sqs.create_queue(QueueName=QUEUE)["QueueUrl"]
    q_arn = sqs.get_queue_attributes(
        QueueUrl=q_url, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
    rule_arn = f"arn:aws:events:{REGION}:{acct}:rule/{BUS}/{RULE_RECV}"
    sqs.set_queue_attributes(QueueUrl=q_url, Attributes={"Policy": json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "events.amazonaws.com"},
            "Action": "sqs:SendMessage",
            "Resource": q_arn,
            "Condition": {"ArnEquals": {"aws:SourceArn": rule_arn}},
        }],
    })})
    # 接收侧规则匹配**任意** source：阶段 C 要看到服务产生的那个 source 是什么，
    # 写死 source 会让「转过来了但 source 不是我猜的那个」表现成「没转过来」。
    ev.put_rule(Name=RULE_RECV, EventBusName=BUS, State="ENABLED",
                EventPattern=json.dumps({"account": ["444455556666"]}))
    ev.put_targets(Rule=RULE_RECV, EventBusName=BUS,
                   Targets=[{"Id": "q", "Arn": q_arn}])
    # 资源策略：这是被验的那一条
    ev.put_permission(EventBusName=BUS, Policy=_bus_policy(form, bus_arn))
    print(f"  策略已挂（{'iam' if ':iam:' in form else 'sts'} 形态）")
    return bus_arn, q_url


def setup_sender(bus_arn: str) -> None:
    iam, ev = _c("iam", SENDER_PROFILE), _c("events", SENDER_PROFILE)
    trust = json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "events.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }],
    })
    try:
        role_arn = iam.create_role(
            RoleName=ROLE, AssumeRolePolicyDocument=trust,
            Description="throwaway probe for ArnLike bus policy form",
        )["Role"]["Arn"]
        print(f"  建角色 {ROLE}")
    except iam.exceptions.EntityAlreadyExistsException:
        role_arn = iam.get_role(RoleName=ROLE)["Role"]["Arn"]
        print(f"  角色已存在 {ROLE}")
    iam.put_role_policy(
        RoleName=ROLE, PolicyName="PutEventsToProbeBus",
        PolicyDocument=json.dumps({
            "Version": "2012-10-17",
            "Statement": [{"Effect": "Allow", "Action": "events:PutEvents",
                           "Resource": bus_arn}],
        }))
    ev.put_rule(Name=RULE_SEND, State="ENABLED",
                EventPattern=json.dumps({"source": [PROBE_SOURCE]}))
    ev.put_targets(Rule=RULE_SEND, Targets=[
        {"Id": "xa", "Arn": bus_arn, "RoleArn": role_arn}])
    # 阶段 C：**定时**规则。它的事件由服务产生 → source 是保留前缀，
    # 而那正是「reserved source 能不能被跨账号转发」要验的东西。
    ev.put_rule(Name=SCHED_RULE, State="ENABLED",
                ScheduleExpression="rate(1 minute)")
    ev.put_targets(Rule=SCHED_RULE, Targets=[
        {"Id": "xa", "Arn": bus_arn, "RoleArn": role_arn}])
    print(f"  发送侧就绪：自定义 source 规则 + 定时规则（698 → 677 {BUS}）")


def fire_and_wait(q_url: str, marker: str, *, wait_s: int = 90) -> bool:
    ev, sqs = _c("events", SENDER_PROFILE), _c("sqs")
    # ⚠️ **不 purge**：PurgeQueue 有「每 60 秒一次」的硬节流，而三段是连着跑的。
    #    靠 marker 过滤就够（每段 marker 不同）。
    resp = ev.put_events(Entries=[{
        "Source": PROBE_SOURCE,
        "DetailType": "Investigation Completed",
        "Detail": json.dumps({"probe": marker}),
    }])
    # 顺带验「source 以 aws. 开头会不会被拒」
    print(f"  PutEvents(source={PROBE_SOURCE}) → FailedEntryCount="
          f"{resp.get('FailedEntryCount')} {resp.get('Entries')}")
    if resp.get("FailedEntryCount"):
        print("  🔴 PutEvents 本身失败，走不到策略判定")
        return False

    deadline = time.time() + wait_s
    while time.time() < deadline:
        msgs = sqs.receive_message(
            QueueUrl=q_url, MaxNumberOfMessages=10,
            WaitTimeSeconds=10).get("Messages", [])
        for m in msgs:
            if marker in m["Body"]:
                sqs.delete_message(QueueUrl=q_url,
                                   ReceiptHandle=m["ReceiptHandle"])
                return True
    return False


def wait_for_reserved_source(q_url: str, *, wait_s: int = 200) -> str | None:
    """阶段 C：等定时规则那条事件，返回它的 `source`（拿不到返回 None）。

    🔴 这一段验的是整个方案的生死线：`PutEvents(Source="aws.*")` 被服务端拒
    （NotAuthorizedForSourceException，本脚本阶段 A 实测），而 EventBridge
    跨账号投递底层也是 PutEvents —— 如果保留前缀的 source **转不过去**，
    那么「成员账号的 aws.aidevops 判读事件推回系统账号」这条路根本不存在，
    整个事件推方案要退回主动拉。

    ⚠️ 用定时规则（服务产生的事件）而不是真的 DA 调查：前者免费、1 分钟一次、
    确定性强。结论对 `aws.aidevops` 的外推依据是「`aws.` 是**前缀级**保留，
    不是逐 source 白名单」—— 这一点本身未经逐字查证，所以要在文档里标明
    「以 aws.events 实测，按前缀语义外推」。
    """
    sqs = _c("sqs")
    deadline = time.time() + wait_s
    while time.time() < deadline:
        for m in sqs.receive_message(
                QueueUrl=q_url, MaxNumberOfMessages=10,
                WaitTimeSeconds=10).get("Messages", []):
            body = json.loads(m["Body"])
            src = body.get("source", "")
            sqs.delete_message(QueueUrl=q_url, ReceiptHandle=m["ReceiptHandle"])
            if src.startswith("aws."):
                print(f"    收到保留前缀事件：source={src} "
                      f"detail-type={body.get('detail-type')} "
                      f"account={body.get('account')}")
                return src
    return None


def cleanup() -> None:
    ev, sqs = _c("events"), _c("sqs")
    sev, iam = _c("events", SENDER_PROFILE), _c("iam", SENDER_PROFILE)
    for fn, what in [
        (lambda: sev.remove_targets(Rule=RULE_SEND, Ids=["xa"]), "698 规则 target"),
        (lambda: sev.delete_rule(Name=RULE_SEND), "698 规则"),
        (lambda: sev.remove_targets(Rule=SCHED_RULE, Ids=["xa"]), "698 定时规则 target"),
        (lambda: sev.delete_rule(Name=SCHED_RULE), "698 定时规则"),
        (lambda: iam.delete_role_policy(RoleName=ROLE,
                                        PolicyName="PutEventsToProbeBus"), "698 内联策略"),
        (lambda: iam.delete_role(RoleName=ROLE), "698 角色"),
        (lambda: ev.remove_permission(EventBusName=BUS, StatementId=STMT), "677 总线策略"),
        (lambda: ev.remove_targets(Rule=RULE_RECV, EventBusName=BUS, Ids=["q"]), "677 规则 target"),
        (lambda: ev.delete_rule(Name=RULE_RECV, EventBusName=BUS), "677 规则"),
        (lambda: ev.delete_event_bus(Name=BUS), "677 总线"),
        (lambda: sqs.delete_queue(
            QueueUrl=sqs.get_queue_url(QueueName=QUEUE)["QueueUrl"]), "677 队列"),
    ]:
        try:
            fn()
            print(f"  已删 {what}")
        except Exception as e:                                  # noqa: BLE001
            print(f"  跳过 {what}: {type(e).__name__}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cleanup", action="store_true")
    a = ap.parse_args()
    if a.cleanup:
        print("清理探针资源：")
        cleanup()
        return 0

    print("A. iam 形态（只有 ArnLike，预期：到）")
    bus_arn, q_url = setup_receiver(IAM_FORM)
    setup_sender(bus_arn)
    print("  等策略/规则生效（最终一致）…")
    time.sleep(25)
    iam_ok = fire_and_wait(q_url, "probe-iam-form")
    print(f"  → {'✅ 到了' if iam_ok else '❌ 没到'}")

    print("\nB. sts 形态（反面对照，预期：不到）")
    _c("events").put_permission(
        EventBusName=BUS, Policy=_bus_policy(STS_FORM, bus_arn))
    time.sleep(25)
    sts_ok = fire_and_wait(q_url, "probe-sts-form", wait_s=60)
    print(f"  → {'❌ 也到了（Condition 没起作用，A 的绿是假的）' if sts_ok else '✅ 没到'}")

    print("\nC. 保留前缀 source 能不能被跨账号转发（只有 ArnLike）")
    _c("events").put_permission(
        EventBusName=BUS, Policy=_bus_policy(IAM_FORM, bus_arn))
    time.sleep(20)
    print("  等定时规则触发（rate(1 minute)，最多等 200 秒）…")
    reserved_src = wait_for_reserved_source(q_url)
    print(f"  → {'✅ 转过来了' if reserved_src else '❌ 没转过来'}")

    # ── 阶段 D：生产要上的那条完整 Condition，走**规则转发**这条真实路径 ──
    print("\nD. 生产那条完整 Condition（review 抓出：此前从没验过）")
    results = {}
    for mode, label in [("forallvalues", "ForAllValues:StringEquals + Null（当前 CDK 写的）"),
                        ("stringequals", "StringEquals + Null（官方跨账号例子的写法）")]:
        _c("events").put_permission(
            EventBusName=BUS,
            Policy=_bus_policy(IAM_FORM, bus_arn, source_mode=mode))
        print(f"  {label}")
        time.sleep(25)
        got = wait_for_reserved_source(q_url, wait_s=170)
        results[mode] = bool(got)
        print(f"    → {'✅ 到了' if got else '❌ 没到'}")

    print("\n" + "=" * 70)
    ok = iam_ok and not sts_ok
    if ok:
        print("A/B：iam 形态匹配、sts 形态不匹配 —— 文档的更正成立。")
    elif iam_ok and sts_ok:
        print("A/B：两种都到 —— Condition 没起作用，本次结果不可用。")
    else:
        print("A/B：iam 形态也没到 —— 改动② 的策略形状要重新设计。")
    print(f"C  ：保留前缀 source{'（' + str(reserved_src) + '）能' if reserved_src else '**不能**'}"
          "被跨账号转发。")
    print(f"D  ：ForAllValues+Null → {'✅ 通' if results['forallvalues'] else '❌ 不通'}"
          f"   |   StringEquals+Null → {'✅ 通' if results['stringequals'] else '❌ 不通'}")
    if results["forallvalues"]:
        print("     ⇒ 当前 CDK 的写法在真实转发路径上成立，改动② 不用改。")
    elif results["stringequals"]:
        print("     🔴 ⇒ **必须把 CDK 改成 StringEquals** ——")
        print("        ForAllValues 那条在转发路径上永不匹配，表现是事件静默不到。")
    else:
        print("     🔴 ⇒ 两种带 source 条件的写法都不通 —— source 条件本身")
        print("        在转发路径上用不了，改动② 要重新设计。")
    rc = 0 if (ok and reserved_src and results["forallvalues"]) else 1
    print("清理请跑：… scripts/probe_arnlike_bus_policy.py --cleanup")
    return rc


if __name__ == "__main__":
    sys.exit(main())
