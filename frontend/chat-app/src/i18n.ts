/**
 * 轻量 i18n —— 中英双语，从第一版内建。
 * 真实工程可换 react-i18next；Phase 0 用零依赖字典 + Context 足够。
 */
import { createContext, useContext } from "react";

export type Locale = "zh" | "en";

type Dict = Record<string, { zh: string; en: string }>;

export const STRINGS: Dict = {
  "app.newChat": { zh: "新对话", en: "New chat" },
  "topic.investigate": { zh: "调查", en: "Investigation" },
  "topic.cost": { zh: "成本", en: "Cost" },
  "topic.cases": { zh: "案例", en: "Cases" },
  "topic.security": { zh: "安全", en: "Security" },
  "topic.whatsnew": { zh: "What's New", en: "What's New" },
  "topic.general": { zh: "通用", en: "General" },
  "whatsnew.card": { zh: "What's New", en: "What's New" },
  "whatsnew.cardSub": { zh: "AWS 最新发布 · 与你的业务结合", en: "Latest AWS launches · tied to your workloads" },
  // （`nav.inspections` —— 外链到老 idle 控制台的入口文案 —— 已随控制台
  //   退役删除，2026-09-04。站内巡检看板用 `insp.*` 命名空间，键名刻意
  //   不同：`inspection.test.ts` 有断言钉着「站内看板不复用旧外链键」。）
  "nav.admin": { zh: "管理", en: "Admin" },

  // ── 资源巡检看板（R10.9）──────────────────────────────
  // 导航与页签
  "insp.title": { zh: "巡检", en: "Inspection" },
  /**
   * 默认落地页。**「待处置」而不是「总览」** —— 客户打开看板要回答的是
   * 「今天我要处置什么」，而总览回答的是「巡检系统本身正常吗」。
   */
  "insp.tab.triage": { zh: "待处置", en: "To act on" },
  /**
   * ⚠️ 导航里已经没有这一项了（内容进了待处置页的「系统状态」折叠区），
   * 但**保留这个 key** —— 系统状态区的标题与 IM 深链 `?tab=overview`
   * 的兼容映射还引用它。删了会让那里显示 `insp.tab.overview` 字面量。
   */
  "insp.tab.overview": { zh: "巡检总览", en: "Overview" },
  "insp.tab.highLoad": { zh: "高负载", en: "High Load" },
  "insp.tab.idle": { zh: "闲置与成本", en: "Idle & Cost" },
  // 「结构性风险」→「配置检查」（2026-08-25）。客户原话：「我也没有要结构性
  // 风险，不知道这个是做什么的」—— 而这一页查的就是**配置**（证书临期 /
  // 引擎 EOL / 备份未开 / 单 AZ / gp2），不看任何指标。
  // 「结构性」是我们内部的分类词，客户词汇表里没有它。
  "insp.tab.structural": { zh: "配置检查", en: "Config Checks" },
  "insp.tab.scope": { zh: "巡检范围", en: "Scope" },
  "insp.tab.config": { zh: "阈值与定时", en: "Thresholds & Schedule" },
  "insp.group.findings": { zh: "巡检发现", en: "Findings" },
  "insp.group.settings": { zh: "配置", en: "Settings" },

  // KPI 卡
  "insp.kpi.total": { zh: "风险总数", en: "Total findings" },
  "insp.kpi.lastRun": { zh: "最近巡检", en: "Last run" },
  "insp.kpi.completeness": { zh: "采集完整度", en: "Data completeness" },
  "insp.kpi.noAnalysis": { zh: "未做根因分析", en: "Without analysis" },
  "insp.kpi.vsPrev": { zh: "较上一轮", en: "vs previous run" },

  // 严重度（与后端 Severity 四值一一对应）
  "insp.sev.CRITICAL": { zh: "紧急", en: "Critical" },
  "insp.sev.HIGH": { zh: "高", en: "High" },
  "insp.sev.MEDIUM": { zh: "中", en: "Medium" },
  "insp.sev.INFO": { zh: "提示", en: "Info" },

  // finding 状态机四态
  "insp.state.new": { zh: "新增", en: "New" },
  "insp.state.active": { zh: "持续", en: "Active" },
  "insp.state.resolving": { zh: "缓解中", en: "Resolving" },
  "insp.state.resolved": { zh: "已解决", en: "Resolved" },
  // 🔴 后端状态机有**五**个态（`FindingState`），这里原来只登记了四个 ——
  //    `chronic` 的卡片徽章上直接印出 `insp.state.chronic` 这串 key 给客户看。
  //    `t()` 找不到键就返回键名本身，不抛不告警。
  //
  // ⚠️ 这不是 `check_frontend_keys` 能抓的：key 是从后端枚举**动态拼**的
  //    （`t(\`insp.state.${f.state}\`)`），静态扫不到。所以另有一条枚举一致性
  //    断言钉住「五个态都有文案」（见 inspection.test.ts）。
  //
  // ⚠️ chronic 恰恰是最需要解释的那一态：本轮未命中但水位没回健康区，
  //    卡片上同时挂着「数据截至 X 天前」的琥珀标 —— 而客户看到的是一行代码。
  "insp.state.chronic": { zh: "长期高位", en: "Chronic" },
  // 判读回来了（有正文）但没解析出结论。
  // 🔴 原来这种情况卡片上那一行整个消失 —— 既没有「判读结论」也没有「判读缺失」，
  //    而 FindingCard 自己写着「必须二者之一，都不显示会让『DA 说没问题』与
  //    『判读没回来』长得一样（R12.4）」。
  "insp.degraded.partialNoVerdict": {
    zh: "已有判读，但没解析出结论 —— 点「详情」看全文",
    en: "Analysis returned but no verdict was parsed - open details for the full text",
  },
  // 🔴 判读**回来了但是空的** —— 与「还在路上」必须分开。
  //    `callback_apply.py` 对 EMPTY / missing_section 只写 parse_status，
  //    不写 body，于是「da_task_id 有、da_body 空」这个组合会**永久**存在。
  //    上一版的判据是 `dispatched && !hasJudgment` → 恒真 → 永远显示
  //    蓝色「1~3 分钟后回来」，客户一直刷新等一个不会来的东西。
  "insp.judge.failed": {
    zh: "判读已返回但没有内容 —— 不会再变了，需要重新派发",
    en: "The analysis came back empty; it will not change - dispatch again",
  },
  // 🔴 有正文但解析没对上号 —— 那段正文可能是**同批别的 finding** 的分析
  //    （一个 task 最多装 6 条，parse_failed 时挂的是整份报告原文）。
  //    不标注就等于宣称它是本条的结论。
  // ⚠️ 这里**不要**写 markdown 的 `**` —— 它渲染在 `Alert` 的 children 里，
  //    是纯文本，星号会字面显示给客户看。
  "insp.judge.rawWarning": {
    zh: "下面这段是整份报告原文，没能按 finding 切开 —— 它可能包含同一批"
      + "其它资源的分析，不要当成这一条的结论。",
    en: "The text below is the raw report; it could not be split per finding, "
      + "so it may describe other resources from the same batch.",
  },
  // `da_parse_status` 的四档 + 两个降级原因 → 人话。
  // ⚠️ 与 `report_parse.ParseStatus` 对齐；认不出的取值原样显示（见
  //    `format.ts::parseStatusLabel`）。
  // 🔴 闲置分**判据不足**。与「闲置分很低」必须分开 ——
  //    后端为此专门把 0 改成了 `None`（`dto.py::IdleScore.available_weight`：
  //    「0 在排序里等于『完全不闲』——『什么都不知道』被呈现成了『非常确定
  //    不闲』」），而读侧原来把 `None` 退回灰色的「提示」徽标，
  //    与低分卡片长得一模一样，那份努力就白费了。
  //    两者的处置动作完全不同：一个不用管，一个要去查为什么没有指标。
  "insp.idle.undecided": { zh: "未判定", en: "not scored" },
  "insp.idle.undecidedWhy": {
    zh: "监控数据不足，本轮未判定 —— 不是「不闲」，是我们还不知道。"
      + "去查这台资源的 CloudWatch 指标为什么读不到。",
    en: "Not enough monitoring data to score this round; this is not "
      + "a statement that the resource is busy.",
  },
  /* ── 7.9a skill 门禁的 8 档降级（D22）───────────────────────────────────
     真源是后端 `inspection/domain/journal_gate.py::Degradation`。
     ⚠️ 那边加了新档就要在这里补一条 —— `degradationLabel` 认不出时**原样
        返回英文枚举**（不返回空串），所以漏了不会白屏，但客户会看到
        `no_data_access` 这种字。有源码级断言钉住 8 档齐全。
     🔴 文案要写「下一步去查什么」，不是只翻译枚举名。这几档的价值全在
        「客户/运维读完知道该动哪里」——「读不到 journal」远不如
        「无法证明 skill 加载过（可能调查还在跑，也可能是我们权限不足）」。 */
  // 前四档 ⇒ 判定为**不可信**（trustworthy=false）
  "insp.gate.skill_not_loaded": {
    zh: "我们的判读 skill 一份都没加载 —— 结论等于通用 AI 发挥，不是按我们的方法论判的",
    en: "none of our judgement skills were loaded; the conclusion is generic AI output, not our methodology",
  },
  "insp.gate.wrong_skill": {
    zh: "加载的是另一份判读 skill（派发措辞路由写偏了）—— 用错了方法论",
    en: "a different judgement skill was loaded (dispatch wording mis-routed); wrong methodology applied",
  },
  "insp.gate.no_journal": {
    zh: "读不到调查日志，无法证明 skill 加载过 —— 可能调查还在跑，也可能是我们权限不足；「无法证明」不等于「没问题」",
    en: "the investigation journal was unreadable, so skill loading cannot be proven; the run may still be in flight, or our permissions may be insufficient. Unproven is not the same as fine",
  },
  "insp.gate.no_data_access": {
    zh: "AI 拿不到这个账号的数据（Agent Space 少了账号关联）—— 报告格式完好但里面没有真实分析，去管理页把该账号关联进巡检 space",
    en: "the agent could not read this account's data (the agent space is missing the account association); the report looks complete but contains no real analysis. Link the account in the admin page",
  },
  // 后四档：方法论**已生效**，只是有折扣（trustworthy=true）
  "insp.gate.compaction": {
    zh: "上下文被压缩过，这批判读有精度损失（载荷偏长时会发生）",
    en: "the context window was compacted, so this batch lost some precision (happens on long payloads)",
  },
  "insp.gate.analysis_gap": {
    zh: "部分证据拿不到，结论基于不完整的数据（不是什么都拿不到）",
    en: "some evidence was unavailable, so the conclusion rests on incomplete data (not a total blackout)",
  },
  "insp.gate.extra_skill": {
    zh: "同时还命中了别的 skill（可能是这个账号自己装的）—— 结论的依据混了两套方法论",
    en: "another skill was also activated (possibly one installed in this account); the conclusion mixes two methodologies",
  },
  "insp.gate.parse_failed": {
    zh: "AI 的输出解析不出来，原文已保留（去查输出是否被截断）",
    en: "the agent's output could not be parsed; the raw text is kept (check whether the output was truncated)",
  },
  /* 两个徽标的**面上文字**。
     ⚠️ 键名故意用 camelCase：这个前缀下 snake_case 的那些是后端
        `Degradation` 的枚举值（有 `test_前端的降级码译名没有多余项` 逐个对着
        后端核）。camelCase = 纯 UI 文案、后端没有对应档。混用大小写风格在
        这里是**判据的一部分**，不是随手写的。
     ⚠️ `{n}` 靠 `.replace("{n}", …)` 填，占位符名字改了界面上就显示原文
        （`insp.warn.dispatchGap` 同套，那条有断言钉着）。 */
  "insp.gate.badgeUntrusted": {
    zh: "判读不可信 ⓘ", en: "unverified judgement ⓘ",
  },
  "insp.gate.badgeCaveats": {
    zh: "判读有降级 {n} ⓘ", en: "{n} caveat(s) ⓘ",
  },
  /* 开头句 —— 徽标 `title`（悬浮/屏幕阅读器）与详情抽屉的 Alert header
     共用**同一对键**：两处说的是同一件事，各写一份迟早漂移。
     ⚠️ 不带结尾冒号：抽屉 header 单独成行用不上，`degradeTitle` 拼接时自己加。 */
  "insp.gate.headUntrusted": {
    zh: "这份判读没能证明是按我们的判读方法论做出来的，结论仅供参考",
    en: "This judgement could not be shown to follow our methodology",
  },
  "insp.gate.headDegraded": {
    zh: "方法论已生效，但这份判读有以下折扣",
    en: "Methodology applied, with the following caveats",
  },
  /* 「实际加载了什么」—— 排查 wrong_skill / skill_not_loaded 的唯一直接线索。
     空数组说成「一个都没加载」（那正是 skill_not_loaded 的形态），不省略。 */
  "insp.gate.skillsLoaded": {
    zh: "实际加载的 skill：{s}", en: "skills actually loaded: {s}",
  },
  "insp.gate.skillsNone": {
    zh: "实际一个判读 skill 都没加载",
    en: "no judgement skill was loaded at all",
  },
  "insp.parse.ok": { zh: "解析正常", en: "parsed cleanly" },
  "insp.parse.partial": {
    zh: "只对上了一部分 —— 缺的那几条判读是缺失的，不是「没问题」",
    en: "only partially matched; the missing ones are missing, not clean",
  },
  "insp.parse.parse_failed": {
    zh: "一节都没对上号（去查 skill 有没有加载 / 输出被截断）",
    en: "no section matched (check skill loading / truncated output)",
  },
  "insp.parse.empty": {
    zh: "DA 没有返回内容（去查 DA 那侧）",
    en: "the agent returned nothing (check the agent side)",
  },
  "insp.parse.missing_section": {
    zh: "这一条没有出现在判读里（同批其它条目对上了）",
    en: "this finding did not appear in the analysis (others in the batch did)",
  },
  // 🔴 「本轮被跳过」必须与「跑完了」分开说。后端 try_acquire_run_lock 的条件
  //    不放行「今天已有成功的一轮」，而跳过是静默的（消息删除、不进 DLQ）。
  //    原来前端把这种情况显示成绿字「跑完了」—— 客户以为看到的是刚拉的指标。
  "insp.run.skippedToday": {
    zh: "本轮被跳过 —— 今天已经有一轮成功的巡检，指标没有重新采集。"
      + "看板上显示的仍是那一轮的数据。要强制重跑请改用后台触发（或等明天）。",
    en: "This run was skipped - a successful run already happened today, so "
      + "metrics were not re-collected. The dashboard still shows that run's "
      + "data. Use a backend trigger to force a re-run (or wait for tomorrow).",
  },
  // 手动一轮会占掉当天的槽位 —— 这件事必须在按钮旁边说清楚。
  "insp.run.takesTodaySlot": {
    // ⚠️ 纯文本容器（tooltip），不能用 `**`。
    zh: "手动一轮会占用今天的巡检槽位：跑完之后当天的定时轮不再执行"
      + "（调度只看「今天有没有成功的一轮」）。也就是说当天不会有状态机推进、"
      + "不会判「已解决」、不会推送。"
      // 🔴 「会派 AI 判读」这半必须说 —— 它花 DA 额度（按秒计费）。
      //    2026-08-29 之前手动轮**不派** DA（`dry_run` 顺带关掉了它），
      //    所以客户点完永远看不到根因分析，而界面上不说为什么。现在派了，
      //    那就必须把成本讲清楚：点一次就是买一次判读。
      + "会派 AI 判读（按秒计费）。",
    en: "A manual run takes today's inspection slot: the scheduled run for "
      + "today will be skipped (scheduling only checks whether a successful run "
      + "happened today). That means no state-machine progress, no resolved "
      + "detection and no push for the day. "
      + "It does dispatch AI judgement (billed per second).",
  },
  /* ── 批量触发的护栏（2026-09-01 从五行确认屏压成一行）────────────────────
     🔴 这一行是这个功能的**唯一**护栏，四件事一件都不能省：
        ① 会真花钱（GetMetricData 按指标计费 + AI 判读按秒计费）
        ② 占掉今天的巡检槽位（当天的定时轮不再执行）
        ③ 撤不回来（后端没有批量取消）
        ④ 今天已成功跑过的账号会被静默跳过（不重复花钱，也拿不到新数据）

     🔴 为什么从五行压成一行：上一版是「选账号 →『全部账号』→ 第二屏五行
        说明 → 确认」。客户原话：「我点全部账号后又出来一大堆内容，絮絮叨叨
        贫死了。能不能别加这么多文字？不要再出现第二步和描述性的大段文字了。」
        —— 一段没人读的说明等于没有护栏，而它还挡住了下面的账号列表。

     ⚠️ 不用 `**` 加粗：这一行渲染在纯文本容器里（不经过 Message.tsx 那个
        markdown 渲染器），星号会**字面显示**给客户。
     ⚠️ 也**不许再加长**。`weekdaysAndBatchRun.render.test.tsx` 同时钉住
        「四件事都在」和「不超过 80 字、不含换行」—— 两条一起才是这次的要求。 */
  "insp.run.costLine": {
    zh: "会真调 GetMetricData 并派 AI 判读（都计费）、占掉今天的巡检槽位、"
      + "撤不回来；今天已成功跑过的账号会跳过。",
    en: "Really calls GetMetricData and dispatches AI judgement (both billed), "
      + "consumes today's slot, cannot be cancelled; accounts that already "
      + "succeeded today are skipped.",
  },
  /* 🔴 「已提交」不能说成「跑完了」。这条路**不轮询**（一个槽位盯不了 N 个
        账号的 run 行），所以我们只知道 invoke 成功了。提示条那侧也把它映成
        琥珀而不是绿色 —— 见 `RunPhase` 的 `submitted`。 */
  "insp.run.allSubmitted": {
    // ⚠️ 纯文本容器，不能用 `**`（星号会字面显示）。
    zh: "已提交 {n} 个账号。批量触发不做轮询，这里不显示每个账号的结果 —— "
      + "几分钟后点右上角「刷新」；想盯住某一个账号，用弹层里那个账号单独点。",
    en: "Submitted {n} accounts. Per-account results are NOT shown here - "
      + "batch triggers are not polled. Refresh the dashboard in a few "
      + "minutes, or trigger a single account to watch it complete.",
  },
  /* ── 按需判读（「深入分析」，2026-08-31）────────────────────────────────
     🔴 这条路是「批量不派、人点了就派」：闲置轮设计上不派 DA
        （`DETERMINISTIC_RUN_TYPES = {"idle"}`），于是 `inspection-cost-idle`
        那份 skill 的 idle 那一半成了死代码 —— 而它回答的正是客户唯一真正
        关心的问题：这台是真闲，还是**有理由地**闲着。 */
    // 按钮 tooltip。🔴 从 128 字压到一行 —— 没人读 128 字的 tooltip，
  // 而且它与 `insp.judge.what`（弹窗正文）内容 80% 重复：点一下就看到完整说明，
  // tooltip 只需要回答「点下去会不会立刻花钱」。
  "insp.judge.hint": {
    zh: "派一次 AI 判读（会先确认）",
    en: "Dispatch an AI review (asks first)",
  },
  "insp.judge.ok": {
    // 成功提示条。1~3 分钟 + 刷新的说明已经在卡片徽章与抽屉那块里了，
    // 这里只需要回执（task id 是客户去 DA 后台核对的唯一凭据）。
    zh: "已派发 · task {task}",
    en: "Dispatched · task {task}",
  },
  /* 🔴 已派过时**不给再派一次的机会**（客户明确要的）：重复派发会重复烧 DA
        额度，而两份判读回填到同一行只会互相覆盖。所以这条文案要说清
        「等它」而不是「再试」。 */
  "insp.judge.dispatched": {
    // ⚠️ 不再说「结论会出现在下方『AI 判读』里」：这块只在**判读还没回来**时
    //    渲染，那时下方那一节还是空的，指过去反而让人去找。回来之后本块消失、
    //    正文自然出现在同一位置。
    zh: "判读已派发，1~3 分钟后回来。点右上角「刷新」查看。",
    en: "Review dispatched; back in 1-3 min. Use Refresh (top right) to check.",
  },
  /* 🔴 列表行上的徽章。客户实测原话：「这里也没有标注出来哪一条 finding
        触发了深度分析」—— 派发之后列表回到 N 条一模一样的卡片，唯一的痕迹是
        顶部那条会被关掉的提示条。于是客户不知道派过哪一条，会重复点。 */
  "insp.judge.badge": { zh: "⏳ 判读中", en: "⏳ Reviewing" },
  "insp.judge.go": { zh: "派发判读", en: "Dispatch review" },
  "insp.judge.noteLabel": { zh: "补充背景（可选）", en: "Add context (optional)" },
  /* 弹窗里「会做什么」那一段。
     🔴 「在**这个资源所在的账号**里」这半句必须写出来 —— 客户实测时问过
        「我这个深入分析是在哪个账号内进行的」，而旧实现的答案是「聊天页顶部
        选择器选的那个账号」，与这条 finding 无关。现在是对的，但那个疑问
        本身说明这件事不明说就没人知道。 */
  "insp.judge.what": {
    // 🔴 从 143 字压到两行。原文把三件事（在哪跑 / 判什么 / 代价）揉成一段
    //    散文，而弹窗的任务只是「这件事花钱，确认吗」。
    // ⚠️ 不能用 `**` 加粗 —— 渲染容器是纯文本，星号会字面显示。
    //    「这个资源所在的账号」也不再是抽象指代：`{where}` 由调用方填成
    //    真实的「<账号> · <region>」，客户当初问的就是「在哪个账号内进行」。
    // ⚠️ 「判断是真闲置还是有理由地闲着」后面那四个例子挪进备注框的
    //    placeholder（那里本来就有同一批词，原来是重复的）。
    zh: "在 {where} 里跑，判断它是真闲置还是有理由地闲着。\n"
      + "按秒计费 · 1~3 分钟后回填 · 不能撤回、不能重复派。",
    en: "Runs in {where}. Decides whether the resource is genuinely idle or "
      + "idle for a reason.\n"
      + "Billed per second · lands in 1-3 min · cannot be cancelled or repeated.",
  },
  "insp.judge.notePlaceholder": {
    zh: "例：这台是灾备备库，平时确实没流量／只在月末跑批／缓存刻意保持预热",
    en: "e.g. this is the DR standby, batch only runs at month end, cache is "
      + "deliberately kept warm",
  },
  /* 🔴 「不是指令」这句必须在。不说的话客户会写「这台没问题别报了」——
        而严重度是判定层的事。skill 那侧的第 6 条硬边界就是为此加的
        （它会把这句话当成**待核实的主张**而不是指令），
        但界面上也要先说清，否则客户以为写了就能关掉这条。 */
  "insp.judge.noteHint": {
    // 🔴 从 130 字压到两行（原来这段提示比输入框本身还高）。
    // ⚠️ 「是背景不是指令」这一句**不能删** —— 不说的话客户会写「这台没问题
    //    别报了」，然后照样被报，他会认为「填了没用」。但一句话够了，
    //    不需要解释 skill 那侧怎么处理它。
    // ⚠️ 不能用 `**`（纯文本容器，星号字面显示）。
    zh: "写一句「为什么它看起来闲」—— 规则看得出低利用率，看不出原因。\n"
      + "这是背景不是指令：不会改严重度，也不会让这条消失。",
    en: "Say WHY it looks idle - the rules see low utilisation, not the reason.\n"
      + "This is context, not an instruction: it changes neither the severity "
      + "nor whether the finding shows.",
  },
  "insp.scope.neverExpiresNoRenew": {
    zh: "这条排除永不过期，不需要续期 —— 点续期反而会给它加上 30 天后的到期日",
    en: "This exclusion never expires; renewing would actually give it a "
      + "30-day expiry",
  },

  // finding 字段
  "insp.field.instance": { zh: "资源", en: "Resource" },
  "insp.field.metric": { zh: "指标", en: "Metric" },
  "insp.field.severity": { zh: "严重度", en: "Severity" },
  "insp.field.daysActive": { zh: "已持续", en: "Active for" },
  "insp.field.days": { zh: "天", en: "d" },
  "insp.field.verdict": { zh: "判读结论", en: "Verdict" },
  "insp.field.savings": { zh: "预计月节省", en: "Est. monthly saving" },
  "insp.field.firstSeen": { zh: "首次发现", en: "First seen" },
  "insp.field.region": { zh: "区域", en: "Region" },

  // 判读缺失（对应后端 DegradedReason，标注「判读缺失」是 R12.4 的硬要求）
  // 🔴 确定性结论（2026-08-31 实机暴露）。闲置轮**不派 DA**，判定是纯计算的
  //    （CPU 均值 × 权重 + 内存 + 请求数 → 加权分）—— 它有结论。
  //    此前那个结论不落库，卡片只能显示「判读缺失」、详情里显示红色的
  //    「读取失败: not_found」，而功能完全正常 ⇒「看起来全坏了」。
  // ⚠️ 标签刻意**不叫**「AI 判读」——它不是 AI 出的。叫「规则结论」，
  //    与 DA 那条（`insp.field.verdict`）在视觉上就区分开。
  "insp.field.ruleVerdict": { zh: "规则结论", en: "Rule-based" },

  // ── DA verdict 的四个取值 → 人话（2026-09-01 客户实测）──
  //
  // 🔴 `da_verdict` 是 **skill 输出信封里的机器枚举**
  //    （`inspection/domain/report_parse.py` 的 `VERDICTS`），而卡片原来直接
  //    `<b>{f.da_verdict}</b>` 打出来 —— 客户看到的是「判读结论 warm_up」。
  //    用户原话：「看起来不像是人类可读的词」。
  //
  // ⚠️ 键名必须是 `insp.verdict.<枚举值>`，逐字对上后端那四个值。
  //    `tests/test_inspection_gating.py` 有元断言钉住「四个值都有译名」——
  //    漏一个的表现就是那一档继续显示英文枚举，而它只在那一档命中时出现
  //    （最难被发现的那种）。
  //
  // ⚠️ 措辞是**结论**而不是形容词，因为它出现在「判读结论 …」后面。
  //    `expected_behaviour` 不能译成「预期」——「预期行为」才说清了
  //    「这个闲置/高负载是有原因的，不用动」。
  "insp.verdict.real_degradation": { zh: "确有劣化", en: "Real degradation" },
  "insp.verdict.expected_behaviour": { zh: "预期行为", en: "Expected behaviour" },
  "insp.verdict.warm_up": { zh: "预热期，证据不足", en: "Warm-up, too early" },
  "insp.verdict.insufficient_evidence": { zh: "证据不足", en: "Insufficient evidence" },
  "insp.degraded.title": { zh: "判读缺失", en: "Analysis missing" },

  "insp.error.load": { zh: "加载失败", en: "Failed to load" },
  "insp.error.forbidden": { zh: "没有访问权限", en: "You do not have access" },
  "insp.retry": { zh: "重试", en: "Retry" },

  // 🔴 派发缺口：有 task 发出去了却没落映射 → 那些判读永久回不来。
  //    必须能在看板上看见，否则它只表现为「finding 旁边是空的」。
  "insp.warn.dispatchGap": {
    zh: "有 {n} 条判读任务已派发但未能关联，其分析结果无法回填",
    en: "{n} analysis tasks were dispatched but could not be matched back",
  },
  // R10.6：明示「另有 N 项未做根因分析」——不显示会让客户以为看板就是全部。
  "insp.warn.notAnalysed": {
    zh: "另有 {n} 项未做根因分析",
    en: "{n} more findings have no root-cause analysis",
  },

  // 范围与配置
  "insp.scope.exclusions": { zh: "排除清单", en: "Exclusions" },
  "insp.scope.targets": { zh: "巡检范围", en: "In scope" },
  "insp.scope.expiresOn": { zh: "到期", en: "Expires" },
  "insp.scope.reason": { zh: "原因", en: "Reason" },
  // ⚠️ 两份清单是**独立**的（R1.2）。UI 必须分开呈现 ——
  //    合成一份会让客户以为「别报 CPU」等于「别管闲置」。
  "insp.scope.listHigh": { zh: "高负载轮", en: "High-load run" },
  "insp.scope.listIdle": { zh: "闲置轮", en: "Idle run" },
  "insp.config.cron": { zh: "执行时刻", en: "Schedule" },
  "insp.config.nextRun": { zh: "下一轮", en: "Next run" },
  // R13.5：改了阈值必须明示「下一轮生效」——否则客户会等着看即时变化。
  "insp.config.effectiveNext": {
    zh: "修改在下一轮巡检生效",
    en: "Changes take effect on the next run",
  },
  "insp.config.globalNote": {
    zh: "执行时刻按巡检类型全局设置，不按账号",
    en: "The schedule is global per run type, not per account",
  },

  // ── 判定阈值（R13.4）─────────────────────────────────────────────
  "insp.rules.title": { zh: "判定阈值", en: "Detection thresholds" },
  "insp.rules.secThreshold": { zh: "高负载阈值", en: "High-load thresholds" },
  "insp.rules.secIdle": { zh: "闲置判定", en: "Idle detection" },
  "insp.rules.secCapacity": { zh: "容量与否决", en: "Capacity & vetoes" },
  // ⚠️ 与 `insp.tab.structural` 保持同一个词。两处不一致（一处「配置检查」
  //    一处「结构性风险」）会让客户以为阈值页配的不是那一页的规则。
  "insp.rules.secStructural": { zh: "配置检查", en: "Config checks" },
  "insp.rules.default": { zh: "默认", en: "default" },
  "insp.rules.range": { zh: "范围", en: "range" },
  "insp.rules.customized": { zh: "已自定义", en: "customized" },
  "insp.rules.reset": { zh: "恢复默认", en: "Reset to default" },
  "insp.rules.resetAll": { zh: "全部恢复默认", en: "Reset all" },
  // 🔴 必须说出来。改阈值不只是「以后按新标准判」——按 R6.9，配置变更会把
  //    现有 finding 全部 resolve 再按新阈值重建，看板上的数字会变。
  //    不说的话客户会以为看板出错了。
  "insp.rules.recountNote": {
    zh: "改动会在下一轮生效，并按新阈值重新计数现有风险项",
    en: "Changes apply on the next run and re-count existing findings",
  },
  "insp.rules.orNote": {
    zh: "任一指标越界即判高负载 —— 调高某一项只会让那一项少报",
    en: "Any single metric over its threshold flags high load",
  },
  "insp.rules.andNote": {
    zh: "须同时满足才算闲置候选 —— 调大任一项都会让更多资源被判闲置",
    en: "All must hold to flag idle — raising any one flags more resources",
  },
  "insp.rules.tagsHint": {
    zh: "逗号分隔的 tag 值",
    en: "Comma-separated tag values",
  },
  "insp.rules.outOfRange": { zh: "超出允许范围", en: "Out of allowed range" },
  "insp.rules.noChange": { zh: "没有改动", en: "No changes" },
  "insp.rules.readOnly": {
    zh: "你没有改阈值的权限（需要 action:inspection:threshold）",
    en: "You cannot edit thresholds (needs action:inspection:threshold)",
  },

  // ── 服务筛选器 ───────────────────────────────────────────────────
  "insp.rules.filterBy": { zh: "按服务查看", en: "View by service" },
  "insp.rules.allServices": { zh: "全部", en: "All" },
  // 🔴 必须说清「筛选器不是作用域」。阈值是全局一份 —— 不说的话客户会以为
  //    「我只调了 Redis」,而 RDS 也跟着变了,且没有任何运行时信号。
  "insp.rules.scopeNote": {
    zh: "阈值是全局共用的一份；选服务只决定显示哪些项，改动会影响所有用到该指标的服务",
    en: "Thresholds are one shared set. Picking a service only filters what is shown — a change affects every service using that metric",
  },
  // ⚠️ 用 `{n}` / `{total}` 占位符而不是把量词拆成独立 key —— 拆开后英文那侧
  //    的量词会是空串（「项」在英文里不需要），而 i18n lint 要求每个 key 两种
  //    语言都非空。既有惯例见 `admin.models.matchCount`。
  "insp.rules.shownOf": { zh: "显示 {n} / 共 {total} 项", en: "Showing {n} of {total}" },
  "insp.rules.totalOnly": { zh: "共 {total} 项", en: "{total} settings" },
  "insp.rules.hiddenDirty": {
    zh: "另有 {n} 项改动在当前筛选之外，保存时一并生效",
    en: "{n} more pending change(s) outside the current filter will also be saved",
  },
  "insp.rules.appliesAll": { zh: "全部服务", en: "All services" },
  "insp.rules.appliesOnly": { zh: "仅", en: "Only" },
  // 选了某服务后有些 section 会整段空掉 —— 明示比静默消失好
  "insp.rules.noneForService": {
    zh: "该服务没有可调的此类阈值",
    en: "No thresholds of this kind apply to this service",
  },

  // ── 写侧────────────────────────────────────────
  // 通用动作
  "insp.act.save": { zh: "保存", en: "Save" },
  "insp.act.saving": { zh: "保存中…", en: "Saving…" },
  "insp.act.cancel": { zh: "取消", en: "Cancel" },
  "insp.act.saved": { zh: "已保存", en: "Saved" },
  "insp.act.failed": { zh: "操作失败", en: "Request failed" },

  // 排除清单写侧
  "insp.scope.add": { zh: "新增排除", en: "Add exclusion" },
  "insp.scope.renew": { zh: "续期 30 天", en: "Renew 30d" },
  // 🔴 「挪出白名单」（2026-09-01）。在这之前清单上唯一的动作是续期，
  //    于是手滑排除一台生产库之后只能等 30 天过期 —— 而那 30 天里
  //    「没有告警」会被读成「一切正常」，没有任何运行时信号。
  //    客户原话：「也没有任何位置让我取消移除。如果用户误操作，
  //    岂不是要等待 30 天？」
  // ⚠️ 用「挪出白名单」而不是「删除」：客户自己用的就是这个词，
  //    而「删除」会让人担心是不是把历史记录也删了。
  "insp.scope.remove": { zh: "挪出白名单", en: "Remove" },
  // R1.4：到期条目**保留记录但不生效**。列表里仍在，所以必须打标 ——
  // 不打标会让「排除还生效着」与「早就过期了」在界面上一模一样。
  "insp.scope.expired": { zh: "已过期", en: "Expired" },
  "insp.scope.neverExpires": { zh: "永不过期", en: "Never" },
  "insp.scope.level": { zh: "层级", en: "Level" },
  // ⚠️ `level` 是级联排除的判据 —— 缺了它「勾中集群即排除其下成员」会
  //    静默失效（UI 上是勾选的，成员照样出现）。所以表单里它是必选项。
  "insp.scope.levelHint": {
    zh: "层级决定级联范围：选 cluster 会连同其下成员一起排除",
    en: "Level drives cascading: cluster also excludes its members",
  },
  "insp.scope.lv.instance": { zh: "实例", en: "Instance" },
  "insp.scope.lv.cluster": { zh: "集群", en: "Cluster" },
  "insp.scope.lv.group": { zh: "组", en: "Group" },
  "insp.scope.lv.account": { zh: "整账号", en: "Whole account" },
  "insp.scope.service": { zh: "服务", en: "Service" },
  "insp.scope.resourceId": { zh: "资源 ID", en: "Resource ID" },
  "insp.scope.resourceIdHint": {
    zh: "留空 = 整账号排除",
    en: "Leave empty to exclude the whole account",
  },
  "insp.scope.accountId": { zh: "账号", en: "Account" },
  "insp.scope.reasonHint": {
    zh: "必填。没有理由的排除会越积越多，最后没人敢删",
    en: "Required. Exclusions without a reason pile up and nobody dares remove them",
  },
  // R1.7：整账号排除会让该账号整体退出巡检，且**没有任何运行时信号** ——
  //   下一轮就是少了那些资源，报告上不会写「有一个账号被排除了」。
  "insp.scope.confirmAccountWide": {
    zh: "这会让账号 {a} 整体退出「{k}」巡检，下一轮起该账号的资源都不再被检查。确认？",
    en: "This removes account {a} from the \"{k}\" inspection entirely. Confirm?",
  },
  "insp.scope.expiresAtHint": {
    zh: "留空 = 30 天后到期",
    en: "Leave empty for 30 days",
  },

  // 定时写侧
  "insp.config.atUtc": { zh: "执行时刻 (UTC)", en: "Run at (UTC)" },
  // 🔴 调度是 EventBridge 的 15 分钟 tick。填 02:07 得到的是一个**永远不被
  //    精确命中**的配置：只能靠补跑在 02:15 执行，表现为「报告总是慢 8 分钟」
  //    而不是任何报错。所以这条提示必须在输入框旁边，不能只靠后端 400。
  "insp.config.atUtcHint": {
    zh: "分钟须为 15 的整数倍（调度粒度 15 分钟，其他时刻只会靠补跑）",
    en: "Minutes must be a multiple of 15 (scheduler ticks every 15 min)",
  },
  "insp.config.atUtcBad": {
    zh: "格式 HH:MM，且分钟为 00/15/30/45",
    en: "Use HH:MM with minutes 00/15/30/45",
  },
  "insp.config.enabled": { zh: "启用", en: "Enabled" },
  "insp.config.weekdays": { zh: "执行日", en: "Days" },
  /* 🔴 原来这里是 `insp.config.everyDay`（「每天」那行小字），2026-08-31 连同
     那行小字一起删了：七个 chip 全亮**就是**每天，而原来的表现是七个全灭
     + 旁边写「每天」—— 屏幕上说「一天都不跑」，小字说「天天跑」，两者矛盾。 */
  "insp.config.weekdaysMin": {
    zh: "至少留一天。要停掉这一类巡检请用上面的「启用」开关 —— 一天都不选在库里等于「每天」，点灭最后一天会变成天天跑。",
    en: "Keep at least one day. To stop this inspection use the Enabled switch above: an empty selection means \"every day\" in storage, so clearing the last day would run it daily.",
  },
  // `persisted: false` = 用的是代码默认值，而巡检**已经在跑**。
  // 不标出来会让客户以为「还没配所以没跑」，于是去等一个已经发生的事。
  "insp.config.notPersisted": {
    zh: "使用默认值（尚未保存过，但巡检已按此执行）",
    en: "Using defaults (never saved, but the run already follows it)",
  },
  // 🔴 键是 **1~7（1 = 周一 … 7 = 周日）**，对齐调度器的 `date.isoweekday()`
  //    （`inspection/domain/schedule.py::matches_day`）。曾用 0~6（以为对齐的是
  //    `weekday()`），后果完全静默：选「周一」存 0，而 isoweekday() 永不返回 0
  //    → 那类巡检永远不跑。
  "insp.wd.1": { zh: "一", en: "Mon" },
  "insp.wd.2": { zh: "二", en: "Tue" },
  "insp.wd.3": { zh: "三", en: "Wed" },
  "insp.wd.4": { zh: "四", en: "Thu" },
  "insp.wd.5": { zh: "五", en: "Fri" },
  "insp.wd.6": { zh: "六", en: "Sat" },
  "insp.wd.7": { zh: "日", en: "Sun" },
  "admin.tab.roles": { zh: "角色", en: "Roles" },
  "admin.tab.users": { zh: "用户", en: "Users" },
  "admin.tab.groups": { zh: "组映射", en: "Group mapping" },
  "admin.tab.modules": { zh: "模块", en: "Modules" },
  "admin.tab.accounts": { zh: "账户", en: "Accounts" },
  "admin.tab.lifecycle": { zh: "生命周期", en: "Lifecycle" },
  "admin.tab.notifications": { zh: "集成 IM", en: "IM Integration" },
  "admin.tab.models": { zh: "模型", en: "Models" },
  // ── 模型目录（LLM provider / 候选模型 / 凭证 / 后端任务）──
  "admin.models.title": { zh: "模型目录", en: "Model catalogue" },
  "admin.models.sub": { zh: "勾选的模型就是所有用户在对话里能选到的全部候选;Provider 与凭证不对普通用户开放。保存后长驻实例会在下一条消息生效。", en: "The models you enable here are the only ones users can pick in chat; provider and credentials are never exposed to them. Long-running instances pick up changes on the next message." },
  "admin.models.loading": { zh: "加载中…", en: "Loading…" },
  "admin.models.provider": { zh: "Provider", en: "Provider" },
  "admin.models.providerHint": { zh: "当前阶段仅支持 Amazon Bedrock;LiteLLM 等多 Provider 在后续阶段开放。", en: "Amazon Bedrock only for now; multi-provider (LiteLLM) lands in a later phase." },
  "admin.models.credMode": { zh: "凭证方式", en: "Credentials" },
  "admin.models.cred.iam": { zh: "IAM 角色(默认)", en: "IAM role (default)" },
  "admin.models.cred.api_key": { zh: "Bedrock API Key", en: "Bedrock API key" },
  "admin.models.credHint": { zh: "选 API Key 后,推理请求用该 Key 计费与鉴权;列模型等控制面操作仍走本系统自身的 IAM 角色。", en: "With an API key, inference is billed and authorised through it; control-plane calls such as listing models still use this system's own IAM role." },
  "admin.models.keyPh": { zh: "粘贴 Bedrock API Key(保存后不再回显)", en: "Paste the Bedrock API key (never shown again)" },
  "admin.models.keySave": { zh: "保存 Key", en: "Save key" },
  "admin.models.keyClear": { zh: "清除", en: "Clear" },
  "admin.models.keySet": { zh: "已配置", en: "Configured" },
  "admin.models.keyUnset": { zh: "未配置", en: "Not configured" },
  "admin.models.keyHint": { zh: "仅显示后 4 位;更换 Key 会让各端重建模型客户端。", en: "Only the last 4 chars are shown; replacing the key makes every surface rebuild its model client." },
  // 谁在何时设的 + 轮换提示（spec R5.6）。Key 是共享凭证，只显示后 4 位定位不到人。
  "admin.models.keySetBy": { zh: "由 {who} 于 {when} 设置", en: "Set by {who} on {when}" },
  "admin.models.keySetByUnknown": { zh: "未记录的操作人", en: "an unrecorded actor" },
  "admin.models.keyRotationDue": { zh: "该 Key 已使用 {days} 天(超过建议的 {limit} 天),建议轮换。轮换后所有模型的验证状态会重置,需重新测试。", en: "This key has been in use for {days} days (past the recommended {limit}); consider rotating it. Rotating resets every model's verification, so they will need re-testing." },
  "admin.models.listTitle": { zh: "候选模型", en: "Candidate models" },
  "admin.models.enabledCount": { zh: "已启用 {n} 个", en: "{n} enabled" },
  "admin.models.surface.webchat": { zh: "Web", en: "Web" },
  "admin.models.surface.im": { zh: "IM", en: "IM" },
  "admin.models.default": { zh: "默认", en: "Default" },
  "admin.models.defaultTip": { zh: "新对话的默认模型,必须已启用且通过连通性测试", en: "Default model for new chats; must be enabled and pass the connectivity test" },
  "admin.models.capTip": { zh: "该模型的输出 token 硬上限(取自模型文档);设太低会静默截断回复", en: "The model's hard output-token cap from its docs; too low silently truncates replies" },
  "model.degradedNotice": { zh: "⚠ 暂时读不到模型目录，当前用的是内置备用清单;稍后会自动重试。", en: "\u26a0 The model catalogue is temporarily unavailable; using the built-in fallback list. Retrying automatically." },
  "model.noneEnabled": { zh: "管理员尚未为 Web 对话启用任何模型,暂时无法发送消息。请联系管理员在「管理 → 模型」中启用。", en: "No model has been enabled for web chat yet, so messages cannot be sent. Ask an administrator to enable one under Admin \u2192 Models." },
  "model.loading": { zh: "正在读取可用模型…", en: "Loading available models…" },
  "model.fallbackNotice": { zh: "⚠ 这是打包内置的备用清单 —— 未能读取管理员配置的模型目录，实际可用模型可能与此不同。", en: "\u26a0 Built-in fallback list \u2014 the administrator's model catalogue could not be loaded, so the models actually available may differ." },
  "admin.models.cap": { zh: "最大输出", en: "Max output" },
  "admin.models.searchPh": { zh: "搜索模型(如 claude 5、nova、gpt)", en: "Search models (e.g. claude 5, nova, gpt)" },
  "admin.models.matchCount": { zh: "匹配 {n} / 共 {total} 个候选", en: "{n} of {total} candidates" },
  "admin.models.noMatch": { zh: "没有匹配的模型。可改用下面的「手动填 model_id」。", en: "No matching model. You can use \"enter a model_id manually\" below." },
  "admin.models.candLoading": { zh: "正在读取候选模型…", en: "Loading candidate models…" },
  "admin.models.candFailed": { zh: "读取候选模型失败(见下方原因)。也可改用下面的「手动填 model_id」。", en: "Could not load candidate models (reason below). You can also use \"enter a model_id manually\" below." },
  "admin.models.retry": { zh: "重试", en: "Retry" },
  "admin.models.allAdded": { zh: "所有候选模型都已加入目录。", en: "Every candidate model is already in the catalogue." },
  "admin.models.otherProvider": { zh: "其他", en: "Other" },
  "admin.models.capUnit": { zh: "tokens", en: "tokens" },
  "admin.models.needAtLeastOne": { zh: "请先添加至少一个模型。", en: "Add at least one model first." },
  "admin.models.needEnabled": { zh: "至少启用一个模型(勾选模型名左侧的复选框)。", en: "Enable at least one model (tick the checkbox next to its name)." },
  "admin.models.needDefault": { zh: "请指定一个默认模型。", en: "Pick a default model." },
  "admin.models.defaultMustBeEnabled": { zh: "默认模型必须在启用集内。", en: "The default model must be one of the enabled ones." },
  "admin.models.needSurface": { zh: "「{surface}」端还没有可用模型:请让至少一个启用模型勾上它。", en: "No model is available for \"{surface}\": tick it on at least one enabled model." },
  "admin.models.cannotSave": { zh: "还不能保存", en: "Not ready to save" },
  "admin.models.testBtn": { zh: "测试", en: "Test" },
  "admin.models.testing": { zh: "测试中…", en: "Testing…" },
  "admin.models.testTip": { zh: "发一次最小请求验证可达与授权(真实调用)", en: "Send one minimal request to check reachability and authorisation (a real call)" },
  // 「已验证 / 未验证」这对文案随持久化的 verified 字段一起删除 —— 那是个会过期的快照。
  // 「未测试」占位也已删除：字段没了之后它对每个模型恒成立，不携带任何信息，只占宽度。
  // 现在结果只在点过「测试」之后出现，表达的就是那一次调用的结果。
  "admin.models.remove": { zh: "从目录移除", en: "Remove from the catalogue" },
  "admin.models.addModel": { zh: "添加模型", en: "Add model" },
  "admin.models.pickPh": { zh: "从本账号可用模型中选择…", en: "Pick from the models available to this account…" },
  "admin.models.add": { zh: "添加", en: "Add" },
  "admin.models.cancel": { zh: "取消", en: "Cancel" },
  // 推理路由范围 = 数据驻留范围，由 model_id 前缀决定（见 AdminPanel routingScopeKey）
  "admin.models.routing.global": { zh: "全球路由", en: "Global routing" },
  "admin.models.routing.us": { zh: "美加区域", en: "US & Canada" },
  "admin.models.routing.eu": { zh: "欧洲区域", en: "Europe" },
  "admin.models.routing.apac": { zh: "亚太区域", en: "Asia Pacific" },
  "admin.models.routing.regional": { zh: "本区域", en: "This Region" },
  "admin.models.routing.jp": { zh: "日本境内", en: "Japan only" },
  "admin.models.routing.usgov": { zh: "US GovCloud", en: "US GovCloud" },
  // 徽章要短：它与 model_id / region 同处一行时，长文案会把整行挤到换行（实测 GPT
  // 那行错位）。端点细节改由 ⓘ 弹层的 admin.models.infoMantle 承担。
  "admin.models.routing.mantle": { zh: "跨区", en: "Cross-Region" },
  // ⓘ 弹层：技术标识不再平铺在行内，改为点开查阅
  "admin.models.infoBtn": { zh: "查看模型标识与路由范围", en: "Model identifier and routing scope" },
  "admin.models.infoModelId": { zh: "Model ID", en: "Model ID" },
  "admin.models.infoRegion": { zh: "区域", en: "Region" },
  "admin.models.infoRouting": { zh: "路由范围", en: "Routing scope" },
  "admin.models.infoMantle": { zh: "该模型只在 bedrock-mantle 端点提供(不在 bedrock-runtime 上),请求会打到上面这个区域,与本部署区域无关。", en: "This model is served only on the bedrock-mantle endpoint (not on bedrock-runtime); requests go to the Region shown above, regardless of this deployment's Region." },
  "admin.models.routingTip": { zh: "推理请求会被路由到哪些区域,也就是提示词与回复可能流经的范围。由 model_id 前缀决定:global. = 全球所有支持的商业区域;us./eu./apac. = 限定在该地理范围内;无前缀 = 仅本部署区域。换前缀就是一次数据驻留变更。", en: "Which Regions inference requests can be routed to — i.e. where prompts and responses may travel. Determined by the model_id prefix: global. = every supported commercial Region worldwide; us./eu./apac. = confined to that geography; no prefix = this deployment Region only. Changing the prefix is a data-residency change." },
  "admin.models.orManual": { zh: "或手动填写 model_id：", en: "Or enter a model_id manually:" },
  "admin.models.manualLabelPh": { zh: "显示名（可选）", en: "Display name (optional)" },
  "admin.models.manualHint": { zh: "跨账号 Key 指向的模型可能不在本账号的候选列表里,此时手动填写。手填的条目未经枚举确认,务必先做连通性测试再启用。", en: "A model reached through a cross-account key may not appear in this account's candidate list; enter it manually here. A manual entry has not been confirmed by enumeration — always run the connectivity test before enabling it." },
  // 候选列表的来源身份。枚举必须用「将来真正执行推理的那个身份」去问，否则列出来的模型
  // Key 可能调不了 —— 那时必须说出来，不能默认两者一致。
  "admin.models.candFromKey": { zh: "以下候选由已配置的 Bedrock API Key 列出 —— 与推理使用的凭证一致。", en: "The candidates below were listed using the configured Bedrock API key — the same credential used for inference." },
  "admin.models.candFromRole": { zh: "以下候选由本系统的 IAM 角色列出（当前凭证方式为 IAM）。", en: "The candidates below were listed using this system's IAM role (credential mode is IAM)." },
  "admin.models.candKeyNoListPerm": { zh: "注意:该 Bedrock API Key 没有列模型的权限,以下候选改由本系统的 IAM 角色列出 —— 可能包含 Key 实际调不了的模型。启用前请务必逐个测试。", en: "Note: this Bedrock API key lacks permission to list models, so the candidates below came from this system's IAM role — they may include models the key cannot actually invoke. Test each one before enabling it." },
  "admin.models.test.ok": { zh: "可用", en: "OK" },
  "admin.models.test.forbidden": { zh: "无权限", en: "Forbidden" },
  "admin.models.test.unauthorized": { zh: "凭证无效", en: "Bad credentials" },
  "admin.models.test.invalidModel": { zh: "模型 ID 无效", en: "Invalid model id" },
  "admin.models.test.notFound": { zh: "未找到", en: "Not found" },
  "admin.models.test.throttled": { zh: "被限流", en: "Throttled" },
  "admin.models.test.notReady": { zh: "未就绪", en: "Not ready" },
  "admin.models.test.timeout": { zh: "超时", en: "Timed out" },

  "admin.models.test.error": { zh: "失败", en: "Failed" },
  "admin.models.test.probeError": { zh: "探测参数不被接受(疑似本系统的探测请求有问题,非模型不可用),请反馈", en: "The probe request was rejected (likely a bug in our probe, not the model); please report it" },
  "admin.models.test.needsProfile": { zh: "本区域不支持直调该模型,请改用带 global. / apac. 前缀的跨区域版本(在「添加模型」里搜同名模型)", en: "This Region cannot invoke the model directly; use the cross-Region version prefixed global. / apac. (search the same name under Add model)" },
  "admin.models.backendTitle": { zh: "后端任务模型", en: "Backend task models" },
  // 文案曾写「仅可选走 Converse 的模型(GPT 系不适用)」——那是我们后端缺 Mantle 分支时的
  // 状态，且「GPT 系」本身过度概括（gpt-oss 系是支持 Converse 的）。现已两端对齐。
  "admin.models.backendSub": { zh: "无人参与的后台任务用哪个模型。已启用的模型都可选。", en: "Which model unattended backend jobs use. Any enabled model can be selected." },

  "admin.models.task.phd_translate": { zh: "PHD 事件翻译与摘要", en: "PHD event translation and summary" },
  "admin.models.task.devops_report_summarize": { zh: "调查报告精简", en: "Investigation report summarisation" },
  "admin.models.followDefault": { zh: "跟随默认模型", en: "Follow the default model" },
  "admin.models.outOfSync": { zh: "上次同步到后端失败,请重新保存。", en: "The last sync to the backend failed; save again." },
  "admin.models.syncUnknown": { zh: "无法读取后端当前值,同步状态未知。", en: "Could not read the backend's current value; sync state unknown." },
  // 这条文案改过两轮，两轮都是因为它落后于代码：
  //   ① 原写「IM 尚未接入」+「GPT 系例外,始终走 IAM」—— IM 侧注入已完成，Mantle(GPT)
  //      三条路径也都改为优先用 Key，两条都不成立。
  //   ② 接着写「列模型等控制面操作仍走本系统自身的 IAM 角色」—— 也不成立了：候选枚举
  //      已改为用 Key 去列（否则用部署角色列出来的模型 Key 可能调不了,管理员加进目录、
  //      启用,直到用户发消息才 403）。见 bff/web-chat/llm_config.mjs::apiGetCandidates
  //      的 source_identity。
  // 管理员按这句话判断「切到 Key 之后哪些行为会变」,写错就是误导,不是小瑕疵。
  "admin.models.credApiKeyScope": { zh: "注意:API Key 用于全部推理调用 —— Web 对话、IM 机器人、后端任务(PHD 翻译 / 报告精简),对 Converse 与 Mantle(GPT)两类模型都生效。候选模型列表也用它枚举,好让列表与 Key 实际可调的范围一致;若 Key 没有列模型的权限,则退回本系统自身的 IAM 角色并在列表上标注。", en: "Note: the API key is used for every inference call — web chat, the IM bot, and backend tasks (PHD translation / report summarisation) — for both Converse and Mantle (GPT) models. It also enumerates the candidate model list, so that list matches what the key can actually invoke; if the key lacks listing permission, enumeration falls back to this system's own IAM role and says so." },
  // 换 Key = 换 IAM 身份（Key 背后是独立 IAM user，权限可被按模型收窄），旧的「已验证」
  // 随之失效。不说出来的话，管理员只看到绿勾变灰，还会撞上「默认模型未验证」的保存拦截。
  "admin.models.keyChangedRetest": { zh: "页面上的测试结果已清空 —— 凭证换了,旧结果不再代表现在的状况。可点「全部测试」用新凭证重测一遍。保存时系统会自动现场校验默认模型。", en: "The test results on this page were cleared: the credential changed, so the old results no longer reflect reality. Use \"Test all\" to re-check with the new credential. On save, the system verifies the default model live anyway." },
  "admin.models.testAll": { zh: "全部测试", en: "Test all" },
  "admin.models.testAllTip": { zh: "逐个真调已启用的模型。AWS 没有「列出某凭证可调模型」的接口,能不能调只能实际调一次才知道。串行执行以免触发限流。", en: "Really calls each enabled model, one at a time. AWS has no API that lists which models a given credential may invoke, so the only reliable answer comes from actually calling them. Sequential, to avoid throttling." },
  "admin.models.probedWithKey": { zh: "以上验证结果使用的是已配置的 Bedrock API Key —— 与推理请求实际使用的凭证一致。", en: "The results above were obtained with the configured Bedrock API key — the same credential inference requests actually use." },
  "admin.models.probedWithRole": { zh: "注意:以上验证使用的是本系统的 IAM 角色,不是 Bedrock API Key(凭证方式为 IAM,或 Key 未配置)。若稍后改用 Key,需要重新验证。", en: "Note: the results above used this system's IAM role, not a Bedrock API key (credential mode is IAM, or no key is set). Re-verify after switching to a key." },
  "admin.models.save": { zh: "保存", en: "Save" },
  "admin.models.saving": { zh: "保存中…", en: "Saving…" },
  "admin.models.saved": { zh: "已保存", en: "Saved" },
  "admin.models.generation": { zh: "配置版本", en: "Config version" },
  "admin.models.audit": { zh: "变更记录", en: "Change history" },
  "admin.models.auditEmpty": { zh: "暂无变更记录。", en: "No changes recorded yet." },
  "admin.models.rollback": { zh: "回滚到此前", en: "Roll back to before" },
  "admin.notif.title": { zh: "飞书机器人", en: "Feishu Bot" },
  "admin.notif.loading": { zh: "加载中…", en: "Loading…" },
  "admin.notif.secretPh": { zh: "留空或保持 **** 不变则不修改", en: "Leave masked (****) to keep unchanged" },
  "admin.notif.secretHint": { zh: "仅显示后 4 位;输入新值将覆盖。", en: "Only last 4 chars shown; enter a new value to replace." },
  // Encrypt Key / Verification Token:webhook 模式下的唯一鉴权手段。ingress 冷启动硬校验,
  // 任一为空直接崩(platforms/feishu/lambda_ingress.py「硬约束 A」)—— 所以这里写"必填",
  // 不写"可选"。
  "admin.notif.encryptHint": { zh: "自己生成的随机串(建议 ≥32 位),必须与飞书「加密策略」页填的完全一致。仅显示后 4 位。", en: "A random string you generate (32+ chars recommended); must match the Encryption Strategy page in the Feishu console exactly. Only last 4 chars shown." },
  "admin.notif.tokenHint": { zh: "飞书「加密策略」页直接给出,复制过来。仅显示后 4 位。", en: "Shown on the Feishu Encryption Strategy page — copy it here. Only last 4 chars shown." },
  "admin.notif.keysRequired": { zh: "Webhook 模式下这两把钥匙是必填项:缺任一,IM 入口会在冷启动时直接失败(飞书那边显示「校验失败」)。必须先在这里保存,再去飞书填请求地址。", en: "Both keys are required in webhook mode: if either is empty the IM entry point fails at cold start (Feishu shows a verification failure). Save them here BEFORE setting the request URL in Feishu." },
  "admin.notif.chatIds": { zh: "推送群组 Chat ID", en: "Target group chat IDs" },
  "admin.notif.chatIdsHint": { zh: "出方向:每日报告、告警推送、调查回调发到这些群。群里 @机器人 的收方向不用在这里登记,由飞书的事件订阅决定。", en: "Outbound only: daily reports, alerts and investigation callbacks go to these chats. Inbound (@mention in a chat) needs no entry here — it is driven by the Feishu event subscription." },
  // 页面上的四步速览 + 打开右侧抽屉的超链接。详细步骤内容在 content/feishuGuide.ts。
  "admin.notif.steps.title": { zh: "在飞书开放平台要做的四步", en: "Four steps in the Feishu console" },
  "admin.notif.steps.s1": { zh: "创建/打开自建应用,开通机器人能力与 im / cardkit 权限,创建版本并发布。", en: "Create or open a custom app, enable the bot capability plus the im / cardkit scopes, then publish a version." },
  "admin.notif.steps.s2": { zh: "事件与回调 → 加密策略:填一个 Encrypt Key、复制 Verification Token,回到上面保存。", en: "Events & Callbacks → Encryption Strategy: set an Encrypt Key, copy the Verification Token, then save both above." },
  "admin.notif.steps.s3": { zh: "事件配置:订阅方式改为「将事件发送至开发者服务器」,请求地址填栈输出的 FeishuWebhookUrl,订阅 im.message.receive_v1。", en: "Event config: switch delivery to \"send to developer server\", set the request URL to the stack output FeishuWebhookUrl, and subscribe im.message.receive_v1." },
  "admin.notif.steps.s4": { zh: "回调配置:同一个 URL,订阅 card.action.trigger(卡片按钮全靠它)。", en: "Callback config: the same URL, subscribe card.action.trigger (card buttons depend on it)." },
  "admin.notif.steps.order": { zh: "顺序是硬的:先保存上面两把钥匙,再去飞书填请求地址。反了的症状是飞书显示「校验失败」,看起来像地址填错了。", en: "The order is not optional: save the two keys above first, then set the request URL in Feishu. Doing it the other way round shows up as \"verification failed\" in Feishu, which looks like a wrong URL." },
  "admin.notif.guideLink": { zh: "查看详细配置步骤", en: "View the detailed setup steps" },
  "admin.notif.guideTitle": { zh: "配置飞书机器人", en: "Set up the Feishu bot" },
  "admin.notif.guideSub": { zh: "本页保存凭证,飞书控制台改订阅方式与请求地址。两边都做完才通。", en: "Credentials are saved on this page; delivery mode and request URL are set in the Feishu console. It only works once both are done." },
  "admin.notif.test": { zh: "测试", en: "Test" },
  "admin.notif.testing": { zh: "发送中…", en: "Sending…" },
  "admin.notif.testTip": { zh: "向该群发送一条测试消息(真实发送)", en: "Send a real test message to this chat" },
  "admin.notif.addChat": { zh: "添加群组", en: "Add chat" },
  "admin.notif.save": { zh: "保存", en: "Save" },
  "admin.notif.saving": { zh: "保存中…", en: "Saving…" },
  "admin.notif.saved": { zh: "已保存", en: "Saved" },
  // 抽屉第 3 步的 webhook 地址框。地址本身由后端查出来（不是文案），这里只有周边的界面字。
  "admin.notif.url.label": { zh: "飞书请求地址(Webhook)", en: "Feishu request URL (webhook)" },
  "admin.notif.url.copy": { zh: "复制", en: "Copy" },
  "admin.notif.url.copied": { zh: "已复制", en: "Copied" },
  // 空串的三种原因（没装 IM / 名字对不上 / 查询无权限）对客户是同一个动作：去 Outputs 里看。
  // 所以不分开报 —— 分开报要么泄露内部细节,要么让客户面对一个他解决不了的区分。
  "admin.notif.url.missing": { zh: "取不到地址。请到 CloudFormation 控制台 → 你的栈 → Outputs → FeishuWebhookUrl 里复制(只装了 web 的栈没有这一项)。", en: "Could not retrieve the URL. Copy it from the CloudFormation console → your stack → Outputs → FeishuWebhookUrl (a web-only stack has no such output)." },
  // 🔴 原名「添加组织外账号(跨 Payer)」对一大类客户是**错的**：
  //    partner-resold 客户手里没有 payer 账号、系统部署在某个 linked account
  //    上，他要加的 456 与部署账号 123 **在同一个组织里** —— 只是他没有管理
  //    账号权限。看到「组织外」他会以为这条路不适用自己。
  //    判据不是「在不在同一组织」，而是「有没有管理账号权限」。
  "admin.xpayer.title": { zh: "手动接入账号（不需要管理账号权限）", en: "Manual onboarding (no management-account access needed)" },

  // ── 跨账号**巡检**的前置（2026-08-25）──
  //
  // 与上面的接入 / DA 关联是独立的两件事：那些让账号「接进来」，
  // 这些让**巡检**能真的采到它。
  //
  // 🔴 文案里必须说清「巡检共用系统账号的一个 space」—— 否则客户会去
  //    成员账号自己的 space 里找 monitor account 的设置，而那里没有。
  "admin.inspxacct.title": {
    zh: "巡检的跨账号前置", en: "Cross-account prerequisites for inspection" },
  "admin.inspxacct.desc": {
    zh: "巡检要采到这个账号，需要下面两件。① 是必需的，缺了整轮巡检直接失败；② 影响 AI 判读能挖多深，缺了判读仍会出结论。两个都要账号所有者在自己账号里部署 CloudFormation，我们代不了。",
    en: "Two independent things are needed. ① is required — without it the whole inspection run fails. ② affects how deep the AI analysis can dig; without it the analysis still concludes. Both require the account owner to deploy CloudFormation in their own account.",
  },
  "admin.inspxacct.step1": { zh: "采集角色（必需）", en: "Collection role (required)" },
  "admin.inspxacct.step1Hint": {
    zh: "巡检用它 AssumeRole 进目标账号读 RDS / ElastiCache / CloudWatch。接入时那个 CloudFormation 栈已经建好它了（同 Org 的一键接入也一样），保存账号时会自动 AssumeRole 验一次。显示缺失说明栈是老模板部署的、或者部署时把 CreateCollectionRole 选成了 no —— 那就用下面的链接补一个栈。",
    en: "Inspection assumes it to read RDS / ElastiCache / CloudWatch in the target account. The onboarding CloudFormation stack already creates it (same for one-click onboarding), and saving the account verifies it automatically. If it shows missing, the stack predates that change or was deployed with CreateCollectionRole=no - use the link below to add it.",
  },

  "admin.inspxacct.step2": {
    zh: "关联进巡检 Agent Space（可选）", en: "Link into the inspection agent space (optional)" },
  "admin.inspxacct.step2Hint": {
    zh: "让 AI 判读能主动查目标账号的 Performance Insights / 事件，不只看我们打包进去的指标。成员账号那一侧的角色已经由接入的那个栈建好，剩下的关联是系统账号里的一次 API 调用 —— 点「一键关联」即可，不用进 DevOps Agent 控制台。\n\n不做这一步巡检照常采集和判定，只是判读少了主动深挖那一半。",
    en: "Lets the AI analysis query Performance Insights and events in the target account directly, instead of only the metrics we package for it. The role on the member side is already created by the onboarding stack; linking it is a single API call in the system account - just click Link, no console trip needed.\n\nWithout this, inspection still collects and scores normally; the analysis just cannot dig deeper on its own.",
  },

  "admin.inspxacct.spaceLabel": { zh: "巡检 Agent Space", en: "Inspection agent space" },
  // 🔴 两步在**不同账号**里操作 —— 这是跨账号流程最容易搞错的一件事。
  //    徽章直接写出账号号码，不要只说「目标账号」/「系统账号」
  //    （客户手里可能有好几个账号，"系统账号"是哪个他未必记得）。
  "admin.inspxacct.inTarget": { zh: "在此账号操作 →", en: "do this in →" },
  "admin.inspxacct.inSystem": { zh: "在系统账号操作 →", en: "do this in the system account →" },
  "admin.inspxacct.copyBtn": { zh: "复制", en: "Copy" },
  "admin.inspxacct.copied": { zh: "已复制", en: "copied" },
  "admin.inspxacct.copyFailed": {
    zh: "复制失败（浏览器不允许访问剪贴板）—— 请手动选中复制。",
    en: "Copy failed (clipboard blocked) — please select and copy manually." },
  // 🔴 第②步是在 AWS 控制台里做的，做完必须有办法让状态灯更新 ——
  //    这个按钮是那一步唯一的反馈渠道。
  "admin.inspxacct.recheckBtn": { zh: "重新检查", en: "Re-check" },
  "admin.inspxacct.stackBtn": { zh: "生成部署链接", en: "Get deploy link" },
  "admin.inspxacct.stackOpen": {
    zh: "在目标账号打开 CloudFormation 部署 ↗",
    en: "Open CloudFormation in the target account ↗" },
  "admin.inspxacct.stackHint": {
    zh: "⚠️ 用**目标账号**的控制台登录后再点这个链接（不是系统账号）。参数已经填好，直接下一步到底、勾选 IAM 确认框即可。链接 12 小时内有效。部署完回来点「验证并登记」。",
    en: "⚠️ Sign in to the TARGET account's console before opening this link (not the system account). Parameters are pre-filled — just proceed and tick the IAM acknowledgement. Link valid for 12h. Come back and click Verify afterwards.",
  },
  "admin.inspxacct.verifyBtn": { zh: "验证并登记采集角色", en: "Verify & register role" },
  "admin.inspxacct.verifyOk": { zh: "AssumeRole 通过，已登记", en: "AssumeRole succeeded, registered" },
  "admin.inspxacct.done": { zh: "已完成", en: "done" },
  "admin.inspxacct.missingRequired": { zh: "缺失（巡检会失败）", en: "missing (inspection will fail)" },
  "admin.inspxacct.missingOptional": { zh: "未关联（判读会降级）", en: "not linked (analysis degraded)" },
  // ⚠️ 「查不到」与「没关联」必须分开：前者去查我们的权限，后者去关联。
  "admin.inspxacct.unknown": { zh: "查不到（不等于未关联）", en: "unknown (not the same as unlinked)" },
  "admin.inspxacct.mismatch": {
    zh: "⚠️ 已登记的 ARN 与模板会建出来的不一致 —— 可能贴错了，或换过部署账号。AssumeRole 会一直失败：",
    en: "⚠️ The registered ARN differs from what the template creates — wrong paste, or the deployment account changed. AssumeRole will keep failing:",
  },
  // 折叠标题上的状态徽章。三档，因为①与②的**后果量级不同**：
  // ①缺失 = 整轮巡检失败（阻塞）；②未关联 = 判读少了主动深挖那一半（降级）。
  // 🔴 客户 2026-08-27 原话：「做成这么小的一行，而且还自动折叠起来了，
  //    我都没有发现，以为已经完全配置好了」—— 折叠且不显示状态 = 「这里没事」。
  "admin.inspxacct.headBlocking": {
    zh: "缺采集角色 · 巡检会失败", en: "collection role missing - inspection will fail",
  },
  "admin.inspxacct.headDegraded": {
    zh: "判读未关联 · 会降级", en: "analysis not linked - degraded",
  },
  "admin.inspxacct.headReady": { zh: "已就绪", en: "ready" },
  "admin.inspxacct.whyToggle": {
    zh: "这两件事分别是什么、角色 ARN 是哪些",
    en: "What these two are, and which role ARNs",
  },
  "admin.inspxacct.tmplBtn": { zh: "生成模板 URL", en: "Get template URL" },
  // 🔴 ①缺失时的唯一下一步。采集角色已经合并进接入用的那个模板，所以缺它
  //    意味着**那个栈是旧模板部署的** —— 正确动作是 update 已有栈，不是再建
  //    一个（Launch Stack URL 是 create/review，会去建第二个栈）。
  // ⚠️ 拿不到成员账号里那个栈的 stackId（跨账号），给不了 update 深链，
  //    所以给模板 URL + 三步指令。
  "admin.inspxacct.updateStackHint": {
    zh: "采集角色现在由接入时那个 CloudFormation 栈一并建出来 —— 显示缺失说明"
      + "那个栈是这次改动之前部署的，更新一次就能同时补齐①和②。\n"
      + "在账号 {account} 的 CloudFormation 里选中栈 {stack} → 更新 → "
      + "替换现有模板 → 粘贴下面这个 S3 URL → 两个新参数保持预填值 → 更新。"
      + "完成后点上面①的「验证并登记采集角色」。",
    en: "The collection role is now created by the same onboarding CloudFormation "
      + "stack - showing missing means that stack predates this change. Updating "
      + "it once satisfies both steps.\nIn account {account}, open CloudFormation, "
      + "select stack {stack} -> Update -> Replace existing template -> paste the "
      + "S3 URL below -> keep the prefilled values for the two new parameters -> "
      + "Update. Then click Verify in step 1 above.",
  },
  "admin.inspxacct.assocBtn": { zh: "一键关联", en: "Link now" },
  // 🔴 客户 2026-08-27 原话：「我也不懂什么叫一键关联，关联的是什么？谁来操作？」
  //    「一键关联」这四个字既没说做什么、也没说谁在做。徽章说了「在系统账号操作」，
  //    但那回答的是「在哪」不是「谁」—— 客户合理地以为要他自己去那个账号操作。
  "admin.inspxacct.assocTip": {
    zh: "由 NotiOps 代做，你不用进控制台。做的是控制台「添加辅助云来源」向导的"
      + "最后一步（第 7 步「连接到代理」）：把这个账号的角色注册到系统账号的巡检"
      + "Agent Space 上。前 6 步（建 IAM 角色 + 抄信任策略）已经由接入时那个"
      + "CloudFormation 栈做完了。",
    en: "NotiOps does this for you - no console needed. It performs the last step "
      + "of the console's \"add secondary cloud source\" wizard (step 7, \"connect "
      + "to agent\"): registering this account's role on the inspection agent space "
      + "in the system account. Steps 1-6 (creating the IAM role and pasting the "
      + "trust policy) were already done by the onboarding CloudFormation stack.",
  },
  // 🔴 「已登记但对不上」是独立的一态，不能显示成「已完成」。
  //    登记的 ARN 与模板会建的不一致 = 贴错过账号 / 换过部署账号，
  //    两种都会让 AssumeRole 永远失败，而每一轮巡检都在后台失败一次。
  "admin.inspxacct.mismatchShort": {
    zh: "已登记但与预期不符（巡检会失败）",
    en: "registered but does not match (inspection will fail)",
  },
  "admin.inspxacct.assocOk": {
    zh: "已关联进巡检 Agent Space",
    en: "Linked into the inspection agent space",
  },
  "admin.inspxacct.assocExists": {
    zh: "本来就已关联（没有重复创建）",
    en: "Already linked (nothing created)",
  },
  // 🔴 `invalid` 与「未关联」是两回事：关联建了，但成员账号里那个角色不存在
  //    或信任策略不对 —— DA assume 不进去。显示成「已关联」会掩盖它。
  "admin.inspxacct.assocInvalid": {
    zh: "关联已建但校验为 invalid —— 目标账号里那个角色不存在或信任策略不对。"
      + "去目标账号确认接入栈里的 InspectionMonitorRole 建出来了（部署时 "
      + "InspectionAgentSpaceArn 留空就不会建），然后再点一次「重新检查」。",
    en: "Linked but validation says invalid - the role in the target account is "
      + "missing or its trust policy does not match. Check that the onboarding "
      + "stack created InspectionMonitorRole (it is skipped when "
      + "InspectionAgentSpaceArn is left empty), then re-check.",
  },
  "admin.inspxacct.assocPending": {
    zh: "关联待确认 —— 稍等几秒再点「重新检查」（IAM 角色刚建完需要传播）。",
    en: "Link pending confirmation - wait a few seconds and re-check (a freshly "
      + "created IAM role takes a moment to propagate).",
  },
  "admin.inspxacct.noSpace": {
    zh: "🔴 读不到巡检 Agent Space ID —— 主栈的 InspectionAgentSpaceId 没注入到 BFF，重新部署 NotiOpsBackendStack 与 WebChatStack。",
    en: "🔴 Inspection agent space ID unavailable — the main stack's InspectionAgentSpaceId is not wired into the BFF. Redeploy NotiOpsBackendStack and WebChatStack.",
  },
  "admin.xpayer.desc": { zh: "两种情况都走这条：① 账号不在本组织；② 在同一组织但你没有管理账号权限（例如 partner-resold，手里只有 linked account）。流程：输入账号 ID → 生成 CloudFormation 链接 → 用**那个账号**登录控制台部署 → 把 Outputs 回填到这里。全程不需要 Organizations 权限。", en: "Use this for either case: (1) the account is outside this organization, or (2) it is in the same organization but you lack management-account access (e.g. partner-resold, you only hold linked accounts). Flow: enter account ID → generate a CloudFormation link → sign in AS THAT ACCOUNT and deploy → paste the Outputs back here. No Organizations permissions required." },
  "admin.xpayer.acctLabel": { zh: "目标账号 ID (12 位)", en: "Target account ID (12 digits)" },
  "admin.xpayer.invalidId": { zh: "账号 ID 格式错误(需 12 位数字)", en: "Invalid account ID (must be 12 digits)" },
  "admin.xpayer.genBtn": { zh: "生成链接", en: "Generate link" },
  "admin.xpayer.openStack": { zh: "→ 点此在目标账号的 AWS 控制台部署", en: "→ Click to deploy in the target account's AWS console" },
  "admin.xpayer.stackHint": { zh: "将此链接发给目标账号管理员,在其 AWS 控制台中一键部署;完成后把 Stack Outputs 里的 AgentSpaceId 和 TriggerRoleArn 贴回下方。", en: "Share this link with the target account admin to deploy via their AWS console; once done, paste the AgentSpaceId and TriggerRoleArn from the Stack Outputs below." },
  "admin.xpayer.saveBtn": { zh: "保存并激活", en: "Save & activate" },
  // 🔴 **别再写「（可选）」。** 2026-08-31 实机接入时用户明确反馈「我被误导了」。
  //
  //    「可选」只对一种人成立：栈是**旧版**、Outputs 里压根没有
  //    `InspectionAgentSpaceId` 这一项。而任何部署**当前**模板的人，那个 Output
  //    就摆在栈的 Outputs 页上 —— 对他们来说这是必填，留空唯一的效果是把这个
  //    账号的 AI 判读整个关掉。
  //
  //    而留空是**静默**的：写侧不拒、不 warning，那个字段直接不进
  //    UpdateExpression（`member_accounts.mjs` 的 `inspectSpaceId ? ... : ""`）。
  //    表现是巡检看板上 finding 照出、每条旁边的判读永远空着，
  //    而看板上「判读为空」与「DA 说这条没问题」长得一样。
  //
  // ⇒ 标签改成「必填」，把「旧版模板可留空」降级成提示里的一句例外。
  //   ⚠️ **不能**直接做成表单必填校验 —— 那会把旧模板的存量账号挡在门外，
  //     而他们除了重新部署栈别无他法。所以是「文案上必填 + 校验上允许空」。
  "admin.xpayer.inspectSpaceLabel": {
    zh: "巡检 Agent Space ID（必填）",
    en: "Inspection Agent Space ID (required)" },
  "admin.xpayer.inspectSpaceHint": {
    zh: "填模板输出里的 InspectionAgentSpaceId（与上面那个 Agent Space ID 是**两个不同**的值）。"
      + "🔴 留空 = 这个账号不做 AI 判读：采集与确定性规则照跑、finding 照出，"
      + "但每条 finding 旁边的判读永远是空的，而看板上「判读为空」与「DA 说这条没问题」长得一样。"
      + "排障不受影响。只有一种情况该留空：你的栈是旧版模板、Outputs 里没有这一项 —— 那要重新部署栈才有。",
    en: "Paste the InspectionAgentSpaceId output (a **different** value from the Agent Space ID above). "
      + "Leaving it empty disables AI judgment for this account: collection and rule-based findings still run, "
      + "but every finding's analysis stays empty -- and on the dashboard \"no analysis\" looks exactly like "
      + "\"the agent found nothing wrong\". Troubleshooting is unaffected. The only reason to leave it empty is "
      + "an older template whose Outputs do not expose it -- redeploy the stack to get it." },
  "admin.xpayer.saved": { zh: "已保存并激活", en: "Saved and activated" },
  "admin.xpayer.testBtn": { zh: "测试连接", en: "Test connection" },
  "admin.xpayer.testOk": { zh: "✅ 连接成功", en: "✅ Connection successful" },
  "admin.accounts.onboardTitle": { zh: "成员账号接入", en: "Member account onboarding" },
  "admin.accounts.onboardDesc": { zh: "组织内账号一键接入：自动下发只读采集角色 + DevOps/PHD 事件转发（CloudFormation StackSets），完成后自动登记并启用。", en: "One-click onboarding for organization accounts: provisions the read-only role + DevOps/PHD event forwarding via CloudFormation StackSets, then registers and enables the account." },
  "admin.accounts.colAccount": { zh: "账号", en: "Account" },
  "admin.accounts.colStatus": { zh: "接入状态", en: "Status" },
  "admin.accounts.colRegions": { zh: "采集 Region", en: "Regions" },
  "admin.accounts.colAction": { zh: "操作", en: "Action" },
  "admin.accounts.stActive": { zh: "已接入", en: "Onboarded" },
  "admin.accounts.stProvisioning": { zh: "接入中…", en: "Provisioning…" },
  "admin.accounts.stFailed": { zh: "接入失败", en: "Failed" },
  "admin.accounts.stRegistered": { zh: "已登记（未启用）", en: "Registered (disabled)" },
  "admin.accounts.stNone": { zh: "未接入", en: "Not onboarded" },
  "admin.accounts.onboardBtn": { zh: "一键接入", en: "Onboard" },
  "admin.accounts.retryBtn": { zh: "重试接入", en: "Retry" },
  // 🔴 `*` 那句提示是这个字段的**全部**用户文档。没有它的话「怎么让它扫
  //    全部 region」在界面上无从得知（2026-08-29 之前巡检恒扫全部、压根不
  //    读这个字段，客户填 us-east-1 保存成功，第二天报告里冒出 eu-west-1 的
  //    finding，回来改这个框改成什么都没用）。现在它生效了，代价是「全部」
  //    要显式表达 —— 就是这个 `*`。
  "admin.accounts.regionsPrompt": {
    zh: "采集 Region（逗号分隔，如 us-east-1,us-east-2）。填 * 表示所有 region；不填默认 us-east-1",
    en: "Regions to collect (comma-separated, e.g. us-east-1,us-east-2). Use * for all regions; defaults to us-east-1" },
  "admin.accounts.regionsEdit": { zh: "改 Region", en: "Edit regions" },
  "admin.accounts.regionsSaved": { zh: "采集 Region 已更新", en: "Regions updated" },
  /* ── 账号显示名（alias）─────────────────────────────────────────────────
     🔴 这几条为什么重要：`account_name` / `account_alias` 此前**只在接入那一刻
        写一次**，来源是 `organizations:DescribeAccount` 的 Account.Name。
        跨组织接入的账号那个调用拿不到东西（账号不在本组织里）→ 两个字段都空
        → 客户在账号选择器和 IM 推送里看到的是**十二位数字**，
        而他手里可能有五个这样的账号。 */
  "admin.accounts.aliasEdit": { zh: "改名", en: "Rename" },
  "admin.accounts.aliasHint": {
    zh: "改这个账号在选择器、看板和 IM 推送里显示的名字。不动任何 AWS 资源。",
    en: "Change how this account is labelled in the selector, dashboards and IM "
      + "pushes. Touches no AWS resources.",
  },
  "admin.accounts.aliasManual": { zh: "自定义名", en: "Custom name" },
  "admin.accounts.aliasManualHint": {
    zh: "这个名字是在这里手填的，不是 AWS Organizations 里的账号名 —— "
      + "在 AWS 控制台里搜不到它。排查时请用下面那个 12 位账号号。",
    en: "This label was set here, not in AWS Organizations - you will not find "
      + "it in the AWS console. Use the 12-digit account ID below when "
      + "troubleshooting.",
  },
  "admin.accounts.aliasPrompt": {
    zh: "影响：账号选择器、各看板的账号列、IM 推送的标题标签、调查记录的账号名。\n"
      // 🔴 「留空 = 清空」这条必须说 —— 否则清空之后回退成什么完全不可预测。
      + "留空 = 清空自定义名，回退成 AWS Organizations 里的账号名"
      + "（取不到时显示 12 位账号号）。\n"
      // 🔴 这条不说的话客户改完会去 DevOps Agent 控制台找那个新名字，找不到，
      //    然后以为保存失败了、反复重试。space 创建时名字就定死了，没有 rename API。
      + "⚠️ 不会重命名已经建好的 DevOps Agent space —— 那个名字在创建时就定死了。\n"
      + "最多 64 个字符；不能是纯数字（列表里显示成「名字 · 账号号」，"
      + "两串数字并排分不出哪个是账号号）。",
    en: "Affects: the account selector, the account column on every dashboard, "
      + "the IM push title label and the account name on investigation records.\n"
      + "Leave empty to clear the custom name and fall back to the AWS "
      + "Organizations account name (or the 12-digit ID if unavailable).\n"
      + "Note: this does NOT rename an existing DevOps Agent space - that name "
      + "is fixed at creation time.\n"
      + "Max 64 characters; cannot be all digits (the list renders "
      + "\"name - account id\", and two number strings side by side are "
      + "indistinguishable).",
  },
  "admin.accounts.aliasSaved": {
    zh: "显示名已更新 —— 选择器、看板和 IM 推送的标签都改好了。",
    en: "Name updated - the selector, dashboards and IM push labels all reflect it.",
  },
  /* 🔴 `da#` 行不存在（只做了接入、还没做 DevOps Agent 关联）时后端跳过那一行，
        也就是 IM 推送里那个账号的标签**没有变**。两种结果在列表上长得一样，
        所以必须分成两条文案。 */
  "admin.accounts.aliasSavedNoPush": {
    zh: "显示名已更新（选择器与看板）。\n"
      + "⚠️ IM 推送的标签**没有改** —— 这个账号还没做 DevOps Agent 关联，"
      + "推送里用的仍然是「账号 <账号号>」。做完关联后再改一次名即可。",
    en: "Name updated for the selector and dashboards.\n"
      + "Note: the IM push label was NOT changed - this account has no DevOps "
      + "Agent association yet, so pushes still use \"account <id>\". "
      + "Rename again after associating.",
  },
  // 🔴 存量账号的升级信号（per-account agent space 之后）。
  //    不显示它的后果：那些账号采集照跑、花 GetMetricData，而判读永远为空，
  //    而看板上「N 条未做根因分析」与「DA 说这些没问题」长得一样。
  "admin.accounts.needsUpdate": { zh: "待更新栈", en: "Stack update needed" },
  "admin.accounts.outOfOrg": { zh: "组织外", en: "Outside organization" },
  "admin.accounts.outOfOrgHint": {
    zh: "这个账号不在部署账号所属的 AWS Organizations 里，是通过「跨 Payer 接入」"
      + "手动加进来的。它照常被巡检采集与判读，但一键接入 / 一键下线走 StackSet，"
      + "覆盖不到它 —— 那两个按钮对它不显示。要调整它的部署内容，"
      + "去它自己的 CloudFormation 控制台改那个栈。",
    en: "This account is not in the deployment account's AWS Organizations; it was "
      + "added manually via cross-payer onboarding. It is collected and analyzed "
      + "normally, but one-click onboarding/offboarding goes through StackSets and "
      + "cannot reach it, so those buttons are hidden. To change what is deployed "
      + "there, edit the stack in that account's own CloudFormation console.",
  },
  // ⚠️ 提示里必须给**具体步骤**，因为 CloudFormation 的 quick-create 链接
  //    只支持「创建」（官方文档确认没有更新栈的形式），我们给不了一键链接。
  //    也必须覆盖两种读法：旧模板没有那个输出 / 新模板但回填时留空了。
  "admin.accounts.needsUpdateHint": {
    zh: "这个账号还没有登记巡检 Agent Space，所以只有规则判定、没有 AI 判读"
      + "（采集与排障不受影响）。两种原因："
      + "① 部署的是旧版模板（Outputs 里没有 InspectionAgentSpaceId）——"
      + "去 CloudFormation 控制台选中 notiops-devops-agent-<账号> 栈 → 更新 →"
      + "替换现有模板 → 用上面「生成部署链接」拿到的模板 URL；"
      + "② 部署过新模板但回填时那一栏留空 —— 直接回填即可。",
    en: "This account has no inspection Agent Space registered, so it gets "
      + "rule-based findings only, no AI judgment (collection and "
      + "troubleshooting are unaffected). Two possible causes: "
      + "(1) it runs an older template version with no InspectionAgentSpaceId "
      + "output - in the CloudFormation console select the "
      + "notiops-devops-agent-<account> stack, choose Update, replace the "
      + "existing template with the URL from \"Generate deploy link\"; "
      + "(2) it runs the new template but the field was left blank when "
      + "filling back the outputs - just fill it in." },
  "admin.accounts.confirmBtn": { zh: "确认接入", en: "Confirm" },
  "admin.accounts.cancelBtn": { zh: "取消", en: "Cancel" },
  "admin.accounts.refresh": { zh: "刷新", en: "Refresh" },
  "admin.accounts.visTitle": { zh: "账号数据可见性", en: "Account data visibility" },
  "admin.accounts.visDesc": { zh: "控制哪些用户/组能看到成员账号的数据（FinOps、调查等）。未配置 = 可见全部；admin 恒可见全部。", en: "Control which users/groups can see member account data (FinOps, investigations, etc.). Unconfigured = all visible; admin always sees all." },
  "admin.accounts.visPrincipal": { zh: "主体", en: "Principal" },
  "admin.accounts.visUser": { zh: "用户", en: "User" },
  "admin.accounts.visGroup": { zh: "组", en: "Group" },
  "admin.accounts.visAll": { zh: "全部账号", en: "All accounts" },
  "admin.accounts.visSave": { zh: "保存", en: "Save" },
  "admin.accounts.visReset": { zh: "清除限制（恢复全部可见）", en: "Clear restriction (all visible)" },
  "admin.accounts.visSaved": { zh: "已保存", en: "Saved" },
  "admin.accounts.visPick": { zh: "选择用户或组以配置可见账号", en: "Select a user or group to configure visible accounts" },
  "admin.accounts.empty": { zh: "组织内没有 ACTIVE 账号", en: "No ACTIVE accounts in the organization" },
  // ⚠️ 「组织里没有别的账号」与「还没登记过任何账号」是两件不同的事 ——
  //    混成一句会让人以为组织是空的。
  "admin.accounts.emptyRegistered": {
    zh: "还没有接入任何账号。用下面的「手动接入账号」加第一个。",
    en: "No accounts onboarded yet. Use Manual onboarding below to add the first one." },
  "admin.accounts.onboardDescRegistered": {
    zh: "已接入的账号（一键接入与手动接入都列在这里）。一键接入需要组织管理账号"
      + "权限并以多账号模式部署，当前不可用 —— 用下面的「手动接入账号」逐个加。",
    en: "Onboarded accounts (both one-click and manual are listed here). One-click "
      + "onboarding needs management-account permissions and a multi-account "
      + "deployment, which is not available here - use \"Manual onboarding\" below.",
  },
  // 🔴 这个键漏加过一次，页面上直接印出 "admin.accounts.noOneClick" 原文。
  //    `t()` 找不到键就返回键名本身 —— 不抛、不告警，而 scripts/lint_i18n.py
  //    只查 core/i18n.py（Python 侧），压根不查这个文件。已在那个脚本里补上
  //    前端键的存在性检查。
  "admin.accounts.noOneClick": {
    // 🔴 **必须带上那条具体命令。** 改这段文案时我一度只写了「以多账号模式
    //    部署」，把 `./setup.sh --multi-account` 丢了 —— 而运维看到「需要多账号
    //    模式」之后的第一个问题就是「怎么开」。老那句
    //    （`admin.accounts.orgDisabled`，已删）是有命令的，这是可操作性的退步。
    //
    // ⚠️ 老那句还有半句「非组织场景请在目标账号手动部署
    //    infra/member-account-onboarding.yaml」—— 那句**现在是错的**：
    //    采集角色已经合并进 member-devops-agent.yaml，手动接入只部署一个栈，
    //    而且那条路有 UI 入口（下面那个折叠区），不需要人去翻仓库里的 yaml。
    zh: "一键接入不可用 —— 它要 CloudFormation StackSets，只有组织管理账号"
      + "（或 StackSets 委派管理员）以多账号模式部署才有。"
      + "要启用：在组织管理账号上重新部署一次 `./setup.sh --multi-account`。\n"
      + "不想动部署的话用下面的「手动接入账号」：生成一条 CloudFormation 链接，"
      + "让账号所有者在自己账号里点一下部署，回填两个值即可 —— "
      + "不需要任何组织权限，也不需要重新部署。",
    en: "One-click onboarding is unavailable - it needs CloudFormation StackSets, "
      + "which requires a multi-account deployment from the organization "
      + "management account (or a StackSets delegated admin). "
      + "To enable it, redeploy with `./setup.sh --multi-account` from the "
      + "management account.\n"
      + "If you would rather not touch the deployment, use \"Manual onboarding\" "
      + "below: we generate a CloudFormation link, the account owner deploys it in "
      + "their own account, and you paste two values back - no organization "
      + "permissions and no redeploy needed.",
  },
  "admin.accounts.srcOneClick": { zh: "一键接入", en: "one-click" },
  "admin.accounts.srcManual": { zh: "手动接入", en: "manual" },
  "admin.accounts.srcOneClickTip": {
    zh: "由 CloudFormation StackSets 下发。下线时成员账号里的栈会被一并删除。",
    en: "Provisioned by CloudFormation StackSets. Offboarding also deletes the "
      + "stack in the member account.",
  },
  "admin.accounts.srcManualTip": {
    zh: "客户在自己账号里部署的 CloudFormation 栈。下线只清本地登记 —— 那个栈"
      + "我们删不了，要账号所有者自己删。",
    en: "A CloudFormation stack the account owner deployed themselves. Offboarding "
      + "only clears our records - we cannot delete that stack, the owner must.",
  },
  "admin.accounts.offboardManualWarn": {
    zh: "⚠️ 这是手动接入的账号：下线只会清掉我们这边的登记。目标账号里的 "
      + "CloudFormation 栈（Agent Space + IAM 角色）我们删不了，要账号所有者"
      + "自己去删 —— Agent Space 是计费资源。",
    en: "WARNING this account was onboarded manually: offboarding only clears our "
      + "records. We cannot delete the CloudFormation stack in the target account "
      + "(agent space + IAM roles) - the account owner must. An agent space is a "
      + "billed resource.",
  },
  "admin.accounts.offboardRetained": {
    zh: "已清除登记。请让账号所有者在目标账号删除这个 CloudFormation 栈：",
    en: "Records cleared. Ask the account owner to delete this CloudFormation "
      + "stack in the target account:",
  },
  "admin.accounts.noOrgList": {
    zh: "读不到组织账号列表（当前身份没有 organizations:ListAccounts —— partner-resold 或 linked account 部署时是正常的）。所以上面只显示已接入的账号，加新账号请用下面的「手动接入账号」输入账号 ID。",
    en: "Cannot list organization accounts (this identity lacks organizations:ListAccounts — normal for partner-resold or linked-account deployments). Only onboarded accounts are listed above; add new ones by account ID via Manual onboarding below.",
  },
  "admin.accounts.disableBtn": { zh: "停用", en: "Disable" },
  "admin.accounts.enableBtn": { zh: "启用", en: "Enable" },
  "admin.accounts.offboardBtn": { zh: "下线", en: "Offboard" },
  "admin.accounts.stOffboarding": { zh: "下线中…", en: "Offboarding…" },
  "notif.eos.in90riskShort": { zh: "90 天内到期", en: "due in 90d" },
  "notif.eos.orgTable": { zh: "按账号风险分布（点击下钻）", en: "Risk by account (click to drill down)" },
  "notif.eos.pastEol": { zh: "已过期", en: "past EOL" },
  "notif.eos.unavail": { zh: "不可用", en: "unavailable" },
  "notif.sched.allAccounts": { zh: "全部账号", en: "All accounts" },
  "notif.summary.byAccount": { zh: "按账号分布（点击下钻）", en: "By account (click to drill down)" },
  "notif.acct.org": { zh: "全组织（汇总视图）", en: "Whole org (aggregate)" },
  "notif.acct.orgScope": { zh: "全组织", en: "Organization-wide" },
  "notif.acct.deployScope": { zh: "部署账号", en: "Deployment account" },
  "notif.summary.openEvents": { zh: "个进行中事件", en: "open events" },
  "notif.summary.widest": { zh: "影响面最大", en: "Widest impact" },
  "admin.accounts.daStep2": { zh: "第二步: DevOps Agent", en: "Step 2: DevOps Agent" },
  "admin.accounts.daEnabled": { zh: "调查能力已启用", en: "Investigations enabled" },
  "admin.accounts.daPending": { zh: "关联进行中", en: "Association in progress" },
  "admin.accounts.daMissing": { zh: "未关联（无法对该账号发起深度调查）", en: "Not associated (deep investigations unavailable)" },
  "admin.accounts.daGuideBtn": { zh: "一键关联", en: "Associate" },
  "admin.accounts.daAssociating": { zh: "关联中（建 Agent Space）…", en: "Associating (creating agent space)…" },
  "admin.accounts.daGuideTip": { zh: "数据采集已就绪；深度调查还需在 Idle 控制台完成「DevOps Agent 账户」4 步向导（生成模板 → 成员账号部署 → 回填 → 启用）", en: "Data collection is ready; deep investigations also require the 4-step DevOps Agent wizard in the Idle console (generate template → deploy in member account → paste payload → enable)" },
  "admin.accounts.offboardConfirm": { zh: "下线将删除该账号内的采集角色与事件转发（StackSet 实例），并从登记中移除。再次输入账号 ID 确认：", en: "Offboarding deletes the collection role and event forwarding (StackSet instances) in that account and removes the registration. Re-type the account ID to confirm:" },
  "admin.eol.hint": { zh: "手动覆盖资源版本的 EOS 日期（优先级最高）。RDS/EKS 默认走实时 API，其余服务走内置表——此处覆盖对所有服务生效。日期格式 YYYY-MM-DD。", en: "Manually override a version's EOS date (highest priority). RDS/EKS use live APIs by default, others use the built-in table — overrides here apply to all services. Date format YYYY-MM-DD." },
  "admin.eol.service": { zh: "服务", en: "Service" },
  "admin.eol.version": { zh: "版本标识", en: "Version key" },
  "admin.eol.date": { zh: "EOS 日期", en: "EOS date" },
  "admin.eol.default": { zh: "内置默认", en: "built-in default" },
  "admin.eol.overridden": { zh: "已覆盖", en: "overridden" },
  "admin.eol.add": { zh: "添加覆盖", en: "Add override" },
  "admin.eol.save": { zh: "保存覆盖", en: "Save overrides" },
  "admin.eol.saved": { zh: "已保存", en: "Saved" },
  "admin.eol.remove": { zh: "移除覆盖", en: "Remove override" },
  "admin.eol.newService": { zh: "服务（如 lambda / rds / eks）", en: "Service (e.g. lambda / rds / eks)" },
  "admin.eol.empty": { zh: "暂无覆盖。下方可添加，或参考内置默认。", en: "No overrides yet. Add below, or see built-in defaults." },
  "admin.eol.tableAsOf": { zh: "内置表更新于", en: "Built-in table as of" },
  "admin.groups.hint": { zh: "把 Cognito 组映射到角色：组内成员自动获得这些角色的权限（与逐人分配的角色取并集）。适合大规模统一配置。", en: "Map Cognito groups to roles — members inherit those roles' permissions (union with individually-assigned roles). Ideal for managing many users at once." },
  "admin.groups.roles": { zh: "映射到角色", en: "Mapped roles" },
  "admin.groups.save": { zh: "保存映射", en: "Save mapping" },
  "admin.groups.saved": { zh: "已保存", en: "Saved" },
  "admin.groups.empty": { zh: "用户池暂无 Cognito 组。可在 Cognito 控制台创建组后在此映射。", en: "No Cognito groups in the pool yet. Create groups in the Cognito console, then map them here." },
  "admin.groups.new": { zh: "新建组", en: "New group" },
  "admin.groups.name": { zh: "组名", en: "Group name" },
  "admin.groups.desc": { zh: "描述（可选）", en: "Description (optional)" },
  "admin.groups.delete": { zh: "删除组", en: "Delete group" },
  "admin.groups.protected": { zh: "内置组，不可删除", en: "Built-in group, cannot delete" },
  "admin.groups.members": { zh: "成员", en: "Members" },
  "admin.groups.manageMembers": { zh: "管理成员", en: "Manage members" },
  "admin.groups.addMember": { zh: "添加成员", en: "Add member" },
  "admin.groups.pickUser": { zh: "选择用户…", en: "Select user…" },
  "admin.groups.noMembers": { zh: "暂无成员", en: "No members yet" },
  "admin.groups.defaultTag": { zh: "默认映射", en: "default" },
  "admin.confirm.deleteGroup": { zh: "确认删除组「{name}」？组内成员将失去该组带来的权限。", en: "Delete group \"{name}\"? Members will lose permissions granted by this group." },
  "admin.loading": { zh: "加载中…", en: "Loading…" },
  "admin.error": { zh: "操作失败", en: "Action failed" },
  "admin.roles.new": { zh: "新建角色", en: "New role" },
  "admin.roles.name": { zh: "角色名", en: "Role name" },
  "admin.roles.save": { zh: "保存角色", en: "Save role" },
  "admin.roles.delete": { zh: "删除", en: "Delete" },
  "admin.roles.preset": { zh: "预置", en: "Preset" },
  "admin.roles.perms": { zh: "权限（勾选到 subtab / dashboard 级）", en: "Permissions (down to subtab / dashboard)" },
  "admin.roles.whole": { zh: "整个", en: "Entire" },
  "admin.roles.saved": { zh: "已保存", en: "Saved" },
  "admin.roles.adminReadonly": { zh: "内置超级管理员角色，权限为全部（*），不可编辑。", en: "Built-in super-admin role — full access (*), not editable." },
  "admin.roles.inuse": { zh: "角色被 {n} 个用户使用，无法删除", en: "Role is used by {n} user(s), cannot delete" },
  "admin.users.roles": { zh: "角色", en: "Roles" },
  "admin.users.denies": { zh: "显式屏蔽（权限键，逗号分隔）", en: "Denies (permission keys, comma-separated)" },
  "admin.users.save": { zh: "保存", en: "Save" },
  "admin.users.saved": { zh: "已保存", en: "Saved" },
  "admin.modules.hint": { zh: "关闭的模块对所有用户隐藏（模块开关优先于个人权限）。", en: "Disabled modules are hidden for everyone (module toggle overrides individual permissions)." },
  "admin.modules.enabled": { zh: "已启用", en: "Enabled" },
  "admin.modules.disabled": { zh: "已停用", en: "Disabled" },
  "admin.confirm.deleteRole": { zh: "确认删除角色「{name}」？此操作不可撤销。", en: "Delete role \"{name}\"? This cannot be undone." },
  "admin.confirm.deleteUser": { zh: "确认删除用户「{name}」？该用户将无法再登录。", en: "Delete user \"{name}\"? They will no longer be able to sign in." },
  "admin.users.count": { zh: "共 {n} 个用户", en: "{n} user(s)" },
  "admin.users.new": { zh: "新建用户", en: "New user" },
  "admin.users.username": { zh: "用户名", en: "Username" },
  "admin.users.email": { zh: "邮箱（可选）", en: "Email (optional)" },
  "admin.users.create": { zh: "创建", en: "Create" },
  "admin.users.delete": { zh: "删除", en: "Delete" },
  "admin.users.search": { zh: "搜索用户名…", en: "Search username…" },
  "admin.users.copy": { zh: "复制", en: "Copy" },
  "admin.users.tempPwNote": { zh: "临时密码（仅显示一次，请转告用户；首次登录需改密）：", en: "Temporary password (shown once — share with the user; must change on first login):" },
  "admin.users.created": { zh: "已创建用户「{name}」", en: "User \"{name}\" created" },
  "admin.users.selected": { zh: "已选 {n} 个", en: "{n} selected" },
  "admin.users.bulkRole": { zh: "选择角色…", en: "Select role…" },
  "admin.users.bulkAdd": { zh: "批量赋予", en: "Add to selected" },
  "admin.users.bulkRemove": { zh: "批量移除", en: "Remove from selected" },
  "admin.users.bulkDone": { zh: "批量完成（{n} 个用户）", en: "Done ({n} users)" },
  "admin.users.selectAll": { zh: "全选（当前筛选）", en: "Select all (filtered)" },
  "admin.subtitle": { zh: "管理角色、用户、组映射与模块开关", en: "Manage roles, users, group mapping and module toggles" },
  "admin.title": { zh: "管理控制台", en: "Admin Console" },
  "admin.roles.listTitle": { zh: "角色", en: "Roles" },
  "admin.roles.pick": { zh: "从左侧选择一个角色来编辑权限", en: "Select a role on the left to edit its permissions" },
  "admin.roles.groupTip": { zh: "勾选 / 取消该组全部卡片", en: "Toggle all cards in this group" },
  "admin.users.createTitle": { zh: "新建用户", en: "Create user" },
  "admin.users.status.confirmed": { zh: "已激活", en: "Active" },
  "admin.users.status.forceChange": { zh: "待改密", en: "Pending password" },
  "admin.users.status.resetRequired": { zh: "需重置", en: "Reset required" },
  "admin.users.status.unconfirmed": { zh: "未确认", en: "Unconfirmed" },
  "admin.users.status.archived": { zh: "已归档", en: "Archived" },
  "admin.role.admin": { zh: "管理员", en: "Administrator" },
  "admin.role.viewer": { zh: "只读查看", en: "Viewer" },
  "admin.role.finops": { zh: "FinOps", en: "FinOps" },
  "admin.role.support": { zh: "支持/运维", en: "Support / Ops" },
  "admin.role.developer": { zh: "开发者", en: "Developer" },
  "admin.role.serviceManager": { zh: "服务经理", en: "Service manager" },
  "admin.role.notifications": { zh: "通知", en: "Notifications" },
  "admin.users.roleFilter": { zh: "过滤角色…", en: "Filter roles…" },
  "admin.group.admin": { zh: "管理员组", en: "Administrators" },
  "admin.group.member": { zh: "成员", en: "Members" },
  "admin.group.finops-team": { zh: "FinOps 团队", en: "FinOps team" },
  "admin.group.sre-ops": { zh: "SRE / 运维", en: "SRE / Ops" },
  "admin.group.support-lead": { zh: "支持负责人", en: "Support lead" },
  "admin.group.service-manager": { zh: "服务经理", en: "Service manager" },
  "admin.group.read-only": { zh: "只读", en: "Read-only" },
  "admin.group.dev-team": { zh: "开发团队", en: "Dev team" },
  "nav.customize": { zh: "定制", en: "Customize" },
  "nav.more": { zh: "更多", en: "More" },
  // 通知（主动观察 push）
  "topic.notifications": { zh: "通知", en: "Notifications" },
  "notif.title": { zh: "通知", en: "Notifications" },
  "notif.subtitle": {
    zh: "AWS 事件主动通知",
    en: "Proactive AWS event alerts",
  },
  "notif.markAllRead": { zh: "全部标记已读", en: "Mark all read" },
  "notif.refresh": { zh: "刷新", en: "Refresh" },
  "notif.investigate": { zh: "深入调查", en: "Investigate" },
  "notif.ask": { zh: "就此提问", en: "Ask about this" },
  "notif.console": { zh: "控制台", en: "Console" },
  "notif.filter.all": { zh: "全部", en: "All" },
  "notif.filter.unread": { zh: "未读", en: "Unread" },
  "notif.new": { zh: "新", en: "NEW" },
  "notif.sev.critical": { zh: "严重", en: "Critical" },
  "notif.sev.warn": { zh: "警告", en: "Warning" },
  "notif.sev.info": { zh: "信息", en: "Info" },
  "notif.toast": { zh: "条新通知", en: "new notification(s)" },
  // Health Dashboard 区块
  "notif.health.title": { zh: "AWS Health Dashboard", en: "AWS Health Dashboard" },
  "notif.health.serviceHealth": { zh: "服务运行状况", en: "Service health" },
  "notif.health.accountHealth": { zh: "您的账户运行状况", en: "Your account health" },
  "notif.health.openIssues": { zh: "尚未处理和最近的问题", en: "Open and recent issues" },
  "notif.health.scheduledChanges": { zh: "计划的更改", en: "Scheduled changes" },
  "notif.health.statusHistory": { zh: "状态历史", en: "Status history" },
  "notif.health.otherNotifications": { zh: "其他通知", en: "Other notifications" },
  "notif.health.eventLog": { zh: "事件日志", en: "Event log" },
  "notif.health.noIssues": { zh: "最近没有问题", en: "No recent issues" },
  "notif.health.noScheduled": { zh: "无计划的更改", en: "No scheduled changes" },
  "notif.health.viewList": { zh: "列表", en: "List" },
  "notif.health.viewTimeline": { zh: "时间轴", en: "Timeline" },
  "notif.health.viewCalendar": { zh: "日历", en: "Calendar" },
  "notif.sched.window7": { zh: "未来 7 天", en: "Next 7 days" },
  "notif.sched.window30": { zh: "未来 30 天", en: "Next 30 days" },
  "notif.sched.window60": { zh: "未来 60 天", en: "Next 60 days" },
  "notif.sched.changes": { zh: "项变更", en: "changes" },
  "notif.eos.title": { zh: "生命周期 / EOS", en: "Lifecycle / EOS" },
  "notif.eos.past": { zh: "已过期 EOS", en: "Past EOS" },
  "notif.eos.in7": { zh: "7 天内到期", en: "EOS ≤7 days" },
  "notif.eos.in30": { zh: "30 天内到期", en: "EOS ≤30 days" },
  "notif.eos.in90": { zh: "90 天内到期", en: "EOS ≤90 days" },
  "notif.eos.supported": { zh: "受支持比例", en: "Supported ratio" },
  "notif.eos.byService": { zh: "按服务（风险/总）", en: "By service (risk/total)" },
  "notif.eos.upcoming": { zh: "即将到期（90 天内）", en: "Upcoming (≤90 days)" },
  "notif.eos.none": { zh: "未发现即将 EOS 的资源", en: "No resources approaching EOS" },
  "notif.eos.resources": { zh: "项资源", en: "resources" },
  "notif.eos.daysLeft": { zh: "剩 {n} 天", en: "{n} days left" },
  "notif.eos.overdue": { zh: "已过期 {n} 天", en: "{n} days overdue" },
  "notif.eos.regions": { zh: "已扫描 {n} 个 region", en: "scanned {n} regions" },
  "notif.eos.unavailable": { zh: "EOS 数据不可用（检查 IAM 权限或稍后重试）", en: "EOS data unavailable (check IAM or retry)" },
  "notif.eos.health": { zh: "AWS Health 结束支持通知（权威）", en: "AWS Health end-of-support notices (authoritative)" },
  "notif.health.openConsole": { zh: "在控制台查看", en: "View in console" },
  "notif.health.moreInConsole": { zh: "还有 {n} 条，去控制台查看", en: "{n} more — view in console" },
  "notif.health.windowNote": { zh: "仅显示近 {d} 天；完整历史见控制台", en: "Showing last {d} days; full history in console" },
  "notif.health.unavailable": { zh: "Health Dashboard 需要 Business 或 Enterprise Support 计划。可直接在控制台查看。", en: "Health Dashboard requires a Business or Enterprise Support plan. View directly in the console." },
  "notif.health.otherCount": { zh: "{n} 条其他通知", en: "{n} other notifications" },
  // 事件通知按类型分组(每组对应 core/push_event.py 的一个 normalizer / 一条 EventBridge 规则)
  "notif.evt.cloudwatch": { zh: "CloudWatch 告警", en: "CloudWatch alarms" },
  "notif.evt.cloudwatch.sub": { zh: "告警进入 ALARM 状态时推送", en: "Pushed when an alarm enters ALARM state" },
  "notif.evt.health": { zh: "Health 事件推送", en: "Health event alerts" },
  "notif.evt.health.sub": { zh: "AWS Health 实际影响事件（issue）实时落库；计划变更/账户通知见上方 AWS Health 分组", en: "AWS Health impact events (issues) captured in real time; scheduled changes and account notices are under AWS Health above" },
  "notif.evt.backup": { zh: "AWS Backup", en: "AWS Backup" },
  "notif.evt.backup.sub": { zh: "备份作业失败/状态变化", en: "Backup job failures and state changes" },
  "notif.evt.spot": { zh: "EC2 Spot 中断", en: "EC2 Spot interruptions" },
  "notif.evt.spot.sub": { zh: "Spot 实例回收前两分钟警告", en: "Two-minute Spot instance interruption warnings" },
  "notif.evt.autoscaling": { zh: "Auto Scaling", en: "Auto Scaling" },
  "notif.evt.autoscaling.sub": { zh: "实例启动失败（容量/配额/AMI 等）", en: "Instance launch failures (capacity, quota, AMI, etc.)" },
  "notif.evt.guardduty": { zh: "GuardDuty", en: "GuardDuty" },
  "notif.evt.guardduty.sub": { zh: "威胁检测发现（按严重度阈值过滤）", en: "Threat findings, filtered by severity threshold" },
  "notif.evt.cost": { zh: "成本异常", en: "Cost anomalies" },
  "notif.evt.cost.sub": { zh: "Cost Anomaly Detection 检出的异常支出", en: "Anomalous spend detected by Cost Anomaly Detection" },
  "notif.evt.ta": { zh: "Trusted Advisor", en: "Trusted Advisor" },
  "notif.evt.ta.sub": { zh: "检查项状态变化（按类别过滤）", en: "Check item status changes, filtered by category" },
  "notif.evt.rds": { zh: "RDS 事件", en: "RDS events" },
  "notif.evt.rds.sub": { zh: "数据库实例事件（故障转移/维护/存储等）", en: "DB instance events (failover, maintenance, storage, etc.)" },
  "notif.evt.config": { zh: "Config 合规", en: "Config compliance" },
  "notif.evt.config.sub": { zh: "Config 规则合规状态变化", en: "Config rule compliance changes" },
  "notif.evt.other": { zh: "其他事件", en: "Other events" },
  "notif.evt.other.sub": { zh: "尚未归类的事件源", en: "Event sources not yet categorized" },
  "notif.evt.empty": { zh: "暂无此类事件", en: "No events of this type yet" },
  "notif.evt.emptyOptIn": { zh: "暂无此类事件。该事件源默认关闭，需先启用对应的 EventBridge 规则。", en: "No events of this type yet. This source is off by default — enable its EventBridge rule first." },
  // 默认已开、但还依赖客户侧前置条件的源：空着不代表 NotiOps 没工作，说清要先做什么
  "notif.evt.emptyPrereq.guardduty": { zh: "暂无此类事件。通知已默认开启；若账号尚未启用 GuardDuty，则不会产生任何检测结果。", en: "No events of this type yet. Notifications are on by default; if GuardDuty is not enabled in this account, it produces no findings." },
  "notif.evt.emptyPrereq.cost": { zh: "暂无此类事件。通知已默认开启；需先在 Cost Explorer 创建成本异常监控器，且事件只在 us-east-1 发出。", en: "No events of this type yet. Notifications are on by default; create a Cost Anomaly monitor first, and note these events are only emitted in us-east-1." },
  "notif.evt.emptyPrereq.ta": { zh: "暂无此类事件。通知已默认开启；需 Business/Enterprise 及以上支持计划，且事件只在 us-east-1 发出。", en: "No events of this type yet. Notifications are on by default; requires a Business/Enterprise or higher support plan, and these events are only emitted in us-east-1." },
  // 收件箱被 limit 截断时的如实提示(不静默截断;总数查不到时退化成 Unknown 版本)
  "notif.inbox.truncated": { zh: "显示最新 {n} 条，共 {total} 条", en: "Showing the newest {n} of {total}" },
  "notif.inbox.truncatedUnknown": { zh: "显示最新 {n} 条，还有更早的通知未显示", en: "Showing the newest {n}; older alerts are not shown" },
  // 两层目录左侧子导航分组
  "notif.nav.group.health": { zh: "AWS Health", en: "AWS Health" },
  "notif.nav.group.events": { zh: "事件通知", en: "Event alerts" },
  // 完整通知详情(渐进式加载)
  "notif.detail.show": { zh: "显示完整通知", en: "Show full notification" },
  "notif.detail.hide": { zh: "收起", en: "Collapse" },
  "notif.detail.loading": { zh: "加载详情…", en: "Loading details…" },
  "notif.detail.start": { zh: "开始时间", en: "Start time" },
  "notif.detail.end": { zh: "结束时间", en: "End time" },
  "notif.detail.updated": { zh: "最后更新", en: "Last updated" },
  "notif.detail.affected": { zh: "受影响的资源", en: "Affected resources" },
  "notif.detail.affectedNone": { zh: "无受影响的资源记录", en: "No affected resources recorded" },
  "notif.detail.affectedMore": { zh: "仅显示前 {n} 个，完整列表见控制台", en: "Showing first {n}; full list in console" },
  "notif.detail.description": { zh: "详情", en: "Details" },
  "notif.detail.failed": { zh: "详情加载失败，请重试或去控制台查看。", en: "Failed to load details. Retry or view in console." },
  // Customize 页
  "cz.title": { zh: "定制 NotiOps", en: "Customize NotiOps" },
  "cz.subtitle": {
    zh: "用 Skills、连接器和插件，塑造 NotiOps 为你工作的方式。",
    en: "Skills, connectors, and plugins shape how NotiOps works for you.",
  },
  "cz.nav.skills": { zh: "Skills", en: "Skills" },
  "cz.nav.connectors": { zh: "连接器", en: "Connectors" },
  "cz.nav.plugins": { zh: "插件", en: "Plugins" },
  "cz.skills.title": { zh: "Skills", en: "Skills" },
  "cz.skills.desc": {
    zh: "把你的流程、团队规范和专业知识教给 NotiOps——让它按你的方式做事。",
    en: "Teach NotiOps your processes, team norms, and expertise — so it works your way.",
  },
  "cz.skills.new": { zh: "新建 Skill", en: "Create new skill" },
  "cz.skills.empty": {
    zh: "还没有自定义 Skill。新建一个，把你的专业知识/流程沉淀给 NotiOps。",
    en: "No custom skills yet. Create one to give NotiOps your expertise and processes.",
  },
  "cz.skills.search": { zh: "搜索 Skill（名称 / ID / 说明）…", en: "Search skills (name / ID / description)…" },
  "cz.skills.noMatch": { zh: "没有匹配的 Skill。", en: "No matching skills." },
  "cz.skills.sort.recent": { zh: "最近更新", en: "Recently updated" },
  "cz.skills.sort.name": { zh: "按名称", en: "By name" },
  "cz.skills.group.preset": { zh: "预置 Skills", en: "Preset skills" },
  "cz.skills.group.mine": { zh: "我的 Skills", en: "My skills" },
  "cz.skill.tag.preset": { zh: "预置", en: "Preset" },
  "cz.skill.tag.mine": { zh: "自建", en: "Custom" },
  "cz.skill.edit": { zh: "编辑", en: "Edit" },
  // 发布到 DevOps Agent（世界 B）
  "cz.da.publish": { zh: "发布到 DevOps Agent", en: "Publish to DevOps Agent" },
  "cz.da.published": { zh: "已发布", en: "Published" },
  "cz.da.publishedN": { zh: "已发布 ×{n}", en: "Published ×{n}" },
  "cz.da.publishedTip": { zh: "已发布到 DevOps Agent 的 Agent Space", en: "Published to DevOps Agent's Agent Space" },
  "cz.da.title": { zh: "发布到 DevOps Agent", en: "Publish to DevOps Agent" },
  "cz.da.subtitle": { zh: "把「{name}」作为 skill 装进 DevOps Agent 的 Agent Space", en: "Install “{name}” as a skill in DevOps Agent's Agent Space" },
  // 🔴 必须说清「不影响巡检判读」。这里发布的目标是**排障** Agent Space
  //    （DEVOPS_AGENT_SPACE_ID），而巡检判读用的是另一个专属 space
  //    （INSPECT_AGENT_SPACE_ID）。两个刻意拆开：
  //      · 判读 skill 进排障 space → 客户的深度调查可能误加载它们
  //        （skill 激活是 description 语义匹配，命中并不精确）
  //      · 通用 skill 进巡检 space → 判读被带偏，而判读有严格的输出信封契约
  //        （必须按 `## <finding_id>` 分节），偏了就 parse_failed
  //    不说明的话客户会以为「发布了就会影响巡检结论」，然后为巡检的判读质量
  //    在这里反复发布 skill —— 而那永远不会生效。
  "cz.da.intro": {
    zh: "发布后，DevOps Agent 在做**深度调查**时会按 skill 的描述自动决定是否使用它。仅上传文档（不含脚本），只读边界不受影响。\n\n⚠️ 这里发布的 skill **不影响资源巡检的 AI 判读** —— 巡检用的是另一个专属 Agent Space，它的判读 skill 随代码发布（`inspection/skills/`），刻意与调查隔离，避免互相误激活。",
    en: "Once published, DevOps Agent decides whether to use this skill during DEEP INVESTIGATIONS, based on its description. Documents only (no scripts); the read-only boundary is unaffected.\n\n⚠️ Skills published here do NOT affect resource-inspection AI analysis — inspection uses a separate dedicated Agent Space whose judgement skills ship with the code (`inspection/skills/`), deliberately isolated to avoid cross-activation.",
  },
  "cz.da.noTargets": {
    zh: "暂无可用的 Agent Space。请先在「管理 → 账户」里接入 DevOps Agent。",
    en: "No Agent Space available. Onboard DevOps Agent first under Admin → Accounts.",
  },
  "cz.da.scope.self": { zh: "本账号", en: "This account" },
  "cz.da.scope.cross": { zh: "成员账号", en: "Member account" },
  "cz.da.publishBtn": { zh: "发布", en: "Publish" },
  "cz.da.publishing": { zh: "发布中…", en: "Publishing…" },
  "cz.da.reupload": { zh: "重新发布", en: "Re-publish" },
  "cz.da.remove": { zh: "撤下", en: "Remove" },
  "cz.da.state.published": { zh: "已发布", en: "Published" },
  "cz.da.confirmRemove": { zh: "从「{name}」撤下这个 skill？", en: "Remove this skill from “{name}”?" },
  "cz.da.close": { zh: "关闭", en: "Close" },
  "cz.soon": { zh: "即将上线", en: "Coming soon" },
  "cz.connectors.desc": {
    zh: "连接你已在用的工具，让 NotiOps 读写它们（即将上线）。",
    en: "Connect the tools you already use so NotiOps can read and write to them (coming soon).",
  },
  "cz.plugins.desc": {
    zh: "为你的领域添加预置知识包（即将上线）。",
    en: "Add pre-built knowledge packs for your field (coming soon).",
  },
  "cz.skill.name": { zh: "名称", en: "Name" },
  "cz.skill.namePh": { zh: "如：我们团队的发布流程", en: "e.g. Our team's release process" },
  "cz.skill.desc": { zh: "说明（何时使用）", en: "Description (when to use)" },
  "cz.skill.descPh": { zh: "一句话说明这个 Skill 适用的场景", en: "One line on when this skill applies" },
  "cz.skill.body": { zh: "内容（流程 / 规范 / 知识）", en: "Content (process / norms / knowledge)" },
  "cz.skill.bodyPh": { zh: "用 Markdown 写清楚步骤、规范或专业知识…", en: "Write the steps, norms, or expertise in Markdown…" },
  // Composer：开了「深度调查」（经我们的 agent 转交 DevOps Agent）但选中的 skill 尚未发布到
  // DevOps Agent 时的行内提示 —— 那条路径不传正文，未发布就真的不会被激活。
  "composer.skill.notPublished": {
    zh: "该 Skill 尚未发布到 DevOps Agent，深度调查时不会被激活。到左侧「Skills」里发布后即可生效。",
    en: "This skill isn't published to DevOps Agent yet, so it won't be activated in deep investigation. Publish it from the Skills tab in the sidebar to enable.",
  },
  // 两条**直连**路径（「深度调查（直连）」/「DevOps 对话」）：BFF 会把 skill 正文内联进发给
  // DevOps Agent 的那段话（bff/web-chat/devops_skill.mjs），所以未发布也生效 —— 不能套用上面
  // 那句「不会被激活」。这里如实说清：谁在执行、无需发布、以及唯一的缺口（references/ 取不到）。
  "composer.skill.directInline": {
    zh: "该 Skill 的正文会随本轮内联发给 DevOps Agent 执行，无需发布；若它附带 references/ 参考文件，那部分在这条路径上取不到。",
    en: "This skill's body is inlined into what we send DevOps Agent this turn, so publishing isn't required; if it ships references/ files, those aren't reachable on this path.",
  },
  "cz.skill.save": { zh: "保存", en: "Save" },
  "cz.skill.cancel": { zh: "取消", en: "Cancel" },
  "cz.skill.delete": { zh: "删除", en: "Delete" },
  "cz.skill.id": { zh: "Skill ID（唯一，用于 /命令）", en: "Skill ID (unique, for /command)" },
  "cz.skill.idPh": { zh: "如 rds-health-check（小写字母/数字/连字符）", en: "e.g. rds-health-check (lowercase, digits, hyphens)" },
  "cz.skill.idTaken": { zh: "该 ID 已存在，换一个", en: "This ID already exists — pick another" },
  "cz.skill.idBad": { zh: "ID 只能用小写字母/数字/连字符，2-64 位", en: "ID: lowercase a-z, 0-9, hyphens, 2-64 chars" },
  "cz.skill.upload": { zh: "上传 zip", en: "Upload zip" },
  "cz.skill.uploadHint": { zh: "支持 Claude Skills 格式（含 SKILL.md 的 zip）", en: "Claude Skills format (zip with SKILL.md)" },
  "cz.skill.versions": { zh: "版本历史", en: "Version history" },
  "cz.skill.useVersion": { zh: "用此版本运行", en: "Run with this version" },
  "cz.skill.rollback": { zh: "设为当前版本", en: "Make latest" },
  "cz.skill.latest": { zh: "当前", en: "latest" },
  "cz.skill.importing": { zh: "导入中…", en: "Importing…" },
  "cz.skill.discardConfirm": { zh: "有未保存的修改，确定要离开吗？", en: "You have unsaved changes. Leave anyway?" },
  "cz.skill.importOk": { zh: "已导入", en: "Imported" },
  // 新建 skill 的方式选择器（Create new / Import existing）
  "cz.add.title": { zh: "选择添加 Skill 的方式：", en: "Choose how you want to add a skill:" },
  "cz.add.createGroup": { zh: "新建", en: "CREATE NEW" },
  "cz.add.importGroup": { zh: "导入已有", en: "IMPORT EXISTING" },
  "cz.add.create": { zh: "创建 Skill", en: "Create skill" },
  "cz.add.createDesc": { zh: "填写表单，直接创建一个 Skill", en: "Fill out a form to create a skill directly" },
  "cz.add.upload": { zh: "上传 Skill", en: "Upload skill" },
  "cz.add.uploadDesc": { zh: "上传含 SKILL.md 及附属资源的 zip 文件", en: "Upload a zip file with SKILL.md and additional resources" },
  // 上传对话框
  "cz.up.title": { zh: "上传 Skill", en: "Upload skill" },
  "cz.up.subtitle": {
    zh: "帮助 NotiOps 理解何时使用这个 Skill。请具体说明它适用的场景、应用或要解决的问题。",
    en: "Help NotiOps understand when to use this skill. Be specific about the scenarios, applications, or problems it addresses.",
  },
  "cz.up.intro": {
    zh: "上传一个包含你 Skill 的 zip 文件。zip 中必须包含一个 SKILL.md 文件，且 frontmatter 里带有 name 与 description。",
    en: "Upload a zip file containing your skill. The zip must include a SKILL.md file with name and description in the frontmatter.",
  },
  "cz.up.drop": { zh: "拖拽文件到此处，或点击浏览", en: "Drag and drop a file here, or click to browse" },
  "cz.up.dropHint": { zh: "仅限 ZIP 文件，最大 6 MB", en: "ZIP files only, max 6 MB" },
  "cz.up.dropActive": { zh: "松手即可上传", en: "Drop to upload" },
  "cz.up.picked": { zh: "已选择", en: "Selected" },
  "cz.up.reqTitle": { zh: "zip 文件要求", en: "Zip file requirements" },
  "cz.up.req1": { zh: "必须包含带 name 和 description 的 SKILL.md 文件", en: "Must contain a SKILL.md file with name and description" },
  "cz.up.req2": { zh: "可包含 references/、assets/ 或其他文件夹", en: "May include references/, assets/, or other folders" },
  "cz.up.req3": { zh: "暂不支持脚本（scripts）", en: "Scripts are not currently supported" },
  "cz.up.cancel": { zh: "取消", en: "Cancel" },
  "cz.up.submit": { zh: "上传", en: "Upload" },
  "cz.up.badType": { zh: "请选择 .zip 文件", en: "Please select a .zip file" },
  "cz.up.tooBig": { zh: "文件超过 6 MB 上限", en: "File exceeds the 6 MB limit" },
  "topic.soon": {
    zh: "「{name}」专属主题页即将上线，敬请期待。当前可用「New chat」聊任意功能。",
    en: "The “{name}” topic page is coming soon. For now use “New chat” for anything.",
  },
  "sidebar.today": { zh: "今天", en: "Today" },
  "sidebar.earlier": { zh: "更早", en: "Earlier" },
  "sidebar.pinned": { zh: "已置顶", en: "Pinned" },
  // 会话分组的一键折叠/展开（仅 ≥2 个非空组时显示）
  "sidebar.collapseAll": { zh: "折叠全部", en: "Collapse all" },
  "sidebar.expandAll": { zh: "展开全部", en: "Expand all" },
  "conv.rename": { zh: "重命名", en: "Rename" },
  "conv.pin": { zh: "置顶会话", en: "Pin chat" },
  "conv.unpin": { zh: "取消置顶", en: "Unpin chat" },
  "conv.delete": { zh: "删除", en: "Delete" },
  "conv.deleteConfirm": { zh: "确定删除这个会话？", en: "Delete this chat?" },
  "conv.menu": { zh: "更多操作", en: "More" },
  "conv.busy": { zh: "正在生成回复…", en: "Generating a response…" },
  "conv.unread": { zh: "有新回复未读", en: "New response — unread" },
  "composer.placeholder": { zh: "给 NotiOps 发消息…（/命令 · $skill）", en: "Message NotiOps… (/command · $skill)" },
  // 开着「DevOps 对话」时的提示语：答话的是客户自己的 DevOps Agent，不是 NotiOps；
  // 这条路径也不走 /命令 与 skill，所以不重复那两个提示。
  "composer.placeholder.devopschat": { zh: "跟 DevOps Agent 对话…", en: "Chat with DevOps Agent…" },
  "chip.investigate": { zh: "调查一个资源", en: "Investigate a resource" },
  "chip.cases": { zh: "我的 Support cases", en: "My Support cases" },
  "chip.cost": { zh: "本月成本异常", en: "This month's cost anomalies" },
  "chip.health": { zh: "RDS 健康巡检", en: "RDS health check" },
  // 通用主题 prompt 池（额外项）
  "chip.g.diff": { zh: "ALB 和 NLB 有什么区别？", en: "What's the difference between ALB and NLB?" },
  "chip.g.save": { zh: "如何降低我的 EC2 成本？", en: "How can I reduce my EC2 costs?" },
  "chip.g.arch": { zh: "设计一个高可用的 Web 应用架构", en: "Design a highly available web app architecture" },
  "chip.g.latest": { zh: "最近 AWS 有什么新发布？", en: "What's new at AWS recently?" },
  // Cases 主题 prompt 池
  "chip.cases.open": { zh: "列出我所有未结的 cases", en: "List all my open cases" },
  "chip.cases.analyze": { zh: "分析我最近的一个 case 并解释", en: "Analyze my latest case and explain it" },
  "chip.cases.bySeverity": { zh: "按严重级别列出我的 cases", en: "List my cases by severity" },
  "chip.cases.draft": { zh: "帮我给某个 case 起草一条回复", en: "Help me draft a reply to a case" },
  "chip.cases.recent": { zh: "最近 30 天我提过哪些 cases？", en: "What cases did I open in the last 30 days?" },
  "chip.cases.summary": { zh: "总结我所有 cases 的整体情况", en: "Summarize the overall status of all my cases" },
  "chip.cases.create": { zh: "帮我创建一个新的 support case", en: "Help me create a new support case" },
  // 故障调查主题 prompt 池
  "chip.inv.resource": { zh: "调查一个资源的当前状态", en: "Investigate a resource's current state" },
  "chip.inv.ec2reboot": { zh: "我的 EC2 实例昨晚是否发生过重启？", en: "Did my EC2 instance reboot last night?" },
  "chip.inv.logs": { zh: "帮我解读这段报错日志", en: "Help me interpret this error log" },
  "chip.inv.connectivity": { zh: "排查 EC2 无法 SSH 连接的原因", en: "Troubleshoot why I can't SSH into my EC2" },
  "chip.inv.cwalarms": { zh: "最近有哪些 CloudWatch 告警触发？", en: "Which CloudWatch alarms fired recently?" },
  "chip.inv.rootcause": { zh: "帮我分析这个故障的可能根因", en: "Analyze the likely root cause of this incident" },
  // FinOps 主题 prompt 池
  "chip.fin.anomaly": { zh: "本月有哪些成本异常？", en: "Any cost anomalies this month?" },
  "chip.fin.topcost": { zh: "哪些服务花费最高？", en: "Which services cost the most?" },
  "chip.fin.savings": { zh: "如何降低我的云成本？", en: "How can I reduce my cloud costs?" },
  "chip.fin.trend": { zh: "最近的成本趋势如何？", en: "What's my recent cost trend?" },
  "chip.fin.ri": { zh: "我适合买预留实例或 Savings Plans 吗？", en: "Should I buy RIs or Savings Plans?" },
  "chip.fin.untagged": { zh: "有哪些未打标签的高成本资源？", en: "Any high-cost untagged resources?" },
  // 安全主题 prompt 池
  "chip.sec.findings": { zh: "我有哪些安全风险发现？", en: "What security findings do I have?" },
  "chip.sec.publics3": { zh: "有哪些 S3 桶是公开可访问的？", en: "Which S3 buckets are publicly accessible?" },
  "chip.sec.opensg": { zh: "有哪些安全组对 0.0.0.0/0 开放？", en: "Which security groups are open to 0.0.0.0/0?" },
  "chip.sec.iamreview": { zh: "帮我审查 IAM 权限风险", en: "Review my IAM permission risks" },
  "chip.sec.mfa": { zh: "哪些 IAM 用户没有启用 MFA？", en: "Which IAM users don't have MFA enabled?" },
  "chip.sec.bestpractice": { zh: "云安全最佳实践有哪些？", en: "What are cloud security best practices?" },
  // What's New 主题 prompt 池
  "chip.wn.recent": { zh: "最近 3 天 AWS 有哪些新发布？", en: "What did AWS launch in the last 3 days?" },
  "chip.wn.mine": { zh: "最近有哪些和我账号在用服务相关的发布？", en: "Recent launches relevant to my account's services?" },
  "chip.wn.digest": { zh: "给我本周 AWS 新发布摘要", en: "Give me this week's AWS What's New digest" },
  "chip.wn.service": { zh: "最近 Bedrock 有什么新功能？", en: "What's new with Bedrock recently?" },
  "chip.wn.ai": { zh: "最近有哪些 AI / 生成式 AI 相关发布？", en: "Any recent AI / generative-AI launches?" },
  "chip.wn.trends": { zh: "当下值得关注的 AWS 重点趋势和旗舰发布有哪些？", en: "Notable AWS trends and flagship launches right now?" },
  "composer.hint": {
    zh: "NotiOps 可能出错，重要结论请核实",
    en: "NotiOps can make mistakes — verify important conclusions",
  },
  // 通用会话选了 DevOps Agent 时的免责声明：答话的不是 NotiOps，主语必须跟着换。
  "composer.hint.devops": {
    zh: "DevOps Agent 可能出错，重要结论请核实",
    en: "DevOps Agent can make mistakes — verify important conclusions",
  },
  "composer.stop": { zh: "停止生成", en: "Stop generating" },
  // "/" 命令菜单
  "cmd.button.hint": { zh: "命令菜单（/）", en: "Command menu (/)" },
  "cmd.typeToFilter": { zh: "输入以筛选…", en: "Type to filter…" },
  "cmd.filterHint": { zh: "输入以筛选", en: "Type to filter" },
  // 命令菜单表头：「技能 (27)」。条数如实写出来 —— 列表是**全部** skill、超出高度靠滚动，
  // 不再随机取 3 个（那让客户以为自己只有 3 个 skill）。
  "cmd.skills.head": { zh: "技能", en: "Skills" },
  "cmd.skills.empty": { zh: "还没有 Skill", en: "No skills yet" },
  "cmd.skills.noMatch": { zh: "没有匹配的 Skill", en: "No matching skill" },
  "cmd.skills.manage": { zh: "管理 Skills", en: "Manage skills" },
  "cmd.skills.add": { zh: "新建 Skill", en: "Add skill" },
  "composer.account.default": { zh: "当前账号（部署账号）", en: "Current account (deployment)" },
  "composer.account.hint": { zh: "选择对哪个 AWS 账号操作", en: "Choose which AWS account to operate on" },
  // 通用对话主页（Codex 式）：居中 logo + 项目化标题 + 随机抽 4 张启动卡片。
  // 每张卡片只有一句话描述，点击即把这句话填入输入框（停留在通用对话，可改写后发送）。
  "home.headline": { zh: "在 NotiOps 里想做点什么？", en: "What should we do in NotiOps?" },
  // 各主题空态主页标题（与通用主页同一视觉，主题化措辞）
  "home.h.finops": { zh: "一起优化你的云成本", en: "Let's optimize your cloud costs" },
  "home.h.cases": { zh: "处理你的 AWS Support 案例", en: "Handle your AWS support cases" },
  "home.h.security": { zh: "看看你的安全态势", en: "Let's review your security posture" },
  "home.h.investigate": { zh: "排查一下你的 AWS 环境", en: "Let's investigate your AWS environment" },
  "home.h.whatsnew": { zh: "看看 AWS 有什么新发布", en: "See what's new at AWS" },
  "home.card.inspect.desc": { zh: "巡检闲置和低利用率资源，列出可优化项", en: "Scan for idle and underused resources and what to trim" },
  "home.card.alarm.desc": { zh: "排查一条 CloudWatch 告警，定位根因", en: "Investigate a CloudWatch alarm and trace the root cause" },
  "home.card.cost.desc": { zh: "分析本月成本异常，找出主要驱动因素", en: "Analyze this month's cost spike and its main drivers" },
  "home.card.security.desc": { zh: "生成一份带优先级的安全态势报告", en: "Generate a prioritized security posture report" },
  "home.card.rds.desc": { zh: "做一次 RDS 健康巡检，找出隐患", en: "Run an RDS health check and surface risks" },
  "home.card.cases.desc": { zh: "看看我的 Support 案例，哪些需要关注", en: "Review my support cases and what needs attention" },
  "home.card.quota.desc": { zh: "检查接近上限的服务配额", en: "Check service quotas approaching their limits" },
  "home.card.savings.desc": { zh: "评估 SP/RI 覆盖率和节省空间", en: "Assess Savings Plan / RI coverage and savings" },
  "home.card.whatsnew.desc": { zh: "看看和我相关的 AWS 最新发布", en: "See recent AWS What's New relevant to me" },
  "home.card.publics3.desc": { zh: "找出公网可访问的 S3 桶和开放安全组", en: "Find public S3 buckets and open security groups" },
  "home.card.untagged.desc": { zh: "找出未打标签的资源并归类", en: "Find and group untagged resources" },
  "home.card.arch.desc": { zh: "帮我设计一个高可用的应用架构", en: "Help me design a highly available application architecture" },
  // ── 「对话对象」选择（只在通用会话的新对话主页出现）────────────────────────────
  // 选谁来答这个会话：NotiOps 自己的 agent，还是客户自己的 DevOps Agent（我们侧 0 token）。
  // 可跳过（直接打字 = 默认 NotiOps）；发出第一句后本会话的对象**固定**，不再中途切换。
  // obj.caption 现在**只做 radiogroup 的 aria-label**（读屏用），界面上不显示（产品要求）。
  "obj.caption": {
    zh: "选择这个会话由谁来回答（可跳过，默认 NotiOps；发出第一句后本会话就固定了）",
    en: "Pick who answers this conversation (optional — defaults to NotiOps; locked once you send the first message)",
  },
  // 分段控件上只放两个名字（选中态靠填充表达，不写"已选"）。
  "obj.notiops.name": { zh: "NotiOps", en: "NotiOps" },
  "obj.devops.name": { zh: "DevOps Agent", en: "DevOps Agent" },
  // 控件下面那一行提示：说两边**擅长的事**有什么不同，不解释内部机制（谁调谁、谁扣 token）——
  // 客户在这一步要做的判断是"我这个问题该问谁"，不是"计费怎么走"。
  "obj.notiops.hint": {
    zh: "全局视角 · 巡检、调查、案例与知识库",
    en: "The wider view · inspection, investigation, cases and knowledge",
  },
  // 「免模型配置」是这条路径**对客户最实际的一句好处**（产品指定要写）：答话的是他自己的
  // DevOps Agent，所以不需要在 Bedrock 开通/挑选任何模型 —— 一个还没开通模型的新部署，
  // 选这边就能直接开始用。说"免模型配置"而不是"0 token / 不经我们的模型"：后者是机制，
  // 前者才是他这一步要判断的事。
  "obj.devops.hint": {
    zh: "深入现场 · 实时排查，免模型配置",
    en: "On the ground · live diagnostics, no model setup",
  },
  // 标题栏的「对话对象」tag：通用会话没有主题 tag，而"谁在答"恰恰是这类会话唯一会变的东西。
  // 锁定后**只靠这个 tag** 说明身份（输入框上方那条身份条已按产品要求去掉）。
  "obj.tag.notiops": { zh: "NotiOps", en: "NotiOps" },
  "obj.tag.devops": { zh: "DevOps Agent", en: "DevOps Agent" },
  "obj.tag.notiops.hint": {
    zh: "本会话由 NotiOps 的 agent 回答",
    en: "This conversation is answered by the NotiOps agent",
  },
  "obj.tag.devops.hint": {
    zh: "本会话由你自己的 DevOps Agent 回答",
    en: "This conversation is answered by your own DevOps Agent",
  },
  // 选中 DevOps Agent 时的启动卡片：与 NotiOps 那 4 张分开 —— 这条路径不做成本/案例/Skills，
  // 用它们当引导会把客户带到一条答不了的问题上。
  "obj.dv.card.anomaly": { zh: "这个账号最近有什么异常？", en: "Any anomalies in this account recently?" },
  "obj.dv.card.ec2": { zh: "帮我看看这台 EC2 为什么重启了", en: "Help me find out why this EC2 instance rebooted" },
  "obj.dv.card.rds": { zh: "我的 RDS 现在健康吗？", en: "Is my RDS healthy right now?" },
  "obj.dv.card.change": { zh: "最近有哪些变更可能影响可用性？", en: "Which recent changes could affect availability?" },
  "recents.title": { zh: "该主题下的会话", en: "Conversations in this topic" },
  // 简化、合并后的说明（仅有会话列表时显示）
  "recents.note.basic": {
    zh: "会话保留近 30 天",
    en: "Conversations kept for 30 days",
  },
  "recents.note.more": {
    zh: "显示最近 {shown} 个 · 会话保留近 30 天",
    en: "Latest {shown} shown · conversations kept for 30 days",
  },
  "composer.websearch": { zh: "联网搜索", en: "Web search" },
  // 短标签(composer 按钮省空间用;完整名走 tooltip/hint)
  "composer.websearch.short": { zh: "联网", en: "Web" },
  "composer.finops.short": { zh: "FinOps", en: "FinOps" },
  "composer.devops.short": { zh: "深度调查", en: "Deep Dive" },
  "composer.devops.direct.short": { zh: "深度调查（直连）", en: "Deep Dive (Direct)" },
  "composer.devopschat.short": { zh: "DevOps 对话", en: "DevOps Chat" },
  "composer.websearch.hint": {
    zh: "开启后可联网查最新信息（默认走 AWS AgentCore 搜索，数据不出 AWS）",
    en: "Search the web for current info when on (uses AWS AgentCore search by default; data stays in AWS)",
  },
  "composer.finops": { zh: "FinOps Agent", en: "FinOps Agent" },
  "composer.devops": { zh: "DevOps Agent", en: "DevOps Agent" },
  "composer.devops.hint": {
    zh: "开启 DevOps Agent 深度调查（发起多信号根因排查，耗时几分钟；关闭时用只读工具即时排查）",
    en: "Enable DevOps Agent deep investigation (multi-signal root-cause; takes minutes. Off = instant read-only triage)",
  },
  "composer.devops.direct": { zh: "DevOps Agent（直连）", en: "DevOps Agent (Direct)" },
  "composer.devops.direct.hint": {
    zh: "同样的 DevOps Agent 深度调查，但绕过大模型直连 API —— 不消耗 token。代价：调查描述按你的原话透传（不做智能改写），也不会先回答概念问题",
    en: "The same DevOps Agent deep investigation, but calls the API directly without an LLM — costs 0 tokens. Trade-off: your wording is passed through as-is (no smart rewrite), and conceptual questions aren't answered first",
  },
  // 「DevOps 对话」：这轮由客户自己的 DevOps Agent 直接回答（不是我们的模型），故 NotiOps 侧 0 token。
  // 文案要说清两件事：谁在答（客户自己的 DevOps Agent）、代价在哪（额度计他自己那边；不挂我们的工具/技能）。
  "composer.devopschat": { zh: "DevOps 对话（直连）", en: "DevOps Chat (Direct)" },
  "composer.devopschat.hint": {
    zh: "直接和你自己的 AWS DevOps Agent 对话（体验与它自己的页面一致，流式输出）——不消耗 NotiOps 的 token、也免模型配置（不需要在 Bedrock 开通模型），用量计入你自己的 DevOps Agent。代价：本轮不挂 NotiOps 的工具与 Skills，需人工确认的动作要去 DevOps Agent 控制台完成",
    en: "Chat directly with your own AWS DevOps Agent (same streaming experience as its own console) — costs no NotiOps tokens and needs no model setup (nothing to enable in Bedrock); usage is billed to your DevOps Agent. Trade-off: NotiOps tools and Skills aren't attached this turn, and any action needing approval must be confirmed in the DevOps Agent console",
  },
  // objMode（通用会话，对象已是客户自己的 DevOps Agent）里那个「深度调查」勾选的说明。
  // 只讲这一轮的行为差别（问答 vs 调查、秒级 vs 几分钟），不重复"直连/0 token"这些机制词 ——
  // 对象已经选定了，机制在选对象那一步就交代过。
  "composer.devops.obj.hint": {
    zh: "勾上后这一轮让它做一次完整的深度调查（多信号根因排查、出报告，通常几分钟）；不勾就是即时问答",
    en: "Have it run a full deep investigation this turn (multi-signal root cause, produces a report, usually minutes); leave it off for instant Q&A",
  },
  "composer.finops.hint": {
    zh: "开启 FinOps Agent 深度分析（更全面的成本归因/优化建议，耗时较长；关闭时走快速成本查询）",
    en: "Enable FinOps Agent deep analysis (richer cost attribution & optimization; takes longer. Off = fast cost lookup)",
  },
  "composer.finops.soon": {
    zh: "FinOps Agent 深度分析即将上线；当前可开启 DevOps Agent 来分析成本与用量",
    en: "FinOps Agent deep analysis coming soon; use DevOps Agent to analyze cost & usage for now",
  },
  "composer.soon": { zh: "即将上线", en: "Soon" },
  // 「回答模式」下拉（ModePicker）—— 原来工具条上四个各自独立的 pill 收成一个控件。
  // 名字取「回答模式」而不是「深度模式」：这一组选的是**谁来答、答到多深**（NotiOps 自己的
  // 模型 / 客户自己的 DevOps Agent / 发起一次完整调查），"深度"只覆盖其中一半。
  "composer.mode.label": { zh: "回答模式", en: "Answer mode" },
  "composer.mode.hint": {
    zh: "选这段对话由谁来答、答到多深（默认由 NotiOps 直接回答）",
    en: "Choose who answers and how deep (default: NotiOps answers directly)",
  },
  "composer.mode.off": { zh: "不启用", en: "Off" },
  "composer.mode.off.desc": {
    zh: "普通对话，由 NotiOps 用你选的模型回答",
    en: "Normal chat, answered by NotiOps with the model you picked",
  },
  // 深度调查不可用（这个部署/这个账号没有 DevOps Agent Agent Space）。开关置灰 + 说清原因与出路，
  // 而不是让用户点开、发一轮、再吃一句 no_local_agent_space / account_not_onboarded。
  "composer.devops.na": { zh: "未接入", en: "N/A" },
  "composer.devops.na.self": {
    zh: "深度调查不可用：本部署账号里没有 AWS DevOps Agent 的 Agent Space。请在本账号创建 Agent Space（或重新部署 NotiOps 让它自动创建）后再用。",
    en: "Deep investigation is unavailable: this deployment account has no AWS DevOps Agent Agent Space. Create one in this account (or redeploy NotiOps, which creates it automatically) and try again.",
  },
  "composer.devops.na.account": {
    zh: "深度调查不可用：所选账号尚未接入 AWS DevOps Agent。请在「管理 → 账户」里给该账号完成 DevOps Agent 接入，或切回部署账号。",
    en: "Deep investigation is unavailable: the selected account isn't onboarded to AWS DevOps Agent. Onboard it under Admin → Accounts, or switch back to the deployment account.",
  },
  // Nova Pro 在成本主题不推荐:它对「大量工具 + 大成本明细结果」处理易超限/失败(输出上限仅 5K),
  // Claude / DeepSeek 更稳。见 D 诊断。
  "model.novaFinopsWarn": { zh: "成本分析不推荐(建议用 Claude / DeepSeek)", en: "Not ideal for cost analysis — use Claude / DeepSeek" },
  "msg.copy": { zh: "复制", en: "Copy" },
  "msg.copied": { zh: "已复制", en: "Copied" },
  "msg.regenerate": { zh: "重新生成", en: "Regenerate" },
  "msg.sources": { zh: "Sources", en: "Sources" },
  "thinking": { zh: "思考中", en: "Thinking" },
  "reasoning.show": { zh: "查看思考过程", en: "Show reasoning" },
  "reasoning.hide": { zh: "隐藏思考过程", en: "Hide reasoning" },
  "model.desc.opus": { zh: "最强推理 · 深度分析/复杂根因 · 经 Bedrock", en: "Most capable · deep analysis & complex RCA · via Bedrock" },
  "model.desc.claude": { zh: "推理与编码均衡 · 全能 · 经 Bedrock", en: "Balanced reasoning & coding · all-rounder · via Bedrock" },
  "model.desc.haiku": { zh: "快速轻量 · 支持提示缓存 · 经 Bedrock", en: "Fast & lightweight · prompt caching · via Bedrock" },
  "model.desc.nova": { zh: "AWS 原生 · 高性价比 · 经 Bedrock", en: "AWS-native · cost-effective · via Bedrock" },
  "model.desc.deepseek": { zh: "强推理 · 通过 Bedrock", en: "Strong reasoning · via Bedrock" },
  "model.desc.gpt": { zh: "OpenAI 旗舰 · 经 Bedrock", en: "OpenAI flagship · via Bedrock" },
  "model.desc.gptSol": { zh: "OpenAI GPT-5.6 Sol · 经 Bedrock", en: "OpenAI GPT-5.6 Sol · via Bedrock" },
  "model.desc.gptLuna": { zh: "OpenAI GPT-5.6 Luna · 经 Bedrock", en: "OpenAI GPT-5.6 Luna · via Bedrock" },
  "model.desc.grok": { zh: "xAI 旗舰 · 500K 上下文 · 长任务/agentic · 经 Bedrock", en: "xAI flagship · 500K context · long-running agentic work · via Bedrock" },
  "model.desc.glm": { zh: "Z.AI 旗舰 · 工具调用强 · 经 Bedrock", en: "Z.AI flagship · strong tool use · via Bedrock" },
  // 管理员手工添加的模型没有 desc_key，用这句通用描述兜底（避免把 i18n key 原样漏到界面上）
  "model.desc.generic": { zh: "由管理员添加 · 经 Bedrock", en: "Added by an administrator · via Bedrock" },
  "model.flag.exp": { zh: "实验", en: "experimental" },
  "login.title": { zh: "登录 NotiOps", en: "Sign in to NotiOps" },
  "login.username": { zh: "用户名", en: "Username" },
  "login.password": { zh: "密码", en: "Password" },
  "login.newPassword": { zh: "设置新密码", en: "Set a new password" },
  "login.submit": { zh: "登录", en: "Sign in" },
  "login.signout": { zh: "退出登录", en: "Sign out" },
  "login.settings": { zh: "设置", en: "Settings" },
  "menu.language": { zh: "语言", en: "Language" },
  "menu.appearance": { zh: "外观", en: "Appearance" },
  "menu.theme.dark": { zh: "深色", en: "Dark" },
  "menu.theme.light": { zh: "浅色", en: "Light" },
  "menu.changelog": { zh: "更新日志", en: "View changelog" },
  "menu.learnmore": { zh: "了解更多", en: "Learn more" },
  "menu.report": { zh: "反馈问题", en: "Report an issue" },
  // hover 提示：说清会跳到哪、要做什么。内网打不开 github.com 时,用户至少
  // 看得到完整 URL,而不是以为按钮坏了。
  "menu.report.hint": {
    zh: "在 GitHub 上提交 issue 反馈问题或提需求 — https://github.com/aws-samples/sample-notiops/issues",
    en: "Report a bug or request a feature on GitHub — https://github.com/aws-samples/sample-notiops/issues",
  },
  "menu.soon": { zh: "即将上线", en: "Coming soon" },
  "sources.empty": { zh: "暂无来源", en: "No sources" },
  "panel.close": { zh: "关闭", en: "Close" },
  // DevOps Agent 后台深链（只有 DevOps 那条过程有；面板本身与普通对话共用同一套文案）
  "inv.panel.console": { zh: "在 DevOps Agent 后台查看", en: "View in DevOps Agent console" },
  // 思考过程面板 —— **所有路径共用**（DevOps Agent 与普通对话必须一致，2026-09-04 客户要求）。
  // 原来 DevOps 那条有自己的 inv.panel.title「调查过程」/ inv.entry「查看调查过程」，已删除。
  "think.panel.title": { zh: "思考过程", en: "Thinking" },
  "think.panel.empty": { zh: "思考与工具调用过程将在这里实时更新…", en: "Reasoning and tool calls will stream here…" },
  "think.panel.live": { zh: "进行中", en: "Live" },
  "think.entry": { zh: "查看思考过程", en: "View thinking" },
  "think.entry.count": { zh: "{n} 步", en: "{n} steps" },
  "think.repeat": { zh: "×{n}", en: "×{n}" },
  "sidebar.collapse": { zh: "收起侧边栏", en: "Collapse sidebar" },
  "sidebar.expand": { zh: "展开侧边栏", en: "Expand sidebar" },
};

