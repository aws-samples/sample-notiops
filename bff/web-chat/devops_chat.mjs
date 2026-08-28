/**
 * 「DevOps 对话」/ Ask DevOps Agent —— 直连 DevOps Agent **控制面对话 API** 的问答路径。
 *
 * 与另两条「深度调查」的关系（三条互斥，前端单选）：
 *   深度调查        前端 devops_agent:true          → agent runtime（Strands + Bedrock，烧 token）
 *                                                    → investigate_live → CreateBacklogTask 调查
 *   深度调查（直连） 前端 deep_investigate_direct    → devops_investigate.mjs（CreateBacklogTask，0 token）
 *   本模块          前端 devops_chat_direct         → CreateChat + SendMessage（**客户自己的
 *                                                    DevOps Agent 额度**回答，NotiOps 侧 0 token）
 *
 * 为什么走控制面 API、而不是文档里的远端 MCP(`/mcp`) / A2A(`/a2a/*`)：那两条是给"外部模型"
 * 用的工具面 —— 一旦接上，回答重新由 Bedrock 模型生成，token 只会**更多**（老 investigate
 * 路径光是把 title/「完成了」翻译一下就实测烧掉 31,918 token）。控制面 CreateChat/SendMessage
 * 是 DevOps Agent **自己**在答，NotiOps 只当传输层，因此不需要模型、也不需要新密钥
 * （沿用 BFF Role / 跨账号 AssumeRole 的 SigV4）。
 *
 * 流式体验对齐"客户直接开 DevOps Agent 网页聊"（这是本功能的硬要求）：
 *   · 正文 textDelta **逐 delta 转发**，不缓冲、不等整块 —— 打字机效果与官方页面一致；
 *   · 工具调用 / 思考 / 子代理等非正文块 → `investigation_step`（右侧「调查过程」面板）
 *     + 正文还没开始时同步一条瞬态 `progress`，避免首答 5-30s 的空白等待；
 *   · jsonDelta（工具入参）只累积、**绝不**进气泡；
 *   · 未知类型的块按"正文"处理（失败安全：宁可多显示，也不能把答案藏进面板）。
 *
 * 2026-08-27 现网实测修正的三个显示 bug（形状实证见 KIND_BY_TYPE 上方注释）：
 *   1. 每轮答案说两遍 —— 服务端在 `text` 块之后还会用 `final_response` 块**整段重发**一次；
 *   2. 气泡尾巴多一句 "New Conversation Started" —— 那是 `chat_title` 元数据块，不是答案；
 *   3. 「本轮没有返回内容」 —— agent 用 `ask_user` 反问用户（`user_prompt` 块）时整轮没有
 *      `text` 块，问题与选项只在 JSON 里；现在会渲染成气泡里的一段人话 + 选项列表。
 *      顺带：面板那行只放**文字**，不再把 `ask_user` 的整坨入参 JSON 抖给用户看。
 *
 * SSE 事件与既有路径同形（token / progress / investigation_step / usage），故前端渲染、
 * 右侧面板全部零改动复用。usage 恒为 `{totalTokens:0, direct:true}` → 前端不显示 token 徽章；
 * DevOps Agent 侧的真实用量只落 CloudWatch（客户在自己的 DevOps Agent 账单里看）。
 */

import { getDevopsChatSession, setDevopsChatSession } from "./store.mjs";
// 复用「深度调查（直连）」里已经过现网验证的三个小工具（client 构造 / 后台链接 / 安全日志），
// 避免同一逻辑两份实现漂移。那边只是把它们加了 export，行为一行未改。
import { clientFor, operatorUrls, safeErr } from "./devops_investigate.mjs";

/** 单轮对话的最长等待。BFF Lambda 上限 900s（平台硬顶），保守取 840s，
 *  与「深度调查（直连）」同一口径。超时不算失败：已流出的正文照样落库，并提示去后台继续看。 */
const MAX_WAIT_SEC = (() => {
  const n = parseInt(process.env.NOTIOPS_DEVOPS_CHAT_MAX_WAIT_SEC ?? "", 10);
  return Number.isFinite(n) ? n : 840;
})();

