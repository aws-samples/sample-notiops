"""`notiops-inspection` 表的读写。

## 为什么单独建表而不复用 `notiops-metrics`

后者已列入删除计划，且序列库有自己的 TTL 策略（`data_date + 35 天`，
**不等于**窗口长度）。混在一张表里会让删除动作互相牵制。

## 三条容易写出静默错误的地方

```
① begins_with 串行
   七个前缀之所以安全，是公共词根 `insp` 后不接分隔符（`inspseries#` 而非
   `insp#series#`）。加子空间时嵌套成 `inspfind#dispatch#` 会让
   begins_with("inspfind#") 把它一起扫出来 —— keys.assert_prefixes_disjoint() 守这条

② TTL 已过期但物理未删
   DynamoDB 的 TTL 删除是**最长 48 小时内**的后台过程，不是到点即删。
   读侧不加 filter 会读到早该消失的行（R13.9）

③ 条件写缺失
   同一天重投（SQS at-least-once 是必然路径）会让 finding 的状态被推进两次
```

## 边界

本模块做 IO，属 adapters 层。**不含任何判定逻辑** —— 状态推进在
`domain/lifecycle.py`，这里只负责把 `Transition` 落成 DDB 的写请求。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import asdict as dc_asdict
from dataclasses import dataclass, field, is_dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from inspection.adapters import keys
from inspection.domain.lifecycle import (
    FindingRecord,
    FindingState,
    Transition,
    TransitionKind,
)
from inspection.domain.schedule import (
    TICK_MINUTES,
    RunStatus,
    RunType,
    ScheduleConfig,
)

logger = logging.getLogger(__name__)

SERIES_TTL_DAYS = 35
"""R13.9：序列库 TTL = `data_date + 35 天`。

⚠️ **不等于窗口长度（7 天）。** 序列库服务三件事：UI 画图不打 CloudWatch、
存 `config_version` 做审计、存当天判定结果做复盘。35 天让「上个月这台怎么样」
还能回答，而 TTL 删早删晚都不影响判定正确性（每轮直接从 CloudWatch 拉）。
"""

DISPATCH_TTL_DAYS = 14
"""派发映射的保留天数（7.4b）。

14 天而不是 35：这张映射只在「等 callback 回来」那段窗口里有用。
取 14 是为了对上两件事 ——
· `DescribeEvents` 只保留 14 天，出问题时能对照的窗口就这么长
· 对账 Lambda 判「pending 超 2h 无终态」（R13.13），2 小时的量级远小于 14 天，
  留这么久是给人工排查用的余量，不是给自动逻辑用的

⚠️ SHALL NOT 取 0 / 不设 TTL：读取模式是按 task_id 点查，无界增长不影响
性能但会一直付存储费，而 14 天以后的映射对任何代码路径都没有意义。
"""

PUSH_STATE_TTL_DAYS = 60
"""推送状态的保留天数（R11b.5 的退避重推靠它）。

⚠️ **必须比 finding 的活跃期长。** 取短了会让一条长期挂着的 CRITICAL
在中途丢掉推送状态，于是它被当成「从没推过」，退避从第 1 档重新开始 ——
表现是每隔一段时间就连着推几天，而客户看不出为什么。
60 天覆盖 R11b.5 举的那个例子（挂 3 周）还有两倍余量。

⚠️ TTL 从**推送当天**起算而不是首见日：只要还在推就一直续期，
停推 60 天之后那条要么早已关闭，要么按「重新开始退避」处理也无妨。
"""

DIGEST_LEDGER_SK = "digest"
"""摘要账本的 SK（与 `high` / `idle` / `push` 同 PK）。

⚠️ 不是 `RunType` 的成员，也不是 `PushKind` 的 —— 它是一行状态而不是配置。
放在同一个 PK 下只是为了让管理页一次读完这一族。
"""

PUSH_SCHEDULE_SK = "push"
"""推送时段配置的 SK（与 `high` / `idle` 同 PK）。

⚠️ 不是 `RunType` 的成员 —— 推送不是一类巡检。写进那个枚举会让
`load_schedules()` 把它当成第三类巡检去 fan-out。
"""

MAX_BATCH_WRITE = 25
"""DynamoDB `BatchWriteItem` 的硬上限（每次 25 条）。"""

RUN_LOCK_TTL_HOURS = 6
"""run 锁的自动释放时长。写进 **`lock_until`**，不是 DDB TTL 属性。

取 6 小时而不是 24：巡检 Lambda 的最长执行时间远小于 6 小时，
崩在中途后等 6 小时就能人工重跑；取 24 会让「今天挂了今天就别想再跑」。
"""

RUN_TTL_DAYS = 60
"""run 记录的保留天数。**与锁超时必须是两个字段。**

🔴 此前锁超时直接写在 `ttl` 上，而 `ttl` 正是本表的 DDB TTL 属性
（CDK `timeToLiveAttribute: "ttl"`，线上 `TimeToLiveStatus: ENABLED`）。
于是每一行 run 记录**6 小时后被 DynamoDB 真的删掉**，成功失败一律。
当时的注释写着「这不是 TTL 的删除时间，TTL 是最长 48 小时的后台过程」——
那是把「删得不准时」当成了「不会删」。东京的验证账号实测：
03:22 建的两行，到 09:2x 整行消失。

后果是三件事同时坏掉，且全部表现为「界面上是空的」：

```
看板 getRuns(days=14)     永远只看得到 6 小时内 → 日期筛选无历史可筛
总览 current vs previous  两轮间隔 24h > 6h    → delta 恒 null
R9.11「那天没跑过」        记录被删             → 分不清「没跑」与「没风险」
```

取 60 天与 `PUSH_STATE_TTL_DAYS` 对齐：看板要 14 天，留四倍余量，
且比任何 finding 的活跃期都长。
"""

RUN_STATUS_RUNNING = RunStatus.RUNNING.value
RUN_STATUS_SUCCESS = RunStatus.SUCCESS.value
RUN_STATUS_FAILED = RunStatus.FAILED.value
RUN_STATUS_PARTIAL = RunStatus.PARTIAL.value
"""run 的四态，**从 `domain/schedule.py` 取**，不在这里再定义一份。

