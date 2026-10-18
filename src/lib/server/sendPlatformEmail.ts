/**
 * Server-side helper to send platform emails via the Supabase send-email
 * Edge Function (Resend). Supabase-only — no Appwrite code anywhere here.
 *
 * Email sending NEVER throws and NEVER fails the caller's request: any
 * misconfiguration, network error, or provider rejection is logged and
 * swallowed. Money/ledger/job logic must never depend on email delivery.
 *
 * The caller passes the recipient's email + template vars. The Edge Function
 * renders one of the six approved Arabic templates and sends via Resend.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type PlatformEmailTemplateId =
  | "welcome"
  | "topup-received"
  | "topup-approved"
  | "topup-rejected"
  | "job-done"
  | "refund";

const AR_MONTHS = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

/** Format an ISO date as e.g. "13 أكتوبر 2026" for the {{ .CreatedAt }} token. */
export function formatArabicDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Display name for the {{ .Name }} token: profile name, else email local part. */
export function resolveDisplayName(user: {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}): string {
  const meta = user.user_metadata ?? {};
  const fullName = typeof meta.full_name === "string" ? meta.full_name.trim() : "";
  if (fullName) return fullName;
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  if (name) return name;
  const email = user.email ?? "";
  if (email.includes("@")) return email.split("@")[0];
  return "عزيزنا العميل";
}

export type NotificationCategory = "topup" | "done" | "refund" | "news";

export const TEMPLATE_CATEGORY_MAP: Record<PlatformEmailTemplateId, NotificationCategory | null> = {
  welcome: null,
  "topup-received": "topup",
  "topup-approved": "topup",
  "topup-rejected": "topup",
  "job-done": "done",
  refund: "refund",
};

/**
 * Checks whether an email template is enabled according to the user's notification preferences.
 * - welcome: always enabled (system template)
 * - topup / done / refund: default true unless explicitly set to false
 * - news: default false
 */
export function isEmailPreferenceEnabled(
  template: PlatformEmailTemplateId,
  userMetadata?: Record<string, any> | null
): boolean {
  const category = TEMPLATE_CATEGORY_MAP[template];
  if (!category) return true;

  const notif = (userMetadata?.prefs as any)?.notif;
  if (!notif || typeof notif !== "object") {
    return category !== "news";
  }

  const val = notif[category];
  if (typeof val === "boolean") {
    return val;
  }

  return category !== "news";
}

/** Resolve a user's email + display name via the Admin API. Returns null if unknown or opted-out. */
export async function getRecipient(
  adminClient: any,
  userId: string,
  template?: PlatformEmailTemplateId
): Promise<{ email: string; name: string } | null> {
  try {
    if (!adminClient?.auth?.admin?.getUserById) return null;
    const { data, error } = await adminClient.auth.admin.getUserById(userId);
    const user = data?.user;
    if (error || !user?.email) return null;

    if (template && !isEmailPreferenceEnabled(template, user.user_metadata)) {
      const category = TEMPLATE_CATEGORY_MAP[template];
      console.log(
        `[email:preference_disabled] template=${template} category=${category} userId=${userId}`
      );
      return null;
    }

    return { email: user.email, name: resolveDisplayName(user) };
  } catch (err) {
    console.error("[email:recipient_lookup_failed]", err);
    return null;
  }
}

/** Why a send did not go out. Only these fixed codes are ever logged or returned: never a body, header or address. */
export type EmailFailureReason =
  | "invalid_recipient"
  | "missing_config"
  | "unauthorized"
  | "invalid_request"
  | "resend_not_configured"
  | "resend_unreachable"
  | "resend_rejected"
  | "function_unavailable"
  | "timeout"
  | "network_error";

export interface EmailSendResult {
  ok: boolean;
  reason?: EmailFailureReason;
}

const SAFE_FUNCTION_ERRORS: Record<string, EmailFailureReason> = {
  unauthorized: "unauthorized",
  invalid_json: "invalid_request",
  invalid_template: "invalid_request",
  invalid_to: "invalid_request",
  invalid_vars: "invalid_request",
  invalid_idempotency_key: "invalid_request",
  resend_not_configured: "resend_not_configured",
  resend_unreachable: "resend_unreachable",
  resend_rejected: "resend_rejected",
};

/** Maps the Edge Function's answer to a fixed reason code; anything unknown becomes function_unavailable. */
export function emailFailureReason(status: number, errorField: unknown): EmailFailureReason {
  const known = typeof errorField === "string" ? SAFE_FUNCTION_ERRORS[errorField] : undefined;
  if (known) return known;
  return status === 401 ? "unauthorized" : "function_unavailable";
}

/**
 * Send one platform email. Fire-and-forget safe: never throws, so it can never block or fail settlement, a top-up
 * approval or any other caller. The sender (Diger <noreply@diger.tech>, a verified domain) and the RESEND_API_KEY
 * secret live in the Edge Function. `idempotencyKey` makes retries send at most one email.
 * `to` must be a real email address; `vars` are the template's {{ .Var }} values.
 */
export async function sendPlatformEmail(
  template: PlatformEmailTemplateId,
  to: string,
  vars: Record<string, string>,
  idempotencyKey?: string,
): Promise<EmailSendResult> {
  const fail = (reason: EmailFailureReason, extra = ""): EmailSendResult => {
    console.error(`[email:send_failed] template=${template} reason=${reason}${extra}`);
    return { ok: false, reason };
  };
  try {
    if (!to || !to.includes("@")) return fail("invalid_recipient");
    const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    if (!base || !key) return fail("missing_config");
    const res = await fetch(`${base}/functions/v1/send-email`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ template, to, vars, ...(idempotencyKey ? { idempotencyKey } : {}) }),
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) {
      let errorField: unknown;
      try { errorField = (await res.json())?.error; } catch { /* no body */ }
      return fail(emailFailureReason(res.status, errorField), ` status=${res.status}`);
    }
    return { ok: true };
  } catch (err: any) {
    // Transport failures must not expose request headers, addresses, or response bodies.
    return fail(err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "network_error");
  }
}
