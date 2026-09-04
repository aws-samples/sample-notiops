/**
 * Admin 管理面板：角色 / 用户 / 组映射 / 模块 四视图。
 * 权限树从后端全量能力清单（GET /admin/capabilities）动态生成——新增 dashboard
 * 只需在 config/capabilities.json 加节点，此处自动出现。
 *
 * 视觉：统一使用全站设计 token（--card/--line/--text/--muted/--orange/--blue/--green/--page），
 * 与 FinOps 等 tab 一致（此前用未定义的 --border/--danger/--ok/--accent → 吃死色 hex、不跟随主题）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useT, useLocale } from "../i18n";
import { loadConfig } from "../config";
import FeishuGuideDrawer from "./FeishuGuideDrawer";
import {
  fetchAllCapabilities, fetchRoles, saveRole, deleteRole,
  fetchUsers, putUser, createUser, deleteUser, fetchModules, putModules,
  fetchGroups, putGroupMap, createGroup, deleteGroup, fetchGroupMembers, addUserToGroup, removeUserFromGroup,
  fetchEol, putEol,
  fetchMemberAccounts, onboardMemberAccount, memberOnboardStatus, setMemberAccountEnabled,
  setMemberAccountRegions, setMemberAccountAlias, offboardMemberAccount,
  associateDevopsAgent, devopsAgentAssocStatus,
  fetchInspectionCrossAccount, verifyInspectionCollectionRole,
  associateInspectionSource,
  generateInspectionCollectionStack,
  type InspectionCrossAccountStatus,
  fetchAccountAccess, putAccountAccess, deleteAccountAccess,
  fetchNotificationConfig, putNotificationConfig, testNotificationSend,
  generateLaunchStack, saveManualPayload, testDaConnection,
  fetchLlmConfig, putLlmConfig, fetchLlmCandidates, putBedrockKey, testLlmModel,
  fetchLlmAudit, rollbackLlmConfig, fetchBackendTasks,
  type FullCapabilityNode, type RoleRec, type UserRec, type ModuleToggle, type GroupRec, type EolMap,
  type MemberAccountRec, type AccountVisibilityRec,
  type LlmConfig, type LlmModelEntry, type LlmCandidate, type BackendTaskRow,
  type ModelSurface, type ModelKind,
} from "../api/admin";

type Tab = "roles" | "users" | "groups" | "modules" | "accounts" | "lifecycle" | "notifications" | "models";
type TFn = (key: string) => string;
const ADMIN_ROLE = "role:admin";
const RED = "#d13212";

/* ── 设计 token 对齐的共享样式 ── */
const box: CSSProperties = { background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12 };
const inputStyle: CSSProperties = { padding: "7px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--page)", color: "var(--text)", fontSize: 13, outline: "none" };
const btnPrimary: CSSProperties = { padding: "7px 15px", borderRadius: 8, border: "1px solid var(--orange)", background: "var(--orange)", color: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" };
const btnGhost: CSSProperties = { padding: "7px 13px", borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--text)", fontWeight: 500, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" };
const iconBtn: CSSProperties = { padding: "3px 9px", borderRadius: 6, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", fontSize: 12, cursor: "pointer", lineHeight: 1.5 };
const okText: CSSProperties = { color: "var(--green)", fontSize: 12.5, fontWeight: 600 };
const errText: CSSProperties = { color: RED, fontSize: 12.5 };
/** ⓘ 弹层里的字段名（MODEL ID / REGION / …）。与 FieldLabel 同一视觉语言，但更小一号。 */
const infoKeyStyle: CSSProperties = { fontSize: 10, color: "var(--muted)", letterSpacing: .5, textTransform: "uppercase" };
// 服务端没下发 default_region 时的兜底（老版本 BFF / 响应被裁剪）。与 BFF 的
// MANTLE_REGION_DEFAULT、Python 的 _MANTLE_REGION_DEFAULT 是同一个值；
// scripts/test_mantle_regions_consistent.py 会断言三处一致。
const MANTLE_REGION_FALLBACK = "us-east-2";

/* 预置角色/Cognito 状态 → i18n key（无中文字面量，满足 i18n lint；未知值回退原文） */
const ROLE_KEY: Record<string, string> = {
  "role:admin": "admin.role.admin", "role:viewer": "admin.role.viewer", "role:finops": "admin.role.finops",
  "role:support": "admin.role.support", "role:developer": "admin.role.developer",
  "role:service-manager": "admin.role.serviceManager", "role:notifications": "admin.role.notifications",
};
const STATUS_KEY: Record<string, string> = {
  CONFIRMED: "admin.users.status.confirmed", FORCE_CHANGE_PASSWORD: "admin.users.status.forceChange",
  RESET_REQUIRED: "admin.users.status.resetRequired", UNCONFIRMED: "admin.users.status.unconfirmed", ARCHIVED: "admin.users.status.archived",
};
const roleName = (t: TFn, name: string) => (ROLE_KEY[name] ? t(ROLE_KEY[name]) : name);
const statusName = (t: TFn, s?: string) => (s ? (STATUS_KEY[s] ? t(STATUS_KEY[s]) : s) : "");
/** 默认 Cognito 组 → 友好名 i18n key（未知组回退原名） */
const GROUP_KEY: Record<string, string> = {
  admin: "admin.group.admin", member: "admin.group.member", "finops-team": "admin.group.finops-team",
  "sre-ops": "admin.group.sre-ops", "support-lead": "admin.group.support-lead",
  "service-manager": "admin.group.service-manager", "read-only": "admin.group.read-only", "dev-team": "admin.group.dev-team",
};
const groupName = (t: TFn, name: string) => (GROUP_KEY[name] ? t(GROUP_KEY[name]) : name);

function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700, color: "var(--text)", textTransform: "uppercase", letterSpacing: ".05em" }}>
        <span style={{ width: 3, height: 13, background: "var(--orange)", borderRadius: 2, display: "inline-block" }} />
        {title}
      </div>
      {sub && <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 5, marginLeft: 11, lineHeight: 1.5 }}>{sub}</div>}
    </div>
  );
}
const FieldLabel = ({ children }: { children: ReactNode }) => (
  <div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600, marginBottom: 5 }}>{children}</div>
);
/** 角色多选 chip（用户/组卡内复用） */
function RoleChip({ t, name, checked, onChange }: { t: TFn; name: string; checked: boolean; onChange: () => void }) {
  return (
    <label title={name} style={{
      display: "inline-flex", gap: 6, alignItems: "center", padding: "4px 10px", borderRadius: 100, cursor: "pointer",
      border: `1px solid ${checked ? "var(--orange)" : "var(--line)"}`, background: checked ? "rgba(255,153,0,.10)" : "transparent",
      fontSize: 12.5, fontWeight: checked ? 600 : 500, color: checked ? "var(--text)" : "var(--muted)",
    }}>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ margin: 0 }} />
      {roleName(t, name)}
    </label>
  );
}

export default function AdminPanel() {
  const t = useT();
  const [tab, setTab] = useState<Tab>("roles");
  const [caps, setCaps] = useState<FullCapabilityNode[]>([]);
  const [err, setErr] = useState("");

  useEffect(() => { fetchAllCapabilities().then(setCaps).catch((e) => setErr(String(e?.message || e))); }, []);

  return (
    <div className="admin-panel" style={{ padding: "18px 22px 40px", overflowY: "auto", height: "100%", maxWidth: 1080, margin: "0 auto", width: "100%", color: "var(--text)" }}>
      <SectionHead title={t("admin.title")} sub={t("admin.subtitle")} />

      {/* 分段 tab 切换（替代原侧栏风格按钮） */}
      <div style={{ display: "inline-flex", gap: 4, padding: 4, ...box, background: "var(--page)", borderRadius: 10, marginBottom: 18 }}>
        {(["roles", "users", "groups", "modules", "accounts", "lifecycle", "notifications", "models"] as Tab[]).map((k) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding: "6px 16px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 13,
            fontWeight: tab === k ? 700 : 500,
            background: tab === k ? "var(--card)" : "transparent",
            color: tab === k ? "var(--text)" : "var(--muted)",
            boxShadow: tab === k ? "0 1px 3px rgba(0,0,0,.14)" : "none",
          }}>{t(`admin.tab.${k}`)}</button>
        ))}
      </div>

      {err && <div style={{ ...errText, marginBottom: 12 }}>{t("admin.error")}: {err}</div>}
      {tab === "roles" && <RolesView caps={caps} />}
      {tab === "users" && <UsersView />}
      {tab === "groups" && <GroupsView />}
      {tab === "modules" && <ModulesView />}
      {tab === "accounts" && <AccountsView />}
      {tab === "lifecycle" && <LifecycleView />}
      {tab === "notifications" && <NotificationsView />}
      {tab === "models" && <ModelsView />}
    </div>
  );
}

/* ───────────────── 通知（飞书机器人配置）─────────────────
 * 自 web-chat 原生实现（存 Secrets Manager notiops/im-bot-feishu），与老管理前端
 * (frontend-app /settings/notifications) 完全解耦 —— 老页面 sunset 时此板块不受影响。
 * 敏感字段(app_secret / encrypt_key / verification_token)后端脱敏为 ****后4位；
 * 保存时回传脱敏值 = 不修改（bff/web-chat/feishu_config.mjs 的 mergeIfMasked）。
 *
 * Encrypt Key / Verification Token 为什么必须在这里能填:webhook 模式下它们是**唯一**
 * 鉴权手段，IM 入口冷启动硬校验、缺一即起不来。以前只能让客户
 * `aws secretsmanager put-secret-value` 手改 JSON —— 只有浏览器的客户走不通那条路，
 * 「一键集成 IM」就断在这一步。四个凭证齐了，客户不碰 CLI 也能配完。
 * ⚠️ 这两个值和 app_secret 一样:不打日志、连长度都不打（docs/LOGGING_STANDARD.md）。 */
type SecretKey = "app_secret" | "encrypt_key" | "verification_token";

/**
 * 飞书三个密钥框。三件事都不是样式问题：
 *
 * ① **没动过时 `type="text"`** —— 值是服务端给的脱敏串 `****后4位`，用 `password`
 *    会把后 4 位也画成圆点，旁边那句「仅显示后 4 位」就成了空话，客户也无从确认
 *    自己配的是哪一把。一旦用户开始输入立刻切 `password`（真明文不能明着摆在屏幕上，
 *    这一页经常是在共享屏幕里打开的）。
 * ② **autofill 谢绝**：`autoComplete="new-password"` + 各家密码管理器的忽略属性。
 *    自动填充进来的值不以 `****` 开头，后端会当成"改了新值"直接覆盖 Secrets Manager。
 * ③ **静默填充兜底**：`NotificationsView` 的 `touched` —— 没动过的框回传服务端原值，
 *    所以"不触发 input 事件"那种填充（直接改 DOM value）填了也改不了。这一层不依赖
 *    浏览器是否尊重 ②。**诚实的边界**：会正常派发 input 事件的密码管理器仍会把框标成
 *    touched，那种情况靠 ② 拦、靠 ① 让用户看得见值变了 —— 不是数学上的消除。
 */
function SecretField({ label, k, value, onChange, touched, setTouched, hint, placeholder }: {
  label: string;
  k: SecretKey;
  value: string;
  onChange: (v: string) => void;
  touched: Record<SecretKey, boolean>;
  setTouched: React.Dispatch<React.SetStateAction<Record<SecretKey, boolean>>>;
  hint: string;
  placeholder: string;
}) {
  const isMasked = !touched[k] && value.startsWith("****");
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        type={isMasked ? "text" : "password"}
        // 名字刻意不叫 password / secret：密码管理器按 name/id 猜字段。
        name={`notiops-feishu-${k}`}
        autoComplete="new-password"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        // 点进来先整串选中：第一个按键就把 `****WXYZ` 整个替换掉，而不是追加在它后面
        //（追加出来的 `****WXYZ<新>` 长度 >8，后端会当成真的新值写进 Secret）。
        // 刻意**不**在 focus 时清空、也不标 touched —— 那样"点错了又点走"就会把钥匙清掉。
        onFocus={(e) => { if (isMasked) e.currentTarget.select(); }}
        style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
        value={value}
        onChange={(e) => { setTouched((p) => ({ ...p, [k]: true })); onChange(e.target.value); }}
        placeholder={placeholder}
      />
      <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 4 }}>{hint}</div>
    </div>
  );
}

function NotificationsView() {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [encryptKey, setEncryptKey] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [chatIds, setChatIds] = useState<string[]>([""]);
  // IM 入口 webhook 地址（后端只读回带；没装 IM / 查不到 = 空串 → 抽屉退回文字说明）
  const [webhookUrl, setWebhookUrl] = useState("");
  /**
   * 三个密钥框「用户是否真的动过」。这不是体验优化，是**防覆盖**：
   *
   * ① 浏览器/密码管理器会往 `type=password` 框里自动填充，填进来的值不以 `****` 开头，
   *    后端的 `mergeIfMasked`（`bff/web-chat/feishu_config.mjs`）就把它当成"用户改了新值"
   *    直接写进 Secrets Manager —— 客户只是进这一页改个推送群组，三把钥匙就被静默换掉，
   *    然后飞书那边开始「校验失败」，而他会去查请求地址。
   * ② 所以保存时**没动过的框一律回传服务端给的原值**（脱敏串 = 保持不变），
   *    不看框里现在是什么。autoComplete 之类的提示只是"请浏览器别填"，
   *    这一条才是"填了也改不了"。
   *
   * 顺带解决显示问题：没动过时用 `type=text` 显示脱敏串，后 4 位才真的看得见
   *（`type=password` 会把 `****WXYZ` 的后 4 位也画成圆点，那句「仅显示后 4 位」就成了空话）；
   * 一动手输入立刻切回 `password`。
   */
  const [touched, setTouched] = useState<Record<"app_secret" | "encrypt_key" | "verification_token", boolean>>({
    app_secret: false, encrypt_key: false, verification_token: false,
  });
  /** 服务端给的脱敏原值，用于「没动过 → 原样回传」。 */
  const loaded = useRef({ app_secret: "", encrypt_key: "", verification_token: "" });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [guide, setGuide] = useState(false);   // 右侧「详细配置步骤」抽屉

  // ⚠️ `silent` 是给**首次加载**用的：`loading` 的初值已经是 true，
  //    那时再 `setLoading(true)` 是冗余的同步 setState —— React 19 的
  //    `react-hooks/set-state-in-effect` 会报错（effect 里同步 setState 会
  //    多触发一轮级联渲染）。手动重载时仍然要设，否则点了刷新没有反馈。
  const load = (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    fetchNotificationConfig()
      .then((r) => {
        setAppId(r.feishu.app_id || "");
        setAppSecret(r.feishu.app_secret || "");
        setEncryptKey(r.feishu.encrypt_key || "");
        setVerifyToken(r.feishu.verification_token || "");
        setWebhookUrl(r.feishu.webhook_url || "");
        // 重新拉取（含保存后的那次）都要把"动过"清掉，否则保存一次之后
        // 这三个框会一直被当成"用户改过的"，下次保存又把脱敏串当新值送上去。
        loaded.current = {
          app_secret: r.feishu.app_secret || "",
          encrypt_key: r.feishu.encrypt_key || "",
          verification_token: r.feishu.verification_token || "",
        };
        setTouched({ app_secret: false, encrypt_key: false, verification_token: false });
        const ids = (r.feishu.notify_chat_ids || "").split(",").map((s) => s.trim()).filter(Boolean);
        setChatIds(ids.length ? ids : [""]);
      })
      .catch((e) => setMsg({ ok: false, text: String(e?.message || e) }))
      .finally(() => setLoading(false));
  };
  // 🔴 **下面那条 disable 是针对规则误报的，不是偷懒。** 判据：`load`/`reload` 的**同步执行路径上
  //    已经没有 setState** 了（`silent: true` 跳过了唯一那一处）。剩下的
  //    `setAccounts` / `setMsg` / `setLoading` 全在 `.then/.catch/.finally`
  //    回调里 —— promise 回调是微任务，不在 effect 的同步路径上。
  //
  //    规则的静态分析追进被调函数体、看到里面有 setState 就报，分不清
  //    同步与异步边界。
  //
  // ⚠️ 不要用「把 setState 包一层骗过规则」的写法绕它 —— 那会让下一个人
  //    以为这里真有级联渲染问题，然后去改本来正确的代码。
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load({ silent: true }); }, []);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      // 没动过的密钥框回传**服务端给的原值**（脱敏串 = 保持不变），不看框里现在是什么 ——
      // 浏览器自动填充改不了任何一把钥匙。理由见 `touched` 的注释。
      const keep = (k: keyof typeof loaded.current, cur: string) =>
        touched[k] ? cur.trim() : loaded.current[k];
      const r = await putNotificationConfig({
        app_id: appId.trim(),
        // trim:这三个值是从飞书控制台**复制**来的，粘贴时带上尾随空格/换行是常事，
        // 而后果是验签 401 —— 症状「飞书显示校验失败」和"地址填错"长得一模一样。
        app_secret: keep("app_secret", appSecret),
        encrypt_key: keep("encrypt_key", encryptKey),
        verification_token: keep("verification_token", verifyToken),
        notify_chat_ids: chatIds.map((s) => s.trim()).filter(Boolean).join(","),
      });
      setMsg({ ok: true, text: r.message || t("admin.notif.saved") });
      load(); // 重新拉取,让 secret 显示为脱敏形态
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error)?.message || e) });
    } finally { setSaving(false); }
  };

  const test = async (idx: number) => {
    const id = chatIds[idx]?.trim();
    if (!id) return;
    setTesting(idx); setMsg(null);
    try {
      const r = await testNotificationSend(id);
      setMsg({ ok: r.success, text: r.message });
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error)?.message || e) });
    } finally { setTesting(null); }
  };

  return (
    <div>
      <SectionHead title={t("admin.notif.title")} />
      {loading ? <div style={{ color: "var(--muted)", fontSize: 13 }}>{t("admin.notif.loading")}</div> : (
        <div style={{ ...box, padding: 18, maxWidth: 640, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <FieldLabel>App ID</FieldLabel>
            <input style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }} value={appId}
              onChange={(e) => setAppId(e.target.value)} placeholder="cli_xxxx" />
          </div>
          <SecretField label="App Secret" k="app_secret" value={appSecret} onChange={setAppSecret}
            touched={touched} setTouched={setTouched} hint={t("admin.notif.secretHint")}
            placeholder={t("admin.notif.secretPh")} />
          {/* Encrypt Key / Verification Token —— webhook 模式的唯一鉴权手段，必填。
              与 App Secret 同样脱敏回显 + 一动手输入就变圆点，避免在客户共享屏幕时露出。 */}
          <SecretField label="Encrypt Key" k="encrypt_key" value={encryptKey} onChange={setEncryptKey}
            touched={touched} setTouched={setTouched} hint={t("admin.notif.encryptHint")}
            placeholder={t("admin.notif.secretPh")} />
          <SecretField label="Verification Token" k="verification_token" value={verifyToken} onChange={setVerifyToken}
            touched={touched} setTouched={setTouched} hint={t("admin.notif.tokenHint")}
            placeholder={t("admin.notif.secretPh")} />
          <div className="imx-steps-order">{t("admin.notif.keysRequired")}</div>
          <div>
            <FieldLabel>{t("admin.notif.chatIds")}</FieldLabel>
            <div style={{ color: "var(--muted)", fontSize: 11.5, margin: "-2px 0 7px" }}>{t("admin.notif.chatIdsHint")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {chatIds.map((id, i) => (
                <div key={i} style={{ display: "flex", gap: 8 }}>
                  <input style={{ ...inputStyle, flex: 1 }} value={id} placeholder="oc_xxxx"
                    onChange={(e) => setChatIds(chatIds.map((v, j) => (j === i ? e.target.value : v)))} />
                  <button style={iconBtn} disabled={testing === i || !id.trim()} onClick={() => test(i)}
                    title={t("admin.notif.testTip")}>
                    {testing === i ? t("admin.notif.testing") : t("admin.notif.test")}
                  </button>
                  <button style={iconBtn} onClick={() => setChatIds(chatIds.length > 1 ? chatIds.filter((_, j) => j !== i) : [""])}>✕</button>
                </div>
              ))}
            </div>
            <button style={{ ...btnGhost, marginTop: 8 }} onClick={() => setChatIds([...chatIds, ""])}>+ {t("admin.notif.addChat")}</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button style={btnPrimary} disabled={saving} onClick={save}>{saving ? t("admin.notif.saving") : t("admin.notif.save")}</button>
            {msg && <span style={msg.ok ? okText : errText}>{msg.text}</span>}
          </div>
        </div>
      )}

      {/* 飞书控制台那一半的活:四步速览摆在页面上（客户不必先去翻文档），
          详细步骤放右侧抽屉 —— 表单不被遮住，能一边看一边填。 */}
      <div className="imx-steps">
        <div className="imx-steps-title">{t("admin.notif.steps.title")}</div>
        <ol>
          <li>{t("admin.notif.steps.s1")}</li>
          <li>{t("admin.notif.steps.s2")}</li>
          <li>{t("admin.notif.steps.s3")}</li>
          <li>{t("admin.notif.steps.s4")}</li>
        </ol>
        <div className="imx-steps-order">{t("admin.notif.steps.order")}</div>
        <button className="imx-guide-link" onClick={() => setGuide(true)}>
          {t("admin.notif.guideLink")} <span aria-hidden="true">→</span>
        </button>
      </div>
      <FeishuGuideDrawer open={guide} onClose={() => setGuide(false)} webhookUrl={webhookUrl} />
    </div>
  );
}

