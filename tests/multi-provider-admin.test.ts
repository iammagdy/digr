import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, fakeKey, fakeKeyStore, mockProviderFetch, newEncryptionKey } from "./helpers/providerKeyTestKit";

const state = vi.hoisted(() => ({ user: null as any, adminClient: null as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.adminClient),
}));

import { GET as keysGet, POST as keysPost } from "../src/app/api/admin/provider-keys/route";
import { GET as callsGet } from "../src/app/api/admin/provider-calls/route";
import { GET as limitsGet } from "../src/app/api/admin/provider-limits/route";
import { __resetKeyChangeLimiter, loadProviderTabState, replaceProviderKey, rollbackProviderKey, isProviderId } from "../src/lib/server/providerKeyAdmin";
import { __setProviderKeyStoreForTests, readEnvProviderKey, resetProviderKeyCache, resolveProviderKey } from "../src/lib/server/providerKeys";
import { invalidateProviderStatusCache, parseContextDevCredits, parseFirecrawlCredits, getProviderStatus } from "../src/lib/server/providerStatus";
import { flushProviderLimitsCache, validateLimitsInput } from "../src/lib/server/providerLimits";
import { saveProviderLimits } from "../src/lib/server/providerLimitsAdmin";
import { resolveProviderDailyCapUsd, resolveAllProviderDailyCaps, readProviderSpendToday } from "../src/lib/server/multiProvider/providerCaps";
import { CALL_LOG_PAGE_SIZE, parseCallLogQuery, readProviderCallLog } from "../src/lib/server/multiProvider/callLog";
import { createFakeFetch, defaultFakeWorld } from "../src/lib/server/multiProvider/fakeTransport";

const ADMIN = { id: "admin-1", email: "a@t", app_metadata: { role: "admin" }, user_metadata: { name: "مدير" } };
const req = (method: string, url: string, body?: unknown) => new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

// ---- a read-only cost table: every operation it is asked to perform is recorded ----------------------------------------------
interface CostRow { id: number; provider: string; job_id: string | null; units: number; cost_usd: number; created_at: string; is_estimate: boolean; capability?: string | null; status?: string | null; duration_ms?: number | null }
function costsClient(rows: CostRow[], options: { metadata?: boolean; settings?: Record<string, any> } = {}) {
  const ops: string[] = [];
  const metadata = options.metadata !== false;
  const client: any = {
    from: (table: string) => {
      ops.push(`from:${table}`);
      const filters: Array<(r: any) => boolean> = [];
      let cols = ""; let wantCount = false; let order: { c: string; asc: boolean } | null = null; let lim: number | null = null; let off = 0;
      const run = async (single = false) => {
        if (table === "settings_private") { const k = (filters as any).key; const v = options.settings?.[k]; return { data: v === undefined ? null : { value: v }, error: null }; }
        if (table === "provider_costs" && !metadata && /capability|status|duration_ms/.test(cols)) return { data: null, error: { code: "42703", message: 'column "capability" does not exist' } };
        let matched = rows.filter((r) => filters.every((f) => f(r)));
        const total = matched.length;
        if (order) { const { c, asc } = order; matched = [...matched].sort((a: any, b: any) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1)); }
        if (lim !== null) matched = matched.slice(off, off + lim);
        return single ? { data: matched[0] ?? null, error: null } : { data: matched, error: null, ...(wantCount ? { count: total } : {}) };
      };
      const b: any = {
        select: (c: string, o?: { count?: string }) => { ops.push("select"); cols = c; wantCount = o?.count === "exact"; return b; },
        eq: (c: string, v: any) => { if (table === "settings_private" && c === "key") (filters as any).key = v; filters.push((r) => r[c] === v); return b; },
        gte: (c: string, v: any) => { filters.push((r) => r[c] >= v); return b; },
        lt: (c: string, v: any) => { filters.push((r) => r[c] < v); return b; },
        in: (c: string, vs: any[]) => { filters.push((r) => vs.includes(r[c])); return b; },
        order: (c: string, o?: { ascending?: boolean }) => { order = { c, asc: o?.ascending !== false }; return b; },
        limit: (n: number) => { lim = n; return b; },
        range: (a: number, z: number) => { off = a; lim = z - a + 1; return b; },
        maybeSingle: () => run(true),
        insert: () => { ops.push("insert"); return b; }, update: () => { ops.push("update"); return b; }, upsert: () => { ops.push("upsert"); return b; }, delete: () => { ops.push("delete"); return b; },
        then: (resolve: any, reject: any) => run().then(resolve, reject),
      };
      return b;
    },
    rpc: async (name: string) => { ops.push(`rpc:${name}`); return { data: null, error: null }; },
  };
  return { client, ops };
}

