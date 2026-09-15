/**
 * 「对话对象」分段控件（通用会话新对话主页）的契约。
 *
 * 改错了都不报错、只是显示错，而且错的方向都很贵：
 *   · **默认选中 NotiOps**（可跳过）：不选直接打字必须还是老行为，否则所有老用户的第一句
 *     都变成走别人的 Agent；
 *   · 三段是**一个** radiogroup（三选一），不是三个独立开关；
 *   · 某个对象没接入（这个部署/账号没有 DevOps Agent、或没登记阿里云 STAROps）时那一段
 *     **置灰 + 点它才写清原因**：不然客户选了它，发一轮才收到 no_local_agent_space / 「尚未配置」；
 *   · **原因不许在默认视图上抢占提示行**：默认选中 NotiOps，那一行必须是 NotiOps 自己的说明。
 *     抢占过的症状是每个没配阿里云的部署（= 绝大多数）的每一个新对话首页都在说
 *     「尚未登记阿里云凭据」—— 与客户此刻要做的事无关，还看着像出错；
 *   · 置灰时把**已选中**的那个对象退回 NotiOps：那一段已经点不动了，客户自己回不来。
 *
 * ⚠️ 置灰段用 `aria-disabled` 而**不是**原生 `disabled`（原生的会把点击一起吞掉，
 *    「点它才解释」就永远触发不了）。所以这里断言 `aria-disabled` 与「点了 onPick 没被调用」，
 *    **不要**改回断言 `.disabled` —— 那个属性现在恒为 false，断言它会永远是绿的。
 *
 * ⚠️ 两条可用性探测必须都 mock 到。少 mock 一个的症状是组件在 effect 里调用 undefined
 *    **整个文件全红**，而不是某一条断言失败 —— 这就是这个 vi.mock 里两个函数都在的原因。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

let availability: { available: boolean; reason?: string } = { available: true };
let soAvailability: { available: boolean; reason?: string } = { available: true };
vi.mock("../api/chat", () => ({
  getDeepInvestigationAvailability: () => Promise.resolve(availability),
  getStarOpsAvailability: () => Promise.resolve(soAvailability),
}));

/** ⚠️ 2026-09-15 起 STAROps 那一段**默认不渲染**（产品决定：多云先不对外，见
 *  `featureFlags.ts`）。这份测试守的是**实现还在、翻开就是这个行为**，所以把开关
 *  mock 成 `true`：下面所有关于三段、置灰、退回的契约照旧全部有效。
 *
 *  不改成「断言只有两段」的理由：那等于用测试把这一段锁死在关闭状态，翻开开关的那天
 *  「置灰要给原因」「置灰要退回 NotiOps」这些**只会显示错、不会报错**的契约一条都没人守。
 *  「关着的时候只有两段、而且不打阿里云探测」由 `ChatObjectPicker.hidden.test.tsx` 钉
 *  （mock 是整文件生效的，两种开关值必须分两个文件）。 */
vi.mock("../featureFlags", () => ({ MULTICLOUD_UI: true }));

import ChatObjectPicker from "./ChatObjectPicker";
import { STRINGS } from "../i18n";

/** 判"这行是不是 NotiOps 自己的说明" —— 从 i18n 取两种语言比对：
 *  不硬编码字句（文案属产品可改），也不假设测试环境解析出来的是哪种语言。 */
const isNotiopsHint = (s: string) =>
  s === STRINGS["obj.notiops.hint"].zh || s === STRINGS["obj.notiops.hint"].en;
/** 「尚未登记阿里云凭据…」那一句 —— 测试环境解析出的语言（这里是 zh）下的原文。 */
const CREDS_HINT = STRINGS["obj.starops.na.creds"].zh;

const segs = () => Array.from(document.querySelectorAll("button.obj-seg-btn")) as HTMLButtonElement[];
/** [NotiOps 段, DevOps Agent 段, 阿里云 STAROps 段] —— 顺序是产品指定的（默认那个在左）。 */
const notiopsSeg = () => segs()[0];
const devopsSeg = () => segs()[1];
const staropsSeg = () => segs()[2];
const hint = () => (document.querySelector(".obj-hint")?.textContent || "").trim();
/** 置灰与否只看 `aria-disabled` + class（见文件头 ⚠️：原生 `.disabled` 已恒为 false）。 */
const greyed = (b: HTMLButtonElement) => b.getAttribute("aria-disabled") === "true" && b.className.includes("disabled");
/** 断言点击后**提示行会变**的用例必须走 `fireEvent`（它包了 act，状态更新当场刷新）；
 *  裸 `.click()` 只够验 onPick 有没有被调用 —— 重渲染还没发生，提示行读到的是旧值。 */
const tap = (b: HTMLButtonElement) => fireEvent.click(b);

