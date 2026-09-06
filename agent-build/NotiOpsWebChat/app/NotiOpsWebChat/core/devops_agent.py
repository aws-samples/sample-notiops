"""
DevOps Agent 深度调查接入（Web Chat / AgentCore 侧，**自包含重写**）。

背景：IM 侧用 Lambda + EventBridge 异步回调那套；Web Chat 是 AgentCore + Strands agent，
不照搬那套基础设施，只**复用它连 DevOps Agent 的方法**，用 **agent tool + 两段式（发起 →
稍后查）** 重写：
  · start_investigation()      —— 调 devops-agent create_backlog_task(INVESTIGATION)，立即返回 task/execution id
  · get_investigation_result() —— 用 execution_id 拉回调查摘要 Markdown（没好就如实说"还在跑"）

连接方式（实测对齐本账号真实情况）：
  - **部署账号（默认）**：DevOps Agent 的 Agent Space 就在本账号里（IM 部署时自动创建），
    **直接用 runtime 执行角色的本地凭证调 `devops-agent`**（boto3 service 名带连字符），
    **无需 config 表、无需跨账号 AssumeRole**。Agent Space 优先读 env
    `DEVOPS_AGENT_SPACE_ID`（scripts/deploy_agent.sh 把主栈输出替进 agentcore.json）；
    env 为空时才回退 ListAgentSpaces 按名字发现
    （`notiops-devops-<account>` 方式B / `notiops-oneclick-<account>` 方式A）。
  - **跨账号（可选，留口）**：若 config 表有 da#{account} 行且目标≠部署账号，沿用 IM 的
    AssumeRole trigger_role_arn 方式。本期跨账号受 LOCKED 闸门约束，通常用不到。

边界与安全：
  - 跨账号闸门：LOCKED_ACCOUNT_ID 限定仅部署账号（与 core/aws_session 一致思路）。
  - 没有可用 Agent Space → 优雅降级（not_onboarded 提示），不抛、不阻断对话。
  - 失败安全：任何异常 → {error}，agent 照常运行。
"""
from __future__ import annotations

import json
import logging
import os

import boto3
from botocore.exceptions import ClientError, BotoCoreError

# DA `ui_investigation_summary` 组件树的摊平器 —— 单一来源，两棵 core/ 树逐字节一致
# （tests/test_core_tree_parity.py 的 _MUST_MATCH）。IM 侧的 report-handler 读的是同一份。
from core.da_ui_tree import summary_md as _ui_summary_from_records

logger = logging.getLogger(__name__)


def _safe_err(e: Exception) -> str:
    """Sensitive-data handling: return the exception *type* (plus the AWS
    error code for botocore ClientError), never the raw message / response body
    which can embed request payloads or user data. See docs/LOGGING_STANDARD.md."""
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__


def _is_unregistered_domain(e: Exception) -> bool:
    """space 没开过 Operator App（web app）时，create_backlog_task 会返回
    "Invalid or unregistered domain"。

    ⚠️ 这条路径现在是**兜底**：两条部署路径与成员账号 StackSet 都在建 space 的同时调
    EnableOperatorApp 把它开好了（见 infra/lib/notiops-backend-stack.ts、
    infra/lib/notiops-webchat-standalone-stack.ts、infra/member-devops-agent.yaml）。
    还能撞上它的只有两种 space：本版本之前建的老 space，和客户自己手工建的 space。

    这里仅【就地分类】该错误
    以便给出可操作提示——不返回、不记录原始 message（遵守 docs/LOGGING_STANDARD.md：
    原文可能含请求负载/用户数据）。判定后调用方只输出固定的引导文案。"""
    resp = getattr(e, "response", None)
    msg = (resp.get("Error", {}) or {}).get("Message", "") if isinstance(resp, dict) else ""
    low = (msg or "").lower()
    return "unregistered domain" in low or ("invalid" in low and "domain" in low)


_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
_CONFIG_TABLE = os.environ.get("CONFIG_TABLE", "notiops-config")
_LOCKED = os.environ.get("LOCKED_ACCOUNT_ID", "").strip()
# 可显式指定 Agent Space（跳过自动发现）；否则按名字 notiops-devops-<account> 优先自动选。
_SPACE_ENV = os.environ.get("DEVOPS_AGENT_SPACE_ID", "").strip()
# 部署脚本注入；未注入时是占位符 __DEVOPS_AGENT_SPACE_ID__，要当成"未设置"忽略，
# 回退到 ListAgentSpaces 自动发现（防止把字面占位符当成真 space id）。
if _SPACE_ENV.startswith("__") and _SPACE_ENV.endswith("__"):
    _SPACE_ENV = ""
# 可用 env 整体关掉。
_DISABLED = os.environ.get("NOTIOPS_DISABLE_DEVOPS_AGENT", "").strip().lower() in ("1", "true")

_sts_cache: dict[str, dict] = {}
_space_cache: dict[str, str] = {}  # account_id -> agent_space_id（自动发现结果缓存）


def configured() -> bool:
    return not _DISABLED


def _deploy_account_id() -> str | None:
    if _LOCKED:
        return _LOCKED
    try:
        return boto3.client("sts", region_name=_REGION).get_caller_identity()["Account"]
    except Exception:  # noqa: BLE001
        return None


def _target_account(account_id: str | None) -> str | None:
    """解析本轮目标账号：缺省=部署账号；跨账号受 LOCKED 闸门约束。"""
    acct = account_id or _deploy_account_id()
    if not acct:
        return None
    if _LOCKED and str(acct) != _LOCKED:
        return None
    return str(acct)


