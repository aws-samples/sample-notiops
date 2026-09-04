/**
 * 调 AgentCore Runtime（Strands agent）并把其流式事件规范化。
 *
 * 用 AWS SDK v3 的 bedrock-agentcore 客户端 invoke_agent_runtime，
 * 传 runtimeSessionId（≥33 字符，由 conversationId 派生）+ JSON payload，
 * 拿到流式响应后逐块解析，转成 BFF 对前端的事件：token / sources / done。
 *
 * Strands 的 stream_async 事件形态多样（文本增量、tool 使用、最终消息）。
 * 这里做**宽容解析**：能提取到文本增量就当 token 推；带 sources 的结构提取出来。
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";

const RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN || "";
const client = new BedrockAgentCoreClient({});

export function agentRuntimeConfigured() {
  return Boolean(RUNTIME_ARN);
}

/** conversationId → 合法 runtimeSessionId（≥33 字符）。不足右侧补零。 */
export function toSessionId(conversationId) {
  let s = String(conversationId || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (s.length < 33) s = (s + "-0000000000000000000000000000000000").slice(0, 36);
  return s.slice(0, 256);
}

/**
 * 组装发往 runtime 的 payload。抽成纯函数便于断言字段契约（见 tests/agentcore.test.mjs）。
 *
 * generation：BFF 服务端读出的配置版本号（epoch-ms）。runtime 用它判断长驻 microVM 里的
 * 模型目录缓存是否过期 —— 与本地值不同就绕过 TTL 立即强刷，使 Admin 保存后**下一条消息**
 * 即生效。
 * BFF 读目录失败（generation=0）时**整个字段省掉**（JSON.stringify 丢弃 undefined），
 * 而不是传 0：runtime 侧 0 是合法值（未 seed 的目录就是 0），传 0 会让"与本地不同"恒真、
 * 每条消息都触发一次强制 ConsistentRead。省掉 → runtime 收到 None → 纯走 TTL 兜底。
 */
export function buildRuntimePayload({ prompt, model, generation, locale, webSearch, finopsAgent, devopsAgent, now, topic, accountId, allowedAccounts, skillId, skillVersion, warmup }) {
  const gen = Number(generation);
  return {
    prompt, model, locale,
    generation: Number.isFinite(gen) && gen > 0 ? gen : undefined,
    web_search: Boolean(webSearch),
    finops_agent: Boolean(finopsAgent),
    devops_agent: Boolean(devopsAgent),
    now,
    topic: topic || "general",
    account_id: accountId || "",
    allowed_accounts: allowedAccounts || "*",
    skill_id: skillId || "",
    skill_version: skillVersion || "",
    // 预热帧标记。只在真的预热时出现（JSON.stringify 丢弃 undefined）——
    // runtime 侧判据是 `payload.get("warmup") is True`，传 false 也不会误触发，
    // 但省掉能让"真实那一轮的 payload 一个字节都没变"这件事一眼可验。
    warmup: warmup ? true : undefined,
  };
}

/**
 * 会话预热（**0 token**）：让 runtime 提前做完平台冷启动 + import + 挂工具快照 +
 * 起 MCP 子进程，把这 ~10s 挪到"用户还在打字"的时候。
 *
 * ⚠️ `conversationId` 必须与随后真实那一轮**完全相同** —— runtimeSessionId 由它派生
 * （toSessionId），AgentCore 按 runtimeSessionId 路由到具体 microVM。传不同的 id 就是
 * 预热了另一个容器，10s 白花且真实那一轮照旧冷启动。
 * ⚠️ model/topic/accountId/devopsAgent 也要与真实那一轮一致：runtime 的 agent 缓存键
 * 含这四项，不一致会在真实那一轮再建一个 agent、白热一遍。
 *
 * 语义是"尽力而为"：任何失败都只 return false，绝不抛给调用方 —— 预热失败的唯一后果
 * 是首字回到原来的延迟。**必须 await 完**（不能发了就返回）：BFF 跑在 Lambda 上，
 * 响应一返回容器就冻结，未完成的请求会被掐断，等于没预热。
 */
export async function warmupAgent({ conversationId, model, generation, topic, accountId, devopsAgent }) {
  if (!RUNTIME_ARN) return false;
  try {
    const cmd = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: RUNTIME_ARN,
      runtimeSessionId: toSessionId(conversationId),
      contentType: "application/json",
      accept: "text/event-stream",
      payload: new TextEncoder().encode(JSON.stringify(buildRuntimePayload({
        prompt: "", model, generation, locale: "", topic, accountId, devopsAgent,
        now: new Date().toISOString().slice(0, 10), warmup: true,
      }))),
    });
    const resp = await client.send(cmd);
    // 必须把流读干：不读完连接就挂在那儿，容器侧的 generator 未必跑到 return。
    const body = resp.response;
    if (body && typeof body[Symbol.asyncIterator] === "function") {
      for await (const _ev of body) { /* 预热帧无正文，丢弃 */ }
    } else if (body && typeof body.transformToString === "function") {
      await body.transformToString();
    }
    return true;
  } catch (e) {
    // 只记类型/摘要（docs/LOGGING_STANDARD.md），不记 payload。
    console.error(`[BFF] warmup failed (harmless) — ${e?.name || ""}: ${e?.message || e}`);
    return false;
  }
}

