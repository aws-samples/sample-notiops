"""
DevOps Agent Investigation Report Handler

Triggered by EventBridge when a DevOps Agent investigation completes or fails.
1. Fetches the investigation summary from the DevOps Agent API
2. Wraps it in a styled HTML report
3. Uploads to S3
4. Generates a 7-day pre-signed GET URL
5. Routes the report back to the originating Feishu chat thread
   (looked up in DynamoDB by incident_id, which the bot embeds in the
   task description as a routing tag)

Environment Variables:
  S3_BUCKET:                  S3 bucket name (required; deploy-injected unique name, no hardcoded default)
  PRESIGN_EXPIRY:             Pre-signed URL expiry in seconds (default: 604800)
  FEISHU_CONVERSATIONS_TABLE: DynamoDB table written by the feishubot stack
  FEISHU_APP_ID_ARN:          Secrets Manager ARN of Feishu App ID
  FEISHU_APP_SECRET_ARN:      Secrets Manager ARN of Feishu App Secret
"""

import boto3
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum

from shared.report_delivery.html_template import generate_html_report
from shared.report_delivery.trace_template import generate_trace_html

# Per-platform sender modules (feishu_sender, slack_sender, dingtalk_sender)
# are imported lazily through _load_sender() below so the handler keeps
# working when any single platform module is missing or broken.

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# S3 目标桶必须由部署环境注入（CDK 生成的、含账号+区域的唯一名，如
# notiops-data-<account>-<region>）。**不使用硬编码字面量兜底**——固定的可预测桶名
# 会带来 S3 bucket-squatting 风险（他人可预先抢注同名桶）。未注入则留空，
# 写入前 _require_bucket() 显式报错，绝不静默写到一个可被抢注的名字。
S3_BUCKET = (os.environ.get("S3_BUCKET")
             or os.environ.get("DATA_BUCKET")
             or os.environ.get("SKILLS_BUCKET")
             or "")
PRESIGN_EXPIRY = int(os.environ.get("PRESIGN_EXPIRY", "604800"))

# Degraded summary_card hard cap (≈16KB). When Bedrock summarization fails we
# fall back to a TRUNCATED slice of long_report as the card; this bound keeps
# the DDB investigation row well under the 400KB item limit (H7 fix, degrade
# branch). The full long_report still goes to S3 (single source of truth).
_DEGRADE_CARD_MAX_CHARS = 16000
# New name; old FEISHU_CONVERSATIONS_TABLE kept as fallback during the
# Phase 3 transition — both env vars resolve to the same table.
CONVERSATIONS_TABLE = (os.environ.get("CONVERSATIONS_TABLE")
                      or os.environ.get("FEISHU_CONVERSATIONS_TABLE", ""))

# Per-platform sender registry: platform slug -> module exposing
# send_report() and send_live_console_link(). Keep imports lazy and
# defensive so a missing/broken platform module doesn't kill the handler.
_SENDERS: dict = {}


def _load_sender(platform: str):
    if not platform:
        return None
    if platform in _SENDERS:
        return _SENDERS[platform]
    sender = None
    try:
        if platform == "feishu":
            from shared.report_delivery import feishu_sender as sender  # type: ignore
        elif platform == "slack":
            from shared.report_delivery import slack_sender as sender  # type: ignore
        elif platform == "dingtalk":
            from shared.report_delivery import dingtalk_sender as sender
    except ImportError as e:
        logger.warning("No sender module for platform=%s: %s", platform, e)
        sender = None
    _SENDERS[platform] = sender
    return sender


devops_client = boto3.client("devops-agent")
s3_client = boto3.client("s3")

# Lazy-init DDB table — avoids crash when CONVERSATIONS_TABLE is not yet
# set at import time (e.g. when callback handler imports this module before
# the env var is fully resolved).
_ddb_table = None


def _get_ddb_table():
    global _ddb_table
    if _ddb_table is None:
        table_name = (os.environ.get("CONVERSATIONS_TABLE")
                      or os.environ.get("FEISHU_CONVERSATIONS_TABLE", ""))
        if table_name:
            _ddb_table = boto3.resource("dynamodb").Table(table_name)
    return _ddb_table


# Backwards-compat alias — some helpers below still reference the old name.
# Removed once we convert all helpers to the platform-routed flow.
_feishu_ddb_table = None


# ===========================================================================
# Platform-agnostic report pipeline (Req 1/2/3/4)
# ===========================================================================
@dataclass
class ReportArtifacts:
    """Output of build_investigation_report.

    summary_card: the single short representation (Bedrock card, or — on
        degrade — a TRUNCATED long_report slice capped at _DEGRADE_CARD_MAX_CHARS).
    long_report: full markdown source (for support-context case body; NOT
        inlined into the DDB row).
    report_md_key / report_html_key / trace_html_key: stable S3 keys; None when
        that object failed to upload.
    report_url / trace_url: freshly-minted presigned GET URLs (for delivery).
    report_available: False when any critical step failed (degraded result).
    report_truncated: True when summary_card is a truncated long_report slice.
    model_id: Bedrock model used (None on degrade/no-summary).
    journal_records: the sliced journal records this run already fetched for
        trace.html. Exposed so downstream gates do not re-fetch — see the
        attribute's own note.
    """
    summary_card: str = ""
    long_report: str | None = None
    report_md_key: str | None = None
    report_html_key: str | None = None
    trace_html_key: str | None = None
    report_url: str | None = None
    trace_url: str | None = None
    report_available: bool = False
    report_truncated: bool = False
    model_id: str | None = None
    incident_id: str = ""
    journal_records: tuple[dict, ...] | None = None
    """本次已拉到的 journal 记录（已按 `slice_after_ts` 切过）。

    ⚠️ **不是**为了让调用方再解析一遍报告 —— 正文走 `long_report`。
    它存在的唯一理由是 `inspection/domain/journal_gate.py` 那道 skill 加载门禁
    需要原始记录，而 trace.html 那一步**已经拉过一次**。不暴露的话下游要
    再发一次 `ListJournalRecords`（跨账号、逐页），而那次调用拿的是同一批数据。

    ⚠️ 只在内存里传递，**SHALL NOT 落库**：实测单次调查 92 条记录、其中
    `ui_investigation_summary` 单条 6.8KB —— 落 DDB 会直接撞 400KB 行上限。

    `None` = 没拉到（trace 那步失败或权限不足）。与空元组是两回事：
    前者是「不知道」，后者是「确实没有记录」，门禁对两者的判定相同
    （都判 `NO_JOURNAL`）但日志要能区分。
    """


class CardMode(str, Enum):
    """`summary_card` 怎么产出（R9.4）。

    ⚠️ 枚举而不是布尔。布尔只能表达「要不要卡片」，而这里有**三种**语义，
    其中两种在布尔下会被压成同一个值：

    ```
    BEDROCK   调 Bedrock 摘要，失败降级成截断片段   ← 排障链路，默认
    SKIP      压根不调 Bedrock，卡片留一行占位文本   ← 巡检链路
    ```

    🔴 `SKIP` **不等于**「把 `long_report` 原样放进 `summary_card`」。
    那是 明写要避免的错：`_summarize_with_degrade` 是函数体内
    第 ② 步且原本无开关，直接跳过会让 DA 全文进 `summary_card`，
    撞 `_DEGRADE_CARD_MAX_CHARS`(16000) 上界 —— 也就是重开 H7
    （DDB 行被一段几万字符的正文撑爆）。

    ⚠️ 巡检为什么不要卡片：`summary_card` 是给 IM 卡片显示用的短表示，
    而巡检不投 IM 卡片（走 Phase 10 的广播层）。它要的是 `long_report`
    —— 按 finding_id 分节的判读全文，回拼时要逐节解析。
    多调一次 Bedrock 只是白花钱，还会把已经结构化的分节文本重新压成散文。
    """

    BEDROCK = "bedrock"
    SKIP = "skip"


