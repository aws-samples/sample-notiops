"""investigation 行的预注册 —— 三处调用方的**单一实现**（R5.5c）。

## 为什么要收敛

同一段逻辑此前有两份实现，且形状不同：

```
lambda4_notifier/handler.py:284   显式参数、except 后只 logger.error（不抛）
api/routes/devops_agent.py:778    从 body dict 解析、校验后 raise ValueError、
                                  另外冗余读一次 account_alias
```

两份都写同一行 `invst#<task_id>`。字段清单分叉的表现是**静默的**：
HTTP 那侧写了 `account_alias`，Lambda 那侧在 alias 为 None 时干脆不写该键，
于是同一张列表里有的行有别名有的没有，UI 上看起来像「有些账号没上车」。

⚠️ 两处的**错误策略必须保持不同**，所以这里用参数表达而不是强行统一：

```
raise_on_error=False   后台批处理（notifier / 巡检）—— 预注册失败不该让
                       已经派出去的调查回滚，那会浪费已花掉的额度
raise_on_error=True    HTTP 端点 —— 调用方需要知道写没写成功，
                       静默成功会让 AgentCore 工具以为登记好了
```

## `source` 的语义

`upsert_investigation` 对 `source` 用 `if_not_exists`（first writer wins），
所以**预注册那一次决定了这一行的 source**，后续 callback 覆盖不了。
这正是要的：callback 不知道这次调查是谁发起的。

⚠️ 但 SHALL NOT 把 `source` 当分流主判据 —— 本函数在失败时（默认策略）
只记日志不抛，所以「source 写成功」不是一个可依赖的前提。
分流主判据是 AWS 在 callback 事件里给的 `agent_space_id`（R12.5d / 7.12g）。
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

INSPECTION_SOURCE = "inspection"
"""资源巡检派发的 investigation 的 `source` 值。

⚠️ 字符串常量而非各处字面量：拼成 `"inspections"` 的那一行会永久
落在按 source 筛选的结果之外，而写入与读取都不报错。
"""

ACCOUNT_ID_RE = re.compile(r"^\d{12}$")


def lookup_account_alias(account_id: str) -> str | None:
    """从 `da#<account>` 行冗余读一次别名。读不到返回 `None`，不抛。

    ⚠️ 别名只是显示用的。为它失败而中断预注册，等于让「配置表暂时读不到」
    升级成「这条调查永远没有记录」。
    """
    if not account_id:
        return None
    try:
        from shared.queries._client import config_table

        resp = config_table().get_item(
            Key={"PK": f"da#{account_id}", "SK": "meta"})
        row = resp.get("Item") or {}
        return row.get("account_alias") or None
    except Exception as e:                     # noqa: BLE001
        logger.warning("查 account_alias 失败，继续预注册: account=%s error=%s",
                       account_id, e)
        return None


def preregister_investigation(
    *,
    task_id: str,
    account_id: str,
    title: str,
    source: str,
    execution_id: str = "",
    account_alias: str | None = None,
    resolve_alias: bool = False,
    raise_on_error: bool = False,
) -> bool:
    """写一行 `status='pending'` 的 investigation 占位记录（R18.1 / R5.5a）。

    Args:
        task_id: AWS 给的 task id。**空值直接拒绝** —— 空 task_id 会退化成
            `invst#`（多个事件互相覆盖）与 S3 的 `investigations//report.md`。
        source: 谁发起的（`inspection` / `health_check` / …）。
            `upsert_investigation` 对它用 `if_not_exists`，所以这一次写定终身。
        resolve_alias: `True` 时在 `account_alias` 为空时去 `da#` 行查一次。
        raise_on_error: 见模块 docstring。

    Returns:
        写成功返回 `True`。`raise_on_error=False` 时失败返回 `False`。
    """
    tid = (task_id or "").strip()
    acct = (account_id or "").strip()
    ttl = (title or "").strip()
    src = (source or "").strip()

    problems = []
    if not tid:
        problems.append("task_id is required")
    if not acct or not ACCOUNT_ID_RE.match(acct):
        problems.append("account_id 必须是 12 位数字")
    if not ttl:
        problems.append("title is required")
    if not src:
        problems.append("source is required")
    if problems:
        msg = "; ".join(problems)
        if raise_on_error:
            raise ValueError(msg)
        logger.error("预注册参数不合法，跳过: %s (task_id=%r)", msg, task_id)
        return False

    alias = account_alias
    if resolve_alias and not alias:
        alias = lookup_account_alias(acct)

    fields: dict[str, Any] = {
        "status": "pending",
        "title": ttl,
        "source": src,
    }
    # ⚠️ 空值不写键，而不是写空串。写空串会让「没查到别名」和
    #    「别名就是空」在 UI 上长得一样，前者该显示账号 ID 兜底。
    if (execution_id or "").strip():
        fields["execution_id"] = execution_id.strip()
    if alias:
        fields["account_alias"] = alias

    try:
        from shared.queries.reports import upsert_investigation

        upsert_investigation(tid, account_id=acct, **fields)
    except Exception as e:                     # noqa: BLE001
        if raise_on_error:
            raise
        # ⚠️ 后台路径不抛：调查已经派出去了（额度已花），
        #    让它因为一行占位记录失败而整轮回滚是更坏的结果。
        logger.error("预注册 pending 记录失败（不中断）: task_id=%s error=%s",
                     tid, e)
        return False

    logger.info("预注册 pending 记录成功: task_id=%s account=%s source=%s",
                tid, acct, src)
    return True
