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


# 与部署版 main.py 的 aws_docs_read 同一套语义（长页面分段读 + 失败与"没有"分开），理由见那边的注释。
_PAGE_KEYS = ("start_index", "end_index", "total_length", "truncated", "redirected_url")
_UNAVAILABLE_NOTE = (
    "The AWS documentation service did not answer (transport failure) — this is NOT "
    "'no documentation exists'. Do not answer this AWS technical question from memory: "
    "tell the user the docs lookup failed and suggest retrying."
)


@tool
def aws_docs_read(url: str, start_index: int = 0) -> dict:
    """Read an AWS documentation page, or the next part of a long one.

    Call after aws_docs_search to read the most relevant doc URL, then answer
    from it. Only docs.aws.amazon.com URLs are allowed.

    Long pages come back in parts: the reply has `start_index`, `end_index`,
    `total_length` and `truncated`, and a truncated part begins with a Table of
    Contents giving each section's char range. Never repeat a call with the same
    url and start_index — it returns the same text. A non-empty `error` means the
    fetch FAILED — say so rather than answering from memory.

    Args:
        url: Exact URL from aws_docs_search results.
        start_index: Char offset to read from (default 0 = page start). To continue,
            pass the previous reply's `next_start_index`; to jump to a section, pass
            its first offset from the Table of Contents.

    Returns:
        dict with `content` (markdown text), the paging fields, and `sources` (the read URL).
    """
    res = aws_docs_mcp.read_documentation_ex(url, start_index=start_index)
    if err := res.get("error"):
        note = (_UNAVAILABLE_NOTE if err != "url_not_allowed" else
                "That URL is not an allowed AWS documentation host. Pick a URL from "
                "aws_docs_search results instead of constructing one.")
        return {"content": "", "sources": [], "error": err, "note": note}
    out = {"content": res["content"], "error": ""}
    out.update({k: res[k] for k in _PAGE_KEYS if k in res})
    start, end, total = res.get("start_index", 0), res.get("end_index"), res.get("total_length")
    if res.get("truncated") and isinstance(end, int):
        out["next_start_index"] = end
        out["note"] = (f"Part of a longer page: chars {start}-{end} of {total}. For more, call "
                       f"aws_docs_read again with start_index={end}, or with a section's offset "
                       "from the Table of Contents.")
    elif not res["content"]:
        out["note"] = (f"start_index={start} is past the end of this page (total_length={total}); "
                       "there is nothing more to read." if isinstance(total, int) and 0 < total <= start
                       else "This page returned no text. Answer from the aws_docs_search excerpts "
                            "or read another URL.")
    out["sources"] = [{"icon": "doc", "title": url, "detail": url}]
    return out
