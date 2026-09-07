/**
 * 管理页「账号」那一屏的**渲染**测试（2026-08-30 新增）。
 *
 * `AdminPanel.tsx` 2000+ 行、此前**零测试**，而这一屏上有几个
 * 「不显示就完全静默」的信号。第一个补上守卫的是「待更新栈」徽章：
 *
 * ```
 * 不显示它 → 存量账号不知道要重新部署栈
 *          → 采集照跑（enabled_accounts 读 da# 行，与巡检字段无关）
 *          → 花 GetMetricData、而判读永远为空
 *          → 看板上「N 条未做根因分析」与「DA 说这些没问题」长得一样
 * ```
 *
 * 🔴 **为什么不能用「查源码子串」代替**（`inspection.render.test.tsx` 已经
 *    记过同款）：标识符还在文件里、只是不起作用了，子串检查照过。
 *    这里具体是：把 `{a.needsStackUpdate && (` 改成 `{false && (`
 *    —— `needsStackUpdate` 这个词在紧邻的注释里还有，源码断言抓不到。
 *    2026-08-30 实测：这四种注入本文件全部抓住。
 *
 * ⚠️ 后端那侧的判据（哪些账号该报）有 6 行真值表钉在
 *    `bff/web-chat/tests/manual_onboard_flow.test.mjs`。本文件只管
 *    「后端说该报，UI 报了吗」这一跳 —— 两侧缺一不可：
 *      判据对 + UI 不显示 = 静默
 *      判据错 + UI 显示   = 噪音（对所有账号都报，客户会学会忽略它）
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemberAccountRec } from "./api/admin";

// ⚠️ mock 必须在被测组件 import **之前**生效。`vi.mock` 会被提升，
//    但工厂函数里不能引用外部变量（提升后还没初始化）。
vi.mock("./api/admin", async (orig) => {
  const real = await orig<typeof import("./api/admin")>();
  return {
    ...real,
    fetchMemberAccounts: vi.fn(),
    // ⚠️ 写入的那几个也要 mock —— 不 mock 会走真的 `signedClient()`，
    //    jsdom 里拿不到凭证于是恒返回 not_authenticated：测试会「通过」
    //    而什么都没验证到（这是 inspection.render.test.tsx 记过的坑）。
    onboardMemberAccount: vi.fn(),
    memberOnboardStatus: vi.fn(),
    setMemberAccountEnabled: vi.fn(),
    setMemberAccountRegions: vi.fn(),
    setMemberAccountAlias: vi.fn(),
    offboardMemberAccount: vi.fn(),
    fetchAccountAccess: vi.fn(),
    putAccountAccess: vi.fn(),
    generateLaunchStack: vi.fn(),
  };
});

// 账号页首屏还会拉一次全局配置（拿 console 深链）。让它安静地成功即可 ——
// 组件里那处是 `.catch(() => {})`。
vi.mock("./config", async (orig) => {
  const real = await orig<typeof import("./config")>();
  return { ...real, loadConfig: vi.fn() };
});

const admin = await import("./api/admin");
const cfg = await import("./config");
const { AccountsView } = await import("./components/AdminPanel");

/** 一条「已接入、active、跑得好」的账号行。
 *
 * ⚠️ `name` 刻意留空：行首渲染的是 `{a.name || a.accountId}`，name 有值时
 *    账号号只出现在第二行、与邮箱和 region 混在同一个文本节点里，
 *    `queryByText(accountId)` 找不到。留空让账号号成为独立文本节点。
 */
const OK: MemberAccountRec = {
  accountId: "012345678901",
  name: "",
  email: "member+02@example.test",
  onboarded: true,
  enabled: true,
  orgOnboardStatus: "ACTIVE",
  regions: ["ap-northeast-1"],
  devopsAgentStatus: "active",
  needsStackUpdate: false,
  onboardSource: "",
} as MemberAccountRec;

