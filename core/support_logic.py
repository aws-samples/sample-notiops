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
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import boto3
from botocore.exceptions import ClientError

from . import case_classifier
from . import ddb_state
from . import i18n

logger = logging.getLogger(__name__)

#: AWS Support 是**全局服务**，endpoint 固定在 us-east-1（跟部署 region 无关）。
#: 跨账号那条路也一样：assume 完成员账号的角色，仍然打 us-east-1。
SUPPORT_REGION = "us-east-1"

#: 部署账号的 Support client。
#:
#: ⚠️ **保留这个模块级属性**，不要改成"每次都新建"：
#:   1. `tests/test_im_case_panel_fields.py` 用 `monkeypatch.setattr(support_logic,
#:      "_support", fake)` 打桩，而 `support_client()` 是**在调用时**读这个全局的，
#:      所以打桩照旧生效（`core/case_management.py` 同理）；
#:   2. 部署账号的凭证不过期，复用一个 client 省掉每轮的握手。
#: 跨账号**不**缓存 client —— 临时凭证有时效，见 `core/aws_session.py` 不变量 #4。
_support = boto3.client("support", region_name=SUPPORT_REGION)

#: 跨账号拿不到凭证时的统一错误码。调用方（IM 的案例流程）把它翻成
#: `failure_hint()` 里那句话；**绝不许**回落到部署账号的 client ——
#: 那等于把工单开到另一个账号里，而用户看到的是"提交成功"。
CROSS_ACCOUNT_ERROR_CODE = "CrossAccountUnavailable"

#: 目标账号的角色没有 Support **写**权限时的统一错误码。
#: 对应成员账号 onboarding 模板参数 `EnableSupportCaseWrite=false`
#: （见 `infra/member-account-onboarding.yaml`）。单独一个码而不是直接抛
#: `AccessDeniedException`：后者会让客户以为是 NotiOps 坏了，而这其实是
#: 客户自己在成员账号里**选择关掉**的一项授权，出路很明确（重跑 onboarding 打开它）。
WRITE_NOT_GRANTED_ERROR_CODE = "CaseWriteNotGranted"

#: 探针（`case_capability`）阶段就被拒 = 那个账号的角色连 Support **只读**都没有。
#: 与 `WRITE_NOT_GRANTED_ERROR_CODE` 是两回事，出路也不同（前者是角色根本没挂
#: ReadOnlyAccess / 被 SCP 拦了，后者只是那一项写授权关着），所以给两个码两句话。
SUPPORT_READ_DENIED_ERROR_CODE = "SupportReadDenied"

#: AWS 各服务对"没权限"用的几种码（Support API 实测返回 AccessDeniedException，
#: 其余几个是别的服务/别的失败路径上见过的，一起认，别漏判成"未知错误"）。
_DENIED_CODES = ("AccessDenied", "AccessDeniedException",
                 "UnauthorizedOperation", "UnrecognizedClientException")


def support_client(account_id: str | None = None):
    """Support client（多账号）。

    Args:
        account_id: 目标账号号。空 / 等于部署账号 = 用部署账号本地凭证（历史行为）。

    Returns:
        boto3 support client；或 `None` = **拒绝**（没上车 / Web 上停用了 /
        `LOCKED_ACCOUNT_ID` 闸门 / AssumeRole 失败）。

    ⚠️ 拿到 `None` 的调用方必须报错给用户，**不许**退回 `_support`。
       这是 `core/aws_session.py` 的不变量 #3，也是 Web 侧 2026-08-05 那个
       「跨账号建案误落部署账号」（`acea5ac`）的同一条教训。
    """
    from . import aws_session
    if aws_session.is_local(account_id):
        return _support
    sess = aws_session.get_session(str(account_id).strip())
    if sess is None:
        return None
    return sess.client("support", region_name=SUPPORT_REGION)

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


def failure_hint(result: "CaseResult", locale: str = "zh") -> str:
    """建案失败时结果卡上那句人话。**五个渲染点共用这一份**。

    为什么集中在这里：飞书 / Slack / 钉钉的案例面板 + 飞书 / Slack 的报告升级路径
    一共五处渲染 `CaseResult`，各写一条 `if code == ...` 的话，加一个错误码就得改五处，
    漏一处的表现是"客户看到一串 AWS 原始错误码"。

    未知错误码就回落到 AWS 的原始 message（截断）—— 那比一句笼统的"失败了"有用。
    """
    code = (result.error_code or "").strip()
    if code == "SubscriptionRequiredException":
        return i18n.t("case.create.fail_subscription", locale)
    if code == CROSS_ACCOUNT_ERROR_CODE:
        return i18n.t("case.create.fail_cross_account", locale)
    if code == WRITE_NOT_GRANTED_ERROR_CODE:
        return i18n.t("case.create.fail_write_not_granted", locale)
    if code == SUPPORT_READ_DENIED_ERROR_CODE:
        return i18n.t("case.create.fail_support_read_denied", locale)
    return (result.error_message or "")[:300]


