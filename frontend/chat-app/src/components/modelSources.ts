/**
 * 模型来源（2026-10）的纯逻辑 —— 拿出来单独成文件，好让 vitest 直接测，也让 AdminPanel.tsx
 * 只剩渲染（react-refresh 规则：组件文件里不放非组件导出）。
 *
 * 规则与服务端（bff/web-chat/llm_config.mjs）、消费端（core/llm_config.py）是同一套：
 *   · 三种来源排成一个次序，**只用第一个**，坏了不自动降级
 *   · 每个来源只调自己家族的条目：Bedrock 三种 kind 归 iam / api_key，openai_compatible 归 gateway
 *   · 每个来源各记一个默认模型
 *   · IM 原生链路不接网关：网关排第一时 IM 用排在最前的那个 Bedrock 来源
 */
import type { LlmModelEntry, LlmSource } from "../api/admin";

export const SOURCES: LlmSource[] = ["iam", "api_key", "gateway"];
export const GATEWAY_KIND = "openai_compatible";
/** 新增网关条目的默认输出上限（与 BFF GATEWAY_DEFAULT_OUTPUT_LIMIT 一致）。 */
export const GATEWAY_DEFAULT_OUTPUT_LIMIT = 8192;
/** 网关模型名的合法形状（与 BFF GATEWAY_MODEL_ID_RE 一致）。 */
export const GATEWAY_MODEL_ID_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

export const isGateway = (m: Pick<LlmModelEntry, "kind">) => m.kind === GATEWAY_KIND;

/** 条目能否由该来源调用。 */
export function inFamily(m: Pick<LlmModelEntry, "kind">, source: LlmSource): boolean {
  return source === "gateway" ? isGateway(m) : !isGateway(m);
}

/** 规整成三种来源各一次；缺失时以 legacy credential_mode 打头。与 BFF normalizeSourceOrder 一致。 */
export function normalizeOrder(order: unknown, legacy?: string): LlmSource[] {
  const out: LlmSource[] = [];
  if (Array.isArray(order)) {
    for (const s of order) {
      if ((SOURCES as string[]).includes(s) && !out.includes(s as LlmSource)) out.push(s as LlmSource);
    }
  }
  if (!out.length) out.push((SOURCES as string[]).includes(String(legacy)) ? legacy as LlmSource : "iam");
  for (const s of SOURCES) if (!out.includes(s)) out.push(s);
  return out;
}

/** 把 from 位置的来源挪到 to 位置（拖拽与上下按钮共用）。越界原样返回。 */
export function moveSource(order: LlmSource[], from: number, to: number): LlmSource[] {
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return order;
  const next = [...order];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}

/** IM 实际用的来源：次序里第一个 Bedrock 来源。 */
export function imSource(order: LlmSource[]): LlmSource {
  return order.find((s) => s !== "gateway") || "iam";
}

/** 某来源此刻的默认模型：选过且可用就用它，否则该家族第一个启用项，都没有返回 ""。 */
export function sourceDefault(models: LlmModelEntry[], source: LlmSource, wanted?: string): string {
  const fam = models.filter((m) => m.enabled && inFamily(m, source));
  if (wanted && fam.some((m) => m.alias === wanted)) return wanted;
  return fam[0]?.alias || "";
}

/** 每个来源的默认，按可用性收敛（只留能用的）。保存时就发这一份。 */
export function resolvedDefaults(models: LlmModelEntry[],
                                 wanted: Partial<Record<LlmSource, string>>): Partial<Record<LlmSource, string>> {
  const out: Partial<Record<LlmSource, string>> = {};
  for (const s of SOURCES) {
    const a = sourceDefault(models, s, wanted[s]);
    if (a) out[s] = a;
  }
  return out;
}

/** 网关模型名 → 建议 alias：`gw-` + 末段 slug。去掉 provider 前缀，免得 alias 一长串。 */
export function gatewayAlias(modelId: string, taken: (alias: string) => boolean): string {
  const tail = String(modelId || "").split("/").filter(Boolean).pop() || "model";
  const slug = tail.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "model";
  let alias = `gw-${slug}`;
  for (let i = 2; taken(alias); i++) alias = `gw-${slug}-${i}`;
  return alias;
}

/** 新的网关条目。只上 Web：IM 原生链路一期不接网关（BFF 校验也会拒）。 */
export function newGatewayEntry(modelId: string, taken: (alias: string) => boolean): LlmModelEntry {
  return {
    alias: gatewayAlias(modelId, taken), short: null, aliases_legacy: [],
    model_id: modelId, label: modelId, kind: GATEWAY_KIND, region: null,
    hard_output_limit: GATEWAY_DEFAULT_OUTPUT_LIMIT, output_override: null,
    supports_prompt_cache: false, surfaces: ["webchat"], enabled: true,
  };
}

/** 网关地址的显示形态：只露主机名（路径通常是 /v1，没有信息量）。 */
export function gatewayHost(url?: string): string {
  try { return url ? new URL(url).host : ""; } catch { return url || ""; }
}

/** 模型列表搜索：按空白 / 常见分隔符切词，全部命中才算匹配。 */
export function matchesQuery(id: string, query: string): boolean {
  const hay = id.toLowerCase();
  return query.trim().toLowerCase().split(/[\s\-_./:]+/).filter(Boolean).every((w) => hay.includes(w));
}
