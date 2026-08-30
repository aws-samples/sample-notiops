/**
 * NotiOps Web Chat BFF — Lambda Function URL (response streaming)。
 *
 * 路由（Function URL，path 形如 /api/chat/...）：
 *   POST /api/chat/stream            SSE 流式（核心）
 *   GET  /api/chat/conversations     列出我的会话
 *   GET  /api/chat/conversations/{id} 取会话消息
 *
 * 鉴权：所有路由校验 Cognito idToken（与 idle 控制台共享同一 user pool）。
 *
 * Phase 0：/stream 先把用户输入"回显"成 token 流（thinking → tokens →
 * sources → done），验证端到端 SSE 管线。Phase 1 起把这里换成调用
 * AgentCore Runtime（Phase 1）。
 *
 * 运行时：Node.js 20。零第三方依赖（crypto/https 内置 + 预装 AWS SDK v3）。
 */
import { verifyToken, bearerFrom } from "./jwt.mjs";
import { ensureConversation, touchConversation, appendMessage, listConversations, listMessages, renameConversation, setConversationPinned, deleteConversation, listNotifications, unreadNotifications, markNotificationsRead } from "./store.mjs";
import { agentRuntimeConfigured, invokeAgent } from "./agentcore.mjs";
import { executeAction, casesSummary, casesDashboard, describeServices, getCasesTrends, casesOrgSummary } from "./support.mjs";
import { listAccounts, deploymentInfo } from "./accounts.mjs";
import { listSkills, getSkill, saveSkill, deleteSkill, skillExists, listVersions, rollbackSkill, importSkillZip, seedPresetSkills } from "./skills.mjs";
import { uploadSkillToDevopsAgent, removeSkillFromDevopsAgent, listDevopsAgentTargets } from "./devops_agent_skills.mjs";
import { getHealthDashboard, getHealthOpenIssueCount, getHealthEventDetail } from "./health.mjs";
import { getFinopsDashboard, getDeepDive, getTagKeys, getTagValues, getTagCost } from "./finops.mjs";
import { getSecurityDashboard, taCheckResources } from "./security.mjs";
import { getGuarddutyDashboard, getBackupDashboard, getSecurityOrgSummary } from "./secops.mjs";
import { getAlarmDashboard, getAlarmOrgSummary } from "./alarms.mjs";
import { getEosDashboard, getEosOrgSummary } from "./eos.mjs";
import { authorize, effective, filterDashboard, visibleTree } from "./authz.mjs";
import { apiListRoles, apiSaveRole, apiDeleteRole, apiListUsers, apiPutUser, apiGetModules, apiPutModules, apiAllCapabilities, apiCreateUser, apiDeleteUser, apiListGroups, apiPutGroupMap, apiCreateGroup, apiDeleteGroup, apiListGroupMembers, apiAddUserToGroup, apiRemoveUserFromGroup, apiGetEol, apiPutEol } from "./admin.mjs";
import { isAccountVisible, filterVisibleAccounts, visibleAccountSet, listVisibility, getVisibility, putVisibility, deleteVisibility } from "./account_visibility.mjs";
import { listMemberAccounts, onboardAccount, onboardStatus, setAccountEnabled, offboardAccount, associateDevopsAgent, devopsAgentAssocStatus, generateLaunchStackUrl, manualPayloadSave, testDaConnection } from "./member_accounts.mjs";
import { apiGetNotificationConfig, apiPutNotificationConfig, apiTestNotificationSend } from "./feishu_config.mjs";
import { apiGetLlmConfig, apiPutLlmConfig, apiGetCandidates, apiPutBedrockKey, apiTestLlmModel, apiListLlmAudit, apiRollbackLlmConfig, apiGetModels, apiGetBackendTasks, apiPutBackendTasks, apiGetLlmStatus, resolveForStream } from "./llm_config.mjs";

const enc = new TextEncoder();
const sse = (event, data) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本轮一个字都没产出、且**不是**冷启动 → 说清失败原因 + 给下一步（别再只给「（无响应）」）。
 *
 * 事故背景（2026-08-25 现网）：Grok 4.6 那轮 Bedrock ConverseStream 连续
 * InternalServerException，agent runtime 按约定发了 `{error, error_type}` 帧，但 BFF 当时
 * 不认识那帧、也就没有 lastErr → 用户只看到「（无响应）」，无从判断是该重试还是换模型。
 * 现在 agentcore.mjs 会把那帧变成异常，这里负责把它翻成人话。
 *
 * 只回显**错误类型**（如 InternalServerException），不回显原始报文
 * （docs/LOGGING_STANDARD.md：日志与用户可见文案都不带模型/服务的原始 message）。
 */
function modelFailureText(locale, err) {
  const kind = String(err?.runtimeErrorType || err?.name || "").trim() || "UnknownError";
  // Bedrock 侧的临时故障/限流 → 明确告诉用户「重试通常就好，或换个模型」；
  // 其它（多为本端 bug）→ 只说失败并建议重试/反馈，不误导成"模型的问题"。
  const transient = /InternalServer|ServiceUnavailable|Throttl|Timeout|ModelError|ModelNotReady/i.test(kind);
  if (locale === "en") {
    return transient
      ? `⚠️ The model service returned \`${kind}\` and this turn produced no answer (already retried automatically).\n\n**Next steps:**\n1. Send the message again — this class of error is usually transient;\n2. If it keeps failing, switch to a different model (e.g. Claude Sonnet 5) above the input box and retry.`
      : `⚠️ This turn failed (\`${kind}\`) and produced no answer.\n\n**Next step:** send the message again. If it keeps failing, report it to your administrator with the time of this message.`;
  }
  return transient
    ? `⚠️ 模型服务返回 \`${kind}\`，本轮未能生成回答（已自动重试）。\n\n**下一步：**\n1. 直接再发一次 —— 这类错误多为模型服务端的临时故障；\n2. 若连续失败，在输入框上方切换到**另一个模型**（如 Claude Sonnet 5）后重试。`
    : `⚠️ 本轮处理失败（\`${kind}\`），未能生成回答。\n\n**下一步：** 请再发送一次。若持续失败，请把这条消息的时间点反馈给管理员。`;
}

function pathOf(event) {
  return event.rawPath || event.requestContext?.http?.path || "/";
}
function methodOf(event) {
  return event.requestContext?.http?.method || event.httpMethod || "GET";
}
async function authClaims(event) {
  const token = bearerFrom(event.headers || {});
  return verifyToken(token); // 抛错即未授权
}

