/**
 * 巡检范围页：两份排除清单 + 一个排除入口 + 挪出白名单。
 *
 * ## 这一版（2026-09-01）改了什么，以及为什么
 *
 * 客户实测圈了三处，都是同一类问题 ——「同一件事有多个入口 / 有入口但没作用」：
 *
 * ```
 * ① 三个「排除资源」按钮      两个区块标题各一个 + 空态卡片里一个，
 *                             而弹层里还有「写进哪份清单」的 checkbox。
 *                             外面那两个按钮的**唯一**区别就是预勾了哪个
 *                             checkbox，而弹层里还能改掉它 —— 于是
 *                             「我点的是闲置轮那个」与「实际写进哪份」可以不一致。
 *                             → 页头**一个**按钮，清单在弹层内选。
 * ② 页头的账号选择器          它不影响下面的清单（清单是跨账号的），
 *                             实际作用只有「写入时用哪个账号」。留着它会让人
 *                             以为「选了 677 就只看 677 的白名单」——
 *                             客户原话正是这个误解。
 *                             → 删掉，账号选择进两个写入弹层。
 * ③ 只有「续期 30 天」        没有任何位置能撤销一条排除。手滑排除一台生产库
 *                             之后只能等 30 天过期，而那 30 天里
 *                             「没有告警」会被读成「一切正常」。
 *                             → 每行加「挪出白名单」。
 * ```
 *
 * ## 清单按账号划分
 *
 * 表格多一列「账号」（只在出现多个账号时显示），并按 `账号 → 资源` 排序，
 * 于是同一个账号的条目在视觉上聚在一起。
 *
 * 🔴 在这之前整份清单**混着全组织的条目**且没有账号列 —— 页头选中 677，
 * 表里却有一行属于 088 的 `*` 整账号排除，而客户无从分辨。
 * 读侧的越权与过滤在 `bff/web-chat/inspection.mjs::getScope` 修掉了，
 * 这一列是让「谁的」这件事在界面上也能看见。
 *
 * ## 为什么到期项要汇总
 *
 * R1.4 规定到期条目「保留记录但不生效」，所以它们仍然在表格里。但一份 30 行
 * 的清单里有 4 行过期，只在行内打标的话没人会注意到 —— 而「过期」意味着
 * 那台资源**已经重新进入巡检范围**了，客户可能正准备收到一批以为已经压掉的告警。
 */

import { useMemo, useState } from "react";

import {
  type ScopeData, type ScopeEntry,
  deleteInspectionExclusion,
  isFail, putInspectionExclusion, renewInspectionExclusion,
} from "../../api/inspection";
import ExclusionModal, {
  type BatchResult, isoPlusDays, PRESETS as WIDE_PRESETS,
} from "./ExclusionModal";
import {
  Alert, Badge, Btn, Chip, Container, Empty, Field, Modal, PageHeader, RowMenu,
  SectionHeading, Status,
} from "./ui";
import { C, inner, input, page, td, th } from "./tokens";

/** 12 位账号。与后端 `ACCOUNT_RE` 同一条判据。 */
const ACCT_RE = /^\d{12}$/;

/**
 * 这一条是不是**整账号**排除。
 *
 * 🔴 判据是**双通配**，不是 `level === "account"`。两者曾经分叉过
 * （`normalizeExclusion` 的 H1/H2 注释记着两个方向的真实缺陷），
 * 而后端最终把 `level === "account"` 归一成双通配 —— 消费侧认的是双通配。
 * 前端跟着认同一件事，否则「界面说整账号、实际只排了一台」会再来一次。
 *
 * 🔴 **认不出属性时回退去读 SK。** 只看 `e.service` / `e.resource_id` 的
 * 表现是存量行 fail-open：
 *
 * ```
 * 老条目（属性没落库，只有 SK = `<acct>#-#*#*`）
 *   → service/resource_id 读出来是空串 → 判成「不是整账号」
 *   → 撤销时只删点中那一份 → 客户以为撤销了，另一轮还压着整个账号
 *   → 确认框还写着「这一台将重新进入巡检范围」，而它排的是整个账号
 * ```
 *
 * SK 的形状是 `scope.py::key`：`<account>#<region|->#<service>#<resource_id>`。
 * 双通配 ⇒ 后两段都是 `*`。
 *
 * ⚠️ 只在属性**读不出**时才回退，不是两个判据取或 —— 属性有值就以属性为准，
 *    否则「属性说是单台、SK 说是整账号」这种不一致会被静默放大成整账号操作
 *    （方向错了：把一次单台撤销放大成整账号撤销）。
 *
 * ⚠️ `seg.length === 4` 是刻意的严格判断：认不出形状就当**不是**整账号。
 *    多一段少一段都说明这条 SK 不是我们理解的那个格式，而这个函数的错
 *    有一个方向会放大操作范围。
 */
