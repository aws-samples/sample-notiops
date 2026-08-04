"""DevOps Agent API wrapper (per-account Agent Space architecture).

Provides create_investigation and get_investigation_summary functions,
used by Lambda4 auto-trigger and Callback Lambda.

Architecture:
- Account routing from DDB config table (shared.queries.accounts)
- STS AssumeRole to target account Trigger_Role before calling DevOps Agent API
  (with ExternalId and normalized RoleSessionName)
- Temporary credentials cached per target_account_id, auto-refreshed 5 min before expiry

Environment variables:
  - AWS_REGION: STS endpoint region (Agent Space real region from DDB)
  - LEGACY_DEVOPS_AGENT_SECRET_ARN: Startup self-check only, logs WARN if legacy config exists

Requirements: R4.1, R4.2, R4.3, R4.5, R4.6, R9.1, R9.2, R9.3, R9.4, R9.5,
              R9.6, R9.7, R16.2
"""

import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone

import boto3

from shared.account_scope import is_account_allowed, locked_account_id
from shared.queries._client import config_table

logger = logging.getLogger("shared.devops_agent")


# ---------------------------------------------------------------------------
# 异常与常量
# ---------------------------------------------------------------------------


class CrossAccountAssumeRoleError(Exception):
    """对目标业务账户 Trigger_Role 执行 STS AssumeRole 失败。

    Requirements: R4.6
    """


# STS 临时凭证缓存（按 target_account_id）
# value: {"credentials": {AccessKeyId, SecretAccessKey, SessionToken}, "expiration": datetime}
_sts_credentials_cache: dict[str, dict] = {}

# 凭证过期前多少秒提前刷新（凭证默认 1 小时）
_SESSION_REFRESH_MARGIN_SECONDS = 300


# ---------------------------------------------------------------------------
# 账户配置查询
# ---------------------------------------------------------------------------


def _get_da_account(account_id: str) -> dict | None:
    """Read DevOps Agent account config from DDB (PK=da#{id})."""
    table = config_table()
    resp = table.get_item(Key={"PK": f"da#{account_id}", "SK": "meta"})
    return resp.get("Item")


def _query_account_mapping(account_id: str) -> dict | None:
    """Query active account DevOps Agent config from DDB.

    Only returns items with onboarding_status='active' AND enabled=True,
    used by active investigation triggers (Lambda4).

    Returns:
        Config dict; None if not found or conditions not met.

    Requirements: R3.4, R3.8, R9.3
    """
    row = _get_da_account(account_id)
    if row is None:
        return None
    if row.get("onboarding_status") != "active" or row.get("enabled") is not True:
        return None
    return row


def _query_account_mapping_raw(account_id: str) -> dict | None:
    """Query account DevOps Agent config from DDB (no status filtering).

    Used by Callback Lambda: even disabled accounts need config lookup
    to store summaries (only active triggers are skipped).

    Requirements: R3.8, R9.3
    """
    return _get_da_account(account_id)


# ---------------------------------------------------------------------------
# STS 跨账户凭证与 boto3 client
# ---------------------------------------------------------------------------


def _infer_component_from_source(source: str) -> str:
    """从 source 推断 component 字段（用于 RoleSessionName 审计）。

    调用方也可以通过 create_investigation(component=...) 显式指定。
    """
    if not source:
        return "caller"
    s = source.lower()
    if "cost-anomaly" in s or "health-critical" in s:
        return "lambda4"
    if "manual-trigger" in s or "manual" in s:
        return "agentcore"
    return "caller"


