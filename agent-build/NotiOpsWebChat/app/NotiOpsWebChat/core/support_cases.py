"""
AWS Support Cases —— 直接封装官方 boto3 `support` client（public API，非内部工具）。

NotiOps 的 Cases 主题能力底座。客户在自己账号里部署 NotiOps，agent runtime 的
IAM 角色调本账号的 AWS Support API，读/写**客户自己的** support cases。

设计要点：
  - 只读（list/get/communications/元数据）直接执行。
  - 写操作（create/reply/resolve）**不在这里自动执行**——见 main.py 的人工确认机制：
    工具只产出"提议"，用户在 UI 确认后由 BFF 调 execute_* 真正执行。本模块同时提供
    execute_* 供 BFF 在确认后调用。
  - Support API **要求 Business / Enterprise On-Ramp / Enterprise 支持计划**；
    Basic/Developer 调用会抛 SubscriptionRequiredException。统一捕获成
    {"error":"support_plan_required"} 让上层优雅提示，不把原始异常抛给用户。
  - Support API 是**全局服务**，endpoint 固定在 us-east-1。

返回结构尽量精简、含 UI 需要的字段；列表/详情会截断超长正文以控 token。
"""
from __future__ import annotations

import logging
import time
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, BotoCoreError

logger = logging.getLogger(__name__)

# Support API 是全局服务，控制面在 us-east-1。
_REGION = "us-east-1"
_MAX_CASES = 20
_MAX_BODY_CHARS = 2000

_client = None


_CFG = Config(retries={"max_attempts": 3, "mode": "standard"})


def _support(account_id: str | None = None):
    """Support client（多账号）：account_id 缺省=部署账号本地凭证；否则按账号 AssumeRole。
    部署账号 client 缓存复用；跨账号每次新建（临时凭证有时效，不缓存）。"""
    if not account_id:
        global _client
        if _client is None:
            _client = boto3.client("support", region_name=_REGION, config=_CFG)
        return _client
    from core.aws_session import get_session
    sess = get_session(account_id)
    if sess is None:
        return None  # 闸门拒绝 / AssumeRole 失败 → 调用方走 cross_account_error
    return sess.client("support", region_name=_REGION, config=_CFG)


def _is_plan_error(e: ClientError) -> bool:
    code = e.response.get("Error", {}).get("Code", "")
    return code in ("SubscriptionRequiredException",)


def _wrap(fn):
    """统一异常处理：计划不足→优雅提示；其他错误→简短 error，不抛。"""
    try:
        return fn()
    except ClientError as e:
        if _is_plan_error(e):
            return {"error": "support_plan_required",
                    "message": "AWS Support API 需要 Business / Enterprise On-Ramp / "
                               "Enterprise 支持计划。当前账号的支持计划不支持该操作。"}
        code = e.response.get("Error", {}).get("Code", "ClientError")
        msg = e.response.get("Error", {}).get("Message", str(e))
        logger.warning("support api %s: %s", code, msg)
        return {"error": code, "message": msg}
    except (BotoCoreError, Exception) as e:  # noqa: BLE001
        logger.warning("support api error: %s", e)
        return {"error": "support_error", "message": str(e)}


def _trim(s: str, n: int = _MAX_BODY_CHARS) -> str:
    s = s or ""
    return s if len(s) <= n else s[:n] + "…"


_XACCT_ERR = {"error": "cross_account_unavailable",
              "message": "无法访问该 AWS 账号：可能未在 NotiOps 注册、跨账号角色未部署，"
                         "或当前为单账号锁定模式。请确认目标账号已 onboard。"}


