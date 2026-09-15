/**
 * STAROps（阿里云 AI 运维数字员工）SSE 流解析器 —— **纯函数模块，零依赖**。
 *
 * 定位：与 `devops_chat.mjs` 完全同一个角色 —— 把外部 agent 服务的流式响应转成
 * NotiOps 既有的四种 SSE 事件（`token` / `progress` / `investigation_step` / `usage`），
 * 因此前端渲染与右侧「调查过程」面板**零改动复用**。NotiOps 侧 0 token
 * （回答由阿里云自己的模型生成，我们只当传输层）。
 *
 * ⚠️ **为什么这个文件不 import 任何东西**：`devops_chat.mjs` 的 `makeSink` / `alreadySaid`
 *    是同一套语义，但它经 `devops_investigate.mjs` 拉进整条 AWS SDK 依赖链。解析器是
 *    本功能唯一的风险中心，必须能**离线、无 SDK、毫秒级**单测。所以这里按 duck-typing
 *    收一个 sink（`say`/`step`/`progress`/`gap`），生产侧直接传 `makeSink()` 的返回值；
 *    `alreadySaid` 那 4 行在下面重写了一份，改动时两处要一起改。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 线格式来源：2026-09-09 从阿里云 STAROps 控制台抓取的**原始事件流**一手证据
 * （完整规格见 `docs/_aliyun-m0-evidence/starops-sse-wire-format.md`，该目录不发布）。
 * 在此之前本模块的设计全部是猜测。下面每一条 🔴 都是那份证据里**实际踩到**的坑，
 * 不是防御性想象：
 *
 *   🔴 `data:` 后面**没有空格**。用 `startsWith("data: ")` 会一帧都匹配不上。
 *   🔴 抓到的那份流里**没有序号字段**（无 seq / eventId / index）。所以**我们这条路上断线
 *      不可续传** —— 可用的去重键只有 `(callId, timestamp)`，而并行工具调用的纳秒时间戳会
 *      撞近似值。调用方必须把「连接断了」当成整轮失败，不许假装能接上（不许静默降级）。
 *      （注：官方 schema 里另有 `action:"reconnect"` 这条续传路径，我们**没有实现**也
 *      **没有实测** —— 说"协议不支持续传"是不对的，说"我们不支持"才对。）
 *   🔴 `spin_text` 是**转场提示**（spinner 文案，`append:false`），不是正文。当正文渲染
 *      会让每个答案都以「让我为您查询相关信息...」开头。
 *   🔴 `text` 的 `lastChunk:true` **不代表答案结束**。实测一轮里出现 6 次 —— 每次调工具
 *      前收一段、调完再开一段。当结束信号会在第一次工具调用处截断答案。
 *      **唯一的结束信号是 `stream_done`。**
 *   🔴 思考帧与正文帧**交错且顺序不保证**（实测有 thinking 的时间戳晚于第一条正文）。
 *      「思考结束→正文开始」的状态机会丢内容，所以两者是**两个独立 sink**，各自按到达
 *      顺序追加。
 *   🔴 `artifacts[].parts[0].text` 是前面所有 `text` 增量拼起来的**全文副本**。当正文渲染
 *      = 答案说两遍。这与 DevOps Agent 的 `final_response` 是**同一个坑**（见
 *      `devops_chat.mjs` 的 KIND_BY_TYPE 注释）—— 两家厂商、同一种协议形状，
 *      所以「识别并丢弃全文副本」在这里是通则，不是某一家的特例。
 *   🔴 工具的 `status:"success"` 只表示「这次调用返回了」，**不表示工具成功**。实测有一次
 *      `status:"success"` 的 Bash，结果体里写着 `**Error**: exit code 5`。判失败要解析
 *      结果体，不能看 status。
 *   🔴 并行工具调用的结果帧**乱序返回**（两次 Bash 的 start 时间戳几乎相同，结果顺序与
 *      发出顺序不一致）。必须按 `toolCallId` 建表匹配，不能按位置配对，也不能按 `id`
 *      （`id` 是工具**类型**，实测与 `name` 同值）。
 *   🔴 `timestamp` 与 `task_finished.statistics.duration` 都是**纳秒**。当毫秒用会把
 *      26.58s 显示成 307 天。
 *   🔴 `stream_done.payload` 是 `null`（不是 `{}`）—— 不许无条件解引用 payload。
 * ────────────────────────────────────────────────────────────────────────────
 */

