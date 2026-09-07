"""IM 侧的两个会话级开关 —— 用哪个 agent、要不要联网。

`core/llm_pref_resolver.py` 的同构模块（同一张表、同一套 fail-soft 口径、同一个
"群按 chat、私聊按 user" 的归属规则）。落在**已有的** conversations 表上，不新建表。

  · `agent`：`"devops"`（默认，DevOps Agent 直连，NotiOps 侧 0 token）
             / `"notiops"`（NotiOps Agent，**走模型、烧 token**）
  · `web`  ：`"off"`（默认）/ `"on"` —— 只对 `agent=notiops` 有意义（DevOps Agent
             直连那条路上联网与否由客户自己的 agent 决定，我们说不上话）。

── 为什么两个默认值都是"省钱那一侧" ────────────────────────────────────────────
IM 是**被动触发**的入口：群里 @ 一下就是一轮。默认挂上走模型的 agent + 联网，等于把
"随手问一句"变成一笔可观的账单，而客户在切换之前完全不知道。所以两个开关都**默认关**，
由用户显式打开（`/agent notiops`、`/web on`）。同一条口径也写在 `core/agent_chat.py` 头部。

── 谁能改 ──────────────────────────────────────────────────────────────────────
与 `/model` 同口径：**群里任何成员都能切**，不设管理员门（2026-06-05 的产品决策）。
理由是一致的 —— IM 里没有可靠的"谁是管理员"信号，加一道门只会让正常使用变卡。
"""
from __future__ import annotations

import logging
import time

from core import ddb_state

logger = logging.getLogger(__name__)

#: 与 `llm_pref_resolver` 同一个 30 天 TTL —— 一个群半个月不说话就回到默认值，
#: 而不是让一年前某个人的选择永久生效。
_PREF_TTL = 30 * 24 * 3600

AGENT_DEVOPS = "devops"
AGENT_NOTIOPS = "notiops"
AGENTS: tuple[str, ...] = (AGENT_DEVOPS, AGENT_NOTIOPS)
DEFAULT_AGENT = AGENT_DEVOPS
DEFAULT_WEB = False
#: 这两条开关命令**认得的入参词表**住在 `core/nl_router.py`
#: （`AGENT_ARG_WORDS` / `WEB_ARG_WORDS`）—— 路由那一层要用同一份来判断"裸词形式
#: 到底是不是这条命令"，而 nl_router 是纯函数、不碰 AWS，所以依赖只能是
#: platforms → core.nl_router 这个方向，不能反过来让 nl_router 导入本模块（boto3）。


def _k(feature: str, scope: str, platform: str, ident: str) -> str:
    return f"impref#{feature}#{scope}#{platform}:{ident}"


def _read(lookup_key: str) -> str:
    """读一行的 `value`。**永不抛** —— 读不到就当"没设过"，回落默认值。"""
    try:
        item = ddb_state._table.get_item(
            Key={"lookup_key": lookup_key}, ConsistentRead=False).get("Item")
    except Exception as e:                        # noqa: BLE001
        logger.warning("im_prefs read %s failed: %s", lookup_key,
                       type(e).__name__)
        return ""
    if not item:
        return ""
    return str(item.get("value") or "").strip().lower()


def _write(lookup_key: str, value: str) -> bool:
    now = int(time.time())
    try:
        ddb_state._table.put_item(Item={
            "lookup_key": lookup_key,
            "value": value,
            "set_at": now,
            "ttl": now + _PREF_TTL,
        })
        return True
    except Exception as e:                        # noqa: BLE001
        logger.warning("im_prefs write %s failed: %s", lookup_key,
                       type(e).__name__)
        return False


def _delete(lookup_key: str) -> bool:
    try:
        ddb_state._table.delete_item(Key={"lookup_key": lookup_key})
        return True
    except Exception as e:                        # noqa: BLE001
        logger.warning("im_prefs delete %s failed: %s", lookup_key,
                       type(e).__name__)
        return False


def _resolve(feature: str, *, platform: str, chat_id: str, user_id: str,
             is_dm: bool) -> str:
    """群 → 看 chat 行；私聊 → 看 user 行。没设过返回空串。

    ⚠️ 归属规则与 `llm_pref_resolver.resolve` **逐字对齐**：群里是"一个群一个设置"
    （大家看同一个对话，按人拆会让 A 切了 B 看不出来），私聊才按人。
    """
    if not platform:
        return ""
    if chat_id and not is_dm:
        return _read(_k(feature, "chat", platform, chat_id))
    if is_dm and user_id:
        return _read(_k(feature, "dm", platform, user_id))
    return ""


# ---------------------------------------------------------------------------
# agent
# ---------------------------------------------------------------------------
def resolve_agent(*, platform: str = "", chat_id: str = "", user_id: str = "",
                  is_dm: bool = False) -> tuple[str, str]:
    """→ `(agent, source)`，`source` ∈ {"chat","dm","default"}。"""
    v = _resolve("agent", platform=platform, chat_id=chat_id,
                 user_id=user_id, is_dm=is_dm)
    if v in AGENTS:
        return v, ("dm" if is_dm else "chat")
    return DEFAULT_AGENT, "default"


def set_agent(agent: str, *, platform: str = "", chat_id: str = "",
              user_id: str = "", is_dm: bool = False) -> bool:
    a = (agent or "").strip().lower()
    if a not in AGENTS or not platform:
        return False
    if is_dm:
        return bool(user_id) and _write(_k("agent", "dm", platform, user_id), a)
    return bool(chat_id) and _write(_k("agent", "chat", platform, chat_id), a)


def clear_agent(*, platform: str = "", chat_id: str = "", user_id: str = "",
                is_dm: bool = False) -> bool:
    if not platform:
        return False
    if is_dm:
        return bool(user_id) and _delete(_k("agent", "dm", platform, user_id))
    return bool(chat_id) and _delete(_k("agent", "chat", platform, chat_id))


# ---------------------------------------------------------------------------
# web search
# ---------------------------------------------------------------------------
def resolve_web(*, platform: str = "", chat_id: str = "", user_id: str = "",
                is_dm: bool = False) -> tuple[bool, str]:
    """→ `(enabled, source)`。默认 **关**（见文件头）。"""
    v = _resolve("web", platform=platform, chat_id=chat_id,
                 user_id=user_id, is_dm=is_dm)
    if v in ("on", "off"):
        return v == "on", ("dm" if is_dm else "chat")
    return DEFAULT_WEB, "default"


def set_web(enabled: bool, *, platform: str = "", chat_id: str = "",
            user_id: str = "", is_dm: bool = False) -> bool:
    v = "on" if enabled else "off"
    if not platform:
        return False
    if is_dm:
        return bool(user_id) and _write(_k("web", "dm", platform, user_id), v)
    return bool(chat_id) and _write(_k("web", "chat", platform, chat_id), v)


__all__ = ["AGENTS", "AGENT_DEVOPS", "AGENT_NOTIOPS", "DEFAULT_AGENT",
           "DEFAULT_WEB", "clear_agent", "resolve_agent", "resolve_web",
           "set_agent", "set_web"]
