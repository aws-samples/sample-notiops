"""群体事件 rollup（R8.6）。

同一 cluster / ASG 内 ≥60% 成员出现**同向同幅**趋势 → 集群层出 1 条，不出 N 条。

```
不 rollup 的样子                      rollup 后
  prod-db-node-1  内存下降  HIGH        prod-db 集群  内存下降  HIGH
  prod-db-node-2  内存下降  HIGH          6/8 成员同向，跌幅 18%~23%
  prod-db-node-3  内存下降  HIGH          成员：node-1 … node-6
  …共 6 条                              （1 条）
```

## 与 `dto.Fingerprint` 的区别（R12.6b vs R8.6，两个正交的轴）

```
Fingerprint  按「这是哪一类问题」去重 —— 跨集群、跨账号都能合
             同一指纹的判读结论逐字相同，让 DA 推理 N 遍是浪费
Rollup       按「这是同一个集群的同一件事」合 —— 只在集群内
             6 台一起掉内存是**一个**现象（可能是流量涨了），不是 6 个
```

两者都要做，顺序是先 rollup（集群内合并）再 Fingerprint（跨集群按类型合并）。
反过来会让「同类型但不同集群」先并成一组，之后再也分不出哪几台属于同一集群。

## 三个会让 rollup 变有害的写法

```
① 分母取「命中数」而不是「已评估成员数」
   3 台命中 / 3 台命中 = 100% → 报「整个集群都在掉内存」
   而集群其实有 10 台，另外 7 台在排除清单里从没看过
   ⇒ 必须同时带上 total / evaluated，让报告能说清「6/8 已评估，另有 2 台未评估」

② 不要求同向
   一半成员 CPU 涨、一半跌 → 那是**负载倾斜**，本身是有价值的发现
   合成一条「集群 CPU 异常」会把这个信号擦掉

③ 低于阈值就把个体 finding 丢掉
   rollup 是「合并表达」，不是「过滤」。2/8 成员掉内存仍然是 2 个真实问题
```
"""

from __future__ import annotations

import statistics
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum

ROLLUP_RATIO = 0.60
"""R8.6 的阈值：同向同幅成员占已评估成员的比例达到它才合并。"""

MIN_MEMBERS = 3
"""参与 rollup 的最少已评估成员数。

⚠️ 取 3 而不是 2：2 台里 2 台同向就是 100%，但「两台都掉内存」说成
「集群级现象」信息量为负 —— 读者会以为有个共因，而两台的样本量支撑不了。
1 台更不必说（`cluster_id` 存在但只有一个成员的集群很常见）。
"""

MAGNITUDE_TOLERANCE = 0.5
"""「同幅」的判据：幅度落在组内中位数的 ±50% 带内。

⚠️ 必须有这条。只要求同向会把「一台跌 80%、五台跌 2%」合成一条，
于是那台真出事的实例被平均进背景噪音里，报告上写「集群轻微下降」。
取 0.5 而不是 0.2：真实集群成员的负载本就不均，带太窄会让 rollup 几乎不触发
（退化成不做 rollup，那还不如不写）。
"""


class Direction(str, Enum):
    """趋势方向。"""

    UP = "up"
    DOWN = "down"
    FLAT = "flat"
    """无明显方向。**不参与 rollup** —— 合并一堆「没什么变化」毫无意义。"""


@dataclass(frozen=True)
class MemberObservation:
    """一个集群成员在某指标上的观测。

    `magnitude` 是**相对变化幅度**（如 0.18 表示 18%），不是绝对值 ——
    绝对值在成员规格不同时不可比（一台 r6g.large 与一台 r6g.4xlarge
    的 FreeableMemory 差一个数量级）。
    """

    instance_id: str
    cluster_id: str
    metric: str
    direction: Direction
    magnitude: float
    severity: str = ""