const resp = (items: MemberAccountRec[]) => ({
  items, orgListable: true, oneClickOnboard: true,
});

beforeEach(() => {
  vi.mocked(cfg.loadConfig).mockResolvedValue({} as never);
  // ⚠️ 这一屏下半部分是「数据可见性」，它自己也拉一次 —— 不 mock 会走真的
  //    `signedClient()`，jsdom 里拿不到凭证 → 组件进错误态 → 上半部分的
  //    账号列表可能压根不渲染，而测试会「通过」（找不到徽章 == 断言成立）。
  vi.mocked(admin.fetchAccountAccess).mockResolvedValue([] as never);
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("「待更新栈」徽章", () => {
  it("★★★ 后端说要更新 → 徽章渲染出来", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([{ ...OK, needsStackUpdate: true }]) as never);
    render(<AccountsView />);
    // 中英都可能（i18n 跟随浏览器 locale），两个都接受
    await waitFor(() => {
      const hit = screen.queryByText("待更新栈")
        || screen.queryByText("Stack update needed");
      expect(hit,
        "needsStackUpdate=true 但徽章没渲染 —— 存量账号不知道要重新部署栈，"
        + "而采集照跑、判读永远为空。管理页是唯一能看出这件事的地方",
      ).not.toBeNull();
    });
  });

  it("★★★ 徽章带 title 说明（四个字说不清「为什么」和「怎么做」）", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([{ ...OK, needsStackUpdate: true }]) as never);
    render(<AccountsView />);
    await waitFor(() => {
      const el = screen.queryByText("待更新栈")
        || screen.queryByText("Stack update needed");
      expect(el).not.toBeNull();
      const title = el!.getAttribute("title") || "";
      // ⚠️ 断「有实质长度」而不是断具体文案 —— 文案会改。而
      //    「i18n key 缺失时 t() 原样返回 key」这种情况长度也够，
      //    所以再排除「title 就是那个 key 本身」。
      expect(title.length, "徽章没有 title —— 客户只看到四个字").toBeGreaterThan(20);
      expect(title, "title 是 i18n key 本身（那个 key 没定义）")
        .not.toContain("admin.accounts.needsUpdate");
    });
  });

  it("★★★ needsStackUpdate=false → 徽章**不**渲染（否则对所有账号都报）", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([{ ...OK, needsStackUpdate: false }]) as never);
    render(<AccountsView />);
    // 🔴 等列表真的渲染出来了**再**断「没有徽章」—— 否则「还没加载完」
    //    与「加载完了但不显示」长得一样，这是这条断言最容易假绿的地方。
    await waitFor(() => {
      expect(screen.queryByText("012345678901")).not.toBeNull();
    });
    expect(screen.queryByText("待更新栈")).toBeNull();
    expect(screen.queryByText("Stack update needed")).toBeNull();
  });

  it("★★ 字段缺失（老后端）→ 徽章不渲染，也不报错", async () => {
    const noField = { ...OK } as Record<string, unknown>;
    delete noField.needsStackUpdate;
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([noField as unknown as MemberAccountRec]) as never);
    render(<AccountsView />);
    await waitFor(() => {
      expect(screen.queryByText("012345678901")).not.toBeNull();
    });
    expect(screen.queryByText("待更新栈")).toBeNull();
  });

  it("★★★ 混合列表：只给该报的那一行报", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(resp([
      { ...OK, accountId: "111111111111", needsStackUpdate: false },
      { ...OK, accountId: "222222222222", needsStackUpdate: true },
      { ...OK, accountId: "333333333333", needsStackUpdate: false },
    ]) as never);
    render(<AccountsView />);
    await waitFor(() => {
      expect(screen.queryByText("222222222222")).not.toBeNull();
    });
    const badges = screen.queryAllByText("待更新栈").length
      + screen.queryAllByText("Stack update needed").length;
    expect(badges,
      `3 行里应该只有 1 个徽章，实际 ${badges} 个 —— `
      + "多了是噪音（客户会学会忽略它），少了是静默",
    ).toBe(1);
  });
});

