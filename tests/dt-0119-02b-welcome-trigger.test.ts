import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { constantTimeEqual, handleWelcomeRequest, type WelcomeDeps, type WelcomeEnv } from "../supabase/functions/send-email/welcomeTrigger";

/**
 * DT-20261119-02b O4: the welcome-only path of send-email. The database trigger sends ONLY the dedicated x-welcome-key and {welcomeUserId}; the function checks the key,
 * looks the user up itself, and welcomes that confirmed user once. Fakes only: no network, no Resend, no database.
 */
const KEY = "dedicated-welcome-key-for-tests";
const SERVICE = "function-own-service-key";
const BASE = "https://proj.supabase.co";
const ID = "0b9c1c1e-2d4a-4b6e-9a58-3f6f2d1f7a11";
const env: WelcomeEnv = { welcomeKey: KEY, supabaseUrl: BASE, serviceKey: SERVICE };

type UserFixture = { id?: string; email?: string | null; email_confirmed_at?: string | null; user_metadata?: Record<string, unknown> } | "404" | "500";
function world(o: { user?: UserFixture; claim?: "new" | "dup" | "fail"; send?: "ok" | "fail" | "throw" } = {}) {
  const user: UserFixture = o.user ?? { id: ID, email: "ali@example.com", email_confirmed_at: "2026-11-20T00:00:00Z", user_metadata: { full_name: "Ali Hassan" } };
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetcher = vi.fn(async (url: any, init: any = {}) => {
    const method = String(init.method ?? "GET");
    calls.push({ method, url: String(url), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    if (method === "GET" && String(url).startsWith(`${BASE}/auth/v1/admin/users/`)) {
      if (user === "404") return new Response("{}", { status: 404 });
      if (user === "500") return new Response("{}", { status: 500 });
      return new Response(JSON.stringify(user), { status: 200 });
    }
    if (method === "POST" && String(url).startsWith(`${BASE}/rest/v1/welcome_email_log`)) {
      if (o.claim === "fail") return new Response("{}", { status: 500 });
      return new Response(JSON.stringify(o.claim === "dup" ? [] : [{ user_id: ID }]), { status: 201 });
    }
    return new Response("{}", { status: 204 });
  });
  const sends: Array<{ to: string; name: string; idempotencyKey: string }> = [];
  const deps: WelcomeDeps = {
    fetcher: fetcher as any,
    send: async (i) => { sends.push(i); if (o.send === "throw") throw new Error("boom"); return o.send === "fail" ? false : { id: "re_123" }; },
  };
  return { calls, sends, deps, fetcher };
}
const req = (body: unknown, headers: Record<string, string> = { "x-welcome-key": KEY }) => new Request(`${BASE}/functions/v1/send-email`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const run = async (r: Request, w = world(), e = env) => ({ res: await handleWelcomeRequest(r, e, w.deps), w });

describe("welcome path: the key", () => {
  it("a wrong key → 401, nothing looked up, nothing sent", async () => {
    const { res, w } = await run(req({ welcomeUserId: ID }, { "x-welcome-key": "wrong" }));
    expect(res.status).toBe(401);
    expect(w.fetcher).not.toHaveBeenCalled();
    expect(w.sends).toHaveLength(0);
  });
  it("an empty key, a key with extra characters, a service-role string → 401", async () => {
    for (const k of ["", KEY + "x", KEY.slice(0, -1), SERVICE]) expect((await run(req({ welcomeUserId: ID }, { "x-welcome-key": k }))).res.status, k).toBe(401);
  });
  it("the function secret WELCOME_TRIGGER_KEY missing or empty → 401 for everyone (even an empty header)", async () => {
    for (const k of ["", "anything"]) {
      const { res, w } = await run(req({ welcomeUserId: ID }, { "x-welcome-key": k }), world(), { ...env, welcomeKey: "" });
      expect(res.status).toBe(401);
      expect(w.sends).toHaveLength(0);
    }
  });
  it("the comparison is constant-time shaped (length included) and exact", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "a")).toBe(false);
  });
  it("the key never appears in any response body", async () => {
    for (const r of [req({ welcomeUserId: ID }), req({ welcomeUserId: ID }, { "x-welcome-key": "bad" }), req({ template: "welcome" })]) expect(await (await run(r)).res.text()).not.toContain(KEY);
  });
});

describe("welcome path: the body is exactly {welcomeUserId}", () => {
  it("any other field, template, to, vars or a missing id → 400, nothing looked up", async () => {
    const bad: unknown[] = [
      { welcomeUserId: ID, template: "welcome" }, { welcomeUserId: ID, to: "x@y.com" }, { welcomeUserId: ID, vars: { Name: "x" } },
      { template: "welcome", to: "x@y.com", vars: {} }, {}, [], null, "text", { welcomeUserId: "not-a-uuid" }, { welcomeUserId: 5 }, { welcomeUserId: `${ID}'; drop` },
    ];
    for (const b of bad) {
      const { res, w } = await run(req(b));
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(w.fetcher, JSON.stringify(b)).not.toHaveBeenCalled();
      expect(w.sends).toHaveLength(0);
    }
    expect((await run(req("{not json"))).res.status).toBe(400);
  });
});