#: `case_capability` 的结论缓存（进程内，account -> (时间戳, 结论)）。
#: 与 web 侧 `agent-build/.../core/support_cases.py` 同一个 TTL。
_CAP_TTL_SEC = 900
_cap_cache: dict[str, tuple[float, dict]] = {}


def case_capability(account_id: str = "", *, use_cache: bool = True) -> dict:
    """这个账号**现在**能不能开 support case —— 在弹面板之前先探一次。

    返回 `{"ok": True}` 或 `{"ok": False, "reason": ..., "code": ...}`；
    `reason` ∈ `cross_account_unavailable` | `support_plan_required` | `access_denied`。
    `code` 是给结果卡用的错误码（可直接喂 `failure_hint`）。

    为什么探：IM 的案例面板要用户挑严重级别、服务、类别、正文。这些全填完点提交，
    才因为"这个成员账号是 Basic 计划"被拒，是最差的体验。探针用
    `describe_severity_levels` —— Support API 里最便宜的只读调用，与建案受同一个
    支持计划闸门。

    ⚠️ **探针探不出"缺写权限"**：`DescribeSeverityLevels` 属只读，`ReadOnlyAccess`
       就给了。所以成员账号把 `EnableSupportCaseWrite` 关掉时这里仍然返回 ok，
       真正的拒绝发生在 `create_case`，由那里翻成
       `WRITE_NOT_GRANTED_ERROR_CODE` 明说是哪一项授权、怎么打开。
       这是有意的取舍：唯一能提前测出写权限的办法是真开一个工单，
       或者依赖成员账号的 `iam:SimulatePrincipalPolicy`（多一个 IAM 依赖、
       还测不到 SCP），代价都比"最后一步给一句准确的话"大。

    拿不准时（限流、网络抖动、未知错误码）**一律返回 ok** —— 宁可让客户走到真正建案
    那一步看到确切报错，也不要因为一次抖动就断言"你开不了工单"。

    探针成功时顺手把**这个计划真的允许的严重等级**（`severities`，元组）带回来 ——
    Basic/Developer 没有 `urgent` / `critical`，把它们印进选项里就是让客户挑一个
    会被 AWS 拒收的值。取不到那一项的调用方走 `plan_severities()`（见那边）。
    """
    key = str(account_id or "").strip() or "_local"
    now = time.monotonic()
    if use_cache:
        hit = _cap_cache.get(key)
        if hit and now - hit[0] < _CAP_TTL_SEC:
            return dict(hit[1])

    client = support_client(account_id)
    if client is None:
        # 不缓存：账号随时可能在 Web 上被启用/上车。
        return {"ok": False, "reason": "cross_account_unavailable",
                "code": CROSS_ACCOUNT_ERROR_CODE}

    try:
        resp = client.describe_severity_levels()
        verdict = {"ok": True, "severities": _plan_severities(resp)}
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code == "SubscriptionRequiredException":
            verdict = {"ok": False, "reason": "support_plan_required",
                       "code": code}
        elif code in _DENIED_CODES:
            verdict = {"ok": False, "reason": "access_denied",
                       "code": SUPPORT_READ_DENIED_ERROR_CODE,
                       "aws_code": code}
        else:
            logger.info("case_capability inconclusive (%s) — treating as available",
                        code or type(e).__name__)
            return {"ok": True, "probe_error": code}
    except Exception as e:  # noqa: BLE001
        logger.info("case_capability probe failed (%s) — treating as available",
                    type(e).__name__)
        return {"ok": True, "probe_error": type(e).__name__}

    _cap_cache[key] = (now, dict(verdict))
    return verdict


def _plan_severities(resp: dict) -> tuple[str, ...]:
    """`DescribeSeverityLevels` 的响应 → 这个计划允许的 severity code。

    回**元组**（不可变）是有意的：`case_capability` 的缓存命中走
    `dict(hit[1])`，那是浅拷贝 —— 换成 list 的话调用方一个 `.remove()` 就把
    进程内缓存改脏了，而那种 bug 只在第二个用户身上出现。

    顺序以 `SEVERITY_CODES` 为准（低→高），而不是 API 的返回顺序：选项编号
    「1 低 … 5 严重」在两个账号之间必须一致，否则用户凭记忆打「4」会挑错。
    认不出一个（AWS 加了新档）就整个回空 → 调用方回落到全部五档。
    """
    try:
        codes = {str(lv.get("code") or "").strip().lower()
                 for lv in (resp or {}).get("severityLevels") or []}
    except Exception:  # noqa: BLE001 —— 探针的附加值，绝不许因为它让探针失败
        return ()
    out = tuple(c for c in SEVERITY_CODES if c in codes)
    return out if out else ()


def plan_severities(cap: dict) -> tuple[str, ...]:
    """`case_capability()` 的结论 → 可选的 severity code（低→高）。

    没有 `severities` 那一项（探针抖动那两条 `probe_error` 路径、或者调用方自己
    造的 `{"ok": True}`）就回**全部五档**：宁可多给一个选项让 AWS 自己拒，也不要
    把客户真的需要的 `critical` 藏起来。
    """
    got = tuple((cap or {}).get("severities") or ())
    return got or tuple(SEVERITY_CODES)


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


