import { describe, expect, it } from "vitest";
import { MAX_LINE_CENTS, RATE_MAX_E4, centsToPoints, centsToQirsh, formatScaled, lineCents, parseScaled, percentOf, roundDiv, unitCcToPoints, unitCcToQirsh } from "../src/lib/invoices/money";
import { computeTotals, lineMoney } from "../src/lib/invoices/totals";
import { fmtEgp, fmtPercent, fmtPoints, fmtRate, fmtUnitUsd, fmtUsd } from "../src/lib/invoices/format";

const NO_TAX = { taxEnabled: false, taxLabel: "ضريبة", taxBp: 0 } as const;
const R50 = 500_000; // 50.00 EGP per USD
const R5075 = 507_500; // 50.75
const V = 1000; // 0.10 EGP per point

describe("rounding: round half up, once per line, integers only", () => {
  it("roundDiv: ties go up, everything else to the nearest, and it never uses a float", () => {
    expect(roundDiv(BigInt(49), BigInt(100))).toBe(BigInt(0));
    expect(roundDiv(BigInt(50), BigInt(100))).toBe(BigInt(1));
    expect(roundDiv(BigInt(149), BigInt(100))).toBe(BigInt(1));
    expect(roundDiv(BigInt(150), BigInt(100))).toBe(BigInt(2));
    expect(() => roundDiv(BigInt(-1), BigInt(100))).toThrow();
  });

  it("matches an independent reference (quotient and remainder) for 20,000 random inputs", () => {
    let seed = 12345;
    const rnd = (max: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % max; };
    for (let i = 0; i < 20_000; i++) {
      const qty = 1 + rnd(10_000_000);
      const unit = rnd(Math.min(100_000_000, Math.floor((MAX_LINE_CENTS * 100) / qty))); // inside the validated range
      const rate = 10_000 + rnd(9_990_000);
      const cents = lineCents(qty, unit);
      const x = BigInt(qty) * BigInt(unit);
      const ref = (num: bigint, den: bigint) => { const q = num / den; const r = num % den; return q + (BigInt(2) * r >= den ? BigInt(1) : BigInt(0)); };
      expect(BigInt(cents)).toBe(ref(x, BigInt(100)));
      // the SQL generated column: truncating division of (q*u + 50) by 100
      expect(BigInt(cents)).toBe((x + BigInt(50)) / BigInt(100));
      expect(BigInt(centsToPoints(cents, rate, V))).toBe(ref(BigInt(cents) * BigInt(rate), BigInt(100) * BigInt(V)));
      expect(BigInt(centsToQirsh(cents, rate))).toBe(ref(BigInt(cents) * BigInt(rate), BigInt(10000)));
      expect(Number.isSafeInteger(cents)).toBe(true);
    }
  });

  it("refuses a float, a negative or an unsafe number", () => {
    expect(() => lineCents(1.5, 100)).toThrow();
    expect(() => lineCents(1, -1)).toThrow();
    expect(() => centsToPoints(Number.MAX_SAFE_INTEGER + 2, R50)).toThrow();
  });
});

describe("limits: no sum can lose precision", () => {
  it("500 lines at the largest allowed line, the highest rate, the lowest point value and a 100% tax stay safe integers and keep the identity", () => {
    const lines = Array.from({ length: 500 }, () => ({ quantity: 1000, unitCc: 100_000_000 }));
    expect(lineCents(1000, 100_000_000)).toBe(MAX_LINE_CENTS);
    const t = computeTotals(lines, { rateE4: RATE_MAX_E4, creditValueE4: 100, discountKind: "none", discountValue: 0, taxEnabled: true, taxLabel: "ضريبة", taxBp: 10000 });
    for (const key of ["usd", "points", "egp"] as const) {
      expect(Number.isSafeInteger(t.total[key]!)).toBe(true);
      expect(t.subtotal[key]! - t.discount[key]! + t.tax[key]!).toBe(t.total[key]);
    }
  });
});

describe("worked example 1: 250 companies x 12 cents at 50.00 EGP/USD", () => {
  it("is 3000 cents = $30.00 = 15,000 points = 1,500.00 EGP", () => {
    const m = lineMoney(250, 1200, R50, V);
    expect(m).toEqual({ usd: 3000, points: 15000, egp: 150000 });
    expect(fmtUsd(m.usd)).toBe("٣٠.٠٠");
    expect(fmtPoints(m.points!)).toBe("١٥٬٠٠٠");
    expect(fmtEgp(m.egp!)).toBe("١٬٥٠٠.٠٠");
  });
});

