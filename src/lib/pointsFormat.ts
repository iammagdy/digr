import { formatAr } from "./arabicDigits";
import { pointsDisplay, pricePer100Points } from "./recordPricing";

/** A unit price in points for the customer: Arabic-Indic digits, at most two decimals and only where there are any (٠٫١٢، ٣٫١٧، ١٢). */
export function formatPointsAr(points: number): string {
  return formatAr(Number(pointsDisplay(points)));
}

/**
 * The unit price as a person reads it. A fractional unit price (0.11715 points a record) is never shown rounded to a record: it is shown as the
 * price of 100 records (the total charged for n records is ceil(n x the real unit price), so a rounded unit price would drift from it by up to
 * 2% at 1,000 records). A whole-point price keeps the plain per-record wording.
 */
export function unitPriceLabelAr(unitPoints: number, unitLabelAr: string = "سجل"): string {
  if (Number.isInteger(Number(unitPoints))) return `${formatPointsAr(unitPoints)} نقطة لكل ${unitLabelAr}`;
  return `حوالي ${formatAr(pricePer100Points(unitPoints))} نقطة لكل ١٠٠ ${unitLabelAr}`;
}

/** The same price in EGP (1 point = 0.10 EGP), per 100 records when fractional. */
export function unitPriceEgpLabelAr(unitPoints: number, unitLabelAr: string = "سجل"): string {
  if (Number.isInteger(Number(unitPoints))) return `${formatAr(Number((Number(unitPoints) / 10).toFixed(4)))} ج.م لكل ${unitLabelAr}`;
  return `${formatAr(Number((pricePer100Points(unitPoints) / 10).toFixed(4)))} ج.م لكل ١٠٠ ${unitLabelAr}`;
}

/**
 * A count of points with its right Arabic word: 1 «نقطة واحدة», 2 «نقطتان», 3 to 10 «٥ نقاط», 11 and more «١٢ نقطة». The digits are
 * Arabic-Indic: written by `format` (each place keeps the way it already wrote its numbers, with or without the thousands mark;
 * the default is the grouped one). A figure with decimals keeps «نقطة» after it.
 */
export function pointsAr(points: number, format?: (value: number) => string): string {
  const value = Number(points);
  const digits = format ?? ((n: number) => formatAr(n));
  if (!Number.isFinite(value)) return `${digits(0)} نقطة`;
  if (!Number.isInteger(value)) return `${format ? format(value) : formatPointsAr(value)} نقطة`;
  const count = Math.abs(value);
  if (value > 0 && count === 1) return "نقطة واحدة";
  if (value > 0 && count === 2) return "نقطتان";
  return `${digits(value)} ${count >= 3 && count <= 10 ? "نقاط" : "نقطة"}`;
}
