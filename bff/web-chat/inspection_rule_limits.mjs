/**
 * 客户可改的判定阈值：字段清单与取值范围。
 *
 * 🔴 **这是 `inspection/domain/rule_limits.py` 的镜像，不是第二个真源。**
 *
 * 为什么不共用一个文件：两边的打包边界隔开了 —— BFF 的 asset 只含
 * `bff/web-chat/`（`web-chat-stack.ts` 的 `fromAsset(join(__dirname,"..","..","bff","web-chat"))`），
 * 而 Python lambda 的 asset `exclude` 了 `bff/**`。物理上没法引用对方的文件。
 *
 * ⚠️ `tests/inspection.test.mjs` 里有元断言**逐字段**比对两侧（直接解析
 * Python 源，不靠人工同步）。分叉的表现是静默的：
 *   · BFF 放行一个 Python 侧会钳掉的值 → 客户以为设成了 200，实际判定用 100
 *   · BFF 比 Python 严 → UI 上填不进一个后端其实接受的值
 *
 * ⚠️ 刻意**不开放**的字段（不是漏了）：
 *   · `IdleRuleConfig.window_days` / `InspectionConfig.window_days`
 *     它们是**数据窗口**，与采集耦合。改成 14 而序列库只有 7 天数据
 *     → 判定拿不到数，表现是「调完之后什么都不报了」
 *   · `InspectionConfig.max_workers` 并发度，运行参数不是判定门槛
 */

export const INT = "int";
export const FLOAT = "float";
export const STR_SET = "str_set";
export const BYTES = "bytes";

export const RDS = "rds";
export const AURORA = "aurora";
export const REDIS = "redis";
export const MEMCACHED = "memcached";

/**
 * 客户在 UI 上能选的四个服务组。
 *
 * 🔴 **这是「筛选视图」而不是「作用域」。** 阈值配置是**全局一份** ——
 * `cpu_utilization` 就是一个阈值，RDS 与 Redis 共用它。选服务只决定显示
 * 哪些字段，不是「给这个服务单独设一套」。
 *
 * ⚠️ UI SHALL 明示这一点。做成看起来像作用域的样子（比如每个服务一个独立
 * 的保存按钮）会让客户以为「我只调了 Redis」而实际上 RDS 也跟着变了 ——
 * 那种误解没有任何运行时信号。
 *
 * ## 为什么是 4 组而不是 7 个 MetricFamily
 *
 * `metrics_meta.MetricFamily` 有 7 个成员，但对**阈值字段**的支持在组内
 * 完全一致（rds-mysql / rds-postgres / rds-other 三者对 10 个指标阈值的
 * 支持相同，差异只在 `MaximumUsedTransactionIDs` —— 那不是可配阈值；
 * 两个 aurora family 同理；valkey 的 family 就是 redis）。
 * 合成 4 组不丢精度，而 7 组会让客户面对「rds-other 是什么」这种问题。
 */
export const SERVICES = Object.freeze([RDS, AURORA, REDIS, MEMCACHED]);

export const SERVICE_LABELS = Object.freeze({
  [RDS]: { zh: "RDS", en: "RDS",
    hint_zh: "MySQL / PostgreSQL / MariaDB / Oracle / SQL Server",
    hint_en: "MySQL / PostgreSQL / MariaDB / Oracle / SQL Server" },
  [AURORA]: { zh: "Aurora", en: "Aurora",
    hint_zh: "Aurora MySQL / PostgreSQL", hint_en: "Aurora MySQL / PostgreSQL" },
  [REDIS]: { zh: "ElastiCache Redis", en: "ElastiCache Redis",
    hint_zh: "Redis / Valkey", hint_en: "Redis / Valkey" },
  [MEMCACHED]: { zh: "ElastiCache Memcached", en: "ElastiCache Memcached",
    hint_zh: "Memcached", hint_en: "Memcached" },
});

/** 四组都适用 —— 比逐个列出来更能表达「与服务无关」。 */
const ALL = SERVICES;
/** RDS 与 Aurora 共有（`attrs.service` 都是 `"rds"`）。 */
const RDS_LIKE = Object.freeze([RDS, AURORA]);
/** 两种 ElastiCache 引擎共有。 */
const EC = Object.freeze([REDIS, MEMCACHED]);

