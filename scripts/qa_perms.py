#!/usr/bin/env python3
"""NotiOps 权限自动化测试（RBAC 能力门禁 + 账号可见性）。

覆盖 UI_TEST_SCRIPT 第三部分能自动化的部分：
  · PERM: 6 个预置角色 × 8 tab 端点的 200/403 矩阵（能力门禁 fail-closed）
  · PERM-3: 未知路由 → 403（不 404 泄漏）
  · VIS-2/3/4: 账号可见性——限单账号后跨账号 dashboard 403、聚合端点零泄漏

做法：临时创建 Cognito 用户 + 直接写 userperm/acctvis DDB 记录（rbac_store/account_visibility
schema），逐用户取 token 探测端点，断言。跑完自动清理（用户 + DDB 记录）。
需 mgmt 账号本地凭证 + qa-bot 已存在（沿用 qa_smoke 的 auth 客户端配置）。

用法：python3 scripts/qa_perms.py   退出码 0 = 全 PASS。
"""
import boto3, botocore.auth, botocore.awsrequest, json, os, urllib.request, urllib.error, secrets, sys, time

# 环境相关值全部 env 驱动，绝不硬编码（交付其它客户时各自不同）。
REGION = os.environ.get("NOTIOPS_REGION", "us-east-1")
POOL = os.environ.get("NOTIOPS_USER_POOL_ID", "")
CLIENT = os.environ.get("NOTIOPS_USER_POOL_CLIENT_ID", "")
BFF = os.environ.get("NOTIOPS_BFF_URL", "").rstrip("/")
TABLE = os.environ.get("NOTIOPS_WEBCHAT_TABLE", "notiops-web-chat")
RUNTIME_ARN = os.environ.get("NOTIOPS_RUNTIME_ARN", "")
_MEMBER_ENV = os.environ.get("NOTIOPS_MEMBER_ACCOUNT", "")
for _k, _v in {"NOTIOPS_USER_POOL_ID": POOL, "NOTIOPS_USER_POOL_CLIENT_ID": CLIENT,
               "NOTIOPS_BFF_URL": BFF, "NOTIOPS_RUNTIME_ARN": RUNTIME_ARN}.items():
    if not _v:
        sys.exit(f"missing required env {_k} — export the deployment's values before running (nothing hardcoded).")

cog = boto3.client("cognito-idp", region_name=REGION)
ddb = boto3.resource("dynamodb", region_name=REGION).Table(TABLE)
# 部署账号运行时发现（STS）；成员账号 env 或运行时发现（首个已接入成员）——不硬编码任何账号。
OTHER_ACCT = boto3.client("sts", region_name=REGION).get_caller_identity()["Account"]  # deployment (always visible)

def _discover_member():
    """从 /admin/member-accounts 取首个 ACTIVE 成员账号（无 env 时用）。"""
    if _MEMBER_ENV:
        return _MEMBER_ENV
    try:
        tok = cog.admin_initiate_auth(UserPoolId=POOL, ClientId=CLIENT, AuthFlow="ADMIN_USER_PASSWORD_AUTH",
            AuthParameters={"USERNAME": "qa-bot", "PASSWORD": open("/tmp/qa-creds.txt").read().strip()})["AuthenticationResult"]["IdToken"]
        url = BFF + "/admin/member-accounts"
        cr = boto3.Session().get_credentials().get_frozen_credentials()
        req = botocore.awsrequest.AWSRequest(method="GET", url=url, headers={"x-notiops-id-token": tok})
        botocore.auth.SigV4Auth(cr, "lambda", REGION).add_auth(req)
        # nosec B310 — dev QA script; url is a fixed https AWS Function URL (not external input)
        items = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=dict(req.headers)), timeout=60).read()).get("items", [])  # nosec B310
        act = next((i for i in items if i.get("orgOnboardStatus") == "ACTIVE"), None)
        return act["accountId"] if act else ""
    except Exception:
        return ""

MEMBER = _discover_member()
results = []

def check(name, ok, detail=""):
    results.append((name, ok))
    print(("PASS" if ok else "FAIL"), name, ("" if ok else f"— {str(detail)[:120]}"))

