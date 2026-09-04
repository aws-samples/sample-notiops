"""日序列组装与变更事件标注（R8.4 / R13.10）。

## 这个模块解决的一件事

`adapters/metrics_repo` 拉回来的是**按 (指标, 统计量) 分开的三条序列**
（Minimum / Average / Maximum）。判定要用的是「某一天这个指标的 min/avg/max」——
按天对齐之后的视图。中间这一步转换有三处容易出错，且都不会报错：

```
① 日期对不齐    某个统计量少一天（CloudWatch 对该统计量返回空）
                → 按下标 zip 会把 8/12 的 min 和 8/13 的 max 配成一天
② 顺序           metrics_repo 给的是**倒序**，而人读报告是正序
                → 两处各自假设一种，`daily[0]` 到底是哪天取决于谁先调
③ 变更事件       R8.4 明令「保留数据点并打标注」，SHALL NOT 剔除
                → 剔除会在序列上留空洞，掩盖「参数组变更次日开始下降」这种更好的告警
```

## 边界

纯函数，零 IO（R14.1）。`today` 由入参传入（R14.2）。
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from enum import Enum
from dataclasses import dataclass, field
from datetime import date, timedelta

# 判定用的三个统计量。p95 不在这里 —— 它按族可选（ElastiCache 不支持百分位），
# 而 `Series` 是「每天都该有」的那三个。
STATS_DAILY: tuple[str, ...] = ("Minimum", "Average", "Maximum")

WINDOW_DAYS = 7
"""v1 的窗口（R2.4a）。**不是 28 天** —— 趋势移出 v1 后 7 天足够：
`consecutive_low_days` 需要 7 天，慢性高位需要 coverage ≥ 7。
⚠️ `GetMetricData` 按**请求的指标数**计费，窗口长度不影响成本，
所以这个数字不是省钱来的，改大也不会更贵。"""


@dataclass(frozen=True)
class DayValues:
    """某一天的三个统计量。缺失用 `None` —— **SHALL NOT 用 0.0 代替**。

    ⚠️ `Evictions=0` 是健康，`Evictions` 缺失是「不知道」，两者判定相反。
    """

    data_date: date
    minimum: float | None = None
    average: float | None = None
    maximum: float | None = None

    @property
    def has_any(self) -> bool:
        return any(v is not None
                   for v in (self.minimum, self.average, self.maximum))

    def stat(self, name: str) -> float | None:
        return {
            "Minimum": self.minimum,
            "Average": self.average,
            "Maximum": self.maximum,
        }.get(name)


@dataclass(frozen=True)
class Annotation:
    """一条变更事件在序列上的标注（R8.4）。"""

    data_date: date
    event_type: str
    detail: str = ""


@dataclass(frozen=True)
class Series:
    """一个 (实例, 指标) 的日序列，**按日期正序**（最早的在 `[0]`）。

    ⚠️ 顺序与 `adapters.MetricSeries.points`（倒序）**相反**，这是刻意的：
    ```
    倒序  适合「从最近往前数连续几天」——  count_consecutive_low/high 的契约
    正序  适合报告与图表 —— 人读的是时间轴
    ```
    两种顺序都需要，所以把转换点收在这里一处，并各自提供取值方法
    （`values()` 正序 / `values_desc()` 倒序），而不是让调用方自己 reverse。
    早期让调用方自己处理的结果是：同一个 `daily[0]` 在两处指的是不同的天。
    """

    instance_id: str
    metric: str
    days: tuple[DayValues, ...] = ()
    annotations: tuple[Annotation, ...] = ()

    @property
    def coverage_days(self) -> int:
        """窗口内**实际有数据**的天数。R2.1 的 `min_coverage_days` 判据用它。

        ⚠️ 不是 `len(days)` —— `days` 里含占位的空天（见 `build_series` 的说明）。
        """
        return sum(1 for d in self.days if d.has_any)

    @property
    def missing_dates(self) -> tuple[date, ...]:
        """窗口内没有任何数据的日期。R3.5 的可观测性缺口上报用它。"""
        return tuple(d.data_date for d in self.days if not d.has_any)

    def values(self, stat: str = "Average") -> tuple[float | None, ...]:
        """正序取某个统计量。"""
        return tuple(d.stat(stat) for d in self.days)

    def values_desc(self, stat: str = "Average") -> tuple[float | None, ...]:
        """倒序取某个统计量 —— `count_consecutive_high/low` 的入参契约。"""
        return tuple(reversed(self.values(stat)))

    @property
    def latest(self) -> DayValues | None:
        """最近一天（正序的最后一个）。"""
        return self.days[-1] if self.days else None

    def annotations_on(self, d: date) -> tuple[Annotation, ...]:
        return tuple(a for a in self.annotations if a.data_date == d)

    @property
    def annotated_dates(self) -> frozenset[date]:
        return frozenset(a.data_date for a in self.annotations)


def window_dates(data_date: date, window_days: int = WINDOW_DAYS) -> tuple[date, ...]:
    """窗口内的全部日期，**正序**，含端点 `data_date`。

    ⚠️ `data_date` 是**最后一个完整的 UTC 日**（R13.10），不是今天。
    用今天会让最后一天永远是残缺的（当天还没过完），而那一天恰好是
    判定用的「最新值」—— 于是每次巡检都在拿一个不完整的日聚合做判断。
    """
    if window_days <= 0:
        raise ValueError("window_days must be positive")
    return tuple(
        data_date - timedelta(days=window_days - 1 - i) for i in range(window_days)
    )


def build_series(
    *,
    instance_id: str,
    metric: str,
    points_by_stat: Mapping[str, Sequence[tuple[date, float]]],
    data_date: date,
    change_events: Iterable[tuple[date, str]] = (),
    window_days: int = WINDOW_DAYS,
) -> Series:
    """把按统计量分开的点位组装成按天对齐的 `Series`。

    Args:
        points_by_stat: `{"Minimum": [(日期, 值), …], "Average": …, "Maximum": …}`。
            顺序任意 —— 这里按日期建索引，不按下标配对。
        data_date: 窗口的最后一天（**最后一个完整 UTC 日**，R13.10）。
        change_events: `[(日期, 事件类型), …]`。R8.4：**标注，不剔除**。
        window_days: 窗口长度。

    Returns:
        `Series`，`days` 长度**恒等于 `window_days`** —— 没数据的天用空
        `DayValues` 占位。

    ⚠️ **为什么要占位而不是只放有数据的天**：
    ```
    只放有数据的天  → len(days) 就是 coverage，看起来更简洁
                     但 `values("Average")` 的长度随数据多少变化，
                     而 count_consecutive_high 是「从最近往前数」——
                     中间缺一天时它会把缺口两侧的天当成相邻，
                     于是「连续 5 天高位」可能横跨 9 个自然日。
    占位            → 缺口显式为 None，计数在 None 处中断（这正是那两个函数的契约）
    ```

    ⚠️ **按日期建索引而不是按下标 zip**：某个统计量少一天时（CloudWatch 对该
    统计量返回空是常见的），下标配对会把 8/12 的 min 和 8/13 的 max 配成同一天。
    结果是一条数值上完全合理、但描述的是两个不同日子的记录。
    """
    dates = window_dates(data_date, window_days)
    in_window = set(dates)

    # 按 (统计量, 日期) 建索引。⚠️ 同一天重复出现时**后者胜出**并不安全 ——
    # 那说明上游给了重复点，两个值可能不同。取先出现的那个并保持确定性，
    # 因为 R14 要求同输入同输出。
    index: dict[tuple[str, date], float] = {}
    for stat, pts in points_by_stat.items():
        for d, v in pts:
            # ⚠️ 这个过滤是**性能优化，不是正确性守卫**。
            # 正确性由下面 `for d in dates` 保证 —— 只有窗口内的日期会被查询，
            # 窗口外的键进不进 index 都取不到。
            # 反向注入（去掉这个 if）**不会**产生行为差异，那是预期的；
            # 别为了「让注入变红」把它改成看起来像守卫的样子。
            if d not in in_window:
                continue
            index.setdefault((stat, d), float(v))

    days = tuple(
        DayValues(
            data_date=d,
            minimum=index.get(("Minimum", d)),
            average=index.get(("Average", d)),
            maximum=index.get(("Maximum", d)),
        )
        for d in dates
    )

    # R8.4：变更事件**保留数据点并打标注**，SHALL NOT 从序列中剔除。
    # 剔除会在时间序列上留下空洞、破坏拟合，且会掩盖发布引入的真实回归 ——
    # 「FreeableMemory 从参数组变更次日开始持续下降」是一条**更好的告警**。
    annotations = tuple(
        sorted(
            (Annotation(d, t) for d, t in change_events if d in in_window),
            key=lambda a: (a.data_date, a.event_type),
        )
    )

    return Series(
        instance_id=instance_id, metric=metric, days=days, annotations=annotations,
    )


def build_series_from_metric_series(
    metric_series: Iterable[object],
    *,
    data_date: date,
    change_events: Iterable[tuple[date, str]] = (),
    window_days: int = WINDOW_DAYS,
) -> dict[tuple[str, str], Series]:
    """从 `adapters.metrics_repo.MetricSeries` 的集合批量组装。

    这是 adapters → domain 的**唯一转换点**。放在 domain 侧是因为它是纯函数
    （只读入参、不碰 IO），而放在 adapters 侧会让 domain 的测试需要构造
    adapters 的 dataclass。

    ⚠️ 接 `object` 而不是 `MetricSeries` 是为了**避免 domain import adapters**
    —— 依赖方向是 adapters → domain，单向。这里只用鸭子类型读
    `.instance_id` / `.metric` / `.stat` / `.points`。
    """
    grouped: dict[tuple[str, str], dict[str, list[tuple[date, float]]]] = {}
    for ms in metric_series:
        key = (getattr(ms, "instance_id"), getattr(ms, "metric"))
        stat = getattr(ms, "stat")
        pts = [(p.data_date, p.value) for p in getattr(ms, "points", ())]
        grouped.setdefault(key, {})[stat] = pts

    return {
        (inst, metric): build_series(
            instance_id=inst, metric=metric, points_by_stat=by_stat,
            data_date=data_date, change_events=change_events,
            window_days=window_days,
        )
        for (inst, metric), by_stat in sorted(grouped.items())
    }


# ---------------------------------------------------------------------------
# R8.5：warm-up 抑制
# ---------------------------------------------------------------------------

class ChangeKind(str, Enum):
    """变更事件的类型。**这是全仓唯一的一份**（R8.2 / R8.5）。

    ⚠️ 采集侧（`adapters/change_events.py`）必须 import 这个枚举，
    不能自己再定义一套。我一度在采集器里独立写了
    `reboot` / `scale` / `config`，而这里是
    `restart` / `instance_class_change` / `parameter_group_change`
    —— **只有 `failover` 对得上**。后果：真账号 14 天里的 99 次重启
    与 10 次规格变更**全都不触发抑制**，而 `in_warmup()` 照常返回 False，
    没有任何错误。表现是「重启后几天报一批内存异常」，查不到原因。

    ⚠️ 值的字面量不可改：它们会落进 DDB 的 `Annotation.event_type`
    与前端曲线的注记标签。改名等于让历史标注全部失配。
    """

    RESTART = "restart"
    """重启 / 崩溃恢复 / 节点更换。"""
    FAILOVER = "failover"
    """主备切换、蓝绿 switchover。Aurora 属集群级事件。"""
    INSTANCE_CLASS_CHANGE = "instance_class_change"
    """规格 / 存储 / 节点类型变更。绝对值类指标的基线整体位移。"""
    PARAMETER_GROUP_CHANGE = "parameter_group_change"
    """参数组变更。可能改了 buffer pool 大小 → 内存基线位移。"""
    MAINTENANCE = "maintenance"
    """维护窗操作与引擎升级。

    ⚠️ **不触发抑制。** 大部分 maintenance 事件是「已排定维护窗」这类
    通知，没有实际动作；真正伴随重启的那次会另有一条 restart 事件。
    让通知触发 5 天抑制会把正常实例大面积哑掉。
    """
    BACKUP = "backup"
    """备份 / 快照 / 恢复。**不触发抑制** —— 自动备份每天都有，
    让它触发等于让每台实例永久处于抑制期，内存类发现一条都出不来。"""
    OTHER = "other"
    """创建 / 删除 / 只读副本 / 通知等。保留但不触发抑制。"""

    @property
    def suppresses_memory(self) -> bool:
        """这类事件之后内存类指标是否需要 warm-up 抑制（R8.5）。"""
        return self in _SUPPRESSING


_SUPPRESSING: frozenset["ChangeKind"] = frozenset({
    ChangeKind.RESTART,
    ChangeKind.FAILOVER,
    ChangeKind.INSTANCE_CLASS_CHANGE,
    ChangeKind.PARAMETER_GROUP_CHANGE,
})

WARMUP_EVENT_TYPES: frozenset[str] = frozenset(
    k.value for k in ChangeKind if k.suppresses_memory
)
"""会触发内存类指标 warm-up 的事件（R8.5）。**从 `ChangeKind` 派生。**

