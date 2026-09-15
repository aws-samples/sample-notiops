import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useT, useLocale } from "../i18n";
import { useModelCatalog } from "../models";
// `MODELS` 不再从 types 引入：模型清单已改为运行时从 `/models` 拉取（useModelCatalog），
// types.ts 里那份只剩历史落款用途。main 侧这行原本是 `{ MODELS, topicHasDevopsAgent }`，
// 合并时只保留后者 —— 本文件已无 MODELS 引用，留着会是未使用导入。
import { topicHasDevopsAgent, topicHasDevopsChat } from "../types";
import { getCasesSummary, getDeepInvestigationAvailability } from "../api/chat";
import { listSkills, skillDisplay, isPresetSkill, type Skill } from "../api/skills";
// IconSkill 随「/命令菜单」的两层结构一起去掉了：现在根层直接就是 skill 列表，
// 不再有那条「技能 ▸」父项，所以这个图标已无处使用（留着 tsc 会报未使用导入）。
// IconChatBubble 随「DevOps 对话」那个平铺 pill 一起搬进了 ModePicker（工具条瘦身），
// 本文件已无引用 —— 留着 tsc 会报未使用导入。
import { IconInvestigate, IconCases, IconFinOps, IconReports, IconGlobe, IconSecurity, IconWhatsNew, IconChevronRight, IconPlus, IconCustomize, skillIcon } from "./icons";
import ModePicker from "./ModePicker";

interface Props {
  model: string;
  onModelChange: (id: string) => void;
  onSend: (text: string, skillId?: string) => void;
  busy: boolean;
  /** 推荐 prompt chips 只在空对话时显示（有消息后悬浮层会挡住回复）。 */
  showSuggestions?: boolean;
  /** 联网搜索开关状态（默认关）。 */
  webSearch?: boolean;
  onToggleWebSearch?: () => void;
  /** FinOps Agent 深度模式开关（默认关；仅 FinOps 主题显示）。 */
  finopsAgent?: boolean;
  onToggleFinopsAgent?: () => void;
  devopsAgent?: boolean;
  onToggleDevopsAgent?: () => void;
  /** 「深度调查（直连）」开关（默认关）：BFF 直连 DevOps Agent API、0 token。与 devopsAgent 互斥。 */
  devopsAgentDirect?: boolean;
  onToggleDevopsAgentDirect?: () => void;
  /** 「DevOps 对话」开关（默认关；**仅故障调查主题**显示这个平铺开关）：BFF 直连 DevOps Agent
   *  控制面 CreateChat/SendMessage，由客户自己的 DevOps Agent 回答、NotiOps 侧 0 token。
   *  与上面两个开关三方互斥（互斥在 ChatApp 侧实现）。
   *  ⚠️ **通用会话不显示这个开关** —— 那里改成新对话主页上的「对话对象」两张卡
   *  （ChatObjectPicker），本字段仍然是同一个状态位，只是入口不同。 */
  devopsChat?: boolean;
  onToggleDevopsChat?: () => void;
  /** 「阿里云 STAROps」对话对象（默认关；**没有任何平铺开关** —— 唯一入口是通用会话新对话
   *  主页的 ChatObjectPicker）。BFF 直连阿里云 CreateChat（SSE），由客户自己的数字员工回答。
   *
   *  ⚠️ 这里之所以**必须**传进 Composer（虽然没有开关要画）：它和 `devopsChat` 一样会让
   *     模型选择器 / 联网搜索 / ModePicker / 模型目录门禁**全部失去意义**。不传的后果不是
   *     "少一个开关"，而是界面上摆着一个"当前模型 Sonnet 5"、而答话的是阿里云的数字员工 ——
   *     纯粹的假信息；并且管理员没勾任何 Bedrock 模型时，这条根本不需要模型的路径会发不出去。 */
  starops?: boolean;
  /** 停止当前会话正在进行的生成。 */
  onStop?: () => void;
  /** 当前会话主题，用于切换专属推荐 prompt。 */
  topic?: string;
  /** 外部预填输入框（如通用主页的启动卡片点击）。seq 变化即触发一次填入 + 聚焦。 */
  prefill?: { text: string; seq: number };
  /** 多账号：已注册账号 + 当前选择（空=部署账号）+ 切换。 */
  /** 本会话/本页当前选中的账号（空=部署账号）。用于判断「深度调查」在该账号上是否可用。 */
  accountId?: string;
  /** 跳转到 Skills 管理页（Customize → Skills）。 */
  onManageSkills?: () => void;
  /**
   * 输入框上方那行**粗粒度**仪表盘入口（每项 = 一整棵看板树的入口，不是某一页）。
   * 有看板的主题全走这一条：调查（运行概览 / 安全态势）、成本（支出与优化）、案例（案例进展）。
   *
   * ⚠️ 粗粒度是**刻意**的：这里只给"运行概览 / 安全态势 / 支出与优化 / 案例进展"这一层描述，
   *    点进去才是现在那棵树状结构（告警总览 / TA 安全检查 / 成本总览 / 案例总览 …）。细节
   *    以后往树里加，不往这行加 —— 这行是导航，不是目录。
   *
   * ⚠️ 四个名字**故意不共用同一个词尾**，改名口径见 `i18n.ts` 的 `dash.pill.*`：第一版四个
   *    都叫「XX 态势」，客户明确指出三个是硬套（`Case posture` 在英文里不成立），只有安全
   *    保留 posture。别为了"看起来整齐"再统一回去。
   *
   * ⚠️ 2026-09-11：原来还有一条 `onOpenDashboard` prop（紧贴输入框左上角、与 `.cbox` 连成
   *    一体的「打开 Dashboard」标签，`.cbox-tab`），成本 / 案例两个主题在用。已删 —— 同一个
   *    位置上两套长得不一样的"仪表盘入口"，客户要在两种交互之间来回适应，而且那个标签名
   *    （"打开 Dashboard"）根本没说清进去是什么。要复活的话 styles.css 里那三条也一起删了。
   */
  dashPills?: { key: string; label: string; Icon: ComponentType<{ size?: number }>; onClick: () => void }[];
  /** 当前会话 id：用于隔离「未发送草稿」。同一 Composer 实例在切会话时不卸载，
   *  故内部 text 会跨会话泄漏（bug）。传了 convKey 后按会话各存各的草稿，切走保存、切回恢复。 */
  convKey?: string;
}


