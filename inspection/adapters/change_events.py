"""变更事件采集（R8.2）。

`rds:DescribeEvents` / `elasticache:DescribeEvents` 是**硬要求**；
CloudTrail 与 AWS Health 只是补充（它们能看到控制面调用，但看不到
「实例自己发生了 failover」这类服务端事件）。

事件的用途是**标注而不是剔除**（R8.2）：7 天窗口里有一次重启，那几天的内存
指标不可比，但把它们删掉会让 coverage 掉到 5 以下、整台实例被判
INSUFFICIENT_DATA。标注让 warm-up 抑制（R8.5）能只压那几天。

## AWS 侧行为（2026-08-19 在真账号 us-east-1 实测，逐条验过）

```
① 什么都不传                    → 0 条，且**不报错**
   默认只看过去 1 小时 ← 静默失效入口，最危险的那个

② Duration 与 StartTime/EndTime **互斥**
   两者都传 → ClientError InvalidParameterCombination
              "If Duration is specified, both StartTime and EndTime must be omitted."
   ⚠️ 是整个调用失败，不是忽略其中一个

③ 14 天硬上限
   Duration=20160 (=14天)  ✅
   Duration=20161          ❌ InvalidParameterCombination
                              "Events occurring more than 14 days in the past
                               are not available."
   ⚠️ 报错而非静默截断 —— 这是好事，不会悄悄少数据

④ StartTime 的边界比 Duration 更严
   StartTime = now - 14d        ❌ 失败
   StartTime = now - 14d + 1min ✅ 通过
   请求到达服务端时 now 已经往前走了，于是「正好 14 天」变成「超过 14 天」。
   看起来完全正确的 `now - timedelta(days=14)` 会稳定失败。

⑤ SourceType 是**两套互不通用**的枚举
   RDS          db-instance / db-cluster / db-snapshot / db-parameter-group /
                blue-green-deployment / db-proxy / db-shard-group / zero-etl …（11 个）
   ElastiCache  cache-cluster / replication-group / serverless-cache /
                cache-parameter-group / user / user-group …（9 个）
   给 elasticache 传 `db-instance` → ClientError InvalidParameterValue（响亮失败）

⑥ 不传 SourceType 返回**混合类型**
   实测一次调用里 db-instance 80 / db-snapshot 12 / blue-green-deployment 8。
   Aurora 的实例级与集群级事件分属 db-instance 与 db-cluster **两个值**，
   只拉 db-instance 会漏掉 failover —— 而 failover 正是 R8.5 要用的信号。

⑦ 事件**没有 id**
   RDS 字段          SourceIdentifier / SourceType / Message / EventCategories /
                     Date / SourceArn
   ElastiCache 字段  SourceIdentifier / SourceType / Message / Date
   ⚠️ **ElastiCache 没有 EventCategories 也没有 SourceArn。**
      把分类逻辑建在 EventCategories 上，ElastiCache 侧会全部落 UNKNOWN ——
      而那等于**静默关掉 ElastiCache 的 warm-up 抑制**，
      表现是「EC 实例重启后几天被报内存异常」，查不到原因。
   去重只能靠 (SourceIdentifier, Date, Message) 三元组。
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from enum import Enum

from botocore.exceptions import BotoCoreError, ClientError

from inspection.domain.series import ChangeKind

logger = logging.getLogger(__name__)

MAX_LOOKBACK_DAYS = 14
"""`DescribeEvents` 的硬上限。超过报 `InvalidParameterCombination`。"""

START_TIME_MARGIN = timedelta(minutes=5)
"""`StartTime` 距 14 天边界要留的余量。

实测 `now - 14d` 失败、`now - 14d + 1min` 成功 —— 请求到达服务端时 `now`
已经往前走了。取 5 分钟而不是 1 分钟：Lambda 冷启动 + 重试可能让
构造时刻与到达时刻差出几分钟。
"""

MAX_RECORDS = 100
"""单页上限。分页靠 `get_paginator("describe_events")`，不手写 Marker 循环。"""


class Service(str, Enum):
    RDS = "rds"
    ELASTICACHE = "elasticache"


RDS_SOURCE_TYPES: tuple[str, ...] = ("db-instance", "db-cluster")
"""RDS 侧要查的类型。

⚠️ **必须包含 `db-cluster`。** Aurora 的 failover 是集群级事件，
只查 `db-instance` 会漏掉它，而 warm-up 抑制正靠这个信号。
其余类型（db-snapshot / db-parameter-group / blue-green-deployment …）
与实例指标不可比性无关，查了只是噪音。
"""

ELASTICACHE_SOURCE_TYPES: tuple[str, ...] = ("cache-cluster", "replication-group")
"""ElastiCache 侧要查的类型。**枚举与 RDS 完全不通用。**

