"""
LLM-driven AWS Support case analysis.

Triggered by `command=case_analyze` from `bedrock_intent.analyze_intent`.
The user types something like "分析 case 12345" / "summarize case 67890" /
"帮我看 case 5xx 是什么原因", we:

  1. Pull the case metadata (subject / severity / service / created_at)
     via `core.case_management.describe_case`.
  2. Pull all communications (newest first, capped at 30 to fit Bedrock
     context) via `core.case_management.list_communications`.
  3. Compose a structured prompt and call Bedrock via `get_bot_model_id()`
     (SSM `/notiops/agent/model_id`, Claude Sonnet 5 today). This is an
     internal utility call with a hand-rolled Anthropic-native body, so it
     deliberately does NOT follow the chat's `@bot model` preference --
     see `shared/model_config.py`.
  4. Return an `AnalyzeResult` dataclass the platform sender renders into
     a card.

This module is **read-only**. It never writes to the case (no
`add_communication`, no `resolve_case`). The L1 zero-change defense in
`bedrock_chat._is_change_request` is bypassed here because the user's
intent has already been classified as `case_analyze`, but the L3
outbound audit on the LLM's reply still runs (see `_audit_response`).

Output language follows the conversation locale (zh / en) — independent
of the case's own language (AWS engineers usually reply in English even
when the customer wrote in Chinese).
"""
from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field

import boto3
from core.lazy_boto import LazyClient

from core import case_management
from shared.model_config import get_bot_model_id

logger = logging.getLogger(__name__)

BEDROCK_REGION = os.environ.get("BEDROCK_REGION", os.environ.get("AWS_REGION", "us-east-1"))
# 惰性构造（core/lazy_boto.py）：botocore 在**构造时**快照凭证，import 期建好的
# client 会让后续 setenv AWS_BEARER_TOKEN_BEDROCK 完全失效（Bedrock API Key 模式
# 因此无法生效）。代理转发属性访问，所有调用点写法不变。
_bedrock = LazyClient("bedrock-runtime", region=BEDROCK_REGION)


# Cap communications fed into the prompt. AWS Support cases occasionally
# accumulate 50+ messages; a Sonnet 5 input window is 200K tokens but
# each communication can be ~5K chars, so 30 is a comfortable upper bound
# that keeps the prompt under ~150K chars / ~50K tokens.
_MAX_COMMS = 30
_PER_COMM_CHARS = 4000  # truncate any single communication this long


@dataclass
class AnalyzeResult:
    """What the LLM analysis returns. Senders render `summary` /
    `root_cause` / `next_steps` / `info_to_provide` as separate
    sections; `error` is set on any failure (case not found, LLM
    error, etc.) so senders can show the user a graceful message.
    """
    case_summary: case_management.CaseSummary | None = None
    comm_count: int = 0
    summary: str = ""           # one-paragraph symptom statement
    root_cause: str = ""        # likely root cause analysis (or "evidence insufficient")
    aws_progress: str = ""      # what AWS engineers have done so far
    next_steps: list[str] = field(default_factory=list)  # concrete user actions
    info_to_provide: list[str] = field(default_factory=list)  # follow-up questions / data to share
    suggested_reply: str = ""   # optional draft reply the user can send back
    error: str = ""             # non-empty iff something went wrong


# Strip noisy AWS auto-template footers (legal disclaimers, "If you're
# satisfied" survey link blocks, log file dumps that bloat the prompt
# without adding signal). Heuristic, not exhaustive — over-trimming is
# fine because the user can always click the "View full case" button.
_NOISE_PATTERNS = [
    re.compile(r"\s*[-=*_]{10,}\s*", re.MULTILINE),  # divider lines
    re.compile(r"^\s*-+\s*Original Message\s*-+.*$", re.MULTILINE | re.IGNORECASE),
    re.compile(r"https?://\S+\s*", re.MULTILINE),     # naked URLs (preserve intent, save tokens)
]


def _trim_comm(body: str) -> str:
    if not body:
        return ""
    body = body.strip()
    for pat in _NOISE_PATTERNS:
        body = pat.sub(" ", body)
    body = re.sub(r"\s+", " ", body).strip()
    if len(body) > _PER_COMM_CHARS:
        body = body[:_PER_COMM_CHARS] + " […truncated]"
    return body


def _format_for_prompt(case: case_management.CaseSummary,
                      comms: list[case_management.Communication]) -> str:
    """Compose the structured case payload that goes into the user message.

    Comms come back from `list_communications` newest-first; we reverse
    so the LLM reads them in chronological order (matches how a human
    reads a case)."""
    lines: list[str] = []
    lines.append(f"## Case {case.display_id}")
    lines.append(f"- subject: {case.subject}")
    lines.append(f"- severity: {case.severity}")
    lines.append(f"- service: {case.service_code}")
    lines.append(f"- category: {case.category_code}")
    lines.append(f"- status: {case.status}")
    lines.append(f"- created_at: {case.created_at}")
    lines.append(f"- language: {case.language}")
    lines.append(f"- communications_total: {len(comms)}")
    lines.append("")
    lines.append("## Communications (chronological, oldest first)")
    if not comms:
        lines.append("(no messages on file)")
    else:
        for i, c in enumerate(reversed(comms), 1):
            speaker = "AWS" if c.is_aws else "Customer"
            body = _trim_comm(c.body)
            lines.append(f"### #{i} {speaker} @ {c.submitted_at}")
            lines.append(body)
            lines.append("")
    return "\n".join(lines)


