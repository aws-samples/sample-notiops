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
  /** 钉钉段**可选**是刻意的：旧 BFF（还没部署钉钉那段）不回这一段，
   *  界面必须退回"全部空着"而不是白屏 —— 见下面同名断言。 */
  dingtalk?: {
    app_key: string; app_secret: string; push_webhook_url?: string; webhook_url?: string;
  };
  /** Slack 段同理可选（旧 BFF 不回）。注意这一段**两个字段都是凭证** ——
   *  没有飞书 App ID / 钉钉 App Key 那种明文可核对的字段。 */
  slack?: { bot_token: string; signing_secret: string; webhook_url?: string };
};
const putSpy = vi.fn(async (_cfg: Record<string, string>) => ({ message: "ok" }));
const putDtSpy = vi.fn(async (_cfg: Record<string, string>) => ({ message: "ok" }));
const testDtSpy = vi.fn(async () => ({ success: true, message: "token ok" }));
const putSlSpy = vi.fn(async (_cfg: Record<string, string>) => ({ message: "ok" }));
const testSlSpy = vi.fn(async () => ({ success: true, message: "scopes ok" }));

vi.mock("../api/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/admin")>();
  return {
    ...actual,
    fetchAllCapabilities: vi.fn(async () => []),
    fetchNotificationConfig: vi.fn(async () => getResp),
    putNotificationConfig: (cfg: Record<string, string>) => putSpy(cfg),
    testNotificationSend: vi.fn(async () => ({ success: true, message: "sent" })),
    putDingtalkConfig: (cfg: Record<string, string>) => putDtSpy(cfg),
    testDingtalkSend: () => testDtSpy(),
    putSlackConfig: (cfg: Record<string, string>) => putSlSpy(cfg),
    testSlackSend: () => testSlSpy(),
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
    // API id 是**占位**（`a1b2c3d4e5`）。别贴真实部署的 webhook 地址进来：这个仓要外发，
    // 而 IM webhook 是公网未鉴权入口，贴真值等于把某个部署的入口发到公网上。
    const url = "https://a1b2c3d4e5.execute-api.us-east-1.amazonaws.com/";
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
    const url = "https://a1b2c3d4e5.execute-api.us-east-1.amazonaws.com/";   // 占位，见上一条
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

/**
 * 钉钉分页（2026-09-08）。
 *
 * 为什么单独一组、而不是把上面那些断言参数化：**钉钉不是"飞书换个名字"**。
 * 字段集、能测到什么、以及配错时的症状，三样都不一样，而差异全都指向同一个后果 ——
 * 客户以为自己配好了，其实机器人一句话不回：
 *   · 钉钉保存回调地址时**不做任何校验**（没有飞书那种 URL challenge）→ 地址填错
 *     不会当场报错，唯一的排错入口是抽屉里那两条 `aws logs tail`；
 *   · 钉钉**没有**「往任意群发测试消息」的接口 → 「测试凭证」只能验 accessToken，
 *     这一点必须写在界面上，否则"测试通过 + 群里没反应"会被当成产品坏了；
 *   · 只有两把钥匙（没有 Encrypt Key / Verification Token），也没有推送群组列表 ——
 *     少画的框必须是**故意**少画，多画一个空框客户就会去找不存在的值。
 *
 * 另外两条是回归性质的：平台切换默认必须停在飞书（否则老客户进来看到的是空表单），
 * 且**同一时刻只挂一个抽屉**（`imd-webhook-url` 是固定 id）。
 */
const dtSecretInputs = () =>
  Array.from(document.querySelectorAll('input[name^="notiops-dingtalk-"]')) as HTMLInputElement[];

/** 打开「集成 IM」→ 切到钉钉分页。 */
async function openDtTab() {
  await openImTab();                       // 默认停在飞书（这本身是下面第一条断言）
  const btn = Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent === zh("admin.notif.platform.dingtalk"))!;
  expect(btn).toBeTruthy();
  fireEvent.click(btn);
  await waitFor(() => expect(dtSecretInputs().length).toBe(2));
}

