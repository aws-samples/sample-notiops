"""Web chat agent tools。

- AWS Q&A（aws_docs_search / aws_docs_read）：官方文档检索，doc-first 防幻觉。
- web_search：联网搜索（第三方 Exa，逐请求门控，默认关）。
后续主题（investigate / case / 巡检）逐步加。
"""
from .aws_qa import aws_docs_search, aws_docs_read
from .web_search import web_search, WEB_SEARCH_ENABLED
from .support_cases_tools import CASE_TOOLS, PROPOSED_ACTIONS

__all__ = ["aws_docs_search", "aws_docs_read", "web_search", "WEB_SEARCH_ENABLED",
           "CASE_TOOLS", "PROPOSED_ACTIONS"]
