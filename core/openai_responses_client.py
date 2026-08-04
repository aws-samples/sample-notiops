"""Bedrock Mantle Responses API client (OpenAI-compatible).

Used by `core/bedrock_chat.py` for the `bedrock_mantle_responses` model
kind (today: GPT-5.4, GPT-5.5). The Mantle endpoint speaks OpenAI's
Responses API protocol (different from Bedrock InvokeModel/Converse):

    POST https://bedrock-mantle.<region>.api.aws/openai/v1/responses

Authentication is SigV4 with service="bedrock" using whatever IAM
credentials boto3 picks up (ECS task role in production, AWS profile
locally) — no separate Bedrock API key is required.

Region constraints (per AWS blog 2026-06):
    - GPT-5.4 → us-east-2 / us-west-2 / GovCloud-us-west
    - GPT-5.5 → us-east-2 only

The bot ECS deployment runs in us-east-1, so we make a cross-region
HTTPS call. Latency is ~50ms higher than in-region but acceptable for
chat-path workloads.

This module exposes:
    - call_responses(...)            : single shot, returns parsed JSON
    - run_tool_use_loop(...)         : multi-turn function-calling loop
                                       that mirrors the bot's other
                                       providers in producing
                                       (text, citations, tool_calls)
"""
from __future__ import annotations
from core.net import safe_urlopen

import json as _json
import logging
import os
import urllib.error
import urllib.request
from typing import Any, Callable

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

logger = logging.getLogger(__name__)

# us-east-2 is where every GPT-5.x SKU is currently available; explicit
# env override for operators who want to pin us-west-2 or GovCloud.
GPT_REGION = os.environ.get("GPT_REGION", "us-east-2")

# Both reasoning effort and output verbosity are tunable via env so an
# operator can flip the trade-off without a code change. Defaults
# match AWS's recommended starting points (medium effort / low
# verbosity for chat use cases).
GPT_REASONING_EFFORT = (os.environ.get("GPT_REASONING_EFFORT") or "medium").strip().lower()
GPT_TEXT_VERBOSITY = (os.environ.get("GPT_TEXT_VERBOSITY") or "low").strip().lower()

# Hard wall on tool-use iterations. Mirrors bedrock_chat._MAX_TOOL_ITERATIONS
# but kept local so changing one doesn't accidentally affect the other —
# Responses API has stateful sessions and may behave differently under
# tight iteration caps.
_MAX_RESPONSES_ITERATIONS = 8

# Generous output token cap. The Mantle endpoint's default cap is low
# enough that GPT-5.4 with reasoning=medium can blow it during a
# tool-use turn — the model spends most of the budget on hidden
# reasoning, then runs out partway through emitting the
# `function_call.arguments` JSON string. Truncated arguments produced
# the 2026-06-05 incident where unparseable JSON caused the model to
# spiral into protocol-fragment + low-quality-Chinese-token output
# (see core/bedrock_chat _looks_like_protocol_leak audit for the
# downstream defense).
#
# 8000 is large enough that a single turn comfortably fits both the
# reasoning span AND a multi-arg function_call body, but small enough
# that a runaway response can't cost more than ~$0.10 per turn.
_MAX_OUTPUT_TOKENS = 8000

_HTTP_TIMEOUT_SECONDS = 60


def _endpoint(region: str) -> str:
    return f"https://bedrock-mantle.{region}.api.aws/openai/v1/responses"


