import { normalizeDigits, toArabicDigits } from "./arabicDigits";

/**
 * ROUND 27 (item 2): the number fields of the customer chat SHOW Arabic-Indic digits (٠١٢…) whatever the keyboard types (Latin, Arabic-Indic or Persian),
 * and the number that is SENT is a normal number. Display only: nothing here prices or limits anything.
 */
export const displayDigitsAr = (raw: string): string => toArabicDigits(normalizeDigits(String(raw ?? "")));

/** The whole number the field holds (every digit kind accepted), or null when it holds no digit. */
export function countInputValue(raw: string): number | null {
  const digits = normalizeDigits(String(raw ?? "")).replace(/[^\d]/g, "");
  return digits === "" ? null : Number(digits);
}
