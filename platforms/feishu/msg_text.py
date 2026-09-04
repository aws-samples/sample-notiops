"""从飞书 `GET /im/v1/messages/{id}` 的返回里抠出**人能读的正文**（B8 第 7 项）。

单独一个模块、只用标准库、**不 import lark_oapi**：`platforms/feishu/app/*` 在 import
期就要 lark_oapi（CI 环境没装），放那里等于这段解析永远测不到。而这段恰恰是最容易
悄悄退化的地方 —— 飞书每种 `msg_type` 的 `body.content` 都是**另一种形状的 JSON 字符串**：

  · `text`        → ``{"text": "..."}``
  · `post`        → ``{"zh_cn": {"title": ..., "content": [[{"tag":"text","text":...}]]}}``
  · `interactive` → 整张卡片的 JSON（NotiOps 自己发的卡都是这种）
  · `image` / `file` / `audio` / `media` → 只有 key，没有任何文字

抠不到就返回空串,由调用方按"取不到历史消息"处理并**明确告诉用户**(不静默)。
"""
from __future__ import annotations

import json

#: 卡片/富文本里承载文字的键。飞书的卡片元素五花八门（markdown / plain_text /
#: lark_md / button 的 text.content …），但文字最终都落在这几个键上。
_TEXT_KEYS = ("text", "content", "title")

#: 递归深度上限 —— 卡片可以嵌很深（column_set → column → element → text）。给个上限
#: 纯粹是防畸形输入把栈打爆，正常卡片 8 层足够。
_MAX_DEPTH = 8


def parse_content(msg_type: str, content: str) -> str:
    """``(msg_type, body.content)`` → 可读正文。抠不到返回空串。"""
    raw = (content or "").strip()
    if not raw:
        return ""
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        # 不是 JSON —— 极少见，但直接当纯文本用比丢掉好。
        return raw[:4000]

    if msg_type == "text" and isinstance(payload, dict):
        return str(payload.get("text") or "").strip()
    if msg_type == "post":
        return _post_text(payload)
    # interactive（卡片）/ share_chat / 未知类型 —— 一律走通用摊平。
    return _flatten(payload)


def parse_item(item: dict) -> str:
    """``data.items[0]`` → 可读正文。`item["body"]["content"]` 是那串 JSON。"""
    if not isinstance(item, dict):
        return ""
    body = item.get("body")
    content = ""
    if isinstance(body, dict):
        content = str(body.get("content") or "")
    return parse_content(str(item.get("msg_type") or ""), content)


def sender_of(item: dict) -> str:
    """发件人 id（open_id / app_id）。只用于给 agent 标一句 "from …"，取不到就空。"""
    if not isinstance(item, dict):
        return ""
    sender = item.get("sender")
    if isinstance(sender, dict):
        return str(sender.get("id") or "")
    return ""


def _post_text(payload) -> str:
    """富文本 `post`：取任意一个语言版本的 title + 所有 text 段。"""
    if not isinstance(payload, dict):
        return ""
    # 形状是 {"zh_cn": {...}} / {"en_us": {...}}；哪个都行，取第一个 dict。
    inner = payload
    for value in payload.values():
        if isinstance(value, dict) and ("content" in value or "title" in value):
            inner = value
            break
    lines: list[str] = []
    title = str(inner.get("title") or "").strip()
    if title:
        lines.append(title)
    flat = _flatten(inner.get("content"))
    if flat:
        lines.append(flat)
    return "\n".join(lines).strip()


def _flatten(node, depth: int = 0) -> str:
    """把嵌套 dict/list 里所有文字键摊成一段（去重、保序）。"""
    out: list[str] = []
    _walk(node, depth, out)
    seen: set[str] = set()
    kept = []
    for s in out:
        if s not in seen:
            seen.add(s)
            kept.append(s)
    return "\n".join(kept).strip()


def _walk(node, depth: int, out: list[str]) -> None:
    if depth > _MAX_DEPTH:
        return
    if isinstance(node, str):
        s = node.strip()
        if s:
            out.append(s)
        return
    if isinstance(node, list):
        for child in node:
            _walk(child, depth + 1, out)
        return
    if not isinstance(node, dict):
        return
    for key, value in node.items():
        if key in _TEXT_KEYS:
            _walk(value, depth + 1, out)
        elif isinstance(value, (dict, list)):
            _walk(value, depth + 1, out)
