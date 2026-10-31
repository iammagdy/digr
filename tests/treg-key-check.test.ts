import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN, clock, fakeSecret, makePoolWorld, teardownPoolWorld, type TregMode } from "./helpers/tregPoolKit";
import { captureConsole } from "./helpers/providerKeyTestKit";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { categoryOf } from "../src/lib/treg/dataPolicy";

const state = vi.hoisted(() => ({ user: null as any, client: null as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.client),
}));

import { POST } from "../src/app/api/admin/treg-keys/route";
import { KEY_CHECK_PROBE, decideVerdict, statusLineAr } from "../src/lib/server/tregKeyCheck";
import { __resetCheckLimiter, KEY_CHECK_LIMITS, checkPastedKey, checkPoolKeyNow } from "../src/lib/server/tregPoolAdmin";
import { accountRefusalReason, providerReasonText, redactAndClip } from "../src/lib/server/tregRefusal";
import { decryptPoolKey } from "../src/lib/server/tregPoolCrypto";
import { flushProviderLimitsCache } from "../src/lib/server/providerLimits";

/**
 * The admin key checker. A key is judged by three steps: the identity read, the balance read and ONE real data call on the cheapest sellable data endpoint. The pasted key is used only as
 * the header of those requests: never stored, logged, echoed or put in a URL. Everything runs against the fake TREG of the kit; no real network, no real clock.
 */
const ADMIN_USER = { id: ADMIN, email: "owner@example.test", app_metadata: { role: "admin" }, user_metadata: { name: "المدير" } };
let logs: ReturnType<typeof captureConsole>;
let w: ReturnType<typeof makePoolWorld>;
let audit: Array<Record<string, any>>;

/** The kit's database plus the admin_audit_log table: insert, and the count query `select(id,{count,head}).eq().eq().gte()` the limiter uses. */
function withAudit(client: any) {
  return {
    ...client,
    from(table: string) {
      if (table !== "admin_audit_log") return client.from(table);
      const filters: Array<[string, any]> = []; let since = ""; let counting = false;
      const chain: any = {
        select: (_cols: string, opts?: { count?: string }) => { counting = Boolean(opts?.count); return chain; },
        eq: (col: string, val: any) => { filters.push([col, val]); return chain; },
        gte: (_col: string, val: string) => { since = val; return chain; },
        insert: async (row: Record<string, any>) => { audit.push({ ...row, created_at: new Date(clock.t).toISOString() }); return { error: null }; },
        then: (resolve: (v: any) => void) => resolve({ count: counting ? audit.filter((r) => filters.every(([c, v]) => r[c] === v) && r.created_at >= since).length : null, error: null }),
      };
      return chain;
    },
  };
}
const deps = () => ({ client: state.client, pool: w.pool, fetchFn: w.treg.fetch as any, now: clock.now });
const pasted = (mode: TregMode, extra: Partial<{ balanceMicro: number; balanceMode: "ok" | "unreadable"; meMode: "ok" | "http503" | "timeout" }> = {}) => {
  const key = fakeSecret("pasted");
  w.treg.set(key, { mode, ...extra });
  return key;
};
const dataRequests = () => w.treg.requests.filter((r) => r.path.startsWith("/call/"));
const secretly = (key: string) => [logs.text(), JSON.stringify(w.db.rpcLog), JSON.stringify(audit), JSON.stringify(w.db.keys), JSON.stringify(w.treg.fetch.mock.calls.map((c: any[]) => String(c[0])))];

beforeEach(() => {
  logs = captureConsole(); w = makePoolWorld(); audit = []; state.client = withAudit(w.db.client); state.user = ADMIN_USER; __resetCheckLimiter();
  vi.stubEnv("PROVIDER_DAILY_SPEND_CAP_USD", "0.8"); flushProviderLimitsCache();
});
afterEach(() => { logs.restore(); teardownPoolWorld(); });