/**
 * 调用 runtime，回调 onToken(text) / onSources(arr)。返回拼好的全文。
 * 解析失败不抛，尽量把能拿到的文本推出去。
 */
export async function invokeAgent({ conversationId, prompt, model, generation, locale, webSearch, finopsAgent, devopsAgent, topic, accountId, allowedAccounts, skillId, skillVersion }, { onToken, onSources, onActions, onUsage, onFollowups, onInvestigationStep, onThinkingStep, onProgress, onReasoning, onRuntimeError, onVia, onOpen, onReady }) {
  // 把"今天"传给 agent：用于联网搜索时给 query 补当前年份（让结果偏向最新），
  // 也让模型知道当前日期、不把训练截止当“现在”。
  const now = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const cmd = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: RUNTIME_ARN,
    runtimeSessionId: toSessionId(conversationId),
    contentType: "application/json",
    accept: "text/event-stream",
    payload: new TextEncoder().encode(JSON.stringify(buildRuntimePayload({
      prompt, model, generation, locale, webSearch, finopsAgent, devopsAgent, now,
      topic, accountId, allowedAccounts, skillId, skillVersion,
    }))),
  });

  const resp = await client.send(cmd);
  // 响应头已到达 → **平台侧的等待结束了**（冷容器要先拉起来才会回响应头，热容器这一步
  // 亚秒级）。等待期提示据此从"正在启动服务"切到"正在分析"，不再把每个慢轮次都说成
  // 冷启动（见 wait_hint.mjs 的模块注释）。回调自身出错不许影响正文。
  try { onOpen?.(); } catch { /* 提示用，忽略 */ }
  let full = "";

  // resp.response 是一个异步可迭代的字节流（SDK v3 streaming）
  const body = resp.response;
  if (!body) return full;

  const decoder = new TextDecoder();
  let buf = "";
  // runtime 侧异常帧（见下 extract 的 error 分支）。**先记下、流读完再处理** ——
  // 在 chunk 回调里抛会把 SDK 的迭代器撕开、丢掉后面已经在缓冲里的帧。
  let runtimeError = null;

  const handleChunk = (chunk) => {
    buf += decoder.decode(chunk, { stream: true });
    // 按 SSE 空行切分；runtime 以 `data: {...}` 行返回 Strands 事件
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        const m = /^data:\s*(.*)$/.exec(line);
        if (!m) continue;
        let evt;
        try { evt = JSON.parse(m[1]); } catch { evt = m[1]; }
        const { text, sources, actions, usage, followups, investigationStep, thinkingStep, progress, reasoning, error, via, ready } = extract(evt);
        if (error) runtimeError = error;
        // 容器里的 entrypoint 真的跑起来了（agent 的第一帧）。纯信号、不发给浏览器：
        // 只用来把等待期提示切到"模型在干活"那一组。比 onOpen 更硬（那只说明响应头回来了）。
        if (ready) { try { onReady?.(); } catch { /* 提示用，忽略 */ } }
        // via 必须在正文之前处理：agent 是先发 via 再发正文的，前端拿到 via 才能把这条
        // 消息的署名切成 NotiOps；顺序颠倒会先按模型署名渲染、再跳一下。
        if (via) onVia?.(via);
        if (text) { full += text; onToken?.(text); }
        if (sources?.length) onSources?.(sources);
        if (actions?.length) onActions?.(actions);
        if (followups?.length) onFollowups?.(followups);
        if (investigationStep) onInvestigationStep?.(investigationStep);
        // 思考/处理过程的**持久**一步（工具调用及其入参摘要、工具返回摘要）→ 右侧「思考过程」面板。
        // 与 progress 的区别：progress 是一行会被覆盖掉的瞬态状态，thinking_step 是一条时间线记录。
        if (thinkingStep) onThinkingStep?.(thinkingStep);
        // 处理中信号（长耗时时聊天窗口不再干等）：progress=一句"正在做什么"；reasoning=思考过程增量。
        if (progress) onProgress?.(progress);
        if (reasoning) onReasoning?.(reasoning);
        if (usage) onUsage?.(usage);
      }
    }
  };

  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const ev of body) {
      // SDK 可能给 {chunk:{bytes}} 或直接字节
      const bytes = ev?.chunk?.bytes || ev?.bytes || ev;
      if (bytes) handleChunk(bytes);
    }
  } else if (typeof body.transformToString === "function") {
    handleChunk(new TextEncoder().encode(await body.transformToString()));
  }

  // runtime 里抛了异常：AgentCore 的 _sync_stream_with_error_handling 会**发一帧**
  // `{"error":…, "error_type":…}` 然后正常结束流（HTTP 早已 200）。此前这帧被 extract
  // 无声丢弃 → invokeAgent 正常返回空串 → 调用方既没拿到文本也没拿到异常，前端只剩
  // 「（无响应）」（2026-08-25 现网事故：Grok 4.6 连续 InternalServerException）。
  // 现在：一个字都没吐 → 抛出带 name=错误类型的异常，让 /stream 走它的错误分支；
  // 已经吐过部分正文 → 不抛（避免调用方重试造成重复输出），只把错误交给回调。
  if (runtimeError) {
    onRuntimeError?.(runtimeError);
    if (!full) throw new AgentRuntimeStreamError(runtimeError.type, runtimeError.message);
  }
  return full;
}

