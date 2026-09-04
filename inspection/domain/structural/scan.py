"""结构性风险扫描主入口 + 指纹去重（R2.4 / R12.6b）。

    实例属性列表
        │
        ├─ scan_structural        逐台跑七条规则 → [Finding]（打 cadence: monthly）
        │
        └─ group_by_fingerprint   按 (服务, 规格, 引擎大版本, 命中规则集, tier) 收敛
                                  → [FingerprintGroup]，这才是交给 DA 的单位

为什么要指纹去重：结构性风险是属性判定，同一指纹的判读结论逐字相同。
实测本账号 11 台 RDS 里 6 台同为 `db.t3.medium` + `mysql 8.4`，
不去重就是让 DA 把同一段推理做 6 遍。

⚠️ 指纹只共享「这类问题该怎么办」，**共享不了 per-instance 数值**。
per-instance 的数字（例如这 6 台里哪 2 台 CPU credit 余额 < 20%）由 Lambda 算好后
附在指纹载荷里，DA 一次判读、结论回填该指纹下全部实例。
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import replace
from datetime import date

from inspection.domain.dto import (
    Fingerprint,
    Finding,
    FingerprintGroup,
    ResourceAttrs,
    Severity,
    StructuralRefData,
    StructuralRuleConfig,
)
from inspection.domain.structural.rules import RULES, applies_to, major_version

# 严重度排序用（越靠前越严重）。⚠️ 原先这里另存了一份 {"critical":0,...} 的小写映射，
# 与 dto 的 Severity、payload 的大写四值三处分叉。现在统一走 Severity.order ——
# 分叉的表现是「排序看起来正常但档位对不上」，不会报错。
def _sev_order(value) -> int:
    try:
        return Severity.coerce(value).order
    except ValueError:
        return 99


def scan_structural(
    attrs_list: Sequence[ResourceAttrs],
    refdata: StructuralRefData,
    cfg: StructuralRuleConfig,
    today: date,
) -> list[Finding]:
    """R2.4b.3 声明的签名（加 today 参数 —— domain 层不许调 date.today()）。

    返回顺序稳定：先按严重度，再按 instance_id，再按规则名。
    稳定顺序是可重放的前提，也让 R12.6a 的 top-N 截断有确定结果。
    """
    findings: list[Finding] = []

    for attrs in attrs_list:
        for rule, fn in RULES.items():
            if not applies_to(rule, attrs.service):
                continue
            hit = fn(attrs, refdata, cfg, today)
            if hit is not None:
                findings.append(hit)

    return sort_findings(findings)


def sort_findings(findings: Iterable[Finding]) -> list[Finding]:
    return sorted(
        findings,
        key=lambda f: (
            _sev_order(f.severity),
            f.instance_id,
            f.rule.value,
        ),
    )


def fingerprint_of(
    attrs: ResourceAttrs, rules: Iterable[str]
) -> Fingerprint:
    """算一台实例在某组命中规则下的指纹。

    规则集合先排序 —— 否则同一组规则因遍历顺序不同会产生两个指纹。
    """
    return Fingerprint(
        service=attrs.service,
        instance_class=attrs.instance_class,
        engine_major=major_version(attrs.engine, attrs.engine_version) or "",
        rules=tuple(sorted(set(rules))),
        tier=attrs.tier,
    )


def group_by_fingerprint(
    findings: Sequence[Finding],
    attrs_by_id: dict[str, ResourceAttrs],
) -> list[FingerprintGroup]:
    """把 finding 按指纹收敛成 DA 的派发单位。

    Args:
        findings: `scan_structural` 的输出。
        attrs_by_id: instance_id -> ResourceAttrs，指纹需要规格与引擎信息。

    ⚠️ 指纹的「命中规则集」是**该实例本轮命中的全部规则**，不是单条规则。
    这样同一台实例的多条 finding 归到同一个指纹里，DA 一次看完
    「这台既是 T 系又单 AZ 又快 EOL」，而不是分三次各看一条。
    """
    # 先按实例把命中的规则聚起来
    rules_by_instance: dict[str, set[str]] = {}
    for f in findings:
        rules_by_instance.setdefault(f.instance_id, set()).add(f.rule.value)

    # 再按指纹归组
    groups: dict[str, tuple[Fingerprint, list[Finding]]] = {}
    for f in findings:
        attrs = attrs_by_id.get(f.instance_id)
        if attrs is None:
            # 拿不到属性就按实例单独成组，不猜 —— 否则会跟别人错误合并
            fp = Fingerprint(
                service=f.service, instance_class="", engine_major="",
                rules=tuple(sorted(rules_by_instance[f.instance_id])),
                tier="",
            )
        else:
            fp = fingerprint_of(attrs, rules_by_instance[f.instance_id])

        stamped = replace(f, fingerprint_key=fp.key)
        bucket = groups.setdefault(fp.key, (fp, []))
        bucket[1].append(stamped)

    out = [
        FingerprintGroup(fingerprint=fp, findings=tuple(sort_findings(items)))
        for fp, items in groups.values()
    ]
    # 覆盖实例多的、严重度高的排前面 —— top-N 截断时先保住影响面大的
    return sorted(
        out,
        key=lambda g: (
            _sev_order(g.findings[0].severity),
            -g.instance_count,
            g.fingerprint.key,
        ),
    )


def dedup_ratio(
    findings: Sequence[Finding], groups: Sequence[FingerprintGroup]
) -> float:
    """去重收益，用于运维可观测性（R9.x）。1.0 = 完全没收敛。"""
    if not groups:
        return 0.0
    instances = len({f.instance_id for f in findings})
    return instances / len(groups)