describe("「组织外」徽章与一键接入按钮", () => {
  /* 🔴 跨 org 接入的账号（实例：111122223333 属于 o-aaaabbbbcc，
   *    而部署账号 444455556666 属于 o-ddddeeeeff）此前**永远不出现在列表里**
   *    —— 后端只列 `organizations:ListAccounts` 返回的账号。
   *    而它照常被巡检扇出（`enabled_accounts` 读 `da#accounts` GSI，与 org
   *    无关），手动接入流程也全绿、页面提示「已保存并激活」。
   *    ⇒ 「工作了但完全不可观测、不可运维」。
   *
   * ⚠️ 后端那侧（把它合并进 items + 打 outOfOrg 标记）有 7 条断言钉在
   *    `bff/web-chat/tests/manual_onboard_flow.test.mjs`。本文件管这一跳。
   */
  const OUT = { ...OK, accountId: "111122223333", outOfOrg: true,
                onboardSource: "manual" } as MemberAccountRec;

  it("★★★ outOfOrg 的账号渲染「组织外」徽章", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([OUT]) as never);
    render(<AccountsView />);
    await waitFor(() => {
      const hit = screen.queryByText("组织外")
        || screen.queryByText("Outside organization");
      expect(hit,
        "组织外账号没有任何标记 —— 运维会以为列表串了账号，"
        + "或者反复去点那个对它无效的一键接入按钮",
      ).not.toBeNull();
    });
  });

  it("★★★ 一键接入按钮对组织外账号**不渲染**（StackSet 覆盖不到它）", async () => {
    // 这一行满足按钮的其余条件：oneClick=true、非 PROVISIONING、未 enabled
    const pending = { ...OUT, onboarded: false, enabled: false,
                      orgOnboardStatus: "" } as MemberAccountRec;
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([pending]) as never);
    render(<AccountsView />);
    await waitFor(() => {
      expect(screen.queryByText("组织外")
        || screen.queryByText("Outside organization")).not.toBeNull();
    });
    const btn = screen.queryByText("一键接入") || screen.queryByText("Onboard");
    expect(btn,
      "组织外账号渲染了一键接入按钮 —— 点了会拿到 StackSet 侧的错，"
      + "而正确做法是走底部的「跨 Payer 接入」重新生成链接",
    ).toBeNull();
  });

  it("★★★ 反例：组织内的同样状态**要**渲染一键接入按钮", async () => {
    const inOrg = { ...OK, outOfOrg: false, onboarded: false, enabled: false,
                    orgOnboardStatus: "" } as MemberAccountRec;
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([inOrg]) as never);
    render(<AccountsView />);
    await waitFor(() => {
      expect(screen.queryByText("012345678901")).not.toBeNull();
    });
    const btn = screen.queryByText("一键接入") || screen.queryByText("Onboard");
    expect(btn, "把组织内账号的一键接入也挡掉了 —— 那是主路径").not.toBeNull();
  });

  it("★★ 组织内账号不渲染「组织外」徽章", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([{ ...OK, outOfOrg: false }]) as never);
    render(<AccountsView />);
    await waitFor(() => {
      expect(screen.queryByText("012345678901")).not.toBeNull();
    });
    expect(screen.queryByText("组织外")).toBeNull();
    expect(screen.queryByText("Outside organization")).toBeNull();
  });
});

