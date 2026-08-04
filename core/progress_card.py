"""
Progress card intermediate representation + helpers.

The polling loop fetches DevOps Agent journal records, then builds a
`ProgressCardIR` — a platform-agnostic dataclass describing what to
display. Each platform's sender renders the IR in its own format (Feishu
v2 card / Slack Block Kit / etc.).

Two helpers in this module:
  - extract_recent_tools(records, limit=5)
        Pulls de-duped tool calls from `tool_use` journal records.
  - summarize_progress(intent_summary, recent_tools, full_records, ...)
        Optional Bedrock narrative — called only on the 1st tick and
        every 4th tick after that to control cost.
"""
from __future__ import annotations

import json as _json
import logging
import os
from dataclasses import dataclass, field

import boto3

from shared.model_config import get_bot_model_id

logger = logging.getLogger(__name__)

BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")

_bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)


@dataclass
class ProgressCardIR:
    """Platform-agnostic representation of a progress card.

    Each platform's `update_live_card(message_ref, ir)` translates this
    into its own card schema. New platforms only need to handle these
    fields — they shouldn't grow without checking with all platforms.
    """
    incident_id: str
    elapsed_seconds: int
    deep_link: str                      # operator-app investigation deep link
    operator_home_url: str              # operator-app home URL
    intent_summary: str = ""            # user-facing question / what's being investigated
    summary_md: str = ""                # Bedrock narrative (may be empty)
    recent_tools: list[str] = field(default_factory=list)
    latest_thinking: str = ""           # newest thinking snippet (≤120 chars), '' if none
    is_final: bool = False              # True on the last update post-Completed
    is_failed: bool = False              # True when investigation failed/timed out


def extract_recent_tools(records: list[dict], limit: int = 5) -> list[str]:
    """Pull the latest tool-use snapshot from journal records.

    DevOps Agent doesn't emit per-call `tool_use` records — instead it
    periodically emits `utilization` records whose content carries a
    cumulative `data.tools[]` list shaped like:

        [{"name": "use_aws", "tool_use_count": 3, "utilization": 0.4}, ...]

    We pick the **newest** utilization record (it's a running cumulative
    snapshot, so newest = "what's happened so far") and render each tool
    as `<name> ×<count>` for the live card. `limit` caps the list length;
    we keep the highest-count tools first so users see the most-used
    ones at a glance.
    """
    if not records:
        return []
    # Find the newest utilization record. They're cumulative — older
    # snapshots are subsumed by later ones, so we just take the latest.
    # `createdAt` is sometimes a datetime (from boto3 unmarshal) and
    # sometimes a string (from cached/serialized rows); cast to str
    # before comparing so we don't TypeError when ts is datetime and
    # latest_ts is "".
    latest = None
    latest_ts = ""
    for r in records:
        if r.get("recordType") != "utilization":
            continue
        ts = str(r.get("createdAt") or r.get("timestamp") or "")
        if ts >= latest_ts:
            latest_ts = ts
            latest = r
    if not latest:
        return []

    content = latest.get("content")
    if isinstance(content, str):
        try:
            content = _json.loads(content)
        except (_json.JSONDecodeError, TypeError):
            return []
    if not isinstance(content, dict):
        return []

    tools = (content.get("data") or {}).get("tools") or []
    if not isinstance(tools, list):
        return []

    # Sort by tool_use_count desc — most-active tools first.
    tools_sorted = sorted(
        tools,
        key=lambda t: int(t.get("tool_use_count") or 0) if isinstance(t, dict) else 0,
        reverse=True,
    )
    out: list[str] = []
    for t in tools_sorted[:limit]:
        if not isinstance(t, dict):
            continue
        name = (t.get("name") or "").strip()
        if not name:
            continue
        count = int(t.get("tool_use_count") or 0)
        if count <= 0:
            # Tool was discovered but never called yet — skip to avoid
            # noise on the card.
            continue
        out.append(f"`{name}` ×{count}")
    return out