/** runtime 流内异常（区别于 invoke 调用本身失败）。`name` = runtime 报的错误类型，
 *  好让 /stream 的 isColdStart / 文案分支按类型判断。 */
export class AgentRuntimeStreamError extends Error {
  constructor(type, message) {
    super(message || "agent runtime stream error");
    this.name = type || "AgentRuntimeStreamError";
    this.runtimeErrorType = type || "";
  }
}

/** 从 Strands 事件里宽容提取文本增量与 sources。
 *
 * runtime 实测事件形态（Bedrock converse-stream 风格，外层包一层 `event`）：
 *   {"event": {"messageStart": {...}}}
 *   {"event": {"contentBlockDelta": {"delta": {"text": "..."}, ...}}}   ← 文本增量
 *   {"event": {"contentBlockDelta": {"delta": {"toolUse": {...}}, ...}}} ← 工具入参增量（非文本，跳过）
 *   {"event": {"contentBlockStart": {"start": {"toolUse": {...}}}}}
 *   {"event": {"messageStop": {...}}} / {"event": {"metadata": {...}}}
 */
export function extract(evt) {
  // 字符串事件 = 「极少数实现直接发纯文本」的兜底。但它同时是 runtime 序列化失败的
  // **退化产物**：AgentCore 的 _safe_serialize_to_json_string 在 json.dumps 抛
  // TypeError（事件里有 bytes，如 Grok 的加密思考链 reasoningContent.redactedContent）时，
  // 兜底成 json.dumps(str(obj)) —— 于是整个事件的 Python repr 变成一个**合法 JSON
  // 字符串**发过来。把它当正文，用户回答里就会出现一坨
  // `{'event': {'contentBlockDelta': … b'rsn_…'}}`（实测事故）。
  // 判据：序列化出来的对象/字节 repr 一定以 { [ b' b" 开头，纯文本不会 → 只收后者。
  if (typeof evt === "string") {
    const s = evt.trimStart();
    const looksSerialised = /^[{[]/.test(s) || /^b['"]/.test(s);
    return { text: looksSerialised ? "" : evt, sources: [], actions: [] };
  }
  if (!evt || typeof evt !== "object") return { text: "", sources: [], actions: [] };

  // 先解开外层 `event` 包装（runtime 实际就是这层结构）
  const e = evt.event && typeof evt.event === "object" ? evt.event : evt;

  // 文本增量：contentBlockDelta.delta.text。注意 delta 里也可能是 toolUse（工具入参），
  // 那种不是给用户看的文本，必须排除（否则会把 JSON 入参混进回答）。
  let text = "";
  const delta = e.contentBlockDelta?.delta ?? e.delta;
  if (delta && typeof delta.text === "string") {
    text = delta.text;
  } else if (typeof e.data === "string") {
    text = e.data; // 兜底：极少数实现直接发 data 字符串
  } else if (typeof evt.data === "string") {
    text = evt.data;
  }

  // tool 结果里若带 sources（我们的 aws_docs_* tool 返回 {sources:[...]}）。
  // 注：当前 runtime 的 SSE 不外发工具结果，此分支多为预留/兼容。
  let sources = [];
  const tr = e.toolResult || evt.toolResult || evt.tool_result || evt.result;
  if (tr) {
    const payload = tr.sources || tr?.content?.sources;
    if (Array.isArray(payload)) sources = payload;
  }
  if (Array.isArray(evt.sources)) sources = evt.sources;

  // 待确认的写操作提议（agent 收尾 yield {"actions":[...]}）。
  const actions = Array.isArray(evt.actions) ? evt.actions : [];

  // 快捷后续按钮（agent yield {"followups":[{label,prompt}]}）——点击=向对话发这句 prompt。
  const followups = Array.isArray(evt.followups) ? evt.followups : [];

  // 调查**分析过程**行（agent yield {"investigation_step":{text,console_url?}}）——收进右侧「调查过程」面板。
  const investigationStep = (evt.investigation_step && typeof evt.investigation_step === "object")
    ? evt.investigation_step : null;

  // 处理中进度（agent yield {"progress":{text,kind}}）——主聊天里的临时状态行（工具调用等）。
  const progress = (evt.progress && typeof evt.progress === "object") ? evt.progress : null;

  // 思考/处理过程的一步（agent yield {"thinking_step":{text,kind?,detail?}}）——收进右侧
  // 「思考过程」面板。**持久**（不像 progress 被下一行覆盖），所以长任务结束后仍可回看。
  const thinkingStep = (evt.thinking_step && typeof evt.thinking_step === "object")
    ? evt.thinking_step : null;

  // agent entrypoint 的第一帧（agent yield {"ready":true}）：容器已就绪、代码已开始跑。
  // 不是内容、不发给浏览器 —— 只用于等待期提示的阶段切换（见 wait_hint.mjs）。
  const ready = evt.ready === true;

  // 思考过程增量（agent yield {"reasoning":{text}}）——前端可折叠灰字，收到正文即隐藏。
  const reasoning = (evt.reasoning && typeof evt.reasoning === "object") ? evt.reasoning : null;

  // 本轮 token 用量（agent 收尾 yield {"usage":{inputTokens,outputTokens,totalTokens}}）。
  const usage = evt.usage && typeof evt.usage === "object" ? evt.usage : undefined;

  // 答案来源标记（agent yield {"via":"builtin"}）：这一轮的回答**不是模型生成的**
  // （内置确定性答案，0 token）。前端署名行必须据此写 "NotiOps" 而不是
  // 「AWS Bedrock (某模型)」—— 沿用模型署名会把答案来源说错。
  const via = typeof evt.via === "string" && evt.via ? evt.via : undefined;

  // runtime 流内异常帧。形状由 AgentCore SDK 固定（bedrock_agentcore/runtime/app.py 的
  // `_sync_stream_with_error_handling`）：{error, error_type, message}。判据用
  // **error_type 存在**，而不是"有 error 字段"——后者太宽，工具返回里 `{"error": "..."}`
  // 一类的业务字段会被误判成 runtime 崩了。
  let error;
  if (typeof evt.error_type === "string" && evt.error_type) {
    error = { type: evt.error_type, message: typeof evt.error === "string" ? evt.error : "" };
  }

  return { text: typeof text === "string" ? text : "", sources, actions, usage, followups, investigationStep, thinkingStep, progress, reasoning, error, via, ready };
}
