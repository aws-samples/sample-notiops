import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentUser, signOut, fetchAuthSession } from "aws-amplify/auth";
import Sidebar from "../components/Sidebar";
import Message from "../components/Message";
import Composer from "../components/Composer";
import SourcesPanel from "../components/SourcesPanel";
import ThinkingPanel from "../components/ThinkingPanel";
import { appendStep, appendReasoning, type TimelineStep } from "../thinking";
import CustomizePanel from "../components/CustomizePanel";
import NotificationsPanel from "../components/NotificationsPanel";
import AdminPanel from "../components/AdminPanel";
import { getMyCapabilities } from "../api/capabilities";
import FinopsDashboardBrowser from "../components/FinopsDashboardBrowser";
import { getFinopsDashboard, type FinopsDashboard as FinopsData } from "../api/finops";
import CasesDashboardBrowser from "../components/CasesDashboardBrowser";
import { getCasesDashboard, type CasesDashboardData } from "../api/cases";
import SecurityDashboardBrowser from "../components/SecurityDashboardBrowser";
import { getSecurityDashboard, type SecurityDashboardData } from "../api/security";
import InvestigationDashboardBrowser from "../components/InvestigationDashboardBrowser";
import InspectionDashboardBrowser from "../components/InspectionDashboardBrowser";
import { getAlarmDashboard, type AlarmDashboardData } from "../api/alarms";
import ErrorBoundary from "../components/ErrorBoundary";
import ChatObjectPicker from "../components/ChatObjectPicker";
import Logo from "../components/Logo";
import { unreadCount } from "../api/notifications";
import { streamChat, warmupChat, listConversations, getMessages, deleteConversationApi, renameConversationApi, setPinnedApi, executeActionApi, getAccountsFull, type SourceItem, type AccountInfo } from "../api/chat";
import { useLocale, useT } from "../i18n";
import { topicDef, deepDiveTogglesFor, normalizeTopic, type ChatMessage, type Conversation, type TopicKey } from "../types";
import { loadConvMode, saveConvMode, forgetConvMode, modeOf, fieldsOf, restorableMode } from "../convMode";
import { defaultModelId, modelDisplayName, refreshModelCatalog, isSelectableModel, useModelCatalog } from "../models";
import { IconInvestigate, IconFinOps, IconCases, IconSecurity, IconWhatsNew, IconReports, IconDatabase, IconGauge, IconPercent, IconCluster, IconCloud, IconInspection, IconChip, IconHeartPulse, IconFileText } from "../components/icons";

// 通用对话主页（Codex 式空态）的启动卡片池：每次进入随机抽 4 个。
// 每张卡片只有一句话描述（descKey，直接作为填入 prompt），点击=填入输入框、停留在通用对话、不切主题。
const HOME_CARD_POOL: { key: string; Icon: React.FC<{ size?: number }>; descKey: string }[] = [
  { key: "inspect",   Icon: IconReports,     descKey: "home.card.inspect.desc" },
  { key: "alarm",     Icon: IconInvestigate, descKey: "home.card.alarm.desc" },
  { key: "cost",      Icon: IconFinOps,      descKey: "home.card.cost.desc" },
  { key: "security",  Icon: IconSecurity,    descKey: "home.card.security.desc" },
  { key: "rds",       Icon: IconDatabase,    descKey: "home.card.rds.desc" },
  { key: "cases",     Icon: IconCases,       descKey: "home.card.cases.desc" },
  { key: "quota",     Icon: IconGauge,       descKey: "home.card.quota.desc" },
  { key: "savings",   Icon: IconPercent,     descKey: "home.card.savings.desc" },
  { key: "whatsnew",  Icon: IconWhatsNew,    descKey: "home.card.whatsnew.desc" },
  { key: "publics3",  Icon: IconSecurity,    descKey: "home.card.publics3.desc" },
  { key: "untagged",  Icon: IconFinOps,      descKey: "home.card.untagged.desc" },
  { key: "arch",      Icon: IconCluster,     descKey: "home.card.arch.desc" },
];

// 选中「DevOps Agent」这个对话对象时的启动卡片（固定 4 张，不随机 —— 这条路径的能力面
// 比 NotiOps 窄得多，池子里没有更多同等质量的引导）。**不能复用上面那 4 张**：成本分析 /
// Support 案例 / Skills / What's New 都不是这条路径做的事，拿它们引导等于把客户带到一个
// 答不了的问题上。
const DEVOPS_HOME_CARDS: { key: string; Icon: React.FC<{ size?: number }>; descKey: string }[] = [
  { key: "dv-anomaly", Icon: IconInvestigate, descKey: "obj.dv.card.anomaly" },
  { key: "dv-ec2",     Icon: IconInvestigate, descKey: "obj.dv.card.ec2" },
  { key: "dv-rds",     Icon: IconDatabase,    descKey: "obj.dv.card.rds" },
  { key: "dv-change",  Icon: IconReports,     descKey: "obj.dv.card.change" },
];

// 选中「阿里云 STAROps」这个对话对象时的启动卡片（同上，固定 4 张）。**同样不能复用**上面
// 任何一组：那两组问的都是 AWS 资源（EC2 / RDS / CloudWatch），拿它们引导等于让客户去问
// STAROps 一个它根本看不到的环境 —— 答案必然是空的，而客户会以为是产品坏了。
// 第一张刻意是「发起巡检」：STAROps 不另设「深度调查」开关，发起调查就是一句自然语言的事
// （这正是 STAROps 控制台里的做法），第一张卡就得把这个用法示范出来。
const STAROPS_HOME_CARDS: { key: string; Icon: React.FC<{ size?: number }>; descKey: string }[] = [
  { key: "so-inspect", Icon: IconInspection,  descKey: "obj.so.card.inspect" },
  { key: "so-ecs",     Icon: IconChip,        descKey: "obj.so.card.ecs" },
  { key: "so-alarm",   Icon: IconHeartPulse,  descKey: "obj.so.card.alarm" },
  { key: "so-log",     Icon: IconFileText,    descKey: "obj.so.card.log" },
];

// 主题空态主页（与通用主页同一套视觉：脉冲 N logo + 主题标题 + 每主题独立 prompt 池随机 4 卡）。
// prompt 池复用 Composer 的 chip.* i18n key（既是显示文案也是填入内容），保证与聊天内推荐一致。
const TOPIC_LANDING: Record<string, { headlineKey: string; pool: { key: string; Icon: React.FC<{ size?: number }>; promptKey: string }[] }> = {
  finops: { headlineKey: "home.h.finops", pool: [
    { key: "anomaly",  Icon: IconFinOps,  promptKey: "chip.fin.anomaly" },
    { key: "topcost",  Icon: IconFinOps,  promptKey: "chip.fin.topcost" },
    { key: "savings",  Icon: IconPercent, promptKey: "chip.fin.savings" },
    { key: "trend",    Icon: IconReports, promptKey: "chip.fin.trend" },
    { key: "ri",       Icon: IconGauge,   promptKey: "chip.fin.ri" },
    { key: "untagged", Icon: IconFinOps,  promptKey: "chip.fin.untagged" },
  ] },
  cases: { headlineKey: "home.h.cases", pool: [
    { key: "open",       Icon: IconCases,       promptKey: "chip.cases.open" },
    { key: "analyze",    Icon: IconInvestigate, promptKey: "chip.cases.analyze" },
    { key: "bySeverity", Icon: IconReports,     promptKey: "chip.cases.bySeverity" },
    { key: "draft",      Icon: IconCases,       promptKey: "chip.cases.draft" },
    { key: "recent",     Icon: IconInvestigate, promptKey: "chip.cases.recent" },
    { key: "summary",    Icon: IconReports,     promptKey: "chip.cases.summary" },
    { key: "create",     Icon: IconCases,       promptKey: "chip.cases.create" },
  ] },
  // 调查池 = 原调查 6 条 + 原安全 6 条（2026-09-11「安全」不再是聊天主题，并入「调查」）。
  // 与 Composer 的 CHIP_POOL.investigate 必须**同步维护** —— 两处各存一份是既有结构
  // （这里给主题主页的 4 张卡，那里给对话内的 3 个 chip），改一处不改另一处会漂。
  investigate: { headlineKey: "home.h.investigate", pool: [
    { key: "resource",     Icon: IconInvestigate, promptKey: "chip.inv.resource" },
    { key: "ec2reboot",    Icon: IconInvestigate, promptKey: "chip.inv.ec2reboot" },
    { key: "logs",         Icon: IconReports,     promptKey: "chip.inv.logs" },
    { key: "connectivity", Icon: IconInvestigate, promptKey: "chip.inv.connectivity" },
    { key: "cwalarms",     Icon: IconReports,     promptKey: "chip.inv.cwalarms" },
    { key: "rootcause",    Icon: IconInvestigate, promptKey: "chip.inv.rootcause" },
    { key: "findings",     Icon: IconSecurity, promptKey: "chip.sec.findings" },
    { key: "publics3",     Icon: IconSecurity, promptKey: "chip.sec.publics3" },
    { key: "opensg",       Icon: IconSecurity, promptKey: "chip.sec.opensg" },
    { key: "iamreview",    Icon: IconSecurity, promptKey: "chip.sec.iamreview" },
    { key: "mfa",          Icon: IconSecurity, promptKey: "chip.sec.mfa" },
    { key: "bestpractice", Icon: IconReports,  promptKey: "chip.sec.bestpractice" },
  ] },
  "whats-new": { headlineKey: "home.h.whatsnew", pool: [
    { key: "recent",  Icon: IconWhatsNew, promptKey: "chip.wn.recent" },
    { key: "mine",    Icon: IconWhatsNew, promptKey: "chip.wn.mine" },
    { key: "digest",  Icon: IconReports,  promptKey: "chip.wn.digest" },
    { key: "service", Icon: IconInvestigate, promptKey: "chip.wn.service" },
    { key: "ai",      Icon: IconWhatsNew, promptKey: "chip.wn.ai" },
    { key: "trends",  Icon: IconReports,  promptKey: "chip.wn.trends" },
  ] },
};

// 顶栏主题 tag 图标（与侧边栏一致）。
// 只列 TOPICS 里真实存在的主题：这是 Record<string,…>，写一个已退役的 key（如 security）
// 不会有编译错误，会一直留着骗人 —— 而它的唯一读取处先过 `topicDef()`，那里已经查不到了。
const TOPBAR_TOPIC_ICON: Record<string, React.FC<{ size?: number }>> = {
  investigate: IconInvestigate, finops: IconFinOps, cases: IconCases,
  "whats-new": IconWhatsNew,
};

const ExpandIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="4" width="18" height="16" rx="2.5" /><line x1="9" y1="4" x2="9" y2="20" />
  </svg>
);

// 主区视图 key。抽成命名类型，是为了让「记住从哪个视图进的看板」那个 state
// （dashReturn）能复用同一个联合，而不是把这一长串再抄一遍。
type ViewKey = "chat" | "skills" | "customize" | "notifications" | "finops" | "cases" | "admin" | "security" | "investigate" | "inspection";

let idSeq = 0;
const newId = (p: string) => `${p}-${Date.now()}-${idSeq++}`;

// 空对话居中态的问候语（按主题区分）
function greeting(topic: TopicKey | undefined, locale: string): string {
  const en = locale === "en";
  switch (topic) {
    case "cases": return en ? "How can I help with your support cases?" : "需要我帮你处理哪个 Support case？";
    case "finops": return en ? "Let's optimize your cloud costs." : "一起来优化你的云成本吧。";
    // 调查主题现在也承接安全提问（「安全」主题已并入），所以问候语不再只说"资源"。
    case "investigate": return en ? "What should we look into — a resource, an alarm, a security finding?" : "想查什么？资源、告警，还是安全风险？";
    case "whats-new": return en ? "What's new at AWS — and what matters to you." : "看看 AWS 有什么新发布，以及哪些对你有用。";
    default: return en ? "What's on your mind today?" : "今天想聊点什么？";
  }
}

// 相对时间（空态会话列表）。
function fmtAgo(ts: number, locale: string): string {
  const en = locale === "en";
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return en ? `${d}d ago` : `${d} 天前`;
  if (h >= 1) return en ? `${h}h ago` : `${h} 小时前`;
  if (m >= 1) return en ? `${m}m ago` : `${m} 分钟前`;
  return en ? "just now" : "刚刚";
}

function emptyConversation(locale: string, topic: TopicKey = "general"): Conversation {
  return {
    id: newId("conv"),
    title: locale === "en" ? "New chat" : "新对话",
    topic,
    model: defaultModelId(), // 新对话用管理员设的默认模型（GET /models 下发；读不到时走内置兜底）
    messages: [],
    updatedAt: Date.now(),
    // DevOps Agent 深度调查开关：所有主题**默认关闭**，由用户按需手动打开
    // （深度调查耗时/耗算力，不宜默认强制走；investigate/finops 主题会显示该开关 ——
    //  口径是 types.ts 的 topicHasDevopsAgent「默认给、按例外排除」，不是这里写死的清单）。
  };
}