def _iter_record_blocks(records: list[dict]):
    """Yield (record_ts, block_dict) for every Anthropic-style content
    block carried inside the journal records, in record order.

    Operator Agent journal records have shape::

        {recordType: "...", createdAt: "...", content: '{...}' or {...}}

    The `content` field, once parsed, looks like::

        {"role": "assistant", "content": [{"type": "thinking", "thinking": "..."},
                                           {"type": "tool_use",  "tool_name": "...",
                                            "input": {...}},
                                           {"type": "text",      "text": "..."},
                                           {"type": "tool_result", ...}]}

    `extract_recent_tools` reads the `utilization` recordType (cumulative
    snapshots without args). The functions below want the per-step blocks
    instead, so we walk every record.
    """
    for r in records:
        ts = r.get("createdAt") or r.get("timestamp") or ""
        content = r.get("content")
        if isinstance(content, str):
            try:
                content = _json.loads(content)
            except (_json.JSONDecodeError, TypeError):
                continue
        if not isinstance(content, dict):
            continue
        inner = content.get("content")
        if isinstance(inner, str):
            try:
                inner = _json.loads(inner)
            except (_json.JSONDecodeError, TypeError):
                continue
        if not isinstance(inner, list):
            continue
        for block in inner:
            if isinstance(block, dict):
                yield ts, block


def extract_latest_thinking(records: list[dict], max_chars: int = 120) -> str:
    """Pull the most recent `thinking` block's first sentence (or up to
    `max_chars`). Returns '' if none found. Intended to surface
    'agent 当前在想什么' on the live card.

    We walk records in order and keep the latest non-empty thinking text.
    Thinking blocks can be long; we shorten to the first sentence-ending
    punctuation or hard-cap at `max_chars` to keep the card readable.
    """
    latest = ""
    latest_ts = ""
    for ts, block in _iter_record_blocks(records):
        if block.get("type") != "thinking":
            continue
        text = (block.get("thinking") or "").strip()
        if not text:
            continue
        ts_s = str(ts)
        if ts_s >= latest_ts:
            latest_ts = ts_s
            latest = text
    if not latest:
        return ""
    # Trim to first sentence end if shorter than max_chars; otherwise
    # hard-cap. Sentence enders cover both Chinese and English.
    for i, ch in enumerate(latest):
        if ch in "。!?.!?\n" and 16 <= i <= max_chars:
            return latest[: i + 1].strip()
    if len(latest) > max_chars:
        return latest[:max_chars].rstrip() + "…"
    return latest


# Cache translation results so we don't pay Haiku per tick when the
# thinking text hasn't changed across consecutive polls. Bounded with a
# tiny LRU since each progress incident only generates a handful of
# distinct thinking snippets over its lifetime.
_THINKING_TRANSLATE_CACHE: dict[str, str] = {}
_THINKING_TRANSLATE_CACHE_MAX = 256


_TRANSLATE_SYSTEM_PROMPT = (
    "你是一个翻译助手。你会收到一段 AWS DevOps Agent 的英文 thinking 片段,"
    "请把它翻译成自然的简体中文,要求:\n"
    "  - 保留专有名词原文(AWS / EC2 / S3 / IAM / Region / instance-id 等服务名、"
    "资源 ID、region 代码 / IAD / NRT 等 region 缩写、命令名、字段名)\n"
    "  - 保留代码段、路径、ARN 原文\n"
    "  - 翻译要简洁,不要解释或加内容,直接输出翻译结果\n"
    "  - 如果输入已经是中文,原样返回\n"
    "  - 不要 markdown 格式,不要前缀(例:不要写 '翻译:'),只输出译文"
)


def _looks_chinese(text: str) -> bool:
    """Quick heuristic: is the text already mostly Chinese? If yes, skip
    Bedrock entirely. Counts CJK Unified Ideographs (U+4E00–U+9FFF) and
    flags as Chinese when ≥ 30% of characters fall in that range —
    enough to catch fully-Chinese inputs while letting bilingual
    thinking ('Looking at i-0123 看下安全组') still get translated."""
    if not text:
        return False
    han = sum(1 for c in text if "一" <= c <= "鿿")
    return han * 10 >= len(text) * 3  # ≥30% Han chars


def translate_thinking_zh(text: str) -> str:
    """Translate an English thinking snippet to Simplified Chinese.

    Returns the original on any failure (empty input, already Chinese,
    Bedrock error/timeout) so the caller can transparently fall back —
    a missing translation is strictly less bad than a missing thinking
    section.
    """
    if not text or len(text) < 4:
        return text
    if _looks_chinese(text):
        return text
    cached = _THINKING_TRANSLATE_CACHE.get(text)
    if cached is not None:
        return cached
    try:
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 200,
            "system": _TRANSLATE_SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": text}],
        }
        resp = _bedrock.invoke_model(
            modelId=get_bot_model_id(),
            contentType="application/json",
            accept="application/json",
            body=_json.dumps(body),
        )
        data = _json.loads(resp["body"].read())
        translated = ""
        for block in data.get("content", []):
            if block.get("type") == "text":
                translated = (block.get("text") or "").strip()
                break
        if not translated:
            return text
        # Bound the cache to avoid unbounded growth across long-running
        # ECS tasks. Simple FIFO eviction — the cache is small enough
        # that LRU vs FIFO is not measurable.
        if len(_THINKING_TRANSLATE_CACHE) >= _THINKING_TRANSLATE_CACHE_MAX:
            try:
                _THINKING_TRANSLATE_CACHE.pop(
                    next(iter(_THINKING_TRANSLATE_CACHE)))
            except StopIteration:
                pass
        _THINKING_TRANSLATE_CACHE[text] = translated
        return translated
    except Exception as e:
        logger.warning("translate_thinking_zh failed: %s", e)
        return text