/** 块类型判定。`contentBlockStart.type` 是**自由字符串**（服务端未给枚举），所以按"已实证类型表
 *  优先 + 模式兜底"分类。口径：**明确像过程**的才进面板，其余（含未标类型 / 未知类型）一律当正文
 *  —— 反过来会把答案藏进右侧面板，用户看到空气泡。
 *
 *  ⚠️ 下面这张表是 **2026-08-27 对现网 SendMessage 事件流做形状实证**得到的（此前只有推测，
 *  两个线上 bug 都出在这里）。实测同一轮回答里出现的块：
 *    · `text`           正文，逐 delta 流（唯一该进气泡的正文块）
 *    · `final_response` **整段答案的全量重复**，一个 delta 给完 —— 当正文处理 = 每轮答案说两遍
 *    · `chat_title`     会话标题（如 "New Conversation Started"）—— 当正文处理 = 答案尾巴多一句莫名的标题
 *    · `context_usage`  上下文水位 JSON，纯元数据
 *    · `tool_summary`   工具调用摘要 → 过程面板
 *    · `user_prompt`    **agent 反问用户**（`ask_user` 的 question + options）。整轮只有它时
 *                       （agent 直接抛选项让你选），旧口径下气泡一个字都没有 → 「本轮没有返回内容」。
 */
const KIND_BY_TYPE = new Map(Object.entries({
  text: "answer", answer: "answer", message: "answer", markdown: "answer",
  output: "answer", content: "answer", response: "answer",
  final_response: "final",
  chat_title: "meta",
  context_usage: "meta",
  tool_summary: "step",
  user_prompt: "prompt",
}));
const STEP_TYPE_RE = /tool|function|think|reason|plan|subagent|status|trace|progress|action|todo|citation|search|retriev/i;

/** @returns {"answer"|"final"|"meta"|"prompt"|"step"} */
function blockKind(type, parentId) {
  const t = String(type || "").trim();
  if (!t) return "answer";                          // 没标类型 → 当正文
  const known = KIND_BY_TYPE.get(t.toLowerCase());
  if (known) return known;                          // 实证类型优先（含 user_prompt 这种嵌在工具块里的）
  if (STEP_TYPE_RE.test(t)) return "step";
  return parentId ? "step" : "answer";              // 嵌套块（子代理内部动作）→ 过程；其余未知类型仍当正文
}

/** 归一化后判"这段话是不是已经说过了"。用于挡住 `final_response`（以及将来任何一次性重发
 *  全文的块）造成的整段重复：deltas 与全量版本的空白/换行常有差异，只能按归一化比。 */
const norm = (s) => String(s || "").replace(/\s+/g, "");
function alreadySaid(reply, text) {
  const a = norm(text), b = norm(reply);
  return a.length > 0 && b.includes(a);
}

/** 从块的 JSON 里抽出 agent 的反问。两种形状都吃：
 *    · `user_prompt` 块：`{question, options, interrupt_id}`
 *    · `tool_summary` 块的工具入参：`{type:"tool_call", name:"ask_user", input:{question, options}}`
 *  返回 null = 这块不是反问（正常情况，绝大多数工具调用都不是）。 */
export function parseAsk(raw) {
  const s = String(raw || "").trim();
  if (!s.startsWith("{")) return null;
  let q;
  try { q = JSON.parse(s); } catch { return null; }
  if (q?.input && typeof q.input === "object") {
    // 工具调用形状：只认 ask_user，别把随便哪个工具的入参当成"对用户说的话"。
    if (!/ask_?user/i.test(String(q?.name || ""))) return null;
    q = q.input;
  }
  const question = String(q?.question || "").trim();
  const options = Array.isArray(q?.options) ? q.options : [];
  if (!question && !options.length) return null;
  return { question, options };
}

/** 把 agent 的反问渲染成气泡里的一段人话。
 *  为什么必须进气泡：这是 agent **对你说的话**（"你想从哪方面开始?" + 4 个选项），
 *  丢掉它整轮就是空白（线上现象：「本轮没有返回内容」）。NotiOps 只做只读传输层 ——
 *  不代客户点选项，让他直接打字回复。 */