describe("the probe: the cheapest sellable data endpoint", () => {
  it("is exactly what the rule picks from the catalog (so a catalog refresh cannot leave a stale or dearer probe)", () => {
    const cat = loadTregCatalog();
    const eligible = cat.endpoints
      .filter((e) => e.cost && typeof e.cost.usd === "number" && e.cost.usd > 0)
      .filter((e) => blockedEndpointReason(e.id, e.scope) === null && categoryOf(e.id) === "public")
      .filter((e) => e.kind === "direct" && e.category !== "AI generation")
      .filter((e) => { const req = e.inputs.filter((i) => i.required); return req.length > 0 && req.every((i) => i.example !== null && i.example !== undefined); })
      .filter((e) => Number(e.observed?.samples) >= 1000 && Number(e.observed?.ok_rate) >= 0.95)
      .sort((a, b) => a.cost!.usd! - b.cost!.usd! || Number(b.observed?.ok_rate) - Number(a.observed?.ok_rate) || Number(a.observed?.p50_ms) - Number(b.observed?.p50_ms) || a.id.localeCompare(b.id));
    expect(eligible[0].id).toBe(KEY_CHECK_PROBE.endpointId);
    expect(eligible[0].cost!.usd).toBe(KEY_CHECK_PROBE.estimateUsd);
    expect((eligible[0].test_request as any).body).toEqual(KEY_CHECK_PROBE.params);
    expect(blockedEndpointReason(KEY_CHECK_PROBE.endpointId)).toBeNull();
  });
});

describe("what a refusal says about the key", () => {
  it.each(["org suspended", "Organization is suspended", "account disabled", "Your account has been suspended", "suspended organization", "team deactivated", '{"detail":"org suspended"}', "ORG SUSPENDED"])("«%s» names the account", (t) => {
    expect(accountRefusalReason(t)).not.toBeNull();
  });
  it("org-ish subjects give org_suspended, the account gives account_disabled", () => {
    expect(accountRefusalReason("org suspended")).toBe("org_suspended");
    expect(accountRefusalReason("workspace banned")).toBe("org_suspended");
    expect(accountRefusalReason("account disabled")).toBe("account_disabled");
  });
  it.each(["forbidden", "not allowed for your plan", "endpoint disabled", "insufficient_balance", "rate limited", "", "access denied to this resource"])("«%s» does not (an endpoint can refuse a plan)", (t) => {
    expect(accountRefusalReason(t)).toBeNull();
  });
  it("non-strings are no evidence", () => { expect(accountRefusalReason(undefined)).toBeNull(); expect(accountRefusalReason(42)).toBeNull(); expect(accountRefusalReason({})).toBeNull(); });
  it("the provider's words are taken from the body, clipped, and the key and token shapes are removed", () => {
    const key = fakeSecret("leak");
    expect(providerReasonText({ detail: "org suspended" })).toBe("org suspended");
    expect(providerReasonText({ error: "forbidden", message: `bad token ${key}` }, [key])).toBe("bad token [REDACTED]");
    expect(providerReasonText({ detail: { code: "x" } })).toBe('{"code":"x"}');
    expect(providerReasonText({ detail: "x".repeat(500) })?.length).toBe(160);
    expect(providerReasonText(null)).toBeNull();
    expect(redactAndClip(`Bearer abc.def treg_abcdef ${"a1".repeat(20)} sk-abc`)).toBe("Bearer [REDACTED] [REDACTED] [REDACTED] [REDACTED]");
  });
});

