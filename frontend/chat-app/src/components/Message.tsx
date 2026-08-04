import { useState, useEffect, useId } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useT, useLocale } from "../i18n";
import { MODELS, type ChatMessage, type ProposedAction } from "../types";
import { getSupportServices, type SupportService } from "../api/chat";

// 模型署名：m.model 在流式时是显示名（如 "DeepSeek V3.2"），从历史加载时是
// id（如 "deepseek-v3-2"）。两种都归一成显示名。
function modelDisplayName(model?: string): string {
  if (!model) return "";
  const byId = MODELS.find((m) => m.id === model);
  if (byId) return byId.name;
  const byName = MODELS.find((m) => m.name === model);
  return byName ? byName.name : model;
}

// 署名行文案："AWS Bedrock (DeepSeek V3.2) · 1,234 tokens · 3 步"
// 所有模型均经 Amazon Bedrock 提供（GPT-5.4 经 Bedrock Mantle），故 provider 统一。
// tokens 是本轮真实账单（agentic loop 每个 cycle 都重发上下文、都计费）；当 cycle>1 时
// 附「N 步」，把大数字解释成"做了多步工具调用/推理"，避免用户误以为一句话就吃了那么多。
// 署名行拆成「正文 + 可选 steps」两段：steps 单独带 tooltip 解释什么是「步」。
function modelSignatureParts(model: string | undefined, usage: ChatMessage["usage"], en: boolean):
  { base: string; steps?: string; stepsTip?: string } {
  const name = modelDisplayName(model);
  if (!name) return { base: "" };
  let base = `AWS Bedrock (${name})`;
  const tot = usage?.totalTokens;
  let steps: string | undefined;
  let stepsTip: string | undefined;
  if (typeof tot === "number" && tot > 0) {
    base += ` · ${tot.toLocaleString()} tokens`;
    const cy = usage?.cycles;
    if (typeof cy === "number" && cy > 1) {
      steps = en ? `${cy} steps` : `${cy} 步`;
      stepsTip = en
        ? "Steps = how many tool-call / reasoning rounds (agentic loop) this answer took. More steps = a more complex task with more tool calls; tokens accumulate across the rounds."
        : "步数 = 本次回答中 agent 调用工具 / 推理的轮次（agentic loop）。步数越多说明任务越复杂、调用工具越多；token 是各轮累加的总量。";
    }
  }
  return { base, steps, stepsTip };
}

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);
const SourcesIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M4 5a2 2 0 0 1 2-2h6v16H6a2 2 0 0 0-2 2zM20 5a2 2 0 0 0-2-2h-6v16h6a2 2 0 0 1 2 2z" />
  </svg>
);
const CheckCircle = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5" />
  </svg>
);

function PulseWave() {
  return (
    <span className="pulsewave"><i /><i /><i /><i /><i /></span>
  );
}

function fmtTime(ts: number, locale: string) {
  const d = new Date(ts);
  const hh = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, "0");
  return (locale === "en" ? "Today " : "今天 ") + hh + ":" + mm;
}

// AWS Support 控制台案例页 URL
const caseUrl = (id: string) => `https://support.console.aws.amazon.com/support/home#/case/?displayId=${encodeURIComponent(id)}`;

/** 前端兜底：把正文里**裸的短数字 displayId**（12+ 位）自动渲染成控制台链接（模型已被
 *  要求这么做，这里防它偶尔漏掉）。
 *  注意：**只 linkify 短数字 displayId**——长的内部 caseId（case-账号-mczh-年-哈希）
 *  在控制台打不开，绝不能拿它拼 ?displayId=，所以不处理那种形式。
 *  已在 markdown 链接/代码里的不重复处理（()/]/反引号 紧邻的跳过）。 */
function linkifyCaseIds(text: string): string {
  if (!text) return text;
  // 仅纯数字 displayId（12 位以上），避免误伤普通数字；不碰长 case-... 内部 ID
  return text.replace(/(?<![\w/([-])(\d{12,})(?![\w)\]])/g, (m) => `[${m}](${caseUrl(m)})`);
}

