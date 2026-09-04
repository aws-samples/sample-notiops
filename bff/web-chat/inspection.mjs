/**
 * 资源巡检看板的数据层（R10.10）。**只读。**
 *
 * ## 六个端点各服务哪一页
 *
 * ```
 * GET /inspection/overview   9.8   KPI 卡（含 diff 箭头）+ 最近 run
 * GET /inspection/findings   9.9/9.10/9.12  高负载 / 闲置 / 结构性列表
 * GET /inspection/finding    9.6   右侧停靠详情（判读全文 / degraded 段）
 * GET /inspection/series     9.11/9.16  趋势图 + sparkline
 * GET /inspection/scope      9.13  两份排除清单 + 两份巡检范围
 * GET /inspection/config     9.14/9.15  三类规则 + 定时 + 额度使用率
 * ```
 *
 * ## 只读是硬约束
 *
 * 写入路径（改阈值、加排除）会**改变下一轮巡检的行为**，必须走独立的
 * `action:inspection:*` 能力而不是搭在看板的 `nav:inspection` 上 ——
 * 后者是「能看」，前者是「能改」。合在一起意味着任何能看看板的人都能
 * 把生产库从巡检范围里摘掉，而那个操作没有任何运行时信号。
 *
 * ## 数字全部来自 Lambda 已经算好的确定性结果
 *
 * R9.1 明写「所有数字 SHALL 由巡检 Lambda 确定性计算」。本模块**不做任何判定**，
 * 只做「读出来 + 排序 + 分组」。在这里补算一个百分比就意味着同一个数字有两个
 * 来源，而两处必然分叉（分叉的表现是看板与报告写着不同的数）。
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { FINDING_GSI1PK, FINDING_GSI1_INDEX,
  RUN_TYPES,
  SCHEDULE_PK,
  SEVERITIES,
  configVersionPk,
  dataBatchPk,
  findingPk,
  runPk,
  scopePk,
  seriesPk,
  targetPk,
} from "./inspection_keys.mjs";
import {
  describeRules, normalizeOverrides, sectionsFor,
  serviceCatalog as ruleServiceCatalog,
} from "./inspection_rule_limits.mjs";

const TABLE = process.env.INSPECTION_TABLE || "notiops-inspection";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** 统一错误形状 —— 与 `api/eos.ts` 等既有 client 的约定一致（绝不 throw 给前端）。 */
const fail = (code, message) => ({ ok: false, code, message: message || "" });

/**
 * 账号解析：空值 → 部署账号。
 *
 * 🔴 为什么需要它：前端的账号选择器把 **空字符串定义为「部署账号」**
 * （`InspectionDashboard.tsx` 的 `<option value="">部署账号</option>`），
 * 而选择器本身只在 `accounts.length > 0` 时才渲染。全新部署的成员账号
 * 登记表（`notiops-config` GSI1 `GSI1PK=accounts`）是空的 —— 于是：
 *
 *     无成员账号 → 选择器不渲染 → accountId 恒 "" → 六个端点全 account_required
 *
 * 表现是**装完第一次打开看板就是「加载失败」**，而巡检本身完全正常。
 * 已在东京的验证账号上实测复现（GSI1 accounts 记录数 = 0）。
 *
 * 兜底到部署账号而不是报错，是因为前端那个 option 已经声明了这个语义；
 * 报错的一侧才是与约定分叉的那一侧。
 *
 * 无越权风险：部署账号就是这套系统自己所在的账号，看它的巡检结果不跨界。
 * 取不到时（STS 异常）返回空 → 调用方照原样报 `account_required`，
 * 即退化成修复前的行为，不会静默查错账号。
 */
async function resolveAccount(accountId) {
  const acct = String(accountId || "").trim();
  if (acct) return acct;
  try {
    const { selfAccountId } = await import("./accounts.mjs");
    return String((await selfAccountId()) || "").trim();
  } catch {
    return "";                      // STS/import 异常 → 交回调用方报错
  }
}

/**
 * 手动触发时 `account` 的「全部账号」哨兵。
 *
 * ⚠️ 用 `*` 而不是空串 —— 空串在这个模块里**已经有含义**了（`resolveAccount`
 * 把它解析成部署账号，见上面）。复用空串会让「跑部署账号」变成「跑全部账号」，
 * 而那是一个花钱乘 N 且撤不回来的操作。
 *
 * ⚠️ 也不用 `all`：`*` 与 `regions` 那边表示「全部 region」的哨兵同形，
 * 这个仓库里已经是既有约定（`ALL_REGIONS`）。
 */
export const ALL_ACCOUNTS = "*";

/**
 * 展开「全部账号」→ 部署账号 + 全部已启用的成员账号。
 *
 * 🔴 判据用 `listAccounts()`（`GSI1PK = "accounts"` 且 `enabled === true`）
 *    —— 与页面上账号选择器**同一个来源**。用别的来源（比如 `da#accounts`）
 *    的表现是「弹层写着 5 个账号，实际跑了 7 个」，多出来的那两个客户在
 *    界面上完全看不到，而钱是真花的。
 *
 * ⚠️ `listAccounts()` 刻意**排除了部署账号**（选择器有内置的「部署账号」项），
 *    所以这里要手动把它加回来 —— 漏掉的表现是「全部账号」独独不跑系统账号本身，
 *    而那通常是资源最多的那个。
 *
 * ⚠️ 拿不到部署账号 ID（STS 异常）时**不**塞空串进去：scheduler 那侧会拿它当
 *    account_id 建 run 行，落成一条 account 为空的记录，看板上归到哪个账号都不对。
 *
 * ⚠️ 去重后再返回。部署账号被登记进成员表的情况存在（历史数据），
 *    重复的 account_id 会让 scheduler 对同一账号扇出两次。
 */
export async function allTriggerTargets() {
  const { selfAccountId, listAccounts } = await import("./accounts.mjs");
  const out = [];
  try {
    const self = String((await selfAccountId()) || "").trim();
    if (self) out.push(self);
  } catch { /* 取不到就只跑成员账号 */ }
  try {
    for (const a of (await listAccounts()) || []) {
      const id = String(a?.accountId || "").trim();
      if (id) out.push(id);
    }
  } catch { /* 表不可用 → 只跑部署账号 */ }
  return [...new Set(out)];
}

/**
 * 看板页 → 该页收哪些 **`finding_id` 的 `<rule>` 段**。
 *
 * ⚠️ 分页维度是 **`kind` 而不是 `run_type`**。结构性与闲置**同属闲置轮**
 * （`run_type=idle` 同时产 `idle` / `structural` / 容量），用 run_type 分不开。
 *
 * ⚠️ 这个维度同时是**权限维度**：capabilities.json 里三个子页各自用
 * `queryMatch: {kind: ...}` 精确分权。所以这里的键必须与那边逐字一致 ——
 * 改了一处不改另一处的表现是那一页对所有人 403 `unknown_route`。
 * `tests/inspection.test.mjs` 有断言把两边钉在一起。
 *
 * ## 🔴 这里有**两套词汇表**，别混
 *
 * ```
 * payload.hit_reason[]     threshold_high / chronic_high / idle / structural
 *   给 DA 看的判读分类       payload.py::VALID_HIT_REASONS，只有这四个值
 *   进 S3 载荷，不进 DDB
 *
 * finding_id 第 5 段        threshold_high / idle / <StructuralRule.value>
 *   业务键的一部分            / <CapacityRule.value>
 *   R6.1，进 SK 与 `rule` 属性
 * ```
 *
 * 本表匹配的是**后者**（SK 上真实存在的那套）。第一版按前者写成
 * `structural: ["structural"]` —— 而 `dto.py::Finding.finding_id` 第 5 段
 * 是 `self.rule.value`（`gp2_volume` / `engine_eol` / …），
 * `"gp2_volume" !== "structural"` 于是 `:filter` 全部过滤掉：
 *
 *     结构性风险页恒 0 条，容量 finding（oversized_*）三页都看不到，
 *     而总览不带 kind 不过滤 → 「总览说 12 条，三页加起来 4 条」。
 *
 * 11 类规则里 9 类的 finding 在界面上到不了，且零错误信号。
 *
 * ⚠️ 容量（`oversized_*`）归**闲置页**，不归结构性页 —— `dto.py::CapacityRule`
 * 的注释写明它「输出归②闲置与优化」（它读指标，结构性不读）。
 *
 * ⚠️ `chronic_high` 不在表里，因为它**不会出现在 `finding_id` 里**：
 * `assemble.py` 把第 5 段硬编码成 `threshold_high`，慢性高位只体现在
 * payload 的 `hit_reason[]` 里。写进来是一条永不命中的死值。
 */
const KIND_RULES = Object.freeze({
  "high_load": ["threshold_high"],
  "idle": ["idle", "oversized_storage", "oversized_memory"],
  "structural": [
    "gp2_volume", "burstable_in_prod", "single_az_in_prod", "backup_disabled",
    "no_read_replica", "ca_cert_expiring", "engine_eol",
    // ⚠️ 这一条不是「资源配置有问题」，而是「我们对这台资源判不了某类风险」
    //    —— 拿不到实例规格（总内存 / 分配存储），于是按规格百分比的判定
    //    对它无效。归结构性页因为它同样是**属性层面**的缺失（零指标），
    //    动作是补 `ec2:DescribeInstanceTypes` 权限。
    //    由**阈值判定**产出（`assemble._no_capacity_metadata_finding`），
    //    不是 `scan_structural` —— 只有那里才知道分母缺了。
    "no_capacity_metadata",
    // ⚠️ 同上，也是**阈值判定**产出的盲区通知而非 `scan_structural`：
    //    `assemble._unsupported_engine_finding` —— DocumentDB / Neptune 会被
    //    `describe-db-instances` 返回（共用 RDS 控制平面）却在别的 CloudWatch
    //    namespace 发指标，于是它们此前一条 finding 都不产、在看板上完全消失。
    //    漏在这里的表现是那条 finding 落到 unclassified，哪一页都进不去 ——
    //    盲区通知自己变成了盲区。
    "unsupported_engine",
  ],
});

export const FINDING_KINDS = Object.freeze(Object.keys(KIND_RULES));

/**
 * 这些看板页上的 finding **结构上永远不会有 DA 判读**，所以「没有判读」
 * 在它们身上不是缺陷。
 *
 * 判据不是印象分类，而是「这一页的规则里有没有能走到 DA 的」——
 * 而全系统只有 `threshold_high` 能走到（其余两轮/两条盲区通知都带确定性结论）：
 *
 * ```
 * high_load    threshold_high                  → 走 DA           ← 缺判读是真缺陷
 * idle         idle / oversized_*              → 闲置轮，DETERMINISTIC
 * structural   7 条纯属性（闲置轮，DETERMINISTIC）
 *              + no_capacity_metadata / unsupported_engine（高负载轮，PLAYBOOK 预置结论）
 * ```
 *
 * 🔴 **`structural` 此前漏在这个判据外**（只判了 `idle`），后果与
 *    2026-08-31 闲置轮那 16 条完全同型：升级**之前**写下的 structural 行
 *    在 DDB 里既没有 `conclusion` 也没有 `skip_reason`（这两个字段是那天才
 *    开始写的），于是每条 gp2_volume / engine_eol 上挂一个琥珀色「判读缺失」，
 *    顶部还写「另有 N 项未做根因分析」。而配置检查页的全部条目都是这一类
 *    —— 也就是整页假告警。
 *
 * ⚠️ `kind` 是行上本来就有的（由 `<rule>` 段算），所以这条兜底**立刻生效**，
 *    不用等下一轮 official 跑完。`conclusion` / `skip_reason` 那两条判据
 *    只能修新写入的行。
 *
 * ⚠️ 与 `FindingCard.tsx` 的同名常量是同一份清单，一致性由
 *    `tests/test_inspection_gating.py` 的元断言锁住（它从
 *    `assemble.rules_for_run_type` + `KIND_RULES` 推导，不手写期望值）。
 */
const DETERMINISTIC_KINDS = Object.freeze(new Set(["idle", "structural"]));

/**
 * `<rule>` 段 → 看板页。**由 `KIND_RULES` 生成，不手写第二份** ——
 * 手写的表现是两表分叉后某一类 finding 列表里有、详情却 403。
 */
const RULE_KIND = Object.freeze(Object.fromEntries(
  Object.entries(KIND_RULES).flatMap(
    ([kind, rules]) => rules.map((r) => [r, kind]))));

export const KNOWN_RULES = Object.freeze(Object.keys(RULE_KIND));

/**
 * 一条 finding 属于哪个看板页。认不出来的 `<rule>` 段返回 `""`。
 *
 * 🔴 详情端点靠它按 kind 复核授权（`index.mjs`）：`/inspection/finding`
 * 只挂在 tab 级 route 上，光有 `nav:inspection:idle` 的人拿一个高负载
 * finding 的 id 就能读到它的判读全文。
 *
 * ⚠️ 返回 `""` 时调用方 SHALL 拒绝而不是放行 —— 认不出的规则码意味着
 * 判定侧加了新规则而这张表没跟上，此时放行等于对新规则完全无授权。
 */
export function kindOfFinding(row) {
  const rule = String(
    row?.rule || String(row?.finding_id || row?.SK || "").split("#")[4] || "");
  return RULE_KIND[rule] || "";
}

/**
 * `begins_with(SK, prefix)` 分页查询。
 *
 * ⚠️ 必须分页。DDB 单页上限 1MB，而一个账号的 finding 行数
 * 与实例数同阶（1000 实例可能有数千条）。不分页的表现是列表**静默截断**
 * —— 看板显示 87 条而实际有 300 条，且没有任何提示。
 */
async function queryAll(params, { limit = 5000, onTruncate = null } = {}) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey }));
    for (const it of r.Items || []) out.push(it);
    ExclusiveStartKey = r.LastEvaluatedKey;
    if (out.length >= limit) {
      // 🔴 截断必须**能被报出去**。这个 break 原来是静默的，返回值与
      //    「真的只有这么多」完全一致 —— 于是看板显示 5000 条并按严重度分档，
      //    而 `by_severity` / `without_judgment` / `parse_quality` /
      //    `unclassified` 全部基于截断后的集合，那几个自检指标一起失真。
      //
      // ⚠️ 这个函数自己的注释批评不分页版本的问题就是「静默截断」——
      //    分页版本换了个数字重现了同一件事。
      if (onTruncate) onTruncate(out.length);
      break;
    }
  } while (ExclusiveStartKey);
  return out;
}

/** DDB 的数字回来可能是 Decimal-ish 对象；统一成 JS number 或 null。 */
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sevRank(s) {
  const i = SEVERITIES.indexOf(String(s || "").toUpperCase());
  return i < 0 ? SEVERITIES.length : i;
}

/** UTC 今天往前 n 天的 ISO 日期串。 */
function isoDaysAgo(n, today = new Date()) {
  const d = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - n));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// finding
// ---------------------------------------------------------------------------

/**
 * 一条 finding 行 → 前端要的形状。
 *
 * ⚠️ `days_active` **由 first_seen_date 与 today 相减算出，不读存储字段** ——
 * Python 侧 `FindingRecord` 刻意没有这个字段（R6.5）：存一个可增量写的计数
 * 在 SQS at-least-once 下必然被放大。这里照同样的口径算。
 */