给 elasticache 传 `db-instance` 会得到 `InvalidParameterValue`。
"""

VALID_SOURCE_TYPES: Mapping[Service, frozenset[str]] = {
    Service.RDS: frozenset({
        "db-instance", "db-parameter-group", "db-security-group", "db-snapshot",
        "db-cluster", "db-cluster-snapshot", "custom-engine-version", "db-proxy",
        "blue-green-deployment", "db-shard-group", "zero-etl",
    }),
    Service.ELASTICACHE: frozenset({
        "cache-cluster", "cache-parameter-group", "cache-security-group",
        "cache-subnet-group", "replication-group", "serverless-cache",
        "serverless-cache-snapshot", "user", "user-group",
    }),
}
"""从 botocore 的 service model 抄下来的完整枚举，用于本地预校验。

⚠️ 本地校验的价值：拼错一个类型名会让**整个调用**失败
（`InvalidParameterValue`），于是那个账号这一轮拿不到任何变更事件，
而下游只表现为「warm-up 抑制没生效」。
"""


# ⚠️ `ChangeKind` **从 domain 取**，不在这里再定义一份。
#
# 我一度在本模块独立写了 `reboot` / `scale` / `config`，而
# `domain/series.py::WARMUP_EVENT_TYPES` 认的是
# `restart` / `instance_class_change` / `parameter_group_change`
# —— 只有 `failover` 对得上。后果：真账号 14 天里的 99 次重启与 10 次规格变更
# **全都不触发抑制**，`in_warmup()` 照常返回 False，无任何错误信号。
# 表现是「重启后几天报一批内存异常」，而那正是 R8.5 要消掉的东西。
# ⚠️ 关键词按 **Message** 匹配，不依赖 EventCategories ——
#    ElastiCache 的事件里根本没有那个字段。
_MESSAGE_RULES: tuple[tuple[ChangeKind, tuple[str, ...]], ...] = (
    # 顺序有意义：先判更具体的。failover 的消息里常同时出现 reboot 字样。
    #
    # ⚠️ 这张表用真账号 14 天里的 363 条真实事件校准过（见模块末尾的实测记录）。
    #    被删掉的三个关键词各自会造成一类静默错误：
    #
    #    "multi-az"          →「Applying modification to convert to a Multi-AZ
    #                          DB Instance」被判 FAILOVER。真 failover 的消息是
    #                          「Multi-AZ instance failover started」，靠
    #                          "failover" 一词就够；留着 "multi-az" 只会把
    #                          规格变更贴上错标签，报告里写「发生了主备切换」。
    #    "replication group" → 🔴 最危险的那个。ElastiCache 几乎每条消息都含它
    #                          （"Cache cluster added to replication group" 之类），
    #                          会让**所有 EC 事件都判 FAILOVER** →
    #                          suppresses_memory 恒真 → 每台 EC 实例永久处于
    #                          5 天抑制期 → **EC 的内存类发现一条都出不来**。
    #                          而看板上只显示「EC 没有异常」。
    #    "changed to"        → 太宽。「Parameter group changed to X」会被判 SCALE
    #                          （触发抑制）而不是 CONFIG（不触发）。
    (ChangeKind.FAILOVER, (
        "failover", "failed over", "promoted", "promotion",
        # 蓝绿切换：写入端点真的换了实例，指标不可比。
        # 实测消息：「Switchover from primary X to Y started./completed.」
        "switchover", "switched over",
        # 切换过程中会主动断连，连接数类指标那几分钟不可比。
        # 实测消息：「Starting to terminate connections and user processes
        #            in the blue environment at ...」
        "in the blue environment", "green environment is now accepting",
    )),
    (ChangeKind.RESTART, (
        "reboot", "restart", "restarted", "shutdown",
        # 实测消息：「Binlog position from crash recovery is mysql-bin-...」
        # 这条是崩溃恢复的**唯一**外部信号，漏了它就等于漏掉一次非计划重启。
        "crash recovery", "recovery of the db instance",
        # ElastiCache 侧的节点更换
        "node replacement", "replaced",
    )),
    (ChangeKind.INSTANCE_CLASS_CHANGE, (
        "modifying db instance class", "finished modifying db instance class",
        "scale", "scaling", "storage size", "allocated storage",
        # 实测消息：「Applying modification to convert to a Multi-AZ DB Instance」
        "applying modification to convert", "node type",
    )),
    (ChangeKind.MAINTENANCE, (
        "maintenance", "upgrade", "patch", "engine version",
        "operating system", "os update",
    )),
    (ChangeKind.PARAMETER_GROUP_CHANGE, (
        "parameter group", "parameter change", "applying modification",
        "security group", "configuration",
    )),
    (ChangeKind.BACKUP, (
        # ⚠️ 必须同时列进行时态：「Backing up DB instance」**不含** "backup"
        #    这个子串（中间有空格）。RDS 侧靠 EventCategories=('backup',) 兜底
        #    救了它，但 ElastiCache 没有那个字段 —— 于是 EC 的备份事件会落
        #    OTHER。两者都不触发抑制所以不影响判定，但报告里的事件标签会写错。
        "backup", "backing up", "snapshot", "restore", "restoring",
    )),
)

_CATEGORY_MAP: Mapping[str, ChangeKind] = {
    "failover": ChangeKind.FAILOVER,
    "availability": ChangeKind.RESTART,
    "maintenance": ChangeKind.MAINTENANCE,
    "configuration change": ChangeKind.PARAMETER_GROUP_CHANGE,
    "backup": ChangeKind.BACKUP,
    "restoration": ChangeKind.BACKUP,
}
"""RDS 的 `EventCategories` → 类型。**只对 RDS 有效。**