def _get_cross_account_credentials(
    target_account_id: str,
    trigger_role_arn: str,
    component: str,
    source: str,
) -> dict:
    """获取或刷新目标账户的 STS 临时凭证（带缓存）。

    缓存策略：
      - 过期前 _SESSION_REFRESH_MARGIN_SECONDS 秒（5 分钟）内直接返回缓存
      - 否则调用 STS AssumeRole 刷新凭证

    Session Name 规范：`<component>-<account_id>-<source>`，截到 64 字符
    （AWS RoleSessionName 上限），便于 CloudTrail 审计追溯。

    Args:
        target_account_id: 目标业务账户 ID
        trigger_role_arn: 目标账户内 Trigger_Role ARN
        component: 调用方组件（lambda4 / agentcore / callback / dashboard / caller）
        source: 调用来源（cost-anomaly / health-critical / manual-trigger /
                fetch-summary / test-connection 等）

    Returns:
        Credentials dict，包含 AccessKeyId、SecretAccessKey、SessionToken

    Raises:
        CrossAccountAssumeRoleError: AssumeRole 失败

    Requirements: R4.1, R4.2, R4.5
    """
    cached = _sts_credentials_cache.get(target_account_id)
    if cached:
        expiration: datetime = cached["expiration"]
        if expiration - datetime.now(timezone.utc) > timedelta(
            seconds=_SESSION_REFRESH_MARGIN_SECONDS
        ):
            return cached["credentials"]

    region = os.environ.get("AWS_REGION", "ap-northeast-1")
    sts = boto3.client("sts", region_name=region)

    # 防御:trigger_role_arn 的账号段必须 == target_account_id。否则一个被授权的
    # 逻辑 account_id(过了 is_account_allowed 闸门)可能配了指向【其它账号】的
    # Role ARN(onboarding 只校验了 arn:aws:iam:: 前缀),从而绕过跨账号闸门
    # AssumeRole 到任意账号。在真正 AssumeRole 前强制一致性。
    arn_parts = (trigger_role_arn or "").split(":")
    arn_account = arn_parts[4] if len(arn_parts) >= 5 else ""
    if arn_account != target_account_id:
        raise CrossAccountAssumeRoleError(
            f"trigger_role_arn 账号段({arn_account or '空'})与 target_account="
            f"{target_account_id} 不一致，拒绝 AssumeRole(防跨账号闸门绕过) "
            f"role={trigger_role_arn}"
        )

    # 规范化 source 前缀（去掉 notiops- 之类的前缀让 session name 更短）
    short_source = source.replace("notiops-", "") if source else "unknown"
    session_name = f"{component}-{target_account_id}-{short_source}"
    # AWS RoleSessionName 最大 64 字符
    session_name = session_name[:64]

    try:
        resp = sts.assume_role(
            RoleArn=trigger_role_arn,
            RoleSessionName=session_name,
            ExternalId=target_account_id,
            DurationSeconds=3600,
        )
    except Exception as e:
        raise CrossAccountAssumeRoleError(
            f"AssumeRole 失败 target_account={target_account_id} "
            f"role={trigger_role_arn}: {e}"
        ) from e

    creds = resp["Credentials"]
    credentials = {
        "AccessKeyId": creds["AccessKeyId"],
        "SecretAccessKey": creds["SecretAccessKey"],
        "SessionToken": creds["SessionToken"],
    }
    _sts_credentials_cache[target_account_id] = {
        "credentials": credentials,
        "expiration": creds["Expiration"],
    }
    logger.info(
        "STS AssumeRole 成功: target_account=%s session=%s expiration=%s",
        target_account_id,
        session_name,
        creds["Expiration"].isoformat(),
    )
    return credentials


def _get_cross_account_client(
    target_account_id: str,
    mapping: dict,
    component: str,
    source: str,
):
    """创建使用目标账户临时凭证的 devops-agent boto3 client。

    注意：boto3 service name 为 'devops-agent'（带连字符），
    不是 aidevops:* IAM action 前缀。

    Requirements: R4.3
    """
    creds = _get_cross_account_credentials(
        target_account_id=target_account_id,
        trigger_role_arn=mapping["trigger_role_arn"],
        component=component,
        source=source,
    )
    return boto3.client(
        "devops-agent",
        region_name=mapping["region"],
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
    )


# ---------------------------------------------------------------------------
# 公有 API: create_investigation
# ---------------------------------------------------------------------------


