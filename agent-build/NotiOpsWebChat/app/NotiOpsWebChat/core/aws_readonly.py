"""
跨账号安全的**原生 boto3 只读兜底**工具（account-aware fallback）。

背景 / 为什么需要它
--------------------
全局兜底 `aws-api-mcp`(core/aws_api_mcp.py 的 call_aws)是 MCP **stdio 子进程**、
**容器级常驻单例**,凭据在子进程 start() 时锁死 = runtime(部署账号)凭据,**完全无视
account_id**。因此跨账号(用户选了成员账号)时,call_aws 仍查部署账号 → 数据串号 + 泄露
(实测:选成员账号查"列出S3桶"返回的是部署账号的桶)。awslabs 源码确认 call_aws 对外
硬编码 credentials=None,无法按调用注入凭据。

本模块是**跨账号场景下 call_aws 的安全替身**:它是**进程内原生 boto3**,每次调用都走
`aws_session.get_session(account_id)` 取该账号的临时凭据(AssumeRole),因此**账号绝对正确**。
单账号(部署账号)时仍用能力更全的 MCP call_aws;跨账号时 main.py 用本工具替换它。

安全
----
- **只读铁律**:operation 必须匹配只读动词白名单(describe/list/get/lookup/...),
  否则拒绝。绝不执行任何 mutating 调用(纵深防御,与 READ_OPERATIONS_ONLY 同义)。
- **账号隔离**:凭据只来自 get_session(account_id) → 受 aws_session 的闸门 + config 表
  role_arn + AssumeRole 保护。get_session 返回 None(未接入/无权限/被闸门拒)→ 明确报错,
  **绝不回退部署账号凭据**(与 support_cases/resources 同范式,不重蹈 whats_new 覆辙)。
- **结果体积上限**:与 call_aws 一致,超限截断,防 agentic loop token 爆炸。
"""
from __future__ import annotations

import json
import logging

from botocore.config import Config as _BotoConfig
from botocore.exceptions import ClientError

from core.aws_session import get_session

logger = logging.getLogger(__name__)

# 只读动词白名单:boto3 operation 名(PascalCase)或 CLI 名(kebab)开头命中即视为只读。
# 这是纵深防御——即便调用方传了 mutating operation,这里也拒绝。
_READ_PREFIXES = (
    "describe", "list", "get", "lookup", "search", "scan", "query",
    "batch_get", "batchget", "estimate", "preview", "view", "check",
    "retrieve", "select", "test", "validate", "head",
)

_MAX_RESULT_CHARS = 40000  # 与 aws_api_mcp 一致,防 token 爆炸


def _is_read_only(operation: str) -> bool:
    op = (operation or "").strip().lower().replace("-", "_")
    return any(op.startswith(p) for p in _READ_PREFIXES)


def _truncate(s: str) -> str:
    if len(s) <= _MAX_RESULT_CHARS:
        return s
    head = s[: _MAX_RESULT_CHARS // 2]
    tail = s[-_MAX_RESULT_CHARS // 4 :]
    return (head + "\n\n…[结果过大已截断,请用更具体的过滤/分页缩小范围]…\n\n" + tail)


def aws_readonly_call(service: str, operation: str, account_id: str,
                      region: str = "", params: dict | None = None) -> dict:
    """跨账号安全的 AWS **只读** API 调用(原生 boto3,按 account_id AssumeRole)。

    Args:
      service: AWS 服务名(boto3 client 名),如 "s3" / "ec2" / "ce" / "cloudwatch".
      operation: 只读 API(boto3 方法名 snake_case,如 "list_buckets"/"describe_instances").
                 非只读动词一律拒绝。
      account_id: 12 位目标账号(必填;调用方从 _resolve_acct() 传入,已过可见性门禁).
      region: 区域(默认 us-east-1;S3/IAM 等全局服务可留空).
      params: API 入参 dict(如 {"MaxResults": 50}).

    Returns: {"ok": bool, "service","operation","account_id", "result"|"error"}.
    """
    svc = (service or "").strip().lower()
    op = (operation or "").strip()
    acct = (account_id or "").strip()

    if not svc or not op:
        return {"ok": False, "error": "service 和 operation 必填"}
    if not _is_read_only(op):
        return {"ok": False, "error": f"拒绝:'{op}' 不是只读操作(本工具仅允许 describe/list/get/lookup 等只读 API)"}
    if not (acct.isdigit() and len(acct) == 12):
        return {"ok": False, "error": f"account_id 必须是 12 位数字,收到 '{acct}'"}

    # 账号隔离核心:凭据只来自 get_session(account_id);None → 明确报错,绝不回退部署账号。
    sess = get_session(acct)
    if sess is None:
        return {"ok": False, "code": "cross_account_unavailable",
                "error": f"账号 {acct} 跨账号访问不可用(未接入 NotiOps / 无 role_arn / 被安全闸门拒绝)。"}

    try:
        client = sess.client(svc, region_name=(region or "us-east-1"),
                             config=_BotoConfig(retries={"max_attempts": 2}))
        method = op.strip().replace("-", "_")
        if not hasattr(client, method):
            return {"ok": False, "error": f"{svc} 无只读方法 '{method}'"}
        resp = getattr(client, method)(**(params or {}))
        # 去掉 boto3 的 ResponseMetadata 噪声
        if isinstance(resp, dict):
            resp = {k: v for k, v in resp.items() if k != "ResponseMetadata"}
        body = json.dumps(resp, default=str, ensure_ascii=False)
        return {"ok": True, "service": svc, "operation": method, "account_id": acct,
                "result": _truncate(body)}
    except ClientError as e:
        return {"ok": False, "service": svc, "operation": op, "account_id": acct,
                "error": f"{type(e).__name__}: {str(e)[:400]}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "service": svc, "operation": op, "account_id": acct,
                "error": f"{type(e).__name__}: {str(e)[:400]}"}
