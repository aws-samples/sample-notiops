import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type ConfigData,
  type FindingKind,
  type FindingRow,
  type FindingsData,
  type OverviewData,
  type ScopeData,
  type Severity,
  SEVERITIES,
  getInspectionConfig,
  getInspectionFindings,
  getInspectionOverview,
  getInspectionScope,
  isFail,
  triggerInspectionRun,
  judgeInspectionFinding,
  ALL_ACCOUNTS_SENTINEL,
  VISIBLE_FINDING_KINDS,
  isHiddenKind,
} from "../api/inspection";
import { useLocale, useT } from "../i18n";
import ExclusionModal, { type BatchResult } from "./inspection/ExclusionModal";
import ConfigPage from "./inspection/ConfigPage";
import FindingCard from "./inspection/FindingCard";
import JudgeModal from "./inspection/JudgeModal";
import ScopePage from "./inspection/ScopePage";
import InspectionDashboardPanel from "./InspectionDashboardPanel";
import {
  fmtMoney, isCoarse, PRECISION_LABEL, precisionRank,
} from "./inspection/format";
import {
  Alert, Badge, Btn, Chip, Container, Empty, Expandable, PageHeader, SkeletonCards, Status,
} from "./inspection/ui";
import { C, SEV_COLOR, inner, page, td, th } from "./inspection/tokens";

/**
 * 资源巡检看板主体。
 *
 * ## 这一版重做了什么，以及为什么
 *
 * 客户的判断是「不太好用、没有符合预期」，落到具体处：
 *
 * ```
 * ① 打开先看到的是「巡检系统本身正常吗」（采集完整度 / 未做根因分析 /
 *    runs 表），而客户要回答的是「**今天我要处置什么**」
 * ② 三次点击才看到第一条风险，而「高负载 / 闲置 / 结构性」是**我们的**
 *    分类维度，不是客户的（客户的维度是严重度和「这台是不是生产库」）
 * ③ 点「跑高负载」，「跑闲置」一起变灰 —— 两个按钮共用一个 runState
 * ④ 一条 finding 都点不开（详情抽屉从未接线）
 * ⑤ 卡片上没有任何数字（判定证据压根没落库）
 * ```
 *
 * 所以：导航 6 → 3，默认落地「待处置」，规则类降为筛选 chip。
 *
 * ## 样式惯例：内联 + CSS 变量
 *
 * 本仓其余仪表盘（Security / FinOps / Cases / Investigation）全部如此，
 * `styles.css` 里没有 `.kpi-card` 这类通用类。自造类名的表现是页面
 * **完全没有样式**（元素堆在左上角），而 tsc 与 lint 都不会报。
 * 例外是 `styles.css` 里那四个 `insp-` 前缀的类 —— `@keyframes` 与
 * `:hover` 内联表达不了。
 *
 * ## 这里不做任何判定
 *
 * R9.1 明写「所有数字 SHALL 由巡检 Lambda 确定性计算」。本组件只排版。
 * 在这里补算一个百分比就意味着同一个数字有两个来源，而两处必然分叉。
 */

/**
 * 导航 id → 实际渲染的页 + 只看哪一类。
 *
 * ## 三类各自一页（2026-08-24 改回来）
 *
 * 上一版把三类合成一页「待处置」+ 筛选 chip，理由是「三页之和才是今天要
 * 处置什么」。合并本身没错，**但它让排序无解**：
 *
 * ```
 * 高负载   要按紧急度排   CRITICAL 的 CPU 打满得排在最上面
 * 闲置     要按金额排     省 $400 的比省 $12 的值得先看
 * ```
 *
 * 一页只能有一个排序键。合并页选了 `severity ↓ → days_active ↓`，于是
 * 闲置那些 INFO 条目**永远沉在底部**，而它们恰恰是这一页唯一能立刻拿走的
 * 收益。客户原话：「优化的，没有看到评分因子」—— 看不到是因为压根没排上来。
 *
 * 两类的处置节奏也不同：高负载是「现在看一眼」，闲置是「本月排期降配」。
 * 混在一列意味着这两种节奏共用一个滚动位置。
 *
 * ```
 * high-load   高负载       按 severity ↓ → days_active ↓
 * idle        闲置与成本   按 savings_usd ↓ → idle_score ↓
 * structural  配置检查     按 severity ↓ → rule
 * ```
 *
 * 🔴 `triage` / `overview` 是**老 id**，导航里已经没有了，但
 * **已经发出去的 IM 深链还在客户手里**（`inspection/adapters/links.py` 拼
 * `?tab=high-load`，`push_policy.tab_for_rule` 决定值）。所以：
 *
 * ```
 * overview  → 高负载页，且「系统状态」默认展开（那是它原来的内容）
 * triage    → 高负载页（合并页时代的默认落地页）
 * ```
 *
 * ⚠️ 每个 kind 页只请求**那一个** kind。这让「一次点击一次请求」保持直观，
 * 也让只有闲置权限的人不会因为高负载 403 而看到一个错误条。
 */
const PAGE_ALIAS: Record<string, {
  page: "kind" | "scope" | "config";
  /** `page === "kind"` 时必填 —— 这一页只看哪一类。 */
  chip?: FindingKind;
  ops?: boolean;
}> = {
  "high-load": { page: "kind", chip: "high_load" },
  idle: { page: "kind", chip: "idle" },
  structural: { page: "kind", chip: "structural" },
  scope: { page: "scope" },
  config: { page: "config" },
  // 老深链 / 老默认页 → 高负载（那是最该先看的一类）
  triage: { page: "kind", chip: "high_load" },
  overview: { page: "kind", chip: "high_load", ops: true },
};

/**
 * `dashboardId` → 这一页看什么。**被隐藏的 kind 页退回高负载页。**
 *
 * 🔴 兜底不能省。`?tab=structural` 的深链**已经发出去了**
 * （`push_policy.tab_for_rule` 给结构性规则拼的就是这个值，客户 IM 里
 * 还留着）。隐藏之后不兜底的表现是：那一页的 chip 与权限求交集得到空集，
 * 于是落到 🔒「没有查看权限」屏 —— 客户去找管理员要一个**根本不存在**
 * 的权限问题。退回高负载页至少是一屏真数据。
 *
 * ⚠️ 与 `InspectionDashboardBrowser` 的 `LEGACY_TAB` 是两道独立的门：
 * 那边只管左侧目录选中项，而本组件可以被别处直接渲染（测试就是这么用的）。
 */
function resolveAlias(id: string) {
  const a = PAGE_ALIAS[id] ?? PAGE_ALIAS.triage;
  if (a.chip && isHiddenKind(a.chip)) return PAGE_ALIAS.triage;
  return a;
}

/** kind → 它需要的能力键。与 capabilities.json 的三个子页逐字一致。 */
const KIND_CAP: Record<FindingKind, string> = {
  high_load: "nav:inspection:high-load",
  idle: "nav:inspection:idle",
  structural: "nav:inspection:structural",
};

const KIND_LABEL: Record<FindingKind, string> = {
  high_load: "insp.tab.highLoad",
  idle: "insp.tab.idle",
  structural: "insp.tab.structural",
};

/**
 * 本看板会去取的 kind。
 *
 * 🔴 用 `VISIBLE_FINDING_KINDS` 而不是把三类写死：被隐藏的那一类
 * （见 `api/inspection.ts::HIDDEN_KINDS`）**连请求都不该发**。
 * 写死的表现是导航里看不到「配置检查」，但每开一次总览还是白打一次
 * `/inspection/findings?kind=structural` —— 客户在 CloudWatch 里看到
 * 一个「已经隐藏」的功能在持续产流量。
 */
const ALL_KINDS: readonly FindingKind[] = VISIBLE_FINDING_KINDS;

/**
 * 一个 run_type 的触发状态。**按类型分槽**，见下。
 *
 * 🔴 `submitted` 与 `done` 是**两件不同的事**，不能合并：
 *
 * ```
 * done       轮询确认过「今天这一轮的 run 行变了且不是 running」→ 真跑完了
 * submitted  只知道 invoke 成功。走「全部账号」时用它 ——
 *            一个槽位盯不了 N 个账号的 run 行，所以这条路**不轮询**
 * ```
 *
 * 合并的表现是绿色 ✓「跑完了」出现在一次压根没验证过的批量触发之后 ——
 * 而这个按钮唯一的存在理由就是「客户不信看板上的数」。
 * 提示条那侧把 `submitted` 映成 **warning（琥珀）** 而不是 success，
 * 就是为了让颜色也说同一件事。
 */
type RunPhase = "idle" | "sending" | "waiting" | "done" | "submitted"
  | "error" | "timeout";
interface RunSlot { phase: RunPhase; msg: string }
const EMPTY_SLOT: RunSlot = { phase: "idle", msg: "" };

interface Props {
  dashboardId: string;
  can?: (key: string) => boolean;
  /* 🔴 **这里原来有 `onInvestigate`（跳聊天页），2026-08-31 删掉。**

     「深入分析」的行为换成了「派一次真的 DA 判读」，而那条路**不需要聊天页**
     的任何东西 —— 判读结果绑在 finding 上（`put_dispatch` 是回拼锚点），
     不落在任何一个会话里。所以实现留在本组件内（`doJudge`），
     不再往上要一个回调。

     客户对旧行为的原话：「现在的做法似乎没有用到任何 skill，连触发的账号
     也是错的，而且也不是触发的 DA 调查，而是 AI 分析。」

     ⚠️ 别把这个 prop 加回来「顺便也支持跳聊天」：两个长得一样的入口做两件
        不同的事，是这一版之前那个缺陷的原始形态。真要问自由问题，
        聊天页本来就在左边。 */
  accountId?: string;
  accounts?: { accountId: string; accountName?: string }[];
  /* 🔴 **这里原来有 `onAccountChange`，2026-09-01 删掉。**

     它只喂给页面级的那个账号选择器（`acctPicker`），而那个选择器已经没有
     任何一页在用 —— 列表跨账号加载、阈值按类型全局存、排除清单有账号列。
     见下面 `acctPicker` 原址那段说明。

     ⚠️ **不要**为了「顺手也能切账号」加回来。切账号在这三页都是无操作或
        有害的（阈值页切一下会静默丢掉未保存的草稿），而一个看起来能用、
        实际什么都不改的控件比没有控件更糟。
     宿主（`InspectionDashboardBrowser`）自己那份 `onAccountChange` 保留：
     深链 `?account=` 要靠它回传给 ChatApp。 */
  /**
   * 推送深链要高亮的 `finding_id`（R11b.7）。
   *
   * ⚠️ 只做高亮 + 滚动到可见 + 自动打开详情，**不做筛选**。筛掉其余条目会
   * 让客户以为「今天只有这一条」，而深链的语义是「先看这条」。
   */
  highlight?: string;
}

