"""DevOps Agent 多账户管理 API 路由（spec: devops-agent-per-account-architecture）。

Endpoints：

账户管理（R7 / R8）：
  GET    /api/devops-agent/accounts                              - 列表
  GET    /api/devops-agent/accounts/{account_id}                 - 单个详情
  POST   /api/devops-agent/accounts                              - 新增（初始 status=pending）
  POST   /api/devops-agent/accounts/{id}/generate-template       - 生成 CFN 模板 + Launch Stack URL
  POST   /api/devops-agent/accounts/{id}/onboarding-payload      - 回填 JSON
  POST   /api/devops-agent/accounts/{id}/test-connection         - 3 步验证
  POST   /api/devops-agent/accounts/{id}/enable                  - 启用
  POST   /api/devops-agent/accounts/{id}/disable                 - 禁用
  PUT    /api/devops-agent/accounts/{id}/context                 - 业务上下文

调查历史（R20）：
  GET    /api/devops-agent/investigations                        - 列表（过滤 + 分页）
  GET    /api/devops-agent/investigations/{task_id}              - 详情（含 summary_raw）
  POST   /api/devops-agent/investigations/preregister            - 预注册 pending 记录（R18.1）

Summarizer_Config（R18）：
  GET    /api/devops-agent/config                                - 读取
  PUT    /api/devops-agent/config                                - 写入

Requirements: R3.3, R7.1-7.8, R8.1-8.5, R18.3, R18.4, R20.1-20.5
"""

import json
import logging
import os
import re
from datetime import datetime
from urllib.parse import quote, urlencode

import boto3

from shared.account_scope import is_account_allowed, locked_account_id
from shared.queries.reports import (
    get_investigation,
    list_investigations,
    upsert_investigation,
)
from shared.queries._client import config_table, _now_iso
from api.errors import NotFoundError

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

_SUPPORTED_REGIONS = [
    "us-east-1",
    "us-west-2",
    "ap-southeast-2",
    "ap-northeast-1",
    "eu-central-1",
    "eu-west-1",
]
_DEFAULT_FALLBACK_REGION = "us-east-1"

_ACCOUNT_ID_RE = re.compile(r"^[0-9]{12}$")

_SESSION_NAME_MAX = 64

_ONBOARDING_BUCKET_ENV = "ONBOARDING_TEMPLATES_BUCKET"
_DEVOPS_EVENT_BUS_NAME = "notiops-devops-events"

# CFN 模板路径（相对于 Lambda 代码根目录）
_TEMPLATE_PATH = "onboarding_templates/business_account_agentspace.yaml.j2"

# DDB key helpers for devops agent account config
_DA_PK_PREFIX = "da#"
_DA_SK = "meta"
_DA_GSI1PK = "da#accounts"


def _da_pk(account_id: str) -> str:
    return f"da#{account_id}"


# ---------------------------------------------------------------------------
# 辅助：解析路径
# ---------------------------------------------------------------------------


def _parse_path(path: str) -> tuple[str, str | None, str | None]:
    """解析 /api/devops-agent/<resource>/<id>/<action> 形式的路径。

    Returns (resource, resource_id, action)。
    """
    parts = path.rstrip("/").split("/")
    # 去掉 "/api/devops-agent/" 前缀
    # parts = ["", "api", "devops-agent", <resource>, <id>?, <action>?]
    if len(parts) < 4:
        return "", None, None

    resource = parts[3] if len(parts) > 3 else ""
    resource_id = parts[4] if len(parts) > 4 else None
    action = parts[5] if len(parts) > 5 else None

    return resource, resource_id, action


# ---------------------------------------------------------------------------
# 主路由分发
# ---------------------------------------------------------------------------


