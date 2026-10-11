"""SQL 模板库 — 一套成本分析 skill 的 R0-R27 配方的代码固化版。

每条 SQL 都经一份真实大规模 CUR 逐题验证（2026-07，45 题基准 + 变体测试）。
此文件是口径的唯一事实源：禁止在工具层拼接口径逻辑。

通用防线（对应 skill 踩坑记录）：
- ARN 判断一律 COALESCE(col, '')          —— CTAS 表 NULL/原生表空串双形态（覆盖率 83.57% 事故）
- 台数唯一算法 SUM(usage_amount)/24 + 三类 usage_type + 四类 charge_type（COUNT DISTINCT 差 12 倍）
- EC2 类费用一律 amortized 行级 CASE       —— net_unblended 被 Negation 抵消
- 机型族精确等值 + Spot 从 description 解析 —— LIKE 'xx%' 混入变体
- 服务 scope 一律 servicecode              —— product_code 混入 DT/Glacier 行
- 聚合全部 SQL 直出                         —— 消除 LLM 口算
"""

# ---------- R0 通用派生表达式 ----------

AMORTIZED = """SUM(CASE
  WHEN line_item_line_item_type = 'SavingsPlanCoveredUsage' THEN savings_plan_net_savings_plan_effective_cost
  WHEN line_item_line_item_type = 'SavingsPlanRecurringFee' THEN savings_plan_total_commitment_to_date - savings_plan_used_commitment
  WHEN line_item_line_item_type IN ('SavingsPlanNegation','SavingsPlanUpfrontFee') THEN 0
  WHEN line_item_line_item_type = 'DiscountedUsage' THEN reservation_net_effective_cost
  WHEN line_item_line_item_type = 'RIFee' THEN reservation_net_unused_amortized_upfront_fee_for_billing_period + reservation_net_unused_recurring_fee
  ELSE line_item_net_unblended_cost END)"""

# 行级 amortized（无 SUM 包裹）——供 CASE WHEN <窗口> THEN ... 条件聚合复用
AMORTIZED_ROW = """(CASE
  WHEN line_item_line_item_type = 'SavingsPlanCoveredUsage' THEN savings_plan_net_savings_plan_effective_cost
  WHEN line_item_line_item_type = 'SavingsPlanRecurringFee' THEN savings_plan_total_commitment_to_date - savings_plan_used_commitment
  WHEN line_item_line_item_type IN ('SavingsPlanNegation','SavingsPlanUpfrontFee') THEN 0
  WHEN line_item_line_item_type = 'DiscountedUsage' THEN reservation_net_effective_cost
  WHEN line_item_line_item_type = 'RIFee' THEN reservation_net_unused_amortized_upfront_fee_for_billing_period + reservation_net_unused_recurring_fee
  ELSE line_item_net_unblended_cost END)"""

FINAL_SERVICE = """CASE
  WHEN line_item_usage_type LIKE '%CapacityBlockFee%' THEN 'AmazonEC2'
  WHEN line_item_product_code = 'ComputeSavingsPlans' THEN 'AmazonEC2'
  WHEN (CASE WHEN bill_billing_entity = 'AWS Marketplace' AND NOT line_item_line_item_type LIKE '%Discount%' THEN product_product_name
             WHEN product_servicecode = '' THEN line_item_product_code
             ELSE product_servicecode END) <> 'AmazonEC2'
    THEN (CASE WHEN bill_billing_entity = 'AWS Marketplace' AND NOT line_item_line_item_type LIKE '%Discount%' THEN product_product_name
               WHEN product_servicecode = '' THEN line_item_product_code
               ELSE product_servicecode END)
  WHEN product_product_family IN ('Compute Instance', 'Compute Instance (bare metal)', 'Dedicated Host', 'CPU Credits') THEN 'AmazonEC2'
  WHEN product_product_family IN ('Storage', 'System Operation', 'Provisioned Throughput', 'Storage Snapshot', 'Fast Snapshot Restore') THEN 'AmazonEBS'
  WHEN product_product_family = 'NAT Gateway' THEN 'NatGateway'
  WHEN product_product_family = 'VPC Peering' THEN 'AmazonVPC'
  ELSE 'AmazonEC2-Other'
END"""

PURCHASE_OPTION = """CASE
  WHEN line_item_usage_type LIKE '%CapacityBlockFee%' THEN 'CapacityBlock'
  WHEN COALESCE(savings_plan_savings_plan_a_r_n, '') <> '' THEN 'SavingsPlan'
  WHEN COALESCE(reservation_reservation_a_r_n, '') <> '' THEN 'Reserved'
  WHEN line_item_usage_type LIKE '%Spot%' THEN 'Spot'
  ELSE 'OnDemand'
END"""