describe("巡检 Agent Space ID 的标签不能说「可选」", () => {
  /* 🔴 2026-08-31 实机接入时用户明确反馈「我被误导了」。
   *
   *    「可选」只对一种人成立：栈是**旧版**、Outputs 里没有
   *    `InspectionAgentSpaceId`。而任何部署**当前**模板的人，那个 Output 就在
   *    栈的 Outputs 页上 —— 对他们是必填，留空唯一的效果是把这个账号的
   *    AI 判读整个关掉。
   *
   *    而留空是**静默**的：写侧不拒、不 warning。表现是 finding 照出、
   *    每条旁边的判读永远空着，而看板上「判读为空」与「DA 说这条没问题」
   *    长得一样。
   *
   * ⚠️ 这条查的是 i18n 文案，不是渲染 —— 因为「跨 Payer 接入」那个区块要
   *    先展开、再输入账号号、再点生成链接才会出现那个字段，
   *    而那条路径依赖真 CFN 调用。文案层面钉住就够：判据是「标签不含可选、
   *    含必填」+「提示里说清留空的后果」。
   */
  it("★★★ 标签是「必填」而不是「可选」", async () => {
    const { STRINGS } = await import("./i18n");
    const label = STRINGS["admin.xpayer.inspectSpaceLabel"];
    expect(label, "i18n key 不在了").toBeTruthy();
    expect(label.zh).not.toContain("可选");
    expect(label.zh).toContain("必填");
    expect(label.en.toLowerCase()).not.toContain("optional");
    expect(label.en.toLowerCase()).toContain("required");
  });

  it("★★★ 提示里必须说清留空的后果是「判读永远空着」", async () => {
    const { STRINGS } = await import("./i18n");
    const hint = STRINGS["admin.xpayer.inspectSpaceHint"];
    expect(hint).toBeTruthy();
    // 🔴 光说「不做 AI 判读」不够 —— 客户不知道那在界面上长什么样。
    //    必须点明它与「没问题」不可区分，那才是这条的真正危害。
    expect(hint.zh, "提示没说清留空后在看板上长什么样").toMatch(/长得一样|分不清|看不出/);
    // 两个 space 不是一个东西，这句也不能丢（贴错的后果更严重）
    expect(hint.zh).toMatch(/两个不同|不同的值/);
    // 旧模板那条例外要留着 —— 否则存量客户以为自己填错了
    expect(hint.zh).toMatch(/旧版|旧模板/);
  });
});