def handle_devops_agent(
    method: str,
    path: str,
    query_params: dict,
    path_params: dict,
    body: dict | None,
) -> dict | list:
    resource, resource_id, action = _parse_path(path)

    if resource == "accounts":
        if action == "generate-template" and method == "POST":
            return _generate_template(resource_id)
        if action == "onboarding-payload" and method == "POST":
            return _save_onboarding_payload(resource_id, body)
        if action == "test-connection" and method == "POST":
            return _test_connection(resource_id)
        if action == "enable" and method == "POST":
            return _set_enabled(resource_id, True)
        if action == "disable" and method == "POST":
            return _set_enabled(resource_id, False)
        if action == "context" and method == "PUT":
            return _update_context(resource_id, body)
        if resource_id and method == "GET":
            return _get_account(resource_id)
        if resource_id and method == "DELETE":
            return _delete_account(resource_id)
        if resource_id is None and method == "GET":
            return _list_accounts(query_params)
        if resource_id is None and method == "POST":
            return _create_account(body)
        raise ValueError(f"Method {method} not allowed on {path}")

    if resource == "investigations":
        # POST /api/devops-agent/investigations/preregister
        if resource_id == "preregister" and method == "POST":
            return _preregister_investigation(body)
        if resource_id and method == "GET":
            return _get_investigation(resource_id)
        if resource_id is None and method == "GET":
            return _list_investigations(query_params)
        raise ValueError(f"Method {method} not allowed on {path}")

    if resource == "config":
        if method == "GET":
            return _get_summarizer_config()
        if method == "PUT":
            return _update_summarizer_config(body)
        raise ValueError(f"Method {method} not allowed on {path}")

    raise NotFoundError(f"Unknown DevOps Agent resource: {resource}")


# ---------------------------------------------------------------------------
# 账户：CRUD + 状态流转 (DynamoDB config table)
# ---------------------------------------------------------------------------


def _validate_account_id(account_id: str | None) -> str:
    if not account_id or not _ACCOUNT_ID_RE.match(account_id):
        raise ValueError("account_id 必须是 12 位数字")
    return account_id


def _validate_region(region: str) -> str:
    if region not in _SUPPORTED_REGIONS:
        raise ValueError(
            f"region 必须是 DevOps Agent 支持的 6 个 Region 之一: "
            f"{', '.join(_SUPPORTED_REGIONS)}"
        )
    return region


def _list_accounts(query_params: dict) -> dict:
    """列出 devops_agent_account_config 全部记录。"""
    from boto3.dynamodb.conditions import Key
    _table = config_table()
    resp = _table.query(
        IndexName="GSI1",
        KeyConditionExpression=Key("GSI1PK").eq(_DA_GSI1PK),
        ScanIndexForward=False,
    )
    rows = resp.get("Items", [])
    return {"items": rows, "total": len(rows)}


def _get_account(account_id: str) -> dict:
    _validate_account_id(account_id)
    _table = config_table()
    resp = _table.get_item(Key={"PK": _da_pk(account_id), "SK": _DA_SK})
    row = resp.get("Item")
    if not row:
        raise NotFoundError(f"Account {account_id} not found")
    return row


def _system_region_default() -> str:
    """选择 Dashboard 表单的默认 region。"""
    sys_region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if sys_region and sys_region in _SUPPORTED_REGIONS:
        return sys_region
    return _DEFAULT_FALLBACK_REGION


def _create_account(body: dict | None) -> dict:
    if not body:
        raise ValueError("Request body is required")

    account_id = _validate_account_id(body.get("account_id"))
    account_alias = body.get("account_alias") or ""
    region = body.get("region") or _system_region_default()
    _validate_region(region)
    related = body.get("related_business_accounts") or []
    if not isinstance(related, list):
        raise ValueError("related_business_accounts must be a list")

    _table = config_table()
    resp = _table.get_item(Key={"PK": _da_pk(account_id), "SK": _DA_SK})
    if resp.get("Item"):
        raise ValueError(f"Account {account_id} already exists")

    now = _now_iso()
    _table.put_item(Item={
        "PK": _da_pk(account_id),
        "SK": _DA_SK,
        "GSI1PK": _DA_GSI1PK,
        "GSI1SK": now,
        "account_id": account_id,
        "account_alias": account_alias,
        "region": region,
        "related_business_accounts": related,
        "onboarding_status": "pending",
        "enabled": False,
        "created_at": now,
        "updated_at": now,
    })
    return {
        "account_id": account_id,
        "message": "Account created (status=pending). Next: generate-template.",
    }


