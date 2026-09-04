"""IM 调查进度 Lambda（IM 重构 / M1 + M3）—— 每分钟一次扫 `imtask#`，**平台无关**。

替代 Fargate 那条 `progress_poller` 常驻线程。做法：`ddb_state.list_im_tasks()` → 每条
`imtask#` 行调 `core.devops_agent.poll_investigation()`（**无状态增量**，游标 `seen_ids`
存在行上）→ 把新增行更新到「已发起」那条消息上；到终态直接删行、写「已完成」。

由 EventBridge（`rate(1 minute)`）触发。

── 为什么在 `platforms/common/` 而不是 `platforms/feishu/`（M1 时它在那儿）───────────
轮询逻辑（拉 journal → 算增量 → 判终态 → 写游标）与平台**完全无关**；只有最后
"把这段正文渲染成什么、发到哪儿"是平台相关的。M3 加 Slack 时如果照旧放在 feishu/ 下
再 `if platform == "slack"`，读代码的人会以为 Slack 的进度是飞书模块的副作用。
一个函数服务所有平台（而不是每平台一个 Lambda + 一条 EventBridge 规则）的理由：
在途调查是**跨平台共享一张表**的，两个函数各扫一遍同一批行只会互相抢着 PATCH。

── 平台分派：只有两处 ─────────────────────────────────────────────────────────
  `_RENDERERS[platform]` → 渲染函数（飞书 card dict / Slack blocks list）
  `_UPDATERS[platform]`  → 更新函数（飞书 PATCH card / Slack chat.update）
加平台（M4 钉钉）= 各加一行，不动 `_tick_one`。
"""
from __future__ import annotations

import logging
import time

from core import ddb_state
from core import devops_agent
from core import i18n

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# 非 COMPLETED 的终态一律按"失败"渲染（红头 / 失败标题 + 开案例按钮）。
_FAILED_STATUSES = {"FAILED", "TIMED_OUT", "CANCELED", "SKIPPED"}

# 正文兜底上限。真正的截断在各平台的渲染模块里（飞书 im_cards.MAX_BODY /
# Slack im_blocks.MAX_BODY，两者不同），这里只保证写回 DDB 的 `rendered` 不会无限长。
# 取两者的较大值 —— 取小的会让飞书那边白丢一截已经渲染过的正文。
_MAX_BODY = 4000


# ---------------------------------------------------------------------------
# 平台分派表
# ---------------------------------------------------------------------------
def _render_feishu(body: str, locale: str, **kw):
    from platforms.feishu import im_cards
    return im_cards.dispatch_card(body[:im_cards.MAX_BODY], locale, **kw)


def _update_feishu(chat_id: str, message_id: str, payload) -> None:
    # 飞书是「改一张卡」：只要 message_id，不需要 chat_id。
    from platforms.feishu.app import feishu_utils
    feishu_utils.update_card(message_id, payload)


def _render_slack(body: str, locale: str, **kw):
    from platforms.slack import im_blocks
    return im_blocks.dispatch_blocks(body[:im_blocks.MAX_BODY], locale, **kw)


def _update_slack(chat_id: str, message_id: str, payload) -> None:
    """Slack 是「改一条消息」：`chat.update` **必须**同时给 channel + ts。

    ⚠️ `text=` 也要给：`chat.update` 不带 text 时会把通知栏 fallback 清空，手机推送
    显示成「This content can't be displayed」。
    """
    from platforms.slack import im_blocks
    from platforms.slack.caps import get_client
    get_client().chat_update(channel=chat_id, ts=message_id,
                             text=im_blocks.fallback_text(payload),
                             blocks=payload)


_RENDERERS = {"feishu": _render_feishu, "slack": _render_slack}
_UPDATERS = {"feishu": _update_feishu, "slack": _update_slack}


