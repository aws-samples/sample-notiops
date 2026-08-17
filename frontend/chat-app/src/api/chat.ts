/**
 * Web Chat 流式客户端。
 *
 * POST {chatApiBase}/stream（Lambda Function URL，response streaming），
 * 附带 Cognito idToken，逐 SSE 事件解析回调。事件类型：
 *   token | tool_call | tool_result | progress | sources | done | error
 *
 * Phase 0：BFF 先回 echo / 假 token 流，本客户端已能完整消费。
 */
import { fetchAuthSession } from "aws-amplify/auth";
import { AwsClient } from "aws4fetch";
import { getConfig } from "../config";

export interface SourceItem {
  icon?: string;
  title: string;
  detail?: string;
}

// 本轮 token 用量（agent 收尾发来；显示在消息署名行）
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cycles?: number; // 本轮 agentic loop 的 cycle 数（>1 说明做了多步工具调用/推理）
}

// 待用户确认的写操作（创建/回复/关闭 case）。create_case_form=可编辑建案卡(提交时转 create_case 执行)。
export interface ProposedAction {
  type: "create_case" | "create_case_form" | "create_case_review" | "add_communication" | "resolve_case";
  summary?: string;
  params?: Record<string, unknown>;
  account_id?: string;
}

/** 快捷后续按钮：点击=向对话发送 prompt；或 url=新标签打开（如"去 DevOps 后台生成缓解方案"）。 */
export interface Followup { label: string; prompt?: string; url?: string }

/** 调查分析过程的一步（收进右侧「调查过程」面板；console_url 仅首条带，用于面板顶部后台链接）。 */
export interface InvestigationStep { text: string; console_url?: string }

export interface StreamCallbacks {
  onToken?: (delta: string) => void;
  onToolCall?: (tool: string, args: unknown) => void;
  onToolResult?: (tool: string, summary: string) => void;
  onProgress?: (p: { text?: string; kind?: string; incident_id?: string; elapsed?: number; thinking?: string }) => void;
  // 思考过程增量（模型 reasoning）：随本轮语言，前端累积成可折叠灰字。
  onReasoning?: (r: { text?: string }) => void;
  onSources?: (sources: SourceItem[]) => void;
  onActions?: (actions: ProposedAction[]) => void;
  onFollowups?: (followups: Followup[]) => void;
  onInvestigationStep?: (step: InvestigationStep) => void;
  onUsage?: (usage: TokenUsage) => void;
  // 服务端把本轮模型换掉了（客户端点的那个已不在管理员启用集内）。
  // 静默替换会让用户以为自己还在用原来的模型，所以必须回传并纠正选择器。
  onModelSubstituted?: (info: { requested?: string; effective?: string; reason?: string }) => void;
  onDone?: (info: { message_id?: string }) => void;
  onError?: (message: string) => void;
}

/**
 * 发送一条消息并流式接收回复。
 *
 * 鉴权：Function URL 用 AWS_IAM，故请求需 SigV4 签名（用 Cognito Identity Pool
 * 换来的临时 AWS 凭证）。用户身份（idToken）放进**请求体**，因为 Authorization
 * 头已被 SigV4 占用；BFF 从 body 校验 idToken 拿 sub 做会话隔离。
 */
