"""巡检执行 Lambda（Phase 6：）。

被 SQS 唤醒，一条消息 = 一个 (run_type, account, data_date)。

```
SQS 消息
   │
   ├─ 6.1  抢 account 级幂等锁 —— 抢不到就**删消息**，不进 DLQ
   ├─ 6.2  展开巡检范围 → 实例清单（集群现展开）
   ├─ 6.3  入口过滤：剔除排除清单
   ├─ 6.4  写 run 记录 expected{} + status=running
   ├─ 6.5  批量 GetMetricData（≤400/批）
   ├─ 6.6  指标存在性校验 → 可观测性缺口
   ├─ 6.7  变更事件采集
   ├─ 6.8  warm-up 抑制
   ├─ 6.9  调 domain 判定；数值落序列库
   ├─ 6.10 出口过滤（二次兜底）
   ├─ 6.11 reconcile_findings 落库（条件写）
   ├─ 6.12 群体 rollup
   ├─ 6.13/6.14 playbook / 结论复用闸门
   ├─ 6.15 复合排序 + 三重配额
   └─ 6.16 写 run 记录 actual + completeness + 终态
```

## SQS 契约（2026-08-19 核 Lambda 官方文档，不凭记忆）

事件源映射开了 `ReportBatchItemFailures`，因此 handler **必须**返回
`{"batchItemFailures": [{"itemIdentifier": <messageId>}]}`。

```
整批算成功   空的 batchItemFailures ｜ null ｜ 空 EventResponse ｜ null EventResponse
整批算失败   ⚠️ 以下任一都会让**整批重投**（含已经跑完的那些）：
             · 抛异常
             · 返回非法 JSON
             · itemIdentifier 是空串
             · itemIdentifier 是 null
             · itemIdentifier 的**键名写错**（如 ItemIdentifier 大写）
             · itemIdentifier 指向一个不存在的 messageId
```

⚠️ **「整批重投」在这里代价极高**：一条消息跑完意味着已经付过一整轮
`GetMetricData`、可能已经派了 DA 调查。重投会重复付费、重复派单，
而 `try_acquire_run_lock` 只能挡住「同一天同账号」——挡不住「同一条消息
在锁 TTL 过期后重投」。所以 handler 顶层**捕获一切异常**，逐条记失败。

⚠️ 抢不到锁**不算失败**：那是正常路径（SQS at-least-once 是必然的，
两个 tick 撞在一起也会）。记成失败会让它进 DLQ 并触发告警，
而 DLQ 里堆的全是「本来就该跳过」的消息，真问题被淹掉。
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
from typing import Any

from inspection.adapters import change_events as ce
from inspection.adapters.store import (
    RUN_STATUS_FAILED,
    RUN_STATUS_PARTIAL,
    RUN_STATUS_SUCCESS,
    InspectionStore,
    SeriesRow,
    StoreError,
)
from inspection.domain import gating, metrics_meta, scope
from inspection.domain.schedule import DataSource, RunMode, RunType

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


# ---------------------------------------------------------------------------
# 跨账号凭证
# ---------------------------------------------------------------------------


_STS_SELF_ACCOUNT: str = ""
"""`_sts_self_account` 的容器级缓存。空串 = 还没问过。"""


def _sts_self_account() -> str:
    """问 STS「我到底是谁」—— `DEPLOY_ACCOUNT_ID` 掉了时的最后一道身份来源。

    ⚠️ 只在环境变量缺失这条**异常路径**上被调（`_session_for`），每容器
    缓存一次。正常路径零额外 API 调用 —— 当年拒绝这个兜底的理由是
    「每轮一次额外调用」，加了缓存之后那个代价不存在了。
    """
    global _STS_SELF_ACCOUNT
    if not _STS_SELF_ACCOUNT:
        import boto3

        _STS_SELF_ACCOUNT = str(
            boto3.client("sts").get_caller_identity()["Account"])
    return _STS_SELF_ACCOUNT


def _deploy_account_id() -> str:
    """部署账号 ID —— 回答「我自己是谁」。

    ## 🔴 优先 `DEPLOY_ACCOUNT_ID`，**不能只靠 `LOCKED_ACCOUNT_ID`**

    两个变量语义不同，而且第二个在多账号模式下**恰好是空的**：

    ```
    LOCKED_ACCOUNT_ID   闸门：「只允许这个账号」
                        orgMode ? "" : ACCOUNT_ID     ← 解锁时留空
    DEPLOY_ACCOUNT_ID   身份：「我自己是谁」
                        ACCOUNT_ID                     ← 恒有值
    ```

    第一版只读 `LOCKED_ACCOUNT_ID`，于是开了 Organizations 模式之后
    executor 判不出自己是谁 → 保守退化成单账号 → **「开了多账号模式反而
    不跨账号」**。而那时 UI 上账号选择器已经解锁、账号也 onboard 了，
    表现是「配置都对，就是不跑成员账号」，且没有任何报错。

    ⚠️ 仍然保留 `LOCKED_ACCOUNT_ID` 作为兜底：存量部署（这次改动之前）
    没有 `DEPLOY_ACCOUNT_ID`，而它们必然是非 orgMode（否则也没跨账号可跑），
    那时 `LOCKED_ACCOUNT_ID` 就是部署账号。

    ⚠️ 两个都拿不到时返回空串 → `_session_for` 退化成单账号（安全）。
    不去 `sts.get_caller_identity()` 兜第三层：那是每轮一次额外 API 调用，
    而两个环境变量都缺只可能是 CDK 没部署到位 —— 该修部署，不该运行时补救。
    """
    return (_env("DEPLOY_ACCOUNT_ID").strip()
            or _env("LOCKED_ACCOUNT_ID").strip())


def _session_for(account_id: str, region: str = ""):
    """按目标账号返回 boto3 Session。部署账号用自身角色，成员账号 AssumeRole。

    ⚠️ `region` 形参**已废弃、不再使用**（保留只为不破调用方签名）。

    🔴 本函数里建的两个客户端（config 表的 DDB、STS）都是**我们自己的**资源，
    必须在 home region（`AWS_REGION`）。多 region 巡检之后调用方传进来的是
    **要扫的** region —— 用它建 DDB 客户端会去 us-east-1 找 `notiops-config`
    表，撞 `ResourceNotFoundException`，而那条异常的文案里不提 region，
    看起来像「表被删了」。

    ## 为什么必须有这一层

    直接 `boto3.client("rds", ...)` 用的是 Lambda 自身的执行角色（部署账号），
    而 `load_rds_attrs(rds, task.account_id, region)` 的 `account_id` 是
    **传进去的参数**。两者错开的后果（2026-08-25 修复前的真实状态）：

    ```
    account_id = B 的 task  →  用部署账号凭证 describe
                            →  拿到部署账号的资源
                            →  落库 account_id 写成 B
    ```

    **不报错、不缺数据、completeness 100%** —— 账号 B 的巡检页里全是部署账号
    的资源。这一类「用错凭证但落对 account_id」的缺陷，看板上完全看不出来。

    ## 凭证从哪来

    ```
    account#<id>/meta 的 role_arn        onboard 时写入（member_accounts.mjs）
      = arn:aws:iam::<id>:role/notiops-idle-detection-role-<部署账号>
    成员账号侧的角色                       infra/member-account-onboarding.yaml
      信任 部署账号 root（+ 可选 aws:PrincipalOrgID 条件）
      挂 ReadOnlyAccess + inline notiops-readonly
    ```

    ⚠️ **不需要 ExternalId** —— 那个角色的信任策略里没有它。传了会被拒。
    （`devops_agent_skills.mjs` 的 `trigger_role_arn` 是另一个角色，那个要。）

    ## 与 `shared/account_scope.py` 的 LOCKED_ACCOUNT_ID 闸门的关系

    🔴 巡检**刻意不接**那道闸门。理由：

    ```
    那道闸门的语义是「跨账号先都 disabled」，它锁的是老 idle-detector
    （lambda1 采集 / lambda5 成本 / DA 调查）。而巡检的账号范围有自己的
    控制面 —— `enabled_accounts()` 只返回 onboard 过**且** enabled 的账号，
    每个账号在管理页上有独立开关，比一个全局环境变量精确。
    ```

    接上它的后果是：跨账号在巡检上永远不可用（CDK 默认注入那个变量），
    而 UI 上照样能 onboard + enable —— 那就回到了「加了没用」，
    只是从「数据错乱」变成「静默不跑」。两个都不好。

    ⚠️ 所以**控制面在管理页**：不想让某个账号被巡检，就在那里 disable 它。
    """
    # ⚠️ **函数内 import**，与本模块其余三处一致：模块级 import boto3 会让
    #    不装 boto3 的 CI job（`inspection-tests`）连 import 都失败。
    #    第一版写成模块级引用，`_session_for` 一跑就 NameError ——
    #    而那要等到第一次真的跨账号采集才会暴露。
    import boto3

    deploy = _deploy_account_id()
    target = str(account_id or "").strip()
    # 部署账号 → 自身角色。
    if not target or (deploy and target == deploy):
        return boto3.Session()
    # 🔴 `deploy` 为空（环境变量没注入）时**不许**直接退化成自身角色。
    #
    #    上一版这里写的是「退化成单账号行为是安全的（与修复前一致）」——
    #    那个论证是错的（2026-09-04 交叉 review）：「修复前的行为」正是
    #    2026-08-25 修掉的那个缺陷本身。而这不是假想路径：
    #    `cross_account_identity.test.mjs` 记录过 `DEPLOY_ACCOUNT_ID` 真的
    #    在一次 CDK 迁移里掉过（14 个消费侧测试全绿，靠 cdk diff 才发现）。
    #    掉了之后走这条退化路径的后果全程静默：
    #
    #    ```
    #    所有账号 → boto3.Session()（部署账号自身凭证）
    #    → 用部署账号的凭证 describe，落库时账号号却是 task.account_id
    #    → 部署账号的资源被当成成员账号的写进 finding
    #    → 零报错、completeness 100%、看板一切正常
    #    ```
    #
    #    同一函数对 `role_arn` 缺失的处置是抛（理由：「唯一能跑通的方式就是
    #    用部署账号的凭证 —— 那正是要防的错」）。两个入口同一个后果，
    #    必须同一个处置。
    #
    # ⚠️ 但抛之前先问一次 STS「我到底是谁」：单账号部署里 target 恒等于
    #    部署账号自己 —— 环境变量掉了就全抛会把单账号部署整个打死，
    #    那是当年写退化路径想防的事，它值得防，只是要用**证据**而不是假设。
    #    每容器只问一次（模块级缓存），代价远小于一条静默错账号路径。
    if not deploy:
        actual = _sts_self_account()
        if target == actual:
            return boto3.Session()
        raise RuntimeError(
            f"DEPLOY_ACCOUNT_ID 没有注入，而目标账号 {target} 不是本账号 "
            f"（STS 实测 {actual}）。拒绝用部署账号凭证代跑 —— 那会把部署"
            "账号的资源落成它的（零报错、completeness 100%）。去查 CDK 的 "
            "env 注入（cross_account_identity.test.mjs 记录过它掉过一次）。")

    home = _env("AWS_REGION", "ap-northeast-1")
    cfg_table = boto3.resource("dynamodb", region_name=home).Table(
        _env("CONFIG_TABLE"))
    from inspection.adapters import accounts as acct_repo
    role_arn = acct_repo.account_role_arn(cfg_table, target)
    if not role_arn:
        # 🔴 **抛而不是退化**。没有 role_arn 却要巡检一个别的账号，
        #    唯一「能跑通」的方式就是用部署账号的凭证 —— 那正是要防的错。
        #    让这一轮失败，run 记录里会留下原因。
        raise RuntimeError(
            f"账号 {target} 没有跨账号采集角色（account#{target}/meta 的 "
            "role_arn 为空）。它可能只做了 DevOps Agent 关联（da# 记录）"
            "而没走管理页的账号 onboard —— 两条记录都要在。"
            "拒绝用部署账号凭证代跑，否则会把部署账号的资源落成它的。")

    # 🔴 **role ARN 的账号段必须 == 目标账号。**
    #    这道校验此前只装在 DevOps Agent 那条路上（`shared/devops_agent.py`），
    #    采集这条**没有** —— 而写侧 `api/routes/accounts.py` 的 `role_arn`
    #    是从请求体直取、零校验。两头一凑：能写 config 表的人就能让我们的
    #    Lambda 执行角色 assume 到**他自己账号**的角色，然后用他控制的凭证
    #    去「采集」某个合法账号 —— 落库时账号号写的是那个合法账号。
    #    ⇒ 巡检 finding 的完整性整个失守，而且这是 confused deputy。
    #
    #    ⚠️ 巡检刻意不接 `LOCKED_ACCOUNT_ID` 闸门（见本模块 docstring），
    #       所以闸门拦不住这条 —— 只能在真要 assume 之前查。
    from shared.account_scope import assert_role_belongs_to

    assert_role_belongs_to(role_arn, target, what=f"account#{target}.role_arn")

    sts = boto3.client("sts", region_name=home)
    try:
        # ⚠️ 会话名带账号后缀 —— CloudTrail 里能一眼看出这次 assume 是替谁做的。
        #    RoleSessionName 只允许 [\w+=,.@-]，账号 ID 是纯数字所以安全。
        cred = sts.assume_role(
            RoleArn=role_arn,
            RoleSessionName=f"notiops-inspection-{target}",
            DurationSeconds=3600,
        )["Credentials"]
    except Exception as e:                                 # noqa: BLE001
        raise RuntimeError(
            f"AssumeRole 进账号 {target} 失败（{role_arn}）: "
            f"{type(e).__name__}: {e}。检查成员账号里那个角色是否存在、"
            "信任策略是否包含部署账号、以及 StackSet 实例有没有下发成功。"
        ) from e
    logger.info("跨账号采集: account=%s 已 assume %s", target, role_arn)
    return boto3.Session(
        aws_access_key_id=cred["AccessKeyId"],
        aws_secret_access_key=cred["SecretAccessKey"],
        aws_session_token=cred["SessionToken"],
    )


# ---------------------------------------------------------------------------
# 6.1 消息解析
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Task:
    """一条消息解析出的巡检任务。"""

    run_type: RunType
    account_id: str
    run_date: date
    data_date: date
    source: DataSource
    mode: RunMode
    tier: str
    region: str = ""
    """**只扫这一个 region**。空 = 扫账号下全部已启用 region（正常路径）。

    🔴 生产上恒为空 —— `inspection/domain/fanout.py::InspectionMessage` 没有
    这个字段，`to_body()` 也不会写它。它存在的唯一用途是**运维手动重跑**：
    往队列里塞一条带 `"region": "us-east-1"` 的消息，只重扫那一个 region，
    不用为全部 17 个再付一遍 GetMetricData。

    ⚠️ 这个字段曾经有一段注释论证「region 必须进锁键，否则 17 个 region 抢
    同一把锁」—— 那论证的是**按 region 扇出 SQS 消息**的方案，而那个方案被
    否掉了（会把 DA heartbeat / run 记录行数 / 报告推送 / 对账缺行判定全部
    乘以 region 数）。现在一个账号一条消息、一行 run 记录、一把锁。

    ⚠️ 收窄之后 run 记录的 `regions_total` 就是 1，`completeness` 只反映那一个
    region —— 与全量轮不可比。所以它**不该**被定时轮使用，只给人工重跑。
    """
    config_version: str = ""
    config_inline: Mapping[str, Any] | None = None
    catch_up: bool = False
    trigger_id: str = ""
    instance_subset: tuple[str, ...] = ()
    """只巡检这几台（补齐重投，R13.15）。空 = 全量。"""
    backfill_run_id: str = ""
    """非空 = 这是给该 run 的补齐轮。见 `InspectionMessage.backfill_run_id`。"""

    @property
    def is_dry_run(self) -> bool:
        """`dry_run` **只表示「不推进 finding 状态机」**，别的什么都不表示。

        🔴 这个属性曾经同时被用来关掉三件事，而只有第一件是本意：
        ```
        ① 不写状态机       ← 本意。`resolved` 判定带日期语义，一次手点的补跑
                             不该推进它（`reconcile(dry_run=...)`）
        ② 不派 DA          ← **副作用**，见 `dispatches_da`
        ③ 但仍占当天槽位    ← `build_stats` 照样落 success，而调度的判据是
                             `BLOCKING_STATUSES = {running, success}`
        ```
        ② 的后果是**看板上「跑高负载」这个按钮从来拿不到 AI 分析** ——
        前端写死 `mode: "dry_run"`（那是对的，理由是 ①），于是客户点完看到
        finding 与全部确定性数值，而根因分析那半永远是空的，界面上不说为什么。
        2026-08-29 三方交叉 review 发现。
        """
        return self.mode is RunMode.DRY_RUN

    @property
    def dispatches_da(self) -> bool:
        """这一轮要不要真的调 `CreateBacklogTask`。

        🔴 与 `is_dry_run` **解耦**（2026-08-29）。`dry_run` 的理由是「不推进
        带日期语义的状态机」，与「要不要买一次 AI 判读」无关 —— 把两件事绑在
        一个开关上，让唯一的手动触发入口失去了它最主要的价值。

        ⚠️ 现在恒为真。留成一个属性而不是直接删掉那个判断，是为了给
        「按 tier 降档到 DEGRADED 时不派」这类未来判据留一个**单一**读点 ——
        散在两处 `if not task.is_dry_run and ...` 里的判断迟早会漂移。

        ⚠️ 代价是**手点一次会花 DA 额度**。按钮的 title 已经说明它会占掉当天
        的巡检槽位，同一处要补上这一句。
        """
        return True

    @property
    def is_backfill(self) -> bool:
        return bool(self.backfill_run_id)


def parse_task(body: str) -> Task:
    """`MessageBody` → `Task`。

    ⚠️ 解析失败**抛异常**，让这条消息计入 `batchItemFailures` 最终进 DLQ。
    静默跳过会让一条格式错误的消息永久消失，而那个账号这天没有巡检也没有失败记录。
    """
    raw = json.loads(body)
    missing = [k for k in ("run_type", "account_id", "run_date", "data_date")
               if not raw.get(k)]
    if missing:
        raise ValueError(f"消息缺字段: {missing}")
    return Task(
        run_type=RunType(str(raw["run_type"])),
        account_id=str(raw["account_id"]),
        run_date=date.fromisoformat(str(raw["run_date"])),
        data_date=date.fromisoformat(str(raw["data_date"])),
        source=DataSource(str(raw.get("source", DataSource.REFETCH.value))),
        mode=RunMode(str(raw.get("mode", RunMode.OFFICIAL.value))),
        tier=str(raw.get("tier", "normal")),
        config_version=str(raw.get("config_version", "")),
        config_inline=raw.get("config_inline"),
        catch_up=bool(raw.get("catch_up", False)),
        region=str(raw.get("region", "")).strip(),
        trigger_id=str(raw.get("trigger_id", "")),
        # ⚠️ 用 tuple 而不是 list：Task 是 frozen dataclass，list 会让它
        #    不可哈希，而 `dedupe_id` 那侧已经依赖可哈希性。
        instance_subset=tuple(
            str(i).strip() for i in (raw.get("instance_subset") or [])
            if str(i).strip()),
        backfill_run_id=str(raw.get("backfill_run_id", "")),
    )


# ---------------------------------------------------------------------------
# 6.2 集群成员展开
# ---------------------------------------------------------------------------


def expand_rds_clusters(rds_client) -> dict[str, list[str]]:
    """`{cluster_id: [成员实例 id]}`（R1.6 / R8.6 的分母来源）。

    ⚠️ 用分页器。`describe_db_clusters` 默认每页 100，账号里集群多了会截断，
    而截断的表现是「那几个集群的 rollup 分母偏小」——比例算出来偏高，
    不报错。
    """
    out: dict[str, list[str]] = {}
    try:
        pages = rds_client.get_paginator("describe_db_clusters").paginate()
        for page in pages:
            for c in page.get("DBClusters", []):
                cid = str(c.get("DBClusterIdentifier") or "")
                if not cid:
                    continue
                out[cid] = [
                    str(m.get("DBInstanceIdentifier") or "")
                    for m in c.get("DBClusterMembers", [])
                    if m.get("DBInstanceIdentifier")
                ]
    except Exception as e:                     # noqa: BLE001
        # 展开失败 → rollup 退回「按已评估数当分母」，仍可用（见 rollup.py 的说明）
        logger.warning("展开 RDS 集群成员失败，rollup 分母将退回已评估数: %s", e)
    return out


def expand_elasticache_groups(ec_client) -> dict[str, list[str]]:
    """`{replication_group_id: [成员 cache cluster id]}`。

    ⚠️ 成员在**两处**都有，取 `MemberClusters`（完整的字符串列表）：

    ```
    MemberClusters                      list[str]  —— 跨全部分片的完整成员
    NodeGroups[].NodeGroupMembers[]     结构体     —— 按分片分组，带 CurrentRole
    ```

    只读 `NodeGroups[0]` 会在 cluster-mode-enabled（多分片）时漏掉其余分片的成员
    —— 分母偏小 → rollup 比例偏高 → 3 台里 3 台同向被报成「整个集群」，
    而集群其实有 12 台。
    """
    out: dict[str, list[str]] = {}
    try:
        pages = ec_client.get_paginator("describe_replication_groups").paginate()
        for page in pages:
            for g in page.get("ReplicationGroups", []):
                gid = str(g.get("ReplicationGroupId") or "")
                if not gid:
                    continue
                members = [str(m) for m in (g.get("MemberClusters") or [])]
                if not members:
                    # 兜底：从分片里拼。⚠️ 要遍历**全部** NodeGroups。
                    members = [
                        str(m.get("CacheClusterId") or "")
                        for ng in (g.get("NodeGroups") or [])
                        for m in (ng.get("NodeGroupMembers") or [])
                        if m.get("CacheClusterId")
                    ]
                out[gid] = members
    except Exception as e:                     # noqa: BLE001
        logger.warning("展开 ElastiCache 副本组成员失败: %s", e)
    return out


# ---------------------------------------------------------------------------
# 6.3 / 6.10 排除过滤
# ---------------------------------------------------------------------------


def load_exclusions(store: InspectionStore, run_type: RunType) -> list[scope.ExclusionEntry]:
    """读对应类型的排除清单。

    ⚠️ 两类巡检各一份（`inspscope#high` / `inspscope#idle`）。
    读错一份的后果是「客户在高负载里排除的实例出现在闲置报告里」——
    看起来像排除没生效。
    """
    rows = store.list_exclusions(run_type.value)
    out: list[scope.ExclusionEntry] = []
    for r in rows:
        try:
            out.append(scope.ExclusionEntry(
                list_kind=scope.ScopeList(run_type.value),
                account_id=str(r.get("account_id") or ""),
                service=str(r.get("service") or ""),
                resource_id=str(r.get("resource_id") or ""),
                region=str(r.get("region") or ""),
                # ⚠️ `level` 用 `r["level"]` 而不是 `.get()`：设计明写这一列
                #    不能省，缺了级联排除会**静默失效**（UI 上集群已勾选，
                #    成员照样出现在结果里）。让它在这里 KeyError 被下面接住并告警。
                level=scope.ScopeLevel(str(r["level"])),
                expires_at=(date.fromisoformat(str(r["expires_at"]))
                            if r.get("expires_at") else None),
                reason=str(r.get("reason") or ""),
                created_by=str(r.get("created_by") or ""),
            ))
        except (KeyError, ValueError) as e:
            # ⚠️ 单条坏记录不能让整份清单失效 —— 那会让**全部**排除失灵，
            #    客户已勾选的实例批量重新出现在报告里。
            logger.warning("跳过一条无法解析的排除记录 %s: %s", r.get("resource_id"), e)
    return out


# ---------------------------------------------------------------------------
# 6.4 / 6.16 run 记录
# ---------------------------------------------------------------------------


def _resolve_rule_config(store: InspectionStore, task: "Task") -> Mapping[str, Any]:
    """拿到本轮该用的规则配置字典（R13.4）。

    两条来源，优先内联：

    ```
    task.config_inline    scheduler 把小配置塞进了消息 → 直接用，省一次读
    task.config_version   大配置只下发了版本号 → 按它回读不可变表
    都没有                → {} → 判定层全部用 dataclass 默认值
    ```

    🔴 **读失败一律降级成 `{}`，不抛。** 抛异常等于「配置读不到就整轮不跑」，
    而巡检不跑在界面上只有一句「本轮未发现风险」—— 与真的没风险长得一样。
    用默认阈值判一轮 + 一条 ERROR 日志，比没有产出好。

    ⚠️ 降级用的是**默认值**而不是「上一轮的配置」：后者要再读一次表（同样可能
    失败），而且会让「客户刚把阈值调宽」在读失败的那一轮静默回到旧值 ——
    表现是误报忽然又出现一次，没人能解释。
    """
    inline = task.config_inline
    if isinstance(inline, Mapping) and inline:
        return inline
    version = (task.config_version or "").strip()
    if not version:
        return {}
    try:
        row = store.get_config_version("inspection", task.run_type.value, version)
    except Exception as e:                     # noqa: BLE001
        logger.error("回读配置版本 %s 失败，本轮用默认阈值: %s", version, e)
        return {}
    if not row:
        logger.error("配置版本 %s 在表里不存在，本轮用默认阈值", version)
        return {}
    try:
        parsed = json.loads(str(row.get("config_json") or "{}"))
    except json.JSONDecodeError as e:
        logger.error("配置版本 %s 的 config_json 解析失败，本轮用默认阈值: %s",
                     version, e)
        return {}
    return parsed if isinstance(parsed, Mapping) else {}


def series_rows(
    bundle: Any, *, account_id: str, region: str, config_version: str = "",
    backfilled: bool = False, backfill_run_id: str = "",
) -> list[SeriesRow]:
    """`MetricsBundle.series` → 可落库的 `SeriesRow` 列表（6.9）。

    ⚠️ 一个 `MetricSeries` 有 N 个日点，要展开成 N 行 —— PK 里没有日期，
    日期在 SK（`inspseries#<acct>#<region>#<svc>#<inst>` + `<metric>#<stat>#<date>`）。
    只写最新那一天会让 7 天窗口永远只有 1 天数据，coverage 恒为 1，
    于是**每台实例都被判 INSUFFICIENT_DATA** 而不报错。
    """
    out: list[SeriesRow] = []
    for ms in bundle.series.values():
        # 🔴 判据走 `metrics_meta.is_elasticache_family`，**不要**自己写。
        #
        #    这一行原来是：
        #
        #    ```python
        #    service = "elasticache" if bundle.family_by_instance.get(
        #        ms.instance_id, "").startswith("AWS/ElastiCache") else "rds"
        #    ```
        #
        #    `family_by_instance` 的值是**指标族**（`redis` / `memcached` /
        #    `rds-mysql` …，见 `MetricFamily`），而 `AWS/ElastiCache` 是
        #    **CloudWatch namespace**。两个词汇表被混成一个 → 那个条件
        #    **永远为假** → 每一行序列都以 `service="rds"` 落库。
        #
        #    2026-09-01 实机：全表 4344 行序列**没有一行**在 `elasticache`
        #    分区，其中 2808 行是 ElastiCache 的资源。而读侧
        #    （`manual_judge` 第 ② 步）用的是 finding 行里真实的
        #    `service="elasticache"`：
        #
        #    ```
        #    写 inspseries#<acct>#<region>#rds#notiops-tb-redis-…
        #    读 inspseries#<acct>#<region>#elasticache#notiops-tb-redis-…
        #      → 0 行 → 载荷里每个指标都是 no_datapoints
        #      → skill 只能回 insufficient_evidence（它被告知没有数据）
        #      → DA 额度花掉，客户拿到一句「证据不足」
        #    ```
        #
        #    ⚠️ 看板**不受影响**，所以这个 bug 极难发现：闲置评分走的是
        #       内存里刚采到的 `MetricsBundle`（`idle_factors` 里有真实值
        #       cpu 0.26% / memory 1.70%），只有「派 DA 判读」这条路读序列库。
        #       于是界面上一切正常，唯独判读说「没有任何数据」。
        #
        #    ⚠️ RDS 侧一直是对的 —— 纯属巧合：写错的那个常量恰好等于
        #       RDS 的正确值。所以「RDS 判读正常」不能当作这条链没问题的证据。
        fam = bundle.family_by_instance.get(ms.instance_id, "")
        service = "elasticache" if metrics_meta.is_elasticache_family(fam) else "rds"
        for p in ms.points:
            out.append(SeriesRow(
                account_id=account_id, region=region, service=service,
                instance_id=ms.instance_id, metric=ms.metric, stat=ms.stat,
                data_date=p.data_date, value=p.value,
                config_version=config_version,
                backfilled=backfilled,
                backfill_run_id=backfill_run_id,
            ))
    return out


def suppression_targets(
    bundle: Any, *, annotations: Mapping[str, Sequence[tuple[date, str]]],
    data_date: date, se: Any,
) -> dict[tuple[str, str], str]:
    """哪些 (实例, 指标) 该被抑制，以及**是哪个探测器判出来的**（6.8 / R8.5）。

    R8.5 要求**两个独立的探测器**，返回值里区分它们：

    ```
    "event"    in_warmup()      事件驱动 —— DescribeEvents 抓到了那次重启
    "plateau"  is_plateauing()  形态驱动 —— 不需要任何事件
    ```

    ⚠️ **两个都要，不可互相替代。** `DescribeEvents` 只保留 14 天，
    且我们按 `SourceType` 过滤。事件漏一次 `in_warmup()` 就完全不知道 ——
    而那台实例的内存曲线恰好最像泄漏（完美单调线性下降）。
    形态判据是那种情形下唯一还站着的防线。

    ⚠️ 反过来，形态判据也代替不了事件判据：刚重启第 1~2 天曲线还在陡降，
    `is_plateauing()` 判 False，只有事件能说明「这是回填不是泄漏」。

    ⚠️ 遍历的是**全部**实例，不只是有标注的那些 —— 平台期检测与标注无关。
    我第一版只对 `annotations` 里有记录的实例算，那等于让形态判据
    完全依附于事件判据，两个探测器合成一个（而且不报错）。
    """
    by_instance: dict[str, list[Any]] = {}
    for ms in bundle.series.values():
        by_instance.setdefault(ms.instance_id, []).append(ms)

    out: dict[tuple[str, str], str] = {}
    for iid, metric_series in by_instance.items():
        evs = annotations.get(iid) or ()
        built = se.build_series_from_metric_series(
            metric_series, data_date=data_date, change_events=evs)
        for (bid, metric), s in built.items():
            if evs and se.in_warmup(s, data_date=data_date):
                out[(bid, metric)] = "event"
            elif se.is_plateauing(s):
                out[(bid, metric)] = "plateau"
    return out


def build_stats(
    *,
    expected_instances: int,
    expected_clusters: int,
    evaluated_instances: int,
    series_written: int,
    gaps: Sequence[Any],
    batches_failed: int,
    suppressed: Mapping[tuple[str, str], str],
    change_event_count: int,
    excluded: int,
    dry_run: bool,
    dispatch: Mapping[str, Any] | None = None,
    skipped: Sequence[str] | None = None,
    regions_total: int = 0,
    regions_failed: Sequence[str] = (),
) -> dict[str, Any]:
    """组装写进 run 记录的 stats（6.16 / R9.2）。

    抽成纯函数是为了让它**可被单测覆盖** —— 留在 `_run_inspection` 里就只能
    靠真 AWS 客户端才跑得到，于是这一段永远没有测试。
    R9.1 明写「所有数字 SHALL 由巡检 Lambda 确定性计算」，
    一段算不出测试的确定性计算不是确定性的。

    ⚠️ 两个 warm-up 探测器**分开记**。合成一个数会让「事件采集坏了」
    这件事不可观测：`suppressed_by_event` 突然归零而 `by_plateau` 顶上时，
    总数看起来没变 —— 而那意味着 `DescribeEvents` 已经完全失效。

    ⚠️ `gaps_our_fault` 单独记（R13b.5）：那些是我们的 IAM 缺权限，
    不该混进客户可见的「可观测性缺口」计数里。
    """
    actual = {
        "instances": evaluated_instances,
        "series_written": series_written,
        "gaps": sum(1 for g in gaps if getattr(g, "customer_visible", True)),
        "gaps_our_fault": sum(1 for g in gaps if getattr(g, "is_our_fault", False)),
        "batches_failed": batches_failed,
        "warmup_suppressed": len(suppressed),
        "suppressed_by_event": sum(1 for v in suppressed.values() if v == "event"),
        "suppressed_by_plateau": sum(1 for v in suppressed.values()
                                     if v == "plateau"),
        "change_events": change_event_count,
    }
    out = {
        "status": terminal_status(expected=expected_instances,
                                 actual=evaluated_instances,
                                 batches_failed=batches_failed,
                                 regions_failed=len(regions_failed)),
        "expected": {"instances": expected_instances,
                     "clusters": expected_clusters},
        "actual": actual,
        "completeness": completeness(expected_instances, evaluated_instances),
        "excluded": excluded,
        "dry_run": dry_run,
    }
    # ⚠️ `dispatch` 段是**必须有**的，即使全是 0。缺了它「今天为什么没有
    #    AI 分析」在事后无法回答 —— 而那正是自查前那个 bug 的表现形态
    #    （run success 但零 finding 零派发，看板上完全看不出异常）。
    out["dispatch"] = dict(dispatch or {
        "findings": 0, "rollup_groups": 0, "excluded_at_exit": 0,
        "dispatched_tasks": 0, "deferred": 0, "transitions": 0,
        "skipped_by_gate": {}, "heartbeat": False,
    })
    # 🔴 本轮降级的痕迹（`refdata:load_failed` / `pricing_table:load_failed`
    #    / 采集层的降级标记）。
    #
    #    这个列表原来被传进 `load_resources`、被 append 两次，然后**再没有
    #    任何引用** —— `build_stats` 的签名里压根没有它。代码注释写着
    #    「痕迹落 skipped，SHALL NOT 静默」，而它落进了一个没人读的列表。
    #
    #    refdata 失败的后果：`ca_cert_expiry` / `engine_lifecycles` 为空 →
    #    证书临期与 EOL 两类规则对**所有**实例返回 None → 那两类风险本轮零
    #    产出。而 run 状态照旧 success/partial，`expected` / `actual` /
    #    `completeness` 都不变（它们数的是实例不是规则）。已存在的那些
    #    finding 走 `_step_missed`，昨天刚建的直接 RESOLVED + prediction_missed
    #    —— 一条真实风险被记成误报并从看板消失。
    #
    # ⚠️ 空列表也要写这个键。缺键与「本轮没有降级」在读侧无法区分，
    #    而那正是这一整轮审计里最常见的缺陷形态。
    out["skipped"] = sorted(set(skipped or ()))
    # 🔴 region 覆盖面。三个数都要在：
    #
    #    regions_total    本来该扫几个（`DescribeRegions` 的结果数）
    #    regions_scanned  真的扫成了几个
    #    regions_failed   哪几个失败了，带异常类型
    #
    # ⚠️ 少了 `total` 就没有分母 —— 失败的 region 在 `by_region` 里**连键都
    #    没有**（不是 0），所以「少了一个 region」在读侧看不出来。这一整轮
    #    改造修的就是这个形状，别在自己身上再犯一次。
    out["regions"] = {
        "total": regions_total,
        "scanned": max(0, regions_total - len(regions_failed)),
        "failed": sorted(regions_failed),
    }
    return out


def completeness(expected: int, actual: int) -> float:
    """完成度。`expected == 0` 时返回 1.0（没有要做的事就是做完了）。

    ⚠️ 返回 0.0 会让「这个账号本来就没有资源」看起来和
    「采集全失败」一模一样，而后者要人来查。
    """
    if expected <= 0:
        return 1.0
    return min(1.0, actual / expected)


_AWS_CFG = None
"""采集客户端的 botocore 配置（惰性构造 —— 模块级 import botocore 会让不装
boto3 的 CI job 连 import 都失败）。见 `_aws_cfg()`。"""


def _aws_cfg():
    """采集客户端统一的重试与超时配置。

    🔴 botocore 的默认是 **legacy** 重试模式（`_retry.json` 的
    `__default__.max_attempts = 5`），而读超时默认 60 秒 —— 一批 400 query
    撞 CloudWatch 限流时最坏 5 × 60 = **300 秒**卡在一个 region 上。
    多 region 之后这 300 秒会连带拖住整个 Lambda 的 15 分钟预算，
    而超时是全静默的一条路（见 `_remaining_seconds`）。

    ```
    mode="adaptive"      带客户端限流感知的退避，比 legacy 更快让出
    connect_timeout 10   建连不该要 60 秒
    read_timeout 30      单次调用超过 30 秒就该重试而不是干等
    max_pool_connections 内层 metrics_repo 有 8 并发，默认 10 恰好够；
                         显式写出来免得日后调 DEFAULT_MAX_WORKERS 时
                         静默撞上 urllib3 的 "Connection pool is full"
    ```
    """
    global _AWS_CFG
    if _AWS_CFG is None:
        from botocore.config import Config
        _AWS_CFG = Config(
            retries={"mode": "adaptive", "max_attempts": 3},
            connect_timeout=10, read_timeout=30,
            max_pool_connections=12,
        )
    return _AWS_CFG


def _remaining_seconds(context: Any, *, reserve_s: float = 60.0) -> float | None:
    """Lambda 还剩多少秒可用（留 `reserve_s` 给收尾）。

    `None` = 拿不到 context（本地跑 / 测试），调用方按「不设 deadline」处理。

    🔴 为什么必须有这个：超时是**全静默**的一条路。

    ```
    15 分钟到点 → finish_run 不执行 → run 行停在 status=running，
                  lock_until = t0 + 6h
    16 分钟后   → visibilityTimeout 到，消息重新可见
    第 2 次收到 → try_acquire_run_lock 三段条件全假（running 且锁未过期）
                → _process_one **正常返回**「已有 run 在跑，跳过」
                → ESM 删消息。maxReceiveCount=3 永远走不到，DLQ 是空的
    对账那侧   → coverage.py `if status == "running": continue`
                  既不记 missing_row 也不记 low_completeness
    ```

    净效果：一个大账号可以连续几个月每天超时，而看板上只有一行 `running`，
    DLQ 空、`RunSucceeded` 无数据点、对账不响。所以宁可提前收尾落 `partial`
    （可见、且不阻止补跑），也不要让它撞超时。

    ⚠️ 留 60 秒是为了让 `put_series` / `finish_run` / `_emit_run_metrics`
    跑完 —— 收尾自己也要时间，deadline 卡到 0 等于没设。
    """
    getter = getattr(context, "get_remaining_time_in_millis", None)
    if not callable(getter):
        return None
    try:
        left = float(getter()) / 1000.0
    except Exception:                                          # noqa: BLE001
        return None
    return max(1.0, left - reserve_s)


def terminal_status(*, expected: int, actual: int, batches_failed: int,
                    regions_failed: int = 0) -> str:
    """run 的终态（R9.2）。

    ```
    success   全部拿到
    partial   有缺口但仍出了报告
    failed    一条都没拿到（且本来有要拿的）
    ```

    ⚠️ `partial` 与 `failed` 必须分开：`partial` 不阻止下一轮重跑（补跑要用），
    而把部分成功记成 `failed` 会让 `due_runs()` 每个 tick 都重新派它。

    🔴 `regions_failed > 0` **必须**落 `partial`（2026-08-27）。

    多 region 之后一个 region 在**发现阶段**失败会同时缩小分子和分母：
    `expected` 是发现之后才算的，所以失败 region 的实例既不在 expected 里、
    也不在 actual 里 → `actual == expected` → 这个函数原来会回 `success`。
    实测复现：us-east-1 的 4 台 RDS 撞一次限流 →
    `expected=0 / actual=0 / batches_failed=0 / completeness=1.0 / success`，
    看板显示「跑过了、没风险」。

    ⚠️ 落 `partial` 而不是 `failed`：其余 region 的结果是好的、报告该出，
    而 `partial` 恰好不阻止补跑。
    """
    if expected > 0 and actual == 0:
        return RUN_STATUS_FAILED
    if regions_failed > 0 or batches_failed > 0 or actual < expected:
        return RUN_STATUS_PARTIAL
    return RUN_STATUS_SUCCESS


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def _failure(message_id: str) -> dict[str, str]:
    """构造一条 `batchItemFailures` 条目。

    ⚠️ 键名必须**恰好**是 `itemIdentifier`。官方文档明列：键名写错、值为空串、
    值为 null、或指向不存在的 messageId，都会让**整批**被判失败并重投 ——
    包括已经跑完（已付 GetMetricData、已派 DA）的那些。
    """
    return {"itemIdentifier": message_id}


def handler(event: Mapping[str, Any], context: Any = None) -> dict[str, Any]:
    """SQS 事件入口。返回 `batchItemFailures`（开了 ReportBatchItemFailures）。

    ⚠️ **另有一条直接 invoke 的入口**：`{"manual_judge": {...}}`（见下）。
       它不走 SQS —— 那条路是「人在界面上点一条 finding 要判读」，
       同步返回结果比「已提交，稍后看」有用得多（整条 1 次 GetItem +
       1 次 query + 1 次 describe + 1 次 CreateBacklogTask，远在 30 秒以内）。
    """
    # ── 按需判读（直接 invoke，不经 SQS）─────────────────────────────────
    #
    # 🔴 必须在 `Records` 循环**之前**分支。放在后面的表现是：这个事件里没有
    #    `Records` → 循环体一次都不执行 → 返回 `{"batchItemFailures": []}`
    #    → 调用方拿到一个「成功」的空结果，而什么都没发生。
    if event.get("manual_judge"):
        return _handle_manual_judge(dict(event["manual_judge"]), context)

    records = list(event.get("Records") or [])
    failures: list[dict[str, str]] = []

    for rec in records:
        message_id = str(rec.get("messageId") or "")
        try:
            outcome = _process_one(rec, context)
            logger.info("消息 %s 处理完毕: %s", message_id, outcome)
        except Exception as e:                 # noqa: BLE001
            # ⚠️ **捕获一切**。抛出去会让整批重投 —— 包括本批里已经跑完的消息，
            #    那意味着重复付 GetMetricData、重复派 DA 调查。
            logger.exception("消息 %s 处理失败: %s", message_id, e)
            if message_id:
                failures.append(_failure(message_id))
            else:
                # 没有 messageId 时**不能**编一个：指向不存在的 id 会让整批失败。
                logger.error("消息缺 messageId，无法上报单条失败")

    return {"batchItemFailures": failures}


def _process_one(record: Mapping[str, Any], context: Any) -> str:
    """处理一条消息。返回一句人读的结果说明。"""
    task = parse_task(str(record.get("body") or "{}"))
    now = datetime.now(timezone.utc)

    table_name = _env("INSPECTION_TABLE")
    if not table_name:
        raise RuntimeError("缺 INSPECTION_TABLE")

    import boto3

    # 🔴 两个 region，别混。
    #
    #    home_region   本系统自己的资源在哪（DDB / SQS / STS）—— 恒等于
    #                  Lambda 所在 region，AWS 注入，不可配。
    #    scan_region   这一轮要巡检哪个 region 的客户资源 —— 由**消息**给。
    #
    # 在 2026-08-27 之前只有一个变量，两个用途共用它。后果是巡检永远只看
    # 部署 region：验证账号的 4 台 RDS 全在 us-east-1，而
    # `expected.instances = 0` → `completeness = 0÷0 = 1` → 看板显示
    # 「跑过了、没风险」。整链零错误、零告警、零日志。
    #
    # ⚠️ DDB 客户端**必须**用 home_region。跟着 scan_region 走会让每个
    #    region 的巡检结果写进那个 region 的（不存在的）表里 ——
    #    `ResourceNotFoundException`，而那条异常的文案里不提 region。
    home_region = _env("AWS_REGION", "ap-northeast-1")
    scan_region = task.region or home_region
    ddb = boto3.resource("dynamodb", region_name=home_region)
    store = InspectionStore(ddb.Table(table_name))

    # ── kill switch（R11c.1）
    #
    # 🔴 调度器挡住的只是**新的** fan-out；拉开关的那一刻队列里可能已经堆着
    #    几十条消息（batchSize=1，一条要跑最长 15 分钟）。只在调度侧挡会让
    #    「已经拉停了」与「还在跑一整轮」并存最长若干小时。
    #
    # ⚠️ 必须在**抢锁之前**判。抢到锁再退出会留下一把 6 小时才过期的锁
    #    （`RUN_LOCK_TTL_HOURS`），于是开关重新打开之后那个账号当天仍然跑不了。
    #
    # ⚠️ 正常返回（消息删除，不进 DLQ）。抛异常会让 DLQ 堆满「本来就该跳过」
    #    的消息并触发告警，真问题被淹掉 —— 与抢不到锁那条同理。
    from inspection.adapters import switches

    if not switches.is_enabled(ddb.Table(_env("CONFIG_TABLE")),
                               switches.Switch.INSPECTION):
        return (f"{task.run_type.value}/{task.account_id} 巡检已被 kill switch "
                f"停用，跳过（消息删除，不进 DLQ）")

    # ── 6.1 幂等锁：抢不到就**正常返回**（消息被删，不进 DLQ）
    owner = getattr(context, "aws_request_id", "") or ""
    # 🔴 补齐轮抢**自己的**锁（SK 带 `#bf<n>` 后缀），不碰原 run 的那把。
    #
    #    原因（review 抓到，此前整条补齐链路零效果）：锁的条件只放行
    #    「无行 / failed / 超时的 running」三种，而缺口那一轮的行是
    #    `partial` 或 `success` —— 补齐消息用同一个键必然被拒，然后按
    #    「正常路径」删除、不进 DLQ、只在日志里留一行「已有 run 在跑或已完成」。
    #    于是 `backfill_attempts` 照常自增到 2（看板显示「补过两次」），
    #    而序列库里那几台的点从头到尾没有补上。
    #
    #    ⚠️ 不是「补齐不抢锁」：两条补齐消息并发跑同一账号会重复付
    #    GetMetricData。独立键既保证互斥、又不与原轮冲突。
    # 🔴 锁键 = `<账号>` 或 `<账号>#bf<n>`。**不带 region。**
    #
    #    多 region 是在**一次调用内部**做的（一个账号一条 SQS 消息、一行 run
    #    记录），所以锁的粒度仍然是账号 —— 与 run 记录的 SK 一致。
    #
    #    ⚠️ 这里曾经短暂写成 `keys.run_sk(account, task.region, attempt)`，
    #      那是「按 region 扇出」那版方案的残留。那个函数在方案回退时被一起
    #      删掉了，于是这一行是 `AttributeError` —— 而崩点在抢锁与 `put_run`
    #      **之前**，所以一行 run 记录都不会写：看板「最近 run」空着，
    #      与「今天还没到点」长得一模一样；reconciler 的 `if not rows: continue`
    #      也把缺行判定整块跳过。唯一信号是 DLQ 深度。
    #
    #    3235 条测试全绿是因为**没有任何测试执行过 `_process_one`** ——
    #    这个文件的测试全是源码文本断言。已补 `test_process_one_*` 那组。
    lock_key = task.account_id
    if task.is_backfill:
        lock_key = f"{task.account_id}#{task.backfill_run_id.rsplit('#', 1)[-1]}"
    got = store.try_acquire_run_lock(
        task.run_type.value, task.run_date, lock_key, owner=owner, now=now)
    if not got:
        # ⚠️ 这是正常路径，不是错误。抛异常会让它进 DLQ 并触发告警，
        #    而 DLQ 里堆的全是「本来就该跳过」的消息，真问题被淹掉。
        return (f"{task.run_type.value}/{lock_key} 已有 run 在跑或已完成，"
                f"跳过（消息删除，不进 DLQ）")

    try:
        stats = _run_inspection(store, task, now=now, region=scan_region,
                                context=context, run_sk=lock_key)
    except Exception as e:                     # noqa: BLE001
        # 锁已经抢到 → 必须落 failed，否则这一天既没巡检也没失败记录，
        # 而锁要等 6 小时才过期（`RUN_LOCK_TTL_HOURS`）。
        store.finish_run(
            run_type=task.run_type.value, run_date=task.run_date,
            # ⚠️ 用 `lock_key` 而不是 `account_id` —— 补齐轮收尾自己那行，
            #    覆盖原行会把缺口那一轮的 stats 抹掉，而对账下一轮要读它。
            account_id=lock_key, status=RUN_STATUS_FAILED,
            now=datetime.now(timezone.utc), error=f"{type(e).__name__}: {e}")
        # ⚠️ 失败路径也要打点（见 `_emit_run_metrics` 的说明）。
        #    这里只有 status，没有 stats —— 构造一个最小 stats 让
        #    `RunSucceeded=0` 能被发出去。
        _emit_run_metrics(task, {"status": RUN_STATUS_FAILED,
                                 "dry_run": task.is_dry_run})
        raise

    store.finish_run(
        run_type=task.run_type.value, run_date=task.run_date,
        account_id=lock_key, status=stats["status"],
        now=datetime.now(timezone.utc), stats=stats)
    _emit_run_metrics(task, stats)
    return (f"{task.run_type.value}/{task.account_id} {stats['status']}: "
            f"{stats['actual']['instances']}/{stats['expected']['instances']} 实例")


def _emit_run_metrics(task: Task, stats: Mapping[str, Any]) -> None:
    """打 run 的告警指标（R11c.3）。

    ⚠️ **成功和失败两条路径都要调。** 只在成功时打点会让「全账号失败」
    在 CloudWatch 里表现为**无数据**而不是「0 次成功」，而 P1 那条告警数的
    正是 `RunSucceeded` 的日 Sum 是否为 0 —— 无数据与 0 的
    `treatMissingData` 语义不同，混起来会让告警在真出事时反而不响。

    ⚠️ 打点失败绝不冒泡：观测不该成为新的故障源。
    """
    # 🔴 **补齐轮不打 run 指标。**
    #
    #    P1 那条告警（`notiops-inspection-all-accounts-failed`）数的是
    #    `RunSucceeded` 的日 Sum 是否 < 1，连续 2 天才响 —— 语义是
    #    「全账号失败，或调度整体停摆」。补齐轮成功一条就能把日 Sum 顶到
    #    ≥1，把那条告警顶灭；而补齐轮的存在**恰恰说明**主轮没跑通，
    #    它成功不能证明调度是通的。
    #
    #    ⚠️ 也不能只是换个维度：Alarm 匹配的是**不带 dimensionsMap** 的
    #    那条聚合指标（打点侧的空 DimensionSet），加维度不会把它从聚合里
    #    摘出去。只能整段不打。
    #    ⚠️ 补齐轮的可观测性走对账那侧的 `backfill_sent` / `backfill_skipped`
    #    与日志，不走 run 指标。
    if task.is_backfill:
        logger.info("补齐轮不打 run 指标（避免顶灭 P1「连续 2 天全账号失败」）: %s",
                    task.backfill_run_id)
        return
    try:
        from inspection.adapters import metrics
        from inspection.domain.observability import signals_from_stats

        metrics.emit_run_signals(signals_from_stats(
            stats, run_type=task.run_type.value, account_id=task.account_id))
    except Exception:                          # noqa: BLE001
        logger.exception("打点失败（不影响本轮结果）")


def _task_id_of(resp: Mapping[str, Any] | None) -> str:
    """从 `CreateBacklogTask` 的响应里取 task id。

    ## 🔴 `taskId` 嵌在 `task` 里，**不在顶层**

    2026-08-25 用真实派发实测到的形状（botocore 的
    `CreateBacklogTaskResponse` shape 也是这个）：

    ```
    {"ResponseMetadata": {...},
     "task": {"taskId": "...", "executionId": "...", "status": "...", …}}
     ^^^^^^^ 顶层只有这一个业务键
    ```

    而本函数第一版只找顶层的 `taskId` / `TaskId` / `task_id` → 恒返回空
    → **全部 DA 判读永久无法回拼**。失败是静默的：task 真的发出去了、
    额度真的花了、`inspdispatch#` 映射是空的，于是每条 finding 都停在
    「未做根因分析」，而看板上没有任何地方说得清为什么。

    ⚠️ 上一版的注释写着「实测真发返回的也是 `taskId`」—— 那句话是错的
    （或者当时的 API 形状与现在不同）。唯一能发现它的信号是
    `DispatchUnmapped` 打点与总览页的「派发缺口」，而那两个数确实报了
    （`DispatchUnmapped: 1`）—— 是**没人去看**。

    ## 候选键的顺序

    先 `task.taskId`（当前真实形状），再顶层三种写法（兜住 API 回退或
    别的 SDK 版本）。多写几个候选的成本远低于「判读全丢且静默」。
    """
    if not resp:
        return ""
    # ① 当前形状：嵌在 `task` 结构里
    inner = resp.get("task")
    if isinstance(inner, Mapping):
        for k in ("taskId", "TaskId", "task_id", "id"):
            v = inner.get(k)
            if v:
                return str(v).strip()
    # ② 顶层（老形状 / 其它 SDK 写法）
    for k in ("taskId", "TaskId", "task_id"):
        v = resp.get(k)
        if v:
            return str(v).strip()
    return ""


# ---------------------------------------------------------------------------
# 多 region 采集（2026-08-27）
# ---------------------------------------------------------------------------


@dataclass
class RegionScan:
    """一个 region 的采集与判定中间态。

    🔴 **不是 frozen** —— `_collect` 阶段要往里填 `bundle` / `rows` 等。
    做成 frozen 再 `replace()` 会让并发那层多一次全量拷贝，而这个对象里
    装着整份指标序列。

    ⚠️ 为什么按 region 分开保存而不是采完就合并：
    `MetricsBundle.series` 的键是 `(instance_id, metric, stat)`、
    `family_by_instance` 按 `instance_id` 索引 —— 而**资源 ID 只在区域内唯一**
    （见 `inspection/adapters/keys.py` 的键构造那段）。合并成一个 bundle 会让
    东京的 `prod-mysql` 与弗吉尼亚的 `prod-mysql` **互相覆盖**，而且静默：
    少的那台既不报错也不出 finding，看起来就像「它今天很健康」。

    所以判定（`judge_findings` / `exit_filter` / `rollup_candidates` /
    `apply_gates`）**逐 region 调**，合并发生在 finding 层面 ——
    `finding_id` 六段里第 2 段是 region，全局唯一。
    """

    region: str
    rds: Any = None
    ec: Any = None
    cw: Any = None
    all_attrs: list = field(default_factory=list)
    kept: list = field(default_factory=list)
    excluded: list = field(default_factory=list)
    cluster_sizes: dict = field(default_factory=dict)
    skipped: list = field(default_factory=list)
    bundle: Any = None
    events: list = field(default_factory=list)
    suppressed: dict = field(default_factory=dict)
    rows: list = field(default_factory=list)
    """这个 region 的序列行。**主线程写完会把它清空**（见 6.9 那段）——
    与 `bundle` 同时活着会让内存按实例总数翻倍。"""


def _fan_regions(fn, items, *, what: str, max_workers: int = 8,
                 deadline_s: float | None = None):
    """并发跑 `fn` over `items`，返回 `(成功的结果, 失败的标识列表)`。

    Args:
        what: 出错时写进日志的阶段名。
        deadline_s: 整体时限（秒）。超时的那些算失败。

    🔴 **返回失败清单，不只返回成功的。**

    第一版只 `return ok`（把失败的过滤掉），后果是被这次改造修掉的那个缺陷
    原样复活，只是粒度从「账号」换成「region」：

    ```
    us-east-1 的 describe 撞一次限流
      → 那个 region 从 scans 里消失
      → expected = len(kept) 只数存活的 → 它的 4 台凭空不见
      → completeness = evaluated / expected = 1.0
      → terminal_status(expected=0, actual=0, batches_failed=0) = success
      → by_region 里连 us-east-1 这个键都没有
      → skipped 空（失败 region 的 marks 随对象一起消失）
      → 看板「跑过了、没风险」
    ```

    实测复现过（2026-08-27）。所以调用方 **SHALL** 用第二个返回值：
    落进 `skipped`、写进 run 记录的 `regions_failed`，并让 `terminal_status`
    看得见它。

    ⚠️ `_discover` 阶段失败尤其危险，因为 `expected` 是在它**之后**才写的。
    `_collect` 阶段失败反而是可见的（expected 已落库 → actual 掉 → partial）。

    🔴 **`pool.map` 没有 timeout。** 一个卡死的 region（botocore legacy 重试
    最坏 5 × 60 秒）能把另外 16 个的结果一起拖到 Lambda 超时，而超时是
    **全静默**的：`finish_run` 不执行 → 行停在 `running` → 16 分钟后消息重投
    → 抢不到锁 → 按「正常路径」删除、不进 DLQ → 对账那侧
    `if status == "running": continue`。所以这里用 `as_completed` + deadline。

    ⚠️ `max_workers` 不开太大：内层 `metrics_repo.collect` 自己还有一个 8 并发
    的池，8×8 = 64 个在飞的 GetMetricData 线程。CloudWatch 侧够用
    （单 region 仍只有 ≤8 个在飞，约 3.5 TPS / 22,400 DPS，远低于
    50 TPS / 396,000 DPS 的配额），但 1024MB Lambda 只有约 0.58 vCPU，
    线程再多就是纯上下文切换。
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    items = list(items)
    if not items:
        return [], []

    ok: list = []
    failed: list[str] = []

    def _ident(it) -> str:
        return str(getattr(it, "region", it))

    with ThreadPoolExecutor(max_workers=min(max_workers, len(items))) as pool:
        futs = {pool.submit(fn, it): it for it in items}
        try:
            for fut in as_completed(futs, timeout=deadline_s):
                it = futs[fut]
                try:
                    ok.append(fut.result())
                except Exception as e:                         # noqa: BLE001
                    failed.append(f"{_ident(it)}:{type(e).__name__}")
                    logger.exception("%s 失败: region=%s %s: %s",
                                     what, _ident(it), type(e).__name__, e)
        except TimeoutError:
            # ⚠️ 超时的 future 记成失败并**取消**没开始的那些。不取消会让
            #    `ThreadPoolExecutor.__exit__` 的 shutdown(wait=True) 继续等，
            #    deadline 就白设了。
            for fut, it in futs.items():
                if not fut.done():
                    fut.cancel()
                    failed.append(f"{_ident(it)}:Timeout")
                    logger.error("%s 超时（deadline=%ss）: region=%s",
                                 what, deadline_s, _ident(it))
    if failed:
        logger.error("%s：%d 个 region 里 %d 个失败 → %s",
                     what, len(items), len(failed), sorted(failed))
    return ok, failed


