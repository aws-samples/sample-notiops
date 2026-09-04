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
    **无需 config 表、无需跨账号 AssumeRole**。Agent Space 通过 ListAgentSpaces **自动发现**
    （优先名为 `notiops-devops-<account>` 的；可用 env DEVOPS_AGENT_SPACE_ID 覆盖）。
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

logger = logging.getLogger(__name__)


def _safe_err(e: Exception) -> str:
    """Sensitive-data handling: return the exception *type* (plus the AWS
    error code for botocore ClientError), never the raw message / response body
    which can embed request payloads or user data. See docs/LOGGING_STANDARD.md."""
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__


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

    `account_id` 传空 = 部署账号（与 `platforms/common/im_types.py::ImMessage.account_id`
    同一个契约）。这一步**必须在这里补**，不能指望每个调用方先过 `_target_account()`：
    空串跟部署账号号永远不相等 → 一路走到跨账号分支 → 找不到 `da#` 配置行 →
    (None, None) → 客户看到「无法定位该账号的 Agent Space」。2026-09-02 现网实测：
    飞书「DevOps 对话」100% 命中（core/devops_chat.py 传的就是 `account_id or ""`）。
    顺带修掉同源的第二处静默错：空账号会让 `_discover_space` 去找名叫
    `notiops-devops-`（后缀空）的 space，找不到就取列表第一个 —— 账号里有多个
    Agent Space 时会安静地连错一个。"""
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
    `notiops-devops-<account>` 匹配。结果缓存。

    ⚠️ **不再兜底取 `spaces[0]`。** 本账号现在有两个 agent space
    （`notiops-devops-<account>` 排障 · `notiops-inspection-<account>` 巡检，
    见 spec R12.5c），而 `ListAgentSpaces` 的返回顺序没有任何保证：

    ```
    原实现  chosen = next(名字匹配) or spaces[0]
            名字匹配不中时取第一个 —— 只有一个 space 时它恒等于那个正确的
            有两个之后，spaces[0] 可能是巡检 space
            → 客户的深度调查跑在巡检 space 里
            → 报告照样出，只是并发算在巡检头上、且加载到巡检的判读 skill
            → **没有任何错误信号**
    ```

    所以匹配不中时**返回 None**（调用方走 `_not_onboarded`，客户会看到一条明确提示），
    而不是猜一个。猜错的代价远大于报错。
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
        preferred = f"notiops-devops-{account_id}"
        chosen = next((s for s in spaces if s.get("name") == preferred), None)
        if chosen is None:
            # ⚠️ 只有一个 space 且名字不匹配时（如客户手工建的、或早期版本命名不同），
            # 沿用它 —— 否则会把本来能用的环境判成未上车。两个及以上就必须明确，
            # 因为那时「取第一个」是在两个语义完全不同的 space 之间瞎猜。
            if len(spaces) == 1:
                chosen = spaces[0]
                logger.info(
                    "devops_agent: 唯一的 agent space 名字不是 %s，沿用它: name=%s",
                    preferred, chosen.get("name"),
                )
            else:
                logger.error(
                    "devops_agent: 账号 %s 有 %d 个 agent space 但没有名为 %s 的，"
                    "拒绝猜测（猜错会把调查跑到巡检 space 且无任何信号）。"
                    "请设置 DEVOPS_AGENT_SPACE_ID。现有: %s",
                    account_id, len(spaces), preferred,
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
                        priority: str = "MEDIUM", source: str = "notiops-web-chat") -> dict:
    """发起一次 DevOps Agent 深度调查（异步，立即返回 task/execution id）。
    成功：{ok, task_id, execution_id, agent_space_id, account_id, console_url, console_home, note}；
    未上车/失败：{error, message}。console_url = 本次调查的后台进度深链（客户可点开看进度）。

    `source` 会作为 `[<source>]` 前缀写进 description —— 客户在 Operator App 的 backlog 里
    要能一眼看出这条调查是从哪儿发起的（web / 飞书 / Slack / 钉钉）。默认值保持
    "notiops-web-chat" 以兼容既有调用方。"""
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
            description=f"[{source}] {description}")
        task = resp["task"]
        _urls = operator_urls(space, task["taskId"])
        return {"ok": True, "task_id": task["taskId"], "execution_id": task["executionId"],
                "agent_space_id": space, "account_id": acct,
                "console_url": _urls["deep_link"], "console_home": _urls["home"],
                "note": "调查已发起，通常需几分钟。稍后用 get_investigation_result 凭 execution_id 查结果。"}
    except (ClientError, BotoCoreError, Exception) as e:  # noqa: BLE001
        logger.warning("devops_agent start failed: %s", _safe_err(e))
        return {"error": "start_failed", "message": f"发起调查失败：{_safe_err(e)}"}


def get_investigation_result(execution_id: str, account_id: str | None = None) -> dict:
    """凭 execution_id 拉回调查摘要 Markdown。还没跑完 → {status:'running'}。"""
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
        # 优先按**后台 Root cause 页同样的结构**组织（用 investigation_summary 结构化记录：
        # Impact/Root causes/Key findings/Gaps，纯透传）；拿不到再回退 investigation_summary_md 原文。
        structured = ""
        try:
            recs = _list_all_records(client, space, execution_id)
            structured = build_structured_report_md(recs)
        except Exception as e:  # noqa: BLE001
            logger.warning("build_structured_report_md failed: %s", _safe_err(e))
        md = structured or _read_summary_md(client, space, execution_id) or \
            _read_last_assistant(client, space, execution_id)
        if not md:
            return {"status": "running", "message": "调查仍在进行中（暂无摘要）。请稍后再查。"}
        return {"ok": True, "status": "completed", "summary_markdown": md,
                "structured": bool(structured)}
    except (ClientError, BotoCoreError, Exception) as e:  # noqa: BLE001
        logger.warning("devops_agent get_result failed: %s", _safe_err(e))
        return {"error": "get_failed", "message": f"拉取调查结果失败：{_safe_err(e)}"}


_TERMINAL = {"COMPLETED", "FAILED", "TIMED_OUT", "CANCELED", "SKIPPED"}


def _record_progress_line(rec: dict, locale: str = "zh") -> str | None:
    """把一条 journal record 渲染成一行人类可读的实时进度（用于流式显示到 chat）。
    返回 None 表示这条不值得展示（如纯系统记录）。

    `locale`（"zh" / "en"）只影响这几个固定前缀（"调用工具" / "Observation" …）；
    正文一律**原样透传** agent 的输出，不翻译（翻译要过模型 = 烧 token，而这条路径
    的全部意义就是 0 token）。
    默认 zh 是为了兼容既有调用方（Fargate progress_poller）。"""
    en = locale == "en"
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
        label = "Tool call" if en else "调用工具"
        return f"\n🔧 {label}：`{name}`\n" if name else None
    if rt == "observation":
        # {title, analysis, signals}
        if isinstance(obj, dict):
            title = (obj.get("title") or "").strip()
            analysis = _plain(obj.get("analysis") or "")
            if title:
                out = f"\n**🔭 Observation{'' if en else '：'}{': ' + title if en else title}**\n"
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
                out = f"\n**🔎 Finding{'' if en else '：'}{': ' + title if en else title}**\n"
                if desc:
                    out += f"\n{_clip(desc, 900)}\n"
                return out
        return None
    if rt == "message":
        # assistant 阶段性叙述（content 是 [{text:...}] 或 {role,content}）
        msg = _assistant_text(content)
        body = _plain(msg)
        return f"\n💬 {_clip(body, 600)}\n" if body else None
    if rt == "investigation_result":
        # 最终摘要在这条；流式阶段不重复吐（完成后单独展示全文），这里只给一句提示。
        return "\n📄 Investigation summary generated.\n" if en else "\n📄 调查摘要已生成。\n"
    if rt == "investigation_summary_md":
        return "\n📄 Generating the investigation summary…\n" if en else "\n📄 正在生成调查摘要…\n"
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

    `locale`（"zh" / "en"）只影响进度行的固定前缀；agent 正文一律原样透传、不翻译
    （翻译=过模型=烧 token，与本路径 0 token 的口径冲突）。默认 zh 兼容既有调用方。"""
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


