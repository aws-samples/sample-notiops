/**
 * 资源巡检看板的 API client。
 *
 * 约定与 `api/eos.ts` 等既有 client 一致：
 *   · 鉴权只走 `signedClient()`（SigV4 + `x-notiops-id-token` 双层）
 *   · **绝不 throw 给组件**，一律返回 `{ ok: false, code }`
 *   · 每个请求都要显式带 `x-notiops-id-token`，漏了就是 401
 */

import { signedClient } from "./chat";

/** 后端 `KIND_REASONS` 的键 —— 与 `bff/web-chat/inspection.mjs` 逐字一致。 */
export type FindingKind = "high_load" | "idle" | "structural";

export const FINDING_KINDS: readonly FindingKind[] = [
  "high_load", "idle", "structural",
] as const;

/**
 * 前端**暂时不显示**的 kind。空集 = 三类全显示。
 *
 * 客户原话（2026-08-31）：「我认为配置检查暂时先 hide 掉吧。这次我没想着
 * 加进来。整个配置检查的 tab 都 hide」。
 *
 * 🔴 这是**只读侧的可见性开关**，不是功能下线。故意只动这一个常量：
 *
 * ```
 * 不动 FINDING_KINDS       它是与后端 KIND_REASONS 对齐的契约表，
 *                          BFF 的 CAP_BY_KIND 元断言、DETERMINISTIC_KINDS
 *                          的元断言都从它推导 —— 从契约表里删一项，
 *                          断言会去证明「后端也不该有 structural」，
 *                          而后端照旧在产这一类
 * 不动 capabilities.json   删掉 nav:inspection:structural 会让已经配好的
 *                          角色在下次能力复核时带一个「未知能力」
 * 不动后端                 照旧扫、照旧落库、照旧推送 —— 隐藏期间攒下的
 *                          first_seen_date / days_active 在放回来那天是
 *                          真实历史，而不是「从今天开始算」
 * ```
 *
 * 要放回来：把这个数组清空即可（`VISIBLE_FINDING_KINDS` 自动跟着变，
 * 导航项、请求集、深链落点三处都是从它派生的）。
 */
export const HIDDEN_KINDS: readonly FindingKind[] = ["structural"] as const;

/** 当前对用户可见的 kind。导航入口、看板请求、深链落点都用它。 */
export const VISIBLE_FINDING_KINDS: readonly FindingKind[] =
  FINDING_KINDS.filter((k) => !HIDDEN_KINDS.includes(k));

/** 这一类当前是否被隐藏。深链落点与 alias 兜底用它。 */
export const isHiddenKind = (k: FindingKind) => HIDDEN_KINDS.includes(k);

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";

/** 四档降序 —— 与后端 `SEVERITIES` 及 `dto.py::Severity` 同序。 */
export const SEVERITIES: readonly Severity[] = [
  "CRITICAL", "HIGH", "MEDIUM", "INFO",
] as const;

export interface Fail { ok: false; code: string; message?: string }

/**
 * 成本估算的可信档（`dto.py::PricePrecision`，五档有序）。
 *
 * 🔴 只有 `exact_api` 能当成一个数字报给客户，而**当前没有任何代码路径
 * 产出它**。其余四档 UI SHALL 显式标注「粗估」——
 * 不标的表现是客户拿 `coarse_default` 的全局兜底常数去做预算。
 */
export type PricePrecision =
  | "exact_api" | "table_unverified_region" | "table_no_provenance"
  | "coarse_keyword" | "coarse_default";

/** 越大越坏 / 越小越坏。决定卡片上写「高于阈值」还是「低于阈值」。 */
export type MetricDirection = "bad_up" | "bad_down" | "";

export interface FindingRow {
  finding_id: string;
  account_id: string;
  region: string;
  service: string;
  instance: string;
  /**
   * `finding_id` 第 5 段的规则码：`threshold_high` / `idle` /
   * `gp2_volume` / `engine_eol` / `oversized_storage` / …
   *
   * ⚠️ **不叫 `hit_reason`**。后者在这套系统里专指 payload 给 DA 的那四个
   * 判读分类（`threshold_high` / `chronic_high` / `idle` / `structural`），
   * 两套词汇表同名正是「结构性风险页恒 0 条」那个 bug 的来源。
   */
  rule: string;
  /**
   * 该条属于哪个看板页。由后端按 `KIND_RULES` 反查。
   *
   * 🔴 前端 SHALL NOT 自己写一份 `rule → kind` 映射 —— 后端的详情端点用
   * 同一张表做授权复核，两份分叉的表现是列表里有、点开 403。
   */
  kind: FindingKind | "";
  metric: string;
  state: string;
  severity: Severity;
  first_seen_date: string;
  last_run_date: string;
  /** 由 first_seen_date 与今天相减算出（R6.5），不是存储字段。 */
  days_active: number | null;
  rule_version: string;
  consecutive_hits: number | null;
  consecutive_misses: number | null;
  was_confirmed: boolean;
  da_verdict: string;
  da_parse_status: string;
  /**
   * 确定性结论 —— **不经 AI** 算出来的那句话。
   *
   * 闲置轮设计上不派 DA（`gating.DETERMINISTIC_RUN_TYPES`），判定是纯计算的
   * （CPU 均值 × 权重 + 内存 + 请求数 → 加权分），所以它有结论。
   * 有它就显示它，别显示「判读缺失」。
   */
  conclusion?: string;
  /**
   * 没派 DA 的原因。区分两类：
   *
   * ```
   * deterministic / playbook / reused / rollup_member   **不需要**判读，有结论
   * budget / quota                                      本该判读但没判，无结论
   * ```
   *
   * 只有后者才该显示「判读缺失」。
   */
  skip_reason?: string;
  da_task_id: string;
  da_report_md_key: string;
  /** 有没有 DA 判读。列表不带全文（每条 1~3KB），详情页单独取。 */
  has_judgment: boolean;
  /**
   * 7.9a skill 门禁的结论（D22）——「这条判读的方法论生效了吗」。
   *
   * 🔴 **三态，`null` 不可折成 `false`。**
   *
   * ```
   * null   门禁没跑过 —— 存量行、老派发行没 run_type、或门禁自己抛了。
   *        语义是「不知道」，UI **不渲染**任何徽标。
   * false  门禁跑了且判定不可信（skill_not_loaded / wrong_skill /
   *        no_journal / no_data_access 四档之一命中）。
   * true   门禁跑了且方法论生效。
   * ```
   *
   * 折成 false 的后果是所有存量行显示「判读不可信」—— 噪音不是信号。
   * 类型写成 `boolean | null` 而不是 `boolean` 就是为了让调用方**必须**
   * 面对第三态，而不是靠 `?? false` 把它悄悄消掉。
   */
  da_gate_trustworthy: boolean | null;
  /**
   * 命中了哪几档降级（后端 `journal_gate.Degradation` 的字符串值，共 8 档）。
   *
   * ⚠️ `[]` = 门禁跑过、一条降级都没有（干净的**正面证据**）；
   *    `null` = 门禁没跑过。两者不可合并，所以**不要** `?? []`。
   */
  da_degradations: string[] | null;
  /**
   * 这次调查实际加载的 skill 名。排查 `wrong_skill` / `extra_skill` 时
   * 「到底加载了什么」是唯一能直接看的线索。
   *
   * ⚠️ 同上：`[]`（一个都没加载，正是 `skill_not_loaded` 的形态）与
   *    `null`（没验过）不可合并。
   */
  da_skills_loaded: string[] | null;

