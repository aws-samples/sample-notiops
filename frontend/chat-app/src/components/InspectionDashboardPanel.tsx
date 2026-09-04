/**
 * finding 详情抽屉（右侧滑出）。
 *
 * ## 为什么这个文件此前不存在
 *
 * `api/inspection.ts` 里 `getInspectionFinding` 与 `getInspectionSeries`
 * **全仓零引用** —— 也就是说 DA 的判读全文（`da_body`，S3 里每条 1~3KB）
 * 在界面上完全到不了，没有一条 finding 可点。设计文档承诺的
 * `InspectionDashboard{,Browser,Panel}.tsx` 三件套只做了两件。
 *
 * ## 抽屉而不是新页面
 *
 * 列表留在原位：关掉抽屉不用重新找刚才看到哪一条、不用重新点筛选 chip。
 * 这也是 AWS Console 详情的默认形态。
 *
 * ## 授权
 *
 * 🔴 `/inspection/finding` 挂在 **tab 级** route 上，所以后端额外按 finding
 * 自己的 kind 复核一次（`index.mjs` 的 `INSPECTION_KIND_NAV`）——
 * 只有 `nav:inspection:idle` 的人拿一个高负载 finding 的 id 也读不到它的
 * 判读全文。前端这边什么都不用做，但**不要**把 403 显示成「加载失败」：
 * 那会让人反复重试一个永远不会成功的请求。
 */

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  type FindingDetail, type FindingRow, getInspectionFinding, isFail,
} from "../api/inspection";
import { useLocale, useT } from "../i18n";
import {
  basisLabel, capacityText, degradationLabel, evidenceText, fmtMoney,
  idleFactorText, IDLE_DIM,
  idleBadgeKind, idleTierColor, idleTierText, isCoarse, judgementState,
  parseStatusLabel, PRECISION_LABEL,
  skillsLoadedText, staleEvidenceText, verdictLabel,
} from "./inspection/format";
import {
  Alert, Badge, Btn, Drawer, Expandable, KV, KVGrid, SevBadge, Skeleton, Status,
} from "./inspection/ui";
import { C } from "./inspection/tokens";

