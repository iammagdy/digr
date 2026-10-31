import { describe, expect, it } from "vitest";
import { emptyForm, emptyLine, formFromDoc, formToInput, formToPreview, newKey, type DocForm } from "../src/lib/invoices/form";
import { parseScaled } from "../src/lib/invoices/money";
import { buildSheetModel } from "../src/lib/invoices/sheetModel";
import { computeTotals } from "../src/lib/invoices/totals";

/**
 * «THE TOTAL DOES NOT WORK» (owner feedback). Reproduced in a headless browser at 380 px on the real builder, against the live state
 * (item types at price 0, no saved rate, no documents):
 *  1. he ticks «نقاط», unticks the dollar, and has not typed a rate  ->  the totals box is EMPTY (labels, no amounts);
 *  2. he types a quantity as «1,200» (a thousands comma)  ->  the preview counts that line as 0 without a word;
 *  3. every item type is still at price 0  ->  every total reads ٠.٠٠ with no warning (covered in tests/invoice-sectors.test.ts).
 * These tests build the owner's real job through the form code and compare with figures worked out by hand.
 */
const SELLER = { name: "ديجر", email: "support@diger.tech", website: "diger.tech", taxNumber: "", commercialRegister: "" };
const BASE = { id: null, number: "", status: "draft" as const, revision: 1, instapayAddress: "iammagdy@instapay" };

/** 3 sectors: كهروميكانيكا 200 companies + 340 managers, بترول 80 companies, مقاولات 120 companies; companies 12 cents, managers 35 cents. */
function ownersJob(over: Partial<DocForm> = {}): DocForm {
  const f = emptyForm("invoice", "2026-10-31", { rateE4: null, payment: "" });
  const batches = ["كهروميكانيكا", "بترول", "مقاولات"].map((title) => ({ key: newKey("b"), title, summaryOnly: false }));
  const line = (batchKey: string, name: string, qty: string, unit: string) => ({ ...emptyLine(batchKey), itemTypeName: name, qty, unit });
  return {
    ...f, company: "شركة العميل", batches,
    lines: [line(batches[0].key, "شركة", "200", "0.12"), line(batches[0].key, "مدير", "340", "0.35"), line(batches[1].key, "شركة", "80", "0.12"), line(batches[2].key, "شركة", "120", "0.12")],
    ...over,
  };
}

// by hand: 200 x 12c = 2400c, 340 x 35c = 11900c, 80 x 12c = 960c, 120 x 12c = 1440c  ->  16700c = $167.00
// at 50.75 EGP per USD, once per line: 2400c -> 12180, 11900c -> 60392.5 -> 60393, 960c -> 4872, 1440c -> 7308  ->  84,753 points
const EXPECTED_USD = "١٦٧.٠٠";
const EXPECTED_POINTS = "٨٤٬٧٥٣";
const totalOf = (f: DocForm) => buildSheetModel(formToPreview(f, BASE), SELLER).totalRows.at(-1)!;

describe("the total shows up, whatever currency the owner picks", () => {
  it("dollars: $167.00 (the figure worked out by hand)", () => {
    const t = totalOf(ownersJob());
    expect(t.amounts).toEqual([EXPECTED_USD]);
  });

  it("points with a rate typed: 84,753 points", () => {
    const t = totalOf(ownersJob({ showUsd: false, showPoints: true, rate: "50.75" }));
    expect(t.amounts).toEqual([EXPECTED_POINTS]);
  });

  it("BUG 1: points only and NO rate typed (the live state): the totals are never empty; the dollar total is shown until a rate exists", () => {
    const f = ownersJob({ showUsd: false, showPoints: true, rate: "" });
    const model = buildSheetModel(formToPreview(f, BASE), SELLER);
    expect(model.currencies.length).toBeGreaterThan(0);
    expect(model.totalRows.every((r) => r.amounts.length > 0 && r.amounts.every((a) => /[٠-٩]/.test(a)))).toBe(true);
    expect(model.totalRows.at(-1)!.amounts).toEqual([EXPECTED_USD]);
  });

  it("BUG 1b: same for EGP only without a rate, and for points + EGP without a rate", () => {
    for (const over of [{ showUsd: false, showEgp: true }, { showUsd: false, showPoints: true, showEgp: true }]) {
      const t = totalOf(ownersJob({ ...over, rate: "" }));
      expect(t.amounts).toEqual([EXPECTED_USD]);
    }
  });

  it("BUG 2: a quantity typed with a thousands comma or space is read as that number, never silently as 0", () => {
    for (const typed of ["1,200", "١٬٢٠٠", "1 200", "1200", "١٢٠٠"]) {
      const f = ownersJob();
      f.lines[0].qty = typed;
      const p = formToPreview(f, BASE);
      expect(p.lines[0].quantity, typed).toBe(1200);
      const r = formToInput(f);
      expect(r.ok, typed).toBe(true);
    }
    expect(parseScaled("1,200", 0)).toBe(1200);
    expect(parseScaled("1.200", 0)).toBeNull(); // a dot is not a thousands mark here: refused, never guessed
    expect(parseScaled("12,5", 0)).toBeNull();
  });

  it("the preview total equals the saved document's total (one money library, no second calculation)", () => {
    const f = ownersJob({ showUsd: true, showPoints: true, rate: "50.75" });
    const r = formToInput(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = formToPreview(f, BASE);
    const t = computeTotals(doc.lines, doc);
    expect(t.total).toEqual({ usd: 16700, points: 84753, egp: 847525 }); // 847,525 qirsh = 8,475.25 EGP, each line rounded once
    expect(formFromDoc(doc).lines.map((l) => l.qty)).toEqual(["200", "340", "80", "120"]);
  });
});
