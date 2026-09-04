/**
 * 巡检看板前端接线的守卫。
 *
 * 这些都是**加了新视图容易漏、而 tsc 查不出来**的接线：
 * 漏了 gate map 那条 → 视图不受权限保护；漏了 i18n key → 界面显示
 * `insp.title` 这种字符串；类名自造 → 页面完全没样式。
 * 三种都不报错。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FINDING_KINDS, SEVERITIES } from "./api/inspection";
import {
  BASIS_LABEL, IDLE_DIM, idleBadgeKind, judgementState, PRECISION_LABEL,
  PRECISION_RANK_LAST, precisionRank,
} from "./components/inspection/format";
import { STRINGS } from "./i18n";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(HERE, p), "utf8");

describe("i18n", () => {
  it("every insp.* key has both languages", () => {
    // `Dict` 的类型已强制两种语言都在，但空串能通过类型检查。
    const bad = Object.entries(STRINGS)
      .filter(([k]) => k.startsWith("insp."))
      .filter(([, v]) => !v.zh.trim() || !v.en.trim())
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it("has a key per severity and per finding state", () => {
    // 缺一个的表现是卡片上显示 `insp.sev.CRITICAL` 这种字符串 ——
    // `useT()` 找不到 key 时原样返回，不报错。
    for (const s of SEVERITIES) {
      expect(STRINGS[`insp.sev.${s}`], `insp.sev.${s}`).toBeTruthy();
    }
    for (const st of ["new", "active", "resolving", "resolved"]) {
      expect(STRINGS[`insp.state.${st}`], `insp.state.${st}`).toBeTruthy();
    }
  });

  it("does not reuse the legacy external-link key", () => {
    // `nav.inspections` 是外链到 idle 控制台的旧入口（SHOW_INSPECTIONS=false
    // 关着）。站内看板复用它会让将来恢复外链时两个入口显示同一个名字。
    const dash = read("components/InspectionDashboard.tsx")
      + read("components/InspectionDashboardBrowser.tsx");
    expect(dash).not.toContain("nav.inspections");
    expect(dash).toContain("insp.title");
  });

  it("placeholder counts are declared with {n}", () => {
    // 这几条是靠 `.replace("{n}", …)` 填的，占位符名字改了就会显示原文。
    // `insp.gate.badgeCaveats` 是门禁徽标的面上文字（D22）：`判读有降级 {n}`。
    for (const k of ["insp.warn.dispatchGap", "insp.warn.notAnalysed",
      "insp.gate.badgeCaveats"]) {
      expect(STRINGS[k].zh).toContain("{n}");
      expect(STRINGS[k].en).toContain("{n}");
    }
  });
});

describe("ChatApp wiring", () => {
  const src = read("pages/ChatApp.tsx");

  it("the inspection view is in the union", () => {
    expect(src).toMatch(/\| "inspection">\("chat"\)/);
  });

  it("★ the inspection view is in the permission gate map", () => {
    // 漏了这条 → 降权或直链进来的用户停在页面上，靠后端 403 才被挡
    // （白屏 + 报错）。tsc 完全查不出来。
    const gate = src.match(/const gate: Record<string, string> = \{[^}]*\}/)?.[0] ?? "";
    expect(gate).toContain('inspection: "nav:inspection"');
  });

  it("renders the browser and passes the account picker through", () => {
    expect(src).toContain("<InspectionDashboardBrowser");
    expect(src).toContain("accountId={dashAccountId}");
  });

  it("★ the sidebar entry is fail-CLOSED, not fail-open", () => {
    // 巡检看板会显示客户的排除清单与阈值配置 —— 运维决策不是公开信息。
    // 用 `!capsLoaded || can(...)`（Finops 那种 fail-open）会在能力
    // 加载完成前的一瞬间对所有人闪出这个入口。
    expect(src).toContain(
      'const showInspectionNav = isAdmin || (capsLoaded && can("nav:inspection"))');
    expect(src).not.toContain('!capsLoaded || can("nav:inspection")');
  });
});

describe("Sidebar wiring", () => {
  const src = read("components/Sidebar.tsx");

  it("has the three-part props set", () => {
    for (const p of ["onInspection?", "inspectionActive?", "showInspection?"]) {
      expect(src, p).toContain(p);
    }
  });

  it("destructures showInspection with a false default", () => {
    expect(src).toContain("showInspection = false");
  });

  it("uses its own icon, not the legacy report icon", () => {
    // 共用 IconReports 会让将来恢复外链时两个入口长得一模一样。
    expect(src).toContain("<IconInspection />");
  });

  it("does not touch the legacy SHOW_INSPECTIONS switch", () => {
    // 那个开关控制的是外链入口；把站内看板挂上去会让它跟着一起被隐藏。
    const navLine = src.split("\n").find((l: string) => l.includes("inspectionActive ?"));
    expect(navLine).toBeTruthy();
    expect(navLine).not.toContain("SHOW_INSPECTIONS");
  });
});

/**
 * 巡检 UI 的**全部**源文件拼一起。
 *
 * ⚠️ 下面「这个词必须出现 / 不能出现」那类断言必须扫全族，不能只读
 * `InspectionDashboard.tsx` —— 2026-08-23 把它拆成 7 个文件之后，
 * 那些断言全部变成了「在一个不再包含被测代码的文件里找字符串」，
 * 于是**恒真或恒假**，而两种都不报「断言失效了」。
 */
const INSPECTION_SRC = [
  "components/InspectionDashboard.tsx",
  "components/InspectionDashboardPanel.tsx",
  "components/inspection/ui.tsx",
  "components/inspection/tokens.ts",
  "components/inspection/format.ts",
  "components/inspection/FindingCard.tsx",
  "components/inspection/ScopePage.tsx",
  "components/inspection/ConfigPage.tsx",
  // 执行日的域与两套表示之间的换算（2026-08-31 从 ConfigPage 拆出来 ——
  // 组件文件里混着非组件导出会让 Vite 的 fast refresh 失效）。
  "components/inspection/weekdays.ts",
  "components/inspection/ExclusionModal.tsx",
  // 「深入分析」的确认弹窗（2026-08-31）。备注框与派发按钮在同一个 dialog 里 ——
  // 上一版备注在详情面板正文中间、按钮在 footer，隔了约 350px。
  "components/inspection/JudgeModal.tsx",
] as const;

const readAll = () => INSPECTION_SRC.map(read).join("\n");

