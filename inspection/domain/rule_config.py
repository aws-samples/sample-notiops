"""把客户改过的阈值覆盖到判定配置上（R13.4）。

## 这条链路此前是断的

```
前端      没有阈值编辑区
BFF       getConfig 的 rules 恒为 {}，也没有写端点
Python    load_rule_config 是自循环 —— 唯一的写者 snapshot_config 的入参
          就是它自己的返回值，于是线上 config_json 恒为 "{}"
判定层    judge_findings 的 threshold_cfg 参数没有任何生产调用者
```

本模块补的是最后一段：**DDB 里的配置字典 → 判定层要的 dataclass**。

## 为什么必须是「部分覆盖」而不是「全量替换」

只存客户改过的键，反序列化时 `dataclasses.replace(默认对象, **改过的键)`。

⚠️ 全量存下来的后果在**加新阈值字段**那天显形：老配置里没有新字段，
如果按「配置里有什么就是全部」来构造，新字段会拿到 `None` 而不是它的默认值
—— 表现是新规则对所有存量客户静默失效。部分覆盖没有这个问题。

## 读侧宽容、写侧严格

```
写侧（BFF）   未知字段 → 400；越界 → 400。错误停在 UI 上，客户当场看到
读侧（本模块）未知字段 → 忽略 + WARNING；越界 → 钳到边界 + WARNING
```

⚠️ 读侧不能抛。这里抛异常等于**一行手工改坏的配置让整轮巡检失败**，
而巡检失败在界面上只是「本轮未发现风险」—— 与「真的没风险」长得一样。
宁可用一个被钳过的值判一轮并留下 WARNING。
"""

from __future__ import annotations

import logging
from dataclasses import fields as dc_fields
from dataclasses import replace as dc_replace
from typing import Any

from inspection.domain import rule_limits as rl

logger = logging.getLogger(__name__)


def _coerce(spec: dict[str, Any], raw: Any) -> Any | None:
    """按字段类型转换。转不了返回 `None`（调用方跳过该字段）。

    ⚠️ DDB 读回来的数字是 `Decimal`，`bool` 是 `int` 的子类 —— 两者都要处理：
    `Decimal("70")` 要变成 `70.0`，而 `True` 不该被当成 `1`。
    """
    kind = spec["type"]
    if kind == rl.STR_SET:
        if isinstance(raw, (str, bytes)) or not hasattr(raw, "__iter__"):
            return None
        vals = [str(v).strip() for v in raw if str(v).strip()]
        return frozenset(vals) if vals else None
    if isinstance(raw, bool):
        return None                      # 数值字段收到布尔一律当非法
    try:
        num = float(raw)
    except (TypeError, ValueError):
        return None
    if num != num or num in (float("inf"), float("-inf")):    # NaN / inf
        return None
    return int(num) if kind == rl.INT else num


def _clamp(spec: dict[str, Any], val: Any) -> Any:
    lo, hi = spec.get("min"), spec.get("max")
    if lo is not None and val < lo:
        return lo
    if hi is not None and val > hi:
        return hi
    return val


def validate(section: str, key: str, raw: Any) -> tuple[Any, str]:
    """写侧校验。返回 `(规范化后的值, 错误码)`，错误码为空即合法。

    错误码是给 BFF 直接当 `code` 用的，所以是稳定的短字符串。
    """
    spec = rl.find(section, key)
    if spec is None:
        return None, "unknown_field"
    val = _coerce(spec, raw)
    if val is None:
        return None, "bad_type"
    if spec["type"] == rl.STR_SET:
        return sorted(val), ""
    lo, hi = spec.get("min"), spec.get("max")
    if lo is not None and val < lo:
        return None, "below_min"
    if hi is not None and val > hi:
        return None, "above_max"
    return val, ""


