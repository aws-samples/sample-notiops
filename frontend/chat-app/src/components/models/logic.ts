/**
 * 管理 → 模型页（2026-10 改版 A）的纯逻辑。组件文件里只留渲染（react-refresh 规则：
 * 组件文件不放非组件导出），这里的每个函数都能被 vitest 直接测。
 *
 * 规则来源：服务端 `bff/web-chat/llm_config.mjs`（validateConfig / backendTaskEntry /
 * probeBeforeWrite）与 `../modelSources.ts`。**服务端仍是唯一权威**：这里的预检只做与
 * validateConfig 同源的结构性判断，不设任何「先测试才能存」的门槛 —— 保存时的现场探测在服务端。
 */
import type {
  LlmCandidate, LlmConfig, LlmModelEntry, LlmProbeResult, LlmSource, ModelKind, ModelSurface,
} from "../../api/admin";
import {
  SOURCES, GATEWAY_MODEL_ID_RE, imSource, inFamily, isGateway, matchesQuery, newGatewayEntry,
  normalizeOrder, resolvedDefaults,
} from "../modelSources";

type TFn = (key: string) => string;

/** 行内元素的 id（还焦点用：删除浮层取消后回 ⋯、抽屉关闭后回打开它的那个按钮）。 */
export const moreId = (alias: string) => `mdl-more-${alias}`;
export const nameId = (alias: string) => `mdl-name-${alias}`;
export type Defaults = Partial<Record<LlmSource, string>>;

/** 探测结果 → i18n key（无中文字面量）。 */
export const TEST_KEY: Record<LlmProbeResult, string> = {
  ok: "admin.models.test.ok", forbidden: "admin.models.test.forbidden",
  unauthorized: "admin.models.test.unauthorized", invalid_model: "admin.models.test.invalidModel",
  // 网关认这把 Key（GET /models 能列），但网关调这个模型的上游时没有授权 —— 不是「凭证无效」
  upstream_auth: "admin.models.test.upstreamAuth",
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
  // 网关 / 来源测试（2026-10）
  no_tools: "admin.models.test.noTools", not_configured: "admin.models.test.notConfigured",
  unreachable: "admin.models.test.unreachable", redirect: "admin.models.test.redirect",
  bad_response: "admin.models.test.badResponse", blocked_host: "admin.models.test.blockedHost",
};

/** 网关条目 / 网关来源另有说法的结果：网关对最小请求回 400 / 422 是确定性的、会拦保存，
 *  不能沿用 Bedrock 那句「疑似本系统的探测请求有问题，请反馈」。 */
const GATEWAY_TEST_KEY: Partial<Record<string, string>> = { probe_error: "admin.models.test.gwProbeError" };

/** 标签之外的整句说明（悬停 / 保存条 ⓘ）。标签要放进 22px 高的标签里，一律是短词；
 *  原来写成整句的那几个，句子挪到这里。 */
const TIP_KEY: Partial<Record<string, string>> = {
  upstream_auth: "admin.models.test.upstreamAuthTip", needs_profile: "admin.models.test.needsProfileTip",
  probe_error: "admin.models.test.probeErrorTip", redirect: "admin.models.test.redirectTip",
  bad_response: "admin.models.test.badResponseTip",
};
const GATEWAY_TIP_KEY: Partial<Record<string, string>> = { probe_error: "admin.models.test.gwProbeErrorTip" };

/** 结果的本地化标签（短词）；未知值回退原文。`gateway` = 网关条目 / 网关来源。 */
export function testLabel(r: string | undefined, t: TFn, gateway = false): string {
  if (!r) return "";
  const k = (gateway && GATEWAY_TEST_KEY[r]) || (TEST_KEY as Record<string, string>)[r];
  return k ? t(k) : r;
}

export const MODEL_SURFACES: ModelSurface[] = ["webchat", "im"];

/** 「确定性失败」—— 与服务端 HARD_FAIL_PROBE_RESULTS / GATEWAY_HARD_FAIL 对齐（含 upstream_auth：
 *  Key 有效但上游没授权，每一轮都会撞同一堵墙）。其余（限流 / 超时 / error / probe_error）只说明
 *  这一次没问对上，不代表这个模型不能用。改版后它的读点是 `resultTone`：决定标红还是标琥珀。 */
