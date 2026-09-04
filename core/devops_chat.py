"""「DevOps 对话」直连 —— Python 端口，供 IM（飞书/Slack/钉钉）Lambda worker 使用。

这是 `bff/web-chat/devops_chat.mjs`（Web 端，2026-08-27 上线并经现网实测）的**逐语义端
口**。为什么必须"照搬"而不是重写：那份 JS 里的 `KIND_BY_TYPE` 表、`already_said` 去重、
`parse_ask` / `render_user_prompt` 全部是**踩过现网 bug 之后**才长成现在这样的（每一处
都对应一个已修的现网问题）。IM 侧重写一遍必然一模一样地重踩，而且 IM 上更难发现
（Web 有右侧面板可对照，IM 只有一张卡片）。

NotiOps 侧 **0 token**：不经 Bedrock、不经 agent runtime。回答由客户自己的 DevOps Agent
生成（计客户自己的 DevOps Agent 额度），NotiOps 只当传输层 —— 所以本模块只依赖
`core.devops_agent` 已有的 boto3 客户端（`_client_and_space` / `operator_urls`），
不引入任何新依赖、不需要新密钥。

与 Web 端的三处**有意**差异（IM 不是浏览器）：
  1. 没有 SSE。`emit(kind, payload)` 是可选回调，IM worker 用它节流地 PATCH 卡片；
     不传就纯累积，最后一次性发出去。
  2. `execution_id` 不落 web 的 conversation 表，而是由调用方存在 `imchat#<chat_id>`
     行上（见 core/ddb_state.py）。本模块只**读入 / 返回**，不自己写库 —— 传输层保持无状态。
  3. 「过程行」在 IM 上是卡片里的折叠区，不是独立面板，故 `steps` 一并返回给调用方。

⚠️ 本模块含中英双语字面量（与 JS 端一致）。这些文案与事件流处理紧耦合、只在这一条路径上
出现，拆成 20 个 i18n key 反而让"和 JS 端逐行对照"变得不可能 —— 因此 `core/devops_chat.py`
进 scripts/lint_i18n.py 的 CJK_ALLOWLIST（与 core/nl_router.py 同样的口径）。
"""
from __future__ import annotations

import json
import logging
import os
import re
import time

from core import devops_agent

logger = logging.getLogger(__name__)


def _safe_err(e: Exception) -> str:
    """复用 devops_agent 的安全错误串（只出类型名 + AWS 错误码，绝不出原始 message）。"""
    return devops_agent._safe_err(e)


# 单轮对话的最长等待。IM worker Lambda timeout 900s（平台硬顶），保守取 840s，与 Web 端
# 同一口径。超时不算失败：已产出的正文照样发出去，并提示去 Operator App 继续看。
def _max_wait_sec() -> int:
    raw = os.environ.get("NOTIOPS_DEVOPS_CHAT_MAX_WAIT_SEC", "")
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 840


# ---------------------------------------------------------------------------
# 块类型判定 —— 2026-08-27 对现网 SendMessage 事件流做形状实证得到的表
# ---------------------------------------------------------------------------
# `contentBlockStart.type` 是**自由字符串**（服务端未给枚举），所以按"已实证类型表优先 +
# 模式兜底"分类。口径：**明确像过程**的才进折叠区，其余（含未标类型 / 未知类型）一律当正文
# —— 反过来会把答案藏起来，用户看到空卡片。
#
# 实测同一轮回答里出现的块：
#   · text           正文，逐 delta 流（唯一该进气泡的正文块）
#   · final_response **整段答案的全量重复**，一个 delta 给完 → 当正文处理 = 每轮说两遍
#   · chat_title     会话标题（如 "New Conversation Started"）→ 当正文 = 答案尾巴多一句
#   · context_usage  上下文水位 JSON，纯元数据
#   · tool_summary   工具调用摘要 → 过程
#   · user_prompt    **agent 反问用户**（ask_user 的 question + options）。整轮只有它时，
#                    旧口径下正文一个字都没有 → 「本轮没有返回内容」
_KIND_BY_TYPE: dict[str, str] = {
    "text": "answer", "answer": "answer", "message": "answer",
    "markdown": "answer", "output": "answer", "content": "answer",
    "response": "answer",
    "final_response": "final",
    "chat_title": "meta",
    "context_usage": "meta",
    "tool_summary": "step",
    "user_prompt": "prompt",
}
_STEP_TYPE_RE = re.compile(
    r"tool|function|think|reason|plan|subagent|status|trace|progress|"
    r"action|todo|citation|search|retriev",
    re.IGNORECASE,
)