describe("worked example 2: 50 managers x 35 cents with a 10% discount at 50.00", () => {
  it("USD 1750 - 175 = 1575 cents; points 8750 - 875 = 7875 (the same as 1575 cents x 5)", () => {
    const t = computeTotals([{ quantity: 50, unitCc: 3500 }], { rateE4: R50, creditValueE4: V, discountKind: "percent", discountValue: 1000, ...NO_TAX });
    expect(t.subtotal).toEqual({ usd: 1750, points: 8750, egp: 87500 });
    expect(t.discount).toEqual({ usd: 175, points: 875, egp: 8750 });
    expect(t.total).toEqual({ usd: 1575, points: 7875, egp: 78750 });
    expect(centsToPoints(1575, R50, V)).toBe(7875);
  });
});

describe("worked example 3: both lines on one invoice, 10% off, at 50.75 EGP/USD", () => {
  const t = computeTotals([{ quantity: 250, unitCc: 1200 }, { quantity: 50, unitCc: 3500 }], { rateE4: R5075, creditValueE4: V, discountKind: "percent", discountValue: 1000, ...NO_TAX });
  it("each currency is computed from its own lines", () => {
    expect(t.lines.map((l) => l.points)).toEqual([15225, 8881]); // 8881.25 rounds down
    expect(t.subtotal.usd).toBe(4750);
    expect(t.discount.usd).toBe(475);
    expect(t.total.usd).toBe(4275);
    expect(t.subtotal.points).toBe(24106);
    expect(t.discount.points).toBe(2411); // 2410.6 rounds up
    expect(t.total.points).toBe(21695);
  });
  it("converting the USD total directly would give 21,696: one point away, which is why totals are never converted", () => {
    expect(centsToPoints(4275, R5075, V)).toBe(21696);
    expect(t.total.points).not.toBe(centsToPoints(t.total.usd, R5075, V));
  });
});

describe("worked example 4 (fractions of a cent): 300 e-mails x 0.45 cent", () => {
  it("0.45 cent is stored as 45 hundredths: 300 x 45 / 100 = 135 cents = $1.35", () => {
    expect(parseScaled("0.45", 2)).toBe(45);
    expect(parseScaled("٠٫٤٥", 2)).toBe(45);
    expect(lineCents(300, 45)).toBe(135);
    expect(fmtUnitUsd(45)).toBe("٠.٠٠٤٥");
    expect(fmtUnitUsd(1200)).toBe("٠.١٢");
    expect(fmtUsd(135)).toBe("١.٣٥");
  });
  it("converts at 50.00: 135 cents = 675 points; at 50.75: 685.125 rounds to 685", () => {
    expect(lineMoney(300, 45, R50, V)).toEqual({ usd: 135, points: 675, egp: 6750 });
    expect(lineMoney(300, 45, R5075, V)).toEqual({ usd: 135, points: 685, egp: 6851 }); // 6851.25 qirsh
  });
  it("the whole-line rounding is done once: 3 x 0.45 cent = 1.35 cents -> 1 cent, and a tie goes up (10 x 0.05 cent = 0.5 -> 1)", () => {
    expect(lineCents(3, 45)).toBe(1);
    expect(lineCents(10, 5)).toBe(1);
    expect(lineCents(9, 5)).toBe(0);
  });
  it("a document with 300 e-mails x 0.45 cent and 250 companies x 12 cents, 10% off, at 50.00", () => {
    const t = computeTotals([{ quantity: 300, unitCc: 45 }, { quantity: 250, unitCc: 1200 }], { rateE4: R50, creditValueE4: V, discountKind: "percent", discountValue: 1000, ...NO_TAX });
    expect(t.subtotal).toEqual({ usd: 3135, points: 15675, egp: 156750 });
    expect(t.discount).toEqual({ usd: 314, points: 1568, egp: 15675 }); // 313.5 -> 314, 1567.5 -> 1568, 15675 exact
    expect(t.total).toEqual({ usd: 2821, points: 14107, egp: 141075 });
  });
});

describe("the unit price shown in points or EGP is informational", () => {
  it("rounds the unit once and may differ from line / quantity (the sheet adds a footnote then)", () => {
    expect(unitCcToPoints(45, R50, V)).toBe(2); // 2.25
    expect(unitCcToQirsh(45, R50)).toBe(23); // 22.5 -> 23
    expect(unitCcToPoints(1200, R50, V)).toBe(60);
  });
});