export const isAccountWide = (e: ScopeEntry) => {
  const svc = String(e.service || "");
  const rid = String(e.resource_id || "");
  if (svc || rid) return svc === "*" && rid === "*";
  const seg = String(e.key || "").split("#");
  return seg.length === 4 && seg[2] === "*" && seg[3] === "*";
};

export default function ScopePage({
  data, zh, t, can, reload, accountId, accounts = [], refreshing,
}: {
  data: ScopeData | null;
  zh: boolean;
  t: (k: string) => string;
  can?: (key: string) => boolean;
  reload: () => void;
  /** 宿主当前选中的账号（可能是空串 = 部署账号）。只当写入弹层的默认值用。 */
  accountId: string;
  /**
   * 已 onboard 的成员账号。**写入弹层里的账号选择器**用它。
   *
   * 🔴 这一页此前拿的是一个现成的 `acctPicker` 节点并渲染在页头。那个位置
   * 的选择器不影响下面的清单（清单跨账号），实际作用只有「写入用哪个账号」
   * —— 而它长得像一个筛选器。客户原话：「不然容易误导用户，误以为选择账号后
   * 会显示出当前账号的已加入白名单的资源列表」。
   *
   * ⚠️ `LOCKED_ACCOUNT_ID` 锁的是**后台采集 / 调查的执行路径**
   * （防止误发跨账号 AWS 调用），不锁 Dashboard 的展示与管理 ——
   * 见 `shared/account_scope.py` 的模块说明。
   */
  accounts?: { accountId: string; accountName?: string }[];
  refreshing: boolean;
}) {
  /**
   * 🔴 fail-CLOSED：`can` 没传（宿主还没拿到能力）时**不显示**写入控件。
   *
   * 导航入口那边是 fail-open，但这些按钮会改变下一轮巡检的行为且**没有
   * 运行时信号** —— 加载期对所有人闪出「排除资源」，手快的人点进去就能提交，
   * 而后端的 403 只在提交那一刻才出现。
   */
  const mayWrite = !!can && can("action:inspection:scope");

  /**
   * 写入弹层里可选的账号。
   *
   * 三个来源合并去重，顺序有讲究 —— 第一项是选择器的默认值：
   *
   * ```
   * ① 宿主选中的 accountId      客户在别的页选过，跟着他的上下文
   * ② data.account_id           BFF resolve 出来的部署账号（STS）
   *                             ← 全新部署唯一能用的那一档
   * ③ accounts（已 onboard）
   * ④ 现有排除条目里出现过的账号  跨组织接入的账号可能不在 ③ 里，
   *                             而它已经在清单里了 —— 不列出来的表现是
   *                             「能看到它的条目，却没法给它加新条目」
   * ```
   *
   * 🔴 ② 是必须的。只有 ①③④ 的话全新部署上是个死锁：要建第一条排除项需要
   * 12 位账号 → 账号只能从已有条目回填 → 清单空的时候回填不到 →
   * 两个写入入口永久禁用 → **永远建不出第一条**。
   * （2026-08-24 客户实测到过：两个按钮都灰着，tooltip 让他「先在待处置页选
   *   一个账号」，而那一页也没有账号选择器。）
   */
  const acctOptions = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    const seen = new Set<string>();
    const push = (id: string, label: string) => {
      if (!ACCT_RE.test(id) || seen.has(id)) return;
      seen.add(id); out.push({ id, label });
    };
    const dep = String(data?.account_id || "");
    const named = new Map(accounts.map((a) => [a.accountId, a.accountName || ""]));
    const label = (id: string) => {
      const n = named.get(id);
      const base = n ? `${n} · ${id}` : id;
      return id === dep ? `${base}${zh ? "（部署账号）" : " (deployment)"}` : base;
    };
    push(accountId, label(accountId));
    push(dep, label(dep));
    for (const a of accounts) push(a.accountId, label(a.accountId));
    for (const k of ["high", "idle"] as const) {
      for (const e of data?.exclusions[k] ?? []) push(e.account_id, label(e.account_id));
    }
    return out;
  }, [accountId, accounts, data, zh]);

  /** 一个账号都解析不出来时的禁用理由（STS 异常 + 清单为空 + 无成员账号）。 */
  const noAccountReason = acctOptions.length ? "" : (zh
    ? "解析不出任何 12 位账号 ID —— BFF 没能 resolve 出部署账号（STS 可能异常）。刷新重试。"
    : "No 12-digit account id available — the BFF could not resolve the "
      + "deployment account (STS may be failing). Retry.");

  /** 排除资源弹层。**不带 entryKind** —— 写哪份清单在弹层里选（客户要求）。 */
  const [modal, setModal] = useState(false);
  /** 整账号排除对话框。**它不分清单** —— 见 `submitWide`。 */
  const [wide, setWide] = useState(false);
  const [wideBusy, setWideBusy] = useState(false);
  /**
   * 整账号排除的有效期，天数。`null` = 永不过期。
   *
   * 🔴 原来**没有这个控件**，请求体里也不带 `expires_at` —— 于是走后端的
   * R1.3 默认值 30 天，而对话框只说「直到这条排除到期」，从不说那是什么时候。
   *
   * 表现：客户为「沙箱账号，2026-Q4 关停」整账号排除，30 天后整个账号
   * **静默回到巡检范围**，一屏 finding 重新冒出来。而这一页上唯一能看到
   * 到期日的地方是清单表格里那一列 —— 得先知道要去看。
   *
   * ⚠️ 默认仍是 30 天（与后端一致），但**显式传**：让「请求体」与「对话框
   *    承诺」在同一处可读，不依赖后端默认值（`service: "*"` 那条注释
   *    同一个理由）。
   */
  const [wideDays, setWideDays] = useState<number | null>(30);
  const [wideReason, setWideReason] = useState("");
  const [wideAccount, setWideAccount] = useState("");
  /** 待确认「挪出白名单」的那一行。`null` = 对话框关着。 */
  const [del, setDel] = useState<{ kind: "high" | "idle"; e: ScopeEntry } | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [flash, setFlash] = useState<
    { type: "success" | "warning" | "error"; head: string; body?: string } | null>(null);
  const [busyKey, setBusyKey] = useState("");

  const expired = useMemo(() => {
    if (!data) return { high: 0, idle: 0 };
    return {
      high: data.exclusions.high.filter((e) => e.expired).length,
      idle: data.exclusions.idle.filter((e) => e.expired).length,
    };
  }, [data]);

  /**
   * 清单里出现了几个不同的账号。**决定要不要显示账号列。**
   *
   * ⚠️ 单账号部署下那一列是纯噪音（每行一个相同的 12 位数字）。
   * 而多账号下它是**唯一**能分辨「这条 `*` 整账号排除是谁的」的依据。
   */
  const acctCount = useMemo(() => {
    const s = new Set<string>();
    for (const k of ["high", "idle"] as const) {
      for (const e of data?.exclusions[k] ?? []) if (e.account_id) s.add(e.account_id);
    }
    return s.size;
  }, [data]);
  const showAcct = acctCount > 1;

  /**
   * 这个动作要落在哪几份清单上。**`renew` 与 `doDelete` 共用。**
   *
   * 🔴 抽出来是因为两处曾经分叉：`doDelete` 对整账号行成对操作，而 `renew`
   * 只动点中那一份 —— 于是「续期」把一条整账号排除拆成了半活半死：
   *
   * ```
   * 点高负载那一份「续期 30 天」→ 只有 high 被延到 +30 天
   *   → idle 那份到了原定日期就失效
   *   → 该账号的**闲置轮**重新开始出 finding，而界面上那一行还写着
   *     「整账号」+ 新的到期日，看起来完好
   * ```
   *
   * 而这正是 `submitWide` 自己在失败分支里承认「只有一半退出了巡检」的
   * 那个中间态 —— 从续期这一侧再制造一次同样不能接受。
   */
  const kindsFor = (e: ScopeEntry, clicked: "high" | "idle"): ("high" | "idle")[] =>
    (isAccountWide(e) ? ["high", "idle"] : [clicked]);

  /**
   * 续期。整账号行**两份一起续**（见 `kindsFor`）。
   *
   * ⚠️ 与 `doDelete` 不同，`not_found` 在这里**是真失败**：续期的前提是那条
   * 记录还在。删除时 `not_found` 等于目标状态已达成，而续期时它意味着
   * 「你以为延后了，其实那一份早就没了」—— 那份清单现在正在巡检该账号。
   */
  const renew = async (k: "high" | "idle", e: ScopeEntry) => {
    const kinds = kindsFor(e, k);
    setBusyKey(e.key); setFlash(null);
    const done: string[] = [];
    const failed: string[] = [];
    let expiresAt = "";
    for (const kind of kinds) {
      const r = await renewInspectionExclusion(kind, e.key);
      if (isFail(r)) failed.push(`${kind}: ${r.message || r.code}`);
      else { done.push(kind); expiresAt = r.expires_at || expiresAt; }
    }
    setBusyKey("");
    if (done.length === 0) {
      setFlash({ type: "error", head: failed[0] || t("insp.act.failed") });
      return;
    }
    const paired = kinds.length > 1;
    setFlash({
      type: failed.length ? "warning" : "success",
      head: `${t("insp.act.saved")} · ${t("insp.scope.expiresOn")} ${expiresAt}`
        + (paired && !failed.length ? (zh ? "（两份清单）" : " (both lists)") : ""),
      /* 🔴 部分失败要如实说**哪一份没续上**。只说「已保存」会让客户以为
         整账号都延后了，而另一轮到期后会静默重新开始判定该账号。 */
      body: failed.length
        ? (zh ? `⚠️ ${failed[0]} —— 该账号只有一半延期了，另一份到期后会重新被判定，请重试。`
              : `⚠️ ${failed[0]}; only half was renewed.`)
        : undefined,
    });
    reload();
  };

  /**
   * 「挪出白名单」—— 删掉一条排除，那台资源立刻回到巡检范围。
   *
   * 🔴 **整账号排除要成对撤销。** 它是 `submitWide` 一个动作写出来的**两条**
   * 记录（high + idle），而两条的 SK 完全相同（`<acct>#-#*#*`）。只删点中
   * 那一份的表现是：客户以为撤销了，实际另一轮还压着 —— 而那正是
   * `submitWide` 失败分支里承认的「只有一半退出了巡检」的中间态，
   * 从撤销这一侧再制造一次是不能接受的。
   *
   * ⚠️ `not_found` **算成功**。成对删除时另一份可能早就没了 ——
   * 报错会让客户以为撤销失败而重试。
   */
  const doDelete = async () => {
    if (!del) return;
    setDelBusy(true); setFlash(null);
    const wideRow = isAccountWide(del.e);
    // ⚠️ 与 `renew` **共用** `kindsFor` —— 两处各写一份就是 S5 那条缺陷
    //    （删除成对、续期不成对）的形态。
    const kinds = kindsFor(del.e, del.kind);
    const failed: string[] = [];
    for (const k of kinds) {
      const r = await deleteInspectionExclusion(k, del.e.key);
      // not_found = 那一份本来就没有 → 目标状态已达成，不算失败
      if (isFail(r) && r.code !== "not_found") failed.push(`${k}: ${r.message || r.code}`);
    }
    setDelBusy(false);
    const what = wideRow
      ? (zh ? `账号 ${del.e.account_id}` : `account ${del.e.account_id}`)
      : (del.e.resource_id || del.e.key);
    if (failed.length === kinds.length) {
      setFlash({ type: "error", head: failed[0] });
      return;
    }
    setDel(null);
    setFlash({
      type: failed.length ? "warning" : "success",
      head: zh ? `${what} 已挪出白名单${wideRow ? "（两份清单）" : ""}`
               : `${what} removed from the exclusion list`,
      body: failed.length
        ? (zh ? `⚠️ 其中一份清单删除失败（${failed[0]}）—— 请重试。`
              : `⚠️ One list failed (${failed[0]}); retry.`)
        : (zh ? "下一轮巡检会重新判定它 —— 之前被压掉的风险可能重新报出来。"
              : "It will be judged again in the next round."),
    });
    reload();
  };

  /**
   * 整账号排除。**独立入口 + 自己的确认对话框**（R1.7）。
   *
   * 🔴 用 Modal 而不是 `window.confirm`：后者说不出「这会让整个账号退出巡检」
   * 的影响面，而且会被浏览器的「阻止此页面再次弹窗」静默禁掉 ——
   * 那时它**直接返回 false**，操作看起来像被用户取消了。
   *
   * 🔴 **两份清单都要写。** 第一版只写 high 那份（`setWide("high")` 写死），
   * 而对话框正文承诺「该账号下所有 RDS / Aurora / ElastiCache 资源都不再被
   * 判定」—— 于是二次确认拿到的是**对另一个动作**的同意：下一轮闲置与结构性
   * 照常对该账号出 finding。
   *
   * 🔴 `service` 传 `"*"`。第一版硬编码 `"rds"`，而后端会把
   * `level === "account"` 归一成双通配（`normalizeExclusion`）——
   * 但显式传 `"*"` 让「请求体」与「对话框承诺」在同一处可读，
   * 不依赖后端的归一。
   */
  const submitWide = async () => {
    const acct = wideAccount || acctOptions[0]?.id || "";
    if (!wideReason.trim() || !ACCT_RE.test(acct)) return;
    setWideBusy(true);
    const results = await Promise.all(
      (["high", "idle"] as const).map((k) => putInspectionExclusion(k, {
        account_id: acct,
        service: "*",
        resource_id: "*",
        level: "account",
        reason: wideReason.trim(),
        /* 🔴 **显式带有效期。** 不带的话走后端默认 30 天，而对话框只说
           「直到这条排除到期」—— 客户不知道那是什么时候，30 天后整个账号
           静默回到巡检范围。
           ⚠️ `never_expires` 必须显式传 `true`，不能靠「不传 expires_at」
              表达 —— 那个组合的语义正好相反（= 用默认 30 天）。 */
        ...(wideDays === null
          ? { never_expires: true }
          : { expires_at: isoPlusDays(wideDays) }),
        // R1.7：后端也必须要求确认 —— 二次确认在 UI 上做，但脚本/误调
        // 一次就生效是不行的。
        confirm_account_wide: true,
      })));
    setWideBusy(false);
    const failed = results.filter(isFail);
    if (failed.length === results.length) {
      setFlash({
        type: "error",
        head: failed[0].message || failed[0].code || t("insp.act.failed"),
      });
      return;
    }
    setWide(false); setWideReason(""); setWideDays(30);
    setFlash({
      type: "warning",
      head: zh
        ? `账号 ${acct} 已整体移出巡检范围（两份清单）`
        : `Account ${acct} excluded from both lists`,
      body: failed.length
        ? (zh ? `⚠️ 其中一份清单写入失败（${failed[0].code}）—— 该账号只有一半退出了巡检，请重试。`
              : `⚠️ One list failed (${failed[0].code}); only half took effect.`)
        : (zh
          ? `该账号的 RDS / Aurora / ElastiCache 在${
            wideDays === null ? "被撤销前" : `${isoPlusDays(wideDays)} 之前`
          }都不会再被判定 —— 记得回来复查。`
          : `Nothing in this account will be judged until ${
            wideDays === null ? "it is removed" : isoPlusDays(wideDays)}.`),
    });
    reload();
  };

  const onBatchDone = (r: BatchResult) => {
    setModal(false);
    // 🔴 部分成功**如实报告**。因为最后一条失败就说整批失败，会让人
    //    重试已经成功的那些 —— 而排除是幂等的但客户不知道。
    // 🔴 文案说的是**资源数**而不是写入次数：「1 台资源 × 两份清单」写成
    //    「已排除 2 条」会让客户去清单里找第二条。
    const both = r.writes > r.resources;
    if (r.failed.length === 0) {
      setFlash({
        type: "success",
        head: zh
          ? `已排除 ${r.resources} 个资源${both ? `（写入 ${r.writes} 条，两份清单）` : ""}`
          : `${r.resources} resource(s) excluded${both ? ` (${r.writes} writes)` : ""}`,
      });
    } else {
      setFlash({
        type: "warning",
        head: zh ? `${r.resources} 个资源成功，${r.failed.length} 条写入失败`
                 : `${r.resources} succeeded, ${r.failed.length} write(s) failed`,
        body: r.failed.map((f) => `${f.id}: ${f.reason}`).join(" · "),
      });
    }
    reload();
  };

  /**
   * 账号下拉。**只有整账号排除对话框用它**，页头没有选择器
   * （见 `accounts` 的说明）。
   *
   * ⚠️ 原注释写「两个写入弹层共用」—— 那是不对的。另一个写入入口
   * （`ExclusionModal`）**刻意不给账号选择器**：账号由那条 finding 定死，
   * 给一个能改的下拉等于允许把 A 账号的实例排到 B 账号名下
   * （`InspectionDashboard` 里传 `accounts` 那处的注释写着这件事）。
   * 留着「共用」这句话会让下一个人以为可以放心地往那边接。
   */
  const acctSelect = (value: string, onChange: (v: string) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      aria-label={zh ? "账号" : "Account"}
      style={{
        background: "var(--page)", color: C.text, border: `1px solid ${C.line}`,
        borderRadius: 8, padding: "6px 9px", fontSize: 13, width: "100%",
      }}>
      {acctOptions.map((a) => (
        <option key={a.id} value={a.id}>{a.label}</option>
      ))}
    </select>
  );

  if (!data) {
    return (
      <div style={page}><div style={inner}>
        <PageHeader title={t("insp.tab.scope")} />
        <Empty title={zh ? "读不到排除清单" : "Could not read exclusions"}
          hint={zh ? "这不代表没有排除项 —— 只代表现在读不到。"
                   : "This does not mean there are none."} />
      </div></div>
    );
  }

  /**
   * 排序：**账号 → 资源**。
   *
   * ⚠️ 账号排第一键是「按账号划分」的全部实现 —— 同一个账号的条目在视觉上
   * 连成一段。按资源名排的话 088 的 `*` 行会插在 677 的两台库中间。
   */
  const sorted = (rows: ScopeEntry[]) => [...rows].sort((a, b) =>
    String(a.account_id).localeCompare(String(b.account_id))
    || String(a.resource_id).localeCompare(String(b.resource_id))
    || String(a.region).localeCompare(String(b.region)));

  const listTable = (k: "high" | "idle", rows: ScopeEntry[]) => (
    <Container padded={false} style={{ overflowX: "auto" }}>
      {rows.length === 0 ? (
        <div style={{ padding: 14 }}>
          {/* 🔴 空态**不放按钮**。页头已经有唯一的那个入口 ——
              这里再放一个就又变成「两个同名按钮」，而那正是客户圈出来的问题。 */}
          <Empty icon="✓"
            title={zh ? "没有排除项" : "No exclusions"}
            hint={zh ? "这一轮巡检覆盖账号里所有 RDS / Aurora 与 ElastiCache 资源。"
                     : "This round covers every RDS/Aurora and ElastiCache resource."} />
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {showAcct ? <th scope="col" style={th}>{zh ? "账号" : "Account"}</th> : null}
              <th scope="col" style={th}>{t("insp.field.instance")}</th>
              <th scope="col" style={th}>{t("insp.field.region")}</th>
              <th scope="col" style={th}>{t("insp.scope.level")}</th>
              <th scope="col" style={th}>{t("insp.scope.reason")}</th>
              <th scope="col" style={th}>{t("insp.scope.expiresOn")}</th>
              {mayWrite ? <th scope="col" style={th} /> : null}
            </tr>
          </thead>
          <tbody>
            {sorted(rows).map((e) => (
              <tr key={e.key} className="insp-row">
                {showAcct ? (
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{e.account_id || "—"}</td>
                ) : null}
                <td style={{ ...td, fontWeight: 600 }}>{e.resource_id || "—"}</td>
                <td style={td}>{e.region || "—"}</td>
                {/* 🔴 `nowrap`：这一列是「短标签 + 徽章」，挤窄时徽章会掉到
                    第二行，看起来像错位（客户圈出来的就是这个）。
                    真的放不下时让整张表横向滚（Container 已经 overflowX:auto），
                    而不是让一行内容拆成两行。 */}
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  {isAccountWide(e) ? (
                    /* 🔴 整账号级**只渲染徽章**，不再「整账号 + [整账号]」。
                       原来那样同一个词出现两次（截图里就是它挤到第二行的），
                       而徽章本身已经同时承担了标签和「这条影响面最大」的强调。 */
                    <Badge tone="red"
                      title={zh ? "该账号下所有资源都不参与判定"
                                : "the whole account is excluded"}>
                      {zh ? "整账号" : "account"}
                    </Badge>
                  ) : (
                    <>
                      {e.level ? t(`insp.scope.lv.${e.level}`) : "—"}
                      {/* 集群级要标出来 —— 它级联到成员，影响面比看起来大。
                          ⚠️ 这两个词**不重复**（层级=集群 / 语义=级联），
                             所以这一支保留「标签 + 徽章」。 */}
                      {e.level === "cluster" && (
                        <Badge tone="blue"
                          title={zh ? "级联排除其下全部成员" : "cascades to members"}>
                          {zh ? "级联" : "cascade"}
                        </Badge>
                      )}
                    </>
                  )}
                </td>
                <td style={{ ...td, maxWidth: 260 }}>{e.reason || "—"}</td>
                {/* ⚠️ `nowrap`：日期不许换行。平铺两个按钮那一版把这一列挤成
                    `2026-10-` + `01` 两行 —— 一个被拆开的日期读起来要拼。 */}
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  {/* R1.4：到期条目保留记录但不生效，所以必须打标 ——
                      不打标会让「排除还生效着」与「早就过期了」长得一样。 */}
                  {e.never_expires ? (
                    <Badge tone="amber">{t("insp.scope.neverExpires")}</Badge>
                  ) : e.expires_at ? (
                    e.expired ? (
                      <Status type="error" bold>
                        {e.expires_at}（{t("insp.scope.expired")}）
                      </Status>
                    ) : <span>{e.expires_at}</span>
                  ) : "—"}
                </td>
                {mayWrite ? (
                  /* 🔴 两个按钮收进一个 `⋯` 菜单（2026-09-01）。客户原话：
                     「可以改成一个 action button，点开有这些功能即可，
                       不要把这些功能都平铺，空间太紧张。」

                     平铺的代价是**内容被操作挤变形**：这一行本来有 6 列
                     （账号 / 资源 / 区域 / 层级 / 原因 / 到期），再加两个按钮
                     之后日期被拆成两行、原因换行、层级的徽章掉到第二行。
                     而内容才是这一页的主体 —— 一份「谁被排除了、到什么时候」
                     的清单，操作是次要的。 */
                  <td style={{ ...td, whiteSpace: "nowrap", width: 1 }}>
                    <RowMenu label={zh ? "操作" : "Actions"} items={[
                      {
                        key: "renew",
                        label: t("insp.scope.renew"),
                        loading: busyKey === e.key,
                        /* ⚠️ 传**整条** `e` 而不是 `e.key`：`renew` 要靠它
                           判「这是不是整账号行」才能成对续期（见 `kindsFor`）。
                           只给 key 就没有那个信息，那也正是 S5 那条缺陷
                           一开始能写出来的原因。 */
                        onClick: () => renew(k, e),
                        /* 🔴 「永不过期」的行**不许续期**，但这里用
                           `disabledReason` 而不是抽掉这一项 —— 菜单里少一项
                           不如「有这一项但灰着并说明为什么」：后者回答了
                           「为什么这条不能续期」，前者让人以为菜单坏了。

                           后端的 `UpdateExpression` 是无条件 `SET expires_at`，
                           对 never_expires（库里没有 expires_at）的行就是
                           **新增**一个到期日 —— 点一下「续期 30 天」等于给
                           一条永久保护加了个 30 天后失效的期限，而界面回的是
                           绿字「已保存」。语义正好反了。 */
                        disabledReason: e.never_expires
                          ? t("insp.scope.neverExpiresNoRenew") : "",
                      },
                      {
                        key: "remove",
                        label: t("insp.scope.remove"),
                        danger: true,
                        onClick: () => setDel({ kind: k, e }),
                      },
                    ]} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Container>
  );

  return (
    <div style={page}>
      <div style={inner}>
        <PageHeader title={t("insp.tab.scope")}
          description={zh
            ? "被排除的资源不参与判定。两份清单独立：高负载轮与闲置轮可以分开排除。"
            : "Excluded resources are not judged. The two lists are independent."}
          /*
           * 🔴 **页头是唯一的排除入口。**
           *
           * 这里曾经有一个蓝色主按钮，而两个区块标题右侧、以及空态卡片里
           * 还各有一个同名按钮 —— 客户实测圈出三个同名按钮问「有什么区别」。
           * 看不出区别，因为它们的唯一差别是预勾了弹层里哪个 checkbox，
           * 而那个 checkbox 在弹层里还能改。
           *
           * 客户原话：「外面有两个『排除资源』，pop-up window 内又有 checkbox
           * 可以选择是高负载还是闲置。简直是多余。不如外面集中一个 button，
           * 让用户进里面选择」。
           *
           * ⚠️ 页头**没有**账号选择器了。它不影响下面的清单（清单是跨账号的），
           *    留着会让人以为「选了 677 就只看 677 的白名单」。账号改在两个
           *    写入弹层里选 —— 那里才是它真正起作用的地方。
           */
          actions={mayWrite ? (
            <>
              <Btn variant="primary" onClick={() => setModal(true)}
                disabledReason={noAccountReason}>
                {zh ? "排除资源" : "Exclude resources"}
              </Btn>
              <Btn variant="danger"
                onClick={() => {
                  setWide(true); setWideReason("");
                  setWideAccount(acctOptions[0]?.id || "");
                }}
                disabledReason={noAccountReason}>
                {zh ? "整账号排除" : "Exclude whole account"}
              </Btn>
            </>
          ) : (
            <Status type="info">
              {zh ? "只读：需要 action:inspection:scope 才能改" : "Read-only"}
            </Status>
          )} />

        {refreshing && <div className="insp-bar" style={{ marginBottom: 8 }} />}

        {flash && (
          <Alert type={flash.type} header={flash.head}
            onDismiss={() => setFlash(null)}>{flash.body}</Alert>
        )}

        {/* 到期项汇总。R1.4 说到期即失效 —— 那些资源**已经重新进入巡检范围**，
            只在行内打标没人会注意到。 */}
        {(expired.high + expired.idle) > 0 && (
          <Alert type="warning"
            header={zh ? `有 ${expired.high + expired.idle} 条排除已过期` : "Expired exclusions"}>
            {/* ⚠️ 这里**不要**写 markdown 的 `**`：`Alert` 的 children 是纯文本，
                星号会字面显示给客户看（`insp.judge.rawWarning` 犯过同样的错）。 */}
            {zh
              ? "过期条目保留记录但不再生效 —— 那些资源已经重新进入巡检范围，下一轮可能重新报出来。逐条续期或让它们过去。"
              : "Expired entries are kept but no longer apply; those resources are back in scope."}
          </Alert>
        )}

        {(["high", "idle"] as const).map((k) => (
          <div key={k}>
            {/* ⚠️ 区块标题右侧**没有**按钮了 —— 见页头那段说明。 */}
            <SectionHeading
              sub={k === "high"
                ? (zh ? "这些资源不参与 CPU / 内存 / 延迟等高负载判定。"
                      : "Excluded from high-load judgement.")
                : (zh ? "这些资源不参与闲置、容量与结构性判定。"
                      : "Excluded from idle, capacity and structural judgement.")}>
              {t(k === "high" ? "insp.scope.listHigh" : "insp.scope.listIdle")}
              <span style={{ color: C.muted, fontWeight: 400, marginLeft: 6 }}>
                ({data.exclusions[k].length})
              </span>
            </SectionHeading>
            {listTable(k, data.exclusions[k])}
          </div>
        ))}
      </div>

      {modal && (
        <ExclusionModal accountId={accountId} accounts={accounts} zh={zh}
          onClose={() => setModal(false)} onDone={onBatchDone} />
      )}

      {/* 挪出白名单的二次确认。
          ⚠️ 撤销的方向是**更多**监控而不是更少，所以不需要 R1.7 那种硬门；
             但它会让之前被压掉的 finding 重新报出来，所以要说一句。 */}
      {del && (
        <Modal onClose={() => setDel(null)} width={480}
          title={t("insp.scope.remove")}
          lockClose={delBusy}
          footer={
            <>
              <Btn variant="link" onClick={() => setDel(null)}>
                {t("insp.act.cancel")}
              </Btn>
              <Btn variant="danger" onClick={doDelete} loading={delBusy}>
                {t("insp.scope.remove")}
              </Btn>
            </>
          }>
          <Alert type="warning"
            header={isAccountWide(del.e)
              ? (zh ? `账号 ${del.e.account_id} 将重新进入巡检范围（两份清单一起撤销）`
                    : `Account ${del.e.account_id} returns to scope (both lists)`)
              : (zh ? `${del.e.resource_id} 将重新进入${
                        del.kind === "high" ? "高负载" : "闲置"}轮判定`
                    : `${del.e.resource_id} returns to the ${del.kind} list`)}>
            {zh ? "下一轮巡检会重新判定它，之前被压掉的风险可能重新报出来。"
                : "It will be judged again next round."}
          </Alert>
        </Modal>
      )}

      {wide && (
        <Modal onClose={() => setWide(false)} width={520}
          title={zh ? "整账号移出巡检范围" : "Exclude the whole account"}
          lockClose={wideBusy}
          footer={
            <>
              <Btn variant="link" onClick={() => setWide(false)}>
                {t("insp.act.cancel")}
              </Btn>
              <Btn variant="danger" onClick={submitWide} loading={wideBusy}
                disabledReason={wideReason.trim() ? "" :
                  (zh ? "原因必填" : "Reason is required")}>
                {zh ? "确认排除整个账号" : "Exclude account"}
              </Btn>
            </>
          }>
          {/* 账号在**这里**选，不在页头。 */}
          <Field label={zh ? "账号" : "Account"} required>
            {acctSelect(wideAccount || acctOptions[0]?.id || "", setWideAccount)}
          </Field>
          {/* 🔴 用 `insp.scope.confirmAccountWide` 而不是硬编码文案。
              那个 key 的两个占位符（{a} 账号 / {k} 清单）就是为「让客户看见
              **是哪个账号**、**哪一份清单**」准备的 —— 只说「确认排除？」的
              对话框客户会无脑点确定，那时 R1.7 就白做了。 */}
          <div style={{ marginTop: 10 }}>
            <Alert type="warning"
              header={t("insp.scope.confirmAccountWide")
                .replace("{a}", wideAccount || acctOptions[0]?.id || "")
                .replace("{k}", zh ? "高负载 + 闲置（两份清单）"
                                   : "high-load + idle (both lists)")}>
              {/* 🔴 **写明到期日**，不说「直到这条排除到期」。
                  后者是一句没有信息的话：客户不知道那是什么时候（默认 30 天
                  藏在后端），30 天后整个账号静默回到巡检范围，一屏 finding
                  重新冒出来。 */}
              {zh
                ? `该账号下所有 RDS / Aurora / ElastiCache 资源都不再被判定，${
                  wideDays === null
                    ? "直到有人手动撤销这条排除"
                    : `直到 ${isoPlusDays(wideDays)}（${wideDays} 天后）`
                }。这类排除没有任何运行时信号 —— 之后「没有告警」会被读成「一切正常」。`
                : `No resource in this account will be judged ${
                  wideDays === null
                    ? "until this exclusion is removed"
                    : `until ${isoPlusDays(wideDays)} (${wideDays} days)`}.`}
            </Alert>
          </div>
          {/* 有效期。⚠️ 与「排除资源」弹层同一套预设（30 / 90 / 永不过期），
              两处不一致会让人以为整账号那条路有别的规则。 */}
          <div style={{ marginTop: 10 }}>
            <Field label={zh ? "有效期" : "Expires"} required>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {WIDE_PRESETS.map((pr) => (
                  <Chip key={String(pr.days)} active={wideDays === pr.days}
                    name={`wide_days_${pr.days}`}
                    onClick={() => setWideDays(pr.days)}>
                    {zh ? pr.zh : pr.en}
                  </Chip>
                ))}
              </div>
            </Field>
          </div>
          <div style={{ marginTop: 4 }}>
            <Field label={zh ? "原因" : "Reason"} required
              description={zh ? "整账号排除尤其需要写清楚 —— 它最容易被忘掉。"
                             : "Account-wide exclusions are the easiest to forget."}>
              <input name="wide_reason" value={wideReason}
                onChange={(e) => setWideReason(e.target.value)}
                placeholder={zh ? "例如：沙箱账号，2026-Q4 关停" : "e.g. sandbox, shutting down"}
                style={input} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
