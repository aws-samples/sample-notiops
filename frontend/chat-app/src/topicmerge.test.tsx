/**
 * 「安全」并入「调查」这次合并的回归契约（2026-09-11）。
 *
 * 合并做了两件事，两件都是"改错了不报错、只是能力悄悄退回去"的类型：
 *   ① **安全不再是聊天主题**。它的聊天能力本来是 investigate 的真子集（agent 侧
 *      `_TOPIC_FOCUS` 没有 security 这一项，工具只挂 core 8 个 vs investigate 22 个），
 *      所以留着它等于让客户在「安全」里问安全问题拿到更差的答案。库里那些
 *      `topic:"security"` 的老会话**永远改不掉**（写入带 `attribute_not_exists(SK)`，
 *      没有任何接口能改 topic），只能在**读**的时候归一 → `normalizeTopic`。
 *   ② 安全**看板**保留，改由调查输入框上方那行**粗粒度**胶囊进入。
 *      粗粒度是产品明确要求的：胶囊只有「运行概览 / 安全态势」两颗，点进去才是原来那棵树；
 *      以后往树里加面板不许在这一行加胶囊。**单行不换行** —— 换行会把输入框往下推。
 *
 * 同一天又跟了三条产品要求，也钉在这里（它们改错了同样不报错）：
 *   ③ 侧栏**去掉「安全」这一项**（看板只从胶囊进）—— 见 Sidebar.nav.test.tsx；
 *   ④ 这一行必须与聊天框左对齐，**空态也一样**（原来空态是居中的）；
 *   ⑤ 成本 / 案例两个主题也改用同一行胶囊（原来是另一套「打开 Dashboard」标签），
 *      并且整行**不再有**前导的「仪表盘」图标+文字标签。
 *
 * 这里钉的东西，类型系统一个都抓不到：
 *   · `ConversationSummary.topic` 是 `string`，水合处 `as TopicKey` 硬转 —— 漏掉归一编译照过；
 *   · 门禁是布尔表达式，侧栏与胶囊各写一份，漂了也编译通过（后果是"侧栏没有安全入口、
 *     输入框上方却有"这种自相矛盾的界面）；
 *   · `flex-wrap` 是 CSS，改成 wrap 没有任何编译期信号。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { normalizeTopic, topicDef, TOPICS } from "./types";

vi.mock("./api/chat", () => ({
  getCasesSummary: () => Promise.resolve(null),
  getDeepInvestigationAvailability: () => Promise.resolve({ available: true }),
}));
vi.mock("./api/skills", () => ({
  listSkills: () => Promise.resolve([]),
  skillDisplay: (s: { name: string }) => ({ name: s.name, description: "" }),
  isPresetSkill: () => false,
}));
vi.mock("./models", () => ({
  useModelCatalog: () => ({
    models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
    defaultModel: "claude-sonnet-5", fromServer: true, loading: false,
    source: "ddb", canSend: true, canSendWithoutModel: true,
  }),
}));

import Composer from "./components/Composer";
// 源码级断言读的是 `?raw` 文本，不是 node:fs —— tsconfig.app.json 只带 `vite/client`
// 类型（不含 node），用 fs 会让 `npm run build` 的 tsc 阶段直接报 TS2307。
import chatAppSrc from "./pages/ChatApp.tsx?raw";
import stylesSrc from "./styles.css?raw";
import { STRINGS } from "./i18n";

/**
 * 剥掉 CSS 注释后的样式表 —— 所有"某条规则不许存在"的断言都必须用这个。
 * 用原文会假 fail：这次删掉的每一条（`.empty-center .dashpills` / `.cbox-tab` /
 * `.dashpills-label`）都在原地留了一段注释**写着它自己的名字**说明为什么删，
 * 那正是最该留的东西，不能为了让正则过而把注释删掉。
 */
