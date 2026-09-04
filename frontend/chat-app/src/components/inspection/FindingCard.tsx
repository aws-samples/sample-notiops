/**
 * 待处置列表里的一张 finding 卡片。
 *
 * ## 卡片要回答的问题
 *
 * ```
 * 谁          实例 · 服务 · 区域
 * 多严重      severity 徽章（色块 + 文字，不只靠颜色）
 * 凭什么      实测值 vs 阈值 —— 这一行此前**完全没有**，
 *             因为那几个数字压根没落库（见后端 assemble.to_evidence）
 * 多少钱      每月可省 + 精度档（只在闲置类出现）
 * 多久了      已持续 N 天 · 首次见到
 * 然后呢      详情 / 移出巡检范围 / 深入分析
 * ```
 *
 * ## 三条 UX 规矩
 *
 * ```
 * ① 整卡可点开详情，但按钮区要 stopPropagation ——
 *    否则点「移出范围」会顺带把抽屉也打开
 * ② 没权限的按钮**不渲染**，不是灰着 —— 灰着等于在界面上摆一个
 *    用户无法解决的问题（api/inspection.ts:378 的既有约定）
 * ③ 缺失的数字**不渲染那一行**，不显示 0 ——
 *    「没有这个数」与「这个数是 0」是两件事
 * ```
 */

import { useEffect, useRef } from "react";

import type { FindingRow } from "../../api/inspection";
import {
  capacityText, degradeTitle, evidenceText, fmtMoney, idleBadgeKind,
  idleTierColor, idleTierText, idleTopFactors, isCoarse,
  judgementState, parseStatusLabel, PRECISION_LABEL,
  staleEvidenceText, verdictLabel,
} from "./format";
import {
  Badge, SevBadge,
} from "./ui";
import { C, SEV_COLOR } from "./tokens";

/*
 * ⚠️ `NEEDS_NO_AI` / `DETERMINISTIC_KINDS` / 七档状态判据都搬到
 *    `format.ts::judgementState` 了 —— 卡片与抽屉必须用**同一份**判据。
 *    各自判的表现是同一条 finding 在列表与详情里两种说法。
 */



