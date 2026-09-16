/**
 * 回复气泡页脚的契约：**只有一行**，顺序固定为 复制 → Sources → 署名(模型) → 账号 ID。
 *
 * 本文件钉的是 `SHOW_TOKEN_USAGE = false`（当前发版值）下的样子 —— 署名里**没有** token 用量。
 * 开关翻成 `true` 的样子由 `Message.footer.tokens-on.test.tsx` 钉（必须是另一个文件：
 * `vi.mock` 是整文件级的）。两份一起看才是完整契约：这里防的是"藏起来的东西自己漏回来"，
 * 那边防的是"以后想放出来时发现拼串逻辑已经被删干净了"。
 *
 * 为什么值得钉住：这里全是"改错了也不报错、只是看着不对"的东西，而回归的方向很具体 ——
 *   · 页脚曾经是两行（署名单独一行），谁再往回加一个 <div> 都不会有任何测试失败；
 *   · 「N 步」（usage.cycles）是产品明确要求去掉的，最容易被"顺手补回来"；
 *   · 账号徽标**只放 12 位 ID**，不放账号名（名字最长、又不能拿去定位资源 / 贴进 case）；
 *   · 「DevOps 对话」/「深度调查」的回复 m.model 是空的，署名只能靠 m.via ——
 *     一旦门条件写回 `m.model &&`，那两条路径的回复就变成"没人署名"。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { ChatMessage } from "../types";
import Message from "./Message";

const base: ChatMessage = { id: "m1", role: "assistant", text: "hello", ts: 1_700_000_000_000 };

function mount(m: Partial<ChatMessage>, props: Record<string, unknown> = {}) {
  render(<Message m={{ ...base, ...m }} onOpenSources={() => {}} {...props} />);
}

const bar = () => document.querySelectorAll(".row.bot .msgbar");
/** 页脚里各元素的出现顺序（按 class 归类），用来断言"复制 → Sources → 署名 → 账号"。 */
const order = () =>
  Array.from(bar()[0].children).map((el) => {
    if (el.classList.contains("modelsig")) return "sig";
    if (el.classList.contains("mb-acct")) return "acct";
    if (el.classList.contains("mb-emp")) return "emp";
    if (el.textContent?.includes("Sources") || el.textContent?.includes("来源")) return "sources";
    return "copy";
  });