const f = (section, key, type, def, min, max, unit, zh, en, services) => ({
  section, key, type, default: def, min, max, unit: unit || "",
  label_zh: zh, label_en: en,
  // 🔴 这个字段对哪些服务真的生效。空缺的表现是客户改了没反应而**零提示**。
  services: Object.freeze(services || ALL),
});

/**
 * 高负载轮（run_type=high）。**OR 语义**（R2.1）：任一指标越界即命中，
 * 所以调高任意一个只会让那一项少报，不会让整条规则失效。
 */
const THRESHOLD = [
  f("threshold", "cpu_utilization", FLOAT, 70.0, 0.1, 100.0, "%", "CPU 使用率", "CPU utilization", ALL),
  // 🔴 只对 T 系实例生效（判定侧按 specs.is_burstable 逐台加判）。
  //    对 T 系，CPUUtilization 会骗人：credit 耗尽后 CPU 被压到 baseline
  //    （t4g 10%~40%），「CPU 30%」与「打满」是同一件事而 70% 门槛不响。
  //    实测真实客户 49 台 RDS 里 18 台（37%）是 T 系。四个服务都适用 ——
  //    ElastiCache 也有 cache.t* 且确实发布这个指标。
  f("threshold", "cpu_credit_balance_min", FLOAT, 10.0, 0.0, 10000.0, "", "CPU credit 余额下限", "CPU credit balance floor", ALL),
  // 🔴 内存与存储是**按规格的百分比**，不是绝对量（用户 2026-08-23 定）。
  //    绝对值门槛在机型跨度大的账号里两端都错：500MB 在 db.t4g.micro（1 GB）
  //    上是「用一半就告警」，在 db.r6g.16xlarge（512 GB）上是「99.9% 才告警」。
  // 🔴 20 → 10（真实客户数据校准）。实测 49 台社区版 RDS 的可用内存
  //    p50 只有 12.6%，20% 压在正常水位上（误报 69%）—— MySQL 的 buffer
  //    pool 默认占 75% 且不计入 MemAvailable。ElastiCache 侧 p50 是 64~76%，
  //    10% 对它命中 0~1%，所以四个服务统一 10 是安全的。
  f("threshold", "freeable_memory_pct", FLOAT, 10.0, 1.0, 50.0, "%", "可用内存下限", "Freeable memory floor", ALL),
  // 🔴 伴随门槛，与上一条是 AND：可用内存低**且**在实质回盘读才算命中。
  //    依据是官方 Best Practices「DB instance RAM recommendations」——
  //    判断工作集放不放得下，那一节只提 ReadIOPS 一个指标。
  //    量纲 IOPS/s（ReadIOPS 的统计量是 Average，不是 Sum）。
  f("threshold", "memory_read_iops_min", FLOAT, 20.0, 0.0, 1000000.0, "", "内存判定的回盘读门槛", "Read IOPS floor for memory verdict", RDS_LIKE),
  // Aurora 存储自动扩展，没有 FreeStorageSpace 这个指标。
  // 🔴 10 → 15：对齐官方唯一的硬数字「consistently at or above 85 percent」。
  f("threshold", "free_storage_pct", FLOAT, 15.0, 1.0, 50.0, "%", "可用存储下限", "Free storage floor", [RDS]),
  // 🔴 latency 按引擎分档（2026-08-23）。Aurora p90 3.83ms / max 7.42ms，
  //    社区版 p90 10.0ms、写延迟 p99 **556ms** —— 差一个数量级。
  //    50ms 旧默认在两种引擎上都是死规则（命中率 0%）。
  // ⚠️ 靠已有的 services 机制分档：RDS 页与 Aurora 页各显示自己那个字段，
  //    标签相同而互不干扰 —— 它们真的是两个独立字段，不是「作用域」。
  f("threshold", "read_latency_seconds", FLOAT, 0.015, 0.001, 10.0, "s", "读延迟", "Read latency", [RDS]),
  f("threshold", "read_latency_seconds_aurora", FLOAT, 0.005, 0.001, 10.0, "s", "读延迟", "Read latency", [AURORA]),
  f("threshold", "write_latency_seconds", FLOAT, 0.030, 0.001, 10.0, "s", "写延迟", "Write latency", [RDS]),
  f("threshold", "write_latency_seconds_aurora", FLOAT, 0.010, 0.001, 10.0, "s", "写延迟", "Write latency", [AURORA]),
  f("threshold", "disk_queue_depth", FLOAT, 10.0, 1.0, 1000.0, "", "磁盘队列深度", "Disk queue depth", RDS_LIKE),
  // 🔴 Redis 主线程单线程 —— 4 vCPU 上引擎打满时整机 CPU 仅约 25%，所以它要
  //    单独一个门槛。Memcached 多线程、没有这个指标，看整机 CPU。
  f("threshold", "engine_cpu_utilization", FLOAT, 70.0, 0.1, 100.0, "%", "引擎 CPU 使用率", "Engine CPU utilization", [REDIS]),
  f("threshold", "database_memory_usage_pct", FLOAT, 90.0, 0.1, 100.0, "%", "内存使用率", "Memory usage", [REDIS]),
  // 🔴 新采的指标（2026-08-23）。实测某生产账号有 34% 的节点碎片率 >2、
  //    p99 = 21.79，此前完全没采。定 3.0 而不是 1.5（后者命中 47%，没人会看）。
  //    ⚠️ Memcached 用 slab 分配器，不暴露这个比率 → 只给 REDIS。
  f("threshold", "memory_fragmentation_ratio", FLOAT, 3.0, 1.0, 100.0, "", "内存碎片率上限", "Memory fragmentation ratio", [REDIS]),
  // 🔴 与 database_memory_usage_pct 是 AND：有驱逐**且**内存 >90% 才命中。
  //    allkeys-lru 下驱逐是设计行为 —— 实测有驱逐的 6 个节点全部内存 >90%。
  f("threshold", "evictions", FLOAT, 0.0, 0.0, 1000000.0, "", "驱逐数", "Evictions", EC),
  f("threshold", "swap_usage_bytes", BYTES, 52428800, 0, 17179869184, "B", "Swap 使用量", "Swap usage", ALL),
  // 下面三个是**置信门槛**不是指标阈值：决定「攒够多少数据才敢判」。与服务无关。
  f("threshold", "min_coverage_days", INT, 5, 1, 30, "d", "最少覆盖天数", "Min coverage days", ALL),
  f("threshold", "chronic_days_min", INT, 5, 2, 30, "d", "慢性高位最少天数", "Chronic min days", ALL),
  f("threshold", "chronic_min_coverage", INT, 7, 2, 30, "d", "慢性判定最少覆盖", "Chronic min coverage", ALL),
];