@dataclass(frozen=True)
class RollupGroup:
    """一条集群层结论。"""

    cluster_id: str
    metric: str
    direction: Direction
    members: tuple[str, ...]
    """参与合并的成员（同向且同幅）。已排序。"""
    evaluated_members: int
    """本轮真正拿到数据的成员数 = 比例的分母。"""
    total_members: int
    """集群声明的成员总数。

    ⚠️ 与 `evaluated_members` 分开报。合起来说会让「10 台里 6 台」
    与「6 台里 6 台」看起来一样，而后者其实有 4 台从没被看过。
    """
    magnitude_median: float
    magnitude_min: float
    magnitude_max: float

    @property
    def ratio(self) -> float:
        """占**已评估**成员的比例。"""
        if self.evaluated_members <= 0:
            return 0.0
        return len(self.members) / self.evaluated_members

    @property
    def unevaluated_members(self) -> int:
        """声明了但本轮没拿到数据的成员数。

        > 0 时报告必须把它写出来 —— 否则「集群级现象」这个说法
        建立在一个读者不知道的缺口上。
        """
        return max(0, self.total_members - self.evaluated_members)


@dataclass(frozen=True)
class RollupResult:
    """rollup 的结果。"""

    groups: tuple[RollupGroup, ...]
    """达到阈值、合并成集群层的组。"""
    kept: tuple[MemberObservation, ...]
    """**没有**被合并、仍按个体上报的观测。

    ⚠️ rollup 是「合并表达」不是「过滤」：2/8 成员掉内存仍是 2 个真实问题。
    把它们丢掉会让「集群里少数几台出问题」这类情形彻底不可见 ——
    而那恰恰是最该看的情形（多数台正常说明不是共因，是那几台自己的事）。
    """

    @property
    def rolled_up_ids(self) -> frozenset[str]:
        return frozenset(i for g in self.groups for i in g.members)


def _consistent_subset(
    obs: Sequence[MemberObservation], tolerance: float,
) -> tuple[MemberObservation, ...]:
    """同幅子集：幅度落在中位数 ±tolerance 带内的那些。"""
    mags = [o.magnitude for o in obs]
    med = statistics.median(mags)
    # ⚠️ 这里**不需要** `if med == 0` 的特判。我一开始写了一个，反向注入时
    #    发现删掉它测试全绿 —— 因为 med=0 时 lo=hi=0，而 `0 <= 0 <= 0` 成立，
    #    全零组自然全部通过。而「三台 0 幅度 + 一台 0.5」的情形下 med 仍是 0，
    #    那台 0.5 被判为离群 —— 这正是想要的行为。
    #    带着自信注释的死代码比没有代码更糟：下一个人会以为那里有个真陷阱。
    lo, hi = med * (1 - tolerance), med * (1 + tolerance)
    lo, hi = min(lo, hi), max(lo, hi)
    return tuple(o for o in obs if lo <= o.magnitude <= hi)