export const HARD_FAIL_RESULTS = new Set<string>([
  "invalid_model", "not_found", "forbidden", "unauthorized", "needs_profile", "not_configured",
  "no_tools", "blocked_host", "redirect", "bad_response", "unreachable", "upstream_auth",
]);

/** 网关条目多一条 `probe_error`：网关对最小请求回 400 / 422 是确定性的（服务端 GATEWAY_HARD_FAIL
 *  会拦保存）；Bedrock 那边的 probe_error 是探测参数自己被拒，只算瞬时。 */
export const GATEWAY_HARD_FAIL_RESULTS = new Set<string>([...HARD_FAIL_RESULTS, "probe_error"]);

/** 测试结果的色调：确定性失败 → 红，可用 → 绿，其余（瞬时）→ 琥珀。`gateway` = 网关条目 / 网关来源。 */
export function resultTone(r: string, gateway = false): "ok" | "err" | "warn" {
  if (r === "ok") return "ok";
  return (gateway ? GATEWAY_HARD_FAIL_RESULTS : HARD_FAIL_RESULTS).has(r) ? "err" : "warn";
}

/** 结果标签的悬停说明：有整句说明的用它（upstream_auth 说清楚「Key 有效、缺的是网关的上游凭证」），
 *  其余就是标签本身。 */
export function resultTip(r: string | undefined, t: TFn, gateway = false): string {
  if (!r) return "";
  const k = (gateway && GATEWAY_TIP_KEY[r]) || TIP_KEY[r];
  return k ? t(k) : testLabel(r, t, gateway);
}

/** 「全部测试」之后按钮旁那句汇总：启用条目里测过的，可用几个、没通过几个。没有结果 → null。 */
export function testSummary(models: LlmModelEntry[], results: Record<string, string>): { ok: number; bad: number } | null {
  let ok = 0, bad = 0;
  for (const m of models) {
    const r = m.enabled ? results[m.alias] : undefined;
    if (!r) continue;
    if (r === "ok") ok++; else bad++;
  }
  return ok + bad ? { ok, bad } : null;
}

// 服务端没下发 default_region 时的兜底（老版本 BFF / 响应被裁剪）。与 BFF 的
// MANTLE_REGION_DEFAULT、Python 的 _MANTLE_REGION_DEFAULT 是同一个值；
// scripts/test_mantle_regions_consistent.py 会断言三处一致。
const MANTLE_REGION_FALLBACK = "us-east-2";

/** 从候选添加时的区域：Mantle 用服务端下发的 `default_region`，**不要退回名单的第一个** ——
 *  那个名单按区域名排序，扩容时谁排第一会变。实际发生过：名单从 2 个区扩到 14 个区后，
 *  按位置取把默认区从 us-east-2 静默变成 us-east-1，而 runtime 的 IAM 当时只授了
 *  us-east-2/us-west-2，于是配置存得进去、聊天时才 403。非 Mantle 条目没有区域。 */
export function candidateRegion(c: Pick<LlmCandidate, "kind" | "default_region">): string | null {
  return c.kind === "bedrock_mantle_responses" ? (c.default_region || MANTLE_REGION_FALLBACK) : null;
}

