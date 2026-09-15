/**
 * 「谁来答这一轮」记忆里 STAROps 那一支在**多云翻开时**的主题口径（convMode.ts 的
 * `restorableMode`）。
 *
 * 为什么必须单独一个文件：`convMode.test.ts` 跑的是真开关（2026-09-15 起 `MULTICLOUD_UI`
 * 关着），它钉的是「一律 off」这件事本身；而 vitest 的 `vi.mock` 是**整文件生效**的 ——
 * 同一个文件里读不到两种开关值。同样的拆法见 `components/ChatObjectPicker.hidden.test.tsx`。
 *
 * 这里守的是「实现还在、翻开就是这个行为」：
 *   · `STAROPS_TOPICS` 必须真的含 general —— general 恰恰是唯一能选 STAROps 的地方，
 *     漏了它这条记忆就被**静默**丢掉（devopsChat 曾经就踩在这个坑里：选了、发过问、
 *     刷新一下选择没了，接着追问换了另一个对象来答，界面上没有任何提示）；
 *   · 别的主题一律 off —— 那些主题里「对话对象」那张卡片根本不存在，恢复回来的状态
 *     客户既看不到也关不掉。
 *
 * ⚠️ 不要因为「现在开关是关的」就把这个文件删掉：删了就等于把 STAROps 那一支锁死在
 *    关闭状态，翻开开关的那天上面两条**只会静默出错、不会报错**的口径一条都没人守。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/convMode.starops.test.ts
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./featureFlags", () => ({ MULTICLOUD_UI: true }));

import { restorableMode } from "./convMode";

describe("恢复前的主题闸门：多云翻开时的 STAROps", () => {
  it("只在 general 恢复（topic 缺失按 general）", () => {
    expect(restorableMode("general", "starops")).toBe("starops");
    expect(restorableMode(undefined, "starops")).toBe("starops");
  });

  it("别的主题一律 off", () => {
    for (const bad of ["investigate", "cost", "finops", "cases", "whats-new"]) {
      expect(restorableMode(bad, "starops"), bad).toBe("off");
    }
  });

  it("翻开多云不影响另外三个模式的口径", () => {
    // 这条是防"翻开开关顺手把别人的闸门也带松了"：三个 DevOps 模式与多云无关，
    // 它们的口径在 flag=true / flag=false 两种世界里必须完全一样。
    expect(restorableMode("investigate", "chat")).toBe("chat");
    expect(restorableMode("general", "chat")).toBe("off");
    expect(restorableMode("investigate", "direct")).toBe("direct");
    expect(restorableMode("general", "direct")).toBe("off");
    expect(restorableMode("investigate", "agent")).toBe("off");
  });
});