function shapeFinding(item, todayIso) {
  const firstSeen = String(item.first_seen_date || "");
  let daysActive = null;
  if (firstSeen) {
    const a = Date.parse(firstSeen + "T00:00:00Z");
    const b = Date.parse(todayIso + "T00:00:00Z");
    if (Number.isFinite(a) && Number.isFinite(b)) {
      daysActive = Math.floor((b - a) / 86400000) + 1;   // 首见当天算 1 天
    }
  }
  const fid = String(item.SK || item.finding_id || "");
  // finding_id 形状：account#region#service#instance#rule#metric（6 段，R6.1）
  const seg = fid.split("#");
  // ⚠️ 字段名是 `rule` 而**不是** `hit_reason`。后者在这套系统里专指
  //    payload 给 DA 的那四个判读分类（见 KIND_RULES 的注释），
  //    两套词汇表叫一个名字正是结构性页恒 0 条那个 bug 的来源。
  //    `item.rule` 是写侧真实落的属性（`store.py::_finding_to_item`），
  //    SK 拆段只作兜底。
  const rule = String(item.rule || seg[4] || "");
  return {
    finding_id: fid,
    account_id: seg[0] || String(item.account_id || ""),
    region: seg[1] || "",
    service: seg[2] || "",
    instance: seg[3] || "",
    rule,
    // 该条属于哪个看板页。前端的 chip 分类靠它，**不要在前端再写一份映射**。
    kind: kindOfFinding({ rule }),
    metric: seg[5] === "-" ? "" : (seg[5] || ""),
    state: String(item.state || ""),
    severity: String(item.severity || "INFO").toUpperCase(),
    first_seen_date: firstSeen,
    last_run_date: String(item.last_run_date || ""),
    days_active: daysActive,
    rule_version: String(item.rule_version || ""),
    consecutive_hits: num(item.consecutive_hits),
    consecutive_misses: num(item.consecutive_misses),
    was_confirmed: Boolean(item.was_confirmed),
    // ── 判定证据（`assemble.to_evidence` → `store._finding_to_item`）──
    //
    // ⚠️ 全部可能是 `null`：结构性风险是属性判定，没有 value/threshold；
    //    存量行（本次改动之前写的）也没有。UI SHALL 容忍 —— 那一行不渲染，
    //    **不显示 0**。「没有这个数」与「这个数是 0」是两件事。
    observed_value: num(item.value),
    threshold_value: num(item.threshold),
    headroom: num(item.headroom),
    /**
     * 指标的物理单位（`%` / `B` / `s` / 空）。
     *
     * 🔴 由后端给，前端 SHALL NOT 按指标名猜。链路是两张现成的表接起来：
     * `thresholds._THRESHOLD_BY_METRIC_FIELD` → `rule_limits.find()["unit"]`。
     * 猜的表现是**单位标错**（把 `0.05` 秒显示成「0.05%」），比不显示更糟。
     */
    unit: String(item.unit || ""),
    /**
     * 按规格百分比判定时的原始观测值与分母（字节）。
     *
     * ⚠️ 内存与存储阈值是**占规格的百分比**（R2.1.2），所以
     * `observed_value` 是百分数。人读的是「可用 200 MB / 共 8 GB」——
     * 这两个字段就是为那句话准备的。非百分比类指标上它们是 null。
     */
    raw_value: num(item.raw_value),
    denominator: num(item.denominator),
    /**
     * `bad_up`（越大越坏）/ `bad_down`（越小越坏）。决定卡片上写
     * 「高于阈值」还是「低于阈值」。
     *
     * 🔴 前端 SHALL NOT 按指标名猜方向 —— FreeableMemory / FreeStorageSpace
     * 是「越小越坏」，猜错的表现是「高于阈值 500MB」，正好反了。
     * 唯一真源是 `metrics_meta`，经 payload 的 `threshold_config.direction`
     * 落到这里。
     */
    direction: String(item.direction || ""),
    /** 每月可省（USD）。⚠️ 只有闲置类才有 —— 高负载挂金额会诱导「关掉能省钱」。 */
    savings_usd: num(item.savings_usd),
    /**
     * 金额精度档（`exact` / `coarse_*`）。
     * ⚠️ 必须与金额**一起**显示。只给数字不给档位，客户会拿兜底常数做预算。
     */
    savings_precision: String(item.savings_precision || ""),
    /**
     * 闲置评分因子（`assemble._idle_evidence`）。**闲置条目「凭什么」的全部依据。**
     *
     * 高负载有「实测值 vs 阈值」一行就够；闲置没有单一阈值 —— 它是四个
     * （RDS：CPU/连接数/存储/IOPS）或三个（ElastiCache：CPU/内存/请求数）
     * 维度加权出来的分。不透出的表现是看板上闲置条目只有一个 INFO 徽标和
     * 一个金额，客户合理地问「凭什么说它闲」。
     *
     * ⚠️ 列表里**带上**（与 `da_body` 相反）：四个维度的 map 每条约 200B，
     * 300 条 60KB，可接受；而它是排序与解释的依据，放到详情里取就意味着
     * 列表上无法显示「主要因为 CPU 均值 2.1%」这句话。
     *
     * 🔴 `idle_score` 可能缺失（非闲置类、或判据不足未判定）。缺就是缺，
     * **不补 0** —— 0 分在排序里等于「完全不闲」，而「没算出来」和
     * 「一点都不闲」方向正好相反。
     */
    /**
     * 规格（`db.t4g.micro` / `cache.r7g.large` / `db.serverless`）。
     *
     * 🔴 闲置条目的处置价值几乎全在这个字段上：`db.t4g.micro` 闲置省几美元、
     * `db.r8g.4xlarge` 闲置省几百。客户原话是「客户想要的是 xxx 实例，什么
     * 规格，什么 region 的，评分是多少分」—— 规格是这四个里唯一缺的。
     *
     * ⚠️ 老 finding 行没有这个字段（2026-08-26 才落库），所以是 `""` 而不是
     * 抛错。UI 侧空串就不渲染那一格。
     */
    instance_class: String(item.instance_class || ""),
    idle_score: num(item.idle_score),
    idle_weight_avail: num(item.idle_weight_avail),
    idle_degraded: Array.isArray(item.idle_degraded)
      ? item.idle_degraded.map((d) => String(d)) : [],
    idle_factors: Array.isArray(item.idle_factors)
      ? item.idle_factors.map((f) => ({
        name: String(f?.n || ""),
        weight: num(f?.w),
        normalized: num(f?.v),
        points: num(f?.p),
        basis: String(f?.b || ""),
        observed: num(f?.m),
      })) : [],
    /**
     * 判定证据的**数据日期**。
     *
     * 🔴 `chronic` / `resolving` 的 finding 保留的是**上一次命中时**的证据
     * （`store.apply_transitions` 只在 resolved 时清）。没有这个字段，
     * 前端就只能把 9 天前的「可用内存 1.1%」当成今天的水位显示 ——
     * 「问题还在」和「现在就是这个数」是两件事。
     *
     * ⚠️ 与 `last_run_date` 相等时说明证据就是本轮的，UI **不该**标注
     * 「数据截至…」—— 每条都挂一个「截至今天」是纯噪音。
     */
    evidence_as_of: String(item.evidence_as_of || ""),
    // DA 判读（callback 回拼上来的）
    da_verdict: String(item.da_verdict || ""),
    da_parse_status: String(item.da_parse_status || ""),
    // 🔴 确定性结论与跳过原因（2026-08-31）。闲置轮**不派 DA**
    //    （`gating.DETERMINISTIC_RUN_TYPES`），但它有结论 —— 纯计算算出来的。
    //    不带出来的表现（实机 16 条全中）：卡片显示「判读缺失」、
    //    详情里红色「读取失败: not_found」，而功能完全正常。
    // ⚠️ `skip_reason` 要单独带：读侧靠它区分「不需要判读」（deterministic /
    //    playbook / reused / rollup_member）与「本该判读但没判」（budget / quota）。
    //    后者才该显示「缺」。
    conclusion: String(item.conclusion || ""),
    skip_reason: String(item.skip_reason || ""),
    da_task_id: String(item.da_task_id || ""),
    da_report_md_key: String(item.da_report_md_key || ""),
    // ⚠️ 列表里**不带** da_body：判读全文每条 1~3KB，300 条就是 1MB 响应。
    //    详情页用 /inspection/finding 单独取。
    has_judgment: Boolean(item.da_body),
    /**
     * 7.9a skill 门禁的结论（D22，2026-09-03）。**「这条判读的方法论生效了吗」。**
     *
     * 🔴 这三个字段在 2026-09-03 之前只进 CloudWatch Logs —— `journal_gate`
     * 那个模块把「skill 有没有加载 / DA 有没有拿到账号数据」算成了可读的事实，
     * 然后没人取。于是看板上一条 **skill 压根没加载**的判读（结论等于通用 LLM
     * 发挥）与一条正常判读**长得一模一样**。
     *
     * 🔴 **`null` 与 `false` 必须分开。**
     *
     * ```
     * null    门禁没跑过 —— 存量行（本次改动之前写的）、老派发行没 run_type、
     *         或门禁自己抛了。语义是「不知道」。
     * false   门禁跑了，判定**不可信**（skill_not_loaded / wrong_skill /
     *         no_journal / no_data_access 四档之一）。
     * true    门禁跑了且方法论生效。
     * ```
     *
     * 写成 `Boolean(item.da_gate_trustworthy)` 就把 `null` 折成了 `false` ——
     * 存量行会**全部**显示成「判读不可信」，而那是噪音不是信号
     * （Python 侧 `ApplyOutcome.journal_trustworthy` 默认 `True` 的注释里
     *  写的就是这件事：默认 False 会让所有存量路径一夜之间全变不可信）。
     * 所以这里用 `=== undefined ? null : Boolean(...)`。
     */
    da_gate_trustworthy: item.da_gate_trustworthy === undefined
      || item.da_gate_trustworthy === null
      ? null : Boolean(item.da_gate_trustworthy),
    /**
     * 命中了哪几档降级（`journal_gate.Degradation` 的字符串值）。
     *
     * ⚠️ **空数组与缺失是两件事**，与上面同理：
     * `[]` = 门禁跑过、一条降级都没有（干净的**正面证据**）；
     * `null` = 门禁没跑过。所以这里不写 `|| []` 兜底。
     */
    da_degradations: Array.isArray(item.da_degradations)
      ? item.da_degradations.map((d) => String(d)) : null,
    /**
     * 这次调查实际加载的 skill 名。排查 `wrong_skill` / `extra_skill` 时
     * 「到底加载了什么」是唯一能直接看的线索。
     *
     * ⚠️ 同上：`[]` 与 `null` 不可合并 —— 前者是「一个都没加载」
     * （那正是 `skill_not_loaded` 的形态），后者是「没验过」。
     */
    da_skills_loaded: Array.isArray(item.da_skills_loaded)
      ? item.da_skills_loaded.map((s) => String(s)) : null,
  };
}

/**
 * finding 列表。
 *
 * ⚠️ 派发映射行（`inspdispatch#`）**不会**混进来 —— 它是平级前缀。
 * 这不是自然而然的：写成 `inspfind#dispatch#` 就会被这个 Query 一起捞出来，
 * 于是列表里出现几条没有 severity、没有 state 的「幽灵 finding」。
 * `inspection_keys.mjs` 有断言守住。
 */
export async function getFindings(accountId, {
  kind = "", severityMin = "", allAccounts = false, visible = null,
} = {}) {
  // 🔴 `allAccounts` = **统一视图**：一次拿全部账号的 finding。
  //
  //    看板要回答「今天我要处置什么」，那是跨账号的问题。而 `accountId`
  //    此前是**必填**，于是页面顶部那个账号选择器从「筛选」退化成
  //    「决定加载哪个分区」—— 客户一次只能看一个账号。
  //
  // ⚠️ `visible` **必须由路由层传进来**：`null` 表示「调用方没给可见集合」，
  //    那时**拒绝**跨账号查询。统一视图会把所有账号的 finding 摊开，
  //    而账号可见性是配置项（管理 → 账号数据可见性）——
  //    忘了过滤等于让只被允许看账号 A 的人看到 B 的全部风险明细
  //    （实例名、金额、判读结论）。
  //
  //    做成「不给就拒」而不是「不给就放行」：后者在忘记接线时**静默越权**，
  //    而这一轮审计里最贵的几条缺陷全是那个形态。
  if (allAccounts) {
    if (visible === null || visible === undefined) {
      return fail("visibility_required",
        "跨账号查询必须由路由层提供可见账号集合（这是防越权的硬门）");
    }
  }
  const acct = allAccounts ? null : await resolveAccount(accountId);
  if (!allAccounts && !acct) return fail("account_required", "缺少 account 参数");
  // ⚠️ `kind` **必填**，这是纵深防御。门禁那一层已经拦住了不带 kind 的请求
  //    （tab 的 routes 里没有 `/inspection/findings$`，所以空 kind 无节点 → 403）。
  //    但那道防线只有一层：一旦有人把该 pattern 加回 tab（看起来是"顺手补全"），
  //    空 kind 就会命中 tab 级门禁，于是只有闲置权限的人拿到**全部** finding。
  //    数据层再拒一次，让那种改动至少变成一个可见的 400 而不是静默越权。
  //
  // 🔴 这道校验**只属于对外端点**。总览要的恰恰是跨 kind 的全量，走
  //    `queryFindings` 绕开它 —— 此前总览直接调本函数且不传 kind，
  //    于是「巡检总览」100% 返回 `bad_kind`（东京实测）。
  if (!(kind in KIND_RULES)) {
    return fail("bad_kind",
      `kind 必填且只能是 ${Object.keys(KIND_RULES).join(" / ")}`);
  }
  return queryFindings(acct, { kind, severityMin, visible });
}

/**
 * finding 取数与整形。**内部函数，不做 kind 校验。**
 *
 * `kind` 为空 = 跨 kind 全量，这是「巡检总览」需要的形状
 * （`by_severity` / `without_judgment` / 状态分布都要覆盖三页之和）。
 *
 * ⚠️ 不要把它导出。对外的 `getFindings` 之所以强制 kind，是因为三个子页
 * 各自分权（`nav:inspection:high-load` / `:idle` / `:structural`）——
 * 导出一个不校验的版本等于给越权留了门。
 */
async function queryFindings(acct, { kind = "", severityMin = "", visible = null } = {}) {
  let items;
  /** 被 5000 上限截断时的条数；0 = 没截断。见下面 onTruncate。 */
  let truncatedAt = 0;
  try {
    // 🔴 `acct` 为 null = **跨账号统一视图**，走 GSI1。
    //
    //    主键是 `inspfind#<账号>`（每账号一个分区），所以按主键查必须先选账号
    //    —— 那让页面顶部的账号选择器从「筛选」退化成「决定加载哪个分区」，
    //    而看板的语义是「今天我要处置什么」，跨账号一起排才对。
    //
    // ⚠️ GSI1SK 的形状是 `<严重度序>#<账号>#<finding_id>`，升序 = 最严重在前。
    //    这一点在**截断**时才体现价值（`queryAll` 有 5000 上限）：
    //    按严重度升序取，被切掉的是 INFO 那一头。
    items = await queryAll(acct ? {
      TableName: TABLE,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "PK" },
      ExpressionAttributeValues: { ":pk": findingPk(acct) },
    } : {
      TableName: TABLE,
      IndexName: FINDING_GSI1_INDEX,
      KeyConditionExpression: "#gpk = :gpk",
      ExpressionAttributeNames: { "#gpk": "GSI1PK" },
      ExpressionAttributeValues: { ":gpk": FINDING_GSI1PK },
    // 🔴 截断要能被报出去。`queryAll` 的 5000 上限原来是静默 break，
    //    返回值与「真的只有这么多」完全一致 —— 于是看板显示 5000 条并按
    //    严重度分档，而 `by_severity` / `without_judgment` / `parse_quality` /
    //    `unclassified` 全部基于截断后的集合，那几个自检指标一起失真。
    //    （`queryAll` 自己的注释批评不分页版本的问题就是「静默截断」。）
    }, { onTruncate: (n) => { truncatedAt = n; } });
  } catch (e) {
    return fail("ddb_error", String(e));
  }
  // 🔴 **跨账号查询之后按可见账号过滤。**
  //
  //    GSI1 一次拿到所有账号的 finding，而账号可见性是配置项
  //    （管理 → 账号数据可见性）。不过滤等于让只被允许看账号 A 的人看到
  //    B 的全部风险明细：实例名、预计月省金额、AI 判读结论。
  //
  // ⚠️ 在**数据层**过滤而不是指望路由层 —— 路由层的门禁只认
  //    `q.account` / `body.account_id` / `body.key` 那几个键，而统一视图
  //    压根不传账号，那道门自然放行（这个形态今天刚在 renewExclusion 上踩过）。
  //
  // ⚠️ `visible === "*"` 是 admin/带 `*` 权限，不过滤。
  if (!acct && visible && visible !== "*") {
    const before = items.length;
    items = items.filter((it) => visible.has(String(it.account_id || "")));
    if (before !== items.length) {
      console.log(`[inspection] 按可见账号过滤：${before} → ${items.length}`);
    }
  }

  const todayIso = isoDaysAgo(0);
  let rows = items.map((it) => shapeFinding(it, todayIso));

  // 🔴 认不出 `<rule>` 段的行 —— 判定侧加了新规则而 `KIND_RULES` 没跟上。
  //    这种行**进不了任何 kind 页**（没法判它该归谁分权），所以必须把数字
  //    露出来：不露的表现是「总览说 12 条，三页加起来 10 条」而无从解释。
  //    元断言（tests/inspection.test.mjs）让这个数正常情况下恒为 0。
  const unclassified = rows.filter((r) => !r.kind).length;

  if (kind) {
    rows = rows.filter((r) => r.kind === kind);
  }
  if (severityMin) {
    const cap = sevRank(severityMin);
    rows = rows.filter((r) => sevRank(r.severity) <= cap);
  }

  // 排序：严重度降 → 已持续天数降 → finding_id（稳定）
  // ⚠️ 第三键必须有：只按前两键排时同severity同天数的条目每次请求顺序不同，
  //    表现是「刷新一下列表就跳」。
  rows.sort((a, b) => sevRank(a.severity) - sevRank(b.severity)
    || (b.days_active ?? 0) - (a.days_active ?? 0)
    || a.finding_id.localeCompare(b.finding_id));

  const bySeverity = {};
  for (const s of SEVERITIES) bySeverity[s] = 0;
  for (const r of rows) if (r.severity in bySeverity) bySeverity[r.severity] += 1;

  /**
   * 这些 `skip_reason` 表示「**不需要** AI 判读」，不该算进「未做根因分析」。
   *
   * ```
   * deterministic   闲置轮等纯计算的判定（gating.DETERMINISTIC_RUN_TYPES）
   * playbook        命中已知模式，有确定性结论
   * reused          沿用最近一次的结论（形态没变）
   * rollup_member   同集群同指标已有集群级结论覆盖
   * ```
   *
   * 🔴 真的缺是另外三档：`budget` / `quota` / `kill_switch` ——
   *    后端 `gating.decide()` 那三支都**不带** conclusion。
   *
   * ⚠️ 与 `frontend/.../FindingCard.tsx` 的 `NEEDS_NO_AI` 是同一份清单。
   *    两处一致性由 `tests/test_inspection_gating.py` 的元断言锁住 ——
   *    这里也在那条断言的覆盖里，加新档位漏了会红。
   */
  const NEEDS_NO_AI = new Set([
    "deterministic", "playbook", "reused", "rollup_member",
  ]);

  // R10.6：明示「另有 N 项未做根因分析」—— 不显示会让客户以为看板就是全部。
  //
  // 🔴 判据不能只看 `has_judgment`（2026-08-31 实机暴露）。闲置轮设计上**不派 DA**
  //    （`gating.DETERMINISTIC_RUN_TYPES = {"idle"}`），16 条闲置 finding 全部
  //    `has_judgment=false` → 顶部显示「另有 16 项未做根因分析」。
  //    客户读到的是「有 16 条我们没分析」，而真相是「这 16 条不需要 AI 分析、
  //    结论已经在卡片上了」。
  //
  // ⚠️ 有 conclusion 或 skip_reason ∈ NEEDS_NO_AI 的都不算 —— 前者是新数据，
  //    后者兼容**存量行**（本次改动之前写下的：skip_reason 有、conclusion 空）。
  //
  // 🔴 第三条 `DETERMINISTIC_KINDS`（idle + structural）是**兜底**，
  //    缺它的表现（实机确认）：
  //
  //    ```
  //    升级**之前**写下的行 → DDB 里既没有 conclusion 也没有 skip_reason
  //      → 前两条判据都不成立
  //      → 照样计入「另有 16 项未做根因分析」
  //    ```
  //
  //    也就是说光靠那两个字段只能修新写入的行。任何客户升级后打开看板，
  //    顶部仍然写着「另有 N 项未做根因分析」，要等下一轮 official 跑完才好。
  //    而 `rule` 段（`kindOfFinding` 的输入）是行上本来就有的，立刻生效。
  const missingJudgment = rows.filter(
    (r) => !r.has_judgment
      && !r.conclusion
      && !NEEDS_NO_AI.has(r.skip_reason || "")
      && !DETERMINISTIC_KINDS.has(kindOfFinding(r)));
  const withoutJudgment = missingJudgment.length;

  /**
   * 那 N 条**各自因为什么**没有判读。
   *
   * 🔴 只给一个总数的表现是「另有 N 项未做根因分析」这一句话吞掉三种完全
   * 不同的处境，而它们的下一步互不相同：
   *
   * ```
   * budget       本轮额度档位不放行这个 severity  → 去调额度档位
   * quota        本轮派发条数配额用满            → 等下一轮，或调配额
   * kill_switch  da_enabled 被人拉停             → 去打开开关
   * ""（空）      派了没回来 / 存量行             → 去看派发缺口
   * ```
   *
   * `gating.SkipReason` 的 docstring 就写着「缺任何一种都会退化成『这条没有
   * AI 分析』这句无信息的话，而客户接着就会问『是坏了还是省钱』—— 那是两个
   * 完全不同的答案」。后端分了六档，读侧压成一个数字等于把那段努力扔掉。
   *
   * ⚠️ 分母是**这些 finding 自己**，不是 run 记录里的 `skipped_by_gate`。
   *    两者的计数对象与时间窗都不同（前者是当前未闭合的 finding，后者是
   *    最近若干轮的派发决策）。混在一句话里会造出一个新的谎。
   *
   * ⚠️ `NEEDS_NO_AI` 那几档**不会**出现在这里 —— 上面的过滤已经把它们排除了
   *    （它们本来就不需要判读，不算「缺」）。
   */
  const withoutJudgmentByReason = {};
  for (const r of missingJudgment) {
    const k = String(r.skip_reason || "") || "unknown";
    withoutJudgmentByReason[k] = (withoutJudgmentByReason[k] || 0) + 1;
  }

  /**
   * DA 判读的**解析质量**分档（`inspection/domain/report_parse.py` 的四档）。
   *
   * 🔴 为什么必须聚合出来：`da_parse_status` 此前只在**单条详情**里显示一个
   * 英文枚举。也就是说 skill 一旦漂移（DA 改了措辞、输出被截断、加载不到
   * skill），100 条里 60 条 `parse_failed`，得**逐条点开**才会发现。
   *
   * 那条链路本身是脆的（LLM 自然语言输出 → 按 `## <finding_id>` 精确匹配
   * 切段），设计上已经做了三道防线（信封硬约束 / 严格正则 / 绝不按位置回退），
   * 但没有任何**度量**。这个字段就是那个度量。
   *
   * ```
   * ok             全部预期的 finding 都对上号了
   * partial        对上一部分 —— 缺的那些判读是缺失的，不是「没问题」
   * parse_failed   有东西但一节都对不上 → 去查 skill
   * empty          DA 什么都没回        → 去查 DA 那侧
   * ```
   *
   * ⚠️ 只统计**派发过**的（有 `da_task_id`）。没派发的条目压根没有解析这件事
   * （闲置轮走 `SkipReason.DETERMINISTIC`），把它们算进分母会让成功率恒低，
   * 于是这个指标永远是红的、也就永远没人看。
   */
  const parseQuality = { ok: 0, partial: 0, parse_failed: 0, empty: 0, other: 0 };
  let dispatched = 0;
  for (const r of rows) {
    if (!r.da_task_id) continue;
    dispatched += 1;
    const s = String(r.da_parse_status || "");
    if (s in parseQuality) parseQuality[s] += 1;
    // 空 status + 有 task_id = 判读还在路上（异步 1~3 分钟）。
    // ⚠️ 不算进 `other`：那一档的语义是「出现了我们不认识的状态值」，
    //    而「还没回来」是正常的中间态。混起来会让刚触发的那一轮显示成异常。
    else if (s) parseQuality.other += 1;
  }

  /**
   * 7.9a skill 门禁的**聚合**（D22 第二步）。「回来的判读里有几条没按
   * 我们的方法论产出」。
   *
   * 🔴 与 `parse_quality` 是正交的两问：那边问「判读切没切出来」，这边问
   * 「切出来的这份可不可信」。一条 `ok` 的判读完全可以是 skill 没加载 ——
   * 单条卡片上有徽标了（第一步），但 100 条里 60 条不可信仍然要逐条看
   * 才能发现，与 `parse_quality` 当年的问题同型。
   *
   * ```
   * untrusted   门禁判不可信（skill 没加载 / 加载错 / 读不到 journal /
   *             账号没关联）—— 结论等于通用 LLM 发挥
   * degraded    可信但有折扣（压缩 / 部分证据缺失 / 混了别的 skill / 解析失败）
   * clean       门禁跑过、零降级 —— **已验证**的干净（正面证据）
   * unknown     有判读但没有门禁结论 —— 存量行 / 老派发行没 run_type /
   *             门禁自己抛了。语义是「不知道」，**不是**「有问题」
   * ```
   *
   * ⚠️ 分母是 `da_parse_status` 非空的条数（判读**已回来**的），不是
   *    `dispatched`：门禁结论与判读同一次 UpdateItem 落库，「派了还没回来」
   *    的行两者都没有 —— 把它们算进 `unknown` 会让刚触发的那一轮显示成
   *    「N 条未验证」，而那只是异步 1~3 分钟的正常中间态（与 parse_quality
   *    不把在途算进 `other` 同理）。
   * ⚠️ 判据是 `=== false` / `=== true`，不是 truthy：`shapeFinding` 对缺失
   *    发的是 null，truthy 判断会把存量行全数成 untrusted。
   */
  const gateQuality = { untrusted: 0, degraded: 0, clean: 0, unknown: 0 };
  for (const r of rows) {
    if (!r.da_task_id || !r.da_parse_status) continue;
    if (r.da_gate_trustworthy === false) gateQuality.untrusted += 1;
    else if (r.da_gate_trustworthy === true) {
      if ((r.da_degradations || []).length > 0) gateQuality.degraded += 1;
      else gateQuality.clean += 1;
    } else gateQuality.unknown += 1;
  }

  // 🔴 R9.11：「那天没跑」SHALL 与「那天没有风险」可区分。
  //
  // 列表空的时候前端只有两种可能的说法，而它们的运维含义完全相反：
  //
  // ```
  // 跑过了、没找到风险   → 「本轮未发现风险」   放心
  // 压根没跑             → 「今天还没巡检」     要去查为什么没跑
  // ```
  //
  // 东京实测踩到的就是后者被显示成前者：run 行卡在 running（锁 bug）、
  // 零 finding，界面照样说「本轮未发现风险」——**客户以为系统在正常工作**。
  //
  // 这个字段放在 findings 响应里而不是让前端再请求一次 overview：
  // 两个接口分别取数会出现「列表是空的但状态说跑过了」的时间窗，
  // 而那正是这条要消掉的歧义。
  let lastRun = null;
  // ⚠️ `kind` 为空 = 总览调用。`getOverview` 自己拉 `getRuns(days:14)` 建 diff，
  //    **不读**这个字段 —— 为它发一次 Query 是纯浪费（算好了没人取）。
  if (kind) {
    try {
      const runs = await getRuns(acct, { days: 3 });
      // 该 kind 属于哪一轮：structural 与 idle 同属闲置轮（run_type=idle）。
      // ⚠️ 配置检查页里有两条规则（no_capacity_metadata / unsupported_engine）
      //    其实由**高负载轮**产出。这里仍按 idle 归类是有意的：前端的
      //    `lastRuns` 同时拿 high 与 idle 两条并取「最值得说」的那一条
      //    （`TriageEmpty` 的 `rank`），所以两轮都会被考虑到。
      lastRun = worstRunAcross(runs, {
        runType: kind === "high_load" ? "high" : "idle",
        crossAccount: !acct,
        visible,
      });
    } catch { /* 读不到 run 记录时留 null，前端会说「状态未知」而不是「没风险」 */ }
  }

  return {
    ok: true, account_id: acct, kind: kind || "all",
    total: rows.length, by_severity: bySeverity,
    without_judgment: withoutJudgment,
    /**
     * 那 N 条各自的 `skip_reason` 计数（`unknown` = 行上没有这个字段）。
     * 见上面 `withoutJudgmentByReason` 的说明 —— 一个总数说不出下一步该做什么。
     */
    without_judgment_by_reason: withoutJudgmentByReason,
    /**
     * 🔴 `<rule>` 段没登记在 `KIND_RULES` 里的条数（正常恒 0）。
     * >0 意味着判定侧加了新规则而读侧没跟上 —— 那些 finding 三页都进不去。
     * 前端 SHALL 把它显示出来，藏起来就回到「总数与分页之和不等」的老问题。
     */
    unclassified,
    /**
     * 被 5000 上限截断时的条数；`0` = 没截断。
     *
     * 🔴 前端 SHALL 把它显示出来。截断之后 `total` 不再是真实总数，而
     * `by_severity` / `without_judgment` / `parse_quality` / `unclassified`
     * 全部基于截断后的集合 —— 那几个自检指标一起失真，而界面上与「真的只有
     * 这么多」完全无法区分。
     */
    truncated_at: truncatedAt,
    /**
     * 判读解析质量。见上面 `parseQuality` 的说明。
     * `dispatched` 是分母（派发过判读的条数），四档之和 ≤ 它
     * —— 差额是「还在路上」。
     */
    parse_quality: { ...parseQuality, dispatched },
    /** 门禁聚合（D22）。见上面 `gateQuality` —— 与 `parse_quality` 正交。 */
    gate_quality: gateQuality,
    findings: rows,
    /**
     * 最近一轮的状态。`null` = 读不到（**不等于没跑过**）。
     * 前端据此区分「跑过没风险」/「还没跑」/「跑失败了」/「状态未知」。
     */
    last_run: lastRun,
  };
}

