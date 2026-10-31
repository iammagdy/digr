import { describe, expect, it } from "vitest";
import { isMoneyAction, parseActions } from "../src/lib/invoices/chat/actions";
import { parseAgentReply, sanitizeSay, type ReplyCtx } from "../src/lib/invoices/chat/reply";
import type { FileProfile } from "../src/lib/invoices/chat/types";

const profile = (cols: string[]): FileProfile => ({ file: "a.xlsx", sheets: [{ sheet: "S", rows: 10, header_row: 1, columns: cols.map((c) => ({ col: c, header: `h${c}`, filled: 5, distinct: 5, email_share: 0, phone_share: 0, number_share: 0, avg_words: 1, samples: [] })) }] });
const ctx: ReplyCtx = { profiles: [profile(["A", "B", "C", "D", "E"])], imageNames: ["scan.png"], lineIds: new Set(["L1", "L2"]) };
const ok = (obj: unknown) => parseAgentReply(JSON.stringify(obj), ctx);
const reason = (obj: unknown) => { const r = ok(obj); return r.ok ? "accepted" : r.reason; };
const act = (a: unknown) => parseActions([a], { lineIds: ctx.lineIds });

describe("the action vocabulary is fixed and strict", () => {
  const valid: unknown[] = [
    { action: "set_rate", egp_per_usd: 56 }, { action: "set_rate", egp_per_usd: "٥٦٫٥" },
    { action: "set_currencies", points: true, usd: false },
    { action: "add_sector", name: "بترول", counts: { company: 150, manager: 0 } },
    { action: "set_counts", sector: "بترول", counts: { email: 12 } },
    { action: "set_unit_price", item_type: "company", value: 0.28, unit: "usd" }, { action: "set_unit_price", item_type: "شركة", value: "60", unit: "points" },
    { action: "set_target_total", amount: 17, currency: "usd" }, { action: "set_target_total", amount: 5000, currency: "points" },
    { action: "set_discount", kind: "percent", value: 10 }, { action: "set_discount", kind: "none" },
    { action: "set_doc_type", doc_type: "quote" }, { action: "set_client", name: "شركة النور" },
    { action: "set_layout", max_pages: 1 }, { action: "set_layout", summary_only_sectors: ["بترول"], unhide_all: true, show_phase_summary: true, hide_line_ids: ["L1"] },
    { action: "rename_sector", from: "أ", to: "ب" }, { action: "remove_sector", sector: "ب" },
  ];
  it("accepts every action with valid fields", () => { for (const a of valid) expect(act(a).ok, JSON.stringify(a)).toBe(true); });

  it("rejects an action outside the list, an extra key, a wrong type and a missing field", () => {
    const bad: unknown[] = [
      { action: "delete_invoice" }, { action: "send_invoice" }, { action: "mark_paid" }, { action: "set_total", amount: 5 },
      { action: "set_rate", egp_per_usd: 56, note: "x" }, { action: "set_rate" }, { action: "set_rate", egp_per_usd: "abc" },
      { action: "add_sector", name: "x" }, { action: "add_sector", name: "x", counts: {} }, { action: "add_sector", name: "x", counts: { company: -1 } }, { action: "add_sector", name: "x", counts: { company: 1.5 } }, { action: "add_sector", name: "x", counts: { price: 5 } },
      { action: "set_unit_price", item_type: "company", value: 0.28, unit: "cents" }, { action: "set_unit_price", item_type: "company", value: 0.00029, unit: "usd" },
      { action: "set_target_total", amount: 0, currency: "usd" }, { action: "set_target_total", amount: 17, currency: "eur" }, { action: "set_target_total", amount: 17.5, currency: "points" },
      { action: "set_discount", kind: "percent", value: 150 }, { action: "set_discount", kind: "percent" }, { action: "set_discount", kind: "free" },
      { action: "set_doc_type", doc_type: "tax_invoice" }, { action: "set_layout" }, { action: "set_layout", max_pages: 0 }, { action: "set_layout", max_pages: 99 },
      { action: "set_layout", hide_line_ids: ["L1", "L999"] }, { action: "set_rate", egp_per_usd: 0 }, { action: "set_rate", egp_per_usd: 5000 }, { action: "set_rate", egp_per_usd: 56.12345 },
      "set_rate", null, 5, [],
    ];
    for (const a of bad) expect(act(a).ok, JSON.stringify(a)).toBe(false);
  });

  it("there is NO action to send, mark paid, void, save or delete: «إرسال» stays a manual button", () => {
    for (const t of ["send", "send_invoice", "set_status", "mark_paid", "void", "save", "save_draft", "delete", "export"]) expect(act({ action: t }).ok, t).toBe(false);
  });

  it("at most 12 actions in one reply", () => {
    expect(parseActions(Array.from({ length: 12 }, () => ({ action: "set_rate", egp_per_usd: 50 })), { lineIds: new Set() }).ok).toBe(true);
    expect(parseActions(Array.from({ length: 13 }, () => ({ action: "set_rate", egp_per_usd: 50 })), { lineIds: new Set() }).ok).toBe(false);
  });

  it("which actions are money-changing (they wait for «تمام»)", () => {
    const money = ["set_rate", "set_currencies", "add_sector", "set_counts", "set_unit_price", "set_target_total", "set_discount", "set_doc_type", "remove_sector"];
    const free = ["set_client", "set_layout", "rename_sector"];
    for (const t of money) expect(isMoneyAction({ type: t } as never), t).toBe(true);
    for (const t of free) expect(isMoneyAction({ type: t } as never), t).toBe(false);
  });
});

