#!/usr/bin/env python3
"""对**一键部署出来的栈**跑一遍端到端冒烟 —— 维护者用，不面向客户。

为什么单独一个脚本、且**不叫** `test_*.py`：它要连真 AWS（开好的栈、真 Cognito 登录、
真调 agent），CI 里没有那样的环境。名字带 `test_` 会被 `scripts/test_ci_runs_every_suite.py`
要求进 CI，那条判据是对的，所以这里避开这个前缀。

它验的是"客户点完 Launch Stack 之后，那套东西到底能不能用"——这件事 `cdk synth`、
`validate-template`、乃至 CREATE_COMPLETE 都证明不了：CFN 只知道资源建出来了，
不知道前端能不能打开、登录能不能过、agent 会不会回话。

七步（任一步失败即退出码 1，并说清是哪一步）：
  1. 读栈 Outputs（ChatUrl / InstalledRelease）
  2. 从 CloudFront 拉 `config.json` —— 顺带证明 CDN + 站点桶 + StagerFn 写的配置是通的，
     并把里面的 `chatApiBase` 与**栈自己的** BFF Function URL 交叉核对（两条部署路径的栈在
     同一个账号里是并存的，「能连通」不等于「连的是这个栈」）
  3. 拉首页，确认 index.html 引用的 bundle 真的在
  4. Cognito 登录拿 idToken（`admin`；带 --reset-password 时先设一个新密码）
  5. Identity Pool 换临时凭证（前端就是这么拿的）
  6. SigV4 签名 POST `/api/chat/stream`，读 SSE 流
  7. 判定确实收到了模型输出（不只是"连上了"）

用法：
    python3 scripts/smoke_oneclick.py --stack notiops --region us-east-1 --reset-password
    SMOKE_ADMIN_PASSWORD='…' python3 scripts/smoke_oneclick.py --stack notiops --region us-east-1

`--reset-password` 会**重设 admin 的密码**（Permanent），只在测试账号上用。
密码从头到尾不打印、不写文件、不进日志 —— 要复用就自己从环境变量传进来。

它同时是发布回归清单给**自动化 AI runner** 用的驱动器：
`--toggle` 能把 BFF 请求体契约里的任意开关打开（键名对不上会**当场报错**，
不会静默忽略 —— 静默忽略会让"开关坏了"和"我根本没打开它"长得一模一样），
`--expect` 做确定性断言，`--json` 让 stdout 只剩一行机器可读的结果：

    python3 scripts/smoke_oneclick.py --stack notiops --region us-east-1 \
      --conversation-id rel-v1.0.19-4.1 --locale zh --prompt '如何降低我的 EC2 成本？' --json
    python3 scripts/smoke_oneclick.py --stack notiops --region us-east-1 \
      --toggle devops_chat_direct=true --expect-usage-total-tokens 0 --json

`--json` 下所有人读的过程输出走 stderr，stdout 只有结果那一行。
结果里**永远不含**密码或 idToken 本身（只有长度），别往里加。
"""
from __future__ import annotations

import argparse
import json
import secrets
import string
import sys
import traceback
import urllib.error
import urllib.request

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

# 一键部署建的管理员用户名（见 infra/lambda/stager/index.py 的 _ADMIN_USERNAME）。
ADMIN_USERNAME = "admin"
# BFF 期望 Cognito idToken 走这个头，而不是 Authorization —— Function URL 是 AWS_IAM
# 鉴权，Authorization 已经被 SigV4 签名占了（见 bff/web-chat/jwt.mjs:105）。
ID_TOKEN_HEADER = "x-notiops-id-token"
PROMPT = "Reply with exactly: SMOKE OK"

# `POST /api/chat/stream` 的请求体契约 —— **真源是 `bff/web-chat/index.mjs` 里读 body 的那段**，
# 改那边就要改这里。列白名单而不是照抄用户输入，是为了让 `--toggle devops_chat=true`
# （少了 `_direct`）这种手滑**当场失败**：静默透传会让"开关不生效"与"我根本没传对键"
# 长得一模一样，而这正是回归测试最需要区分的两件事。
BODY_TOGGLES = (
    "model",                    # 客户侧偏好；服务端准入可能改写并发 model_substituted
    "web_search",               # 联网搜索（AgentCore Web Search，仅 us-east-1）
    "finops_agent",             # 占位，未上线
    "deep_investigate_direct",  # 深度调查（直连），0 token
    "devops_chat_direct",       # DevOps 对话 / 通用会话的「对话对象 = DevOps Agent」，0 token
    "devops_agent",             # DevOps Agent 深度调查（经我们的 agent）
    "topic",                    # general / investigate / finops / cases / security / whats-new
    "account_id",               # 多账号：这一轮问哪个成员账号
    "skill_id",
    "skill_version",
)


