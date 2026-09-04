"""DevOps Agent 调查结果回调 Lambda（多账户架构）。

EventBridge（Custom Event Bus `notiops-devops-events`）触发，处理
Investigation Completed/Failed/Timed Out 事件。

新架构职责：

- 从事件顶层 `account` 字段识别来源业务账户，查 DynamoDB 配置表
  `notiops-config` 的账户项（`PK=da#<account_id>, SK=meta`，见
  `shared/devops_agent.py::_get_da_account`）得到账户配置
- Investigation Completed：调用平台无关报告管道（跨账户拉一次 long_report → 写 S3
  稳定 key → Bedrock 精简成 summary_card）→ UPSERT 到 `devops_agent_investigation`
  表（只存 summary_card + S3 指针，不内联 summary_raw）
- Investigation Failed / Timed Out：不拉报告、不写 S3，直接以失败描述入库 + 失败卡
- 报告交付：发起会话线程的实时进度卡 + 最终报告卡（progress poller 机制保留）；
  调查类事件**不再**推送 notify_chat_ids（_notify_im 已删除，notify_chat_ids
  机制保留供 PHD/Lambda4 日报使用）
- 测试事件（`detail.test=true` 或 `detail.metadata.test=true`）短路跳过

UPSERT 语义：调用方（Lambda4 / AgentCore）在 `create_investigation` 成功后
预注册一条 `status='pending'` 记录（含 task_id / account_id / title / source）。
本 handler UPDATE 时**不覆盖 `source`** 字段（仅更新 status / summary / model_id
等调查完成后才知道的字段），保留预注册时的触发来源信息。

异常处理：
- DynamoDB 访问失败、Bedrock 完全不可用等 **raise** 让 EventBridge 重试 → DLQ
- 测试事件、未知 account、未知 detail-type 等 return skipped（不 raise）

环境变量：
- CONFIG_TABLE（DynamoDB 配置表 `notiops-config`，由 shared/queries 读取）
- DATA_BUCKET（S3 报告桶，report_delivery 写 investigations/<task_id>/ 前缀）
- DEVOPS_AGENT_SUMMARIZER_MODEL_ID（可选，由 shared/summarizer_config.py 读取）
- BEDROCK_API_KEY_SECRET_ARN（可选，由 shared/bedrock_summarizer.py 读取）
- AWS_REGION（STS / Bedrock endpoint 区域）

Requirements: R6.1, R6.2, R6.3, R6.4, R6.5, R6.6, R6.7, R6.8, R6.9, R6.10
"""

import logging
import os

logger = logging.getLogger("devops_agent_callback.handler")
logger.setLevel(logging.INFO)


def _inspect_space_ids() -> set[str]:
    """全部巡检 agent space 的 id —— 分流判据的来源（改动④）。

    ```
    env INSPECT_AGENT_SPACE_ID              部署账号自己那个
      ∪
    da#<账号>.inspect_agent_space_id        每个成员账号那个（GSI1 一次分页查询）
    ```

    ⚠️ 这是**并集，不是 fallback**。写成「env 拿不到才去查 DDB」的形状会让
    「成员账号的字段没填」退化成「用部署账号的 space」—— 那正好是
    per-account 要摆脱的共用形态，而且它是静默的。

    🔴 **查 DDB 失败就让异常穿出去**（不 catch）。三个候选处置里只有这个是
    可逆的：

    ```
    吞成空集合    → route_of 记 ERROR 后全部按排障处理
                   → 巡检判读整批丢掉，finding 旁边永久空着（**不可逆**）
    退化成只用 env → 成员账号的判读全部误判成排障（**不可逆**，且更隐蔽）
    抛            → Lambda 异步重试 2 次 → 落**函数级** DLQ
                   → 事件还在，修好之后可以重投（**可逆**）
    ```

    ⚠️ 最后那条**靠一行基建**才成立：`notiops-backend-stack.ts` 给本函数配了
    `deadLetterQueue: callbackDlq`（2026-08-29 加）。没有它，Lambda 异步重试
    用尽之后是**丢弃**，而 EventBridge 那侧的 DLQ 只兜「投不进去」——
    也就是说「抛 → 可逆」这个论证在那之前是错的。
    ⚠️ DLQ 保留期 14 天，且有 `notiops-inspection-callback-dlq-nonempty` 告警。

    ⚠️ 依赖 `CONFIG_TABLE` 这个 env（`lambdaEnv` 里有）与 lambdaRole 对
    config 表的 GSI 查询权限（`configTable.grantReadWriteData(lambdaRole)`
    覆盖 index ARN）。两者都已存在 —— 本改动**不需要动基建**。
    """
    out: set[str] = set()
    own = (os.environ.get("INSPECT_AGENT_SPACE_ID") or "").strip()
    if own:
        out.add(own)

    table = (os.environ.get("CONFIG_TABLE") or "").strip()
    if not table:
        # ⚠️ 只有 env 缺失这一种情况**不抛** —— 单账号部署下成员账号那半
        #    压根不存在，抛会让每条 callback 都失败。但要记 ERROR：
        #    CONFIG_TABLE 是 lambdaEnv 里的标准注入，缺了说明 CDK 有问题。
        logger.error(
            "CONFIG_TABLE 未注入，分流判据只用 env 里那一个 space id。"
            "成员账号的判读会被判成排障（静默丢掉）")
        return out

    import boto3
    from inspection.adapters import accounts as acct_repo
    ddb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION"))
    members = acct_repo.inspect_space_ids(ddb.Table(table))
    out.update(members.values())
    logger.info("分流判据：%d 个巡检 space（部署账号 %d + 成员账号 %d）",
                len(out), 1 if own else 0, len(members))
    return out


