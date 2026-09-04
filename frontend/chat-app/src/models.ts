/**
 * 可选模型目录（客户端缓存）。
 *
 * 真源在 DynamoDB（PK=llmcfg），由管理员在「管理 → 模型」里勾选，经 BFF 的
 * `GET /models` 下发 —— 该接口只返回**已启用集**，不含 provider、凭证和候选全集，
 * 权限边界落在接口上而不是 UI 上。
 *
 * 为什么不用 React Context：Message.tsx 的署名行需要在渲染期**同步**把 model id
 * 换成显示名（历史消息存的是 id，流式时存的是显示名），走 Context 会把一个纯展示
 * 函数变成必须挂 hook 的组件。所以这里用模块级缓存 + useSyncExternalStore：
 * 同步读随时可用，订阅者在拉取落地后自动重渲染。
 *
 * ── 状态机（这是本文件的核心，改动前请读完）──
 *
 * `types.ts` 的 `MODELS` 是本 feature 之前的硬编码清单，现在**只在服务端明确说
 * "我没有目录"时**才作为清单使用。曾经它是 `catalog` 的初始值，后果是：目录拉回来
 * 之前，下拉框显示一份和真目录一样"正式"的旧清单（实测：先看到 8 个，落地后变 1 个），
 * 那一秒里用户能选中一个管理员已停用的模型。
 *
 *   phase=loading                     还不知道目录是什么 → 不给清单、不许发消息
 *     └─ 超过 LOAD_GRACE_MS 仍未落地   → 降级：用内置清单 + 放行（见下"为什么必须有上限"）
 *   phase=ready  source=ddb           用服务端目录。models 为空 = 管理员确实没为本端启用
 *                                       模型 → 报错让他去修，而不是偷偷换一份清单
 *   phase=ready  source=unseeded      表里没目录（全新部署 / seed 失败）→ 内置清单 + 放行
 *   phase=ready  source=disabled      本端 flag 关闭（灰度回滚拉杆）→ 内置清单 + 放行
 *                                       语义就是"回到 feature 之前"，此时若禁发消息，
 *                                       一拉回滚拉杆就是全员发不出消息
 *   phase=ready  source=read_error    DDB 读失败 → 内置清单 + 放行 + 界面标注降级
 *
 * 为什么"禁止发消息"必须有上限：服务端 `/stream` 本来就会自己定模型（客户端没选或选了
 * 无效值时用管理员设的默认模型），所以拉不到目录并不等于发不出消息。永久阻塞只会把一次
 * 网络抖动变成产品不可用。超时后放行，并如实告诉用户"本次用管理员设定的默认模型"。
 *
 * localStorage 缓存：按部署（chatApiBase）分键存上一次拿到的目录，二次访问直接渲染、
 * 后台再校验。这比拿代码里的快照兜底准得多 —— 它是**这个部署**真实的目录，不是编译期快照。
 */
import { useSyncExternalStore } from "react";
import { MODELS, RETIRED_MODELS, DEFAULT_MODEL, type ModelOption } from "./types";
import { fetchModels } from "./api/chat";
import { getConfig } from "./config";

export type CatalogPhase = "loading" | "ready";
/** 服务端对"这份清单从哪来"的自述。`cache` 是本地缓存命中（尚未校验）。 */
export type CatalogSource = "ddb" | "unseeded" | "disabled" | "read_error" | "cache" | "";

/** 加载宽限期：超过它就降级放行，避免一次抖动变成"发不出消息"。 */
const LOAD_GRACE_MS = 3000;

let catalog: ModelOption[] = [];
let defaultId = "";
let generation = 0;
let phase: CatalogPhase = "loading";
let source: CatalogSource = "";
let inflight: Promise<void> | null = null;

const subscribers = new Set<() => void>();
// useSyncExternalStore 要求 getSnapshot 的返回值稳定（同一份数据必须 === 相等），
// 否则会无限重渲染。用一个只在真正换了目录时才自增的版本号做快照。
let snapshot = 0;

// 拉取失败后的重试。指数退避 2s/4s/8s/16s/32s，最多 5 次。
const MAX_RETRIES = 5;
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let graceTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  snapshot++;
  for (const fn of subscribers) fn();
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/* ───────────────── 本地缓存（按部署分键）───────────────── */

function cacheKey(): string {
  let base = "";
  try { base = getConfig().chatApiBase; } catch { /* 配置还没加载 */ }
  return `notiops.models.v1:${base}`;
}

function readCache(): { models: ModelOption[]; defaultModel: string; generation: number } | null {
  try {
    const raw = localStorage.getItem(cacheKey());
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!Array.isArray(j?.models) || !j.models.length) return null;
    return { models: j.models, defaultModel: String(j.defaultModel || ""), generation: Number(j.generation || 0) };
  } catch { return null; }
}

function writeCache() {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify({
      models: catalog, defaultModel: defaultId, generation,
    }));
  } catch { /* 隐私模式 / 配额满：缓存只是优化，失败无所谓 */ }
}

/** 内置清单（仅在服务端明确没有目录时使用）。 */
function useBuiltin(src: CatalogSource) {
  catalog = MODELS;
  defaultId = DEFAULT_MODEL;
  phase = "ready";
  source = src;
  emit();
}

/* ───────────────── 读取（渲染期同步可用）───────────────── */

export function modelCatalog(): ModelOption[] { return catalog; }
export function defaultModelId(): string { return defaultId; }
export function modelCatalogGeneration(): number { return generation; }
export function modelCatalogPhase(): CatalogPhase { return phase; }
export function modelCatalogSource(): CatalogSource { return source; }
/** 目录是否来自服务端 DDB（false = 内置清单 / 本地缓存 / 仍在加载）。 */
export function modelCatalogFromServer(): boolean { return source === "ddb"; }