  // ── 判定证据（后端 `assemble.to_evidence` 落库）───────────────────────
  //
  // 🔴 全部可能是 `null`，UI **必须**容忍：
  //      · 结构性风险是属性判定，没有 value/threshold
  //      · 存量行（这次改动之前跑出来的）没有这几个字段
  //      · 本轮未命中（走向 resolved）的行会被清掉
  //    表现应当是**那一行不渲染**，而不是显示 0 ——
  //    「没有这个数」与「这个数是 0」是两件事。

  /**
   * 实测值。单位见 `unit`。
   *
   * ⚠️ 内存与存储是**占规格的百分比**（R2.1.2），所以这两个指标上它是百分数
   * 而不是字节数 —— 原始字节在 `raw_value` / `denominator` 里。
   */
  observed_value: number | null;
  /** 判定用的阈值（客户可改，R13.4）。与 `observed_value` **同量纲**。 */
  threshold_value: number | null;
  /** 余量。R7.2a 的严重度分档用它。 */
  headroom: number | null;
  /**
   * 指标的物理单位：`"%"` / `"B"` / `"s"` / `""`。
   *
   * 🔴 由后端给，前端 SHALL NOT 按指标名猜。猜的表现是**单位标错**
   * （把 0.05 秒显示成「0.05%」），比不显示单位更糟。
   */
  unit: string;
  /**
   * 百分比类指标的原始观测值（字节）。非百分比类为 null。
   *
   * 用来显示「可用 2.4%（200 MB / 8 GB）」—— 只给百分比的话客户没法
   * 拿去和 CloudWatch 图表对照（图表上是字节）。
   */
  raw_value: number | null;
  /** 百分比的分母（实例总内存 / 分配存储，字节）。与 `raw_value` 成对出现。 */
  denominator: number | null;
  /** 🔴 SHALL NOT 按指标名猜 —— FreeableMemory 是越小越坏。 */
  direction: MetricDirection;
  /** 每月可省（USD）。⚠️ 只有闲置类有；高负载挂金额会诱导「关掉能省钱」。 */
  savings_usd: number | null;
  /** ⚠️ 必须与金额**一起**显示。 */
  savings_precision: PricePrecision | "";
  /**
   * 判定证据的**数据日期**。
   *
   * 🔴 `chronic` / `resolving` 的 finding 挂的是**上一次命中时**的证据
   * （后端只在 resolved 时清）。UI **必须**在它不等于 `last_run_date` 时
   * 标注「数据截至 X」—— 否则 9 天前的「可用内存 1.1%」会被读成今天的水位。
   * 「问题还在」与「现在就是这个数」是两件事。
   *
   * ⚠️ 等于 `last_run_date` 时**不要**标注：每条都挂一个「截至今天」是噪音，
   * 而噪音会让人连真正该注意的那几条一起跳过。
   */
  evidence_as_of: string;

  // ── 闲置评分因子（后端 `assemble._idle_evidence` 落库）─────────────────
  //
  // 🔴 高负载条目「凭什么」是一行「实测值 vs 阈值」；闲置**没有单一阈值**，
  //    它是加权评分。所以闲置条目的解释力全在这几个字段上 ——
  //    不渲染它们的表现是看板上只有一个 INFO 徽标和一个金额。
  /**
   * 闲置总分 0~100，越大越闲。
   *
   * 🔴 `null` 有两种含义，**都不能显示成 0**：非闲置类（高负载 / 结构性）
   * 压根没有这个概念；闲置类为 null 则是「判据不足，本轮未判定」。
   * 0 分在排序里等于「完全不闲」，而停机的实例（不发指标 → 无从判定）
   * 恰恰是最该处置的那一台 —— 补 0 会把它排到最末。
   */
  /** 规格（`db.t4g.micro` / `cache.r7g.large` / `db.serverless`）。老行没有 → `""`。 */
  instance_class: string;
  idle_score: number | null;
  /** 可用维度的原始权重之和（0~1）。低于 0.5 时后端压根不判定。 */
  idle_weight_avail: number | null;
  /** 因缺数据被丢弃、权重已按比例重分给其余维度的维度名。 */
  idle_degraded: string[];
  /** 各可用维度的明细。⚠️ 不含被丢弃的维度（那些在 `idle_degraded` 里）。 */
  idle_factors: IdleFactor[];
}

/** 闲置评分的一个维度。 */
export interface IdleFactor {
  /** `cpu` / `connections` / `storage` / `iops` / `memory` / `requests`。 */
  name: string;
  /**
   * 重归一化**后**实际生效的权重（各维之和 = 1）。
   *
   * ⚠️ 不是配置里的原始权重。IOPS 缺数据时 CPU 的 0.40 会被重分到 0.44，
   * 显示原始值会让四维之和不等于 1，客户会以为我们算错了。
   */
  weight: number | null;
  /** 归一化值 0~1，越大越闲。 */
  normalized: number | null;
  /** 本维贡献的分数（= weight × normalized × 100）。 */
  points: number | null;
  /** `BasisCode` —— 归一化的依据（分母从哪来）。 */
  basis: string;
  /** 实测值。⚠️ 有些维度没有单一实测值（组合指标），那时是 null。 */
  observed: number | null;
}

export interface FindingDetail extends FindingRow {
  /** 判读全文（按 finding_id 分节回拼来的）。 */
  da_body: string;
  da_updated_at: number | null;
}

export interface RunRow {
  run_type: string;
  run_date: string;
  account_id: string;
  status: string;
  data_date: string;
  source: string;
  mode: string;
  tier: string;
  catch_up: boolean;
  config_version: string;
  completeness: number | null;
  expected: { instances?: number; clusters?: number } | null;
  actual: Record<string, unknown> | null;
  findings: number | null;
  dispatched_tasks: number | null;
  /**
   * ⚠️ 与 `dispatched_tasks` **分开显示**。两者不等意味着有 task 发出去了
   * 却没落映射 → 那些判读永久回不来。把它们合成一个数字
   * 会让这个缺口在看板上完全看不见。
   */
  mapped_tasks: number | null;
  heartbeat: boolean;
  skipped_by_gate: Record<string, number> | null;
  gaps: number | null;
  batches_failed: number | null;
  /**
   * 这一轮的 region 覆盖面（2026-08-27 起巡检扫账号下全部 region）。
   *
   * 🔴 `failed` 非空 = 有 region 没扫成，那一轮的 `status` 会是 `partial`。
   * **必须显示出来**：失败的 region 在 `by_region` 里**连键都没有**（不是 0），
   * 所以「少了一个 region」只能靠 `total` 与 `failed` 看出来。
   *
   * 不显示的后果与被修掉的那个缺陷同形：客户看到「跑过了」，而某个 region
   * 里那台内存 98% 的库一条 finding 都没出。
   */
  regions: { total: number | null; scanned: number | null; failed: string[] } | null;
  /** 每个 region 各扫到几台。⚠️ 失败的 region **不在这里面**（见 `regions.failed`）。 */
  by_region: Record<string, number> | null;
}

