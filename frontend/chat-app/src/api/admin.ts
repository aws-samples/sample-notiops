/**
 * Admin API 客户端（角色 / 用户 / 模块 / 全量能力清单）。
 * 所有请求经 signedClient（SigV4 + idToken）；后端 authz 要求 nav:admin。
 */
import { signedClient } from "./chat";

export interface FullCapabilityNode {
  key: string;
  level: "tab" | "subtab" | "dashboard" | "action" | "group";
  parent: string | null;
  title_zh?: string;
  title_en?: string;
  alwaysOn?: boolean;
  adminOnly?: boolean;
  responseKey?: string | string[];
}
export interface RoleRec { name: string; permissions: string[]; preset?: boolean }
export interface UserRec { username: string; sub: string; enabled?: boolean; status?: string; roles: string[]; denies: string[] }
export interface ModuleToggle { key: string; title_zh?: string; title_en?: string; disabled: boolean }

async function req<T>(method: string, pathSuffix: string, body?: unknown): Promise<T> {
  const s = await signedClient();
  if (!s) throw new Error("not_authenticated");
  const r = await s.aws.fetch(`${s.base}${pathSuffix}`, {
    method,
    headers: { "x-notiops-id-token": s.idToken, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // 服务端的拒绝原因可能落在 `error` 或 `message`：BFF 各路由历史上两种都用过
    // （`/admin/llm-config` 就把 `error` 重命名成 `message` 才回给前端）。只读一个字段的
    // 后果是原因被静默丢掉、界面只剩 `http_400`，管理员无从知道哪条不变量没满足。
    // 两个都读，另外带上服务端可能给出的结构化细节（如非法权限键列表）。
    const rec = (j && typeof j === "object" ? j : {}) as Record<string, unknown>;
    const reason = (rec.error as string) || (rec.message as string) || "";
    const keys = Array.isArray(rec.keys) ? ` (${(rec.keys as string[]).join(", ")})` : "";
    const hint = rec.hint ? ` — ${String(rec.hint)}` : "";
    throw new Error(reason ? `${reason}${keys}${hint}` : `http_${r.status}`);
  }
  return j as T;
}

export async function fetchAllCapabilities(): Promise<FullCapabilityNode[]> {
  return (await req<{ nodes: FullCapabilityNode[] }>("GET", "/admin/capabilities")).nodes || [];
}
export async function fetchRoles(): Promise<RoleRec[]> {
  return (await req<{ roles: RoleRec[] }>("GET", "/admin/roles")).roles || [];
}
export async function saveRole(name: string, permissions: string[]): Promise<RoleRec> {
  return req<RoleRec>("POST", "/admin/roles", { name, permissions });
}
export async function deleteRole(name: string): Promise<{ ok: boolean }> {
  return req<{ ok: boolean }>("DELETE", `/admin/roles/${encodeURIComponent(name)}`);
}
export async function fetchUsers(): Promise<UserRec[]> {
  return (await req<{ users: UserRec[] }>("GET", "/admin/users")).users || [];
}
export async function createUser(username: string, email?: string): Promise<{ username: string; email: string; tempPassword: string }> {
  return req("POST", "/admin/users", { username, email: email || "" });
}
export async function deleteUser(username: string, sub: string): Promise<{ ok: boolean }> {
  return req("DELETE", `/admin/users/${encodeURIComponent(username)}?sub=${encodeURIComponent(sub)}`);
}
export async function putUser(sub: string, roles: string[], denies: string[]): Promise<UserRec> {
  return req<UserRec>("PUT", `/admin/users/${encodeURIComponent(sub)}`, { roles, denies });
}
export async function fetchModules(): Promise<{ disabled: string[]; toggleable: ModuleToggle[] }> {
  return req<{ disabled: string[]; toggleable: ModuleToggle[] }>("GET", "/admin/modules");
}
export async function putModules(disabled: string[]): Promise<{ disabled: string[] }> {
  return req<{ disabled: string[] }>("PUT", "/admin/modules", { disabled });
}

export type EolMap = Record<string, Record<string, string>>;
export async function fetchEol(): Promise<{ overrides: EolMap; table: EolMap & { asOf?: string } }> {
  return req<{ overrides: EolMap; table: EolMap & { asOf?: string } }>("GET", "/admin/eol");
}
export async function putEol(overrides: EolMap): Promise<{ overrides: EolMap }> {
  return req<{ overrides: EolMap }>("PUT", "/admin/eol", { overrides });
}

export interface GroupRec { name: string; description?: string; roles: string[] }
export async function fetchGroups(): Promise<GroupRec[]> {
  return (await req<{ groups: GroupRec[] }>("GET", "/admin/groups")).groups || [];
}
export async function putGroupMap(name: string, roles: string[]): Promise<GroupRec> {
  return req("PUT", `/admin/groups/${encodeURIComponent(name)}`, { roles });
}
export async function createGroup(name: string, description?: string): Promise<{ name: string }> {
  return req("POST", "/admin/groups", { name, description: description || "" });
}
export async function deleteGroup(name: string): Promise<{ ok: boolean }> {
  return req("DELETE", `/admin/groups/${encodeURIComponent(name)}`);
}
export async function fetchGroupMembers(name: string): Promise<string[]> {
  return (await req<{ members: string[] }>("GET", `/admin/groups/${encodeURIComponent(name)}/members`)).members || [];
}
export async function addUserToGroup(group: string, username: string): Promise<{ ok: boolean }> {
  return req("POST", `/admin/groups/${encodeURIComponent(group)}/members`, { username });
}
export async function removeUserFromGroup(group: string, username: string): Promise<{ ok: boolean }> {
  return req("DELETE", `/admin/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(username)}`);
}

// ── 成员账号一键接入（Organizations + StackSets；org 模式部署时可用）──
export interface MemberAccountRec {
  accountId: string; name: string; email: string;
  onboarded: boolean; enabled: boolean; orgOnboardStatus: string; regions: string[];
  /** 第二步（DevOps Agent 关联）状态：'' | pending | template_generated | payload_saved | tested | enabled */
  devopsAgentStatus?: string;
}
export async function fetchMemberAccounts(): Promise<MemberAccountRec[]> {
  return (await req<{ items: MemberAccountRec[] }>("GET", "/admin/member-accounts")).items || [];
}
export async function onboardMemberAccount(accountId: string, regions: string[]): Promise<{ operationId: string; accountId: string }> {
  return req("POST", "/admin/member-accounts", { accountId, regions });
}
export async function memberOnboardStatus(operationId: string, accountId: string): Promise<{ status: string }> {
  return req("GET", `/admin/member-accounts/status/${encodeURIComponent(operationId)}?account_id=${encodeURIComponent(accountId)}`);
}
export async function setMemberAccountEnabled(accountId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  return req("POST", `/admin/member-accounts/${encodeURIComponent(accountId)}/${enabled ? "enable" : "disable"}`);
}
export async function offboardMemberAccount(accountId: string): Promise<{ operationId: string; status: string }> {
  return req("DELETE", `/admin/member-accounts/${encodeURIComponent(accountId)}`);
}
export async function associateDevopsAgent(accountId: string): Promise<{ operationId: string }> {
  return req("POST", `/admin/member-accounts/${encodeURIComponent(accountId)}/devops-agent`);
}
export async function devopsAgentAssocStatus(operationId: string, accountId: string): Promise<{ status: string }> {
  return req("GET", `/admin/member-accounts/da-status/${encodeURIComponent(operationId)}?account_id=${encodeURIComponent(accountId)}`);
}

// ── 成员账号可见性（user/group → 可见账号；未配置 = 全部可见）──
export interface AccountVisibilityRec { kind: "user" | "group"; id: string; accounts: string[] | null }
export async function fetchAccountAccess(): Promise<AccountVisibilityRec[]> {
  return (await req<{ items: AccountVisibilityRec[] }>("GET", "/admin/account-access")).items || [];
}
export async function putAccountAccess(kind: "user" | "group", id: string, accounts: string[]): Promise<AccountVisibilityRec> {
  return req("PUT", `/admin/account-access/${kind}/${encodeURIComponent(id)}`, { accounts });
}
export async function deleteAccountAccess(kind: "user" | "group", id: string): Promise<{ ok: boolean }> {
  return req("DELETE", `/admin/account-access/${kind}/${encodeURIComponent(id)}`);
}

// ── 飞书机器人通知配置（Admin「通知」板块;存 Secrets Manager,与老管理前端解耦）──
export interface FeishuConfig { app_id: string; app_secret: string; verification_token?: string; encrypt_key?: string; notify_chat_ids: string }
export async function fetchNotificationConfig(): Promise<{ feishu: FeishuConfig }> {
  return req("GET", "/admin/notification-config");
}
export async function putNotificationConfig(config: Partial<FeishuConfig>): Promise<{ message: string }> {
  return req("PUT", "/admin/notification-config", { platform: "feishu", config });
}
export async function testNotificationSend(chatId: string): Promise<{ success: boolean; message: string }> {
  return req("POST", "/admin/notification-config/test", { platform: "feishu", chat_id: chatId });
}

// ── 跨 Payer 接入(组织外账号:Launch Stack + 手工回填 + 测试连接)──
export async function generateLaunchStack(accountId: string): Promise<{ launchStackUrl: string; templateUrl: string; expiresHours: number }> {
  return req("POST", `/admin/member-accounts/${encodeURIComponent(accountId)}/launch-stack`);
}
export async function saveManualPayload(accountId: string, payload: { agent_space_id: string; trigger_role_arn: string }): Promise<{ status: string; message: string }> {
  return req("PUT", `/admin/member-accounts/${encodeURIComponent(accountId)}/payload`, payload);
}
export async function testDaConnection(accountId: string): Promise<{ success: boolean; step?: string; error?: string; agentSpaceId?: string }> {
  return req("POST", `/admin/member-accounts/${encodeURIComponent(accountId)}/test-connection`);
}

// ── LLM 模型目录与凭证（DDB llmcfg + Secrets Manager；spec: llm-provider-and-model-management）──
// 真源在 DynamoDB，管理员在这里勾选启用集；普通用户经 GET /models 只读到启用集。
export type ModelKind = "bedrock_anthropic" | "bedrock_converse" | "bedrock_mantle_responses";
export type ModelSurface = "webchat" | "im";

export interface LlmModelEntry {
  alias: string;
  short?: string | null;
  aliases_legacy?: string[];
  model_id: string;
  model_id_override?: Record<string, string> | null;
  label: string;
  desc_key?: string;
  kind: ModelKind;
  region?: string | null;
  hard_output_limit: number;
  output_override?: Record<string, number> | null;
  supports_prompt_cache: boolean;
  surfaces: ModelSurface[];
  enabled: boolean;
}

/** Key 状态。**永不含明文**，只有脱敏元数据（spec R5.5）。 */
export interface BedrockKeyStatus {
  configured: boolean;
  last_4?: string;
  length?: number;
  /** 当前 Key 被写入的时间（Secret 当前版本的创建时间，非 Secret 本身的创建时间）。 */
  set_at?: string;
  /** 谁设的（R5.6）。Key 是共享凭证，出问题时「谁换过它」是第一个要问的。 */
  set_by?: string;
  age_days?: number;
  /** 是否已超轮换期。**判定在服务端算**，前端不重算，避免两边漂移。 */
  rotation_due?: boolean;
  rotation_days?: number;
  error?: string;
}

export interface LlmConfig {
  provider: string;
  credential_mode: "iam" | "api_key";
  default_model: string;
  generation: number;
  models: LlmModelEntry[];
  backend_tasks: Record<string, string | null>;
  bedrock_api_key: BedrockKeyStatus;
  seeded: boolean;
  updated_at: string;
  updated_by: string;
}

/** 候选全集条目（ListFoundationModels + Mantle 型号表）。 */
export interface LlmCandidate {
  model_id: string;
  label: string;
  provider_name?: string;
  kind: ModelKind;
  source: string;
  regions?: string[];
  /** 新增该 Mantle 条目时应采用的默认区域，由服务端下发（BFF `MANTLE_REGION_DEFAULT`）。
   *  **别用 `regions[0]` 代替**：那个名单按区域名排序，扩容时谁排第一会变 —— 名单从 2 个区
   *  扩到 14 个区后就把默认区从 us-east-2 静默变成了 us-east-1。 */
  default_region?: string;
  /** 路由范围：`global`/`apac`/`jp`/`us`/`eu` 为跨区域 inference profile，
   *  `regional` 为本区域基座模型，`mantle` 为 Bedrock Mantle 端点。
   *  选模型时必须可见 —— 它决定推理请求落到哪些区域（数据驻留）。 */
  scope?: string;
  /** inference profile 指向的基座模型 id（仅 profile 有）。 */
  routes_to?: string | null;
}

/** 后端任务（PHD 翻译 / DevOps 报告精简）的模型绑定 + 投影同步状态。 */
export interface BackendTaskRow {
  task: string;
  alias: string;
  model_id: string;
  projected_model_id: string;
  projected_at: string;
  /** 派生行是否由本系统投影（false = 人手填的，解绑时不会被清空）。 */
  projected_by_us: boolean;
  /**
   * unbound  未绑定，后端走自己的 env / 默认
   * in_sync  真源与派生行一致
   * drift    上次投影失败或被人手改过 → 提示重新保存
   * unknown  派生行读取失败，状态不可知
   * 三态而非布尔：旧的 `in_sync` 在什么都没配时是 `"" === ""` → true，
   * 于是从未配置过的系统显示为「已同步」，而这是唯一的漂移信号。
   */
  status: "unbound" | "in_sync" | "drift" | "unknown";
  in_sync: boolean;
}

export async function fetchLlmConfig(): Promise<LlmConfig> {
  return req<LlmConfig>("GET", "/admin/llm-config");
}
/** 整份保存。generation 由服务端生成，请求体里带也会被忽略。并发冲突返回 409。 */
export async function putLlmConfig(cfg: {
  provider: string; credential_mode: string; default_model: string;
  models: LlmModelEntry[]; backend_tasks?: Record<string, string | null>;
}): Promise<{ message: string; generation: number; warning?: string }> {
  return req("PUT", "/admin/llm-config", cfg);
}
/** 候选枚举。
 *  `source_identity` = 这份列表是用**哪个身份**问出来的：
 *    api_key       用 Bedrock API Key 列的 —— 与推理身份一致，可信
 *    iam           凭证方式本来就是 IAM，一致
 *    iam_fallback  Key 没有列模型权限，退回部署角色 ——
 *                  **列表可能包含 Key 调不了的模型**，必须提示管理员 */
export async function fetchLlmCandidates(): Promise<{
  models: LlmCandidate[]; warning?: string; source_identity?: string }> {
  return req("GET", "/admin/llm-config/candidates");
}
/** 设置或清除 Bedrock API Key。响应只含脱敏状态，绝不回明文。 */
export async function putBedrockKey(body: { api_key?: string; clear?: boolean }):
Promise<{ message: string; bedrock_api_key: BedrockKeyStatus }> {
  return req("PUT", "/admin/llm-config/bedrock-key", body);
}
/** 连通性探测。只回枚举态（ok / forbidden / unauthorized / not_found / …），不透传上游原文。
 *  `credential` 是这次探测**实际使用**的凭证（`api_key` / `iam`）—— 必须知道它才能说清
 *  「已验证」的含义：api_key 模式下若 Key 为空，服务端会回退 IAM，那时绿勾与 Key 无关。 */
export async function testLlmModel(body: { model_id: string; kind: ModelKind; region?: string }):
Promise<{ model_id: string; result: string; latency_ms?: number; detail?: string;
          credential?: string }> {
  return req("POST", "/admin/llm-config/test", body);
}
export async function fetchLlmAudit(): Promise<{
  entries: { SK: string; at: string; actor_name?: string; actor_sub?: string;
             generation_before?: number; generation_after?: number }[];
}> {
  return req("GET", "/admin/llm-config/audit");
}
export async function rollbackLlmConfig(sk: string): Promise<{ message: string; generation: number; warning?: string }> {
  return req("POST", "/admin/llm-config/rollback", { sk });
}
export async function fetchBackendTasks(): Promise<{ tasks: BackendTaskRow[]; generation: number }> {
  return req("GET", "/admin/llm-config/backend-tasks");
}
export async function putBackendTasks(body: Record<string, string | null>):
Promise<{ message: string; generation: number; warning?: string }> {
  return req("PUT", "/admin/llm-config/backend-tasks", body);
}