def create_investigation(
    title: str,
    description: str,
    priority: str = "MEDIUM",
    source: str = "notiops-manual",
    target_account_id: str | None = None,
    component: str | None = None,
    incident_id: str | None = None,
) -> dict:
    """创建 DevOps Agent 调查任务（跨账户）。

    Args:
        title: 调查标题
        description: 调查描述（会自动加 [source] 前缀）
        priority: HIGH / MEDIUM / LOW / CRITICAL / MINIMAL
        source: 来源标识（notiops-cost-anomaly / notiops-health-critical /
                notiops-manual 等）
        target_account_id: 目标业务账户 ID；None 时返回错误
        component: 调用方组件标识（lambda4 / agentcore / callback / dashboard / caller）；
                   None 时根据 source 自动推断
        incident_id: IM bot 派发时生成的 incident_id（如 `feishu-<event_id>`）。
                     非空时会被嵌入 description 末尾作为 `<!--notiops:<id>-->`
                     HTML 注释 — report-handler 从 journal 把这个标记 grep 回来
                     用作路由键(查 DDB incident# row 拿 chat 上下文 + 渲染
                     "升级 Support" 等按钮)。Lambda4 等定时触发场景留 None,
                     report-handler 会兜底用 task-<task_id>。

    Returns:
        成功: {"success": True, "task_id": str, "execution_id": str}
        失败: {"success": False, "error": str}

    Requirements: R9.1, R9.4, R4.6
    """
    if not target_account_id:
        logger.info("DevOps Agent 调查跳过：缺少 target_account_id")
        return {"success": False, "error": "缺少 target_account_id"}

    # 跨账号闸门:本期"跨账号 disabled",只允许对【部署账号】发起调查。
    # LOCKED_ACCOUNT_ID 由 CDK 注入 = cdk.Aws.ACCOUNT_ID。这是所有调查路径
    # (bot 手动 / lambda4 自动 / callback)的统一兜底,即使上游传入了别的账号也会在此拒绝。
    # 见 shared/account_scope.py。
    if not is_account_allowed(target_account_id):
        error = (
            f"跨账号已 disabled:仅允许调查部署账号 {locked_account_id()}，"
            f"拒绝对账号 {target_account_id} 发起调查"
        )
        logger.info("DevOps Agent 调查跳过: %s", error)
        return {"success": False, "error": error}

    mapping = _query_account_mapping(target_account_id)
    if mapping is None:
        error = f"账户 {target_account_id} 未上车 DevOps Agent 或未启用"
        logger.info("DevOps Agent 调查跳过: %s", error)
        return {"success": False, "error": error}

    if component is None:
        component = _infer_component_from_source(source)

    # 对 Shared Account：若配置了 related_business_accounts，追加到 description
    related = mapping.get("related_business_accounts") or []
    if related:
        related_text = "、".join(related)
        description = f"{description}\n\n相关业务账户：{related_text}"

    prefixed_description = f"[{source}] {description}"

    # IM bot 派发时把 incident_id 埋成 HTML 注释。report-handler
    # 在 EventBridge 回调时从 journal 反向 grep 这个标记,用作路由键
    # (查 DDB incident# row → chat_id + 渲染"升级 Support"按钮等)。
    # 老 webhook_dispatch 路径一直这么做(2026-06 品牌重命名 MR 还专门
    # 把 `notiops-devops:` 改成 `notiops:`),fusion 时 STS AssumeRole
    # 主路径漏埋了,这里补上。详见 shared/report_delivery/report_handler.py
    # 的 `_extract_incident_id_from_records` + `_INCIDENT_TAG_RE`(双兼容
    # 正则同时识别新旧格式)。
    if incident_id:
        prefixed_description = (
            f"{prefixed_description}\n\n<!--notiops:{incident_id}-->"
        )

    try:
        client = _get_cross_account_client(
            target_account_id=target_account_id,
            mapping=mapping,
            component=component,
            source=source,
        )
    except CrossAccountAssumeRoleError as e:
        logger.error("跨账户 AssumeRole 失败: %s", e)
        return {"success": False, "error": f"跨账户 AssumeRole 失败: {e}"}
    except Exception as e:
        logger.error("创建 devops-agent client 失败: %s", e)
        return {"success": False, "error": str(e)}

    try:
        response = client.create_backlog_task(
            agentSpaceId=mapping["agent_space_id"],
            taskType="INVESTIGATION",
            title=title,
            priority=priority,
            description=prefixed_description,
        )
        task = response["task"]
        task_id = task["taskId"]
        execution_id = task["executionId"]

        logger.info(
            "DevOps Agent 调查已创建: account=%s task_id=%s execution_id=%s source=%s",
            target_account_id,
            task_id,
            execution_id,
            source,
        )
        return {
            "success": True,
            "task_id": task_id,
            "execution_id": execution_id,
        }
    except Exception as e:
        logger.error(
            "DevOps Agent API 调用失败: account=%s error=%s",
            target_account_id,
            e,
        )
        return {"success": False, "error": f"DevOps Agent API 调用失败: {e}"}


