/**
 * 侧栏会话条目上那枚 tag 的契约：**主题会话 → 主题 tag，通用会话 → 「对话对象」tag**，
 * 与顶栏（ChatApp 的 topbar-topic）同一套口径（用户 2026-10-13）。
 *
 * 为什么值得一份测试：这枚 tag 错掉的方式全是「不报错」——
 *   · 老会话（服务端还没有 `obj` 这个属性）被猜成 NotiOps → 一段阿里云 STAROps 会话在
 *     侧栏写着 NotiOps，客户据此判断"这段问的是 AWS"，是纯假信息；
 *   · 顶栏与侧栏用了两套颜色/图标 → 同一段会话看着像两个不同的东西；
 *   · 有人"顺手"把对象 tag 塞回 `showTag` 里 → 分组列表（showTag=false）整片消失，而「通用」
 *     那一组恰恰只能靠它区分 notiops / devops / starops；
 *   · 先看 obj 再看主题（2026-10-13 用户报的）：v1.0.28 起每条新会话都落了 obj（默认
 *     notiops），于是调查 / 成本 / 案例 / What's New 组里一律写着 NotiOps，顶栏却写主题名。
 *
 * 刻意**渲染**组件而不是 grep 源码："用户看不看得见这枚 tag、上面写的是什么"是行为。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/ConvItem.objtag.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { STRINGS } from "../i18n";
import type { Conversation, TopicKey } from "../types";
import { TOPICS } from "../types";
import ConvItem from "./ConvItem";

const zh = (k: string) => STRINGS[k].zh;

const base = {
  active: false,
  onSelect: vi.fn(),
  onRename: vi.fn(),
  onTogglePin: vi.fn(),
  onDelete: vi.fn(),
};

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1", title: "一段会话", messages: [], updatedAt: 1, ...over,
});

/** 条目上那枚 tag 的文字（没有 tag 时返回 null）。 */
function tagText(): string | null {
  const el = document.querySelector(".conv-topic-label");
  return el ? (el.textContent || "").trim() : null;
}
/** 那枚 tag 的行内颜色（顶栏用同一组 CSS 变量，两处必须一致）。 */
function tagColor(): string {
  const el = document.querySelector(".conv-topic") as HTMLElement | null;
  return el?.style.color || "";
}

beforeEach(() => cleanup());

describe("侧栏会话 tag（主题会话 → 主题，通用会话 → 对话对象）", () => {
  it("STAROps 会话显示短名 + 与顶栏同色", () => {
    render(<ConvItem {...base} conv={conv({ obj: "starops" })} />);
    expect(tagText()).toBe(zh("conv.obj.starops"));
    expect(tagText()).toBe("STAROps");   // 短名，不是"阿里云 STAROps"（那会挤没标题）
    expect(tagColor()).toBe("var(--link)");
  });

  it("DevOps 会话显示 DevOps 短名（不是 AWS DevOps Agent 全称）", () => {
    render(<ConvItem {...base} conv={conv({ obj: "devops" })} />);
    expect(tagText()).toBe("DevOps");
    expect(tagText()).not.toBe(zh("obj.tag.devops"));
    expect(tagColor()).toBe("var(--ok)");
  });

  it("NotiOps 会话显示 NotiOps", () => {
    render(<ConvItem {...base} conv={conv({ obj: "notiops" })} />);
    expect(tagText()).toBe("NotiOps");
    expect(tagColor()).toBe("var(--orange)");
  });

  it("全称走 title（信息没丢，只是不占行宽）", () => {
    render(<ConvItem {...base} conv={conv({ obj: "starops" })} />);
    const el = document.querySelector(".conv-topic") as HTMLElement;
    expect(el.getAttribute("title")).toBe(zh("obj.tag.starops.hint"));
  });

  it("分组列表里（showTag=false）对象 tag 照样显示", () => {
    // 这条是需求的核心：组标题说得清主题，说不清"谁答的"。
    render(<ConvItem {...base} conv={conv({ obj: "starops", topic: "general" })} showTag={false} />);
    expect(tagText()).toBe("STAROps");
  });

  it("通用会话在分组列表里（showTag=false）按对象区分 NotiOps / DevOps", () => {
    render(<ConvItem {...base} conv={conv({ obj: "notiops", topic: "general" })} showTag={false} />);
    expect(tagText()).toBe("NotiOps");
    cleanup();
    render(<ConvItem {...base} conv={conv({ obj: "devops" })} showTag={false} />);
    expect(tagText()).toBe("DevOps");
  });

  it("主题会话显示主题 tag，即使对象已知（与顶栏同口径，一行只放一枚）", () => {
    render(<ConvItem {...base} conv={conv({ obj: "devops", topic: "investigate" })} />);
    expect(document.querySelectorAll(".conv-topic").length).toBe(1);
    expect(tagText()).toBe(zh("topic.investigate"));
    expect(screen.queryByText("DevOps")).toBeNull();
  });

  it("分组列表里（showTag=false）每个主题的会话都显示自己的主题 tag，不再一律 NotiOps", () => {
    // 2026-10-13 用户截图里的样子：成本 / 案例 / 调查 / What's New 组里全是 NotiOps。
    for (const td of TOPICS) {
      cleanup();
      render(<ConvItem {...base} conv={conv({ obj: "notiops", topic: td.key })} showTag={false} />);
      expect(document.querySelectorAll(".conv-topic").length).toBe(1);
      expect(tagText()).toBe(zh(td.labelKey));
      expect(tagColor()).toBe(td.color);
      expect(screen.queryByText("NotiOps")).toBeNull();
    }
  });

  it("老会话头里永久存着的 topic:security 按「调查」显示", () => {
    const legacy = "security" as unknown as TopicKey;
    render(<ConvItem {...base} conv={conv({ obj: "notiops", topic: legacy })} showTag={false} />);
    expect(tagText()).toBe(zh("topic.investigate"));
  });

  it("老会话（obj 空/缺失）回落到原来的主题 tag —— 不许猜成 NotiOps", () => {
    render(<ConvItem {...base} conv={conv({ topic: "investigate" })} />);
    expect(tagText()).toBe(zh("topic.investigate"));
    cleanup();
    render(<ConvItem {...base} conv={conv({ obj: "", topic: "finops" })} />);
    expect(tagText()).toBe(zh("topic.cost"));
    cleanup();
    // 未知取值同理（将来后端多写一个值时，宁可回落也不要渲染一个空标签）。
    render(<ConvItem {...base} conv={conv({ obj: "bogus", topic: "general" })} />);
    expect(tagText()).toBe(zh("topic.general"));
  });

  it("老会话 + showTag=false → 与改动前一样什么都不显示", () => {
    render(<ConvItem {...base} conv={conv({ topic: "general" })} showTag={false} />);
    expect(tagText()).toBeNull();
  });
});