export async function streamChat(
  params: { conversationId?: string; text: string; model?: string; locale?: string; webSearch?: boolean; finopsAgent?: boolean; devopsAgent?: boolean; devopsAgentDirect?: boolean; topic?: string; accountId?: string; skillId?: string; skillVersion?: string },
  cb: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const cfg = getConfig();
  const base = cfg.chatApiBase.replace(/\/+$/, ""); // 去掉末尾 /

  // 拿临时 AWS 凭证 + idToken
  let creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined;
  let idToken = "";
  try {
    const session = await fetchAuthSession();
    idToken = session.tokens?.idToken?.toString() ?? "";
    const c = session.credentials;
    if (c) creds = { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken };
  } catch {
    /* 未登录：下面 SigV4 会失败 → onError */
  }
  if (!creds) {
    cb.onError?.("未获取到 AWS 临时凭证（请重新登录）");
    return;
  }

  const bodyStr = JSON.stringify({
    conversation_id: params.conversationId,
    text: params.text,
    model: params.model,
    locale: params.locale,
    web_search: params.webSearch === true,
    finops_agent: params.finopsAgent === true,
    devops_agent: params.devopsAgent === true,
    // 「深度调查（直连）」：BFF 直连 DevOps Agent API（0 token），与 devops_agent 互斥。
    deep_investigate_direct: params.devopsAgentDirect === true,
    topic: params.topic || "general",
    account_id: params.accountId || "",
    skill_id: params.skillId || "",
    skill_version: params.skillVersion || "",
  });

  // SigV4 签名（aws4fetch），service = lambda。用户身份放自定义头（被 SigV4 一并签名）。
  const aws = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    service: "lambda",
    region: cfg.region,
  });

  const resp = await aws.fetch(`${base}/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "x-notiops-id-token": idToken,
    },
    body: bodyStr,
    signal,
  });

  if (!resp.ok || !resp.body) {
    cb.onError?.(`请求失败 (${resp.status})`);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // 解析 SSE：以空行分隔的事件块，每块含 "event:" 与 "data:" 行
  const dispatch = (block: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let data: unknown = dataLines.join("\n");
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      // 非 JSON data，保留原始字符串
    }
    routeEvent(event, data, cb);
  };

  for (;;) {
    // 用户点"停止"：取消读取，抛 AbortError 让上层走停止分支（保留已生成内容）
    if (signal?.aborted) { try { await reader.cancel(); } catch { /* ignore */ } throw new DOMException("Aborted", "AbortError"); }
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (block.trim()) dispatch(block);
    }
  }
  if (buf.trim()) dispatch(buf);
}

/* ───────────────── 会话持久化 API（SigV4 签名的普通 JSON 请求）───────────────── */

export interface ConversationSummary { id: string; title: string; updatedAt: number; topic?: string; pinned?: boolean; }
export interface StoredMessage { role: "user" | "assistant"; text: string; ts: number; model?: string; sources?: SourceItem[]; usage?: TokenUsage; account_id?: string; }

/** 取 SigV4 客户端 + base + idToken（与 streamChat 同源）。未登录返回 null。 */
export async function signedClient() {
  const cfg = getConfig();
  const base = cfg.chatApiBase.replace(/\/+$/, "");
  try {
    const session = await fetchAuthSession();
    const idToken = session.tokens?.idToken?.toString() ?? "";
    const c = session.credentials;
    if (!c) return null;
    const aws = new AwsClient({
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
      service: "lambda",
      region: cfg.region,
    });
    return { aws, base, idToken };
  } catch {
    return null;
  }
}

/** 列出当前用户的所有会话（按 updatedAt 倒序，后端已排序）。 */
export async function listConversations(): Promise<ConversationSummary[]> {
  const s = await signedClient();
  if (!s) return [];
  try {
    const r = await s.aws.fetch(`${s.base}/conversations`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.conversations ?? []) as ConversationSummary[];
  } catch {
    return [];
  }
}

/** 取某会话的全部消息（按时间正序）。 */
export async function getMessages(conversationId: string): Promise<StoredMessage[]> {
  const s = await signedClient();
  if (!s) return [];
  try {
    const r = await s.aws.fetch(`${s.base}/conversations/${encodeURIComponent(conversationId)}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.messages ?? []) as StoredMessage[];
  } catch {
    return [];
  }
}