/**
 * 一批 run 记录 → 「最值得说」的那一条（R9.11）。
 *
 * 🔴 **跨账号视图下不能取「最新那条」。** finding 列表默认就是跨账号的
 * （前端 `getInspectionFindings(kind)` 不传账号 → `all=1`），而 run 记录的
 * 主键是 `insprun#<类型>#<日期>`、SK 是账号 —— 一次 Query 拿到的是**所有
 * 账号**那天那一轮的记录。原来的 `runs.filter(...)[0]`（按日期降序的第一条）
 * 于是变成「任意一个账号最新的那次」：
 *
 * ```
 * 账号 A 今天跑完了      → 有 run 行，run_date = today, status = success
 * 账号 B 压根没跑        → 没有 run 行
 * ⇒ lastRun = A 那条 → 前端渲染「本轮未发现风险」
 * ⇒ 而 B 从来没被巡检过，客户以为它没风险
 * ```
 *
 * 这正是 R9.11 要防的那件事（「那天没跑」SHALL 与「那天没有风险」可区分），
 * 在跨账号视图上被绕过了。
 *
 * ⚠️ 排序判据与前端 `TriageEmpty` 的 `rank` **同序**：
 *   未知(null) > failed > 不是今天 > running > success。
 *   两处必须一致，否则 BFF 挑出「最值得说」的那条之后前端又按另一套重排。
 *
 * ⚠️ 「某个可见账号连 run 行都没有」返回的是 `run_date: ""` 而不是 `null`：
 *   前端对空 run_date 渲染「今天还没巡检，最近一轮是（无记录）」——
 *   比 `null` 的「状态未知」更准确（我们知道它没跑，不是读不到）。
 */
export function worstRunAcross(runs, { runType, crossAccount = false, visible = null } = {}) {
  let mine = (runs || []).filter((r) => r.run_type === runType);
  // 🔴 跨账号时按可见账号过滤 —— 与上面 finding 列表的过滤保持一致。
  //    不过滤会让不可见账号的运行状态（跑没跑、完整度）漏给调用者，
  //    而那道过滤在 finding 那一侧是显式做过的。
  if (crossAccount && visible && visible !== "*") {
    mine = mine.filter((r) => visible.has(String(r.account_id || "")));
  }
  if (!mine.length) return null;

  // 每个账号取它自己最新的那条（`getRuns` 已按 run_date 降序）。
  const latestByAcct = new Map();
  for (const r of mine) {
    const a = String(r.account_id || "");
    if (!latestByAcct.has(a)) latestByAcct.set(a, r);
  }

  // 可见账号里有谁**一条都没有** → 那个账号没跑，整个视图不能说「跑过了」。
  if (crossAccount && visible && visible !== "*") {
    for (const a of visible) {
      if (!latestByAcct.has(String(a))) {
        return { run_date: "", status: "", completeness: null, mode: "" };
      }
    }
  }

  const today = isoDaysAgo(0);
  // 🔴 `partial` 必须排在 `success` **之前**。
  //
  //    上一版只识别 failed / 非今天 / running，`partial` 落到最后那一档，
  //    于是前端把它渲染成绿色 ✓「本轮未发现风险」。而 `partial` 的语义是
  //    「有 region 没扫成」（`schedule.py::RunStatus`）—— 失败 region 的实例
  //    **压根没进 `expected`**，所以 `completeness` 可能仍是 1.0 或 null，
  //    连「完整度不足」那句补充语都不会出现。
  //
  //    表现：某个 region 整轮漏扫 → 那个 region 里内存 98% 的库一条 finding
  //    都没出 → 界面给绿色对勾。`api/inspection.ts` 的 `regions` 注释
  //    自己写着「**必须显示出来**」。
  const rank = (r) => {
    if (!r) return 0;
    if (r.status === "failed") return 1;
    if (r.run_date !== today) return 2;
    if (r.status === "running") return 3;
    if (r.status === "partial") return 4;
    return 5;
  };
  const cur = [...latestByAcct.values()].sort((a, b) => rank(a) - rank(b))[0];
  return {
    run_date: cur.run_date, status: cur.status,
    completeness: cur.completeness, mode: cur.mode,
    // 🔴 带上没扫成的 region 名字。`partial` 只说「不完整」，说不出**少了谁**
    //    —— 而失败的 region 在 `by_region` 里连键都没有（不是 0），
    //    所以这是唯一能回答「哪个 region 漏了」的地方。
    //    空数组 = 没有失败的 region（与「读不到」区分：那时 `regions` 为 null）。
    regions_failed: (cur.regions && Array.isArray(cur.regions.failed))
      ? cur.regions.failed.map((x) => String(x)) : [],
  };
}

/** 单条 finding 详情（含判读全文）。 */
export async function getFinding(accountId, findingId) {
  const acct = await resolveAccount(accountId);
  const fid = String(findingId || "").trim();
  if (!acct) return fail("account_required", "缺少 account 参数");
  if (!fid) return fail("finding_required", "缺少 id 参数");
  let item;
  try {
    const r = await ddb.send(new GetCommand({
      TableName: TABLE, Key: { PK: findingPk(acct), SK: fid },
    }));
    item = r.Item;
  } catch (e) {
    return fail("ddb_error", String(e));
  }
  if (!item) return fail("not_found", "该 finding 不存在或已清理");
  const todayIso = isoDaysAgo(0);
  return {
    ok: true,
    ...shapeFinding(item, todayIso),
    // 详情页才给全文
    da_body: String(item.da_body || ""),
    da_updated_at: num(item.da_updated_at),
  };
}

// ---------------------------------------------------------------------------
// run 记录与总览
// ---------------------------------------------------------------------------

function shapeRun(item) {
  const stats = item.stats || {};
  const dispatch = item.dispatch || stats.dispatch || {};
  return {
    run_type: String(item.run_type || ""),
    run_date: String(item.run_date || ""),
    account_id: String(item.account_id || ""),
    status: String(item.status || ""),
    data_date: String(item.data_date || ""),
    source: String(item.source || ""),
    mode: String(item.mode || ""),
    tier: String(item.tier || ""),
    catch_up: Boolean(item.catch_up),
    config_version: String(item.config_version || ""),
    completeness: num(stats.completeness ?? item.completeness),
    expected: item.expected || null,
    actual: stats.actual || item.actual || null,
    findings: num(dispatch.findings),
    dispatched_tasks: num(dispatch.dispatched_tasks),
    // ⚠️ `mapped_tasks` 与 `dispatched_tasks` 都给前端：两者不等意味着有 task
    //    发出去了却没落映射 → 那些判读回不来。合成一个数字会让这个缺口
    //    在看板上完全看不见。
    mapped_tasks: num(dispatch.mapped_tasks),
    heartbeat: Boolean(dispatch.heartbeat),
    skipped_by_gate: dispatch.skipped_by_gate || null,
    gaps: num(stats.gaps),
    batches_failed: num(stats.batches_failed),
    // 🔴 region 覆盖面（2026-08-27）。**必须带出去** —— 不带的话
    //    「us-west-2 今天没扫」与「us-west-2 没有资源」在 UI 上不可区分，
    //    而那正是这一整轮改造要消灭的形态，只是粒度换成了 region。
    //
    //    `shapeRun` 是逐字段白名单转换，未列出的字段直接丢 —— 所以
    //    `by_region` / `regions` 写进了 run 记录但读侧拿不到，就是典型的
    //    「算好了没人取」。
    //
    // ⚠️ `total` 与 `failed` 都要：失败的 region 在 `by_region` 里**连键都
    //    没有**（不是 0），所以只看 `by_region` 看不出少了谁。
    regions: {
      total: num((stats.regions || {}).total ?? item.regions_total),
      scanned: num((stats.regions || {}).scanned ?? item.regions_scanned),
      failed: ((stats.regions || {}).failed || item.regions_failed || [])
        .map((x) => String(x)),
    },
    by_region: Object.fromEntries(
      Object.entries(item.by_region || {}).map(([k, v]) => [k, num(v)])),
  };
}

/**
 * 最近若干天的 run 记录。
 *
 * ⚠️ 按**日期逐个 PK 查**而不是 Scan：run 的 PK 是 `insprun#<type>#<date>`，
 * 没有跨日期的 PK。Scan 在表变大后会变慢且贵，且拿不到稳定顺序。
 */
export async function getRuns(accountId, { days = 14 } = {}) {
  // 🔴 `accountId === null` = **明确要跨账号**，跳过 resolveAccount。
  //
  //    下面那段查询早就支持跨账号（`acct` 为空时不加 SK 条件，而 run 记录的
  //    SK 就是账号）—— 只是 `resolveAccount("")` 会把空串兜底成部署账号，
  //    于是那条分支从来没被走到过。
  //
  // ⚠️ 判据是 `=== null` 而不是 falsy：空串仍要走兜底
  //    （前端把 `<option value="">` **定义为**「部署账号」，那个约定不能动 ——
  //     `tests/inspection.test.mjs` 有断言钉着）。
  const acct = accountId === null ? null : await resolveAccount(accountId);
  const n = Math.min(Math.max(Number(days) || 14, 1), 60);
  const jobs = [];
  for (const rt of RUN_TYPES) {
    for (let i = 0; i < n; i++) {
      const pk = runPk(rt, isoDaysAgo(i));
      jobs.push(ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "#pk = :pk" + (acct ? " AND #sk = :sk" : ""),
        ExpressionAttributeNames: acct ? { "#pk": "PK", "#sk": "SK" } : { "#pk": "PK" },
        ExpressionAttributeValues: acct ? { ":pk": pk, ":sk": acct } : { ":pk": pk },
      })).catch(() => ({ Items: [] })));   // 单天查失败不拖垮整列表
    }
  }
  const results = await Promise.all(jobs);
  const rows = [];
  for (const r of results) for (const it of r.Items || []) rows.push(shapeRun(it));
  // 日期降序 → 类型（high 在前，与侧栏顺序一致）
  rows.sort((a, b) => b.run_date.localeCompare(a.run_date)
    || RUN_TYPES.indexOf(a.run_type) - RUN_TYPES.indexOf(b.run_type));
  return rows;
}

/**
 * 总览里回传多少轮 run 记录。
 *
 * ⚠️ 与 `runs_total` 成对回传 —— 只截断不说截了多少就是静默截断
 * （前端会把「显示 3 / 20」当成「一共只有 20 轮」）。
 */
const RUNS_LIMIT = 20;

/**
 * 总览：KPI + 与上一轮的 diff + 最近 run（9.8）。
 *
 * ⚠️ diff 的基准是「同类型的上一轮」而不是「昨天」：闲置轮可能是周度的，
 * 拿昨天做基准会让每次都显示「全部新增」。
 */
export async function getOverview(accountId, {
  allAccounts = false, visible = null,
} = {}) {
  // 🔴 `allAccounts` = 统一视图。与 `getFindings` 同一套门：
  //    **拿不到可见账号集合就拒绝**，不放行。
  //
  // ⚠️ run 记录的主键是 `insprun#<类型>#<日期>`、SK 是**账号** —— 也就是说
  //    一次 Query 天然拿到那天那一类的**全部账号**。`getRuns` 早就支持
  //    （`acct` 为空时不加 SK 条件），只是 `resolveAccount` 把空串兜底成了
  //    部署账号，于是那条路从来没被走到。跨账号的运行状态几乎是白送的。
  if (allAccounts && (visible === null || visible === undefined)) {
    return fail("visibility_required",
      "跨账号查询必须由路由层提供可见账号集合（这是防越权的硬门）");
  }
  const acct = allAccounts ? null : await resolveAccount(accountId);
  if (!allAccounts && !acct) return fail("account_required", "缺少 account 参数");

  // ⚠️ `queryFindings` 而不是 `getFindings` —— 后者强制 kind，总览要的是
  //    跨 kind 全量。写成 getFindings(acct) 的表现是总览页恒 `bad_kind`。
  const [findings, runsRaw] = await Promise.all([
    queryFindings(acct, { visible }),
    getRuns(acct, { days: 14 }),
  ]);
  // run 记录也要按可见账号过滤 —— 它带 account_id，而统一视图会把所有账号
  // 的运行状态摊开（哪个账号今天跑失败了本身也是信息）。
  const runs = (!acct && visible && visible !== "*")
    ? runsRaw.filter((r) => visible.has(String(r.account_id || "")))
    : runsRaw;
  if (findings.ok === false) return findings;

  const latestByType = {};
  for (const r of runs) {
    if (!latestByType[r.run_type]) latestByType[r.run_type] = [];
    if (latestByType[r.run_type].length < 2) latestByType[r.run_type].push(r);
  }
  const diff = {};
  for (const rt of RUN_TYPES) {
    const [cur, prev] = latestByType[rt] || [];
    diff[rt] = {
      current: cur ? cur.findings : null,
      previous: prev ? prev.findings : null,
      delta: (cur && prev && cur.findings !== null && prev.findings !== null)
        ? cur.findings - prev.findings : null,
      last_run_date: cur ? cur.run_date : "",
      last_status: cur ? cur.status : "",
      completeness: cur ? cur.completeness : null,
    };
  }

  // 状态分布：R6 的 finding 状态机四态
  const byState = {};
  for (const f of findings.findings) {
    byState[f.state || "unknown"] = (byState[f.state || "unknown"] || 0) + 1;
  }

  // 🔴 派发缺口：dispatched > mapped 意味着有判读永久回不来。
  //    看板必须能看见这个数，否则它只表现为「finding 旁边是空的」。
  const dispatchGap = runs.reduce((acc, r) => {
    if (r.dispatched_tasks !== null && r.mapped_tasks !== null
        && r.dispatched_tasks > r.mapped_tasks) {
      return acc + (r.dispatched_tasks - r.mapped_tasks);
    }
    return acc;
  }, 0);

  /**
   * 采集缺口与失败批次的**累计**。
   *
   * 🔴 `shapeRun` 早就把 `gaps` / `batches_failed` 逐行带出来了，但读侧一个都
   * 没渲染 —— 而 `TriageEmpty` 的 partial 分支明明写着「有采集缺口（具体
   * region 见下方「系统状态」）」，把客户指向一个**不存在的东西**。
   *
   * ⚠️ 聚合口径是「**未截断**的 runs」，与 `dispatch_gap` 一致 —— 见下面
   *    `runs_total` 那段说明。
   */
  const gapsTotal = runs.reduce((a, r) => a + (r.gaps ?? 0), 0);
  const batchesFailed = runs.reduce((a, r) => a + (r.batches_failed ?? 0), 0);

  /**
   * 各闸门各拦下多少条，跨这些轮累加。
   *
   * 🔴 `assemble.py` 的 `skipped_by_gate` 注释写着「报告要能解释『为什么这条
   * 没有 AI 分析』」，`shapeRun` 也逐行带出来了 —— 而读侧零渲染，
   * 典型的「算好了没人取」。
   *
   * ⚠️ 这里**不做 NEEDS_NO_AI 分桶**：那件事在 `without_judgment_by_reason`
   *    上做（那是按 finding 自己的 skip_reason 分的，与「要不要人管」直接
   *    对应）。这一份是**运行侧**的原始计数，两者的计数对象与时间窗都不同，
   *    合并会造出一个既不是 finding 数也不是决策数的数字。
   */
  const skippedByGate = {};
  for (const r of runs) {
    for (const [k, v] of Object.entries(r.skipped_by_gate || {})) {
      const n = num(v);
      if (n !== null) skippedByGate[k] = (skippedByGate[k] || 0) + n;
    }
  }

  return {
    ok: true,
    account_id: acct,
    total: findings.total,
    by_severity: findings.by_severity,
    by_state: byState,
    without_judgment: findings.without_judgment,
    /** 见 `queryFindings` 的同名字段。总览是唯一能看到跨 kind 全量的地方。 */
    unclassified: findings.unclassified,
    truncated_at: findings.truncated_at || 0,
    /**
     * 判读解析质量（见 `queryFindings` 的同名字段）。
     *
     * 🔴 这里是它唯一有意义的位置：总览跨全部 kind，而 skill 漂移是**全局**
     * 现象 —— 在单个 kind 页上看只能看到那一类的比例，判断不出「是这一类
     * 特殊还是整条链坏了」。
     */
    parse_quality: findings.parse_quality,
    /**
     * 门禁聚合（D22）。与 `parse_quality` 同理，总览是它唯一有意义的位置：
     * skill 没加载 / 账号没关联都是**全局**故障（措辞路由、agent space 配置），
     * 单 kind 页上看不出「是这一类特殊还是整条链坏了」。
     */
    gate_quality: findings.gate_quality,
    /** 见 `queryFindings` 的同名字段 —— 一个总数说不出下一步该做什么。 */
    without_judgment_by_reason: findings.without_judgment_by_reason || {},
    dispatch_gap: dispatchGap,
    /** 各闸门各拦下多少条，跨这些轮累加。见上面 `skippedByGate` 的说明。 */
    skipped_by_gate: skippedByGate,
    /** 采集缺口累计。`TriageEmpty` 的 partial 提示指向的就是这个数。 */
    gaps: gapsTotal,
    /** 失败批次累计（>0 = 有资源压根没被评估过）。 */
    batches_failed: batchesFailed,
    diff,
    runs: runs.slice(0, RUNS_LIMIT),
    /**
     * 截断**之前**有多少轮。
     *
     * 🔴 前端那句「显示 N / M 轮」的 M 取的是 `runs.length` —— 也就是**已经被
     * 这里截过**的数（20）。于是它说的是「显示 3 / 20 轮」，而真实可能是
     * 137 轮。同一个仓库里 findings 侧有 `truncated_at` 专门解决这件事，
     * runs 侧却是静默截断。
     *
     * ⚠️ `dispatch_gap` / `skipped_by_gate` / `gaps` / `batches_failed` 全部
     *    按**未截断**的 runs 算 —— 也就是说那几个总数可能大于表里能加出来的。
     *    这是刻意的（少算比少报好），但前端必须说明白，否则客户会看到
     *    「派发缺口 37」而在 20 行里加不出 37。
     */
    runs_total: runs.length,
    /** 回传的上限，前端用来说「只回传最近 N 轮」而不是写死一个数。 */
    runs_limit: RUNS_LIMIT,
  };
}

