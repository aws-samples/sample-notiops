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
  /**
   * `name` 是不是**人手填的 alias**（后端 `alias_source === "manual"`）。
   *
   * 🔴 这一位存在的理由是「改名」那个按钮要能区分两种状态：
   *
   * ```
   * aliasManual: true    这是客户自己起的名字 → 输入框预填它，行上标「自定义」
   * aliasManual: false   这是 Organizations 的账号名（或空）
   *                      → 输入框**留空**，占位符写 org 名
   * ```
   *
   * 预填 org 名的表现是：客户点开「改名」什么都不改就保存 → 那个 org 名被
   * 标记成 manual 落库 → 以后 AWS 上改了账号名，这里再也不跟着变了，
   * 而客户从没输入过任何东西。
   */
  aliasManual?: boolean;
  onboarded: boolean; enabled: boolean; orgOnboardStatus: string;
  /**
   * 「采集 Region」。**老采集链路与资源巡检共用这一个字段**（2026-08-29 起）。
   *
   * ```
   * ["us-east-1","us-west-2"]  两条链路都只扫这两个
   * ["*"]                      巡检枚举全部；老链路把 `*` 滤掉后落回默认 region
   * [] / 无                     读时默认 ["us-east-1"]
   * ```
   *
   * ⚠️ 这段 docstring 在 2026-08-29 之前写的是「**资源巡检不读它**」——
   * 那是真的（巡检恒扫全部 region），也正是那时的缺陷：客户填 `us-east-1`
   * 保存成功，第二天在报告里看到 eu-west-1 的 finding，改这个框改成什么都没用。
   * 现在它生效了，代价是「全部」要显式写成 `*`。
   *
   * ⚠️ 后端在 `regions` 为空时返回 `["us-east-1"]`（读时默认，不改库）。
   */
  regions: string[];
  /** 第二步（DevOps Agent 关联）状态：'' | pending | template_generated | payload_saved | tested | enabled */
  devopsAgentStatus?: string;
  /**
   * 这个账号需不需要**重新部署 CFN 栈**才能做巡检判读。
   *
   * 判据（后端算）：`da#` 行 active + 有 `agent_space_id` + **没有**
   * `inspect_agent_space_id` → 部署的是旧模板（没有巡检 space），
   * 或部署了新模板但回填时那一栏留空。
   *
   * 🔴 不显示它的后果：那些账号采集照跑（`enabled_accounts` 与这个字段无关）、
   * 花 GetMetricData，而判读永远为空 —— 而看板上「N 条未做根因分析」与
   * 「DA 说这些没问题」长得一样。管理页是唯一能看出「要重新部署栈」的地方。
   */
  needsStackUpdate?: boolean;
  /**
   * 这个账号**不在部署账号所属的组织里**（跨 Payer 手动接入）。
   *
   * 🔴 后端此前只列 `organizations:ListAccounts` 返回的账号 ⇒ 跨 org 接入的
   * 账号即使两行都写好、巡检也照常扇出它（`enabled_accounts` 读 `da#accounts`
   * GSI，与 org 无关），管理页上它**永远不存在**。而手动接入流程本身全绿、
   * 页面提示「已保存并激活」—— 运维看到成功，然后在列表里找不到它。
   *
   * ⚠️ UI SHALL 标出它，因为**能做的操作不同**：一键接入走 StackSet，
   * 覆盖不到组织外账号 ⇒ 那个按钮对它必须不渲染（不是灰着 —— 灰着等于摆一个
   * 用户无法解决的问题，本文件既有约定）。
   */
  outOfOrg?: boolean;
  /**
   * 这个账号是组织**管理账号**（只有「从委派管理员账号部署」的形态下才会出现这一行 ——
   * 管理账号自部署时部署账号本身就被排除在列表外）。
   *
   * 🔴 UI SHALL 不渲染一键接入按钮：**CloudFormation 不会把 stack 部署到管理账号**，
   * 即使它在被 target 的 OU 里（AWS 官方限制）。渲染的后果不是报错而是**假成功** ——
   * `CreateStackInstances` 返回成功、操作变 SUCCEEDED、账号被翻成「已接入」，
   * 而那个账号里什么都没建，之后每一次跨账号提问都 AssumeRole 失败。
   * 唯一出路是在管理账号里手工部一次 `member-account-onboarding.yaml` + 手动接入登记。
   */
  isOrgManagementAccount?: boolean;
  /**
   * 接入方式：`"manual"` = 客户自己部署 CFN；`""` = 一键接入（或老记录）。
   *
   * 🔴 UI SHALL 显示它，因为**下线的回收范围按它分岔**：
   *
   * ```
   * 一键接入   DeleteStackInstances → 成员账号里的栈真的被删，资源全回收
   * 手动接入   StackSet 里没有它 → 只清本地登记，成员账号里的
   *            agent space + IAM 角色**留着**，要客户自己去删那个栈
   * ```
   *
   * 两种账号在列表里长得一样、按钮也一样，而点下去的结果完全不同 ——
   * 不标出来客户会以为下线就清干净了（agent space 是计费资源）。
   */
  onboardSource?: string;
}
/**
 * 成员账号列表 + 两个能力标记。
 *
 * 🔴 三件事分开报，**不要合并**（2026-08-25）：
 *
 * ```
 * items            列表本身
 * orgListable      能不能从 Organizations 列账号
 *                  partner-resold 客户（无 payer 权限、系统部署在某个 linked
 *                  account 上）是 false —— 那时只列 DDB 里已登记的账号
 * oneClickOnboard  StackSet 一键接入可不可用（要 org 模式 + 管理账号）
 * ```
 *
 * ⚠️ 原来这三件事挤在「后端抛不抛 `org_mode_disabled`」一个信号里，于是
 * 「列不出账号」被当成「整页不可用」，而跨 payer 流程（两者都不需要）
 * 也被一起挡掉 —— 那条流程恰恰是为这类客户设计的。
 */
