/**
 * 阈值与定时页。
 *
 * ## 与旧版的差别（客户原话：「UI 设计得一塌糊涂」）
 *
 * ```
 * 旧                                     新
 * ─────────────────────────────────    ────────────────────────────────
 * 无 max-width，输入框拉满 1800px        760px 定宽表单，两列
 * auto-fit minmax(190px, 1fr)            label 在上、控件在下（AWS 表单式）
 * 字节裸打印 524288000                    [500] [MB ▾] —— 单位由后端给
 * 30 个字段平铺                           算法类收进「高级」
 * 5 条提示常显                            必读的 3 条常显，其余收进 ⓘ
 * ```
 *
 * ## 三条必须常显、不许收起
 *
 * 这三条的共同点是**误解它们没有任何运行时信号**：
 *
 * ```
 * 「阈值全局共用一份，选服务只是筛选视图」  否则客户以为「我只调了 Redis」
 * 「下一轮生效，不是立刻生效」              否则改完盯着看板等变化
 * 「配置变更会重新计数全部旧 finding」      否则「数字为什么变了」无法解释
 * ```
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type ConfigData, type RuleField, type RuleService, type ScheduleRow,
  isFail, isValidAtUtc, putInspectionRules, putInspectionSchedule,
} from "../../api/inspection";
import { fromDisplayUnit, toDisplayUnit } from "./format";
import {
  Alert, Badge, Btn, Chip, Container, Empty, Expandable, Field, PageHeader, SectionHeading, Status,
} from "./ui";
import { C, FORM_MAXW, inner, input, page } from "./tokens";
import { WEEKDAYS, effectiveWeekdays, weekdaysForSave } from "./weekdays";

/**
 * 补跑窗口的**默认值**，镜像 `inspection/domain/schedule.py::ScheduleConfig`。
 *
 * ⚠️ BFF 的 `SCHEDULE_DEFAULTS.catch_up_hours` 也是 6。三处一致由
 *    `tests/test_inspection_schedule.py` 的元断言锁住（与 `at_utc` 同一套）。
 */
const CATCH_UP_DEFAULT = 6;

/**
 * 这一行**生效**的补跑窗口。
 *
 * 🔴 抽出来是因为「state 的种子」与「`changed` 的基线」必须是**同一个表达**。
 * 各写一遍的表现（我 2026-09-02 就是这样写的，一条既有用例立刻抓到）：
 *
 * ```
 * 字段缺失 → state 种子 = 6，而基线读到 undefined
 *   → `6 !== undefined` 恒真
 *   → 一打开配置页就显示「有未保存的改动」、保存按钮一直亮着
 *   → 而用户什么都没动
 * ```
 *
 * ⚠️ 用 `??` 而不是 `||` —— `0` 是合法值（「错过就不补跑」），
 *    `||` 会把客户显式设的 0 悄悄变回 6。
 */
function effectiveCatchUp(row: { catch_up_hours?: number }): number {
  return row.catch_up_hours ?? CATCH_UP_DEFAULT;
}

/**
 * 收进「高级」的字段。判据是「客户不需要理解算法就能用主界面」。
 *
 * ⚠️ 收起**不等于**不生效。折叠区里有未保存改动时头部要标脏，
 * 否则客户点保存会存进一个他此刻看不到的值。
 */
const ADVANCED: Record<string, readonly string[]> = {
  threshold: ["min_coverage_days", "chronic_days_min", "chronic_min_coverage"],
  idle: ["consecutive_days_step"],
  capacity: ["cpu_max_veto"],
};

const SEC_LABEL: Record<string, string> = {
  threshold: "insp.rules.secThreshold", idle: "insp.rules.secIdle",
  capacity: "insp.rules.secCapacity", structural: "insp.rules.secStructural",
};
const SEC_NOTE: Record<string, string> = {
  threshold: "insp.rules.orNote", idle: "insp.rules.andNote",
};

/** 服务组短名（字段标签里用，全称在筛选器上）。 */
const SERVICE_SHORT: Record<string, { zh: string; en: string }> = {
  rds: { zh: "RDS", en: "RDS" },
  aurora: { zh: "Aurora", en: "Aurora" },
  redis: { zh: "Redis", en: "Redis" },
  memcached: { zh: "Memcached", en: "Memcached" },
};

// ---------------------------------------------------------------------------
// 定时
// ---------------------------------------------------------------------------

/**
 * 一条定时配置。
 *
 * ⚠️ 每张卡自己持 state 而不是提到父组件：两条 run_type 是**独立**保存的
 * （后端一次只写一个 SK），共用一份编辑态会让「改了 high 点保存」
 * 把 idle 的输入框内容也带过去。
 */
/* ⚠️ **导出仅为测试**（同 `AdminPanel.tsx` 的 `AccountsView`）。
      整个 `ConfigPage` 要一份完整的 `ConfigData`（schedules + rules +
      rule_services + data_dates），而这里要验的只有「执行日那七个 chip」——
      构造那份 fixture 的代价全部落在与本断言无关的字段上，
      而 fixture 与真实响应分叉时测试会为了错的理由而绿。 */