def _assemble_and_dispatch(
    store: InspectionStore, task: Task, *,
    scans: Sequence["RegionScan"], exclusions: Sequence[Any],
    insp_cfg: Any, ref: Any, price_table: Mapping[str, Any] | None = None,
    threshold_cfg: Any = None,
    space_id: str = "", da_target: Any = None,
) -> dict[str, Any]:
    """判定结果 → 出口过滤 → rollup → 闸门 → 排序配额 → 派 task。

    ⚠️ 判定逻辑全在 `inspection/assemble.py`（纯函数、有单测），
    这里只做 IO：读 prior、写 finding 状态机、调 `CreateBacklogTask`。

    ⚠️ `dry_run` 时**照常算、照常组装、照常派 DA**，只是不落状态机
    （2026-08-29 起；此前也不派 DA，那是副作用 —— 见 `Task.dispatches_da`）。
    跳过计算会让 dry-run 的报告和正式轮的不一致，那就失去了预演的意义。

    ## 🔴 判定**逐 region** 调，派发只做一次（2026-08-27）

    ```
    逐 region（instance_id 键，只在区域内唯一）
      judge_findings · exit_filter · rollup_candidates · apply_gates
      healthy_observations        ← 要 attrs 才能拼出带正确 region 的 finding_id
      评估集合                     ← 写成 "<region>#<实例>"

    合并之后只做一次（finding 键，全局唯一）
      reconcile 状态机 · apply_transitions
      build_tasks · heartbeat · CreateBacklogTask · put_dispatch
    ```

    为什么这么切：`attrs_by_id` 与 `MetricsBundle` 都按 `instance_id` 索引，
    而资源 ID 只在区域内唯一。合并成一份会让两个 region 的同名实例互相覆盖，
    **且静默** —— 被覆盖那台既不报错也不出 finding，看起来就是「它很健康」。

    为什么派发不分 region：DA 配额按秒计（`MONTHLY_LIMIT_SECONDS`），每个
    region 各派一次 heartbeat 会把开销乘以 region 数；而报告、推送、对账、
    run 记录也都会跟着乘。判读本身与 region 无关（它只看 payload）。
    """
    import boto3

    from inspection import assemble as asm
    from inspection.adapters import switches
    from inspection.domain import scope
    from inspection.domain.budget import Tier
    from inspection.domain import lifecycle as lifecycle_mod
    from inspection.domain.lifecycle import reconcile
    from inspection.domain.schedule import RunType
    from shared.investigations import INSPECTION_SOURCE, preregister_investigation

    list_kind = scope.ScopeList(task.run_type.value)
    tier = Tier(task.tier) if task.tier in {t.value for t in Tier} else Tier.NORMAL

    # ⚠️ 这三个是**账号级**输入，在逐 region 循环**之前**读一次。
    #    放进循环会让每个 region 各读一遍整个账号的 finding 行（17 倍 RCU），
    #    而它们的内容与 region 无关。
    #
    # ⚠️ `AWS_REGION` 而不是被扫的 region —— config 表是**我们自己的**资源，
    #    恒在 home region。跟着要扫的 region 走会去 us-east-1 找这张表，
    #    撞 ResourceNotFoundException（文案里不提 region）。
    cfg_tbl = boto3.resource(
        "dynamodb", region_name=_env("AWS_REGION", "ap-northeast-1")
    ).Table(_env("CONFIG_TABLE"))
    da_enabled = switches.is_enabled(cfg_tbl, switches.Switch.DA)

    # 上一轮的 DA 结论（R5.12 结论复用）。
    #
    # 🔴 2026-08-23 之前**这条链路从未接通**：`priors` 从来没被传过，于是
    #    `try_reuse` 第一行 `if prior is None: return None` 直接返回，
    #    同一个形态每天重新买一次 LLM 判读，而两天的结论逐字相同。
    #
    # ⚠️ 读**原始行**而不是 `load_findings()` —— 后者返回 domain 的
    #    `FindingRecord`，丢掉了 `da_verdict` / `da_body` / `shape`，
    #    而复用判据全靠这三个。
    #
    # ⚠️ 必须读在 `apply_gates` **之前**。下面 6.11 那里的 `load_findings`
    #    是给状态机用的、且跑在闸门之后 —— 拿它当 prior 来源是不行的。
    priors = {}
    for it in store.list_finding_items(task.account_id):
        p = gating.prior_from_item(it)
        if p is not None:
            fid = str(it.get("finding_id") or it.get("SK") or "")
            if fid:
                priors[fid] = p

    # 🔴 `locale` 决定 DA 判读**正文**的语言（R11b.10）：它随
    #    载荷下发，skill 照它输出。此前这里没传，于是一直吃
    #    `judge_findings(locale="zh")` 的默认值 —— 对当前客户恰好是对的，
    #    但那是巧合，改个默认值就会静默把所有报告变成另一种语言。
    #
    # ⚠️ **不能按投递目标的 `locale` 定。** 判读是一条 finding 一份、多个 chat
    #    共享的；两个 chat 看同一个账号却设了不同语言时，按目标定必然让其中
    #    一个收到「外壳是中文、判读正文是英文」的混合卡片。所以分两层：
    #      · 判读正文  ← 部署级 `INSPECTION_REPORT_LOCALE`（本处）
    #      · 推送外壳  ← 每个投递目标的 `locale`（push_policy.render_selection）
    #
    # ⚠️ 不复用 `DEFAULT_LOCALE`：那个 env 在 `report_delivery/push_handler.py`
    #    里的兜底是 `"en"`，共用会把巡检拖成英文 —— 而 R11b.10 的 ⚠️ 说的正是
    #    「中文客户收英文卡片」这件事。
    report_locale = (_env("INSPECTION_REPORT_LOCALE", "zh") or "zh").strip().lower()
    if report_locale not in ("zh", "en"):
        logger.warning("INSPECTION_REPORT_LOCALE=%r 不认识，按 zh 处理",
                       report_locale)
        report_locale = "zh"

    # ── 6.9 / 6.10 / 6.12 / 6.13 / 6.14 **逐 region** 判定
    findings: list = []
    obs: list = []
    evaluated: set[str] = set()
    gate_counts: dict[str, int] = {}
    groups: list = []
    dropped_total = 0
    collected_count = 0
    """采集成功的实例数（采集目标 − 采集失败）。→ run 记录的 actual / completeness。"""
    kept_total = 0

    for sc in scans:
        if not sc.kept:
            continue                     # 这个 region 没有资源，没什么可判的
        attrs_by_id = {a.instance_id: a for a in sc.kept}
        kept_total += len(sc.kept)

        # 水位已回健康区的 (实例, 指标)。**状态机靠它判「客户处置完了」** ——
        # `to_observations` 只处理命中的，它的 docstring 明写「未命中的由调用方按
        # evaluated 集合给出」，而这里以前没给：全仓 `healthy=` 只有一处、写死
        # False，于是 `resolving` 永远走向 CHRONIC、`ResolutionKind.FIXED` 一次都
        # 产不出来 —— 越是正常工作的部署，误报率看起来越高。
        healthy_pairs: list[tuple[str, str]] = []
        # 本轮**判不了**的实例（coverage < min_coverage_days、全部指标 NO_DATA、
        # 或这个引擎没有 alerting 指标）。
        #
        # 🔴 `InstanceVerdict.evaluable` 的 docstring 写着「调用方 SHALL 用它决定
        #    要不要把这台放进评估集合」，而在这次改动之前全仓零读点。
        #    留在评估集合里的后果：本轮产不出 finding → 上一轮那条走
        #    `_step_missed` → 若它是昨天刚建的（未确认），直接判
        #    **RESOLVED + prediction_missed** —— 一条真实风险被记成误报并消失。
        not_evaluable: list[str] = []
        f_r = asm.judge_findings(
            run_type=task.run_type, bundle=sc.bundle, attrs_by_id=attrs_by_id,
            cfg=insp_cfg, refdata=ref, data_date=task.data_date,
            today=task.data_date,
            # 🔴 高负载轮的阈值走这个参数。不传等于 `ThresholdRuleConfig()` ——
            #    客户改的值到不了判定层，而报告照样出（R13.4 那条链路此前就断在这里）。
            threshold_cfg=threshold_cfg,
            price_table=price_table, suppressed=sc.suppressed,
            window_days=insp_cfg.window_days, config_version=task.config_version,
            locale=report_locale,
            healthy_out=healthy_pairs,
            not_evaluable_out=not_evaluable,
            # 🔴 DA 能不能自己去这个账号调 API（PI / DescribeEvents / CloudTrail）。
            #
            #    巡检判读共用**部署账号**的一个 Agent Space，而那个 space 的
            #    association 默认只有部署账号自己（成员账号要客户在管理页点
            #    「一键关联」才会加进去）。所以成员账号的 finding 派进去之后，
            #    DA 对那个账号是够不到的。
            #
            #    不告诉 skill 的后果（实测形态）：`attrs.performance_insights_enabled`
            #    是从**成员账号**读到的 `true`，skill 于是判「usable」并要 DA 自己去
            #    取 `DBLoad`；DA 拿到 AccessDenied，而 skill 原来的三选一表述里没有
            #    「我到不了那个账号」这一档 —— 最可能的输出是「PI is not enabled on
            #    this instance」，**对一台明明开了 PI 的库说了假话**。
            #
            # ⚠️ 这里用「是不是部署账号」近似「在不在 space 的 association 里」。
            #    偏保守的方向是对的：已关联的成员账号会被当成不可达，DA 少做一次
            #    主动查证（结论仍然基于 payload）；反过来（把不可达当可达）才会
            #    产出假陈述。
            reachable=(task.account_id == _deploy_account_id()
                       or not _deploy_account_id()))

        # ── 6.10 出口过滤
        f_r, dropped = asm.exit_filter(
            f_r, exclusions, today=task.data_date,
            attrs_by_id=attrs_by_id, list_kind=list_kind)
        dropped_total += len(dropped)

        # ── 6.12 群体 rollup
        # ⚠️ 用**这个 region 自己的** cluster_sizes：集群 id 只在 region 内唯一，
        #    传合并版会让两个 region 的同名集群共用一个分母，比例算出来偏高。
        f_r, g_r = asm.rollup_candidates(
            f_r, attrs_by_id=attrs_by_id, cluster_sizes=sc.cluster_sizes)
        groups.extend(g_r)

        # ── 6.13 / 6.14 / 11.1 闸门（含 da_enabled kill switch）
        f_r, gc_r = asm.apply_gates(
            f_r, run_type=task.run_type, today=task.data_date, tier=tier,
            attrs_by_id=attrs_by_id, da_enabled=da_enabled, priors=priors)
        for k, v in (gc_r or {}).items():
            gate_counts[k] = gate_counts.get(k, 0) + v

        # 🔴 评估集合 = 采集目标 − 采集失败 − **本轮判不了的**（R6.2a）。
        #    `evaluated_instance_ids` 只减前者。见上面 `not_evaluable` 的说明。
        _evaluated_ids = (sc.bundle.evaluated_instance_ids(list(attrs_by_id))
                          - set(not_evaluable))
        # 🔴 **两个数，量的不是同一件事。别统一。**
        #
        #    ```
        #    collected  采集目标 − 采集失败                「我们成功采到了几台」
        #               → run 记录的 actual.instances / completeness
        #               → heartbeat 正文里的「本轮评估了 N 台」
        #
        #    judged     collected − 判不了的（R6.2a）      「几台真的下了结论」
        #               → 传给状态机的评估集合
        #    ```
        #
        # ⚠️ 我把这两个合成一个试过，真跑立刻暴露：13 台新建实例
        #    coverage < 5 天 → 全部 `not_evaluable` → judged=0 →
        #    `terminal_status(expected=13, actual=0)` → **failed**，
        #    而那一轮明明成功采到 13 台、写了 1727 条序列。
        #    「采不到」与「采到了但数据不够判」是两回事，run 记录必须分开报。
        collected_count += len(sc.bundle.evaluated_instance_ids(list(attrs_by_id)))
        if not_evaluable:
            logger.info("[%s] 本轮判不了 %d 台，已从评估集合剔除（R6.2a）: %s",
                        sc.region, len(not_evaluable),
                        sorted(set(not_evaluable))[:10])
        # 🔴 **必须写成 `<region>#<实例>`，不能传裸实例 id。**
        #
        #    `prev` 是 `load_findings(account_id)` 读出来的 —— 整个账号
        #    `inspfind#<账号>` 的全部 finding，**跨全部 region**。而资源 ID
        #    只在区域内唯一（`keys.py` 的键构造那段就是为这条）。传裸实例 id
        #    的后果：
        #
        #    ```
        #    finding    677#ap-northeast-1#rds#prod-mysql#threshold_high#cpu   东京，真风险
        #    evaluated  {"prod-mysql"}                                         本轮在扫 us-east-1
        #    → lifecycle._in_scope 只比实例段 → 命中 → _step_missed
        #    → 连续两轮 → RESOLVED
        #    ```
        #
        #    一个 region 健康把另一个 region 的真风险判成「已解决」，零报错。
        #    升级前不会发生（那时只扫部署 region，所有 finding 的 region 段
        #    都一样），多 region 一开就激活。
        #
        # ⚠️ `_in_scope` 那侧**仍然接受**裸实例 id（存量契约）。所以这一处
        #    退回裸 id 不会让任何 lifecycle 测试变红 —— 守卫在
        #    `tests/test_inspection_executor.py` 的接缝断言上。
        evaluated |= {
            f"{attrs_by_id[i].region}#{i}" if i in attrs_by_id else i
            for i in _evaluated_ids
        }

        # 命中的观测 + **水位已回健康区**的观测。
        # ⚠️ 两者的 finding_id 必须同格式（六段定长，R6.1）—— 不同的话
        #    healthy 观测永远匹配不到 prev 里的记录，**不报错**，
        #    只是恢复检测永远不生效。见 `asm.healthy_observations`。
        # ⚠️ healthy 观测**必须在 region 循环里**建：它要靠 `attrs_by_id` 拼出
        #    finding_id 的 region 段，用合并版会拼出另一个 region 的 id。
        obs += asm.to_observations(f_r, rule_version=task.config_version)
        obs += asm.healthy_observations(
            healthy_pairs, attrs_by_id, rule_version=task.config_version)
        findings.extend(f_r)

    # ── 6.11 finding 状态机（dry_run 不落库）
    n_transitions = 0
    # 🔴 闸门是 `findings or obs or prev`，**不是** `if findings:`。
    #
    #    原来只在有 finding 时才推进状态机，于是「本轮零风险」那天状态机
    #    完全不动 —— 昨天的 active finding 原地冻结，永远不会 resolved。
    #    与 `healthy` 恒 False 叠起来的结果是：**客户把问题全修完之后，
    #    看板上那些 finding 一条都不会消失**。
    #
    #    ⚠️ `prev` 要先读出来才能判 —— 多一次 Query，但那是本来就要做的
    #      （下面立刻用它）。
    prev_all = asm.scope_prev_findings(

        store.load_findings(task.account_id), task.run_type)
    # ⚠️ 判据是合并后的 `obs` 而不是 `healthy_pairs` —— 后者现在是 region
    #    循环里的局部变量，全部 region 都空时它压根没被绑定
    #    （`UnboundLocalError`，被 `test_空_region_不参与判定也不影响心跳` 抓到）。
    #    `obs` 里已经含 healthy 观测。
    if findings or obs or prev_all:
        # 🔴 按**本轮自己的规则域**收窄。`load_findings` 读的是整个账号所有
        #    finding 行，而 `_in_scope` 只按实例段匹配 —— 不收窄的话
        #    HIGH 轮会把昨天的 gp2_volume 判 miss、IDLE 轮会把 threshold_high
        #    判 miss，而两轮默认都是每天 02:00 扫同一批实例。
        #    见 `assemble.rules_for_run_type` 的完整说明。
        prev = prev_all
        # ⚠️ `evaluated` / `obs` 已经在上面的 region 循环里逐 region 攒好了
        #    （评估集合是 `<region>#<实例>` 形式，观测的 finding_id 带各自的
        #    region 段）。这里**不能**再算一次 —— 那时 `attrs_by_id` 只剩最后
        #    一个 region 的，会把其余 region 的实例全部漏出评估集合，
        #    于是它们的 finding 原地冻结（R6.2），永远不 resolved。
        res = reconcile(
            prev, evaluated, obs,
            today=task.data_date, rule_version=task.config_version,
            dry_run=task.is_dry_run)
        # 🔴 **把「已被移出巡检范围」的那些 finding 关掉**（R1.8，2026-09-01）。
        #
        #    排除是**入口过滤**（`apply_exclusions` 在拉指标之前跑，为的是不给
        #    「别看」的资源付 GetMetricData 的钱），于是被排除的实例掉出了
        #    `evaluated` —— 而 R6.2 对不在评估集合里的 finding 是「原地不动」。
        #    结果它已有的 finding 永久冻在 new/active：既不 resolve 也不消失。
        #    客户原话：「他们等加入到白名单后 为什么仍然显示在findings里面」。
        #
        #    `exit_filter` 只挡本轮**新产出**的，管不到已经落库的行 —— 那道
        #    出口过滤解决的是「排除清单在本轮中途被改动」，不是这件事。
        #
        # ⚠️ 键的形状必须是 `<region>#<实例>`，与 `evaluated` 逐字一致
        #    （`_in_scope` 的 ② 那支）。用裸实例 id 会在多 region 下把另一个
        #    region 的同名实例一起关掉。
        # ⚠️ `already=` 传本轮 reconcile 已经处理过的，否则同一条 finding 拿到
        #    两个 Transition，而 `apply_transitions` 逐条条件写 —— 后写覆盖前写，
        #    结果取决于列表顺序。
        oos = lifecycle_mod.resolve_out_of_scope(
            prev,
            {f"{s.region}#{ref.instance_id}"
             for s in scans for ref, _d in s.excluded},
            today=task.data_date,
            already={t.finding_id for t in res.transitions})
        if oos:
            logger.info("移出巡检范围 → 关闭 %d 条既有 finding: %s",
                        len(oos), [t.finding_id.split("#")[3] for t in oos][:5])
            res = replace(res, transitions=(*res.transitions, *oos))
        if not task.is_dry_run:
            # 判定证据（实测值 / 阈值 / 余量 / 方向 / 金额）随状态一起落库。
            # 🔴 不落的话这些数字只存在于 S3 载荷里，看板卡片上就只有
            #    「CPU 使用率 · CRITICAL」——客户看不到 85% 还是 71%，
            #    也看不到阈值，只能等 1~3 分钟后的 DA 判读全文。
            n_transitions = store.apply_transitions(
                task.account_id, res.transitions, today=task.data_date,
                evidence=asm.to_evidence(findings))
        else:
            n_transitions = len(res.transitions)

    # ── 6.15 / 7.3 / 7.4 排序 → 配额 → task
    # 🔴 **巡检共用部署账号的一个 space；根因调查才是每账号一个。**
    #
    # 两者理由不同：
    #
    # ```
    # 巡检     判读只看我们打包进 payload 的指标 —— DA 不需要进目标账号。
    #          而 skill 是 per agent space 的（Asset API 全部必填 agentSpaceId），
    #          集中一份省得每个账号维护一遍、也不会漂移。
    # 根因调查  要 DA 主动深挖资源，space 必须在那个账号里
    #          （项目约定里的「每业务账户独立 AgentSpace」说的是这一半，
    #           走 da#<id>.agent_space_id）。
    # ```
    #
    # 🔴 `space_id` / `da_target` 由**调用方**（`_run_inspection`）解析好传进来
    #    —— 那里才有 `region`（home）、`skipped`（痕迹要落进去）与 config 表。
    #    在这里解析过一次，撞了 NameError（2026-08-30）。
    #
    # ⚠️ 解析不出来时调用方传 `("", None)` 并已经往 `skipped` 里落了痕迹，
    #    本函数据此不派发（下面 `if space_id:` 那两处）。
    #    **不要在这里补一个 fallback 到 env** —— 见 `da_client.resolve` 的说明。
    run_id = f"{task.run_type.value}#{task.run_date.isoformat()}#{task.account_id}"

    plan, tasks = (None, [])
    if space_id:
        plan, tasks = asm.build_tasks(
            findings, run_type=task.run_type, account_id=task.account_id,
            data_date=task.data_date, run_id=run_id,
            agent_space_id=space_id, tier=tier)
    else:
        # 🔴 **空 space id 时本函数自己也要记 ERROR**，不能只依赖调用方。
        #
        #    改动⑤ 把解析搬到了调用方，我一度顺手把这个分支删了 ——
        #    而 `tests/test_inspection_assemble.py::
        #    test_dispatch_seam_without_space_id_logs_and_sends_nothing`
        #    正钉着它，理由是「静默不派会让『CDK 还没部署 space』表现成
        #    『今天没有风险』」。那条测试直接调本函数，所以信号必须在这里。
        #
        # ⚠️ 与调用方那条 ERROR **不重复**：调用方说的是「为什么解析失败」
        #    （账号没回填 / assume 失败），这里说的是「本轮没派发」——
        #    前者可能压根没跑到（别的调用方直接传空）。
        logger.error(
            "没有巡检 agent space id，本轮不派发任何判读任务。"
            "部署账号看 INSPECT_AGENT_SPACE_ID 有没有注入；"
            "成员账号看 da#<账号>.inspect_agent_space_id 有没有回填"
            "（管理页那一行会显示「待更新栈」）")

    # ── 7.4d 零命中 heartbeat
    hb = None
    if space_id:
        hb = asm.heartbeat_if_empty(
            findings, run_type=task.run_type, account_id=task.account_id,
            data_date=task.data_date, run_id=run_id, agent_space_id=space_id,
            # 全 region 合计。⚠️ 不能用某一个 region 的数 —— heartbeat 正文
            #    里写的是「本轮评估了 N 台、完整度 X」，拿一个 region 的数
            #    会让客户以为只扫了那么点。
            # ⚠️ 用 `collected` 而不是 `judged`。heartbeat 正文写给客户看的是
            #    「本轮评估了 N 台、完整度 X」—— 那句话的语义是采集覆盖面。
            #    用 judged 会在「全是新建实例」这种正常场景下写「评估了 0 台」。
            evaluated=collected_count,
            completeness=completeness(kept_total, collected_count))

    sent = 0
    mapped = 0
    # ⚠️ 判据是 `dispatches_da` 而不是 `not is_dry_run`。两者今天的值不同：
    #    dry_run 轮**照常派 DA**（见 `dispatches_da` 的说明）。
    if task.dispatches_da and (tasks or hb):
        # 🔴 client 由上面的 `da_client.resolve` 给出（改动⑤）：
        #    部署账号 → 本地 client（home region）
        #    成员账号 → assume da#<id>.trigger_role_arn，region 取 da#<id>.region
        #
        # ⚠️ 原来这里是 `boto3.client("devops-agent", region_name=AWS_REGION)`
        #    —— 那个恒指向**部署账号**，成员账号的 space 永远收不到任务。
        #    而 CreateBacklogTask 会以 ResourceNotFoundException 失败，
        #    被逐条 catch 成 dispatch_failed，看板上只显示「N 条未做根因分析」。
        da = da_target
        for req in list(tasks) + ([hb] if hb else []):
            try:
                resp = da.create_backlog_task(**req.to_api_kwargs())
                sent += 1
            except Exception as e:             # noqa: BLE001
                # ⚠️ 一条派发失败不放弃其余：R13.12 要的是逐条落
                #    dispatch_failed，而不是整轮回滚。
                logger.exception("派发 task 失败: %s", e)
                continue

            # ── 7.4b 派发成功 → 落映射 + 预注册 investigation 行
            #
            # ⚠️ `create_backlog_task` 的响应**此前被整个丢弃**，于是
            #    `taskId` 从未被接收。后果不是报错，而是判读结果回不来：
            #    callback 事件里只有 `task_id`，没有映射就无从知道
            #    这段判读属于哪条 finding。表现是报告里有一大段分析，
            #    而每条 finding 旁边都是空的。
            #
            # ⚠️ 必须在**派发成功之后**写。写在调用之前会在 API 失败时
            #    留下一条指向不存在 task 的映射，对账时 `GetBacklogTask`
            #    返回 404，无从判断是「事件丢了」还是「task 压根没建成」。
            task_id = _task_id_of(resp)
            if not task_id:
                # ⚠️ 显式告警而不是静默跳过：拿不到 taskId 意味着这一条的
                #    判读结果**永久无法回拼**，而 task 已经发出去了（会花额度）。
                logger.error(
                    "派发成功但响应里没有 taskId，本条判读将无法回拼: "
                    "findings=%s resp_keys=%s",
                    list(req.finding_ids)[:3], sorted((resp or {}).keys()))
                continue

            is_hb = hb is not None and req is hb
            try:
                store.put_dispatch(
                    task_id, account_id=task.account_id, run_id=run_id,
                    run_type=task.run_type.value, data_date=task.data_date,
                    finding_ids=list(req.finding_ids),
                    agent_space_id=space_id, client_token=req.client_token,
                    is_heartbeat=is_hb)
                mapped += 1
            except Exception as e:             # noqa: BLE001
                logger.exception("写派发映射失败（不阻断其余）: %s", e)

            # 预注册 investigation 行。`source='inspection'` 让 run 级归集
            # 能按来源筛（R5.5a）；**不是**分流主判据 —— 那个是
            # callback 侧读 AWS 给的 `agent_space_id`（R12.5d / 7.12g）。
            preregister_investigation(
                task_id=task_id, execution_id="",
                account_id=task.account_id, account_alias=None,
                title=req.title, source=INSPECTION_SOURCE)

    return {
        "findings": len(findings),
        "rollup_groups": len(groups),
        # ⚠️ 全 region 累加（`dropped_total`）而不是 `len(dropped)` ——
        #    后者是 region 循环里的局部变量，全部 region 都空时压根没绑定。
        "excluded_at_exit": dropped_total,
        "dispatched_tasks": sent,
        # ⚠️ `mapped` 与 `dispatched_tasks` 分开报：两者不等意味着有 task
        #    发出去了却没落映射 → 那些判读回不来。相等才是健康的一轮。
        #    合成一个数字会让这个缺口无法从 run 记录看出来。
        "mapped_tasks": mapped,
        "built_tasks": len(tasks),
        "deferred": plan.deferred_count if plan else 0,
        "transitions": n_transitions,
        "skipped_by_gate": gate_counts,
        "heartbeat": hb is not None,
        "agent_space_id": space_id or "",
        # 🔴 **两个数一起带出去，别合并**（见 region 循环里那段说明）。
        #
        #    collected  采集成功的台数 → run 记录的 actual / completeness
        #    judged     真的下了结论的台数（减掉 R6.2a 的 not_evaluable）
        #
        # ⚠️ `judged` 也要落库：「采到 13 台但一台都判不了」是重要信息
        #    （全是新建实例、或全部指标 NO_DATA），而它与「13 台都健康」
        #    在 completeness 上完全一样。
        #
        # ⚠️ 都是 `<region>#<实例>` 口径的集合大小 —— 跨 region 同名时算两台，
        #    正是我们要的。
        "collected_instances": collected_count,
        "judged_instances": len(evaluated),
        "kept_instances": kept_total,
    }