def rollup(
    observations: Iterable[MemberObservation],
    *,
    cluster_sizes: Mapping[str, int] | None = None,
    evaluated_sizes: Mapping[str, int] | None = None,
    ratio: float = ROLLUP_RATIO,
    min_members: int = MIN_MEMBERS,
    tolerance: float = MAGNITUDE_TOLERANCE,
) -> RollupResult:
    """按 (cluster, metric, direction) 合并（R8.6）。

    Args:
        cluster_sizes: `{cluster_id: 声明的成员总数}`。
            缺失时按「已评估数」当总数 —— 并在 `unevaluated_members` 里体现为 0。
            ⚠️ 拿不到集群大小时**不要猜**：把已评估数当分母是可辩护的
            （「我们看到的这些里有多少」），而编一个总数会让比例凭空变好看。
        evaluated_sizes: `{cluster_id: 本轮**已评估**的成员数}`。
            这才是 `ratio` 的分母。缺失时退化成 `len(obs)`（= 命中数），
            那时 `ratio` 这道闸门无条件成立 —— 见下面那段。

    ⚠️ 分母是**同一 cluster 下已评估的成员数**，不是命中数。

    🔴 2026-08-26 之前 `evaluated = len(obs)`，而 `obs` 是调用方只喂进来的
    **命中** finding —— 于是 `len(subset) / evaluated` 恒为 1.0，
    `ROLLUP_RATIO = 0.60` 这道闸门**无条件成立**。

    实测：`evaluated_members=3 / total_members=8 / ratio=1.0` —— group 声称
    「集群 100% 成员同向」，而集群有 8 台、其中 5 台本轮根本没被看过。

    本模块 docstring 里「三个会让 rollup 变有害的写法」的第①条逐字就是这个：
    「3 台命中 / 3 台命中 = 100% → 报『整个集群都在掉内存』，而集群其实有 10 台」。
    文档是对的，代码不是。
    """
    by_key: dict[tuple[str, str], list[MemberObservation]] = {}
    for o in observations:
        if not o.cluster_id:
            # 没有集群归属的实例不参与 rollup，但要原样保留
            by_key.setdefault(("", o.metric), []).append(o)
            continue
        by_key.setdefault((o.cluster_id, o.metric), []).append(o)

    groups: list[RollupGroup] = []
    kept: list[MemberObservation] = []

    for (cluster_id, metric), obs in by_key.items():
        if not cluster_id:
            kept.extend(obs)
            continue
        # 🔴 分母优先取「本轮已评估的成员数」。退化到 `len(obs)`（命中数）时
        #    比例恒为 1.0，闸门无条件成立 —— 见 docstring。
        hits = len(obs)
        evaluated = (evaluated_sizes or {}).get(cluster_id, hits)
        # 已评估数不该小于命中数；小了说明入参不一致，取大的那个（保守）
        evaluated = max(evaluated, hits)
        total = (cluster_sizes or {}).get(cluster_id, evaluated)
        # 声明的总数不该小于实际看到的数量；小了说明入参有问题，取大的那个
        total = max(total, evaluated)

        rolled_ids: set[str] = set()
        for direction in (Direction.UP, Direction.DOWN):
            same_dir = [o for o in obs if o.direction is direction]
            if len(same_dir) < min_members:
                continue
            subset = _consistent_subset(same_dir, tolerance)
            if len(subset) < min_members:
                continue
            if len(subset) / evaluated < ratio:
                continue
            mags = sorted(o.magnitude for o in subset)
            groups.append(RollupGroup(
                cluster_id=cluster_id,
                metric=metric,
                direction=direction,
                members=tuple(sorted(o.instance_id for o in subset)),
                evaluated_members=evaluated,
                total_members=total,
                magnitude_median=statistics.median(mags),
                magnitude_min=mags[0],
                magnitude_max=mags[-1],
            ))
            rolled_ids.update(o.instance_id for o in subset)
        kept.extend(o for o in obs if o.instance_id not in rolled_ids)

    # R14 可重放：同输入同输出
    groups.sort(key=lambda g: (g.cluster_id, g.metric, g.direction.value))
    kept.sort(key=lambda o: (o.cluster_id, o.metric, o.instance_id))
    return RollupResult(groups=tuple(groups), kept=tuple(kept))


def cluster_sizes_from_attrs(attrs: Iterable[object]) -> dict[str, int]:
    """从 `ResourceAttrs` 列表统计每个集群声明的成员数。

    ⚠️ 这只是「本轮加载到的」成员数，不等于集群真实大小 ——
    被排除清单剔掉的成员根本不在这个列表里。真实大小要从
    `DescribeDBClusters` / `DescribeReplicationGroups` 的成员列表取，
    那是 `pipeline` 层的事（这里是纯函数层，不做 IO）。
    """
    out: dict[str, int] = {}
    for a in attrs:
        cid = getattr(a, "cluster_id", None)
        if cid:
            out[str(cid)] = out.get(str(cid), 0) + 1
    return out