/* ───────────────── 模型（LLM 目录 + 凭证 + 后端任务）─────────────────
 * 真源是 DynamoDB PK=llmcfg（spec: llm-provider-and-model-management）。
 * 这里勾选的启用集就是普通用户在对话框里能选到的全部模型 —— provider 与凭证不对普通
 * 用户开放，权限边界落在接口上（GET /models 只回启用集，/admin/llm-config 需 nav:admin）。
 * 保存后 generation 前进，长驻的 webchat microVM 与 IM bot 会在下一条消息重建实例。 */

/** 探测结果 → i18n key（无中文字面量；未知值回退原文）。 */
const TEST_KEY: Record<string, string> = {
  ok: "admin.models.test.ok", forbidden: "admin.models.test.forbidden",
  unauthorized: "admin.models.test.unauthorized", invalid_model: "admin.models.test.invalidModel",
  not_found: "admin.models.test.notFound", throttled: "admin.models.test.throttled",
  not_ready: "admin.models.test.notReady", timeout: "admin.models.test.timeout",
  error: "admin.models.test.error",
  // `skipped` 已不在服务端的返回集合里 —— Mantle 现在是真探测（早先返回 skipped 是把
  // 一个未实现固化成了「预期行为」，后果是 GPT 系上线前无法验证）。映射一并去掉，
  // 避免留着一个永不出现的分支让人以为「跳过」仍是正常结果。
  // 探测自身的请求参数被模型拒了（不是模型不可用）—— 见 BFF probeMantle/apiTestLlmModel
  probe_error: "admin.models.test.probeError",
  // 本区不支持按需直调，需改用 global./apac. 前缀的 inference profile
  needs_profile: "admin.models.test.needsProfile",
};
const MODEL_SURFACES: ModelSurface[] = ["webchat", "im"];
/* 后端任务的可选性判定（原 `backendEligible`）已删除。
 *
 * 它曾排除所有 `bedrock_mantle_responses`（GPT 系），理由是「后端链只走 Converse」。
 * 那是我们自己的实现缺口，不是模型限制 —— `shared/llm_provider.py` 的 `invoke_llm`
 * 现在有 Mantle Responses 分支，对话侧与后端侧已对齐：**目录里任何已启用的模型都能
 * 绑后端任务**，于是「列出但禁用 + 写原因」这套机制没有可触发的情形了。
 *
 * 一度保留过「Mantle 缺 region 则不可选」作为兜底，但那也是不可达的：候选添加会带上
 * region（服务端下发的 `default_region`），手填只会生成非 Mantle 的 kind，而已保存
 * 的目录早被 BFF 的逐模型校验挡过一轮。留着等于让人以为存在一种会被禁用的模型。 */
/** model_id → 建议 alias（[a-z0-9-]）。仅作预填，管理员可改。 */
function suggestAlias(modelId: string): string {
  return modelId.replace(/^[a-z]+\.(anthropic|openai|amazon|deepseek|meta|mistral)\./i, "")
    .replace(/^(anthropic|openai|amazon|deepseek|meta|mistral)\./i, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "model";
}

/**
 * model_id 前缀 → 推理路由范围的 i18n key。
 *
 * 这是数据驻留的**实际决定因素**，而管理员在界面上看到的只是一串不透明的 model_id。
 * Bedrock 的跨区推理配置文件把范围编码进了前缀：`global.` 路由到全球所有支持的商业
 * 区域，`us.` / `eu.` / `apac.` 限制在对应地理范围内，无前缀则跟随部署区域。
 * 也就是说「换成 us.anthropic.claude-sonnet-5」就是一次数据驻留变更 —— 把它显示出来，
 * 管理员才是在做知情选择，而不是在改一个看不懂的字符串。
 * https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html
 */
/** 路由范围（= 数据驻留范围）→ i18n key。
 *
 *  `scope` 优先用服务端给的值（`LlmCandidate.scope`，由 BFF 的 `routingScope()` 算出）。
 *  只在没有它时才按 model_id 前缀回推 —— 目录里已保存的条目不带 scope 字段，所以回推路径
 *  必须留着。
 *
 *  ⚠️ `kind` 参数不能省：Mantle（GPT 系）的 model_id **没有地理前缀**
 *  （`openai.gpt-5.6-terra`），按前缀回推会得到「本区域」，而它实际打的是
 *  `bedrock-mantle.us-east-2.api.aws` —— 在东京部署上，恰好是真正跨了边界的那批模型被标成
 *  "不跨区"。数据驻留标签给错答案比不给更危险，所以按 kind 显式判定。
 */
function routingScopeKey(modelId: string, opts?: { scope?: string; kind?: string }): string {
  const scope = opts?.scope;
  if (opts?.kind === "bedrock_mantle_responses" || scope === "mantle") {
    return "admin.models.routing.mantle";
  }
  const byScope: Record<string, string> = {
    global: "admin.models.routing.global",
    us: "admin.models.routing.us",
    eu: "admin.models.routing.eu",
    apac: "admin.models.routing.apac",
    jp: "admin.models.routing.jp",
    "us-gov": "admin.models.routing.usgov",
    regional: "admin.models.routing.regional",
  };
  if (scope && byScope[scope]) return byScope[scope];
  const id = (modelId || "").toLowerCase();
  // 前缀回推。顺序要紧：`us-gov.` 必须先判，否则 `us.` 的分支不会命中它（是 `us-` 不是 `us.`），
  // 会静默落到「本区域」。
  if (id.startsWith("us-gov.")) return "admin.models.routing.usgov";
  if (id.startsWith("global.")) return "admin.models.routing.global";
  if (id.startsWith("us.")) return "admin.models.routing.us";
  if (id.startsWith("eu.")) return "admin.models.routing.eu";
  if (id.startsWith("jp.")) return "admin.models.routing.jp";
  if (id.startsWith("apac.") || id.startsWith("au.")) return "admin.models.routing.apac";
  return "admin.models.routing.regional";
}

/** 候选分组的展示顺序。把最常被选的厂商顶上去 —— 候选有 90+ 条（基座模型 + 跨区域
 *  inference profile），按 AWS 返回的原始顺序平铺时，找 Claude 只能靠滚动翻。 */
const PROVIDER_ORDER = ["Anthropic", "Amazon", "OpenAI", "DeepSeek", "Meta", "Mistral AI"];

/** 候选排序：厂商优先级 → 组内跨区域 profile 优先（本目录默认用 global.*）→ 名称。
 *  同一个模型会同时以基座（`anthropic.claude-sonnet-5`）和 profile
 *  （`global.anthropic.claude-sonnet-5`）两种形式出现，profile 排在前面，避免管理员
 *  选了本区域形式却与目录里实际生效的 ID 不一致。 */
function sortCandidates(list: LlmCandidate[]): LlmCandidate[] {
  const rank = (c: LlmCandidate) => {
    const p = PROVIDER_ORDER.indexOf(c.provider_name || "");
    return p === -1 ? PROVIDER_ORDER.length : p;
  };
  return [...list].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    const pa = (a.provider_name || "").localeCompare(b.provider_name || "");
    if (pa !== 0) return pa;
    const ga = a.model_id.startsWith("global.") ? 0 : 1;
    const gb = b.model_id.startsWith("global.") ? 0 : 1;
    if (ga !== gb) return ga - gb;
    return (a.label || a.model_id).localeCompare(b.label || b.model_id);
  });
}

/** 搜索匹配：label 与 model_id 都参与，空格分隔的词需**全部**命中（AND）。
 *  这样输入「claude 5」既能命中 `Claude Sonnet 5`，也能命中
 *  `global.anthropic.claude-sonnet-5` —— 用户记得的是"Claude 5"，而列表里的字符串
 *  有三种写法，单串前缀匹配会让人以为模型不存在。连字符与点视作分隔符。 */
function candMatches(c: LlmCandidate, query: string): boolean {
  const hay = `${c.label || ""} ${c.model_id} ${c.provider_name || ""}`
    .toLowerCase().replace(/[-_.]/g, " ");
  // 查询串按「空白 + 连字符 + 下划线 + 点」**切成多个词**。
  // 早先的写法是每个词内部把分隔符替换成空格，那等于把 `claude-5` 变成一个
  // **短语** "claude 5" 去做连续子串匹配 —— 而干草堆里是 "claude sonnet 5"，
  // 中间夹着 sonnet，于是恒不命中：`claude 5` 有 10 条结果，`claude-5` 是 0 条。
  // 而列表里每个 model_id 都是连字符形式，`claude-5` 正是最自然的输入。
  return candTokens(query).every((w) => hay.includes(w));
}

/** 查询串 → 词元。分隔符与干草堆的归一化保持一致，避免两边规则漂移。 */
function candTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/[\s\-_.]+/).filter(Boolean);
}