def _get_da_config(account_id: str) -> dict | None:
    """读 DevOps Agent 账号配置行（PK=da#{account}, SK=meta）。无表/无行 → None。"""
    try:
        tbl = boto3.resource("dynamodb", region_name=_REGION).Table(_CONFIG_TABLE)
        return tbl.get_item(Key={"PK": f"da#{account_id}", "SK": "meta"}).get("Item")
    except Exception:  # noqa: BLE001  — 表不存在等都按"无配置"处理
        return None


def _client_and_space(account_id: str) -> tuple:
    """返回 (devops-agent client, agent_space_id)。
    - 目标==部署账号：本地凭证直连 + 自动发现/指定 Agent Space。
    - 否则且 config 有跨账号配置：AssumeRole trigger role + config 的 agent_space_id。
    取不到 Agent Space → 返回 (None, None)（调用方走 not_onboarded）。

    `account_id` 传空 = 部署账号。这一步必须在这里补，不能指望每个调用方先过
    `_target_account()`：空串跟部署账号号永远不相等 → 一路走到跨账号分支 → 找不到
    `da#` 配置行 → (None, None) → 客户看到「无法定位该账号的 Agent Space」。
    2026-09-02 IM 侧现网实测命中（同一份逻辑，见 core/devops_agent.py 的长注释）。"""
    deploy = _deploy_account_id()
    target = str(account_id or "").strip() or str(deploy or "")
    if not target:
        return (None, None)
    is_deploy = bool(deploy) and target == str(deploy)

    if is_deploy:
        client = boto3.client("devops-agent", region_name=_REGION)
        space = _discover_space(client, target)
        return (client, space) if space else (None, None)

    # 跨账号：需要 config 行（trigger_role_arn + agent_space_id）
    cfg = _get_da_config(target)
    if not cfg or not cfg.get("trigger_role_arn") or not cfg.get("agent_space_id"):
        return (None, None)
    if cfg.get("enabled") is not True and cfg.get("onboarding_status") not in (None, "active"):
        return (None, None)
    client = _assume_client(target, cfg)
    return (client, cfg["agent_space_id"])


def _discover_space(client, account_id: str) -> str | None:
    """自动发现部署账号里**排障用**的 Agent Space。env 指定优先；否则按名字
    `notiops-devops-<account>`（方式B）/ `notiops-oneclick-<account>`（方式A）匹配。
    结果缓存。

    ⚠️ 这整个函数是**兜底**，不是主路径：两条部署路径的 CDK 都会把
    `DEVOPS_AGENT_SPACE_ID` 注进来（`web-chat-core.ts` / `im-core.ts`），有 env 时
    第一行就返回了。会走到 ListAgentSpaces 的只有「栈还没更新到含该 env 的版本」。

    ⚠️ **不兜底取 `spaces[0]`。** 账号里现在可能有两个 space（`notiops-devops-*`
    排障 · `notiops-inspection-*` 巡检），而 `ListAgentSpaces` 的返回顺序没有任何
    保证。猜中巡检那个的症状是**静默的**：报告照样出，只是跑在巡检 space 上、
    加载的是巡检的判读 skill，没有任何错误信号。所以匹配不中且候选 ≥2 时返回
    None，让调用方给出明确提示。**与 `core/devops_agent.py` 逐条对齐**（这份
    曾经漂移过，只有它还留着 `or spaces[0]`）。
    """
    if _SPACE_ENV:
        return _SPACE_ENV
    if account_id in _space_cache:
        return _space_cache[account_id]
    try:
        resp = client.list_agent_spaces()
        spaces = resp.get("agentSpaces") or resp.get("agentSpaceSummaries") or []
        if not spaces:
            return None
        preferred_names = [
            f"notiops-devops-{account_id}",
            f"notiops-oneclick-{account_id}",
        ]
        chosen = next(
            (s for name in preferred_names for s in spaces if s.get("name") == name),
            None,
        )
        if chosen is None:
            # 只有一个 space 且名字不匹配 → 沿用它（客户手工建的 / 早期命名）。
            # 两个及以上 → 拒绝猜测。
            if len(spaces) == 1:
                chosen = spaces[0]
                logger.info(
                    "devops_agent: 唯一的 agent space 名字不在 %s 里，沿用它: name=%s",
                    preferred_names, chosen.get("name"),
                )
            else:
                logger.error(
                    "devops_agent: 账号 %s 有 %d 个 agent space 但没有一个叫 %s，"
                    "拒绝猜测（猜错会把调查跑到巡检 space 且无任何信号）。"
                    "请设置 DEVOPS_AGENT_SPACE_ID。现有: %s",
                    account_id, len(spaces), preferred_names,
                    [s.get("name") for s in spaces],
                )
                return None
        sid = chosen.get("agentSpaceId")
        if sid:
            _space_cache[account_id] = sid
        return sid
    except Exception as e:  # noqa: BLE001
        logger.warning("devops_agent: list_agent_spaces failed: %s", _safe_err(e))
        return None


