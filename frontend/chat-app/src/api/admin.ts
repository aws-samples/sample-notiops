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
  if (!r.ok) throw new Error((j && (j.error as string)) || `http_${r.status}`);
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