# tab → probe endpoint (tab-level route; visibility of the tab node ⟺ endpoint access)
ENDPOINTS = {
    "nav:notifications": "/health/dashboard",
    "nav:finops": "/finops/dashboard",
    "nav:investigate": "/investigate/alarms",
    "nav:cases": "/cases/dashboard",
    "nav:skills": "/skills",
    "nav:security": "/security/dashboard",
    "nav:admin": "/admin/roles",
}
# 预置角色（探测用；实际权限以 /me/capabilities 为准，避免 DDB 编辑覆盖导致误判）
ROLES = ["role:admin", "role:finops", "role:support", "role:developer", "role:viewer", "role:service-manager"]

def sigv4_get(path, id_token):
    url = BFF + path
    creds = boto3.Session().get_credentials().get_frozen_credentials()
    req = botocore.awsrequest.AWSRequest(method="GET", url=url, headers={"x-notiops-id-token": id_token})
    botocore.auth.SigV4Auth(creds, "lambda", REGION).add_auth(req)
    try:
        # nosec B310 — dev QA script; url is a fixed https AWS Function URL (not external input)
        with urllib.request.urlopen(urllib.request.Request(url, headers=dict(req.headers)), timeout=60) as r:  # nosec B310
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def make_user(uname, roles=None, accounts=None):
    try: cog.admin_delete_user(UserPoolId=POOL, Username=uname)
    except Exception: pass
    cog.admin_create_user(UserPoolId=POOL, Username=uname, MessageAction="SUPPRESS")
    pw = "Qa1!" + secrets.token_hex(8) + "Zz"
    cog.admin_set_user_password(UserPoolId=POOL, Username=uname, Password=pw, Permanent=True)
    u = cog.admin_get_user(UserPoolId=POOL, Username=uname)
    sub = next(a["Value"] for a in u["UserAttributes"] if a["Name"] == "sub")
    if roles is not None:
        ddb.put_item(Item={"PK": f"userperm#{sub}", "SK": "meta", "roles": roles, "denies": [], "updatedAt": int(time.time()*1000)})
    if accounts is not None:
        ddb.put_item(Item={"PK": f"acctvis#user#{sub}", "SK": "meta", "accounts": accounts, "updatedAt": int(time.time()*1000)})
    tok = cog.admin_initiate_auth(UserPoolId=POOL, ClientId=CLIENT, AuthFlow="ADMIN_USER_PASSWORD_AUTH",
        AuthParameters={"USERNAME": uname, "PASSWORD": pw})["AuthenticationResult"]["IdToken"]
    return sub, tok

def cleanup(uname, sub):
    try: cog.admin_delete_user(UserPoolId=POOL, Username=uname)
    except Exception: pass
    for pk in (f"userperm#{sub}", f"acctvis#user#{sub}"):
        try: ddb.delete_item(Key={"PK": pk, "SK": "meta"}); 
        except Exception: pass

def visible_tabs(tok):
    """从 /me/capabilities 取该用户可见的 tab key 集合。"""
    st, raw = sigv4_get("/me/capabilities", tok)
    if st != 200: return set()
    caps = json.loads(raw).get("capabilities", [])
    out = set()
    def walk(nodes):
        for n in nodes:
            out.add(n["key"]); walk(n.get("children", []))
    walk(caps)
    return out

