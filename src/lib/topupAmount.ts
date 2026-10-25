import { normalizeDigits, toArabicDigits } from "./arabicDigits";
import { TOPUP_MAX_POINTS, TOPUP_MIN_POINTS } from "./topupConfig";

/**
 * The top-up amount, in one place for the screen and the server: points to EGP and back at the credit value of the pricing settings (never a number
 * typed in a component), the checks on an amount, the parsing of what a customer types, and the Arabic texts. The screen only shows; the server decides.
 */
const cents = (value: number) => Math.round(value * 100) / 100;

/** EGP to pay for a number of points, rounded to piastres so 1235 points never reads 123.50000000000001. */
export function pointsToEgp(points: number, creditValue: number): number {
  return cents(Number(points) * Number(creditValue));
}

/** The whole number of points an EGP amount buys. */
export function egpToPoints(egp: number, creditValue: number): number {
  return Math.round(Number(egp) / Number(creditValue));
}

export type TopupAmountProblem = "invalid" | "below_min" | "above_max";

/** The checks on a number of points: a whole number, at least the minimum, at most the maximum. Null when the amount is fine. */
export function validateTopupPoints(points: unknown): TopupAmountProblem | null {
  if (typeof points !== "number" || !Number.isFinite(points) || !Number.isInteger(points) || points <= 0) return "invalid";
  if (points < TOPUP_MIN_POINTS) return "below_min";
  if (points > TOPUP_MAX_POINTS) return "above_max";
  return null;
}

/**
 * The SERVER's check of a submitted EGP amount: it must be a whole number of points at the current credit value, and inside the minimum and maximum.
 * Returns the points the amount buys (the same count the approval gives) or why it was refused.
 */
export function validateSubmittedEgp(amountEgp: unknown, creditValue: number): { ok: true; points: number } | { ok: false; problem: TopupAmountProblem } {
  const egp = Number(amountEgp);
  if (!Number.isFinite(egp) || egp <= 0 || !(creditValue > 0)) return { ok: false, problem: "invalid" };
  const points = egpToPoints(egp, creditValue);
  if (Math.abs(pointsToEgp(points, creditValue) - egp) > 0.005) return { ok: false, problem: "invalid" };
  const problem = validateTopupPoints(points);
  return problem ? { ok: false, problem } : { ok: true, points };
}

/** What a customer typed in the free amount: Arabic-Indic or Latin digits, separators ignored, digits only. Null for an empty or digit-less entry. */
export function parseTopupPointsInput(text: string): number | null {
  // integers only: a decimal mark ends the number («١٫٥» is ١), every other non-digit is ignored
  const whole = normalizeDigits(String(text ?? "")).split(/[.٫]/)[0];
  const digits = whole.replace(/\D/g, "").slice(0, 7);
  return digits ? Number(digits) : null;
}

/** The number shown in the free-amount box: Arabic-Indic digits, no separators. */
export function topupInputText(points: number | null): string {
  return points === null ? "" : toArabicDigits(points);
}

/** The EGP number for the clipboard and for the request: no currency, no separators, Latin digits (what a banking app takes), at most two decimals. */
export function egpClipboardText(egp: number): string {
  return String(cents(egp));
}

/** The EGP amount as a customer reads it: Arabic-Indic digits, a decimal mark only where there is a fraction. */
export function egpDisplayAr(egp: number): string {
  const value = cents(egp);
  return toArabicDigits(Number.isInteger(value) ? String(value) : String(value).replace(".", "٫"));
}

/** «ستحوّل ٢٥٠ جنيهًا»: the exact amount to send. */
export function egpDueAr(egp: number): string {
  const value = cents(egp);
  return `ستحوّل ${egpDisplayAr(value)} ${Number.isInteger(value) && value <= 10 ? "جنيهات" : "جنيهًا"}`;
}

/** The message for an amount that is refused, with the limits written from the same constants (digits as the owner wrote them: no separator). */
export function topupAmountMessageAr(problem: TopupAmountProblem, creditValue: number): string {
  const limit = (points: number) => `${toArabicDigits(points)} نقطة (${egpDisplayAr(pointsToEgp(points, creditValue))} جنيه)`;
  if (problem === "below_min") return `أقل مبلغ للشحن ${limit(TOPUP_MIN_POINTS)}`;
  if (problem === "above_max") return `أقصى مبلغ للشحن ${limit(TOPUP_MAX_POINTS)}`;
  return "اكتب عدد نقاط صحيحًا بالأرقام فقط.";
}
