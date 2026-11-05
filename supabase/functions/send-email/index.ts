/**
 * send-email Edge Function (Supabase / Deno).
 *
 * Renders one of the approved Arabic platform email templates (six, plus the compact job-update and the owner's admin-topup-alert) and sends it
 * via the Resend API. This replaces the cancelled Appwrite Messaging path —
 * no Appwrite code is used anywhere here.
 *
 * POST /send-email
 *   Headers: Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 *   Body:    { "template": "welcome" | "topup-received" | "topup-approved"
 *                        | "topup-rejected" | "job-done" | "refund"
 *                        | "job-update" | "admin-topup-alert" | "news",
 *              "to": "customer@example.com",
 *              "vars": { "Name": "...", ... },
 *              "unsubscribeUrl": "https://…" (optional: adds List-Unsubscribe + List-Unsubscribe-Post one-click headers) }
 *   Returns: { "ok": true, "id": "<resend message id>" }
 *
 * Env (Supabase secrets):
 *   RESEND_API_KEY            — Resend API key (send-only).
 *   SUPABASE_SERVICE_ROLE_KEY — authorizes server-to-server callers (standard
 *                               Supabase pattern; the key never goes to clients).
 *                               A caller whose key differs as a string (another valid key format) is
 *                               verified against SUPABASE_URL's admin API instead (authorize.ts).
 *   SITE_URL                  — optional override for {{ .SiteURL }}.
 *
 * Sender is fixed: Diger <noreply@diger.tech> (domain verified on Resend).
 * Templates are verbatim (see templates.ts). Values are HTML-escaped by the
 * renderer; the subject is plain text.
 */

import {
  type PlatformEmailTemplateId,
  renderEmailTemplate,
} from "./templates.ts";
import { buildResendHeaders } from "./resendHeaders.ts";
import { isAuthorizedCaller } from "./authorize.ts";
import { assembleResendPayload, isValidUnsubscribeUrl, renderVarsWithUnsubscribe } from "./payload.ts";

const FROM = "Diger <noreply@diger.tech>";
const RESEND_URL = "https://api.resend.com/emails";

const TEMPLATE_IDS: readonly PlatformEmailTemplateId[] = [
  "welcome",
  "topup-received",
  "topup-approved",
  "topup-rejected",
  "job-done",
  "refund",
  "job-update",
  "admin-topup-alert",
  "news",
];

export type SendEmailRequest = {
  template: PlatformEmailTemplateId;
  to: string;
  vars?: Record<string, string | number | undefined | null>;
  idempotencyKey?: string;
  /** Optional https URL of a one-click unsubscribe endpoint (RFC 8058). When present, List-Unsubscribe headers are added to the Resend payload. */
  unsubscribeUrl?: string;
};

export { isValidUnsubscribeUrl };

/** Build the Resend API payload for a template. Pure — no network, no secrets. The List-Unsubscribe headers are added ONLY when `unsubscribeUrl` is given, so every other caller's payload is unchanged. */
export function buildResendPayload(req: SendEmailRequest) {
  return assembleResendPayload(FROM, renderEmailTemplate(req.template, renderVarsWithUnsubscribe(req.vars ?? {}, req.unsubscribeUrl)), req.to, req.unsubscribeUrl);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  // Server-to-server only: caller must present a service-role key of this project (exact match, else verified by a real call; see authorize.ts).
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  if (!(await isAuthorizedCaller(auth, serviceRoleKey, Deno.env.get("SUPABASE_URL") ?? ""))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const input = body as Partial<SendEmailRequest>;
  if (
    typeof input.template !== "string" ||
    !(TEMPLATE_IDS as readonly string[]).includes(input.template)
  ) {
    return json({ ok: false, error: "invalid_template" }, 400);
  }
  if (typeof input.to !== "string" || !input.to.includes("@")) {
    return json({ ok: false, error: "invalid_to" }, 400);
  }
  if (input.vars !== undefined && (typeof input.vars !== "object" || input.vars === null)) {
    return json({ ok: false, error: "invalid_vars" }, 400);
  }
  if (input.idempotencyKey !== undefined &&
      (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.idempotencyKey))) {
    return json({ ok: false, error: "invalid_idempotency_key" }, 400);
  }

  if (input.unsubscribeUrl !== undefined && !isValidUnsubscribeUrl(input.unsubscribeUrl)) {
    return json({ ok: false, error: "invalid_unsubscribe_url" }, 400);
  }

  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  if (!resendKey) {
    return json({ ok: false, error: "resend_not_configured" }, 500);
  }

  const payload = buildResendPayload({
    template: input.template,
    to: input.to,
    vars: input.vars ?? {},
    unsubscribeUrl: input.unsubscribeUrl,
  });

  let res: Response;
  try {
    res = await fetch(RESEND_URL, {
      method: "POST",
      headers: buildResendHeaders(resendKey, input.idempotencyKey),
      body: JSON.stringify(payload),
    });
  } catch {
    return json({ ok: false, error: "resend_unreachable" }, 502);
  }

  if (!res.ok) {
    // Do not leak the provider's raw error body (it may contain key material).
    return json({ ok: false, error: "resend_rejected", status: res.status }, 502);
  }

  // Resend accepted the message (2xx). An unreadable body must not turn a delivered email into a reported failure.
  let data: { id?: string } = {};
  try {
    data = (await res.json()) as { id?: string };
  } catch {
    data = {};
  }
  return json({ ok: true, id: data?.id ?? null });
}

// Only start the server when run as the function entrypoint (not when imported by tests).
if (import.meta.main) {
  Deno.serve(handle);
}
