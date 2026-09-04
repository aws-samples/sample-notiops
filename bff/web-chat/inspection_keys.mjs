/**
 * `notiops-inspection` 表的键前缀 —— **Python 侧 `inspection/adapters/keys.py` 的镜像**。
 *
 * ## 为什么要复制一份而不是共享
 *
 * BFF 是 Node，巡检的 store 是 Python（1000+ 行的 `InspectionStore`）。
 * 跨语言共享不可能，所以只能复制**键的定义**这一小块。
 *
 * ## 复制带来的风险与对策
 *
 * 两处各存一份前缀，迟早会分叉。分叉的表现是**静默的**：
 * 看板按 `inspfind#` 查，而 Python 侧改成了别的，于是看板永远空 —— 不报错。
 *
 * 对策是两条断言，`tests/inspection.test.mjs` 里各一条：
 *   ① 本文件的前缀集合与 `keys.py` 的 `Prefix` 枚举**逐字相同**
 *      （直接读那个 .py 文件正则提取，不靠人工同步）
 *   ② 任何两个前缀不得互为前缀（`keys.py::assert_prefixes_disjoint` 的镜像）
 *
 * ⚠️ 第 ② 条不是多余的：`inspdispatch#` 曾差点写成 `inspfind#dispatch#`，
 * 那会让 `begins_with("inspfind#")` 把派发映射行一起扫进 finding 列表 ——
 * 看板上会出现几条没有 severity、没有 state 的「幽灵 finding」。
 */

export const SEP = "#";

/** 全部 PK 前缀。**顺序与 keys.py 的 `Prefix` 枚举一致**（断言 ① 依赖它）。 */
export const PREFIX = Object.freeze({
  SERIES: "inspseries#",
  RUN: "insprun#",
  FINDING: "inspfind#",
  SCOPE: "inspscope#",
  TARGET: "insptarget#",
  CHAT: "inspchat#",
  // 每条 finding 的推送状态（R11b.5 的退避重推）。BFF 目前不读它 ——
  // 列在这里是因为断言 ① 要求两侧的前缀集合**逐字相等**：少一个会让
  // `assertPrefixesDisjoint()` 漏检一个真实存在的前缀，而那正是
  // 「begins_with 扫出别的行」那类 bug 的来源。
  PUSH: "insppush#",
  // 补齐重投的次数账本（R13.15）。**必须独立于 run 分区** —— 写在 run 行上
  // 会在「缺整行」的场景建出一条没有 status 的桩行，那条桩行会占死当天的
  // run 锁、并让缺行缺口从指标上消失。见 keys.py 的 Prefix.BACKFILL。
  BACKFILL: "inspbf#",
  SKILL_NOTE: "inspnote#",
  CONFIG_VERSION: "cfgver#",
  SCHEDULE: "inspsched#",
  DISPATCH: "inspdispatch#",
  DATA_BATCH: "inspbatch#",
});

export function allPrefixes() {
  return Object.values(PREFIX);
}

/** `keys.py::assert_prefixes_disjoint` 的镜像。互为前缀即抛。 */
export function assertPrefixesDisjoint() {
  const ps = allPrefixes();
  for (const a of ps) {
    for (const b of ps) {
      if (a === b) continue;
      if (a.startsWith(b) || b.startsWith(a)) {
        throw new Error(
          `键前缀 ${a} 与 ${b} 互为前缀 —— begins_with 查询会互相串行（R14.1b）`);
      }
    }
  }
}

export const MISSING = "-";

export function seriesPk(accountId, region, service, instanceId) {
  return PREFIX.SERIES + [accountId, region, service, instanceId].join(SEP);
}

export function runPk(runType, runDate) {
  return PREFIX.RUN + [runType, runDate].join(SEP);
}

export function findingPk(accountId) {
  return PREFIX.FINDING + accountId;
}

/**
 * 跨账号统一视图的 GSI1 分区键。**必须与 Python 侧
 * `inspection/adapters/keys.py::FINDING_GSI1PK` 逐字一致。**
 *
 * 🔴 看板的语义是「今天我要处置什么」—— 跨账号一起按严重度排。而主键是
 * `inspfind#<账号>`，读侧必须先选账号，于是账号选择器从「筛选」退化成
 * 「决定加载哪个分区」。GSI1 让一次 Query 拿到全部账号。
 *
 * ⚠️ 写侧在 Python（`_finding_to_item`），读侧在这里 —— 两边对不上的表现是
 * 统一视图**永远是空的**，而查询成功、不报错。
 * `tests/test_inspection_cross_view.py` 逐字比对两侧。
 */
export const FINDING_GSI1PK = "inspfind";
export const FINDING_GSI1_INDEX = "GSI1";

export function scopePk(kind) {
  if (kind !== "high" && kind !== "idle") {
    throw new Error(`排除清单只有 high / idle 两份，收到 ${kind}`);
  }
  return PREFIX.SCOPE + kind;
}

export function targetPk(kind) {
  if (kind !== "high" && kind !== "idle") {
    throw new Error(`巡检范围只有 high / idle 两份，收到 ${kind}`);
  }
  return PREFIX.TARGET + kind;
}

/** 定时配置的唯一 PK。SK 是 `high` / `idle`。 */
export const SCHEDULE_PK = PREFIX.SCHEDULE + "config";

export function dataBatchPk(accountId) {
  return PREFIX.DATA_BATCH + accountId;
}

export function configVersionPk(service, ruleType) {
  return PREFIX.CONFIG_VERSION + [service, ruleType].join(SEP);
}

/** 两类巡检轮次。与 `schedule.py::RunType` 一致。 */
export const RUN_TYPES = Object.freeze(["high", "idle"]);

/** 四档严重度，**降序**。与 `dto.py::Severity` 的 `_SEVERITY_ORDER` 一致。 */
export const SEVERITIES = Object.freeze(["CRITICAL", "HIGH", "MEDIUM", "INFO"]);
