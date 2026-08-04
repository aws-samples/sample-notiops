"""
Generate "next step" suggestions from a DevOps Agent investigation summary.

Each suggestion is one of:
  - {type: "dispatch", label, query}     → fire a new investigation with `query`
  - {type: "open_url", label, url}       → AWS Console deep link

Used by the report-handler so the user can act on the agent's findings
with one click instead of writing a new mention. Failures (Bedrock down,
malformed JSON, etc.) return [] — the report still ships, just without
next-step buttons.
"""
from __future__ import annotations

import json
import logging
import os
import re

import boto3

from shared.model_config import get_bot_model_id

logger = logging.getLogger(__name__)

BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")

_bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)

MAX_STEPS = 3
LABEL_MAX = 30
QUERY_MAX = 200
URL_MAX = 500

SYSTEM_PROMPT = (
    "你是 AWS 运维助手的「下一步行动」生成器。\n\n"
    "输入是一份 DevOps Agent 调查报告 (Markdown)。\n"
    "请基于报告里**实际观察到的资源、指标、错误、风险**,提议 1-3 个最值得用户接下来做的动作。\n\n"
    "## 动作格式(只能选下面两类)\n\n"
    "**dispatch**:让 DevOps Agent 跑一次新调查。\n"
    "  - 适合:还没查清的相关方向、报告里点到但未深挖的子问题。\n"
    "  - `query`:写成自然语言指令(中文),包含具体资源 ID / region / 时间窗口。\n"
    "  - 例:'检查 i-0abc 关联的 ALB tg-xyz 在过去 1 小时的健康状态'\n\n"
    "**open_url**:打开 AWS 控制台直达页面。\n"
    "  - 适合:用户应该亲眼看的 metric / log / 资源详情。\n"
    "  - `url`:必须是 https://console.aws.amazon.com/... 或 https://us-east-1.console.aws.amazon.com/... 类的真实控制台路径。\n"
    "  - 常见模板:\n"
    "    • CloudWatch Metrics: https://<region>.console.aws.amazon.com/cloudwatch/home?region=<region>#metricsV2:graph=<json>\n"
    "    • CloudWatch Logs:    https://<region>.console.aws.amazon.com/cloudwatch/home?region=<region>#logsV2:log-groups/log-group/<encoded>\n"
    "    • EC2 instance:       https://<region>.console.aws.amazon.com/ec2/home?region=<region>#InstanceDetails:instanceId=<id>\n"
    "    • RDS instance:       https://<region>.console.aws.amazon.com/rds/home?region=<region>#database:id=<id>\n"
    "    • ALB target group:   https://<region>.console.aws.amazon.com/ec2/home?region=<region>#TargetGroup:targetGroupArn=<arn>\n"
    "    • Cost Explorer:      https://us-east-1.console.aws.amazon.com/cost-management/home#/dashboard\n"
    "  - 不要造假资源 ID / region — 只用报告里**明确出现**的标识符。\n\n"
    "## 严格规则\n"
    "- 报告里看不到具体资源、纯文字结论时,可以全部用 dispatch 类型。\n"
    "- 不要建议用户「去开 case / 联系 support」(已有专门按钮)。\n"
    "- 不要建议「等待告警」「持续观察」这种没有可操作内容的动作。\n"
    "- `label` 控制在 30 字符以内,加 emoji 前缀(🔍 📊 🪵 🌐 🛠️ 等)使一眼可识别。\n"
    "- 输出语言与报告语言一致(中文报告 → 中文 label/query;英文报告 → 英文)。\n"
    "- 如果报告内容太短或不可操作,返回 `{\"steps\": []}`。\n\n"
    "## 输出格式(严格 JSON,不要 markdown 包裹)\n"
    '{\n'
    '  "steps": [\n'
    '    {"type": "dispatch", "label": "<≤30 字符,带 emoji>", "query": "<自然语言指令>"},\n'
    '    {"type": "open_url", "label": "<≤30 字符,带 emoji>", "url": "<完整控制台 URL>"}\n'
    '  ]\n'
    '}'
)