def normalize_overrides(
    run_type: str, raw: Any,
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """写侧：把请求体规范化成只含合法字段的覆盖字典。

    Returns:
        `(overrides, errors)`。`errors` 非空时调用方应当拒绝整个请求 ——
        部分写入会让客户以为全都存上了。
    """
    allowed = rl.sections_for(run_type)
    if not allowed:
        return {}, [f"bad_run_type:{run_type}"]
    out: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    if not isinstance(raw, dict):
        return {}, ["bad_body"]
    for section, body in raw.items():
        if section not in allowed:
            errors.append(f"section_not_allowed:{section}")
            continue
        if not isinstance(body, dict):
            errors.append(f"bad_section_body:{section}")
            continue
        for key, value in body.items():
            val, err = validate(section, key, value)
            if err:
                errors.append(f"{err}:{section}.{key}")
                continue
            out.setdefault(section, {})[key] = val
    errors.extend(_cross_field_errors(out))
    return out, errors


# 跨字段不变量。`validate()` 是逐字段的，表达不了「A 不得大于 B」。
#
# 🔴 少了这一层的后果是「写侧放行、读侧抛」：
#
# ```
# 客户把 chronic_days_min 从 5 调到 10（范围 2..30，写侧放行）
#   → 而 chronic_min_coverage 还是 7
#   → 下一轮 ThresholdRuleConfig.__post_init__ 抛 ValueError
#   → run 落 failed → SQS 重投 → DLQ → **两类巡检每天全失败**
# ```
#
# ⚠️ 判据要用**生效值**（覆盖 ∪ 默认），不能只看这次改了哪个。客户只改一个字段
#    时另一个是默认值，而冲突恰恰发生在那种情况。
_CROSS_FIELD: tuple[tuple[str, str, str, str], ...] = (
    ("threshold", "chronic_min_coverage", "chronic_days_min",
     "chronic_min_coverage 不得小于 chronic_days_min —— "
     "否则「连续 N 天」在 coverage 窗口里永远数不出来，慢性规则静默失效"),
)


def _cross_field_errors(out: dict[str, dict[str, Any]]) -> list[str]:
    """检查跨字段不变量。返回错误码列表（空 = 合法）。"""
    from inspection.domain.thresholds import ThresholdRuleConfig

    errs: list[str] = []
    base = ThresholdRuleConfig()
    for section, big, small, why in _CROSS_FIELD:
        body = out.get(section) or {}
        if big not in body and small not in body:
            continue                       # 这次没碰这两个字段
        eff_big = body.get(big, getattr(base, big))
        eff_small = body.get(small, getattr(base, small))
        if eff_big < eff_small:
            errs.append(f"cross_field:{section}.{big}<{small}:{why}")
    return errs


def _apply(obj: Any, overrides: Any, *, label: str) -> Any:
    """把 `overrides` 覆盖到 dataclass 实例上。读侧宽容。"""
    if not isinstance(overrides, dict) or not overrides:
        return obj
    known = {f.name for f in dc_fields(obj)}
    patch: dict[str, Any] = {}
    for key, raw in overrides.items():
        spec = rl.find(label, key)
        if spec is None or key not in known:
            # 不在白名单里的字段一律忽略 —— 包括 window_days 这类刻意不开放的。
            logger.warning("配置里的 %s.%s 不是可改字段，已忽略", label, key)
            continue
        val = _coerce(spec, raw)
        if val is None:
            logger.warning("配置里的 %s.%s=%r 类型不对，已忽略", label, key, raw)
            continue
        if spec["type"] != rl.STR_SET:
            clamped = _clamp(spec, val)
            if clamped != val:
                logger.warning("配置里的 %s.%s=%s 越界，已钳到 %s",
                               label, key, val, clamped)
            val = clamped
        patch[key] = val
    if not patch:
        return obj
    # 🔴 **读侧不许抛。** 这个模块的 docstring 逐字写着「读侧不能抛，这里抛
    #    异常等于一行手工改坏的配置让整轮巡检失败」，而 `dc_replace` 会触发
    #    `__post_init__` 的校验 —— 那条路一直是通的：
    #
    #    ```
    #    客户把 chronic_days_min 调到 10（写侧当时放行）
    #      → threshold_config(raw) → dc_replace → ValueError
    #      → _run_inspection 冒到 _process_one → run failed → 重投 → DLQ
    #      → 闲置轮一起挂（它也无条件调 threshold_config）
    #    ```
    #
    #    写侧现在有跨字段校验了（`_cross_field_errors`），但**已经写进库的**
    #    历史坏配置、手工改的库、以及将来新加的不变量都会重新打开这条路。
    #
    # ⚠️ 降级策略是**逐字段回退**而不是整段丢弃：一个字段冲突不该让客户其余
    #    十几个自定义阈值一起失效（那等于静默回到全默认，误报会成批回来）。
    try:
        return dc_replace(obj, **patch)
    except (ValueError, TypeError) as e:
        logger.error(
            "配置 %s 整段应用失败（%s）—— 逐字段回退，冲突的那些用默认值。"
            "写侧的跨字段校验应当拦住这种组合，出现在这里说明是历史数据或"
            "手工改库", label, e)
    good = obj
    for key, val in patch.items():
        try:
            good = dc_replace(good, **{key: val})
        except (ValueError, TypeError) as e:
            logger.error("配置 %s.%s=%s 与其他字段冲突，已忽略：%s",
                         label, key, val, e)
    return good


def threshold_config(raw: Any) -> Any:
    """高负载轮的 `ThresholdRuleConfig`（应用客户覆盖后）。"""
    from inspection.domain.thresholds import ThresholdRuleConfig

    base = ThresholdRuleConfig()
    if not isinstance(raw, dict):
        return base
    return _apply(base, raw.get("threshold"), label="threshold")


def inspection_config(raw: Any, *, window_days: int, max_workers: Any = None) -> Any:
    """闲置轮的 `InspectionConfig`（应用客户覆盖后）。

    ⚠️ `window_days` 与 `max_workers` **由调用方给，不从客户配置读** ——
    前者是数据窗口（与采集耦合，改它会让判定拿不到数），后者是并发度。
    两者都不在 `rule_limits.FIELDS` 里，所以就算客户硬塞进 config_json
    也会被 `_apply` 当未知字段忽略。
    """
    from inspection import pipeline
    from inspection.domain.dto import CapacityRuleConfig, IdleRuleConfig
    from inspection.domain.structural.rules import StructuralRuleConfig

    body = raw if isinstance(raw, dict) else {}
    kw: dict[str, Any] = {
        "idle": _apply(IdleRuleConfig(), body.get("idle"), label="idle"),
        "capacity": _apply(CapacityRuleConfig(), body.get("capacity"),
                           label="capacity"),
        "structural": _apply(StructuralRuleConfig(), body.get("structural"),
                             label="structural"),
        "window_days": window_days,
    }
    if max_workers is not None:
        kw["max_workers"] = max_workers
    return pipeline.InspectionConfig(**kw)


def to_storable(overrides: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """覆盖字典 → 可写进 `config_json` 的形状。

    ⚠️ `frozenset` 要转成**排序后的 list**：json 不认识 set，而不排序会让
    同一份配置每次序列化出不同的 `config_hash` → 每轮都被判成「规则变更」
    → 按 R6.9 强制 resolve 全部 finding。
    """
    out: dict[str, Any] = {}
    for section, body in overrides.items():
        clean: dict[str, Any] = {}
        for key, val in (body or {}).items():
            clean[key] = sorted(val) if isinstance(val, (set, frozenset)) else val
        if clean:
            out[section] = clean
    return out


def describe(run_type: str, stored: Any) -> dict[str, Any]:
    """给 UI 的完整描述：每个可改字段的当前值、默认值、范围、单位、适用服务。

    ⚠️ 前端 SHALL NOT 自己写死范围或服务归属 —— 那会与后端分叉，表现是
    「UI 上填得进去、点保存报 400」或「标签说管 Redis 而其实不管」。
    """
    body = stored if isinstance(stored, dict) else {}
    sections: dict[str, Any] = {}
    for section in rl.sections_for(run_type):
        cur = body.get(section) if isinstance(body.get(section), dict) else {}
        items = []
        for spec in rl.fields_of(section):
            key = spec["key"]
            raw = cur.get(key)
            val = spec["default"] if raw is None else _coerce(spec, raw)
            if val is None:
                val = spec["default"]
            if isinstance(val, frozenset):
                val = sorted(val)
            items.append({
                "key": key, "type": spec["type"], "value": val,
                "default": spec["default"], "min": spec["min"],
                "max": spec["max"], "unit": spec["unit"],
                "label_zh": spec["label_zh"], "label_en": spec["label_en"],
                # 🔴 这个字段对哪些服务组真的生效。不给的话客户改了
                #    `read_latency_seconds` 会以为 Redis 也跟着变 —— 而那
                #    完全不生效且零提示。
                "services": list(spec["services"]),
                # 客户改过没有 —— 前端据此把「已自定义」标出来，
                # 否则「默认 70 而客户也填了 70」与「没配过」长得一样。
                "customized": key in cur,
            })
        sections[section] = items
    return sections


def service_catalog() -> list[dict[str, Any]]:
    """给 UI 的服务筛选器数据：四个服务组 + 各自的字段数。

    🔴 **这是筛选器不是作用域。** 阈值配置全局一份，选服务只决定显示哪些
    字段。调用方 SHALL 把这句话呈现出来 —— 做成看起来像「给这个服务单独
    设一套」会让客户以为只调了 Redis，而 RDS 也跟着变了，且没有任何信号。
    """
    return [
        {
            "key": svc,
            "label_zh": rl.SERVICE_LABELS[svc]["zh"],
            "label_en": rl.SERVICE_LABELS[svc]["en"],
            "hint_zh": rl.SERVICE_LABELS[svc]["hint_zh"],
            "hint_en": rl.SERVICE_LABELS[svc]["hint_en"],
            "field_count": rl.count_for(svc),
        }
        for svc in rl.SERVICES
    ]