export interface FindingsData {
  ok: true;
  account_id: string;
  kind: string;
  total: number;
  by_severity: Record<Severity, number>;
  /** R10.6：明示「另有 N 项未做根因分析」。不显示会让客户以为看板就是全部。 */
  without_judgment: number;
  /** 见 `OverviewData.without_judgment_by_reason`。 */
  without_judgment_by_reason?: Record<string, number>;
  /**
   * 🔴 规则码没登记在后端 `KIND_RULES` 里的条数（正常恒 0）。
   *
   * >0 意味着判定侧加了新规则而读侧没跟上 —— 那些 finding **三页都进不去**。
   * UI SHALL 显示它，藏起来就回到「总数与分页之和不等」而无从解释。
   */
  unclassified: number;
  /**
   * 被读侧 5000 上限截断时的条数；`0` = 没截断。
   *
   * 🔴 UI SHALL 显示它。截断之后 `total` 不再是真实总数，而 `by_severity` /
   * `without_judgment` / `parse_quality` / `unclassified` 全部基于截断后的
   * 集合 —— 那几个自检指标一起失真，而与「真的只有这么多」完全无法区分
   * （`queryAll` 那个 break 原来是静默的）。
   */
  truncated_at?: number;
  findings: FindingRow[];
  /**
   * 最近一轮的状态。**`null` = 读不到，不等于没跑过。**
   *
   * 🔴 R9.11：列表为空时「那天没跑」与「那天没有风险」必须可区分 ——
   * 两者的运维含义完全相反（一个放心，一个要去查为什么没跑）。
   * 东京实测踩到的就是后者被显示成前者：run 卡在 running、零 finding，
   * 界面照样说「本轮未发现风险」，客户以为系统正常工作。
   */
  last_run: {
    run_date: string;
    status: string;
    completeness: number | null;
    mode: string;
    /**
     * 这一轮**没扫成**的 region 名字。空数组 = 全都扫成了。
     *
     * 🔴 `status === "partial"` 只说「不完整」，说不出少了谁 —— 而失败的
     * region 在 `by_region` 里**连键都没有**（不是 0）。更要紧的是那些实例
     * 压根没进 `expected`，所以 `completeness` 可能仍是 1.0：
     * 「完整度 100% 但漏了一个 region」是真实存在的组合。
     *
     * ⚠️ 存量 BFF 不返回这个字段 → `undefined`，调用方按「不知道」处理
     * （不是「没有失败」）。
     */
    regions_failed?: string[];
  } | null;
}

export interface OverviewData {
  ok: true;
  account_id: string;
  total: number;
  /**
   * 严重度 / 状态分档。**目前前端一个都不读** —— 页头那排分档是从
   * `openRows` 现算的（`bySev`），因为它要随「已解决」筛选实时变，
   * 而这两个字段是后端按**全量**算的（含 resolved）。
   *
   * ⚠️ 留着不删：它们是 BFF 的既有契约，删了会让任何直接打端点的调用方
   * （脚本 / 未来的报告）拿到一个字段变少的响应。但**不要**把它们接到
   * 页头那排分档上 —— 两个口径不同，接上去的表现是「筛掉已解决之后
   * 分档数字不变」。
   */
  by_severity: Record<Severity, number>;
  by_state: Record<string, number>;
  without_judgment: number;
  /** 见 `FindingsData.unclassified`。总览是唯一能看到跨 kind 全量的地方。 */
  unclassified: number;
  /**
   * 被读侧 5000 上限截断的条数；`0` = 没截断。见 `FindingsData.truncated_at`。
   *
   * 🔴 总览是**最先撞上**这个上限的那一个：它不带 kind 过滤，一次扫全量，
   * 所以任何单个 kind 页还没截断时它可能已经截断了。而它下面的 `total` /
   * `by_severity` / `by_state` / `parse_quality` 全部基于截断后的集合。
   *
   * ⚠️ 这个字段后端一直在返回（`inspection.mjs` 的 `getOverview`），
   * 但此前类型里没声明、前端也没读 —— 算好了没人取，与 `shapeRun` 里
   * 批评过的那类缺口同型。
   */
  truncated_at: number;
  /** 🔴 派发缺口累计。>0 意味着有判读永久回不来，看板必须能看见这个数。 */
  dispatch_gap: number;
  /**
   * DA 判读的解析质量分档（后端 `report_parse.ParseStatus` 的四档）。
   *
   * 🔴 skill 漂移的唯一可见信号。判读是自然语言，回来之后按
   * `## <finding_id>` 精确匹配切段 —— DA 改了措辞 / 输出被截断 /
   * skill 没加载，都表现为切不出节。此前只在单条详情里显示英文枚举，
   * 100 条里 60 条失败也得逐条点开才发现。
   *
   * ⚠️ `dispatched` 是分母（**派发过判读**的条数，不是全部 finding）。
   * 四档之和 ≤ dispatched，差额是「判读还在路上」（异步 1~3 分钟）。
   */
  parse_quality: {
    ok: number; partial: number; parse_failed: number; empty: number;
    other: number; dispatched: number;
  };
  /**
   * 7.9a skill 门禁的聚合（D22）。「回来的判读里有几条没按我们的方法论产出」。
   *
   * 🔴 与 `parse_quality` 正交：那边问「判读切没切出来」，这边问「切出来的
   * 这份可不可信」。一条 `ok` 的判读完全可以是 skill 没加载 —— 单条卡片
   * 有徽标，但「100 条里 60 条不可信」这种全局故障（措辞路由写偏 /
   * agent space 没关联账号）只有聚合才看得见。
   *
   * ```
   * untrusted  门禁判不可信 —— 结论等于通用 LLM 发挥
   * degraded   可信但有折扣（压缩 / 部分证据缺失 / 混了别的 skill / 解析失败）
   * clean      门禁跑过、零降级 —— 已验证的干净（正面证据，≠ unknown）
   * unknown    有判读但没有门禁结论（存量行 / 老派发行 / 门禁抛了）——
   *            「不知道」，不是「有问题」，界面不该为它报警
   * ```
   *
   * ⚠️ 分母是判读**已回来**的条数（四档之和），在途的不算 —— 与
   * `parse_quality` 不把在途算进 `other` 同理。
   * ⚠️ 可选：存量 BFF 不返回 → `undefined`，整块不渲染（不显示一排 0）。
   */
  gate_quality?: {
    untrusted: number; degraded: number; clean: number; unknown: number;
  };
  /**
   * 那 N 条「未做根因分析」**各自因为什么**（键是 `gating.SkipReason` 的值，
   * `unknown` = 行上没有这个字段）。
   *
   * 🔴 只给 `without_judgment` 一个总数的表现是一句「另有 N 项未做根因分析」
   * 吞掉三种下一步互不相同的处境：`budget`（去调额度档位）/ `quota`（等下一轮）
   * / `kill_switch`（去打开开关）。`gating.SkipReason` 的 docstring 就写着
   * 「客户接着就会问『是坏了还是省钱』—— 那是两个完全不同的答案」。
   *
   * ⚠️ 与 `skipped_by_gate` **不是同一个东西**：这一份按 finding 自己的
   * `skip_reason` 数（当前未闭合的条目），那一份是最近若干轮的**派发决策**
   * 计数。两者的计数对象与时间窗都不同，加在一起没有意义。
   *
   * ⚠️ 可选：存量 BFF 不返回 → `undefined` = 「不知道各自什么原因」，
   * 不是「没有原因」。
   */
  without_judgment_by_reason?: Record<string, number>;
  /**
   * 各闸门各拦下多少条**派发决策**，跨回传的这些轮累加。
   *
   * ⚠️ 按**未截断**的 runs 算（见 `runs_total`），所以可能大于 runs 表里能
   * 加出来的数。
   */
  skipped_by_gate?: Record<string, number>;
  /** 采集缺口累计。`>0` = 有资源没被采到，`0` = 没有。 */
  gaps?: number;
  /** 失败批次累计。`>0` = 有资源压根没被评估过。 */
  batches_failed?: number;
  diff: Record<string, {
    current: number | null;
    previous: number | null;
    delta: number | null;
    last_run_date: string;
    last_status: string;
    completeness: number | null;
  }>;
  runs: RunRow[];
  /**
   * 截断**之前**有多少轮。
   *
   * 🔴 「显示 N / M 轮」的 M 必须用这个，不能用 `runs.length` —— 后者是
   * 已经被 BFF 截过的数（`runs_limit`），于是那句话会说「显示 3 / 20 轮」
   * 而真实可能是 137 轮。findings 侧有 `truncated_at` 专门解决这件事，
   * runs 侧此前是静默截断。
   *
   * ⚠️ 可选：存量 BFF 不返回 → `undefined` = 「不知道截没截」。那时**不能**
   * 假设没截断（回落到 `runs.length` 只是没有更好的信息，不是真相）。
   */
  runs_total?: number;
  /** 回传上限。前端用它说「只回传最近 N 轮」而不是写死 20。 */
  runs_limit?: number;
}

