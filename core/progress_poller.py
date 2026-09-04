"""
Progress poller — keeps the "Investigation In Progress" card alive while
DevOps Agent is working, by periodically fetching journal records and
updating the card with recent tool calls + an LLM narrative.

Architecture (option Z):
  - report-handler Lambda receives `Investigation In Progress`, posts the
    initial card, and writes a `progress#<incident_id>` row to DDB
    containing the platform, message_ref, agent_space_id, execution_id.
  - Each platform's ECS task starts a SINGLE daemon thread on boot:
        progress_poller.run(platform="<slug>", sender=<callable>)
    The thread scans `progress#*` rows for its own platform every 10s.
    For each row, if 20s elapsed since `last_polled_at`, it fetches the
    latest journal records, builds a ProgressCardIR, and calls the
    sender's update_live_card(message_ref, ir).
  - When `Investigation Completed/Failed` arrives, report-handler deletes
    the row. The thread's next scan won't see it → updates stop.

Failure handling:
  - DDB row TTL = 30 minutes. Worst case if both report-handler and the
    poller miss the Completed event, the row reaps itself and updates
    stop. The original card stays in the chat with its last-known
    progress state — harmless.
  - Any tick error is logged + swallowed; the next tick tries again.
  - The thread is a daemon, so process shutdown is clean.

Sender contract (passed in by the platform's main.py):
  send_callable(message_ref: dict, ir: ProgressCardIR) -> None
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Callable

import boto3
from boto3.dynamodb.conditions import Attr

from . import bedrock_credentials as _bedrock_credentials
from . import ddb_state
from . import progress_card
from .progress_card import ProgressCardIR

logger = logging.getLogger(__name__)

# 10s scan cadence keeps DDB load tiny while feeling snappy. Per-row
# update cadence is gated by `MIN_UPDATE_INTERVAL` (default 20s) so we
# don't pummel platform APIs.
SCAN_INTERVAL_SECONDS = int(os.environ.get("PROGRESS_SCAN_INTERVAL", "10"))
MIN_UPDATE_INTERVAL = int(os.environ.get("PROGRESS_UPDATE_INTERVAL", "20"))
# Defensive ceiling — even if Completed/Failed never fires, stop
# updating after this long. The DDB TTL also handles cleanup.
MAX_RUNTIME_SECONDS = int(os.environ.get("PROGRESS_MAX_RUNTIME", "1500"))  # 25 min
# Bedrock summary cadence: tick #1, #5, #9, ... — 1 + every 4 thereafter.
BEDROCK_SUMMARY_EVERY_N_TICKS = 4

DEVOPS_AGENT_REGION = os.environ.get("DEVOPS_AGENT_REGION", "us-east-1")
_aidevops = boto3.client("devops-agent", region_name=DEVOPS_AGENT_REGION)


def _call_card(card_fn, message_ref: dict, ir, locale: str) -> None:
    """Call an update_live_card / finalize_card callable with locale,
    falling back to a 2-arg call for older senders that don't yet
    accept the locale kwarg. Lets us roll out the bot ECS tasks and
    Lambda update separately without lockstep coordination."""
    try:
        card_fn(message_ref, ir, locale)
        return
    except TypeError:
        pass
    card_fn(message_ref, ir)


def run(platform: str,
        update_live_card: Callable[[dict, ProgressCardIR], None],
        finalize_card: Callable[[dict, ProgressCardIR], None] | None = None,
        ) -> None:
    """Start the daemon thread that polls progress rows for this platform.

    `update_live_card`: platform-specific updater that translates the IR
        into a card and patches the existing message identified by
        message_ref. Called every ~20s while the row exists.
    `finalize_card`:    optional callable invoked once after the row
        disappears (Completed/Failed) — gives the platform a chance to
        replace the card text with "已完成 — 报告见下方". When omitted,
        the last live card just stays as-is.
    """
    if not platform:
        return

    def _loop() -> None:
        logger.info("progress_poller: started for platform=%s", platform)
        # Track which incidents we've seen this run so we can detect
        # disappearance (= investigation finished) and call finalize_card.
        seen: dict[str, dict] = {}
        # Incidents we've already finalized this run — don't fire
        # finalize_card twice for the same row (e.g. row keeps lingering
        # at status=completed for up to 30 min before TTL reaps it).
        finalized_ids: set[str] = set()

        while True:
            try:
                # Bedrock API Key 热生效：这个 daemon 线程独立于消息入口，
                # 自己也调 Bedrock（进度叙述），所以必须自行收敛凭证变更。Key 未变时是
                # 廉价 no-op；变了则重建缓存的 bedrock 客户端。
                _bedrock_credentials.refresh()
                rows = _scan_progress_rows(platform)
                # Build the set of currently-active incidents so we can
                # diff against `seen` and finalize the ones that vanished.
                active_ids = set()
                for row in rows:
                    incident_id = row.get("incident_id", "")
                    if not incident_id:
                        continue
                    active_ids.add(incident_id)
                    seen[incident_id] = row

                    # Locale on the row was written by report-handler at
                    # progress# row creation. Falls back to "en" if absent
                    # (older incidents pre-dating multi-locale).
                    row_locale = (row.get("locale") or "en").lower()
                    if row_locale not in {"zh", "en"}:
                        row_locale = "en"

                    # PRIMARY finalize signal — row carries status=completed
                    # / failed (written by report-handler when the
                    # investigation finishes). This survives ECS task
                    # replacements, because the row stays in DDB with TTL
                    # = 30 min after status flips. A poller in any task
                    # (old, new, freshly deployed) can pick it up.
                    status = (row.get("status") or "").lower()
                    if status in {"completed", "failed"}:
                        if (incident_id not in finalized_ids
                                and finalize_card):
                            try:
                                ir = _build_final_ir(row, status=status)
                                _call_card(finalize_card,
                                           row.get("message_ref") or {},
                                           ir, row_locale)
                                finalized_ids.add(incident_id)
                                logger.info(
                                    "progress_poller: finalized "
                                    "incident=%s via status=%s locale=%s",
                                    incident_id, status, row_locale)
                            except Exception as e:
                                logger.exception(
                                    "progress_poller: finalize via status "
                                    "failed: %s", e)
                        # Don't tick — investigation is over.
                        continue

                    # Only tick this row if enough time has elapsed since
                    # the last poll for it.
                    last_polled = int(row.get("last_polled_at") or 0)
                    if time.time() - last_polled < MIN_UPDATE_INTERVAL:
                        continue
                    try:
                        _tick_one(row, update_live_card, row_locale)
                    except Exception as e:
                        logger.exception(
                            "progress_poller: tick failed for incident=%s: %s",
                            incident_id, e)

                # SECONDARY finalize signal — row literally vanished from
                # DDB without going through status=completed. Possible if
                # an old report-handler still calls delete_item, or TTL
                # reaped a stuck row. Either way, the user deserves a
                # closing card. Skip rows we already finalized via status.
                vanished = (set(seen) - active_ids) - finalized_ids
                for incident_id in vanished:
                    row = seen.pop(incident_id)
                    if finalize_card:
                        try:
                            ir = _build_final_ir(row)
                            row_locale = (row.get("locale") or "en").lower()
                            if row_locale not in {"zh", "en"}:
                                row_locale = "en"
                            _call_card(finalize_card,
                                       row.get("message_ref") or {},
                                       ir, row_locale)
                            finalized_ids.add(incident_id)
                        except Exception as e:
                            logger.exception(
                                "progress_poller: finalize failed: %s", e)
            except Exception as e:
                logger.exception("progress_poller: scan error: %s", e)

            time.sleep(SCAN_INTERVAL_SECONDS)

    t = threading.Thread(target=_loop, name=f"progress_poller-{platform}",
                         daemon=True)
    t.start()


# ---------------------------------------------------------------------------
# Per-tick logic
# ---------------------------------------------------------------------------
def _tick_one(row: dict,
              update_live_card: Callable[[dict, ProgressCardIR], None],
              locale: str = "en") -> None:
    """Fetch the latest journal records for one investigation, build an
    IR, and call the platform updater."""
    incident_id = row["incident_id"]
    started_at = int(row.get("started_at") or time.time())
    elapsed = int(time.time()) - started_at
    if elapsed > MAX_RUNTIME_SECONDS:
        logger.info("progress_poller: %s exceeded MAX_RUNTIME, stopping updates",
                    incident_id)
        return

    agent_space_id = row.get("agent_space_id", "")
    execution_id = row.get("execution_id", "")
    if not agent_space_id or not execution_id:
        return

    # Pull ALL recent records, not just tool_use — different agent
    # versions emit different recordType values. We log the type
    # distribution on first tick so we know what's actually there, then
    # filter by tool_use client-side.
    all_records = _list_records(agent_space_id, execution_id)
    type_counts: dict = {}
    for r in all_records:
        rt = r.get("recordType", "<missing>")
        type_counts[rt] = type_counts.get(rt, 0) + 1
    # `extract_recent_tools` reads tools from the latest `utilization`
    # record's `content.data.tools[]` — pass through all records so it
    # can find them. (Older agent versions used per-call `tool_use`
    # records; current Operator Agent uses cumulative utilization
    # snapshots only, so filtering to tool_use here drops everything.)
    tool_records = [r for r in all_records if r.get("recordType") == "tool_use"]
    tick_num = int(row.get("tick_count") or 0) + 1
    logger.info("progress tick: incident=%s tick=%d elapsed=%ds "
                "all_records=%d tool_use=%d type_counts=%s",
                incident_id, tick_num, elapsed,
                len(all_records), len(tool_records), type_counts)
    if all_records and tick_num <= 2:
        # Log the first record so we can verify the field shape we're parsing.
        try:
            import json as _j
            sample = all_records[0]
            logger.info("progress tick: first record sample (type=%s) = %s",
                        sample.get("recordType"),
                        _j.dumps({k: (v if not isinstance(v, str) else v[:500])
                                  for k, v in sample.items()}, default=str)[:1500])
        except Exception:
            pass
    recent_tools = progress_card.extract_recent_tools(all_records, limit=5)
    # Per-step tool calls with args (newest first) — falls back to empty
    # when records don't include per-step tool_use blocks. We prefer this
    # for the Bedrock summary so the narrative can name what was queried.
    recent_tool_calls = progress_card.extract_recent_tool_calls(
        all_records, limit=5)
    latest_thinking = progress_card.extract_latest_thinking(all_records)
    # Operator Agent thinks in English by default; translate to zh-CN so
    # users in Feishu/Slack groups see a uniform Chinese "💭 当前思路".
    # Translation is cached per-snippet, so consecutive ticks on the
    # same thinking only pay Bedrock once. Failure is silent — caller
    # falls back to the original English.
    if latest_thinking:
        latest_thinking = progress_card.translate_thinking_zh(latest_thinking)
    logger.info("progress tick: extracted %d recent_tools, %d tool_calls, "
                "thinking=%s",
                len(recent_tools), len(recent_tool_calls),
                "yes" if latest_thinking else "no")

    tick_count = int(row.get("tick_count") or 0) + 1
    summary_md = row.get("last_summary_md") or ""
    # Bedrock narrative: tick 1, 5, 9, …  (1 + every 4 thereafter)
    if tick_count == 1 or (tick_count - 1) % BEDROCK_SUMMARY_EVERY_N_TICKS == 0:
        narrative = progress_card.summarize_progress(
            intent_summary=row.get("intent_summary", ""),
            recent_tools=recent_tools,
            elapsed_seconds=elapsed,
            latest_thinking=latest_thinking,
            recent_tool_calls=recent_tool_calls,
        )
        if narrative:
            summary_md = narrative

    # Prefer the per-step list (with args) for the live card display —
    # it's much more informative than `use_aws ×8`. Fall back to the
    # cumulative count when no per-step blocks are available yet
    # (typically the first ~30s of an investigation).
    display_tools = recent_tool_calls if recent_tool_calls else recent_tools

    ir = ProgressCardIR(
        incident_id=incident_id,
        elapsed_seconds=elapsed,
        deep_link=row.get("deep_link", ""),
        operator_home_url=row.get("operator_home_url", ""),
        intent_summary=row.get("intent_summary", ""),
        summary_md=summary_md,
        recent_tools=display_tools,
        latest_thinking=latest_thinking,
    )

    _call_card(update_live_card, row.get("message_ref") or {}, ir, locale)

    # Persist the new tick state. We don't conditional-write because the
    # only writer here is this thread; report-handler won't touch
    # last_polled_at / tick_count / last_summary_md.
    try:
        ddb_state._table.update_item(
            Key={"lookup_key": f"progress#{incident_id}"},
            UpdateExpression=("SET last_polled_at = :ts, "
                              "tick_count = :tc, "
                              "last_summary_md = :sm"),
            ExpressionAttributeValues={
                ":ts": int(time.time()),
                ":tc": tick_count,
                ":sm": summary_md or "",
            },
        )
    except Exception as e:
        logger.warning("progress_poller: persist tick state failed: %s", e)


def _build_final_ir(row: dict,
                    status: str = "completed") -> ProgressCardIR:
    """IR for the final update. Marks is_final so the sender renders
    `✅ 调查已完成` (or `⚠️ 调查失败` if status=='failed'). Elapsed
    time is computed from `finalized_at` if present (set by report-
    handler), else now — the latter only happens on the legacy
    vanished-row finalize path."""
    started_at = int(row.get("started_at") or time.time())
    finalized_at = int(row.get("finalized_at") or time.time())
    return ProgressCardIR(
        incident_id=row.get("incident_id", ""),
        elapsed_seconds=finalized_at - started_at,
        deep_link=row.get("deep_link", ""),
        operator_home_url=row.get("operator_home_url", ""),
        intent_summary=row.get("intent_summary", ""),
        summary_md=row.get("last_summary_md") or "",
        recent_tools=[],
        is_final=True,
        is_failed=(status == "failed"),
    )


# ---------------------------------------------------------------------------
# DDB scan
# ---------------------------------------------------------------------------
def _scan_progress_rows(platform: str) -> list[dict]:
    """Scan the conversations table for `progress#*` rows belonging to
    this platform. Volume is small (a handful of in-flight investigations
    at most), so a filtered scan is cheap."""
    try:
        resp = ddb_state._table.scan(
            FilterExpression=(Attr("lookup_key").begins_with("progress#")
                              & Attr("platform").eq(platform)),
            ConsistentRead=False,
        )
        items = resp.get("Items", [])
        # Handle pagination (rare for this small set, but defensive).
        while "LastEvaluatedKey" in resp:
            resp = ddb_state._table.scan(
                FilterExpression=(Attr("lookup_key").begins_with("progress#")
                                  & Attr("platform").eq(platform)),
                ExclusiveStartKey=resp["LastEvaluatedKey"],
                ConsistentRead=False,
            )
            items.extend(resp.get("Items", []))
        return items
    except Exception as e:
        logger.warning("progress_poller scan failed: %s", e)
        return []


def _list_records(agent_space_id: str, execution_id: str,
                  record_type: str | None = None) -> list[dict]:
    """Paginated wrapper for aidevops:ListJournalRecords. Same shape as
    the report-handler's helper but lives in core for ECS-side reuse."""
    out: list[dict] = []
    params = {"agentSpaceId": agent_space_id, "executionId": execution_id,
              "limit": 100, "order": "DESC"}
    if record_type:
        params["recordType"] = record_type
    while True:
        resp = _aidevops.list_journal_records(**params)
        out.extend(resp.get("records", []))
        token = resp.get("nextToken")
        if not token or len(out) >= 50:
            break
        params["nextToken"] = token
    return out