_SKIP_CARD_PLACEHOLDER = "（巡检判读，详见完整报告）"
"""`CardMode.SKIP` 时 `summary_card` 的内容。

⚠️ 是一行占位文本而不是空串：`summary_card` 会进 DDB 行并被列表 UI 读，
空串会让那一行在列表里显示成一片空白，看起来像「调查失败了」。
"""


class TextSource(str, Enum):
    """`long_report` 从哪条 journal 记录取（2026-08-31 实测定的）。

    ## 为什么需要这个开关

    两个调用方要的**不是同一段文字**，而在此之前它们共用一条固定顺序的
    fallback 链 —— 于是巡检永远取不到它要的那段。

    ```
    排障   要 DA 的成品报告      投 IM 卡片、给客户读、喂 Bedrock 摘要
    巡检   要 agent 的自由输出   按 `## <finding_id>` 分节，逐节回拼到 finding 行
    ```

    🔴 `investigation_summary_md` 是 **DA 服务端按固定模板渲染的产物**，
    不是 agent 的自由输出。两次独立实测都确认：

    ```
    2026-08-20  一次与巡检无关的排障调查，92 条 journal 逐类核对
                → 内容恒为 `# Investigation Summary` + Symptoms/Findings/Root Cause
                  （见 agent-build/.../core/devops_agent.py 的实测注释）
    2026-08-20  一个**没有账号关联**的 space：DA 一条真实数据都读不到、
                finding 记录 0 条，而 investigation_summary_md 照样产出
                一份格式完好的报告（见 inspection/domain/journal_gate.py
                的 NO_DATA_ACCESS 一档）
    ```

    ⇒ skill 要求的 `## <finding_id>` 信封**永远不会**出现在那个字段里，
      与 skill 有没有加载无关。

    ## 实测证据（2026-08-31，部署账号）

    两次真实判读，`utilization.skills.bundles` 都是 `['inspection-cost-idle']`
    —— skill 加载了、加载的是对的那份。agent 也确实按信封写了：

    ```
    ## 444455556666#us-east-1#elasticache#notiops-tb-redis-us-east-1-001#idle#-
    **verdict**: `expected_behaviour`
    **evidence**: …
    ```

    那段文字在 **assistant message** 记录里。拿同一批数据跑 `parse_sections`：

    ```
    investigation_summary_md（改动前实际取的）   892 字符 → parse_failed  0 节
    末条 assistant message（agent 自由输出）    2046 字符 → ok          1 节 ✅
    ```

    判读一直都在、可解析，被取正文这一步扔掉了。

    ⚠️ `AGENT_OUTPUT` 只是把 message 提到**第一位**，不是删掉其余三级。
    agent 那条取不到时仍然退回成品报告 —— 那时 `parse_sections` 会如实标
    `parse_failed` 并保留原文，而那是能看出问题的形态。

    ⚠️ 顺序改了之后 `long_report` 也是写进 S3 的那一段，这是**要的** ——
    `ParseResult.raw` 的契约是「分节解析的正确性只能靠事后对照原文验证」。
    S3 里放一段与被解析文本不同的文字，等于把那个验证变成不可回答的问题。
    """

    PRODUCT_REPORT = "product_report"
    """DA 成品报告优先（既有行为，排障链路）。"""

    AGENT_OUTPUT = "agent_output"
    """agent 自由输出优先（巡检链路）。"""


def _text_source_of(value: "TextSource | str | None") -> "TextSource":
    """把入参归一成 `TextSource`。认不出的值**回落到 PRODUCT_REPORT**。

    ⚠️ 与 `_card_mode_of` 同一条理由：`build_investigation_report` 的契约是
    「从不抛异常」。回落方向是既有行为，拼错时排障链路不变。
    """
    if isinstance(value, TextSource):
        return value
    try:
        return TextSource(str(value or "").strip().lower())
    except ValueError:
        logger.warning("未知 text_source=%r，按 %s 处理", value,
                       TextSource.PRODUCT_REPORT.value)
        return TextSource.PRODUCT_REPORT


def _stable_keys(
    task_id: str, *, key_prefix: str = "investigations"
) -> tuple[str, str, str]:
    """S3 的三个固定 key。

    ⚠️ `key_prefix` 可分流（R9.4b）：巡检报告与排障报告
    落在同一个 `investigations/<task_id>/` 前缀下时，
    「按前缀列出全部排障报告」会把巡检的也列出来，而两者的读者不同
    （前者给客户看，后者给巡检看板拼装）。分前缀让 S3 侧的生命周期策略
    也能分别设置 —— 巡检报告每天产出，保留期需要比排障短。

    ⚠️ 前缀里的 `/` 由本函数拼，调用方 SHALL NOT 自带尾斜杠 ——
    自带会拼出 `insp//<task_id>/report.md`，那是一个**合法但不同**的 key，
    于是写进去的对象再也读不出来（读侧用的是规范化后的 key）。
    """
    p = (key_prefix or "investigations").strip().strip("/")
    base = f"{p}/{task_id}"
    return f"{base}/report.md", f"{base}/report.html", f"{base}/trace.html"


INSPECTION_KEY_PREFIX = "inspections"
"""巡检报告的 S3 前缀。与排障的 `investigations` 分开，见 `_stable_keys`。"""


def _card_mode_of(value: CardMode | str | None) -> CardMode:
    """把入参归一成 `CardMode`。认不出的值**回落到 BEDROCK**。

    ⚠️ 认不出时 SHALL NOT 抛 —— `build_investigation_report` 的整体契约是
    「从不抛异常」（外层大 try/except，任何错误只降级成
    `report_available=False`）。为一个拼错的字符串抛异常会让整条 callback
    进 DLQ，而那是比「多调一次 Bedrock」严重得多的后果。

    ⚠️ 回落方向是 BEDROCK 而不是 SKIP：前者是既有行为，
    拼错时保持老路径不变；回落到 SKIP 会让排障卡片静默变成一行占位文本。
    """
    if isinstance(value, CardMode):
        return value
    try:
        return CardMode(str(value or "").strip().lower())
    except ValueError:
        logger.warning("未知 card_mode=%r，按 %s 处理", value, CardMode.BEDROCK.value)
        return CardMode.BEDROCK


def _summarize_with_degrade(long_report: str | None) -> tuple[str, str | None, bool]:
    """Bedrock summarize → (summary_card, model_id, truncated).

    On Bedrock/config failure, degrade to a TRUNCATED long_report slice
    (≤ _DEGRADE_CARD_MAX_CHARS) so the DDB row stays bounded (H7 degrade-branch
    fix). When long_report is empty, return a placeholder card.
    """
    if not long_report or not long_report.strip():
        return "调查已完成，但未能获取报告内容。", None, False
    from shared.bedrock_summarizer import summarize_investigation
    from shared.summarizer_config import load_summarizer_config

    model_id = None
    try:
        config = load_summarizer_config()
        model_id = config["model_id"]
        card = summarize_investigation(
            long_report=long_report, model_id=model_id,
            agent_prompt=config.get("agent_prompt"),
            # 协议 / 区域随 model_id 一起从目录投影下来。少了它们，只在
            # bedrock-mantle 上架的模型会被当成 Converse 调，报「model identifier
            # is invalid」，然后整段降级成截断的长报告 —— 归因很难。
            model_kind=config.get("model_kind", ""),
            model_region=config.get("model_region", ""),
        )
        return card, model_id, False
    except Exception as e:
        logger.warning("Bedrock summarize failed, degrading to truncated "
                       "long_report (cap=%d): %s", _DEGRADE_CARD_MAX_CHARS, e)
        card = long_report[:_DEGRADE_CARD_MAX_CHARS]
        if len(long_report) > _DEGRADE_CARD_MAX_CHARS:
            card += "\n\n…（摘要降级：内容已截断，完整报告见「查看完整报告」）"
        return card, model_id, True


