"""已上车账号的读取（R1.1）。

## 为什么单独一个模块而不是放进 `InspectionStore`

账号清单在 **config 表**（`da#<account>` / `SK=meta`），不在 `notiops-inspection`。
`InspectionStore` 包的是后者一张表 —— 把跨表读取塞进去，下一个人会以为
`da#` 行也在巡检表里，然后写出一条永远查不到东西的 query（不报错，返回空列表，
表现为「今天一个账号都没巡检」）。

## 为什么走 GSI1 而不是 Scan

CDK 给这些行写了 `GSI1PK = "da#accounts"` / `GSI1SK = <account_id>`，
`api/routes/devops_agent.py::_list_accounts` 已经在用这条索引。复用同一条路径，
避免两处对「怎么列账号」有不同答案。
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

logger = logging.getLogger(__name__)

DA_GSI1PK = "da#accounts"
"""与 `api/routes/devops_agent.py::_DA_GSI1PK` 及 CDK 里的写入值同源。"""

GSI1 = "GSI1"


def _is_enabled(item: Mapping[str, Any]) -> bool:
    """`enabled` 缺省视为**启用**。

    ⚠️ 缺省视为禁用会让老数据（`enabled` 字段是本 feature 之后才加的）
    全部被静默跳过 —— 表现是升级后巡检突然一个账号都不跑。
    """
    v = item.get("enabled")
    if v is None:
        return True
    if isinstance(v, str):
        return v.strip().lower() not in ("false", "0", "no", "")
    return bool(v)


def _is_active(item: Mapping[str, Any]) -> bool:
    """只要 `onboarding_status` 不是明确的失败态就算可巡检。

    ⚠️ 不用白名单式的 `== "active"`：`onboarding_status` 的取值散落在
    onboarding 的多个阶段，写死一个值会让处在中间态的账号被漏掉，
    而漏掉是静默的。
    """
    return str(item.get("onboarding_status") or "").lower() not in (
        "failed", "disabled", "removed",
    )


def _da_items(config_table: Any) -> list[dict[str, Any]]:
    """`GSI1PK = "da#accounts"` 的全部行，**分页取完**。

    🔴 **分页不能省。** 同一条 GSI 在本仓库有三处查询实现，其中两处
    （`api/routes/devops_agent.py::_list_accounts`、
    `bff/web-chat/devops_agent_skills.mjs` 的那条）**不翻页** ——
    账号数一多就静默漏掉尾部账号。漏掉的后果按调用方不同：
    扇出那边是「那个账号今天没巡检」，callback 分流那边是
    「那个账号的判读被误判成排障、整批丢掉」。两个都不报错。

    ⚠️ 抽成共用函数是为了让 `enabled_accounts` 与 `inspect_space_ids`
    **不可能**对「哪些账号算数」给出不同答案。两个各写一遍 query 的话，
    第一个改了过滤条件而第二个没改时，会出现「扇出跑了它、分流不认它」
    这种组合 —— 表现就是那个账号的判读永久回不来，而且钱已经花了。
    """
    from boto3.dynamodb.conditions import Key

    items: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {
        "IndexName": GSI1,
        "KeyConditionExpression": Key("GSI1PK").eq(DA_GSI1PK),
    }
    while True:
        resp = config_table.query(**kwargs)
        items.extend(resp.get("Items", []))
        nxt = resp.get("LastEvaluatedKey")
        if not nxt:
            break
        kwargs["ExclusiveStartKey"] = nxt
    return items


def is_callback_authorized(item: Mapping[str, Any]) -> bool:
    """callback 跨账号取判读正文的授权判据 —— **单一真源**（2026-09-04）。

    🔴 这是一道**安全边界**，与上面 `_is_enabled` / `_is_active` 的宽松判据
    **刻意不同**，不许合并、不许放宽：

    ```
    派发侧（enabled_accounts）   黑名单式宽松 —— 升级来的老行（enabled
                                 缺失 / status 中间态）要继续巡检
    callback 侧（这里）          白名单式严格 —— `active` + `enabled is True`
    ```

    严的这半有完整的攻击链论证（`devops_agent_callback/handler.py` 2026-08-30
    收紧那段注释）：config 表最弱的写入口能为任意账号建 `deployed` 且
    **不写 enabled** 的行 → 宽判据会放行它 → 我们 assume 进攻击者写的
    信任策略的角色。`enabled is True` 的身份比较正是拦它的那一格 ——
    改成 `_is_enabled`（缺失当启用）等于把门重新打开。

    ⚠️ 两侧判据不等的代价是一个**缺口**：落在缝里的行（`deployed` /
    enabled 缺失 / enabled 是字符串 `"true"`）会被派发（花钱）而正文取不
    回来（报告空）。那个缺口由 `dispatch_gap_accounts` 在派发侧点名，
    不靠放宽这里来消除。
    """
    return bool(
        str(item.get("onboarding_status") or "").strip().lower() == "active"
        and item.get("enabled") is True)


def enabled_accounts(config_table: Any) -> list[str]:
    """列出该巡检的账号 ID。

    ⚠️ 返回**排序后去重**的列表 —— R14 要求同输入同输出，
    而 DDB 的 query 顺序只在同一 PK 内有保证。
    顺序不稳会让 fan-out 的批划分每轮不同，排障时对不上。
    """
    out: set[str] = set()
    gap: list[str] = []
    for it in _da_items(config_table):
        if not _is_enabled(it) or not _is_active(it):
            continue
        acct = str(it.get("account_id") or "").strip()
        if acct:
            out.add(acct)
            # 🔴 派得出去、取不回来 —— 落在两侧判据缝里的行要**点名**。
            #    这种账号每一轮都会被派发 DA 判读（花钱），而 callback 的
            #    安全闸门拒绝跨账号取正文 → 每条都收敛到 parse_status=empty，
            #    客户看到「判读回来了但没有内容」，真因在 finding 侧完全
            #    看不到。修法不是放宽 callback（那是安全边界），而是把
            #    这行修成 `active` + `enabled=true(BOOL)`。
            if not is_callback_authorized(it):
                gap.append(acct)
    if gap:
        logger.warning(
            "⚠️ %d 个账号会被派发但判读正文取不回来（不满足 callback 的 "
            "active+enabled 判据）：%s —— 每轮白花判读额度且报告恒空。"
            "去把 da#<账号>/meta 修成 onboarding_status=active + "
            "enabled=true(BOOL)，或 disable 它", len(gap), sorted(gap))
    if not out:
        logger.warning("没有可巡检的账号（GSI1PK=%s 无启用行）", DA_GSI1PK)
    return sorted(out)


def inspect_space_id(config_table: Any, account_id: str) -> str:
    """读某账号的巡检 agent space id。

    ⚠️ 读的是 `inspect_agent_space_id` 这个**新字段**，
    不是 `agent_space_id`（那是排障 space）。拿错会把巡检调查派进排障 space
    —— 那里没有判读 skill，DA 会用通用提示词自由发挥，输出格式对不上解析器。
    """
    resp = config_table.get_item(Key={"PK": f"da#{account_id}", "SK": "meta"})
    item = resp.get("Item") or {}
    return str(item.get("inspect_agent_space_id") or "")


def inspect_space_ids(config_table: Any) -> dict[str, str]:
    """全部可巡检账号的巡检 space id → `{账号: space_id}`。

    callback 分流用它：per-account agent space 之后判据不再是「等于那一个
    space id」，而是「在这 N 个里」。

    ⚠️ 只收**非空**的 `inspect_agent_space_id`。空串进集合会让判据变成
    「事件里没有 space id 也算巡检」（`callback_route.space_id_of` 取不到时
    返回空串）—— 那会把排障事件误判成巡检，白跑一次 Bedrock 摘要、写错
    S3 前缀，还会让客户收不到排障卡片。

    ⚠️ 与 `enabled_accounts` 共用 `_da_items`，所以「哪些账号算数」两边恒一致。
    🔴 两边不一致的组合是最坏的：扇出跑了那个账号（花 GetMetricData、派 DA），
       而分流不认它的 space → 判读回来被判成排障 → 那些钱白花。

    🔴 **不缓存。** 缓存的失效条件是「新接入了账号」，而那一刻新账号的
    第一批判读会被误判成排障、静默丢掉。callback 的频率是每账号每天几条，
    一次 GSI 查询完全可接受。

    ⚠️ 读失败**不吞**（这里不 catch，让异常穿出去）。调用方的处置见
    `devops_agent_callback/handler.py::_inspect_space_ids` —— 结论是让
    Lambda 失败进 DLQ，因为事件可以重投，而误判成排障是不可逆的
    （那条 finding 的判读永久空着）。
    """
    out: dict[str, str] = {}
    for it in _da_items(config_table):
        if not _is_enabled(it) or not _is_active(it):
            continue
        acct = str(it.get("account_id") or "").strip()
        sid = str(it.get("inspect_agent_space_id") or "").strip()
        if acct and sid:
            out[acct] = sid
    if not out:
        logger.warning(
            "没有任何账号登记了 inspect_agent_space_id —— callback 分流将只认 "
            "env 里那一个 space。成员账号的判读会被判成排障（静默丢掉）")
    return out


# ---------------------------------------------------------------------------
# 跨账号采集凭证（R1.1 的多账号那一半）
# ---------------------------------------------------------------------------

ACCOUNT_PK_PREFIX = "account#"
"""跨账号字段所在的记录前缀。

