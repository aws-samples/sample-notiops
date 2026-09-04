/**
 * 巡检看板的数值格式化。**纯函数，无 React 依赖**（所以能单独测）。
 *
 * ## 这一层为什么必须存在
 *
 * 第一版把格式化散在 JSX 里，于是同一个字节数在三处有三种写法，
 * 而最要紧的那处直接打印了 `524288000`。客户的原话是
 * 「用 B 来做单位完全没有站在用户视角，正常都是 GB」。
 *
 * ## 单位从哪来
 *
 * 🔴 **后端给的 `unit` 字段**（`%` / `B` / `s` / `d` / 空），前端 SHALL NOT
 * 按指标名猜。链路是后端两张现成的表接起来：
 * `thresholds._THRESHOLD_BY_METRIC_FIELD` → `rule_limits.find()["unit"]`。
 *
 * 本模块只做**物理单位的换算**（1 GB = 1024 MB 这种不会分叉的事），
 * 不做「哪个字段该用什么单位」的业务判断 —— 那个在后端的
 * `rule_limits.DISPLAY_UNITS`。
 */

/** 二进制字节档。⚠️ 用 1024 而不是 1000 —— CloudWatch 的 Bytes 是二进制。 */
const BYTE_STEPS: readonly [string, number][] = [
  ["TB", 1024 ** 4],
  ["GB", 1024 ** 3],
  ["MB", 1024 ** 2],
  ["KB", 1024],
];

/**
 * 有效数字修剪：`85.30` → `85.3`，`3.00` → `3`。
 *
 * ⚠️ 不用 `toFixed(1)` 直接输出 —— 那会把 `3` 显示成 `3.0`，
 * 一列整数里混着 `.0` 读起来很脏。
 */