_CONSOLE_URL_RE = re.compile(
    r"^https://(?:[a-z0-9-]+\.)?console\.aws\.amazon\.com/[^\s]*$",
    re.IGNORECASE,
)


def _looks_like_console_url(url: str) -> bool:
    return bool(_CONSOLE_URL_RE.match(url or ""))


def _loose_load_json(text: str) -> dict | None:
    """Extract the first balanced JSON object from `text`. Tolerates
    Bedrock occasionally appending stray prose after the JSON."""
    if not text:
        return None
    s = text.lstrip()
    try:
        v = json.loads(s)
        return v if isinstance(v, dict) else None
    except json.JSONDecodeError:
        pass
    start = s.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(s)):
        ch = s[i]
        if escape:
            escape = False
            continue
        if ch == "\\" and in_str:
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                snippet = s[start:i + 1]
                try:
                    v = json.loads(snippet)
                    return v if isinstance(v, dict) else None
                except json.JSONDecodeError:
                    return None
    return None


def _locale_directive(locale: str) -> str:
    """Output-language addendum for the next-step generator. Affects
    only `label` / `query` strings in the JSON output."""
    if locale == "zh":
        return ("\n\n## OUTPUT LANGUAGE\n"
                "Write button `label` and `query` fields in **Simplified "
                "Chinese**. Keep AWS technical terms (EC2, IAM, ARN, "
                "instance-id, etc.) in English.")
    return ("\n\n## OUTPUT LANGUAGE\n"
            "Write button `label` and `query` fields in **English**.")


def generate(summary_md: str, status: str = "COMPLETED",
             max_chars: int = 4000,
             locale: str = "en") -> list[dict]:
    """Return a list of next-step suggestions (≤ MAX_STEPS) based on the
    investigation summary. Each item is a dict with keys:
      - type:   "dispatch" or "open_url"
      - label:  short human-readable button label
      - query:  (dispatch) natural-language follow-up command
      - url:    (open_url) AWS console URL

    Always returns [] on any error / when nothing actionable is found.
    Skips entirely when status indicates failure / cancellation — there's
    nothing useful to follow up on a failed investigation.

    `locale` controls the language of `label` and `query` fields so the
    follow-up buttons match the rest of the report.
    """
    if not summary_md or not summary_md.strip():
        return []
    if status not in (None, "", "COMPLETED"):
        return []
    body_input = summary_md.strip()
    if len(body_input) > max_chars:
        body_input = body_input[:max_chars] + "\n\n[truncated]"

    try:
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            # 1500 was 800 — bumped 2026-05-30 alongside the chat
            # path's 3000, since long investigations can produce
            # next-step lists that bumped against the old cap.
            "max_tokens": 1500,
            "system": SYSTEM_PROMPT + _locale_directive(locale),
            "messages": [{"role": "user", "content": body_input}],
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
        if text.startswith("```"):
            text = text.strip("`")
            if text.lstrip().lower().startswith("json"):
                text = (text.split("\n", 1)[1] if "\n" in text else text[4:])
        parsed = _loose_load_json(text)
        if not parsed:
            logger.warning("next_steps: could not parse Bedrock output")
            return []
        raw_steps = parsed.get("steps") or []
        if not isinstance(raw_steps, list):
            return []
    except Exception as e:
        logger.warning("next_steps generation failed: %s", e)
        return []

    out: list[dict] = []
    for s in raw_steps[:MAX_STEPS]:
        if not isinstance(s, dict):
            continue
        t = (s.get("type") or "").strip().lower()
        label = (s.get("label") or "").strip()[:LABEL_MAX]
        if not label:
            continue
        if t == "dispatch":
            query = (s.get("query") or "").strip()[:QUERY_MAX]
            if not query:
                continue
            out.append({"type": "dispatch", "label": label, "query": query})
        elif t == "open_url":
            url = (s.get("url") or "").strip()[:URL_MAX]
            if not _looks_like_console_url(url):
                logger.info("next_steps: dropping non-console URL %r", url[:80])
                continue
            out.append({"type": "open_url", "label": label, "url": url})
        else:
            continue
    return out