def build_investigation_report(*, execution_id: str, target_account_id: str,
                               task_id: str, detail: dict,
                               event_status: str,
                               incident_id: str = "",
                               card_mode: CardMode | str = CardMode.BEDROCK,
                               key_prefix: str = "investigations",
                               account_already_authorized: bool = False,
                               text_source: TextSource | str = (
                                   TextSource.PRODUCT_REPORT),
                               ) -> ReportArtifacts:
    """Single-source-of-truth report pipeline (completed investigations).

    ① cross-account fetch long_report ONCE (4-level fallback + slice)
    ② Bedrock → summary_card (degrade w/ truncation)
    ③ write S3 stable keys investigations/<task_id>/report.md|report.html|trace.html
    ④ return ReportArtifacts

    Wrapped in an outer try/except: ANY uncaught error degrades to
    report_available=False with whatever pointers succeeded — NEVER raises, so
    the caller's terminal upsert is never gated (H7/DLQ prevention).

    task_id empty → returns an empty (report_available=False) artifact WITHOUT
    writing any degenerate S3 key (Req 1.6 / Property 7).

    `account_already_authorized`: 调用方已确认 `target_account_id` 是我们登记的
    账号 → 跳过 `LOCKED_ACCOUNT_ID` 闸门（两个取正文的下游调用都会带上它）。
    🔴 不传它时，成员账号的报告会**静默降级**：`long_report=None`、trace 为空，
    而 `report_available` 仍为真、S3 对象与链接都正常 —— 巡检那侧收敛到
    `parse_status="empty"`，看板上与「DA 说这些没问题」长得一样。
    语义与正当性见 `shared.devops_agent.build_cross_account_devops_client`。

    `incident_id`: when empty, recovered from journal records (also yields the
    slice cutoff timestamp for multi-incident isolation); surfaced on the
    returned artifact for the delivery step to route on.

    `card_mode` / `key_prefix` / `text_source`: all three default to the
    existing behaviour so that callers written before they existed need no
    change (R9.4). Inspection passes `CardMode.SKIP` +
    `INSPECTION_KEY_PREFIX` + `TextSource.AGENT_OUTPUT`: it never shows an IM
    card, its S3 objects live under their own prefix, and it needs the agent's
    own `## <finding_id>`-sectioned output rather than DA's product report.
    See `CardMode` for why SKIP is not "put long_report into summary_card",
    and `TextSource` for the measured reason the product report can never
    carry that envelope.

    🔴 `text_source` 不由 `card_mode` 推导。两者恰好都在巡检那侧取非默认值，
    但表达的是**无关**的两件事（要不要 IM 卡片 / 取哪段文字）。绑在一起之后，
    任何一方将来需要单独调整都会连带改掉另一方的行为 —— 这正是
    `account_already_authorized` 那段注释拒绝按 `is_inspection` 分岔的理由。
    """
    artifacts = ReportArtifacts(incident_id=incident_id)
    if not task_id:
        logger.warning("build_investigation_report: empty task_id, skipping "
                       "S3/pointer writes (execution_id=%s)", execution_id)
        return artifacts
    try:
        metadata = (detail or {}).get("metadata", {}) or {}
        data = (detail or {}).get("data", {}) or {}
        from shared.devops_agent import (
            build_cross_account_devops_client,
            list_journal_records_cross_account,
        )
        client, xa_space_id = build_cross_account_devops_client(
            target_account_id, source="fetch-report",
            account_already_authorized=account_already_authorized)
        agent_space_id = metadata.get("agent_space_id", "") or xa_space_id or ""

        # Recover incident_id + slice cutoff when not supplied (DevOps Agent's
        # triage may merge multiple incidents into one execution; slice keeps
        # only this incident's records — multi-incident isolation, design A5).
        slice_after_ts = None
        if not incident_id:
            incident_id, slice_after_ts = _extract_incident_id_from_records(
                agent_space_id, execution_id, client=client)
        artifacts.incident_id = incident_id

        report_md_key, report_html_key, trace_html_key = _stable_keys(
            task_id, key_prefix=key_prefix)
        common = dict(
            status=data.get("status", "UNKNOWN"),
            priority=data.get("priority", "UNKNOWN"),
            detail_type="Investigation Completed",
            task_id=task_id, execution_id=execution_id,
            agent_space_id=agent_space_id,
            created_at=data.get("created_at", ""),
            updated_at=data.get("updated_at", ""),
        )

        # ① fetch long_report ONCE (cross-account client injected + slice)
        summary_record_id = data.get("summary_record_id", "")
        long_report = fetch_investigation_results(
            agent_space_id, execution_id, summary_record_id,
            slice_after_ts=slice_after_ts, client=client,
            text_source=text_source)
        artifacts.long_report = long_report

        # ② Bedrock summarize → summary_card (degrade w/ truncation)
        #
        # ⚠️ `CardMode.SKIP` 走的是「给一行占位文本」，**不是**「把 long_report
        #    原样放进 summary_card」。后者会撞 _DEGRADE_CARD_MAX_CHARS 上界
        #    并把 DDB 行撑爆 —— 也就是重开 H7（明写要避免）。
        if _card_mode_of(card_mode) is CardMode.SKIP:
            summary_card, model_id, truncated = _SKIP_CARD_PLACEHOLDER, None, False
        else:
            summary_card, model_id, truncated = _summarize_with_degrade(long_report)
        artifacts.summary_card = summary_card
        artifacts.model_id = model_id
        artifacts.report_truncated = truncated

        # ③ write S3 stable keys (pointer set only AFTER successful upload, so
        #    pointer-non-empty ⇔ object-exists holds — Property 4)
        upload_to_s3(long_report or "", report_md_key,
                     content_type="text/markdown; charset=utf-8")
        artifacts.report_md_key = report_md_key

        report_html = generate_html_report(summary_md=long_report or "", **common)
        upload_to_s3(report_html, report_html_key)
        artifacts.report_html_key = report_html_key
        artifacts.report_url = generate_presigned_url(report_html_key)

        # trace.html — cross-account full record listing (best-effort), sliced
        try:
            records = list_journal_records_cross_account(
                execution_id=execution_id, target_account_id=target_account_id,
                account_already_authorized=account_already_authorized,
                # 🔴 **必须传本函数已经解析出来的 space。** 那个函数默认去读
                #    `da#<acct>.agent_space_id`（**排障** space），而巡检的
                #    execution 活在 `inspect_agent_space_id` 里 —— 不传的表现是
                #    巡检的 trace.html 恒空 + skill 门禁恒判 no_journal
                #    （同一次回调里「正文取到了、trace 是空的」）。
                #    这里的 `agent_space_id` 来自事件 metadata，是 DA 盖章的。
                agent_space_id=agent_space_id)
            records = _filter_after_ts(records, slice_after_ts)
            # ⚠️ 在 trace.html 之**前**挂上：下面几步（渲染 / 上传 / presign）
            #    任一失败都会跳到 except，而门禁只要记录本身就够了 ——
            #    把赋值放在后面会让「trace 上传失败」连带把 skill 门禁也关掉，
            #    而那两件事完全无关。
            artifacts.journal_records = tuple(records or ())
            trace_html = generate_trace_html(records=records, **common)
            upload_to_s3(trace_html, trace_html_key)
            artifacts.trace_html_key = trace_html_key
            artifacts.trace_url = generate_presigned_url(trace_html_key)
        except Exception as e:
            logger.warning("trace.html build failed (non-fatal): %s", e)

        artifacts.report_available = True
    except Exception as e:
        logger.warning("build_investigation_report degraded "
                       "(report_available=false): %s", e)
        artifacts.report_available = False
    return artifacts