describe("「对话对象」分段控件", () => {
  beforeEach(() => {
    availability = { available: true };
    soAvailability = { available: true };
    cleanup();
  });

  it("三段组成一个 radiogroup，默认选中 NotiOps", async () => {
    render(<ChatObjectPicker devopsChat={false} starops={false} onPick={() => {}} />);
    await waitFor(() => expect(segs().length).toBe(3));
    // radiogroup 只能有**一个**：三段是同一个"谁来答"的单选，做成两个组会让读屏用户
    // 以为可以各选一个（而后端是一选一，第二个选择会被静默丢掉）。
    expect(screen.getAllByRole("radiogroup").length).toBe(1);
    expect(notiopsSeg().getAttribute("aria-checked")).toBe("true");
    expect(devopsSeg().getAttribute("aria-checked")).toBe("false");
    expect(staropsSeg().getAttribute("aria-checked")).toBe("false");
    expect(notiopsSeg().className).toContain("sel");
  });

  it("选中 DevOps Agent 时选中态跟着走，回调 devops，提示行也跟着换", async () => {
    const onPick = vi.fn();
    render(<ChatObjectPicker devopsChat={false} starops={false} onPick={onPick} />);
    await waitFor(() => expect(segs().length).toBe(3));
    const notiopsHint = hint();
    expect(notiopsHint.length).toBeGreaterThan(0);
    devopsSeg().click();
    expect(onPick).toHaveBeenCalledWith("devops");

    cleanup();
    render(<ChatObjectPicker devopsChat={true} starops={false} onPick={onPick} />);
    await waitFor(() => expect(devopsSeg().getAttribute("aria-checked")).toBe("true"));
    expect(notiopsSeg().getAttribute("aria-checked")).toBe("false");
    expect(hint()).not.toBe(notiopsHint);
    notiopsSeg().click();
    expect(onPick).toHaveBeenCalledWith("notiops");
  });

  // STAROps 与 DevOps 是**同一个单选**里的两个值：选中一个，另一个必须灭。这条断言值钱的
  // 地方是"落款不能自相矛盾"——同时点亮意味着界面在说两朵云同时在答这一段对话。
  it("选中阿里云 STAROps 时选中态跟着走，回调 starops，且 DevOps 段同时灭掉", async () => {
    const onPick = vi.fn();
    render(<ChatObjectPicker devopsChat={false} starops={false} onPick={onPick} />);
    await waitFor(() => expect(segs().length).toBe(3));
    const notiopsHint = hint();
    staropsSeg().click();
    expect(onPick).toHaveBeenCalledWith("starops");

    cleanup();
    render(<ChatObjectPicker devopsChat={false} starops={true} onPick={onPick} />);
    await waitFor(() => expect(staropsSeg().getAttribute("aria-checked")).toBe("true"));
    expect(notiopsSeg().getAttribute("aria-checked")).toBe("false");
    expect(devopsSeg().getAttribute("aria-checked")).toBe("false");
    expect(notiopsSeg().className).not.toContain("sel");
    expect(hint()).not.toBe(notiopsHint);
  });

  it("选中态不写「已选」二字（靠填充表达），提示行也不解释计费机制", async () => {
    render(<ChatObjectPicker devopsChat={true} starops={false} onPick={() => {}} />);
    await waitFor(() => expect(segs().length).toBe(3));
    const tx = document.querySelector(".obj-pick")?.textContent || "";
    expect(tx).not.toContain("已选");
    expect(tx).not.toContain("0 token");
  });

  // 产品指定：DevOps Agent 那一侧的提示行必须写「免模型配置」——这是这条路径对客户最实际的
  // 一句好处（模型还没在 Bedrock 开通好的部署，选这边就能直接用），不是"0 token"这种机制话。
  it("选中 DevOps Agent 时提示行写明「免模型配置」", async () => {
    render(<ChatObjectPicker devopsChat={true} starops={false} onPick={() => {}} />);
    await waitFor(() => expect(segs().length).toBe(3));
    expect(hint()).toContain("免模型配置");
  });

  // 段名要点出**哪朵云**：这一排现在有两朵云，而答案页脚的署名逐字是 "AWS DevOps Agent"
  // （Message.tsx 里硬编码、不过 i18n）。段名与署名对不上时，客户会以为选的和答的不是一个东西。
  it("DevOps 段名带 AWS，且与页脚署名同一个写法", async () => {
    render(<ChatObjectPicker devopsChat={false} starops={false} onPick={() => {}} />);
    await waitFor(() => expect(segs().length).toBe(3));
    expect((devopsSeg().textContent || "").trim()).toBe("AWS DevOps Agent");
    // 两种语言同一串（这是产品名，不译）。
    expect(STRINGS["obj.devops.name"].en).toBe("AWS DevOps Agent");
    expect(STRINGS["obj.devops.name"].zh).toBe(STRINGS["obj.devops.name"].en);
    // 锁定后标题栏那个 tag 是同一个对象的同一个身份，写法必须一致。
    expect(STRINGS["obj.tag.devops"].zh).toBe(STRINGS["obj.devops.name"].zh);
    expect(STRINGS["obj.tag.devops"].en).toBe(STRINGS["obj.devops.name"].en);
  });

  // beta 徽标必须画在**段名旁边**，不能只写进提示行：提示行要等选中/点击后才说话，
  // 而客户在这一步做的判断是"这句话发给谁" —— 等他选完再告知就晚了（问题原文已经出境）。
  // 只有 STAROps 这一段是 beta，另外两段不许跟着长出徽标。
  it("只有阿里云 STAROps 段带 beta 徽标，且徽标自己带解释（不抢按钮的 title）", async () => {
    render(<ChatObjectPicker devopsChat={false} starops={false} onPick={() => {}} />);
    await waitFor(() => expect(segs().length).toBe(3));
    const badges = Array.from(document.querySelectorAll(".obj-seg-beta"));
    expect(badges.length).toBe(1);
    expect(staropsSeg().querySelector(".obj-seg-beta")).toBeTruthy();
    expect(notiopsSeg().querySelector(".obj-seg-beta")).toBeNull();
    expect(devopsSeg().querySelector(".obj-seg-beta")).toBeNull();
    expect((badges[0].textContent || "").trim()).toBe("beta");
    // 解释挂在徽标自己身上：置灰时按钮的 title 要留给「为什么点不动」那句原因。
    expect(badges[0].getAttribute("title")).toBe(STRINGS["obj.starops.beta.hint"].zh);
    // aria-hidden 会让读屏用户读不到"这还不是正式功能"。
    expect(badges[0].getAttribute("aria-hidden")).toBeNull();
  });

  // 置灰时两者不许互相盖：徽标的 title 说"这是 beta"，按钮的 title 说"为什么点不动"。
  it("STAROps 段置灰时，beta 徽标与「点不动的原因」两个 title 并存且不同", async () => {
    soAvailability = { available: false, reason: "no_credentials" };
    render(<ChatObjectPicker devopsChat={false} starops={false} onPick={() => {}} />);
    await waitFor(() => expect(greyed(staropsSeg())).toBe(true));
    const badgeTitle = staropsSeg().querySelector(".obj-seg-beta")!.getAttribute("title");
    expect(staropsSeg().getAttribute("title")).toBe(CREDS_HINT);
    expect(badgeTitle).toBe(STRINGS["obj.starops.beta.hint"].zh);
    expect(badgeTitle).not.toBe(staropsSeg().getAttribute("title"));
  });

  // STAROps 那一侧必须在界面上点出**阿里云**：客户上一段可能刚在问 AWS，段名只写 "STAROps"
  // 就看不出这句话要发去另一朵云 —— 而这是唯一不可逆的信息（问题原文已经出境了）。
  it("STAROps 段与其提示行都点明「阿里云」", async () => {
    render(<ChatObjectPicker devopsChat={false} starops={true} onPick={() => {}} />);
    await waitFor(() => expect(segs().length).toBe(3));
    expect(staropsSeg().textContent || "").toContain("阿里云");
    expect(hint()).toContain("阿里云");
  });

  it("没接入 DevOps Agent：那一段置灰、点不动，点它才把原因写进提示行", async () => {
    availability = { available: false, reason: "account_not_onboarded_to_devops_agent" };
    const onPick = vi.fn();
    render(<ChatObjectPicker devopsChat={false} starops={false} onPick={onPick} accountId="123456789012" />);
    await waitFor(() => expect(greyed(devopsSeg())).toBe(true));
    expect(devopsSeg().getAttribute("title")).toBeTruthy();
    // 点它：只解释，**不切过去** —— 父组件收不到任何选择。
    tap(devopsSeg());
    expect(onPick).not.toHaveBeenCalled();
    // 原因要出现在界面上（而不是只藏在 title 里）。
    expect(hint().length).toBeGreaterThan(10);
    expect(isNotiopsHint(hint())).toBe(false);
    // 另一朵云没配跟这条无关：DevOps 不可用**不能**顺手把 STAROps 也藏掉
    // （两条探测独立就是为了这个）。
    expect(greyed(staropsSeg())).toBe(false);
  });

  it("没登记阿里云 STAROps：那一段置灰、点不动，点它才写清原因，且不影响 DevOps 段", async () => {
    soAvailability = { available: false, reason: "no_credentials" };
    const onPick = vi.fn();
    render(<ChatObjectPicker devopsChat={false} starops={false} onPick={onPick} />);
    await waitFor(() => expect(greyed(staropsSeg())).toBe(true));
    expect(staropsSeg().getAttribute("title")).toBeTruthy();
    tap(staropsSeg());
    expect(onPick).not.toHaveBeenCalled();
    expect(hint()).toBe(CREDS_HINT);
    expect(greyed(devopsSeg())).toBe(false);
  });

  // 这条就是那个回归本身：**没配阿里云的部署**（绝大多数）进新对话首页时，提示行必须还是
  // NotiOps 自己的说明。曾经写成「置灰就把原因写进提示行」，于是每个客户的每一个新对话
  // 首页都在说「尚未登记阿里云凭据」—— 说的是一个他没选、也没打算选的对象。
  it("默认选中 NotiOps 时，提示行永远是 NotiOps 的说明 —— 不借它说别的对象没配好", async () => {
    for (const [av, soAv] of [
      [{ available: false, reason: "no_local_agent_space" }, { available: false, reason: "no_credentials" }],
      [{ available: true }, { available: false, reason: "no_credentials" }],
      [{ available: false, reason: "no_local_agent_space" }, { available: true }],
    ] as const) {
      cleanup();
      availability = { ...av };
      soAvailability = { ...soAv };
      render(<ChatObjectPicker devopsChat={false} starops={false} onPick={() => {}} />);
      await waitFor(() => expect(segs().length).toBe(3));
      // 等两条探测都落地（置灰状态渲染出来）再看提示行，否则可能在探测回来前就断言完了。
      await waitFor(() => expect(hint().length).toBeGreaterThan(0));
      expect(isNotiopsHint(hint())).toBe(true);
      // 逐字钉住那句抱怨本身（两种语言都钉）—— 它就是这条回归的现场症状。
      expect(hint()).not.toBe(STRINGS["obj.starops.na.creds"].zh);
      expect(hint()).not.toBe(STRINGS["obj.starops.na.creds"].en);
    }
  });

  // reason → 提示行是**逐个映射**的：几种缺失的修法完全不同（登记 AK / 改员工名 / 换 region），
  // 回同一句"未配置"等于让管理员把「多云」页从头翻一遍。这条只验"不同 reason 给出不同文案"，
  // 不锁具体字句（文案属产品可改）。
  it("不同的 reason 给出不同的提示文案", async () => {
    const hints: string[] = [];
    for (const reason of ["no_credentials", "no_employee", "bad_employee", "bad_region", "bad_workspace", "bad_project"]) {
      cleanup();
      soAvailability = { available: false, reason };
      render(<ChatObjectPicker devopsChat={false} starops={false} onPick={() => {}} />);
      await waitFor(() => expect(greyed(staropsSeg())).toBe(true));
      tap(staropsSeg());   // 原因现在要**点过**才出现
      hints.push(hint());
    }
    // bad_workspace / bad_project 共用一条（都是 variables 那格填错），故 6 个 reason → 5 句。
    expect(new Set(hints).size).toBe(5);
    for (const h of hints) expect(h.length).toBeGreaterThan(10);
  });

  it("点了置灰段之后再选一个能用的对象，提示行把「为什么点不动」收回去", async () => {
    soAvailability = { available: false, reason: "no_credentials" };
    const onPick = vi.fn();
    render(<ChatObjectPicker devopsChat={false} starops={false} onPick={onPick} />);
    await waitFor(() => expect(greyed(staropsSeg())).toBe(true));
    tap(staropsSeg());
    expect(isNotiopsHint(hint())).toBe(false);
    tap(devopsSeg());                       // DevOps 这轮是可用的
    expect(onPick).toHaveBeenCalledWith("devops");
    // 父组件受控，这里 devopsChat 仍是 false（= NotiOps 态），所以提示行该回到 NotiOps 的说明。
    expect(isNotiopsHint(hint())).toBe(true);
  });

  it("探到不可用时把已选中的 DevOps Agent 退回 NotiOps", async () => {
    availability = { available: false, reason: "no_local_agent_space" };
    const onPick = vi.fn();
    render(<ChatObjectPicker devopsChat={true} starops={false} onPick={onPick} />);
    await waitFor(() => expect(onPick).toHaveBeenCalledWith("notiops"));
  });

  it("探到不可用时把已选中的阿里云 STAROps 退回 NotiOps", async () => {
    soAvailability = { available: false, reason: "no_employee" };
    const onPick = vi.fn();
    render(<ChatObjectPicker devopsChat={false} starops={true} onPick={onPick} />);
    await waitFor(() => expect(onPick).toHaveBeenCalledWith("notiops"));
  });

  it("探测失败/可用时不动已有选择（探测不确定一律按可用处理）", async () => {
    const onPick = vi.fn();
    render(<ChatObjectPicker devopsChat={true} starops={false} onPick={onPick} />);
    await waitFor(() => expect(segs().length).toBe(3));
    expect(greyed(devopsSeg())).toBe(false);
    expect(greyed(staropsSeg())).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
  });
});
