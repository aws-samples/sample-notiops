/**
 * 侧栏会话条目上那枚「对话对象」tag 的契约。
 *
 * 为什么值得一份测试：这枚 tag 是**跨云**的身份标识，而它错掉的方式全是「不报错」——
 *   · 老会话（服务端还没有 `obj` 这个属性）被猜成 NotiOps → 一段阿里云 STAROps 会话在
 *     侧栏写着 NotiOps，客户据此判断"这段问的是 AWS"，是纯假信息；
 *   · 顶栏与侧栏用了两套颜色/图标 → 同一段会话看着像两个不同的东西；
 *   · 有人"顺手"把它塞回 `showTag` 里 → 分组列表（showTag=false）整片消失，而「通用」
 *     那一组恰恰只能靠它区分 notiops / devops / starops，也就是这个需求的全部目的。
 *
 * 刻意**渲染**组件而不是 grep 源码："用户看不看得见这枚 tag、上面写的是什么"是行为。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/ConvItem.objtag.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { STRINGS } from "../i18n";
import type { Conversation } from "../types";
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

describe("侧栏「对话对象」tag", () => {
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

  it("对象已知时**不再**显示主题 tag（一行只放一枚）", () => {
    render(<ConvItem {...base} conv={conv({ obj: "devops", topic: "investigate" })} />);
    expect(document.querySelectorAll(".conv-topic").length).toBe(1);
    expect(tagText()).toBe("DevOps");
    expect(screen.queryByText(zh("topic.investigate"))).toBeNull();
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