def _call_send_report(sender, platform: str, target: dict, *, status: str,
                      priority: str, detail_type: str, task_id: str,
                      summary_card: str, report_url: str | None,
                      trace_url: str | None, incident_id: str,
                      linked_case_display_id: str, next_steps: list,
                      locale: str) -> None:
    """Invoke sender.send_report with the report-link mapped to each platform's
    slot (dingtalk uses `html_url`, feishu/slack use `report_url`) and
    summary_card passed via the existing `summary_md` slot. locale-aware with
    TypeError fallback for older senders."""
    kwargs = dict(
        chat_id=target["chat_id"], root_message_id=target["root_message_id"],
        status=status, priority=priority, detail_type=detail_type,
        task_id=task_id, trace_url=trace_url, summary_md=summary_card,
        incident_id=incident_id, linked_case_display_id=linked_case_display_id,
        next_steps=next_steps,
    )
    if platform == "dingtalk":
        kwargs["html_url"] = report_url
    else:
        kwargs["report_url"] = report_url
    try:
        sender.send_report(locale=locale, **kwargs)
    except TypeError:
        sender.send_report(**kwargs)


def _resolve_locale(target: dict, incident_id: str) -> str:
    locale = target.get("locale", "")
    if not locale:
        try:
            from core import locale_resolver as _lr
            locale = _lr.get_for_incident(incident_id) or "en"
        except Exception as e:
            logger.warning("report locale lookup failed: %s", e)
            locale = "en"
    return locale if locale in {"zh", "en"} else "en"


def deliver_report_card(*, artifacts: ReportArtifacts, incident_id: str,
                        task_id: str, agent_space_id: str, execution_id: str,
                        detail: dict) -> None:
    """Deliver the final report card from ReportArtifacts (NO second fetch).

    Routes to the originating chat, persists support context (case body =
    long_report[:7500], NOT summary_card), generates next-steps, sends the card
    via the platform sender, then marks the progress row completed.
    """
    data = (detail or {}).get("data", {}) or {}
    status = data.get("status", "UNKNOWN")
    priority = data.get("priority", "UNKNOWN")
    detail_type = "Investigation Completed"

    target = _resolve_chat_target(incident_id, task_id)
    if not target:
        logger.warning("deliver_report_card: no chat target incident_id=%s "
                       "task_id=%s; report stored but not delivered.",
                       incident_id, task_id)
        if incident_id:
            _mark_progress_row_completed(incident_id, "completed")
        return

    incident_id = incident_id or _backfill_incident_id(target, task_id)

    _persist_support_context(
        incident_id=incident_id, task_id=task_id, agent_space_id=agent_space_id,
        execution_id=execution_id, summary_md=(artifacts.long_report or ""),
        report_url=artifacts.report_url or "", trace_url=artifacts.trace_url or "",
        raw_text=target.get("raw_text", ""),
        intent_summary=target.get("intent_summary", ""),
        platform=target.get("platform", ""),
    )

    linked_case_display_id = _extract_case_display_id(incident_id)
    locale = _resolve_locale(target, incident_id)
    try:
        from core import next_steps as _ns
        ns_actions = _ns.generate(summary_md=artifacts.summary_card,
                                  status=status, locale=locale)
    except Exception as e:
        logger.warning("next_steps.generate failed: %s", e)
        # ⚠️ 空列表是**降级兜底**，不是「待收集的容器」。
        #    `scripts/lint_seams.py` 的③会把它报成「传出去之后没人读」——
        #    那条检查找的是「创建一个空列表收集痕迹，然后自己从不读它」
        #    （`skipped` 那个缺陷的形态）。这里正好相反：值由上面
        #    `_ns.generate()` 产出，空列表只是它失败时的替代，
        #    而它的**用途就是传给 sender**。已钉进 .seams_baseline.json。
        ns_actions = []

    sender = _load_sender(target.get("platform", ""))
    if sender:
        _call_send_report(
            sender, target.get("platform", ""), target,
            status=status, priority=priority, detail_type=detail_type,
            task_id=task_id, summary_card=artifacts.summary_card,
            report_url=artifacts.report_url, trace_url=artifacts.trace_url,
            incident_id=incident_id, linked_case_display_id=linked_case_display_id,
            next_steps=ns_actions, locale=locale,
        )
    else:
        logger.warning("No sender for platform=%s; incident_id=%s report stored "
                       "but not delivered.", target.get("platform"), incident_id)

    if incident_id:
        _mark_progress_row_completed(incident_id, "completed")


def _failure_case_body(event_status: str, status: str, task_id: str,
                       execution_id: str) -> str:
    """调查失败/超时时塞进案例正文的那段说明（英文 —— 读者是 AWS Support 工程师）。

    只有机器事实（状态 / task_id / execution_id），不含用户问题原文 —— 用户的问题本身
    由 `raw_text` / `intent_summary` 走 `build_body` 的既有字段带进去。
    """
    what = ("timed out" if event_status == "timed_out" else "failed")
    return (
        "## Automated investigation did not complete\n\n"
        f"NotiOps' automated investigation {what} before producing a report, "
        "so no findings are attached below. The customer is escalating from "
        "the failure notification card.\n\n"
        f"- Investigation status: `{status}`\n"
        f"- task_id: `{task_id or 'n/a'}`\n"
        f"- execution_id: `{execution_id or 'n/a'}`\n"
    )


def deliver_failure_card(*, incident_id: str, task_id: str, detail: dict,
                         event_status: str, agent_space_id: str = "",
                         execution_id: str = "",
                         target_account_id: str = "",
                         account_already_authorized: bool = False) -> None:
    """Deliver a failure/timeout card WITHOUT fetching long_report or writing
    S3 (Req 5.5). Routes to chat (if any) and marks the progress row terminal.

    incident_id is rarely echoed in callback events; when empty we recover it
    from the journal marker (cross-account client, same as the completed path)
    so the failure card still renders the 🆘 escalate-support button and the
    progress row finalizes on the correct key (instead of staying stuck on the
    live card until the 30-min TTL reaps it)."""
    if not incident_id and execution_id and target_account_id:
        try:
            from shared.devops_agent import build_cross_account_devops_client
            client, xa_space_id = build_cross_account_devops_client(
                target_account_id, source="fetch-failcard",
                account_already_authorized=account_already_authorized)
            eff_space_id = agent_space_id or xa_space_id or ""
            incident_id, _ = _extract_incident_id_from_records(
                eff_space_id, execution_id, client=client)
        except Exception as e:
            logger.warning("failure card incident_id recovery failed: %s", e)
    data = (detail or {}).get("data", {}) or {}
    status = data.get("status", event_status.upper())
    priority = data.get("priority", "UNKNOWN")
    detail_type = ("Investigation Failed" if event_status == "failed"
                   else "Investigation Timed Out")
    target = _resolve_chat_target(incident_id, task_id)
    if target:
        incident_id = incident_id or _backfill_incident_id(target, task_id)
        # 失败卡上照样渲染 🆘「升级到 AWS Support」按钮 —— 调查失败恰恰是最需要找人的
        # 时候。但这条路径以前**不写** `support#<incident_id>` 行，于是点 🆘 →
        # `load_support_context()` 返回 None → 客户看到"报告已过期"，而报告从来就没存在
        # 过。这里补一条：没有长报告可存（Req 5.5 明确不 fetch / 不写 S3），就存一句
        # 说明失败的正文，让案例里写清"自动调查失败/超时"而不是空白。
        _persist_support_context(
            incident_id=incident_id, task_id=task_id,
            agent_space_id=agent_space_id, execution_id=execution_id,
            summary_md=_failure_case_body(event_status, status, task_id,
                                          execution_id),
            report_url="", trace_url="",
            raw_text=target.get("raw_text", ""),
            intent_summary=target.get("intent_summary", ""),
            platform=target.get("platform", ""),
        )
        sender = _load_sender(target.get("platform", ""))
        if sender:
            locale = _resolve_locale(target, incident_id)
            _call_send_report(
                sender, target.get("platform", ""), target,
                status=status, priority=priority, detail_type=detail_type,
                task_id=task_id,
                summary_card=f"调查 {event_status}（task_id: {task_id}）",
                report_url=None, trace_url=None, incident_id=incident_id,
                linked_case_display_id=_extract_case_display_id(incident_id),
                next_steps=[], locale=locale,
            )
    if incident_id:
        _mark_progress_row_completed(incident_id, event_status)


