/**
 * Admin 管理面板：角色 / 用户 / 组映射 / 模块 四视图。
 * 权限树从后端全量能力清单（GET /admin/capabilities）动态生成——新增 dashboard
 * 只需在 config/capabilities.json 加节点，此处自动出现（需求 4.6）。
 *
 * 视觉：统一使用全站设计 token（--card/--line/--text/--muted/--orange/--blue/--green/--page），
 * 与 FinOps 等 tab 一致（此前用未定义的 --border/--danger/--ok/--accent → 吃死色 hex、不跟随主题）。
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useT, useLocale } from "../i18n";
import { loadConfig } from "../config";
import {
  fetchAllCapabilities, fetchRoles, saveRole, deleteRole,
  fetchUsers, putUser, createUser, deleteUser, fetchModules, putModules,
  fetchGroups, putGroupMap, createGroup, deleteGroup, fetchGroupMembers, addUserToGroup, removeUserFromGroup,
  fetchEol, putEol,
  fetchMemberAccounts, onboardMemberAccount, memberOnboardStatus, setMemberAccountEnabled, offboardMemberAccount,
  associateDevopsAgent, devopsAgentAssocStatus,
  fetchAccountAccess, putAccountAccess, deleteAccountAccess,
  fetchNotificationConfig, putNotificationConfig, testNotificationSend,
  generateLaunchStack, saveManualPayload, testDaConnection,
  type FullCapabilityNode, type RoleRec, type UserRec, type ModuleToggle, type GroupRec, type EolMap,
  type MemberAccountRec, type AccountVisibilityRec,
} from "../api/admin";

type Tab = "roles" | "users" | "groups" | "modules" | "accounts" | "lifecycle" | "notifications";
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
        {(["roles", "users", "groups", "modules", "accounts", "lifecycle", "notifications"] as Tab[]).map((k) => (
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
    </div>
  );
}

/* ───────────────── 通知（飞书机器人配置）─────────────────
 * 自 web-chat 原生实现（存 Secrets Manager notiops/im-bot-feishu），与老管理前端
 * (frontend-app /settings/notifications) 完全解耦 —— 老页面 sunset 时此板块不受影响。
 * 敏感字段(app_secret)后端脱敏为 ****后4位；保存时回传脱敏值 = 不修改。 */
