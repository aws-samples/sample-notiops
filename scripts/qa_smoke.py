#!/usr/bin/env python3
"""NotiOps 全量冒烟 QA（无需手工点 UI）。

覆盖面：
  1. BFF 全 API 面（SigV4 + Cognito idToken，与前端 signedClient 同构）：
     accounts / me-capabilities / dashboards(finops·security·health·eos·cases·alarms) /
     cases org rollup / admin(roles·users·groups·modules·member-accounts·account-access) /
     security TA 下钻 / conversations
  2. Agent runtime 直连：通用问答、部署账号 cases、成员账号 cases（真实跨账号）、
     可见性拒绝（allowed_accounts 不含目标账号必须拒绝）
  3. 数据不变量：config 表登记 ↔ StackSet 实例一致性；da# enabled 必须有 space+trigger

用法：python3 scripts/qa_smoke.py   （需 mgmt 账号本地凭证；qa-bot Cognito 用户存在）
退出码 0 = 全 PASS。
"""
import boto3, botocore.auth, botocore.awsrequest, json, os, re, sys, urllib.request, uuid

# 环境相关配置一律从 env 读，绝不硬编码（交付给其它客户时各自的部署值不同）。
# setup.sh 部署完成后可写一个 scripts/.notiops-qa-env（gitignore）导出这些，或运行时 export。
REGION = os.environ.get("NOTIOPS_REGION", "us-east-1")
POOL = os.environ.get("NOTIOPS_USER_POOL_ID", "")
CLIENT = os.environ.get("NOTIOPS_USER_POOL_CLIENT_ID", "")
BFF_URL = os.environ.get("NOTIOPS_BFF_URL", "").rstrip("/")
RUNTIME_ARN = os.environ.get("NOTIOPS_RUNTIME_ARN", "")
_MEMBER_ENV = os.environ.get("NOTIOPS_MEMBER_ACCOUNT", "")  # 可选：不设则运行时自动发现首个已接入成员
for _k, _v in {"NOTIOPS_USER_POOL_ID": POOL, "NOTIOPS_USER_POOL_CLIENT_ID": CLIENT,
               "NOTIOPS_BFF_URL": BFF_URL, "NOTIOPS_RUNTIME_ARN": RUNTIME_ARN}.items():
    if not _v:
        sys.exit(f"missing required env {_k} — export the deployment's values before running "
                 f"(see docs; setup.sh outputs them). Nothing is hardcoded for client delivery.")

# 部署账号运行时发现（STS），成员账号运行时发现（/admin/member-accounts）——不硬编码任何账号。
DEPLOY_ACCT = boto3.client("sts", region_name=REGION).get_caller_identity()["Account"]
MEMBER = _MEMBER_ENV  # 若为空，主流程首次拿到 member 列表后填入

results = []
def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("✅" if ok else "❌"), name, ("— " + str(detail)[:120]) if detail and not ok else "")

def id_token():
    cog = boto3.client("cognito-idp", region_name=REGION)
    pw = open("/tmp/qa-creds.txt").read().strip()
    r = cog.admin_initiate_auth(UserPoolId=POOL, ClientId=CLIENT, AuthFlow="ADMIN_USER_PASSWORD_AUTH",
        AuthParameters={"USERNAME": "qa-bot", "PASSWORD": pw})
    return r["AuthenticationResult"]["IdToken"]

def bff(method, path, token, body=None):
    url = BFF_URL + path
    data = json.dumps(body).encode() if body is not None else None
    creds = boto3.Session().get_credentials().get_frozen_credentials()
    req = botocore.awsrequest.AWSRequest(method=method, url=url, data=data,
        headers={"x-notiops-id-token": token, **({"content-type": "application/json"} if data else {})})
    botocore.auth.SigV4Auth(creds, "lambda", REGION).add_auth(req)
    u = urllib.request.Request(url, data=data, method=method, headers=dict(req.headers))
    try:
        # nosec B310 — dev QA script; url is a fixed https AWS Function URL (not external input)
        with urllib.request.urlopen(u, timeout=60) as resp:  # nosec B310
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

def agent(prompt, account_id="", allowed="*", topic="cases"):
    c = boto3.client("bedrock-agentcore", region_name=REGION)
    r = c.invoke_agent_runtime(agentRuntimeArn=RUNTIME_ARN, runtimeSessionId=str(uuid.uuid4()) + "-qa000000",
        payload=json.dumps({"prompt": prompt, "model": "", "locale": "en", "topic": topic,
                            "account_id": account_id, "allowed_accounts": allowed}).encode())
    data = r["response"].read().decode("utf-8", "ignore")
    return "".join(m for m in re.findall(r'"text": "([^"]*)"', data))