export interface SeriesPoint { date: string; value: number | null }
export interface SeriesData {
  ok: true;
  account_id: string;
  region: string;
  service: string;
  instance: string;
  series: { metric: string; stat: string; points: SeriesPoint[] }[];
}

export interface ScopeEntry {
  key: string;
  account_id: string;
  region: string;
  service: string;
  resource_id: string;
  level?: string;
  reason?: string;
  /** ⚠️ 字段名是 `expires_at`（对齐 `scope.ExclusionEntry`），不是 expires_on。 */
  expires_at?: string;
  never_expires?: boolean;
  /**
   * 读侧算出来的（`today >= expires_at`）。
   * R1.4：到期条目**保留记录但不生效**，所以列表里仍会返回它们，只是打标。
   */
  expired?: boolean;
  created_by?: string;
  created_at?: string;
}

/**
 * 「巡检范围」白名单里的一行。**比 `ScopeEntry` 窄** —— 见
 * `ScopeData.targets` 的说明（BFF 只 map 出这五个字段）。
 */
export interface ScopeTarget {
  key: string;
  account_id: string;
  region: string;
  service: string;
  resource_id: string;
}

export interface ScopeData {
  ok: true;
  /**
   * BFF resolve 出来的部署账号（12 位）。
   *
   * 🔴 这一页**不渲染账号选择器**（单账号锁定），所以前端手里的
   * `accountId` 是空串，而写端点要求 `/^\d{12}$/`。少了这个字段就是死锁：
   * 要建第一条排除项需要账号 → 账号只能从已有条目回填 → 清单空的时候
   * 回填不到 → 两个写入入口永久禁用 → 建不出第一条。
   *
   * ⚠️ 可能是空串（STS 异常）。那时写入入口继续禁用并说明原因，
   * 而不是让客户填完一整张表才被拒。
   */
  account_id: string;
  /** 两份**独立**清单（R1.2）。合成一份会让「别报 CPU」等于「别管闲置」。 */
  exclusions: Record<"high" | "idle", ScopeEntry[]>;
  /**
   * 「巡检范围」白名单（与排除清单相反的那一份）。
   *
   * 🔴 类型是 `ScopeTarget` 而不是 `ScopeEntry` —— BFF 那一路
   * （`getScope` 里 `out.targets[kind] = …`）**只 map 出五个字段**，
   * 没有 `expires_at` / `expired` / `never_expires` / `reason` / `created_by`。
   *
   * 声明成 `ScopeEntry[]` 是类型在说谎：tsc 会放行
   * `targets.high[0].expired`，而运行时那个值恒为 `undefined` ——
   * 于是「这条过期了没」永远读成「没过期」，而且没有任何编译期信号。
   * （目前没有调用点读它们，所以这是**预防**而不是修一个已发生的缺陷。）
   */
  targets: Record<"high" | "idle", ScopeTarget[]>;
}

export interface ScheduleRow {
  run_type: string;
  enabled: boolean;
  /**
   * `HH:MM` UTC。**不是 cron 表达式** —— 调度粒度等于 EventBridge 的
   * 15 分钟 tick，能表达的只有「几点几分」。给 cron 输入框会让客户写出
   * 「每 5 分钟」这种系统根本不会执行的东西。
   */
  at_utc: string;
  /**
   * `null` = 每天跑。**`1` = 周一 … `7` = 周日**，对齐调度器的
   * `date.isoweekday()`。⚠️ 不是 `weekday()`（那个是 0=周一）——
   * 用 0 存进去的那一类巡检**永远不跑**，且没有任何错误信号。
   */
  weekdays: number[] | null;
  /**
   * 错过配置时刻后，允许在多少小时内补跑。**`0` = 不补跑**。
   *
   * ⚠️ `0` 是合法值且有运维后果（错过就彻底不跑那一轮），所以判缺失要用
   * `== null` 而不是 falsy —— 后端 `store.py` 那侧同口径。
   */
  catch_up_hours: number;
  /** 该行是否真的落库过。`false` = 用的是默认值（而巡检**已经在跑**）。 */
  persisted: boolean;
  /**
   * 下一轮的 UTC 时刻。**`""` = 不会再跑**（停用了，或算不出来）。
   *
   * 🔴 由**后端**算，前端 SHALL NOT 自己算 —— 这条规则带 weekdays 过滤，
   * 而 JS 的 `getUTCDay()` 是 0=周日、调度器的 `isoweekday()` 是 1=周一…7=周日。
   * 分叉的表现是 UI 显示的时间与实际执行差一天，客户按 UI 等，等不到。
   *
   * 🔴 此前**只有 PUT 回传它**，GET 不回 —— 于是「下一轮」只在刚保存完那一下
   * 存在，刷新页面就没了。而 `at_utc` / `weekdays` 一直在手上。
   *
   * ⚠️ 可选：存量 BFF 不返回 → `undefined`。那时只能沿用「保存后才显示」
   * 的老行为（不是假装没有下一轮）。
   */
  next_run_utc?: string;
}

