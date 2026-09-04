#!/usr/bin/env python3
"""拿真实资源验证**采集层**：AWS API → `ResourceAttrs` → 判定层的输入。

## 为什么必须用真资源验

采集层的单测全都喂 fake describe 响应。fake 响应是**我们以为 API 长什么样**，
而这一层踩过的坑全部是「API 实际长的样子和我们以为的不一样」：

```
db.serverless        Serverless v2 的 DBInstanceClass 就是这个字符串
                     specs 查不到它的内存 → memory 维度必须优雅降级
valkey               新引擎。`metric_family` 认不认它决定了整组指标取不取
集群模式启用的 Redis  节点在 NodeGroups 里，不在 CacheClusters 的顶层
MultiAZ + Aurora     Aurora 的 HA 在集群层，实例层的 MultiAZ 恒 False
```

判定层的覆盖靠 `tests/test_inspection_verdict_matrix.py`（真实客户观测值），
两者不可互相替代 —— 那边测「数值 → 结论」，这里测「API → 属性」。

## 判据

每一行打印实际读到的值，并对**已知应当为真**的断言做检查。断言失败不抛，
打 `✗` 继续 —— 一次跑完看到全部问题，比修一个跑一次快。
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

REGION = "ap-northeast-1"
ACCT = "111122223333"

fails: list[str] = []


def check(cond: bool, label: str, got: object = "") -> None:
    if cond:
        print(f"    ✓ {label}" + (f"  ({got})" if got != "" else ""))
    else:
        print(f"    ✗ {label}  实际: {got!r}")
        fails.append(label)


def main() -> int:
    import boto3

    from inspection.adapters import attrs_repo as ar
    from inspection.domain import metrics_meta as mm
    from inspection.domain import specs
    from inspection.domain.rule_config import threshold_config
    from inspection.domain.thresholds import engine_variant_key

    cfg = threshold_config({})
    rds = boto3.client("rds", region_name=REGION)
    ec = boto3.client("elasticache", region_name=REGION)

    print("=" * 74)
    print("① RDS / Aurora —— load_rds_attrs")
    print("=" * 74)
    all_rds = ar.load_rds_attrs(rds, ACCT, REGION)
    mine = {a.instance_id: a for a in all_rds
            if a.instance_id.startswith("insp-")}
    print(f"读到 {len(all_rds)} 台，其中本次验证的 {len(mine)} 台\n")

    for iid in sorted(mine):
        a = mine[iid]
        fam = mm.metric_family(a.service, a.engine)
        burst = specs.is_burstable(a.instance_class)
        eff = cfg.for_engine(a.engine)
        gb = (a.memory_bytes / 1024 ** 3) if a.memory_bytes else None
        print(f"  {iid}")
        print(f"    机型 {a.instance_class:16} 引擎 {a.engine:20} "
              f"族 {fam}")
        print(f"    内存 {f'{gb:.1f} GiB' if gb else '(查不到)':12} "
              f"burstable={burst}  tier={a.tier}  "
              f"存储 {a.allocated_storage_gb}")
        print(f"    读延迟档 {eff.read_latency_seconds*1000:.0f}ms  "
              f"写延迟档 {eff.write_latency_seconds*1000:.0f}ms  "
              f"（引擎归一化 → {engine_variant_key(a.engine)}）")
        print(f"    PI enabled={a.performance_insights_enabled} "
              f"retention={a.performance_insights_retention_days}")

        # ── 逐台的已知断言 ──────────────────────────────────────────
        if iid == "insp-t4g-mysql":
            check(burst, "t4g 被识别为 burstable", burst)
            check(a.tier == "prod", "Environment=prod → tier=prod", a.tier)
            check(abs(eff.read_latency_seconds - 0.015) < 1e-9,
                  "社区版 MySQL 走 15ms 档", eff.read_latency_seconds)
        if iid == "insp-m8g-mysql":
            check(not burst, "m8g 不是 burstable", burst)
            # db.m8g.large = 8 vCPU? 不是 —— large 是 2 vCPU / 8 GiB
            check(gb is not None and gb > 4,
                  "8 代机型能查到内存规格", gb)
        if iid == "insp-m7g-pg":
            check(gb is not None and gb > 4, "7 代机型能查到内存规格", gb)
            check(fam == "rds-postgres",
                  "PostgreSQL 归到 rds-postgres 族", fam)
        if iid == "insp-t4g-pi":
            check(a.performance_insights_enabled is True,
                  "PI 开启被读到", a.performance_insights_enabled)
            check(a.performance_insights_retention_days == 7,
                  "PI 保留期 7 天被读到",
                  a.performance_insights_retention_days)
        if iid == "insp-aur-mysql-1":
            check(abs(eff.read_latency_seconds - 0.005) < 1e-9,
                  "🔴 Aurora MySQL 走 5ms 档（不是社区版的 15ms）",
                  eff.read_latency_seconds)
            check(engine_variant_key(a.engine) == "aurora",
                  "aurora-mysql 归一化成 aurora", engine_variant_key(a.engine))
        if iid == "insp-aur-pg-1":
            check(abs(eff.write_latency_seconds - 0.010) < 1e-9,
                  "🔴 Aurora PG 走 10ms 写延迟档",
                  eff.write_latency_seconds)
        if iid == "insp-aur-sv2-1":
            check(a.instance_class == "db.serverless",
                  "Serverless v2 的机型字符串", a.instance_class)
            # 🔴 关键：规格查不到不能崩，也不能返回一个假的内存数
            check(a.memory_bytes is None or a.memory_bytes == 0,
                  "Serverless 查不到固定内存（该降级而不是编一个数）",
                  a.memory_bytes)
            check(not specs.is_burstable("db.serverless"),
                  "db.serverless 不被误判成 burstable")
        print()

    print("=" * 74)
    print("② ElastiCache —— load_elasticache_attrs")
    print("=" * 74)
    all_ec = ar.load_elasticache_attrs(ec, ACCT, REGION)
    ecmine = [a for a in all_ec if a.instance_id.startswith("insp-")]
    print(f"读到 {len(all_ec)} 个节点，其中本次验证的 {len(ecmine)} 个\n")

    by_engine: dict[str, list] = {}
    for a in ecmine:
        by_engine.setdefault(a.engine, []).append(a)

    for a in sorted(ecmine, key=lambda x: x.instance_id):
        fam = mm.metric_family(a.service, a.engine)
        gb = (a.memory_bytes / 1024 ** 3) if a.memory_bytes else None
        alerting = sorted(mm.alerting_metrics(fam))
        print(f"  {a.instance_id}")
        print(f"    机型 {a.instance_class:18} 引擎 {a.engine:12} 族 {fam}")
        print(f"    内存 {f'{gb:.2f} GiB' if gb else '(查不到)':12} "
              f"tier={a.tier}  判定指标 {len(alerting)} 个")
        print(f"    {alerting}")
        print()

    # ── ElastiCache 的关键断言 ──────────────────────────────────────
    print("  断言:")
    check(len(ecmine) >= 5,
          "四种形态的节点都被列出（含集群模式启用的 2 个分片）", len(ecmine))
    check("valkey" in by_engine,
          "🔴 Valkey 被列出来了（新引擎没被静默丢掉）",
          sorted(by_engine))
    if "valkey" in by_engine:
        vfam = mm.metric_family("elasticache", "valkey")
        check(vfam == "redis",
              "🔴 Valkey 归到 redis 族（否则整组指标都取不到）", vfam)
        vmetrics = mm.alerting_metrics(vfam)
        check("MemoryFragmentationRatio" in vmetrics,
              "Valkey 也判碎片率", "MemoryFragmentationRatio" in vmetrics)
    if "memcached" in by_engine:
        mfam = mm.metric_family("elasticache", "memcached")
        mmetrics = mm.alerting_metrics(mfam)
        check("MemoryFragmentationRatio" not in mmetrics,
              "Memcached **不**判碎片率（该族没这个指标）")
        check("CPUUtilization" in mmetrics,
              "🔴 Memcached 判整机 CPU（多线程，与 Redis 相反）",
              "CPUUtilization" in mmetrics)
    if "redis" in by_engine:
        rmetrics = mm.alerting_metrics(mm.metric_family("elasticache", "redis"))
        check("EngineCPUUtilization" in rmetrics,
              "🔴 Redis 判 EngineCPUUtilization（单线程，整机均值无意义）")
        check("CPUUtilization" not in rmetrics,
              "Redis **不**判整机 CPU")
    sharded = [a for a in ecmine if "sharded" in a.instance_id]
    check(len(sharded) >= 2,
          "🔴 集群模式启用的 2 个分片各自成节点（不是一个聚合行）",
          [a.instance_id for a in sharded])

    print()
    print("=" * 74)
    if fails:
        print(f"❌ {len(fails)} 项断言失败:")
        for f in fails:
            print(f"   · {f}")
        return 1
    print("✅ 采集层断言全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
