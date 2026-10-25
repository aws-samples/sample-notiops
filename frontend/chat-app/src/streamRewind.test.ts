import { describe, expect, it } from "vitest";
import { createStreamRewind } from "./streamRewind";
import { appendReasoning, appendStep, type TimelineStep } from "./thinking";

// 输出崩坏守卫（待办 #2）浏览器这一侧：书签记下正文与「思考过程」，discard 时原样退回。
describe("streamRewind", () => {
  it("退回到被判死的那次调用开头：之前几次调用的正文与时间线都在，乱码那段没了", () => {
    const r = createStreamRewind<TimelineStep[]>();
    let acc = "";
    let tl: TimelineStep[] = [];
    r.mark(1, acc, tl);
    tl = appendReasoning(tl, "先查一下文档。", 1);
    acc += "我先查一下官方文档……";
    tl = appendStep(tl, { text: "调用 aws_docs_read", kind: "tool" }, 2);
    r.mark(2, acc, tl);
    tl = appendReasoning(tl, " @ @ @ @ @ @", 3);          // 乱码进了思考段
    acc += "勒-何-时间-唯一-ex-comp";                       // 乱码也进了正文
    const m = r.rewind(2);
    expect(m?.text).toBe("我先查一下官方文档……");
    expect(m?.timeline.map((s) => s.text)).toEqual(["先查一下文档。", "调用 aws_docs_read"]);
  });

  it("书签只记引用、不被后来的追加改掉（thinking.ts 每次返回新数组）", () => {
    const r = createStreamRewind<TimelineStep[]>();
    let tl = appendReasoning([], "第一段", 1);
    r.mark(1, "", tl);
    tl = appendReasoning(tl, "接着想", 2);                  // 并进同一段 thought：新对象，不改旧的
    expect(r.rewind(1)?.timeline[0].text).toBe("第一段");
  });

  it("没记过的书签 / 非数字：返回 undefined，调用方原样不动", () => {
    const r = createStreamRewind<string[]>();
    r.mark(Number.NaN, "x", []);
    expect(r.rewind(1)).toBeUndefined();
    expect(r.rewind(undefined)).toBeUndefined();
    expect(r.rewind(Number.NaN)).toBeUndefined();
  });
});