def _upsert_investigation_record(
    task_id: str,
    execution_id: str,
    account_id: str,
    account_alias: str | None,
    title: str,
    status: str,
    summary_card: str | None,
    model_id: str | None,
    report_md_key: str | None = None,
    report_html_key: str | None = None,
    trace_html_key: str | None = None,
    report_available: bool = False,
    report_truncated: bool = False,
) -> None:
    """UPSERT investigation record via shared/queries (DDB).

    Terminal-state guard + source COALESCE handled inside upsert_investigation.
    调用方可能已经预注册了 status='pending' 的占位记录，本函数用
    upsert_investigation 完成结果回填。

    写 summary_card + S3 指针（report_md_key/html_key/trace_html_key +
    report_available/report_truncated），**不再内联 summary_raw**（H7 根因消除）。
    不动 source 字段（预注册时写入，Callback 无法得知）。
    """
    from shared.queries.reports import upsert_investigation

    fields: dict = {
        "status": status,
        "execution_id": execution_id,
        "account_alias": account_alias,
        "title": title,
        "summary_card": summary_card,
        "model_id": model_id,
        "report_available": report_available,
    }
    if report_md_key:
        fields["report_md_key"] = report_md_key
    if report_html_key:
        fields["report_html_key"] = report_html_key
    if trace_html_key:
        fields["trace_html_key"] = trace_html_key
    if report_truncated:
        fields["report_truncated"] = report_truncated

    upsert_investigation(task_id, account_id=account_id, **fields)


