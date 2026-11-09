import type { EmailFailureReason } from "./sendPlatformEmail";

const RESEND_URL = "https://api.resend.com/emails";
export const CUSTOMER_MAIL_FROM = "Diger <noreply@diger.tech>";
export const CUSTOMER_MAIL_REPLY_TO = "support@diger.tech";
/** Resend's limit is 40 MB for the whole message; a mission file is far smaller, so a much lower cap keeps a mistake cheap. */
export const CUSTOMER_MAIL_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface CustomerMailAttachment { filename: string; content: Buffer }
export interface CustomerMailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** One send per key (Resend keeps it 24 hours): a double click or a retried request sends one e-mail. */
  idempotencyKey: string;
  attachments?: CustomerMailAttachment[];
}
export type CustomerMailResult = { ok: true; id: string | null } | { ok: false; reason: EmailFailureReason | "no_key" };

/**
 * Sends one message from the admin to one customer through Resend, from the verified platform sender. Never throws, and logs only a fixed
 * reason code: never the address, the subject or the body. The caller decides who the recipient is (the customer's registered address).
 */
export async function sendCustomerMail(input: CustomerMailInput, deps: { fetchImpl?: typeof fetch } = {}): Promise<CustomerMailResult> {
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) return { ok: false, reason: "no_key" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) return { ok: false, reason: "invalid_recipient" };
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `admin-mail:${input.idempotencyKey}`.slice(0, 256) },
      body: JSON.stringify({
        from: CUSTOMER_MAIL_FROM,
        to: [input.to],
        reply_to: CUSTOMER_MAIL_REPLY_TO,
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments.map((a) => ({ filename: a.filename, content: a.content.toString("base64") })) } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.error(`[admin-mail:send_failed] reason=resend_rejected status=${res.status}`);
      return { ok: false, reason: res.status === 401 || res.status === 403 ? "unauthorized" : "resend_rejected" };
    }
    let id: string | null = null;
    try { const j = (await res.json()) as { id?: unknown }; id = typeof j?.id === "string" ? j.id : null; } catch { /* the send went out */ }
    return { ok: true, id };
  } catch (err: any) {
    const reason: EmailFailureReason = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "network_error";
    console.error(`[admin-mail:send_failed] reason=${reason}`);
    return { ok: false, reason };
  }
}

/** The admin's sentence for a failed send (Arabic, no internals). */
export function customerMailFailureAr(reason: EmailFailureReason | "no_key"): string {
  switch (reason) {
    case "no_key": return "إرسال البريد غير مُفعَّل على الخادم (مفتاح Resend غير موجود).";
    case "invalid_recipient": return "بريد العميل المسجّل غير صالح.";
    case "unauthorized": return "رفض Resend مفتاح الإرسال؛ راجع RESEND_API_KEY.";
    case "timeout": return "انتهت مهلة الاتصال بخدمة البريد؛ حاول مرة أخرى.";
    case "network_error": return "تعذّر الاتصال بخدمة البريد؛ حاول مرة أخرى.";
    default: return "رفضت خدمة البريد الرسالة؛ حاول مرة أخرى بعد قليل.";
  }
}
