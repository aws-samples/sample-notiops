#!/usr/bin/env python3
"""量 web-chat agent 的**冷启动首字延迟**（改冷启动相关代码前后的对照口径）。

为什么直接打 AgentCore Runtime、不走 BFF：
  我们优化的是 runtime 容器内部的开销（MCP 子进程拉起、模型目录读取、Agent 构造）。
  BFF 还要过 Cognito JWT + Function URL，既要人的口令、又给数字掺进一段与本次改动
  无关的固定开销。直接 `invoke_agent_runtime` 拿到的是**可归因**的数字。

为什么每次换 runtimeSessionId：
  AgentCore 按 session 隔离 —— 一个新 session = 一个新 microVM = 一次真冷启动。
  复用 session 会命中已常驻的容器，量出来的是热路径（几百毫秒），不是我们要的东西。
  所以 session id 必须**每轮唯一**，这也是本脚本不接受"复用 session"选项的原因。

口径（三个数，都从发出请求那一刻起算）：
  ttfb    第一个 SSE 帧到达 —— 容器已经开始说话（含 microVM 冷启 + import + 工具挂载）
  ttft    第一个**带文本**的帧 —— 用户在界面上看到第一个字（这是产品口径的"首字延迟"）
  total   流结束

用法：
  scripts/measure_cold_start.py --runs 5
  scripts/measure_cold_start.py --runs 5 --topic finops --label after
  scripts/measure_cold_start.py --runs 3 --json /tmp/before.json

比较两次结果：
  scripts/measure_cold_start.py --compare /tmp/before.json /tmp/after.json
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import uuid

REGION = os.environ.get("NOTIOPS_REGION", "us-east-1")
# 现网 web-chat runtime。给了 --arn 就用给的（验证账号 / 其它环境）。
DEFAULT_STACK = "AgentCore-NotiOpsWebChat-default"


def _resolve_arn(session, explicit: str | None) -> str:
    if explicit:
        return explicit
    env = os.environ.get("AGENT_RUNTIME_ARN")
    if env:
        return env
    cfn = session.client("cloudformation", region_name=REGION)
    outs = cfn.describe_stacks(StackName=DEFAULT_STACK)["Stacks"][0].get("Outputs", [])
    for o in outs:
        if o["OutputKey"].startswith("ApplicationAgentNotiOpsWebChatRuntimeArnOutput"):
            return o["OutputValue"]
    raise SystemExit(f"找不到 runtime ARN（stack {DEFAULT_STACK} 没有对应 Output）；用 --arn 显式指定")


def _payload(prompt: str, topic: str, locale: str, model: str) -> bytes:
    """与 bff/web-chat/agentcore.mjs `buildRuntimePayload` 对齐的最小字段集。
    刻意**不传** generation —— 传 0 会让 runtime 每轮强制 ConsistentRead 读模型目录，
    那是 BFF 才有的行为，掺进来会污染对照（见 agentcore.mjs 里那段注释）。"""
    body = {
        "prompt": prompt,
        "model": model,
        "locale": locale,
        "web_search": False,
        "finops_agent": False,
        "devops_agent": False,
        "now": time.strftime("%Y-%m-%d"),
        "topic": topic,
        "account_id": "",
        "allowed_accounts": "*",
        "skill_id": "",
        "skill_version": "",
    }
    return json.dumps(body).encode("utf-8")


def _one_run(client, arn: str, prompt: str, topic: str, locale: str, model: str,
             verbose: bool) -> dict:
    # ≥33 字符且只含 [A-Za-z0-9_-]；每轮唯一 → 保证是新 microVM。
    sid = f"coldprobe-{uuid.uuid4().hex}-{uuid.uuid4().hex}"[:64]
    t0 = time.monotonic()
    resp = client.invoke_agent_runtime(
        agentRuntimeArn=arn,
        runtimeSessionId=sid,
        contentType="application/json",
        accept="text/event-stream",
        payload=_payload(prompt, topic, locale, model),
    )
    ttfb = ttft = None
    chars = 0
    buf = ""
    body = resp.get("response")
    if body is None:
        raise SystemExit("响应里没有 response 流（API 形状变了？）")
    for chunk in body.iter_chunks() if hasattr(body, "iter_chunks") else body:
        if ttfb is None:
            ttfb = time.monotonic() - t0
        buf += chunk.decode("utf-8", "replace")
        while "\n\n" in buf:
            block, buf = buf.split("\n\n", 1)
            for line in block.split("\n"):
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                try:
                    evt = json.loads(raw)
                except ValueError:
                    evt = raw
                text = _text_of(evt)
                if text:
                    chars += len(text)
                    if ttft is None:
                        ttft = time.monotonic() - t0
                        if verbose:
                            print(f"      first text: {text[:40]!r}")
    total = time.monotonic() - t0
    return {"session": sid[:20], "ttfb": ttfb, "ttft": ttft, "total": total, "chars": chars}


def _text_of(evt) -> str:
    """宽容提取文本增量（对齐 agentcore.mjs 的 extract：形态多样，能取到就算）。
    只用于计时，不求语义完整。"""
    if isinstance(evt, str):
        return evt
    if not isinstance(evt, dict):
        return ""
    for k in ("data", "text", "delta", "contentBlockDelta"):
        v = evt.get(k)
        if isinstance(v, str):
            return v
        if isinstance(v, dict):
            got = _text_of(v)
            if got:
                return got
    ev = evt.get("event")
    if isinstance(ev, dict):
        return _text_of(ev)
    return ""


def _fmt(vals: list[float | None]) -> str:
    got = [v for v in vals if v is not None]
    if not got:
        return "  n/a"
    med = statistics.median(got)
    return f"{med:6.2f}s  (min {min(got):5.2f} / max {max(got):5.2f}, n={len(got)})"


def _summary(runs: list[dict]) -> dict:
    out = {}
    for k in ("ttfb", "ttft", "total"):
        got = [r[k] for r in runs if r.get(k) is not None]
        out[k] = {"median": statistics.median(got) if got else None,
                  "min": min(got) if got else None,
                  "max": max(got) if got else None,
                  "n": len(got)}
    return out


def _compare(before_path: str, after_path: str) -> int:
    with open(before_path, encoding="utf-8") as f:
        before = json.load(f)
    with open(after_path, encoding="utf-8") as f:
        after = json.load(f)
    print(f"\n{'':10}{'before':>12}{'after':>12}{'delta':>12}{'':>10}")
    print("-" * 56)
    for k in ("ttfb", "ttft", "total"):
        b = (before["summary"][k] or {}).get("median")
        a = (after["summary"][k] or {}).get("median")
        if b is None or a is None:
            print(f"{k:10}{'n/a':>12}{'n/a':>12}")
            continue
        d = a - b
        pct = (d / b * 100) if b else 0.0
        print(f"{k:10}{b:11.2f}s{a:11.2f}s{d:+11.2f}s{pct:+9.1f}%")
    print(f"\nbefore: {before.get('label') or before_path}  ({before['runs_n']} runs)")
    print(f"after : {after.get('label') or after_path}  ({after['runs_n']} runs)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs", type=int, default=5, help="冷启动轮数（默认 5；每轮一个新 microVM）")
    ap.add_argument("--arn", help="agent runtime ARN（默认从 CFN Output 取）")
    ap.add_argument("--topic", default="general",
                    help="会话主题。general=核心工具子集；finops/investigate=全量（默认 general）")
    ap.add_argument("--locale", default="zh", choices=["zh", "en"])
    ap.add_argument("--model", default="", help="留空用服务端默认")
    ap.add_argument("--prompt", default="你好",
                    help="探针问题。刻意选**不需要调工具**的一句，量的是首字延迟而不是工具耗时")
    ap.add_argument("--label", default="", help="给这批结果起个名字（写进 json）")
    ap.add_argument("--json", dest="json_out", help="结果落盘路径（给 --compare 用）")
    ap.add_argument("--sleep", type=float, default=3.0, help="轮间隔秒数（默认 3）")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--compare", nargs=2, metavar=("BEFORE", "AFTER"),
                    help="只做对照、不发请求")
    args = ap.parse_args()

    if args.compare:
        return _compare(*args.compare)

    import boto3
    from botocore.config import Config
    session = boto3.Session()
    arn = _resolve_arn(session, args.arn)
    # 冷启动可能 60s+；read timeout 必须放得比它宽，否则量到的是超时不是延迟。
    client = session.client("bedrock-agentcore", region_name=REGION,
                            config=Config(read_timeout=300, connect_timeout=15,
                                          retries={"max_attempts": 0}))

    print(f"runtime : ...{arn[-40:]}")
    print(f"topic   : {args.topic}   locale: {args.locale}   prompt: {args.prompt!r}")
    print(f"runs    : {args.runs}（每轮新 session = 新 microVM = 真冷启动）\n")

    runs = []
    for i in range(args.runs):
        try:
            r = _one_run(client, arn, args.prompt, args.topic, args.locale, args.model,
                         args.verbose)
        except Exception as e:  # noqa: BLE001
            print(f"  run {i+1}/{args.runs}: FAILED {type(e).__name__}")
            continue
        runs.append(r)
        ttft = f"{r['ttft']:.2f}s" if r["ttft"] is not None else "n/a"
        print(f"  run {i+1}/{args.runs}: ttfb {r['ttfb']:.2f}s  ttft {ttft}  "
              f"total {r['total']:.2f}s  ({r['chars']} chars)")
        if i < args.runs - 1:
            time.sleep(args.sleep)

    if not runs:
        print("\n全部失败，没有数据。")
        return 1

    print(f"\n  ttfb  (首帧)  {_fmt([r['ttfb'] for r in runs])}")
    print(f"  ttft  (首字)  {_fmt([r['ttft'] for r in runs])}")
    print(f"  total (全程)  {_fmt([r['total'] for r in runs])}")

    if args.json_out:
        blob = {"label": args.label, "arn_tail": arn[-40:], "topic": args.topic,
                "locale": args.locale, "prompt": args.prompt, "runs_n": len(runs),
                "runs": runs, "summary": _summary(runs)}
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump(blob, f, ensure_ascii=False, indent=2)
        print(f"\n已写入 {args.json_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
