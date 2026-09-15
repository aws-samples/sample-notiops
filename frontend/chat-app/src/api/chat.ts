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

/**
 * 思考/处理过程的一步（收进右侧「思考过程」面板）。与 InvestigationStep 的区别：那个是
 * DevOps Agent 深度调查专属的分析过程，这个是**任意长任务**都有的过程记录。
 *
 * kind 决定图标/样式：
 *   thought = 模型思考（reasoning 增量攒成的一段）；tool = 正在调工具；
 *   result  = 工具返回摘要；status = 其它状态行（含 BFF 的等待期提示，前端会滤掉）。
 * ts = 前端收到该步的时间（epoch ms），用于面板上显示相对耗时。
 */
export interface ThinkingStep {
  text: string;
  kind?: "thought" | "tool" | "result" | "status";
  detail?: string;
  ts?: number;
}

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
  // 思考/处理过程的一步（agent 侧的工具调用与返回摘要）→ 右侧「思考过程」面板。
  onThinkingStep?: (step: ThinkingStep) => void;
  onUsage?: (usage: TokenUsage) => void;
  // 答案来源标记（"builtin"：agent 的内置确定性回答，未调模型、0 token；"starops"：客户
  // 自己的阿里云数字员工）。收到即把该条消息的署名行从「AWS Bedrock (某模型)」换成对应
  // 来源，见 types.ts::ChatMessage.via。
  // 第二个参数只有 STAROps 那条路径会给：**这一轮**回答的数字员工 ID，页脚要显示它的值。
  onVia?: (via: string, staropsEmployee?: string) => void;
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
  params: { conversationId?: string; text: string; model?: string; locale?: string; webSearch?: boolean; finopsAgent?: boolean; devopsAgent?: boolean; devopsAgentDirect?: boolean; devopsChat?: boolean; starops?: boolean; topic?: string; accountId?: string; skillId?: string; skillVersion?: string },
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
    // 「DevOps 对话」：BFF 直连 DevOps Agent 控制面对话 API，由客户自己的 DevOps Agent 回答
    // （NotiOps 侧 0 token），与上面两个开关三方互斥。
    devops_chat_direct: params.devopsChat === true,
    // 「STAROps 对话」：BFF 直连**阿里云** STAROps 数字员工（CreateChat + SSE），由客户自己的
    // 数字员工回答（计他的阿里云 AI 额度，NotiOps 侧 0 token）。与上面三个**四方互斥**，
    // 且 BFF 侧 STAROps 优先（index.mjs 的一选一）。这里不做兜底纠正 —— 互斥由
    // convMode.ts 的枚举在类型层面保证，`fieldsOf` 出来的四个布尔恒定只有一个为真。
    starops_chat: params.starops === true,
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

// obj = 最后一轮的「对话对象」（"notiops" | "devops" | "starops"，老会话是空串）。
// 服务端唯一事实来源（store.mjs 的 touchConversation 每轮写）；侧栏 tag 只认它，
// **不要**改成本地推断 —— 本地那份 convMode 是 per-浏览器 的，换台机器就成了空。
export interface ConversationSummary { id: string; title: string; updatedAt: number; topic?: string; pinned?: boolean; obj?: string; }
export interface StoredMessage { role: "user" | "assistant"; text: string; ts: number; model?: string; sources?: SourceItem[]; usage?: TokenUsage; account_id?: string; via?: string; starops_employee?: string; }

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

/**
 * 会话预热（**0 token**，发即忘）。
 *
 * 首字延迟的大头不是模型，是 agent runtime 这个容器还没准备好（平台冷启动 + import +
 * 挂工具快照 + 起 MCP 子进程，实测 ~10s）。这段时间与"用户读完落地页、想好要问什么、
 * 把问题打出来"完全可以重叠 —— 所以进入对话时先发这么一发。
 *
 * ⚠️ `conversationId` 必须与随后真正发消息用的**同一个** —— runtimeSessionId 由它派生，
 * AgentCore 按 runtimeSessionId 路由到具体 microVM；换个 id 就是预热了另一个容器。
 * ⚠️ model/topic/accountId/devopsAgent 也要与真正那一轮一致：runtime 的 agent 缓存键
 * 含这四项，不一致会在真正那一轮再建一个 agent、白热一遍。
 *
 * 永不抛、永不影响 UI：预热失败的唯一后果是首字回到原来的延迟。
 */