export default function InspectionDashboard({
  dashboardId, accountId = "", accounts = [], can,
  highlight = "",
}: Props) {
  const t = useT();
  const { locale } = useLocale();
  const zh = locale !== "en";

  const alias = resolveAlias(dashboardId);
  const view = alias.page;

  /**
   * 写操作成功后强制重取。
   *
   * ⚠️ 不能只更新本地 state —— 后端会补默认值（`expires_at` 缺省 30 天、
   * `enabled` 缺省 true），本地拼一份必然与库里不同。表现是保存后页面显示
   * 的到期日与实际生效的不是同一天，而客户按页面上的日期去安排续期。
   */
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const [loading, setLoading] = useState(true);
  /** 原地刷新（写操作之后）。**不清内容** —— 见下面 isRefresh 的说明。 */
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState("");
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [byKind, setByKind] = useState<Partial<Record<FindingKind, FindingsData>>>({});
  const [scope, setScope] = useState<ScopeData | null>(null);
  const [config, setConfig] = useState<ConfigData | null>(null);

  // 有权限的 kind。⚠️ 只对这些发请求 —— 拿 403 当探针会在日志里刷一堆噪音。
  const kinds = useMemo(
    () => ALL_KINDS.filter((k) => !can || can(KIND_CAP[k])), [can]);
  /**
   * 本页要取的 kind。kind 页只取那一个（见 PAGE_ALIAS 的说明）。
   *
   * 🔴 **要与权限求交集。** 导航入口按 cap 过滤过了，但深链能直接带
   * `?tab=idle` 进到一个无权的页。不求交集的表现是发一个必然 403 的请求；
   * 而如果反过来在无权时返回空数组、又不显式提示，页面会渲染成
   * **「零条待处置」** —— 客户看到的是「今天没风险」，真相是「你没权限看」。
   * 这两件事绝不能长得一样（R9.11）。所以空数组 + 下面的 `noAccess` 分支
   * 成对存在。
   */
  const wantKinds = useMemo(() => {
    if (!alias.chip) return kinds;
    return kinds.includes(alias.chip) ? [alias.chip] : [];
  }, [alias.chip, kinds]);
  const wantKey = wantKinds.join(",");

  // ── 手动触发（action:inspection:run）───────────────────────────────────
  //
  // 🔴 **按 run_type 分槽。** 第一版两个按钮共用一个 `runState`，后果分三层：
  //
  // ```
  // ① 显示     点「跑高负载」→「跑闲置」同时变「巡检中…」
  // ② 阻塞     守卫 `if (runState === sending||waiting) return`
  //            → 高负载在跑的 5 分钟里闲置**点不动**，且无提示
  // ③ 跨页残留  切页只换 dashboardId prop，组件不卸载 → 另一页的按钮也是灰的
  // ```
  //
  // 状态机四态：「已发出」与「跑完了」必须分开 —— 后端是异步 invoke
  // （一轮 refetch 是分钟级，同步会顶到 Function URL 的 30 秒上限），
  // 所以「按钮点完」只代表消息投出去了。合并成一个「完成」态会让用户
  // 以为数据已经好了，刷新看到空列表就以为没风险。
  const [runs, setRuns] = useState<Record<"high" | "idle", RunSlot>>({
    high: EMPTY_SLOT, idle: EMPTY_SLOT,
  });
  const polls = useRef<Record<"high" | "idle", ReturnType<typeof setInterval> | null>>({
    high: null, idle: null,
  });
  /**
   * 当前账号。**给轮询回调读**。
   *
   * 🔴 `setInterval` 里的 `accountId` 是 `doRun` 那一刻的闭包值，而 `polls`
   * 只按 run_type 分槽、不按账号。不比对的话：
   *
   * ```
   * 账号 A 点「跑闲置」→ 立刻切到账号 B
   *   → 1~3 分钟后 A 那一轮结束
   *   → 界面（当前是 B）弹绿条「闲置轮：跑完了」+ reload() 重取 B 的数据
   *   → 客户以为 B 刚跑完了一轮
   * ```
   */
  const acctRef = useRef(accountId);
  // ⚠️ 在 effect 里同步，不在渲染期赋值 —— React 19 的
  //    `react-hooks/refs` 规则禁止渲染期访问 ref（并发渲染下那次赋值
  //    可能属于一次被丢弃的渲染）。
  useEffect(() => { acctRef.current = accountId; }, [accountId]);

  // 轮询要在组件卸载时停掉，否则切页之后还在后台打请求。
  useEffect(() => () => {
    for (const k of ["high", "idle"] as const) {
      if (polls.current[k]) clearInterval(polls.current[k]!);
    }
  }, []);

  const setSlot = (rt: "high" | "idle", s: Partial<RunSlot>) =>
    setRuns((cur) => ({ ...cur, [rt]: { ...cur[rt], ...s } }));

  /**
   * 触发一轮巡检。
   *
   * 🔴 `runAcct` 是**显式**传的，不再读顶部那个账号选择器。
   *
   * 统一视图之后页面上没有「当前账号」这个概念了（finding 跨账号一起列），
   * 所以「跑哪个账号」必须由这次点击自己说清。沿用一个不存在的全局状态会让
   * 客户以为跑的是他刚在 filter 里搜的那个账号 —— 而那两件事毫无关系。
   */
  const doRun = async (rt: "high" | "idle", runAcct: string,
                       runList: string[] | null = null) => {
    if (runs[rt].phase === "sending" || runs[rt].phase === "waiting") return;
    setSlot(rt, { phase: "sending", msg: "" });
    /**
     * 显式多选（2026-09-01）。走**与「全部账号」同一条**不轮询的路。
     *
     * 🔴 判据是「这次扇出了几个账号」，不是「走的哪条 API 路径」。
     *    下面那套完成判据是**单账号**的（一个 baseline、一个
     *    `polls.current[rt]`、判据是那一个账号的 run 行变了没），照原样跑
     *    N 个只有两种落法，两种都是假信号：
     *      · 只盯第一个 → 它 5 秒后完成就报「跑完了」，另外 N-1 个还在跑
     *      · 盯一个与这次点击无关的账号 → 完全是别的事
     *
     * ⚠️ 只勾了**一个**时不走这条路 —— 那时轮询是准确的，而「跑完了」这个
     *    确认是这个按钮最有价值的部分（客户点它就是因为不信看板上的数）。
     *    所以调用方对 `list.length === 1` 传标量，见 `runGo`。
     */
    if ((runList && runList.length > 0) || runAcct === ALL_ACCOUNTS_SENTINEL) {
      /* ⚠️ `"*"` 也走这一支。UI 现在不产生它（多选换掉了「全部账号」那个
         按钮），但 API 层仍然支持它（IM / 脚本用），而它**必须**落在这条
         不轮询的路上 —— 掉到下面那套单账号轮询里会去 poll 一个叫 `*` 的
         账号，那个请求永远不会显示完成，进度条卡在「巡检中…」直到超时。 */
      const r = await triggerInspectionRun(
        runList && runList.length > 0
          ? { run_type: rt, source: "refetch", mode: "dry_run", accounts: runList }
          : { run_type: rt, source: "refetch", mode: "dry_run",
              account: ALL_ACCOUNTS_SENTINEL });
      if (isFail(r)) {
        setSlot(rt, {
          phase: "error",
          msg: r.code === "http_403"
            ? (zh ? "没有手动触发权限（action:inspection:run）" : "Not authorised")
            : (zh ? `触发失败：${r.message || r.code}` : `Failed: ${r.code}`),
        });
        return;
      }
      // ⚠️ 用**后端回传的** `account_ids` 报数，不用前端的勾选数。
      //    两边分叉的情况是真实存在的（部署账号可能也被登记进了成员表，
      //    BFF 会去重），而报一个客户没法核对的数字就是撒谎。
      setSlot(rt, {
        phase: "submitted",
        msg: t("insp.run.allSubmitted")
          .replace("{n}", String((r.account_ids || []).length)),
      });
      return;
    }
    // 🔴 **先抓基线**。完成判据必须来自「这次操作产生的新证据」，而不是一个
    //    点击前就已经为真的条件。
    //
    //    原来的判据是 `row.last_run_date === today && last_status !== "running"`
    //    —— 下午打开看板时，早上的定时轮早就写下了今天的 success 行，所以这个
    //    条件在**点击之前**就成立了。而后端 `try_acquire_run_lock` 的
    //    ConditionExpression 只放行「无行 / failed / 超时的 running」，今天是
    //    success 就直接跳过（消息删除、不进 DLQ、run 行一个字段都不变）。
    //
    //    两件事叠起来：跳过是静默的，前端又把「早就完成」读成「我这次完成了」
    //    —— 15 秒后弹绿条「跑完了」+ 自动 reload，客户以为看到的是刚拉的指标，
    //    实际是早上那一轮的数，而这次点击一台机器都没碰。
    //
    //    这个按钮是唯一会花钱的入口（refetch 真调 GetMetricData），客户按它
    //    就是因为不信看板上的数 —— 给成功反馈却复用旧数据比报错严重得多。
    let baseline: { d: string; s: string } | null = null;
    try {
      const b = await getInspectionOverview(runAcct || undefined);
      if (!isFail(b)) {
        const brow = b.diff?.[rt];
        if (brow) {
          baseline = {
            d: String(brow.last_run_date || ""),
            s: String(brow.last_status || ""),
          };
        }
      }
    } catch { /* 拿不到基线 → 按「没有基线」处理，仍然比原来强 */ }

    const r = await triggerInspectionRun({
      run_type: rt,
      // refetch：点「立即巡检」要的是现在的指标。
      source: "refetch",
      // dry_run：一次手点的补跑不该改变「这条风险是否已解决」这种带日期
      // 语义的结论（resolved 判定按 official 轮推进）。
      mode: "dry_run",
      account: runAcct || undefined,
    });
    if (isFail(r)) {
      setSlot(rt, {
        phase: "error",
        msg: r.code === "http_403"
          ? (zh ? "没有手动触发权限（action:inspection:run）" : "Not authorised")
          : (zh ? `触发失败：${r.code}` : `Failed: ${r.code}`),
      });
      return;
    }
    setSlot(rt, { phase: "waiting", msg: "" });

    // 轮询 run 状态。20 次 × 15 秒 = 5 分钟上限 —— 一轮 refetch 通常
    // 1~3 分钟，超时就停并让用户自己刷新，而不是无限打请求。
    let ticks = 0;
    if (polls.current[rt]) clearInterval(polls.current[rt]!);
    const startedFor = runAcct;
    polls.current[rt] = setInterval(async () => {
      ticks += 1;
      // 账号已经切走了 —— 停掉，不要对着新账号报旧账号的结果。
      if (acctRef.current !== startedFor) {
        if (polls.current[rt]) clearInterval(polls.current[rt]!);
        setSlot(rt, { phase: "idle", msg: "" });
        return;
      }
      // ⚠️ 用 **overview** 轮询而不是 findings：后者要 kind，而这里是 run_type
      //    （结构性与闲置同属 idle 轮），对不上。
      const d = await getInspectionOverview(startedFor);
      if (!isFail(d)) {
        const row = d.diff?.[rt];
        const today = new Date().toISOString().slice(0, 10);
        // 🔴 判据是「**与基线不同**」而不是「今天跑过且不在跑」——
        //    后者在点击之前就可能为真（见上面 baseline 那段的说明）。
        const changed = !baseline
          || String(row?.last_run_date || "") !== baseline.d
          || String(row?.last_status || "") !== baseline.s;
        if (row && changed && row.last_run_date === today
            && row.last_status !== "running") {
          if (polls.current[rt]) clearInterval(polls.current[rt]!);
          const bad = row.last_status === "failed";
          setSlot(rt, {
            phase: bad ? "error" : "done",
            msg: bad
              ? (zh ? "本轮失败，去看 notiops-inspection-executor 的日志"
                    : "Run failed; check the executor logs")
              : (zh ? "跑完了" : "Done"),
          });
          reload();
          return;
        }
        // ⚠️ 基线未变 + 今天已有成功的一轮 → 这次**被后端跳过了**。
        //    `try_acquire_run_lock` 的条件不放行「今天已 success」，而跳过是
        //    静默的（消息删除、不进 DLQ）。必须如实说，否则客户会拿早上的
        //    水位去做扩容决策。
        if (baseline && !changed && baseline.d === today
            && baseline.s === "success") {
          if (polls.current[rt]) clearInterval(polls.current[rt]!);
          setSlot(rt, { phase: "error", msg: t("insp.run.skippedToday") });
          return;
        }
      }
      if (ticks >= 20) {
        if (polls.current[rt]) clearInterval(polls.current[rt]!);
        // 🔴 `timeout` 而不是 `idle`。第一版置 idle 却留着 msg，而提示条的
        //    type 是「error 之外都算 success」→ 超时显示成**绿色 ✓**
        //    「等待超时，稍后手动刷新看结果」。既与 ui.tsx 第③条（图标+文字+
        //    颜色要一致）矛盾，也正是「让用户以为数据已经好了」那种误读。
        setSlot(rt, {
          phase: "timeout",
          msg: zh ? "等待超时（5 分钟）—— 那一轮可能还在跑，稍后刷新看结果"
                  : "Timed out after 5 minutes; the run may still be in progress",
        });
      }
    }, 15000);
  };

  const mayRun = !!can?.("action:inspection:run");
  const mayScope = !!can && can("action:inspection:scope");

  /**
   * 点了哪个按钮在等选账号（`""` = 没在等）。
   *
   * 🔴 统一视图之后页面上没有「当前账号」这个概念了，所以「跑哪个账号」必须
   * 由这次点击自己说清。原来它读顶部那个选择器 —— 那个选择器现在没了，
   * 而沿用一个不存在的全局状态会让客户以为跑的是他刚在 filter 里搜的那个账号。
   */
  const [runPick, setRunPick] = useState<"high" | "idle" | "">("");
  /**
   * 弹层里勾中的账号。**空串代表部署账号**（与 BFF 的 `resolveAccount`
   * 空值兜底同一套语义 —— 前端拿不到部署账号的 12 位 ID）。
   *
   * 🔴 这一版把「选一个账号 / 全部账号 + 二次确认屏」换成了单层多选
   * （2026-09-01）。客户原话：「被挡住了，我点全部账号后又出来一大堆内容，
   * 絮絮叨叨贫死了。能不能别加这么多文字？不如一个 dropdown 让客户一个一个
   * check 账号然后执行就完了。别这么繁琐。不要再出现第二步和描述性的大段
   * 文字了。」
   *
   * ⚠️ 默认**一个都不勾**。这个按钮是唯一会真花钱的入口（refetch 真调
   *    GetMetricData、还可能派 DA 判读），预先勾上一个等于替客户做了一个
   *    付费决定。「执行」在空选时是灰的并说明原因。
   */
  const [runSel, setRunSel] = useState<Set<string>>(() => new Set());

  /**
   * 弹层里列出的账号。第一项是部署账号（值为空串）。
   *
   * ⚠️ 成员表里可能有部署账号的历史登记 → 这里会出现两行长得不一样、
   *    实际指向同一个账号的项（一行写「部署账号」、一行写它的 ID）。
   *    前端认不出来（拿不到部署账号 ID），BFF 会在扇出前去重 ——
   *    所以**报数用后端回传的 `account_ids`**，不用这里的勾选数。
   */
  const runTargets = useMemo(() => [
    { id: "", label: zh ? "部署账号" : "Deployment account" },
    ...accounts.map((a) => ({
      id: a.accountId,
      label: a.accountName ? `${a.accountName} · ${a.accountId}` : a.accountId,
    })),
  ], [accounts, zh]);

  const toggleRunAcct = (id: string) => setRunSel((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /**
   * 执行。**勾一个走标量、勾多个走数组。**
   *
   * 🔴 一个和多个是两条不同的路，不能统一成数组：单账号那条会抓基线 + 轮询，
   * 跑完弹绿条「跑完了」—— 而那个确认是这个按钮最有价值的部分（客户点它
   * 就是因为不信看板上的数）。多个账号一个槽位盯不过来，只能如实说「已提交」。
   */
  const runGo = (rt: "high" | "idle") => {
    const list = [...runSel];
    if (list.length === 0) return;
    setRunPick(""); setRunSel(new Set());
    if (list.length === 1) void doRun(rt, list[0]);
    else void doRun(rt, "", list);
  };

  const runButton = (rt: "high" | "idle") => {
    const s = runs[rt];
    const busy = s.phase === "sending" || s.phase === "waiting";
    const label = rt === "high"
      ? (zh ? "跑高负载" : "Run high-load")
      : (zh ? "跑闲置" : "Run idle");
    return (
      // 🔴 `title` 说明**副作用**：手点一轮会占掉今天的巡检槽位。
      //
      //    前端写死 `mode: "dry_run"`，理由是「一次手点的补跑不该改变带日期
      //    语义的结论」。但 dry_run 的 `build_stats` 照样走 `terminal_status()`
      //    落 `success`，而调度的唯一判据是
      //    `BLOCKING_STATUSES = {running, success}` —— 也就是说 dry_run
      //    **占掉了那一天的槽位**。
      //
      //    客户的自然动作（上午想看看现在什么情况）会静默取消当天的正式巡检：
      //    当天没有状态机推进、没有 resolved 判定、没有推送。
      //    第二天他会问「昨天怎么没推送」。
      // ⚠️ 只有部署账号一个可选时**直接跑**，不弹层 —— 让人从一个选项里选一个
      //    是纯粹的多余点击（单账号部署是最常见的形态）。
      <Btn key={rt} size="small" loading={busy}
        onClick={() => {
          if (accounts.length === 0) { void doRun(rt, ""); return; }
          // 每次打开都从空选开始 —— 上一次的勾选留着会让人在不看列表的
          // 情况下点「执行」，而那一次可能跑的是别的账号。
          setRunSel(new Set()); setRunPick(rt);
        }}
        title={t("insp.run.takesTodaySlot")}
        // 🔴 disabled 必须给原因。灰着不说为什么的按钮让人只能猜「是不是坏了」。
        disabledReason={busy
          ? (s.phase === "sending"
            ? (zh ? "正在提交…" : "Submitting…")
            : (zh ? "这一轮正在跑（最多等 5 分钟）" : "This run is in progress"))
          : ""}>
        {label}
      </Btn>
    );
  };

  /**
   * 按需判读：给**一条** finding 派一次 DA 调查，用写好的判读 skill。
   *
   * 🔴 这**替换**了原来「深入分析」的行为。原来那个是跳到聊天页开一个普通
   *    LLM 会话 —— 不调 DA、不用 skill，账号还继承聊天页选择器（与这条
   *    finding 无关）。客户实测后原话：「现在的做法似乎没有用到任何 skill，
   *    连触发的账号也是错的，而且也不是触发的 DA 调查，而是 AI 分析。」
   *
   * ⚠️ 实现放在**这一层**而不是提到 `ChatApp`：判读的结果绑在 finding 上
   *    （`put_dispatch` 是回拼锚点），不落在任何一个会话里 —— 所以它不需要
   *    聊天页的任何东西。而这一层手上有 `accountId` 与 `reload()`。
   *
   * ⚠️ `accountId` 用 **finding 自己的** `f.account_id`，不是页面选择器的值。
   *    统一视图下列表是跨账号的，用选择器的值会让 677 那条 finding 的判读
   *    派到 698 去（那正是刚修掉的同一类缺陷）。
   */
  /**
   * `askJudge` = 确认弹窗要问哪一条（null = 弹窗关着）。
   *
   * 🔴 分成两个 state 而不是一个：弹窗**打开**与请求**在飞**是两件事。
   *    合成一个的表现是派发中弹窗就消失了 —— 而那 1~3 秒里客户看不到任何
   *    进度，会去点第二次（卡片上那个按钮还在）。
   */
  const [askJudge, setAskJudge] = useState<FindingRow | null>(null);
  const [judging, setJudging] = useState("");        // 正在派的 finding_id
  const [judgeMsg, setJudgeMsg] = useState<
    { type: "success" | "error" | "warning"; text: string } | null>(null);
  /**
   * 本次会话里刚派成功、但列表可能还没刷新到的 finding_id。
   *
   * 🔴 `reload()` 只是 bump 一个 nonce（**不可 await**），所以「派发成功」到
   * 「列表带回 `da_task_id`」之间有一个几百毫秒的窗口。窗口里 `judging` 已经
   * 清了而 `da_task_id` 还是空 ⇒ 按钮重新可点，客户再点一次拿到
   * `already_dispatched`，看起来像失败。
   *
   * ⚠️ 这是**乐观状态，不是数据源**：它只负责让按钮消失 / 状态行出现。
   * task id 与判读正文仍然只认后端回来的值 —— 乐观地编一个 task id
   * 会让「我们以为派了」和「真的派了」无法区分。
   *
   * ⚠️ 只增不减、只在本次会话里有效。刷新页面后判据回到 `da_task_id`
   * （那时后端已经写好了），所以它不需要清理。
   */
  const [justJudged, setJustJudged] = useState<ReadonlySet<string>>(
    () => new Set<string>());

  const doJudge = async (f: FindingRow, note = "") => {
    if (judging) return;                              // 防重复点
    setJudging(f.finding_id);
    setJudgeMsg(null);
    const r = await judgeInspectionFinding({
      finding_id: f.finding_id,
      account: f.account_id,
      note: note || undefined,
    });
    setJudging("");
    // 🔴 成功与失败**都**关弹窗。失败时留着的表现是：错误提示条在弹窗**后面**
    //    的页面上（弹窗有遮罩），客户看不见它，只觉得点了没反应。
    setAskJudge(null);
    if (isFail(r)) {
      /**
       * ⚠️ 后端的 `code` 各自对应一句**不同且可操作**的话，不能合成一句。
       *
       * ```
       * already_dispatched  已经派过了 → 等它回来，或去后台看
       * kill_switch         巡检被拉停了 → 先打开开关
       * not_found           这条 finding 没了 → 大概已被下一轮 resolve
       * conflict            已标记「已解决」→ 派出去只会得到自相矛盾的分析
       * http_403            没有 action:inspection:run 权限
       * ```
       */
      setJudgeMsg({
        type: r.code === "already_dispatched" ? "warning" : "error",
        text: r.code === "http_403"
          ? (zh ? "没有派判读的权限（action:inspection:run）" : "Not authorised")
          // 🔴 原样显示后端的话 —— 它带着「为什么」和「下一步」。
          //    换成一句「派发失败」等于把那些全丢掉。
          : (r.message || (zh ? `派发失败：${r.code}` : `Failed: ${r.code}`)),
      });
      /**
       * 🔴 `already_dispatched` 要与其它失败**分开处理**：它说明后端那条
       * finding **已经有 task 了**，而本地列表没有 —— 也就是说
       * 「按钮还亮着」这件事本身就是本地数据过期的证据。
       *
       * 不 reload 的表现是个闭环：
       *
       * ```
       * 本地 da_task_id 空 → 按钮可点 → 点 → 后端拒 already_dispatched
       *   → 本地 da_task_id 仍然空 → 按钮还可点 → 客户再点 → …
       * ```
       *
       * 客户能做的只有手动刷新，而提示条里那句话（后端原文）没说要刷新。
       * 补 `justJudged` + `reload()` 之后，一次点击就让界面收敛到真实状态
       * ——「⏳ 判读中」，也就是它本该显示的东西。
       *
       * ⚠️ 其它失败码**不能**这样处理：`kill_switch` / `conflict` /
       *    `not_found` / `http_403` 都是「真的没派」，记乐观状态会让按钮
       *    永久消失，客户连重试的入口都没有。
       */
      if (r.code === "already_dispatched") {
        setJustJudged((s) => new Set(s).add(f.finding_id));
        reload();
      }
      return;
    }
    setJudgeMsg({
      type: "success",
      text: t("insp.judge.ok").replace("{task}", r.task_id),
    });
    // 🔴 **先记乐观状态再 reload。** 顺序重要：`reload()` 不可 await，
    //    先 reload 后记的话中间那一帧仍然是「按钮可点」。
    setJustJudged((s) => new Set(s).add(f.finding_id));
    // 🔴 必须 reload：`da_task_id` 落在 finding 行上，不重取的话按钮还在，
    //    客户会再点一次（然后拿到 already_dispatched，以为是失败）。
    //    ⚠️ 光有乐观状态不够 —— 判读正文、解析状态、task id 都只能从后端来。
    reload();
  };

  /** 上一次取数的「页面身份」。用来分辨换页 vs 原地刷新，见下。 */
  const lastKeyRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    const pageKey = `${view}|${accountId}|${wantKey}`;
    /**
     * 🔴 写操作后的重取是**原地刷新**，不能走「清空 + loading」那条路。
     *
     * 走了会让父组件短暂进 loading 分支，从而把子页面**卸载**掉 ——
     * 而「已保存」提示是那些子组件的 state。表现极其误导：保存成功 →
     * 提示闪一下就没了（组件重建）；保存失败 → 不刷新所以错误提示留着。
     * 于是「成功没反馈、失败有反馈」，客户会以为都失败了。
     *
     * 换页时仍然要清 —— 不清的表现是切页瞬间先闪一下上一页的内容。
     */
    const isRefresh = lastKeyRef.current === pageKey;
    lastKeyRef.current = pageKey;

    (async () => {
      // ⚠️ 清理放在 async 体**内**而不是 effect 同步段：同步 setState
      //    会触发级联渲染（eslint 的 react-hooks 规则直接报错）。
      setErr("");
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setOverview(null); setByKind({}); setScope(null); setConfig(null);
        setLoading(true);
      }
      try {
        if (view === "kind") {
          // 总览与各 kind **并发**取。串行的话三个 kind 各 1 次 DDB Query，
          // 首屏要等 4 个 RTT。
          const [ov, ...lists] = await Promise.all([
            // 统一视图：不传账号 → 跨全部可见账号的运行状态与 KPI。
            // ⚠️ run 记录的 SK 就是账号，所以这一条是白送的 —— 无需 GSI。
            getInspectionOverview(),
            // 🔴 **不传 accountId = 统一视图**（跨全部可见账号）。
            //
            //    看板要回答「今天我要处置什么」—— 那是跨账号的问题。原来传
            //    `accountId` 让顶部那个选择器从「筛选」退化成「决定加载哪个
            //    分区」：客户一次只能看一个账号，还得自己记住哪个账号有事。
            //
            // ⚠️ 账号现在是**卡片上的徽章 + 顶部 filter**，不是加载维度。
            ...wantKinds.map((k) => getInspectionFindings(k)),
          ]);
          if (cancelled) return;
          // ⚠️ 总览失败**不阻断列表** —— 总览只提供「系统状态」与派发缺口，
          //    而列表才是这一页的主体。反过来做的表现是「运维自检的一个数
          //    读不到，整页打不开」。
          if (!isFail(ov)) setOverview(ov);
          const next: Partial<Record<FindingKind, FindingsData>> = {};
          let anyOk = false;
          let firstErr = "";
          wantKinds.forEach((k, i) => {
            const d = lists[i];
            // 🔴 判据是「**明确成功**」而不是「不是失败」。
            //    `isFail(undefined)` 返回 false —— 于是一个 undefined 会被
            //    当成合法数据放进 byKind，那一页渲染成「零条待处置」，
            //    而真相是请求根本没返回。空列表与「没风险」混成一回事，
            //    正是 R9.11 要防的那类歧义。
            if (!d || d.ok !== true) {
              firstErr = firstErr || (isFail(d) ? d.code : "empty_response");
              return;
            }
            next[k] = d; anyOk = true;
          });
          setByKind(next);
          // 全部 kind 都失败才算这一页失败。
          //
          // ⚠️ 总览的错误码**优先**：403 是权限问题（去找管理员），
          //    比列表那侧的泛化错误更有指导性。反过来会让一个权限问题
          //    显示成「加载失败」，而客户会反复重试一个永不成功的请求。
          // ⚠️ `wantKinds` 为空 = 这个用户没有**任何**一类 finding 的查看
          //    权限。那不是错误，是权限配置的结果 —— 报「加载失败」会让人
          //    以为系统坏了，去查一个不存在的故障。空态那边会明说。
          //    （他仍然可能有 `action:inspection:run`，所以触发按钮照常显示。）
          if (wantKinds.length > 0 && !anyOk) {
            setErr(isFail(ov) ? ov.code : (firstErr || "empty_response"));
          }
        } else if (view === "scope") {
          const d = await getInspectionScope();
          if (cancelled) return;
          if (isFail(d)) setErr(d.code); else setScope(d);
        } else if (view === "config") {
          const d = await getInspectionConfig(accountId);
          if (cancelled) return;
          if (isFail(d)) setErr(d.code); else setConfig(d);
        }
      } finally {
        if (!cancelled) { setLoading(false); setRefreshing(false); }
      }
    })();
    return () => { cancelled = true; };
    // ⚠️ deps 里**不放 `wantKinds`** —— 它是每次渲染新建的数组，而
    //    `wantKey` 已经完整编码了它的内容。放进去的表现是：宿主
    //    （ChatApp）的 `can` 每次渲染都是新函数身份 → `kinds` useMemo 重算
    //    → 新数组 → effect 重跑 → 通知红点 60 秒轮询一次就让巡检页把
    //    overview + 最多 3 个 findings 全部重打一遍、顶部进度条闪一下。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, accountId, wantKey, nonce]);

  /*
   * 🔴 **这里原来有一个页面级的账号选择器（`acctPicker`），2026-09-01 删掉。**
   *
   * 它已经没有任何一页在用：
   *
   * ```
   * 高负载 / 闲置    列表是跨账号的（`getInspectionFindings` 不传账号），
   *                  账号是卡片上的徽章 + 顶部 filter，不是加载维度
   * 阈值与定时       阈值按类型全局存，切账号只会静默丢掉未保存的草稿
   * 巡检范围         清单跨账号（现在有账号列），选择器唯一的作用是
   *                  「写入用哪个账号」—— 而它长得像筛选器。客户原话：
   *                  「不然容易误导用户，误以为选择账号后会显示出
   *                    当前账号的已加入白名单的资源列表」
   * ```
   *
   * 「空串 = 部署账号」这个与 BFF `resolveAccount` 的契约搬到了
   * `ExclusionModal`（账号选择器现在在那里）—— `tests/inspection.test.mjs`
   * 那条断言跟着指向了那个文件。
   *
   * ⚠️ `onAccountChange` prop 保留：宿主（ChatApp）顶部那个全局账号选择器
   *    还在用它，深链带 `?account=` 也靠它回传。
   */

  if (err) {
    // 403 与「加载失败」要分开：前者是权限问题（去找管理员），后者是故障
    // （重试有意义）。混成一句会让客户反复重试一个永远不会成功的请求。
    return (
      <div style={page}><div style={inner}>
        {err === "http_403" ? (
          <Empty icon="🔒" title={t("insp.error.forbidden")}
            hint={zh ? "看板入口可见但数据被拒 —— 找管理员确认能力配置。"
                     : "Ask an administrator to check your capabilities."} />
        ) : (
          <Empty icon="!" tone={C.red} title={t("insp.error.load")}
            hint={<>({err})</>}
            action={<Btn onClick={reload}>{zh ? "重试" : "Retry"}</Btn>} />
        )}
      </div></div>
    );
  }

  /* 判读的确认弹窗。⚠️ 挂在**这一层**而不是 TriagePage 里：卡片与详情面板
     两个入口都要用它，而它们分属两个不同的子树。 */
  const judgeModal = askJudge ? (
    <JudgeModal row={askJudge}
      busy={judging === askJudge.finding_id}
      onCancel={() => setAskJudge(null)}
      onConfirm={(note) => void doJudge(askJudge, note)} />
  ) : null;

  if (view === "scope") {
    return loading ? <PageSkeleton title={t("insp.tab.scope")} /> : (
      /* ⚠️ 传 `accounts` 而不是现成的 `acctPicker`（2026-09-01）：那一页的
            账号选择器搬进了两个写入弹层，页头不再有它 —— 页头那个位置的
            选择器不影响清单（清单跨账号），却长得像筛选器。 */
      <ScopePage data={scope} zh={zh} t={t} can={can} reload={reload}
        accountId={accountId} accounts={accounts} refreshing={refreshing} />
    );
  }
  if (view === "config") {
    return loading ? <PageSkeleton title={t("insp.tab.config")} /> : (
      <ConfigPage data={config} zh={zh} t={t} can={can} reload={reload}
        refreshing={refreshing} />
    );
  }

  // kind 页 + 该 kind 无权 → 显式提示，**不能**渲染成空列表。
  // 见 `wantKinds` 的说明：「没权限」与「今天没风险」长得一样是最坏的结果。
  if (alias.chip && wantKinds.length === 0) {
    return (
      <div style={page}><div style={inner}>
        <Empty icon="🔒" title={t("insp.error.forbidden")}
          hint={zh
            ? `没有「${t(KIND_LABEL[alias.chip])}」的查看权限 —— 找管理员确认能力配置。`
            : `No access to ${t(KIND_LABEL[alias.chip])} — ask an administrator.`} />
      </div></div>
    );
  }

  /* ⚠️ 弹窗只挂在 kind 页这一支：`scope` / `config` 两页没有 finding 列表，
     也就没有判读入口。挂在那两支上是死代码，而死代码会让下一个人以为
     那两页也能派判读。 */
  return (
    <>
    {judgeModal}
    <TriagePage
      /* 🔴 `key` 随当前子页变 —— 切页时组件卸载，`sev` / `chip` 两个筛选
         state 跟着重置。

         没有它的表现：在高负载页点了「紧急 3」这个分档筛选，切到「闲置与成本」
         → 页面显示金额条「$1,240 每月合计可省」，下面却是空态「没有符合筛选
         条件的项」。因为切子页只换 `dashboardId` prop，`<TriagePage>` 的位置
         与类型不变 → 组件不卸载 → `sev` 保持 "CRITICAL"，而闲置类 severity
         恒为 INFO，过滤后必然为 0。

         而闲置页把那排严重度按钮换成了金额条，所以客户在屏幕上**找不到任何
         处于选中态的筛选控件** —— 界面自相矛盾且没有线索。 */
      key={String(alias.chip ?? "all")}
      byKind={byKind} overview={overview} loading={loading} refreshing={refreshing}
      zh={zh} t={t} kinds={wantKinds} single={alias.chip}
      opsOpen={!!alias.ops}
      runBar={mayRun ? (
        <>
          {(["high", "idle"] as const).map(runButton)}
          {/*
            选账号的弹层。统一视图之后页面上没有「当前账号」这个概念了，
            所以「跑哪个账号」必须由这次点击自己说清。

            🔴 **单层、多选、一个「执行」。** 上一版是「一排账号按钮 +
               『全部账号』→ 第二屏五行说明 → 确认」。客户原话：
               「被挡住了，我点全部账号后又出来一大堆内容，絮絮叨叨贫死了。
                 不如一个 dropdown 让客户一个一个 check 账号然后执行就完了。
                 不要再出现第二步和描述性的大段文字了。」

            ⚠️ 护栏没有取消，只是**压成一行**（`insp.run.costLine`）：
               会花什么钱、占今天的槽位、撤不回来、今天跑过的会被跳过。
               这四件事一件都不能省 —— 少一件就是客户不知道自己在买什么。
               `weekdaysAndBatchRun.render.test.tsx` 同时钉住「四件事都在」
               和「必须是一行、不许超长」。
          */}
          {runPick && (
            <div role="group"
              aria-label={zh ? "选择账号" : "Select accounts"}
              style={{
                position: "absolute", zIndex: 30, marginTop: 30, right: 0,
                background: C.card, border: `1px solid ${C.line}`,
                borderRadius: 10, padding: 10, minWidth: 250, maxWidth: 330,
                boxShadow: "0 8px 24px rgba(0,0,0,.14)",
              }}>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 7 }}>
                {zh ? `跑哪些账号的${runPick === "high" ? "高负载" : "闲置"}？`
                  : `Run ${runPick} inspection for which accounts?`}
              </div>
              <div style={{
                display: "grid", gap: 2, maxHeight: 200, overflowY: "auto",
              }}>
                {runTargets.map((a) => (
                  <label key={a.id || "_self"} className="insp-row"
                    style={{
                      display: "flex", alignItems: "center", gap: 7,
                      padding: "4px 5px", borderRadius: 6,
                      fontSize: 12.5, color: C.text, cursor: "pointer",
                    }}>
                    <input type="checkbox" name={`run_acct_${a.id || "self"}`}
                      checked={runSel.has(a.id)}
                      onChange={() => toggleRunAcct(a.id)} />
                    {a.label}
                  </label>
                ))}
              </div>
              {/* 全选 / 清空：账号多的时候「一个一个 check」太慢。
                  ⚠️ 是**链接**而不是按钮 —— 它们只改勾选，不提交。 */}
              <div style={{
                display: "flex", gap: 10, margin: "6px 0 2px", fontSize: 11.5,
              }}>
                <a href="#" onClick={(e) => {
                  e.preventDefault();
                  setRunSel(new Set(runTargets.map((a) => a.id)));
                }} style={{ color: C.blue }}>{zh ? "全选" : "All"}</a>
                <a href="#" onClick={(e) => { e.preventDefault(); setRunSel(new Set()); }}
                  style={{ color: C.muted }}>{zh ? "清空" : "None"}</a>
              </div>
              <div style={{
                fontSize: 11, color: C.amber, lineHeight: 1.5,
                margin: "4px 0 8px",
              }}>
                {t("insp.run.costLine")}
              </div>
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <Btn size="small" variant="link" onClick={() => setRunPick("")}>
                  {t("insp.act.cancel")}
                </Btn>
                {/* 🔴 勾多个时是 danger 色。一次点击对 N 个账号各跑一轮，
                    花的钱与时长乘 N 且撤不回来 —— 那不该与「跑一个」长得一样。
                    ⚠️ 空选时灰掉并**说出原因**（`Btn` 的 API 强制给理由）。 */}
                <Btn size="small"
                  variant={runSel.size > 1 ? "danger" : "primary"}
                  onClick={() => runGo(runPick)}
                  disabledReason={runSel.size === 0
                    ? (zh ? "先勾选至少一个账号" : "Select at least one account")
                    : ""}>
                  {runSel.size > 1
                    ? (zh ? `执行（${runSel.size} 个账号）` : `Run (${runSel.size})`)
                    : (zh ? "执行" : "Run")}
                </Btn>
              </div>
            </div>
          )}
        </>
      ) : null}
      runs={runs}
      onDismissRun={(rt) => setSlot(rt, { phase: "idle", msg: "" })}
      accountId={accountId} highlight={highlight}
      mayScope={mayScope} reload={reload}
      /* 🔴 判读只在有 `action:inspection:run` 时给 —— 它直接花 DA 额度，
         与「手动跑一轮」同一个能力节点。没权限时**不渲染**按钮而不是灰掉：
         灰着等于在界面上摆一个用户无法解决的问题（本仓库既有约定）。 */
      onJudge={mayRun ? setAskJudge : undefined}
      judging={judging} judgeMsg={judgeMsg} justJudged={justJudged}
      onDismissJudge={() => setJudgeMsg(null)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 首屏骨架
// ---------------------------------------------------------------------------

/**
 * 首次加载用骨架屏而不是一行「…」。
 *
 * 骨架保住了最终布局的几何，内容到达时**不跳**；而一行「…」会让页面在
 * 内容到达的那一刻整体重排，视觉上像闪了一下。
 */
function PageSkeleton({ title }: { title: string }) {
  return (
    <div style={page}><div style={inner}>
      <PageHeader title={title} />
      <SkeletonCards n={3} />
    </div></div>
  );
}

// ---------------------------------------------------------------------------
// 待处置
// ---------------------------------------------------------------------------

/**
 * 每一类的展示排序键。**这是三类各自一页的核心理由** ——
 * 一页只能有一个排序键，而三类要的键不同。
 *
 * ```
 * high_load    severity ↓ → days_active ↓     「紧急的、已经拖了很久的」在最上面
 * idle         savings_usd ↓ → idle_score ↓    「省钱最多的」在最上面
 * structural   severity ↓ → rule 字典序        配置风险按严重度；同档按规则聚在一起
 * ```
 *
 * 🔴 闲置**不能**按 severity 排：闲置类的 severity 恒为 `INFO`
 * （`idle_findings` 里写死 `severity=Severity.INFO`），所以按 severity 排
 * 等于不排 —— 退化成 `days_active` 序，而「发现得早」跟「值得先处置」无关。
 * 金额才是这一页的决策依据。
 *
 * ⚠️ `savings_usd` 可能是 null（估不出价）。null 排在有金额的**后面**，
 * 但不能当 0 参与比较 —— 那会让「估不出价」和「省 $0」混成一档。
 *
 * 🔴 闲置那一支**先按 `savings_precision` 分桶、再按金额**（R4.6）。
 * `dto.PricePrecision.confidence_rank` 的 docstring 写着不分桶的后果：
 *
 * > 一个 `COARSE_DEFAULT` 猜出来的 $1000 会排在一个精确算出来的 $200 前面，
 * > 而客户会照着它去动资源。
 *
 * 而这一页的排序**就是**处置顺序（客户从上往下做），所以「谁排第一」等于
 * 「先动哪台机器」。用一个连规格关键字都没命中的兜底常数决定那件事是不行的。
 */
function sortForKind(rows: FindingRow[], kind: FindingKind | undefined) {
  const rank = (s: Severity) => {
    const i = SEVERITIES.indexOf(s);
    return i < 0 ? SEVERITIES.length : i;
  };
  const bySev = (a: FindingRow, b: FindingRow) =>
    rank(a.severity) - rank(b.severity);
  if (kind === "idle") {
    return rows.sort((a, b) => {
      /* ① 精度桶。⚠️ 只在**两边都有金额**时才分桶 —— 没有金额的行其
         `savings_precision` 通常是空串（落最后一桶），拿它参与分桶会让
         「估不出价」的行按精度散开，而它们本该整块沉底（见 ②）。 */
      const av = a.savings_usd, bv = b.savings_usd;
      if (av != null && bv != null) {
        const ar = precisionRank(a.savings_precision);
        const br = precisionRank(b.savings_precision);
        if (ar !== br) return ar - br;
        if (av !== bv) return bv - av;
      }
      // ② null 沉底：有金额的在前，都没金额的再比闲置分。
      if (av != null && bv == null) return -1;
      if (av == null && bv != null) return 1;
      return (b.idle_score ?? -1) - (a.idle_score ?? -1)
        || a.finding_id.localeCompare(b.finding_id);
    });
  }
  if (kind === "structural") {
    return rows.sort((a, b) => bySev(a, b)
      || a.rule.localeCompare(b.rule)
      || a.finding_id.localeCompare(b.finding_id));
  }
  // 高负载（以及多 kind 兜底）：紧急度 → 已持续天数
  return rows.sort((a, b) => bySev(a, b)
    || (b.days_active ?? 0) - (a.days_active ?? 0)
    || a.finding_id.localeCompare(b.finding_id));
}

/** 每一页的标题 / 副标题 / 排序说明。 */
const KIND_PAGE: Record<FindingKind, {
  title: string; sub: { zh: string; en: string }; order: { zh: string; en: string };
}> = {
  high_load: {
    title: "insp.tab.highLoad",
    sub: {
      zh: "指标越过阈值的资源。按紧急度排 —— 最上面那条最该先看。",
      en: "Resources past their thresholds, most urgent first.",
    },
    order: { zh: "按严重度 → 已持续天数", en: "By severity → days active" },
  },
  idle: {
    title: "insp.tab.idle",
    /**
     * 🔴 「规则判定，不派 AI 判读」这半句是**页面级**的一次性说明。
     *
     *    闲置轮设计上不调 DA（`gating.DETERMINISTIC_RUN_TYPES = {"idle"}`）——
     *    三个维度加权算分就是结论。而在这句话存在之前，客户唯一能看到的信号是
     *    每条卡片上的琥珀色「判读缺失」+ 详情抽屉里「判读是异步回来的（通常
     *    1~3 分钟）」，于是去等一个**永远不会来**的东西
     *    （2026-08-31 实机，用户原话：「到底有没有AI判读？」）。
     *
     * ⚠️ 说在**页面上说一次**，不在 16 条 finding 上各重复一遍。
     *    每条上都挂一句「本轮不派 AI」是纯噪音：它对那一条没有任何可操作信息，
     *    而客户学会忽略之后，真正该看的「判读缺失」（额度耗尽那种）也会被一起忽略。
     */
    sub: {
      zh: "多维加权评分判定为低利用的资源。规则判定，不派 AI 判读。按每月可省金额排。",
      en: "Under-utilised resources by weighted score. Rule-based, no AI analysis. "
        + "Highest monthly saving first.",
    },
    order: { zh: "按每月可省 → 闲置分", en: "By monthly saving → idle score" },
  },
  structural: {
    title: "insp.tab.structural",
    sub: {
      // 客户原话：「我也没有要结构性风险，不知道这个是做什么的」——
      // 所以副标题必须一句话说清它查什么，且强调它**不看指标**。
      zh: "只看配置、不看指标的检查：证书临期、引擎将 EOL、备份未开、单 AZ、gp2 卷等。",
      en: "Config-only checks: expiring CA certs, engine EOL, backups off, single-AZ, gp2 volumes.",
    },
    order: { zh: "按严重度 → 规则", en: "By severity → rule" },
  },
};

function TriagePage({
  byKind, overview, loading, refreshing, zh, t, kinds, single, opsOpen,
  runBar, runs, onDismissRun, accountId, highlight,
  mayScope, reload, onJudge, judging = "", justJudged, judgeMsg, onDismissJudge,
}: {
  byKind: Partial<Record<FindingKind, FindingsData>>;
  overview: OverviewData | null;
  loading: boolean;
  refreshing: boolean;
  zh: boolean;
  t: (k: string) => string;
  kinds: readonly FindingKind[];
  /** 单类页看哪一类。给了它就不渲染类别 chip（只有一类，chip 无意义）。 */
  single?: FindingKind;
  opsOpen: boolean;

  runBar: React.ReactNode;
  runs: Record<"high" | "idle", RunSlot>;
  onDismissRun: (rt: "high" | "idle") => void;
  accountId: string;
  highlight: string;
  mayScope: boolean;
  reload: () => void;
  /**
   * **请求**派一次 DA 判读 —— 打开确认弹窗，不直接发请求。
   *
   * ⚠️ 收**整行** `FindingRow` 而不是 `findingId`：弹窗要显示资源名 / 账号 /
   *    闲置分 / 预计月省（全部读这一行，不发请求），而真正派发时也要用它自己的
   *    `account_id`（统一视图下列表是跨账号的，用页面选择器的值会派到别的账号）。
   */
  onJudge?: (f: FindingRow) => void;
  /** 正在派的那条 finding_id（空 = 空闲）。按钮据此进 loading + 防重复点。 */
  judging?: string;
  /**
   * 刚派成功、列表可能还没刷新到的 finding_id。见外层同名 state 的说明。
   * 与 `da_task_id` **取或**：任一为真就当「已派过」。
   */
  justJudged?: ReadonlySet<string>;
  judgeMsg?: { type: "success" | "error" | "warning"; text: string } | null;
  onDismissJudge?: () => void;
}) {
  /**
   * 类别筛选。单类页里只剩「本类」与「已解决」两态。
   *
   * ⚠️ 单类页仍然保留 `resolved` chip —— 「昨天那条去哪了」在单类页上
   * 同样会被问到，而它是唯一能回答的入口。
   */
  const [chip, setChip] = useState<FindingKind | "" | "resolved">("");
  const [sev, setSev] = useState<Severity | "">("");
  /**
   * 账号 / 实例名搜索。
   *
   * 🔴 统一视图之后账号是**筛选维度**，不是加载维度。原来顶部那个选择器
   * 决定「加载哪个账号的分区」—— 客户一次只能看一个账号，还得自己记住
   * 哪个账号有事。现在一次列全部，用这个框收窄。
   *
   * ⚠️ 同时匹配账号 ID 与实例名：客户手里既有「698 那台库怎么了」也有
   * 「insp-t4g-mysql 在哪个账号」两种问法，分成两个框会让他先猜该用哪个。
   */
  const [q, setQ] = useState("");
  /**
   * 抽屉里显示哪一条。
   *
   * ⚠️ 拆成「手动打开的」+「深链带的」两个来源，**派生**出最终值 ——
   * 而不是在 effect 里 `setOpen(深链那条)`。effect 里 setState 会触发
   * 级联渲染（eslint 的 `react-hooks/set-state-in-effect`），而且会先渲染
   * 一帧没有抽屉的列表再弹出来。
   */
  /**
   * 手动打开的那一条的**快照**。
   *
   * 🔴 它只是「打开了哪一条」的身份 + 一份兜底副本，**不是抽屉渲染的数据源**
   * —— 数据源见下面派生出来的 `manual`。
   *
   * 这一层区分是 2026-09-01 客户实测那条缺陷的修法：抽屉里所有字段都读
   * `row` prop，而 `row` 原来直接就是这个快照。于是
   *
   * ```
   * 点「深入分析」→ 派发成功 → 后端写上 da_task_id → reload() 重取列表
   *   → 列表里那张卡片更新了（它读 byKind）
   *   → 而抽屉手里还是点开那一刻的旧对象
   *   ⇒ 抽屉里「判读已派发」那一块不出现（判据是 row.da_task_id）
   *   ⇒ 蓝色的「深入分析」按钮还在、还能点（判据是 !row.da_task_id）
   *   ⇒ 客户再点一次 → 后端拒 already_dispatched → 看起来像失败
   * ```
   *
   * ⚠️ 深链那条（`linked`）一直是从 `all` 派生的，所以它没有这个问题 ——
   * 也就是同一个抽屉在两条打开路径下行为不同，而那种不一致最难被发现。
   */
  const [manualSnap, setManualSnap] = useState<FindingRow | null>(null);
  /** 深链那条被关过了。**只生效一次** —— 客户关掉之后不该被再弹开。 */
  const [linkConsumed, setLinkConsumed] = useState(false);
  const [excluding, setExcluding] = useState<FindingRow | null>(null);
  const [flash, setFlash] = useState<
    { type: "success" | "warning"; head: string; body?: string } | null>(null);
  // 「系统状态」默认折起。`opsOpen` 来自老的 `?tab=overview` 深链。
  const [ops, setOps] = useState(opsOpen);

  /**
   * 本页的 finding，按**本类的**排序键排（`sortForKind`）。
   *
   * ⚠️ 后端读侧（`inspection.mjs` 的 `rows.sort`）给的是
   * `severity ↓ → days_active ↓ → finding_id` —— 那是跨类可比的通用序。
   * 单类页在它之上按本类的决策依据重排（闲置按金额）。前端重排是安全的：
   * 排序不是判定，R9.1 禁的是**补算数字**，不是换个顺序显示。
   *
   * ⚠️ `dispatch.py` 里那套复合优先级是 **DA 派发选取**用的，不是展示序 ——
   * 引进来会让「看板上第一条」与「今天最该处置的一条」是两个不同的东西。
   */
  const all = useMemo(() => {
    const rows: FindingRow[] = [];
    for (const k of kinds) {
      const d = byKind[k];
      if (d) rows.push(...d.findings);
    }
    return sortForKind(rows, single);
  }, [byKind, kinds, single]);

  /**
   * 状态机四态里哪些算「待处置」。
   *
   * `resolved` 的不进主列表 —— 它们已经不需要动作了。但也**不能删掉**：
   * 「昨天那条去哪了」是个真实的问题，所以给一个 chip 让它们可查。
   */
  /**
   * 这一条**派过判读了没有**。卡片与抽屉共用这一处判据。
   *
   * 🔴 两个来源取或，缺任一都会出现「按钮还能点」：
   *
   * ```
   * f.da_task_id            权威值，但要等 reload() 把列表重取回来
   * justJudged.has(id)      本次会话刚派成功 —— 补上那几百毫秒的窗口
   * ```
   *
   * ⚠️ 判据必须**只有这一处**。原来卡片写 `!f.da_task_id`、抽屉写
   * `!row.da_task_id`，两处各自判 —— 而抽屉那边拿的是过期快照，于是同一条
   * finding 在列表上显示「已派发」而抽屉里按钮还亮着（2026-09-01 客户实测）。
   */
  const isJudged = (f: FindingRow) =>
    Boolean(f.da_task_id) || Boolean(justJudged?.has(f.finding_id));

  const isDone = (f: FindingRow) => f.state === "resolved";
  const openRows = all.filter((f) => !isDone(f));
  const doneRows = all.filter(isDone);

  const shown = useMemo(() => {
    let rows = chip === "resolved" ? doneRows : openRows;
    if (chip && chip !== "resolved") rows = rows.filter((f) => f.kind === chip);
    if (sev) rows = rows.filter((f) => f.severity === sev);
    // 账号 / 实例名 / 指标 搜索。⚠️ 大小写不敏感 —— 实例名常带大小写混排
    //    （`insp-T4g-MySQL`），要求精确大小写等于让这个框大部分时候搜不到。
    const needle = q.trim().toLowerCase();
    if (needle) {
      rows = rows.filter((f) =>
        f.account_id.includes(needle)
        || f.instance.toLowerCase().includes(needle)
        || f.metric.toLowerCase().includes(needle)
        || (f.rule || "").toLowerCase().includes(needle));
    }
    return rows;
  }, [chip, sev, q, openRows, doneRows]);

  /** 当前结果里出现过的账号（给 filter 框做提示，也用来判断要不要显示账号列）。 */
  const acctsInView = useMemo(
    () => [...new Set(all.map((f) => f.account_id))].filter(Boolean).sort(),
    [all]);

  const bySev = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of SEVERITIES) out[s] = 0;
    for (const f of openRows) if (f.severity in out) out[f.severity] += 1;
    return out;
  }, [openRows]);

  /**
   * 未做根因分析的条数（R10.6）。不显示会让客户以为看板就是全部。
   *
   * 🔴 **用后端算的 `without_judgment`，不在前端重算**（2026-09-01 实测）。
   * 这里原来是 `openRows.filter((f) => !f.has_judgment).length` —— 只判一个
   * 字段，于是 BFF 里那四条判据全被绕过：
   *
   * ```
   * !has_judgment                    ← 前端只看这个
   * && !conclusion                   ← 确定性结论（新数据）
   * && !NEEDS_NO_AI.has(skip_reason) ← 兼容存量行
   * && !DETERMINISTIC_KINDS.has(kind)← 闲置 + 配置检查结构上不派 DA
   * ```
   *
   * 后果是闲置页顶上恒挂「另有 13 项未做根因分析」，而那一页**没有一条**需要
   * AI 判读。同一个页面上另一处（系统状态区）用的是对的 `without_judgment`
   * —— 两个数两套判据。
   *
   * ⚠️ 与 `unclassified` / `truncatedAt` 同样用 `max` 而不是 `sum`：
   * 三类各发一次请求，而这个数是 BFF 在 kind 过滤**之后**算的，
   * 所以每类给的是自己那一份，跨类要取和 —— 但同一 kind 的多账号已经合并过了。
   * 这里按 kind 求和是对的。
   */
  const noJudgment = kinds.reduce(
    (n, k) => n + (byKind[k]?.without_judgment ?? 0), 0);
  /**
   * 规则码未登记的条数（正常恒 0）。>0 意味着有 finding 三页都进不去。
   *
   * 🔴 用 `max` 而不是 `sum`。BFF 是在 **kind 过滤之前**算这个数的
   * （`inspection.mjs` 的 `queryFindings`），所以每个 kind 的响应里都带着
   * 同一个**全局**数 —— 相加会得到 N 倍：
   *
   * ```
   * 2 条未归类 + 三类权限 → 三次请求各返回 unclassified: 2
   *                      → 页面写「有 6 条 finding 无法归类」
   * ```
   *
   * 而这条提示存在的意义就是让人能对上账（总数 vs 三页之和）——
   * 它自己对不上就没有意义了。
   */
  const unclassified = Math.max(
    0, ...kinds.map((k) => byKind[k]?.unclassified ?? 0));
  // 被读侧 5000 上限截断的条数（0 = 没截断）。
  // ⚠️ 与 `unclassified` 同样用 `max` 而不是 `sum`：三类各发一次请求，
  //    同一份数据被截断的位置是一样的，相加会得到三倍。
  //
  // 🔴 **总览那一份必须一起算进来。** 它不带 kind 过滤、一次扫全量，
  //    所以它是最先撞上 5000 的那一个 —— 单个 kind 页都还没截断时它可能
  //    已经截了，而总览区的 total / by_severity / by_state / parse_quality
  //    全都基于截断后的集合。漏掉它的表现是「运维视图上的截断完全不可见」。
  const truncatedAt = Math.max(
    0, overview?.truncated_at ?? 0,
    ...kinds.map((k) => byKind[k]?.truncated_at ?? 0));

  const gap = overview?.dispatch_gap ?? 0;
  /**
   * 系统状态区是否展开。**派生值**，不是 effect 纠偏。
   *
   * 🔴 `gap > 0` 时**强制展开且不允许折叠**。那个数意味着有判读永久回不来
   * （dispatched > mapped），折叠一个已知的数据缺口等于把它藏起来。
   * 折叠按钮那时会说明为什么点不动。
   */
  const opsShown = ops || gap > 0;

  /**
   * 深链要打开的那一条（R11b.7「一跳到具体 finding，不是跳列表页让客户
   * 自己翻」）。数据到达前找不到，到达后派生出来。
   */
  const linked = useMemo(
    () => (highlight ? all.find((f) => f.finding_id === highlight) ?? null : null),
    [highlight, all]);
  /**
   * 抽屉真正渲染的那一条：**按 finding_id 从最新一次取数里重新查**。
   *
   * 🔴 这是「派发后抽屉不更新」的修法。`reload()` 之后 `all` 是新对象，
   * 查一次就自动带上 `da_task_id` / `da_parse_status` / `da_body`，
   * 抽屉里的「判读已派发」和按钮的显隐随之正确。
   *
   * ⚠️ 查不到时**回落到快照而不是 null**。查不到有正常原因（下一轮把它
   * resolve 了并从当前 chip 里筛掉、或者被清理掉了），而 `null` 会让抽屉
   * **凭空消失** —— 客户正在读的东西突然不见了，比显示一份稍旧的数据糟得多。
   */
  const manual = useMemo(() => {
    if (!manualSnap) return null;
    return all.find((f) => f.finding_id === manualSnap.finding_id) ?? manualSnap;
  }, [manualSnap, all]);
  const open = manual ?? (linkConsumed ? null : linked);
  const closeDrawer = () => { setManualSnap(null); setLinkConsumed(true); };

  /** 单类页的标题 / 副标题 / 排序说明。多 kind（不该再出现）时为 null。 */
  const meta = single ? KIND_PAGE[single] : null;

  /**
   * 闲置页的合计可省金额。
   *
   * 🔴 只加**有金额**的条目，且把「有几条估不出价」单独说出来。
   * 把 null 当 0 加进去的表现是：10 条里 7 条估不出价，页面写「合计可省
   * $86」，客户拿这个数去做预算 —— 而真实可省额可能是它的三倍。
   *
   * ⚠️ **必须在下面那个 `if (loading) return` 之前。** hooks 不能在条件
   * return 之后调用 —— 第一版放在 `chipFor` 旁边（return 之后），
   * 26 个测试直接 "Rendered more hooks than during the previous render"。
   */
  const savings = useMemo(() => {
    let sum = 0, priced = 0, unpriced = 0, coarse = 0;
    /** 最不可信的那一档的**精度字符串**（不是 rank）—— 要拿它查
        `PRECISION_LABEL` 拿到给客户看的那句话。 */
    let worst = "", worstRank = -1;
    for (const f of openRows) {
      if (f.savings_usd != null) {
        sum += f.savings_usd; priced += 1;
        /* 🔴 **合计里有几条是粗估的**。当前没有任何代码路径产出 `exact_api`
           （`isCoarse` 的注释写着这件事），所以这个数实际恒等于 `priced`
           —— 但判据仍按字段算而不是写死，否则将来真接上 Price List API
           之后这一行会继续说「全部粗估」。 */
        if (isCoarse(f.savings_precision)) coarse += 1;
        // 最差的那一档决定整个合计有多可信（一颗老鼠屎原则）。
        const r = precisionRank(f.savings_precision);
        if (r > worstRank) { worstRank = r; worst = f.savings_precision; }
      } else unpriced += 1;
    }
    return { sum, priced, unpriced, coarse, worst };
  }, [openRows]);

  // 骨架也用本页标题 —— 写死「待处置」会让加载中的闲置页顶着别的页名。
  if (loading) {
    return <PageSkeleton
      title={meta ? t(meta.title) : (zh ? "待处置" : "To act on")} />;
  }

  /** 最近一轮的状态，按 run_type 各一条。空态与提示都用它。 */
  const lastRuns = (() => {
    const out: { rt: "high" | "idle"; run: FindingsData["last_run"] }[] = [];
    const high = byKind.high_load?.last_run ?? null;
    const idle = byKind.idle?.last_run ?? byKind.structural?.last_run ?? null;
    if (kinds.includes("high_load")) out.push({ rt: "high", run: high });
    if (kinds.includes("idle") || kinds.includes("structural")) {
      out.push({ rt: "idle", run: idle });
    }
    return out;
  })();

  const chipFor = (k: FindingKind) => {
    const n = openRows.filter((f) => f.kind === k).length;
    return (
      <Chip key={k} active={chip === k} name={`chip_${k}`}
        onClick={() => setChip(chip === k ? "" : k)}>
        {t(KIND_LABEL[k])} {n}
      </Chip>
    );
  };

  return (
    <div style={page}>
      <div style={inner}>
        <PageHeader
          title={meta ? t(meta.title) : (zh ? "待处置" : "To act on")}
          count={openRows.length}
          description={meta
            ? `${zh ? meta.sub.zh : meta.sub.en}（${zh ? meta.order.zh : meta.order.en}）`
            : (zh
              ? "按严重度和已持续天数排序。点任意一条看判读全文与处置动作。"
              : "Sorted by severity then age. Click any card for the full analysis.")}
          // 🔴 页头**不再有账号选择器**。统一视图之后账号是筛选维度 ——
          //    筛选框在列表上方那一排（与严重度、类别 chip 同层）。
          //    这里原来那个与 ChatApp 右上角那个是**两个**选择器，
          //    客户原话：「这两个地方是不是功能一样？简直是多余」。
          // ⚠️ `position: relative` 是给触发弹层定位用的。
          actions={
            <div style={{ position: "relative", display: "flex", gap: 8,
              alignItems: "center" }}>
              {/* 🔴 **刷新按钮**（2026-09-01 客户实测提的）。
                  `reload()` 与 `refreshing` 一直都有，但页面上**没有任何
                  触发它的控件** —— 只有写操作之后自动调。于是客户想看
                  「判读回来了没」只能按浏览器刷新（整页重载：丢滚动位置、
                  丢筛选、丢展开的抽屉，还要重跑一次首屏骨架）。

                  ⚠️ 与「跑高负载 / 跑闲置」同一排但**放在它们左边**：
                     刷新是零代价的读操作，那两个是花钱的写操作 ——
                     顺序上把安全的放在手边，危险的放远一点。
                  ⚠️ `loading` 复用 `refreshing`，所以连点无效（本来就在取数）。
                  ⚠️ 文案只有「刷新」两个字：它旁边就是两个「跑…」按钮，
                     写成「刷新数据」会让三个按钮读起来一样长、反而更难区分。 */}
              <Btn size="small" onClick={reload} loading={refreshing}
                iconLeft="⟳"
                title={zh
                  ? "重新读取列表与总览（不重跑巡检、不花钱）"
                  : "Re-read findings and overview (does not re-run inspection)"}>
                {zh ? "刷新" : "Refresh"}
              </Btn>
              
              {runBar}
            </div>
          } />

        {refreshing && <div className="insp-bar" style={{ marginBottom: 8 }} />}

        {/* 触发结果条。**按 run_type 各一条** —— 合并会让「高负载失败了」
            与「闲置失败了」分不开。 */}
        {(["high", "idle"] as const).map((rt) => runs[rt].msg ? (
          <Alert key={rt}
            /* 🔴 `submitted` 映 **warning** 而不是 success。
                那条路（全部账号）**没有轮询**，所以我们只知道 invoke 成功了，
                不知道任何一个账号跑成没跑成。给绿色 ✓ 等于替后端做了一个
                我们没有证据的承诺 —— 而这个按钮存在的理由就是客户不信数。 */
            type={runs[rt].phase === "error" ? "error"
              : (runs[rt].phase === "timeout" || runs[rt].phase === "submitted")
                ? "warning" : "success"}
            header={`${rt === "high" ? (zh ? "高负载轮" : "High-load") : (zh ? "闲置轮" : "Idle")}：${runs[rt].msg}`}
            onDismiss={() => onDismissRun(rt)} />
        ) : null)}

        {/* 判读派发的结果条。
            ⚠️ 与上面「跑一轮」的结果条**分开** —— 合并会让「判读派发失败」
               与「那一轮跑失败」分不开，而两者的下一步完全不同。

            🔴 **抽屉开着时这一份不渲染**（同一条回执改由抽屉自己显示）。
               派发只能从抽屉里发起，而抽屉 `zIndex: 1000` 盖住这里 ——
               所以这一份在派发的那一刻**必然**是看不见的。

               两处同时渲染的话视觉上仍是一条（被盖住了），但 DOM 里是两份：
               读屏会把同一句话念两遍，用例里 `getByText` 也会因「找到两个」
               直接抛。互斥之后关掉抽屉那份会回到这里 —— 它仍然是
               「你刚才做了什么」的痕迹。 */}
        {judgeMsg && !open && (
          <Alert type={judgeMsg.type}
            header={judgeMsg.text}
            onDismiss={onDismissJudge} />
        )}

        {flash && (
          <Alert type={flash.type} header={flash.head}
            onDismiss={() => setFlash(null)}>{flash.body}</Alert>
        )}

        {/* 🔴 列表被 5000 上限截断 —— `total` 与四个分档统计**全部失真**。
            不显示的话与「真的只有这么多」完全无法区分（`queryAll` 那个
            break 原来是静默的）。 */}
        {truncatedAt > 0 && (
          <Alert type="warning"
            header={zh ? `列表被截断在 ${truncatedAt} 条`
              : `List truncated at ${truncatedAt}`}>
            {zh
              ? "这个账号的 finding 超过读侧上限，下面的总数、严重度分档、判读质量统计都只覆盖前 " + truncatedAt + " 条。先用严重度筛选收窄，或者清理已解决的条目。"
              : `This account has more findings than the read-side cap. The counts and breakdowns below cover only the first ${truncatedAt}.`}
          </Alert>
        )}

        {/* 🔴 **派发缺口要在首屏说一次。**

            它原来只在页面**最底部**的「系统状态」折叠区里（那一区因为
            `locked={gap > 0}` 强制展开，但展开的是一个首屏外的区）。
            一页 20 条卡片之后才出现的红字等于没出现 —— 而这一条的含义是
            「有判读永久回不来」，那些 finding 会一直停在「未做根因分析」。

            ⚠️ 与下面「系统状态」区里那条**不重复措辞**：这里只说结论 + 指路，
               细节（哪几轮、多少条）留在那一区。两处都写整段的话客户读第二遍
               才发现是同一件事。

            ⚠️ 判据用 `gap > 0` 而不是 `overview?.dispatch_gap` —— 上面那个
               常量已经带了 `?? 0` 兜底，两处各写一遍会分叉。 */}
        {gap > 0 && (
          <Alert type="error"
            header={t("insp.warn.dispatchGap").replace("{n}", String(gap))}>
            {zh
              ? "那些判读永久回不来，对应的 finding 会一直停在「未做根因分析」。"
                + "明细在页面底部「系统状态」里。"
              : "Those analyses will never arrive; details under System status."}
          </Alert>
        )}

        {/* 🔴 规则码未登记 —— 那些 finding 一页都进不去。正常恒 0。 */}
        {unclassified > 0 && (
          <Alert type="warning"
            header={zh ? `有 ${unclassified} 条 finding 无法归类` : `${unclassified} unclassified findings`}>
            {zh
              ? "它们的规则码没有登记在读侧的 KIND_RULES 里，所以三类筛选都收不到。这是判定侧加了新规则而看板没跟上 —— 需要发一版修。"
              : "Their rule codes are not registered in KIND_RULES, so no filter matches them."}
          </Alert>
        )}

        {/*
          闲置页的头图是**金额**，不是严重度分档。

          🔴 闲置类的 severity 恒为 `INFO`（`assemble.idle_findings` 里写死
          `severity=Severity.INFO`），所以那四个格子永远是「0 / 0 / 0 / N」——
          三个恒零的按钮占着首屏最好的位置，还让人以为「闲置没有严重的」是
          一个判定结论，而它只是这一类压根不分级。
          这一页的决策依据是每月能省多少。
        */}
        {single === "idle" ? (
          <div style={{
            display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12,
            alignItems: "baseline", background: C.card,
            border: `1px solid ${C.line}`, borderLeft: `3px solid ${C.green}`,
            borderRadius: 9, padding: "10px 14px",
          }}>
            {/* 🔴 走 `fmtMoney` 而不是自己 `Math.round`。
                `Math.round(0.4)` = 0 → 判据 `sum > 0` 为真 → 渲染 **`$0`**，
                而这一页 22px 最醒目的位置写着「每月合计可省 $0」。
                `fmtMoney` 对 (0, 1) 给 `<$1` —— 那是这个数字的真实形态。

                ⚠️ 这也是全页唯一一处自己拼 `$` 的地方，卡片那侧一直走
                   `fmtMoney`。同一个金额两套格式化就是这类缺陷的来源。 */}
            <span style={{ fontSize: 22, fontWeight: 700, color: C.green }}>
              {savings.priced > 0 ? fmtMoney(savings.sum) : "—"}
            </span>
            <span style={{ fontSize: 12, color: C.muted }}>
              {/* 🔴 **口径写清楚：待处置的全部，不是当前筛选结果。**
                  这个合计基于 `openRows`，而下面的列表是 `shown`（受 chip /
                  severity / 搜索词影响）。筛掉一半之后金额不变，客户会以为
                  「筛选没生效」或者「这个数是筛出来的那几条的和」。 */}
              {zh ? `每月合计可省 · 待处置全部 ${savings.priced} 条已估价`
                : `total monthly saving · ${savings.priced} priced (all open)`}
            </span>
            {/* 🔴 **粗估要标出来。** 22px 的绿色数字看起来像一个可入账的数，
                而 `coarse_default` 那一档的含义是「连规格关键字都没命中，
                用的是全局兜底常数」—— `PRECISION_LABEL` 里那句话原文是
                「不要拿它做预算」。而这一行此前没有任何精度提示。 */}
            {savings.coarse > 0 && (
              <span style={{ fontSize: 12, color: C.amber }}
                /* 最不可信那一档的原话（`PRECISION_LABEL` 是与后端
                   `PricePrecision` 对齐的单一来源，这里**不另写一份文案**）。
                   ⚠️ 认不出的档位不给 title —— 编一句话比留空更糟。 */
                title={PRECISION_LABEL[savings.worst]
                  ? (zh ? PRECISION_LABEL[savings.worst].zh
                    : PRECISION_LABEL[savings.worst].en)
                  : undefined}>
                {zh ? `⚠️ 全部为粗估，不要直接拿去做预算`
                  : "⚠️ coarse estimates — do not budget against this"}
              </span>
            )}
            {/* 🔴 估不出价的条数必须显示。不显示的表现是客户拿合计金额去做
                预算，而真实可省额可能是它的数倍。 */}
            {savings.unpriced > 0 && (
              <span style={{ fontSize: 12, color: C.amber }}>
                {zh ? `另有 ${savings.unpriced} 条估不出价（未计入）`
                  : `${savings.unpriced} without a price estimate (excluded)`}
              </span>
            )}
          </div>
        ) : (
        /* 严重度分档。**可点** —— 客户的第一维度就是严重度。 */
        <div style={{
          display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10,
        }}>
          {SEVERITIES.map((s) => (
            <button key={s} onClick={() => setSev(sev === s ? "" : s)}
              name={`sev_${s}`}
              aria-pressed={sev === s}
              style={{
                display: "flex", alignItems: "baseline", gap: 7,
                background: sev === s ? "var(--menu-hover)" : C.card,
                border: `1px solid ${sev === s ? SEV_COLOR[s] : C.line}`,
                borderLeft: `3px solid ${SEV_COLOR[s]}`,
                borderRadius: 9, padding: "7px 13px", cursor: "pointer",
                minWidth: 96, textAlign: "left",
              }}>
              <span style={{
                fontSize: 20, fontWeight: 700, lineHeight: 1,
                color: bySev[s] ? SEV_COLOR[s] : C.muted,
              }}>{bySev[s]}</span>
              <span style={{ fontSize: 11.5, color: C.muted }}>
                {t(`insp.sev.${s}`)}
              </span>
            </button>
          ))}
        </div>
        )}

        {/*
          筛选 chip 行。

          ⚠️ 单类页**不渲染类别 chip** —— 一页只有一类，「全部 / 高负载」
          两个 chip 点哪个都是同一份列表，纯噪音。但 `resolved` 要留：
          「昨天那条去哪了」在单类页上同样会被问，而它是唯一的入口。
        */}
        <div style={{
          display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12,
          alignItems: "center",
        }}>
          {!single && (
            <>
              <Chip active={!chip} onClick={() => setChip("")} name="chip_all">
                {zh ? "全部" : "All"} {openRows.length}
              </Chip>
              {kinds.map(chipFor)}
            </>
          )}
          {single && doneRows.length > 0 && (
            <Chip active={!chip} onClick={() => setChip("")} name="chip_all">
              {zh ? "待处置" : "Open"} {openRows.length}
            </Chip>
          )}
          {doneRows.length > 0 && (
            <Chip active={chip === "resolved"} name="chip_resolved"
              onClick={() => setChip(chip === "resolved" ? "" : "resolved")}>
              {zh ? "已解决" : "Resolved"} {doneRows.length}
            </Chip>
          )}
          {/* 🔴 账号 / 实例名搜索。统一视图之后账号是**筛选维度**而不是加载维度
              —— 原来顶部那个选择器决定「加载哪个账号的分区」，客户一次只能看
              一个账号，还得自己记住哪个账号有事。
              ⚠️ 放在这一排（与严重度、类别 chip 同层）而不是页头：它们是**同一
                 类操作**（收窄当前列表），分开放会让人以为账号那个又是切视图。 */}
          <div style={{ flex: 1 }} />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            name="finding_filter"
            placeholder={acctsInView.length > 1
              ? (zh ? `搜账号 / 实例名（${acctsInView.length} 个账号）`
                : `Filter by account / instance (${acctsInView.length} accounts)`)
              : (zh ? "搜实例名 / 指标" : "Filter by instance / metric")}
            style={{
              width: 240, padding: "4px 9px", borderRadius: 8, fontSize: 12.5,
              border: `1px solid ${q ? "var(--orange)" : C.line}`,
              background: "var(--bg)", color: C.text,
            }} />
          {(sev || chip || q) && (
            <Btn size="small" variant="link"
              onClick={() => { setSev(""); setChip(""); setQ(""); }}>
              {zh ? "清除筛选" : "Clear filters"}
            </Btn>
          )}
        </div>

        {/* R10.6 + 完整度提示 */}
        {noJudgment > 0 && (
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
            {t("insp.warn.notAnalysed").replace("{n}", String(noJudgment))}
          </div>
        )}
        {/* 覆盖面不足的两种独立成因，**都要提示**：
            ① completeness < 1  指标采集有缺口
            ② status = partial   有 region 整个没扫成
            🔴 ② 不能靠 ① 兜住：失败 region 的实例压根没进 `expected`，
               所以 `completeness` 可以是 1.0 甚至 null —— 只判 ① 的表现是
               「漏了一整个 region 而页面上一个字都没说」。 */}
        {lastRuns.map(({ rt, run }) => {
          if (!run) return null;
          const label = rt === "high"
            ? (zh ? "高负载轮" : "high-load run")
            : (zh ? "闲置轮" : "idle run");
          const pct = run.completeness != null && run.completeness < 1
            ? Math.round(run.completeness * 100) : null;
          const failed = run.status === "partial" ? (run.regions_failed ?? []) : [];
          if (pct === null && run.status !== "partial") return null;
          return (
            <div key={rt} style={{ marginBottom: 8 }}>
              <Status type="warning">
                {[
                  pct !== null
                    ? (zh ? `${label}数据完整度 ${pct}%`
                          : `${label} is ${pct}% complete`)
                    : (zh ? `${label}只跑完了一部分` : `${label} completed partially`),
                  failed.length
                    ? (zh ? `没扫成的 region：${failed.join("、")}`
                          : `failed Regions: ${failed.join(", ")}`)
                    : "",
                  zh ? "下面的列表可能不全" : "the list may be partial",
                ].filter(Boolean).join(" · ")}
              </Status>
            </div>
          );
        })}

        {/* ── 列表 ── */}
        {shown.length === 0 ? (
          /* ⚠️ `q` 必须传：它是第三个筛选维度，漏掉会让「搜不到」显示成
                绿色「本轮未发现风险」。`onClear` 也要清它 —— 只清 chip/sev
                的话点了「清除筛选」列表还是空的，按钮看起来坏了。 */
          <TriageEmpty rows={openRows} chip={chip} sev={sev} q={q}
            lastRuns={lastRuns}
            zh={zh} noKinds={kinds.length === 0}
            onClear={() => { setChip(""); setSev(""); setQ(""); }} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {shown.map((f) => (
              <FindingCard key={f.finding_id} f={f} zh={zh} t={t}
                highlighted={!!highlight && f.finding_id === highlight}
                // 只在**真的跨账号**时显示徽章。单账号部署下每张卡挂一个
                // 恒定的账号号是纯噪音（还挤掉规格与 region 的位置）。
                showAccount={acctsInView.length > 1}
                onOpen={() => setManualSnap(f)}
                /* 🔴 卡片**不再有动作按钮**（2026-09-01）。「移出巡检范围」与
                     「深入分析」只在抽屉 footer 里 —— 卡片上那三个（含一个
                     纯重复的「详情」）每张占一整行，20 张卡就是 20 行 chrome，
                     而这一页的全部意义是扫读密度。见 `FindingCard` 末尾那段。
                   ⚠️ `judged` 仍要传：它决定「⏳ 判读中」徽章渲不渲染。 */
                judged={isJudged(f)} />
            ))}
          </div>
        )}

        {/* ── 系统状态（原「巡检总览」）──
            这些是**运维自检**（采集完整度 / 派发缺口 / runs 表），不是
            「今天要处置什么」。默认折起，但 dispatch_gap > 0 时强制展开。 */}
        <Expandable open={opsShown} onToggle={() => setOps((v) => !v)}
          locked={gap > 0}
          lockedReason={zh
            ? "有派发缺口，这一区不折叠 —— 藏起来等于把已知的数据缺口藏起来"
            : "There is a dispatch gap; this section stays open"}
          title={zh ? "系统状态" : "System status"}
          badge={gap > 0 ? (
            <Badge tone="red">{zh ? `派发缺口 ${gap}` : `gap ${gap}`}</Badge>
          ) : undefined}>
          <OpsPanel overview={overview} lastRuns={lastRuns} zh={zh} t={t} />
        </Expandable>
      </div>

      {open && (
        <InspectionDashboardPanel row={open}
          /* ⚠️ **不传 `accountId`**（2026-09-01）：账号是 finding 自己的属性，
             而列表是跨账号的 —— 传页面选中的账号会让详情去查错分区，
             表现是「刚派发就红字 not_found」。见 Panel 里 `detailAccount`。 */
          onClose={closeDrawer}
          onExclude={mayScope ? () => { setExcluding(open); closeDrawer(); } : undefined}
          /* 与卡片那处同一个动作，只是这里能先填一句背景。
             ⚠️ **不 closeDrawer()** —— 派完要让人看到「已派发 task <id>」
                那一行状态，关掉的话客户不知道成没成。 */
          onJudge={onJudge ? () => onJudge(open) : undefined}
          judging={judging === open.finding_id}
          /* 🔴 **派发回执要在抽屉里也有一份。**
             `judgeMsg` 渲染在列表区顶部，而抽屉 `zIndex: 1000` 盖在它上面
             —— 派发动作**只能从抽屉里发起**（卡片上的按钮 2026-09-01 删了），
             所以那条提示 100% 落在客户看不见的地方。

             表现与本文件上面刚修过的那条同型：「失败时留着弹窗的表现是
             错误提示条在弹窗后面的页面上，客户看不见它，只觉得点了没反应」
             —— 弹窗那次修了，抽屉这次漏了。403 / kill_switch / conflict
             这几种**永远不会自己变**的失败在抽屉里就是完全静默。 */
          judgeMsg={judgeMsg} onDismissJudge={onDismissJudge}
          /* 🔴 抽屉**不再自己判** `!row.da_task_id` —— 那个判据在过期快照上
             恒为真。用列表这一层算好的 `isJudged`（它还含乐观状态）。 */
          judged={isJudged(open)} />
      )}

      {excluding && (
        <ExclusionModal
          /* 🔴 用**这条 finding 的**账号，不是页面选中的那个。
             列表是跨账号的（`getInspectionFindings` 不传账号），所以卡片上
             那台资源很可能不属于 `accountId`。传错的表现是弹层去列另一个
             账号的资源 → 预勾项变成 orphan → 「资源已不在清单里」，
             而那台资源就写在他刚点的那张卡片上。

             ⚠️ 这里**不给** `accounts`：账号已经由 finding 定死了，
                给一个能改的下拉等于允许把 A 账号的实例排到 B 账号名下。 */
          accountId={excluding.account_id || accountId}
          // 从卡片进来时按这条 finding 的类别决定默认勾哪份清单：
          // 高负载 finding → 高负载清单；闲置/结构性 → 闲置清单。
          entryKind={excluding.kind === "high_load" ? "high" : "idle"}
          // ⚠️ 三段都要给。清单的行键是 `<region>#<service>#<resource_id>`
          //    —— 只给实例名会让预勾项变成 orphan（「资源已不在清单里」），
          //    因为资源 ID 只在区域内唯一。
          preselect={{ region: excluding.region, service: excluding.service,
                       instance: excluding.instance }}
          zh={zh}
          onClose={() => setExcluding(null)}
          onDone={(r: BatchResult) => {
            setExcluding(null);
            // 文案说**资源数**而不是写入次数 —— 「1 台 × 两份清单」写成
            // 「已排除 2 条」会让客户去清单里找第二条。
            setFlash(r.failed.length === 0
              ? {
                type: "success",
                head: zh
                  ? `已排除 ${r.resources} 个资源`
                    + (r.writes > r.resources ? `（写入 ${r.writes} 条）` : "")
                  : `${r.resources} resource(s) excluded`,
              }
              : {
                type: "warning",
                head: zh ? `${r.resources} 个资源成功，${r.failed.length} 条写入失败`
                         : `${r.resources} succeeded, ${r.failed.length} failed`,
                body: r.failed.map((f) => `${f.id}: ${f.reason}`).join(" · "),
              });
            reload();
          }} />
      )}
    </div>
  );
}