describe("discount, tax and the totals identity", () => {
  const lines = [{ quantity: 7, unitCc: 333 }, { quantity: 11, unitCc: 1750 }, { quantity: 1, unitCc: 99 }];
  it("subtotal - discount + tax = total in every currency, for percent and fixed discounts", () => {
    for (const rate of [R50, R5075, 123_457, 10_000]) {
      for (const pricing of [
        { discountKind: "percent" as const, discountValue: 1250 },
        { discountKind: "amount" as const, discountValue: 321 },
        { discountKind: "none" as const, discountValue: 0 },
      ]) {
        const t = computeTotals(lines, { rateE4: rate, creditValueE4: V, ...pricing, taxEnabled: true, taxLabel: "ضريبة", taxBp: 1400 });
        for (const key of ["usd", "points", "egp"] as const) {
          expect(t.subtotal[key]! - t.discount[key]! + t.tax[key]!).toBe(t.total[key]);
          expect(t.lines.reduce((s, l) => s + l[key]!, 0)).toBe(t.subtotal[key]);
        }
      }
    }
  });
  it("a fixed discount larger than the subtotal is capped (the total is never negative)", () => {
    const t = computeTotals([{ quantity: 1, unitCc: 1000 }], { rateE4: R50, creditValueE4: V, discountKind: "amount", discountValue: 999_999, ...NO_TAX });
    expect(t.total).toEqual({ usd: 0, points: 0, egp: 0 });
  });
  it("tax is off by default and applies to the discounted subtotal", () => {
    const off = computeTotals([{ quantity: 100, unitCc: 1000 }], { rateE4: null, creditValueE4: V, discountKind: "none", discountValue: 0, ...NO_TAX });
    expect(off.tax.usd).toBe(0);
    const on = computeTotals([{ quantity: 100, unitCc: 1000 }], { rateE4: null, creditValueE4: V, discountKind: "percent", discountValue: 1000, taxEnabled: true, taxLabel: "ضريبة", taxBp: 1400 });
    expect(on.subtotal.usd).toBe(1000);
    expect(on.discount.usd).toBe(100);
    expect(on.tax.usd).toBe(126); // 14% of 900
    expect(on.total.usd).toBe(1026);
  });
  it("with no rate, points and EGP are null (never guessed)", () => {
    const t = computeTotals([{ quantity: 2, unitCc: 500 }], { rateE4: null, creditValueE4: V, discountKind: "none", discountValue: 0, ...NO_TAX });
    expect(t.total).toEqual({ usd: 10, points: null, egp: null });
  });
  it("percentOf rounds half up", () => {
    expect(percentOf(5, 1000)).toBe(1); // 0.5 -> 1
    expect(percentOf(4, 1000)).toBe(0);
  });
});

describe("typed numbers become integers without a float", () => {
  it("parseScaled: decimals, Arabic digits, separators, and refusals", () => {
    expect(parseScaled("50.75", 4)).toBe(507500);
    expect(parseScaled("٥٠٫٧٥", 4)).toBe(507500);
    expect(parseScaled("1,200", 2)).toBeNull(); // «,» is a decimal mark, so «1,200» has 3 decimals: refused, never guessed as a thousand
    expect(parseScaled("12", 2)).toBe(1200);
    expect(parseScaled("0.455", 2)).toBeNull();
    expect(parseScaled("-1", 2)).toBeNull();
    expect(parseScaled("abc", 2)).toBeNull();
    expect(parseScaled("", 2)).toBeNull();
    expect(parseScaled("9".repeat(16), 2)).toBeNull();
  });
  it("formatScaled is the inverse", () => {
    for (const v of [0, 1, 45, 100, 1200, 507500]) expect(parseScaled(formatScaled(v, v === 507500 ? 4 : 2), v === 507500 ? 4 : 2)).toBe(v);
    expect(formatScaled(45, 2)).toBe("0.45");
    expect(formatScaled(1200, 2)).toBe("12");
  });
  it("display helpers", () => {
    expect(fmtRate(507500)).toBe("٥٠.٧٥");
    expect(fmtPercent(1250)).toBe("١٢.٥٪");
    expect(fmtPercent(1000)).toBe("١٠٪");
  });
});