describe("账号 alias（显示名）", () => {
  /* 🔴 `account_name` / `da#.account_alias` 此前**只在接入那一刻写一次**，
   *    来源是 `organizations:DescribeAccount` 的 `Account.Name`。
   *    跨组织接入的账号那个调用拿不到东西（账号不在本组织里）→ 两个字段都空
   *    → 客户在账号选择器和 IM 推送里看到的是**十二位数字**。
   *
   * ⚠️ 后端那侧（两行一起写、alias_source 的优先级、64 字 / 纯数字 / 控制字符
   *    三道校验）有 54 条断言钉在
   *    `bff/web-chat/tests/alias_and_batch_run.test.mjs`。本文件只管这两跳：
   *      · 「自定义名」徽章显示了没有
   *      · 「改名」输入框的**预填**对不对（这一条是真会造成静默损坏的那个）
   */
  it("★★★ aliasManual=true → 渲染「自定义名」徽章", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([{ ...OK, name: "生产-游戏1", aliasManual: true }]) as never);
    render(<AccountsView />);
    await waitFor(() => {
      const hit = screen.queryByText("自定义名")
        || screen.queryByText("Custom name");
      expect(hit,
        "人手起的名字没有任何标记 —— 排查跨账号问题时运维会拿它去 "
        + "Organizations 里搜，而那里没有这个名字",
      ).not.toBeNull();
    });
  });

  it("★★★ aliasManual=false → **不**渲染徽章（否则对所有账号都报）", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([{ ...OK, name: "org-account-name", aliasManual: false }]) as never);
    render(<AccountsView />);
    /* 🔴 先等列表真的渲染出来**再**断「没有徽章」—— 否则「还没加载完」与
     *    「加载完了但不显示」长得一样。
     *
     * ⚠️ 这里的「渲染完成」信号用**「改名」按钮**而不是 `queryByText(accountId)`。
     *    本文件开头 `OK` 那段注释写着：`name` 有值时账号号只出现在第二行、
     *    与邮箱和 region 混在同一个文本节点里，`queryByText(accountId)` 找不到。
     *    而这条用例**必须**给 name 一个值（要区分 org 名与自定义名），
     *    所以不能沿用那个信号。第一版沿用了，这条就为了错的理由红了。 */
    await waitFor(() => {
      expect(screen.queryByText("改名") || screen.queryByText("Rename")).not.toBeNull();
    });
    expect(screen.queryByText("自定义名")).toBeNull();
    expect(screen.queryByText("Custom name")).toBeNull();
  });

  it("★★★ 已接入的账号有「改名」按钮", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([{ ...OK, onboarded: true }]) as never);
    render(<AccountsView />);
    await waitFor(() => {
      expect(screen.queryByText("改名") || screen.queryByText("Rename"),
        "已接入的账号改不了显示名 —— 跨组织接入的账号会永远显示 12 位数字",
      ).not.toBeNull();
    });
  });

  it("★★ 未接入的账号**没有**「改名」按钮（库里还没有那一行可写）", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([{ ...OK, onboarded: false, enabled: false,
              orgOnboardStatus: "" }]) as never);
    render(<AccountsView />);
    await waitFor(() => {
      expect(screen.queryByText("012345678901")).not.toBeNull();
    });
    // 后端对未登记的账号抛 account_not_registered —— 摆一个必然失败的按钮
    // 等于在界面上放一个用户解决不了的问题（本文件既有约定）。
    expect(screen.queryByText("改名")).toBeNull();
    expect(screen.queryByText("Rename")).toBeNull();
  });

  it("★★★ 预填：aliasManual=true → 输入框带出那个名字", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([{ ...OK, name: "生产-游戏1", aliasManual: true }]) as never);
    render(<AccountsView />);
    await waitFor(() => {
      expect(screen.queryByText("改名") || screen.queryByText("Rename")).not.toBeNull();
    });
    fireEvent.click((screen.queryByText("改名") || screen.queryByText("Rename"))!);
    const box = await waitFor(() => {
      const el = document.querySelector('input[maxlength="64"]');
      expect(el, "改名输入框没出来").not.toBeNull();
      return el as HTMLInputElement;
    });
    expect(box.value).toBe("生产-游戏1");
  });

  it("★★★ 预填：aliasManual=false → 输入框**留空**，org 名只做占位符", async () => {
    /* 🔴 这是这一族里唯一会造成**静默损坏**的一条。
     *
     *    预填 org 名的表现是：客户点开「改名」什么都不改就保存
     *      → 那个 org 名被标记成 `alias_source=manual` 落库
     *      → 以后在 AWS Organizations 里改了账号名，这里**再也不跟着变了**
     *    而客户从没输入过任何东西，界面上也没有任何提示说他刚固化了一个值。
     */
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([{ ...OK, name: "org-account-name", aliasManual: false }]) as never);
    render(<AccountsView />);
    await waitFor(() => {
      expect(screen.queryByText("改名") || screen.queryByText("Rename")).not.toBeNull();
    });
    fireEvent.click((screen.queryByText("改名") || screen.queryByText("Rename"))!);
    const box = await waitFor(() => {
      const el = document.querySelector('input[maxlength="64"]');
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    expect(box.value,
      "预填了 org 名 —— 客户什么都不改点保存就把它固化成自定义名，"
      + "以后 AWS 上改了账号名这里再也不跟着变",
    ).toBe("");
    // 占位符要写**当前生效的名字**，客户才能看出「留空会回退成什么」
    expect(box.getAttribute("placeholder")).toBe("org-account-name");
  });

  it("★★★ 保存后按 pushLabelUpdated 分两种反馈说", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([{ ...OK, aliasManual: true, name: "x" }]) as never);
    // da# 行不存在 → 后端跳过那一行 → IM 推送标签**没变**
    vi.mocked(admin.setMemberAccountAlias).mockResolvedValue(
      { accountId: OK.accountId, alias: "新名", pushLabelUpdated: false } as never);
    render(<AccountsView />);
    await waitFor(() => {
      expect(screen.queryByText("改名") || screen.queryByText("Rename")).not.toBeNull();
    });
    fireEvent.click((screen.queryByText("改名") || screen.queryByText("Rename"))!);
    await waitFor(() => {
      expect(document.querySelector('input[maxlength="64"]')).not.toBeNull();
    });
    fireEvent.click(screen.getByText("确认接入"));
    await waitFor(() => expect(admin.setMemberAccountAlias).toHaveBeenCalled());
    // 🔴 判据是「说了推送没改」。不说的话「都改好了」与「页面改了但推送
    //    还是旧名字」在界面上一样 —— 而推送是客户看得最多的那一面。
    await waitFor(() => {
      /* 🔴 判据只能匹配 **`aliasSavedNoPush` 独有**的措辞。
       *
       *    第一版写成 `/IM 推送的标签\*\*没有改\*\*|IM 推送的标签/` ——
       *    第二个分支把「都改好了」那条文案（`aliasSaved`，正文里也有
       *    「IM 推送的标签」四个字）一起匹配上了，于是这条断言**永真**：
       *    2026-08-31 反向注入实测，把两条文案合并成一条之后它照样绿。 */
      const hit = screen.queryByText(/没有改/)
        || screen.queryByText(/NOT changed/);
      expect(hit,
        "pushLabelUpdated=false 却报「都改好了」—— 客户以为 IM 推送里也改了",
      ).not.toBeNull();
    });
  });
});

