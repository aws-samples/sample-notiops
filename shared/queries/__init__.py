"""shared.queries — pure boto3 + stdlib DynamoDB-native query layer."""
from __future__ import annotations

from ._client import (
    _zpad,
    config_table,
    decode_cursor,
    encode_cursor,
    metrics_table,
    reset_table_cache,
)

__all__ = [
    "_zpad",
    "config_table",
    "decode_cursor",
    "encode_cursor",
    "metrics_table",
    "reset_table_cache",
]
