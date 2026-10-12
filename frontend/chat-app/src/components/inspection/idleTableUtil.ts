/**
 * 闲置表格与页面 KPI 共用的纯函数（2026-10 看板改版）。
 *
 * ⚠️ 单独成文件：组件文件只导出组件（react-refresh 的约定）。
 */

import type { FindingRow } from "../../api/inspection";
import { judgementState } from "./format";

/** 服务的显示名。认不出的原样显示（陌生值至少能拿去搜）。 */
export function serviceLabel(svc: string): string {
  return ({ rds: "RDS", elasticache: "ElastiCache", ec2: "EC2", ebs: "EBS" } as
    Record<string, string>)[svc] ?? (svc || "—");
}

/** 服务配色。只用于这一页的分组与拆分条，不承担语义（语义靠文字）。 */
export function serviceColor(svc: string): string {
  return ({ rds: "#2563eb", elasticache: "#16a34a" } as Record<string, string>)[svc]
    ?? "#9ca3af";
}

/**
 * 这一页里「每条都一样」的那句规则说明。
 *
 * 取 `state === "rule"` 的条目里出现最多的那句 conclusion。和它相同的行不再逐行
 * 显示，表格下方说一次；**不同的**（例如容量审计那一档）仍在行里显示 —— 那才是
 * 有区分度的信息。
 */
export function commonConclusion(
  rows: FindingRow[], judged: (f: FindingRow) => boolean,
): string {
  const n = new Map<string, number>();
  for (const f of rows) {
    if (judgementState(f, { dispatched: judged(f) }) !== "rule") continue;
    const c = (f.conclusion || "").trim();
    if (c) n.set(c, (n.get(c) ?? 0) + 1);
  }
  let best = "", bestN = 0;
  for (const [c, k] of n) if (k > bestN) { best = c; bestN = k; }
  return best;
}

/**
 * 给 KPI 那张「按服务拆分」用：每个服务的已估价小计与资源台数。
 *
 * ⚠️ 按**资源**算（`groupByResource` 的 `saving` 是那台资源各条里最大的一笔），
 *    不按 finding 求和 —— 同一台的「闲置」与「超配」是二选一的处置，加起来是重复计。
 */
export function savingsByService(
  rows: FindingRow[],
): { svc: string; usd: number; n: number }[] {
  const m = new Map<string, { usd: number; n: number }>();
  for (const g of groupByResource(rows)) {
    const k = g.primary.service || "";
    const cur = m.get(k) ?? { usd: 0, n: 0 };
    cur.n += 1;
    if (g.saving != null) cur.usd += g.saving;
    m.set(k, cur);
  }
  return [...m.entries()].map(([svc, v]) => ({ svc, ...v }))
    .sort((a, b) => b.usd - a.usd || b.n - a.n);
}

/** 容量审计那两条规则的名字 —— 它们与闲置并列在这一页上，但不是「闲置」。 */
export const CAPACITY_RULE_LABEL: Record<string, { zh: string; en: string }> = {
  oversized_storage: { zh: "存储超配", en: "Storage oversized" },
  oversized_memory: { zh: "内存超配", en: "Memory oversized" },
};

/** 同一台资源的身份。`finding_id` 是 `<账号>#<region>#<service>#<实例>#<规则>#<指标>`。 */
export function resourceKey(f: FindingRow): string {
  return [f.account_id, f.region, f.service, f.instance].join("#");
}

/**
 * 「闲置与成本」表格的一行 = **一台资源**，不是一条 finding（2026-10 第二版）。
 *
 * 🔴 截图里 17 行有 7 个名字出现了两次：同一台 redis 先以「闲置」出现一次，
 *    再以「内存超配」出现一次，后者没有金额、没有指标，只是一行「—」。
 *    读的人第一反应是「重复了」，而且两条指向的处置互斥（闲置 → 下线；
 *    超配 → 降配），分两行摆反而让人以为要做两件事。
 *
 * - `primary`：点这一行打开的那条。有闲置判定的优先（它带金额与评分明细），
 *   其余（超配）作为同一行上的标签，详情抽屉里能切过去。
 * - `saving`：这台资源的可省金额 = 各条里**最大**的那个，不是求和 ——
 *   下线与降配二选一，加起来就是重复计。
 * - 行序 = `rows` 里**首次出现**的顺序。调用方已按「精度桶 → 金额 → 闲置分」排好
 *   （`sortForKind`），而 primary 总是那一组里排得最前的那条。
 */
export interface ResourceGroup {
  key: string;
  primary: FindingRow;
  /** 同一台资源上的其余 finding（按规则名排，稳定）。 */
  others: FindingRow[];
  saving: number | null;
}

export function groupByResource(rows: FindingRow[]): ResourceGroup[] {
  const m = new Map<string, FindingRow[]>();
  for (const f of rows) {
    const k = resourceKey(f);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(f);
  }
  return [...m.entries()].map(([key, fs]) => {
    const primary = fs.find((f) => f.rule === "idle")
      ?? fs.find((f) => f.savings_usd != null) ?? fs[0];
    const priced = fs.map((f) => f.savings_usd).filter((v): v is number => v != null);
    return {
      key, primary,
      others: fs.filter((f) => f !== primary)
        .sort((a, b) => a.rule.localeCompare(b.rule)),
      saving: priced.length ? Math.max(...priced) : null,
    };
  });
}

/**
 * 抽屉里「判定方式」那一行。**界面文案，不读库里的 `conclusion`。**
 *
 * 🔴 库里那句是写入当时的版本：2026-10 之前写进去的闲置条目还在承诺「降配目标」
 *    （没有代码算过那个数），超配条目带的还是结构性规则那一句（「describe 结果
 *    即可确定」—— 对按占用比值判的超配是错的）。那些行要等下一次正式巡检才会被
 *    重写，而定时巡检可能是关着的。说明方法的话属于界面，跟着界面版本走。
 * ⚠️ 认不出的规则回落到库里那句（新规则上线而这里没跟上时，至少还有话说）。
 */
export function methodNote(f: FindingRow, zh: boolean): string {
  if (f.rule === "idle") {
    return zh
      ? "按上面各维加权算分，再经峰值与隐形负载否决、成本核算得出。规则判定，不需要 AI；需要时可从下方按钮手动派一次。"
      : "Weighted score of the dimensions above, with peak and hidden-load vetoes and a cost estimate. Rule-based; you can still request an AI analysis.";
  }
  if (f.rule in CAPACITY_RULE_LABEL) {
    return zh
      ? "容量审计：实测占用与规格的比值，附 CPU 峰值否决。规则判定，不需要 AI。"
      : "Capacity audit: measured usage vs. provisioned size, with a CPU-peak veto. Rule-based.";
  }
  return (f.conclusion || "").trim();
}
