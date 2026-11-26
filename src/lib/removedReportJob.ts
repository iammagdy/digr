/**
 * A SAVED JOB RESULT FROM THE REMOVED «FACEBOOK TOPIC REPORT» (DT-20261126-wl4-ph1b, D-0232 K1).
 * The report was never offered to a customer and its code is gone. If saved data of such a job ever turns up, the file routes that would have to
 * REBUILD a file from it answer honestly and early (410, before anything is built, saved or charged) instead of producing a wrong file or a 500.
 * This is a check of ONE data key the old feature wrote; it never reads or classifies a customer's request.
 */
export const REMOVED_REPORT_STATUS = 410;
export const REMOVED_REPORT_ERROR_AR = "تقرير فيسبوك عن موضوع لم يعد متاحًا بعد إيقاف هذه الخدمة، ولا يمكن تجهيز ملفاته.";
export const REMOVED_REPORT_NO_CHARGE_ERROR_AR = `${REMOVED_REPORT_ERROR_AR} لم يتم خصم أي نقاط.`;

export function isRemovedReportPayload(payload: unknown): boolean {
  const metadata = (payload as { metadata?: unknown } | null | undefined)?.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const marker = (metadata as { facebookReport?: unknown }).facebookReport;
  return Boolean(marker) && typeof marker === "object";
}