class SmokeError(RuntimeError):
    pass


# --json 时人读的过程输出全部改走 stderr，stdout 只留结果那一行。
_LOG = sys.stdout
# 当前走到第几步。失败时直接进结果 JSON 的 failed_step —— 自动化 runner 靠它一眼看出
# 是"环境还没起来"（第 1–3 步）还是"功能真的坏了"（第 6–7 步），不用去解析报错文本。
_STEP = 0


def _say(msg: str = "") -> None:
    print(msg, file=_LOG)


def step(n: int, title: str) -> None:
    global _STEP
    _STEP = n
    _say(f"\n[{n}/7] {title}")


def parse_toggle(raw: str) -> tuple[str, object]:
    """`key=value` → (key, 值)。`true/false` 转 bool，纯数字转 int，其余当字符串。"""
    if "=" not in raw:
        raise SmokeError(f"--toggle wants key=value, got {raw!r}")
    key, _, value = raw.partition("=")
    key = key.strip()
    if key not in BODY_TOGGLES:
        raise SmokeError(
            f"unknown request-body key {key!r}; the contract is: {', '.join(BODY_TOGGLES)}")
    low = value.strip().lower()
    if low in ("true", "false"):
        return key, low == "true"
    if low.lstrip("-").isdigit():
        return key, int(low)
    return key, value.strip()


