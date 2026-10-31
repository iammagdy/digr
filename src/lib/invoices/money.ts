/**
 * Invoice money: INTEGERS only, no floating point anywhere. The arithmetic runs in BigInt and comes back as a safe integer.
 *
 * Units
 *   unit price      hundredths of a US cent (`unitCc`):  12 cents = 1200,  0.45 cent = 45
 *   line total      US cents:                            round_half_up(quantity x unitCc / 100), ONCE per line
 *   points          whole points
 *   EGP             qirsh (1/100 EGP)
 *   exchange rate   EGP per USD x 10,000 (`rateE4`):     50.75 = 507500
 *   point value     EGP x 10,000 (`creditValueE4`):      0.10 EGP = 1000
 *   percent         basis points:                        10% = 1000
 *
 * Conversion (each currency column is computed from its OWN lines; a total is never converted from another currency's total):
 *   points = round_half_up(cents x rateE4 / (100 x creditValueE4))
 *   qirsh  = round_half_up(cents x rateE4 / 10000)
 * round_half_up(x / d) = floor((2x + d) / 2d) for x >= 0, d > 0: deterministic, exact, ties go up.
 */

export const RATE_MIN_E4 = 10_000;
export const RATE_MAX_E4 = 10_000_000;
export const CREDIT_VALUE_DEFAULT_E4 = 1000;
export const MAX_QUANTITY = 10_000_000;
export const MAX_UNIT_CC = 100_000_000;
/**
 * A line may not exceed $10,000,000.00. With 500 lines, the highest rate (1000 EGP/USD), the lowest point value (0.01 EGP) and a tax of 100%,
 * every subtotal and total is still below 2^53 (about 9.0e15), so no sum can lose precision: see the limits test.
 */
export const MAX_LINE_CENTS = 1_000_000_000;
export const CREDIT_VALUE_MIN_E4 = 100;
export const CREDIT_VALUE_MAX_E4 = 100_000;
export const MAX_LINES = 500;
export const MAX_BATCHES = 50;

// BigInt literals (1n) need an ES2020 target; this project's tsconfig targets lower, so constants are built with BigInt().
const B0 = BigInt(0);
const B2 = BigInt(2);
const B100 = BigInt(100);
const B10000 = BigInt(10000);
const B10 = BigInt(10);

function pow10(scale: number): bigint {
  let r = BigInt(1);
  for (let i = 0; i < scale; i++) r = r * B10;
  return r;
}

function big(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`money_input:${name}`);
  return BigInt(value);
}

/** floor((2n + d) / 2d): n / d rounded half up (n >= 0, d > 0). */
export function roundDiv(n: bigint, d: bigint): bigint {
  if (n < B0 || d <= B0) throw new RangeError("money_roundDiv");
  return (B2 * n + d) / (B2 * d);
}

function out(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("money_overflow");
  return Number(value);
}

/** The line total in cents: round_half_up(quantity x unitCc / 100). Mirrors the generated column in 02_documents.sql. */
export function lineCents(quantity: number, unitCc: number): number {
  return out(roundDiv(big(quantity, "quantity") * big(unitCc, "unitCc"), B100));
}

export function centsToPoints(cents: number, rateE4: number, creditValueE4: number = CREDIT_VALUE_DEFAULT_E4): number {
  return out(roundDiv(big(cents, "cents") * big(rateE4, "rate"), B100 * big(creditValueE4, "creditValue")));
}

export function centsToQirsh(cents: number, rateE4: number): number {
  return out(roundDiv(big(cents, "cents") * big(rateE4, "rate"), B10000));
}

/** The unit price in whole points, for display only (the line total is authoritative). */
export function unitCcToPoints(unitCc: number, rateE4: number, creditValueE4: number = CREDIT_VALUE_DEFAULT_E4): number {
  return out(roundDiv(big(unitCc, "unitCc") * big(rateE4, "rate"), B100 * B100 * big(creditValueE4, "creditValue")));
}

/** The unit price in qirsh, for display only. */
export function unitCcToQirsh(unitCc: number, rateE4: number): number {
  return out(roundDiv(big(unitCc, "unitCc") * big(rateE4, "rate"), B10000 * B100));
}

/** round_half_up(amount x basisPoints / 10000). */
export function percentOf(amount: number, basisPoints: number): number {
  return out(roundDiv(big(amount, "amount") * big(basisPoints, "bp"), B10000));
}

/**
 * Typed text -> integer with `scale` decimals, with no float: «0.45» -> 45 (scale 2), «50.75» -> 507500 (scale 4).
 * Accepts Arabic-Indic / Persian digits, «٫» and «,» as the decimal mark and spaces or «٬» as grouping. Returns null for anything else
 * (negative, more decimals than `scale`, letters, empty) or a value that is not a safe integer.
 */
export function parseScaled(text: string, scale: number): number | null {
  const ascii = String(text ?? "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\s٬ ']/g, "")
    .replace(/[٫,]/g, ".");
  const m = /^(\d{1,15})(?:\.(\d{1,12}))?$/.exec(ascii);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > scale) return null;
  const value = BigInt(m[1]) * pow10(scale) + BigInt(frac.padEnd(scale, "0") || "0");
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

/** The inverse of parseScaled for editing: 45 (scale 2) -> «0.45», 1200 -> «12», 507500 (scale 4) -> «50.75». ASCII digits. */
export function formatScaled(value: number, scale: number): string {
  const v = big(value, "value");
  const unit = pow10(scale);
  const int = v / unit;
  const frac = (v % unit).toString().padStart(scale, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : String(int);
}