# ---------------------------------------------------------------------------
# 公有 API: get_investigation_summary
# ---------------------------------------------------------------------------


def _extract_record_content(content) -> str | None:
    """从 journal record 的 content 字段提取文本。

    content 是 boto3 document 类型，可能是 str / dict / list 等。

    Returns:
        提取到的文本，失败返回 None
    """
    if content is None:
        return None
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        return content.get("markdown", str(content))
    return str(content)


def _extract_summary_from_messages(
    client,
    agent_space_id: str,
    execution_id: str,
) -> str | None:
    """从 message 类型的 journal records 中提取最后一条 assistant 报告。

    全面巡检型调查不会生成 investigation_summary_md 记录，
    报告内容存储在最后一条 role=assistant 的 message 记录中。

    Returns:
        提取到的 Markdown 文本，失败返回 None
    """
    try:
        response = client.list_journal_records(
            agentSpaceId=agent_space_id,
            executionId=execution_id,
            recordType="message",
            order="DESC",
        )

        records = response.get("records", [])
        if not records:
            logger.info(
                "未找到 message 记录: agent_space_id=%s execution_id=%s",
                agent_space_id,
                execution_id,
            )
            return None

        # 遍历找到第一条 assistant 角色的 text 内容
        for record in records:
            raw = record.get("content")
            if raw is None:
                continue

            try:
                if isinstance(raw, str):
                    msg = json.loads(raw)
                elif isinstance(raw, dict):
                    msg = raw
                else:
                    continue

                if msg.get("role") != "assistant":
                    continue

                content_blocks = msg.get("content", [])
                text_parts = []
                for block in content_blocks:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text = block.get("text", "")
                        if text:
                            text_parts.append(text)

                if text_parts:
                    result = "\n\n".join(text_parts)
                    logger.info(
                        "从 message 记录中提取到摘要（%d 字符）: execution_id=%s",
                        len(result),
                        execution_id,
                    )
                    return result

            except (json.JSONDecodeError, TypeError, KeyError):
                continue

        logger.info(
            "message 记录中未找到 assistant 文本: execution_id=%s",
            execution_id,
        )
        return None

    except Exception as e:
        logger.error(
            "从 message 记录提取摘要失败: execution_id=%s error=%s",
            execution_id,
            e,
        )
        return None