def block_kind(type_: str, parent_id: str = "") -> str:
    """→ "answer" | "final" | "meta" | "prompt" | "step"."""
    t = str(type_ or "").strip()
    if not t:
        return "answer"                      # 没标类型 → 当正文
    known = _KIND_BY_TYPE.get(t.lower())
    if known:
        return known                         # 实证类型优先
    if _STEP_TYPE_RE.search(t):
        return "step"
    # 嵌套块（子代理内部动作）→ 过程；其余未知类型仍当正文（失败安全）
    return "step" if parent_id else "answer"


_WS_RE = re.compile(r"\s+")


def _norm(s) -> str:
    return _WS_RE.sub("", str(s or ""))


def already_said(reply: str, text: str) -> bool:
    """归一化后判"这段话是不是已经说过了"。

    用于挡住 `final_response`（以及将来任何一次性重发全文的块）造成的整段重复：deltas 与
    全量版本的空白/换行常有差异，只能按归一化比。
    """
    a, b = _norm(text), _norm(reply)
    return len(a) > 0 and a in b


def parse_ask(raw) -> dict | None:
    """从块的 JSON 里抽出 agent 的反问。两种形状都吃：

      · `user_prompt` 块：``{question, options, interrupt_id}``
      · `tool_summary` 块的工具入参：``{type:"tool_call", name:"ask_user", input:{...}}``

    返回 None = 这块不是反问（正常情况，绝大多数工具调用都不是）。
    """
    s = str(raw or "").strip()
    if not s.startswith("{"):
        return None
    try:
        q = json.loads(s)
    except (ValueError, TypeError):
        return None
    if not isinstance(q, dict):
        return None
    inner = q.get("input")
    if isinstance(inner, dict):
        # 工具调用形状：只认 ask_user，别把随便哪个工具的入参当成"对用户说的话"。
        if not re.search(r"ask_?user", str(q.get("name") or ""), re.IGNORECASE):
            return None
        q = inner
    question = str(q.get("question") or "").strip()
    options = q.get("options")
    options = options if isinstance(options, list) else []
    if not question and not options:
        return None
    return {"question": question, "options": options}


def render_user_prompt(raw, en: bool = False) -> str:
    """把 agent 的反问渲染成正文里的一段人话。

    为什么必须进正文：这是 agent **对你说的话**（"你想从哪方面开始?" + 几个选项），丢掉它
    整轮就是空白（线上现象：「本轮没有返回内容」）。NotiOps 只做只读传输层 —— 不代客户点
    选项，让他直接打字回复。
    """
    parsed = parse_ask(raw) if isinstance(raw, str) else (raw or {})
    question = str((parsed or {}).get("question") or "").strip()
    options = (parsed or {}).get("options")
    options = options if isinstance(options, list) else []
    if not question and not options:
        # 解析失败：绝不把裸 JSON 倒进正文，只给一句可操作的提示。
        return ("**DevOps Agent needs more input before it can continue.** "
                "Please reply with the details here." if en else
                "**DevOps Agent 需要你补充信息才能继续。** 请直接回复补充说明。")
    lines: list[str] = []
    lines.append(f"**DevOps Agent asks:** {question}" if en
                 else f"**DevOps Agent 想先确认：** {question}")
    if options:
        lines.append("")
        for o in options:
            if not isinstance(o, dict):
                continue
            label = str(o.get("label") or "").strip()
            if not label:
                continue
            desc = str(o.get("description") or "").strip()
            rec = (" _(recommended)_" if en else " _（推荐）_") if o.get("recommended") else ""
            lines.append(f"- **{label}**{rec} —— {desc}" if desc
                         else f"- **{label}**{rec}")
        lines.append("")
        lines.append("_Reply with your choice and DevOps Agent will continue._" if en
                     else "_把你的选择直接回我，DevOps Agent 就会接着做。_")
    return "\n".join(lines)


