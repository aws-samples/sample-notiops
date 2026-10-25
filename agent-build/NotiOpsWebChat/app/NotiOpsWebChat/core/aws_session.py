"""
多账号基座（agent 侧）—— 统一的"按账号拿 boto3 Session"。

所有要调 AWS 的工具（cases / 未来 finops / 故障调查 / 安全）都**不直接建 client**，
而是 `get_session(account_id)` 拿凭证，再 `session.client("…")`。这样多账号逻辑只此一处。

行为（与 notiops 的 lambda5 _assume_role 模式一致）：
  - account_id 缺省 / 等于部署账号 → 用本地默认凭证（agent runtime 的 IAM 角色），
    即当前单账号行为，零变化。
  - 否则 → 查 config 表（notiops-config）拿该账号的 role_arn，STS AssumeRole
    取临时凭证，返回该账号的 Session。
  - **安全闸门**：环境变量 LOCKED_ACCOUNT_ID（部署账号）若设置，则只允许该账号，
    其余账号一律拒绝（与 shared/account_scope.py 同语义）。默认安全、可逆。

约定：
  - 目标账号里的跨账号角色由接入模板建：`notiops-cross-account-role-<系统账号>`
    （2026-10 之前接入的叫 `notiops-idle-detection-role-<系统账号>`）。角色 ARN
    **只取** config 表账号条目的 role_arn，不按名字约定拼。
  - Support API 是全局服务，调用方仍用 region us-east-1。
"""
from __future__ import annotations

import logging
import os
import re

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

_LOCKED_ENV = "LOCKED_ACCOUNT_ID"

# 成员账号跨账号角色的新旧两代名字互为别名（2026-10 改名）。
# ⚠️ 与 `shared/account_scope.py::sibling_role_arn` 同一条规则 —— agent 包不含
#    shared/**，只能在这里再写一份；改一边必须改另一边（两边都有测试钉着）。
#    为什么要别名：改名 = CFN 替换角色，而触发更新的路径（StackSet 异步滚动、
#    客户自己更新栈）时机不由我们控制，注册表里存的名字随时可能指向已删的那一代。
_ALIAS_RE = re.compile(
    r"^(arn:aws(?:-[a-z-]+)?:iam::\d{12}:role/)"
    r"(notiops-cross-account-role|notiops-idle-detection-role)-(\d{12})$")


def _sibling_role_arn(role_arn: str) -> str | None:
    """给一代名字，返回同账号、同后缀的另一代；不是这两种带后缀的形态 → None。"""
    m = _ALIAS_RE.match(str(role_arn or "").strip())
    if not m:
        return None
    other = ("notiops-idle-detection-role" if m.group(2) == "notiops-cross-account-role"
             else "notiops-cross-account-role")
    return f"{m.group(1)}{other}-{m.group(3)}"


#: 注册表 ARN → 本进程上次实际成功的别名。没有它，栈已换名而注册表没换的账号每次都要
#: 先吃一次 AccessDenied（CloudTrail 噪音）。与 shared/account_scope.py::_ALIAS_MEMO 同语义。
_ALIAS_MEMO: dict[str, str] = {}


def _assume_with_alias(sts, role_arn: str, kw: dict) -> dict:
    """AssumeRole；AccessDenied 时换另一代名字再试。两次都失败抛注册表那个 ARN 的错。"""
    alt = _sibling_role_arn(role_arn)
    order = [alt, role_arn] if alt and _ALIAS_MEMO.get(role_arn) == alt else [role_arn, alt]
    errs: dict[str, ClientError] = {}
    for candidate in order:
        if not candidate:
            continue
        try:
            resp = sts.assume_role(RoleArn=candidate, **kw)
        except ClientError as e:
            errs[candidate] = e
            if e.response.get("Error", {}).get("Code") not in (
                    "AccessDenied", "AccessDeniedException"):
                break
            continue
        if candidate == role_arn:
            _ALIAS_MEMO.pop(role_arn, None)
        else:
            _ALIAS_MEMO[role_arn] = candidate
            logger.info("AssumeRole via alias: %s -> %s", role_arn, candidate)
        return resp
    _ALIAS_MEMO.pop(role_arn, None)
    raise errs.get(role_arn) or next(iter(errs.values()))

_deploy_account_cache: str | None = None


def _deploy_account_id() -> str | None:
    """部署账号 ID：优先 LOCKED_ACCOUNT_ID，否则用 STS 实时查（缓存）。"""
    locked = os.environ.get(_LOCKED_ENV, "").strip()
    if locked:
        return locked
    global _deploy_account_cache
    if _deploy_account_cache is None:
        try:
            _deploy_account_cache = boto3.client("sts").get_caller_identity()["Account"]
        except Exception as e:  # noqa: BLE001
            logger.warning("get_caller_identity failed: %s", e)
            _deploy_account_cache = ""
    return _deploy_account_cache or None