// ---------------------------------------------------------------------------
// 序列（趋势图 / sparkline）
// ---------------------------------------------------------------------------

/**
 * 一个实例一个指标的逐日序列。
 *
 * ⚠️ 读侧过滤 TTL 已过期的行 —— DDB 的 TTL 删除是**最长 48 小时内**的后台过程，
 * 不是到点即删。不过滤会画出早该消失的点，而那些点的 `config_version`
 * 对应一份不存在的配置，阈值线会画错（Python 侧 `query_series` 同口径）。
 */
export async function getSeries(accountId, { region, service, instance, metric = "", stat = "" } = {}) {
  const acct = await resolveAccount(accountId);
  if (!acct) return fail("account_required", "缺少 account 参数");
  if (!region || !service || !instance) {
    return fail("resource_required", "缺少 region / service / instance");
  }
  const nowEpoch = Math.floor(Date.now() / 1000);
  const names = { "#pk": "PK", "#ttl": "ttl" };
  const values = { ":pk": seriesPk(acct, region, service, instance), ":now": nowEpoch };
  let kce = "#pk = :pk";
  if (metric) {
    kce += " AND begins_with(#sk, :sk)";
    names["#sk"] = "SK";
    values[":sk"] = metric + "#";
  }
  let items;
  try {
    items = await queryAll({
      TableName: TABLE,
      KeyConditionExpression: kce,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      FilterExpression: "attribute_not_exists(#ttl) OR #ttl > :now",
    });
  } catch (e) {
    return fail("ddb_error", String(e));
  }

  // SK 形状：<metric>#<stat>#<data_date>
  const series = {};
  for (const it of items) {
    const parts = String(it.SK || "").split("#");
    if (parts.length < 3) continue;
    const [m, st, date] = parts;
    if (stat && st !== stat) continue;
    const key = m + "#" + st;
    (series[key] ||= { metric: m, stat: st, points: [] }).points.push({
      date, value: num(it.value),
    });
  }
  for (const s of Object.values(series)) {
    s.points.sort((a, b) => a.date.localeCompare(b.date));
  }
  return {
    ok: true, account_id: acct, region, service, instance,
    series: Object.values(series).sort(
      (a, b) => a.metric.localeCompare(b.metric) || a.stat.localeCompare(b.stat)),
  };
}

// ---------------------------------------------------------------------------
// 巡检范围（9.13）
// ---------------------------------------------------------------------------

/**
 * 两份排除清单 + 两份巡检范围。
 *
 * ⚠️ **两份是独立的**（R1.2）。合成一份的表现：客户把一台库从「高负载」
 * 排除掉，「闲置」轮也不看它了 —— 而那两件事的判断依据完全不同
 * （「这台库我知道 CPU 高，别报了」不代表「这台库没人用也别管」）。
 */
/**
 * 排除条目 → 前端形状。
 *
 * 🔴 字段名是 **`expires_at`**，不是 `expires_on`。第一版读后者 ——
 * 那个键 DDB 里没有，表现是到期列永远空白，而「到期提示续期」（R1.4）
 * 因此完全不起作用，且不报错。
 *
 * ⚠️ `expired` 由**读侧算**（`today >= expires_at`，该日起失效不含当日 ——
 * 与 `scope.ExclusionEntry.is_active` 逐字同口径）。存一个布尔字段会在
 * 到期当天变成陈旧值，除非有人每天来刷一遍。
 *
 * ⚠️ R1.4：到期条目**保留记录但不生效**，所以这里不过滤掉它们，
 * 只打标记。过滤掉会让客户以为「那条排除消失了」，从而重新加一条 ——
 * 而防「白名单越积越多没人敢删」的机制正是让它们可见。
 */
/**
 * 一条排除/范围记录归属哪个账号。
 *
 * 🔴 不能只读 `account_id` 属性。SK 的第一段**就是**账号
 * （`normalizeExclusion` 拼的 `[account, region, service, resource].join("#")`），
 * 而属性是后来才加的 —— 存量行可能没有它。
 *
 * 这个回退是**可见性过滤的判据**，所以空串必须当成「认不出归属」而不是
 * 「属于当前用户」：一条认不出账号的记录被放行，等于给跨账号泄漏留一个
 * 只在存量数据上触发的口子（新数据全绿，测试也全绿）。
 */
export function accountOfRow(it) {
  const attr = String(it?.account_id || "").trim();
  if (ACCOUNT_RE.test(attr)) return attr;
  const first = String(it?.SK || "").split("#")[0] || "";
  return ACCOUNT_RE.test(first) ? first : "";
}

/**
 * 按可见账号（+ 可选的单账号）过滤排除/范围记录。**纯函数。**
 *
 * 🔴 抽出来是为了能被单测真的覆盖。留在 `getScope` 里就只有源码文本断言，
 * 而这一层是**越权门**：`exclusionKeys` 那条注释记着实测结果 ——
 * 「把匹配键改回裸 resource_id，BFF 那 75 条测试全绿」。
 * 一个能被静默改掉的越权门比没有门更糟，因为它让人以为有门。
 *
 * @param rows DDB 原始 item（**未** shape），要能读到 `SK` / `account_id`
 * @param account 只留这一个账号；空串 = 全部可见账号
 * @param visible `"*"` 或 `Set<accountId>`
 */
export function filterScopeRows(rows, { account = "", visible = null } = {}) {
  const only = String(account || "").trim();
  return (rows || []).filter((row) => {
    const acc = accountOfRow(row);
    // 认不出账号的行一律丢 —— 见 `accountOfRow` 的说明。
    if (!acc) return false;
    if (visible !== "*" && !(visible && visible.has && visible.has(acc))) {
      return false;
    }
    return !only || acc === only;
  });
}

function shapeExclusion(it, todayIso) {
  const expiresAt = String(it.expires_at || "");
  return {
    key: String(it.SK || ""),
    // ⚠️ 走 `accountOfRow` 而不是裸 `it.account_id` —— UI 要按账号分组，
    //    而一个空白的账号分组标题会让客户以为「这条不属于任何账号」。
    account_id: accountOfRow(it),
    region: String(it.region || ""),
    service: String(it.service || ""),
    resource_id: String(it.resource_id || ""),
    // level 缺失是**级联排除静默失效**的形态（put_exclusion 会拒写，
    // 但历史行可能没有），所以原样透出让 UI 能标出来。
    level: String(it.level || ""),
    reason: String(it.reason || ""),
    expires_at: expiresAt,
    never_expires: !expiresAt,
    expired: Boolean(expiresAt) && todayIso >= expiresAt,
    created_by: String(it.created_by || ""),
    created_at: String(it.created_at || ""),
  };
}

/**
 * 两份排除清单 + 两份巡检范围，**按可见账号过滤**。
 *
 * 🔴 这个端点原来完全不管账号（2026-09-01 修）。PK 是 `inspscope#<kind>`，
 * 账号只在 SK 的第一段里，于是一次 Query 拿到的是**全组织**的排除条目：
 *
 * ```
 * ① 越权     只被允许看账号 A 的人能读到 B 的资源名、排除原因、创建人
 *            （再配合 renew 还能把 B 的排除延长 30 天 —— 那条路已经在
 *             路由层堵上了，但读侧一直漏着）
 * ② 误导     客户在页头选中 677，列表里却混着 088 的整账号 `*` 行，
 *            而那一行连账号列都没有 —— 看不出它是谁的
 * ③ 锁死     `getResources` 拿这份清单标「已排除」徽标并 disable checkbox。
 *            键里没有账号（`exclusionKeys`），于是 088 的
 *            `notiops-tb-redis-us-east-1` 会把 677 的同名资源标成已排除
 *            → 那台资源从界面上**再也排不掉**，而后端照常巡检它、照常花钱。
 *            与 region 那条修过的缺陷是同一形态。
 * ```
 *
 * 🔴 `visible` **不给就拒**，不是「不给就放行」。与 `getFindings` /
 * `getOverview` 同一套硬门：后者在忘记接线时**静默越权**，
 * 而这一轮审计里最贵的几条缺陷全是那个形态。
 *
 * @param account 只看这一个账号；空串 = 全部可见账号（看板默认）
 * @param visible `"*"` 或 `Set<accountId>`，由路由层算（那里才有身份上下文）
 */
export async function getScope({ account = "", visible = null } = {}) {
  if (visible === null || visible === undefined) {
    return fail("visibility_required",
      "排除清单的 PK 不带账号维度，必须由路由层提供可见账号集合（防越权的硬门）");
  }
  const only = String(account || "").trim();
  if (only && !ACCOUNT_RE.test(only)) {
    return fail("bad_account", "account 必须是 12 位数字");
  }
  /** 过滤判据抽在 `filterScopeRows` 里 —— 那是越权门，必须能被单测覆盖。 */
  const keep = (rows) => filterScopeRows(rows, { account: only, visible });
  const todayIso = isoDaysAgo(0);
  // 🔴 把 resolve 出来的部署账号一起返回。
  //
  // 巡检范围页**不渲染账号选择器**（单账号锁定，没什么可选的），所以前端
  // 手里的 `accountId` 是空串。而写端点要求 `/^\d{12}$/` —— 前端只能从
  // **已有排除条目**里回填账号，于是全新部署上是个死锁：
  //
  // ```
  // 要建第一条排除项  → 需要 12 位 account_id
  // account_id 从哪来 → 从已有排除条目回填
  // 但清单是空的      → 回填不到 → 两个入口都禁用 → 永远建不了第一条
  // ```
  //
  // 客户看到的是「排除资源」和「整账号排除」两个按钮都灰着，tooltip 让他
  // 「先在待处置页选一个账号」—— 而那一页也没有账号选择器（单账号部署）。
  //
  // ⚠️ 拿不到就返回空串，**不抛**。读路径不该因为 STS 抽风而整页失败 ——
  //    清单本身是能显示的，只是写入入口会继续禁用（那时 tooltip 是对的）。
  const out = {
    ok: true, account_id: await resolveAccount(""), exclusions: {}, targets: {},
  };
  for (const kind of ["high", "idle"]) {
    try {
      // ⚠️ 过滤在 `.map` **之前**：shape 之后再滤要靠 shape 出来的字段，
      //    而那一步已经把「认不出账号」归一成空串，判据会更弱。
      out.exclusions[kind] = keep(await queryAll({
        TableName: TABLE,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "PK" },
        ExpressionAttributeValues: { ":pk": scopePk(kind) },
      })).map((it) => shapeExclusion(it, todayIso));
      out.targets[kind] = keep(await queryAll({
        TableName: TABLE,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "PK" },
        ExpressionAttributeValues: { ":pk": targetPk(kind) },
      })).map((it) => ({
        key: String(it.SK || ""),
        account_id: accountOfRow(it),
        region: String(it.region || ""),
        service: String(it.service || ""),
        resource_id: String(it.resource_id || ""),
      }));
    } catch (e) {
      return fail("ddb_error", String(e));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 写入
//
// ⚠️ 这三个是本 feature 里**唯一**的看板写入路径，走独立的
// `action:inspection:*` 能力而不是 `nav:inspection`。理由不是洁癖：
// 搭在 nav 上意味着任何能看看板的人都能把生产库从巡检范围里摘掉，
// 而那个操作**没有任何运行时信号** —— 下一轮巡检就是少了那台，
// 报告上不会写「有一台被排除了」。
// ---------------------------------------------------------------------------

/** 合法的排除层级。与 `scope.ScopeLevel` 逐字一致。 */
const SCOPE_LEVELS = Object.freeze(["instance", "cluster", "group", "account"]);

/**
 * 数据层的账号可见性硬门。**三个写入端点共用。**
 *
 * 🔴 存在的理由是一条 Critical 越权（2026-09-02 review 抓到）。路由层
 * （`index.mjs`）把四个键名合成**一个标量**：
 *
 * ```js
 * const requestedAccount = (q.account) || (body.account_id)
 *                       || (body.account) || keyAccount || "";
 * ```
 *
 * `||` 短路 —— 谁在链上靠前，谁就把后面的全遮住，而**后面那个才是端点
 * 真正用的**。于是三条写入路都能绕：
 *
 * ```
 * POST /inspection/scope/high?account=<可见A>
 *   body { account_id: "<不可见B>", level: "account",
 *          confirm_account_wide: true, reason: "x" }
 *   → 门禁校验 A（放行）→ normalizeExclusion 用 body.account_id = B
 *   ⇒ 把 B 整个账号写出巡检范围，30 天内没有任何运行时信号
 *
 * POST /inspection/scope/high/renew
 *   body { account_id: "<可见A>", key: "<B>#us-east-1#rds#prod-db" }
 *   → 门禁取 body.account_id（在 keyAccount **之前**）→ 校验 A
 *   → renewExclusion 用 key ⇒ 延长 B 的排除
 *
 * POST .../delete 同上 ⇒ 删掉 B 的排除，且响应回传 B 的
 *   account_id / resource_id / level ⇒ 越权**读**
 * ```
 *
 * 🔴 修法是**在数据层再拒一次**，与 `getScope` / `getFindings` /
 * `triggerRun` 同一套：`visible` 不给就拒，而不是不给就放行。
 * 后者在忘记接线时**静默越权** —— 这一轮审计里最贵的几条缺陷全是那个形态，
 * 而这三个函数此前连 `visible` 参数都没有。
 *
 * ⚠️ 路由层那一道**也要留**（纵深防御）：它是集中的，将来任何端点用
 * `body.account_id` 都自动被覆盖。两道门防的是不同的遗漏。
 *
 * @param account 12 位账号；空串 / 畸形一律拒（调用方已先做形状校验）
 * @param visible `"*"` 或 `Set<accountId>`；`null`/`undefined` = 没接线 → 拒
 */
function denyIfInvisible(account, visible) {
  if (visible === null || visible === undefined) {
    return fail("visibility_required",
      "写入排除清单必须由路由层提供可见账号集合（防越权的硬门）—— "
      + "不给就拒，因为「不给就放行」在忘记接线时静默越权");
  }
  const acc = String(account || "").trim();
  if (!ACCOUNT_RE.test(acc)) {
    return fail("bad_account", "account 必须是 12 位数字");
  }
  if (visible !== "*" && !(visible && visible.has && visible.has(acc))) {
    return fail("account_forbidden", `没有账号 ${acc} 的可见权限`);
  }
  return null;
}

/**
 * 缺失段的占位符。**与 `keys.py` 的 `MISSING` 一致** ——
 * SK 的段数必须固定，否则 DDB 侧按位置解析会错位。
 */
const MISSING_SEG = "-";

const ACCOUNT_RE = /^\d{12}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** `HH:MM`，且分钟必须是 15 的整数倍（见 `putSchedule` 的说明）。 */
const AT_UTC_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TICK_MINUTES = 15;

/**
 * 星期取值范围。**1 = 周一 … 7 = 周日**，对齐 Python 的 `date.isoweekday()`。
 *
 * 🔴 调度器的判据是 `inspection/domain/schedule.py::ScheduleConfig.matches_day`：
 * `d.isoweekday() in self.weekdays`。**不是** `weekday()`（那个才是 0=周一）。
 * 两者差一，而差一的表现是完全静默的：存 `0` 的那天永远不匹配（`isoweekday()`
 * 不返回 0）→ 那类巡检永远不跑，且没有任何错误信号。
 */
export const WEEKDAY_MIN = 1;
export const WEEKDAY_MAX = 7;

/**
 * 新增/更新一条排除（R1.3 / R1.5 / R1.7）。
 *
 * ⚠️ `level` **必填且必须合法**。`put_exclusion`（Python 侧）会拒写缺 level
 * 的条目，理由是「勾中集群即排除其下全部成员」靠它判 —— 缺了级联排除会
 * **静默失效**：UI 上集群是勾选状态，成员却照样出现在结果里。
 * 这里提前拦，让错误停在 400 而不是 500。
 *
 * ⚠️ R1.7：只给 `account_id` 不给 `resource_id` = **整账号排除**。
 * 那是一个能让整个账号从巡检里消失的操作，所以要求调用方显式带
 * `confirm_account_wide: true`。少了它返回 400 ——
 * 二次确认在 UI 上做，但后端也必须要求，否则脚本/误调一次就生效了。
 */
/**
 * 消费侧认的通配符。**必须与 `inspection/domain/scope.py::WILDCARD` 逐字一致。**
 *
 * 🔴 这个常量存在的理由是一次真实的缺陷（2026-08-23 交叉 review 找到）：
 * 写侧与消费侧对「什么算整账号排除」用了**两套判据**，两侧各自的单测全绿，
 * 分叉恰恰出在中间。
 *
 * ```
 * 写侧（这里）    accountWide = !resource || level === "account"
 * 消费侧          service === "*" && resource_id === "*"     ← 与 level 无关
 * ```
 *
 * 交集之外就是洞，而两个方向都出过：
 *
 * ```
 * H1  service="*" resource_id="*" level="instance"
 *     → 写侧不要求 confirm（`!"*"` 为假、level 不是 account）
 *     → 消费侧命中 by_account → **整个账号退出巡检**，R1.7 被绕过
 * H2  UI 的整账号排除发 {service:"rds", level:"account"}（无 resource_id）
 *     → 写侧写 resource_id: ""
 *     → 消费侧落 by_instance[(acct,"rds","")] → **一台都没排除**
 *     → 而界面显示「整账号已移出巡检范围」+ 表格里一条红色「整账号」badge
 * ```
 *
 * H2 是方向相反的错误 —— 比「多排了」更危险：后来复查覆盖面的人会认为
 * 这个账号已经被摘出去了。
 *
 * 现在的做法是**归一**：写侧把 `level === "account"` 强制展开成双通配，
 * 于是「写侧认定整账号」与「消费侧整账号生效」成为同一件事。
 * `tests/test_inspection_scope_roundtrip.py` 有往返断言钉住这一点。
 */
const WILDCARD = "*";

/** 允许的 service 值。⚠️ 白名单而不是「非空即可」—— 见 `normalizeExclusion`。 */
const EXCLUSION_SERVICES = Object.freeze(["rds", "elasticache", WILDCARD]);

/**
 * 校验 + 归一一条排除请求。**纯函数，不碰 DDB。**
 *
 * 抽出来是为了让往返测试能拿到「写侧真正会落库的那个 item」，
 * 而不是在 Python 里复现一遍写侧逻辑（复现一份等于测了一个不存在的实现，
 * 而那正是 H1/H2 的成因）。
 *
 * @returns `{ error }` 或 `{ item, accountWide }`
 */
export function normalizeExclusion(kind, body, { actor = "", today = "" } = {}) {
  if (kind !== "high" && kind !== "idle") {
    return { error: fail("bad_kind", "排除清单只有 high / idle 两份") };
  }
  const b = body || {};
  const account = String(b.account_id || "").trim();
  let service = String(b.service || "").trim().toLowerCase();
  let resource = String(b.resource_id || "").trim();
  const region = String(b.region || "").trim();
  let level = String(b.level || "").trim().toLowerCase();
  const reason = String(b.reason || "").trim();

  if (!ACCOUNT_RE.test(account)) {
    return { error: fail("bad_account", "account_id 必须是 12 位数字") };
  }
  // 🔴 白名单，不是「非空即可」。任意串都能落库的表现是一条
  //    「语义合法但永不匹配」的排除记录 —— UI 显示保存成功、巡检压根不看它。
  //    `getResources` 的注释专门讲了这个缺陷类型并在 UI 侧堵住了（不列 EC2），
  //    API 侧此前没堵。
  if (!EXCLUSION_SERVICES.includes(service)) {
    return { error: fail("bad_service",
      `service 只能是 ${EXCLUSION_SERVICES.join(" / ")}（巡检不覆盖其它服务）`) };
  }
  if (!SCOPE_LEVELS.includes(level)) {
    return { error: fail("bad_level",
      `level 必须是 ${SCOPE_LEVELS.join(" / ")} —— 级联排除靠它判，缺了会静默失效`) };
  }
  // R1.3：没有理由的排除是「白名单越积越多没人敢删」的起点。
  if (!reason) {
    return { error: fail("reason_required", "排除必须写理由（R1.3）") };
  }

  // ── 归一：让写侧的判定与消费侧的分支成为同一件事 ─────────────────────
  //
  // ⚠️ 顺序要紧：先把 `level === "account"` 展开成双通配，再判 accountWide。
  //    反过来的话 UI 那条（level=account 但 service=rds）仍然写出一条
  //    消费侧不认的记录 —— 那就是 H2。
  if (level === "account") {
    service = WILDCARD;
    resource = WILDCARD;
  }
  if (!resource) {
    // 不给 resource 就是「整个 service」。写空串的表现是消费侧落到
    // `by_instance[(acct, svc, "")]` —— 永不匹配任何真实 instance_id。
    resource = WILDCARD;
  }
  if (service === WILDCARD) {
    // ⚠️ 「所有服务的某台具体实例」没有意义 —— 实例 id 只在服务内唯一。
    //    不归一的表现是消费侧落 `by_instance[(acct, "*", "prod-db-1")]`，
    //    而查询用的是真实 service（`"rds"`）→ **永不匹配**。
    //    又是一条「语义合法但永不匹配」的记录，与 H2 同类。
    resource = WILDCARD;
  }

  // 🔴 判据覆盖**所有**会让消费侧整账号 / 整服务生效的形状。
  //    只判 `!resource || level === "account"` 会漏掉双通配那一支（H1）。
  const accountWide = service === WILDCARD && resource === WILDCARD;
  const serviceWide = !accountWide && resource === WILDCARD;
  if ((accountWide || serviceWide) && b.confirm_account_wide !== true) {
    return { error: fail("confirm_required",
      accountWide
        ? "整账号排除会让该账号整体退出巡检，需显式确认（R1.7）"
        : `整 ${service} 排除会让该账号下所有 ${service} 资源退出巡检，需显式确认（R1.7）`) };
  }

  // R1.3：默认 30 天有效期。**不允许静默永不过期** ——
  // `expires_at` 为空时 `audit_expiry` 会把它算进 `never_expires`，
  // 而那个数正是本机制要盯的问题本身。
  let expiresAt = String(b.expires_at || "").trim();
  if (expiresAt && !ISO_DATE_RE.test(expiresAt)) {
    return { error: fail("bad_expires_at", "expires_at 需为 YYYY-MM-DD") };
  }
  const todayIso = today || isoDaysAgo(0);
  if (expiresAt) {
    // ⚠️ 过去的日期落库即失效，而 UI 显示保存成功 —— 那台资源照样被巡检。
    //    正是这次重做要消灭的「打错了不会报错」那一类。
    // 🔴 `<=` 而不是 `<`。Python 侧 `ExclusionEntry.is_active` 是
    //    `today < self.expires_at` —— 填**今天**的话这条排除从写入那一刻就
    //    不参与判定（`ExclusionIndex.build` 直接跳过它），资源照样出现在报告里，
    //    而返回的是 `ok:true` + `expires_at:<今天>`。
    //
    // ⚠️ 这段自己的错误文案就写着「落库即失效，而界面会显示保存成功」——
    //    少覆盖了边界那一天。
    if (expiresAt <= todayIso) {
      return { error: fail("bad_expires_at",
        `expires_at 必须晚于今天（${todayIso}）—— 等于今天的话落库即失效`
        + `（判据是 today < expires_at），而界面会显示保存成功`) };
    }
    // ⚠️ 上限 5 年。`9999-12-31` 等同永不过期，但**不触发**「永不过期」那条
    //    警告、`audit_expiry` 的 `never_expires` 计数也统计不到它。
    //    要永不过期就走 `never_expires: true` 那条显式路径。
    const cap = new Date();
    cap.setUTCFullYear(cap.getUTCFullYear() + 5);
    if (expiresAt > cap.toISOString().slice(0, 10)) {
      return { error: fail("bad_expires_at",
        "expires_at 最多 5 年 —— 要永不过期请显式传 never_expires: true，"
        + "否则它绕过「永不过期」的审计计数") };
    }
  }
  if (!expiresAt && b.never_expires !== true) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 30);
    expiresAt = d.toISOString().slice(0, 10);
  }

  const item = {
    PK: scopePk(kind),
    SK: [account, region || MISSING_SEG, service, resource].join("#"),
    list_kind: kind,
    account_id: account,
    service,
    resource_id: resource,
    region,
    level,
    reason,
    created_by: String(actor || b.created_by || "").trim(),
    created_at: todayIso,
  };
  if (expiresAt) item.expires_at = expiresAt;
  return { item, accountWide, serviceWide };
}

