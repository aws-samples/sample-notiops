"""巡检判读的 DA 目标解析：`账号 → (巡检 space id, devops-agent client)`。

per-account agent space 之后，「派判读任务给谁」不再是一个常量：

```
部署账号自己    env INSPECT_AGENT_SPACE_ID      +  本地 boto3 client
成员账号        da#<id>.inspect_agent_space_id  +  assume da#<id>.trigger_role_arn
```

## 为什么单独一个模块

executor（派发）与 reconciler（对账兜底）**都要**这个解析，而它有四个容易搞错的
地方。各写一遍必然漂，而漂了的表现全是静默的：

```
space id 拿成 agent_space_id（排障那个）
  → 巡检 task 派进排障 space → 那里没有判读 skill → DA 用通用提示词自由发挥
  → `## <finding_id>` 切不出节 → da_parse_status: parse_failed

region 用被扫的那个 region
  → 去错误的区找 space → ResourceNotFoundException
  → 而 reconciler 明确规定「拿不到状态什么都不做」→ 对账整条变 no-op

空 space id 时 fallback 到 env
  → 「成员账号的字段没填」退化成「用部署账号的 space」→ 又回到共用形态

assume 失败时吞掉
  → 那个账号一条判读都派不出去，而 run 记录看起来正常
```

## 失败一律抛，由调用方决定怎么降级

本模块**不吞异常**。调用方（executor / reconciler）都是「逐账号处理」的形状，
它们要的是「这个账号跳过并留下痕迹，其余账号继续」——
而那个决定属于调用方，不属于这里。
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class DaTargetUnavailable(RuntimeError):
    """这个账号的判读目标解析不出来。调用方应跳过它并留下可见痕迹。"""


def resolve(
    account_id: str,
    *,
    deploy_account_id: str,
    home_region: str,
    config_table: Any,
    env_space_id: str = "",
    source: str = "inspection-dispatch",
) -> tuple[str, Any]:
    """`(巡检 space id, devops-agent client)`。

    Args:
        account_id: 目标账号。
        deploy_account_id: 部署账号（`DEPLOY_ACCOUNT_ID`，**恒有值**）。
            ⚠️ 不要传 `LOCKED_ACCOUNT_ID` —— 那个在多账号模式下是**空的**，
            会让部署账号自己被当成成员账号处理（去读一个 CDK 已经播种过、
            但语义不同的字段），而那是 2026-08-25 踩过的坑。
        home_region: 部署账号那个 space 所在的 region（= Lambda 的 AWS_REGION）。
        config_table: config 表的 DDB Table 资源。
        env_space_id: `INSPECT_AGENT_SPACE_ID`，只对部署账号有意义。

    Raises:
        DaTargetUnavailable: 解析不出来（缺 space id / 缺角色 / assume 失败）。

    ⚠️ **成员账号的 space id 缺失时抛，不 fallback 到 env。** fallback 会把
    「这个账号还没回填 inspect_agent_space_id」伪装成「用部署账号的 space」——
    那正是 per-account 要摆脱的共用形态，而且它静默。
    管理页有「待更新栈」徽章专门显示这个状态。
    """
    acct = str(account_id or "").strip()
    deploy = str(deploy_account_id or "").strip()
    if not acct:
        raise DaTargetUnavailable("account_id 为空")

    # ── 部署账号自己：env + 本地 client ────────────────────────────────────
    if deploy and acct == deploy:
        space = str(env_space_id or "").strip()
        if not space:
            raise DaTargetUnavailable(
                "部署账号的 INSPECT_AGENT_SPACE_ID 为空 —— 去 CDK 确认 "
                "NotiOpsBackendStack 的 InspectionAgentSpaceId 有没有注入")
        import boto3
        return space, boto3.client("devops-agent", region_name=home_region)

    # ── 成员账号：da# 行 + 跨账号 assume ───────────────────────────────────
    from inspection.adapters import accounts as acct_repo

    space = acct_repo.inspect_space_id(config_table, acct).strip()
    if not space:
        raise DaTargetUnavailable(
            f"账号 {acct} 的 da# 行上没有 inspect_agent_space_id —— "
            "它部署的可能是旧版模板（没有巡检 space），或回填时那一栏留空了。"
            "管理页那一行会显示「待更新栈」。"
            "⚠️ 刻意**不** fallback 到部署账号的 space：那会把「没回填」"
            "伪装成「共用一个 space」，而共用正是 per-account 要摆脱的形态")

    # 🔴 复用 `shared.devops_agent` 的跨账号 client，**不在这里自己 assume**。
    #    那边有一道防御：`trigger_role_arn` 的账号段必须 == 目标账号，否则拒绝
    #    AssumeRole。自己写一遍必然漏掉它，而漏掉的后果是「一个被授权的
    #    account_id 配了指向别的账号的 Role ARN」能 assume 到任意账号。
    #
    # ⚠️ `account_already_authorized=True`：这里的账号来自 `enabled_accounts()`
    #    —— 我们自己的 config 表，比 callback 的 step 2 更强的授权。
    #    语义见 `shared.devops_agent.build_cross_account_devops_client`。
    #
    # ⚠️ 那个函数返回的第二个值是**排障** space id（`da#.agent_space_id`），
    #    这里刻意丢掉它、用上面读到的 `inspect_agent_space_id`。
    #    拿错会把巡检 task 派进排障 space。
    from shared.devops_agent import build_cross_account_devops_client

    client, _rca_space = build_cross_account_devops_client(
        acct, source=source, account_already_authorized=True)
    if client is None:
        raise DaTargetUnavailable(
            f"账号 {acct} 的跨账号 devops-agent client 建不出来 —— "
            "da# 行缺 trigger_role_arn / region，或 AssumeRole 失败。"
            "去管理页点「测试连接」看 AWS 的原话")
    logger.info("判读目标: account=%s space=%s（跨账号）", acct, space)
    return space, client
