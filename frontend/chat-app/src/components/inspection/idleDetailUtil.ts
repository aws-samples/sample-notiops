/**
 * 闲置详情抽屉（2026-10 第三版「结论先行」）用的纯函数。
 *
 * 抽屉的阅读顺序是「省多少 → 为什么 → 怎么做 → 算法细节」。这里负责把库里的
 * 数字翻成那几段话：一句结论、每一维一行带白话解释的依据、按服务写好的处置步骤，
 * 以及把 DA 判读正文（`label: value` 信封）拆成结构化字段。
 *
 * ⚠️ 单独成文件：组件文件只导出组件（react-refresh 的约定）。
 */

import type { FindingRow, IdleFactor } from "../../api/inspection";
import { idleFactorText, verdictLabel } from "./format";

// ---------------------------------------------------------------------------
// DA 判读正文 → 结构化字段
// ---------------------------------------------------------------------------

export interface JudgmentAction {
  action: string;
  /** `yes` / `no` / `unknown` / ""（DA 没给）。 */
  downtime: string;
  approval: string;
  caveats: string;
}

export interface ParsedJudgment {
  verdict: string;
  disposition: string;
  idleReason: string;
  summary: string;
  evidence: string[];
  actions: JudgmentAction[];
  /** 以下四个只有 high-load skill 会给（`inspection/skills/high-load/SKILL.md`）。 */
  rootCause: string;
  blastRadius: string;
  /** AI 对严重度定级的异议。skill 规定「不同意才写」，所以空串 = 认可。 */
  severityDispute: string;
  changeAttribution: string;
}

/** 单值字段：顶层 `key:` → 结构里的哪个属性（续行接在它后面）。 */
const SCALAR: Record<string, keyof Pick<ParsedJudgment,
  "verdict" | "disposition" | "idleReason" | "summary" | "rootCause" | "blastRadius"
  | "severityDispute" | "changeAttribution">> = {
  verdict: "verdict", disposition: "disposition", idle_reason: "idleReason",
  summary: "summary", root_cause_hypothesis: "rootCause", blast_radius: "blastRadius",
  severity_dispute: "severityDispute", change_attribution: "changeAttribution",
};
const PROSE = new Set([
  "summary", "root_cause_hypothesis", "blast_radius", "severity_dispute", "change_attribution",
]);