def describe_investigation(ref_id: str, account_id: str | None = None,
                           locale: str = "zh", max_lines: int = 8) -> dict:
    """凭**用户给的一个引用**（task_id 或 execution_id）回读一条已有调查的状态。

    这是 IM 侧「[[investigation:…]] 现在是什么状态 / 帮我监控它的实时进展」那条路径的
    数据源 —— **0 token**（不过模型，全是 DevOps Agent 的只读 API）。

    为什么要"两种 id 都收"：卡片正文里我们贴给用户的是 **task_id**（Operator App 深链
    的 key），而 journal 记录只能按 **executionId** 读。用户复制哪个都得认，所以：

      · `exe-…` 开头 → 直接当 executionId 用（`GetBacklogTask` 不认它，别去问）；
      · 其余 → 当 taskId，先 `GetBacklogTask` 换出 executionId + status + title。

    口径与 web 端 `devops_investigate.mjs::resolveInvestigationRef` 一致。

    返回：
      · 成功 ``{ok, task_id, execution_id, status, terminal, title, lines[],
        rendered, seen_ids[], console_url, console_home, agent_space_id,
        account_id}`` —— ``rendered`` / ``seen_ids`` 是给"把这张状态卡接到每分钟的
        进度 Lambda 上继续刷"用的（`imtask#` 行的两个游标字段，口径与
        `platforms/common/lambda_progress.py` 完全一致：行自带换行，用 `"".join`
        拼；`seen_ids` 是**全部**已渲染过的 recordId，接上之后不会重复贴旧进度）。
      · 解析不出来 ``{error: "not_found", message}`` —— 调用方应当**照实说**，
        绝不能退化成"那就再开一条调查"（那是这次要修的 bug 本身）。
      · 其余失败沿用本模块统一的 ``{error, message}`` 形状。

    ``max_lines`` 只截**最近**几行进度（卡片装不下全量 journal；<=0 = 不截）。
    """
    if _DISABLED:
        return _not_onboarded(account_id)
    ref = (ref_id or "").strip().strip("`")
    if not ref:
        return {"error": "bad_request", "message": "缺少调查引用（task_id / execution_id）"}
    acct = _target_account(account_id)
    if not acct:
        return {"error": "cross_account_denied", "message": "跨账号未开启，仅支持部署账号。"}
    try:
        client, space = _client_and_space(acct)
    except Exception as e:  # noqa: BLE001
        return {"error": "connect_failed", "message": f"连接 DevOps Agent 失败：{_safe_err(e)}"}
    if not client or not space:
        return _not_onboarded(acct)

    task_id, execution_id, status, title = "", "", "", ""
    if ref.lower().startswith("exe-"):
        execution_id = ref
    else:
        task_id = ref
        try:
            t = client.get_backlog_task(agentSpaceId=space, taskId=ref).get("task", {})
        except Exception as e:  # noqa: BLE001
            # 引用查不到是**正常**的用户输入错误（打错一位、引用了别的账号的调查），
            # 不是系统故障 —— 所以只留错误类型，不刷 exception 栈。
            logger.info("describe_investigation get_backlog_task miss: %s", _safe_err(e))
            return {"error": "not_found",
                    "message": f"没有找到调查 {ref}（可能 id 有误，或它属于另一个账号）。"}
        execution_id = t.get("executionId") or ""
        status = t.get("status") or ""
        title = t.get("title") or ""
        if not execution_id:
            return {"error": "not_found",
                    "message": f"调查 {ref} 还没有执行记录，请稍后再看。"}

    lines: list[str] = []
    seen_ids: list[str] = []
    try:
        records = _list_all_records(client, space, execution_id)
    except Exception as e:  # noqa: BLE001
        records = []
        logger.warning("describe_investigation list records failed: %s", _safe_err(e))
    for rec in records:
        line = _record_progress_line(rec, locale)
        if not line:
            continue
        lines.append(line)
        rid = rec.get("recordId")
        if rid:
            seen_ids.append(str(rid))
    rendered = "".join(lines)
    if max_lines > 0 and len(lines) > max_lines:
        lines = lines[-max_lines:]

    if not status:
        # 只给了 execution_id 时拿不到 backlog task —— 用 journal 是否收敛做兜底判断。
        status = "COMPLETED" if _structured_summary_from_records(records) else "IN_PROGRESS"
    urls = operator_urls(space, task_id)
    return {"ok": True, "task_id": task_id, "execution_id": execution_id,
            "status": status, "terminal": status in _TERMINAL, "title": title,
            "lines": lines, "rendered": rendered, "seen_ids": seen_ids,
            "console_url": urls["deep_link"],
            "console_home": urls["home"], "agent_space_id": space,
            "account_id": acct}


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