def get_investigation_summary(
    execution_id: str,
    target_account_id: str,
    max_retries: int = 3,
    retry_delay: float = 5.0,
) -> str | None:
    """跨账户获取调查摘要 Markdown。

    降级链：
      1. 查询 investigation_summary_md 记录（问题诊断型调查）
      2. 若为空，从最后一条 assistant message 中提取（全面巡检型调查）
      3. 支持重试，应对 EventBridge 事件与摘要生成的时序竞争

    使用 _query_account_mapping_raw 查配置（即便账户 disabled 也允许拉摘要入库）。

    Args:
        execution_id: 执行 ID
        target_account_id: 目标业务账户 ID
        max_retries: 最大重试次数（默认 3 次，总等待 ~15 秒）
        retry_delay: 每次重试间隔秒数（默认 5 秒）

    Returns:
        摘要 Markdown 字符串；获取失败或账户未配置返回 None

    Requirements: R9.2, R9.3
    """
    if not execution_id:
        logger.warning(
            "execution_id 为空，无法获取调查摘要: target_account=%s",
            target_account_id,
        )
        return None

    if not target_account_id:
        logger.warning("target_account_id 为空，无法获取调查摘要")
        return None

    # 跨账号闸门(defense-in-depth):本期"跨账号 disabled",摘要拉取也会对目标账号
    # AssumeRole,故同样收敛到部署账号。锁定模式下部署账号必然通过;其它账号直接返回 None。
    # 正常流程里非部署账号根本不会产生 Completed 事件(create_investigation 已拦),此处为兜底。
    # 见 shared/account_scope.py。
    if not is_account_allowed(target_account_id):
        logger.info(
            "跨账号已 disabled:跳过非部署账号 %s 的调查摘要拉取(仅允许 %s)",
            target_account_id,
            locked_account_id(),
        )
        return None

    mapping = _query_account_mapping_raw(target_account_id)
    if mapping is None:
        logger.warning(
            "账户未配置 DevOps Agent，无法获取调查摘要: target_account=%s",
            target_account_id,
        )
        return None

    agent_space_id = mapping.get("agent_space_id")
    if not agent_space_id:
        logger.warning(
            "账户配置缺少 agent_space_id: target_account=%s",
            target_account_id,
        )
        return None

    try:
        client = _get_cross_account_client(
            target_account_id=target_account_id,
            mapping=mapping,
            component="callback",
            source="fetch-summary",
        )
    except CrossAccountAssumeRoleError as e:
        logger.error(
            "获取调查摘要失败：跨账户 AssumeRole 失败 target_account=%s error=%s",
            target_account_id,
            e,
        )
        return None
    except Exception as e:
        logger.error("创建 devops-agent client 失败: %s", e)
        return None

    # 第一优先级：查询 investigation_summary_md 记录
    for attempt in range(1, max_retries + 1):
        try:
            response = client.list_journal_records(
                agentSpaceId=agent_space_id,
                executionId=execution_id,
                recordType="investigation_summary_md",
            )

            records = response.get("records", [])
            if records:
                content = _extract_record_content(records[0].get("content"))
                if content:
                    logger.info(
                        "从 investigation_summary_md 获取到摘要: execution_id=%s",
                        execution_id,
                    )
                    return content

            if attempt < max_retries:
                logger.info(
                    "未找到 investigation_summary_md（第 %d/%d 次），"
                    "%s 秒后重试: execution_id=%s",
                    attempt,
                    max_retries,
                    retry_delay,
                    execution_id,
                )
                time.sleep(retry_delay)  # nosemgrep: arbitrary-sleep — retry backoff for journal eventual consistency
            else:
                logger.info(
                    "重试 %d 次后仍无 investigation_summary_md，"
                    "尝试从 message 记录降级提取: execution_id=%s",
                    max_retries,
                    execution_id,
                )

        except Exception as e:
            if attempt < max_retries:
                logger.warning(
                    "查询 investigation_summary_md 异常（第 %d/%d 次），"
                    "%s 秒后重试: %s",
                    attempt,
                    max_retries,
                    retry_delay,
                    e,
                )
                time.sleep(retry_delay)  # nosemgrep: arbitrary-sleep — retry backoff after API error
            else:
                logger.warning(
                    "查询 investigation_summary_md 失败，"
                    "尝试从 message 记录降级提取: execution_id=%s error=%s",
                    execution_id,
                    e,
                )

    # 第二优先级：从 message 记录中提取最后一条 assistant 报告
    return _extract_summary_from_messages(client, agent_space_id, execution_id)


# ---------------------------------------------------------------------------
# 公有 API: build_cross_account_devops_client（供报告管道注入跨账户 client）
# ---------------------------------------------------------------------------


def build_cross_account_devops_client(
    target_account_id: str,
    *,
    source: str = "fetch-report",
) -> tuple[object | None, str | None]:
    """返回 (跨账户 devops-agent client, agent_space_id)。

    供报告管道把跨账户 client 注入 report_handler.fetch_investigation_results，
    替代其顶层本账户 client（per-account 架构正确性）。

    任何失败（账户未配置 / 跨账号闸门拦截 / 缺 agent_space_id / AssumeRole 失败）
    返回 (None, None)，调用方据此降级（report_available=false）。

    Requirements: R3.1, R4.1, R4.3
    """
    if not target_account_id or not is_account_allowed(target_account_id):
        return None, None
    mapping = _query_account_mapping_raw(target_account_id)
    if mapping is None or not mapping.get("agent_space_id"):
        return None, None
    try:
        client = _get_cross_account_client(
            target_account_id=target_account_id,
            mapping=mapping,
            component="callback",
            source=source,
        )
        return client, mapping.get("agent_space_id")
    except Exception as e:
        logger.error("build_cross_account_devops_client 失败: %s", e)
        return None, None


# ---------------------------------------------------------------------------
# 公有 API: list_journal_records_cross_account（trace 全量列举）
# ---------------------------------------------------------------------------


