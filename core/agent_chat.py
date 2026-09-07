"""IM 侧 NotiOps Agent 直连（走模型）—— `core.devops_chat` 的姊妹模块。

`core.devops_chat` 把 IM 的问答接到**客户自己的** DevOps Agent（NotiOps 侧 0 token）。
本模块接的是另一条：**NotiOps 自己的 AgentCore runtime**，也就是 Web 端默认那个 agent。
两者在 IM 里并存，由 `/agent notiops|devops` 选（默认 devops —— 为什么默认挑省钱那一侧，
见 `core/im_prefs.py` 头部）。

⚠️ **这条路径会烧 NotiOps 侧的 token** —— 它就是一次真正的模型调用。所以：
  · 主题固定 `im-chat`，工具集是窄集（5 个，实测每轮 2,055 token —— web 端那 42 个工具是
    24,320，差 91.5%）；
  · 联网默认 **关**（`/web on` 开）；
  · 卡片页脚换成「Agent: NotiOps | Model: <实际生效的模型 id>」，不能再写「0 token」
    （用量 2026-09-06 起**只统计不显示**，但 `usage` 里照样是实测值 —— 见
    `_resolve_model_id` 与 `core/i18n.py::router.agent_model`）。

── 为什么是逐语义端口而不是复用 bff ────────────────────────────────────────────
调用契约（payload 形状、SSE 解析、`runtimeSessionId` 规整、`extract()` 的每一处防御、
错误帧后置处理）权威实现在 `bff/web-chat/agentcore.mjs`。那份 JS 跑在 Node BFF 里，
IM 是 Python Lambda，没法共享代码 —— 只能**逐条对照移植**，并在每处防御上留下"它为什么
存在"的注释，否则下一个人会把它当冗余删掉（`core/devops_chat.py` 文件头同理）。

改本文件前请先读 `bff/web-chat/agentcore.mjs`：两边任何一处不一致都会表现成"web 好的
问题 IM 答错"，而且是静默的。

本模块**不在** `scripts/lint_i18n.py` 的 `CJK_ALLOWLIST` 里，也不该进去：这里的每一句
用户可见文案（六条失败/超时话术）都走 `i18n.t("agent.chat.*", locale)`。这一点与
`core/devops_chat.py` 不同 —— 那个模块被豁免是因为它的 CJK 与事件流处理逐行耦合、要能和
`bff/web-chat/devops_chat.mjs` 对照；本模块的 CJK 只是**终态话术**，没有那种耦合。
"""
from __future__ import annotations

import json
import logging
import os
import re
import time

from core import i18n

logger = logging.getLogger(__name__)

#: 步骤行最多留几条（卡片折叠区本来也只显示 8 条，见 platforms/common/live_card.py）。
_MAX_STEPS = 24

#: IM 专用主题 —— agent 侧据此挂窄工具集（`main.py::_tools_for_topic`）。
#: ⚠️ 字符串两边硬耦合：改这里必须同时改 agent 里的 `_IM_CHAT_TOPIC`，
#: 否则 IM 会静默拿到 general 的 42 个工具（+22K token/轮，没有任何报错）。
TOPIC = "im-chat"


def _safe_err(e: Exception) -> str:
    """只回异常**类型**（botocore 再带上 AWS 错误码），绝不回原始 message。

    原始 message 里可能嵌着请求体（也就是用户问题原文）。见 docs/LOGGING_STANDARD.md。
    """
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__


def _resolve_model_id(alias: str) -> str:
    """alias（`/model` 那条命令的产物，空 = 走默认）→ **实际生效**的模型 id。

    与 agent 侧 `model/load.py::resolve_model_id()` 是同一个函数体（都只是
    `llm_config.resolve(alias).model_id`）—— 同一个模块、同一行 DDB 配置，所以这里
    算出来的就是 runtime 真的加载的那个，含「点的模型被 Admin 停用 → 回落默认」。

    **永不抛**：拿不到就回空串，落款退成只报 agent 名（`router.agent_model_unknown`）。
    局部 import 是刻意的 —— `core.llm_config` 顶层 `import boto3` 并在首次读配置时
    建 DDB 资源；不该为了一行落款把它拖进每个 import `core.agent_chat` 的进程。
    """
    try:
        from core import llm_config
        return str(llm_config.resolve(alias or "").model_id or "")
    except Exception as e:                            # noqa: BLE001
        logger.warning("agent_chat: model id resolve failed: %s", _safe_err(e))
        return ""


