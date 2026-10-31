import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyForm, emptyLine, formToInput, formToPreview, rateSanityWarning, showRateBox, unitErrors, type DocForm } from "../src/lib/invoices/form";
import { lineCents, parseScaled } from "../src/lib/invoices/money";
import { parseUnitPoints, parseUnitUsd, unitPointsText, unitUsdText } from "../src/lib/invoices/priceInput";
import { computeTotals } from "../src/lib/invoices/totals";

/**
 * Bugs the owner hit LIVE (INVOICE AGENT 1, part A). Each test below was written before the fix and failed first.
 *   1. the exchange rate: the builder's rate box disappeared after the FIRST typed digit and showed «٥.٠٠» (50 typed as «5»)
 *   2. a price with more than 2 decimals of a cent became 0 silently
 *   3. the price unit was cents («٠.٢٨» meant 28 cents, but he meant 28 cents as dollars 0.28): USD or points per item, one toggle, no «سنت»
 */
const builder = readFileSync("src/components/admin/invoices/InvoiceBuilder.tsx", "utf8");
const typesPanel = readFileSync("src/components/admin/invoices/ItemTypesPanel.tsx", "utf8");
const B = (n: number) => BigInt(n);

const base = (over: Partial<DocForm> = {}): DocForm => ({ ...emptyForm("invoice", "2026-10-31", { rateE4: null, payment: "" }), showUsd: false, showPoints: true, ...over });
const withLine = (unit: string, qty = "10", f: Partial<DocForm> = {}): DocForm => ({ ...base(f), lines: [{ ...emptyLine(null), itemTypeName: "شركة", qty, unit }] });

describe("bug 1: the rate box stays while the owner types, and the number read is the number typed", () => {
  const sequences: Array<[string, number]> = [["50", 500000], ["٥٠", 500000], ["56.5", 565000], ["٥٦٫٥", 565000]];
  for (const [typed, expected] of sequences) {
    it(`typing «${typed}» key by key: the box is there after every key, and the end result is ${expected}`, () => {
      for (let i = 1; i <= typed.length; i++) {
        const prefix = typed.slice(0, i);
        expect(showRateBox(base({ rate: prefix })), `after «${prefix}»`).toBe(true);
      }
      expect(parseScaled(typed, 4)).toBe(expected);
      const preview = formToPreview(base({ rate: typed }), { id: null, number: "", status: "draft", revision: 1, instapayAddress: "" });
      expect(preview.rateE4).toBe(expected);
    });
  }

  it("the box shows whenever points or EGP are on (even when a rate is already saved), and never on a data statement or with the dollar only", () => {
    expect(showRateBox(base({ rate: "" }))).toBe(true);
    expect(showRateBox(base({ rate: "50" }))).toBe(true);
    expect(showRateBox(base({ rate: "50", showPoints: false, showEgp: true }))).toBe(true);
    expect(showRateBox(base({ rate: "50", showPoints: false, showEgp: false, showUsd: true }))).toBe(false);
    expect(showRateBox(base({ rate: "50", docType: "statement" }))).toBe(false);
  });

  it("the builder no longer hides the rate input behind «the rate is empty»", () => {
    const at = builder.indexOf('data-testid="rate"');
    expect(at).toBeGreaterThan(0);
    expect(builder.slice(Math.max(0, at - 700), at)).toContain("showRateBox(form)");
    expect(builder).not.toMatch(/form\.rate\.trim\(\) === ""\) \? \(\s*<Field/);
    expect(builder).not.toContain('data-testid="rate-doc"'); // one rate box, not two
  });

  it("a rate that looks like a typo gets a visible hint: «٥» when ٥٠ was meant is caught; ٥٠ and ٥٦.٥ are not", () => {
    expect(rateSanityWarning("5")).toMatch(/٥/);
    expect(rateSanityWarning("5")).toContain("٥٠");
    expect(rateSanityWarning("500")).not.toBeNull();
    for (const ok of ["50", "٥٠", "56.5", "٥٦٫٥", "47.25", ""]) expect(rateSanityWarning(ok), ok).toBeNull();
    expect(rateSanityWarning("abc")).toBeNull(); // an unreadable rate has its own message
  });
});