export function detectLocale(): Locale {
  // 默认英文显示；仅当用户手动切换过（localStorage 有记录）才用其选择。
  const saved = (() => {
    try {
      return localStorage.getItem("notiops-chat-lang");
    } catch {
      return null;
    }
  })();
  if (saved === "zh" || saved === "en") return saved;
  return "en";
}

export function saveLocale(l: Locale) {
  try {
    localStorage.setItem("notiops-chat-lang", l);
  } catch {
    /* ignore */
  }
}

export const LocaleContext = createContext<{ locale: Locale; setLocale: (l: Locale) => void }>({
  locale: "zh",
  setLocale: () => {},
});

// ── 主题（Appearance）──
// 仅 dark / light 两种，默认 dark，用户可手动切 light。
// （曾做过"跟随系统"，但部分浏览器/环境的 prefers-color-scheme 不反映 OS 暗色、
//  会误报 light，体验不可靠，故移除——默认 Dark 更稳。）
export type Theme = "dark" | "light";
export type ThemePref = Theme; // 不再有 system

/** 读用户保存的偏好（默认 dark）。 */
export function detectThemePref(): ThemePref {
  try {
    const saved = localStorage.getItem("notiops-chat-theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch { /* ignore */ }
  return "dark";
}

/** 偏好 → 生效主题（现在一一对应）。 */
export function resolveTheme(pref: ThemePref): Theme {
  return pref === "light" ? "light" : "dark";
}

export function detectTheme(): Theme {
  return detectThemePref();
}
export function saveThemePref(p: ThemePref) {
  try { localStorage.setItem("notiops-chat-theme", p); } catch { /* ignore */ }
}
export function saveTheme(p: ThemePref) { saveThemePref(p); }

export const ThemeContext = createContext<{ pref: ThemePref; theme: Theme; setPref: (p: ThemePref) => void }>({
  pref: "dark",
  theme: "dark",
  setPref: () => {},
});
export function useTheme() {
  return useContext(ThemeContext);
}

export function useT() {
  const { locale } = useContext(LocaleContext);
  return (key: keyof typeof STRINGS | string) => {
    const entry = STRINGS[key as string];
    return entry ? entry[locale] : (key as string);
  };
}

export function useLocale() {
  return useContext(LocaleContext);
}
