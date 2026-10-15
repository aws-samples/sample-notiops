/**
 * 管理 → 模型（2026-10 改版 A：单页 + 抽屉）的界面契约。
 *
 * 钉住的几件事都是「界面骗人 / 把人锁住」那一类，不报错、不掉指标：
 *   · 「当前使用」只标已保存的第一来源；拖上去没保存的标「保存后启用」；保存条只在有改动时出现
 *   · 不再有「先测试才能存」：换到已配置的网关直接能存，门槛在服务端保存时的现场探测
 *   · 保存失败（upstream_auth）三处同时标出，且**任何地方都不说「凭证无效」**；签名一变失败标记消失
 *   · 结构性预检仍在（没配好的来源排第一 / IM 落到没配好的 Key）
 *   · 网关挑选器增删对称；⋯ 常驻；删默认当场挑新默认
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/AdminPanel.models.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within, act } from "@testing-library/react";
import { STRINGS } from "../i18n";
import type { LlmConfig, LlmModelEntry } from "../api/admin";

const BEDROCK: LlmModelEntry = {
  alias: "moonshot-kimi-k3", model_id: "global.moonshotai.kimi-k3", label: "Kimi K3",
  kind: "bedrock_converse", region: null, hard_output_limit: 128000, supports_prompt_cache: false,
  surfaces: ["webchat", "im"], enabled: true,
};
const GROK: LlmModelEntry = { ...BEDROCK, alias: "xai-grok-4-7", model_id: "global.xai.grok-4.7", label: "Grok 4.7" };
const GW: LlmModelEntry = {
  alias: "gw-claude-opus-4-7", model_id: "anthropic/claude-opus-4-7", label: "anthropic/claude-opus-4-7",
  kind: "openai_compatible", region: null, hard_output_limit: 8192, supports_prompt_cache: false,
  surfaces: ["webchat"], enabled: true,
};
const GW2: LlmModelEntry = { ...GW, alias: "gw-claude-sonnet-5-5", model_id: "anthropic/claude-sonnet-5-5", label: "anthropic/claude-sonnet-5-5" };
const GW_ON = { configured: true, base_url: "https://gw.example.com/v1", base_url_valid: true, has_key: true, last_4: "abcd" };

let CFG: LlmConfig;
const baseCfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  provider: "bedrock", credential_mode: "iam", source_order: ["iam", "api_key", "gateway"],
  source_defaults: { iam: BEDROCK.alias }, im_source: "iam",
  default_model: BEDROCK.alias, generation: 1, models: [BEDROCK],
  backend_tasks: {}, bedrock_api_key: { configured: false },
  gateway: { configured: false }, seeded: true, updated_at: "2026-10-13T00:00:00Z", updated_by: "admin", ...over,
});

type PutResult = { message: string; generation: number; warning?: string; sent?: unknown };
const putSpy = vi.fn(async (c: unknown): Promise<PutResult> => ({ message: "ok", generation: 2, sent: c }));
const testSpy = vi.fn(async (b: { model_id: string }) => ({ model_id: b.model_id, result: "ok", credential: "gateway" }));
const listSpy = vi.fn(async () => ({
  result: "ok", total: 5, hidden: [{ id: "*", reason: "wildcard" }],
  models: [{ id: "anthropic/claude-opus-4-7" }, { id: "gpt-4o-mini" }, { id: "Qwen/Qwen3-235B-A22B" }],
}));
const putGwSpy = vi.fn(async (b: unknown) => ({ message: "ok", gateway: CFG.gateway, sent: b }));

vi.mock("../api/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/admin")>();
  return {
    ...actual,
    fetchAllCapabilities: vi.fn(async () => []),
    fetchRoles: vi.fn(async () => []),
    fetchLlmConfig: vi.fn(async () => structuredClone(CFG)),
    fetchBackendTasks: vi.fn(async () => ({ tasks: [], generation: 1 })),
    putLlmConfig: (c: unknown) => putSpy(c),
    testLlmModel: (b: { model_id: string }) => testSpy(b),
    fetchGatewayModels: () => listSpy(),
    putGateway: (b: unknown) => putGwSpy(b),
    fetchLlmCandidates: vi.fn(async () => ({ models: [], source_identity: "iam" })),
  };
});

import AdminPanel from "./AdminPanel";

const zh = (k: string) => STRINGS[k].zh;
const btn = (label: string, root: HTMLElement = document.body) =>
  Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

async function openModels() {
  render(<AdminPanel />);
  fireEvent.click(btn(zh("admin.tab.models")));
  await waitFor(() => expect(screen.getByRole("list", { name: zh("admin.models.sources") })).toBeTruthy());
}
const rows = () => within(screen.getByRole("list", { name: zh("admin.models.sources") })).getAllByRole("listitem");
const bar = () => document.querySelector(".mdl-bar") as HTMLElement | null;
const saveBtn = () => btn(zh("admin.models.save"), bar()!);
const handle = (s: string) => screen.getByLabelText(`${zh(`admin.models.src.${s}`)} · ${zh("admin.models.dragTip")}`);
/** 键盘把某个来源挪到第一。 */
const toTop = (s: string) => {
  for (let i = 0; i < 3; i++) fireEvent.keyDown(handle(s), { key: "ArrowUp" });
};
const modelRow = (label: string) => screen.getByRole("button", { name: label }).closest(".mdl-tr") as HTMLElement;
const srcSelect = (s: string) => screen.getByLabelText(`${zh(`admin.models.src.${s}`)} ${zh("admin.models.default")}`) as HTMLSelectElement;
const openMenu = (label: string) => fireEvent.click(screen.getByRole("button", { name: `${label} ${zh("admin.models.more")}` }));
const menuItem = (label: string) => fireEvent.click(screen.getByRole("menuitem", { name: label }));