describe("the verdict of the three steps (pure)", () => {
  const ok = { ok: true, httpStatus: 200, text: null };
  const data = (over: Record<string, unknown> = {}) => ({ ran: true, ok: false, httpStatus: null, platformBalanceLow: false, text: null, ...over });
  it("works only when the data call was answered", () => {
    expect(decideVerdict({ identity: ok, balanceMicro: 5, minBalanceMicro: 10_000, data: data({ ok: true, httpStatus: 200 }) }).verdict).toBe("works");
  });
  it("the identity read refusing is final: suspended when the words say so, refused otherwise, unknown for a blip", () => {
    const bad = (httpStatus: number | null, text: string | null) => decideVerdict({ identity: { ok: false, httpStatus, text }, balanceMicro: null, minBalanceMicro: 1, data: data({ ran: false }) });
    expect(bad(403, "org suspended").verdict).toBe("suspended");
    expect(bad(401, "unauthorized").verdict).toBe("refused");
    expect(bad(503, null).verdict).toBe("unknown");
    expect(bad(null, null).verdict).toBe("unknown");
  });
  it("a data call that the key's account refuses is suspended even though the identity read passes", () => {
    expect(decideVerdict({ identity: ok, balanceMicro: 912_244, minBalanceMicro: 10_000, data: data({ httpStatus: 403, text: "org suspended" }) })).toMatchObject({ verdict: "suspended", refusal: "org_suspended", origin: "data" });
    expect(decideVerdict({ identity: ok, balanceMicro: 912_244, minBalanceMicro: 10_000, data: data({ httpStatus: 403, text: "forbidden" }) })).toMatchObject({ verdict: "refused", origin: "data" });
  });
  it("a 402 with a confirmed low balance is an empty balance; any other failure of the call is unknown, never a verdict on the key", () => {
    expect(decideVerdict({ identity: ok, balanceMicro: 0, minBalanceMicro: 1, data: data({ httpStatus: 402, platformBalanceLow: true }) }).verdict).toBe("out_of_balance");
    for (const httpStatus of [400, 404, 422, 429, 500, 503, null]) expect(decideVerdict({ identity: ok, balanceMicro: 500_000, minBalanceMicro: 1, data: data({ httpStatus }) }).verdict).toBe("unknown");
  });
  it("with no data call (cap, cost record): only a low balance is conclusive", () => {
    expect(decideVerdict({ identity: ok, balanceMicro: 5, minBalanceMicro: 10_000, data: data({ ran: false }) }).verdict).toBe("out_of_balance");
    expect(decideVerdict({ identity: ok, balanceMicro: 900_000, minBalanceMicro: 10_000, data: data({ ran: false }) }).verdict).toBe("unknown");
    expect(decideVerdict({ identity: ok, balanceMicro: null, minBalanceMicro: 10_000, data: data({ ran: false }) }).verdict).toBe("unknown");
  });
  it("the Arabic status words", () => {
    expect(statusLineAr("works", 200)).toBe("يعمل");
    expect(statusLineAr("out_of_balance", 402)).toBe("رصيد غير كافٍ");
    expect(statusLineAr("suspended", 403)).toBe("الحساب موقوف");
    expect(statusLineAr("unknown", null)).toBe("غير معروف");
    expect(statusLineAr("refused", 401)).toBe("مرفوض: المفتاح غير صالح أو أُلغي");
    expect(statusLineAr("refused", 403)).toBe("مرفوض: ممنوع من المزود");
    expect(statusLineAr("refused", 404)).toBe("مرفوض: رمز الرد ٤٠٤");
  });
});

