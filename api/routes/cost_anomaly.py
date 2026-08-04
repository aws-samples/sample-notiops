"""
成本异常检测 API 路由。
POST /api/cost-anomaly/save - 保存成本异常分析结果（UPSERT）
"""

import json
import logging
import re

from shared.queries.cost_anomaly import (
    upsert_anomaly_result,
    upsert_anomaly_summary,
)

logger = logging.getLogger(__name__)

VALID_CONFIDENCE_LEVELS = {"High", "Medium", "Low"}
VALID_ANOMALY_TYPES = {"high_priority", "medium_priority", "new_cost", "observation"}
_ACCOUNT_ID_RE = re.compile(r"^\d{12}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def handle_cost_anomaly(
    method: str, path: str, query_params: dict, path_params: dict, body: dict | None
) -> dict:
    parts = path.rstrip("/").split("/")
    # POST /api/cost-anomaly/save
    if method == "POST" and len(parts) >= 3 and parts[-1] == "save":
        return _save(body)

    raise ValueError(f"Method {method} not allowed for {path}")


def _validate_anomaly(anomaly: dict, index: int) -> None:
    """校验单条 anomaly 记录。"""
    service_name = anomaly.get("service_name")
    if not service_name:
        raise ValueError(f"anomalies[{index}].service_name is required")

    score = anomaly.get("anomaly_score")
    if score is not None:
        if not isinstance(score, (int, float)) or score < 0 or score > 100:
            raise ValueError(
                f"anomalies[{index}].anomaly_score must be between 0 and 100"
            )

    confidence = anomaly.get("confidence_level")
    if confidence is not None and confidence not in VALID_CONFIDENCE_LEVELS:
        raise ValueError(
            f"anomalies[{index}].confidence_level must be one of {sorted(VALID_CONFIDENCE_LEVELS)}"
        )

    anomaly_type = anomaly.get("anomaly_type")
    if anomaly_type is not None and anomaly_type not in VALID_ANOMALY_TYPES:
        raise ValueError(
            f"anomalies[{index}].anomaly_type must be one of {sorted(VALID_ANOMALY_TYPES)}"
        )


def _save(body: dict | None) -> dict:
    """保存成本异常分析结果（anomalies + summary），使用 UPSERT 语义。"""
    if not body:
        raise ValueError("Request body is required")

    account_id = body.get("account_id")
    report_date = body.get("report_date")
    anomalies = body.get("anomalies")
    summary = body.get("summary")

    if not account_id:
        raise ValueError("account_id is required")
    if not _ACCOUNT_ID_RE.match(str(account_id)):
        raise ValueError("account_id must be 12 digits")
    if not report_date:
        raise ValueError("report_date is required")
    if not _DATE_RE.match(str(report_date)):
        raise ValueError("report_date must be YYYY-MM-DD")
    if anomalies is not None and not isinstance(anomalies, list):
        raise ValueError("anomalies must be a JSON array")
    if summary is not None and not isinstance(summary, dict):
        raise ValueError("summary must be a JSON object")

    # 校验每条 anomaly
    if anomalies:
        for i, anomaly in enumerate(anomalies):
            _validate_anomaly(anomaly, i)

    upserted_anomalies = 0
    upserted_summary = False

    # UPSERT anomalies
    if anomalies:
        for anomaly in anomalies:
            top_drivers = anomaly.get("top_drivers")
            if top_drivers is not None and not isinstance(top_drivers, str):
                top_drivers = json.dumps(top_drivers)

            upsert_anomaly_result(
                account_id,
                report_date,
                anomaly.get("service_name"),
                score=int(anomaly.get("anomaly_score", 0)),
                anomaly_score=anomaly.get("anomaly_score"),
                confidence_level=anomaly.get("confidence_level"),
                anomaly_type=anomaly.get("anomaly_type"),
                baseline_daily_avg=anomaly.get("baseline_daily_avg"),
                recent_3d_avg=anomaly.get("recent_3d_avg"),
                projected_7d_extra_cost=anomaly.get("projected_7d_extra_cost"),
                top_drivers=top_drivers,
                trend_symbols=anomaly.get("trend_symbols"),
                related_services=anomaly.get("related_services"),
            )
            upserted_anomalies += 1

    # UPSERT summary
    if summary:
        projected = float(summary.get("total_projected_7d_extra_cost", 0) or 0)
        upsert_anomaly_summary(
            account_id,
            report_date,
            projected=int(projected),
            total_daily_avg=summary.get("total_daily_avg"),
            recent_3d_daily_avg=summary.get("recent_3d_daily_avg"),
            total_anomalies_detected=summary.get("total_anomalies_detected"),
            total_projected_7d_extra_cost=summary.get("total_projected_7d_extra_cost"),
            status=summary.get("status"),
            error_message=summary.get("error_message"),
        )
        upserted_summary = True

    return {
        "message": "Cost anomaly data saved",
        "upserted_anomalies": upserted_anomalies,
        "upserted_summary": upserted_summary,
    }