def _delete_account(account_id: str | None) -> dict:
    """删除账户配置记录。"""
    _validate_account_id(account_id)
    _table = config_table()
    resp = _table.get_item(Key={"PK": _da_pk(account_id), "SK": _DA_SK})
    row = resp.get("Item")
    if not row:
        raise NotFoundError(f"Account {account_id} not found")

    status = row.get("onboarding_status")
    if status == "active":
        raise ValueError(
            f"不能删除 active 状态的账户（当前 status={status}）。"
            f"请先禁用（disable）再删除。"
        )

    # 清理 S3 模板（best-effort）
    s3_key = row.get("template_s3_key")
    if s3_key:
        bucket = os.environ.get(_ONBOARDING_BUCKET_ENV, "")
        if bucket:
            try:
                s3 = boto3.client("s3")
                s3.delete_object(Bucket=bucket, Key=s3_key)
                logger.info("已清理 S3 模板: bucket=%s key=%s", bucket, s3_key)
            except Exception as e:
                logger.warning("清理 S3 模板失败（不阻断）: %s", e)

    _table.delete_item(Key={"PK": _da_pk(account_id), "SK": _DA_SK})
    return {"account_id": account_id, "message": "Account deleted."}


def _set_enabled(account_id: str | None, enable: bool) -> dict:
    """启用/禁用（R3.3）。"""
    _validate_account_id(account_id)
    _table = config_table()
    resp = _table.get_item(Key={"PK": _da_pk(account_id), "SK": _DA_SK})
    row = resp.get("Item")
    if not row:
        raise NotFoundError(f"Account {account_id} not found")

    current = row.get("onboarding_status")
    now = _now_iso()
    if enable:
        if current not in ("tested", "active"):
            raise ValueError(
                f"启用前必须先通过测试连接（当前 status={current}，期望 tested 或 active）"
            )
        _table.update_item(
            Key={"PK": _da_pk(account_id), "SK": _DA_SK},
            UpdateExpression="SET onboarding_status = :s, enabled = :e, updated_at = :u",
            ExpressionAttributeValues={":s": "active", ":e": True, ":u": now},
        )
        return {"account_id": account_id, "status": "active", "enabled": True}
    else:
        _table.update_item(
            Key={"PK": _da_pk(account_id), "SK": _DA_SK},
            UpdateExpression="SET onboarding_status = :s, enabled = :e, updated_at = :u",
            ExpressionAttributeValues={":s": "disabled", ":e": False, ":u": now},
        )
        return {"account_id": account_id, "status": "disabled", "enabled": False}


def _update_context(account_id: str | None, body: dict | None) -> dict:
    """更新 business_context（R8.3）。"""
    _validate_account_id(account_id)
    if not body:
        raise ValueError("Request body is required")

    allowed_keys = {"terms", "preferences", "known_issues", "contacts"}
    ctx = {k: v for k, v in body.items() if k in allowed_keys}

    _table = config_table()
    now = _now_iso()
    _table.update_item(
        Key={"PK": _da_pk(account_id), "SK": _DA_SK},
        UpdateExpression="SET business_context = :ctx, updated_at = :u",
        ExpressionAttributeValues={":ctx": ctx, ":u": now},
    )
    return {"account_id": account_id, "business_context": ctx}


# ---------------------------------------------------------------------------
# 模板生成：渲染 Jinja2 → 上传 S3 → presigned URL + Launch Stack URL
# ---------------------------------------------------------------------------


def _sanitize_agent_space_name(alias: str, account_id: str) -> str:
    """生成合法 Agent Space 名称。"""
    cleaned = re.sub(r"[^a-zA-Z0-9-]", "-", alias or "")
    cleaned = re.sub(r"-+", "-", cleaned).strip("-")
    if not cleaned:
        cleaned = f"notiops-{account_id}"
    else:
        cleaned = f"notiops-{cleaned}"
    return cleaned[:64]