export interface MemberAccountsResp {
  items: MemberAccountRec[];
  orgListable: boolean;
  oneClickOnboard: boolean;
  /** 部署账号的巡检范围（2026-09-07 起可配）。它不进 items（不是"成员接入"），
   *  UI 在列表顶部钉一行。regions 为空数组 = 没配过 = 巡检默认扫全部 region。
   *  null = 老 BFF（没有这个字段）→ 不渲染部署账号行，其余功能不受影响。 */
  deployAccount: { accountId: string; regions: string[] } | null;
}
export async function fetchMemberAccounts(): Promise<MemberAccountsResp> {
  const r = await req<Partial<MemberAccountsResp>>("GET", "/admin/member-accounts");
  return {
    items: r.items || [],
    // ⚠️ 缺省按 **true** 兜底：存量 BFF（这次改动之前）不返回这两个字段，
    //    而那时的行为就是「能列出来 + 能一键接入」。默认 false 会让老部署
    //    突然显示一堆「不可用」提示。
    orgListable: r.orgListable !== false,
    oneClickOnboard: r.oneClickOnboard !== false,
    deployAccount: r.deployAccount || null,
  };
}
export async function onboardMemberAccount(accountId: string, regions: string[]): Promise<{ operationId: string; accountId: string }> {
  return req("POST", "/admin/member-accounts", { accountId, regions });
}
export async function memberOnboardStatus(operationId: string, accountId: string): Promise<{ status: string }> {
  return req("GET", `/admin/member-accounts/status/${encodeURIComponent(operationId)}?account_id=${encodeURIComponent(accountId)}`);
}
/**
 * 只改「采集 Region」，**不触发 StackSet 下发**。
 *
 * 🔴 不要用 `onboardMemberAccount` 代替：那个会 `CreateStackInstances`
 * 重新下发两个 StackSet（几分钟、会动成员账号里的资源）。客户在列表里改一下
 * region 不该付那个代价。
 *
 * ⚠️ 后端会**拒绝**打错形状的 region（`us-east1` 这种）而不是静默过滤 ——
 * 静默过滤会让客户以为存进去了，而那条链路的表现是「那个区一直没被采」，
 * 与「region 名打错了」在界面上完全一样。错误原文要原样显示。
 */
