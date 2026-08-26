"""
Web Search —— 经 **AWS Bedrock AgentCore Gateway** 的内置 `web-search` 连接器。

作为回答链的**最后一步**（AWS 文档 → 专业知识 → 联网），且**仅在用户本轮主动开启**
联网搜索时才被调用（逐请求门控在 agent/tools/web_search.py 的 ContextVar）。

为什么只剩这一条路：查询文本**不出 AWS**。历史上这里还有一条 Exa 公共 MCP 端点的兜底
（第三方、无鉴权、无 SLA、查询离开 AWS），2026-08 移除。移除的理由不是"多余"，而是
**它让同一个界面开关的隐私边界取决于部署有没有配 Gateway**：配了就在 AWS 内，没配就静默
把用户的查询发给第三方 —— 而客户从界面上完全看不出自己是哪一种。真实实现在
core/agentcore_search.py；本模块只负责「未配置 / 失败 → 空结果而不是异常」这层契约，
让上层（工具层与模型）的行为与原来完全一致。

Operating constraints:
  - 未配置 Gateway（`AGENTCORE_WEBSEARCH_GATEWAY_URL` 为空）或调用失败 →
    返回 `{"text": "", "sources": []}`，**不抛异常**：模型据此回退到非联网回答
    （prompt.py 里 `[Web search: ON]` 但拿到空结果时的行为已定义）。
  - 最多 5 条结果、每条正文截断到 800 字以控 token；截断与噪声过滤都在
    core/agentcore_search.py 做（那里还拿得到结构化的 hit）。
  - 返回 `{"text": <拼接正文>, "sources": [{icon,title,detail}]}`，sources 直接喂给
    前端 Sources 抽屉（与 aws_docs 工具同形）。
"""
from __future__ import annotations

import logging
import os

from core import agentcore_search as _agentcore

logger = logging.getLogger(__name__)

_MAX_RESULTS = int(os.environ.get("WEB_SEARCH_MAX_RESULTS", "5"))

_EMPTY: dict = {"text": "", "sources": []}


def configured() -> bool:
    """本部署是否真的能联网搜索（= Gateway URL 已注入）。

    供上层做能力位用：两条部署路径都会在部署期建 Gateway 并注入 URL，所以正常情况下
    恒为 True；为空只发生在「区域不支持 / 建 Gateway 失败」这类降级场景。
    """
    return _agentcore.configured()


def search(query: str, *, num_results: int = _MAX_RESULTS) -> dict:
    """Search the web for ``query``. Returns ``{"text": str, "sources": [...]}``.

    Never raises: any failure (not provisioned / throttled / bad response) yields an empty
    result so the model answers without the web instead of surfacing an error to the user.
    """
    query = (query or "").strip()
    if not query:
        return dict(_EMPTY)
    if not _agentcore.configured():
        # 部署期没建出 Gateway（区域不支持或建失败）。不是异常路径，但值得留痕：
        # 否则"联网搜索开了却什么都没搜到"在日志里毫无线索。
        logger.warning("web_search: no AgentCore gateway configured — returning empty result")
        return dict(_EMPTY)

    try:
        res = _agentcore.search(query, num_results=num_results)
    except Exception as e:  # noqa: BLE001 — 工具层不允许抛
        logger.warning("web_search: AgentCore search failed: %s", type(e).__name__)
        return dict(_EMPTY)

    if not res or not res.get("text"):
        return dict(_EMPTY)
    return {"text": res.get("text", ""), "sources": res.get("sources", [])}
