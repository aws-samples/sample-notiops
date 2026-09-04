"""巡检范围与排除清单（R1）—— 纯逻辑，零 IO。

两份独立清单（R1.2）：

```
high   高负载巡检的排除清单
idle   闲置/优化巡检的排除清单
```

⚠️ 两份分开是刻意的：一台跑批机器「不该报高负载」（每晚打满是预期）
但「该报闲置」（白天空着）。合成一份会强迫客户二选一。

## 三条关键语义

1. **到期自动失效，但记录保留**（R1.3 / R1.4）
   条目带 `reason` + `expires_at`。到期后判定上不再生效，但行还在库里 ——
   客户要能看见「这条曾经排除过、什么理由、什么时候失效的」。
   ⚠️ 这是防「白名单越积越多没人敢删」的唯一机制。

2. **存 ID + level，不存展开结果**（R1.6）
   勾选集群时只存集群 ID，成员在**判定时**展开。
   ⚠️ 存展开结果会在集群扩缩容后失效：加了新副本不会被排除，
   删掉的成员留成幽灵条目。

3. **集群行勾中即排除其下全部**
   级联方向只有一个：集群 → 成员。反向不成立（排除一个成员不影响集群其它成员）。
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from enum import Enum

# 通配符 —— 排除整个账号或某账号下某个服务
WILDCARD = "*"


DEFAULT_EXCLUSION_DAYS = 30
"""R1.3：新建排除条目的默认有效期。

⚠️ 这个默认值此前**只写在 spec 里没有实现**：`ExclusionEntry.expires_at`
默认 `None` = 永不过期，而 `audit_expiry` 专门盯 `never_expires` 这个数 ——
系统自己在制造它要报的那个问题。