# Spot 行机型解析（Spot Usage 行 product_instance_type 为空）
INSTANCE_TYPE = """(CASE WHEN line_item_usage_type LIKE '%Spot%' AND line_item_product_code = 'AmazonEC2' AND line_item_line_item_type = 'Usage'
  THEN split_part(line_item_line_item_description, ' ', 1) ELSE product_instance_type END)"""

INSTANCE_FAMILY = """(CASE WHEN line_item_usage_type LIKE '%Spot%' AND line_item_product_code = 'AmazonEC2' AND line_item_line_item_type = 'Usage'
  THEN split_part(split_part(line_item_line_item_description, ' ', 1), '.', 1) ELSE product_instance_type_family END)"""

NOT_TCR = "line_item_line_item_type NOT IN ('Tax','Credit','Refund')"

# 台数：唯一算法（三类 usage_type + 四类 charge_type 缺一不可）
COUNT_ROWS_FILTER = """(line_item_usage_type LIKE '%BoxUsage%' OR line_item_usage_type LIKE '%SpotUsage%' OR line_item_usage_type LIKE '%UnusedBox%')
  AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage','DiscountedUsage','RIFee')"""

EC2_COMPUTE_FAMILY = "product_product_family IN ('Compute Instance','Compute Instance (bare metal)','Dedicated Host','CPU Credits')"

GRAVITON_MATCH = """(product_physical_processor LIKE '%Graviton%'
  OR product_instance_type_family LIKE '%6g%' OR product_instance_type_family LIKE '%7g%'
  OR product_instance_type_family LIKE '%8g%' OR product_instance_type_family LIKE '%9g%'
  OR product_instance_type_family LIKE '%4g%' OR product_instance_type_family LIKE '%2g%'
  OR product_instance_type_family = 'a1' OR product_instance_type_family = 'g5g'
  OR product_instance_type LIKE '%6g%' OR product_instance_type LIKE '%7g%'
  OR product_instance_type LIKE '%8g%' OR product_instance_type LIKE '%9g%'
  OR product_instance_type LIKE '%4g%' OR product_instance_type LIKE '%2g%'
  OR product_instance_type = 'a1' OR product_instance_type = 'g5g')"""

GRAVITON_SP_FAMILY = """(savings_plan_instance_type_family LIKE '%6g%' OR savings_plan_instance_type_family LIKE '%7g%'
  OR savings_plan_instance_type_family LIKE '%8g%' OR savings_plan_instance_type_family LIKE '%9g%'
  OR savings_plan_instance_type_family LIKE '%4g%' OR savings_plan_instance_type_family LIKE '%2g%'
  OR savings_plan_instance_type_family IN ('a1','g5g'))"""

GPU_MATCH = "product_gpu <> '' AND product_gpu <> '0' AND product_gpu <> 'N/A' AND product_gpu IS NOT NULL"

FINAL_PURCHASE_OPTION = """CASE
  WHEN line_item_line_item_type = 'SavingsPlanRecurringFee' THEN 'Wasted SP'
  WHEN line_item_line_item_type = 'RIFee' THEN 'RI'
  WHEN line_item_line_item_type = 'SavingsPlanNegation' THEN 'SP Negation'
  WHEN line_item_line_item_type IN ('EdpDiscount','PrivateRateDiscount','BundledDiscount','Credit') THEN 'Discount/Credit'
  WHEN line_item_usage_type LIKE '%CapacityBlockFee%' THEN 'Capacity Block'
  WHEN product_capacitystatus = 'AllocatedCapacityReservation' THEN 'ODCR Reservation Record'
  WHEN line_item_usage_type LIKE '%SpotUsage%' THEN 'Spot'
  WHEN line_item_usage_type LIKE '%UnusedBox%' AND line_item_line_item_type = 'SavingsPlanCoveredUsage' THEN 'SP covered wasted ODCR'
  WHEN line_item_usage_type LIKE '%UnusedBox%' THEN 'Wasted ODCR'
  WHEN product_capacitystatus = 'Used' AND line_item_line_item_type = 'SavingsPlanCoveredUsage' THEN 'SP covered OD/ODCR'
  WHEN product_capacitystatus = 'Used' THEN 'OD/ODCR'
  WHEN line_item_line_item_type = 'SavingsPlanCoveredUsage' THEN 'SP covered OD'
  ELSE 'Other' END"""

# 内层 service（final_service 的内层，用于 EC2 全集 scope）
INNER_SERVICE = """(CASE WHEN bill_billing_entity = 'AWS Marketplace' AND NOT line_item_line_item_type LIKE '%Discount%' THEN product_product_name
  WHEN product_servicecode = '' THEN line_item_product_code
  ELSE product_servicecode END)"""