/** model_id → 建议 alias（[a-z0-9-]）。仅作预填，管理员可改。 */
export function suggestAlias(modelId: string): string {
  return modelId.replace(/^[a-z]+\.(anthropic|openai|amazon|deepseek|meta|mistral)\./i, "")
    .replace(/^(anthropic|openai|amazon|deepseek|meta|mistral)\./i, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "model";
}

/**
 * 路由范围（= 数据驻留范围）→ i18n key。
 *
 * 这是数据驻留的**实际决定因素**，而管理员在界面上看到的只是一串不透明的 model_id。
 * Bedrock 的跨区推理配置文件把范围编码进了前缀：`global.` 路由到全球所有支持的商业
 * 区域，`us.` / `eu.` / `apac.` 限制在对应地理范围内，无前缀则跟随部署区域。
 * 也就是说「换成 us.anthropic.claude-sonnet-5」就是一次数据驻留变更 —— 把它显示出来，
 * 管理员才是在做知情选择，而不是在改一个看不懂的字符串。
 * https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html
 *
 * `scope` 优先用服务端给的值（`LlmCandidate.scope`，由 BFF 的 `routingScope()` 算出）。
 * 只在没有它时才按 model_id 前缀回推 —— 目录里已保存的条目不带 scope 字段，所以回推路径
 * 必须留着。
 *
 * ⚠️ `kind` 参数不能省：Mantle（GPT 系）的 model_id **没有地理前缀**
 * （`openai.gpt-5.6-terra`），按前缀回推会得到「本区域」，而它实际打的是
 * `bedrock-mantle.us-east-2.api.aws` —— 在东京部署上，恰好是真正跨了边界的那批模型被标成
 * "不跨区"。数据驻留标签给错答案比不给更危险，所以按 kind 显式判定。
 */
export function routingScopeKey(modelId: string, opts?: { scope?: string; kind?: string }): string {
  const scope = opts?.scope;
  // 网关条目的数据去向由网关自己的路由决定，我们看不到 —— 如实说「经网关」，不按 id 前缀猜
  // （LiteLLM 的 `bedrock/global.anthropic…` 会被前缀回推误判成全球路由的 Bedrock）。
  if (opts?.kind === "openai_compatible") return "admin.models.routing.gateway";
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
export const PROVIDER_ORDER = ["Anthropic", "Amazon", "OpenAI", "DeepSeek", "Meta", "Mistral AI"];

/** 候选排序：厂商优先级 → 组内跨区域 profile 优先（本目录默认用 global.*）→ 名称。
 *  同一个模型会同时以基座（`anthropic.claude-sonnet-5`）和 profile
 *  （`global.anthropic.claude-sonnet-5`）两种形式出现，profile 排在前面，避免管理员
 *  选了本区域形式却与目录里实际生效的 ID 不一致。 */
export function sortCandidates(list: LlmCandidate[]): LlmCandidate[] {
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
export function candMatches(c: LlmCandidate, query: string): boolean {
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
export function candTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/[\s\-_.]+/).filter(Boolean);
}

/* ───────────────── 草稿 ───────────────── */

/** 页面上的可编辑状态。与已保存配置比较就知道「改了几处」。 */
export interface Draft {
  order: LlmSource[];
  /** 每个来源各自想用的默认（未收敛；收敛后的值用 resolvedDefaults 算）。 */
  srcDefaults: Defaults;
  models: LlmModelEntry[];
  tasks: Record<string, string>;
}

/** 已保存配置 → 草稿。第一来源那一格以 default_model 为准（升级前的配置只有它）。 */
export function draftFromConfig(c: LlmConfig): Draft {
  const order = normalizeOrder(c.source_order, c.credential_mode);
  const tasks: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.backend_tasks || {})) tasks[k] = String(v || "");
  return {
    order,
    srcDefaults: { ...(c.source_defaults || {}), [order[0]]: c.default_model || c.source_defaults?.[order[0]] },
    models: c.models.map((m) => ({ ...m })),
    tasks,
  };
}

/** 键排序后的 JSON：条目被 patch 过之后字段顺序可能不同，内容相同就该算同一份。 */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const liveTasks = (t: Record<string, string>) =>
  Object.fromEntries(Object.entries(t).filter(([, v]) => Boolean(v)));

/** 草稿签名：次序 + 收敛后的默认 + 目录 + 后台任务。签名相同 = 没有未保存的修改。
 *  保存失败标记也挂在签名上：草稿一改，签名变了，失败标记自然失效（不用 effect 去清）。 */
export function draftSignature(d: Draft): string {
  return canon({ o: d.order, d: resolvedDefaults(d.models, d.srcDefaults), m: d.models, t: liveTasks(d.tasks) });
}

export type DraftChange =
  | { kind: "order" }
  | { kind: "default"; source: LlmSource }
  | { kind: "added"; alias: string; gateway: boolean }
  | { kind: "removed"; alias: string }
  | { kind: "edited"; alias: string }
  | { kind: "task"; task: string };

