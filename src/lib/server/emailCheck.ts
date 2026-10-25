import { toArabicDigits } from "../arabicDigits";
import { completionNoticeFull, releasedNoticeFull, startedNoticeFull, type JobNoticeEmail } from "./jobNotices";
import type { EmailFailureReason, PlatformEmailTemplateId } from "./sendPlatformEmail";

/**
 * ADMIN ONLY. A safe way for the owner to see whether customer e-mail works, without printing a secret and without writing anything:
 *  - `probeSendEmailFunction`: asks the e-mail function a question it answers BEFORE it reaches the e-mail service, so nothing is sent. The
 *    function checks the caller's key, then the template name, then the recipient; a probe with a known template and a recipient that is not
 *    an address therefore stops at «invalid_to» and tells us: the function is published, the key is accepted, and the template is known.
 *  - the test e-mail goes only to the signed-in admin's OWN address, built by the same code that builds the customer's e-mail.
 * Nothing here is reachable from a customer route (the routes using it check the admin role first).
 */
export type FunctionProbe = "not_deployed" | "key_rejected" | "template_missing" | "ready" | "unreachable" | "unknown";

export const FUNCTION_PROBE_LABEL_AR: Record<FunctionProbe, string> = {
  not_deployed: "دالة البريد (send-email) غير منشورة على Supabase: لن يصل أي بريد حتى تُنشر.",
  key_rejected: "دالة البريد منشورة لكنها رفضت مفتاح الخدمة المرسل من التطبيق: تأكد أن المفتاحين من المشروع نفسه.",
  template_missing: "دالة البريد منشورة بنسخة قديمة لا تعرف قالب «تحديث الطلب»: أعد نشرها من آخر نسخة في المستودع.",
  ready: "دالة البريد منشورة وتقبل المفتاح وتعرف قالب «تحديث الطلب». يبقى التأكد من مفتاح الإرسال (Resend) بإرسال رسالة اختبار.",
  unreachable: "تعذّر الوصول إلى دالة البريد (انتهت المهلة أو انقطع الاتصال).",
  unknown: "ردّت دالة البريد بجواب غير متوقع؛ جرّب رسالة اختبار لمعرفة السبب.",
};

export const SEND_FAILURE_LABEL_AR: Record<EmailFailureReason, string> = {
  invalid_recipient: "عنوان بريد المستلم غير صالح.",
  missing_config: "إعدادات الاتصال بـSupabase ناقصة في التطبيق (عنوان المشروع أو مفتاح الخدمة).",
  unauthorized: "دالة البريد رفضت مفتاح الخدمة: تأكد أن مفتاح الخدمة في التطبيق من المشروع نفسه.",
  invalid_request: "دالة البريد رفضت شكل الطلب (قالب أو متغيرات غير معروفة): أعد نشرها من آخر نسخة.",
  resend_not_configured: "مفتاح الإرسال RESEND_API_KEY غير مضبوط في أسرار دالة البريد على Supabase (وجوده في Vercel لا يكفي، لأن الدالة تقرأه من Supabase).",
  resend_unreachable: "تعذّر الوصول إلى خدمة الإرسال (Resend) من دالة البريد.",
  resend_rejected: "خدمة الإرسال رفضت الرسالة: تحقق من صلاحية المفتاح ومن توثيق نطاق المرسل diger.tech.",
  function_unavailable: "دالة البريد (send-email) غير منشورة على Supabase أو لا تستجيب.",
  timeout: "انتهت مهلة الاتصال بدالة البريد.",
  network_error: "انقطع الاتصال بدالة البريد.",
};

export interface EmailConfigStatus {
  supabaseUrl: boolean;
  serviceRoleKey: boolean;
}

/** Booleans only: whether the two settings the app needs to call the e-mail function exist. Never a value. */
export function emailConfigStatus(env: Record<string, string | undefined> = process.env): EmailConfigStatus {
  return { supabaseUrl: Boolean((env.NEXT_PUBLIC_SUPABASE_URL || "").trim()), serviceRoleKey: Boolean((env.SUPABASE_SERVICE_ROLE_KEY || "").trim()) };
}

export async function probeSendEmailFunction(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<FunctionProbe> {
  const base = (env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!base || !key) return "unknown";
  try {
    const res = await fetcher(`${base}/functions/v1/send-email`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      // a known template and a recipient that is not an address: the function stops at the recipient check, before any e-mail service call
      body: JSON.stringify({ template: "job-update", to: "probe-no-send", vars: {} }),
      signal: AbortSignal.timeout(7000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 404) return "not_deployed";
    if (res.status === 401) return "key_rejected";
    if (res.status === 400 && body?.error === "invalid_template") return "template_missing";
    if (res.status === 400 && body?.error === "invalid_to") return "ready";
    return "unknown";
  } catch {
    return "unreachable";
  }
}

export const TEST_EMAIL_KINDS = ["completion", "partial", "failed", "started"] as const;
export type TestEmailKind = (typeof TEST_EMAIL_KINDS)[number];

export interface TestEmail {
  template: PlatformEmailTemplateId;
  vars: Record<string, string>;
}

const fromNotice = (email: JobNoticeEmail, name: string, jobUrl: string): TestEmail => ({
  template: "job-update",
  vars: { Name: name, Subject: email.subject, Heading: email.heading, Lead: email.lead, DetailOne: email.detail1, DetailTwo: email.detail2, ButtonLabel: email.buttonLabel, JobURL: jobUrl },
});

/** The e-mail a customer would get, with sample numbers, from the same builders the worker uses. */
export function buildTestEmail(kind: TestEmailKind, name: string, siteUrl: string): TestEmail {
  const jobUrl = `${siteUrl.replace(/\/+$/, "")}/dashboard/requests`;
  if (kind === "completion") {
    return {
      template: "job-done",
      vars: {
        Name: name,
        JobTitle: "رسالة اختبار من لوحة الإدارة",
        Delivered: toArabicDigits(40),
        Requested: toArabicDigits(40),
        Charged: toArabicDigits(360),
        Refunded: toArabicDigits(0),
        JobURL: jobUrl,
      },
    };
  }
  const notice =
    kind === "partial" ? completionNoticeFull({ delivered: 40, requested: 100, chargedPoints: 360, refundedPoints: 140 })
    : kind === "failed" ? releasedNoticeFull(590, { withEmail: true })
    : startedNoticeFull({ targetVolumeMax: 5000, driver: "tab" });
  return fromNotice(notice.email as JobNoticeEmail, name, jobUrl);
}
