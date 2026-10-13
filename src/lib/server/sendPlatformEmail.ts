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

/** Resolve a user's email + display name via the Admin API. Returns null if unknown. */
export async function getRecipient(
  adminClient: SupabaseClient,
  userId: string
): Promise<{ email: string; name: string } | null> {
  try {
    const {
      data: { user },
      error,
    } = await adminClient.auth.admin.getUserById(userId);
    if (error || !user?.email) return null;
    return { email: user.email, name: resolveDisplayName(user) };
  } catch (err) {
    console.error("[email:recipient_lookup_failed]", err);
    return null;
  }
}

/**
 * Send one platform email. Fire-and-forget safe: never throws.
 * `to` must be a real email address; `vars` are the template's {{ .Var }} values.
 */
export async function sendPlatformEmail(
  template: PlatformEmailTemplateId,
  to: string,
  vars: Record<string, string>
): Promise<void> {
  try {
    if (!to || !to.includes("@")) return;
    const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    if (!base || !key) {
      console.error("[email:missing_config] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
      return;
    }
    const res = await fetch(`${base}/functions/v1/send-email`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ template, to, vars }),
    });
    if (!res.ok) {
      console.error(`[email:send_failed] template=${template} status=${res.status}`);
    }
  } catch (err) {
    console.error("[email:send_error]", err);
  }
}