/**
 * 已保存 → 草稿之间的修改清单（保存条上的「N 处未保存的修改」）。
 *   · 次序变了算 1
 *   · 每个新增 / 删除 / 字段有变的条目各算 1
 *   · 某来源的默认：只在「已保存时它有默认、草稿里换成了别的、且原默认仍是可选的启用条目」时算 1。
 *     新增模型顺带成为默认、或停用 / 删掉原默认导致默认挪走，都只是那次改动的后果，不重复计数
 *     （A-1 的「3 处」= 次序 + 2 个新增）
 *   · 每个变了的后台任务算 1
 */
export function draftChanges(saved: Draft, cur: Draft): DraftChange[] {
  const out: DraftChange[] = [];
  if (saved.order.join() !== cur.order.join()) out.push({ kind: "order" });
  const sd = resolvedDefaults(saved.models, saved.srcDefaults);
  const cd = resolvedDefaults(cur.models, cur.srcDefaults);
  for (const s of SOURCES) {
    const was = sd[s];
    if (!was || cd[s] === was) continue;
    const still = cur.models.find((m) => m.alias === was);
    if (still && still.enabled && inFamily(still, s)) out.push({ kind: "default", source: s });
  }
  const savedBy = new Map(saved.models.map((m) => [m.alias, m]));
  const curBy = new Map(cur.models.map((m) => [m.alias, m]));
  for (const m of cur.models) {
    const prev = savedBy.get(m.alias);
    if (!prev) out.push({ kind: "added", alias: m.alias, gateway: isGateway(m) });
    else if (canon(prev) !== canon(m)) out.push({ kind: "edited", alias: m.alias });
  }
  for (const m of saved.models) if (!curBy.has(m.alias)) out.push({ kind: "removed", alias: m.alias });
  const st = liveTasks(saved.tasks), ct = liveTasks(cur.tasks);
  for (const k of [...new Set([...Object.keys(st), ...Object.keys(ct)])].sort()) {
    if ((st[k] || "") !== (ct[k] || "")) out.push({ kind: "task", task: k });
  }
  return out;
}

/** 修改清单 → 保存条上那行摘要（「来源次序 · 新增 2 个网关模型」）。 */
export function summarizeChanges(changes: DraftChange[], t: TFn): string {
  const parts: string[] = [];
  const n = (k: DraftChange["kind"]) => changes.filter((c) => c.kind === k);
  if (n("order").length) parts.push(t("admin.models.bar.change.order"));
  if (n("default").length) parts.push(t("admin.models.bar.change.defaults"));
  const added = n("added") as Extract<DraftChange, { kind: "added" }>[];
  if (added.length) {
    parts.push(t(added.every((a) => a.gateway) ? "admin.models.bar.change.addedGw" : "admin.models.bar.change.added")
      .replace("{n}", String(added.length)));
  }
  if (n("removed").length) parts.push(t("admin.models.bar.change.removed").replace("{n}", String(n("removed").length)));
  if (n("edited").length) parts.push(t("admin.models.bar.change.edited").replace("{n}", String(n("edited").length)));
  if (n("task").length) parts.push(t("admin.models.bar.change.tasks"));
  return parts.join(" · ");
}

/* ───────────────── 结构性预检 ───────────────── */

/** 一条「还不能保存」的原因。只带 id，文案由 blockerText 渲染（保持这里不依赖 i18n 上下文）。 */
export interface Blocker { key: string; source?: LlmSource; surface?: ModelSurface; label?: string }

/** 来源本身配没配好：IAM 恒成立；Key / 网关看服务端回的状态。 */
export function sourceConfigured(s: LlmSource, cfg: Pick<LlmConfig, "bedrock_api_key" | "gateway"> | null): boolean {
  if (s === "iam") return true;
  if (s === "api_key") return Boolean(cfg?.bedrock_api_key?.configured);
  return Boolean(cfg?.gateway?.configured);
}