function NotificationsView() {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [chatIds, setChatIds] = useState<string[]>([""]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => {
    setLoading(true);
    fetchNotificationConfig()
      .then((r) => {
        setAppId(r.feishu.app_id || "");
        setAppSecret(r.feishu.app_secret || "");
        const ids = (r.feishu.notify_chat_ids || "").split(",").map((s) => s.trim()).filter(Boolean);
        setChatIds(ids.length ? ids : [""]);
      })
      .catch((e) => setMsg({ ok: false, text: String(e?.message || e) }))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const r = await putNotificationConfig({
        app_id: appId.trim(),
        app_secret: appSecret,
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
      <SectionHead title={t("admin.notif.title")} sub={t("admin.notif.sub")} />
      {loading ? <div style={{ color: "var(--muted)", fontSize: 13 }}>{t("admin.notif.loading")}</div> : (
        <div style={{ ...box, padding: 18, maxWidth: 640, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <FieldLabel>App ID</FieldLabel>
            <input style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }} value={appId}
              onChange={(e) => setAppId(e.target.value)} placeholder="cli_xxxx" />
          </div>
          <div>
            <FieldLabel>App Secret</FieldLabel>
            <input type="password" style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }} value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)} placeholder={t("admin.notif.secretPh")} />
            <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 4 }}>{t("admin.notif.secretHint")}</div>
          </div>
          <div>
            <FieldLabel>{t("admin.notif.chatIds")}</FieldLabel>
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
    setPerms((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
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
  const toggleSel = (sub: string) => setSelected((prev) => { const n = new Set(prev); n.has(sub) ? n.delete(sub) : n.add(sub); return n; });
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

function AccountsView() {
  const t = useT();
  // ── 接入 ──
  const [accounts, setAccounts] = useState<MemberAccountRec[]>([]);
  const [orgDisabled, setOrgDisabled] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<MemberAccountRec | null>(null);
  const [regionsInput, setRegionsInput] = useState("us-east-1");
  const [submitting, setSubmitting] = useState(false);
  const [polling, setPolling] = useState<Record<string, string>>({}); // opId -> accountId
  const [consoleUrl, setConsoleUrl] = useState("");
  useEffect(() => { loadConfig().then((c) => setConsoleUrl(c.idleConsoleUrl || "")).catch(() => {}); }, []);
  const [daPolling, setDaPolling] = useState<Record<string, string>>({}); // opId -> accountId
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
  }, [daPolling]);

  const reload = () => {
    setErr("");
    return fetchMemberAccounts()
      .then((items) => { setAccounts(items); setOrgDisabled(false); })
      .catch((e) => {
        const m = String((e as Error)?.message || e);
        if (m === "org_mode_disabled") setOrgDisabled(true); else setErr(m);
      })
      .finally(() => setLoading(false));
  };
  useEffect(() => { reload(); }, []);

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
  }, [polling]);

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

  if (orgDisabled) {
    return (
      <div>
        <SectionHead title={t("admin.accounts.onboardTitle")} />
        <div style={{ ...box, padding: 16, fontSize: 13, color: "var(--muted)", lineHeight: 1.7 }}>{t("admin.accounts.orgDisabled")}</div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 24 }}>
      {err && <div style={errText}>{err}</div>}

      {/* 成员账号接入 */}
      <div>
        <SectionHead title={t("admin.accounts.onboardTitle")} sub={t("admin.accounts.onboardDesc")} />
        <div style={{ ...box, padding: "4px 14px" }}>
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 0" }}>
            <button onClick={reload} disabled={loading} style={{ fontSize: 12, padding: "4px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", cursor: "pointer" }}>{t("admin.accounts.refresh")}</button>
          </div>
          {accounts.length === 0 && !loading && <div style={{ padding: "16px 0", color: "var(--muted)", fontSize: 13 }}>{t("admin.accounts.empty")}</div>}
          {accounts.map((a, i) => (
            <div key={a.accountId} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderTop: i === 0 ? "none" : "1px solid var(--line)" }}>
              <div style={{ minWidth: 220 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--text)" }}>{a.name || a.accountId}</div>
                <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{a.accountId}{a.email ? ` · ${a.email}` : ""}</div>
                <div style={{ marginTop: 3 }}>{daBadge(a)}</div>
              </div>
              <div>{statusBadge(a)}</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", flex: 1 }}>{(a.regions || []).join(", ")}</div>
              {a.orgOnboardStatus !== "PROVISIONING" && a.orgOnboardStatus !== "OFFBOARDING" && !(a.onboarded && a.enabled) && (
                <button onClick={() => { setTarget(a); setRegionsInput(a.regions?.join(",") || "us-east-1"); }}
                  style={{ fontSize: 12.5, fontWeight: 600, padding: "5px 14px", borderRadius: 8, border: "1px solid var(--orange)", background: "rgba(255,153,0,.10)", color: "var(--text)", cursor: "pointer" }}>
                  {a.orgOnboardStatus === "FAILED" ? t("admin.accounts.retryBtn") : t("admin.accounts.onboardBtn")}
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
                  const typed = window.prompt(`${t("admin.accounts.offboardConfirm")}\n${a.accountId}`);
                  if (typed !== a.accountId) return;
                  try {
                    const r = await offboardMemberAccount(a.accountId);
                    if (r.operationId) setPolling((prev) => ({ ...prev, [r.operationId]: a.accountId }));
                    await reload();
                  } catch (e) { setErr(String((e as Error)?.message || e)); }
                }}
                  style={{ fontSize: 12, padding: "5px 12px", borderRadius: 8, border: "1px solid #d13212", background: "transparent", color: "#d13212", cursor: "pointer" }}>
                  {t("admin.accounts.offboardBtn")}
                </button>
              )}
            </div>
          ))}
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
      <CrossPayerSection onDone={reload} />
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
      await saveManualPayload(acctId.trim(), { agent_space_id: spaceId.trim(), trigger_role_arn: roleArn.trim() });
      setMsg({ ok: true, text: t("admin.xpayer.saved") });
      onDone();
    } catch (e) { setMsg({ ok: false, text: String((e as Error)?.message || e) }); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true); setMsg(null);
    try {
      const r = await testDaConnection(acctId.trim());
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
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button style={btnPrimary} disabled={saving || !spaceId.trim() || !roleArn.trim()} onClick={save}>
                  {saving ? "..." : t("admin.xpayer.saveBtn")}
                </button>
                <button style={btnGhost} disabled={testing || !acctId.trim()} onClick={test}>
                  {testing ? "..." : t("admin.xpayer.testBtn")}
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
