"""IM 侧「这个会话在问哪个 AWS 账号」的解析 —— **0 token**，纯 DDB。

一句话：**账号上车统一在 Web，选哪个账号 Web 和 IM 各自独立控制。**

三条不变量（改这个文件之前先读完）：

1. **IM 对账号注册表只读。** 上车 / 启用 / 停用的唯一写入方是
   `bff/web-chat/member_accounts.mjs`（Web）。本模块只 Query，一条写路径都没有 ——
   这既是产品决策（N1），也让「IM 侧被 prompt injection 骗着去上车一个账号」这类问题
   在结构上不存在。

2. **Web 是唯一真源，所以每次都去校验。** 偏好里躺着的账号号如果在 Web 上被停用 /
   下车了，必须**立刻**失效（回落到部署账号），不能因为 IM 缓存了一份就还能继续问。
   代价是"设过偏好的会话"每条消息多一次 GSI1 Query；**没设过偏好的会话（绝大多数）
   在读到空偏好时就短路返回**，一次 Query 都不多。

3. **`allowed_accounts` fail-closed。** 注册表读失败时退化成"只有部署账号"，
   **不是**退化成 `"*"`（全开）。这一条是 §4.2 的落点：agent 侧
   （`agent-build/.../main.py::_resolve_acct`）拿 `allowed != "*"` 当闸门开关，
   传 `"*"` 等于把可见性闸门整个拆掉。

⚠️ 这里**不做**任何"这个账号接没接 DevOps Agent"的判断 —— 那是
`core/devops_agent.py::_client_and_space` 的活儿，它自己会 AssumeRole 并在拿不到
Agent Space 时走 `_not_onboarded`。多写一份只会让两处判据漂移。
"""
from __future__ import annotations

import logging

from core import im_prefs
from shared import account_scope

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 部署账号 / 闸门
# ---------------------------------------------------------------------------
def locked_account_id() -> str | None:
    """`LOCKED_ACCOUNT_ID`（单账号部署 = 部署账号；org 模式 = None）。

    **委托给 `shared.account_scope`**，不在这里再读一次环境变量：那个模块的 docstring
    记录着"闸门只设在真正会发起跨账号调用的执行路径上、绝不下沉到通用查询层"这条决策，
    自己读一遍 env 就是第二份实现，迟早跟它漂。
    """
    return account_scope.locked_account_id()


def is_locked() -> bool:
    """这套部署是不是锁死在单账号（= 非 org 模式）。锁死时 `/account <别的>` 必须拒绝。"""
    return account_scope.is_cross_account_disabled()


#: `deploy_account_id()` 的容器级缓存。`None` = 还没问过。
#: **只缓存成功的结果**（见下面函数的说明）。
_DEPLOY_CACHE: str | None = None


def _reset_deploy_cache() -> None:
    """清掉部署账号缓存。**只给测试用**（生产里没有任何合法理由调它）。"""
    global _DEPLOY_CACHE
    _DEPLOY_CACHE = None


def deploy_account_id() -> str:
    """部署账号号。拿不到返回空串（**不抛** —— 这是展示路径，不是执行路径）。

    与 `core/devops_agent.py::_deploy_account_id` 同一个实现（锁定值优先，否则 STS）：
    直接借它的，免得两处对"部署账号是谁"给出不同答案。

    ── 为什么在这一层加缓存（2026-09-07）────────────────────────────────────
    org 模式下 `LOCKED_ACCOUNT_ID` 是空的，那个函数每次都会打一次 **STS
    `GetCallerIdentity`**。2026-09-07 起卡片落款也要显示账号号
    （`platforms/common/im_footer.py`），而落款会被 `LiveCard.flush` **每几秒**
    渲染一次 —— 不缓存就等于把一次 AWS 调用塞进渲染循环。

    缓存到**容器生命周期**是安全的：部署账号就是这个 Lambda 自己所在的账号，
    进程活着的时候它不可能变。

    ⚠️ **只缓存非空结果**。STS 偶发失败（限流 / 冷启动时网络还没好）返回的空串
    如果也被缓存，一次抖动就会让这个容器**余生**都显示不出账号号 —— 一个 5 秒的
    故障变成一个小时的故障。这是"缓存失败值"这个经典坑，别把它当成小优化删掉。
    """
    global _DEPLOY_CACHE
    if _DEPLOY_CACHE:
        return _DEPLOY_CACHE
    try:
        from core import devops_agent
        acct = str(devops_agent._deploy_account_id() or "")
    except Exception as e:                        # noqa: BLE001
        logger.warning("im_accounts.deploy_account_id failed: %s", type(e).__name__)
        return ""
    if acct:
        _DEPLOY_CACHE = acct
    return acct


