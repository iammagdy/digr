/**
 * The welcome-only path of send-email (DT-20261119-02b).
 *
 * Called by the database trigger public.send_welcome_email() through pg_net with ONLY a dedicated key (header x-welcome-key) and
 * {"welcomeUserId": "<uuid>"}. The pg_net queue is readable by every database role, so nothing wide or personal is in it. This path
 * therefore trusts the key for ONE thing, and re-checks everything else itself:
 *   1. the key is compared in constant time with the function secret WELCOME_TRIGGER_KEY (missing or empty secret = nobody is let in);
 *   2. the body is exactly {welcomeUserId: <uuid>}: no template, no address, no variables can be chosen by the caller;
 *   3. the user is looked up with the function's OWN service key; the mail goes only to that user's own address, only when it is confirmed;
 *   4. one welcome per user for life: the claim row in public.welcome_email_log is inserted first (a duplicate is skipped), and removed again
 *      when the send fails so a later confirmation can retry.
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
  /** Sends the "welcome" template to `to`. Returns the provider's message id (or null) on success, `false` on any failure. */
  send: (input: { to: string; name: string; idempotencyKey: string }) => Promise<{ id: string | null } | false>;
}

const json = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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

  const base = env.supabaseUrl.replace(/\/+$/, "");
  if (!base || !env.serviceKey) return json({ ok: false, error: "not_configured" }, 500);
  const auth = { apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}` };

  // 3. the user, looked up by the function itself
  let user: { id?: string; email?: string | null; email_confirmed_at?: string | null; user_metadata?: Record<string, unknown> | null } | null = null;
  try {
    const res = await fetcher(`${base}/auth/v1/admin/users/${id}`, { method: "GET", headers: auth, signal: AbortSignal.timeout(5000) });
    if (res.status === 404) { await res.body?.cancel().catch(() => undefined); return json({ ok: true, skipped: "user_not_found" }, 200); }
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return json({ ok: false, error: "user_lookup_failed" }, 502); }
    user = await res.json();
  } catch {
    return json({ ok: false, error: "user_lookup_failed" }, 502);
  }
  if (!user || String(user.id ?? "").toLowerCase() !== id) return json({ ok: true, skipped: "user_not_found" }, 200);
  const email = typeof user.email === "string" ? user.email.trim() : "";
  if (!email) return json({ ok: true, skipped: "no_email" }, 200);
  if (!user.email_confirmed_at) return json({ ok: true, skipped: "not_confirmed" }, 200);

  // 4. the claim: one welcome per user for life (a duplicate inserts nothing)
  const rest = `${base}/rest/v1/welcome_email_log`;
  try {
    const res = await fetcher(`${rest}?on_conflict=user_id`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify([{ user_id: id }]),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return json({ ok: false, error: "claim_failed" }, 502); }
    const inserted = await res.json();
    if (!Array.isArray(inserted) || inserted.length === 0) return json({ ok: true, skipped: "already_sent" }, 200);
  } catch {
    return json({ ok: false, error: "claim_failed" }, 502);
  }

  // 5. the send: to the user's own address, name taken here (never from the caller)
  const meta = user.user_metadata ?? {};
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const name = pick(meta.full_name) || pick(meta.name) || email.split("@")[0];
  const sent = await deps.send({ to: email, name, idempotencyKey: `welcome-${id}` }).catch(() => false as const);
  if (!sent) {
    // the claim is given back so a later confirmation can try again
    try { const r = await fetcher(`${rest}?user_id=eq.${id}`, { method: "DELETE", headers: auth, signal: AbortSignal.timeout(5000) }); await r.body?.cancel().catch(() => undefined); } catch { /* the claim stays: at worst this user gets no welcome */ }
    return json({ ok: false, error: "send_failed" }, 502);
  }
  // 6. the provider's id, best effort
  if (sent.id) {
    try { const r = await fetcher(`${rest}?user_id=eq.${id}`, { method: "PATCH", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ resend_id: sent.id }), signal: AbortSignal.timeout(5000) }); await r.body?.cancel().catch(() => undefined); } catch { /* not needed to have sent */ }
  }
  return json({ ok: true, sent: true }, 200);
}