export default function ChatApp({ onSignOut }: { onSignOut: () => void }) {
  const { locale } = useLocale();
  const t = useT();
  const [conversations, setConversations] = useState<Conversation[]>([emptyConversation(locale)]);
  const [activeId, setActiveId] = useState<string>(conversations[0].id);
  // 主区视图：chat（默认）| skills（独立 Skills 页）| customize（定制页：连接器/插件）
  // | notifications（通知收件箱）。非对话页切到它时主区换渲染。
  // ⚠️ 这是**视图**联合，与 TopicKey 是两回事。"security" 仍然是一个合法视图（安全看板还在），
  //    但它已经不再是一个聊天主题（见 types.ts 的 TopicKey）—— 别把两者混起来。
  const [view, setView] = useState<ViewKey>("chat");
  // 从「仪表盘」胶囊进看板时记下"从哪来"，看板左上角的返回按钮据此回去（回对话 / 回主题主页）。
  // null = 不是从胶囊进来的（走侧栏进的），那就不显示返回按钮 —— 与 view==="inspection"
  // 这种本来就没有主页的看板一致。
  //
  // 刻意**不用** `switchTo()` 回去：那个函数无条件 setView("chat")（回不到主题主页），
  // 而且如果离开的那条会话是空的又没落库，它会把会话**删掉** —— 从对话里点开看板再返回，
  // 会发现刚开的新对话没了。
  const [dashReturn, setDashReturn] = useState<ViewKey | null>(null);
  // 「Skills」一级入口点击信号：每次点都自增。已在 skills 视图内（可能停在某个 skill 详情/编辑器）
  // 时，CustomizePanel 据此重置回列表首页——无修改直接回、有未保存修改先确认。见 skillsHome 透传。
  const [skillsHome, setSkillsHome] = useState(0);
  // 当前用户可见能力 key 集合（GET /me/capabilities）；据此门禁 tab 入口。
  // 初始全允许（undefined 视为"未加载"）→ 加载后收敛；加载失败保守隐藏受控入口。
  const [capKeys, setCapKeys] = useState<string[] | null>(null);
  // capsError: /me/capabilities 加载失败或返回空（异常）→ fail-open，避免所有人被误锁（后端仍 403 强制）。
  const [capsError, setCapsError] = useState(false);
  // isAdmin: 直接从 idToken 的 cognito:groups 判断，作为最强兜底 —— admin 永远不会被前端门禁锁死，
  // 即便 /me/capabilities 异常或 token group claim 传播延迟（与后端 admin-group 兜底同源）。
  const [isAdmin, setIsAdmin] = useState(false);
  const can = (key: string) => isAdmin || (capKeys || []).includes(key);
  // hasCapNode: 服务端能力树里**确实下发了**这个节点。与 can() 的区别是不 fail-open
  // （admin 也不例外）—— 用于「可选外部数据源」类能力：服务端在数据源未配置时会把节点
  // 整个摘掉（authz.mjs 的 requiresEnv），此时任何人都不该看到入口，否则就是一个点进去
  // 只会显示"数据源未配置"的死 tab。权限不足与数据源缺失在这里被合成同一个信号：不可用。
  const hasCapNode = (key: string) => (capKeys || []).includes(key);
  // 加载完成 = 拿到非空能力集 且 无错误；否则视为"未就绪"→ 门禁 fail-open（默认显示，后端把关）。
  const capsLoaded = capKeys !== null && !capsError;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 关键：强制用 refresh token 换发新 idToken —— 拿到最新 cognito:groups。
      // 这样管理员改了某人的组/角色后，该用户下次打开/刷新页面即生效，无需手动退出重登。
      let groups: string[] = [];
      try {
        const s = await fetchAuthSession({ forceRefresh: true });
        const g = s.tokens?.idToken?.payload?.["cognito:groups"];
        groups = Array.isArray(g) ? (g as string[]) : [];
      } catch { /* 刷新失败 → 用现有会话 */ }
      if (cancelled) return;
      setIsAdmin(groups.includes("admin"));
      // 用刷新后的 token 拉能力（getMyCapabilities → signedClient 复用已刷新的会话）
      try {
        const nodes = await getMyCapabilities();
        if (cancelled) return;
        if (!nodes || nodes.length === 0) { setCapsError(true); setCapKeys([]); } // 空=后端异常 → fail-open
        else { setCapsError(false); setCapKeys(nodes.map((n) => n.key)); }
      } catch {
        if (!cancelled) { setCapsError(true); setCapKeys([]); }
      }
    })();
    return () => { cancelled = true; };
  }, []);
  // 能力加载后：若当前停在无权访问的 tab，回退到 chat（防止直链/降权后停留）
  useEffect(() => {
    if (!capsLoaded) return;
    // ⚠️ **view union 加了新值就必须在这里加一条**，否则那个视图不受权限保护：
    //    降权或直链进来的用户会停在页面上，靠后端 403 才被挡（白屏 + 报错）。
    const gate: Record<string, string> = { finops: "nav:finops", cases: "nav:cases", admin: "nav:admin", notifications: "nav:notifications", skills: "nav:skills", customize: "nav:customize", security: "nav:security", investigate: "nav:investigate", inspection: "nav:inspection" };
    const need = gate[view];
    if (need && !can(need)) setView("chat");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capsLoaded, view]);
  // 通知未读数（60s 轮询；侧栏红点用）。
  const [notifUnread, setNotifUnread] = useState(0);
  // 桌面默认展开侧栏；手机/平板（≤768px）默认收起（侧栏在移动端是覆盖式抽屉）
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return window.matchMedia("(max-width: 768px)").matches; } catch { return false; }
  });
  // 侧边栏宽度（可拖拽，持久化）。min 200 / max 480。
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("notiops-chat-sidebar-w"));
    return v >= 200 && v <= 480 ? v : 264;
  });
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  // Sources 面板宽度（右侧停靠、可拖拽；像左侧栏一样独立、不遮挡主区）。
  const [srcWidth, setSrcWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("notiops-chat-src-w"));
    return v >= 280 && v <= 640 ? v : 380;
  });
  const srcWidthRef = useRef(srcWidth);
  srcWidthRef.current = srcWidth;
  const [accounts, setAccounts] = useState<AccountInfo[]>([]); // 多账号选择器数据
  const [deployment, setDeployment] = useState<{ accountId: string; accountName: string }>({ accountId: "", accountName: "Management account" });
  // 每会话独立的"生成中"状态：A 在流式输出时，切到 B 仍可正常提问，互不锁定。
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const busy = busyIds.has(activeId); // 仅当前会话在生成时，禁用当前会话的发送
  // 「未读」会话集合：某后台(非当前打开)会话的 agent 输出完成时标记，侧栏列表显红点提示，
  // 切进该会话即清除。让客户跳到别的 session 后，仍知道上一个 session 已出完结果。
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  // activeId 的最新值 ref：供流式完成回调(闭包捕获的是启动时的 activeId)判断"完成时是否仍停在该会话"。
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // view 的最新值 ref：同理。判断"完成时是否仍在看这个会话"不能只比 activeId ——
  // 用户可能切到了仪表盘/Skills 等非 chat 视图（activeId 没变但人已不在聊天窗），此时也应标未读。
  const viewRef = useRef(view);
  viewRef.current = view;
  const [username, setUsername] = useState("U");
  const [srcOpen, setSrcOpen] = useState(false);
  const [srcItems, setSrcItems] = useState<SourceItem[]>([]);
  // 通用/whats-new 主页启动卡片 → Composer 预填（点卡片=把 prompt 填进输入框，停留在该会话）。
  // 按会话 id 各存各的：多个 home 会话共用一份 prefill 时，切会话会把上一个会话的 seq 带过来
  // 触发填入 → 卡片自动填充内容跨会话泄漏。故用 Record<convId, {text,seq}>（同 themePrefill）。
  const [homePrefill, setHomePrefill] = useState<Record<string, { text: string; seq: number }>>({});
  const fillHomePrefill = (convId: string, text: string) =>
    setHomePrefill((p) => ({ ...p, [convId]: { text, seq: (p[convId]?.seq ?? 0) + 1 } }));
  // 右侧「思考过程」面板（复用 src 停靠栏样式）：记住**是哪条消息**（存 msgId），渲染时从当前
  // 会话实时取该消息的 steps —— 这样流式新步骤会实时进面板（不是打开那刻的快照）。
  // **只有这一个过程面板**：DevOps Agent 与普通对话的过程展示共用它（2026-09-04 客户要求一致）。
  const [thinkOpen, setThinkOpen] = useState(false);
  const [thinkMsgId, setThinkMsgId] = useState<string>("");
  // 自动弹面板的用户偏好：默认开；用户手动关一次就记住"别再自动弹了"（持久化）。
  // 用 ref 是因为它在流式回调里被读，state 会造成回调闭包读到旧值。
  const thinkAutoRef = useRef<boolean>((() => {
    try { return localStorage.getItem("notiops-thinkpanel-auto") !== "off"; } catch { return true; }
  })());
  const [finopsDash, setFinopsDash] = useState<string | null>(null);
  const [finopsData, setFinopsData] = useState<FinopsData | null>(null);
  const [casesDash, setCasesDash] = useState<string | null>(null);
  const [casesData, setCasesData] = useState<CasesDashboardData | null>(null);
  const accountIdRef = useRef("");
  /** 正在执行的写操作（键 = `${msgId}#${idx}`）—— 见 confirmAction 上的说明。 */
  const execingRef = useRef<Set<string>>(new Set());
  const [securityDash, setSecurityDash] = useState<string | null>(null);
  const [securityData, setSecurityData] = useState<SecurityDashboardData | null>(null);
  const [investigateDash, setInvestigateDash] = useState<string | null>(null);
  const [alarmData, setAlarmData] = useState<AlarmDashboardData | null>(null);
  // 资源巡检看板：当前打开的子页 key（null = 停在缩略卡主页）。
  //
  // ⚠️ 侧栏入口用 `isAdmin || (capsLoaded && can(...))` 而**不是**
  //    `!capsLoaded || can(...)` —— 与 Security 同档、与 Finops 不同。
  //    后者是 fail-open（能力加载期先显示），而巡检看板会显示客户的
  //    排除清单与阈值配置，那是运维决策不是公开信息。
  //    fail-open 会在加载完成前的那一瞬间对所有人闪出这个入口。
  // ⚠️ 数据**不在这里预取**。巡检的六个端点各自服务不同子页，而缩略卡主页
  // 一个都不需要 —— 在这里预取等于每次点开侧栏就打六次 DDB。
  // 各子页组件自己按需拉（见 InspectionDashboard）。
  const [inspectionDash, setInspectionDash] = useState<string | null>(null);
  // 🔴 这一条**不能**用 `can()`（上面 L177：`isAdmin || capKeys.includes(...)`）——
  //    「方式A 没有巡检后端」是**数据源**维度，不是权限维度：那张表 admin 也没有。
  //    2026-09-07 现网反馈就是 admin 看到侧栏有「巡检」、点进去 `加载失败 (ddb_error)`；
  //    只改后端那道 `requiresEnv` 闸门对 admin **完全无效**，因为 `can()` 自己先短路了。
  //    所以这里读**服务端算好的**那份列表：`/me/capabilities` 返回的 `visibleTree` 已经
  //    按 `requiresEnv: INSPECTION_TABLE` 把 `nav:inspection` 整棵子树摘掉了
  //    （`bff/web-chat/authz.mjs`；方式B 上 admin 照旧拿得到这一项）。
  //    ⚠️ 代价是 admin 要等能力加载完才看到入口（原来 `isAdmin ||` 让它立刻出现）——
  //       这与本入口 fail-closed 的初衷一致：加载完成前**谁都不显示**，而不是先闪出来。
  //    ⚠️ 别"顺手"把别的 `isAdmin || (capsLoaded && can(...))` 也改成这样：只有巡检
  //       这一个 tab 的可见性带**环境依赖**，其余那些纯粹是权限，admin 短路是对的。
  const showInspectionNav = capsLoaded && (capKeys || []).includes("nav:inspection");
  // dashboard **浏览账号**（finops/cases/security/investigate 仪表盘共用的全局浏览维度，与 chat
  // 会话账号解耦；见下方 acctPickerFor）。声明在此处——须在下面各 dashboard fetch effect 之前。
  const [dashAccountId, setDashAccountId] = useState("");
  // investigate 告警拉取移到 accountId 定义之后（账号感知，见下）
  // security 拉取移到 accountId 定义之后（账号感知，见下）
  useEffect(() => {
    if (view !== "finops" || finopsData) return; // 进入 FinOps 视图时只拉一次，缩略卡与面板共享
    let cancelled = false;
    getFinopsDashboard(dashAccountId).then((d) => { if (!cancelled) setFinopsData(d); }); // dashboard 浏览账号
    return () => { cancelled = true; };
  }, [view, finopsData, dashAccountId]);
  useEffect(() => {
    if (view !== "cases" || casesData) return; // 进入 Cases 视图时只拉一次，缩略卡与面板共享
    let cancelled = false;
    getCasesDashboard(dashAccountId).then((d) => { if (!cancelled) setCasesData(d); });
    return () => { cancelled = true; };
  }, [view, casesData, dashAccountId]);
  // 对话流滚动容器：用 **callback ref + state** 而不是纯 useRef —— 滚动监听必须以真实节点
  // 为依赖重绑（`.stream` 会随 <ErrorBoundary key={view}> 重挂载），见下方滚动跟随 effect。
  const streamRef = useRef<HTMLDivElement | null>(null);
  const [streamEl, setStreamEl] = useState<HTMLDivElement | null>(null);
  const attachStream = useCallback((el: HTMLDivElement | null) => { streamRef.current = el; setStreamEl(el); }, []);
  // 仅当用户停在底部附近时才自动跟随流式输出；一旦上滚查看历史就停止打扰
  const followRef = useRef(true);
  // 上一次已知的 scrollTop + "这次滚动是我们自己发起的"标记 —— 用来把**用户上滚**与
  // **程序滚到底**区分开，否则自动滚底触发的 scroll 事件会把跟随状态又打开。
  const lastTopRef = useRef(0);
  const selfScrollRef = useRef(false);
  // 程序滚到底：只有位置真的会变时才打 selfScroll 标记，否则标记留着会误吞用户的下一次滚动。
  const scrollToBottom = () => {
    const el = streamRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.clientHeight;
    if (bottom - el.scrollTop > 1) selfScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
  };
  // 已从后端拉过消息的会话 id（避免重复加载）
  const loadedRef = useRef<Set<string>>(new Set());
  // 每会话进行中的 AbortController（用于"停止生成"）
  const abortRef = useRef<Map<string, AbortController>>(new Map());
  // 已持久化（来自后端 / 已发过消息）的会话 id —— 用于判定"可丢弃的空会话"。
  // 注意不能用 loadedRef：它会把任何被选中的空会话也标上，无法区分本地新建。
  const persistedRef = useRef<Set<string>>(new Set());
  // 正在从后端拉历史（"水合"中）的会话 id。历史是懒加载的，请求在飞的那几秒里
  // messages 仍是 []，若只看 isEmpty 就会把**空会话落地页**当加载占位闪出来
  // （各主题闪各自的落地页：general 闪 4 卡主页、finops/cases/… 闪 greeting+建议）。
  // 故把"历史未到"与"真的是空会话"分开，前者渲染骨架屏。
  const [hydratingIds, setHydratingIds] = useState<Set<string>>(new Set());

  const active = conversations.find((c) => c.id === activeId) ?? conversations[0];
  const isEmpty = active.messages.length === 0; // 空对话 → 居中布局（ChatGPT 风）
  // 水合中：消息为空只是因为历史还没拉回来 → 骨架屏，不是空会话。
  const isHydrating = isEmpty && hydratingIds.has(active.id);
  // 真正该渲染"空会话落地页"的条件。凡是"空态布局"判断都用它，不要再直接用 isEmpty，
  // 否则水合期间仍会走居中空态（.main.empty）而出现落地页闪现。
  const showLanding = isEmpty && !isHydrating;
  // 通用主页启动卡片：从池里随机抽 4 个（每切换到一个新的空会话就重抽 → 每次「新对话」不同）。
  const homeCards = useMemo(() => {
    const arr = [...HOME_CARD_POOL];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, 4);
  }, [active.id]);
  // 主题空态主页：当前所在主题 view（finops/cases/security/investigate/whats-new）的随机 4 卡。
  // 一次性为所有主题各抽 4 张并缓存（依赖 active.id + themeSeed）——**必须 memo**：
  // 否则每次重渲染（如在 composer 里打字触发 setThemePrefill）都会重抽，卡片会跳变。
  const [themeSeed] = useState(0);
  const themeCardsCache = useMemo(() => {
    const out: Record<string, { key: string; Icon: React.FC<{ size?: number }>; promptKey: string }[]> = {};
    for (const k of Object.keys(TOPIC_LANDING)) {
      const arr = [...TOPIC_LANDING[k].pool];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      out[k] = arr.slice(0, 4);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id, themeSeed]);
  const themeCards = (topicKey: string) => themeCardsCache[topicKey] ?? [];
  // 主题 landing 的 Composer 预填信号（点卡片=把 prompt 填进输入框，停在该主题 landing，可改写后发送）。
  // 必须**按主题各存各的**：4 个主题 landing 共用一份 prefill 时，切主题会把上一个主题的
  // seq 带过来触发填入 → 卡片自动填充内容跨主题泄漏（bug）。故用 Record<topicKey, {text,seq}>。
  const [themePrefill, setThemePrefill] = useState<Record<string, { text: string; seq: number }>>({});
  const fillThemePrefill = (topicKey: string, text: string) =>
    setThemePrefill((p) => ({ ...p, [topicKey]: { text, seq: (p[topicKey]?.seq ?? 0) + 1 } }));
  // 「思考过程」面板实时数据：按 msgId 从当前会话取该消息（每次渲染都取最新）——流式新步骤写进
  // 消息后这里自动反映到面板，无需重新打开。**两个 agent 共用这一个面板**（2026-09-04）。
  const thinkMsg = thinkMsgId ? active.messages.find((m) => m.id === thinkMsgId) : undefined;
  // 兼容**改版前**存下来的老消息：那时 DevOps 的过程只写进 investigationSteps、没进 thinkingSteps，
  // 刷新后若只看 thinkingSteps 会是空面板。故 thinkingSteps 为空时回落到 investigationSteps
  // （只有 text，没有 kind → 统一按 status 那一档渲染）。新消息两者都有，走前者。
  const thinkSteps: TimelineStep[] = thinkMsg?.thinkingSteps?.length
    ? thinkMsg.thinkingSteps
    : (thinkMsg?.investigationSteps ?? []).map((s) => ({ text: s.text, kind: "status" as const }));
  const thinkLive = Boolean(thinkMsg?.streaming || thinkMsg?.thinking); // 仍在跑 → 面板显示脉冲/自动滚底
  // DevOps Agent 后台深链（只有 DevOps 那条有）——两条路径唯一的差异，属能力差异不是样式差异。
  const thinkConsoleUrl = thinkMsg?.investigationConsoleUrl ?? "";
  // 模型改为**每会话**：改了只影响该会话、切走再回保持。
  // 存量会话记的模型可能已被管理员下架 —— 此时回落到当前默认值，让下拉框显示的就是真正会用的
  // 那个（服务端也会做同样的替换并回一条 model_substituted，两侧结论一致）。
  // 订阅目录：`model` 是派生值，目录落地后必须重渲染，否则会一直停在加载期的空值。
  // （改动前 defaultModelId() 的初值是个非空常量，掩盖了这里没有订阅的问题。）
  const { defaultModel: catalogDefault } = useModelCatalog();
  const model = isSelectableModel(active.model) ? active.model! : catalogDefault;
  const setModel = (id: string) => setConversations((prev) => prev.map((c) => (c.id === activeId ? { ...c, model: id } : c)));
  // 多账号：当前 **chat 会话** 目标账号（默认空=部署账号）；改了只影响该会话（per-session 锁定）。
  const accountId = active.accountId ?? "";
  // effects 声明在本 const 之前也能拿到最新账号（拉取时机都在 render 后）
  accountIdRef.current = accountId;
  // 账号选择器渲染器（复用给 chat 会话 / dashboard 两处，各自传自己的值+setter）。
  const acctPickerFor = (value: string, onChange: (id: string) => void) => accounts.length > 0 ? (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      title={locale === "en" ? "Switch account for this view" : "切换本视图的账号视角"}
      style={{ marginLeft: 10, padding: "3px 8px", borderRadius: 8, border: `1px solid ${value ? "var(--orange)" : "var(--line)"}`, background: "var(--bg)", color: "var(--text)", fontSize: 12, fontWeight: 600, maxWidth: 260 }}>
      <option value="">{(deployment.accountName || "Management account") + (deployment.accountId ? " · " + deployment.accountId : "")}</option>
      {accounts.map((a) => (
        <option key={a.accountId} value={a.accountId}>{(a.accountName ? a.accountName + " · " : "") + a.accountId}</option>
      ))}
    </select>
  ) : null;
  // chat 会话账号选择器（session topbar 用）：读写**当前会话**的 accountId。
  const headerAcctPicker = acctPickerFor(accountId, (id) => setAccountId(id));
  // dashboard 浏览账号选择器：读写**全局** dashAccountId。
  const dashAcctPicker = acctPickerFor(dashAccountId, (id) => setDashAccountId(id));
  // 右对齐包装：把账号选择器推到 topbar 最右端（仿 AWS 控制台右上角；逻辑不变，仅位置）。
  // 作为 .topbar(flex) 的直接子元素 + marginLeft:auto 才生效 —— 故须放在 .title **之外**。
  const rightAlign = (el: React.ReactNode) => el ? <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center" }}>{el}</span> : null;
  const dashAcctPickerRight = rightAlign(dashAcctPicker);
  const headerAcctPickerRight = rightAlign(headerAcctPicker);
  // FinOps 数据是 payer 级组织聚合（含全部成员账号），在 LINKED_ACCOUNT 单账号过滤落地前，
  // 徽标如实标注聚合视角，避免"选了成员账号却看到全组织成本"的误解
  const finopsBadge = (
    <span title={dashAccountId
        ? (locale === "en" ? "Cost queries filtered to this account (LINKED_ACCOUNT); budgets/savings/credit sections remain org-level" : "成本查询已按该账号过滤（LINKED_ACCOUNT）；预算/优化建议/credit 等板块仍为组织级")
        : (locale === "en" ? "Cost data is aggregated at the payer (all member accounts included)" : "成本数据为 payer 级组织聚合（已包含全部成员账号）")}
      style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: "var(--muted)", border: "1px solid var(--line)", borderRadius: 100, padding: "2px 10px", marginLeft: 10 }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: dashAccountId ? "var(--orange)" : "var(--blue)", display: "inline-block" }} />
      {dashAccountId
        ? `${accounts.find((a) => a.accountId === dashAccountId)?.accountName || dashAccountId} · ${dashAccountId}${locale === "en" ? " (cost-filtered)" : "（成本已过滤）"}`
        : (locale === "en" ? "Org aggregate (payer)" : "组织聚合 (payer)")}
    </span>
  );
  const setAccountId = (id: string) => setConversations((prev) => prev.map((c) => (c.id === activeId ? { ...c, accountId: id } : c)));
  // Security 仪表盘：按 **dashboard 浏览账号** 拉取（BFF 侧按账号缓存 5 分钟）；切浏览账号即失效重取
  useEffect(() => {
    if (view !== "security" || securityData) return;
    let cancelled = false;
    getSecurityDashboard(dashAccountId).then((d) => { if (!cancelled) setSecurityData(d); });
    return () => { cancelled = true; };
  }, [view, securityData, dashAccountId]);
  useEffect(() => { setSecurityData(null); }, [dashAccountId]);
  // Investigate 告警仪表盘：按 dashboard 浏览账号拉取；切浏览账号即失效重取
  useEffect(() => {
    if (view !== "investigate" || alarmData) return;
    let cancelled = false;
    getAlarmDashboard(dashAccountId).then((d) => { if (!cancelled) setAlarmData(d); });
    return () => { cancelled = true; };
  }, [view, alarmData, dashAccountId]);
  useEffect(() => { setAlarmData(null); }, [dashAccountId]);
  // Cases 仪表盘：按 dashboard 浏览账号拉取（BFF supportClientFor 按账号 AssumeRole）；切浏览账号即失效重取
  useEffect(() => { setCasesData(null); }, [dashAccountId]);
  // FinOps：切浏览账号 → LINKED_ACCOUNT 过滤视角失效重取
  useEffect(() => { setFinopsData(null); }, [dashAccountId]);
  // 联网搜索改为**每会话**：开关只影响当前会话（默认关）；切到别的会话不受影响。
  const webSearch = active.webSearch ?? false;
  const toggleWebSearch = () => setConversations((prev) => prev.map((c) => (c.id === activeId ? { ...c, webSearch: !(c.webSearch ?? false) } : c)));
  // FinOps Agent 深度模式：同样**每会话**独立（默认关）；仅 FinOps 主题会显示该开关。
  const finopsAgent = active.finopsAgent ?? false;
  const toggleFinopsAgent = () => setConversations((prev) => prev.map((c) => (c.id === activeId ? { ...c, finopsAgent: !(c.finopsAgent ?? false) } : c)));
  // DevOps Agent 深度调查：每会话独立（默认关）；哪些主题显示该开关见 types.ts
  // `topicHasDevopsAgent`（默认全部提供，只排除 general/cases/whats-new）。
  const devopsAgent = active.devopsAgent ?? false;
  // 「深度调查（直连）」：同一能力的 0-token 版本。两个开关**互斥** —— 点亮一个自动灭另一个
  // （同时开会同时走两条路：一条烧 token 的 + 一条直连的）。
  const devopsAgentDirect = active.devopsAgentDirect ?? false;
  // 「DevOps 对话」：直连 DevOps Agent 控制面对话 API，由**客户自己的 DevOps Agent** 回答
  // （NotiOps 侧 0 token）。仅故障调查主题显示。
  const devopsChat = active.devopsChat ?? false;
  // 「阿里云 STAROps」：BFF 直连**阿里云** STAROps 数字员工（CreateChat + SSE），由客户自己的
  // 数字员工回答（计他的阿里云 AI 额度，NotiOps 侧 0 token）。仅通用会话的「对话对象」可选。
  const starops = active.starops ?? false;
  /** 四个"谁来答"的字段是**单选**（four-way exclusive）：点亮一个自动灭其余三个。
   *  同时开的后果不是"更强"，而是同一个问题被送上几条互不相干的链路 —— 其中 starops
   *  那条还会把问题原文送到**另一朵云**上，而界面上完全看不出来。
   *  写成显式四个布尔（而不是计算 key 的展开）是为了让 TS 精确校验字段名。 */
  const setDevopsMode = (mode: "agent" | "direct" | "chat" | "starops" | "off") =>
    setConversations((prev) => prev.map((c) => (c.id === activeId
      ? { ...c, devopsAgent: mode === "agent", devopsAgentDirect: mode === "direct", devopsChat: mode === "chat", starops: mode === "starops" }
      : c)));
  const toggleDevopsAgent = () => setDevopsMode(devopsAgent ? "off" : "agent");
  /** 「深度调查（直连）」有**两种语义**，按会话类型分：
   *  · 故障调查等主题：它是三个 DevOps 开关之一 → 单选（点亮它灭掉其余两个）；
   *  · 通用会话且对话对象已是 DevOps Agent（objMode）：它是**这一轮的修饰** —— 对象没变，
   *    只是这一轮从"直接问答"换成"发起一次深度调查"，所以**绝不能**把 devopsChat 一起灭掉
   *    （灭了就等于客户勾一下深度调查、这段对话的对象被悄悄换回 NotiOps 来答，而标题栏的
   *    tag 也会跟着跳）。两个字段同时为真时由 BFF 让深度调查优先
   *    （index.mjs：`chatDirect = objDevops && !deepDirectAsked`）。 */
  const toggleDevopsAgentDirect = () => {
    if (devopsChat && (active.topic ?? "general") === "general") {
      setConversations((prev) => prev.map((c) => (c.id === activeId
        ? { ...c, devopsAgentDirect: !(c.devopsAgentDirect ?? false), devopsAgent: false }
        : c)));
      return;
    }
    setDevopsMode(devopsAgentDirect ? "off" : "direct");
  };
  const toggleDevopsChat = () => setDevopsMode(devopsChat ? "off" : "chat");

  // 选中的模式**跟着会话留下来**（跨刷新）。
  //
  // 为什么要有这一段：三个开关只活在前端的 Conversation 对象里，后端不存 ——
  // 刷新后 `listConversations()` 重建列表时它们一律回落 false。客户报的现象是
  // 「在调查会话里选了 DevOps 对话、发过问、刷新一下选择就没了」，而且不报错：
  // 接着追问会静默换成 NotiOps 来答。落盘细节与取舍见 convMode.ts。
  //
  // 挂在 effect 上而不是塞进 setDevopsMode：模式还有别的写入口（落地页草稿随
  // startFromNotification 带进新会话、水合时按历史 via 回锁），逐个去 hook 必然漏一个。
  // 只看 active 是够的 —— 非当前会话的模式没有任何入口能改。
  useEffect(() => {
    if (!active) return;
    saveConvMode(active.id, modeOf(active));
  }, [active]);

  // ── 主题 landing 页的开关草稿（per-topic，互不影响）──
  // BUG 修复：各主题 landing 页共用同一个 active 会话，直接读写 active.webSearch 会导致
  // 「一个主题开联网 → 所有主题都变」。landing 页改用按 topic 存的草稿状态，真正发消息时
  // 通过 convPatch 带进新会话。（真实会话内的开关仍走上面的 active.* per-会话逻辑。）
  type LandingToggle = { webSearch?: boolean; finopsAgent?: boolean; devopsAgent?: boolean; devopsAgentDirect?: boolean; devopsChat?: boolean };
  const [landingToggles, setLandingToggles] = useState<Record<string, LandingToggle>>({});
  // 各主题 landing 开关的默认值 —— 必须与 emptyConversation 的默认保持一致，否则
  // landing 开关显示的状态与新会话实际发送的状态脱节（曾导致：investigate 深度调查
  // 显示为关、发送后却是开）。当前所有主题 devopsAgent 均默认关（用户按需手动开）。
  const LANDING_DEFAULTS: Record<string, LandingToggle> = {};
  const lt = (topic: string): LandingToggle => ({ ...(LANDING_DEFAULTS[topic] ?? {}), ...(landingToggles[topic] ?? {}) });
  const setLt = (topic: string, patch: LandingToggle) =>
    setLandingToggles((prev) => ({ ...prev, [topic]: { ...(LANDING_DEFAULTS[topic] ?? {}), ...(prev[topic] ?? {}), ...patch } }));

  // ── 主题 landing 页的**模型**草稿（per-topic，与上面的开关同源同理）──
  // BUG 修复：landing 的模型选择器此前直接读写 `model`/`setModel`（= 背后那个 active 会话的
  // 模型），而发送走 startFromNotification **新建**会话、只继承账号与开关，模型被
  // emptyConversation 重置成管理员默认值 —— 表现为「选了 Grok 4.6，一发送又变回 Sonnet 5」，
  // 且**真的用默认模型发出去了**（handleSend 的 sendModel 取新会话的 model），不只是显示不对。
  // 现在与开关一样按 topic 存草稿，发送时通过 convPatch 带进新会话。
  const [landingModels, setLandingModels] = useState<Record<string, string>>({});
  // 草稿为空 / 记的模型已被管理员下架 → 回落到当前默认模型（与会话内 `model` 的口径一致）。
  const lm = (topic: string): string => {
    const id = landingModels[topic];
    return isSelectableModel(id) ? id! : catalogDefault;
  };
  const setLm = (topic: string, id: string) => setLandingModels((prev) => ({ ...prev, [topic]: id }));

  useEffect(() => {
    getCurrentUser()
      .then((u) => setUsername(u.username || "U"))
      .catch(() => setUsername("dev")); // 跳过登录预览时无真实用户
  }, []);

  // 多账号：启动加载已注册账号列表（供账号选择器）。失败 → 空（仅默认账号）。
  // 账号列表随视图切换刷新（offboard/onboard 后无需整页刷新即同步；请求走 15s 内去重）
  const accountsFetchedAt = useRef(0);
  useEffect(() => {
    if (Date.now() - accountsFetchedAt.current < 15000) return;
    accountsFetchedAt.current = Date.now();
    getAccountsFull().then((r) => { setAccounts(r.accounts); setDeployment(r.deployment); }).catch(() => {});
  }, [view]);

  // 通知红点：启动 + 每 60s 轮询（方案：实时性非硬需求，用轻量轮询代替 WebSocket）。
  // 红点数 = **仅收件箱未读**(其他事件源 push)。故意不叠加 Health 未处理 issue 数 ——
  // 那是"客观存在的未解决问题"(如某 region operational issue 长期 open),不是"读没读"
  // 能清的,叠进红点会导致红点永远消不掉。Health 未处理数已由左侧导航各分块的计数徽章反映。
  // 在通知页时红点清零（进去即读）。
  useEffect(() => {
    let stop = false;
    const tick = () => {
      if (view === "notifications") { setNotifUnread(0); return; }
      // ⚠️ 只在**问到了**的时候才写计数（u.ok）。原来是无条件 `u.unread || 0`，而失败
      // 分支回的就是 `{unread: 0}` —— 轮询里任何一次抖动都会把红点灭掉，用户看到的是
      // "没有新通知"这句明确的假话，而且不会再点进去看。红点宁可停在旧数字上（陈旧），
      // 也不能归零（说谎）。
      unreadCount().then((u) => { if (!stop && u.ok) setNotifUnread(u.unread || 0); }).catch(() => {});
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => { stop = true; clearInterval(id); };
  }, [view]);

  // 启动时拉一次可选模型（管理员勾选的启用集，GET /models）。
  // 失败不处理：models.ts 会继续用内置兜底目录，下拉框不会空（见该文件「失败安全」）。
  useEffect(() => { void refreshModelCatalog(); }, []);

  // 启动时从后端加载历史会话列表（持久化：刷新不再清空）。
  useEffect(() => {
    let cancelled = false;
    listConversations()
      .then((list) => {
        if (cancelled || !list.length) return;
        const loaded: Conversation[] = list.map((c) => {
          // 唯一的 topic 水合口 —— 退役主题在**这里**归一（security → investigate）。
          // 库里那些 topic:"security" 永远不会被改写（写入带 attribute_not_exists(SK)，
          // 也没有任何接口能改 topic），所以必须读时归一，不能指望"下次发消息自愈"。
          // 以前这里是 `c.topic as TopicKey` —— 硬转，TypeScript 一个字都拦不住。
          const topic = normalizeTopic(c.topic);
          return {
            id: c.id,
            title: c.title || (locale === "en" ? "New chat" : "新对话"),
            topic,
            messages: [], // 消息懒加载：选中时再拉
            updatedAt: c.updatedAt,
            pinned: c.pinned, // 置顶状态从后端读回（刷新不再丢失）
            obj: c.obj || undefined, // 最后一轮谁答的（侧栏 tag 用）；空串→undefined，别标成 NotiOps
            // 回答模式从本地记忆读回（刷新不再丢失）。后端不存这三个字段，见 convMode.ts。
            ...fieldsOf(restorableMode(topic, loadConvMode(c.id))),
          };
        });
        loaded.forEach((c) => persistedRef.current.add(c.id)); // 后端来的都算已持久化
        setConversations(loaded);
        setActiveId(loaded[0].id);
      })
      .catch(() => { /* 拉取失败：保留本地空会话 */ });
    return () => { cancelled = true; };
    // 仅启动时加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 选中某会话且尚未加载过消息 → 从后端拉取该会话历史。
  useEffect(() => {
    const conv = conversations.find((c) => c.id === activeId);
    if (!conv || loadedRef.current.has(activeId) || conv.messages.length > 0) return;
    loadedRef.current.add(activeId);
    // 只有**后端来的**会话才可能有历史待拉取 → 标记水合中，让主区渲染骨架屏而不是落地页。
    // 本地新建的空会话不在 persistedRef 里（见启动加载处的 persistedRef 填充），不标记，
    // 落地页照旧立即渲染 —— 「新对话」体验零回归。
    const willHydrate = persistedRef.current.has(activeId);
    if (willHydrate) setHydratingIds((p) => new Set(p).add(activeId));
    const settleHydration = () => {
      if (!willHydrate) return;
      setHydratingIds((p) => {
        if (!p.has(activeId)) return p; // 无变化就返回原引用，避免多余重渲染
        const n = new Set(p);
        n.delete(activeId);
        return n;
      });
    };
    getMessages(activeId)
      .then(({ messages: msgs, truncated, limit }) => {
        if (!msgs.length) return;
        const mapped: ChatMessage[] = msgs.map((m, i) => ({
          id: `${activeId}-h${i}`,
          role: m.role,
          text: m.text,
          ts: m.ts,
          model: m.model,
          sources: m.sources,
          usage: m.usage,
          accountId: m.account_id,  // 历史回复的账号徽标(刷新后仍显示)
          via: m.via,               // 答案来源(devops-agent → 署名行显示 "AWS DevOps Agent")
          staropsEmployee: m.starops_employee, // 阿里云那条：页脚显示当时那个数字员工 ID
        }));
        // 「对话对象」的锁要**跨刷新**成立：devopsChat 只活在前端内存里，刷新后回落 false ——
        // 那样一个由客户自己的 DevOps Agent 答过的会话，接着问会**静默换成 NotiOps 来答**
        // （客户看不出来，只会觉得答案风格突然变了）。历史消息里的 via="devops-agent" 是
        // 持久化的事实（store.mjs 存了这个字段），用它把锁恢复回来。
        // 只恢复通用会话：故障调查主题仍是"每轮开关"语义，这里一行不动。
        // ⚠️ 历史被截断时这个锁也会跟着丢：`via="devops-agent"` 只存在于被丢掉的
        // 那些早期轮次里 → relock=false → 接着问会静默换回 NotiOps 来答。所以下面那条
        // 截断提示不只是"少显示了几条"，它同时是这个锁失效的唯一线索。
        //
        // STAROps 同理，但**必须是独立的一条锁**，绝不能与上面那条合并成"有 via 就锁 devopsChat"：
        // 那样刷新后一段阿里云会话会被锁成 AWS DevOps Agent，接着问就把问题原文送去了
        // 另一朵云 —— 界面上只是署名行变了一行字，客户几乎不可能发现。
        // 两条锁互斥，STAROps 优先（与 modeOf / BFF 的一选一同序）。
        const relock = mapped.some((m) => m.via === "devops-agent");
        const relockSo = mapped.some((m) => m.via === "starops");
        setConversations((prev) => prev.map((c) => {
          if (c.id !== activeId) return c;
          const general = (c.topic ?? "general") === "general";
          const lockSo = relockSo && general;
          const lock = !lockSo && relock && general;
          return {
            ...c, messages: mapped, historyTruncated: truncated, historyLimit: limit,
            ...(lockSo ? { starops: true, devopsChat: false, devopsAgent: false, devopsAgentDirect: false }
              : lock ? { devopsChat: true, starops: false, devopsAgent: false, devopsAgentDirect: false } : {}),
          };
        }));
      })
      .catch(() => { /* ignore */ })
      // 必须放在 then 之后：先落消息再摘水合标记，否则中间会有一帧
      // messages 仍空、水合已结束 → 落地页又闪一下（就是要修的那个 bug）。
      // 拉到空数组 / 请求失败时同样要摘，否则骨架屏卡死。
      .finally(settleHydration);
  }, [activeId, conversations]);

  // 已预热过的会话（每个 tab 生命周期内每会话最多一次）。
  const warmedRef = useRef<Set<string>>(new Set());

  // 会话预热：**空会话摆到用户面前**时，先把 agent runtime 那个容器叫起来（0 token）。
  //
  // 首字延迟的大头不是模型，是容器还没准备好（平台冷启动 + import + 挂工具快照 + 起 MCP
  // 子进程，实测 ~10s）。这段时间与"用户读落地页、想好要问什么、把问题打出来"完全重叠 ——
  // 白等的那 10s 就是这么省掉的。
  //
  // 口径（有意为之，别顺手放宽）：
  //   · **只预热空会话**。有历史的会话被点开时不热 —— 用户在侧栏翻会话是常态，每点一下
  //     热一发就是白起 N 个 microVM（真金白银），而"接着追问"这一路的 runtimeSessionId
  //     通常还是热的。代价：刷新页面后打开旧会话追问，仍是原来的延迟。
  //   · 每会话至多一次（warmedRef），且不看 hydratingIds —— 水合中的会话必然非空，进不来。
  //   · 站在输入框前才热：管理/技能/通知/定制这些页面没有 Composer，热了没人用。
  //   · model/topic/accountId/devopsAgent 与 handleSend 同源。预热后用户又改了模型 →
  //     真正那一轮会另建一个 agent（多花约 1s 建 agent），但容器/import/MCP 的预热仍然有效。
  useEffect(() => {
    if (view === "skills" || view === "customize" || view === "admin" || view === "notifications") return;
    if (!active || active.messages.length > 0) return;
    if (warmedRef.current.has(active.id)) return;
    warmedRef.current.add(active.id);
    // 发即忘：warmupChat 自己吞掉所有异常，失败的唯一后果是首字回到原来的延迟。
    void warmupChat({ conversationId: active.id, model, topic: active.topic ?? "general", accountId, devopsAgent });
  }, [view, active, model, accountId, devopsAgent]);

  // 监听滚动：判断用户是否还贴着底部；一旦上滚就停止自动跟随。
  //
  // ⚠️ 依赖必须是**真实 DOM 节点**（streamEl），不能用 isEmpty 之类的近似信号 —— 这是
  // 「上滚被强拉回底」反复复发的根因：`.stream` 会随 <ErrorBoundary key={view}> 在**切换视图**
  // （主题落地页/仪表盘 → chat）时整棵子树重挂载。若切走前的 active 会话本来就有消息，
  // isEmpty 全程为 false → effect 不重跑 → 监听留在**已卸载的旧节点**上，而 streamRef 指向
  // 新节点、身上一个监听都没有 → followRef 永远是 true → 每个 token 都把视口按回底部。
  // 复现路径：先在任意会话里聊过 → 进「成本/调查」等主题页 → 从落地页发问 → 流式中上滚。
  // 用 callback ref 把节点存进 state：节点换了就一定重绑，与 view/topic/isEmpty 全部解耦。
  useEffect(() => {
    const el = streamEl;
    if (!el) return;
    const dist = () => el.scrollHeight - el.scrollTop - el.clientHeight;
    // 用户主动上滚：**任何输入方式**都靠"scrollTop 变小且不是我们自己滚的"识别（滚轮/触摸/
    // 拖滚动条/键盘 PageUp 都覆盖）。wheel/touch 额外保留一份即时判定，比 scroll 事件更早到。
    const onScroll = () => {
      const top = el.scrollTop;
      if (selfScrollRef.current) { selfScrollRef.current = false; lastTopRef.current = top; return; }
      if (top < lastTopRef.current - 1) followRef.current = false;
      else if (dist() < 24) followRef.current = true; // 只有真正回到底部才重新跟随
      lastTopRef.current = top;
    };
    const stopFollow = () => { followRef.current = false; selfScrollRef.current = false; };
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) stopFollow(); };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent) => { if ((e.touches[0]?.clientY ?? 0) > touchY) stopFollow(); };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    lastTopRef.current = el.scrollTop;
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [streamEl]);

  useEffect(() => {
    // 只有在"跟随"状态才滚到底；用户上滚看历史时不强拉
    if (followRef.current) scrollToBottom();
  }, [active.messages]);

  // 切换会话时重置为跟随并滚到底
  useEffect(() => {
    followRef.current = true;
    scrollToBottom();
  }, [activeId, streamEl]);

  // 按**指定会话 id**改写（流式回调必须用启动时捕获的 convId，而非随时会变的 activeId，
  // 否则用户中途切会话会把 token 写到错误的会话里）。
  const patchConv = (convId: string, fn: (c: Conversation) => Conversation) => {
    setConversations((prev) => prev.map((c) => (c.id === convId ? fn(c) : c)));
  };
  const patchMsgIn = (convId: string, msgId: string, patch: Partial<ChatMessage>) => {
    patchConv(convId, (c) => ({
      ...c,
      messages: c.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)),
    }));
  };
  const setBusyFor = (convId: string, on: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(convId); else next.delete(convId);
      return next;
    });
  };

  const handleSend = async (text: string, skillId?: string, target?: Conversation) => {
    // 捕获本轮所属会话（之后即便用户切走，回调仍写回这个会话）。
    // target：从通知卡等外部入口发起时显式传入新会话对象（避免 setActiveId 未生效、
    // 且 conversations 闭包里还没有该新会话 的双重竞态）。
    const convId = target?.id ?? activeId;
    const findConv = (c: Conversation) => c.id === convId;
    const targetConv = target ?? conversations.find(findConv);
    const convTopic = targetConv?.topic ?? "general";
    if (busyIds.has(convId)) return; // 该会话正在生成才拦；其他会话不受影响
    persistedRef.current.add(convId); // 发过消息 → 已持久化，不再当空会话丢弃
    const userMsg: ChatMessage = { id: newId("u"), role: "user", text, ts: Date.now() };
    const botId = newId("a");
    const sendModel = targetConv?.model ?? model;
    // 本轮提问的目标账号（与下方 streamChat 同源）——存进 assistant 消息,让历史回复能标明针对哪个账号。
    const sendAccountId = targetConv?.accountId ?? (conversations.find(findConv)?.accountId) ?? "";
    // 「DevOps 对话」开着时这轮由客户自己的 DevOps Agent 回答 —— 从第一帧就署名成
    // "AWS DevOps Agent"（否则流式期间会先挂着本地模型名，答完才跳变）。
    const sendDevopsChat = targetConv?.devopsChat ?? (conversations.find(findConv)?.devopsChat) ?? false;
    // 同理的第四个对象：阿里云 STAROps 数字员工。第一帧就要署名成它 —— 这条链路一个字都不经
    // Bedrock，先挂上本地模型名等于在流式那几秒里对客户撒谎（还是"答案来自哪朵云"这种谎）。
    const sendStarops = targetConv?.starops ?? (conversations.find(findConv)?.starops) ?? false;
    const botMsg: ChatMessage = { id: botId, role: "assistant", text: "", ts: Date.now(), thinking: true, thinkElapsed: 0, streaming: true, model: modelDisplayName(sendModel), accountId: sendAccountId, via: sendStarops ? "starops" : sendDevopsChat ? "devops-agent" : undefined };

    // upsert:通常会话已在列表里(map 命中);但从通知卡发起时,新会话可能还没被
    // React flush 进 conversations（setConversations 与本 setTimeout 的时序不定）——
    // 若 map 找不到就会静默丢消息(表现为"有时点了没反应")。故用 target 兜底插入。
    setConversations((prev) => {
      const exists = prev.some((c) => c.id === convId);
      const apply = (c: Conversation): Conversation => ({
        ...c,
        title: c.messages.length === 0 ? text.slice(0, 24) : c.title,
        messages: [...c.messages, userMsg, botMsg],
        updatedAt: Date.now(),
        // 侧栏 tag 立刻跟上（服务端 `obj` 只在下次 listConversations 才读得到，
        // 不本地置位的话：刚在通用会话里选了 STAROps 发第一句，顶栏已经是「阿里云 STAROps」
        // 而侧栏那条还什么都没有 —— 同一段会话两处说法不一致）。
        // 判定与 botMsg.via **同源**（也就是 BFF 落库那份的同一组条件），不是另猜一遍：
        //   starops → "starops"、DevOps 对话 → "devops"、其余（含内置回答）→ "notiops"。
        // 唯一会与服务端不一致的是「转人工支持」那种回落到我们 agent 的轮次（BFF 会记
        // "notiops"）—— 下次刷新即以服务端为准，这里不猜它。
        obj: sendStarops ? "starops" : sendDevopsChat ? "devops" : "notiops",
      });
      if (exists) return prev.map((c) => (c.id === convId ? apply(c) : c));
      // 不在列表(新会话尚未 flush):用传入的 target 作基插入到最前。
      const base = target ?? { id: convId, title: text.slice(0, 24), topic: convTopic, messages: [], updatedAt: Date.now() } as Conversation;
      return [apply(base), ...prev];
    });
    setBusyFor(convId, true);

    // 本轮 AbortController：供"停止生成"用
    const ac = new AbortController();
    abortRef.current.set(convId, ac);

    // 思考计时
    let sec = 0;
    const tk = setInterval(() => { sec += 1; patchMsgIn(convId, botId, { thinkElapsed: sec }); }, 1000);
    let firstToken = true;
    let acc = "";
    let reasoningAcc = ""; // 思考过程累积（可折叠灰字）
    const invSteps: import("../api/chat").InvestigationStep[] = []; // 调查过程累积（走右侧面板）
    // 「思考过程」时间线累积（走右侧面板；合并连续思考、去重重复行、滤掉 BFF 等待期提示）。
    let thinkTimeline: TimelineStep[] = [];
    // 收到第一步时：若用户没关过自动弹，且面板没在看别的消息 → 自动把面板打开到本条。只做一次。
    let thinkAutoDone = false;
    const pushThinking = (next: TimelineStep[]) => {
      if (next === thinkTimeline) return;             // 纯函数原样返回（被过滤/到顶）→ 不必重渲染
      thinkTimeline = next;
      patchMsgIn(convId, botId, { thinkingSteps: next });
      if (!thinkAutoDone && thinkAutoRef.current && convId === activeIdRef.current && viewRef.current === "chat") {
        thinkAutoDone = true;
        setThinkMsgId(botId);
        setSrcOpen(false); // 与 Sources 互斥，共用停靠位
        setThinkOpen(true);
      }
    };

    try {
      await streamChat(
        { conversationId: convId, text, model: sendModel, locale, webSearch: (conversations.find(findConv)?.webSearch) ?? false, finopsAgent: (conversations.find(findConv)?.finopsAgent) ?? false, devopsAgent: targetConv?.devopsAgent ?? (conversations.find(findConv)?.devopsAgent) ?? false, devopsAgentDirect: targetConv?.devopsAgentDirect ?? (conversations.find(findConv)?.devopsAgentDirect) ?? false, devopsChat: sendDevopsChat, starops: sendStarops, topic: convTopic, accountId: targetConv?.accountId ?? (conversations.find(findConv)?.accountId) ?? "", skillId },
        {
          onToken: (delta) => {
            if (firstToken) { firstToken = false; clearInterval(tk); }
            acc += delta;
            // 收到正文 → 清掉临时进度行（"正在做什么"已完成，正文开始输出）。
            patchMsgIn(convId, botId, { text: acc, thinking: false, streaming: true, progress: "" });
          },
          // 处理中临时状态行（工具调用等）：只在**还没有正文**时显示（复用思考态区域），
          // 一旦正文开始就由 onToken 清空。文案已由 agent 端按本轮语言给好，前端直接显示。
          onProgress: (p) => {
            if (!acc && p?.text) patchMsgIn(convId, botId, { progress: p.text });
            // 工具调用等进度行也进「思考过程」时间线（appendStep 会按 kind 滤掉 coldstart/working
            // 这类 BFF 等待期提示——那不是模型/工具做的事）。
            if (p?.text) pushThinking(appendStep(thinkTimeline, { text: p.text, kind: p.kind }, Date.now()));
          },
          // 思考过程增量：累积成可折叠灰字（默认折叠）+ 并进右侧面板的思考段。语言由 agent 端锁定跟随本轮。
          onReasoning: (r) => {
            if (r?.text) {
              reasoningAcc += r.text;
              patchMsgIn(convId, botId, { reasoning: reasoningAcc });
              pushThinking(appendReasoning(thinkTimeline, r.text, Date.now()));
            }
          },
          // 思考/处理过程的一步（工具调用及入参摘要、工具返回摘要）→ 右侧「思考过程」面板。
          onThinkingStep: (step) => { if (step?.text) pushThinking(appendStep(thinkTimeline, step, Date.now())); },
          onSources: (sources) => patchMsgIn(convId, botId, { sources }),
          onActions: (actions) => patchMsgIn(convId, botId, { actions }),
          onFollowups: (followups) => patchMsgIn(convId, botId, { followups }),
          // DevOps Agent 的调查步骤。除了原样存进 investigationSteps（面板的 console 深链、历史兼容
          // 都靠它），**还要进同一条思考时间线** —— 两个 agent 的过程展示要一致：同一个面板、同样的
          // 图标/「进行中」脉冲/自动滚底/自动弹出。只写 investigationSteps 的话 DevOps 那条不会自动弹。
          onInvestigationStep: (step) => {
            invSteps.push(step);
            const patch: Partial<ChatMessage> = { investigationSteps: [...invSteps] };
            if (step.console_url) patch.investigationConsoleUrl = step.console_url;
            patchMsgIn(convId, botId, patch);
            if (step.text) pushThinking(appendStep(thinkTimeline, { text: step.text }, Date.now()));
          },
          onUsage: (usage) => patchMsgIn(convId, botId, { usage }),
          // 答案来源标记（"builtin" = agent 的内置确定性回答，未调模型、0 token）：
          // 把这条的署名行从「AWS Bedrock (某模型)」换成 NotiOps。agent 在正文之前发这一帧，
          // 所以署名不会先按模型渲染再跳变。
          // staropsEmployee 只有阿里云那条路径会带（页脚显示"哪个数字员工答的"）。
          // 用 ...(x ? {} : {}) 而不是直接写进对象：别让别的路径把它 patch 成 undefined
          // 覆盖掉已有值。
          onVia: (via, staropsEmployee) =>
            patchMsgIn(convId, botId, { via, ...(staropsEmployee ? { staropsEmployee } : {}) }),
          // 服务端换了模型（本会话记的那个已被管理员下架）：把会话选择和本条署名都纠正过来，
          // 并重拉一次候选集 —— 说明本地目录已过期。不纠正的话用户会一直看到一个再也用不了的名字。
          onModelSubstituted: (info) => {
            const eff = String(info?.effective || "");
            if (!eff) return;
            setConversations((prev) => prev.map((c) => (c.id === convId ? { ...c, model: eff } : c)));
            patchMsgIn(convId, botId, { model: modelDisplayName(eff) });
            void refreshModelCatalog();
          },
          onDone: () => { clearInterval(tk); patchMsgIn(convId, botId, { streaming: false, thinking: false, progress: "" }); },
          onError: (msg) => { clearInterval(tk); patchMsgIn(convId, botId, { text: acc || `⚠️ ${msg}`, streaming: false, thinking: false, progress: "" }); },
        },
        ac.signal,
      );
    } catch (e) {
      clearInterval(tk);
      // 用户主动停止：保留已生成内容，附一句"已停止"，不当错误
      const aborted = (e as Error)?.name === "AbortError" || ac.signal.aborted;
      if (aborted) {
        patchMsgIn(convId, botId, { text: (acc || "") + (acc ? "\n\n" : "") + (locale === "en" ? "_(stopped)_" : "_（已停止）_"), streaming: false, thinking: false });
      } else {
        patchMsgIn(convId, botId, { text: acc || `⚠️ ${(e as Error)?.message ?? "error"}`, streaming: false, thinking: false });
      }
    } finally {
      clearInterval(tk);
      patchMsgIn(convId, botId, { streaming: false, thinking: false, progress: "" });
      setBusyFor(convId, false);
      abortRef.current.delete(convId);
      // 生成结束（正常/停止/出错皆然）时，若用户已不在看这个会话 → 标「未读」，侧栏红点提示；
      // 若仍停在该会话（且视图就是聊天）则不标（用户正看着，无需提示）。切进该会话时清除（见 switchTo）。
      // "不在看" = 切到了别的会话，或虽是同一会话但视图切到了仪表盘/Skills 等非 chat 视图。
      const stillViewing = convId === activeIdRef.current && viewRef.current === "chat";
      if (!stillViewing) setUnreadIds((prev) => new Set(prev).add(convId));
    }
  };

  // 停止当前会话正在进行的生成
  const stopGen = () => {
    const ac = abortRef.current.get(activeId);
    if (ac) ac.abort();
  };

  // 拖拽分割线调节侧边栏宽度（min 200 / max 480），松手持久化。
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(200, Math.min(480, startW + (ev.clientX - startX)));
      setSidebarWidth(w);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem("notiops-chat-sidebar-w", String(sidebarWidthRef.current)); } catch { /* ignore */ }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // 拖拽 Sources 面板左边缘调宽（右侧停靠，向左拖变宽，故 delta 取反；min 280 / max 640）。
  const startSrcResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = srcWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(280, Math.min(640, startW - (ev.clientX - startX)));
      setSrcWidth(w);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem("notiops-chat-src-w", String(srcWidthRef.current)); } catch { /* ignore */ }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const openSources = (m: ChatMessage) => { setSrcItems(m.sources ?? []); setSrcOpen(true); };
  // 打开右侧「思考过程」面板（点入口按钮触发）。与 Sources 互斥（共用停靠位）。
  // 只记 msgId，步骤在渲染时实时取（见上方 thinkMsg/thinkSteps 派生）——流式新步骤会自动进面板。
  const openThinking = (m: ChatMessage) => {
    setThinkMsgId(m.id);
    setSrcOpen(false);
    setThinkOpen(true);
  };
  // 用户**手动**关闭思考面板 → 记住"以后别自动弹了"（持久化）。自动弹只是便利，用户关掉即尊重。
  const closeThinking = () => {
    setThinkOpen(false);
    thinkAutoRef.current = false;
    try { localStorage.setItem("notiops-thinkpanel-auto", "off"); } catch { /* ignore */ }
  };

  // 用户在确认卡上点"确认" → 执行写操作（创建/回复/关闭 case），结果回填到该 action。
  // editedParams：可编辑建案卡(create_case_form)提交时传入客户改过的参数 —— 用它执行真正的
  // create_case（表单卡只负责收集，执行仍走确定性 /actions/execute）。
  // pickedAccount：开案例卡上那个账号下拉选中的账号（2026-09-07）。`undefined` = 下拉
  // 没渲染（单账号部署 / 拿不到部署账号号）→ 沿用 agent 盖的 `action.account_id`。
  const confirmAction = async (msgId: string, idx: number,
                               editedParams?: Record<string, unknown>,
                               pickedAccount?: string) => {
    // 🔴 真正的去重在这里，不在卡上。卡上的 disabled 只是第一道（而且卡一重挂就丢）；
    //    `action.done` 要等下面 await 回来才置上，那段窗口里第二次点击会**再发一次真的
    //    写请求** —— 建案 = 两个案例、回复 = 两条回复，而界面只留后一次的结果。
    //    用 ref 而不是 state：state 更新是异步的，挡不住同一个 tick 里的第二次点击。
    const inflightKey = `${msgId}#${idx}`;
    if (execingRef.current.has(inflightKey)) return;
    const conv = conversations.find((c) => c.messages.some((m) => m.id === msgId));
    const convId = conv?.id ?? activeId;
    const msg = conv?.messages.find((m) => m.id === msgId);
    const action = msg?.actions?.[idx];
    if (!action || action.done) return;
    execingRef.current.add(inflightKey);
    // create_case_form(可编辑) / create_case_review(只读预览) → 都转成 create_case 执行。
    // 关键：必须带上 action.account_id —— 否则跨账号(linked account)建案会丢目标账号，
    // BFF 回退到部署账号,case 误落到部署账号(而非用户选中的账号)。见 support.mjs 的
    // supportClientFor(缺省=部署账号)。account_id 由 agent _propose 按本轮 _acct() 写入。
    // 🔴 客户在下拉里选的账号**优先于** agent 盖的那个章 —— 那个下拉存在的全部理由
    //    就是让客户能改这一项。空串是合法值（= 部署账号），所以判据是
    //    `!== undefined` 而不是 `||`：用 `||` 会把"客户明确选了部署账号"错当成
    //    "没选"，从而落回 agent 的章。
    //    ⚠️ 后端对这个值做**可见性校验**（BFF `accountCandidates` 里的
    //       `body.action.account_id`）+ 数据层拿不到跨账号凭证就返回 null 而不是
    //       回落到部署账号（`support.mjs::supportClientFor`）。前端这一层只负责传对。
    const toExec = (action.type === "create_case_form" || action.type === "create_case_review")
      ? { type: "create_case" as const, params: editedParams ?? action.params,
          account_id: pickedAccount !== undefined ? pickedAccount : action.account_id }
      : action;
    try {
      const result = await executeActionApi(toExec);
      patchMsgIn(convId, msgId, {
        actions: (msg?.actions ?? []).map((a, i) => (i === idx ? { ...a, done: true, params: editedParams ?? a.params, result } : a)),
      });
    } finally {
      // finally 而不是写在 await 后面：executeActionApi 目前自己兜住了所有异常，但
      // 一旦它哪天会抛，漏了 finally 就把这张卡永久锁死（done 也没置上）。
      execingRef.current.delete(inflightKey);
    }
  };
  const cancelAction = (msgId: string, idx: number) => {
    // 正在执行的写操作不许被"取消"盖掉 —— 那会在一次**已经发出去**的建案上画
    // 「未执行：已取消」，用户于是不去控制台看，而案例真的开了。取消只能在发出前生效。
    if (execingRef.current.has(`${msgId}#${idx}`)) return;
    const conv = conversations.find((c) => c.messages.some((m) => m.id === msgId));
    const convId = conv?.id ?? activeId;
    const msg = conv?.messages.find((m) => m.id === msgId);
    patchMsgIn(convId, msgId, {
      actions: (msg?.actions ?? []).map((a, i) => (i === idx ? { ...a, done: true, result: { ok: false, message: "已取消" } } : a)),
    });
  };

  const doSignOut = async () => { try { await signOut(); } catch { /* ignore */ } onSignOut(); };

  // 切换会话：离开当前**空且未持久化**的会话时自动丢弃（避免堆一堆空 New chat）。
  // 判定"空"：无消息；"未持久化"：后端没拉过它(loadedRef 没有) —— 即本地新建、从没发过消息。
  // 可丢弃 = 无消息 且 未持久化（本地新建、从没发过消息、也不在后端列表）
  const isThrowaway = (c: Conversation | undefined) =>
    !!c && c.messages.length === 0 && !persistedRef.current.has(c.id);

  // 移动端（≤768px）侧栏是覆盖式抽屉：选中会话/主题后自动收起，露出聊天页 —— 单击即达。
  // 否则抽屉仍盖在内容上，看起来"没打开"，要再点一次（点到遮罩）才关闭，体验差。
  const isMobile = () => {
    try { return window.matchMedia("(max-width: 768px)").matches; } catch { return false; }
  };
  const collapseIfMobile = () => { if (isMobile()) setCollapsed(true); };

  const switchTo = (id: string) => {
    collapseIfMobile(); // 移动端：无论是否切换都收起抽屉，露出选中的会话
    setView("chat");    // 从 Customize 页点回某个会话 → 回到聊天视图
    // 进入该会话 → 清除它的「未读」红点（客户已看到结果）。
    if (unreadIds.has(id)) setUnreadIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    if (id === activeId && view === "chat") return;
    const prevId = activeId;
    setConversations((prev) => {
      const leaving = prev.find((c) => c.id === prevId);
      return isThrowaway(leaving) ? prev.filter((c) => c.id !== prevId) : prev;
    });
    setActiveId(id);
  };

  const newConv = (topic: TopicKey = "general") => {
    collapseIfMobile(); // 移动端：点主题/New chat 后收起抽屉，直接进新会话页
    setView("chat");    // 新建对话 → 回到聊天视图
    // 新建前也先丢弃当前空会话（点了主题/New chat 又点别的，不留空壳）
    const c = emptyConversation(locale, topic);
    setConversations((prev) => {
      const leaving = prev.find((x) => x.id === activeId);
      const base = isThrowaway(leaving) ? prev.filter((x) => x.id !== activeId) : prev;
      return [c, ...base];
    });
    setActiveId(c.id);
  };

  // What's New：进入 AWS 新发布学习空间。只新建 whats-new 主题空会话（默认开联网搜索），
  // **不自动拉取**——由空态的推荐 prompt chips 让客户自己选（更干净、不打扰、不浪费）。
  const openWhatsNew = () => {
    collapseIfMobile();
    setView("chat");
    const c: Conversation = { ...emptyConversation(locale, "whats-new"), webSearch: true };
    setConversations((prev) => {
      const leaving = prev.find((x) => x.id === activeId);
      const base = isThrowaway(leaving) ? prev.filter((x) => x.id !== activeId) : prev;
      return [c, ...base];
    });
    setActiveId(c.id);
  };

  // 通知卡「深入调查」：起一个「故障调查」会话，把事件的 dispatch_query 作为首条消息自动发出。
  // 「就此提问」：起普通会话问技术解释。
  // ⚠️ 深度调查开关**不在这里默认打开**，由调用方通过 convPatch 显式带进来
  // （`...deepDiveTogglesFor(topic)`，见 types.ts）。事件卡的 dispatch_query 本来就是后端
  // 给 DevOps Agent 写的调查描述，所以那类入口必须带；而 landing Composer 等入口发起的
  // 普通提问不该被强行升级成深度调查。此处一度写着"默认开 DevOps Agent"，但代码从未设置过
  // 任何一个开关 —— 于是从「通知 → 事件通知」点「深入调查」，Composer 里
  // 「深度调查（直连）」是没勾的，那一轮实际走的是普通问答。
  // skillId：从 landing/主题起始页的 Composer 用 `/` 选中 skill 发起**新会话第一句**时透传，
  // 否则起始页发起的调查会丢掉 skill（Composer.onSend 的第二参数）——见 handleSend 透传。
  const startFromNotification = (query: string, topic: TopicKey, convPatch?: Partial<Conversation>, skillId?: string) => {
    collapseIfMobile();
    setView("chat");
    // 新会话继承当前选中的账号(landing 上的账号选择器);convPatch 显式给了 accountId 则以它为准。
    // 否则从 landing Composer 发起的调查会丢掉跨账号选择 → agent 用默认凭据返回部署账号数据。
    // 用 accountIdRef.current(最新值)而非闭包 accountId,避免选账号后立即发送时读到 stale 值。
    const inheritedAccount = convPatch && "accountId" in convPatch ? {} : { accountId: accountIdRef.current };
    // 新会话继承该主题 landing 上选的模型（lm 的草稿），否则从 landing / 仪表盘卡片发起的会话
    // 会被 emptyConversation 重置成管理员默认模型 —— 用户选的 Grok 4.6 等于白选，且是**静默**
    // 用错模型。放在这里统一兜底，所有入口（landing Composer、通知卡、各仪表盘的
    // 「深入调查 / 就此提问」）一次覆盖；调用方显式给 model 时以调用方为准。
    const inheritedModel = convPatch && "model" in convPatch ? {} : { model: lm(topic) };
    const c = { ...emptyConversation(locale, topic), ...inheritedAccount, ...inheritedModel, ...(convPatch || {}) };
    // 先丢弃当前 throwaway 空会话 + 切到新会话;新会话的**插入交给 handleSend 的 upsert**
    // (它带 target 兜底,不依赖本次 setConversations 是否已 flush)——避免时序竞态导致
    // "有时点了没反应"。这里只处理 throwaway 清理 + activeId,不预插 c(否则可能双插)。
    setConversations((prev) => {
      const leaving = prev.find((x) => x.id === activeId);
      return isThrowaway(leaving) ? prev.filter((x) => x.id !== activeId) : prev;
    });
    setActiveId(c.id);
    // 直接调 handleSend(不用 setTimeout):它内部 upsert 会把 c 插进列表并追加消息。
    handleSend(query, skillId, c);
  };

  const renameConv = (id: string, title: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    void renameConversationApi(id, title); // 持久化重命名
  };
  const togglePin = (id: string) => {
    let next = false;
    setConversations((prev) => prev.map((c) => {
      if (c.id === id) { next = !c.pinned; return { ...c, pinned: next }; }
      return c;
    }));
    void setPinnedApi(id, next); // 持久化置顶（刷新后保留）
  };
  const deleteConv = (id: string) => {
    void deleteConversationApi(id); // 后端立即删除（含消息）
    loadedRef.current.delete(id);
    forgetConvMode(id);             // 连它记住的回答模式一起清掉，别留孤儿条目

    if (unreadIds.has(id)) setUnreadIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      const list = next.length ? next : [emptyConversation(locale)];
      if (id === activeId) setActiveId(list[0].id);
      return list;
    });
  };

  // 从仪表盘返回。`dashReturn` 记的是"从哪儿进来的"（输入框上方的仪表盘胶囊会写它）。
  // 没有值 = 走侧栏进的看板，本来就没有"上一步"，调用方不会渲染返回按钮。
  // ⚠️ 不要改成 switchTo()：见 dashReturn 声明处那段注释（会回不到主题主页 + 删空会话）。
  // ⚠️ 四棵看板树的"当前页"全在这里清。漏一棵的后果是静默的：返回后 view 变了但那棵树的
  //    dash state 还留着，下次点它的胶囊会直接落在上次那一页上（而不是胶囊指定的首页）。
  const backFromDash = () => {
    const back = dashReturn;
    setDashReturn(null);
    setSecurityDash(null);
    setInvestigateDash(null);
    setFinopsDash(null);
    setCasesDash(null);
    if (back) setView(back);
  };

  // 输入框上方那排「仪表盘」胶囊。刻意**粗粒度**：一颗 = 一整棵看板树的入口，
  // 点进去才是原来那棵树（告警总览 / 当前告警 / 最近变更 / Backup 健康；TA 安全检查 /
  // Security Hub / 安全公告 / GuardDuty；成本各页；案例各页）。以后往树里加面板不用动
  // 这里 —— 否则每加一个面板输入框上方就多一颗胶囊，很快就挤爆一行。
  //
  // 2026-09-11：成本 / 案例两个主题原来走的是另一套入口（紧贴输入框左上角那个
  // 「打开 Dashboard」标签，Composer 的 `onOpenDashboard` prop + `.cbox-tab`），
  // 现在统一到这一行；那条 prop 与它的三条 CSS 已删。有看板的主题**只有这一套入口**。
  //
  // 门禁与侧栏**逐字一致**，否则会出现"侧栏没有这个入口、输入框上方却有"这种矛盾：
  //   - 运行概览：`!capsLoaded || can("nav:investigate")` —— fail-open（能力没加载完先给）
  //   - 支出与优化：`!capsLoaded || can("nav:finops")`      —— 同 fail-open
  //   - 案例进展：`!capsLoaded || can("nav:cases")`       —— 同 fail-open
  //   - 安全态势：`isAdmin || (capsLoaded && can("nav:security"))` —— fail-closed
  // ⚠️ 安全这颗是**唯一没有侧栏兄弟**的：2026-09-11 起「安全」不在侧栏里了（产品要求），
  //    它的看板只能从这颗胶囊进。所以那条门禁表达式在本文件里只出现一次，不再是两次。
  // nav:security 是管理员可关的模块（level:"tab"），关掉时必须**整颗不渲染**，
  // 不能渲染成 disabled —— 那等于告诉客户"这里有个功能，只是你不能用"。
  const dashPillsFor = (topicKey: TopicKey) => {
    const pills: { key: string; label: string; Icon: React.FC<{ size?: number }>; onClick: () => void }[] = [];
    // go() 会记下 dashReturn = 当前视图，这样看板里的「返回」知道该回哪儿：
    // 从主题主页进 → 回主题主页；从会话里进 → 回那条会话。
    const go = (v: ViewKey, open: () => void) => () => {
      setDashReturn(view);
      open();
      setSrcOpen(false);
      setThinkOpen(false);
      setView(v);
      collapseIfMobile();
    };
    if (topicKey === "investigate") {
      if (!capsLoaded || can("nav:investigate")) {
        pills.push({ key: "ops", label: t("dash.pill.ops"), Icon: IconInvestigate,
          onClick: go("investigate", () => setInvestigateDash("alarm-overview")) });
      }
      if (isAdmin || (capsLoaded && can("nav:security"))) {
        pills.push({ key: "security", label: t("dash.pill.security"), Icon: IconSecurity,
          onClick: go("security", () => setSecurityDash("ta-security")) });
      }
    } else if (topicKey === "finops") {
      if (!capsLoaded || can("nav:finops")) {
        pills.push({ key: "cost", label: t("dash.pill.cost"), Icon: IconFinOps,
          onClick: go("finops", () => setFinopsDash("spend")) });
      }
    } else if (topicKey === "cases") {
      if (!capsLoaded || can("nav:cases")) {
        pills.push({ key: "cases", label: t("dash.pill.cases"), Icon: IconCases,
          onClick: go("cases", () => setCasesDash("overview")) });
      }
    }
    // 其余主题（通用 / What's new）没有看板 → undefined，Composer 里
    // `!!dashPills?.length` 直接不渲染那一行（返回空数组会渲染出一行只有「仪表盘」
    // 三个字、后面什么都没有的空标签）。
    return pills.length ? pills : undefined;
  };

  // 主题空态主页（统一设计）：脉冲 N hero + 主题标题 + 每主题随机 4 卡（点=填入 composer）
  //   + 底部 composer（发起该主题新会话）。
  // 与通用主页同一套 .empty-center.home 视觉；主题各自的 prompt 池 / 标题来自 TOPIC_LANDING。
  // ⚠️ 看板入口**不在这里**：统一走输入框上方 dashPillsFor() 那排粗粒度胶囊（每个主题该有
  //    哪几颗、门禁怎么写都在那个函数里）。2026-09-11 之前这里还有第二个参数 openDash，
  //    成本 / 案例走它渲染成「打开 Dashboard」标签 —— 已删，别再加回来：同一位置两套入口。
  const renderThemeLanding = (topicKey: TopicKey) => {
    const cfg = TOPIC_LANDING[topicKey];
    const cards = themeCards(topicKey);
    return (
      <div className="empty-center home">
        <div className="home-hero">
          <div className="home-logo"><Logo size={104} variant="hero" /></div>
          <div className="home-headline">{t(cfg.headlineKey)}</div>
          <div className="home-cards">
            {cards.map((c) => {
              const desc = t(c.promptKey);
              return (
                <button key={c.key} type="button" className="home-card"
                  onClick={() => fillThemePrefill(topicKey, desc)}>
                  <span className="hc-ic"><c.Icon size={18} /></span>
                  <span className="hc-desc">{desc}</span>
                </button>
              );
            })}
          </div>
        </div>
        {/* 三个 DevOps 开关在 landing 也是**单选**（与会话内 setDevopsMode 同口径）：
            点亮一个必须显式把另两个置 false，否则草稿会带着两个开关进新会话、后端同时收到两个 flag。 */}
        <Composer model={lm(topicKey)} onModelChange={(id) => setLm(topicKey, id)}
          onSend={(text, skillId) => startFromNotification(text, topicKey, { ...lt(topicKey), accountId: dashAccountId }, skillId)}
          busy={false} /* landing 是发起新会话入口,永远可发送 */ showSuggestions={false} prefill={themePrefill[topicKey]}
          webSearch={lt(topicKey).webSearch ?? false} onToggleWebSearch={() => setLt(topicKey, { webSearch: !(lt(topicKey).webSearch ?? false) })}
          finopsAgent={lt(topicKey).finopsAgent ?? false} onToggleFinopsAgent={() => setLt(topicKey, { finopsAgent: !(lt(topicKey).finopsAgent ?? false) })}
          devopsAgent={lt(topicKey).devopsAgent ?? false} onToggleDevopsAgent={() => setLt(topicKey, { devopsAgent: !(lt(topicKey).devopsAgent ?? false), devopsAgentDirect: false, devopsChat: false })}
          devopsAgentDirect={lt(topicKey).devopsAgentDirect ?? false} onToggleDevopsAgentDirect={() => setLt(topicKey, { devopsAgentDirect: !(lt(topicKey).devopsAgentDirect ?? false), devopsAgent: false, devopsChat: false })}
          devopsChat={lt(topicKey).devopsChat ?? false} onToggleDevopsChat={() => setLt(topicKey, { devopsChat: !(lt(topicKey).devopsChat ?? false), devopsAgent: false, devopsAgentDirect: false })}
          onStop={stopGen} topic={topicKey} dashPills={dashPillsFor(topicKey)}
          convKey={"landing:" + topicKey} accountId={dashAccountId}
          onManageSkills={() => { setView("skills"); collapseIfMobile(); }} />
      </div>
    );
  };

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        busyIds={busyIds}
        unreadIds={unreadIds}
        onSelect={switchTo}
        onNew={newConv}
        onRename={renameConv}
        onTogglePin={togglePin}
        onDelete={deleteConv}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        username={username}
        onSignOut={doSignOut}
        width={sidebarWidth}
        onSkills={() => { setView("skills"); setSkillsHome((n) => n + 1); collapseIfMobile(); }}
        onCustomize={() => { setView("customize"); collapseIfMobile(); }}
        onWhatsNew={openWhatsNew}
        onNotifications={() => { setView("notifications"); collapseIfMobile(); }}
        skillsActive={view === "skills"}
        customizeActive={view === "customize"}
        notificationsActive={view === "notifications"}
        notifUnread={notifUnread}
        onFinops={() => { setFinopsDash(null); setView("finops"); collapseIfMobile(); }}
        finopsActive={view === "finops"}
        onCases={() => { setCasesDash(null); setView("cases"); collapseIfMobile(); }}
        casesActive={view === "cases"}
        // ⚠️ 这里**没有** onSecurity / securityActive / showSecurity —— 2026-09-11 产品要求
        // 侧栏去掉「安全」这一项，Sidebar 那三条 prop 也一起删了。安全看板的唯一入口是
        // 「调查」输入框上方的「安全态势」胶囊（dashPillsFor）。
        //
        // 侧栏进来 = 没有"上一步"，必须清 dashReturn，否则上一次从胶囊进看板留下的值
        // 会让返回按钮继续挂着，点一下把人送回一个他并不是从那儿来的地方。
        onInvestigate={() => { setDashReturn(null); setInvestigateDash(null); setView("investigate"); collapseIfMobile(); }}
        investigateActive={view === "investigate"}
        onInspection={() => { setInspectionDash(null); setView("inspection"); collapseIfMobile(); }}
        inspectionActive={view === "inspection"}
        onAdmin={() => { setView("admin"); collapseIfMobile(); }}
        adminActive={view === "admin"}
        showFinops={!capsLoaded || can("nav:finops")}
        showCases={!capsLoaded || can("nav:cases")}
        showAdmin={isAdmin || (capsLoaded && can("nav:admin"))}
        showNotifications={!capsLoaded || can("nav:notifications")}
        showInvestigation={!capsLoaded || can("nav:investigate")}
        showInspection={showInspectionNav}
        showSkills={!capsLoaded || can("nav:skills")}
        showCustomize={!capsLoaded || can("nav:customize")}
      />
      {/* 可拖拽分割线：调节侧边栏宽度（仅桌面、侧栏展开时显示；移动端 CSS 隐藏）*/}
      {!collapsed && <div className="resize-handle" onMouseDown={startResize} title="拖动调整宽度" />}
      {/* 移动端：侧栏作为覆盖式抽屉打开时的背景遮罩，点击关闭 */}
      {!collapsed && <div className="sidebar-backdrop" onClick={() => setCollapsed(true)} />}
      <main className={"main" + (view === "chat" && showLanding ? " empty" : "")}>
        <ErrorBoundary key={view} label={view}>
        {view === "notifications" ? (
          <>
            <div className="topbar">
              {collapsed && (
                <button className="panel-btn topbar-expand" onClick={() => setCollapsed(false)}><ExpandIcon /></button>
              )}
              <div className="title">{t("notif.title")}</div>{dashAcctPickerRight}
            </div>
            <NotificationsPanel
              // 事件卡的「深入调查」（opts.deep）→ 新会话直接开「深度调查（直连）」，
              // 因为它发的正文就是后端给 DevOps Agent 备好的 dispatch_query。
              onInvestigate={(query, _title, opts) => startFromNotification(query, "investigate", {
                accountId: dashAccountId,
                ...(opts?.deep ? deepDiveTogglesFor("investigate") : {}),
              })}
              onAsk={(query) => startFromNotification(query, "general")}
              onLoaded={() => setNotifUnread(0)}
              can={can}
              accountId={dashAccountId}
              accounts={accounts}
              onAccountChange={setDashAccountId}
            />
          </>
        ) : view === "finops" && finopsDash ? (
          /* 仪表盘两栏浏览器(仿通知主题:左列表+右内容);从缩略卡点进来 */
          <>
            <div className="topbar">
              {collapsed && (
                <button className="panel-btn topbar-expand" onClick={() => setCollapsed(false)}><ExpandIcon /></button>
              )}
              {/* 走 backFromDash（不是裸 setFinopsDash(null)）：2026-09-11 起这棵树只能从
                  输入框上方的「支出与优化」胶囊进，而胶囊会记下 dashReturn —— 从会话里点进来的
                  就该回那条会话，裸清 dash 只会把人扔到成本主页上。 */}
              <button className="dash-back" onClick={backFromDash}
                title={dashReturn === "chat"
                  ? (locale === "en" ? "Back to chat" : "返回对话")
                  : (locale === "en" ? "Back to Cost" : "返回成本主页")}>← {locale === "en" ? "Back" : "返回"}</button>
              <div className="title">{t("topic.cost")} · {locale === "en" ? "Dashboards" : "仪表盘"}</div>{dashAcctPickerRight}{finopsBadge}
            </div>
            <FinopsDashboardBrowser data={finopsData ?? undefined} initial={finopsDash}
              can={can} hasCapNode={hasCapNode} accountId={dashAccountId}
              onAsk={(q) => { setFinopsDash(null); startFromNotification(q, "finops"); }} />
          </>
        ) : view === "finops" ? (
          <>
            <div className="topbar">
              {collapsed && (
                <button className="panel-btn topbar-expand" onClick={() => setCollapsed(false)}><ExpandIcon /></button>
              )}
              <div className="title">{t("topic.cost")}</div>{dashAcctPickerRight}{finopsBadge}
            </div>
            {/* 看板入口走输入框上方的「支出与优化」胶囊（dashPillsFor）*/}
            {renderThemeLanding("finops")}
          </>
        ) : view === "cases" && casesDash ? (
          /* 案例仪表盘两栏浏览器(仿通知/成本主题) */
          <>
            <div className="topbar">
              {collapsed && (
                <button className="panel-btn topbar-expand" onClick={() => setCollapsed(false)}><ExpandIcon /></button>
              )}
              {/* 同上：走 backFromDash，别退回裸 setCasesDash(null)。 */}
              <button className="dash-back" onClick={backFromDash}
                title={dashReturn === "chat"
                  ? (locale === "en" ? "Back to chat" : "返回对话")
                  : (locale === "en" ? "Back to Cases" : "返回案例主页")}>← {locale === "en" ? "Back" : "返回"}</button>
              <div className="title">{t("topic.cases")} · {locale === "en" ? "Dashboards" : "仪表盘"}</div>{dashAcctPickerRight}
            </div>
            <CasesDashboardBrowser data={casesData ?? undefined} initial={casesDash}
              onAsk={(q) => { setCasesDash(null); startFromNotification(q, "cases"); }} />
          </>
        ) : view === "cases" ? (
          <>
            <div className="topbar">
              {collapsed && (
                <button className="panel-btn topbar-expand" onClick={() => setCollapsed(false)}><ExpandIcon /></button>
              )}
              <div className="title">{t("topic.cases")}</div>{dashAcctPickerRight}
            </div>
            {/* 看板入口走输入框上方的「案例进展」胶囊（dashPillsFor）*/}
            {renderThemeLanding("cases")}
          </>
        ) : view === "security" ? (
          /* 安全看板两栏浏览器（左目录 + 右内容）。
             2026-09-11「安全」不再是聊天主题（聊天并入「调查」），所以这里和 view==="inspection"
             一样：**没有主题落地页**，点进来直接是目录，initial 缺省落「TA 安全检查」。
             返回按钮只在 dashReturn 有值时给 —— 那代表用户是从「调查」输入框上方的
             「安全态势」胶囊进来的，回得去；从侧栏直接点进来没有上一步，给了就是死按钮。 */
          <>
            <div className="topbar">
              {collapsed && (
                <button className="panel-btn topbar-expand" onClick={() => setCollapsed(false)}><ExpandIcon /></button>
              )}
              {dashReturn && (
                <button className="dash-back" onClick={backFromDash}
                  title={dashReturn === "chat"
                    ? (locale === "en" ? "Back to chat" : "返回对话")
                    : (locale === "en" ? "Back to Investigation" : "返回调查主页")}>← {locale === "en" ? "Back" : "返回"}</button>
              )}
              <div className="title">{t("topic.security")} · {locale === "en" ? "Dashboards" : "仪表盘"}</div>{dashAcctPickerRight}
            </div>
            {/* 不传 onAccountChange：切账号走顶栏那个 dashAcctPickerRight（唯一入口）。
                看板内部原来那个"组织概览点行下钻"已随缩略卡落地页一起删了。 */}
            <SecurityDashboardBrowser data={securityData ?? undefined} initial={securityDash ?? "ta-security"} can={can}
              accountId={dashAccountId} accounts={accounts}
              onInvestigate={(text) => startFromNotification(text, "investigate", { accountId: dashAccountId })}
              onReload={() => setSecurityData(null)} />
          </>
        ) : view === "investigate" && investigateDash ? (
          /* 调查仪表盘两栏浏览器(仿通知/成本/案例主题:左列表+右内容) */
          <>
            <div className="topbar">
              {collapsed && (
                <button className="panel-btn topbar-expand" onClick={() => setCollapsed(false)}><ExpandIcon /></button>
              )}
              <button className="dash-back" onClick={backFromDash}
                title={dashReturn === "chat"
                  ? (locale === "en" ? "Back to chat" : "返回对话")
                  : (locale === "en" ? "Back to Investigation" : "返回调查主页")}>← {locale === "en" ? "Back" : "返回"}</button>
              <div className="title">{t("topic.investigate")} · {locale === "en" ? "Dashboards" : "仪表盘"}</div>{dashAcctPickerRight}
            </div>
            {/* 不传 accounts / onAccountChange：切账号走顶栏那个 dashAcctPickerRight（唯一入口）。
                看板内部原来那个"组织概览点行下钻"已随缩略卡落地页一起删了。 */}
            <InvestigationDashboardBrowser data={alarmData ?? undefined} initial={investigateDash} can={can}
              accountId={dashAccountId}
              onReload={() => setAlarmData(null)}
              onInvestigate={(q, opts) => startFromNotification(q, "investigate", {
                accountId: dashAccountId,
                ...(opts?.deep ? deepDiveTogglesFor("investigate") : {}),
              })}
              onNotify={(q) => startFromNotification(q, "general", { accountId: dashAccountId })} />
          </>
        ) : view === "investigate" ? (
          <>
            <div className="topbar">
              {collapsed && (
                <button className="panel-btn topbar-expand" onClick={() => setCollapsed(false)}><ExpandIcon /></button>
              )}
              <div className="title">{t("topic.investigate")}</div>{dashAcctPickerRight}
            </div>
            {/* 调查的两个看板走输入框上方的「仪表盘」胶囊（dashPillsFor）*/}
            {renderThemeLanding("investigate")}
          </>
        ) : view === "inspection" ? (
          /* 巡检看板：两栏浏览器（左目录 + 右内容），**没有主题落地页**。
             ⚠️ 其他仪表盘（finops / cases / investigate）走
             `renderThemeLanding` 是因为它们同时是**聊天主题** ——
             （security 也没有：它 2026-09-11 已不是聊天主题，和巡检一样直接进目录）
             落地页的作用是「发起该主题的新会话」。巡检不是聊天主题：
             硬塞一个会让它出现在侧栏的会话分组里，而那里永远是空的
             （`TopicKey` 与会话分组同源，见 types.ts 的 TOPICS）。
             所以直接进目录，`initial` 缺省落总览。 */
          <>
            <div className="topbar">
              {collapsed && (
                <button className="panel-btn topbar-expand" onClick={() => setCollapsed(false)}><ExpandIcon /></button>
              )}
              <div className="title">{t("insp.title")}</div>{dashAcctPickerRight}
            </div>
            <InspectionDashboardBrowser initial={inspectionDash ?? "overview"} can={can}
              accountId={dashAccountId} accounts={accounts} onAccountChange={setDashAccountId}
              onNavigate={setInspectionDash}
              /* 🔴 **这里原来有 `onInvestigate`，2026-08-31 删掉。**

                 巡检的「深入分析」改成了「派一次真的 DA 判读」——
                 结果绑在那条 finding 上（`put_dispatch` 是回拼锚点），
                 不落在任何一个聊天会话里。所以它不需要宿主给回调，
                 实现留在 `InspectionDashboard` 内的 `doJudge`。

                 ⚠️ 顺带解决了这一行原本的缺陷：它以前不给账号 ⇒
                    `startFromNotification` 继承**聊天页选择器**的账号 ⇒
                    点 677 的 finding、DA 在 698 里分析 698 的同名资源，
                    给出一份看起来完全正常的报告。零错误码、零提示。
                    现在判读走 executor，每个账号自己 assume。 */ />
          </>
        ) : view === "skills" || view === "customize" ? (
          <>
            <div className="topbar">
              {collapsed && (
                <button className="panel-btn topbar-expand" onClick={() => setCollapsed(false)}><ExpandIcon /></button>
              )}
              <div className="title">{view === "skills" ? t("cz.nav.skills") : t("nav.customize")}</div>
            </div>
            <CustomizePanel only={view === "skills" ? "skills" : undefined} homeSignal={skillsHome} />
          </>
        ) : view === "admin" ? (
          <>
            <div className="topbar">
              {collapsed && (
                <button className="panel-btn topbar-expand" onClick={() => setCollapsed(false)}><ExpandIcon /></button>
              )}
              <div className="title">{t("nav.admin")}</div>
            </div>
            <AdminPanel />
          </>
        ) : (
        <>
        {/* 空对话态：无标题（标题无意义），但多账号可用时显示账号选择器 —— 让"新对话"
            也能在发消息前选定目标账号（选择写入当前会话，发送时随会话带上）。
            无成员账号时 headerAcctPicker 为 null，退回原来的"仅悬浮展开钮"。
            水合中用 showLanding（而非 isEmpty）：会话标题在列表接口里就有，拉历史时
            直接显示真实标题栏，避免"标题栏先空后有"的第二次跳动。 */}
        {/* `!starops` 与下面会话态那一处同源：对象已经切到阿里云 STAROps 时，右上角那个
            **AWS** 账号下拉一并撤掉 —— 发第一条消息前就切好对象是常见路径，只在会话态藏
            等于"发出去之前还在误导"。 */}
        {showLanding ? (
          ((accounts.length > 0 && !starops) || collapsed) ? (
            <div className="topbar">
              {collapsed && (
                <button className="panel-btn topbar-expand" onClick={() => setCollapsed(false)}><ExpandIcon /></button>
              )}
              {accounts.length > 0 && !starops && (
                <div className="title" style={{ color: "var(--muted)", fontWeight: 600, fontSize: 13, marginLeft: "auto", display: "inline-flex", alignItems: "center" }}>
                  {locale === "en" ? "Account" : "账号"}{headerAcctPicker}
                </div>
              )}
            </div>
          ) : null
        ) : (
          <div className="topbar">
            {collapsed && (
              <button className="panel-btn topbar-expand" onClick={() => setCollapsed(false)}><ExpandIcon /></button>
            )}
            <div className="title">{active.title}</div>
            {/* 主题 tag：与侧边栏一致，收起侧栏时也能看清当前会话主题 */}
            {(() => {
              const td = topicDef(active.topic);
              if (!td) return null;
              const TopicIcon = TOPBAR_TOPIC_ICON[td.key];
              return (
                <span className="topbar-topic" style={{ color: td.color, borderColor: td.color }}>
                  {TopicIcon && <TopicIcon size={13} />}{t(td.labelKey)}
                </span>
              );
            })()}
            {/* 「对话对象」tag（只有通用会话有）：通用会话没有主题 tag（topicDef("general")=null），
                而"谁在答"恰恰是这类会话唯一会变的东西 —— 翻回一个旧会话时靠它一眼认出这段是
                NotiOps 答的还是客户自己的 DevOps Agent 答的。输入框上方那条身份条已按产品要求
                去掉，所以锁定之后**只剩这个 tag** 承担身份说明。
                ⚠️ 水合中（历史还没到）不渲染：devopsChat / starops 都不落库，锁是靠历史里的
                via="devops-agent" / via="starops" 恢复的（见上面的 relock），历史到达前渲染出来
                必然是 "NotiOps" —— 对一段 DevOps / STAROps 会话就是**标错**，比不标更糟。
                STAROps 排在最前，与 modeOf / BFF 的一选一同序。
                STAROps 那枚用 --link（深色 #5aa7ff / 浅色 #006ce0）而不是 --blue：--blue 是
                品牌蓝、只有一个值，在近黑背景上暗到接近正文色；--ok 那一枚已被 DevOps 占了，
                两个对象必须一眼能分开。 */}
            {(active.topic ?? "general") === "general" && !hydratingIds.has(active.id) && (
              starops ? (
                <span className="topbar-topic" style={{ color: "var(--link)" }} title={t("obj.tag.starops.hint")}>
                  <IconCloud size={13} />{t("obj.tag.starops")}
                </span>
              ) : devopsChat ? (
                <span className="topbar-topic" style={{ color: "var(--ok)" }} title={t("obj.tag.devops.hint")}>
                  <IconInvestigate size={13} />{t("obj.tag.devops")}
                </span>
              ) : (
                <span className="topbar-topic" style={{ color: "var(--orange)" }} title={t("obj.tag.notiops.hint")}>
                  <Logo size={13} />{t("obj.tag.notiops")}
                </span>
              )
            )}
            {/* 会话账号选择器：与 landing 一致的下拉，让用户在会话中也能看到/切换当前账号。
                切换后本会话后续消息即用新账号(每条消息发送时读会话当前 accountId)。
                右上角对齐(仿 AWS 控制台;逻辑不变,仅位置)。多账号可用时才显示。
                ⚠️ STAROps 会话**不显示**：这个下拉是「本会话对着哪个 **AWS** 账号」，而这段对话
                问的是客户自己的**阿里云**数字员工 —— 摆一个选了也不生效的 AWS 账号在右上角，
                客户会以为"这条阿里云结论对应这个 AWS 账号"。与页脚删掉 AWS 账号 ID 是同一件事
                （见 Message.tsx 里的 🔴）：拿不到阿里云账号就**不显示**，不显示错的那个。
                只藏不清值：切回 NotiOps / DevOps 对象时，原来选的账号原样回来。 */}
            {!starops && headerAcctPickerRight}
          </div>
        )}
        {/* 有对话：消息流在上、输入框在下（原布局）。
            空对话：问候语 + 输入框 + 会话列表 全部放进一个 flex 列容器(.empty-center)，
            自然顺序堆叠、整体垂直居中——不用任何写死偏移，任意屏幕相对位置恒定、不重叠。 */}
        {!isEmpty ? (
          <>
            <div className="stream" ref={attachStream}>
              <div className="thread">
                {/* 🔴 历史被截断 —— 与"这个会话本来就这么短"必须能区分开。
                    见上面 relock 那段注释：截断还会顺带丢掉「对话对象」的锁。 */}
                {active.historyTruncated && (
                  <div className="thread-truncated">
                    {locale === "en"
                      ? `Showing the most recent ${active.historyLimit || 0} messages; earlier ones are not loaded.`
                      : `只显示最近 ${active.historyLimit || 0} 条消息，更早的部分未加载。`}
                  </div>
                )}
                {active.messages.map((m) => (
                  <Message key={m.id} m={m} onOpenSources={openSources}
                    onOpenThinking={openThinking}
                    onConfirmAction={(idx, editedParams, acctId) => confirmAction(m.id, idx, editedParams, acctId)}
                    /* 开案例卡的账号下拉数据源。已在挂载时加载好（`getAccountsFull`），
                       Message 那边不再发请求。 */
                    accounts={accounts} deployAccount={deployment.accountId}
                    onCancelAction={(idx) => cancelAction(m.id, idx)}
                    onFollowup={(prompt) => handleSend(prompt)}
                    /* 多账号模式下每条回复都标账号：成员账号=橙，management/部署账号(accountId 空)=蓝。
                       单账号部署(accounts 为空)不显示徽标,避免噪音。
                       **只给 12 位 ID，不给账号名** —— 页脚已合并成一行，账号名在里面最长又最没用
                       （能定位资源、能贴进 case 的是 ID）。极端情况下部署账号 ID 拿不到，才退回名字，
                       否则徽标会整个消失、丢掉"这条回答针对哪个账号"这个信息。 */
                    accountLabel={accounts.length > 0
                      ? (m.accountId
                          || deployment.accountId
                          || deployment.accountName
                          || "Management account")
                      : undefined}
                    accountIsMember={!!m.accountId} />
                ))}
              </div>
            </div>
            <Composer model={model} onModelChange={setModel} onSend={handleSend} busy={busy} showSuggestions={false} webSearch={webSearch} onToggleWebSearch={toggleWebSearch} finopsAgent={finopsAgent} onToggleFinopsAgent={toggleFinopsAgent} devopsAgent={devopsAgent} onToggleDevopsAgent={toggleDevopsAgent} devopsAgentDirect={devopsAgentDirect} onToggleDevopsAgentDirect={toggleDevopsAgentDirect} devopsChat={devopsChat} onToggleDevopsChat={toggleDevopsChat} starops={starops} onStop={stopGen} topic={active.topic ?? "general"} convKey={active.id} accountId={accountId} dashPills={dashPillsFor(active.topic ?? "general")}

              onManageSkills={() => { setView("skills"); collapseIfMobile(); }} />
          </>
        ) : isHydrating ? (
          /* 历史水合中的骨架屏：复用 .stream/.thread/.row 的真实排版（同 max-width、padding、gap），
             所以历史到达时是"灰块换成文字"，布局不位移。行宽写死不随机 —— 用 Math.random 会
             在每次重渲染时跳变。composer 与真实聊天态一致（用户可以直接开始输入）。 */
          <>
            <div className="stream">
              <div className="thread" aria-busy="true">
                <div className="row user"><div className="msg"><div className="sk sk-bubble" /></div></div>
                <div className="row bot"><div className="msg">
                  <div className="sk sk-line" style={{ width: "92%" }} />
                  <div className="sk sk-line" style={{ width: "84%" }} />
                  <div className="sk sk-line" style={{ width: "61%" }} />
                </div></div>
                <div className="row user"><div className="msg"><div className="sk sk-bubble sk-bubble-sm" /></div></div>
                <div className="row bot"><div className="msg">
                  <div className="sk sk-line" style={{ width: "88%" }} />
                  <div className="sk sk-line" style={{ width: "70%" }} />
                </div></div>
              </div>
            </div>
            <Composer model={model} onModelChange={setModel} onSend={handleSend} busy={busy} showSuggestions={false} webSearch={webSearch} onToggleWebSearch={toggleWebSearch} finopsAgent={finopsAgent} onToggleFinopsAgent={toggleFinopsAgent} devopsAgent={devopsAgent} onToggleDevopsAgent={toggleDevopsAgent} devopsAgentDirect={devopsAgentDirect} onToggleDevopsAgentDirect={toggleDevopsAgentDirect} devopsChat={devopsChat} onToggleDevopsChat={toggleDevopsChat} starops={starops} onStop={stopGen} topic={active.topic ?? "general"} convKey={active.id} accountId={accountId} dashPills={dashPillsFor(active.topic ?? "general")}
              onManageSkills={() => { setView("skills"); collapseIfMobile(); }} />
          </>
        ) : (active.topic ?? "general") === "general" ? (
          /* 通用对话主页（Codex 式）：居中 logo + 项目化标题 + 「对话对象」分段控件 + 4 张启动卡片，
             composer 停在下方。
             对话对象（ChatObjectPicker）= 这段对话由谁来答：NotiOps 自己的 agent、客户自己的
             DevOps Agent，还是客户自己在**阿里云**上的 STAROps 数字员工（后两条我们侧都 0 token）。
             **可跳过**：不选直接打字就是 NotiOps（老用户零回归）；
             发出第一句后本会话就固定（锁定后由标题栏的「对话对象」tag 说明谁在答）。
             启动卡片按选中的对象换池子：DevOps Agent 那条路径不做成本/案例/Skills，
             拿 NotiOps 那 4 张引导等于把客户带到答不了的问题上；STAROps 更远 —— 它连
             EC2/RDS/CloudWatch 都看不到，必须用它自己那一组（阿里云资源）。
             卡片点击 = 把代表性 prompt 填入输入框（停留在通用对话，不切主题），用户可再改写后发送。 */
          <div className="empty-center home">
            <div className="home-hero">
              <div className="home-logo"><Logo size={104} variant="hero" /></div>
              <div className="home-headline">{t("home.headline")}</div>
              <ChatObjectPicker devopsChat={devopsChat} starops={starops} accountId={accountId}
                onPick={(obj) => setDevopsMode(obj === "devops" ? "chat" : obj === "starops" ? "starops" : "off")} />
              <div className="home-cards">
                {(starops ? STAROPS_HOME_CARDS : devopsChat ? DEVOPS_HOME_CARDS : homeCards).map((c) => {
                  const desc = t(c.descKey);
                  return (
                    <button key={c.key} type="button" className="home-card"
                      onClick={() => fillHomePrefill(active.id, desc)}>
                      <span className="hc-ic"><c.Icon size={18} /></span>
                      <span className="hc-desc">{desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <Composer model={model} onModelChange={setModel} onSend={handleSend} busy={busy} showSuggestions={false} webSearch={webSearch} onToggleWebSearch={toggleWebSearch} finopsAgent={finopsAgent} onToggleFinopsAgent={toggleFinopsAgent} devopsAgent={devopsAgent} onToggleDevopsAgent={toggleDevopsAgent} devopsAgentDirect={devopsAgentDirect} onToggleDevopsAgentDirect={toggleDevopsAgentDirect} devopsChat={devopsChat} onToggleDevopsChat={toggleDevopsChat} starops={starops} onStop={stopGen} topic={active.topic ?? "general"} prefill={homePrefill[active.id]} convKey={active.id} accountId={accountId}
              onManageSkills={() => { setView("skills"); collapseIfMobile(); }} />
          </div>
        ) : (active.topic ?? "general") === "whats-new" ? (
          /* What's New 主页（与通用/主题主页同一套视觉）：脉冲 N logo + 标题 + 每主题独立 prompt 池 4 卡。
             whats-new 是**真实会话**（非 view），故 composer 绑当前会话（handleSend + active 绑定），
             卡片点击=把 prompt 填进输入框（复用 homePrefill）。无 Dashboard（该主题无仪表盘）。 */
          <div className="empty-center home">
            <div className="home-hero">
              <div className="home-logo"><Logo size={104} variant="hero" /></div>
              <div className="home-headline">{t("home.h.whatsnew")}</div>
              <div className="home-cards">
                {themeCards("whats-new").map((c) => {
                  const desc = t(c.promptKey);
                  return (
                    <button key={c.key} type="button" className="home-card"
                      onClick={() => fillHomePrefill(active.id, desc)}>
                      <span className="hc-ic"><c.Icon size={18} /></span>
                      <span className="hc-desc">{desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <Composer model={model} onModelChange={setModel} onSend={handleSend} busy={busy} showSuggestions={false} webSearch={webSearch} onToggleWebSearch={toggleWebSearch} finopsAgent={finopsAgent} onToggleFinopsAgent={toggleFinopsAgent} devopsAgent={devopsAgent} onToggleDevopsAgent={toggleDevopsAgent} devopsAgentDirect={devopsAgentDirect} onToggleDevopsAgentDirect={toggleDevopsAgentDirect} devopsChat={devopsChat} onToggleDevopsChat={toggleDevopsChat} starops={starops} onStop={stopGen} topic={active.topic ?? "general"} prefill={homePrefill[active.id]} convKey={active.id} accountId={accountId}
              onManageSkills={() => { setView("skills"); collapseIfMobile(); }} />
          </div>
        ) : (
          <div className="empty-center">
            <div className="empty-greeting">{greeting(active.topic, locale)}</div>
            <Composer model={model} onModelChange={setModel} onSend={handleSend} busy={busy} showSuggestions={true} webSearch={webSearch} onToggleWebSearch={toggleWebSearch} finopsAgent={finopsAgent} onToggleFinopsAgent={toggleFinopsAgent} devopsAgent={devopsAgent} onToggleDevopsAgent={toggleDevopsAgent} devopsAgentDirect={devopsAgentDirect} onToggleDevopsAgentDirect={toggleDevopsAgentDirect} devopsChat={devopsChat} onToggleDevopsChat={toggleDevopsChat} starops={starops} onStop={stopGen} topic={active.topic ?? "general"} convKey={active.id} accountId={accountId} dashPills={dashPillsFor(active.topic ?? "general")}

              onManageSkills={() => { setView("skills"); collapseIfMobile(); }} />
            {(() => {
              const curTopic = active.topic ?? "general";
              return null; // 用户要求隐藏「该主题下的会话」模块
              const isDefaultTitle = (s: string) => s === "New chat" || s === "新对话";
              const all = conversations
                .filter((c) => c.id !== active.id && (c.topic ?? "general") === curTopic
                  && (c.messages.length > 0 || !isDefaultTitle(c.title)))
                .sort((a, b) => b.updatedAt - a.updatedAt);
              const SHOWN = 5;
              const peers = all.slice(0, SHOWN);
              if (peers.length === 0) return null; // 无历史会话 → 整块不显示（含说明文字）
              return (
                <div className="empty-recents">
                  <div className="empty-recents-h">{t("recents.title")}</div>
                  {peers.map((c) => (
                    <button key={c.id} className="empty-recent-item" onClick={() => switchTo(c.id)}>
                      <span className="eri-title">{c.title}</span>
                      <span className="eri-time">{fmtAgo(c.updatedAt, locale)}</span>
                    </button>
                  ))}
                  {/* #2+#4：两条说明合并成一行、简化；仅有会话列表时才显示 */}
                  <div className="empty-recents-note">
                    {all.length > SHOWN
                      ? t("recents.note.more").replace("{shown}", String(SHOWN))
                      : t("recents.note.basic")}
                  </div>
                </div>
              );
            })()}
          </div>
        )}
        </>
        )}
        </ErrorBoundary>
      </main>
      {/* Sources 面板：右侧停靠、独立、可拖拽调宽（像左侧栏）——不遮挡主区、主区仍可交互。
          桌面用可拖拽分割线；移动端 CSS 里退回覆盖式抽屉。 */}
      {srcOpen && <div className="src-resize" onMouseDown={startSrcResize} title="拖动调整宽度" />}
      <SourcesPanel open={srcOpen} sources={srcItems} width={srcWidth} onClose={() => setSrcOpen(false)} />
      {/* 「思考过程」面板：**所有路径共用这一个**（DevOps Agent 与普通对话的过程展示必须一致 ——
          2026-09-04 客户要求；原来 DevOps 走独立的 InvestigationPanel，标题/图标/脉冲都不一样）。
          与 Sources 同一停靠位（互斥）。手动关会记住"别再自动弹"。 */}
      {thinkOpen && <div className="src-resize" onMouseDown={startSrcResize} title="拖动调整宽度" />}
      <ThinkingPanel open={thinkOpen} steps={thinkSteps} live={thinkLive} consoleUrl={thinkConsoleUrl}
                     width={srcWidth} onClose={closeThinking} />
      {/* FinOps / Cases 仪表盘均改为主区两栏浏览器(见 view==="finops"/"cases" && *Dash 分支),不再用右停靠面板 */}
    </div>
  );
}
