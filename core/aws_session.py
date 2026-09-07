"""跨账号凭证（IM / core 侧）—— 拿目标 AWS 账号的 boto3 Session。

**为什么需要它**：IM 侧的案例路径（`core/support_logic.py`、`core/case_management.py`）
原本只有一个模块级 Support client，用的永远是部署账号的本地凭证。`/account` 切到成员
账号之后，工单还是开在部署账号里 —— 用户看到"提交成功"，工单落在另一个账号。
Web 侧同一个 bug 在 2026-08-05（`acea5ac`）修过一次，这里是同一条教训的第二个入口。

四条不变量（改这个文件之前先读完）：

1. **`role_arn` 只信 config 表，绝不按角色名约定拼。** org 模式下成员账号的采集角色
   名字带管理账号后缀（`notiops-idle-detection-role-<系统账号>`），而手工接入 /
   历史部署的可能是无后缀的那个名字。按约定拼出来的 ARN 在一半的部署里是错的，
   而错的表现是 `AccessDenied`（看起来像"客户没给权限"），不是"我们拼错了"。
   ⇒ 与 `agent-build/.../core/aws_session.py::_role_arn_for` 同一条口径。

2. **assume 之前必过 `shared.account_scope.assert_role_belongs_to`。** config 表的
   `role_arn` 写侧（`bff/web-chat/member_accounts.mjs`）虽然是自己按目标账号号拼的、
   账号段天然正确，但**这道校验不能靠上游自觉**：将来多一个写入方（导入、迁移脚本、
   人工改表）就有人能让我们的 Lambda 执行角色 assume 到他自己账号的角色，
   然后用他控制的凭证去替一个合法账号开工单。这是 confused deputy，
   而 `shared/account_scope.py` 的长注释里记着四个 assume 点漏校验的历史。
   ⚠️ agent-build 那份**没有**这道校验（它读表读的是自己那一份实现），
   所以别拿它当"标准做法"整段抄回来。

3. **拿不到凭证 → 返回 `None`，调用方必须明确报错。绝不许回落到部署账号凭证。**
   回落的后果不是"少了个功能"，而是**在错误的账号里执行了写操作**，而用户看到的是成功。
   这是本文件唯一一条真正危险的失败模式，所以每个返回 `None` 的分支都写了原因。

4. **不缓存跨账号 client，只缓存凭证。** 临时凭证有时效；缓存 client 会在一小时后
   开始静默 401，而 boto3 不会自己去续。缓存凭证 + 每次新建 client 的开销在 Lambda 上
   可忽略（IM 的案例路径本来就每轮只调几次 API）。
"""
from __future__ import annotations

import datetime as _dt
import logging
import os

import boto3

from shared import account_scope

logger = logging.getLogger(__name__)

_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
_CONFIG_TABLE = os.environ.get("CONFIG_TABLE", "notiops-config")

#: account_id -> {"creds": {...}, "exp": datetime}
_creds_cache: dict[str, dict] = {}

#: 临时凭证还剩多少秒就当过期（避免"刚好在调用中间过期"）。与
#: `core/devops_agent.py::_assume_client` 同一个数。
_EXPIRY_SKEW_SEC = 300


def _safe_err(e: Exception) -> str:
    """异常**类型**（+ AWS 错误码），绝不带原始 message。见 docs/LOGGING_STANDARD.md。"""
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__


def deploy_account_id() -> str | None:
    """部署账号号。借 `core.devops_agent._deploy_account_id`（锁定值优先，否则 STS），
    不在这里再写一份 —— 两处对"部署账号是谁"给出不同答案是很难查的一类错。"""
    try:
        from core import devops_agent
        return devops_agent._deploy_account_id()
    except Exception as e:  # noqa: BLE001
        logger.warning("aws_session.deploy_account_id failed: %s", _safe_err(e))
        return None


def is_local(account_id: str | None) -> bool:
    """这个账号是不是"用本地凭证就行"（空 = 部署账号，或显式等于部署账号号）。

    空串 = 部署账号，与 `platforms/common/im_types.py::ImMessage.account_id` 同一契约。
    """
    acct = str(account_id or "").strip()
    if not acct:
        return True
    return acct == str(deploy_account_id() or "")