export async function warmupChat(params: {
  conversationId: string; model?: string; topic?: string; accountId?: string; devopsAgent?: boolean;
}): Promise<void> {
  if (!params.conversationId) return;
  const s = await signedClient();
  if (!s) return;
  try {
    await s.aws.fetch(`${s.base}/warmup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-notiops-id-token": s.idToken },
      body: JSON.stringify({
        conversation_id: params.conversationId,
        model: params.model || "",
        topic: params.topic || "general",
        account_id: params.accountId || "",
        devops_agent: params.devopsAgent === true,
      }),
    });
  } catch { /* 预热失败无害，静默 */ }
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

/** 取某会话的消息（按时间正序）。
 *
 * `truncated` = 后端只回了最近 N 条、更早的没读（store.mjs 的 HISTORY_LIMIT）。
 * 必须一路带到界面上：一条长会话被截断时，用户看到的是"我早先问的那些不见了"，
 * 而界面上没有任何区别于"这个会话本来就这么短"的信号。所有失败路径都回
 * `truncated: false` —— 请求都没成功，声称"有更早的历史"是另一种撒谎。 */
export async function getMessages(conversationId: string): Promise<{ messages: StoredMessage[]; truncated: boolean; limit: number }> {
  const s = await signedClient();
  if (!s) return { messages: [], truncated: false, limit: 0 };
  try {
    const r = await s.aws.fetch(`${s.base}/conversations/${encodeURIComponent(conversationId)}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { messages: [], truncated: false, limit: 0 };
    const j = await r.json();
    return { messages: (j.messages ?? []) as StoredMessage[], truncated: !!j.truncated, limit: Number(j.limit) || 0 };
  } catch {
    return { messages: [], truncated: false, limit: 0 };
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
export async function executeActionApi(action: ProposedAction): Promise<{ ok: boolean; verified?: boolean; status?: string; code?: string; message?: string; caseId?: string; displayId?: string; duplicate?: boolean }> {
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

/**
 * 建案卡片的服务/类别下拉数据源（describe-services，BFF 缓存）。
 *
 * 拿不到目录时**必须区分原因**：`unavailable === "support_plan_required"` 意味着这个账号
 * 根本开不了 case（Basic/Developer 计划），卡片要当场提醒；而不是显示成"没匹配到服务"，
 * 让客户把整张表填完、点了确认才吃一个报错。其他原因（网络/权限/BFF 异常）只当"这次没读到"。
 */
export interface SupportServiceCat { code: string; name: string }
export interface SupportService { code: string; name: string; categories: SupportServiceCat[] }
export interface SupportServicesResult { services: SupportService[]; unavailable?: string }
export async function getSupportServices(language = "en"): Promise<SupportServicesResult> {
  const s = await signedClient();
  if (!s) return { services: [] };
  try {
    const r = await s.aws.fetch(`${s.base}/support/services?language=${encodeURIComponent(language)}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { services: [] };
    const j = await r.json();
    // BFF 用 200 + {ok:false, code} 表达"能问但答不了"（见 support.mjs 的 wrapErr）。
    if (j?.ok === false) return { services: [], unavailable: String(j.code || "support_error") };
    return { services: (j.services ?? []) as SupportService[] };
  } catch { return { services: [] }; }
}

/**
 * 「深度调查」两个开关能不能点：这个部署/这个账号有没有可用的 DevOps Agent Agent Space。
 *
 * 拿不到答案时**当可用**（返回 available:true）—— 宁可让用户点进去看到真实报错，也不要因为
 * 一次网络抖动或老版本 BFF（没有这个路由 → 404）把功能藏起来。BFF 侧同样对"探测不确定"
 * 放行（见 devops_investigate.mjs 的 deepInvestigationAvailability）。
 */
export interface DeepInvestigationAvailability { available: boolean; reason?: string }
export async function getDeepInvestigationAvailability(accountId = ""): Promise<DeepInvestigationAvailability> {
  const s = await signedClient();
  if (!s) return { available: true };
  try {
    const qs = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
    const r = await s.aws.fetch(`${s.base}/features/deep-investigation${qs}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { available: true };
    const j = await r.json();
    return { available: j?.available !== false, reason: j?.reason ? String(j.reason) : undefined };
  } catch { return { available: true }; }
}

/**
 * 「对话对象」里的 **STAROps** 能不能选：管理员填过阿里云 AK 与数字员工名了吗。
 *
 * **不与上面那条合并**：那条查的是 AWS DevOps Agent 的 Agent Space 接入，与阿里云配置
 * 毫无关系。合成一条的后果是任一朵云没配就把两个对话对象都藏掉。
 *
 * 与上面同一个取舍：拿不到答案（网络抖动 / 老版本 BFF 没这条路由 → 404）时**当可用**，
 * 让用户点进去看到 BFF 那句更具体的真实报错，而不是入口凭空消失。
 *
 * ⚠️ `reason` 是**机器码**（no_credentials / no_employee / bad_employee / bad_region /
 *    bad_workspace / bad_project），由前端映射成"缺哪一项、去哪儿填"的话术 ——
 *    不要直接把它渲染给用户。BFF 保证这条响应里没有凭据、也没有 workspace
 *    （那个值嵌着阿里云账号 UID）。
 */
export interface StarOpsAvailability { available: boolean; reason?: string; employee?: string; region?: string }
export async function getStarOpsAvailability(): Promise<StarOpsAvailability> {
  const s = await signedClient();
  if (!s) return { available: true };
  try {
    // 没有 `?account=` —— STAROps 是**阿里云侧**的数字员工，与当前选的 AWS 账号无关。
    const r = await s.aws.fetch(`${s.base}/features/starops`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { available: true };
    const j = await r.json();
    return {
      available: j?.available !== false,
      reason: j?.reason ? String(j.reason) : undefined,
      employee: j?.employee ? String(j.employee) : undefined,
      region: j?.region ? String(j.region) : undefined,
    };
  } catch { return { available: true }; }
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
    case "via":
      if (data?.via) cb.onVia?.(String(data.via), data?.employee ? String(data.employee) : undefined);
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
    case "thinking_step":
      if (data?.step) cb.onThinkingStep?.(data.step);
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
