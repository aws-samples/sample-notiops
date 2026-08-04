import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useT, useLocale } from "../i18n";
import { MODELS } from "../types";
import { getCasesSummary } from "../api/chat";
import { listSkills, skillDisplay, isPresetSkill, type Skill } from "../api/skills";
import { IconInvestigate, IconCases, IconFinOps, IconReports, IconGlobe, IconSecurity, IconSkill, IconWhatsNew, IconChevronRight, IconPlus, IconCustomize, IconGauge, skillIcon } from "./icons";

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
  /** 停止当前会话正在进行的生成。 */
  onStop?: () => void;
  /** 当前会话主题，用于切换专属推荐 prompt。 */
  topic?: string;
  /** 外部预填输入框（如通用主页的启动卡片点击）。seq 变化即触发一次填入 + 聚焦。 */
  prefill?: { text: string; seq: number };
  /** 多账号：已注册账号 + 当前选择（空=部署账号）+ 切换。 */
  /** 跳转到 Skills 管理页（Customize → Skills）。 */
  onManageSkills?: () => void;
  /** 主题页：点「打开 Dashboard」跳该主题仪表盘详情。传了才渲染——作为紧贴输入框左上角的一体化标签。 */
  onOpenDashboard?: () => void;
  /** 当前会话 id：用于隔离「未发送草稿」。同一 Composer 实例在切会话时不卸载，
   *  故内部 text 会跨会话泄漏（bug）。传了 convKey 后按会话各存各的草稿，切走保存、切回恢复。 */
  convKey?: string;
}

const EFFORTS = ["model.effort.fast", "model.effort.balanced", "model.effort.deep"] as const;