export default function InspectionDashboardPanel({
  row, onClose, onExclude, onJudge, judging, judged,
  judgeMsg, onDismissJudge,
}: {
  /** 列表里那一行。**先用它渲染头部**，判读全文再异步补 —— 见下。 */
  row: FindingRow;
  /* 🔴 **这里原来有 `accountId`（页面选中的账号），2026-09-01 删掉。**

     它是一个真实缺陷的载体：finding 列表**跨账号**取
     （`getInspectionFindings(kind)` 不传账号 → `?all=1`），而详情端点的
     主键是 `PK=inspfind#<账号>`。传页面账号的表现：

     ```
     卡片上那条属于某成员账号，页面选中的是管理账号
       → 查 PK=inspfind#444455556666 + SK=111122223333#…#idle#-
       → PK 与 SK 里的账号对不上 → 必然 not_found
       → 抽屉的「AI 判读」那一节红字「读取失败：not_found」
     ```

     客户实测到的形态：刚点「深入分析」派发成功（`doJudge` 用的是
     `f.account_id`，落库正确），抽屉却立刻报读取失败 —— 看起来像判读失败了，
     而实际那条判读正在跑。

     ⚠️ **不要把它加回来**。账号是 finding 自己的属性（`row.account_id`，
        且 `finding_id` 的首段就是它），不该由调用方另给一个可能不一致的值。
        这与 `ExclusionModal` 那处是同一个根因的两处漏网。 */
  onClose: () => void;
  onExclude?: () => void;
  /**
   * 派一次 DA 判读（可带一句运维手填的背景）。
   *
   * 🔴 名字从 `onInvestigate` 改成 `onJudge`，因为**行为换了**：
   *    以前是「跳到聊天页、用预填的一句话开一个普通 LLM 会话」——
   *    不调 DA、不用 skill，而且账号继承聊天页选择器（与这条 finding 无关）。
   *    现在是「走 executor → 用写好的判读 skill → 真调 DA → 结果绑回这条
   *    finding」。留着旧名字会让下一个人以为它还是跳聊天。
   */
  onJudge?: () => void;
  /** 正在派发中 —— 按钮进 loading，防重复点。 */
  judging?: boolean;
  /**
   * 这一条**派过判读了没有**。由列表那一层算（`isJudged`），本组件不自己判。
   *
   * 🔴 原来这里判的是 `!row.da_task_id`，而 `row` 是「点开那一刻的快照」——
   * 派发成功后后端写上了 `da_task_id`、列表也 reload 了，但快照不变，于是
   *
   * ```
   * 抽屉里「判读已派发」那一块不出现（判据 row.da_task_id 恒空）
   * 蓝色「深入分析」按钮还在、还能点（判据 !row.da_task_id 恒真）
   * → 客户再点一次 → 后端拒 already_dispatched → 看起来像失败
   * ```
   *
   * 2026-09-01 客户实测报的就是这个。修法是两条：列表那层把 `row` 改成从
   * 最新取数里派生（不再传快照），以及判据收到这一个 prop 上来 ——
   * 后者让「列表说已派发、抽屉说没派」这种自相矛盾在结构上不可能出现。
   */
  judged?: boolean;
  /**
   * 派发回执 —— **列表那层算的同一条**，抽屉里再显示一份。
   *
   * 🔴 不传的表现是派发动作完全静默：`judgeMsg` 渲染在列表区顶部，而抽屉
   * `zIndex: 1000` 盖在它上面，且派发**只能从抽屉里发起**（卡片按钮已删）。
   * 成功那一支还能靠 reload 之后的「⏳ 判读中」自证，而 `http_403` /
   * `kill_switch` / `conflict` 这些**永远不会自己变**的失败在抽屉里就是
   * 点了没反应。
   */
  judgeMsg?: { type: "success" | "error" | "warning"; text: string } | null;
  onDismissJudge?: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const zh = locale !== "en";

  /* ⚠️ `note` / `noteOpen` 两个 state 已挪进 `JudgeModal`（2026-08-31）——
     备注是「派判读」这个动作的输入，不是这条 finding 的属性。
     留在这里就是它离按钮 350px 远的根源。 */
  const [detail, setDetail] = useState<FindingDetail | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  /** 「诊断信息」折叠区。默认收起 —— 它是排查用的，不影响「要不要处置」。 */
  const [diagOpen, setDiagOpen] = useState(false);

  /**
   * 闲置评分条的**满格分数** = 本条 finding 里权重最大那一维的上限。
   *
   * 一维的贡献分上限就是 `生效权重 × 100`（归一化值取 1 时）。所以：
   *
   * ```
   * RDS          权重 40/30/20/10  → barMax 40
   * ElastiCache  权重 35/35/30     → barMax 35
   * ```
   *
   * 🔴 这里原来写死 **40**，注释说是「RDS 单维最高权重 0.40」。对
   * ElastiCache 就错了 —— 它任何一维都到不了 40，于是**没有一条条能满**。
   * 客户实测原话：「这里 30 分是满分，为什么仍然没有沾满绿色进度条？」
   * 那一维（请求数，权重 30%）拿到了它可能的最高分 30.0，条却只有 75%。
   *
   * ⚠️ 分母仍然是「**最大那一维**的上限」而不是「每一维自己的上限」——
   * 后者等于把归一化值画出来，而那正是上面那条注释拒绝的事（权重 0.30 的
   * 维度满格时会和权重 0.35 的满格一样长，读起来像两者贡献相同）。
   * 现在的语义是「谁把这个分推上去的」：请求数满格但权重小，条就该短一截。
   *
   * ⚠️ 权重全缺时回落到 40（老数据没有 `w` 字段），且下面那行列头说明
   * 跟着显示真实数字，不再写死「满格 40」。
   */
  const barMax = (() => {
    const ws = (row.idle_factors ?? [])
      .map((f) => f.weight)
      .filter((w): w is number => typeof w === "number" && w > 0);
    return ws.length ? Math.max(...ws) * 100 : 40;
  })();

  /**
   * 「派过判读了没有」—— 本组件里**只用这一个值**判，不再各处读
   * `row.da_task_id`。
   *
   * ⚠️ `?? Boolean(row.da_task_id)` 是给不传 `judged` 的调用方兜底
   * （测试 / 将来别处复用）。有 `judged` 时它优先，因为它含乐观状态、
   * 且它是列表那层从最新取数算出来的。
   */
  const dispatched = judged ?? Boolean(row.da_task_id);


  /**
   * 判读状态（七档）。**与卡片同一个派生函数**（`format.ts::judgementState`）。
   *
   * 🔴 抽出来之前抽屉只有一个 `dispatched && !hasJudgment` 判据，
   *    2026-09-02 review 抓到它同时错了三处：
   *
   *    ```
   *    A2  EMPTY / missing_section（有 task_id、有 parse_status、无 body）
   *        → 恒真 → 永久显示蓝色「1~3 分钟后回来」，那个状态不会退出
   *    A3  parse_failed 的 body 是**整份报告原文**（可能含同批别的资源），
   *        被当成本条结论渲染，还配着「AI 判读」标题与时间徽章
   *    A4  reused / playbook（高负载轮也会出现）→ 落到「还没有判读结果」，
   *        把正常状态说成疑似故障；budget / quota 显示同一句话，
   *        看不出「因额度未分析」
   *    ```
   *
   * ⚠️ `detailBody` 传抽屉自己拉到的全文 —— 它比列表的 `has_judgment` 权威
   *    （列表那个是 `Boolean(da_body)`，而这里拿到的是正文本身）。
   */
  const state = judgementState(row, {
    dispatched, detailBody: detail?.da_body,
  });

  /**
   * 要不要渲染「AI 判读」那一整节。
   *
   * ```
   * 闲置类 + 从没派过判读   ✗  定时闲置轮结构上不派 DA，那一节的三句话
   *                            全是主动的错误陈述（见下面那段长注释）
   * 其余任何情况           ✓  包括「闲置类但手动派过」—— 判读正文必须有地方去
   * ```
   *
   * 🔴 `dispatched` 这一半是 2026-09-01 补的。缺它的时候手动派给闲置 finding
   * 的判读**完全没有落点**：额度花了、结果回来了、库里也有，而界面上到不了。
   */
  const showAi = row.kind !== "idle" || dispatched;

  /**
   * 读详情用哪个账号。**只从这一行自己来。**
   *
   * 🔴 详情端点的主键是 `PK=inspfind#<账号>` + `SK=<finding_id>`，而
   * `finding_id` 的**第一段就是账号**（`<账号>#<region>#<service>#…`）。
   * 也就是说「查哪个分区」这件事完全由这一行决定，不该由调用方另给 ——
   * 给错的表现是 PK 与 SK 里的账号对不上，必然 `not_found`。
   *
   * ⚠️ 两级：属性优先，回退 `finding_id` 首段。属性理论上恒有
   * （`shapeFinding` 会填），但它是 `String(it.account_id || "")` ——
   * 存量行缺这个属性时会是空串，而那时空串会被当成「部署账号」兜底，
   * 于是又回到查错分区。首段这一档让它在任何情况下都指向对的分区。
   */
  const detailAccount = row.account_id || row.finding_id.split("#")[0] || undefined;

  useEffect(() => {
    let dead = false;
    /**
     * 🔴 闲置轮**不发这个请求**。
     *
     *    `detail` 的唯一读点是「AI 判读」那一块（`da_updated_at` / `da_body`），
     *    而那一块对 `kind === "idle"` 已经整节不渲染 —— 请求打出去只有坏处：
     *
     *    ```
     *    前端按 da_task_id 去查 invst# 行，而闲置轮从没派过 DA
     *      → not_found
     *      → setErr("读取失败：not_found")
     *      → 抽屉里一条**红色**的「读取失败」（2026-08-31 实机用户看到的就是它）
     *    ```
     *
     *    删掉那一块之后红字不会再显示了，但请求还在打 —— 每打开一条闲置
     *    finding 就是一次注定失败的往返 + 一条服务端错误日志。
     *
     * ⚠️ `setLoading(false)` 要照样调。留在 `true` 会让那一块（对非 idle）
     *    永远显示骨架屏 —— 而这个 early return 走的是 idle 分支，
     *    将来有人把判据放宽就会踩到。
     */
    (async () => {
      setLoading(true); setErr(""); setDetail(null);
      // 🔴 短路点在这里（**setState 之后**）而不是 effect 顶部：
      //    顶部 early return 要先把三个 state 重置一遍才能退出，而那是
      //    `react-hooks/set-state-in-effect` 明确禁止的形态（eslint 会报）。
      //    放在这里既复用了上面那次重置，也照样一个请求都不发。
      // 🔴 判据必须与 `showAi` **同一个**（2026-09-01）：不渲染那一节才跳过
      //    请求。原来只判 `kind === "idle"`，而手动「深入分析」能给闲置类派
      //    真判读 —— 那时 `showAi` 为真、这里却短路，于是「AI 判读」那一节
      //    永远停在 `detail === null` 的分支，显示「这条还没有 AI 判读」，
      //    而库里躺着 1833 字符的正文。
      if (!showAi) { setLoading(false); return; }
      const d = await getInspectionFinding(row.finding_id, detailAccount);
      if (dead) return;
      setLoading(false);
      if (isFail(d)) {
        /* 403 / not_found / 其它三分，因为下一步动作完全不同。

           ⚠️ 判据里原来还有 `|| d.code === "forbidden_kind"`，那一半**恒假**：
              BFF 那条是 `json(403, {code: "forbidden_kind"})`，而
              `api/inspection.ts::get()` 对任何非 2xx 一律把 `code` 覆写成
              `"http_" + r.status` —— 响应体里的 `code` 到不了这里（`message`
              倒是保留了）。留着会让人以为多了一道防线。 */
        if (d.code === "http_403") {
          setErr(zh ? "没有查看这一类 finding 详情的权限"
                    : "Not authorised for this finding kind");
        } else if (d.code === "not_found") {
          /* 🔴 到这里的 `not_found` 只剩一种真实含义：**那条 finding 已经不在
             库里了**（配置变更按 R6.9 会 resolve 全部旧 finding 并重建，
             finding_id 里含 rule_version / 规则哈希，所以会换 id）。

             以前它还有另一个来源 —— 账号传错（详情主键是
             `inspfind#<账号>`，而这里曾经传页面选中的账号）。那个已经在
             `detailAccount` 修掉了；留下这句人话是因为原来的
             「读取失败：not_found」既没说是什么，也没说下一步做什么。 */
          setErr(zh
            ? "这条 finding 已不在库里 —— 判定规则或阈值变更后旧条目会被重建"
              + "（换了新 id）。点右上角「刷新」看最新一批。"
            : "This finding no longer exists — entries are rebuilt with a new id "
              + "after a rule or threshold change. Refresh to see the current list.");
        } else {
          setErr(zh ? `读取失败：${d.code}` : `Failed: ${d.code}`);
        }
        return;
      }
      setDetail(d);
    })();
    return () => { dead = true; };
    // ⚠️ 依赖里放 `showAi` 而不是 `row.kind`：判据换了，依赖也得跟着换 ——
    //    否则「派发之后 showAi 由假变真」这一跳不会触发重取，那一节仍然空着。
    //
    // 🔴 `row.has_judgment` / `row.da_parse_status` 也必须在依赖里。
    //    缺它们的表现（2026-09-02 review 抓到，是这条功能的**终点动作**坏掉）：
    //
    //    ```
    //    点「深入分析」→ 1~3 分钟后判读落库 → 列表 reload() 拿到
    //      has_judgment: true，而抽屉的四个依赖一个都没变
    //      → detail 仍是打开那一刻的空 da_body
    //      → 分支落到「还没有判读结果 / 解析状态：ok」
    //    ```
    //
    //    而 `insp.judge.dispatched` 的文案正是「1~3 分钟后回来。点右上角
    //    「刷新」查看」—— 客户照做，看到的是从蓝色「判读中」退化成灰色
    //    「还没有判读结果」，正文必须关掉抽屉重开才出现。
    //
    // ⚠️ 用这两个字段而不是 `row` 整体：`row` 每次 reload 都是新对象身份，
    //    放进去会让抽屉每次列表刷新都重新拉一次详情（1~3KB × 每次轮询）。
  }, [row.finding_id, detailAccount, zh, showAi,
    row.has_judgment, row.da_parse_status]);

  // ⚠️ 头部用**列表那一行**渲染，不等详情回来 —— 抽屉一打开就该有内容。
  //    等详情的表现是点开先看到一片空白，而 90% 的信息列表里已经有了。
  const ev = evidenceText(row, zh);
  const cap = capacityText(row);
  const showMoney = row.kind === "idle" && row.savings_usd !== null;
  // 证据是不是上一轮留下的（chronic / resolving 保留最后一次已知水位）。
  const stale = staleEvidenceText(row, zh);

  return (
    /* 560 → 680（2026-09-01，客户要求「更宽一些」）。判读正文里常有表格与
       代码块（skill 的输出），560px 下 GFM 表格要横向滚。
       ⚠️ `Drawer` 内部是 `min(width, 100vw)`，窄屏不会溢出。 */
    <Drawer onClose={onClose} width={680}
      title={
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {/* 🔴 与卡片首格**同一个判据**（2026-09-01）。卡片对闲置类放评分而不放
              严重度，理由是「闲置的 severity 恒为 INFO，一整页 20 个同样的灰
              『提示』徽标零信息量」—— 而抽屉标题原来仍然挂着那个「提示」。
              同一条 finding 在列表上是「99/100」、点开变成「提示」，
              客户会以为这是两个不同的分级。 */}
          {/* 🔴 判据不足单独一档（与卡片首格**同一个** `idleBadgeKind`）——
              退回 `SevBadge` 的表现是灰色「提示」，与「闲置分很低」不可区分，
              而后端专门把 0 改成 `None` 就是为了区分这两件事。 */}
          {idleBadgeKind(row) === "undecided" ? (
            <span title={t("insp.idle.undecidedWhy")}
              style={{
                fontSize: 12.5, fontWeight: 700, padding: "2px 9px",
                borderRadius: 100, whiteSpace: "nowrap",
                color: "var(--amber)", border: "1px solid var(--amber)",
              }}>
              {t("insp.idle.undecided")}
            </span>
          ) : row.kind === "idle" && row.idle_score !== null ? (
            /* 档位与颜色都走 `idleTier*`（与卡片首格**同源**）——
               原来两处各写一遍 `>= 80` / `>= 60`，漂开就是
               「同一条 finding 在列表上是红的、点开变成橙的」。
               档名进 `aria-label`：档位此前**只由颜色表达**。 */
            <span
              title={`${zh ? "闲置分" : "Idle score"} ${row.idle_score.toFixed(0)}/100`
                + `（${idleTierText(row.idle_score, zh)}）`}
              aria-label={`${zh ? "闲置分" : "Idle score"} ${row.idle_score.toFixed(0)}`
                + `/100，${idleTierText(row.idle_score, zh)}`}
              style={{
                fontSize: 12.5, fontWeight: 700, padding: "2px 9px",
                borderRadius: 100, whiteSpace: "nowrap",
                color: idleTierColor(row.idle_score),
                border: `1px solid ${idleTierColor(row.idle_score)}`,
              }}>
              {row.idle_score.toFixed(0)}
              <span style={{ fontSize: 10, fontWeight: 400, opacity: .75 }}>/100</span>
            </span>
          ) : (
            <SevBadge sev={row.severity} label={t(`insp.sev.${row.severity}`)} />
          )}
          {row.instance}
        </span>
      }
      subtitle={`${row.service} · ${row.region} · ${row.account_id}`}
      footer={
        <>
          {onExclude && (
            <Btn onClick={onExclude}>{zh ? "移出巡检范围" : "Exclude"}</Btn>
          )}
          {/* 🔴 三态，**互斥**：
                 已派过        不渲染按钮，只给一行状态 + DA 后台链接
                 没派过        [深入分析]（点了走 onJudge，带上备注框里的话）
                 无权/无回调    什么都不渲染

              ⚠️ 已派过时按钮**不渲染**而不是灰掉：灰着等于在界面上摆一个
                 用户无法解决的问题（本仓库既有约定），而且重复派发会重复烧
                 DA 额度、两份判读回填到同一行只会互相覆盖。 */}
          {/* 点了开确认弹窗（`JudgeModal`），不直接派。
              ⚠️ 已派过时**不渲染**而不是灰掉：灰着等于在界面上摆一个用户
                 无法解决的问题，而重复派发会重复烧额度、两份判读回填到同一行
                 只会互相覆盖。 */}
          {onJudge && !dispatched && (
            <Btn variant="primary" onClick={onJudge}
              loading={!!judging}
              title={t("insp.judge.hint")}>
              {zh ? "深入分析" : "Investigate"}
            </Btn>
          )}
          {/* 🔴 **footer 里不再有「取消」**（2026-09-01）。
              抽屉是只读视图，没有「提交 / 取消」这一对语义 —— 而「取消」这个词
              暗示「刚才那些操作会被撤销」，而它其实只是关闭。
              关闭已经有三条路：右上角 ✕、Esc、点遮罩。 */}
        </>
      }>

      {/* ── 派发回执 ──
          🔴 与列表区那一份**是同一条**（同一个 `judgeMsg` state），这里再渲染
             一遍。理由是抽屉 `zIndex: 1000` 盖住列表区，而派发**只能从抽屉里
             发起**（卡片上的按钮 2026-09-01 删了）—— 也就是说不在这里渲染，
             那条提示 100% 落在客户看不见的地方。

          ⚠️ 放在**正文最上面**而不是 footer：footer 里的内容会被长正文
             （判读全文能有 46vh）挤到视口外，而回执是刚点完那一下要看的。
          ⚠️ 成功那一支也留着：reload 之后的「⏳ 判读中」要 1~2 秒才到，
             中间那段空白就是客户以为「点了没反应」的窗口。 */}
      {judgeMsg && (
        <div style={{ marginBottom: 12 }}>
          <Alert type={judgeMsg.type} header={judgeMsg.text}
            onDismiss={onDismissJudge} />
        </div>
      )}

      {/* ── 判定证据 ──
          🔴 这里**只放卡片上没有的、且影响决策的**（2026-09-01）。
             原来 9~11 项平铺，其中对一条闲置 finding 是这样：

             ```
             规则 idle                  ← 页面本身就叫「闲置与成本」
             状态 新增                   ← 卡片右上角已有同名徽章
             已持续 2天                  ← 卡片已有
             首次发现 2026-08-31        ← 卡片已有
             预计月节省 $15 + 精度说明   ← 卡片已有
             规则版本 2026-08-31T02:09:52.670805+00:00   ← 带微秒的 ISO 串
             连续命中/连续未命中 1 / 0    ← 状态机内部计数
             ```

             7 项里 4 项与卡片重复、3 项是内部标识 —— 上半屏零决策价值，
             而真正的内容（评分明细、AI 判读）被推到折叠线以下。
             规则 / 规则版本 / 连续命中 / 状态 收进下面的「诊断信息」。 */}
      <KVGrid cols={2}>
        {ev && (
          <>
            <KV label={row.metric || t("insp.field.metric")}>
              <b style={{ fontSize: 15 }}>{ev.value}</b>
              {/* `relation` 为空 = 后端没给 `direction` —— 只说阈值，不猜方向。
                  见 `format.ts::evidenceText` 那段说明。 */}
              <span style={{ color: C.muted, fontSize: 12, marginLeft: 6 }}>
                {ev.relation
                  ? `${ev.relation} ${ev.threshold}`
                  : (zh ? `阈值 ${ev.threshold}` : `threshold ${ev.threshold}`)}
              </span>
              {/* 🔴 陈旧证据的标注在**数字紧邻处**，不在页脚。
                  放远了等于没标 —— 客户读到数字就已经形成判断了。 */}
              {stale && (
                <div style={{ color: C.amber, fontSize: 11, marginTop: 3 }}>
                  {stale}
                  <div style={{ color: C.muted, marginTop: 2 }}>
                    {zh
                      ? "本轮未命中，但水位没回到健康区 —— 显示的是最后一次命中时的数值。"
                      : "Not hit this run, but the level has not recovered; showing last known values."}
                  </div>
                </div>
              )}
            </KV>
            {cap && <KV label={zh ? "原始值 / 规格" : "Raw / capacity"}>{cap}</KV>}
          </>
        )}
        {/* ⚠️ 「已持续 N 天」卡片上已经有了，这里**只留首次发现的日期** ——
            卡片上那个 `（2026-08-31）` 括号是冗余的，已从卡片移到这里。 */}
        <KV label={t("insp.field.firstSeen")}>{row.first_seen_date || "—"}</KV>
        {/* 🔴 越线的 finding 这一栏必然是**负数**（`headroom = (T - x)/|T|`，
            `is_breached` 就是靠它 ≤ 0 判的）。而标签写「余量」，读起来像
            「剩余容量 -21.4%」—— 客户要反应一下才明白是超了。
            负值改说「已超出 21.4%」，正值才叫余量。 */}
        {row.headroom !== null && (
          row.headroom < 0 ? (
            <KV label={zh ? "已超出阈值" : "Over threshold"}
            >{(Math.abs(row.headroom) * 100).toFixed(1)}%</KV>
          ) : (
            <KV label={zh ? "余量" : "Headroom"}
            >{(row.headroom * 100).toFixed(1)}%</KV>
          )
        )}
        {showMoney && (
          <KV label={t("insp.field.savings")}>
            <b style={{ color: C.green }}>{fmtMoney(row.savings_usd)}</b>
            {row.savings_precision && isCoarse(row.savings_precision) && (
              <div style={{ color: C.amber, fontSize: 11, marginTop: 3 }}>
                {PRECISION_LABEL[row.savings_precision]?.[zh ? "zh" : "en"]
                  || row.savings_precision}
              </div>
            )}
          </KV>
        )}
      </KVGrid>

      {/* ── 诊断信息（默认折起）──
          规则码、规则版本、状态、状态机计数 —— 这些是**排查用的**，
          对「今天要不要处置这条」没有影响。默认展开时它们占掉上半屏，
          把评分明细和 AI 判读挤到折叠线以下。
          ⚠️ 不是删掉：`rule_version` 是解释「为什么这条的天数重新计过」的
             唯一凭据（R6.9），排查时必须拿得到。 */}
      <div style={{ marginTop: 12 }}>
        <Expandable title={zh ? "诊断信息" : "Diagnostics"}
          open={diagOpen} onToggle={() => setDiagOpen((v) => !v)}>
          <KVGrid cols={2}>
            <KV label={zh ? "规则" : "Rule"}>
              <code style={{ fontSize: 12 }}>{row.rule || "—"}</code>
            </KV>
            <KV label={zh ? "状态" : "State"}>
              {row.state ? t(`insp.state.${row.state}`) : "—"}
            </KV>
            <KV label={zh ? "连续命中 / 未命中" : "Hits / misses"}>
              {row.consecutive_hits ?? "—"} / {row.consecutive_misses ?? "—"}
            </KV>
            <KV label={zh ? "规则版本" : "Rule version"}>
              <code style={{ fontSize: 11 }}>{row.rule_version || "—"}</code>
            </KV>
          </KVGrid>
        </Expandable>
      </div>

      {/*
        ── 闲置评分明细：四维（或三维）逐行 ──

        🔴 这是「凭什么说它闲」的完整回答。卡片上只有总分 + 主因两维，
        点进来要能看到每一维的**权重、实测值、贡献分、归一化依据**。

        `deterministic_conclusion` 的文案写着「结论与降配目标见本条的评分
        明细」—— 在这一段落地之前那句话指向的东西并不存在。

        ⚠️ 权重列显示的是**重归一化后**的生效权重，所以各维之和 = 100%。
        显示配置里的原始权重会让四维加起来不等于 1，客户会以为算错了；
        少掉的那几维在下面「已丢弃维度」里单独说。
      */}
      {row.kind === "idle" && (row.idle_factors?.length ?? 0) > 0 && (
        <>
          <div style={{
            marginTop: 18, fontSize: 13, fontWeight: 700, color: C.text,
            display: "flex", alignItems: "baseline", gap: 8,
          }}>
            {zh ? "闲置评分明细" : "Idle score breakdown"}
            {row.idle_score !== null && (
              <span style={{ fontSize: 12, color: C.muted, fontWeight: 400 }}>
                {zh ? "总分 " : "total "}
                <b style={{ color: C.text }}>{row.idle_score.toFixed(1)}</b>/100
              </span>
            )}
          </div>
          <div style={{ marginTop: 8 }}>
            {[...(row.idle_factors ?? [])]
              .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
              .map((fac) => {
                const x = idleFactorText(fac, zh);
                // 条宽按**贡献分**，满格 = 本条里权重最大那一维的上限（`barMax`）。
                // ⚠️ 不按归一化值画：那会让权重 0.10 的 IOPS 画出和权重
                //    0.40 的 CPU 一样长的条，而它对总分的影响只有 1/4。
                const pct = Math.max(0, Math.min(100,
                  ((fac.points ?? 0) / barMax) * 100));
                return (
                  <div key={fac.name} style={{
                    display: "flex", alignItems: "baseline", gap: 8,
                    fontSize: 12.5, padding: "5px 0",
                    borderBottom: `1px solid ${C.line}`,
                  }}>
                    <span style={{ width: 82, color: C.text }}>{x.label}</span>
                    <span style={{
                      width: 62, textAlign: "right", color: C.text,
                      fontWeight: 600,
                    }}>{x.observed || "—"}</span>
                    <span style={{
                      width: 44, textAlign: "right", color: C.muted,
                      fontSize: 11,
                    }}>
                      {fac.weight !== null ? `${(fac.weight * 100).toFixed(0)}%` : "—"}
                    </span>
                    {/* 🔴 `role="progressbar"` + 值语义。
                        纯 div 拼的条对读屏是**完全不存在**的 —— 而这条是
                        「凭什么说它闲」里唯一表达「各维度贡献多少」的东西，
                        剩下四列都是裸数字。
                        ⚠️ `aria-valuenow` 报**贡献分**而不是那个百分比：
                           百分比是相对 `barMax` 的画图口径，读出来是
                           「87%」而列头写的是「贡献分（满格 40）」，
                           两个数对不上。 */}
                    <div role="progressbar"
                      aria-label={x.label}
                      aria-valuenow={fac.points ?? undefined}
                      aria-valuemin={0}
                      aria-valuemax={Number(barMax.toFixed(0))}
                      aria-valuetext={fac.points === null
                        ? (zh ? "本维度未参与评分" : "not scored")
                        : `${x.points} / ${barMax.toFixed(0)}`}
                      style={{
                        flex: 1, height: 7, background: "var(--menu-hover)",
                        borderRadius: 4, overflow: "hidden", minWidth: 40,
                      }}>
                      <div style={{
                        width: `${pct}%`, height: "100%", background: C.green,
                      }} />
                    </div>
                    <span style={{ width: 52, textAlign: "right", color: C.text }}>
                      {x.points}
                    </span>
                  </div>
                );
              })}
          </div>
          {/* 列头说明放在**下面**：五列里三列是数字，先看数字再看它们是什么
              比反过来快。放上面会在窄抽屉里挤成两行。 */}
          <div style={{ marginTop: 5, fontSize: 11, color: C.muted }}>
            {/* ⚠️ 满格分数**跟着资源类型变**（RDS 40 / ElastiCache 35），
                不能写死 —— 写死 40 时 ElastiCache 的条永远满不了，
                而列头还告诉客户「满格 40」，于是那个 30.0 分看起来像没算对。 */}
            {zh ? `维度 · 实测值 · 生效权重 · 贡献分（满格 ${barMax.toFixed(0)}）`
              : `dimension · observed · effective weight · points (full = ${barMax.toFixed(0)})`}
          </div>
          {/* 🔴 丢弃的维度必须列出来，且说清「权重去哪了」。
              不说的表现是客户对着一个 87 分问「存储那一维呢」，
              而看板上没有任何地方回答得了。 */}
          {(row.idle_degraded?.length ?? 0) > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: C.amber }}>
              {zh
                ? `已丢弃 ${(row.idle_degraded ?? []).length} 维（缺数据，权重已按比例重分给上面各维）：`
                : `${(row.idle_degraded ?? []).length} dimension(s) dropped, weights redistributed: `}
              {(row.idle_degraded ?? [])
                .map((d) => IDLE_DIM[d]?.[zh ? "zh" : "en"] || d)
                .join(zh ? "、" : ", ")}
              {row.idle_weight_avail !== null && (
                // ⚠️ 间距用 marginLeft，不用全角空格 —— eslint 的
                //    `no-irregular-whitespace` 会直接报错。
                <span style={{ color: C.muted, marginLeft: 8 }}>
                  {zh ? `判据覆盖 ${(row.idle_weight_avail * 100).toFixed(0)}%`
                    : `(basis coverage ${(row.idle_weight_avail * 100).toFixed(0)}%)`}
                </span>
              )}
            </div>
          )}
          {/* 归一化依据 —— 回答「这个百分比的分母是哪来的」。
              ⚠️ 折叠成一行小字：它是追溯用的，不该和主表争注意力。 */}
          <div style={{ marginTop: 6, fontSize: 11, color: C.muted }}>
            {(row.idle_factors ?? []).filter((fc) => fc.basis).map((fc) => {
              const dim = IDLE_DIM[fc.name];
              return `${dim ? (zh ? dim.zh : dim.en) : fc.name}: ${basisLabel(fc.basis, zh)}`;
            }).join(zh ? " · " : "  ·  ")}
          </div>
        </>
      )}

      {/* 🔴 **这里原来还有一个独立的「判读已派发」琥珀块**，2026-09-01 删掉、
             并进下面「AI 判读」那一节的等待态。删之前这一屏是（客户截图）：

             ```
             ⚠ 判读已派发，1~3 分钟后回来。点右上角「刷新」查看。
               task: 93c22b0c-…
             AI 判读
             ○ 这条还没有 AI 判读
               判读是异步回来的（通常 1~3 分钟）。如果一直没有，回到「高负载」
               页底部展开「系统状态」看「派发缺口」——那个数 >0 意味着…
               task: 93c22b0c-…
             ```

             同一件事说了两遍、task id 出现两次、外加三行「如果一直没有」的
             排障指引 —— 而这是**刚派发 10 秒**的正常等待态，不是故障态。
             客户原话：「这一大堆太繁琐了。我希望简洁、干净、精准的 UI。」

             ⚠️ 更早之前这里还有一个备注输入框（2026-08-31 挪进 `JudgeModal`）。
                别把任何东西加回这个位置 —— 「AI 判读」一节自己就是判读状态的
                唯一落点，第二个落点必然重复。 */}

      {/* ── AI 判读全文 ──
          🔴 **闲置轮整节不渲染**（2026-08-31 实机暴露）。

          闲置轮设计上不派 DA（`gating.DETERMINISTIC_RUN_TYPES = {"idle"}`），
          结论就是上面那份「闲置评分明细」。而这一节原来对它显示的是：

            ○ 这条还没有 AI 判读
              判读是异步回来的（通常 1~3 分钟）。如果一直没有，回到「高负载」
              页底部展开「系统状态」看「派发缺口」——那个数 >0 意味着…

          两句都是**主动的错误陈述**：判读不会来（不是「还没」），
          而闲置轮从没派发过、那个「派发缺口」恒为 0 —— 客户照着查会得出
          「派发正常，那就是还在路上」，然后一直等。
          用户原话：「到底有没有AI判读？」

          ⚠️ 为什么是**整节删**而不是换成一句「本轮不派 AI」：
             那句话对这一条 finding 没有任何可操作信息，而「这个系统有 AI 判读、
             为什么闲置这里没有」属于产品说明 —— 已经放在「闲置与成本」页的
             副标题里说了一次（`InspectionDashboard.tsx` 的 `PAGE.idle.sub`）。
             16 条 finding 上各重复一遍是噪音。

          ⚠️ 也**不能**反过来把整节对所有 kind 都删掉：高负载与配置检查那两类
             是真的「可能有、也可能没有」，R12.4 要求那两态必须能区分
             （「判读没回来」与「DA 说没问题」长得一样是最坏的结果）。

          🔴 **但判据不能只卡 `kind === "idle"`**（2026-09-01 客户实测）。
             那个判据成立的前提是「闲置类永远没有判读」，而**手动「深入分析」
             把这个前提打破了** —— 它能给任意一条 finding 派真 DA，包括闲置类。
             于是实机上出现：

             ```
             闲置 finding 手动派了判读 → DA COMPLETED → 解析 ok
               → da_verdict=warm_up、da_body 1833 字符全都落库了
               → 而抽屉对 kind=idle 整节不渲染
               ⇒ 那 1833 字符**没有任何地方能显示**
               ⇒ 客户花了 DA 额度，拿不到结果，且抽屉还在说「等结果回来」
             ```

             所以判据改成「闲置类**且从没派过判读**」才不渲染。定时闲置轮
             （从不派发）的行为完全不变 —— 上面那几段理由仍然成立。 */}
      {showAi && (
      <div style={{
        marginTop: 18, fontSize: 13, fontWeight: 700, color: C.text,
        display: "flex", alignItems: "center", gap: 8,
      }}>
        {zh ? "AI 判读" : "AI analysis"}
        {detail?.da_updated_at && (
          <Badge>{new Date(detail.da_updated_at * 1000).toISOString().slice(0, 16)
            .replace("T", " ")} UTC</Badge>
        )}
      </div>
      )}

      {/* ── 7.9a skill 门禁的结论（D22 第二步）——「这份判读可不可信」──

          🔴 放在正文**上面**、且不依赖正文那条 ternary 链：门禁结论与判读
             同一次 UpdateItem 落库，`parse_failed` / `missing_section` 的行
             也带着它（第一步特意让 gate_kw 在那两条路径上同行）—— 挂进
             `da_body` 那个分支会让「解析失败 + skill 没加载」只显示前一半，
             而后一半才解释了为什么会失败。

          🔴 判据 `=== false` / `=== true`，三态。`null`（存量行 / 门禁没跑）
             什么都不渲染 —— 卡片徽标同一条规则（R12.4 的反面：把「不知道」
             渲染成「不可信」，存量行会全部误报）。

          ⚠️ 卡片徽标的 title 是一整句悬浮文案，这里是**逐档一行**：抽屉是
             唯一能从容读字的地方，8 档文案的价值全在「读完知道去动哪里」。 */}
      {showAi && row.da_gate_trustworthy === false && (
        <div style={{ marginTop: 8 }}>
          <Alert type="error" header={t("insp.gate.headUntrusted")}>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12 }}>
              {(row.da_degradations ?? []).map((c) => (
                <li key={c} style={{ marginBottom: 3 }}>
                  <code style={{ fontSize: 11 }}>{c}</code>
                  {" "}{degradationLabel(c, t)}
                </li>
              ))}
            </ul>
            {skillsLoadedText(row, zh, t) && (
              <div style={{ marginTop: 5, fontSize: 12 }}>
                {skillsLoadedText(row, zh, t)}
              </div>
            )}
          </Alert>
        </div>
      )}
      {showAi && row.da_gate_trustworthy === true
        && (row.da_degradations?.length ?? 0) > 0 && (
        <div style={{ marginTop: 8 }}>
          <Alert type="warning" header={t("insp.gate.headDegraded")}>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12 }}>
              {(row.da_degradations ?? []).map((c) => (
                <li key={c} style={{ marginBottom: 3 }}>
                  <code style={{ fontSize: 11 }}>{c}</code>
                  {" "}{degradationLabel(c, t)}
                </li>
              ))}
            </ul>
          </Alert>
        </div>
      )}

      {showAi && (
      <div style={{ marginTop: 8 }}>
        {loading ? (
          <>
            <Skeleton w="100%" h={13} />
            <Skeleton w="92%" h={13} style={{ marginTop: 7 }} />
            <Skeleton w="78%" h={13} style={{ marginTop: 7 }} />
          </>
        ) : err ? (
          <Alert type="error">{err}</Alert>
        ) : (state === "ok" || state === "partial") && detail?.da_body ? (
          <>
            {/* 🔴 `partial` 时这段正文是**整份报告原文**（`callback_apply.py`
                的 `res.raw`），而一个 task 最多装 6 条 finding —— 里面可能是
                同一批**别的资源**的分析。

                上一版只判 `detail?.da_body` 非空就直接渲染，于是客户在
                db-A 的抽屉里读到 db-B 的分析，还配着「AI 判读」标题和一个
                时间徽章，看起来完全成功。`report_parse.py` 的注释写着
                「宁可让它退化成 PARSE_FAILED（原文仍保留，人一眼能看出来）」
                —— 前提是 UI 会标出来，而 UI 没标。 */}
            {state === "partial" && (
              <div style={{ marginBottom: 8 }}>
                <Alert type="warning"
                  header={row.da_parse_status
                    ? parseStatusLabel(row.da_parse_status, t)
                    : t("insp.degraded.partialNoVerdict")}>
                  {t("insp.judge.rawWarning")}
                </Alert>
              </div>
            )}
            {/* 判读结论 —— 抽屉里也要有。
                🔴 上一版 `hasJudgment` 读了 `row.da_verdict` 却从不渲染它：
                   列表卡片有译名，点开详情反而少了这一行，客户要自己从
                   1~3KB 正文里找 `**verdict**: warm_up` 这种机器串。 */}
            {state === "ok" && row.da_verdict && (
              <div style={{ marginBottom: 8, fontSize: 12.5 }}>
                <span style={{ color: C.muted }}>{t("insp.field.verdict")} </span>
                <b title={row.da_verdict}>{verdictLabel(row.da_verdict, t)}</b>
              </div>
            )}
            {/* 判读全文**按 markdown 渲染**。
                🔴 上一版按 `pre-wrap` 当纯文本，客户直接读到源码（星号、
                反引号、列表符号字面显示）—— 而这段文字是花 DA 额度换来的
                唯一产物。
                ⚠️ 复用 `Message.tsx` 已在用的 `react-markdown` + `remark-gfm`
                （GFM 是为了表格），不引新依赖、不自己写解析。
                ⚠️ 链接一律新标签打开：抽屉在 SPA 里，同标签跳走会丢掉整个会话。
                ⚠️ 没有 `rehype-raw` —— 原始 HTML 不解析，这是 XSS 的防线。 */}
            <div className="insp-md" style={{
              fontSize: 12.5, lineHeight: 1.75,
              color: C.text, background: "var(--code-bg)",
              border: `1px solid ${C.line}`, borderRadius: 8,
              padding: "11px 13px", maxHeight: "46vh", overflowY: "auto",
            }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ ...props }) => (
                    <a target="_blank" rel="noopener noreferrer" {...props} />),
                }}>{detail.da_body}</ReactMarkdown>
            </div>
          </>
        ) : state === "pending" ? (
          /* 🔴 派发了、还没回来 —— **正常等待态，一行说完**。
             这是「深入分析」点完后 1~3 分钟里的常规状态，不是故障：
             用 in-progress（蓝）不用 warning（琥珀），不给排障指引。
             「派发缺口」那套指引是给**永久回不来**的情况准备的，
             对一个刚派发 10 秒的判读说「如果一直没有就去查缺口」是吓唬人。

             ⚠️ task id 只在**后端真的回来之后**显示（乐观状态下没有它）——
                编一个出来会让「我们以为派了」和「真的派了」无法区分。
             ⚠️ 全屏只此一处 task id。 */
          <Status type="in-progress">
            {t("insp.judge.dispatched")}
            {row.da_task_id && (
              <span style={{ marginLeft: 6, fontSize: 11, color: C.muted }}>
                <code>{row.da_task_id}</code>
              </span>
            )}
          </Status>
        ) : state === "failed" ? (
          /* 🔴 判读**回来了但是空的** —— 与 pending 分开，因为它**不会再变**。
             `callback_apply.py` 对 `ParseStatus.EMPTY` 与 `res.missing` 只写
             `parse_status` 不写 body，所以「有 task_id、无 body」这个组合
             是终态。上一版判成 pending，蓝色「1~3 分钟后回来」永远不退出，
             客户一直刷新等一个已经确定失败的东西。 */
          <Alert type="warning" header={t("insp.judge.failed")}>
            {row.da_parse_status
              ? parseStatusLabel(row.da_parse_status, t) : ""}
          </Alert>
        ) : state === "rule" ? (
          /* 确定性结论（规则算出来的，不是 AI）。
             ⚠️ 抽屉此前**完全不读** `conclusion` / `skip_reason`，于是
                reused / playbook 覆盖的高负载 finding 在这里显示
                「还没有判读结果…一直没有的话看派发缺口」—— 把正常状态
                说成疑似故障。 */
          <div style={{ fontSize: 12.5, color: C.text }}>
            <span style={{ color: C.muted }}>{t("insp.field.ruleVerdict")} </span>
            {row.conclusion}
          </div>
        ) : state === "missing" ? (
          /* 🔴 **本该判读却没判** —— budget / quota / kill_switch。
             `gating.Decision.has_conclusion` 的 docstring 明写这几种
             「必须显式告诉客户『因额度未分析』而不是留白」。
             上一版与「还没有判读结果」共用一句话，客户分不出
             「加钱能解决」「链路坏了」「1 分钟后就有」。 */
          <Alert type="warning" header={t("insp.degraded.title")}>
            {row.skip_reason
              ? (zh ? `跳过原因：${row.skip_reason}` : `Skip reason: ${row.skip_reason}`)
              : (zh
                ? "看「高负载」页底部「系统状态」里的派发缺口。"
                : "Check the dispatch gap under System status.")}
          </Alert>
        ) : (
          /* `not_needed` 落到这里 —— 结构上不需要判读。
             ⚠️ `showAi` 已经把「闲置类且没派过」整节挡在外面，所以这一支
                只在极少数情形下可达（比如高负载类命中 NEEDS_NO_AI 而
                conclusion 为空的存量行）。给一句中性说明而不是排障指引。 */
          <Status type="info">
            {zh ? "本轮按确定性规则判定，不需要 AI 判读。"
                : "Judged by deterministic rules; no AI analysis needed."}
          </Status>
        )}
      </div>
      )}

      {/* 🔴 趋势曲线不在本期范围（`/inspection/series` 未接线）。
          这里**不放一个空图表占位** —— 空图表看起来像「这台没有数据」，
          而真相是我们还没做这个功能。 */}
      <div style={{ marginTop: 14, fontSize: 11, color: C.muted }}>
        <Status type="info">
          {zh ? "指标曲线在后续版本提供" : "Metric charts land in a later version"}
        </Status>
      </div>
    </Drawer>
  );
}
