"""DA callback 事件的归属判定：这次调查是巡检的，还是排障的（R12.5d）。

## 为什么需要它

拆出独立巡检 agent space（7.12）之后，**两类调查的完成事件走同一个 callback
Lambda**（EventBridge 规则只按 `source: aws.aidevops` + detail-type 匹配，
没有 space 维度）。不分流的后果不是报错，而是巡检的判读事件被当成排障事件处理：

```
step 4   build_investigation_report  → 拉报告 + Bedrock 摘要 + 写 S3
step 6   写 progress# 行             → ECS poller 去更新一张不存在的实时卡片
step 6b  _deliver_report             → 试图给「发起这次调查的聊天会话」投卡片
```

第三步靠 `_resolve_chat_target()` 兜住了（巡检 task 没有 conversations 行 →
拿不到 target → 记一条 warning 后返回），所以**不会给客户发错卡片**。
但前两步会实打实地跑：每条巡检 task 白花一次 Bedrock 摘要调用 + 一次 S3 写 +
一条无用的 progress 行。按每账号每天 6 条 task 算，是每天 6 次。

## 判据为什么用 `agent_space_id` 而不是 `source='inspection'`

`source` 是**我们自己**预注册时写进 DDB 的字段（`_preregister_investigation`）。
拿它做判据等于「分流正确性依赖我们的预注册写成功」——而预注册那段代码
`except Exception: logger.error(...)` 不抛异常。预注册失败时事件会被判成排障，
于是那条 finding 的判读永远回不来，且看板上什么都看不出。

`agent_space_id` 是 **AWS 在事件里给的**，不依赖我们写过任何东西。
R12.5d 明写用它。

⚠️ 判据只能取 `detail.metadata.agent_space_id` 的**原值**。
`report_handler.py` 里那个同名变量是
`metadata.get("agent_space_id","") or xa_space_id or ""` —— 带兜底，
metadata 缺失时会退化成 DDB `da#` 行里的**排障** space id。
拿那个变量做判据会把 metadata 缺失的巡检事件误判成排障。
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


class Route(str, Enum):
    """这次 callback 该走哪条路。"""

    INSPECTION = "inspection"
    """资源巡检的判读结果。跳过 progress 行与 IM 投递（那两条是排障链路专属）。"""

    TROUBLESHOOTING = "troubleshooting"
    """排障根因调查。**默认档** —— 拿不准时走这里，保持既有行为不变。"""


def space_id_of(event: Mapping[str, Any] | None) -> str:
    """取事件里 AWS 给的 agent space id。取不到返回空串。

    ⚠️ 只看 `detail.metadata.agent_space_id`，**不做任何兜底**。
    兜底会让「metadata 里没有」和「metadata 说是排障」变成同一个结果，
    而这两者需要不同处理（前者判不了，后者判得了）。
    """
    detail = (event or {}).get("detail") or {}
    metadata = detail.get("metadata") or {}
    return str(metadata.get("agent_space_id") or "").strip()


def route_of(
    event: Mapping[str, Any] | None,
    *,
    inspect_space_ids: Iterable[str],
) -> Route:
    """判定归属。

    Args:
        event: 完整的 EventBridge 事件（不是 `detail`）。
        inspect_space_ids: **全部**巡检 space 的 id 集合 ——
            部署账号自己那个（`INSPECT_AGENT_SPACE_ID`）+ 每个成员账号那个
            （`da#<id>.inspect_agent_space_id`）。

    🔴 **2026-08-29 从「单个 id」改成集合**（per-account agent space 设计）。判错的两种
    表现都是**静默**的：
      ① 巡检事件判成排障 → `build_investigation_report` 白跑（拉报告 +
         Bedrock 摘要 + 写 S3 + 一条无人消费的 progress 行）
      ② 判读结果整个丢掉 → 报告里有分析，而每条 finding 旁边是空的

    ⚠️ 集合为空时返回 `TROUBLESHOOTING` 并**记 ERROR**。那种情况下我们根本
    无法分流，静默走排障路会让「CDK 没重新部署、env 没注入」表现成
    「巡检 callback 从来没触发过」—— 一个查不出来的现象。

    ⚠️ 事件里没有 `agent_space_id` 时也走 `TROUBLESHOOTING`，但只记 INFO：
    排障事件一直都带这个字段，缺失更可能是新的事件类型而不是配置错误。
    """
    # ⚠️ 大小写无关比较：space id 是 UUID，AWS 侧返回小写，但 env / DDB 里的值
    #    经过人手复制粘贴的路径，见过大写形态。区分大小写会让「值其实对得上」
    #    的事件被判成排障。集合化之后**在建集合时就 casefold**，
    #    否则每次成员判定都要遍历一遍，白丢掉 set 的意义。
    want = {s.strip().casefold() for s in (inspect_space_ids or ()) if s
            and s.strip()}
    got = space_id_of(event)

    if not want:
        logger.error(
            "巡检 space id 集合为空（env INSPECT_AGENT_SPACE_ID 与 "
            "da#<账号>.inspect_agent_space_id 都没给出值），无法区分巡检与"
            "排障事件 —— 本次按排障处理。⚠️ 这会让巡检判读结果静默走错链路："
            "既不回拼到 finding，又白跑一次 Bedrock 摘要。"
            "请确认 callback Lambda 的环境变量已注入（CDK 重新部署）"
        )
        return Route.TROUBLESHOOTING

    if not got:
        logger.info("事件未带 agent_space_id，按排障处理")
        return Route.TROUBLESHOOTING

    if got.casefold() in want:
        return Route.INSPECTION
    return Route.TROUBLESHOOTING


def is_inspection(
    event: Mapping[str, Any] | None, *, inspect_space_ids: Iterable[str]
) -> bool:
    """`route_of(...) is Route.INSPECTION` 的简写。

    ⚠️ 全仓**零生产读点**（只有测试用它）。留着是因为它把判据的语义说清楚了，
    但不要以为改 `route_of` 就够 —— 生产走的是
    `devops_agent_callback/handler.py` 里那个 `route is Route.INSPECTION`。
    """
    return route_of(
        event, inspect_space_ids=inspect_space_ids) is Route.INSPECTION