def _run_inspection(
    store: InspectionStore, task: Task, *, now: datetime, region: str,
    context: Any = None, run_sk: str = "",
) -> dict[str, Any]:
    """一轮巡检的主体。返回写进 run 记录的 stats。

    这里刻意只做**编排**：每一步的判定逻辑都在 `inspection/domain/`，
    IO 都在 `inspection/adapters/`。混进判定会让它无法被单测覆盖
    —— 而这个函数本身需要真 AWS 客户端才能跑。

    ⚠️ **`region` 形参是 scan region，不是 home。** 调用方传的是
    `task.region or home_region`（`handler` 里的 `scan_region`）——
    也就是说手动重跑单 region 时它等于**那个** region。
    我们自己的资源（DDB / config 表 / 巡检 space）恒在 home，
    所以下面另取一个 `home_region`。
    """
    import boto3

    # 🔴 **不要用 `region` 去访问我们自己的资源。**
    #
    #    2026-08-30 踩过一次：判读目标解析写成
    #    `boto3.resource("dynamodb", region_name=region)`，而它在
    #    `if forced_region` 的**分支之外** —— 运维手动重跑单 region 时
    #    去那个 region 找 config 表 → ResourceNotFoundException
    #    （而那条异常的文案里不提 region）→ 那一轮一条判读都不派。
    #
    # ⚠️ 上面 `list_scan_regions(sess, home=region)` 与读 config 表那两处
    #    此前**只是恰好**安全（都在 `else` 分支里，那时 region == home）。
    #    显式取一次比依赖分支位置稳。
    home_region = _env("AWS_REGION", "ap-northeast-1")

    # ⚠️ `pipeline` 在本函数里还有 `apply_exclusions` / `load_resources` 等用途，
    #    不只是构造 InspectionConfig —— 删它会在**真实运行时**才炸
    #    （`NameError: name 'pipeline' is not defined`），因为本函数需要真 AWS
    #    客户端，单测跑不到这一行。踩过一次，真实环境才发现。
    from inspection import pipeline
    # ⚠️ 不再 import `attrs_repo` —— 采集全部走 `pipeline.load_resources`
    #    （见下面那段说明）。留着它只会让人以为「在这里手写一段采集」是
    #    被允许的，而那正是 RDS 内存分母丢失的成因。
    from inspection.adapters import metrics_repo, pricing_table, refdata
    from inspection.adapters import regions as regions_repo
    from inspection.adapters.refdata import StructuralRefData
    from inspection.domain import rule_config as rule_cfg
    from inspection.domain import series as se
    from inspection.domain.schedule import RunType

    # 🔴 **按 task.account_id 取凭证**，不要直接 `boto3.client(...)`。
    #
    # 直接建 client 用的是 Lambda 自身的执行角色（= 部署账号），而
    # `load_rds_attrs(rds, task.account_id, region)` 的 account_id 是
    # **传进去的参数**，不是从 API 响应读的。两者一错开就是：
    #
    # ```
    # onboard 并 enable 账号 B
    #   → scheduler 给 B 扇出 task（task.account_id = B）
    #   → executor 用**部署账号的凭证** describe RDS
    #   → 拿到部署账号的资源，落库时 account_id 写成 B
    #   → 账号 B 的巡检页里全是部署账号的资源
    # ```
    #
    # 不报错、不缺数据，看板上一切正常 —— 只是数据是错账号的。
    # ── 6.2a 要扫哪些 region
    #
    # 🔴 在 2026-08-27 之前这里只有一个 region：`AWS_REGION`。那个变量由 AWS
    #    注入、等于 Lambda 自己所在的 region、**不可配** —— 于是任何不在部署
    #    region 的资源从来没被看到过：
    #
    #    ```
    #    验证账号       4 台 RDS 全在 us-east-1，系统部署在 ap-northeast-1
    #      → expected.instances = 0 → completeness = 0÷0 = 1
    #      → run success → 看板「跑过了、没风险」
    #    ```
    #
    # ⚠️ 一个账号仍然是**一次调用**（一条 SQS 消息）。按 region 扇出成 17 条
    #    消息的方案被否掉了，理由是它会把这些一起乘 17：
    #    DA heartbeat（配额按秒计）、run 记录行数、报告推送、对账的缺行判定。
    #    真正必须分 region 的只有 AWS 客户端本身（us-east-1 实例的指标只存在于
    #    us-east-1），判定 / 状态机 / 派发 / 报告都与 region 无关。
    sess = _session_for(task.account_id)
    skipped: list[str] = []
    # 🔴 `task.region` 非空 = 运维手动重跑，**只扫那一个**。
    #    生产的定时轮不会设它（`InspectionMessage` 没这个字段），所以正常
    #    路径走下面的全量枚举。
    #
    # ⚠️ 收窄时**跳过** `DescribeRegions` —— 既省一次调用，也让「指定的 region
    #    压根没启用」这种情况在后面的 describe 上明确失败，而不是被枚举
    #    结果静默过滤掉（那会让重跑「成功」但一台都没扫）。
    forced_region = (task.region or "").strip()

    # 🔴 **在进线程池之前把四个 service model 灌进 loader 缓存。**
    #
    #    `_discover` 在 worker 线程里调 `sess.client(...)`，而 boto3 官方只保证
    #    **client** 线程安全（clients 那页原文 "Unlike Resources and Sessions,
    #    clients are generally thread-safe"）—— Session 不在其中，resources 页
    #    明写「每个线程建自己的 Session」。botocore 侧 `ComponentLocator`
    #    与 `loaders.instance_cache` 都是裸的 check-then-set（无锁），
    #    它只承诺「不会直接崩」，不承诺不重复构造。
    #
    #    冷缓存下 8 个线程同时 miss 同一个 key 会把同一份 service-2.json
    #    解析最多 8 遍。实测单次峰值：rds 13.1MB / ec2 22.1MB /
    #    elasticache 2.4MB / cloudwatch 1.6MB → 瞬时可达 ~137MB，
    #    而 executor 是 1024MB / 约 0.58 vCPU。
    #
    # ⚠️ 高负载轮最糟：`refdata` 那个分支只有闲置轮才走，所以 HIGH 轮进池之前
    #    rds / elasticache / cloudwatch 三个模型全是冷的（ec2 恰好被
    #    `list_scan_regions` 暖过 —— 那是运气不是设计）。
    #
    # ⚠️ 建完立刻丢：要的只是副作用（模型进缓存）。同时用 `_AWS_CFG` 统一
    #    重试与超时 —— botocore 默认是 legacy 模式（5 次 × 60 秒读超时），
    #    一批撞限流最坏 300 秒，直接吃掉 Lambda 预算。
    for _svc in ("rds", "elasticache", "cloudwatch", "ec2"):
        try:
            sess.client(_svc, region_name=region, config=_aws_cfg())
        except Exception:                                      # noqa: BLE001
            # 预热失败不影响正确性（worker 里还会再建一次），不值得中断本轮。
            logger.warning("预热 %s 客户端模型失败（不影响正确性）", _svc)
    if forced_region:
        scan_list = [forced_region]
        logger.info("手动重跑：只扫 %s（task.region 指定）", forced_region)
    else:
        # 🔴 **读客户配的范围**，不再无条件扫全部（2026-08-29）。
        #
        #    管理页那个「采集 Region」输入框决定它，`*` = 全部。此前这里恒
        #    枚举全部 —— 而那个输入框在界面上是存在的，客户填了 `us-east-1`
        #    之后第二天在报告里看到 eu-west-1 的 finding，会以为配置没生效
        #    （而且他改成什么都没用）。
        #
        # ⚠️ `region` 是 **home region**（config 表是我们自己的资源），
        #    不是被扫的那个 —— 跟着 scan region 走会去别的区找这张表，
        #    撞 ResourceNotFoundException（文案里不提 region）。
        import boto3
        from inspection.adapters import accounts as acct_repo
        scan_all, scoped = acct_repo.scan_region_scope(
            boto3.resource("dynamodb", region_name=home_region).Table(
                _env("CONFIG_TABLE")),
            task.account_id, deploy_account_id=_deploy_account_id())
        if scan_all:
            scan_list = regions_repo.list_scan_regions(
                sess, home=home_region, errors=skipped)
        else:
            scan_list = scoped
            logger.info("账号 %s 的巡检范围按配置收窄到 %d 个 region: %s",
                        task.account_id, len(scan_list), ",".join(scan_list))

    # ── 账号级、与 region 无关的输入：**只取一次**
    exclusions = load_exclusions(store, task.run_type)
    rule_raw = _resolve_rule_config(store, task)
    insp_cfg = rule_cfg.inspection_config(rule_raw, window_days=se.WINDOW_DAYS)
    threshold_cfg = rule_cfg.threshold_config(rule_raw)
    ref = StructuralRefData()
    price_table = None
    if task.run_type is RunType.IDLE:
        # ⚠️ 用 **home region** 的 RDS 客户端拉一次，不逐 region 重复。
        #
        #    `DescribeDBMajorEngineVersions` 与 `DescribeCertificates` 是**区域性
        #    API**（不是全局端点），所以「一份就够」需要证据。2026-08-27 实测
        #    四个 region（ap-northeast-1 / us-east-1 / us-west-2 / sa-east-1）：
        #
        #    ```
        #    aurora-mysql 的 major 版本   5.7 · 8.0 · 8.4          四地逐字相同
        #    CA 证书 id                    ecc384-g1 / rsa2048-g1 /
        #                                  rsa4096-g1               四地逐字相同
        #    ```
        #
        # ⚠️ 残余风险（已知、未处理）：新 major 版本可能先在某个 region 上线。
        #    那时 home region 的表里查不到它 → `refdata` 的契约是「参考数据缺失
        #    即不判定」→ 那台实例的 EOL / 证书临期两类风险**静默不产出**，
        #    而 `load_refdata` 本身是成功的，`skipped` 里没有痕迹。
        #    真要消掉这个盲区得逐 region 拉（17 倍调用）或在版本查不到时落一条
        #    `skipped` —— 后者成本低得多，值得单独做。
        try:
            ref = refdata.load_refdata(sess.client("rds", region_name=region))
        except Exception as e:                 # noqa: BLE001
            skipped.append("refdata:load_failed")
            logger.error("refdata 加载失败，日期类结构性规则本轮失效: %s", e)
        try:
            price_table = pricing_table.load_pricing_table()
        except Exception as e:                 # noqa: BLE001
            skipped.append("pricing_table:load_failed")
            logger.error("价格表加载失败，savings 走关键字兜底并标 coarse: %s", e)

    # ── 6.2 / 6.3 逐 region 发现资源 + 入口过滤（**并发**）
    #
    # ⚠️ 并发而不是串行：零资源的 region 只花 2-3 次 describe 就结束，但 17 个
    #    region 串起来仍是十几秒；而单次 Lambda 只有 15 分钟，那十几秒要留给
    #    真正花时间的 GetMetricData。
    #
    # 🔴 入口过滤放在**拉指标之前** —— 否则为客户说了「别看」的资源付钱。
    def _discover(reg: str) -> "RegionScan":
        r_rds = sess.client("rds", region_name=reg, config=_aws_cfg())
        r_ec = sess.client("elasticache", region_name=reg, config=_aws_cfg())
        r_cw = sess.client("cloudwatch", region_name=reg, config=_aws_cfg())
        r_ec2 = sess.client("ec2", region_name=reg, config=_aws_cfg())
        marks: list[str] = []
        # 🔴 走 `pipeline.load_resources`，不要在这里手写采集顺序。
        #    手写的那版曾漏了「RDS 也要补 memory_bytes」，后果是 R2.1.2 的内存
        #    判定对 RDS 完全失效，而单测全绿（fixture 里 memory_bytes 是硬编码的
        #    32 GiB）。`load_resources` 还负责一个顺序依赖：`enrich_max_connections`
        #    退到规格表公式时要 `memory_bytes`，所以内存必须先补。
        attrs = pipeline.load_resources(
            pipeline.InspectionClients(
                rds=r_rds, elasticache=r_ec, ec2=r_ec2, cloudwatch=r_cw),
            account_id=task.account_id, region=reg, skipped=marks)
        members = expand_rds_clusters(r_rds)
        members.update(expand_elasticache_groups(r_ec))
        sizes = {k: len(v) for k, v in members.items() if v}
        keep, drop = pipeline.apply_exclusions(attrs, exclusions, task.data_date)
        # ⚠️ 降级痕迹带上 region 前缀。不带的话 17 个 region 的
        #    `rds:describe_failed` 在 run 记录里长得一模一样，看不出是哪个。
        return RegionScan(
            region=reg, rds=r_rds, ec=r_ec, cw=r_cw,
            all_attrs=attrs, kept=keep, excluded=drop, cluster_sizes=sizes,
            skipped=[f"{reg}:{m}" for m in marks])

    # 🔴 剩余时间预算。发现阶段给 1/3，采集阶段给剩下的 —— 两个阶段都要
    #    在 Lambda 超时**之前**结束，否则走那条全静默的路：
    #    finish_run 不执行 → 行停 running → 重投抢不到锁 → 消息被删、
    #    不进 DLQ → 对账 `if status == "running": continue`。
    remaining = _remaining_seconds(context)
    scans, discover_failed = _fan_regions(
        _discover, scan_list, what="发现资源",
        deadline_s=(remaining / 3) if remaining else None)
    for sc in scans:
        skipped.extend(sc.skipped)
    # ⚠️ 失败 region 的痕迹**必须**落进 skipped。它们的 `marks` 随对象一起
    #    消失了，所以这里是唯一的记录点。
    skipped.extend(f"region_discover_failed:{f}" for f in discover_failed)

    # ── 8.4 补齐重投：只巡检 `instance_subset` 里那几台（R13.15）
    #
    # 🔴 收窄放在**入口过滤之后**：反过来会让一台「已被客户排除但上一轮漏采」
    #    的实例被补采回来 —— 排除清单是客户的显式意图，补齐不该绕过它。
    if task.instance_subset:
        # 🔴 `wanted` 里的元素可能是裸实例 id（存量形状）也可能是
        #    `<region>#<实例>`。两种都认，但**裸 id 会跨 region** ——
        #    补齐 us-east-1 的 prod-mysql 会连带把东京同名那台收进 kept：
        #    一起付 GetMetricData，而且一起进 `evaluated` → 补齐轮的
        #    `reconcile` 会推进东京那条 finding 的状态机（本轮只该动 us-east-1）。
        #
        # ⚠️ 目前 `instance_subset` 生产上恒为空：`missing_instance_ids`
        #    在全仓**只有读点没有写点**（reconciler 读它，而 `build_stats`
        #    压根没有这个键），所以补齐一律全量。这条断链是存量缺陷，
        #    单独修；这里先把 region 语义做对，免得那条链接上时踩这个坑。
        wanted = set(task.instance_subset)

        def _wanted(a) -> bool:
            return (f"{a.region}#{a.instance_id}" in wanted
                    or a.instance_id in wanted)

        before = sum(len(s.kept) for s in scans)
        for sc in scans:
            sc.kept = [a for a in sc.kept if _wanted(a)]
        got = {f"{a.region}#{a.instance_id}" for s in scans for a in s.kept}
        missing = wanted - got
        logger.info(
            "补齐轮 backfill_run_id=%s：subset %d 台，范围内命中 %d 台"
            "（原范围 %d 台）%s",
            task.backfill_run_id, len(wanted), len(got), before,
            f"，以下不在范围内已跳过: {sorted(missing)}" if missing else "")
        if not got:
            logger.warning(
                "补齐轮 subset 内一台都不在当前范围，本轮无事可做: %s",
                sorted(wanted))

    all_attrs = [a for s in scans for a in s.all_attrs]
    kept = [a for s in scans for a in s.kept]
    excluded = [a for s in scans for a in s.excluded]
    # ⚠️ 集群 id 只在 region 内唯一，所以合并前加 region 前缀 —— 不加会让两个
    #    region 的同名集群共用一个 size，rollup 的分母就错了。
    #    ⚠️ 但 `rollup_candidates` 是**按 region 调**的（见下），它拿到的是那个
    #      region 自己的 `sc.cluster_sizes`，不是这份合并版。这份只用于计数。
    cluster_total = sum(len(s.cluster_sizes) for s in scans)
    with_res = [s.region for s in scans if s.all_attrs]
    logger.info("范围: %d 个 region 里 %d 个有资源（%s）；共 %d 台，"
                "排除 %d 台，剩 %d 台",
                len(scans), len(with_res), ",".join(with_res) or "无",
                len(all_attrs), len(excluded), len(kept))

    # ── 6.4 run 记录 expected
    #
    # 🔴 写在拉指标**之前**：这一行是「本轮打算看几台」的唯一凭据，而拉指标
    #    可能跑 10 分钟或中途超时。先写它，超时的那次也能看出打算做什么。
    expected = {"instances": len(kept), "clusters": cluster_total}
    # 🔴 SK 必须与**抢锁时用的那个**一致（`run_sk`，由 `_process_one` 传下来）。
    #
    #    此前这里写死 `task.account_id`，而锁与 `finish_run` 用的是 `lock_key`
    #    —— 补齐轮那两者不同（`<账号>#bf<n>`）。后果是补齐轮：
    #
    #    ```
    #    put_run   写 SK=<账号>       status=running（**put_item 整行覆盖**）
    #              → 把原轮那行的 stats / status 全抹掉
    #    finish_run 写 SK=<账号>#bf1  只有 stats，没有 expected / data_date
    #    ```
    #
    #    净效果：原轮那行永远停在 `running` → reconciler 的
    #    `if status == "running": continue` 把它跳过 → 那个账号在看板上
    #    「永远正在运行」，而补齐的结果挂在一行读侧不查的伪账号上。
    #
    # ⚠️ 空串兜底成 `task.account_id`（本地跑 / 老调用方），与非补齐轮等价。
    store.put_run(task.run_type.value, task.run_date,
                  run_sk or task.account_id, {
        "status": "running",
        "expected": expected,
        "data_date": task.data_date.isoformat(),
        "source": task.source.value,
        "mode": task.mode.value,
        "tier": task.tier,
        "catch_up": task.catch_up,
        "config_version": task.config_version,
        "window_start": (task.data_date - timedelta(days=se.WINDOW_DAYS - 1)).isoformat(),
        "window_end": task.data_date.isoformat(),
        # 🔴 逐 region 的实例数。没有它，「us-west-2 今天没扫」与
        #    「us-west-2 没有资源」在数据上不可区分 —— 而那正是这次修的
        #    缺陷的形状，只是粒度换成了 region。
        "by_region": {s.region: len(s.kept) for s in scans},
        # 🔴 三个数都要写。只写 `regions_scanned` 的话「本来该扫 17 个」这个
        #    分母读侧拿不到 —— 而失败的 region 在 `by_region` 里**连键都没有**
        #    （不是 0），所以「少了一个 region」从数据上看不出来。
        "regions_total": len(scan_list),
        "regions_scanned": len(scans),
        "regions_failed": sorted(discover_failed),
    })

    # ── 6.5 / 6.6 / 6.7 / 6.8 / 6.9 逐 region 采集（**并发**）
    def _collect(sc: "RegionScan") -> "RegionScan":
        # 没有资源的 region 到此为止 —— 不发 GetMetricData、不查变更事件。
        # ⚠️ 仍然保留这条 RegionScan（`by_region` 要它），只是内容是空的。
        if not sc.kept:
            sc.bundle = metrics_repo.MetricsBundle()
            return sc
        sc.bundle = metrics_repo.collect(
            sc.cw, sc.kept, today=task.data_date + timedelta(days=1))
        ev = ce.collect(sc.rds, service=ce.Service.RDS,
                        start=now - timedelta(days=se.WINDOW_DAYS + 1), end=now)
        ev += ce.collect(sc.ec, service=ce.Service.ELASTICACHE,
                         start=now - timedelta(days=se.WINDOW_DAYS + 1), end=now)
        sc.events = ev
        sc.suppressed = suppression_targets(
            sc.bundle, annotations=ce.annotations_by_instance(ev),
            data_date=task.data_date, se=se)
        rows = series_rows(
            sc.bundle, account_id=task.account_id, region=sc.region,
            config_version=task.config_version,
            backfilled=task.is_backfill,
            backfill_run_id=task.backfill_run_id)
        # 🔴 **SHALL NOT 在这里调 `store.put_series`。**
        #
        #    `store._t` 是 DynamoDB 的 **Table resource**，而 boto3 官方明写
        #    resources 不是线程安全的（resources 那页："Resource instances are
        #    not thread safe and should not be shared across threads or
        #    processes"）。在 8 个 worker 里共用同一个 Table 写库正是那条禁令。
        #
        #    我第一版就是这么写的（为了并行掉 `batch_writer` 的串行开销），
        #    等于把刚修掉的「共享 Session 建 client」换个地方再犯一次。
        #
        # ⚠️ 序列由主线程逐 region 写（见下面 6.9 那段）：写完立刻丢掉 rows，
        #    内存不会按实例总数翻倍；串行时长的风险单独记在那里。
        sc.rows = rows
        return sc

    scans, collect_failed = _fan_regions(
        _collect, scans, what="采集指标",
        deadline_s=_remaining_seconds(context))
    skipped.extend(f"region_collect_failed:{f}" for f in collect_failed)

    # ── 6.9 数值落序列库
    #
    # 🔴 **逐 region 写完立刻丢掉那份 rows**，不要先合并成一个大列表。
    #
    #    `sc.bundle` 与 `sc.rows` 同时活着时内存按实例总数翻倍：实测口径
    #    bundle ≈ 105KB/台、rows ≈ 101KB/台，1000 台 ≈ 210MB，而 executor
    #    是 1024MB（`notiops-backend-stack.ts` 的 memorySize）。bundle 后面
    #    判定还要用，rows 写完就没用了 —— 所以立刻释放它。
    #
    # ⚠️ **在主线程写，不并行。** `store._t` 是 DynamoDB Table resource，
    #    boto3 官方明写 resources 不是线程安全的。要并行得给每个 worker
    #    各建一份 Table resource，那是另一件事。
    #
    # ⚠️ 已知时长风险（未解决，规模到了要处理）：`put_series` 走
    #    `batch_writer`，串行。1000 台 ≈ 504,000 行 ≈ 20,160 次
    #    BatchWriteItem ≈ 160-400 秒，而这是唯一被 region 数乘了却没并行的
    #    一段。`_fan_regions` 的 deadline 只管采集，管不到这里 ——
    #    真撞 15 分钟会走那条全静默的超时路径（见 `_remaining_seconds`）。
    written = 0
    for sc in scans:
        if not sc.rows:
            continue
        written += store.put_series(sc.rows)
        sc.rows = []          # 立刻释放
    if written:
        store.mark_data_batch(task.account_id, task.data_date)

    # ── 6.10~6.15 + 7.3/7.4/7.4d：判定 → 闸门 → 排序 → task
    #
    # ⚠️ 这一段**曾经整段不存在**。2026-08-20 自查发现 `rollup` / `gating` /
    #    `dispatch` / `task_builder` 四个模块写完测完却零生产调用 ——
    #    执行 Lambda 采完指标写完序列库就返回了。那时部署下去巡检会「成功」
    #    但一条 finding 都不产出、一次 DA 都不调，而 run 状态是 success。
    #    接线逻辑放在 `inspection/assemble.py`（纯函数，可单测），
    #    这里只做 IO 与编排 —— 塞在本函数里的逻辑永远没有测试，
    #    上面那个错就是这么来的。
    # 🔴 **判读目标解析**（改动⑤，2026-08-30）：账号 → (巡检 space id, DA client)。
    #
    #    ```
    #    部署账号   env INSPECT_AGENT_SPACE_ID      + 本地 client（home region）
    #    成员账号   da#<id>.inspect_agent_space_id  + assume da#<id>.trigger_role_arn
    #    ```
    #
    # ⚠️ 在这里做而不是在 `_assemble_and_dispatch` 里：这个作用域才有 `region`
    #    （home，config 表在那里）、`skipped`（痕迹要落进去）。
    #
    # ⚠️ 解析失败**不抛**：一个账号解析不出来不该让整轮失败（其余 region 的
    #    采集结果是好的、报告该出）。但要落进 `skipped` —— 那会让终态变 partial
    #    而不是 success，看板上能看出来。
    da_space_id, da_target = "", None
    try:
        from inspection.adapters import da_client as _da_res
        da_space_id, da_target = _da_res.resolve(
            task.account_id,
            deploy_account_id=_deploy_account_id(),
            # 🔴 **home_region**，不是 `region`（那是 scan region）。
            #    巡检 space 与 config 表都在 home。
            home_region=home_region,
            config_table=boto3.resource(
                "dynamodb", region_name=home_region).Table(
                    _env("CONFIG_TABLE")),
            env_space_id=_env("INSPECT_AGENT_SPACE_ID"),
        )
    except Exception as e:                     # noqa: BLE001
        logger.error("判读目标解析失败，本账号不派发任何判读: %s", e)
        skipped.append(
            f"da_target_unresolved:{task.account_id}:{type(e).__name__}")

    # 🔴 **派发前确保那个 space 里有判读 skill**（2026-08-30 补）。
    #
    #    在此之前，生产代码里 `sync_all_skills` 的调用点是 **0** —— 唯一入口是
    #    `scripts/upload_inspection_skills.py`，而它在 `setup.sh` 里只跑一次，
    #    那一刻只有部署账号在库里。**新接入的成员账号永远拿不到判读 skill**。
    #
    #    后果完全静默：space 里没 skill 时 DA **不报错**，它用通用提示词自由发挥
    #    → 切不出 `## <finding_id>` → 每条 finding 的 da_parse_status 都是
    #    parse_failed，而**额度照花、报告照出、run 是 success**。
    #
    # ⚠️ 挂在这里而不是接入流程里：这是「skill 必须已经在」的唯一时刻，而且
    #    对**存量**账号也自愈（接入早于本次改动的那些）。
    # ⚠️ `ensure_skills` 从不抛，失败返回 `failed:...`；那时落进 `skipped`
    #    让终态变 partial —— 否则这一轮的判读会静默退化。
    if da_space_id and da_target is not None:
        from inspection.adapters import skill_upload as _sk

        _sk_status = _sk.ensure_skills(
            da_target, da_space_id, account_id=task.account_id)
        if _sk_status.startswith("failed:"):
            skipped.append(
                f"skill_sync_failed:{task.account_id}:{_sk_status[7:80]}")

    dispatch_stats = _assemble_and_dispatch(
        store, task, scans=scans, exclusions=exclusions,
        insp_cfg=insp_cfg, ref=ref, price_table=price_table,
        # ⚠️ 两个配置对象都要往下传：`insp_cfg` 给闲置轮的三段规则，
        #    `threshold_cfg` 给高负载轮。少传后者等于高负载轮恒用默认阈值。
        threshold_cfg=threshold_cfg,
        space_id=da_space_id, da_target=da_target)

    # ── 6.16 stats（纯函数，见 `build_stats` 的说明）
    # 全 region 合并后的计数。⚠️ 逐项相加/并集，不能拿某一个 region 的
    #    代表全部 —— 那会让 completeness 变成「最后那个 region 的完整度」。
    # 🔴 键必须带 region。`suppression_targets` 的键是 `(实例, 指标)`
    #    （`build_series_from_metric_series` 的 `(ms.instance_id, ms.metric)`，
    #    不含 region），而实例名只在 region 内唯一 —— `dict.update` 是后来者胜。
    #
    #    不加前缀的后果（两个 region 各有一台 prod-mysql，一台被 event 探测器
    #    抑制、一台被 plateau 抑制）：
    #
    #    ```
    #    warmup_suppressed      1   真值 2
    #    suppressed_by_event    0   真值 1     ← 被 plateau 那条覆盖掉了
    #    suppressed_by_plateau  1   真值 1
    #    ```
    #
    #    而 `build_stats` 自己的 docstring 写着「两个探测器分开记 ——
    #    `suppressed_by_event` 突然归零而 by_plateau 顶上时，总数看起来没变，
    #    而那意味着 DescribeEvents 已经完全失效」。这个合并恰好造出那个假信号。
    #
    # ⚠️ 判定本身不受影响（`judge_findings` 拿的是逐 region 的 `sc.suppressed`），
    #    坏的只有 run 记录与 CloudWatch 打点 —— 也就是唯一能发现「事件采集坏了」
    #    的那个信号。
    merged_suppressed: dict[tuple[str, str], str] = {}
    for s_ in scans:
        for (iid, metric), who in s_.suppressed.items():
            merged_suppressed[(f"{s_.region}#{iid}", metric)] = who
    return build_stats(
        dispatch=dispatch_stats,
        expected_instances=expected["instances"],
        expected_clusters=expected["clusters"],
        # ⚠️ 用 **collected**（采集成功的台数），不是 judged。
        #    `actual.instances` 与 `completeness` 回答的是「采集覆盖了多少」；
        #    用 judged 会让「13 台新建实例、coverage 不够判」变成
        #    `actual=0` → status=failed，而那一轮其实成功采到了 13 台。
        #    judged 单独落在 `dispatch.judged_instances`。
        evaluated_instances=int(dispatch_stats.get("collected_instances", 0)),
        series_written=written,
        gaps=tuple(g for s_ in scans for g in s_.bundle.gaps),
        batches_failed=sum(s_.bundle.batches_failed for s_ in scans),
        suppressed=merged_suppressed,
        change_event_count=sum(len(s_.events) for s_ in scans),
        excluded=len(excluded),
        dry_run=task.is_dry_run,
        regions_total=len(scan_list),
        # ⚠️ 两个阶段的失败都算：发现阶段缩分母（静默），采集阶段掉
        #    completeness（可见）—— 但两者都该让 status 落 partial。
        regions_failed=[*discover_failed, *collect_failed],
        # 降级痕迹。⚠️ 不传的话 refdata / 价格表失败在 run 记录里毫无痕迹，
        #    而那时「证书临期」「引擎 EOL」两类风险本轮全部为空。
        skipped=skipped,
    )


