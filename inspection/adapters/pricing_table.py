"""价格表加载 —— 把老 `engine._load_pricing_data` 的 IO 从 domain 层挪出来。

老实现的两个问题：
  · `open()` 在 domain 函数内部（违反 R14.1）
  · 模块级全局 `_PRICING_DATA` 让单测互相污染，测试得手动复位

这里用 `functools.lru_cache` 替代手写全局：语义一样（进程内只读一次），
但自带 `cache_clear()`，测试不需要碰私有变量。
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parents[1]

# 新表带 as_of / region / region_verified 三个溯源字段（R11e.3）。
_PRIMARY_PATH = _ROOT / "data" / "pricing_estimates.json"

# 老表无溯源字段，仅作过渡兜底。Phase 11 删 lambda2_analyzer 后这条路径失效，
# 届时未迁完的机型走关键字兜底（会被标 coarse_keyword，不会静默当精确价用）。
_LEGACY_PATH = _ROOT.parent / "lambda2_analyzer" / "aws_pricing_estimates.json"


@lru_cache(maxsize=4)
def load_pricing_table(path: str | None = None) -> dict:
    """读价格表。文件缺失或格式坏了返回 {} 并告警 —— 不抛异常。

    优先新表；新表缺失才退老表，且退老表时**不补 as_of / region**
    —— 让 `pricing._provenance()` 拿到 None，估算自然落到 coarse 档。
    SHALL NOT 给老表编一个 as_of，那等于把不可信数据洗成可信的。

    ⚠️ 价格表只影响估算精度与排序，不影响「是不是闲置」的判定。
    为它让整轮巡检失败不划算，所以这里降级而不是 fail-fast。
    """
    candidates = [Path(path)] if path else [_PRIMARY_PATH, _LEGACY_PATH]

    for target in candidates:
        data = _read_json(target)
        if data is not None:
            if "as_of" not in data:
                logger.warning(
                    "pricing table %s 无 as_of/region 溯源字段，估算将全部标为 coarse",
                    target,
                )
            return data

    logger.warning(
        "no pricing table readable (tried %s); falling back to keyword table",
        ", ".join(str(c) for c in candidates),
    )
    return {}


def _read_json(target: Path) -> dict | None:
    try:
        with open(target, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("pricing table at %s unreadable (%s)", target, exc)
        return None
    if not isinstance(data, dict):
        logger.warning("pricing table at %s is not an object", target)
        return None
    return data