def handler(event: dict, context) -> dict:
    """DevOps Agent 调查结果回调 Lambda 入口（EventBridge 触发）。

    顶层不吞异常：DB 连接失败等可重试错误会抛出。

    ⚠️ **抛出之后落在哪里**（2026-08-29 实测更正）：EventBridge 对本函数是
    **异步**调用（`AsyncEventsReceived == Invocations`）。所以
    EventBridge 那侧的 `retryAttempts: 2` + `notiops-devops-callback-dlq`
    只兜「**投不进去**」；函数内抛异常走的是 **Lambda 自己的**异步重试
    （2 次）然后落**函数级** DLQ。
    🔴 那个函数级 DLQ 是 2026-08-29 才加的（`deadLetterQueue: callbackDlq`）——
    在那之前抛出去的事件**被静默丢弃**，而这段 docstring 一直写着「→ DLQ」。
    可识别的跳过场景（测试事件、未配置账户、未知事件类型）返回 skipped。

    Requirements: R6.1, R6.2, R6.3, R6.4, R6.5, R6.6, R6.8, R6.9
    """
    detail_type = event.get("detail-type", "")
    detail = event.get("detail") or {}
    source_account_id = event.get("account", "")
    metadata = detail.get("metadata") or {}
    data = detail.get("data") or {}

    task_id = metadata.get("task_id", "") or ""
    execution_id = metadata.get("execution_id", "") or ""
    status = data.get("status", "") or ""

    logger.info(
        "收到 DevOps Agent 事件: detail_type=%s source_account=%s "
        "task_id=%s execution_id=%s status=%s",
        detail_type, source_account_id, task_id, execution_id, status,
    )

    # 1. 测试事件短路（R6.1 / 流程 4 step 3）
    if detail.get("test") is True or metadata.get("test") is True:
        logger.info(
            "收到测试事件，跳过处理: source_account=%s task_id=%s",
            source_account_id, task_id,
        )
        return {
            "status": "skipped_test",
            "source_account_id": source_account_id,
        }

    # 2. 查账户配置（raw，含 disabled — 结果仍要入库）
    from shared.devops_agent import _query_account_mapping_raw

    mapping = _query_account_mapping_raw(source_account_id)
    if mapping is None:
        logger.warning(
            "未找到账户配置，跳过处理: source_account=%s",
            source_account_id,
        )
        return {
            "status": "skipped",
            "reason": "account_not_configured",
            "source_account_id": source_account_id,
        }

    account_alias = mapping.get("account_alias") or source_account_id

    # 🔴 **跨账号取判读正文的授权判据**（2026-08-30 收紧）。
    #
    #    原来传的是常量 `True`，理由是「step 2 已经确认这个账号在我们的 config
    #    表里」。而那张表最弱的写入口是 `api/routes/devops_agent.py` 那条 ——
    #    `update_item` 无 ConditionExpression（能为任意账号**新建**行）、
    #    `trigger_role_arn` 只校 `startswith("arn:aws:iam::")`，
    #    而 `api/handler.py` **零** claims / cognito:groups 读取、API GW 只挂
    #    Cognito authorizer（**认证**，不是授权）⇒ 池里任何已登录用户都能写。
    #
    #    攻击链：写一行 da#<攻击者账号> + 在他自己账号建同名前缀的转发角色 →
    #    转发他账号里真实产生的 aws.aidevops 事件 → step 2 放行 →
    #    我们 assume 进**他写的信任策略**的角色 → 拉回他控制的 journal 正文 →
    #    Bedrock 摘要 → 写我们的 S3 + invst# 行 + 拼进巡检 finding。
    #
    # ⇒ 判据收紧到「**active 且 enabled**」。那个弱路由写的是
    #   `onboarding_status="deployed"` 且**不写** `enabled`，过不了这一关；
    #   而合法接入的三条路（BFF 手动回填、BFF org 回填、CDK 播种部署账号）
    #   写的都是 `active` + `enabled=true`。
    #
    # ⚠️ 代价：被运维**停用**的成员账号，判读正文也取不回来（报告里是空的）。
    #    那是**恢复**改动前的行为，不是新的退化 —— 闸门本来就挡着它们。
    #    而 step 2 仍然用 `_raw`（含 disabled），所以「停用的账号也要能存摘要」
    #    那个既有约定不变：记录照样入库，只是不跨账号去拉正文。
    # 判据本体收到 `accounts.is_callback_authorized` —— 单一真源（2026-09-04）。
    # 此前这里手写 `== "active" and enabled is True`，与派发侧的宽松判据
    # （`_is_enabled` / `_is_active`）不在一个文件、没有元断言互锁 ——
    # 谁改哪边都不会被提醒。严格语义逐字不变（见那个函数的安全论证）。
    from inspection.adapters.accounts import is_callback_authorized

    account_authorized = is_callback_authorized(mapping)
    if not account_authorized:
        logger.warning(
            "账号 %s 不是 active+enabled（status=%r enabled=%r）—— "
            "不跨账号取判读正文。报告会是空的（巡检那侧收敛到 "
            "da_parse_status=parse_failed，看板上有红色告警）",
            source_account_id, mapping.get("onboarding_status"),
            mapping.get("enabled"))

    # 3. 事件类型 → event_status
    if detail_type == "Investigation Completed":
        event_status = "completed"
    elif detail_type == "Investigation Failed":
        event_status = "failed"
    elif detail_type == "Investigation Timed Out":
        event_status = "timed_out"
    elif detail_type == "Investigation Created":
        event_status = "created"
    elif detail_type == "Investigation Cancelled":
        event_status = "cancelled"
    elif detail_type == "Investigation Linked":
        event_status = "linked"
    elif detail_type == "Investigation Skipped":
        # R13.13b。官方语义是「matched skip criteria defined in a
        # skill」，而巡检自己上传两份 skill → 这条路径**真实可达**。
        #
        # ⚠️ 这是**终态**，且与 failed / timed_out 的处置相反：重投会得到
        #    同样结果（每轮白烧一次额度，报告永远不出现）。所以它既不进
        #    `_mark_progress_row_completed` 的重试语义，也不出失败卡。
        #
        # ⚠️ 没有这一支时的表现：事件落到下面的 `unknown_detail_type` 分支，
        #    于是 SKIPPED 只能等对账 Lambda 每小时一次去 `GetBacklogTask`
        #    才发现 —— finding 在那之前一直显示「判读缺失（原因未知）」。
        event_status = "skipped"
    else:
        logger.warning("未知 detail-type: %s", detail_type)
        return {
            "status": "skipped",
            "reason": "unknown_detail_type",
            "detail_type": detail_type,
        }

    # 3b. task_id 非空校验（所有事件类型）：空 task_id 会退化
    #     investigations//report.md（S3）/ invst#（DDB PK，多事件互相覆盖）。
    #     按 Req 1.6 一律拒绝并跳过，不进 DLQ。
    if not task_id:
        logger.warning(
            "事件缺 task_id，跳过（不写退化 key）: detail_type=%s source_account=%s "
            "execution_id=%s", detail_type, source_account_id, execution_id,
        )
        return {
            "status": "skipped",
            "reason": "missing_task_id",
            "source_account_id": source_account_id,
        }

    # 3c. 归属分流（R12.5d）：巡检与排障用两个独立 agent space，
    #     但**两类事件走同一个 callback**（EventBridge 规则只按 source +
    #     detail-type 匹配，没有 space 维度）。
    #
    #     判据取 AWS 在事件里给的 `detail.metadata.agent_space_id`，
    #     **不用**我们自己预注册写的 `source` 字段 —— 后者会让分流正确性
    #     依赖预注册写成功，而那段代码是 `except: logger.error` 不抛异常的。
    #
    #     ⚠️ 位置在 step 3b 之后、step 4 之前：step 4 会拉报告 + 调 Bedrock 摘要
    #     + 写 S3，巡检事件也需要那份报告（那正是我们要的判读），所以**不跳过**；
    #     要跳的是 step 6 / 6b 这两条排障链路专属的动作。
    from inspection.domain import callback_route

    route = callback_route.route_of(
        event, inspect_space_ids=_inspect_space_ids())
    is_inspection = route is callback_route.Route.INSPECTION
    if is_inspection:
        logger.info("巡检判读事件: task_id=%s space=%s —— 跳过 progress 行与 IM 投递",
                    task_id, metadata.get("agent_space_id", ""))

    title = (
        metadata.get("title")
        or data.get("title")
        or "DevOps Agent 调查"
    )

    # 4. Completed：单次拉取报告管道（拉一次 long_report → S3 稳定 key →
    #    Bedrock summary_card）。非 completed：仅状态描述，不拉报告。
    artifacts = None
    summary_card: str | None = None
    model_id: str | None = None
    report_md_key = report_html_key = trace_html_key = None
    report_available = False
    report_truncated = False

    if event_status == "completed":
        from shared.report_delivery.report_handler import (
            INSPECTION_KEY_PREFIX,
            CardMode,
            TextSource,
            build_investigation_report,
        )

        incident_id_hint = (metadata.get("incident_id", "")
                            or data.get("incident_id", "")
                            or data.get("incidentId", ""))
        # ⚠️ 巡检不投 IM 卡片（走 Phase 10 的广播层），所以不调 Bedrock 摘要：
        #    白花钱，还会把已经按 finding_id 分好节的判读文本重新压成散文，
        #    而回拼要的正是那些分节。
        #    S3 前缀也分开 —— 同前缀会让「列出全部排障报告」把巡检的一起列出来，
        #    且两者的保留期需求不同（巡检每天产出）。
        artifacts = build_investigation_report(
            execution_id=execution_id,
            target_account_id=source_account_id,
            task_id=task_id,
            detail=detail,
            event_status="completed",
            incident_id=incident_id_hint,
            card_mode=CardMode.SKIP if is_inspection else CardMode.BEDROCK,
            key_prefix=(INSPECTION_KEY_PREFIX if is_inspection
                        else "investigations"),
            # 🔴 **巡检要 agent 的自由输出，不要 DA 的成品报告**（2026-08-31
            #    实测定的）。`investigation_summary_md` 是服务端按固定模板渲染的
            #    产物，`## <finding_id>` 信封**永远不会**出现在里面 —— 而那正是
            #    回拼的缝合点。改动前巡检 100% 落到 parse_failed，且现象与
            #    「skill 没加载」一模一样（实测：skill 两次都加载了、agent 两次
            #    都按信封写了，文本就在 assistant message 记录里被扔掉）。
            #    完整证据见 `TextSource` 的 docstring。
            #
            # ⚠️ 与 `card_mode` **分开传**而不是二者都由 `is_inspection` 推一个
            #    枚举出来：它们表达无关的两件事，合并后任一方单独调整都会
            #    连带改掉另一方。
            text_source=(TextSource.AGENT_OUTPUT if is_inspection
                         else TextSource.PRODUCT_REPORT),
            # 🔴 **闸门那道口子**（2026-08-30）。走到这一步时 step 2 已经确认
            #    `source_account_id`（= `event.account`）在我们的 config 表里，
            #    而那个字段是 EventBridge **服务盖章**的（PutEventsRequestEntry
            #    没有 Account 字段，调用方填不了）—— 那才是真正的边界。
            #
            #    `LOCKED_ACCOUNT_ID` 闸门的本意是「把跨账号采集/调查的**发起**
            #    锁在部署账号」。而这里做的是**读回我们自己派出去的调查的结果**：
            #    事件已经到了、调查已经跑完了、账号已经验过了。闸在这里只做了
            #    一件事 —— 让成员账号的判读永远取不回来，而 run 成功、报告链接
            #    正常、S3 对象都在，只是 parse_status="empty"。零错误码。
            #
            # ⚠️ **不按 route 分**（巡检/排障都传 True）。理由是这个参数说的是
            #    「账号验过了」，而 step 2 对两种事件都跑 —— 按 route 分需要多传
            #    一个 `is_inspection`，而那个参数在语义上与闸门无关；而且会留着
            #    成员账号排障事件那半的空报告（白跑 Bedrock + 写 S3）。
            #
            # ⚠️ 值是 `account_authorized`（active+enabled），**不是常量 True**
            #    —— 见上面那段。仍然不按 route 分：巡检与排障用同一个判据。
            account_already_authorized=account_authorized,
        )
        summary_card = artifacts.summary_card
        model_id = artifacts.model_id
        report_md_key = artifacts.report_md_key
        report_html_key = artifacts.report_html_key
        trace_html_key = artifacts.trace_html_key
        report_available = artifacts.report_available
        report_truncated = artifacts.report_truncated
    elif event_status in ("created", "cancelled", "linked", "skipped"):
        # ⚠️ `skipped` 归在这里而**不是**下面那支「失败」——
        #    它是判据命中的正常结果（skill 里定义的 skip criteria），
        #    叫它「调查 skipped」会让客户以为出了问题。
        label = {"created": "已创建", "cancelled": "已取消", "linked": "已关联",
                 "skipped": "已按判据跳过"}
        summary_card = f"调查{label.get(event_status, event_status)}（task_id: {task_id}）"
    else:
        # failed / timed_out：不拉报告，直接写失败描述
        summary_card = (
            f"调查 {event_status}（task_id: {task_id}，状态: {status})"
            if status
            else f"调查 {event_status}（task_id: {task_id}）"
        )

    # 5. 写入 devops_agent_investigation（UPSERT）：summary_card + S3 指针，
    #    不再内联 summary_raw（H7 根因消除）
    _upsert_investigation_record(
        task_id=task_id,
        execution_id=execution_id,
        account_id=source_account_id,
        account_alias=account_alias,
        title=title,
        status=event_status,
        summary_card=summary_card,
        model_id=model_id,
        report_md_key=report_md_key,
        report_html_key=report_html_key,
        trace_html_key=trace_html_key,
        report_available=report_available,
        report_truncated=report_truncated,
    )

    # 5b. 终态行 best-effort 补指针：若本行此前已是降级终态（report_available=false、
    #     无指针），upsert 的终态 guard 会拦掉指针写入；backfill 绕过 guard 只补
    #     指针 + report_available，不动 status（修复 B3 / Property 4）。
    if event_status == "completed" and report_available and report_md_key:
        try:
            from shared.queries.reports import backfill_report_pointers
            backfill_report_pointers(
                task_id,
                report_md_key=report_md_key,
                report_html_key=report_html_key,
                trace_html_key=trace_html_key,
                report_available=True,
            )
        except Exception as e:
            logger.warning("backfill_report_pointers 异常（不阻断主流程）: %s", e)

    logger.info(
        "DevOps Agent 调查结果已入库: task_id=%s account=%s(%s) "
        "status=%s summary_card_len=%d model=%s report_available=%s",
        task_id, source_account_id, account_alias, event_status,
        len(summary_card or ""), model_id or "-", report_available,
    )

    # 5c. 巡检：把判读文本按 finding_id 回拼到各条 finding 行（7.10b / R9.6）
    #
    # ⚠️ 这一步是整条巡检链的**最后一环**。缺它的表现是：报告里有一大段
    #    分析，而每条 finding 旁边是空的 —— 与「本轮没有风险」在看板上
    #    长得一样。而额度已经花了。
    #
    # ⚠️ 放在 step 5 之后：`invst#` 行先写好，判读再挂到 finding 上。
    #    反过来会让判读挂上了而 investigation 行还没有，对账时对不上。
    if is_inspection and event_status == "completed":
        try:
            _apply_inspection_judgment(
                task_id=task_id,
                long_report=(artifacts.long_report if artifacts else ""),
                report_md_key=report_md_key or "",
                # ⚠️ 复用 trace.html 那步已经拉到的记录，**不重新拉** ——
                #    跨账号逐页 ListJournalRecords 拿的是同一批数据。
                #    `None`（trace 那步失败）时门禁判 no_journal，不判「没问题」。
                journal_records=(artifacts.journal_records
                                 if artifacts else None))
        except Exception as e:                 # noqa: BLE001
            # ⚠️ 不阻断：判读回拼失败不该让 callback 进 DLQ 并反复重试 ——
            #    重试同样会失败（原因是数据形状，不是瞬时故障），
            #    而 DLQ 里堆积的事件会掩盖真正需要重试的那些。
            logger.exception("巡检判读回拼失败（不阻断）: task_id=%s %s", task_id, e)

    # 5d. 巡检：非 completed 的**终态**要把降级原因落到 finding 上
    #     。
    #
    # ⚠️ 不落的表现是那条 finding 永远显示「判读缺失（原因未知）」，
    #    而我们手里明明有答案 —— 且对账 Lambda 每小时都会再去
    #    `GetBacklogTask` 问一遍同一个 task（因为它仍然「在等判读」）。
    #
    # ⚠️ `cancelled` 映射成 `quota_exhausted`（R12.3：`Created` 紧接
    #    `Cancelled` 且无 `Completed` 就是月度额度用尽的签名），
    #    **不是** `investigation_failed` —— 两者的下一步完全不同
    #    （等下个月 vs 查我们的载荷）。
    if is_inspection:
        _INSPECTION_TERMINAL_REASON = {
            "failed": "investigation_failed",
            "timed_out": "investigation_timed_out",
            "skipped": "skipped_by_skill",
            "cancelled": "quota_exhausted",
        }
        reason = _INSPECTION_TERMINAL_REASON.get(event_status, "")
        if reason:
            try:
                _apply_inspection_degraded(task_id=task_id, reason=reason)
            except Exception as e:             # noqa: BLE001
                logger.exception(
                    "巡检降级原因落库失败（不阻断）: task_id=%s reason=%s %s",
                    task_id, reason, e)

    # 6. Progress poller 行管理（终态标记，poller 发最终卡后 TTL 自清）
    #
    # ⚠️ 巡检事件跳过：`progress#` 行是 ECS poller 更新**IM 实时卡片**的驱动数据，
    #    而巡检的 task 压根没有对应的 IM 会话。不跳过会每条 task 写一条
    #    没有任何消费者的行（TTL 30 分钟自清，所以不是泄漏，但是纯浪费）。
    if not is_inspection:
        try:
            if event_status in ("completed", "failed", "timed_out"):
                _mark_progress_row_completed(
                    incident_id=f"task-{task_id}" if task_id else "",
                    final_status=event_status,
                )
        except Exception as e:
            logger.warning("progress 行管理异常（不阻断主流程）: %s", e)

    # 6b. 报告交付（消费 artifacts，不二次拉取）
    #
    # ⚠️ 巡检事件跳过：这一步是「把卡片投回发起调查的那个聊天会话」。
    #    巡检不是从聊天发起的，`_resolve_chat_target()` 拿不到 target，
    #    最终只会记一条 warning 后返回 —— 也就是说**不跳过也不会发错卡片**，
    #    但会白跑一遍 target 解析 + locale 解析 + next_steps 生成。
    #    巡检有自己的推送链路（Phase 10 的 report_delivery 广播层），
    #    结论走那条路，不走这里。
    if not is_inspection:
        try:
            _deliver_report(
                event=event,
                event_status=event_status,
                task_id=task_id,
                execution_id=execution_id,
                agent_space_id=metadata.get("agent_space_id", ""),
                artifacts=artifacts,
                # ⚠️ **必须传。** 形参默认 `False`，不传的话失败卡那条路
                #    永远恢复不出 incident_id → 进度行停在实时卡上直到
                #    30 分钟 TTL 把它收掉。而那是静默的。
                account_authorized=account_authorized,
            )
        except Exception as e:
            logger.warning("报告交付异常（不阻断主流程）: %s", e)

    return {
        "status": "completed",
        "source_account_id": source_account_id,
        "task_id": task_id,
        "event_status": event_status,
        "summary_card_length": len(summary_card or ""),
        "report_available": report_available,
        # ⚠️ 回传 route 是为了让「分流有没有生效」可以从 Lambda 返回值/日志看出来。
        #    不回传的话巡检事件走错路时唯一的痕迹是「客户没收到卡片」——
        #    而那本来就是预期行为，看不出异常。
        "route": route.value,
    }


