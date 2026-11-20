/**
 * The welcome-only path of send-email (DT-20261119-02b).
 *
 * Called by the database trigger public.send_welcome_email() through pg_net with ONLY a dedicated key (header x-welcome-key) and
 * {"welcomeUserId": "<uuid>"}. The pg_net queue is readable by every database role, so nothing wide or personal is in it. This path
 * therefore trusts the key for ONE thing, and re-checks everything else itself:
 *   1. the key is compared in constant time with the function secret WELCOME_TRIGGER_KEY (missing or empty secret = nobody is let in);
 *   2. the body is exactly {welcomeUserId: <uuid>}: no template, no address, no variables can be chosen by the caller;
 *   3. the user is looked up with the function's OWN service key; the mail goes only to that user's own address, only when it is confirmed;
 *   4. one welcome per user for life: the claim row in public.welcome_email_log is inserted first (a duplicate is skipped). It is removed again
 *      ONLY when the provider's definite rejection (an HTTP 4xx/5xx answer was received, or nothing could have been sent) says no mail went out, so a
 *      later confirmation can retry; when the outcome is unknown (network error, timeout, unreadable answer) the claim STAYS: once per user for
 *      life wins over a possibly missed welcome.
 *   5. PRIVACY: a caller holding the key (the queue is readable by database roles) learns NOTHING about any account. After the key check (401) and
 *      the body check (400), EVERY outcome (user absent, no e-mail, not confirmed, already welcomed, sent, send failed, any internal failure)
 *      answers the SAME 202 {"ok":true}. The outcome and the user id go to the server log only (never an e-mail, a name or the key).
 *      Known limit: the response TIME is not made independent of the account state.
 * The service-role path of the function is a different branch and is never reachable with this key.
 */

export const WELCOME_KEY_HEADER = "x-welcome-key";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WelcomeEnv {
  /** Function secret WELCOME_TRIGGER_KEY. */
  welcomeKey: string;
  supabaseUrl: string;
  /** The function's own SUPABASE_SERVICE_ROLE_KEY (never the caller's). */
  serviceKey: string;
}
export interface WelcomeDeps {
  fetcher?: typeof fetch;
  /**
   * Sends the "welcome" template to `to`. The answer says what is KNOWN about delivery:
   *   sent     — the provider accepted it (id is its message id, or null when it could not be read);
   *   rejected — the provider answered with an HTTP 4xx/5xx, or nothing was sent at all (not configured): no mail went out;
   *   unknown  — anything else (network error, timeout, unreadable answer): the mail may have gone out. A throw also counts as unknown.
   */
  send: (input: { to: string; name: string; idempotencyKey: string }) => Promise<{ status: "sent"; id: string | null } | { status: "rejected" } | { status: "unknown" }>;
}

const json = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
/** The ONE answer of every welcome outcome after the key and body checks (nothing account-derived in it). */
const ack = (): Response => json({ ok: true }, 202);

/** Constant-time string comparison (length difference included): no early exit on the first differing byte. */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function handleWelcomeRequest(req: Request, env: WelcomeEnv, deps: WelcomeDeps): Promise<Response> {
  const fetcher = deps.fetcher ?? fetch;
  // 1. the key
  const given = req.headers.get(WELCOME_KEY_HEADER) ?? "";
  if (!env.welcomeKey || !constantTimeEqual(given, env.welcomeKey)) return json({ ok: false, error: "unauthorized" }, 401);

  // 2. the body: exactly {welcomeUserId: <uuid>}
  let body: unknown;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body as object) : [];
  const userId = keys.length === 1 && keys[0] === "welcomeUserId" ? (body as { welcomeUserId?: unknown }).welcomeUserId : undefined;
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return json({ ok: false, error: "invalid_body" }, 400);
  const id = userId.toLowerCase();

  // From here on the caller always gets the same 202; what happened goes to the server log (outcome code + user id only).
  const done = (outcome: string): Response => {
    console.info(JSON.stringify({ tag: "welcome_outcome", outcome, userId: id }));
    return ack();
  };

  const base = env.supabaseUrl.replace(/\/+$/, "");
  if (!base || !env.serviceKey) return done("not_configured");
  const auth = { apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}` };
  const drain = async (r: Response) => { await r.body?.cancel().catch(() => undefined); };

  // 3. the user, looked up by the function itself
  let user: { id?: string; email?: string | null; email_confirmed_at?: string | null; user_metadata?: Record<string, unknown> | null } | null = null;
  try {
    const res = await fetcher(`${base}/auth/v1/admin/users/${id}`, { method: "GET", headers: auth, signal: AbortSignal.timeout(5000) });
    if (res.status === 404) { await drain(res); return done("user_not_found"); }
    if (!res.ok) { await drain(res); return done("user_lookup_failed"); }
    user = await res.json();
  } catch {
    return done("user_lookup_failed");
  }
  if (!user || String(user.id ?? "").toLowerCase() !== id) return done("user_not_found");
  const email = typeof user.email === "string" ? user.email.trim() : "";
  if (!email) return done("no_email");
  if (!user.email_confirmed_at) return done("not_confirmed");

  // 4. the claim: one welcome per user for life (a duplicate inserts nothing)
  const rest = `${base}/rest/v1/welcome_email_log`;
  try {
    const res = await fetcher(`${rest}?on_conflict=user_id`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify([{ user_id: id }]),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) { await drain(res); return done("claim_failed"); }
    const inserted = await res.json();
    if (!Array.isArray(inserted) || inserted.length === 0) return done("already_sent");
  } catch {
    return done("claim_failed");
  }

  // 5. the send: to the user's own address, name taken here (never from the caller)
  const meta = user.user_metadata ?? {};
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const name = pick(meta.full_name) || pick(meta.name) || email.split("@")[0];
  const sent = await deps.send({ to: email, name, idempotencyKey: `welcome-${id}` }).catch(() => ({ status: "unknown" as const }));
  if (sent.status === "rejected") {
    // a definite rejection: no mail went out, so the claim is given back and a later confirmation can try again
    try { const r = await fetcher(`${rest}?user_id=eq.${id}`, { method: "DELETE", headers: auth, signal: AbortSignal.timeout(5000) }); await drain(r); } catch { /* the claim stays: at worst this user gets no welcome */ }
    return done("send_rejected");
  }
  if (sent.status === "unknown") return done("send_unknown_claim_kept"); // the mail may have gone out: once per user for life wins
  // 6. the provider's id, best effort
  if (sent.id) {
    try { const r = await fetcher(`${rest}?user_id=eq.${id}`, { method: "PATCH", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ resend_id: sent.id }), signal: AbortSignal.timeout(5000) }); await drain(r); } catch { /* not needed to have sent */ }
  }
  return done("sent");
}