describe("Admin「集成 IM」钉钉分页", () => {
  beforeEach(() => {
    cleanup();
    putDtSpy.mockClear();
    testDtSpy.mockClear();
    getResp = {
      feishu: {
        app_id: "cli_a1b2c3d4", app_secret: "****WXYZ",
        verification_token: "", encrypt_key: "", notify_chat_ids: "oc_room1",
      },
      dingtalk: {
        app_key: "dingabcd1234", app_secret: "****6789",
        push_webhook_url: "", webhook_url: "",
      },
    };
  });

  it("默认停在飞书分页；三个平台都在切换器里", async () => {
    // 老客户（只配了飞书）进这一页不该看到一张空表单 —— 那会让人以为配置丢了。
    await openImTab();
    expect(secretInputs().length).toBe(3);
    expect(dtSecretInputs().length).toBe(0);
    const btns = Array.from(document.querySelectorAll("button")).map((b) => b.textContent);
    expect(btns).toContain(zh("admin.notif.platform.feishu"));
    expect(btns).toContain(zh("admin.notif.platform.dingtalk"));
    expect(btns).toContain(zh("admin.notif.platform.slack"));
  });

  it("切到钉钉：两把钥匙 + App Key，飞书那三个框离场", async () => {
    await openDtTab();
    expect(secretInputs().length).toBe(0);       // 同一时刻只挂一个平台的表单
    const names = dtSecretInputs().map((el) => el.name);
    expect(names).toEqual(["notiops-dingtalk-app_secret", "notiops-dingtalk-push_webhook_url"]);
    const labels = labelTexts();
    expect(labels).toContain("App Key");
    // 钉钉没有这两样 —— 多画一个空框，客户会去钉钉控制台找不存在的值。
    expect(labels).not.toContain("Encrypt Key");
    expect(labels).not.toContain("Verification Token");
  });

  it("name 带平台前缀（否则浏览器把飞书的密钥填进钉钉那个框）", async () => {
    // 两个平台都有 `app_secret`。不带前缀的话，浏览器/密码管理器会认成同一个字段，
    // 把上一页存下的飞书密钥自动填过来 —— 保存后钉钉验签失败，症状指向"地址填错"。
    await openDtTab();
    for (const el of dtSecretInputs()) {
      expect(el.name).toMatch(/^notiops-dingtalk-/);
      expect(el.getAttribute("autocomplete")).toBe("new-password");
      expect(el.getAttribute("data-1p-ignore")).not.toBeNull();
      expect(el.getAttribute("data-lpignore")).toBe("true");
      expect(el.name).not.toMatch(/password/i);
    }
  });

  it("没有推送群组列表，取而代之的是一句说明", async () => {
    // 飞书要填 chat id 列表，钉钉不用（群里那条回复通道是回调里带的一次性地址）。
    // 少画的框必须是**故意**少画：界面得说出来，不然客户会以为这一页没做完。
    await openDtTab();
    expect(document.body.textContent).toContain(zh("admin.notif.dt.noChatIds"));
    expect(document.body.textContent).toContain(zh("admin.notif.dt.keysRequired"));
  });

  it("自定义机器人推送地址当**密钥**处理（那串地址本身就是凭证）", async () => {
    // 谁拿到那个地址都能往那个群发消息。所以它跟 App Secret 走同一条路：
    // 脱敏回显、谢绝自动填充、没动过就原样回传。
    getResp.dingtalk!.push_webhook_url = "****send";
    await openDtTab();
    const [, push] = dtSecretInputs();
    expect(push.value).toBe("****send");
    expect(push.type).toBe("text");        // 没动过 → 后 4 位真的看得见
    fireEvent.change(push, { target: { value: "https://oapi.dingtalk.com/robot/send?access_token=x" } });
    expect(dtSecretInputs()[1].type).toBe("password");
  });

  it("保存时 trim；没动过的两把钥匙原样回传（= 不修改）", async () => {
    await openDtTab();
    const appKeyInput = Array.from(document.querySelectorAll("input"))
      .find((el) => el.getAttribute("placeholder") === "dingxxxxxxxx")!;
    fireEvent.change(appKeyInput, { target: { value: "  dingnewkey9999 \n" } });
    const saveBtn = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent === zh("admin.notif.save"))!;
    fireEvent.click(saveBtn);
    await waitFor(() => expect(putDtSpy).toHaveBeenCalled());
    const sent = putDtSpy.mock.calls[0][0];
    expect(sent.app_key).toBe("dingnewkey9999");
    expect(sent.app_secret).toBe("****6789");        // 没动过 → 服务端原值
    expect(sent.push_webhook_url).toBe("");
    // 飞书那份的字段一个都不该混进来（后端是两个独立的 Secret）
    expect(sent.encrypt_key).toBeUndefined();
    expect(sent.verification_token).toBeUndefined();
    expect(sent.notify_chat_ids).toBeUndefined();
  });

  it("兜底：静默自动填充改不了钥匙", async () => {
    await openDtTab();
    const [secret] = dtSecretInputs();
    secret.value = "autofilled-by-password-manager";   // 不触发 onChange，同飞书那条
    fireEvent.click(Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent === zh("admin.notif.save"))!);
    await waitFor(() => expect(putDtSpy).toHaveBeenCalled());
    expect(putDtSpy.mock.calls[0][0].app_secret).toBe("****6789");
  });

  it("「测试凭证」不需要群 id 就能点，并如实说明它测到了什么", async () => {
    // 钉钉没有「往任意群发测试消息」的接口 → 这个按钮只验 accessToken。
    // 提示文案必须在界面上，否则"测试通过 + 群里没反应"会被当成产品坏了。
    await openDtTab();
    const testBtn = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent === zh("admin.notif.dt.test"))!;
    expect(testBtn.getAttribute("title")).toBe(zh("admin.notif.dt.testTip"));
    fireEvent.click(testBtn);
    await waitFor(() => expect(testDtSpy).toHaveBeenCalled());
    await waitFor(() => expect(document.body.textContent).toContain("token ok"));
  });

  it("旧 BFF 不回 dingtalk 段 → 退回空表单，不白屏", async () => {
    // 前端资产与 BFF 在同一个栈里更新，但客户浏览器可能拿到缓存下来的旧前端，
    // 反过来也可能：新前端 + 还没更新完的 BFF。缺这一段时必须还能配。
    delete getResp.dingtalk;
    await openDtTab();
    expect(dtSecretInputs().map((el) => el.value)).toEqual(["", ""]);
    expect(document.querySelector(".imx-steps")).toBeTruthy();
  });

  it("钉钉抽屉：七节步骤 + 回调地址 + 明说钉钉保存时不校验", async () => {
    const url = "https://a1b2c3d4e5.execute-api.us-east-1.amazonaws.com/";   // 占位，见飞书那条
    getResp.dingtalk!.webhook_url = url;
    await openDtTab();
    const panel = () => document.querySelector(".imd-panel")!;
    fireEvent.click(document.querySelector("button.imx-guide-link") as HTMLButtonElement);
    await waitFor(() => expect(panel().className).toContain("open"));

    // 同一时刻只有一个抽屉在 DOM 里（`imd-webhook-url` 是固定 id）
    expect(document.querySelectorAll(".imd-panel").length).toBe(1);
    expect(document.querySelector(".imd-title")!.textContent).toBe(zh("admin.notif.dt.guideTitle"));
    expect(document.querySelectorAll(".imd-body .imd-h").length).toBe(7);

    const body = document.querySelector(".imd-body")!.textContent || "";
    // 客户在浏览器里配不完的那几件事必须写明
    expect(body).toContain("HTTP");                       // 默认是 Stream 模式，必须改
    expect(body).toContain("不做任何校验");                 // 没有 URL challenge → 填错不报错
    expect(body).toContain("notiops-im-ingress-dingtalk"); // 唯一的排错入口
    expect(body).not.toContain("put-secret-value");        // 抽屉是给只有浏览器的客户看的

    const input = document.querySelector("input.imd-url") as HTMLInputElement;
    expect(input.value).toBe(url);
    expect(input.readOnly).toBe(true);
  });

  it("取不到回调地址时指向 DingtalkWebhookUrl 这个 Output（不是飞书那个名字）", async () => {
    // 指错 Output 名字的代价：客户在 Outputs 里翻不到，以为部署漏了东西。
    await openDtTab();               // fixture 里 webhook_url 是空串
    fireEvent.click(document.querySelector("button.imx-guide-link") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector(".imd-panel")!.className).toContain("open"));
    const body = document.querySelector(".imd-body")!.textContent || "";
    expect(document.querySelector(".imd-urlbox")).toBeNull();
    expect(body).toContain(zh("admin.notif.dt.url.missing"));
    expect(body).toContain("DingtalkWebhookUrl");
    expect(body).not.toContain("FeishuWebhookUrl");
    expect(document.querySelectorAll(".imd-body .imd-h").length).toBe(7);
  });
});