describe("the whole reply is parsed strictly", () => {
  it("accepts mapping + actions + a sentence without digits", () => {
    const r = ok({ say: "ماشي، هرتب الملف وأعرض عليك الأعداد.", mapping: [{ file: "a.xlsx", sheet: "S", sector_name: "بترول", columns: { company: "B", manager: "C", email: "D", phone: null } }], actions: [{ action: "set_rate", egp_per_usd: 56 }] });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.reply.mapping[0].columns).toEqual({ company: "B", manager: "C", email: "D" }); expect(r.reply.mapping[0].sectorName).toBe("بترول"); expect(r.sayDropped).toBe(false); }
  });

  it("a prose reply, an array, an unknown top-level key and a price or total anywhere at the top reject the whole reply", () => {
    expect(parseAgentReply("تمام يا فندم", ctx)).toMatchObject({ ok: false, reason: "not_json" });
    expect(reason([])).toBe("not_object");
    expect(reason({ say: "x", note: "y" })).toBe("bad_keys");
    for (const k of ["price", "total", "unit_price_usd", "currency", "discount", "tax", "cost", "إجمالي", "سعر"]) expect(reason({ [k]: 1 }), k).toBe("money_field");
  });

  it("a mapping to a file, sheet or column that is not in the profile, a column used twice, or an extra key is rejected; a sheet with no data columns is skipped", () => {
    const col = (columns: unknown, extra: object = {}) => ({ mapping: [{ file: "a.xlsx", sheet: "S", columns, ...extra }] });
    expect(reason(col({ company: "B" }))).toBe("accepted");
    expect(reason({ mapping: [{ file: "ghost.xlsx", sheet: "S", columns: { company: "B" } }] })).toBe("bad_mapping");
    expect(reason({ mapping: [{ file: "a.xlsx", sheet: "ghost", columns: { company: "B" } }] })).toBe("bad_mapping");
    expect(reason(col({ company: "Z" }))).toBe("bad_mapping");
    expect(reason(col({ company: "B", manager: "B" }))).toBe("bad_mapping");
    expect(reason(col({ company: "B", price: "C" }))).toBe("bad_mapping");
    expect(reason(col({ company: "B" }, { total: 5 }))).toBe("bad_mapping");
    const skipped = ok(col({}));
    expect(skipped.ok && skipped.reply.mapping).toEqual([]);
    expect(reason({ mapping: [col({ company: "B" }).mapping[0], col({ company: "C" }).mapping[0]] })).toBe("bad_mapping"); // the same sheet twice
  });

  it("image counts: only the four keys, an attached image, a known item type, a whole quantity", () => {
    const e = (over: object = {}) => ({ image_counts: [{ image: "scan.png", sector: "بترول", item_type: "company", quantity: 40, ...over }] });
    expect(reason(e())).toBe("accepted");
    expect(reason(e({ item_type: "شركة" }))).toBe("accepted");
    expect(reason(e({ image: "other.png" }))).toBe("bad_image_counts");
    expect(reason(e({ item_type: "logo" }))).toBe("bad_image_counts");
    expect(reason(e({ quantity: 0 }))).toBe("bad_image_counts");
    expect(reason(e({ quantity: 2.5 }))).toBe("bad_image_counts");
    expect(reason(e({ price: 1 }))).toBe("bad_image_counts");
  });

  it("the sentence may not contain a number: it is replaced by the code's own sentence (flagged), the rest of the reply still works", () => {
    for (const s of ["لقيت 200 شركة", "لقيت ٢٠٠ شركة", "الإجمالي $17", "خصم ١٠٪", "ok 5"]) expect(sanitizeSay(s), s).toEqual({ say: "", dropped: true });
    expect(sanitizeSay("تمام، هرتب الأعداد.")).toEqual({ say: "تمام، هرتب الأعداد.", dropped: false });
    const r = ok({ say: "الإجمالي ١٧ دولار", actions: [{ action: "set_target_total", amount: 17, currency: "usd" }] });
    expect(r.ok && r.sayDropped).toBe(true);
    expect(r.ok && r.reply.say).toBe("");
  });

  it("a bad action inside an otherwise good reply rejects the whole reply", () => {
    expect(reason({ say: "تمام", actions: [{ action: "set_rate", egp_per_usd: 56 }, { action: "send_invoice" }] })).toBe("bad_actions");
  });

  it("fenced JSON is accepted; empty actions are fine", () => {
    expect(parseAgentReply("```json\n{\"say\":\"تمام\"}\n```", ctx).ok).toBe(true);
    expect(reason({})).toBe("accepted");
  });
});
