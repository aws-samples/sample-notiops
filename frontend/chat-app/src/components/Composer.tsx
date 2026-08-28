import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useT, useLocale } from "../i18n";
import { useModelCatalog } from "../models";
// `MODELS` 不再从 types 引入：模型清单已改为运行时从 `/models` 拉取（useModelCatalog），
// types.ts 里那份只剩历史落款用途。main 侧这行原本是 `{ MODELS, topicHasDevopsAgent }`，
// 合并时只保留后者 —— 本文件已无 MODELS 引用，留着会是未使用导入。
import { topicHasDevopsAgent } from "../types";
import { getCasesSummary, getDeepInvestigationAvailability } from "../api/chat";
import { listSkills, skillDisplay, isPresetSkill, type Skill } from "../api/skills";
// IconSkill 随「/命令菜单」的两层结构一起去掉了：现在根层直接就是 skill 列表，
// 不再有那条「技能 ▸」父项，所以这个图标已无处使用（留着 tsc 会报未使用导入）。
import { IconInvestigate, IconCases, IconFinOps, IconReports, IconGlobe, IconSecurity, IconWhatsNew, IconChevronRight, IconPlus, IconCustomize, IconGauge, IconChatBubble, skillIcon } from "./icons";

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
  /** 主题页：点「打开 Dashboard」跳该主题仪表盘详情。传了才渲染——作为紧贴输入框左上角的一体化标签。 */
  onOpenDashboard?: () => void;
  /** 当前会话 id：用于隔离「未发送草稿」。同一 Composer 实例在切会话时不卸载，
   *  故内部 text 会跨会话泄漏（bug）。传了 convKey 后按会话各存各的草稿，切走保存、切回恢复。 */
  convKey?: string;
}

const EFFORTS = ["model.effort.fast", "model.effort.balanced", "model.effort.deep"] as const;

