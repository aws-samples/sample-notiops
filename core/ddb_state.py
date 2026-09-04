"""
DynamoDB conversation state — shared across all chat platforms.

Single table; same business row indexed by multiple lookup_key prefixes:
  event#<event_id>      -- idempotency on platform event id (or message ts)
  incident#<id>         -- key passed to DevOps Agent webhook
                           conventionally `<platform>-<event_id>` so it's
                           globally unique across platforms
  task#<id>             -- fallback when DevOps Agent doesn't echo incident_id
  support#<incident_id> -- written by report-handler with case-creation context
  imtask#<incident_id>  -- IM webhook: one dispatched deep investigation +
                           its journal-poll cursor (`seen_ids`)
  imchat#<plat>:<chat>  -- IM webhook: the DevOps Agent `execution_id` backing
                           a chat's multi-turn direct conversation

Every row carries a `platform` field ("feishu" / "slack") so
the report-handler's sender router can dispatch results back to the right IM.

TTL on `ttl` (epoch seconds) auto-cleans rows after ~24h (events/incidents)
or ~7d (support context — matches presigned report URL expiry).

`event_id` uniqueness: Feishu event_ids are UUIDs; Slack message ts is
"<seconds>.<microseconds>" and unique per workspace. They don't collide
across platforms.
"""
from __future__ import annotations

import logging
import os
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


def _safe_err(e: Exception) -> str:
    """Sensitive-data handling: return the exception *type* (plus the AWS
    error code for botocore ClientError), never the raw message / response body
    which can embed request payloads or user data. See docs/LOGGING_STANDARD.md."""
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__


DEFAULT_TTL_SECONDS = 24 * 3600


class _LazyTable:
    """惰性 DynamoDB Table 代理：import 时不创建 boto3 资源、不读环境变量，
    第一次真正用到（.put_item / .get_item 等）时才初始化并缓存。

    这样在无 AWS region / 无 CONVERSATIONS_TABLE 的环境（如 CI 静态检查、
    单元导入测试）下仅 import 本模块不会触发 NoRegionError / KeyError。"""

    _real = None

    def _resolve(self):
        if self._real is None:
            self._real = boto3.resource("dynamodb").Table(os.environ["CONVERSATIONS_TABLE"])
        return self._real

    def __getattr__(self, name):
        return getattr(self._resolve(), name)


_table = _LazyTable()


def put_new_event(event_id: str, *, platform: str, chat_id: str,
                  root_message_id: str, user_id: str, raw_text: str,
                  locale: str = "") -> bool:
    """Returns False if event_id already exists (platform retried).

    `locale` ("zh" | "en" | "") is the resolved conversation locale at
    intake. Stored on the row so downstream stages (`link_incident` →
    Lambda's report sender → progress poller) inherit it without
    re-resolving."""
    item = {
        "lookup_key": _k_event(event_id),
        "platform": platform,
        "event_id": event_id,
        "chat_id": chat_id,
        "root_message_id": root_message_id,
        "user_id": user_id,
        "raw_text": raw_text,
        "status": "received",
        "ttl": int(time.time()) + DEFAULT_TTL_SECONDS,
    }
    if locale:
        item["locale"] = locale
    try:
        _table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(lookup_key)",
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            logger.info("Duplicate event_id %s — skipping", event_id)
            return False
        raise


def update_intent(event_id: str, intent_summary: str, prompt_message_id: str) -> None:
    _table.update_item(
        Key={"lookup_key": _k_event(event_id)},
        UpdateExpression="SET intent_summary = :i, prompt_message_id = :p, #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":i": intent_summary,
            ":p": prompt_message_id,
            ":s": "awaiting_confirmation",
        },
    )


def get_by_event(event_id: str) -> dict | None:
    return _table.get_item(Key={"lookup_key": _k_event(event_id)}).get("Item")


def get_by_incident(incident_id: str) -> dict | None:
    return _table.get_item(Key={"lookup_key": _k_incident(incident_id)}).get("Item")


def get_by_task(task_id: str) -> dict | None:
    return _table.get_item(Key={"lookup_key": _k_task(task_id)}).get("Item")