# ─────────────────────────── 只读 ───────────────────────────
def list_cases(*, status: str = "open", max_results: int = _MAX_CASES,
               include_resolved: bool = False, account_id: str | None = None) -> dict:
    """列出 support cases。status: open|resolved|all。返回 {cases:[...]} 或 {error}。"""
    cli = _support(account_id)
    if cli is None:
        return dict(_XACCT_ERR)
    def go():
        # ⚠️ describe_cases **不保证按时间倒序**返回，且分页（每页≤100）。要正确返回
        # "最新 N 个"，必须：① 翻页把符合 status 的 case 收全（设上限防失控）；
        # ② 按 timeCreated **降序排序**；③ 再取前 max_results。
        # 之前的实现直接取 API 头几条 + 不排序 → "最新5个"其实是任意/最旧的5个（bug）。
        kwargs: dict[str, Any] = {"maxResults": 100, "includeCommunications": False}
        if status == "all" or include_resolved or status == "resolved":
            kwargs["includeResolvedCases"] = True  # resolved/all 需要带上已解决的

        collected = []
        next_token = None
        pages = 0
        _HARD_CAP = 300  # 最多翻 3 页/300 条，避免账号 case 极多时失控
        while True:
            if next_token:
                kwargs["nextToken"] = next_token
            resp = cli.describe_cases(**kwargs)
            for c in resp.get("cases", []):
                st = (c.get("status") or "").lower()
                if status == "open" and st in ("resolved", "closed"):
                    continue
                if status == "resolved" and st not in ("resolved", "closed"):
                    continue
                collected.append({
                    "caseId": c.get("caseId"),
                    "displayId": c.get("displayId"),
                    "subject": c.get("subject"),
                    "status": c.get("status"),
                    "severityCode": c.get("severityCode"),
                    "serviceCode": c.get("serviceCode"),
                    "categoryCode": c.get("categoryCode"),
                    "submittedBy": c.get("submittedBy"),
                    "timeCreated": c.get("timeCreated"),
                })
            next_token = resp.get("nextToken")
            pages += 1
            if not next_token or len(collected) >= _HARD_CAP or pages >= 3:
                break

        # 按创建时间降序（timeCreated 是 ISO8601 串，字典序==时间序；缺失的排最后）。
        collected.sort(key=lambda x: x.get("timeCreated") or "", reverse=True)
        top = collected[: min(max(max_results, 1), _MAX_CASES)]
        return {"cases": top, "count": len(top), "total_scanned": len(collected)}
    return _wrap(go)


def get_case(case_id: str, *, with_communications: bool = True, account_id: str | None = None) -> dict:
    """取单个 case 详情（含最近往来）。case_id 是 caseId 或 displayId。"""
    cli = _support(account_id)
    if cli is None:
        return dict(_XACCT_ERR)
    def go():
        resp = cli.describe_cases(caseIdList=[case_id], includeCommunications=with_communications,
                                  includeResolvedCases=True)
        cs = resp.get("cases", [])
        if not cs:
            return {"error": "not_found", "message": f"未找到 case {case_id}"}
        c = cs[0]
        comms = []
        for m in (c.get("recentCommunications", {}) or {}).get("communications", [])[:10]:
            comms.append({
                "submittedBy": m.get("submittedBy"),
                "timeCreated": m.get("timeCreated"),
                "body": _trim(m.get("body", "")),
            })
        return {
            "caseId": c.get("caseId"), "displayId": c.get("displayId"),
            "subject": c.get("subject"), "status": c.get("status"),
            "severityCode": c.get("severityCode"), "serviceCode": c.get("serviceCode"),
            "categoryCode": c.get("categoryCode"), "submittedBy": c.get("submittedBy"),
            "ccEmailAddresses": c.get("ccEmailAddresses", []),
            "timeCreated": c.get("timeCreated"),
            "communications": comms,
        }
    return _wrap(go)


def get_communications(case_id: str, *, max_results: int = 20, account_id: str | None = None) -> dict:
    """取某 case 的往来历史（按时间）。"""
    cli = _support(account_id)
    if cli is None:
        return dict(_XACCT_ERR)
    def go():
        resp = cli.describe_communications(caseId=case_id, maxResults=min(max(max_results, 1), 100))
        out = [{
            "submittedBy": m.get("submittedBy"),
            "timeCreated": m.get("timeCreated"),
            "body": _trim(m.get("body", "")),
        } for m in resp.get("communications", [])]
        return {"caseId": case_id, "communications": out, "count": len(out)}
    return _wrap(go)


def list_services(*, account_id: str | None = None) -> dict:
    """列出可开 case 的 AWS 服务 + category 代码（创建 case 时选 service/category 用）。"""
    cli = _support(account_id)
    if cli is None:
        return dict(_XACCT_ERR)
    def go():
        resp = cli.describe_services()
        svcs = [{
            "code": s.get("code"), "name": s.get("name"),
            "categories": [{"code": cc.get("code"), "name": cc.get("name")}
                           for cc in s.get("categories", [])],
        } for s in resp.get("services", [])]
        return {"services": svcs, "count": len(svcs)}
    return _wrap(go)


def list_severity_levels(*, account_id: str | None = None) -> dict:
    """列出严重级别（low/normal/high/urgent/critical，按计划而定）。"""
    cli = _support(account_id)
    if cli is None:
        return dict(_XACCT_ERR)
    def go():
        resp = cli.describe_severity_levels()
        return {"severityLevels": [{"code": s.get("code"), "name": s.get("name")}
                                    for s in resp.get("severityLevels", [])]}
    return _wrap(go)