/**
 * 闲置轮（run_type=idle）。🔴 **AND 语义**（R2.2）：必须同时满足才算候选，
 * 再经峰值与隐形负载两道否决。所以把任意一个调**大**都会让更多资源被判闲置
 * —— 与高负载轮方向相反，搞错就是「越调越多误报」。
 */
const IDLE = [
  // ⚠️ 两类都生效，但**读的指标名不同**（`metrics_repo._ec_candidate`）：
  //      RDS  CPUUtilization+DatabaseConnections / Redis EngineCPUUtilization+CurrConnections
  //      Memcached CPUUtilization+CurrConnections。字段是同一个。
  f("idle", "candidate_cpu_avg", FLOAT, 2.0, 0.0, 100.0, "%", "闲置候选 CPU 均值上限", "Idle candidate CPU avg", ALL),
  f("idle", "candidate_connections", INT, 5, 0, 10000, "", "闲置候选连接数上限", "Idle candidate connections", ALL),
  f("idle", "peak_cpu_veto", FLOAT, 50.0, 0.0, 100.0, "%", "峰值 CPU 否决线", "Peak CPU veto", ALL),
  // `veto._check_rds` 才读这两个
  f("idle", "iops_total", INT, 500, 0, 1000000, "", "总 IOPS 否决线", "Total IOPS veto", RDS_LIKE),
  f("idle", "write_iops", INT, 1000, 0, 1000000, "", "写 IOPS 否决线", "Write IOPS veto", RDS_LIKE),
  // `veto._check_elasticache` 才读这三个
  f("idle", "evictions", INT, 0, 0, 1000000, "", "驱逐否决线", "Evictions veto", EC),
  f("idle", "requests_per_minute", INT, 1000, 0, 10000000, "", "每分钟请求否决线", "Requests/min veto", EC),
  f("idle", "conn_max", INT, 10, 0, 10000, "", "最大连接否决线", "Max connections veto", EC),
  f("idle", "consecutive_days_step", FLOAT, 0.1, 0.0, 1.0, "", "连续天数加权步长", "Consecutive-day weight step", ALL),
];