/**
 * 一个可改的判定阈值字段（R13.4）。
 *
 * 🔴 `min` / `max` / `default` **由后端给，前端 SHALL NOT 自己写死**。
 * 写死一份的表现是「UI 上填得进去、点保存报 400」——
 * 单一来源是 `inspection/domain/rule_limits.py`（BFF 侧有镜像 + 元断言）。
 */
export interface RuleField {
  key: string;
  /** `int` / `float` / `bytes` / `str_set`。`bytes` 该按 MB/GB 渲染。 */
  type: string;
  value: number | string[];
  default: number | string[];
  min: number | null;
  max: number | null;
  unit: string;
  label_zh: string;
  label_en: string;
  /**
   * 这个字段对哪些服务组真的生效（`rds` / `aurora` / `redis` / `memcached`）。
   *
   * 🔴 由后端给，前端 SHALL NOT 自己写一份映射。缺了它的表现是客户改了
   * `read_latency_seconds` 期待 Redis 跟着变 —— 而那完全不生效且零提示。
   */
  services: string[];
  /**
   * 客户显式设过这个字段。
   *
   * ⚠️ 用它区分「填了 70」与「没配过而默认也是 70」—— 分不开的话，
   * 我们以后调默认值时那些其实没配过的部署不会跟着走。
   */
  customized: boolean;
  /**
   * 默认显示单位。`""` = 按原始值显示（多数字段）。
   *
   * 🔴 由后端给，前端 SHALL NOT 自己写死换算表 —— 与 min/max/default 同一条
   * 规矩。写死一份分叉的表现是 UI 显示「500 MB」而实际存进去 500 GB：
   * 阈值被无声放宽 1000 倍，那条规则从此永不触发。
   */
  display_unit: string;
  /**
   * 可选的显示单位与换算系数，第一项即 `display_unit`。
   *
   * ```
   * 显示值 = value / scale
   * 回写   = 显示值 × scale，然后按 type 决定要不要取整：
   *            bytes / int   round(…)   字节与天数没有小数
   *            float         不取整      50 ms × 0.001 = 0.05 s，
   *                                      取整会变成 0 → 阈值失效
   * ```
   *
   * ⚠️ 校验仍按**换算回去的原始值**打 min/max —— 单一来源还是后端那张表。
   */
  display_units: { unit: string; scale: number }[];
}

/** `{ high: { threshold: [...] }, idle: { idle: [...], capacity: [...], structural: [...] } }` */
export type RulesData = Record<string, Record<string, RuleField[]>>;

/**
 * 一个服务组（阈值页的筛选器）。
 *
 * 🔴 **筛选器不是作用域。** 阈值配置全局一份 —— `cpu_utilization` 就是一个
 * 阈值，RDS 与 Redis 共用它。选服务只决定**显示哪些字段**，不是「给这个
 * 服务单独设一套」。UI 必须把这句说出来，否则客户以为「我只调了 Redis」
 * 而 RDS 也跟着变了，且没有任何运行时信号。
 */
export interface RuleService {
  /** `rds` / `aurora` / `redis` / `memcached` */
  key: string;
  label_zh: string;
  label_en: string;
  /** 副标题，例如「MySQL / PostgreSQL / MariaDB / Oracle / SQL Server」 */
  hint_zh: string;
  hint_en: string;
  /** 该服务组有多少个可改字段 —— 用于「显示 22 / 共 30 项」。 */
  field_count: number;
}

export interface ConfigData {
  ok: true;
  /** 按类型全局（R11.1），不按账号 —— UI SHALL NOT 提供按账号设定时的入口。 */
  schedules: Record<string, ScheduleRow>;
  rules: RulesData;
  /** 服务筛选器的数据。由后端给，前端 SHALL NOT 自己维护一份。 */
  rule_services?: RuleService[];
  data_dates: string[];
}

/** 统一的 GET 包装：把鉴权、错误码、异常收敛到一处。 */
async function get<T>(pathAndQuery: string): Promise<T | Fail> {
  const s = await signedClient();
  if (!s) return { ok: false, code: "not_authenticated" };
  try {
    const r = await s.aws.fetch(`${s.base}${pathAndQuery}`, {
      headers: { "x-notiops-id-token": s.idToken },
    });
    if (!r.ok) {
      // 🔴 **把响应体里的原因带出来**，并给 403 一句人话。
      //
      //    原来只回 `{ok:false, code:"http_403"}`（不带 message、丢掉响应体），
      //    而写路径的调用方写的是 `r.message || t("insp.act.failed")` ——
      //    `code` 从来不进 UI。于是保存定时 / 阈值失败时界面上只有一行
      //    「操作失败」，没有码、没有下一步。
      //
      //    BFF 自己的校验失败是 200 + `{ok:false,code,message}`，那条路径有话说；
      //    只有 **HTTP 层**的失败（403 / 5xx / API GW 限流）全静音。
      const j = await r.json().catch(() => ({}) as Record<string, unknown>);
      const rec = j as Record<string, unknown>;
      const reason = String(rec.message || rec.error || "");
      return {
        ok: false as const,
        code: "http_" + r.status,
        message: r.status === 403
          ? (reason || "没有这个操作的权限（action:inspection:*）")
          : (reason || `请求失败：HTTP ${r.status}`),
      };
    }
    return (await r.json()) as T;
  } catch (e) {
    return { ok: false, code: "error", message: String(e) };
  }
}

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * 总览：KPI + 运行状态 + 最近巡检记录。
 *
 * 🔴 **不传 `accountId` = 统一视图**（跨全部可见账号）。
 *
 * run 记录的主键是 `insprun#<类型>#<日期>`、SK 是**账号** —— 一次 Query 天然
 * 拿到那天那一类的全部账号。所以「698 那轮还在跑」这种事不用切账号就能看到。
 */
export function getInspectionOverview(accountId?: string) {
  return get<OverviewData>(`/inspection/overview${qs({
    account: accountId, all: accountId ? undefined : "1" })}`);
}