describe("下线后的「需手动删栈」提示（2026-09-06 交叉 review）", () => {
  /* 🔴 原缺陷：`setErr(offboardRetained…)` 之后同一个 handler 里 `await reload()`，
   *    而 reload 第一行就是 `setErr("")` —— 两次 setErr 在同一次 React 批处理里
   *    后写胜出，「要删哪个栈」这条唯一带栈名和 region 的指引**一帧都渲染不出来**。
   *    agent space 是计费资源，这条提示是下线手动接入账号后唯一的回收指引。
   *    修法：reload({silent:true}) + 无提示时显式清旧错误。 */
  it("★★★ stackRetained 的栈名提示在 reload 之后必须仍然可见", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([{ ...OK, onboardSource: "manual" }]) as never);
    vi.mocked(admin.offboardMemberAccount).mockResolvedValue({
      stackRetained: true,
      stackName: "notiops-devops-agent-012345678901",
      stackRegion: "ap-northeast-1",
    } as never);
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("012345678901");
    try {
      render(<AccountsView />);
      await waitFor(() => {
        const btn = screen.queryByText("下线") || screen.queryByText("Offboard");
        expect(btn, "下线按钮没渲染出来（前置条件失败）").not.toBeNull();
      });
      fireEvent.click(screen.queryByText("下线") || screen.getByText("Offboard"));
      // 等 offboard → setErr → reload 整条链跑完，栈名必须还在屏幕上
      await waitFor(() => {
        expect(
          screen.queryByText(/notiops-devops-agent-012345678901/),
          "「需手动删除的栈名」提示不见了 —— 它被 reload() 里的 setErr(\"\") 清掉了"
          + "（同一批处理后写胜出）。客户下线后看不到要删哪个栈，计费的 agent space 静默残留",
        ).not.toBeNull();
      });
      // region 也要带上（跨区部署时光有栈名还要猜区）—— 断言在**消息元素内**，
      // 页面上别处（账号行的 region 列）也有同名文本，用全局查询会多命中。
      const msgEl = screen.getByText(/notiops-devops-agent-012345678901/);
      expect(msgEl.textContent).toContain("ap-northeast-1");
    } finally { promptSpy.mockRestore(); }
  });
});

