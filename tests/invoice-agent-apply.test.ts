import { describe, expect, it } from "vitest";
import { applyActions, draftSummary, needsConfirm, snapshot, type ApplyCtx } from "../src/lib/invoices/chat/apply";
import type { Action } from "../src/lib/invoices/chat/actions";
import { nextFitStep } from "../src/lib/invoices/chat/fit";
import { emptyForm, formToInput, type DocForm } from "../src/lib/invoices/form";
import type { ItemTypeLite } from "../src/lib/invoices/sectors";

const T = (n: number, nameAr: string, unitCc: number): ItemTypeLite => ({ id: `00000000-0000-4000-8000-00000000000${n}`, nameAr, unitCc });
const TYPES = [T(1, "شركة", 1200), T(2, "مدير", 3500), T(3, "بريد إلكتروني", 45), T(4, "رقم هاتف", 500)];
const CTX: ApplyCtx = { types: TYPES, creditValueE4: 1000, canChangeDocType: true };
const blank = (over: Partial<DocForm> = {}): DocForm => ({ ...emptyForm("invoice", "2026-10-31", { rateE4: null, payment: "" }), showUsd: true, showPoints: false, showEgp: false, ...over });
const run = (form: DocForm, actions: Action[], ctx: ApplyCtx = CTX) => applyActions(form, actions, ctx, draftSummary(form, ctx.types).lineIds);
const SECTORS: Action[] = [
  { type: "add_sector", name: "كهروميكانيكا", counts: { company: 200, manager: 312, email: 287, phone: 140 } },
  { type: "add_sector", name: "بترول", counts: { company: 150, manager: 190 } },
];

