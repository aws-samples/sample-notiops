"""STAROps（阿里云 AI 运维数字员工）SSE 流解析器 —— **纯函数模块，零依赖**。

`bff/web-chat/starops_sse.mjs` 的语义移植，**逐函数对照**（改动时两边一起改，别只改一边
—— 那正是 `core/devops_chat.py` 文件头讲的那件事）。定位与 `core/devops_chat.py` 相同：
把外部 agent 服务的流式响应转成 NotiOps 既有的输出通道（正文 / 过程行 / 瞬态进度），
因此 IM 卡片与 Web 面板**零改动复用**。NotiOps 侧 0 token（回答由阿里云自己的模型生成，
我们只当传输层）。

⚠️ **为什么这个文件不 import 本仓库任何东西**：`core/devops_chat.Sink` 是同一套语义，但它
   经 `core/devops_agent` 拉进 boto3。解析器是本功能唯一的风险中心，必须能**离线、无
   boto3、毫秒级**单测。所以这里按 duck-typing 收一个 sink（`say`/`step`/`progress`/`gap`），
   生产侧直接传 `core/devops_chat.Sink` 的实例；`already_said` 那几行在下面重写了一份，
   改动时两处要一起改。

────────────────────────────────────────────────────────────────────────────
线格式来源：2026-09-09 从阿里云 STAROps 控制台抓取的**原始事件流**一手证据
（完整规格见 `docs/_aliyun-m0-evidence/starops-sse-wire-format.md`，该目录不发布）。
在此之前本模块的设计全部是猜测。下面每一条 🔴 都是那份证据里**实际踩到**的坑，
不是防御性想象：

  🔴 `data:` 后面**没有空格**。用 `startswith("data: ")` 会一帧都匹配不上。
  🔴 抓到的那份流里**没有序号字段**（无 seq / eventId / index）。所以**我们这条路上断线
     不可续传** —— 可用的去重键只有 `(callId, timestamp)`，而并行工具调用的纳秒时间戳会
     撞近似值。调用方必须把「连接断了」当成整轮失败，不许假装能接上（不许静默降级）。
     （注：官方 schema 里另有 `action:"reconnect"` 这条续传路径，我们**没有实现**也
     **没有实测** —— 说"协议不支持续传"是不对的，说"我们不支持"才对。）
  🔴 `spin_text` 是**转场提示**（spinner 文案，`append:false`），不是正文。当正文渲染
     会让每个答案都以「让我为您查询相关信息...」开头。
  🔴 `text` 的 `lastChunk:true` **不代表答案结束**。实测一轮里出现 6 次 —— 每次调工具
     前收一段、调完再开一段。当结束信号会在第一次工具调用处截断答案。
     **唯一的结束信号是 `stream_done`。**
  🔴 思考帧与正文帧**交错且顺序不保证**（实测有 thinking 的时间戳晚于第一条正文）。
     「思考结束→正文开始」的状态机会丢内容，所以两者是**两个独立通道**，各自按到达
     顺序追加。
  🔴 `artifacts[].parts[0].text` 是前面所有 `text` 增量拼起来的**全文副本**。当正文渲染
     = 答案说两遍。这与 DevOps Agent 的 `final_response` 是**同一个坑**（见
     `core/devops_chat.py` 的 `_KIND_BY_TYPE` 注释）—— 两家厂商、同一种协议形状，
     所以「识别并丢弃全文副本」在这里是通则，不是某一家的特例。
  🔴 工具的 `status:"success"` 只表示「这次调用返回了」，**不表示工具成功**。实测有一次
     `status:"success"` 的 Bash，结果体里写着 `**Error**: exit code 5`。判失败要解析
     结果体，不能看 status。
  🔴 并行工具调用的结果帧**乱序返回**（两次 Bash 的 start 时间戳几乎相同，结果顺序与
     发出顺序不一致）。必须按 `toolCallId` 建表匹配，不能按位置配对，也不能按 `id`
     （`id` 是工具**类型**，实测与 `name` 同值）。
  🔴 `timestamp` 与 `task_finished.statistics.duration` 都是**纳秒**。当毫秒用会把
     26.58s 显示成 307 天。
  🔴 `stream_done.payload` 是 `None`（不是 `{}`）—— 不许无条件解引用 payload。
────────────────────────────────────────────────────────────────────────────
"""
from __future__ import annotations

import json
import re