beforeEach(() => {
  cleanup();
  putSpy.mockReset(); putSpy.mockImplementation(async (c: unknown): Promise<PutResult> => ({ message: "ok", generation: 2, sent: c }));
  testSpy.mockReset();
  testSpy.mockImplementation(async (b: { model_id: string }) => ({ model_id: b.model_id, result: "ok", credential: "gateway" }));
  listSpy.mockClear(); putGwSpy.mockClear();
  localStorage.clear();
  CFG = baseCfg();
});

describe("管理 → 模型（方案 A）", () => {
  it("首屏：当前生效条、三行来源、「当前使用」在已保存的第一来源，没有保存条", async () => {
    await openModels();
    const strip = screen.getByLabelText(zh("admin.models.strip.live"));
    expect(strip.textContent).toContain(`${zh("admin.models.strip.web")}→${zh("admin.models.src.iam")} · Kimi K3`);
    const r = rows();
    expect(r).toHaveLength(3);
    expect(r[0].textContent).toContain(zh("admin.models.src.iam"));
    expect(r[0].textContent).toContain(zh("admin.models.src.active"));
    expect(r[2].textContent).toContain(zh("admin.models.keyUnset"));
    expect(bar()).toBeNull();
  });

  it("键盘调序：⠿ 上 ↑ 两次 → 网关第一「保存后启用」，保存条出现；放弃后复原", async () => {
    await openModels();
    fireEvent.keyDown(handle("gateway"), { key: "ArrowUp" });
    fireEvent.keyDown(handle("gateway"), { key: "ArrowUp" });
    expect(rows()[0].textContent).toContain(zh("admin.models.src.gateway"));
    expect(rows()[0].textContent).toContain(zh("admin.models.src.pending"));
    expect(rows()[1].textContent).toContain(zh("admin.models.src.active"));
    expect(bar()!.textContent).toContain(zh("admin.models.bar.dirty").replace("{n}", "1"));
    expect(bar()!.textContent).toContain(zh("admin.models.bar.change.order"));
    expect(document.querySelector('[aria-live="polite"]')!.textContent)
      .toBe(zh("admin.models.movedTo").replace("{source}", zh("admin.models.src.gateway")).replace("{n}", "1"));
    fireEvent.click(btn(zh("admin.models.bar.discard"), bar()!));
    expect(bar()).toBeNull();
    expect(rows()[0].textContent).toContain(zh("admin.models.src.iam"));
  });

  it("不再有「先测试才能存」：已配置的网关挪到第一直接能存，发的是 source_order + 各来源默认", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    await openModels();
    toTop("gateway");
    expect(saveBtn().disabled).toBe(false);
    expect(bar()!.textContent).toContain(zh("admin.models.bar.probeGw"));
    fireEvent.click(saveBtn());
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const sent = putSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.source_order).toEqual(["gateway", "iam", "api_key"]);
    expect(sent.credential_mode).toBe("gateway");
    expect(sent.default_model).toBe(GW.alias);
    expect(sent.source_defaults).toMatchObject({ gateway: GW.alias, iam: BEDROCK.alias, api_key: BEDROCK.alias });
    expect(testSpy).not.toHaveBeenCalled();
  });

  it("保存失败 upstream_auth：来源行 / 模型行 / 保存条三处标出，不出现「凭证无效」；改动后失败标记消失；只保存模型改动", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW, GW2], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    const fail = (alias: string, model_id: string) => async () => {
      throw Object.assign(new Error(`default_model ${alias} failed a live check through the gateway (upstream_auth)`),
        { status: 400, probe: { source: "gateway", alias, model_id, result: "upstream_auth" } });
    };
    putSpy.mockImplementationOnce(fail(GW.alias, GW.model_id));
    await openModels();
    toTop("gateway");
    fireEvent.click(saveBtn());
    const label = zh("admin.models.test.upstreamAuth");
    await waitFor(() => expect(bar()!.className).toContain("err"));
    expect(rows()[0].textContent).toContain(label);
    expect(modelRow(GW.label).textContent).toContain(label);
    expect(bar()!.textContent).toContain(label);
    expect(bar()!.textContent).toContain(GW.model_id);
    expect(screen.getByRole("tooltip").textContent).toContain("Anthropic");
    expect(document.body.textContent).not.toContain(zh("admin.models.test.unauthorized"));
    // 改一下网关默认 → 草稿签名变了，失败标记自然消失，回到「未保存」
    fireEvent.change(srcSelect("gateway"), { target: { value: GW2.alias } });
    expect(bar()!.className).not.toContain("err");
    expect(rows()[0].textContent).not.toContain(label);
    // 再失败一次，这次走「只保存模型改动，来源仍以本账号 IAM 第一」
    putSpy.mockImplementationOnce(fail(GW2.alias, GW2.model_id));
    fireEvent.click(saveBtn());
    await waitFor(() => expect(bar()!.className).toContain("err"));
    fireEvent.click(btn(zh("admin.models.bar.keepOrder.iam"), bar()!));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(3));
    const sent = putSpy.mock.calls[2][0] as Record<string, unknown>;
    expect(sent.source_order).toEqual(["iam", "api_key", "gateway"]);
    expect(sent.credential_mode).toBe("iam");
    expect(sent.default_model).toBe(BEDROCK.alias);
  });

  it("瞬时失败照存：服务端回 warning → 保存条变成一行本地化提醒，不是英文原句", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    putSpy.mockImplementationOnce(async () => ({
      message: "LLM config updated", generation: 2,
      warning: `saved, but default_model ${GW.alias} could not be verified through the gateway right now (throttled) — re-run the connectivity test later`,
    }));
    await openModels();
    toTop("gateway");
    fireEvent.click(saveBtn());
    const want = zh("admin.models.savedWarnProbe").replace("{model}", GW.model_id).replace("{result}", zh("admin.models.test.throttled"));
    await waitFor(() => expect(bar()?.textContent).toContain(want));
    expect(bar()!.textContent).not.toContain("could not be verified");
  });

  it("结构性预检仍在：没配好的网关挪到第一 → 保存禁用并说出原因", async () => {
    await openModels();
    toTop("gateway");
    expect(saveBtn().disabled).toBe(true);
    expect(bar()!.textContent).toContain(zh("admin.models.needSourceConfigured").replace("{source}", zh("admin.models.src.gateway")));
  });

  it("结构性预检仍在：网关排第一时 IM 落到没配好的 Key → 保存禁用", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    await openModels();
    toTop("gateway");                                   // gateway, iam, api_key
    fireEvent.keyDown(handle("api_key"), { key: "ArrowUp" }); // gateway, api_key, iam
    expect(saveBtn().disabled).toBe(true);
    expect(bar()!.textContent).toContain(zh("admin.models.needImSourceConfigured").replace("{source}", zh("admin.models.src.api_key")));
  });

  it("网关挑选器增删对称：勾上 = 加、取消 = 移出；「取消」不改目录", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    await openModels();
    const openPicker = () => {
      fireEvent.click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes(zh("admin.models.addModel")))!);
      fireEvent.click(screen.getByRole("menuitem", { name: zh("admin.models.add.fromGateway") }));
    };
    openPicker();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    const dlg = await screen.findByRole("dialog", { name: zh("admin.models.gw.pickerTitle") });
    await waitFor(() => expect(within(dlg).getByText("gpt-4o-mini")).toBeTruthy());
    fireEvent.click(within(dlg).getByText("gpt-4o-mini").closest("label")!.querySelector("input")!);
    fireEvent.click(within(dlg).getByText(GW.model_id).closest("label")!.querySelector("input")!);
    fireEvent.click(btn(zh("admin.models.done"), dlg));
    const row = modelRow("gpt-4o-mini");
    const web = within(row).getByLabelText(`gpt-4o-mini ${zh("admin.models.surface.webchat")}`) as HTMLInputElement;
    expect(web.checked && web.disabled).toBe(true);
    expect(within(row).getByTitle(zh("admin.models.gw.noIm")).textContent).toBe("—");
    expect(screen.queryByRole("button", { name: GW.label })).toBeNull();
    expect(srcSelect("gateway").value).toBe("gw-gpt-4o-mini");
    // 「取消」丢弃本次勾选
    openPicker();
    const dlg2 = await screen.findByRole("dialog", { name: zh("admin.models.gw.pickerTitle") });
    fireEvent.click(within(dlg2).getByText("gpt-4o-mini").closest("label")!.querySelector("input")!);
    fireEvent.click(btn(zh("admin.models.cancel"), dlg2));
    expect(screen.getByRole("button", { name: "gpt-4o-mini" })).toBeTruthy();
  });

  it("⋯ 常驻；删非默认直接删；删网关默认先挑新默认", async () => {
    CFG = baseCfg({ models: [BEDROCK, GROK, GW, GW2], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    await openModels();
    for (const m of [BEDROCK, GROK, GW, GW2]) {
      expect(screen.getByRole("button", { name: `${m.label} ${zh("admin.models.more")}` })).toBeTruthy();
    }
    openMenu(GROK.label);
    menuItem(zh("admin.models.menu.delete"));
    expect(screen.queryByRole("button", { name: GROK.label })).toBeNull();
    openMenu(GW.label);
    menuItem(zh("admin.models.menu.delete"));
    const pop = screen.getByRole("dialog", { name: zh("admin.models.del.title").replace("{name}", GW.label) });
    expect(pop.textContent).toContain(zh("admin.models.del.isDefault").replace("{sources}", zh("admin.models.src.gateway")));
    expect((within(pop).getByRole("combobox") as HTMLSelectElement).value).toBe(GW2.alias);
    fireEvent.click(btn(zh("admin.models.menu.delete"), pop));
    expect(screen.queryByRole("button", { name: GW.label })).toBeNull();
    expect(srcSelect("gateway").value).toBe(GW2.alias);
  });

  it("模型详情抽屉：model_id / 路由范围 / 输出上限在这里；改上限出现保存条；测试带上 Bedrock 来源", async () => {
    await openModels();
    fireEvent.click(screen.getByRole("button", { name: BEDROCK.label }));
    const d = screen.getByRole("dialog", { name: BEDROCK.label });
    expect(d.textContent).toContain(BEDROCK.model_id);
    expect(d.textContent).toContain(zh("admin.models.routing.global"));
    fireEvent.change(within(d).getByLabelText(zh("admin.models.cap")), { target: { value: "64000" } });
    expect(bar()!.textContent).toContain(zh("admin.models.bar.dirty").replace("{n}", "1"));
    fireEvent.click(btn(zh("admin.models.testBtn"), d));
    await waitFor(() => expect(testSpy).toHaveBeenCalled());
    expect(testSpy.mock.calls[0][0]).toMatchObject({ model_id: BEDROCK.model_id, source: "iam" });
    fireEvent.click(btn(zh("admin.models.done"), d));
    expect(screen.queryByRole("dialog", { name: BEDROCK.label })).toBeNull();
  });

  it("网关设置抽屉：保存并验证不冲掉页面上未保存的次序", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias } });
    await openModels();
    toTop("gateway");
    fireEvent.click(screen.getByLabelText(`${zh("admin.models.src.gateway")} ${zh("admin.models.src.settings")}`));
    const d = screen.getByRole("dialog", { name: zh("admin.models.src.gateway") });
    fireEvent.change(within(d).getByLabelText(zh("admin.models.gw.url")), { target: { value: "https://gw.example.com/v1" } });
    fireEvent.change(within(d).getByLabelText(zh("admin.models.gw.key")), { target: { value: `sk-${"abcd".repeat(4)}` } });
    CFG = { ...CFG, gateway: GW_ON };
    fireEvent.click(btn(zh("admin.models.gw.save"), d));
    await waitFor(() => expect(putGwSpy).toHaveBeenCalled());
    expect(putGwSpy.mock.calls[0][0]).toMatchObject({ base_url: "https://gw.example.com/v1" });
    await waitFor(() => expect(rows()[0].textContent).toContain("gw.example.com"));
    expect(rows()[0].textContent).toContain(zh("admin.models.src.gateway"));
  });

  it("网关在用时「清除地址与 Key」禁用", async () => {
    CFG = baseCfg({
      credential_mode: "gateway", source_order: ["gateway", "iam", "api_key"], default_model: GW.alias,
      models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON,
    });
    await openModels();
    fireEvent.click(screen.getByLabelText(`${zh("admin.models.src.gateway")} ${zh("admin.models.src.settings")}`));
    const d = screen.getByRole("dialog", { name: zh("admin.models.src.gateway") });
    expect(btn(zh("admin.models.gw.clear"), d).disabled).toBe(true);
    expect(d.textContent).toContain(zh("admin.models.gw.clearInUse"));
  });

  it("Key 抽屉：测试默认模型带 source=api_key；没配 Key 时禁用", async () => {
    CFG = baseCfg({ bedrock_api_key: { configured: true, last_4: "wxyz" } });
    testSpy.mockImplementationOnce(async (b) => ({ model_id: b.model_id, result: "ok", credential: "api_key" }));
    await openModels();
    fireEvent.click(screen.getByLabelText(`${zh("admin.models.src.api_key")} ${zh("admin.models.src.settings")}`));
    let d = screen.getByRole("dialog", { name: zh("admin.models.src.api_key") });
    fireEvent.click(btn(zh("admin.models.gw.testDefault"), d));
    await waitFor(() => expect(testSpy).toHaveBeenCalled());
    expect(testSpy.mock.calls[0][0]).toMatchObject({ model_id: BEDROCK.model_id, source: "api_key" });
    cleanup();
    CFG = baseCfg();
    await openModels();
    fireEvent.click(screen.getByLabelText(`${zh("admin.models.src.api_key")} ${zh("admin.models.src.settings")}`));
    d = screen.getByRole("dialog", { name: zh("admin.models.src.api_key") });
    expect(btn(zh("admin.models.gw.testDefault"), d).disabled).toBe(true);
  });

  it("后台任务：网关挪到第一 → PHD 行说出保存后实际用网关默认", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    await openModels();
    const phd = () => screen.getByLabelText(zh("admin.models.task.phd_translate")).closest(".mdl-tr") as HTMLElement;
    expect(phd().textContent).not.toContain(zh("admin.models.task.usesAfterSave").split("{model}")[0].trim());
    toTop("gateway");
    expect(phd().textContent).toContain(`${zh("admin.models.task.usesAfterSave").replace("{model}", GW.model_id)}`);
  });

  it("保存失败后能「重试保存」：同一份草稿原样再发一次，成功后失败态消失", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    putSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error(`default_model ${GW.alias} failed a live check through the gateway (upstream_auth)`),
        { status: 400, probe: { source: "gateway", alias: GW.alias, model_id: GW.model_id, result: "upstream_auth" } });
    });
    await openModels();
    toTop("gateway");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(bar()!.className).toContain("err"));
    // 管理员去网关补好了上游凭证，回来点「重试保存」
    fireEvent.click(btn(zh("admin.models.bar.retry"), bar()!));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(2));
    expect(putSpy.mock.calls[1][0]).toEqual(putSpy.mock.calls[0][0]);
    await waitFor(() => expect(bar()?.className || "").not.toContain("err"));
  });

  it("没有 probe 的失败（5xx / 网络）也能重试；网关抽屉里重存网关后失败态让位给「保存」", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    putSpy.mockImplementationOnce(async () => { throw Object.assign(new Error("http_502"), { status: 502 }); });
    await openModels();
    toTop("gateway");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(bar()!.className).toContain("err"));
    expect(btn(zh("admin.models.bar.retry"), bar()!)).toBeTruthy();
    // 在网关抽屉里重存一次（只改 Key）→ 失败态让位，保存条回到「保存」
    fireEvent.click(screen.getByLabelText(`${zh("admin.models.src.gateway")} ${zh("admin.models.src.settings")}`));
    const d = screen.getByRole("dialog", { name: zh("admin.models.src.gateway") });
    fireEvent.change(within(d).getByLabelText(zh("admin.models.gw.key")), { target: { value: `sk-${"abcd".repeat(4)}` } });
    fireEvent.click(btn(zh("admin.models.gw.save"), d));
    await waitFor(() => expect(putGwSpy).toHaveBeenCalled());
    await waitFor(() => expect(bar()!.className).not.toContain("err"));
    expect(saveBtn().disabled).toBe(false);
  });

  it("失败态「换默认模型」：抽屉关掉，焦点落到那个来源的默认模型下拉", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW, GW2], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    putSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error("x"), { status: 400, probe: { source: "gateway", alias: GW.alias, model_id: GW.model_id, result: "upstream_auth" } });
    });
    await openModels();
    toTop("gateway");
    fireEvent.click(screen.getByLabelText(`${zh("admin.models.src.gateway")} ${zh("admin.models.src.settings")}`));
    expect(screen.getByRole("dialog", { name: zh("admin.models.src.gateway") })).toBeTruthy();
    fireEvent.click(saveBtn());
    await waitFor(() => expect(bar()!.className).toContain("err"));
    fireEvent.click(btn(zh("admin.models.bar.changeDefault"), bar()!));
    expect(screen.queryByRole("dialog", { name: zh("admin.models.src.gateway") })).toBeNull();
    await waitFor(() => expect(document.activeElement?.id).toBe("src-default-gateway"));
  });

  it("未启用的模型折叠成一行：计数、展开排在折叠行下面、收起；搜索或切到「未启用」时不折叠", async () => {
    const OFF1 = { ...GROK, enabled: false };
    const OFF2 = { ...BEDROCK, alias: "glm-5-3", model_id: "global.zai.glm-5.3", label: "GLM 5.3", enabled: false };
    CFG = baseCfg({ models: [BEDROCK, OFF1, OFF2] });
    await openModels();
    const fold = () => screen.queryByRole("button", { name: new RegExp(zh("admin.models.foldDisabled").replace("{n}", "2")) });
    expect(fold()).toBeTruthy();
    expect(fold()!.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: OFF1.label })).toBeNull();
    fireEvent.click(fold()!);
    expect(fold()!.getAttribute("aria-expanded")).toBe("true");
    const r1 = modelRow(OFF1.label), r2 = modelRow(OFF2.label);
    // 展开后排在折叠行**下面**，不和在用的混排
    expect(fold()!.compareDocumentPosition(r1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fold()!.compareDocumentPosition(r2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(modelRow(BEDROCK.label).compareDocumentPosition(fold()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(fold()!);
    expect(screen.queryByRole("button", { name: OFF1.label })).toBeNull();
    // 搜索时不折叠：命中的未启用行直接出现
    fireEvent.change(screen.getByLabelText(zh("admin.models.searchModels")), { target: { value: "grok" } });
    expect(fold()).toBeNull();
    expect(screen.getByRole("button", { name: OFF1.label })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(zh("admin.models.searchModels")), { target: { value: "" } });
    // 分段「未启用」：两行都直接列出，没有折叠行
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${zh("admin.models.seg.disabled")}`) }));
    expect(fold()).toBeNull();
    expect(screen.getByRole("button", { name: OFF1.label })).toBeTruthy();
    expect(screen.getByRole("button", { name: OFF2.label })).toBeTruthy();
    expect(screen.queryByRole("button", { name: BEDROCK.label })).toBeNull();
  });

  it("挑选器是模态：打开时焦点在搜索框（autoFocus 不被标题抢走），Tab / Shift+Tab 在框内环绕；关闭后焦点回「+ 添加模型」", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    await openModels();
    const add = document.getElementById("mdl-add-btn") as HTMLButtonElement;
    fireEvent.click(add);
    const first = screen.getByRole("menuitem", { name: zh("admin.models.add.fromBedrock") });
    expect(document.activeElement).toBe(first);
    fireEvent.click(screen.getByRole("menuitem", { name: zh("admin.models.add.fromGateway") }));
    const dlg = await screen.findByRole("dialog", { name: zh("admin.models.gw.pickerTitle") });
    expect(document.activeElement).toBe(within(dlg).getByLabelText(zh("admin.models.gw.searchPh")));
    const done = btn(zh("admin.models.done"), dlg);
    const close = within(dlg).getByLabelText(zh("admin.models.close"));
    done.focus();
    fireEvent.keyDown(done, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(done);
    fireEvent.click(btn(zh("admin.models.cancel"), dlg));
    expect(screen.queryByRole("dialog", { name: zh("admin.models.gw.pickerTitle") })).toBeNull();
    expect(document.activeElement).toBe(add);
  });

  it("从网关抽屉「管理网关模型」打开的挑选器，关闭后焦点回到那个按钮（抽屉还开着）", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    await openModels();
    fireEvent.click(screen.getByLabelText(`${zh("admin.models.src.gateway")} ${zh("admin.models.src.settings")}`));
    const d = screen.getByRole("dialog", { name: zh("admin.models.src.gateway") });
    fireEvent.click(btn(zh("admin.models.gw.manage"), d));
    const dlg = await screen.findByRole("dialog", { name: zh("admin.models.gw.pickerTitle") });
    // Esc 只关最上层：挑选器关掉，抽屉还在
    fireEvent.keyDown(document.activeElement || document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: zh("admin.models.gw.pickerTitle") })).toBeNull();
    expect(dlg.isConnected).toBe(false);
    expect(screen.getByRole("dialog", { name: zh("admin.models.src.gateway") })).toBeTruthy();
    expect(document.activeElement?.id).toBe("mdl-gw-manage");
  });

  it("⋯ 菜单：动作后焦点回到该行 ⋯；「详情…」打开的抽屉关闭后也回到 ⋯；删除浮层取消 / Esc 回到 ⋯；删掉一行落到相邻行", async () => {
    CFG = baseCfg({ models: [BEDROCK, GROK, GW, GW2], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    await openModels();
    const more = (label: string) => screen.getByRole("button", { name: `${label} ${zh("admin.models.more")}` });
    openMenu(GROK.label);
    menuItem(zh("admin.models.testBtn"));
    expect(document.activeElement).toBe(more(GROK.label));
    await waitFor(() => expect(testSpy).toHaveBeenCalled());
    // 详情… → 抽屉 → 完成 → 回到 ⋯
    openMenu(GROK.label);
    menuItem(zh("admin.models.menu.details"));
    const d = screen.getByRole("dialog", { name: GROK.label });
    fireEvent.click(btn(zh("admin.models.done"), d));
    expect(document.activeElement).toBe(more(GROK.label));
    // 删的是网关默认 → 浮层；取消 → 回到 ⋯
    openMenu(GW.label);
    menuItem(zh("admin.models.menu.delete"));
    const popName = zh("admin.models.del.title").replace("{name}", GW.label);
    fireEvent.click(btn(zh("admin.models.cancel"), screen.getByRole("dialog", { name: popName })));
    expect(screen.queryByRole("dialog", { name: popName })).toBeNull();
    expect(document.activeElement).toBe(more(GW.label));
    // 再开一次，Esc → 同样回到 ⋯
    openMenu(GW.label);
    menuItem(zh("admin.models.menu.delete"));
    fireEvent.keyDown(document.activeElement || document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: popName })).toBeNull();
    expect(document.activeElement).toBe(more(GW.label));
    // 删一行非默认 → 焦点落到相邻行的 ⋯（不掉回 body）
    openMenu(GROK.label);
    menuItem(zh("admin.models.menu.delete"));
    expect(screen.queryByRole("button", { name: GROK.label })).toBeNull();
    await waitFor(() => expect(document.activeElement?.classList.contains("mdl-more")).toBe(true));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("「+ 添加模型」菜单：Esc 只关菜单，不连带关掉开着的抽屉；焦点回到按钮", async () => {
    await openModels();
    fireEvent.click(screen.getByRole("button", { name: BEDROCK.label }));
    expect(screen.getByRole("dialog", { name: BEDROCK.label })).toBeTruthy();
    const add = document.getElementById("mdl-add-btn") as HTMLButtonElement;
    fireEvent.click(add);
    expect(screen.getByRole("menu", { name: zh("admin.models.addModel") })).toBeTruthy();
    fireEvent.keyDown(document.activeElement || document.body, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: zh("admin.models.addModel") })).toBeNull();
    expect(screen.getByRole("dialog", { name: BEDROCK.label })).toBeTruthy();
    expect(document.activeElement).toBe(add);
  });

  it("ⓘ 悬停弹出的提示不持焦点也能用 Esc 关掉", async () => {
    await openModels();
    const info = screen.getByLabelText(zh("admin.models.sources"), { selector: "button" });
    fireEvent.mouseEnter(info.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toContain(zh("admin.models.sourcesSub"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("全部测试后状态列不逐行挂「可用」，按钮旁给汇总；单测的那一行才显示「可用」", async () => {
    CFG = baseCfg({ models: [BEDROCK, GROK] });
    testSpy.mockImplementation(async (b: { model_id: string }) =>
      ({ model_id: b.model_id, result: b.model_id === GROK.model_id ? "throttled" : "ok", credential: "iam" }));
    await openModels();
    fireEvent.click(btn(zh("admin.models.testAll")));
    await waitFor(() => expect(testSpy).toHaveBeenCalledTimes(2));
    const okLabel = zh("admin.models.test.ok");
    await waitFor(() => expect(document.querySelector(".mdl-tsum")?.textContent)
      .toBe(`${zh("admin.models.sum.ok").replace("{n}", "1")} · ${zh("admin.models.sum.bad").replace("{n}", "1")}`));
    expect(within(modelRow(BEDROCK.label)).queryByText(okLabel)).toBeNull();
    expect(within(modelRow(GROK.label)).getByText(zh("admin.models.test.throttled"))).toBeTruthy();
    openMenu(BEDROCK.label);
    menuItem(zh("admin.models.testBtn"));
    await waitFor(() => expect(within(modelRow(BEDROCK.label)).getByText(okLabel)).toBeTruthy());
  });

  it("探测本身出错（probe error）形态的提醒也本地化，不显示英文原句", async () => {
    CFG = baseCfg({ models: [BEDROCK, GROK] });
    putSpy.mockImplementationOnce(async () => ({
      message: "LLM config updated", generation: 2, warning: `saved, but could not verify default_model ${BEDROCK.alias} (probe error)`,
    }));
    await openModels();
    fireEvent.click(within(modelRow(GROK.label)).getByRole("switch"));
    fireEvent.click(saveBtn());
    const want = zh("admin.models.savedWarnProbe").replace("{model}", BEDROCK.label).replace("{result}", zh("admin.models.test.error"));
    await waitFor(() => expect(bar()?.textContent).toContain(want));
    expect(bar()!.textContent).not.toContain("could not verify");
  });

  it("保存请求在路上时草稿锁住：开关 / 勾选 / 把手 / 下拉 / 抽屉输入都禁用，保存条说「保存中」；被拒后失败原因照常显示（L1）", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    let reject: (e: unknown) => void = () => {};
    putSpy.mockImplementationOnce(() => new Promise<PutResult>((_, rj) => { reject = rj; }));
    await openModels();
    toTop("gateway");
    fireEvent.click(screen.getByRole("button", { name: BEDROCK.label }));
    const d = screen.getByRole("dialog", { name: BEDROCK.label });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    expect(bar()!.textContent).toContain(zh("admin.models.bar.savingLocked"));
    const sw = within(modelRow(BEDROCK.label)).getByRole("switch") as HTMLButtonElement;
    const web = within(modelRow(BEDROCK.label)).getByLabelText(`${BEDROCK.label} ${zh("admin.models.surface.webchat")}`) as HTMLInputElement;
    const cap = within(d).getByLabelText(zh("admin.models.cap")) as HTMLInputElement;
    expect([sw.disabled, web.disabled, (handle("iam") as HTMLButtonElement).disabled, srcSelect("gateway").disabled, cap.disabled,
      (document.getElementById("mdl-add-btn") as HTMLButtonElement).disabled]).toEqual([true, true, true, true, true, true]);
    // 旁路（键盘事件、程序化 change）也改不动草稿
    fireEvent.keyDown(handle("iam"), { key: "ArrowUp" });
    fireEvent.change(cap, { target: { value: "1" } });
    expect(rows()[0].textContent).toContain(zh("admin.models.src.gateway"));
    expect(cap.value).toBe(String(BEDROCK.hard_output_limit));
    // ⋯ 菜单里改草稿的项 aria-disabled，并说出原因
    openMenu(BEDROCK.label);
    const del = screen.getByRole("menuitem", { name: zh("admin.models.menu.delete") });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(del.getAttribute("aria-describedby")!)!.textContent).toBe(zh("admin.models.bar.savingLocked"));
    fireEvent.click(del);
    expect(screen.getByRole("button", { name: BEDROCK.label })).toBeTruthy();
    fireEvent.keyDown(document.activeElement || document.body, { key: "Escape" });
    // 服务端拒了：失败态出来（签名没变，原因不会被吞），控件恢复
    await act(async () => {
      reject(Object.assign(new Error("x"), { status: 400, probe: { source: "gateway", alias: GW.alias, model_id: GW.model_id, result: "upstream_auth" } }));
    });
    await waitFor(() => expect(bar()!.className).toContain("err"));
    expect(bar()!.textContent).toContain(zh("admin.models.test.upstreamAuth"));
    expect(sw.disabled).toBe(false);
    expect(srcSelect("gateway").disabled).toBe(false);
  });

  it("「只保存模型改动」先按已保存的次序跑结构性预检：不成立就禁用并说出原因，不发请求（L2）", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    putSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error("x"), { status: 400, probe: { source: "gateway", alias: GW.alias, model_id: GW.model_id, result: "upstream_auth" } });
    });
    await openModels();
    toTop("gateway");
    // 网关排第一时 Web 由网关模型满足，取消 Bedrock 条目的 Web 仍然成立；换回 IAM 第一就不成立了
    fireEvent.click(within(modelRow(BEDROCK.label)).getByLabelText(`${BEDROCK.label} ${zh("admin.models.surface.webchat")}`));
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(saveBtn());
    await waitFor(() => expect(bar()!.className).toContain("err"));
    const why = zh("admin.models.needSurface").replace("{surface}", zh("admin.models.surface.webchat"));
    const keep = btn(zh("admin.models.bar.keepOrder.iam"), bar()!);
    expect(keep.disabled).toBe(true);
    expect(keep.title).toContain(why);
    expect(bar()!.textContent).toContain(why);
    fireEvent.click(keep);
    expect(putSpy).toHaveBeenCalledTimes(1);
    // 其余出路照旧可用
    expect(btn(zh("admin.models.bar.retry"), bar()!).disabled).toBe(false);
    expect(btn(zh("admin.models.bar.changeDefault"), bar()!).disabled).toBe(false);
  });

  it("禁用的菜单项仍可用方向键走到，原因作为可见的第二行读出来；点了不执行（S3）", async () => {
    CFG = baseCfg({ models: [BEDROCK, { ...GROK, enabled: false }] });
    await openModels();
    const add = document.getElementById("mdl-add-btn") as HTMLButtonElement;
    fireEvent.click(add);
    const first = screen.getByRole("menuitem", { name: zh("admin.models.add.fromBedrock") });
    const gwItem = screen.getByRole("menuitem", { name: zh("admin.models.add.fromGateway") });
    expect(document.activeElement).toBe(first);
    expect(gwItem.getAttribute("aria-disabled")).toBe("true");
    expect(gwItem.hasAttribute("disabled")).toBe(false);
    const hint = document.getElementById(gwItem.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe(zh("admin.models.add.gwNotConfigured"));
    expect(gwItem.contains(hint)).toBe(true);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(gwItem);
    fireEvent.click(gwItem);
    expect(screen.queryByRole("dialog", { name: zh("admin.models.gw.pickerTitle") })).toBeNull();
    expect(listSpy).not.toHaveBeenCalled();
    fireEvent.keyDown(gwItem, { key: "Escape" });
    // ⋯ 菜单：未启用的模型「设为 IAM 默认」同样可聚焦、说出原因
    fireEvent.click(screen.getByRole("button", { name: new RegExp(zh("admin.models.foldDisabled").replace("{n}", "1")) }));
    openMenu(GROK.label);
    const setDef = screen.getByRole("menuitem", { name: zh("admin.models.menu.setDefault.iam") });
    expect(setDef.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(setDef.getAttribute("aria-describedby")!)!.textContent).toBe(zh("admin.models.menu.needEnabled"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(setDef);
    fireEvent.click(setDef);
    expect(srcSelect("iam").value).toBe(BEDROCK.alias);
  });

  it("挑选器手填报错会播报：role=alert，输入框 aria-invalid + aria-describedby（S4）", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    await openModels();
    const openAdd = (item: string) => {
      fireEvent.click(document.getElementById("mdl-add-btn")!);
      fireEvent.click(screen.getByRole("menuitem", { name: zh(item) }));
    };
    openAdd("admin.models.add.fromGateway");
    let dlg = await screen.findByRole("dialog", { name: zh("admin.models.gw.pickerTitle") });
    const gwIn = within(dlg).getByLabelText(zh("admin.models.gw.manualLabel")) as HTMLInputElement;
    expect(gwIn.getAttribute("aria-invalid")).toBeNull();
    fireEvent.change(gwIn, { target: { value: "bad id" } });
    fireEvent.keyDown(gwIn, { key: "Enter" });
    let alert = within(dlg).getByRole("alert");
    expect(alert.textContent).toBe(zh("admin.models.gw.badId"));
    expect(gwIn.getAttribute("aria-invalid")).toBe("true");
    expect(gwIn.getAttribute("aria-describedby")).toBe(alert.id);
    fireEvent.change(gwIn, { target: { value: "anthropic/x" } });
    expect(within(dlg).queryByRole("alert")).toBeNull();
    expect(gwIn.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(btn(zh("admin.models.cancel"), dlg));
    openAdd("admin.models.add.fromBedrock");
    dlg = await screen.findByRole("dialog", { name: zh("admin.models.bedrockPicker.title") });
    const brIn = within(dlg).getByLabelText(zh("admin.models.orManual")) as HTMLInputElement;
    fireEvent.change(brIn, { target: { value: "anthropic/claude-haiku-9" } });
    fireEvent.click(btn(zh("admin.models.add"), dlg));
    alert = within(dlg).getByRole("alert");
    expect(alert.textContent).toBe(zh("admin.models.manualLooksGateway"));
    expect(brIn.getAttribute("aria-invalid")).toBe("true");
    expect(brIn.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("单模型测试 upstream_auth → 状态列「网关上游未授权」，不是「凭证无效」", async () => {
    CFG = baseCfg({ models: [BEDROCK, GW], source_defaults: { iam: BEDROCK.alias, gateway: GW.alias }, gateway: GW_ON });
    testSpy.mockImplementationOnce(async (b) => ({ model_id: b.model_id, result: "upstream_auth", credential: "gateway" }));
    await openModels();
    openMenu(GW.label);
    menuItem(zh("admin.models.testBtn"));
    await waitFor(() => expect(modelRow(GW.label).textContent).toContain(zh("admin.models.test.upstreamAuth")));
    expect(document.body.textContent).not.toContain(zh("admin.models.test.unauthorized"));
  });
});
