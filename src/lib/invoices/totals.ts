import { centsToPoints, centsToQirsh, lineCents, percentOf } from "./money";
import type { DocView, Money, PricingInput, Totals } from "./types";

const ZERO: Money = { usd: 0, points: 0, egp: 0 };

export function addMoney(a: Money, b: Money): Money {
  return { usd: a.usd + b.usd, points: a.points === null || b.points === null ? null : a.points + b.points, egp: a.egp === null || b.egp === null ? null : a.egp + b.egp };
}
export function subMoney(a: Money, b: Money): Money {
  return { usd: a.usd - b.usd, points: a.points === null || b.points === null ? null : a.points - b.points, egp: a.egp === null || b.egp === null ? null : a.egp - b.egp };
}
const nullIfNoRate = (m: Money, rate: number | null): Money => (rate === null ? { usd: m.usd, points: null, egp: null } : m);

/** One line in the three currencies: USD cents once per line, then points and qirsh once per line from those cents. */
export function lineMoney(quantity: number, unitCc: number, rateE4: number | null, creditValueE4: number): Money {
  const usd = lineCents(quantity, unitCc);
  return rateE4 === null ? { usd, points: null, egp: null } : { usd, points: centsToPoints(usd, rateE4, creditValueE4), egp: centsToQirsh(usd, rateE4) };
}

/** Converts a fixed discount (USD cents) once per currency. */
function fixedDiscount(cents: number, rateE4: number | null, creditValueE4: number): Money {
  return rateE4 === null ? { usd: cents, points: null, egp: null } : { usd: cents, points: centsToPoints(cents, rateE4, creditValueE4), egp: centsToQirsh(cents, rateE4) };
}

/**
 * Every total of a document, each currency computed from its own lines (never converted from another currency's total):
 * subtotal = sum of the rounded lines (hidden lines included), discount (percent or fixed, capped at the subtotal), tax on (subtotal - discount), total.
 */
export function computeTotals(lines: Array<{ quantity: number; unitCc: number }>, pricing: PricingInput): Totals {
  const per = lines.map((l) => lineMoney(l.quantity, l.unitCc, pricing.rateE4, pricing.creditValueE4));
  return finishTotals(per, nullIfNoRate(per.reduce<Money>((sum, m) => addMoney(sum, m), ZERO), pricing.rateE4), pricing);
}

/**
 * Everything after the lines: discount, tax and total from an already summed subtotal. Split out so a caller that changes ONE line (the agent's «target total»
 * search) can re-derive the grand total from the new subtotal without re-pricing every line; `computeTotals` itself is unchanged.
 */
export function finishTotals(per: Money[], subtotal: Money, pricing: PricingInput): Totals {
  let discount: Money;
  if (pricing.discountKind === "percent") {
    discount = {
      usd: percentOf(subtotal.usd, pricing.discountValue),
      points: subtotal.points === null ? null : percentOf(subtotal.points, pricing.discountValue),
      egp: subtotal.egp === null ? null : percentOf(subtotal.egp, pricing.discountValue),
    };
  } else if (pricing.discountKind === "amount") {
    const fixed = fixedDiscount(pricing.discountValue, pricing.rateE4, pricing.creditValueE4);
    discount = {
      usd: Math.min(fixed.usd, subtotal.usd),
      points: fixed.points === null || subtotal.points === null ? null : Math.min(fixed.points, subtotal.points),
      egp: fixed.egp === null || subtotal.egp === null ? null : Math.min(fixed.egp, subtotal.egp),
    };
  } else {
    discount = nullIfNoRate(ZERO, pricing.rateE4);
  }
  const afterDiscount = subMoney(subtotal, discount);
  const tax: Money = pricing.taxEnabled
    ? {
        usd: percentOf(afterDiscount.usd, pricing.taxBp),
        points: afterDiscount.points === null ? null : percentOf(afterDiscount.points, pricing.taxBp),
        egp: afterDiscount.egp === null ? null : percentOf(afterDiscount.egp, pricing.taxBp),
      }
    : nullIfNoRate(ZERO, pricing.rateE4);
  return { lines: per, subtotal, discount, afterDiscount, tax, total: addMoney(afterDiscount, tax) };
}

/** What the database freezes at issue (same field names as the columns). */
export function toFrozenPayload(lineIds: string[], totals: Totals): { lines: Array<{ id: string; points: number | null; egp: number | null }>; totals: Record<string, number | null> } {
  return {
    lines: lineIds.map((id, i) => ({ id, points: totals.lines[i].points, egp: totals.lines[i].egp })),
    totals: {
      subtotal_usd_cents: totals.subtotal.usd, discount_usd_cents: totals.discount.usd, tax_usd_cents: totals.tax.usd, total_usd_cents: totals.total.usd,
      subtotal_points: totals.subtotal.points, discount_points: totals.discount.points, tax_points: totals.tax.points, total_points: totals.total.points,
      subtotal_egp_qirsh: totals.subtotal.egp, discount_egp_qirsh: totals.discount.egp, tax_egp_qirsh: totals.tax.egp, total_egp_qirsh: totals.total.egp,
    },
  };
}

/**
 * The totals to PRINT. An issued document prints the numbers frozen when it was issued (a later change of any code or rate can never alter it);
 * a draft is computed live from its lines.
 */
export function totalsForDoc(doc: DocView): Totals {
  if (doc.status !== "draft" && doc.frozen) return doc.frozen;
  return computeTotals(doc.lines, doc);
}