def _assume_client(account_id: str, cfg: dict):
    """跨账号：AssumeRole trigger role → devops-agent client（带凭证缓存）。"""
    role_arn = cfg["trigger_role_arn"]
    region = cfg.get("region") or _REGION
    parts = (role_arn or "").split(":")
    if len(parts) < 5 or parts[4] != str(account_id):
        raise ValueError(f"trigger_role_arn 账号段与目标账号不一致：{role_arn}")
    import datetime as _dt
    now = _dt.datetime.now(_dt.timezone.utc)
    cached = _sts_cache.get(account_id)
    if cached and (cached["exp"] - now).total_seconds() > 300:
        creds = cached["creds"]
    else:
        r = boto3.client("sts", region_name=_REGION).assume_role(
            RoleArn=role_arn, RoleSessionName=f"agentcore-{account_id}-investigate"[:64],
            ExternalId=str(account_id), DurationSeconds=3600)
        c = r["Credentials"]
        creds = {"AccessKeyId": c["AccessKeyId"], "SecretAccessKey": c["SecretAccessKey"],
                 "SessionToken": c["SessionToken"]}
        _sts_cache[account_id] = {"creds": creds, "exp": c["Expiration"]}
    return boto3.client("devops-agent", region_name=region,
                        aws_access_key_id=creds["AccessKeyId"],
                        aws_secret_access_key=creds["SecretAccessKey"],
                        aws_session_token=creds["SessionToken"])


def _not_onboarded(account_id: str | None) -> dict:
    return {"error": "not_onboarded",
            "message": (f"账号 {account_id or '(部署账号)'} 没有可用的 AWS DevOps Agent Agent Space，"
                        "无法发起深度调查。请确认该账号已创建 DevOps Agent Agent Space"
                        "（或设置 DEVOPS_AGENT_SPACE_ID）。当前可用本主题的只读工具"
                        "（CloudWatch 告警/指标/日志、CloudTrail 事件、EC2/RDS 状态）做即时排查。")}


def operator_urls(agent_space_id: str, task_id: str = "") -> dict:
    """构造 DevOps Agent **Operator App**（后台 Web 应用）链接——**每个客户不同**，
    按其 agentSpaceId 动态拼；绝不写死。给客户"点进去看进度"用。

    URL scheme（与 IM 端 feishu_sender 一致，遵循 DevOps Agent Operator App 的 per-agent-space 深链约定）：
      · 后台首页：https://{agent_space_id}.aidevops.global.app.aws/
      · 本次调查进度深链：https://{agent_space_id}.aidevops.global.app.aws/investigation/{task_id}
        （深链 key 是 **task_id**，不是 execution_id）
    返回 {home, deep_link}；agent_space_id 为空 → 返回空串（调用方据此不展示）。"""
    if not agent_space_id:
        return {"home": "", "deep_link": ""}
    root = f"https://{agent_space_id}.aidevops.global.app.aws"
    home = f"{root}/"
    deep = f"{root}/investigation/{task_id}" if task_id else home
    return {"home": home, "deep_link": deep}


def start_investigation(title: str, description: str, account_id: str | None = None,
                        priority: str = "MEDIUM") -> dict:
    """发起一次 DevOps Agent 深度调查（异步，立即返回 task/execution id）。
    成功：{ok, task_id, execution_id, agent_space_id, account_id, console_url, console_home, note}；
    未上车/失败：{error, message}。console_url = 本次调查的后台进度深链（客户可点开看进度）。"""
    if _DISABLED:
        return _not_onboarded(account_id)
    acct = _target_account(account_id)
    if not acct:
        return {"error": "cross_account_denied",
                "message": "跨账号深度调查未开启，当前仅支持部署账号。"}
    try:
        client, space = _client_and_space(acct)
    except (ClientError, BotoCoreError, Exception) as e:  # noqa: BLE001
        return {"error": "connect_failed", "message": f"连接 DevOps Agent 失败：{_safe_err(e)}"}
    if not client or not space:
        return _not_onboarded(acct)
    try:
        resp = client.create_backlog_task(
            agentSpaceId=space, taskType="INVESTIGATION",
            title=title, priority=priority,
            description=f"[notiops-web-chat] {description}")
        task = resp["task"]
        _urls = operator_urls(space, task["taskId"])
        return {"ok": True, "task_id": task["taskId"], "execution_id": task["executionId"],
                "agent_space_id": space, "account_id": acct,
                "console_url": _urls["deep_link"], "console_home": _urls["home"],
                "note": "调查已发起，通常需几分钟。稍后用 get_investigation_result 凭 execution_id 查结果。"}
    except (ClientError, BotoCoreError, Exception) as e:  # noqa: BLE001
        if _is_unregistered_domain(e):
            logger.warning("devops_agent start failed: unregistered_domain")
            return {"error": "unregistered_domain",
                    "message": ("这个 Agent Space 还没开启 Web 应用（Operator App），暂时无法发起调查。"
                                "新部署会自动开好，所以你多半用的是旧 space 或手工建的 space。"
                                "去 DevOps Agent 控制台（https://console.aws.amazon.com/aidevops/home#/agent-spaces）"
                                "→ 你的 space → Access → Configure web app 点一次即可。"
                                "（详见 docs/DEPLOYMENT.md §5.3.3。）")}
        logger.warning("devops_agent start failed: %s", _safe_err(e))
        return {"error": "start_failed", "message": f"发起调查失败：{_safe_err(e)}"}


