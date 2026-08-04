"""Module-level lazy DynamoDB table handles + shared stdlib helpers."""
from __future__ import annotations

import base64
import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import boto3

_resource = None
_metrics = None
_config = None


def _dynamodb():
    global _resource
    if _resource is None:
        _resource = boto3.resource("dynamodb")
    return _resource


def metrics_table():
    global _metrics
    if _metrics is None:
        _metrics = _dynamodb().Table(os.environ["METRICS_TABLE"])
    return _metrics


def config_table():
    global _config
    if _config is None:
        _config = _dynamodb().Table(os.environ["CONFIG_TABLE"])
    return _config


def reset_table_cache() -> None:
    global _resource, _metrics, _config
    _resource = None
    _metrics = None
    _config = None


def _zpad(num: int, width: int) -> str:
    if num < 0:
        raise ValueError(f"_zpad expects non-negative int, got {num}")
    return str(num).zfill(width)


def to_decimal(obj: Any) -> Any:
    """Recursively convert Python floats to Decimal for DynamoDB writes.

    boto3's DynamoDB resource rejects Python `float` ("Float types are not
    supported. Use Decimal types instead."). Nested floats inside list/dict
    attributes (e.g. cost_anomaly `top_drivers`) must be converted too, so a
    flat `isinstance(v, float)` check is insufficient. bool is left untouched
    (DynamoDB BOOL); int stays int (Number).
    """
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: to_decimal(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_decimal(v) for v in obj]
    return obj


def _json_default(o):
    if isinstance(o, Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    raise TypeError(f"not JSON-serializable: {type(o).__name__}")


def encode_cursor(last_evaluated_key: dict | None) -> str | None:
    if last_evaluated_key is None:
        return None
    raw = json.dumps(last_evaluated_key, default=_json_default,
                     separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def decode_cursor(cursor: str | None) -> dict | None:
    if not cursor:
        return None
    try:
        pad = "=" * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode(cursor + pad)
        obj = json.loads(raw, parse_float=Decimal)
    except Exception as e:
        raise ValueError(f"invalid pagination cursor: {e}") from e
    if not isinstance(obj, dict):
        raise ValueError("invalid pagination cursor: not a key object")
    return obj


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