# ===========================================================================
# Lambda Handler
# ===========================================================================
def lambda_handler(event, context):
    # 只记安全元数据（不 dump 完整 event —— 可能含用户内容/敏感字段）。
    logger.info(
        "Event received: source=%s detail-type=%s keys=%s",
        event.get("source"), event.get("detail-type"), sorted(event.keys()),
    )

    detail = event.get("detail", {})
    metadata = detail.get("metadata", {})
    data = detail.get("data", {})

    agent_space_id = metadata.get("agent_space_id", "")
    task_id = metadata.get("task_id", "")
    execution_id = metadata.get("execution_id", "")
    incident_id = (metadata.get("incident_id", "")
                   or data.get("incident_id", "")
                   or data.get("incidentId", ""))
    status = data.get("status", "UNKNOWN")
    priority = data.get("priority", "UNKNOWN")
    summary_record_id = data.get("summary_record_id", "")
    created_at = data.get("created_at", "")
    updated_at = data.get("updated_at", "")
    detail_type = event.get("detail-type", "")

    if not agent_space_id or not execution_id:
        return {"statusCode": 400, "body": "Missing agent_space_id or execution_id"}

    # ── Branch: Investigation In Progress → post a console deep-link card
    # and exit (no report to render yet).
    # DevOps Agent emits "Investigation Created" (PENDING_TRIAGE) →
    # "Investigation Linked" (if merged into existing execution) →
    # "Investigation In Progress" (IN_PROGRESS, agent actually starts working) →
    # "Investigation Completed". We pick "In Progress" because that's when
    # the execution_id is final and the agent is genuinely running.
    if detail_type == "Investigation In Progress":
        return _handle_investigation_started(
            agent_space_id=agent_space_id,
            execution_id=execution_id,
            task_id=task_id,
            incident_id=incident_id,
        )

    # DevOps Agent doesn't echo incidentId in callback events, and the sync
    # webhook response doesn't return task_id. The Feishu bot embeds a routing
    # tag in the task description like `<!--notiops:feishu-xxx-->` (or the
    # legacy form `<!--notiops-devops:...-->` for incidents dispatched
    # before the 2026-06 rename — _INCIDENT_TAG_RE accepts both).
    # Cross-account journal recovery happens inside build_investigation_report
    # (which has the injected cross-account client + slice handling).
    target_account_id = event.get("account", "")

    # Failure / timeout: deliver a failure card WITHOUT fetching or writing S3
    # (Req 5.5). The completed pipeline is reserved for actual reports.
    if detail_type in ("Investigation Failed", "Investigation Timed Out"):
        ev = "failed" if detail_type == "Investigation Failed" else "timed_out"
        deliver_failure_card(incident_id=incident_id, task_id=task_id,
                             detail=detail, event_status=ev,
                             agent_space_id=agent_space_id,
                             execution_id=execution_id,
                             target_account_id=target_account_id)
        return {"statusCode": 200, "body": json.dumps({"delivered": ev})}

    # Completed → single-source-of-truth pipeline (fetch ONCE → S3 → card),
    # then deliver from artifacts (NO second fetch).
    artifacts = build_investigation_report(
        execution_id=execution_id, target_account_id=target_account_id,
        task_id=task_id, detail=detail, event_status="completed",
        incident_id=incident_id,
    )
    deliver_report_card(
        artifacts=artifacts, incident_id=artifacts.incident_id or incident_id,
        task_id=task_id, agent_space_id=agent_space_id,
        execution_id=execution_id, detail=detail,
    )
    return {"statusCode": 200, "body": json.dumps({
        "report_md_key": artifacts.report_md_key,
        "report_html_key": artifacts.report_html_key,
        "report_url": artifacts.report_url,
        "trace_html_key": artifacts.trace_html_key,
        "report_available": artifacts.report_available,
    })}


# ===========================================================================
# Step 1: Fetch investigation results
# ===========================================================================
def fetch_investigation_results(agent_space_id, execution_id, summary_record_id,
                                slice_after_ts=None, client=None,
                                text_source=TextSource.PRODUCT_REPORT):
    """Fetch investigation content with 4-level fallback.

    `slice_after_ts` (ISO timestamp str): when provided, only records created
    at/after this time are considered. Used to isolate this incident's content
    from prior incidents that DevOps Agent's triage step merged into the same
    execution.

    `client` (optional): a cross-account devops-agent boto3 client injected by
    the report pipeline. When None, falls back to the module-level top-level
    client (本账户凭证) for backward compatibility.

    `text_source`: which record the caller actually wants first. See
    `TextSource` for the measured reason this is a knob and not a constant.
    **两种模式的候选集合完全相同，只有顺序不同** —— 任一模式下四级都会试完，
    所以没有哪一方会因为这个开关而拿不到内容。
    """
    order = _FETCH_ORDER[_text_source_of(text_source)]
    for level in order:
        text = _FETCH_LEVELS[level](
            agent_space_id, execution_id, slice_after_ts, client)
        if text:
            logger.info("Source: %s (%d chars, text_source=%s)",
                        level, len(text), _text_source_of(text_source).value)
            return text
    # 四级全空。返回空串而不是 None —— 调用方 (`_summarize_with_degrade` /
    # `upload_to_s3` / `parse_sections`) 都按字符串处理，None 会在三处各炸一次。
    logger.warning("取正文四级全空: execution_id=%s text_source=%s",
                   execution_id, _text_source_of(text_source).value)
    return ""


_FETCH_LEVELS = {
    "investigation_summary_md": lambda sp, ex, ts, cl: _try_record_type(
        sp, ex, "investigation_summary_md", ts, client=cl),
    "finding": lambda sp, ex, ts, cl: _try_record_type(
        sp, ex, "finding", ts, client=cl),
    "assistant_message": lambda sp, ex, ts, cl: _try_last_assistant_message(
        sp, ex, ts, client=cl),
    "all_records": lambda sp, ex, ts, cl: _try_all_records(
        sp, ex, ts, client=cl),
}
"""取正文的四个取数器。键名会进日志，改名要同步改 `_FETCH_ORDER`。"""

