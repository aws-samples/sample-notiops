/**
 * Admin「集成 IM」板块的契约（NotificationsView + 右侧步骤抽屉）。
 *
 * 为什么值得一份测试：这一页是**客户不碰 CLI 完成 IM 接入的唯一入口**。webhook 模式下
 * Encrypt Key / Verification Token 是唯一鉴权手段（ingress 冷启动硬校验，缺一即起不来），
 * 而这一页出问题的方式全是「不报错、只是配不上」：
 *   · 少了那两个输入框 → 客户只能去改 Secrets Manager JSON，一键集成断在这一步；
 *   · 输入的明文没遮住 → 客户共享屏幕时把钥匙念出去；
 *   · 保存时不 trim → 从飞书控制台复制粘贴带上尾随空格，验签 401，症状和「地址填错」一样；
 *   · 飞书控制台那一半的步骤没入口 → 保存完凭证就卡住，不知道还要去改订阅方式；
 *   · **没动过的密钥框被浏览器自动填充后原样保存** → 三把钥匙被静默换掉，飞书开始
 *     「校验失败」，而客户会去查请求地址（同上，症状指向错误的地方）。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import { STRINGS } from "../i18n";

/** 后端回来的形态：敏感字段已脱敏（空 = 未配置 → 空串，见 bff/web-chat/feishu_config.mjs）。
 *  `webhook_url` 是**只读**回带字段，不脱敏（它是公开入口地址，不是凭证）。 */
let getResp: {
  feishu: {
    app_id: string; app_secret: string; verification_token: string;
    encrypt_key: string; notify_chat_ids: string; webhook_url?: string;
  };
};
const putSpy = vi.fn(async (_cfg: Record<string, string>) => ({ message: "ok" }));

vi.mock("../api/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/admin")>();
  return {
    ...actual,
    fetchAllCapabilities: vi.fn(async () => []),
    fetchNotificationConfig: vi.fn(async () => getResp),
    putNotificationConfig: (cfg: Record<string, string>) => putSpy(cfg),
    testNotificationSend: vi.fn(async () => ({ success: true, message: "sent" })),
  };
});

import AdminPanel from "./AdminPanel";

const zh = (k: string) => STRINGS[k].zh;

/** 打开「集成 IM」tab（默认 tab 是角色）。 */
async function openImTab() {
  render(<AdminPanel />);
  const tab = Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent === zh("admin.tab.notifications"))!;
  expect(tab).toBeTruthy();
  fireEvent.click(tab);
  await waitFor(() => expect(secretInputs().length).toBe(3));
}

/**
 * 三个密钥框，顺序是界面顺序：App Secret / Encrypt Key / Verification Token。
 *
 * 按 `name` 选而不是按 `type=password` 选：这三个框的 `type` 是**会变的** ——
 * 没动过的脱敏串用 `text`（否则后 4 位也被画成圆点，那句「仅显示后 4 位」就成了空话），
 * 一动手输入才切 `password`。按 type 选会让"框变了形态"伪装成"框不见了"。
 */
const secretInputs = () =>
  Array.from(document.querySelectorAll('input[name^="notiops-feishu-"]')) as HTMLInputElement[];
const labelTexts = () =>
  Array.from(document.querySelectorAll("div")).map((d) => d.textContent || "");