describe("«افحص»: a pasted key, three steps, nothing kept", () => {
  const cases: Array<[string, TregMode, Partial<{ balanceMicro: number }>, string, string]> = [
    ["a healthy key", "ok", {}, "works", "يعمل"],
    ["the incident: identity and balance pass, every data call says «org suspended»", "suspended403", { balanceMicro: 912_244 }, "suspended", "الحساب موقوف"],
    ["a bare 403 on the data call", "forbid403", {}, "refused", "مرفوض: ممنوع من المزود"],
    ["an empty account (402 on the data call)", "empty", { balanceMicro: 5_000 }, "out_of_balance", "رصيد غير كافٍ"],
    ["a source error (503) is nobody's verdict", "http503", {}, "unknown", "غير معروف"],
    ["a timeout", "timeout", {}, "unknown", "غير معروف"],
  ];
  it.each(cases)("%s", async (_name, mode, extra, verdict, statusAr) => {
    const key = pasted(mode, extra);
    const out = await checkPastedKey(deps(), { adminId: ADMIN, key });
    expect(out).toMatchObject({ ok: true, status: 200, report: { verdict, statusAr } });
    expect(dataRequests()).toHaveLength(1);
    expect(dataRequests()[0].path).toBe(`/call/${KEY_CHECK_PROBE.endpointId}`);
  });

  it("an identity read that refuses the key (401) ends it there: «مرفوض», no data call is sent", async () => {
    const key = pasted("revoked");
    const out = await checkPastedKey(deps(), { adminId: ADMIN, key });
    expect(out.report).toMatchObject({ verdict: "refused", statusAr: "مرفوض: المفتاح غير صالح أو أُلغي", steps: [{ name: "identity", ok: false }, { name: "balance", ran: false }, { name: "data", ran: false }] });
    expect(dataRequests()).toHaveLength(0);
    expect(w.db.spend.reserveCalls).toHaveLength(0);                       // nothing reserved, nothing spent
  });

  it("shows الحالة، الرصيد، and the provider's own short reason", async () => {
    const key = pasted("suspended403", { balanceMicro: 912_244 });
    const { report } = await checkPastedKey(deps(), { adminId: ADMIN, key });
    expect(report).toMatchObject({ statusAr: "الحساب موقوف", balanceUsd: 0.912244, providerText: "org suspended" });
    expect(report?.steps.map((s) => [s.name, s.ok, s.httpStatus])).toEqual([["identity", true, 200], ["balance", true, null], ["data", false, 403]]);
  });

  it("a balance that cannot be read is «غير متاح» but the key still works if the data call is answered", async () => {
    const key = pasted("ok", { balanceMode: "unreadable" });
    expect((await checkPastedKey(deps(), { adminId: ADMIN, key })).report).toMatchObject({ verdict: "works", balanceUsd: null });
  });

  it("the data call is counted like any call: reserved against the provider's daily cap, committed with what it cost, no job", async () => {
    const key = pasted("ok");
    const out = await checkPastedKey(deps(), { adminId: ADMIN, key });
    expect(w.db.spend.reserveCalls).toEqual([{ job: null, provider: "treg", est: KEY_CHECK_PROBE.estimateUsd, cap: 0.8 }]);
    expect(out.report?.costUsd).toBe(0.001);                                // the fake TREG's cost header (1000 micro-USD)
    expect(w.db.spend.today).toBeCloseTo(0.001, 6);
    expect(w.db.spend.estimates.size).toBe(0);                              // the estimate row was closed, never left open
  });

  it("a failed call is closed too (cost 0, status failed); a cut call keeps its estimate (it may have been billed after we stopped waiting)", async () => {
    await checkPastedKey(deps(), { adminId: ADMIN, key: pasted("suspended403") });
    expect(w.db.spend.estimates.size).toBe(0);
    expect(w.db.spend.today).toBe(0);
    await checkPastedKey(deps(), { adminId: ADMIN, key: pasted("timeout") });
    expect(w.db.spend.estimates.size).toBe(0);
    expect(w.db.spend.today).toBeCloseTo(KEY_CHECK_PROBE.estimateUsd, 8);
  });

  it("PROVIDER_DAILY_SPEND_CAP_USD binds it: at the cap no request leaves, and the answer says so", async () => {
    vi.stubEnv("PROVIDER_DAILY_SPEND_CAP_USD", "0.0001"); flushProviderLimitsCache();
    const key = pasted("ok", { balanceMicro: 900_000 });
    const out = await checkPastedKey(deps(), { adminId: ADMIN, key });
    expect(dataRequests()).toHaveLength(0);
    expect(out.report).toMatchObject({ verdict: "unknown", noteAr: "لم يُرسَل الطلب الحقيقي: بلغ الإنفاق اليومي على المزود حدّه." });
    expect(out.report?.steps.find((s) => s.name === "data")).toMatchObject({ ran: false });
    // a low balance is still conclusive without the call
    const low = pasted("ok", { balanceMicro: 5_000 });
    expect((await checkPastedKey(deps(), { adminId: ADMIN, key: low })).report?.verdict).toBe("out_of_balance");
  });

  it("two checks in a row spend from the same cap: the second is refused once the first's real cost used it up", async () => {
    vi.stubEnv("PROVIDER_DAILY_SPEND_CAP_USD", "0.0011"); flushProviderLimitsCache();
    expect((await checkPastedKey(deps(), { adminId: ADMIN, key: pasted("ok") })).report?.verdict).toBe("works");   // costs 0.001
    const second = await checkPastedKey(deps(), { adminId: ADMIN, key: pasted("ok") });
    expect(second.report?.verdict).toBe("unknown");
    expect(dataRequests()).toHaveLength(1);
  });

  it("a malformed key is refused without using the allowance or sending anything", async () => {
    for (const key of ["", "short", "has space in it 123456", 42, null, "é".repeat(20)]) expect(await checkPastedKey(deps(), { adminId: ADMIN, key })).toMatchObject({ ok: false, reason: "invalid_key", status: 400 });
    expect(w.treg.requests).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });
});