/**
 * 保存前的不变量预检 —— 与服务端 validateConfig 同源的那几条，**全是确定性的**。
 *
 * 为什么要在前端重复一遍：服务端拒绝是**正确**的，但让 400 成为管理员的第一次反馈是
 * 糟糕的交互 —— 他刚把模型加进列表、点保存，只看到一个 `http_400`。这里把同样的判断提前到
 * 点击之前，并直接指出该做什么。服务端校验仍是唯一权威（前端可被绕过）。
 *
 * 2026-10 改版：删掉了「换来源前先在那一行测试通过」那三条（needSourceTest / needSourceTestFailed /
 * needImSourceTest）。保存时服务端现场探测就是那道门 —— 确定性失败拦，瞬时失败照存 + 提示。
 * 这里不再出现任何依赖测试结果的判断。
 */
export function saveBlockers({ models, order, defaults, cfg }: {
  models: LlmModelEntry[]; order: LlmSource[]; defaults: Defaults;
  cfg: Pick<LlmConfig, "bedrock_api_key" | "gateway"> | null;
}): Blocker[] {
  const out: Blocker[] = [];
  const active = order[0];
  const im = imSource(order);
  // 第一来源本身要成立：Key / 网关没配好就排上去，等于让所有对话直接失败（不自动降级）。
  // 排在最前：来源没配好时，「先给它加个模型」不是该先做的那件事。
  if (!sourceConfigured(active, cfg)) out.push({ key: "admin.models.needSourceConfigured", source: active });
  // 网关排第一时 IM 用排在最前的 Bedrock 来源：它同样不能是一个没配好的 Key（运行时会静默退回
  // IAM —— 正是「不自动降级」要杜绝的）。
  if (active === "gateway" && im !== active && !sourceConfigured(im, cfg)) {
    out.push({ key: "admin.models.needImSourceConfigured", source: im });
  }
  if (models.length === 0) out.push({ key: "admin.models.needAtLeastOne" });
  else if (!models.some((m) => m.enabled)) out.push({ key: "admin.models.needEnabled" });
  else if (!defaults[active]) out.push({ key: "admin.models.needSourceModel", source: active });
  else {
    // 每个端至少一个启用模型：按该端**实际用的来源**数（网关排第一时 Web 要有网关模型，
    // IM 仍要有 Bedrock 模型）—— 与服务端同规则。
    for (const s of MODEL_SURFACES) {
      const src = s === "im" ? im : active;
      if (!models.some((m) => m.enabled && m.surfaces.includes(s) && inFamily(m, src))) {
        out.push({ key: s === "im" && active === "gateway" ? "admin.models.needSurfaceImBedrock" : "admin.models.needSurface", surface: s });
      }
    }
  }
  // 每个条目至少上一个端：服务端逐条校验 surfaces 非空，报错只带下标，管理员对不上是哪一行。
  for (const m of models) {
    if (!m.surfaces.length) out.push({ key: "admin.models.needEntrySurface", label: m.label || m.alias });
  }
  return out;
}

/** 预检原因 → 文案。 */
export function blockerText(b: Blocker, t: TFn): string {
  let s = t(b.key);
  if (b.source) s = s.replace("{source}", t(`admin.models.src.${b.source}`));
  if (b.surface) s = s.replace("{surface}", t(`admin.models.surface.${b.surface}`));
  if (b.label) s = s.replace("{label}", b.label);
  return s;
}

/* ───────────────── 后台任务 ───────────────── */

/**
 * 后台任务此刻（按给定的次序 / 默认）实际会用哪个条目 —— 逐条镜像 BFF `backendTaskEntry`
 * （`bff/web-chat/llm_config.mjs`），两边改一处要改两处：
 *   · 绑定的条目启用、且属于第一来源家族 → 用它
 *   · 第一来源是网关、而绑定项是 Bedrock 模型（或没绑定）→ 网关的默认模型（再退到第一个启用网关条目）
 *   · 第一来源是 Bedrock、绑定项是网关模型或没绑定 → null（后端走自己的 Bedrock 兜底 / 预置值）
 */
