// 变更记录里那一行「改了什么」：服务端只记主机与动作（`llm_config.mjs::writeAudit` 的 note），这里换成人话。
import { describe, expect, it } from "vitest";
import { STRINGS, type Locale } from "../../i18n";
import { auditNoteText } from "./AuditDrawer";

const tFor = (locale: Locale) => (k: string) => STRINGS[k]?.[locale] ?? k;

describe("auditNoteText", () => {
  it("names both hosts of a gateway change", () => {
    expect(auditNoteText("gateway_set:gw.example.com->gw2.example.com", tFor("en")))
      .toBe("Gateway: gw.example.com → gw2.example.com");
    expect(auditNoteText("gateway_set:-->gw.example.com", tFor("zh"))).toBe("网关:— → gw.example.com");
  });

  it("says when the change did not reach the running agents", () => {
    expect(auditNoteText("gateway_set:a.example.com->b.example.com:not_propagated", tFor("en")))
      .toBe("Gateway: a.example.com → b.example.com (running agents not notified)");
  });

  it("covers the other notes the server writes, in both languages", () => {
    for (const locale of ["zh", "en"] as const) {
      const t = tFor(locale);
      for (const note of ["gateway_cleared:gw.example.com->-", "key_set", "key_cleared", "backend_tasks", "rollback_to:0001"]) {
        const text = auditNoteText(note, t);
        expect(text).not.toBe(note);
        expect(text).not.toMatch(/admin\.models\./);   // 没有漏掉的 i18n key
      }
    }
  });

  it("shows an unknown note as is, and nothing for old entries without one", () => {
    expect(auditNoteText("something_new", tFor("en"))).toBe("something_new");
    expect(auditNoteText(undefined, tFor("en"))).toBe("");
  });
});