/**
 * Slack 分页（2026-09-11）。
 *
 * 与另两个平台的差异比它们彼此之间大 —— 这一组盯的就是这些差异，而不是"再跑一遍
 * 同样的断言"：
 *   · **两个字段都是凭证**：没有飞书 App ID / 钉钉 App Key 那种明文可核对的字段，
 *     所以"我配的是哪个 App"只能靠「测试凭证」回的 workspace 名字确认；
 *   · **「未配置」不等于「空」**：方式 B 里这两个 secret 由 CDK 建、值是随机串，
 *     忘了填的症状是 `invalid_auth` / 401，不是"空"。这句警告必须画在**表单里**，
 *     不能只写在抽屉里 —— 卡住的人不会去点「详细步骤」；
 *   · **「测试凭证」验不了 signing secret**（没有任何 API 能验），但能报出缺的 scope。
 *     界面必须如实说，否则"测试通过 + Slack 说校验失败"会被当成产品坏了；
 *   · 抽屉必须说清**三处 Request URL 是同一个地址**、以及**不要开 Socket Mode**
 *     （开了之后 Slack 根本不发请求，日志里什么都没有，看起来像地址填错）。
 */
const slSecretInputs = () =>
  Array.from(document.querySelectorAll('input[name^="notiops-slack-"]')) as HTMLInputElement[];