def _render_template(account: dict) -> str:
    """用 Jinja2 渲染 CFN 模板。"""
    try:
        from jinja2 import Template
    except ImportError as e:
        raise RuntimeError(
            "jinja2 not installed — add to requirements.txt and redeploy"
        ) from e

    candidates = [
        _TEMPLATE_PATH,
        os.path.join(os.path.dirname(__file__), "..", "..", _TEMPLATE_PATH),
    ]
    template_content = None
    for c in candidates:
        try:
            with open(c, "r", encoding="utf-8") as f:
                template_content = f.read()
                break
        except FileNotFoundError:
            continue

    if template_content is None:
        raise ValueError(
            "Onboarding 模板文件尚未配置(onboarding_templates/ 目录缺失)。"
            "该功能本期暂未上线。"
        )

    tpl = Template(template_content)

    region = account["region"]
    account_id = account["account_id"]
    account_alias = account.get("account_alias") or ""
    agent_space_name = _sanitize_agent_space_name(account_alias, account_id)

    system_account_id = os.environ.get("AWS_ACCOUNT_ID") or _get_caller_account()
    system_region = os.environ.get("AWS_REGION") or _DEFAULT_FALLBACK_REGION

    return tpl.render(
        business_account_id=account_id,
        account_alias=account_alias,
        system_account_id=system_account_id,
        system_lambda_role_arn=(
            f"arn:aws:iam::{system_account_id}:role/notiops-lambda-execution-role"
        ),
        system_agentcore_role_arn=(
            f"arn:aws:iam::{system_account_id}:role/notiops-agentcore-runtime-role"
        ),
        system_event_bus_arn=(
            f"arn:aws:events:{system_region}:{system_account_id}:event-bus/{_DEVOPS_EVENT_BUS_NAME}"
        ),
        agent_space_name=agent_space_name,
        region=region,
    )


def _get_caller_account() -> str:
    try:
        sts = boto3.client("sts")
        return sts.get_caller_identity()["Account"]
    except Exception as e:
        logger.error("get_caller_identity 失败: %s", e)
        raise RuntimeError("无法获取系统账户 ID") from e


def _generate_template(account_id: str | None) -> dict:
    """生成 CFN 模板 + 上传 S3 + 生成 presigned URL + Launch Stack URL。"""
    _validate_account_id(account_id)
    account = _get_account(account_id)

    bucket = os.environ.get(_ONBOARDING_BUCKET_ENV)
    if not bucket:
        raise RuntimeError(
            f"环境变量 {_ONBOARDING_BUCKET_ENV} 未设置，无法上传模板"
        )

    rendered = _render_template(account)

    timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    s3_key = f"templates/{account_id}/{timestamp}.yaml"

    s3 = boto3.client("s3")
    s3.put_object(
        Bucket=bucket,
        Key=s3_key,
        Body=rendered.encode("utf-8"),
        ContentType="text/yaml",
        ServerSideEncryption="AES256",
    )

    presigned_url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": s3_key},
        ExpiresIn=3600,
    )

    business_region = account["region"]
    stack_name = f"notiops-devops-agent-{account_id}"
    launch_stack_url = (
        f"https://{business_region}.console.aws.amazon.com/cloudformation/home"
        f"?region={business_region}#/stacks/create/review"
        f"?templateURL={quote(presigned_url, safe='')}"
        f"&stackName={stack_name}"
    )

    # 记录 s3_key
    _table = config_table()
    now = _now_iso()
    _table.update_item(
        Key={"PK": _da_pk(account_id), "SK": _DA_SK},
        UpdateExpression="SET template_s3_key = :k, template_generated_at = :t, updated_at = :u",
        ExpressionAttributeValues={":k": s3_key, ":t": now, ":u": now},
    )

    return {
        "account_id": account_id,
        "presigned_url": presigned_url,
        "launch_stack_url": launch_stack_url,
        "s3_key": s3_key,
        "expires_in": 3600,
    }


# ---------------------------------------------------------------------------
# OnboardingPayload 回填（R7.5, R7.6）
# ---------------------------------------------------------------------------


_PAYLOAD_REQUIRED_KEYS = {"agentSpaceId", "agentSpaceArn", "triggerRoleArn"}


