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

/** The contact columns whose empty or invalid value reads «غير متاح» on the screen (like the Excel), and the status columns that can mark each one invalid. */
const CONTACT_CELL_STATUS_KEYS: Record<string, readonly string[]> = {
  phone: ["phone_verification_status"],
  work_email: ["work_email_verification_status", "email_verification_status"],
  email: ["email_verification_status"],
  contact_name: [],
  job_title: ["title_verification_status"],
};

const NO_VALUE_TEXT = /^(?:[-–—]+|n\/?a|null|undefined|غير متاح)$/i;

/**
 * True when a contact cell of the results screen has nothing to show: the value is missing («—», blank), or the source marked it invalid (the
 * same `markedInvalid` rule the company workbook uses). The caller writes «غير متاح» there; other columns (the availability columns, the
 * description, the website) keep their own wording.
 */
export function contactCellUnavailable(column: string, row: Record<string, unknown>): boolean {
  const statusKeys = CONTACT_CELL_STATUS_KEYS[column];
  if (!statusKeys) return false;
  const text = String(row[column] ?? "").replace(/^'+/, "").trim();
  if (!text || NO_VALUE_TEXT.test(text)) return true;
  const statusKey = statusKeys.find((key) => row[key] != null && row[key] !== "");
  return statusKey ? markedInvalid(row[statusKey], true) : false;
}