export async function putExclusion(kind, body, { actor = "", visible = null } = {}) {
  const norm = normalizeExclusion(kind, body, { actor });
  if (norm.error) return norm.error;
  const { item, accountWide, serviceWide } = norm;

  // 🔴 门在 `normalizeExclusion` **之后**：那一步才把 `body.account_id`
  //    归一成 `item.account_id`，而门要校验的正是**端点真正会写的**那个账号。
  //    放在之前就又变成「校验一个、写另一个」（见 `denyIfInvisible`）。
  const denied = denyIfInvisible(item.account_id, visible);
  if (denied) return denied;

  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  } catch (e) {
    return fail("ddb_error", String(e));
  }
  return {
    ok: true, key: item.SK, kind,
    expires_at: item.expires_at || null,
    // ⚠️ 回传归一后的**实际**作用范围。UI 拿它显示「已排除整个账号」还是
    //    「已排除这一台」—— 显示与实际不一致正是 H2 的形态。
    scope: accountWide ? "account" : serviceWide ? "service" : "resource",
    service: item.service,
    resource_id: item.resource_id,
  };
}

/**
 * 续期一条排除（R1.4 的「一键续期」）。
 *
 * ⚠️ 用 `update_item` + `attribute_exists(PK)` 而不是 put：put 需要调用方
 * 把整条记录回传，而 UI 手里只有列表里那几个字段 —— 少传 `level` 就会
 * 让级联排除静默失效（那是 `put_exclusion` 专门拦的那个错）。
 * update 只动到期日，其余字段一个都不碰。
 */
export async function renewExclusion(
  kind, key, { days = 30, actor = "", visible = null } = {},
) {
  if (kind !== "high" && kind !== "idle") {
    return fail("bad_kind", "排除清单只有 high / idle 两份");
  }
  const sk = String(key || "").trim();
  if (!sk) return fail("key_required", "缺 key");
  // 🔴 `key` 的第一段就是 account_id，而路由层的账号可见性门禁只认三个固定
  //    键名（`q.account` / `body.account_id` / `body.account`）—— `key` 不在
  //    其中。于是只被允许看账号 A 的人可以：
  //
  //    ① 从 `/inspection/scope` 读到账号 B 的排除条目（那个端点的 PK 是
  //       `inspscope#<kind>`，不带账号维度）
  //    ② POST renew 把 B 的排除有效期延长 30 天
  //
  //    `attribute_exists(PK)` 满足 → 写入成功 → 返回 ok:true。
  //
  // ⚠️ 门禁那段的注释解释过为什么要补键名，但补的是**键名**，
  //    不是「凡带账号语义的入参都要过一遍可见性」。这里补上后者。
  const n = Number(days);
  if (!Number.isFinite(n) || n < 1 || n > 365) {
    return fail("bad_days", "days 需在 1~365 之间");
  }
  // 🔴 形状校验放在 days 之后 —— 保持原有的错误优先级（既有测试钉着
  //    「days=0 必须报 bad_days」，而那条用例传的 key 是个占位串）。
  //
  // 账号可见性在**路由层**校验（`index.mjs` 门禁那段把 `body.key` 的首段
  // 也纳入了）—— 那里才有 `sub` / `groups` / `eff` 三个身份上下文。
  // 这里只挡畸形 key，避免拿它去打 DDB。
  //
  // ⚠️ 判据与 `deleteExclusion` 共用 `badExclusionKeyShape` —— 两处分叉会让
  //    路由层的门禁认不出账号（它靠同一条「首段 12 位」规则）。
  const badKey = badExclusionKeyShape(sk);
  if (badKey) return badKey;
  // 🔴 账号取自 **key 的首段**（那是端点真正会改的那一行），不取任何
  //    请求体字段 —— 路由层的 `||` 链会让 `body.account_id` 遮住 key，
  //    于是「校验 A、改 B」。见 `denyIfInvisible`。
  const denied = denyIfInvisible(sk.split("#")[0], visible);
  if (denied) return denied;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  const expiresAt = d.toISOString().slice(0, 10);
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: scopePk(kind), SK: sk },
      UpdateExpression: "SET expires_at = :e, renewed_at = :t, renewed_by = :u",
      ExpressionAttributeValues: {
        ":e": expiresAt, ":t": isoDaysAgo(0), ":u": String(actor || ""),
      },
      ConditionExpression: "attribute_exists(PK)",
    }));
  } catch (e) {
    if (String(e).includes("ConditionalCheckFailed")) {
      return fail("not_found", "该排除条目不存在（可能已被删除）");
    }
    return fail("ddb_error", String(e));
  }
  return { ok: true, key: sk, kind, expires_at: expiresAt };
}

/**
 * key 的形状：首段必须是 12 位账号。**`renew` 与 `delete` 共用同一条判据。**
 *
 * ⚠️ 只抽形状，不抽整套校验 —— 两条路的**错误优先级**不同（`renew` 先判
 * `days` 再判 key 形状，有既有测试钉着），合成一个函数会改掉那个顺序。
 *
 * 🔴 这条正则同时是一道**越权门的前提**：路由层的账号可见性门禁靠
 * 「`body.key` 首段是 12 位数字」来认出账号（`index.mjs` 那段）。
 * 两处放宽得不一致的表现是门禁认不出账号 → 静默放行。
 */
function badExclusionKeyShape(sk) {
  if (!/^[0-9]{12}#/.test(sk)) {
    return fail("bad_key", "key 的第一段必须是 12 位账号 ID");
  }
  return null;
}

/**
 * 删除一条排除 —— 「挪出白名单」（2026-09-01，客户要求）。
 *
 * 🔴 **这条路以前不存在。** 清单上唯一的动作是「续期 30 天」，于是误操作
 * 之后客户只能等它过期：
 *
 * ```
 * 手滑排除了一台生产库 → 那台库 30 天不参与判定
 *                      → 而「没有告警」会被读成「一切正常」
 *                      → 30 天里没有任何运行时信号提醒它被摘掉了
 * ```
 *
 * 客户原话：「也没有任何位置让我取消移除。如果用户误操作，岂不是要等待
 * 30 天？」
 *
 * ## 为什么是硬删而不是软删
 *
 * R1.4 的「保留记录但不生效」说的是**到期**条目 —— 那个机制要防的是
 * 「白名单越积越多没人敢删」，靠的是让它们**可见**。而这里是客户显式说
 * 「这条不该存在」，留着它就正好是那份越积越多的清单本身。
 *
 * ⚠️ 审计不能一起丢（R6.4）。`ReturnValues: "ALL_OLD"` 把被删的整行拿回来
 * 打进 CloudWatch Logs —— 「谁在什么时候删了哪条、原来的理由是什么」全在。
 * 这比新开一个 DDB 前缀便宜，而新前缀要同步改 `keys.py` 并动那条
 * 「前缀数量 = 13」的绊线。
 */
export async function deleteExclusion(kind, key, { actor = "", visible = null } = {}) {
  if (kind !== "high" && kind !== "idle") {
    return fail("bad_kind", "排除清单只有 high / idle 两份");
  }
  const sk = String(key || "").trim();
  if (!sk) return fail("key_required", "缺 key");
  const bad = badExclusionKeyShape(sk);
  if (bad) return bad;
  // 🔴 同 `renewExclusion`：账号取 key 首段。这一条尤其要紧 ——
  //    响应会回传被删行的 `account_id` / `resource_id` / `level` / `reason`，
  //    所以门漏了不只是越权**写**，还是越权**读**。
  const denied = denyIfInvisible(sk.split("#")[0], visible);
  if (denied) return denied;
  let old;
  try {
    const r = await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: { PK: scopePk(kind), SK: sk },
      ConditionExpression: "attribute_exists(PK)",
      // 🔴 审计靠它。少了 ALL_OLD 就只知道「有人删了某个 key」，
      //    而 key 里没有理由、没有 level、没有创建人。
      ReturnValues: "ALL_OLD",
    }));
    old = r.Attributes || {};
  } catch (e) {
    if (String(e).includes("ConditionalCheckFailed")) {
      // ⚠️ 不当成错误往上抛得太重：整账号排除是**两条**记录，UI 成对撤销时
      //    另一份可能早就没了。`already_gone` 让调用方能把它算成成功。
      return fail("not_found", "该排除条目不存在（可能已被删除）");
    }
    return fail("ddb_error", String(e));
  }
  console.log("[inspection] 排除条目已删除 " + JSON.stringify({
    actor: String(actor || ""), kind, key: sk,
    account_id: accountOfRow(old),
    resource_id: String(old.resource_id || ""),
    region: String(old.region || ""),
    level: String(old.level || ""),
    reason: String(old.reason || ""),
    created_by: String(old.created_by || ""),
    created_at: String(old.created_at || ""),
    expires_at: String(old.expires_at || ""),
  }));
  return {
    ok: true, key: sk, kind,
    account_id: accountOfRow(old),
    resource_id: String(old.resource_id || ""),
    level: String(old.level || ""),
    // 回传「这条是不是整账号级」—— UI 靠它决定要不要成对撤销另一份清单。
    // ⚠️ 判据与 `normalizeExclusion` 的 `accountWide` 逐字相同（双通配），
    //    **不是** `level === "account"`：那两者曾经分叉过（H1/H2）。
    account_wide: String(old.service || "") === WILDCARD
      && String(old.resource_id || "") === WILDCARD,
  };
}

/**
 * 写定时配置（R11.1 / R13.5）。
 *
 * ⚠️ **按类型全局，不按账号**：PK 只有一个（`inspsched#config`），SK 是
 * `high` / `idle`。接受 `account_id` 参数会让 UI 上出现「给这个账号单独
 * 设时间」的入口，而后端读不到那样的行 —— 客户以为设了，实际没生效。
 *
 * 🔴 `at_utc` 的**分钟必须是 15 的整数倍**。调度是 EventBridge 的 15 分钟
 * tick，填 `02:07` 会得到一个**永远不被精确命中**的配置：它只能靠
 * `catch_up` 在 02:15 被补跑，表现为「报告总是慢 8 分钟」而不是报错。
 * Python 侧 `put_schedule` 也拦这一条，这里提前拦让错误停在 400。
 */
export async function putSchedule(runType, body, { actor = "" } = {}) {
  if (!RUN_TYPES.includes(runType)) {
    return fail("bad_run_type", `run_type 只能是 ${RUN_TYPES.join(" / ")}`);
  }
  const b = body || {};
  const atUtc = String(b.at_utc || "").trim();
  if (!AT_UTC_RE.test(atUtc)) return fail("bad_at_utc", "at_utc 需为 HH:MM");
  const minute = Number(atUtc.slice(3, 5));
  if (minute % TICK_MINUTES) {
    return fail("bad_at_utc_tick",
      `分钟数必须是 ${TICK_MINUTES} 的整数倍 —— 调度粒度等于 EventBridge `
      + "Rule 周期，其他时刻永远不会被精确命中（只会靠补跑，表现为报告总是晚几分钟）");
  }
  const catchUp = b.catch_up_hours === undefined || b.catch_up_hours === null
    ? 6 : Number(b.catch_up_hours);
  if (!Number.isFinite(catchUp) || catchUp < 0 || catchUp > 24) {
    return fail("bad_catch_up_hours", "catch_up_hours 需在 0~24 之间");
  }

  const item = {
    PK: SCHEDULE_PK,
    SK: runType,
    // ⚠️ 缺省 **true**，与 Python 侧 `_schedule_from_item` 一致。
    //    默认 false 会让客户跑完 setup.sh 之后什么都没发生且无错误信号。
    enabled: b.enabled === undefined || b.enabled === null ? true : Boolean(b.enabled),
    at_utc: atUtc,
    catch_up_hours: catchUp,
    updated_at: new Date().toISOString(),
    updated_by: String(actor || ""),
  };
  // null / 省略 = 每天跑。空数组会被 Python 侧当成 falsy 同样按每天跑，
  // 但显式写空数组会让「客户清空了选择」与「从没设过」长得一样，所以不写。
  if (Array.isArray(b.weekdays) && b.weekdays.length > 0) {
    const wd = b.weekdays.map((w) => Number(w));
    // 🔴 取值 **1~7（1 = 周一，7 = 周日）**，因为调度器用的是
    //    `date.isoweekday()`（`inspection/domain/schedule.py::matches_day`）。
    //
    // ⚠️ 这里曾写成 0~6，理由是「与 Python 的 weekday() 同」—— 那个前提是错的，
    //    调度器用的是 isoweekday 不是 weekday。后果**完全静默**：
    //      · UI 选「周一」→ 存 [0] → `isoweekday()` 永不返回 0 → 那类巡检**永远不跑**
    //      · UI 选「周日」→ 存 [6] → `isoweekday()==6` 是**周六** → 差一天
    //    两者都没有任何错误信号，客户只会以为「那天没有风险」。
    if (wd.some((w) => !Number.isInteger(w) || w < WEEKDAY_MIN || w > WEEKDAY_MAX)) {
      return fail("bad_weekdays",
        `weekdays 取值 ${WEEKDAY_MIN}~${WEEKDAY_MAX}（${WEEKDAY_MIN} = 周一，`
        + `${WEEKDAY_MAX} = 周日），对齐调度器的 date.isoweekday()`);
    }
    item.weekdays = [...new Set(wd)].sort((a, z) => a - z);
  }

  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  } catch (e) {
    return fail("ddb_error", String(e));
  }
  // R13.5：明确回传「下一轮时间」，让 UI 不必自己算（自己算必然与调度器分叉）。
  return { ok: true, run_type: runType, at_utc: atUtc, enabled: item.enabled,
    /* 🔴 **停用时返回空串。** 原来无条件算 —— 于是「取消启用 → 保存」的结果是
       header 上一个红色「已停用」徽章，正下方一条绿色「下一轮: 02:00」，
       两句直接矛盾，而 `schedule.py` 的 `if not cfg.enabled: continue`
       说明那一轮压根不会跑。
       ⚠️ 与 `shapeSchedule` 走**同一条**判据（`nextRunFor`）—— 两处各写一遍
          就是「保存后说不跑、刷新后又说跑」这种自相矛盾的来源。 */
    next_run_utc: nextRunFor(item.enabled, atUtc, item.weekdays ?? null) };
}