def get_investigation_result(execution_id: str, account_id: str | None = None,
                             lang: str = "en") -> dict:
    """凭 execution_id 拉回调查结果。还没跑完 → {status:'running'}。

    对齐 DevOps Agent 后台的 4 个 tab，**分区返回**（此前是 `structured or summary_md or
    last_assistant` 三选一，Root cause 一出现就把 Summary 顶掉、Mitigation plan 从来没取过）：
      - Summary            → `sections.summary`      （`ui_investigation_summary` 的**执行摘要卡**：
                                                      问题概要 / 根本原因 / 修复方案；退化到末条 assistant）
      - Investigation timeline → 不在这里：调查过程走 `poll_investigation` 实时进右侧栏
      - Root cause         → `sections.root_cause`   （结构化 investigation_summary：Impact/Root
                                                      causes/Key findings/Investigation gaps；
                                                      退化到 investigation_summary_md 原文）
      - Mitigation plan    → `sections.mitigation`   （`mitigation_summary_md` 原文：Action/Reasoning/
                                                      Execution Plan/Code Change Spec；退化到
                                                      list_recommendations。**有就给、没有就空**）

    ⚠️ 数据源是**实测**校准过的（2026-08-20 拿现网一次真调查 exe-ops1-0cbea51b… 的 92 条 journal
    记录逐类核对）：`investigation_summary_md` 的内容其实是 `# Investigation Summary` +
    Symptoms/Findings/**Root Cause** —— 它是后台 **Root cause** 页的 md 版，**不是** Summary 页；
    Summary 页真正的数据源是 `ui_investigation_summary`（一棵 UI 组件树，逐步刷新，最后一条为终版）；
    Mitigation plan 页来自 `mitigation_summary_md`，而 `list_recommendations` 在这次调查里返回 0 条
    —— 所以只把 recommendations 当**退化**来源。早先按"summary_md=Summary、recommendations=
    Mitigation"接，会导致 Summary 与 Root cause 内容重复、且缓解方案永远缺失。

    `summary_markdown` 保持存在（调用方/报告仍用它），但内容变成按 Summary → Root cause →
    Mitigation plan 顺序拼好的完整文档。lang 只影响章节标题（正文一律 DevOps Agent 原文透传）。
    """
    if _DISABLED:
        return _not_onboarded(account_id)
    if not execution_id:
        return {"error": "bad_request", "message": "缺少 execution_id"}
    acct = _target_account(account_id)
    if not acct:
        return {"error": "cross_account_denied", "message": "跨账号未开启，仅支持部署账号。"}
    try:
        client, space = _client_and_space(acct)
    except (ClientError, BotoCoreError, Exception) as e:  # noqa: BLE001
        return {"error": "connect_failed", "message": f"连接 DevOps Agent 失败：{_safe_err(e)}"}
    if not client or not space:
        return _not_onboarded(acct)
    try:
        # 只拉一次全量 journal 记录，三个区段都从里面取（避免同一份数据查三遍）。
        recs = []
        try:
            recs = _list_all_records(client, space, execution_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("list_journal_records failed: %s", _safe_err(e))
        # ① Root cause 区：按**后台 Root cause 页同样的结构**组织（结构化 investigation_summary：
        #    Impact/Root causes/Key findings/Gaps，纯透传）；拿不到结构化就用它的 md 版原文。
        structured, summary_md_raw = "", ""
        try:
            structured = build_structured_report_md(recs)
        except Exception as e:  # noqa: BLE001
            logger.warning("build_structured_report_md failed: %s", _safe_err(e))
        summary_md_raw = _md_record_from_records(recs, "investigation_summary_md")
        root_cause = structured or summary_md_raw
        # 「跑完没跑完」只看**终态产物**（结构化摘要 / summary md）：ui_investigation_summary 在调查
        # 刚开始时就有一条 "Investigation starting…"，拿它判断会把在跑的调查误判成已完成。
        if not root_cause:
            return {"status": "running", "message": "调查仍在进行中（暂无摘要）。请稍后再查。"}
        # ② Summary 区：后台 Summary 页的数据源 = ui_investigation_summary 终版里的**执行摘要卡**
        #    （问题概要 / 根本原因 / 修复方案）；取不到才退化到末条 assistant 原文。
        summary = _ui_summary_from_records(recs) or \
            _read_last_assistant(client, space, execution_id) or ""
        # 尽力从 journal 记录反查本次调查的 taskId（用于拼后台深链 + 拉 recommendations）。
        task_id = ""
        try:
            for r in (recs or []):
                tid = r.get("taskId") or (r.get("task") or {}).get("taskId") if isinstance(r, dict) else ""
                if tid:
                    task_id = tid
                    break
        except Exception:  # noqa: BLE001
            task_id = ""
        # ③ Mitigation plan 区：后台 Mitigation plan 页的数据源 = mitigation_summary_md（Action/
        #    Reasoning/Execution Plan/Code Change Spec）；没有它才退化到 recommendations。
        #    后台不一定生成过 —— 失败安全地"有就取"（异常/没有 → 空串，整段不出现）。
        mitigation = _md_record_from_records(recs, "mitigation_summary_md")
        if not mitigation and task_id:
            mitigation = get_recommendations_md(task_id, acct, lang, with_header=False)
        _urls = operator_urls(space, task_id)
        sections = {"summary": summary, "root_cause": root_cause, "mitigation": mitigation}
        return {"ok": True, "status": "completed",
                "summary_markdown": build_full_report_md(sections, lang),
                "sections": sections,
                "structured": bool(structured), "has_mitigation": bool(mitigation),
                "agent_space_id": space, "task_id": task_id,
                "console_url": _urls["deep_link"], "console_home": _urls["home"]}
    except (ClientError, BotoCoreError, Exception) as e:  # noqa: BLE001
        logger.warning("devops_agent get_result failed: %s", _safe_err(e))
        return {"error": "get_failed", "message": f"拉取调查结果失败：{_safe_err(e)}"}


_TERMINAL = {"COMPLETED", "FAILED", "TIMED_OUT", "CANCELED", "SKIPPED"}


def _record_progress_line(rec: dict, locale: str = "zh") -> str | None:
    """把一条 journal record 渲染成一行人类可读的实时进度（用于流式显示到 chat）。
    返回 None 表示这条不值得展示（如纯系统记录）。
    locale: 框架标签语言（"en"/"zh"）；标签**绕过模型直接显示到右侧栏**，故必须显式切换。
    Observation/Finding 等的**正文**是 DevOps Agent 原文，保持透传、不翻译。"""
    _en = locale == "en"
    rt = rec.get("recordType", "") or ""
    content = rec.get("content")
    # content 可能是 str / dict / JSON 字符串；先解析成对象。
    obj = content
    if isinstance(content, str):
        try:
            obj = json.loads(content)
        except (ValueError, TypeError):
            obj = content
    # 噪声类型：系统/元数据/上下文窗口统计/工具原始结果——不展示（避免糊原始 JSON）。
    if rt in ("system", "metadata", "context", "checkpoint", "heartbeat", "tool_result", "utilization"):
        return None

    # 忠实透传：每类记录渲染成**独立的 markdown 块**（前后空行、标题加粗），
    # 不把多条揉成一段、不做激进截断（尽量还原 DevOps Agent timeline 的 Observation/Finding）。
    if rt == "thinking":
        body = _plain(obj if isinstance(obj, str) else (obj.get("text") if isinstance(obj, dict) else ""))
        return f"\n🤔 {_clip(body, 400)}\n" if body else None
    if rt == "tool_use":
        name = _tool_name_from(content)
        if not name:
            return None
        return f"\n🔧 Calling tool: `{name}`\n" if _en else f"\n🔧 调用工具：`{name}`\n"
    if rt == "observation":
        # {title, analysis, signals}——标题分隔符/正文是 DevOps Agent 原文，仅 "Observation" 标签已英文。
        if isinstance(obj, dict):
            title = (obj.get("title") or "").strip()
            analysis = _plain(obj.get("analysis") or "")
            if title:
                out = f"\n**🔭 Observation: {title}**\n" if _en else f"\n**🔭 Observation：{title}**\n"
                if analysis:
                    out += f"\n{_clip(analysis, 700)}\n"
                return out
        return None
    if rt == "finding":
        # {title, description, supporting_observations}
        if isinstance(obj, dict):
            title = (obj.get("title") or "").strip()
            desc = _plain(obj.get("description") or "")
            if title:
                out = f"\n**🔎 Finding: {title}**\n" if _en else f"\n**🔎 Finding：{title}**\n"
                if desc:
                    out += f"\n{_clip(desc, 900)}\n"
                return out
        return None
    if rt == "message":
        # assistant 阶段性叙述（content 是 [{text:...}] 或 {role,content}）——正文为 DevOps Agent 原文。
        msg = _assistant_text(content)
        body = _plain(msg)
        return f"\n💬 {_clip(body, 600)}\n" if body else None
    if rt == "investigation_result":
        # 最终摘要在这条；流式阶段不重复吐（完成后单独展示全文），这里只给一句提示。
        return "\n📄 Investigation summary generated.\n" if _en else "\n📄 调查摘要已生成。\n"
    if rt == "investigation_summary_md":
        return "\n📄 Generating investigation summary…\n" if _en else "\n📄 正在生成调查摘要…\n"
    return None


def _plain(s) -> str:
    if not isinstance(s, str):
        return ""
    import re as _re
    s = _re.sub(r"<[^>]+>", " ", s)
    return _re.sub(r"\s+", " ", s).strip()


def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + "…"


def _tool_name_from(content) -> str:
    try:
        d = json.loads(content) if isinstance(content, str) else content
        if isinstance(d, dict):
            return d.get("name") or d.get("toolName") or (d.get("toolUse") or {}).get("name") or ""
    except Exception:  # noqa: BLE001
        pass
    return ""


def _assistant_text(content) -> str:
    try:
        d = json.loads(content) if isinstance(content, str) else content
    except Exception:  # noqa: BLE001
        return content if isinstance(content, str) else ""
    if isinstance(d, dict) and d.get("role") == "assistant":
        c = d.get("content")
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("text"))
    if isinstance(d, str):
        return d
    return ""