/* ───────────────── 流式入口（Function URL streaming）───────────────── */
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const path = pathOf(event);
  const method = methodOf(event);

  // 非流式路由（会话列表/历史）也走这个 handler，用 JSON 一次性写回
  const json = (status, obj) => {
    const meta = { statusCode: status, headers: { "content-type": "application/json" } };
    const s = awslambda.HttpResponseStream.from(responseStream, meta);
    s.write(JSON.stringify(obj));
    s.end();
  };

  let claims;
  try {
    claims = await authClaims(event);
  } catch {
    return json(401, { error: "unauthorized" });
  }
  const sub = claims.sub;
  const groups = claims["cognito:groups"] || [];

  /** 审计用操作者上下文（spec R6.4：谁 / 何时 / 从哪改的）。 */
  const actorOf = () => ({
    sub,
    username: claims["cognito:username"] || claims.email || claims.username || "",
    groups,
    ip: event.requestContext?.http?.sourceIp || "",
    ua: event.requestContext?.http?.userAgent || "",
  });

  try {
    // ── 统一授权门禁（安全边界；见 authz.mjs / spec 需求 2）──
    // 登录白名单（会话/账号/me-capabilities）由 authorize 内部放行；其余按 registry 门禁。
    const q = event.queryStringParameters || {};
    let authBody = {};
    try {
      authBody = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "{}"));
    } catch { /* 非 JSON body（如无 body 的 GET）→ 空对象 */ }
    const eff = await effective(sub, groups);
    const gate = await authorize({ method, path, query: q, body: authBody }, eff);
    if (!gate.allow) return json(gate.status || 403, { error: "forbidden", required: gate.required });

    // ── 成员账号数据可见性（账号级 RBAC；Admin「账户」页配置）──
    // 任何带账号参数的请求（FinOps ?account= / 会话 body.account_id）在此统一校验；
    // 空值 = 部署账号，不受限。见 account_visibility.mjs。
    {
      const requestedAccount = String((q && q.account) || (authBody && authBody.account_id) || "").trim();
      if (requestedAccount && !(await isAccountVisible(requestedAccount, sub, groups, eff))) {
        return json(403, { error: "account_forbidden", account: requestedAccount });
      }
    }

    // ── 当前用户可见能力子树（前端渲染依据；spec 需求 3）──
    if (method === "GET" && path.endsWith("/me/capabilities")) {
      return json(200, { capabilities: await visibleTree(eff) });
    }

    // ── Admin API（角色/用户/模块；均已由门禁要求 nav:admin）──
    const adminRoleMatch = /\/admin\/roles\/([^/]+)$/.exec(path);
    const adminUserMatch = /\/admin\/users\/([^/]+)$/.exec(path);
    const adminGroupMatch = /\/admin\/groups\/([^/]+)$/.exec(path);
    if (method === "GET" && path.endsWith("/admin/capabilities")) {
      return json(200, { nodes: apiAllCapabilities() });
    }
    if (method === "GET" && path.endsWith("/admin/roles")) {
      return json(200, { roles: await apiListRoles() });
    }
    if (method === "POST" && path.endsWith("/admin/roles")) {
      const r = await apiSaveRole(authBody.name, authBody.permissions);
      return json(r.status, r.body);
    }
    if (method === "DELETE" && adminRoleMatch) {
      const r = await apiDeleteRole(decodeURIComponent(adminRoleMatch[1]));
      return json(r.status, r.body);
    }
    if (method === "GET" && path.endsWith("/admin/users")) {
      return json(200, { users: await apiListUsers() });
    }
    if (method === "POST" && path.endsWith("/admin/users")) {
      const r = await apiCreateUser({ username: authBody.username, email: authBody.email });
      return json(r.status, r.body);
    }
    if (method === "DELETE" && adminUserMatch) {
      const uname = decodeURIComponent(adminUserMatch[1]);
      const delSub = (event.queryStringParameters && event.queryStringParameters.sub) || "";
      const currentUsername = claims["cognito:username"] || claims.username || "";
      const r = await apiDeleteUser(uname, delSub, currentUsername);
      return json(r.status, r.body);
    }
    if (method === "PUT" && adminUserMatch) {
      const r = await apiPutUser(decodeURIComponent(adminUserMatch[1]), { roles: authBody.roles, denies: authBody.denies }, sub);
      return json(r.status, r.body);
    }
    if (method === "GET" && path.endsWith("/admin/groups")) {
      return json(200, { groups: await apiListGroups() });
    }
    if (method === "POST" && path.endsWith("/admin/groups")) {
      const r = await apiCreateGroup(authBody.name, authBody.description);
      return json(r.status, r.body);
    }
    // 成员管理: /admin/groups/{name}/members[/{username}]
    const groupMembersMatch = /\/admin\/groups\/([^/]+)\/members$/.exec(path);
    const groupMemberOneMatch = /\/admin\/groups\/([^/]+)\/members\/([^/]+)$/.exec(path);
    if (method === "GET" && groupMembersMatch) {
      const r = await apiListGroupMembers(decodeURIComponent(groupMembersMatch[1]));
      return json(r.status, r.body);
    }
    if (method === "POST" && groupMembersMatch) {
      const r = await apiAddUserToGroup(authBody.username, decodeURIComponent(groupMembersMatch[1]));
      return json(r.status, r.body);
    }
    if (method === "DELETE" && groupMemberOneMatch) {
      const r = await apiRemoveUserFromGroup(decodeURIComponent(groupMemberOneMatch[2]), decodeURIComponent(groupMemberOneMatch[1]));
      return json(r.status, r.body);
    }
    if (method === "DELETE" && adminGroupMatch) {
      const r = await apiDeleteGroup(decodeURIComponent(adminGroupMatch[1]));
      return json(r.status, r.body);
    }
    if (method === "PUT" && adminGroupMatch) {
      const r = await apiPutGroupMap(decodeURIComponent(adminGroupMatch[1]), authBody.roles);
      return json(r.status, r.body);
    }
    if (method === "GET" && path.endsWith("/admin/modules")) {
      return json(200, await apiGetModules());
    }
    if (method === "PUT" && path.endsWith("/admin/modules")) {
      const r = await apiPutModules(authBody.disabled);
      return json(r.status, r.body);
    }
    if (method === "GET" && path.endsWith("/admin/eol")) {
      return json(200, await apiGetEol());
    }
    if (method === "PUT" && path.endsWith("/admin/eol")) {
      const r = await apiPutEol(authBody.overrides);
      return json(r.status, r.body);
    }

    // ── Admin: 预置 Skills 落库（把 bundle 里的 NotiOps 官方 skill 幂等写入 S3;门禁 nav:admin）──
    // force=true 时对内容有变化的预置 skill bump 版本;不覆盖客户自建的同名 skill。
    if (method === "POST" && path.endsWith("/admin/skills/seed-presets")) {
      try { return json(200, await seedPresetSkills({ force: !!authBody.force })); }
      catch (e) { return json(500, { error: String(e?.message || e) }); }
    }

    // ── Admin: 飞书机器人通知配置（Secrets Manager 单 secret;门禁同 /admin/.+ = nav:admin）──
    if (method === "POST" && path.endsWith("/admin/notification-config/test")) {
      const r = await apiTestNotificationSend(authBody);
      return r.error ? json(r.status || 400, { message: r.error }) : json(200, r);
    }
    if (method === "GET" && path.endsWith("/admin/notification-config")) {
      return json(200, await apiGetNotificationConfig());
    }
    if (method === "PUT" && path.endsWith("/admin/notification-config")) {
      const r = await apiPutNotificationConfig(authBody);
      return r.error ? json(r.status || 400, { message: r.error }) : json(200, r);
    }

    // ── Admin: LLM 模型目录与凭证（DDB llmcfg + Secrets；门禁同 /admin/.+ = nav:admin）──
    // 注意顺序：更具体的子路径必须排在 /admin/llm-config 之前，否则 endsWith 匹配不到。
    if (method === "GET" && path.endsWith("/admin/llm-config/candidates")) {
      return json(200, await apiGetCandidates());
    }
    if (method === "PUT" && path.endsWith("/admin/llm-config/bedrock-key")) {
      const r = await apiPutBedrockKey(authBody, actorOf());
      return r.error ? json(r.status || 400, { message: r.error }) : json(200, r);
    }
    if (method === "POST" && path.endsWith("/admin/llm-config/test")) {
      const r = await apiTestLlmModel(authBody);
      return r.error ? json(r.status || 400, { message: r.error }) : json(200, r);
    }
    if (method === "POST" && path.endsWith("/admin/llm-config/rollback")) {
      const r = await apiRollbackLlmConfig(authBody, actorOf());
      return r.error ? json(r.status || 400, { message: r.error }) : json(200, r);
    }
    if (method === "GET" && path.endsWith("/admin/llm-config/audit")) {
      return json(200, await apiListLlmAudit());
    }
    if (method === "GET" && path.endsWith("/admin/llm-config/status")) {
      return json(200, await apiGetLlmStatus());
    }
    if (method === "GET" && path.endsWith("/admin/llm-config/backend-tasks")) {
      return json(200, await apiGetBackendTasks());
    }
    if (method === "PUT" && path.endsWith("/admin/llm-config/backend-tasks")) {
      const r = await apiPutBackendTasks(authBody, actorOf());
      return r.error ? json(r.status || 400, { message: r.error }) : json(200, r);
    }
    if (method === "GET" && path.endsWith("/admin/llm-config")) {
      return json(200, await apiGetLlmConfig());
    }
    if (method === "PUT" && path.endsWith("/admin/llm-config")) {
      const r = await apiPutLlmConfig(authBody, actorOf());
      if (r.error) {
        // 同时回 `error` 与 `message`：前端历史上只读其中一个，只回一个就会把拒绝原因
        // 静默丢成 `http_400`（实际发生过：管理员看不出是哪条不变量没满足）。
        // 并且**记一行日志** —— 4xx 此前完全不记，CloudWatch 里查不到任何线索，
        // 而配置校验失败恰恰是最需要事后追溯的一类请求。不记请求体（含目录全文）。
        console.warn(`[BFF] 400 PUT /admin/llm-config rejected: ${r.error}`);
        return json(r.status || 400, { error: r.error, message: r.error });
      }
      return json(200, r);
    }

    // ── 用户侧：可选模型（仅启用集；登录即可，见 authz LOGIN_ONLY）──
    if (method === "GET" && path.endsWith("/models")) {
      const surface = (event.queryStringParameters && event.queryStringParameters.surface) || "webchat";
      return json(200, await apiGetModels(surface));
    }

    // ── Admin: 成员账号一键接入（Organizations + StackSets；门禁同 /admin/.+ = nav:admin）──
    const memberStatusMatch = /\/admin\/member-accounts\/status\/([^/]+)$/.exec(path);
    try {
      if (method === "GET" && path.endsWith("/admin/member-accounts")) {
        return json(200, { items: await listMemberAccounts() });
      }
      if (method === "POST" && path.endsWith("/admin/member-accounts")) {
        const r = await onboardAccount(authBody.accountId, authBody.regions);
        return json(202, r);
      }
      if (method === "GET" && memberStatusMatch) {
        const r = await onboardStatus(decodeURIComponent(memberStatusMatch[1]), q.account_id || "");
        return json(200, r);
      }
      const daAssocMatch = /\/admin\/member-accounts\/([0-9]{12})\/devops-agent$/.exec(path);
      if (method === "POST" && daAssocMatch) {
        return json(202, await associateDevopsAgent(daAssocMatch[1]));
      }
      const daStatusMatch = /\/admin\/member-accounts\/da-status\/([^/]+)$/.exec(path);
      if (method === "GET" && daStatusMatch) {
        return json(200, await devopsAgentAssocStatus(decodeURIComponent(daStatusMatch[1]), q.account_id || ""));
      }
      const memberActMatch = /\/admin\/member-accounts\/([0-9]{12})(?:\/(enable|disable))?$/.exec(path);
      if (method === "POST" && memberActMatch && memberActMatch[2]) {
        return json(200, await setAccountEnabled(memberActMatch[1], memberActMatch[2] === "enable"));
      }
      if (method === "DELETE" && memberActMatch && !memberActMatch[2]) {
        return json(202, await offboardAccount(memberActMatch[1]));
      }
      // ── 跨 Payer 接入（组织外账号:模板分发 + 手工回填 + 测试连接）──
      const xpayerMatch = /\/admin\/member-accounts\/([0-9]{12})\/launch-stack$/.exec(path);
      if (method === "POST" && xpayerMatch) {
        return json(200, await generateLaunchStackUrl(xpayerMatch[1]));
      }
      const xpayerSaveMatch = /\/admin\/member-accounts\/([0-9]{12})\/payload$/.exec(path);
      if (method === "PUT" && xpayerSaveMatch) {
        return json(200, await manualPayloadSave(xpayerSaveMatch[1], authBody));
      }
      const xpayerTestMatch = /\/admin\/member-accounts\/([0-9]{12})\/test-connection$/.exec(path);
      if (method === "POST" && xpayerTestMatch) {
        return json(200, await testDaConnection(xpayerTestMatch[1]));
      }
    } catch (err) {
      if (err && (err.code === "org_mode_disabled" || err.code === "bad_request" || err.code === "config_error")) {
        return json(400, { error: err.message });
      }
      throw err;
    }

    // ── Admin: 成员账号可见性（user/group → 可见账号列表）──
    const acctVisMatch = /\/admin\/account-access\/(user|group)\/([^/]+)$/.exec(path);
    if (method === "GET" && path.endsWith("/admin/account-access")) {
      return json(200, { items: await listVisibility() });
    }
    if (acctVisMatch) {
      const kind = acctVisMatch[1];
      const id = decodeURIComponent(acctVisMatch[2]);
      if (method === "GET") {
        return json(200, (await getVisibility(kind, id)) || { kind, id, accounts: null });
      }
      if (method === "PUT") {
        return json(200, await putVisibility(kind, id, authBody.accounts));
      }
      if (method === "DELETE") {
        await deleteVisibility(kind, id);
        return json(200, { ok: true });
      }
    }

    // ── 会话列表 ──
    if (method === "GET" && path.endsWith("/conversations")) {
      // 可见性回收生效于历史会话：会话记录了接触过的成员账号，
      // 不在当前可见集内的会话从列表隐藏（数据仍在 DDB，恢复可见性即回来）
      const convs = await listConversations(sub);
      const vis = await visibleAccountSet(sub, groups, eff);
      const filtered = vis === "*" ? convs : convs.filter((c) => !c.accountId || vis.has(String(c.accountId)));
      return json(200, { conversations: filtered });
    }
    // ── 会话历史 ── /conversations/{id}
    const convMatch = /\/conversations\/([^/]+)$/.exec(path);
    if (method === "GET" && convMatch) {
      return json(200, { messages: await listMessages(convMatch[1]) });
    }
    // ── 删除会话（用户显式删除 → 立即移除，含全部消息）──
    if (method === "DELETE" && convMatch) {
      await deleteConversation(sub, convMatch[1]);
      return json(200, { ok: true });
    }
    // ── 更新会话 ── PATCH /conversations/{id}  body:{title?, pinned?}
    // title → 重命名；pinned(bool) → 置顶/取消置顶。两者可分别或同时传。
    if (method === "PATCH" && convMatch) {
      let b = {};
      try { b = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : (event.body || "{}")); } catch { /* ignore */ }
      if (typeof b.title === "string") await renameConversation(sub, convMatch[1], b.title.toString());
      if (typeof b.pinned === "boolean") await setConversationPinned(sub, convMatch[1], b.pinned);
      return json(200, { ok: true });
    }
    // ── 已注册账号列表（多账号选择器，只读 config 表；按用户可见性过滤）──
    if (method === "GET" && path.endsWith("/accounts")) {
      const all = await listAccounts();
      const dep = await deploymentInfo();
      return json(200, { accounts: await filterVisibleAccounts(all, sub, groups, eff), deployment: dep });
    }
    // ── 深度调查可用性（前端据此决定两个「深度调查」开关能不能点）──
    // 没有 DevOps Agent Agent Space 的部署/账号，点开关只能白等一轮再吃一句
    // no_local_agent_space / account_not_onboarded_to_devops_agent。这里提前把答案给前端。
    // ?account= 走上面统一的账号可见性校验（不可见 → 403），无需本地再判。
    if (method === "GET" && path.endsWith("/features/deep-investigation")) {
      const { deepInvestigationAvailability } = await import("./devops_investigate.mjs");
      return json(200, await deepInvestigationAvailability(q.account || ""));
    }
    // ── Skills（Customize 页；存 S3 skills/ 前缀，与 IM 端共享）──
    const parseBody = () => { try { return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : (event.body || "{}")); } catch { return {}; } };
    const skillExistsMatch = /\/skills\/([^/]+)\/exists$/.exec(path);
    const skillVersionsMatch = /\/skills\/([^/]+)\/versions$/.exec(path);
    const skillRollbackMatch = /\/skills\/([^/]+)\/rollback$/.exec(path);
    const skillDevopsMatch = /\/skills\/([^/]+)\/devops-agent$/.exec(path);
    const skillMatch = /\/skills\/([^/]+)$/.exec(path);
    if (method === "POST" && path.endsWith("/skills/import")) {
      const b = parseBody();
      try { return json(200, await importSkillZip(b.zip_base64 || "", { skillId: b.skill_id || "", author: sub || "web" })); }
      catch (e) { return json(400, { error: String(e?.message || e) }); }
    }
    // ── 世界 B 打通：把某个 skill 发布到 DevOps Agent 的 Agent Space ──
    // GET    /skills/devops-agent/targets  可上传的目标(本账号 + 已接入 da# 成员账号)
    // POST   /skills/{id}/devops-agent     发布(body.account_id 空=本账号;否则跨 payer)
    // DELETE /skills/{id}/devops-agent     从 DevOps Agent 撤下(query.account_id 指定目标)
    if (method === "GET" && path.endsWith("/skills/devops-agent/targets")) {
      return json(200, { targets: await listDevopsAgentTargets() });
    }
    if (method === "POST" && skillDevopsMatch) {
      const b = parseBody();
      // agent_types 可选：前端不传就用 skill meta 里的、再兜底 ["GENERIC"]（见 devops_agent_skills.mjs）。
      try { return json(200, await uploadSkillToDevopsAgent(decodeURIComponent(skillDevopsMatch[1]), { accountId: b.account_id || "", agentTypes: b.agent_types })); }
      catch (e) { return json(e?.code === "bad_request" ? 400 : 500, { error: String(e?.message || e) }); }
    }
    if (method === "DELETE" && skillDevopsMatch) {
      try { return json(200, await removeSkillFromDevopsAgent(decodeURIComponent(skillDevopsMatch[1]), { accountId: (event.queryStringParameters && event.queryStringParameters.account_id) || "" })); }
      catch (e) { return json(e?.code === "bad_request" ? 400 : 500, { error: String(e?.message || e) }); }
    }
    if (method === "GET" && skillExistsMatch) {
      return json(200, { exists: await skillExists(decodeURIComponent(skillExistsMatch[1])) });
    }
    if (method === "GET" && skillVersionsMatch) {
      return json(200, { versions: await listVersions(decodeURIComponent(skillVersionsMatch[1])) });
    }
    if (method === "POST" && skillRollbackMatch) {
      const b = parseBody();
      try { return json(200, await rollbackSkill(decodeURIComponent(skillRollbackMatch[1]), b.version)); }
      catch (e) { return json(400, { error: String(e?.message || e) }); }
    }
    if (method === "GET" && path.endsWith("/skills")) {
      return json(200, { skills: await listSkills() });
    }
    if (method === "GET" && skillMatch) {
      const ver = (event.queryStringParameters && event.queryStringParameters.version) || "";
      // locale（可选）：预置 skill 有对应语言的本地化正文时返回译文正文，否则回退规范正文。
      const loc = (event.queryStringParameters && event.queryStringParameters.locale) || "";
      const s = await getSkill(decodeURIComponent(skillMatch[1]), ver || undefined, loc || undefined);
      return s ? json(200, s) : json(404, { error: "not_found" });
    }
    if (method === "POST" && path.endsWith("/skills")) {
      const b = parseBody();
      try {
        const saved = await saveSkill({ skill_id: b.skill_id, name: b.name, description: b.description, body: b.body, mode: b.mode || "", author: sub || "web" });
        return json(200, saved);
      } catch (e) {
        return json(400, { error: String(e?.message || e) });
      }
    }
    if (method === "DELETE" && skillMatch) {
      await deleteSkill(decodeURIComponent(skillMatch[1]));
      return json(200, { ok: true });
    }
    // ── 通知收件箱（主动观察 push 的 web 端）──
    // GET  /notifications          列出通知（倒序）+ 已读游标
    // GET  /notifications/unread   仅未读数（前端 60s 轮询红点用，轻量）
    // POST /notifications/read     标记已读（body:{upto_ts?} 缺省=最新）
    if (method === "GET" && path.endsWith("/notifications/unread")) {
      return json(200, await unreadNotifications());
    }
    if (method === "POST" && path.endsWith("/notifications/read")) {
      const b = parseBody();
      return json(200, await markNotificationsRead(b.upto_ts));
    }
    if (method === "GET" && path.endsWith("/notifications")) {
      return json(200, await listNotifications());
    }
    // ── AWS Health Dashboard 实时视图(通知主题重点区块)──
    // GET /health/dashboard        服务运行状况 + 账户运行状况 + 计划变更(近7天,超出给控制台链接)
    // GET /health/dashboard/count  仅未处理 issue 数(红点/轮询用，轻量)
    if (method === "GET" && path.endsWith("/health/dashboard/count")) {
      return json(200, await getHealthOpenIssueCount());
    }
    if (method === "GET" && path.endsWith("/health/dashboard")) {
      return json(200, await getHealthDashboard(q.account || ""));
    }
    // 单个 Health 事件完整详情(渐进式加载:点"显示完整通知"/深入调查时按 arn 拉全)
    if (method === "GET" && path.endsWith("/health/event")) {
      const arn = (event.queryStringParameters && event.queryStringParameters.arn) || "";
      return json(200, await getHealthEventDetail(decodeURIComponent(arn)));
    }
    // ── FinOps 仪表盘（FinOps 主题的仪表盘区块，只读，独立于聊天/LLM）──
    // GET /finops/dashboard   一次拿齐 Budget 预警 + CUR/Athena 状态 + DevOps Agent 成本
    if (method === "GET" && path.endsWith("/finops/dashboard")) {
      return json(200, filterDashboard("nav:finops", await getFinopsDashboard(q.account || ""), eff));
    }
    if (method === "GET" && path.endsWith("/security/dashboard")) {
      const acct = (event.queryStringParameters && event.queryStringParameters.account) || "";
      return json(200, filterDashboard("nav:security", await getSecurityDashboard(acct), eff));
    }
    // TA 检查下钻：被标记资源（Security tab 调查按钮前置数据；账号可见性已由中央门禁校验）
    const taCheckMatch = /\/security\/ta-check\/([^/]+)\/resources$/.exec(path);
    if (method === "GET" && taCheckMatch) {
      try {
        return json(200, await taCheckResources(decodeURIComponent(taCheckMatch[1]), q.account || ""));
      } catch (err) {
        if (err && (err.code === "cross_account_unavailable" || err.code === "bad_request")) {
          return json(400, { error: err.message });
        }
        throw err;
      }
    }
    if (method === "GET" && path.endsWith("/security/org-summary")) {
      const vis = await visibleAccountSet(sub, groups, eff);
      return json(200, await getSecurityOrgSummary(vis));
    }
    if (method === "GET" && path.endsWith("/security/guardduty")) {
      return json(200, await getGuarddutyDashboard(q.account || ""));
    }
    if (method === "GET" && path.endsWith("/investigate/backup")) {
      return json(200, await getBackupDashboard(q.account || ""));
    }
    if (method === "GET" && path.endsWith("/investigate/alarms/org-summary")) {
      const vis = await visibleAccountSet(sub, groups, eff);
      return json(200, await getAlarmOrgSummary(vis));
    }
    if (method === "GET" && path.endsWith("/investigate/alarms")) {
      const acct = (event.queryStringParameters && event.queryStringParameters.account) || "";
      return json(200, filterDashboard("nav:investigate", await getAlarmDashboard(acct), eff));
    }
    // GET /lifecycle/eos  多 region 扫描资源 → EOS 到期(7/30/90天)+受支持比例(整端点按 nav:notifications:eos 门禁)
    if (method === "GET" && path.endsWith("/lifecycle/eos")) {
      const refresh = String((event.queryStringParameters || {}).refresh || "") === "1";
      return json(200, await getEosDashboard(q.account || "", { refresh }));
    }
    if (method === "GET" && path.endsWith("/lifecycle/eos/org-summary")) {
      const vis = await visibleAccountSet(sub, groups, eff);
      return json(200, await getEosOrgSummary(vis));
    }
    // GET /finops/deep-dive?scenario=cloudwatch|datatransfer
    //   跑 Athena 保存查询(grounded CUR rows) → Bedrock 出 insight/chart → 附 CSV 下载 URL
    if (method === "GET" && path.endsWith("/finops/deep-dive")) {
      const scenario = (event.queryStringParameters && event.queryStringParameters.scenario) || "";
      return json(200, await getDeepDive(scenario));
    }
    // ── 成本分配标签浏览器（Cost Allocation Tag Explorer）──
    // GET /finops/tag-keys?account=      已激活的成本分配标签键列表
    if (method === "GET" && path.endsWith("/finops/tag-keys")) {
      return json(200, await getTagKeys(q.account || ""));
    }
    // GET /finops/tag-values?account=&key=   某标签键的可选值（二级下拉）
    if (method === "GET" && path.endsWith("/finops/tag-values")) {
      const key = (event.queryStringParameters && event.queryStringParameters.key) || "";
      return json(200, await getTagValues(q.account || "", decodeURIComponent(key)));
    }
    // GET /finops/tag-cost?account=&key=&value=   按标签查成本(按服务分组)+AI 洞察
    //   value 省略 = 该标签所有值合计；value="" 需显式传（表示 untagged）。
    if (method === "GET" && path.endsWith("/finops/tag-cost")) {
      const qp = event.queryStringParameters || {};
      const key = decodeURIComponent(qp.key || "");
      // 区分「未传 value」(合计) vs 「传了空 value」(untagged)：用 hasOwnProperty 判断
      const hasValue = Object.prototype.hasOwnProperty.call(qp, "value");
      const value = hasValue ? decodeURIComponent(qp.value || "") : null;
      return json(200, await getTagCost(q.account || "", key, value));
    }
    // ── Cases 摘要（L2 动态推荐 prompt 用，只读）──
    if (method === "GET" && path.endsWith("/cases/summary")) {
      // summary 也按当前选择的账号（query ?account=）；缺省=部署账号
      const acct = (event.queryStringParameters && event.queryStringParameters.account) || "";
      return json(200, await casesSummary(acct));
    }
    if (method === "GET" && path.endsWith("/cases/org-summary")) {
      // 组织级汇总（Top-N 问题账号）；聚合读按用户可见账号集过滤
      const vis = await visibleAccountSet(sub, groups, eff);
      return json(200, await casesOrgSummary(vis));
    }
    // ── Cases 仪表盘（只读:概览/等你回复/incident/SLA 启发式）──
    if (method === "GET" && path.endsWith("/cases/dashboard")) {
      const acct = (event.queryStringParameters && event.queryStringParameters.account) || "";
      return json(200, filterDashboard("nav:cases", await casesDashboard(acct), eff));
    }
    if (method === "GET" && path.endsWith("/cases/trends")) {
      const acct = (event.queryStringParameters && event.queryStringParameters.account) || "";
      return json(200, await getCasesTrends(acct));
    }
    // ── 创建案例卡片的服务/类别目录（describe-services，只读，进程内缓存）──
    if (method === "GET" && path.endsWith("/support/services")) {
      const lang = (event.queryStringParameters && event.queryStringParameters.language) || "en";
      return json(200, await describeServices(lang));
    }
    // ── 执行已确认的写操作（创建/回复/关闭 case）──
    // 前端在用户点击确认卡后调用；执行不经过 LLM，严格按确认的参数。
    if (method === "POST" && path.endsWith("/actions/execute")) {
      let b = {};
      try { b = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : (event.body || "{}")); } catch { /* ignore */ }
      const result = await executeAction(b.action);
      return json(result.ok ? 200 : 400, result);
    }
    // ── 流式对话 ──
    if (method === "POST" && path.endsWith("/stream")) {
      return streamChat(event, responseStream, { sub, groups });
    }
    return json(404, { error: "not found", path });
  } catch (e) {
    // 记录到 CloudWatch Logs（含 method/path/stack）便于定位根因
    console.error(`[BFF] 500 on ${method} ${path} — ${e?.name || ""}: ${e?.message || e}`, e?.stack || "");
    return json(500, { error: String(e?.message || e) });
  }
});

