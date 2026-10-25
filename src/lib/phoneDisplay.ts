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