⚠️ 我一度在这里独立写成 `RUN_STATUS_COMPLETED = "completed"`，
而 `due_runs()` 认的是 `"success"` —— 两套词汇互不认识，
后果是 run 明明成功了却被判成「今天还没跑」，每个 tick 重跑一次。
不报错，只烧额度。
"""


class StoreError(RuntimeError):
    """DDB 操作失败。**故意不吞** —— 写失败而调用方以为成功，
    下一轮就会把「没落库的 finding」当成新出现的（R6.5 的计数被污染）。"""


# ---------------------------------------------------------------------------
# 数值转换
# ---------------------------------------------------------------------------


def to_ddb_number(x: float | int | None) -> Decimal | None:
    """float → Decimal。DynamoDB **不接受 float**（boto3 会抛 TypeError）。

    ⚠️ 走 `str()` 而不是 `Decimal(float)`：后者会把 0.1 存成
    `0.1000000000000000055511151231257827021181583404541015625`，
    于是同一个阈值在两轮之间「变了」，`config_hash` 跟着变，
    R6.9 会误判规则变更并强制 resolve 全部 finding。
    """
    if x is None:
        return None
    if isinstance(x, bool):      # bool 是 int 的子类，别当数字存
        raise TypeError("bool 不该走数值转换")
    return Decimal(str(x))


def from_ddb_number(x: Any) -> float | None:
    if x is None:
        return None
    return float(x)


def _utc_today() -> date:
    """今天（UTC）。**只给 TTL 用** —— 判定层的 `today` 一律由入参传入（R14.2）。

    ⚠️ 存在的理由是「续期」：TTL 要锚在**写入当天**，而写入方传进来的业务日期
    可能是陈旧的（摘要写传的是上一次日推的日期）。
    """
    return datetime.now(timezone.utc).date()


def _ttl_epoch(data_date: date, days: int = SERIES_TTL_DAYS) -> int:
    """TTL 属性要的是 **epoch 秒**（int）。

    ⚠️ 存 ISO 字符串 DynamoDB 会**静默忽略** —— 不报错，行永不过期。
    """
    expire = datetime(
        data_date.year, data_date.month, data_date.day, tzinfo=timezone.utc
    ) + timedelta(days=days)
    return int(expire.timestamp())


def _now_epoch() -> int:
    return int(datetime.now(timezone.utc).timestamp())


# ---------------------------------------------------------------------------
# 序列库（R13.9 / R13.10 / R13.11）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SeriesRow:
    """序列库的一行 = 一个 (实例, 指标, 统计量, 数据日期) 的值。"""

    account_id: str
    region: str
    service: str
    instance_id: str
    metric: str
    stat: str
    data_date: date
    value: float | None
    datapoint_count: int = 0
    unit: str = ""
    period: int = 86_400
    config_version: str = ""
    backfilled: bool = False
    backfill_run_id: str = ""

    def pk(self) -> str:
        return keys.series_pk(
            self.account_id, self.region, self.service, self.instance_id)

    def sk(self) -> str:
        return keys.series_sk(self.metric, self.stat, self.data_date)

    def to_item(self) -> dict[str, Any]:
        """R13.11：`value=None` 也**显式写行**并带 `datapoint_count: 0`。

        ⚠️ 不写行与写 `value=None` 是两件事：
        ```
        不写行            读的时候分不出「那天没采」与「那天采了但没数据」
        写 value=None     显式记录「我们看过那天，CloudWatch 返回空」
                          → R3.5 的可观测性缺口能按它上报
        ```
        """
        item: dict[str, Any] = {
            "PK": self.pk(),
            "SK": self.sk(),
            "account_id": self.account_id,
            "region": self.region,
            "service": self.service,
            "instance_id": self.instance_id,
            "metric": self.metric,
            "stat": self.stat,
            "data_date": self.data_date.isoformat(),
            "datapoint_count": self.datapoint_count,
            "period": self.period,
            "ttl": _ttl_epoch(self.data_date),
        }
        v = to_ddb_number(self.value)
        if v is not None:
            item["value"] = v
        if self.unit:
            item["unit"] = self.unit
        if self.config_version:
            item["config_version"] = self.config_version
        if self.backfilled:
            # R13.15：补齐的数据点要能被认出来 —— 否则「昨天为什么没告警」
            # 会因为今天补上了数据而永远查不清。
            item["backfilled"] = True
            item["backfill_run_id"] = self.backfill_run_id
        return item

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> "SeriesRow":
        return cls(
            account_id=str(item.get("account_id", "")),
            region=str(item.get("region", "")),
            service=str(item.get("service", "")),
            instance_id=str(item.get("instance_id", "")),
            metric=str(item.get("metric", "")),
            stat=str(item.get("stat", "")),
            data_date=date.fromisoformat(str(item["data_date"])),
            value=from_ddb_number(item.get("value")),
            datapoint_count=int(item.get("datapoint_count", 0) or 0),
            unit=str(item.get("unit", "")),
            period=int(item.get("period", 86_400) or 86_400),
            config_version=str(item.get("config_version", "")),
            backfilled=bool(item.get("backfilled", False)),
            backfill_run_id=str(item.get("backfill_run_id", "")),
        )


class InspectionStore:
    """`notiops-inspection` 表的读写门面。

    构造时只拿 `table`（boto3 `Table` 资源或替身），不自己建 client ——
    这样测试不需要 moto，也不需要网络。
    """

    def __init__(self, table: Any):
        self._t = table

    # ── 序列库 ──────────────────────────────────────────────────────────

    def put_series(self, rows: Sequence[SeriesRow]) -> int:
        """批量写序列行。返回写入条数。

        ⚠️ 用 `batch_writer()` 而不是逐条 `put_item`：1000 实例 × 18 指标 ×
        4 统计量 × 7 天 ≈ 500k 行，逐条写在 Lambda 15 分钟内跑不完。
        """
        if not rows:
            return 0
        try:
            with self._t.batch_writer() as bw:
                for r in rows:
                    bw.put_item(Item=r.to_item())
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"写序列库失败（{len(rows)} 行）: {e}") from e
        return len(rows)

    def query_series(
        self,
        account_id: str,
        region: str,
        service: str,
        instance_id: str,
        *,
        metric: str = "",
        now_epoch: int | None = None,
    ) -> list[SeriesRow]:
        """读一个实例的序列。**已过期的行会被过滤掉**（R13.9）。

        ⚠️ TTL 过滤必须在读侧做：DynamoDB 的 TTL 删除是**最长 48 小时内**的
        后台过程，不是到点即删。不过滤会读到早该消失的行，而那些行的
        `config_version` 已经对应一份不存在的配置 —— UI 画阈值线时会画错。
        """
        cutoff = _now_epoch() if now_epoch is None else now_epoch
        kw: dict[str, Any] = {
            "KeyConditionExpression": "#pk = :pk",
            "ExpressionAttributeNames": {"#pk": "PK"},
            "ExpressionAttributeValues": {
                ":pk": keys.series_pk(account_id, region, service, instance_id),
                ":now": cutoff,
            },
            "FilterExpression": "attribute_not_exists(#ttl) OR #ttl > :now",
        }
        kw["ExpressionAttributeNames"]["#ttl"] = "ttl"
        if metric:
            kw["KeyConditionExpression"] += " AND begins_with(#sk, :sk)"
            kw["ExpressionAttributeNames"]["#sk"] = "SK"
            kw["ExpressionAttributeValues"][":sk"] = metric + keys.SEP
        return [SeriesRow.from_item(it) for it in self._paginate("query", kw)]

    # ── run 记录 ────────────────────────────────────────────────────────

    def put_run(
        self, run_type: str, run_date: date, account_id: str, payload: Mapping[str, Any]
    ) -> None:
        """写 run 记录。**`put_item` 整行覆盖**，所以要自己补回两个时钟字段。

        🔴 `lock_until` 与 `ttl` 是 `try_acquire_run_lock` 写下的，而本函数
        用 `put_item`（不是 update）—— payload 里没有它们就等于**抹掉**。
        executor 在 6.4 步调本函数写 `expected` / `data_date`，于是：

        ```
        claim   写 lock_until(+6h) 与 ttl(+60d)
        put_run 整行覆盖 → 两个字段消失
                → 行没有 TTL 属性 → **永不过期，run 记录无限累积**
                → 锁也没了超时判据（崩在中途时只能靠 status=failed 那条）
        ```

        东京实测（2026-08-22）：收尾后的 run 行字段清单里既没有 `lock_until`
        也没有 `ttl`。这是 `RUN_TTL_DAYS` 那个修复的反面漏洞 —— 那次把两个
        时钟拆开了，却没管住整行覆盖的这条路径。

        ⚠️ 不能改成 `update_item`：本函数在 executor 里也用于**首次建行**
        （补齐轮的 `<account>#bf<n>` 键第一次出现），update 对不存在的行会
        建出没有 status 的桩行。所以做法是 put 之前把两个字段补进 payload。
        """
        item = {
            "PK": keys.run_pk(run_type, run_date),
            "SK": account_id,
            "run_type": run_type,
            "run_date": run_date.isoformat(),
            "account_id": account_id,
            **_jsonable(payload),
        }
        # 调用方没显式给就补：ttl 一律按写入当天算（与 finish_run 同约定），
        # lock_until 读回已有值 —— 覆盖它等于把锁的超时点往后推。
        if "ttl" not in item:
            item["ttl"] = _ttl_epoch(_utc_today(), RUN_TTL_DAYS)
        if "lock_until" not in item:
            try:
                prev = self.get_run(run_type, run_date, account_id) or {}
            except StoreError:
                prev = {}
            if prev.get("lock_until") is not None:
                item["lock_until"] = prev["lock_until"]
        try:
            self._t.put_item(Item=item)
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"写 run 记录失败 {run_type}/{run_date}: {e}") from e

    def get_run(
        self, run_type: str, run_date: date, account_id: str
    ) -> dict[str, Any] | None:
        try:
            r = self._t.get_item(
                Key={"PK": keys.run_pk(run_type, run_date), "SK": account_id})
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"读 run 记录失败: {e}") from e
        return r.get("Item")

    # 🔴 这里原本有**第二个** `try_acquire_run_lock` 定义（已删，2026-08-26）。
    #
    # 两个同名方法，后定义的胜出 —— 也就是下面那个带四段条件的正确版本。
    # 被删的那个条件只有 `attribute_not_exists(PK)`：崩在中途的 run 会**永久**
    # 占着锁（status 停在 running，之后每一轮都抢不到），而那正是下面那个
    # 定义花 30 行 docstring 解释并修掉的事。
    #
    # ⚠️ 留着死代码的风险不是「多几行」，而是任何一次重排 / 合并冲突让它
    #    排到后面，就静默回退到旧行为 —— 表现是「巡检从某天起再也不跑」，
    #    而 run 记录里只有一条 info 日志。


    # ── finding ────────────────────────────────────────────────────────

    def load_findings(self, account_id: str) -> dict[str, FindingRecord]:
        """读一个账号的全部 finding，组装成 `reconcile()` 的 `prev` 入参。

        ⚠️ **不过滤 state**。已 resolved 的行也要读回来 —— 否则同一条风险
        再次出现时会被当成 `new`，而它其实是 reopen，`first_seen_date` 该保留。
        """
        kw = {
            "KeyConditionExpression": "#pk = :pk",
            "ExpressionAttributeNames": {"#pk": "PK"},
            "ExpressionAttributeValues": {":pk": keys.finding_pk(account_id)},
        }
        out: dict[str, FindingRecord] = {}
        for it in self._paginate("query", kw):
            rec = _finding_from_item(it)
            out[rec.finding_id] = rec
        return out

    def get_finding_item(
        self, account_id: str, finding_id: str
    ) -> dict[str, Any] | None:
        """点查一条 finding 的**原始行**。不存在返回 `None`。

        🔴 `SK` 就是 `finding_id` 本身（实机确认：
        `SK = 444455556666#ap-northeast-1#elasticache#notiops-tb-mc-…#idle#-`
        与该行的 `finding_id` 逐字相同）。所以这是一次 `GetItem`，1 RCU。

        ⚠️ 不要用 `list_finding_items()` 再过滤代替它：那是**整个分区的 query**
        （一个账号可能有数千条 finding），为了一条记录付全分区的读取。
        「按需给单条 finding 派判读」那条路每次点击都会走这里。

        ⚠️ 返回原始行而不是 `FindingRecord`：载荷要用 `instance_id` / `region`
        / `instance_class` / `idle_factors` / `savings_usd` 这些字段，
        而 `FindingRecord` 把它们都丢掉了（`load_findings` 的说明里写了同一件事）。
        """
        try:
            r = self._t.get_item(
                Key={"PK": keys.finding_pk(account_id), "SK": finding_id})
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"读 finding 行失败: {e}") from e
        return r.get("Item")

    def list_finding_items(self, account_id: str) -> list[dict[str, Any]]:
        """读一个账号的 finding **原始行**（推送侧用）。

        ⚠️ 与 `load_findings()` 不是重复：那个返回 domain 的 `FindingRecord`，
        丢掉了 `instance_id` / `region` / `metric` / `transition_kind` /
        `da_verdict` —— 而推送正文与 Top N 排序全靠这些字段。
        用 `load_findings()` 的表现是推送卡片上只有 finding_id，
        客户看不出是哪台机器。
        """
        kw = {
            "KeyConditionExpression": "#pk = :pk",
            "ExpressionAttributeNames": {"#pk": "PK"},
            "ExpressionAttributeValues": {":pk": keys.finding_pk(account_id)},
        }
        return list(self._paginate("query", kw))

    def load_push_states(self, account_id: str) -> list[dict[str, Any]]:
        """读一个账号的推送状态行（`insppush#<acct>`，R11b.5）。"""
        return self._list_by_prefix(keys.push_pk(account_id))

    def mark_pushed(
        self,
        account_id: str,
        finding_id: str,
        *,
        pushed_date: date | None,
        push_count: int,
        severity: str = "",
        resolved_announced: bool = False,
        digest_date: date | None = None,
        ttl_days: int = PUSH_STATE_TTL_DAYS,
    ) -> None:
        """记下「这条推过了」。**独立行，不碰 finding 行。**

        🔴 为什么不写在 finding 行上：`apply_transitions()` 用 `put_item`
        **整行覆盖**，第二天的巡检轮会把推送字段整片抹掉 —— 表现是
        CRITICAL 的退避永远停在第 1 档（`push_count` 天天归零），
        「1/2/4/7 天」退化成「每天推」，而那正是 R11b.5 要防的。

        ⚠️ 用 `put_item` 而不是 `update_item`：这一行由推送侧独占，
        没有别的写者，整行覆盖是最简单且幂等的。同一天重投写出同样的值。

        ⚠️ 带 TTL：finding 关闭之后这行就没用了，但 finding 行本身会留着
        （`load_findings` 刻意不过滤 state）。不设 TTL 会让这张分区随时间
        无界增长。取值比 finding 的保留期略长 —— 短了会让一条长期 CRITICAL
        的推送状态在中途消失，于是它被当成「从没推过」重新从第 1 档开始退避。
        """
        fid = (finding_id or "").strip()
        if not fid:
            raise StoreError("mark_pushed 需要 finding_id —— 空键会让所有推送状态挤进一行")
        item: dict[str, Any] = {
            "PK": keys.push_pk(account_id),
            "SK": fid,
            "finding_id": fid,
            "account_id": account_id,
            "push_count": max(0, int(push_count)),
            # 🔴 TTL 一律按**写入当天**算，不是按 `pushed_date`。
            #
            #    第一版写的是 `pushed_date or digest_date or _today()`：
            #    ① `_today()` 在本模块里压根不存在（NameError 地雷，当前两个
            #       调用点都传了日期所以不可达）；
            #    ② 更要紧的是优先级 —— 摘要写传进来的 `pushed_date` 是**陈旧的**
            #       `last_pushed_date`，于是 TTL 锚在旧日期上。一条被日推过的
            #       finding 降到 MEDIUM 之后只走周报，`last_pushed_date` 从此
            #       冻结，第 60 天整行被删 → `push_count` 与 `resolved_announced`
            #       一起丢 → 退避从第 1 档重来、缓解通报重发。
            #       而 `PUSH_STATE_TTL_DAYS` 的注释承诺的是「只要还在推就一直续期」。
            "ttl": _ttl_epoch(_utc_today(), ttl_days),
        }
        # 🔴 `pushed_date` 为 None = 这是**摘要轮**，只更新 `last_digest_date`。
        #    写 `last_pushed_date` 会让 `next_push_date` 把 CRITICAL 的下次
        #    重推往后顶一天（周报每周顶一次）—— 与「摘要不消耗退避配额」相反。
        if pushed_date is not None:
            item["last_pushed_date"] = pushed_date.isoformat()
        if digest_date is not None:
            item["last_digest_date"] = digest_date.isoformat()
        if severity:
            item["last_pushed_severity"] = severity
        if resolved_announced:
            item["resolved_announced"] = True
        try:
            self._t.put_item(Item=item)
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"写推送状态失败 {fid}: {e}") from e

    def bump_backfill_attempt(
        self, run_type: str, account_id: str, run_date: date, *,
        attempt: int, backfill_run_id: str,
    ) -> None:
        """记下「这个 (类型, 账号, 日期) 补过第 N 次了」（R13.15）。

        🔴 **写在独立分区 `inspbf#<type>#<date>`，不碰 run 行。**

        第一版写在 run 行上用 `update_item` —— 而 `missing_row` 的场景**就是
        那行不存在**，于是 DynamoDB 建出一条只有两个计数字段、**没有
        `status`** 的桩行，后果三连且全部静默：那个账号当天再也抢不到 run 锁
        （锁的三段条件在缺失属性上一律判假）、缺行缺口下一小时从指标上消失
        （`audit_coverage` 只判 `row is None`）、重投上限因此永远到不了 2。
        净效果是账号整天没有巡检而三条信号全绿。详见 `keys.Prefix.BACKFILL`。

        ⚠️ 独立分区里**可以**放心建行：这一行的读者只有 `load_backfill_attempts`
        一个，它本来就把「没有行」当成「没补过」。
        """
        try:
            self._t.put_item(Item={
                "PK": keys.backfill_pk(run_type, run_date),
                "SK": account_id,
                "run_type": run_type,
                "run_date": run_date.isoformat(),
                "account_id": account_id,
                "backfill_attempts": max(1, int(attempt)),
                "last_backfill_run_id": backfill_run_id,
                # 与 run 行同期保留：账本活得比缺口窗口长就够了。
                "ttl": _ttl_epoch(run_date, DISPATCH_TTL_DAYS),
            })
        except (ClientError, BotoCoreError) as e:
            raise StoreError(
                f"记补齐次数失败 {run_type}/{account_id}/{run_date}: {e}") from e

    def load_backfill_attempts(
        self, run_type: str, run_date: date,
    ) -> dict[str, dict[str, Any]]:
        """某天某类型「各账号补过几次」，按 `account_id` 索引。

        ⚠️ 读不到返回空 dict —— `plan_backfill` 把缺失当成「没补过」。
        """
        rows = self._list_by_prefix(keys.backfill_pk(run_type, run_date))
        return {str(r.get("account_id") or r.get("SK") or ""): r for r in rows}

    def load_digest_ledger(self) -> dict[str, Any] | None:
        """读「两类摘要各自最后一次发出的日期」（R11b.5）。

        🔴 没有它就无法**顺延**摘要：1 号落周六的月份，月度摘要要延到
        周一发，而「延到周一」与「这个月已经发过了」只能靠这条账本区分。
        少了它的表现是那个月一条结构性风险都不推（2026 年有 4 个月中招），
        而结构性在每日推送里被明确挡掉 —— 月度是唯一出口。

        ⚠️ 与逐条 finding 的 `insppush#` 行分开：这是**整份摘要**的账本，
        一个部署一行。放在 finding 分区里会让「这个月发过没」要先知道
        有哪些 finding。
        """
        try:
            r = self._t.get_item(
                Key={"PK": keys.SCHEDULE_PK, "SK": DIGEST_LEDGER_SK})
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"读摘要账本失败: {e}") from e
        return r.get("Item")

    def mark_digest_sent(self, period: str, sent_date: date) -> None:
        """记下「这一份摘要今天发过了」。`period` ∈ {weekly, monthly}。

        ⚠️ 用 `update_item` 而不是 put：两类摘要同一行不同字段，
        整行覆盖会把另一类的日期抹掉 —— 表现是月度发过之后周度被判成
        「从没发过」，于是每天补发一次周报。
        """
        if period not in ("weekly", "monthly"):
            raise StoreError(f"摘要类型只有 weekly / monthly，收到 {period!r}")
        try:
            self._t.update_item(
                Key={"PK": keys.SCHEDULE_PK, "SK": DIGEST_LEDGER_SK},
                UpdateExpression="SET #p = :d",
                ExpressionAttributeNames={"#p": f"last_{period}"},
                ExpressionAttributeValues={":d": sent_date.isoformat()},
            )
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"记摘要发出日期失败 {period}: {e}") from e

    def load_push_window(self) -> dict[str, Any] | None:
        """读推送时段配置（`inspsched#config` / `SK="push"`）。

        ⚠️ 与 high/idle 同 PK 不同 SK —— 它们是同一类「定时配置」，
        分成两个 PK 会让管理页要读两次，而这两份永远一起显示。
        """
        try:
            r = self._t.get_item(Key={"PK": keys.SCHEDULE_PK, "SK": PUSH_SCHEDULE_SK})
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"读推送时段配置失败: {e}") from e
        return r.get("Item")

    def put_push_window(self, body: Mapping[str, Any]) -> None:
        """写推送时段配置。"""
        item = {**_jsonable(body), "PK": keys.SCHEDULE_PK, "SK": PUSH_SCHEDULE_SK}
        try:
            self._t.put_item(Item=item)
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"写推送时段配置失败: {e}") from e

    def apply_transitions(
        self, account_id: str, transitions: Sequence[Transition], *, today: date,
        evidence: Mapping[str, Mapping[str, Any]] | None = None,
    ) -> int:
        """把 `Transition` 落库。返回实际写入条数。

        ⚠️ R6.8 的条件写：`attribute_not_exists(last_run_date) OR last_run_date < :today`。
        没有它，同一天重投（SQS at-least-once 是**必然**路径）会把状态推进两次 ——
        `consecutive_misses` 从 1 直接跳到 2，于是「缓解观察期」被压缩成一轮，
        R6.3 的 K=2 确认形同虚设。

        `evidence`：`finding_id → 判定证据`（`assemble.to_evidence`）。

        ⚠️ 只有本轮**命中**的 finding 有证据。未命中（走向 resolved）的那些
        没有，它们行里的旧数值会被**清掉**（`REMOVE _EVIDENCE_FIELDS`）。
        这是刻意的而不是漏了：「未命中」意味着水位已经不越线了，留着上一轮
        的「85% / 阈值 70%」比空着更糟 —— 客户会以为现在还是 85%。
        UI 侧的表现是那一行不渲染（`observed_value` 缺键）。

        ## 🔴 为什么是 `update_item` 而不是 `put_item`

        `put_item` 是**整项替换**，而这一行是**两个进程各写一半**的：

        ```
        apply_transitions()   写 state / severity / evidence      每轮 02:00
        attach_judgment()     写 da_task_id / da_verdict /        DA 回调，几分钟后
                                 da_body / da_parse_status
        ```

        用 `put_item` 的后果（2026-08-23 在真实表实测确认）：次日 02:00 那次
        写入把 `da_*` 四个字段**全部清掉** —— `_finding_to_item` 压根不含它们。

        ```
        第 1 天 02:00  put_item      写状态
        第 1 天 02:03  update_item   补判读
        第 2 天 02:00  put_item      条件成立 → 整项替换 → 判读消失
        ```

        代价两层：`try_reuse`（R5.12）永远拿不到 prior，于是每天为同一个形态
        重新买一次 LLM 判读；以及客户在 02:00~02:03 之间看不到昨天的分析，
        若那轮 DA 失败则**彻底丢失**。

        ⚠️ 条件写（R6.8）逐字保留 —— 它挡的是同一天 SQS 重投，与用哪个
        API 无关。
        """
        written = 0
        ev_by_id = evidence or {}
        for t in transitions:
            item = _finding_to_item(account_id, t, today=today,
                                    evidence=ev_by_id.get(t.finding_id))
            key = {"PK": item.pop("PK"), "SK": item.pop("SK")}
            pairs = list(item.items())
            names = {f"#n{i}": k for i, (k, _) in enumerate(pairs)}
            values = {f":v{i}": v for i, (_, v) in enumerate(pairs)}
            expr = "SET " + ", ".join(f"#n{i} = :v{i}" for i in range(len(pairs)))
            # 上一轮的证据要不要清掉 —— 判据是**整快照语义**：
            # resolved 时清全部；本轮**写了任何证据**时清掉本轮快照没覆盖的
            # 那部分；本轮一个证据都没有（CHRONIC 未命中轮）才整套保留。
            #
            # 🔴 第一版是无条件 REMOVE，于是 CHRONIC 被清空（「HIGH · 已持续
            #    14 天」而没有任何数字）。第二版改成「只在 resolved 时清」，
            #    修好了 CHRONIC 却开了一个更隐蔽的洞（2026-09-04 交叉 review
            #    抓到）：**部分证据**的轮次会让新旧两轮的字段混在同一行上，
            #    而 `evidence_as_of` 被盖成今天 ——
            #
            #    ```
            #    ① pricing_table 加载失败 → 本轮没有 savings_usd
            #       → 上一轮的金额留在行上、挂着今天的日期
            #    ② 闸门翻档：上一轮 REUSED（写了 conclusion + skip_reason），
            #       本轮真派了 DA（两个键都不写）
            #       → 残留的 conclusion 让这条显示成「已有结论」，
            #         从「未做根因分析」计数里消失；本轮 BUDGET 时同理 ——
            #         一条因额度没判读的 finding 靠残值伪装成已判
            #    ```
            #
            #    「保留旧证据 + `evidence_as_of` 标注哪天的」这对设计**只在
            #    整快照粒度上成立**：要么整套是本轮的（日期=今天），要么整套
            #    是上次命中的（日期=那天）。字段级混合让日期对不上任何一半。
            #
            #    ```
            #    resolved         → 清全部（水位回健康区，旧数字会被读成现状）
            #    本轮有证据       → REMOVE 快照外字段（行 = 本轮完整快照）
            #    本轮没有证据     → 整套保留（CHRONIC：旧值 + 旧 evidence_as_of
            #                       成对，读侧显示「数据截至 N 天前」）
            #    ```
            #
            # ⚠️ 「本轮写了证据」的判据用 `evidence_as_of in item` ——
            #    `_finding_to_item` 只在 `if evidence:` 分支写它，两处天然同步；
            #    另起一个布尔要在两个函数间传，漂移了就回到字段级混合。
            resolved = item.get("state") == FindingState.RESOLVED.value
            snapshot = "evidence_as_of" in item
            stale = (sorted(_EVIDENCE_FIELDS - set(item))
                     if (resolved or snapshot) else [])
            if stale:
                names.update({f"#r{i}": k for i, k in enumerate(stale)})
                expr += " REMOVE " + ", ".join(f"#r{i}" for i in range(len(stale)))
            values[":today"] = today.isoformat()
            # ── R6.8 同日幂等，但要给 R6.9 的「关闭后新建」留一条门 ──
            #
            # 🔴 `reconcile` 对同一个 `finding_id` 会产出**两条** Transition：
            #    FORCE_RESOLVED 然后 CREATED（`lifecycle.reconcile` 里
            #    `follow_up_for` 追加的那条）。两条走同一个 PK/SK。
            #    第一条把 `last_run_date` 写成今天 → 第二条的
            #    `last_run_date < :today` 判假 → 被当成「同日重投」丢掉，
            #    只留一行 logger.debug。
            #
            #    后果是 finding 行永久停在 `state=resolved`，且下面那段
            #    `REMOVE _EVIDENCE_FIELDS` 把实测值/阈值/金额/idle 因子全清掉。
            #    看板上「风险还在却显示已解决，而且没有任何数字」——
            #    `follow_up_for` 自己的 docstring 逐字写着这就是它要防的事。
            #
            # 所以 CREATED 额外允许一种情形：同一天、但那行现在是 resolved。
            #
            # ⚠️ 这**不会**放开 SQS 同日重投：重投时第一条 FORCE_RESOLVED 的
            #    条件仍然判假（`last_run_date` 已是今天，且它走的是原条件），
            #    而第二条 CREATED 看到的 state 是 `new`（上一次已写进去了）
            #    而不是 `resolved` → 同样判假。两条都跳过，与修复前一致。
            #
            # ⚠️ 判据用 `state` 而不是「这一批里前面写过同 id」：后者要在
            #    循环里维护额外状态，而且对跨消息的情形无效。
            cond = "attribute_not_exists(last_run_date) OR last_run_date < :today"
            if t.kind is TransitionKind.CREATED:
                cond = f"({cond}) OR #st_g = :resolved_g"
                names["#st_g"] = "state"
                values[":resolved_g"] = FindingState.RESOLVED.value
            try:
                self._t.update_item(
                    Key=key,
                    UpdateExpression=expr,
                    ConditionExpression=cond,
                    ExpressionAttributeNames=names,
                    ExpressionAttributeValues=values,
                )
                written += 1
            except ClientError as e:
                if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                    # 同一天已经写过 —— 幂等，不是错误。
                    logger.debug("finding 今日已写过，跳过: %s", t.finding_id)
                    continue
                raise StoreError(f"写 finding 失败 {t.finding_id}: {e}") from e
            except BotoCoreError as e:
                raise StoreError(f"写 finding 失败 {t.finding_id}: {e}") from e
        return written

    # ── 配置版本（R13.4）─────────────────────────────────────────────

    def put_config_version(
        self, service: str, rule_type: str, config: Mapping[str, Any],
        *, changed_by: str, now: datetime,
    ) -> str:
        """append-only 写一个配置版本，返回版本号（ISO 时间戳）。

        ⚠️ **不覆盖历史版本**。历史行服务两件事：审计「当天为什么这么判」、
        UI 在历史曲线上画当时的阈值线（出现台阶是正确呈现，不是 bug）。

        ## 🔴 内容没变就复用既有版本号 —— 不是优化，是 R6.9 的正确性前提

        版本号被 executor 直接当成 `rule_version`
        （`lambda_inspection_executor/handler.py:936`），而 `lifecycle` 的 R6.9
        判据是 ``rec.rule_version != rule_version`` → **强制 resolve 全部
        finding 并新建**。

        `snapshot_config` 每一轮官方巡检都无条件调这个方法。所以只要版本号每次
        都是新的（`now.isoformat()` 必然如此），R6.9 就**每轮都触发**：

        ```
        days_active        永远 1      「已持续 N 天」全线失效
        consecutive_hits   永远 1      慢性高位 / K=2 确认永不成立
                                       chronic_days_min 与 chronic_min_coverage
                                       两个可配字段成为死值
        每条 finding       每天带 note=rule-version-changed-…
        推送退避           每条都当「第一次见」
        ```

        2026-08-26 线上实测（`cfgver#inspection#high`）：**63 个版本号，只有 6
        份不同的配置内容** —— 57 次「规则变更」对应零改动。

        ⚠️ 这是同一个缺陷的第三次形态，前两次都在这个文件里留了注释：

        ```
        ① _stable_hash 的 docstring：用内置 hash() 会因 PYTHONHASHSEED
           随机化「每次部署都检测到配置变更」→ 换成 sha256 修掉
        ② snapshot_config 的 docstring：config_version 内联时返回空串
           → R6.9 第一个条件恒假 → 永不触发 → 改成恒有值修掉
        ③ 现在：恒有值但**每次都不同** → 从「永不触发」翻成「每轮都触发」
        ```

        ②的修法只保证了「非空」，没保证「同内容同值」。这里补上后者。

        ⚠️ 只跟**最新**那一行比。配置 A→B→A 时最新是 B，哈希不同，于是给 A 写
        一个新版本号 —— 那是对的，规则**确实**变过一次。
        """
        version = now.isoformat()
        # 🔴 **不要** `json.dumps(_jsonable(config))`：`_jsonable` 把 float 转成
        #    Decimal（那是 `put_item` 要的形状），而 json 不认识 Decimal ——
        #    于是任何含浮点阈值的配置都写不进来。见 `_json_default` 的说明。
        body = json.dumps(config, sort_keys=True, ensure_ascii=False,
                          default=_json_default)
        # 🔴 哈希算的是**规范化**形式，不是上面 `body` —— 见 `canonical_config_json`。
        digest = _stable_hash(canonical_config_json(config))
        # ── 内容没变 → 复用既有版本号（见上面 docstring）──
        #
        # ⚠️ 读失败**不当成「没变」**。那会在限流/无权时写出一个新版本号，
        #    于是恰好在故障期间把全部 finding 强制 resolve 一遍。读不到就
        #    往下走正常的写入路径 —— 多一个版本号是噪音，错误的 resolve
        #    是数据损坏。两害取轻。
        #
        # 🔴 比 `config_hash` 而不是 `config_json`：后者是 `json.dumps` 的
        #    输出，Python 与 BFF 的分隔符/浮点格式不同（`70.0` vs `70`），
        #    直接比字符串会在两侧写的行之间永远判不等。
        try:
            latest = self.get_config_version(service, rule_type)
        except StoreError:
            latest = None
        if latest and latest.get("config_hash") == digest:
            prior = str(latest.get("SK") or "")
            if prior:
                logger.debug("配置内容未变，复用版本 %s（service=%s rule=%s）",
                             prior, service, rule_type)
                return prior
        item = {
            "PK": keys.config_version_pk(service, rule_type),
            "SK": version,
            "service": service,
            "rule_type": rule_type,
            "config_json": body,
            "config_hash": digest,
            "changed_by": changed_by,
        }
        try:
            self._t.put_item(Item=item, ConditionExpression="attribute_not_exists(SK)")
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise StoreError(
                    f"配置版本 {version} 已存在 —— append-only 表不允许覆盖"
                ) from e
            raise StoreError(f"写配置版本失败: {e}") from e
        except BotoCoreError as e:
            raise StoreError(f"写配置版本失败: {e}") from e
        return version

    def get_config_version(
        self, service: str, rule_type: str, version: str = ""
    ) -> dict[str, Any] | None:
        """读配置版本。`version` 为空 → 读最新（SK 倒序第一条）。"""
        pk = keys.config_version_pk(service, rule_type)
        if version:
            try:
                r = self._t.get_item(Key={"PK": pk, "SK": version})
            except (ClientError, BotoCoreError) as e:
                raise StoreError(f"读配置版本失败: {e}") from e
            return r.get("Item")
        kw = {
            "KeyConditionExpression": "#pk = :pk",
            "ExpressionAttributeNames": {"#pk": "PK"},
            "ExpressionAttributeValues": {":pk": pk},
            "ScanIndexForward": False,
            "Limit": 1,
        }
        items = list(self._paginate("query", kw, stop_after=1))
        return items[0] if items else None

    # ── run 锁与 run 记录（R13.2 / R9.2）─────────────

    def try_acquire_run_lock(
        self, run_type: str, run_date: date, account_id: str, *,
        owner: str = "", now: datetime | None = None,
        ttl_hours: int = RUN_LOCK_TTL_HOURS,
    ) -> bool:
        """抢一天一个账号的 run 锁。抢到返回 `True`，已被占返回 `False`。

        ⚠️ **锁必须靠 `ConditionExpression` 而不是「先读再写」。**
        调度器的 15 分钟 tick 与 SQS 的 at-least-once 会让同一
        `(run_type, run_date, account_id)` 在几毫秒内并发进来；
        read-then-write 之间的窗口足够两个都读到「没锁」，于是同一天巡检跑两遍
        —— 表现是 DA 额度翻倍消耗，**不报错**。

        条件有三段，各对应一个必须放行的场景：

        ```
        attribute_not_exists(PK)           今天还没跑过        → 抢
        #s = :failed                       上次失败            → 允许重试
        #s = :running AND #lock < :now     崩在中途且已超时    → 允许接手
        #s = :running AND 无 #lock
                       AND #ttl < :now     升级前的旧行        → 允许接手
        ```

        🔴 判据是 **`lock_until`，不是 `ttl`**。`ttl` 是本表的 DDB TTL 属性，
        把 6 小时写进去等于让整行 6 小时后被真删（见 `RUN_TTL_DAYS`）。
        第四段只为**升级前写下的旧行**存在：它们没有 `lock_until`，
        而 `#lock < :now` 对缺失属性恒假 —— 少了这段那些行永远抢不动。

        ⚠️ 只写 `attribute_not_exists(PK)` 会让**崩在中途的 run 永久占锁**：
        Lambda 超时/OOM 时 `finish_run` 不会执行，行就一直是 `running`。
        DynamoDB 的 TTL 删除是最长 48 小时的后台过程，不是到点即删，
        所以「等 TTL 把行删掉」不是可用的释放路径 —— 必须让条件自己判过期。

        ⚠️ 反过来，`completed` / `partial` **不放行**。写成
        `attribute_not_exists(#ttl) OR #ttl < :now` 会让已成功的那天在 6 小时后
        重新可抢 —— 那时 `due_runs()` 的 `completed` 判据一旦失灵（读表失败、
        参数漏传），就会把同一天重跑一遍，而两道防线本该是独立的。
        """
        now = now or datetime.now(timezone.utc)
        epoch = int(now.timestamp())
        try:
            self._t.put_item(
                Item={
                    "PK": keys.run_pk(run_type, run_date),
                    "SK": account_id,
                    "run_type": run_type,
                    "run_date": run_date.isoformat(),
                    "account_id": account_id,
                    "status": RUN_STATUS_RUNNING,
                    "started_at": now.isoformat(),
                    "owner": owner,
                    # 锁超时判据（短）与行保留期（长）是两个字段。合成一个的
                    # 后果见 RUN_TTL_DAYS —— 整行 6 小时后被 DDB 真删。
                    "lock_until": epoch + ttl_hours * 3600,
                    "ttl": _ttl_epoch(run_date, RUN_TTL_DAYS),
                },
                ConditionExpression=(
                    "attribute_not_exists(PK)"
                    " OR #s = :failed"
                    " OR (#s = :running AND #lock < :now)"
                    # 升级前的旧行只有 ttl 没有 lock_until。
                    " OR (#s = :running AND attribute_not_exists(#lock)"
                    " AND #ttl < :now)"
                ),
                ExpressionAttributeNames={
                    "#s": "status", "#ttl": "ttl", "#lock": "lock_until"},
                ExpressionAttributeValues={
                    ":failed": RUN_STATUS_FAILED,
                    ":running": RUN_STATUS_RUNNING,
                    ":now": epoch,
                },
            )
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return False
            raise StoreError(f"抢 run 锁失败: {e}") from e
        except BotoCoreError as e:
            raise StoreError(f"抢 run 锁失败: {e}") from e
        return True

    def finish_run(
        self, *, run_type: str, run_date: date, account_id: str,
        status: str, now: datetime, stats: Mapping[str, Any] | None = None,
        error: str = "",
    ) -> None:
        """收尾 run 记录（R9.2）。

        ⚠️ **无条件 update，不带 `status = running` 的条件。** 失败路径也要能落
        `status=failed` —— 带条件会让「锁已被 TTL 清掉之后才失败」的那次
        连失败都记不下来，看板上表现为这一天根本没跑过（R9.11 的空洞）。
        """
        names = {"#s": "status"}
        values: dict[str, Any] = {":s": status, ":f": now.isoformat()}
        sets = ["#s = :s", "finished_at = :f"]
        if stats:
            names["#st"] = "stats"
            values[":st"] = _jsonable(dict(stats))
            sets.append("#st = :st")
        if error:
            # 🔴 `error` 是 DynamoDB **保留字**，裸写进 UpdateExpression 会
            #    `ValidationException: Attribute name is a reserved keyword`。
            #    同一函数里 status / stats 都做了别名，只有这一支漏了 ——
            #    而它**只在失败路径上执行**，所以成功路径的测试永远碰不到。
            #
            #    后果不是「少记一个字段」，是**收尾整体崩掉**：调用方
            #    （scheduler 的投递失败分支）拿到 StoreError → run 行永远停在
            #    `status=running` → 锁被永久占死 → 之后每一轮都「已有 run 在跑，
            #    跳过」，而看板显示「本轮未发现风险」。
            #    东京实测：两个 run 卡了 4 小时，零 finding，零指标批次。
            names["#e"] = "error"
            values[":e"] = error[:1024]
            sets.append("#e = :e")
        try:
            self._t.update_item(
                Key={"PK": keys.run_pk(run_type, run_date), "SK": account_id},
                UpdateExpression="SET " + ", ".join(sets),
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"收尾 run 记录失败: {e}") from e

    def runs_for(self, run_type: str, run_date: date) -> dict[str, dict[str, Any]]:
        """某天某类型的全部 run 行，按 `account_id` 索引（对账用）。

        ⚠️ 与 `completed_runs()` 的区别是**保留整行**。那个函数只回 status
        字符串，把 `stats` 丢了 —— 而完整度判定要读 `stats.completeness` /
        `stats.expected` / `stats.dry_run`。用它会让对账只能判「缺行」，
        判不了「跑了但没跑全」，而后者才是常见的那一种。
        """
        out: dict[str, dict[str, Any]] = {}
        for item in self._list_by_prefix(keys.run_pk(run_type, run_date)):
            acct = str(item.get("account_id") or item.get("SK") or "")
            if acct:
                out[acct] = dict(item)
        return out

    def completed_runs(
        self, *, run_type: str, run_date: date,
    ) -> dict[tuple[str, str, date], str]:
        """读某天某类型已存在的 run，组装成 `due_runs()` 的 `completed` 入参。

        ⚠️ 把 `running` 也算「已存在」。只查 `completed` 会让正在跑的 run
        在下一个 tick 被重新判定为 due —— 虽然会被锁拦下，但 run 记录的
        `started_at` 会被后到的那次覆盖，排障时看到的开始时间是错的。
        """
        pk = keys.run_pk(run_type, run_date)
        out: dict[tuple[str, str, date], str] = {}
        for item in self._list_by_prefix(pk):
            acct = str(item.get("account_id") or item.get("SK") or "")
            if acct:
                out[(run_type, acct, run_date)] = str(item.get("status") or "")
        return out

    # ── 调度器要读的几份配置───────────────────────

    def load_schedules(self) -> list[ScheduleConfig]:
        """读两类巡检的定时配置（R11.1：按类型全局配置，不按账号）。

        ⚠️ **读不到就用默认值，不是「不跑」。** 全新部署的表是空的；
        返回空列表会让系统装好之后一条都不跑，而客户看不到任何错误
        —— 只会以为「巡检要等一天」，等到第二天还是没有。
        """
        out: list[ScheduleConfig] = []
        for run_type in RunType:
            item = None
            try:
                r = self._t.get_item(Key={"PK": keys.SCHEDULE_PK,
                                          "SK": run_type.value})
                item = r.get("Item")
            except (ClientError, BotoCoreError) as e:
                raise StoreError(f"读定时配置失败: {e}") from e
            out.append(_schedule_from_item(run_type, item))
        return out

    def put_schedule(self, cfg: ScheduleConfig) -> None:
        """写一类巡检的定时配置。

        ⚠️ `at_utc` 的分钟数必须是 tick 周期的整数倍。填 `02:07` 会得到一个
        **永远不被精确命中**的配置 —— 它只能靠 `catch_up` 在 02:15 被补跑，
        表现为「报告总是慢 8 分钟」而不是报错。UI 侧也要限制，这里兜底。
        """
        if cfg.at_utc.minute % TICK_MINUTES:
            raise StoreError(
                f"at_utc={cfg.at_utc} 的分钟数不是 {TICK_MINUTES} 的整数倍 —— "
                "调度粒度等于 EventBridge Rule 周期，这个时刻永远不会被精确命中"
            )
        item: dict[str, Any] = {
            "PK": keys.SCHEDULE_PK,
            "SK": cfg.run_type.value,
            "enabled": cfg.enabled,
            "at_utc": cfg.at_utc.isoformat(timespec="minutes"),
            "catch_up_hours": cfg.catch_up_hours,
        }
        if cfg.weekdays is not None:
            item["weekdays"] = sorted(cfg.weekdays)
        try:
            self._t.put_item(Item=item)
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"写定时配置失败: {e}") from e

    def load_rule_config(self, run_type: str) -> dict[str, Any]:
        """读某类巡检的判定规则配置（阈值等），用于快照。

        ⚠️ 读不到返回**空 dict 而不是抛错**：空配置意味着各规则用自己的默认值，
        那是可用的初始状态。抛错会让新部署的第一轮直接失败。
        """
        latest = self.get_config_version("inspection", run_type)
        if not latest:
            return {}
        try:
            return json.loads(str(latest.get("config_json") or "{}"))
        except json.JSONDecodeError:
            logger.warning("config_json 解析失败，按空配置处理: %s", run_type)
            return {}

    def list_awaiting_judgment(self, account_id: str) -> list[dict[str, Any]]:
        """列出「已派发但判读还没回来」的 finding 行（对账用）。

        判据是 `da_task_id` 存在而 `da_updated_at` 不存在：
        `attach_judgment` 无论成功还是解析失败都会写 `da_updated_at`，
        所以它的存在就等于「结论（或结论的失败）已经落库」。

        ⚠️ 用 `da_updated_at` 而**不是** `da_body`：解析失败时 body 存的是原文，
        而 `parse_failed` 那种情况已经有结论了（原文 + 状态），不该再去对账 ——
        对账只该管「什么都没回来」的那些。用 body 判会让每轮都去 probe 一批
        已经处理过的 task，白花 `GetBacklogTask` 调用。

        ⚠️ **Query 不是 Scan**：finding 行按账号分区（`inspfind#<account>`），
        所以这是一次分区内查询。Scan 会随表增长线性变慢，而对账每小时跑一次。

        ⚠️ 带 `ProjectionExpression` 只取三个字段。取全行会把判读全文
        （1~3KB/条）也读回来，而对账压根不看它 —— 那是纯粹的 RCU 浪费。
        """
        acct = (account_id or "").strip()
        if not acct:
            return []
        kw = {
            "KeyConditionExpression": "#pk = :pk",
            # `da_task_id` 与 `da_updated_at` 都不是保留字，但 `#pk` 是必须的，
            # 而混用 names 与字面量容易漏 —— 统一走 names。
            "FilterExpression": (
                "attribute_exists(#tid) AND attribute_not_exists(#upd)"
            ),
            "ProjectionExpression": "#fid, #tid, #st",
            "ExpressionAttributeNames": {
                "#pk": "PK",
                "#tid": "da_task_id",
                "#upd": "da_updated_at",
                "#fid": "finding_id",
                "#st": "state",
            },
            "ExpressionAttributeValues": {":pk": keys.finding_pk(acct)},
        }
        return list(self._paginate("query", kw))

    def mark_judge_dispatched(
        self, account_id: str, finding_id: str, *, task_id: str,
    ) -> bool:
        """派发**成功那一刻**就把 `da_task_id` 落到 finding 行上。

        Returns:
            写成功 `True`；行不存在时 `False`（**不建行**）。

        ## 🔴 为什么必须有这个方法（2026-08-31 实机暴露）

        `da_task_id` 原本**只在 DA 回调回来时**由 `attach_judgment()` 写 ——
        也就是派发之后的 **1~3 分钟**里，finding 行上根本没有它。而那个字段
        同时是两处「已经派过了」的判据：

        ```
        前端  FindingCard / 详情面板  `!f.da_task_id` → 决定按钮渲不渲染
        后端  manual_judge.load_finding  `da_task_id` 非空 → 拒绝重复派发
        ```

        两处在窗口期内**都失效**。表现（客户实测）：点完「深入分析」拿到
        「判读已派发」，再点开那条 finding，按钮还在、还能点 —— 点第二次会派
        **第二个** task，两份判读回填到同一行互相覆盖，而额度花了两次。

        ⚠️ 写 `da_task_id` 而**不是**另起一个 `pending_task_id`：那两处判据读的
        就是这一个字段，另起一个意味着同一件事有两个来源，而 UI 只读一个
        （`devops_agent_callback` 的注释里写过同一句话）。语义上也对得上 ——
        它的含义是「这条 finding 派给了哪个 task」，与「判读回来了没有」是
        两件事（后者看 `da_body` / `da_updated_at`）。

        ⚠️ **不写 `da_updated_at`**。`store` 里有一处判据是「`da_task_id` 存在
        而 `da_updated_at` 不存在 = 派了但还没回来」——那正是这个方法要造出的
        状态。写了它会让对账把一条还在跑的 task 当成已完成。
        """
        try:
            self._t.update_item(
                Key={"PK": keys.finding_pk(account_id), "SK": finding_id},
                UpdateExpression="SET da_task_id = :t",
                ConditionExpression="attribute_exists(PK)",
                ExpressionAttributeValues={":t": task_id},
            )
            return True
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") \
                    == "ConditionalCheckFailedException":
                return False
            raise StoreError(f"标记判读已派发失败: {e}") from e
        except BotoCoreError as e:
            raise StoreError(f"标记判读已派发失败: {e}") from e

    def attach_judgment(
        self,
        account_id: str,
        finding_id: str,
        *,
        task_id: str,
        verdict: str = "",
        body: str = "",
        parse_status: str = "",
        report_md_key: str = "",
        now_epoch: int | None = None,
        gate_trustworthy: bool | None = None,
        degradations: Sequence[str] | None = None,
        skills_loaded: Sequence[str] | None = None,
    ) -> bool:
        """把 DA 的判读文本挂到 finding 行上（7.10b / R9.6）。

        Returns:
            写成功 `True`；那条 finding 行不存在时返回 `False`（**不建行**）。

        ⚠️ 用 `update_item` + `attribute_exists(PK)` 而不是 `put_item`：
        put 会把状态机字段（`state` / `first_seen_date` / `consecutive_hits` /
        `was_confirmed`）整条覆盖掉。callback 与巡检轮是**两个不同的 Lambda、
        不同的时刻**，callback 手里没有那些值 —— 覆盖等于把状态机清零，
        表现是每条 finding 每天都是 `new`，`days_active` 永远是 1，
        R6.5 的「已持续 N 天」永久失效。

        ⚠️ 行不存在时**不建行**。callback 可能比巡检轮的落库晚到，也可能
        对应一条已经 resolved 被清掉的 finding。建一条只有判读没有状态的行，
        会让 `load_findings()` 下一轮读到一个 `state` 缺失的记录。
        返回 False 让调用方记日志，不静默。

        ⚠️ **不截断 `body`**。判读文本是花 DA 额度换来的唯一产物；
        截断会把最后一条建议砍掉一半，而报告看起来是完整的。
        单条 finding 的判读远小于 DDB 的 400KB 行上限（实测判读全文
        约 1~3KB/条），真正需要防的是 `CreateBacklogTask.description`
        那一侧，而那一侧有独立的 10000 字符校验。

        ## 7.9a skill 门禁的结论（D22，2026-09-03）

        `gate_trustworthy` / `degradations` / `skills_loaded` 三个参数搭在
        **同一次 UpdateItem** 上，而不是另起一个方法。

        🔴 一个 callback 覆盖**最多 6 条** finding（`payload.pack_payloads`
        的 `max_per_task=6`），`apply_judgment` 本来就对每条调一次本方法 ——
        另起 `attach_gate_verdict` 意味着每个 callback 多最多 6 次写，而且
        可能半途失败，留下「有判读、没有判读质量」的行。搭在一起则判读与
        判读质量原子落库。

        🔴 门禁结论是**逐 task** 算的，所以同一个 task 下 6 条 finding 拿到的
        是同一份结论 —— 这是对的：skill 有没有加载是整次调查的属性，不是
        某一条 finding 的属性。只挂第一条会让其余 5 条显示成「未知」。

        ⚠️ 三个参数**都用 `None` 表示「门禁没跑」**，见下面赋值处的长注释。
        """
        if not finding_id:
            return False
        expr = {
            "da_task_id": task_id,
            "da_verdict": verdict,
            "da_body": body,
            "da_parse_status": parse_status,
            "da_updated_at": _now_epoch() if now_epoch is None else now_epoch,
        }
        if report_md_key:
            expr["da_report_md_key"] = report_md_key
        # 空值不写：写空串会让「DA 没给 verdict」与「verdict 是空」长得一样。
        expr = {k: v for k, v in expr.items() if v not in ("", None)}
        # ── 7.9a skill 门禁的结论（D22）────────────────────────────────────
        #
        # 🔴 **`None` 与「空列表」是两件事，这里的全部难点就在这。**
        #
        #   ```
        #   None        门禁**没跑**（老派发行没 run_type / 门禁自己抛了）
        #               → 一个键都不写。「属性缺失」= 未知，与仓库既有约定
        #                 一致（`num()` absent→null、`_finding_to_item`
        #                 「不补 None 不补 0」）。
        #   ()  / []    门禁跑了、**一条降级都没有**
        #               → 要写，写成空 list。这是「干净」的**正面证据**，
        #                 与「不知道」必须可区分。
        #   ```
        #
        #   不区分的后果是制造**假清白**：`_evaluate_gate` 在那三条路径上返回
        #   `{}`，`ApplyOutcome` 于是落回默认 `journal_trustworthy=True` +
        #   `degradations=()` —— 把它当成「跑过且干净」写进库，看板就会对着
        #   一条根本没验过的判读显示「方法论已生效」。
        #
        # ⚠️ **刻意不复用上面那个 `v not in ("", None)` 过滤器。**
        #    它对 bool 与空容器的语义脉络不清：`False not in ("", None)` 为真
        #    （侥幸对了），而 `()` 也为真（这里恰好要的）—— 但两者都是靠
        #    `==` 的偶然结果，而不是靠「我要区分 None」这个意图。
        #    改天有人往那个 tuple 里加个 `0` 或 `False`，`gate_trustworthy=False`
        #    就会静默不写，表现是**不可信的判读在看板上显示为未知**。
        #    所以这里用显式的 `is not None`。
        if gate_trustworthy is not None:
            expr["da_gate_trustworthy"] = bool(gate_trustworthy)
        if degradations is not None:
            expr["da_degradations"] = [str(d) for d in degradations]
        if skills_loaded is not None:
            expr["da_skills_loaded"] = [str(s) for s in skills_loaded]
        names = {f"#{i}": k for i, k in enumerate(expr)}
        values = {f":{i}": v for i, (_, v) in enumerate(expr.items())}
        sets = ", ".join(f"#{i} = :{i}" for i in range(len(expr)))
        try:
            self._t.update_item(
                Key={"PK": keys.finding_pk(account_id), "SK": finding_id},
                UpdateExpression="SET " + sets,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ConditionExpression="attribute_exists(PK)",
            )
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                logger.warning(
                    "finding 行不存在，判读未挂上（不建行）: account=%s finding=%s",
                    account_id, finding_id)
                return False
            raise StoreError(f"挂判读失败 {finding_id}: {e}") from e
        except BotoCoreError as e:
            raise StoreError(f"挂判读失败 {finding_id}: {e}") from e
        return True

    # ── 派发映射（task_id → finding_ids）─────────────────────────────────

    def put_dispatch(
        self,
        task_id: str,
        *,
        account_id: str,
        run_id: str,
        run_type: str,
        data_date: date,
        finding_ids: Sequence[str],
        agent_space_id: str = "",
        client_token: str = "",
        is_heartbeat: bool = False,
    ) -> None:
        """记下「这个 task 装了哪些 finding」（7.4b / R5.5a）。

        ⚠️ 这是**回拼的唯一锚点**。callback 事件里只有 `task_id`，而一个 task
        因装箱（R5.4）可能含最多 6 条 finding。没有这一行，判读文本就只能
        整段挂在 task 上 —— 报告里有一大段分析，而每条 finding 旁边是空的。

        ⚠️ **派发成功之后**才写。写在调用 API 之前会在 API 失败时留下一条
        指向不存在 task 的映射，而对账逻辑会拿它去 `GetBacklogTask` 查，
        得到 404 之后无从判断「是事件丢了」还是「task 压根没建成」。

        ⚠️ 带 TTL：映射只在「等 callback 回来」这段窗口里有用。
        不设 TTL 会让这张表随时间无界增长（每天每账号 6 条 × 无限天），
        而它的读取模式是「按 task_id 点查」——增长不影响性能但影响成本。
        """
        item: dict[str, Any] = {
            "PK": keys.dispatch_pk(task_id),
            "SK": keys.DISPATCH_SK,
            "task_id": task_id,
            "account_id": account_id,
            "run_id": run_id,
            "run_type": run_type,
            "data_date": data_date.isoformat(),
            # ⚠️ list 而不是 set：DDB 的 SS 类型不保序，而 finding 的顺序
            #    决定报告里各节的顺序（DA 按 finding_id 分节输出，我们按
            #    严重度排过序）。用 set 会让报告每天顺序随机。
            "finding_ids": list(finding_ids),
            "finding_count": len(finding_ids),
            "is_heartbeat": is_heartbeat,
            "dispatched_at": _now_epoch(),
            "ttl": _ttl_epoch(data_date, DISPATCH_TTL_DAYS),
        }
        if agent_space_id:
            item["agent_space_id"] = agent_space_id
        if client_token:
            item["client_token"] = client_token
        try:
            self._t.put_item(Item=item)
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"写派发映射失败 task_id={task_id}: {e}") from e

    def get_dispatch(self, task_id: str) -> dict[str, Any] | None:
        """按 `task_id` 读回派发映射。找不到返回 `None`。

        ⚠️ 找不到是**正常路径**，不是错误：客户在 webchat 里手点的深度调查
        也会走同一个 callback，那些 task 当然没有巡检派发行。
        抛异常会让排障链路的 callback 全部进 DLQ。
        """
        tid = (task_id or "").strip()
        if not tid:
            return None
        try:
            r = self._t.get_item(
                Key={"PK": keys.dispatch_pk(tid), "SK": keys.DISPATCH_SK})
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"读派发映射失败 task_id={tid}: {e}") from e
        item = r.get("Item")
        if item is None:
            return None
        out = dict(item)
        # DDB 取回来的数字是 Decimal，调用方拿它做 range/比较会炸。
        for k in ("finding_count", "dispatched_at", "ttl"):
            if k in out:
                out[k] = int(out[k])
        return out

    def mark_data_batch(self, account_id: str, data_date: date) -> None:
        """记一条「这个账号在这天有可复用的序列数据」（R11.4a 的写侧）。

        ⚠️ **必须有这张索引。** 序列行的 PK 是
        `inspseries#<acct>#<region>#<service>#<instance>`，date 在 SK 里 ——
        想问「这个账号有哪些天的数据」得跨全部实例 PK 扫，那是 Scan。
        执行 Lambda 写完序列后打这一条标记，`reuse` 就是一次 query。
        """
        try:
            self._t.put_item(Item={
                "PK": keys.data_batch_pk(account_id),
                "SK": data_date.isoformat(),
                "account_id": account_id,
                "data_date": data_date.isoformat(),
                "ttl": _ttl_epoch(data_date),
            })
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"写数据批次标记失败: {e}") from e

    def available_data_dates(self, account_id: str) -> list[date]:
        """该账号有哪些天的序列数据可复用（R11.4a 的输入）。

        ⚠️ 返回的是**真实存在的日期**，不是「最近 7 天」。
        `resolve_reuse_date()` 靠它区分「有但太旧」与「压根没有」，
        后者要明确失败、不静默降级成 refetch（R11.4b）。

        ⚠️ 过滤已过期的 TTL 行：DynamoDB 的 TTL 删除是最长 48 小时的后台过程，
        读到早该消失的日期会让 `reuse` 指向一批已被删掉的序列 ——
        那时执行侧拿到空数据，表现是「报告里所有实例都 INSUFFICIENT_DATA」。
        """
        now = _now_epoch()
        seen: set[date] = set()
        for item in self._list_by_prefix(keys.data_batch_pk(account_id)):
            ttl = item.get("ttl")
            if ttl is not None and int(ttl) <= now:
                continue
            raw = item.get("data_date") or item.get("SK")
            try:
                seen.add(date.fromisoformat(str(raw)))
            except (ValueError, TypeError):
                continue
        return sorted(seen, reverse=True)

    # ── 排除清单 / 巡检范围（4.5a）────────────────────────────────────

    def list_exclusions(self, kind: str) -> list[dict[str, Any]]:
        """读一份排除清单（`high` / `idle`）。

        ⚠️ **到期的行也读回来。** 设计：「到期保留记录但不生效」——
        失效判定在 `domain/scope.py`，这里不做。在这里过滤会让
        「为什么这台又开始被巡检了」查不到那条已到期的记录。
        """
        return self._list_by_prefix(keys.scope_pk(kind))

    def list_targets(self, kind: str) -> list[dict[str, Any]]:
        """读一份巡检范围。存的是 ID，不是展开结果 —— 展开在判定时做。"""
        return self._list_by_prefix(keys.target_pk(kind))

    def list_chat_targets(self) -> list[dict[str, Any]]:
        """读全部推送投递目标（`inspchat#target`，R11b.2）。

        ⚠️ **停用的行也读回来** —— `enabled` 的判定在
        `domain/targets.resolve_inspection_targets()`。在这里过滤会让
        「为什么这个群没收到」查不出「因为有人把它停用了」，
        而那正是最常见的那个原因。
        """
        return self._list_by_prefix(keys.chat_pk())

    def put_chat_target(self, item: Mapping[str, Any]) -> None:
        """写一条投递目标。

        ⚠️ `platform` 与 `chat_id` **都不能省**（`keys.chat_sk()` 会抛）：
        少了任何一个，这一行的 SK 就不是 `<platform>#<chat_id>`，
        于是它既投不出去、也不会在管理页上与真正的目标并列显示 ——
        表现是「保存成功了但那个群永远收不到」。
        """
        platform = str(item.get("platform") or "").strip().lower()
        chat_id = str(item.get("chat_id") or "").strip()
        try:
            sk = keys.chat_sk(platform, chat_id)
        except ValueError as e:
            raise StoreError(f"写投递目标失败: {e}") from e
        body = {**_jsonable(item), "PK": keys.chat_pk(), "SK": sk,
                "platform": platform, "chat_id": chat_id}
        try:
            self._t.put_item(Item=body)
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"写投递目标失败: {e}") from e

    def put_exclusion(self, kind: str, item: Mapping[str, Any]) -> None:
        """写一条排除。

        ⚠️ `level` 字段**不能省**（明写）：「勾中集群即排除其下全部成员」
        靠它判。少了它级联排除会**静默失效** —— UI 上集群明明是勾选状态，
        成员却照样出现在结果里，而系统不报任何错。
        """
        if not str(item.get("level", "")).strip():
            raise StoreError(
                "排除清单条目缺 level —— 级联排除靠它判，缺了会静默失效"
                "（UI 显示已排除，成员照样出现在结果里）"
            )
        body = {**_jsonable(item), "PK": keys.scope_pk(kind)}
        body.setdefault("SK", keys.resource_sk(
            str(item.get("account_id", "")), str(item.get("region", "")),
            str(item.get("service", "")), str(item.get("resource_id", "")),
        ))
        try:
            self._t.put_item(Item=body)
        except (ClientError, BotoCoreError) as e:
            raise StoreError(f"写排除清单失败: {e}") from e

    # ── 内部 ───────────────────────────────────────────────────────────

    def _list_by_prefix(self, pk: str) -> list[dict[str, Any]]:
        kw = {
            "KeyConditionExpression": "#pk = :pk",
            "ExpressionAttributeNames": {"#pk": "PK"},
            "ExpressionAttributeValues": {":pk": pk},
        }
        return list(self._paginate("query", kw))

    def _paginate(
        self, op: str, kw: Mapping[str, Any], *, stop_after: int | None = None
    ) -> Iterator[dict[str, Any]]:
        """手动分页。

        ⚠️ **必须分页。** DDB 单次 Query 上限 1MB —— 一个账号几千条 finding
        很容易超过。不分页的表现是「只处理了前面一部分」，而 R6.2 的评估集合
        少了后面那些 → 它们的 finding 状态原地不动 → 看板上的数字冻住，
        且不报错。
        """
        params = dict(kw)
        seen = 0
        while True:
            try:
                resp = getattr(self._t, op)(**params)
            except (ClientError, BotoCoreError) as e:
                raise StoreError(f"{op} 失败: {e}") from e
            for it in resp.get("Items", []):
                yield it
                seen += 1
                if stop_after is not None and seen >= stop_after:
                    return
            token = resp.get("LastEvaluatedKey")
            if not token:
                return
            params["ExclusiveStartKey"] = token


# ---------------------------------------------------------------------------
# finding ↔ item
# ---------------------------------------------------------------------------


_EVIDENCE_FORBIDDEN: frozenset[str] = frozenset({
    # 键位
    "PK", "SK",
    # 身份
    "finding_id", "account_id", "region", "service", "instance_id", "rule", "metric",
    # 状态机的结论 —— 这些只能由 `Transition` 决定
    "state", "severity", "prev_severity", "transition_kind", "resolution_kind",
    "first_seen_date", "last_run_date", "last_evaluated_date",
    "consecutive_hits", "consecutive_misses", "was_confirmed", "days_active",
    "rule_version",
})
"""`evidence` **不得覆盖**的字段。见 `_finding_to_item` 里的说明。"""

_EVIDENCE_FIELDS: frozenset[str] = frozenset({
    # `assemble._EVIDENCE_NUMERIC`
    "value", "threshold", "headroom", "raw_value", "denominator",
    # 方向 / 单位 / 金额
    "direction", "unit", "savings_usd", "savings_precision",
    # 形态哈希（R5.12 复用判据）。⚠️ 它在这份清单里意味着**未命中时会被
    # 一起清掉** —— 那是刻意的：水位回到健康区后再次出现应当重新判读。
    "shape",
    # 闲置评分因子（`assemble._idle_evidence`）。
    # ⚠️ `idle_factors` 是 list of map，`idle_degraded` 是 list of str ——
    #    REMOVE 不看类型，但**必须在清单里**：一台机器从「闲置」变回
    #    「在用」之后，若上一轮的 `idle_factors` 留着，看板上会挂着
    #    「CPU 均值 2.1%」而它现在跑到了 60%。
    "idle_score", "idle_weight_avail", "idle_degraded", "idle_factors",
    # 规格（`db.t4g.micro` / `cache.r7g.large` / `db.serverless`）。
    # ⚠️ 进这个集合意味着 resolved 时会被 REMOVE —— 那是对的：规格是「当时
    #    那台机器的规格」，客户降配之后旧值会误导（而降配正是闲置条目的处置）。
    "instance_class",
    # 证据的数据日期。⚠️ 必须和证据字段**一起**清 —— 留一个孤立的
    # `evidence_as_of` 会让读侧算出「数据截至 N 天前」而旁边没有任何数字。
    "evidence_as_of",
    # 确定性结论与跳过原因（2026-08-31）。闲置轮不派 DA，但它**有结论**
    # （`gating.decide` 的 DETERMINISTIC 分支），此前那个文本从不落库 ——
    # 看板只能显示「判读缺失 / 读取失败 not_found」，而功能是正常的。
    # ⚠️ 进这个集合意味着未命中时会被一起 REMOVE —— 那是对的：结论是
    #    「当时那个形态的结论」，水位回到健康区之后它会误导。
    "conclusion", "skip_reason",
})
"""`assemble.to_evidence` **可能**产出的全部字段名。

