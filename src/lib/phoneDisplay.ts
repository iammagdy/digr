import { normalizeDigits } from "./arabicDigits";
import { normalizePhone } from "./multiProvider/policy";

/**
 * ONE way to write a phone number, in the workbook and on the screen: Latin digits, a leading «+» kept («00» is read as «+»), no spaces, dashes, dots or
 * brackets, and the national trunk zero written after a country code («+20 (0)22…») dropped. A value that is not a phone number of 7 to 15 digits is returned
 * cleaned of those separators and otherwise unchanged (nothing is guessed). The cell is read left to right (the screen sets dir="ltr").
 */
export function formatPhoneDisplay(raw: unknown): string {
  const text = String(raw ?? "").replace(/^'+/, "").trim();
  if (!text) return "";
  const latin = normalizeDigits(text);
  return normalizePhone(latin) ?? latin.replace(/[\s().-]+/g, "");
}

/**
 * Digits AFTER the country code that a number of that country normally has (landlines and mobiles together). Only countries whose plan is fixed
 * and well known are listed; a country that is not listed is never judged. No code is the start of another, so the longest-prefix match is exact.
 */
const NATIONAL_LENGTHS: Record<string, readonly [min: number, max: number]> = {
  "20": [8, 10], "966": [8, 9], "971": [8, 9], "965": [8, 8], "974": [8, 8], "973": [8, 8], "968": [8, 8], "962": [8, 9], "961": [7, 8],
  "212": [9, 9], "213": [8, 9], "216": [8, 8], "1": [10, 10], "44": [7, 10], "33": [9, 9], "91": [10, 10], "90": [10, 10],
};

/**
 * True when a phone written with an international prefix has fewer or more digits than the numbering plan of its country code allows, so the
 * source probably cut it («+20 2 5087419»: a Cairo number has 8 digits after the area code 2, this one 7). Nothing is guessed or completed: it only
 * decides whether the screen shows a small note. A number without «+» (its country is unknown), an unlisted country code, a value that is not
 * plain digits (an extension, text) and a national number that starts with a trunk zero are never judged.
 */
export function phoneMayBeIncomplete(raw: unknown): boolean {
  // Letters («ext 5», «داخلي ٣») are digits of an extension that normalizePhone would merge into the number: such a value is not judged.
  if (/\p{L}/u.test(String(raw ?? ""))) return false;
  const text = formatPhoneDisplay(raw);
  if (!/^\+\d+$/.test(text)) return false;
  const digits = text.slice(1);
  const code = [3, 2, 1].map((length) => digits.slice(0, length)).find((candidate) => NATIONAL_LENGTHS[candidate]);
  if (!code) return false;
  const national = digits.slice(code.length);
  if (national.startsWith("0")) return false;
  const [min, max] = NATIONAL_LENGTHS[code];
  if (national.length < min || national.length > max) return true;
  // Egypt: a mobile (starts with 1) has 10 digits and a Cairo or Giza landline (starts with 2) has 9; the other area codes keep the general range.
  if (code === "20") {
    if (national.startsWith("1")) return national.length !== 10;
    if (national.startsWith("2")) return national.length !== 9;
  }
  return false;
}

/** The one wording of the note (the results screen and the workbook cell note). */
export const PHONE_MAY_BE_INCOMPLETE_AR = "رقم قد يكون ناقصًا";
