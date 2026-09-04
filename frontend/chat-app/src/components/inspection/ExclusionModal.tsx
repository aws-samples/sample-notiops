/**
 * 「移出巡检范围」弹层。
 *
 * ## 客户定的流程（2026-08-23）
 *
 * ```
 * 巡检范围 → 选服务 → 加载列表 → 勾中要排除的资源 → 给日期 + 原因 → 执行
 * ```
 *
 * ## 它替掉了什么
 *
 * 七个手填框（account_id / service / resource_id / region / level /
 * expires_at / reason）。客户原话：「这个什么手填选项简直鸡肋。直接加载
 * 对应服务的对应列表不就好了吗？也不让我选择什么服务。太烂了现在的实现。」
 *
 * 那七个框里有四个是**打错了不会报错**的：
 *
 * ```
 * resource_id  打错一个字符 → 排除永不生效，零提示
 *              （「排除一个不存在的资源」在语义上完全合法）
 * region       ⚠️ 「只有一个合法值」这句话在 2026-08-27 之前成立（那时巡检
 *              只扫部署 region）。现在巡检扫全部 region，同名实例可能在两个
 *              region 各一台 —— 所以 region 是**区分它们的唯一依据**，
 *              行键、勾选集合、已排除标注全都按 `<region>#<服务>#<id>` 来。
 *              手填仍然是坏主意（打错就是一条永不匹配的记录），
 *              所以它照旧从选中的资源自动带出
 * service      选中资源自带
 * level        选错 → **级联排除静默失效**：勾了一个 Aurora 集群，
 *              UI 显示已排除，三台成员照样出现在结果里
 * ```
 *
 * 现在全部自动带出，人只填「到什么时候」和「为什么」。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  type ExclusionInput, type ResourceItem,
  getInspectionResources, isFail, putInspectionExclusion,
} from "../../api/inspection";
import {
  Alert, Badge, Btn, Chip, Empty, Field, Modal, Skeleton, Status,
} from "./ui";
import { C, input } from "./tokens";

/** 服务组 chip。⚠️ 只有 rds / elasticache —— 巡检不覆盖 EC2。 */
const SERVICE_TABS: { key: string; zh: string; en: string }[] = [
  { key: "", zh: "全部", en: "All" },
  { key: "rds", zh: "RDS / Aurora", en: "RDS / Aurora" },
  { key: "elasticache", zh: "ElastiCache", en: "ElastiCache" },
];

/**
 * 有效期预设。⚠️「永不过期」必须显式点 —— 后端省略时给 30 天。
 *
 * ⚠️ **导出**给 `ScopePage` 的整账号对话框复用：两处预设不一致会让人以为
 *    整账号那条路有别的规则。
 */
export const PRESETS: { days: number | null; zh: string; en: string }[] = [
  { days: 30, zh: "30 天", en: "30 days" },
  { days: 90, zh: "90 天", en: "90 days" },
  { days: null, zh: "永不过期", en: "Never" },
];

/**
 * 「已排除」徽标上到底说什么。
 *
 * 🔴 只说「已排除」的问题是：整账号 / 整服务 / 集群级排除会把这一行的
 * checkbox 变灰，而客户**在这个弹层里撤不掉它们** —— 那三层要去
 * 「巡检范围 → 排除清单」删那一行。不说清是哪一层，客户会以为是自己勾错了，
 * 反复点那个灰掉的 checkbox。
 *
 * ⚠️ 取**最粗**那一层来说话（account > service > container > instance）：
 *    勾了两份清单时可能一份是 instance、另一份是 account，而客户要解决的是
 *    更难撤销的那个。挑最细的会把「整账号排除」说成「这一行排除了」，
 *    等于指错路。
 *
 * ⚠️ `excluded_by` 缺失（存量 BFF）→ 返回笼统那句，**不猜** `instance`：
 *    猜错的方向是告诉客户「取消勾选就行」，而他取消不了。
 */
const LAYER_RANK: Record<string, number> = {
  account: 4, service: 3, container: 2, instance: 1,
};