def overrides_cover_classification(service_text: str = "",
                                   issue_type: str = "") -> bool:
    """用户填的服务 + 案例类型是不是**已经把分类器的全部输出盖满了**？

    `classify()` 只产出三样东西：`serviceCode`、`categoryCode`、`issueType`。
    服务一旦在目录里匹配到、且它名下有类别，`apply_case_overrides` 会把前两样
    **一起**换掉（类别必须跟着服务走，否则是非法组合）；`issueType` 是合法 code
    时第三样也被换掉。三样全被盖 ⇒ 那次分类调用的结果一个字都不会进 CreateCase，
    纯属白烧 token（钉钉案例模版把这两栏都做成了带默认值的必答项，所以这条路很常走）。

    只看**能不能盖满**，不做任何 AWS 写操作；判据与 `apply_case_overrides` 里的
    分支一一对应 —— 那边改了这边必须跟着改，否则会跳过一次其实需要的分类。
    `category_text` 不参与：它只在**已定下来的服务**名下反查，盖不住 `serviceCode`。
    """
    if (issue_type or "").strip().lower() not in ISSUE_TYPE_CODES:
        return False
    if not (service_text or "").strip():
        return False
    hit = case_classifier.resolve_service(service_text)
    # `category` 为空 = 那个服务名下没有类别，`apply_case_overrides` 会整条放弃并
    # 保留分类器的挑选 —— 这种情况下分类**必须**跑。
    return bool(hit and hit.get("code") and hit.get("category"))


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
                category_text: str = "", account_id: str = "") -> CaseResult:
    """Classify the investigation and call support:CreateCase.

    Pure logic — no card rendering, no Feishu/Slack SDK calls.
    Returns a CaseResult the caller renders into a platform-specific card.

    `service_text` / `issue_type` / `category_text` 是**面板里用户填的**（IM 端
    2026-09-03 补服务与类型、2026-09-04 补类别，与 web 端案例面板对齐）。全部留空
    = 完全交给分类器，即历史行为。

    `account_id`（2026-09-07，案例多账号）：工单开在**哪个账号**下。空 = 部署账号
    （历史行为）。非空且拿不到那个账号的凭证时返回
    `CaseResult(ok=False, error_code=CROSS_ACCOUNT_ERROR_CODE)` ——
    **绝不**悄悄开到部署账号去。

    ⚠️ 客户端拿到的 `caseId` 是**账号内**唯一的，跨账号看不到；所以后续的
    `describe_case` / `add_communication` / `resolve_case` 必须带同一个 `account_id`
    （卡片按钮里会把它随 `action_value` 一起带上，见两个 `case_flow.py`）。
    """
    if severity not in SEVERITY_CODES:
        return CaseResult(ok=False, error_code="InvalidSeverity",
                          error_message=f"unknown severity: {severity}")
    if language not in LANGUAGE_CODES:
        language = DEFAULT_LANGUAGE

    client = support_client(account_id)
    if client is None:
        # 分类器还没跑，所以这里没有 classification —— 有意的：跨账号拿不到凭证时
        # 连那次（全 IM 最贵的一次输入）都不该烧。
        logger.warning("create_case refused: no credentials for target account")
        return CaseResult(ok=False, error_code=CROSS_ACCOUNT_ERROR_CODE,
                          error_message="cross-account credentials unavailable")

    subject = build_subject(ctx, platform)
    body = build_body(ctx, severity, extra, operator_name, platform)

    if overrides_cover_classification(service_text, issue_type):
        # 用户把服务和案例类型都填了、且服务在目录里匹配得上 —— 分类器那三个输出
        # 会被 `apply_case_overrides` 全部覆盖掉，跑它等于白烧一次最贵的输入。
        # 这里的种子值只是占位，下一行就会被逐个盖掉；`reason` 如实写成人填的。
        classification = {
            "serviceCode": case_classifier.FALLBACK_SERVICE,
            "categoryCode": case_classifier.FALLBACK_CATEGORY,
            "issueType": DEFAULT_ISSUE_TYPE,
            "reason": "user-specified (classifier skipped)",
        }
        logger.info("Case classification skipped: overrides cover it (0 token)")
    else:
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
        resp = client.create_case(
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
            d = client.describe_cases(
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
        if code in _DENIED_CODES:
            # 没权限建案 = 那个账号的 NotiOps 角色缺 `support:CreateCase`。换成自己的码，
            # 结果卡才能说出"是哪一项授权、在哪打开"，而不是甩一句 AccessDeniedException
            # 让客户以为 NotiOps 坏了。原始码保留在 message 里便于排查。
            return CaseResult(ok=False,
                              error_code=WRITE_NOT_GRANTED_ERROR_CODE,
                              error_message=f"{code}: {msg}",
                              classification=classification)
        return CaseResult(ok=False, error_code=code, error_message=msg,
                          classification=classification)
    except Exception as e:
        logger.exception("CreateCase unexpected error")
        return CaseResult(ok=False, error_code="UnexpectedError",
                          error_message=str(e), classification=classification)