/** 去掉模型泄漏的内部推理/工具调用标记（弱模型不听 prompt，必须在输出层确定性剥离）。
 *  覆盖：
 *   - <thinking>/<reasoning>/<scratchpad> 标签（Nova 等）
 *   - DeepSeek 特殊分隔符标记，如 `<｜DSML｜function_calls...`、`<|...|>`（全角/半角竖线均有）
 *  闭合块整段删；流式中未闭合的起始标记之后内容先隐藏，待闭合/正文到达再显示。 */
function stripThinking(text: string): string {
  if (!text) return text;
  let out = text;
  // 1) <thinking>…</thinking>/<reasoning>/<scratchpad> 闭合块整段删
  out = out.replace(/<(thinking|reasoning|scratchpad)>[\s\S]*?<\/\1>/gi, "");
  // 2) DeepSeek DSML 标记：实测泄漏形如整行 `<｜DSML｜function_calls让我再搜索…：`
  //    （标记 + 同行工具调用旁白）。**整行删除**含 DSML 标记的行（标记+旁白一起去），
  //    不动其它行（避免误删真正的回答）。半/全角竖线都覆盖。
  const dsml = /<\s*[｜|].*?(?:DSML|function_calls|tool_call|tool▁call)/i;
  out = out.split("\n").filter((ln) => !dsml.test(ln)).join("\n");
  // 3) 流式未闭合的 <thinking 起始 → 丢弃其后（还在思考）
  out = out.replace(/<(thinking|reasoning|scratchpad)>[\s\S]*$/i, "");
  // 4) 流式：行尾刚冒出的未成形特殊 token 起始，先藏起来
  out = out.replace(/<\s*[｜|][^\n]*$/i, "");
  return out.replace(/^\s+/, "");
}

// 写操作成功后的明确反馈（按操作类型，而非泛泛的"已执行"）
function successMsg(type: string, en: boolean): string {
  switch (type) {
    case "create_case": return en ? "Support case created" : "已成功创建 Support 案例";
    case "add_communication": return en ? "Reply added to the case" : "已成功回复该案例";
    case "resolve_case": return en ? "Case resolved (closed)" : "已成功关闭该案例";
    default: return en ? "Done" : "已执行";
  }
}

const ACTION_TITLE: Record<string, { zh: string; en: string }> = {
  create_case: { zh: "创建 Support Case", en: "Create Support Case" },
  add_communication: { zh: "回复 Support Case", en: "Reply to Support Case" },
  resolve_case: { zh: "关闭 Support Case", en: "Resolve Support Case" },
};

// 严重级别选项（AWS Support；label 随 locale）。
const SEVERITY_OPTS: { code: string; zh: string; en: string }[] = [
  { code: "low", zh: "一般咨询 (low)", en: "General guidance (low)" },
  { code: "normal", zh: "影响较小 (normal)", en: "System impaired (normal)" },
  { code: "high", zh: "生产受影响 (high)", en: "Production impaired (high)" },
  { code: "urgent", zh: "生产严重 (urgent)", en: "Production down (urgent)" },
  { code: "critical", zh: "业务中断 (critical)", en: "Business-critical down (critical)" },
];
const LANG_OPTS: { code: string; label: string }[] = [
  { code: "zh", label: "中文" }, { code: "en", label: "English" },
  { code: "ja", label: "日本語" }, { code: "ko", label: "한국어" },
];
// AWS 案例三类(issueType)。提高服务限制走 service-limit-increase;账单/账户走 customer-service。
const ISSUE_TYPE_OPTS: { code: string; zh: string; en: string }[] = [
  { code: "technical", zh: "技术问题", en: "Technical" },
  { code: "customer-service", zh: "账单和账户", en: "Account & billing" },
  { code: "service-limit-increase", zh: "提高服务限制", en: "Service limit increase" },
];

/**
 * 只读「创建支持案例 · 确认」卡（markdown 模版流程用）：agent 已解析模版 + 用真实目录校正好
 * 服务/类别,这里只展示让客户核对后确认建案(不可编辑;要改就返回改 markdown)。与可编辑
 * CaseFormCard 区分:这条不弹表单、不查目录,信息都由 agent 备好。
 */