/** 已实证过的线格式版本。见 `messages[].version`。
 *
 *  不认识的版本**不静默继续**：会往面板打一条显眼的过程行（调用方能在日志里看到），
 *  但**仍然尽力解析**。为什么不直接抛：把用户这一轮的答案整段丢掉，比"版本可能变了"
 *  更坏 —— 而且版本号变化通常是加字段，旧字段照旧能解。两者取"大声 + 不丢答案"。 */
export const STAROPS_WIRE_VERSION = "v0.1.0";

/** 结果体里的失败标记。形状：`**Error**: exit code 5`（插在 `**Request ID**` 与
 *  `**Output**` 之间）。只认这一种 —— 认宽了会把答案里正常出现的 "Error" 当成失败。 */
const TOOL_ERROR_RE = /\*\*Error\*\*:\s*(.+)/;

/** 纳秒 → 毫秒。传进来的是**字符串**（19 位，超 Number.MAX_SAFE_INTEGER 的精度区间，
 *  但除以 1e6 之后落回安全范围，所以先转 Number 再除是可以的：
 *  1789219652666618780 / 1e6 = 1789219652666.6188，毫秒部分精确）。 */
export function nsToMs(ns) {
  const n = Number(ns);
  return Number.isFinite(n) ? n / 1e6 : 0;
}

/**
 * 从字节流缓冲里切出完整帧。
 *
 * ⚠️ 必须显式做这件事：SSE chunk 边界与帧边界**无关**，一个 chunk 可能是半行。
 * 返回 `rest` 让调用方把残行留到下一个 chunk 前面。
 *
 * @param {string} buf
 * @returns {{ lines: string[], rest: string }}
 */
export function splitFrames(buf) {
  const parts = String(buf ?? "").split("\n");
  const rest = parts.pop() ?? "";   // 最后一段没有换行结尾 → 可能是半行，留给下一轮
  return { lines: parts, rest };
}

/**
 * 单行 → 信封对象。非 `data:` 行（空行、`event:`、`:` 心跳注释）与解析失败都回 null。
 *
 * `/^data:\s?/` 而不是 `"data: "`：实测**没有空格**，但 SSE 规范允许有一个，
 * 两种都吃才不会因为服务端某天加了空格而整体失效。
 *
 * @returns {{messages: Array, requestId?: string, traceId?: string} | null}
 */
export function parseFrame(line) {
  const s = String(line ?? "").trim();
  if (!s || !/^data:/.test(s)) return null;
  const body = s.replace(/^data:\s?/, "").trim();
  if (!body || body === "[DONE]") return null;   // 未观测到 [DONE]，但这是 SSE 通用终止串
  let obj;
  try { obj = JSON.parse(body); } catch { return null; }   // 半帧/心跳 → 静默跳过
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.messages)) return null;
  return obj;
}

/**
 * 一条 `messages[]` 元素里可能出现的载荷数组 —— **互斥**，这就是解析器的判别式。
 *
 * ⚠️ `agents` 是官方 schema 里的第 5 个数组，我们**没有实测到过**它。本文件的第一版只列了
 *    前 4 个、`default` 直接 `break`，于是一旦服务端发来 `agents[]`（多数字员工协作场景）
 *    就是**一声不响地整帧丢掉**。收进判别式之后：认得出来、会警告、但**不当正文渲染** ——
 *    我们不知道它的字段形状，猜着渲染要么抖一坨 JSON 给用户，要么把答案说两遍。
 *    「知道有这么一帧、并说出来」是这条路上唯一诚实的做法。
 *    （`core/starops_sse.py::_PAYLOAD_KINDS` 是同一份，改这里就要改那边。）
 */
export const PAYLOAD_KINDS = ["contents", "events", "tools", "artifacts", "agents"];

/**
 * 判别一条 `messages[]` 元素的载荷类型（见 `PAYLOAD_KINDS`）。
 * @returns {"contents"|"events"|"tools"|"artifacts"|"agents"|null}
 */
export function payloadKind(msg) {
  for (const k of PAYLOAD_KINDS) {
    if (Array.isArray(msg?.[k]) && msg[k].length) return k;
  }
  return null;
}