def _sign_and_send(body: dict, region: str) -> dict:
    """SigV4-sign + POST + parse JSON. Raises on HTTP errors so the
    caller can decide between retry and degrade.

    When `GPT_DUMP_REQUEST_BODY` env is set to a truthy value, the
    request body is logged at INFO level (truncated to 8KB so CW
    Logs cost stays sane). This is the diagnostic switch we use to
    confirm `tools` shape on a real Mantle round-trip without
    deploying a one-off branch — flip the env, reproduce the bug,
    flip it back.
    """
    body_bytes = _json.dumps(body).encode("utf-8")
    if os.environ.get("GPT_DUMP_REQUEST_BODY", "").strip().lower() in {
            "1", "true", "yes", "on"}:
        body_preview = body_bytes.decode("utf-8", errors="replace")[:8000]
        logger.info("openai_responses: outbound body (truncated 8KB): %s",
                    body_preview)
    creds = boto3.Session().get_credentials().get_frozen_credentials()

    req = AWSRequest(
        method="POST",
        url=_endpoint(region),
        data=body_bytes,
        headers={"Content-Type": "application/json"},
    )
    SigV4Auth(creds, "bedrock", region).add_auth(req)
    prepared = req.prepare()

    http_req = urllib.request.Request(
        prepared.url, data=prepared.body, method=prepared.method,
    )
    for k, v in prepared.headers.items():
        http_req.add_header(k, v)

    with safe_urlopen(http_req, timeout=_HTTP_TIMEOUT_SECONDS) as resp:
        return _json.loads(resp.read().decode("utf-8"))


def call_responses(*,
                   model_id: str,
                   instructions: str,
                   user_text: str,
                   tools: list[dict] | None = None,
                   previous_response_id: str | None = None,
                   reasoning_effort: str = "",
                   text_verbosity: str = "",
                   region: str = "",
                   ) -> dict:
    """Single Responses API call. Returns the raw response dict.

    `previous_response_id` chains a follow-up turn (used for tool-call
    rounds). `tools` is the OpenAI function-spec format — the caller
    is responsible for converting from the bot's standard tool shape.

    No exception handling here on purpose: the loop wrapper decides
    whether a 400 (bad request) is fatal vs a 503 worth retrying.
    """
    body: dict[str, Any] = {
        "model": model_id,
        "input": user_text,
        "max_output_tokens": _MAX_OUTPUT_TOKENS,
        "reasoning": {
            "effort": (reasoning_effort or GPT_REASONING_EFFORT) or "medium",
        },
        "text": {
            "verbosity": (text_verbosity or GPT_TEXT_VERBOSITY) or "low",
        },
        # Disable parallel tool calling. With it on, GPT-5.x emits an
        # OpenAI-internal pseudo-tool `multi_tool_use.parallel` whose
        # body wraps a `tool_uses[]` array of nested calls. Bedrock
        # Mantle does NOT translate that pseudo-tool into the
        # canonical `function_call` blocks our client expects — it
        # surfaces the raw ChatML protocol marker as `output_text`,
        # which our sanitizer then has to refuse. By forcing
        # `parallel_tool_calls: false` the model is required to call
        # tools one at a time, which Mantle handles correctly. Cost:
        # slightly more turns when the model wants 2+ tools at once.
        # Reliability win: order-of-magnitude fewer leaks. See the
        # 2026-06-06 morning leak (`m6i.xlarge SIN OD price`) where
        # head was `to=functions.multi_tool_use.parallel\n
        # {"tool_uses":[{"recipient_name":"functions.aws_pricing_..."`.
        "parallel_tool_calls": False,
    }
    # `instructions` and `tools` and `previous_response_id` are
    # optional from the API's perspective; only attach when set so we
    # don't send empty fields the wire format may reject.
    if instructions:
        body["instructions"] = instructions
    if tools:
        body["tools"] = tools
    if previous_response_id:
        body["previous_response_id"] = previous_response_id

    return _sign_and_send(body, region or GPT_REGION)