export function ScheduleCard({ row, mayWrite, reload, zh, t }: {
  row: ScheduleRow; mayWrite: boolean; reload: () => void;
  zh: boolean; t: (k: string) => string;
}) {
  const [atUtc, setAtUtc] = useState(row.at_utc);
  const [enabled, setEnabled] = useState(row.enabled);
  /**
   * 执行日。**state 里存的是「生效集合」，永远非空。**
   *
   * 🔴 库里的语义是「空 = 每天」（`weekdays` 字段不存在时调度器不做过滤）。
   *    照着库里的值渲染的表现是：一个从没配过 weekdays 的账号，七个 chip
   *    **全灭**，旁边一行小字写「每天」—— 屏幕上说的是「一天都不跑」，
   *    小字说的是「天天跑」，两者矛盾，而正确的那个是小字。
   *
   *    所以这里在**进入组件时就把空展开成七天**：UI 一律显示生效集合，
   *    「空」这个内部表示只活在 `save()` 的那一行里（七天全选 → 传
   *    `undefined`，库里仍然是「没有这个字段」）。
   *
   * ⚠️ 于是「七天全选」与「从没配过」在库里是**同一个东西** —— 这是有意的。
   *    两者的调度行为完全一致，区分它们只会多出一种没人能解释的状态。
   */
  const [wd, setWd] = useState<number[]>(
    row.weekdays && row.weekdays.length > 0 ? row.weekdays : [...WEEKDAYS]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  /**
   * R13.5：下一轮时间由**后端**算并回传。
   *
   * 🔴 前端绝不自己算 —— 这条规则带 weekdays 过滤，而 JS 的 `getUTCDay()`
   * 是 0=周日、调度器的 `isoweekday()` 是 1=周一…7=周日。两份实现分叉的
   * 表现是 UI 显示的时间与实际执行差一天，客户按 UI 等，等不到。
   */
  const [nextRun, setNextRun] = useState(row.next_run_utc ?? "");
  /**
   * 补跑窗口，小时。**`0` = 错过就不跑**。
   *
   * 🔴 这一项此前**完全没有 UI 入口**：后端定义了（`schedule.py` 默认 6）、
   * store 存了、BFF 校验并回传了、前端类型也声明了 —— 唯独没有输入口。
   * 客户既改不了，也看不到当前是 6 还是 0，而 `0` 意味着「错过就彻底不跑
   * 那一轮」，是个有运维后果的值。
   *
   * ⚠️ 判缺失用 `?? `（只兜 null/undefined）而不是 `||` —— `0` 是合法值，
   *    用 `||` 会把客户显式设的 0 悄悄变回 6。
   */
  const [catchUp, setCatchUp] = useState(String(effectiveCatchUp(row)));

  const okAtUtc = isValidAtUtc(atUtc);
  const title = row.run_type === "high" ? t("insp.tab.highLoad") : t("insp.tab.idle");
  const runType = row.run_type === "high" ? "high" : "idle";
  /**
   * 🔴 `changed` 比的是**生效集合**，不是库里的原始值。
   *
   *    直接 `JSON.stringify(wd) !== JSON.stringify(row.weekdays ?? [])` 的表现是：
   *    一个「空 = 每天」的账号打开配置页，`wd` 已经被展开成七天、而
   *    `row.weekdays` 是 `undefined` → `changed` 恒为 true → 保存按钮一直亮着、
   *    一直显示「有未保存的改动」，而用户什么都没动。
   */
  /**
   * 补跑窗口的数值形态。`null` = 填的不是 0~24 的整数。
   *
   * ⚠️ 用 `Number.isInteger` 而不是 `parseInt`：`"6.5"` 被 parseInt 吃成 6，
   *    而后端要的是整数小时 —— 静默取整会让 UI 显示 6.5、库里是 6。
   */
  const catchUpNum = (() => {
    const n = Number(catchUp.trim());
    return catchUp.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 24
      ? n : null;
  })();
  const okCatchUp = catchUpNum !== null;
  const changed = atUtc !== row.at_utc || enabled !== row.enabled
    /* 🔴 比的是**生效值**，不是 `row.catch_up_hours` 原值。
       与 `weekdays` 那条同一个道理（见下面 `changed` 的说明）：字段缺失时
       state 的种子是 6 而原值是 `undefined` → `changed` 恒真 → 一打开页面
       就显示「有未保存的改动」、保存按钮一直亮着，而用户什么都没动。
       有一条用例专门守这个（`weekdaysAndBatchRun.render.test.tsx`）。 */
    || catchUpNum !== effectiveCatchUp(row)
    || JSON.stringify(wd) !== JSON.stringify(effectiveWeekdays(row.weekdays));
  /**
   * 能不能保存。
   *
   * 🔴 `!row.persisted` 也算 —— 那一行用的是**代码默认值**，库里压根没有它。
   * 客户点一次保存是为了把当前值固化下来（这样以后我们改默认值不会
   * 悄悄改变他的巡检时刻）。只按「有没有改动」判会让那个场景做不到，
   * 而它恰恰是 `persisted: false` 那个标记存在的理由。
   */
  const canSave = changed || !row.persisted;

  const save = async () => {
    // 🔴 **第二道防御。** 按钮已经按 `okAtUtc` 灰掉了，但两道都要留：
    //    渲染测试只能验到 disabled 那一道（jsdom 里点 disabled 的按钮压根
    //    不触发 handler），而将来任何人为了「让客户看见报错」把 disabled
    //    去掉，就会把一个永远不被精确命中的时刻写进库 ——
    //    表现是那一类巡检的报告总是慢几分钟，而不是任何报错。
    if (!okAtUtc) { setErr(t("insp.config.atUtcBad")); return; }
    /* 同一条理由的第二道防御：按钮灰了，但谁把 disabled 去掉就会把一个
       越界值发给后端（拿到 400，而客户看到的是「保存失败」而非哪里错了）。 */
    if (catchUpNum === null) {
      setErr(zh ? "补跑窗口需为 0~24 的整数小时"
        : "catch-up window must be an integer 0-24");
      return;
    }
    setBusy(true); setErr(""); setMsg("");
    const r = await putInspectionSchedule(runType, {
      at_utc: atUtc,
      enabled,
      /**
       * 🔴 **七天全选 → 整个字段不传**（= 库里没有 `weekdays`，调度器不过滤）。
       *
       *    `wd` 在 UI 里永远非空（见上面 state 的说明），所以判据不能再是
       *    `wd.length > 0`。落成 `[1,2,3,4,5,6,7]` 与不传的调度行为完全一致，
       *    但会让库里多一个「配过了」的显式值 —— 而下一个人看到它会以为
       *    这是客户刻意逐个勾出来的七天，不敢动。
       */
      weekdays: weekdaysForSave(wd),
      /* ⚠️ 显式带上 —— 不传的话 BFF 会兜底成 6，于是客户设的 0 每次保存
         都会被悄悄改回 6（而界面显示保存成功）。 */
      catch_up_hours: catchUpNum,
    });
    setBusy(false);
    if (isFail(r)) { setErr(r.message || t("insp.act.failed")); return; }
    setMsg(t("insp.act.saved"));
    setNextRun(r.next_run_utc);
    reload();
  };

  /**
   * 🔴 **不许点到零个。**
   *
   *    库里「空 = 每天」，所以点掉最后一天会存成 `undefined` → 变成天天跑。
   *    也就是说用户一路点灭七个 chip，期望是「一天都不跑」，实际拿到的是
   *    「每天都跑」—— 完全相反，而且界面上七个 chip 会在保存后**又全亮回来**。
   *
   *    要停掉这一类巡检的正确入口是上面那个「启用」开关，所以这里拒绝并
   *    指过去，而不是静默忽略这次点击。
   */
  const toggleWd = (d: number) => {
    setErr("");
    if (wd.length === 1 && wd.includes(d)) {
      setErr(t("insp.config.weekdaysMin"));
      return;
    }
    setWd((cur) => cur.includes(d)
      ? cur.filter((x) => x !== d)
      : [...cur, d].sort((a, b) => a - b));
  };

  return (
    <Container style={{ marginBottom: 12 }}
      header={
        <>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{title}</div>
          {/* `persisted: false` = 用的是代码默认值，而巡检**已经在跑**。
              不标出来会让客户以为「还没配所以没跑」，去等一件已经发生的事。 */}
          {!row.persisted && (
            <Badge tone="amber"
              title={zh ? "库里没有这一行，用的是代码默认值 —— 但巡检已经在按它跑"
                        : "not persisted; running on code defaults"}>
              {t("insp.config.notPersisted")}
            </Badge>
          )}
          {!enabled && <Badge tone="red">{zh ? "已停用" : "Disabled"}</Badge>}
          <div style={{ flex: 1 }} />
          {mayWrite && (
            <Btn size="small" variant={canSave ? "primary" : "normal"}
              onClick={save} loading={busy}
              disabledReason={
                !okAtUtc ? t("insp.config.atUtcBad")
                  : !okCatchUp ? (zh ? "补跑窗口需为 0~24 的整数小时"
                    : "catch-up window must be an integer 0-24")
                    : !canSave ? (zh ? "没有改动" : "No changes") : ""}>
              {t("insp.act.save")}
            </Btn>
          )}
        </>
      }>
      <div style={{
        display: "grid", gap: 16, alignItems: "start",
        gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
        maxWidth: FORM_MAXW,
      }}>
        <Field label={t("insp.config.atUtc")}
          error={okAtUtc ? undefined : t("insp.config.atUtcBad")}
          hint={t("insp.config.atUtcHint")}>
          {mayWrite ? (
            <input name={`at_utc_${runType}`} value={atUtc}
              onChange={(e) => setAtUtc(e.target.value)} placeholder="02:00"
              style={{ ...input, borderColor: okAtUtc ? C.line : C.red, width: 110 }} />
          ) : (
            <code style={{ fontSize: 13 }}>{row.at_utc || "—"}</code>
          )}
        </Field>

        <Field label={t("insp.config.enabled")}>
          {mayWrite ? (
            <label style={{
              display: "flex", alignItems: "center", gap: 7, fontSize: 13,
              color: C.text, cursor: "pointer",
            }}>
              <input type="checkbox" name={`enabled_${runType}`} checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)} />
              {enabled ? t("insp.config.enabled") : (zh ? "已停用" : "Disabled")}
            </label>
          ) : (
            <div style={{ fontSize: 13 }}>{row.enabled ? "✓" : "—"}</div>
          )}
        </Field>

        {/* 🔴 补跑窗口。此前**完全没有 UI 入口** —— 后端定义了、store 存了、
            BFF 校验并回传了、前端类型也声明了，唯独客户改不了也看不到。
            而 `0` 意味着「错过配置时刻就彻底不跑那一轮」，是个有运维后果的值。 */}
        <Field label={zh ? "补跑窗口（小时）" : "Catch-up window (h)"}
          error={okCatchUp ? undefined
            : (zh ? "需为 0~24 的整数" : "integer 0-24")}
          hint={zh
            ? (catchUpNum === 0
              ? "0 = 错过配置时刻就不补跑，那一轮直接跳过"
              : `错过配置时刻后，${catchUpNum ?? "?"} 小时内还会补跑一次`)
            : "hours after the scheduled time during which a missed run still fires"}>
          {mayWrite ? (
            <input name={`catch_up_${runType}`} value={catchUp}
              onChange={(e) => setCatchUp(e.target.value)} placeholder="6"
              style={{
                ...input, width: 90,
                borderColor: okCatchUp ? C.line : C.red,
              }} />
          ) : (
            <code style={{ fontSize: 13 }}>{effectiveCatchUp(row)}</code>
          )}
        </Field>

        {/* ⚠️ 不再有「每天」那行小字 —— 七个 chip 全亮**就是**每天，
            而一行与 chip 状态矛盾的小字（全灭 + 「每天」）是这条缺陷本身。 */}
        <Field label={t("insp.config.weekdays")}>
          {mayWrite ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {WEEKDAYS.map((d) => (
                <Chip key={d} active={wd.includes(d)} onClick={() => toggleWd(d)}>
                  {t(`insp.wd.${d}`)}
                </Chip>
              ))}
            </div>
          ) : (
            // 只读态也走同一个换算 —— 两边分叉的表现是有写权限的人和没写权限的
            // 人看同一个账号看到的执行日不一样。
            <div style={{ fontSize: 13 }}>
              {effectiveWeekdays(row.weekdays).map((d) => t(`insp.wd.${d}`)).join(" ")}
            </div>
          )}
        </Field>
      </div>

      {/* 🔴 **停用时不显示时刻。** 原来渲染门只有 `nextRun &&`，完全不看
          `enabled` —— 于是「取消启用 → 保存」的结果是 header 上一个红色
          「已停用」徽章，正下方一条**绿色**「下一轮: 02:00」，两句直接矛盾，
          而 `schedule.py` 的 `if not cfg.enabled: continue` 说明那一轮压根
          不会跑。

          ⚠️ 判据用**本地 `enabled`**（表单当前值）而不是 `row.enabled`：
             取消勾选还没保存时就该立刻收起那个时刻，否则中间那一帧仍在
             承诺一件即将不成立的事。
          ⚠️ 后端也已经在停用时返回空串（`nextRunFor`），这里是第二道 ——
             两道都留：BFF 那道覆盖存量前端，这道覆盖存量 BFF。 */}
      {!enabled ? (
        <div style={{ marginTop: 10 }}>
          <Status type="pending">
            {zh ? "已停用 —— 不会有下一轮" : "Disabled; no next run"}
          </Status>
        </div>
      ) : nextRun ? (
        <div style={{ marginTop: 10 }}>
          <Status type="success">
            {t("insp.config.nextRun")}: <b>{nextRun}</b>
          </Status>
        </div>
      ) : null}
      {msg && <div style={{ marginTop: 8 }}><Status type="success">{msg}</Status></div>}
      {err && <div style={{ marginTop: 8 }}><Status type="error">{err}</Status></div>}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// 阈值字段