/* ───────────────── 流式对话核心 ───────────────── */
async function streamChat(event, responseStream, { sub, groups }) {
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
    if (event.isBase64Encoded) body = JSON.parse(Buffer.from(event.body, "base64").toString("utf8"));
  } catch {
    /* ignore */
  }
  const text = (body.text || "").toString();
  const conversationId = (body.conversation_id || `conv-${Date.now()}`).toString();
  const requestedModel = (body.model || "").toString(); // 客户端意向，**未经准入**，勿直接下发
  const locale = body.locale === "en" ? "en" : "zh";
  const webSearch = body.web_search === true; // 用户本轮是否开启联网搜索
  const finopsAgent = body.finops_agent === true; // 本轮是否启用 FinOps Agent 深度模式（仅 FinOps 主题）
  // 「深度调查（直连）」：绕开 agent runtime，BFF 直接调 DevOps Agent API → 全程 0 token。
  // 与 devopsAgent（老路径）**互斥**（前端也做了互斥），老客户端不传此字段 → 永远走老路。
  //
  // ⚠️ 唯一例外：「转人工支持」按钮。它是 prompt 型 followup，点击 = 在**同一会话**里再发一轮，
  // 而直连开关仍然开着 → 会再落回直连；而直连没有模型，`escalate_to_support` 是 agent 侧工具，
  // 于是那一轮只会把同一份报告再贴一遍就结束（现象：闪一下文字、然后没反应）。
  // 按设计文档 §5 方案 (a)：这个按钮**本轮回退老（计费）路径**，并且必须把 devops_agent 打开，
  // 否则 agent 那边 `_devops_agent_enabled` 门控会拒掉 `escalate_to_support`（main.py:1111）。
  // 判据放在 devops_investigate.mjs 里与生成该 prompt 的代码同文件（改文案不会漂移）。
  // import 失败不该让整个请求 500（此时 SSE 头还没建立，客户端只会看到裸错误）——退化成
  // "不回退"，直连分支自己还有兜底文案。
  let escalateFallback = false;
  if (body.deep_investigate_direct === true) {
    try {
      escalateFallback = (await import("./devops_investigate.mjs")).isEscalateRequest(text);
    } catch (e) {
      console.error(`[BFF] /stream escalate-detect import failed — ${e?.name || ""}: ${e?.message || e}`);
    }
  }
  // 「DevOps 对话」：BFF 直连 DevOps Agent 控制面 CreateChat/SendMessage —— 由**客户自己的
  // DevOps Agent** 回答（计他自己的 DevOps Agent 额度），NotiOps 侧 0 token、不经 Bedrock。
  // 与上面两个开关三方互斥（前端单选；这里再兜一层，防手搓请求同时开两个走两条路）。
  // 老客户端不传此字段 → 永远走老路，行为逐字节不变。
  // `objDevops` = 这段会话的**对话对象**是客户自己的 DevOps Agent（通用会话在落地页选的，
  // 或故障调查里的平铺开关）。它与「深度调查（直连）」**不是简单互斥**：通用会话里客户可以
  // 在 DevOps Agent 对话中把「深度调查」勾上 —— 那是**这一轮**的修饰（对象没变，只是这一轮
  // 从"直接问答"换成"发起一次调查"），所以 deep 被勾上时它优先，否则勾了也照样走
  // CreateChat/SendMessage（现象：点了深度调查、答回来的还是普通对话，且不报错）。
  const objDevops = body.devops_chat_direct === true;
  const deepDirectAsked = body.deep_investigate_direct === true;
  const devopsAgent = body.devops_agent === true || escalateFallback; // DevOps Agent 深度调查（仅故障调查主题）
  const directInvestigate = deepDirectAsked && !escalateFallback;
  const chatDirect = objDevops && !deepDirectAsked;
  const topic = (body.topic || "general").toString(); // 会话主题（用于分类 + 未来按主题微调）
  const accountId = (body.account_id || "").toString(); // 多账号：本轮目标 AWS 账号（缺省=部署账号）
  // 显式 /skill：本轮强制使用的 skill。**三条路径都要用它** —— agent runtime 走 payload 注入，
  // 两条直连（DevOps 对话 / 深度调查（直连））把正文内联进发给 DevOps Agent 的那段话
  // （见 devops_skill.mjs）。少接一条 = 客户点了 skill 但那一路悄悄没生效。
  const skillId = (body.skill_id || "").toString();
  const skillVersion = (body.skill_version || "").toString(); // 可选：指定 skill 版本（缺省=latest）

  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });

  // ── 保活（keepalive）：整条 SSE 流**全程**每 10s 写一个注释行 ────────────────────
  // 事故：深度调查（`investigate_live`）只在**有新 timeline 行**时才 yield，一次调查里
  // 常有 3-5 分钟一个字节都不发；而下面那个"冷启动心跳"见到首个产出就永久停了
  // （`beat()` 在 `sawAgentOutput` 后直接 return）。结果是浏览器 → Function URL 的连接
  // 长时间零字节 —— 中间任何一跳（企业代理 / NAT / 客户端网络栈）的空闲回收都会把它掐断，
  // 而 Lambda **不会**因客户端断连而停止（AWS 文档明确："streamed responses are not
  // interrupted or stopped when the invoking client connection is broken"），所以后端照样
  // 跑完并写完最终答案，前端却永远停在那句"分析过程正在右侧…面板实时更新"直到超时。
  // 这里与业务事件完全解耦：只要流没结束就一直发，保证**任何**分支（agent / 直连调查 / echo）
  // 都不会出现分钟级静默。用 SSE 注释行（`: ka`）而不是自定义事件 —— 前端解析器按
  // "event:/data:" 取字段，注释块没有 data 行会被直接忽略，故前端零改动、也不入库。
  // 自终止：除了正常收尾时 stopKeepalive()，还要防「本函数中途抛错 → 定时器留在容器里，
  // 下次调用复用同一容器时对着已关闭的流狂写」。故三重停：流已 end / 写失败 / 超过 Lambda
  // 超时（15min = 90 tick）都自己 clear。
  let kaLeft = 90, kaTick = null;
  const stopKeepalive = () => { if (kaTick) { clearInterval(kaTick); kaTick = null; } };
  kaTick = setInterval(() => {
    if (--kaLeft <= 0 || responseStream.writableEnded || responseStream.destroyed) return stopKeepalive();
    try { stream.write(enc.encode(": ka\n\n")); } catch { stopKeepalive(); }
  }, 10000);

  // ── 服务端模型准入 + generation 注入（spec R3.5 / R4）──
  // 客户端传来的 model 只当**意向**：可能是 admin 刚下架的别名、也可能是前端缓存里的旧值，
  // 甚至可能是手搓请求点名未授权模型。一律以 DDB 目录的启用集为准，不在集内则换默认模型
  // 并回一条 model_substituted 让前端把选择器纠正过来（静默替换会让用户以为自己还在用旧模型）。
  // generation 也在此处由**服务端**读出后注入 payload —— 绝不接受客户端传值（可被污染致
  // runtime 侧 TTL 兜底失效 + 放大 DDB 读）。
  // 失败安全：目录读不出来（DDB 抖动 / 尚未 seed）不阻断对话 —— 退回客户端值 + generation 0，
  // 由 runtime 侧内置兜底 + TTL 自行收敛。宁可用旧模型，不可让聊天不可用。
  let model = requestedModel || "claude-sonnet-5";
  let generation = 0;
  try {
    const picked = await resolveForStream(requestedModel, "webchat");
    if (picked.alias) model = picked.alias;
    generation = Number(picked.generation) || 0;
    if (picked.substituted) {
      stream.write(sse("model_substituted", {
        requested: requestedModel,
        effective: model,
        reason: "not_in_enabled_set",
      }));
    }
  } catch (e) {
    console.error(`[BFF] /stream model resolve failed, falling back to client value — ${e?.name || ""}: ${e?.message || e}`);
  }

  // 落库：会话（带主题）+ 用户消息
  await ensureConversation(sub, conversationId, text.slice(0, 24), topic);
  await appendMessage(conversationId, { role: "user", text, ts: Date.now() });

  let reply = "";
  const collectedSources = [];
  let usage; // 本轮 token 用量（agent 收尾发来）

  if (chatDirect) {
    // ── DevOps 对话：0 token 路径（由**客户自己的 DevOps Agent** 回答）──
    // 不经 agent runtime / Bedrock，BFF 直接调 DevOps Agent 控制面 CreateChat + SendMessage，
    // 把事件流逐 delta 转成 SSE（token/progress/investigation_step），体验对齐"直接开 DevOps
    // Agent 网页聊"。SSE 事件与老路径同形 → 前端渲染/右侧面板零改动复用。
    // ⚠️ 开关关闭时（老客户端不传此字段）本分支永不进入，老路径一行未改。
    try {
      const { runDevopsChat } = await import("./devops_chat.mjs");
      reply = await runDevopsChat({
        text, locale, accountId, conversationId, skillId, skillVersion,
        emit: (evt, data) => {
          if (evt === "usage") usage = data?.usage;
          stream.write(sse(evt, data || {}));
        },
      });
    } catch (e) {
      console.error(`[BFF] /stream devops chat failed — ${e?.name || ""}: ${e?.message || e}`, e?.stack || "");
      if (!reply) {
        reply = locale === "en"
          ? "⚠️ “DevOps Chat” failed to run. Please retry, or turn it off to use the standard chat."
          : "⚠️ 「DevOps 对话」执行失败。请重试，或关闭该开关改用普通对话。";
        stream.write(sse("token", { delta: reply }));
      }
    }
  } else if (directInvestigate) {
    // ── 深度调查（直连）：0 token 路径 ──
    // 不经 agent runtime / Bedrock，BFF 直接调 DevOps Agent API（发起 + 轮询 journal + 读摘要
    // + 落 HTML 报告）。SSE 事件与老路径同形，故前端渲染/右侧「调查过程」面板零改动复用。
    // ⚠️ 老路径（agentRuntimeConfigured 分支）一行未改——新增分支置于其前，互不影响。
    try {
      const { runDirectInvestigation } = await import("./devops_investigate.mjs");
      reply = await runDirectInvestigation({
        text, locale, accountId, skillId, skillVersion,
        emit: (evt, data) => {
          // sources 与老路径一致地累积，供落库复用（历史回显时报告链接不丢）。
          if (evt === "sources") {
            for (const s of data?.sources || []) collectedSources.push(s);
            stream.write(sse("sources", { sources: collectedSources }));
            return;
          }
          if (evt === "usage") usage = data?.usage;
          stream.write(sse(evt, data || {}));
        },
      });
    } catch (e) {
      console.error(`[BFF] /stream direct investigation failed — ${e?.name || ""}: ${e?.message || e}`, e?.stack || "");
      if (!reply) {
        reply = locale === "en"
          ? "⚠️ The direct deep investigation failed to run. Please retry, or turn off “Deep Dive (Direct)” to use the standard Deep Dive."
          : "⚠️ 深度调查（直连）执行失败。请重试，或关闭「深度调查（直连）」改用普通「深度调查」。";
        stream.write(sse("token", { delta: reply }));
      }
    }
  } else if (agentRuntimeConfigured()) {
    // ── Phase 1：调 AgentCore Runtime（Strands agent），透传流式 ──
    // 冷启动兜底：AgentCore runtime 空闲回收后下次请求会冷启动，若容器初始化 >30s
    // 会被 kill 并抛 "Runtime initialization time exceeded"（RuntimeClientError）——
    // 此错误发生在**流开始前**（client.send 阶段），此时一个 token 都没吐，因此可安全重试
    // （第二次实例已在预热/已热）。streamedAny 守住"已吐内容就绝不重试"，避免重复输出。
    let streamedAny = false;

    // ── 冷启动"心跳"：runtime 空闲回收后首个请求要冷启动（client.send 阻塞、期间一片空白，
    // 客户只能干等）。这里在**首个真实产出前**周期性发一条瞬态 progress（分阶段文案），
    // 让等待有反馈。热启动首 token 通常 <5s，故延迟 5s 才开始发，避免热路径闪现"加载中"；
    // 之后每 10s 一条。任何来自 agent 的真实产出（token/progress/reasoning/…）即停并交还给
    // agent 自己的进度行。纯瞬态：走 progress 通道 → 前端收到正文即清空，不入库、不置 streamedAny，
    // 冷启动重试仍安全。 */
    // 文案里的秒数按实测走：2026-08-30 做完 MCP 规格快照 + 懒挂载后，冷启动首字
    // general 10.14s / finops 10.32s（n=5，每轮换 runtimeSessionId；口径见
    // scripts/measure_cold_start.py），此前是 23-24s，更早的 ~30-40s 是并行启动之前的数。
    // 第三条"马上就好"专门兜长尾 —— **刚部署新版本**的头一个会话仍可能 ~30s（要拉新镜像），
    // 所以第二条只说"约 10 秒"、不写死上限，长尾由第三条接住而不是把所有人都吓一跳。
    const COLD_MSGS = locale === "en"
      ? ["Loading session…", "Starting up the service (first request after idle, ~10s)…", "Almost ready — warming up the model…"]
      : ["会话加载中…", "正在启动服务（空闲后的首次请求，约 10 秒）…", "马上就好，正在预热模型…"];
    let sawAgentOutput = false;   // agent 已有任何真实产出 → 冷启动已过，停心跳
    let hbIdx = 0, hbFirst = null, hbTick = null;
    const beat = () => {
      if (sawAgentOutput) return;
      stream.write(sse("progress", { text: COLD_MSGS[Math.min(hbIdx, COLD_MSGS.length - 1)], kind: "coldstart" }));
      hbIdx++;
    };
    const startHeartbeat = () => {
      if (hbFirst || hbTick) return; // 幂等：整个重试周期共用一个心跳
      hbFirst = setTimeout(() => { beat(); hbTick = setInterval(beat, 10000); }, 5000);
    };
    const stopHeartbeat = () => {
      if (hbFirst) { clearTimeout(hbFirst); hbFirst = null; }
      if (hbTick) { clearInterval(hbTick); hbTick = null; }
    };
    const gotOutput = () => { sawAgentOutput = true; stopHeartbeat(); };

    const callbacks = {
      onToken: (delta) => { streamedAny = true; gotOutput(); stream.write(sse("token", { delta })); },
      onSources: (sources) => {
        for (const s of sources) collectedSources.push(s);
        stream.write(sse("sources", { sources: collectedSources }));
      },
      // 待确认的写操作（创建/回复/关闭 case）→ 前端渲染确认卡
      onActions: (actions) => { streamedAny = true; gotOutput(); stream.write(sse("actions", { actions })); },
      // 快捷后续按钮（如调查完成后的 生成缓解方案/转人工）→ 前端渲染成可点按钮
      onFollowups: (followups) => stream.write(sse("followups", { followups })),
      // 调查分析过程行 → 前端收进右侧「调查过程」面板（不刷主聊天）
      onInvestigationStep: (step) => { streamedAny = true; gotOutput(); stream.write(sse("investigation_step", { step })); },
      // 处理中进度行（工具调用等）→ 前端主聊天临时状态行。**不置 streamedAny**：这是瞬态提示、
      // 非答案内容，冷启动重试(在任何正文 token 之前)仍安全，不会造成重复输出。agent 一冒出进度
      // 就说明已热 → 停冷启动心跳，交还给 agent 自己的进度行。
      onProgress: (p) => { gotOutput(); stream.write(sse("progress", p || {})); },
      // 思考过程增量 → 前端可折叠灰字（默认折叠，收到正文即隐藏）。同样不置 streamedAny。
      onReasoning: (r) => { gotOutput(); stream.write(sse("reasoning", r || {})); },
      // 本轮 token 用量 → 前端在消息末尾显示「· N tokens」
      onUsage: (u) => { usage = u; stream.write(sse("usage", { usage: u })); },
      // runtime 流内异常帧（模型 5xx/限流等）。只记**类型**，不记原始报文
      // （docs/LOGGING_STANDARD.md）。文案由下面的 fallback 统一给，这里只保证可观测。
      onRuntimeError: (err) => {
        console.error(`[BFF] /stream agent runtime error frame — type=${err?.type || "?"} model=${model || "-"}`);
      },
    };
    // 冷启动类错误(容器初始化超时/未就绪)才重试；真实业务错误不重试。
    const isColdStart = (e) => {
      const m = String(e?.name || "") + " " + String(e?.message || e || "");
      return /Runtime initialization time exceeded|RuntimeClientError|not ready|initialization|ServiceUnavailable|throttl/i.test(m);
    };
    const MAX_ATTEMPTS = 3;
    let lastErr;
    startHeartbeat(); // 冷启动阻塞期间的过程提示（5s 后起，每 10s 一条；见 first token 即停）
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        reply = await invokeAgent(
          // allowedAccounts：可见性 RBAC 下发给 agent，防 prompt 点名账号绕过门禁
          { conversationId, prompt: text, model, generation, locale, webSearch, finopsAgent, devopsAgent, topic, accountId,
            allowedAccounts: await (async () => {
              // eff 在本函数作用域内自行计算（此前误引用 handler 作用域变量 → ReferenceError
              // 被重试循环吞掉 → 前端 "(no response)"。事故根因，勿再跨作用域引用。）
              const effLocal = await effective(sub, groups || []);
              const v = await visibleAccountSet(sub, groups || [], effLocal);
              return v === "*" ? "*" : [...v].join(",");
            })(),
            skillId, skillVersion },
          callbacks,
        );
        lastErr = undefined;
        break; // 成功（可能空文本，也当作完成，不重试）
      } catch (e) {
        lastErr = e;
        // 观测缺口教训：此前吞错不打日志 → "(no response)" 无迹可查。必须落 CloudWatch。
        console.error(`[BFF] /stream invokeAgent attempt ${attempt} failed — ${e?.name || ""}: ${e?.message || e}`, e?.stack || "");
        // 已经吐过内容 → 绝不重试（避免重复）；非冷启动错误 → 不重试；到达上限 → 停。
        if (streamedAny || !isColdStart(e) || attempt >= MAX_ATTEMPTS) break;
        // 冷启动重试：过渡提示走**瞬态 progress**（不污染答案正文，收到正文即清空），
        // 而非当作 token 写进 reply。退避后重试（心跳仍在跑，不重复起）。
        stream.write(sse("progress", {
          text: locale === "en" ? "Still starting up — retrying…" : "仍在启动中，正在重试…",
          kind: "coldstart",
        }));
        await sleep(attempt * 2000); // 2s、4s 退避，给冷启动实例完成初始化的时间
      }
    }
    stopHeartbeat(); // 循环结束（成功/失败/放弃）——务必停掉心跳，避免定时器泄漏到响应之后
    // 注意：**不**再往前端发 sse("error", {message: 原始报文})。
    // 一是违反日志/展示纪律（docs/LOGGING_STANDARD.md）——Bedrock 的原始报文里带
    // region / model id / 内部提示（Strands 还会追加 `└ Model id: …` 两行），不该进用户界面；
    // 二是会闪一下：前端 onError 把气泡先置成「⚠️ 原始报文」，紧接着下面的 token 又把它
    // 覆盖成友好文案，用户会看到一帧乱码似的英文错误。错误一律只走下面的 modelFailureText。
    // 排障靠 CloudWatch：上面 catch 里的 console.error 已记了 name/message/stack。
    if (!reply) {
      // 仍无产出——冷启动没醒给明确的下一步建议（区分 vs 真空响应），避免空白气泡。
      // 冷启动失败文案带"再发一次"引导：第二次请求通常已落到预热/已热实例。
      reply = lastErr && isColdStart(lastErr)
        ? (locale === "en"
            ? "⏳ The service is still starting up and didn't respond in time (cold start after idle).\n\n**Next step:** send your message again — the second request usually lands on an already-warmed instance and responds immediately."
            : "⏳ 服务仍在启动中，本次未能及时响应（空闲后的冷启动）。\n\n**下一步：** 请再发送一次消息 —— 第二次请求通常会落到已预热的实例，会立即响应。")
        : lastErr
          ? modelFailureText(locale, lastErr)
          : (locale === "en" ? "(no response)" : "（无响应）");
      stream.write(sse("token", { delta: reply }));
    }
  } else {
    // ── 回退：AGENT_RUNTIME_ARN 未配置时仍走 echo（Phase 0 部署兼容）──
    await sleep(300);
    reply =
      locale === "en"
        ? `Got it — you said: “${text}”. (Echo — AGENT_RUNTIME_ARN not set; deploy the agent runtime to enable the real agent.)`
        : `收到 —— 你说的是：“${text}”。（回显 —— 未配置 AGENT_RUNTIME_ARN；部署 agent runtime 后启用真 agent。）`;
    for (const ch of reply.match(/\s+|\S+/g) || [reply]) {
      stream.write(sse("token", { delta: ch }));
      await sleep(24);
    }
  }

  const ts = Date.now();
  await appendMessage(conversationId, {
    role: "assistant", text: reply, ts, model,
    sources: collectedSources.length ? collectedSources : undefined,
    usage: usage || undefined, // 持久化本轮用量，刷新后仍显示
    accountId: accountId || undefined, // 本轮针对账号(历史回复账号徽标用)
    // 答案来源：对话对象是客户自己的 DevOps Agent 时（普通直答**或**这一轮的直连深度调查），
    // 署名行不能写成 "AWS Bedrock (某模型)"。例外是「转人工支持」那一轮真的回落到我们的 agent
    // （escalateFallback → devopsAgent），那轮就该署我们的模型名。
    // 不落这个字段的后果：刷新页面后历史回复被错误署名成本地模型，且通用会话「对话对象」的
    // 重新上锁失去唯一依据。
    via: objDevops && !escalateFallback ? "devops-agent" : undefined,
  });
  await touchConversation(sub, conversationId, accountId);

  stopKeepalive(); // 收尾：务必在 end() 前停，否则定时器会写进已关闭的流
  stream.write(sse("done", { message_id: `m-${ts}` }));
  stream.end();
}