def call_with_tool_outputs(*,
                            model_id: str,
                            previous_response_id: str,
                            tool_outputs: list[dict],
                            region: str = "",
                            ) -> dict:
    """Continuation call after the bot has executed every function_call
    the previous turn requested. Each `tool_outputs` entry must be:

        {"type": "function_call_output",
         "call_id": "<id from the previous response>",
         "output": "<stringified tool result>"}

    The Responses API picks up the conversation server-side via
    `previous_response_id`, so we send only the tool_call_output
    items, not a full message history.
    """
    body: dict[str, Any] = {
        "model": model_id,
        "input": tool_outputs,
        "previous_response_id": previous_response_id,
        "max_output_tokens": _MAX_OUTPUT_TOKENS,
        # `reasoning` / `text` carry over from the original call — but
        # passing them again is a no-op so it's safer than relying on
        # server-side defaults.
        "reasoning": {"effort": GPT_REASONING_EFFORT or "medium"},
        "text": {"verbosity": GPT_TEXT_VERBOSITY or "low"},
        # Same rationale as in `call_responses` — keep the model
        # off the parallel-tool-call path Mantle can't render.
        "parallel_tool_calls": False,
    }
    return _sign_and_send(body, region or GPT_REGION)


def extract_text(response: dict) -> str:
    """Pull the assistant's user-visible text from a Responses payload.

    Format (excerpted from a real GPT-5.4 response):
        {"output": [
            {"type": "reasoning", ...},
            {"type": "message",
             "role": "assistant",
             "content": [
                {"type": "output_text", "text": "..."}
             ]}
        ]}

    Per-block sanitizer:

    Bedrock Mantle for GPT-5.x has been observed (2026-06-06 probe)
    emitting MULTIPLE `output_text` items in one response — typically
    a few exploratory items that contain leaked ChatML protocol
    markers (`to=functions.<tool>`) followed by the model's actual
    final answer in a clean item. Earlier behaviour was all-or-
    nothing: any block contained leakage → we discarded the whole
    response. That was throwing away the clean final answer.

    New behaviour:
      * Each `output_text` is checked individually.
      * Blocks that contain leak signatures are dropped.
      * Blocks that are clean are kept.
      * If at least one block survived, return it (joined by \\n).
      * If every block leaked, return "" (caller falls back).

    Bedrock Mantle also tends to emit STREAMING-style partial
    blocks where each successive clean block is a strictly longer
    prefix-extension of the previous one (the model is replaying
    its full answer as it streams). To avoid duplicated text we
    keep only the LONGEST clean block when N > 1 clean blocks all
    start with the same prefix.
    """
    pre_audit_blocks: list[str] = []
    for block in response.get("output") or []:
        if block.get("type") != "message":
            continue
        for sub in block.get("content") or []:
            if sub.get("type") == "output_text":
                t = sub.get("text") or ""
                if t:
                    pre_audit_blocks.append(t)

    if not pre_audit_blocks:
        return ""

    clean_blocks: list[str] = []
    leak_count = 0
    for blk in pre_audit_blocks:
        if _looks_like_protocol_leak(blk):
            leak_count += 1
            continue
        clean_blocks.append(blk)

    if leak_count and not clean_blocks:
        # Whole response is garbage. Log + return "" — caller takes
        # the sentinel path and surfaces the "switch model" reply.
        joined = "\n".join(pre_audit_blocks)
        logger.warning(
            "openai_responses: refusing to surface leaked/garbage output "
            "(all %d block(s) flagged, len=%d, head=%r)",
            leak_count, len(joined), joined[:200],
        )
        return ""

    if leak_count and clean_blocks:
        # Mixed payload — log at INFO so we can quantify how often it
        # happens, but DO surface the clean part. The model produced
        # a real answer; the leakage is upstream noise.
        logger.info(
            "openai_responses: dropped %d leak block(s), kept %d clean "
            "block(s) (clean head=%r)",
            leak_count, len(clean_blocks), clean_blocks[-1][:120],
        )

    # Stream-replay dedupe: when N clean blocks each strictly extend
    # the previous, keep only the longest. Cheap O(N) check on the
    # is-prefix-of relationship.
    if len(clean_blocks) >= 2:
        sorted_by_len = sorted(clean_blocks, key=len)
        is_streaming = all(
            sorted_by_len[i].startswith(sorted_by_len[i - 1][:200])
            for i in range(1, len(sorted_by_len))
        )
        if is_streaming:
            return sorted_by_len[-1].strip()

    return "\n".join(clean_blocks).strip()


