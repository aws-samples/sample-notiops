"""
AWS Q&A tool —— web chat agent 的第一个 tool（Phase 1）。

包装 core/aws_docs_mcp 的 search/read（经 AWS Knowledge MCP 查官方文档），
作为 Strands @tool 暴露给 agent。anti-hallucination：AWS 技术问题必须先查文档，
不凭记忆答（与 core/bedrock_chat 的零变更/防幻觉规则一致）。

返回结构里带 sources，供 BFF/前端的 Sources 抽屉展示出处。
"""
from __future__ import annotations

import sys
import os

# 让 agent 容器能 import 仓库根的 core/（部署打包时 core/ 一并带上）
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from strands import tool  # type: ignore
from core import aws_docs_mcp  # 复用既有 MCP 封装


@tool
def aws_docs_search(query: str) -> dict:
    """Search official AWS documentation for a technical question.

    Use this FIRST for any AWS technical question (service behavior, concepts,
    quotas, API, config syntax, best practices, error codes, limits, defaults,
    differences). Never answer AWS technical questions from memory — training
    data may be stale or wrong; only the docs are authoritative.

    Args:
        query: The technical question or search phrase, e.g. "ALB vs NLB".

    Returns:
        dict with `hits` (list of {title, url, context}) and `sources`
        (list of {icon, title, detail}) for the UI Sources panel.
    """
    res = aws_docs_mcp.search_documentation(query)
    hits = res.get("results") or res.get("hits") or []
    sources = [
        {"icon": "doc", "title": h.get("title") or h.get("url", ""), "detail": h.get("url", "")}
        for h in hits
        if h.get("url")
    ]
    return {"hits": hits, "sources": sources}


@tool
def aws_docs_read(url: str) -> dict:
    """Read the full content of a specific AWS documentation page.

    Call after aws_docs_search to read the most relevant doc URL, then answer
    from it. Only docs.aws.amazon.com URLs are allowed.

    Args:
        url: The AWS documentation URL to read.

    Returns:
        dict with `content` (markdown text) and `sources` (the read URL).
    """
    content = aws_docs_mcp.read_documentation(url)
    return {
        "content": content,
        "sources": [{"icon": "doc", "title": url, "detail": url}],
    }
