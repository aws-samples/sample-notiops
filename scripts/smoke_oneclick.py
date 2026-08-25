#!/usr/bin/env python3
"""对**一键部署出来的栈**跑一遍端到端冒烟 —— 维护者用，不面向客户。

为什么单独一个脚本、且**不叫** `test_*.py`：它要连真 AWS（开好的栈、真 Cognito 登录、
真调 agent），CI 里没有那样的环境。名字带 `test_` 会被 `scripts/test_ci_runs_every_suite.py`
要求进 CI，那条判据是对的，所以这里避开这个前缀。

它验的是"客户点完 Launch Stack 之后，那套东西到底能不能用"——这件事 `cdk synth`、
`validate-template`、乃至 CREATE_COMPLETE 都证明不了：CFN 只知道资源建出来了，
不知道前端能不能打开、登录能不能过、agent 会不会回话。

七步（任一步失败即退出码 1，并说清是哪一步）：
  1. 读栈 Outputs（ChatUrl / ChatBffUrl / InstalledRelease）
  2. 从 CloudFront 拉 `config.json` —— 顺带证明 CDN + 站点桶 + StagerFn 写的配置是通的
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
"""
from __future__ import annotations

import argparse
import json
import secrets
import string
import sys
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


class SmokeError(RuntimeError):
    pass


def step(n: int, title: str) -> None:
    print(f"\n[{n}/7] {title}")


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


def login(idp, pool_id: str, client_id: str, password: str) -> str:
    """USER_PASSWORD_AUTH 拿 idToken；碰到首登改密挑战就当场改掉。"""
    resp = idp.initiate_auth(
        ClientId=client_id, AuthFlow="USER_PASSWORD_AUTH",
        AuthParameters={"USERNAME": ADMIN_USERNAME, "PASSWORD": password},
    )
    if resp.get("ChallengeName") == "NEW_PASSWORD_REQUIRED":
        print("      user was in FORCE_CHANGE_PASSWORD; answering the challenge")
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


def stream_chat(bff_url: str, region: str, creds: dict, id_token: str, prompt: str) -> dict:
    """签名 POST /api/chat/stream，把 SSE 流解析成 {event: [...]}。"""
    url = bff_url.rstrip("/") + "/api/chat/stream"
    body = json.dumps({"text": prompt, "conversation_id": "smoke-oneclick", "locale": "en"})
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

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stack", default="notiops")
    ap.add_argument("--region", required=True)
    ap.add_argument("--reset-password", action="store_true",
                    help="reset the admin password to a generated one (test accounts only)")
    ap.add_argument("--prompt", default=PROMPT)
    args = ap.parse_args(argv)

    cfn = boto3.client("cloudformation", region_name=args.region)
    idp = boto3.client("cognito-idp", region_name=args.region)

    try:
        step(1, "stack outputs")
        out = outputs_of(cfn, args.stack)
        for key in ("ChatUrl", "ChatBffUrl"):
            if key not in out:
                raise SmokeError(f"stack has no {key} output")
        print(f"      release  : {out.get('InstalledRelease', '?')}")
        print(f"      chat url : {out['ChatUrl']}")

        step(2, "config.json over CloudFront")
        status, raw = _get(out["ChatUrl"].rstrip("/") + "/config.json")
        if status != 200:
            raise SmokeError(f"GET config.json -> HTTP {status} (CDN or StagerFn Site phase failed)")
        cfg = json.loads(raw)
        missing = [k for k in ("chatApiBase", "cognitoUserPoolId", "cognitoClientId",
                              "cognitoIdentityPoolId") if not cfg.get(k)]
        if missing:
            raise SmokeError(f"config.json is missing {missing}")
        if cfg["chatApiBase"].rstrip("/") != out["ChatBffUrl"].rstrip("/"):
            raise SmokeError("config.json chatApiBase does not match the ChatBffUrl output")
        print(f"      user pool: {cfg['cognitoUserPoolId']}")

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
        print(f"      bundle   : {bundles[0].decode()} ok")

        step(4, "Cognito login")
        password = os.environ.get("SMOKE_ADMIN_PASSWORD", "")
        if args.reset_password:
            password = _new_password()
            idp.admin_set_user_password(UserPoolId=cfg["cognitoUserPoolId"],
                                        Username=ADMIN_USERNAME, Password=password,
                                        Permanent=True)
            print("      reset the admin password (value not printed)")
        if not password:
            raise SmokeError("no password: pass --reset-password or set SMOKE_ADMIN_PASSWORD")
        id_token = login(idp, cfg["cognitoUserPoolId"], cfg["cognitoClientId"], password)
        print(f"      idToken  : {len(id_token)} chars")

        step(5, "identity pool credentials")
        creds = identity_pool_creds(args.region, cfg["cognitoIdentityPoolId"],
                                    cfg["cognitoUserPoolId"], id_token)
        print("      got temporary credentials for the authenticated role")

        step(6, f"POST /api/chat/stream  ({args.prompt!r})")
        events = stream_chat(out["ChatBffUrl"], args.region, creds, id_token, args.prompt)
        print(f"      SSE events: { {k: len(v) for k, v in events.items()} }")

        step(7, "assert the agent actually answered")
        if "error" in events:
            raise SmokeError(f"stream returned an error event: {events['error'][:2]}")
        tokens = events.get("token") or events.get("tokens") or []
        text = "".join(t if isinstance(t, str) else (t.get("text") or t.get("delta") or "")
                       for t in tokens)
        if not text.strip():
            raise SmokeError(f"no model output in the stream; events were {sorted(events)}")
        print(f"      answer   : {text.strip()[:200]!r}")
        # usage 里带模型名与 token 数。打出来是为了区分"真调了模型"和"回显模式"
        # （Phase 0 的 /stream 会把输入原样吐回来，同样是一串 token 事件）。
        for usage in events.get("usage", [])[:1]:
            if isinstance(usage, dict):
                print(f"      usage    : { {k: usage[k] for k in sorted(usage)} }")
        if "done" not in events:
            raise SmokeError("stream never sent a 'done' event (it was cut short)")
    except SmokeError as exc:
        print(f"\nSMOKE FAILED: {exc}", file=sys.stderr)
        return 1

    print("\nSMOKE OK — the one-click deployment is usable end to end")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