function ModelsView() {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [cfg, setCfg] = useState<LlmConfig | null>(null);
  const [models, setModels] = useState<LlmModelEntry[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [credMode, setCredMode] = useState<"iam" | "api_key">("iam");
  const [tasks, setTasks] = useState<Record<string, string>>({});
  const [taskRows, setTaskRows] = useState<BackendTaskRow[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [candidates, setCandidates] = useState<LlmCandidate[]>([]);
  const [candWarn, setCandWarn] = useState("");
  /** 候选列表是用哪个身份枚举出来的（服务端 `source_identity`）。
   *  `iam_fallback` 必须显眼：那时列表来自部署角色，而推理用 Key，两者可能**不是同一批
   *  模型** —— 管理员会选中一个 Key 调不了的模型，直到用户发消息才 403。 */
  const [candSource, setCandSource] = useState("");
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");
  const [candQuery, setCandQuery] = useState("");
  const [manualId, setManualId] = useState("");
  const [manualLabel, setManualLabel] = useState("");
  const [testing, setTesting] = useState<string>("");
  const [results, setResults] = useState<Record<string, string>>({});
  /** 哪一行的技术标识弹层是展开的（alias；空串 = 全收起）。单值 ⇒ 天然互斥，
   *  打开一行会收起另一行，不会堆出一屏弹层。 */
  const [infoOpen, setInfoOpen] = useState<string>("");
  /** 最近一次探测**实际使用**的凭证（服务端回的 `credential`：api_key / iam）。
   *  用来把「已验证」说清楚 —— 选了 API Key 但 Key 是空的时，服务端会回退 IAM，
   *  此时绿勾证明的只是部署角色能调，与 Key 无关。 */
  const [probeCred, setProbeCred] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [audit, setAudit] = useState<Awaited<ReturnType<typeof fetchLlmAudit>>["entries"]>([]);

  // ⚠️ `silent` 是给**首次加载**用的：`loading` 的初值已经是 true，
  //    那时再 `setLoading(true)` 是冗余的同步 setState —— React 19 的
  //    `react-hooks/set-state-in-effect` 会报错（effect 里同步 setState 会
  //    多触发一轮级联渲染）。手动重载时仍然要设，否则点了刷新没有反馈。
  const load = (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    fetchLlmConfig()
      .then((c) => {
        setCfg(c);
        setModels(c.models.map((m) => ({ ...m })));
        setDefaultModel(c.default_model);
        setCredMode(c.credential_mode);
        const tk: Record<string, string> = {};
        for (const [k, v] of Object.entries(c.backend_tasks || {})) tk[k] = String(v || "");
        setTasks(tk);
      })
      .catch((e) => setMsg({ ok: false, text: String(e?.message || e) }))
      .finally(() => setLoading(false));
    fetchBackendTasks().then((r) => setTaskRows(r.tasks)).catch(() => { /* 非关键：仅用于同步提示 */ });
  };
  // 🔴 **下面那条 disable 是针对规则误报的，不是偷懒。** 判据：`load`/`reload` 的**同步执行路径上
  //    已经没有 setState** 了（`silent: true` 跳过了唯一那一处）。剩下的
  //    `setAccounts` / `setMsg` / `setLoading` 全在 `.then/.catch/.finally`
  //    回调里 —— promise 回调是微任务，不在 effect 的同步路径上。
  //
  //    规则的静态分析追进被调函数体、看到里面有 setState 就报，分不清
  //    同步与异步边界。
  //
  // ⚠️ 不要用「把 setState 包一层骗过规则」的写法绕它 —— 那会让下一个人
  //    以为这里真有级联渲染问题，然后去改本来正确的代码。
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load({ silent: true }); }, []);

  const loadCandidates = () => {
    setAdding(true);
    if (candidates.length) return;
    fetchLlmCandidates()
      .then((r) => {
        setCandidates(r.models || []);
        setCandWarn(r.warning || "");
        setCandSource(r.source_identity || "");
      })
      .catch((e) => setCandWarn(String(e?.message || e)));
  };

  const patch = (alias: string, p: Partial<LlmModelEntry>) =>
    setModels((prev) => prev.map((m) => (m.alias === alias ? { ...m, ...p } : m)));

  const toggleSurface = (m: LlmModelEntry, s: ModelSurface) => {
    const next = m.surfaces.includes(s) ? m.surfaces.filter((x) => x !== s) : [...m.surfaces, s];
    patch(m.alias, { surfaces: next });
  };

  /** 新条目的公共骨架。上限给一个多数模型都安全的值，管理员可按该模型文档调高 ——
   *  设太低会静默截断回复，所以这个字段在行内是可见可改的。 */
  const newEntry = (modelId: string, label: string, kind: ModelKind,
                    region: string | null): LlmModelEntry => {
    let alias = suggestAlias(modelId);
    while (models.some((m) => m.alias === alias)) alias = `${alias}-2`;
    return {
      alias, short: null, aliases_legacy: [], model_id: modelId, label: label || modelId,
      kind, region,
      hard_output_limit: 8192,
      output_override: null, supports_prompt_cache: false,
      // 两个端都勾上：validateConfig 要求每个端至少有一个启用模型，只勾 webchat 的话，
      // 一个只剩这条新模型的目录会被拒（400），管理员很难看出原因。
      surfaces: ["webchat", "im"],
      // **添加即启用**。此前默认 false，于是「加完模型 → 保存」必然 400
      // （"at least one model must be enabled"），管理员得再回来逐个勾一遍才明白。
      // 启用开关的真正用途是**下架**已有模型（enabled=false 保留条目以留住历史落款，
      // 见 spec R2.7），不该同时充当"首次可用"的门槛 —— 显式添加一个模型就是想用它。
      enabled: true,
    };
  };

  /** 追加一个条目并维持不变量：目录里若还没有默认模型，这条就是默认。
   *  让「添加」这一个动作产生一个**可直接保存**的合法配置，而不是留三个待办给管理员。 */
  const appendEntry = (entry: LlmModelEntry) => {
    setModels((prev) => [...prev, entry]);
    setDefaultModel((prev) => prev || entry.alias);
  };

  const addFromCandidate = () => {
    const c = candidates.find((x) => x.model_id === pick);
    if (!c) return;
    appendEntry(newEntry(
      c.model_id, c.label || c.model_id, c.kind,
      // 默认区用服务端下发的 `default_region`，**不要退回 `regions[0]`**：那个名单按区域名
      // 排序，扩容时谁排第一会变。实际发生过 —— 名单从 2 个区扩到 14 个区后，`regions[0]`
      // 把默认区从 us-east-2 静默变成 us-east-1，而 runtime 的 IAM 当时只授了
      // us-east-2/us-west-2，于是配置存得进去、聊天时才 403。
      c.kind === "bedrock_mantle_responses"
        ? (c.default_region || MANTLE_REGION_FALLBACK) : null,
    ));
    setPick(""); setCandQuery(""); setAdding(false);
  };

  /** 手填 model_id。候选枚举列不出来时（跨账号 Key 指向的模型不在本账号候选里、
   *  或 ListFoundationModels 无权限）这是唯一入口 —— 服务端文档一直承诺有它，
   *  但 UI 此前并未提供。加进来之前，候选为空就等于彻底加不了模型。 */
  const addManual = () => {
    const id = manualId.trim();
    if (!id) return;
    if (models.some((m) => m.model_id === id)) { setManualId(""); return; }
    const kind: ModelKind = /anthropic/i.test(id) ? "bedrock_anthropic" : "bedrock_converse";
    appendEntry(newEntry(id, manualLabel.trim() || id, kind, null));
    setManualId(""); setManualLabel(""); setAdding(false);
  };

  const test = async (m: LlmModelEntry) => {
    setTesting(m.alias); setMsg(null);
    try {
      await runProbe(m);
    } finally { setTesting(""); }
  };

  /** 单模型探测 + 落状态。抽出来给「全部测试」复用，避免两处各写一遍成功判定。 */
  const runProbe = async (m: LlmModelEntry) => {
    try {
      const r = await testLlmModel({ model_id: m.model_id, kind: m.kind, region: m.region || undefined });
      setResults((p) => ({ ...p, [m.alias]: r.result }));
      // 服务端回的 `credential` 说明这次验的是哪种凭证。记下来，因为「用你的 Key 验过」
      // 和「用部署角色验过」是两个不同的保证 —— 后者在 api_key 模式下等于没验。
      if (r.credential) setProbeCred(r.credential);
      // 只认 "ok"。此前还把 "skipped" 当通过，理由是「BFF 无法探测 Mantle」——
      // 那个前提已不成立（Mantle 现在是真探测，不再返回 skipped）。继续把 skipped
      // 当成功等于给一个从未被验证的模型盖绿章。
      // 不再把结果写回目录（`verified` 字段已删除）。探测结论只属于**这一次**：
      // 它依赖模型 × 区域 × 凭证 × 时刻，持久化就会变成一个过期的假绿。
      // 保存时服务端会对默认模型再现场探一次，那才是拦住不可用模型的地方。
      return r.result;
    } catch (e) {
      setResults((p) => ({ ...p, [m.alias]: "error" }));
      setMsg({ ok: false, text: String((e as Error)?.message || e) });
      return "error";
    }
  };

  /**
   * 「全部测试」—— 逐个探测已启用的模型。
   *
   * 这就是「测试这个 Key 能调哪些模型」的**可行形态**：AWS 没有「列出某凭证可调模型」
   * 的 API（ListFoundationModels 返回的是区域内的全部模型，与调用者权限无关），所以
   * 唯一可靠的答案只能由逐个真调换回来。换 Key 之后想确认哪些模型仍可用，这是入口。
   * 串行：Bedrock 对探测这种小请求也会限流，并发打过去容易换回一片 throttled，
   * 那种假红比慢几秒更糟。
   */
  const testAll = async () => {
    const targets = models.filter((m) => m.enabled);
    if (!targets.length) return;
    setMsg(null);
    for (const m of targets) {
      setTesting(m.alias);
      await runProbe(m);
    }
    setTesting("");
  };

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const r = await putLlmConfig({
        provider: "bedrock",
        credential_mode: credMode,
        default_model: effectiveDefault,
        models,
        backend_tasks: Object.fromEntries(Object.entries(tasks).map(([k, v]) => [k, v || null])),
      });
      setMsg({ ok: !r.warning, text: r.warning || r.message || t("admin.models.saved") });
      load();
    } catch (e) {
      // 409 = 有人先改了；文案提示重新载入，避免把对方的改动覆盖掉
      setMsg({ ok: false, text: String((e as Error)?.message || e) });
    } finally { setSaving(false); }
  };

  const saveKey = async (clear: boolean) => {
    setSaving(true); setMsg(null);
    try {
      const r = await putBedrockKey(clear ? { clear: true } : { api_key: apiKey.trim() });
      setApiKey("");
      // 换了凭证，页面上那批测试结果就不再代表现在的状况 —— 清掉，别让管理员对着一屏
      // 用旧 Key 得到的绿字做判断。提示他用新 Key 重测一遍。
      setMsg({ ok: true, text: `${r.message} — ${t("admin.models.keyChangedRetest")}` });
      setResults({});
      setProbeCred("");
      load();
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error)?.message || e) });
    } finally { setSaving(false); }
  };

  const openAudit = () => {
    setAuditOpen(!auditOpen);
    if (!auditOpen && !audit.length) fetchLlmAudit().then((r) => setAudit(r.entries || [])).catch(() => { /* ignore */ });
  };

  const doRollback = async (sk: string) => {
    setSaving(true); setMsg(null);
    try {
      const r = await rollbackLlmConfig(sk);
      setMsg({ ok: !r.warning, text: r.warning || r.message });
      load();
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error)?.message || e) });
    } finally { setSaving(false); }
  };

  const enabledCount = models.filter((m) => m.enabled).length;
  const testLabel = (r?: string) => (r ? (TEST_KEY[r] ? t(TEST_KEY[r]) : r) : "");

  // 候选的可选集与当前匹配集。提到 JSX 之外：`pickVisible` 需要它，且它也是
  // 「加载中 / 加载失败 / 全部已加入 / 无匹配」四个态能被区分开的前提。
  const availCandidates = sortCandidates(
    candidates.filter((c) => !models.some((m) => m.model_id === c.model_id)),
  );
  const shownCandidates = availCandidates.filter((c) => candMatches(c, candQuery));
  const pickVisible = !!pick && shownCandidates.some((c) => c.model_id === pick);

  // 默认模型收敛到启用集内。触发场景：取消勾选当前默认那条、或把它删掉 —— 此时
  // default_model 会指向一个非启用项，保存必被服务端拒（"default model must be enabled"）。
  // 与其让管理员再撞一次 400 并自己找出是哪一条，不如就近改正：落到第一个启用项上。
  // 这是纠正而非猜测：不变量本身要求默认模型 ∈ 启用集，候选只有一个合法方向。
  //
  // 用**派生值**而不是 useEffect+setState：后者会在每次 models 变化后多跑一轮渲染
  // （eslint 也会拦：Calling setState synchronously within an effect）。这里读的时候
  // 算一次即可，保存时用的也是这个收敛后的值。
  const effectiveDefault = models.some((m) => m.alias === defaultModel && m.enabled)
    ? defaultModel
    : (models.find((m) => m.enabled)?.alias || "");

  /** 保存前的不变量预检 —— 与服务端 validateConfig 同源的那几条。
   *
   *  为什么要在前端重复一遍：服务端拒绝是**正确**的，但让 400 成为管理员的第一次反馈是
   *  糟糕的交互 —— 他刚把模型加进列表、点保存，只看到一个 `http_400`，而真实原因
   *  （"一个都没启用"）藏在响应体里。这里把同样的判断提前到点击之前，并直接指出该做什么。
   *  服务端校验仍是唯一权威（前端可被绕过），这里只负责"别让用户白撞一次"。
   */
  const blockers: string[] = [];
  if (models.length === 0) blockers.push(t("admin.models.needAtLeastOne"));
  else if (enabledCount === 0) blockers.push(t("admin.models.needEnabled"));
  else if (!effectiveDefault) blockers.push(t("admin.models.needDefault"));
  else {
    // 这里曾有「默认模型必须 verified」一条，镜像服务端的同名校验。两者都已删除：
    // `verified` 是个会过期的快照，服务端改为**保存时现场探测**默认模型。
    // 因此这条预检也不该留 —— 前端无法在不发请求的情况下知道模型此刻能不能调，
    // 硬留下来只会变成一条凭陈旧数据阻止保存的假拦截。
    // 每个端至少一个启用模型：少了这条，那个端的用户会拿不到任何可选模型。
    for (const s of MODEL_SURFACES) {
      if (!models.some((m) => m.enabled && m.surfaces.includes(s))) {
        blockers.push(t("admin.models.needSurface").replace("{surface}", t(`admin.models.surface.${s}`)));
      }
    }
  }

  return (
    <div>
      <SectionHead title={t("admin.models.title")} sub={t("admin.models.sub")} />
      {loading ? <div style={{ color: "var(--muted)", fontSize: 13 }}>{t("admin.models.loading")}</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          {/* ── Provider 与凭证 ── */}
          <div style={{ ...box, padding: 18, maxWidth: 780, display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <FieldLabel>{t("admin.models.provider")}</FieldLabel>
              <select style={{ ...inputStyle, width: 240 }} value="bedrock" disabled>
                <option value="bedrock">Amazon Bedrock</option>
              </select>
              <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 4 }}>{t("admin.models.providerHint")}</div>
            </div>
            <div>
              <FieldLabel>{t("admin.models.credMode")}</FieldLabel>
              <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
                {(["iam", "api_key"] as const).map((mode) => (
                  <label key={mode} style={{ display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                    <input type="radio" checked={credMode === mode} onChange={() => setCredMode(mode)} style={{ margin: 0 }} />
                    {t(`admin.models.cred.${mode}`)}
                  </label>
                ))}
              </div>
              <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 4 }}>{t("admin.models.credHint")}</div>
              {credMode === "api_key" && (
                // 诚实性：这条提示要说清 Key 到底覆盖到哪。四条消费路径都已接线 ——
                // webchat runtime（model/load.py）、IM bot（core/bedrock_credentials.py +
                // core/openai_responses_client.py）、后端任务（shared/llm_provider.py），
                // 且对 Converse 与 Mantle(GPT) 两类模型都生效。
                // 此处原写「IM bot 尚未接线（待做）」+「GPT 系不受 Key 影响（R5.7）」，
                // 两条都已不成立，别照着它把代码改回去。文案见 admin.models.credApiKeyScope。
                <div style={{ ...errText, fontSize: 11.5, marginTop: 6 }}>
                  {t("admin.models.credApiKeyScope")}
                </div>
              )}
            </div>
            {credMode === "api_key" && (
              <div>
                <FieldLabel>Bedrock API Key</FieldLabel>
                <div style={{ display: "flex", gap: 8 }}>
                  <input type="password" style={{ ...inputStyle, flex: 1 }} value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)} placeholder={t("admin.models.keyPh")} />
                  <button style={btnGhost} disabled={saving || !apiKey.trim()} onClick={() => saveKey(false)}>
                    {t("admin.models.keySave")}
                  </button>
                  <button style={iconBtn} disabled={saving || !cfg?.bedrock_api_key.configured} onClick={() => saveKey(true)}>
                    {t("admin.models.keyClear")}
                  </button>
                </div>
                <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 4 }}>
                  {cfg?.bedrock_api_key.configured
                    ? `${t("admin.models.keySet")} ****${cfg.bedrock_api_key.last_4 || ""}`
                    : t("admin.models.keyUnset")}
                  {" · "}{t("admin.models.keyHint")}
                </div>
                {/* 谁在何时设的（spec R5.6 的 set_by / set_at）。Key 是共享凭证，出问题时
                    「谁换过它」是第一个要问的问题；只显示后 4 位定位不到人。 */}
                {cfg?.bedrock_api_key.configured && (cfg.bedrock_api_key.set_at || cfg.bedrock_api_key.set_by) && (
                  <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 2 }}>
                    {t("admin.models.keySetBy")
                      .replace("{who}", cfg.bedrock_api_key.set_by || t("admin.models.keySetByUnknown"))
                      .replace("{when}", (cfg.bedrock_api_key.set_at || "").slice(0, 10))}
                  </div>
                )}
                {/* 轮换提示（R5.6）。判定在服务端算好（`rotation_due`），前端不重算 ——
                    两边各算一遍迟早漂移，而这是一条安全提示。 */}
                {cfg?.bedrock_api_key.rotation_due && (
                  <div style={{ ...errText, fontSize: 11.5, marginTop: 2 }}>
                    {t("admin.models.keyRotationDue")
                      .replace("{days}", String(cfg.bedrock_api_key.age_days ?? ""))
                      .replace("{limit}", String(cfg.bedrock_api_key.rotation_days ?? 90))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── 模型清单（勾选即用户可见）── */}
          <div style={{ ...box, padding: 18 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{t("admin.models.listTitle")}</div>
              <div style={{ color: "var(--muted)", fontSize: 11.5 }}>
                {t("admin.models.enabledCount").replace("{n}", String(enabledCount))}
              </div>
              {/* 「全部测试」——「这个 Key 能调哪些模型」只能靠逐个真调换回来，AWS 没有
                  按凭证列模型的 API。换 Key 后想确认哪些模型仍可用，用这个。 */}
              <button style={{ ...iconBtn, marginLeft: "auto" }} onClick={testAll}
                disabled={Boolean(testing) || !enabledCount} title={t("admin.models.testAllTip")}>
                {testing ? t("admin.models.testing") : t("admin.models.testAll")}
              </button>
            </div>
            {/* 探测用的是哪种凭证。选了 API Key 但 Key 为空时服务端会回退 IAM —— 那时
                绿勾只证明部署角色能调，与 Key 无关，必须说清楚。 */}
            {probeCred && (
              <div style={{
                fontSize: 11.5, marginTop: -4, marginBottom: 8,
                color: probeCred === "api_key" ? "var(--muted)" : RED,
              }}>
                {t(probeCred === "api_key"
                  ? "admin.models.probedWithKey"
                  : "admin.models.probedWithRole")}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {models.map((m) => (
                <div key={m.alias} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", borderRadius: 9,
                  border: `1px solid ${m.enabled ? "var(--orange)" : "var(--line)"}`,
                  background: m.enabled ? "rgba(255,153,0,.06)" : "transparent", flexWrap: "wrap",
                }}>
                  <label style={{ display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer", minWidth: 190 }}>
                    <input type="checkbox" checked={m.enabled} style={{ margin: 0 }}
                      onChange={() => patch(m.alias, { enabled: !m.enabled })} />
                    <span style={{ fontSize: 13, fontWeight: m.enabled ? 600 : 500 }}>{m.label || m.alias}</span>
                  </label>
                  {/* 技术标识（model_id / region）收进 ⓘ 弹层，不再平铺在行内。
                      平铺时这段最长到 ~50 字符（`openai.gpt-5.6-terra · us-east-2` 再加
                      「跨区(Mantle 端点)」），把后面的 Web/IM、默认、输出上限、测试全挤到
                      换行，整行错位 —— 而它们是**查阅**用的，不需要每行都读。
                      路由范围徽章留在行内：那是数据驻留结论，藏起来等于降低安全可见性。 */}
                  <span style={{
                    position: "relative", display: "inline-flex", alignItems: "center",
                    gap: 6, flex: 1, minWidth: 130,
                  }}>
                    <span style={{
                      fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 5,
                      whiteSpace: "nowrap", border: "1px solid var(--line)", color: "var(--muted)",
                    }}>{t(routingScopeKey(m.model_id, { kind: m.kind }))}</span>
                    <button type="button" aria-expanded={infoOpen === m.alias}
                      aria-label={t("admin.models.infoBtn")} title={t("admin.models.infoBtn")}
                      style={{ ...iconBtn, padding: "0 7px", borderRadius: 100, fontSize: 13 }}
                      onClick={() => setInfoOpen(infoOpen === m.alias ? "" : m.alias)}>ⓘ</button>
                    {infoOpen === m.alias && (
                      <span style={{
                        ...box, position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 20,
                        padding: "10px 12px", width: 340, display: "flex",
                        flexDirection: "column", gap: 3,
                        boxShadow: "0 6px 20px rgba(0,0,0,.18)",
                      }}>
                        <span style={infoKeyStyle}>{t("admin.models.infoModelId")}</span>
                        <code style={{ fontSize: 11.5, wordBreak: "break-all" }}>{m.model_id}</code>
                        {m.region && (
                          <>
                            <span style={{ ...infoKeyStyle, marginTop: 5 }}>{t("admin.models.infoRegion")}</span>
                            <code style={{ fontSize: 11.5 }}>{m.region}</code>
                          </>
                        )}
                        <span style={{ ...infoKeyStyle, marginTop: 5 }}>{t("admin.models.infoRouting")}</span>
                        <span style={{ fontSize: 11.5 }}>
                          {t(routingScopeKey(m.model_id, { kind: m.kind }))}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.55, marginTop: 3 }}>
                          {t("admin.models.routingTip")}
                        </span>
                        {m.kind === "bedrock_mantle_responses" && (
                          <span style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.55, marginTop: 5 }}>
                            {t("admin.models.infoMantle")}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  <div style={{ display: "flex", gap: 5 }}>
                    {MODEL_SURFACES.map((s) => (
                      <label key={s} title={t(`admin.models.surface.${s}`)} style={{
                        display: "inline-flex", gap: 4, alignItems: "center", padding: "3px 9px", borderRadius: 100,
                        cursor: "pointer", fontSize: 11.5,
                        border: `1px solid ${m.surfaces.includes(s) ? "var(--blue)" : "var(--line)"}`,
                        color: m.surfaces.includes(s) ? "var(--text)" : "var(--muted)",
                      }}>
                        <input type="checkbox" checked={m.surfaces.includes(s)} style={{ margin: 0 }}
                          onChange={() => toggleSurface(m, s)} />
                        {t(`admin.models.surface.${s}`)}
                      </label>
                    ))}
                  </div>
                  <label title={t("admin.models.defaultTip")} style={{
                    display: "inline-flex", gap: 5, alignItems: "center", fontSize: 11.5,
                    color: effectiveDefault === m.alias ? "var(--text)" : "var(--muted)",
                    cursor: m.enabled ? "pointer" : "not-allowed", opacity: m.enabled ? 1 : 0.5,
                  }}>
                    <input type="radio" checked={effectiveDefault === m.alias} disabled={!m.enabled}
                      onChange={() => setDefaultModel(m.alias)} style={{ margin: 0 }} />
                    {t("admin.models.default")}
                  </label>
                  {/* 裸数字框曾被误认成端口号 —— 加上可见的名字与单位。它是该模型单次回复的
                      输出上限，设太低会把长回答静默截断，所以保持行内可见可改。 */}
                  <label title={t("admin.models.capTip")} style={{
                    display: "inline-flex", gap: 5, alignItems: "center",
                    fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap",
                  }}>
                    {t("admin.models.cap")}
                    <input style={{ ...inputStyle, width: 82, fontSize: 11.5 }} type="number" min={1}
                      value={m.hard_output_limit}
                      onChange={(e) => patch(m.alias, { hard_output_limit: Number(e.target.value) || 0 })} />
                    {t("admin.models.capUnit")}
                  </label>
                  <button style={iconBtn} disabled={testing === m.alias} onClick={() => test(m)}
                    title={t("admin.models.testTip")}>
                    {testing === m.alias ? t("admin.models.testing") : t("admin.models.testBtn")}
                  </button>
                  {/* 只在点过「测试」之后显示这一次的结果，没点过就什么都不显示。
                      这里曾有一个「未测试」占位，那是持久化 `verified` 字段留下的语义 ——
                      当时它是个状态（存在 DDB 里、参与保存门禁）。字段删掉之后，「未测试」
                      就退化成了一句废话：它对每个模型、每次打开页面都成立，既不代表模型有
                      问题，也不代表管理员漏了一步，却占着一列宽度让本就挤的行更难读。
                      可用性由保存时的现场探测负责，不需要页面上有个常驻标记。 */}
                  {results[m.alias] ? (
                    <span style={{ fontSize: 11.5,
                      color: results[m.alias] === "ok" ? "var(--green)" : RED }}>
                      {testLabel(results[m.alias])}
                    </span>
                  ) : null}
                  <button style={iconBtn} title={t("admin.models.remove")}
                    onClick={() => setModels(models.filter((x) => x.alias !== m.alias))}>✕</button>
                </div>
              ))}
            </div>
            {adding ? (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                {/* 候选选择器。原先是一个原生 <select>：90+ 条、零排序、无法搜索，
                    找 Claude 5 只能滚动翻，而它还同时以 `anthropic.*` 与 `global.anthropic.*`
                    两种形式存在 —— 实测管理员的结论是"这个模型没有"。
                    改成 搜索 + 按厂商分组 + 路由范围徽章。 */}
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input style={{ ...inputStyle, minWidth: 260 }} value={candQuery} autoFocus
                    aria-label={t("admin.models.searchPh")}
                    placeholder={t("admin.models.searchPh")}
                    onChange={(e) => setCandQuery(e.target.value)} />
                  {/* 只有当选中项**当前可见**时才允许添加。否则会出现：搜索把选中项过滤掉了，
                      按钮却仍然亮着、点下去加进一个屏幕上看不到的模型 —— 而它还会被
                      appendEntry 自动设为默认模型（enabled 也默认为 true）。 */}
                  <button style={btnGhost} disabled={!pickVisible} onClick={addFromCandidate}>{t("admin.models.add")}</button>
                  <button style={iconBtn} onClick={() => {
                    setAdding(false); setPick(""); setManualId(""); setCandQuery("");
                  }}>
                    {t("admin.models.cancel")}
                  </button>
                </div>
                {(() => {
                  // 四个态必须分开说，否则管理员会误判：
                  //  · 还在读     → 「正在读取…」
                  //  · 读失败     → 之前这里也显示「正在读取…」并**永久停在那**（candidates 恒空），
                  //                同时下方一条红色 warning，自相矛盾。现在明确说失败 + 给重试。
                  //  · 全部已加入 → 之前显示「没有匹配的模型」，听起来像搜索没结果
                  //  · 无匹配     → 才是真的没搜到
                  if (!candidates.length) {
                    return candWarn
                      ? (
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span style={{ ...errText, fontSize: 12 }}>{t("admin.models.candFailed")}</span>
                          <button style={iconBtn} onClick={() => { setCandWarn(""); loadCandidates(); }}>
                            {t("admin.models.retry")}
                          </button>
                        </div>
                      )
                      : <div style={{ color: "var(--muted)", fontSize: 12 }}>{t("admin.models.candLoading")}</div>;
                  }
                  if (!availCandidates.length) {
                    return <div style={{ color: "var(--muted)", fontSize: 12 }}>{t("admin.models.allAdded")}</div>;
                  }
                  if (!shownCandidates.length) {
                    return <div style={{ color: "var(--muted)", fontSize: 12 }}>{t("admin.models.noMatch")}</div>;
                  }
                  // 分组：保持 sortCandidates 已排好的顺序，按厂商切段
                  const groups: { name: string; items: LlmCandidate[] }[] = [];
                  for (const c of shownCandidates) {
                    const name = c.provider_name || t("admin.models.otherProvider");
                    const last = groups[groups.length - 1];
                    if (last && last.name === name) last.items.push(c);
                    else groups.push({ name, items: [c] });
                  }
                  return (
                    <div>
                      <div style={{ color: "var(--muted)", fontSize: 11.5, marginBottom: 4 }}>
                        {t("admin.models.matchCount").replace("{n}", String(shownCandidates.length))
                          .replace("{total}", String(availCandidates.length))}
                      </div>
                      <div style={{
                        maxHeight: 280, overflowY: "auto", border: "1px solid var(--line)",
                        borderRadius: 8, padding: 6,
                      }}>
                        {groups.map((g) => (
                          <div key={g.name}>
                            <div style={{
                              fontSize: 10.5, fontWeight: 700, color: "var(--muted)",
                              padding: "6px 6px 3px", textTransform: "uppercase", letterSpacing: .4,
                            }}>{g.name}</div>
                            {g.items.map((c) => {
                              const on = pick === c.model_id;
                              return (
                                <div key={c.model_id} onClick={() => setPick(c.model_id)}
                                  style={{
                                    display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                                    padding: "5px 7px", borderRadius: 6, cursor: "pointer",
                                    background: on ? "rgba(255,153,0,.10)" : "transparent",
                                    border: `1px solid ${on ? "var(--orange)" : "transparent"}`,
                                  }}>
                                  <input type="radio" name="llm-candidate" checked={on} onChange={() => setPick(c.model_id)}
                                    style={{ margin: 0 }} />
                                  <span style={{ fontSize: 12.5, fontWeight: on ? 600 : 500 }}>
                                    {c.label || c.model_id}
                                  </span>
                                  <code style={{
                                    fontSize: 11, color: "var(--muted)", flex: 1, minWidth: 200,
                                    wordBreak: "break-all",
                                  }}>{c.model_id}</code>
                                  <span title={t("admin.models.routingTip")} style={{
                                    fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 5,
                                    whiteSpace: "nowrap", border: "1px solid var(--line)", color: "var(--muted)",
                                  }}>{t(routingScopeKey(c.model_id, { scope: c.scope, kind: c.kind }))}</span>
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                {candWarn && <div style={{ ...errText, fontSize: 11.5 }}>{candWarn}</div>}
                {/* 列表来源身份。`iam_fallback` 是唯一危险的情形：列表来自部署角色而推理
                    用 Key，两者可能不是同一批模型。以前默认两者一致、什么都不说，管理员
                    会选中一个 Key 调不了的模型，到生产才 403。 */}
                {candSource && (
                  <div style={candSource === "iam_fallback"
                    ? { ...errText, fontSize: 11.5 }
                    : { color: "var(--muted)", fontSize: 11.5 }}>
                    {t(candSource === "api_key" ? "admin.models.candFromKey"
                      : candSource === "iam_fallback" ? "admin.models.candKeyNoListPerm"
                        : "admin.models.candFromRole")}
                  </div>
                )}
                {/* 手填入口：候选列不出来时（跨账号 Key 指向的模型不在本账号候选里、
                    或本栈缺 ListFoundationModels 权限）这是唯一的加模型方式。 */}
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ color: "var(--muted)", fontSize: 11.5 }}>{t("admin.models.orManual")}</span>
                  <input style={{ ...inputStyle, minWidth: 260 }} value={manualId}
                    placeholder="global.anthropic.claude-sonnet-5"
                    onChange={(e) => setManualId(e.target.value)} />
                  <input style={{ ...inputStyle, width: 160 }} value={manualLabel}
                    placeholder={t("admin.models.manualLabelPh")}
                    onChange={(e) => setManualLabel(e.target.value)} />
                  <button style={btnGhost} disabled={!manualId.trim()} onClick={addManual}>
                    {t("admin.models.add")}
                  </button>
                </div>
                <div style={{ color: "var(--muted)", fontSize: 11.5 }}>{t("admin.models.manualHint")}</div>
              </div>
            ) : (
              <button style={{ ...btnGhost, marginTop: 10 }} onClick={loadCandidates}>+ {t("admin.models.addModel")}</button>
            )}
          </div>

          {/* ── 后端任务模型（PHD 翻译 / 报告精简）── */}
          <div style={{ ...box, padding: 18, maxWidth: 780, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{t("admin.models.backendTitle")}</div>
            <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: -8 }}>{t("admin.models.backendSub")}</div>
            {["phd_translate", "devops_report_summarize"].map((task) => {
              const row = taskRows.find((r) => r.task === task);
              return (
                <div key={task}>
                  <FieldLabel>{t(`admin.models.task.${task}`)}</FieldLabel>
                  <select style={{ ...inputStyle, width: 320 }} value={tasks[task] || ""}
                    onChange={(e) => setTasks({ ...tasks, [task]: e.target.value })}>
                    <option value="">{t("admin.models.followDefault")}</option>
                    {/* 已启用的模型全部可选，没有例外。此处曾把 GPT 系「列出但禁用 +
                        写原因」，因为后端链只走 Converse —— 那个缺口已补齐（见上方注释）。 */}
                    {models.filter((m) => m.enabled).map((m) => (
                      <option key={m.alias} value={m.alias}>{m.label || m.alias}</option>
                    ))}
                  </select>
                  {row?.status === "drift" && (
                    <div style={{ ...errText, fontSize: 11.5, marginTop: 4 }}>{t("admin.models.outOfSync")}</div>
                  )}
                  {row?.status === "unknown" && (
                    <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 4 }}>
                      {t("admin.models.syncUnknown")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── 保存 + 审计/回滚 ── */}
          {/* 不变量预检结果放在按钮**旁边、点击之前**。此前这些条件只在服务端校验，
              管理员点保存后只看到 `http_400`，得自己猜是哪一条 —— 实测就卡在这里。 */}
          {blockers.length > 0 && (
            <div style={{
              border: `1px solid ${RED}`, borderRadius: 8, padding: "9px 12px",
              display: "flex", flexDirection: "column", gap: 3, maxWidth: 780,
            }}>
              <div style={{ ...errText, fontWeight: 600 }}>{t("admin.models.cannotSave")}</div>
              {blockers.map((b) => (
                <div key={b} style={{ ...errText, fontSize: 11.5 }}>· {b}</div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button style={{ ...btnPrimary, opacity: blockers.length ? 0.5 : 1,
                             cursor: blockers.length ? "not-allowed" : "pointer" }}
              disabled={saving || blockers.length > 0} onClick={save}
              title={blockers.length ? blockers.join(" / ") : undefined}>
              {saving ? t("admin.models.saving") : t("admin.models.save")}
            </button>
            <button style={btnGhost} onClick={openAudit}>{t("admin.models.audit")}</button>
            {cfg && <span style={{ color: "var(--muted)", fontSize: 11.5 }}>
              {t("admin.models.generation")}: {cfg.generation}
              {cfg.updated_by ? ` · ${cfg.updated_by}` : ""}
            </span>}
            {msg && <span style={msg.ok ? okText : errText}>{msg.text}</span>}
          </div>
          {auditOpen && (
            <div style={{ ...box, padding: 14 }}>
              {audit.length === 0 ? <div style={{ color: "var(--muted)", fontSize: 12.5 }}>{t("admin.models.auditEmpty")}</div> : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {audit.map((a) => (
                    <div key={a.SK} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                      <span style={{ color: "var(--muted)", minWidth: 165 }}>{a.at}</span>
                      <span style={{ flex: 1 }}>{a.actor_name || a.actor_sub || ""}</span>
                      <span style={{ color: "var(--muted)" }}>{a.generation_before} → {a.generation_after}</span>
                      <button style={iconBtn} disabled={saving} onClick={() => doRollback(a.SK)}>
                        {t("admin.models.rollback")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────────── 角色 + 权限树 ───────────────── */

function RolesView({ caps }: { caps: FullCapabilityNode[] }) {
  const t = useT();
  const { locale } = useLocale();
  const title = (n: FullCapabilityNode) => (locale === "en" ? n.title_en : n.title_zh) || n.key;
  const [roles, setRoles] = useState<RoleRec[]>([]);
  const [sel, setSel] = useState<string>("");
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const reload = () => fetchRoles().then(setRoles).catch((e) => setErr(String(e?.message || e)));
  useEffect(() => { reload(); }, []);

  // 父→子索引（按 registry 顺序）
  const childrenOf = useMemo(() => {
    const m = new Map<string, FullCapabilityNode[]>();
    for (const n of caps) {
      const p = n.parent || "__root__";
      if (!m.has(p)) m.set(p, []);
      m.get(p)!.push(n);
    }
    return m;
  }, [caps]);
  const tabs = childrenOf.get("__root__") || [];

  const editing = roles.find((r) => r.name === sel);
  const isAdminRole = sel === ADMIN_ROLE;
  void editing;

  const selectRole = (name: string) => {
    setSel(name); setMsg(""); setErr("");
    const r = roles.find((x) => x.name === name);
    setPerms(new Set(r?.permissions || []));
  };

  // 某 key 是否被某个祖先通配（X:* 或 *）覆盖 → 覆盖时后代不可单独取消
  const coveredByAncestor = (key: string): boolean => {
    if (perms.has("*")) return true;
    for (const p of perms) {
      if (p.endsWith(":*")) {
        const base = p.slice(0, -2);
        if (key !== base && key.startsWith(base + ":")) return true;
      }
    }
    return false;
  };
  const wholeKey = (key: string) => `${key}:*`;
  const hasWhole = (key: string) => perms.has(wholeKey(key));
  const hasExact = (key: string) => perms.has(key);

  const toggleExact = (key: string) => {
    setPerms((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  };
  const toggleWhole = (key: string) => {
    setPerms((prev) => {
      const n = new Set(prev); const wk = wholeKey(key);
      if (n.has(wk)) { n.delete(wk); }
      else {
        n.add(wk);
        // 去掉该子树下的冗余 exact 键
        for (const p of [...n]) { if (p !== wk && (p === key || p.startsWith(key + ":"))) n.delete(p); }
      }
      return n;
    });
  };

  const save = async () => {
    setMsg(""); setErr("");
    try { await saveRole(sel, [...perms]); setMsg(t("admin.roles.saved")); await reload(); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
  };
  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setMsg(""); setErr("");
    try { await saveRole(name, []); setNewName(""); await reload(); selectRole(name); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
  };
  const remove = async (name: string) => {
    if (!window.confirm(t("admin.confirm.deleteRole").replace("{name}", name))) return;
    setMsg(""); setErr("");
    try { await deleteRole(name); if (sel === name) { setSel(""); setPerms(new Set()); } await reload(); }
    catch (e) {
      const m = String((e as Error)?.message || e);
      setErr(m === "role_in_use" ? t("admin.roles.inuse").replace("{n}", "≥1") : m);
    }
  };

  // 纯分组节点（如 Cost Breakdown / Deep Dive）：有子、无 responseKey、非 tab → 渲染为小节表头
  const isGroupHeader = (n: FullCapabilityNode) =>
    n.level !== "tab" && (childrenOf.get(n.key)?.length || 0) > 0 && !n.responseKey;
  // 某节点下所有可授予叶子 key（无子节点者 = 卡片/场景）
  const leafKeysUnder = (key: string): string[] => {
    const kids = childrenOf.get(key) || [];
    if (kids.length === 0) return [key];
    return kids.flatMap((c) => leafKeysUnder(c.key));
  };
  const isOn = (k: string) => hasExact(k) || hasWhole(k) || coveredByAncestor(k);
  const toggleGroup = (leaves: string[], allOn: boolean) => {
    setPerms((prev) => {
      const s = new Set(prev);
      if (allOn) leaves.forEach((k) => s.delete(k));
      else leaves.forEach((k) => s.add(k));
      return s;
    });
  };

  const renderNode = (n: FullCapabilityNode, depth: number) => {
    const kids = childrenOf.get(n.key) || [];
    const covered = coveredByAncestor(n.key);

    // 分组小节表头：一个全选/全不选复选框（tri-state）+ 组名，下面缩进子项
    if (isGroupHeader(n)) {
      const leaves = leafKeysUnder(n.key);
      const onCount = leaves.filter(isOn).length;
      const allOn = leaves.length > 0 && onCount === leaves.length;
      const someOn = onCount > 0 && !allOn;
      return (
        <div key={n.key}>
          <label title={t("admin.roles.groupTip")} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0 3px", paddingLeft: depth * 20, opacity: covered ? 0.55 : 1, cursor: covered ? "default" : "pointer" }}>
            <input type="checkbox" ref={(el) => { if (el) el.indeterminate = someOn; }} disabled={isAdminRole || covered} checked={allOn || covered} onChange={() => toggleGroup(leaves, allOn)} />
            <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--muted)" }}>{title(n)}</span>
          </label>
          {kids.map((k) => renderNode(k, depth + 1))}
        </div>
      );
    }

    // 叶子 / tab 节点：复选框 + 名称 + 小字权限键；tab 额外带「整个 :*」
    const checked = hasExact(n.key) || hasWhole(n.key) || covered;
    return (
      <div key={n.key}>
        <label title={n.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", paddingLeft: depth * 20, opacity: covered ? 0.55 : 1, cursor: covered ? "default" : "pointer" }}>
          <input type="checkbox" disabled={isAdminRole || covered} checked={checked} onChange={() => toggleExact(n.key)} />
          <span style={{ fontSize: 13.5, fontWeight: depth === 0 ? 700 : 400, color: "var(--text)" }}>{title(n)}</span>
          <code style={{ fontSize: 10.5, color: "var(--muted)", opacity: 0.8 }}>{n.key}</code>
          {kids.length > 0 && (
            <label title={wholeKey(n.key)} style={{ marginLeft: 12, fontSize: 11.5, display: "inline-flex", gap: 4, alignItems: "center", color: "var(--muted)", opacity: covered ? 0.55 : 1 }}>
              <input type="checkbox" disabled={isAdminRole || covered} checked={hasWhole(n.key)} onChange={() => toggleWhole(n.key)} />
              {t("admin.roles.whole")}
            </label>
          )}
        </label>
        {kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
      {/* 左：角色列表 + 新建 */}
      <div style={{ ...box, padding: 12, width: 232, flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("admin.roles.name")} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
          <button style={btnPrimary} onClick={create}>{t("admin.roles.new")}</button>
        </div>
        <FieldLabel>{t("admin.roles.listTitle")}</FieldLabel>
        {roles.map((r) => (
          <div key={r.name} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <button onClick={() => selectRole(r.name)} title={r.name} style={{
              flex: 1, textAlign: "left", padding: "7px 10px", borderRadius: 7, cursor: "pointer", fontSize: 13,
              border: `1px solid ${sel === r.name ? "var(--orange)" : "transparent"}`,
              background: sel === r.name ? "rgba(255,153,0,.10)" : "transparent",
              color: "var(--text)", fontWeight: sel === r.name ? 600 : 500,
              display: "flex", alignItems: "center", gap: 6, minWidth: 0,
            }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{roleName(t, r.name)}</span>
              {r.preset && <span style={{ fontSize: 10, color: "var(--muted)", border: "1px solid var(--line)", borderRadius: 4, padding: "0 5px", flexShrink: 0 }}>{t("admin.roles.preset")}</span>}
            </button>
            {r.name !== ADMIN_ROLE && !r.preset && (
              <button style={iconBtn} title={t("admin.roles.delete")} onClick={() => remove(r.name)}>✕</button>
            )}
          </div>
        ))}
      </div>

      {/* 右：权限树 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {!sel && <div style={{ ...box, padding: "28px 20px", color: "var(--muted)", fontSize: 13, textAlign: "center" }}>{t("admin.roles.pick")}</div>}
        {sel && (
          <div style={{ ...box, padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>{roleName(t, sel)}</span>
              {roleName(t, sel) !== sel && <code style={{ fontSize: 11, color: "var(--muted)" }}>{sel}</code>}
            </div>
            {isAdminRole ? (
              <div style={{ color: "var(--muted)", fontSize: 13 }}>{t("admin.roles.adminReadonly")}</div>
            ) : (
              <>
                <FieldLabel>{t("admin.roles.perms")}</FieldLabel>
                <div style={{ maxHeight: "50vh", overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: "10px 14px", background: "var(--page)" }}>
                  {tabs.map((n) => renderNode(n, 0))}
                </div>
                <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 12 }}>
                  <button style={btnPrimary} onClick={save}>{t("admin.roles.save")}</button>
                  {msg && <span style={okText}>{msg}</span>}
                  {err && <span style={errText}>{err}</span>}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────────── 用户 ───────────────── */

function UsersView() {
  const t = useT();
  const [users, setUsers] = useState<UserRec[]>([]);
  const [roles, setRoles] = useState<RoleRec[]>([]);
  const [draft, setDraft] = useState<Record<string, { roles: string[]; denies: string }>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [expUser, setExpUser] = useState("");
  const [roleQ, setRoleQ] = useState("");
  // 创建用户表单
  const [newUser, setNewUser] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [tempPw, setTempPw] = useState<{ username: string; password: string } | null>(null);

  const reload = () =>
    Promise.all([fetchUsers(), fetchRoles()])
      .then(([u, r]) => {
        setUsers(u); setRoles(r);
        const d: Record<string, { roles: string[]; denies: string }> = {};
        for (const x of u) d[x.sub] = { roles: [...x.roles], denies: (x.denies || []).join(", ") };
        setDraft(d);
      })
      .catch((e) => setErr(String(e?.message || e)));
  useEffect(() => { reload(); }, []);

  const toggleRole = (sub: string, role: string) => {
    setDraft((prev) => {
      const cur = prev[sub] || { roles: [], denies: "" };
      const has = cur.roles.includes(role);
      return { ...prev, [sub]: { ...cur, roles: has ? cur.roles.filter((r) => r !== role) : [...cur.roles, role] } };
    });
  };
  const setDenies = (sub: string, v: string) => setDraft((prev) => ({ ...prev, [sub]: { ...(prev[sub] || { roles: [], denies: "" }), denies: v } }));

  const save = async (sub: string) => {
    const d = draft[sub] || { roles: [], denies: "" };
    const denies = d.denies.split(",").map((s) => s.trim()).filter(Boolean);
    setErr(""); setMsg((m) => ({ ...m, [sub]: "" }));
    try { await putUser(sub, d.roles, denies); setMsg((m) => ({ ...m, [sub]: t("admin.users.saved") })); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
  };

  const doCreate = async () => {
    const u = newUser.trim();
    if (!u) return;
    setErr(""); setTempPw(null);
    try {
      const r = await createUser(u, newEmail.trim() || undefined);
      setTempPw({ username: r.username, password: r.tempPassword });
      setNewUser(""); setNewEmail("");
      await reload();
    } catch (e) { setErr(String((e as Error)?.message || e)); }
  };

  const doDelete = async (u: UserRec) => {
    if (!window.confirm(t("admin.confirm.deleteUser").replace("{name}", u.username))) return;
    setErr("");
    try { await deleteUser(u.username, u.sub); await reload(); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
  };

  const filtered = users.filter((u) => u.username.toLowerCase().includes(query.trim().toLowerCase()));

  // 批量：多选用户 + 一次赋予/移除某角色
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRole, setBulkRole] = useState("");
  const [bulkMsg, setBulkMsg] = useState("");
  const toggleSel = (sub: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(sub)) n.delete(sub); else n.add(sub); return n; });
  const selectAllFiltered = () => setSelected(new Set(filtered.map((u) => u.sub)));
  const clearSel = () => setSelected(new Set());
  const bulkApply = async (add: boolean) => {
    if (!bulkRole || selected.size === 0) return;
    setBulkMsg(""); setErr("");
    const targets = users.filter((u) => selected.has(u.sub));
    try {
      for (const u of targets) {
        const cur = draft[u.sub] || { roles: [...u.roles], denies: (u.denies || []).join(", ") };
        const roles = add
          ? Array.from(new Set([...cur.roles, bulkRole]))
          : cur.roles.filter((r) => r !== bulkRole);
        const denies = cur.denies.split(",").map((s) => s.trim()).filter(Boolean);
        await putUser(u.sub, roles, denies);
      }
      setBulkMsg(t("admin.users.bulkDone").replace("{n}", String(targets.length)));
      await reload(); clearSel();
    } catch (e) { setErr(String((e as Error)?.message || e)); }
  };

  return (
    <div>
      {/* 统计条 + 搜索 + 全选 */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{t("admin.users.count").replace("{n}", String(users.length))}</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("admin.users.search")} style={{ ...inputStyle, flex: "0 1 220px" }} />
        <button style={btnGhost} onClick={selectAllFiltered}>{t("admin.users.selectAll")}</button>
      </div>

      {/* 批量操作栏：选中用户后出现 */}
      {selected.size > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, padding: "10px 14px", border: "1px solid var(--orange)", borderRadius: 10, background: "rgba(255,153,0,.07)", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700 }}>{t("admin.users.selected").replace("{n}", String(selected.size))}</span>
          <select value={bulkRole} onChange={(e) => setBulkRole(e.target.value)} style={inputStyle}>
            <option value="">{t("admin.users.bulkRole")}</option>
            {roles.map((r) => <option key={r.name} value={r.name}>{roleName(t, r.name)}</option>)}
          </select>
          <button style={btnPrimary} disabled={!bulkRole} onClick={() => bulkApply(true)}>{t("admin.users.bulkAdd")}</button>
          <button style={btnGhost} disabled={!bulkRole} onClick={() => bulkApply(false)}>{t("admin.users.bulkRemove")}</button>
          <button style={iconBtn} onClick={clearSel}>✕</button>
          {bulkMsg && <span style={okText}>{bulkMsg}</span>}
        </div>
      )}

      {/* 新建用户 */}
      <div style={{ ...box, padding: "12px 14px", marginBottom: 16 }}>
        <FieldLabel>{t("admin.users.createTitle")}</FieldLabel>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input value={newUser} onChange={(e) => setNewUser(e.target.value)} placeholder={t("admin.users.username")} style={inputStyle} />
          <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder={t("admin.users.email")} style={{ ...inputStyle, flex: "0 1 240px" }} />
          <button style={btnPrimary} onClick={doCreate}>{t("admin.users.new")}</button>
        </div>
        {tempPw && (
          <div style={{ border: "1px solid var(--green)", borderRadius: 8, padding: "10px 14px", marginTop: 12, background: "rgba(0,128,47,.06)" }}>
            <div style={{ marginBottom: 6, fontWeight: 600 }}>{t("admin.users.created").replace("{name}", tempPw.username)}</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 6 }}>{t("admin.users.tempPwNote")}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <code style={{ fontSize: 14, padding: "4px 10px", background: "var(--code-bg)", borderRadius: 6 }}>{tempPw.password}</code>
              <button style={iconBtn} onClick={() => navigator.clipboard?.writeText(tempPw.password)}>{t("admin.users.copy")}</button>
              <button style={{ ...iconBtn, marginLeft: "auto" }} onClick={() => setTempPw(null)}>✕</button>
            </div>
          </div>
        )}
      </div>

      {err && <div style={{ ...errText, marginBottom: 12 }}>{err}</div>}

      {/* 用户卡片列表（折叠式：摘要行可点开编辑） */}
      {filtered.map((u) => {
        const d = draft[u.sub] || { roles: [], denies: "" };
        const st = statusName(t, u.status);
        const open = expUser === u.sub;
        const visRoles = roleQ.trim() ? roles.filter((r) => (r.name + roleName(t, r.name)).toLowerCase().includes(roleQ.trim().toLowerCase())) : roles;
        return (
          <div key={u.sub} style={{ ...box, marginBottom: 8 }}>
            {/* 摘要行 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px" }}>
              <input type="checkbox" checked={selected.has(u.sub)} onChange={() => toggleSel(u.sub)} />
              <div onClick={() => setExpUser(open ? "" : u.sub)} style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, cursor: "pointer", minWidth: 0, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700, fontSize: 14 }} title={u.sub}>{u.username}</span>
                {st && <span style={{ fontSize: 11, fontWeight: 600, color: u.status === "CONFIRMED" ? "var(--green)" : "var(--muted)", border: "1px solid var(--line)", borderRadius: 100, padding: "1px 8px" }}>{st}</span>}
                <span style={{ display: "inline-flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                  {d.roles.length === 0
                    ? <span style={{ color: "var(--muted)", fontSize: 12 }}>—</span>
                    : d.roles.slice(0, 5).map((r) => <span key={r} title={r} style={{ fontSize: 11.5, color: "var(--muted)", background: "var(--page)", border: "1px solid var(--line)", borderRadius: 100, padding: "1px 9px" }}>{roleName(t, r)}</span>)}
                  {d.roles.length > 5 && <span style={{ color: "var(--muted)", fontSize: 11.5 }}>+{d.roles.length - 5}</span>}
                </span>
              </div>
              <button style={iconBtn} title={t("admin.users.delete")} onClick={() => doDelete(u)}>✕</button>
              <button style={{ ...iconBtn, border: "none" }} onClick={() => setExpUser(open ? "" : u.sub)}>{open ? "▲" : "▼"}</button>
            </div>
            {/* 展开编辑 */}
            {open && (
              <div style={{ padding: "12px 14px", borderTop: "1px solid var(--line)" }}>
                <FieldLabel>{t("admin.users.roles")}</FieldLabel>
                {roles.length > 8 && (
                  <input value={roleQ} onChange={(e) => setRoleQ(e.target.value)} placeholder={t("admin.users.roleFilter")} style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 8 }} />
                )}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                  {visRoles.map((r) => (
                    <RoleChip key={r.name} t={t} name={r.name} checked={d.roles.includes(r.name)} onChange={() => toggleRole(u.sub, r.name)} />
                  ))}
                </div>
                <FieldLabel>{t("admin.users.denies")}</FieldLabel>
                <input value={d.denies} onChange={(e) => setDenies(u.sub, e.target.value)} placeholder="nav:finops:ai-spend, ..." style={{ ...inputStyle, width: "100%", marginBottom: 12, boxSizing: "border-box" }} />
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button style={btnPrimary} onClick={() => save(u.sub)}>{t("admin.users.save")}</button>
                  {msg[u.sub] && <span style={okText}>{msg[u.sub]}</span>}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────── 组→角色映射 ───────────────── */

function GroupsView() {
  const t = useT();
  const [groups, setGroups] = useState<GroupRec[]>([]);
  const [roles, setRoles] = useState<RoleRec[]>([]);
  const [users, setUsers] = useState<UserRec[]>([]);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [newDesc, setNewDesc] = useState("");
  // 成员管理
  const [expanded, setExpanded] = useState<string>("");
  const [members, setMembers] = useState<Record<string, string[]>>({});
  const [addPick, setAddPick] = useState<Record<string, string>>({});
  const PROTECTED = new Set(["admin", "member"]);

  const reload = () =>
    Promise.all([fetchGroups(), fetchRoles(), fetchUsers()])
      .then(([g, r, u]) => {
        setGroups(g); setRoles(r); setUsers(u);
        const d: Record<string, string[]> = {};
        for (const x of g) d[x.name] = [...x.roles];
        setDraft(d);
      })
      .catch((e) => setErr(String(e?.message || e)));
  useEffect(() => { reload(); }, []);

  const toggle = (group: string, role: string) => {
    setDraft((prev) => {
      const cur = prev[group] || [];
      return { ...prev, [group]: cur.includes(role) ? cur.filter((r) => r !== role) : [...cur, role] };
    });
  };
  const save = async (group: string) => {
    setErr(""); setMsg((m) => ({ ...m, [group]: "" }));
    try { await putGroupMap(group, draft[group] || []); setMsg((m) => ({ ...m, [group]: t("admin.groups.saved") })); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
  };
  const doCreate = async () => {
    const g = newGroup.trim();
    if (!g) return;
    setErr("");
    try { await createGroup(g, newDesc.trim() || undefined); setNewGroup(""); setNewDesc(""); await reload(); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
  };
  const doDelete = async (g: string) => {
    if (!window.confirm(t("admin.confirm.deleteGroup").replace("{name}", g))) return;
    setErr("");
    try { await deleteGroup(g); await reload(); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
  };
  const loadMembers = async (g: string) => {
    try { const m = await fetchGroupMembers(g); setMembers((prev) => ({ ...prev, [g]: m })); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
  };
  const toggleExpand = (g: string) => {
    const next = expanded === g ? "" : g;
    setExpanded(next);
    if (next && members[next] === undefined) loadMembers(next);
  };
  const doAddMember = async (g: string) => {
    const u = addPick[g];
    if (!u) return;
    setErr("");
    try { await addUserToGroup(g, u); setAddPick((p) => ({ ...p, [g]: "" })); await loadMembers(g); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
  };
  const doRemoveMember = async (g: string, u: string) => {
    setErr("");
    try { await removeUserFromGroup(g, u); await loadMembers(g); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
  };

  return (
    <div>
      <SectionHead title={t("admin.tab.groups")} sub={t("admin.groups.hint")} />

      {/* 建组 */}
      <div style={{ ...box, padding: "12px 14px", marginBottom: 16 }}>
        <FieldLabel>{t("admin.groups.new")}</FieldLabel>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder={t("admin.groups.name")} style={inputStyle} />
          <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder={t("admin.groups.desc")} style={{ ...inputStyle, flex: "0 1 280px" }} />
          <button style={btnPrimary} onClick={doCreate}>{t("admin.groups.new")}</button>
        </div>
      </div>

      {err && <div style={{ ...errText, marginBottom: 12 }}>{err}</div>}
      {groups.length === 0 && <div style={{ ...box, padding: "24px 20px", color: "var(--muted)", fontSize: 13, textAlign: "center" }}>{t("admin.groups.empty")}</div>}

      {groups.map((g) => {
        const mem = members[g.name] || [];
        const nonMembers = users.filter((u) => !mem.includes(u.username));
        const open = expanded === g.name;
        const gRoles = draft[g.name] || [];
        return (
          <div key={g.name} style={{ ...box, marginBottom: 8 }}>
            {/* 摘要行 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px" }}>
              <div onClick={() => toggleExpand(g.name)} style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, cursor: "pointer", minWidth: 0, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700, fontSize: 14 }} title={g.name}>{groupName(t, g.name)}</span>
                {PROTECTED.has(g.name) && <span style={{ fontSize: 11, color: "var(--muted)" }} title={t("admin.groups.protected")}>🔒</span>}
                <span style={{ display: "inline-flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                  {gRoles.length === 0
                    ? <span style={{ color: "var(--muted)", fontSize: 12 }}>—</span>
                    : gRoles.slice(0, 5).map((r) => <span key={r} title={r} style={{ fontSize: 11.5, color: "var(--muted)", background: "var(--page)", border: "1px solid var(--line)", borderRadius: 100, padding: "1px 9px" }}>{roleName(t, r)}</span>)}
                  {gRoles.length > 5 && <span style={{ color: "var(--muted)", fontSize: 11.5 }}>+{gRoles.length - 5}</span>}
                </span>
              </div>
              {!PROTECTED.has(g.name) && <button style={iconBtn} title={t("admin.groups.delete")} onClick={() => doDelete(g.name)}>✕</button>}
              <button style={{ ...iconBtn, border: "none" }} onClick={() => toggleExpand(g.name)}>{open ? "▲" : "▼"}</button>
            </div>
            {/* 展开：角色映射 + 成员 */}
            {open && (
              <div style={{ padding: "12px 14px", borderTop: "1px solid var(--line)" }}>
                {g.description && <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>{g.description}</div>}
                <FieldLabel>{t("admin.groups.roles")}</FieldLabel>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                  {roles.map((r) => (
                    <RoleChip key={r.name} t={t} name={r.name} checked={gRoles.includes(r.name)} onChange={() => toggle(g.name, r.name)} />
                  ))}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button style={btnPrimary} onClick={() => save(g.name)}>{t("admin.groups.save")}</button>
                  {msg[g.name] && <span style={okText}>{msg[g.name]}</span>}
                </div>
                <div style={{ borderTop: "1px solid var(--line)", marginTop: 12, paddingTop: 12 }}>
                  <FieldLabel>{t("admin.groups.members")} ({mem.length})</FieldLabel>
                  {mem.length === 0 && <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>{t("admin.groups.noMembers")}</div>}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                    {mem.map((u) => (
                      <span key={u} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 6px 3px 10px", borderRadius: 100, border: "1px solid var(--line)", fontSize: 12.5 }}>
                        {u}<button style={{ ...iconBtn, padding: "0 6px", border: "none" }} onClick={() => doRemoveMember(g.name, u)}>✕</button>
                      </span>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <select value={addPick[g.name] || ""} onChange={(e) => setAddPick((p) => ({ ...p, [g.name]: e.target.value }))} style={inputStyle}>
                      <option value="">{t("admin.groups.pickUser")}</option>
                      {nonMembers.map((u) => <option key={u.sub} value={u.username}>{u.username}</option>)}
                    </select>
                    <button style={btnPrimary} disabled={!addPick[g.name]} onClick={() => doAddMember(g.name)}>{t("admin.groups.addMember")}</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────── 模块开关 ───────────────── */

function ModulesView() {
  const t = useT();
  const { locale } = useLocale();
  const [mods, setMods] = useState<ModuleToggle[]>([]);
  const [err, setErr] = useState("");

  const reload = () => fetchModules().then((r) => setMods(r.toggleable)).catch((e) => setErr(String(e?.message || e)));
  useEffect(() => { reload(); }, []);

  const toggle = async (key: string) => {
    const next = mods.map((m) => (m.key === key ? { ...m, disabled: !m.disabled } : m));
    setMods(next);
    const disabled = next.filter((m) => m.disabled).map((m) => m.key);
    try { await putModules(disabled); } catch (e) { setErr(String((e as Error)?.message || e)); reload(); }
  };

  return (
    <div>
      <SectionHead title={t("admin.tab.modules")} sub={t("admin.modules.hint")} />
      {err && <div style={{ ...errText, marginBottom: 12 }}>{err}</div>}
      <div style={{ ...box, padding: "4px 14px" }}>
        {mods.map((m, i) => (
          <label key={m.key} title={m.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderTop: i === 0 ? "none" : "1px solid var(--line)", cursor: "pointer" }}>
            <input type="checkbox" checked={!m.disabled} onChange={() => toggle(m.key)} />
            <span style={{ fontWeight: 600, fontSize: 13.5, color: "var(--text)" }}>{(locale === "en" ? m.title_en : m.title_zh) || m.key}</span>
            <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 600, padding: "2px 10px", borderRadius: 100, color: m.disabled ? RED : "var(--green)", border: `1px solid ${m.disabled ? RED : "var(--green)"}` }}>
              {m.disabled ? t("admin.modules.disabled") : t("admin.modules.enabled")}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/* ───────────────── 账户（成员账号接入 + 数据可见性） ───────────────── */

/**
 * ⚠️ **只为测试而导出**（2026-08-30）。本文件 2000+ 行、零测试，而账号页上
 * 有几个「不显示就完全静默」的信号 —— 最典型的是「待更新栈」徽章：
 *
 * ```
 * 不显示它 → 存量账号不知道要重新部署栈
 *          → 采集照跑（enabled_accounts 读 da# 行，与巡检字段无关）
 *          → 花 GetMetricData、而判读永远为空
 *          → 看板上「N 条未做根因分析」与「DA 说这些没问题」长得一样
 * ```
 *
 * 整个 `AdminPanel` 渲染要 mock 十几个 API 并切到对应 tab；导出这一个子组件
 * 让测试能直接渲染它。**不要**在生产代码里 import 这个名字 ——
 * `AdminPanel` 内部照旧直接用它。
 */
export function AccountsView() {
  const t = useT();
  // ── 接入 ──
  const [accounts, setAccounts] = useState<MemberAccountRec[]>([]);
  /**
   * 两个**互相独立**的能力，不能合成一个「org 模式开没开」。
   *
   * ```
   * orgListable      能不能从 Organizations 列出账号
   *                  partner-resold 客户（手里没有 payer 账号、系统部署在某个
   *                  linked account 上）读不到 → false，那时只列已登记的
   * oneClickOnboard  StackSet 一键接入可不可用（要 org 模式 + 管理账号）
   * ```
   *
   * 🔴 原来这两件事挤在一个 `orgDisabled` 里，而它整页 early return，
   *    于是「列不出账号」被当成「整页不可用」—— 连**手动接入**都被挡掉，
   *    而那条路径两个能力都不需要。
   */
  const [orgListable, setOrgListable] = useState(true);
  const [oneClick, setOneClick] = useState(true);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<MemberAccountRec | null>(null);
  const [regionsInput, setRegionsInput] = useState("us-east-1");
  const [submitting, setSubmitting] = useState(false);
  const [polling, setPolling] = useState<Record<string, string>>({}); // opId -> accountId
  const [consoleUrl, setConsoleUrl] = useState("");
  useEffect(() => { loadConfig().then((c) => setConsoleUrl(c.idleConsoleUrl || "")).catch(() => {}); }, []);
  const [daPolling, setDaPolling] = useState<Record<string, string>>({}); // opId -> accountId

  /**
   * 重取账号列表。
   *
   * 🔴 **必须定义在下面两个轮询 effect 之前**，而且要 `useCallback`。
   *    原来它定义在两个 effect **之后**，于是 interval 回调里的 `reload()`
   *    是「在声明前访问」（eslint 直接报 Cannot access variable before it
   *    is declared）。运行时侥幸不炸 —— effect 在首次渲染**之后**执行，
   *    那时函数体已经跑完、`reload` 已赋值；interval 回调更晚。
   *
   *    但它不在依赖数组里，而每次渲染都是**新函数**：闭包捕获的是首屏那个。
   *    现在只调 setState（引用稳定）所以看不出问题 —— 哪天它引用了别的
   *    state，interval 里读到的就是过期值，而这种 bug 极难复现。
   *
   * ⚠️ `silent` 同 `load` 那两处：首次加载时 `loading` 初值已是 true，
   *    effect 里再同步 `setErr("")` 会触发级联渲染（React 19 的规则）。
   */
  const reload = useCallback((opts?: { silent?: boolean }) => {
    if (!opts?.silent) setErr("");
    return fetchMemberAccounts()
      .then((r) => {
        setAccounts(r.items);
        setOrgListable(r.orgListable);
        setOneClick(r.oneClickOnboard);
      })
      // ⚠️ 不再把 `org_mode_disabled` 特殊处理成「整页不可用」——
      //    后端已经不抛它了（改成两个标记）。这里只剩真正的错误。
      .catch((e) => setErr(String((e as Error)?.message || e)))
      .finally(() => setLoading(false));
  }, []);
  // 🔴 **下面那条 disable 是针对规则误报的，不是偷懒。** 判据：`load`/`reload` 的**同步执行路径上
  //    已经没有 setState** 了（`silent: true` 跳过了唯一那一处）。剩下的
  //    `setAccounts` / `setMsg` / `setLoading` 全在 `.then/.catch/.finally`
  //    回调里 —— promise 回调是微任务，不在 effect 的同步路径上。
  //
  //    规则的静态分析追进被调函数体、看到里面有 setState 就报，分不清
  //    同步与异步边界。
  //
  // ⚠️ 不要用「把 setState 包一层骗过规则」的写法绕它 —— 那会让下一个人
  //    以为这里真有级联渲染问题，然后去改本来正确的代码。
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { reload({ silent: true }); }, [reload]);

  useEffect(() => {
    const ids = Object.keys(daPolling);
    if (!ids.length) return;
    const timer = setInterval(async () => {
      for (const opId of Object.keys(daPolling)) {
        try {
          const r = await devopsAgentAssocStatus(opId, daPolling[opId]);
          if (r.status !== "RUNNING" && r.status !== "QUEUED") {
            setDaPolling((prev) => { const n = { ...prev }; delete n[opId]; return n; });
            reload();
          }
        } catch { setDaPolling((prev) => { const n = { ...prev }; delete n[opId]; return n; }); }
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [daPolling, reload]);


  // 轮询进行中的 StackSet operation（5s）
  useEffect(() => {
    const ids = Object.keys(polling);
    if (!ids.length) return;
    const timer = setInterval(async () => {
      for (const opId of Object.keys(polling)) {
        try {
          const r = await memberOnboardStatus(opId, polling[opId]);
          if (r.status !== "RUNNING" && r.status !== "QUEUED") {
            setPolling((prev) => { const n = { ...prev }; delete n[opId]; return n; });
            reload();
          }
        } catch {
          setPolling((prev) => { const n = { ...prev }; delete n[opId]; return n; });
        }
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [polling, reload]);

  /**
   * 正在内联编辑采集 Region 的那个账号，以及输入框的当前值。
   *
   * 🔴 与 `target` / `regionsInput` **分开**：那两个是**接入流程**的状态
   * （点「接入」会 CreateStackInstances 下发 StackSet，几分钟、会动成员账号里
   * 的资源）。改一下 region 不该走那条路，也不该共用状态 —— 共用会让
   * 「点编辑」意外触发一次接入。
   */
  const [editRegions, setEditRegions] = useState<
    { accountId: string; value: string } | null>(null);
  const [savingRegions, setSavingRegions] = useState(false);

  const submitRegions = async () => {
    if (!editRegions) return;
    setSavingRegions(true); setErr("");
    try {
      const list = editRegions.value.split(/[,;\s]+/)
        .map((r) => r.trim()).filter(Boolean);
      await setMemberAccountRegions(editRegions.accountId, list);
      setEditRegions(null);
      await reload();
    } catch (e) {
      // ⚠️ 原样显示后端的话。它会明确拒绝打错形状的 region（`us-east1`）并把
      //    哪几个错了列出来 —— 换成一句「保存失败」等于把那个信息丢掉，
      //    而打错的 region 在运行时的表现是「那个区一直没被采」，看不出原因。
      setErr(String((e as Error)?.message || e));
    } finally { setSavingRegions(false); }
  };

  /**
   * 显示名（alias）的内联编辑。与 `editRegions` 同构、**分开的 state**。
   *
   * 🔴 共用一个 state 的表现是：点「改名」把 region 输入框的内容当成 alias
   *    提交（或者反过来），而两个提交都会「成功」—— region 字段能存任意字符串，
   *    alias 也能。错的值要到第二天巡检没采到那个区才暴露。
   */
  const [editAlias, setEditAlias] = useState<
    { accountId: string; value: string } | null>(null);
  const [savingAlias, setSavingAlias] = useState(false);
  /** 保存成功后的一句话反馈（说清 IM 推送标签改了没有）。 */
  const [aliasMsg, setAliasMsg] = useState("");

  const submitAlias = async () => {
    if (!editAlias) return;
    setSavingAlias(true); setErr(""); setAliasMsg("");
    try {
      const r = await setMemberAccountAlias(
        editAlias.accountId, editAlias.value.trim());
      setEditAlias(null);
      /**
       * 🔴 把 `pushLabelUpdated` 说出来。
       *
       *    `da#` 行不存在（账号只做了接入、还没做 DevOps Agent 关联）时后端
       *    **跳过**那一行的写入 —— 也就是 IM 推送里那个账号的标签没有变。
       *    不说的话「都改好了」与「页面改了但推送还是旧名字」在界面上一样，
       *    而推送是客户看得最多的那一面。
       */
      setAliasMsg(r.pushLabelUpdated
        ? t("admin.accounts.aliasSaved")
        : t("admin.accounts.aliasSavedNoPush"));
      await reload();
    } catch (e) {
      // ⚠️ 原样显示后端的话 —— 它会明确说「太长」/「不能是纯数字」以及为什么。
      setErr(String((e as Error)?.message || e));
    } finally { setSavingAlias(false); }
  };

  const submitOnboard = async () => {
    if (!target) return;
    const regions = regionsInput.split(/[,;\s]+/).map((r) => r.trim()).filter(Boolean);
    if (!regions.length) { setErr(t("admin.accounts.regionsPrompt")); return; }
    setSubmitting(true); setErr("");
    try {
      const r = await onboardMemberAccount(target.accountId, regions);
      setPolling((prev) => ({ ...prev, [r.operationId]: target.accountId }));
      setTarget(null);
      await reload();
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setSubmitting(false); }
  };

  const statusBadge = (a: MemberAccountRec) => {
    let label = t("admin.accounts.stNone"); let color = "var(--muted)";
    if (a.orgOnboardStatus === "PROVISIONING") { label = t("admin.accounts.stProvisioning"); color = "var(--orange)"; }
    else if (a.orgOnboardStatus === "OFFBOARDING") { label = t("admin.accounts.stOffboarding"); color = "var(--orange)"; }
    else if (a.orgOnboardStatus === "FAILED") { label = t("admin.accounts.stFailed"); color = RED; }
    else if (a.onboarded && a.enabled) { label = t("admin.accounts.stActive"); color = "var(--green)"; }
    else if (a.onboarded) { label = t("admin.accounts.stRegistered"); color = "var(--muted)"; }
    return <span style={{ fontSize: 11.5, fontWeight: 600, padding: "2px 10px", borderRadius: 100, color, border: `1px solid ${color}` }}>{label}</span>;
  };

  /**
   * 接入方式徽章。
   *
   * 🔴 存在的理由只有一个：**下线的回收范围按它分岔**。
   *
   * ```
   * 一键接入   DeleteStackInstances → 成员账号里的栈真被删，资源全回收
   * 手动接入   StackSet 里没有它 → 只清本地登记；成员账号里的 agent space
   *            + IAM 角色留着，要客户自己去删那个栈（agent space 计费）
   * ```
   *
   * 原来两种账号在列表里长得一模一样，「下线」按钮也一样 —— 而点下去的结果
   * 完全不同。客户点完手动接入账号的下线，会以为已经清干净了。
   */
  const sourceBadge = (a: MemberAccountRec) => {
    if (!a.onboarded) return null;
    const manual = a.onboardSource === "manual";
    const color = manual ? "var(--blue)" : "var(--muted)";
    return (
      <span title={manual ? t("admin.accounts.srcManualTip")
        : t("admin.accounts.srcOneClickTip")}
        style={{
          fontSize: 10.5, fontWeight: 600, padding: "1px 8px",
          borderRadius: 100, color, border: `1px solid ${color}`,
        }}>
        {manual ? t("admin.accounts.srcManual") : t("admin.accounts.srcOneClick")}
      </span>
    );
  };

  // 第二步（DevOps Agent 关联）状态徽标：数据采集(第一步)完成后引导完成深度调查关联
  const daBadge = (a: MemberAccountRec) => {
    if (!a.onboarded || a.orgOnboardStatus !== "ACTIVE") return null;
    const st = a.devopsAgentStatus || "";
    let label = t("admin.accounts.daMissing"); let color = "var(--muted)"; let showGuide = true;
    // "active"=统一后的终态字面量(与老向导/消费方对齐);"enabled"=历史值,兼容显示
    if (st === "active" || st === "enabled") { label = t("admin.accounts.daEnabled"); color = "var(--green)"; showGuide = false; }
    else if (st === "provisioning") { label = t("admin.accounts.daAssociating"); color = "var(--orange)"; showGuide = false; }
    else if (st) { label = t("admin.accounts.daPending"); color = "var(--orange)"; }
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }} title={t("admin.accounts.daGuideTip")}>
        <span style={{ fontSize: 10.5, fontWeight: 600, padding: "1px 8px", borderRadius: 100, color, border: `1px solid ${color}` }}>
          {t("admin.accounts.daStep2")}: {label}
        </span>
        {showGuide && (
          <button onClick={async () => {
            try {
              const r = await associateDevopsAgent(a.accountId);
              setDaPolling((prev) => ({ ...prev, [r.operationId]: a.accountId }));
              await reload();
            } catch (e) { setErr(String((e as Error)?.message || e)); }
          }}
            style={{ fontSize: 11, fontWeight: 700, color: "var(--orange)", background: "transparent", border: "1px solid var(--orange)", borderRadius: 100, padding: "1px 10px", cursor: "pointer" }}>
            {t("admin.accounts.daGuideBtn")}
          </button>
        )}
        {showGuide && consoleUrl && (
          <a href={`${consoleUrl}/settings/devops-agent-accounts`} target="_blank" rel="noreferrer"
            title="手动向导（逃生通道）" style={{ fontSize: 11, color: "var(--muted)", textDecoration: "none" }}>↗</a>
        )}
      </span>
    );
  };

  // ── 可见性 ──
  const [users, setUsers] = useState<UserRec[]>([]);
  const [groups, setGroups] = useState<GroupRec[]>([]);
  const [visRecs, setVisRecs] = useState<AccountVisibilityRec[]>([]);
  const [principal, setPrincipal] = useState(""); // "user:<sub>" / "group:<name>"
  const [visAll, setVisAll] = useState(true);
  const [visSet, setVisSet] = useState<Set<string>>(new Set());
  const [visMsg, setVisMsg] = useState("");

  useEffect(() => {
    Promise.all([fetchUsers(), fetchGroups(), fetchAccountAccess()])
      .then(([u, g, v]) => { setUsers(u); setGroups(g); setVisRecs(v); })
      .catch((e) => setErr(String((e as Error)?.message || e)));
  }, []);

  const onboardedAccounts = accounts.filter((a) => a.onboarded);
  const principalKind = principal.split(":")[0] as "user" | "group";
  const principalId = principal.slice(principal.indexOf(":") + 1);

  const selectPrincipal = (p: string) => {
    setPrincipal(p); setVisMsg("");
    const kind = p.split(":")[0]; const id = p.slice(p.indexOf(":") + 1);
    const rec = visRecs.find((r) => r.kind === kind && r.id === id);
    if (!rec || rec.accounts === null || rec.accounts.includes("*")) { setVisAll(true); setVisSet(new Set()); }
    else { setVisAll(false); setVisSet(new Set(rec.accounts)); }
  };

  const saveVis = async () => {
    if (!principal) return;
    setVisMsg("");
    try {
      await putAccountAccess(principalKind, principalId, visAll ? ["*"] : [...visSet]);
      setVisRecs(await fetchAccountAccess());
      setVisMsg(t("admin.accounts.visSaved"));
    } catch (e) { setErr(String((e as Error)?.message || e)); }
  };
  const clearVis = async () => {
    if (!principal) return;
    try {
      await deleteAccountAccess(principalKind, principalId);
      setVisRecs(await fetchAccountAccess());
      setVisAll(true); setVisSet(new Set());
      setVisMsg(t("admin.accounts.visSaved"));
    } catch (e) { setErr(String((e as Error)?.message || e)); }
  };

  return (
    <div style={{ display: "grid", gap: 24 }}>
      {err && <div style={errText}>{err}</div>}
      {/* 🔴 改名的成功反馈**必须显示**，而且要说清 IM 推送标签改了没有。
          `reload()` 之后列表上那个名字确实变了，但推送标签在 `da#` 行不存在时
          是**没变**的 —— 两种结果在列表上长得一模一样。 */}
      {aliasMsg && (
        <div style={{ fontSize: 12.5, color: "var(--muted)",
          whiteSpace: "pre-line" }}>{aliasMsg}</div>
      )}

      {/*
        两个能力各自提示，**不再整页 early return**。
        🔴 原来「列不出账号」和「不能一键接入」挤在一个 orgDisabled 里，
           而它整页 return —— 于是手动接入（两个能力都不需要）也被挡掉。
      */}
      {!oneClick && (
        <div style={{
          // ⚠️ `whiteSpace: pre-line` —— 文案里用 \n 把两段分开
          //    （「怎么启用一键接入」/「不想动部署怎么办」）。不加它两段会连成
          //    一大坨，而那正是客户会跳过不读的形态（step2Hint 同理）。
          ...box, padding: "12px 14px", fontSize: 12.5,
          color: "var(--muted)", lineHeight: 1.7, whiteSpace: "pre-line",
          borderLeft: "3px solid var(--orange)",
        }}>
          {t("admin.accounts.noOneClick")}
        </div>
      )}
      {oneClick && !orgListable && (
        <div style={{
          // ⚠️ `whiteSpace: pre-line` —— 文案里用 \n 把两段分开
          //    （「怎么启用一键接入」/「不想动部署怎么办」）。不加它两段会连成
          //    一大坨，而那正是客户会跳过不读的形态（step2Hint 同理）。
          ...box, padding: "12px 14px", fontSize: 12.5,
          color: "var(--muted)", lineHeight: 1.7, whiteSpace: "pre-line",
          borderLeft: "3px solid var(--orange)",
        }}>
          {t("admin.accounts.noOrgList")}
        </div>
      )}

      {/* 成员账号接入 */}
      <div>
        {/* 🔴 判据是 `oneClick`（有没有 StackSet），**不是** `orgListable`
            （能不能列出组织账号）—— 那句文案讲的是一键接入这个机制。
            2026-08-26 实测：部署账号恰好是 org 管理账号（能 ListAccounts →
            orgListable=true）但没开 org 模式部署（MEMBER_ONBOARDING_STACKSET_NAME
            为空）。于是标题写着「组织内账号一键接入（CloudFormation StackSets）」，
            而列表里全是手动接入的账号、一键接入压根不可用 —— 客户看到手动接入的
            外部账号出现在「组织内一键接入」下面，合理地怀疑是不是搞错了。 */}
        <SectionHead title={t("admin.accounts.onboardTitle")}
          sub={oneClick ? t("admin.accounts.onboardDesc")
            : t("admin.accounts.onboardDescRegistered")} />
        <div style={{ ...box, padding: "4px 14px" }}>
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 0" }}>
            <button onClick={() => reload()} disabled={loading} style={{ fontSize: 12, padding: "4px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", cursor: "pointer" }}>{t("admin.accounts.refresh")}</button>
          </div>
          {/* ⚠️ 空态文案按能力分岔：「组织里没有别的账号」与「还没登记过任何
              账号」是两件完全不同的事，混成一句会让人以为组织是空的。 */}
          {accounts.length === 0 && !loading && (
            <div style={{ padding: "16px 0", color: "var(--muted)", fontSize: 13, lineHeight: 1.7 }}>
              {orgListable ? t("admin.accounts.empty")
                : t("admin.accounts.emptyRegistered")}
            </div>
          )}
          {accounts.map((a, i) => (
            <div key={a.accountId} style={{ borderTop: i === 0 ? "none" : "1px solid var(--line)" }}>
            {/* 行布局：
                  第 1 行  名称 ······················ 状态徽章  [操作按钮]
                  第 2 行  账号号 · 邮箱 · region（一条 muted 行）
                  第 3 行  DA 关联徽章（它很长，单独占一行）

                🔴 原来是「名称块(minWidth 220) | 状态 | region(flex:1) | 按钮」
                   四个并排。手动接入的账号 `regions` 是空数组，于是那个
                   flex:1 的 div 撑出一大片空白，「已接入」孤零零飘在中间，
                   而两个徽章被挤在 220px 里往下溢成第三行。 */}
            <div style={{ padding: "11px 0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--text)",
                  flex: 1, minWidth: 0, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.name || a.accountId}
                </div>
                {/* 状态 + 接入方式贴在一起靠右 —— 它们回答同一个问题
                    「这个账号现在是什么情况」，中间不该被空白隔开 */}
                <div style={{ display: "flex", gap: 6, alignItems: "center",
                  flexShrink: 0 }}>
                  {statusBadge(a)}
                  {sourceBadge(a)}
                  {/* 🔴 「组织外」徽章。后端此前只列 ListAccounts 返回的账号
                      ⇒ 跨 org 接入的账号即使两行都写好、巡检也照常扇出它，
                      管理页上它**永远不存在** —— 而手动接入流程本身全绿、
                      页面提示「已保存并激活」。运维看到成功，然后在列表里
                      找不到它。
                      ⚠️ 标出来是因为**能做的操作不同**（一键接入/下线走
                         StackSet，覆盖不到它）—— 不标的话运维会以为列表串了
                         账号，或者反复去点那个对它无效的按钮。 */}
                  {/* 「自定义名」徽章。
                      ⚠️ 存在的理由是**排查跨账号问题时的对账**：行首那个名字
                         如果是人手起的，它在 AWS 控制台里搜不到 ——
                         不标的话运维会拿它去 Organizations 里找，找不到。
                         标了之后第二行的账号号就是唯一可靠的抓手。 */}
                  {a.aliasManual && (
                    <span title={t("admin.accounts.aliasManualHint")}
                      style={{ fontSize: 11, padding: "2px 8px",
                        borderRadius: 6, border: "1px dashed var(--line)",
                        color: "var(--muted)", cursor: "help",
                        whiteSpace: "nowrap" }}>
                      {t("admin.accounts.aliasManual")}
                    </span>
                  )}
                  {a.outOfOrg && (
                    <span title={t("admin.accounts.outOfOrgHint")}
                      style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px",
                        borderRadius: 6, border: "1px solid var(--line)",
                        color: "var(--muted)", cursor: "help",
                        whiteSpace: "nowrap" }}>
                      {t("admin.accounts.outOfOrg")}
                    </span>
                  )}
                  {/* 🔴 「要重新部署栈」的徽章。这个账号采集照跑、花
                      GetMetricData，而判读永远为空 —— 而看板上「N 条未做根因
                      分析」与「DA 说这些没问题」长得一样。管理页是唯一能看出
                      这件事的地方。
                      ⚠️ 用 title 带出完整说明：徽章只有四个字，而客户需要知道
                         「为什么」和「怎么做」。CFN 的 quick-create 链接**只支持
                         创建**（官方文档确认没有更新栈的形式），所以这里只能给
                         文字步骤，不能给一键链接。 */}
                  {a.needsStackUpdate && (
                    <span title={t("admin.accounts.needsUpdateHint")}
                      style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px",
                        borderRadius: 6, border: "1px solid #d13212",
                        color: "#d13212", background: "rgba(209,50,18,.08)",
                        cursor: "help", whiteSpace: "nowrap" }}>
                      {t("admin.accounts.needsUpdate")}
                    </span>
                  )}
                </div>
              {/* ⚠️ 一键接入要 StackSet —— 不可用时**不渲染**而不是灰着：
                  灰着等于在界面上摆一个用户无法解决的问题（本文件既有约定）。 */}
              {/* ⚠️ `!a.outOfOrg`：一键接入走 StackSet（SERVICE_MANAGED +
                  OU 下发），**覆盖不到组织外账号**。渲染它会让运维点了之后
                  拿到一个 StackSet 侧的错，而正确做法是走底部的「跨 Payer
                  接入」重新生成链接。
                  ⚠️ 不渲染而不是灰着 —— 灰着等于在界面上摆一个用户无法解决
                     的问题（本文件既有约定）。 */}
              {oneClick && !a.outOfOrg && a.orgOnboardStatus !== "PROVISIONING" && a.orgOnboardStatus !== "OFFBOARDING" && !(a.onboarded && a.enabled) && (
                <button onClick={() => { setTarget(a); setRegionsInput(a.regions?.join(",") || "us-east-1"); }}
                  style={{ fontSize: 12.5, fontWeight: 600, padding: "5px 14px", borderRadius: 8, border: "1px solid var(--orange)", background: "rgba(255,153,0,.10)", color: "var(--text)", cursor: "pointer" }}>
                  {a.orgOnboardStatus === "FAILED" ? t("admin.accounts.retryBtn") : t("admin.accounts.onboardBtn")}
                </button>
              )}
              {/* 🔴 采集 Region 的**内联编辑**。此前那个输入框只出现在「接入」
                  流程里（`setTarget`），也就是说账号一旦上车就**再也改不了**
                  它的采集范围 —— 而唯一的入口「接入」按钮在 `a.onboarded &&
                  a.enabled` 之后就不渲染了。
                  ⚠️ 走独立路由（PUT .../regions），不触发 StackSet 下发。 */}
              {a.onboarded && (
                <button onClick={() => setEditRegions(
                  editRegions?.accountId === a.accountId
                    ? null
                    : { accountId: a.accountId, value: a.regions.join(",") })}
                  style={{ fontSize: 12, padding: "5px 12px", borderRadius: 8,
                    border: "1px solid var(--line)",
                    background: editRegions?.accountId === a.accountId
                      ? "rgba(255,153,0,.10)" : "transparent",
                    color: "var(--muted)", cursor: "pointer" }}
                  title={a.regions.join(", ")}>
                  {t("admin.accounts.regionsEdit")}
                </button>
              )}
              {/* 🔴 显示名（alias）的内联编辑。
                  这两个字段此前**只在接入那一刻写一次**，来源是
                  `organizations:DescribeAccount` 的 Account.Name ——
                  而跨组织接入的账号那个调用拿不到东西（账号不在本组织里），
                  于是客户在账号选择器和 IM 推送里看到的是**十二位数字**。
                  ⚠️ 与「改 Region」同构：独立路由、不碰 StackSet。 */}
              {a.onboarded && (
                <button onClick={() => { setAliasMsg(""); setEditAlias(
                  editAlias?.accountId === a.accountId
                    ? null
                    // 🔴 **只在 `aliasManual` 时预填**。预填 org 名的表现是：
                    //    客户点开、什么都不改就保存 → 那个 org 名被标记成
                    //    manual 落库 → 以后 AWS 上改了账号名这里再也不跟着变，
                    //    而客户从没输入过任何东西。
                    : { accountId: a.accountId, value: a.aliasManual ? a.name : "" });
                }}
                  style={{ fontSize: 12, padding: "5px 12px", borderRadius: 8,
                    border: "1px solid var(--line)",
                    background: editAlias?.accountId === a.accountId
                      ? "rgba(255,153,0,.10)" : "transparent",
                    color: "var(--muted)", cursor: "pointer" }}
                  title={t("admin.accounts.aliasHint")}>
                  {t("admin.accounts.aliasEdit")}
                </button>
              )}
              {a.onboarded && a.orgOnboardStatus === "ACTIVE" && (
                <button onClick={async () => { try { await setMemberAccountEnabled(a.accountId, !a.enabled); await reload(); } catch (e) { setErr(String((e as Error)?.message || e)); } }}
                  style={{ fontSize: 12, padding: "5px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", cursor: "pointer" }}>
                  {a.enabled ? t("admin.accounts.disableBtn") : t("admin.accounts.enableBtn")}
                </button>
              )}
              {a.onboarded && a.orgOnboardStatus !== "OFFBOARDING" && a.orgOnboardStatus !== "PROVISIONING" && (
                <button onClick={async () => {
                  // 🔴 确认文案按接入方式分岔：手动接入的账号我们**删不掉**
                  //    成员账号里那个栈（StackSet 里没有它的 instance）。
                  //    不在确认框里说清楚，客户点完会以为资源都回收了，而
                  //    agent space 还在那儿计费。
                  const manual = a.onboardSource === "manual";
                  const warn = manual ? `\n\n${t("admin.accounts.offboardManualWarn")}` : "";
                  const typed = window.prompt(
                    `${t("admin.accounts.offboardConfirm")}${warn}\n${a.accountId}`);
                  if (typed !== a.accountId) return;
                  try {
                    const r = await offboardMemberAccount(a.accountId);
                    if (r.operationId) setPolling((prev) => ({ ...prev, [r.operationId]: a.accountId }));
                    // 后端确认那个栈没被删 → 把要删的栈名直接给出来，
                    // 而不是让客户自己去 CloudFormation 里认哪个是我们的。
                    if (r.stackRetained && r.stackName) {
                      setErr(`${t("admin.accounts.offboardRetained")} ${r.stackName}`
                        + (r.stackRegion ? ` (${r.stackRegion})` : ""));
                    }
                    await reload();
                  } catch (e) { setErr(String((e as Error)?.message || e)); }
                }}
                  style={{ fontSize: 12, padding: "5px 12px", borderRadius: 8, border: "1px solid #d13212", background: "transparent", color: "#d13212", cursor: "pointer" }}>
                  {t("admin.accounts.offboardBtn")}
                </button>
              )}
              </div>
              {/* 第 2 行：号 · 邮箱 · region 合成一条，而不是各占一列 */}
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>
                {[a.accountId, a.email, (a.regions || []).join(", ")]
                  .filter(Boolean).join(" · ")}
              </div>
              {/* 采集 Region 的编辑行（点上面那个「改 Region」才展开） */}
              {editRegions?.accountId === a.accountId && (
                <div style={{ marginTop: 8, padding: 10, borderRadius: 8,
                  border: "1px solid var(--line)", background: "var(--bg2, transparent)" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input value={editRegions.value}
                      onChange={(e) => setEditRegions(
                        { accountId: a.accountId, value: e.target.value })}
                      onKeyDown={(e) => { if (e.key === "Enter") void submitRegions(); }}
                      placeholder="us-east-1,us-east-2"
                      style={{ flex: 1, padding: "6px 10px", borderRadius: 8,
                        border: "1px solid var(--line)", background: "var(--bg)",
                        color: "var(--text)", fontSize: 13 }} />
                    <button onClick={() => void submitRegions()} disabled={savingRegions}
                      style={{ fontSize: 12.5, fontWeight: 700, padding: "6px 14px",
                        borderRadius: 8, border: "none", background: "var(--orange)",
                        color: "#fff", cursor: savingRegions ? "default" : "pointer" }}>
                      {t("admin.accounts.confirmBtn")}
                    </button>
                    <button onClick={() => setEditRegions(null)}
                      style={{ fontSize: 12.5, padding: "6px 12px", borderRadius: 8,
                        border: "1px solid var(--line)", background: "transparent",
                        color: "var(--muted)", cursor: "pointer" }}>
                      {t("admin.accounts.cancelBtn")}
                    </button>
                  </div>
                  {/* 🔴 这一句必须在。客户在这里填 `us-east-1` 的自然预期是
                      「只看这个区」，而**资源巡检不读这个字段** —— 它扫账号下
                      全部已启用 region。不说清楚的话客户第二天在巡检报告里看到
                      eu-west-1 的 finding，会回来反复改这个框，而改成什么都没用。 */}
                  <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6,
                    whiteSpace: "pre-line" }}>
                    {t("admin.accounts.regionsPrompt")}
                  </div>
                </div>
              )}
              {/* 显示名的编辑行（点上面那个「改名」才展开） */}
              {editAlias?.accountId === a.accountId && (
                <div style={{ marginTop: 8, padding: 10, borderRadius: 8,
                  border: "1px solid var(--line)", background: "var(--bg2, transparent)" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input value={editAlias.value}
                      onChange={(e) => setEditAlias(
                        { accountId: a.accountId, value: e.target.value })}
                      onKeyDown={(e) => { if (e.key === "Enter") void submitAlias(); }}
                      maxLength={64}
                      /* ⚠️ 占位符是**当前生效的名字**（org 名或账号号）——
                         客户要能看出「留空会回退成什么」。写死一句
                         「输入别名」会让「清空」这个操作的结果完全不可预测。 */
                      placeholder={a.name || a.accountId}
                      style={{ flex: 1, padding: "6px 10px", borderRadius: 8,
                        border: "1px solid var(--line)", background: "var(--bg)",
                        color: "var(--text)", fontSize: 13 }} />
                    <button onClick={() => void submitAlias()} disabled={savingAlias}
                      style={{ fontSize: 12.5, fontWeight: 700, padding: "6px 14px",
                        borderRadius: 8, border: "none", background: "var(--orange)",
                        color: "#fff", cursor: savingAlias ? "default" : "pointer" }}>
                      {t("admin.accounts.confirmBtn")}
                    </button>
                    <button onClick={() => setEditAlias(null)}
                      style={{ fontSize: 12.5, padding: "6px 12px", borderRadius: 8,
                        border: "1px solid var(--line)", background: "transparent",
                        color: "var(--muted)", cursor: "pointer" }}>
                      {t("admin.accounts.cancelBtn")}
                    </button>
                  </div>
                  {/* 🔴 三件事必须写在这里：改了会影响哪些地方、留空等于清空、
                      以及**已经建好的 agent space 不会跟着改名**。
                      最后那件不说的话客户改完会去 DevOps Agent 控制台找那个新
                      名字，找不到，然后以为保存失败了。 */}
                  <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6,
                    whiteSpace: "pre-line" }}>
                    {t("admin.accounts.aliasPrompt")}
                  </div>
                </div>
              )}
              {/* 第 3 行：DA 徽章（含「立即关联」按钮时更长），单独一行 */}
              {daBadge(a) && (
                <div style={{ marginTop: 5 }}>{daBadge(a)}</div>
              )}
            </div>
            {/* 巡检的跨账号前置。
                ⚠️ 不用判「是不是部署账号」—— `listMemberAccounts()` 已经把
                部署账号自己排除了（它不属于「成员接入」范畴，见那个函数的注释）。
                只判 `onboarded`：没接进来的账号谈不上巡检前置。 */}
            {a.onboarded && (
              <InspectionCrossAccountSection accountId={a.accountId} />
            )}
            </div>
          ))}
          {/* 手动接入并进**同一张卡的底部** —— 它产出的账号就出现在上面那个
              列表里，两者是一件事的两半。
              🔴 原来它排在「账号数据可见性」**后面**，隔了一整个区块，于是
                 「一键接入不可用」的部署上，客户看完列表往下翻先撞到一个
                 无关的可见性配置，唯一能用的接入入口反而在最下面。 */}
          <div style={{ borderTop: "1px solid var(--line)", padding: "10px 0 4px" }}>
            <CrossPayerSection onDone={reload} />
          </div>
        </div>
        {target && (
          <div style={{ ...box, padding: 16, marginTop: 10 }}>
            <FieldLabel>{`${target.name || target.accountId} (${target.accountId})`}</FieldLabel>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input value={regionsInput} onChange={(e) => setRegionsInput(e.target.value)} placeholder="us-east-1,ap-southeast-1"
                style={{ flex: 1, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg)", color: "var(--text)", fontSize: 13 }} />
              <button onClick={submitOnboard} disabled={submitting}
                style={{ fontSize: 12.5, fontWeight: 700, padding: "7px 16px", borderRadius: 8, border: "none", background: "var(--orange)", color: "#fff", cursor: "pointer" }}>{t("admin.accounts.confirmBtn")}</button>
              <button onClick={() => setTarget(null)} style={{ fontSize: 12.5, padding: "7px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", cursor: "pointer" }}>{t("admin.accounts.cancelBtn")}</button>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>{t("admin.accounts.regionsPrompt")}</div>
          </div>
        )}
      </div>

      {/* 账号数据可见性 */}
      <div>
        <SectionHead title={t("admin.accounts.visTitle")} sub={t("admin.accounts.visDesc")} />
        <div style={{ ...box, padding: 16 }}>
          <FieldLabel>{t("admin.accounts.visPrincipal")}</FieldLabel>
          <select value={principal} onChange={(e) => selectPrincipal(e.target.value)}
            style={{ width: "100%", maxWidth: 420, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg)", color: "var(--text)", fontSize: 13, marginBottom: 14 }}>
            <option value="">{t("admin.accounts.visPick")}</option>
            <optgroup label={t("admin.accounts.visGroup")}>
              {groups.map((g) => <option key={`group:${g.name}`} value={`group:${g.name}`}>{groupName(t, g.name)}</option>)}
            </optgroup>
            <optgroup label={t("admin.accounts.visUser")}>
              {users.map((u) => <option key={`user:${u.sub}`} value={`user:${u.sub}`}>{u.username}</option>)}
            </optgroup>
          </select>

          {principal && (
            <>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 600, color: "var(--text)", marginBottom: 10, cursor: "pointer" }}>
                <input type="checkbox" checked={visAll} onChange={() => setVisAll(!visAll)} />
                {t("admin.accounts.visAll")}
              </label>
              {!visAll && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                  {onboardedAccounts.map((a) => {
                    const checked = visSet.has(a.accountId);
                    return (
                      <label key={a.accountId} title={a.accountId} style={{
                        display: "inline-flex", gap: 6, alignItems: "center", padding: "4px 10px", borderRadius: 100, cursor: "pointer",
                        border: `1px solid ${checked ? "var(--orange)" : "var(--line)"}`, background: checked ? "rgba(255,153,0,.10)" : "transparent",
                        fontSize: 12.5, fontWeight: checked ? 600 : 500, color: checked ? "var(--text)" : "var(--muted)",
                      }}>
                        <input type="checkbox" checked={checked} style={{ margin: 0 }}
                          onChange={() => setVisSet((prev) => { const n = new Set(prev); if (n.has(a.accountId)) n.delete(a.accountId); else n.add(a.accountId); return n; })} />
                        {a.name || a.accountId}
                      </label>
                    );
                  })}
                </div>
              )}
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button onClick={saveVis} style={{ fontSize: 12.5, fontWeight: 700, padding: "7px 16px", borderRadius: 8, border: "none", background: "var(--orange)", color: "#fff", cursor: "pointer" }}>{t("admin.accounts.visSave")}</button>
                <button onClick={clearVis} style={{ fontSize: 12.5, padding: "7px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", cursor: "pointer" }}>{t("admin.accounts.visReset")}</button>
                {visMsg && <span style={{ color: "var(--green)", fontSize: 12.5 }}>{visMsg}</span>}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── 跨 Payer 接入(组织外账号) ── */}
    </div>
  );
}

/** 跨 Payer 接入:添加组织外账号(模板分发 + 手工回填 + 测试连接)。 */
function CrossPayerSection({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [acctId, setAcctId] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launchUrl, setLaunchUrl] = useState("");
  // 回填
  const [spaceId, setSpaceId] = useState("");
  const [roleArn, setRoleArn] = useState("");
  // 巡检判读用的第二个 space（模板输出 InspectionAgentSpaceId）。
  // ⚠️ 可选 —— 存量账号部署的旧模板没有这个输出，做成必填会让他们连排障那半
  //    都回填不了。所以下面「保存」按钮的 disabled 判据**不含**它。
  const [inspectSpaceId, setInspectSpaceId] = useState("");
  const [saving, setSaving] = useState(false);
  // 测试连接
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const genUrl = async () => {
    if (!/^[0-9]{12}$/.test(acctId.trim())) { setMsg({ ok: false, text: t("admin.xpayer.invalidId") }); return; }
    setLaunching(true); setMsg(null);
    try {
      const r = await generateLaunchStack(acctId.trim());
      setLaunchUrl(r.launchStackUrl);
    } catch (e) { setMsg({ ok: false, text: String((e as Error)?.message || e) }); }
    finally { setLaunching(false); }
  };

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      await saveManualPayload(acctId.trim(), {
        agent_space_id: spaceId.trim(),
        trigger_role_arn: roleArn.trim(),
        // 空串时不传 —— BFF 侧对空值不写那个字段（写进去与没有它在读侧同结果，
        // 但 DDB 上多一个看起来配过的空字段会让排查误导）。
        ...(inspectSpaceId.trim()
          ? { inspect_agent_space_id: inspectSpaceId.trim() } : {}),
      });
      setMsg({ ok: true, text: t("admin.xpayer.saved") });
      onDone();
    } catch (e) { setMsg({ ok: false, text: String((e as Error)?.message || e) }); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true); setMsg(null);
    try {
      // 🔴 **把输入框里的值当 probe 传下去** —— 「测试」的语义本该是
      //    「测我填的这些对不对」，而不是「测库里已经存着的那些」。
      //
      //    没有它的表现（2026-08-27 实测）：客户按自然顺序操作 ——
      //    填完两个框 → 点「测试连接」（两个按钮并排）→ 拿到
      //    「account not configured — fill in Agent Space ID and Trigger
      //    Role ARN (or click Save first)」，而他**明明刚填了那两个值**。
      //
      // ⚠️ 这条修复的后端三环（member_accounts 的 probe 参数、index.mjs 的
      //    路由透传、api/admin.ts 的签名）都改好了，唯独**这一行没接** ——
      //    又是「算好了但调用方没取」那个形态。所以 scripts/lint_seams.py
      //    只覆盖 Python 侧是不够的，前端同样会犯。
      const probe = (spaceId.trim() && roleArn.trim())
        ? { agent_space_id: spaceId.trim(), trigger_role_arn: roleArn.trim() }
        : undefined;
      const r = await testDaConnection(acctId.trim(), probe);
      if (r.success) setMsg({ ok: true, text: t("admin.xpayer.testOk") });
      else setMsg({ ok: false, text: `${r.step}: ${r.error}` });
    } catch (e) { setMsg({ ok: false, text: String((e as Error)?.message || e) }); }
    finally { setTesting(false); }
  };

  return (
    <div style={{ marginTop: 22 }}>
      <button style={btnGhost} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {t("admin.xpayer.title")}
      </button>
      {open && (
        <div style={{ ...box, padding: 16, marginTop: 10, maxWidth: 640, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ color: "var(--muted)", fontSize: 12.5, lineHeight: 1.6 }}>{t("admin.xpayer.desc")}</div>
          {/* Step 1: 生成链接 */}
          <div>
            <FieldLabel>{t("admin.xpayer.acctLabel")}</FieldLabel>
            <div style={{ display: "flex", gap: 8 }}>
              <input style={{ ...inputStyle, flex: 1 }} value={acctId} onChange={(e) => setAcctId(e.target.value)} placeholder="123456789012" />
              <button style={btnPrimary} disabled={launching} onClick={genUrl}>
                {launching ? "..." : t("admin.xpayer.genBtn")}
              </button>
            </div>
          </div>
          {launchUrl && (
            <>
              <div>
                <FieldLabel>Launch Stack URL</FieldLabel>
                <a href={launchUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5, color: "var(--blue)", wordBreak: "break-all" }}>
                  {t("admin.xpayer.openStack")}
                </a>
                <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 4 }}>{t("admin.xpayer.stackHint")}</div>
              </div>
              {/* Step 2: 回填 */}
              <div>
                <FieldLabel>Agent Space ID</FieldLabel>
                <input style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }} value={spaceId} onChange={(e) => setSpaceId(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
              </div>
              <div>
                <FieldLabel>Trigger Role ARN</FieldLabel>
                <input style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }} value={roleArn} onChange={(e) => setRoleArn(e.target.value)} placeholder="arn:aws:iam::123456789012:role/notiops-agent-trigger-..." />
              </div>
              {/* 🔴 第三个框：巡检判读用的 space（模板输出 InspectionAgentSpaceId）。
                  不接这个框的后果是**成员账号永远不派巡检判读** —— 那个字段的
                  读取函数早就存在（accounts.inspect_space_id / inspect_space_ids），
                  缺的一直是写入面。
                  ⚠️ 标注「可选」并说清缺它会怎样：存量账号部署的旧模板没有这个
                     输出，客户在 Outputs 里找不到它时需要知道那不是他填错了。 */}
              <div>
                <FieldLabel>{t("admin.xpayer.inspectSpaceLabel")}</FieldLabel>
                <input style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                  value={inspectSpaceId}
                  onChange={(e) => setInspectSpaceId(e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
                <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 4 }}>
                  {t("admin.xpayer.inspectSpaceHint")}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {/* 🔴 顺序是「测试 → 保存」，不是反的。
                    客户的自然动作是「填完先验一下，通过了再存」，而原来
                    「保存」在左、且「测试」只测已保存的记录 —— 按自然顺序
                    操作必然先撞一次 account not configured。
                    ⚠️ 测试用的是输入框里的值（见 test() 里的 probe），
                       所以先测后存现在是**成立**的。 */}
                <button style={btnGhost}
                  disabled={testing || !acctId.trim() || !spaceId.trim() || !roleArn.trim()}
                  onClick={test}>
                  {testing ? "..." : t("admin.xpayer.testBtn")}
                </button>
                <button style={btnPrimary} disabled={saving || !spaceId.trim() || !roleArn.trim()} onClick={save}>
                  {saving ? "..." : t("admin.xpayer.saveBtn")}
                </button>
              </div>
            </>
          )}
          {msg && <div style={msg.ok ? okText : errText}>{msg.text}</div>}
        </div>
      )}
    </div>
  );
}

/* ───────────────── 跨账号巡检的前置 ───────────────── */

/**
 * 让**巡检**能真的采到一个成员账号，需要两件互相独立的东西。
 *
 * 这个区块只做两件事：**告诉客户还缺什么**，以及把能自动化的那一步
 * （采集角色的验证 + 登记）做成一个按钮。两个 CFN 模板都必须由账号所有者
 * 在自己账号里点，我们代不了。
 *
 * ```
 * ① 采集凭证   account#<id> 的 role_arn
 *              executor 用它 AssumeRole 进去 describe / 读 CloudWatch
 *              🔴 **必需** —— 缺了整轮巡检直接失败
 *
 * ② 判读深度   把该账号作为 monitor account 关联进**系统账号的巡检 space**
 *              DA 判读时才能主动查它的 PI / events
 *              ⚠️ 可选 —— 缺了判读仍出结论（payload 里有 7 天指标），
 *                 只是少了主动深挖那一半
 * ```
 *
 * 🔴 **巡检共用系统账号的一个 space**，根因调查才是每账号一个。所以 ② 是
 * 「把成员账号加进那一个 space」，不是「给它建自己的 space」——
 * 界面上必须写清这一点，否则客户会去成员账号自己的 space 里找。
 */
/**
 * 巡检跨账号前置的一行状态。
 *
 * ```
 * ① 采集角色（必需）   在此账号操作 → <账号号>   ●缺失（巡检会失败）   [验证]
 * ```
 *
 * 🔴 「在哪个账号操作」必须带号码：①在成员账号里做、②在系统账号里做，
 *    这是跨账号流程最容易搞错的一件事，而客户手里可能有好几个账号。
 */
function StepRow({ n, label, where, whereColor, ok, statusText, statusColor, action }: {
  n: string; label: string; where: string; whereColor: string;
  ok: boolean; statusText: string; statusColor: string; action: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
      border: "1px solid var(--line)", borderRadius: 8, padding: "7px 10px",
      borderLeft: `3px solid ${ok ? "var(--green)" : statusColor}`,
    }}>
      <span style={{ fontWeight: 600 }}>{n} {label}</span>
      <span style={{
        fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 100,
        color: whereColor, border: `1px solid ${whereColor}`, whiteSpace: "nowrap",
      }}>{where}</span>
      <span style={{ color: statusColor, flex: 1, minWidth: 90 }}>{statusText}</span>
      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>{action}</span>
    </div>
  );
}

function InspectionCrossAccountSection({ accountId }: { accountId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<InspectionCrossAccountStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [stackUrl, setStackUrl] = useState("");
  const [gen, setGen] = useState(false);
  const [assoc, setAssoc] = useState(false);
  /** 长说明的折叠位。默认收起 —— 客户展开这一块要的是「现在能不能采」，
      而不是两段关于机制的解释。 */
  const [why, setWhy] = useState(false);

  /**
   * 🔴 **挂载时就拉状态，不等客户展开。**
   *
   * 客户 2026-08-27 原话：「你做成这么小的一行，而且还自动折叠起来了，
   * 我都没有发现，你不说我都不会去点开看，以为已经完全配置好了」。
   *
   * 一个折叠、不显示任何状态的标题栏，对客户的含义是「这里没事」。而实际
   * 可能是「①采集角色缺失 → 整轮巡检直接失败」。上一版把信息密度压下去的
   * 时候把**可见性**一起压掉了 —— 而这一块的全部价值就是让人看见缺什么。
   *
   * ⚠️ 代价是每个已接入账号一次请求（DDB get + 一次 ListAssociations）。
   *    可接受：账号数是个位数，而漏报一个「巡检会失败」的代价是客户以为
   *    配好了、然后每天收不到那个账号的任何结论。
   */
  /** 阻塞级问题只自动展开**一次**。用 ref 而不是 state —— 它不参与渲染。 */
  const autoOpenedRef = useRef(false);

  /**
   * 落状态 + **阻塞级问题自动展开一次**。挂载探测与手动刷新共用。
   *
   * 徽章能让人看见「有问题」，但客户仍要点一下才知道怎么办 —— 而①缺失意味着
   * 这个账号一条结论都产不出来，那个代价大到不该多一次点击。
   *
   * ⚠️ 只展开一次（`autoOpenedRef`）。每次刷新都强制展开会覆盖客户手动折叠的
   *    动作 —— 那种「关不掉」的界面比藏起来更烦。
   * ⚠️ 只对①（阻塞）展开，②（降级）不展开：自动展开每一个降级项会让账号
   *    列表整页铺开。
   */
  const applyStatus = useCallback((d: InspectionCrossAccountStatus) => {
    setData(d);
    const blocking = Boolean(d?.collection)
      && (!d.collection.registered || d.collection.mismatch);
    if (blocking && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setOpen(true);
    }
  }, []);

  const load = useCallback(async (silent = false) => {
    // ⚠️ `silent` 存在的唯一理由是**能在 useEffect 里调它**。
    //    `setLoading(true)` 是同步 setState，放进 effect 会被 React 19 的
    //    `react-hooks/set-state-in-effect` 直接报错。silent 模式跳过它，
    //    第一次 setState 发生在 await 之后（已经出了同步的 effect 体）。
    // 🔴 silent 模式下**两个 setState 都要跳过**，不只 setLoading。
    //
    //    `setMsg(null)` 原来是无条件的 → 它仍然是同步 setState，放进
    //    `useEffect` 照样被 `react-hooks/set-state-in-effect` 拦下
    //    （「Calling setState synchronously within an effect can trigger
    //      cascading renders」）。
    //
    // ⚠️ 这不只是为了过 lint：后台静默刷新去清掉客户刚看到的那条提示
    //    （比如「已关联进巡检 Agent Space」）本身就是错的 —— 他会以为
    //    那次操作没生效。silent 的语义就该是「不动任何可见状态，只更新数据」。
    if (!silent) { setLoading(true); setMsg(null); }
    try {
      applyStatus(await fetchInspectionCrossAccount(accountId));
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error)?.message || e) });
    } finally { if (!silent) setLoading(false); }
  }, [accountId, applyStatus]);

  /**
   * 🔴 **挂载时就拉状态，不等客户展开。**
   *
   * 客户 2026-08-27 原话：「你做成这么小的一行，而且还自动折叠起来了，
   * 我都没有发现，你不说我都不会去点开看，以为已经完全配置好了」。
   *
   * 一个折叠、不显示任何状态的标题栏，对客户的含义是「这里没事」。而实际
   * 可能是「①采集角色缺失 → 整轮巡检直接失败」。上一版把信息密度压下去的
   * 时候把**可见性**一起压掉了 —— 而这一块的全部价值就是让人看见缺什么。
   *
   * ⚠️ 必须放在 `load` **声明之后** —— 放前面 React Compiler 会报
   *    「Cannot access variable before it is declared」（那不是风格问题：
   *    闭包捕获的是初始化前的绑定，`load` 变化时这个 effect 不会更新）。
   * ⚠️ 用 `silent` 模式：`setLoading(true)` 是同步 setState，放进 effect
   *    会被 `react-hooks/set-state-in-effect` 拦。
   */
  useEffect(() => {
    // ⚠️ effect **自己做 await**，不调 `load(true)`。
    //    `load` 里那个 `if (!silent) setLoading(...)` 分支让 linter 静态证不了
    //    「这次调用不会同步 setState」，于是 `react-hooks/set-state-in-effect`
    //    照样报。这样写零同步 setState，而且 lint 能验证。
    //
    // ⚠️ `dead` 守卫是 `load` 路径**缺的东西**：账号切走或组件卸载之后，
    //    在途的响应回来会 setState 到一个已经不存在的实例上
    //    （React 会警告，而且对着新账号显示旧账号的状态）。
    let dead = false;
    (async () => {
      try {
        const d = await fetchInspectionCrossAccount(accountId);
        if (!dead) applyStatus(d);
      } catch {
        // 🔴 挂载时的后台探测**静默失败**。这一步客户没有主动触发，
        //    弹一条红字（比如没有 nav:inspection 权限时）会让整页看起来坏了。
        //    真要看状态时点展开会走 `load()`，那条路径会如实报错。
      }
    })();
    return () => { dead = true; };
  }, [accountId, applyStatus]);


  // 生成采集角色模板的 Launch Stack URL。客户在**目标账号**点开它部署。
  // ⚠️ 我们不能代部署 —— 那要目标账号的 CFN 写权限，而我们只有只读跨账号角色
  //    （而且那个角色本身就是这个模板要建的，鸡生蛋）。
  const genStack = async () => {
    setGen(true); setMsg(null);
    try {
      const r = await generateInspectionCollectionStack(accountId);
      setStackUrl(r.launchStackUrl);
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error)?.message || e) });
    } finally { setGen(false); }
  };

  /**
   * 复制到剪贴板。
   *
   * ⚠️ 跨账号操作时**复制才是主要用法** —— Launch Stack URL 要拿到另一个
   * 浏览器会话（用目标账号登录）里打开，直接点会在当前账号建栈。
   * space id 同理：要贴进 DevOps Agent 控制台的搜索框。
   *
   * ⚠️ `navigator.clipboard` 在非安全上下文里是 undefined（本地 http 调试）。
   * 失败就提示手动复制，不静默 —— 客户点了没反应会以为按钮坏了。
   */
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMsg({ ok: true, text: `${label} ${t("admin.inspxacct.copied")}` });
    } catch {
      setMsg({ ok: false, text: t("admin.inspxacct.copyFailed") });
    }
  };

  const verify = async () => {
    setVerifying(true); setMsg(null);
    try {
      const r = await verifyInspectionCollectionRole(accountId);
      setMsg({ ok: true, text: `${t("admin.inspxacct.verifyOk")}：${r.roleArn}` });
      // 验证通过说明模板已经部署好了 —— 清掉那个链接，否则它还挂在界面上
      // 诱导客户再点一次（presign 12h 内都能打开，重复建栈会报 AlreadyExists）。
      setStackUrl("");
      await load();
    } catch (e) {
      // ⚠️ 原样显示 AWS 的话 —— AccessDenied 与 NoSuchEntity 指向完全不同的动作
      //    （前者信任策略不对，后者模板还没部署）。翻译成一句「失败」会让客户
      //    无从下手。
      setMsg({ ok: false, text: String((e as Error)?.message || e) });
    } finally { setVerifying(false); }
  };

  /**
   * ②：一键把这个账号关联进系统账号的巡检 Agent Space。
   *
   * 原来这一步只能让客户进 DevOps Agent 控制台走「添加辅助云来源」向导 ——
   * 7 步，其中 6 步是手抄一段自定义信任策略去建 IAM 角色。拆开之后：
   *
   * ```
   * 角色（要在成员账号里建 IAM）  → 接入那个 CFN 模板建好，客户看不见
   * 关联（系统账号的一次 API）    → 这个按钮
   * ```
   *
   * ⚠️ `status` 才是真相，不是「调用成功了」：角色那半没到位时关联照样能建，
   *    状态是 invalid —— 只报「已关联 ✓」会把这种情况说成好的。
   */
  const link = async () => {
    setAssoc(true); setMsg(null);
    try {
      const r = await associateInspectionSource(accountId);
      const base = r.created ? t("admin.inspxacct.assocOk")
        : t("admin.inspxacct.assocExists");
      if (r.status === "invalid") {
        setMsg({ ok: false, text: t("admin.inspxacct.assocInvalid") });
      } else if (r.status === "pending-confirmation") {
        setMsg({ ok: false, text: t("admin.inspxacct.assocPending") });
      } else {
        setMsg({ ok: true, text: base });
      }
      await load();
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error)?.message || e) });
    } finally { setAssoc(false); }
  };

  const sp = data?.inspectionSpace;
  const col = data?.collection;
  const mon = data?.monitorAssociation;
  /** 「②真的到位了」= 关联在 + 校验没说 invalid。 */
  const monOk = mon?.linked === true && mon?.status !== "invalid"
    && mon?.status !== "pending-confirmation";

  /** ①真的到位了 = 登记过 **且**与模板会建的那个一致（mismatch 会让 assume 永远失败）。 */
  const colOk = Boolean(col?.registered) && !col?.mismatch;

  /**
   * 折叠标题上的状态徽章 —— 三档。
   *
   * ```
   * 采集角色缺失/对不上   红   **巡检会失败**（整轮产不出任何结论）  → 自动展开
   * 判读未关联/invalid    琥珀 采集正常，只是判读少了主动深挖那一半
   * 全部就绪              绿   不用点开
   * ```
   *
   * ⚠️ 三档而不是两档：①与②的**后果量级不同**。把它们并成一个「未配置完」
   *    会让客户按同一个优先级处理，而①是阻塞、②是降级。
   */
  const headBadge = (() => {
    if (!data) return null;                 // 还没拉到 / 无权限 → 不猜
    const [text, color] = !colOk
      ? [t("admin.inspxacct.headBlocking"), "var(--red)"]
      : !monOk
        ? [t("admin.inspxacct.headDegraded"), "var(--amber)"]
        : [t("admin.inspxacct.headReady"), "var(--green)"];
    return (
      <span style={{
        marginLeft: 8, fontSize: 11, fontWeight: 700, padding: "1px 8px",
        borderRadius: 100, color, border: `1px solid ${color}`,
        whiteSpace: "nowrap",
      }}>{text}</span>
    );
  })();

  /**
   * 🔴 **阻塞级问题自动展开一次。**
   *
   * 徽章能让人看见「有问题」，但客户仍然要点一下才知道怎么办 —— 而①缺失
   * 意味着这个账号一条结论都产不出来，那个代价大到不该多一次点击。
   *
   * ⚠️ 只自动展开**一次**（`autoOpened`）。每次 data 刷新都强制展开会把
   *    客户手动折叠的动作覆盖掉 —— 那种「关不掉」的界面比藏起来更烦。
   * ⚠️ 只对①（红）自动展开，②（琥珀）不展开：后者是降级不是阻塞，
   *    自动展开每一个降级项会让账号列表整页铺开。
   */


  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
      {/* ⚠️ 在**点击**里触发加载，不用 `useEffect(() => {...}, [open])`。
          后者会在 effect 内同步 setState（`load()` 第一行就是 setLoading）——
          React 19 的 `react-hooks/set-state-in-effect` 直接报错，
          而且那会多一次级联渲染。点开才加载语义上也更对。 */}
      <button onClick={() => {
        const next = !open;
        setOpen(next);
        // 🔴 **每次展开都重新拉**，不是 `!data` 才拉。
        //    第②步（把账号加进巡检 space 的 secondary accounts）是在
        //    **AWS 控制台**里做的 —— 做完回到这个页面，状态灯必须能更新。
        //    原来只在 `data` 为空时拉，于是第二次展开读的还是旧结果，
        //    客户会以为「加了没生效」。
        if (next) void load();
      }}
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          color: "var(--text)", fontSize: 12.5, fontWeight: 600, padding: 0,
        }}>
        {open ? "▾" : "▸"} {t("admin.inspxacct.title")}
        {/* 🔴 状态必须出现在**折叠状态下也看得见**的地方。
            没有它，「①缺失（巡检会失败）」与「全部就绪」长得一模一样，
            而前者意味着这个账号一条结论都产不出来。 */}
        {headBadge}
      </button>
      {open && (
        <div style={{ marginTop: 8, display: "grid", gap: 8, fontSize: 12.5 }}>
          {loading && <div style={{ color: "var(--muted)" }}>…</div>}

          {data && (
            <>
              {/* ── 两行状态，一眼看完 ──
                  🔴 原来是两张大卡，每张 4 行说明文字 + 按钮。客户展开看到的是
                     一屏文字，而他要的答案只有两个字：能采吗、判读全吗。
                     说明搬进下面那个「这两件事分别是什么」折叠层。 */}
              {/* 🔴 三态，不是两态。`registered` 只表示**登记过**（BFF 自己的注释
                  写着「不代表 assume 通得过」），而 `mismatch`（登记的与模板会建
                  的不一致）是第三个状态 —— 前端注释自己说那「两种都会让 assume
                  永远失败」。

                  原来颜色与文案只看 `registered` 一个布尔，于是同一张卡上会
                  出现两个相反的结论：绿框 + 绿字「已完成」，下面一行琥珀字
                  「登记的与预期不一致 arn:…」。绿灯会让客户停止排查，而每一轮
                  巡检都在后台 assume 失败。

                  ②那一步把 invalid / pending / null 三态都分开了，①没有。 */}
              <StepRow
                n="①"
                label={t("admin.inspxacct.step1")}
                where={`${t("admin.inspxacct.inTarget")} ${accountId}`}
                whereColor="var(--blue)"
                ok={Boolean(col?.registered) && !col?.mismatch}
                statusText={!col ? t("admin.inspxacct.unknown")
                  : col.mismatch ? t("admin.inspxacct.mismatchShort")
                    : col.registered ? t("admin.inspxacct.done")
                      : t("admin.inspxacct.missingRequired")}
                statusColor={!col ? "var(--muted)"
                  : col.mismatch ? "var(--amber)"
                    : col.registered ? "var(--green)" : "var(--red)"}
                action={(
                  <button style={{ ...btnGhost, fontSize: 11, padding: "2px 9px" }}
                    disabled={verifying} onClick={() => void verify()}>
                    {t("admin.inspxacct.verifyBtn")}{verifying ? " …" : ""}
                  </button>
                )}
              />
              <StepRow
                n="②"
                label={t("admin.inspxacct.step2")}
                where={`${t("admin.inspxacct.inSystem")} ${data?.systemAccountId || "—"}`}
                whereColor="var(--orange)"
                ok={monOk}
                statusText={monOk ? t("admin.inspxacct.done")
                  : mon?.status === "invalid" ? "invalid"
                    : mon?.status === "pending-confirmation" ? "pending"
                      : mon?.linked === false ? t("admin.inspxacct.missingOptional")
                        /* null = 查不到，**不等于**没关联 */
                        : t("admin.inspxacct.unknown")}
                statusColor={monOk ? "var(--green)" : "var(--amber)"}
                action={(
                  <>
                    <button style={{ ...btnGhost, fontSize: 11, padding: "2px 9px" }}
                      disabled={loading} onClick={() => void load()}>
                      {t("admin.inspxacct.recheckBtn")}{loading ? " …" : ""}
                    </button>
                    {/* ⚠️ 已关联时也不禁用 —— 后端把「已存在」当成功，重复点安全，
                        而且会顺带 validate 一次把 invalid 翻出来。 */}
                    <button style={{ ...btnPrimary, fontSize: 11, padding: "3px 11px" }}
                      title={t("admin.inspxacct.assocTip")}
                      disabled={assoc || !sp?.id} onClick={() => void link()}>
                      {t("admin.inspxacct.assocBtn")}{assoc ? " …" : ""}
                    </button>
                  </>
                )}
              />

              {/* ── ①缺失时的**唯一**下一步 ──
                  🔴 这里不给「生成部署链接」当主动作。采集角色现在合并进了
                     接入用的那个模板，所以缺它意味着**那个栈是旧模板部署的**，
                     正确动作是 update 已有栈 —— 而 Launch Stack URL 是
                     `#/stacks/create/review`，用它会去建**第二个**栈，然后
                     撞 AlreadyExists 或者建出一堆重复角色。
                  ⚠️ 我们拿不到成员账号里那个栈的 stackId（跨账号），所以给不了
                     update 深链。给模板 URL + 三步指令是能给的最精确的东西。 */}
              {!col?.registered && (
                <div style={{
                  border: "1px solid var(--line)", borderRadius: 8,
                  padding: "9px 11px", borderLeft: "3px solid var(--orange)",
                  lineHeight: 1.7, color: "var(--muted)",
                  whiteSpace: "pre-line",
                }}>
                  {t("admin.inspxacct.updateStackHint")
                    .replace("{stack}", `notiops-devops-agent-${accountId}`)
                    .replace("{account}", accountId)}
                  <div style={{ display: "flex", gap: 8, marginTop: 7,
                    alignItems: "center", flexWrap: "wrap" }}>
                    <button style={btnGhost} disabled={gen} onClick={genStack}>
                      {t("admin.inspxacct.tmplBtn")}{gen ? " …" : ""}
                    </button>
                    {stackUrl && (
                      <>
                        <button style={{ ...btnPrimary, fontSize: 11, padding: "3px 11px" }}
                          onClick={() => void copy(stackUrl, "Template URL")}>
                          {t("admin.inspxacct.copyBtn")}
                        </button>
                        <code style={{ fontSize: 10.5, color: "var(--muted)",
                          maxWidth: 320, overflow: "hidden",
                          textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {stackUrl}
                        </code>
                      </>
                    )}
                  </div>
                </div>
              )}

              {!sp?.id && (
                <div style={{ color: "var(--red)" }}>
                  {t("admin.inspxacct.noSpace")}
                </div>
              )}

              {/* ── 长说明收进这里 ── */}
              <button onClick={() => setWhy((v) => !v)} style={{
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--muted)", fontSize: 11.5, padding: 0,
                textAlign: "left",
              }}>
                {why ? "▾" : "▸"} {t("admin.inspxacct.whyToggle")}
              </button>
              {why && (
                <div style={{
                  color: "var(--muted)", lineHeight: 1.7, whiteSpace: "pre-line",
                  borderLeft: "2px solid var(--line)", paddingLeft: 10,
                }}>
                  {t("admin.inspxacct.step1Hint")}
                  {"\n\n"}
                  {t("admin.inspxacct.step2Hint")}
                  {"\n\n"}
                  {t("admin.inspxacct.spaceLabel")}: {sp?.name || "—"}
                  {sp?.id ? `  ${sp.id}` : ""}
                  {"\n"}
                  {t("admin.inspxacct.step1")}: {col?.expectedRoleArn || "—"}
                  {"\n"}
                  {t("admin.inspxacct.step2")}: {mon?.expectedRoleArn || "—"}
                  {col?.mismatch && (
                    <div style={{ color: "var(--amber)", marginTop: 6 }}>
                      {t("admin.inspxacct.mismatch")} {col.roleArn}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {msg && <div style={msg.ok ? okText : errText}>{msg.text}</div>}
        </div>
      )}
    </div>
  );
}

/* ───────────────── 生命周期 / EOL 覆盖 ───────────────── */

function LifecycleView() {
  const t = useT();
  const [overrides, setOverrides] = useState<EolMap>({});
  const [table, setTable] = useState<EolMap & { asOf?: string }>({});
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [nsvc, setNsvc] = useState("");
  const [nver, setNver] = useState("");
  const [ndate, setNdate] = useState("");

  const reload = () => fetchEol().then((r) => { setOverrides(r.overrides || {}); setTable(r.table || {}); }).catch((e) => setErr(String(e?.message || e)));
  useEffect(() => { reload(); }, []);

  const META = new Set(["asOf", "sources", "_note"]);
  const services = Array.from(new Set([...Object.keys(table).filter((k) => !META.has(k)), ...Object.keys(overrides)])).sort();

  const setDate = (svc: string, ver: string, d: string) =>
    setOverrides((prev) => ({ ...prev, [svc]: { ...(prev[svc] || {}), [ver]: d } }));
  const removeOverride = (svc: string, ver: string) =>
    setOverrides((prev) => { const s = { ...(prev[svc] || {}) }; delete s[ver]; const n = { ...prev, [svc]: s }; if (!Object.keys(s).length) delete n[svc]; return n; });
  const addRow = () => {
    const s = nsvc.trim().toLowerCase(), v = nver.trim();
    if (!s || !v || !/^\d{4}-\d{2}-\d{2}$/.test(ndate)) return;
    setDate(s, v, ndate); setNsvc(""); setNver(""); setNdate("");
  };
  const save = async () => {
    setErr(""); setMsg("");
    try { await putEol(overrides); setMsg(t("admin.eol.saved")); await reload(); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
  };

  return (
    <div>
      <SectionHead title={t("admin.tab.lifecycle")} sub={t("admin.eol.hint")} />
      {table.asOf && <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>{t("admin.eol.tableAsOf")} {table.asOf}</div>}
      {err && <div style={{ ...errText, marginBottom: 12 }}>{err}</div>}

      {services.length === 0 && <div style={{ ...box, padding: "20px", color: "var(--muted)", fontSize: 13, textAlign: "center" }}>{t("admin.eol.empty")}</div>}
      {services.map((svc) => {
        const def = table[svc] || {};
        const ov = overrides[svc] || {};
        const versions = Array.from(new Set([...Object.keys(def), ...Object.keys(ov)])).sort();
        return (
          <div key={svc} style={{ ...box, padding: "12px 14px", marginBottom: 10 }}>
            <FieldLabel>{svc}</FieldLabel>
            {versions.map((ver) => {
              const overridden = ov[ver] != null;
              return (
                <div key={ver} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", flexWrap: "wrap" }}>
                  <code style={{ fontSize: 12, minWidth: 170, color: "var(--text)" }}>{ver}</code>
                  <input type="date" value={ov[ver] ?? ""} onChange={(e) => setDate(svc, ver, e.target.value)} style={{ ...inputStyle, width: 180 }} />
                  {overridden
                    ? <span style={{ fontSize: 11, fontWeight: 600, color: "var(--orange)" }}>{t("admin.eol.overridden")}</span>
                    : (def[ver] && <span style={{ fontSize: 11, color: "var(--muted)" }}>{t("admin.eol.default")}: {def[ver]}</span>)}
                  {overridden && <button style={iconBtn} title={t("admin.eol.remove")} onClick={() => removeOverride(svc, ver)}>✕</button>}
                </div>
              );
            })}
          </div>
        );
      })}

      <div style={{ ...box, padding: "12px 14px", marginBottom: 12 }}>
        <FieldLabel>{t("admin.eol.add")}</FieldLabel>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input value={nsvc} onChange={(e) => setNsvc(e.target.value)} placeholder={t("admin.eol.newService")} style={{ ...inputStyle, width: 220 }} />
          <input value={nver} onChange={(e) => setNver(e.target.value)} placeholder={t("admin.eol.version")} style={{ ...inputStyle, width: 180 }} />
          <input type="date" value={ndate} onChange={(e) => setNdate(e.target.value)} style={{ ...inputStyle, width: 180 }} />
          <button style={btnGhost} onClick={addRow}>{t("admin.eol.add")}</button>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button style={btnPrimary} onClick={save}>{t("admin.eol.save")}</button>
        {msg && <span style={okText}>{msg}</span>}
      </div>
    </div>
  );
}
