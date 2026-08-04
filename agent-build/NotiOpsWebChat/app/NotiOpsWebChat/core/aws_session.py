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
  - 跨账号只读/操作角色名沿用 notiops 的 `notiops-idle-detection-role`（部署到
    目标账号、信任部署账号）。也可在 config 表的账号条目里显式给 role_arn 覆盖。
  - Support API 是全局服务，调用方仍用 region us-east-1。
"""
from __future__ import annotations

import logging
import os

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

# 跨账号角色名约定（目标账号里部署的角色）。可被 config 表条目的 role_arn 覆盖。
_DEFAULT_ROLE_NAME = os.environ.get("NOTIOPS_CROSS_ACCOUNT_ROLE", "notiops-idle-detection-role")
_LOCKED_ENV = "LOCKED_ACCOUNT_ID"

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
    未接入/记录缺 role_arn → 返回 None（get_session 据此拒绝，工具层报
    cross_account_unavailable，模型如实告知用户）。
    """
    try:
        # 直接读 config 表（自包含 —— 事故教训：shared.queries 从未随 agent 打包，
        # "No module named shared" 被静默吞掉、历史上走了错误的无后缀角色名回退）。
        table = os.environ.get("CONFIG_TABLE", "notiops-config")
        item = boto3.client("dynamodb").get_item(
            TableName=table,
            Key={"PK": {"S": f"account#{account_id}"}, "SK": {"S": "meta"}},
        ).get("Item")
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
        resp = sts.assume_role(
            RoleArn=role_arn,
            RoleSessionName=f"NotiOpsWebChat-{acct}",
            DurationSeconds=3600,
        )
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