# ---------------------------------------------------------------------------
# 按需判读（`{"manual_judge": {...}}` 直接 invoke）
# ---------------------------------------------------------------------------


def _handle_manual_judge(req: dict[str, Any], context: Any) -> dict[str, Any]:
    """给一条 finding 派一次 DA 判读。**同步**返回结果。

    入参（BFF 拼的）：

    ```
    account_id     必填
    finding_id     必填
    operator_note  可选，运维在界面上手填的一句背景
    locale         可选，默认 zh
    ```

    返回：`{"ok": true, "task_id": …, "agent_space_id": …}`
    或 `{"ok": false, "code": …, "message": …}`。

    🔴 **不抛异常。** 这条路是同步 invoke，抛出去调用方拿到的是
       `Unhandled` + 一段 Python traceback，而 BFF 会把它当 500 转给前端 ——
       客户看到「深入分析失败」而看不出是「这条已经派过了」还是真故障。
       所有失败都落成带 `code` 的结构化结果。

    ⚠️ **不碰 run 记录**：不抢锁、不 `put_run`、不进 completeness。
       走 run 流水线会占掉当天的巡检槽位（见 `Task.is_dry_run` 的第 ③ 条），
       也就是「点一次深入分析 → 当天的正式定时轮不再执行」。

    ⚠️ **照样受 kill switch 管**。那个开关是急停而不是省钱护栏 ——
       拉停的场景通常就是「DA 那边在出问题」，那时仍然允许有人一条条点着派，
       等于开关没关上。
    """
    from inspection import manual_judge as mj

    account_id = str(req.get("account_id") or "").strip()
    finding_id = str(req.get("finding_id") or "").strip()
    if not account_id or not finding_id:
        return {"ok": False, "code": "bad_request",
                "message": "缺 account_id 或 finding_id"}

    table_name = _env("INSPECTION_TABLE")
    config_table_name = _env("CONFIG_TABLE")
    if not table_name or not config_table_name:
        return {"ok": False, "code": "internal",
                "message": "缺 INSPECTION_TABLE / CONFIG_TABLE"}

    import boto3

    home_region = _env("AWS_REGION", "ap-northeast-1")
    ddb = boto3.resource("dynamodb", region_name=home_region)
    store = InspectionStore(ddb.Table(table_name))
    config_table = ddb.Table(config_table_name)

    # ── kill switch（急停，不是省钱护栏）──
    from inspection.adapters import switches
    if not switches.is_enabled(config_table, switches.Switch.INSPECTION):
        return {"ok": False, "code": "kill_switch",
                "message": "巡检已被 kill switch 停用 —— 判读派发也一起停了。"
                           "打开 appconfig#inspection/enabled 之后再试。"}

    deploy_account_id = _env("DEPLOY_ACCOUNT_ID")
    if not deploy_account_id:
        # 🔴 `DEPLOY_ACCOUNT_ID` **恒有值**（CDK 注入）。缺了说明部署有问题，
        #    而它决定 `resource_reachable` —— 猜错会让 skill 对成员账号的库
        #    说「PI 没开」这种假话。所以宁可失败。
        return {"ok": False, "code": "internal",
                "message": "缺 DEPLOY_ACCOUNT_ID（CDK 注入的，缺了说明部署有问题）"}

    try:
        result = mj.dispatch_manual_judge(
            store=store,
            config_table=config_table,
            account_id=account_id,
            finding_id=finding_id,
            deploy_account_id=deploy_account_id,
            home_region=home_region,
            describe_attrs=_make_describe_attrs(),
            operator_note=str(req.get("operator_note") or ""),
            locale=str(req.get("locale") or "zh"),
            env_space_id=_env("INSPECT_AGENT_SPACE_ID"),
        )
    except mj.ManualJudgeError as e:
        logger.warning("按需判读被拒: account=%s finding=%s code=%s: %s",
                       account_id, finding_id, e.code, e)
        return {"ok": False, "code": e.code, "message": str(e)}
    except Exception as e:                                 # noqa: BLE001
        # ⚠️ 兜住一切。同步 invoke 抛出去 = BFF 拿 500 + traceback，
        #    而前端只能显示「失败」。
        logger.exception("按需判读失败: account=%s finding=%s", account_id, finding_id)
        return {"ok": False, "code": "internal", "message": f"{type(e).__name__}: {e}"}

    return {
        "ok": True,
        "finding_id": result.finding_id,
        "account_id": result.account_id,
        "task_id": result.task_id,
        "agent_space_id": result.agent_space_id,
        "payload_chars": result.payload_chars,
    }