def extract_recent_tool_calls(records: list[dict],
                              limit: int = 5) -> list[str]:
    """Walk per-step `tool_use` blocks and render the most recent `limit`
    as `name · key=value · key=value` strings (newest first).

    Falls back to plain `name` when the input has no interesting fields.
    Different from `extract_recent_tools`, which only sees the cumulative
    `utilization` snapshot and therefore can't show args.
    """
    items: list[tuple[str, str, str]] = []  # (ts, name, args_summary)
    for ts, block in _iter_record_blocks(records):
        if block.get("type") != "tool_use":
            continue
        name = (block.get("tool_name") or block.get("name") or "").strip()
        if not name:
            continue
        raw_input = block.get("input") or {}
        if not isinstance(raw_input, dict):
            raw_input = {}
        args_summary = _summarize_tool_args(raw_input)
        items.append((str(ts), name, args_summary))
    if not items:
        return []
    # Newest first, then format.
    items.sort(key=lambda t: t[0], reverse=True)
    out: list[str] = []
    for _ts, name, args in items[:limit]:
        out.append(_format_tool_display(name, args))
    return out


def _parse_tool_use(record: dict) -> tuple[str, str]:
    """Extract (tool_name, args_summary) from a tool_use record.

    Handles both shapes we've seen in the journal:
      content = '{"name": "...", "input": {...}}'   (string)
      content = {"name": "...", "input": {...}}     (already-parsed dict)
    """
    content = record.get("content")
    if isinstance(content, str):
        try:
            content = _json.loads(content)
        except (_json.JSONDecodeError, TypeError):
            return "", ""
    if not isinstance(content, dict):
        return "", ""
    # Common shapes: {"name": ..., "input": {...}} or
    # {"toolName": ..., "toolInput": {...}}
    name = (content.get("name") or content.get("toolName")
            or content.get("tool_name") or "")
    raw_input = (content.get("input") or content.get("toolInput")
                 or content.get("tool_input") or {})
    if not isinstance(raw_input, dict):
        raw_input = {}
    args_summary = _summarize_tool_args(raw_input)
    return str(name), args_summary


def _summarize_tool_args(args: dict) -> str:
    """Pick out the few fields that are user-meaningful (region, resource
    ids, account ids) and render them as `key=value` joined by " · ".
    Drop anything large (lists, nested objects beyond first level)."""
    if not isinstance(args, dict):
        return ""
    # Order matters: keys earlier in the tuple win the 4-slot budget. We
    # put `use_aws`'s most-meaningful fields first — service_name /
    # operation_name / aws_region / aws_account_id — because they're
    # what turns `use_aws` from opaque into readable. The `*_name` and
    # `aws_*` variants are the ACTUAL field names emitted by Operator
    # Agent's use_aws tool (verified against journal records). The
    # shorter aliases (`service`, `operation`, etc.) cover hand-built
    # / future tool inputs. command / path / file cover editor /
    # fs_read / shell-style tools.
    interesting_keys = (
        "service_name", "service", "Service",
        "operation_name", "operation", "Operation",
        "api", "Api",
        "aws_region", "region", "Region",
        "aws_account_id", "accountId", "AccountId", "account_id",
        "command",
        "path", "Path",
        "file", "file_path",
        "expression",
        "instanceId", "InstanceId", "instance_id",
        "instanceIds",
        "vpcId", "VpcId",
        "bucket", "Bucket", "bucketName",
        "functionName", "FunctionName",
        "logGroupName", "logGroupNames",
        "alarmName", "alarmNames",
        "stackName", "StackName",
        "dbInstanceIdentifier", "DBInstanceIdentifier",
        "clusterName", "ClusterName",
        "namespace", "Namespace",
        "metricName", "MetricName",
        "queryString",
    )
    parts: list[str] = []
    for k in interesting_keys:
        if k in args and args[k] not in (None, "", [], {}):
            v = args[k]
            if isinstance(v, list):
                if len(v) > 2:
                    v = f"{v[0]}… (+{len(v)-1})"
                else:
                    v = ",".join(str(x) for x in v)
            v = str(v)[:60]
            parts.append(f"{_canonical_arg_name(k)}={v}")
            if len(parts) >= 4:
                break
    return " · ".join(parts)


