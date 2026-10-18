export interface SupportSettings {
  supportEmail: string;
  whatsappNumber: string;
}

/** Shown until the owner sets real values in the admin settings. */
export const SUPPORT_PLACEHOLDER_AR = "سيُضاف قريبًا";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(value: string): boolean {
  return value.length <= 200 && EMAIL_PATTERN.test(value);
}

/** Digits only, 8 to 15 long, international form without a plus sign (for a wa.me link). Empty means not set. */
export function normalizeWhatsapp(raw: unknown): string {
  const digits = String(raw ?? "")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : "";
}

export function whatsappHref(number: string): string | null {
  const digits = normalizeWhatsapp(number);
  return digits ? `https://wa.me/${digits}` : null;
}

export function normalizeSupportSettings(raw: any): SupportSettings {
  const email = String(raw?.supportEmail ?? "").trim();
  return {
    supportEmail: isValidEmail(email) ? email : "",
    whatsappNumber: normalizeWhatsapp(raw?.whatsappNumber),
  };
}

export interface SupportMessageInput {
  name: unknown;
  email: unknown;
  message: unknown;
}

export interface SupportMessageValid {
  name: string;
  email: string;
  message: string;
}

/** Arabic reason or the cleaned values. The form and the route use the same rules. */
export function validateSupportMessage(input: SupportMessageInput): { ok: true; value: SupportMessageValid } | { ok: false; errorAr: string } {
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim();
  const email = String(input.email ?? "").trim();
  const message = String(input.message ?? "").trim();
  if (name.length < 2 || name.length > 120) return { ok: false, errorAr: "اكتب اسمك (حرفان على الأقل)." };
  if (!isValidEmail(email)) return { ok: false, errorAr: "اكتب بريدًا إلكترونيًا صحيحًا لنرد عليك." };
  if (message.length < 5) return { ok: false, errorAr: "اكتب رسالتك (٥ أحرف على الأقل)." };
  if (message.length > 4000) return { ok: false, errorAr: "الرسالة طويلة جدًا. اختصرها إلى ٤٠٠٠ حرف." };
  return { ok: true, value: { name, email, message } };
}

/** The message a «بلّغ عن مشكلة» button submits for a job, written by code. */
export function jobReportMessageAr(job: { id: string; status: string; delivered?: number | null; requested?: number | null }): string {
  const kind = /fail|cancel|refus/i.test(job.status) ? "تعذر تنفيذ الطلب" : "الطلب اكتمل جزئيًا";
  const counts = typeof job.delivered === "number" && typeof job.requested === "number" ? ` (سُلّم ${job.delivered} من ${job.requested})` : "";
  return `بلاغ عن مشكلة في الطلب رقم ${job.id}: ${kind}${counts}.`;
}