_FETCH_ORDER = {
    TextSource.PRODUCT_REPORT: (
        "investigation_summary_md", "finding", "assistant_message",
        "all_records"),
    TextSource.AGENT_OUTPUT: (
        # 🔴 `assistant_message` 在第一位是这个模式**唯一**的意义。
        #    实测：巡检要的 `## <finding_id>` 信封只在这一级里，而
        #    `investigation_summary_md` 是 DA 的模板报告、恒无信封 ——
        #    它排在前面时巡检 100% 落到 parse_failed（见 `TextSource`）。
        "assistant_message", "investigation_summary_md", "finding",
        "all_records"),
}
"""两种模式的取数顺序。

⚠️ 两个元组必须是**同一个集合的排列** —— 少一级会让那一档在该模式下
永久取不到，而表现是「偶发空报告」（取决于 DA 那次产出了哪些 recordType）。
`tests/test_report_text_source.py` 有一条元断言钉住这件事。
"""


def _try_record_type(agent_space_id, execution_id, record_type, slice_after_ts=None, client=None):
    try:
        records = _list_records(agent_space_id, execution_id, record_type, client=client)
        records = _filter_after_ts(records, slice_after_ts)
        parts = []
        for r in records:
            t = _extract_text(r.get("content", ""))
            if t and len(t) > 50:
                parts.append(t)
        return "\n\n---\n\n".join(parts) if parts else ""
    except Exception as e:
        logger.warning("Failed to fetch %s: %s", record_type, e)
        return ""


def _try_last_assistant_message(agent_space_id, execution_id, slice_after_ts=None, client=None):
    try:
        records = _list_records(agent_space_id, execution_id, "message", client=client)
        records = _filter_after_ts(records, slice_after_ts)
        last_text = ""
        for r in records:
            content = _parse_content(r.get("content", ""))
            if not isinstance(content, dict) or content.get("role") != "assistant":
                continue
            blocks = content.get("content", [])
            if isinstance(blocks, str):
                try:
                    blocks = json.loads(blocks)
                except (json.JSONDecodeError, TypeError):
                    if len(blocks) > 100:
                        last_text = _clean(blocks)
                    continue
            if isinstance(blocks, list):
                msg_parts = []
                for b in blocks:
                    if isinstance(b, dict) and b.get("type") == "text":
                        t = b.get("text", "")
                        if t and len(t) > 100:
                            msg_parts.append(_clean(t))
                if msg_parts:
                    combined = "\n\n".join(msg_parts)
                    if len(combined) > len(last_text):
                        last_text = combined
        return last_text
    except Exception as e:
        logger.warning("Failed to extract assistant messages: %s", e)
        return ""


def _try_all_records(agent_space_id, execution_id, slice_after_ts=None, client=None):
    try:
        records = _list_records(agent_space_id, execution_id, client=client)
        records = _filter_after_ts(records, slice_after_ts)
        parts = []
        for r in records:
            rt = r.get("recordType", "")
            if rt in ("tool_use", "tool_result", "thinking", "system"):
                continue
            content = _parse_content(r.get("content", ""))
            if isinstance(content, dict):
                if content.get("role") == "user":
                    continue
                t = _extract_text(content)
            elif isinstance(content, str):
                t = content if not content.strip().startswith("{") else ""
            else:
                t = ""
            t = t.strip()
            if t and len(t) > 30:
                parts.append(t)
        return "\n\n---\n\n".join(parts) if parts else "No investigation content available."
    except Exception as e:
        logger.error("All fetch attempts failed: %s", e)
        return f"Error: {e}"


# ===========================================================================
# Content extraction helpers
# ===========================================================================
def _parse_content(content):
    if isinstance(content, str):
        try:
            return json.loads(content)
        except (json.JSONDecodeError, TypeError):
            return content
    return content


def _extract_text(content):
    if isinstance(content, str):
        return _clean(content)
    if isinstance(content, dict):
        for key in ("text", "markdown", "summary", "description", "message"):
            if key in content and isinstance(content[key], str):
                return _clean(content[key])
        if content.get("role") == "assistant":
            blocks = content.get("content", [])
            if isinstance(blocks, list):
                parts = [_clean(b["text"]) for b in blocks
                         if isinstance(b, dict) and b.get("type") == "text" and b.get("text")]
                return "\n\n".join(parts)
    return ""


# Both `notiops:` (post-rename) and `notiops-devops:` (legacy in-flight
# incidents) accepted. The legacy form can be retired after the 24h TTL
# window has cleared all `incident#*` DDB rows minted before the rename.
_INCIDENT_TAG_RE = re.compile(
    r"<!--(?:notiops|notiops-devops):([a-zA-Z0-9_\-]+)-->"
)

# Match incident IDs minted by case_flow when a "create + dispatch" flow
# kicks off an investigation: "<platform>-case-<display_id>".
_CASE_LINKED_INCIDENT_RE = re.compile(r"^[a-z]+-case-(\d{6,})$")


def _extract_case_display_id(incident_id: str) -> str:
    """Return the case display id when an incident_id was minted from a
    case-create-dispatch flow; otherwise empty string."""
    if not incident_id:
        return ""
    m = _CASE_LINKED_INCIDENT_RE.match(incident_id)
    return m.group(1) if m else ""


def _clean(text):
    if not isinstance(text, str):
        return str(text)
    try:
        if "\\u" in text:
            text = text.encode("utf-8").decode("unicode_escape")
    except (UnicodeDecodeError, UnicodeEncodeError):
        pass
    text = re.sub(r"[\ud800-\udfff]", "", text)
    # Strip routing tags injected by bots so they don't appear in reports
    text = _INCIDENT_TAG_RE.sub("", text)
    return text


def _extract_incident_id_from_records(agent_space_id: str, execution_id: str,
                                      client=None) -> tuple[str, str | None]:
    """
    Find the LATEST `<!--notiops:<incident_id>-->` (or legacy
    `<!--notiops-devops:...-->`) marker in journal records.
    Returns (incident_id, marker_record_createdAt).

    DevOps Agent may correlate multiple incidents into one execution. Returning
    the LATEST marker means: (a) the report is routed to the most recent
    requester, and (b) downstream filters only include records produced at or
    after this marker's timestamp, ignoring prior unrelated context.
    """
    try:
        all_records = _list_records(agent_space_id, execution_id, client=client)
    except Exception as e:
        logger.warning("Could not list records to recover incident_id: %s", e)
        return "", None

    latest_id = ""
    latest_ts: str | None = None
    for r in all_records:
        if r.get("recordType") != "message":
            continue
        content = _parse_content(r.get("content", ""))
        if not isinstance(content, dict) or content.get("role") != "user":
            continue
        blocks = content.get("content", "")
        text = ""
        if isinstance(blocks, str):
            text = blocks
        elif isinstance(blocks, list):
            text = " ".join(b.get("text", "") for b in blocks
                            if isinstance(b, dict) and b.get("type") == "text")
        m = _INCIDENT_TAG_RE.search(text)
        if m:
            latest_id = m.group(1)
            latest_ts = r.get("createdAt") or r.get("createdAtIsoString") or r.get("timestamp")
    return latest_id, latest_ts


def _filter_after_ts(records: list, slice_after_ts: str | None) -> list:
    """Keep records whose createdAt >= slice_after_ts; passthrough if no slice."""
    if not slice_after_ts:
        return records
    out = []
    for r in records:
        ts = r.get("createdAt") or r.get("createdAtIsoString") or r.get("timestamp") or ""
        if ts and ts >= slice_after_ts:
            out.append(r)
    return out


def _list_records(agent_space_id, execution_id, record_type=None, client=None):
    c = client or devops_client
    records = []
    params = {"agentSpaceId": agent_space_id, "executionId": execution_id,
              "limit": 100, "order": "ASC"}
    if record_type:
        params["recordType"] = record_type
    while True:
        resp = c.list_journal_records(**params)
        records.extend(resp.get("records", []))
        token = resp.get("nextToken")
        if not token:
            break
        params["nextToken"] = token
    return records