// ⚠️ 加了 Props 字段就**必须**在下面这行解构里也加上 —— 漏了不会有任何 TypeScript 报错，
//    props 会被静默丢弃（现成的例子：`finopsAgent` / `onToggleFinopsAgent` 在 Props 里、
//    六个调用点都传了，但从没解构出来，于是那个开关永远不显示）。
export default function Composer({ model, onModelChange, onSend, busy, showSuggestions = true, webSearch = false, onToggleWebSearch, devopsAgent = false, onToggleDevopsAgent, devopsAgentDirect = false, onToggleDevopsAgentDirect, devopsChat = false, onToggleDevopsChat, starops = false, onStop, topic = "general", prefill, onManageSkills, dashPills, convKey, accountId = "" }: Props) {
  const t = useT();
  const { locale } = useLocale();
  const [text, setText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  // 模型菜单弹出方向:默认向上(bottom:54px);但 composer 在页面靠上时(如成本/案例主题
  // 带仪表盘,输入框顶在上方),向上弹会被视口顶部裁掉。点开时测一下上方空间,不够就向下弹。
  const [menuDropUp, setMenuDropUp] = useState(true);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const selRef = useRef<HTMLDivElement>(null);
  // 未发送草稿按会话隔离(见 convKey prop)：ref 存各会话草稿(不触发渲染) + 追踪上一个会话 key。
  const draftsRef = useRef<Record<string, string>>({});
  const prevConvKeyRef = useRef<string | undefined>(convKey);

  // Skills：显式 /skill 调用。点 "/" 按钮或手输 "/" → 弹命令菜单；选中后挂一个"激活 skill"芯片，
  // 发送时把 skill_id 一并传给 onSend（→ streamChat → BFF → agent 强注入该 skill）。
  const [skills, setSkills] = useState<Skill[]>([]);
  const [activeSkill, setActiveSkill] = useState<Skill | null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  // 键盘高亮行（↑/↓ 移动、Enter 选中）。列表现在可能很长且要滚动，光靠鼠标不够用。
  const [slashIdx, setSlashIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listSkills().then(setSkills).catch(() => {}); }, []);
  // 当输入恰为 "/..." 且无空格时，视为正在挑命令。text==="/" 为根层（列全部），"/xxx" 为过滤层。
  const slashQuery = (!activeSkill && text.startsWith("/") && !text.includes(" ")) ? text.slice(1).toLowerCase() : null;
  const slashRoot = slashQuery === "";   // 恰为 "/" → 列出全部 skill
  const slashMatches = useMemo(() => (slashQuery
    ? skills.filter((s) => s.skill_id.toLowerCase().includes(slashQuery) || s.name.toLowerCase().includes(slashQuery))
    : []), [skills, slashQuery]);
  // 菜单里那份列表：根层 = **全部** skill（不截断、不抽样，超出高度由 .cmd-list 自己滚动）；
  // 过滤层 = 全部匹配项（同样不截断 —— 以前 slice(0,8) 会把第 9 个匹配静默藏掉）。
  const slashList = slashRoot ? skills : slashMatches;
  // 只要在挑命令就弹（含"一个 skill 都没有""一个都没匹配上"两种空态）：菜单里还有「管理/新建」
  // 两个出口，而且旧行为——打到没匹配就整个菜单消失——会让客户以为自己打错了字，
  // 而不是"确实没有这个 skill"。空态如实写出是哪一种。
  useEffect(() => { setSlashOpen(slashQuery !== null); }, [text, skills.length]); // eslint-disable-line
  // 每次改动查询串都把高亮拉回第一行：留在原位会指向一个已经被过滤掉的 skill。
  useEffect(() => { setSlashIdx(0); }, [slashQuery]);
  // 键盘移动时把高亮行滚进可视区（列表最多 ~7 行高，第 8 个之后必须靠滚）。
  // jsdom 没实现 scrollIntoView → 可选调用，测试里不会炸。
  useEffect(() => {
    if (!slashOpen) return;
    const el = listRef.current?.querySelector(`[data-idx="${slashIdx}"]`) as HTMLElement | null;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [slashIdx, slashOpen]);
  // 打开根层菜单时重拉一次列表：客户刚在「定制 → Skills」新建/删除完就按 "/"，
  // 只在挂载时拉过一次的话他看到的是旧清单（"我明明刚建好"）。
  useEffect(() => {
    if (slashOpen && slashRoot) listSkills().then(setSkills).catch(() => {});
  }, [slashOpen, slashRoot]);

  // ── 深度调查可用性：这个部署/这个账号有没有 DevOps Agent 的 Agent Space ──
  // 此前两个「深度调查」开关只按主题显示，没有 Agent Space 的部署（或没接入 DevOps Agent 的
  // 成员账号）也照样能点开，用户发一轮才收到一句 no_local_agent_space /
  // account_not_onboarded_to_devops_agent。这里提前问一次，不可用就置灰 + 写清原因和出路。
  // "" = 可用（或还没问出来 —— 探测不确定一律按可用处理，见 api/chat.ts）。
  const deepShown = topicHasDevopsAgent(topic);
  // 「DevOps 对话」的**平铺开关**只留给故障调查主题。判据搬到了 types.ts 的
  // `topicHasDevopsChat`（原因与口径见那里）—— ChatApp 恢复会话模式时要用同一个判断。
  const chatShown = topicHasDevopsChat(topic);
  // 通用会话里选了「DevOps Agent」这个对话对象：这一段对话不经我们的模型，
  // 模型选择器 / 联网搜索**全都与它无关**，留在界面上是在承诺不成立的事。
  const objDevops = devopsChat && (topic || "general") === "general";
  // 同理的第二个对象：阿里云 STAROps 数字员工。
  const objStarops = starops && (topic || "general") === "general";
  /** 「这段对话不由我们的模型回答」——凡是靠这一条做界面瘦身的地方都用它。
   *  ⚠️ 新增一个对话对象时**只需**加进这里；千万不要在下面逐处写 `devopsChat || starops`
   *     —— 那样漏掉任何一处都不报错，只是那一处继续展示一个不生效的控件（假信息）。 */
  const objMode = objDevops || objStarops;
  const [deepNa, setDeepNa] = useState("");
  useEffect(() => {
    // 通用会话既不显示深度调查、也不显示这个开关 → 不探（可用性由 ChatObjectPicker 自己探，
    // 两处各探一次等于每进一次主页发两个签名请求）。
    if (!deepShown && !chatShown) return;
    let stop = false;
    getDeepInvestigationAvailability(accountId)
      .then((r) => { if (!stop) setDeepNa(r.available ? "" : (r.reason || "unavailable")); })
      .catch(() => { /* 探测失败按可用处理 */ });
    return () => { stop = true; };
  }, [deepShown, chatShown, accountId]);
  // 切到一个做不了深度调查的账号时，把已经开着的开关自动关掉 —— 否则用户带着一个必然失败的
  // 开关继续发消息（开关置灰后他也点不掉）。
  useEffect(() => {
    if (!deepNa) return;
    if (devopsAgent) onToggleDevopsAgent?.();
    if (devopsAgentDirect) onToggleDevopsAgentDirect?.();
    if (devopsChat) onToggleDevopsChat?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepNa, devopsAgent, devopsAgentDirect, devopsChat]);
  const deepNaHint = deepNa === "account_not_onboarded_to_devops_agent"
    ? t("composer.devops.na.account") : t("composer.devops.na.self");

  // 本轮这个 skill 会不会被交给客户自己的 DevOps Agent 执行 —— 三条路径都算（见芯片处注释）。
  // 🔴 **刻意不含 `starops`**（别顺手补上去）：这个标志唯一的作用是打出「本轮由你的
  //    DevOps Agent 执行」那条提示，而 STAROps 那条链路根本不接 skill（runStarOpsChat
  //    只收 text/locale/conversationId），加进来就是一句纯假信息。STAROps 下 `/` 按钮
  //    本身也已经隐掉（见下面 `!objStarops`），正常走不到这里。
  const devopsHandsOff = devopsAgent || devopsAgentDirect || devopsChat;
  // 已发布到某个 Agent Space（世界 B）= DevOps Agent 那边有完整一份（含 references/）。
  const skillPublishedToDevops = !!activeSkill?.devops_agent?.uploads
    && Object.keys(activeSkill.devops_agent!.uploads!).length > 0;

  const pickSkill = (s: Skill) => {
    setActiveSkill(s);
    // /-触发场景：把原来只作占位提示的「使用 Skill「xxx」」落成真实文字预填进输入框，
    // 客户无需再手输即可直接发送（也可继续改写补充诉求）。光标落到文末，回车即发。
    const nm = skillDisplay(s, locale).name;
    const prefill = locale === "zh" ? `使用 Skill「${nm}」` : `Use the "${nm}" skill`;
    setText(prefill);
    setSlashOpen(false);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(prefill.length, prefill.length); }
      autogrow();
    });
  };

  // 点 "/" 按钮：填入 "/" 并打开命令菜单（再点一次关闭）。
  const toggleCmdMenu = () => {
    if (slashOpen && slashRoot) { setText(""); setSlashOpen(false); return; }
    setText("/");
    setSlashOpen(true);
    requestAnimationFrame(() => { taRef.current?.focus(); autogrow(); });
  };

  const gotoManageSkills = () => {
    setText(""); setSlashOpen(false);
    onManageSkills?.();
  };

  // 候选集由管理员在服务端勾选（GET /models），拉取落地后本组件自动重渲染。
  const { models: modelOptions, loading: catalogLoading, source: catalogSource,
          canSend: catalogCanSend, canSendWithoutModel } = useModelCatalog();
  // 「深度调查（直连）」和「DevOps 对话」都由 BFF 直连 DevOps Agent API，全程 0 token、
  // 不碰 Bedrock，所以它们不受模型目录门禁约束 —— 否则管理员取消勾选全部 webchat 模型后，
  // 唯一不需要模型的功能反而发不出去，而提示语还指向一个与它无关的配置项。
  // STAROps 同理，而且更彻底：答话的是**阿里云**的数字员工，一个字都不经 Bedrock。
  const sendAllowed = (devopsAgentDirect || devopsChat || starops) ? canSendWithoutModel : catalogCanSend;
  const modelName = modelOptions.find((m) => m.id === model)?.name ?? model;

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (selRef.current && !selRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  const autogrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(Math.max(ta.scrollHeight, 30), 160) + "px";
  };

  const send = () => {
    const v = text.trim();
    if (!v || busy) return;
    // 目录还没落地（或管理员没为本端启用任何模型）就先别发：否则消息会带着一个
    // 界面上显示的、但其实不在启用集里的模型发出去，服务端替换后用户看到的模型
    // 与他选的不一致。`canSend` 在宽限期结束后会自动放行（见 models.ts 状态机）。
    // 直连路径不需要模型，用 sendAllowed 而不是 catalogCanSend。
    if (!sendAllowed) return;
    onSend(v, activeSkill?.skill_id);
    setText("");
    setActiveSkill(null);
    requestAnimationFrame(autogrow);
  };

  // 推荐 prompt 模板池（L1）：每主题一个池，随机抽 N。key 既是展示文案也是填入内容。
  const CHIP_POOL: Record<string, { Icon: ComponentType<{ size?: number }>; key: string }[]> = {
    cases: [
      { Icon: IconCases, key: "chip.cases.open" },
      { Icon: IconInvestigate, key: "chip.cases.analyze" },
      { Icon: IconReports, key: "chip.cases.bySeverity" },
      { Icon: IconFinOps, key: "chip.cases.draft" },
      { Icon: IconInvestigate, key: "chip.cases.recent" },
      { Icon: IconCases, key: "chip.cases.summary" },
      { Icon: IconReports, key: "chip.cases.create" },
    ],
    // 调查池 = 原调查 6 条 + 原安全 6 条（2026-09-11「安全」主题并入「调查」）。
    // 池子变大不改抽样数（下面 N_CHIPS=3），只是每次刷出来的组合更多样；安全那 6 条
    // 的图标保持 IconSecurity，客户一眼能看出这条是安全向的。
    investigate: [
      { Icon: IconInvestigate, key: "chip.inv.resource" },
      { Icon: IconInvestigate, key: "chip.inv.ec2reboot" },
      { Icon: IconReports, key: "chip.inv.logs" },
      { Icon: IconInvestigate, key: "chip.inv.connectivity" },
      { Icon: IconReports, key: "chip.inv.cwalarms" },
      { Icon: IconInvestigate, key: "chip.inv.rootcause" },
      { Icon: IconSecurity, key: "chip.sec.findings" },
      { Icon: IconSecurity, key: "chip.sec.publics3" },
      { Icon: IconSecurity, key: "chip.sec.opensg" },
      { Icon: IconSecurity, key: "chip.sec.iamreview" },
      { Icon: IconSecurity, key: "chip.sec.mfa" },
      { Icon: IconReports, key: "chip.sec.bestpractice" },
    ],
    finops: [
      { Icon: IconFinOps, key: "chip.fin.anomaly" },
      { Icon: IconFinOps, key: "chip.fin.topcost" },
      { Icon: IconFinOps, key: "chip.fin.savings" },
      { Icon: IconReports, key: "chip.fin.trend" },
      { Icon: IconFinOps, key: "chip.fin.ri" },
      { Icon: IconFinOps, key: "chip.fin.untagged" },
    ],
    // （原 security 池已并入上面的 investigate —— 「安全」不再是聊天主题。
    //   留一个空的 security 键没有意义：`CHIP_POOL[topic] ?? CHIP_POOL.general` 本身就兜得住，
    //   而留着会让人以为还有个安全主题。）
    "whats-new": [
      { Icon: IconWhatsNew, key: "chip.wn.recent" },
      { Icon: IconWhatsNew, key: "chip.wn.mine" },
      { Icon: IconReports, key: "chip.wn.digest" },
      { Icon: IconInvestigate, key: "chip.wn.service" },
      { Icon: IconWhatsNew, key: "chip.wn.ai" },
      { Icon: IconReports, key: "chip.wn.trends" },
    ],
    general: [
      { Icon: IconInvestigate, key: "chip.investigate" },
      { Icon: IconCases, key: "chip.cases" },
      { Icon: IconFinOps, key: "chip.cost" },
      { Icon: IconReports, key: "chip.health" },
      { Icon: IconInvestigate, key: "chip.g.diff" },
      { Icon: IconFinOps, key: "chip.g.save" },
      { Icon: IconReports, key: "chip.g.arch" },
      { Icon: IconCases, key: "chip.g.latest" },
    ],
  };
  const N_CHIPS = 3;
  const [chipSeed, setChipSeed] = useState(0);
  useEffect(() => { if (showSuggestions) setChipSeed((s) => s + 1); }, [topic, showSuggestions]);

  // L2：cases 主题空对话时，静默拉一次真实 case 摘要，用真实数字/案例构造引导。
  // 拉取失败/计划不足/非 cases 主题 → casesSummary 保持 null，回退 L1 模板。
  const [casesSummary, setCasesSummary] = useState<import("../api/chat").CasesSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (topic === "cases" && showSuggestions) {
      getCasesSummary().then((s) => { if (!cancelled && s?.ok) setCasesSummary(s); }).catch(() => {});
    } else {
      setCasesSummary(null);
    }
    return () => { cancelled = true; };
  }, [topic, showSuggestions, chipSeed]);

  // 统一的 chip 形态：{Icon, label(显示), prompt(点击填入)}
  const CHIPS = useMemo(() => {
    // L2：cases 且拿到真实摘要 → 用真实数据拼引导（带 case 编号/数字）
    if (topic === "cases" && casesSummary?.ok) {
      const en = locale === "en";
      const s = casesSummary;
      const dyn: { Icon: ComponentType<{ size?: number }>; label: string; prompt: string }[] = [];
      if (s.openCount && s.openCount > 0) {
        dyn.push({ Icon: IconCases,
          label: en ? `Look at my ${s.openCount} open case(s)` : `看看我的 ${s.openCount} 个未结案例`,
          prompt: en ? `Analyze my ${s.openCount} open support case(s) and tell me what needs attention.`
                     : `分析我的 ${s.openCount} 个未结 support 案例，告诉我哪些需要关注。` });
      }
      if (s.latest?.displayId) {
        const subj = s.latest.subject ? `「${s.latest.subject.slice(0, 24)}」` : "";
        dyn.push({ Icon: IconInvestigate,
          label: en ? `Analyze latest case #${s.latest.displayId}` : `分析最近案例 #${s.latest.displayId}`,
          prompt: en ? `Analyze support case ${s.latest.displayId} ${subj}, explain the situation and suggest next steps.`
                     : `分析 support 案例 ${s.latest.displayId}${subj}，解释整体情况并给出下一步建议。` });
      }
      if (s.totalCount && s.totalCount > 0) {
        dyn.push({ Icon: IconReports,
          label: en ? `Summarize all ${s.totalCount} cases` : `总结全部 ${s.totalCount} 个案例`,
          prompt: en ? `Summarize the overall status of all my ${s.totalCount} support cases.`
                     : `总结我全部 ${s.totalCount} 个 support 案例的整体情况。` });
      }
      dyn.push({ Icon: IconFinOps,
        label: en ? "Draft a reply to a case" : "帮我给某个案例起草回复",
        prompt: en ? "Help me draft a reply to one of my support cases." : "帮我给我的某个 support 案例起草一条回复。" });
      if (dyn.length >= 2) return dyn.slice(0, N_CHIPS);
    }
    // L1：模板池随机抽（用 i18n key 作为显示+填入）
    const pool = CHIP_POOL[topic] ?? CHIP_POOL.general;
    const arr = [...pool];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, N_CHIPS).map((c) => ({ Icon: c.Icon, label: t(c.key), prompt: t(c.key) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, chipSeed, casesSummary, locale]);

  const fillChip = (prompt: string) => {
    setText(prompt);
    requestAnimationFrame(() => { taRef.current?.focus(); autogrow(); });
  };

  // 已消费过的 prefill seq。**初值取挂载时的 seq，而不是 0** —— 这是"回到主题时输入框里
  // 还留着上次问过的那句话"的根因（2026-08-27 现网反馈：只有强刷浏览器才会消失）：
  // prefill 存在 ChatApp 的 `themePrefill[topic]` / `homePrefill[convId]` 里，活得比本组件久；
  // 而主题 landing 挂在 `view` 上，点主题=整棵子树卸载重挂。若从 0 起算，重挂时下面这个
  // effect 会认为"seq 变了"，把那条**已经发出去**的问题又填回输入框。
  // 卡片和输入框在同一棵子树里（卡片点击时本组件必定已挂载），所以"挂载时的 seq 一律视为
  // 已消费"不会漏掉任何一次真实点击。
  const appliedPrefillSeqRef = useRef(prefill?.seq ?? 0);

  // 外部预填（通用主页启动卡片）：seq 每变一次就填入并聚焦，光标落文末，回车即发。
  useEffect(() => {
    if (!prefill || prefill.seq === 0) return;
    if (prefill.seq === appliedPrefillSeqRef.current) return;   // 挂载时带进来的旧 seq / 重复渲染
    appliedPrefillSeqRef.current = prefill.seq;
    setActiveSkill(null);
    setText(prefill.text);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(prefill.text.length, prefill.text.length); }
      autogrow();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.seq]);

  // 切会话时隔离草稿：把离开会话的未发送文本存进 map，载入进入会话的草稿(默认空)。
  // 同一 Composer 实例切会话不卸载,若不隔离 text 会跨会话泄漏(bug)。
  useEffect(() => {
    if (convKey === prevConvKeyRef.current) return;
    if (prevConvKeyRef.current !== undefined) draftsRef.current[prevConvKeyRef.current] = text;
    const next = convKey !== undefined ? (draftsRef.current[convKey] ?? "") : "";
    prevConvKeyRef.current = convKey;
    setText(next);
    setActiveSkill(null);
    requestAnimationFrame(autogrow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convKey]);

  return (
    <div className="composer">
      <div className="cwrap">
        {showSuggestions && (
          <div className="chips">
            {CHIPS.map((c, i) => (
              <button key={i} type="button" className="chip" onClick={() => fillChip(c.prompt)}>
                <c.Icon size={15} /> {c.label}
              </button>
            ))}
          </div>
        )}
        {/* 输入框上方那行**粗粒度**仪表盘入口（调查：运行概览 / 安全态势；成本：支出与优化；
            案例：案例进展）。跟上面那排 `.chip` 靠**形状**区分，不靠文字说明 ——
            `.dashpill` 是透明底 + 全圆角 + 右侧一个 `›`，`.chip` 是卡片底 + 18px 圆角。
            ⚠️ 2026-09-11：这一行原来前面还有一个「仪表盘」图标+文字标签（`.dashpills-label`），
            产品要求去掉 —— 胶囊名字本身（运行概览 / 安全态势 / …）已经说清是什么了，再加一个
            分类词只是占掉输入框上方本来就很紧的横向空间。别再加回来。
            ⚠️ 左边那个主题图标**不上色**（客户原话「这些 dashboard 前面的图标，不需要有颜色」）：
            两个 svg 都继承 `.dashpill` 的 color，层次靠 opacity 不靠色相。见 styles.css。
            单行、不换行（`nowrap` + 横向滚动）：换行会把输入框往下推，两三个入口不值得。
            这一行**左对齐**（贴 .cbox 左边缘），空态也一样 —— 见 styles.css 里 .empty-center
            那段注释：曾经在空态居中过一版，产品否掉了。 */}
        {!!dashPills?.length && (
          <div className="dashpills">
            {dashPills.map((p) => (
              <button key={p.key} type="button" className="dashpill" onClick={p.onClick}>
                <p.Icon size={14} />
                {p.label}
                <IconChevronRight size={13} />
              </button>
            ))}
          </div>
        )}
        <div className="cbox">
          {/* 命令菜单：点 "/" 按钮或手输 "/" 弹出。**一层扁平列表**（不再是「Skills ▸」+ 悬停子菜单）：
              根层(text==="/")列出**全部** skill，过滤层(text==="/xxx")列出全部匹配项 —— 两层同一个
              渲染分支，唯一差别是列表内容。
              为什么改：旧版子菜单只随机展示 3 个 + 一行「输入以筛选」。客户有 20 个 skill 也只看见 3 个，
              且那 3 个每次展开都在变 —— 看上去像"我就这么点能力"，想找某个 skill 只能靠猜名字打字。
              现在条数写在表头、超出高度由列表自己滚动（该藏的是像素，不是能力）。
              「管理 Skills / 新建 Skill」两个出口留在滚动区**外面**：它们不该被 30 个 skill 挤到看不见。 */}
          {slashOpen && (
            <div className="cmd-menu">
              <div className="cmd-head">
                <span className="cmd-head-title">{t("cmd.skills.head")} ({slashList.length})</span>
                {/* 根层才提示「输入以筛选」：过滤层里用户已经在筛了。 */}
                {slashRoot && slashList.length > 0 && <span className="cmd-head-hint">{t("cmd.filterHint")}</span>}
              </div>
              {slashList.length > 0 ? (
                <div className="cmd-list" ref={listRef}>
                  {slashList.map((s, i) => {
                    const Mi = skillIcon(s.skill_id);
                    const preset = isPresetSkill(s);
                    const d = skillDisplay(s, locale);
                    return (
                    <button key={s.skill_id} type="button" data-idx={i}
                      className={"skill-mi" + (i === slashIdx ? " active" : "")}
                      title={d.description ? `${d.name} — ${d.description}` : d.name}
                      onMouseEnter={() => setSlashIdx(i)}
                      onClick={() => pickSkill(s)}>
                      <Mi size={15} />
                      <span className="skill-mi-name">/{s.skill_id}</span>
                      <span className={"skill-mi-tag " + (preset ? "preset" : "mine")}>
                        {preset ? t("cz.skill.tag.preset") : t("cz.skill.tag.mine")}
                      </span>
                      <span className="skill-mi-desc">{d.name}</span>
                      {/* 描述（「什么时候用它」）：选哪个 skill 靠的是这句，不是 id。整行放不下就截断，
                          完整内容在 title 里（悬停可见）。 */}
                      {d.description && <span className="skill-mi-sub">{d.description}</span>}
                    </button>
                    );
                  })}
                </div>
              ) : (
                <div className="cmd-empty">{t(slashRoot ? "cmd.skills.empty" : "cmd.skills.noMatch")}</div>
              )}
              <div className="cmd-sep" />
              <button type="button" className="cmd-mi" onClick={gotoManageSkills}>
                <IconCustomize size={15} />
                <span className="cmd-mi-name">{t("cmd.skills.manage")}</span>
              </button>
              <button type="button" className="cmd-mi" onClick={gotoManageSkills}>
                <IconPlus size={15} />
                <span className="cmd-mi-name">{t("cmd.skills.add")}</span>
              </button>
            </div>
          )}
          {/* 已激活的 skill 芯片（发送时随本轮强制使用该 skill）。「DevOps Agent」标记的含义是
              **这一轮谁来执行这个 skill**，所以三条交给 DevOps Agent 的路径都要打上：
                · `devopsAgent`       → 我们的 agent 转交 DevOps Agent（**已无界面入口**，
                                        2026-09-13 撤掉，见 ModePicker 文件头；字段仍在）；
                · `devopsAgentDirect` → 界面上的「深度调查」，BFF 直连 CreateBacklogTask；
                · `devopsChat`        → 界面上的「DevOps 对话」，BFF 直连 CreateChat/SendMessage。
              以前只认第一个，于是走直连的客户在界面上**看不出**这个 skill 会被交给
              DevOps Agent —— 同一件事，界面说法却随路径变。 */}
          {activeSkill && (() => { const ChipIcon = skillIcon(activeSkill.skill_id); return (
            <div className="skill-active">
              <ChipIcon size={14} /> <span>{skillDisplay(activeSkill, locale).name}</span>
              {devopsHandsOff && (
                <span className="skill-active-mode" title={t("composer.devops")}><IconInvestigate size={12} /> DevOps Agent</span>
              )}
              <button type="button" className="skill-active-x" onClick={() => setActiveSkill(null)} title="移除">×</button>
            </div>
          ); })()}
          {/* 未发布到 DevOps Agent 的 skill，在两类路径上的后果**不一样**，所以提示分两句写：
              · 转交路径（`devopsAgent`）：我们的 agent 只是转交一个任务描述，正文不过去 →
                这个 skill 真的不会被激活，必须先发布；
              · 两条**直连**路径：BFF 把正文内联进发给 DevOps Agent 的那段话（devops_skill.mjs）→ 无需发布也生效，
                唯一缺口是 references/ 附属文件取不到。
              这里以前只有第一句、且只在 devopsAgent 时出现：直连路径既没提示（客户不知道谁在执行），
              而把第一句套上去更糟 —— 那是在说一件不成立的事（"不会被激活"）。
              ⚠️ 2026-09-13 起 `devopsAgent` 已经没有界面入口（见 ModePicker 文件头）⇒ 实际走到
              的永远是第二句。这个三元刻意不删：字段与 BFF 侧那条路都还在，入口一旦加回来，
              第一句必须跟着回来 —— 删了就得有人重新发现"两条路径后果不同"这件事。 */}
          {activeSkill && devopsHandsOff && !skillPublishedToDevops && (
            <div className="skill-needs-devops">
              <IconInvestigate size={13} /> {t(devopsAgent ? "composer.skill.notPublished" : "composer.skill.directInline")}
            </div>
          )}
          {/* 开着「DevOps 对话」时提示语必须换：这一轮答话的**不是 NotiOps**，而是客户自己的
              DevOps Agent（我们侧 0 token）—— 还写 "给 NotiOps 发消息…" 是在说错谁在答。
              （/skill 在这条路径上是生效的，所以提示语里不必否认它。） */}
          <div className="ta-wrap">
            <textarea
              ref={taRef}
              rows={1}
              placeholder={activeSkill
                ? `使用 Skill「${skillDisplay(activeSkill, locale).name}」…`
                : t(starops ? "composer.placeholder.starops"
                    : devopsChat ? "composer.placeholder.devopschat"
                    : "composer.placeholder")}
              value={text}
              onChange={(e) => { setText(e.target.value); autogrow(); }}
              onKeyDown={(e) => {
                // 命令菜单开着时先让键盘归它：↑/↓ 选行、Enter 选中高亮那个、Esc 关。
                // 列表现在可能有几十行且要滚动，"Enter = 第一个匹配"已经不够用了。
                if (slashOpen && slashList.length) {
                  if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashList.length); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashList.length) % slashList.length); return; }
                  if (e.key === "Enter") { e.preventDefault(); pickSkill(slashList[Math.min(slashIdx, slashList.length - 1)]); return; }
                }
                if (e.key === "Escape" && slashOpen) { setSlashOpen(false); return; }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
            />
            {/* 仅当输入恰为 "/" 时，在聊天框里 "/" 后面显示淡色「输入以筛选」内联提示；
                用户一开始打字（text != "/"）就消失。覆盖层不拦事件，焦点仍在 textarea。 */}
            {text === "/" && (
              <div className="ta-ghost" aria-hidden="true">
                <span className="ta-ghost-slash">/</span>
                <span className="ta-ghost-hint">{t("cmd.filterHint")}</span>
              </div>
            )}
          </div>
          <div className="cbar">
            {/* objMode（通用会话选了 DevOps Agent）下**只**去掉联网搜索与模型选择器：联网搜索
                由 DevOps Agent 自己决定、模型跟这条路径完全无关（见下方 cbar-right），留着等于
                给客户点了不生效的控件。
                "/" 则保留 —— 它现在是真生效的：BFF 会把 skill 正文内联进发给 DevOps Agent 的
                那段话（bff/web-chat/devops_skill.mjs），DevOps Agent 按它执行，我们侧仍 0 token。 */}
            {/* "/" 命令菜单按钮：填入 "/" 并弹出扁平 skill 列表（全部 + 管理 / 新建）
                🔴 STAROps 那个对象下**不显示**：BFF 的 STAROps 分支根本不接 skillId
                （runStarOpsChat 只收 text/locale/conversationId），而 Skills 全是 AWS 侧的
                做法（调 AWS API、读 CloudWatch），内联给阿里云的数字员工也毫无意义。留着它
                客户会挑一个 skill、看到输入框被填成「使用 Skill「X」」、发出去却什么都没按它执行
                —— 又一条"发出去才知道没生效"的假信息。要给 STAROps 做 skill 是另一件事。 */}
            {!objStarops && (
            <button
              type="button"
              className={"cmd-btn" + (slashOpen ? " on" : "")}
              onClick={toggleCmdMenu}
              title={t("cmd.button.hint")}
              aria-pressed={slashOpen}
            >
              /
            </button>
            )}
            {/* 联网搜索：**只留图标**（产品指定，2026-09-13）。地球仪这个图标本身就是"联网"的
                通用符号，「联网」两个字在它旁边不增加任何信息，只占工具条宽度。
                ⚠️ 去掉可见文字后**必须**有 `aria-label` —— 否则读屏软件念出来的是一个空按钮
                （IconGlobe 是个裸 `<svg>`，既没有 `<title>` 也没有 `aria-hidden`）。这里用
                `t("composer.websearch")` 而不是硬编码英文，因为同一句已经在 `title` 里用了，
                两处同源就不会漂。（旁边 Stop/Send 两个按钮的 aria-label 是硬编码英文 —— 那是
                旧写法，别照抄。） */}
            {!objMode && (
              <button
                type="button"
                className={"websearch-toggle icon-only" + (webSearch ? " on" : "")}
                onClick={onToggleWebSearch}
                title={t("composer.websearch") + " — " + t("composer.websearch.hint")}
                aria-label={t("composer.websearch")}
                aria-pressed={webSearch}
              >
                <IconGlobe size={15} />
              </button>
            )}
            {/* 「谁来答这一轮」的开关：**平铺**，不是下拉。
                🔁 2026-09-13 产品指定改回平铺。上一版（2026-09-04）这里写着一条阈值规则
                「工具条上带文字的按钮 >2 个就收成下拉」，并算出每个主题都是 3~4 枚 ⇒ 全部走
                下拉。那条规则和那笔账**现在都不成立了**，因为同一次改动把项数砍到了 ≤2：
                  · 「深度调查」（经我们的 agent 转交）从界面撤掉；
                  · 成本主题那项永久置灰的「FinOps」删掉；
                  · 「联网」只留图标，本来就不再占"带文字按钮"的预算。
                现在各主题的实际枚数（ModePicker 渲染几枚就是几枚，没有"不启用"那一项）：
                  · investigate = 2（DevOps 对话 + 深度调查）
                  · finops / security 等 deepShown 主题 = 1（深度调查）
                  · general / cases / whats-new = 0 → ModePicker 返回 null，什么都不渲染
                项清单、置灰（deepNa）、图标、互斥调用都在 ModePicker 里，**这边不再列第二份**
                —— 上一版就是在这里列了一份主题→枚数的账，然后那份账先烂掉。
                主题门控与互斥（ChatApp 的 onToggle*）原样保留：关着时前端一个字段都不传，
                后端行为与从前逐字节一致。
                ⚠️ objMode（通用会话选了 DevOps Agent）不走这条：那里剩下的「深度调查」
                是**这一轮的修饰**而不是选模式，仍是下面单独那个开关（两处现在同名同字段）。 */}
            {!objMode && (
              <ModePicker
                deepShown={deepShown}
                chatShown={chatShown}
                deepNa={deepNa}
                deepNaHint={deepNaHint}
                devopsAgentDirect={devopsAgentDirect}
                devopsChat={devopsChat}
                onToggleDevopsAgentDirect={onToggleDevopsAgentDirect}
                onToggleDevopsChat={onToggleDevopsChat}
              />
            )}
            {/* objMode（通用会话，对话对象已是客户自己的 DevOps Agent）下**唯一保留**的开关：
                「深度调查」。对象不变，它只决定**这一轮**走哪一条：不勾 = 直接问答（秒级回话）；
                勾上 = 让它发起一次完整的深度调查（多信号排查，出报告，通常几分钟）。两者都不经
                我们的模型，所以这里不需要模型选择器/联网/命令（见上面的瘦身注释）。
                **默认不勾**（产品指定）：深度调查要跑几分钟，不能替客户默认选上。
                不置灰：能进 objMode 就说明这个账号已接入 DevOps Agent（可用性已由
                ChatObjectPicker 探过），这里再探一次只是多一个签名请求。
                互斥由 ChatApp 的 toggleDevopsAgentDirect 保证 —— 勾它**不会**把对话对象换掉。
                🔴 判据是 `objDevops` 而**不是** `objMode`：STAROps 那个对象**没有**这个开关
                   （它靠一句自然语言自己发起巡检/调查，正如 STAROps 控制台里的做法）。写成
                   objMode 会在阿里云会话里摆出一个 AWS DevOps Agent 的深度调查开关 ——
                   勾上之后 BFF 的一选一让 STAROps 胜出，这个开关**什么也不做**。 */}
            {objDevops && (
              <button
                type="button"
                className={"websearch-toggle" + (devopsAgentDirect ? " on" : "")}
                onClick={onToggleDevopsAgentDirect}
                title={t("composer.devops.short") + " — " + t("composer.devops.obj.hint")}
                aria-pressed={devopsAgentDirect}
              >
                <IconInvestigate size={15} /> {t("composer.devops.short")}
              </button>
            )}
            <div className="cbar-right" style={{ marginLeft: "auto" }} ref={selRef}>
              {/* 模型选择器：objMode 下**不显示** —— 这段对话由客户自己的 DevOps Agent 回答，
                  一个字都不经我们的 Bedrock 模型（NotiOps 侧 0 token）。显示一个"当前模型"
                  会让客户以为自己选的模型在答这些问题，那是纯粹的假信息。
                  发送按钮不受影响：sendAllowed 对直连路径走 canSendWithoutModel。 */}
              {!objMode && (
              <div className="modelsel" onClick={(e) => {
                e.stopPropagation();
                // 开菜单前判断方向:菜单约 ~420px 高,若选择器上方空间不足就向下弹。
                if (!menuOpen) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const spaceAbove = r.top;
                  const spaceBelow = window.innerHeight - r.bottom;
                  const MENU_H = 440;
                  setMenuDropUp(spaceAbove >= MENU_H || spaceAbove >= spaceBelow);
                }
                setMenuOpen((o) => !o);
              }}>
                <span>{modelName}</span>
                <span className="caret">▾</span>
              </div>
              )}
              {busy ? (
                /* 生成中：显示停止按钮（方块），点击中止本会话生成 */
                <button className="send stop" onClick={() => onStop?.()} aria-label="Stop" title={t("composer.stop")}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none">
                    <rect x="6" y="6" width="12" height="12" rx="2.5" />
                  </svg>
                </button>
              ) : (
                <button className="send" onClick={send} disabled={!text.trim() || !sendAllowed}
                  title={!sendAllowed
                    ? t(catalogLoading ? "model.loading" : "model.noneEnabled") : undefined}
                  aria-label="Send">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V6" /><path d="M6 12l6-6 6 6" />
                  </svg>
                </button>
              )}

              {/* !objMode 也要挡：菜单开着时客户去点了「DevOps Agent」那张卡，选择器会消失，
                  菜单却会留在原地悬空。 */}
              {!objMode && menuOpen && (
                <div className={"modelmenu" + (menuDropUp ? "" : " drop-down")} onClick={(e) => e.stopPropagation()}>
                  {/* 这一份清单不是管理员配的那一份 —— 读服务端目录失败时会静默退回打包内置
                      清单，于是用户看到的模型多于（甚至完全不同于）管理员启用的那些。
                      此前这个状态在界面上毫无痕迹，问题只能靠对比 DDB 才能发现。 */}
                  {catalogLoading && (
                    <div style={{ fontSize: 11.5, color: "var(--muted)", padding: "8px 10px" }}>
                      {t("model.loading")}
                    </div>
                  )}
                  {/* 只在服务端明确"没有目录"时才提示降级。`cache` 不提示 —— 它是这个部署
                      真实目录的上一次快照，后台正在校验，提示只会造成噪声。 */}
                  {!catalogLoading && (catalogSource === "read_error" || catalogSource === "unseeded"
                                       || catalogSource === "disabled") && (
                    <div style={{ fontSize: 11, color: "#8a5a00", background: "#fff3da",
                                  borderBottom: "1px solid #f0d9a6", padding: "6px 10px",
                                  lineHeight: 1.45 }}>
                      {t(catalogSource === "read_error" ? "model.degradedNotice" : "model.fallbackNotice")}
                    </div>
                  )}
                  {/* 目录读到了、但管理员没为 Web 对话启用任何模型：这要他去改配置，
                      不能偷偷换一份清单顶上（那正是之前"看到 8 个其实只有 1 个"的成因）。 */}
                  {!catalogLoading && catalogSource === "ddb" && modelOptions.length === 0 && (
                    <div style={{ fontSize: 11.5, color: "#8a5a00", padding: "8px 10px", lineHeight: 1.45 }}>
                      {t("model.noneEnabled")}
                    </div>
                  )}
                  {/* 加载中不渲染任何模型行：`catalog` 的初值是打包内置清单，渲染它等于
                      在那一秒里把一份错清单当成正式目录给用户选（实测：先看到 8 个，
                      落地后变 1 个）。宁可短暂空着，也不给可选的错项。 */}
                  {!catalogLoading && modelOptions.map((mo) => (
                    <div key={mo.id} className={"mm-item" + (mo.id === model ? " sel" : "")} onClick={() => { onModelChange(mo.id); setMenuOpen(false); }}>
                      <div style={{ flex: 1 }}>
                        <div className="mm-name">
                          {mo.name}
                          {mo.flagKey && (
                            <span style={{ fontSize: 10, fontWeight: 700, color: "#8a5a00", background: "#fff3da", border: "1px solid #f0d9a6", borderRadius: 5, padding: "1px 5px", marginLeft: 5 }}>
                              {t(mo.flagKey)}
                            </span>
                          )}
                          {/* 成本主题:Nova Pro 标「不推荐」(处理大成本结果易失败,见 D 诊断) */}
                          {topic === "finops" && mo.id === "amazon-nova-pro" && (
                            <span style={{ fontSize: 10, fontWeight: 700, color: "#9a3412", background: "#ffe4d6", border: "1px solid #f6b89a", borderRadius: 5, padding: "1px 5px", marginLeft: 5 }}>
                              {locale === "en" ? "not recommended" : "不推荐"}
                            </span>
                          )}
                        </div>
                        <div className="mm-desc">{topic === "finops" && mo.id === "amazon-nova-pro" ? t("model.novaFinopsWarn") : t(mo.descKey)}</div>
                      </div>
                      <span className="mm-check">✓</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {/* 免责声明仅在已开始对话时显示；空对话居中态隐藏。
            通用会话选了 DevOps Agent（objDevops）时必须换主语：这段对话答话的不是 NotiOps，
            把"NotiOps 可能出错"挂在别人的答案下面既张冠李戴、也让客户不知道该找谁核实。

            🔴 这里是**三选一**、判据必须是 `objDevops` / `objStarops` 而不是笼统的 `objMode`：
               objMode 把两个对象并成一个，会让阿里云 STAROps 的会话底下写着"由你的
               DevOps Agent 回答" —— 落款写成另一朵云，比不写更糟。 */}
        {!showSuggestions && (
          <div className="chint">{t(objStarops ? "composer.hint.starops" : objDevops ? "composer.hint.devops" : "composer.hint")}</div>
        )}
      </div>
    </div>
  );
}
