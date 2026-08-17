"""
AWS Support Case classifier.

Reads the DevOps Agent investigation summary and asks Claude Haiku to pick
the right serviceCode + categoryCode + issueType from the real AWS Support
service catalog (fetched once at startup via support:DescribeServices).

The classifier is constrained to choose ONLY values that exist in the live
catalog — Claude never invents codes — so CreateCase will never reject the
classification with InvalidParameterValue. On any failure (Bedrock error,
unparseable JSON, code not in catalog) we fall back to the safe defaults
(general-info / using-aws / technical) so a case still gets opened.
"""
from __future__ import annotations

import json
import logging
import os
import threading

import boto3
from core.lazy_boto import LazyClient
from botocore.exceptions import ClientError

from shared.model_config import get_bot_model_id

logger = logging.getLogger(__name__)

BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")

# 惰性构造（core/lazy_boto.py）：botocore 在**构造时**快照凭证，import 期建好的
# client 会让后续 setenv AWS_BEARER_TOKEN_BEDROCK 完全失效（Bedrock API Key 模式
# 因此无法生效）。代理转发属性访问，所有调用点写法不变。
_bedrock = LazyClient("bedrock-runtime", region=BEDROCK_REGION)
_support = boto3.client("support", region_name="us-east-1")

# Safe fallback when classification fails. These are guaranteed to exist
# in every Support plan that supports CreateCase.
FALLBACK_SERVICE = "general-info"
FALLBACK_CATEGORY = "using-aws"
FALLBACK_ISSUE_TYPE = "technical"

_catalog_lock = threading.Lock()
_catalog: list[dict] | None = None
_catalog_index: dict[str, set[str]] | None = None


def _load_catalog() -> tuple[list[dict], dict[str, set[str]]]:
    """Load (and cache) the full Support service catalog."""
    global _catalog, _catalog_index
    with _catalog_lock:
        if _catalog is not None and _catalog_index is not None:
            return _catalog, _catalog_index
        try:
            resp = _support.describe_services(language="en")
            services = resp.get("services", [])
        except ClientError as e:
            logger.error("describe_services failed: %s", e)
            _catalog = []
            _catalog_index = {}
            return _catalog, _catalog_index

        index: dict[str, set[str]] = {}
        compact: list[dict] = []
        for s in services:
            cats = [{"code": c["code"], "name": c["name"]}
                    for c in s.get("categories", [])]
            compact.append({"code": s["code"], "name": s["name"],
                            "categories": cats})
            index[s["code"]] = {c["code"] for c in cats}

        _catalog = compact
        _catalog_index = index
        logger.info("Loaded AWS Support catalog: %d services", len(compact))
        return _catalog, _catalog_index


# Category code substrings to prefer when we need to soft-repair a
# hallucinated categoryCode by picking ANY valid one under the same
# service. Generic / catch-all categories are safer defaults than
# specific ones (e.g. an EC2 case with unknown root cause shouldn't be
# auto-routed into "billing" or "limit-increase").
_DEFAULT_CATEGORY_HINTS = (
    "general",
    "guidance",
    "usage",
    "questions",
    "other",
    "performance",
    "configuration",
    "operational",
)


def _pick_default_category(valid: set[str]) -> str | None:
    """Pick the most generic category code from a valid set. Returns None
    if nothing matches the hint list."""
    valid_list = list(valid)
    for hint in _DEFAULT_CATEGORY_HINTS:
        for code in valid_list:
            if hint in code.lower():
                return code
    return None


def _format_catalog_for_prompt(catalog: list[dict]) -> str:
    """Render the catalog as a compact JSON-y list Claude can scan.
    Keep it tight to fit Haiku's context easily — strip names that don't
    add signal beyond the code.
    """
    lines: list[str] = []
    for s in catalog:
        cat_codes = ", ".join(c["code"] for c in s["categories"])
        lines.append(f'- "{s["code"]}" ({s["name"]}): [{cat_codes}]')
    return "\n".join(lines)