/**
 * 现在能不能发消息。
 * 只在"还不知道目录是什么"和"管理员确实没为本端启用任何模型"两种情况下拦：
 * 前者会在 LOAD_GRACE_MS 后自动放行，后者要管理员去改配置，拦着才对。
 *
 * `opts.needsModel === false` 时**一律放行**：有的发送路径压根不调模型，拿模型目录去拦
 * 它是错的。目前这样的路径是「深度调查（直连）」—— BFF 直连 DevOps Agent API，全程
 * 0 token、不碰 Bedrock（见 `bff/web-chat/index.mjs` 的 `directInvestigate` 分支）。
 * 不加这个出口的后果很别扭：管理员把 webchat 的模型全部取消勾选后，**唯一不需要模型的
 * 功能反而用不了**，而提示语还写着「管理员尚未为 Web 对话启用任何模型」，把人引向一个
 * 与该功能无关的配置项。
 */
export function canSendMessage(opts?: { needsModel?: boolean }): boolean {
  if (opts?.needsModel === false) return true;
  if (phase === "loading") return false;
  return catalog.length > 0;
}

/**
 * model id 或显示名 → 显示名。
 * 流式时消息里存的是显示名，从历史加载时是 id，两种都要归一。
 * 都对不上就原样返回（模型可能已被管理员下架，但历史消息仍该显示它当时用的名字）。
 */
export function modelDisplayName(model?: string): string {
  if (!model) return "";
  const byId = catalog.find((m) => m.id === model);
  if (byId) return byId.name;
  const byName = catalog.find((m) => m.name === model);
  if (byName) return byName.name;
  // 内置清单 + 已下架清单里也找一遍：管理员下架某模型（或我们把它从 Web 列表移走）后，
  // 历史消息仍该显示它当时用的名字。这是 MODELS 现在**唯一**的正当用途（历史落款），
  // 不再作为可选清单；RETIRED_MODELS 则只服务这一条路径。
  const legacy = MODELS.find((m) => m.id === model)
    || RETIRED_MODELS.find((m) => m.id === model);
  return legacy ? legacy.name : model;
}

/** 该 alias 是否仍在当前候选集内（用于纠正存量会话里已被下架的选择）。 */
export function isSelectableModel(id?: string): boolean {
  if (!id) return false;
  return catalog.some((m) => m.id === id);
}

/* ───────────────── 拉取 ───────────────── */

function scheduleRetry() {
  if (retryTimer || retries >= MAX_RETRIES) return;
  const delay = 2000 * 2 ** retries;
  retries++;
  retryTimer = setTimeout(() => { retryTimer = null; void refreshModelCatalog(); }, delay);
}

/** 首次拉取的宽限计时：到点仍未落地就降级放行（见文件头）。 */
function startGrace() {
  if (graceTimer || phase === "ready") return;
  graceTimer = setTimeout(() => {
    graceTimer = null;
    if (phase === "loading") useBuiltin("read_error");
  }, LOAD_GRACE_MS);
}

/**
 * 拉取一次目录。并发调用共享同一个请求。
 * 首次调用会先尝试本地缓存（立即可用），再用服务端结果校正。
 */
export function refreshModelCatalog(): Promise<void> {
  if (inflight) return inflight;
  // 本地缓存命中：先渲染，避免加载窗口。仍继续请求做校验。
  if (phase === "loading") {
    const c = readCache();
    if (c) {
      catalog = c.models; defaultId = c.defaultModel; generation = c.generation;
      phase = "ready"; source = "cache";
      emit();
    } else {
      startGrace();
    }
  }
  inflight = (async () => {
    const r = await fetchModels("webchat");
    if (!r) {
      // 请求本身失败（网络 / 401 / 500）。保持现状并重试；仍在 loading 则由宽限计时降级。
      scheduleRetry();
      return;
    }
    retries = 0;
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    const src = (r.source || "ddb") as CatalogSource;
    if (src !== "ddb") {
      // 服务端明确说自己没有目录 → 用内置清单并放行（用户的情况 1）
      useBuiltin(src);
      return;
    }
    catalog = r.models.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      // 管理员手填的 model_id 没有 desc_key，给一句通用描述而不是把 key 原样漏到界面上
      descKey: m.desc_key || "model.desc.generic",
    }));
    defaultId = r.default_model && catalog.some((m) => m.id === r.default_model)
      ? r.default_model
      : (catalog[0]?.id || "");
    generation = r.generation;
    phase = "ready";
    source = "ddb";
    if (catalog.length) writeCache();
    emit();
  })().finally(() => { inflight = null; });
  return inflight;
}

/** 标签页重新可见时重拉一次（管理员在另一个标签页改完目录，切回来即生效）。 */
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    retries = 0;
    void refreshModelCatalog();
  });
}

/** 订阅目录变化的 hook（下拉框等需要在拉取落地后重渲染的地方用）。 */
export function useModelCatalog(): {
  models: ModelOption[]; defaultModel: string; fromServer: boolean;
  loading: boolean; source: CatalogSource; canSend: boolean;
  /** 对**不需要模型**的发送路径（如「深度调查（直连）」）是否放行。见 canSendMessage。 */
  canSendWithoutModel: boolean;
} {
  useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return {
    models: catalog, defaultModel: defaultId, fromServer: source === "ddb",
    loading: phase === "loading", source, canSend: canSendMessage(),
    canSendWithoutModel: canSendMessage({ needsModel: false }),
  };
}

/** 仅供测试：把模块级缓存复位。 */
export function __resetModelCatalog() {
  catalog = [];
  defaultId = "";
  generation = 0;
  phase = "loading";
  source = "";
  inflight = null;
  retries = 0;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  emit();
}
