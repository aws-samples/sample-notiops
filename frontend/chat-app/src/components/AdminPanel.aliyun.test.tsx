/**
 * Admin「多云」板块的契约（AliyunView + 阿里云凭据抽屉）。
 *
 * 为什么值得一份测试：这一页是**客户不碰 CLI 登记另一朵云凭据的唯一入口**，而它出问题
 * 的方式全都是「不报错、只是骗人」：
 *   · 未配置的密钥回显成 `****` → 客户以为配好了，去别处找为什么多云不工作；
 *   · 「已配置」由前端自己判空 → 与后端判据（两个字段都非空）迟早不一致，同上；
 *   · 没动过的密钥框被浏览器自动填充后原样保存 → 密钥被静默换掉，阿里云那边开始
 *     「签名不对」，症状和「密钥填错了」一模一样；
 *   · 保存时不 trim → 从阿里云控制台复制粘贴带尾随空格，同上；
 *   · **多出一个「测试连接」按钮** → 只验格式的「通过」会被读成「多云已可用」。
 *     这一条是产品决定，不是遗漏，所以由测试钉住"不许有"。
 *
 * 还有一条**结构性**不变量只能在这里守：ImGuideDrawer 对没接线的 `webhookUrl` 块是
 * **静默不渲染**的（见那个文件头的 ⚠️），所以「这份 guide 里混进了一个 webhook 地址块」
 * 靠人看抽屉看不出来 —— 只能断言内容里没有那个块。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup, waitFor, fireEvent, screen } from "@testing-library/react";

import { STRINGS } from "../i18n";
import { ALIYUN_GUIDE } from "../content/aliyunGuide";

/** 后端 GET /admin/aliyun-config 回来的形态（见 bff/web-chat/aliyun_config.mjs）：
 *  `access_key_secret` 已脱敏，未配置时是**空串而不是 ****；`configured` 是后端的判据。 */
let getResp: {
  aliyun?: {
    access_key_id: string; access_key_secret: string; region_id: string;
    auth_mode?: string; configured?: boolean;
    // STAROps 数字员工那一段。`starops_configured` 与 `configured` 是**两个独立判据**
    // （前者还要求填了员工名），所以两个都得能在 fixture 里单独摆。
    starops_employee?: string; starops_region?: string;
    starops_workspace?: string; starops_project?: string;
    starops_configured?: boolean;
  };
};
const putSpy = vi.fn(async (_cfg: Record<string, string>) => ({ message: "ok" }));

/** ⚠️ 2026-09-15 起「多云」这一条**不在左导航里**（产品决定：多云先不对外，见
 *  `featureFlags.ts`）。这份测试守的是**实现还在、翻开就能用** —— 所以这里把开关
 *  mock 成 `true`，让 nav 出现，下面所有用例照旧验那一页的行为。
 *
 *  为什么不改成「断言点不到」：那样等于用测试把这一页锁死在关闭状态，翻开开关的那天
 *  没有任何用例覆盖它，而这一页恰好是**客户登记另一朵云凭据的唯一入口**。
 *  「关着的时候 nav 里没有这一条」由 `AdminPanel.nav.test.tsx` 钉 —— 它**不 mock**
 *  这个开关，跟着仓库里真实的字面量走，所以必须是另一个文件（mock 是整文件生效的）。 */
vi.mock("../featureFlags", () => ({ MULTICLOUD_UI: true }));

vi.mock("../api/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/admin")>();
  return {
    ...actual,
    fetchAllCapabilities: vi.fn(async () => []),
    fetchAliyunConfig: vi.fn(async () => getResp),
    putAliyunConfig: (cfg: Record<string, string>) => putSpy(cfg),
  };
});

import AdminPanel from "./AdminPanel";

const zh = (k: string) => STRINGS[k].zh;

/** 这一页只有一个密钥框。按 `name` 选而不是按 `type=password`：那个 type 是**会变的**
 *  （没动过的脱敏串用 text，否则「仅显示后 4 位」就成了空话），按 type 选会让
 *  "框变了形态"伪装成"框不见了"。 */
const akSecretInputs = () =>
  Array.from(document.querySelectorAll('input[name^="notiops-aliyun-"]')) as HTMLInputElement[];
const akIdInput = () =>
  document.querySelector('input[placeholder="LTAIxxxxxxxxxxxxxxxx"]') as HTMLInputElement;
const regionInput = () =>
  document.querySelector('input[placeholder="cn-hangzhou"]') as HTMLInputElement;