def _canonical_arg_name(k: str) -> str:
    """Lowercase-plus-readable variant of an arg key. We collapse the
    Agent's verbose `service_name` / `operation_name` / `aws_region` /
    `aws_account_id` into shorter labels (`service` / `operation` /
    `region` / `account`) so the live card stays readable."""
    if k in {"service_name"}: return "service"
    if k in {"operation_name"}: return "op"
    if k in {"aws_region"}: return "region"
    if k in {"aws_account_id"}: return "account"
    if k.lower() in {"region", "instanceid", "instance_id", "vpcid", "bucket",
                     "bucketname", "functionname", "loggroupname",
                     "alarmname", "stackname", "dbinstanceidentifier",
                     "clustername", "service", "namespace", "metricname",
                     "accountid", "account_id", "querystring", "operation",
                     "api", "command", "path", "file", "file_path",
                     "expression"}:
        return k.lower().replace("identifier", "_id")
    return k


def _format_tool_display(name: str, args_summary: str) -> str:
    """Render `name` + args into a single one-line display string."""
    if args_summary:
        return f"`{name}` — {args_summary}"
    return f"`{name}`"


# ---------------------------------------------------------------------------
# Bedrock summarizer (called sparingly: 1st tick + every 4th)
# ---------------------------------------------------------------------------
SUMMARY_SYSTEM_PROMPT = (
    "你是 DevOps Agent 调查进度概要生成器。\n\n"
    "你会收到:用户原始指令、agent 当前已经调用过的工具列表、agent 的最近思考片段。\n"
    "请用 1-2 句话(≤80 字符)告诉用户「agent 当前在做什么 + 接下来大概会做什么」。\n\n"
    "规则:\n"
    "  - 输出语言:与用户原始指令同语言\n"
    "  - 不要重复用户已经看到的工具名,而是高层次描述「正在干嘛」\n"
    "  - 用进行时态,例:'正在检查 EC2 实例,接下来会查询 IAM 信任关系'\n"
    "  - 不要带前缀('总结:'、'当前:'),直接写内容\n"
    "  - 只输出文本,不要 JSON、不要 markdown 包裹"
)


def summarize_progress(intent_summary: str, recent_tools: list[str],
                       elapsed_seconds: int,
                       latest_thinking: str = "",
                       recent_tool_calls: list[str] | None = None) -> str:
    """Ask Bedrock for a 1-2 sentence narrative. Returns '' on any error
    so the caller can fall back to just the tool list.

    `recent_tools` is the cumulative-count list from `extract_recent_tools`.
    `recent_tool_calls` (preferred when present) is the per-step list
    with args from `extract_recent_tool_calls` — much more informative.
    `latest_thinking` is a short (≤120 char) snippet of agent reasoning,
    when available. We feed everything we have so the narrative can name
    what the agent is actually doing."""
    if not recent_tools and not recent_tool_calls and not latest_thinking:
        return ""
    try:
        sections = [
            f"用户原始问题: {intent_summary or '(未知)'}",
            f"调查已用时: {elapsed_seconds} 秒",
        ]
        if recent_tool_calls:
            sections.append("最近的工具调用(新→旧,带参数):")
            sections.append("\n".join(f"  - {t}" for t in recent_tool_calls[:5]))
        elif recent_tools:
            sections.append("最近调用的工具(累积计数):")
            sections.append("\n".join(f"  - {t}" for t in recent_tools[:5]))
        if latest_thinking:
            sections.append(f"agent 当前思考片段: {latest_thinking}")
        user_text = "\n".join(sections)
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 200,
            "system": SUMMARY_SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_text}],
        }
        resp = _bedrock.invoke_model(
            modelId=get_bot_model_id(),
            contentType="application/json",
            accept="application/json",
            body=_json.dumps(body),
        )
        data = _json.loads(resp["body"].read())
        for block in data.get("content", []):
            if block.get("type") == "text":
                return block["text"].strip()[:200]
        return ""
    except Exception as e:
        logger.warning("summarize_progress failed: %s", e)
        return ""