def _save_onboarding_payload(account_id: str | None, body: dict | None) -> dict:
    _validate_account_id(account_id)
    if not body:
        raise ValueError("Request body is required")

    payload_raw = body.get("payload") if "payload" in body else body
    if isinstance(payload_raw, str):
        try:
            payload = json.loads(payload_raw)
        except json.JSONDecodeError as e:
            raise ValueError(f"Payload JSON 解析失败: {e}")
    elif isinstance(payload_raw, dict):
        payload = payload_raw
    else:
        raise ValueError("Payload 必须是 JSON 对象或字符串")

    missing = _PAYLOAD_REQUIRED_KEYS - set(payload.keys())
    if missing:
        raise ValueError(f"OnboardingPayload 缺少字段: {sorted(missing)}")

    agent_space_id = payload["agentSpaceId"]
    agent_space_arn = payload["agentSpaceArn"]
    trigger_role_arn = payload["triggerRoleArn"]

    if not trigger_role_arn.startswith("arn:aws:iam::"):
        raise ValueError("triggerRoleArn 格式非法")
    # 🔴 **ARN 的账号段必须等于目标账号**（2026-08-30 补）。
    #
    #    只校前缀的后果：可以给账号 A 登记一个指向账号 B 的角色 ARN。
    #    而下游 `shared/devops_agent.py` 那道防御（「arn 账号段必须 ==
    #    target_account_id」）会在 AssumeRole 前拒掉它 —— 也就是说这一行不修
    #    不会造成跨账号逃逸，但会造成**一个永远失败的登记**：
    #    管理页显示「已登记 ✓」，而每一轮判读派发都 AccessDenied，
    #    错误只在 executor 日志里。写侧拒掉比让它烂在库里好。
    #
    # ⚠️ 这条**挡不住**「用自己的账号 A 配 A 里的恶意角色」——
    #    那要靠消费侧的授权判据（见下一条注释），不是这里。
    _arn_parts = trigger_role_arn.split(":")
    _arn_acct = _arn_parts[4] if len(_arn_parts) >= 5 else ""
    if _arn_acct != str(account_id):
        raise ValueError(
            f"triggerRoleArn 的账号段({_arn_acct or '空'})与目标账号"
            f"({account_id})不一致 —— 那样登记出来的账号每一轮都会 AccessDenied，"
            "而管理页会显示「已登记 ✓」")
    if not agent_space_arn.startswith("arn:aws:aidevops:"):
        raise ValueError("agentSpaceArn 格式非法")

    _table = config_table()
    now = _now_iso()
    _table.update_item(
        Key={"PK": _da_pk(account_id), "SK": _DA_SK},
        UpdateExpression=(
            "SET agent_space_id = :asi, agent_space_arn = :asa, "
            "trigger_role_arn = :tra, onboarding_status = :s, updated_at = :u"
        ),
        ExpressionAttributeValues={
            ":asi": agent_space_id,
            ":asa": agent_space_arn,
            ":tra": trigger_role_arn,
            # 🔴 **`deployed` 不是 `active`，这个区别是一道安全边界**（2026-08-30）。
            #
            #    `devops_agent_callback` 在跨账号取判读正文时要跳过
            #    `LOCKED_ACCOUNT_ID` 闸门，而它的授权判据是
            #    「`onboarding_status == "active"` **且** `enabled is True`」——
            #    本路由写的 `deployed`（且不写 `enabled`）**过不了**那个判据。
            #
            # ⚠️ 这很重要，因为本路由的授权很弱：`api/handler.py` 没有任何
            #    组/角色校验，API GW 只挂了 Cognito authorizer（**认证**，不是
            #    授权）。也就是说池里任何已登录用户都能调它。
            #    ⇒ 不要把这里改成写 `active`，也不要在这里写 `enabled`。
            #      真正的接入终态由 BFF 那两条路写（它们要 nav:admin 能力）。
            ":s": "deployed",
            ":u": now,
        },
    )
    return {
        "account_id": account_id,
        "status": "deployed",
        "agent_space_id": agent_space_id,
        "trigger_role_arn": trigger_role_arn,
    }


# ---------------------------------------------------------------------------
# 测试连接三步验证（R7.7, R7.8）
# ---------------------------------------------------------------------------