🔴 **不是 `da#`。** config 表里有**两套**账号记录，分工不同：

```
account#<id>/meta   GSI1PK="accounts"      onboard 写入
                    role_arn / regions / enabled / org_onboard_status
                    → 跨账号采集凭证从这里来

da#<id>/meta        GSI1PK="da#accounts"   DevOps Agent 关联写入
                    agent_space_id / inspect_agent_space_id / trigger_role_arn
                    → `enabled_accounts()` 读这里决定「巡检哪些账号」
```

两条记录都要在，一个账号才真的可巡检：
`da#` 决定「跑不跑它」，`account#` 决定「用什么凭证进去」。

⚠️ `da#` 行上**没有** `role_arn`（实测确认），去那里找只会永远拿到空串 ——
而空串的语义是「用 Lambda 自身角色」，于是成员账号会被用**部署账号的凭证**
去 describe。那不会报错，但会把部署账号的资源落库成成员账号的（见
`handler._session_for` 的说明）。
"""


def account_role_arn(config_table: Any, account_id: str) -> str:
    """某账号的跨账号采集角色 ARN。**空串 = 用调用方自身凭证**。

    部署账号的 onboard 记录由 CDK Custom Resource 写入，不含 `role_arn`
    （那是跨账号字段）—— 所以对它返回空串是正确的，不是「读失败」。

    ⚠️ 读不到记录也返回空串。这一层不区分「没这条记录」与「记录里没这个字段」：
    两者对调用方都是「没有跨账号凭证可用」，而**调用方必须自己判断
    account_id 是不是部署账号**（`handler._session_for` 那里做的）——
    在这里判会让本模块依赖运行环境。
    """
    try:
        resp = config_table.get_item(
            Key={"PK": f"{ACCOUNT_PK_PREFIX}{account_id}", "SK": "meta"})
    except Exception as e:                                 # noqa: BLE001
        # 读失败**不吞成空串**就地抛 —— 空串会静默退化成「用自身凭证」，
        # 那是错凭证访问错账号。宁可让本轮失败。
        raise RuntimeError(
            f"读 {ACCOUNT_PK_PREFIX}{account_id} 的 role_arn 失败: "
            f"{type(e).__name__}: {e}") from e
    return str((resp.get("Item") or {}).get("role_arn") or "").strip()


# ---------------------------------------------------------------------------
# 巡检的 region 范围（2026-08-29）
# ---------------------------------------------------------------------------

ALL_REGIONS = "*"
"""`regions` 里出现这个值 = 扫全部 region。

