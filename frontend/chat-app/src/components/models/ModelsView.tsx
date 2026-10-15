/* 管理 → 模型（LLM 目录 + 来源 + 后台任务），2026-10 改版 A：单页 + 抽屉。
 *
 * 真源是 DynamoDB PK=llmcfg（spec: llm-provider-and-model-management）。
 * 这里勾选的启用集就是普通用户在对话框里能选到的全部模型 —— provider 与凭证不对普通
 * 用户开放，权限边界落在接口上（GET /models 只回启用集，/admin/llm-config 需 nav:admin）。
 * 保存后 generation 前进，长驻的 webchat microVM 与 IM bot 会在下一条消息重建实例。
 *
 * 版面：页头 → 「当前生效」条 → 来源表 → 模型表 → 后台任务；细节进右侧抽屉（同一时刻最多一个），
 * 挑选器是模态；保存条只在有未保存修改 / 保存失败 / 刚保存完时出现。
 *
 * 「先测试才能存」的门槛已删除：服务端保存时现场探测是唯一的门 —— 确定性失败拦（回结构化 `probe`，
 * 这里把来源行、模型行、保存条一起标出），瞬时失败照存并给一句提醒。这里只做与 validateConfig
 * 同源的结构性预检（logic.ts::saveBlockers）。
 */
import { useEffect, useState } from "react";
import { useLocale, useT } from "../../i18n";
import {
  fetchLlmConfig, putLlmConfig, fetchLlmCandidates, putBedrockKey, testLlmModel, fetchLlmAudit,
  rollbackLlmConfig, fetchBackendTasks, putGateway, fetchGatewayModels,
  type AdminApiError, type BackendTaskRow, type GatewayModelList, type LlmCandidate, type LlmConfig,
  type LlmModelEntry, type LlmSaveProbe, type LlmSource, type ModelKind, type ModelSurface,
} from "../../api/admin";
import { gatewayHost, imSource, inFamily, isGateway, moveSource, resolvedDefaults } from "../modelSources";
import {
  appendWithDefault, applyGatewaySelection, blockerText, candidateRegion, draftChanges, draftFromConfig,
  draftSignature, moreId, nameId, newBedrockEntry, saveBlockers, summarizeChanges, surfaceModel,
  testLabel, testSummary, type Defaults,
} from "./logic";
import { useContentLeft } from "./useContentLeft";
import PageHeader from "./PageHeader";
import StatusStrip from "./StatusStrip";
import SourceTable from "./SourceTable";
import ModelTable from "./ModelTable";
import BackendTasks from "./BackendTasks";
import ModelDrawer from "./ModelDrawer";
import GatewayDrawer from "./GatewayDrawer";
import ApiKeyDrawer from "./ApiKeyDrawer";
import AuditDrawer, { type AuditEntry } from "./AuditDrawer";
import GatewayPicker from "./GatewayPicker";
import BedrockPicker from "./BedrockPicker";
import SaveBar, { type SaveBarState } from "./SaveBar";

type Msg = { ok: boolean; text: string };
/** 一次来源测试：结果 + 测的是哪一条（换了默认模型就不再算数）。 */
type SrcProbe = { alias: string; model_id: string; result: string };
/** 抽屉；`from` = 关闭后焦点回到哪个元素（id）。从 ⋯ 菜单打开的回到该行 ⋯，点名称打开的回到名称。 */
type DrawerState = { kind: "model"; alias: string; from: string } | { kind: "gateway" } | { kind: "api_key" } | { kind: "audit" } | null;
/** 挑选器；`from` 同上（「+ 添加模型」/ 网关抽屉里的「管理网关模型」）。 */
type PickerState = { kind: "gateway" | "bedrock"; from: string } | null;
type SaveOpts = { keepSavedOrder?: boolean };
/** 保存失败。只在 `sig === 当前草稿签名` 时生效：草稿一改，失败标记自然消失（不用 effect 去清）。
 *  `opts` 记下那一次是怎么存的，「重试保存」照原样再来一次。 */
type SaveFail = { sig: string; probe?: LlmSaveProbe; message: string; conflict: boolean; opts?: SaveOpts };