#: 已实证过的线格式版本。见 `messages[].version`。
#:
#: 不认识的版本**不静默继续**：会往过程行打一条显眼的警告（调用方也能在日志里看到），
#: 但**仍然尽力解析**。为什么不直接抛：把用户这一轮的答案整段丢掉，比"版本可能变了"
#: 更坏 —— 而且版本号变化通常是加字段，旧字段照旧能解。两者取"大声 + 不丢答案"。
STAROPS_WIRE_VERSION = "v0.1.0"

#: 结果体里的失败标记。形状：`**Error**: exit code 5`（插在 `**Request ID**` 与
#: `**Output**` 之间）。只认这一种 —— 认宽了会把答案里正常出现的 "Error" 当成失败。
_TOOL_ERROR_RE = re.compile(r"\*\*Error\*\*:\s*(.+)")

#: `**Output**:` 之后那个围栏代码块里的首段。
_TOOL_OUTPUT_RE = re.compile(r"\*\*Output\*\*:\s*\n+```[^\n]*\n(.*?)(?:```|$)", re.S)

#: 一条 `messages[]` 元素里可能出现的载荷数组 —— **互斥**，这就是解析器的判别式。
#:
#: ⚠️ `agents` 是官方 schema 里的第 5 个数组，我们**没有实测到过**它。JS 那份的第一版只
#:    列了前 4 个、`default` 直接 `break`，于是一旦服务端发来 `agents[]`（多数字员工协作
#:    场景）就是**一声不响地整帧丢掉**。这里把它收进判别式：认得出来、会警告、但**不当
#:    正文渲染** —— 我们不知道它的字段形状，猜着渲染要么抖一坨 JSON 给用户，要么把答案
#:    说两遍。「知道有这么一帧、并说出来」是这条路上唯一诚实的做法。
_PAYLOAD_KINDS = ("contents", "events", "tools", "artifacts", "agents")


def ns_to_ms(ns) -> float:
    """纳秒 → 毫秒。Python 的 int 是任意精度，这里不像 JS 那样有 2^53 的顾虑。"""
    try:
        return float(int(ns)) / 1e6
    except (TypeError, ValueError):
        return 0.0


def split_frames(buf: str) -> tuple[list[str], str]:
    """从字节流缓冲里切出完整帧，返回 `(lines, rest)`。

    ⚠️ 必须显式做这件事：SSE chunk 边界与帧边界**无关**，一个 chunk 可能是半行。
    `rest` 让调用方把残行留到下一个 chunk 前面。
    """
    parts = ("" if buf is None else str(buf)).split("\n")
    rest = parts.pop() if parts else ""
    return parts, rest


def parse_frame(line: str) -> dict | None:
    """单行 → 信封对象。非 `data:` 行（空行、`event:`、`:` 心跳注释）与解析失败都回 None。

    `^data:\\s?` 而不是 `"data: "`：实测**没有空格**，但 SSE 规范允许有一个，
    两种都吃才不会因为服务端某天加了空格而整体失效。
    """
    s = ("" if line is None else str(line)).strip()
    if not s or not s.startswith("data:"):
        return None
    body = re.sub(r"^data:\s?", "", s).strip()
    if not body or body == "[DONE]":
        return None                          # 未观测到 [DONE]，但这是 SSE 通用终止串
    try:
        obj = json.loads(body)
    except Exception:                        # noqa: BLE001 — 半帧/心跳 → 静默跳过
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("messages"), list):
        return None
    return obj


def payload_kind(msg) -> str | None:
    """判别一条 `messages[]` 元素的载荷类型（见 `_PAYLOAD_KINDS`）。"""
    if not isinstance(msg, dict):
        return None
    for k in _PAYLOAD_KINDS:
        v = msg.get(k)
        if isinstance(v, list) and v:
            return k
    return None


def _norm(s) -> str:
    return re.sub(r"\s+", "", "" if s is None else str(s))


def already_said(reply: str, text: str) -> bool:
    """判"这段话是不是已经说过了"。用来挡 `artifacts` 的全文重发。

    与 `core/devops_chat.py::already_said` 同一实现（那边在另一条依赖链上，见文件头）。
    只能按去空白比：增量与全量版本的换行/空格常有差异。
    """
    a, b = _norm(text), _norm(reply)
    return len(a) > 0 and a in b


def _clip(v, n: int = 160) -> str:
    s = re.sub(r"\s+", " ", "" if v is None else str(v)).strip()
    return (s[:n] + "…") if len(s) > n else s