const divTexts = () => Array.from(document.querySelectorAll("div")).map((d) => d.textContent || "");
const buttons = () => Array.from(document.querySelectorAll("button"));
const saveBtn = () => buttons().find((b) => b.textContent === zh("admin.notif.save"))!;

/** 打开「多云」tab（默认 tab 是角色）。 */
async function openAliyunTab() {
  render(<AdminPanel />);
  const tab = buttons().find((b) => b.textContent === zh("admin.tab.aliyun"))!;
  expect(tab).toBeTruthy();     // 漏了 NAV_ITEMS 那一条 → tab 编译得过但点不到
  fireEvent.click(tab);
  await waitFor(() => expect(akSecretInputs().length).toBe(1));
}

describe("Admin「多云」阿里云凭据表单", () => {
  beforeEach(() => {
    cleanup();
    putSpy.mockClear();
    getResp = {
      aliyun: {
        access_key_id: "LTAIabcd1234efgh", access_key_secret: "****WXYZ",
        region_id: "cn-hangzhou", auth_mode: "ak", configured: true,
        starops_employee: "my-sre-agent", starops_region: "cn-beijing",
        starops_workspace: "ws-demo", starops_project: "sls-demo",
        starops_configured: true,
      },
    };
  });

  // 「只有这三个」现在指的是**凭据那一格**：STAROps 数字员工那一段在同一页的下半部分
  // （见下面那个 describe）。这条守的仍是老不变量 —— IM 三个平台的字段一个都不该混进来。
  it("凭据那三个字段都能在页面上填，且 IM 那几个字段一个都没混进来", async () => {
    await openAliyunTab();
    expect(akIdInput()).toBeTruthy();
    expect(regionInput()).toBeTruthy();
    expect(akSecretInputs().map((el) => el.name)).toEqual(["notiops-aliyun-access_key_secret"]);
    const labels = divTexts();
    expect(labels).toContain("AccessKey ID");
    expect(labels).toContain("AccessKey Secret");
    expect(labels).toContain(zh("admin.aliyun.region"));
    // IM 那三个平台的字段一个都不该出现在这一页（它不是第 4 个 IM 平台）
    expect(labels).not.toContain("Encrypt Key");
    expect(labels).not.toContain("App Key");
    expect(labels).not.toContain("Signing Secret");
  });

  it("未配置的密钥显示为空白输入框，不是 ****", async () => {
    // 这是最贵的显示型 bug：回显 **** 会让客户以为已经配好，然后去别处找
    // 「为什么多云不工作」。空 = 明摆着还没填。
    getResp.aliyun = { access_key_id: "", access_key_secret: "", region_id: "cn-hangzhou", configured: false };
    await openAliyunTab();
    expect(akSecretInputs()[0].value).toBe("");
    expect(akIdInput().value).toBe("");
  });

  it("已配置且没动过 → type=text（后 4 位真看得见）；一动手切 password", async () => {
    // 提示文案写着「仅显示后 4 位」。password 会把 WXYZ 也画成圆点，那句话就永远不成立。
    await openAliyunTab();
    const [sec] = akSecretInputs();
    expect(sec.value).toBe("****WXYZ");
    expect(sec.type).toBe("text");
    fireEvent.change(sec, { target: { value: "a-value-typed-by-hand" } });
    expect(akSecretInputs()[0].type).toBe("password");
  });

  it("密钥框谢绝浏览器自动填充，name 带 aliyun 前缀", async () => {
    // 不带前缀的话，浏览器会把 IM 那几页存下的 app_secret 填进这个框 —— 保存后
    // 阿里云验签失败，症状指向"密钥填错了"。
    await openAliyunTab();
    const [sec] = akSecretInputs();
    expect(sec.name).toBe("notiops-aliyun-access_key_secret");
    expect(sec.getAttribute("autocomplete")).toBe("new-password");
    expect(sec.getAttribute("data-1p-ignore")).not.toBeNull();
    expect(sec.getAttribute("data-lpignore")).toBe("true");
    expect(sec.name).not.toMatch(/password/i);
  });

  it("保存时三个字段都 trim，没动过的密钥原样回传（= 不修改）", async () => {
    // 这三个值都是从阿里云控制台**复制**来的，带尾随空格/换行是常事，而后果是签名失败 ——
    // 与「密钥填错了」同一个症状，指不到真因。
    await openAliyunTab();
    fireEvent.change(akIdInput(), { target: { value: "  LTAInew1234567890 \n" } });
    fireEvent.change(regionInput(), { target: { value: " ap-southeast-1\t" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const sent = putSpy.mock.calls[0][0];
    expect(sent.access_key_id).toBe("LTAInew1234567890");
    expect(sent.region_id).toBe("ap-southeast-1");
    expect(sent.access_key_secret).toBe("****WXYZ");   // 没动过 → 服务端原值
    // IM 那几份 Secret 的字段一个都不该混进来（后端是另一个独立的 Secret）
    expect(sent.app_secret).toBeUndefined();
    expect(sent.bot_token).toBeUndefined();
  });

  it("兜底：静默自动填充改不了密钥", async () => {
    // 直接改 DOM 的 value 而**不**触发 React 的 onChange —— 静默自动填充在受控组件上
    // 就是这个形态。会正常派发 input 事件的密码管理器靠上一条的属性拦。
    await openAliyunTab();
    akSecretInputs()[0].value = "autofilled-by-password-manager";
    fireEvent.click(saveBtn());
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][0].access_key_secret).toBe("****WXYZ");
  });

  it("「已配置」用后端的 configured，前端不自己判空", async () => {
    // 两处各判一次迟早不一致，而不一致的表现正是这一页最贵的 bug：界面骗人。
    // 这个 fixture 里两个字段都非空、但后端说 configured=false —— 界面必须听后端的。
    getResp.aliyun = {
      access_key_id: "LTAIabcd1234efgh", access_key_secret: "****WXYZ",
      region_id: "cn-hangzhou", configured: false,
    };
    await openAliyunTab();
    expect(divTexts()).toContain(zh("admin.aliyun.notConfigured"));
    expect(divTexts()).not.toContain(zh("admin.aliyun.configured"));
  });

  it("**没有「测试连接」按钮**，并且界面上明说为什么、替代判据是什么", async () => {
    // 产品决定（见 AliyunView 的注释）：能证明这副密钥有效的调用还没接进来，只验格式的
    // 「通过」会被读成「多云已可用」。所以这里钉的是"不许有"，外加那句说明必须画在**表单里**
    //  —— 找不到「测试」的人不会去点「详细步骤」。
    await openAliyunTab();
    expect(buttons().map((b) => b.textContent || "").filter((s) => s.includes("测试"))).toEqual([]);
    expect(document.body.textContent).toContain(zh("admin.aliyun.noTest"));
    expect(document.body.textContent).toContain(zh("admin.aliyun.required"));
  });

  it("旧 BFF 不回 aliyun 段 → 退回空表单，不白屏", async () => {
    // 前端资产与 BFF 在同一个栈里更新，但客户浏览器可能拿到缓存下来的新前端 + 旧 BFF。
    delete getResp.aliyun;
    await openAliyunTab();
    expect(akSecretInputs()[0].value).toBe("");
    expect(akIdInput().value).toBe("");
    expect(document.querySelector(".imx-steps")).toBeTruthy();
  });
});

/**
 * STAROps 数字员工那一段（同一页的下半部分，同一个保存按钮）。
 *
 * 这一段决定「新对话」里第三个对话对象能不能选，而它出错的方式同样是**不报错、只是骗人**：
 *   · 「已接入」若由前端自己判空 → 与后端判据（凭据 + 员工名都在）迟早不一致，页面说能选、
 *     对话里那一段却是灰的；
 *   · 地域做成输入框 → 填错只表现为一个语义为空的 404，客户会去改员工名（改错地方）；
 *   · 保存不 trim → 从控制台复制粘贴带尾随空格，同上，指不到真因；
 *   · 「项目」不写清是**日志服务(SLS)**的 project → 客户填一个业务项目名，然后收到查不到
 *     日志的空回答。这是这一段最容易犯、也最难自己看出来的错。
 */
describe("Admin「多云」STAROps 数字员工那一段", () => {
  const soEmployeeInput = () =>
    document.querySelector('input[placeholder="my-sre-agent"]') as HTMLInputElement;
  const soRegionSelects = () => Array.from(document.querySelectorAll("select")) as HTMLSelectElement[];
  const soOptionalInputs = () =>
    Array.from(document.querySelectorAll(`input[placeholder="${zh("admin.aliyun.so.optionalPh")}"]`)) as HTMLInputElement[];

  beforeEach(() => {
    cleanup();
    putSpy.mockClear();
    getResp = {
      aliyun: {
        access_key_id: "LTAIabcd1234efgh", access_key_secret: "****WXYZ",
        region_id: "cn-hangzhou", auth_mode: "ak", configured: true,
        starops_employee: "my-sre-agent", starops_region: "cn-beijing",
        starops_workspace: "ws-demo", starops_project: "sls-demo",
        starops_configured: true,
      },
    };
  });

  it("四个字段都在页面上，且地域是下拉、取值只有 cn-beijing / ap-southeast-1", async () => {
    await openAliyunTab();
    expect(soEmployeeInput()).toBeTruthy();
    expect(soOptionalInputs().length).toBe(2);           // 工作空间 + 项目
    // 下拉而不是输入框，且穷举清单与 bff/web-chat/aliyun_config.mjs 的 STAROPS_REGIONS 一致。
    // 多出一个取值 = 客户能选一个我们签不出名字的地域（后端 400，页面上像"保存失败"）。
    expect(soRegionSelects().length).toBe(1);
    expect(Array.from(soRegionSelects()[0].options).map((o) => o.value)).toEqual(["cn-beijing", "ap-southeast-1"]);
    const labels = divTexts();
    expect(labels).toContain(zh("admin.aliyun.so.employee"));
    expect(labels).toContain(zh("admin.aliyun.so.region"));
    expect(labels).toContain(zh("admin.aliyun.so.workspace"));
    expect(labels).toContain(zh("admin.aliyun.so.project"));
  });

  it("加载时四个值都回显（含地域选中态）", async () => {
    await openAliyunTab();
    expect(soEmployeeInput().value).toBe("my-sre-agent");
    expect(soRegionSelects()[0].value).toBe("cn-beijing");
    expect(soOptionalInputs().map((el) => el.value)).toEqual(["ws-demo", "sls-demo"]);
  });

  it("「已接入」用后端的 starops_configured，前端不自己判空", async () => {
    // fixture 里员工名非空、凭据也 configured，但后端说 starops_configured=false ——
    // 界面必须听后端的，否则页面说"可以选"而对话里那一段是灰的。
    getResp.aliyun!.starops_configured = false;
    await openAliyunTab();
    expect(divTexts()).toContain(zh("admin.aliyun.so.notConfigured"));
    expect(divTexts()).not.toContain(zh("admin.aliyun.so.configured"));
  });

  it("保存时四项一起发出去，三个名字字段都 trim", async () => {
    await openAliyunTab();
    fireEvent.change(soEmployeeInput(), { target: { value: "  sre-bot \n" } });
    fireEvent.change(soRegionSelects()[0], { target: { value: "ap-southeast-1" } });
    fireEvent.change(soOptionalInputs()[0], { target: { value: " ws-prod\t" } });
    fireEvent.change(soOptionalInputs()[1], { target: { value: "  sls-prod " } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const sent = putSpy.mock.calls[0][0];
    expect(sent.starops_employee).toBe("sre-bot");
    expect(sent.starops_region).toBe("ap-southeast-1");
    expect(sent.starops_workspace).toBe("ws-prod");
    expect(sent.starops_project).toBe("sls-prod");
    // 同一个保存按钮 —— 凭据那几项必须跟着一起回传，否则保存员工名会把密钥清掉。
    expect(sent.access_key_id).toBe("LTAIabcd1234efgh");
    expect(sent.access_key_secret).toBe("****WXYZ");
  });

  it("整页只有一个保存按钮（不存在「配了一半」的中间态）", async () => {
    await openAliyunTab();
    expect(buttons().filter((b) => b.textContent === zh("admin.notif.save")).length).toBe(1);
  });

  it("「项目」那一栏在界面上点明是日志服务（SLS）的 project", async () => {
    // 阿里云上"项目"至少有三层意思。写成笼统的"项目名"，客户填业务项目名 → 数字员工
    // 查不到日志，回一个空答案，而页面上一切看起来都配好了。
    await openAliyunTab();
    expect(zh("admin.aliyun.so.project")).toContain("日志服务");
    expect(document.body.textContent).toContain(zh("admin.aliyun.so.projectHint"));
    expect(zh("admin.aliyun.so.projectHint")).toContain("SLS");
  });

  it("第一格叫「ID」而不是「名称」，且提示明确排掉显示名", async () => {
    // 2026-09-13 现网配置时踩到的：这一格原来叫「数字员工名称」，而要填的是控制台里那个
    // **ID**（内置员工形如 `apsara-ops`）。这不是措辞洁癖 —— 员工的 ID 与显示名是
    // `GetDigitalEmployee` 回的**两个不同字段**，我们请求里发的是 ID；写「名称」会把客户
    // 直接推向唯一那个我们诊断不了的错误：阿里云对不存在的员工回一个语义为空的 404
    // `DigitalEmployeeNotExist`，界面只能说「连不上」，指不到真因。
    await openAliyunTab();
    for (const loc of ["zh", "en"] as const) {
      const label = STRINGS["admin.aliyun.so.employee"][loc];
      expect(label, `${loc} 标签必须是 ID`).toMatch(/\bID\b/);
      expect(label, `${loc} 标签不许再写「名称/name」`).not.toMatch(/名称|[Nn]ame/);
      const hint = STRINGS["admin.aliyun.so.employeeHint"][loc];
      expect(hint, `${loc} 提示要给出 ID 的样子`).toContain("apsara-ops");
      expect(hint, `${loc} 提示要明说不是显示名`).toMatch(/显示名|display name/);
    }
    // 标签确实渲染出来了（只断言 STRINGS 会漏掉「组件里写死了旧文案」这种改法）。
    expect(divTexts()).toContain(zh("admin.aliyun.so.employee"));
    // ⚠️ 反过来也要守：我们**没有**实测过控制台上那个显示名长什么样，所以文案里不许
    // 出现一个具体的显示名。编一个值出来，客户照着找不到、反而更确信自己填对了。
    expect(STRINGS["admin.aliyun.so.employeeHint"].zh).not.toContain("智能运维助手");
    expect(STRINGS["admin.aliyun.so.employeeHint"].en).not.toContain("智能运维助手");
  });

  it("旧 BFF 不回 starops_* → 空表单 + 地域回落 cn-beijing，不白屏", async () => {
    // 前端资产与 BFF 同栈更新，但客户浏览器可能拿到缓存的新前端 + 旧 BFF。
    getResp.aliyun = { access_key_id: "", access_key_secret: "", region_id: "cn-hangzhou", configured: false };
    await openAliyunTab();
    expect(soEmployeeInput().value).toBe("");
    expect(soRegionSelects()[0].value).toBe("cn-beijing");
    expect(soOptionalInputs().map((el) => el.value)).toEqual(["", ""]);
    expect(divTexts()).toContain(zh("admin.aliyun.so.notConfigured"));
  });
});

describe("阿里云凭据步骤抽屉", () => {
  beforeEach(() => {
    cleanup();
    getResp = {
      aliyun: { access_key_id: "", access_key_secret: "", region_id: "cn-hangzhou", configured: false },
    };
  });

  it("页面上先给三步速览 + 不可逆提醒（不必先去翻文档）", async () => {
    await openAliyunTab();
    const txt = document.body.textContent || "";
    for (const k of ["admin.aliyun.steps.title", "admin.aliyun.steps.s1",
                     "admin.aliyun.steps.s2", "admin.aliyun.steps.s3", "admin.aliyun.steps.order"]) {
      expect(txt).toContain(zh(k));
    }
  });

  it("点超链接打开右侧抽屉；六节步骤都在；Esc 关闭", async () => {
    await openAliyunTab();
    const panel = () => document.querySelector(".imd-panel")!;
    // 抽屉常驻 DOM、靠 .open 平移进来（动画需要），所以判据是 class 而不是存在性。
    expect(panel().className).not.toContain("open");

    const link = document.querySelector("button.imx-guide-link") as HTMLButtonElement;
    expect(link.textContent).toContain(zh("admin.notif.guideLink"));
    fireEvent.click(link);
    await waitFor(() => expect(panel().className).toContain("open"));

    expect(document.querySelectorAll(".imd-panel").length).toBe(1);   // imd-webhook-url 是固定 id
    expect(document.querySelector(".imd-title")!.textContent).toBe(zh("admin.aliyun.guideTitle"));
    expect(document.querySelector(".imd-sub")!.textContent).toBe(zh("admin.aliyun.guideSub"));
    expect(document.querySelectorAll(".imd-body .imd-h").length).toBe(6);

    const body = document.querySelector(".imd-body")!.textContent || "";
    expect(body).toContain("ram.console.aliyun.com");     // 客户要去的那个控制台
    // 要挂的那条策略。🔁 2026-09-13：上一版断言的是 `AliyunReadOnlyAccess` —— 那个策略名
    // **根本不存在**（枚举阿里云全部 979 条系统策略确认），客户照着搜是空列表。真名逐字来自
    // `ram:GetPolicy`。`\b` 边界是必须的：`AliyunSTAROpsReadOnlyAccess` 自己就含子串
    // `ReadOnlyAccess`（AWS 侧那条正牌策略名，抽屉里也在用），不加边界两条会互相误伤。
    expect(body).toContain("AliyunSTAROpsReadOnlyAccess");
    expect(body).not.toMatch(/\bAliyunReadOnlyAccess\b/);
    // 官方策略把 CreateThread / CreateChat 的资源限定在 `digitalemployee/apsara-*`（全小写、
    // 逐字）。这一句在不在界面上，决定了自建员工的客户会不会踩「页面显示已接入、问第一句才
    // 吃 403 NoPermission」那个最坏形状的缺陷。
    expect(body).toContain("digitalemployee/apsara-");
    expect(body).toContain("再也取不回来");                 // 唯一不可逆的一步
    expect(body).toContain("不等于");                      // 只读 ≠ 看不到数据
    expect(body).not.toContain("put-secret-value");       // 抽屉是给只有浏览器的客户看的

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(panel().className).not.toContain("open"));
  });

  it("抽屉里没有 webhook 地址块，也没有那条兜底文案", async () => {
    // 配阿里云是**反方向**：我们这边没有任何要交给对方的地址。
    await openAliyunTab();
    fireEvent.click(document.querySelector("button.imx-guide-link") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector(".imd-panel")!.className).toContain("open"));
    const body = document.querySelector(".imd-body")!.textContent || "";
    expect(document.querySelector(".imd-urlbox")).toBeNull();
    expect(document.querySelector("#imd-webhook-url")).toBeNull();
    expect(body).not.toContain(zh("admin.notif.url.missing"));
    expect(body).not.toContain("WebhookUrl");
    expect(screen.getByLabelText(zh("panel.close"))).toBeTruthy();
  });
});

/**
 * 内容侧的不变量 —— 这一组**不渲染任何组件**，因为要守的正是"渲染看不出来"的那件事。
 *
 * AliyunGuideDrawer 刻意不传 `urlLabelKey` / `urlMissingKey`（配阿里云没有要交出去的
 * 地址），而 ImGuideDrawer 对没接线的 `webhookUrl` 块是**静默 return null**。于是
 * 「有人往 ALIYUN_GUIDE 里加了一个 webhook 地址块」在界面上什么都看不见 —— 只有在这里
 * 断言得到。反过来若哪天真需要那个块，正确做法是给抽屉补上那两条 key，而不是删掉本断言。
 */
describe("ALIYUN_GUIDE 内容不变量", () => {
  it("两种语言都没有 webhookUrl 块（否则会被静默丢弃）", () => {
    for (const [loc, blocks] of Object.entries(ALIYUN_GUIDE)) {
      expect(blocks.filter((b) => b.k === "webhookUrl"), `${loc} 里有 webhookUrl 块`).toEqual([]);
    }
  });

  it("zh / en 的章节数一致（漏译一整节在界面上只表现为「少了几段」）", () => {
    const heads = (l: "zh" | "en") => ALIYUN_GUIDE[l].filter((b) => b.k === "h").length;
    expect(heads("zh")).toBe(6);
    expect(heads("en")).toBe(heads("zh"));
  });

  it("每条 admin.aliyun.* 文案 zh / en 都齐（缺 en 时 t() 会把 key 直接画在界面上）", () => {
    const keys = Object.keys(STRINGS).filter((k) => k.startsWith("admin.aliyun.") || k === "admin.tab.aliyun");
    expect(keys.length).toBeGreaterThanOrEqual(18);
    for (const k of keys) {
      expect(STRINGS[k].zh, `${k}.zh`).toBeTruthy();
      expect(STRINGS[k].en, `${k}.en`).toBeTruthy();
    }
  });

  // 上面那条只检查**已存在**的 key 齐不齐；漏写一整条 key 的症状是界面上直接画出
  // "admin.aliyun.so.employeeHint" 这串字（t() 的回退是 key 本身），而 tsc 一声不响。
  // 所以这一段的 key 要逐个点名。
  it("STAROps 那一段引用的每条 key 都真的存在（否则界面上画出 key 本身）", () => {
    const need = [
      "title", "sub", "configured", "notConfigured",
      "employee", "employeeHint", "region", "regionHint",
      "workspace", "workspaceHint", "project", "projectHint",
      "optionalPh", "required",
    ].map((s) => `admin.aliyun.so.${s}`);
    for (const k of need) {
      expect(STRINGS[k], `缺 ${k}`).toBeTruthy();
      expect(STRINGS[k].zh, `${k}.zh`).toBeTruthy();
      expect(STRINGS[k].en, `${k}.en`).toBeTruthy();
    }
  });

  // en 侧品牌名必须统一成 "Alibaba Cloud"（官方英文名）。混用 "Aliyun" 的后果不是难看：
  // 同一朵云在一个产品里有两个名字，客户读不出"这两处说的是同一件事"。
  //
  // 唯一的例外是**策略专名**（阿里云自己就是这么起名的，改一个字客户就搜不到）。
  // 🔁 2026-09-13：这条守卫上一版写成 `/Aliyun(?!ReadOnlyAccess)/`，豁免的是
  // `AliyunReadOnlyAccess` —— 一条**根本不存在**的策略（枚举全部 979 条系统策略确认）。
  // 现在换成**闭集允许清单 + 反向占位检查**，比负向 lookahead 强三处：① 报得出是哪个词元，
  // 不只是哪条 key；② 拼错的 `AliyunSTAROpsReadonlyAccess` 也会被点名；③ 豁免不会腐烂 ——
  // 将来文案不再点名策略时，反向检查会要求把豁免一起删掉，而不是留一张空头许可。
  const ALLOWED_ALIYUN_TOKENS = new Set(["AliyunSTAROpsReadOnlyAccess"]);

  it("en 文案不混用 Aliyun / Alibaba Cloud 两个品牌名（只放过策略专名）", () => {
    const scanned = Object.entries(STRINGS)
      .filter(([k]) => k.startsWith("admin.aliyun.") || k.startsWith("obj.starops.")
        || k === "admin.tab.aliyun"
        || k === "obj.tag.starops" || k === "obj.tag.starops.hint"
        || k.startsWith("obj.so.")
        || k === "composer.placeholder.starops" || k === "composer.hint.starops");
    const bad: string[] = [];
    for (const [k, v] of scanned) {
      for (const tok of v.en.match(/Aliyun\w*/g) ?? []) {
        if (!ALLOWED_ALIYUN_TOKENS.has(tok)) bad.push(`${k}: ${tok}`);
      }
    }
    expect(bad).toEqual([]);

    // 反向：允许清单里的名字必须真的还被某条文案用着。
    for (const tok of ALLOWED_ALIYUN_TOKENS) {
      expect(scanned.some(([, v]) => v.en.includes(tok)),
        `${tok} 已经没有任何文案在用了，请连这条豁免一起删`).toBe(true);
    }
  });

  /**
   * 抽屉正文（`content/aliyunGuide.ts`）的**两种语言**都要扫 —— 上面那些渲染断言只看得到
   * 一种语言：`AdminPanel` 不裹 Provider，`useContext(LocaleContext)` 拿到的是 i18n.ts 里的
   * 默认值 `zh`；而 `detectLocale()` 默认返回 `"en"`，**客户默认看到的正是没被渲染过的那一份**。
   * 只修 zh 侧的话，en 侧的假策略名可以整条留在现网而全部测试仍然全绿。
   */
  it("两种语言都只提真实存在的官方策略、都写明了 apsara- 前缀这道坎", () => {
    // 抽屉里允许多一个 FullAccess —— 文案是在明确劝客户**不要**挂它（它多带
    // ram:CreateServiceLinkedRole / ram:PassRole，本产品一个都不用）。
    const allowedInGuide = new Set([...ALLOWED_ALIYUN_TOKENS, "AliyunSTAROpsFullAccess"]);
    for (const loc of ["zh", "en"] as const) {
      // JSON.stringify 是为了连 items[] / rows[] 里的字一起扫到（那些不是顶层 tx）。
      const txt = JSON.stringify(ALIYUN_GUIDE[loc]);
      expect(txt, `${loc} 没点名那条官方策略`).toContain("AliyunSTAROpsReadOnlyAccess");
      expect(txt, `${loc} 还在提那条不存在的策略`).not.toMatch(/\bAliyunReadOnlyAccess\b/);
      // 内置员工的资源前缀（逐字，全小写 digitalemployee）与自建员工要自己填的那个 ARN 模板。
      expect(txt, `${loc} 缺内置员工的资源前缀`).toContain("digitalemployee/apsara-");
      expect(txt, `${loc} 缺自建员工的自定义策略处方`).toMatch(/digitalemployee\/</);
      expect(txt, `${loc} 缺自建员工会吃到的错误码`).toContain("NoPermission");
      for (const tok of txt.match(/Aliyun[A-Za-z]*Access/g) ?? []) {
        expect(allowedInGuide.has(tok), `${loc} 出现了不认识的策略名 ${tok}`).toBe(true);
      }
    }
  });

  /**
   * 🔴 2026-09-14：处方必须开出**两条** ARN（员工级 + `/*` 子资源），并且必须点明另外两种
   * 漏法（没真正授权给那个 RAM 用户 / 生效的还是旧版本）。
   *
   * 为什么钉这个：客户照上一版（只有员工级那一条 ARN）配完，`CreateThread` 仍然 403
   * `ImplicitDeny`。官方那条是 `apsara-*`，而阿里云的 `*` 连 `/` 一起吃，所以内置员工顺带
   * 覆盖了子资源、精确 ARN 不会 —— 上一版拿内置员工的 200 当"这个形状够了"的证据，是误证。
   * 缺任何一条，客户就会停在「我明明照做了」而我们这边看不见。
   */
  it("两种语言都开出两条 ARN，并点明授权与生效版本这两个坑", () => {
    for (const loc of ["zh", "en"] as const) {
      const txt = JSON.stringify(ALIYUN_GUIDE[loc]);
      expect(txt, `${loc} 缺 /* 子资源那一条 ARN`).toMatch(/digitalemployee\/<[^>]+>\/\*/);
      // 不许顺手放宽成所有员工 —— 本页自己在劝客户别这么干。
      expect(txt, `${loc} 把 Resource 放宽到了所有员工`).not.toMatch(/digitalemployee\/\*/);
      if (loc === "zh") {
        expect(txt, "zh 没说要真正授权给那个 RAM 用户").toContain("真正授权");
        expect(txt, "zh 没提生效版本这个坑").toContain("当前生效的版本");
      } else {
        expect(txt, "en 没说要真正授权给那个 RAM 用户").toContain("Actually GRANT");
        expect(txt, "en 没提生效版本这个坑").toContain("version IN EFFECT");
      }
    }
  });

  /**
   * 🔴 2026-09-14：处方必须是一段**能整段复制**的策略 JSON，不是让客户从散文里自己拼。
   *
   * 为什么钉这个：上一版把 ARN、Action、两处自查全写在一段话里，客户要自己在脑子里译成
   * 一份 JSON 再粘进 RAM 控制台 —— 这一步每漏一样，报出来的 403 都长得一模一样。
   * 这条测试**真的把那段 JSON parse 一遍**：抽屉里的这段字面量以后被人手改坏（少个逗号、
   * 引号写成中文引号），tsc 完全看不出来，客户粘进去才发现，而那时它已经发到现网了。
   *
   * ⚠️ 地域 / 账号 ID 两位刻意是 `*:*` —— 那是 2026-09-14 实测跑通的形状；收窄成具体值
   * 我们没实测过，所以这里**反向**钉住：不许有人"顺手"把它改成没验证过的那一版。
   */
  it("两种语言都给出一段能直接 parse 的策略 JSON（三个接口全覆盖、两条 ARN 用实测形状）", () => {
    for (const loc of ["zh", "en"] as const) {
      const codes = ALIYUN_GUIDE[loc].filter((b) => b.k === "code");
      expect(codes.length, `${loc} 应当只有那一段策略 JSON`).toBe(1);

      // 占位符（<你的数字员工ID> / <your-employee-id>）换成一个合法员工名再 parse。
      const raw = (codes[0] as { k: "code"; tx: string }).tx.replace(/<[^>]+>/g, "my-emp");
      const doc = JSON.parse(raw) as {
        Version: string;
        Statement: Array<{ Effect: string; Action: string[]; Resource: string | string[] }>;
      };

      expect(doc.Version, `${loc} 策略版本号`).toBe("1");
      expect(doc.Statement.length, `${loc} 应当是读 + 写两段`).toBe(2);

      const write = doc.Statement.find((s) => s.Action.some((a) => a.startsWith("starops:Create")))!;
      expect(write.Effect).toBe("Allow");
      expect(write.Action, `${loc} 写操作那段的 Action`).toEqual([
        "starops:CreateChat",
        "starops:CreateThread",
      ]);
      // 员工级 + 子资源两条，顺序也钉住（客户是照抄的，顺序变了 diff 会难读）。
      expect(write.Resource, `${loc} 两条 ARN 必须是实测跑通的 *:* 形状`).toEqual([
        "acs:starops:*:*:digitalemployee/my-emp",
        "acs:starops:*:*:digitalemployee/my-emp/*",
      ]);

      const read = doc.Statement.find((s) => s !== write)!;
      expect(read.Action, `${loc} 读操作那段的 Action`).toEqual(["starops:Get*", "starops:List*"]);

      // 整条链路只用这三个接口 —— 这一条策略必须**自己就够**（客户可能没挂官方那条）。
      const covered = (api: string) =>
        doc.Statement.some((s) =>
          s.Action.some((a) => a === `starops:${api}`
            || (a.endsWith("*") && api.startsWith(a.slice("starops:".length, -1)))));
      for (const api of ["GetDigitalEmployee", "CreateThread", "CreateChat"]) {
        expect(covered(api), `${loc} 这段策略没覆盖 ${api}`).toBe(true);
      }
    }
  });
});