export default function ModelsView() {
  const t = useT();
  // 英文标签长得多：styles.css 按语言给来源名 / 状态 / 任务名列不同的宽度（每行是独立 grid，列宽不能自适应内容）。
  const { locale } = useLocale();
  const tl = (r?: string, gateway = false) => testLabel(r, t, gateway);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const contentLeft = useContentLeft(rootEl);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [cfg, setCfg] = useState<LlmConfig | null>(null);
  /** 模型来源次序：只用第一个（2026-10）。 */
  const [order, setOrder] = useState<LlmSource[]>(["iam", "api_key", "gateway"]);
  /** 每个来源各自想用的默认模型（未收敛；收敛后的值见 `defaults`）。 */
  const [srcDefaults, setSrcDefaults] = useState<Defaults>({});
  const [models, setModels] = useState<LlmModelEntry[]>([]);
  const [tasks, setTasks] = useState<Record<string, string>>({});
  const [taskRows, setTaskRows] = useState<BackendTaskRow[]>([]);
  const [results, setResults] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState("");
  /** 最近一次探测**实际使用**的凭证（服务端回的 `credential`：api_key / iam）。
   *  用来把「已验证」说清楚 —— 选了 API Key 但 Key 是空的时，服务端会回退 IAM，
   *  此时绿勾证明的只是部署角色能调，与 Key 无关。 */
  const [probeCred, setProbeCred] = useState("");
  /** 每个来源最近一次「测试默认模型」的结果，连同**测的是哪一条**（alias + model_id）。
   *  只认与该来源此刻默认模型对得上的那一次：默认被换掉之后，旧的结果不再代表它。 */
  const [srcResults, setSrcResults] = useState<Partial<Record<LlmSource, SrcProbe>>>({});
  const [srcTesting, setSrcTesting] = useState<LlmSource[]>([]);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [picker, setPicker] = useState<PickerState>(null);
  /** 最近一次**单测**的模型：表里只有这一行显示「可用」（算那一下点击的回执）。 */
  const [soloAlias, setSoloAlias] = useState("");
  /** 跑过「全部测试」：按钮旁给一句汇总，代替逐行的「可用」。 */
  const [ranAll, setRanAll] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 草稿保存 / 回滚的请求在路上：改草稿的控件全部禁用，处理函数也直接忽略。
   *  否则途中改一处，失败回来时挂在旧签名上（`fail` 只认当前签名）—— 保存条只剩「N 处未保存」，原因被吞掉；
   *  成功时 `load()` 也会冲掉途中那一处。凭证保存不改草稿，不锁。 */
  const [draftLock, setDraftLock] = useState(false);
  const [saveFail, setSaveFail] = useState<SaveFail | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  /** 网关地址输入框：没动过（null）就跟着服务端的值走，管理员自己敲过就别被刷新覆盖。 */
  const [gwUrlEdit, setGwUrlEdit] = useState<string | null>(null);
  const [gwKey, setGwKey] = useState("");
  const [gwMsg, setGwMsg] = useState<Msg | null>(null);
  const [gwList, setGwList] = useState<GatewayModelList | null>(null);
  const [gwListing, setGwListing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [keyMsg, setKeyMsg] = useState<Msg | null>(null);
  const [candidates, setCandidates] = useState<LlmCandidate[]>([]);
  const [candWarn, setCandWarn] = useState("");
  /** 候选列表是用哪个身份枚举出来的（服务端 `source_identity`）。`iam_fallback` 必须显眼。 */
  const [candSource, setCandSource] = useState("");
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditMsg, setAuditMsg] = useState<Msg | null>(null);
  /** 读屏播报（次序变化）。 */
  const [liveMsg, setLiveMsg] = useState("");

  // ⚠️ `silent` 是给**首次加载**与保存后重读用的：`loading` 的初值已经是 true，那时再
  //    `setLoading(true)` 是冗余的同步 setState —— React 19 的 `react-hooks/set-state-in-effect`
  //    会报错。手动重载（409 冲突后「重新载入」）时仍然要设，否则点了没有反馈。
  const load = (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    fetchLlmConfig()
      .then((c) => {
        setCfg(c);
        const d = draftFromConfig(c);
        setOrder(d.order); setSrcDefaults(d.srcDefaults); setModels(d.models); setTasks(d.tasks);
        setLoadErr("");
      })
      .catch((e) => setLoadErr(String(e?.message || e)))
      .finally(() => setLoading(false));
    fetchBackendTasks().then((r) => setTaskRows(r.tasks)).catch(() => { /* 非关键：仅用于同步提示 */ });
  };
  // 🔴 **下面那条 disable 是针对规则误报的，不是偷懒。** 判据：`load` 的**同步执行路径上已经没有
  //    setState** 了（`silent: true` 跳过了唯一那一处）。剩下的 setState 全在 `.then/.catch/.finally`
  //    回调里 —— promise 回调是微任务，不在 effect 的同步路径上。规则的静态分析追进被调函数体、
  //    看到里面有 setState 就报，分不清同步与异步边界。
  // ⚠️ 不要用「把 setState 包一层骗过规则」的写法绕它 —— 那会让下一个人以为这里真有级联渲染问题。
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load({ silent: true }); }, []);

  // 成功提示 5 秒后自动消失；带提醒的保存要管理员自己关（setState 在定时器回调里，不在 effect 同步路径上）。
  useEffect(() => {
    if (notice?.kind !== "ok") return;
    const id = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(id);
  }, [notice]);

  /** 凭证保存（Bedrock Key / 网关）之后只刷新凭证状态，**不动**页面上未保存的目录、次序与默认。
   *  这两个接口不改目录；整页重载会把「拖到第一 → 打开设置填好 → 保存」这条引导路径上
   *  刚拖好的次序一起冲掉。并发保护在服务端（PUT /admin/llm-config 自己读 generation 比对）。 */
  const refreshCreds = (opts?: { gatewaySaved?: boolean }) => {
    fetchLlmConfig()
      .then((c) => {
        setCfg((p) => (p ? { ...p, gateway: c.gateway, bedrock_api_key: c.bedrock_api_key,
                              generation: c.generation, updated_by: c.updated_by, updated_at: c.updated_at } : c));
        // 刚存好网关：输入框改回跟随服务端（规整后的地址，如补上的 /v1）。
        if (opts?.gatewaySaved) setGwUrlEdit(null);
      })
      .catch(() => { /* 凭证已存好；状态刷新失败只是显示旧值，下次打开会再读 */ });
  };

  /* ───── 派生值 ───── */
  const cur = { order, srcDefaults, models, tasks };
  const saved = cfg ? draftFromConfig(cfg) : null;
  // 默认模型收敛到启用集内（取消启用 / 删掉当前默认时就近落到同家族第一个启用项）。用派生值而不是
  // useEffect+setState：读的时候算一次，保存时用的也是这份收敛后的值。
  const defaults = resolvedDefaults(models, srcDefaults);
  const active = order[0];
  const bedrockSrc = imSource(order);
  const savedOrder = saved?.order ?? order;
  /** 线上**真正在用**的来源 —— 「当前使用」只能标它。 */
  const savedActive = savedOrder[0];
  const savedDefaults = saved ? resolvedDefaults(saved.models, saved.srcDefaults) : defaults;
  const sig = draftSignature(cur);
  const dirty = saved ? sig !== draftSignature(saved) : false;
  const changes = saved ? draftChanges(saved, cur) : [];
  const blockers = saveBlockers({ models, order, defaults, cfg });
  // 「只保存模型改动」发的是**已保存的次序**：草稿在那个次序下不一定成立（网关排第一时取消了 Bedrock 条目的 Web），
  // 同一套预检对它再算一遍，不成立就不发（否则拿到 validateConfig 的英文 400，「重试」也必然再失败）。
  const keepBlockers = order[0] !== savedOrder[0] ? saveBlockers({ models, order: savedOrder, defaults, cfg }) : [];
  const fail = saveFail && saveFail.sig === sig ? saveFail : null;
  const srcName = (s: LlmSource) => t(`admin.models.src.${s}`);
  const gwUrl = gwUrlEdit ?? (cfg?.gateway?.base_url || "");
  // 清除凭证按**已保存**的次序判断（服务端也是）：拖动但没保存不改变线上在用的是谁。
  const keyInUse = savedActive === "api_key" || (savedActive === "gateway" && imSource(savedOrder) === "api_key");
  const gatewayInUse = savedActive === "gateway";
  const gwHost = gatewayHost(cfg?.gateway?.base_url);
  /** 该来源**此刻默认模型**的测试结果；测的不是这一条（默认被换掉了）就当没测过。 */
  const srcResult = (s: LlmSource): string | undefined => {
    const r = srcResults[s];
    const m = models.find((x) => x.alias === defaults[s]);
    return r && m && r.alias === m.alias && r.model_id === m.model_id ? r.result : undefined;
  };
  // 用户真正能选到的是**各端所用来源家族**的启用项。
  const webCount = models.filter((m) => m.enabled && m.surfaces.includes("webchat") && inFamily(m, active)).length;
  const imCount = models.filter((m) => m.enabled && m.surfaces.includes("im") && inFamily(m, bedrockSrc)).length;

  /* ───── 草稿编辑（draftLock 时一律忽略：控件已禁用，这里兜住键盘 / 已打开的浮层这些旁路）───── */
  const patch = (alias: string, p: Partial<LlmModelEntry>) => {
    if (draftLock) return;
    setModels((prev) => prev.map((m) => (m.alias === alias ? { ...m, ...p } : m)));
  };
  const toggleSurface = (m: LlmModelEntry, s: ModelSurface) =>
    patch(m.alias, { surfaces: m.surfaces.includes(s) ? m.surfaces.filter((x) => x !== s) : [...m.surfaces, s] });
  const setDefault = (s: LlmSource, alias: string) => {
    if (!draftLock) setSrcDefaults((p) => ({ ...p, [s]: alias }));
  };
  const setTask = (k: string, v: string) => {
    if (!draftLock) setTasks((p) => ({ ...p, [k]: v }));
  };

  /** 拖拽与键盘共用；给读屏播报新位置。 */
  const move = (from: number, to: number) => {
    const s = order[from];
    if (draftLock || !s || to < 0 || to >= order.length || from === to) return;
    setOrder((o) => moveSource(o, from, to));
    setLiveMsg(t("admin.models.movedTo").replace("{source}", srcName(s)).replace("{n}", String(to + 1)));
  };

  /** 删条目，连带清掉它的测试结果；删的是默认时那些来源改用所选的新默认。 */
  const removeEntry = (alias: string, nd?: { sources: LlmSource[]; alias: string }) => {
    if (draftLock) return;
    setModels((prev) => prev.filter((x) => x.alias !== alias));
    setResults((p) => { const n = { ...p }; delete n[alias]; return n; });
    // 指向它的默认：有接替的就换成接替的；没有就清掉，免得以后同名 alias 加回来时悄悄成为默认。
    setSrcDefaults((p) => {
      const n: Defaults = { ...p };
      for (const s of Object.keys(n) as LlmSource[]) if (n[s] === alias) delete n[s];
      if (nd) for (const s of nd.sources) n[s] = nd.alias;
      return n;
    });
    setDrawer((d) => (d?.kind === "model" && d.alias === alias ? null : d));
    // 那一行没了：焦点落到表格里**此刻显示着**的相邻行（它的 ⋯；按 DOM 顺序，分段 / 搜索 / 折叠都算进去），
    // 一行都不剩就落到表格搜索框，别掉回 <body>。其余行的节点有 key，删完还是同一个元素。
    const btns = Array.from(document.querySelectorAll<HTMLElement>(".mdl-tbl .mdl-more"));
    const i = btns.findIndex((b) => b.id === moreId(alias));
    const next = i >= 0 ? (btns[i + 1] ?? btns[i - 1]) : undefined;
    requestAnimationFrame(() => {
      (next && document.contains(next) ? next : document.getElementById("mdl-model-search"))?.focus();
    });
  };

  const append = (entry: LlmModelEntry) => {
    if (draftLock) return;
    const r = appendWithDefault(models, srcDefaults, entry);
    setModels(r.models); setSrcDefaults(r.srcDefaults);
  };
  const taken = (a: string) => models.some((m) => m.alias === a);
  const addFromCandidate = (c: LlmCandidate) => {
    append(newBedrockEntry(c.model_id, c.label || c.model_id, c.kind, candidateRegion(c), taken));
    setPicker(null);
  };
  /** 手填 model_id。候选枚举列不出来时（跨账号 Key 指向的模型不在本账号候选里、或
   *  ListFoundationModels 无权限）这是唯一入口。 */
  const addManual = (id: string, label: string) => {
    const kind: ModelKind = /anthropic/i.test(id) ? "bedrock_anthropic" : "bedrock_converse";
    append(newBedrockEntry(id, label || id, kind, null, taken));
    setPicker(null);
  };
  const applyGateway = (selected: string[]) => {
    if (draftLock) { setPicker(null); return; }
    const r = applyGatewaySelection(models, srcDefaults, selected);
    const gone = new Set(models.filter((m) => isGateway(m) && r.removed.includes(m.model_id)).map((m) => m.alias));
    setModels(r.models); setSrcDefaults(r.srcDefaults);
    setResults((p) => Object.fromEntries(Object.entries(p).filter(([a]) => !gone.has(a))));
    setPicker(null);
  };

  const loadCandidates = () => {
    if (candidates.length) return;
    fetchLlmCandidates()
      .then((r) => { setCandidates(r.models || []); setCandWarn(r.warning || ""); setCandSource(r.source_identity || ""); })
      .catch((e) => setCandWarn(String(e?.message || e)));
  };
  const listGateway = async () => {
    setGwListing(true);
    try { setGwList(await fetchGatewayModels()); }
    catch { setGwList({ result: "error", models: [], hidden: [], total: 0 }); }
    finally { setGwListing(false); }
  };

  /* ───── 测试 ───── */
  /** 单模型探测 + 落状态。Bedrock 条目默认用**页面上**排在最前的 Bedrock 来源去验（未保存的次序也算）——
   *  那正是它保存后会被调用的方式；网关条目由服务端用已保存的网关连接信息去验。
   *  结论不写回目录：它依赖模型 × 区域 × 凭证 × 时刻，持久化就会变成一个过期的假绿。 */
  const runProbe = async (m: LlmModelEntry, source?: "iam" | "api_key") => {
    try {
      const r = await testLlmModel({ model_id: m.model_id, kind: m.kind, region: m.region || undefined,
                                     ...(isGateway(m) ? {} : { source: source || (bedrockSrc as "iam" | "api_key") }) });
      setResults((p) => ({ ...p, [m.alias]: r.result }));
      // 保存时没过的那一条现在测通了（比如网关补上了上游凭证）：失败态让位，保存条回到「保存」。
      if (r.result === "ok") setSaveFail((f) => (f?.probe?.alias === m.alias ? null : f));
      // 「用你的 Key 验过」和「用部署角色验过」是两个不同的保证；网关条目不参与这条提示。
      if (r.credential && r.credential !== "gateway") setProbeCred(r.credential);
    } catch {
      setResults((p) => ({ ...p, [m.alias]: "error" }));
    }
  };
  const test = async (m: LlmModelEntry, source?: "iam" | "api_key") => {
    setTesting(m.alias); setSoloAlias(m.alias);
    try { await runProbe(m, source); } finally { setTesting(""); }
  };
  /** 「全部测试」—— 这就是「这个 Key 能调哪些模型」的可行形态：AWS 没有按凭证列可调模型的 API。
   *  串行：并发打过去容易换回一片 throttled，那种假的失败比慢几秒更糟。 */
  const testAll = async () => {
    setSoloAlias(""); setRanAll(true);
    for (const m of models.filter((x) => x.enabled)) {
      setTesting(m.alias);
      await runProbe(m);
    }
    setTesting("");
  };
  /** 来源的「测试默认模型」：测该来源此刻的默认模型，用该来源自己的凭证。 */
  const testSource = async (src: LlmSource) => {
    const m = models.find((x) => x.alias === defaults[src]);
    if (!m) return;
    setSrcTesting((p) => [...p.filter((x) => x !== src), src]);
    const record = (result: string) => setSrcResults((p) => ({ ...p, [src]: { alias: m.alias, model_id: m.model_id, result } }));
    try {
      const r = await testLlmModel({ model_id: m.model_id, kind: m.kind, region: m.region || undefined,
                                     ...(src === "gateway" ? {} : { source: src }) });
      record(r.result);
      if (r.result === "ok") setSaveFail((f) => (f?.probe?.source === src ? null : f));
    } catch { record("error"); } finally { setSrcTesting((p) => p.filter((x) => x !== src)); }
  };

  /* ───── 凭证 ───── */
  const saveKey = async (clear: boolean) => {
    setSaving(true); setKeyMsg(null);
    try {
      await putBedrockKey(clear ? { clear: true } : { api_key: apiKey.trim() });
      setApiKey("");
      // 换了凭证，页面上那批测试结果就不再代表现在的状况 —— 清掉（只清 Bedrock 条目：网关条目不经这把 Key）。
      setKeyMsg({ ok: true, text: `${t("admin.models.saved")} · ${t("admin.models.keyChangedRetest")}` });
      setResults((p) => Object.fromEntries(Object.entries(p).filter(([a]) => models.some((m) => m.alias === a && isGateway(m)))));
      setProbeCred("");
      setSrcResults((p) => ({ ...p, api_key: undefined }));
      // 凭证换了：上一次保存失败的结论不再代表现在（失败态让位，保存条回到「保存」）。
      setSaveFail(null);
      refreshCreds();
    } catch (e) {
      setKeyMsg({ ok: false, text: String((e as Error)?.message || e) });
    } finally { setSaving(false); }
  };
  /** 保存网关地址 + Key。服务端先 GET {base}/models 验证（不花 token），过了才落库，顺手把这次
   *  拉到的模型列表带回来 —— 存完直接就能挑模型。 */
  const saveGateway = async (clear: boolean) => {
    setSaving(true); setGwMsg(null);
    try {
      const r = await putGateway(clear ? { clear: true }
        : { base_url: gwUrl.trim(), ...(gwKey.trim() ? { api_key: gwKey.trim() } : {}) });
      setGwKey("");
      if (!clear && r.models) setGwList({ result: "ok", models: r.models, hidden: r.hidden || [], total: r.total || 0 });
      else if (clear) setGwList(null);
      // 已写进 Secret、却没能推动 gateway_rev：运行中的 Agent 最多还会用旧设置 5 分钟，要让管理员知道。
      setGwMsg(r.warning ? { ok: false, text: t("admin.models.gw.savedNotPropagated") }
        : { ok: true, text: clear ? t("admin.models.saved") : t("admin.models.gw.saved") });
      // 换了网关：网关条目上的旧测试结果不再代表现在（可能已经是另一个网关）。
      setResults((p) => Object.fromEntries(Object.entries(p).filter(([a]) => !models.some((m) => m.alias === a && isGateway(m)))));
      setSrcResults((p) => ({ ...p, gateway: undefined }));
      setSaveFail(null);
      refreshCreds({ gatewaySaved: true });
    } catch (e) {
      const r = (e as AdminApiError)?.result;
      setGwMsg({ ok: false, text: r ? t("admin.models.gw.rejected").replace("{result}", tl(r, true)) : String((e as Error)?.message || e) });
    } finally { setSaving(false); }
  };

  /* ───── 保存 / 放弃 / 回滚 ───── */
  /** 服务端的 warning 是英文、给日志看的；把我们认得的两类（探测没验上 / 投影失败）换成本地化的一句。 */
  const savedNotice = (r: { warning?: string }): { kind: "ok" | "warn"; text: string } => {
    const w = r.warning || "";
    if (!w) return { kind: "ok", text: t("admin.models.saved") };
    const parts: string[] = [];
    // 两种措辞：「<what> <alias> could not be verified … (<result>)」与探测本身抛错时的
    // 「could not verify <what> <alias> (probe error)」—— 后者按 error 显示。
    const re = /(?:default_model|IM default) (\S+) could not be verified[^(]*\(([a-z_]+)\)|could not verify (?:default_model|IM default) (\S+) \(probe error\)/g;
    for (const m of w.matchAll(re)) {
      const alias = m[1] ?? m[3];
      const e = models.find((x) => x.alias === alias);
      parts.push(t("admin.models.savedWarnProbe").replace("{model}", e ? (isGateway(e) ? e.model_id : e.label || e.alias) : alias)
        .replace("{result}", tl(m[2] ?? "error", Boolean(e && isGateway(e)))));
    }
    if (/syncing to the backend config failed/.test(w)) parts.push(t("admin.models.outOfSync"));
    return { kind: "warn", text: parts.length ? parts.join(" ") : w };
  };

  const save = async (opts?: SaveOpts) => {
    // 按钮已禁用；这里再兜一次：按已保存次序不成立的草稿不发（服务端必拒，拒了还是一句英文）。
    if (opts?.keepSavedOrder && keepBlockers.length) return;
    const at = sig;
    // 「只保存模型改动」：次序沿用已保存的，第一来源与 default_model 跟着它。
    const o = opts?.keepSavedOrder ? savedOrder : order;
    setSaving(true); setDraftLock(true); setSaveFail(null); setNotice(null);
    try {
      const r = await putLlmConfig({
        provider: "bedrock", credential_mode: o[0], source_order: o, source_defaults: defaults,
        default_model: defaults[o[0]] || "", models,
        backend_tasks: Object.fromEntries(Object.entries(tasks).map(([k, v]) => [k, v || null])),
      });
      setNotice(savedNotice(r));
      load({ silent: true });
    } catch (e) {
      // 409 = 有人先改了：提示重新载入，避免把对方的改动覆盖掉。服务端带了 `probe`（保存时现场探测没过）
      // 就把来源行、模型行、保存条一起标出。
      const err = e as AdminApiError;
      // 保存期间草稿是锁住的，`at` 就是当前签名：失败一定显示得出来。
      setSaveFail({ sig: at, probe: err.probe, message: String(err.message || e), conflict: err.status === 409, opts });
    } finally { setSaving(false); setDraftLock(false); }
  };
  const discard = () => {
    if (!saved) return;
    setOrder(saved.order); setSrcDefaults(saved.srcDefaults); setModels(saved.models); setTasks(saved.tasks);
    setSaveFail(null); setNotice(null);
  };
  const focusDefault = (s: LlmSource) => {
    setDrawer(null);
    requestAnimationFrame(() => {
      const el = document.getElementById(`src-default-${s}`);
      el?.scrollIntoView?.({ block: "center" });
      el?.focus();
    });
  };
  const openAudit = () => {
    if (drawer?.kind === "audit") { setDrawer(null); return; }
    setDrawer({ kind: "audit" }); setAuditMsg(null); setAuditLoading(true);
    fetchLlmAudit().then((r) => setAudit(r.entries || [])).catch(() => setAudit([])).finally(() => setAuditLoading(false));
  };
  const doRollback = async (sk: string) => {
    // 回滚成功后整页重读，途中改的草稿会被冲掉 —— 同样锁住。
    setSaving(true); setDraftLock(true); setAuditMsg(null);
    try {
      const r = await rollbackLlmConfig(sk);
      setNotice(savedNotice(r));
      setDrawer(null);
      load({ silent: true });
    } catch (e) {
      const err = e as AdminApiError;
      setAuditMsg({ ok: false, text: err.probe
        ? t("admin.models.rollbackProbeFailed").replace("{source}", srcName(err.probe.source))
          .replace("{result}", tl(err.probe.result, err.probe.source === "gateway"))
        : String(err.message || e) });
    } finally { setSaving(false); setDraftLock(false); }
  };

  if (!cfg) {
    return (
      <div className="mdl" data-lang={locale} ref={setRootEl}>
        <PageHeader cfg={null} onAudit={openAudit} auditOpen={false} />
        <div className={loadErr ? "mdl-errtxt" : "mdl-mut"}>{loading || !loadErr ? t("admin.models.loading") : loadErr}</div>
      </div>
    );
  }

  const failProbe = fail?.probe;
  const savedModels = saved?.models || [];
  const drawerModel = drawer?.kind === "model" ? models.find((m) => m.alias === drawer.alias) : undefined;

  let bar: SaveBarState | null = null;
  if (fail) {
    bar = { mode: "fail", probe: fail.probe, message: fail.message, conflict: fail.conflict,
            keepOrder: active !== savedActive ? savedActive : null, keepBlocked: keepBlockers.map((b) => blockerText(b, t)), saving,
            onChangeDefault: () => fail.probe && focusDefault(fail.probe.source),
            onKeepOrder: () => save({ keepSavedOrder: true }), onRetry: () => save(fail.opts),
            onReload: () => { setSaveFail(null); load(); }, onDiscard: discard };
  } else if (dirty) {
    bar = { mode: "dirty", count: Math.max(1, changes.length), summary: summarizeChanges(changes, t), gwFirst: active === "gateway",
            blockers: blockers.map((b) => blockerText(b, t)), saving, locked: draftLock, onDiscard: discard, onSave: () => save() };
  } else if (notice) {
    bar = { mode: "notice", kind: notice.kind, text: notice.text, onClose: () => setNotice(null) };
  }

  return (
    <div className="mdl" data-lang={locale} ref={setRootEl}>
      <PageHeader cfg={cfg} onAudit={openAudit} auditOpen={drawer?.kind === "audit"} />
      <StatusStrip
        liveWeb={{ source: savedActive, model: surfaceModel(savedModels, savedDefaults, savedActive, "webchat") }}
        liveIm={{ source: imSource(savedOrder), model: surfaceModel(savedModels, savedDefaults, imSource(savedOrder), "im") }}
        nextWeb={{ source: active, model: surfaceModel(models, defaults, active, "webchat") }}
        nextIm={{ source: bedrockSrc, model: surfaceModel(models, defaults, bedrockSrc, "im") }} />
      <SourceTable order={order} savedActive={savedActive} defaults={defaults} models={models} cfg={cfg}
        failSource={failProbe?.source} failResult={failProbe?.result} srcResult={srcResult}
        openSource={drawer?.kind === "gateway" || drawer?.kind === "api_key" ? drawer.kind : null} locked={draftLock}
        onMove={move} onDefault={setDefault} onOpen={(s) => setDrawer({ kind: s })} liveMsg={liveMsg} />
      <ModelTable models={models} savedAliases={new Set(savedModels.map((m) => m.alias))} defaults={defaults} active={active}
        results={results} soloAlias={soloAlias} summary={ranAll ? testSummary(models, results) : null}
        testing={testing} failAlias={failProbe?.alias} failResult={failProbe?.result}
        curAlias={drawerModel?.alias} gatewayConfigured={Boolean(cfg.gateway?.configured)}
        webCount={webCount} imCount={imCount} locked={draftLock}
        probeNote={probeCred && probeCred !== "gateway" ? {
          text: t(probeCred === "api_key" ? "admin.models.probedWithKey" : "admin.models.probedWithRole"),
          tip: t(probeCred === "api_key" ? "admin.models.probedWithKeyTip" : "admin.models.probedWithRoleTip"),
          // 只在「该用 Key 却用了部署角色」时标红；Bedrock 来源本来就是 IAM 时这是如实陈述。
          warn: probeCred !== "api_key" && bedrockSrc === "api_key",
        } : null}
        onToggleEnabled={(a, v) => patch(a, { enabled: v })} onToggleSurface={toggleSurface}
        onOpen={(a, from) => setDrawer({ kind: "model", alias: a, from: from === "menu" ? moreId(a) : nameId(a) })}
        onTest={(m) => test(m)} onTestAll={testAll}
        onSetDefault={setDefault} onRemove={removeEntry}
        onAddBedrock={() => { setPicker({ kind: "bedrock", from: "mdl-add-btn" }); loadCandidates(); }}
        onAddGateway={() => { setPicker({ kind: "gateway", from: "mdl-add-btn" }); if (gwList?.result !== "ok") listGateway(); }} />
      <BackendTasks tasks={tasks} setTask={setTask} taskRows={taskRows} locked={draftLock}
        models={models} defaults={defaults} active={active}
        saved={saved ? { models: saved.models, defaults: savedDefaults, active: savedActive, tasks: saved.tasks } : null} />

      {drawerModel && (
        <ModelDrawer key={drawerModel.alias} m={drawerModel} models={models} defaults={defaults} bedrockSrc={bedrockSrc}
          keyConfigured={Boolean(cfg.bedrock_api_key?.configured)} gwHost={gwHost}
          result={results[drawerModel.alias]} testing={testing === drawerModel.alias} locked={draftLock}
          onPatch={(p) => patch(drawerModel.alias, p)} onToggleSurface={(s) => toggleSurface(drawerModel, s)}
          onTest={(src) => test(drawerModel, src)} onRemove={(nd) => removeEntry(drawerModel.alias, nd)}
          returnFocus={() => document.getElementById(drawer?.kind === "model" ? drawer.from : "")}
          onClose={() => setDrawer(null)} />
      )}
      {drawer?.kind === "gateway" && (
        <GatewayDrawer cfg={cfg} url={gwUrl} setUrl={setGwUrlEdit} keyVal={gwKey} setKey={setGwKey} saving={saving} locked={draftLock} msg={gwMsg}
          inUse={gatewayInUse} models={models} defaultAlias={defaults.gateway} onDefault={(a) => setDefault("gateway", a)}
          onSave={saveGateway}
          onManage={() => { setPicker({ kind: "gateway", from: "mdl-gw-manage" }); if (gwList?.result !== "ok") listGateway(); }}
          testResult={srcResult("gateway")} testing={srcTesting.includes("gateway")} onTest={() => testSource("gateway")}
          returnFocus={() => document.getElementById("src-settings-gateway")}
          onClose={() => { setDrawer(null); setGwMsg(null); }} />
      )}
      {drawer?.kind === "api_key" && (
        <ApiKeyDrawer cfg={cfg} keyVal={apiKey} setKey={setApiKey} saving={saving} locked={draftLock} msg={keyMsg} inUse={keyInUse}
          models={models} defaultAlias={defaults.api_key} onDefault={(a) => setDefault("api_key", a)} onSave={saveKey}
          testResult={srcResult("api_key")} testing={srcTesting.includes("api_key")} onTest={() => testSource("api_key")}
          returnFocus={() => document.getElementById("src-settings-api_key")}
          onClose={() => { setDrawer(null); setKeyMsg(null); }} />
      )}
      {drawer?.kind === "audit" && (
        <AuditDrawer entries={audit} loading={auditLoading} saving={saving} msg={auditMsg} onRollback={doRollback}
          returnFocus={() => document.getElementById("mdl-audit-btn")} onClose={() => setDrawer(null)} />
      )}
      {picker?.kind === "gateway" && (
        <GatewayPicker host={gwHost} list={gwList} listing={gwListing} models={models}
          returnFocus={() => document.getElementById(picker.from)}
          defaultModelId={models.find((m) => m.alias === defaults.gateway)?.model_id}
          onRetry={listGateway} onCancel={() => setPicker(null)} onDone={applyGateway} />
      )}
      {picker?.kind === "bedrock" && (
        <BedrockPicker candidates={candidates} candWarn={candWarn} candSource={candSource} models={models}
          returnFocus={() => document.getElementById(picker.from)}
          onRetry={() => { setCandWarn(""); loadCandidates(); }} onAddCandidate={addFromCandidate} onAddManual={addManual}
          onClose={() => setPicker(null)} />
      )}
      {bar && <SaveBar state={bar} left={contentLeft} withDrawer={Boolean(drawer)} />}
    </div>
  );
}