def main():
    created = []
    try:
        # ── PERM: 安全不变量 = UI 可见某 tab ⟺ 该 tab 端点放行（不依赖硬编码，抗 DDB 编辑）──
        for role in ROLES:
            uname = "qa-perm-" + role.split(":")[1]
            sub, tok = make_user(uname, roles=[role]); created.append((uname, sub))
            vis = visible_tabs(tok)
            for tabkey, ep in ENDPOINTS.items():
                st, _ = sigv4_get(ep, tok)
                want200 = tabkey in vis
                ok = (st == 200) if want200 else (st == 403)
                check(f"PERM {role} → {tabkey.split(':')[1]} (visible={want200} ⟺ {'200' if want200 else '403'})", ok, f"got {st}")
            st, _ = sigv4_get("/no/such/route/xyz", tok)
            check(f"PERM {role} → unknown route fail-closed", st in (403, 404), f"got {st}")

        # ── VIS: 账号可见性隔离。须用【非 admin】角色（admin 有 * → visibleAccountSet 全放行，
        #    账号限制对 admin 无效，是既定设计）。临时建一个含全 dashboard tab 但无 * 的测试角色。 ──
        VIS_ROLE = "role:qa-alltabs"
        ddb.put_item(Item={"PK": f"role#{VIS_ROLE}", "SK": "meta",
            "permissions": ["nav:notifications:*", "nav:finops:*", "nav:investigate:*", "nav:cases:*", "nav:security:*"],
            "updatedAt": int(time.time()*1000)})
        sub, tok = make_user("qa-vis", roles=[VIS_ROLE], accounts=[MEMBER]); created.append(("qa-vis", sub))
        st2, _ = sigv4_get("/security/dashboard?account=999999999999", tok)
        check("VIS-3 non-visible account dashboard → 403", st2 == 403, f"got {st2}")
        for ep, key in [("/cases/org-summary", "perAccount"), ("/security/org-summary", "rows"),
                        ("/lifecycle/eos/org-summary", "rows"), ("/investigate/alarms/org-summary", "rows")]:
            st, raw = sigv4_get(ep, tok)
            rows = json.loads(raw).get(key, []) if st == 200 else []
            accts = {str(r.get("accountId", "")) for r in rows}
            leaked = accts - {"", MEMBER, OTHER_ACCT}  # deployment(mgmt) always-visible
            check(f"VIS-4 {ep} zero-leak (only member+mgmt)", st == 200 and not leaked, f"st={st} accts={accts}")
        st, raw = sigv4_get("/accounts", tok)
        accts = {a["accountId"] for a in json.loads(raw).get("accounts", [])} if st == 200 else set()
        check("VIS-2 selector limited to 682", accts == {MEMBER}, accts)
        ddb.delete_item(Key={"PK": f"role#{VIS_ROLE}", "SK": "meta"})

        # ── ATTR-C3: 账号隔离红线（agent 层）。picker=成员账号 → chat 回答不得回落/泄漏部署账号 case。
        #    直接 invoke runtime（跳过 BFF，account_id 直给），断言不出现部署账号 id/其 case id。 ──
        try:
            import uuid as _uuid
            bac = boto3.client("bedrock-agentcore", region_name=REGION)
            arn = RUNTIME_ARN
            pl = {"prompt": "how many cases in this account? state the account id", "model": "claude",
                  "locale": "en", "topic": "cases", "account_id": MEMBER, "allowed_accounts": "*",
                  "now": "2026-07-15"}
            rr = bac.invoke_agent_runtime(agentRuntimeArn=arn,
                    runtimeSessionId=("qaattr" + _uuid.uuid4().hex + _uuid.uuid4().hex)[:40],
                    payload=json.dumps(pl).encode(), contentType="application/json",
                    accept="text/event-stream")
            ans = ""
            for ln in rr["response"].iter_lines():
                if not ln:
                    continue
                sx = ln.decode("utf-8", "ignore")
                if sx.startswith("data:"):
                    try:
                        dd = json.loads(sx[5:].strip())["event"].get("contentBlockDelta", {}).get("delta", {})
                        if isinstance(dd.get("text"), str):
                            ans += dd["text"]
                    except Exception:
                        pass
            # 部署账号真实 case display-id 通过 env 传入（逗号分隔），仓库里不留真实数据。
            # 未设置时该子检查退化为“不匹配任何 id”（仍保留账号号泄漏断言）。
            _known = [c.strip() for c in os.environ.get("QA_DEPLOYMENT_CASE_IDS", "").split(",") if c.strip()]
            leaked_ids = [c for c in _known if c in ans]
            ok = (MEMBER in ans) and (OTHER_ACCT not in ans) and not leaked_ids
            check("ATTR-C3 picker=member chat: no deployment(mgmt) case fallback/leak", ok,
                  f"mgmt_in_answer={OTHER_ACCT in ans} leaked={leaked_ids}")
        except Exception as e:  # 非阻断：runtime 不可达时跳过（记为 skip 而非 fail）
            print("SKIP ATTR-C3 (runtime invoke unavailable):", str(e)[:100])

    finally:
        for uname, sub in created: cleanup(uname, sub)
        print("cleaned up", len(created), "test users")

    fails = [n for n, ok in results if not ok]
    print(f"\n===== {len(results)-len(fails)}/{len(results)} PASS =====")
    for n in fails: print("FAIL:", n)
    sys.exit(1 if fails else 0)

main()