describe("dashboard components", () => {
  const dash = readAll();
  const browser = read("components/InspectionDashboardBrowser.tsx");
  const css = read("styles.css");

  it("★ the file list above covers every inspection UI file", () => {
    // 这条是上面那个清单的看门人：新增一个巡检 UI 文件而忘了登记，
    // 下面所有子串断言就对它失效了 —— 而失效是静默的。
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const listed = new Set<string>(INSPECTION_SRC);
    const onDisk = [
      ...readdirSync(join(HERE, "components", "inspection"))
        .filter((f) => /\.tsx?$/.test(f))
        .map((f) => `components/inspection/${f}`),
      // 🔴 顶层的 `Inspection*.tsx` 也要扫。只扫子目录的表现是：把详情抽屉
      //    拆成 `components/InspectionFindingDrawer.tsx` 之后，
      //    「不能出现 DeleteItem / 不能出现硬编码指标名」那一族断言对它
      //    **全部失效**，而看门人一声不响。本版新增的
      //    `InspectionDashboardPanel.tsx` 正好就是顶层这种。
      ...readdirSync(join(HERE, "components"))
        .filter((f) => /^Inspection.*\.tsx?$/.test(f))
        .map((f) => `components/${f}`),
    ];
    // Browser 单独 `read()`（它是导航而不是内容），不必进 INSPECTION_SRC。
    const exempt = new Set(["components/InspectionDashboardBrowser.tsx"]);
    expect(onDisk.filter((f) => !listed.has(f) && !exempt.has(f))).toEqual([]);
  });

  it("★ only uses class names that exist in styles.css", () => {
    // 自造类名的表现是页面**完全没有样式**（元素堆在左上角），
    // 而 tsc 与 lint 都不报。第一版造了 17 个不存在的类名。
    const used = new Set<string>();
    for (const blob of [dash, browser]) {
      for (const m of blob.matchAll(/className=\{?"([^"]+)"/g)) {
        for (const c of m[1].split(/\s+/)) if (c && !c.includes("$")) used.add(c);
      }
    }
    const missing = [...used].filter((c) => !css.includes("." + c));
    expect(missing).toEqual([]);
  });

  it("keeps the per-kind pages aligned with the API kinds", () => {
    // 两边分叉的表现是那一页对所有人 403（后端按 kind 做权限分流）。
    for (const k of FINDING_KINDS) expect(dash).toContain(`"${k}"`);
  });

  it("★ shows dispatched and matched as separate columns", () => {
    // 两者不等意味着有判读永久回不来。合成一列会让这个
    // 缺口在看板上完全看不见。
    expect(dash).toContain("r.dispatched_tasks");
    expect(dash).toContain("r.mapped_tasks");
  });

  it("★ always shows either a verdict or the missing-analysis marker", () => {
    // 都不显示会让「DA 说没问题」与「判读没回来」长得一样（R12.4）。
    expect(dash).toContain("f.has_judgment");
    expect(dash).toContain("insp.degraded.title");
  });

  it("★★ gate_quality 有人取：总览渲染聚合，抽屉渲染逐档（D22）", () => {
    // 🔴 BFF 侧「算好了没人取」的检查在它自己的测试里；这条守**前端侧**的
    //    同型缺口 —— `OverviewData.gate_quality` 类型声明了、后端返回了，
    //    而 dashboard 不读它的话，「100 条里 60 条不可信」仍然只能逐条发现。
    expect(dash).toContain("overview.gate_quality");
    // 三态判据必须是显式 ===，truthy 会把存量行（null）折进某一档
    expect(dash).toMatch(/gq\.untrusted/);
    // 抽屉：逐档说明 + 「实际加载了什么」（悬浮 title 之外唯一能读全文的地方）
    const panel = read("components/InspectionDashboardPanel.tsx");
    expect(panel).toContain("insp.gate.headUntrusted");
    expect(panel).toContain("insp.gate.headDegraded");
    expect(panel).toContain("degradationLabel");
    expect(panel).toContain("skillsLoadedText");
    // 放置决策：门禁块不挂在正文那条 ternary 链里（解析失败的行也要能看到）
    expect(panel).toMatch(/da_gate_trustworthy === false/);
    expect(panel).toMatch(/da_gate_trustworthy === true/);
  });

  it("★★ the display-unit round-trip rounds by `type`, not always", () => {
    // 🔴 `fromDisplayUnit` 里那个三元此前**前端侧没有任何守卫** ——
    //    改成 `return Math.round(raw)` 时前端 123 条、Python 相关 94 条全绿。
    //
    //    而它错的后果是硬的：`read_latency_seconds` 的显示单位是 ms，
    //    50 ms × 0.001 = 0.05 s → 取整变成 **0** → 后端 min 是 0.001 → 400；
    //    而如果哪天 min 放到 0，它会静默存成「阈值 0」，那条规则从此
    //    对所有实例命中。
    const fmt = read("components/inspection/format.ts");
    expect(fmt).toMatch(
      /type === "bytes" \|\| type === "int"\)\s*\?\s*Math\.round\(raw\)\s*:\s*raw/);
  });

  it("★★ the metric direction comes from the backend, not a local list", () => {
    // 🔴 这一版把前端的 `BAD_DOWN` 指标名清单**删掉了**，改成读后端给的
    //    `direction` 字段（`assemble.to_evidence` 从 payload 的
    //    `threshold_config.direction` 取，唯一真源是 `metrics_meta`）。
    //
    //    为什么这是改进：前端那份清单是镜像，而镜像必然分叉 ——
    //    分叉的表现是**颜色/措辞反了**（「可用内存高于阈值」），
    //    读起来完全通顺，没有任何报错。
    const fmt = read("components/inspection/format.ts");
    expect(fmt).toContain("row.direction");
    expect(fmt).toContain("bad_down");

    // 前端**不得**再出现按指标名硬编码方向的清单。判据查指标名字面量：
    // `FreeableMemory` / `FreeStorageSpace` 这类只应出现在注释里。
    const code = stripComments(dash);
    for (const m of ["FreeableMemory", "FreeStorageSpace", "CPUCreditBalance"]) {
      expect(code, `${m} 不该出现在前端代码里（方向由后端给）`)
        .not.toContain(m);
    }
  });

  it("keeps the two scope lists separate (R1.2)", () => {
    // 合成一张表会让客户以为「别报 CPU」等于「别管闲置」。
    expect(dash).toContain("insp.scope.listHigh");
    expect(dash).toContain("insp.scope.listIdle");
  });

  it("directory is five items in two groups, no service dimension (R10.3 / R10.4)", () => {
    // 两个分组保留：「看风险」与「改配置」是两类动作 —— 混成一列会让
    // 「把生产库从巡检范围里摘掉」和「看看今天有什么风险」在导航上等价。
    expect(browser).toContain('"findings"');
    expect(browser).toContain('"settings"');

    const ids = [...browser.matchAll(/\bid: "([^"]+)"/g)].map((m) => m[1]);
    // 🔴 三类各自一页（2026-08-24 改回来）。
    //
    //    上一版合成一页「待处置」+ 筛选 chip，理由是少两次点击。合并本身
    //    没错，**但它让排序无解** —— 一页只能有一个排序键，而高负载要按
    //    紧急度排、闲置要按可省金额排。合并页选了 severity 序，而闲置类的
    //    severity **恒为 INFO**（`assemble.idle_findings` 写死），于是闲置
    //    条目永远沉在底部 —— 那一页唯一能立刻拿走的收益被排到看不见的地方。
    expect(ids).toEqual(["high-load", "idle", "structural", "scope", "config"]);

    // 服务维度进导航会让目录变成「服务 × 页面」的笛卡尔积。
    // ⚠️ 判据必须查**目录条目的 id**，不能查裸词 —— 组件 docstring 里正
    //    解释着「RDS / Aurora / ElastiCache 的筛选在右侧内容区」。
    const serviceish = ids.filter((i) => /rds|aurora|elasticache|cache/i.test(i));
    expect(serviceish).toEqual([]);

    // 服务筛选仍在**右侧内容区**：阈值页的 ServiceFilter + 排除弹层的 chip
    expect(read("components/inspection/ConfigPage.tsx")).toContain("ServiceFilter");
    expect(read("components/inspection/ExclusionModal.tsx")).toContain("SERVICE_TABS");
  });

  it("★★ the legacy deep-link tabs still resolve to a real page", () => {
    // 🔴 **已经发出去的 IM 深链还在客户手里**（`?tab=high-load` 等）。
    //    导航里没有这些 id 了 —— 没有兼容映射的表现是客户点开推送里的
    //    「详情」落在默认页，而链接看起来是好的、也不报错。
    const legacy = browser.match(/const LEGACY_TAB[^}]*\}/)?.[0] ?? "";
    const ids = new Set([...browser.matchAll(/\bid: "([^"]+)"/g)].map((m) => m[1]));

    // 🔴 判据是**每个深链 tab 值都到得了某一页**，而不是「都在 LEGACY_TAB 里」。
    //
    //    三类各自一页之后，`high-load` / `idle` / `structural` **本身就是**
    //    目录 id —— 它们不需要映射，要求它们出现在 LEGACY_TAB 里反而会逼出
    //    一个 `"idle": "idle"` 这样的恒等项。所以两条路任一条通就算过。
    //
    //    这四个值来自 `push_policy.tab_for_rule` 的返回值 + 老的 `overview`。
    for (const old of ["overview", "high-load", "idle", "structural", "triage"]) {
      const reachable = ids.has(old) || legacy.includes(`${old}:`)
        || legacy.includes(`"${old}":`);
      expect(reachable, `深链 ?tab=${old} 既不是目录 id 也没有兼容映射`)
        .toBe(true);
    }
    // 映射的目标必须是真实存在的目录 id
    for (const m of legacy.matchAll(/:\s*"([a-z-]+)"/g)) {
      expect(ids.has(m[1]), `LEGACY_TAB 指向了不存在的页 ${m[1]}`).toBe(true);
    }
  });

  it("★ every directory entry guards on a real capability key", () => {
    const ids = [...browser.matchAll(/\bid: "([^"]+)"/g)].map((m) => m[1]);
    // 写错 key 的表现是那一页对**有权限的人**也被隐藏
    // （`can()` 查不存在的 key 恒 false），而后端照样放行 —— 零报错。
    const caps = new Set<string>(
      JSON.parse(read("../../../config/capabilities.json")).nodes
        .map((n: { key: string }) => n.key));
    // ⚠️ 正则抓的是**所有** `"nav:inspection:*"` 字面量（不区分 `cap:` 还是
    //    数组里的一项）—— 将来聚合页回来带 `anyCap: [...]` 时不必改这里。
    const used = [...browser.matchAll(/"(nav:inspection:[a-z-]+)"/g)].map((m) => m[1]);
    expect(used.filter((k) => !caps.has(k))).toEqual([]);

    // 🔴 **逐个条目**检查，不是「总数 ≥ 某个常数」。
    //
    //    可见性判据是 `!e.cap || can(e.cap)` —— 一个**没有 `cap`** 的条目
    //    对所有人可见。绑常数的版本余量为 0，加一个无 cap 的条目时红的是
    //    id 清单那条断言，而自然的修法（把新 id 加进期望清单）会让守卫全绿
    //    —— 一个未授权页就这么上线了。
    const entriesBlock = browser.slice(
      browser.indexOf("const ENTRIES"), browser.indexOf("const LEGACY_TAB"));
    const perEntry = entriesBlock.split(/\bid:\s*"/).slice(1);
    expect(perEntry.length).toBe(ids.length);
    for (const chunk of perEntry) {
      const name = chunk.slice(0, chunk.indexOf('"'));
      expect(/\bcap:\s*"/.test(chunk),
        `目录项 ${name} 没有 cap —— 它对所有人可见`).toBe(true);
    }

    /* 🔴 **每一项都用单个 `cap`。**
       `Entry.anyCap`（「三者任一」）2026-09-02 删掉了 —— `ENTRIES` 里
       一项都没设过它，那个分支从写下起就没执行过。它本来是为**聚合的
       「待处置」页**准备的（只有闲置权限的人也该看到那一页），而聚合视图
       后来没了：`PAGE_ALIAS` 每一项都带 `chip`，也就是每页恒定单 kind。

       ⚠️ 将来把聚合页加回来时这条会红 —— 那时要**同时**把 `anyCap` 与
          `e.anyCap.some((k) => can(k))` 那个分支一起加回来，
          而不是给聚合页绑一个单 kind 的 cap（那会让只有闲置权限的人
          看不到本该看到的那一类）。 */
    expect(/\banyCap\b/.test(browser),
      "`anyCap` 回来了 —— 那说明聚合页也回来了，"
      + "记得同时恢复 `e.anyCap.some((k) => can(k))` 那道可见性分支",
    ).toBe(false);
  });
});

// ===========================================================================
// 写侧接线
//
// 行为层面的断言在 `inspection.render.test.tsx`。这里只查**接线**：
// 能力 key 是否真存在、门禁是否 fail-CLOSED、i18n 是否双语齐全。
// 这三类的失效形态是「按钮永远不显示」或「界面显示 insp.act.save」——
// 渲染测试用的是中文文案，所以它们抓不到 key 拼错。
// ===========================================================================

