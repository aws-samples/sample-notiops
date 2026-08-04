/**
 * EDP Commitment Attainment —— Demo mock 数据。
 *
 * 真实客户的 EDP（Enterprise Discount Program）承诺数据来自客户合同条款（年度承诺
 * 金额、折扣率、Marketplace cap 等），这些不是任何 AWS API 能查到的字段——必须
 * 手工登记合同参数，再用 CUR 明细按合同口径逐月计算"已消耗承诺 / 剩余承诺"。
 *
 * 计算口径完整复刻自 TAM 团队现有的 EDP 追踪脚本（同一套 CASE WHEN 分类逻辑），
 * 确保未来接入真实客户数据时公式不用重新设计，只需把 mock 换成真实 CUR 查询：
 *   参考 SQL:    ai-for-tam/cpa/mbr/mbr_automation/sqls/backup_single_payer/edp_commitment_query.sql
 *   参考脚本:    ai-for-tam/cpa/mbr/mbr_automation/scripts/edp_commitment_tracker.sh
 *
 * 口径要点（与参考脚本一致）：
 *   - aws_service_spending: bill_billing_entity='AWS' 且 line_item_type 属于
 *     Usage/SavingsPlanRecurringFee/RIFee/BundledDiscount/EdpDiscount/Credit/Fee，
 *     排除 AWSProServe（专业服务不计入承诺）
 *   - marketplace_total: bill_billing_entity='AWS Marketplace'，排除 Tax 和 ProServe
 *   - support_fee: line_item_product_code='AWSSupportEnterprise'
 *   - ri_sp_purchase: Fee 类型且限定 RI/SP 相关 product_code，乘以 (1-EDP折扣率)
 *     换算成税前口径（CUR 的 Fee 是税前，账单侧显示是税后）
 *   - monthly_eligible = aws_service_spending + marketplace_total - support_fee
 *     - ri_sp_purchase（当月计入承诺的净额）
 *   - remaining = prev_remaining - monthly_eligible（逐月滚动扣减）
 *
 * 本文件的数值是**固定的 demo 样例**（不是每次随机生成），保证仪表盘刷新时数字
 * 稳定一致，方便 demo/截图；数量级参考典型企业客户 EDP 合同规模，不对应任何真实客户。
 */

/**
 * @typedef {object} EdpCommitmentMock
 * @property {number} annualCommitmentUsd 年度承诺总额（美元）
 * @property {number} discountRate EDP 折扣率（如 0.16 = 16%）
 * @property {number} marketplaceCapRatio Marketplace 支出上限占年度承诺的比例（如 0.25 = 25%）
 * @property {string} contractPeriod 合同起止（展示用）
 * @property {number} attainmentPct 已消耗承诺占比（%），即 progress
 * @property {number} expectedPct 按合同月份数计算的"应达成"比例（%）
 * @property {number} remainingUsd 剩余总承诺（美元）
 * @property {number} remainingMarketplaceUsd 剩余 Marketplace 承诺（美元）
 */

/**
 * 固定 demo 样例：模拟一个 $15M/年合同、进行到合同第 10 个月、消耗已略微领先进度
 * 的客户（169.7% 是模板原始设计稿里的示例数字，这里保留同一视觉效果但换算成
 * 一组内部自洽的假设数据：年度 $15M，16% 折扣，已消耗 $10.17M，领先进度)。
 * @returns {EdpCommitmentMock}
 */
export function getEdpCommitmentMock() {
  const annualCommitmentUsd = 15_000_000;
  const discountRate = 0.16;
  const marketplaceCapRatio = 0.25;
  const marketplaceCapUsd = annualCommitmentUsd * marketplaceCapRatio;

  const contractMonthElapsed = 10; // 合同第 10/12 个月
  const expectedPct = (contractMonthElapsed / 12) * 100;

  const remainingUsd = 4_830_000; // demo 固定值：已消耗 $10.17M / $15M
  const attainmentPct = ((annualCommitmentUsd - remainingUsd) / annualCommitmentUsd) * 100;
  const remainingMarketplaceUsd = marketplaceCapUsd - 937_500; // demo 固定值：已消耗 $937.5K marketplace

  return {
    annualCommitmentUsd,
    discountRate,
    marketplaceCapRatio,
    contractPeriod: "Contract Year 3 · Feb 2026 – Jan 2027",
    attainmentPct: Math.round(attainmentPct * 10) / 10,
    expectedPct: Math.round(expectedPct * 10) / 10,
    remainingUsd,
    remainingMarketplaceUsd,
  };
}