def _get(url: str, timeout: int = 20) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers={"user-agent": "notiops-smoke"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _new_password() -> str:
    # Cognito 默认策略：>=8 位，含大小写、数字、符号。
    alphabet = string.ascii_letters + string.digits
    return "Aa1!" + "".join(secrets.choice(alphabet) for _ in range(20))


def outputs_of(cfn, stack: str) -> dict[str, str]:
    stacks = cfn.describe_stacks(StackName=stack)["Stacks"]
    status = stacks[0]["StackStatus"]
    if status not in ("CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"):
        raise SmokeError(f"stack {stack} is in {status}; nothing to smoke-test")
    return {o["OutputKey"]: o["OutputValue"] for o in stacks[0].get("Outputs", [])}


def _bff_function_url(cfn, lam, stack: str) -> str:
    """这个栈自己的 BFF Function URL，取不到就返回 ""（交叉核对降级为跳过）。

    做法：从栈资源里找 `AWS::Lambda::Function` 且 logical id 以 `WebChatBff` 开头的那个
    （CDK 会追加一段哈希后缀，所以是前缀匹配而非全等），再 `get_function_url_config`。

    为什么允许返回 ""：这是一道**交叉核对**，不是被测功能。少一个
    `lambda:GetFunctionUrlConfig` / `cloudformation:ListStackResources` 权限就让整个
    smoke 挂掉，是把加固变成了故障源 —— 那会逼着下一个人干脆把这段删掉。
    """
    try:
        logical = ""
        paginator = cfn.get_paginator("list_stack_resources")
        for page in paginator.paginate(StackName=stack):
            for r in page.get("StackResourceSummaries", []):
                if (r.get("ResourceType") == "AWS::Lambda::Function"
                        and r.get("LogicalResourceId", "").startswith("WebChatBff")):
                    logical = r.get("PhysicalResourceId", "")
                    break
            if logical:
                break
        if not logical:
            _say("      note: no WebChatBff function in the stack; skipping cross-check")
            return ""
        return lam.get_function_url_config(FunctionName=logical).get("FunctionUrl", "")
    except Exception as e:  # noqa: BLE001 — 加固不得成为 smoke 的故障源
        _say(f"      note: BFF cross-check unavailable ({type(e).__name__}); skipping")
        return ""


def login(idp, pool_id: str, client_id: str, password: str) -> str:
    """USER_PASSWORD_AUTH 拿 idToken；碰到首登改密挑战就当场改掉。"""
    resp = idp.initiate_auth(
        ClientId=client_id, AuthFlow="USER_PASSWORD_AUTH",
        AuthParameters={"USERNAME": ADMIN_USERNAME, "PASSWORD": password},
    )
    if resp.get("ChallengeName") == "NEW_PASSWORD_REQUIRED":
        _say("      user was in FORCE_CHANGE_PASSWORD; answering the challenge")
        resp = idp.respond_to_auth_challenge(
            ClientId=client_id, ChallengeName="NEW_PASSWORD_REQUIRED",
            Session=resp["Session"],
            ChallengeResponses={"USERNAME": ADMIN_USERNAME, "NEW_PASSWORD": password},
        )
    if resp.get("ChallengeName"):
        raise SmokeError(f"unexpected auth challenge: {resp['ChallengeName']}")
    return resp["AuthenticationResult"]["IdToken"]


def identity_pool_creds(region: str, identity_pool_id: str, pool_id: str, id_token: str) -> dict:
    ci = boto3.client("cognito-identity", region_name=region)
    logins = {f"cognito-idp.{region}.amazonaws.com/{pool_id}": id_token}
    ident = ci.get_id(IdentityPoolId=identity_pool_id, Logins=logins)["IdentityId"]
    creds = ci.get_credentials_for_identity(IdentityId=ident, Logins=logins)["Credentials"]
    return {"access_key": creds["AccessKeyId"], "secret_key": creds["SecretKey"],
            "token": creds["SessionToken"]}


def build_body(prompt: str, conversation_id: str, locale: str, toggles: dict) -> dict:
    """请求体 = 三个必填 + `--toggle` 传进来的契约字段（只保留显式给的，别塞默认值：
    关着的开关**前端也不传**，塞一个 `false` 进去测的就不是同一条码路了）。"""
    return {"text": prompt, "conversation_id": conversation_id, "locale": locale, **toggles}


def stream_chat(bff_url: str, region: str, creds: dict, id_token: str, body_obj: dict) -> dict:
    """签名 POST /api/chat/stream，把 SSE 流解析成 {event: [...]}。"""
    url = bff_url.rstrip("/") + "/api/chat/stream"
    body = json.dumps(body_obj, ensure_ascii=False)
    request = AWSRequest(method="POST", url=url, data=body.encode(), headers={
        "content-type": "application/json",
        ID_TOKEN_HEADER: id_token,
    })
    frozen = boto3.Session(
        aws_access_key_id=creds["access_key"], aws_secret_access_key=creds["secret_key"],
        aws_session_token=creds["token"], region_name=region,
    ).get_credentials()
    # Function URL 的 IAM 鉴权按 lambda 服务签名。
    SigV4Auth(frozen, "lambda", region).add_auth(request)

    req = urllib.request.Request(url, data=body.encode(), method="POST",
                                headers=dict(request.headers))
    events: dict[str, list] = {}
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            if resp.status != 200:
                raise SmokeError(f"POST {url} -> HTTP {resp.status}")
            name = None
            for raw in resp:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                if line.startswith("event: "):
                    name = line[7:].strip()
                elif line.startswith("data: ") and name:
                    try:
                        payload = json.loads(line[6:])
                    except json.JSONDecodeError:
                        payload = line[6:]
                    events.setdefault(name, []).append(payload)
    except urllib.error.HTTPError as exc:
        raise SmokeError(f"POST {url} -> HTTP {exc.code}: {exc.read()[:500]!r}") from exc
    return events


def main(argv: list[str] | None = None) -> int:
    import os

    global _LOG

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stack", default="notiops")
    ap.add_argument("--region", required=True)
    ap.add_argument("--reset-password", action="store_true",
                    help="reset the admin password to a generated one (test accounts only)")
    ap.add_argument("--prompt", default=PROMPT)
    ap.add_argument("--conversation-id", default="smoke-oneclick",
                    help="reuse an id to continue a conversation, or pass a fresh one per case")
    ap.add_argument("--locale", default="en", choices=("en", "zh"))
    ap.add_argument("--toggle", action="append", default=[], metavar="KEY=VALUE",
                    help=f"request-body field; one of: {', '.join(BODY_TOGGLES)}")
    ap.add_argument("--expect", default="",
                    help="fail unless the answer contains this substring (case-insensitive)")
    ap.add_argument("--expect-usage-total-tokens", type=int, default=None,
                    help="fail unless usage.totalTokens equals this (use 0 for the direct paths)")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="print one line of machine-readable result on stdout; prose goes to stderr")
    args = ap.parse_args(argv)

    if args.as_json:
        _LOG = sys.stderr

    result: dict = {"ok": False, "stack": args.stack, "region": args.region,
                    "failed_step": None, "error": None}

    try:
        # 建 client 也放进 try：profile 打错 / 没配区域会在这里抛 ProfileNotFound，
        # 那同样得走下面的兜底、照样吐出结果那一行 JSON。
        cfn = boto3.client("cloudformation", region_name=args.region)
        idp = boto3.client("cognito-idp", region_name=args.region)
        lam = boto3.client("lambda", region_name=args.region)

        toggles = dict(parse_toggle(t) for t in args.toggle)
        step(1, "stack outputs")
        out = outputs_of(cfn, args.stack)
        for key in ("ChatUrl",):
            if key not in out:
                raise SmokeError(f"stack has no {key} output")
        result["release"] = out.get("InstalledRelease")
        result["chat_url"] = out["ChatUrl"]
        _say(f"      release  : {out.get('InstalledRelease', '?')}")
        _say(f"      chat url : {out['ChatUrl']}")

        step(2, "config.json over CloudFront")
        status, raw = _get(out["ChatUrl"].rstrip("/") + "/config.json")
        if status != 200:
            raise SmokeError(f"GET config.json -> HTTP {status} (CDN or StagerFn Site phase failed)")
        cfg = json.loads(raw)
        missing = [k for k in ("chatApiBase", "cognitoUserPoolId", "cognitoClientId",
                              "cognitoIdentityPoolId") if not cfg.get(k)]
        if missing:
            raise SmokeError(f"config.json is missing {missing}")
        # BFF 地址的真源是 config.json 的 `chatApiBase` —— 前端读的就是它。
        # 2026-09-01 起方式A 的 Outputs 不再有 `ChatBffUrl`（对客户零用处，只会招来
        # 「这个要配到哪」的问询），所以这里改从 config.json 取。
        result["bff_url"] = cfg["chatApiBase"]
        # ⚠️ 但**不能**只信 config.json：它是 StagerFn 写进网站桶的一个文件，若某次
        # 部署写歪了（指向另一个栈的 BFF），下面第 6 步照样会 200 通过 —— 而这个账号里
        # 方式A / 方式B 两个栈是**并存**的，「能连通」根本不等于「连的是这个栈」。
        # 所以拿栈自己的资源做一次交叉核对：这才是原来那条 `ChatBffUrl` output 断言
        # 真正在守的东西，换个更可靠的来源接着守。
        expected = _bff_function_url(cfn, lam, args.stack)
        if expected and cfg["chatApiBase"].rstrip("/") != expected.rstrip("/"):
            raise SmokeError(
                "config.json chatApiBase does not point at this stack's BFF "
                f"Function URL (config={cfg['chatApiBase']!r} stack={expected!r})")
        _say(f"      bff url  : {cfg['chatApiBase']}"
             + ("" if expected else "  (stack cross-check skipped)"))
        _say(f"      user pool: {cfg['cognitoUserPoolId']}")

        step(3, "index.html + bundle")
        status, html = _get(out["ChatUrl"])
        if status != 200 or b"<div id=\"root\"" not in html:
            raise SmokeError(f"GET / -> HTTP {status}, body did not look like the chat app")
        import re
        bundles = re.findall(rb'src="(/assets/[^"]+\.js)"', html)
        if not bundles:
            raise SmokeError("index.html references no /assets/*.js bundle")
        status, _ = _get(out["ChatUrl"].rstrip("/") + bundles[0].decode())
        if status != 200:
            raise SmokeError(f"bundle {bundles[0]!r} -> HTTP {status} (frontend publish incomplete)")
        result["bundle"] = bundles[0].decode()
        _say(f"      bundle   : {bundles[0].decode()} ok")

        step(4, "Cognito login")
        password = os.environ.get("SMOKE_ADMIN_PASSWORD", "")
        if args.reset_password:
            password = _new_password()
            idp.admin_set_user_password(UserPoolId=cfg["cognitoUserPoolId"],
                                        Username=ADMIN_USERNAME, Password=password,
                                        Permanent=True)
            _say("      reset the admin password (value not printed)")
        if not password:
            raise SmokeError("no password: pass --reset-password or set SMOKE_ADMIN_PASSWORD")
        id_token = login(idp, cfg["cognitoUserPoolId"], cfg["cognitoClientId"], password)
        _say(f"      idToken  : {len(id_token)} chars")

        step(5, "identity pool credentials")
        creds = identity_pool_creds(args.region, cfg["cognitoIdentityPoolId"],
                                    cfg["cognitoUserPoolId"], id_token)
        _say("      got temporary credentials for the authenticated role")

        step(6, f"POST /api/chat/stream  ({args.prompt!r})")
        body_obj = build_body(args.prompt, args.conversation_id, args.locale, toggles)
        result["request"] = body_obj
        events = stream_chat(cfg["chatApiBase"], args.region, creds, id_token, body_obj)
        result["events"] = {k: len(v) for k, v in events.items()}
        _say(f"      SSE events: {result['events']}")

        step(7, "assert the agent actually answered")
        if "error" in events:
            raise SmokeError(f"stream returned an error event: {events['error'][:2]}")
        tokens = events.get("token") or events.get("tokens") or []
        text = "".join(t if isinstance(t, str) else (t.get("text") or t.get("delta") or "")
                       for t in tokens)
        if not text.strip():
            raise SmokeError(f"no model output in the stream; events were {sorted(events)}")
        result["answer"] = text.strip()
        _say(f"      answer   : {text.strip()[:200]!r}")
        # usage 里带模型名与 token 数。打出来是为了区分"真调了模型"和"回显模式"
        # （Phase 0 的 /stream 会把输入原样吐回来，同样是一串 token 事件）。
        for usage in events.get("usage", [])[:1]:
            if isinstance(usage, dict):
                result["usage"] = usage.get("usage") if "usage" in usage else usage
                _say(f"      usage    : { {k: usage[k] for k in sorted(usage)} }")
        if "done" not in events:
            raise SmokeError("stream never sent a 'done' event (it was cut short)")
        if args.expect and args.expect.lower() not in text.lower():
            raise SmokeError(f"answer does not contain --expect {args.expect!r}")
        if args.expect_usage_total_tokens is not None:
            got = (result.get("usage") or {}).get("totalTokens")
            if got != args.expect_usage_total_tokens:
                raise SmokeError(
                    f"usage.totalTokens is {got!r}, expected {args.expect_usage_total_tokens}"
                    " (0 means the request really bypassed our model)")
        result["ok"] = True
    except SmokeError as exc:
        # 只报步号 + 消息；两者都不含凭证（密码/idToken 从来不进异常文本）。
        result["failed_step"] = _STEP or None
        result["error"] = str(exc)
        print(f"\nSMOKE FAILED: {exc}", file=sys.stderr)
        if args.as_json:
            print(json.dumps(result, ensure_ascii=False))
        return 1
    except Exception as exc:  # noqa: BLE001
        # 兜底。botocore 的 ClientError / 凭证错误 / 网络超时都不是 SmokeError，漏出去就会是
        # 一个 traceback + **stdout 上一个字都没有** —— 而 --json 承诺"stdout 只有一行 JSON"，
        # 自动化 runner 拿不到那一行就只能猜。所以这里必须兜住并照常输出结果。
        # 只往 JSON 里放**异常类型 + AWS 错误码**（照 docs/LOGGING_STANDARD.md 的口径，
        # 不放原始服务报文）；人要看的完整栈留在 stderr。
        result["failed_step"] = _STEP or None
        code = None
        if isinstance(getattr(exc, "response", None), dict):
            code = exc.response.get("Error", {}).get("Code")
        result["error"] = type(exc).__name__ + (f": {code}" if code else "")
        traceback.print_exc()
        print(f"\nSMOKE FAILED: {result['error']} (full traceback above)", file=sys.stderr)
        if args.as_json:
            print(json.dumps(result, ensure_ascii=False))
        return 1

    _say("\nSMOKE OK — the one-click deployment is usable end to end")
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