/**
 * finding 列表。
 *
 * ⚠️ `kind` **必传**。后端按它做权限分流（`queryMatch`），不带就是
 * 403 `unknown_route` —— 这是设计上的：静默回落到「全部」会让只有闲置
 * 权限的人看到高负载 finding。
 *
 * 🔴 **不传 `accountId` = 统一视图**（`?all=1`，跨全部可见账号）。
 *
 * 巡检看板要回答的是「今天我要处置什么」—— 那是跨账号的问题。而这个端点
 * 原来 `account` 必填，于是页面顶部那个账号选择器从「筛选」退化成
 * 「决定加载哪个分区」：客户一次只能看一个账号，还得自己记住哪个账号有事。
 *
 * ⚠️ 后端按调用者的**可见账号集合**过滤（管理 → 账号数据可见性），
 *    并且「拿不到可见集合就拒绝跨账号查询」—— 不是放行。
 */
export function getInspectionFindings(
  kind: FindingKind, accountId?: string, severityMin?: Severity,
) {
  return get<FindingsData>(
    `/inspection/findings${qs({
      account: accountId,
      all: accountId ? undefined : "1",
      kind,
      severity_min: severityMin,
    })}`);
}

export function getInspectionFinding(findingId: string, accountId?: string) {
  return get<FindingDetail>(
    `/inspection/finding${qs({ account: accountId, id: findingId })}`);
}

export function getInspectionSeries(
  res: { region: string; service: string; instance: string; metric?: string; stat?: string },
  accountId?: string,
) {
  return get<SeriesData>(`/inspection/series${qs({
    account: accountId, region: res.region, service: res.service,
    instance: res.instance, metric: res.metric, stat: res.stat,
  })}`);
}

export function getInspectionScope() {
  return get<ScopeData>("/inspection/scope");
}

export function getInspectionConfig(accountId?: string) {
  return get<ConfigData>(`/inspection/config${qs({ account: accountId })}`);
}

/** 账号下一个可被排除的资源。`excluded_in` 让勾选态能回显。 */
export interface ResourceItem {
  /**
   * 🔴 只有 `rds` 与 `elasticache`。**巡检不覆盖 EC2** ——
   * `inspection/pipeline.py::load_resources` 只加载这两类，EC2 在这套里
   * 唯一的用途是给 RDS/EC 的规格名查内存大小。
   *
   * 列了 EC2 的后果是勾一台会写出一条「语义合法但永不匹配」的排除记录：
   * UI 显示已排除、巡检压根不看它 —— 比手填打错更难发现，因为界面反馈
   * 是成功的。
   */
  service: "rds" | "elasticache";
  tier: "instance" | "cluster";
  region: string;
  resource_id: string;
  /** 展示名。EC2 是 `Name 标签 (i-0abc…)`，其它就是 id。 */
  label: string;
  klass: string;
  engine: string;
  cluster_id: string;
  status: string;
  member_count?: number;
  /**
   * 这个资源已经在**哪几份**排除清单里。
   *
   * ⚠️ 两份清单独立（高负载轮 / 闲置轮），所以是数组不是布尔。
   * 一个资源可以只在闲置轮被排除而仍然参与高负载巡检 —— 那是常见配置：
   * 「这台是冷备，别报它闲置，但内存打满还是要告警」。
   */
  excluded_in: ("high" | "idle")[];
  /**
   * 每一份清单里**是哪一层**覆盖了它 —— 与 `excluded_in` 成对。
   *
   * ```
   * instance    这一行自己被排除了            ← 在这个弹层里能撤销
   * container   它所属的集群 / 副本组被排除了   ← 撤不掉，要去排除清单
   * service     整个服务被排除了               ← 同上
   * account     整个账号被排除了               ← 同上
   * ```
   *
   * 🔴 后三层的 checkbox 是灰的，而客户在这个弹层里**没有撤销入口**。
   * 只说「已排除」等于在界面上摆一个用户无法解决的问题 —— 必须说清是
   * 哪一层，客户才知道该去「巡检范围 → 排除清单」删哪一行。
   *
   * ⚠️ 可选：存量 BFF 不回这个字段。缺失时只能退回「已排除」那句笼统的话
   *    （而不是猜成 `instance` —— 猜错的方向是告诉客户「取消勾选就行」，
   *    而他取消不了）。
   */
  excluded_by?: Partial<Record<"high" | "idle", ExclusionLayer>>;
}

/** `bff/web-chat/inspection.mjs::exclusionLayer` 的四档，与 `scope.py` 同序。 */
export type ExclusionLayer = "instance" | "container" | "service" | "account";

export interface ResourcesData {
  ok: true;
  account_id: string;
  /**
   * 这一次**真的扫过**的 region 列表（2026-08-27 起是全 region 枚举）。
   *
   * 🔴 空态文案要靠它才能说真话：「这 17 个 region 里都没有 RDS /
   * ElastiCache」与「只看了 ap-northeast-1」是完全不同的结论，而在多 region
   * 之前界面一律显示前者。
   *
   * ⚠️ 顶层原来是单数的 `region: string`，BFF 已经不返回它了 —— 留着那个字段
   * 只会让人写出恒为 `undefined` 的代码，而 `tsc` 查不出来（响应是 `get<T>`
   * 断言的）。
   */
  regions: string[];
  total: number;
  resources: ResourceItem[];
  /**
   * 某服务在某 region 读不到时进这里。空数组 = 账号里真的没有资源，不是权限问题。
   *
   * ⚠️ `region` 必须显示出来。多 region 之后同一个 `AccessDenied` 会出现 17 次、
   * 逐字相同 —— 不带 region 的话客户和 TAM 都看不出是哪个 region 缺权限。
   * Python 侧同一个问题是靠把痕迹写成 `f"{reg}:{m}"` 解决的。
   */
  degraded: { service: string; region?: string; reason: string }[];
}

/**
 * 账号下的资源清单，供排除清单**勾选**。
 *
 * 存在的理由：手填 `resource_id` 打错一个字符那条排除永远不生效，
 * 而且没有任何提示 —— 「排除一个不存在的资源」在语义上完全合法。
 */
export function getInspectionResources(accountId?: string, region?: string) {
  return get<ResourcesData>(
    `/inspection/resources${qs({ account: accountId, region })}`);
}

// ---------------------------------------------------------------------------
// 写入
//
// ⚠️ 这三个走 `action:inspection:*` 能力，与看板的 `nav:inspection` **分开**。
// 组件里必须用 `can("action:inspection:scope")` 门禁按钮 —— 只有看板权限的
// 用户看到一个点了就 403 的按钮，比看不到更糟。
// ---------------------------------------------------------------------------

export type ScopeLevel = "instance" | "cluster" | "group" | "account";