describe("the pasted key is never stored, logged, echoed, or put in a URL", () => {
  const scenarios: Array<[string, TregMode]> = [["works", "ok"], ["suspended", "suspended403"], ["refused", "forbid403"], ["revoked", "revoked"], ["empty", "empty"], ["source error", "http503"], ["timeout", "timeout"]];
  it.each(scenarios)("%s: not in the answer, the console, any database call, any audit row, any stored key row, any URL", async (_n, mode) => {
    const key = pasted(mode);
    const liveBefore = w.db.live().length;
    const out = await checkPastedKey(deps(), { adminId: ADMIN, key });
    expect(JSON.stringify(out)).not.toContain(key);
    for (const where of secretly(key)) expect(where).not.toContain(key);
    expect(w.db.live().length).toBe(liveBefore);                           // nothing was saved
    // it travels only as the X-Treg-Token header of the requests that use it
    for (const [, init] of w.treg.fetch.mock.calls as Array<[string, RequestInit]>) {
      const headers = init.headers as Record<string, string>;
      for (const [name, value] of Object.entries(headers)) if (name !== "X-Treg-Token") expect(String(value)).not.toContain(key);
      expect(String(init.body ?? "")).not.toContain(key);
    }
  });

  it("not even when the provider or the network echoes it back inside an error", async () => {
    const key = pasted("ok");
    const realFetch = w.treg.fetch.getMockImplementation()!;
    w.treg.fetch.mockImplementation(async (input: any, init: any) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/call/")) {
        if ((init.headers as any)["Idempotency-Key"]?.includes("never")) return realFetch(input, init);
        return new Response(JSON.stringify({ detail: `token ${key} is not allowed: org suspended` }), { status: 403, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    });
    const out = await checkPastedKey(deps(), { adminId: ADMIN, key });
    expect(out.report).toMatchObject({ verdict: "suspended", providerText: "token [REDACTED] is not allowed: org suspended" });
    for (const where of [JSON.stringify(out), ...secretly(key)]) expect(where).not.toContain(key);

    const key2 = pasted("ok");
    w.treg.fetch.mockImplementation(async (input: any, init: any) => {
      if (String(input).includes("/call/")) throw Object.assign(new Error(`connect ECONNRESET while sending token ${key2}`), { name: "Error" });
      return realFetch(input, init);
    });
    const out2 = await checkPastedKey(deps(), { adminId: ADMIN, key: key2 });
    expect(out2.report?.verdict).toBe("unknown");
    expect(out2.report?.providerText).toBe("connect ECONNRESET while sending token [REDACTED]");
    for (const where of [JSON.stringify(out2), logs.text()]) expect(where).not.toContain(key2);
  });

  it("the audit row names the action only: no key, no last 4, no other detail", async () => {
    const key = pasted("ok");
    await checkPastedKey(deps(), { adminId: ADMIN, key });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: ADMIN, action: "key", target_type: KEY_CHECK_LIMITS.pasted.targetType, details: { label: "فحص مفتاح TREG ملصوق" } });
    expect(Object.keys(audit[0].details)).toEqual(["label"]);
  });
});

describe("rate limit: 5 pasted checks per admin per hour, durable", () => {
  it("the 6th is refused with 429 before anything is sent; a restart (new instance) does not reset it; an hour later it does", async () => {
    for (let i = 0; i < KEY_CHECK_LIMITS.pasted.max; i++) expect((await checkPastedKey(deps(), { adminId: ADMIN, key: pasted("ok") })).ok).toBe(true);
    const sent = w.treg.requests.length;
    expect(await checkPastedKey(deps(), { adminId: ADMIN, key: pasted("ok") })).toMatchObject({ ok: false, reason: "rate_limited", status: 429 });
    expect(w.treg.requests.length).toBe(sent);
    __resetCheckLimiter();                                                   // another server instance / a restart: the audit table still remembers
    expect(await checkPastedKey(deps(), { adminId: ADMIN, key: pasted("ok") })).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(audit).toHaveLength(KEY_CHECK_LIMITS.pasted.max);
    clock.advance(KEY_CHECK_LIMITS.pasted.windowMs + 1_000);
    __resetCheckLimiter();
    expect((await checkPastedKey(deps(), { adminId: ADMIN, key: pasted("ok") })).ok).toBe(true);
  });

  it("is per admin", async () => {
    for (let i = 0; i < KEY_CHECK_LIMITS.pasted.max; i++) await checkPastedKey(deps(), { adminId: ADMIN, key: pasted("ok") });
    expect((await checkPastedKey(deps(), { adminId: "admin-2", key: pasted("ok") })).ok).toBe(true);
  });

  it("when the audit table cannot be read the per-instance limit still holds", async () => {
    state.client = { ...w.db.client, from: () => { throw new Error("table unreachable"); } };
    for (let i = 0; i < KEY_CHECK_LIMITS.pasted.max; i++) expect((await checkPastedKey(deps(), { adminId: ADMIN, key: pasted("ok") })).ok).toBe(true);
    expect((await checkPastedKey(deps(), { adminId: ADMIN, key: pasted("ok") })).reason).toBe("rate_limited");
  });
});