# ---------------------------------------------------------------------------
def _tick_one(row: dict) -> None:
    """处理一条 `imtask#` 行。永不抛（一条挂了不该拖垮别的）。"""
    incident_id = row.get("incident_id") or ""
    task_id = row.get("task_id") or ""
    execution_id = row.get("execution_id") or ""
    space = row.get("agent_space_id") or ""
    if not (incident_id and task_id and execution_id and space):
        logger.warning("progress: skip malformed row %s", incident_id)
        return

    platform = str(row.get("platform") or "feishu")
    render = _RENDERERS.get(platform)
    update = _UPDATERS.get(platform)
    if not (render and update):
        # 未知平台 —— 删掉这行，否则它会每分钟被扫到一次直到 TTL（最长 30 分钟），
        # 每轮都白拉一遍 journal。**不静默跳过**：日志里点名平台名。
        logger.error("progress: row %s has unknown platform %r — dropped",
                     incident_id, platform)
        ddb_state.delete_im_task(incident_id)
        return

    seen = set(row.get("seen_ids") or [])
    account = row.get("account_id") or ""
    locale = row.get("locale") or "zh"
    result = devops_agent.poll_investigation(
        execution_id=execution_id, task_id=task_id, agent_space_id=space,
        account_id=account or None, seen_ids=seen, locale=locale,
    )
    if not result.get("ok"):
        logger.warning("progress: poll failed for %s: %s", incident_id,
                       result.get("error"))
        return
    new_lines = result.get("new_lines") or []
    seen_after = set(result.get("seen_ids") or [])
    terminal = bool(result.get("terminal"))
    status = str(result.get("status") or "")

    rendered = str(row.get("rendered") or "")
    if new_lines:
        rendered = (rendered + "".join(new_lines))[-_MAX_BODY:]

    # 链接优先用发起时存下来的（更新是**整体替换**，不带上就把按钮抹掉了）；
    # 万一那时没拿到，再现算一次。
    deep_link = str(row.get("console_url") or "")
    home = str(row.get("console_home") or "")
    if not (deep_link or home):
        urls = devops_agent.operator_urls(space, task_id)
        deep_link = urls.get("deep_link") or ""
        home = urls.get("home") or ""

    elapsed = max(0, int(time.time()) - int(row.get("started_at") or 0))
    if not terminal:
        state = "running"
    elif status in _FAILED_STATUSES:
        state = "failed"
    else:
        state = "done"
    # 2026-09-03 起不再传 `question=` —— 深度调查卡上那两个回调按钮
    # （「只要一个答案就行」/「开案例」）已经去掉，渲染函数也不再接这个参数
    # （见 `platforms/feishu/im_cards.dispatch_card` 的说明）。行里的 `title`
    # 字段保留不动：它还是这条 imtask 行的人类可读标识，日志/排障要用。
    payload = render(
        rendered or i18n.t("progress.placeholder_analyzing", locale),
        locale, deep_link=deep_link, home=home,
        state=state, elapsed=elapsed,
    )

    message_id = row.get("message_id") or ""
    chat_id = str(row.get("chat_id") or "")
    if message_id:
        try:
            update(chat_id, message_id, payload)
        except Exception as e:                    # noqa: BLE001
            logger.warning("progress: update (%s) %s failed: %s",
                           platform, message_id, type(e).__name__)
    else:
        # caps.investigate 只在拿到消息 id 时才落行，所以这里理论上不该发生。
        logger.error("progress: row %s has no message_id — cannot patch",
                     incident_id)

    if terminal:
        # 到终态：从游标行里删掉，避免下一轮再拉一遍全量 journal。
        ddb_state.delete_im_task(incident_id)
        logger.info("progress: task %s → %s (deleted row)", task_id, status)
    else:
        # 只写回增量游标 + 已渲染字节
        ddb_state.update_im_task_cursor(incident_id, list(seen_after), rendered)


def handler(event, context) -> dict:
    """EventBridge → 每分钟。事件 payload 无关紧要。"""
    try:
        rows = ddb_state.list_im_tasks(limit=50)
        logger.info("progress: %d in-flight tasks", len(rows))
        for r in rows:
            try:
                _tick_one(r)
            except Exception as e:                # noqa: BLE001
                logger.exception("progress: row failed: %s", type(e).__name__)
    except Exception as e:                        # noqa: BLE001
        logger.exception("progress: swallow %s", type(e).__name__)
    return {"ok": True}
