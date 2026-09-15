/**
 * 会话「谁来答这一轮」记忆的契约（convMode.ts）。
 *
 * 为什么值得钉：这个模块修的 bug 是**静默**的 —— 客户在调查会话里选了「DevOps 对话」、
 * 发过问、刷新一下选择就没了，然后接着追问会由 NotiOps 而不是他自己的 DevOps Agent 来答，
 * 界面上没有任何提示。修坏了同样静默（记错模式 = 把问题送上另一条链路），
 * 所以每一条口径都要有断言。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/convMode.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";

import { loadConvMode, saveConvMode, forgetConvMode, modeOf, fieldsOf, restorableMode } from "./convMode";

const KEY = "notiops.convMode";
const raw = () => JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, string>;

beforeEach(() => localStorage.clear());

describe("落盘与读回", () => {
  it("存了就读得回来（这就是要修的那个刷新丢选择）", () => {
    saveConvMode("c1", "chat");
    expect(loadConvMode("c1")).toBe("chat");
  });

  it("没记过的会话 → off（默认关，不替客户开深度调查）", () => {
    expect(loadConvMode("never-seen")).toBe("off");
    expect(loadConvMode("")).toBe("off");
  });

  it("off 不落盘 —— 否则每建一个空会话都写一条，表很快被无意义记录填满", () => {
    saveConvMode("c1", "off");
    expect(raw()).toEqual({});
    saveConvMode("c1", "agent");
    saveConvMode("c1", "off");   // 关掉 → 这一条被删掉，不是留一个 "off"
    expect(raw()).toEqual({});
  });

  it("forgetConvMode 清掉某会话（会话被删时用，避免留孤儿条目）", () => {
    saveConvMode("c1", "direct");
    saveConvMode("c2", "chat");
    forgetConvMode("c1");
    expect(loadConvMode("c1")).toBe("off");
    expect(loadConvMode("c2")).toBe("chat");
  });

  it("坏数据一律当没记过：JSON 损坏 / 值不是已知模式 —— 绝不能让聊天页崩", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadConvMode("c1")).toBe("off");
    localStorage.setItem(KEY, JSON.stringify({ c1: "turbo", c2: 42, c3: "chat" }));
    expect(loadConvMode("c1")).toBe("off");
    expect(loadConvMode("c2")).toBe("off");
    expect(loadConvMode("c3")).toBe("chat");   // 好的那一条照旧生效
  });

  it("上限 200：超了丢最久没动过的，且被动过的那条不会被误丢", () => {
    for (let i = 0; i < 200; i++) saveConvMode(`c${i}`, "chat");
    saveConvMode("c0", "agent");        // 重新动一下最老的那条 → 它挪到末尾
    saveConvMode("c200", "direct");     // 第 201 条 → 淘汰一条
    expect(Object.keys(raw()).length).toBe(200);
    expect(loadConvMode("c0")).toBe("agent");   // 刚动过的还在
    expect(loadConvMode("c200")).toBe("direct");
    expect(loadConvMode("c1")).toBe("off");     // 现在最老的那条被丢了
  });
});

describe("四个布尔 ↔ 枚举", () => {
  it("modeOf：devopsChat 优先于 devopsAgentDirect", () => {
    // 通用会话里两者会同时为真（「深度调查」是这一轮的修饰，对话对象仍是客户自己的
    // DevOps Agent）。按 direct 记就把整段对话的"对象"降级成一次性开关，刷新后对象丢了。
    expect(modeOf({ devopsChat: true, devopsAgentDirect: true })).toBe("chat");
    expect(modeOf({ devopsChat: true })).toBe("chat");
    expect(modeOf({ devopsAgent: true })).toBe("agent");
    expect(modeOf({ devopsAgentDirect: true })).toBe("direct");
    expect(modeOf({})).toBe("off");
  });

  it("modeOf：starops 排在最前，与 BFF 的一选一同序", () => {
    // 万一某条写入路径漏了互斥，让 starops 与某个 DevOps 字段同时为真：前端记下的
    // 对象必须与后端实际答话的对象是同一个（index.mjs 的 STAROps 分支也排最前）。
    // 反了的症状是自相矛盾的会话 —— 落款是阿里云，刷新后对象锁成 AWS DevOps Agent。
    expect(modeOf({ starops: true })).toBe("starops");
    expect(modeOf({ starops: true, devopsChat: true })).toBe("starops");
    expect(modeOf({ starops: true, devopsAgent: true, devopsAgentDirect: true })).toBe("starops");
  });

  it("fieldsOf 恒定互斥：任何模式下至多一个字段为真", () => {
    for (const m of ["agent", "direct", "chat", "starops", "off"] as const) {
      const f = fieldsOf(m);
      expect([f.devopsAgent, f.devopsAgentDirect, f.devopsChat, f.starops].filter(Boolean).length)
        .toBe(m === "off" ? 0 : 1);
    }
    // 逐键写全（而不是只数真值个数）：加字段时这一条会挂，提醒把新字段接进
    // ChatApp 的 setDevopsMode / modeOf / VALID 三处 —— 漏接是静默的。
    expect(fieldsOf("chat")).toEqual({ devopsAgent: false, devopsAgentDirect: false, devopsChat: true, starops: false });
    expect(fieldsOf("starops")).toEqual({ devopsAgent: false, devopsAgentDirect: false, devopsChat: false, starops: true });
  });

  it("往返：modeOf(fieldsOf(m)) === m", () => {
    for (const m of ["agent", "direct", "chat", "starops", "off"] as const) {
      expect(modeOf(fieldsOf(m))).toBe(m);
    }
  });

  it("starops 真的落盘读得回来 —— 漏加进 VALID 会静默丢掉它", () => {
    // convMode.ts 的 VALID 是白名单：新模式漏加不报错，readAll 会把它当"老版本
    // 写进去的脏值"丢掉，症状是**只有这一个模式**记不住，其余全正常，极难往这儿找。
    saveConvMode("c1", "starops");
    expect(loadConvMode("c1")).toBe("starops");
    expect(raw()).toEqual({ c1: "starops" });
  });
});

describe("恢复前的主题闸门", () => {
  it("「DevOps 对话」只在提供它的主题恢复（当前只有故障调查）", () => {
    expect(restorableMode("investigate", "chat")).toBe("chat");
    // general 刻意不提供这个开关（那里用主页的「对话对象」卡片选）——
    // 恢复回来客户既看不到也关不掉，但它真的会改变下一轮走哪条链路。
    expect(restorableMode("general", "chat")).toBe("off");
    expect(restorableMode("cost", "chat")).toBe("off");
  });

  it("「深度调查」（直连）按 topicHasDevopsAgent 的口径（general/cases/whats-new 除外）", () => {
    expect(restorableMode("investigate", "direct")).toBe("direct");
    expect(restorableMode("cost", "direct")).toBe("direct");
    for (const bad of ["general", "cases", "whats-new"]) {
      expect(restorableMode(bad, "direct")).toBe("off");
    }
  });

  it("`agent`（经我们的模型转交那条）一律 off —— 2026-09-13 起它在界面上没有入口", () => {
    // 🔴 这一条钉的是**入口下线**这件事本身，不是主题口径。字段与 BFF 那条链路都还活着，
    //    所以"恢复"技术上是能成的 —— 恰恰因此必须在这里挡：2026-09-13 之前落过盘的会话
    //    （localStorage 里写着 "agent"）一旦恢复，客户会拿到一个看不见、关不掉、却真的
    //    会改变下一轮走哪条链路（先烧 token 让我们的模型转交一次）的模式。
    //    连主题还提供深度调查的 investigate / cost 也一样 off —— 那里显示的那枚
    //    「深度调查」绑的是 devopsAgentDirect，管不到这个字段。
    for (const topic of ["investigate", "cost", "finops", "general", "cases", "whats-new", undefined]) {
      expect(restorableMode(topic, "agent"), String(topic)).toBe("off");
    }
    // 把入口加回来时，改 convMode.ts 里那一行的同时把这条测试换回主题口径。
  });

  it("starops 一律 off —— 2026-09-15 起多云入口不对外（`MULTICLOUD_UI` 关着）", () => {
    // 🔴 与上面 `agent` 那条同一个形态，只是这次挡的是**多云入口隐藏**：`starops` 字段、
    //    BFF 的 STAROps 分支、以及 localStorage 里那些值全都还活着，所以"恢复"技术上
    //    是能成的 —— 恰恰因此必须挡。真实数据就在客户浏览器里：2026-09-15 之前在通用
    //    会话选过「阿里云 STAROps」的人，本地写着 `"starops"`。放它恢复的症状是
    //    **界面上找不到任何地方显示它切走了**（那一段现在整段不渲染），而下一轮问 AWS
    //    的问题会真的发去另一朵云 —— 不可逆（问题原文已经出境）。
    //    这里连 general 也 off，因为闸门走 `topicHasStarops`，它已经被 `MULTICLOUD_UI` 门住。
    for (const topic of ["general", "investigate", "cost", "finops", "cases", "whats-new", undefined]) {
      expect(restorableMode(topic, "starops"), String(topic)).toBe("off");
    }
    // 「开关翻开那天的主题口径」由 `convMode.starops.test.ts` 钉（vi.mock 整文件生效，
    // 两种开关值必须分两个文件）—— 不要在这里补 flag=true 的断言。
  });

  it("off 永远是 off；topic 缺失按 general 处理", () => {
    expect(restorableMode("investigate", "off")).toBe("off");
    expect(restorableMode(undefined, "chat")).toBe("off");
    expect(restorableMode(undefined, "agent")).toBe("off");
  });
});