/** 打开「集成 IM」→ 切到 Slack 分页。 */
async function openSlTab() {
  await openImTab();                       // 默认停在飞书
  const btn = Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent === zh("admin.notif.platform.slack"))!;
  expect(btn).toBeTruthy();
  fireEvent.click(btn);
  await waitFor(() => expect(slSecretInputs().length).toBe(2));
}

describe("Admin「集成 IM」Slack 分页", () => {
  beforeEach(() => {
    cleanup();
    putSlSpy.mockClear();
    testSlSpy.mockClear();
    getResp = {
      feishu: {
        app_id: "cli_a1b2c3d4", app_secret: "****WXYZ",
        verification_token: "", encrypt_key: "", notify_chat_ids: "oc_room1",
      },
      slack: { bot_token: "****wxyz", signing_secret: "****cdef", webhook_url: "" },
    };
  });

  it("切到 Slack：两个框都是密钥框，另两个平台的表单离场", async () => {
    await openSlTab();
    expect(secretInputs().length).toBe(0);       // 同一时刻只挂一个平台的表单
    expect(dtSecretInputs().length).toBe(0);
    expect(slSecretInputs().map((el) => el.name))
      .toEqual(["notiops-slack-bot_token", "notiops-slack-signing_secret"]);
    const labels = labelTexts();
    expect(labels).toContain("Bot User OAuth Token");
    expect(labels).toContain("Signing Secret");
    // Slack 没有这些 —— 多画一个空框，客户会去 Slack 后台找不存在的值。
    expect(labels).not.toContain("Encrypt Key");
    expect(labels).not.toContain("App Key");
  });

  it("name 带平台前缀（否则浏览器把钉钉/飞书的密钥填进这两个框）", async () => {
    await openSlTab();
    for (const el of slSecretInputs()) {
      expect(el.name).toMatch(/^notiops-slack-/);
      expect(el.getAttribute("autocomplete")).toBe("new-password");
      expect(el.getAttribute("data-1p-ignore")).not.toBeNull();
      expect(el.getAttribute("data-lpignore")).toBe("true");
      expect(el.name).not.toMatch(/password/i);
    }
  });

  it("「未配置≠空」这条警告画在表单里，不只在抽屉里", async () => {
    // 方式 B 客户最容易卡住的地方就是这个（secret 里躺着 CDK 随机串），而卡住时
    // 人不会去点「详细步骤」—— 所以这句必须在表单上直接看得到。
    await openSlTab();
    expect(document.body.textContent).toContain(zh("admin.notif.sl.notEmptyWarn"));
    expect(document.body.textContent).toContain(zh("admin.notif.sl.keysRequired"));
  });

  it("已配置且没动过 → type=text（后 4 位真看得见）；一动手切 password", async () => {
    await openSlTab();
    const [tok, sign] = slSecretInputs();
    expect(tok.value).toBe("****wxyz");
    expect(sign.value).toBe("****cdef");
    expect(tok.type).toBe("text");
    // 这里刻意**不**写成 `xoxb-…` 形状：本条只断言"动过手就切 password"，跟值的形状无关，
    // 而任何 `xoxb-` 开头的字面量都会被 pre-commit 的密钥扫描器当硬编码 Slack token 报警
    // （每次改这个文件都报一次），也会在公开仓库里给客户的安全扫描制造假阳性。
    fireEvent.change(tok, { target: { value: "a-value-typed-by-hand" } });
    expect(slSecretInputs()[0].type).toBe("password");
  });

  it("保存时 trim；没动过的那个原样回传（= 不修改）", async () => {
    // 两个值都是从 Slack 后台**复制**来的，粘贴带尾随空格/换行是常事：bot token 带
    // 空格 → invalid_auth；signing secret 带空格 → 每次验签 401，而 Slack 只说
    // 「URL 校验不通过」。两种症状都指不到真因。
    await openSlTab();
    const [, sign] = slSecretInputs();
    fireEvent.change(sign, { target: { value: "  0123456789abcdef0123456789abcdef \n" } });
    fireEvent.click(Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent === zh("admin.notif.save"))!);
    await waitFor(() => expect(putSlSpy).toHaveBeenCalled());
    const sent = putSlSpy.mock.calls[0][0];
    expect(sent.signing_secret).toBe("0123456789abcdef0123456789abcdef");
    expect(sent.bot_token).toBe("****wxyz");     // 没动过 → 服务端原值
    // 另两个平台的字段一个都不该混进来（后端是三份独立的 Secret）
    expect(sent.app_key).toBeUndefined();
    expect(sent.encrypt_key).toBeUndefined();
    expect(sent.push_webhook_url).toBeUndefined();
  });

  it("兜底：静默自动填充改不了钥匙", async () => {
    await openSlTab();
    const [tok] = slSecretInputs();
    tok.value = "autofilled-by-password-manager";   // 不触发 onChange，同另两个平台
    fireEvent.click(Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent === zh("admin.notif.save"))!);
    await waitFor(() => expect(putSlSpy).toHaveBeenCalled());
    expect(putSlSpy.mock.calls[0][0].bot_token).toBe("****wxyz");
  });

  it("「测试凭证」如实说明它验不了 signing secret、但会报缺的 scope", async () => {
    await openSlTab();
    const testBtn = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent === zh("admin.notif.sl.test"))!;
    expect(testBtn.getAttribute("title")).toBe(zh("admin.notif.sl.testTip"));
    fireEvent.click(testBtn);
    await waitFor(() => expect(testSlSpy).toHaveBeenCalled());
    await waitFor(() => expect(document.body.textContent).toContain("scopes ok"));
  });

  it("旧 BFF 不回 slack 段 → 退回空表单，不白屏", async () => {
    delete getResp.slack;
    await openSlTab();
    expect(slSecretInputs().map((el) => el.value)).toEqual(["", ""]);
    expect(document.querySelector(".imx-steps")).toBeTruthy();
  });

  it("Slack 抽屉：七节 + 三处同一地址 + 不要开 Socket Mode + 回调地址", async () => {
    const url = "https://a1b2c3d4e5.execute-api.us-east-1.amazonaws.com/";   // 占位，见飞书那条
    getResp.slack!.webhook_url = url;
    await openSlTab();
    fireEvent.click(document.querySelector("button.imx-guide-link") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector(".imd-panel")!.className).toContain("open"));

    // 同一时刻只有一个抽屉在 DOM 里（`imd-webhook-url` 是固定 id）
    expect(document.querySelectorAll(".imd-panel").length).toBe(1);
    expect(document.querySelector(".imd-title")!.textContent).toBe(zh("admin.notif.sl.guideTitle"));
    expect(document.querySelectorAll(".imd-body .imd-h").length).toBe(7);

    const body = document.querySelector(".imd-body")!.textContent || "";
    expect(body).toContain("全填同一个");                  // 三处 Request URL 是同一个地址
    expect(body).toContain("Socket Mode");                // 开了就收不到任何请求
    expect(body).toContain("app_mention");                // 4 个 bot events
    expect(body).toContain("notiops-im-ingress-slack");   // 排错入口
    expect(body).not.toContain("put-secret-value");       // 抽屉是给只有浏览器的客户看的

    const input = document.querySelector("input.imd-url") as HTMLInputElement;
    expect(input.value).toBe(url);
    expect(input.readOnly).toBe(true);
  });

  it("取不到回调地址时指向 SlackWebhookUrl 这个 Output（不是另两个名字）", async () => {
    await openSlTab();               // fixture 里 webhook_url 是空串
    fireEvent.click(document.querySelector("button.imx-guide-link") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector(".imd-panel")!.className).toContain("open"));
    const body = document.querySelector(".imd-body")!.textContent || "";
    expect(document.querySelector(".imd-urlbox")).toBeNull();
    expect(body).toContain(zh("admin.notif.sl.url.missing"));
    expect(body).toContain("SlackWebhookUrl");
    expect(body).not.toContain("FeishuWebhookUrl");
    expect(body).not.toContain("DingtalkWebhookUrl");
    expect(document.querySelectorAll(".imd-body .imd-h").length).toBe(7);
  });
});