def get_recommendations_md(task_id: str, account_id: str | None = None) -> str:
    """拉某次调查(task_id)的**缓解建议/推荐**（DevOps Agent 的 mitigation plan，若有），
    渲染成一段 markdown 追加到报告。没有则返回空串。失败安全（异常→空串）。
    注意：recommendations 非每次调查都自动生成；这里是"有就加"。"""
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
    recs = sorted(recs, key=lambda r: r.get("rankPosition", 999))
    lines = ["", "## 缓解建议（Mitigation Plan）", ""]
    for i, r in enumerate(recs, 1):
        title = r.get("title", "") or f"建议 {i}"
        pri = r.get("priority", "")
        c = r.get("content")
        body = c if isinstance(c, str) else (c.get("text") if isinstance(c, dict) else "")
        lines.append(f"### {i}. {title}" + (f"（优先级：{pri}）" if pri else ""))
        if body:
            lines.append(str(body))
        lines.append("")
    return "\n".join(lines)


def _read_summary_md(client, space, execution_id) -> str | None:
    try:
        resp = client.list_journal_records(
            agentSpaceId=space, executionId=execution_id,
            recordType="investigation_summary_md", order="DESC")
        for rec in resp.get("records", []):
            c = rec.get("content")
            if isinstance(c, str) and c.strip():
                return c
            if isinstance(c, dict) and c.get("text"):
                return c["text"]
    except Exception:  # noqa: BLE001
        pass
    return None


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
