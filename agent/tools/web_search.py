"""
Web search tool —— 联网搜索（AWS 原生：AgentCore Gateway 的 web-search 连接器，
查询文本**不出 AWS**；2026-08 起没有第三方兜底，见 core/web_search.py）。

作为回答链的**最后一步**（AWS 文档 → 专业知识 → 联网），且**仅在用户本轮主动
开启**联网搜索时才允许调用。用 ContextVar 逐请求门控：Strands 用 asyncio.to_thread
跑同步工具时会拷贝 contextvars，因此同容器并发会话互不影响。

包装 core/web_search 的 search()，返回 {text, sources}，sources 形态与 aws_qa
一致（{icon,title,detail}），直接喂给前端 Sources 抽屉。
"""
from __future__ import annotations

import contextvars
import os
import sys

# 让 agent 容器能 import 仓库根的 core/（部署打包时 core/ 一并带上）
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from strands import tool  # type: ignore
from core import web_search as _web_search

# 本轮是否允许联网搜索；由 main.py 在每次请求开始时按 payload.web_search set。
WEB_SEARCH_ENABLED: "contextvars.ContextVar[bool]" = contextvars.ContextVar(
    "notiops_web_search_enabled", default=False
)


@tool
def web_search(query: str) -> dict:
    """Search the public web for CURRENT/EXTERNAL info not in AWS docs
    (recent news, pricing pages, third-party comparisons, non-AWS tech).

    Only available when the user has enabled web search for this turn; if
    disabled, returns a notice and you must answer without it.
    NOTE: the query is searched inside AWS (Bedrock AgentCore web search);
    it is not sent to any third-party engine.

    Args:
        query: 要搜索的自然语言查询。

    Returns:
        dict with `text` (compact summary of top hits) and `sources`
        (list of {icon:"web", title, detail}) for the UI Sources panel.
    """
    if not WEB_SEARCH_ENABLED.get():
        return {
            "text": "",
            "sources": [],
            "notice": "Web search is OFF for this turn. Answer from AWS docs and "
                      "your own knowledge; do not claim you searched the web.",
        }
    res = _web_search.search(query)
    return {"text": res.get("text", ""), "sources": res.get("sources", [])}