export default function Composer({ model, onModelChange, onSend, busy, showSuggestions = true, webSearch = false, onToggleWebSearch, devopsAgent = false, onToggleDevopsAgent, onStop, topic = "general", prefill, onManageSkills, onOpenDashboard, convKey }: Props) {
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
  const [skillsSub, setSkillsSub] = useState(false);   // 一级「Skills」展开的二级子菜单
  useEffect(() => { listSkills().then(setSkills).catch(() => {}); }, []);
  // 当输入恰为 "/..." 且无空格时，视为正在挑命令。text==="/" 为根菜单（分类层），"/xxx" 为过滤层。
  const slashQuery = (!activeSkill && text.startsWith("/") && !text.includes(" ")) ? text.slice(1).toLowerCase() : null;
  const slashRoot = slashQuery === "";   // 恰为 "/" → 显示分类（Skills ▸）
  const slashMatches = slashQuery
    ? skills.filter((s) => s.skill_id.toLowerCase().includes(slashQuery) || s.name.toLowerCase().includes(slashQuery)).slice(0, 8)
    : [];
  // 根菜单(恰为"/")总是显示分类；过滤层有匹配才显示。
  useEffect(() => { setSlashOpen(slashQuery !== null && (slashRoot || slashMatches.length > 0)); }, [text, skills.length]); // eslint-disable-line
  useEffect(() => { if (!slashRoot) setSkillsSub(false); }, [slashRoot]);

  // 二级子菜单只随机展示 3 个 skill（其余靠「输入以筛选」找）。每次展开子菜单重新洗牌。
  const [subSeed, setSubSeed] = useState(0);
  useEffect(() => { if (skillsSub) setSubSeed((s) => s + 1); }, [skillsSub]);
  const subSkills = useMemo(() => {
    const arr = [...skills];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skills.length, subSeed]);

  // 子菜单里点「输入以筛选」：把光标留在输入框，提示用户接着打字过滤（已是 "/" 态）。
  const focusFilter = () => {
    setSkillsSub(false);
    requestAnimationFrame(() => { taRef.current?.focus(); autogrow(); });
  };

  const pickSkill = (s: Skill) => {
    setActiveSkill(s);
    // /-触发场景：把原来只作占位提示的「使用 Skill「xxx」」落成真实文字预填进输入框，
    // 客户无需再手输即可直接发送（也可继续改写补充诉求）。光标落到文末，回车即发。
    const nm = skillDisplay(s, locale).name;
    const prefill = locale === "zh" ? `使用 Skill「${nm}」` : `Use the "${nm}" skill`;
    setText(prefill);
    setSlashOpen(false);
    setSkillsSub(false);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(prefill.length, prefill.length); }
      autogrow();
    });
  };

  // 点 "/" 按钮：填入 "/" 并打开命令菜单（再点一次关闭）。
  const toggleCmdMenu = () => {
    if (slashOpen && slashRoot) { setText(""); setSlashOpen(false); setSkillsSub(false); return; }
    setText("/");
    setSlashOpen(true);
    requestAnimationFrame(() => { taRef.current?.focus(); autogrow(); });
  };

  const gotoManageSkills = () => {
    setText(""); setSlashOpen(false); setSkillsSub(false);
    onManageSkills?.();
  };

  const modelName = MODELS.find((m) => m.id === model)?.name ?? model;

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

  // 外部预填（通用主页启动卡片）：seq 每变一次就填入并聚焦，光标落文末，回车即发。
  useEffect(() => {
    if (!prefill || prefill.seq === 0) return;
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
          {/* 命令菜单：点 "/" 按钮或手输 "/" 弹出。
              根层(text==="/")显示分类「Skills ▸」，悬停展开二级子菜单（已有 skills + 管理/新增）；
              过滤层(text==="/xxx")显示扁平的 skill 匹配列表（type-to-filter）。 */}
          {slashOpen && (
            slashRoot ? (
              <div className="cmd-menu">
                <div className="cmd-cat" onMouseEnter={() => setSkillsSub(true)} onMouseLeave={() => setSkillsSub(false)}>
                  <button type="button" className="cmd-mi" onClick={() => setSkillsSub((v) => !v)}>
                    <IconSkill size={15} />
                    <span className="cmd-mi-name">{t("cz.nav.skills")}</span>
                    <span className="cmd-mi-arrow"><IconChevronRight size={15} /></span>
                  </button>
                  {skillsSub && (
                    <div className="cmd-sub">
                      {subSkills.length > 0 ? (
                        subSkills.map((s) => {
                          const Mi = skillIcon(s.skill_id);
                          const preset = isPresetSkill(s);
                          return (
                          <button key={s.skill_id} type="button" className="skill-mi" onClick={() => pickSkill(s)}>
                            <Mi size={15} />
                            <span className="skill-mi-name">/{s.skill_id}</span>
                            <span className={"skill-mi-tag " + (preset ? "preset" : "mine")}>
                              {preset ? t("cz.skill.tag.preset") : t("cz.skill.tag.mine")}
                            </span>
                            <span className="skill-mi-desc">{skillDisplay(s, locale).name}</span>
                          </button>
                          );
                        })
                      ) : (
                        <div className="cmd-sub-empty">{t("cmd.skills.empty")}</div>
                      )}
                      {/* 第 4 行用「输入以筛选」替代：其余 skill 靠继续打字过滤 */}
                      {skills.length > 0 && (
                        <button type="button" className="cmd-mi cmd-mi-filter" onClick={focusFilter}>
                          <IconSkill size={15} />
                          <span className="cmd-mi-name cmd-mi-muted">{t("cmd.filterHint")}</span>
                        </button>
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
                </div>
              </div>
            ) : slashMatches.length > 0 ? (
              <div className="skill-menu">
                {slashMatches.map((s) => {
                  const Mi = skillIcon(s.skill_id);
                  const preset = isPresetSkill(s);
                  return (
                  <button key={s.skill_id} type="button" className="skill-mi" onClick={() => pickSkill(s)}>
                    <Mi size={15} />
                    <span className="skill-mi-name">/{s.skill_id}</span>
                    <span className={"skill-mi-tag " + (preset ? "preset" : "mine")}>
                      {preset ? t("cz.skill.tag.preset") : t("cz.skill.tag.mine")}
                    </span>
                    <span className="skill-mi-desc">{skillDisplay(s, locale).name}</span>
                  </button>
                  );
                })}
              </div>
            ) : null
          )}
          {/* 已激活的 skill 芯片（发送时随本轮强制使用该 skill）。DevOps Agent 标记只看本轮开关：
              开 → 这轮会把该 skill 交给 DevOps Agent 深度调查。所有 skill 本地都能跑，无需声明执行方式。*/}
          {activeSkill && (() => { const ChipIcon = skillIcon(activeSkill.skill_id); return (
            <div className="skill-active">
              <ChipIcon size={14} /> <span>{skillDisplay(activeSkill, locale).name}</span>
              {devopsAgent && (
                <span className="skill-active-mode" title={t("composer.devops")}><IconInvestigate size={12} /> DevOps Agent</span>
              )}
              <button type="button" className="skill-active-x" onClick={() => setActiveSkill(null)} title="移除">×</button>
            </div>
          ); })()}
          {/* 开了 DevOps Agent 开关，但选中的 skill 尚未发布到 DevOps Agent → 行内提醒：
              深度调查时这个 skill 不会被激活，先去「定制 → Skills」发布。补上"选未发布 skill 静默不生效"的缺口。 */}
          {activeSkill && devopsAgent && !(activeSkill.devops_agent?.uploads && Object.keys(activeSkill.devops_agent.uploads).length > 0) && (
            <div className="skill-needs-devops">
              <IconInvestigate size={13} /> {t("composer.skill.notPublished")}
            </div>
          )}
          <div className="ta-wrap">
            <textarea
              ref={taRef}
              rows={1}
              placeholder={activeSkill ? `使用 Skill「${skillDisplay(activeSkill, locale).name}」…` : t("composer.placeholder")}
              value={text}
              onChange={(e) => { setText(e.target.value); autogrow(); }}
              onKeyDown={(e) => {
                if (slashOpen && e.key === "Enter" && slashMatches.length) { e.preventDefault(); pickSkill(slashMatches[0]); return; }
                if (e.key === "Escape" && slashOpen) { setSlashOpen(false); setSkillsSub(false); return; }
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
            {/* "/" 命令菜单按钮：点开两层菜单（Skills ▸ 子菜单 / 管理 / 新增），并填入 "/" 进入过滤态 */}
            <button
              type="button"
              className={"cmd-btn" + (slashOpen ? " on" : "")}
              onClick={toggleCmdMenu}
              title={t("cmd.button.hint")}
              aria-pressed={slashOpen}
            >
              /
            </button>
            <button
              type="button"
              className={"websearch-toggle" + (webSearch ? " on" : "")}
              onClick={onToggleWebSearch}
              title={t("composer.websearch") + " — " + t("composer.websearch.hint")}
              aria-pressed={webSearch}
            >
              <IconGlobe size={15} /> {t("composer.websearch.short")}
            </button>
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
            {/* DevOps Agent 深度调查开关：故障调查 + FinOps + 安全主题都显示
                (FinOps 里用它分析成本/用量;安全里用它深度排查安全风险/配置)。
                默认状态由会话初始值决定(见 ChatApp;当前三者均默认关)。 */}
            {(topic === "investigate" || topic === "finops" || topic === "security") && (
              <button
                type="button"
                className={"websearch-toggle" + (devopsAgent ? " on" : "")}
                onClick={onToggleDevopsAgent}
                title={t("composer.devops") + " — " + t("composer.devops.hint")}
                aria-pressed={devopsAgent}
              >
                <IconInvestigate size={15} /> {t("composer.devops.short")}
              </button>
            )}
            <div className="cbar-right" style={{ marginLeft: "auto" }} ref={selRef}>
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
              {busy ? (
                /* 生成中：显示停止按钮（方块），点击中止本会话生成 */
                <button className="send stop" onClick={() => onStop?.()} aria-label="Stop" title={t("composer.stop")}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none">
                    <rect x="6" y="6" width="12" height="12" rx="2.5" />
                  </svg>
                </button>
              ) : (
                <button className="send" onClick={send} disabled={!text.trim()} aria-label="Send">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V6" /><path d="M6 12l6-6 6 6" />
                  </svg>
                </button>
              )}

              {menuOpen && (
                <div className={"modelmenu" + (menuDropUp ? "" : " drop-down")} onClick={(e) => e.stopPropagation()}>
                  {MODELS.map((mo) => (
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
        {/* 免责声明仅在已开始对话时显示；空对话居中态隐藏 */}
        {!showSuggestions && <div className="chint">{t("composer.hint")}</div>}
      </div>
    </div>
  );
}