def link_incident(event_id: str, incident_id: str, *, platform: str,
                  task_id: str | None = None) -> None:
    src = get_by_event(event_id)
    if not src:
        logger.error("link_incident: source row missing for event_id=%s", event_id)
        return
    base = {
        "platform": platform,
        "event_id": event_id,
        "incident_id": incident_id,
        "chat_id": src["chat_id"],
        "root_message_id": src.get("root_message_id", ""),
        "user_id": src.get("user_id", ""),
        "raw_text": src.get("raw_text", ""),
        "intent_summary": src.get("intent_summary", ""),
        "status": "investigating",
        "ttl": int(time.time()) + DEFAULT_TTL_SECONDS,
    }
    # Carry locale forward so downstream stages (Lambda's slack_sender /
    # feishu_sender, progress poller, next-step generator) can render
    # in the same language without re-resolving.
    if src.get("locale"):
        base["locale"] = src["locale"]
    _table.put_item(Item={**base, "lookup_key": _k_incident(incident_id)})
    if task_id:
        _table.put_item(Item={**base, "lookup_key": _k_task(task_id), "task_id": task_id})
    _table.update_item(
        Key={"lookup_key": _k_event(event_id)},
        UpdateExpression="SET incident_id = :i, #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":i": incident_id, ":s": "dispatched"},
    )


def _k_event(event_id: str) -> str:
    return f"event#{event_id}"


def _k_incident(incident_id: str) -> str:
    return f"incident#{incident_id}"


def _k_task(task_id: str) -> str:
    return f"task#{task_id}"


def _k_inflight(key: str) -> str:
    return f"inflight#{key}"


# ---------------------------------------------------------------------------
# Persistent inflight lock — replaces in-process dicts so duplicate-action
# protection survives process restarts and works across multiple replicas.
#
# Lock lifetime is bounded by the DDB TTL; after expiry the row auto-deletes
# and a retry by the user goes through. Pick the TTL based on the expected
# end-to-end completion time of the operation:
#
#   - case create / reply / resolve / sync   → ~5 min plenty
#   - dispatch (which kicks off agent run)   → ~10 min
#
# The default is 1 hour, matching the prior in-memory _INFLIGHT_TTL.
# ---------------------------------------------------------------------------
INFLIGHT_TTL_SECONDS = 3600