describe("bug 2: a price never silently becomes 0", () => {
  it("٠.٠٢٩ dollars is 2.9 cents = 290 hundredths of a cent: read exactly", () => {
    expect(parseUnitUsd("٠.٠٢٩")).toEqual({ ok: true, cc: 290 });
    expect(lineCents(1000, 290)).toBe(2900);
  });

  it("a price with more than 4 decimals (finer than a hundredth of a cent) is an error, not 0", () => {
    const r = parseUnitUsd("0.00029");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain("٤ منازل"); expect(r.error).toContain("٠.٠٠٠١"); }
  });

  it("empty, letters, negative and absurdly large prices are errors with a plain Arabic sentence", () => {
    for (const bad of ["", "abc", "-1", "1e5", "٠.٠٠٠٠٠٠٠٠٠٠٠٠٠١"]) {
      const r = parseUnitUsd(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error, bad).toMatch(/[؀-ۿ]/);
    }
    const huge = parseUnitUsd("20000");
    expect(huge.ok).toBe(false);
  });

  it("the form blocks the save/send with the line number, and the field gets its own error", () => {
    const f = withLine("0.00029");
    const r = formToInput(f);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain("البند ١"); expect(r.error).toContain("٤ منازل"); }
    const errs = unitErrors(f);
    expect(Object.keys(errs)).toEqual([f.lines[0].key]);
    expect(errs[f.lines[0].key]).toContain("٤ منازل");
    expect(unitErrors(withLine("0.029"))).toEqual({});
  });

  it("the live preview shows 0 for an unreadable price only while the error is shown next to it (it is never the only signal)", () => {
    const f = withLine("0.00029");
    const preview = formToPreview(f, { id: null, number: "", status: "draft", revision: 1, instapayAddress: "" });
    expect(preview.lines[0].unitCc).toBe(0);
    expect(Object.keys(unitErrors(f)).length).toBe(1);
  });

  it("the builder shows the error in red under the price box and «إرسال» goes through the strict conversion", () => {
    expect(builder).toMatch(/data-testid=\{`price-error-/);
    expect(builder).toContain("unitErrors(");
    expect(builder).toMatch(/const askSend = \(\) => \{\s*const r = formToInput\(form\);/);
  });
});

describe("bug 3: the owner types a price in dollars (default) or in points per item; «سنت» is no longer an input unit", () => {
  it("٠.٢٨ means 28 cents (0.28 USD): 2800 hundredths, a line of 1 is 28 cents", () => {
    expect(parseUnitUsd("٠.٢٨")).toEqual({ ok: true, cc: 2800 });
    expect(lineCents(1, 2800)).toBe(28);
    expect(unitUsdText(2800)).toBe("0.28");
    expect(unitUsdText(1200)).toBe("0.12");
    expect(unitUsdText(45)).toBe("0.0045");
  });

  it("points per item are converted with the document rate and the point value, then rounded half up to one hundredth of a cent", () => {
    // R = 50.00 EGP/USD, 1 point = 0.10 EGP: 60 points = 6.00 EGP = 0.12 USD = 1200
    expect(parseUnitPoints("60", 500000, 1000)).toEqual({ ok: true, cc: 1200 });
    expect(parseUnitPoints("٢.٢٥", 500000, 1000)).toEqual({ ok: true, cc: 45 }); // 0.45 cent
    expect(parseUnitPoints("175", 500000, 1000)).toEqual({ ok: true, cc: 3500 });
    // 0.03 point at R = 50: 0.6 of a unit -> 1 (up);  a tie goes UP: 0.01 point at R = 20: exactly 0.5 -> 1
    expect(parseUnitPoints("0.03", 500000, 1000)).toEqual({ ok: true, cc: 1 });
    expect(parseUnitPoints("0.01", 200000, 1000)).toEqual({ ok: true, cc: 1 });
    // a different rate changes the conversion (the document's rate is the one used)
    expect(parseUnitPoints("60", 565000, 1000)).toEqual({ ok: true, cc: 1062 }); // 6/56.5 = 0.106194 USD
  });

  it("a points price that rounds to 0 is an error (never a silent 0); more than 2 decimals of a point and a missing rate are errors", () => {
    const tiny = parseUnitPoints("0.02", 500000, 1000); // 0.4 of a unit
    expect(tiny.ok).toBe(false);
    if (!tiny.ok) expect(tiny.error).toContain("٠.٠٠٠١");
    const many = parseUnitPoints("1.234", 500000, 1000);
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.error).toContain("منزلتين");
    const noRate = parseUnitPoints("60", null, 1000);
    expect(noRate.ok).toBe(false);
    if (!noRate.ok) expect(noRate.error).toContain("سعر الصرف");
    expect(parseUnitPoints("0", 500000, 1000)).toEqual({ ok: true, cc: 0 }); // an explicit zero is allowed (the zero-price warning handles it)
  });

  it("the stored value is within half a step of the exact conversion for any typed points value (random, exact BigInt check)", () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 400; i++) {
      const rate = 100_000 + rnd(900_000); // 10.00 .. 100.00
      const value = [1000, 500, 2000, 100][rnd(4)];
      const pointsScaled = 1 + rnd(5_000_000); // up to 50,000.00 points
      const text = `${Math.floor(pointsScaled / 100)}.${String(pointsScaled % 100).padStart(2, "0")}`;
      const r = parseUnitPoints(text, rate, value);
      if (!r.ok) continue; // too small -> error, covered above
      const exactNum = B(pointsScaled) * B(value) * B(100), den = B(rate);
      const diff = B(r.cc) * den - exactNum;
      expect((diff < BigInt(0) ? -diff : diff) * B(2) <= den, `${text} @${rate}/${value}`).toBe(true);
    }
  });

  it("the points shown for a stored price are the same conversion backwards, two decimals, trailing zeros trimmed", () => {
    expect(unitPointsText(1200, 500000, 1000)).toBe("60");
    expect(unitPointsText(45, 500000, 1000)).toBe("2.25");
    expect(unitPointsText(3500, 500000, 1000)).toBe("175");
    expect(unitPointsText(1200, null, 1000)).toBe("");
  });

  it("the totals still come from the one money library: 250 companies at 0.12 USD = 3000 cents = 15,000 points at R = 50", () => {
    const t = computeTotals([{ quantity: 250, unitCc: (parseUnitUsd("0.12") as { cc: number }).cc }], { rateE4: 500000, creditValueE4: 1000, discountKind: "none", discountValue: 0, taxEnabled: false, taxLabel: "ضريبة", taxBp: 0 });
    expect(t.total.usd).toBe(3000);
    expect(t.total.points).toBe(15000);
  });

  it("the builder has ONE unit toggle defaulting to dollars, shows the unit next to every price box, and has no «سنت» input anywhere", () => {
    expect(builder).toMatch(/useState<PriceUnit>\("usd"\)/);
    expect(builder.match(/data-testid="price-unit-toggle"/g)).toHaveLength(1);
    expect(builder).toMatch(/data-testid=\{`price-unit-/);
    for (const [name, src] of [["builder", builder], ["types panel", typesPanel]] as const) {
      expect(src, name).not.toMatch(/بالسنت|\(سنت\)|>سنت<|سنت\}/);
    }
    expect(typesPanel).toContain("دولار");
    expect(typesPanel).toContain("parseUnitUsd");
  });

  it("switching the unit while a price is in error is refused with that error (it would hide the error and leave a stale number)", () => {
    const at = builder.indexOf("const switchPriceUnit");
    expect(at).toBeGreaterThan(0);
    const body = builder.slice(at, at + 600);
    expect(body).toContain("firstPriceError()");
    expect(body.indexOf("firstPriceError()")).toBeLessThan(body.indexOf("setPriceUnit(u)"));
  });

  it("an existing document's stored prices read back unchanged (the unit of the TEXT changed, the stored number did not)", () => {
    // 12 cents was stored as 1200 and still is; the text for editing is now dollars
    const f = withLine(unitUsdText(1200), "250", { rate: "50" });
    const r = formToInput(f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.lines[0].unitCc).toBe(1200);
  });
});
