import { describe, expect, it } from "vitest";
import { normalizeDigits, normalizePhone as normalizeForArabic } from "../src/lib/arabicDigits";
import { normalizePhone as normalizeFromPages } from "../src/lib/multiProvider/policy";

/**
 * A phone number is cleaned, never shortened: every digit the source wrote is still there, in order, after either normaliser. Evidence (the owner's live check):
 * two rows showed +20225087419 and +2025087419. Both normalisers keep every digit of each form tested here; a missing digit has to come from the source text. The bracketed trunk zero («+20 (0)22…») is not in this list: it is dropped on purpose and tested in phone-trunk-zero.test.ts.
 */
const isSubsequence = (small: string, big: string) => { let i = 0; for (const ch of big) if (ch === small[i]) i += 1; return i === small.length; };
const digitsOf = (text: string) => normalizeDigits(text).replace(/\D/g, "");

describe("no digit of a phone number is dropped by the normalisers", () => {
  const forms = ["+20225087419", "+20 22 5087419", "+20-22-508-7419", "+2025087419", "+20 2 5087419", "00 20 22 508 7419", "٠٢٠٢٢٥٠٨٧٤١٩", "+٢٠ ٢٢ ٥٠٨٧٤١٩", "+۲۰۲۲۵۰۸۷۴۱۹", "022 508 7419", "(022) 5087419"];
  for (const form of forms) {
    it(`«${form}» keeps every digit (arabic-digits normaliser and page normaliser)`, () => {
      // a leading 00 is the international prefix: both normalisers write it as «+», so it is not a digit of the number
      const source = digitsOf(form.replace(/^\s*00/, "+"));
      for (const out of [normalizeForArabic(form), normalizeFromPages(form)]) {
        if (out === null) continue; // the page normaliser refuses a number of the wrong length, it does not shorten it
        expect(isSubsequence(source, digitsOf(out))).toBe(true);
      }
    });
  }
});