export function coarsestLayer(
  r: Pick<ResourceItem, "excluded_by">, lists: ReadonlySet<"high" | "idle">,
): "" | "instance" | "container" | "service" | "account" {
  let best: string = "";
  for (const k of lists) {
    const layer = r.excluded_by?.[k];
    if (!layer) continue;
    if (!best || LAYER_RANK[layer] > LAYER_RANK[best]) best = layer;
  }
  return best as "" | "instance" | "container" | "service" | "account";
}

export function coverLabel(
  r: Pick<ResourceItem, "excluded_by" | "service">,
  lists: ReadonlySet<"high" | "idle">, zh: boolean,
): string {
  switch (coarsestLayer(r, lists)) {
    case "account":
      return zh ? "整账号已排除" : "whole account excluded";
    case "service":
      return zh ? `整个 ${r.service} 已排除` : `all ${r.service} excluded`;
    case "container":
      return zh ? "所属集群已排除" : "parent cluster excluded";
    default:
      return zh ? "已排除" : "excluded";
  }
}

export function coverHint(
  r: Pick<ResourceItem, "excluded_by" | "service">,
  lists: ReadonlySet<"high" | "idle">, zh: boolean,
): string {
  const layer = coarsestLayer(r, lists);
  if (layer === "instance" || layer === "") {
    return zh ? "这一行已经在清单里了" : "already on the list";
  }
  return zh
    ? "这条排除不是加在这一行上的，在这里取消不掉 —— "
      + "去「巡检范围 → 排除清单」里删掉那一条"
    : "This exclusion is not on this row; remove it from the exclusion list.";
}

/**
 * 今天 + N 天的 `YYYY-MM-DD`（UTC）。
 *
 * ⚠️ **导出**给 `ScopePage` 的整账号对话框复用。各写一份的表现是两条路的
 *    到期日算法漂开（比如一处用本地时区、一处用 UTC），而后端的判据是
 *    `today < expires_at` 的日期比较 —— 差一天就是「落库即失效」。
 */
export function isoPlusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface BatchResult {
  /** 成功写入的**次数**。一台资源写两份清单 = 2。 */
  writes: number;
  /** 成功处理的**资源数**。汇总文案用它 —— 见下。 */
  resources: number;
  failed: { id: string; reason: string }[];
}

