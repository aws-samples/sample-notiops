"""Lambda5 Cost Explorer API 封装。

独立函数（非 @tool），供 Lambda5 handler 直接调用。
调用方负责 STS AssumeRole 获取 session，本模块仅负责 CE 查询。

CE API 仅有 us-east-1 全局端点，所有 CE client 强制 region_name='us-east-1'。

内置 200ms 最小调用间隔 + 指数退避重试 + 分页合并。

需求: 1.3, 1.4, 1.5, 7.1
"""

from __future__ import annotations

import logging
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger("lambda5_cost_analyzer.ce_client")

# 连续 CE API 调用的最小间隔（秒）
_MIN_CALL_INTERVAL_SEC = 0.2

# 指数退避重试配置
_MAX_RETRIES = 3
_BASE_BACKOFF_SEC = 1  # 1s, 2s, 4s

# 可重试的 CE 异常码
_RETRYABLE_ERROR_CODES = frozenset({"LimitExceededException", "ThrottlingException"})

# 上一次 CE API 调用的时间戳（模块级，跨函数共享）
_last_ce_call_time: float = 0.0


# ---------------------------------------------------------------------------
# 内部辅助
# ---------------------------------------------------------------------------


def _create_ce_client(session: boto3.Session):
    """创建 Cost Explorer 客户端，强制 region_name='us-east-1'。"""
    return session.client("ce", region_name="us-east-1")


def _enforce_min_interval() -> None:
    """强制连续 CE API 调用之间的最小间隔（200ms）。"""
    global _last_ce_call_time
    now = time.monotonic()
    elapsed = now - _last_ce_call_time
    if _last_ce_call_time > 0 and elapsed < _MIN_CALL_INTERVAL_SEC:
        sleep_time = _MIN_CALL_INTERVAL_SEC - elapsed
        logger.debug("CE rate limit: sleeping %.3fs", sleep_time)
        time.sleep(sleep_time)
    _last_ce_call_time = time.monotonic()


def _call_ce_with_retry(ce_client, params: dict) -> dict:
    """带限流保护的 CE API 调用：200ms 最小间隔 + 指数退避重试。

    重试策略：
    - 仅对 LimitExceededException / ThrottlingException 重试
    - 指数退避：1s → 2s → 4s
    - 最多重试 3 次，全部失败后 raise

    Returns:
        CE API 响应字典。

    Raises:
        ClientError: 不可重试的错误或重试耗尽。
    """
    last_error: ClientError | None = None

    for attempt in range(_MAX_RETRIES + 1):  # 0=首次, 1-3=重试
        if attempt > 0:
            backoff = _BASE_BACKOFF_SEC * (2 ** (attempt - 1))
            logger.warning(
                "CE API retry %d/%d, backoff=%.1fs",
                attempt, _MAX_RETRIES, backoff,
            )
            time.sleep(backoff)

        _enforce_min_interval()

        try:
            response = ce_client.get_cost_and_usage(**params)
            return response
        except ClientError as e:
            error_code = e.response["Error"]["Code"]
            last_error = e

            if error_code in _RETRYABLE_ERROR_CODES and attempt < _MAX_RETRIES:
                logger.warning(
                    "CE API throttled: code=%s, attempt=%d/%d",
                    error_code, attempt + 1, _MAX_RETRIES + 1,
                )
                continue

            # 不可重试或重试耗尽 → 直接抛出
            raise

    # 所有重试耗尽（安全兜底）
    raise last_error  # type: ignore[misc]


def _paginate_ce(ce_client, params: dict) -> list[dict]:
    """自动处理 NextPageToken 分页，返回合并后的 ResultsByTime 列表。

    Raises:
        ClientError: CE API 调用失败（由 _call_ce_with_retry 抛出）。
    """
    all_results: list[dict] = []
    current_params = dict(params)  # 浅拷贝

    while True:
        response = _call_ce_with_retry(ce_client, current_params)
        all_results.extend(response.get("ResultsByTime", []))

        next_token = response.get("NextPageToken")
        if not next_token:
            break
        current_params["NextPageToken"] = next_token

    return all_results


# ---------------------------------------------------------------------------
# 公开 API
# ---------------------------------------------------------------------------


def query_cost_by_service(
    session: boto3.Session,
    start_date: str,
    end_date: str,
) -> list[dict]:
    """一级查询：按 SERVICE 分组获取每日摊销成本。

    Args:
        session: boto3.Session（由调用方通过 STS AssumeRole 获取）。
        start_date: 查询起始日期，格式 YYYY-MM-DD。
        end_date: 查询结束日期，格式 YYYY-MM-DD。

    Returns:
        合并后的 ResultsByTime 列表，每个条目按 SERVICE 分组。

    Raises:
        ClientError: CE API 调用失败。
    """
    ce_client = _create_ce_client(session)
    params = {
        "TimePeriod": {"Start": start_date, "End": end_date},
        "Granularity": "DAILY",
        "Metrics": ["AmortizedCost"],
        "GroupBy": [{"Type": "DIMENSION", "Key": "SERVICE"}],
    }
    return _paginate_ce(ce_client, params)


def query_cost_drilldown(
    session: boto3.Session,
    start_date: str,
    end_date: str,
    service_name: str,
) -> list[dict]:
    """二级下钻查询：获取指定服务的 USAGE_TYPE 维度成本明细。

    Args:
        session: boto3.Session（由调用方通过 STS AssumeRole 获取）。
        start_date: 查询起始日期，格式 YYYY-MM-DD。
        end_date: 查询结束日期，格式 YYYY-MM-DD。
        service_name: 要下钻的 AWS 服务名（CE 返回的原始名称）。

    Returns:
        合并后的 ResultsByTime 列表，按 USAGE_TYPE 分组并过滤到指定服务。

    Raises:
        ClientError: CE API 调用失败。
    """
    ce_client = _create_ce_client(session)
    params = {
        "TimePeriod": {"Start": start_date, "End": end_date},
        "Granularity": "DAILY",
        "Metrics": ["AmortizedCost"],
        "GroupBy": [{"Type": "DIMENSION", "Key": "USAGE_TYPE"}],
        "Filter": {
            "Dimensions": {
                "Key": "SERVICE",
                "Values": [service_name],
            },
        },
    }
    return _paginate_ce(ce_client, params)