const day = (d: string, h = 10) => `${d}T${String(h).padStart(2, "0")}:00:00.000Z`;
function seedRows(): CostRow[] {
  const rows: CostRow[] = [];
  let id = 1;
  const add = (provider: string, n: number, base: Partial<CostRow>) => { for (let i = 0; i < n; i += 1) rows.push({ id: id++, provider, job_id: `job_${provider}_${i}`, units: 1, cost_usd: 0.005, created_at: day("2026-10-21", 8 + (i % 10)), is_estimate: false, capability: `${provider}.scrape`, status: "success", duration_ms: 100 + i, ...base }); };
  add("firecrawl", 30, {});
  add("contextdev", 7, { cost_usd: 0.00254, capability: "contextdev.search" });
  add("treg", 5, { cost_usd: 0.0123, capability: null, status: null, duration_ms: null });
  rows.push({ id: id++, provider: "firecrawl", job_id: null, units: 0, cost_usd: 0, created_at: day("2026-10-22", 9), is_estimate: false, capability: "firecrawl.scrape", status: "failed", duration_ms: 12 });
  rows.push({ id: id++, provider: "firecrawl", job_id: "job_x", units: 0, cost_usd: 0, created_at: day("2026-10-22", 11), is_estimate: false, capability: "firecrawl.search", status: "empty", duration_ms: 30 });
  return rows;
}