# ---------------------------------------------------------------------------
# Progress poller 行管理(移植自原 lambda/devops_agent_report_handler.py)
#
# progress# 行是 ECS progress_poller 线程的驱动数据:
#   Created → 写行(poller 扫到后开始 20s 间隔更新实时卡片)
#   Completed/Failed/TimedOut → 标记终止(poller 发最终卡、TTL 自清)
# ---------------------------------------------------------------------------

def _apply_inspection_judgment(
    *, task_id: str, long_report: str, report_md_key: str = "",
    journal_records=None,
) -> None:
    """巡检判读回拼的 IO 外壳。判定逻辑全在 `inspection/callback_apply.py`。

    ⚠️ 这里只做「建 store」这件需要 AWS 的事。回拼逻辑放在纯函数里
    是因为塞进本文件的逻辑需要真事件 + 真 DDB 才跑得到 —— 本 feature
    已经因为「逻辑塞在需要真客户端的函数里」踩过两次静默失败。
    """
    import boto3

    from inspection.adapters.store import InspectionStore
    from inspection.callback_apply import apply_judgment

    table_name = os.environ.get("INSPECTION_TABLE", "")
    if not table_name:
        # ⚠️ 显式 ERROR：缺这个 env 会让**全部**巡检判读永久回不来，
        #    而现象是「finding 旁边总是空的」——查不到原因。
        logger.error(
            "INSPECTION_TABLE 未注入，巡检判读无法回拼（task_id=%s）。"
            "请确认 callback Lambda 的环境变量已部署", task_id)
        return

    store = InspectionStore(boto3.resource("dynamodb").Table(table_name))
    outcome = apply_judgment(
        store, task_id=task_id, long_report=long_report,
        report_md_key=report_md_key, journal_records=journal_records)
    # ⚠️ `skills=` / `degraded=` 要在**这条**行里，不只在门禁自己的日志里：
    #    排查时人是按 task_id grep 的，两个字段分在两条行上就得对时间戳。
    logger.info(
        "巡检判读回拼: task_id=%s status=%s %d/%d 挂上 missing=%d orphaned=%d "
        "skills=%s degraded=%s trustworthy=%s",
        outcome.task_id, outcome.parse_status or outcome.skipped_reason,
        outcome.attached, outcome.expected,
        len(outcome.missing), len(outcome.orphaned),
        list(outcome.skills_loaded) or "-",
        list(outcome.degradations) or "-", outcome.journal_trustworthy)


