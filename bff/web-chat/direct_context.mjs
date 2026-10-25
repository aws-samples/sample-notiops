/**
 * 「直连那几轮 agent 看不见」的补丁（待办 #33）。
 *
 * 网页上一个会话可能由三种引擎回答：NotiOps 的 agent、深度调查（直连）、DevOps 对话（直连）。
 * agent 的上下文只来自它自己写进 AgentCore Memory 的轮次；直连那几轮只进了 DynamoDB 的会话记录
 * （BFF 调 agent 时只发本轮的 prompt）。2026-10-21 现网实测：跑完一次深度调查，关掉开关说
 * 「针对上面的问题开一个案例」—— agent 恢复记忆 `Retrieved total of 0 events`，思考里写着
 * 「这是第一条用户消息，没有上面的问题的上下文」，回了一张**空白**建案卡。
 *
 * 这里只做一件事：从会话记录里挑出 agent **还没见过**的直连轮次，截好长度交给 agent
 * （`payload.direct_turns`；排版、防注入的措辞在 agent 侧 `direct_turns.py`）。
 * 「没见过」= **最近一次 agent 回答之后**的那些：更早的直连轮次已经随某一次注入写进了 agent 的
 * 记忆（注入块是那一轮 prompt 的一部分），再带一遍就是重复花 token。
 */

/** 上限都偏紧：这是"让 agent 知道上面发生了什么"，不是把整份报告再喂一遍 —— 完整结论
 *  agent 用 `escalate_to_support` 建案时会在服务端按 execution_id 重新取原文。 */
export const LIMITS = Object.freeze({ maxTurns: 3, maxQuestionChars: 500, maxAnswerChars: 3500, maxTotalChars: 8000 });

const INV_REF_RE = /\[\[\s*investigation\s*:\s*([A-Za-z0-9][A-Za-z0-9._-]{7,})\s*\]\]/i;
const DIRECT = new Set(["deep-direct", "devops-chat"]);

/**
 * 这条助手消息是哪个引擎答的：`agent` / `deep-direct` / `devops-chat` / `starops` / ""（不是助手消息）。
 * 落库的 `path` 还可能是 `echo`（没配 runtime）和 `busy`（会话忙，这一句没进 agent，待办 #30）——
 * 原样返回，两者都既不算直连轮次、也不算「agent 答过」。
 * 2026-10-23 起每条助手消息都落了 `path`，直接用；更早的消息靠 `via` 和正文里的调查编号推断 ——
 * 直连深度调查那几轮在故障调查主题里 `via` 是空的（对象不是 DevOps Agent），只能认正文里那串
 * `[[investigation:<taskId>]]`（`devops_investigate.mjs` 的开场横幅和结尾都会贴它）。
 */
export function engineOf(m) {
  if (!m || m.role !== "assistant") return "";
  if (m.path) return String(m.path);
  if (m.via === "starops") return "starops";
  if (INV_REF_RE.test(String(m.text || ""))) return "deep-direct";
  if (m.via === "devops-agent") return "devops-chat";
  return "agent";
}

const clipHead = (s, n) => (s.length > n ? s.slice(0, n) + " …" : s);
const clipTail = (s, n) => (s.length > n ? "… " + s.slice(s.length - n) : s);

/**
 * @param {Array<{role:string,text?:string,via?:string,path?:string,investigation?:object}>} messages
 *        会话记录，时间正序（`store.listMessages` 的 `messages`）。
 * @returns {Array|undefined} 交给 agent 的 `direct_turns`；没有就 undefined（payload 里整个省掉）。
 */
export function pickUnseenDirectTurns(messages, limits = LIMITS) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  // 本轮的用户消息已经先落库了（index.mjs 先 appendMessage(user) 再分流）—— 那是「这一句」，不是上文。
  if (list.length && list[list.length - 1]?.role === "user") list.pop();
  let lastAgent = -1;
  for (let i = 0; i < list.length; i++) if (engineOf(list[i]) === "agent") lastAgent = i;
  const out = [];
  for (let i = lastAgent + 1; i < list.length; i++) {
    const m = list[i];
    const engine = engineOf(m);
    if (!DIRECT.has(engine)) continue;
    let question = "";
    for (let j = i - 1; j > lastAgent; j--) {
      if (list[j]?.role === "user") { question = String(list[j].text || ""); break; }
      if (list[j]?.role === "assistant") break;
    }
    const text = String(m.text || "");
    const inv = m.investigation && typeof m.investigation === "object" ? m.investigation : null;
    const legacyTaskId = !inv && engine === "deep-direct" ? (INV_REF_RE.exec(text)?.[1] || "") : "";
    const investigation = inv
      ? { task_id: inv.task_id || undefined, execution_id: inv.execution_id || undefined }
      : (legacyTaskId ? { task_id: legacyTaskId } : undefined);
    out.push({
      engine,
      question: clipHead(question, limits.maxQuestionChars),
      // 深度调查的结论在正文**末尾**（开头是「🚀 深度调查已发起」横幅 + 原话），所以留尾；
      // DevOps 对话的答案开头就是正文，留头。
      answer: engine === "deep-direct" ? clipTail(text, limits.maxAnswerChars) : clipHead(text, limits.maxAnswerChars),
      investigation,
    });
  }
  let picked = out.slice(-limits.maxTurns);
  // 总长超了就从最旧的丢（最近那一轮最可能是用户这句话在接的），至少留一轮。
  while (picked.length > 1 && JSON.stringify(picked).length > limits.maxTotalChars) picked = picked.slice(1);
  return picked.length ? picked : undefined;
}