def summarize_tool_args(name: str, args) -> str:
    """把工具入参压成**一行人话**。

    ⚠️ 绝不把整坨 `arguments` JSON 抖进过程行 —— 与 `core/devops_chat.py` 里
       「过程行只放文字，不再把 ask_user 的整坨入参 JSON 抖给用户看」同一条规矩。
       过程行是给人看进度的，不是给人读 JSON 的。

    实测的三个工具各有自己的可读字段；未知工具**只报名字**，不猜它的入参含义。
    """
    a = args if isinstance(args, dict) else {}
    n = str(name or "")
    if n == "Bash":
        return _clip(a.get("command"))
    if n == "Read":
        return _clip(a.get("file_path") or a.get("path") or a.get("filePath"))
    if n == "TodoWrite":
        steps = a.get("steps") if isinstance(a.get("steps"), list) else []
        cur = next((s for s in steps if isinstance(s, dict) and s.get("status") == "in_progress"),
                   None)
        # 只报"共几步 + 当前在做哪一步"。把 4 步全列出来会让过程行每轮刷一屏。
        if cur:
            return f"{len(steps)} 步 · {_clip(cur.get('step'), 80)}"
        return f"{len(steps)} 步"
    return ""


def summarize_tool_result(raw) -> dict:
    """从工具结果体里抽出可读摘要 + 是否失败，返回 `{"text","failed","error"}`。

    `Bash` 的结果是固定结构的 markdown：
      `## Exec Result` → `**Request ID**: …` → （失败时 `**Error**: exit code N`）
      → `**Output**:` + 围栏代码块 → `Execution completed.`
    其余工具（`Read` 回 `"Read … (50 lines)"`）就是一行纯文本。
    """
    s = "" if raw is None else str(raw)
    err = _TOOL_ERROR_RE.search(s)
    failed = bool(err)
    # 过程行只要一行：优先报错误，其次报 Output 的首行，最后退回整体首行。
    if failed:
        text = err.group(1).strip()
    else:
        out = _TOOL_OUTPUT_RE.search(s)
        src = out.group(1) if out else s
        first = next((ln.strip() for ln in src.split("\n") if ln.strip()), "")
        text = (first[:200] + "…") if len(first) > 200 else first
    return {"text": text, "failed": failed, "error": err.group(1).strip() if failed else ""}


