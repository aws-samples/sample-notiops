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

    ⚠️ 只适用于 **content 本身就是正文**的 recordType。实测只有
    `investigation_summary_md` 是这样（裸 markdown，不是 JSON）。
    `investigation_result` / `investigation_summary` / `finding` 的 content 是
    **JSON 字符串**，走这里会把 `{"type": ..., "text": ...}` 整段当正文返回，
    报告里就会漏出 JSON 包装。那几类用类型感知的提取器
    （见 `_extract_investigation_result_text`）。

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


def _extract_investigation_result_text(
    client,
    agent_space_id: str,
    execution_id: str,
) -> str | None:
    """读**成品报告**记录里的 markdown。按 `_REPORT_RECORD_TYPES` 逐个类型试。

    ## 为什么不写死单一类型

    三次实测，`recordType` 的构成每次都不同：

    ```
    2026-07 的 5 次    message · utilization · investigation_result
                       + 部分带 symptom/finding/observation/investigation_gap
                       其中 1 次（07-14）带 investigation_summary_md + investigation_summary
    2026-08-11 的 4 次 message · utilization · investigation_result   （细粒度记录全消失）
    2026-08-19 的 1 次 message · utilization · investigation_summary_md(2) ·
                       investigation_summary(2) · finding(2) · observation(2) · symptom(1)
                       + ui_investigation_summary(11)   ← 全新类型
                       ⚠️ **没有 investigation_result**
    ```

    所以「哪个类型是成品报告」这件事**不是稳定契约**。上一版把
    `investigation_result` 当唯一第一优先级，而 2026-08-19 那次它压根没出现 ——
    那次会直接落到最末的 message 兜底（对话式回复而非成品报告）。

    ⚠️ `ui_investigation_summary` 故意**不在**候选里：它是给控制台渲染的 UI 组件树
    （`{"type":..., "content":{"id":"root","type":"container","children":[...]}}`，
    单条 6.8KB），不是可读报告。把它当报告会把一坨组件 JSON 推给客户。

    ## content 的编码按类型不同

    ```
    investigation_result       JSON 字符串 {"type","text"}   正文在 text
    investigation_summary_md   **裸 markdown**（不是 JSON）
    ```
    两种都要能处理 —— 只处理一种，另一种会漏出 JSON 包装或直接被丢弃。

    ⚠️ recordType 在 API 模型里**没有枚举、文档也没列**（`order` 却是 ASC|DESC 枚举）。
    因此只用 journal 取**叙述**；需要可复现的结构化数字 SHALL NOT 依赖它。
    """
    for record_type in _REPORT_RECORD_TYPES:
        text = _read_report_record(client, agent_space_id, execution_id, record_type)
        if text:
            return text
    return None


# 成品报告的候选 recordType，按优先级。⚠️ 顺序之外更重要的是**逐个都试** ——
# 实测三批调查里没有任何一个类型是每次都出现的。
# SHALL NOT 加入 `ui_investigation_summary`（UI 组件树，见上）或 `message`
# （对话式回复，由 `_extract_summary_from_messages` 单独兜底）。
_REPORT_RECORD_TYPES: tuple[str, ...] = (
    "investigation_result",
    "investigation_summary_md",
)


def _read_report_record(
    client,
    agent_space_id: str,
    execution_id: str,
    record_type: str,
) -> str | None:
    """取单一 recordType 的最新一条并解出正文。兼容 JSON 包装与裸 markdown。"""
    try:
        response = client.list_journal_records(
            agentSpaceId=agent_space_id,
            executionId=execution_id,
            recordType=record_type,
            order="DESC",
            limit=1,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "查询 %s 失败: execution_id=%s error=%s", record_type, execution_id, e,
        )
        return None

    for record in response.get("records", []):
        raw = record.get("content")
        if raw is None:
            continue
        try:
            payload = json.loads(raw) if isinstance(raw, str) else raw
        except (json.JSONDecodeError, TypeError):
            # 裸 markdown 是 `investigation_summary_md` 的**正常**形态（实测 2026-08-19
            # 那条以 "# Investigation Summary" 开头、不是 JSON），不是降级路径。
            if isinstance(raw, str) and raw.strip():
                logger.info(
                    "%s 是裸文本（%d 字符）: execution_id=%s",
                    record_type, len(raw), execution_id,
                )
                return raw
            continue
        if not isinstance(payload, dict):
            continue
        text = payload.get("text")
        if isinstance(text, str) and text.strip():
            logger.info(
                "从 %s 获取到摘要（%d 字符）: execution_id=%s",
                record_type, len(text), execution_id,
            )
            return text
    return None