def list_journal_records_cross_account(
    *,
    execution_id: str,
    target_account_id: str,
    record_type: str | None = None,
) -> list[dict]:
    """跨账户分页拉取一次 execution 的全部 journal records（供 trace.html 生成）。

    与 get_investigation_summary 的区别：后者只返回提取后的摘要文本；本函数返回
    原始 records 列表，供调用方（report_handler trace 渲染 / fetch_investigation_results
    注入 client）自行处理。

    复用 _query_account_mapping_raw + _get_cross_account_client：AssumeRole 到业务账户
    Trigger_Role（component="callback", source="fetch-trace"），分页 list_journal_records
    （带 nextToken）拉全量。

    任何失败（账户未配置 / 跨账号闸门拦截 / AssumeRole 失败 / API 异常）均返回 []
    并记录 WARN，绝不抛出 —— trace 退化为空不应阻断主报告交付。

    Args:
        execution_id: 执行 ID
        target_account_id: 目标业务账户 ID
        record_type: 可选的 recordType 过滤（None 表示全部类型）

    Returns:
        records 列表；失败返回 []

    Requirements: R3.1, R3.3
    """
    if not execution_id or not target_account_id:
        logger.warning(
            "list_journal_records_cross_account 缺少参数: execution_id=%s target_account=%s",
            execution_id, target_account_id,
        )
        return []

    # 跨账号闸门（defense-in-depth）：与 get_investigation_summary 一致收敛到部署账号。
    if not is_account_allowed(target_account_id):
        logger.info(
            "跨账号已 disabled：跳过非部署账号 %s 的 trace 列举（仅允许 %s）",
            target_account_id, locked_account_id(),
        )
        return []

    mapping = _query_account_mapping_raw(target_account_id)
    if mapping is None:
        logger.warning(
            "账户未配置 DevOps Agent，无法列举 trace records: target_account=%s",
            target_account_id,
        )
        return []

    agent_space_id = mapping.get("agent_space_id")
    if not agent_space_id:
        logger.warning(
            "账户配置缺少 agent_space_id: target_account=%s", target_account_id,
        )
        return []

    try:
        client = _get_cross_account_client(
            target_account_id=target_account_id,
            mapping=mapping,
            component="callback",
            source="fetch-trace",
        )
    except CrossAccountAssumeRoleError as e:
        logger.error(
            "列举 trace records 失败：跨账户 AssumeRole 失败 target_account=%s error=%s",
            target_account_id, e,
        )
        return []
    except Exception as e:
        logger.error("创建 devops-agent client 失败: %s", e)
        return []

    records: list[dict] = []
    params: dict = {
        "agentSpaceId": agent_space_id,
        "executionId": execution_id,
        "limit": 100,
        "order": "ASC",
    }
    if record_type:
        params["recordType"] = record_type
    try:
        while True:
            resp = client.list_journal_records(**params)
            records.extend(resp.get("records", []))
            token = resp.get("nextToken")
            if not token:
                break
            params["nextToken"] = token
    except Exception as e:
        logger.warning(
            "列举 trace records 异常（返回已拉取的 %d 条）: execution_id=%s error=%s",
            len(records), execution_id, e,
        )
    return records


# ---------------------------------------------------------------------------
# 启动自检：检测遗留 Secret 配置并记录弃用警告
# ---------------------------------------------------------------------------


def _emit_deprecation_warning_if_legacy_secret_exists() -> None:
    """Log warning if legacy DEVOPS_AGENT_SECRET_ARN env var still exists.

    New architecture uses DDB config table (shared.queries.accounts).
    The single shared Secret approach is deprecated.

    Requirements: R16.2
    """
    secret_arn = os.environ.get("LEGACY_DEVOPS_AGENT_SECRET_ARN", "")
    if secret_arn:
        logger.warning(
            "Legacy DEVOPS_AGENT_SECRET_ARN detected -- "
            "new architecture stores per-account config in the DDB config "
            "table (see shared.queries.accounts); migrate off the single "
            "shared Secret. Legacy Secret ARN: %s",
            secret_arn,
        )


# 模块加载时触发一次启动自检
_emit_deprecation_warning_if_legacy_secret_exists()