def claim_inflight(key: str, ttl_seconds: int = INFLIGHT_TTL_SECONDS) -> bool:
    """Attempt to claim a one-shot lock for `key`. Returns True iff this
    caller is the first to claim it within the TTL window.

    Implemented as a DDB conditional put: succeeds when no row with the
    inflight key exists, fails (returns False) when one already does.

    On any DDB error (throttling, network) we **fail-open** and return
    True — better to let the user proceed than to deadlock the workflow
    on infrastructure flakes. This matches the pre-persistent semantics:
    duplicate work is recoverable; not running at all is not.

    Pass an empty string to bypass the check (best-effort path); useful
    when callers don't have a good idempotency key handy.
    """
    if not key:
        return True
    try:
        _table.put_item(
            Item={
                "lookup_key": _k_inflight(key),
                "claimed_at": int(time.time()),
                "ttl": int(time.time()) + ttl_seconds,
            },
            ConditionExpression="attribute_not_exists(lookup_key)",
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            logger.info("inflight lock already held: %s", key)
            return False
        # Any other DDB error → fail-open with a loud log so we notice.
        logger.error("claim_inflight DDB error (failing open): %s — %s", key, _safe_err(e))
        return True
    except Exception as e:
        logger.error("claim_inflight unexpected error (failing open): %s — %s", key, _safe_err(e))
        return True


# ---------------------------------------------------------------------------
# Bot-thread membership — tracks IM threads where the bot has already
# responded, so subsequent messages in that thread can be processed
# without requiring a fresh @mention. Cheap O(1) DDB conditional put +
# get on a `botthread#<platform>:<root_id>` key. 24h TTL keeps the
# table small (a thread that's been silent for a day is unlikely to
# need autocomplete @-context anyway).
#
# `platform` segments the namespace so the same root id can't collide
# between feishu/slack and the same key never moves between platforms.
# ---------------------------------------------------------------------------
_BOT_THREAD_TTL_SECONDS = 24 * 3600


def _k_botthread(platform: str, root_id: str) -> str:
    return f"botthread#{platform}:{root_id}"


def mark_bot_thread(platform: str, root_id: str) -> None:
    """Record that the bot has just replied inside the IM thread rooted
    at ``root_id``. Subsequent messages in that thread are then treated
    as conversations with the bot even if the user didn't @-mention
    explicitly. Idempotent + cheap; never raises."""
    if not platform or not root_id:
        return
    try:
        _table.put_item(Item={
            "lookup_key": _k_botthread(platform, root_id),
            "marked_at": int(time.time()),
            "ttl": int(time.time()) + _BOT_THREAD_TTL_SECONDS,
        })
    except Exception as e:
        # Failure here just means thread continuity won't kick in for
        # this thread — not worth raising.
        logger.warning("mark_bot_thread (%s, %s) failed: %s",
                       platform, root_id, _safe_err(e))


def is_bot_thread(platform: str, root_id: str) -> bool:
    """Return True if the bot has been recorded as participating in the
    IM thread rooted at ``root_id`` within the TTL window. False on any
    DDB error so we fall back to the safer "@mention required" path."""
    if not platform or not root_id:
        return False
    try:
        resp = _table.get_item(
            Key={"lookup_key": _k_botthread(platform, root_id)},
            ConsistentRead=False,
        )
    except Exception as e:
        logger.warning("is_bot_thread (%s, %s) DDB error: %s",
                       platform, root_id, _safe_err(e))
        return False
    item = resp.get("Item") or {}
    if not item:
        return False
    # Defensive TTL check: DDB reaper can lag a few hours, so a row may
    # still be readable past its `ttl`. We treat anything past TTL as
    # absent so behaviour matches what the user expects.
    if int(item.get("ttl", 0)) < int(time.time()):
        return False
    return True


def release_inflight(key: str) -> None:
    """Best-effort early release of an inflight lock. Optional — the TTL
    will reap stale rows automatically. Useful only when the worker
    finishes very quickly and the user might want to retry sooner.
    """
    if not key:
        return
    try:
        _table.delete_item(Key={"lookup_key": _k_inflight(key)})
    except Exception as e:
        logger.warning("release_inflight (%s) failed: %s", key, _safe_err(e))


# ---------------------------------------------------------------------------
# Multi-turn conversational session state
# ---------------------------------------------------------------------------
# Used by platforms that lack native modal/view forms (DingTalk Phase 2b)
# to drive multi-step flows like "open a case" through plain text turns.
# Each session is keyed by `(platform, chat_id, user_id, kind)` so two
# concurrent flows from the same user in different chats don't collide.
#
# Generic shape on purpose: the value is an arbitrary dict the caller
# controls. ddb_state never inspects it. TTL defaults to 30 minutes —
# long enough to type a multi-line body, short enough to abandon
# silently if the user wanders off.

_CONVO_SESSION_TTL_SECONDS = 30 * 60


def _k_convo_session(platform: str, chat_id: str, user_id: str,
                      kind: str) -> str:
    return f"convosess#{platform}:{chat_id}:{user_id}:{kind}"


def get_convo_session(platform: str, chat_id: str, user_id: str,
                       kind: str) -> dict | None:
    """Fetch the current session state for a (chat, user, kind) tuple.

    Returns None if no session is active or it has expired (the row's
    own TTL field is checked client-side as well, so we don't surface
    a near-stale state that DDB hasn't yet GC'd)."""
    if not (platform and chat_id and user_id and kind):
        return None
    try:
        resp = _table.get_item(
            Key={"lookup_key": _k_convo_session(platform, chat_id,
                                                  user_id, kind)},
            ConsistentRead=False,
        )
    except Exception as e:
        logger.warning("get_convo_session (%s/%s) failed: %s",
                       chat_id, kind, _safe_err(e))
        return None
    item = resp.get("Item")
    if not item:
        return None
    if int(item.get("ttl", 0)) < int(time.time()):
        return None
    return item.get("data") or {}


def put_convo_session(platform: str, chat_id: str, user_id: str,
                       kind: str, data: dict,
                       ttl_seconds: int = _CONVO_SESSION_TTL_SECONDS) -> None:
    """Upsert the session state. `data` is stored verbatim under the
    `data` attribute. Replaces any prior state for the same key — the
    caller is responsible for read-modify-write semantics if they
    want to merge rather than overwrite."""
    if not (platform and chat_id and user_id and kind):
        return
    try:
        _table.put_item(Item={
            "lookup_key": _k_convo_session(platform, chat_id, user_id, kind),
            "platform": platform,
            "chat_id": chat_id,
            "user_id": user_id,
            "kind": kind,
            "data": data,
            "updated_at": int(time.time()),
            "ttl": int(time.time()) + ttl_seconds,
        })
    except Exception as e:
        logger.warning("put_convo_session (%s/%s) failed: %s",
                       chat_id, kind, _safe_err(e))


def clear_convo_session(platform: str, chat_id: str, user_id: str,
                         kind: str) -> None:
    """Delete the session state — used when the flow completes or the
    user explicitly cancels."""
    if not (platform and chat_id and user_id and kind):
        return
    try:
        _table.delete_item(Key={"lookup_key": _k_convo_session(
            platform, chat_id, user_id, kind)})
    except Exception as e:
        logger.warning("clear_convo_session (%s/%s) failed: %s",
                       chat_id, kind, _safe_err(e))


# ---------------------------------------------------------------------------
# IM webhook state (IM 重构 / M1) —— imtask# + imchat#
# ---------------------------------------------------------------------------
# 同一张表加新前缀，与 `notif#` 一样的做法（不新建表：方式A 的一键 CFN 只有
# notiops-config + notiops-web-chat 两张表，多一张就意味着两条部署路径的表名不一致）。
#
#   imtask#<incident_id>  一次「发起深度调查」的全部上下文 + 进度游标
#   imchat#<chat_id>      一个会话的 DevOps Agent execution_id（多轮上下文）
#
# 为什么把 execution_id 存 DDB 而不是靠模型记忆：IM 不需要 web 那套"合成历史"
# （≈150 token/轮）来"记住"上一轮的 execution_id —— 它确定性地就在这行上。
# 这正是 IM 比 web 直连路径更省的地方（§8.1.1）。

# 进度 Lambda 的轮询窗口。终态会立刻删行；这个 TTL 只是"agent 一直不收敛"时的兜底，
# 与今天 progress_poller 的 30 分钟口径一致。
_IM_TASK_TTL_SECONDS = 30 * 60
# 会话（execution_id）比单次调查活得久：一个群/私聊里连续问答通常横跨几小时。
_IM_CHAT_TTL_SECONDS = 12 * 3600

#: 写在 `incident#` / `task#` 路由行上的"这条调查的实时卡已经有主了"标记。
#: 消费方是 `shared/report_delivery/report_handler.py::_handle_investigation_started`
#: —— 见 `link_im_investigation` 文档里的「`live_card_owner` 是干什么的」。
#: **字符串常量两边共用**：拼错就退化成"又发第二张卡"，而那是静默的。
LIVE_CARD_OWNER_IM_LAMBDA = "im_lambda"


def _k_im_task(incident_id: str) -> str:
    return f"imtask#{incident_id}"


def _k_im_chat(platform: str, chat_id: str) -> str:
    return f"imchat#{platform}:{chat_id}"


def put_im_task(incident_id: str, *, platform: str, chat_id: str,
                message_id: str, locale: str, account_id: str,
                task_id: str, execution_id: str, agent_space_id: str,
                user_id: str = "", title: str = "",
                console_url: str = "", console_home: str = "",
                ttl_seconds: int = _IM_TASK_TTL_SECONDS) -> None:
    """记一次已派发的深度调查，供进度 Lambda 增量轮询 + 回帖。

    `message_id` 是那张「已发起」卡片的 id —— 进度 Lambda 靠它 PATCH 同一张卡片
    （而不是每轮新发一条消息刷屏）。

    `console_url` / `console_home` 也要存：进度 Lambda 是**整卡替换**，不存下来的话
    第一次 PATCH 就把「打开 Operator App」那个链接按钮抹掉了。
    """
    if not incident_id:
        return
    now = int(time.time())
    try:
        _table.put_item(Item={
            "lookup_key": _k_im_task(incident_id),
            "incident_id": incident_id,
            "platform": platform,
            "chat_id": chat_id,
            "message_id": message_id,
            "locale": locale or "",
            "account_id": account_id or "",
            "task_id": task_id or "",
            "execution_id": execution_id or "",
            "agent_space_id": agent_space_id or "",
            "user_id": user_id or "",
            "title": title or "",
            "console_url": console_url or "",
            "console_home": console_home or "",
            "seen_ids": [],       # poll_investigation 的游标（List<S>），见下方 note
            "started_at": now,
            "updated_at": now,
            "ttl": now + ttl_seconds,
        })
    except Exception as e:
        logger.warning("put_im_task (%s) failed: %s", incident_id, _safe_err(e))


def get_im_task(incident_id: str) -> dict | None:
    """取一条调查上下文；None = 不存在 / 已过期（客户端也校验一次 ttl）。"""
    if not incident_id:
        return None
    try:
        resp = _table.get_item(Key={"lookup_key": _k_im_task(incident_id)},
                               ConsistentRead=False)
    except Exception as e:
        logger.warning("get_im_task (%s) failed: %s", incident_id, _safe_err(e))
        return None
    item = resp.get("Item")
    if not item:
        return None
    if int(item.get("ttl", 0)) < int(time.time()):
        return None
    return item


def list_im_tasks(limit: int = 50) -> list[dict]:
    """扫出所有在途调查（进度 Lambda 每分钟一次）。

    ⚠️ 用 Scan 而不是 GSI：在途调查同时最多几条（一个客户的 IM 并发调查量级），
    表里 99% 是别的前缀的行但总量也就几千 —— 加一个 GSI 的成本和运维面比 Scan 大。
    如果哪天真的多到需要索引，那时再加 GSI 并把这里换掉。
    """
    now = int(time.time())
    try:
        resp = _table.scan(
            FilterExpression="begins_with(lookup_key, :p) AND #t > :now",
            ExpressionAttributeNames={"#t": "ttl"},
            ExpressionAttributeValues={":p": "imtask#", ":now": now},
            Limit=1000,
        )
    except Exception as e:
        logger.warning("list_im_tasks failed: %s", _safe_err(e))
        return []
    items = resp.get("Items") or []
    return items[:limit]


def find_im_task_by_task_id(task_id: str) -> dict | None:
    """按 DevOps Agent 的 `task_id` 找在途的 `imtask#` 行；没有则 None。

    用途只有一个：用户问「[[investigation:…]] 现在什么状态 / 帮我监控它的进展」时，
    先看**这条调查是不是已经有一张卡在被每分钟的进度 Lambda 刷**。有 → 只回一张
    快照卡（否则两张卡刷同一次调查，就是 `link_im_investigation` 文档里那种纯噪音）；
    没有（原卡过期/发失败/是 web 端发起的）→ 才把新卡接上去当实时卡。

    ⚠️ 走 `list_im_tasks` 的那次 Scan（在途调查同时最多几条，见那边的说明），不新加
    GSI —— 这条路径每次用户主动问状态才走一次，量级与每分钟一次的进度 Lambda 同级。
    """
    tid = (task_id or "").strip()
    if not tid:
        return None
    for row in list_im_tasks(limit=50):
        if str(row.get("task_id") or "") == tid:
            return row
    return None


def update_im_task_cursor(incident_id: str, seen_ids: list,
                          rendered: str = "") -> None:
    """写回轮询游标（`poll_investigation` 是无状态增量的，游标由调用方持有）。

    `rendered` 是已经贴出去的进度正文，PATCH 卡片时要在它后面接新行 —— 存下来
    进度 Lambda 才不需要重新拉全量 journal。
    """
    if not incident_id:
        return
    try:
        _table.update_item(
            Key={"lookup_key": _k_im_task(incident_id)},
            UpdateExpression=("SET seen_ids = :s, rendered = :r, "
                              "updated_at = :now"),
            ExpressionAttributeValues={
                ":s": list(seen_ids or []),
                ":r": rendered or "",
                ":now": int(time.time()),
            },
        )
    except Exception as e:
        logger.warning("update_im_task_cursor (%s) failed: %s",
                       incident_id, _safe_err(e))


def delete_im_task(incident_id: str) -> None:
    """调查到达终态 → 立刻删行（不等 TTL），进度 Lambda 下一轮就不会再看到它。"""
    if not incident_id:
        return
    try:
        _table.delete_item(Key={"lookup_key": _k_im_task(incident_id)})
    except Exception as e:
        logger.warning("delete_im_task (%s) failed: %s", incident_id, _safe_err(e))


def link_im_investigation(incident_id: str, task_id: str, *, platform: str,
                          chat_id: str, root_message_id: str,
                          locale: str = "", user_id: str = "",
                          raw_text: str = "",
                          ttl_seconds: int = DEFAULT_TTL_SECONDS) -> None:
    """写 `incident#` / `task#` 路由行 —— **最终报告卡靠这两行才知道发回哪个会话**。

    `imtask#` 那行只服务进度 Lambda（每分钟 PATCH 那张卡）。而"调查跑完了、报告落 S3
    了、把摘要卡 + 报告链接发回来"是另一条链路：DevOps Agent 的
    `Investigation Started/Completed` EventBridge 事件 → `notiops-devops-callback`
    → `shared/report_delivery/report_handler.py`。它认的键**只有** `incident#<id>`
    和 `task#<task_id>`（`_resolve_chat_target`），两行都没有就只在日志里留一句
    ``no chat target … report stored but not delivered`` —— 报告确实生成了、也确实
    传上了 S3，但用户什么都收不到。2026-09-02 现网就是这个形态（webhook 重构后
    `caps.investigate` 只落了 `imtask#`）。

    ⚠️ 为什么必须落 `task#`（而不是只落 `incident#`）：`start_investigation` 不把
    incident_id 塞进 description，所以回调侧 mine journal 也恢复不出我们这个合成的
    `<platform>-<event_id>`，`incident_id` 恒为空。真正能命中的是 `task#<task_id>`。
    `incident#` 那行仍然写：它是 `_persist_support_context` / locale 查找的键。

    与 `link_incident()` 的区别：那个要求先有一行 `event#`（Fargate 长连接时代由
    `put_event` 写），webhook 路径上没有那一行，所以这里直接落最终形态。

    ── `live_card_owner` 是干什么的（2026-09-02 现网踩，别删）─────────────────────
    这两行一落，回调侧 `_resolve_chat_target` 就**能命中**了 —— 于是 Fargate 时代的
    `Investigation Created` 分支（`_handle_investigation_started` →
    `send_live_console_link`）也活了，会**再发一张**「调查已开始」卡：用户一条 `/调查`
    看到两张卡。而第二张卡的驱动数据是 `progress#` 行，读它的**只有** Fargate 那个常驻
    `core/progress_poller.py`（`platforms/common/lambda_progress.py` 只扫 `imtask#`）：
      · 2026-09-02（`BotStack` 的飞书服务当时 desired 1 / running 1）第二张卡是真的在动
        —— 两张会各自刷同一次调查的进度，纯噪音；
      · M2 撤掉 Fargate（2026-09-03）之后就没人刷它了，第二张卡会定格在「调查已开始」
        不动也不收尾 —— 这就是现在的形态。
    两种形态都不该给用户看，所以这里显式声明"这条调查的实时卡已经有主了"，回调侧据此
    跳过发第二张卡。
    ⚠️ 别改成"按平台判断"、也别去删回调侧那条 Created 分支：`infra/lib/bot-stack.ts`
    还留在仓库里当长连接回滚路径，那条路径回来时那张卡是它**唯一**的实时进度。
    """
    if not (chat_id and (incident_id or task_id)):
        return
    base = {
        "platform": platform,
        "live_card_owner": LIVE_CARD_OWNER_IM_LAMBDA,
        "incident_id": incident_id or "",
        "chat_id": chat_id,
        "root_message_id": root_message_id or "",
        "user_id": user_id or "",
        "raw_text": raw_text or "",
        "intent_summary": "",
        "status": "investigating",
        "ttl": int(time.time()) + ttl_seconds,
    }
    if locale:
        base["locale"] = locale
    try:
        if incident_id:
            _table.put_item(Item={**base,
                                  "lookup_key": _k_incident(incident_id)})
        if task_id:
            _table.put_item(Item={**base, "lookup_key": _k_task(task_id),
                                  "task_id": task_id})
    except Exception as e:
        logger.warning("link_im_investigation (%s/%s) failed: %s",
                       incident_id, task_id, _safe_err(e))


def get_im_chat_session(platform: str, chat_id: str) -> dict | None:
    """取该会话的 DevOps Agent 直连会话状态（execution_id + space + account）。"""
    if not (platform and chat_id):
        return None
    try:
        resp = _table.get_item(Key={"lookup_key": _k_im_chat(platform, chat_id)},
                               ConsistentRead=False)
    except Exception as e:
        logger.warning("get_im_chat_session (%s) failed: %s", chat_id, _safe_err(e))
        return None
    item = resp.get("Item")
    if not item:
        return None
    if int(item.get("ttl", 0)) < int(time.time()):
        return None
    return {
        "execution_id": str(item.get("execution_id") or ""),
        "agent_space_id": str(item.get("agent_space_id") or ""),
        "account_id": str(item.get("account_id") or ""),
    }


def put_im_chat_session(platform: str, chat_id: str, session: dict,
                        ttl_seconds: int = _IM_CHAT_TTL_SECONDS) -> None:
    """落库该会话的 execution_id。空 execution_id 视为"没会话可存"，直接跳过。

    ⚠️ 群会话的归属口径：**一个 chat 一个会话**（不按用户拆）。群里本来就是大家一起看
    同一个排查过程，按用户拆会让 A 问的上下文对 B 不可见，反直觉。见 §15。
    """
    if not (platform and chat_id):
        return
    exid = str((session or {}).get("execution_id") or "")
    if not exid:
        return
    now = int(time.time())
    try:
        _table.put_item(Item={
            "lookup_key": _k_im_chat(platform, chat_id),
            "platform": platform,
            "chat_id": chat_id,
            "execution_id": exid,
            "agent_space_id": str((session or {}).get("agent_space_id") or ""),
            "account_id": str((session or {}).get("account_id") or ""),
            "updated_at": now,
            "ttl": now + ttl_seconds,
        })
    except Exception as e:
        logger.warning("put_im_chat_session (%s) failed: %s", chat_id, _safe_err(e))


def clear_im_chat_session(platform: str, chat_id: str) -> None:
    """显式清会话（`/new` 之类）。"""
    if not (platform and chat_id):
        return
    try:
        _table.delete_item(Key={"lookup_key": _k_im_chat(platform, chat_id)})
    except Exception as e:
        logger.warning("clear_im_chat_session (%s) failed: %s",
                       chat_id, _safe_err(e))


# ---------------------------------------------------------------------------
# 一个会话同时只跑一个问题 —— imlease#（2026-09-02 线上）
# ---------------------------------------------------------------------------
# 修的是什么：DevOps Agent 的多轮上下文是**一个 chat 一个 `execution_id`**（见上面
# `put_im_chat_session`）。同一个会话里在第一个问题还没答完时再问一个，两次 worker 调用
# 会拿着**同一个** execution_id 并发打到同一个 agent 上，现网实测的结果是：
#   · 第二个问题把第一个饿死（一轮跑了 318 秒然后 upstream `connection_error`）；
#   · 两张「思考中」卡片同时在动，用户不知道哪张是自己刚问的；
#   · `put_im_chat_session` 是 `put_item`（后写覆盖前写），会话状态看运气。
# 所以按 chat 串行化：拿到租约的那次正常跑，没拿到的**立刻告知并排队等**
# （见 `platforms/common/chat_lease.py` —— 直接拒绝会让用户以为 bot 掉了消息）。
#
# 为什么是**单独一行**而不是往 `imchat#` 上加字段：`put_im_chat_session` 是整行
# `put_item`，落会话状态时会把同一行上的租约字段一起抹掉。两件事生命周期也不同
# （会话 12 小时，租约几分钟）。
#
# 为什么条件里要自己比 `ttl` 而不是靠 DDB 的 TTL 清理：TTL 删除是**尽力而为**，官方
# 口径是 48 小时内。worker 被 Lambda 超时杀掉（或 OOM）时不会走到 release，如果只靠
# TTL 清理，这个会话最坏会被一条死租约堵**两天**。

#: 租约兜底时长。取 worker Lambda 的 timeout（900s）—— 真实值由调用方按
#: `context.get_remaining_time_in_millis()` 算（见 `platforms/common/lambda_deadline.py`）。
_IM_CHAT_LEASE_TTL_SECONDS = 900


def _k_im_chat_lease(platform: str, chat_id: str) -> str:
    return f"imlease#{platform}:{chat_id}"


def acquire_im_chat_lease(platform: str, chat_id: str, *, owner: str,
                          ttl_seconds: int = _IM_CHAT_LEASE_TTL_SECONDS) -> bool:
    """抢下"这个会话现在归我跑"的租约。True = 抢到了（调用方必须 `finally` 里 release）。

    条件写：没有行、或者行上的 `ttl` 已经过去（上一个持有者死了）时才写得进去。

    ⚠️ **DDB 出错时 fail-open 返回 True**（与 `claim_inflight` 同口径）：并发跑两个问题
    是可恢复的降级，"因为 DDB 抖了一下就不回答用户"不是。这条 error 日志是唯一线索。
    """
    if not (platform and chat_id and owner):
        return True
    now = int(time.time())
    try:
        _table.put_item(
            Item={
                "lookup_key": _k_im_chat_lease(platform, chat_id),
                "platform": platform,
                "chat_id": chat_id,
                "owner": owner,
                "acquired_at": now,
                "ttl": now + max(1, int(ttl_seconds)),
            },
            ConditionExpression=(
                "attribute_not_exists(lookup_key) OR #t < :now"),
            ExpressionAttributeNames={"#t": "ttl"},
            ExpressionAttributeValues={":now": now},
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        logger.error("acquire_im_chat_lease DDB error (failing open): %s — %s",
                     chat_id, _safe_err(e))
        return True
    except Exception as e:                        # noqa: BLE001
        logger.error("acquire_im_chat_lease unexpected error (failing open): "
                     "%s — %s", chat_id, _safe_err(e))
        return True


def release_im_chat_lease(platform: str, chat_id: str, *, owner: str) -> None:
    """放掉租约。**只删自己那把** —— 条件是 `owner` 相等。

    为什么要带条件：一次超时的 worker 可能在租约过期、后面的人已经接手之后才走到这里
    （Lambda 超时不保证代码停在哪儿）。无条件 delete 会把**别人**正在用的租约删掉，
    于是又回到两个问题并发的原状。
    """
    if not (platform and chat_id and owner):
        return
    try:
        _table.delete_item(
            Key={"lookup_key": _k_im_chat_lease(platform, chat_id)},
            ConditionExpression="#o = :o",
            ExpressionAttributeNames={"#o": "owner"},
            ExpressionAttributeValues={":o": owner},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            # 租约已经过期并被别人接手了 —— 正常，不是错误。
            logger.info("release_im_chat_lease (%s): not ours any more", chat_id)
            return
        logger.warning("release_im_chat_lease (%s) failed: %s",
                       chat_id, _safe_err(e))
    except Exception as e:                        # noqa: BLE001
        logger.warning("release_im_chat_lease (%s) failed: %s",
                       chat_id, _safe_err(e))


def get_im_chat_lease(platform: str, chat_id: str) -> dict | None:
    """当前租约（None = 没人持有 / 已过期）。只给排查和单测用 —— 抢租约靠上面那个
    条件写，**不要**先 get 再 put（那中间就是竞态窗口）。"""
    if not (platform and chat_id):
        return None
    try:
        resp = _table.get_item(
            Key={"lookup_key": _k_im_chat_lease(platform, chat_id)},
            ConsistentRead=True)
    except Exception as e:                        # noqa: BLE001
        logger.warning("get_im_chat_lease (%s) failed: %s", chat_id, _safe_err(e))
        return None
    item = resp.get("Item")
    if not item:
        return None
    if int(item.get("ttl", 0)) < int(time.time()):
        return None
    return {"owner": str(item.get("owner") or ""),
            "acquired_at": int(item.get("acquired_at", 0)),
            "ttl": int(item.get("ttl", 0))}