/** 去掉行内 markdown 记号（`**粗**` / `__粗__` / `` `代码` ``），保留文字本身。 */
function plainInline(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

/** 中文与中文之间续行不加空格，英文之间加一个。 */
function joinCont(a: string, b: string): string {
  if (!a) return b;
  const cjk = /[\u3000-\u9fff\uff00-\uffef]/;
  return cjk.test(a.slice(-1)) || cjk.test(b[0] ?? "") ? a + b : `${a} ${b}`;
}

function setActionField(a: JudgmentAction, key: string, value: string) {
  const v = value.trim();
  if (key === "action") a.action = v;
  else if (key === "downtime") a.downtime = v.toLowerCase();
  else if (key === "approval_or_window") a.approval = v.toLowerCase();
  else if (key === "caveats") a.caveats = v;
}

/**
 * 把判读 skill 的输出信封拆开（cost-idle 与 high-load 两份 SKILL.md 共用这套格式，
 * high-load 多出 `root_cause_hypothesis` / `blast_radius` / `change_attribution` /
 * `severity_dispute` 四个单值字段）。
 *
 * ```
 * verdict: real_degradation
 * disposition: verify_owner
 * idle_reason: genuinely_unused
 * summary: …（可续行）
 * evidence:
 * - …
 * recommended_action:
 * - action: …
 *   downtime: yes
 *   approval_or_window: yes
 *   caveats: …
 * ```
 *
 * 🔴 **拆不出来就返回 `null`**，调用方照原样渲染全文。判据是「有 summary 或至少
 *    一条 action」—— 只认出一个 verdict 的正文（老格式、`**verdict**:` 加粗写法、
 *    纯散文）不算结构化，硬拆会把一大段话丢掉。
 */
export function parseJudgment(body: string | null | undefined): ParsedJudgment | null {
  const out: ParsedJudgment = {
    verdict: "", disposition: "", idleReason: "", summary: "", evidence: [], actions: [],
    rootCause: "", blastRadius: "", severityDispute: "", changeAttribution: "",
  };
  let cur = "";
  let act: JudgmentAction | null = null;
  for (const raw of (body || "").replace(/\r\n/g, "\n").split("\n")) {
    if (!raw.trim() || /^#{1,6}\s/.test(raw)) continue;

    const top = /^([a-z_]+):\s*(.*)$/.exec(raw);
    if (top) {
      cur = top[1];
      act = null;
      const v = top[2].trim();
      if (SCALAR[cur]) out[SCALAR[cur]] = v;
      else if (cur === "evidence" && v) out.evidence.push(v);
      continue;
    }

    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && cur === "evidence") { out.evidence.push(item[1].trim()); continue; }
    if (item && cur === "recommended_action") {
      act = { action: "", downtime: "", approval: "", caveats: "" };
      out.actions.push(act);
      const kv = /^([a-z_]+):\s*(.*)$/.exec(item[1]);
      if (kv) setActionField(act, kv[1], kv[2]);
      else act.action = item[1].trim();
      continue;
    }

    const sub = /^\s+([a-z_]+):\s*(.*)$/.exec(raw);
    if (sub && cur === "recommended_action" && act) {
      setActionField(act, sub[1], sub[2]);
      continue;
    }

    // 续行：接到上一个字段后面
    const text = raw.trim();
    // ⚠️ 只有散文字段收续行。枚举字段（verdict / disposition / idle_reason）后面
    //    冒出来的杂行接上去会让译名查不到，宁可丢掉那一行。
    if (PROSE.has(cur)) out[SCALAR[cur]] = joinCont(out[SCALAR[cur]], text);
    else if (cur === "evidence" && out.evidence.length) {
      out.evidence[out.evidence.length - 1] = joinCont(out.evidence[out.evidence.length - 1], text);
    } else if (cur === "recommended_action" && act) act.action = joinCont(act.action, text);
  }
  out.actions = out.actions.filter((a) => a.action);
  // 🔴 这些字段渲染在纯文本节点里，skill 偶尔会在里面写 markdown 加粗 / 行内代码
  //    （实机：「但这是**空缓存的度量伪影**」）—— 星号会字面显示给客户看。
  for (const k of ["summary", "rootCause", "blastRadius", "severityDispute",
    "changeAttribution"] as const) out[k] = plainInline(out[k]);
  out.evidence = out.evidence.map(plainInline);
  for (const a of out.actions) { a.action = plainInline(a.action); a.caveats = plainInline(a.caveats); }
  return out.summary || out.actions.length ? out : null;
}

// ---------------------------------------------------------------------------
// 判读的标签（闲置语境）
// ---------------------------------------------------------------------------

/**
 * verdict 在**闲置**语境下的说法。
 *
 * 🔴 共享枚举 `real_degradation` 的通用译名是「确有劣化」—— 放在一条闲置 finding
 *    上读不通（客户截图：「确有劣化」挂在一台空 Redis 上）。cost-idle skill 对它的
 *    定义是「genuinely under-used — the saving is real」，所以这里叫「确认闲置」。
 *    其余两档沿用通用译名。
 */
export function idleVerdictLabel(
  verdict: string, t: (k: string) => string, zh: boolean,
): string {
  if (verdict === "real_degradation") return zh ? "确认闲置" : "Confirmed idle";
  if (verdict === "expected_behaviour") return zh ? "闲置有正当理由" : "Idle for a reason";
  return verdictLabel(verdict, t);
}

const IDLE_REASON: Record<string, { zh: string; en: string }> = {
  genuinely_unused: { zh: "没人在用", en: "unused" },
  standby_replica: { zh: "备用副本", en: "standby replica" },
  periodic_workload: { zh: "周期性负载", en: "periodic workload" },
  warmed_cache: { zh: "预热的缓存", en: "warmed cache" },
  stopped_instance: { zh: "实例已停止", en: "stopped" },
  reader_fanout: { zh: "读副本分流", en: "reader fan-out" },
};

/** `unknown` / 认不出 → 空串（不显示，比显示一个机器值好）。 */
export function idleReasonLabel(reason: string, zh: boolean): string {
  const r = IDLE_REASON[reason];
  return r ? (zh ? r.zh : r.en) : "";
}

const DISPOSITION: Record<string, { zh: string; en: string }> = {
  verify_owner: { zh: "先确认归属", en: "verify with the owner" },
  delete: { zh: "可以删除", en: "safe to delete" },
  downsize: { zh: "可以降配", en: "downsize" },
  leave_alone: { zh: "保持现状", en: "leave alone" },
};

export function dispositionLabel(d: string, zh: boolean): string {
  const r = DISPOSITION[d];
  return r ? (zh ? r.zh : r.en) : "";
}

// ---------------------------------------------------------------------------
// 判定依据：每一维一行 + 一句白话
// ---------------------------------------------------------------------------

export interface SignalRow {
  key: string;
  label: string;
  value: string;
  hint: string;
  /** 这一维没参与评分（缺数据 / 不适用）—— 灰显。 */
  off?: boolean;
}

/** 依据列表里的维度名。与评分明细的列名（`IDLE_DIM`）分开：这里是给人读的说法。 */
const SIGNAL_LABEL: Record<string, { zh: string; en: string }> = {
  cpu: { zh: "CPU 均值", en: "Avg CPU" },
  connections: { zh: "连接数（日均）", en: "Connections (avg)" },
  storage: { zh: "可用存储", en: "Free storage" },
  iops: { zh: "读写 IOPS", en: "Read/write IOPS" },
  memory: { zh: "内存已用", en: "Memory used" },
  requests: { zh: "请求数", en: "Requests" },
};

/** 归一化值越接近 1 越闲（各维都已换成「越大越闲」的口径，见 scoring/idle.py）。 */
function hintFor(name: string, n: number | null, zh: boolean): string {
  if (n === null || !Number.isFinite(n)) return "";
  const pick = (hi: [string, string], mid: [string, string], lo: [string, string]) => {
    const p = n >= 0.95 ? hi : n >= 0.8 ? mid : lo;
    return zh ? p[0] : p[1];
  };
  switch (name) {
    case "cpu": return pick(["几乎空转", "almost no load"], ["负载很低", "very light"], ["有一定负载", "some load"]);
    case "memory": return pick(["基本是空的", "nearly empty"], ["占用很少", "light"], ["有一定占用", "some usage"]);
    case "requests": return pick(["没有读写", "no traffic"], ["请求很少", "very few"], ["有一定请求", "some traffic"]);
    case "connections": return pick(["几乎没有连接", "almost none"], ["连接很少", "very few"], ["有一定连接", "some connections"]);
    case "iops": return pick(["几乎没有读写", "almost no I/O"], ["读写很少", "light I/O"], ["有一定读写", "some I/O"]);
    case "storage":
      // ⚠️ 这一维的 n 就是「剩余 / 分配」本身（不是 1 - 占用）。
      return n >= 0.8 ? (zh ? "分配的存储大多没用上" : "mostly unused")
        : n >= 0.5 ? (zh ? "一半以上空着" : "over half free")
          : (zh ? "大部分在用" : "mostly in use");
    default: return "";
  }
}

/** 一维的实测值（展示用）。 */
function valueFor(f: IdleFactor, zh: boolean): string {
  // 🔴 存储那一维**实测字节没有落库**（observed 恒为 null），但归一化值就是
  //    「剩余 / 分配」—— 直接换成百分比。原来这一行显示「—」，客户以为没采到。
  if (f.name === "storage" && f.observed === null && typeof f.normalized === "number") {
    return `${(f.normalized * 100).toFixed(1)}%`;
  }
  const v = idleFactorText(f, zh).observed;
  if (!v) return "—";
  return f.name === "requests" ? (zh ? `${v} / 分钟` : `${v} / min`) : v;
}

export function signalRows(f: FindingRow, zh: boolean): SignalRow[] {
  const rows: SignalRow[] = [...(f.idle_factors ?? [])]
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
    .map((x) => ({
      key: x.name,
      label: SIGNAL_LABEL[x.name]?.[zh ? "zh" : "en"] ?? x.name,
      value: valueFor(x, zh),
      hint: hintFor(x.name, typeof x.normalized === "number" ? x.normalized : null, zh),
    }));
  for (const d of f.idle_degraded ?? []) {
    rows.push({
      key: `off-${d}`,
      label: SIGNAL_LABEL[d]?.[zh ? "zh" : "en"] ?? d,
      value: zh ? "无数据" : "no data",
      hint: zh ? "未计入评分" : "not scored",
      off: true,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 一句结论
// ---------------------------------------------------------------------------

const PHRASE: Record<string, { zh: string; en: string }> = {
  cpu: { zh: "CPU 长期接近零", en: "CPU near zero" },
  memory: { zh: "内存基本没用", en: "memory barely used" },
  requests: { zh: "没有请求", en: "no requests" },
  connections: { zh: "几乎没有连接", en: "almost no connections" },
  iops: { zh: "几乎没有读写", en: "almost no I/O" },
  storage: { zh: "存储大量空着", en: "storage mostly free" },
};

export function summaryLine(f: FindingRow, zh: boolean): string {
  if (f.rule === "oversized_storage") {
    return zh ? "分配的存储远大于实际占用，容量审计判定为存储超配。"
      : "Provisioned storage is far above what is used; flagged by the capacity audit.";
  }
  if (f.rule === "oversized_memory") {
    return zh ? "节点内存远大于实际占用，容量审计判定为内存超配。"
      : "Node memory is far above what is used; flagged by the capacity audit.";
  }
  if (f.idle_score === null) {
    return zh ? "判据不足，没有算出闲置分。展开下方评分明细看缺了哪些维度。"
      : "Not enough data to score. See the breakdown below for what is missing.";
  }
  const phrases = [...(f.idle_factors ?? [])]
    .filter((x) => typeof x.normalized === "number" && x.normalized >= 0.9 && PHRASE[x.name])
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
    .slice(0, 3)
    .map((x) => PHRASE[x.name][zh ? "zh" : "en"]);
  const score = Math.round(f.idle_score);
  const tail = zh ? `规则评分 ${score} / 100，判定为闲置。` : `Rule score ${score}/100: idle.`;
  if (!phrases.length) return tail;
  return zh ? `${phrases.join("，")}。${tail}` : `${phrases.join(", ")}. ${tail}`;
}

// ---------------------------------------------------------------------------
// 建议处置（界面写好的步骤，不是 AI 生成的）
// ---------------------------------------------------------------------------

export interface ActionStep { title: string; sub: string }

/**
 * 按规则 × 服务写好的处置步骤。
 *
 * ⚠️ 这是**通用流程**，不是对这台资源的判断 —— 那一份来自 AI 判读，派过之后
 *    抽屉用 AI 给的那一条替换掉这里。事实性的说法（RDS 停止最长 7 天、ElastiCache
 *    没有「停止」、Memcached 没有快照、RDS 不能直接调小已分配存储）都是服务本身的
 *    限制，写错会让人照着做出错事，改之前先核对官方文档。
 */
export function actionSteps(f: FindingRow, zh: boolean): ActionStep[] {
  const s = (zt: string, zs: string, et: string, es: string): ActionStep =>
    (zh ? { title: zt, sub: zs } : { title: et, sub: es });
  const owner = s("确认归属", "找到负责人，确认没有业务、报表或定时任务还在用它",
    "Confirm the owner", "Make sure no service, report or scheduled job still uses it");
  if (f.rule === "oversized_storage") {
    return [
      s("看占用趋势", "确认近几个月的增长，给后续扩容留出余量",
        "Check the growth trend", "Leave headroom for the next few months"),
      s("迁到更小的存储", "RDS 不能直接调小已分配的存储，需要迁到新实例",
        "Move to smaller storage", "RDS cannot shrink allocated storage in place; migrate to a new instance"),
    ];
  }
  if (f.rule === "oversized_memory") {
    return [
      s("看内存峰值", "确认最近一个月的峰值放得进小一档的节点",
        "Check the memory peak", "Make sure last month's peak fits one size down"),
      s("换小一档节点", "可以直接修改节点类型，建议放在维护窗口里做",
        "Move one node size down", "Change the node type in place; schedule it in a maintenance window"),
    ];
  }
  if (f.service === "elasticache") {
    return [
      owner,
      s("建最终快照", "Redis 与 Valkey 删除前可以留快照；Memcached 没有快照，删除即丢数据",
        "Take a final snapshot", "Redis/Valkey only; Memcached has no snapshots"),
      s("删除", "ElastiCache 没有「停止」，只能删除",
        "Delete", "ElastiCache cannot be stopped, only deleted"),
    ];
  }
  if (f.service === "rds") {
    return [
      owner,
      s("建最终快照", "删除前留一份可恢复的数据", "Take a final snapshot", "Keep a restorable copy"),
      s("删除，或先停止观察", "RDS 与 Aurora 停止最长 7 天，到期会自动重新启动",
        "Delete, or stop first", "RDS and Aurora restart automatically after 7 days stopped"),
    ];
  }
  return [owner, s("下线或删除", "按这项服务自己的流程处理", "Retire it", "Follow the service's own process")];
}

/** 关联发现的一句说明（同一台资源上的另一条）。 */
export function relatedNote(f: FindingRow, zh: boolean): string {
  if (f.rule === "oversized_storage") return zh ? "分配的存储远大于实际占用" : "Storage far above usage";
  if (f.rule === "oversized_memory") return zh ? "节点内存远大于实际占用" : "Memory far above usage";
  if (f.rule === "idle") {
    return f.idle_score !== null
      ? (zh ? `被判定闲置，评分 ${Math.round(f.idle_score)}` : `Flagged idle, score ${Math.round(f.idle_score)}`)
      : (zh ? "闲置判据不足" : "Idle, not enough data");
  }
  return "";
}

/** 粗估精度的短说法（完整一句在 `PRECISION_LABEL`，放 title）。 */
export const PRECISION_SHORT: Record<string, { zh: string; en: string }> = {
  table_unverified_region: { zh: "区域未核对", en: "region unverified" },
  table_no_provenance: { zh: "价格来源不明", en: "unknown source" },
  coarse_keyword: { zh: "按规格关键字", en: "by size keyword" },
  coarse_default: { zh: "全局兜底价", en: "fallback price" },
};

/** `2026-09-07` → 「9 月 7 日」（不是今年时带年份）。 */
export function shortDate(iso: string, zh: boolean): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m) return iso || "—";
  if (!zh) return `${m[1]}-${m[2]}-${m[3]}`;
  const thisYear = String(new Date().getFullYear());
  return `${m[1] === thisYear ? "" : `${m[1]} 年 `}${Number(m[2])} 月 ${Number(m[3])} 日`;
}