export async function setMemberAccountRegions(
  accountId: string, regions: string[],
): Promise<{ accountId: string; regions: string[] }> {
  return req("PUT", `/admin/member-accounts/${encodeURIComponent(accountId)}/regions`,
    { regions });
}

/**
 * 改账号显示名。**空串 = 清空**，回退到 Organizations 的账号名。
 *
 * 后端会同时写两处（`account#` 的 `account_name` + `da#` 的 `account_alias`），
 * 回传的 `pushLabelUpdated` 说的是**第二处**改了没有 —— `da#` 行不存在
 * （还没做 DevOps Agent 关联）时是 false，那种账号本来就不进 IM 推送。
 *
 * ⚠️ **不会重命名已经建好的 DevOps Agent space**（创建时定死，没有 rename API）。
 */
export async function setMemberAccountAlias(
  accountId: string, alias: string,
): Promise<{ accountId: string; alias: string; pushLabelUpdated: boolean }> {
  return req("PUT", `/admin/member-accounts/${encodeURIComponent(accountId)}/alias`,
    { alias });
}

export async function setMemberAccountEnabled(accountId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  return req("POST", `/admin/member-accounts/${encodeURIComponent(accountId)}/${enabled ? "enable" : "disable"}`);
}
/**
 * 下线。回收范围按接入方式分岔 —— 见 `stackRetained`。
 *
 * 🔴 `stackRetained: true` 表示成员账号里那个 CloudFormation 栈**没被删**
 * （手动接入的账号：StackSet 里没有它的 instance，我们碰不到）。这时
 * `stackName` 给出要客户自己去删的栈名 —— agent space 是计费资源，
 * 不说清楚等于让它一直挂着。
 */