export interface ExclusionInput {
  account_id: string;
  service: string;
  /** 空 = 整账号排除，需要 `confirm_account_wide`（R1.7）。 */
  resource_id?: string;
  region?: string;
  /**
   * ⚠️ **必填**。「勾中集群即排除其下全部成员」靠它判 ——
   * 缺了级联排除会**静默失效**：UI 上集群是勾选状态，成员照样出现在结果里。
   */
  level: ScopeLevel;
  /** ⚠️ 必填（R1.3）。没有理由的排除是「白名单越积越多没人敢删」的起点。 */
  reason: string;
  /** `YYYY-MM-DD`。省略则后端给 30 天。 */
  expires_at?: string;
  /** 显式要求永不过期。省略时后端**不会**让它永不过期。 */
  never_expires?: boolean;
  /** R1.7 的二次确认。整账号排除时必须为 true。 */
  confirm_account_wide?: boolean;
}

async function send<T>(
  method: "POST" | "PUT", path: string, body: unknown,
): Promise<T | Fail> {
  const s = await signedClient();
  if (!s) return { ok: false, code: "not_authenticated" };
  try {
    const r = await s.aws.fetch(`${s.base}${path}`, {
      method,
      headers: {
        "x-notiops-id-token": s.idToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
    if (!r.ok) {
      // 🔴 **把响应体里的原因带出来**，并给 403 一句人话。
      //
      //    原来只回 `{ok:false, code:"http_403"}`（不带 message、丢掉响应体），
      //    而写路径的调用方写的是 `r.message || t("insp.act.failed")` ——
      //    `code` 从来不进 UI。于是保存定时 / 阈值失败时界面上只有一行
      //    「操作失败」，没有码、没有下一步。
      //
      //    BFF 自己的校验失败是 200 + `{ok:false,code,message}`，那条路径有话说；
      //    只有 **HTTP 层**的失败（403 / 5xx / API GW 限流）全静音。
      const j = await r.json().catch(() => ({}) as Record<string, unknown>);
      const rec = j as Record<string, unknown>;
      const reason = String(rec.message || rec.error || "");
      return {
        ok: false as const,
        code: "http_" + r.status,
        message: r.status === 403
          ? (reason || "没有这个操作的权限（action:inspection:*）")
          : (reason || `请求失败：HTTP ${r.status}`),
      };
    }
    return (await r.json()) as T;
  } catch (e) {
    return { ok: false, code: "error", message: String(e) };
  }
}

export function putInspectionExclusion(
  kind: "high" | "idle", input: ExclusionInput,
) {
  return send<{ ok: true; key: string; kind: string; expires_at: string | null }>(
    "POST", `/inspection/scope/${kind}`, input);
}

/** R1.4 的一键续期。只动到期日，其余字段不碰。 */
export function renewInspectionExclusion(
  kind: "high" | "idle", key: string, days = 30,
) {
  return send<{ ok: true; key: string; expires_at: string }>(
    "POST", `/inspection/scope/${kind}/renew`, { key, days });
}

/**
 * 「挪出白名单」—— 删掉一条排除，让那台资源立刻回到巡检范围。
 *
 * 🔴 这条路 2026-09-01 才有。此前清单上唯一的动作是「续期 30 天」，
 * 于是手滑排除一台生产库之后只能等 30 天过期 —— 而那 30 天里
 * 「没有告警」会被读成「一切正常」，没有任何运行时信号。
 *
 * ⚠️ `not_found` **要当成成功**处理。整账号排除是两份清单各一条，
 * 成对撤销时另一份可能早就没了 —— 报错会让客户以为撤销失败而重试。
 */
export function deleteInspectionExclusion(
  kind: "high" | "idle", key: string,
) {
  return send<{
    ok: true; key: string; kind: string;
    account_id: string; resource_id: string; level: string;
    /** 这条是不是整账号级（双通配）。UI 靠它决定要不要成对撤销另一份。 */
    account_wide: boolean;
  }>("POST", `/inspection/scope/${kind}/delete`, { key });
}

export interface ScheduleInput {
  /** `HH:MM`，**分钟必须是 15 的整数倍**（调度是 15 分钟 tick）。 */
  at_utc: string;
  enabled?: boolean;
  /**
   * **`1` = 周一 … `7` = 周日**（`date.isoweekday()`）。省略/空 = 每天跑。
   * ⚠️ 传 `0` 会被后端以 `bad_weekdays` 拒掉 —— 那是刻意的，
   * 因为 `isoweekday()` 永不返回 0，落库之后表现是那类巡检永远不跑。
   */
  weekdays?: number[];
  catch_up_hours?: number;
}

export function putInspectionSchedule(
  runType: "high" | "idle", input: ScheduleInput,
) {
  return send<{
    ok: true; run_type: string; at_utc: string; enabled: boolean;
    /** R13.5：下一轮时间由**后端**算并回传，前端不要自己算。 */
    next_run_utc: string;
  }>("PUT", `/inspection/schedule/${runType}`, input);
}

/** 分钟必须是 tick 的整数倍 —— 与后端同一条判据，用于表单即时校验。 */
export const SCHEDULE_TICK_MINUTES = 15;

/**
 * 改判定阈值（R13.4，需要 `action:inspection:threshold`）。
 *
 * 🔴 **增量提交，服务端 merge**。只传要改的字段。
 *
 * ⚠️ 2026-08-23 之前后端**不 merge** —— 它把请求体原样写成新的配置版本，
 * 而读侧取最新那一行。于是「第二天只改一个字段」会把前一天调过的所有阈值
 * 静默清回默认值，而客户以为自己只动了那一个。现在服务端先读最新一版再合并。
 *
 * 🔴 **恢复默认传 `null`**，不是「把 key 从请求体里去掉」（merge 之后那表达
 * 不了删除），更不是「显式传当前的默认值」（那会把它记成「已自定义」，
 * 之后我们调默认值时这个部署不会跟着走）。
 *
 * 🔴 **下一轮生效，不是立刻生效。** 写的是 append-only 的配置版本表，
 * scheduler 下一轮读最新那版随消息下发。UI 必须把这句说出来，否则客户
 * 改完盯着看板等变化，等不到就以为没保存上。
 *
 * ⚠️ 按 R6.9，配置变更会让**全部旧 finding 被强制 resolve 并重新计数**，
 * 卡片上会标「规则变更导致重新计数」。这不是 bug，是让「阈值调过之后
 * 数字为什么变了」可解释。
 */
export function putInspectionRules(
  runType: "high" | "idle",
  /**
   * 增量。**`null` = 恢复默认**（后端从合并结果里删掉那个 key）。
   *
   * 🔴 「恢复默认」不能用「显式传当前的默认值」实现 —— 那会把它记成
   * 「已自定义」，之后我们调默认值时这个部署不会跟着走。
   */
  overrides: Record<string, Record<string, number | string[] | null>>,
) {
  return send<{
    ok: true; run_type: string; config_version: string;
    rules: Record<string, RuleField[]>;
    /** 恒为 `"next_run"` —— 与 R13.5 同一口径。 */
    effective: string;
  }>("PUT", `/inspection/rules/${runType}`, overrides);
}

export function isValidAtUtc(v: string): boolean {
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(v)) return false;
  return Number(v.slice(3, 5)) % SCHEDULE_TICK_MINUTES === 0;
}

// ---------------------------------------------------------------------------
// 手动触发（action:inspection:run）
//
// 🔴 这个能力**与改范围/改定时分开授权**。它是唯一能被前端请求直接花钱的
// 巡检端点：refetch 真调 CloudWatch GetMetricData，official 还会派发 DA 判读。
// 组件里必须用 `can("action:inspection:run")` 门禁按钮。
// ---------------------------------------------------------------------------
export interface TriggerRunInput {
  run_type?: "high" | "idle";
  /**
   * `refetch` = 现拉指标（分钟级、按指标数计费）；
   * `reuse` = 复用最近一批（秒级、零成本，但全新部署上没有可复用批次会失败）。
   * 省略 = 后端默认 `refetch`，因为「点了立即巡检」要的是现在的数。
   */
  source?: "reuse" | "refetch";
  /**
   * `dry_run` = 只出结果，不推进 finding 状态机、不参与 resolved 判定、不推送；
   * `official` = 全套。省略 = 后端默认 `dry_run`。
   *
   * ⚠️ 默认 dry_run 是刻意的：一次手点的补跑不该改变「这条风险是否已解决」
   * 这种带日期语义的结论。
   */
  mode?: "dry_run" | "official";
  /**
   * 目标账号。三种取值：
   *
   * ```
   * 省略 / ""   部署账号（BFF 的 resolveAccount 空值兜底）
   * "<12 位>"   那一个账号
   * "*"         **全部账号** = 部署账号 + 全部已启用的成员账号
   * ```
   *
   * 🔴 `"*"` 一次点击对 N 个账号各跑一轮 refetch —— 花的钱与时长乘 N，
   *    而且中途撤不回来（后端没有批量取消）。调用方必须先二次确认，
   *    并且**不要**沿用单账号那套轮询（见 `ALL_ACCOUNTS_SENTINEL`）。
   *
   * ⚠️ 与 `accounts` **互斥**。给了 `accounts` 时后端忽略这个字段。
   */
  account?: string;
  /**
   * 显式多选：对这几个账号各跑一轮（2026-09-01）。
   *
   * 🔴 **一次请求带数组**，不要在前端循环 N 次 POST。循环会产生部分成功
   * （第 3 次失败时前两个已经在跑），而界面只能报一个结果 —— 要么谎报全失败
   * （客户重试 → 前两个账号各跑两轮、花两倍的钱），要么谎报全成功。
   * scheduler 那侧本来就按列表扇出，数组是它的原生形态。
   *
   * 每一项是 12 位数字，或**空串 = 部署账号**（与标量 `account` 同一套
   * `resolveAccount` 兜底）。
   *
   * 🔴 空串这一档是必须的：看板的总览是跨账号取的，那条路上后端返回
   * `account_id: null` —— 前端**拿不到**部署账号的 12 位 ID。让 UI 去猜一个
   * 的话，猜错就是对另一个账号跑一轮并计费。
   */
  accounts?: string[];
}

/**
 * 「全部账号」的哨兵，必须与 BFF `inspection.mjs::ALL_ACCOUNTS` 逐字一致。
 *
 * ⚠️ 两侧分叉的表现是：前端发 `account: "all"`，BFF 把它当成一个**账号号**
 *    去查，查不到 → 那一轮什么都没跑，而接口返回 `accepted: true`
 *    → 界面显示「已提交」。零错误、零日志。
 *    `frontend/chat-app/src/inspection.test.ts` 有断言把两边钉在一起。
 */
export const ALL_ACCOUNTS_SENTINEL = "*";

/**
 * 触发一轮巡检。**立即返回**（后端异步 invoke），不等巡检跑完。
 *
 * ⚠️ 返回里没有 run_id：run 的主键是 `(run_type, run_date, account)`，
 * 日期由 scheduler 那侧的 `now` 决定，前端猜出来的可能差一天。
 * 进度靠轮询 `getInspectionOverview()` 的 `diff[run_type].last_status`。
 */
export function triggerInspectionRun(input: TriggerRunInput = {}) {
  return send<{
    ok: true; account_id: string; run_type: string;
    source: string; mode: string; accepted: true;
    /** 实际扇出的账号列表。`account: "*"` 时是展开后的结果。 */
    account_ids?: string[];
    /** 后端确认这次走的是「全部账号」那条路。前端据此跳过单账号轮询。 */
    all_accounts?: boolean;
  }>("POST", "/inspection/run", input);
}

/** 窄化辅助：组件里 `if (isFail(d)) return <Error/>` 之后 d 就是成功类型。 */
export function isFail(d: unknown): d is Fail {
  return !!d && typeof d === "object" && (d as { ok?: unknown }).ok === false;
}

// ---------------------------------------------------------------------------
// 按需判读（`action:inspection:run`）
//
// 给**一条** finding 派一次 DA 调查，用写好的判读 skill
// （`inspection-cost-idle` / `inspection-high-load`）。
//
// 🔴 与「深度调查（直连）」是两回事：
//
// ```
// 直连     聊天页的工具，**绑在会话所选账号**上（那套工具不收账号号入参）
//          结果流在聊天里，过两天翻不到
// 本端点   走 executor Lambda → 每个账号自己 assume
//          结果绑在**那条 finding** 上，下次打开详情面板还在，报告里也带
// ```
//
// ⚠️ 门禁与「手动跑一轮」共用 `action:inspection:run` —— 两者都直接花 DA 额度。
// ---------------------------------------------------------------------------

/**
 * 运维手填备注的字符上限。
 *
 * 🔴 必须与 BFF 的 `inspection.mjs::OPERATOR_NOTE_LIMIT` 以及 Python 的
 *    `payload.py::OPERATOR_NOTE_LIMIT` 三处相同。前端松的表现是输入框放你写
 *    2000 字，点提交才被 BFF 拒 —— 而那时你已经写完了。
 *    三处一致由 `bff/web-chat/tests/judge_finding.test.mjs` 与
 *    `src/inspection.test.ts` 的元断言钉住。
 */
export const OPERATOR_NOTE_LIMIT = 1000;

export interface JudgeFindingInput {
  finding_id: string;
  /** 这条 finding 属于哪个账号。**必传** —— 见 `ALL_ACCOUNTS_SENTINEL` 那段。 */
  account: string;
  /** 可选的一句背景（「这台是 DR 备库」）。会随判读请求发给 DA。 */
  note?: string;
}

/**
 * 派一次判读。**同步**返回 —— 后端是 RequestResponse invoke。
 *
 * ⚠️ 返回的 `task_id` 只表示「任务建好了」，不表示判读回来了。判读全文由
 * `getInspectionFinding()` 的 `da_body` 承载（callback 回填，通常 1~3 分钟）。
 */
export function judgeInspectionFinding(input: JudgeFindingInput) {
  return send<{
    ok: true;
    account_id: string;
    finding_id: string;
    task_id: string;
    agent_space_id: string;
    accepted: true;
  }>("POST", "/inspection/judge", input);
}