export function renderUserPrompt(raw, en = false) {
  const parsed = typeof raw === "string" ? parseAsk(raw) : raw;
  const question = String(parsed?.question || "").trim();
  const options = Array.isArray(parsed?.options) ? parsed.options : [];
  if (!question && !options.length) {
    // 解析失败：绝不把裸 JSON 倒进气泡，只给一句可操作的提示。
    return en
      ? "**DevOps Agent needs more input before it can continue.** Please reply with the details in the box below."
      : "**DevOps Agent 需要你补充信息才能继续。** 请直接在下面的输入框里回复。";
  }
  const lines = [];
  lines.push(en ? `**DevOps Agent asks:** ${question}` : `**DevOps Agent 想先确认：** ${question}`);
  if (options.length) {
    lines.push("");
    for (const o of options) {
      const label = String(o?.label || "").trim();
      if (!label) continue;
      const desc = String(o?.description || "").trim();
      const rec = o?.recommended ? (en ? " _(recommended)_" : " _（推荐）_") : "";
      lines.push(desc ? `- **${label}**${rec} —— ${desc}` : `- **${label}**${rec}`);
    }
    lines.push("");
    lines.push(en
      ? "_Reply with your choice in the box below and DevOps Agent will continue._"
      : "_把你的选择直接打在下面回我，DevOps Agent 就会接着做。_");
  }
  return lines.join("\n");
}

/** 过程行文案：把 `tool_use` / `thinking` 这类机器类型名转成人话。 */
function blockLabel(b, en) {
  const t = String(b?.type || "").trim();
  const pretty = t.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const nested = b?.parentId ? (en ? " (subagent)" : "（子代理）") : "";
  // 实测类型名直接给人话（`tool_summary` 拼进 "调用工具：tool summary" 是一句中英夹生的废话）。
  if (/^tool_summary$/i.test(t)) return (en ? "Tool call" : "调用工具") + nested;
  if (/tool|function/i.test(t)) return (en ? `Tool call: ${pretty}` : `调用工具：${pretty}`) + nested;
  if (/think|reason/i.test(t)) return (en ? `Thinking${nested}…` : `思考中${nested}…`);
  if (/plan|todo/i.test(t)) return (en ? `Planning${nested}…` : `制定计划${nested}…`);
  if (/user_prompt/i.test(t)) return en ? "Waiting for your choice" : "等待你的选择";
  if (/search|retriev/i.test(t)) return (en ? `Searching${nested}…` : `检索中${nested}…`);
  return (en ? `Step: ${pretty}` : `过程：${pretty}`) + nested;
}

/** 过程行的尾巴：单行、截断 —— 面板是逐行时间线，长文会把它撑爆。 */
function excerpt(s, max = 180) {
  const one = String(s || "").replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + "…" : one;
}

/** executionId 失效（会话过期/被清）时的错误名。只在**一个字都还没吐**时才重开新会话重试一次。 */
const STALE_RE = /ResourceNotFound|NotFound|Validation|Conflict|Expired|Gone|InvalidRequest/i;

/**
 * 输出通道：把一轮回答要写的三种东西（正文 / 过程行 / 瞬态进度）收在一处，并累积正文供落库。
 * 单独导出是为了让下面的 consumeEvents 能被**离线单测**（喂手写事件流，不连 AWS）。
 *
 * @param {{ emit: (event: string, data: object) => void }} p
 */
export function makeSink({ emit }) {
  const s = {
    reply: "",
    /** 正文：既流给前端，也累积进 reply 供落库。 */
    say(t) { s.reply += t; emit("token", { delta: t }); },
    /** 过程行 → 右侧「调查过程」面板。 */
    step(t, extra) { emit("investigation_step", { step: { text: t, ...(extra || {}) } }); },
    /** 瞬态进度行：**只在正文还没开始时**发（前端收到正文即清空），避免盖住答案。 */
    progress(t) { if (!s.reply) emit("progress", { text: t }); },
    /** 正文块之间插空行：工具调用穿插在段落之间时，不插会把两段粘成一段。 */
    gap() { if (s.reply && !/\n\n$/.test(s.reply)) s.say("\n\n"); },
  };
  return s;
}

/**
 * 消费 SendMessage 的事件流并实时转成 SSE。**本函数是这个功能的风险中心**，故独立可测：
 * 逐 delta 转发（不缓冲）、正文/过程分流、stop 的累积文本不许重复追加。
 *
 * @param {AsyncIterable} events   SendMessageResponse.events
 * @param {object} sink            makeSink() 的返回值
 * @param {{ en?: boolean, maxWaitSec?: number }} opts
 * @returns {Promise<{completed: boolean, failed: object|null, timedOut: boolean}>}
 */
