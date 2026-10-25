/** Customer-facing verification status for one contact field (work email or phone). */
export const CONTACT_VERIFICATION_LABELS = ["متحقق", "لم يتم التحقق", "يحتاج مراجعة", "غير صالح", "لم يتوفر تأكيد"] as const;

/**
 * Map whatever the source reported about a field into the fixed Arabic status
 * set. A missing value is "غير متاح"; a present value with no report is
 * "لم يتوفر تأكيد" (never "متحقق"), so a verified claim always comes from the source.
 */
export function arabicVerificationStatus(value: unknown, hasValue: boolean): string {
  if (!hasValue) return "غير متاح";
  if ((CONTACT_VERIFICATION_LABELS as readonly string[]).includes(String(value || ""))) return String(value);
  if (value === true) return "متحقق";
  if (value === false) return "لم يتم التحقق";
  const status = String(value || "").trim().toLowerCase();
  if (/^(?:verified|valid|deliverable|confirmed|true|pass)$/i.test(status)) return "متحقق";
  if (/accept[_ -]?all|catch[_ -]?all/i.test(status)) return "يحتاج مراجعة";
  if (/invalid|undeliverable|false|fail|disposable/i.test(status)) return "غير صالح";
  return "لم يتوفر تأكيد";
}

/**
 * True when the SOURCE marked a present field invalid («غير صالح», «invalid», «undeliverable», «disposable»…). A field with no report, one still to
 * review («يحتاج مراجعة», accept-all) and one not yet verified are NOT invalid: only a value known to be wrong is withheld from a delivered file.
 */
export function markedInvalid(statusValue: unknown, hasValue: boolean): boolean {
  return hasValue && arabicVerificationStatus(statusValue, hasValue) === "غير صالح";
}