/**
 * 下一轮时刻，**带停用判据**。GET 与 PUT 都走这一个。
 *
 * 🔴 `enabled === false` → 返回空串（「不会再跑」），不是照算一个时刻。
 * 两处各写一遍的表现是「保存后说不跑、刷新后又说跑」这种自相矛盾 ——
 * 而 UI 那侧只有一个 `nextRun && (...)` 的渲染门，它信任这个字段。
 *
 * ⚠️ 空串同时也是 `nextRunUtc` 算不出来时的返回值。两者对客户的含义一致：
 *    **不要指望有下一轮**，所以不必区分。
 */
export function nextRunFor(enabled, atUtc, weekdays) {
  if (!enabled) return "";
  return nextRunUtc(atUtc, weekdays);
}

/**
 * 下一轮的 UTC 时刻（R13.5）。
 *
 * ⚠️ 由**后端**算并回传，不让前端算。前端算一遍等于同一个规则有两份实现，
 * 而这条规则有 weekdays 过滤 —— 分叉的表现是 UI 显示的下一轮时间与实际
 * 执行时刻不同，客户按 UI 的时间来等，等不到。
 */
export function nextRunUtc(atUtc, weekdays) {
  const [hh, mm] = atUtc.split(":").map(Number);
  const now = new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i, hh, mm));
    if (d <= now) continue;
    if (Array.isArray(weekdays) && weekdays.length > 0) {
      // JS 的 `getUTCDay()` 是 **0=周日**；调度器用的 `date.isoweekday()`
      // 是 **1=周一 … 7=周日**。
      // ⚠️ 不换算会让「只在周一跑」显示成「周日跑」—— 差一天，
      //    而客户要到第二周才会发现自己等错了日子。
      const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
      if (!weekdays.includes(iso)) continue;
    }
    return d.toISOString().slice(0, 16) + "Z";
  }
  return "";
}

// ---------------------------------------------------------------------------
// 配置（9.14 / 9.15）
// ---------------------------------------------------------------------------

/**
 * 三类规则配置 + 定时配置 + 可复用数据日期。
 *
 * ⚠️ 定时配置是**按类型全局**的（R11.1），PK 只有一个、SK 是 `high` / `idle`。
 * 前端 SHALL NOT 提供「给每个账号单独设时间」的入口 —— 那与「一天一轮、
 * 一份报告」的产品形态冲突，而后端也读不到那样的行。
 */
/** Python 侧 `ScheduleConfig` 的默认值镜像（`schedule.py`）。 */
const SCHEDULE_DEFAULTS = Object.freeze({
  enabled: true, at_utc: "02:00", weekdays: null, catch_up_hours: 6,
});

/**
 * 定时配置行 → 前端形状。
 *
 * 🔴 字段名是 **`at_utc` / `weekdays` / `catch_up_hours`**，不是 `cron`。
 * 第一版按 `cron` / `timezone` / `tier` / `updated_at` 读 —— 那四个键
 * DDB 里**一个都没有**（`put_schedule` 只写上面三个 + `enabled`）。
 * 表现是定时页四列全空，而 tsc / 测试 / 后端都不报错。
 *
 * ⚠️ 时刻是**纯 UTC 时分**而不是 cron 表达式：调度粒度等于 EventBridge
 * Rule 的 15 分钟周期，能表达的只有「几点几分」。给前端一个 cron 输入框
 * 会让客户写出「每 5 分钟」这种系统根本不会执行的东西。
 */
function shapeSchedule(runType, item) {
  const it = item || {};
  return {
    run_type: runType,
    // 行不存在时 enabled 默认 **true** —— 与 Python 侧一致。
    enabled: it.enabled === undefined || it.enabled === null
      ? SCHEDULE_DEFAULTS.enabled : Boolean(it.enabled),
    at_utc: String(it.at_utc || SCHEDULE_DEFAULTS.at_utc),
    // null = 每天跑；数组 = 只在这些星期几跑（1=周一 … 7=周日，
    // 对齐调度器的 `date.isoweekday()`，见 WEEKDAY_MIN/MAX 的说明）
    weekdays: Array.isArray(it.weekdays)
      ? it.weekdays.map((w) => num(w)).filter((w) => w !== null)
      : SCHEDULE_DEFAULTS.weekdays,
    catch_up_hours: num(it.catch_up_hours) ?? SCHEDULE_DEFAULTS.catch_up_hours,
    /** 该行是否真的落库过。前端据此区分「用的是默认值」与「客户配过」。 */
    persisted: Boolean(item),
    /**
     * 下一轮的 UTC 时刻。**`""` = 不会再跑**（停用了）。
     *
     * 🔴 此前只有 PUT 回传它，GET 不回 —— 于是「下一轮」这个信息**只在刚保存
     * 完的那一下**存在，刷新页面就没了。而 `at_utc` 与 `weekdays` 一直在手上，
     * 加进来的成本几乎为零（`nextRunUtc` 本来就是个导出的纯函数）。
     *
     * 🔴 **停用时返回空串**，不是照算一个时刻。原来 PUT 那侧无条件算 ——
     * 于是「取消启用 → 保存」的结果是 header 上一个红色「已停用」徽章，
     * 正下方一条绿色「下一轮: 02:00」，两句直接矛盾，而
     * `schedule.py` 的 `if not cfg.enabled: continue` 说明那一轮压根不会跑。
     *
     * ⚠️ 空串与「算不出来」在这里是同一个表达（`nextRunUtc` 找不到时也返回
     * 空串）。两者对客户的含义一致：**不要指望有下一轮**。
     */
    next_run_utc: nextRunFor(
      it.enabled === undefined || it.enabled === null
        ? SCHEDULE_DEFAULTS.enabled : Boolean(it.enabled),
      String(it.at_utc || SCHEDULE_DEFAULTS.at_utc),
      Array.isArray(it.weekdays) ? it.weekdays.map((w) => num(w)) : null),
  };
}

/**
 * 读某一轮当前生效的规则覆盖（`cfgver#inspection#<run_type>` 最新一行）。
 *
 * ⚠️ 与 Python 侧 `store.load_rule_config` **同口径**：SK 倒序取第一条，
 * 解析失败按空配置处理而不是抛 —— 配置页打不开比阈值显示成默认值更糟。
 *
 * ## 🔴 `strict` 是写路径**必须**传的
 *
 * 这个函数原来对任何异常都 `return {}`，而 `{}` 有两个完全不同的含义：
 *
 * ```
 * 「这个部署没配过任何自定义阈值」   全新部署的正常状态
 * 「我读不到（限流 / 无权 / 解析失败）」  故障
 * ```
 *
 * 读路径（`getConfig`）压成一个值是对的 —— 显示默认值比配置页打不开好。
 * 写路径（`putRules` 的 merge 基线）压成一个值是**数据丢失**：
 *
 * ```
 * 客户在阈值页只改一个字段并保存
 *   → merge 基线读失败 → prev = {}
 *   → merged = 只有这一个字段
 *   → 写出**全量快照** → 之前所有自定义阈值回到默认
 *   → 返回 ok:true，customized 徽章消失
 *   → 下一轮按默认阈值判定，一批之前被调高压掉的告警全部重新报出来
 * ```
 *
 * 这是 08-23 那个数据丢失缺陷的原样复现（那次修的是「不做全量覆盖」，
 * 而这条 catch 又把它造回来了 —— 基线错了，全量快照就是错的）。
 *
 * `strict: true` 时读失败**抛**，让 `putRules` 拒写。多一次失败的保存比
 * 静默清空客户的配置好。
 */
async function loadRuleOverrides(runType, { strict = false } = {}) {
  try {
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "PK" },
      ExpressionAttributeValues: { ":pk": configVersionPk("inspection", runType) },
      ScanIndexForward: false,
      Limit: 1,
    }));
    const item = (r.Items || [])[0];
    if (!item) return {};
    return JSON.parse(String(item.config_json || "{}")) || {};
  } catch (e) {
    if (strict) {
      // ⚠️ 带上原因。「读不到基线所以拒写」这句话客户看不懂，
      //    但底下那个 AWS 错误名（ProvisionedThroughputExceeded /
      //    AccessDenied）是运维唯一的线索。
      throw Object.assign(new Error(
        `读不到当前阈值配置，拒绝写入（避免把已有自定义清空）：`
        + `${e?.name || ""} ${e?.message || e}`.trim()),
        { code: "merge_base_unavailable" });
    }
    return {};
  }
}

export async function getConfig(accountId) {
  const acct = await resolveAccount(accountId);
  const out = { ok: true, schedules: {}, rules: {}, data_dates: [] };
  try {
    const sched = await queryAll({
      TableName: TABLE,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "PK" },
      ExpressionAttributeValues: { ":pk": SCHEDULE_PK },
    });
    const seen = new Set();
    for (const it of sched) {
      const rt = String(it.SK || "");
      seen.add(rt);
      out.schedules[rt] = shapeSchedule(rt, it);
    }
    // ⚠️ **行不存在时给默认值**，与 Python 侧 `_schedule_from_item` 同口径。
    //    不给的表现是全新部署上定时页一片空白，客户以为「还没配」——
    //    而实际上巡检**已经在按默认时刻跑**（那侧默认 enabled=True）。
    //    两边不一致比两边都空更糟：UI 说没配，系统在跑。
    for (const rt of RUN_TYPES) {
      if (!seen.has(rt)) out.schedules[rt] = shapeSchedule(rt, null);
    }
  } catch (e) {
    return fail("ddb_error", String(e));
  }

  // 🔴 判定阈值（R13.4）。此前这个字段在初始化成 `{}` 之后**再没被赋值过**
  //    —— 于是「阈值与定时」页的阈值那一半没有数据源，页面上只有定时。
  //    每个字段带 value / default / min / max / unit / customized，
  //    前端据此渲染，SHALL NOT 自己写死范围（那必然与后端校验分叉）。
  for (const rt of RUN_TYPES) {
    out.rules[rt] = describeRules(rt, await loadRuleOverrides(rt));
  }
  // 🔴 服务筛选器的数据由**后端**给（含各组字段数）。前端自己算一份会与
  //    字段的 services 归属分叉,表现是标签说管 Redis 而其实不管。
  //
  // ⚠️ 它是**筛选器不是作用域** —— 阈值配置全局一份,选服务只决定显示哪些
  //    字段。前端 SHALL 把这句呈现出来,否则客户以为「我只调了 Redis」。
  out.rule_services = ruleServiceCatalog();

  if (acct) {
    try {
      // 🔴 过滤**已过期但还没被物理删**的行。DynamoDB 的 TTL 是后台清理，
      //    官方口径最长 48 小时 —— 那段时间里过期行照样会被 Query 返回。
      //
      //    不过滤的表现：日期选择器里躺着一个可选日期，客户选了之后趋势图
      //    空白 / 全 INSUFFICIENT_DATA，而界面没有任何解释。
      //
      // ⚠️ Python 侧 `store.available_data_dates` 显式做了这个过滤，同一个
      //    文件里的 `getSeries` 也加了 FilterExpression —— 只有这一处漏了。
      out.data_dates = (await queryAll({
        TableName: TABLE,
        KeyConditionExpression: "#pk = :pk",
        FilterExpression: "attribute_not_exists(#ttl) OR #ttl > :now",
        ExpressionAttributeNames: { "#pk": "PK", "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":pk": dataBatchPk(acct),
          ":now": Math.floor(Date.now() / 1000),
        },
      })).map((it) => String(it.SK || "")).sort().reverse();
    } catch {
      out.data_dates = [];       // 索引缺失不该让整个配置页打不开
    }
  }
  return out;
}

/**
 * 改判定阈值（R13.4，能力 `action:inspection:threshold`）。
 *
 * 🔴 **写的是 append-only 的 cfgver 表**，不是一行可覆盖的当前值：
 *
 * ```
 * PUT /inspection/rules/high  →  cfgver#inspection#high 追加一行
 *                                scheduler 下一轮 load_rule_config 读最新那行
 *                                → 随消息下发 → executor 反序列化 → 判定生效
 * ```
 *
 * 也就是说**下一轮生效，不是立刻生效**。UI 必须把这句说出来，否则客户改完
 * 盯着看板等变化，等不到就以为没保存上。
 *
 * ⚠️ 按 R6.9，配置变更（`config_hash` 变）会让**全部旧 finding 被强制
 * resolve 并按新阈值重新计数**，UI 上标注「规则变更导致重新计数」。
 * 所以这是一个能一次性改写整个看板的操作 —— 它的能力点独立于改定时。
 *
 * ## 请求体是**增量**，服务端 merge
 *
 * 🔴 这一段 2026-08-23 修过一个**数据丢失**缺陷。原来的行为是把请求体
 * 原样写成新的一行，而读侧（`loadRuleOverrides` / Python 的
 * `store.load_rule_config`）都是「取最新那一行，**不 merge**」。
 * 于是「最新那一行 = 全量生效配置」，而前端只发 diff：
 *
 * ```
 * 第一天  把 cpu_utilization 从 70 改成 85 → 库里 {threshold:{cpu_utilization:85}}
 * 第二天  进同一页（显示 85 · 已自定义），只改 swap_usage_bytes → 保存
 *         新行只有 {threshold:{swap_usage_bytes:…}}
 *         → cpu_utilization 悄悄回到默认 70，连「已自定义」徽章都没了
 *         → 下一轮按 70 判定，一批之前被调高压掉的告警全部重新报出来
 *           而客户以为自己只动了 swap
 * ```
 *
 * 现在服务端先读最新一版再 merge，所以「部分覆盖」这个语义才真的成立。
 * 每一版仍然是**全量快照** —— 那对审计更好（能直接看到那一刻的完整配置），
 * 也不改变 `config_hash` 的语义（每次写都变，R6.9 照旧触发重新计数）。
 *
 * ## 恢复默认：把值传 `null`
 *
 * merge 之后没法用「不传」表达「删掉」，所以显式传 `null`：
 *
 * ```
 * {"threshold": {"cpu_utilization": null}}   → 从合并结果里删掉这个 key
 *                                              → 该字段回到代码默认值
 *                                              → `customized` 变回 false
 * ```
 *
 * ⚠️ 「恢复默认」**不能**用「显式传当前的默认值」实现 —— 那会把它记成
 * 「已自定义」，之后我们调默认值时这个部署不会跟着走。
 */
export async function putRules(runType, body, { actor = "" } = {}) {
  if (!RUN_TYPES.includes(runType)) {
    return fail("bad_run_type", `run_type 只能是 ${RUN_TYPES.join(" / ")}`);
  }
  // ── 先分离出「恢复默认」（值为 null）──────────────────────────────────
  //
  // ⚠️ 必须在 `normalizeOverrides` **之前**分离 —— 它按类型校验，`null`
  //    会被判 `bad_type`。而「恢复默认」是一个合法且必要的操作。
  const resets = {};
  const changes = {};
  for (const [section, fields] of Object.entries(body || {})) {
    if (!fields || typeof fields !== "object") { changes[section] = fields; continue; }
    for (const [key, v] of Object.entries(fields)) {
      if (v === null) (resets[section] ||= new Set()).add(key);
      else (changes[section] ||= {})[key] = v;
    }
  }

  const { overrides, errors } = normalizeOverrides(runType, changes);
  if (errors.length) {
    // ⚠️ 有一个不合法就整个拒。部分写入会让客户以为全都存上了，
    //    而下一轮只有一半生效 —— 那种半生效状态没有任何信号。
    return fail("bad_rules", errors.join("; "));
  }
  if (Object.keys(overrides).length === 0 && Object.keys(resets).length === 0) {
    return fail("empty_rules", "没有可写入的字段");
  }
  // 恢复默认也要校验 section 归属 —— 否则 `{"idle":{"x":null}}` 会在
  // 高负载轮里删一个不属于它的 key（无害但语义错，且会污染审计）。
  for (const section of Object.keys(resets)) {
    if (!sectionsFor(runType).includes(section)) {
      return fail("bad_rules", `section_not_allowed:${section}`);
    }
  }

  // ── merge：读最新一版，叠上本次改动，再删掉要恢复默认的 key ──────────
  // 🔴 `strict: true` —— 读不到基线就拒写。见 `loadRuleOverrides` 的说明：
  //    基线退化成 `{}` 会让这次写出的全量快照把客户所有自定义阈值清空，
  //    而返回值是 ok:true。
  const prev = await loadRuleOverrides(runType, { strict: true });
  const merged = {};
  for (const section of new Set([
    ...Object.keys(prev), ...Object.keys(overrides), ...Object.keys(resets),
  ])) {
    const body2 = { ...(prev[section] || {}), ...(overrides[section] || {}) };
    for (const k of (resets[section] || [])) delete body2[k];
    // 空 section 不留 —— 留下 `{"threshold":{}}` 会让「有没有自定义过」
    // 这个判断多一种形态。
    if (Object.keys(body2).length > 0) merged[section] = body2;
  }

  const now = new Date();
  const version = now.toISOString();
  const configJson = JSON.stringify(sortedDeep(merged));
  const item = {
    PK: configVersionPk("inspection", runType),
    SK: version,
    service: "inspection",
    rule_type: runType,
    config_json: configJson,
    config_hash: await sha256Hex16(configJson),
    // ⚠️ 与 scheduler 写的那些行区分开 —— 审计时要能看出「这一版是人改的」。
    changed_by: String(actor || "ui"),
  };
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE, Item: item,
      // append-only：同一时间戳撞上就是并发写，让后来者重试而不是静默覆盖
      ConditionExpression: "attribute_not_exists(SK)",
    }));
  } catch (e) {
    if (String(e).includes("ConditionalCheckFailed")) {
      return fail("version_conflict", "同一时刻已有另一次写入，请重试");
    }
    return fail("ddb_error", String(e));
  }
  return {
    ok: true, run_type: runType, config_version: version,
    // ⚠️ 回传 **merge 后的全量**而不是本次的增量。回传增量的表现是
    //    前端拿它刷新字段时，没在本次改动里的字段全部显示成默认值 ——
    //    与库里的真实状态不一致，而客户会以为自己的旧设置丢了
    //    （那正是这次修掉的那个数据丢失缺陷的**表象**）。
    rules: describeRules(runType, merged),
    // R13.5 同一口径：明示「下一轮生效」，让 UI 不必猜
    effective: "next_run",
  };
}

/**
 * 递归按键排序 + 数字规范化 —— `config_hash` 的规范化输入。
 *
 * 🔴 必须与 `inspection/adapters/store.py::canonical_config_json` **逐字节一致**。
 * 2026-08-26 实测两侧对同一份配置算出不同的哈希：
 *
 * ```
 * Python  {"threshold": {"cpu_utilization": 70.0}}   0d4d62a6313777ee
 * BFF     {"threshold":{"cpu_utilization":70}}       dd67ccb9dddf4813
 * ```
 *
 * 差异来自分隔符空格与 float 格式。这以前无害（`config_hash` 没有读者），
 * **现在有害**：`put_config_version` 拿它判「内容变没变」来决定要不要产生新的
 * 版本号，而版本号就是 R6.9 的 `rule_version`。两侧不一致 → 客户从 UI 保存一次
 * 阈值，下一轮 scheduler 判为「规则变了」→ 全部 finding 被强制 resolve。
 *
 * ⚠️ 这个函数原来的注释写的是「与 Python 侧同理」—— 那句话是假的。跨语言的
 *    **键序**有断言守着，跨语言的**序列化字节**没有。
 *    `tests/test_inspection_config_hash.py` 补上了。
 *
 * ⚠️ 数组也要递归（原来 `if (Array.isArray(v)) return v` 直接返回，数组里的 map
 *    键序就不排了）。阈值配置目前没有数组，但判据不该依赖那个巧合。
 */
function sortedDeep(v) {
  if (Array.isArray(v)) return v.map(sortedDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedDeep(v[k])]));
  }
  return v;
}

/**
 * `sha256(body)` 前 16 位 —— 与 Python 侧 `_stable_hash` 逐字一致。
 *
 * ⚠️ 不能用 JS 的任何非加密哈希：R6.9 的规则变更判据就是这个值，
 * 两侧算不出同一个数会让每一轮都被判成「规则变更」→ 全部 finding
 * 被反复 resolve 重建。
 */
async function sha256Hex16(body) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

/* ───────────────── 手动触发一轮巡检（action:inspection:run） ───────────────── */