# ---------------------------------------------------------------------------
# 部署接线
# ---------------------------------------------------------------------------
_REGION = (os.environ.get("AWS_REGION")
           or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1")


def runtime_arn() -> str:
    """本部署的 AgentCore runtime ARN（没接就是空串）。

    ⚠️ 每次读环境变量、不做模块级缓存：单测要能 monkeypatch，且 Lambda 冷启动时
    这个值必然已经在环境里（CDK 注入），没有性能理由缓存。
    未替换的部署占位符（`__AGENT_RUNTIME_ARN__` 这种）一律当"没接"—— 否则会拿字面
    占位符去调 API，报出来的是一个看不懂的 ValidationException。
    """
    arn = os.environ.get("AGENT_RUNTIME_ARN", "").strip()
    if arn.startswith("__") and arn.endswith("__"):
        return ""
    return arn


def configured() -> bool:
    """这个部署有没有接 NotiOps agent。False 时**必须明确拒绝**，不许静默回落到
    devops 直连 —— 用户明确点了 `/agent notiops`，静默换一个 agent 答是欺骗。"""
    return bool(runtime_arn())


_client_cache = None


def _client():
    """缓存的 `bedrock-agentcore` client。

    · `read_timeout` 给足：这是**流式**调用，一个复杂问题现网实测能跑到 5 分钟以上，
      botocore 默认 60s 会在流中间把连接掐断（用户侧表现为答案被截一半）。
    · `retries.max_attempts = 1`（= 不重试）：重试一次 `InvokeAgentRuntime` 就是**再
      烧一遍 token**，而且用户会看到重复正文。宁可失败一次让用户重问。
    """
    global _client_cache
    if _client_cache is not None:
        return _client_cache
    import boto3
    from botocore.config import Config
    _client_cache = boto3.client(
        "bedrock-agentcore", region_name=_REGION,
        config=Config(read_timeout=900, connect_timeout=15,
                      retries={"max_attempts": 1, "mode": "standard"}),
    )
    return _client_cache


def _max_wait_sec() -> int:
    raw = os.environ.get("NOTIOPS_IM_AGENT_MAX_WAIT_SEC", "")
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 840


# ---------------------------------------------------------------------------
# runtimeSessionId —— 端口自 agentcore.mjs::toSessionId
# ---------------------------------------------------------------------------
_SID_ILLEGAL_RE = re.compile(r"[^A-Za-z0-9_-]")


def to_session_id(conversation_id: str) -> str:
    """会话 id → 合法 `runtimeSessionId`。

    AgentCore 的约束：只允许 `[A-Za-z0-9_-]`，**至少 33 字符**，最多 256。短了右侧补零
    （与 `bff/web-chat/agentcore.mjs::toSessionId` 逐字对齐 —— 两边补法不同会让同一个
    会话在 web 和 IM 落到不同 microVM，上下文对不上）。
    """
    s = _SID_ILLEGAL_RE.sub("", str(conversation_id or ""))
    if len(s) < 33:
        s = (s + "-0000000000000000000000000000000000")[:36]
    return s[:256]


# ---------------------------------------------------------------------------
# payload —— 端口自 agentcore.mjs::buildRuntimePayload
# ---------------------------------------------------------------------------
def build_payload(*, prompt: str, model: str = "", locale: str = "en",
                  web_search: bool = False, now: str = "",
                  account_id: str = "", allowed_accounts: str = "*",
                  warmup: bool = False) -> dict:
    """runtime 入参。**键名一个字都不能错** —— agent 侧用 `payload.get(...)` 取，
    拼错不会报错，只会静默拿到默认值（`web_search` 拼错 = 联网永远关）。

    IM 侧刻意**不传**的几个键（agent 侧默认即我们要的值）：
      · `generation` —— 重新生成是 web 的功能，IM 没有那个按钮；
      · `finops_agent` / `devops_agent` —— IM 的 NotiOps 对话不挂这两个子 agent
        （挂上就是 +9K/+8.5K token 的工具 schema，与"窄集"这条决策直接冲突）；
      · `skill_id` / `skill_version` —— skill 能力 2026-09-06 从 IM 侧整体退役，
        只在 web 端管（见 `core/nl_router.py` 文件末尾那段）。
    """
    return {
        "prompt": prompt,
        "model": model or "",
        "locale": locale or "en",
        "web_search": bool(web_search),
        "finops_agent": False,
        "devops_agent": False,
        "now": now or time.strftime("%Y-%m-%d"),
        "topic": TOPIC,
        "account_id": account_id or "",
        "allowed_accounts": allowed_accounts or "*",
        "skill_id": "",
        "skill_version": "",
        **({"warmup": True} if warmup else {}),
    }


# ---------------------------------------------------------------------------
# 事件解析 —— 端口自 agentcore.mjs::extract
# ---------------------------------------------------------------------------
#: 一个 SSE 帧看起来像"被序列化过的对象"的特征。
#: 为什么需要它：Grok 的 `reasoningContent.redactedContent` 是 bytes，AgentCore 的
#: `_safe_serialize_to_json_string` 遇到不可 JSON 化的对象会**降级成
#: `json.dumps(str(obj))`** —— 于是整个事件字典变成一个字符串帧。现网真实事故：用户
#: 在回答里看到 `{'event': {'contentBlockDelta': … b'rsn_…'}}`。所以字符串帧**只有
#: 不像序列化产物时**才当正文用。
_LOOKS_SERIALISED_RE = re.compile(r"^[{\[]|^b['\"]")


def extract(evt) -> dict:
    """一个 SSE 帧 → `{"text","sources","actions","followups","investigation_step",
    "thinking_step","progress","reasoning","usage","via","ready","error"}`。

    每一条判断都在 `agentcore.mjs::extract` 里有对应行，改动必须两边一起改。
    """
    empty = {"text": "", "sources": [], "actions": [], "followups": [],
             "investigation_step": None, "thinking_step": None,
             "progress": None, "reasoning": None, "usage": None,
             "via": "", "ready": False, "error": None}
    if isinstance(evt, str):
        s = evt.lstrip()
        return {**empty,
                "text": "" if _LOOKS_SERIALISED_RE.search(s) else evt}
    if not isinstance(evt, dict):
        return empty

    # 外层可能包一层 `event`（Bedrock converse-stream 的形状），也可能不包
    # （agent 自己 yield 的事件）。两种都要认。
    inner = evt.get("event")
    e = inner if isinstance(inner, dict) else evt

    text = ""
    delta = (e.get("contentBlockDelta") or {}).get("delta")
    if not isinstance(delta, dict):
        delta = e.get("delta") if isinstance(e.get("delta"), dict) else None
    if isinstance(delta, dict) and isinstance(delta.get("text"), str):
        # ⚠️ 只认 `delta.text`。`delta.toolUse` 是工具入参的 JSON 片段，当正文拼进去
        # 就是把裸 JSON 糊到用户脸上（web 端踩过）。
        text = delta["text"]
    elif isinstance(e.get("data"), str):
        text = e["data"]
    elif isinstance(evt.get("data"), str):
        text = evt["data"]

    # 来源：工具结果里带的 `sources`，或 agent 收尾时单独 yield 的那一帧。
    sources = []
    tr = e.get("toolResult") if isinstance(e.get("toolResult"), dict) else None
    if tr:
        cand = tr.get("sources")
        if not isinstance(cand, list):
            content = tr.get("content")
            cand = content.get("sources") if isinstance(content, dict) else None
        if isinstance(cand, list):
            sources = cand
    if not sources and isinstance(evt.get("sources"), list):
        sources = evt["sources"]

    error = None
    # ⚠️ 判据是 `error_type` 而**不是** `error`：工具返回体里合法地带业务字段
    # `{"error": "..."}`（比如权限不足的提示），拿 `error` 当"流失败了"会把正常
    # 回答误判成失败。runtime 的失败帧一定带 `error_type`。
    et = evt.get("error_type")
    if isinstance(et, str) and et:
        msg = evt.get("error")
        error = {"type": et, "message": msg if isinstance(msg, str) else ""}

    return {
        "text": text,
        "sources": sources,
        "actions": evt["actions"] if isinstance(evt.get("actions"), list) else [],
        "followups": (evt["followups"]
                      if isinstance(evt.get("followups"), list) else []),
        "investigation_step": (evt["investigation_step"]
                               if isinstance(evt.get("investigation_step"), dict)
                               else None),
        "thinking_step": (evt["thinking_step"]
                          if isinstance(evt.get("thinking_step"), dict) else None),
        "progress": (evt["progress"]
                     if isinstance(evt.get("progress"), dict) else None),
        "reasoning": (evt["reasoning"]
                      if isinstance(evt.get("reasoning"), dict) else None),
        "usage": evt["usage"] if isinstance(evt.get("usage"), dict) else None,
        "via": evt["via"] if isinstance(evt.get("via"), str) else "",
        "ready": evt.get("ready") is True,
        "error": error,
    }


# ---------------------------------------------------------------------------
# 收集器
# ---------------------------------------------------------------------------
class Sink:
    """把事件流攒成"要发出去的一张卡"，并把增量实时喂给 `LiveCard.emit`。

    与 `core.devops_chat.Sink` 同形（同样三种 emit kind、同样吞掉回调异常）——
    平台层因此可以对两条路径用**同一个** `LiveCard`。
    """

    def __init__(self, emit=None):
        self.reply: str = ""
        self.steps: list[str] = []
        self.sources: list[dict] = []
        self._seen_sources: set[str] = set()
        self._emit = emit

    def _fire(self, kind: str, payload: dict) -> None:
        if self._emit is None:
            return
        try:
            self._emit(kind, payload)
        except Exception as e:                    # noqa: BLE001
            # 显示层出错绝不能拖垮这一轮回答（答案已经付过 token 了）。
            logger.warning("agent_chat sink emit(%s) failed: %s", kind,
                           type(e).__name__)

    def say(self, text: str) -> None:
        if not text:
            return
        self.reply += text
        self._fire("text", {"delta": text})

    def step(self, text: str, detail: str = "") -> None:
        """加一条过程行。

        `progress` 先来一条无入参的（"正在查 CloudWatch"），紧随其后 `thinking_step`
        再来一条**同文**但带入参的 —— 前端的规则是"原地升级那一行"，这里照做：
        文案相同就替换最后一行，而不是并列成两条一样的。
        """
        line = (text or "").strip()
        if not line:
            return
        full = f"{line} · {detail.strip()}" if detail.strip() else line
        if self.steps and (self.steps[-1] == line
                           or self.steps[-1].split(" · ")[0] == line):
            self.steps[-1] = full
        else:
            self.steps.append(full)
            del self.steps[:-_MAX_STEPS]
        self._fire("step", {"text": full})

    def add_sources(self, items) -> None:
        for s in items or []:
            if not isinstance(s, dict):
                continue
            key = str(s.get("detail") or s.get("title") or "")
            if not key or key in self._seen_sources:
                continue
            self._seen_sources.add(key)
            self.sources.append(s)


def _step_text_of(obj) -> tuple[str, str]:
    """`thinking_step` / `progress` / `investigation_step` → `(text, detail)`。"""
    if not isinstance(obj, dict):
        return "", ""
    return (str(obj.get("text") or "").strip(),
            str(obj.get("detail") or "").strip())


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def consume_stream(body, sink: Sink, *, max_wait_sec: int) -> dict:
    """吃完一条 SSE 流。返回 `{"status","usage","error"}`。

    `status` ∈ {"completed","timed_out","failed"}。

    ⚠️ **错误帧后置处理**（与 agentcore.mjs 同一条铁律）：在解析回调里就 raise 会把
    SDK 的迭代器撕开，**丢掉缓冲区里已经到达的后续帧** —— 现网表现是"报错了，但其实
    答案已经生成完了，用户什么都没看到"。所以这里只**记下**错误，等流自然排空再处理。
    """
    t0 = time.monotonic()
    buf = ""
    usage: dict = {}
    runtime_error: dict | None = None
    timed_out = False

    chunks = body.iter_chunks() if hasattr(body, "iter_chunks") else body
    for chunk in chunks:
        if time.monotonic() - t0 > max_wait_sec:
            timed_out = True
            break
        if isinstance(chunk, str):
            buf += chunk
        else:
            buf += chunk.decode("utf-8", "replace")
        # SSE 以空行分帧。**不要**按单行切：一帧可以有多行 `data:`。
        while "\n\n" in buf:
            block, buf = buf.split("\n\n", 1)
            for line in block.split("\n"):
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw:
                    continue
                try:
                    evt = json.loads(raw)
                except ValueError:
                    # 不是 JSON → 原样当字符串帧交给 extract（它会判断像不像
                    # 序列化产物）。这也是 grok redactedContent 那条防线的入口。
                    evt = raw
                got = extract(evt)
                if got["error"] and runtime_error is None:
                    runtime_error = got["error"]
                sink.say(got["text"])
                sink.add_sources(got["sources"])
                for key in ("progress", "thinking_step", "investigation_step"):
                    t, d = _step_text_of(got[key])
                    if t:
                        sink.step(t, d)
                if got["usage"]:
                    usage = got["usage"]

    if timed_out:
        return {"status": "timed_out", "usage": usage, "error": runtime_error}
    if runtime_error and not sink.reply.strip():
        return {"status": "failed", "usage": usage, "error": runtime_error}
    return {"status": "completed", "usage": usage, "error": runtime_error}


def run_agent_chat(text: str, *, locale: str = "en", session_id: str = "",
                   model: str = "", account_id: str | None = None,
                   allowed_accounts: str = "",
                   web_search: bool = False, emit=None,
                   max_wait_sec: int | None = None) -> dict:
    """跑一轮 NotiOps Agent 对话。**永不抛** —— 失败也返回一句人话。

    返回 `{"reply","steps","sources","ok","usage","error"}`。
    `usage` 是**真实**用量（`{"totalTokens","cycles",...}`）；这一点与
    `core.devops_chat` 相反（那条是直连，硬编码 0）—— 卡片页脚据此选文案。

    `allowed_accounts` = 逗号分隔的账号闸门，**agent 侧真正的越权拦截线**
    （见 `agent-build/NotiOpsWebChat/app/NotiOpsWebChat/main.py::_resolve_acct`）。
    传空 = 沿用 `build_payload` 的历史默认 `"*"`（全开）—— 所以 IM 两个平台的
    `caps.chat` 都**必须**显式传 `core.im_accounts.allowed_accounts()`（fail-closed，
    永不返回 `"*"`）。少传一边的症状：那一个平台上闸门全开，而另一个平台是关的，
    两边看起来都"能用"，差别只在越权那一刻才显出来。
    """
    # 所有用户可见文案走 `agent.chat.*`（`core/i18n.py`）。`locale` 是调用方传的
    # `msg.locale`，已经是规整过的 `zh` / `en`；意外值由 `i18n.t` 回落到英文 —— 与同一张
    # 卡片里其它文案（步骤行、页脚）同一个回落方向，不会中英混排。
    sink = Sink(emit=emit)
    usage = {"totalTokens": 0, "cycles": 0, "direct": False}
    question = (text or "").strip()
    if not question:
        return {"reply": "", "steps": [], "sources": [], "ok": False,
                "usage": usage, "error": "empty_prompt"}

    arn = runtime_arn()
    if not arn:
        # 不许静默降级：这个部署压根没接 NotiOps agent（例如客户只部了 IM 栈）。
        # 明确说清楚 + 给出可执行的下一步，而不是偷偷换成 devops 直连。
        logger.error("agent_chat: AGENT_RUNTIME_ARN not set — refusing")
        return {"reply": i18n.t("agent.chat.not_configured", locale),
                "steps": [], "sources": [], "ok": False, "usage": usage,
                "error": "not_configured"}

    wait = _max_wait_sec() if max_wait_sec is None else max_wait_sec
    # 别等到被 Lambda 杀掉 —— 那样用户看到的是一张永远停在「思考中」的卡。
    # 留 45s 给"渲染终版 + 落库 + 释放租约"。
    try:
        from platforms.common import lambda_deadline
        wait = int(min(wait, max(30.0, lambda_deadline.remaining_seconds() - 45)))
    except Exception as e:                        # noqa: BLE001
        logger.warning("agent_chat: deadline probe failed: %s", type(e).__name__)

    sid = to_session_id(session_id or "")
    payload = build_payload(prompt=question, model=model, locale=locale,
                            web_search=web_search,
                            account_id=account_id or "",
                            allowed_accounts=allowed_accounts or "")
    try:
        resp = _client().invoke_agent_runtime(
            agentRuntimeArn=arn,
            runtimeSessionId=sid,
            contentType="application/json",
            accept="text/event-stream",
            payload=json.dumps(payload).encode("utf-8"),
        )
    except Exception as e:                        # noqa: BLE001
        logger.error("agent_chat: invoke failed: %s", _safe_err(e))
        return {"reply": i18n.t("agent.chat.invoke_failed", locale,
                               err=_safe_err(e)),
                "steps": sink.steps, "sources": [], "ok": False, "usage": usage,
                "error": "invoke_failed"}

    body = resp.get("response")
    if body is None:
        logger.error("agent_chat: response has no stream (API shape changed?)")
        return {"reply": i18n.t("agent.chat.no_stream", locale),
                "steps": sink.steps, "sources": [], "ok": False, "usage": usage,
                "error": "no_stream"}

    try:
        out = consume_stream(body, sink, max_wait_sec=wait)
    except Exception as e:                        # noqa: BLE001
        logger.error("agent_chat: stream failed: %s", _safe_err(e))
        out = {"status": "failed", "usage": {},
               "error": {"type": _safe_err(e), "message": ""}}
    finally:
        try:
            close = getattr(body, "close", None)
            if callable(close):
                close()
        except Exception as e:                    # noqa: BLE001
            logger.warning("agent_chat: stream close failed: %s", type(e).__name__)

    if out.get("usage"):
        u = out["usage"]
        usage = {
            "totalTokens": int(u.get("totalTokens") or 0),
            "cycles": int(u.get("cycles") or 0),
            "inputTokens": int(u.get("inputTokens") or 0),
            "outputTokens": int(u.get("outputTokens") or 0),
            "direct": False,
        }
    # 卡片落款报的是**哪个模型**（用量本身 2026-09-06 起不给客户看，但照样统计、
    # 照样在这个 dict 里 —— 见 `core/i18n.py::router.agent_model` 那段注释）。
    #
    # ⚠️ 为什么在这里解析、而不是在卡片层：`model` 是**这一轮真的发出去**的 alias
    # （`llm_pref_resolver` 的产物），而 `llm_config.resolve()` 与 agent 侧
    # `resolve_model_id()` 是同一个模块、读同一行 DDB 配置 —— 所以这里算出来的就是
    # runtime 实际加载的那个 id，包括「用户点的模型已被 Admin 停用 → 回落默认」这种
    # 情况。放到卡片层再猜一遍就会漂移，而漂移的症状是**落款报了个假模型**。
    # 失败只丢这一个字段（落款退成只报 agent 名）—— 报不出模型不该毁掉整张卡。
    usage["modelId"] = _resolve_model_id(model)

    reply = sink.reply.strip()
    status = out.get("status")
    if status == "timed_out" and not reply:
        reply = i18n.t("agent.chat.timed_out", locale, sec=wait)
    elif status == "failed" and not reply:
        etype = ((out.get("error") or {}).get("type")
                 or "AgentRuntimeStreamError")
        logger.error("agent_chat: runtime error type=%s", etype)
        reply = i18n.t("agent.chat.failed", locale, etype=etype)
    elif status == "timed_out":
        # 有正文但被我们掐断了 —— **必须明说**，不许让用户以为答完了。
        reply += "\n\n" + i18n.t("agent.chat.partial", locale, sec=wait)

    return {"reply": reply, "steps": list(sink.steps),
            "sources": list(sink.sources),
            "ok": status == "completed" and bool(reply),
            "usage": usage, "error": (out.get("error") or {}).get("type", "")}


__all__ = ["TOPIC", "Sink", "build_payload", "configured", "consume_stream",
           "extract", "run_agent_chat", "runtime_arn", "to_session_id"]
