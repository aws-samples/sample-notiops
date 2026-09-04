"""结构性风险的参考数据（R2.4b.4）。

两张表：
    引擎大版本 → 标准 / Extended 支持窗口   rds:DescribeDBMajorEngineVersions
    CA 证书标识 → 到期日                     rds:DescribeCertificates

⚠️ **这里是 `bff/web-chat/eos.mjs` 那个 bug 的正确写法**（R11e.2b）。
eos.mjs 调 `DescribeDBEngineVersions` 并读 `SupportedEngineLifecycle`，但该字段只存在于
`DBMajorEngineVersion` shape 上（已核对 botocore 1.43.19 的 rds/2014-10-31 模型），
`DBEngineVersion` 从来没有它 —— 实测 93 个引擎版本零个返回，且因 `catch{}` 静默降级，
导致 EOS 面板上 RDS/Aurora 的到期日恒为 null。
Phase 3.7 修 eos.mjs 时可直接照这里的调用方式改。

⚠️ 实测的大版本粒度按引擎不同（2026-08-17，us-east-1）：
    mysql / aurora-mysql   5.7 · 8.0 · 8.4          两段
    postgres               11 ~ 18                  一段
`rules.major_version()` 写死了这个差异，不要试图统一推导。
"""

from __future__ import annotations

import json
import logging
import pathlib
from datetime import date, datetime

from botocore.exceptions import BotoCoreError, ClientError

from inspection.domain.dto import (
    EngineLifecycle,
    LifecyclePhase,
    LifecycleWindow,
    StructuralRefData,
)

logger = logging.getLogger(__name__)

# v1 首批范围（用户 2026-08-17 定）：
#   RDS for PostgreSQL · RDS for MySQL · Aurora MySQL · Aurora PostgreSQL · ElastiCache
# ElastiCache 不在这个列表里 —— 它没有等价 API，走 elasticache_eol.json（见 load_refdata）。
DEFAULT_ENGINES: tuple[str, ...] = (
    "postgres",
    "mysql",
    "aurora-mysql",
    "aurora-postgresql",
)


_EC_EOL_PATH = pathlib.Path(__file__).resolve().parents[1] / "data" / "elasticache_eol.json"


def load_refdata(
    rds_client,
    *,
    engines: tuple[str, ...] = DEFAULT_ENGINES,
    include_elasticache: bool = True,
) -> StructuralRefData:
    """拉齐两张参考表。任一部分失败只降级该部分，不抛。

    降级后对应规则会因为查不到而跳过（rules.py 的约定：属性/参考数据缺失即不判定），
    结果是「少报」而不是「误报」—— 这是 R2.4.3 零误报要求下的正确取舍。
    """
    lifecycles = load_engine_lifecycles(rds_client, engines=engines)
    if include_elasticache:
        lifecycles.update(load_elasticache_lifecycles())
    return StructuralRefData(
        engine_lifecycles=lifecycles,
        ca_cert_expiry=load_ca_cert_expiry(rds_client),
    )