def _apply_inspection_degraded(*, task_id: str, reason: str) -> None:
    """把降级原因落到该 task 覆盖的**每一条** finding 上。

    ⚠️ 与对账 Lambda 写的是**同一个字段**（`da_parse_status`，经
    `attach_judgment`）。另起字段会让同一件事有两个来源，而看板只读一个。
    两条路径都写它是有意的：事件路径快（秒级），对账路径兜底（事件丢了）。
    幂等 —— 同一条被写两次结果一样。

    ⚠️ 只挂第一条会让同一个 task 里其余 finding 永远停在「等判读」，
    于是对账每小时都把它们再问一遍。
    """
    import boto3

    from inspection.adapters.store import InspectionStore

    table_name = os.environ.get("INSPECTION_TABLE", "")
    if not table_name:
        logger.error(
            "INSPECTION_TABLE 未注入，巡检降级原因无法落库（task_id=%s reason=%s）",
            task_id, reason)
        return

    store = InspectionStore(boto3.resource("dynamodb").Table(table_name))
    mapping = store.get_dispatch(task_id)
    if not mapping:
        # 正常路径：客户在 webchat 里手点的调查也走同一个 callback，
        # 那些 task 没有巡检派发行。这里 is_inspection 已经为真，所以
        # 更可能是映射行被 TTL 清掉（14 天）。
        logger.info("task=%s 没有派发映射，降级原因无处可挂", task_id)
        return

    account_id = str(mapping.get("account_id") or "")
    attached = 0
    for fid in [str(f) for f in (mapping.get("finding_ids") or [])]:
        try:
            if store.attach_judgment(account_id, fid, task_id=task_id,
                                     parse_status=reason):
                attached += 1
        except Exception as e:                 # noqa: BLE001
            logger.exception("挂降级原因失败 finding=%s: %s", fid, e)
    logger.info("巡检降级原因已落: task=%s reason=%s %d 条", task_id, reason, attached)