⚠️ 默认值 SHALL 在**创建入口**生效（`new_exclusion`），
SHALL NOT 在 `ExclusionEntry` 的字段默认值上做。理由：
从 DDB 读回来的老条目本来就没有 `expires_at`，
如果字段默认值是「今天+30 天」，那些条目会在**每次读取时**被算出一个
新的过期日，永远不会过期，而且每天的值都不一样（不可重放）。
`None` 必须继续表示「这条就是永不过期」，这样 `audit_expiry` 才数得准。
"""


class ScopeList(str, Enum):
    """两份清单。"""

    HIGH = "high"
    IDLE = "idle"


class ScopeLevel(str, Enum):
    """条目指向的粒度。"""

    INSTANCE = "instance"
    CLUSTER = "cluster"         # RDS/Aurora 集群
    GROUP = "group"             # ElastiCache 副本组
    ACCOUNT = "account"         # 整个账号（resource_id = *）


@dataclass(frozen=True)
class ExclusionEntry:
    """一条排除记录。

    `expires_at` 语义与既有 `shared/queries/whitelist.py` 保持一致：
    **该日起失效，不含当日** —— `today >= expires_at` 即视为失效。
    ⚠️ 这里只比到日期（不比时刻）。日粒度巡检下够用，且误差方向是安全的：
    偏早失效 = 该资源被重新纳入巡检 = 客户多看见一条，而不是漏掉一条。
    """

    list_kind: ScopeList
    account_id: str
    service: str
    resource_id: str                    # 实例 / 集群 / 副本组 ID，或 WILDCARD
    region: str = ""                    # 空 = 该账号下所有区域
    level: ScopeLevel = ScopeLevel.INSTANCE
    reason: str = ""
    expires_at: date | None = None
    created_by: str = ""
    created_at: date | None = None

    def is_active(self, today: date) -> bool:
        return self.expires_at is None or today < self.expires_at

    @property
    def never_expires(self) -> bool:
        return self.expires_at is None

    def days_until_expiry(self, today: date) -> int | None:
        return (self.expires_at - today).days if self.expires_at else None

    def covers_region(self, region: str) -> bool:
        """条目是否作用于该区域。`region` 为空 = 跨区域生效（老数据兼容）。

        ⚠️ 资源 ID 只在区域内唯一。不带 region 的条目会把两个区域的同名实例
        一起排除掉 —— 对「勾一台不该报的机器」这个意图来说是超出预期的副作用。
        新写入 SHALL 带 region；留空只为兼容既有数据。
        """
        return not self.region or self.region == region

    @property
    def key(self) -> str:
        """DDB SK：`<account>#<region>#<service>#<resource_id>`。

        ⚠️ 比原设计多一段 `region`：资源 ID 只在区域内唯一，
        不含 region 的 SK 会让跨区同名实例共用一条排除记录。
        region 为空时用 `-`，保持段数固定。
        """
        return "#".join((
            self.account_id, self.region or "-", self.service, self.resource_id
        ))


def new_exclusion(
    *,
    list_kind: ScopeList,
    account_id: str,
    service: str,
    resource_id: str,
    today: date,
    region: str = "",
    level: ScopeLevel | None = None,
    reason: str = "",
    created_by: str = "",
    days: int | None = DEFAULT_EXCLUSION_DAYS,
) -> ExclusionEntry:
    """建一条排除条目，**默认 30 天后失效**（R1.3）。

    Args:
        days: 有效天数。`None` = 显式要求永不过期 ——
            这是个刻意的显式动作，不是默认行为。

    ⚠️ 写入路径 SHALL 走这个函数而不是直接构造 `ExclusionEntry`，
    否则「默认 30 天」这条需求就又只存在于文档里了。
    有测试锁住「直接构造仍然是 None」与「走这个函数就有日期」的差别。
    """
    return ExclusionEntry(
        list_kind=list_kind,
        account_id=account_id,
        service=service,
        resource_id=resource_id,
        region=region,
        level=level or ScopeLevel.INSTANCE,
        reason=reason,
        expires_at=(today + timedelta(days=days)) if days is not None else None,
        created_by=created_by,
        created_at=today,
    )


@dataclass(frozen=True)
class ExclusionDecision:
    """排除判定结果 —— 要能说清是被哪一条排除的（UI 上客户会问）。"""

    excluded: bool
    matched: ExclusionEntry | None = None
    matched_on: str = ""                # instance | cluster | group | account | service

    @property
    def reason(self) -> str:
        return self.matched.reason if self.matched else ""


@dataclass(frozen=True)
class ResourceRef:
    """判定排除所需的最小资源标识。

    `cluster_id` 覆盖 RDS/Aurora 集群与 ElastiCache 副本组两种情形 ——
    它们在排除语义上是同一件事：勾中容器即排除其下全部成员。
    """

    account_id: str
    service: str
    instance_id: str
    cluster_id: str | None = None
    region: str = ""


# ---------------------------------------------------------------------------
# 判定
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExclusionIndex:
    """把排除清单预处理成索引，让判定从 O(条目数) 降到 O(1)。

    ⚠️ 建索引不是过早优化：`is_excluded` 会被调 4 次（R1.8 入口 + R6.10 出口）
    × 两份清单，而排除条目**只增不减**（R1.3 的到期机制是为了控这个但不保证）。
    实测 5000 资源 × 2000 条 = 1.75 秒/趟；条目上万后会成为可感知的开销。

    索引只装 `is_active(today)` 为真的条目 —— 失效条目仍在库里但不参与判定（R1.4）。
    """

    by_instance: Mapping[tuple[str, str, str], list[ExclusionEntry]] = field(
        default_factory=dict
    )
    by_container: Mapping[tuple[str, str, str], list[ExclusionEntry]] = field(
        default_factory=dict
    )
    by_service: Mapping[tuple[str, str], list[ExclusionEntry]] = field(
        default_factory=dict
    )
    by_account: Mapping[str, list[ExclusionEntry]] = field(default_factory=dict)
    # region 不参与索引键（条目可能是跨区域的），命中后用 _first_covering 挑
    # —— 值是**列表**而不是单条，否则跨区同名条目会被 setdefault 丢掉
    active_count: int = 0
    list_kind: ScopeList | None = None
    """本索引代表哪份清单。`None` = 没过滤（兼容用）。"""

    @classmethod
    def build(
        cls,
        entries: Iterable[ExclusionEntry],
        today: date,
        list_kind: ScopeList | None = None,
    ) -> ExclusionIndex:
        """建索引。

        Args:
            list_kind: **只收这份清单的条目**。`None` = 不过滤（仅为兼容既有
                调用方；生产路径 SHALL 显式传）。

        ⚠️ `list_kind` 此前在整条判定链上**完全没被读过** ——
        `build` / `is_excluded` / `filter_targets` 三个函数一个都没看它。
        而 DDB 上按 `inspscope#<account>` 做一次 Query 拿回来的是 high + idle
        混在一起的全部条目，于是 R1.2「两份独立的排除清单」事实上是一份：
        客户为跑批机器加一条 `high` 排除（「每晚打满是预期」），
        这台机器会同时从 `idle` 轮消失 —— 正是那条需求要避免的结果，而且是静默的。

        ⚠️ 每一层用 `list[ExclusionEntry]` 而不是单条。早期实现用 `setdefault`，
        于是同一个 (account, service, resource_id) 只保留**第一条**：

        ```
        条目A  prod-mysql  region=us-east-1        ← 先进索引
        条目B  prod-mysql  region=ap-northeast-1   ← 被丢弃
        判定 ap-northeast-1 的 prod-mysql：命中 A → covers_region 假 → 不排除
        ```

        客户在 UI 上勾掉了东京那台，系统照样报它；而 `active_count` 还把 B 算了进去，
        所以 R1.0a 常驻显示的「已排除 N 个」也是错的。
        """
        by_instance: dict[tuple[str, str, str], list[ExclusionEntry]] = {}
        by_container: dict[tuple[str, str, str], list[ExclusionEntry]] = {}
        by_service: dict[tuple[str, str], list[ExclusionEntry]] = {}
        by_account: dict[str, list[ExclusionEntry]] = {}
        n = 0

        for e in entries:
            if list_kind is not None and e.list_kind is not list_kind:
                continue
            if not e.is_active(today):
                continue
            n += 1
            if e.service == WILDCARD and e.resource_id == WILDCARD:
                by_account.setdefault(e.account_id, []).append(e)
            elif e.resource_id == WILDCARD:
                by_service.setdefault((e.account_id, e.service), []).append(e)
            elif e.level in (ScopeLevel.CLUSTER, ScopeLevel.GROUP):
                by_container.setdefault(
                    (e.account_id, e.service, e.resource_id), []
                ).append(e)
            else:
                by_instance.setdefault(
                    (e.account_id, e.service, e.resource_id), []
                ).append(e)

        return cls(by_instance, by_container, by_service, by_account, n, list_kind)


def _first_covering(
    candidates: list[ExclusionEntry] | None, region: str
) -> ExclusionEntry | None:
    """同一个键下可能挂着多条（不同 region）—— 取第一条作用于该区域的。

    精确 region 优先于跨区域（`region=""`）条目，这样 UI 显示的理由是最具体那条。
    """
    if not candidates:
        return None
    exact = [e for e in candidates if e.region and e.region == region]
    if exact:
        return exact[0]
    return next((e for e in candidates if not e.region), None)


def is_excluded(
    resource: ResourceRef,
    entries: Iterable[ExclusionEntry] | ExclusionIndex,
    today: date,
    list_kind: ScopeList | None = None,
) -> ExclusionDecision:
    """这个资源在这份清单里被排除了吗。

    `entries` 可以是原始条目序列（内部自建索引），也可以是预建好的
    `ExclusionIndex`（批量过滤时用后者，避免每个资源重建一次）。

    匹配优先级（先命中先返回，越具体越优先 —— UI 要显示最精确那条的理由）：

    ```
    1  instance   (account, service, instance_id)
    2  cluster    (account, service, cluster_id)  且 level ∈ {cluster, group}
    3  service    (account, service)              且 resource_id == *
    4  account    account                         且 service == * 且 resource_id == *
    ```

    每一层命中后还要过 `covers_region()` —— 资源 ID 只在区域内唯一。
    """
    idx = (
        entries if isinstance(entries, ExclusionIndex)
        else ExclusionIndex.build(entries, today, list_kind)
    )
    if (
        list_kind is not None
        and idx.list_kind is not None
        and idx.list_kind is not list_kind
    ):
        raise ValueError(
            f"索引是 {idx.list_kind.value} 清单的，却在判定 {list_kind.value} —— "
            f"两份清单混用会静默跨类排除（R1.2）"
        )

    acct, svc, region = resource.account_id, resource.service, resource.region

    hit = _first_covering(idx.by_instance.get((acct, svc, resource.instance_id)), region)
    if hit is not None:
        return ExclusionDecision(True, hit, "instance")

    if resource.cluster_id:
        hit = _first_covering(
            idx.by_container.get((acct, svc, resource.cluster_id)), region
        )
        if hit is not None:
            return ExclusionDecision(True, hit, hit.level.value)

    hit = _first_covering(idx.by_service.get((acct, svc)), region)
    if hit is not None:
        return ExclusionDecision(True, hit, "service")

    hit = _first_covering(idx.by_account.get(acct), region)
    if hit is not None:
        return ExclusionDecision(True, hit, "account")

    return ExclusionDecision(False)


def filter_targets(
    resources: Sequence[ResourceRef],
    entries: Iterable[ExclusionEntry] | ExclusionIndex,
    today: date,
    list_kind: ScopeList | None = None,
) -> tuple[list[ResourceRef], list[tuple[ResourceRef, ExclusionDecision]]]:
    """一次过滤一批。返回 (纳入巡检的, 被排除的+原因)。

    ⚠️ 被排除的也返回 —— 运维要能看到「本轮排除了 N 台，因为这些条目」，
    否则排除清单会变成静默黑洞（R9.x 的可观测性要求）。

    索引只建一次（而不是每个资源一次），这是 O(n+m) 而非 O(n×m) 的关键。
    """
    idx = (
        entries if isinstance(entries, ExclusionIndex)
        else ExclusionIndex.build(entries, today, list_kind)
    )
    kept: list[ResourceRef] = []
    dropped: list[tuple[ResourceRef, ExclusionDecision]] = []

    for r in resources:
        decision = is_excluded(r, idx, today, list_kind)
        if decision.excluded:
            dropped.append((r, decision))
        else:
            kept.append(r)

    return kept, dropped


# ---------------------------------------------------------------------------
# 到期治理 —— R1.3 的「避免越积越多」要有可观测性
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExpiryReport:
    """排除清单的健康度。给运维页与月报用。"""

    total: int = 0
    active: int = 0
    expired: int = 0
    never_expires: int = 0
    expiring_within_7d: tuple[ExclusionEntry, ...] = ()
    no_reason: tuple[ExclusionEntry, ...] = field(default_factory=tuple)

    @property
    def never_expires_ratio(self) -> float:
        return self.never_expires / self.total if self.total else 0.0


def audit_expiry(
    entries: Iterable[ExclusionEntry], today: date, lead_days: int = 7
) -> ExpiryReport:
    """盘一遍清单的到期状况。

    `never_expires` 是要盯的那个数 —— 永不过期的条目就是「越积越多」的来源。
    `no_reason` 同理：没写理由的条目过半年谁也不敢删。
    """
    items = list(entries)
    active = [e for e in items if e.is_active(today)]
    expiring = [
        e for e in active
        if e.expires_at is not None and 0 <= (e.expires_at - today).days <= lead_days
    ]
    return ExpiryReport(
        total=len(items),
        active=len(active),
        expired=len(items) - len(active),
        never_expires=sum(1 for e in items if e.expires_at is None),
        expiring_within_7d=tuple(
            sorted(expiring, key=lambda e: (e.expires_at, e.key))
        ),
        no_reason=tuple(
            sorted((e for e in items if not e.reason.strip()), key=lambda e: e.key)
        ),
    )


# ---------------------------------------------------------------------------
# 巡检范围（R1.6）—— 存 ID + level，不存展开结果
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScopeTarget:
    """客户勾选的一个巡检目标。"""

    list_kind: ScopeList
    account_id: str
    service: str
    resource_id: str
    level: ScopeLevel = ScopeLevel.INSTANCE


def expand_targets(
    targets: Iterable[ScopeTarget],
    members_by_container: Mapping[str, Sequence[str]],
) -> tuple[tuple[str, str, str], ...]:
    """把勾选目标展开成 (account, service, instance_id) 的**有序**元组。

    Args:
        targets: 客户勾选的（可能是集群/副本组级）。
        members_by_container: 容器 ID → 成员实例 ID 列表，**由 repository 层
            在本轮实时查出来**，不从库里读历史展开结果（R1.6）。

    ⚠️ 展开发生在判定时而不是保存时。集群扩缩容后，保存时的展开结果就错了：
    新加的副本不会被包含，删掉的成员留成幽灵。
    ⚠️ 容器查不到成员时**只保留容器 ID 自身**，不静默丢弃 ——
    否则「集群暂时查不到」会表现为「这个集群不在范围内」。

    ⚠️ 返回的是**有序 tuple 而不是 set**。CPython 默认开启字符串哈希随机化，
    set 的迭代顺序每个进程都不同 —— 而这个返回值会决定巡检实例清单的顺序，
    进而决定 `GetMetricData` 的批次划分、`sort_findings` 里同 key 条目的相对次序、
    以及 R12.6a ③ top-N 截断切在哪里。同一天用同一份数据重跑会得到不同的报告，
    而 R14 的「可重放」是这批 domain 代码的核心卖点。
    """
    out: set[tuple[str, str, str]] = set()
    for t in targets:
        if t.level in (ScopeLevel.CLUSTER, ScopeLevel.GROUP):
            members = members_by_container.get(t.resource_id) or []
            if members:
                for m in members:
                    out.add((t.account_id, t.service, m))
            else:
                out.add((t.account_id, t.service, t.resource_id))
        else:
            out.add((t.account_id, t.service, t.resource_id))
    return tuple(sorted(out))
