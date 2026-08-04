/**
 * Potential Savings —— AWS Cost Optimization Hub（COH）。账号需已 enroll(Active)；
 * 未开通 / 无权限 → { available:false }，前端优雅降级为"未开通"。
 * 按 ActionType 汇总每月节省估算（rightsizing / stop / SP·RI 购买 / Graviton 等）。
 * 单账号(部署账号=payer)用默认凭证查本账号；COH 是全局服务，端点固定 us-east-1。
 */
import { CostOptimizationHubClient, ListRecommendationSummariesCommand } from "@aws-sdk/client-cost-optimization-hub";

const _coh = new CostOptimizationHubClient({ region: "us-east-1" });

export async function getPotentialSavings() {
  try {
    const r = await _coh.send(new ListRecommendationSummariesCommand({ groupBy: "ActionType" }));
    const byAction = (r.items || [])
      .map((it) => ({
        action: it.group || "—",
        savingsUsd: Math.round(Number(it.estimatedMonthlySavings || 0) * 100) / 100,
        count: Number(it.recommendationCount || 0),
      }))
      .filter((g) => g.savingsUsd > 0)
      .sort((a, b) => b.savingsUsd - a.savingsUsd);
    const totalMonthlyUsd = Math.round(
      Number(r.estimatedTotalDedupedSavings ?? byAction.reduce((s, g) => s + g.savingsUsd, 0)) * 100,
    ) / 100;
    return { available: true, totalMonthlyUsd, byAction: byAction.slice(0, 5), currency: r.currencyCode || "USD" };
  } catch (e) {
    return { available: false, message: String(e?.message || e) };
  }
}