class StarOpsParser:
    """有状态的解析器。喂 chunk，往 sink 上写。

    `state["done"]` 为 True 表示收到 `stream_done`（**唯一**的正常结束信号）。

    sink 是 duck-typed：需要 `say(str)` / `step(str, dict)` / `progress(str)` / `gap()`。
    """

    def __init__(self, sink, *, en: bool = False, on_warn=None):
        self._sink = sink
        self._en = bool(en)
        self._warn_cb = on_warn
        self._buf = ""
        #: 待匹配的工具调用：toolCallId → name。**必须按 id 匹配**（并行调用乱序）。
        self._pending: dict[str, str] = {}
        #: 当前思考块的累积增量。按 `lastChunk` 收口成**一条**过程行 —— 一条一条发会让
        #: 过程区出现几百行三个字的碎片（reasoningDelta 的粒度非常细）。
        self._thinking = ""
        #: 已见过的 `version` / 未知 `agents` 帧，各只警告一次，避免每帧刷一行。
        self._version_warned = False
        self._agents_warned = False
        self.state: dict = {
            "done": False,
            # `task_finished` 报的墙钟（毫秒）。None = 还没收到。
            "duration_ms": None,
            # `task_finished.success`。None = 还没收到。
            "success": None,
            "request_id": "",
            "trace_id": "",
            # 用于挡全文副本：sink 自己也累积 reply，但 sink 是 duck-typed，不保证有这个字段。
            "reply": "",
        }

    # ── 内部工具 ────────────────────────────────────────────────────────────
    def _warn(self, msg: str) -> None:
        if callable(self._warn_cb):
            try:
                self._warn_cb(msg)
            except Exception:                # noqa: BLE001 — 警告回调炸了不许拖垮这一轮
                pass

    def _dv(self, zh: str, en: str) -> str:
        return en if self._en else zh

    def _say(self, t: str) -> None:
        self.state["reply"] += t
        self._sink.say(t)

    def _flush_thinking(self) -> None:
        t = self._thinking.strip()
        self._thinking = ""
        if not t:
            return
        # 思考内容是英文（对外正文是中文）—— 原样进过程行，不翻译：翻译要过模型，
        # 那就不是 0 token 了，而这条路存在的全部理由就是 0 token。
        self._sink.step((t[:600] + "…") if len(t) > 600 else t, {"kind": "thinking"})

    # ── 四类载荷 ────────────────────────────────────────────────────────────
    def _handle_contents(self, msg: dict) -> None:
        for c in msg.get("contents") or []:
            if not isinstance(c, dict):
                continue
            ctype = str(c.get("type") or "")
            value = "" if c.get("value") is None else str(c.get("value"))
            if ctype == "spin_text":
                # 转场提示：只在正文还没开始时显示（sink.progress 自己也守着这一条）。
                if value:
                    self._sink.progress(value)
                continue
            if ctype == "text":
                # `lastChunk` 一律忽略 —— 它在一轮里出现多次，不是结束信号。
                if value:
                    self._say(value)
                continue
            # 未知 content 类型 → **当正文**（失败安全：宁可多显示，也不能把答案藏进过程区）。
            # 与 core/devops_chat.py::block_kind 的兜底口径一致。
            if value:
                self._warn(f"unknown content type: {ctype}")
                self._say(value)

    def _handle_events(self, msg: dict) -> None:
        for e in msg.get("events") or []:
            if not isinstance(e, dict):
                continue
            etype = str(e.get("type") or "")
            p = e.get("payload")             # 🔴 可能是 None（stream_done）
            p = p if isinstance(p, dict) else {}
            if etype == "thinking":
                self._thinking += "" if p.get("reasoningDelta") is None \
                    else str(p.get("reasoningDelta"))
                if p.get("lastChunk"):
                    self._flush_thinking()
                continue
            if etype == "task_finished":
                self._flush_thinking()
                stats = p.get("statistics") if isinstance(p.get("statistics"), dict) else {}
                self.state["duration_ms"] = ns_to_ms(stats.get("duration"))
                self.state["success"] = p.get("success") is not False
                continue
            if etype == "stream_done":
                self._flush_thinking()
                self.state["done"] = True
                continue
            if etype == "thread_title_updated":
                # STAROps 自己给会话生成标题。IM 侧的卡片标题由我们自己管（im_cards），
                # 这一帧对前端没用 —— 但它**每轮都发**，不显式认掉就是每轮一条假告警
                # （2026-09-13 对真服务实测发现）。静默忽略，不是未知帧。
                continue
            self._warn(f"unknown event type: {etype}")

    def _handle_tools(self, msg: dict) -> None:
        for t in msg.get("tools") or []:
            if not isinstance(t, dict):
                continue
            # `id` 与 `name` 实测同值（都是 "Bash"）—— `id` 是工具**类型**不是唯一 id，
            # 唯一 id 是 `toolCallId`。别拿 `id` 当键。
            name = str(t.get("name") or t.get("id") or "tool")
            call_id = str(t.get("toolCallId") or "")
            status = str(t.get("status") or "")

            if status == "start":
                self._pending[call_id] = name
                brief = summarize_tool_args(name, t.get("arguments"))
                # 工具穿插在正文段落之间：不插空行会把前后两段粘成一段。
                self._sink.gap()
                self._sink.step(f"{name}: {brief}" if brief else name,
                                {"kind": "tool", "tool": name, "toolCallId": call_id})
                continue

            # 结果帧。按 callId 找回是哪次调用（乱序，不能按位置）。
            tool_name = self._pending.pop(call_id, "") or name
            contents = t.get("contents")
            body = "".join(
                "" if (c or {}).get("value") is None else str((c or {}).get("value"))
                for c in contents if isinstance(c, dict)
            ) if isinstance(contents, list) else ""
            r = summarize_tool_result(body)
            if r["failed"]:
                line = self._dv(f"{tool_name} 失败: {r['error']}",
                                f"{tool_name} failed: {r['error']}")
            else:
                line = self._dv(f"{tool_name} → {r['text'] or '完成'}",
                                f"{tool_name} → {r['text'] or 'done'}")
            self._sink.step(line, {"kind": "tool_result", "tool": tool_name,
                                   "toolCallId": call_id, "failed": r["failed"]})

    def _handle_artifacts(self, msg: dict) -> None:
        for a in msg.get("artifacts") or []:
            if not isinstance(a, dict):
                continue
            parts = a.get("parts") if isinstance(a.get("parts"), list) else []
            text = "".join(
                ("" if p.get("text") is None else str(p.get("text")))
                for p in parts if isinstance(p, dict) and p.get("kind") == "text"
            )
            if not text:
                continue
            # 🔴 正常情况下这是**全文副本**，必须丢。
            if already_said(self.state["reply"], text):
                continue
            # 但如果增量一条都没到（服务端只发了 artifact，或前面的帧丢了），它就是**唯一的
            # 答案** —— 那时必须说出来。这一条不是防御性想象：`is_final` 的语义是"最终产物"，
            # 协议没有保证增量一定先到。宁可重复，也不能整轮空白。
            self._sink.gap()
            self._say(text)

    def _handle_agents(self, msg: dict) -> None:
        """`agents[]` —— 官方 schema 有、我们**没实测到过**的第 5 个数组。

        见 `_PAYLOAD_KINDS` 的 ⚠️：认得出来、说一句、但不猜字段形状去渲染正文。
        只警告一次（多数字员工协作场景下它可能每帧都来）。
        """
        if self._agents_warned:
            return
        self._agents_warned = True
        names = [str(a.get("name") or a.get("digitalEmployeeName") or "").strip()
                 for a in msg.get("agents") or [] if isinstance(a, dict)]
        names = [n for n in names if n]
        shown = "、".join(names) if not self._en else ", ".join(names)
        self._warn(f"unhandled payload kind: agents (n={len(msg.get('agents') or [])})")
        self._sink.step(
            self._dv(
                "这一轮出现了多数字员工协作帧（agents），NotiOps 尚未实测过它的内容格式，"
                f"只如实报告收到{('：' + shown) if shown else ''}。",
                "This turn contained a multi-agent frame (agents) whose format NotiOps has "
                f"not verified; reporting its arrival only{(': ' + shown) if shown else ''}.",
            ),
            {"kind": "warning"},
        )

    # ── 对外 ────────────────────────────────────────────────────────────────
    def push(self, chunk: str) -> dict:
        """喂一段字节流。可以是半行。"""
        self._buf += "" if chunk is None else str(chunk)
        lines, rest = split_frames(self._buf)
        self._buf = rest
        for line in lines:
            env = parse_frame(line)
            if not env:
                continue
            if env.get("requestId"):
                self.state["request_id"] = str(env["requestId"])
            if env.get("traceId"):
                self.state["trace_id"] = str(env["traceId"])
            for msg in env.get("messages") or []:
                if not isinstance(msg, dict):
                    continue
                v = str(msg.get("version") or "")
                if v and v != STAROPS_WIRE_VERSION and not self._version_warned:
                    self._version_warned = True
                    self._warn(f"unexpected wire version: {v} "
                               f"(verified {STAROPS_WIRE_VERSION})")
                    self._sink.step(
                        self._dv(
                            f"STAROps 流格式为 {v}，NotiOps 已验证的是 "
                            f"{STAROPS_WIRE_VERSION}，按尽力解析处理。",
                            f"STAROps stream format is {v}; NotiOps verified "
                            f"{STAROPS_WIRE_VERSION}. Rendering best-effort.",
                        ),
                        {"kind": "warning"},
                    )
                kind = payload_kind(msg)
                if kind == "contents":
                    self._handle_contents(msg)
                elif kind == "events":
                    self._handle_events(msg)
                elif kind == "tools":
                    self._handle_tools(msg)
                elif kind == "artifacts":
                    self._handle_artifacts(msg)
                elif kind == "agents":
                    self._handle_agents(msg)
                # else: 五个数组都空 → 无载荷帧，跳过（未观测到，但不该崩）
        return self.state

    def end(self) -> dict:
        """流结束（连接关闭）。

        ⚠️ **没收到 `stream_done` 就是这一轮不完整**，而我们这条路上没有续传 → 调用方要
        据此给用户一句诚实的话，不许当成正常结束（不许静默降级）。
        这里只收口尚未 flush 的思考块，并把残留的 pending 工具报出来 ——
        「有 3 个工具发出去没回来」本身就是给用户的重要信号。
        """
        self._flush_thinking()
        if self._pending:
            names = list(self._pending.values())
            n = len(names)
            self._sink.step(
                self._dv(
                    f"流关闭时还有 {n} 个工具调用没有返回：{'、'.join(names)}",
                    f"{n} tool call(s) did not return before the stream closed: "
                    f"{', '.join(names)}",
                ),
                {"kind": "warning"},
            )
        return self.state


def create_starops_parser(sink, *, en: bool = False, on_warn=None) -> StarOpsParser:
    """与 JS 侧 `createStarOpsParser(sink, opts)` 同名同形的工厂（便于逐行对照）。"""
    return StarOpsParser(sink, en=en, on_warn=on_warn)


__all__ = [
    "STAROPS_WIRE_VERSION",
    "StarOpsParser",
    "already_said",
    "create_starops_parser",
    "ns_to_ms",
    "parse_frame",
    "payload_kind",
    "split_frames",
    "summarize_tool_args",
    "summarize_tool_result",
]