/**
 * 剥掉 `//` 与块注释后的源码。
 *
 * ⚠️ 「本文件里不该出现 X」这类断言**必须**在剥注释后的源码上做。
 * 本仓的注释里经常正解释着那个词 —— 例如 `getUTCDay` 出现在
 * 「JS 的 getUTCDay() 是 0=周日」这句说明里，直接查裸词就是误报。
 * 反过来，如果只把断言放宽到能绕过注释，就抓不到真的回归了。
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("write-side wiring", () => {
  const dash = readAll();
  const dashCode = stripComments(dash);
  /**
   * 定时那一段单独取。
   *
   * ⚠️ 「不许自己算时间」那条断言**只针对定时**。排除清单的到期日
   * （`isoPlusDays` 里的 `setUTCDate`）是另一回事 —— 那是「今天 + 30 天」，
   * 与 weekdays 过滤无关，自己算完全正确。扫全族会把它误报成回归。
   */
  const configSrc = stripComments(read("components/inspection/ConfigPage.tsx"));
  const api = read("api/inspection.ts");
  const caps = JSON.parse(read("../../../config/capabilities.json")) as {
    nodes: { key: string; level?: string; routes?: { method: string; pattern: string }[] }[];
  };
  const capKeys = new Set(caps.nodes.map((n) => n.key));

  it("★ the two action capabilities exist in capabilities.json", () => {
    // 写错 key 的表现是按钮对**有权限的人**也不显示（`can()` 查不存在的
    // key 恒 false），而后端照样放行 —— 零报错。
    for (const k of ["action:inspection:scope", "action:inspection:schedule"]) {
      expect(capKeys.has(k), k).toBe(true);
      expect(dash, k).toContain(`can("${k}")`);
    }
  });

  it("★★ write gates are fail-CLOSED", () => {
    // `can` 未传（宿主还没拿到能力）时**不能**显示写入控件。
    // fail-open 的写法是 `!can || can(...)` —— 那会在加载期对所有人闪出
    // 「新增排除」，手快的人点进去就能提交，而 403 只在提交那一刻出现。
    expect(dash).toContain('!!can && can("action:inspection:scope")');
    expect(dash).toContain('!!can && can("action:inspection:schedule")');
    expect(dash).not.toContain('!can || can("action:inspection');
  });

  it("★ the two action capabilities are separate keys", () => {
    // 合成一个的表现是：给了「改排除清单」的人顺带能改执行时刻，
    // 而后者是**全局**配置（R11.1），一改影响所有账号。
    const scope = caps.nodes.find((n) => n.key === "action:inspection:scope")!;
    const sched = caps.nodes.find((n) => n.key === "action:inspection:schedule")!;
    const pat = (n: typeof scope) => (n.routes ?? []).map((r) => `${r.method} ${r.pattern}`);
    expect(pat(scope).length).toBeGreaterThan(0);
    expect(pat(sched).length).toBeGreaterThan(0);
    // 两者的路由集合不能有交集
    expect(pat(scope).filter((p) => pat(sched).includes(p))).toEqual([]);
  });

  it("★★ account-wide exclusion is a separate entry that always confirms", () => {
    // 后端的判据是 `!resource || level === "account"`（R1.7）。
    //
    // 🔴 这一版把它从「同一张表单里可能误触发」改成**独立入口**：
    //
    //    ```
    //    旧：一张 7 字段表单。不填 resource_id 或把 level 选成 account
    //        → 悄悄变成整账号排除。前端判据宽一格就是「UI 没弹确认、
    //          后端却要求 confirm」的 400，窄一格就是不弹确认直接生效
    //    新：普通排除**恒有** resource_id 且 level 只可能是
    //        instance / cluster（从选中资源的 tier 自动推）
    //        → 后端那个判据永不命中
    //        整账号排除是另一个按钮 + 自己的确认对话框，恒传
    //          confirm_account_wide: true
    //    ```
    //
    //    也就是说「误触发整账号排除」这条路径被结构性地消掉了，
    //    而不是靠两处判据保持一致。
    const scope = read("components/inspection/ScopePage.tsx");
    const modal = read("components/inspection/ExclusionModal.tsx");

    // 整账号那条路径：level 写死 account + 恒确认
    expect(scope).toContain('level: "account"');
    expect(scope).toContain("confirm_account_wide: true");
    // 且它有自己的对话框（不是 window.confirm —— 后者说不出影响面，
    // 而且会被浏览器的「阻止此页面再次弹窗」静默禁掉并返回 false）
    expect(stripComments(scope)).not.toContain("window.confirm");
    expect(scope).toContain("<Modal");

    // 普通排除那条路径：resource_id 恒有，level 从 tier 推
    expect(modal).toContain("resource_id: r.resource_id");
    expect(modal).toContain('r.tier === "cluster" ? "cluster" : "instance"');
    // 🔴 普通排除**不得**传 confirm_account_wide —— 传了等于给后端的
    //    R1.7 护栏发了一张永久通行证。
    const body = modal.slice(modal.indexOf("const body: ExclusionInput"),
      modal.indexOf("const resp = await putInspectionExclusion"));
    expect(body).not.toContain("confirm_account_wide");

    // 后端那一侧的判据仍然在（它是最后一道）
    const bff = read("../../../bff/web-chat/inspection.mjs");
    expect(bff).toContain('!resource || level === "account"');
  });

  it("★★ renew does not resend the whole record", () => {
    // put 需要调用方回传整条记录，而 UI 手里没有 `level` ——
    // 少传就让级联排除静默失效（那正是 put_exclusion 专门拦的那个错）。
    expect(api).toContain("renewInspectionExclusion");
    const sig = api.match(/renewInspectionExclusion\([^)]*\)/)?.[0] ?? "";
    expect(sig).toContain("key");
    expect(sig).not.toContain("level");
  });

  it("★★ the frontend never computes the next run time itself", () => {
    // 这条规则带 weekdays 过滤，而 JS 的 getUTCDay() 是 0=周日、
    // Python 的 weekday() 是 0=周一。两份实现分叉的表现是 UI 显示的时间
    // 与实际执行差一天，客户按 UI 等，等不到。
    expect(configSrc).toContain("r.next_run_utc");
    expect(configSrc).not.toContain("getUTCDay");
    expect(configSrc).not.toContain("setUTCDate");
    // 剥注释的自检：注释里**确实**有这个词，所以剥之前必然命中。
    // 这条防止 stripComments 某天把整个文件都吃掉而上面两条恒真。
    const raw = read("components/inspection/ConfigPage.tsx");
    expect(raw).toContain("getUTCDay");
    expect(configSrc.length).toBeGreaterThan(raw.length / 3);
  });

  it("★ at_utc is validated with the shared predicate, not a local regex", () => {
    // 自己写一遍正则等于同一条判据两份实现。后端拦得住，但客户会填完
    // 一整张表才被 400 拒 —— 而错误信息里那句「15 的整数倍」他没见过。
    expect(configSrc).toContain("isValidAtUtc");
    expect(api).toContain("SCHEDULE_TICK_MINUTES = 15");
  });

  it("★ at_utc has BOTH defenses: disabled button and an in-handler guard", () => {
    // 渲染测试只能验到 `disabled` 那一道 —— jsdom 里点 disabled 的按钮
    // 压根不触发 handler，所以 handler 里的 guard 无法从 DOM 观察到。
    // 实测：把 guard 删掉，全部渲染测试照过。
    //
    // 两道都要留：只有 disabled 时，将来任何人为了「让客户看见报错」
    // 把 disabled 去掉，就会把一个永远不被精确命中的时刻写进库
    //（表现是那一类巡检的报告总是慢几分钟，而不是任何报错）。
    // 第一道：按钮按 okAtUtc 灰掉，且**带出原因**（`Btn` 的 API 强制给理由 ——
    //   灰着不说为什么的按钮让人只能猜「是不是坏了」）。
    expect(configSrc).toMatch(/disabledReason=\{[\s\S]{0,120}okAtUtc/);
    // 🔴 `loading={busy}` 也要在。第一版的逐字断言是
    //    `disabled={busy || !okAtUtc}`，改成只查 okAtUtc 之后 `busy` 那一半
    //    就没人守了 —— 去掉它的表现是飞行窗口内按钮可重复点
    //    （`canSave` 依赖 `row.at_utc`，要等 reload() 才更新），而重复写配置
    //    会白写一个配置版本，R6.9 跟着强制 resolve 全部旧 finding。
    expect(configSrc).toMatch(/loading=\{busy\}/);
    // 第二道：handler 内的 guard。
    expect(configSrc).toMatch(/if \(!okAtUtc\)\s*\{[^}]*return;/);
  });

  /**
   * 删除排除条目：**逐行可以，批量不行。**
   *
   * 🔴 这条断言 2026-09-01 反过来了。原来是「整个写面不许有任何删除路径」，
   * 理由是 R1.4「到期条目保留记录但不生效」—— 那是防「白名单越积越多没人
   * 敢删」的机制。但客户遇到的是另一个方向的问题：
   *
   * ```
   * 原来防的      攒着不管 → 靠「让它们可见」防
   * 客户遇到的    手滑排除一台生产库，**没有任何位置能撤销**
   *               → 只能等 30 天过期
   *               → 那 30 天里「没有告警」会被读成「一切正常」
   *               → 同样没有运行时信号
   * ```
   *
   * 所以现在守的是**边界**而不是「有没有」：逐行撤销 + 二次确认 + 审计留存，
   * 但**不许**出现批量删除 / 「清理已过期」按钮 —— 那一步才是原来担心的。
   */
  it("★★ 删除只有逐行入口，没有批量清理", () => {
    const scope = stripComments(read("components/inspection/ScopePage.tsx"));
    // 逐行入口必须在（否则「误操作只能等 30 天」那个缺陷又回来了）
    expect(scope).toContain("deleteInspectionExclusion");
    // 🔴 必须有二次确认。少了它，一次误点就把排除撤掉，
    //    而被压住的 finding 会在下一轮全部回来。
    expect(scope).toMatch(/setDel\(\{ kind: k, e \}\)/);
    // 🔴 **没有批量。** 这几个词一旦出现就说明有人加了「清理已过期」那类按钮。
    // ⚠️ 扫**整个巡检 UI 族**（`dashCode`）而不只是 ScopePage —— 批量清理
    //    最可能被加到「巡检总览/系统状态」那种运维自检的位置去。
    for (const bad of ["清理已过期", "clearExpired", "deleteAllExpired",
                       "purgeExpired", "批量删除"]) {
      expect(scope, `ScopePage 出现了批量删除入口：${bad}`).not.toContain(bad);
      expect(dashCode, `巡检 UI 里出现了批量删除入口：${bad}`).not.toContain(bad);
    }
    // 审计：BFF 必须用 ALL_OLD 把被删的整行打进日志（谁/何时/删了什么）
    const bff = stripComments(read("../../../bff/web-chat/inspection.mjs"));
    expect(bff).toContain("DeleteCommand");
    expect(bff).toMatch(/ReturnValues: "ALL_OLD"/);
    expect(bff).toMatch(/排除条目已删除/);
    /* 🔴 IAM 要真的给 DeleteItem —— 不给的表现是点下去
       AccessDeniedException，而前端只显示「操作失败」。

       ⚠️ 读的是 `constructs/web-chat-core.ts` 而**不是** `web-chat-stack.ts`
          （2026-09-03 合并 main 时改）：main 的 `d7de88e` 把 Web Chat 的资源
          定义全部抽进了那个 construct，`web-chat-stack.ts` 只剩 30 行委托壳。
          抽成**函数**而不是 Construct 子类是刻意的 —— 后者会在每个构件路径里
          插一层 id，让现网栈的逻辑 ID 全变（等于一次 delete + recreate）。
          一键部署的 standalone 单栈复用同一份定义，所以这条断言现在同时
          守住了两条部署路径。 */
    const core = read("../../../infra/lib/constructs/web-chat-core.ts");
    const insp = core.slice(core.indexOf("sid: \"InspectionScopeAndScheduleWrite\""));
    expect(insp.slice(0, 400)).toContain("dynamodb:DeleteItem");
  });

  it("★ form controls carry stable `name` attributes", () => {
    // 没有 name 时测试只能按 DOM 顺序取第 N 个输入框 —— 字段重排之后
    // 值会填进**别的**框，而断言的是「调用参数里有这个值」，于是照过。
    //
    // ⚠️ 清单跟着表单变了：`account_id` / `service` / `resource_id` /
    //    `region` / `level` **不再有输入框** —— 它们从选中的资源自动带出
    //    （那五个的共同点是打错了不会报错，见 ExclusionModal 的说明）。
    //    现在人能填的只有到期日、原因、时刻、开关、阈值。
    for (const n of ["expires_at", "reason", "wide_reason"]) {
      expect(dash, n).toContain(`name="${n}"`);
    }
    // 定时：两个 run_type 各自独立的控件（共用一份编辑态会让「改了 high
    // 点保存」把 idle 的输入框内容也带过去）
    expect(dash).toContain("name={`at_utc_${runType}`}");
    expect(dash).toContain("name={`enabled_${runType}`}");
    // 阈值字段与它的显示单位下拉
    expect(dash).toContain("name={`rule_${f.key}`}");
    expect(dash).toContain("name={`unit_${f.key}`}");
    // 排除弹层的清单勾选（两份清单独立，所以是两个 checkbox）
    expect(dash).toContain("name={`excl_list_${k}`}");

    // 🔴 反向：那五个**不该**再有输入框。留着的表现是「弹层里自动带出了，
    //    表单里还能手改」—— 客户改完那五个之一，排除就静默永不生效。
    for (const n of ["resource_id", "level"]) {
      expect(dash, `${n} 不该再有手填输入框`).not.toContain(`name="${n}"`);
    }
  });

  it("every write-side i18n key is present in both languages", () => {
    const keys = [
      "insp.act.save", "insp.act.saving", "insp.act.cancel", "insp.act.saved",
      "insp.act.failed", "insp.scope.add", "insp.scope.renew",
      "insp.scope.expired", "insp.scope.neverExpires", "insp.scope.level",
      "insp.scope.levelHint", "insp.scope.service", "insp.scope.resourceId",
      "insp.scope.resourceIdHint", "insp.scope.accountId",
      "insp.scope.reasonHint", "insp.scope.confirmAccountWide",
      "insp.scope.expiresAtHint", "insp.config.atUtc", "insp.config.atUtcHint",
      "insp.config.atUtcBad", "insp.config.enabled", "insp.config.weekdays",
      // ⚠️ `insp.config.everyDay` 已删（七个 chip 全亮就是每天，不再有那行
      //    小字）。换成拦「点灭最后一天」的那条 —— 它缺失的表现是按钮上
      //    直接显示 `insp.config.weekdaysMin` 这个 key 本身。
      "insp.config.weekdaysMin", "insp.config.notPersisted",
    ];
    for (const k of keys) {
      expect(STRINGS[k], k).toBeTruthy();
      expect(STRINGS[k].zh.trim(), k).toBeTruthy();
      expect(STRINGS[k].en.trim(), k).toBeTruthy();
    }
    for (const lv of ["instance", "cluster", "group", "account"]) {
      expect(STRINGS[`insp.scope.lv.${lv}`], lv).toBeTruthy();
    }
    // 🔴 1 = 周一 … 7 = 周日（调度器的 `date.isoweekday()`）。
    // 七天缺一个的表现是按钮上显示 `insp.wd.5` 这种字符串 ——
    // `useT()` 找不到 key 时原样返回。
    for (let d = 1; d <= 7; d++) {
      expect(STRINGS[`insp.wd.${d}`], `insp.wd.${d}`).toBeTruthy();
    }
    // ★ 0 这个键**必须不存在**：它的存在意味着有人又把口径改回 weekday()，
    //   而那会让「周一」落库成 0 → 那类巡检永远不跑（完全静默）。
    expect(STRINGS["insp.wd.0"]).toBeUndefined();
  });

  it("the account-wide confirmation names both the account and the list", () => {
    // 只说「确认排除？」的对话框客户会无脑点确定。要点是让他看见
    // **是哪个账号**、**哪一份清单**。
    for (const loc of ["zh", "en"] as const) {
      expect(STRINGS["insp.scope.confirmAccountWide"][loc]).toContain("{a}");
      expect(STRINGS["insp.scope.confirmAccountWide"][loc]).toContain("{k}");
    }
  });

  it("★★★ 后端状态机的每一个 state 都有 i18n 文案", () => {
    // 🔴 `insp.state.chronic` 漏加过一次 —— 卡片徽章上直接印出
    //    `insp.state.chronic` 这串 key 给客户看（`t()` 找不到键就返回键名
    //    本身，不抛不告警）。
    //
    // ⚠️ 这**不是** `scripts/lint_i18n.py::check_frontend_keys` 能抓的：
    //    key 是从后端枚举**动态拼**的（`t(\`insp.state.${row.state}\`)`），
    //    静态扫源码看不到。所以这一族要有专门的枚举一致性断言。
    //
    // 真源是 `inspection/domain/lifecycle.py::FindingState`。
    // 加一个态却忘了加文案，表现是那一态的徽章显示成一行代码。
    const STATES = ["new", "active", "resolving", "resolved", "chronic"];
    for (const st of STATES) {
      const key = `insp.state.${st}`;
      expect(STRINGS[key], `${key} 缺文案 —— 徽章上会显示 "${key}" 给客户看`)
        .toBeTruthy();
      for (const loc of ["zh", "en"] as const) {
        expect(STRINGS[key][loc], `${key}.${loc} 是空的`).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// `evidenceText` 的方向 —— 猜错方向的表现是「句子通顺、结论相反」
//
// 🔴 2026-09-02 review 抓到：上一版是
//    `direction === "bad_down" ? "低于" : "高于"`，三元的 else 把
//    「读不到方向」和「越大越坏」合成了同一个分支。
//
//    而 `value` / `threshold` 与 `direction` 来自**不同的白名单**
//    （`assemble.py` 的 `_EVIDENCE_NUMERIC` vs `payload.threshold_config
//    .direction` 非空才落），所以「有数值、没方向」是真实存在的行形态。
//
//    后果：FreeableMemory（越小越坏）渲染成「1.1% **高于阈值** 20%」——
//    零报错、颜色徽章全对，只有结论是反的，客户读完的动作是「不用管」。
// ---------------------------------------------------------------------------
describe("evidenceText direction", () => {
  const row = (direction: string) => ({
    observed_value: 1.1, threshold_value: 20, direction, unit: "%",
  });

  it("bad_down → 低于阈值", async () => {
    const { evidenceText } = await import("./components/inspection/format");
    expect(evidenceText(row("bad_down"), true)?.relation).toBe("低于阈值");
    expect(evidenceText(row("bad_down"), false)?.relation).toBe("below threshold");
  });

  it("bad_up → 高于阈值", async () => {
    const { evidenceText } = await import("./components/inspection/format");
    expect(evidenceText(row("bad_up"), true)?.relation).toBe("高于阈值");
    expect(evidenceText(row("bad_up"), false)?.relation).toBe("above threshold");
  });

  it("★★★ 缺 direction 时 relation 为空串，绝不默认「高于阈值」", async () => {
    const { evidenceText } = await import("./components/inspection/format");
    for (const d of ["", "  ", "unknown_direction"]) {
      const got = evidenceText(row(d), true);
      expect(got,
        `direction=${JSON.stringify(d)}: 数值仍要给出来（它是有效证据）`,
      ).toBeTruthy();
      expect(got!.relation,
        `direction=${JSON.stringify(d)} 时不许猜方向 —— `
        + "猜错会把 FreeableMemory 的结论说反").toBe("");
      // 数值与阈值本身照旧给 —— 不该因为缺方向就把证据整条丢掉。
      expect(got!.value).toBe("1.1%");
      expect(got!.threshold).toBe("20%");
    }
  });

  it("★★ 源码里不许再出现「else 就是高于阈值」的三元", async () => {
    // 行为断言会被「把 else 换成另一个默认值」满足，所以再钉一次结构。
    const src = read("components/inspection/format.ts");
    const fn = src.slice(src.indexOf("export function evidenceText"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(/direction === "bad_up"/.test(body),
      "必须显式判 bad_up，而不是靠三元的 else 兜住它").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// run 状态 rank 的适用范围 —— 钉一个**容易被误解的现状**，不是缺陷
// ---------------------------------------------------------------------------
describe("run status rank", () => {
  it("★★ 前后端 rank 同序（partial 必须排在 success 之前）", () => {
    // 🔴 `partial` 的语义是「有 region 没扫成」，而那些实例压根没进
    //    `expected` → `completeness` 可能仍是 1.0 → 「完整度不足」那句补充语
    //    不出现。归到成功那一档的表现是绿色 ✓「本轮未发现风险」，
    //    而那个 region 里内存 98% 的库一条 finding 都没出。
    //
    // ⚠️ 两处必须同序：BFF 的 `worstRunAcross` 跨账号时真的要排
    //    （一个账号 partial、另一个 success），而前端会把 BFF 挑出的那条
    //    再排一次。分叉的表现是空态文案与真实原因错位。
    const fe = read("components/InspectionDashboard.tsx");
    const bff = readFileSync(
      join(HERE, "..", "..", "..", "bff", "web-chat", "inspection.mjs"), "utf8");
    for (const [label, body] of [["前端", fe], ["BFF", bff]] as const) {
      expect(/status === "partial"\) return 4/.test(body),
        `${label} 的 rank 没把 partial 排在第 4 档`).toBe(true);
      expect(/return 5;/.test(body),
        `${label} 的 rank 最后一档应当是 5（partial 插进来之后 success 后移）`,
      ).toBe(true);
    }
  });

  it("★★ 每个 kind 页只取一个 kind —— 前端 rank 的排序目前是死的", () => {
    // `PAGE_ALIAS` 每一项（含 `triage` / `overview` 两个老深链）都带 `chip`，
    // 所以 `alias.chip` 恒非空 → `wantKinds` 只有一个元素 → `lastRuns` 只有
    // 一个元素 → 前端 `rank` 的**排序**结果与档位数值无关。
    //
    // 真正拦住「partial 显示成未发现风险」的是 `TriageEmpty` 里那个
    // `status === "partial"` 分支（有独立的渲染用例）。
    //
    // ⚠️ 将来把聚合视图加回来（某一项去掉 `chip`）时这条会红 —— 那时要
    //    **同时**给 rank 补一条真正的多 kind 行为用例，否则档位写错没有信号。
    const src = read("components/InspectionDashboard.tsx");
    const start = src.indexOf("const PAGE_ALIAS");
    const block = src.slice(start, src.indexOf("\n};", start));
    const entries = block.split("\n")
      .filter((l) => /^ {2}[\w"'-]+:\s*\{/.test(l));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((l) => /page: "kind"/.test(l) && !/chip:/.test(l)),
      "有 kind 页没带 chip = 出现了真正的多 kind 视图，"
      + "那时 TriageEmpty 的 rank 会真的排序，必须给它补行为用例",
    ).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// judgementState —— 判读状态七档
// ═══════════════════════════════════════════════════════════════════════════
/**
 * 🔴 这一节钉的是 2026-09-02 review 抓到的四条缺陷的**共同根因**：
 * 判读状态是个四元组 `(dispatched, 有正文, parse_status, skip_reason/
 * conclusion)`，而卡片与抽屉各自只看其中一两个维度 —— 于是同一条 finding
 * 在列表与详情里有两种说法。
 */
describe("judgementState（卡片与抽屉的唯一判据）", () => {
  const ROW = (over: Record<string, unknown> = {}) => ({
    kind: "high_load", has_judgment: false, da_verdict: "",
    da_parse_status: "", da_task_id: "", conclusion: "", skip_reason: "",
    ...over,
  });

  it("★ 解析干净且有结论 → ok", () => {
    expect(judgementState(ROW({
      has_judgment: true, da_verdict: "real_degradation",
      da_parse_status: "ok", da_task_id: "t-1",
    }))).toBe("ok");
  });

  it("★★★ 有正文但没解析出结论 → partial（不是 ok）", () => {
    /* 那段正文是**整份报告原文**，可能含同批别的资源的分析。
       判成 ok 就等于宣称它是本条的结论 —— 客户会在 db-A 的抽屉里
       读到 db-B 的分析，还配着「AI 判读」标题和时间徽章。 */
    expect(judgementState(ROW({
      has_judgment: true, da_verdict: "",
      da_parse_status: "parse_failed", da_task_id: "t-1",
    }))).toBe("partial");
  });

  it("★★★ 有正文、有结论、但 parse_status 是 partial → partial", () => {
    // 「只对上了一部分」时对上的那几条是真的，没对上的是缺的 ——
    // 而我们不知道**本条**属于哪一边，所以必须标注。
    expect(judgementState(ROW({
      has_judgment: true, da_verdict: "real_degradation",
      da_parse_status: "partial", da_task_id: "t-1",
    }))).toBe("partial");
  });

  it("★★★ 派了、没正文、没 parse_status → pending", () => {
    expect(judgementState(ROW({ da_task_id: "t-1" }))).toBe("pending");
  });

  it("★★★ 派了、没正文、**有** parse_status → failed（不是 pending）", () => {
    /* 🔴 这是抽屉那条 P0 的核心：`callback_apply.py` 对
       `ParseStatus.EMPTY` / `res.missing` 只写 parse_status 不写 body，
       所以这个组合是**终态**。判成 pending 的话蓝色「1~3 分钟后回来」
       永远不会退出，客户一直刷新等一个已经确定失败的东西。 */
    for (const st of ["empty", "missing_section", "parse_failed"]) {
      expect(judgementState(ROW({ da_task_id: "t-1", da_parse_status: st })),
        `parse_status=${st} 被判成了等待态`,
      ).toBe("failed");
    }
  });

  it("★★★ 没派、有 conclusion → rule（规则算的，不是 AI）", () => {
    expect(judgementState(ROW({
      kind: "idle", conclusion: "主因 CPU 均值 0.25%",
    }))).toBe("rule");
  });

  it("★★★ 没派、NEEDS_NO_AI 的 skip_reason → not_needed", () => {
    for (const r of ["deterministic", "playbook", "reused", "rollup_member"]) {
      expect(judgementState(ROW({ skip_reason: r })),
        `skip_reason=${r} 本来就不需要 AI，被说成缺判读`,
      ).toBe("not_needed");
    }
  });

  it("★★★ 没派、kind 是 idle/structural → not_needed（存量行兜底）", () => {
    // 升级**之前**写下的行既没有 conclusion 也没有 skip_reason。
    // 少了这条兜底的表现是 2026-08-31 实机那 16 条各挂一个「判读缺失」。
    for (const k of ["idle", "structural"]) {
      expect(judgementState(ROW({ kind: k })), `kind=${k}`).toBe("not_needed");
    }
  });

  it("★★★ budget / quota / kill_switch → missing（本该判却没判）", () => {
    /* `gating.decide()` 这三支都返回 `Decision(dispatch=False)` 而
       **不带** conclusion，`Decision.has_conclusion` 的 docstring 明写
       「必须显式告诉客户『因额度未分析』而不是留白」。 */
    for (const r of ["budget", "quota", "kill_switch"]) {
      expect(judgementState(ROW({ skip_reason: r })), `skip_reason=${r}`)
        .toBe("missing");
    }
  });

  it("★★★ `da_verdict` 单独到达也算「回来了」", () => {
    /* ⚠️ 这一路看着多余（有结论必然有正文），但少了它，
       「有 verdict、无 body」会掉进 dispatched 分支被判成 `failed`
       —— 界面说「判读回来了但没有内容」而结论就在旁边。
       这是原 `hasJudgment` 三源取或的用意，搬进 judgementState 时
       不要顺手简化掉。 */
    expect(judgementState(ROW({
      da_verdict: "real_degradation", da_parse_status: "ok",
      da_task_id: "t-1", has_judgment: false,
    }))).toBe("ok");
  });

  it("★★★ 抽屉自己拉到的正文优先于列表的 has_judgment", () => {
    // 列表说没有、抽屉拉到了 → 按「有」算（detail 最权威）。
    expect(judgementState(ROW({ da_task_id: "t-1", da_parse_status: "ok",
      da_verdict: "warm_up" }), { detailBody: "## 分析\n…" })).toBe("ok");
  });

  it("★★★ `dispatched` 传进来时压过 `da_task_id`（乐观状态）", () => {
    // 刚派成功、列表还没刷新到 → task_id 仍是空，但必须已经是 pending，
    // 否则那一帧会显示「判读缺失」（琥珀色故障态）。
    expect(judgementState(ROW(), { dispatched: true })).toBe("pending");
  });

  it("★★★ 卡片与抽屉必须用同一个 judgementState —— 不许各自判", () => {
    /* 🔴 这是那四条缺陷的共同根因。两处各自判的表现是同一条 finding
       在列表与详情里两种说法，而这种不一致没有任何单元测试能自然抓到
       （两边各自的用例都是绿的）。 */
    /* 每个文件的**老判据长得不一样**，所以逐个钉：
         FindingCard   `(judged ?? Boolean(da_task_id)) && !f.has_judgment`
         Panel         `dispatched && !hasJudgment`
       共同点是「派了 && 没正文」，而这个组合在「回来了但是空的」上恒真。 */
    const CASES: [string, RegExp][] = [
      ["components/inspection/FindingCard.tsx", /&&\s*!f\.has_judgment/],
      ["components/InspectionDashboardPanel.tsx", /dispatched\s*&&\s*!hasJudgment/],
    ];
    for (const [f, oldPredicate] of CASES) {
      const raw = read(f);
      /* ⚠️ 否定断言必须**先剥注释** —— 这两个文件的注释里正记着老判据
         长什么样（那是为了让下一个人知道为什么不能那样写）。
         不剥的话这条恒红，而放宽到能绕过注释就抓不到真回归了。 */
      const src = stripComments(raw);
      expect(src.includes("judgementState("), `${f} 不再走共享判据`)
        .toBe(true);
      expect(oldPredicate.test(src),
        `${f} 里「派了 && 没正文」的老判据回来了 —— `
        + "它在「回来了但是空的」上恒真，蓝色等待态永不退出",
      ).toBe(false);
      /* 剥注释的自检：注释里**确实**写着这个串，剥之前必然命中。
         这条防止 stripComments 某天把整个文件吃掉而上面那条恒绿。 */
      expect(oldPredicate.test(raw),
        `${f} 的注释里不再记着老判据 —— 那段「为什么不能这样写」丢了，`
        + "同时上面那条否定断言也失去了自检",
      ).toBe(true);
    }
  });

  it("★★★ 顶部 ⏳ 徽章的判据必须是 state==='pending'", () => {
    /* 老判据 `(judged ?? Boolean(da_task_id)) && !f.has_judgment` 在
       EMPTY / missing_section 上恒真 → 徽章永久挂着，而同一张卡底部
       写着「判读已返回但没有内容」，两处语义相反。 */
    const src = stripComments(read("components/inspection/FindingCard.tsx"));
    expect(/\{state === "pending" && \(/.test(src),
      "徽章判据不是 state==='pending'").toBe(true);
    expect(/&&\s*!f\.has_judgment/.test(src),
      "`!f.has_judgment` 判据回来了 —— 它把终态说成等待态",
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 派发回执与重取 —— 源码级（行为用例在 render.test.tsx）
// ═══════════════════════════════════════════════════════════════════════════
describe("派发之后界面要收敛", () => {
  it("★★★ 抽屉的 detail effect 依赖里必须有判读到达信号", () => {
    /* 🔴 缺它的表现是这条功能的**终点动作**坏掉：判读 1~3 分钟后落库，
       列表 reload 拿到 has_judgment=true，而抽屉四个依赖一个都没变
       → detail 仍是打开那一刻的空 da_body → 显示「还没有判读结果」。
       而 `insp.judge.dispatched` 的文案正是「点右上角刷新查看」。 */
    const src = stripComments(read("components/InspectionDashboardPanel.tsx"));
    const m = /\}, \[row\.finding_id[^\]]*\]\);/.exec(src);
    expect(m, "detail effect 的依赖数组找不到了").not.toBeNull();
    for (const dep of ["row.has_judgment", "row.da_parse_status"]) {
      expect(m![0].includes(dep),
        `依赖里没有 ${dep} —— 判读回来了抽屉不重取`,
      ).toBe(true);
    }
    /* ⚠️ 反过来也钉：不许把整个 `row` 丢进依赖。`row` 每次 reload 都是
       新对象身份，那样抽屉每次列表刷新都重拉一次详情。 */
    expect(/\}, \[row,/.test(src),
      "整个 row 进了依赖 —— 每次列表刷新都会重拉详情",
    ).toBe(false);
  });

  it("★★★ already_dispatched 之后必须 reload", () => {
    /* 不 reload 是个闭环：本地 da_task_id 空 → 按钮可点 → 点 → 后端拒
       already_dispatched → 本地仍然空 → 还可点 → …
       客户能做的只有手动刷新，而提示条里那句话没说要刷新。 */
    const src = stripComments(read("components/InspectionDashboard.tsx"));
    const i = src.indexOf('r.code === "already_dispatched"');
    expect(i, "already_dispatched 那一支不在了").toBeGreaterThan(0);
    const tail = src.slice(i, src.indexOf("    return;", i));
    expect(/reload\(\)/.test(tail), "already_dispatched 之后没有 reload()")
      .toBe(true);
    expect(/setJustJudged/.test(tail),
      "没记乐观状态 —— reload 回来之前按钮还亮着",
    ).toBe(true);
  });

  it("★★★ 派发回执要在抽屉里渲染，且与列表那份互斥", () => {
    /* 🔴 `judgeMsg` 原来只渲染在列表区，而抽屉 zIndex 1000 盖住它、
       派发又只能从抽屉里发起 —— 那条提示 100% 看不见。
       http_403 / kill_switch / conflict 这些永远不会自己变的失败
       在抽屉里就是点了没反应。 */
    const panel = stripComments(read("components/InspectionDashboardPanel.tsx"));
    expect(/judgeMsg\s*&&/.test(panel), "抽屉里没有回执").toBe(true);
    /* 互斥：两处同时渲染的话读屏会把同一句念两遍。 */
    const dash = stripComments(read("components/InspectionDashboard.tsx"));
    expect(/\{judgeMsg && !open && \(/.test(dash),
      "列表区那份没有在抽屉开着时让位 —— DOM 里会有两份同样的回执",
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 金额与评分的诚实性（2026-09-02 review #7）
// ═══════════════════════════════════════════════════════════════════════════
describe("精度分桶（R4.6）", () => {
  it("★★★ 五档顺序与后端 PricePrecision 逐档一致", () => {
    /* 🔴 前端自己写一份顺序 = 两份实现。而这份顺序决定「先动哪台机器」，
       漂开的表现是排序结果与后端报告不一致，而两边都说自己按 R4.6 排了。
       判据从后端 `_PRICE_CONFIDENCE_RANK` **推导**，不手写期望值。 */
    const py = read("../../../inspection/domain/dto.py");
    const i = py.indexOf("_PRICE_CONFIDENCE_RANK: dict[PricePrecision, int] = {");
    expect(i, "后端那张表不在了 —— 这条测试的前提坏了").toBeGreaterThan(0);
    const block = py.slice(i, py.indexOf("}", i));
    const want: Record<string, number> = {};
    for (const m of block.matchAll(/PricePrecision\.(\w+):\s*(\d+)/g)) {
      want[m[1].toLowerCase()] = Number(m[2]);
    }
    expect(Object.keys(want).length, "后端表解析不出来").toBeGreaterThan(3);
    for (const [k, v] of Object.entries(want)) {
      expect(precisionRank(k), `${k} 的桶号与后端不一致`).toBe(v);
    }
  });

  it("★★★ 认不出的档位排**最后**一桶（不是 0）", () => {
    /* 后端加了新档而前端没跟上时，默认成「最可信」会让一个未知来源的数字
       冲到榜首 —— 与 R4.6 要防的那件事完全同型。 */
    for (const s of ["", "brand_new_tier", "EXACT_API"]) {
      expect(precisionRank(s), `${s} 没落到最后一桶`).toBe(PRECISION_RANK_LAST);
    }
    expect(PRECISION_RANK_LAST).toBeGreaterThan(precisionRank("coarse_default"));
  });

  it("★★★ 闲置排序先分桶再比金额", () => {
    /* `dto.py` 的原话：「一个 COARSE_DEFAULT 猜出来的 $1000 会排在一个精确
       算出来的 $200 前面，而客户会照着它去动资源」。
       这一页的排序**就是**处置顺序，所以「谁排第一」等于「先动哪台机器」。 */
    const src = stripComments(read("components/InspectionDashboard.tsx"));
    const i = src.indexOf('if (kind === "idle") {');
    expect(i, "闲置那一支不在了").toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf('if (kind === "structural")', i));
    expect(/precisionRank\(/.test(body),
      "闲置排序完全没看 savings_precision —— 违反 R4.6",
    ).toBe(true);
    // 分桶必须在比金额**之前**
    expect(body.indexOf("precisionRank("),
      "分桶排在比金额之后 —— 那等于没分桶",
    ).toBeLessThan(body.indexOf("return bv - av"));
  });
});

describe("闲置维度标签与后端口径一致", () => {
  const py = () => read("../../../inspection/domain/scoring/idle.py");

  it("★★★ storage 是**剩余**占比，不是已用（方向不能反）", () => {
    /* 🔴 `_norm_storage` 的 docstring：「剩余存储占分配容量的比例越大 →
       存储开得越浪费」，归一化里 `ratio` 直接进分（不取 `1.0 - ratio`）。

       标成「已用」的后果：一台分配 100GB、用了 8GB 的库实测值是 92，
       卡片写「存储已用 92%」→ 客户以为磁盘快满了，而这条 finding 的结论
       恰恰是「存储开太大可以缩」。同一张卡上两句话直接矛盾。 */
    expect(py()).toMatch(/剩余存储占分配容量的比例越大/);
    expect(IDLE_DIM.storage.zh, "storage 标签方向反了").toMatch(/剩余/);
    expect(IDLE_DIM.storage.zh).not.toMatch(/已用/);
    // 与 BASIS_LABEL 那侧同向（它一直是对的：「可用存储比例」）
    expect(BASIS_LABEL.storage_free_ratio.zh).toMatch(/可用/);
  });

  it("★★★ connections 是均值，不是峰值", () => {
    /* `_norm_connections` 读的是 `cand.connections_avg`。
       写成「峰值」会把证据强度说反：「连接数峰值 3」= 最忙也只有 3 个连接
       （很强的删库理由），而实际是日均 3、峰值可能几百。 */
    expect(py()).toMatch(/cand\.connections_avg/);
    expect(IDLE_DIM.connections.zh, "connections 标成了峰值")
      .not.toMatch(/峰值/);
    expect(IDLE_DIM.connections.zh).toMatch(/均/);
  });

  it("★★★ requests 的量纲是每分钟", () => {
    /* `_norm_requests` 的注释：`Average` 统计量在 `period=86400` 下等于
       「那天各 1 分钟数据点的平均值」= 平均每分钟请求数，门槛字段也因此叫
       `requests_per_minute`。光写「请求数」会被读成当日总量 ——
       「请求数 12」按总量是「一天 12 次，几乎没人用」，按真实量纲是
       「每分钟 12 次 ≈ 每天 1.7 万次」，处置动作完全相反。 */
    expect(py()).toMatch(/requests_per_minute/);
    expect(IDLE_DIM.requests.zh, "requests 没标量纲").toMatch(/分钟/);
  });

  it("★★★ IDLE_DIM 的键与后端 WEIGHTS_* 完全一致", () => {
    /* 多写一个键 = 一个永不出现的标签；少写一个 = 那一维显示成原始英文键。
       判据从后端两张权重表推导，不手写。 */
    const src = py();
    const keys = new Set<string>();
    for (const name of ["WEIGHTS_RDS", "WEIGHTS_ELASTICACHE"]) {
      const i = src.indexOf(`${name}:`);
      expect(i, `${name} 不在了`).toBeGreaterThan(0);
      const block = src.slice(i, src.indexOf("}", i));
      for (const m of block.matchAll(/"(\w+)":/g)) keys.add(m[1]);
    }
    expect(keys.size).toBeGreaterThan(3);
    expect(new Set(Object.keys(IDLE_DIM)), "IDLE_DIM 的键与后端权重表不一致")
      .toEqual(keys);
  });
});

describe("idle_score = null 与「分很低」必须分开", () => {
  it("★★★ 闲置类判据不足 → undecided（不退回严重度徽标）", () => {
    /* 🔴 `dto.py::IdleScore.available_weight` 的注释：
       「`idle_score is None` 时展示层 SHALL 显示『监控数据不足，本轮未判定』
         而不是一个数字。早期实现在所有维度都不可用时输出 0，
         而 0 在排序里等于『完全不闲』——『什么都不知道』被呈现成了
         『非常确定不闲』。」
       后端为此专门把 0 改成 `None`，而读侧原来把 `None` 退回灰色的
       「提示」徽标 —— 与低分卡片长得一模一样，那份努力就白费了。 */
    expect(idleBadgeKind({ kind: "idle", idle_score: null })).toBe("undecided");
    expect(idleBadgeKind({ kind: "idle", idle_score: 0 })).toBe("score");
    expect(idleBadgeKind({ kind: "idle", idle_score: 99.3 })).toBe("score");
  });

  it("★★★ 非闲置类的 null 是正常形态 → 退回严重度", () => {
    // 高负载 / 配置检查压根没有闲置分这个概念。
    for (const k of ["high_load", "structural"]) {
      expect(idleBadgeKind({ kind: k, idle_score: null })).toBe("severity");
    }
  });

  it("★★★ 卡片与抽屉走同一个 idleBadgeKind（不许各自判）", () => {
    /* 各自判的表现是同一条 finding 在列表上是「99/100」、点开变成「提示」
       —— 这个文件里那条注释自己写着这件事，而 `null` 那一档又漏了。 */
    for (const f of ["components/inspection/FindingCard.tsx",
      "components/InspectionDashboardPanel.tsx"]) {
      expect(stripComments(read(f)).includes("idleBadgeKind("),
        `${f} 没走共享判据`).toBe(true);
    }
  });

  it("★★★ 后端那条 SHALL 还在（这几条测试的前提）", () => {
    expect(read("../../../inspection/domain/dto.py"))
      .toMatch(/SHALL 显示「监控数据不足，本轮未判定」/);
  });
});

describe("页头合计金额", () => {
  const src = () => stripComments(read("components/InspectionDashboard.tsx"));

  it("★★★ 走 fmtMoney，不自己 Math.round", () => {
    /* 🔴 `Math.round(0.4)` = 0 → 判据 `sum > 0` 为真 → 22px 最醒目的位置
       写着「每月合计可省 $0」。`fmtMoney` 对 (0, 1) 给 `<$1`。
       ⚠️ 这也是全页唯一自己拼 `$` 的地方，卡片那侧一直走 fmtMoney ——
          同一个金额两套格式化就是这类缺陷的来源。 */
    const i = src().indexOf("每月合计可省");
    expect(i, "合计那一段不在了").toBeGreaterThan(0);
    const seg = src().slice(i - 700, i);
    expect(/fmtMoney\(savings\.sum\)/.test(seg), "合计没走 fmtMoney").toBe(true);
    expect(/Math\.round\(savings\.sum\)/.test(seg),
      "又自己 Math.round 了 —— $0.4 会显示成 $0",
    ).toBe(false);
  });

  it("★★★ 粗估要标注（PRECISION_LABEL 里写着「不要拿它做预算」）", () => {
    expect(/savings\.coarse > 0 &&/.test(src()),
      "合计金额没有粗估标注 —— 22px 绿色数字看起来像可入账的数",
    ).toBe(true);
    expect(PRECISION_LABEL.coarse_default.zh).toMatch(/不要拿它做预算/);
  });

  it("★★★ 口径要写清是「待处置全部」而不是当前筛选结果", () => {
    /* 合计基于 `openRows`，列表是 `shown`（受 chip / severity / 搜索词影响）。
       筛掉一半之后金额不变，客户会以为筛选没生效。 */
    const i = src().indexOf("每月合计可省");
    const seg = src().slice(i, i + 200);
    expect(/待处置全部/.test(seg), "合计口径没说明").toBe(true);
  });

  it("★★★ priced === 0 时显示「—」而不是 $0", () => {
    // 判据要是 `priced > 0` 而不是 `sum > 0`：全部估不出价时 sum 是 0，
    // 而那不代表「可省 $0」。
    const i = src().indexOf("fmtMoney(savings.sum)");
    expect(i).toBeGreaterThan(0);
    const seg = src().slice(i - 120, i + 60);
    expect(/savings\.priced > 0/.test(seg),
      "判据用了 sum > 0 —— 全部估不出价时会显示 $0",
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 可访问性的源码级断言（2026-09-02 review #8）
//
// ⚠️ 这几条查的是**源码结构**，所以放在这里而不是 render 测试里 ——
//    那个文件没有读源码的 helper（我先写在那边，四条全 `read is not defined`）。
//    行为能测的那几条（双浮层 Tab / Esc / RowMenu 键盘 / 档位可访问名）
//    在 render 测试里。
// ═══════════════════════════════════════════════════════════════════════════
describe("可访问性：结构约束", () => {
  it("★★★ 浮层键盘只由最上层响应（F1 的根因修复）", () => {
    /* 🔴 `useOverlay` 把 `keydown` 挂在 `document` 上，两层同开时**两个
       handler 都会跑**，各自都想把焦点抢回自己的框里 —— 每按一次 Tab
       焦点都被重置回第一个元素，键盘用户到不了「派发」按钮。
       Esc 同样：一次按键把两层一起关掉。 */
    const src = stripComments(read("components/inspection/ui.tsx"));
    expect(/const overlayStack/.test(src), "没有浮层栈").toBe(true);
    expect(/overlayStack\[overlayStack\.length - 1\] !== box\) return;/.test(src),
      "handler 里没有「只有最上层才响应」的早退",
    ).toBe(true);
    /* 卸载时按**身份**移除，不能 `pop()` —— React 的卸载顺序不保证与挂载
       顺序严格相反（Strict Mode 下会双挂载），`pop()` 会移错人。 */
    expect(/overlayStack\.indexOf\(box\)/.test(src),
      "移除用了 pop() 而不是按身份 —— 会把别人从栈里踢掉",
    ).toBe(true);
    expect(/overlayStack\.pop\(\)/.test(src)).toBe(false);
  });

  it("★★★ body overflow 只在最后一个浮层关闭时还原", () => {
    /* 抽屉+弹层同开时，关掉弹窗就把 `overflow` 还成 `visible` 会让身后的
       页面重新能滚 —— 而抽屉还开着，滚动会把它拖离视口。 */
    const src = stripComments(read("components/inspection/ui.tsx"));
    expect(/overlayStack\.length === 0\) document\.body\.style\.overflow/.test(src),
      "overflow 的还原没判「栈空了」",
    ).toBe(true);
  });

  it("★★★ F3 焦点归还前先确认节点还在文档里", () => {
    /* 焦点来源常常是「点完就不再渲染」的按钮：抽屉里的「深入分析」派发成功后
       整个按钮消失（判据是 `!dispatched`），于是 `.focus()` 打在一个已卸载的
       节点上 —— 静默无效，焦点掉回 `<body>`，Tab 从页面顶端重新开始。
       那正是「焦点归还」本身要防的那件事，只是换了个成因。 */
    const src = stripComments(read("components/inspection/ui.tsx"));
    expect(/document\.contains\(prevFocus\)/.test(src),
      "焦点归还没检查节点还在不在 —— 打在已卸载的节点上是静默无效",
    ).toBe(true);
    // 老写法不许回来（无条件 focus）
    expect(/^\s*prevFocus\?\.focus\?\.\(\);\s*$/m.test(src),
      "无条件 `prevFocus?.focus?.()` 回来了",
    ).toBe(false);
  });

  it("★★★ F2 两种浮层都用 aria-labelledby 指向标题", () => {
    /* `role="dialog"` 没有名字时读屏只念「对话框」—— 而这个产品的对话框
       都是「你确定要让整个账号退出巡检吗」这一类，名字就是全部信息。
       ⚠️ 用 `aria-labelledby` 而不是 `aria-label`：标题是 `ReactNode`，
          复制不出来，而复制得出来的那部分也会随时漂开。 */
    const src = stripComments(read("components/inspection/ui.tsx"));
    const dialogs = src.match(/role="dialog"/g) || [];
    expect(dialogs.length, "dialog 少于两个（Modal + Drawer）")
      .toBeGreaterThanOrEqual(2);
    expect((src.match(/aria-labelledby=\{titleId\}/g) || []).length,
      "有 dialog 没给 aria-labelledby",
    ).toBe(dialogs.length);
    expect(/id=\{titleId\}/.test(src), "标题节点没带那个 id").toBe(true);
  });

  it("★★★ 贡献条有 role=progressbar，值语义报贡献分", () => {
    /* 纯 div 拼的条对读屏是**完全不存在**的 —— 而它是「凭什么说它闲」里
       唯一表达「各维度贡献多少」的东西，剩下四列都是裸数字。 */
    /* ⚠️ **剥注释**：这个文件的注释里正写着「`role="progressbar"` + 值语义」，
       不剥的话把那个属性删掉断言照样绿（反向注入实测 16/17 就是被它漏的）。 */
    const src = stripComments(read("components/InspectionDashboardPanel.tsx"));
    expect(/role="progressbar"/.test(src), "贡献条没有 role").toBe(true);
    /* ⚠️ `aria-valuenow` 报**贡献分**而不是画图用的百分比：后者是相对
       `barMax` 的口径，读出来「87%」而列头写着「贡献分（满格 40）」，
       两个数对不上。 */
    expect(/aria-valuenow=\{fac\.points/.test(src),
      "aria-valuenow 报的不是贡献分",
    ).toBe(true);
    expect(/aria-valuemax=\{Number\(barMax/.test(src),
      "aria-valuemax 没跟着 barMax（RDS 40 / ElastiCache 35 不同）",
    ).toBe(true);
  });

  it("★★★ 所有表头都有 scope=col", () => {
    /* 没有 `scope` 时读屏无法把数据单元格与列关联 —— 一个九列的 runs 表
       念出来是一串没有标签的数字。 */
    for (const f of ["components/InspectionDashboard.tsx",
      "components/inspection/ScopePage.tsx"]) {
      expect(/<th style=\{th\}/.test(read(f)),
        `${f} 里还有不带 scope 的表头`,
      ).toBe(false);
    }
  });

  it("★★★ Badge 的 title 同时映到 aria-label", () => {
    /* 卡片上「粗估 ⓘ」与「少 N 维 ⓘ」的细节此前**只在 `title`** 里，
       而 `title` 是鼠标专属的（键盘与触屏用户永远看不到）。
       那两个细节都直接影响「这个数字能不能信」。 */
    const src = stripComments(read("components/inspection/ui.tsx"));
    expect(/aria-label=\{ariaLabel \?\? title\}/.test(src),
      "Badge 的 title 没映到 aria-label",
    ).toBe(true);
  });

  it("★★★ 闲置分的颜色与档名同源（不许各写一遍阈值）", () => {
    /* 卡片首格与抽屉标题原来各写一遍 `>= 80` / `>= 60`，漂开的表现是
       「同一条 finding 在列表上是红的、点开变成橙的」。 */
    for (const f of ["components/inspection/FindingCard.tsx",
      "components/InspectionDashboardPanel.tsx"]) {
      const src = stripComments(read(f));
      expect(/idleTierColor\(/.test(src), `${f} 的颜色没走 idleTierColor`)
        .toBe(true);
      expect(/idleTierText\(/.test(src), `${f} 没给档名（只靠颜色）`).toBe(true);
      expect(/idle_score >= 80/.test(src),
        `${f} 里又自己写了一遍阈值 —— 与 idleTier 漂开就是「红色的但写着中」`,
      ).toBe(false);
    }
  });

  it("★★★ RowMenu 的禁用项用 tabIndex=-1，不用 disabled", () => {
    /* `disabled` 会让读屏**完全跳过**它，于是「有这一项但不可用，原因是 X」
       这个信息也丢了 —— 而那正是本仓库规矩①要保住的东西。 */
    const src = stripComments(read("components/inspection/ui.tsx"));
    /* ⚠️ 定位那个 **button 元素**，不是 `role="menuitem"` 这个串 ——
       后者在键盘 handler 里作为 `querySelectorAll` 的选择器也出现，而它排在
       更前面。`indexOf` 命中的是选择器，于是切出来的一段里压根没有 `tabIndex`
       （前两版都因此假红：一次是固定 900 字符窗口，一次是切到闭合标签）。 */
    const i = src.indexOf('<button key={it.key} type="button" role="menuitem"');
    expect(i, "RowMenu 的菜单项不在了").toBeGreaterThan(0);
    const seg = src.slice(i, src.indexOf("</button>", i));
    expect(/tabIndex=\{off \? -1 : 0\}/.test(seg), "禁用项还在 tab 序里")
      .toBe(true);
    /* ⚠️ 正则要锚在**属性起始**（前面是空白），否则 `aria-disabled={off …}`
       会被命中 —— 而那一条是**要有**的（它告诉读屏这项不可用）。
       `\b` 不够：`-` 也算单词边界。 */
    expect(/\sdisabled=\{off/.test(seg),
      "用了原生 disabled —— 读屏会跳过它，「为什么不可用」就丢了",
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 死代码不许复活（2026-09-02 review #9）
//
// ⚠️ 这一组与别处不同：它守的是「已经删掉的东西**别回来**」，而删掉的那些
//    在行为上**不可观测**（恒等价的三元、只在类型里的谎、恒假的分支）。
//    反向注入实测这三条把它们加回去，全部测试照样绿 —— 所以只能源码断言。
// ═══════════════════════════════════════════════════════════════════════════
describe("死代码不许复活", () => {
  it("★★ Expandable 的箭头不再有恒等价的三元", () => {
    /* 原来是 `locked ? "▾" : open ? "▾" : "▸"` —— 前两支给的是**同一个字符**。
       `locked` 时恒为展开态（`opsShown = ops || gap > 0`），所以那一支多余。
       留着的害处不是多几个字符，是让读代码的人以为 locked 与 open 在这里
       有语义差别，去找一个不存在的区别。 */
    const src = stripComments(read("components/inspection/ui.tsx"));
    expect(/locked \? "▾" : open \? "▾"/.test(src),
      "恒等价的三元回来了（前两支同一个字符）",
    ).toBe(false);
    expect(/\{open \? "▾" : "▸"\}/.test(src), "箭头判据不在了").toBe(true);
  });

  it("★★★ ScopeData.targets 的类型不许放宽回 ScopeEntry[]", () => {
    /* 🔴 BFF 那一路（`getScope` 里 `out.targets[kind] = …`）**只 map 出五个
       字段**，没有 `expires_at` / `expired` / `reason` / `created_by`。
       声明成 `ScopeEntry[]` 是类型在说谎：tsc 会放行 `targets.high[0].expired`
       而运行时那个值恒为 `undefined` —— 「这条过期了没」永远读成「没过期」，
       且没有任何编译期信号。

       ⚠️ 判据同时查 BFF 那侧 map 出的字段数：将来 BFF 补齐了字段，
          这条会红，那时该做的是把类型放宽回去（而不是删掉这条断言）。 */
    const api = stripComments(read("api/inspection.ts"));
    expect(/targets: Record<"high" \| "idle", ScopeTarget\[\]>/.test(api),
      "targets 的类型被放宽了 —— 声明比 BFF 实际返回的宽",
    ).toBe(true);
    expect(/interface ScopeTarget/.test(api), "ScopeTarget 不在了").toBe(true);

    const bff = read("../../../bff/web-chat/inspection.mjs");
    const i = bff.indexOf("out.targets[kind] = keep(");
    expect(i, "BFF 那一路不在了 —— 这条断言的前提坏了").toBeGreaterThan(0);
    const seg = bff.slice(i, bff.indexOf("}));", i));
    for (const gone of ["expires_at", "expired", "reason", "created_by"]) {
      expect(seg.includes(gone),
        `BFF 现在也返回 ${gone} 了 —— 那 ScopeTarget 该放宽回 ScopeEntry`,
      ).toBe(false);
    }
  });

  it("★★ 详情的 403 判据不再查 forbidden_kind（恒假）", () => {
    /* BFF 那条是 `json(403, {code: "forbidden_kind"})`，而
       `api/inspection.ts::get()` 对任何非 2xx 一律把 `code` 覆写成
       `"http_" + r.status` —— 响应体里的 `code` 到不了消费点。
       留着会让人以为多了一道防线。 */
    const panel = stripComments(read("components/InspectionDashboardPanel.tsx"));
    expect(/forbidden_kind/.test(panel),
      "恒假的 forbidden_kind 判据回来了",
    ).toBe(false);
    // 真正生效的那一半必须在
    expect(/d\.code === "http_403"/.test(panel), "403 分支不在了").toBe(true);
    // 前提：`get()` 确实覆写 code（它变了的话上面那条推理就不成立）
    expect(/code: "http_" \+ r\.status/.test(stripComments(read("api/inspection.ts"))),
      "`get()` 不再覆写 code —— 那 forbidden_kind 可能重新可达，"
      + "这条断言要重新想",
    ).toBe(true);
  });
});