def block_label(b: dict, en: bool) -> str:
    """过程行文案：把 `tool_use` / `thinking` 这类机器类型名转成人话。"""
    t = str((b or {}).get("type") or "").strip()
    pretty = _WS_RE.sub(" ", re.sub(r"[_-]+", " ", t)).strip()
    nested = (" (subagent)" if en else "（子代理）") if (b or {}).get("parentId") else ""
    # 实证类型名直接给人话（`tool_summary` 拼进 "调用工具：tool summary" 是句中英夹生的废话）。
    if re.fullmatch(r"tool_summary", t, re.IGNORECASE):
        return ("Tool call" if en else "调用工具") + nested
    if re.search(r"tool|function", t, re.IGNORECASE):
        return (f"Tool call: {pretty}" if en else f"调用工具：{pretty}") + nested
    if re.search(r"think|reason", t, re.IGNORECASE):
        return f"Thinking{nested}…" if en else f"思考中{nested}…"
    if re.search(r"plan|todo", t, re.IGNORECASE):
        return f"Planning{nested}…" if en else f"制定计划{nested}…"
    if re.search(r"user_prompt", t, re.IGNORECASE):
        return "Waiting for your choice" if en else "等待你的选择"
    if re.search(r"search|retriev", t, re.IGNORECASE):
        return f"Searching{nested}…" if en else f"检索中{nested}…"
    return (f"Step: {pretty}" if en else f"过程：{pretty}") + nested


def excerpt(s, max_len: int = 180) -> str:
    """过程行的尾巴：单行、截断 —— 折叠区是逐行时间线，长文会把卡片撑爆。"""
    one = _WS_RE.sub(" ", str(s or "")).strip()
    return (one[:max_len] + "…") if len(one) > max_len else one


# executionId 失效（会话过期/被清）时的错误名。只在**一个字都还没吐**时才重开新会话重试一次。
_STALE_RE = re.compile(
    r"ResourceNotFound|NotFound|Validation|Conflict|Expired|Gone|InvalidRequest",
    re.IGNORECASE,
)


class Sink:
    """输出通道：把一轮回答要写的三种东西（正文 / 过程行 / 瞬态进度）收在一处。

    与 Web 端 `makeSink` 同形。IM 侧多存一份 `steps`（卡片折叠区要一次性渲染），并把
    `emit` 做成可选 —— 离线单测喂手写事件流时不需要任何回调。
    """

    def __init__(self, emit=None):
        self.reply = ""
        self.steps: list[dict] = []
        self.progress_text = ""
        self._emit = emit

    def _fire(self, kind: str, payload: dict) -> None:
        if not self._emit:
            return
        try:
            self._emit(kind, payload)
        except Exception as e:                        # 回调炸了不许拖垮这一轮回答
            logger.warning("devops_chat sink emit(%s) failed: %s", kind, _safe_err(e))

    def say(self, t: str) -> None:
        """正文：累积 + 通知调用方（IM 侧用来节流刷卡片）。"""
        if not t:
            return
        self.reply += t
        self._fire("text", {"delta": t})

    def step(self, t: str, extra: dict | None = None) -> None:
        """过程行 → 卡片折叠区。"""
        if not t:
            return
        item = {"text": t}
        if extra:
            item.update(extra)
        self.steps.append(item)
        self._fire("step", item)

    def progress(self, t: str) -> None:
        """瞬态进度行：**只在正文还没开始时**发（正文一来就该被覆盖），避免盖住答案。"""
        if self.reply or not t:
            return
        self.progress_text = t
        self._fire("progress", {"text": t})

    def gap(self) -> None:
        """正文块之间插空行：工具调用穿插在段落之间时，不插会把两段粘成一段。"""
        if self.reply and not self.reply.endswith("\n\n"):
            self.say("\n\n")


def _new_block() -> dict:
    # ⚠️ 文字与 JSON **分开存**：同一个块里两者都会来（实测 `tool_summary` = 一句人话
    # "Asking user: …?" + 一大坨 `{"type":"tool_call",…}` 入参）。混在一个 buf 里，过程行
    # 就会把裸 JSON 抖给用户看（线上已出现）。
    return {"type": "", "kind": "answer", "buf": "", "json": "",
            "emitted_any": False, "dup": False}