def _test_connection(account_id: str | None) -> dict:
    _validate_account_id(account_id)

    # 跨账号闸门:本期"跨账号 disabled"。测试连接会对目标账号 AssumeRole + GetAgentSpace
    # + PutEvents(真实跨账号 AWS 调用),故只允许测【部署账号】自己(self-assume,
    # investigate 本账号所需的信任链验证)。对其它账号直接拒绝。
    # 留空 LOCKED_ACCOUNT_ID 即恢复多账号测试。见 shared/account_scope.py。
    if not is_account_allowed(account_id):
        return {
            "passed": False,
            "steps": [{
                "step": 0,
                "name": "CrossAccountGate",
                "passed": False,
                "error": (
                    f"跨账号已 disabled:仅允许测试部署账号 {locked_account_id()} 的连接，"
                    f"拒绝测试账号 {account_id}"
                ),
            }],
        }

    account = _get_account(account_id)

    trigger_role_arn = account.get("trigger_role_arn")
    agent_space_id = account.get("agent_space_id")
    region = account["region"]

    if not trigger_role_arn or not agent_space_id:
        raise ValueError("请先回填 OnboardingPayload 后再执行测试连接")

    steps = []
    overall_passed = True

    # Step 1: AssumeRole
    #
    # 🔴 账号段校验：本函数**自己** assume，绕过了
    #    `shared.devops_agent._get_cross_account_client` 里那道防御。
    #    而 `_test_connection` 成功会把 `onboarding_status` 推进到 `tested`，
    #    紧接着 `/enable` 就能写成 `active` + `enabled=true` —— 那正是
    #    callback 放行跨账号取判读全文的判据。
    #    ⇒ 这一步放过一个指向别人账号的角色，等于把那个判据也放过了。
    from shared.account_scope import (
        CrossAccountRoleMismatch, assert_role_belongs_to,
    )

    try:
        assert_role_belongs_to(trigger_role_arn, account_id,
                               what=f"da#{account_id}.trigger_role_arn")
    except CrossAccountRoleMismatch as e:
        # 走既有的 step 失败形状（前端逐步显示原话），不抛 500
        return {
            "account_id": account_id, "passed": False,
            "steps": [{"step": 1, "name": "AssumeRole", "passed": False,
                       "error": str(e)}],
        }

    session_name = f"dashboard-{account_id}-test-connection"[:_SESSION_NAME_MAX]
    try:
        sts = boto3.client("sts")
        resp = sts.assume_role(
            RoleArn=trigger_role_arn,
            RoleSessionName=session_name,
            ExternalId=account_id,
            DurationSeconds=900,
        )
        creds = resp["Credentials"]
        steps.append({"step": 1, "name": "AssumeRole", "passed": True})
    except Exception as e:
        steps.append({
            "step": 1, "name": "AssumeRole", "passed": False,
            "error": str(e),
        })
        _record_test_result(account_id, False, f"Step 1 failed: {e}")
        return {"passed": False, "steps": steps}

    # Step 2: GetAgentSpace
    try:
        client = boto3.client(
            "devops-agent",
            region_name=region,
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
        )
        client.get_agent_space(agentSpaceId=agent_space_id)
        steps.append({"step": 2, "name": "GetAgentSpace", "passed": True})
    except Exception as e:
        steps.append({
            "step": 2, "name": "GetAgentSpace", "passed": False,
            "error": str(e),
        })
        overall_passed = False

    # Step 3: PutEvents 测试事件到 Custom Bus
    try:
        events_client = boto3.client("events")
        test_event = {
            "Source": "notiops.test",
            "DetailType": "Test Connection",
            "Detail": json.dumps({
                "test": True,
                "metadata": {
                    "test": True,
                    "account_id": account_id,
                    "trigger": "dashboard-test-connection",
                },
            }),
            "EventBusName": _DEVOPS_EVENT_BUS_NAME,
        }
        resp = events_client.put_events(Entries=[test_event])
        failed = resp.get("FailedEntryCount", 0)
        if failed > 0:
            raise RuntimeError(
                f"PutEvents 失败: {resp.get('Entries', [{}])[0].get('ErrorMessage', 'unknown')}"
            )
        steps.append({"step": 3, "name": "PutEvents", "passed": True})
    except Exception as e:
        steps.append({
            "step": 3, "name": "PutEvents", "passed": False,
            "error": str(e),
        })
        overall_passed = False

    # 更新 last_test_* 字段
    if overall_passed:
        _table = config_table()
        now = _now_iso()
        _table.update_item(
            Key={"PK": _da_pk(account_id), "SK": _DA_SK},
            UpdateExpression=(
                "SET onboarding_status = :s, last_test_at = :t, "
                "last_test_result = :r, last_test_error = :e, updated_at = :u"
            ),
            ExpressionAttributeValues={
                ":s": "tested", ":t": now, ":r": "pass", ":e": None, ":u": now,
            },
        )
    else:
        errors = [s.get("error", "") for s in steps if not s.get("passed")]
        _record_test_result(account_id, False, "; ".join(errors))

    return {"passed": overall_passed, "steps": steps}


def _record_test_result(account_id: str, passed: bool, error_text: str) -> None:
    _table = config_table()
    now = _now_iso()
    _table.update_item(
        Key={"PK": _da_pk(account_id), "SK": _DA_SK},
        UpdateExpression=(
            "SET last_test_at = :t, last_test_result = :r, "
            "last_test_error = :e, updated_at = :u"
        ),
        ExpressionAttributeValues={
            ":t": now,
            ":r": "pass" if passed else "fail",
            ":e": error_text[:2000],
            ":u": now,
        },
    )