def _registry_row(account_id: str) -> dict | None:
    """账号注册表那一行（`PK=account#<id>`, `SK=meta`）。读不到 → None。

    直接 `get_item` 而不走 `shared.queries.accounts.get_account`？—— **走**。
    `shared/**` 确实随 IM 代码包一起打（`infra/im-code-exclude.txt` 没排除它，
    `scripts/build_im_zips.py` 的 REQUIRED_IN_CODE 也钉了），所以这里不需要
    agent-build 那份"自己写一遍 get_item"的绕法（那是因为 agent 包**不含** shared/**）。
    """
    try:
        from shared.queries import accounts as accounts_q
        return accounts_q.get_account(account_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("aws_session: registry read failed for one account: %s", _safe_err(e))
        return None


def role_arn_for(account_id: str) -> str | None:
    """目标账号的 AssumeRole ARN —— **只信注册表行的 `role_arn`**（不变量 #1）。

    返回 None 的三种情况，都是"这个账号现在不该被跨账号访问"：
      · 注册表里没有这一行（没在 Web 上上车）；
      · 这一行 `enabled` 不是 True（Web 上停用了）；
      · 这一行没有 `role_arn`（第二步"关联 DevOps Agent"写的是 `trigger_role_arn`，
        那是**另一个角色**，不能拿来当采集角色用）。
    """
    row = _registry_row(account_id)
    if not row:
        logger.info("aws_session: account not in registry — refusing cross-account access")
        return None
    if row.get("enabled") is not True:
        logger.info("aws_session: account not enabled in registry — refusing")
        return None
    arn = str(row.get("role_arn") or "").strip()
    if not arn:
        logger.info("aws_session: registry row has no role_arn — refusing "
                    "(trigger_role_arn is a different role and must not be substituted)")
        return None
    return arn


def get_session(account_id: str) -> boto3.Session | None:
    """目标账号的 boto3 Session（AssumeRole 采集角色）。

    Args:
        account_id: 12 位账号号。**必须非空且不是部署账号** —— 本函数只管跨账号那一半，
            调用方先用 `is_local()` 分流。

    Returns:
        Session；或 `None` = **拒绝**（闸门 / 未上车 / 未启用 / ARN 不合法 /
        AssumeRole 失败）。调用方拿到 None 必须向用户报错，
        **绝不许回落到部署账号凭证**（不变量 #3）。
    """
    acct = str(account_id or "").strip()
    if not acct:
        logger.error("aws_session.get_session called with empty account_id — refusing")
        return None

    # 闸门：单账号部署（`LOCKED_ACCOUNT_ID` 非空）里一律不许跨账号。
    # ⚠️ `shared.account_scope` 每次都现读 env，所以这里不能把结果缓存到模块级。
    if not account_scope.is_account_allowed(acct):
        logger.info("aws_session: LOCKED_ACCOUNT_ID gate refused cross-account access")
        return None

    arn = role_arn_for(acct)
    if not arn:
        return None

    # 不变量 #2：账号段必须与目标账号一致。**抛**而不是返回 bool（见那个函数的注释），
    # 所以这里显式接住 —— 本函数的契约是"永不抛，拿不到就 None"。
    try:
        account_scope.assert_role_belongs_to(arn, acct, what="role_arn")
    except account_scope.CrossAccountRoleMismatch as e:
        logger.error("aws_session: %s", e)
        return None

    now = _dt.datetime.now(_dt.timezone.utc)
    cached = _creds_cache.get(acct)
    if cached and (cached["exp"] - now).total_seconds() > _EXPIRY_SKEW_SEC:
        creds = cached["creds"]
    else:
        try:
            r = boto3.client("sts", region_name=_REGION).assume_role(
                RoleArn=arn,
                RoleSessionName=f"NotiOpsCase-{acct}"[:64],
                DurationSeconds=3600,
            )
        except Exception as e:  # noqa: BLE001
            # AccessDenied 在这里最常见的两个真实原因：成员账号还没部署那个角色，
            # 或者部署了但信任策略带 `aws:PrincipalOrgID` 而这个账号不在同一个 org。
            # 两者都不是"重试能好"的，所以不重试；调用方会把它翻成一句人能看懂的话。
            logger.warning("aws_session: assume_role failed: %s", _safe_err(e))
            return None
        c = r["Credentials"]
        creds = {"AccessKeyId": c["AccessKeyId"],
                 "SecretAccessKey": c["SecretAccessKey"],
                 "SessionToken": c["SessionToken"]}
        _creds_cache[acct] = {"creds": creds, "exp": c["Expiration"]}

    return boto3.Session(
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
        region_name=_REGION,
    )


__all__ = ["deploy_account_id", "get_session", "is_local", "role_arn_for"]