const CAPACITY = [
  // `capacity.AUDITS["rds"]` = audit_oversized_storage
  // 🔴 量纲是 0~100 的**百分数**，不是 0~1 的比例。同一个配置页上
  //    threshold.free_storage_pct 是百分数，两个同名字段一个填 0.4
  //    一个填 10 的话客户必然填错，而门槛差 100 倍且不报错。
  f("capacity", "free_storage_pct", FLOAT, 40.0, 0.0, 100.0, "%", "可用存储占比上限（判超配）", "Free storage ratio (oversized)", [RDS]),
  // 两个 audit 都用它
  f("capacity", "cpu_max_veto", FLOAT, 50.0, 0.0, 100.0, "%", "CPU 峰值否决线", "CPU max veto", ALL),
  // `audit_oversized_memory` 开头就 `if is_memcached: return` → 只 Redis
  f("capacity", "swap_max_gb", FLOAT, 0.01, 0.0, 1024.0, "GB", "Swap 上限", "Swap max", [REDIS]),
  f("capacity", "memory_util_max", FLOAT, 30.0, 0.0, 100.0, "%", "内存使用率上限", "Memory utilization max", [REDIS]),
];

const STRUCTURAL = [
  // RULE_SERVICES[ENGINE_EOL] = {rds, elasticache} —— 四组都有
  f("structural", "engine_eol_lead_days", INT, 180, 1, 730, "d", "引擎 EOL 提前告知天数", "Engine EOL lead days", ALL),
  // RULE_SERVICES[CA_CERT_EXPIRING] = {rds} —— ElastiCache 不管理 CA 证书
  f("structural", "ca_cert_lead_days", INT, 90, 1, 730, "d", "CA 证书到期提前天数", "CA cert lead days", RDS_LIKE),
  // 这两个是**标签值**不是数值。客户的 tag 未必叫 prod / tier1 —— 改不了它
  // 等于结构性规则里所有「只报生产库」的判据对该客户全部失效。
  f("structural", "prod_tiers", STR_SET, ["prod", "tier1"], null, null, "", "视为生产环境的 tier 标签", "Tags treated as production", ALL),
  f("structural", "read_replica_required_tiers", STR_SET, ["tier1"], null, null, "", "必须有只读副本的 tier 标签", "Tiers requiring a read replica", ALL),
];

export const FIELDS = Object.freeze([...THRESHOLD, ...IDLE, ...CAPACITY, ...STRUCTURAL]);

/** 哪一轮能改哪几个 section（R11.1：两轮独立，不互相影响）。 */
export const BY_RUN_TYPE = Object.freeze({
  high: Object.freeze(["threshold"]),
  idle: Object.freeze(["idle", "capacity", "structural"]),
});

export const SECTIONS = Object.freeze(["threshold", "idle", "capacity", "structural"]);

export function fieldsOf(section) {
  return FIELDS.filter((x) => x.section === section);
}

/** 这个字段对该服务组生效吗。`service` 为空 = 不筛选。 */
export function appliesTo(spec, service) {
  if (!service) return true;
  return (spec.services || []).includes(service);
}

/**
 * 该服务组一共有多少个可改字段 —— UI 的「显示 22 / 共 30 项」用它。
 *
 * ⚠️ 必须让客户看见这个数。选了 Memcached 只剩十几个字段，不说的话会以为
 * 「字段丢了」而不是「那些对 Memcached 不适用」。
 */
export function countFor(service) {
  return FIELDS.filter((x) => appliesTo(x, service)).length;
}

/**
 * 给 UI 的服务筛选器数据：四个服务组 + 各自的字段数。
 *
 * 🔴 **这是筛选器不是作用域。** 调用方 SHALL 把这句话呈现出来。
 */
export function serviceCatalog() {
  return SERVICES.map((svc) => ({
    key: svc,
    label_zh: SERVICE_LABELS[svc].zh,
    label_en: SERVICE_LABELS[svc].en,
    hint_zh: SERVICE_LABELS[svc].hint_zh,
    hint_en: SERVICE_LABELS[svc].hint_en,
    field_count: countFor(svc),
  }));
}