def _extract_summary_from_messages(
    client,
    agent_space_id: str,
    execution_id: str,
) -> str | None:
    """从 message 类型的 journal records 中提取最后一条 assistant 报告。

    这是降级链的**最后一档**，不是常规路径 —— 它拿到的是对话式回复，不是成品报告。
    原注释说「全面巡检型调查不会生成 investigation_summary_md 记录，所以报告在最后
    一条 assistant message 里」：前半句对（实测 8/9 不生成），后半句错 —— 成品报告
    在 `investigation_result` 记录里，见 `_extract_investigation_result_text`。
    走到这里说明那两种记录都没拿到。

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

    降级链（每一轮①②都试，命中即返回；重试只覆盖 EventBridge 事件与摘要落库的
    时序竞争，不是为了等某一种 recordType 出现）：
      ① investigation_result      当前主路径。实测 8/9 命中，单条成品 markdown，
                                  content 是 JSON 字符串，正文在 `text`
      ② investigation_summary_md  老调查仍可能命中，content 是裸 markdown
      ③ 最后一条 assistant message  兜底，是对话式回复而非成品报告

    ⚠️ 顺序曾经是反的（①②互换且先把②重试满 3×5 秒才降级）。因为 8/9 的调查不产出
    `investigation_summary_md`，那等于每次回调白等 15 秒再退到③。

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

    # ①：每一轮把 `_REPORT_RECORD_TYPES` 里的类型**逐个都试**，命中即返回。
    # 重试只为覆盖 EventBridge 事件与摘要落库之间的时序竞争，不是为了等某一种类型出现。
    #
    # ⚠️ 为什么不能只试一种：`recordType` 的构成三次实测三个样子，没有任何类型每次都出现
    #    （详见 `_extract_investigation_result_text` 的 docstring）。上一版只试
    #    `investigation_result`，而 2026-08-19 那次调查压根没产生它 → 直接落到 message 兜底。
    #    再上一版反过来只试 `investigation_summary_md` 并先重试满 3×5 秒 → 每次白等 15 秒。
    for attempt in range(1, max_retries + 1):
        content = _extract_investigation_result_text(
            client, agent_space_id, execution_id
        )
        if content:
            return content

        if attempt < max_retries:
            logger.info(
                "成品报告记录 %s 均未命中（第 %d/%d 次），%s 秒后重试: execution_id=%s",
                list(_REPORT_RECORD_TYPES),
                attempt,
                max_retries,
                retry_delay,
                execution_id,
            )
            time.sleep(retry_delay)  # nosemgrep: arbitrary-sleep — retry backoff for journal eventual consistency
        else:
            logger.info(
                "重试 %d 次后 %s 均无，降级到 message 提取: execution_id=%s",
                max_retries,
                list(_REPORT_RECORD_TYPES),
                execution_id,
            )

    # ② 兜底：从 message 记录中提取最后一条 assistant 报告
    return _extract_summary_from_messages(client, agent_space_id, execution_id)


# ---------------------------------------------------------------------------
# 公有 API: build_cross_account_devops_client（供报告管道注入跨账户 client）
# ---------------------------------------------------------------------------


def build_cross_account_devops_client(
    target_account_id: str,
    *,
    source: str = "fetch-report",
    account_already_authorized: bool = False,
) -> tuple[object | None, str | None]:
    """返回 (跨账户 devops-agent client, agent_space_id)。

    供报告管道把跨账户 client 注入 report_handler.fetch_investigation_results，
    替代其顶层本账户 client（per-account 架构正确性）。

    任何失败（账户未配置 / 跨账号闸门拦截 / 缺 agent_space_id / AssumeRole 失败）
    返回 (None, None)，调用方据此降级（report_available=false）。

    Args:
        account_already_authorized: 调用方**已经**确认过 `target_account_id`
            是我们登记的账号。为真时跳过 `LOCKED_ACCOUNT_ID` 闸门。

    🔴 **那个参数说的是前提，不是动作**（2026-08-30 加）。名字刻意不叫
    `skip_gate` —— 那会让下一个人以为「想省事就传 True」。传它的调用方必须
    真的验过，而目前只有一个：`devops_agent_callback.handler`，它的 step 2
    用 `_query_account_mapping_raw(event.account)` 拦掉未登记账号，
    **而 `event.account` 是 EventBridge 服务盖章的**（`PutEventsRequestEntry`
    没有 `Account` 字段，调用方填不了）—— 那才是真正的边界。

    ⚠️ 为什么需要它：这道闸的本意是「把跨账号**采集/调查的发起**锁在部署账号」
    （见 `shared/account_scope.py` 的 docstring）。而本函数在 callback 里做的是
    **读回我们自己派出去的调查的结果** —— 事件已经到了、调查已经跑完了、账号
    已经验过了。闸在这里只做了一件事：让成员账号的判读永远取不回来，而
    `run` 状态、报告链接、S3 对象全部正常，只是 `parse_status="empty"`。
    零错误码。

    ⚠️ 默认 `False`，所以**其余调用方行为一字不变**（包括那个未部署的
    `report_handler.lambda_handler`，它没有账号校验，不该传 True）。
    """
    if not target_account_id:
        return None, None
    # 🔴 **判据是「必须授权」，不是「授权了就绕过闸门」**（2026-08-30 第二次改）。
    #
    #    上一版写的是 `if not authorized and not is_account_allowed(...)`，
    #    也就是「没授权时回落到 LOCKED_ACCOUNT_ID 闸门」。而 orgMode 下
    #    `LOCKED_ACCOUNT_ID` 是**空串**（notiops-backend-stack.ts:551
    #    `orgMode ? "" : ACCOUNT_ID`）→ `is_account_allowed` 恒 True
    #    → `not True` = False → 整个条件为假 → **不 return，继续往下 assume**。
    #
    #    后果比没有判据更糟：调用方那侧记着 "不跨账号取判读正文" 的 WARNING，
    #    而代码真的取了。排查的人会相信那行日志。
    #    （两份独立 review 都抓到这条；我自己用真值表复现过。）
    #
    # ⇒ 现在：没授权就是不放行，两种部署形态行为一致，日志不再说谎。
    # ⚠️ 默认 `False` ⇒ **fail-closed**：将来谁忘了传这个参数，拿到的是
    #    `(None, None)`（报告降级、可见），而不是静默的跨账号 assume。
    # ⚠️ `is_account_allowed` 在这条路上**不再被读** —— 那道闸锁的是
    #    「跨账号采集/调查的**发起**」，而这里是读回我们自己派出去的结果。
    #    把「谁有资格被读」交给调用方的显式判据（active + enabled）更准确。
    if not account_already_authorized:
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
    account_already_authorized: bool = False,
    agent_space_id: str = "",
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
        account_already_authorized: 调用方已确认该账号是我们登记的账号，
            为真时跳过 `LOCKED_ACCOUNT_ID` 闸门。语义与理由见
            `build_cross_account_devops_client`（两处必须一起传，否则会出现
            「报告正文取到了、trace 是空的」这种半通状态）。

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

    # 🔴 与 `build_cross_account_devops_client` **同一个判据形状**：必须授权。
    #    上一版是「没授权时回落到闸门」，而 orgMode 下闸门恒放行 ⇒ 判据 no-op。
    #    详见那个函数里的说明。
    if not account_already_authorized:
        logger.info(
            "账号 %s 未被调用方授权（active+enabled），跳过 trace 列举。"
            "⚠️ 与报告正文那条**必须一致** —— 只放一个会出现"
            "「正文取到了、trace 是空的」这种半通状态，而 trace 的失败是"
            "best-effort 吞掉的，那种半通完全静默",
            target_account_id,
        )
        return []

    mapping = _query_account_mapping_raw(target_account_id)
    if mapping is None:
        logger.warning(
            "账户未配置 DevOps Agent，无法列举 trace records: target_account=%s",
            target_account_id,
        )
        return []

    # 🔴 **调用方传进来的 space 优先。** `mapping` 里那个是**排障** space
    #    （`da#<acct>.agent_space_id`），而巡检的 execution 活在**巡检** space
    #    （`inspect_agent_space_id`）里 —— 两者是不同的 agent space。
    #
    #    只读 mapping 的后果（2026-08-31 实机确认）：拿排障 space 去查一个
    #    巡检 execution 的 journal，`ListJournalRecords` 返回空 ⇒
    #
    #    ```
    #    trace.html          巡检的一直是**空的**（6.4KB 骨架、零条记录）
    #    skill 加载门禁       恒判 no_journal / trustworthy=False
    #                        —— 一个恒亮的红灯，而门禁的价值全在于它平时是绿的
    #    ```
    #
    #    而正文那一侧是对的：`build_investigation_report` 用的是
    #    **事件 metadata 里的** `agent_space_id`（DA 盖章的、必然正确）。
    #    也就是同一次回调里「正文取到了、trace 是空的」——
    #    正是本函数 docstring 警告过的那种半通状态，只是原因不是授权而是 space。
    #
    # ⚠️ 空字符串才回落到 mapping：排障链路没有第二个 space，行为不变。
    agent_space_id = (agent_space_id or "").strip() or mapping.get("agent_space_id")
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
    # ⚠️ **页数上限**。原来是裸 `while True` —— AWS 若返回一个重复的 nextToken
    #    （或我们把 params 传坏了），这里会一直转到 Lambda 超时。而超时是这个
    #    项目反复踩的那类静默失败：finish_run 不执行、行停在 running、消息被删
    #    不进 DLQ。2026-08-30 补上，同时它让「拿 MagicMock 当 client」的测试
    #    不再死循环（MagicMock.get() 恒真）。
    #    200 页 × 每页上限，远超任何一次真实 execution 的记录数。
    _MAX_PAGES = 200
    try:
        for page in range(_MAX_PAGES):
            resp = client.list_journal_records(**params)
            records.extend(resp.get("records", []))
            token = resp.get("nextToken")
            if not token:
                break
            params["nextToken"] = token
        else:
            logger.error(
                "列举 trace records 达到页数上限 %d，可能是 nextToken 不收敛："
                "execution_id=%s target_account=%s 已拉 %d 条",
                _MAX_PAGES, execution_id, target_account_id, len(records))
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