describe("«افحص الآن» on a pool key: the same three steps on the stored key, recorded on it", () => {
  const poolWorld = (mode: TregMode, over: Partial<{ balanceMicro: number }> = {}) => {
    const main = w.addKey({ isMain: true });
    const k = w.addKey({ tregMode: mode, ...over });
    w.switchOn(k.id);
    return { main, k };
  };
  const run = (keyId: string) => checkPoolKeyNow(deps(), { adminId: ADMIN, keyId });

  it("a working key is recorded «connected» (reason: a data call answered), its call is marked with the key, and its last answered call shows", async () => {
    const { k } = poolWorld("ok");
    w.db.byId(k.id)!.status = "unknown";
    const out = await run(k.id);
    expect(out).toMatchObject({ ok: true, report: { verdict: "works", statusAr: "يعمل" } });
    expect(w.db.byId(k.id)).toMatchObject({ status: "connected", status_reason: "data_call_ok" });
    expect([...w.db.calls.values()].filter((c) => c.key_number === k.number)).toHaveLength(1);
    const health = (await w.db.client.rpc("treg_pool_call_health", {})).data;
    expect(health).toEqual([expect.objectContaining({ key_number: k.number, failed_since_ok: 0 })]);
    expect(health[0].last_ok_at).not.toBeNull();
  });

  it("the incident: «org suspended» on the ACTIVE key is recorded revoked/org_suspended and the pool moves to main at once", async () => {
    const { main, k } = poolWorld("suspended403", { balanceMicro: 912_244 });
    const out = await run(k.id);
    expect(out.report).toMatchObject({ verdict: "suspended", statusAr: "الحساب موقوف", providerText: "org suspended" });
    expect(w.db.byId(k.id)).toMatchObject({ status: "revoked", status_reason: "org_suspended" });
    expect(w.db.state.active_key_id).toBe(main.id);
    expect(w.db.events.filter((e) => e.kind === "failover")).toHaveLength(1);
  });

  it("a refusal proved by the data call is stored as data_403 (a free read cannot clear it later)", async () => {
    const { k } = poolWorld("forbid403");
    await run(k.id);
    expect(w.db.byId(k.id)).toMatchObject({ status: "revoked", status_reason: "data_403" });
  });

  it("an empty account is recorded out_of_balance; an inconclusive check records nothing and keeps what the key had", async () => {
    const a = poolWorld("empty", { balanceMicro: 5_000 });
    await run(a.k.id);
    expect(w.db.byId(a.k.id)).toMatchObject({ status: "out_of_balance", status_reason: "balance_low:crawl4ai.google.serp.news" });
    teardownPoolWorld(); w = makePoolWorld(); state.client = withAudit(w.db.client);
    const b = poolWorld("http503");
    w.db.byId(b.k.id)!.status_reason = "http_402"; w.db.byId(b.k.id)!.status = "out_of_balance";
    const before = w.db.rpcCount("treg_pool_record_check");
    await run(b.k.id);
    expect(w.db.rpcCount("treg_pool_record_check")).toBe(before);
    expect(w.db.byId(b.k.id)).toMatchObject({ status: "out_of_balance", status_reason: "http_402" });
  });

  it("the stored key is read and decrypted on the server and never leaves it: not in the answer, the console, an rpc argument or a URL", async () => {
    const { k } = poolWorld("ok");
    const out = await run(k.id);
    expect(JSON.stringify(out)).not.toContain(k.plaintext);
    for (const where of secretly(k.plaintext)) expect(where).not.toContain(k.plaintext);
    expect(w.treg.requests.every((r) => r.token === k.plaintext)).toBe(true);   // only that key was used
    expect(decryptPoolKey(w.db.encKey, k.id, w.db.byId(k.id)!.ciphertext!)).toBe(k.plaintext);
  });

  it("refuses a bad id, an unknown key, a missing SQL 06 and an unreadable Vault key, and is limited to 20 an hour", async () => {
    poolWorld("ok");
    expect(await run("nope")).toMatchObject({ ok: false, status: 400 });
    w.db.flags.encMissing = true;                                          // before the Vault key is first read (the pool keeps it 10 minutes once it has it)
    expect(await run("00000000-0000-4000-8000-000000000000")).toMatchObject({ ok: false, reason: "encryption_unavailable", status: 503 });
    w.db.flags.encMissing = false;
    expect(await run("00000000-0000-4000-8000-000000000000")).toMatchObject({ ok: false, reason: "unknown_key", status: 404 });
    w.db.flags.noCheckFn = true;
    expect(await run("00000000-0000-4000-8000-000000000000")).toMatchObject({ ok: false, reason: "sql_not_ready", status: 409 });
    w.db.flags.noCheckFn = false;
    __resetCheckLimiter(); audit.length = 0;
    for (let i = 0; i < KEY_CHECK_LIMITS.pool.max; i++) await run("00000000-0000-4000-8000-000000000000");
    expect(await run("00000000-0000-4000-8000-000000000000")).toMatchObject({ ok: false, reason: "rate_limited", status: 429 });
  });
});