/**
 * 空态。
 *
 * 🔴 **四种空因绝不能长得一样**（R9.11）。真实事故（东京的验证账号）：
 * run 卡在 `running`、零 finding，而界面无条件显示「本轮未发现风险」——
 * 客户以为系统在正常工作，实际上整套巡检从未成功执行过一次。
 *
 * ```
 * 筛选筛空了          → 说清是筛选的结果，给「清除筛选」
 * last_run = null     → 状态未知（读不到 run 记录）→ 别下结论
 * 没有今天的 run       → 还没巡检 → 去查为什么没跑
 * status = running    → 正在跑 → 等一下再看
 * status = failed     → 跑失败了 → 去看日志
 * success / partial   → 才是「未发现风险」
 * ```
 */
function TriageEmpty({ rows, chip, sev, q, lastRuns, zh, onClear, noKinds = false }: {
  rows: FindingRow[];
  chip: string;
  sev: string;
  /**
   * 搜索框当前的内容。
   *
   * 🔴 **必须收进来。** 缺它的表现（2026-09-02 review 抓到）：在高负载页
   * 搜一个不存在的实例名 → `shown` 为空 → 而「筛空」的判据只看 `chip || sev`
   * → 落到最后那个成功分支 → **绿色 ✓「本轮未发现风险 · 今天跑完」**。
   *
   * 那是这一页最强的保证语句，而真相只是「你打的字没匹配上」。更糟的是
   * 页头那排严重度分档仍显示非零计数（`bySev` 基于 `openRows`），
   * 界面自相矛盾且没有任何线索。
   */
  q: string;
  lastRuns: { rt: "high" | "idle"; run: FindingsData["last_run"] }[];
  zh: boolean;
  onClear: () => void;
  /** 这个用户没有任何一类 finding 的查看权限。 */
  noKinds?: boolean;
}) {
  // 🔴 「没权限看」与「没有风险」必须分开。混成后者的表现是客户看到
  //    「本轮未发现风险」而实际上他只是看不到 —— 那句话是一个他不该
  //    得到的保证。
  if (noKinds) {
    return (
      <Empty icon="🔒" title={zh ? "没有查看风险清单的权限" : "No access to findings"}
        hint={zh
          ? "三类风险（高负载 / 闲置与成本 / 结构性）各自独立授权，你当前一类都没有。找管理员确认能力配置。"
          : "The three finding kinds are authorised separately; you have none of them."} />
    );
  }
  // 有数据但被筛空 —— 这与「系统没产出」完全不同。
  // ⚠️ 判据含 `q`：搜索框也是筛选器。漏掉它会让「搜不到」显示成
  //    绿色「本轮未发现风险」，而那是这一页最强的保证语句。
  if (rows.length > 0 && (chip || sev || q.trim())) {
    return (
      <Empty icon="⌕" title={zh ? "没有符合筛选条件的项" : "No matches"}
        hint={[
          // 🔴 搜索词要回显出来。只说「共有 N 条」看不出是哪个条件筛空的 ——
          //    而客户最可能忘掉的恰恰是那个自己敲进去的字。
          q.trim()
            ? (zh ? `搜索「${q.trim()}」没有匹配项。` : `No match for "${q.trim()}".`)
            : "",
          zh ? `账号里共有 ${rows.length} 条待处置。`
             : `${rows.length} open findings in total.`,
        ].filter(Boolean).join(" ")}
        action={<Btn onClick={onClear}>{zh ? "清除筛选" : "Clear filters"}</Btn>} />
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  // 取「最值得说」的那一轮：未知 > 失败 > 没跑 > 在跑 > 部分 > 成功。
  // ⚠️ 与 BFF 的 `worstRunAcross::rank` **同序**（两处刻意一致）——
  //    分叉的表现是「BFF 挑出的那条被前端按另一套重排」，空态文案与真实
  //    原因错位。加档位时两边一起加。
  const rank = (r: FindingsData["last_run"]) => {
    if (!r) return 0;
    if (r.status === "failed") return 1;
    if (r.run_date !== today) return 2;
    if (r.status === "running") return 3;
    if (r.status === "partial") return 4;
    return 5;
  };
  const worst = [...lastRuns].sort((a, b) => rank(a.run) - rank(b.run))[0];
  const run = worst?.run ?? null;

  if (!run) {
    return (
      <Empty icon="?" title={zh ? "巡检状态未知" : "Inspection status unknown"}
        hint={zh
          ? "读不到最近一轮的记录 —— 这不代表没有风险，只代表现在说不了。"
          : "Could not read the latest run. This does not mean there is no risk."} />
    );
  }
  if (run.status === "failed") {
    return (
      <Empty icon="✕" tone={C.red} title={zh ? "本轮巡检失败" : "This run failed"}
        hint={zh
          ? "空列表是失败的结果，不是「没有风险」。去 CloudWatch 看 notiops-inspection-executor 的日志。"
          : "The empty list is a consequence of the failure, not a clean result."} />
    );
  }
  if (run.run_date !== today) {
    return (
      <Empty icon="○" title={zh ? "今天还没巡检" : "No inspection run today"}
        hint={zh
          ? `最近一轮是 ${run.run_date || "（无记录）"}。空列表是因为今天没跑，不是因为没有风险。`
          : `Last run: ${run.run_date || "(none)"}. Nothing ran today.`} />
    );
  }
  if (run.status === "running") {
    return (
      <Empty icon="◐" title={zh ? "正在巡检" : "Inspection in progress"}
        hint={zh ? "本轮还没结束，稍后刷新。" : "This run has not finished yet."} />
    );
  }
  /**
   * 🔴 `partial` **不是**「未发现风险」。
   *
   * 它的语义是「有 region 没扫成」（`schedule.py::RunStatus`）。那些 region
   * 里的实例**压根没进 `expected`**，所以 `completeness` 可能仍是 1.0 ——
   * 也就是说「完整度 100% 但漏了一个 region」是真实存在的组合，
   * 下面那句「⚠️ 完整度仅 N%」不会出现。
   *
   * 上一版把它归到成功分支，表现是：某个 region 整轮漏扫 → 那个 region 里
   * 内存 98% 的库一条 finding 都没出 → 界面给绿色 ✓。
   */
  if (run.status === "partial") {
    const failed = run.regions_failed ?? [];
    return (
      <Empty icon="◑" tone={C.amber}
        title={zh ? "本轮只跑完了一部分" : "This run completed only partially"}
        hint={[
          failed.length
            ? (zh ? `这些 region 没扫成：${failed.join("、")}`
                  : `Regions that failed: ${failed.join(", ")}`)
            : (zh ? "有采集缺口（具体 region 见下方「系统状态」）"
                  : "There were collection gaps; see System status below"),
          zh
            ? "那些 region 里的资源不在本轮范围内 —— 空列表不代表它们没有风险。"
            : "Resources in those Regions were not evaluated; an empty list says nothing about them.",
        ].filter(Boolean).join(" · ")} />
    );
  }

  const pct = run.completeness == null ? null : Math.round(run.completeness * 100);
  return (
    <Empty icon="✓" tone={C.green}
      title={zh ? "本轮未发现风险" : "No risks found in this run"}
      hint={[
        zh ? `${run.run_date} 跑完` : `Completed ${run.run_date}`,
        // 完整度 <100% 必须说出来 —— 「没找到风险」和「只看了一半没找到风险」
        // 是两个不同的保证，而后者被当成前者会让客户对覆盖面产生错误信心。
        pct != null && pct < 100
          ? (zh ? `⚠️ 数据完整度仅 ${pct}%` : `only ${pct}% complete`) : "",
        run.mode === "dry_run" ? (zh ? "（试运行，未推进状态机）" : "(dry run)") : "",
      ].filter(Boolean).join(" · ")} />
  );
}

/**
 * 较上一轮的变化箭头。
 *
 * ⚠️ 这里**风险数变少是好事**，所以 ↓ 用绿色 —— 与指标值的语义方向
 * （`FreeableMemory` 跌是坏事）是两件不同的事。搞混会让
 * 「风险从 20 降到 3」显示成一条红色警报。
 */
function DiffArrow({ delta, zh }: { delta: number | null; zh: boolean }) {
  if (delta === null) return null;
  if (delta === 0) {
    return <span style={{ color: C.muted }}>±0</span>;
  }
  const up = delta > 0;
  return (
    <span style={{ color: up ? C.red : C.green, fontWeight: 600 }}
      title={zh ? "较同类型的上一轮" : "vs the previous run of the same type"}>
      {up ? "↑" : "↓"} {Math.abs(delta)}
    </span>
  );
}

/**
 * run 状态 → 颜色档 + 人话。**卡片与 runs 表共用。**
 *
 * 🔴 抽出来的两个理由：
 *
 * ```
 * ① runs 表里状态是**裸文本无颜色** —— `partial`（有 region 没扫成）与
 *    `success` 在表里只是两个不同的英文单词，而这一列右边的「已关联」和
 *    「Region」都做了标红加粗。最该有颜色的那一列反而没有。
 * ② 卡片那侧有颜色但把 `partial` 扔进 `: "warning"` 兜底，与任何未知状态值
 *    同色同字 —— 而 `partial` 是我们**认识**的状态，还是本轮最要紧的那个。
 * ```
 *
 * ⚠️ 认不出的取值**原样返回文本**（不译、不着色档给 warning）：一个陌生的
 *    英文枚举至少能拿去搜代码，而空白会让那一格看起来像后端没给。
 */
const RUN_STATUS_TONE: Record<string,
  "success" | "error" | "in-progress" | "warning"> = {
    success: "success", failed: "error", running: "in-progress",
    partial: "warning", skipped: "warning",
  };

/**
 * ⚠️ `success` 的标签是**「成功」而不是「跑完了」**。
 *
 * 「跑完了」在这个文件里已经是**「跑一轮」按钮的完成确认**专属措辞
 * （`phase === "done"` 那一支），而那条提示的全部价值在于「客户不信看板上的
 * 数，所以我们轮询确认过」。把它同时用作 run 状态标签的后果：
 *
 * ```
 * 批量触发（不轮询，只能说「已提交」）
 *   → 有一条用例断言「此时不许出现『跑完了』」
 *   → 而 runs 表里每一轮成功的记录都写着「跑完了」
 *   → 那条断言开始抓到无关的文本
 * ```
 *
 * 也就是说这两处**必须用不同的词** —— 一个说「这一轮的状态是成功」，
 * 一个说「你刚才点的那次我们确认跑完了」。
 */
function runStatusText(status: string, zh: boolean): string {
  const s = String(status || "");
  if (!zh) return s || "—";
  const map: Record<string, string> = {
    success: "成功", failed: "失败", running: "进行中",
    partial: "只跑了一部分", skipped: "本轮跳过",
  };
  return map[s] || s || "—";
}

/**
 * 「未做根因分析」的原因分档 → 一句紧凑的补充说明。
 *
 * 🔴 每一档配**下一步动作**，不只报数。一个光秃秃的 `budget: 3` 与
 * 「另有 3 项未做根因分析」的信息量是一样的 —— 客户仍然不知道该干什么。
 *
 * ⚠️ 返回 `null` 而不是空串：调用方要能靠它决定「这一段整个不渲染」。
 *    分档为空（存量 BFF 不回这个字段）时**不编造原因**。
 */
const SKIP_REASON_HINT: Record<string, { zh: string; en: string }> = {
  budget: { zh: "额度档位不放行（去「额度」调档位）", en: "budget tier" },
  quota: { zh: "本轮配额用满（等下一轮，或调配额）", en: "quota exhausted" },
  kill_switch: { zh: "判读被拉停（去打开 da_enabled）", en: "kill switch" },
  unknown: { zh: "原因未记录（去看下面的派发缺口）", en: "not recorded" },
};

export function reasonBreakdown(
  by: Record<string, number> | undefined, zh: boolean,
): string | null {
  const entries = Object.entries(by || {}).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  // 数量降序 —— 最大的那一档最值得先解决。
  entries.sort((a, b) => b[1] - a[1]);
  const parts = entries.map(([k, n]) => {
    const hint = SKIP_REASON_HINT[k];
    /* ⚠️ 认不出的 skip_reason **原样显示**（后端加了新档而这里没跟上时，
       至少能看到那个字符串去搜代码；吞掉它会让那几条凭空消失）。 */
    const label = hint ? (zh ? hint.zh : hint.en) : k;
    return `${label} ${n}`;
  });
  return zh
    ? `（${parts.join("；")}）`
    : ` (${parts.join("; ")})`;
}

/** 系统状态面板：采集完整度、派发缺口、最近的 run 记录。 */
function OpsPanel({ overview, lastRuns, zh, t }: {
  overview: OverviewData | null;
  lastRuns: { rt: "high" | "idle"; run: FindingsData["last_run"] }[];
  zh: boolean;
  t: (k: string) => string;
}) {
  const [onlyLatest, setOnlyLatest] = useState(true);

  if (!overview) {
    return (
      <div style={{ paddingTop: 12 }}>
        <Status type="pending">
          {zh ? "读不到系统状态（不影响上面的列表）" : "System status unavailable"}
        </Status>
      </div>
    );
  }

  const runs = overview.runs;
  // ⚠️ 存量响应（这一版之前的 BFF）没有 parse_quality —— 用可选链取，
  //    缺就整块不渲染，不要显示一排 0（那会让人以为「判读全都失败了」）。
  const pq = overview.parse_quality;
  /**
   * 派发过、但四档一个都没落上的条数 = **判读还在路上**（异步 1~3 分钟）。
   *
   * 🔴 不算出来的表现是「四档之和 < 分母」而无解释，客户自己加一遍发现少了
   * 几条 —— 那个差额有完全正常的解释，看起来却像我们丢了数据。
   *
   * ⚠️ 夹到 `>= 0`：分档是 BFF 独立累加的，理论上和不会超过分母，但真超了
   *    （比如将来某一档被重复计数）显示成负数只会让人怀疑整块数据。
   */
  const pendingParse = pq
    ? Math.max(0, pq.dispatched
      - (pq.ok + pq.partial + pq.parse_failed + pq.empty + pq.other))
    : 0;
  // ⚠️ 与 pq 同一条规则：存量 BFF 没有 gate_quality → 整块不渲染，
  //    不显示一排 0（那会让人以为「一条都没验过」是刚发生的故障）。
  const gq = overview.gate_quality;
  const gqBack = gq ? gq.untrusted + gq.degraded + gq.clean + gq.unknown : 0;

  const dates = [...new Set(runs.map((r) => r.run_date))].sort().reverse();
  const shownRuns = onlyLatest && dates.length
    ? runs.filter((r) => r.run_date === dates[0]) : runs;
  /** run 记录里出现过的账号 —— 决定要不要显示账号列。 */
  const runAccts = [...new Set(runs.map((r) => r.account_id))].filter(Boolean);
  /**
   * 这段时间里**一共**有多少轮（截断之前）。
   *
   * ⚠️ `runs_total` 缺失时回落到 `runs.length` —— 那不是「没截断」的证据，
   *    只是没有更好的信息，所以 `truncated` 那一支同时也判不出来（见下）。
   */
  const total = overview.runs_total ?? runs.length;
  const truncated = total > runs.length;

  return (
    <div style={{ paddingTop: 12 }}>
      {/* 🔴 派发缺口：有 task 发出去了却没落映射 → 那些判读永久回不来。
          放最上面 —— 它不是「有多少风险」而是「我们的链路漏了东西」。 */}
      {/* 🔴 派发缺口的**告警在页首**（`truncatedAt` / `unclassified` 旁边），
          不在这里 —— 这一区在一页 20 条卡片之后，首屏外的红字等于没有。

          ⚠️ 这里**刻意不再重复那条告警**。我第一版在两处都放了整条 Alert，
             结果同一句 header 在一页上出现两次（用例里 `getByText` 因
             「找到两个」直接抛）—— 与 #3 那条「判读回执渲染两份」同型。
             判据与去哪儿看那句话改挂在下面 runs 表的表头说明里。 */}

      {/*
        🔴 AI 判读的**解析质量** —— skill 漂移的唯一可见信号。

        DA 的判读是自然语言，回来之后按 `## <finding_id>` 精确匹配切段
        （`inspection/domain/report_parse.py`）。那一步设计上有三道防线
        （skill 信封硬约束 / 严格正则 / 绝不按位置回退），但在这一版之前
        **没有任何聚合度量** —— `da_parse_status` 只在单条详情里显示一个
        英文枚举。也就是说 DA 哪天改了措辞、100 条里 60 条切不出来，
        得逐条点开才会发现。

        ⚠️ 分母是**派发过的条数**，不是全部 finding。闲置轮走
        `SkipReason.DETERMINISTIC` 压根不派发，算进去会让这个比例恒低，
        于是永远是红的、也就永远没人看。
      */}
      {/* 🔴 **全绿时也要有一行。** 三个条件全成立才渲染的表现是：
             解析质量健康 → 整块**消失** → 与「存量 BFF 没返回这个字段」
             在界面上完全不可区分。而这一块是 skill 漂移的唯一可见信号，
             「看不到」正好是它失效时的样子。
          ⚠️ 全绿那一行刻意做得很轻（一行小字，不是绿色 Alert）——
             健康状态不该占视觉预算，但必须存在。 */}
      {pq && pq.dispatched > 0
        && (pq.parse_failed + pq.empty + pq.partial + pq.other) === 0 && (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
          {zh
            ? `${pq.dispatched} 条判读全部对上号了`
            : `all ${pq.dispatched} analyses mapped cleanly`}
          {pendingParse > 0 && (zh
            ? `（另有 ${pendingParse} 条还在路上）`
            : ` (${pendingParse} still in flight)`)}
        </div>
      )}
      {pq && pq.dispatched > 0
        && (pq.parse_failed + pq.empty + pq.partial + pq.other) > 0 && (
        <Alert
          type={(pq.parse_failed + pq.empty) > 0 ? "error" : "warning"}
          header={zh
            ? `${pq.dispatched} 条判读里有 ${pq.parse_failed + pq.empty + pq.partial} 条没能完整对上号`
            : `${pq.parse_failed + pq.empty + pq.partial} of ${pq.dispatched} analyses did not map cleanly`}>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12 }}>
            <span>{zh ? "完整" : "ok"} <b>{pq.ok}</b></span>
            {pq.partial > 0 && (
              <span>{zh ? "部分（缺的那些判读是缺失的，不是没问题）" : "partial"} <b>{pq.partial}</b></span>
            )}
            {pq.parse_failed > 0 && (
              <span style={{ color: C.red }}>
                {zh ? "切不出节（去查 skill 有没有加载 / 输出被截断）" : "parse_failed"} <b>{pq.parse_failed}</b>
              </span>
            )}
            {pq.empty > 0 && (
              <span style={{ color: C.red }}>
                {zh ? "DA 没回内容（去查 DA 那侧）" : "empty"} <b>{pq.empty}</b>
              </span>
            )}
            {pq.other > 0 && (
              <span>{zh ? "未知状态值" : "unknown"} <b>{pq.other}</b></span>
            )}
            {/* 🔴 四档之和 < 分母时**必须解释差额**。不解释的表现是客户自己
                加一遍发现少了几条，而那个差额有完全正常的解释（判读是异步的，
                派出去 1~3 分钟才回来）—— 看起来却像我们丢了几条。 */}
            {pendingParse > 0 && (
              <span style={{ color: C.blue }}>
                {zh ? "还在路上（异步 1~3 分钟）" : "in flight"}
                {" "}<b>{pendingParse}</b>
              </span>
            )}
          </div>
        </Alert>
      )}

      {/* ── 7.9a skill 门禁的聚合（D22 第二步）───────────────────────────
          「回来的判读里有几条没按我们的方法论产出」。与上面 parse_quality
          正交：那边问「切没切出来」，这边问「切出来的可不可信」。
          单条卡片有徽标（第一步），但「100 条里 60 条不可信」是全局故障
          （措辞路由写偏 / agent space 没关联账号），只有聚合才看得见 ——
          与 parse_quality 当年「逐条点开才发现」同型。

          🔴 全绿时也要有一行（与 pq 同一条规则）：这一块健康时整块消失，
             与「存量 BFF 没返回这个字段」在界面上完全不可区分，而它正是
             skill 漂移的可见信号，「看不到」正好是它失效时的样子。
          ⚠️ `unknown` 不触发 Alert：那是存量行/门禁没跑的「不知道」，
             不是「有问题」—— 部署完的第一天所有行都是 unknown，
             为它报警等于让这个 Alert 天生就是狼来了。 */}
      {gq && gqBack > 0 && gq.untrusted + gq.degraded === 0 && (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
          {zh
            ? `${gq.clean} 条判读已验证按方法论产出`
            : `${gq.clean} analyses verified to follow our methodology`}
          {gq.unknown > 0 && (zh
            ? `（另有 ${gq.unknown} 条是门禁上线前的存量，未验证）`
            : ` (${gq.unknown} predate the gate and are unverified)`)}
        </div>
      )}
      {gq && (gq.untrusted > 0 || gq.degraded > 0) && (
        <Alert
          type={gq.untrusted > 0 ? "error" : "warning"}
          header={zh
            ? [
              gq.untrusted > 0 ? `有 ${gq.untrusted} 条判读不可信 —— 结论未按我们的方法论产出` : "",
              gq.degraded > 0 ? `${gq.degraded} 条有降级` : "",
            ].filter(Boolean).join("，")
            : [
              gq.untrusted > 0 ? `${gq.untrusted} unverified judgement(s) - not produced by our methodology` : "",
              gq.degraded > 0 ? `${gq.degraded} with caveats` : "",
            ].filter(Boolean).join(", ")}>
          <div style={{ fontSize: 12 }}>
            {zh
              ? "点开对应 finding 的详情看具体是哪一档：skill 没加载/加载错 → 查"
                + "派发措辞路由；账号没关联 → 去管理页把账号关联进巡检 space；"
                + "读不到 journal → 可能还在跑，也可能是我们权限不足。"
              : "Open the finding details for the specific cause: skill not "
                + "loaded / wrong skill points at dispatch wording; missing "
                + "account association is fixed in the admin page."}
            <span style={{ marginLeft: 10, color: C.muted }}>
              {zh
                ? `已验证干净 ${gq.clean}${gq.unknown > 0 ? ` · 未验证（存量）${gq.unknown}` : ""}`
                : `verified clean ${gq.clean}${gq.unknown > 0 ? ` · unverified (legacy) ${gq.unknown}` : ""}`}
            </span>
          </div>
        </Alert>
      )}

      {/* 🔴 采集缺口与失败批次。
          `shapeRun` 早就逐行带出来了，读侧一个都没渲染 —— 而
          `TriageEmpty` 的 partial 分支写着「有采集缺口（具体 region 见下方
          「系统状态」）」，把客户指向一个**不存在的东西**。

          ⚠️ `batches_failed > 0` 比 `gaps > 0` 严重：前者是「有资源压根没被
             评估过」，后者是「采到的数据有洞」。所以两者分开说，不合成一句。 */}
      {((overview.gaps ?? 0) > 0 || (overview.batches_failed ?? 0) > 0) && (
        <Alert type={(overview.batches_failed ?? 0) > 0 ? "error" : "warning"}
          header={zh
            ? [
              (overview.batches_failed ?? 0) > 0
                ? `有 ${overview.batches_failed} 个批次采集失败` : "",
              (overview.gaps ?? 0) > 0 ? `有 ${overview.gaps} 处采集缺口` : "",
            ].filter(Boolean).join("，")
            : [
              (overview.batches_failed ?? 0) > 0
                ? `${overview.batches_failed} batch(es) failed` : "",
              (overview.gaps ?? 0) > 0 ? `${overview.gaps} collection gap(s)` : "",
            ].filter(Boolean).join(", ")}>
          {zh
            ? "缺口范围内的资源没有被判定 —— 那几台上的风险不会出现在列表里，"
              + "空列表不代表它们没问题。具体是哪些 region 看下面「Region」列"
              + "（标红的那些）。"
            : "Resources in those gaps were not evaluated; see the Regions column below."}
        </Alert>
      )}

      {/* R10.6：明示「另有 N 项未做根因分析」。
          不显示会让客户以为看板上有判读的那些就是全部。

          🔴 **要说清各自因为什么。** 这一句话此前吞掉三种下一步互不相同的
             处境，而 `gating.SkipReason` 的 docstring 就写着「缺任何一种都会
             退化成『这条没有 AI 分析』这句无信息的话，而客户接着就会问
             『是坏了还是省钱』—— 那是两个完全不同的答案」：

             ```
             budget       额度档位不放行这个 severity  → 去调额度档位
             quota        本轮派发条数配额用满         → 等下一轮，或调配额
             kill_switch  da_enabled 被人拉停          → 去打开开关
             unknown      派了没回来 / 存量行          → 去看派发缺口
             ```

          ⚠️ `without_judgment_by_reason` 缺失（存量 BFF）时只显示总数 ——
             不编造原因。 */}
      {overview.without_judgment > 0 && (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
          {t("insp.warn.notAnalysed")
            .replace("{n}", String(overview.without_judgment))}
          {reasonBreakdown(overview.without_judgment_by_reason, zh)}
        </div>
      )}

      <div style={{
        display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12,
      }}>
        {lastRuns.map(({ rt, run }) => (
          <Container key={rt} style={{ minWidth: 210, flex: 1 }}>
            <div style={{
              fontSize: 11.5, color: C.muted, marginBottom: 3,
              display: "flex", alignItems: "baseline", gap: 8,
            }}>
              {rt === "high" ? t("insp.tab.highLoad") : t("insp.tab.idle")}
              {/* 较上一轮的变化。**风险数变少是好事**，所以 ↓ 用绿色 ——
                  与指标曲线的语义方向判定是两件事（那边由后端的 direction
                  决定）。搞混会让「风险从 20 降到 3」显示成红色警报。 */}
              <DiffArrow delta={overview.diff?.[rt]?.delta ?? null} zh={zh} />
            </div>
            {run ? (
              <>
                {/* ⚠️ 走共享的 `RUN_STATUS_TONE` / `runStatusText` ——
                    此前 `partial` 掉进 `: "warning"` 兜底，与未知状态值
                    同色同字，而它是本轮最要紧的那个状态。 */}
                {/* ⚠️ `title` 挂在外层 span 上（`Status` 不收这个 prop）——
                    原始枚举要留一个能 hover 看到的出口，出问题时好搜代码。 */}
                <span title={run.status}>
                  <Status type={RUN_STATUS_TONE[run.status] || "warning"} bold>
                    {runStatusText(run.status, zh)}
                  </Status>
                </span>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
                  {run.run_date}
                  {/* 🔴 完整度**读不到时也要占位**。原来 `!= null` 为假就整段
                      不渲染，于是「完整度读不到」与「这一轮本来就没有完整度」
                      在界面上不可区分 —— 而前者意味着我们不知道这一轮覆盖了
                      多少，后者不存在（每轮都该有）。 */}
                  {` · ${t("insp.kpi.completeness")} `}
                  {run.completeness == null
                    ? (zh ? "读不到" : "unknown")
                    : `${Math.round(run.completeness * 100)}%`}
                  {run.mode === "dry_run" && (zh ? " · 试运行" : " · dry run")}
                </div>
              </>
            ) : (
              <Status type="pending">{zh ? "无记录" : "no record"}</Status>
            )}
          </Container>
        ))}
        <Container style={{ minWidth: 160, flex: 1 }}>
          <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 3 }}>
            {t("insp.kpi.noAnalysis")}
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>
            {overview.without_judgment}
          </div>
        </Container>
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 10, marginBottom: 6,
      }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text }}>
          {zh ? "最近巡检记录" : "Recent runs"}
        </div>
        {/* 派发缺口的**判据**放在这里（告警本体在页首，不重复）。
            ⚠️ 截断时要说明「总数按全部轮算」—— 否则客户在表里加不出页首那个
               数字，会以为其中一个是错的。 */}
        {overview.dispatch_gap > 0 && (
          <span style={{ fontSize: 11, color: C.red }}>
            {zh
              ? `派发缺口在「已关联」标红的那几轮${
                truncated ? `（总数按全部 ${total} 轮算，表里只有 ${runs.length} 轮）` : ""}`
              : "the gap is where Matched is highlighted below"}
          </span>
        )}
        <label style={{
          display: "flex", alignItems: "center", gap: 5,
          fontSize: 12, color: C.muted, cursor: "pointer",
        }}>
          <input type="checkbox" checked={onlyLatest}
            onChange={(e) => setOnlyLatest(e.target.checked)} />
          {zh ? "只看最新一天" : "Latest day only"}
        </label>
        {/* 筛掉了多少必须说出来 —— 否则用户会以为「只有这么几轮」。

            🔴 分母用 `runs_total`（截断**之前**的轮数），不是 `runs.length`。
               后者是 BFF `slice(0, runs_limit)` 之后的数，于是这句话会说
               「显示 3 / 20 轮」而真实可能是 137 轮 —— 静默截断。
               findings 侧有 `truncated_at` 专门解决这件事，runs 侧此前没有。

            ⚠️ `runs_total` 缺失（存量 BFF）时回落到 `runs.length`，但**不说**
               「共 N 轮」那半句 —— 那时我们并不知道截没截，硬说一个数就是
               把「不知道」显示成「知道」。 */}
        {(shownRuns.length !== runs.length || truncated) && (
          <span style={{ fontSize: 11, color: truncated ? C.amber : C.muted }}
            title={truncated
              ? (zh
                ? `只回传了最近 ${overview.runs_limit ?? runs.length} 轮，`
                  + `而这段时间里一共有 ${total} 轮。下面几个总数`
                  + "（派发缺口 / 采集缺口 / 各闸门）是按**全部**轮算的，"
                  + "所以可能大于表里能加出来的。"
                : `only the latest ${overview.runs_limit ?? runs.length} runs are returned`)
              : undefined}>
            {zh ? `显示 ${shownRuns.length} / ${total} 轮${truncated ? "（已截断）" : ""}`
                : `showing ${shownRuns.length} of ${total}${truncated ? " (truncated)" : ""}`}
          </span>
        )}
      </div>

      <Container padded={false} style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th scope="col" style={th}>{zh ? "日期" : "Date"}</th>
              {/* 🔴 账号列。run 记录的主键是 `insprun#<类型>#<日期>`、SK 是账号
                  —— 一次 Query 天然拿到全部账号。不显示这一列的话「698 那轮
                  还在跑」就得切账号才看得到，而那正是统一视图要消掉的动作。
                  ⚠️ 只在真的跨账号时显示（单账号部署下是恒定值 = 纯噪音）。 */}
              {runAccts.length > 1 && (
                <th scope="col" style={th}>{zh ? "账号" : "Account"}</th>
              )}
              <th scope="col" style={th}>{zh ? "类型" : "Type"}</th>
              <th scope="col" style={th}>{zh ? "状态" : "Status"}</th>
              <th scope="col" style={th}>{zh ? "风险" : "Findings"}</th>
              <th scope="col" style={th}>{zh ? "已派发" : "Dispatched"}</th>
              {/* ⚠️ 「已关联」与「已派发」**分两列**。两者不等意味着有判读
                  回不来。合成一列会让这个缺口完全看不见。 */}
              <th scope="col" style={th}>{zh ? "已关联" : "Matched"}</th>
              {/* 🔴 region 覆盖面。失败的 region 在 `by_region` 里**连键都没有**
                  （不是 0），所以「少扫了一个 region」只能靠 total 与 failed
                  看出来 —— 不显示的话它与「那个 region 没有资源」不可区分，
                  而那正是这一整轮改造要消灭的形态。 */}
              <th scope="col" style={th}>{zh ? "Region" : "Regions"}</th>
              <th scope="col" style={th}>{t("insp.kpi.completeness")}</th>
            </tr>
          </thead>
          <tbody>
            {shownRuns.map((r) => {
              const g = r.dispatched_tasks !== null && r.mapped_tasks !== null
                && r.dispatched_tasks > r.mapped_tasks;
              return (
                // ⚠️ key 必须带账号：统一视图下同一天同一类型有多个账号，
                //    只用 `type#date` 会 key 冲突（React 会复用错的行，表现是
                //    切换筛选时某一行的数据串到另一个账号上）。
                <tr key={`${r.run_type}#${r.run_date}#${r.account_id}`}
                  className="insp-row">
                  <td style={td}>{r.run_date}</td>
                  {runAccts.length > 1 && (
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                      {r.account_id || "—"}
                    </td>
                  )}
                  <td style={td}>
                    {r.run_type === "high" ? t("insp.tab.highLoad") : t("insp.tab.idle")}
                  </td>
                  {/* 🔴 状态列**上色 + 译名**。裸文本的表现是 `partial`
                      （有 region 没扫成）与 `success` 在表里只是两个不同的
                      英文单词，而右边「已关联」和「Region」都标红加粗了。 */}
                  <td style={{
                    ...td,
                    color: r.status === "failed" ? C.red
                      : r.status === "success" ? undefined
                        : r.status === "running" ? C.blue : C.amber,
                    fontWeight: r.status === "success" ? undefined : 700,
                  }} title={r.status}>
                    {runStatusText(r.status, zh)}
                    {r.heartbeat ? " · ♥" : ""}
                    {/* 🔴 **dry_run 必须能看出来。** 它占掉当天那一轮的槽位
                        （`try_acquire_run_lock` 不放行「今天已有成功的一轮」），
                        而 runs 表里它与真实轮长得一模一样 —— 客户看到「跑完了」
                        而那一轮压根没推进状态机。
                        ⚠️ 用徽章而不是新开一列：这张表已经九列了，而 dry_run
                           是少数情形，为它常驻一列全是空格。 */}
                    {r.mode === "dry_run" && (
                      <> <Badge tone="amber"
                        title={zh ? "试运行：占了当天的槽位但不推进状态机"
                                  : "dry run: took the slot without advancing state"}>
                        {zh ? "试运行" : "dry"}
                      </Badge></>
                    )}
                    {/* 补跑轮：时刻没对上、在 catch_up_hours 内补的。
                        不标出来会让「报告总是晚几分钟」查不出原因。 */}
                    {r.catch_up && (
                      <> <Badge title={zh ? "补跑（错过配置时刻后在补跑窗口内跑的）"
                                          : "catch-up run"}>
                        {zh ? "补跑" : "catch-up"}
                      </Badge></>
                    )}
                  </td>
                  <td style={td}>{r.findings ?? "—"}</td>
                  <td style={td}>{r.dispatched_tasks ?? "—"}</td>
                  <td style={{
                    ...td, color: g ? C.red : undefined,
                    fontWeight: g ? 700 : undefined,
                  }}>{r.mapped_tasks ?? "—"}</td>
                  {/* region 覆盖面：`扫成/应扫`，有失败的标红并把名字放进 title */}
                  <td style={{
                    ...td,
                    color: (r.regions?.failed?.length ?? 0) > 0 ? C.red : undefined,
                    fontWeight: (r.regions?.failed?.length ?? 0) > 0 ? 700 : undefined,
                    fontVariantNumeric: "tabular-nums",
                  }} title={(r.regions?.failed?.length ?? 0) > 0
                    ? (zh
                      ? `这些 region 没扫成：${r.regions!.failed.join("、")}。`
                        + "它们的资源不在 expected 里，所以本轮 status 是 partial。"
                      : `Regions that failed: ${r.regions!.failed.join(", ")}`)
                    : (r.by_region
                      ? Object.entries(r.by_region)
                          .filter(([, n]) => n > 0)
                          .map(([k, n]) => `${k}: ${n}`).join(zh ? "、" : ", ")
                        || (zh ? "所有 region 都没有资源" : "no resources in any region")
                      : undefined)}>
                    {r.regions && r.regions.total !== null
                      ? `${r.regions.scanned ?? "?"}/${r.regions.total}`
                      : "—"}
                  </td>
                  {/* ⚠️ 判据是 `== null`（宽松）而不是 `!== null`：
                      类型是 `number | null`，但任何绕过 `shapeRun` 的响应会给
                      `undefined` → `Math.round(undefined * 100)` = `NaN%`。
                      同一个字段在卡片那侧用的就是 `== null`，两处不该分叉。 */}
                  <td style={td}>
                    {r.completeness == null
                      ? "—" : `${Math.round(r.completeness * 100)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Container>
    </div>
  );
}
