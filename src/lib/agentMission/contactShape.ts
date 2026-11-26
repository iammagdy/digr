import { normalizeDigits } from "../arabicDigits";

/**
 * THE ONE SYNTACTIC RULE for «this cell holds a contact value» (DT-20261119-06 PART B, Megz D-0117/D-0126). It is the SHAPE of an address or a phone number, never a word list and never a verification verdict. The same function decides
 *  - at ingest (agent/src/items/ingest.ts), BEFORE a native phone/e-mail cell is normalised: a date, a labelled id or any text that is not a phone is not turned into a «phone» by digit-stripping;
 *  - at settlement (billableRows.ts): whether a delivered person carries a contact the customer asked for.
 * A phone is digits with only the separators a phone is written with: a leading «+» or «(», then digits, spaces and «().-», 7 to 15 digits, and not a date (2021-03-12, 2021 - 03 - 12, 12/03/2021), a decimal (3.14, +3.14159265), an address (10.0.0.1) or a placeholder (0000000000, one digit repeated). A label, a word or a masked value («*») is not a phone.
 * Plain digits in a phone COLUMN are a phone by that column's own provenance (local, international, office and fax numbers all count).
 */
// A DATE, with or without spaces around its separators. YEAR FIRST: a 19xx/20xx year, then a 1-2 digit month and a 1-2 digit day (2021-03-12, 2021 - 03 - 12, 2024.5.7) is date-shaped EVEN WHEN the month or day is out of range (2021-13-45 is a malformed date, never a phone: Gate 2 r3).
// DAY FIRST (or month first): a day and a month in range (1-31) and a 4-digit year (12/03/2021, 12 - 05 - 2024); the ranges keep a phone written in groups («010-12-3456», «55-77-2024») from being taken for a date.
const SEP = "\\s*[-/.]\\s*";
const DAY = "(?:0?[1-9]|[12]\\d|3[01])";
const DATE = new RegExp(`^(?:(?:19|20)\\d{2}${SEP}\\d{1,2}${SEP}\\d{1,2}|${DAY}${SEP}${DAY}${SEP}(?:19|20)\\d{2})$`);
// A DECIMAL NUMBER, signed or not («3.14159265», «+3.14159265»), or a dotted-quad id (10.0.0.1). The one exception is the international «+CC.number» form with a real country code (+1 or +7, or 2 to 3 digits: «+44.2071234567»): «+3.14159265» has no country code «3».
const DECIMAL = /^[+-]?\d+[.]\d+$|^(?:\d{1,3}[.]){3}\d{1,3}$/;
const COUNTRY_DOT = /^\+(?:1|7|[1-9]\d{1,2})[.]\d+$/;
// A PLACEHOLDER: one digit repeated (0000000000, 000-000-0000, +0 000 000 0000): the same rule the number normaliser applies (multiProvider/policy.ts normalizePhone).
const REPEATED_DIGIT = /^(\d)\1+$/;

export function phoneShape(raw: unknown, minimumDigits = 7): boolean {
  // Arabic-Indic (٠-٩) and Persian (۰-۹) digits are converted to ASCII first so every syntactic rule judges them identically to Latin digits.
  const t = normalizeDigits(String(raw ?? "")).trim().replace(/^tel:/i, "");
  const digits = t.replace(/\D/g, "");
  if (!/^[+\d(][\d\s().-]*$/.test(t) || digits.length < minimumDigits || digits.length > 15) return false;
  if (DATE.test(t) || REPEATED_DIGIT.test(digits)) return false;
  return !DECIMAL.test(t) || COUNTRY_DOT.test(t);
}

/** An address and nothing else: one «@», a dot in the domain, no spaces and no mask. */
export function emailShape(raw: unknown): boolean {
  return /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(String(raw ?? "").trim());
}

export type ContactShapeKind = "email" | "phone";
export const contactShape = (kind: ContactShapeKind, raw: unknown): boolean => (kind === "email" ? emailShape(raw) : phoneShape(raw));
