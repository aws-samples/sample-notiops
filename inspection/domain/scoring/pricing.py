"""月度成本估算 —— 承接老 `engine.estimate_monthly_savings`。

与老实现的两处差异：

1. **价格表作为入参传入**，不在函数里 `open()` 本地 JSON。
   老实现用模块级全局 `_PRICING_DATA` + `open(Path(__file__).parent / ...)`，
   domain 层不允许（R14.1），而且模块级缓存让单测互相污染
   （`tests/test_engine.py:538` 就得手动 `eng._PRICING_DATA = None` 复位）。
   加载 JSON 的活儿归 `inspection/adapters/pricing_table.py`。

2. **返回带精度标记的 `PriceEstimate` 而不是裸 float**（R11e.3）。
   老实现返回一个 float，调用方无法区分「查到精确价」和「按关键字猜的 $60 兜底」，
   而 R4.6 拿它当「唯一可比的共同标尺」做跨服务排序 —— 排序会被兜底值主导且无人察觉。

⚠️ 现有价格表**无 region、无 as_of**（`git log` 显示 2026-06-02 一次提交后从未更新），
所以本模块对来自该表的取值一律标 `TABLE_UNVERIFIED_REGION`，不敢标 EXACT。
价格按区域差异可达 30%+。彻底修法是 ：改从 AWS Price List API 生成。
"""

from __future__ import annotations

from collections.abc import Mapping

from inspection.domain.dto import PriceEstimate, PricePrecision

# 规格关键字 → 月成本兜底估算（USD）。精确价查不到时才用。
# 长关键字优先匹配（"2xlarge" 要在 "xlarge" 之前命中）。
_FALLBACK_TABLE: tuple[tuple[str, float], ...] = (
    ("nano", 15.0),
    ("micro", 15.0),
    ("small", 30.0),
    ("medium", 60.0),
    ("large", 120.0),
    ("xlarge", 250.0),
    ("2xlarge", 500.0),
    ("4xlarge", 1000.0),
    ("8xlarge", 1000.0),
    ("12xlarge", 1000.0),
    ("16xlarge", 1000.0),
    ("24xlarge", 1000.0),
)

DEFAULT_MONTHLY_USD = 60.0


def estimate_monthly_savings(
    instance_class: str,
    engine: str = "",
    num_nodes: int = 1,
    price_table: Mapping[str, object] | None = None,
) -> PriceEstimate:
    """估算这个实例每月大约多少钱。

    Args:
        instance_class: 'db.r5.large' / 'cache.m5.large'。
        engine: 目前不参与计算，保留是为了与老签名兼容（调用方已在传）。
        num_nodes: ElastiCache 副本组的节点数；RDS 恒按 1 算。
        price_table: `inspection.adapters.pricing_table.load_pricing_table()` 的返回。
            None 则只走关键字兜底。

    Returns:
        `PriceEstimate` —— ElastiCache 为单节点价 × 节点数。

    ⚠️ 这是**估算**，不是账单。用途是 R4.6 的跨服务排序与给客户量级感，
    SHALL NOT 当成本承诺。
    """
    lower = (instance_class or "").lower()
    nodes = max(num_nodes or 1, 1)
    as_of, region = _provenance(price_table)

    if not lower:
        return PriceEstimate(
            DEFAULT_MONTHLY_USD, PricePrecision.COARSE_DEFAULT,
            as_of=as_of, region=region, num_nodes=nodes,
        )

    is_cache = lower.startswith("cache.")

    # 1. 精确条目
    exact = _lookup_exact(lower, is_cache, price_table)
    if exact is not None:
        total = exact * nodes if is_cache else exact
        # 连 as_of 都没有的表（老 aws_pricing_estimates.json）降一档 ——
        # 不知道是哪天采的价，不该与有日期的表同级。
        precision = (
            PricePrecision.TABLE_UNVERIFIED_REGION if as_of
            else PricePrecision.TABLE_NO_PROVENANCE
        )
        return PriceEstimate(
            total, precision, matched_key=lower,
            as_of=as_of, region=region, num_nodes=nodes,
        )

    # 2. 关键字兜底
    for keyword, cost in sorted(_FALLBACK_TABLE, key=lambda kv: len(kv[0]), reverse=True):
        if keyword in lower:
            total = cost * nodes if is_cache else cost
            return PriceEstimate(
                total, PricePrecision.COARSE_KEYWORD, matched_key=keyword,
                as_of=as_of, region=region, num_nodes=nodes,
            )

    # 3. 全局兜底
    return PriceEstimate(
        DEFAULT_MONTHLY_USD, PricePrecision.COARSE_DEFAULT,
        as_of=as_of, region=region, num_nodes=nodes,
    )


def _provenance(price_table: Mapping[str, object] | None) -> tuple[str | None, str | None]:
    if not price_table:
        return None, None
    as_of = price_table.get("as_of")
    region = price_table.get("region") if price_table.get("region_verified") else None
    return (str(as_of) if as_of else None), (str(region) if region else None)


def _lookup_exact(
    lower_class: str,
    is_cache: bool,
    price_table: Mapping[str, object] | None,
) -> float | None:
    if not price_table:
        return None
    monthly = price_table.get("monthly_usd")
    if not isinstance(monthly, Mapping):
        return None
    bucket = monthly.get("elasticache_node" if is_cache else "rds")
    if not isinstance(bucket, Mapping):
        return None
    value = bucket.get(lower_class)
    return float(value) if isinstance(value, (int, float)) else None
