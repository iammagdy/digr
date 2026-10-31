import { toArabicDigits } from "@/lib/arabicDigits";

/** Digit grouping on a string of digits («١٥٬٠٠٠»), Arabic-Indic. Never goes through Number/locale. */
function group(intText: string): string {
  return toArabicDigits(intText.replace(/\B(?=(\d{3})+(?!\d))/g, "٬"));
}

/**
 * The decimal mark is a plain «.» between Arabic-Indic digits: in the document font the Arabic decimal separator «٫» is drawn like a slash («٤٧/٥٠»),
 * which is a risk on a money column. Thousands use «٬». The digits themselves are always Arabic-Indic.
 */
const DEC = ".";

function splitMinor(value: number, decimals: number): { int: string; frac: string } {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("format_input");
  const text = String(value).padStart(decimals + 1, "0");
  return { int: text.slice(0, text.length - decimals), frac: text.slice(text.length - decimals) };
}

/** USD cents -> «٣٠٫٠٠». */
export function fmtUsd(cents: number): string {
  const { int, frac } = splitMinor(cents, 2);
  return `${group(int)}${DEC}${toArabicDigits(frac)}`;
}
/** qirsh -> «١٬٥٠٠٫٠٠». */
export const fmtEgp = fmtUsd;
/** whole points -> «١٥٬٠٠٠». */
export function fmtPoints(points: number): string {
  if (!Number.isSafeInteger(points) || points < 0) throw new RangeError("format_input");
  return group(String(points));
}
/** whole number (quantity, counts) -> «٢٥٠». */
export const fmtInt = fmtPoints;

/** A unit price in hundredths of a cent, shown in USD: 1200 -> «٠٫١٢», 45 -> «٠٫٠٠٤٥» (two decimals, up to four when the price has fractions of a cent). */
export function fmtUnitUsd(unitCc: number): string {
  const { int, frac } = splitMinor(unitCc, 4);
  const trimmed = frac.replace(/0+$/, "").padEnd(2, "0");
  return `${group(int)}${DEC}${toArabicDigits(trimmed)}`;
}

/** Basis points as a percent: 1000 -> «١٠٪», 1250 -> «١٢٫٥٪». */
export function fmtPercent(bp: number): string {
  const { int, frac } = splitMinor(bp, 2);
  const f = frac.replace(/0+$/, "");
  return `${toArabicDigits(int)}${f ? `${DEC}${toArabicDigits(f)}` : ""}٪`;
}

/** EGP-per-USD rate (x10,000) -> «٥٠٫٧٥». */
export function fmtRate(rateE4: number): string {
  const { int, frac } = splitMinor(rateE4, 4);
  const f = frac.replace(/0+$/, "").padEnd(2, "0");
  return `${group(int)}${DEC}${toArabicDigits(f)}`;
}

/** Point value (EGP x10,000) -> «٠٫١٠». */
export const fmtPointValue = fmtRate;

/** «٣١/١٠/٢٠٢٦» from yyyy-mm-dd (a date, never shifted by a time zone). */
export function fmtDateAr(isoDate: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate ?? ""));
  if (!m) return "";
  return toArabicDigits(`${m[3]}/${m[2]}/${m[1]}`);
}

/** A document number for display: INV-2026-0001 -> «INV-٢٠٢٦-٠٠٠١» (stored as ASCII; only the digits are shown in Arabic-Indic). */
export function fmtNumber(number: string): string {
  return toArabicDigits(number);
}

/** A phone number shown with Arabic-Indic digits (the «+» and separators stay). */
export function fmtPhone(phone: string): string {
  return toArabicDigits(phone);
}

/**
 * Free text (descriptions, names, notes, addresses) with its digits shown Arabic-Indic. A word that holds an «@» or a link (an e-mail, a handle, a URL)
 * is left exactly as typed, because changing its digits would change the address.
 */
export function arabicizeText(text: string): string {
  return String(text ?? "").replace(/\S+/g, (word) => (/@|:\/\/|^www\./i.test(word) ? word : toArabicDigits(word)));
}