SYSTEM_PROMPT = """\
你是 AWS Support case 分类器。给定一段 DevOps Agent 的调查内容，从下方真实的
AWS Support 服务目录里，挑出最匹配的 serviceCode 和 categoryCode，并判断
issueType 是 technical 还是 customer-service。

严格规则：
1. serviceCode 必须从下方目录里**原样**复制（不能改大小写、不能编造）
2. categoryCode 必须是**该 serviceCode 名下的一个**类别 code（不能跨服务挑）
3. issueType 默认为 **"technical"**。**只有**当问题明确属于以下场景时才选
   "customer-service":
   - 账单、付款、退款问题
   - 服务限额(quota / limit)提升申请
   - 账户管理(关闭、合并、root user 重置)
   - 合同、商务、订阅级别变更
   其他所有情形(包括运维查询、性能、错误、配置、AWS 服务使用方式) → "technical"。
   含糊不清时一律按 technical 处理。
4. 如果调查内容主要围绕某个 AWS 服务（比如 EC2、S3、Lambda、RDS、Cost Explorer 等），
   就选该服务的 code（注意 EC2 区分 Linux / Windows，多数情况选 Linux 即
   "amazon-elastic-compute-cloud-linux"）
5. 如果调查跨多个服务无明确主体，可以选 "general-info"
   (注意:general-info + technical 是合法组合;technical 不要求一定是具体服务)

**严格输出 JSON**（不要 markdown 包裹），结构如下：
{
  "serviceCode": "<目录里的 code>",
  "categoryCode": "<该 service 名下的 category code>",
  "issueType": "technical" | "customer-service",
  "reason": "<一句话说明选这个分类的理由>"
}

==== AWS Support 服务目录 ====
{CATALOG}
"""


def classify(intent_summary: str, raw_text: str, summary_md: str) -> dict:
    """Pick a (serviceCode, categoryCode, issueType) for the given investigation.

    Returns a dict with keys: serviceCode, categoryCode, issueType, reason.
    On any failure, returns the safe fallback. Never raises.
    """
    fallback = {
        "serviceCode": FALLBACK_SERVICE,
        "categoryCode": FALLBACK_CATEGORY,
        "issueType": FALLBACK_ISSUE_TYPE,
        "reason": "fallback (classifier unavailable)",
    }

    catalog, index = _load_catalog()
    if not catalog or not index:
        return fallback

    investigation_blob = (
        f"用户原指令: {raw_text}\n"
        f"意图总结: {intent_summary}\n\n"
        f"调查报告(节选):\n{summary_md[:3000]}"
    )

    system = SYSTEM_PROMPT.replace("{CATALOG}",
                                   _format_catalog_for_prompt(catalog))

    try:
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 400,
            "system": system,
            "messages": [{"role": "user", "content": investigation_blob}],
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
            logger.warning("Classifier: empty response")
            return fallback
        if text.startswith("```"):
            text = text.strip("`")
            if text.lstrip().lower().startswith("json"):
                text = text.split("\n", 1)[1] if "\n" in text else text[4:]
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        logger.warning("Classifier JSON parse failed: %s; raw=%r", e, text[:300])
        return fallback
    except Exception as e:
        logger.warning("Classifier invocation failed: %s", e)
        return fallback

    service = (parsed.get("serviceCode") or "").strip()
    category = (parsed.get("categoryCode") or "").strip()
    issue_type = (parsed.get("issueType") or "").strip().lower()
    reason = parsed.get("reason", "")

    if service not in index:
        logger.warning("Classifier returned unknown serviceCode %r — falling back", service)
        return fallback
    # Soft repair: classifier sometimes picks a plausible-but-nonexistent
    # categoryCode under the right service (Haiku hallucinates "performance-
    # related-issues" etc.). Rather than dumping the whole classification
    # back to general-info, keep the service the user/agent intended and
    # pick a sensible default category from the same service. We prefer
    # categories whose code suggests a generic / catch-all bucket.
    if category not in index[service]:
        valid_cats = index[service]
        logger.warning("Classifier returned unknown categoryCode %r for service %r — "
                       "repairing with a same-service default", category, service)
        category = _pick_default_category(valid_cats) or next(iter(valid_cats))
    if issue_type not in ("technical", "customer-service"):
        issue_type = "technical"

    # Defense-in-depth: classifier sometimes labels routine ops questions
    # as customer-service. Only keep customer-service when the matched
    # service strongly implies billing/account/limits; otherwise prefer
    # technical so the case lands in the right Support engineer queue.
    _CUSTOMER_SERVICE_ALLOWED = {
        "billing", "account-management", "service-limit-increase",
        "customer-service", "tax-inquiries",
    }
    if issue_type == "customer-service" and service not in _CUSTOMER_SERVICE_ALLOWED:
        logger.info("Classifier proposed customer-service for service=%r; "
                    "downgrading to technical (default)", service)
        issue_type = "technical"

    logger.info("Classified case: service=%s category=%s issue=%s reason=%s",
                service, category, issue_type, reason[:120])
    return {
        "serviceCode": service,
        "categoryCode": category,
        "issueType": issue_type,
        "reason": reason,
    }
