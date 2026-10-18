import type { EmailFailureReason } from "./sendPlatformEmail";

const RESEND_URL = "https://api.resend.com/emails";
const FROM = "Diger <noreply@diger.tech>";

export interface SupportMailInput {
  id: string;
  to: string;
  replyTo: string;
  name: string;
  message: string;
  jobId?: string | null;
}

/**
 * Sends a support message to the owner through Resend, only when RESEND_API_KEY exists. Never throws; the stored
 * message is the source of truth, the email is a convenience. The result carries a fixed reason code only.
 */
export async function sendSupportMail(input: SupportMailInput): Promise<{ ok: boolean; reason?: EmailFailureReason | "no_key" }> {
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) return { ok: false, reason: "no_key" };
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `support:${input.id}` },
      body: JSON.stringify({
        from: FROM,
        to: [input.to],
        reply_to: input.replyTo,
        subject: input.jobId ? "بلاغ مشكلة في طلب" : "رسالة جديدة من صفحة التواصل",
        text: `الاسم: ${input.name}\nالبريد: ${input.replyTo}${input.jobId ? `\nالطلب: ${input.jobId}` : ""}\n\n${input.message}`,
      }),
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) {
      console.error(`[support:mail_failed] reason=resend_rejected status=${res.status}`);
      return { ok: false, reason: "resend_rejected" };
    }
    return { ok: true };
  } catch (err: any) {
    const reason: EmailFailureReason = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "network_error";
    console.error(`[support:mail_failed] reason=${reason}`);
    return { ok: false, reason };
  }
}