# ===========================================================================
# Step 3: Upload to S3
# ===========================================================================
def upload_to_s3(html_content, s3_key, content_type="text/html; charset=utf-8"):
    if not S3_BUCKET:
        # 没有部署注入的唯一桶名就直接失败，绝不写到硬编码/可抢注的名字（防 bucket squatting）。
        raise RuntimeError(
            "S3 target bucket not configured: set S3_BUCKET / DATA_BUCKET / SKILLS_BUCKET "
            "to the deploy-generated bucket (e.g. notiops-data-<account>-<region>)."
        )
    try:
        body = html_content.encode("utf-8", errors="replace")
        s3_client.put_object(
            Bucket=S3_BUCKET, Key=s3_key, Body=body,
            ContentType=content_type, ContentDisposition="inline",
        )
        logger.info("Uploaded to s3://%s/%s", S3_BUCKET, s3_key)
    except Exception as e:
        logger.error("S3 upload failed: %s", e)
        raise


# ===========================================================================
# Step 4: Pre-signed URL
# ===========================================================================
def generate_presigned_url(s3_key):
    try:
        url = s3_client.generate_presigned_url(
            "get_object", Params={"Bucket": S3_BUCKET, "Key": s3_key},
            ExpiresIn=PRESIGN_EXPIRY,
        )
        logger.info("Pre-signed URL generated (expires %ds)", PRESIGN_EXPIRY)
        return url
    except Exception as e:
        logger.error("Pre-signed URL failed: %s", e)
        raise


# ===========================================================================
# Investigation Started → post execution-deep-link card
# ===========================================================================
#: Mirror of `core.ddb_state.LIVE_CARD_OWNER_IM_LAMBDA`. Kept as a literal so
#: this module stays importable without `core` (Lambda layering — same reason
#: `update_live_card` takes its IR duck-typed). `tests/test_im_double_card.py`
#: asserts the two strings are equal so they can't drift apart silently.
LIVE_CARD_OWNER_IM_LAMBDA = "im_lambda"


def _handle_investigation_started(agent_space_id: str, execution_id: str,
                                  task_id: str, incident_id: str) -> dict:
    """Post the execution-level console deep link to the originating Feishu thread.

    incident_id is rarely echoed in the Started event metadata, so we mine
    journal records to recover it (same trick as Completed handling).

    ⚠️ Skipped entirely when the routing row says the IM webhook path already
    owns a live card (`live_card_owner == "im_lambda"`). Posting here too gives
    the user TWO cards for one `/investigate` — measured on prod 2026-09-02.
    This card is driven by a `progress#` row, and the only reader of those rows
    was the Fargate-resident `core/progress_poller.py`
    (`platforms/common/lambda_progress.py` scans `imtask#` only).

    ⚠️ `BotStack` was retired on 2026-09-03 (IM refactor M2), so nothing reads
    `progress#` rows any more: a card posted here would freeze on "investigation
    started" forever. Every IM dispatch now goes through the webhook Lambda,
    which stamps `live_card_owner = "im_lambda"`, so in practice this function
    returns early for IM. The branch is kept — not deleted — because
    `infra/lib/bot-stack.ts` is still in the repo as the long-connection
    rollback path, and if it ever comes back this card is its only live
    progress. See `core.ddb_state.link_im_investigation`.
    """
    if not incident_id:
        incident_id, _ = _extract_incident_id_from_records(agent_space_id, execution_id)
        if incident_id:
            logger.info("InvestigationStarted: recovered incident_id %s", incident_id)

    # Fallback: use task-{task_id} as progress row key (same convention
    # as _mark_progress_row_completed in callback handler). This ensures
    # the progress row is written even when incident_id can't be recovered
    # from journal records (e.g. records not yet available on Created event).
    effective_incident_id = incident_id or (f"task-{task_id}" if task_id else "")

    target = _resolve_chat_target(incident_id, task_id)
    if not target:
        logger.info("InvestigationStarted: no chat thread for incident_id=%s, "
                    "task_id=%s — skipping live link post", incident_id, task_id)
        return {"statusCode": 200, "body": "no-thread"}

    if target.get("live_card_owner") == LIVE_CARD_OWNER_IM_LAMBDA:
        # The IM webhook path already posted its own dispatch card and owns an
        # `imtask#` row that the progress Lambda patches every minute. A second
        # card here is pure noise either way — see docstring.
        logger.info("InvestigationStarted: live card owned by %s for task_id=%s "
                    "— skipping duplicate live link post",
                    LIVE_CARD_OWNER_IM_LAMBDA, task_id)
        return {"statusCode": 200, "body": "live-card-owned-by-im"}

    sender = _load_sender(target.get("platform", ""))
    if not sender:
        logger.info("InvestigationStarted: no sender for platform=%s, "
                    "incident_id=%s — skipping live link post",
                    target.get("platform"), incident_id)
        return {"statusCode": 200, "body": "no-sender"}

    intent_summary = target.get("intent_summary", "") or ""
    # Resolve locale: prefer the locale stored in the task#/incident# row
    # (written by the bot at dispatch time), then fall back to
    # locale_resolver's incident lookup, then "en".
    live_locale = target.get("locale", "")
    if not live_locale:
        try:
            from core import locale_resolver as _lr
            live_locale = _lr.get_for_incident(incident_id) or "en"
        except Exception:
            live_locale = "en"
    if live_locale not in {"zh", "en"}:
        live_locale = "en"
    try:
        msg_ref = sender.send_live_console_link(
            chat_id=target["chat_id"],
            root_message_id=target["root_message_id"],
            agent_space_id=agent_space_id,
            execution_id=execution_id,
            incident_id=incident_id,
            task_id=task_id,
            intent_summary=intent_summary,
            locale=live_locale,
        )
    except TypeError:
        # Older sender without locale support — falls back gracefully.
        msg_ref = sender.send_live_console_link(
            chat_id=target["chat_id"],
            root_message_id=target["root_message_id"],
            agent_space_id=agent_space_id,
            execution_id=execution_id,
            incident_id=incident_id,
            task_id=task_id,
            intent_summary=intent_summary,
        )
    # Idempotency: pre-existing senders return None (old API). Newer
    # ones return a message_ref dict. Only write the progress row when
    # we have something the poller can update.
    if msg_ref:
        _write_progress_row(
            incident_id=effective_incident_id,
            platform=target.get("platform", ""),
            agent_space_id=agent_space_id,
            execution_id=execution_id,
            message_ref=msg_ref,
            intent_summary=target.get("intent_summary", ""),
        )
    return {"statusCode": 200, "body": json.dumps({
        "live_link_posted_for": effective_incident_id,
    })}


# ===========================================================================
# Progress polling row management
# ===========================================================================
def _write_progress_row(*, incident_id: str, platform: str,
                        agent_space_id: str, execution_id: str,
                        message_ref: dict, intent_summary: str) -> None:
    """Persist progress# row consumed by the platform's ECS progress
    poller. TTL = 30 minutes; if Completed/Failed never arrives the row
    is auto-cleaned and updates stop on their own."""
    table = _get_ddb_table()
    if not table or not incident_id or not platform:
        return
    import time as _t
    # Inherit the locale from the incident row (set by the bot when
    # the user dispatched). Falls back to env default in poller code
    # if missing — old incidents pre-dating this feature still work.
    locale = ""
    try:
        from core import locale_resolver as _lr
        locale = _lr.get_for_incident(incident_id) or ""
    except Exception as e:
        logger.warning("progress row locale lookup failed: %s", e)
    item = {
        "lookup_key": f"progress#{incident_id}",
        "platform": platform,
        "incident_id": incident_id,
        "agent_space_id": agent_space_id,
        "execution_id": execution_id,
        "message_ref": message_ref or {},
        "deep_link": (message_ref or {}).get("deep_link", ""),
        "operator_home_url": (message_ref or {}).get("operator_home_url", ""),
        "intent_summary": intent_summary[:200] if intent_summary else "",
        "started_at": int(_t.time()),
        "last_polled_at": 0,
        "tick_count": 0,
        "last_summary_md": "",
        "ttl": int(_t.time()) + 30 * 60,
    }
    if locale:
        item["locale"] = locale
    try:
        table.put_item(Item=item)
        logger.info("Wrote progress row for incident_id=%s platform=%s "
                    "locale=%s", incident_id, platform, locale or "(none)")
    except Exception as e:
        logger.warning("write progress row failed: %s", e)