describe("actions run on the draft with the money library, and report before and after", () => {
  it("the owner's flow: sectors from his words, the rate, then the exact total; before/after are the real totals", () => {
    const a = run(blank(), SECTORS);
    expect(a.applied).toHaveLength(2);
    expect(a.form.batches.map((b) => b.title)).toEqual(["كهروميكانيكا", "بترول"]);
    expect(a.form.lines.map((l) => [l.itemTypeName, l.qty])).toEqual([["شركة", "200"], ["مدير", "312"], ["بريد إلكتروني", "287"], ["رقم هاتف", "140"], ["شركة", "150"], ["مدير", "190"]]);
    // 200x12c + 312x35c + 287x0.45c + 140x5c + 150x12c + 190x35c = 2400 + 10920 + 129 + 700 + 1800 + 6650
    expect(a.after.usd).toBe(22599);
    expect(a.before.usd).toBe(0);
    expect(a.moneyChanged).toBe(true);
    const b = run(a.form, [{ type: "set_rate", rateE4: 560000 }, { type: "set_currencies", usd: true, points: true }]);
    expect(b.form.rate).toBe("56");
    expect(b.after.shown).toEqual(["usd", "points"]);
    const c = run(b.form, [{ type: "set_target_total", currency: "usd", text: "17" }]);
    expect(c.after.usd).toBe(1700);
    expect(c.before.usd).toBe(22599);
    expect(c.applied[0]).toContain("تمامًا");
    expect(c.applied[0]).toContain("١٧.٠٠");
    // the prices changed, the quantities did not
    expect(c.form.lines.map((l) => l.qty)).toEqual(a.form.lines.map((l) => l.qty));
    expect(c.form.lines.some((l, i) => l.unit !== a.form.lines[i].unit)).toBe(true);
    // and the result is a saveable document
    expect(formToInput(c.form).ok).toBe(true);
  });

  it("an exact total is not always possible: the nearest is applied and SAID (in points, per-line cents)", () => {
    const f = run(blank({ showUsd: false, showPoints: true, rate: "56" }), SECTORS).form;
    const r = run(f, [{ type: "set_target_total", currency: "points", text: "5000" }]);
    expect(r.refused).toEqual([]);
    expect(r.applied[0]).toMatch(/تمامًا|أقرب إجمالي ممكن/);
    if (r.after.points !== 5000) { expect(r.applied[0]).toContain("أقرب إجمالي ممكن"); expect(r.warnings.join(" ")).toContain("أقرب إجمالي ممكن"); }
  });

  it("prices: dollars (0.28 = 28 cents) or points per item (converted with the document's rate); all lines of that type, also lines added in the same reply", () => {
    const f = run(blank({ rate: "50", showPoints: true }), SECTORS.slice(0, 1)).form;
    const usd = run(f, [{ type: "set_unit_price", itemType: "company", unit: "usd", text: "0.28" }]);
    expect(usd.form.lines.find((l) => l.itemTypeName === "شركة")?.unit).toBe("0.28");
    expect(usd.applied[0]).toContain("٠.٢٨");
    const pts = run(f, [{ type: "set_unit_price", itemType: "شركة", unit: "points", text: "60" }]);
    expect(pts.form.lines.find((l) => l.itemTypeName === "شركة")?.unit).toBe("0.12"); // 60 points at 50 EGP/USD, 0.10 EGP a point
    // set before the sector exists: the new lines take the new price
    const both = run(blank(), [{ type: "set_unit_price", itemType: "company", unit: "usd", text: "0.5" }, { type: "add_sector", name: "س", counts: { company: 10, manager: 4 } }]);
    expect(both.form.lines.map((l) => [l.itemTypeName, l.unit])).toEqual([["شركة", "0.5"], ["مدير", "0.35"]]);
  });

  it("refusals, in plain Arabic, change nothing: points price without a rate, unknown item type, unknown sector, a currency that is not shown", () => {
    const f = run(blank(), SECTORS.slice(0, 1)).form;
    const cases: Action[][] = [
      [{ type: "set_unit_price", itemType: "company", unit: "points", text: "60" }],
      [{ type: "set_unit_price", itemType: "logo", unit: "usd", text: "1" }],
      [{ type: "rename_sector", from: "غير موجود", to: "س" }],
      [{ type: "remove_sector", sector: "غير موجود" }],
      [{ type: "set_target_total", currency: "points", text: "100" }], // points need a rate: nothing is switched on either
    ];
    for (const actions of cases) {
      const r = run(f, actions);
      expect(r.refused.length, JSON.stringify(actions)).toBe(1);
      expect(r.form).toBe(f);
      expect(r.refused[0]).toMatch(/[؀-ۿ]/);
    }
  });

  it("a total in a currency that is not shown switches that currency on (and says so); a refusal leaves the currency flags as they were", () => {
    const f = run(blank({ showUsd: false, showPoints: true, rate: "56" }), SECTORS).form;
    expect(f.showUsd).toBe(false);
    const r = run(f, [{ type: "set_target_total", currency: "usd", text: "17" }]);
    expect(r.form.showUsd).toBe(true);
    expect(r.applied[0]).toContain("فعّلت عرض دولار");
    expect(r.after.usd).toBe(1700);
    expect(r.after.shown).toEqual(["usd", "points"]);
    const noRate = run(blank({ showUsd: true, showPoints: false }), SECTORS).form;
    const refused = run(noRate, [{ type: "set_target_total", currency: "egp", text: "100" }]);
    expect(refused.refused).toHaveLength(1);
    expect(refused.form.showEgp).toBe(false);
  });

  it("a data statement has no money: every money action is refused", () => {
    const f = blank({ docType: "statement" });
    const r = run(f, [{ type: "set_rate", rateE4: 560000 }, { type: "set_unit_price", itemType: "company", unit: "usd", text: "1" }, { type: "set_target_total", currency: "usd", text: "5" }, { type: "set_discount", kind: "percent", text: "10" }, { type: "set_currencies", points: true }]);
    expect(r.applied).toEqual([]);
    expect(r.refused).toHaveLength(5);
  });

  it("document type changes only on a new document; discount and client apply", () => {
    expect(run(blank(), [{ type: "set_doc_type", docType: "quote" }]).form.docType).toBe("quote");
    const locked = run(blank(), [{ type: "set_doc_type", docType: "quote" }], { ...CTX, canChangeDocType: false });
    expect(locked.refused[0]).toContain("بعد حفظها");
    const d = run(blank(), [{ type: "set_discount", kind: "percent", text: "10" }, { type: "set_client", name: "شركة النور" }]);
    expect(d.form).toMatchObject({ discountKind: "percent", discount: "10", company: "شركة النور", clientId: null });
  });

  it("setting counts of an existing sector REPLACES them (a second import never doubles), a missing sector is created, 0 removes a line", () => {
    const f = run(blank(), SECTORS).form;
    const r = run(f, [{ type: "set_counts", sector: "بترول", counts: { company: 160, manager: 0 } }, { type: "set_counts", sector: "مقاولات", counts: { company: 50 } }]);
    expect(r.form.batches.map((b) => b.title)).toEqual(["كهروميكانيكا", "بترول", "مقاولات"]);
    const petrol = r.form.batches[1].key;
    expect(r.form.lines.filter((l) => l.batchKey === petrol).map((l) => [l.itemTypeName, l.qty])).toEqual([["شركة", "160"]]);
  });

  it("a sector is found by name loosely (alef, spaces) and by the only sector that contains the words", () => {
    const f = run(blank(), [{ type: "add_sector", name: "الأسمنت والإنشاءات", counts: { company: 5 } }]).form;
    expect(run(f, [{ type: "rename_sector", from: "الاسمنت والانشاءات", to: "إنشاءات" }]).form.batches[0].title).toBe("إنشاءات");
    expect(run(f, [{ type: "rename_sector", from: "الإنشاءات", to: "x" }]).form.batches[0].title).toBe("x");
  });
});

