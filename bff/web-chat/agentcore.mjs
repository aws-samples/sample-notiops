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
export function buildRuntimePayload({ prompt, model, generation, locale, webSearch, finopsAgent, devopsAgent, now, topic, accountId, allowedAccounts, skillId, skillVersion }) {
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
  };
}

/**
 * 调用 runtime，回调 onToken(text) / onSources(arr)。返回拼好的全文。
 * 解析失败不抛，尽量把能拿到的文本推出去。
 */
export async function invokeAgent({ conversationId, prompt, model, generation, locale, webSearch, finopsAgent, devopsAgent, topic, accountId, allowedAccounts, skillId, skillVersion }, { onToken, onSources, onActions, onUsage, onFollowups, onInvestigationStep, onProgress, onReasoning }) {
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
  let full = "";

  // resp.response 是一个异步可迭代的字节流（SDK v3 streaming）
  const body = resp.response;
  if (!body) return full;

  const decoder = new TextDecoder();
  let buf = "";

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
        const { text, sources, actions, usage, followups, investigationStep, progress, reasoning } = extract(evt);
        if (text) { full += text; onToken?.(text); }
        if (sources?.length) onSources?.(sources);
        if (actions?.length) onActions?.(actions);
        if (followups?.length) onFollowups?.(followups);
        if (investigationStep) onInvestigationStep?.(investigationStep);
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
  return full;
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

  // 思考过程增量（agent yield {"reasoning":{text}}）——前端可折叠灰字，收到正文即隐藏。
  const reasoning = (evt.reasoning && typeof evt.reasoning === "object") ? evt.reasoning : null;

  // 本轮 token 用量（agent 收尾 yield {"usage":{inputTokens,outputTokens,totalTokens}}）。
  const usage = evt.usage && typeof evt.usage === "object" ? evt.usage : undefined;

  return { text: typeof text === "string" ? text : "", sources, actions, usage, followups, investigationStep, progress, reasoning };
}