# ---------------------------------------------------------------------------
# 调查历史（R20.5）
# ---------------------------------------------------------------------------


def _list_investigations(query_params: dict) -> dict:
    """过滤 + 分页查询调查历史。

    与前端契约对齐（offset 翻页 + total + alias/title/date_to 过滤），镜像原版
    RDS 的 WHERE + COUNT + LIMIT/OFFSET：
      - date_from 作为 GSI sort-key 下界下推，status 服务端 FilterExpression
      - account_alias / title_keyword 模糊匹配、date_to 创建日期上界在应用层过滤
      - 在按 created_at DESC 的完整过滤集上做 offset/limit 切片并返回 total
    （调查量低，拉取完整集做过滤/分页可接受；后续高量可改服务端游标分页。）
    """
    account_id = query_params.get("account_id")
    account_alias = (query_params.get("account_alias") or "").strip().lower()
    title_keyword = (query_params.get("title_keyword") or "").strip().lower()
    date_from = query_params.get("date_from")
    date_to = query_params.get("date_to")
    status = query_params.get("status")
    limit = min(int(query_params.get("limit", 50)), 500)
    offset = max(0, int(query_params.get("offset", 0)))

    statuses = [status] if status else None

    # 拉取完整集（GSI 内部翻页）；date_from 下推为 sort-key 下界。
    rows: list = []
    cursor = None
    while True:
        page, cursor = list_investigations(
            account_id=account_id, since=date_from, statuses=statuses,
            cursor=cursor, limit=200,
        )
        rows.extend(page)
        if not cursor:
            break

    # 应用层过滤：alias / title 模糊匹配，date_to 作为创建日期上界（含当天）。
    def _match(r: dict) -> bool:
        if account_alias and account_alias not in str(r.get("account_alias") or "").lower():
            return False
        if title_keyword and title_keyword not in str(r.get("title") or "").lower():
            return False
        if date_to and str(r.get("created_at") or "")[:10] > date_to:
            return False
        return True

    filtered = [r for r in rows if _match(r)]
    total = len(filtered)
    paged = filtered[offset:offset + limit]

    return {"items": paged, "total": total, "limit": limit, "offset": offset}


def _report_bucket() -> str:
    """Resolve the report S3 bucket (same precedence as report_handler)."""
    return (os.environ.get("S3_BUCKET")
            or os.environ.get("DATA_BUCKET")
            or os.environ.get("SKILLS_BUCKET", ""))


def _read_s3_text(key: str) -> str | None:
    """Read a UTF-8 S3 object body; None on any failure (graceful)."""
    bucket = _report_bucket()
    if not bucket or not key:
        return None
    try:
        client = boto3.client("s3")
        resp = client.get_object(Bucket=bucket, Key=key)
        return resp["Body"].read().decode("utf-8", errors="replace")
    except Exception as e:
        logger.warning("读取 S3 报告失败 bucket=%s key=%s error=%s", bucket, key, e)
        return None


def _get_investigation(task_id: str) -> dict:
    row = get_investigation(task_id)
    if not row:
        raise NotFoundError(f"Investigation {task_id} not found")

    # report_content 解析：① 新行带 S3 指针 → 读 S3 report.md；
    # ② 旧行内联 summary_raw → 读兼容；③ 都没有 → 空（详情优雅降级）。
    report_content = ""
    md_key = row.get("report_md_key")
    if md_key:
        text = _read_s3_text(md_key)
        if text is not None:
            report_content = text
        else:
            # S3 读失败：优雅提示，不抛
            report_content = "（报告暂不可用，请稍后重试）"
    elif row.get("summary_raw"):
        report_content = row.get("summary_raw")

    out = dict(row)
    out["report_content"] = report_content
    return out