export default function Composer({ model, onModelChange, onSend, busy, showSuggestions = true, webSearch = false, onToggleWebSearch, devopsAgent = false, onToggleDevopsAgent, devopsAgentDirect = false, onToggleDevopsAgentDirect, devopsChat = false, onToggleDevopsChat, onStop, topic = "general", prefill, onManageSkills, onOpenDashboard, convKey, accountId = "" }: Props) {
  const t = useT();
  const { locale } = useLocale();
  const [text, setText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  // 模型菜单弹出方向:默认向上(bottom:54px);但 composer 在页面靠上时(如成本/案例主题
  // 带仪表盘,输入框顶在上方),向上弹会被视口顶部裁掉。点开时测一下上方空间,不够就向下弹。
  const [menuDropUp, setMenuDropUp] = useState(true);
  const [effortIdx, setEffortIdx] = useState(1);
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
  // 「DevOps 对话」的**平铺开关**只留给故障调查主题（产品决定：显式列举，不跟随
  // topicHasDevopsAgent 的"默认提供、按例外排除"口径 —— 那份排除表管的是"给我们的 agent
  // 挂 DevOps 工具"，与这条根本不经我们 agent 的路径无关）。
  // 通用会话**不显示这个开关**：那里改由新对话主页的「对话对象」两张卡来选
  // （ChatObjectPicker），选完发第一句即锁定 —— 一个能力两个入口会让"这段对话谁在答"
  // 变得不可预期（开关是每轮修饰，对象是整段会话的事实）。
  const CHAT_TOPICS: ReadonlySet<string> = new Set(["investigate"]);
  const chatShown = CHAT_TOPICS.has(topic || "general");
  // 通用会话里选了「DevOps Agent」这个对话对象：这一段对话不经我们的模型，
  // 模型选择器 / "/" 命令 / 联网搜索**全都与它无关**，留在界面上是在承诺不成立的事。
  const objMode = devopsChat && (topic || "general") === "general";
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
  const sendAllowed = (devopsAgentDirect || devopsChat) ? canSendWithoutModel : catalogCanSend;
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
    investigate: [
      { Icon: IconInvestigate, key: "chip.inv.resource" },
      { Icon: IconInvestigate, key: "chip.inv.ec2reboot" },
      { Icon: IconReports, key: "chip.inv.logs" },
      { Icon: IconInvestigate, key: "chip.inv.connectivity" },
      { Icon: IconReports, key: "chip.inv.cwalarms" },
      { Icon: IconInvestigate, key: "chip.inv.rootcause" },
    ],
    finops: [
      { Icon: IconFinOps, key: "chip.fin.anomaly" },
      { Icon: IconFinOps, key: "chip.fin.topcost" },
      { Icon: IconFinOps, key: "chip.fin.savings" },
      { Icon: IconReports, key: "chip.fin.trend" },
      { Icon: IconFinOps, key: "chip.fin.ri" },
      { Icon: IconFinOps, key: "chip.fin.untagged" },
    ],
    security: [
      { Icon: IconSecurity, key: "chip.sec.findings" },
      { Icon: IconSecurity, key: "chip.sec.publics3" },
      { Icon: IconSecurity, key: "chip.sec.opensg" },
      { Icon: IconSecurity, key: "chip.sec.iamreview" },
      { Icon: IconSecurity, key: "chip.sec.mfa" },
      { Icon: IconReports, key: "chip.sec.bestpractice" },
    ],
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
        {/* 主题页专属：紧贴输入框左上角的一体化「打开 Dashboard」标签（视觉上与 .cbox 连成一体：
            底边压在 cbox 上、共用圆角与描边）。仅主题页传了 onOpenDashboard 才渲染。 */}
        {onOpenDashboard && (
          <div className="cbox-tabs">
            <button type="button" className="cbox-tab" onClick={onOpenDashboard}>
              <IconGauge size={14} />
              {locale === "en" ? "Open Dashboard" : "打开 Dashboard"}
              <IconChevronRight size={14} />
            </button>
          </div>
        )}
        <div className={"cbox" + (onOpenDashboard ? " has-tab" : "")}>
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
                · 深度调查（devopsAgent）      → 我们的 agent 转交 DevOps Agent；
                · 深度调查（直连）（devopsAgentDirect）→ BFF 直连 CreateBacklogTask；
                · DevOps 对话（devopsChat）    → BFF 直连 CreateChat/SendMessage。
              以前只认第一个，于是勾了「深度调查（直连）」的客户在界面上**看不出**这个 skill 会被
              交给 DevOps Agent —— 同一件事，界面说法却随路径变。 */}
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
              · 「深度调查」：我们的 agent 只是转交一个任务描述，正文不过去 → 这个 skill 真的不会被激活，必须先发布；
              · 两条**直连**路径：BFF 把正文内联进发给 DevOps Agent 的那段话（devops_skill.mjs）→ 无需发布也生效，
                唯一缺口是 references/ 附属文件取不到。
              这里以前只有第一句、且只在 devopsAgent 时出现：直连路径既没提示（客户不知道谁在执行），
              而把第一句套上去更糟 —— 那是在说一件不成立的事（"不会被激活"）。 */}
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
                : t(devopsChat ? "composer.placeholder.devopschat" : "composer.placeholder")}
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
            {/* "/" 命令菜单按钮：填入 "/" 并弹出扁平 skill 列表（全部 + 管理 / 新建） */}
            <button
              type="button"
              className={"cmd-btn" + (slashOpen ? " on" : "")}
              onClick={toggleCmdMenu}
              title={t("cmd.button.hint")}
              aria-pressed={slashOpen}
            >
              /
            </button>
            {!objMode && (
              <button
                type="button"
                className={"websearch-toggle" + (webSearch ? " on" : "")}
                onClick={onToggleWebSearch}
                title={t("composer.websearch") + " — " + t("composer.websearch.hint")}
                aria-pressed={webSearch}
              >
                <IconGlobe size={15} /> {t("composer.websearch.short")}
              </button>
            )}
            {/* 「DevOps 对话」：这轮直接由**客户自己的 DevOps Agent** 回答（BFF 直连控制面
                CreateChat/SendMessage 并逐 delta 转发），NotiOps 侧 **0 token**。
                位置固定在联网搜索之后（产品指定）；在**故障调查 + 通用会话**两个主题显示
                （chatShown 显式列举，不跟 topicHasDevopsAgent 走）。同样依赖 Agent Space，故复用
                deepNa 的置灰与提示。与两个「深度调查」三方互斥（互斥在 ChatApp 侧）。
                ⚠️ 关着时前端不传 devops_chat_direct，后端行为与从前逐字节一致。 */}
            {chatShown && (
              <button
                type="button"
                className={"websearch-toggle" + (devopsChat ? " on" : "") + (deepNa ? " disabled" : "")}
                onClick={deepNa ? undefined : onToggleDevopsChat}
                disabled={!!deepNa}
                title={deepNa ? deepNaHint : t("composer.devopschat") + " — " + t("composer.devopschat.hint")}
                aria-pressed={devopsChat}
                aria-disabled={deepNa ? "true" : undefined}
              >
                <IconChatBubble size={15} /> {t("composer.devopschat.short")}
                {deepNa && <span className="toggle-soon">{t("composer.devops.na")}</span>}
              </button>
            )}
            {/* FinOps Agent 深度模式开关：仅 FinOps 主题显示。**暂不可用**(功能未完善)——
                置灰禁用,提示"即将上线"。客户可改用下面的 DevOps Agent 分析成本/用量。 */}
            {topic === "finops" && (
              <button
                type="button"
                className="websearch-toggle disabled"
                disabled
                title={t("composer.finops") + " — " + t("composer.finops.soon")}
                aria-disabled="true"
              >
                <IconFinOps size={15} /> {t("composer.finops.short")}
                <span className="toggle-soon">{t("composer.soon")}</span>
              </button>
            )}
            {/* DevOps Agent 深度调查开关：**默认所有主题都显示**，只排除少数不适用的
                (见 types.ts `topicHasDevopsAgent` —— 与后端 `_DEVOPS_TOPICS_EXCLUDED` 同一口径)。
                这样以后新增主题自动继承该能力，不需要回来改这里。
                默认开/关状态由会话初始值决定(见 ChatApp;当前一律默认关，用户按需手动开)。 */}
            {deepShown && (
              <button
                type="button"
                className={"websearch-toggle" + (devopsAgent ? " on" : "") + (deepNa ? " disabled" : "")}
                onClick={deepNa ? undefined : onToggleDevopsAgent}
                disabled={!!deepNa}
                title={deepNa ? deepNaHint : t("composer.devops") + " — " + t("composer.devops.hint")}
                aria-pressed={devopsAgent}
                aria-disabled={deepNa ? "true" : undefined}
              >
                <IconInvestigate size={15} /> {t("composer.devops.short")}
                {deepNa && <span className="toggle-soon">{t("composer.devops.na")}</span>}
              </button>
            )}
            {/* 「深度调查（直连）」：与上面同一能力的 **0 token** 版本（BFF 直连 DevOps Agent
                API，不经大模型）。与上面的开关**互斥**（互斥在 ChatApp 的 toggle 里实现），
                主题门控沿用同一个 topicHasDevopsAgent。老开关一行未改。 */}
            {deepShown && (
              <button
                type="button"
                className={"websearch-toggle" + (devopsAgentDirect ? " on" : "") + (deepNa ? " disabled" : "")}
                onClick={deepNa ? undefined : onToggleDevopsAgentDirect}
                disabled={!!deepNa}
                title={deepNa ? deepNaHint : t("composer.devops.direct") + " — " + t("composer.devops.direct.hint")}
                aria-pressed={devopsAgentDirect}
                aria-disabled={deepNa ? "true" : undefined}
              >
                <IconInvestigate size={15} /> {t("composer.devops.direct.short")}
                {deepNa && <span className="toggle-soon">{t("composer.devops.na")}</span>}
              </button>
            )}
            {/* objMode（通用会话，对话对象已是客户自己的 DevOps Agent）下**唯一保留**的开关：
                「深度调查」。对象不变，它只决定**这一轮**走哪一条：不勾 = 直接问答（秒级回话）；
                勾上 = 让它发起一次完整的深度调查（多信号排查，出报告，通常几分钟）。两者都不经
                我们的模型，所以这里不需要模型选择器/联网/命令（见上面的瘦身注释）。
                **默认不勾**（产品指定）：深度调查要跑几分钟，不能替客户默认选上。
                不置灰：能进 objMode 就说明这个账号已接入 DevOps Agent（可用性已由
                ChatObjectPicker 探过），这里再探一次只是多一个签名请求。
                互斥由 ChatApp 的 toggleDevopsAgentDirect 保证 —— 勾它**不会**把对话对象换掉。 */}
            {objMode && (
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
                <span className="effort">{t(EFFORTS[effortIdx])}</span>
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
                  <div style={{ height: 1, background: "var(--line)", margin: "5px 8px" }} />
                  <div className="mm-item" onClick={(e) => { e.stopPropagation(); setEffortIdx((i) => (i + 1) % EFFORTS.length); }} style={{ justifyContent: "space-between" }}>
                    <div className="mm-name" style={{ fontWeight: 500 }}>{t("model.effort.label")}</div>
                    <span style={{ fontSize: 13, color: "var(--muted)" }}>{t(EFFORTS[effortIdx])} ›</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        {/* 免责声明仅在已开始对话时显示；空对话居中态隐藏。
            通用会话选了 DevOps Agent（objMode）时必须换主语：这段对话答话的不是 NotiOps，
            把"NotiOps 可能出错"挂在别人的答案下面既张冠李戴、也让客户不知道该找谁核实。 */}
        {!showSuggestions && (
          <div className="chint">{t(objMode ? "composer.hint.devops" : "composer.hint")}</div>
        )}
      </div>
    </div>
  );
}
