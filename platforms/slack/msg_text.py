"""从 Slack 消息对象里抠出**人能读的正文**（B8 第 7 项）。

单独一个模块、只用标准库、**不 import slack_sdk**：这样 CI 里能直接单测解析逻辑
（Slack 的 `WebClient` 在 import 期就要 token，`platforms/slack/caps.py` 那条路走不通）。

为什么不能只读 `message["text"]`：NotiOps 自己发的都是 Block Kit 卡片，那种消息的
`text` 往往只是一句 fallback（甚至空串），真正的内容在 `blocks[].text.text` 里。
用户"回复一条 NotiOps 发的历史消息让它解读"正是这次要修的场景，所以卡片必须能读出来。
"""
from __future__ import annotations

#: Block Kit 里承载文字的键。`text` 既可能是字符串也可能是
#: ``{"type": "mrkdwn", "text": "..."}``，所以统一递归处理。
_TEXT_KEYS = ("text", "value", "alt_text")

_MAX_DEPTH = 8


def parse_message(message: dict) -> str:
    """一条 Slack 消息 → 可读正文。抠不到返回空串。

    顺序：`text` 优先（绝大多数人类消息就够了），再补 `blocks` / `attachments` 里
    额外的内容 —— 卡片消息的 `text` 常常只是 fallback，两者都要。
    """
    if not isinstance(message, dict):
        return ""
    chunks: list[str] = []
    top = str(message.get("text") or "").strip()
    if top:
        chunks.append(top)
    for key in ("blocks", "attachments"):
        flat = _flatten(message.get(key))
        if flat:
            chunks.append(flat)
    return _dedupe("\n".join(c for c in chunks if c))


def sender_of(message: dict) -> str:
    """发件人：真人是 `user`，bot 是 `bot_id`（NotiOps 自己发的就是后者）。"""
    if not isinstance(message, dict):
        return ""
    return str(message.get("user") or message.get("bot_id") or "")


def _flatten(node, depth: int = 0) -> str:
    out: list[str] = []
    _walk(node, depth, out)
    return "\n".join(out).strip()


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


def _dedupe(text: str) -> str:
    """去掉重复行（卡片的 fallback `text` 常与 block 里的第一行一模一样）。"""
    seen: set[str] = set()
    kept: list[str] = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s in seen:
            continue
        seen.add(s)
        kept.append(s)
    return "\n".join(kept).strip()