# ──────────────── 建案能力探测（先提醒，别让客户白填一整张表）────────────────
# 为什么要单独探一次：Basic/Developer 计划（或 agent 角色缺 support:* 权限）下，"开 case"
# 这条路从头到尾都不通，但失败点在**最后一步** execute_create_case —— 客户已经把主题、
# 服务、正文都填完点了确认，才收到一句 SubscriptionRequiredException。所以在弹卡之前先
# 探一次，把"这个账号开不了 case"当场说清楚，并给出出路。
# 用 describe_severity_levels 探：Support API 里最便宜的只读调用，且它和 create_case 受
# 同一个支持计划闸门、同一套 IAM action 约束 —— 它通，建案就通。
_CAP_TTL_SEC = 900
_cap_cache: dict[str, tuple[float, dict]] = {}
_DENIED_CODES = ("AccessDenied", "AccessDeniedException", "UnauthorizedOperation",
                 "UnrecognizedClientException")


def case_capability(*, account_id: str | None = None, use_cache: bool = True) -> dict:
    """这个账号现在能不能开 support case。

    返回 {"ok": True} 或 {"ok": False, "reason": ..., "message": ...}；
    reason ∈ support_plan_required | access_denied | cross_account_unavailable。

    拿不准时（限流、网络抖动、未知错误码）**返回 ok** 并带上 probe_error —— 宁可让客户
    继续走下去在真正建案时看到确切报错，也不要因为一次抖动就断言"你开不了 case"。
    """
    key = account_id or "_local"
    now = time.monotonic()
    if use_cache:
        hit = _cap_cache.get(key)
        if hit and now - hit[0] < _CAP_TTL_SEC:
            return dict(hit[1])

    probe = list_severity_levels(account_id=account_id)
    err = probe.get("error") if isinstance(probe, dict) else "support_error"
    if not err:
        verdict = {"ok": True}
    elif err == "support_plan_required":
        verdict = {"ok": False, "reason": "support_plan_required",
                   "message": "该账号的支持计划不包含 Support API 访问"
                              "（需 Business / Enterprise On-Ramp / Enterprise 之一）。"}
    elif err in _DENIED_CODES:
        verdict = {"ok": False, "reason": "access_denied",
                   "message": "该账号有支持计划，但当前角色缺少 Support API 权限"
                              "（至少需要 support:DescribeSeverityLevels 与 support:CreateCase）。"}
    elif err == "cross_account_unavailable":
        verdict = {"ok": False, "reason": "cross_account_unavailable",
                   "message": str(probe.get("message", ""))}
    else:
        logger.info("case_capability inconclusive (%s) — treating as available", err)
        return {"ok": True, "probe_error": err}

    # 只缓存**确定**的结论。cross_account_unavailable 不缓存：账号随时可能被 onboard。
    if verdict["ok"] or verdict["reason"] in ("support_plan_required", "access_denied"):
        _cap_cache[key] = (now, dict(verdict))
    return verdict


# ─────────────────────── 写操作（仅 BFF 在用户确认后调用）───────────────────────
def execute_create_case(*, subject: str, communication_body: str, service_code: str,
                        category_code: str, severity_code: str = "low",
                        cc_email_addresses: list[str] | None = None,
                        language: str = "en", account_id: str | None = None) -> dict:
    """真正创建 case。**只应由 BFF 在用户 UI 确认后调用**，不在 agent 工具里自动执行。"""
    cli = _support(account_id)
    if cli is None:
        return dict(_XACCT_ERR)
    def go():
        kwargs: dict[str, Any] = {
            "subject": subject, "communicationBody": communication_body,
            "serviceCode": service_code, "categoryCode": category_code,
            "severityCode": severity_code, "language": language,
            "issueType": "technical",
        }
        if cc_email_addresses:
            kwargs["ccEmailAddresses"] = cc_email_addresses[:10]
        resp = cli.create_case(**kwargs)
        return {"ok": True, "caseId": resp.get("caseId")}
    return _wrap(go)


def execute_add_communication(*, case_id: str, communication_body: str,
                              cc_email_addresses: list[str] | None = None,
                              account_id: str | None = None) -> dict:
    """真正给 case 追加回复。**只应由 BFF 在用户确认后调用**。"""
    cli = _support(account_id)
    if cli is None:
        return dict(_XACCT_ERR)
    def go():
        kwargs: dict[str, Any] = {"caseId": case_id, "communicationBody": communication_body}
        if cc_email_addresses:
            kwargs["ccEmailAddresses"] = cc_email_addresses[:10]
        resp = cli.add_communication_to_case(**kwargs)
        return {"ok": bool(resp.get("result", True)), "caseId": case_id}
    return _wrap(go)


def execute_resolve_case(*, case_id: str, account_id: str | None = None) -> dict:
    """真正关闭 case。**只应由 BFF 在用户确认后调用**。"""
    cli = _support(account_id)
    if cli is None:
        return dict(_XACCT_ERR)
    def go():
        resp = cli.resolve_case(caseId=case_id)
        return {"ok": True, "caseId": case_id,
                "initialStatus": resp.get("initialCaseStatus"),
                "finalStatus": resp.get("finalCaseStatus")}
    return _wrap(go)