export function taskEffective(models: LlmModelEntry[], defaults: Defaults, active: LlmSource,
                              boundAlias: string): LlmModelEntry | null {
  const entry = boundAlias ? models.find((m) => m.alias === boundAlias) : undefined;
  if (entry && entry.enabled && inFamily(entry, active)) return entry;
  if (active !== "gateway") return null;
  const def = defaults.gateway;
  const gw = models.find((m) => m.alias === def && m.enabled && inFamily(m, "gateway"));
  return gw || models.find((m) => m.enabled && inFamily(m, "gateway")) || null;
}

/* ───────────────── 网关 ───────────────── */

const UPSTREAM_NAMES: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", bedrock: "Bedrock", bedrock_converse: "Bedrock",
  vertex_ai: "Vertex AI", vertex_ai_beta: "Vertex AI", gemini: "Gemini", azure: "Azure",
  azure_ai: "Azure AI", deepseek: "DeepSeek", groq: "Groq", mistral: "Mistral", cohere: "Cohere",
  xai: "xAI", openrouter: "OpenRouter", together_ai: "Together AI", fireworks_ai: "Fireworks AI",
  perplexity: "Perplexity", ollama: "Ollama", dashscope: "DashScope", moonshot: "Moonshot",
  sagemaker: "SageMaker", databricks: "Databricks", huggingface: "Hugging Face",
};

/** 网关模型名的上游供应商（LiteLLM 的 `provider/model` 写法）。认不出 → null，
 *  界面改用不点名的那句（fail.upstreamAuthGeneric），不瞎猜一个供应商名。 */
export function gatewayUpstreamName(modelId: string): string | null {
  const i = String(modelId || "").indexOf("/");
  if (i <= 0) return null;
  return UPSTREAM_NAMES[modelId.slice(0, i).toLowerCase()] || null;
}

/** 网关模型名按 `/` 前的首段分组（`anthropic/`）；没有 `/` 的进「其他」。组按名排序，「其他」垫底。 */
export function groupByPrefix(ids: string[], otherLabel: string): { name: string; ids: string[] }[] {
  const groups = new Map<string, string[]>();
  const other: string[] = [];
  for (const id of ids) {
    const i = id.indexOf("/");
    if (i <= 0) { other.push(id); continue; }
    const g = id.slice(0, i + 1);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(id);
  }
  const out = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => ({ name, ids: list }));
  if (other.length) out.push({ name: otherLabel, ids: other });
  return out;
}

/**
 * 网关挑选器「完成」：勾选集合与目录里的网关条目做差集，**增删对称**。
 *   · 勾上的、目录里没有 → 新条目（只上 Web，别名避撞）
 *   · 目录里有、被取消勾选 → 移出目录
 *   · Bedrock 条目原样
 * 默认：网关来源还没有默认 → 第一个新加的；原默认被移出 → 落到剩下的第一个启用网关条目。
 */
export function applyGatewaySelection(models: LlmModelEntry[], srcDefaults: Defaults, selected: string[]):
{ models: LlmModelEntry[]; srcDefaults: Defaults; added: string[]; removed: string[] } {
  const sel = new Set(selected);
  const kept = models.filter((m) => !isGateway(m) || sel.has(m.model_id));
  const removed = models.filter((m) => isGateway(m) && !sel.has(m.model_id)).map((m) => m.model_id);
  const have = new Set(kept.filter(isGateway).map((m) => m.model_id));
  // 被移出的条目的 alias 也算占用：同一次操作里回收它，会让原本指向它的默认悄悄换成另一个模型。
  const taken = new Set(models.map((m) => m.alias));
  const added: string[] = [];
  const next = [...kept];
  for (const id of selected) {
    if (have.has(id) || !GATEWAY_MODEL_ID_RE.test(id)) continue;
    const e = newGatewayEntry(id, (a) => taken.has(a));
    taken.add(e.alias); have.add(id);
    next.push(e); added.push(id);
  }
  const sd = { ...srcDefaults };
  const def = sd.gateway;
  if (def && !next.some((m) => m.alias === def)) sd.gateway = resolvedDefaults(next, { ...sd, gateway: undefined }).gateway;
  if (!resolvedDefaults(models, srcDefaults).gateway && added.length) {
    sd.gateway = next.find((m) => m.model_id === added[0] && isGateway(m))?.alias;
  }
  return { models: next, srcDefaults: sd, added, removed };
}