用途：`apply_transitions` 改用 `update_item` 之后，「本轮未命中 → 清掉上轮
证据」这个刻意行为需要显式 `REMOVE`（`put_item` 时它是整项替换的副产品）。

⚠️ REMOVE 一个不存在的属性在 DynamoDB 里是 no-op，所以这份清单**宁可宽**
不可窄 —— 窄了的表现是「水位已经回到健康区，而看板上还挂着上一轮的
85% / 阈值 70%」，客户会以为现在还是 85%。

⚠️ 与 `assemble.to_evidence` 的一致性由 `test_inspection_store.py` 的元断言
守住。不 import assemble：adapter 不该依赖 domain 的组装层。
"""


def _finding_to_item(
    account_id: str, t: Transition, *, today: date,
    evidence: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    rec = t.record
    parts = rec.finding_id.split(keys.SEP)
    # 六段定长（R6.1）：<account>#<region>#<service>#<instance>#<rule>#<metric>
    padded = (parts + [keys.MISSING] * 6)[:6]
    item: dict[str, Any] = {
        "PK": keys.finding_pk(account_id),
        "SK": rec.finding_id,
        # 🔴 跨账号统一视图的索引键。看板的语义是「今天我要处置什么」——
        #    跨账号一起按严重度排，而主键 `inspfind#<账号>` 每个账号一个分区，
        #    读侧只能一次看一个账号。见 `keys.FINDING_GSI1PK` 的完整说明。
        #
        # ⚠️ 必须在**每次写**都重算：`GSI1SK` 里含 severity，而 severity 会随
        #    水位变（HIGH → CRITICAL）。只在 CREATED 时写会让索引里留着旧的
        #    严重度序 —— 那时统一视图的排序是错的，而**没有任何报错**
        #    （行在、位置不对）。`_finding_to_item` 每次写都被调，所以放这里。
        "GSI1PK": keys.FINDING_GSI1PK,
        "GSI1SK": keys.finding_gsi1sk(
            rec.severity.value, account_id, rec.finding_id),
        "finding_id": rec.finding_id,
        "account_id": padded[0],
        "region": padded[1],
        "service": padded[2],
        "instance_id": padded[3],
        "rule": padded[4],
        "metric": padded[5],
        "state": rec.state.value,
        "first_seen_date": rec.first_seen_date.isoformat(),
        "last_run_date": rec.last_run_date.isoformat(),
        "last_evaluated_date": today.isoformat(),
        "severity": rec.severity.value,
        "rule_version": rec.rule_version,
        "consecutive_hits": rec.consecutive_hits,
        "consecutive_misses": rec.consecutive_misses,
        "was_confirmed": rec.was_confirmed,
        "days_active": rec.days_active(today),
        "transition_kind": t.kind.value,
    }
    if t.resolution_kind is not None:
        item["resolution_kind"] = t.resolution_kind.value
    if t.prev_severity is not None:
        item["prev_severity"] = t.prev_severity.value
    if t.note:
        item["note"] = t.note
    # 判定证据（`assemble.to_evidence`）：实测值 / 阈值 / 余量 / 方向 / 金额。
    #
    # 🔴 走**旁路**而不是塞进 `Transition`：状态机管的是状态，证据是本轮的
    #    展示数据。为了几个显示用的数字给 lifecycle.py 的 13 个
    #    `Transition(...)` 构造点各加一个字段，风险远大于收益 ——
    #    漏一个构造点的表现是那一类状态变化的证据静默丢失。
    #
    # ⚠️ **不补 None、不补 0**：取不到就不写这个键，与 `Judgment.as_dict()`
    #    同约定。结构性风险是属性判定，本来就没有 value/threshold；
    #    UI 上那一行不渲染，而不是显示 0。
    if evidence:
        for k, v in evidence.items():
            if k in _EVIDENCE_FORBIDDEN:
                # 🔴 身份 / 状态 / 键位字段**不许被证据覆盖**。
                #
                #    这一段是无条件赋值且排在 `severity` / `state` / `SK` 之后，
                #    所以一个宽一格的抽取白名单就能让**展示数据覆盖状态机的
                #    结论** —— 表现是看板上的 severity 与推送出去的不一致，
                #    而且没人能解释；覆盖 `SK` 更是直接劫持排序键，写到另一条
                #    finding 上去。
                #
                #    生产侧的白名单（`assemble.to_evidence`）目前是干净的，
                #    但 `apply_transitions(evidence=…)` 是个可复用的写侧接口，
                #    不能只靠调用方自律。2026-08-23 的交叉 review 实测过：
                #    传 `{"severity":"INFO","state":"resolved","SK":"hijacked"}`
                #    三项全部生效。
                logger.warning(
                    "evidence 试图覆盖保留字段 %s（已忽略）—— 抽取白名单可能写宽了", k)
                continue
            if v is not None:
                item[k] = _jsonable(v)
        # 🔴 证据的**数据日期**。CHRONIC 会保留上一轮的证据（见
        #    `apply_transitions` 里 REMOVE 的条件），所以读侧必须能回答
        #    「这个数字是哪天的」——
        #
        #    不落它的表现：一条 CHRONIC finding 上挂着「可用内存 1.1%」，
        #    客户读成今天的水位，而那可能是 9 天前最后一次命中时的值。
        #    「问题还在」和「现在就是这个数」是两件事。
        #
        #    ⚠️ 只在**本轮真的写了证据**时更新。CHRONIC 轮次不进这个分支，
        #    于是旧的 `evidence_as_of` 原样留着 —— 那正是要的语义。
        item["evidence_as_of"] = today.isoformat()
    return item


def _finding_from_item(item: Mapping[str, Any]) -> FindingRecord:
    from inspection.domain.dto import Severity

    return FindingRecord(
        finding_id=str(item.get("finding_id") or item.get("SK", "")),
        state=FindingState(str(item.get("state", "new"))),
        first_seen_date=date.fromisoformat(str(item["first_seen_date"])),
        last_run_date=date.fromisoformat(str(item["last_run_date"])),
        severity=Severity.coerce(str(item.get("severity", "INFO"))),
        rule_version=str(item.get("rule_version", "")),
        consecutive_hits=int(item.get("consecutive_hits", 0) or 0),
        consecutive_misses=int(item.get("consecutive_misses", 0) or 0),
        was_confirmed=bool(item.get("was_confirmed", False)),
    )


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------


def _json_default(obj: Any) -> Any:
    """`json.dumps` 的兜底转换。**与 `_jsonable` 方向相反。**

    🔴 两个转换器服务两种去向，混用会炸：

    ```
    _jsonable       给 put_item        float → Decimal   （DDB 不收 float）
    _json_default   给 json.dumps      Decimal → float   （JSON 不收 Decimal）
    ```

    ⚠️ 曾经 `put_config_version` 写的是
    `json.dumps(_jsonable(config), ...)` —— 先把 float 转成 Decimal，
    再交给一个不认识 Decimal 的序列化器。**任何含浮点阈值的配置都写不进去**
    （`TypeError: Object of type Decimal is not JSON serializable`）。

    这个 bug 一直没被发现，因为两件事恰好互相掩盖：
    · 生产上流过这条路径的配置**恒为 `{}`**（写端没接上，见 `load_rule_config`）
    · 三个既有单测用的都是**整数** `{"cpu": 70}` —— 不走 float 分支

    而真实的 `ThresholdRuleConfig` 全是 `70.0` / `0.05` 这样的浮点，
    也就是说：**接上写端的那一刻，第一次写就会抛异常。**
    """
    if isinstance(obj, Decimal):
        # 整值还原成 int，避免 `5` 被写成 `5.0` 让 config_hash 无谓变化
        return int(obj) if obj == obj.to_integral_value() else float(obj)
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    if hasattr(obj, "value") and hasattr(obj, "name"):     # Enum
        return obj.value
    if is_dataclass(obj) and not isinstance(obj, type):
        return dc_asdict(obj)
    raise TypeError(f"{type(obj).__name__} 不能序列化进 config_json")


def _jsonable(obj: Any) -> Any:
    """把 dataclass / date / float 转成 DDB 能存的形状。

    ⚠️ float → Decimal 走 `str()`（见 `to_ddb_number` 的说明）。

    ⚠️ **这是给 `put_item` 用的，不是给 `json.dumps` 用的。** 要序列化成
    JSON 字符串时用 `_json_default`（Decimal 反过来会让 dumps 抛 TypeError）。
    """
    if isinstance(obj, Mapping):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    if hasattr(obj, "value") and hasattr(obj, "name"):     # Enum
        return obj.value
    return obj


def _schedule_from_item(
    run_type: RunType, item: Mapping[str, Any] | None,
) -> ScheduleConfig:
    """DDB 行 → `ScheduleConfig`。行不存在时给默认配置。

    ⚠️ **默认是 `enabled=True` 而不是 False。** 全新部署的表是空的；
    默认关掉会让客户跑完 `setup.sh` 之后什么都没发生，而且没有任何错误信号
    —— 只会以为「巡检要等一天」，等到第二天还是没有。

    ⚠️ 单个坏字段不能让整轮不跑：`at_utc` 解析失败时退回默认时刻并告警。
    抛异常会让一行手工改错的配置把**两类**巡检一起掐停。
    """
    if not item:
        return ScheduleConfig(run_type=run_type)

    raw_at = str(item.get("at_utc") or "")
    at_utc = ScheduleConfig(run_type=run_type).at_utc
    if raw_at:
        try:
            at_utc = time.fromisoformat(raw_at)
        except ValueError:
            logger.warning("at_utc=%r 解析失败，退回默认 %s", raw_at, at_utc)

    weekdays = item.get("weekdays")
    parsed_weekdays: frozenset[int] | None = None
    if weekdays:
        try:
            parsed_weekdays = frozenset(int(w) for w in weekdays)
        except (TypeError, ValueError):
            logger.warning("weekdays=%r 解析失败，按每天跑", weekdays)
        else:
            # 🔴 取值必须落在 `date.isoweekday()` 的域里（1~7，1=周一）。
            #
            # ⚠️ 越界值的表现**完全静默**：`matches_day` 用
            #    `d.isoweekday() in self.weekdays`，而 `isoweekday()` 永远不返回
            #    0 或 8 —— 于是存了 `0` 的那一类巡检**永远不跑**，run 记录里
            #    连一行都没有，看起来像「调度器压根没派它」。
            #    写入侧曾经就用 0~6（当成 `weekday()` 的域）落过库。
            bad = sorted(w for w in parsed_weekdays if not 1 <= w <= 7)
            if bad:
                good = frozenset(w for w in parsed_weekdays if 1 <= w <= 7)
                logger.error(
                    "weekdays 含越界值 %s（合法域 1~7，1=周一，对齐 isoweekday）"
                    "—— 这些值永远不会匹配任何一天；剩余 %s",
                    bad, sorted(good) or "空 → 按每天跑")
                # 全越界时退回「每天跑」而不是「一天都不跑」：后者会让一行写错
                # 的配置静默掐停这一类巡检，而前者至少会产出结果被人看见。
                parsed_weekdays = good or None

    enabled = item.get("enabled")

    # 🔴 `catch_up_hours` 必须按 **`is None`** 判缺失，不能用 `or` 兜底。
    #
    # `int(item.get("catch_up_hours") or 6)` 的问题：**0 是合法值但是 falsy**。
    # 客户把它设成 0 的意思是「错过就别补了，我不想看到延迟几小时的报告」，
    # 而 `or` 把这个意图当成「没设过」→ 读回 6 → 照样补跑。
    # 写侧是对的（`put_schedule` 原样写 0，BFF 也校验 `0 <= x <= 24`），
    # 于是表现是**存的是 0、生效的是 6**，且完全静默。
    #
    # 隔壁 `enabled` 用的就是 `is None`（所以 `enabled=False` 能正确读回）——
    # 两个字段紧挨着，一个对一个错。
    #
    # ⚠️ 解析失败要退回默认而不是抛：与上面 `at_utc` 同口径 ——
    # 一行手工改错的配置不该把**两类**巡检一起掐停。
    default_catch_up = ScheduleConfig(run_type=run_type).catch_up_hours
    raw_catch = item.get("catch_up_hours")
    catch_up_hours = default_catch_up
    if raw_catch is not None:
        try:
            catch_up_hours = int(raw_catch)
        except (TypeError, ValueError):
            logger.warning("catch_up_hours=%r 解析失败，退回默认 %d",
                           raw_catch, default_catch_up)

    return ScheduleConfig(
        run_type=run_type,
        enabled=True if enabled is None else bool(enabled),
        at_utc=at_utc,
        weekdays=parsed_weekdays,
        catch_up_hours=catch_up_hours,
    )


def canonical_config_json(config: Mapping[str, Any]) -> str:
    """`config_hash` 的**规范化**输入 —— 必须与 BFF 侧逐字节一致。

    ## 为什么不能直接用存库那个 `config_json`

    ```
    Python  json.dumps(cfg, sort_keys=True)            默认分隔符带空格
            {"threshold": {"cpu_utilization": 70.0}}   float 输出 70.0
    BFF     JSON.stringify(sortedDeep(cfg))            无空格
            {"threshold":{"cpu_utilization":70}}       整数值的 float 输出 70
    ```

    2026-08-26 实测同一份配置：`0d4d62a6313777ee` vs `dd67ccb9dddf4813`。

    🔴 这件事以前无害（`config_hash` 没有任何读者），**现在有害** ——
    `put_config_version` 拿它判「内容变没变」来决定要不要产生新版本号，而版本号
    就是 R6.9 的 `rule_version`。两侧不一致的后果：客户从 UI 保存一次阈值
    （BFF 写一行，哈希是 JS 算法），下一轮 scheduler 用同一份内容算出**另一个**
    哈希 → 判为「规则变了」→ 把全部 finding 强制 resolve 一遍。

    ⚠️ `bff/web-chat/inspection.mjs::sortedDeep` 上原本写着「与 Python 侧同理」
    —— 那句话是假的。跨语言的**键序**有断言守着，跨语言的**序列化字节**没有。
    `tests/test_inspection_config_hash.py` 补上了。

    ## 规范化的三件事

    ```
    键序        递归按键排序（数组内的 map 也要）
    分隔符      紧凑形式，无空格
    整数值 float  70.0 → 70   （JSON 只有一种数字类型，JS 就是这么输出的）
    ```

    ⚠️ 存库的 `config_json` **不改** —— 它给人读、给 UI 画阈值线，带空格更好认。
       哈希与存储形式解耦，改任何一个都不牵动另一个。
    """
    def norm(v: Any) -> Any:
        if isinstance(v, bool):
            return v
        if isinstance(v, Decimal):
            v = float(v)
        if isinstance(v, float) and v.is_integer():
            return int(v)
        if isinstance(v, Mapping):
            # ⚠️ **不在这里排键序** —— 下面 `json.dumps(sort_keys=True)` 已经排了
            #    （包括数组里嵌的 map）。在这里再排一遍是死代码：反向注入
            #    「改成 reversed」时测试照样绿，说明它不承载任何保证。
            #    而看起来承载保证、实际不起作用的代码正是这一轮一堆缺陷的形态
            #    （`is_rollup` / `evaluable` / `skipped` 都是）。
            return {k: norm(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)):
            return [norm(x) for x in v]
        return v

    return json.dumps(norm(config), sort_keys=True,
                      separators=(",", ":"), ensure_ascii=False,
                      default=_json_default)


def _stable_hash(body: str) -> str:
    """配置内容的稳定哈希。

    ⚠️ 用 sha256 而不是内置 `hash()` —— 后者带 PYTHONHASHSEED 随机化，
    每个进程都不一样，于是每次部署都会「检测到配置变更」并按 R6.9
    强制 resolve 全部 finding。
    """
    import hashlib

    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]