/**
 * 触发一轮巡检。**只是转发给 scheduler**，不重实现任何调度逻辑。
 *
 * 额度护栏、run 锁抢占、fan-out、data_date 解析全在
 * `lambda_inspection_scheduler` 里。BFF 在这里做的只有三件事：
 * 参数校验、异步 invoke、把 scheduler 的回执原样递回。
 *
 * 🔴 `source` 默认 **refetch** 而不是 scheduler 自己的默认值 `reuse`。
 *    理由是这个端点的调用场景：人点了「立即巡检」，期望的是**现在的**
 *    指标。而 `reuse` 在没有历史批次时会直接抛
 *    （`resolve_reuse_date` 按 R11.4b 不静默降级），于是全新部署点一次
 *    按钮拿到的是一个失败的 run —— 而失败原因「没有可复用的批次」对
 *    点按钮的人毫无意义。
 *
 * 🔴 `mode` 默认 **dry_run**。official 会推进 finding 状态机并参与
 *    resolved 判定 —— 一次手点的补跑不该改变「这条风险是不是已解决」
 *    这种带日期语义的结论。要 official 必须显式传。
 *
 * ⚠️ `InvocationType: "Event"`（异步）。一轮 refetch 是分钟级，同步 invoke
 *    会顶到 Function URL 的 30 秒上限 —— 表现是前端超时报错而巡检**其实
 *    正常跑着**，用户会重复点。异步则立刻返回，进度靠轮询 run 行。
 */