describe("the route: admin only, and the answer carries the verdict and nothing else", () => {
  const req = (body: unknown) => new NextRequest("http://localhost/api/admin/treg-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("signed out 401, a customer 403: nothing is sent, nothing is read, nothing is audited", async () => {
    const key = pasted("ok");
    for (const user of [null, { id: "u1", email: "customer@example.com", app_metadata: {}, user_metadata: {} }]) {
      state.user = user;
      const res = await POST(req({ action: "check_key", key }));
      expect(res.status).toBe(user ? 403 : 401);
      expect(await res.text()).not.toContain(key);
      expect((await POST(req({ action: "check_pool_key", keyId: "00000000-0000-4000-8000-000000000000" }))).status).toBe(user ? 403 : 401);
    }
    expect(w.treg.requests).toHaveLength(0);
    expect(w.db.rpcLog).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it("an admin gets الحالة and the rest, never the key, the account e-mail or the internal record", async () => {
    const key = pasted("suspended403", { balanceMicro: 912_244 });
    const res = await POST(req({ action: "check_key", key }));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = JSON.parse(text);
    expect(body).toMatchObject({ success: true, report: { verdict: "suspended", statusAr: "الحساب موقوف", balanceUsd: 0.912244, providerText: "org suspended" } });
    expect(Object.keys(body.report).sort()).toEqual(["balanceUsd", "costUsd", "noteAr", "providerText", "steps", "statusAr", "verdict"].sort());
    expect(text).not.toContain(key);
    expect(text).not.toMatch(/acct@example\.test|record|last4|ciphertext/);
    for (const where of secretly(key)) expect(where).not.toContain(key);
  });

  it("the 6th check in an hour is 429 with a fixed Arabic sentence; a malformed key is 400", async () => {
    for (let i = 0; i < KEY_CHECK_LIMITS.pasted.max; i++) expect((await POST(req({ action: "check_key", key: pasted("ok") }))).status).toBe(200);
    const limited = await POST(req({ action: "check_key", key: pasted("ok") }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ success: false, error: "تجاوزت عدد الفحوص المسموح به في الساعة. حاول بعد قليل." });
    __resetCheckLimiter(); audit.length = 0;
    expect((await POST(req({ action: "check_key", key: "short" }))).status).toBe(400);
  });

  it("an unexpected failure answers with a fixed sentence that carries nothing of the request", async () => {
    const key = pasted("ok");
    state.client = { ...state.client, from: () => { throw new Error(`boom ${key}`); }, rpc: () => { throw new Error(`boom ${key}`); } };
    const res = await POST(req({ action: "check_key", key }));
    expect([200, 500]).toContain(res.status);
    expect(await res.text()).not.toContain(key);
    expect(logs.text()).not.toContain(key);
  });
});