def poll_investigation(execution_id: str, task_id: str, agent_space_id: str,
                       account_id: str | None = None, seen_ids: set | None = None,
                       locale: str = "zh") -> dict:
    """**轮询一次**：拉自上次以来的新 journal 记录 + 当前任务状态。供上层循环驱动"实时显示"。
    返回 {ok, status, terminal(bool), new_lines:[str], seen_ids(set)}；失败 {error,message}。
    无状态化：调用方持有 seen_ids（已展示过的 recordId），传进来做增量。
    locale: 进度行框架标签语言（"en"/"zh"），透传给 _record_progress_line。"""
    if _DISABLED:
        return _not_onboarded(account_id)
    acct = _target_account(account_id)
    if not acct:
        return {"error": "cross_account_denied", "message": "跨账号未开启，仅支持部署账号。"}
    try:
        client, space = _client_and_space(acct)
    except Exception as e:  # noqa: BLE001
        return {"error": "connect_failed", "message": f"连接 DevOps Agent 失败：{_safe_err(e)}"}
    if not client or not space:
        return _not_onboarded(acct)
    space = agent_space_id or space
    seen = set(seen_ids or set())
    new_lines: list[str] = []
    # 1) 拉全部新记录（按时间升序，老的先展示）
    try:
        records = _list_all_records(client, space, execution_id)
    except Exception as e:  # noqa: BLE001
        records = []
        logger.warning("poll_investigation list records failed: %s", _safe_err(e))
    for rec in records:
        rid = rec.get("recordId")
        if not rid or rid in seen:
            continue
        seen.add(rid)
        line = _record_progress_line(rec, locale)
        if line:
            new_lines.append(line)
    # 2) 查任务状态（判断是否终态）
    status = "IN_PROGRESS"
    try:
        t = client.get_backlog_task(agentSpaceId=space, taskId=task_id).get("task", {})
        status = t.get("status") or status
    except Exception as e:  # noqa: BLE001
        logger.warning("poll_investigation get_backlog_task failed: %s", _safe_err(e))
    return {"ok": True, "status": status, "terminal": status in _TERMINAL,
            "new_lines": new_lines, "seen_ids": seen}