# ----- output sanitizer ----------------------------------------------------

# OpenAI ChatML internal protocol fragment — should NEVER appear in
# user-visible output. When the model spirals after a tool-call/parse
# error, it leaks these.
_PROTOCOL_FRAGMENTS = (
    "to=functions.",
    "<|start|>",
    "<|end|>",
    "<|message|>",
    "<|channel|>",
    "<|constrain|>",
    "<|im_start|>",
    "<|im_end|>",
)

# Chinese-language SEO/gambling/lottery spam tokens that GPT-5.4 has
# been observed to fall into when its output budget is exhausted or its
# previous tool args were truncated. None of these legitimately appear
# in DevOps / AWS technical content. We err on the side of false
# positives — if a real AWS reply ever happens to contain one of these
# strings, the caller's canned-fallback reply is still safer than
# rendering spam to the user.
_SPAM_TOKENS = (
    "彩票", "中彩票", "大发快三", "六和彩", "六合彩",
    "红鼎", "天天中彩", "时时彩", "北京赛车", "幸运飞艇",
    "百家乐", "赌博", "博彩", "澳门赌",
    # Added 2026-06-05 PM after the post-deploy validation in a feishu
    # DM showed GPT-5.4 emitting these exact tokens (`彩神争霸`,
    # `下载彩神争霸`, `开号地址`, `天天送`) when its tool-call channel
    # got crossed with the output channel. Belt-and-suspenders — the
    # generic `彩票` already caught the first variant, but adding the
    # whole observed family closes the trailing edge.
    "彩神", "彩神争霸", "下载彩神", "开号地址",
    "天天送", "送彩金",
)

# Sentinel pushed onto `tool_calls_trace` whenever the output sanitizer
# (`_looks_like_protocol_leak`) refused to surface a model reply. The
# bedrock_chat layer keys off this so it can:
#   1. skip P1 / final-fallback reinvocation (which would just hit the
#      same model and likely leak again, wasting tokens)
#   2. surface a precise user-facing message ("GPT output blocked, try
#      `model claude` or `model nova`") instead of the generic canned
#      chitchat reply, which made the bot look like it didn't hear the
#      question.
OUTPUT_BLOCKED_SENTINEL = "_OUTPUT_BLOCKED_BY_AUDIT"


def _extract_text_and_record(response: dict,
                              tool_calls_trace: list[dict]) -> str:
    """Like `extract_text`, but if the sanitizer redacted the model's
    reply to "" we ALSO push `OUTPUT_BLOCKED_SENTINEL` onto
    `tool_calls_trace` so the caller can distinguish:

      * truly empty model turn (rare; just means the model produced
        no `output_text` block) — caller falls back as usual
      * model produced text BUT the audit dropped it on the floor —
        caller should NOT fall back to the same model; should surface
        a clear "blocked, switch model" message instead

    The distinction matters: P1/final fallbacks reinvoke the same GPT
    instance, which on a known-bad turn just burns tokens to leak
    again. See the 2026-06-05 PM post-deploy logs for the case study
    (a single "what is EKS" went through 2 leak/redact rounds before
    the user saw the generic canned greeting and got confused).
    """
    pre_audit_chunks: list[str] = []
    for block in response.get("output") or []:
        if block.get("type") != "message":
            continue
        for sub in block.get("content") or []:
            if sub.get("type") == "output_text":
                t = sub.get("text") or ""
                if t:
                    pre_audit_chunks.append(t)
    raw = "\n".join(pre_audit_chunks).strip()
    cleaned = extract_text(response)
    if raw and not cleaned:
        # Audit kicked in. Tell the caller via sentinel.
        tool_calls_trace.append({
            "name": OUTPUT_BLOCKED_SENTINEL,
            "summary": "(model output blocked by sanitizer — "
                       "protocol leak / spam token detected)",
            "ok": False,
        })
    return cleaned