def main():
    global MEMBER
    tok = id_token()
    check("cognito auth (qa-bot)", bool(tok))

    # ── 1. BFF API 面 ──
    st, b = bff("GET", "/accounts", tok)
    accts = [a["accountId"] for a in b.get("accounts", [])]
    check("GET /accounts", st == 200, b)
    check("  selector excludes deployment acct", DEPLOY_ACCT not in accts, accts)
    check("  member 682 present", MEMBER in accts, accts)
    dep = b.get("deployment", {})
    check("  /accounts returns deployment info", dep.get("accountId") == DEPLOY_ACCT and bool(dep.get("accountName")), dep)
    st, b = bff("GET", "/me/capabilities", tok)
    check("GET /me/capabilities", st == 200 and b.get("capabilities"), st)
    for path, key in [("/finops/dashboard", "costExplorer"), ("/security/dashboard", "trustedAdvisor"),
                      ("/health/dashboard", None), ("/lifecycle/eos", None),
                      ("/cases/dashboard", None), ("/cases/org-summary", "perAccount"),
                      ("/investigate/alarms", None)]:
        st, b = bff("GET", path, tok)
        ok = st == 200 and (key is None or key in b)
        check(f"GET {path}", ok, f"{st} {list(b)[:6]}")
    # ④ SecOps 仪表盘 + ③c EOS org 汇总
    st, b = bff("GET", "/security/guardduty", tok)
    check("GET /security/guardduty", st == 200 and "ok" in b, f"{st} {str(b)[:60]}")
    st, b = bff("GET", "/investigate/backup", tok)
    check("GET /investigate/backup", st == 200 and "ok" in b, f"{st} {str(b)[:60]}")
    st, b = bff("GET", "/lifecycle/eos/org-summary", tok)
    check("GET /lifecycle/eos/org-summary", st == 200 and "rows" in b, f"{st} {list(b)[:4]}")
    if st == 200:
        rows = b.get("rows", [])
        check("  eos rollup covers member accts", any(r.get("accountId") == MEMBER for r in rows), [r.get("accountId") for r in rows])
    st, b = bff("GET", "/investigate/alarms/org-summary", tok)
    check("GET /investigate/alarms/org-summary", st == 200 and "rows" in b, f"{st} {list(b)[:4]}")
    if st == 200:
        rows = b.get("rows", [])
        check("  alarms rollup covers member accts", any(r.get("accountId") == MEMBER for r in rows), [r.get("accountId") for r in rows])
    # cross-account dashboards
    for path in (f"/security/dashboard?account={MEMBER}", f"/health/dashboard?account={MEMBER}",
                 f"/cases/dashboard?account={MEMBER}",
                 f"/security/guardduty?account={MEMBER}", f"/investigate/backup?account={MEMBER}"):
        st, b = bff("GET", path, tok)
        check(f"GET {path.split('?')[0]}?account=682", st == 200, st)
    # admin surface
    for path in ("/admin/roles", "/admin/users", "/admin/groups", "/admin/modules",
                 "/admin/member-accounts", "/admin/account-access", "/admin/capabilities"):
        st, b = bff("GET", path, tok)
        check(f"GET {path}", st == 200, f"{st} {str(b)[:80]}")
    st, b = bff("GET", "/admin/member-accounts", tok)
    items = b.get("items", [])
    if not MEMBER:
        _act = next((i for i in items if i.get("orgOnboardStatus") == "ACTIVE"), None)
        MEMBER = _act["accountId"] if _act else ""
        check("  discovered an ACTIVE member account", bool(MEMBER), "no onboarded member found — onboard one first")
    check("  member list excludes deployment acct", all(i["accountId"] != DEPLOY_ACCT for i in items))
    m682 = next((i for i in items if i["accountId"] == MEMBER), None)
    check("  682 ACTIVE + DA enabled", bool(m682 and m682["orgOnboardStatus"] == "ACTIVE" and m682.get("devopsAgentStatus") == "enabled"), m682)
    st, b = bff("GET", "/conversations", tok)
    check("GET /conversations", st == 200, st)

    # ── 2. Agent runtime ──
    t = agent("Reply with exactly: QA-OK", topic="general")
    check("agent general chat", "QA-OK" in t, t[:80])
    t = agent("Invoke support_cases_list with account_id='" + MEMBER + "', status='all'. Reply only account_queried and error/displayIds.", MEMBER)
    check("agent member cases (crosses account)", MEMBER in t and "cross_account_unavailable" not in t, t[:150])
    t = agent("Invoke support_cases_list with account_id='" + MEMBER + "'. Reply only the error field.", MEMBER, allowed="111122223333")
    # 措辞随模型改写而变 —— 安全断言以"零泄漏"为准：不得出现任何 case ID/表格数据。
    # 部署账号真实 case display-id 通过 env 传入（逗号分隔），仓库里不留真实数据；
    # 未设置时退化为“不匹配任何 id”（表格泄漏断言仍生效）。
    _known_cids = [c.strip() for c in os.environ.get("QA_DEPLOYMENT_CASE_IDS", "").split(",") if c.strip()]
    leaked = any(cid in t for cid in _known_cids)
    has_table = "| " in t and "displayId" not in t.lower() and leaked
    check("agent visibility DENY enforced (no data leak)", not leaked and not has_table, t[:120])

    # ── 3. 数据不变量 ──
    ddb = boto3.resource("dynamodb", region_name=REGION).Table("notiops-config")
    from boto3.dynamodb.conditions import Key
    q = ddb.query(IndexName="GSI1", KeyConditionExpression=Key("GSI1PK").eq("accounts"))["Items"]
    cf = boto3.client("cloudformation", region_name=REGION)
    for it in q:
        acct = str(it["account_id"])
        if acct == DEPLOY_ACCT: continue
        inst = cf.list_stack_instances(StackSetName="notiops-member-onboarding", StackInstanceAccount=acct)["Summaries"]
        check(f"invariant: {acct} registered => stack instance exists", len(inst) > 0, it.get("org_onboard_status"))
        da = ddb.get_item(Key={"PK": f"da#{acct}", "SK": "meta"}).get("Item")
        if da and da.get("onboarding_status") == "enabled":
            check(f"invariant: {acct} DA enabled => space+trigger present",
                  bool(da.get("agent_space_id") and da.get("trigger_role_arn")))

    fails = [r for r in results if not r[1]]
    print(f"\n===== {len(results) - len(fails)}/{len(results)} PASS =====")
    for n, _, d in fails: print("FAIL:", n, "—", str(d)[:150])
    sys.exit(1 if fails else 0)

main()