function trim(n: number, digits: number): string {
  const s = n.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** 千分位。大数值不分组时 `1610612736` 根本读不出量级。 */
function group(s: string): string {
  const [int, frac] = s.split(".");
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${g}.${frac}` : g;
}

/**
 * 字节 → 人读的量。
 *
 * ```
 * 524288000   → 500 MB
 * 1610612736  → 1.5 GB
 * 0           → 0 B
 * ```
 */
export function fmtBytes(n: number): string {
  const abs = Math.abs(n);
  for (const [unit, scale] of BYTE_STEPS) {
    if (abs >= scale) return `${trim(n / scale, 2)} ${unit}`;
  }
  return `${trim(n, 0)} B`;
}

/**
 * 秒 → 人读的量。**亚秒一律用 ms** —— 客户认的是「50 ms」而不是「0.05 s」。
 *
 * ⚠️ 阈值默认 `0.05`，直接显示会让客户以为「延迟 0.05 秒？很快啊」，
 * 而那其实是数据库延迟的严重线。
 */
export function fmtSeconds(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1) return `${trim(n * 1000, 2)} ms`;
  return `${trim(n, 3)} s`;
}

/**
 * 按后端给的 `unit` 格式化一个值。
 *
 * `unit` 为空 = 无量纲计数（驱逐数、队列深度），加千分位原样显示。
 */
export function fmtValue(
  n: number | null | undefined, unit: string, zh = true,
): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  switch (unit) {
    case "%": return `${trim(n, 2)}%`;
    case "B": return fmtBytes(n);
    case "s": return fmtSeconds(n);
    // ⚠️ 「天」跟随 locale。同一个函数的其余分支（% / B / s）都是语言中立的，
    //    只有这一支硬编码了中文 —— 英文界面上证书临期会显示成 `30 天`。
    case "d": return `${trim(n, 0)}${zh ? " 天" : "d"}`;
    default: return group(trim(n, 2));
  }
}

/**
 * 金额。**每月**口径（后端的 `savings_estimate` 就是月度）。
 *
 * ⚠️ 小于 $1 显示 `<$1` 而不是 `$0` —— 后者读起来像「省不到钱」，
 * 而真实含义是「省得很少但不是零」。`$0` 只在**真的估为 0** 时出现，
 * 而那种情况后端根本不写这个字段（「估不出来」与「省 $0」是两件事）。
 */
export function fmtMoney(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "—";
  if (usd > 0 && usd < 1) return "<$1";
  return `$${group(trim(usd, usd < 100 ? 2 : 0))}`;
}

/** 成本估算精度档 → 给客户看的一句话。 */
export const PRECISION_LABEL: Record<string, { zh: string; en: string }> = {
  exact_api: { zh: "按 Price List API 精确取价", en: "exact (Price List API)" },
  table_unverified_region: {
    zh: "粗估：查表命中，但表里没记区域（跨区价差可达 30%）",
    en: "coarse: table hit, region not recorded (up to 30% variance)",
  },
  table_no_provenance: {
    zh: "粗估：查表命中，但不知道价格是哪天哪个区的",
    en: "coarse: table hit, no provenance",
  },
  coarse_keyword: {
    zh: "粗估：只按规格关键字猜（同规格不同家族价差数倍）",
    en: "coarse: guessed from size keyword only",
  },
  coarse_default: {
    zh: "粗估：连关键字都没命中，用的是全局兜底常数 —— 不要拿它做预算",
    en: "coarse: global fallback constant — do not budget against this",
  },
};

/**
 * 这个精度档能不能当一个数字报给客户。
 *
 * 🔴 与后端 `PricePrecision.is_coarse` 同一条判据：**只有 `exact_api` 可以**。
 * 而当前没有任何代码路径产出那一档，所以现在落下来的每个金额都必须
 * 带着「粗估」的标签走。
 */
export function isCoarse(precision: string): boolean {
  return precision !== "exact_api";
}

/**
 * 精度档 → 排序分桶键（0 = 最可信）。**与后端
 * `dto.PricePrecision.confidence_rank` 逐档一致。**
 *
 * 🔴 R4.6 要求跨服务排序**先按这个分桶、再按金额**。`dto.py` 那条 docstring
 * 写着不这么做的后果：
 *
 * > 一个 `COARSE_DEFAULT` 猜出来的 $1000 会排在一个精确算出来的 $200 前面，
 * > 而客户会照着它去动资源。
 *
 * 而 `coarse_default` 的含义是「连规格关键字都没命中，用的是全局兜底常数」
 * —— 那个 $1000 与真实价格可能差一个数量级，它凭什么排在第一位。
 *
 * ⚠️ **认不出的档位排最后一桶**（`len` 而不是 0）。后端加了新档而前端没跟上时，
 *    默认成「最可信」会让一个未知来源的数字冲到榜首 —— 与上面那条完全同型。
 *
 * ⚠️ 空串（后端没给精度）也是最后一桶：「不知道多准」不能当成「很准」。
 *
 * ⚠️ 这份顺序由元测试锁住（`tests/test_inspection_dto.py` 从
 *    `_PRICE_CONFIDENCE_RANK` 推导期望值，不手写）。
 */
const PRECISION_RANK: Record<string, number> = {
  exact_api: 0,
  table_unverified_region: 1,
  table_no_provenance: 2,
  coarse_keyword: 3,
  coarse_default: 4,
};

/** 桶数。认不出的档位落在这里 —— 比任何已知档都靠后。 */
export const PRECISION_RANK_LAST = Object.keys(PRECISION_RANK).length;

export function precisionRank(precision: string): number {
  const r = PRECISION_RANK[String(precision || "")];
  return r === undefined ? PRECISION_RANK_LAST : r;
}

/**
 * 闲置分的**显示档**。卡片首格与抽屉标题共用。
 *
 * ```
 * score        有分 → 显示 N/100（红 ≥80 / 橙 ≥60 / 灰）
 * undecided    闲置类但 `idle_score === null` → 「本轮未判定」
 * severity     非闲置类 → 退回严重度徽标
 * ```
 *
 * 🔴 `undecided` 这一档是本次新加的。原来两处都是
 * `kind === "idle" && idle_score !== null ? 评分 : <SevBadge>` ——
 * 也就是说判据不足的闲置 finding 退回**灰色的「提示」徽标**，而：
 *
 * ```
 * dto.py::IdleScore.available_weight 的注释：
 *   ⚠️ `idle_score is None` 时展示层 SHALL 显示「监控数据不足，本轮未判定」
 *      而不是一个数字。早期实现在所有维度都不可用时输出 0，
 *      而 0 在排序里等于「完全不闲」——「什么都不知道」被呈现成了
 *      「非常确定不闲」。
 * ```
 *
 * 后端为此专门把 0 改成了 `None`，而读侧把 `None` 显示成一个与
 * 「闲置分很低」（灰色「提示」）**长得一模一样**的徽标 —— 那份努力就白费了。
 * 两者的处置动作完全不同：一个是「不用管」，一个是「去查为什么没有指标」。
 *
 * ⚠️ 只对 `kind === "idle"` 判 `undecided`。高负载 / 配置检查那两类压根没有
 *    闲置分这个概念，`null` 是它们的正常形态。
 */
/**
 * 闲置分的紧急档。**颜色与文字同源** —— 两处各判一遍就会出现
 * 「红色的但写着『低』」。
 *
 * 🔴 分档此前**只由颜色表达**（红 ≥80 / 橙 ≥60 / 灰）。色盲用户与读屏用户
 * 拿到的只是一个数字 `87/100`，而「87 意味着要优先处理」这件事在界面上
 * 没有任何非颜色的载体。这一页的排序就是处置顺序，档位是它的解释。
 *
 * ⚠️ 门槛 80 / 60 与卡片、抽屉里的颜色判据是**同一份**（那两处原来各写了
 *    一遍 `>= 80` / `>= 60`）。
 */
export type IdleTier = "high" | "mid" | "low";

export function idleTier(score: number): IdleTier {
  if (score >= 80) return "high";
  if (score >= 60) return "mid";
  return "low";
}

/** 档位 → 颜色变量名。与 `idleTier` 同源，调用方不再自己写阈值。 */
export function idleTierColor(score: number): string {
  return { high: "var(--red)", mid: "var(--orange)", low: "var(--muted)" }[
    idleTier(score)];
}

/** 档位 → 给读屏与 hover 的一句话（含**为什么**，不只是档名）。 */
export function idleTierText(score: number, zh: boolean): string {
  const t = idleTier(score);
  if (!zh) {
    return { high: "high — act first", mid: "medium", low: "low" }[t];
  }
  return {
    high: "高 —— 建议优先处理", mid: "中", low: "低",
  }[t];
}

export type IdleBadgeKind = "score" | "undecided" | "severity";

export function idleBadgeKind(
  row: { kind: string; idle_score: number | null },
): IdleBadgeKind {
  if (row.kind !== "idle") return "severity";
  return row.idle_score === null ? "undecided" : "score";
}

/**
 * 「实测值 vs 阈值」那一行的措辞。
 *
 * 🔴 「高于 / 低于」由后端的 `direction` 决定，**前端 SHALL NOT 按指标名猜**。
 * 猜错的表现是 `FreeableMemory`（越小越坏）被写成「高于阈值 20%」，
 * 方向正好反了 —— 而那句话读起来完全通顺，没有任何报错。
 *
 * 返回 `null` = 没有可显示的证据（结构性风险是属性判定，本来就没有数值；
 * 存量行也没有）。调用方应当**不渲染那一行**，而不是显示 0。
 */
export function evidenceText(
  row: {
    observed_value: number | null;
    threshold_value: number | null;
    direction: string;
    unit: string;
  },
  zh: boolean,
): { value: string; threshold: string; relation: string } | null {
  if (row.observed_value === null || row.threshold_value === null) return null;
  // 🔴 **缺 `direction` 时 `relation` 为空串，不默认「高于阈值」。**
  //
  //    上一版是 `direction === "bad_down" ? "低于" : "高于"` —— 三元的 else
  //    把「读不到方向」和「越大越坏」合成了同一个分支。而这两个字段来自
  //    **不同的白名单**（`assemble.py` 的 `_EVIDENCE_NUMERIC` 给 value/threshold，
  //    `direction` 只在 `payload.threshold_config.direction` 非空时才落），
  //    所以「有数值、没方向」是真实存在的行形态（存量行尤其如此）。
  //
  //    后果：`FreeableMemory` / `FreeStorageSpace`（越小越坏）会渲染成
  //    「可用内存 1.1% **高于阈值** 20%」。句子通顺、颜色与徽章全对、零报错，
  //    只有结论是反的 —— 客户读完的动作是「不用管」。
  //
  // ⚠️ 返回空串而不是返回 `null`（整行不渲染）：数值本身是有价值的证据，
  //    丢掉整行等于把「1.1%」也藏了。调用方按空串跳过 relation 那一段。
  const relation = row.direction === "bad_down"
    ? (zh ? "低于阈值" : "below threshold")
    : row.direction === "bad_up"
      ? (zh ? "高于阈值" : "above threshold")
      : "";
  return {
    value: fmtValue(row.observed_value, row.unit, zh),
    threshold: fmtValue(row.threshold_value, row.unit, zh),
    relation,
  };
}

/**
 * 按规格百分比判定时的「原始值 / 分母」补充说明。
 *
 * 「可用 2.4%」没法拿去对 CloudWatch 图表（图表是字节），
 * 「可用 200 MB」又说不出这算不算问题（200MB 是 1GB 实例的 20%、
 * 512GB 实例的 0.04%）。所以两个一起给。
 */
export function capacityText(row: {
  raw_value: number | null; denominator: number | null;
}): string | null {
  if (row.raw_value === null || row.denominator === null) return null;
  return `${fmtBytes(row.raw_value)} / ${fmtBytes(row.denominator)}`;
}

/**
 * 证据的「陈旧程度」文案。**只在证据不是本轮的时候返回非空。**
 *
 * `chronic` / `resolving` 的 finding 保留的是上一次命中时的数字 ——
 * 不标注就等于宣称那是今天的水位。
 *
 * 返回 `null` = 证据就是本轮的（或者两个日期任一缺失），调用方**不渲染**。
 */
export function staleEvidenceText(
  row: { evidence_as_of: string; last_run_date: string },
  zh: boolean,
): string | null {
  const asOf = (row.evidence_as_of || "").slice(0, 10);
  const run = (row.last_run_date || "").slice(0, 10);
  if (!asOf || !run || asOf >= run) return null;
  // 天数差。⚠️ 用 UTC 解析（两个都是 `YYYY-MM-DD`），本地时区会在跨日
  // 边界上差一天 —— 「数据截至 1 天前」和「截至今天」的区别就在那一天。
  const d1 = Date.parse(`${asOf}T00:00:00Z`);
  const d2 = Date.parse(`${run}T00:00:00Z`);
  if (!Number.isFinite(d1) || !Number.isFinite(d2)) return null;
  const days = Math.round((d2 - d1) / 86_400_000);
  return zh
    ? `数据截至 ${asOf}（${days} 天前）`
    : `data as of ${asOf} (${days}d ago)`;
}

/**
 * 闲置评分各维度的显示名与实测值单位。
 *
 * 🔴 维度名（`cpu` / `connections` / …）是后端 `scoring/idle.py` 的
 * `WEIGHTS_RDS` / `WEIGHTS_ELASTICACHE` 的键。**这里不许自己发明维度** ——
 * 多写一个键只会得到一个永不出现的标签，少写一个则那一维显示成原始英文键。
 */
export const IDLE_DIM: Record<string, { zh: string; en: string; unit: string }> = {
  cpu: { zh: "CPU 均值", en: "avg CPU", unit: "%" },
  /**
   * 🔴 **均值不是峰值。** `_norm_connections` 读的是 `cand.connections_avg`。
   *
   * 写成「峰值」的后果是把这一维的证据强度说反了：客户看到「连接数峰值 3」
   * 会认为「最忙的时候也只有 3 个连接」——那是很强的删库理由。而实际是
   * 日均 3 个连接，峰值完全可能是几百（一个每天跑一次的批处理库就是这样）。
   */
  connections: { zh: "连接数日均", en: "avg connections", unit: "" },
  /**
   * 🔴 **剩余，不是已用。方向反了。**
   *
   * `_norm_storage` 的 docstring：「剩余存储占分配容量的比例越大 → 存储开得
   * 越浪费」，归一化里也是 `ratio` 直接进分（不取 `1.0 - ratio`）。
   * `BASIS_LABEL.storage_free_ratio` 同样写着「可用存储比例」。
   *
   * 写成「已用」的后果是这一维的数字读起来意思完全相反：一台分配 100GB、
   * 用了 8GB 的库，实测值是 **92**（剩余占比）。标成「存储已用 92%」会让
   * 客户以为磁盘快满了 —— 而这条 finding 的结论恰恰是「存储开太大可以缩」。
   * 两句话在同一张卡片上直接矛盾。
   */
  storage: { zh: "存储剩余", en: "storage free", unit: "%" },
  iops: { zh: "IOPS 均值", en: "avg IOPS", unit: "" },
  memory: { zh: "内存已用", en: "memory used", unit: "%" },
  /**
   * 🔴 **量纲是「每分钟」。** `_norm_requests` 的注释写得很明确：
   * `cache_hits` / `cache_misses` 取自 `Average` 统计量，在 `period=86400`
   * 下等于「那天各 1 分钟数据点的平均值」= 平均每分钟请求数。
   * 门槛字段也因此叫 `requests_per_minute` 而不是 `requests_sum`。
   *
   * 光写「请求数」会被读成当日总量 —— 一个「请求数 12」的 Redis，
   * 按总量理解是「一天 12 次请求，几乎没人用」，按真实量纲是
   * 「每分钟 12 次 ≈ 每天 1.7 万次」。这两个判断的处置动作完全相反。
   */
  requests: { zh: "请求数/分钟", en: "requests/min", unit: "" },
};

/**
 * `BasisCode` → 人话。回答「这个百分比的分母是哪来的」。
 *
 * ⚠️ 缺一个 code 时**返回原值**而不是空串 —— 显示一个陌生的英文枚举
 * 至少能拿去搜代码；显示空白则那一列凭空消失，看起来像后端没给。
 */
export const BASIS_LABEL: Record<string, { zh: string; en: string }> = {
  // 可用 —— 归一化的依据
  cpu_pct: { zh: "CPU 百分比", en: "CPU percentage" },
  conn_over_max: { zh: "连接数 ÷ 上限", en: "connections ÷ max" },
  storage_free_ratio: { zh: "可用存储比例", en: "free storage ratio" },
  iops_over_baseline: { zh: "IOPS ÷ 基线", en: "IOPS ÷ baseline" },
  memory_pct: { zh: "内存百分比", en: "memory percentage" },
  requests_over_threshold: { zh: "请求数 ÷ 门槛", en: "requests ÷ threshold" },
  // 不可用的原因。⚠️ 后三个**不能合并** —— 见 dto.BasisCode 的说明：
  //   denominator_unknown 是「这次没读到，下次可能有」（去查权限 / API）
  //   not_applicable      是「这类资源永远没有这个概念」（Aurora 无分配容量）
  //   混成一句会让运维一直去查一个永远查不到的东西。
  metric_missing: { zh: "缺指标数据", en: "metric missing" },
  denominator_unknown: { zh: "分母本轮没读到", en: "denominator not read" },
  denominator_invalid: { zh: "分母无效", en: "denominator invalid" },
  not_applicable: { zh: "该类资源无此维度", en: "not applicable" },
};

export function basisLabel(code: string, zh: boolean): string {
  const m = BASIS_LABEL[code];
  return m ? (zh ? m.zh : m.en) : code;
}

/**
 * 闲置维度的一行文字：「CPU 均值 2.1% · 贡献 38 分」。
 *
 * ⚠️ `observed` 可能是 null（组合维度没有单一实测值，例如 requests 是
 * GetHits+GetMisses 的合成）。那时**只给贡献分**，不能写「实测 0」——
 * 0 在闲置语义里是「完全没有请求」，恰好是最强的闲置证据，
 * 而真相是「这一维没有单一数字可展示」。
 */
export function idleFactorText(
  f: { name: string; observed: number | null; points: number | null },
  zh: boolean,
): { label: string; observed: string; points: string } {
  const dim = IDLE_DIM[f.name];
  const label = dim ? (zh ? dim.zh : dim.en) : f.name;
  const observed = f.observed === null ? ""
    : fmtValue(f.observed, dim?.unit ?? "", zh);
  const points = f.points === null ? "—"
    : `${f.points.toFixed(1)}${zh ? " 分" : " pts"}`;
  return { label, observed, points };
}

/**
 * 卡片上那句「主因」。取贡献分最高的两维。
 *
 * 🔴 排的是**贡献分**（weight × normalized）而不是归一化值。按归一化值排会
 * 让一个权重 0.10 的维度（IOPS）压过权重 0.40 的 CPU —— 而客户要知道的是
 * 「这个分主要是谁给的」，那就是贡献分。
 *
 * 返回 `null` = 没有可用维度（不该发生，但存量行没有这些字段）。
 */
export function idleTopFactors(
  factors: { name: string; observed: number | null; points: number | null }[],
  zh: boolean,
  take = 2,
): string | null {
  // 🔴 容忍 `undefined`。类型上它是必填数组，但**部署窗口里会出现
  //    「新 JS + 旧 BFF」**：CloudFront 缓存 JS，而 BFF 是 Lambda URL
  //    不走缓存，两者更新不是原子的。那一刻旧 BFF 不返回 `idle_factors`
  //    → `factors.length` 抛 TypeError → **整页白屏**（React 卸载整棵树）。
  //    一个空数组换一次白屏，非常值。
  if (!Array.isArray(factors) || !factors.length) return null;
  const top = [...factors]
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
    .slice(0, take);
  const parts = top.map((f) => {
    const x = idleFactorText(f, zh);
    return x.observed ? `${x.label} ${x.observed}` : x.label;
  });
  return parts.join(zh ? "、" : ", ");
}

/**
 * 显示单位换算：存储值 → 显示值。
 *
 * `units` 来自后端 `RuleField.display_units`（第一项是默认单位）。
 * 空数组 = 按原始值显示。
 */
export function toDisplayUnit(
  stored: number, units: { unit: string; scale: number }[], pick?: string,
): { shown: number; unit: string } {
  if (units.length === 0) return { shown: stored, unit: "" };
  const u = units.find((x) => x.unit === pick) ?? units[0];
  return { shown: stored / u.scale, unit: u.unit };
}

/**
 * 显示值 → 存储值。**取不取整由 `type` 决定。**
 *
 * ```
 * bytes / int   round(显示值 × scale)   字节数与天数没有小数
 * float         显示值 × scale          50 ms × 0.001 = 0.05 s，
 *                                       取整会变成 0 → 那条阈值直接失效
 * ```
 *
 * 🔴 这两支必须分开。第一版对所有类型都取整，于是延迟阈值一保存就变成 0 ——
 * 后端 min 是 0.001，于是报 400；而如果 min 是 0，它会静默存成「阈值 0」，
 * 那条规则从此对所有实例命中。
 */
export function fromDisplayUnit(
  shown: number, units: { unit: string; scale: number }[],
  pick: string, type: string,
): number {
  const u = units.find((x) => x.unit === pick) ?? units[0];
  if (!u) return shown;
  const raw = shown * u.scale;
  return (type === "bytes" || type === "int") ? Math.round(raw) : raw;
}

/**
 * DA verdict 的机器枚举 → 人话。
 *
 * 🔴 `da_verdict` 的取值来自 **skill 的输出信封**
 * （`inspection/domain/report_parse.py` 的 `VERDICTS`，四个值）。它原来在
 * 卡片上被直接 `<b>{f.da_verdict}</b>` 打出来，于是客户看到
 *
 * ```
 * 判读结论 warm_up
 * ```
 *
 * 用户原话（2026-09-01 实测）：「看起来不像是人类可读的词」。
 *
 * ⚠️ **认不出的取值原样返回**，不返回空串。DA 哪天换了措辞、或者我们加了
 * 第五档而 i18n 没跟上，显示一个陌生的英文枚举至少能拿去搜代码；返回空串
 * 则那一行凭空消失，看起来像后端没给这个字段 —— 而那是完全不同的问题。
 *
 * ⚠️ 译名放 i18n 而不是本文件的常量表：这四句是**面向客户的措辞**，
 * 要跟随 locale。本模块只做量纲换算（见文件头的边界说明）。
 * 一致性由 `tests/test_inspection_gating.py` 的元断言钉住
 * （后端 `VERDICTS` 的每一个值都必须有 `insp.verdict.<值>` 这个键）。
 */
export function verdictLabel(
  verdict: string, t: (k: string) => string,
): string {
  const v = (verdict || "").trim();
  if (!v) return "";
  const key = `insp.verdict.${v}`;
  const label = t(key);
  // `t()` 对未登记的键回落成键名本身 —— 那种情况按「认不出」处理。
  return label && label !== key ? label : v;
}

// ---------------------------------------------------------------------------
// 判读状态 —— **卡片与抽屉的唯一判据**
// ---------------------------------------------------------------------------

/**
 * 这些 `skip_reason` 表示「**不需要** AI 判读」，不是「判读缺了」。
 *
 * ```
 * deterministic   闲置轮等纯计算的判定（gating.DETERMINISTIC_RUN_TYPES）
 * playbook        命中已知模式，有确定性结论
 * reused          沿用最近一次的结论（形态没变）
 * rollup_member   同集群同指标已有集群级结论覆盖
 * ```
 *
 * 🔴 **不在这个集合里的三个才是真的缺**：`budget` / `quota` / `kill_switch`
 *    —— `gating.decide()` 那三支都返回 `Decision(dispatch=False)` 而
 *    **不带** conclusion，`Decision.has_conclusion` 的 docstring 明写
 *    它们「必须显式告诉客户『因额度未分析』而不是留白」。
 *
 * ⚠️ 与 `bff/web-chat/inspection.mjs` 的同名常量是同一份清单，
 *    一致性由 `tests/test_inspection_gating.py` 的元断言锁住。
 */
export const NEEDS_NO_AI: ReadonlySet<string> = new Set([
  "deterministic", "playbook", "reused", "rollup_member",
]);

/**
 * 这些看板页上的 finding **结构上永远不会有 DA 判读**（定时轮不派）。
 *
 * ```
 * high_load    threshold_high        → 走 DA        ← 缺判读是真缺陷
 * idle         idle / oversized_*    → 闲置轮，DETERMINISTIC
 * structural   7 条纯属性 + no_capacity_metadata / unsupported_engine
 * ```
 *
 * ⚠️ 这是**兜底**，用来覆盖升级之前写下的行（那些行既没有 `conclusion`
 *    也没有 `skip_reason`）。手动「深入分析」能给任意一条派真判读，
 *    所以它只在 `dispatched` 为假时才该被采信 —— 见 `judgementState`。
 */
export const DETERMINISTIC_KINDS: ReadonlySet<string> = new Set([
  "idle", "structural",
]);

/**
 * 判读在这一条 finding 上处于什么状态。
 *
 * 🔴 **这是卡片与抽屉的唯一判据。** 抽出来的理由是 2026-09-02 review 抓到
 * 的四条缺陷有同一个根因：状态其实是个**四元组**
 * `(dispatched, 有正文, parse_status, skip_reason/conclusion)`，
 * 而两处代码各自只看其中一两个维度，于是同一条 finding 在列表与详情里
 * 有两种说法。
 *
 * ```
 * not_needed    结构上不需要判读（闲置/配置检查的定时轮，或 NEEDS_NO_AI）
 * rule          有确定性结论（conclusion 非空）—— 规则算出来的，不是 AI
 * pending       派了、还没回来          ← 正常等待，1~3 分钟
 * failed        派了、回来了但没内容     ← empty / missing_section，永不再变
 * partial       有正文但没解析出 verdict 或只对上一部分
 * ok            有正文且有 verdict
 * missing       本该判读却没有（budget / quota / kill_switch）
 * ```
 *
 * ## 为什么 `failed` 必须与 `pending` 分开
 *
 * `callback_apply.py` 对 `ParseStatus.EMPTY` 与 `res.missing` 写的是
 * `attach_judgment(parse_status=…)` 而**不带 body / verdict**。落到行上是
 * 「`da_task_id` 有、`da_body` 空、`da_parse_status` 非空」。
 *
 * 上一版抽屉的判据是 `dispatched && !hasJudgment` → 恒真 → 永远显示
 * 蓝色「判读已派发，1~3 分钟后回来」。**那个状态永远不会退出** ——
 * 把一个已经确定失败的结果显示成正常等待，客户会一直刷新。
 *
 * ## 为什么 `partial` 要单独一档
 *
 * `parse_failed` / `partial` 时 `body` 是**整份报告原文**
 * （`callback_apply.py` 的 `res.raw`），而一个 task 最多装 6 条 finding ——
 * 也就是说那段原文里可能是**另外几台资源**的分析。渲染成本条的结论
 * （上一版就是）会让客户在 db-A 的抽屉里读到 db-B 的分析，
 * 而界面配着「AI 判读」标题和时间徽章，看起来完全成功。
 */
export type JudgementState =
  | "not_needed" | "rule" | "pending" | "failed" | "partial" | "ok" | "missing";

export function judgementState(row: {
  kind: string;
  has_judgment: boolean;
  da_verdict: string;
  da_parse_status: string;
  da_task_id: string;
  // ⚠️ 这两个是**可选**的：存量 finding 行没有它们（2026-08-31 才落库），
  //    而 `FindingRow` 如实把它们标成 `string | undefined`。
  //    收窄成必填会让调用方被迫 `?? ""`，那等于把「字段缺失」这件事
  //    在每个调用点各处理一遍。
  conclusion?: string;
  skip_reason?: string;
}, opts: {
  /** 派过判读没有。由列表那一层算（含乐观状态），比 `da_task_id` 更早为真。 */
  dispatched?: boolean;
  /** 抽屉自己拉到的判读全文 —— 最慢但最权威。 */
  detailBody?: string;
} = {}): JudgementState {
  const dispatched = opts.dispatched ?? Boolean(row.da_task_id);
  const status = String(row.da_parse_status || "");

  /**
   * 判读**回来了没有**。三个来源取或，因为它们到达的时刻不同：
   *
   * ```
   * detailBody        抽屉自己拉的全文，最慢但最权威
   * row.has_judgment  列表那一层给的（BFF 里 = Boolean(item.da_body)）
   * row.da_verdict    解析出结论才有
   * ```
   *
   * ⚠️ `da_verdict` 这一路看着多余（有结论必然有正文），但**必须留**：
   *    少了它，「有 verdict、无 body」这个组合会掉进下面的 `dispatched`
   *    分支，`parse_status: "ok"` 被判成 `failed` —— 界面说「判读回来了但
   *    没有内容」而结论就在旁边。这是原 `hasJudgment` 三源取或的用意，
   *    搬过来时不要顺手简化掉。
   */
  const body = opts.detailBody
    || (row.has_judgment || row.da_verdict ? "1" : "");

  // ① 有正文 —— 只有「解析干净 **且** 有结论」才算 ok，其余一律 partial。
  //
  //    ⚠️ `parse_failed` / `partial` / `missing_section` 时那段正文是
  //       **整份报告原文**（`callback_apply.py` 的 `res.raw`），而一个 task
  //       最多装 6 条 finding —— 也就是说里面可能是别的资源的分析。
  //       调用方必须标注出来，不能当本条的结论直接渲染。
  if (body) {
    const clean = !status || status === "ok";
    return clean && row.da_verdict ? "ok" : "partial";
  }

  // ② 没正文但**派过** —— 分「还在路上」与「回来了是空的」。
  //    判据是 `da_parse_status` 有没有值：callback 写它的时候判读已经回来了。
  if (dispatched) {
    return status ? "failed" : "pending";
  }

  // ③ 没派过 —— 有确定性结论就是 `rule`，结构上不需要就是 `not_needed`，
  //    剩下的才是真的缺（budget / quota / kill_switch）。
  if (row.conclusion) return "rule";
  if (NEEDS_NO_AI.has(row.skip_reason || "")
      || DETERMINISTIC_KINDS.has(row.kind)) {
    return "not_needed";
  }
  return "missing";
}

/* 动态拼 i18n 键的前缀，**必须提成命名常量**（而不是内联进模板字符串）。
 *
 * 🔴 这不是风格洁癖，是让 `scripts/lint_i18n.py::check_frontend_orphans`
 * 能看见这些键。那个检查靠两条正则认「动态键」：
 *   ① t(`insp.x.${v}`)     —— 前缀直接跟在 t( 后面
 *   ② "insp.x."            —— 引号包裹、以点结尾的字面量
 * 下面两个函数都要拿 `key` 跟 `t(key)` 的返回值比（认不出就原样返回，见各自
 * docstring），所以键必须先落在一个变量上，形态 ① 用不上。内联写成
 * `const key = \`insp.parse.${s}\`` 两条都不命中 —— 于是 5 个
 * `insp.parse.*` 被报成「定义了没人用」，当年是塞进 `i18n_baseline.txt`
 * 蒙过去的（第 99-103 行），而基线的意思是「已知欠债」，不是「这样写没问题」。
 * 提成常量后字面量命中 ②，8 个 `insp.degraded.*` 和 5 个 `insp.parse.*`
 * 一起被认出来，那 5 条基线也就能销了。
 */
const PARSE_KEY_PREFIX = "insp.parse.";
/* ⚠️ 是 `insp.gate.` 而**不是** `insp.degraded.` —— 后者早就被两个讲「判读
 * 压根没回来」的键占着（`insp.degraded.title` / `.partialNoVerdict`），那是
 * 另一个维度。混进同一个命名空间的直接代价：`test_前端的降级码译名没有多余项`
 * 那条反面断言要为它们开两个例外，而例外清单是会被后来人当成「随便加」的。
 * 用 `insp.gate.` 之后这个前缀下**只有** 8 档门禁码，与写侧的
 * `da_gate_trustworthy` / 后端 `journal_gate.py` 同一套词。 */
const DEGRADED_KEY_PREFIX = "insp.gate.";

/**
 * `da_parse_status` 的机器枚举 → 人话。
 *
 * 🔴 上一版把 `parse_failed` / `empty` / `missing_section` 原样打给客户看。
 * 而 `da_verdict` 早就因为「看起来不像是人类可读的词」被 `verdictLabel`
 * 修过 —— 这是同一个问题的未修版本。
 *
 * ⚠️ 认不出的取值**原样返回**，不返回空串：一个陌生的英文枚举至少能拿去
 * 搜代码，空白则那一行凭空消失、看起来像后端没给这个字段。
 */
export function parseStatusLabel(
  status: string, t: (k: string) => string,
): string {
  const s = (status || "").trim();
  if (!s) return "";
  const key = `${PARSE_KEY_PREFIX}${s}`;
  const label = t(key);
  return label && label !== key ? label : s;
}

/**
 * 一档降级码 → 人话（7.9a skill 门禁，D22）。
 *
 * 后端 `inspection/domain/journal_gate.py::Degradation` 共 8 档：
 * `skill_not_loaded` / `wrong_skill` / `no_journal` / `no_data_access`
 * （这四档 ⇒ 不可信）、`compaction` / `analysis_gap` / `extra_skill` /
 * `parse_failed`（这四档仅降级，方法论仍生效）。
 *
 * ⚠️ 与 `parseStatusLabel` 同套：认不出的取值**原样返回**，不返回空串。
 * 后端加了新档而前端文案没跟上时，客户至少看到一个能拿去搜代码的英文枚举；
 * 空白则那一条凭空消失，看起来像后端没给这个字段。
 */
export function degradationLabel(
  code: string, t: (k: string) => string,
): string {
  const c = (code || "").trim();
  if (!c) return "";
  const key = `${DEGRADED_KEY_PREFIX}${c}`;
  const label = t(key);
  return label && label !== key ? label : c;
}

/**
 * 门禁徽标的 `title`（悬浮全文）。
 *
 * 🔴 `Badge` 把 `title` 映射成 `aria-label`，所以**整句话**要放在这里 ——
 * 徽标面上只有「判读不可信 ⓘ」四个字加一个数字，屏幕阅读器与鼠标悬浮
 * 拿到的必须是「为什么」。
 *
 * ⚠️ 传 `t` 而不是在这里写死中英：8 档文案在 `i18n.ts` 里成对维护
 * （`lint_i18n` 守着 zh/en 必须同时存在）。这里只负责拼装。
 */
/** degradeTitle / 详情抽屉共用的 row 形状 —— 只关心门禁三字段。 */
type GateRow = {
  da_gate_trustworthy?: boolean | null; da_degradations?: string[] | null;
  da_skills_loaded?: string[] | null;
};

/**
 * 「这次调查实际加载了什么 skill」的一句话。排查 `wrong_skill` /
 * `skill_not_loaded` 的唯一直接线索，徽标 title 与详情抽屉都要说。
 *
 * ⚠️ 空数组要说成「一个都没加载」而不是省略 —— 那正是 `skill_not_loaded`
 *    的形态；`null`/缺失（没验过）才返回空串。
 */
export function skillsLoadedText(
  row: GateRow, zh: boolean, t: (k: string) => string,
): string {
  if (row.da_skills_loaded === null || row.da_skills_loaded === undefined) {
    return "";
  }
  const loaded = row.da_skills_loaded;
  return loaded.length
    ? t("insp.gate.skillsLoaded")
      .replace("{s}", loaded.join(zh ? "、" : ", "))
    : t("insp.gate.skillsNone");
}

/**
 * 门禁徽标的 `title`（悬浮全文）。
 *
 * 🔴 `Badge` 把 `title` 映射成 `aria-label`，所以**整句话**要放在这里 ——
 * 徽标面上只有「判读不可信 ⓘ」四个字加一个数字，屏幕阅读器与鼠标悬浮
 * 拿到的必须是「为什么」。
 *
 * ⚠️ 传 `t` 而不是在这里写死中英：全部文案（8 档 + 两句开头 + skill 行）
 * 在 `i18n.ts` 里成对维护（`lint_i18n` 守着 zh/en 必须同时存在）。
 * 这里只负责拼装。开头两句与详情抽屉的 Alert header 是**同一对键** ——
 * 悬浮读到的话和点开抽屉读到的话必须一致，两处各写一份迟早漂移。
 */
export function degradeTitle(
  row: GateRow,
  zh: boolean,
  t: (k: string) => string,
): string {
  const codes = row.da_degradations ?? [];
  const names = codes.map((c) => degradationLabel(c, t)).filter(Boolean);
  const sep = zh ? "；" : "; ";
  const head = row.da_gate_trustworthy === false
    ? t("insp.gate.headUntrusted")
    : t("insp.gate.headDegraded");
  return [head + (zh ? "：" : ": ") + names.join(sep),
    skillsLoadedText(row, zh, t)].filter(Boolean).join(sep);
}