describe("welcome path: only a real, confirmed, not-yet-welcomed user", () => {
  it("not confirmed → 200 skipped, 0 sends, no claim", async () => {
    const { res, w } = await run(req({ welcomeUserId: ID }), world({ user: { id: ID, email: "a@b.com", email_confirmed_at: null } }));
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe("not_confirmed");
    expect(w.sends).toHaveLength(0);
    expect(w.calls.some((c) => c.method === "POST")).toBe(false);
  });
  it("no e-mail, user not found (404), or the answer is another user's id → skipped, 0 sends", async () => {
    for (const user of [{ id: ID, email: "", email_confirmed_at: "2026-11-20T00:00:00Z" }, "404", { id: "00000000-0000-4000-8000-000000000000", email: "a@b.com", email_confirmed_at: "2026-11-20T00:00:00Z" }] as UserFixture[]) {
      const { res, w } = await run(req({ welcomeUserId: ID }), world({ user }));
      expect(res.status).toBe(200);
      expect((await res.json()).skipped).toBeTruthy();
      expect(w.sends).toHaveLength(0);
    }
  });
  it("already in welcome_email_log (the claim inserts nothing) → 200 already_sent, 0 sends", async () => {
    const { res, w } = await run(req({ welcomeUserId: ID }), world({ claim: "dup" }));
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe("already_sent");
    expect(w.sends).toHaveLength(0);
  });
  it("a failing lookup (500) or a failing claim → 502 and nothing is sent", async () => {
    for (const o of [{ user: "500" as const }, { claim: "fail" as const }]) {
      const { res, w } = await run(req({ welcomeUserId: ID }), world(o));
      expect(res.status).toBe(502);
      expect(w.sends).toHaveLength(0);
    }
  });
});

