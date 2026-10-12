"""账号作用域守卫 —— 把所有跨账号行为锁死在【单一账号(系统部署账号)】内。

本期需求(用户原话):"确保跨账号的功能先都 disabled，只 focus 在系统部署账号内即可"。

idle-detactor 原生是【无条件多账号】架构:lambda1 采集 / lambda5 成本 / DevOps Agent
调查都会遍历 config 表里所有 enabled 账号、逐个 STS AssumeRole 进去。光靠"表里只放一个
账号"并不等于 disabled —— 一旦在管理页上 onboard 了别的账号(当时是 Dashboard;它
2026-09-04 退役后是 Web Chat「更多 → 管理 → 账户」)就会立刻跨账号。所以这里在
代码层加一道硬闸门。

设计原则:【单一开关 + 默认安全 + 完全可逆】
  环境变量 ``LOCKED_ACCOUNT_ID`` = 部署账号 ID(CDK 在主栈 lambdaEnv 与 IM 函数
  ``createImCore`` 里统一注入 ``cdk.Aws.ACCOUNT_ID``,多账号模式部署时注入空串;原先
  BotStack 容器那一处随 BotStack 退役)。
    * 已设置(默认部署形态):所有后台采集 / 调查只允许该账号,其余账号在执行路径上被
      过滤 / 拒绝。
    * 未设置(留空):退化为 idle-detactor 原始多账号行为。本开关零侵入、可逆——日后要
      重新开放跨账号,只需在 CDK 里不注入此变量,无需回滚任何业务代码。

为什么闸门设在"账号加载层 / create_investigation 入口",而不是改
``shared.queries.list_accounts``:
  管理与展示需要 list_accounts 列出【全部】账号(含被锁掉的)—— 当时是 Dashboard 与 API
  (已于 2026-09-04 退役);现在 Python 侧的展示方是 IM 的 ``/account list``
  (``core/im_accounts.py``;被锁的账号照列,只标明当前切不过去)。所以过滤绝不能下沉到
  通用查询层;只在真正会发起跨账号 AWS 调用的执行路径上设闸门。这样列表照实展示,而
  采集/调查被收敛到部署账号。
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

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

    ⚠️ 只查账号段，**不查角色名**。角色名有几种合法形态
       （`notiops-cross-account-role-<系统账号>`、它改名前的
        `notiops-idle-detection-role-<系统账号>`、
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


# ---------------------------------------------------------------------------
# 成员账号跨账号角色的新旧两代名字（2026-10 改名）
# ---------------------------------------------------------------------------
#
# 成员账号里那个采集 / 只读角色原名 `notiops-idle-detection-role-<系统账号>`
# —— 老 idle-detector 时代的名字，老系统已删，客户在成员账号里看到它会问
# 「怎么还有 idle detector」。新接入改成 `notiops-cross-account-role-<系统账号>`。
#
# 🔴 为什么要「别名」而不是一次性迁移：角色名一改，CloudFormation 就是**替换**
#    （建新删旧），而触发更新的路径不止一条、时机也不由我们控制：
#
#    ```
#    setup.sh 重跑          update-stack-set → 异步滚动，不等完成
#    一键部署 stager        同上
#    非 Org 成员账号        客户自己在控制台更新栈，什么时候都可能
#    ```
#
#    而注册表 `account#<id>.role_arn` 里存的是接入那一刻的名字。任何一条路径先走
#    一步，存的名字就指向一个已删除（或尚未建出）的角色 —— 那个账号的巡检、跨账号
#    问答、案例全部 AccessDenied，看起来像「客户没给权限」。
#
#    所以执行侧把两个名字当**同一个角色的别名**：按注册表里的那个先 assume，
#    AccessDenied 时换成同账号、同后缀的另一个再试一次。
#
# ⚠️ 只认**带 12 位后缀**的这两种形态。无后缀的 `notiops-idle-detection-role` 是
#    部署账号自身的角色 / 历史手工接入的名字，没有对应的新名，不参与换名。
# ⚠️ 换名不改变账号段（正则保证），所以 `assert_role_belongs_to` 对原 ARN 的
#    校验结论对别名同样成立。
CROSS_ACCOUNT_ROLE_PREFIX = "notiops-cross-account-role"
LEGACY_CROSS_ACCOUNT_ROLE_PREFIX = "notiops-idle-detection-role"

_ALIAS_RE = re.compile(
    r"^(arn:aws(?:-[a-z-]+)?:iam::\d{12}:role/)"
    rf"({re.escape(CROSS_ACCOUNT_ROLE_PREFIX)}|{re.escape(LEGACY_CROSS_ACCOUNT_ROLE_PREFIX)})"
    r"-(\d{12})$")


def sibling_role_arn(role_arn: str) -> str | None:
    """新旧两代跨账号角色互为别名：给一个，返回同账号、同后缀的另一个。

    不是这两种形态（包括无后缀的老名字、trigger role 等别的角色）→ `None`。
    """
    m = _ALIAS_RE.match(str(role_arn or "").strip())
    if not m:
        return None
    other = (LEGACY_CROSS_ACCOUNT_ROLE_PREFIX
             if m.group(2) == CROSS_ACCOUNT_ROLE_PREFIX
             else CROSS_ACCOUNT_ROLE_PREFIX)
    return f"{m.group(1)}{other}-{m.group(3)}"


def _is_access_denied(e: BaseException) -> bool:
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else ""
    return code in ("AccessDenied", "AccessDeniedException")


#: 进程内记忆：注册表里的 ARN → 上次实际 assume 成功的别名。
#: 🔴 没有它的话，栈已换成新名而注册表还是旧名的账号**每一次**都先吃一次
#:    AccessDenied 再换名（R2/R3 review）：STS 调用翻倍，CloudTrail 里长期挂着
#:    AssumeRole AccessDenied —— 客户的安全告警很爱盯这种事件。条件回写注册表
#:    （`persist_aliased_role_arn`）是根治，这个记忆兜住没有写权限的调用方。
_ALIAS_MEMO: dict[str, str] = {}


def assume_role_with_alias(sts: Any, role_arn: str, **kwargs: Any) -> tuple[dict, str]:
    """`sts.assume_role(RoleArn=role_arn, **kwargs)`；AccessDenied 时换别名再试一次。

    Returns:
        `(assume_role 的响应, 实际 assume 成功的那个 ARN)`。

    ⚠️ 只在 **AccessDenied** 时换名。限流 / 网络错误换个名字不会好，原样抛。
    ⚠️ 两个都失败时抛**注册表那个 ARN** 的错 —— 排障要从它查起。
    ⚠️ 本进程上次已经证明别名才是对的，就先试别名（见 `_ALIAS_MEMO`）。
    ⚠️ 调用方仍须在调用前对 `role_arn` 做 `assert_role_belongs_to`。
    """
    alt = sibling_role_arn(role_arn)
    order = [alt, role_arn] if alt and _ALIAS_MEMO.get(role_arn) == alt else [role_arn, alt]
    errs: dict[str, BaseException] = {}
    for candidate in order:
        if not candidate:
            continue
        try:
            resp = sts.assume_role(RoleArn=candidate, **kwargs)
        except Exception as e:                             # noqa: BLE001
            errs[candidate] = e
            if not _is_access_denied(e):
                break
            continue
        if candidate == role_arn:
            _ALIAS_MEMO.pop(role_arn, None)
        else:
            _ALIAS_MEMO[role_arn] = candidate
            logger.info("跨账号角色按别名 assume 成功: 注册表=%s 实际=%s", role_arn, candidate)
        return resp, candidate
    # 两个都失败（或第一个就是非 AccessDenied）。别名记忆作废，抛注册表那个 ARN 的错；
    # 它没被试到（记忆顺序下第一个就是非 AccessDenied）时抛实际遇到的那个。
    _ALIAS_MEMO.pop(role_arn, None)
    raise errs.get(role_arn) or next(iter(errs.values()))


def persist_aliased_role_arn(config_table: Any, account_id: str,
                             registered: str, actual: str) -> bool:
    """别名成功后把注册表 `account#<id>/meta.role_arn` 条件改成实际那一代。

    条件是 `role_arn = :registered` —— 只在注册表还是我们刚读到的那个值时才改，
    不会覆盖管理页上同时发生的人工登记。

    ⚠️ **尽力而为，永不抛**：写不进去（无权限 / 条件不成立 / 限流）只是下次再多吃
       一次 AccessDenied，不该让一次已经拿到凭证的巡检失败。
    ⚠️ 只接受**互为别名**的两个值。别的组合（调用方传错）一律不写 —— 这个函数不能
       变成一个「按调用方的意思改 role_arn」的口子。
    """
    if not actual or sibling_role_arn(registered) != actual:
        return False
    try:
        config_table.update_item(
            Key={"PK": f"account#{account_id}", "SK": "meta"},
            UpdateExpression="SET role_arn = :actual",
            ConditionExpression="role_arn = :registered",
            ExpressionAttributeValues={":actual": actual, ":registered": registered},
        )
    except Exception as e:                                 # noqa: BLE001
        logger.info("别名回写注册表未成功（不影响本次）: %s", type(e).__name__)
        return False
    logger.info("注册表 role_arn 已换成实际那一代: account=%s", account_id)
    return True