export async function triggerRun(accountId, body, { actor = "", visible = null } = {}) {
  const b = body || {};
  const runType = String(b.run_type || "high").trim();
  if (!RUN_TYPES.includes(runType)) {
    return fail("bad_run_type", `run_type 只能是 ${RUN_TYPES.join(" / ")}`);
  }
  const source = String(b.source || "refetch").trim();
  if (!["reuse", "refetch"].includes(source)) {
    return fail("bad_source", "source 只能是 reuse / refetch");
  }
  const mode = String(b.mode || "dry_run").trim();
  if (!["dry_run", "official"].includes(mode)) {
    return fail("bad_mode", "mode 只能是 dry_run / official");
  }
  /**
   * `account: "*"` = 全部账号（部署账号 + 全部已启用的成员账号）。
   *
   * 🔴 **先 `resolveAccount` 再比哨兵**，不要在这里自己 `String(...).trim()`。
   *
   *    `resolveAccount` 是空值兜底成部署账号的**唯一**入口，而 `"*"` 非空
   *    ⇒ 它原样返回。所以这个顺序既拿到了哨兵判断，也没有把那段 trim 逻辑
   *    复制第二份。
   *
   *    `tests/inspection.test.mjs` 有一条守卫在数那段 trim 表达式的出现次数
   *    （必须只有 1 处，在 `resolveAccount` 内部）—— 它守的不变量是
   *    「不许有端点绕过部署账号兜底自己解析」。我第一版在这里加了第二处，
   *    那条守卫当场红了，是对的。
   *
   * ⚠️ 这段注释**刻意不写出那个表达式的字面量** —— 那条守卫剥注释之后才计数，
   *    但本仓库已经踩过八次「断言命中自己的注释」，不给它第九次机会。
   */
  /**
   * `accounts: ["<12 位>", …]` = **显式多选**（2026-09-01）。
   *
   * 🔴 为什么加这条路而不是让前端循环 POST N 次：与下面
   * 「一次 invoke 带全部账号」同一个理由 —— 循环会产生**部分成功**
   * （第 3 次失败时前两个已经在跑），而调用方只能拿到一个结果，
   * 于是要么谎报全失败（客户重试 → 前两个账号各跑两轮、花两倍的钱）、
   * 要么谎报全成功。scheduler 那侧本来就按列表扇出，数组是它的原生形态。
   *
   * ⚠️ 校验在**这里**而不是只在路由层：路由层的账号可见性门禁只认
   * `q.account` / `body.account_id` / `body.account` / `body.key` 四个键名，
   * 数组是第五个 —— 不管的话它自然放行（`renewExclusion` 与 `/inspection/scope`
   * 都踩过这个形态）。
   */
  const wantList = Array.isArray(b.accounts) ? b.accounts : null;

  /**
   * 可见账号硬门。
   *
   * 🔴 **不给就拒。** 与 `getFindings` / `getOverview` / `getScope` 同一套：
   * 「不给就放行」在忘记接线时是**静默越权**。
   *
   * 🔴 这条门顺带修掉一个既有的越权（2026-09-01 发现）：`account: "*"` 那条
   * 路走 `allTriggerTargets()`，它读的是**全组织**的成员账号表，而路由层的
   * 门禁看不到账号参数（`"*"` 不是 12 位数字）。于是：
   *
   * ```
   * 只被允许看账号 A 的人 POST /inspection/run {"account":"*"}
   *   → 对**所有**账号各跑一轮 refetch（真调 GetMetricData、真派 DA 判读）
   *   → 而他直接传 {"account":"<账号B>"} 是会被门禁 403 的
   * ```
   *
   * 即「批量」比「单个」权限更大。旧测试里那句「这个端点没有账号维度的授权，
   * 所以全部账号不放大权限」的前提是错的 —— 单账号那条**是**被门禁管着的。
   */
  const gate = (ids, whatFor) => {
    if (visible === "*") return null;
    if (!visible) {
      return fail("visibility_required",
        "触发巡检必须由路由层提供可见账号集合（这是防越权的硬门）");
    }
    const bad = ids.filter((id) => !visible.has(id));
    if (bad.length) {
      return fail("account_forbidden",
        `${whatFor}里有不可见的账号：${bad.join(", ")}`);
    }
    return null;
  };

  let targets;
  let wantAll = false;
  if (wantList) {
    const ids = [...new Set(wantList.map((a) => String(a || "").trim()))];
    if (!ids.length) return fail("account_required", "accounts 是空数组");
    /**
     * 空串 = **部署账号**，与标量 `account` 完全同一套语义
     * （`resolveAccount` 的空值兜底）。
     *
     * 🔴 前端拿不到部署账号的 12 位 ID：看板的总览是跨账号取的
     * （`getOverview` 在 allAccounts 那条路上返回 `account_id: null`），
     * 而账号选择器第一项一直是 `value=""`。让数组也认空串，比让 UI 去
     * 猜一个 ID 安全 —— 猜错的表现是对**另一个**账号跑一轮并计费。
     *
     * ⚠️ 空串**不过可见性门禁**，与标量那条路一致（门禁那侧
     * `requestedAccount` 为空时直接跳过）。部署账号是系统自己，
     * 把它挡在外面会让受限用户连自己的看板都刷不了。
     */
    const hasSelf = ids.includes("");
    const explicit = ids.filter(Boolean);
    const badShape = explicit.filter((id) => !ACCOUNT_RE.test(id));
    if (badShape.length) {
      return fail("bad_account",
        `accounts 里有不是 12 位数字的项：${badShape.join(", ")}`);
    }
    const g = gate(explicit, "accounts");
    if (g) return g;
    if (hasSelf) {
      const self = await resolveAccount("");
      if (!self) {
        return fail("account_required",
          "解析不出部署账号（STS 可能异常）—— 请改选具体的成员账号");
      }
      // ⚠️ 部署账号排第一，与 `allTriggerTargets()` 同序；去重是因为它可能
      //    也被登记进了成员表（历史数据），重复会让 scheduler 扇出两次。
      targets = [...new Set([self, ...explicit])];
    } else {
      targets = explicit;
    }
  } else {
    const acct = await resolveAccount(accountId);
    if (!acct) return fail("account_required", "缺少 account 参数");
    wantAll = acct === ALL_ACCOUNTS;
    if (wantAll) {
      const all = await allTriggerTargets();
      if (!all.length) {
        return fail("account_required",
          "展开「全部账号」时一个目标都没解析出来 —— STS 与成员账号登记表都取不到");
      }
      // ⚠️ `"*"` 是**取交集**而不是报错：语义是「我能看到的全部账号」。
      //    报错会让一个受限用户完全用不了这个按钮，而他对自己那个账号有权。
      targets = visible === "*" ? all : all.filter((id) => visible?.has(id));
      if (!targets.length) {
        return fail("account_forbidden",
          "「全部账号」展开后没有任何一个在你的可见范围内");
      }
    } else {
      const g = gate([acct], "account");
      if (g) return g;
      targets = [acct];
    }
  }

  const fn = process.env.INSPECTION_SCHEDULER_FUNCTION
    || "notiops-inspection-scheduler";
  try {
    const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
    const payload = {
      manual_trigger: {
        run_type: runType,
        /**
         * 🔴 一次 invoke 带**全部**账号，而不是循环 invoke N 次。
         *
         *    scheduler 那侧本来就按列表扇出
         *    （`[DueRun(manual.run_type, a, now.date()) for a in manual.account_ids]`），
         *    所以这里给数组是它的原生形态。
         *
         *    循环 invoke 的坏处是**部分成功**：第 3 个 invoke 抛
         *    AccessDenied 时前两个已经在跑了，而这个函数只能返回一个结果 ——
         *    要么谎报全失败（客户重试 → 前两个账号各跑两轮，花两倍的钱），
         *    要么谎报全成功。单次 invoke 没有这个中间态。
         */
        account_ids: targets,
        source,
        mode,
        requested_by: actor || "webchat",
      },
    };
    await new LambdaClient({}).send(new InvokeCommand({
      FunctionName: fn,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
    return {
      ok: true,
      // ⚠️ **只有确定是单个账号时**才给 `account_id` —— 前端的轮询逻辑读它，
      //    而一个槽位盯不了 N 个账号（只盯第一个 → 它 5 秒后完成就报
      //    「跑完了」，另外 N-1 个还在跑）。给数组会让「跑单个账号」那条
      //    主路径的进度条永远不完成，给多个里的第一个会假绿。
      account_id: targets.length === 1 ? targets[0] : "",
      // 扇出的完整列表。前端据此显示「已提交 N 个账号」并在 N>1 时跳过轮询。
      account_ids: targets,
      // ⚠️ 语义是「走的是 `"*"` 那条路」，**不是**「跑了多个账号」——
      //    显式多选也可能是多个。前端判「要不要轮询」看的是
      //    `account_ids.length`，不是这个字段。
      all_accounts: wantAll,
      run_type: runType, source, mode,
      // 前端据此轮询 `/inspection/config`（data_dates）与
      // `/inspection/overview`（diff.last_run_date / last_status）。
      // 不返回 run_id：run 的主键是 (run_type, run_date, account)，
      // 日期由 scheduler 那侧的 `now` 决定，BFF 猜出来的可能差一天。
      accepted: true,
    };
  } catch (e) {
    // AccessDeniedException 在这里最常见 —— 缺 InspectionManualRunInvoke
    // 那条 policy。原样回传 code，别让它退化成一句「触发失败」。
    return fail("invoke_failed", String(e?.name || e));
  }
}

/* ───────────────── 资源清单（nav:inspection:resources） ───────────────── */

/**
 * 列举账号下可被排除的资源，并标出**哪些已经在排除清单里**。
 *
 * 这个端点存在的唯一理由：排除清单原先要人**手填** `resource_id` + `region`
 * + `service` + `tier` 四个字段。手填的三个后果都很实际 ——
 * 打错一个字符那条排除永远不生效（而且没有任何提示，因为「排除一个不存在
 * 的资源」在语义上完全合法）；不知道 region 写什么；不知道自己账号里到底
 * 有哪些实例。
 *
 * 🔴 返回里带 `excluded_in`（`["high"]` / `["idle"]` / `["high","idle"]`）。
 *    没有它前端就没法回显勾选态，只能显示一份「全都没勾」的列表 ——
 *    于是用户会重复添加已经排除的资源。**两份清单是独立的**（高负载轮和
 *    闲置轮各一份），所以这里必须是数组而不是布尔。
 *
 * ⚠️ 逐服务 try/catch 各自降级。一个服务的 AccessDenied 不该让整个列表空掉：
 *    表现会是「勾选面板打不开」，而用户其实只是没开 ElastiCache。
 *    降级的服务进 `degraded` 数组，让 UI 能说清「RDS 12 台，ElastiCache 读不到」
 *    而不是假装账号里只有 RDS。
 */
/**
 * 排除清单条目 → 匹配键集合。**语义对齐 `inspection/domain/scope.py`。**
 *
 * 这一层决定资源选择器里哪些行显示「已排除」徽标并 **disable checkbox**，
 * 所以它错的方向决定了后果轻重：
 *
 * ```
 * 过度匹配   UI 说「已排除」但后端照常巡检 → 那台资源从界面上**再也排不掉**
 *            （checkbox 是灰的），而它照常出 finding、照常派 DA、照常花钱
 * 匹配不足   UI 说「没排除」但后端已排除 → 客户重复提交一次，写入幂等，无害
 * ```
 *
 * ⇒ 拿不准时**宁可匹配不足**。下面每一条判据都是照 `scope.py` 抄的，
 *   不是「宁可多提示」那种自由裁量。
 *
 * ## 键的形状：`<层>:<region>#<service>#<resource_id>`
 *
 * ```
 * inst:<reg>#<svc>#<rid>     普通条目（level 不是 cluster/group）
 * cont:<reg>#<svc>#<rid>     level ∈ {cluster, group} —— 要连带成员
 * svc:<reg>#<svc>            resource_id === "*"（整服务）
 * acct:<reg>                 service === "*" 且 resource_id === "*"（整账号）
 * ```
 *
 * 三条历史缺陷，每条都是「键比 scope.py 少一个维度」：
 *
 * 🔴 **少 region**（2026-08-27 修）。原来只用 `resource_id`，注释写着
 *    「tier/region 不同的同名条目会一起被标上，那是刻意的：宁可多提示」。
 *    单 region 下成立，多 region 一开就把功能锁死：客户在 us-east-1 与东京
 *    各有一台 prod-mysql，排掉 us-east-1 那台之后东京那行也被打上徽标 →
 *    再也排不掉，而 `covers_region()` 是按 region 精确匹配的，executor
 *    照常巡检东京那台。客户去清单里只找到一条 us-east-1 的记录，
 *    会以为是清单页显示漏了。
 *
 * 🔴 **少 service**（本次修）。`notiops-tb-redis-*` / `notiops-tb-rds-*`
 *    这种多服务同前缀部署里，同 region 同名的 RDS 与 ElastiCache 会互相
 *    标成已排除 —— 而 `scope.py` 四层索引每一层的键**都**含 service
 *    （`(acct, svc, id)`）。少这一段就是过度匹配，也就是上面那个「再也
 *    排不掉」的形态。
 *
 * 🔴 **不认通配**（本次修）。整账号 / 整服务排除写的是 `resource_id: "*"`，
 *    老代码生成 `*#*` 这种键，而查的是 `<region>#<真实资源名>` ——
 *    **永远不可能相等**。表现是整账号排除在选择器里**零信号**：客户明明
 *    整账号退出了巡检，选择器里每一行都是「未排除」+ checkbox 可勾，
 *    于是又逐台勾一遍（写进去的是一堆冗余条目），而真正生效的是那条
 *    `*` 行。反过来「取消整账号排除」之后也看不出有什么变化。
 *
 * 🔴 **不看过期**（本次修）。`ExclusionIndex.build` 第一件事就是
 *    `if not e.is_active(today): continue`，也就是**过期条目在判定上不生效**
 *    （行保留，客户要能看见「曾经排除过、什么理由、什么时候失效」）。
 *    而这里把过期条目一样算进键里 → 徽标还在、checkbox 还是灰的，
 *    客户看着「已排除」而巡检已经在报它了。这条尤其阴：R1.3 的默认有效期
 *    是 30 天，也就是说**每一条排除都会走到这个状态**。
 *
 * @param entries `shapeExclusion` 出来的条目（要有 `expired` 或 `expires_at`）
 * @param today   `YYYY-MM-DD`。只在条目没带 `expired` 时用来自己算。
 *
 * ⚠️ 抽成纯函数是为了能被单测真的覆盖 —— 留在 `getResources` 里就只有源码
 *    文本断言，而实测过：把这里改回裸 `resource_id` 匹配，BFF 那 75 条
 *    测试全绿。
 */
export const SCOPE_WILDCARD = "*";

/** `scope.py::ScopeLevel` 里会连带成员的两档。 */
const CONTAINER_LEVELS = new Set(["cluster", "group"]);

export function exclusionKeys(entries, { today = "" } = {}) {
  const out = new Set();
  const todayIso = String(today || "");
  for (const ex of entries || []) {
    const rid = String(ex?.resource_id || "").trim();
    if (!rid) continue;
    /* 🔴 过期条目**不参与匹配**（`ExclusionIndex.build` 的第一行）。
       `expired` 由 `shapeExclusion` 算好；没有那个字段时自己按
       `today >= expires_at` 算（与 `is_active` 的 `today < expires_at`
       互为反面，边界那一天算失效）。 */
    if (ex?.expired === true) continue;
    const expiresAt = String(ex?.expires_at || "");
    if (ex?.expired === undefined && expiresAt && todayIso
        && todayIso >= expiresAt) continue;

    const reg = String(ex?.region || "").trim() || SCOPE_WILDCARD;
    const svc = String(ex?.service || "").trim();
    const level = String(ex?.level || "").trim().toLowerCase();

    if (rid === SCOPE_WILDCARD) {
      /* 整账号 = service 也是 `*`；整服务 = service 是具体值。
         ⚠️ service 为空且 rid 为 `*` 的行按整账号算 —— `put_exclusion`
            会拒写这种，但历史行可能是空的，而「不确定它排了多大范围」时
            按大的算会过度匹配。这里反过来：认不出 service 就**不生成键**，
            让那一行在选择器里没有信号，而不是把整个账号锁死。 */
      if (svc === SCOPE_WILDCARD) out.add(`acct:${reg}`);
      else if (svc) out.add(`svc:${reg}#${svc}`);
      continue;
    }
    /* 具体资源。**service 必须有** —— 少了它就退化成跨服务同名匹配，
       也就是上面那条「再也排不掉」。认不出 service 的历史行同样不生成键。 */
    if (!svc) continue;
    out.add(`${CONTAINER_LEVELS.has(level) ? "cont" : "inst"}:${reg}#${svc}#${rid}`);
  }
  return out;
}

/**
 * 这一行资源被哪一层覆盖。**四层判据，与 `scope.py::is_excluded` 同序。**
 *
 * ```
 * 1  instance    这一行自己           inst: / cont: + 精确 resource_id
 * 2  container   它所属的集群/副本组    cont: + row.cluster_id   ← 只认 cont:
 * 3  service     整服务               svc:
 * 4  account     整账号               acct:
 * ""             没被覆盖
 * ```
 *
 * 🔴 **返回层级而不是布尔值**是因为读侧要用它决定说什么话。整账号排除会让
 * 选择器里每一行 checkbox 变灰，而一个只说「已排除」的灰 checkbox 等于
 * 「在界面上摆一个用户无法解决的问题」—— 客户看不出是这一行被排了还是
 * 整账号被排了，也就不知道该去哪儿撤销（前三层在这个弹层里撤不掉，
 * 只能去「巡检范围 → 排除清单」删那一行）。
 *
 * ⚠️ 第 2 层**只查 `cont:`**（level 是 cluster/group 的条目）。查 `inst:`
 *    会让「某台实例名恰好等于另一个集群名」时整个集群被标死 —— 而
 *    `scope.py` 的 `by_container` 索引同样只收 cluster/group 那两档。
 *
 * ⚠️ 两轮 region：先精确、再 `*`。`region` 为空的条目是**跨区域生效**的
 *    老数据（`covers_region()` 的 `return not self.region or ...`）。
 *
 * ⚠️ 层级顺序即优先级，与 `scope.py` 一致（越具体越先返回）—— UI 要显示
 *    最精确那一条的理由。
 */
export function exclusionLayer(row, keys) {
  const rid = String(row?.resource_id || "");
  if (!rid) return "";
  const svc = String(row?.service || "");
  const cluster = String(row?.cluster_id || "");
  const regions = [String(row?.region || ""), SCOPE_WILDCARD];
  for (const reg of regions) {
    if (keys.has(`inst:${reg}#${svc}#${rid}`)) return "instance";
    if (keys.has(`cont:${reg}#${svc}#${rid}`)) return "container";
    if (cluster && keys.has(`cont:${reg}#${svc}#${cluster}`)) return "container";
    if (svc && keys.has(`svc:${reg}#${svc}`)) return "service";
    if (keys.has(`acct:${reg}`)) return "account";
  }
  return "";
}

/**
 * 这一行资源是否被 `keys` 覆盖。
 *
 * ⚠️ 只是 `exclusionLayer` 的布尔壳 —— **不要**在这里再写一份判据。
 *    两份判据分叉的表现是「徽标说整账号排除、而 checkbox 是可勾的」
 *    这种自相矛盾，而两边各自的用例都是绿的。
 */
export function rowIsExcluded(row, keys) {
  return Boolean(exclusionLayer(row, keys));
}


export async function getResources(accountId, { region = "" } = {}) {
  const acct = await resolveAccount(accountId);
  if (!acct) return fail("account_required", "缺少 account 参数");

  const out = [];
  const degraded = [];
  /** 系统自己所在的 region（DDB / 枚举用），**不是**要列资源的 region。 */
  const home = String(process.env.AWS_REGION || "ap-northeast-1").trim();

  // ── 🔴 跨账号必须换凭证 ──
  //
  // 这个函数原来只带 region 建 client，走 Lambda 自身角色 —— 于是选了成员账号
  // 时列出来的是**部署账号**的资源，而每一行的 `account_id` 写着成员账号。
  // 客户照着勾一台 → 写出 `account_id=456 / resource_id=<部署账号的实例>` 的
  // 排除记录 → UI 显示「已排除」，而那条记录永远匹配不到任何真实资源
  // （「排除一个不存在的资源」在语义上完全合法，写侧没有存在性校验）。
  // `degraded` 是空数组，语义是「这个账号里真的只有这些」。
  //
  // 这与 executor 上修过的那条是**同一个缺陷**
  // （见 `lambda_inspection_executor/handler.py::_session_for`）——
  // 那次修了采集侧，这个读侧漏了。
  //
  // ⚠️ 拿不到角色 / assume 失败就**报错**，不退化成列部署账号的资源。
  //    多一个错误提示比一份错账号的清单好 —— 后者会诱导客户写出永不生效的配置。
  let creds;
  const self = await resolveAccount("");
  if (self && acct !== self) {
    const { collectionRoleArn } = await import("./member_accounts.mjs");
    const roleArn = collectionRoleArn(acct, self);
    const { getAssumedCredentialsForAccount } =
      await import("./devops_agent_accounts.mjs");
    creds = await getAssumedCredentialsForAccount(acct, roleArn);
    if (!creds) {
      return fail("cross_account_unavailable",
        `AssumeRole ${roleArn} 失败 —— 无法列出账号 ${acct} 的资源。`
        + "去「管理 → 账户」展开这个账号的「巡检的跨账号前置」，"
        + "确认①采集角色已部署并验证通过。");
    }
  }
  /** 建 client 的公共入参：跨账号时带临时凭证，本账号时不带。 */
  const mkCfg = (reg) =>
    (creds ? { region: reg, credentials: creds } : { region: reg });

  // ── 🔴 要列**哪些 region** ──
  //
  // 这个函数原来只列一个 region：`process.env.AWS_REGION`，也就是 BFF Lambda
  // 自己所在的部署 region。而 `region` 形参**没有任何调用方传** —— 前端调
  // `getInspectionResources` 时不带它。
  //
  // 实测后果（验证账号，2026-08-27）：账号里 4 台 RDS 全在 us-east-1，
  // 而「移出巡检范围」弹层显示「RDS / Aurora 0」+「这个账号里没有可排除的
  // 资源」，`degraded` 是空数组 —— 语义是「账号里真的没有」。
  //
  // 与巡检采集侧（`lambda_inspection_executor`）是**同一个缺陷**。两边必须
  // 一起改：只修采集的话 us-east-1 的 finding 会冒出来，而客户没法把它移出
  // 范围（弹层列不到它）。
  //
  // ⚠️ 显式传 `region` 时只列那一个 —— 那个形参从此真的可用（此前是死参数）。
  let regions = [];
  if (String(region || "").trim()) {
    regions = [String(region).trim()];
  } else {
    try {
      const { EC2Client, DescribeRegionsCommand } =
        await import("@aws-sdk/client-ec2");
      // ⚠️ 枚举用**目标账号的**凭证：opt-in region 是按账号启用的。
      //    用 BFF 自己的凭证会把部署账号的 opt-in 集合套到成员账号上。
      const r = await new EC2Client(mkCfg(home))
        .send(new DescribeRegionsCommand({ AllRegions: false }));
      regions = (r.Regions || [])
        .map((x) => String(x.RegionName || "").trim())
        .filter(Boolean)
        .sort();
    } catch (e) {
      // 🔴 枚举失败**不静默回落到部署 region** —— 那正是这次修的缺陷本体，
      //    而回落之后界面显示的仍然是「这个账号里没有可排除的资源」。
      //    退回单 region 但把原因写进 degraded，让 UI 能说出「只看了 1 个
      //    region」而不是「没有资源」。
      regions = [home];
      degraded.push({
        service: "regions", region: home,
        reason: `DescribeRegions 失败（${String(e?.name || e)}）—— `
          + `只列了 ${home}，其余 region 的资源没有出现在这份清单里`,
      });
    }
  }
  if (!regions.length) regions = [home];

  /** 列一个 region 的资源。失败只降级这一个 region，不影响其余。 */
  async function collectRegion(reg) {
  const cw = mkCfg(reg);

  // ── RDS 实例 + Aurora 集群 ──
  try {
    const { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand } =
      await import("@aws-sdk/client-rds");
    const rds = new RDSClient(cw);
    let marker;
    do {
      const r = await rds.send(new DescribeDBInstancesCommand({ Marker: marker }));
      for (const db of r.DBInstances || []) {
        out.push({
          service: "rds", tier: "instance", region: reg,
          resource_id: db.DBInstanceIdentifier,
          label: db.DBInstanceIdentifier,
          klass: db.DBInstanceClass || "",
          engine: `${db.Engine || ""} ${db.EngineVersion || ""}`.trim(),
          // cluster 归属：选 cluster 层排除时要连同成员一起排，UI 需要这个
          // 才能提示「这台属于集群 X，按集群排会连带 3 台」。
          cluster_id: db.DBClusterIdentifier || "",
          status: db.DBInstanceStatus || "",
        });
      }
      marker = r.Marker;
    } while (marker);

    let cmarker;
    do {
      const r = await rds.send(new DescribeDBClustersCommand({ Marker: cmarker }));
      for (const c of r.DBClusters || []) {
        out.push({
          service: "rds", tier: "cluster", region: reg,
          resource_id: c.DBClusterIdentifier,
          label: c.DBClusterIdentifier,
          klass: "", engine: `${c.Engine || ""} ${c.EngineVersion || ""}`.trim(),
          cluster_id: "", status: c.Status || "",
          member_count: (c.DBClusterMembers || []).length,
        });
      }
      cmarker = r.Marker;
    } while (cmarker);
  } catch (e) {
    degraded.push({ service: "rds", region: reg,
                    reason: String(e?.name || e) });
  }

  // ── ElastiCache 副本组 ──
  // 用副本组而不是节点：巡检的 EC 规则判在副本组层（见
  // inspection/adapters/attrs_repo.py 的 load_elasticache_attrs），
  // 列节点会让用户勾了一个节点却发现整组还在被巡检。
  try {
    const { ElastiCacheClient, DescribeReplicationGroupsCommand } =
      await import("@aws-sdk/client-elasticache");
    const ec = new ElastiCacheClient(cw);
    let marker;
    do {
      const r = await ec.send(new DescribeReplicationGroupsCommand({ Marker: marker }));
      for (const g of r.ReplicationGroups || []) {
        out.push({
          service: "elasticache", tier: "cluster", region: reg,
          resource_id: g.ReplicationGroupId,
          label: g.ReplicationGroupId,
          klass: g.CacheNodeType || "",
          engine: g.Engine || "",
          cluster_id: "", status: g.Status || "",
          member_count: (g.MemberClusters || []).length,
        });
      }
      marker = r.Marker;
    } while (marker);
    // ── 没有副本组的集群（Memcached、单节点 Redis）──
    //
    // 🔴 判定侧的主循环是 `for c in clusters`（`load_elasticache_attrs`），
    //    `instance_id` 就是 `CacheClusterId`。副本组下的节点靠
    //    `cluster_id=rgid` 被集群级排除覆盖，所以上面那份组列表够用；
    //    但 **Memcached 没有 ReplicationGroupId**，永远进不了那份列表。
    //
    //    表现：客户在面板里找不到那台 Memcached，而 `total` 与空的 `degraded`
    //    联合表示「账号里就这些」。想排除它只能回到手填 —— 而手填入口已经
    //    按「有面板了」的前提被收窄。`rule_limits` 里整整一组 MEMCACHED 字段
    //    说明它确实在判定范围内。
    //
    // ⚠️ 已归属副本组的节点要跳过，否则同一组会重复列出（组 + 每个节点）。
    // ⚠️ 不传 `ShowCacheNodeInfo` —— 只需要 id / 类型 / 引擎，节点明细白花配额。
    let cmarker;
    do {
      const { DescribeCacheClustersCommand } =
        await import("@aws-sdk/client-elasticache");
      const r = await ec.send(new DescribeCacheClustersCommand({ Marker: cmarker }));
      for (const c of r.CacheClusters || []) {
        if (c.ReplicationGroupId) continue;      // 已在上面按组列出
        out.push({
          service: "elasticache", tier: "instance", region: reg,
          resource_id: c.CacheClusterId,
          label: c.CacheClusterId,
          klass: c.CacheNodeType || "",
          engine: `${c.Engine || ""} ${c.EngineVersion || ""}`.trim(),
          cluster_id: "", status: c.CacheClusterStatus || "",
          member_count: c.NumCacheNodes || 1,
        });
      }
      cmarker = r.Marker;
    } while (cmarker);
  } catch (e) {
    degraded.push({ service: "elasticache", region: reg,
                    reason: String(e?.name || e) });
  }
  }   // ← collectRegion 结束

  // ⚠️ **并发**跑。串行 17 个 region × 4 次 describe 会撞 API Gateway 的
  //    30 秒上限，而超时的表现是前端一个 504 —— 与「账号里没有资源」一样
  //    什么都看不出来。零资源的 region 只花 2 次 describe，很快返回。
  await Promise.all(regions.map((r) => collectRegion(r)));

  // 🔴 **不列 EC2。** 资源巡检只覆盖 RDS 与 ElastiCache ——
  //    `inspection/pipeline.py::load_resources` 只调
  //    `load_rds_attrs_with_groups` 与 `load_elasticache_attrs`；
  //    EC2 在这套里唯一的用途是 `ec2:DescribeInstanceTypes`
  //    （给 RDS/EC 的规格名查内存大小）。
  //
  //    第一版把 EC2 列进来了，那正是这个端点要消除的那种缺陷：
  //    勾一台 EC2 会写出一条**语义合法但永不匹配**的排除记录，
  //    UI 显示「已排除」而巡检压根不看它 —— 比手填打错更难发现，
  //    因为界面反馈是成功的。
  //
  //    要支持 EC2 得先让采集端覆盖它，那是另一件事。

  // ── 标注已排除 ──
  // 两份清单独立，所以是 Set 的并集查询而不是一次。
  const excluded = { high: new Set(), idle: new Set() };
  try {
    /* 🔴 **只取这个账号的排除条目。** `exclusionKeys` 的键里**没有账号**
       （是 `<层>:<region>#<service>#<id>`，账号靠这里的查询范围保证），
       所以拿全组织的清单来标的表现是：另一个账号里同名的资源把这一行标成
       「已排除」+ checkbox disabled → 那台资源从界面上**再也排不掉**，
       而后端照常巡检它、照常花 GetMetricData 的钱。
       `notiops-tb-*` 这种多账号同名部署一撞就中。

       ⚠️ 账号**不进键**是刻意的：进了键之后这里传错范围就不再有后果，
          而「传全组织的清单」这个错误会静默地变成正确 —— 于是下一个人
          很容易把 `visible` 放宽，而那才是越权读的入口。

       ⚠️ `visible` 传 `Set([acct])` 而不是 `"*"`：`acct` 在路由层已经过了
          账号可见性门禁，这里给一个**最小**集合，免得将来有人照着
          `"*"` 抄到一个没过门禁的调用点上。 */
    const scope = await getScope({ account: acct, visible: new Set([acct]) });
    if (scope.ok !== false) {
      for (const kind of ["high", "idle"]) {
        /* ⚠️ 传 `today` 是**兜底**：`getScope` 的条目已经带算好的 `expired`，
           但这里不假设它一定在（将来若有别的调用点直接喂原始 DDB item，
           少了这个参数就会把过期条目算进去，而那是静默的）。 */
        for (const key of exclusionKeys(scope.exclusions?.[kind] || [],
          { today: isoDaysAgo(0) })) {
          excluded[kind].add(key);
        }
      }
    }
  } catch { /* 读不到排除清单不该让资源列表打不开 */ }

  for (const r of out) {
    /* `excluded_in` 决定 checkbox 灰不灰；`excluded_by` 决定灰的时候说什么话。
       🔴 少了 `excluded_by`，整账号 / 整服务 / 集群级排除在这个弹层里就是
          一个说「已排除」的灰 checkbox，而客户在这个弹层里**撤不掉它** ——
          得去「巡检范围 → 排除清单」删那一行。不说清是哪一层就等于
          在界面上摆一个用户无法解决的问题。 */
    r.excluded_by = {};
    for (const k of ["high", "idle"]) {
      const layer = exclusionLayer(r, excluded[k]);
      if (layer) r.excluded_by[k] = layer;
    }
    r.excluded_in = ["high", "idle"].filter((k) => r.excluded_by[k]);
  }

  // ⚠️ 排序里加 `region`：不加的话两个 region 的同名资源永远相邻，而它们的
  //    label 逐字相同，客户只能靠第二行小字里的 region 分辨 —— 相邻更容易
  //    被当成重复项。按 region 分组更好读。
  out.sort((a, b) => a.service.localeCompare(b.service)
    || a.tier.localeCompare(b.tier)
    || String(a.region).localeCompare(String(b.region))
    || String(a.label).localeCompare(String(b.label)));

  return {
    ok: true, account_id: acct,
    // 🔴 回**扫过的 region 列表**，不是单个 region。
    //    前端的空态文案要靠它才能说真话：「这 17 个 region 里都没有 RDS /
    //    ElastiCache」与「只看了 ap-northeast-1」是完全不同的结论，而在这
    //    之前界面一律显示前者。
    regions,
    total: out.length, resources: out,
    // 空数组也要回：前端据此区分「账号里真的没有资源」与「权限不够」。
    degraded,
  };
}

/* ───────────── 按需判读：给一条 finding 派一次 DA 调查（action:inspection:run） ───────────── */

/**
 * 给**单条 finding** 派一次 DA 判读，用写好的 `inspection-cost-idle` /
 * `inspection-high-load` skill。
 *
 * ## 为什么要有这个端点
 *
 * 闲置轮设计上不派 DA（`gating.DETERMINISTIC_RUN_TYPES = {"idle"}`）——
 * 批量语境下那是对的。但它让 `cost-idle` 那份 skill 的 idle 那一半成了死代码，
 * 而那份 skill 回答的正是客户唯一真正关心的问题：这台是真闲，
 * 还是**有理由地**闲着（standby 备库 / 月末批量 / 预热缓存 / 已停机）。
 *
 * ## 与「深度调查（直连）」的区别
 *
 * ```
 * 直连          聊天页的工具，**绑在会话所选账号**上（那套工具不收账号号入参）
 *               结果流在聊天里，两天后就翻不到了
 * 本端点        走 executor Lambda → 每个账号自己 assume
 *               结果绑在**那条 finding** 上（put_dispatch 是回拼锚点），
 *               下次打开详情面板还在，报告里也带
 * ```
 *
 * 🔴 **同步** invoke（`RequestResponse`）。整条在 executor 里是 1 次 GetItem
 *    + 1 次 query + 1 次 describe + 1 次 CreateBacklogTask，远在 Function URL
 *    的 30 秒上限之内。同步的价值是能把「已经派过了」「缺巡检 space id」
 *    这类**可操作**的原因直接回给客户 —— 异步只能回一句「已提交」，
 *    然后让人自己猜为什么没结果。
 *
 * ⚠️ 门禁沿用 `action:inspection:run`：那个能力节点的定义就是「唯一能被前端
 *    请求直接花钱的巡检端点」，而这条同样花 DA 额度。给它单开一个节点会让
 *    三个预置角色都要改，而语义上它与「手动跑一轮」是同一类权限。
 */
export async function judgeFinding(accountId, body, { actor = "" } = {}) {
  const b = body || {};
  const findingId = String(b.finding_id || "").trim();
  if (!findingId) return fail("bad_request", "缺 finding_id");

  // ⚠️ 账号解析走同一个 `resolveAccount`（空值兜底成部署账号）——
  //    不复用它的表现是这个端点对「部署账号」这个默认选项不工作。
  const acct = await resolveAccount(accountId);
  if (!acct) return fail("account_required", "缺少 account 参数");
  // 🔴 `"*"`（全部账号哨兵）在这里**没有意义**：判读是针对一条具体 finding 的。
  //    不挡的话它会被当成账号号去查，`get_finding_item` 返回空 →
  //    报「finding 不存在」，而真正的原因是账号选择器停在「全部账号」上。
  if (acct === ALL_ACCOUNTS) {
    return fail("bad_request",
      "判读要针对一个具体账号 —— 顶部账号选择器不能停在「全部账号」上");
  }

  /**
   * 运维手填的一句背景，可选。
   *
   * ⚠️ 长度上限与 Python 侧的 `payload.OPERATOR_NOTE_LIMIT` **必须一致**。
   *    这里松那边紧的表现是：客户输入 1500 字，前端与 BFF 都放过，
   *    到 `validate_payload` 才被拒 —— 而那条错误信息要穿过 Lambda 回到界面，
   *    客户看到的是一句长长的契约层报错。在这里拒能给出人话。
   *    ⚠️ 两侧数值由 `tests/test_inspection_manual_judge.py` 的元断言钉住。
   */
  const note = String(b.note || "").trim();
  if (note.length > OPERATOR_NOTE_LIMIT) {
    return fail("bad_request",
      `备注最多 ${OPERATOR_NOTE_LIMIT} 个字符（收到 ${note.length}）。`
      + "它会随判读请求一起发给 DA，太长会顶穿任务描述的长度上限。");
  }

  const fn = process.env.INSPECTION_EXECUTOR_FUNCTION
    || "notiops-inspection-executor";
  let payload;
  try {
    const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
    const r = await new LambdaClient({}).send(new InvokeCommand({
      FunctionName: fn,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({
        manual_judge: {
          account_id: acct,
          finding_id: findingId,
          operator_note: note,
          requested_by: actor || "webchat",
        },
      })),
    }));
    // ⚠️ `FunctionError` 要单独看：Lambda 里抛异常时 HTTP 仍是 200，
    //    payload 里是 `{errorType, errorMessage}`。不看这个字段的表现是
    //    把一段 Python traceback 当成正常结果解析 → `ok` 为 undefined →
    //    前端显示「派发失败」而拿不到任何原因。
    const text = Buffer.from(r.Payload || []).toString("utf8");
    if (r.FunctionError) {
      console.error("[judge] executor 异常:", text.slice(0, 400));
      return fail("invoke_failed",
        "判读派发失败（executor 内部错误）—— 看 notiops-inspection-executor 的日志");
    }
    payload = JSON.parse(text || "{}");
  } catch (e) {
    // AccessDeniedException 在这里最常见 —— 缺 `InspectionManualRunInvoke`
    // 那条 policy 里 executor 那一项。原样回传 code，别退化成一句「失败」。
    return fail("invoke_failed", String(e?.name || e));
  }

  // executor 那侧**从不抛**，失败都落成 `{ok:false, code, message}`。
  // ⚠️ 原样透传它的 code 与 message：`already_dispatched` / `kill_switch` /
  //    `not_found` / `conflict` 各自对应一句不同的、可操作的话，
  //    合成一句「派发失败」等于把那些话全丢掉。
  if (!payload || payload.ok !== true) {
    return fail(String(payload?.code || "judge_failed"),
                String(payload?.message || "判读派发失败"));
  }
  return {
    ok: true,
    account_id: acct,
    finding_id: findingId,
    task_id: String(payload.task_id || ""),
    agent_space_id: String(payload.agent_space_id || ""),
    // 前端据此显示「已派发」并给出 DA 后台链接；判读全文回来之后
    // 由 `getFinding` 的 `da_body` 承载（callback 那侧零改动）。
    accepted: true,
  };
}

/**
 * `operator_note` 的字符上限。
 *
 * 🔴 **必须与 `inspection/domain/payload.py::OPERATOR_NOTE_LIMIT` 相同。**
 *    两侧分叉的表现见 `judgeFinding` 里那段说明。
 */
export const OPERATOR_NOTE_LIMIT = 1000;
