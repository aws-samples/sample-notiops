"""
AWS Support Cases 工具集（Cases 主题底座）。

只读工具（list/get/communications/services/severities）直接执行；
写工具（create/reply/resolve）**只产出"提议"**，不在 agent 里自动执行——
用户在 UI 确认后由 BFF 调 core.support_cases.execute_* 真正执行。

提议通过 PROPOSED_ACTIONS（ContextVar）收集，main.py 收尾把它发给前端。
包装 core/support_cases（直封官方 boto3 Support API，非内部工具）。
"""
from __future__ import annotations

import contextvars
import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from strands import tool  # type: ignore
from core import support_cases as _cases

# 本轮待确认的写操作提议（main.py 每轮重置、收尾读取并发给前端）。
PROPOSED_ACTIONS: "contextvars.ContextVar[list]" = contextvars.ContextVar(
    "notiops_proposed_actions", default=None
)


def _propose(action: dict) -> dict:
    lst = PROPOSED_ACTIONS.get()
    if lst is None:
        lst = []
        PROPOSED_ACTIONS.set(lst)
    lst.append(action)
    return {"status": "pending_user_confirmation", "action": action.get("type"),
            "note": "已把该操作作为提议提交给用户，请说明将执行什么并提示用户点确认后才会真正执行；不要声称已执行。"}


# —— 只读 ——
@tool
def support_cases_list(status: str = "open") -> dict:
    """List the user's AWS Support cases. status: 'open'|'resolved'|'all'."""
    return _cases.list_cases(status=status)


@tool
def support_case_get(case_id: str) -> dict:
    """Get one Support case's details + recent communications (caseId or displayId)."""
    return _cases.get_case(case_id)


@tool
def support_case_communications(case_id: str) -> dict:
    """Get the full communication history of a Support case."""
    return _cases.get_communications(case_id)


@tool
def support_list_services() -> dict:
    """List AWS services + category codes available for opening a case."""
    return _cases.list_services()


@tool
def support_list_severities() -> dict:
    """List valid severity levels for the account's support plan."""
    return _cases.list_severity_levels()


# —— 写操作：propose-only（人工确认后由 BFF 执行）——
@tool
def support_case_create(subject: str, body: str, service_code: str,
                        category_code: str, severity_code: str = "low") -> dict:
    """PROPOSE creating a new AWS Support case (does NOT execute immediately).
    User must confirm in the UI before it is actually created."""
    return _propose({"type": "create_case", "summary": f"创建 case：{subject}",
                     "params": {"subject": subject, "communication_body": body,
                                "service_code": service_code, "category_code": category_code,
                                "severity_code": severity_code}})


@tool
def support_case_reply(case_id: str, body: str) -> dict:
    """PROPOSE adding a reply to an existing case (does NOT execute immediately)."""
    return _propose({"type": "add_communication", "summary": f"回复 case {case_id}",
                     "params": {"case_id": case_id, "communication_body": body}})


@tool
def support_case_resolve(case_id: str) -> dict:
    """PROPOSE resolving/closing a case (does NOT execute immediately)."""
    return _propose({"type": "resolve_case", "summary": f"关闭 case {case_id}",
                     "params": {"case_id": case_id}})


CASE_TOOLS = [
    support_cases_list, support_case_get, support_case_communications,
    support_list_services, support_list_severities,
    support_case_create, support_case_reply, support_case_resolve,
]