def _is_locked_out(account_id: str) -> bool:
    """跨账号闸门（默认安全）：
    - 设了 LOCKED_ACCOUNT_ID → 只允许该账号；
    - **没设** LOCKED_ACCOUNT_ID 但显式开了 NOTIOPS_ALLOW_CROSS_ACCOUNT=1 → 放开多账号；
    - 都没设（默认）→ 仅允许部署账号，跨账号一律拒绝（与 BFF 默认锁定对齐，避免误开放）。"""
    locked = os.environ.get(_LOCKED_ENV, "").strip()
    if locked:
        return str(account_id) != locked
    if os.environ.get("NOTIOPS_ALLOW_CROSS_ACCOUNT", "").strip() in ("1", "true", "True"):
        return False  # 显式放开
    deploy = _deploy_account_id()
    return bool(deploy) and str(account_id) != deploy  # 默认只允许部署账号


def _role_arn_for(account_id: str) -> str | None:
    """取目标账号的 AssumeRole ARN：**只信 config 表条目的 role_arn**。

    不再按角色名约定静默拼 ARN —— org 模式下成员角色带管理账号后缀，
    约定拼出的无后缀 ARN 是错的（会命中目标账号里独立部署的角色或不存在的角色）。
    未接入/记录缺 role_arn/在 Admin「账户」页停用了（`enabled` 不是 True）→ 返回 None（get_session 据此
    拒绝，工具层报 cross_account_unavailable，模型如实告知用户）。

    `enabled` 这一条 2026-10-23 补上（待办 #38 ⑤）：IM 那份 `core/aws_session.py::role_arn_for` 早就查它，
    这一份漏了 —— 停用的成员账号从账号下拉里消失了，但在问题里点名它的 12 位账号号，agent 照样
    AssumeRole 进去查。
    """
    try:
        # 直接读 config 表（自包含 —— 事故教训：shared.queries 从未随 agent 打包，
        # "No module named shared" 被静默吞掉、历史上走了错误的无后缀角色名回退）。
        table = os.environ.get("CONFIG_TABLE", "notiops-config")
        item = boto3.client("dynamodb").get_item(
            TableName=table,
            Key={"PK": {"S": f"account#{account_id}"}, "SK": {"S": "meta"}},
        ).get("Item")
        if item and item.get("enabled", {}).get("BOOL") is not True:
            logger.info("account %s is not enabled in the registry — refusing cross-account access", account_id)
            return None
        role_arn = item and item.get("role_arn", {}).get("S")
        if role_arn:
            return str(role_arn)
        logger.warning("account %s has no role_arn in config (not onboarded?) — refusing", account_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("config lookup(%s) failed — refusing cross-account: %s", account_id, e)
    return None


def get_session(account_id: str | None = None):
    """返回针对 account_id 的 boto3 Session。

    account_id 缺省/部署账号 → 本地默认凭证；其他账号 → STS AssumeRole。
    被闸门拒绝或 AssumeRole 失败 → 返回 None（调用方据此回退或报错，不抛）。
    """
    acct = str(account_id).strip() if account_id else ""
    deploy = _deploy_account_id()

    # 缺省 / 部署账号本身 → 本地默认凭证（当前单账号行为）
    if not acct or (deploy and acct == deploy):
        return boto3.Session()

    # 跨账号闸门
    if _is_locked_out(acct):
        logger.info("cross-account disabled (LOCKED_ACCOUNT_ID); refusing account %s", acct)
        return None

    role_arn = _role_arn_for(acct)
    if not role_arn:
        return None  # 未接入/无 role_arn → 拒绝（调用方报 cross_account_unavailable）
    try:
        sts = boto3.client("sts")
        kw = {"RoleSessionName": f"NotiOpsWebChat-{acct}", "DurationSeconds": 3600}
        resp = _assume_with_alias(sts, role_arn, kw)
        c = resp["Credentials"]
        return boto3.Session(
            aws_access_key_id=c["AccessKeyId"],
            aws_secret_access_key=c["SecretAccessKey"],
            aws_session_token=c["SessionToken"],
        )
    except ClientError as e:
        logger.warning("AssumeRole failed for %s (%s): %s", acct, role_arn, e)
        return None
    except Exception as e:  # noqa: BLE001
        logger.warning("get_session error for %s: %s", acct, e)
        return None