// ---------------------------------------------------------------------------

/** 字段的适用服务标签。四个都支持时说「全部服务」，不列四个标签。 */
function ServiceNote({ services, all, zh, t }: {
  services: string[]; all: string[]; zh: boolean; t: (k: string) => string;
}) {
  if (all.length > 0 && services.length >= all.length) {
    return <span style={{ color: C.muted }}>{t("insp.rules.appliesAll")}</span>;
  }
  const names = services.map((s) => SERVICE_SHORT[s]?.[zh ? "zh" : "en"] || s);
  return (
    <span style={{ color: C.blue }}>
      {t("insp.rules.appliesOnly")} {names.join(" · ")}
    </span>
  );
}

/**
 * 一个阈值字段的输入控件。
 *
 * 🔴 范围、默认值、**单位**全部来自后端，前端不写死任何数
 * （`api/inspection.ts:193` 立的规矩）。
 */
function RuleInput({ f, draft, onChange, onReset, onBad, mayWrite, allServices, zh, t }: {
  f: RuleField; draft: number | string[] | null | undefined;
  onChange: (v: number | string[] | undefined) => void;
  /** 恢复默认：把这个 key 标成「删掉」（后端收到 null 就从合并结果里移除）。 */
  onReset: () => void;
  /** 把「这个字段当前越界」告诉父组件 —— 保存按钮要据此禁用。 */
  onBad: (bad: boolean) => void;
  mayWrite: boolean; allServices: string[];
  zh: boolean; t: (k: string) => string;
}) {
  const isSet = f.type === "str_set";
  const units = f.display_units || [];
  // 当前显示单位。⚠️ 切换它**只改显示，不改存储值**。
  const [unit, setUnit] = useState(f.display_unit || "");
  /**
   * 输入框的**字符串**态。
   *
   * 🔴 完全受控 + 「空 → onChange(undefined)」的组合会让输入框在删空的那一刻
   * 弹回旧值：`draft` 删格子 → `cur` 回落 `f.value` → 值又出现了。
   *
   * ```
   * swap_usage_bytes 在 GB 单位下显示 0.048828125
   * 用户全选删除 → 输入框跳回 0.048828125 → 再敲「1」得到 10.048828125
   * str_set 更彻底：标签全删干净 → 立刻恢复原标签，**永远清不空**
   * ```
   *
   * `null` = 用受控值；字符串 = 用户正在编辑（`""` 是合法中间态）。
   */
  const [typing, setTyping] = useState<string | null>(null);

  const isReset = draft === null;
  const cur = (draft === undefined || draft === null) ? f.value : draft;
  const changed = draft !== undefined
    && JSON.stringify(draft) !== JSON.stringify(f.value);

  // 越界即时提示 —— 与后端同一条判据（min/max 就是后端给的）。
  // ⚠️ 判的是**换算回去的原始值**，因为 min/max 是原始量纲。
  const bad = !isReset && !isSet && typeof cur === "number"
    && ((f.min !== null && cur < f.min) || (f.max !== null && cur > f.max));
  // 🔴 上报给父组件。第一版只在这里显示红框，而保存按钮照样是蓝色 primary
  //    → 点下去后端整批拒（putRules 是「有一个不合法就整个拒」）→
  //    客户本次的其他改动一起没存上，而红框看起来只是装饰。
  useEffect(() => { onBad(!!bad); }, [bad, onBad]);

  const shownRaw = (!isSet && typeof cur === "number" && units.length > 0)
    ? toDisplayUnit(cur, units, unit).shown : cur;
  const shown = typing !== null ? typing : shownRaw;

  const fmtDefault = (() => {
    if (Array.isArray(f.default)) return f.default.join(", ");
    if (units.length > 0) {
      const d = toDisplayUnit(f.default as number, units, unit);
      return `${Number(d.shown.toFixed(4))} ${d.unit}`;
    }
    return `${f.default}${f.unit ? " " + f.unit : ""}`;
  })();

  const label = (
    <>
      {zh ? f.label_zh : f.label_en}
      {/* 单位在 label 上而不是输入框后面 —— AWS 表单的惯例，且换行时不会
          让单位孤零零掉到下一行。有显示单位下拉时不重复标物理单位。 */}
      {f.unit && units.length === 0 && (
        <span style={{ color: C.muted, fontWeight: 400 }}> ({f.unit})</span>
      )}
      {isReset ? (
        <span style={{ marginLeft: 6 }}>
          <Badge tone="amber">{zh ? "将恢复默认" : "will reset"}</Badge>
        </span>
      ) : (f.customized || changed) && (
        <span style={{ marginLeft: 6 }}>
          <Badge tone={changed ? "blue" : "neutral"}>
            {changed ? (zh ? "未保存" : "unsaved") : t("insp.rules.customized")}
          </Badge>
        </span>
      )}
      {/* 🔴 「恢复默认」此前**没有任何入口**。手打回默认值只会再次记成
          「已自定义」，之后我们调默认值时这个部署不会跟着走 ——
          `insp.rules.reset` 这个 key 从旧版起就在，一直零引用。 */}
      {mayWrite && (f.customized || changed) && !isReset && (
        <button type="button" onClick={() => { setTyping(null); onReset(); }}
          title={zh ? "把这一项交回代码默认值（以后我们调默认值时会跟着走）"
                    : "Hand this field back to the code default"}
          style={{
            marginLeft: 6, background: "transparent", border: "none",
            color: C.muted, cursor: "pointer", fontSize: 11,
            textDecoration: "underline", padding: 0,
          }}>
          {t("insp.rules.reset")}
        </button>
      )}
    </>
  );

  return (
    <Field label={label}
      error={bad ? t("insp.rules.outOfRange") : undefined}
      hint={
        <>
          {t("insp.rules.default")} {fmtDefault}
          {!isSet && f.min !== null && f.max !== null && (
            <> · {t("insp.rules.range")} {units.length > 0
              ? `${Number(toDisplayUnit(f.min, units, unit).shown.toFixed(4))}~${Number(toDisplayUnit(f.max, units, unit).shown.toFixed(4))} ${unit}`
              : `${f.min}~${f.max}`}</>
          )}
          {" · "}
          <ServiceNote services={f.services || []} all={allServices} zh={zh} t={t} />
        </>
      }>
      {mayWrite ? (
        isSet ? (
          <input name={`rule_${f.key}`}
            value={Array.isArray(cur) ? cur.join(", ") : String(cur)}
            placeholder={t("insp.rules.tagsHint")}
            onChange={(e) => {
              const raw = e.target.value;
              setTyping(raw);                    // 允许「全部删空」这个中间态
              const vals = raw.split(",").map((x) => x.trim()).filter(Boolean);
              onChange(vals.length > 0 ? vals : undefined);
            }}
            onBlur={() => setTyping(null)}
            style={input} />
        ) : (
          <div style={{ display: "flex", gap: 6 }}>
            <input name={`rule_${f.key}`} type="number"
              value={String(shown)}
              step={f.type === "int" ? 1 : "any"}
              onChange={(e) => {
                const raw = e.target.value;
                setTyping(raw);                  // 允许「全部删空」这个中间态
                if (raw === "") { onChange(undefined); return; }
                const n = Number(raw);
                if (!Number.isFinite(n)) { onChange(undefined); return; }
                // 显示值 → 存储值。取不取整由 type 决定（见 format.ts 的说明）。
                onChange(units.length > 0
                  ? fromDisplayUnit(n, units, unit, f.type) : n);
              }}
              onBlur={() => setTyping(null)}
              style={{ ...input, borderColor: bad ? C.red : C.line }} />
            {units.length > 1 && (
              <select value={unit} onChange={(e) => setUnit(e.target.value)}
                name={`unit_${f.key}`}
                title={zh ? "只改显示单位，不改存储的值" : "display unit only"}
                style={{ ...input, width: 78 }}>
                {units.map((u) => (
                  <option key={u.unit} value={u.unit}>{u.unit}</option>
                ))}
              </select>
            )}
            {units.length === 1 && (
              <span style={{
                fontSize: 12, color: C.muted, alignSelf: "center", minWidth: 26,
              }}>{units[0].unit}</span>
            )}
          </div>
        )
      ) : (
        <code style={{ fontSize: 13 }}>
          {Array.isArray(cur) ? cur.join(", ") : String(shown)}
          {units.length > 0 ? ` ${unit}` : (f.unit ? ` ${f.unit}` : "")}
        </code>
      )}
    </Field>
  );
}