describe("welcome path: the send", () => {
  it("success → exactly ONE send, to the user's OWN address, with the server-side name and idempotencyKey welcome-<id>; the claim row is written and the provider id stored", async () => {
    const { res, w } = await run(req({ welcomeUserId: ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(w.sends).toEqual([{ to: "ali@example.com", name: "Ali Hassan", idempotencyKey: `welcome-${ID}` }]);
    const claim = w.calls.find((c) => c.method === "POST")!;
    expect(claim.url).toContain("/rest/v1/welcome_email_log");
    expect(claim.body).toEqual([{ user_id: ID }]);
    expect(claim.headers.Prefer).toContain("ignore-duplicates");
    const patch = w.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toContain(`user_id=eq.${ID}`);
    expect(patch.body).toEqual({ resend_id: "re_123" });
    expect(w.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
  it("the lookup and the log use the function's OWN service key, never anything from the caller", async () => {
    const { w } = await run(req({ welcomeUserId: ID }));
    for (const c of w.calls) { expect(c.headers.apikey).toBe(SERVICE); expect(c.headers.Authorization).toBe(`Bearer ${SERVICE}`); expect(JSON.stringify(c.headers)).not.toContain(KEY); }
  });
  it("the name falls back: name, then the local part of the e-mail", async () => {
    let w = world({ user: { id: ID, email: "sara@example.com", email_confirmed_at: "2026-11-20T00:00:00Z", user_metadata: { name: "Sara" } } });
    await run(req({ welcomeUserId: ID }), w);
    expect(w.sends[0].name).toBe("Sara");
    w = world({ user: { id: ID, email: "omar.k@example.com", email_confirmed_at: "2026-11-20T00:00:00Z", user_metadata: {} } });
    await run(req({ welcomeUserId: ID }), w);
    expect(w.sends[0].name).toBe("omar.k");
  });
  it("the provider fails (or throws) → the claim row is DELETED, 502, so a later confirmation can retry", async () => {
    for (const send of ["fail", "throw"] as const) {
      const { res, w } = await run(req({ welcomeUserId: ID }), world({ send }));
      expect(res.status).toBe(502);
      expect(w.sends).toHaveLength(1);
      const del = w.calls.find((c) => c.method === "DELETE")!;
      expect(del.url).toContain(`user_id=eq.${ID}`);
      expect(w.calls.some((c) => c.method === "PATCH")).toBe(false);
    }
  });
  it("two requests for the same user in a row: the second one is skipped by the log (one welcome for life)", async () => {
    const w1 = world({ claim: "new" });
    await run(req({ welcomeUserId: ID }), w1);
    const w2 = world({ claim: "dup" });
    await run(req({ welcomeUserId: ID }), w2);
    expect(w1.sends).toHaveLength(1);
    expect(w2.sends).toHaveLength(0);
  });
});

/** The router: the welcome key never reaches the service-role path, and that path is unchanged. */
describe("send-email router (index.ts)", () => {
  const ENVV: Record<string, string> = { RESEND_API_KEY: "re_test", SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_URL: BASE, WELCOME_TRIGGER_KEY: KEY };
  const realFetch = globalThis.fetch;
  let outbound: Array<{ url: string; method: string; headers: any; body: any }>;
  beforeEach(() => {
    (globalThis as any).Deno = { env: { get: (k: string) => ENVV[k] } };
    outbound = [];
    globalThis.fetch = vi.fn(async (url: any, init: any = {}) => {
      const u = String(url); const method = String(init.method ?? "GET");
      outbound.push({ url: u, method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
      if (u.startsWith(`${BASE}/auth/v1/admin/users/${ID}`)) return new Response(JSON.stringify({ id: ID, email: "ali@example.com", email_confirmed_at: "2026-11-20T00:00:00Z", user_metadata: { full_name: "Ali Hassan" } }), { status: 200 });
      if (u.startsWith(`${BASE}/auth/v1/admin/users`)) return new Response("{}", { status: 401 }); // the verification call of a foreign bearer
      if (u.startsWith(`${BASE}/rest/v1/welcome_email_log`)) return new Response(method === "POST" ? JSON.stringify([{ user_id: ID }]) : "{}", { status: method === "POST" ? 201 : 204 });
      if (u === "https://api.resend.com/emails") return new Response(JSON.stringify({ id: "re_9" }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as any;
  });
  afterEach(() => { globalThis.fetch = realFetch; delete (globalThis as any).Deno; });
  // index.ts is Deno code (Deno.env, Deno.serve): it is loaded at run time, by a path TypeScript does not follow, so the app's tsc never compiles it
  const loadRouter = async (): Promise<{ handle: (req: Request) => Promise<Response> }> => { const path = "../supabase/functions/send-email/index"; return import(/* @vite-ignore */ path); };
  const post = (body: unknown, headers: Record<string, string>) => new Request(`${BASE}/functions/v1/send-email`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const resendCalls = () => outbound.filter((c) => c.url === "https://api.resend.com/emails");

  it("the right key + a real confirmed user → ONE Resend call, to the user's own address, the welcome template, Idempotency-Key welcome-<id>", async () => {
    const { handle } = await loadRouter();
    const res = await handle(post({ welcomeUserId: ID }, { "x-welcome-key": KEY }));
    expect(res.status).toBe(200);
    const sent = resendCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.to).toEqual(["ali@example.com"]);
    expect(sent[0].body.subject).toBe("أهلًا Ali Hassan، حسابك على ديجر جاهز");
    expect(sent[0].headers["Idempotency-Key"]).toBe(`welcome-${ID}`);
    expect(sent[0].headers.Authorization).toBe("Bearer re_test");
  });
  it("a forged call with a wrong welcome key sends nothing (even with a valid service key in Authorization: the welcome path never falls through)", async () => {
    const { handle } = await loadRouter();
    for (const headers of [{ "x-welcome-key": "forged" }, { "x-welcome-key": "forged", Authorization: `Bearer ${SERVICE}` }] as Array<Record<string, string>>) {
      const res = await handle(post({ welcomeUserId: ID, template: "welcome", to: "victim@example.com", vars: {} }, headers));
      expect(res.status).toBe(401);
    }
    expect(resendCalls()).toHaveLength(0);
  });
  it("the welcome key used as a bearer on the service-role path is refused: it can only do the welcome", async () => {
    const { handle } = await loadRouter();
    const res = await handle(post({ template: "topup-approved", to: "victim@example.com", vars: { Name: "x" } }, { Authorization: `Bearer ${KEY}` }));
    expect(res.status).toBe(401);
    expect(resendCalls()).toHaveLength(0);
  });
  it("regression: the service-role path is unchanged (a caller with the service key sends any template to any address)", async () => {
    const { handle } = await loadRouter();
    const res = await handle(post({ template: "welcome", to: "someone@example.com", vars: { Name: "Sam" }, idempotencyKey: "welcome-x" }, { Authorization: `Bearer ${SERVICE}` }));
    expect(res.status).toBe(200);
    const sent = resendCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.to).toEqual(["someone@example.com"]);
    expect(sent[0].headers["Idempotency-Key"]).toBe("welcome-x");
    expect((await handle(post({ template: "welcome", to: "x@y.com" }, {}))).status).toBe(401);
  });
  it("RESEND_API_KEY missing: the welcome path reports a failure and the claim is given back; nothing is sent", async () => {
    delete ENVV.RESEND_API_KEY;
    try {
      const { handle } = await loadRouter();
      const res = await handle(post({ welcomeUserId: ID }, { "x-welcome-key": KEY }));
      expect(res.status).toBe(502);
      expect(resendCalls()).toHaveLength(0);
      expect(outbound.some((c) => c.method === "DELETE")).toBe(true);
    } finally { ENVV.RESEND_API_KEY = "re_test"; }
  });
});
