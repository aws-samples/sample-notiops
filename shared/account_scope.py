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