describe("Admin「集成 IM」凭证表单", () => {
  beforeEach(() => {
    cleanup();
    putSpy.mockClear();
    getResp = {
      feishu: {
        app_id: "cli_a1b2c3d4", app_secret: "****WXYZ",
        verification_token: "", encrypt_key: "", notify_chat_ids: "oc_room1",
      },
    };
  });

  it("四个凭证都能在页面上填（三个密钥框 + App ID）", async () => {
    await openImTab();
    expect(secretInputs().length).toBe(3);
    const labels = labelTexts();
    expect(labels).toContain("Encrypt Key");
    expect(labels).toContain("Verification Token");
  });

  it("未配置的钥匙显示为空白输入框，不是 ****", async () => {
    // 这是最贵的显示型 bug：回显 **** 会让客户以为已经配好，跳过飞书那边的加密策略，
    // 最后拿一个「校验失败」去查请求地址。空 = 明摆着还没填。
    await openImTab();
    const [secret, enc, tok] = secretInputs();
    expect(secret.value).toBe("****WXYZ");   // 已配置 → 脱敏回显
    expect(enc.value).toBe("");              // 未配置 → 空白
    expect(tok.value).toBe("");
  });

  it("已配置且没动过 → type=text，后 4 位真的看得见；未配置 → password", async () => {
    // 提示文案写着「仅显示后 4 位」。`type=password` 会把 `****WXYZ` 里的 WXYZ 也画成圆点，
    // 那句话就永远不成立，客户也无从确认自己配的是哪一把钥匙。
    await openImTab();
    const [secret, enc, tok] = secretInputs();
    expect(secret.type).toBe("text");
    expect(enc.type).toBe("password");
    expect(tok.type).toBe("password");
  });

  it("一动手输入立刻切 password（明文不摆在共享的屏幕上）", async () => {
    await openImTab();
    const [secret] = secretInputs();
    fireEvent.change(secret, { target: { value: "real-plaintext-secret" } });
    expect(secretInputs()[0].type).toBe("password");
  });

  it("点进脱敏框会整串选中（第一个按键是替换，不是追加）", async () => {
    // 追加出来的 `****WXYZ<新>` 长度 >8，后端的 mergeIfMasked 会当成真的新值写进 Secret。
    await openImTab();
    const [secret] = secretInputs();
    fireEvent.focus(secret);
    expect(secret.selectionStart).toBe(0);
    expect(secret.selectionEnd).toBe("****WXYZ".length);
  });

  it("三个密钥框都谢绝浏览器自动填充", async () => {
    // 自动填充进来的值不以 **** 开头 → 后端当成"改了新值"→ 覆盖 Secrets Manager。
    // 这一条是第一层防线（请浏览器别填），下一条是兜底（填了也改不了）。
    await openImTab();
    for (const el of secretInputs()) {
      expect(el.getAttribute("autocomplete")).toBe("new-password");
      expect(el.getAttribute("data-1p-ignore")).not.toBeNull();
      expect(el.getAttribute("data-lpignore")).toBe("true");
      // name 里不带 password/secret 之类的词 —— 密码管理器按 name/id 猜字段。
      expect(el.name).not.toMatch(/password/i);
    }
  });

  it("保存时两把钥匙都 trim，没动过的 app_secret 原样回传（= 不修改）", async () => {
    await openImTab();
    const [, enc, tok] = secretInputs();
    // 模拟从飞书控制台粘贴：尾随空格 / 换行是常事。
    fireEvent.change(enc, { target: { value: "  enc-key-value \n" } });
    fireEvent.change(tok, { target: { value: "tok-value\t" } });
    const saveBtn = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent === zh("admin.notif.save"))!;
    fireEvent.click(saveBtn);
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const sent = putSpy.mock.calls[0][0];
    expect(sent.encrypt_key).toBe("enc-key-value");
    expect(sent.verification_token).toBe("tok-value");
    expect(sent.app_secret).toBe("****WXYZ");
    expect(sent.notify_chat_ids).toBe("oc_room1");
  });

  it("兜底：没动过的框回传的是服务端原值，被静默填成什么都不算", async () => {
    // 直接改 DOM 的 value 而**不**触发 React 的 onChange —— 这正是静默自动填充在
    // React 受控组件上的形态。会正常派发 input 事件的密码管理器不在这条覆盖范围内
    // （那种靠 autoComplete/data-*-ignore 拦，见上一条），SecretField 的注释里写了这个边界。
    await openImTab();
    const [secret] = secretInputs();
    secret.value = "autofilled-by-password-manager";
    const saveBtn = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent === zh("admin.notif.save"))!;
    fireEvent.click(saveBtn);
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][0].app_secret).toBe("****WXYZ");
  });

  it("删掉的副标题不再出现在文案表里", async () => {
    // 产品明确要求删除「配置飞书自建应用凭证与推送群组…」这一行。key 若被恢复，
    // SectionHead 会重新渲染它 —— 这条断言把「删掉」钉住。
    expect(STRINGS["admin.notif.sub"]).toBeUndefined();
  });
});