def _list_all_records(client, space, execution_id) -> list:
    """拉某次执行的全部 journal 记录（升序，分页）。"""
    out, token = [], None
    while True:
        params = {"agentSpaceId": space, "executionId": execution_id, "limit": 100, "order": "ASC"}
        if token:
            params["nextToken"] = token
        resp = client.list_journal_records(**params)
        out.extend(resp.get("records", []))
        token = resp.get("nextToken")
        if not token:
            break
    return out


def _structured_summary_from_records(records: list) -> dict | None:
    """从 journal 记录里取 DevOps Agent 的**结构化调查摘要** `investigation_summary`
    （{symptoms, findings, investigation_gaps}）——这正是后台 Root cause 页的数据源。
    取最后一条（最终版）。没有则 None。"""
    latest = None
    for r in records:
        if r.get("recordType") == "investigation_summary":
            c = r.get("content")
            try:
                c = json.loads(c) if isinstance(c, str) else c
            except (ValueError, TypeError):
                continue
            if isinstance(c, dict):
                latest = c
    return latest


def build_structured_report_md(records: list) -> str:
    """把 DevOps Agent 的结构化摘要按**后台 Root cause 页同样的组织**渲染成 markdown：
    Impact（symptoms）/ Root causes（findings.type==root_cause）/ Key findings（其余 findings）/
    Investigation gaps。**纯透传**：字段全用 DevOps Agent 原文，NotiOps 不加分析/总结/改写。
    拿不到结构化摘要 → 返回空串（调用方回退到 investigation_summary_md 原文）。"""
    s = _structured_summary_from_records(records)
    if not s:
        return ""
    lines = []

    def _emit_finding(f, idx):
        lines.append(f"### {idx}. {(f.get('title') or '').strip()}")
        desc = (f.get("description") or "").strip()
        if desc:
            lines.append("")
            lines.append(desc)
        obs = f.get("observations") or []
        if obs:
            lines.append("")
            lines.append("**Supporting observations:**")
            for o in obs:
                if not isinstance(o, dict):
                    continue
                ot = (o.get("title") or "").strip()
                oa = (o.get("analysis") or "").strip()
                if ot:
                    lines.append(f"- **{ot}**" + (f" — {oa}" if oa else ""))
                elif oa:
                    lines.append(f"- {oa}")
        lines.append("")

    symptoms = s.get("symptoms") or []
    if symptoms:
        lines.append("## Impact")
        lines.append("")
        for i, sy in enumerate(symptoms, 1):
            if not isinstance(sy, dict):
                continue
            lines.append(f"### {i}. {(sy.get('title') or '').strip()}")
            d = (sy.get("description") or "").strip()
            if d:
                lines.append("")
                lines.append(d)
            lines.append("")

    findings = [f for f in (s.get("findings") or []) if isinstance(f, dict)]
    root_causes = [f for f in findings if f.get("type") == "root_cause"]
    key_findings = [f for f in findings if f.get("type") != "root_cause"]
    if root_causes:
        lines.append("## Root causes")
        lines.append("")
        for i, f in enumerate(root_causes, 1):
            _emit_finding(f, i)
    if key_findings:
        lines.append("## Key findings")
        lines.append("")
        for i, f in enumerate(key_findings, 1):
            _emit_finding(f, i)

    gaps = s.get("investigation_gaps") or []
    if gaps:
        lines.append("## Investigation gaps")
        lines.append("")
        for g in gaps:
            if isinstance(g, dict):
                gt = (g.get("title") or "").strip()
                gd = (g.get("description") or "").strip()
                lines.append(f"- **{gt}**" + (f" — {gd}" if gd else "") if gt else f"- {gd}")
            elif isinstance(g, str):
                lines.append(f"- {g}")
        lines.append("")

    return "\n".join(lines).strip()


def _md_record_from_records(records: list, record_type: str) -> str:
    """取某类**markdown 型** journal 记录的终版原文（如 investigation_summary_md /
    mitigation_summary_md），并去掉它自带的 H1 标题行（`# Investigation Summary` /
    `# Mitigation Summary`）—— 我们会在外面套统一的章节标题（后台 tab 名），留着就是重复标题。
    没有 → 空串。"""
    latest = ""
    for r in records or []:
        if not isinstance(r, dict) or r.get("recordType") != record_type:
            continue
        c = r.get("content")
        if isinstance(c, dict):
            c = c.get("text") or ""
        if isinstance(c, str) and c.strip():
            latest = c  # 记录已按 ASC 排序，最后一条即终版
    if not latest:
        return ""
    lines = latest.split("\n")
    # 去掉开头的 H1（可能前面有空行）
    for i, ln in enumerate(lines[:5]):
        if ln.lstrip().startswith("# ") :
            lines = lines[i + 1:]
            break
        if ln.strip():
            break
    return "\n".join(lines).strip()