def consume_events(events, sink: Sink, en: bool = False,
                   max_wait_sec: int | None = None) -> dict:
    """消费 SendMessage 的事件流并实时喂给 `sink`。

    **本函数是这个功能的风险中心**，故独立可测：逐 delta 转发（不缓冲）、正文/过程分流、
    stop 的累积文本不许重复追加。

    返回 ``{"completed": bool, "failed": dict|None, "timed_out": bool}``。
    """
    if max_wait_sec is None:
        max_wait_sec = _max_wait_sec()

    def dv(zh: str, en_str: str) -> str:
        return en_str if en else zh

    blocks: dict[object, dict] = {}

    def block_for(i):
        b = blocks.get(i)
        if b is None:
            # 没见过 start 就来 delta：按正文处理（失败安全）。
            b = _new_block()
            blocks[i] = b
        return b

    # 已经在正文里说过的反问（按问题正文归一化去重）：同一个 ask_user 会同时出现在
    # `tool_summary` 的入参和 `user_prompt` 块里，不去重就会问两遍。
    ask_shown: set[str] = set()

    def flush_pending_asks() -> None:
        """收尾兜底：流提前结束（completed / 超时）时把还没 stop 的块里的反问补出来，
        否则那一轮正文可能一个字都没有。"""
        for b in list(blocks.values()):
            if b["kind"] not in ("prompt", "step"):
                continue
            ask = parse_ask(b["json"]) or parse_ask(b["buf"])
            if not ask or _norm(ask["question"]) in ask_shown:
                continue
            ask_shown.add(_norm(ask["question"]))
            sink.gap()
            sink.say(render_user_prompt(ask, en))

    completed, failed, timed_out = False, None, False
    t0 = time.monotonic()
    for ev in (events or []):
        if not isinstance(ev, dict):
            continue
        # 墙钟兜底：Lambda 被平台掐掉的话用户只会看到截断，主动收尾至少能给一句出路。
        if time.monotonic() - t0 > max_wait_sec:
            timed_out = True
            flush_pending_asks()
            break
        if ev.get("heartbeat"):
            continue
        if ev.get("responseCreated") or ev.get("responseInProgress"):
            sink.progress(dv("DevOps Agent 正在思考…", "DevOps Agent is thinking…"))
            continue
        if ev.get("summary"):
            c = str((ev["summary"] or {}).get("content") or "").strip()
            if c:
                sink.step(excerpt(c, 400))
                sink.progress(excerpt(c, 120))
            continue
        if ev.get("contentBlockStart"):
            b = ev["contentBlockStart"] or {}
            kind = block_kind(b.get("type"), b.get("parentId"))
            label = block_label(b, en)
            nb = _new_block()
            nb["type"] = b.get("type") or ""
            nb["kind"] = kind
            blocks[b.get("index")] = nb
            if kind in ("step", "prompt"):
                sink.step(label)
                sink.progress(label)
            continue
        if ev.get("contentBlockDelta"):
            d = ev["contentBlockDelta"] or {}
            b = block_for(d.get("index"))
            delta = d.get("delta") or {}
            td = (delta.get("textDelta") or {}).get("text")
            jd = (delta.get("jsonDelta") or {}).get("partialJson")
            if isinstance(td, str) and td:
                if b["kind"] == "answer":
                    # 反重复兜底：某些块（已知 `final_response`）会把**整段答案**一次性
                    # 重发。首个 delta 就已经说过 → 整块丢弃，否则用户每轮看到两遍。
                    if (not b["emitted_any"] and not b["dup"]
                            and already_said(sink.reply, td)
                            and len(_norm(td)) >= 12):
                        b["dup"] = True
                    if b["dup"]:
                        b["buf"] += td
                        continue
                    if not b["emitted_any"]:
                        sink.gap()
                    b["emitted_any"] = True
                    sink.say(td)   # ★ 逐 delta 转发，不缓冲
                else:
                    # 过程 / 元数据 / 反问块的文字：先收着
                    b["buf"] += td
            elif isinstance(jd, str) and jd:
                b["json"] += jd   # 工具入参 / 反问选项 JSON：单独存，绝不裸进正文或过程行
            continue
        if ev.get("contentBlockStop"):
            s = ev["contentBlockStop"] or {}
            idx = s.get("index")
            b = blocks.get(idx)
            kind = (b or {}).get("kind") or "answer"
            s_text = s.get("text") if isinstance(s.get("text"), str) else ""
            if kind in ("step", "prompt"):
                # 过程行尾巴：**只用文字**（b["buf"]），JSON 入参不外泄。
                tail = excerpt((b or {}).get("buf") or s_text)
                if tail:
                    sink.step(f"  ↳ {tail}")
                # agent 的反问 → 提到正文里说人话，按问题正文去重避免说两遍。
                ask = parse_ask((b or {}).get("json")) or parse_ask((b or {}).get("buf"))
                if ask and _norm(ask["question"]) not in ask_shown:
                    ask_shown.add(_norm(ask["question"]))
                    sink.gap()
                    sink.say(render_user_prompt(ask, en))
            elif kind == "meta":
                pass   # chat_title / context_usage：既不进正文也不进过程行
            elif kind == "final":
                # 全量重复块：只在**一个字都还没吐**时才用它（此时它是唯一答案来源）。
                full = ((b or {}).get("buf") or s_text).strip()
                if full and not already_said(sink.reply, full):
                    sink.gap()
                    sink.say(full)
            elif b and not b["emitted_any"] and not b["dup"] and s_text.strip():
                # 兜底：**只在一个 delta 都没收到**时才用 stop 的累积全文。
                # 已经流过 deltas 还追加 = 整段重复（stop.text 是累积值，不是增量）。
                sink.gap()
                sink.say(s_text)
            blocks.pop(idx, None)
            continue
        if ev.get("responseCompleted"):
            u = (ev["responseCompleted"] or {}).get("usage") or {}
            # DevOps Agent 侧的用量（计客户自己的 DevOps Agent 额度，不是 NotiOps 的 token）。
            logger.info("devops_chat completed devops_tokens=%s "
                        "(billed to the customer's DevOps Agent, not NotiOps)",
                        u.get("totalTokens") or u.get("outputTokens") or "?")
            completed = True
            flush_pending_asks()
            break
        if ev.get("responseFailed"):
            failed = ev["responseFailed"] or {}
            break
    return {"completed": completed, "failed": failed, "timed_out": timed_out}


