import { effectiveJobPointsCap } from "../../lib/jobPointsCap";
import { markedInvalid } from "../../lib/contactVerification";
export type ContactField = "work_email" | "phone";
export interface ContactUnitPricesPoints {
  basePerson: number;
  workEmail: number;
  phone: number;
}

/** Customer prices for the decision-maker capability, in points per delivered unit.
 * Keep these prices independent from the lower-cost email/phone lookup routes.
 */
export const DECISION_MAKER_UNIT_PRICES_POINTS: Readonly<ContactUnitPricesPoints> = Object.freeze({
  basePerson: 83,
  workEmail: 55,
  phone: 55,
});

/**
 * True when the row carries a usable value for the field. A value the SOURCE marked invalid is shown as «غير متاح» in the delivered file
 * (see fileGenerators), so it is not delivered and not charged either; a value with no report, or one still to review, is delivered.
 */
export function contactValueDelivered(row: Record<string, unknown>, field: ContactField): boolean {
  if (field === "work_email") {
    const present = Boolean(String(row.work_email ?? "").trim());
    return present && !markedInvalid(row.work_email_verification_status ?? row.email_verification_status, present);
  }
  const present = Boolean(String(row.phone ?? "").trim());
  return present && !markedInvalid(row.phone_verification_status, present);
}

export function decisionMakerDeliveredUnits(rows: Record<string, unknown>[], requestedFields: ContactField[]) {
  const requested = new Set(requestedFields);
  let baseUnits = 0;
  let emailUnits = 0;
  let phoneUnits = 0;
  for (const row of rows) {
    const hasEmail = requested.has("work_email") && contactValueDelivered(row, "work_email");
    const hasPhone = requested.has("phone") && contactValueDelivered(row, "phone");
    if (hasEmail || hasPhone) baseUnits += 1;
    if (hasEmail) emailUnits += 1;
    if (hasPhone) phoneUnits += 1;
  }
  return { baseUnits, emailUnits, phoneUnits };
}

export function markContactRowsForReview(
  rows: Record<string, any>[],
  requestedFields: ContactField[],
): Record<string, any>[] {
  return rows.map((row) => {
    const missing = requestedFields.filter((field) => !contactValueDelivered(row, field));
    return {
      ...row,
      contact_review_status: missing.length
        ? `مراجعة: لم يتوفر ${missing.map((field) => field === "work_email" ? "بريد مهني" : "رقم هاتف مهني").join(" و")}`
        : "مكتمل حسب الحقول المطلوبة",
    };
  });
}

export function decisionMakerChargePoints(
  units: { baseUnits: number; emailUnits: number; phoneUnits: number },
  prices: ContactUnitPricesPoints,
  cap = effectiveJobPointsCap(),
): number {
  const raw = units.baseUnits * prices.basePerson +
    units.emailUnits * prices.workEmail + units.phoneUnits * prices.phone;
  return Math.min(Math.ceil(raw), cap);
}

export function decisionMakerQuotePoints(
  volume: number,
  requestedFields: ContactField[],
  prices: ContactUnitPricesPoints,
  safetyBuffer = 0.15,
  cap = effectiveJobPointsCap(),
): number {
  const perPerson = prices.basePerson +
    (requestedFields.includes("work_email") ? prices.workEmail : 0) +
    (requestedFields.includes("phone") ? prices.phone : 0);
  return Math.min(Math.ceil(volume * perPerson * (1 + safetyBuffer)), cap);
}