def _make_describe_attrs():
    """造一个 `(account, region, service, instance) -> ResourceAttrs | None`。

    🔴 复用 `attrs_repo.load_*_attrs` 而**不自己写一份 describe**。
       那两个函数产出的 `ResourceAttrs` 里有 `multi_az` / `maxmemory_policy` /
       `memory_bytes` / 副本关系 —— 正是 skill 判「是不是 standby、是不是有
       理由地闲着」的依据。自己写一份必然只填几个字段，而缺的那些在载荷契约里
       都有登记（`attrs_section()`），于是 skill 会去读一个永远是 null 的字段。

    ⚠️ 代价是它们**列全区再过滤**（`describe_db_instances` 无过滤参数，
       ElastiCache 同）。对单条 finding 略重，但比重写一份 describe 安全得多：
       两份实现分叉的表现是「批量判读看到 multi_az=true、手动判读看到 null」，
       而同一台机器同一天两个结论。

    ⚠️ 跨账号 assume 走既有的 `_session_for`（它带账号段校验 ——
       `role_arn` 的账号段必须等于目标账号，见 `shared.account_scope`）。
    """
    from inspection.adapters import attrs_repo

    def describe(account_id: str, region: str, service: str,
                 instance_id: str):
        sess = _session_for(account_id, region)
        svc = (service or "").lower()
        errors: list[str] = []
        if svc in ("rds", "aurora"):
            rows = attrs_repo.load_rds_attrs(
                sess.client("rds", region_name=region), account_id, region,
                errors=errors)
        elif svc == "elasticache":
            rows = attrs_repo.load_elasticache_attrs(
                sess.client("elasticache", region_name=region), account_id, region,
                errors=errors)
        else:
            raise RuntimeError(f"不支持的 service: {service!r}")
        if errors:
            # ⚠️ describe 的部分失败**不能**静默：少一台的表现是下面返回 None，
            #    调用方报「资源不存在」——而真相是「我们没权限看它」。
            logger.warning("按需判读 describe 有部分失败: %s", errors[:3])
        for a in rows:
            if a.instance_id == instance_id:
                return a
        return None

    return describe