export async function consumeEvents(events, sink, { en = false, maxWaitSec = MAX_WAIT_SEC } = {}) {
  const dv = (zh, enStr) => (en ? enStr : zh);
  const blocks = new Map();   // index -> { type, kind, buf, json, emittedAny, dup }
  // ⚠️ 文字与 JSON **分开存**：同一个块里两者都会来（实测 `tool_summary` = 一句人话
  // "Asking user: …?" + 一大坨 `{"type":"tool_call",…}` 入参）。混在一个 buf 里，面板那行
  // 就会把裸 JSON 抖给用户看（线上已出现）。
  const nb = () => ({ type: "", kind: "answer", buf: "", json: "", emittedAny: false, dup: false });
  const blockFor = (i) => {
    let b = blocks.get(i);
    // 没见过 start 就来 delta：按正文处理（失败安全，见文件头）。
    if (!b) { b = nb(); blocks.set(i, b); }
    return b;
  };

  // 已经在气泡里说过的反问（按问题正文归一化去重）：同一个 ask_user 会同时出现在
  // `tool_summary` 的入参和 `user_prompt` 块里，不去重就会问两遍。
  const askShown = new Set();
  /** 收尾兜底：流提前结束（responseCompleted / 超时）时，把还没 stop 的块里的反问补出来，
   *  否则那一轮气泡可能一个字都没有。 */
  const flushPendingAsks = () => {
    for (const b of blocks.values()) {
      if (b.kind !== "prompt" && b.kind !== "step") continue;
      const ask = parseAsk(b.json) || parseAsk(b.buf);
      if (!ask || askShown.has(norm(ask.question))) continue;
      askShown.add(norm(ask.question));
      sink.gap();
      sink.say(renderUserPrompt(ask, en));
    }
  };

  let completed = false, failed = null, timedOut = false;
  const t0 = Date.now();
  for await (const ev of events || []) {
    // 墙钟兜底：Lambda 被平台掐掉的话客户端只会看到截断，主动收尾至少能给一句出路。
    if (Date.now() - t0 > maxWaitSec * 1000) { timedOut = true; flushPendingAsks(); break; }
    if (ev.heartbeat) continue;                       // 保活帧（BFF 自己也每 10s 发 `: ka`）
    if (ev.responseCreated || ev.responseInProgress) {
      sink.progress(dv("DevOps Agent 正在思考…", "DevOps Agent is thinking…"));
      continue;
    }
    if (ev.summary) {
      const c = String(ev.summary.content || "").trim();
      if (c) { sink.step(excerpt(c, 400)); sink.progress(excerpt(c, 120)); }
      continue;
    }
    if (ev.contentBlockStart) {
      const b = ev.contentBlockStart;
      const kind = blockKind(b.type, b.parentId);
      const label = blockLabel(b, en);
      blocks.set(b.index, { ...nb(), type: b.type || "", kind });
      if (kind === "step" || kind === "prompt") { sink.step(label); sink.progress(label); }
      continue;
    }
    if (ev.contentBlockDelta) {
      const d = ev.contentBlockDelta;
      const b = blockFor(d.index);
      const td = d.delta?.textDelta?.text;
      const jd = d.delta?.jsonDelta?.partialJson;
      if (typeof td === "string" && td) {
        if (b.kind === "answer") {
          // 反重复兜底：某些块（已知 `final_response`，将来可能有别的）会把**整段答案**一次性
          // 重发一遍。首个 delta 就已经说过 → 整块丢弃，否则用户每轮看到同一段话两遍。
          if (!b.emittedAny && !b.dup && alreadySaid(sink.reply, td) && norm(td).length >= 12) b.dup = true;
          if (b.dup) { b.buf += td; continue; }
          if (!b.emittedAny) sink.gap();
          b.emittedAny = true;
          sink.say(td);                 // ★ 逐 delta 转发，不缓冲 —— 官方页面同款打字机效果
        } else {
          // 过程 / 元数据 / 反问块的文字：先收着（过程→面板、反问→stop 时渲染成人话、元数据→丢弃）
          b.buf += td;
        }
      } else if (typeof jd === "string" && jd) {
        b.json += jd;                   // 工具入参 / 反问选项 JSON：单独存，绝不裸进气泡或面板
      }
      continue;
    }
    if (ev.contentBlockStop) {
      const s = ev.contentBlockStop;
      const b = blocks.get(s.index);
      const kind = b?.kind || "answer";
      if (kind === "step" || kind === "prompt") {
        // 面板尾行：**只用文字**（b.buf），JSON 入参不外泄（线上曾把 ask_user 的整坨入参抖到面板）。
        const tail = excerpt(b.buf || (typeof s.text === "string" ? s.text : ""));
        if (tail) sink.step(`  ↳ ${tail}`);
        // agent 的反问 → 提到主气泡里说人话。两种块形状都可能带它，用问题正文去重，避免说两遍。
        const ask = parseAsk(b.json) || parseAsk(b.buf);
        if (ask && !askShown.has(norm(ask.question))) {
          askShown.add(norm(ask.question));
          sink.gap();
          sink.say(renderUserPrompt(ask, en));
        }
      } else if (kind === "meta") {
        /* chat_title / context_usage 等元数据：既不进气泡也不进面板 */
      } else if (kind === "final") {
        // 全量重复块：只在**一个字都还没吐**时才用它（此时它就是唯一的答案来源）。
        const full = (b.buf || (typeof s.text === "string" ? s.text : "")).trim();
        if (full && !alreadySaid(sink.reply, full)) { sink.gap(); sink.say(full); }
      } else if (b && !b.emittedAny && !b.dup && typeof s.text === "string" && s.text.trim()) {
        // 兜底：**只在一个 delta 都没收到**时才用 stop 的累积全文。
        // 已经流过 deltas 还追加 = 整段重复（stop.text 是累积值，不是增量）。
        sink.gap();
        sink.say(s.text);
      }
      blocks.delete(s.index);
      continue;
    }
    if (ev.responseCompleted) {
      const u = ev.responseCompleted.usage || {};
      // DevOps Agent 侧的用量（计客户自己的 DevOps Agent 额度，不是 NotiOps 的 Bedrock token）。
      console.log(`[devops-chat] completed devops_tokens=${u.totalTokens ?? u.outputTokens ?? "?"} (billed to the customer's DevOps Agent, not NotiOps)`);
      completed = true;
      flushPendingAsks();
      break;
    }
    if (ev.responseFailed) { failed = ev.responseFailed; break; }
  }
  return { completed, failed, timedOut };
}