export async function offboardMemberAccount(accountId: string): Promise<{
  operationId: string; status: string;
  stackRetained?: boolean; stackName?: string; stackRegion?: string;
}> {
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

// ── IM 机器人配置（Admin「集成 IM」板块;每平台一个 Secrets Manager secret,与老管理前端解耦）──
export interface FeishuConfig { app_id: string; app_secret: string; verification_token?: string; encrypt_key?: string; notify_chat_ids: string }
/** 钉钉的字段集**比飞书少**：没有 verification_token / encrypt_key（钉钉验签用的就是
 *  app_secret），也没有 notify_chat_ids（钉钉的主动推送只有一个自定义机器人地址，
 *  见 shared/report_delivery/dingtalk_sender.py 的 SINGLE_SINK_PLATFORMS）。
 *
 *  ⚠️ `push_webhook_url` 与下面那个只读的 `webhook_url` **不是一回事**，方向正好相反：
 *     · `push_webhook_url` = 客户那个**自定义机器人**的推送地址，**它本身就是凭证**
 *       （谁拿到都能往那个群发消息）→ GET 回来是脱敏形态，回传脱敏值 = 不改。
 *     · `webhook_url`（下面）= NotiOps 的**入站**回调地址，公开、只读、不脱敏。
 *     后端刻意把 secret 里的 `webhook_url` 改名成 `push_webhook_url` 对外，就是为了这两个
 *     不同名（见 bff/web-chat/dingtalk_config.mjs 文件头「命名陷阱」）。 */
export interface DingtalkConfig { app_key: string; app_secret: string; push_webhook_url?: string }
/** Slack 的字段集与另两个平台**结构上不同**：只有两个字段，而且**两个都是凭证**
 *  （飞书/钉钉的 `app_id` / `app_key` 是明文回显的标识符，Slack 没有对应物）。
 *
 *  ⚠️ 后端存的是**两个纯字符串 secret**（`notiops/slack-bot-token` /
 *     `notiops/slack-signing-secret`），不是飞书/钉钉那种"一个 secret 里放 JSON"。
 *     前端不用关心这一点，但改这一块之前请先读 bff/web-chat/slack_config.mjs 文件头 ——
 *     那里写着为什么"未配置"不等于"空"（方式 B 下 CDK 会给这两个 secret 填随机值）。
 *
 *  ⚠️ 这两个字段 GET 回来**永远是脱敏形态或空串**，没有明文回显的可能。空串 = 未配置
 *     （含"值的形状不对"，比如粘到了 `xoxa-`/`xapp-` 或 CDK 那个随机占位值）。 */
export interface SlackConfig { bot_token: string; signing_secret: string }
/** GET 额外回带一个**只读**字段 `webhook_url`：该平台 IM 入口的回调地址，后端按名字查
 *  HTTP API 得到（bff/web-chat/{feishu,dingtalk}_config.mjs）。它不是凭证、不脱敏，给抽屉
 *  第 3 步显示 + 一键复制用。**没装 IM / 查不到时是空串**，界面据此退回"去 Outputs 里找"。
 *  故意不放进 `FeishuConfig` / `DingtalkConfig` —— PUT 不接受这个字段，写进去会让它看着像可改的。
 *
 *  一次 GET 回全部平台（不是每个平台一次请求）：这一页要同时画出"哪个配好了、哪个还空着"，
 *  拆成多次请求就多出一堆半成功状态，而这一页最贵的 bug 恰好是**界面骗人**。
 *
 *  `dingtalk` / `slack` 标成**可选**是诚实的:前端资产与 BFF Lambda 虽然在同一个栈里更新，
 *  但客户浏览器可能拿到的是缓存下来的旧前端（或反过来:新前端 + 还没更新完的 BFF）。缺这一段时
 *  对应分页要退回"全部空着"，而不是白屏 —— 所以调用方必须给兜底。 */
export async function fetchNotificationConfig(): Promise<{
  feishu: FeishuConfig & { webhook_url?: string };
  dingtalk?: DingtalkConfig & { webhook_url?: string };
  slack?: SlackConfig & { webhook_url?: string };
}> {
  return req("GET", "/admin/notification-config");
}
export async function putNotificationConfig(config: Partial<FeishuConfig>): Promise<{ message: string }> {
  return req("PUT", "/admin/notification-config", { platform: "feishu", config });
}
export async function testNotificationSend(chatId: string): Promise<{ success: boolean; message: string }> {
  return req("POST", "/admin/notification-config/test", { platform: "feishu", chat_id: chatId });
}
export async function putDingtalkConfig(config: Partial<DingtalkConfig>): Promise<{ message: string }> {
  return req("PUT", "/admin/notification-config", { platform: "dingtalk", config });
}
/** 钉钉的"测试"**不发到群里**：钉钉没有"往任意群发一条测试消息"的接口（机制 2 要
 *  openConversationId、机制 3 要 staffId，两者都只能从回调报文里拿）。所以后端做的是
 *  换一次 access_token 验凭证，外加"填了自定义机器人地址就顺手推一条"。
 *  因此这个函数**没有 chatId 参数** —— 不是漏了。 */
export async function testDingtalkSend(): Promise<{ success: boolean; message: string }> {
  return req("POST", "/admin/notification-config/test", { platform: "dingtalk" });
}
export async function putSlackConfig(config: Partial<SlackConfig>): Promise<{ message: string }> {
  return req("PUT", "/admin/notification-config", { platform: "slack", config });
}
/** Slack 的"测试"**也不发到群里**，但它比钉钉那条能多说一件事：`auth.test` 的响应头
 *  带着 bot token 实际拿到的 scope 清单，所以后端会把**缺的 scope**直接点名报回来
 *  （"装好了但漏勾 im:history"这种坑否则要等到"DM 里 bot 收到空消息"才发现）。
 *
 *  ⚠️ 它**验不了 signing secret** —— Slack 没有任何 API 能验它，唯一的验证时机是在
 *     Slack 后台保存 Request URL（那一步会立刻发一个 url_verification 过来）。所以
 *     `success: true` 只代表 bot token + scope 没问题，文案里会明确写清这一点。
 *  因此这个函数**没有参数** —— 不是漏了。 */
export async function testSlackSend(): Promise<{ success: boolean; message: string }> {
  return req("POST", "/admin/notification-config/test", { platform: "slack" });
}

// ── 阿里云只读凭据（Admin「多云」板块;单个 secret notiops/aliyun-credentials）──
/**
 * ⚠️ 路由**不复用** `/admin/notification-config`，自己一条 `/admin/aliyun-config`。
 *    阿里云凭据不是 IM 平台:字段集、校验规则、以及"测试连接"能证明什么，三样都不一样;
 *    而且那条 IM 路由是「一次请求画出全部平台」，混进去等于给那一页的渲染多背一个失败源。
 *    后端同理是独立模块（bff/web-chat/aliyun_config.mjs）。
 *
 * ⚠️ 本轮只有 AccessKey（AK/SK）一种模式。`auth_mode` 后端**只接受 `"ak"`**，传别的会被
 *    显式 400（不是静默当成 ak）—— 所以这里把它写成字面量类型，将来加 OIDC 是**追加**
 *    一个取值。前端目前根本不传这个字段（后端补默认值），留着它是为了让「只支持一种模式」
 *    这件事在类型上看得见。
 */
export interface AliyunConfig {
  /** 不是凭证（阿里云签名要 id+secret 成对），后端明文回显 —— 客户要能核对填的是哪一把。 */
  access_key_id: string;
  /** GET 回来**永远是脱敏形态（`****后4位`）或空串**。回传脱敏值 = 不修改。 */
  access_key_secret: string;
  /** 阿里云地域 id（如 cn-hangzhou）。后端只放过小写字母/数字/连字符 —— 它会被拼进
   *  endpoint 主机名，那条校验是 SSRF 闸门，不是格式美化（见 aliyun_config.mjs 文件头）。 */
  region_id: string;
  auth_mode?: "ak";
  /** ── STAROps 数字员工（「对话对象」里那一段的全部配置）───────────────────
   *
   * 与上面的凭据同一个 secret、同一条路由：它们**永远一起用**（没有 AK 的员工名毫无意义，
   * 有 AK 没员工名也发不出一次 CreateChat），拆成两条路由只会造出"一半配好"的中间态。
   *
   * ⚠️ `starops_region` 与上面的 `region_id` 是**两件事**，别合并（后端注释同款警告）：
   *    · `region_id`      = 要被巡检的地域（客户资源在哪，如 cn-hangzhou）
   *    · `starops_region` = STAROps **接口**地域，取值只有 cn-beijing / ap-southeast-1
   *      —— 填错的症状是一个语义不明的 404，客户会以为是员工名写错了。
   *
   * 🔒 `starops_workspace` 的值里嵌着阿里云账号 UID：可以在这一页填写与回显（管理员本来
   *    就看得到自己的账号），但**不进日志**，也不出现在任何非 admin 的响应里
   *    （`/features/starops` 那条探测就刻意不回它）。 */
  starops_employee?: string;
  starops_region?: string;
  /** 可选的定位上下文（不填数字员工也能答，只是范围更宽）。`starops_project` 是**日志服务
   *  (SLS) 的 project**，不是"项目"这种泛称 —— 文案里必须写清楚，否则客户会填个部门名，
   *  症状是数字员工"什么都查不到"，这种归因极难。 */
  starops_workspace?: string;
  starops_project?: string;
}
/**
 * GET 额外回带两个只读判据:**别在前端自己判「空串算不算配好」**。
 * `configured` 的判据是「AK id 与 AK secret 都非空」—— 半副密钥一次调用都发不出去，
 * 所以不算配好；`starops_configured` 还要求员工名非空。
 * 两边各判一次的话迟早不一致，而这一页最贵的 bug 恰好是**界面骗人**。
 *
 * `aliyun` 标成**可选**是诚实的:客户浏览器可能拿到缓存的新前端 + 还没更新完的 BFF
 * （那时这条路由是 404 / 不回这一段）。缺它时要退回"空表单"，不能白屏。
 */
export async function fetchAliyunConfig(): Promise<{
  aliyun?: AliyunConfig & { configured?: boolean; starops_configured?: boolean };
}> {
  return req("GET", "/admin/aliyun-config");
}
export async function putAliyunConfig(config: Partial<AliyunConfig>): Promise<{ message: string }> {
  return req("PUT", "/admin/aliyun-config", { config });
}

// ── 跨 Payer 接入(组织外账号:Launch Stack + 手工回填 + 测试连接)──
export async function generateLaunchStack(accountId: string): Promise<{ launchStackUrl: string; templateUrl: string; expiresHours: number }> {
  return req("POST", `/admin/member-accounts/${encodeURIComponent(accountId)}/launch-stack`);
}
export async function saveManualPayload(accountId: string, payload: {
  agent_space_id: string;
  trigger_role_arn: string;
  /**
   * 巡检判读用的第二个 space（模板输出 `InspectionAgentSpaceId`）。
   *
   * ⚠️ **可选**：存量账号部署的是旧模板，没有这个输出。缺它的后果是那个账号
   * 不派巡检判读（executor 侧显式报错，不是静默），但排障那半照常工作 ——
   * 所以不能做成必填，否则存量账号连排障都回填不了。
   */
  inspect_agent_space_id?: string;
}): Promise<{ status: string; message: string }> {
  return req("PUT", `/admin/member-accounts/${encodeURIComponent(accountId)}/payload`, payload);
}
/**
 * 测试跨账号连接（AssumeRole → GetAgentSpace）。
 *
 * 🔴 `probe` 传当前**输入框里**的值 —— 不传就只测已保存的记录。
 * 原来只测已保存的，于是客户填完两个框先点「测试连接」（两个按钮并排，
 * 很自然的顺序）就会拿到「account not configured (missing trigger_role_arn
 * or agent_space_id)」—— 而他明明刚填了那两个值。
 */
export async function testDaConnection(
  accountId: string,
  probe?: { agent_space_id: string; trigger_role_arn: string },
): Promise<{ success: boolean; step?: string; error?: string; agentSpaceId?: string }> {
  return req("POST",
    `/admin/member-accounts/${encodeURIComponent(accountId)}/test-connection`,
    probe);
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

// ---------------------------------------------------------------------------
// 跨账号**巡检**的前置（2026-08-25）
//
// 与 onboard / DA 关联是独立的两件事：那些让账号「接进来」，这些让**巡检**
// 能真的采到它。
// ---------------------------------------------------------------------------

export interface InspectionCrossAccountStatus {
  ok: true;
  accountId: string;
  systemAccountId: string;
  /**
   * 巡检共用的那**一个** agent space（在系统账号里）。
   *
   * 🔴 巡检共用一个 space，根因调查才是每账号一个。所以这里显示的是
   * 「把成员账号加进哪个 space」，不是「它自己的 space」。
   * ⚠️ 前端 SHALL NOT 硬编码这个 id —— 重建栈它就变了。
   */
  inspectionSpace: { id: string; name: string; region: string };
  /** ① 采集凭证 —— **巡检必需**，缺了整轮直接失败。 */
  collection: {
    /** 只表示登记过，不代表 assume 通得过（那要 verify 一次）。 */
    registered: boolean;
    roleArn: string;
    /** 模板会建出来的那个 ARN（角色名固定，所以能推导）。 */
    expectedRoleArn: string;
    /** 登记的与预期不一致 —— 手工贴错，或换过部署账号。 */
    mismatch: boolean;
  };
  /** ② 判读深度 —— 可选，缺了判读仍出结论但少了主动深挖。 */
  monitorAssociation: {
    /** `null` = 查不到（无权 / SDK 缺），**不等于**没关联。 */
    linked: boolean | null;
    /**
     * `"" | "valid" | "invalid" | "pending-confirmation"`
     *
     * 🔴 `invalid` 与「没关联」是**两回事**：关联建了，但成员账号里那个角色
     * 不存在或信任策略不对，DA assume 不进去。只看 `linked` 会把这种情况
     * 显示成「已关联 ✓」。
     */
    status: string;
    /** 模板固定命名，能推导 —— 不让客户手贴。 */
    expectedRoleArn: string;
  };
}

export async function fetchInspectionCrossAccount(
  accountId: string,
): Promise<InspectionCrossAccountStatus> {
  return req("GET",
    `/admin/member-accounts/${encodeURIComponent(accountId)}/inspection`);
}

/**
 * 验证并登记采集角色。**会真的 AssumeRole 一次**，通了才写库。
 *
 * ⚠️ 失败时后端返回 `cross_account_unavailable` 并带 AWS 原话
 * （`AccessDenied` 与 `NoSuchEntity` 指向完全不同的动作），UI SHALL 原样显示。
 */
export async function verifyInspectionCollectionRole(
  accountId: string,
): Promise<{ ok: true; accountId: string; roleArn: string; verified: boolean }> {
  return req("POST",
    `/admin/member-accounts/${encodeURIComponent(accountId)}/inspection/verify-role`);
}

/**
 * 采集角色模板的 Launch Stack URL —— **兜底用**。
 *
 * ⚠️ 2026-08-26 起采集角色已经合并进手动接入那个模板
 * （`infra/member-devops-agent.yaml` 的 `IdleDetectionRole`），所以正常流程
 * 客户只部署**一个**栈，不需要这个。留着它是给两种账号收尾：
 * 用合并前的老模板部署过的、以及部署时把 `CreateCollectionRole` 选成了 no 的。
 */
export async function generateInspectionCollectionStack(
  accountId: string,
): Promise<{
  accountId: string; templateUrl: string; launchStackUrl: string;
  expiresHours: number; expectedRoleArn: string;
}> {
  return req("POST",
    `/admin/member-accounts/${encodeURIComponent(accountId)}/inspection/launch-stack`);
}

/**
 * ②：把这个账号关联进**系统账号**的巡检 Agent Space（辅助云来源）。
 *
 * 原来这一步只能让客户进 DevOps Agent 控制台走「添加辅助云来源」向导 —— 7 步，
 * 其中 6 步是手抄一段自定义信任策略去建 IAM 角色。拆开之后：
 *
 * ```
 * 角色（成员账号里建 IAM）   → 合并后的 CFN 模板建好，客户看不见
 * 关联（系统账号的 API）     → 这个按钮，BFF 就跑在系统账号里
 * ```
 *
 * ⚠️ 后端把「已存在」当成功（客户可能自己在控制台做过），所以这个按钮可以
 * 重复点。返回的 `status` 才是真相：`invalid` 表示关联建了但角色那半没到位。
 */
export async function associateInspectionSource(
  accountId: string,
): Promise<{
  ok: true; accountId: string; created: boolean; roleArn: string;
  status: string; spaceId: string;
}> {
  return req("POST",
    `/admin/member-accounts/${encodeURIComponent(accountId)}/inspection/associate`);
}