/** 归一化后判"这段话是不是已经说过了"。用来挡 `artifacts` 的全文重发。
 *  与 `devops_chat.mjs::alreadySaid` 同一实现（那边没 export，见文件头说明）。
 *  只能按去空白比：增量与全量版本的换行/空格常有差异。 */
const norm = (s) => String(s ?? "").replace(/\s+/g, "");
export function alreadySaid(reply, text) {
  const a = norm(text), b = norm(reply);
  return a.length > 0 && b.includes(a);
}

/**
 * 把工具入参压成**一行人话**。
 *
 * ⚠️ 绝不把整坨 `arguments` JSON 抖进面板 —— 与 `devops_chat.mjs` 里
 *    「面板那行只放文字，不再把 ask_user 的整坨入参 JSON 抖给用户看」同一条规矩。
 *    面板是给人看进度的，不是给人读 JSON 的。
 *
 * 实测的三个工具各有自己的可读字段；未知工具**只报名字**，不猜它的入参含义。
 */
export function summarizeToolArgs(name, args) {
  const a = (args && typeof args === "object") ? args : {};
  const clip = (v, n = 160) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  };
  switch (String(name || "")) {
    case "Bash":      return clip(a.command);
    case "Read":      return clip(a.file_path || a.path || a.filePath);
    case "TodoWrite": {
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const cur = steps.find((s) => s?.status === "in_progress");
      // 只报"共几步 + 当前在做哪一步"。把 4 步全列出来会让面板每轮刷一屏。
      return cur ? `${steps.length} 步 · ${clip(cur.step, 80)}` : `${steps.length} 步`;
    }
    default:          return "";
  }
}

/**
 * 从工具结果体里抽出可读摘要 + 是否失败。
 *
 * `Bash` 的结果是固定结构的 markdown：
 *   `## Exec Result` → `**Request ID**: …` → （失败时 `**Error**: exit code N`）
 *   → `**Output**:` + 围栏代码块 → `Execution completed.`
 * 其余工具（`Read` 回 `"Read … (50 lines)"`）就是一行纯文本。
 *
 * @returns {{ text: string, failed: boolean, error: string }}
 */
export function summarizeToolResult(raw) {
  const s = String(raw ?? "");
  const err = s.match(TOOL_ERROR_RE);
  const failed = !!err;
  // 面板只要一行：优先报错误，其次报 Output 的首行，最后退回整体首行。
  let text;
  if (failed) {
    text = err[1].trim();
  } else {
    const out = s.match(/\*\*Output\*\*:\s*\n+```[^\n]*\n([\s\S]*?)(?:```|$)/);
    const first = (out ? out[1] : s).split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
    text = first.length > 200 ? first.slice(0, 200) + "…" : first;
  }
  return { text, failed, error: failed ? err[1].trim() : "" };
}

/**
 * 有状态的解析器。喂 chunk，往 sink 上写；`done` 为 true 表示收到 `stream_done`。
 *
 * @param {{ say:(t:string)=>void, step:(t:string, extra?:object)=>void,
 *           progress:(t:string)=>void, gap:()=>void, reply?:string }} sink
 * @param {{ en?: boolean, onWarn?: (msg: string) => void }} [opts]
 */