export function sectionsFor(runType) {
  return BY_RUN_TYPE[String(runType)] || [];
}

export function findField(section, key) {
  return FIELDS.find((x) => x.section === section && x.key === key) || null;
}

/**
 * 写侧校验。返回 `{value, code}`，`code` 为空即合法。
 *
 * ⚠️ 错误码与 Python 侧 `rule_config.validate` **逐字相同**
 * （`unknown_field` / `bad_type` / `below_min` / `above_max`），
 * 因为两边可能各自先拦到，而客户看到的错误提示只有一套文案。
 */
export function validateField(section, key, raw) {
  const spec = findField(section, key);
  if (!spec) return { value: null, code: "unknown_field" };
  if (spec.type === STR_SET) {
    if (!Array.isArray(raw)) return { value: null, code: "bad_type" };
    const vals = raw.map((v) => String(v).trim()).filter(Boolean);
    if (vals.length === 0) return { value: null, code: "bad_type" };
    return { value: [...new Set(vals)].sort(), code: "" };
  }
  // ⚠️ 布尔要显式拒。JS 的 Number(true) === 1，不拦的话「勾了个开关」
  //    会被存成阈值 1，而 1 对多数字段都是合法值 —— 完全静默。
  if (typeof raw === "boolean") return { value: null, code: "bad_type" };
  const n = Number(raw);
  if (raw === null || raw === undefined || raw === "" || !Number.isFinite(n)) {
    return { value: null, code: "bad_type" };
  }
  const val = spec.type === INT ? Math.trunc(n) : n;
  if (spec.min !== null && val < spec.min) return { value: null, code: "below_min" };
  if (spec.max !== null && val > spec.max) return { value: null, code: "above_max" };
  return { value: val, code: "" };
}

/**
 * 把请求体规范化成只含合法字段的覆盖字典。
 *
 * ⚠️ 有任何一个字段不合法就**整个拒**，不做部分写入 —— 部分成功会让客户
 * 以为全都存上了，而下一轮只有一半生效。
 */
export function normalizeOverrides(runType, body) {
  const allowed = sectionsFor(runType);
  if (allowed.length === 0) return { overrides: {}, errors: [`bad_run_type:${runType}`] };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { overrides: {}, errors: ["bad_body"] };
  }
  const out = {};
  const errors = [];
  for (const [section, sub] of Object.entries(body)) {
    if (!allowed.includes(section)) { errors.push(`section_not_allowed:${section}`); continue; }
    if (!sub || typeof sub !== "object" || Array.isArray(sub)) {
      errors.push(`bad_section_body:${section}`); continue;
    }
    for (const [key, value] of Object.entries(sub)) {
      const { value: v, code } = validateField(section, key, value);
      if (code) { errors.push(`${code}:${section}.${key}`); continue; }
      (out[section] ||= {})[key] = v;
    }
  }
  errors.push(...crossFieldErrors(out));
  return { overrides: out, errors };
}

/**
 * 跨字段不变量 —— 必须与 `inspection/domain/rule_config.py::_CROSS_FIELD` 一致。
 *
 * `validateField` 是逐字段的，表达不了「A 不得小于 B」。少这一层的后果是
 * **写侧放行、读侧抛**：
 *
 * ```
 * 客户把 chronic_days_min 从 5 调到 10（范围 2..30，逐字段校验放行）
 *   → chronic_min_coverage 还是默认 7
 *   → 下一轮 executor 的 ThresholdRuleConfig.__post_init__ 抛 ValueError
 *   → run failed → SQS 重投 → DLQ → **两类巡检每天全失败**
 *     （`_run_inspection` 连闲置轮也无条件调 threshold_config）
 * ```
 *
 * 客户看到的是「巡检不再产出」，而原因是一个 UI 接受了的数字。
 *
 * ⚠️ 判据用**生效值**（这次的覆盖 ∪ 默认值），不能只看这次改了哪个 ——
 *    客户只改一个字段时另一个是默认值，而冲突恰恰发生在那种情况。
 */