# ---------------------------------------------------------------------------
# 注册表（只读）
# ---------------------------------------------------------------------------
def list_selectable() -> list[dict]:
    """Web 上已启用的账号（注册表 `enabled=True` 的行）。**永不抛** —— 读不到返回 `[]`。

    返回的是注册表原始 item（`account_id` / `name` / `enabled` / …），调用方自己取字段。
    不含部署账号本身（部署账号不需要上车），所以展示时要单独把它列在最前面。
    """
    try:
        from shared.queries import accounts as accounts_q
        items = accounts_q.list_accounts(enabled_only=True)
    except Exception as e:                        # noqa: BLE001
        # 表不存在 / 没权限 / CONFIG_TABLE 没注入 —— 全部按"注册表里什么都没有"处理。
        # **不许静默当成全开**：调用方（`allowed_accounts`）据此退化成只有部署账号。
        logger.warning("im_accounts.list_selectable failed: %s", type(e).__name__)
        return []
    out: list[dict] = []
    for it in items:
        acct = str(it.get("account_id") or "").strip()
        if im_prefs.is_account_id(acct):
            out.append(it)
    return out


def selectable_ids() -> list[str]:
    """`list_selectable()` 的账号号列表，已排序、已去重。"""
    return sorted({str(it.get("account_id") or "").strip()
                   for it in list_selectable()})


# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------
def resolve(*, platform: str = "", chat_id: str = "", user_id: str = "",
            is_dm: bool = False) -> str:
    """本轮的目标账号号。**空串 = 部署账号**（`ImMessage.account_id` 的契约）。

    每条消息都会调，所以顺序刻意是"先便宜后贵"：

      1. 读偏好（1 次 GetItem）。没设过 → 直接 `""`，**不查注册表**。
      2. 锁定部署（非 org 模式）→ 除了锁定账号本身以外一律 `""`。
      3. 拿去注册表校验（1 次 GSI1 Query）。Web 上已经停用 / 下车 → `""`。

    第 3 步的回落**不删偏好行**：`/account` 要能看出"你选的那个已经失效了"并明说
    （删掉的话用户只会看到"当前是部署账号"，不知道为什么变了）。自愈的实际动作留给
    用户下一次显式切换。
    """
    pref, _src = im_prefs.resolve_account(
        platform=platform, chat_id=chat_id, user_id=user_id, is_dm=is_dm)
    if not pref:
        return ""

    locked = locked_account_id()
    if locked is not None:
        if pref != locked:
            # 单账号部署里躺着一个跨账号偏好 —— 可能是先在 org 模式下选的、后来改回单账号
            # 部署。**照实回落**，不是假装成功。
            logger.info("im_accounts.resolve: pref dropped by LOCKED_ACCOUNT_ID gate")
        return ""

    if pref not in selectable_ids():
        logger.info("im_accounts.resolve: pref not in enabled registry — fell back")
        return ""
    return pref


def is_stale(account_id: str) -> bool:
    """偏好里这个账号号现在还能不能用（给 `/account` 的"已失效"提示用）。

    空串（= 部署账号）永远不算失效。
    """
    a = (account_id or "").strip()
    if not a:
        return False
    locked = locked_account_id()
    if locked is not None:
        return a != locked
    return a not in selectable_ids()


# ---------------------------------------------------------------------------
# 可见性闸门
# ---------------------------------------------------------------------------
def allowed_accounts() -> str:
    """交给 NotiOps Agent 的可见账号清单（逗号分隔）。**永不为空、永不是 `"*"`**。

    取值 = 部署账号 + 注册表里 `enabled=True` 的账号。agent 侧的消费点是
    `agent-build/NotiOpsWebChat/app/NotiOpsWebChat/main.py::_resolve_acct`：
    `allowed != "*"` 时任何不在清单里的 `account_id` 直接被拒。

    ⚠️ **fail-closed**：注册表读不到时返回的是"只有部署账号"，而不是 `"*"`。
    传 `"*"` 会让 agent 侧那道闸门整体失效（`build_payload` 的历史默认值就是 `"*"`，
    在 `account_id` 恒为空的年代无害，现在不是了）。
    """
    ids: list[str] = []
    deploy = deploy_account_id()
    if deploy:
        ids.append(deploy)
    locked = locked_account_id()
    if locked is not None:
        # 单账号部署：清单里只该有那一个。注册表里有别的也不给看。
        return locked
    for acct in selectable_ids():
        if acct not in ids:
            ids.append(acct)
    if not ids:
        # 连部署账号都拿不到（STS 失败）。返回一个**永不匹配**的哨兵而不是空串 ——
        # 空串会被 `build_payload` 的 `or "*"` 翻回全开。
        logger.error("im_accounts.allowed_accounts: no deploy account — fail closed")
        return "none"
    return ",".join(ids)


__all__ = ["allowed_accounts", "deploy_account_id", "is_locked", "is_stale",
           "list_selectable", "locked_account_id", "resolve", "selectable_ids"]