describe("the per-provider call log reads only that provider's rows, and its totals are the table's totals", () => {
  const rows = seedRows();
  const now = new Date("2026-10-22T12:00:00.000Z");

  it("every provider's tab lists only rows with its own identifier, newest first, 25 per page", async () => {
    for (const provider of ["firecrawl", "contextdev", "treg"] as const) {
      const { client } = costsClient(rows);
      const log = await readProviderCallLog(client, { provider }, now);
      const mine = rows.filter((r) => r.provider === provider);
      expect(log.total).toBe(mine.length);
      expect(log.rows.length).toBe(Math.min(CALL_LOG_PAGE_SIZE, mine.length));
      expect(log.rows.every((r) => mine.some((m) => m.id === r.id))).toBe(true);
      const times = log.rows.map((r) => r.at);
      expect([...times].sort().reverse()).toEqual(times);
    }
    const { client } = costsClient(rows);
    const p1 = await readProviderCallLog(client, { provider: "firecrawl", page: 1 }, now);
    const p2 = await readProviderCallLog(client, { provider: "firecrawl", page: 2 }, now);
    expect(p1.rows).toHaveLength(25);
    expect(p2.rows).toHaveLength(32 - 25);
    expect(new Set([...p1.rows, ...p2.rows].map((r) => r.id)).size).toBe(32);
  });

  it("the daily and total cost summary are sums of the same rows of the same provider (to the last decimal)", async () => {
    for (const provider of ["firecrawl", "contextdev", "treg"] as const) {
      const { client } = costsClient(rows);
      const log = await readProviderCallLog(client, { provider }, now);
      const mine = rows.filter((r) => r.provider === provider);
      const total = mine.reduce((a, r) => a + r.cost_usd, 0);
      expect(log.summary.totalUsd).toBeCloseTo(total, 9);
      expect(log.summary.totalCalls).toBe(mine.length);
      expect(log.summary.todayUsd).toBeCloseTo(mine.filter((r) => r.created_at >= "2026-10-22T00:00:00.000Z").reduce((a, r) => a + r.cost_usd, 0), 9);
      expect(log.summary.daily.reduce((a, d) => a + d.costUsd, 0)).toBeCloseTo(total, 9);
      expect(log.summary.daily.reduce((a, d) => a + d.calls, 0)).toBe(mine.length);
    }
  });

  it("filters by date and by status; each row carries the Arabic internal label, the status and the duration", async () => {
    const { client } = costsClient(rows);
    const failed = await readProviderCallLog(client, { provider: "firecrawl", status: "failed" }, now);
    expect(failed.total).toBe(1);
    expect(failed.rows[0]).toMatchObject({ status: "failed", costUsd: 0, durationMs: 12, capabilityLabelAr: "قراءة صفحة (Firecrawl)" });
    const empty = await readProviderCallLog(client, { provider: "firecrawl", status: "empty" }, now);
    expect(empty.rows[0]).toMatchObject({ status: "empty", capabilityLabelAr: "بحث الويب (Firecrawl)" });
    const today = await readProviderCallLog(client, { provider: "firecrawl", from: "2026-10-22", to: "2026-10-22" }, now);
    expect(today.total).toBe(2);
    const yesterday = await readProviderCallLog(client, { provider: "firecrawl", from: "2026-10-21", to: "2026-10-21" }, now);
    expect(yesterday.total).toBe(30);
    expect((await readProviderCallLog(client, { provider: "contextdev", from: "2026-10-22" }, now)).total).toBe(0);
  });

  it("before the database update the log still lists every call and says «غير متاح» (null) for what the table cannot know; the status filter is not applied", async () => {
    const { client } = costsClient(rows, { metadata: false });
    const log = await readProviderCallLog(client, { provider: "firecrawl", status: "failed" }, now);
    expect(log.metadataAvailable).toBe(false);
    expect(log.statusFilterUnavailable).toBe(true);
    expect(log.total).toBe(32);
    for (const r of log.rows) expect(r).toMatchObject({ capabilityLabelAr: null, status: null, durationMs: null });
    expect(log.rows[0].costUsd).toBeGreaterThanOrEqual(0);
  });

  it("TREG's rows written the existing way (no capability, status or duration) show «غير متاح» for those, never a guess", async () => {
    const { client } = costsClient(rows);
    const log = await readProviderCallLog(client, { provider: "treg" }, now);
    for (const r of log.rows) expect(r).toMatchObject({ capabilityLabelAr: null, status: null, durationMs: null });
  });

  it("is read only: it performs selects and nothing else", async () => {
    const { client, ops } = costsClient(rows);
    await readProviderCallLog(client, { provider: "firecrawl" }, now);
    await resolveProviderDailyCapUsd(client, "firecrawl").catch(() => 0);
    await readProviderSpendToday(client, "firecrawl");
    expect(ops.filter((o) => ["insert", "update", "upsert", "delete"].includes(o) || o.startsWith("rpc:"))).toEqual([]);
  });

  it("validates its query: provider, dates, status, page", () => {
    const parse = (q: string) => parseCallLogQuery(new URLSearchParams(q));
    expect(parse("provider=firecrawl&page=2&status=failed&from=2026-10-01&to=2026-10-22")).toMatchObject({ ok: true, value: { provider: "firecrawl", page: 2, status: "failed" } });
    expect(parse("provider=anthropic")).toMatchObject({ ok: false });
    expect(parse("provider=treg&from=22/10/2026")).toMatchObject({ ok: false });
    expect(parse("provider=treg&status=weird")).toMatchObject({ ok: false });
    expect(parse("provider=treg&page=-4")).toMatchObject({ ok: true, value: { page: 1 } });
  });
});