export default function ExclusionModal({
  accountId, accounts = [], entryKind, zh, onClose, onDone, preselect = null,
}: {
  accountId: string;
  /**
   * 可选账号。**非空时弹层顶部渲染账号下拉。**
   *
   * 🔴 账号选择 2026-09-01 从页头搬进这里。页头那个位置不影响清单
   * （清单是跨账号的），实际作用只有「写入用哪个账号」—— 而它长得像筛选器。
   * 客户原话：「让用户在『排除资源』的页面内先选择账号，然后再去操作。
   * 不然容易误导用户，误以为选择账号后会显示出当前账号的已加入白名单的
   * 资源列表」。
   *
   * ⚠️ 选中的账号同时决定**下面列出谁的资源** —— 换账号会重新拉一次
   *    `/inspection/resources`，并清空已勾选项（见那个 effect）。
   */
  accounts?: { accountId: string; accountName?: string }[];
  /**
   * 默认勾哪份清单。**可选** —— 从页头那个唯一入口进来时不带它。
   *
   * 🔴 这个 prop 曾经是必填的，因为外面有两个「排除资源」按钮各自预勾一份。
   * 客户实测的反应是「外面有两个排除资源，pop-up window 内又有 checkbox
   * 可以选择是高负载还是闲置。简直是多余」——
   * 外面收成一个按钮之后，清单只在这里选。
   *
   * ⚠️ 留着它是给 finding 卡片的「移出巡检范围」用：从高负载卡片进来时
   *    预勾高负载轮是对的上下文。
   */
  entryKind?: "high" | "idle";
  zh: boolean;
  onClose: () => void;
  /** 提交完成（含部分成功）后回调，调用方负责刷新与展示汇总。 */
  onDone: (r: BatchResult) => void;
  /** 从卡片点「移出巡检范围」进来时预选那台资源。 */
  /**
   * 从 finding 卡片点进来时预勾的那一台。
   *
   * 🔴 **必须给全 `region` + `service`**，不能只给实例名：清单的行键是
   * `<region>#<service>#<resource_id>`（资源 ID 只在区域内唯一）。只给实例名
   * 会让预勾项变成 orphan，客户看到「资源已不在清单里」，而那台就在他眼前。
   */
  preselect?: { region: string; service: string; instance: string } | null;
}) {
  /**
   * 当前选中的账号。**空串 = 部署账号**（BFF 的 `resolveAccount` 空值兜底
   * 就是照这个语义写的）。
   *
   * ⚠️ 用 state 而不是直接读 prop：换账号要重拉资源清单，而 prop 由宿主的
   *    页面级 state 驱动 —— 那个 state 已经不再由这一页控制（页头没有选择器了）。
   */
  const [acct, setAcct] = useState(accountId);
  const [svc, setSvc] = useState("");
  const [q, setQ] = useState("");
  const [list, setList] = useState<ResourceItem[] | null>(null);
  const [degraded, setDegraded] = useState<
    { service: string; region?: string; reason: string }[]>([]);
  /** 这一次真的扫过的 region —— 空态文案要靠它才能说真话。 */
  const [scanned, setScanned] = useState<string[]>([]);
  /** 清单来源账号（来自 `/inspection/resources` 的响应）。写入用它。 */
  const [srcAccount, setSrcAccount] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(preselect
      ? [`${preselect.region}#${preselect.service}#${preselect.instance}`]
      : []));

  /**
   * 写进哪份清单。两份**独立**（R1.2）——「冷备机：别报闲置，但内存打满
   * 还要告警」是常见配置，所以是两个 checkbox 而不是单选。
   * 默认勾**入口所在**那一份。
   */
  const [lists, setLists] = useState<Set<"high" | "idle">>(
    // 🔴 不带 `entryKind`（页头那个唯一入口）时**两份都勾**。
    //    默认空集的表现是「执行」按钮一进来就是灰的，tooltip 说
    //    「至少要写进一份清单」—— 而客户点的按钮叫「排除资源」，
    //    他的意图是「别再管这台」，那就是两份。
    () => new Set(entryKind ? [entryKind] : (["high", "idle"] as const)));

  const [presetIdx, setPresetIdx] = useState(0);
  const [customDate, setCustomDate] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitErr, setSubmitErr] = useState("");
  /**
   * 组件还在挂载。
   *
   * 🔴 `submit` 是串行 N 次 await，卸载**不会**打断它。所以按 Esc / 点遮罩
   * 关掉弹层之后，剩下的 POST 照样发完（部分写入已经生效），而 `onDone`
   * 永远不会被调用 → 没有汇总、`reload()` 没跑、清单还是旧的 →
   * 客户会再来一遍。
   */
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // ── 资源清单 ──────────────────────────────────────────────────────────
  //
  // ⚠️ 这一次请求会打真实的 DescribeDBInstances + DescribeDBClusters +
  //    DescribeReplicationGroups（各自分页循环），慢是正常的。
  //    所以用骨架屏而不是一行「读取中…」——后者在 2 秒以上会让人以为卡死。
  useEffect(() => {
    let dead = false;
    (async () => {
      setList(null); setLoadErr(""); setDegraded([]); setScanned([]);
      const d = await getInspectionResources(acct || undefined);
      if (dead) return;
      if (isFail(d)) {
        setLoadErr(d.code === "http_403"
          ? (zh ? "没有读取资源清单的权限（nav:inspection:resources）"
                : "No permission to list resources")
          : (zh ? `读取失败：${d.code}` : `Failed: ${d.code}`));
        setList([]);
        return;
      }
      setList(d.resources);
      // 🔴 **写入用的账号取自这次响应，不用那个 prop。**
      //
      // 原来 `ExclusionModal` 拿的是 `accountId={accountId}`，而
      // `ChatApp.tsx` 的 `dashAccountId` 初值是 `""`，账号选择器的第一个
      // option 也是 `value=""`（= 部署账号），单账号部署甚至不渲染选择器。
      // 于是提交时发出 `account_id: ""`，被 BFF 的 `ACCOUNT_RE` 拒掉：
      //
      //   「全部失败：account_id 必须是 12 位数字」
      //
      // 而这张表单里压根没有账号字段，客户无从下手。**默认状态下整个排除
      // 功能不可用**，只有手选了成员账号才能用。
      //
      // `ScopePage` 算了个三级兜底的 `effectiveAccount`，但只用在按钮的
      // 禁用理由和整账号排除上 —— 这个模态没接。
      //
      // ⚠️ 用响应里的 `account_id` 而不是再传一个 prop：那是**清单来源的那个
      //    账号**，语义上正是「我勾的这些资源属于谁」。传 prop 还会留下
      //    「prop 与清单不是同一个账号」这种不可能被发现的错配。
      setSrcAccount(String(d.account_id || ""));
      // 🔴 degraded 必须显示成「读不到」而不是当成「账号里没有」——
      //    后者会让客户以为 ElastiCache 不需要排除，而真相是我们没权限看。
      setDegraded(d.degraded || []);
      setScanned(d.regions || []);
    })();
    return () => { dead = true; };
  }, [acct, zh]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list ?? []).filter((r) =>
      (!svc || r.service === svc)
      && (!needle || r.label.toLowerCase().includes(needle)
          || r.resource_id.toLowerCase().includes(needle)));
  }, [list, svc, q]);

  /**
   * 行的唯一键。
   *
   * 🔴 **必须含 region。** 资源 ID 只在区域内唯一，而多 region（2026-08-27）
   * 之后弹层会同时列出两个 region 的同名实例。只用 `resource_id` 的后果：
   *
   * ```
   * byId   两条同名只留最后一条 → 提交时 byId.get(id) 拿到的是被覆盖后那条
   *        → 写出去的 region 是**另一个** region 的
   * picked 勾第一行 → 第二行也显示打勾 → 提交只写一条
   *        → 成功横幅说「已排除 1 个资源」，而客户以为勾了两个
   * key    React 重复 key → 切筛选时行数据串位
   * ```
   */
  const rowKey = (r: { region: string; service: string; resource_id: string }) =>
    `${r.region}#${r.service}#${r.resource_id}`;

  const byId = useMemo(
    () => new Map((list ?? []).map((r) => [rowKey(r), r])), [list]);

  const toggle = (id: string) => setPicked((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /**
   * 换账号。**必须清掉已勾选项。**
   *
   * 🔴 行键是 `<region>#<service>#<resource_id>`，**不含账号**（资源 ID 只在
   * 区域内唯一，而清单一次只列一个账号）。不清的表现：
   *
   * ```
   * 在 A 账号勾了 us-east-1 的 notiops-tb-redis
   *   → 切到 B 账号，B 里也有同名同区域的一台（多账号同名部署很常见）
   *   → 那一行**仍然是勾选状态**，客户没点过它
   *   → 提交写出 account_id=B 的排除记录，而他以为排的是 A
   * ```
   *
   * 与 `normalizeExclusion` 的 H2 同类：界面反馈是成功的，写出去的东西是错的。
   */
  const changeAcct = (v: string) => {
    if (v === acct) return;
    setAcct(v);
    setPicked(new Set());
    setSubmitErr("");
  };

  const expiresAt = presetIdx === 2 ? "" : (
    presetIdx === 3
      ? customDate.trim()
      : isoPlusDays(PRESETS[presetIdx].days as number));
  const neverExpires = presetIdx === 2;

  // ── 提交条件。**每一条都要能说出原因**（Btn 的 disabledReason）──
  /** `picked` 里在清单中找不到的那些（预选给的 id 与清单口径不一致）。 */
  const orphans = list === null ? [] : [...picked].filter((id) => !byId.has(id));

  const blocked = (() => {
    // 🔴 清单还没回来就不能提交。资源清单要打真实的 DescribeDBInstances +
    //    DescribeDBClusters + DescribeReplicationGroups（分页循环，几秒），
    //    而从卡片点进来时 `picked` 已经预填了一台 —— footer 显示「已选 1 个」。
    //    客户在这几秒里填好原因点执行 → `byId` 还是空 Map → 全部落进
    //    `failed` → 「全部失败：资源已不在清单里」，而那台资源就在他眼前。
    if (list === null) {
      return zh ? "资源清单还在加载（要读 RDS 与 ElastiCache 的真实清单）"
                : "Still loading the resource list";
    }
    if (picked.size === 0) return zh ? "先勾选至少一个资源" : "Select at least one resource";
    // 预选的 id 与清单口径不一致（finding 的实例名 vs replication group id 等）
    if (orphans.length) {
      return zh
        ? `${orphans.join("、")} 不在资源清单里 —— 取消勾选或换一台`
        : `${orphans.join(", ")} not in the resource list`;
    }
    if (lists.size === 0) return zh ? "至少要写进一份清单" : "Pick at least one list";
    // ⚠️ 不带 `（R1.3）`。需求编号是**我们**的内部坐标，对客户没有意义 ——
    //    与这一版删掉的那三段说明同一个理由。
    if (!reason.trim()) return zh ? "原因必填" : "Reason is required";
    if (presetIdx === 3 && !/^\d{4}-\d{2}-\d{2}$/.test(customDate.trim())) {
      return zh ? "自定义日期格式是 YYYY-MM-DD" : "Date must be YYYY-MM-DD";
    }
    return "";
  })();

  /**
   * 批量提交。
   *
   * ⚠️ 后端接口是**单条**的，所以这里是 N 次 POST。串行发而不是并发 ——
   * 并发会在几十条时把 API Gateway 打成限流，而部分成功的语义已经够复杂了。
   *
   * 🔴 **部分成功要如实报告**：「12 条成功，2 条失败」，不能因为最后一条
   * 失败就说整批失败（那会让人重试已经成功的 12 条）。
   */
  const submit = async () => {
    if (blocked) return;
    setBusy(true); setSubmitErr("");
    // 🔴 计数分两个。第一版只有 `ok` 且在 `for (kind of lists)` 里累加，于是
    //    「1 台资源 × 两份清单」成功后绿条写「已排除 **2 条**」——
    //    客户会去清单里找第二条。
    const result: BatchResult = { writes: 0, resources: 0, failed: [] };

    for (const id of picked) {
      if (!alive.current) break;   // 弹层已被关掉 —— 停止后续 POST
      const r = byId.get(id);
      if (!r) {
        result.failed.push({ id, reason: zh ? "资源已不在清单里" : "not in list" });
        continue;
      }
      let okForThis = 0;
      for (const kind of lists) {
        const body: ExclusionInput = {
          account_id: srcAccount,
          service: r.service,
          resource_id: r.resource_id,
          region: r.region,
          // 🔴 `level` 自动推。手填选错的后果是**级联排除静默失效** ——
          //    勾了一个 Aurora 集群，UI 显示已排除，三台成员照样出现。
          level: r.tier === "cluster" ? "cluster" : "instance",
          reason: reason.trim(),
          ...(neverExpires ? { never_expires: true } : { expires_at: expiresAt }),
        };
        const resp = await putInspectionExclusion(kind, body);
        if (isFail(resp)) {
          result.failed.push({
            id: `${r.resource_id}→${kind}`,
            reason: resp.message || resp.code,
          });
        } else {
          result.writes += 1;
          okForThis += 1;
        }
      }
      if (okForThis > 0) result.resources += 1;
    }

    setBusy(false);
    if (!alive.current) return;    // 卸载了就别 setState
    if (result.writes === 0 && result.failed.length > 0) {
      // 全失败就留在弹层里 —— 关掉会让人不知道该重试什么。
      setSubmitErr(zh
        ? `全部失败：${result.failed[0].reason}`
        : `All failed: ${result.failed[0].reason}`);
      return;
    }
    onDone(result);
  };

  return (
    /* 620 → 780（2026-09-01，客户要求「加宽一些」）。资源名本来就长
       （`notiops-tb-redis-ap-northeast-1`），后面还要跟 service / 集群 /
       「已在闲置轮排除」三个徽章 —— 620px 下那一行必然换行，而换行之后
       每条资源占两行，一屏只剩四条。
       ⚠️ `Modal` 内部是 `min(width, 100vw - 32px)`，窄屏不会溢出。 */
    <Modal width={780}
      onClose={onClose}
      // 🔴 提交中不许关。关掉的话剩下的 POST 照样发完而没有任何汇总。
      // ⚠️ 有未保存内容时遮罩点击也不关 —— 勾了 8 台、原因填了一半，
      //    鼠标点到弹层外 1 像素就全丢了（Cloudscape 的规矩同此）。
      lockClose={busy}
      dirty={picked.size > 0 || !!reason.trim()}
      title={zh ? "移出巡检范围" : "Exclude from inspection"}
      footer={
        <>
          {/* ⚠️ footer 里原来有一行「已选 0 个 · 写两份清单」，客户圈为废话
              删了。计数**没有丢** —— 挪进了「执行」按钮本身（`执行（N）`），
              与触发弹层的「执行（N 个账号）」同一个形态：数字长在动作上，
              而不是旁边一句随时都在的旁白。
              「写两份清单」更是重复：上面那两个 checkbox 的勾选状态就是它。 */}
          <Btn variant="link" onClick={onClose}>{zh ? "取消" : "Cancel"}</Btn>
          <Btn variant="primary" onClick={submit} loading={busy}
            disabledReason={blocked}>
            {picked.size > 0
              ? (zh ? `执行（${picked.size}）` : `Apply (${picked.size})`)
              : (zh ? "执行" : "Apply")}
          </Btn>
        </>
      }>

      {submitErr && <Alert type="error" onDismiss={() => setSubmitErr("")}>{submitErr}</Alert>}

      {/* ⓿ 选账号。**只在多账号部署时出现** —— 单账号部署下它是一个只有一个
             选项的下拉，纯噪音。

          🔴 位置在最上面，因为它决定下面列出**谁的**资源。放在底部（挨着
             「原因」）的表现是客户勾完 8 台才发现列的是别的账号。 */}
      {accounts.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {/* ⚠️ description 删了（客户圈的第四处废话）。「下面列出这个账号里的
              RDS / Aurora 与 ElastiCache」—— 下拉正下方**就是**那份列表，
              换账号列表跟着变，因果关系自己就能看见，不需要一句旁白。 */}
          <Field label={zh ? "账号" : "Account"}>
            <select value={acct} onChange={(e) => changeAcct(e.target.value)}
              aria-label={zh ? "账号" : "Account"}
              style={{ ...input, width: "auto", minWidth: 240 }}>
              {/* 🔴 `value=""` 代表**部署账号** —— BFF 的 `resolveAccount` 空值
                  兜底就是照这个语义写的。改成传真实 ID 会让那段兜底变成
                  无人经过的死代码。 */}
              <option value="">{zh ? "部署账号" : "Deployment account"}</option>
              {accounts.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.accountName ? `${a.accountName} · ${a.accountId}` : a.accountId}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {/* ① 选服务 */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {SERVICE_TABS.map((s) => (
          <Chip key={s.key} active={svc === s.key} onClick={() => setSvc(s.key)}
            name={`excl_svc_${s.key || "all"}`}>
            {zh ? s.zh : s.en}
            {list && s.key
              ? ` ${list.filter((r) => r.service === s.key).length}`
              : ""}
          </Chip>
        ))}
        <div style={{ flex: 1 }} />
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={zh ? "搜索名称或 ID" : "Search name or ID"}
          style={{ ...input, width: 190 }} />
      </div>

      {/* degraded：读不到 ≠ 账号里没有 */}
      {degraded.length > 0 && (
        <Alert type="warning"
          header={zh ? "部分服务读不到，清单不完整" : "Some services could not be read"}>
          {degraded.map((d) => (d.region ? `${d.region} / ${d.service}: ${d.reason}`
                                             : `${d.service}: ${d.reason}`)).join(" · ")}
        </Alert>
      )}
      {loadErr && <Alert type="error">{loadErr}</Alert>}

      {/* ② 资源清单（多选） */}
      <div style={{
        border: `1px solid ${C.line}`, borderRadius: 8,
        maxHeight: 260, overflowY: "auto", marginBottom: 14,
      }}>
        {list === null ? (
          <div style={{ padding: 12 }}>
            <Status type="in-progress">
              {zh ? "正在读取 RDS 与 ElastiCache 清单…" : "Listing RDS and ElastiCache…"}
            </Status>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{ marginTop: 10 }}>
                <Skeleton w="45%" h={13} />
                <Skeleton w="30%" h={10} style={{ marginTop: 5 }} />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 8 }}>
            <Empty icon="○"
              title={(list.length === 0)
                ? (zh ? "这个账号里没有可排除的资源" : "No resources in this account")
                : (zh ? "没有匹配项" : "No matches")}
              hint={list.length === 0
                ? (zh
                  // 🔴 把**扫过几个 region** 说出来。「这个账号里没有可排除的
                  //    资源」这句话在多 region 之前是骗人的（只看了部署
                  //    region），现在是真的 —— 但客户没法验证，除非我们把
                  //    分母写出来。而 DescribeRegions 失败回落成单 region 时
                  //    这句话又会变成假的，那时上面那条黄警示会同时出现。
                  ? `巡检只覆盖 RDS / Aurora 与 ElastiCache${
                      scanned.length ? `；已扫 ${scanned.length} 个 region` : ""}。`
                  : `Inspection covers RDS/Aurora and ElastiCache only${
                      scanned.length ? `; scanned ${scanned.length} regions` : ""}.`)
                : undefined} />
          </div>
        ) : rows.map((r) => {
          /* 「已排除」= **当前勾选的每一份清单**里都已经有它了 → 这一行没什么
             可做的，checkbox 禁用。

             🔴 判据从 `entryKind` 改成 `lists`（2026-09-01）。入口收成一个之后
                已经没有「从哪份清单点进来」这回事了，而更重要的是它现在
                **随 checkbox 变化**：勾上「闲置轮」之后，一台只在高负载轮里
                被排除过的资源立刻从「已排除」变回可勾选 —— 那才是真的。
                旧写法在两份都勾的情况下会把「只排了一份」的资源显示成
                「已排除」并锁掉，于是另一份**永远补不上**。

             ⚠️ `lists` 为空时 `every` 恒真，所以要先判 size。 */
          const already = lists.size > 0
            && [...lists].every((k) => r.excluded_in.includes(k));
          const other = !already && r.excluded_in.length > 0;
          const rk = rowKey(r);
          const on = picked.has(rk);
          return (
            <label key={`${rk}#${r.tier}`}
              className="insp-row"
              style={{
                display: "flex", gap: 9, alignItems: "flex-start",
                padding: "8px 11px", borderBottom: `1px solid ${C.line}`,
                cursor: already ? "default" : "pointer",
                opacity: already ? 0.55 : 1,
              }}>
              <input type="checkbox" checked={on} disabled={already}
                onChange={() => toggle(rk)}
                style={{ marginTop: 3 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: C.text }}>
                    {r.label}
                  </span>
                  <Badge>{r.service}</Badge>
                  {r.tier === "cluster" && (
                    <Badge tone="blue"
                      title={zh ? "勾中集群会级联排除其下全部成员"
                                : "excluding a cluster cascades to its members"}>
                      {zh ? "集群" : "cluster"}{r.member_count ? ` ×${r.member_count}` : ""}
                    </Badge>
                  )}
                  {/* 🔴 说清**是哪一层**排除的，不只说「已排除」。
                      整账号 / 整服务 / 集群级排除会把这一行的 checkbox 变灰，
                      而客户在这个弹层里撤不掉它们（只能去「巡检范围 →
                      排除清单」删那一行）。只说「已排除」等于摆一个
                      用户无法解决的问题 —— 而他会以为是自己勾错了。

                      ⚠️ `excluded_by` 缺失（存量 BFF）时退回笼统那句，
                         **不猜** `instance`：猜错的方向是告诉客户
                         「取消勾选就行」，而他取消不了。 */}
                  {already && (
                    <Badge title={coverHint(r, lists, zh)}>
                      {coverLabel(r, lists, zh)}
                    </Badge>
                  )}
                  {/* 已在某一份清单里 —— 不说的话客户会以为「没标记」就是两轮都没排。
                      ⚠️ 说**哪一份**，不说「另一份」：入口收成一个之后没有
                         「当前这一份」的概念了，而 `excluded_in` 本来就带着答案。 */}
                  {other && (
                    <Badge tone="amber">
                      {zh
                        ? `已在${r.excluded_in
                            .map((k) => (k === "high" ? "高负载" : "闲置")).join(" / ")}轮排除`
                        : `already excluded in ${r.excluded_in.join(" / ")}`}
                    </Badge>
                  )}
                </div>
                <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>
                  {[r.region, r.klass, r.engine, r.status].filter(Boolean).join(" · ")}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {/* ③ 写进哪份清单 */}
      {/* ⚠️ **不要再加 description。** 这里原来写着「两份清单独立。『这台是
          冷备，别报它闲置，但内存打满还要告警』就只勾闲置。」——
          客户原话：「这些都删掉，都没意义。都是废话。」
          两个 checkbox 的标签（高负载轮 / 闲置轮）已经把「可以分开勾」说完了；
          举例子是在教用户怎么想，而他比我们更清楚自己那台机器是干什么的。 */}
      <Field label={zh ? "写进哪份清单" : "Which lists"}>
        <div style={{ display: "flex", gap: 16 }}>
          {(["high", "idle"] as const).map((k) => (
            <label key={k} style={{
              display: "flex", alignItems: "center", gap: 6,
              fontSize: 13, color: C.text, cursor: "pointer",
            }}>
              <input type="checkbox" name={`excl_list_${k}`}
                checked={lists.has(k)}
                onChange={() => setLists((cur) => {
                  const next = new Set(cur);
                  if (next.has(k)) next.delete(k); else next.add(k);
                  return next;
                })} />
              {k === "high" ? (zh ? "高负载轮" : "High-load") : (zh ? "闲置轮" : "Idle")}
            </label>
          ))}
        </div>
      </Field>

      {/* ④ 有效期 */}
      <div style={{ marginTop: 14 }}>
        {/* ⚠️ description 删了（同上）。「到期后记录保留但不再生效（R1.4），
            列表里会标『已过期』并可一键续期」—— R 编号对客户没有意义，
            而「到期会怎样」是他到那一天在列表里看到的事，不是现在要读的。
            🔴 下面「永不过期」那条 `Status` **保留** —— 它不是说明，
               是对一个**当前选择**的警告，只在选中那一档时出现。 */}
        <Field label={zh ? "有效期" : "Expiry"}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {PRESETS.map((p, i) => (
              <Chip key={i} active={presetIdx === i} onClick={() => setPresetIdx(i)}
                name={`excl_exp_${p.days ?? "never"}`}>
                {zh ? p.zh : p.en}
              </Chip>
            ))}
            <Chip active={presetIdx === 3} onClick={() => setPresetIdx(3)}
              name="excl_exp_custom">
              {zh ? "自定义" : "Custom"}
            </Chip>
            {presetIdx === 3 && (
              <input name="expires_at" value={customDate} placeholder="YYYY-MM-DD"
                onChange={(e) => setCustomDate(e.target.value)}
                style={{ ...input, width: 140 }} />
            )}
          </div>
        </Field>
        {/* ⚠️「永不过期」是个需要被看见的决定 —— 白名单越积越多没人敢删
            正是从这里开始的。 */}
        {neverExpires && (
          <div style={{ marginTop: 6 }}>
            <Status type="warning">
              {zh ? "永不过期的排除项没人会再来复查它 —— 确定要这样？"
                  : "A never-expiring exclusion will never be revisited."}
            </Status>
          </div>
        )}
        {/* ⚠️ 这里原来还有一行「到期日 2026-10-01」（预设档下的换算结果），
            客户圈为废话删了 —— 「30 天」这个 chip 已经说完了这件事，
            具体日期他排除完在列表的「到期」列里看得到。
            自定义档不受影响：那是**输入框**，日期由他自己填。 */}
      </div>

      {/* ⑤ 原因（必填） */}
      <div style={{ marginTop: 14 }}>
        {/* ⚠️ description 删了（同上）。「没有理由的排除是『白名单越积越多
            没人敢删』的起点（R1.3）」—— 那是**我们**要这个字段的理由，
            不是客户填它需要知道的事。`required` 的红星 + placeholder 里的
            例子已经够了。 */}
        <Field label={zh ? "原因" : "Reason"} required>
          <input name="reason" value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={zh ? "例如：预发环境，容量刻意留小" : "e.g. staging, intentionally small"}
            style={input} />
        </Field>
      </div>
    </Modal>
  );
}