export default function FindingCard({
  f, zh, t, highlighted = false, showAccount = false, onOpen, judged,
}: {
  f: FindingRow;
  zh: boolean;
  t: (k: string) => string;
  highlighted?: boolean;
  /**
   * 显示账号徽章。
   *
   * 🔴 统一视图（跨账号一起列）时**必须显示** —— 否则同名实例在两个账号里
   * 长得一模一样，客户会去错的账号处置。而单账号部署下每张卡挂一个恒定的
   * 账号号是纯噪音，所以由调用方按「视图里有几个账号」决定。
   */
  showAccount?: boolean;
  /**
   * 点卡片任意位置 → 打开详情抽屉。
   *
   * ⚠️ 这是卡片**唯一**的动作。「移出巡检范围」/「深入分析」都在抽屉 footer
   *    里 —— 见文件末尾那段说明。
   */
  onOpen: () => void;
  /**
   * 这一条**派过判读了没有**。由列表那一层算（`isJudged`），含「刚派成功但
   * 列表还没刷新到」的乐观状态 —— 所以它比 `f.da_task_id` 更早为真。
   *
   * ⚠️ 徽章的判据用它而不是 `f.da_task_id`：后者要等 `reload()` 回来，
   * 那几百毫秒里客户点完看不到任何变化，会以为没反应。
   */
  judged?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ev = evidenceText(f, zh);
  const cap = capacityText(f);
  // 金额只在闲置类出现 —— 高负载 finding 挂金额会让人以为「关掉它能省钱」。
  const showMoney = f.kind === "idle" && f.savings_usd !== null;
  // 卡片上那句「主因」：贡献分最高的两维（完整四维表在详情抽屉里）。
  const top = idleTopFactors(f.idle_factors, zh);
  // 判读状态（七档）。**唯一判据** —— 见 `format.ts::judgementState`。
  // ⚠️ 传 `judged` 而不是让它自己读 `f.da_task_id`：前者含「刚派成功但列表
  //    还没刷新到」的乐观状态，后者要等 reload() 回来。
  const state = judgementState(f, { dispatched: judged });
  // 首格显示哪一档（评分 / 未判定 / 严重度）。**与抽屉标题共用同一判据** ——
  // 各自判的表现是同一条 finding 在列表上是「99/100」、点开变成「提示」。
  const idleBadge = idleBadgeKind(f);
  // 证据是不是上一轮留下的（chronic / resolving 会保留最后一次已知水位）。
  const stale = staleEvidenceText(f, zh);

  // 深链落地时滚到可见（R11b.7：一跳到具体 finding）。
  // ⚠️ `block: "center"` 而不是默认的 `"start"`：start 会把卡片顶到视口最上边，
  //    紧贴筛选栏，看起来像列表就是从这条开始的。
  // ⚠️ jsdom 里没有 `scrollIntoView`，所以要判在不在。
  useEffect(() => {
    if (!highlighted || !ref.current) return;
    ref.current.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [highlighted]);

  return (
    <div ref={ref} data-finding-id={f.finding_id}
      data-highlighted={highlighted ? "1" : undefined}
      className="insp-clickable"
      /*
       * 整卡是**一个按钮**：`role="button"` + `tabIndex` + Enter/Space。
       *
       * 🔴 这一版才敢这么写。上一版刻意**不给**这两个属性，理由是
       * 「ARIA 不允许 button 有交互后代，而这张卡里有三个真按钮」：
       *
       * ```
       * Tab 到「移出巡检范围」→ 按 Enter
       *   → keydown 冒泡到卡片的 onKeyDown → 打开详情抽屉
       *   → 按钮自己的 click 又打开排除弹层
       *   → 两个浮层同时开，两套 Esc 监听都在
       * ```
       *
       * 那个理由的**前提是卡里有按钮**。2026-09-01 把三个按钮全删了
       * （动作只留在抽屉 footer），前提消失，嵌套冲突也就没有了。
       *
       * 🔴 而删掉按钮之后**必须**补这一段：上一版的键盘入口是那个
       * 「详情」按钮，它一走，纯键盘与屏幕阅读器用户就**完全打不开抽屉** ——
       * 那不是退化，是把功能删了。
       *
       * ⚠️ Space 必须 `preventDefault`：默认行为是滚动页面，
       * 不拦会「抽屉打开的同时列表往下跳一屏」。
       */
      role="button"
      tabIndex={0}
      aria-label={zh
        ? `${f.instance} 的巡检详情` : `Inspection details for ${f.instance}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onOpen();
      }}
      style={{
        background: C.card, borderRadius: 10, padding: "12px 14px",
        // 左侧 severity 色条：扫一列卡片时它是最快的分档线索。
        border: `1px solid ${highlighted ? C.blue : C.line}`,
        borderLeft: `3px solid ${SEV_COLOR[f.severity]}`,
        cursor: "pointer",
        // 高亮用外描边而不是换背景 —— 背景色会与 severity 的语义配色打架。
        outline: highlighted ? `2px solid ${C.blue}` : undefined,
        outlineOffset: 2,
      }}>
      {/* ── 第一行：严重度 · 实例 · 服务/区域 · 状态 ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {/* 🔴 闲置类首格放**评分**，不放严重度。
            闲置的 severity 设计上恒为 INFO（判定是六维加权评分 + 双否决，
            没有「越线」这个概念），于是每张卡的首格都是一个「提示」——
            一整页 20 张卡 20 个同样的灰徽标，零信息量，还占了最显眼的位置。
            客户原话：「没有按照评分因子来排序，只有一个『中』『提示』，
            这不是客户想要的」。
            🔴 **判据不足（`idle_score === null`）走单独一档**，不退回严重度。
            退回去的表现是灰色的「提示」徽标 —— 与「闲置分很低」长得一模一样，
            而后端为此专门把 0 改成了 `None`（`dto.py` 的注释：「0 在排序里
            等于『完全不闲』——『什么都不知道』被呈现成了『非常确定不闲』」）。
            两者的处置动作完全不同：一个不用管，一个要去查为什么没有指标。

            ⚠️ 非闲置类（高负载 / 配置检查）才退回严重度徽标 —— 它们压根没有
               闲置分这个概念，`null` 是正常形态。判据走共享的
               `idleBadgeKind()`，抽屉标题用同一个。 */}
        {idleBadge === "undecided" ? (
          <span title={t("insp.idle.undecidedWhy")}
            style={{
              fontSize: 12.5, fontWeight: 700, padding: "2px 9px",
              borderRadius: 100, whiteSpace: "nowrap",
              color: "var(--amber)", border: "1px solid var(--amber)",
            }}>
            {t("insp.idle.undecided")}
          </span>
        ) : idleBadge === "score" && f.idle_score !== null ? (
          /* 🔴 **档位不能只由颜色表达。** 红 ≥80 / 橙 ≥60 / 灰 —— 色盲用户与
             读屏用户拿到的只是一个数字，而「87 意味着要优先处理」这件事
             在界面上没有任何非颜色的载体。档名进 `aria-label` 与 `title`。
             ⚠️ 颜色也走 `idleTierColor`（与档名**同源**）—— 原来这里自己写了
                两遍 `>= 80` / `>= 60`，与抽屉那份是两套阈值，
                漂开的表现是「红色的但写着『中』」。 */
          <span
            title={`${zh ? "闲置分" : "Idle score"} ${f.idle_score.toFixed(0)}/100`
              + `（${idleTierText(f.idle_score, zh)}）`}
            aria-label={`${zh ? "闲置分" : "Idle score"} ${f.idle_score.toFixed(0)}`
              + `/100，${idleTierText(f.idle_score, zh)}`}
            style={{
              fontSize: 12.5, fontWeight: 700, padding: "2px 9px",
              borderRadius: 100, whiteSpace: "nowrap",
              color: idleTierColor(f.idle_score),
              border: `1px solid ${idleTierColor(f.idle_score)}`,
            }}>
            {f.idle_score.toFixed(0)}
            <span style={{ fontSize: 10, fontWeight: 400, opacity: .75 }}>/100</span>
          </span>
        ) : (
          <SevBadge sev={f.severity} label={t(`insp.sev.${f.severity}`)} />
        )}
        <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
          {f.instance}
        </span>
        {/* 🔴 规格与 service·region 同一行。闲置条目「值不值得动」几乎全看它 ——
            `db.t4g.micro` 与 `db.r8g.4xlarge` 闲置的处置价值差两个数量级，
            而在这个字段落库之前两者在卡片上长得一模一样。
            ⚠️ 用 code 字体：客户要拿它去控制台里对，等宽字体好认。
            ⚠️ 空串不渲染 —— 老 finding 行没这个字段，摆一个空格子更糟。 */}
        {f.instance_class && (
          <code style={{
            fontSize: 11.5, color: C.text, background: "var(--bg2, rgba(0,0,0,.05))",
            padding: "1px 6px", borderRadius: 4,
          }}>{f.instance_class}</code>
        )}
        {/* 🔴 账号徽章。统一视图里同名实例可能在两个账号各一台 ——
            不标出来客户会去错的账号处置。
            ⚠️ 单账号部署时 `showAccount` 为假：那时每张卡一个恒定的账号号
               是纯噪音，还挤掉了规格与 region 的位置。 */}
        {showAccount && f.account_id && (
          <span title={zh ? "所属账号" : "Account"}
            style={{
              fontSize: 11, fontWeight: 600, padding: "1px 7px",
              borderRadius: 100, color: "var(--blue)",
              border: "1px solid var(--blue)", whiteSpace: "nowrap",
            }}>{f.account_id}</span>
        )}
        <span style={{ color: C.muted, fontSize: 12 }}>
          {f.service} · {f.region}
        </span>
        <div style={{ flex: 1 }} />
        {f.was_confirmed && (
          <Badge tone="neutral"
            title={zh ? "连续多轮命中，已过确认门槛（R6.3）" : "confirmed across runs"}>
            {zh ? "已确认" : "confirmed"}
          </Badge>
        )}
        {f.state && <Badge>{t(`insp.state.${f.state}`)}</Badge>}
        {/* 「可点」的可见提示。删掉「详情」按钮之后，整卡可点这件事没有任何
            视觉线索 —— hover 变色对触屏无效，而列表里没有别的箭头。
            ⚠️ `aria-hidden`：卡片自己已经有 `aria-label`，这个字符念出来是噪音。 */}
        <span aria-hidden="true" style={{
          color: C.muted, fontSize: 15, lineHeight: 1, marginLeft: 2,
        }}>›</span>
        {/* 🔴 **「已派 AI 判读」徽章**（2026-08-31 客户实测提的）。
            客户原话：「这里也没有标注出来哪一条 finding 触发了深度分析。
            我认为 findings 这一行至少有一个醒目的标识，证明他已经被触发了
            DA 调查呀」——完全对：派发之后列表回到 16 条一模一样的卡片，
            唯一的痕迹是顶部那条几秒后就被关掉的绿色提示条。
            于是客户不知道自己派过哪一条，会重复点（而后端会拒，
            看起来像失败）。

            ⚠️ 两态要分开：
              判读**还没回来**  琥珀 ⏳「判读中」  ← da_task_id 有、da_body 无
              判读**已经回来**  正文里那段结论    ← 不需要徽章，内容自己会说话
            合成一个的表现是「在跑」与「跑完了」长得一样。 */}
        {/* 🔴 判据是 `state === "pending"`。**老判据不许回来**：

               (judged ?? Boolean(f.da_task_id)) && !f.has_judgment

            它在「回来了但是空的」（EMPTY / missing_section：有 task_id、
            有 parse_status、无 body）上**恒真** → ⏳ 永久挂着，
            而同一张卡底部又写着「判读已返回但没有内容」，两处语义相反。
            有源码级否定断言钉住（`inspection.test.ts`）。 */}
        {state === "pending" && (
          <Badge tone="amber" title={t("insp.judge.dispatched")}>
            {t("insp.judge.badge")}
          </Badge>
        )}
        {/* ── 7.9a skill 门禁的结论（D22）——「这条判读的方法论生效了吗」──

            🔴 与上面那七档判读状态是**正交**的两个维度，所以是独立徽标、
               没有塞进 `judgementState()`：
                 判读状态  判读回来了没有 / 解析干净没有
                 门禁结论  回来的这份是不是按我们的方法论判出来的
               一条 `state === "ok"`（解析干净、有结论）的判读完全可以是
               `skill_not_loaded` —— 那时结论等于通用 LLM 发挥，而卡片上
               看起来一切正常。合进同一个枚举会让现有 7 态各乘 3。

            🔴 **三态，`null` 什么都不渲染。** 判据必须是 `=== false` /
               `=== true` 而不是 truthy 判断：存量行（本次改动之前跑出来的）
               这个字段是 `null`，写成 `!f.da_gate_trustworthy &&` 会让
               **每一条存量 finding** 都挂上红色「判读不可信」——
               噪音不是信号，而且正好与后端
               `ApplyOutcome.journal_trustworthy` 默认 `True` 的用意相反。 */}
        {f.da_gate_trustworthy === false && (
          <Badge tone="red" title={degradeTitle(f, zh, t)}>
            {t("insp.gate.badgeUntrusted")}
          </Badge>
        )}
        {/* 可信但有降级 —— 方法论生效了，只是有精度损失或部分证据缺失
            （compaction / analysis_gap / extra_skill / parse_failed）。
            ⚠️ 与上面互斥：不可信时已经列出全部降级档，再挂一个琥珀的
               「有降级」是重复信息。 */}
        {f.da_gate_trustworthy === true
          && (f.da_degradations?.length ?? 0) > 0 && (
          <Badge tone="amber" title={degradeTitle(f, zh, t)}>
            {t("insp.gate.badgeCaveats")
              .replace("{n}", String(f.da_degradations?.length ?? 0))}
          </Badge>
        )}
      </div>

      {/* ── 第二行：判定证据。缺就整行不渲染，不显示 0 ── */}
      {ev ? (
        <div style={{
          marginTop: 7, fontSize: 13, color: C.text,
          display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap",
        }}>
          <span style={{ color: C.muted }}>{f.metric || t("insp.field.metric")}</span>
          <b style={{ fontSize: 15, color: SEV_COLOR[f.severity] }}>{ev.value}</b>
          {/* 🔴 `relation` 为空 = 后端没给 `direction`。那时**只说阈值是多少**，
              不猜「高于」还是「低于」—— 猜错的表现是 FreeableMemory
              被写成「1.1% 高于阈值 20%」，方向正好反，而句子完全通顺。
              ⚠️ 不整行不渲染：数值本身仍是有效证据。 */}
          <span style={{ color: C.muted, fontSize: 12 }}>
            {ev.relation
              ? `${ev.relation} ${ev.threshold}`
              : (zh ? `阈值 ${ev.threshold}` : `threshold ${ev.threshold}`)}
          </span>
          {/* 按规格百分比判定时补一句原始值 —— 「2.4%」没法对 CloudWatch 图表，
              「200 MB」又说不出算不算问题。两个一起给。 */}
          {cap && (
            <span style={{ color: C.muted, fontSize: 12 }}>（{cap}）</span>
          )}
          {/* 🔴 证据不是本轮的时候**必须**说出来。
              chronic 的语义是「问题还在但本轮未命中」，它挂的数字是上一次
              命中时的 —— 不标注就等于宣称那是今天的水位，而客户会照着它
              判断「现在有多严重」。
              ⚠️ 等于本轮时 `staleEvidenceText` 返回 null，这里整块不渲染。 */}
          {stale && (
            <Badge tone="amber" title={zh
              ? "这条本轮未命中但水位没回到健康区，显示的是最后一次命中时的数值"
              : "not hit this run but water level has not recovered; showing last known values"}>
              {stale}
            </Badge>
          )}
        </div>
      ) : f.metric ? (
        <div style={{ marginTop: 7, fontSize: 13, color: C.muted }}>
          {f.metric}
        </div>
      ) : null}

      {/* ── 第三行：持续时间 + 金额 ── */}
      <div style={{
        marginTop: 6, display: "flex", gap: 14, flexWrap: "wrap",
        fontSize: 12, color: C.muted,
      }}>
        {f.days_active !== null && (
          /* ⚠️ 首次发现的日期挪进抽屉了：「已持续 2 天」与「（2026-08-31）」
              是同一件事的两种说法，扫读时只需要前者。 */
          <span title={f.first_seen_date
            ? `${t("insp.field.firstSeen")} ${f.first_seen_date}` : undefined}>
            {t("insp.field.daysActive")}{" "}
            <b style={{ color: C.text }}>{f.days_active}{t("insp.field.days")}</b>
          </span>
        )}
        {showMoney && (
          <span>
            {t("insp.field.savings")}{" "}
            <b style={{ color: C.green }}>{fmtMoney(f.savings_usd)}</b>
            {/* 🔴 精度档必须与金额**一起**显示。只给数字不给档位，
                客户会拿 coarse_default 的兜底常数去做预算。 */}
            {f.savings_precision && isCoarse(f.savings_precision) && (
              <span style={{ marginLeft: 5 }}>
                {/* ⚠️ `ⓘ` 的细节（哪一档粗估）此前**只在 `title` 里** ——
                    键盘与触屏用户看不到，读屏也不一定念。`Badge` 现在把
                    `title` 同时映到 `aria-label`，所以这里给一句完整的话。 */}
                <Badge tone="amber"
                  title={PRECISION_LABEL[f.savings_precision]?.[zh ? "zh" : "en"]
                    || f.savings_precision}>
                  {zh ? "粗估 ⓘ" : "coarse ⓘ"}
                </Badge>
              </span>
            )}
          </span>
        )}
      </div>

      {/*
        ── 闲置评分因子 ──

        🔴 **闲置条目「凭什么」的全部依据。** 高负载有一行「实测值 vs 阈值」
        就说清了；闲置没有单一阈值 —— 它是四维（RDS：CPU/连接数/存储/IOPS）
        或三维（ElastiCache：CPU/内存/请求数）加权出来的分。

        不显示它的表现（客户 2026-08-24 原话）：「优化的，没有看到评分因子，
        没有看到哪里写着到底是什么地方低于阈值导致的？」—— 卡片上只剩一个
        INFO 徽标和一个金额，凭什么说它闲完全看不见。

        ⚠️ 卡片上只给**总分 + 贡献最大的两维**，完整四维表在详情抽屉里。
        四维全铺在卡片上会让一屏只装得下两条。
      */}
      {f.kind === "idle" && f.idle_score !== null && (
        <div style={{
          marginTop: 7, display: "flex", gap: 8, alignItems: "baseline",
          flexWrap: "wrap", fontSize: 12.5,
        }}>
          {/* 🔴 **这里不再重复总分** —— 首格徽章已经是分数了（2026-08-26 起
              闲置类首格放评分而非恒为 INFO 的严重度）。同一张卡上两个「87」
              会让人以为是两个不同的指标。
              这一行只留「凭什么」：贡献最大的两维 + 降级警告。 */}
          {top ? (
            <span style={{ color: C.muted }}>
              {zh ? "主因 " : "mainly "}{top}
            </span>
          ) : (
            /* 拿不到因子明细（老 finding 行）时仍要说清这个分是闲置分，
               否则首格那个数字没有标签，看不出量纲。 */
            <span style={{ color: C.muted }}>
              {zh ? "闲置分 / 100" : "idle score / 100"}
            </span>
          )}
          {/* 🔴 降级维度必须说出来。四维里丢了两维还给一个 87 分，
              客户会以为这个分和别的 87 分一样可信 —— 而它的判据只有一半。 */}
          {(f.idle_degraded?.length ?? 0) > 0 && (
            <Badge tone="amber"
              title={zh
                ? `这些维度缺数据、权重已重分给其余维度：${(f.idle_degraded ?? []).join("、")}`
                : `dimensions unavailable, weights redistributed: ${(f.idle_degraded ?? []).join(", ")}`}>
              {zh ? `少 ${(f.idle_degraded?.length ?? 0)} 维 ⓘ`
                : `${(f.idle_degraded?.length ?? 0)} dims missing ⓘ`}
            </Badge>
          )}
        </div>
      )}

      {/* ── 第四行：判读状态。**七档，走同一个派生函数** ──

          🔴 判据是 `judgementState`（`format.ts`），**卡片与抽屉共用一份**。
             各自判的表现是同一条 finding 在列表与详情里两种说法 ——
             2026-09-02 review 抓到的四条缺陷全是那个形态：
             状态其实是四元组 `(dispatched, 有正文, parse_status,
             skip_reason/conclusion)`，而两处各自只看其中一两个维度。

          R12.4：「DA 说没问题」与「判读没回来」不能长得一样。 */}
      {state === "ok" ? (
        <div style={{ marginTop: 7, fontSize: 12.5, color: C.text }}>
          <span style={{ color: C.muted }}>{t("insp.field.verdict")} </span>
          {/* 🔴 **译名，不是原始枚举。** 客户曾看到「判读结论 warm_up」
              （用户原话「看起来不像是人类可读的词」）。
              ⚠️ 认不出的取值原样显示 —— 陌生枚举至少能拿去搜代码，
                 空白则那一行凭空消失、看起来像后端没给。 */}
          <b title={f.da_verdict}>{verdictLabel(f.da_verdict, t)}</b>
        </div>
      ) : state === "rule" ? (
        /* **确定性结论** —— 不经 AI 算出来的那句话（2026-08-31 实机暴露）。
           闲置轮不派 DA（`gating.DETERMINISTIC_RUN_TYPES`），判定是纯计算的，
           **它有结论**。在这一支存在之前那 16 条全落进「判读缺失」，
           抽屉里还显示红色「读取失败: not_found」—— 客户以为系统坏了。
           ⚠️ 标签用「规则结论」而不是「判读结论」：它不是 AI 出的。 */
        <div style={{ marginTop: 7, fontSize: 12.5, color: C.text }}>
          <span style={{ color: C.muted }}>{t("insp.field.ruleVerdict")} </span>
          {f.conclusion}
        </div>
      ) : state === "pending" ? (
        /**
         * **正常等待态 —— 这一行不渲染**，顶部那个 ⏳ 徽章就是信号。
         *
         * 🔴 上一版这个状态落到下面的琥珀「判读缺失」，于是一张卡上同时挂着
         *    顶部 ⏳「判读中」和底部「判读缺失」，两个徽标语义相反 ——
         *    而「判读缺失」在这一页的既定含义是 budget/quota（该去查的故障态）。
         *
         * ⚠️ 修的时候我先在这里也打了一遍 `insp.judge.badge`，结果一张卡上
         *    「判读中」出现两次（用例里 `queryByText` 因「找到两个」直接抛）。
         *    重复一遍不增加任何信息，删掉。
         *
         * 🔴 **它与上面那个徽章是成对的**：判据同为 `state === "pending"`。
         *    谁把徽章删了，就必须把这一行补回来，否则等待态在卡片上零信号
         *    —— 有一条用例断言 pending 时「判读中」恰好出现 **1 次**
         *    （0 次和 2 次都红）。
         */
        null
      ) : state === "failed" ? (
        /* 🔴 判读**回来了但是空的** —— 与 pending 必须分开。
             `callback_apply.py` 对 EMPTY / missing_section 只写 parse_status
             不写 body，所以这个组合**永久存在**：上一版判成 pending 的话
             蓝色「1~3 分钟后回来」永远不会退出，客户一直刷新。 */
        <div style={{ marginTop: 7, fontSize: 12, color: C.amber }}>
          {t("insp.judge.failed")}
          {f.da_parse_status
            ? `（${parseStatusLabel(f.da_parse_status, t)}）` : ""}
        </div>
      ) : state === "partial" ? (
        /* 有正文但没对上号 / 没解析出结论。正文可能是同批别的 finding 的分析，
           所以这里只提示「去看全文」，不在卡片上展示任何结论。 */
        <div style={{ marginTop: 7, fontSize: 12, color: C.amber }}>
          {t("insp.degraded.partialNoVerdict")}
          {f.da_parse_status
            ? `（${parseStatusLabel(f.da_parse_status, t)}）` : ""}
        </div>
      ) : state === "not_needed" ? (
        /**
         * 「本轮不需要 AI」—— **什么都不渲染**。
         *
         * ⚠️ 这不违反 R12.4：那条规则的前提是同一个位置「可能有、也可能没有」，
         *    两态要能区分。而闲置轮结构上恒定没有，没有第二态。
         * ⚠️ 原来这里渲染一行灰字「规则结论 ⓘ」，2026-08-31 按用户意见删掉：
         *    16 条上各挂一遍是噪音，而客户学会忽略之后真正该看的
         *    「判读缺失」（额度耗尽那种）会被一起忽略。
         */
        null
      ) : (
        /* 到这里才是**真的**缺判读：`budget` / `quota` / `kill_switch`
           —— 本该判但没判，`gating.Decision` 那三支都不带 conclusion。
           R12.4 要求必须标注出来。 */
        <div style={{ marginTop: 7, fontSize: 12, color: C.amber }}>
          {t("insp.degraded.title")}
          {f.skip_reason ? `（${f.skip_reason}）` : ""}
        </div>
      )}

      {/*
        ── 没有操作区 ──

        🔴 **卡片上的三个按钮全部删掉了**（2026-09-01 客户实测）。原来是
        `[详情] [移出巡检范围] [深入分析]`，三个问题：

        ```
        「详情」是空动作      整卡本来就可点开抽屉，它只是同一个目标的重复；
                             更糟的是它**反向教育**用户「卡片不可点，要瞄准
                             这个按钮」。用户原话：「但其实整个side panel
                             都已经clickable，详情button的意义是什么？」
        另两个与抽屉重复      同样的动作在 footer 里也有一份
        每张卡多一整行 chrome  20 张卡 = 20 行按钮，一屏少装 4~5 条 ——
                             而这一页的全部意义是「今天我要处置什么」的扫读密度
        ```

        ⇒ 动作只留在抽屉 footer 一处。点卡片任意位置进抽屉，右侧 `›` 是提示。

        ⚠️ 代价是「连续排除多条噪音」要逐条开抽屉。可接受：那条路本来就该走
           「巡检范围 → 排除资源 → 勾清单」（已支持多选一次提交），
           单条排除是例外而不是常态。

        ⚠️ `onExclude` / `onJudge` / `judging` 三个 prop 也一并删了 ——
           权限判据本来就在列表那一层算（它决定传什么给抽屉），
           留一组没人读的 prop 只会让下一个人以为卡片还能长出按钮。
      */}
    </div>
  );
}
