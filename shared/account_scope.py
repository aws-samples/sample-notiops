"""账号作用域守卫 —— 把所有跨账号行为锁死在【单一账号(系统部署账号)】内。

本期需求(用户原话):"确保跨账号的功能先都 disabled，只 focus 在系统部署账号内即可"。

idle-detactor 原生是【无条件多账号】架构:lambda1 采集 / lambda5 成本 / DevOps Agent
调查都会遍历 config 表里所有 enabled 账号、逐个 STS AssumeRole 进去。光靠"表里只放一个
账号"并不等于 disabled —— 一旦 Dashboard 上 onboard 了别的账号就会立刻跨账号。所以这里在
代码层加一道硬闸门。

设计原则:【单一开关 + 默认安全 + 完全可逆】
  环境变量 ``LOCKED_ACCOUNT_ID`` = 部署账号 ID(CDK 在主栈 lambdaEnv 与 BotStack 容器
  里统一注入 ``cdk.Aws.ACCOUNT_ID``)。
    * 已设置(默认部署形态):所有后台采集 / 调查只允许该账号,其余账号在执行路径上被
      过滤 / 拒绝。
    * 未设置(留空):退化为 idle-detactor 原始多账号行为。本开关零侵入、可逆——日后要
      重新开放跨账号,只需在 CDK 里不注入此变量,无需回滚任何业务代码。

为什么闸门设在"账号加载层 / create_investigation 入口",而不是改
``shared.queries.list_accounts``:
  Dashboard 与 API 需要 list_accounts 列出【全部】账号(含被锁掉的)来做管理与展示,过滤
  绝不能下沉到通用查询层;只在真正会发起跨账号 AWS 调用的执行路径上设闸门。这样
  Dashboard 行为不变,而采集/调查被收敛到部署账号。
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("shared.account_scope")

_ENV_VAR = "LOCKED_ACCOUNT_ID"


def locked_account_id() -> str | None:
    """返回被锁定的账号 ID;未设置(空串/缺失)时返回 None = 不限制(多账号模式)。"""
    val = os.environ.get(_ENV_VAR, "").strip()
    return val or None


def is_cross_account_disabled() -> bool:
    """是否处于"跨账号已 disabled"模式(即设置了 LOCKED_ACCOUNT_ID)。"""
    return locked_account_id() is not None


def is_account_allowed(account_id: str) -> bool:
    """该账号是否允许被采集/调查。

    未锁定 -> 全部允许(多账号模式);已锁定 -> 仅允许 == 锁定账号。
    """
    locked = locked_account_id()
    if locked is None:
        return True
    return str(account_id) == locked


def filter_allowed(items: list, get_account_id) -> list:
    """从账号列表里只保留允许的账号,并对被丢弃的账号打 INFO 日志(便于审计可见)。

    Args:
        items: 账号对象列表(可为 dict 或 dataclass)。
        get_account_id: 取出单个 item 的 account_id 的函数。

    Returns:
        过滤后的列表。未锁定时原样返回。
    """
    if not is_cross_account_disabled():
        return items

    locked = locked_account_id()
    allowed: list = []
    dropped: list[str] = []
    for it in items:
        acct = str(get_account_id(it))
        if acct == locked:
            allowed.append(it)
        else:
            dropped.append(acct)

    if dropped:
        logger.info(
            "account_scope: 跨账号已 disabled(LOCKED_ACCOUNT_ID=%s),"
            "已跳过 %d 个非部署账号: %s",
            locked,
            len(dropped),
            ", ".join(dropped),
        )
    return allowed


# ─── role ARN 的账号段校验（2026-08-30 补）────────────────────────────────
#
# 🔴 这道防御此前**只装在 DevOps Agent 那条路上**（`shared/devops_agent.py`
#    的 `_get_cross_account_client`），而**采集那条路上没有**：
#
#    ```
#    shared/devops_agent.py:161-168      ✅ 有（注释逐字写着这个攻击）
#    lambda_inspection_executor:208      ❌ 裸 assume_role
#    lambda1_collector/accounts.py:89    ❌ 裸 assume_role（连账号号都没传进来）
#    lambda5_cost_analyzer/handler.py:72 ❌ 裸 assume_role（账号号在手里却没用）
#    api/routes/devops_agent.py:606      ❌ 裸 assume_role（_test_connection）
#    core/devops_agent.py:178-180        ✅ 有（自己写了一份）
#    ```
#
#    而写侧 `api/routes/accounts.py` 的 `role_arn` 是从请求体直取、**零校验**
#    （`put_account(**fields)` 也不校验）。两头一凑：能写 config 表的人
#    就能让我们的 Lambda 执行角色 assume 到**他自己账号**的角色，
#    然后用他控制的凭证去「采集」某个合法账号 —— 落库时账号号写的是那个
#    合法账号。巡检 finding 的完整性整个失守，而且这是 confused deputy。
#
#    ⚠️ 巡检那条路**刻意不接** `LOCKED_ACCOUNT_ID` 闸门（那是设计，见
#       `lambda_inspection_executor.handler` 的 docstring），所以闸门也拦不住。
#
# ⇒ 抽成一个函数，四个 assume 点都过它。各写一遍必然漏，而漏了的表现是静默。


class CrossAccountRoleMismatch(RuntimeError):
    """role ARN 的账号段与目标账号不一致 —— 拒绝 AssumeRole。"""


def assert_role_belongs_to(
    role_arn: str, target_account_id: str, *, what: str = "role_arn",
) -> None:
    """`role_arn` 的账号段必须 == `target_account_id`，否则抛。

    Args:
        role_arn: 要 assume 的角色 ARN。
        target_account_id: 我们**认为**这次操作针对的账号（来自我们自己的
            config 表的 key，或来自 EventBridge 服务盖章的 `event.account`）。
        what: 出错信息里的字段名，方便定位是哪条记录写坏了。

    Raises:
        CrossAccountRoleMismatch: 不一致、ARN 形状不对、或账号段为空。

    ⚠️ **一律抛，不返回 bool。** 返回 bool 会让调用方漏掉 `if` —— 而漏掉的
       表现是静默通过。抛异常时最坏情况是那个账号这一轮失败，可见。

    ⚠️ 只查账号段，**不查角色名**。角色名有三种合法形态
       （`notiops-idle-detection-role-<系统账号>`、
        `notiops-agent-trigger-<账号>-m<系统账号>`、历史手工建的），
       写死会把合法接入挡掉。账号段是唯一在所有形态里都成立的判据。
    """
    arn = str(role_arn or "").strip()
    target = str(target_account_id or "").strip()
    if not target:
        raise CrossAccountRoleMismatch(
            f"目标账号为空，拒绝 AssumeRole({what}={arn or '空'})。"
            "调用方必须把「我们认为这是哪个账号」传进来 —— "
            "拿不到就说明这条链路上账号归属是不明确的，那正是要防的情况")
    # `arn:aws:iam::<账号>:role/<名字>` —— 账号段是第 5 段（下标 4）
    parts = arn.split(":")
    if len(parts) < 6 or parts[0] != "arn" or parts[2] != "iam":
        raise CrossAccountRoleMismatch(
            f"{what} 不是 IAM role ARN，拒绝 AssumeRole: {arn or '空'}")
    if parts[4] != target:
        raise CrossAccountRoleMismatch(
            f"{what} 的账号段({parts[4] or '空'})与目标账号({target})不一致，"
            f"拒绝 AssumeRole（防跨账号绕过）: {arn}。"
            "如果这是合法接入，去管理页重新登记那个账号的角色 —— "
            "而不是放宽这道校验")


def role_belongs_to(role_arn: str, target_account_id: str) -> bool:
    """`assert_role_belongs_to` 的**只读**版本，给写侧的入参校验用。

    ⚠️ 执行路径上（真要 assume 之前）请用 `assert_role_belongs_to` ——
       返回 bool 的版本容易被漏掉 `if`。
    """
    try:
        assert_role_belongs_to(role_arn, target_account_id)
    except CrossAccountRoleMismatch:
        return False
    return True