def _resolve_platform(task_id: str) -> str:
    """从 conversations 表的 task# 行读 platform 字段。"""
    try:
        from core import ddb_state
        row = ddb_state.get_by_task(task_id)
        return (row or {}).get("platform", "")
    except Exception:
        return ""


def _write_progress_row(*, incident_id: str, platform: str,
                        agent_space_id: str, execution_id: str,
                        task_id: str) -> None:
    """写 progress# 行,供 ECS poller 扫描并更新实时卡片。TTL 30 分钟自清。"""
    if not incident_id or not platform:
        return
    import time as _t
    import os
    from shared.queries._client import config_table  # conversations 表
    # 实际写 conversations 表(和 ddb_state 同表)
    import boto3
    table = boto3.resource("dynamodb").Table(os.environ.get("CONVERSATIONS_TABLE", ""))

    locale = ""
    try:
        from core import locale_resolver
        locale = locale_resolver.get_for_incident(incident_id) or ""
    except Exception:
        pass

    # 从 conversations 表读 incident 行拿 message_ref(bot 派发时写的)
    message_ref = {}
    intent_summary = ""
    try:
        from core import ddb_state
        row = ddb_state.get_by_task(task_id) or ddb_state.get_by_incident(incident_id) or {}
        intent_summary = row.get("intent_summary", "")
    except Exception:
        pass

    item = {
        "lookup_key": f"progress#{incident_id}",
        "platform": platform,
        "incident_id": incident_id,
        "agent_space_id": agent_space_id,
        "execution_id": execution_id,
        "message_ref": message_ref,
        "deep_link": "",
        "operator_home_url": "",
        "intent_summary": intent_summary[:200] if intent_summary else "",
        "started_at": int(_t.time()),
        "last_polled_at": 0,
        "tick_count": 0,
        "last_summary_md": "",
        "ttl": int(_t.time()) + 30 * 60,
    }
    if locale:
        item["locale"] = locale
    try:
        table.put_item(Item=item)
        logger.info("Wrote progress row: incident_id=%s platform=%s", incident_id, platform)
    except Exception as e:
        logger.warning("write progress row failed: %s", e)