⚠️ 这是个**共用字段**上的哨兵值 —— 老采集链路（`lambda1_collector`）也读
`account#<id>.regions`，而它是 `for region in account.regions` 直接建客户端。
`lambda1_collector/accounts.py` 里已经把 `*` 滤掉了（那一段有注释说明），
新增读点时记得同样处理，否则会去建一个 region 名叫 `*` 的客户端。
"""

REGION_RE = __import__("re").compile(r"^[a-z]{2}(-[a-z]+)+-\d$")
"""region 名的形状。写侧（BFF）也校验一次 —— 这里是读侧的兜底。"""

DEFAULT_SCAN_REGIONS: tuple[str, ...] = ("us-east-1",)
"""成员账号没配过时的默认范围。

⚠️ 与「全部 region」**刻意不同**。默认扫全部的代价是客户接一个账号进来就
自动开始扫他 17 个 region 的资源（GetMetricData 按请求指标数计费），
而他可能只关心一两个区。默认窄、要全部得显式填 `*`。
"""


def scan_region_scope(
    config_table: Any, account_id: str, *, deploy_account_id: str = "",
) -> tuple[bool, list[str]]:
    """这个账号的巡检 region 范围 → `(要不要扫全部, 显式列表)`。

    ```
    部署账号自己              → (True, [])              恒扫全部，没有 UI 可配
    regions 含 "*"           → (True, [])              客户填了 *
    regions 非空             → (False, [...])          就扫这些
    都没有                    → (False, ["us-east-1"])  读时默认
    ```

    ⚠️ `*` 与具体 region 混在一起时（`us-east-1,*`）**按全部算** —— 全部是
    具体列表的超集，取交集反而会让「多填了一个 *」表现成「只扫那一个」。

    ⚠️ 部署账号那条分支是刻意的（2026-08-29 决定）：它不在
    `listMemberAccounts` 返回的列表里（那个函数把自己排除了），所以没有
    UI 行可以配它。恒扫全部 = 保持改造前的行为，不引入一个「配不了但会
    影响行为」的隐藏设置。

    ⚠️ 读失败**抛**，不吞成默认值。吞掉的后果是「配置读不到」表现成
    「客户只配了 us-east-1」—— 而那与真的只配了 us-east-1 无法区分。
    """
    acct = str(account_id or "").strip()
    if acct and acct == str(deploy_account_id or "").strip():
        return True, []
    try:
        resp = config_table.get_item(
            Key={"PK": f"{ACCOUNT_PK_PREFIX}{acct}", "SK": "meta"})
    except Exception as e:                                     # noqa: BLE001
        raise RuntimeError(
            f"读 {ACCOUNT_PK_PREFIX}{acct} 的巡检 region 范围失败: "
            f"{type(e).__name__}: {e}。吞成默认值会让「配置读不到」"
            "表现成「客户只配了 us-east-1」，两者无法区分。"
        ) from e
    item = resp.get("Item") or {}
    raw = item.get("regions") or []
    out: list[str] = []
    bad: list[str] = []
    for r in raw:
        s = str(r or "").strip().lower()
        if not s:
            continue
        if s == ALL_REGIONS:
            return True, []
        (out if REGION_RE.match(s) else bad).append(s)
    if bad:
        # ⚠️ 打错的 region 直接**跳过并告警**，不让它进扫描列表 ——
        #    进去之后 describe 会失败，而失败会被记成「那个 region 采集失败」，
        #    看起来像 AWS 侧的问题，而真相是名字打错了。
        logger.error("账号 %s 的 regions 里有形状不对的值，已跳过: %s",
                     acct, sorted(set(bad)))
    if not out:
        return False, list(DEFAULT_SCAN_REGIONS)
    # 去重 + 排序：R14 要求同输入同输出
    return False, sorted(set(out))
