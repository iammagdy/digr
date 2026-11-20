import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { constantTimeEqual, handleWelcomeRequest, type WelcomeDeps, type WelcomeEnv } from "../supabase/functions/send-email/welcomeTrigger";

/**
 * DT-20261119-02b O4: the welcome-only path of send-email. The database trigger sends ONLY the dedicated x-welcome-key and {welcomeUserId}; the function checks the key,
 * looks the user up itself, and welcomes that confirmed user once. After the key (401) and body (400) checks EVERY outcome answers the same 202 {"ok":true} (O6: the key holder learns nothing about any account).
 * Fakes only: no network, no Resend, no database.
 */
const KEY = "dedicated-welcome-key-for-tests";
const SERVICE = "function-own-service-key";
const BASE = "https://proj.supabase.co";
const ID = "0b9c1c1e-2d4a-4b6e-9a58-3f6f2d1f7a11";
const env: WelcomeEnv = { welcomeKey: KEY, supabaseUrl: BASE, serviceKey: SERVICE };

type UserFixture = { id?: string; email?: string | null; email_confirmed_at?: string | null; user_metadata?: Record<string, unknown> } | "404" | "500";
function world(o: { user?: UserFixture; claim?: "new" | "dup" | "fail"; send?: "ok" | "rejected" | "unknown" | "throw" } = {}) {
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
    send: async (i) => { sends.push(i); if (o.send === "throw") throw new Error("boom"); return o.send === "rejected" ? { status: "rejected" } : o.send === "unknown" ? { status: "unknown" } : { status: "sent", id: "re_123" }; },
  };
  return { calls, sends, deps, fetcher };
}
const req = (body: unknown, headers: Record<string, string> = { "x-welcome-key": KEY }) => new Request(`${BASE}/functions/v1/send-email`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const run = async (r: Request, w = world(), e = env) => ({ res: await handleWelcomeRequest(r, e, w.deps), w });
const SAME = '{"ok":true}';
beforeEach(() => { vi.spyOn(console, "info").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

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

describe("welcome path: only a real, confirmed, not-yet-welcomed user (and the caller learns nothing either way)", () => {
  it("not confirmed → 202 {ok:true}, 0 sends, no claim", async () => {
    const { res, w } = await run(req({ welcomeUserId: ID }), world({ user: { id: ID, email: "a@b.com", email_confirmed_at: null } }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe(SAME);
    expect(w.sends).toHaveLength(0);
    expect(w.calls.some((c) => c.method === "POST")).toBe(false);
  });
  it("no e-mail, user not found (404), or the answer is another user's id → 202 {ok:true}, 0 sends", async () => {
    for (const user of [{ id: ID, email: "", email_confirmed_at: "2026-11-20T00:00:00Z" }, "404", { id: "00000000-0000-4000-8000-000000000000", email: "a@b.com", email_confirmed_at: "2026-11-20T00:00:00Z" }] as UserFixture[]) {
      const { res, w } = await run(req({ welcomeUserId: ID }), world({ user }));
      expect(res.status).toBe(202);
      expect(await res.text()).toBe(SAME);
      expect(w.sends).toHaveLength(0);
    }
  });
  it("already in welcome_email_log (the claim inserts nothing) → 202 {ok:true}, 0 sends", async () => {
    const { res, w } = await run(req({ welcomeUserId: ID }), world({ claim: "dup" }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe(SAME);
    expect(w.sends).toHaveLength(0);
  });
  it("a failing lookup (500) or a failing claim → 202 {ok:true} and nothing is sent", async () => {
    for (const o of [{ user: "500" as const }, { claim: "fail" as const }]) {
      const { res, w } = await run(req({ welcomeUserId: ID }), world(o));
      expect(res.status).toBe(202);
      expect(await res.text()).toBe(SAME);
      expect(w.sends).toHaveLength(0);
    }
  });
  it("PRIVACY: the public answer is byte-identical (status, body, headers) for absent, no-email, unconfirmed, already-welcomed, sent, provider-rejected, unknown, lookup-failed and claim-failed", async () => {
    const ok = { id: ID, email: "ali@example.com", email_confirmed_at: "2026-11-20T00:00:00Z", user_metadata: { full_name: "Ali Hassan" } };
    const worlds = [
      world({ user: "404" }), world({ user: { id: ID, email: "", email_confirmed_at: "2026-11-20T00:00:00Z" } }), world({ user: { id: ID, email: "a@b.com", email_confirmed_at: null } }),
      world({ claim: "dup" }), world({ user: ok }), world({ send: "rejected" }), world({ send: "unknown" }), world({ send: "throw" }), world({ user: "500" }), world({ claim: "fail" }),
    ];
    const answers: string[] = [];
    for (const w of worlds) {
      const res = await handleWelcomeRequest(req({ welcomeUserId: ID }), env, w.deps);
      answers.push(`${res.status}|${res.headers.get("content-type")}|${await res.text()}|${[...res.headers.keys()].sort().join(",")}`);
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe(`202|application/json|${SAME}|content-type`);
    // the 401 and 400 answers are NOT part of that set (they say nothing about an account either)
    expect((await run(req({ welcomeUserId: ID }, { "x-welcome-key": "bad" }))).res.status).toBe(401);
    expect((await run(req({ template: "welcome" }))).res.status).toBe(400);
  });
  it("the outcome goes to the SERVER log only: outcome code + user id, never an e-mail, a name or the key", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await run(req({ welcomeUserId: ID }), world({ user: { id: ID, email: "ali@example.com", email_confirmed_at: null, user_metadata: { full_name: "Ali Hassan" } } }));
    await run(req({ welcomeUserId: ID }));
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.map((l) => JSON.parse(l).outcome)).toEqual(["not_confirmed", "sent"]);
    for (const l of lines) { expect(JSON.parse(l).userId).toBe(ID); expect(l).not.toMatch(/ali@example|Ali Hassan|dedicated-welcome-key|function-own-service-key|re_123/); }
  });
});

describe("welcome path: the send", () => {
  it("success → exactly ONE send, to the user's OWN address, with the server-side name and idempotencyKey welcome-<id>; the claim row is written and the provider id stored", async () => {
    const { res, w } = await run(req({ welcomeUserId: ID }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe(SAME);
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
  it("the provider's DEFINITE rejection (an HTTP 4xx/5xx answer, or nothing could be sent) → the claim row is DELETED so a later confirmation can retry; the answer is the same 202", async () => {
    const { res, w } = await run(req({ welcomeUserId: ID }), world({ send: "rejected" }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe(SAME);
    expect(w.sends).toHaveLength(1);
    const del = w.calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toContain(`user_id=eq.${ID}`);
    expect(w.calls.some((c) => c.method === "PATCH")).toBe(false);
  });
  it("an UNKNOWN delivery outcome (the send threw, timed out or the answer was unreadable) KEEPS the claim: once per user for life wins over a possibly missed welcome", async () => {
    for (const send of ["unknown", "throw"] as const) {
      const { res, w } = await run(req({ welcomeUserId: ID }), world({ send }));
      expect(res.status).toBe(202);
      expect(w.sends).toHaveLength(1);
      expect(w.calls.some((c) => c.method === "DELETE"), send).toBe(false);
      expect(w.calls.some((c) => c.method === "PATCH"), send).toBe(false);
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
    expect(res.status).toBe(202);
    expect(await res.text()).toBe(SAME);
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
  it("RESEND_API_KEY missing: nothing could be sent, so the claim is given back; the answer is still the same 202", async () => {
    delete ENVV.RESEND_API_KEY;
    try {
      const { handle } = await loadRouter();
      const res = await handle(post({ welcomeUserId: ID }, { "x-welcome-key": KEY }));
      expect(res.status).toBe(202);
      expect(resendCalls()).toHaveLength(0);
      expect(outbound.some((c) => c.method === "DELETE")).toBe(true);
    } finally { ENVV.RESEND_API_KEY = "re_test"; }
  });
  it("Resend answers 4xx/5xx → the claim is DELETED; Resend fetch throws or times out, or answers 200 with an unreadable body → the claim is KEPT; the public answer is the same 202 every time", async () => {
    const { handle } = await loadRouter();
    const base = globalThis.fetch as any;
    const cases: Array<[string, (u: string, i: any) => Promise<Response> | null, boolean]> = [
      ["resend 500", (u) => (u === "https://api.resend.com/emails" ? Promise.resolve(new Response("{}", { status: 500 })) : null), true],
      ["resend 422", (u) => (u === "https://api.resend.com/emails" ? Promise.resolve(new Response("{}", { status: 422 })) : null), true],
      ["resend throws", (u) => (u === "https://api.resend.com/emails" ? Promise.reject(new Error("network down")) : null), false],
      ["resend timeout", (u) => (u === "https://api.resend.com/emails" ? Promise.reject(new DOMException("timed out", "TimeoutError")) : null), false],
      ["resend 200 unreadable", (u) => (u === "https://api.resend.com/emails" ? Promise.resolve(new Response("not json", { status: 200 })) : null), false],
    ];
    const bodies = new Set<string>();
    for (const [label, hook, deleted] of cases) {
      outbound.length = 0;
      globalThis.fetch = vi.fn(async (u: any, i: any = {}) => { outbound.push({ url: String(u), method: String(i.method ?? "GET"), headers: i.headers ?? {}, body: i.body ? JSON.parse(i.body) : null }); return (await hook(String(u), i)) ?? base(u, i); }) as any;
      outbound.length = 0;
      const res = await handle(post({ welcomeUserId: ID }, { "x-welcome-key": KEY }));
      bodies.add(`${res.status}|${await res.text()}`);
      expect(outbound.some((c) => c.method === "DELETE"), label).toBe(deleted);
    }
    expect([...bodies]).toEqual([`202|${SAME}`]);
  });
  it("the Resend call of the welcome path has a timeout signal; the service-role path is unchanged", async () => {
    const { handle } = await loadRouter();
    let signal: unknown = null;
    const base = globalThis.fetch as any;
    globalThis.fetch = vi.fn(async (u: any, i: any = {}) => { if (String(u) === "https://api.resend.com/emails") signal = i.signal; return base(u, i); }) as any;
    await handle(post({ welcomeUserId: ID }, { "x-welcome-key": KEY }));
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