def _mark_progress_row_completed(incident_id: str, final_status: str = "completed") -> None:
    """标记 progress# 行终止,poller 下次扫描时发最终卡片。"""
    if not incident_id:
        return
    import time as _t
    import os
    import boto3
    table = boto3.resource("dynamodb").Table(os.environ.get("CONVERSATIONS_TABLE", ""))
    try:
        table.update_item(
            Key={"lookup_key": f"progress#{incident_id}"},
            UpdateExpression="SET #s = :st, finalized_at = :ts, #ttl = :ttl",
            ExpressionAttributeNames={"#s": "status", "#ttl": "ttl"},
            ExpressionAttributeValues={
                ":st": final_status,
                ":ts": int(_t.time()),
                ":ttl": int(_t.time()) + 30 * 60,
            },
            ConditionExpression="attribute_exists(lookup_key)",
        )
        logger.info("Marked progress row status=%s: incident_id=%s", final_status, incident_id)
    except Exception as e:
        if "ConditionalCheckFailed" in str(e):
            pass  # 行已不在(TTL 清了或从未写)
        else:
            logger.warning("mark progress row failed: %s", e)


# ---------------------------------------------------------------------------
# 报告交付 — 调用 shared/report_delivery 完成 HTML 报告 + IM 卡片交付
# ---------------------------------------------------------------------------