function CaseReviewCard({ action, onConfirm, onCancel, locale }: {
  action: ProposedAction; onConfirm: () => void; onCancel: () => void; locale: string;
}) {
  const en = locale === "en";
  const p = action.params || {};
  const r = action.result;
  const itLabel = (ISSUE_TYPE_OPTS.find((o) => o.code === p.issue_type) || ISSUE_TYPE_OPTS[0])[en ? "en" : "zh"];
  const sevLabel = (SEVERITY_OPTS.find((o) => o.code === p.severity_code) || SEVERITY_OPTS[1])[en ? "en" : "zh"];
  const langLabel = (LANG_OPTS.find((o) => o.code === p.language) || {}).label || String(p.language || "");
  const svcMatched = p.service_matched !== false && p.service_code;
  if (action.done) {
    return (
      <div className="actcard done">
        <div className={"actcard-result" + (r?.ok ? " ok" : " fail")}>
          {r?.ok ? (
            <>
              <div className="actcard-result-title"><CheckCircle /> {en ? "Support case created" : "已成功创建 Support 案例"}
                {r.verified ? <span className="actcard-verified">{en ? "verified" : "已验证"}</span>
                  : <span className="actcard-verified pending">{en ? "status pending" : "状态待确认"}</span>}
              </div>
              {(r.displayId || r.caseId) && (
                <div className="actcard-caseid"><span>Case ID:</span>
                  <a href={caseUrl(r.displayId || r.caseId!)} target="_blank" rel="noopener noreferrer">{r.displayId || r.caseId}</a>
                  <span className="actcard-caseid-hint">{en ? "— open in AWS Console" : "— 在 AWS 控制台打开"}</span>
                </div>
              )}
            </>
          ) : ((en ? "Not executed: " : "未执行：") + (r?.message || (en ? "cancelled" : "已取消")))}
        </div>
      </div>
    );
  }
  return (
    <div className="casecard">
      <div className="casecard-h">
        <span className="casecard-badge">{en ? "Create support case" : "创建支持案例"}</span>
        <span className="casecard-hint">{en ? "Review & confirm — created directly" : "核对后直接创建"}</span>
      </div>
      <div className="casecard-preview">
        <div className="cf-prev-row"><b>{en ? "Subject" : "主题"}:</b> {String(p.subject || "")}</div>
        <div className="cf-prev-row"><b>{en ? "Case type" : "案例类型"}:</b> {itLabel}</div>
        <div className="cf-prev-row"><b>{en ? "Service" : "服务"}:</b> {String(p.service_name || p.service_code || "")}
          {!svcMatched && <span className="cf-warn"> {en ? "(couldn't match a service — go back and specify)" : "（未能匹配到服务，请返回补充服务名）"}</span>}
        </div>
        <div className="cf-prev-row"><b>{en ? "Severity" : "严重级别"}:</b> {sevLabel}</div>
        <div className="cf-prev-row"><b>{en ? "Language" : "语言"}:</b> {langLabel}</div>
        <div className="cf-prev-body"><b>{en ? "Case body" : "案例正文"}:</b><pre>{String(p.communication_body || "")}</pre></div>
        <div className="casecard-foot">
          <button className="actbtn cancel" onClick={onCancel}>{en ? "Cancel" : "取消"}</button>
          <button className="actbtn confirm" disabled={!svcMatched} onClick={onConfirm}>{en ? "Create case" : "确认创建"}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 可编辑「创建支持案例」卡（严肃动作,让客户核对/填写关键信息后再建案）。
 * 流程:填写(主题/服务下拉/类别联动/严重级别/语言/附加上下文) → 预览(只读) → 确认建案 / 返回修改。
 * 服务/类别下拉数据来自 BFF /support/services(describe-services,权威,不编造);
 * 提交时把编辑后的参数交给 onSubmit → 走确定性 /actions/execute 建 create_case。
 */
function CaseFormCard({ action, onSubmit, onCancel, locale }: {
  action: ProposedAction; onSubmit: (edited: Record<string, unknown>) => void;
  onCancel: () => void; locale: string;
}) {
  const en = locale === "en";
  const p = action.params || {};
  const [subject, setSubject] = useState(String(p.subject || ""));
  const [serviceCode, setServiceCode] = useState(String(p.service_code || ""));
  const [categoryCode, setCategoryCode] = useState(String(p.category_code || ""));
  const [severity, setSeverity] = useState(String(p.severity_code || "normal"));
  // 语言默认**跟随用户提问语言**(不是 UI locale)：agent 通常已按问题语言给 p.language；
  // 若缺省则看问题文本(主题+背景+正文)——含中文字符→中文，否则英文。
  const [language, setLanguage] = useState(() => {
    if (p.language) return String(p.language);
    const qs = `${p.subject || ""} ${p.background || ""} ${p.communication_body || ""}`;
    return /[一-鿿]/.test(qs) ? "zh" : "en";
  });
  const [issueType, setIssueType] = useState(String(p.issue_type || "technical"));
  const [extra, setExtra] = useState("");
  const [services, setServices] = useState<SupportService[]>([]);
  const [svcLoading, setSvcLoading] = useState(true);
  const [preview, setPreview] = useState(false);
  // 服务下拉可搜索：AWS 有几百个服务，原生 select 难找。改用 input+datalist 输入即筛。
  // svcQuery = 输入框可见文本(服务名)；真正的值仍是 serviceCode，onChange 时按名字反查 code。
  const svcListId = useId();
  const [svcQuery, setSvcQuery] = useState("");

  // 拉服务目录(下拉数据源)。按 language 拉(label 本地化);失败→空(回退手填/仅现有值)。
  useEffect(() => {
    let stop = false;
    setSvcLoading(true);
    getSupportServices(language).then((s) => { if (!stop) { setServices(s); setSvcLoading(false); } })
      .catch(() => { if (!stop) setSvcLoading(false); });
    return () => { stop = true; };
  }, [language]);

  // 模型给的 service_code 可能是编造的(如 amazon-ec2,真实是 amazon-elastic-compute-cloud-linux)。
  // 目录加载后若当前 code 不在目录里 → 按 token 重叠做**最佳匹配**映射到真实 code;匹配不到则清空,
  // 逼客户从下拉里选真实服务。
  useEffect(() => {
    if (!services.length || !serviceCode) return;
    if (services.some((s) => s.code === serviceCode)) return; // 已是真实 code
    const toks = serviceCode.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    let best = "", bestScore = 0;
    for (const s of services) {
      const hay = (s.code + " " + s.name).toLowerCase();
      const score = toks.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = s.code; }
    }
    // 至少命中 2 个 token 才敢自动映射(如 elastic/compute/cloud/ec2);否则清空让客户选。
    setServiceCode(bestScore >= 2 ? best : "");
    setCategoryCode("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services]);

  const cats = services.find((s) => s.code === serviceCode)?.categories || [];
  // 类别必填(AWS CreateCase 要求 service+category+issueType 合法组合)：目录加载后，
  // 若当前 category 不在该 service 名下(或为空) → 自动选第一个,避免"空类别→非法组合"报错。
  useEffect(() => {
    if (cats.length && !cats.some((c) => c.code === categoryCode)) {
      setCategoryCode(cats[0].code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceCode, services]);
  const svcName = services.find((s) => s.code === serviceCode)?.name || serviceCode;
  // serviceCode 变化(初始/编造码映射/选择)时，把输入框可见文本同步成服务名。
  useEffect(() => { setSvcQuery(svcName); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [serviceCode, services.length]);
  // 输入框改动：按可见文本精确匹配服务名→反查 code(匹配到才算选中；没匹配上 code 清空、逼真选)。
  const onSvcInput = (v: string) => {
    setSvcQuery(v);
    const hit = services.find((s) => s.name === v);
    setServiceCode(hit ? hit.code : "");
    setCategoryCode("");
  };
  const catName = cats.find((c) => c.code === categoryCode)?.name || categoryCode;
  const sevLabel = (SEVERITY_OPTS.find((o) => o.code === severity) || SEVERITY_OPTS[1])[en ? "en" : "zh"];
  const baseBody = String(p.communication_body || "").trim();
  // 案例正文：有调查摘要(baseBody)→ 附加上下文拼在其前;无 baseBody(Cases 主题直接建案)→
  // 附加上下文本身就是正文。两者都空 → 用主题兜底(CreateCase 要求 body 非空,绝不发空)。
  const finalBody = baseBody
    ? (extra.trim()
        ? `=== ${en ? "Additional context from requester" : "客户补充说明"} ===\n${extra.trim()}\n\n${baseBody}`
        : baseBody)
    : (extra.trim() || subject.trim() || (en ? "(no details provided)" : "(未提供详情)"));

  // 必须选到**目录里真实存在**的 service（模型可能编造如 amazon-ec2）+ 一个 category，
  // 否则 CreateCase 报 "No service exists for combination"。目录还没加载完时不阻断（宽松）。
  const serviceValid = !services.length || services.some((s) => s.code === serviceCode);
  const categoryValid = !cats.length || cats.some((c) => c.code === categoryCode);
  // 无调查摘要(Cases 直接建案)时，问题描述(extra)必填 —— 否则正文只有主题、信息不足。
  const bodyOk = baseBody.length > 0 || extra.trim().length > 0;
  const canSubmit = subject.trim().length > 0 && serviceCode.trim().length > 0
    && serviceValid && categoryValid && bodyOk && !action.done;

  // 已建案:显示结果(复用 ActionCard 的结果区样式)。
  const r = action.result;
  if (action.done) {
    return (
      <div className="actcard done">
        <div className={"actcard-result" + (r?.ok ? " ok" : " fail")}>
          {r?.ok ? (
            <>
              <div className="actcard-result-title"><CheckCircle /> {en ? "Support case created" : "已成功创建 Support 案例"}
                {r.verified ? <span className="actcard-verified">{en ? "verified" : "已验证"}</span>
                  : <span className="actcard-verified pending">{en ? "status pending" : "状态待确认"}</span>}
              </div>
              {(r.displayId || r.caseId) && (
                <div className="actcard-caseid"><span>Case ID:</span>
                  <a href={caseUrl(r.displayId || r.caseId!)} target="_blank" rel="noopener noreferrer">{r.displayId || r.caseId}</a>
                  <span className="actcard-caseid-hint">{en ? "— open in AWS Console" : "— 在 AWS 控制台打开"}</span>
                </div>
              )}
            </>
          ) : ((en ? "Not executed: " : "未执行：") + (r?.message || (en ? "cancelled" : "已取消")))}
        </div>
      </div>
    );
  }

  return (
    <div className="casecard">
      <div className="casecard-h">
        <span className="casecard-badge">{en ? "Create support case" : "创建支持案例"}</span>
        <span className="casecard-hint">{en ? "Review & confirm before submitting" : "提交前请核对信息"}</span>
      </div>

      {!preview ? (
        <div className="casecard-form">
          <label className="cf-field">
            <span>{en ? "Subject" : "主题"} *</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)}
              placeholder={en ? "One line describing the problem" : "一句话概括问题"} />
          </label>
          <div className="cf-row">
            <label className="cf-field">
              <span>{en ? "Service" : "服务"} *</span>
              {/* 可搜索：输入即筛(datalist 原生 type-to-filter)。选中真实服务名→反查 code。 */}
              <input
                list={svcListId}
                value={svcQuery}
                onChange={(e) => onSvcInput(e.target.value)}
                placeholder={svcLoading ? (en ? "loading…" : "加载中…") : (en ? "Type to search a service" : "输入以搜索服务")}
                autoComplete="off"
                className={serviceCode || !svcQuery ? "" : "cf-input-warn"}
              />
              <datalist id={svcListId}>
                {/* 只列目录里真实存在的服务(模型编造的 code 已在上面 effect 里映射/清空) */}
                {services.map((s) => <option key={s.code} value={s.name} />)}
              </datalist>
            </label>
            <label className="cf-field">
              <span>{en ? "Category" : "类别"} *</span>
              <select value={categoryCode} onChange={(e) => setCategoryCode(e.target.value)} disabled={!cats.length}>
                <option value="">{cats.length ? (en ? "Select a category" : "选择类别") : (en ? "Pick a service first" : "请先选服务")}</option>
                {cats.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
          </div>
          <div className="cf-row">
            <label className="cf-field">
              <span>{en ? "Case type" : "案例类型"}</span>
              <select value={issueType} onChange={(e) => setIssueType(e.target.value)}>
                {ISSUE_TYPE_OPTS.map((o) => <option key={o.code} value={o.code}>{en ? o.en : o.zh}</option>)}
              </select>
            </label>
            <label className="cf-field">
              <span>{en ? "Severity" : "严重级别"}</span>
              <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                {SEVERITY_OPTS.map((o) => <option key={o.code} value={o.code}>{en ? o.en : o.zh}</option>)}
              </select>
            </label>
            <label className="cf-field">
              <span>{en ? "Language" : "语言"}</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANG_OPTS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
              </select>
            </label>
          </div>
          <label className="cf-field">
            {/* 有调查摘要时这是"附加"; 无摘要(Cases 直接建案)时这就是问题描述本体 */}
            <span>{baseBody ? (en ? "Additional context (optional)" : "附加上下文（可选）") : (en ? "Problem description *" : "问题描述 *")}</span>
            <textarea value={extra} onChange={(e) => setExtra(e.target.value.slice(0, 2000))} rows={baseBody ? 3 : 5}
              placeholder={baseBody ? (en ? "Anything else AWS Support should know." : "还有什么想补充给 AWS Support 的。")
                : (en ? "Symptoms + expected vs actual + resource IDs / time window." : "现象 + 预期 vs 实际 + 相关资源 ID / 时间窗。")} />
            <span className="cf-count">{extra.length}/2000</span>
          </label>
          <div className="casecard-foot">
            <button className="actbtn cancel" onClick={onCancel}>{en ? "Cancel" : "取消"}</button>
            <button className="actbtn confirm" disabled={!canSubmit}
              onClick={() => setPreview(true)}>{en ? "Preview" : "预览"}</button>
          </div>
        </div>
      ) : (
        <div className="casecard-preview">
          <div className="cf-prev-row"><b>{en ? "Subject" : "主题"}:</b> {subject}</div>
          <div className="cf-prev-row"><b>{en ? "Case type" : "案例类型"}:</b> {(ISSUE_TYPE_OPTS.find((o) => o.code === issueType) || ISSUE_TYPE_OPTS[0])[en ? "en" : "zh"]}</div>
          <div className="cf-prev-row"><b>{en ? "Service" : "服务"}:</b> {svcName}{catName ? ` / ${catName}` : ""}</div>
          <div className="cf-prev-row"><b>{en ? "Severity" : "严重级别"}:</b> {sevLabel}</div>
          <div className="cf-prev-row"><b>{en ? "Language" : "语言"}:</b> {(LANG_OPTS.find((o) => o.code === language) || {}).label || language}</div>
          <div className="cf-prev-body"><b>{en ? "Case body" : "案例正文"}:</b><pre>{finalBody}</pre></div>
          <div className="casecard-foot">
            <button className="actbtn cancel" onClick={() => setPreview(false)}>{en ? "Back to edit" : "返回修改"}</button>
            <button className="actbtn confirm"
              onClick={() => onSubmit({
                subject: subject.trim(), communication_body: finalBody,
                service_code: serviceCode, category_code: categoryCode,
                severity_code: severity, language, issue_type: issueType,
              })}>{en ? "Create case" : "确认创建"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 写操作确认卡：展示将执行的操作 + 参数，需用户点确认才真执行（不可逆动作前必停）。 */
function ActionCard({ action, onConfirm, onCancel, locale }: {
  action: ProposedAction; onConfirm: () => void; onCancel: () => void; locale: string;
}) {
  const en = locale === "en";
  const title = (ACTION_TITLE[action.type] || { zh: action.type, en: action.type })[en ? "en" : "zh"];
  const p = action.params || {};
  const r = action.result;
  return (
    <div className={"actcard" + (action.done ? " done" : "")}>
      <div className="actcard-h">
        <span className="actcard-badge">{en ? "Confirm action" : "需确认操作"}</span>
        <span className="actcard-title">{title}</span>
      </div>
      <div className="actcard-body">
        {action.summary && <div className="actcard-sum">{action.summary}</div>}
        {/* 关键参数预览 */}
        <div className="actcard-params">
          {p.subject != null && <div><b>{en ? "Subject" : "标题"}:</b> {String(p.subject)}</div>}
          {p.case_id != null && <div><b>Case ID:</b> {String(p.case_id)}</div>}
          {p.severity_code != null && <div><b>{en ? "Severity" : "严重级别"}:</b> {String(p.severity_code)}</div>}
          {p.service_code != null && <div><b>{en ? "Service" : "服务"}:</b> {String(p.service_code)}</div>}
          {p.communication_body != null && (
            <div className="actcard-msg"><b>{en ? "Message" : "内容"}:</b><br />{String(p.communication_body)}</div>
          )}
        </div>
      </div>
      {!action.done ? (
        <div className="actcard-foot">
          <button className="actbtn cancel" onClick={onCancel}>{en ? "Cancel" : "取消"}</button>
          <button className="actbtn confirm" onClick={onConfirm}>{en ? "Confirm & Execute" : "确认执行"}</button>
        </div>
      ) : (
        <div className={"actcard-result" + (r?.ok ? " ok" : " fail")}>
          {r?.ok ? (
            <>
              <div className="actcard-result-title">
                <CheckCircle /> {successMsg(action.type, en)}
                {r.verified
                  ? <span className="actcard-verified">{en ? "verified" : "已验证"}</span>
                  : <span className="actcard-verified pending">{en ? "status pending" : "状态待确认"}</span>}
              </div>
              {r.status && (
                <div className="actcard-status">{en ? "Current status: " : "当前状态："}<b>{r.status}</b></div>
              )}
              {(r.displayId || r.caseId) && (
                <div className="actcard-caseid">
                  <span>Case ID:</span>
                  <a href={caseUrl(r.displayId || r.caseId!)}
                     target="_blank" rel="noopener noreferrer">{r.displayId || r.caseId}</a>
                  <span className="actcard-caseid-hint">{en ? "— click to open in AWS Console" : "— 点击在 AWS 控制台打开"}</span>
                </div>
              )}
            </>
          ) : (
            (en ? "Not executed: " : "未执行：") + (r?.message || (en ? "cancelled" : "已取消"))
          )}
        </div>
      )}
    </div>
  );
}

export default function Message({ m, onOpenSources, onOpenInvestigation, onConfirmAction, onCancelAction, onFollowup, accountLabel, accountIsMember }: {
  m: ChatMessage;
  onOpenSources: (m: ChatMessage) => void;
  onOpenInvestigation?: (m: ChatMessage) => void;
  onConfirmAction?: (idx: number, editedParams?: Record<string, unknown>) => void;
  onCancelAction?: (idx: number) => void;
  onFollowup?: (prompt: string) => void;
  accountLabel?: string;   // 本回复针对的账号显示名（"名 · id"）；由父组件解析后传入。空=不显示(单账号部署)
  accountIsMember?: boolean; // true=成员账号(橙)；false=部署/management 账号(蓝)。用于徽标配色区分。
}) {
  const t = useT();
  const { locale } = useLocale();
  const [copied, setCopied] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false); // 思考过程默认折叠

  const copy = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(m.text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  if (m.role === "user") {
    return (
      <div className="row user">
        <div className="msg">
          <div className="ts">{fmtTime(m.ts, locale)}</div>
          <p className="bubble">{m.text}</p>
          {/* 用户消息也提供复制按钮（与 assistant 一致） */}
          <div className="msgbar user">
            <button className={"mb-btn" + (copied ? " copied" : "")} title={copied ? t("msg.copied") : t("msg.copy")} onClick={copy}>
              <CopyIcon />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="row bot">
      <div className="msg">
        <div className="ts">{fmtTime(m.ts, locale)}</div>

        {/* 思考过程（reasoning）：可折叠灰字，默认折叠。处理中与出答案后都可见（放 ternary 之上）。
            语言随本轮（后端已按本轮提问语言锁定，中问中答、英问英答）。 */}
        {m.reasoning && m.reasoning.trim() && (
          <div className="reasoning">
            <button type="button" className="reasoning-toggle"
                    onClick={() => setShowReasoning((v) => !v)}>
              <svg className={"reasoning-caret" + (showReasoning ? " open" : "")} viewBox="0 0 24 24"
                   width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
              {showReasoning ? t("reasoning.hide") : t("reasoning.show")}
            </button>
            {showReasoning && <div className="reasoning-body">{m.reasoning}</div>}
          </div>
        )}

        {m.thinking ? (
          <div className="thinking">
            <PulseWave />
            {/* 处理中：有进度行(工具调用等)就显示"正在做什么"，否则显示"思考中"。
                文案已由后端按本轮语言给好（中问中答、英问英答）。 */}
            <span>{m.progress || t("thinking")}<span className="tk-dots" /></span>
            <span className="tk-sep">·</span>
            <span className="tk-time">{m.thinkElapsed ?? 0}s</span>
          </div>
        ) : (
          <>
            <div className={"md" + (m.streaming ? " typing" : "")}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // 所有链接新标签打开，避免在 SPA 内导航丢失会话
                  a: ({ ...props }) => <a target="_blank" rel="noopener noreferrer" {...props} />,
                }}
              >{linkifyCaseIds(stripThinking(m.text))}</ReactMarkdown>
            </div>
            {/* 调查过程入口：有分析步骤时给一个按钮，点开右侧「调查过程」面板（不自动弹，主聊天干净）。 */}
            {m.investigationSteps && m.investigationSteps.length > 0 && (
              <button type="button" className="inv-entry" onClick={() => onOpenInvestigation?.(m)}>
                <span className="inv-entry-ic">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
                  </svg>
                </span>
                {t("inv.entry")}
                <span className="inv-entry-count">{t("inv.entry.count").replace("{n}", String(m.investigationSteps.length))}</span>
              </button>
            )}
            {/* 待确认写操作（创建/回复/关闭 case）确认卡 */}
            {!m.streaming && m.actions && m.actions.length > 0 && (
              <div className="action-cards">
                {m.actions.map((a, i) => (
                  a.type === "create_case_form"
                    ? <CaseFormCard key={i} action={a} locale={locale}
                        onSubmit={(edited) => onConfirmAction?.(i, edited)}
                        onCancel={() => onCancelAction?.(i)} />
                    : a.type === "create_case_review"
                    ? <CaseReviewCard key={i} action={a} locale={locale}
                        onConfirm={() => onConfirmAction?.(i)}
                        onCancel={() => onCancelAction?.(i)} />
                    : <ActionCard key={i} action={a}
                        onConfirm={() => onConfirmAction?.(i)}
                        onCancel={() => onCancelAction?.(i)} locale={locale} />
                ))}
              </div>
            )}
            {/* 快捷后续按钮：url 型=新标签打开(如"去 DevOps 后台生成缓解方案")；
                prompt 型=向对话发预设 prompt(如转人工支持)。 */}
            {!m.streaming && m.followups && m.followups.length > 0 && (
              <div className="followups">
                {m.followups.map((f, i) => (
                  f.url
                    ? <a key={i} className="followup-btn" href={f.url} target="_blank" rel="noopener noreferrer">{f.label}</a>
                    : <button key={i} type="button" className="followup-btn"
                        onClick={() => f.prompt && onFollowup?.(f.prompt)}>{f.label}</button>
                ))}
              </div>
            )}
            {!m.streaming && (
              <>
                {m.model && (() => {
                  const sig = modelSignatureParts(m.model, m.usage, locale === "en");
                  if (!sig.base) return null;
                  return (
                    <div className="modelsig">
                      {sig.base}
                      {sig.steps && <> · <span className="modelsig-steps" title={sig.stepsTip}>{sig.steps}</span></>}
                    </div>
                  );
                })()}
                <div className="msgbar">
                  <button className={"mb-btn" + (copied ? " copied" : "")} title={copied ? t("msg.copied") : t("msg.copy")} onClick={copy}>
                    <CopyIcon />
                  </button>
                  {/* 账号徽标：多账号可切换,历史回复标明本次提问针对的账号(含 management/部署账号,
                      频繁切换时才看得出区别)。成员账号=橙,部署/management=蓝。 */}
                  {accountLabel && (() => {
                    const tone = accountIsMember ? "var(--orange)" : "var(--blue)";
                    return (
                      <span className="mb-acct" title={locale === "en" ? "This answer is for this AWS account" : "本回复针对该 AWS 账号的提问"}
                        style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--muted)", border: `1px solid ${tone}`, borderRadius: 100, padding: "1px 9px" }}>
                        <span style={{ width: 5, height: 5, borderRadius: 3, background: tone, display: "inline-block" }} />
                        {accountLabel}
                      </span>
                    );
                  })()}
                  {m.sources && m.sources.length > 0 && (
                    <button className="mb-btn" onClick={() => onOpenSources(m)}>
                      <SourcesIcon /> {t("msg.sources")} <span className="mb-count">{m.sources.length}</span>
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
