"""
AWS Support case creation logic — platform-agnostic.

This module encapsulates "given an investigation context, classify and
open an AWS Support case" without any IM card / button / form rendering.
Each chat platform builds its own UI on top.

Public surface:
  - SEVERITY_CODES / SEVERITY_LABELS / DEFAULT_SEVERITY
  - LANGUAGE_CODES  / LANGUAGE_LABELS  / DEFAULT_LANGUAGE
  - ISSUE_TYPE_CODES / issue_type_label(s) / DEFAULT_ISSUE_TYPE
  - apply_case_overrides(classification, service_text=, issue_type=)
  - load_support_context(incident_id) -> dict | None
  - claim_inflight(idempotency_key)   -> bool
  - create_case(...)                  -> CaseResult dataclass

Idempotency: callers should call `claim_inflight(key)` before kicking off
case creation. Feishu/Slack both retry callbacks on missed-ACK,
so without this guard we'd open duplicate cases.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import boto3
from botocore.exceptions import ClientError

from . import case_classifier
from . import ddb_state
from . import i18n

logger = logging.getLogger(__name__)

_support = boto3.client("support", region_name="us-east-1")

# AWS Support API severity codes (lowercase) — confirmed against
# describe-severity-levels in Business plan.
SEVERITY_CODES = ["low", "normal", "high", "urgent", "critical"]
DEFAULT_SEVERITY = "normal"

# Severity labels per UI locale. The label is what the user sees on
# the picker / badge; the underlying API value is always the lowercase
# code (low / normal / high / urgent / critical). Both locales keep
# the dot-separated bilingual form because customers cross-reference
# the AWS Console which shows English-only labels.
_SEVERITY_LABELS_BY_LOCALE: dict[str, dict[str, str]] = {
    "zh": {
        "low": "低 · Low",
        "normal": "中 · Normal",
        "high": "高 · High",
        "urgent": "紧急 · Urgent",
        "critical": "严重 · Critical",
    },
    "en": {
        "low": "Low",
        "normal": "Normal",
        "high": "High",
        "urgent": "Urgent",
        "critical": "Critical",
    },
}


def severity_label(code: str, locale: str = "en") -> str:
    """Return the human label for a severity `code` in `locale`.
    Falls back to en, then to the code itself."""
    code = (code or "").lower()
    by_loc = _SEVERITY_LABELS_BY_LOCALE.get(locale) \
        or _SEVERITY_LABELS_BY_LOCALE["en"]
    return by_loc.get(code) or code


def severity_labels(locale: str = "en") -> dict[str, str]:
    """Return the full code→label dict for a locale. Used by the case
    severity picker UI."""
    return dict(_SEVERITY_LABELS_BY_LOCALE.get(locale)
                or _SEVERITY_LABELS_BY_LOCALE["en"])


# Legacy alias kept for one release — case_flow.py imports this name.
# Will be removed once all call sites use severity_labels(locale).
SEVERITY_LABELS = _SEVERITY_LABELS_BY_LOCALE["zh"]


LANGUAGE_CODES = ["zh", "en", "ja", "ko"]
# Language labels — these stay bilingual / native-form because the
# customer is choosing what language AWS Support engineers should
# reply in, regardless of the bot's UI locale. "中文" / "日本語" /
# "한국어" are universally readable inside their own ecosystem.
LANGUAGE_LABELS = {
    "zh": "Chinese / 中文",
    "en": "English",
    "ja": "Japanese / 日本語",
    "ko": "Korean / 한국어",
}
DEFAULT_LANGUAGE = "zh"

# AWS 案例类型（`issueType`）—— 与 web 端案例面板的 `ISSUE_TYPE_OPTS` 逐条对齐
# （`frontend/chat-app/src/components/Message.tsx`）。IM 面板 2026-09-03 补上这一项，
# 在此之前 IM 端只能由分类器猜，猜错就落进错误的 Support 队列。
# **顺序即 UI 顺序**，第一项是默认值。
ISSUE_TYPE_CODES = ["technical", "customer-service", "service-limit-increase"]
DEFAULT_ISSUE_TYPE = "technical"
_ISSUE_TYPE_LABELS_BY_LOCALE: dict[str, dict[str, str]] = {
    "zh": {
        "technical": "技术问题",
        "customer-service": "账单和账户",
        "service-limit-increase": "提高服务限制",
    },
    "en": {
        "technical": "Technical",
        "customer-service": "Account & billing",
        "service-limit-increase": "Service limit increase",
    },
}


def issue_type_label(code: str, locale: str = "en") -> str:
    """案例类型的人类可读标签。回退顺序：locale → en → code 本身。"""
    by_loc = _ISSUE_TYPE_LABELS_BY_LOCALE.get(locale) \
        or _ISSUE_TYPE_LABELS_BY_LOCALE["en"]
    return by_loc.get((code or "").lower()) or code


def issue_type_labels(locale: str = "en") -> dict[str, str]:
    """给案例类型选择器用的 code→label 全表。"""
    return dict(_ISSUE_TYPE_LABELS_BY_LOCALE.get(locale)
                or _ISSUE_TYPE_LABELS_BY_LOCALE["en"])


# Body cap matching AWS Support API (8000 chars hard limit; we leave headroom).
_BODY_MAX_CHARS = 7900


@dataclass
class CaseResult:
    ok: bool
    display_id: str = ""
    internal_id: str = ""
    case_url: str = ""
    error_code: str = ""
    error_message: str = ""
    classification: dict | None = None


def claim_inflight(key: str) -> bool:
    """Return True if this is the first attempt for `key`; False if a previous
    attempt is already in progress (or completed within TTL).

    Pass an empty string to bypass (best-effort path).

    Backed by `core.ddb_state.claim_inflight` so the lock survives process
    restarts and works across multiple replicas. On DDB infrastructure
    failure the underlying call fails open (returns True), which trades
    rare duplicate work for not deadlocking the user — see ddb_state for
    the rationale.
    """
    return ddb_state.claim_inflight(key)


def load_support_context(incident_id: str) -> dict | None:
    """Read the support#<incident_id> row written by the report-handler.

    Returns the DDB item (dict) on hit, None if missing/expired.
    """
    table = ddb_state._table  # reuse the same table client
    resp = table.get_item(Key={"lookup_key": f"support#{incident_id}"})
    return resp.get("Item")


def build_subject(ctx: dict, platform: str) -> str:
    intent = ctx.get("intent_summary") or ctx.get("raw_text") or "investigation"
    intent = intent.strip().splitlines()[0][:120]
    label = platform.capitalize() if platform else "Bot"
    return f"[{label} NotiOps] {intent}"


def build_body(ctx: dict, severity: str, extra: str, operator_name: str,
               platform: str) -> str:
    summary = ctx.get("summary_md", "") or "(no summary available)"
    raw_text = ctx.get("raw_text", "")
    intent = ctx.get("intent_summary", "")
    report_url = ctx.get("report_url", "")
    trace_url = ctx.get("trace_url", "")
    incident_id = ctx.get("incident_id", "")
    task_id = ctx.get("task_id", "")
    agent_space_id = ctx.get("agent_space_id", "")
    operator_url = (f"https://{agent_space_id}.aidevops.global.app.aws/investigation/{task_id}"
                    if agent_space_id and task_id else "")
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    via = (platform or "bot").capitalize()

    parts = [
        f"This case was opened automatically from a {via} NotiOps",
        "investigation. Below is the agent's findings; please continue from there.",
        "",
        "=== Request context ===",
        f"Submitted by   : {operator_name or 'unknown'} (via {via})",
        f"Submitted at   : {now_utc}",
        f"Severity       : {severity}",
        f"Incident ID    : {incident_id}",
        f"Task ID        : {task_id}",
        f"Agent Space    : {agent_space_id}",
        f"User question  : {raw_text}",
        f"Intent summary : {intent}",
        "",
    ]
    if extra:
        parts += ["=== Additional context from requester ===", extra, ""]
    if operator_url:
        parts += ["=== Live investigation in DevOps Agent ===", operator_url,
                  "(requires AWS console login)", ""]
    if report_url:
        parts += ["=== Final report (HTML, presigned, valid 7 days) ===",
                  report_url, ""]
    if trace_url:
        parts += ["=== Investigation trace (HTML, presigned, valid 7 days) ===",
                  trace_url, ""]
    parts += ["=== Investigation summary ===", "", summary]

    body = "\n".join(parts)
    if len(body) > _BODY_MAX_CHARS:
        # 截断提示本身也算进 body 长度 —— 先给它留出位置再切，否则"截断后"的正文
        # 反而比上限还长（7900 + 提示语），把留给 API 8000 硬限的余量吃掉一半。
        notice = "\n\n[truncated — see report URL for full content]"
        body = body[:_BODY_MAX_CHARS - len(notice)] + notice
    return body


def category_display(classification: dict, locale: str = "zh") -> str:
    """结果卡上「Category」那一格要显示的串 —— 类别 code **加上它是怎么定下来的**。

    四张结果卡（Slack/飞书 × `/案例` 面板/调查报告升级）共用这一个口径：只印一个
    code 是静默的 —— 用户分不清这个类别是自己在面板里指定的、还是我们按服务推的，
    而类别直接决定案例进哪个工程师队列。
    """
    cls = classification or {}
    code = str(cls.get("categoryCode") or "")
    if not code:
        return ""
    key = ("case.create.category_source_chosen"
           if cls.get("categorySource") == "matched"
           else "case.create.category_source_auto")
    return f"{code} {i18n.t(key, locale)}"


def apply_case_overrides(classification: dict, *, service_text: str = "",
                         issue_type: str = "", category_text: str = "") -> dict:
    """把用户在面板里**手选/手打**的服务、类别、案例类型盖到分类器的结果上。

    为什么盖而不是替代分类器：CreateCase 要求 service + category 是同一服务下的合法
    组合。所以服务一旦被用户改掉，类别必须跟着换成**新服务名下**的一个，否则报
    `No service exists for combination`（用户填得越具体反而越开不出来）。

    `category_text` 是用户在面板里手打的类别（2026-09-04 补齐，与 web 端对齐；为什么
    是手打而不是下拉，见 `case_classifier.resolve_category_detail` 的 docstring）。
    它**只在该服务名下**反查（`resolve_category_detail`），所以无论用户打什么都不可能
    拼出非法组合；匹配不上就退回通用类别，并在 `categorySource` 里记下是"匹配到的"
    还是"推导的"，由结果卡如实告诉用户（别让人猜案例落到了哪个类别）。

    匹配不上就**保留分类器的结果**，不硬塞编造的 code。返回新 dict（不改入参），
    额外带一个 `override` 字段说明这次盖了什么，方便日志和结果卡溯源。
    """
    out = dict(classification or {})
    applied: list[str] = []
    cat_q = (category_text or "").strip()

    if service_text.strip():
        hit = case_classifier.resolve_service(service_text)
        if hit and hit.get("code") and hit.get("category"):
            out["serviceCode"] = hit["code"]
            # 类别必须换成新服务名下的 —— 沿用旧的就是非法组合。
            out["categoryCode"] = hit["category"]
            out["serviceName"] = hit.get("name", "")
            applied.append(f"service={hit['code']}")
        elif hit and hit.get("code"):
            # 匹配到了服务但它名下**一个类别都没有** —— 拿不出合法组合，只能整条放弃。
            # 硬写 serviceCode + 空 categoryCode 一定会被 CreateCase 拒。
            logger.warning("case override: service %r has no categories; "
                           "keeping classifier pick", hit["code"])
            out["serviceUnmatched"] = service_text.strip()[:120]
        else:
            # 说清楚"你填的服务没匹配上，用的是分类器挑的" —— 静默忽略最坑：
            # 用户以为自己指定了服务，案例却落到 general-info。
            logger.warning("case override: service %r not found in catalog; "
                           "keeping classifier pick %r",
                           service_text[:60], out.get("serviceCode"))
            out["serviceUnmatched"] = service_text.strip()[:120]

    # 类别放在服务**后面**处理：要在"最终定下来的那个服务"名下反查，否则可能拼出
    # 跨服务的非法组合。`categorySource` 一律写上，结果卡靠它区分"你选的"和"自动的"。
    if cat_q:
        detail = case_classifier.resolve_category_detail(
            out.get("serviceCode") or "", cat_q)
        if detail["source"] == "matched":
            out["categoryCode"] = detail["code"]
            out["categoryName"] = detail.get("name") or ""
            out["categorySource"] = "matched"
            applied.append(f"category={detail['code']}")
        else:
            # 打了但这个服务名下没有 → 退回通用类别（已经在 categoryCode 里了），
            # 但必须让用户看见"你打的那个没用上"。
            logger.warning("case override: category %r not found under service "
                           "%r; keeping %r", cat_q[:60],
                           out.get("serviceCode"), out.get("categoryCode"))
            out["categoryUnmatched"] = cat_q[:120]
            out["categorySource"] = "derived"
    else:
        out.setdefault("categorySource", "derived")

    it = (issue_type or "").strip().lower()
    if it and it in ISSUE_TYPE_CODES:
        # 用户明确选了 → 不再走分类器那道 `_CUSTOMER_SERVICE_ALLOWED` 降级
        # （那道防线是为了纠正**模型**乱标，不该否决人的选择）。
        out["issueType"] = it
        applied.append(f"issueType={it}")

    if applied:
        out["override"] = ",".join(applied)
        logger.info("Case classification overridden by panel: %s", out["override"])
    return out


def create_case(ctx: dict, *, platform: str, severity: str, language: str,
                extra: str, operator_name: str,
                service_text: str = "", issue_type: str = "",
                category_text: str = "") -> CaseResult:
    """Classify the investigation and call support:CreateCase.

    Pure logic — no card rendering, no Feishu/Slack SDK calls.
    Returns a CaseResult the caller renders into a platform-specific card.

    `service_text` / `issue_type` / `category_text` 是**面板里用户填的**（IM 端
    2026-09-03 补服务与类型、2026-09-04 补类别，与 web 端案例面板对齐）。全部留空
    = 完全交给分类器，即历史行为。
    """
    if severity not in SEVERITY_CODES:
        return CaseResult(ok=False, error_code="InvalidSeverity",
                          error_message=f"unknown severity: {severity}")
    if language not in LANGUAGE_CODES:
        language = DEFAULT_LANGUAGE

    subject = build_subject(ctx, platform)
    body = build_body(ctx, severity, extra, operator_name, platform)

    classification = case_classifier.classify(
        intent_summary=ctx.get("intent_summary", ""),
        raw_text=ctx.get("raw_text", ""),
        summary_md=ctx.get("summary_md", ""),
    )
    logger.info("Case classification: %s", classification)
    classification = apply_case_overrides(classification,
                                          service_text=service_text,
                                          issue_type=issue_type,
                                          category_text=category_text)

    try:
        resp = _support.create_case(
            subject=subject,
            serviceCode=classification["serviceCode"],
            categoryCode=classification["categoryCode"],
            severityCode=severity,
            communicationBody=body,
            language=language,
            issueType=classification["issueType"],
        )
        internal_id = resp.get("caseId", "")
        display_id = internal_id
        try:
            d = _support.describe_cases(
                caseIdList=[internal_id],
                includeCommunications=False,
            )
            cases = d.get("cases") or []
            if cases:
                display_id = cases[0].get("displayId") or internal_id
        except ClientError as e:
            logger.warning("DescribeCases failed: %s", e)

        case_url = (f"https://us-east-1.console.aws.amazon.com/support/home"
                    f"#/case/?displayId={display_id}")
        logger.info("Support case created: internal=%s display=%s lang=%s sev=%s",
                    internal_id, display_id, language, severity)
        return CaseResult(
            ok=True,
            internal_id=internal_id,
            display_id=display_id,
            case_url=case_url,
            classification=classification,
        )
    except ClientError as e:
        err = e.response.get("Error", {})
        code = err.get("Code", "")
        msg = err.get("Message", str(e))
        logger.error("CreateCase failed (%s): %s", code, msg)
        return CaseResult(ok=False, error_code=code, error_message=msg,
                          classification=classification)
    except Exception as e:
        logger.exception("CreateCase unexpected error")
        return CaseResult(ok=False, error_code="UnexpectedError",
                          error_message=str(e), classification=classification)