function crossFieldErrors(out) {
  const RULES = [
    ["threshold", "chronic_min_coverage", "chronic_days_min",
      "chronic_min_coverage 不得小于 chronic_days_min —— "
      + "否则「连续 N 天」在 coverage 窗口里永远数不出来，慢性规则静默失效"],
  ];
  const errs = [];
  for (const [section, big, small, why] of RULES) {
    const body = out[section] || {};
    if (!(big in body) && !(small in body)) continue;
    const dflt = (k) => {
      const spec = FIELDS.find((f) => f.section === section && f.key === k);
      return spec ? spec.default : null;
    };
    const effBig = big in body ? body[big] : dflt(big);
    const effSmall = small in body ? body[small] : dflt(small);
    if (effBig === null || effSmall === null) continue;
    if (effBig < effSmall) errs.push(`cross_field:${section}.${big}<${small}:${why}`);
  }
  return errs;
}

/**
 * 给 UI 的完整描述：当前值 + 默认值 + 范围 + 单位 + 改过没有。
 *
 * ⚠️ 前端 SHALL NOT 自己写死范围 —— 那会与后端校验分叉，表现是
 * 「UI 上填得进去、点保存报 400」。
 */
/**
 * `section.key` → 显示单位与换算系数。**第一项是默认显示单位。**
 *
 * 🔴 `inspection/domain/rule_limits.py::DISPLAY_UNITS` 的镜像。
 * `tests/test_inspection_rule_config.py` 逐项比对，且断言「每个 BYTES 字段
 * 与每个秒级字段都必须登记」—— 漏了的表现是输入框里躺着 `524288000`。
 *
 * ⚠️ 存储值永远是**基础单位**（字节 / 秒）。这张表只影响显示：
 * `显示值 = 存储值 / scale`，保存时 `存储值 = round(显示值 × scale)`。
 * 校验仍按换算回来的存储值打 min/max。
 */
export const DISPLAY_UNITS = Object.freeze({
  "threshold.swap_usage_bytes": [["MB", 1048576], ["GB", 1073741824]],
  "threshold.read_latency_seconds": [["ms", 0.001], ["s", 1]],
  "threshold.write_latency_seconds": [["ms", 0.001], ["s", 1]],
  // ⚠️ Aurora 那两档也要 —— 漏了的表现是 Aurora 页显示「0.005 s」而
  //    RDS 页显示「15 ms」，同一个概念两种量纲，客户会填错 1000 倍。
  "threshold.read_latency_seconds_aurora": [["ms", 0.001], ["s", 1]],
  "threshold.write_latency_seconds_aurora": [["ms", 0.001], ["s", 1]],
});

/** 该字段的显示单位表。`[]` = 按原始值显示（多数字段是这样）。 */
export function displayUnitsOf(section, key) {
  return DISPLAY_UNITS[`${section}.${key}`] || [];
}

export function describeRules(runType, stored) {
  const body = (stored && typeof stored === "object") ? stored : {};
  const out = {};
  for (const section of sectionsFor(runType)) {
    const cur = (body[section] && typeof body[section] === "object") ? body[section] : {};
    out[section] = fieldsOf(section).map((spec) => {
      const has = Object.prototype.hasOwnProperty.call(cur, spec.key);
      let value = spec.default;
      if (has) {
        const { value: v, code } = validateField(section, spec.key, cur[spec.key]);
        if (!code) value = v;
      }
      const units = displayUnitsOf(section, spec.key);
      return {
        key: spec.key, type: spec.type, value,
        default: spec.default, min: spec.min, max: spec.max, unit: spec.unit,
        label_zh: spec.label_zh, label_en: spec.label_en,
        // 显示单位。🔴 前端 SHALL NOT 自己写死换算表 —— 与 min/max/default
        //    同一条规矩（`api/inspection.ts` 的说明）。空数组 = 按原始值显示。
        display_units: units.map(([u, scale]) => ({ unit: u, scale })),
        display_unit: units.length ? units[0][0] : "",
        // 🔴 这个字段对哪些服务组真的生效。不给的话客户改了
        //    `read_latency_seconds` 会以为 Redis 也跟着变 —— 完全不生效且零提示。
        services: [...(spec.services || [])],
        // 客户改过没有 —— 否则「默认 70 而客户也填了 70」与「没配过」长得一样。
        customized: has,
      };
    });
  }
  return out;
}