describe("跨 Payer 的 Launch Stack 链接（2026-09-06 交叉 review）", () => {
  /* 🔴 原缺陷：Launch Stack URL 渲染成可直点的 <a target=_blank>，文案写着
   *    「点此在目标账号的 AWS 控制台部署」。quick-create URL 用的是**打开者
   *    当前会话**的凭证 —— 管理页操作者手里最可能是部署账号的会话，直点的
   *    结果是把成员模板（IAM 角色 + 计费的 agent space）部署进部署账号，而
   *    回填/测试连接（同账号 AssumeRole）照样全绿，零错误信号。
   *    修法：与 InspectionCrossAccountSection 同一标准 —— 只给复制按钮。 */
  const openXpayerAndGenerate = async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(resp([]) as never);
    vi.mocked(admin.generateLaunchStack).mockResolvedValue({
      launchStackUrl: "https://console.aws.amazon.com/cloudformation/home#/stacks/create/review?templateURL=x",
      templateUrl: "https://x", expiresHours: 12,
    } as never);
    render(<AccountsView />);
    const title = await waitFor(() => {
      const el = screen.queryByText(/手动接入账号/) || screen.queryByText(/Manual onboarding/);
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(title);
    const input = await waitFor(() => screen.getByPlaceholderText("123456789012"));
    fireEvent.change(input, { target: { value: "444455556666" } });
    fireEvent.click(screen.queryByText("生成链接") || screen.getByText("Generate link"));
    await waitFor(() => expect(vi.mocked(admin.generateLaunchStack)).toHaveBeenCalled());
  };

  it("★★★ 不许渲染指向 quick-create 的可点链接", async () => {
    await openXpayerAndGenerate();
    await waitFor(() => {
      const copyBtn = screen.queryByText(/复制 Launch Stack 链接/)
        || screen.queryByText(/Copy the Launch Stack link/);
      expect(copyBtn, "复制按钮没渲染 —— 链接生成后唯一的分发动作就是复制").not.toBeNull();
    });
    const badLinks = [...document.querySelectorAll("a")]
      .filter((a) => (a.getAttribute("href") || "").includes("cloudformation"));
    expect(badLinks.length,
      "又出现了可直点的 quick-create 链接 —— 它会用点击者（通常是部署账号）的会话建栈，"
      + "把成员模板部署进部署账号且零错误信号。只许复制后发给目标账号管理员",
    ).toBe(0);
  });

  it("★★★ 提示文案必须警告「别自己点开」", async () => {
    const { STRINGS } = await import("./i18n");
    const hint = STRINGS["admin.xpayer.stackHint"];
    expect(hint.zh).toMatch(/别自己点开|不要自己点开/);
    expect(hint.en.toLowerCase()).toContain("do not open it yourself");
  });
});

describe("巡检范围字段行（2026-09-07 UX 重做）", () => {
  /* 🔴 原「改 Region」是个长得像状态徽章的悬空按钮（客户原话「做成了和状态
   *    一样的 tag 形式，非常误导人…新用户怎么知道是改什么 region？」）：
   *    动作与数据分离、动词悬空、唯一的说明藏在编辑态里。
   *    重做后的三个不变量，哪个退化都会回到误导形态：
   *      ① 值有名字 —— 「巡检范围」标签与值同行可见
   *      ② 说明常驻 —— 标签带 title（ⓘ），不点编辑也能看到解释
   *      ③ 编辑挂在数据上 —— 点字段行里的编辑按钮展开编辑器，而不是一个
   *        混在状态徽章里的「改 Region」 */
  it("★★★ 已接入账号渲染「巡检范围」字段行：标签 + 值 + 常驻说明", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([{ ...OK, regions: ["ap-northeast-1", "us-east-1"] }]) as never);
    render(<AccountsView />);
    const label = await waitFor(() => {
      const el = screen.queryByText(/^巡检范围/) || screen.queryByText(/^Inspection scope/);
      expect(el, "「巡检范围」标签没渲染 —— 值又变回没名字的裸文本了").not.toBeNull();
      return el!;
    });
    // ② 说明常驻：标签自带 title（ⓘ 悬停解释），内容必须说清管什么资源
    expect(label.getAttribute("title") || "",
      "标签没有常驻说明（title）—— 解释又只活在编辑态里了"
    ).toMatch(/RDS|resources/);
    // ① 值可见且与标签同处一行区域
    expect(screen.queryByText(/ap-northeast-1 · us-east-1/),
      "范围值没渲染在字段行里").not.toBeNull();
    // 旧的悬空按钮不许复活
    expect(screen.queryByText("改 Region"),
      "「改 Region」tag 按钮复活了 —— UX 重做被回退").toBeNull();
  });

  it("★★★ 编辑挂在字段行上：点「编辑」展开编辑器并能提交", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      resp([{ ...OK, regions: ["us-east-1"] }]) as never);
    vi.mocked(admin.setMemberAccountRegions).mockResolvedValue(
      { accountId: OK.accountId, regions: ["us-west-2"] } as never);
    render(<AccountsView />);
    await waitFor(() => expect(screen.queryByText(/^巡检范围|^Inspection scope/)).not.toBeNull());
    fireEvent.click(screen.getByText(/✎/));
    const input = await waitFor(() => screen.getByPlaceholderText("us-east-1,us-east-2"));
    fireEvent.change(input, { target: { value: "us-west-2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(vi.mocked(admin.setMemberAccountRegions))
      .toHaveBeenCalledWith(OK.accountId, ["us-west-2"]));
  });
});