# ── ui_investigation_summary：后台 Summary 页的数据源（一棵 UI 组件树，不是 markdown） ──────
# 🔴 摊平逻辑**已经搬到 `core/da_ui_tree.py`**（2026-09-05），这里只留一个薄委托。
#    搬的理由：同一棵树 IM 侧的 report-handler Lambda 也要读（报告页取「概要 /
#    核心建议」、Trace 页取「调查过程时间线」），而在此之前逻辑只有 web 这一份，
#    于是同一次调查在 web 上有结构、在 IM 的报告 HTML 里只剩一段对话式正文。
#    两棵 core/ 树的 `da_ui_tree.py` 由 tests/test_core_tree_parity.py 锁成逐字节一致。
#
# ⚠️ 别在这里再写一份 —— 那正是被这次改动消掉的那种漂移。import 在文件顶部。


def _demote_md(md: str, times: int = 1) -> str:
    """把一段 markdown 里的 ATX 标题整体降 `times` 级（`## X` → `### X`），用于把**自带标题层级的
    区块**（如 build_structured_report_md 产出的 `## Impact` / `### 1. …`）嵌到更高一级的章节
    标题（`## Root cause`）之下，避免出现"子区块标题与父章节同级"的错乱目录。
    跳过 ``` 围栏代码块内的行（shell 注释里的 `#` 不是标题）；已到 h6 不再降。"""
    if times <= 0:
        return md or ""
    out, fenced = [], False
    for ln in (md or "").split("\n"):
        s = ln.lstrip()
        if s.startswith("```") or s.startswith("~~~"):
            fenced = not fenced
            out.append(ln)
            continue
        if not fenced and s.startswith("#"):
            lvl = len(s) - len(s.lstrip("#"))
            out.append("#" * min(6 - lvl, times) + ln)
        else:
            out.append(ln)
    return "\n".join(out)


def _min_heading_level(md: str) -> int:
    """一段 markdown 里最浅的 ATX 标题层级（围栏代码块内的 `#` 不算）；没有标题 → 0。"""
    lo, fenced = 0, False
    for ln in (md or "").split("\n"):
        s = ln.lstrip()
        if s.startswith("```") or s.startswith("~~~"):
            fenced = not fenced
            continue
        if fenced or not s.startswith("#"):
            continue
        n = len(s) - len(s.lstrip("#"))
        rest = s[n:]
        if n > 6 or (rest and not rest.startswith(" ")):
            continue  # 不是合法 ATX 标题（如 `#tag`）
        lo = n if lo == 0 else min(lo, n)
    return lo


def _fit_under_section(md: str, target: int = 3) -> str:
    """把一段区块的标题层级整体压到 `target` 及更深，让它能干净地嵌在 `##` 章节标题之下。
    各区来源的原始层级不一样（结构化根因是 `##` 起、mitigation_summary_md 是 `##` 起、
    recommendations 是 `###` 起、UI 摘要是 `###` 起），统一在这里按**实测最浅层级**归一，
    不再靠"哪个区要降级"的硬编码（那正是之前 mitigation 多降一级的来源）。"""
    lo = _min_heading_level(md)
    return _demote_md(md, target - lo) if 0 < lo < target else (md or "")


# 章节标题：**照抄 DevOps Agent 后台的 tab 名**（Summary / Root cause / Mitigation plan），
# 让"前端正文"与客户在后台看到的一致。Investigation timeline 不在这里 —— 它走右侧栏。
_SECTION_TITLES = {
    "summary":    ("## Summary", "## 调查摘要（Summary）"),
    "root_cause": ("## Root cause", "## 根因分析（Root cause）"),
    "mitigation": ("## Mitigation plan", "## 缓解方案（Mitigation plan）"),
}


def build_full_report_md(sections: dict, lang: str = "en", clip: dict | None = None) -> str:
    """把分区内容按 **Summary → Root cause → Mitigation plan** 顺序拼成一篇 markdown。
    空区段直接跳过（mitigation 常常没有）。正文一律 DevOps Agent 原文透传，我们只加章节标题
    （标题即后台 tab 名）。clip：可选的**逐区**字符上限 {section: n} —— 用于聊天气泡这类需要
    控长的场合；按区截断而不是整篇截断，否则后面的 Root cause / Mitigation plan 会被整段吃掉。"""
    en = str(lang).lower() != "zh"
    parts = []
    for key in ("summary", "root_cause", "mitigation"):
        body = (sections or {}).get(key) or ""
        body = body.strip()
        if not body:
            continue
        # 层级归一（**先归一再截断**：截断可能切断 ``` 围栏，之后再判标题会把代码注释当标题）：
        # 各区来源的最浅标题层级不同（`##` / `###`），统一压到 `###` 及更深，保证都能干净嵌在
        # `## <tab 名>` 之下（详见 _fit_under_section）。
        body = _fit_under_section(body, 3)
        limit = (clip or {}).get(key)
        if limit and len(body) > limit:
            body = body[:limit]
            # 截断点可能落在 ``` 围栏里 —— 不补一个收尾围栏，后面所有内容都会被渲染成代码块。
            if body.count("```") % 2:
                body += "\n```"
            body += ("\n\n… (truncated; see the full report below)" if en
                     else "\n\n…（此处截断，完整内容见下方在线报告）")
        title = _SECTION_TITLES[key][0 if en else 1]
        parts.append(f"{title}\n\n{body}")
    return "\n\n".join(parts).strip()