/**
 * 「DevOps 对话」主流程。**NotiOps 侧 0 token**（不经 Bedrock / agent runtime）。
 *
 * @param {object} p
 * @param {string} p.text            用户原话
 * @param {string} p.locale          "zh" | "en"
 * @param {string} p.accountId       目标账号（空=部署账号自身）
 * @param {string} p.conversationId  会话 id（用来复用同一个 DevOps Agent executionId → 多轮上下文）
 * @param {string} [p.skillId]       本轮用 `/` 显式选中的 NotiOps Skill（空=没选）
 * @param {string} [p.skillVersion]  指定版本（缺省=latest）
 * @param {function} p.emit          (event, data) => void，写一条 SSE
 * @returns {Promise<string>}        落库用的 assistant 正文
 */
export async function runDevopsChat({ text, locale, accountId, conversationId, skillId, skillVersion, emit }) {
  const en = locale === "en";
  const dv = (zh, enStr) => (en ? enStr : zh);
  const sink = makeSink({ emit });
  const say = (s) => sink.say(s);
  const step = (t, extra) => sink.step(t, extra);
  const progress = (t) => sink.progress(t);
  // NotiOps 侧不烧 token —— 总是显式声明（前端对 totalTokens:0 不渲染 token 徽章）。
  const finishUsage = () => emit("usage", { usage: { totalTokens: 0, cycles: 0, direct: true } });

  // ── `/` 选中的 Skill：把正文内联进要发出去的那段话（见 devops_skill.mjs 的取舍说明）──
  // 这条路径上没有我们的模型可注入 system prompt，所以"让 skill 生效"只能靠内联。
  // 读失败**不静默**：气泡里明说这轮没用上哪个 skill，然后按普通提问继续 ——
  // 比整轮失败好，但绝不能让客户以为 skill 参与了回答。
  let content = String(text || "");
  if (skillId) {
    try {
      const { loadSkillForDirect, buildSkillContent, skillLabel } = await import("./devops_skill.mjs");
      const skill = await loadSkillForDirect({ skillId, skillVersion, locale });
      content = buildSkillContent({ text, skill, en, mode: "chat" });
      const label = skillLabel(skill) || skillId;
      step(dv(`本轮按 Skill「${label}」${skill.version ? ` v${skill.version}` : ""} 执行`,
              `Running this turn with the skill "${label}"${skill.version ? ` v${skill.version}` : ""}`));
    } catch (e) {
      console.warn("[devops-chat] skill_load_failed", skillId, safeErr(e));
      say(dv(`⚠️ 没能读到 Skill \`${skillId}\`（${safeErr(e)}），本轮按普通提问处理。\n\n`,
              `⚠️ Could not load the skill \`${skillId}\` (${safeErr(e)}); handling this turn as a plain question.\n\n`));
    }
  }

  // 真正开始对话之前已经写进气泡的内容（目前只可能是上面那句 skill 读失败提示）。
  const prelude = sink.reply;

  progress(dv("正在连接 DevOps Agent…", "Connecting to DevOps Agent…"));

  let client, target;
  try {
    ({ client, target } = await clientFor(accountId));
  } catch (e) {
    const code = e?.code === "bad_request" ? e.message : safeErr(e);
    console.warn("[devops-chat] resolve_target_failed", code);
    say(dv(
      `\n⚠️ 无法定位该账号的 DevOps Agent Agent Space（${code}）。请确认该账号已接入 DevOps Agent。\n`,
      `\n⚠️ Could not resolve the DevOps Agent Agent Space for this account (${code}). Please confirm the account is onboarded to DevOps Agent.\n`));
    finishUsage();
    return sink.reply;
  }
  const space = target.agentSpaceId;
  const home = operatorUrls(space).home;
  // 面板首行：连到哪个 Agent Space + 后台入口（console_url 会渲染成面板顶部链接）。
  // ⚠️ 只给 Operator App **首页**，不猜 /chat/{executionId} 之类深链（猜错就是死链）。
  step(dv(`已连接 Agent Space \`${space}\``, `Connected to Agent Space \`${space}\``),
       home ? { console_url: home } : undefined);

  // ── 多轮上下文：复用同一个 executionId ──
  // DevOps Agent 的对话历史挂在 executionId 上，所以"接着上一句问"必须复用它。
  // 只在 Agent Space 与目标账号都没变时才复用（切账号=切目标环境，必须开新会话）。
  const acct = String(accountId || "");
  let sess = null;
  try {
    sess = await getDevopsChatSession(conversationId);
  } catch (e) {
    console.warn("[devops-chat] load_session_failed", safeErr(e)); // 读不到就当新会话，不阻断
  }
  let executionId = (sess && sess.agentSpaceId === space && String(sess.accountId || "") === acct)
    ? String(sess.executionId || "") : "";
  const reused = !!executionId;

  const newChat = async () => {
    const { CreateChatCommand } = await import("@aws-sdk/client-devops-agent");
    // userId 已废弃（服务端从鉴权会话解析身份）→ 不传；userType 标明我们是 IAM 签名调用方。
    const r = await client.send(new CreateChatCommand({ agentSpaceId: space, userType: "IAM" }));
    const id = r?.executionId || "";
    if (!id) throw Object.assign(new Error("create_chat_no_execution_id"), { name: "InvalidResponse" });
    await setDevopsChatSession(conversationId, { executionId: id, agentSpaceId: space, accountId: acct })
      .catch((e) => console.warn("[devops-chat] save_session_failed", safeErr(e)));
    return id;
  };

  if (!executionId) {
    progress(dv("正在创建对话…", "Creating the chat…"));
    try {
      executionId = await newChat();
    } catch (e) {
      console.warn("[devops-chat] create_chat_failed", safeErr(e));
      say(dv(
        `\n⚠️ 创建 DevOps Agent 对话失败（${safeErr(e)}）。请稍后重试，或关闭「DevOps 对话」改用普通对话。\n`,
        `\n⚠️ Failed to create the DevOps Agent chat (${safeErr(e)}). Retry later, or turn off “DevOps Chat” to use the standard chat.\n`));
      finishUsage();
      return sink.reply;
    }
  }

  /** 发一轮消息并把事件流实时转成 SSE。返回 { completed, failed, timedOut }。 */
  const streamOnce = async (execId) => {
    const { SendMessageCommand } = await import("@aws-sdk/client-devops-agent");
    progress(dv("已发送，DevOps Agent 正在处理…", "Sent — DevOps Agent is working…"));
    const resp = await client.send(new SendMessageCommand({
      agentSpaceId: space, executionId: execId, content,
    }));
    return consumeEvents(resp?.events, sink, { en, maxWaitSec: MAX_WAIT_SEC });
  };

  let res;
  try {
    res = await streamOnce(executionId);
  } catch (e) {
    // 复用的 executionId 过期/失效 → 重开一个新对话重试一次（**仅在还没吐过正文时**，否则会重复输出）。
    // 与 `prelude` 比而不是 `!sink.reply`：skill 读失败那句 ⚠️ 提示也在 reply 里，
    // 拿它当"已经答过话了"会把这次重试白白吃掉。
    const stale = reused && sink.reply === prelude && STALE_RE.test(String(e?.name || ""));
    console.warn("[devops-chat] send_message_failed", safeErr(e), stale ? "stale_execution_retry" : "");
    if (!stale) {
      say(dv(
        `\n⚠️ 与 DevOps Agent 的对话中断（${safeErr(e)}）。请重试。\n`,
        `\n⚠️ The DevOps Agent conversation was interrupted (${safeErr(e)}). Please retry.\n`));
      finishUsage();
      return sink.reply;
    }
    step(dv("上一轮对话已过期，正在新建对话重试…", "The previous chat expired — starting a new one and retrying…"));
    try {
      executionId = await newChat();
      res = await streamOnce(executionId);
    } catch (e2) {
      console.warn("[devops-chat] send_message_retry_failed", safeErr(e2));
      say(dv(
        `\n⚠️ 与 DevOps Agent 的对话失败（${safeErr(e2)}）。请稍后重试。\n`,
        `\n⚠️ The DevOps Agent conversation failed (${safeErr(e2)}). Please retry later.\n`));
      finishUsage();
      return sink.reply;
    }
  }

  if (res.failed) {
    // 只展示错误**码**，不展示服务端原始 message（docs/LOGGING_STANDARD.md）。
    const code = String(res.failed.errorCode || "unknown");
    console.warn("[devops-chat] response_failed", `code=${code}`);
    say(dv(`\n\n⚠️ DevOps Agent 未能完成本次回答（${code}）。`, `\n\n⚠️ DevOps Agent could not complete this answer (${code}).`));
    if (home) say(dv(`可到后台查看详情：${home}\n`, ` See details in the console: ${home}\n`));
  } else if (res.timedOut) {
    say(dv(`\n\n⏳ 本轮等待超过 ${MAX_WAIT_SEC} 秒，先返回已生成的部分。`, `\n\n⏳ This turn exceeded ${MAX_WAIT_SEC}s, returning what was generated so far.`));
    if (home) say(dv(`完整对话可在 DevOps Agent 后台继续查看：${home}\n`, ` You can continue in the DevOps Agent console: ${home}\n`));
  } else if (!sink.reply) {
    say(dv("\n（DevOps Agent 本轮没有返回内容，请换个说法再试。）\n", "\n(DevOps Agent returned no content this turn — try rephrasing.)\n"));
  }

  // ── 待确认（暂停的工具调用）──
  // DevOps Agent 遇到需要人工批准的动作（多为写操作/变更）会挂起等确认。NotiOps 是**只读**界面，
  // 绝不代客户批准 —— 只如实告知并把人引到 DevOps Agent 控制台去做这个决定。
  if (res.completed) {
    try {
      const { ListPendingMessagesCommand } = await import("@aws-sdk/client-devops-agent");
      const r = await client.send(new ListPendingMessagesCommand({ agentSpaceId: space, executionId }));
      if ((r?.messages || []).length) {
        say(dv(
          `\n\n---\n\n⏸️ DevOps Agent 正在等待一次**人工确认**才能继续（通常是变更类动作）。NotiOps 是只读界面、不代你批准 —— 请到 DevOps Agent 控制台完成确认：${home || "DevOps Agent 控制台"}\n`,
          `\n\n---\n\n⏸️ DevOps Agent is waiting for a **human approval** before it can continue (usually a change action). NotiOps is read-only and will not approve on your behalf — complete the approval in the DevOps Agent console: ${home || "DevOps Agent console"}\n`));
      }
    } catch (e) {
      console.warn("[devops-chat] list_pending_failed", safeErr(e)); // 探测失败不影响答案
    }
  }

  finishUsage();
  return sink.reply;
}