⚠️ 不能把它当唯一判据：ElastiCache 的事件没有这个字段，
全靠它会让 EC 侧的每一条都落 `OTHER` → `suppresses_memory` 恒 False →
**ElastiCache 的 warm-up 抑制静默失效**。
所以 `classify()` 是「消息优先、类别兜底」。
"""


def classify(message: str, categories: Sequence[str] = ()) -> ChangeKind:
    """把一条事件归类。

    **消息优先、类别兜底** —— 而不是反过来。
    理由见 `_CATEGORY_MAP` 的说明：ElastiCache 没有 `EventCategories`。
    """
    text = (message or "").lower()
    for kind, needles in _MESSAGE_RULES:
        if any(n in text for n in needles):
            return kind
    for c in categories or ():
        hit = _CATEGORY_MAP.get(str(c).strip().lower())
        if hit is not None:
            return hit
    return ChangeKind.OTHER


@dataclass(frozen=True)
class ChangeEvent:
    """一条变更事件。

    ⚠️ 没有 `event_id` 字段 —— API 不提供。去重靠 `dedupe_key()`。
    """

    service: Service
    source_id: str
    source_type: str
    message: str
    at: datetime
    kind: ChangeKind
    categories: tuple[str, ...] = ()

    @property
    def day(self) -> date:
        """事件所在的 UTC 日。

        ⚠️ 用 UTC，与指标窗口（`period=86400` 从 UTC 零点起算）对齐。
        用本地时区会让事件标注错位一天，于是 warm-up 抑制压错日子。
        """
        return self.at.astimezone(timezone.utc).date()

    def dedupe_key(self) -> tuple[str, str, str]:
        """`(source_id, iso 时刻, message)`。

        ⚠️ API **不返回事件 id**，这个三元组是唯一可用的身份。
        分页边界重叠、以及 `db-instance` 与 `db-cluster` 两次查询返回同一条，
        都靠它去重。
        """
        return (self.source_id, self.at.isoformat(), self.message)


def clamp_window(
    *, start: datetime, end: datetime,
    max_days: int = MAX_LOOKBACK_DAYS, margin: timedelta = START_TIME_MARGIN,
) -> tuple[datetime, datetime]:
    """把窗口夹进 API 允许的范围。

    ⚠️ **`now - 14d` 会失败**（实测），必须留余量：请求到达服务端时
    `now` 已经往前走了，「正好 14 天」就变成「超过 14 天」。
    看起来完全正确的写法会稳定报 `InvalidParameterCombination`。
    """
    earliest = end - timedelta(days=max_days) + margin
    if start < earliest:
        logger.info("变更事件窗口起点 %s 早于 API 上限，夹到 %s", start, earliest)
        start = earliest
    if start >= end:
        raise ValueError(f"窗口非法: start={start} >= end={end}")
    return start, end


def _validate_source_types(service: Service, source_types: Sequence[str]) -> None:
    """本地预校验类型名。

    ⚠️ 拼错一个名字会让**整个调用**失败（`InvalidParameterValue`），
    于是那个账号这一轮一条变更事件都没有，而下游只表现为
    「warm-up 抑制没生效」。在这里拦住，错误信息里能看到合法值。
    """
    valid = VALID_SOURCE_TYPES[service]
    bad = [t for t in source_types if t not in valid]
    if bad:
        raise ValueError(
            f"{service.value} 不认识这些 SourceType: {bad}；"
            f"合法值 {sorted(valid)}"
        )


def collect(
    client, *, service: Service, start: datetime, end: datetime,
    source_types: Sequence[str] | None = None,
    source_id: str = "",
) -> list[ChangeEvent]:
    """拉一个服务的变更事件。

    ⚠️ **只传 `StartTime`/`EndTime`，绝不同时传 `Duration`。**
    两者互斥，同时传会让整个调用报 `InvalidParameterCombination`
    （不是忽略其中一个）。

    ⚠️ 也**绝不两个都不传** —— 那样默认只看过去 1 小时且不报错，
    是最容易写出来的静默失效。

    ⚠️ 逐个 `SourceType` 分别请求，不靠「不传 SourceType 拿混合结果」：
    后者会带回 db-snapshot / blue-green-deployment 这类与指标无关的噪音，
    且分页配额被它们占掉后真正需要的 db-cluster 事件可能翻不到。
    """
    if source_types is None:
        source_types = (RDS_SOURCE_TYPES if service is Service.RDS
                        else ELASTICACHE_SOURCE_TYPES)
    _validate_source_types(service, source_types)
    start, end = clamp_window(start=start, end=end)

    seen: set[tuple[str, str, str]] = set()
    out: list[ChangeEvent] = []
    for st in source_types:
        kw: dict[str, object] = {
            "SourceType": st,
            "StartTime": start,
            "EndTime": end,
            "MaxRecords": MAX_RECORDS,
        }
        if source_id:
            kw["SourceIdentifier"] = source_id
        try:
            pages = client.get_paginator("describe_events").paginate(**kw)
            for page in pages:
                for raw in page.get("Events", []):
                    ev = _to_event(service, raw)
                    if ev is None:
                        continue
                    k = ev.dedupe_key()
                    if k in seen:
                        continue
                    seen.add(k)
                    out.append(ev)
        except (ClientError, BotoCoreError) as e:
            # ⚠️ 一个 SourceType 失败不放弃其余类型：拿到 db-instance 却因为
            #    db-cluster 报错而全丢，会让抑制完全失效；只丢一半仍然有用。
            logger.warning("%s/%s 变更事件拉取失败: %s", service.value, st, e)
    out.sort(key=lambda e: (e.at, e.source_id))
    return out


def _to_event(service: Service, raw: Mapping[str, object]) -> ChangeEvent | None:
    """原始 dict → `ChangeEvent`。字段缺失时返回 None 而不是抛。

    ⚠️ `SourceArn` 与 `EventCategories` **只有 RDS 有**，用 `.get()` 取。
    写成 `raw["EventCategories"]` 会让 ElastiCache 侧每条都 KeyError，
    整个采集失败。
    """
    at = raw.get("Date")
    if not isinstance(at, datetime):
        return None
    source_id = str(raw.get("SourceIdentifier") or "")
    if not source_id:
        return None
    cats = tuple(str(c) for c in (raw.get("EventCategories") or ()))
    message = str(raw.get("Message") or "")
    return ChangeEvent(
        service=service,
        source_id=source_id,
        source_type=str(raw.get("SourceType") or ""),
        message=message,
        at=at if at.tzinfo else at.replace(tzinfo=timezone.utc),
        kind=classify(message, cats),
        categories=cats,
    )


def annotations_by_instance(
    events: Iterable[ChangeEvent],
) -> dict[str, list[tuple[date, str]]]:
    """整理成 `series.build_series(change_events=...)` 要的形状。

    ⚠️ 返回**标注**而不是「要剔除的日子」（R8.2）：7 天窗口里一次重启，
    把那几天删掉会让 coverage 掉到 5 以下、整台实例被判 INSUFFICIENT_DATA。

    ⚠️ **按 (日, 类型) 去重。** 不去重的话一台实例一天有 154 条备份事件就会
    产生 154 个相同标注 —— 实测数值。它们会一路带到 UI 的曲线注记上，
    把一天的图标叠成一坨，也让载荷白白变大。
    """
    seen: set[tuple[str, date, str]] = set()
    out: dict[str, list[tuple[date, str]]] = {}
    for ev in events:
        key = (ev.source_id, ev.day, ev.kind.value)
        if key in seen:
            continue
        seen.add(key)
        out.setdefault(ev.source_id, []).append((ev.day, ev.kind.value))
    for rows in out.values():
        rows.sort()
    return out


def suppression_days(
    events: Iterable[ChangeEvent], *, warmup_days: int = 5,
) -> dict[str, set[date]]:
    """每台实例需要压制内存类判定的日子（R8.5）。

    只有 `suppresses_memory` 为真的事件才产生抑制窗口 ——
    备份、参数组变更不该让整台实例哑掉 5 天。
    """
    out: dict[str, set[date]] = {}
    for ev in events:
        if not ev.kind.suppresses_memory:
            continue
        d0 = ev.day
        out.setdefault(ev.source_id, set()).update(
            d0 + timedelta(days=i) for i in range(warmup_days + 1)
        )
    return out