describe("layout actions", () => {
  const f = run(blank(), SECTORS).form;
  const sum = draftSummary(f, TYPES);

  it("«شيل الأرقام المخفية»: every hidden line is shown again; hide by line id; summary-only by sector name; the phase summary flag; pages", () => {
    const hid = run(f, [{ type: "set_layout", hideLineIds: ["L1", "L2"] }]);
    expect(hid.form.lines.filter((l) => l.hidden)).toHaveLength(2);
    expect(hid.after.usd).toBe(hid.before.usd); // hiding never changes a total
    const un = run(hid.form, [{ type: "set_layout", unhideAll: true }]);
    expect(un.form.lines.every((l) => !l.hidden)).toBe(true);
    expect(un.applied[0]).toContain("أظهرت");
    const s = run(f, [{ type: "set_layout", summaryOnlySectors: ["بترول", "غير موجود"], showPhaseSummary: false, maxPages: 1 }]);
    expect(s.form.batches.find((b) => b.title === "بترول")?.summaryOnly).toBe(true);
    expect(s.refused[0]).toContain("غير موجود");
    expect(s.phaseSummary).toBe(false);
    expect(s.fitPages).toBe(1);
    expect(s.after.usd).toBe(s.before.usd);
    expect(sum.lineIds.get("L1")).toBe(f.lines[0].key);
  });

  it("layout actions do not wait for «تمام»; money actions do", () => {
    const layout: Action[] = [{ type: "set_layout", maxPages: 1 }, { type: "rename_sector", from: "بترول", to: "نفط" }, { type: "set_client", name: "س" }];
    expect(needsConfirm(layout, run(f, layout))).toBe(false);
    const money: Action[] = [{ type: "set_discount", kind: "percent", text: "5" }];
    expect(needsConfirm(money, run(f, money))).toBe(true);
  });

  it("fit steps: the biggest sector becomes a summary first, then loose lines are hidden together; totals never change; nothing left = null", () => {
    let cur = f;
    const sizes = [];
    for (let i = 0; i < 5; i++) { const s = nextFitStep(cur); if (!s) break; sizes.push(s.note); cur = s.form; }
    expect(sizes[0]).toContain("كهروميكانيكا");
    expect(sizes[1]).toContain("بترول");
    expect(cur.batches.every((b) => b.summaryOnly)).toBe(true);
    expect(nextFitStep(cur)).toBeNull();
    expect(snapshot(cur, 1000).usd).toBe(snapshot(f, 1000).usd);
    const loose = { ...blank(), lines: [{ key: "a", batchKey: null, itemTypeId: null, itemTypeName: "x", description: "", qty: "1", unit: "1", hidden: false }, { key: "b", batchKey: null, itemTypeId: null, itemTypeName: "y", description: "", qty: "1", unit: "1", hidden: false }] };
    expect(nextFitStep(loose)?.form.lines.every((l) => l.hidden)).toBe(true);
  });
});

describe("what the model is told about the draft: names and counts, never money", () => {
  it("has sectors, counts and line ids; no price, total, rate value or amount anywhere", () => {
    const f = run(blank({ rate: "56.5", showPoints: true, discountKind: "percent", discount: "10" }), SECTORS).form;
    const { summary, lineIds } = draftSummary(f, TYPES);
    const json = JSON.stringify(summary);
    expect(summary.sectors[0]).toEqual({ name: "كهروميكانيكا", summary_only: false, counts: { company: 200, manager: 312, email: 287, phone: 140 } });
    expect(summary.rate_set).toBe(true);
    expect(lineIds.size).toBe(f.lines.length);
    expect(json).not.toMatch(/56\.5|unit|price|total|0\.12|1200|22599|22,599/);
    expect(Object.keys(summary).sort()).toEqual(["client", "currencies", "discount", "doc_type", "lines", "lines_listed", "rate_set", "sectors"]);
  });

  it("a big draft lists no lines (line ids are only offered when they fit)", () => {
    const f = { ...blank(), lines: Array.from({ length: 151 }, (_, i) => ({ key: `k${i}`, batchKey: null, itemTypeId: null, itemTypeName: "x", description: "", qty: "1", unit: "1", hidden: false })) };
    expect(draftSummary(f, TYPES).summary.lines_listed).toBe(false);
    expect(draftSummary(f, TYPES).summary.lines).toEqual([]);
  });
});