def _mark_progress_row_completed(incident_id: str,
                                 final_status: str = "completed") -> None:
    """Mark the progress row as terminal so the poller can finalize the
    live card on its next scan, then let DDB TTL reap the row 30 minutes
    later. Replaces the old delete-on-finish design (which lost finalize
    when the bot's ECS task got replaced mid-investigation: the daemon
    poller died with the task, the new task's poller never saw the row,
    and the live card stayed stuck on its last "调查中" tick).

    Now the row stays in DDB with `status=completed`, so even a freshly
    started poller will pick it up on first scan, run its `finalize_card`
    hook, then leave the row for TTL to clean up.

    `final_status` is "completed" for normal finish or "failed" if the
    investigation errored out. The poller treats both the same way (stop
    updating + render the final card)."""
    table = _get_ddb_table()
    if not table or not incident_id:
        return
    import time as _t
    try:
        # Using update_item rather than put_item so we don't clobber any
        # fields the poller wrote (last_polled_at / tick_count /
        # last_summary_md). If the row somehow doesn't exist we skip —
        # nothing to finalize.
        table.update_item(
            Key={"lookup_key": f"progress#{incident_id}"},
            UpdateExpression=("SET #s = :st, finalized_at = :ts, "
                              "#ttl = :ttl"),
            ExpressionAttributeNames={"#s": "status", "#ttl": "ttl"},
            ExpressionAttributeValues={
                ":st": final_status,
                ":ts": int(_t.time()),
                # Short TTL so the row reaps quickly once finalize runs.
                # 30 min is enough cushion for any in-flight poller
                # iteration to spot it without holding stale state.
                ":ttl": int(_t.time()) + 30 * 60,
            },
            ConditionExpression="attribute_exists(lookup_key)",
        )
        logger.info("Marked progress row status=%s for incident_id=%s",
                    final_status, incident_id)
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        # Row already gone (e.g. legacy delete path or TTL reaper). Fine.
        pass
    except Exception as e:
        logger.warning("mark progress row completed failed: %s", e)


# Legacy alias kept for one deploy cycle in case anything still calls
# it. Same behavior as the new mark-completed function.
def _delete_progress_row(incident_id: str) -> None:
    _mark_progress_row_completed(incident_id, "completed")


# ===========================================================================
# Persist content needed by the "Ask for human support" button
# ===========================================================================
def _persist_support_context(incident_id: str, task_id: str, agent_space_id: str,
                             execution_id: str, summary_md: str, report_url: str,
                             trace_url: str, raw_text: str, intent_summary: str,
                             platform: str) -> None:
    """Stash the report content under a `support#<incident_id>` key so the
    originating platform bot's support handler can retrieve it when the user
    clicks 'Ask for human support' on the report card. TTL matches the
    presigned URL expiry (7 days).
    """
    table = _get_ddb_table()
    if not table:
        return
    import time as _t
    # Truncate summary to keep DDB item under 400KB limit (and AWS Support API
    # caseBody under 8000 chars).
    summary_for_case = summary_md[:7500] if summary_md else ""
    item = {
        "lookup_key": f"support#{incident_id}",
        "platform": platform,
        "incident_id": incident_id,
        "task_id": task_id or "",
        "agent_space_id": agent_space_id,
        "execution_id": execution_id,
        "summary_md": summary_for_case,
        "report_url": report_url,
        "trace_url": trace_url,
        "raw_text": raw_text,
        "intent_summary": intent_summary,
        "ttl": int(_t.time()) + 7 * 24 * 3600,
    }
    try:
        table.put_item(Item=item)
        logger.info("Persisted support context for incident_id=%s platform=%s",
                    incident_id, platform)
    except Exception as e:
        logger.warning("Failed to persist support context: %s", e)


# ===========================================================================
# Cross-platform chat routing lookup
# ===========================================================================
def _backfill_incident_id(target: dict, task_id: str) -> str:
    """Recover the incident_id from the routing row when the callback lacks one.

    Why this is needed: the Lambda-webhook IM path dispatches through
    ``core.devops_agent.start_investigation()``, which does **not** embed the
    ``<!--notiops:<incident_id>-->`` marker that the older Fargate path used
    (``shared.devops_agent.create_investigation``). Callback events rarely echo
    the incident_id either, so by the time we get here it is usually empty even
    though ``ddb_state.link_im_investigation()`` wrote it into both the
    ``incident#`` and ``task#`` rows.

    Two things break on an empty incident_id, both silently:
      * ``_persist_support_context`` writes to the literal key ``support#`` —
        every IM investigation overwrites the same row, so the report card's
        "sync to case" / "escalate to support" buttons look up a stranger's
        report (or nothing at all);
      * ``_extract_case_display_id`` returns "", so a report whose investigation
        was kicked off from a case-create flow loses its link back to the case.

    Falls back to ``task#<task_id>`` as a synthetic id so the support-context row
    is at least unique per investigation. That synthetic form deliberately does
    NOT match ``_CASE_LINKED_INCIDENT_RE`` — a made-up id must never be mistaken
    for a real case link.
    """
    recovered = str((target or {}).get("incident_id") or "").strip()
    if recovered:
        return recovered
    if task_id:
        logger.info("incident_id absent from callback and routing row; "
                    "falling back to task-derived id for task_id=%s", task_id)
        return f"task-{task_id}"
    return ""


def _resolve_chat_target(incident_id: str, task_id: str) -> dict | None:
    """Look up the originating chat context from the shared Conversations
    table. Returns a dict including the `platform` slug on hit; None if no
    matching row found (e.g. the row TTL'd out or the incident was minted
    outside any platform bot).

    Backwards-compat: rows written before Phase 3 lack the `platform`
    field — we treat those as "feishu" since that's the only platform that
    existed pre-migration.
    """
    table = _get_ddb_table()
    if not table:
        return None
    try:
        for key in (f"incident#{incident_id}" if incident_id else None,
                    f"task#{task_id}" if task_id else None):
            if not key:
                continue
            item = table.get_item(Key={"lookup_key": key}).get("Item")
            if item:
                platform = item.get("platform") or "feishu"
                logger.info("Routing to %s chat via %s", platform, key)
                return {"platform": platform,
                        "chat_id": item.get("chat_id", ""),
                        "root_message_id": item.get("root_message_id", ""),
                        "raw_text": item.get("raw_text", ""),
                        "intent_summary": item.get("intent_summary", ""),
                        "locale": item.get("locale", ""),
                        # The row carries the incident_id even when the callback
                        # event doesn't — see the backfill in
                        # deliver_report_card / deliver_failure_card.
                        "incident_id": item.get("incident_id", ""),
                        # Who owns the live/progress card for this run — see
                        # LIVE_CARD_OWNER_IM_LAMBDA below.
                        "live_card_owner": item.get("live_card_owner", "")}
    except Exception as e:
        logger.warning("DDB lookup failed: %s", e)
    return None