describe("部署账号固定行（巡检范围可配，2026-09-07）", () => {
  /* 🔴 此前部署账号恒扫全部 17 个 region 且**没有任何入口能改**（scan_region_scope
   *    的短路分支 + 它被成员列表排除）。这一行是它唯一的配置入口。 */
  const DEPLOY = { accountId: "444455556666", regions: [] as string[] };

  it("★★★ BFF 回传 deployAccount → 渲染固定行，空 regions 显示「全部 region」", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      { ...resp([]), deployAccount: DEPLOY } as never);
    render(<AccountsView />);
    await waitFor(() => {
      expect(screen.queryByText("部署账号") || screen.queryByText("Deployment account"),
        "部署账号固定行没渲染 —— 它的巡检范围又变成配不了的隐藏行为了").not.toBeNull();
    });
    expect(screen.queryByText(/全部 region|All regions/),
      "空 regions 没有显示成「全部 region (*)」—— 客户看不出默认行为是什么").not.toBeNull();
    expect(screen.queryByText("444455556666")).not.toBeNull();
  });

  it("★★★ 部署账号行的范围能编辑并提交到自己的账号 ID", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(
      { ...resp([]), deployAccount: DEPLOY } as never);
    vi.mocked(admin.setMemberAccountRegions).mockResolvedValue(
      { accountId: DEPLOY.accountId, regions: ["ap-northeast-1"] } as never);
    render(<AccountsView />);
    await waitFor(() => expect(screen.queryByText(/部署账号|Deployment account/)).not.toBeNull());
    fireEvent.click(screen.getByText(/✎/));
    const input = await waitFor(() => screen.getByPlaceholderText("us-east-1,us-east-2"));
    fireEvent.change(input, { target: { value: "ap-northeast-1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(vi.mocked(admin.setMemberAccountRegions))
      .toHaveBeenCalledWith(DEPLOY.accountId, ["ap-northeast-1"]));
  });

  it("★★ 老 BFF（无 deployAccount 字段）→ 不渲染固定行，页面其余照常", async () => {
    vi.mocked(admin.fetchMemberAccounts).mockResolvedValue(resp([OK]) as never);
    render(<AccountsView />);
    await waitFor(() => expect(screen.queryByText(OK.accountId)).not.toBeNull());
    expect(screen.queryByText("部署账号") || screen.queryByText("Deployment account")).toBeNull();
  });
});