def _looks_like_protocol_leak(text: str) -> bool:
    """Return True if `text` contains output that should never reach
    the end user. Triggers on:

      * OpenAI ChatML protocol fragments (`to=functions.`, `<|...|>`)
      * Known Chinese SEO / gambling spam tokens
      * Heuristic: a stranded line that begins with `{"` and is shorter
        than 240 chars (truncated function_call.arguments leaked into
        message text). Real JSON the bot emits is fenced in code blocks.
    """
    if not text:
        return False
    for frag in _PROTOCOL_FRAGMENTS:
        if frag in text:
            return True
    for tok in _SPAM_TOKENS:
        if tok in text:
            return True
    for line in text.splitlines():
        s = line.strip()
        if (s.startswith('{"') and not s.endswith("}")
                and 4 < len(s) < 240):
            return True
    return False


def extract_tool_calls(response: dict) -> list[dict]:
    """Return any `function_call` entries in the response output, in
    their wire-format dict shape (caller will dispatch each one and
    feed the output back via `call_with_tool_outputs`).

    Each function_call has shape:
        {"type": "function_call",
         "id": "fc_...",
         "call_id": "call_...",
         "name": "<tool_name>",
         "arguments": '<json string>'}    # ← yes, stringified JSON
    """
    return [
        block for block in (response.get("output") or [])
        if block.get("type") == "function_call"
    ]


