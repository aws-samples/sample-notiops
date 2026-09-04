"""看板深链（R11b.7 / R11b.9）。

⚠️ 放在 `adapters/` 而不是 `domain/`：它要 `urllib.parse.quote`，而
`test_domain_layer_has_no_io` 把 `urllib` 整个列进 `BANNED_MODULES`
（domain 层不得有 IO）。这个模块**不 import boto3**，所以 CI 的
`inspection-tests` job（故意不装 boto3）照样能测它。

## 为什么 finding_id 必须编码

`finding_id` 是六段 `#` 拼起来的
（`<acct>#<region>#<service>#<instance>#<rule>#<metric>`）。裸着放进
query string 的话，第一个 `#` 会被浏览器当成 fragment 分隔符 ——
`?finding=` 后面的内容**整段丢失**，而链接看起来是好的、点开也不报错，
只是落在一个没有选中任何条目的看板上。

## base URL 空着不是错误

`WEB_BASE_URL` 没配（新部署 / 只装了后端）时返回空串，调用方**不放链接**
而不是放一个坏链接。照 `bff/web-chat/devops_investigate.mjs:354` 的先例。
"""

from __future__ import annotations

from urllib.parse import quote

QUERY_ACCOUNT = "account"
QUERY_FINDING = "finding"
QUERY_TAB = "tab"
"""query 参数名。**与前端读取处必须一致**（`InspectionDashboardBrowser`），
有元断言锁住 —— 改一侧的表现是链接点开落在默认页，没有任何报错。

⚠️ `account` 与后端 `/inspection/finding?account=&id=` 的参数名同名是刻意的
（一处约定），但 finding 用 `finding` 而不是 `id`：前端的 URL 是给人看的，
`?id=` 在一个还有 account / tab 的 URL 里读不出指的是什么。
"""


def normalize_base(base: str) -> str:
    """`d123.cloudfront.net` / `https://x/` → `https://x`。空 → 空。

    ⚠️ 容忍带不带 scheme：CDK 的 CfnOutput 给的是带 `https://` 的完整 URL，
    而运维手填 context 时常常只填域名。少了这层的表现是拼出
    `d123.cloudfront.net/?account=…` 这种相对路径链接，IM 客户端不识别成
    链接（不报错，只是不可点）。
    """
    b = (base or "").strip().rstrip("/")
    if not b:
        return ""
    if not b.startswith(("http://", "https://")):
        b = "https://" + b
    return b


def finding_link(base: str, account_id: str, finding_id: str, *,
                 tab: str = "") -> str:
    """一跳到具体 finding 的深链（R11b.7）。base 空 → 返回空串。

    R11b.7 原文要求「深链一跳到具体 finding，**不是跳列表页让客户自己翻**」，
    所以 `finding` 参数必须带上，且前端要读它并打开右侧详情。
    """
    root = normalize_base(base)
    if not root or not finding_id:
        return ""
    parts = [f"{QUERY_FINDING}={quote(str(finding_id), safe='')}"]
    if account_id:
        parts.insert(0, f"{QUERY_ACCOUNT}={quote(str(account_id), safe='')}")
    if tab:
        parts.append(f"{QUERY_TAB}={quote(str(tab), safe='')}")
    return f"{root}/?" + "&".join(parts)


def dashboard_link(base: str, account_id: str = "", *, tab: str = "") -> str:
    """「查看全部」用的列表链（R11b.7 的第二个链接）。base 空 → 空串。"""
    root = normalize_base(base)
    if not root:
        return ""
    parts = []
    if account_id:
        parts.append(f"{QUERY_ACCOUNT}={quote(str(account_id), safe='')}")
    if tab:
        parts.append(f"{QUERY_TAB}={quote(str(tab), safe='')}")
    return f"{root}/?" + "&".join(parts) if parts else f"{root}/"


def scope_link(base: str, account_id: str = "") -> str:
    """snooze 深链（R11b.9 的降级路径）：一跳到「巡检范围」页。

    🔴 R11b.9 首选是**卡片上的 snooze 按钮**，本期没做，原因是可验证的：
    推送走 `send_markdown`（markdown 正文），而按钮需要交互式卡片 +
    平台各自的 action callback 路由，三个平台三套。R11b.9 明写
    「若本期不做，至少 SHALL 提供深链让客户一跳到能 snooze 的位置」——
    这就是那条深链，落在排除清单页（`tab=scope`）。
    """
    return dashboard_link(base, account_id, tab="scope")