buffer pool + page cache 回填的形状是**完美单调线性下降** —— 与内存泄漏
几乎不可区分。而企业客户的维护窗集中在周末 → 周一整队列报警，
正是 on-call 最忙、最容易把整份报告归类为「不用看」的时刻。

⚠️ 派生而非手写字面量：手写会与 `ChangeKind.suppresses_memory` 漂移，
而漂移的方向是「声明了会抑制、实际不抑制」——不报错，只是假告警回来了。
"""

WARMUP_DAYS = 5
"""R8.5：重启/failover/实例类型变更后 3-5 天内内存类指标降级。取上界 5。

⚠️ 取 5 而不是 3：取 3 会在「4 天前重启」的情况下漏抑制，而漏抑制的代价
（一批假告警把整份报告的可信度拉低）远大于多抑制两天。
"""

WARMUP_SENSITIVE_METRICS: frozenset[str] = frozenset({
    "FreeableMemory", "DatabaseMemoryUsagePercentage", "BytesUsedForCache",
    "SwapUsage",
})
"""受 warm-up 影响的指标。**只有内存类** —— CPU 与 IO 不受 buffer pool 回填影响，
把它们一起抑制会让「重启后 CPU 飙高」这种真事故被吞掉。"""


PLATEAU_TAIL_DAYS = 2
"""平台期检测看「最近几天」的斜率（R8.5 原文：最近 2 天斜率趋缓）。"""

PLATEAU_FLATTEN_RATIO = 0.5
"""尾段斜率 / 前段斜率 低于它就判平台期。