def _preregister_investigation(body: dict | None) -> dict:
    """AgentCore 工具调用：预注册 pending 记录到 devops_agent_investigation（R18.1）。"""
    if not body:
        raise ValueError("body is required")

    task_id = (body.get("task_id") or "").strip()
    execution_id = (body.get("execution_id") or "").strip() or None
    account_id = (body.get("account_id") or "").strip()
    title = (body.get("title") or "").strip()
    source = (body.get("source") or "").strip()

    # ⚠️ 校验 + 写入都委托给 `shared/investigations.py`（R5.5c）。
    #    此前本函数与 `lambda4_notifier/handler.py::_preregister_investigation`
    #    是两份独立实现，字段清单分叉且不报错。
    #    `raise_on_error=True` 保持本端点的既有契约：调用方（AgentCore 工具）
    #    需要知道写没写成功，静默成功会让它以为登记好了。
    from shared.investigations import lookup_account_alias, preregister_investigation

    account_alias = lookup_account_alias(account_id) if account_id else None
    preregister_investigation(
        task_id=task_id, account_id=account_id, title=title, source=source,
        execution_id=execution_id or "", account_alias=account_alias,
        raise_on_error=True,
    )

    return {
        "task_id": task_id,
        "account_id": account_id,
        "account_alias": account_alias,
        "status": "pending",
        "message": "Investigation pre-registered successfully.",
    }


# ---------------------------------------------------------------------------
# Summarizer_Config（R18.3, R18.4）
# ---------------------------------------------------------------------------


_DA_CONFIG_PK = "appconfig#devops_agent"


def _get_summarizer_config() -> dict:
    """从 appconfig#devops_agent 读取（和 shared/summarizer_config.py 共享同一数据源）。

    返回 config_key / config_value 行格式，与前端 DevOpsAgentTab /
    DevopsAgentConfig 的 ``items.find(i => i.config_key === ...)`` 契约对齐。
    （RDS→DDB 迁移时这里曾误改成扁平对象，导致前端永远解析不到已存配置。）
    """
    _table = config_table()
    items = []
    for key in ("agent_prompt", "bedrock_model_id"):
        item = _table.get_item(Key={"PK": _DA_CONFIG_PK, "SK": key}).get("Item", {})
        items.append({
            "config_key": key,
            "config_value": item.get("config_value", ""),
            "updated_at": item.get("updated_at", ""),
        })
    return {"items": items}


def _update_summarizer_config(body: dict | None) -> dict:
    """写入 appconfig#devops_agent（和 shared/summarizer_config.py 共享同一数据源）。"""
    if not body:
        raise ValueError("Request body is required")

    allowed_keys = {"bedrock_model_id", "agent_prompt"}

    # 🔴 **先全部校验，再写一个字节。** 原来是「建表客户端 → 边校验边写」，
    #    两个后果：
    #
    #    ① `{"agent_prompt": 123}` 这种请求会**部分写入** —— 循环里第一个
    #       合法字段已经 put_item 落库，第二个类型不对才抛。调用方拿到 400，
    #       以为什么都没改，实际有一半生效了。
    #    ② 「一个合法字段都没给」那条校验**永远走不到**：`config_table()`
    #       在最前面，环境里没有 CONFIG_TABLE 时先炸 `KeyError` —— 调用方
    #       看到的是 CONFIG_TABLE 解析失败，而不是本该返回的「至少需要…」。
    #       `test_update_rejects_unknown_field` 一直是红的就是因为这个。
    #
    #    ⇒ 校验通过后才取表、才写：请求要么全写要么不写。
    #
    # ⚠️ `sorted()` 不是排版 —— `allowed_keys` 是 set，原来那个循环序不定，
    #    于是返回的 `updated` 顺序在两次相同请求之间可能不一样。
    #
    # ⚠️ 2026-09-03 合并 main：那边**独立做了同一个修复**，但引入的
    #    `updated: list[str]` 从不 append，返回的恒是空数组
    #    （调用方拿不到「改了哪几个字段」）。这里保留 HEAD 的
    #    `[k for k, _ in pending]`。
    pending: list[tuple[str, str]] = []
    for key in sorted(allowed_keys):
        if key not in body:
            continue
        value = body[key]
        if value is None:
            value = ""
        if not isinstance(value, str):
            raise ValueError(f"{key} 必须是字符串")
        pending.append((key, value))

    if not pending:
        raise ValueError(f"至少需要提供一个字段：{sorted(allowed_keys)}")

    _table = config_table()
    now = _now_iso()
    for key, value in pending:
        _table.put_item(Item={
            "PK": _DA_CONFIG_PK,
            "SK": key,
            "config_value": value,
            "updated_at": now,
        })

    return {"updated": [k for k, _ in pending]}