/** 删除会话（含全部消息）。 */
export async function deleteConversationApi(conversationId: string): Promise<void> {
  const s = await signedClient();
  if (!s) return;
  try {
    await s.aws.fetch(`${s.base}/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
      headers: { "x-notiops-id-token": s.idToken },
    });
  } catch { /* ignore */ }
}

export interface AccountInfo { accountId: string; accountName: string; ou?: string; }
export interface AccountsResult { accounts: AccountInfo[]; deployment: { accountId: string; accountName: string } }

/** 列出已注册账号（多账号选择器）+ 部署账号信息。失败/无 → 空。 */
export async function getAccountsFull(): Promise<AccountsResult> {
  const s = await signedClient();
  const empty = { accounts: [], deployment: { accountId: "", accountName: "Management account" } };
  if (!s) return empty;
  try {
    const r = await s.aws.fetch(`${s.base}/accounts`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return empty;
    const j = await r.json();
    return { accounts: (j.accounts ?? []) as AccountInfo[], deployment: j.deployment || empty.deployment };
  } catch { return empty; }
}

/** 兼容旧调用点：仅返回账号数组。 */
export async function getAccounts(): Promise<AccountInfo[]> {
  return (await getAccountsFull()).accounts;
}

export interface CasesSummary {
  ok: boolean;
  openCount?: number;
  totalCount?: number;
  latest?: { displayId: string; subject: string; severity: string; status: string } | null;
  bySeverity?: Record<string, number>;
}

/** 取 cases 摘要（L2 动态推荐 prompt 用）。失败/计划不足返回 {ok:false}。 */
export async function getCasesSummary(): Promise<CasesSummary> {
  const s = await signedClient();
  if (!s) return { ok: false };
  try {
    const r = await s.aws.fetch(`${s.base}/cases/summary`, { headers: { "x-notiops-id-token": s.idToken } });
    return await r.json();
  } catch {
    return { ok: false };
  }
}

/** 执行一个已被用户确认的写操作（创建/回复/关闭 case）。返回执行结果（含回查验证）。 */
export async function executeActionApi(action: ProposedAction): Promise<{ ok: boolean; verified?: boolean; status?: string; code?: string; message?: string; caseId?: string; displayId?: string }> {
  const s = await signedClient();
  if (!s) return { ok: false, message: "未登录" };
  try {
    const r = await s.aws.fetch(`${s.base}/actions/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-notiops-id-token": s.idToken },
      body: JSON.stringify({ action }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, message: (e as Error)?.message || "执行失败" };
  }
}

/** GET /models —— 管理员已启用的候选模型（登录即可读；不含 provider / 凭证 / 候选全集）。 */
export interface ServerModel {
  id: string;
  name: string;
  short?: string;
  desc_key?: string;
  /** 推理调用是否受 Admin 配的 Bedrock API Key 影响。现在恒为 true（Converse 与
   *  Mantle 两类端点都接受该 Key）。保留字段是为了兼容存量客户端 —— 曾经 Mantle
   *  是 false，那是我们没把 Key 传给 Mantle，不是端点不支持。 */
  uses_api_key?: boolean;
}
export async function fetchModels(surface = "webchat"): Promise<{
  models: ServerModel[]; default_model: string; generation: number; source: string;
} | null> {
  const s = await signedClient();
  if (!s) return null;
  try {
    const r = await s.aws.fetch(`${s.base}/models?surface=${encodeURIComponent(surface)}`,
                                { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) {
      // 一定要留痕。这个失败此前是完全静默的：下拉框继续显示**打包内置**的兜底清单，
      // 于是管理员在管理页把目录收敛到 1 个模型，用户侧却仍然看到 8 个 —— 界面上、
      // 控制台里、日志里都没有任何迹象（BFF 只记 5xx）。排查时无从下手。
      console.error(`[models] GET /models failed: HTTP ${r.status}`);
      return null;
    }
    const j = await r.json();
    if (!Array.isArray(j?.models)) {
      console.error("[models] GET /models returned an unexpected shape", j);
      return null;
    }
    return { models: j.models as ServerModel[],
             default_model: String(j.default_model || ""),
             generation: Number(j.generation || 0),
             // 服务端对"这份清单从哪来"的自述，前端据此分流（见 models.ts 的状态机）。
             // 老版本 BFF 不返回它 —— 缺省当 ddb 处理，行为与改动前一致。
             source: String(j.source || "ddb") };
  } catch (e) {
    // 返回 null 而不是 [] —— 调用方据此区分"管理员一个都没启用"（合法的空列表）
    // 与"这次没读到"（该继续用内置兜底目录，别把下拉框清空）。
    console.error("[models] GET /models threw", e);
    return null;
  }
}

/** 建案卡片的服务/类别下拉数据源（describe-services，BFF 缓存）。失败/计划不足 → []。 */
export interface SupportServiceCat { code: string; name: string }
export interface SupportService { code: string; name: string; categories: SupportServiceCat[] }
export async function getSupportServices(language = "en"): Promise<SupportService[]> {
  const s = await signedClient();
  if (!s) return [];
  try {
    const r = await s.aws.fetch(`${s.base}/support/services?language=${encodeURIComponent(language)}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.services ?? []) as SupportService[];
  } catch { return []; }
}

/** 重命名会话。 */
export async function renameConversationApi(conversationId: string, title: string): Promise<void> {
  const s = await signedClient();
  if (!s) return;
  try {
    await s.aws.fetch(`${s.base}/conversations/${encodeURIComponent(conversationId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-notiops-id-token": s.idToken },
      body: JSON.stringify({ title }),
    });
  } catch { /* ignore */ }
}

/** 置顶/取消置顶（持久化到后端，刷新后保留）。 */
export async function setPinnedApi(conversationId: string, pinned: boolean): Promise<void> {
  const s = await signedClient();
  if (!s) return;
  try {
    await s.aws.fetch(`${s.base}/conversations/${encodeURIComponent(conversationId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-notiops-id-token": s.idToken },
      body: JSON.stringify({ pinned }),
    });
  } catch { /* ignore */ }
}

function routeEvent(event: string, data: any, cb: StreamCallbacks) {
  switch (event) {
    case "token":
      cb.onToken?.(typeof data === "string" ? data : data?.delta ?? "");
      break;
    case "tool_call":
      cb.onToolCall?.(data?.tool, data?.args);
      break;
    case "tool_result":
      cb.onToolResult?.(data?.tool, data?.summary ?? "");
      break;
    case "progress":
      cb.onProgress?.(data ?? {});
      break;
    case "reasoning":
      cb.onReasoning?.(data ?? {});
      break;
    case "usage":
      if (data?.usage) cb.onUsage?.(data.usage);
      break;
    case "model_substituted":
      cb.onModelSubstituted?.(data ?? {});
      break;
    case "sources":
      cb.onSources?.(data?.sources ?? []);
      break;
    case "actions":
      cb.onActions?.(data?.actions ?? []);
      break;
    case "investigation_step":
      if (data?.step) cb.onInvestigationStep?.(data.step);
      break;
    case "followups":
      cb.onFollowups?.(data?.followups ?? []);
      break;
    case "done":
      cb.onDone?.(data ?? {});
      break;
    case "error":
      cb.onError?.(data?.message ?? "出错了");
      break;
    default:
      // message / 未知事件：当作 token 兜底
      if (typeof data === "string") cb.onToken?.(data);
  }
}