describe("飞书配置步骤抽屉", () => {
  beforeEach(() => {
    cleanup();
    getResp = {
      feishu: {
        app_id: "", app_secret: "", verification_token: "",
        encrypt_key: "", notify_chat_ids: "",
      },
    };
  });

  it("页面上先给四步速览 + 顺序警告（不必先去翻文档）", async () => {
    await openImTab();
    const txt = document.body.textContent || "";
    for (const k of ["admin.notif.steps.title", "admin.notif.steps.s1", "admin.notif.steps.s2",
                     "admin.notif.steps.s3", "admin.notif.steps.s4", "admin.notif.steps.order"]) {
      expect(txt).toContain(zh(k));
    }
  });

  it("点超链接打开右侧抽屉；抽屉里有完整步骤；Esc 关闭", async () => {
    await openImTab();
    const panel = () => document.querySelector(".imd-panel")!;
    // 抽屉常驻 DOM、靠 .open 平移进来（动画需要），所以判据是 class 而不是存在性。
    expect(panel().className).not.toContain("open");

    const link = document.querySelector("button.imx-guide-link") as HTMLButtonElement;
    expect(link.textContent).toContain(zh("admin.notif.guideLink"));
    fireEvent.click(link);
    await waitFor(() => expect(panel().className).toContain("open"));

    const body = document.querySelector(".imd-body")!.textContent || "";
    // 七节标题都在（内容源 content/feishuGuide.ts，与 docs/IM_WEBHOOK_SETUP.md 对齐）
    expect(document.querySelectorAll(".imd-body .imd-h").length).toBe(7);
    // 客户在浏览器里配不完的那两件事必须写明：请求地址从哪来、回调要订阅什么
    expect(body).toContain("FeishuWebhookUrl");
    expect(body).toContain("card.action.trigger");
    // 抽屉是给「只有浏览器的客户」看的：不该再出现改 secret 的 CLI 步骤
    expect(body).not.toContain("put-secret-value");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(panel().className).not.toContain("open"));
  });

  it("第 3 步直接给出本部署真实的 webhook 地址 + 复制按钮", async () => {
    // 这是整条接入流程里**唯一需要客户手抄**的值：抄错一个字符 → 飞书「校验失败」，
    // 而症状指向的是钥匙没配。所以宁可后端查一次，也不让客户去翻 CloudFormation Outputs。
    const url = "https://e5er287z3e.execute-api.us-east-1.amazonaws.com/";
    getResp.feishu.webhook_url = url;
    await openImTab();
    fireEvent.click(document.querySelector("button.imx-guide-link") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector(".imd-panel")!.className).toContain("open"));

    const box = document.querySelector(".imd-urlbox")!;
    expect(box).toBeTruthy();
    const input = box.querySelector("input.imd-url") as HTMLInputElement;
    // 一字不差，**包括结尾那个 `/`**（HTTP API 的 $default 路由，少了照样通，但 Outputs 里带着，
    // 两处显示不一致会让客户怀疑自己拿错了地址）。
    expect(input.value).toBe(url);
    expect(input.readOnly).toBe(true);
    expect(box.querySelector("button.imd-url-copy")!.textContent).toContain(zh("admin.notif.url.copy"));
    // 取不到时才显示的兜底文案，这里不该出现
    expect(box.textContent).not.toContain(zh("admin.notif.url.missing"));
  });

  it("点复制写进剪贴板，并把按钮文案切成「已复制」", async () => {
    const url = "https://e5er287z3e.execute-api.us-east-1.amazonaws.com/";
    getResp.feishu.webhook_url = url;
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await openImTab();
    fireEvent.click(document.querySelector("button.imx-guide-link") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector(".imd-urlbox")).toBeTruthy());

    fireEvent.click(document.querySelector("button.imd-url-copy") as HTMLButtonElement);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
    await waitFor(() =>
      expect(document.querySelector("button.imd-url-copy")!.textContent)
        .toContain(zh("admin.notif.url.copied")));
  });

  it("取不到地址时退回「去 Outputs 里看」，抽屉照样能开", async () => {
    // 三种成因（没装 IM / API 名字对不上 / 查询无权限）对客户是同一个动作，所以合成一句话。
    // 关键是**不能把抽屉搞崩** —— 这一页是只有浏览器的客户唯一的接入入口。
    await openImTab();          // fixture 里没有 webhook_url → 空串
    fireEvent.click(document.querySelector("button.imx-guide-link") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector(".imd-panel")!.className).toContain("open"));
    expect(document.querySelector(".imd-urlbox")).toBeNull();
    expect(document.querySelector(".imd-body")!.textContent).toContain(zh("admin.notif.url.missing"));
    expect(document.querySelectorAll(".imd-body .imd-h").length).toBe(7);
  });

  it("抽屉标题/副标题走 i18n，关闭按钮有可读名字", async () => {
    await openImTab();
    fireEvent.click(document.querySelector("button.imx-guide-link") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector(".imd-panel")!.className).toContain("open"));
    expect(document.querySelector(".imd-title")!.textContent).toBe(zh("admin.notif.guideTitle"));
    expect(document.querySelector(".imd-sub")!.textContent).toBe(zh("admin.notif.guideSub"));
    expect(screen.getByLabelText(zh("panel.close"))).toBeTruthy();
  });
});