describe("回复页脚（一行）", () => {
  beforeEach(() => cleanup());

  it("四样东西在同一行，顺序=复制/Sources/署名/账号 ID", () => {
    mount(
      { model: "claude-sonnet-5", usage: { totalTokens: 137024, cycles: 4 }, sources: [{ title: "CloudWatch" }] },
      { accountLabel: "123456789012" },
    );
    expect(bar().length).toBe(1); // 不是两行
    expect(order()).toEqual(["copy", "sources", "sig", "acct"]);
  });

  // 产品决定（`SHOW_TOKEN_USAGE = false`）：页脚只留模型署名，token 用量先不给客户看。
  // 这里要钉住的不是"少一段文字"，而是**藏得干净**：后端照旧回 usage、也照旧落库，
  // 所以只要谁在拼串或渲染处漏一个条件，数字就会自己回到界面上而没有任何报错。
  // 同时反向钉住署名主体还在 —— 藏 token 不等于把整行署名藏掉（那会让"这条谁答的"没法追）。
  it("署名只有模型、**不带** tokens（当前隐藏），也不带「N 步」", () => {
    mount({ model: "claude-sonnet-5", usage: { totalTokens: 137024, cycles: 4 } });
    const sig = document.querySelector(".modelsig")!.textContent || "";
    expect(sig).toBe("AWS Bedrock (Claude Sonnet 5)"); // 署名主体必须还在
    expect(sig).not.toContain("tokens");
    expect(sig).not.toContain("137,024"); // 连数字本身也不许漏（防"改了单位没改数"）
    expect(sig).not.toContain("步");
    expect(sig.toLowerCase()).not.toContain("step");
    expect(document.querySelector(".modelsig-steps")).toBeNull();
  });

  it("账号只显示传入的 ID（父组件已不再拼账号名）", () => {
    mount({ model: "claude-sonnet-5" }, { accountLabel: "123456789012" });
    expect((document.querySelector(".mb-acct")?.textContent || "").trim()).toBe("123456789012");
  });

  it("账号是普通文字：没有外边框/胶囊底，只留一颗表示账号类型的点", () => {
    mount({ model: "claude-sonnet-5" }, { accountLabel: "123456789012", accountIsMember: true });
    const acct = document.querySelector(".mb-acct")!;
    // 曾经整块是 inline style 画出来的胶囊（border + borderRadius + padding）。样式回到 CSS 后
    // 这个元素身上不该再有任何 inline style —— 谁把边框写回来都会在这里失败。
    expect(acct.getAttribute("style")).toBeNull();
    const dot = acct.querySelector<HTMLElement>(".mb-acct-dot")!;
    expect(dot).not.toBeNull();
    expect(dot.style.background).toBe("var(--orange)"); // 成员账号=橙，部署/management=蓝
  });

  it("DevOps Agent 直答（m.model 为空、只有 m.via）也在同一行署名，且不显示 token", () => {
    mount({ via: "devops-agent", usage: undefined });
    expect(bar().length).toBe(1);
    const sig = document.querySelector(".modelsig")!.textContent || "";
    expect(sig).toBe("AWS DevOps Agent");
    expect(sig).not.toContain("tokens");
  });

  // 这条是补上来的：署名字符串**不过 i18n**（zh/en 同一串），所以 i18n 那条
  // 「en 不许混用 Aliyun / Alibaba Cloud」的守卫扫不到它 —— 它只扫 STRINGS。
  // 结果就是署名一度写成 "Aliyun STAROps"，而四份文档都写 "Alibaba Cloud STAROps"：
  // 界面与文档对不上，客户照文档核对署名会以为功能没生效。所以这里**逐字**钉住。
  it("阿里云 STAROps 直答：署名逐字为 Alibaba Cloud STAROps，且不显示 token", () => {
    mount({ via: "starops", usage: undefined });
    expect(bar().length).toBe(1);
    const sig = document.querySelector(".modelsig")!.textContent || "";
    expect(sig).toBe("Alibaba Cloud STAROps");
    // 品牌名只许一种写法。这里可以无条件禁 "Aliyun"：唯一允许写 Aliyun 的是策略专名
    // （`AliyunSTAROpsReadOnlyAccess`），而署名里不可能出现策略名。
    expect(sig).not.toContain("Aliyun");
    // 0 token 是这条路径的产品事实：用量记在客户自己的阿里云账号上，不是我们这边。
    expect(sig).not.toContain("tokens");
  });

  it("即便后端多回了 usage，STAROps 署名也不许显示 token", () => {
    // 防的是「哪天 BFF 顺手把 usage 填上，署名就悄悄多出一串 tokens」——
    // 那会变成我们在替客户的阿里云账单说话，而这条路径我们这边根本没花 token。
    mount({ via: "starops", usage: { totalTokens: 4096 } });
    const sig = document.querySelector(".modelsig")!.textContent || "";
    expect(sig).toBe("Alibaba Cloud STAROps");
    expect(sig).not.toContain("4,096");
  });

  // 🔴 2026-09-13 现网抓到的假信息：STAROps 回复的页脚是
  //    「Alibaba Cloud STAROps  111122223333」—— 后面那个是 **AWS** 账号 ID
  //    （这里写的是占位号；现网抓到的是部署账号那个真号，不进仓库）。
  //    这条回答来自客户自己的**阿里云**数字员工，跟那个 AWS 账号毫无关系；两个云的账号
  //    挨着写在同一行，客户会把它当成"这条阿里云结论对应的账号"拿去核对、贴进工单。
  //    阿里云账号 UID 这条路径拿不到（唯一带它的 workspace 是管理员专属、不回给非管理员），
  //    所以正确做法是**不显示**，不是显示错的那个。
  //    ⚠️ 只钉 via="starops"：其余路径（含 devops-agent）的账号 ID 是**对的**，必须保留 ——
  //    这条断言故意配一条反向断言，防止"顺手把整个账号 chip 删掉"。
  it("阿里云 STAROps 直答：页脚里不许出现 AWS 账号 ID（跨云假信息）", () => {
    mount({ via: "starops", usage: undefined }, { accountLabel: "123456789012" });
    expect(bar().length).toBe(1);
    expect(document.querySelector(".mb-acct")).toBeNull();
    expect(bar()[0].textContent || "").not.toContain("123456789012");
    expect(order()).toEqual(["copy", "sig"]);
  });

  it("反向：DevOps Agent 直答的账号 ID 必须还在（别把 chip 整个删了）", () => {
    mount({ via: "devops-agent", usage: undefined }, { accountLabel: "123456789012" });
    expect((document.querySelector(".mb-acct")?.textContent || "").trim()).toBe("123456789012");
  });

  // 上面那条把错的（AWS 账号）拿掉，这一条把对的（数字员工 ID）放回同一位。
  // 为什么必须显示：一个阿里云账号可以有多个数字员工，纳管范围与答题能力都不同 ——
  // 页脚只写 "Alibaba Cloud STAROps" 时，客户无法判断这条结论出自哪一个员工。
  // 值必须是**这一轮**的（BFF 在 `via` 事件里带回、逐条落库），不是读当前配置：
  // 管理员换过员工之后，历史回复仍要显示当时那一个。
  it("阿里云 STAROps 直答：页脚显示数字员工 ID 的值，且占的是账号 ID 那一位", () => {
    mount({ via: "starops", usage: undefined, staropsEmployee: "apsara-ops" },
      { accountLabel: "123456789012" });
    expect(bar().length).toBe(1);
    expect((document.querySelector(".mb-emp")?.textContent || "").trim()).toBe("apsara-ops");
    expect(document.querySelector(".mb-acct")).toBeNull();       // AWS 账号仍然不许出现
    expect(bar()[0].textContent || "").not.toContain("123456789012");
    expect(order()).toEqual(["copy", "sig", "emp"]);
  });

  it("没拿到员工 ID 时页脚就少这一位（绝不回落成 AWS 账号，也不显示占位文字）", () => {
    mount({ via: "starops", usage: undefined }, { accountLabel: "123456789012" });
    expect(document.querySelector(".mb-emp")).toBeNull();
    expect(order()).toEqual(["copy", "sig"]);
  });

  it("反向：非 STAROps 的回复即便带了 staropsEmployee 也不显示（防串台）", () => {
    mount({ via: "devops-agent", usage: undefined, staropsEmployee: "apsara-ops" });
    expect(document.querySelector(".mb-emp")).toBeNull();
  });

  it("流式中不渲染页脚（避免答案没写完就出现复制/署名）", () => {
    mount({ model: "claude-sonnet-5", streaming: true });
    expect(bar().length).toBe(0);
  });
});