def _deliver_report(
    *,
    event: dict,
    event_status: str,
    task_id: str,
    execution_id: str,
    agent_space_id: str,
    artifacts=None,
    account_authorized: bool = False,
) -> None:
    """根据事件类型交付报告（消费已构建的 artifacts，不二次拉取）。

    - Created: 发初始实时卡(带 console 深链 + 写 progress# 行带 message_ref)
    - Completed: deliver_report_card(artifacts) —— 复用管道产出的 summary_card/
      report_url/long_report，不再二次 fetch
    - Failed/TimedOut: deliver_failure_card —— 不拉报告、不写 S3
    - Cancelled/Linked: 不投递富卡
    """
    import os
    os.environ.setdefault("CONVERSATIONS_TABLE",
                          os.environ.get("CONVERSATIONS_TABLE", ""))

    from shared.report_delivery.report_handler import (
        _handle_investigation_started,
        deliver_report_card,
        deliver_failure_card,
    )

    detail = event.get("detail") or {}
    metadata = detail.get("metadata") or {}
    data = detail.get("data") or {}
    incident_id = (metadata.get("incident_id", "")
                   or data.get("incident_id", "")
                   or data.get("incidentId", ""))

    if event_status == "created":
        _handle_investigation_started(
            agent_space_id=agent_space_id,
            execution_id=execution_id,
            task_id=task_id,
            incident_id=incident_id,
        )

    elif event_status == "completed":
        if artifacts is None:
            logger.warning("completed 交付缺 artifacts，跳过卡片投递: task_id=%s", task_id)
            return
        deliver_report_card(
            artifacts=artifacts,
            incident_id=(getattr(artifacts, "incident_id", "") or incident_id),
            task_id=task_id,
            agent_space_id=agent_space_id,
            execution_id=execution_id,
            detail=detail,
        )

    elif event_status in ("failed", "timed_out"):
        deliver_failure_card(
            incident_id=incident_id,
            task_id=task_id,
            detail=detail,
            event_status=event_status,
            agent_space_id=agent_space_id,
            execution_id=execution_id,
            target_account_id=event.get("account", ""),
            # 同上：不传的话失败卡恢复不出 incident_id，进度行会一直停在实时卡上
            # 直到 30 分钟 TTL 把它收掉。
            # ⚠️ 判据由 `handler` 算好后透传进来（本函数没有 `mapping`）。
            account_already_authorized=account_authorized,
        )
    # cancelled / linked: 仅状态入库，不投递富卡
