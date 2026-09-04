#!/usr/bin/env python3
"""触发一轮**真实**巡检，然后逐层核对落库结果。

## 为什么需要它

2026-08-25 用真实资源挖出的四个 P0 全部有同一个形态：

```
run 状态 success · completeness 100% · 零错误码
而某一层的数据是空的，且与「本来就没有问题」无法区分
3000 多个单测全绿（fake 数据是「我们以为的形状」）
```

那一轮是手工跑的：改代码 → 部署 → 删 run 锁 → invoke scheduler →
等 executor → 查 DDB → 对着日志找哪一层断了，来回五次。
本脚本把那个循环收成一条命令，并把每一层的判据写成断言。

## 用法

```bash
# 跑一轮高负载并核对
python3 scripts/inspection_verify_live.py --run-type high

# 只核对上一轮的结果，不重新触发
python3 scripts/inspection_verify_live.py --check-only

# 强制重跑今天（删掉今天的 run 锁）
python3 scripts/inspection_verify_live.py --run-type idle --force
```

🔴 `--force` 会**删掉今天那条 run 记录**。它是 R6.8 的每日幂等锁 ——
删掉的唯一影响是允许今天再跑一轮，但**别在生产账号上随便用**：
如果那一轮已经推送过报告，重跑会让状态机的 `consecutive_hits` 多走一格。

## 核对哪几层

```
① 采集    RDS / ElastiCache attrs 数量、memory_bytes 补全率
② 判定    finding 条数、按规则分布
③ 证据    实测值 / 阈值 / 余量 / 评分因子 是否落库
④ 派发    dispatched vs mapped（taskId 接住了没有）
⑤ 判读    da_parse_status 四档分布
```

⚠️ 本脚本**只读 + 触发**，不改判定结果。唯一的写操作是 `--force` 删 run 锁。
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# 🔴 **参数化，不写死。**
#
#    这两个原来是常量。而 §八 第 5 步（executor 跨账号切换）指定用本脚本逐层
#    核对，同时又写着「风险面只在**有成员账号**的部署上」—— 上线闸门与风险面
#    完全不相交：唯一切换行为的那一步，验证工具只跑那个零变化的账号。
#
# ⚠️ 默认值保持原样（部署账号），所以既有用法一字不变。
REGION = os.environ.get("AWS_REGION") or "ap-northeast-1"
ACCT = os.environ.get("VERIFY_ACCOUNT_ID") or "111122223333"
SCHEDULER = "notiops-inspection-scheduler"
EXECUTOR = "notiops-inspection-executor"

fails: list[str] = []
warns: list[str] = []

# `--expect-space-in-account` 的值（空 = 不做那条断言）。
_VERIFY_SPACE_IN_ACCOUNT = ""


def _space_belongs_to(space_id: str, account_id: str) -> bool:
    """那个 space 是不是**这个账号**里的。

    space id 是裸 UUID，看不出账号 —— 所以去那个账号里 `ListAgentSpaces` 对一遍。
    成员账号要先 assume 它的 TriggerRole。

    ⚠️ 取不到时返回 **False** 并打印原因，不返回 True。「查不出来」与「属于它」
    是两件事，而后者是本条断言要证明的东西。
    """
    import boto3
    try:
        if account_id == os.environ.get("DEPLOY_ACCOUNT_ID", "") or \
                account_id == boto3.client(
                    "sts", region_name=REGION).get_caller_identity()["Account"]:
            c = boto3.client("devops-agent", region_name=REGION)
        else:
            from shared.devops_agent import build_cross_account_devops_client
            c, _ = build_cross_account_devops_client(
                account_id, source="verify-live",
                account_already_authorized=True)
            if c is None:
                print(f"    （建不出 {account_id} 的跨账号 client，判据无法证实）")
                return False
        ids = set()
        tok = None
        while True:
            kw = {"nextToken": tok} if tok else {}
            r = c.list_agent_spaces(**kw)
            ids |= {s.get("agentSpaceId") for s in r.get("agentSpaces", [])}
            tok = r.get("nextToken")
            if not tok:
                break
        return space_id in ids
    except Exception as e:                                 # noqa: BLE001
        print(f"    （ListAgentSpaces 失败: {type(e).__name__}: {e}）")
        return False


def _check(cond: bool, label: str, got: object = "") -> None:
    if cond:
        print(f"    ✓ {label}" + (f"  ({got})" if got != "" else ""))
    else:
        print(f"    ✗ {label}  实际: {got!r}")
        fails.append(label)


def _warn(cond: bool, label: str, got: object = "") -> None:
    """不达标但不算失败的观察项（例如新建资源数据不足）。"""
    if cond:
        print(f"    ✓ {label}" + (f"  ({got})" if got != "" else ""))
    else:
        print(f"    ⚠ {label}  实际: {got!r}")
        warns.append(label)


def _table():
    import boto3
    lam = boto3.client("lambda", region_name=REGION)
    env = lam.get_function_configuration(
        FunctionName=EXECUTOR)["Environment"]["Variables"]
    # 🔴 表名从 **Lambda 的环境变量**读，不写死。
    #    `idle-detector-*` 是旧名，现役是 `notiops-*` —— 写死会让这个脚本
    #    查一张空表然后报告「一条 finding 都没有」。
    name = env["INSPECTION_TABLE"]
    print(f"  巡检表: {name}   巡检 AgentSpace: {env.get('INSPECT_AGENT_SPACE_ID','?')}")
    return boto3.resource("dynamodb", region_name=REGION).Table(name), env


def _drop_lock(table, run_type: str, day: datetime.date) -> None:
    from inspection.adapters import keys
    pk = keys.run_pk(run_type, day)
    got = table.get_item(Key={"PK": pk, "SK": ACCT}).get("Item")
    if not got:
        print(f"  今天没有 {run_type} 的 run 锁，无需删")
        return
    table.delete_item(Key={"PK": pk, "SK": ACCT})
    print(f"  ✓ 已删 run 锁 {pk}（status 曾是 {got.get('status')}）")


def _trigger(run_type: str) -> dict:
    import boto3
    lam = boto3.client("lambda", region_name=REGION)
    payload = {"manual_trigger": {
        "run_type": run_type, "account_ids": [ACCT],
        "source": "refetch", "mode": "official",
        "requested_by": "inspection_verify_live"}}
    r = lam.invoke(FunctionName=SCHEDULER,
                   Payload=json.dumps(payload).encode())
    body = json.loads(r["Payload"].read() or b"{}")
    print(f"  scheduler → {body}")
    return body


def _tail_logs(minutes: int = 4) -> list[str]:
    import boto3
    logs = boto3.client("logs", region_name=REGION)
    start = int((time.time() - minutes * 60) * 1000)
    out: list[str] = []
    try:
        pages = logs.get_paginator("filter_log_events").paginate(
            logGroupName=f"/aws/lambda/{EXECUTOR}", startTime=start)
        for p in pages:
            out.extend(e.get("message", "") for e in p.get("events", []))
    except Exception as e:                                 # noqa: BLE001
        print(f"  读日志失败: {type(e).__name__}: {e}")
    return out


def _layer_collect(lines: list[str]) -> None:
    """① 采集层。判据全部来自 executor 的 INFO 行。"""
    print("\n① 采集")
    rds = next((l for l in lines if "loaded" in l and "RDS attrs" in l), "")
    ec = next((l for l in lines if "loaded" in l and "ElastiCache attrs" in l), "")
    mem = next((l for l in lines if "resolved memory for" in l), "")
    scope = next((l for l in lines if "范围:" in l), "")
    print(f"    {rds.strip()[-64:] if rds else '（无 RDS 采集日志）'}")
    print(f"    {ec.strip()[-64:] if ec else '（无 EC 采集日志）'}")

    # 🔴 `resolved memory for N/M` —— 这一行是 2026-08-25 那个 P0 的唯一信号。
    #    N=0 意味着 `freeable_memory_pct` / `database_memory_usage_pct`
    #    的分母全缺 → 内存类规则一条都不命中，而看板与「内存都健康」无法区分。
    if mem:
        seg = mem.split("resolved memory for", 1)[1].split()[0]      # "5/5"
        got, want = (seg.split("/") + ["0"])[:2]
        _check(got == want and want != "0",
               "🔴 memory_bytes 全部补全（内存类判定的分母）", seg)
    else:
        _warn(False, "日志里没有 `resolved memory for` —— 这一轮没有需要补内存的机型？")
    if scope:
        print(f"    {scope.strip()[-52:]}")


def _layer_findings(table) -> list[dict]:
    """② 判定 + ③ 证据。"""
    from inspection.adapters import keys
    print("\n② 判定")
    items = table.query(
        KeyConditionExpression="PK = :p",
        ExpressionAttributeValues={":p": keys.finding_pk(ACCT)})["Items"]
    print(f"    finding 共 {len(items)} 条")
    by_rule: dict[str, int] = {}
    for i in items:
        seg = str(i.get("SK", "")).split("#")
        by_rule[seg[4] if len(seg) > 4 else "?"] = by_rule.get(
            seg[4] if len(seg) > 4 else "?", 0) + 1
    for k in sorted(by_rule, key=lambda x: -by_rule[x]):
        print(f"      {k:22} {by_rule[k]}")

    print("\n③ 判定证据")
    metric = [i for i in items
              if str(i.get("SK", "")).split("#")[4:5] in (["threshold_high"],
                                                          ["chronic_high"])]
    idle = [i for i in items if str(i.get("SK", "")).split("#")[4:5] == ["idle"]]
    if metric:
        # 🔴 **把假数据挑出来单独算。** `scripts/inspection_e2e.py` 的
        #    `_fake_findings` 造的探针行（`e2e-probe-*` / `synthetic-*`）
        #    压根不带证据字段 —— 混在分母里会让这一项恒红，于是真的缺证据
        #    那天也不会被注意到。
        real = [i for i in metric
                if not any(p in str(i.get("SK", ""))
                           for p in ("e2e-probe", "synthetic"))]
        faked = len(metric) - len(real)
        if real:
            with_val = sum(1 for i in real if i.get("value") is not None)
            _check(with_val == len(real),
                   "指标类 finding 都带实测值 vs 阈值",
                   f"{with_val}/{len(real)}")
            if with_val < len(real):
                for i in real:
                    if i.get("value") is None:
                        print(f"       缺证据: {str(i.get('SK'))[:78]}")
        if faked:
            print(f"    （另有 {faked} 条测试探针行不计入 —— "
                  "`_fake_findings` 刻意不造证据字段）")
        if not real:
            print("    （指标类 finding 全是测试探针行）")
    else:
        print("    （本轮没有指标类 finding —— 高负载轮零命中是正常的）")
    if idle:
        # 🔴 闲置条目「凭什么」的全部依据。缺了它看板上只有一个 INFO 徽标。
        with_score = sum(1 for i in idle if i.get("idle_score") is not None)
        _warn(with_score == len(idle),
              "闲置 finding 都带评分因子（idle_score / idle_factors）",
              f"{with_score}/{len(idle)}")
        if with_score < len(idle):
            print("       ⚠️ 新建资源（数据 < min_coverage_days）算不出分是**正常**的：")
            print("          四个维度全缺数据 → available_weight=0 → 不判定。")
            print("          这一项要在有 5 天以上历史的资源上才有意义。")
    else:
        print("    （本轮没有闲置 finding）")
    return items


def _layer_dispatch(table, run_type: str, day: datetime.date) -> None:
    """④ 派发。`dispatched > mapped` 意味着判读永久回不来。"""
    from inspection.adapters import keys
    print("\n④ 派发")
    run = table.get_item(
        Key={"PK": keys.run_pk(run_type, day), "SK": ACCT}).get("Item") or {}
    stats = run.get("stats") or {}
    dis = (stats.get("dispatch") or {})
    d, m = dis.get("dispatched_tasks"), dis.get("mapped_tasks")
    print(f"    run status={run.get('status')} completeness={stats.get('completeness')}")
    print(f"    dispatched={d}  mapped={m}  findings={dis.get('findings')} "
          f"heartbeat={dis.get('heartbeat')}")
    # 🔴 这是 taskId P0 的信号。两者不等 → `inspdispatch#` 映射是空的 →
    #    每条 finding 都停在「未做根因分析」，而 task 真的发出去了、额度花了。
    if d is not None and m is not None:
        _check(int(d) == int(m),
               "🔴 dispatched == mapped（taskId 接住了，判读能回拼）",
               f"{d} vs {m}")
    space = dis.get("agent_space_id")
    if space:
        _check(bool(space), "派发用了巡检专属 AgentSpace", space[:8])
    # 🔴 **per-account 之后必须验「派给了哪个账号的 space」。**
    #
    #    改动⑤ 之前 executor 恒往部署账号那一个 space 派 —— 而那时
    #    `dispatched == mapped`、run success、判读也真的回来，**看板上看不出来**。
    #    只是那份判读是「部署账号的 DA 用成员账号的 payload 做的」，
    #    秒数记在部署账号的 payer 上 ⇒ per-account 的全部收益一个都不成立。
    #
    # ⚠️ 判据不能只看 space 非空（那是改动⑤ 之前也满足的）。要看它到底属于谁 ——
    #    而 space id 是裸 UUID、看不出账号，所以去那个账号里 ListAgentSpaces 对一遍。
    want_acct = _VERIFY_SPACE_IN_ACCOUNT
    if space and want_acct:
        _check(_space_belongs_to(space, want_acct),
               f"🔴 派发用的 space 属于账号 {want_acct}",
               f"space={space[:8]}…")


def _layer_judgement(items: list[dict]) -> None:
    """⑤ 判读解析质量。四档不合并。"""
    print("\n⑤ AI 判读")
    dispatched = [i for i in items if i.get("da_task_id")]
    if not dispatched:
        print("    （没有派发过判读的 finding —— 闲置轮走 DETERMINISTIC，正常）")
        return
    dist: dict[str, int] = {}
    for i in dispatched:
        dist[str(i.get("da_parse_status") or "(还在路上)")] = dist.get(
            str(i.get("da_parse_status") or "(还在路上)"), 0) + 1
    print(f"    派发过判读 {len(dispatched)} 条，解析状态分布: {dist}")
    bad = dist.get("parse_failed", 0) + dist.get("empty", 0)
    _check(bad == 0,
           "没有 parse_failed / empty（skill 没漂移、输出没被截断）", dist)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--run-type", choices=["high", "idle"], default="high")
    ap.add_argument("--check-only", action="store_true",
                    help="只核对上一轮，不触发")
    ap.add_argument("--force", action="store_true",
                    help="删掉今天的 run 锁以允许重跑（见 docstring 的警告）")
    ap.add_argument("--wait", type=int, default=120,
                    help="触发后等多少秒再核对（默认 120）")
    ap.add_argument("--account", default="",
                    help="要核对哪个账号（默认部署账号；成员账号用它来验"
                         "跨账号那半 —— 那才是改动⑤ 的风险面）")
    ap.add_argument("--expect-space-in-account", default="",
                    help="断言派发用的 space **属于**这个账号。"
                         "per-account 之后这是唯一能看出「派给谁」的判据")
    args = ap.parse_args()

    # ⚠️ 用 global 而不是到处传参：本脚本的十几个 _layer_* 都读模块级 ACCT，
    #    改成传参要动全部签名，而它是个一次性核对工具。
    global ACCT, _VERIFY_SPACE_IN_ACCOUNT
    if args.account:
        ACCT = args.account
    _VERIFY_SPACE_IN_ACCOUNT = args.expect_space_in_account or ""
    print(f"  核对账号={ACCT}  region={REGION}")

    table, _env = _table()
    # ⚠️ 用 **UTC** 日期：run_date 是 executor 侧按 UTC 生成的。
    #    用本地日期会在东京时间 09:00 之前查错一天的 run 记录。
    today = datetime.datetime.now(datetime.timezone.utc).date()
    print(f"  run_type={args.run_type}  UTC 日期={today}")

    if not args.check_only:
        if args.force:
            _drop_lock(table, args.run_type, today)
        print("\n触发:")
        body = _trigger(args.run_type)
        if not body.get("dispatched"):
            print("  ⚠️ scheduler 没有派发任何 task。常见原因："
                  "今天已经跑过（加 --force）/ kill switch 关了 / 账号未启用。")
        print(f"\n等 {args.wait} 秒让 executor 跑完…")
        time.sleep(args.wait)

    # ⚠️ `--check-only` 时窗口拉长到 45 分钟：那个模式的用途是「核对上一轮」，
    #    而上一轮可能是几十分钟前跑的。用 6 分钟窗口会读到空日志，然后把
    #    「没有 `resolved memory for` 这一行」报成一个观察项 —— 而那只是
    #    日志窗口没覆盖到。
    lines = _tail_logs(minutes=45 if args.check_only else 5)
    err = [l for l in lines if "[ERROR]" in l]
    if err:
        print(f"\n🔴 executor 日志里有 {len(err)} 条 ERROR:")
        for l in err[:5]:
            print(f"    {l.strip()[:150]}")
        fails.append(f"executor 有 {len(err)} 条 ERROR")

    _layer_collect(lines)
    items = _layer_findings(table)
    _layer_dispatch(table, args.run_type, today)
    _layer_judgement(items)

    print("\n" + "=" * 72)
    if fails:
        print(f"❌ {len(fails)} 项不通过:")
        for f in fails:
            print(f"   · {f}")
    if warns:
        print(f"⚠️  {len(warns)} 项观察（不一定是缺陷，见上面的说明）:")
        for w in warns:
            print(f"   · {w}")
    if not fails:
        print("✅ 各层核对通过")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