describe("/api/admin/provider-calls is admin only and leaks nothing to anyone else", () => {
  beforeEach(() => { state.adminClient = costsClient(seedRows()).client; });
  it("401 signed out, 403 for a non-admin, 400 for a bad query, 200 with the log for an admin", async () => {
    state.user = null;
    expect((await callsGet(req("GET", "/api/admin/provider-calls?provider=firecrawl"))).status).toBe(401);
    state.user = { id: "u1", email: "u@t", app_metadata: {} };
    const denied = await callsGet(req("GET", "/api/admin/provider-calls?provider=firecrawl"));
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).not.toMatch(/firecrawl|capability|cost|usd/i);
    state.user = ADMIN;
    expect((await callsGet(req("GET", "/api/admin/provider-calls?provider=nope"))).status).toBe(400);
    const res = await callsGet(req("GET", "/api/admin/provider-calls?provider=contextdev"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.log.provider).toBe("contextdev");
    expect(body.log.total).toBe(7);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("Firecrawl and Context.dev in the key store and the status read", () => {
  let logs: ReturnType<typeof captureConsole>;
  let store: ReturnType<typeof fakeKeyStore>;
  beforeEach(() => {
    vi.stubEnv("PROVIDER_KEYS_ENCRYPTION_KEY", newEncryptionKey());
    for (const name of ["TREG_TOKEN", "TREG_API_KEY", "FIRECRAWL_API_KEY", "CONTEXT_DEV_API_KEY"]) vi.stubEnv(name, "");
    store = fakeKeyStore({ admins: ["admin-1"] });
    state.adminClient = store.client; state.user = ADMIN;
    __setProviderKeyStoreForTests(store.client); __resetKeyChangeLimiter(); invalidateProviderStatusCache(); flushProviderLimitsCache();
    logs = captureConsole();
  });
  afterEach(() => { logs.restore(); __setProviderKeyStoreForTests(null); resetProviderKeyCache(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("the two providers are known ids; the key store reads their keys from the store first, then FIRECRAWL_API_KEY / CONTEXT_DEV_API_KEY", async () => {
    expect(isProviderId("firecrawl")).toBe(true);
    expect(isProviderId("contextdev")).toBe(true);
    expect(isProviderId("openai")).toBe(false);
    vi.stubEnv("FIRECRAWL_API_KEY", " \"fc-env-key-0123456789\" ");
    vi.stubEnv("CONTEXT_DEV_API_KEY", "cx-env-key-0123456789");
    expect(readEnvProviderKey("firecrawl")).toBe("fc-env-key-0123456789");
    expect(readEnvProviderKey("contextdev")).toBe("cx-env-key-0123456789");
    expect(await resolveProviderKey("firecrawl")).toMatchObject({ source: "env", last4: "6789" });
    const key = fakeKey("fc");
    store.seed("firecrawl", key);
    expect(await resolveProviderKey("firecrawl", { forceRefresh: true })).toMatchObject({ source: "store", key });
  });

  it("set: the key is validated with the provider's FREE credit read BEFORE saving, stored encrypted, audited with the last 4 only; a rejected key is not saved", async () => {
    const good = fakeKey("firecrawl");
    const fetchOk = createFakeFetch(defaultFakeWorld(2), { validKey: good });
    const saved = await replaceProviderKey({ client: store.client, fetchFn: fetchOk }, { adminId: "admin-1", provider: "firecrawl", newKey: good });
    expect(saved).toMatchObject({ ok: true, last4: good.slice(-4) });
    expect(fetchOk.log.map((l) => `${l.provider}:${l.operation}`)).toEqual(["firecrawl:usage"]);
    expect(store.audit).toEqual([{ provider: "firecrawl", action: "set", last4: good.slice(-4), actor_id: "admin-1" }]);
    expect(JSON.stringify([...store.rows.values()])).not.toContain(good);
    const bad = fakeKey("wrong");
    const rejected = await replaceProviderKey({ client: store.client, fetchFn: createFakeFetch(defaultFakeWorld(2), { validKey: good }) }, { adminId: "admin-1", provider: "contextdev", newKey: bad });
    expect(rejected).toMatchObject({ ok: false, reason: "validation_rejected" });
    expect(store.rows.has("contextdev")).toBe(false);
    expect(logs.text()).not.toContain(good);
    expect(logs.text()).not.toContain(bad);
  });

  it("rollback returns to the previous key for the new providers, audited", async () => {
    const k1 = fakeKey("one"); const k2 = fakeKey("two");
    const f = createFakeFetch(defaultFakeWorld(2));
    expect((await replaceProviderKey({ client: store.client, fetchFn: f }, { adminId: "admin-1", provider: "contextdev", newKey: k1 })).ok).toBe(true);
    expect((await replaceProviderKey({ client: store.client, fetchFn: f }, { adminId: "admin-1", provider: "contextdev", newKey: k2 })).ok).toBe(true);
    const back = await rollbackProviderKey({ client: store.client, fetchFn: f }, { adminId: "admin-1", provider: "contextdev" });
    expect(back).toMatchObject({ ok: true, last4: k1.slice(-4) });
    expect(store.audit.map((a) => `${a.provider}:${a.action}`)).toEqual(["contextdev:set", "contextdev:set", "contextdev:rollback"]);
  });

  it("the keys route accepts the new providers (admin only) and answers with their real state", async () => {
    const key = fakeKey("route");
    vi.stubGlobal("fetch", createFakeFetch(defaultFakeWorld(2), { creditsRemaining: 4321 }));
    const post = await keysPost(req("POST", "/api/admin/provider-keys", { action: "replace", provider: "firecrawl", key }));
    expect(post.status).toBe(200);
    const get = await keysGet(req("GET", "/api/admin/provider-keys?provider=firecrawl&refresh=1"));
    const body = await get.json();
    expect(body.state).toMatchObject({ provider: "firecrawl", keySource: "store", last4: key.slice(-4), status: { balance: { available: true, credits: 4321, planCredits: 5000 } }, lowBalance: false, spend: { capKind: "provider_daily", capUsd: 0 } });
    expect(JSON.stringify(body)).not.toContain(key);
    expect((await keysGet(req("GET", "/api/admin/provider-keys?provider=nope"))).status).toBe(400);
    state.user = { id: "u1", email: "u@t", app_metadata: {} };
    expect((await keysGet(req("GET", "/api/admin/provider-keys?provider=firecrawl"))).status).toBe(403);
  });

  it("the real credit count is the provider's own number; when the provider cannot give one the tab says so («غير متاح» reasons), and no estimate is ever shown", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-env-key-0123456789"); vi.stubEnv("CONTEXT_DEV_API_KEY", "cx-env-key-0123456789");
    const ok = await getProviderStatus("contextdev", "cx-env-key-0123456789", { forceRefresh: true, fetchFn: createFakeFetch(defaultFakeWorld(1), { creditsRemaining: 777 }) });
    expect(ok.balance).toMatchObject({ available: true, credits: 777, creditsUsedThisPeriod: 100, periodEndsAt: "2026-11-01T00:00:00Z" });
    expect(ok.balance.balanceUsd).toBeUndefined();
    const down = await getProviderStatus("firecrawl", "fc-env-key-0123456789", { forceRefresh: true, fetchFn: createFakeFetch(defaultFakeWorld(1), { failProvider: { firecrawl: 500 } }) });
    expect(down.health).toMatchObject({ ok: false, reason: "server_error" });
    expect(down.balance).toMatchObject({ available: false, unavailableReason: "check_failed" });
    expect(down.balance.credits).toBeUndefined();
    const noKey = await getProviderStatus("contextdev", "", { forceRefresh: true });
    expect(noKey.balance).toMatchObject({ available: false, unavailableReason: "no_key" });
    const mock = mockProviderFetch(() => ({ status: 200, body: { unrelated: true } }));
    const odd = await getProviderStatus("firecrawl", "fc-env-key-0123456789", { forceRefresh: true, fetchFn: mock.fn });
    expect(odd.balance).toMatchObject({ available: false, unavailableReason: "unreadable" });
    expect(parseFirecrawlCredits({ data: { remainingCredits: -5 } })).toBeNull();
    expect(parseContextDevCredits({ credits_remaining: "12" })).toBeNull();
    expect(parseFirecrawlCredits({ data: { remainingCredits: 0 } })).toMatchObject({ credits: 0 });
  });

  it("the tab state of a data provider is read from its OWN cost rows and its OWN daily cap; with no cap set it says nothing may be spent", async () => {
    const rows = seedRows();
    const { client } = costsClient(rows, { settings: { provider_limits: { dailyUsd: 0.8, firecrawlDailyUsd: 2 } } });
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-env-key-0123456789"); vi.stubEnv("CONTEXT_DEV_API_KEY", "cx-env-key-0123456789");
    const fetchFn = createFakeFetch(defaultFakeWorld(1));
    const fc = await loadProviderTabState({ client, fetchFn }, "firecrawl", { forceRefresh: true });
    expect(fc.spend.capUsd).toBe(2);
    expect(fc.activity.length).toBeGreaterThan(0);
    expect(fc.noticesAr.join(" ")).not.toMatch(/لم يُضبط حد يومي/);
    const cx = await loadProviderTabState({ client, fetchFn }, "contextdev", { forceRefresh: true });
    expect(cx.spend.capUsd).toBe(0);
    expect(cx.noticesAr.join(" ")).toMatch(/لم يُضبط حد يومي/);
    expect(cx.noticesAr.join(" ")).toMatch(/logs:read/);
    expect(cx.lowBalance).toBe(false);
  });
});

describe("per-provider daily limits (admin-editable, audited by the approved SQL function)", () => {
  beforeEach(() => flushProviderLimitsCache());
  it("validates the two new limits like the existing daily limit (Arabic digits, no negatives, no text)", () => {
    expect(validateLimitsInput({ firecrawlDailyUsd: "٢٫٥" })).toEqual({ ok: true, value: { firecrawlDailyUsd: 2.5 } });
    expect(validateLimitsInput({ contextdevDailyUsd: 0 })).toEqual({ ok: true, value: { contextdevDailyUsd: 0 } });
    expect(validateLimitsInput({ firecrawlDailyUsd: -1 })).toMatchObject({ ok: false });
    expect(validateLimitsInput({ contextdevDailyUsd: "abc" })).toMatchObject({ ok: false });
    expect(validateLimitsInput({ contextdevDailyUsd: 1e13 })).toMatchObject({ ok: false });
    expect(validateLimitsInput({ dailyUsd: 1 })).toEqual({ ok: true, value: { dailyUsd: 1 } }); // existing behaviour untouched
  });

  it("saves through admin_set_provider_limits_atomic with the admin id and only the validated keys; before the SQL proposal it says the store is not ready", async () => {
    const calls: any[] = [];
    const ready = { rpc: async (name: string, args: any) => { calls.push({ name, args }); return { data: { success: true, limits: args.p_limits }, error: null }; } };
    expect(await saveProviderLimits({ client: ready }, { adminId: "admin-1", limits: { firecrawlDailyUsd: "2", evil: 99 } as any })).toMatchObject({ ok: true });
    expect(calls).toEqual([{ name: "admin_set_provider_limits_atomic", args: { p_admin_id: "admin-1", p_limits: { firecrawlDailyUsd: 2 } } }]);
    const old = { rpc: async () => ({ data: { success: false, error: "unknown_key", error_ar: "إعداد غير معروف." }, error: null }) };
    expect(await saveProviderLimits({ client: old }, { adminId: "admin-1", limits: { contextdevDailyUsd: 1 } })).toMatchObject({ ok: false, reason: "store_not_ready", status: 409 });
  });

  it("a provider's cap is read from the settings row; TREG keeps the existing dailyUsd; an unset provider is 0 (no spend)", async () => {
    const { client } = costsClient([], { settings: { provider_limits: { dailyUsd: 0.8, firecrawlDailyUsd: 2.5 } } });
    expect(await resolveProviderDailyCapUsd(client, "treg")).toBe(0.8);
    expect(await resolveProviderDailyCapUsd(client, "firecrawl")).toBe(2.5);
    expect(await resolveProviderDailyCapUsd(client, "contextdev")).toBe(0);
    expect(await resolveAllProviderDailyCaps(client)).toEqual({ treg: 0.8, firecrawl: 2.5, contextdev: 0 });
    const garbage = costsClient([], { settings: { provider_limits: { firecrawlDailyUsd: "lots", contextdevDailyUsd: -3 } } });
    expect(await resolveProviderDailyCapUsd(garbage.client, "firecrawl")).toBe(0);
    expect(await resolveProviderDailyCapUsd(garbage.client, "contextdev")).toBe(0);
  });

  it("the limits route answers with the existing state AND the two extra daily limits with their recorded spend today", async () => {
    state.user = ADMIN;
    const today = new Date().toISOString().slice(0, 10);
    const rows: CostRow[] = [{ id: 1, provider: "firecrawl", job_id: null, units: 1, cost_usd: 0.25, created_at: `${today}T01:00:00.000Z`, is_estimate: false }];
    state.adminClient = costsClient(rows, { settings: { provider_limits: { firecrawlDailyUsd: 2 } } }).client;
    const res = await limitsGet(req("GET", "/api/admin/provider-limits"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.extra).toEqual({ firecrawl: { dailyUsd: 2, todayUsd: 0.25 }, contextdev: { dailyUsd: 0, todayUsd: 0 } });
    expect(body.state.limits.dailyUsd).toBeTypeOf("number");
  });
});