/* ───────────────── 添加 / 删除 ───────────────── */

/** 新 Bedrock 条目的公共骨架。上限给一个多数模型都安全的值，管理员可按该模型文档调高 ——
 *  设太低会静默截断回复，所以它在详情抽屉里可见可改。 */
export function newBedrockEntry(modelId: string, label: string, kind: ModelKind, region: string | null,
                                taken: (alias: string) => boolean): LlmModelEntry {
  let alias = suggestAlias(modelId);
  while (taken(alias)) alias = `${alias}-2`;
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
}

/** 追加一个条目并维持不变量：该家族的来源若还**没有任何默认**（收敛后也没有），这条就是默认。
 *  让「添加」这一个动作产生一个可直接保存的合法配置，而不是留待办给管理员。
 *  只在「没有」时才设 —— 已有默认（哪怕是收敛出来的）就不动，免得加一个模型顺手换掉别的来源的默认。 */
export function appendWithDefault(models: LlmModelEntry[], srcDefaults: Defaults, entry: LlmModelEntry):
{ models: LlmModelEntry[]; srcDefaults: Defaults } {
  const next = [...models, entry];
  const had = resolvedDefaults(models, srcDefaults);
  const sd = { ...srcDefaults };
  // Bedrock 条目同时是 iam 与 api_key 两个来源的候选。
  for (const s of (isGateway(entry) ? ["gateway"] : ["iam", "api_key"]) as LlmSource[]) {
    if (!had[s]) sd[s] = entry.alias;
  }
  return { models: next, srcDefaults: sd };
}

/** 这个条目是哪些来源的默认（收敛后的）。 */
export function defaultOf(alias: string, models: LlmModelEntry[], defaults: Defaults): LlmSource[] {
  const m = models.find((x) => x.alias === alias);
  if (!m) return [];
  return SOURCES.filter((s) => defaults[s] === alias && inFamily(m, s));
}

/** 删掉某来源的默认之前，能接替它的条目：同家族、启用、不是它自己。 */
export function replacementsFor(alias: string, models: LlmModelEntry[], sources: LlmSource[]): LlmModelEntry[] {
  if (!sources.length) return [];
  return models.filter((m) => m.alias !== alias && m.enabled && sources.every((s) => inFamily(m, s)));
}

/** 某个端在某个来源下此刻会用哪个条目 —— 与 BFF `apiGetModels(surface)` 同一条规则：
 *  该来源的默认（启用、上了这个端、属于这个家族），否则这个端可选集里的第一个；都没有 → undefined。 */
export function surfaceModel(models: LlmModelEntry[], defaults: Defaults, source: LlmSource,
                             surface: ModelSurface): LlmModelEntry | undefined {
  const fam = models.filter((m) => m.enabled && m.surfaces.includes(surface) && inFamily(m, source));
  return fam.find((m) => m.alias === defaults[source]) || fam[0];
}

/* ───────────────── 模型表 ───────────────── */

export type Seg = "all" | "bedrock" | "gateway" | "disabled";

/** 表格顺序：第一来源的家族在前，组内保持目录顺序。 */
export function sortForTable(models: LlmModelEntry[], active: LlmSource): LlmModelEntry[] {
  return [...models].sort((a, b) => Number(!inFamily(a, active)) - Number(!inFamily(b, active)));
}

/** 分段 + 搜索（label 与 model_id 都参与，分词全部命中）。 */
export function filterModels(models: LlmModelEntry[], seg: Seg, query: string): LlmModelEntry[] {
  return models.filter((m) => {
    if (seg === "bedrock" && isGateway(m)) return false;
    if (seg === "gateway" && !isGateway(m)) return false;
    if (seg === "disabled" && m.enabled) return false;
    return !query.trim() || matchesQuery(`${m.label || ""} ${m.model_id}`, query);
  });
}

/** 分段计数。 */
export function segCounts(models: LlmModelEntry[]): Record<Seg, number> {
  return {
    all: models.length,
    bedrock: models.filter((m) => !isGateway(m)).length,
    gateway: models.filter(isGateway).length,
    disabled: models.filter((m) => !m.enabled).length,
  };
}