/**
 * 一轮的阈值编辑区。
 *
 * 🔴 提交的是**部分覆盖**：只发改动过的字段。「恢复默认」是把那个 key 从
 * 请求体里去掉，而不是显式传当前默认值 —— 显式传会把它标成「已自定义」，
 * 之后我们调默认值时这个部署就不会跟着走。
 *
 * ⚠️ 一个 run_type **一个保存按钮**。闲置轮含 idle / capacity / structural
 * 三个 section，如果每个 section 各给一个按钮，就会写出三个配置版本，
 * 而 R6.9 规定每次配置变更都强制 resolve 全部旧 finding —— 一次操作让
 * 看板数字连跳三次，没人能解释。
 */
function RulesCard({
  runType, sections, mayWrite, reload, service, allServices, zh, t,
}: {
  runType: "high" | "idle";
  sections: Record<string, RuleField[]>;
  mayWrite: boolean; reload: () => void;
  /** 选中的服务组；空串 = 全部。**只筛显示，不改作用域。** */
  service: string;
  allServices: string[];
  zh: boolean; t: (k: string) => string;
}) {
  /** `null` = 这一项要**恢复默认**（提交时传 null，后端从合并结果里删掉它）。 */
  const [draft, setDraft] = useState<
    Record<string, Record<string, number | string[] | null>>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [advOpen, setAdvOpen] = useState(false);
  /**
   * 当前越界的字段。
   *
   * 🔴 保存按钮要据此禁用。第一版只在字段上显示红框，而按钮照样是蓝色
   * primary → 点下去后端整批拒（`putRules` 是「有一个不合法就整个拒」）
   * → 客户本次的**其他**改动一起没存上，而红框看起来只是装饰。
   */
  const [badKeys, setBadKeys] = useState<Set<string>>(new Set());

  const setField = (section: string, key: string,
                    v: number | string[] | null | undefined) => {
    setMsg(""); setErr("");
    setDraft((cur) => {
      const next = { ...cur, [section]: { ...(cur[section] || {}) } };
      if (v === undefined) delete next[section][key];
      else next[section][key] = v;
      if (Object.keys(next[section]).length === 0) delete next[section];
      return next;
    });
  };

  const markBad = useCallback((section: string, key: string, bad: boolean) => {
    setBadKeys((cur) => {
      const id = `${section}.${key}`;
      if (bad === cur.has(id)) return cur;      // 不变就不触发重渲染
      const next = new Set(cur);
      if (bad) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  // 只提交与当前生效值不同的字段。
  const payload = useMemo(() => {
    const out: Record<string, Record<string, number | string[] | null>> = {};
    for (const [section, body] of Object.entries(draft)) {
      const live = new Map((sections[section] || []).map(
        (f) => [f.key, { value: f.value, customized: f.customized }]));
      for (const [key, v] of Object.entries(body)) {
        if (v === null) {
          // 恢复默认。⚠️ 没被自定义过的字段传 null 是**空操作** ——
          //    发它只会白写一个配置版本，而 R6.9 规定每次配置变更都强制
          //    resolve 全部旧 finding（看板数字跳一次，没人能解释）。
          if (!live.get(key)?.customized) continue;
          (out[section] ||= {})[key] = null;
          continue;
        }
        if (JSON.stringify(v) === JSON.stringify(live.get(key)?.value)) continue;
        (out[section] ||= {})[key] = v;
      }
    }
    return out;
  }, [draft, sections]);
  const dirty = Object.keys(payload).length > 0;

  const save = async () => {
    // 🔴 第二道防御（与 ScheduleCard 的 okAtUtc 同理）。按钮已经按 badKeys
    //    灰掉了，但渲染测试只验到 disabled 那一道 —— 将来任何人为了
    //    「让客户看见报错」把它去掉，就会把一整批改动送去被后端整批拒。
    if (badKeys.size > 0) {
      setErr(t("insp.rules.outOfRange"));
      return;
    }
    setBusy(true); setErr(""); setMsg("");
    const r = await putInspectionRules(runType, payload);
    setBusy(false);
    if (isFail(r)) { setErr(r.message || t("insp.act.failed")); return; }
    setMsg(t("insp.act.saved"));
    setDraft({});
    reload();
  };

  const title = runType === "high" ? t("insp.tab.highLoad") : t("insp.tab.idle");

  // 按服务筛。⚠️ 只影响**显示**：`payload` 仍然从 `draft` 全量算，
  // 所以「先在 RDS 视图改一项、切到 Redis 视图再改一项、保存」两项都会存上。
  const shown: [string, RuleField[]][] = Object.entries(sections)
    .map(([sec, fields]) => [
      sec,
      fields.filter((f) => !service || (f.services || []).includes(service)),
    ] as [string, RuleField[]]);
  const shownCount = shown.reduce((n, [, fs]) => n + fs.length, 0);
  const totalCount = Object.values(sections).reduce((n, fs) => n + fs.length, 0);

  const isAdv = (sec: string, key: string) =>
    (ADVANCED[sec] || []).includes(key);

  // 当前视图看不见、但有未保存改动的字段数。
  const shownKeys = new Set(
    shown.flatMap(([sec, fs]) => fs.map((f) => sec + "." + f.key)));
  const hiddenDirty = Object.entries(payload)
    .flatMap(([sec, body]) => Object.keys(body).map((k) => sec + "." + k))
    .filter((k) => !shownKeys.has(k)).length;
  // 折叠起来的「高级」里有没有脏改动 —— 有就必须在折叠头上标出来。
  const advDirty = Object.entries(payload)
    .flatMap(([sec, body]) => Object.keys(body).map((k) => [sec, k] as const))
    .filter(([sec, k]) => isAdv(sec, k)).length;

  /**
   * ⚠️ 必须**带 section** 传进来。`RuleField` 上没有 `section` 字段
   * （它是 `sections` 这个 map 的 key），所以拿不到 section 的版本
   * 会让 `draft` 查不到对应格子 —— 表现是「输入框里改了、点保存没生效」。
   */
  const gridOf = (sec: string, fields: RuleField[]) => (
    <div style={{
      display: "grid", gap: 16, alignItems: "start", maxWidth: FORM_MAXW,
      gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
    }}>
      {fields.map((f) => (
        <RuleInput key={f.key} f={f} mayWrite={mayWrite} zh={zh} t={t}
          allServices={allServices}
          draft={draft[sec]?.[f.key]}
          onChange={(v) => setField(sec, f.key, v)}
          onReset={() => setField(sec, f.key, null)}
          onBad={(bad) => markBad(sec, f.key, bad)} />
      ))}
    </div>
  );

  return (
    <Container style={{ marginBottom: 14 }}
      header={
        <>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{title}</div>
          <span style={{ fontSize: 11.5, color: C.muted }}>
            {service
              ? t("insp.rules.shownOf")
                  .replace("{n}", String(shownCount))
                  .replace("{total}", String(totalCount))
              : t("insp.rules.totalOnly").replace("{total}", String(totalCount))}
          </span>
          <div style={{ flex: 1 }} />
          {mayWrite && (
            <Btn size="small" variant={dirty ? "primary" : "normal"}
              onClick={save} loading={busy}
              disabledReason={
                badKeys.size > 0
                  ? (zh ? `有 ${badKeys.size} 项超出允许范围 —— 后端会整批拒，`
                        + "本次其他改动也存不上"
                        : `${badKeys.size} field(s) out of range`)
                  : dirty ? "" : t("insp.rules.noChange")}>
              {t("insp.act.save")}
            </Btn>
          )}
        </>
      }>

      {/* 当前视图看不见但有未保存改动 —— 不说会让客户点保存时存进一个
          他此刻看不到的值，而那正是「我明明只改了一项」的来源。 */}
      {hiddenDirty > 0 && (
        <Alert type="info">
          {t("insp.rules.hiddenDirty").replace("{n}", String(hiddenDirty))}
        </Alert>
      )}

      {shown.map(([section, fields]) => {
        const main = fields.filter((f) => !isAdv(section, f.key));
        const adv = fields.filter((f) => isAdv(section, f.key));
        return (
          <div key={section} style={{ marginBottom: 18 }}>
            <div style={{
              fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 3,
            }}>
              {t(SEC_LABEL[section] || section)}
            </div>
            {/* OR 与 AND 语义相反，方向搞错就是「越调越多误报」—— 明示它 */}
            {SEC_NOTE[section] && fields.length > 0 && (
              <div style={{
                color: C.muted, fontSize: 11.5, marginBottom: 10, lineHeight: 1.6,
              }}>{t(SEC_NOTE[section])}</div>
            )}
            {fields.length === 0 ? (
              /* 选了某服务后整段空掉时明示 —— 静默消失会让客户以为页面坏了 */
              <div style={{ color: C.muted, fontSize: 12 }}>
                {t("insp.rules.noneForService")}
              </div>
            ) : (
              <>
                {main.length > 0 && gridOf(section, main)}
                {adv.length > 0 && (
                  <Expandable open={advOpen} onToggle={() => setAdvOpen((v) => !v)}
                    title={zh ? "高级（置信与权重）" : "Advanced"}
                    count={adv.length}
                    badge={advDirty > 0 ? (
                      <Badge tone="blue">{zh ? "有未保存改动" : "unsaved"}</Badge>
                    ) : undefined}>
                    <div style={{ paddingTop: 12 }}>
                      <div style={{
                        color: C.muted, fontSize: 11.5, marginBottom: 10, lineHeight: 1.6,
                      }}>
                        {zh
                          ? "这几个决定「攒够多少数据才敢判」与权重步长。调小会更早触发但更不稳，调大会让风险出得更晚。"
                          : "These control how much data is required before judging."}
                      </div>
                      {gridOf(section, adv)}
                    </div>
                  </Expandable>
                )}
              </>
            )}
          </div>
        );
      })}

      {err && <Status type="error">{err}</Status>}
      {msg && <Status type="success">{msg}</Status>}
    </Container>
  );
}

/**
 * 服务筛选器。
 *
 * 🔴 **它是筛选器不是作用域。** 阈值配置全局一份 —— 选 Redis 不等于
 * 「只给 Redis 设一套」。所以：
 *   · 不做成每个服务一个独立保存按钮（那看起来就是作用域）
 *   · 选中态旁边**常驻**一句说明
 *   · 每个字段自己标适用服务，让「共用」在字段级别也可见
 */
function ServiceFilter({ services, value, onChange, total, zh, t }: {
  services: RuleService[]; value: string; onChange: (v: string) => void;
  total: number; zh: boolean; t: (k: string) => string;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        flexWrap: "wrap", marginBottom: 6,
      }}>
        <span style={{ fontSize: 12, color: C.muted, marginRight: 2 }}>
          {t("insp.rules.filterBy")}
        </span>
        <Chip active={!value} onClick={() => onChange("")} name="rule_svc_all">
          {t("insp.rules.allServices")} {total}
        </Chip>
        {services.map((s) => (
          <Chip key={s.key} active={value === s.key} name={`rule_svc_${s.key}`}
            title={zh ? s.hint_zh : s.hint_en}
            onClick={() => onChange(value === s.key ? "" : s.key)}>
            {zh ? s.label_zh : s.label_en} {s.field_count}
          </Chip>
        ))}
      </div>
      {/* 🔴 常驻，不是只在选中时才显示 —— 客户第一眼就该知道这是共用的一份 */}
      <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.6 }}>
        {t("insp.rules.scopeNote")}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export default function ConfigPage({
  data, zh, t, can, reload, refreshing,
}: {
  data: ConfigData | null;
  zh: boolean; t: (k: string) => string;
  can?: (key: string) => boolean;
  reload: () => void;
  refreshing: boolean;
}) {
  // ⚠️ hook **必须在提前返回之前**。放在 `if (!data) return` 之后会让
  //    data 为 null 的那次渲染跳过它 → hook 顺序在两次渲染间不一致 →
  //    React 抛「Rendered fewer hooks than expected」。
  const [svcFilter, setSvcFilter] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);

  if (!data) {
    return (
      <div style={page}><div style={inner}>
        {/* 🔴 **不再有账号选择器**。
            阈值与定时是**全局**配置（R11.1），这个页面的 `api/inspection.ts`
            自己立的规矩就是「UI SHALL NOT 提供按账号设定的入口」——
            那个选择器唯一真实影响的是折叠区里的 `data_dates`。

            而它的**副作用**是丢草稿：切账号让 pageKey 变化 → setConfig(null)
            + loading → PageSkeleton → ConfigPage 连着 RulesCard 的 draft 一起
            卸载。管理员改了 5 个字段（页面标着「未保存」），顺手切个账号，
            改动全没了，没有任何确认或提示。

            也就是说：它暗示「这套阈值是给这个账号的」（与页面自己那句矛盾），
            而真实副作用（丢草稿）与它的表面语义（换个账号看看）毫无关系。 */}
        <PageHeader title={t("insp.tab.config")} />
        <Empty title={zh ? "读不到配置" : "Could not read config"} />
      </div></div>
    );
  }

  const rows = Object.values(data.schedules);
  // 🔴 两个独立能力：改时刻只影响「什么时候跑」，改阈值直接改变
  //    「什么算风险」—— 调高一档就能让一批生产告警消失。
  const mayWrite = !!can && can("action:inspection:schedule");
  const mayEditRules = !!can && can("action:inspection:threshold");

  const totalFields = Object.values(data.rules).reduce(
    (n, secs) => n + Object.values(secs).reduce((m, fs) => m + fs.length, 0), 0);

  return (
    <div style={page}>
      <div style={inner}>
        <PageHeader title={t("insp.tab.config")}
          description={zh
            ? "阈值决定「什么算风险」，定时决定「什么时候看」。两者都按巡检类型全局生效，不按账号。"
            : "Thresholds decide what counts as a risk; the schedule decides when we look."}
          />

        {refreshing && <div className="insp-bar" style={{ marginBottom: 8 }} />}

        {/* 🔴 三条必读的。它们的误解都没有任何运行时信号，所以常显、不许收起。 */}
        <Alert type="info" header={zh ? "改动生效方式" : "How changes take effect"}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span>· {t("insp.config.effectiveNext")}</span>
            <span>· {t("insp.rules.recountNote")}</span>
            {/* ⚠️「阈值全局共用」那句常驻在服务筛选器下面（贴着它最相关的
                控件）。这里**不重复** —— 同一句话出现两遍会让人以为是两条
                不同的规则，而且测试里 getByText 会因为多个匹配而失败。 */}
            <span>· {zh
              ? "两轮独立：改高负载阈值不影响闲置判定，反之亦然。"
              : "The two rounds are independent."}</span>
          </div>
        </Alert>

        {!mayEditRules && (
          <Alert type="pending">{t("insp.rules.readOnly")}</Alert>
        )}

        <SectionHeading
          sub={zh ? "UTC 时刻，分钟必须是 15 的整数倍（调度是 15 分钟 tick）。"
                  : "UTC time; minutes must be a multiple of 15."}>
          {t("insp.config.cron")}
        </SectionHeading>
        {rows.length === 0 ? (
          <Empty title={zh ? "尚未配置" : "Not configured yet"}
            hint={zh ? "巡检仍在按代码默认时刻运行。" : "Running on code defaults."} />
        ) : rows.map((s) => (
          <ScheduleCard key={s.run_type} row={s} mayWrite={mayWrite}
            reload={reload} zh={zh} t={t} />
        ))}

        <SectionHeading>{t("insp.rules.title")}</SectionHeading>
        {Object.keys(data.rules || {}).length === 0 ? (
          <Empty title="—" />
        ) : (
          <>
            {(data.rule_services || []).length > 0 && (
              <ServiceFilter services={data.rule_services || []}
                value={svcFilter} onChange={setSvcFilter}
                total={totalFields} zh={zh} t={t} />
            )}
            {(["high", "idle"] as const)
              .filter((rt) => data.rules[rt])
              .map((rt) => (
                <RulesCard key={rt} runType={rt} sections={data.rules[rt]}
                  mayWrite={mayEditRules} reload={reload}
                  service={svcFilter} zh={zh} t={t}
                  allServices={(data.rule_services || []).map((s) => s.key)} />
              ))}
          </>
        )}

        {data.data_dates.length > 0 && (
          <Expandable open={notesOpen} onToggle={() => setNotesOpen((v) => !v)}
            title={zh ? "可复用的数据日期" : "Reusable data dates"}
            count={data.data_dates.length}>
            <div style={{ paddingTop: 12 }}>
              <div style={{ color: C.muted, fontSize: 11.5, marginBottom: 8 }}>
                {zh
                  ? "手动触发时选 reuse 可以复用这些日期的指标批次（零 CloudWatch 成本）。"
                  : "A manual run with source=reuse can reuse these batches at no cost."}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {data.data_dates.slice(0, 30).map((d) => (
                  <Badge key={d}>{d}</Badge>
                ))}
              </div>
            </div>
          </Expandable>
        )}
      </div>
    </div>
  );
}