export function createStarOpsParser(sink, opts = {}) {
  const en = !!opts.en;
  const warn = typeof opts.onWarn === "function" ? opts.onWarn : () => {};

  let buf = "";
  /** 待匹配的工具调用：toolCallId → {name, args}。**必须按 id 匹配**（并行调用乱序）。 */
  const pending = new Map();
  /** 当前思考块的累积增量。按 `lastChunk` 收口成**一条**过程行 —— 一条一条发会让
   *  面板出现几百行三个字的碎片（reasoningDelta 的粒度非常细）。 */
  let thinking = "";
  /** 已见过的 `version` / 未知 `agents` 帧，各只警告一次，避免每帧刷一行。 */
  let versionWarned = false;
  let agentsWarned = false;

  const dv = (zh, en_) => (en ? en_ : zh);

  const state = {
    done: false,
    /** `task_finished` 报的墙钟（毫秒）。null = 还没收到。 */
    durationMs: null,
    /** `task_finished.success`。null = 还没收到。 */
    success: null,
    requestId: "",
    traceId: "",
    /** 用于挡全文副本：sink 自己也累积 reply，但 sink 是 duck-typed，不保证有这个字段。 */
    reply: "",
  };

  const say = (t) => { state.reply += t; sink.say(t); };

  function flushThinking() {
    const t = thinking.trim();
    thinking = "";
    if (!t) return;
    // 思考内容是英文（对外正文是中文）—— 原样进面板，不翻译：翻译要过模型，
    // 那就不是 0 token 了，而这条路存在的全部理由就是 0 token。
    sink.step(t.length > 600 ? t.slice(0, 600) + "…" : t, { kind: "thinking" });
  }

  function handleContents(msg) {
    for (const c of msg.contents) {
      const type = String(c?.type || "");
      const value = String(c?.value ?? "");
      if (type === "spin_text") {
        // 转场提示：只在正文还没开始时显示（sink.progress 自己也守着这一条）。
        if (value) sink.progress(value);
        continue;
      }
      if (type === "text") {
        // `lastChunk` 一律忽略 —— 它在一轮里出现多次，不是结束信号。
        if (value) say(value);
        continue;
      }
      // 未知 content 类型 → **当正文**（失败安全：宁可多显示，也不能把答案藏进面板）。
      // 与 devops_chat.mjs::blockKind 的兜底口径一致。
      if (value) {
        warn(`unknown content type: ${type}`);
        say(value);
      }
    }
  }

  function handleEvents(msg) {
    for (const e of msg.events) {
      const type = String(e?.type || "");
      const p = e?.payload;   // 🔴 可能是 null（stream_done）
      if (type === "thinking") {
        thinking += String(p?.reasoningDelta ?? "");
        if (p?.lastChunk) flushThinking();
        continue;
      }
      if (type === "task_finished") {
        flushThinking();
        state.durationMs = nsToMs(p?.statistics?.duration);
        state.success = p?.success !== false;
        continue;
      }
      if (type === "stream_done") {
        flushThinking();
        state.done = true;
        continue;
      }
      if (type === "thread_title_updated") {
        // STAROps 自己给会话生成标题。Web 端的会话标题由我们自己管（store.mjs），
        // 这一帧对前端没用 —— 但它**每轮都发**，不显式认掉就是每轮一条假告警
        // （2026-09-13 对真服务实测发现）。静默忽略，不是未知帧。
        continue;
      }
      warn(`unknown event type: ${type}`);
    }
  }

  function handleTools(msg) {
    for (const t of msg.tools) {
      // `id` 与 `name` 实测同值（都是 "Bash"）—— `id` 是工具**类型**不是唯一 id，
      // 唯一 id 是 `toolCallId`。别拿 `id` 当键。
      const name = String(t?.name || t?.id || "tool");
      const callId = String(t?.toolCallId || "");
      const status = String(t?.status || "");

      if (status === "start") {
        pending.set(callId, { name });
        const brief = summarizeToolArgs(name, t?.arguments);
        // 工具穿插在正文段落之间：不插空行会把前后两段粘成一段。
        sink.gap();
        sink.step(brief ? `${name}: ${brief}` : name, { kind: "tool", tool: name, toolCallId: callId });
        continue;
      }

      // 结果帧。按 callId 找回是哪次调用（乱序，不能按位置）。
      const known = pending.get(callId);
      pending.delete(callId);
      const toolName = known?.name || name;
      const body = Array.isArray(t?.contents)
        ? t.contents.map((c) => String(c?.value ?? "")).join("")
        : "";
      const { text, failed, error } = summarizeToolResult(body);
      // 🔴 这两句原来是中文硬编码 —— 英文界面下面板会中英混排（工具名英文、状态中文）。
      //    `en` 已经在这个闭包里，忘了用而已。`core/starops_sse.py::_dv` 是同一份口径。
      sink.step(
        failed
          ? dv(`${toolName} 失败: ${error}`, `${toolName} failed: ${error}`)
          : dv(`${toolName} → ${text || "完成"}`, `${toolName} → ${text || "done"}`),
        { kind: "tool_result", tool: toolName, toolCallId: callId, failed },
      );
    }
  }

  function handleArtifacts(msg) {
    for (const a of msg.artifacts) {
      const parts = Array.isArray(a?.parts) ? a.parts : [];
      const text = parts.map((p) => (p?.kind === "text" ? String(p?.text ?? "") : "")).join("");
      if (!text) continue;
      // 🔴 正常情况下这是**全文副本**，必须丢。
      if (alreadySaid(state.reply, text)) continue;
      // 但如果增量一条都没到（服务端只发了 artifact，或前面的帧丢了），它就是**唯一的答案** ——
      // 那时必须说出来。这一条不是防御性想象：`is_final` 的语义是"最终产物"，
      // 协议没有保证增量一定先到。宁可重复，也不能整轮空白。
      sink.gap();
      say(text);
    }
  }

  /**
   * `agents[]` —— 官方 schema 有、我们**没实测到过**的第 5 个数组。
   *
   * 见 `PAYLOAD_KINDS` 的 ⚠️：认得出来、说一句、但不猜字段形状去渲染正文。
   * 只警告一次（多数字员工协作场景下它可能每帧都来）。
   */
  function handleAgents(msg) {
    if (agentsWarned) return;
    agentsWarned = true;
    const names = (Array.isArray(msg.agents) ? msg.agents : [])
      .map((a) => String(a?.name || a?.digitalEmployeeName || "").trim())
      .filter(Boolean);
    const shown = en ? names.join(", ") : names.join("、");
    warn(`unhandled payload kind: agents (n=${(msg.agents || []).length})`);
    sink.step(
      dv(
        `这一轮出现了多数字员工协作帧（agents），NotiOps 尚未实测过它的内容格式，只如实报告收到${shown ? "：" + shown : ""}。`,
        `This turn contained a multi-agent frame (agents) whose format NotiOps has not verified; reporting its arrival only${shown ? ": " + shown : ""}.`,
      ),
      { kind: "warning" },
    );
  }

  return {
    state,

    /** 喂一段字节流。可以是半行。 */
    push(chunk) {
      buf += String(chunk ?? "");
      const { lines, rest } = splitFrames(buf);
      buf = rest;
      for (const line of lines) {
        const env = parseFrame(line);
        if (!env) continue;
        if (env.requestId) state.requestId = String(env.requestId);
        if (env.traceId) state.traceId = String(env.traceId);
        for (const msg of env.messages) {
          const v = String(msg?.version || "");
          if (v && v !== STAROPS_WIRE_VERSION && !versionWarned) {
            versionWarned = true;
            warn(`unexpected wire version: ${v} (verified ${STAROPS_WIRE_VERSION})`);
            sink.step(
              en
                ? `STAROps stream format is ${v}; NotiOps verified ${STAROPS_WIRE_VERSION}. Rendering best-effort.`
                : `STAROps 流格式为 ${v}，NotiOps 已验证的是 ${STAROPS_WIRE_VERSION}，按尽力解析处理。`,
              { kind: "warning" },
            );
          }
          switch (payloadKind(msg)) {
            case "contents":  handleContents(msg); break;
            case "events":    handleEvents(msg); break;
            case "tools":     handleTools(msg); break;
            case "artifacts": handleArtifacts(msg); break;
            case "agents":    handleAgents(msg); break;
            default: break;   // 五个数组都空 → 无载荷帧，跳过（未观测到，但不该崩）
          }
        }
      }
      return state;
    },

    /**
     * 流结束（连接关闭）。
     *
     * ⚠️ **没收到 `stream_done` 就是这一轮不完整**，而**我们这条路上**没有续传。
     * 调用方要据此给用户一句诚实的话，不许当成正常结束（不许静默降级）。
     * （官方 schema 里另有 `action:"reconnect"` 这条续传路径，我们**没有实现**也**没有实测**
     *  —— 说"协议不支持续传"是不对的，说"我们不支持"才对。抓到的那份流里没有序号字段，
     *  所以就算要自己接，可用的去重键也只有 `(callId, timestamp)`，纳秒时间戳会撞近似值。）
     * 这里只收口尚未 flush 的思考块，并把残留的 pending 工具报出来 ——
     * 「有 3 个工具发出去没回来」本身就是给用户的重要信号。
     */
    end() {
      flushThinking();
      if (pending.size) {
        const names = [...pending.values()].map((p) => p.name);
        sink.step(
          en
            ? `${pending.size} tool call(s) did not return before the stream closed: ${names.join(", ")}`
            : `流关闭时还有 ${pending.size} 个工具调用没有返回：${names.join("、")}`,
          { kind: "warning" },
        );
      }
      return state;
    },
  };
}