const css = stylesSrc.replace(/\/\*[\s\S]*?\*\//g, "");

afterEach(cleanup);

describe("normalizeTopic（退役主题读时改写）", () => {
  it("把老会话的 security 改写成 investigate", () => {
    expect(normalizeTopic("security")).toBe("investigate");
  });

  // 这三条恰好说明了为什么必须归一：不归一的话顶栏主题 tag 直接消失（topicDef 返回
  // undefined），侧栏分组回落到「通用」灰 tag，chip 池回落到 general —— 全静默。
  it("security 已经不在主题注册表里（所以不归一就会静默降级）", () => {
    expect(TOPICS.map((t) => t.key)).not.toContain("security");
    expect(topicDef("security")).toBeUndefined();
    expect(topicDef(normalizeTopic("security"))).toBeDefined();
  });

  it("在册主题原样返回", () => {
    for (const k of ["investigate", "finops", "cases", "whats-new"]) {
      expect(normalizeTopic(k)).toBe(k);
    }
  });

  // 前端这一层**必须**回落到一个合法 TopicKey（它的返回值直接进 `topicDef` / chip 池 /
  // 侧栏分组）。这与 BFF 侧刻意"原样透传未知值"不是矛盾：那边归一的是发给 agent 的
  // payload，突然对 topic 做 allowlist 会把老客户端打死（见 bff/web-chat/topic.mjs）。
  it("未知值与空值回落 general", () => {
    expect(normalizeTopic("security-posture")).toBe("general");
    expect(normalizeTopic("")).toBe("general");
    expect(normalizeTopic(undefined)).toBe("general");
  });
});

describe("归一接在了会话水合处", () => {
  // 只在**水合**那一处归一（读 DynamoDB 的会话头时），而不是散在每个消费点上：
  // 一旦 state 里存的是归一后的值，顶栏 tag / 侧栏分组 / chip 池 / 发给 BFF 的 topic
  // 就全都一致了。漏一个消费点就会出现"tag 显示调查、发出去还是 security"。
  it("ChatApp 从 types 引入并在水合会话时调用", () => {
    expect(chatAppSrc).toContain("normalizeTopic");
    expect(chatAppSrc).toMatch(/normalizeTopic\(c\.topic\)/);
  });
});

// ── 输入框上方那行「仪表盘」胶囊 ────────────────────────────────────────────────
function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return render(
    <Composer model="claude-sonnet-5" onModelChange={() => {}} onSend={() => {}} busy={false}
      showSuggestions={false} topic="investigate" {...props} />,
  );
}

const Dot = () => <svg />;

describe("「仪表盘」胶囊行（Composer）", () => {
  it("传了 dashPills 才渲染那一行，且**只有**胶囊、没有前导标签", () => {
    const ops = vi.fn(), sec = vi.fn();
    const { container } = renderComposer({
      dashPills: [
        { key: "ops", label: "运行概览", Icon: Dot, onClick: ops },
        { key: "security", label: "安全态势", Icon: Dot, onClick: sec },
      ],
    });
    const row = container.querySelector(".dashpills");
    expect(row, "调查主题没有渲染 .dashpills 那一行").not.toBeNull();
    expect(row!.querySelectorAll(".dashpill").length).toBe(2);
    // 2026-09-11 产品要求去掉行首那个「仪表盘」图标+文字标签：胶囊名字（运行概览 /
    // 安全态势 / …）本身就说清了是什么，再加一个分类词只占掉输入框上方本来就紧的横向空间。
    // 钉住两头：DOM 里没有那个节点，行里也不该冒出「仪表盘 / Dashboards」这几个字
    //（有人可能直接把文字塞进 div 而不建 .dashpills-label）。
    expect(row!.querySelector(".dashpills-label")).toBeNull();
    expect(row!.textContent || "").not.toMatch(/仪表盘|Dashboards/);
    // 这一行的子节点应当**清一色**是胶囊 —— 混进别的东西就是又在往这行加说明文字。
    expect([...row!.children].every((el) => el.classList.contains("dashpill"))).toBe(true);
  });

  it("点胶囊触发它自己的 onClick（不是发消息）", () => {
    const ops = vi.fn(), sec = vi.fn();
    renderComposer({
      dashPills: [
        { key: "ops", label: "运行概览", Icon: Dot, onClick: ops },
        { key: "security", label: "安全态势", Icon: Dot, onClick: sec },
      ],
    });
    screen.getByText("安全态势").click();
    expect(sec).toHaveBeenCalledTimes(1);
    expect(ops).not.toHaveBeenCalled();
  });

  // 不传 / 传空数组都不渲染 —— 空数组要单独钉：`dashPillsFor` 在门禁把该主题的胶囊全挡掉时
  // 返回 undefined，但只要哪天改成 `return pills`，`{pills && …}` 就会渲染出一行空容器
  //（现在没有前导标签了，看不见，但它带 margin-bottom:10px，会凭空多出 10px 空隙）。
  it("没传 dashPills（如通用主题）与传空数组都不渲染", () => {
    const { container } = renderComposer({ topic: "general" });
    expect(container.querySelector(".dashpills")).toBeNull();
    cleanup();
    const empty = renderComposer({ dashPills: [] });
    expect(empty.container.querySelector(".dashpills")).toBeNull();
  });
});

