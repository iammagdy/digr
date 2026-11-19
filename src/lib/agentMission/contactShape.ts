/**
 * THE ONE SYNTACTIC RULE for «this cell holds a contact value» (DT-20261119-06 PART B, Megz D-0117/D-0126). It is the SHAPE of an address or a phone number, never a word list and never a verification verdict. The same function decides
 *  - at ingest (agent/src/items/ingest.ts), BEFORE a native phone/e-mail cell is normalised: a date, a labelled id or any text that is not a phone is not turned into a «phone» by digit-stripping;
 *  - at settlement (billableRows.ts): whether a delivered person carries a contact the customer asked for.
 * A phone is digits with only the separators a phone is written with: a leading «+» or «(», then digits, spaces and «().-», 7 to 15 digits, and not a date or a decimal (2021-03-12, 12/03/2021, 3.14, 10.0.0.1). A label, a word or a masked value («*») is not a phone.
 * Plain digits in a phone COLUMN are a phone by that column's own provenance (local, international, office and fax numbers all count).
 */
const DATE_OR_DECIMAL = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$|^\d+[.]\d+$|^(?:\d{1,3}[.]){3}\d{1,3}$/;

export function phoneShape(raw: unknown, minimumDigits = 7): boolean {
  const t = String(raw ?? "").trim().replace(/^tel:/i, "");
  const digits = t.replace(/\D/g, "");
  return /^[+\d(][\d\s().-]*$/.test(t) && !DATE_OR_DECIMAL.test(t) && digits.length >= minimumDigits && digits.length <= 15;
}

/** An address and nothing else: one «@», a dot in the domain, no spaces and no mask. */
export function emailShape(raw: unknown): boolean {
  return /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(String(raw ?? "").trim());
}

export type ContactShapeKind = "email" | "phone";
export const contactShape = (kind: ContactShapeKind, raw: unknown): boolean => (kind === "email" ? emailShape(raw) : phoneShape(raw));