_SYSTEM_PROMPT_BASE = (
    "You are a senior AWS SRE assisting a customer with their AWS Support case. "
    "You will be given the case metadata and the full chronological "
    "communication thread between the customer and AWS engineers.\n\n"
    "Your task: produce a structured analysis to help the customer understand "
    "where the case stands and what to do next. Be concise and decisive.\n\n"
    "## Hard rules\n"
    "1. NEVER invent resource ids, ARNs, account ids, or facts not present in "
    "   the case text. If a detail is missing, say so explicitly.\n"
    "2. NEVER instruct the customer to run mutating AWS commands (delete / "
    "   stop / terminate / modify / scale). The bot is read-only by design — "
    "   you may suggest *that* a change is needed but never the exact mutating "
    "   command. Read-only commands (describe / list / get) are fine.\n"
    "3. If the case is too thin to analyze (e.g. just opened, no AWS reply yet), "
    "   say so and skip the speculation.\n"
    "4. Keep each section short. Bullet points where natural.\n\n"
    "## Output format (strict JSON, no markdown wrapper)\n"
    "{\n"
    '  "summary": "<one paragraph, the symptom and where the case is>",\n'
    '  "root_cause": "<best-guess root cause from evidence, or \\"evidence insufficient: missing X / Y\\">",\n'
    '  "aws_progress": "<what AWS has done so far, or \\"awaiting AWS response\\">",\n'
    '  "next_steps": ["<concrete user action 1>", "<action 2>", ...],\n'
    '  "info_to_provide": ["<data point AWS likely needs next>", ...],\n'
    '  "suggested_reply": "<optional, ≤300 chars, what the user could write back to AWS — leave empty if no reply is needed>"\n'
    "}\n\n"
    "Lists capped at 5 items each. Empty arrays allowed if not applicable.\n"
)


def _system_prompt_for_locale(locale: str) -> str:
    if locale == "zh":
        return _SYSTEM_PROMPT_BASE + (
            "\n## OUTPUT LANGUAGE\n"
            "Write all string fields in Simplified Chinese, regardless of "
            "the case's own language. Technical terms (service names, error "
            "codes, AWS resource types) stay in English.\n"
        )
    return _SYSTEM_PROMPT_BASE + (
        "\n## OUTPUT LANGUAGE\n"
        "Write all string fields in English.\n"
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def analyze(display_id: str, *, locale: str = "en") -> AnalyzeResult:
    """End-to-end: fetch case + comms → call Bedrock → parse → return.

    Failure modes are signalled via `result.error` (non-empty string) so
    callers can render a graceful "couldn't analyze" message instead of
    raising. Logs the actual exception for ops.
    """
    locale = locale if locale in {"zh", "en"} else "en"

    case = case_management.describe_case(display_id)
    if case is None:
        return AnalyzeResult(error="case_not_found")

    comms = case_management.list_communications(
        display_id,
        max_items=_MAX_COMMS,
        internal_id=case.internal_id,
    )

    prompt_payload = _format_for_prompt(case, comms)
    system_prompt = _system_prompt_for_locale(locale)

    try:
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1500,
            "system": system_prompt,
            "messages": [{"role": "user", "content": prompt_payload}],
        }
        resp = _bedrock.invoke_model(
            modelId=get_bot_model_id(),
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        data = json.loads(resp["body"].read())
        text = ""
        for block in data.get("content", []):
            if block.get("type") == "text":
                text = block["text"].strip()
                break
        if not text:
            logger.warning("case_analyze: Bedrock returned no text block: %s", data)
            return AnalyzeResult(case_summary=case, comm_count=len(comms),
                                 error="llm_empty_response")
    except Exception as e:
        logger.error("case_analyze: Bedrock invoke failed: %s", e)
        return AnalyzeResult(case_summary=case, comm_count=len(comms),
                             error=f"llm_invoke_failed:{e.__class__.__name__}")

    # The model occasionally wraps JSON in markdown fences; strip defensively.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lstrip().lower().startswith("json"):
            text = text.split("\n", 1)[1] if "\n" in text else text[4:]

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        logger.warning("case_analyze: non-JSON response (%s): %r", e, text[:200])
        return AnalyzeResult(case_summary=case, comm_count=len(comms),
                             error="llm_parse_failed")

    def _coerce_list(v) -> list[str]:
        if not isinstance(v, list):
            return []
        out: list[str] = []
        for it in v:
            if isinstance(it, str) and it.strip():
                out.append(it.strip())
            if len(out) >= 5:
                break
        return out

    return AnalyzeResult(
        case_summary=case,
        comm_count=len(comms),
        summary=(parsed.get("summary") or "").strip(),
        root_cause=(parsed.get("root_cause") or "").strip(),
        aws_progress=(parsed.get("aws_progress") or "").strip(),
        next_steps=_coerce_list(parsed.get("next_steps")),
        info_to_provide=_coerce_list(parsed.get("info_to_provide")),
        suggested_reply=(parsed.get("suggested_reply") or "").strip()[:300],
        error="",
    )