describe("胶囊行的门禁与形态（源码级）", () => {
  // 有侧栏兄弟的那几颗，门禁必须与侧栏**逐字一致**，否则会出现"侧栏没有这个入口、
  // 输入框上方却有"（或反过来）。出现 2 次 = 胶囊一处 + 侧栏 props 一处。
  // ⚠️ 先剥掉整行 `//` 注释：`dashPillsFor` 上面那段注释把这些表达式**原文抄了一遍**
  //    （那是有意的，讲 fail-open / fail-closed 的差别），不剥就会数多。
  it("有侧栏兄弟的胶囊，门禁与侧栏逐字一致", () => {
    const code = chatAppSrc.replace(/^\s*\/\/.*$/gm, "");
    for (const [what, re] of [
      ["运行概览", /!capsLoaded \|\| can\("nav:investigate"\)/g],
      ["支出与优化", /!capsLoaded \|\| can\("nav:finops"\)/g],
      ["案例进展", /!capsLoaded \|\| can\("nav:cases"\)/g],
    ] as const) {
      expect((code.match(re) || []).length, `${what} 的门禁应在「胶囊」与「侧栏」各出现一次且写法完全相同`).toBe(2);
    }
  });

  // 安全是**唯一没有侧栏兄弟**的一颗：2026-09-11 侧栏去掉了「安全」，看板只能从胶囊进。
  // 所以这条门禁在本文件里只剩一次 —— 数成 2 说明有人把侧栏入口补回来了。
  it("安全的门禁只剩胶囊一处（侧栏已无「安全」入口）", () => {
    const code = chatAppSrc.replace(/^\s*\/\/.*$/gm, "");
    const sec = code.match(/isAdmin \|\| \(capsLoaded && can\("nav:security"\)\)/g) || [];
    expect(sec.length, "安全门禁只该出现在 dashPillsFor 里（侧栏不再有安全入口）").toBe(1);
    // 侧栏那三条 prop 必须一个都不传（Sidebar 里也已删，多传会直接 tsc 报错，
    // 但源码断言能在有人"顺手加回 prop 定义"时先红）。
    expect(code).not.toMatch(/showSecurity/);
    expect(code).not.toMatch(/securityActive/);
  });

  // 有看板的主题**只走胶囊**这一套入口：renderThemeLanding 不再接第二个参数（旧的
  // openDash → Composer 的 onOpenDashboard → 紧贴输入框左上角那个「打开 Dashboard」标签）。
  // 两套入口同时挂上，输入框上方就会出现两行互相竞争的"仪表盘"；而且那个标签名根本
  // 没说清点进去是什么。2026-09-11 成本 / 案例也从标签改成了胶囊，这条 prop 已删。
  it("三个有看板的主题都不传 openDash，Composer 里也不再有 onOpenDashboard", () => {
    for (const k of ["investigate", "finops", "cases"]) {
      expect(chatAppSrc).toContain(`renderThemeLanding("${k}")`);
      expect(chatAppSrc, `${k} 又被传了第二个参数（openDash）`)
        .not.toMatch(new RegExp(`renderThemeLanding\\("${k}",`));
    }
    // 注释里提到这个名字是允许的（讲它为什么删了），所以先剥注释再断言。
    const code = chatAppSrc.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code).not.toMatch(/onOpenDashboard/);
    // 那三条 CSS 也不许留着（留着就是给复活铺路）。
    expect(css).not.toMatch(/^\.cbox-tabs?\s*[,{]/m);
    expect(css).not.toMatch(/\.cbox\.has-tab/);
  });

  // 行首那个「仪表盘」标签的 CSS 也要一起删干净 —— 留着规则、只删 JSX，下一个人看到
  // 一条孤零零的 `.dashpills-label` 会以为是漏渲染的 bug，顺手把节点"补"回来。
  it("`.dashpills-label` 的 CSS 也删了", () => {
    expect(css).not.toMatch(/\.dashpills-label/);
  });

  // 产品明确要求「单行不换行」。改成 wrap 没有任何编译期信号，只会在窄屏上把输入框往下推。
  it("单行不换行：.dashpills 是 nowrap + 横向滚动", () => {
    // 行首锚定（`m` 标志）：历史上曾另有一条 `.empty-center .dashpills { … }`（已删，
    // 见下一条），锚定是为了以后再出现同类覆盖规则时不会误配到那一条上。
    const rule = css.match(/^\.dashpills\s*\{([^}]*)\}/m);
    expect(rule, "styles.css 里找不到 .dashpills 规则").not.toBeNull();
    expect(rule![1]).toMatch(/flex-wrap:\s*nowrap/);
    expect(rule![1]).not.toMatch(/flex-wrap:\s*wrap/);
    expect(rule![1]).toMatch(/overflow-x:\s*auto/);
  });

  // 2026-09-11 产品要求：这一行必须与聊天框（.cbox）左对齐 —— **空态也一样**。
  // 之前有一条 `.empty-center .dashpills { justify-content: center }` 把它在主题主页上
  // 居中了。为什么钉源码而不是渲染：jsdom 不做布局，`getBoundingClientRect()` 全返回 0，
  // 渲染断言在这件事上恒真，抓不到任何回归。
  it("左对齐：.dashpills 没有任何 justify-content（空态也不许居中）", () => {
    const rule = css.match(/^\.dashpills\s*\{([^}]*)\}/m);
    expect(rule![1], ".dashpills 自己不该写 justify-content（默认 flex-start 就贴着 .cbox 左边缘）")
      .not.toMatch(/justify-content/);
    // 关键是**任何**选择器都不许给它加居中（`.empty-center .dashpills`、
    // `.home .dashpills`、媒体查询里的……）。所以在整份 CSS 里搜"含 .dashpills 的规则块"。
    const blocks = css.match(/[^{}]*\.dashpills[^{}]*\{[^}]*\}/g) || [];
    for (const b of blocks) {
      expect(b, `这条规则给胶囊行加了 justify-content，会让它在空态飘到中间：\n${b}`)
        .not.toMatch(/justify-content/);
    }
  });
});