def generate_mitigation(root_cause_summary: str, account_id: str | None = None,
                        timeout_s: int = 90) -> str:
    """复刻 Operator App "Generate mitigation plan" 按钮：让 **DevOps Agent 自己**基于本次调查
    根因产出缓解方案（investigate 阶段不自动产生，需发起后续请求）。方案完全来自 DevOps Agent，
    NotiOps 不做任何加工/总结/LLM——这里只是把"生成缓解方案"这个用户意图透传给它。

    机制（实测打通）：CreateChat → 可对话 executionId → SendMessage → 返回 **EventStream**，
    原样聚合其文本增量即为 DevOps Agent 生成的缓解方案。失败安全：异常/超时 → 空串。"""
    if _DISABLED or not root_cause_summary:
        return ""
    acct = _target_account(account_id)
    if not acct:
        return ""
    try:
        client, space = _client_and_space(acct)
        if not client or not space:
            return ""
        chat = client.create_chat(agentSpaceId=space, userId="notiops-web")
        exid = chat.get("executionId")
        if not exid:
            return ""
        # 中性触发：只传达"生成缓解方案"这个意图（等价于点后台 Generate mitigation plan），
        # 不加 NotiOps 自己的格式/引导要求。因是新 chat execution（无调查上下文），把 DevOps Agent
        # **自己产出的根因原文**回传作为背景（这仍是它自己的内容，非 NotiOps 加工）；结构由它自定。
        prompt = ("Generate a mitigation plan for the following root cause "
                  "(from the completed investigation):\n\n" + root_cause_summary[:6000])
        resp = client.send_message(agentSpaceId=space, executionId=exid, content=prompt)
        events = resp.get("events")
        if events is None:
            return ""
        parts = []
        import time as _t
        _start = _t.time()
        for ev in events:
            if _t.time() - _start > timeout_s:
                break
            if not isinstance(ev, dict):
                continue
            # 实测事件路径：contentBlockDelta.delta.textDelta.text（Operator EventStream）。
            cbd = ev.get("contentBlockDelta")
            if isinstance(cbd, dict):
                delta = cbd.get("delta") or {}
                td = delta.get("textDelta") if isinstance(delta, dict) else None
                t = td.get("text") if isinstance(td, dict) else (delta.get("text") if isinstance(delta, dict) else None)
                if isinstance(t, str):
                    parts.append(t)
            # responseCompleted 事件表示流结束。
            if "responseCompleted" in ev or "responseFailed" in ev:
                break
        return "".join(parts).strip()
    except Exception as e:  # noqa: BLE001
        logger.warning("generate_mitigation failed: %s", _safe_err(e))
        return ""


def get_recommendations_md(task_id: str, account_id: str | None = None, lang: str = "en",
                           with_header: bool = True) -> str:
    """拉某次调查(task_id)的**缓解建议/推荐**（DevOps Agent 的 mitigation plan，若有），
    渲染成一段 markdown 追加到报告。没有则返回空串。失败安全（异常→空串）。
    注意：recommendations 非每次调查都自动生成；这里是"有就加"。

    lang：报告正文语言（"en"/"zh"）。这段 markdown 会拼进**客户逐字下载/查看的报告**，不经模型翻译，
    框架标签必须按提问语言切换——英文客户看到中文标签就是 bug。调用方应传入 _ui_locale。"""
    if _DISABLED or not task_id:
        return ""
    acct = _target_account(account_id)
    if not acct:
        return ""
    try:
        client, space = _client_and_space(acct)
        if not client or not space:
            return ""
        recs = client.list_recommendations(agentSpaceId=space, taskId=task_id).get("recommendations", [])
    except Exception as e:  # noqa: BLE001
        logger.warning("get_recommendations failed: %s", _safe_err(e))
        return ""
    if not recs:
        return ""
    en = (str(lang).lower() == "en")
    recs = sorted(recs, key=lambda r: r.get("rankPosition", 999))
    # with_header=False：调用方自己出「## Mitigation plan」章节标题（见 build_full_report_md），
    # 这里只出条目，避免一篇报告里出现两个同义标题。
    lines = ["", ("## Mitigation Plan" if en else "## 缓解建议（Mitigation Plan）"), ""] if with_header else [""]
    for i, r in enumerate(recs, 1):
        title = r.get("title", "") or (f"Recommendation {i}" if en else f"建议 {i}")
        pri = r.get("priority", "")
        c = r.get("content")
        body = c if isinstance(c, str) else (c.get("text") if isinstance(c, dict) else "")
        _pri_sfx = ((f" (priority: {pri})" if en else f"（优先级：{pri}）") if pri else "")
        lines.append(f"### {i}. {title}" + _pri_sfx)
        if body:
            lines.append(str(body))
        lines.append("")
    return "\n".join(lines)


# （原 _read_summary_md 已由 _md_record_from_records(recs, "investigation_summary_md") 取代：
#   那条记录是后台 Root cause 页的 md 版、且要剥掉自带 H1；同时全量记录只拉一次即可复用。）


def _read_last_assistant(client, space, execution_id) -> str | None:
    try:
        resp = client.list_journal_records(
            agentSpaceId=space, executionId=execution_id,
            recordType="message", order="DESC")
        for rec in resp.get("records", []):
            raw = rec.get("content")
            try:
                msg = json.loads(raw) if isinstance(raw, str) else raw
            except Exception:  # noqa: BLE001
                continue
            if not isinstance(msg, dict) or msg.get("role") != "assistant":
                continue
            content = msg.get("content")
            if isinstance(content, str) and content.strip():
                return content
            if isinstance(content, list):
                texts = [b.get("text") for b in content if isinstance(b, dict) and b.get("text")]
                if texts:
                    return "\n".join(texts)
    except Exception:  # noqa: BLE001
        pass
    return None