def load_elasticache_lifecycles(
    path: pathlib.Path | None = None,
) -> dict[tuple[str, str], EngineLifecycle]:
    """ElastiCache 的支持窗口 —— 读维护表，不是 API。

    ⚠️ ElastiCache 没有等价于 `rds:DescribeDBMajorEngineVersions` 的 API：
    `CacheEngineVersion` shape 只有 5 个字段，无任何生命周期信息
    （已核对 botocore 1.43.19 的 elasticache/2015-02-02 模型）。
    这是本 feature 里**唯一**需要人工维护的参考表，运维项见 json 里的 `_ops`。

    空对象（如 valkey / memcached）= AWS 未公布，不是漏填 → 规则跳过，不猜日期。
    """
    target = path or _EC_EOL_PATH
    try:
        with open(target, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        logger.warning("elasticache EOL table missing at %s; EC EOL 规则将跳过", target)
        return {}
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("elasticache EOL table unreadable (%s); EC EOL 规则将跳过", exc)
        return {}

    as_of = raw.get("asOf")
    out: dict[tuple[str, str], EngineLifecycle] = {}
    for engine, majors in (raw.get("engines") or {}).items():
        for major, spec in (majors or {}).items():
            if not isinstance(spec, dict):
                continue
            std_end = _to_date(spec.get("standard_support_end"))
            ext_end = _to_date(spec.get("extended_support_end"))
            if std_end is None:
                continue
            windows = [LifecycleWindow(LifecyclePhase.STANDARD, None, std_end)]
            if ext_end is not None:
                windows.append(LifecycleWindow(LifecyclePhase.EXTENDED, std_end, ext_end))
            out[(engine.lower(), str(major))] = EngineLifecycle(
                engine=engine.lower(), major_version=str(major),
                windows=tuple(windows),
            )

    logger.info("loaded %d ElastiCache lifecycles (table asOf=%s)", len(out), as_of)
    return out


def elasticache_table_as_of(path: pathlib.Path | None = None) -> str | None:
    """给运维面板用 —— 表多久没核对了（R2.4b.4 的季度核对运维项）。"""
    try:
        with open(path or _EC_EOL_PATH, encoding="utf-8") as f:
            return json.load(f).get("asOf")
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def elasticache_table_staleness_days(today: date, path: pathlib.Path | None = None) -> int | None:
    """表距上次核对过了多少天。`None` = 表里没有 `asOf` 或读不出来。

    ⚠️ 这是本 feature 里**唯一**需要人工维护的参考表（ElastiCache 没有等价
    于 `rds:DescribeDBMajorEngineVersions` 的 API），所以它的陈旧程度必须是
    一个能上看板、能告警的**数字**，而不是一句「记得每季度核对」的注释。
    `elasticache_table_as_of()` 只返回日期字符串，没人拿它跟今天比过 ——
    那等于把运维项写在了没人读的地方。
    """
    as_of = _to_date(elasticache_table_as_of(path))
    return (today - as_of).days if as_of else None


def load_engine_lifecycles(
    rds_client,
    *,
    engines: tuple[str, ...] = DEFAULT_ENGINES,
) -> dict[tuple[str, str], EngineLifecycle]:
    """{(engine, major_version): EngineLifecycle}。

    每个引擎独立 try/except —— 一个引擎不可用（如该区域不支持）不该拖垮其余。
    """
    out: dict[tuple[str, str], EngineLifecycle] = {}

    for engine in engines:
        try:
            pages = _paginate(
                rds_client, "describe_db_major_engine_versions", {"Engine": engine}
            )
        except (ClientError, BotoCoreError) as exc:
            logger.warning(
                "DescribeDBMajorEngineVersions failed for engine=%s: %s", engine, exc
            )
            continue

        for page in pages:
            for item in page.get("DBMajorEngineVersions", []) or []:
                major = item.get("MajorEngineVersion")
                if not major:
                    continue
                windows = tuple(
                    w for w in (
                        _to_window(raw)
                        for raw in (item.get("SupportedEngineLifecycles") or [])
                    ) if w is not None
                )
                if not windows:
                    # AWS 对尚未公布 EOL 的大版本返回空列表（实测 aurora-mysql 8.4）。
                    # 空列表 = 「还没announce」，不是错误，也不要伪造日期。
                    continue
                out[(engine.lower(), str(major))] = EngineLifecycle(
                    engine=engine.lower(), major_version=str(major), windows=windows
                )

    logger.info("loaded %d engine major-version lifecycles", len(out))
    return out


def load_ca_cert_expiry(rds_client) -> dict[str, date]:
    """{CA 标识: 到期日}。如 rds-ca-rsa2048-g1 -> 2061-05-xx。"""
    out: dict[str, date] = {}
    try:
        pages = _paginate(rds_client, "describe_certificates", {})
    except (ClientError, BotoCoreError) as exc:
        logger.warning("DescribeCertificates failed: %s", exc)
        return out

    for page in pages:
        for cert in page.get("Certificates", []) or []:
            ident = cert.get("CertificateIdentifier")
            valid_till = _to_date(cert.get("ValidTill"))
            if ident and valid_till is not None:
                out[str(ident)] = valid_till

    logger.info("loaded %d CA certificate expiry dates", len(out))
    return out


# ---------------------------------------------------------------------------
# 内部工具
# ---------------------------------------------------------------------------


def _paginate(client, operation: str, params: dict) -> list[dict]:
    """能分页就分页，不能就单次调用。

    `describe_db_major_engine_versions` 在部分 botocore 版本里没有注册 paginator，
    直接 get_paginator 会抛 OperationNotPageableError。
    """
    try:
        paginator = client.get_paginator(operation)
    except Exception:  # noqa: BLE001 — OperationNotPageableError 或方法不存在
        return [getattr(client, operation)(**params)]
    return list(paginator.paginate(**params))


def _to_window(raw: dict) -> LifecycleWindow | None:
    name = raw.get("LifecycleSupportName")
    try:
        phase = LifecyclePhase(name)
    except ValueError:
        logger.debug("unknown LifecycleSupportName %r, skipped", name)
        return None
    return LifecycleWindow(
        phase=phase,
        start_date=_to_date(raw.get("LifecycleSupportStartDate")),
        end_date=_to_date(raw.get("LifecycleSupportEndDate")),
    )


def _to_date(value) -> date | None:
    """boto3 返回 datetime；也容忍字符串（便于用录制的 fixture 回放）。"""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
        except ValueError:
            try:
                return date.fromisoformat(value[:10])
            except ValueError:
                return None
    return None
