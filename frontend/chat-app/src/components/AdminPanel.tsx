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

  const load = () => {
    setLoading(true);
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
  useEffect(load, []);

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
                // 此处原写「IM bot 尚未接线（task 4.5 待做）」+「GPT 系不受 Key 影响（R5.7）」，
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