def run_devops_chat(text: str, *, locale: str = "en", account_id: str | None = None,
                    session: dict | None = None, skill_prompt: str = "",
                    emit=None, max_wait_sec: int | None = None) -> dict:
    """一轮「DevOps 对话」。**NotiOps 侧 0 token**（不经 Bedrock / agent runtime）。

    Args:
      text: 用户原话。
      locale: "zh" | "en" —— 只影响 NotiOps 自己那几句提示；答案语言由 DevOps Agent 决定。
      account_id: 目标账号（空 = 部署账号自身）。
      session: 上一轮的会话状态，形如 ``{"execution_id","agent_space_id","account_id"}``，
        由调用方从 `imchat#<chat_id>` 行读入。只在 Agent Space 与目标账号都没变时才复用
        （切账号 = 切目标环境，必须开新会话）。
      skill_prompt: 已内联好的 skill 正文（调用方负责加载；这条路径上没有我们的模型可注入
        system prompt，"让 skill 生效"只能靠内联）。
      emit: 可选 ``(kind, payload)`` 回调 —— "text" / "step" / "progress"。
      max_wait_sec: 覆盖默认墙钟上限（测试用）。

    Returns:
      ``{"reply", "steps", "session", "console_home", "ok", "usage"}``。
      ``session`` 是**要落库的**新状态（调用方写回 `imchat#`）；``usage`` 恒为
      ``{"totalTokens": 0, "direct": True}`` —— 0 token 必须可见，不能像 Web 早期那样
      悄悄吞掉（客户会以为功能坏了）。
    """
    en = (locale or "en") == "en"
    wait = _max_wait_sec() if max_wait_sec is None else max_wait_sec

    def dv(zh: str, en_str: str) -> str:
        return en_str if en else zh

    sink = Sink(emit=emit)
    usage = {"totalTokens": 0, "cycles": 0, "direct": True}

    def done(ok: bool, sess: dict | None = None, home: str = "") -> dict:
        return {"reply": sink.reply, "steps": sink.steps, "session": sess or {},
                "console_home": home, "ok": ok, "usage": usage}

    content = str(text or "")
    if skill_prompt:
        content = skill_prompt

    sink.progress(dv("正在连接 DevOps Agent…", "Connecting to DevOps Agent…"))

    # 先过跨账号闸门（LOCKED_ACCOUNT_ID），再解析 client —— 与 start_investigation /
    # poll_investigation 同一个口径。少了这一步，本路径就是三条 DevOps Agent 链路里
    # 唯一一条不受闸门约束的：单账号部署下，只要 config 表里有一行 `da#<别的账号>`，
    # 用户打一句 `account <别的账号>` 就能拿它的 Agent Space 说话。
    # `_target_account(None)` 会补成部署账号，所以缺省行为不变。
    acct = devops_agent._target_account(account_id)
    if not acct:
        sink.say(dv(
            "⚠️ 跨账号 DevOps 对话未开启，当前仅支持部署账号。",
            "⚠️ Cross-account DevOps chat is not enabled; only the deployment "
            "account is supported."))
        return done(False)

    client, space = devops_agent._client_and_space(acct)
    if not client or not space:
        sink.say(dv(
            "⚠️ 无法定位该账号的 DevOps Agent Agent Space。请确认该账号已接入 DevOps Agent。",
            "⚠️ Could not resolve the DevOps Agent Agent Space for this account. "
            "Please confirm the account is onboarded to DevOps Agent."))
        return done(False)

    home = (devops_agent.operator_urls(space) or {}).get("home") or ""
    # 过程首行：连到哪个 Agent Space + 后台入口。
    # ⚠️ 只给 Operator App **首页**，不猜 /chat/{executionId} 之类深链（猜错就是死链）。
    sink.step(dv(f"已连接 Agent Space `{space}`", f"Connected to Agent Space `{space}`"),
              {"console_url": home} if home else None)

    # ── 多轮上下文：复用同一个 execution_id ──
    # DevOps Agent 的对话历史挂在 execution_id 上，所以"接着上一句问"必须复用它。
    # 会话键里的 `acct` 是**解析后**的账号（不是入参原样）：否则同一个部署账号会
    # 因为一次带 account_id、一次不带而被当成两个环境，白开新对话丢上下文。
    sess = session or {}
    execution_id = ""
    if (str(sess.get("agent_space_id") or "") == space
            and str(sess.get("account_id") or "") == acct):
        execution_id = str(sess.get("execution_id") or "")
    reused = bool(execution_id)

    def new_state(exid: str) -> dict:
        return {"execution_id": exid, "agent_space_id": space, "account_id": acct}

    def new_chat() -> str:
        # userId 已废弃（服务端从鉴权会话解析身份）→ 不传；userType 标明我们是 IAM 签名调用方。
        r = client.create_chat(agentSpaceId=space, userType="IAM")
        exid = (r or {}).get("executionId") or ""
        if not exid:
            raise RuntimeError("create_chat_no_execution_id")
        return exid

    if not execution_id:
        sink.progress(dv("正在创建对话…", "Creating the chat…"))
        try:
            execution_id = new_chat()
        except Exception as e:
            logger.warning("devops_chat create_chat_failed: %s", _safe_err(e))
            sink.say(dv(
                f"⚠️ 创建 DevOps Agent 对话失败（{_safe_err(e)}）。请稍后重试。",
                f"⚠️ Failed to create the DevOps Agent chat ({_safe_err(e)}). Retry later."))
            return done(False, home=home)

    # 真正开始对话之前已经写进正文的内容（目前只可能是 skill 读失败提示，由调用方写入）。
    prelude = sink.reply

    def stream_once(exid: str) -> dict:
        sink.progress(dv("已发送，DevOps Agent 正在处理…",
                         "Sent — DevOps Agent is working…"))
        resp = client.send_message(agentSpaceId=space, executionId=exid,
                                   content=content)
        return consume_events(resp.get("events"), sink, en=en, max_wait_sec=wait)

    try:
        res = stream_once(execution_id)
    except Exception as e:
        # 复用的 execution_id 过期/失效 → 重开一个新对话重试一次（**仅在还没吐过正文时**）。
        # 与 `prelude` 比而不是 `not sink.reply`：调用方写的 skill 提示也在 reply 里。
        stale = (reused and sink.reply == prelude
                 and bool(_STALE_RE.search(type(e).__name__ or "")))
        logger.warning("devops_chat send_message_failed: %s %s", _safe_err(e),
                       "stale_execution_retry" if stale else "")
        if not stale:
            sink.say(dv(
                f"⚠️ 与 DevOps Agent 的对话中断（{_safe_err(e)}）。请重试。",
                f"⚠️ The DevOps Agent conversation was interrupted ({_safe_err(e)}). "
                f"Please retry."))
            return done(False, new_state(execution_id), home)
        sink.step(dv("上一轮对话已过期，正在新建对话重试…",
                     "The previous chat expired — starting a new one and retrying…"))
        try:
            execution_id = new_chat()
            res = stream_once(execution_id)
        except Exception as e2:
            logger.warning("devops_chat send_message_retry_failed: %s", _safe_err(e2))
            sink.say(dv(
                f"⚠️ 与 DevOps Agent 的对话失败（{_safe_err(e2)}）。请稍后重试。",
                f"⚠️ The DevOps Agent conversation failed ({_safe_err(e2)}). "
                f"Please retry later."))
            return done(False, home=home)

    if res["failed"]:
        # 只展示错误**码**，不展示服务端原始 message（docs/LOGGING_STANDARD.md）。
        code = str((res["failed"] or {}).get("errorCode") or "unknown")
        logger.warning("devops_chat response_failed code=%s", code)
        sink.say(dv(f"\n\n⚠️ DevOps Agent 未能完成本次回答（{code}）。",
                    f"\n\n⚠️ DevOps Agent could not complete this answer ({code})."))
        if home:
            sink.say(dv(f"可到后台查看详情：{home}",
                        f" See details in the console: {home}"))
    elif res["timed_out"]:
        sink.say(dv(f"\n\n⏳ 本轮等待超过 {wait} 秒，先返回已生成的部分。",
                    f"\n\n⏳ This turn exceeded {wait}s, returning what was "
                    f"generated so far."))
        if home:
            sink.say(dv(f"完整对话可在 DevOps Agent 后台继续查看：{home}",
                        f" You can continue in the DevOps Agent console: {home}"))
    elif not sink.reply:
        sink.say(dv("（DevOps Agent 本轮没有返回内容，请换个说法再试。）",
                    "(DevOps Agent returned no content this turn — try rephrasing.)"))

    # ── 待确认（暂停的工具调用）──
    # DevOps Agent 遇到需要人工批准的动作（多为写操作/变更）会挂起等确认。NotiOps 是**只读**
    # 界面，绝不代客户批准 —— 只如实告知并把人引到 DevOps Agent 控制台去做这个决定。
    if res["completed"]:
        try:
            r = client.list_pending_messages(agentSpaceId=space,
                                             executionId=execution_id)
            if (r or {}).get("messages"):
                sink.say(dv(
                    f"\n\n---\n\n⏸️ DevOps Agent 正在等待一次**人工确认**才能继续"
                    f"（通常是变更类动作）。NotiOps 是只读界面、不代你批准 —— "
                    f"请到 DevOps Agent 控制台完成确认：{home or 'DevOps Agent 控制台'}",
                    f"\n\n---\n\n⏸️ DevOps Agent is waiting for a **human approval** "
                    f"before it can continue (usually a change action). NotiOps is "
                    f"read-only and will not approve on your behalf — complete the "
                    f"approval in the DevOps Agent console: "
                    f"{home or 'DevOps Agent console'}"))
        except Exception as e:
            # 探测失败不影响答案（老 botocore 可能没这个 API）
            logger.warning("devops_chat list_pending_failed: %s", _safe_err(e))

    return done(True, new_state(execution_id), home)