取 0.5 的含义是「最近两天的下降速度已经不到之前的一半」。
⚠️ 取太松（如 0.9）会把真泄漏也判成 warm-up —— 泄漏的斜率有正常抖动，
0.9 这种带宽随便就满足了，于是 R2 的内存泄漏规则整类失效。
"""

PLATEAU_MIN_COVERAGE = 5
"""少于这么多天不做平台期判定。

⚠️ 4 天时前段只有 2 个点，斜率完全由噪声决定 —— 判出来的「趋缓」是假的。
而这个假阳会**抑制**一条真实告警，方向上比漏判更危险。
"""


def _slope(points: Sequence[tuple[int, float]]) -> float | None:
    """最小二乘斜率。点数 < 2 返回 None。"""
    n = len(points)
    if n < 2:
        return None
    sx = sum(x for x, _ in points)
    sy = sum(y for _, y in points)
    sxx = sum(x * x for x, _ in points)
    sxy = sum(x * y for x, y in points)
    denom = n * sxx - sx * sx
    if denom == 0:
        return None
    return (n * sxy - sx * sy) / denom


def is_plateauing(
    series: Series,
    *,
    tail_days: int = PLATEAU_TAIL_DAYS,
    flatten_ratio: float = PLATEAU_FLATTEN_RATIO,
    min_coverage: int = PLATEAU_MIN_COVERAGE,
    stat: str = "Average",
) -> bool:
    """形态判据：这条下降曲线是否已经走平（R8.5 的平台期检测）。

    ```
    真泄漏      斜率保持或变陡 —— 它不会自己走平
    warm-up     buffer pool + page cache 回填完就平了
    ```

    ⚠️ **这是与 `in_warmup()` 独立的第二个探测器，两者不可互相替代。**

    ```
    in_warmup()      事件驱动 —— 需要 DescribeEvents 抓到那次重启
    is_plateauing()  形态驱动 —— 不需要任何事件
    ```

    为什么两个都要：`DescribeEvents` 只保留 **14 天**，且我们按
    `SourceType` 过滤（只查 db-instance / db-cluster / cache-cluster /
    replication-group）。事件漏了一次，`in_warmup()` 就完全不知道 ——
    而那台实例的内存曲线恰好最像泄漏（完美单调线性下降）。
    形态判据是那种情形下唯一还站着的防线。

    ⚠️ 只对**下降**的内存类曲线生效。上升的内存（用量涨）与 warm-up 无关，
    对它判「走平」会把「涨到一半停住」当成没事 —— 而那可能正是 OOM 前夜。
    """
    if series.metric not in WARMUP_SENSITIVE_METRICS:
        return False

    pairs = [(i, d.stat(stat)) for i, d in enumerate(series.days)]
    pts = [(i, v) for i, v in pairs if v is not None]
    if len(pts) < min_coverage:
        return False
    if len(pts) <= tail_days:
        return False

    head = pts[:-tail_days]
    tail = pts[-(tail_days + 1):]      # 多带一个点，尾段才有两个点算斜率
    s_head = _slope(head)
    s_tail = _slope(tail)
    if s_head is None or s_tail is None:
        return False
    # 只处理下降段：前段必须在明显下降
    if s_head >= 0:
        return False
    # 尾段转为上升 → 已经回填完并开始回升，同样算平台期
    if s_tail >= 0:
        return True
    return abs(s_tail) < flatten_ratio * abs(s_head)


def in_warmup(
    series: Series, *, data_date: date, warmup_days: int = WARMUP_DAYS
) -> bool:
    """这个指标在 `data_date` 是否处于 warm-up 抑制窗口内（R8.5）。

    判据：`data_date` 往前 `warmup_days` 天内有 warm-up 类事件，
    **且**该指标是内存类。
    """
    if series.metric not in WARMUP_SENSITIVE_METRICS:
        return False
    cutoff = data_date - timedelta(days=warmup_days)
    return any(
        a.event_type in WARMUP_EVENT_TYPES and cutoff <= a.data_date <= data_date
        for a in series.annotations
    )