def run_tool_use_loop(*,
                      model_id: str,
                      instructions: str,
                      user_text: str,
                      tools: list[dict],
                      tool_dispatch: Callable[[str, dict], tuple[bool, str, list[dict]]],
                      region: str = "",
                      max_iterations: int = _MAX_RESPONSES_ITERATIONS,
                      ) -> tuple[str, list[dict], list[dict]]:
    """Multi-turn tool-use loop on the Responses API.

    Returns ``(final_text, citations, tool_calls)`` matching the shape
    other providers produce so `bedrock_chat.respond()` can render the
    final reply uniformly.

    `tool_dispatch(name, args_dict) -> (ok, text, citations)` is the
    bot's standard tool dispatcher; the caller passes in the same
    function used by the Anthropic / Nova loops so all three providers
    share MCP execution, allowlist enforcement, and citation capture.

    Errors funnel into ``("", [], tool_calls_so_far)`` — caller falls
    back to the canned chitchat reply.
    """
    region = region or GPT_REGION
    citations: list[dict] = []
    seen_urls: set[str] = set()
    tool_calls_trace: list[dict] = []

    try:
        resp = call_responses(
            model_id=model_id,
            instructions=instructions,
            user_text=user_text,
            tools=tools,
            region=region,
        )
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        logger.warning("openai_responses: initial call HTTP %d: %s", e.code, body)
        return ("", citations, tool_calls_trace)
    except Exception as e:
        logger.warning("openai_responses: initial call failed: %s", e)
        return ("", citations, tool_calls_trace)

    response_id = resp.get("id") or ""

    for _it in range(max_iterations):
        fn_calls = extract_tool_calls(resp)
        if not fn_calls:
            # No more tools to run — terminal turn.
            return (
                _extract_text_and_record(resp, tool_calls_trace),
                citations,
                tool_calls_trace,
            )

        tool_outputs: list[dict] = []
        # Track whether ANY function_call had unparseable arguments. If
        # so, we DO NOT execute it (`args = {}` silently was the
        # 2026-06-05 incident's smoking gun — the model thought the call
        # succeeded with empty input, then started spiraling out garbage
        # in the next turn). Instead we surface the parse error to the
        # model via the `output` field, hand it back the actual error
        # message, and let it self-correct on the next iteration. If it
        # can't recover, the iteration cap or output sanitizer will
        # short-circuit before the user sees anything.
        any_bad_args = False
        for fc in fn_calls:
            tool_name = fc.get("name") or ""
            call_id = fc.get("call_id") or ""
            raw_args = fc.get("arguments") or "{}"

            # OpenAI Responses returns arguments as a JSON-string, not
            # an object — be tolerant if a future server change ever
            # sends it as already-parsed dict.
            if isinstance(raw_args, dict):
                args = raw_args
                args_ok = True
            else:
                try:
                    args = _json.loads(raw_args) if raw_args.strip() else {}
                    args_ok = True
                except Exception as e:
                    logger.warning(
                        "openai_responses: bad JSON arguments for %s: %r (%s)",
                        tool_name, raw_args[:120], e,
                    )
                    args = {}
                    args_ok = False
                    any_bad_args = True

            if not args_ok:
                # Don't dispatch the tool with empty args. Tell the
                # model exactly what went wrong; that's the only way
                # it can decide to retry with shorter args (the most
                # common cause is the JSON string was truncated by the
                # token cap).
                tool_calls_trace.append({
                    "name": tool_name,
                    "summary": "(invalid arguments — JSON parse failed)",
                    "ok": False,
                })
                tool_outputs.append({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": (
                        "ERROR: Your function_call.arguments was not valid "
                        "JSON (likely truncated by the output-token budget). "
                        "Retry this tool call with a SHORTER arguments value, "
                        "or skip the tool call and answer from existing "
                        "context."
                    ),
                })
                continue

            ok, text, hits = tool_dispatch(tool_name, args)
            tool_calls_trace.append({
                "name": tool_name,
                "summary": _summarize_args(args),
                "ok": bool(ok),
            })
            for h in hits or []:
                u = (h.get("url") or "").strip()
                if u and u not in seen_urls:
                    seen_urls.add(u)
                    citations.append({"title": h.get("title", ""), "url": u})

            tool_outputs.append({
                "type": "function_call_output",
                "call_id": call_id,
                "output": text or "(empty)",
            })

        # If EVERY function_call this turn had bad args, the model is
        # stuck — escape the loop early so we don't burn iterations
        # watching it produce more truncated calls. Caller gets ""
        # text and falls back to the canned chitchat reply.
        if any_bad_args and not any(
            tc.get("ok") for tc in tool_calls_trace[-len(fn_calls):]
        ):
            logger.warning(
                "openai_responses: all %d tool calls this turn had bad args "
                "— aborting loop to prevent runaway", len(fn_calls),
            )
            return ("", citations, tool_calls_trace)

        # Continue the conversation server-side via previous_response_id.
        try:
            resp = call_with_tool_outputs(
                model_id=model_id,
                previous_response_id=response_id,
                tool_outputs=tool_outputs,
                region=region,
            )
            response_id = resp.get("id") or response_id
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:500]
            logger.warning(
                "openai_responses: continuation HTTP %d: %s", e.code, body,
            )
            return ("", citations, tool_calls_trace)
        except Exception as e:
            logger.warning("openai_responses: continuation failed: %s", e)
            return ("", citations, tool_calls_trace)

    logger.info(
        "openai_responses: hit iteration cap (%d) — returning what we have",
        max_iterations,
    )
    return (
        _extract_text_and_record(resp, tool_calls_trace),
        citations,
        tool_calls_trace,
    )


def _summarize_args(args: dict) -> str:
    """One-line preview of tool args for the `🔧 调用的 MCP 工具` block.
    Mirrors `bedrock_chat._summarize_tool_args` minimal version — the
    bedrock_chat helper has tool-specific cleanup we don't repeat here
    because callers can swap in a richer summarizer if needed."""
    if not args:
        return ""
    try:
        s = _json.dumps(args, ensure_ascii=False)
    except Exception:
        return str(args)[:120]
    return s if len(s) <= 120 else s[:117] + "..."


__all__ = [
    "call_responses",
    "call_with_tool_outputs",
    "extract_text",
    "extract_tool_calls",
    "run_tool_use_loop",
    "GPT_REGION",
    "OUTPUT_BLOCKED_SENTINEL",
]
