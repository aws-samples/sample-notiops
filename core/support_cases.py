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


def _support():
    global _client
    if _client is None:
        _client = boto3.client("support", region_name=_REGION,
                               config=Config(retries={"max_attempts": 3, "mode": "standard"}))
    return _client


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


# ─────────────────────────── 只读 ───────────────────────────
def list_cases(*, status: str = "open", max_results: int = _MAX_CASES,
               include_resolved: bool = False) -> dict:
    """列出 support cases。status: open|resolved|all。返回 {cases:[...]} 或 {error}。"""
    def go():
        # describe_cases 不保证时间倒序且分页：翻页收全 → 按 timeCreated 降序 → 取前 N。
        # （旧实现直接取头几条不排序，"最新N个"返回的是任意/最旧的，是 bug。）
        kwargs: dict[str, Any] = {"maxResults": 100, "includeCommunications": False}
        if status == "all" or include_resolved or status == "resolved":
            kwargs["includeResolvedCases"] = True
        collected = []
        next_token = None
        pages = 0
        while True:
            if next_token:
                kwargs["nextToken"] = next_token
            resp = _support().describe_cases(**kwargs)
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
            if not next_token or len(collected) >= 300 or pages >= 3:
                break
        collected.sort(key=lambda x: x.get("timeCreated") or "", reverse=True)
        top = collected[: min(max(max_results, 1), _MAX_CASES)]
        return {"cases": top, "count": len(top), "total_scanned": len(collected)}
    return _wrap(go)


def get_case(case_id: str, *, with_communications: bool = True) -> dict:
    """取单个 case 详情（含最近往来）。case_id 是 caseId 或 displayId。"""
    def go():
        resp = _support().describe_cases(caseIdList=[case_id], includeCommunications=with_communications,
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


def get_communications(case_id: str, *, max_results: int = 20) -> dict:
    """取某 case 的往来历史（按时间）。"""
    def go():
        resp = _support().describe_communications(caseId=case_id, maxResults=min(max(max_results, 1), 100))
        out = [{
            "submittedBy": m.get("submittedBy"),
            "timeCreated": m.get("timeCreated"),
            "body": _trim(m.get("body", "")),
        } for m in resp.get("communications", [])]
        return {"caseId": case_id, "communications": out, "count": len(out)}
    return _wrap(go)


def list_services() -> dict:
    """列出可开 case 的 AWS 服务 + category 代码（创建 case 时选 service/category 用）。"""
    def go():
        resp = _support().describe_services()
        svcs = [{
            "code": s.get("code"), "name": s.get("name"),
            "categories": [{"code": cc.get("code"), "name": cc.get("name")}
                           for cc in s.get("categories", [])],
        } for s in resp.get("services", [])]
        return {"services": svcs, "count": len(svcs)}
    return _wrap(go)


def list_severity_levels() -> dict:
    """列出严重级别（low/normal/high/urgent/critical，按计划而定）。"""
    def go():
        resp = _support().describe_severity_levels()
        return {"severityLevels": [{"code": s.get("code"), "name": s.get("name")}
                                    for s in resp.get("severityLevels", [])]}
    return _wrap(go)


# ─────────────────────── 写操作（仅 BFF 在用户确认后调用）───────────────────────
def execute_create_case(*, subject: str, communication_body: str, service_code: str,
                        category_code: str, severity_code: str = "low",
                        cc_email_addresses: list[str] | None = None,
                        language: str = "en") -> dict:
    """真正创建 case。**只应由 BFF 在用户 UI 确认后调用**，不在 agent 工具里自动执行。"""
    def go():
        kwargs: dict[str, Any] = {
            "subject": subject, "communicationBody": communication_body,
            "serviceCode": service_code, "categoryCode": category_code,
            "severityCode": severity_code, "language": language,
            "issueType": "technical",
        }
        if cc_email_addresses:
            kwargs["ccEmailAddresses"] = cc_email_addresses[:10]
        resp = _support().create_case(**kwargs)
        return {"ok": True, "caseId": resp.get("caseId")}
    return _wrap(go)


def execute_add_communication(*, case_id: str, communication_body: str,
                              cc_email_addresses: list[str] | None = None) -> dict:
    """真正给 case 追加回复。**只应由 BFF 在用户确认后调用**。"""
    def go():
        kwargs: dict[str, Any] = {"caseId": case_id, "communicationBody": communication_body}
        if cc_email_addresses:
            kwargs["ccEmailAddresses"] = cc_email_addresses[:10]
        resp = _support().add_communication_to_case(**kwargs)
        return {"ok": bool(resp.get("result", True)), "caseId": case_id}
    return _wrap(go)


def execute_resolve_case(*, case_id: str) -> dict:
    """真正关闭 case。**只应由 BFF 在用户确认后调用**。"""
    def go():
        resp = _support().resolve_case(caseId=case_id)
        return {"ok": True, "caseId": case_id,
                "initialStatus": resp.get("initialCaseStatus"),
                "finalStatus": resp.get("finalCaseStatus")}
    return _wrap(go)