// ── 四颗胶囊的名字与图标颜色（2026-09-11 第二轮产品要求）─────────────────────────
//
// 第一版四个都叫「XX 态势」，客户原话「我发现取的 dashboard 名字都是 XX 态势」——
// 整齐但三个是硬套。第二轮只保留「安全态势」（posture 在安全语境是行业术语，
// CSPM = Cloud Security **Posture** Management），另外三个按各自看板的语义内核重取。
// 这两条断言防的是同一类回归：**下一个人觉得"不整齐"，顺手又统一回同一个词尾**。
// 类型系统抓不到（都是 string），界面上也不会报错，只会又变成客户已经否掉的样子。
describe("胶囊名字：刻意不共用同一个词尾", () => {
  const PILLS = ["dash.pill.ops", "dash.pill.security", "dash.pill.cost", "dash.pill.cases"] as const;

  it("四个 key 中英都在", () => {
    for (const k of PILLS) {
      expect(STRINGS[k], `${k} 缺了`).toBeTruthy();
      expect(STRINGS[k].zh, `${k} 缺中文`).toBeTruthy();
      expect(STRINGS[k].en, `${k} 缺英文`).toBeTruthy();
    }
  });

  it("只有安全叫「态势」，其余三个都不许再是「XX 态势」", () => {
    expect(STRINGS["dash.pill.security"].zh).toBe("安全态势");
    for (const k of ["dash.pill.ops", "dash.pill.cost", "dash.pill.cases"] as const) {
      expect(STRINGS[k].zh, `${k} 又被统一成「XX 态势」了 —— 客户明确否过这个词尾`)
        .not.toMatch(/态势$/);
    }
  });

  it("英文同理：只有安全用 posture（`Case posture` 这种英文里不成立）", () => {
    expect(STRINGS["dash.pill.security"].en.toLowerCase()).toContain("posture");
    for (const k of ["dash.pill.ops", "dash.pill.cost", "dash.pill.cases"] as const) {
      expect(STRINGS[k].en.toLowerCase(), `${k} 的英文又套上 posture 了`).not.toContain("posture");
    }
  });
});

// 客户原话「这些 dashboard 前面的图标，不需要有颜色」。全链路唯一能给它上色的地方就是
// 这里：icons.tsx 里没有任何硬编码色值（全是 currentColor），看板浏览器左栏那些图标本来
// 就是 --muted / 选中态 --text。所以"图标不上色"这件事等价于"styles.css 里没有任何
// 针对 .dashpill 内 svg 的 color 声明"，删掉的那条原文是
// `.dashpill svg:first-of-type { color: var(--orange) }`。
describe("胶囊左边那个图标不上色", () => {
  it("没有任何规则给 .dashpill 里的 svg 写 color", () => {
    const blocks = css.match(/[^{}]*\.dashpill[^{}]*svg[^{}]*\{[^}]*\}/g) || [];
    for (const b of blocks) {
      const body = b.slice(b.indexOf("{") + 1, b.lastIndexOf("}"));
      const props = body.split(";").map((d) => d.split(":")[0].trim().toLowerCase());
      // 只挑 `color` 本身 —— `border-color` / `background-color` 不算（它们是胶囊边框/底色，
      // 跟图标颜色是两回事），所以用精确相等而不是 includes("color")。
      expect(props, `这条规则又给胶囊图标上色了：\n${b}`).not.toContain("color");
    }
  });

  it("层次仍然靠 opacity 拉开（右边那个箭头是半透明的）", () => {
    // 上一条把颜色拿掉了，如果这条也被顺手删掉，两个 svg 就会一模一样、看不出主次。
    const rule = css.match(/\.dashpill\s+svg:last-of-type\s*\{([^}]*)\}/);
    expect(rule, "`.dashpill svg:last-of-type` 的 opacity 规则不见了").not.toBeNull();
    expect(rule![1]).toMatch(/opacity:\s*\.?0?\.?5/);
  });
});
