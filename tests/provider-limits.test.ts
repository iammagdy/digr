import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A. Provider spend limits editable from the admin dashboard: resolver order and cache, fallback to 0.80, validation,
 * the worker honouring a changed limit and the per-job / per-user ceilings, non-admin refusal, audit, huge values, and
 * the warning at the threshold. The SQL function and trigger are tested for real in tests/sql/provider-limits.local-pg.
 */
const state = vi.hoisted(() => ({
  user: { id: "admin_1", app_metadata: { role: "admin" }, email: "a@t", user_metadata: {} } as any,
  settings: {} as Record<string, any>,
  settingsReadFails: false,
  reads: 0,
  rpc: [] as Array<{ name: string; args: any }>,
  rpcImpl: null as null | ((name: string, args: any) => any),
  jobs: [] as any[], quotes: [] as any[], costs: [] as any[],
  partials: new Map<string, Buffer>(), results: new Map<string, Buffer>(), events: [] as any[],
  step: 0, cursor: null as string | null, delivered: 0,
}));

function table(rows: () => any[], onRead?: () => void) {
  const filters: Array<[string, unknown]> = [];
  const ins: Array<[string, unknown[]]> = [];
  const apply = () => rows().filter((r) => filters.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c])));
  const api: any = {
    select: () => api, eq: (c: string, v: unknown) => { filters.push([c, v]); return api; }, gte: () => api,
    in: (c: string, vs: unknown[]) => { ins.push([c, vs]); return api; }, or: () => api, not: () => api, order: () => api, limit: () => api,
    maybeSingle: async () => { onRead?.(); return { data: apply()[0] ?? null, error: null }; },
    then: (res: any, rej: any) => Promise.resolve({ data: apply(), error: null }).then(res, rej),
  };
  return api;
}

function fakeClient() {
  return {
    rpc: vi.fn(async (name: string, args: any) => {
      state.rpc.push({ name, args });
      if (state.rpcImpl) { const r = state.rpcImpl(name, args); if (r !== undefined) return r; }
      if (name === "claim_job_chunk") return { data: { claimed: true, job_id: args.p_job_id, user_id: "user_1", step: state.step, current_cursor: state.cursor, delivered_units: state.delivered, target_volume_max: 2, target_volume_min: 1, endpoint_id: "icypeas.companies.search", unit_price: 2 }, error: null };
      if (name === "reserve_provider_spend_atomic") return { data: { allowed: true, cost_id: 11 }, error: null };
      if (name === "complete_chunk") { state.step += 1; state.delivered = args.p_new_delivered_units; state.cursor = args.p_new_cursor; return { data: { success: true, delivered_units: state.delivered }, error: null }; }
      if (name === "release_job_atomic") return { data: { success: true, released_credits: 6 }, error: null };
      return { data: { success: true }, error: null };
    }),
    storage: { from: (bucket: string) => { const s = bucket === "partials" ? state.partials : state.results; return {
      upload: async (p: string, b: any) => { s.set(p, Buffer.from(b)); return { data: { path: p }, error: null }; },
      download: async (p: string) => { const b = s.get(p); return b ? { data: new Blob([new Uint8Array(b)]), error: null } : { data: null, error: { message: "nf" } }; },
      remove: async () => ({ data: [], error: null }),
    }; } },
    from: (t: string) => {
      if (t === "settings_private") {
        return table(() => (state.settingsReadFails ? (() => { throw new Error("db down"); })() : Object.entries(state.settings).map(([key, value]) => ({ key, value }))), () => { state.reads += 1; });
      }
      if (t === "jobs") return table(() => state.jobs);
      if (t === "plans_quotes") return table(() => state.quotes);
      if (t === "provider_costs") return table(() => state.costs);
      if (t === "job_events" || t === "notifications" || t === "artifact_versions") {
        const base = table(() => (t === "job_events" ? state.events : []));
        return { ...base, insert: async (row: any) => { if (t === "job_events") state.events.push(row); return { data: row, error: null }; }, upsert: async (row: any) => ({ data: row, error: null }) };
      }
      return table(() => []);
    },
  };
}

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => fakeClient()),
}));
vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: vi.fn(async () => undefined), getRecipient: vi.fn(async () => null) }));
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null), searchCatalog: vi.fn(async () => []),
}));

import {
  CEILING_MESSAGE_AR, PROVIDER_LIMITS_CACHE_TTL_MS, defaultProviderLimits, evaluateSpendCeilings, flushProviderLimitsCache,
  parseLimitNumber, resolveProviderLimits, spendLevel, validateLimitsInput,
} from "../src/lib/server/providerLimits";
import { auditSummaryAr, saveProviderLimits } from "../src/lib/server/providerLimitsAdmin";
import { checkProviderDailySpendCap, getProviderBalanceStatus, resetProviderBalanceCacheForTesting } from "../src/functions/shared/providerSpend";
import { jobIdForQuote } from "../src/lib/server/retryReuse";
import { setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";
import { SpendLimitBanner } from "../src/components/admin/ProviderLimitsPanel";

beforeEach(() => {
  flushProviderLimitsCache();
  resetProviderBalanceCacheForTesting();
  state.user = { id: "admin_1", app_metadata: { role: "admin" }, email: "a@t", user_metadata: {} };
  state.settings = {}; state.settingsReadFails = false; state.reads = 0; state.rpc = []; state.rpcImpl = null;
  state.jobs = []; state.quotes = []; state.costs = []; state.events = [];
  state.partials.clear(); state.results.clear(); state.step = 0; state.cursor = null; state.delivered = 0;
});

describe("A. resolver: order, cache and fallback", () => {
  it("falls back to 0.80 when nothing is stored, when the store is unreadable, and with no client", async () => {
    const client = fakeClient();
    expect((await resolveProviderLimits(client)).limits).toMatchObject({ dailyUsd: 0.8, perJobUsd: null, perUserDailyUsd: null, warnPercent: 80 });
    expect((await resolveProviderLimits(client)).source).toBe("default");
    flushProviderLimitsCache();
    state.settingsReadFails = true;
    const broken = await resolveProviderLimits(client);
    expect(broken.limits.dailyUsd).toBe(0.8);
    expect(broken.source).toBe("default");
    flushProviderLimitsCache();
    expect((await resolveProviderLimits(undefined)).limits.dailyUsd).toBe(0.8);
    expect(defaultProviderLimits().dailyUsd).toBe(0.8);
  });

  it("order: provider_limits row, then the legacy pricing row, then the defaults", async () => {
    const client = fakeClient();
    state.settings = { pricing: { providerDailySpendCapUsd: 1.25, llmDailySpendCapUsd: 7 } };
    const legacy = await resolveProviderLimits(client);
    expect(legacy).toMatchObject({ source: "legacy", limits: { dailyUsd: 1.25, llmDailyUsd: 7 } });
    flushProviderLimitsCache();
    state.settings = { pricing: { providerDailySpendCapUsd: 1.25 }, provider_limits: { dailyUsd: 3, perJobUsd: 0.05, perUserDailyUsd: 0.3, warnPercent: 70 } };
    const fresh = await resolveProviderLimits(client);
    expect(fresh).toMatchObject({ source: "settings", limits: { dailyUsd: 3, perJobUsd: 0.05, perUserDailyUsd: 0.3, warnPercent: 70 } });
  });

  it("ignores stored values that are not clean numbers (a bad row never breaks enforcement)", async () => {
    state.settings = { provider_limits: { dailyUsd: "lots", perJobUsd: -1, warnPercent: 500, perUserDailyUsd: Number.NaN } };
    const r = await resolveProviderLimits(fakeClient());
    expect(r.limits).toMatchObject({ dailyUsd: 0.8, perJobUsd: null, perUserDailyUsd: null, warnPercent: 80 });
  });

  it("caches for 30 seconds and re-reads after the TTL or a flush", async () => {
    const client = fakeClient();
    state.settings = { provider_limits: { dailyUsd: 2 } };
    const t0 = 1_000_000;
    await resolveProviderLimits(client, { now: t0 });
    const readsAfterFirst = state.reads;
    state.settings = { provider_limits: { dailyUsd: 9 } };
    expect((await resolveProviderLimits(client, { now: t0 + PROVIDER_LIMITS_CACHE_TTL_MS - 1 })).limits.dailyUsd).toBe(2);
    expect(state.reads).toBe(readsAfterFirst);
    expect((await resolveProviderLimits(client, { now: t0 + PROVIDER_LIMITS_CACHE_TTL_MS + 1 })).limits.dailyUsd).toBe(9);
    state.settings = { provider_limits: { dailyUsd: 4 } };
    flushProviderLimitsCache();
    expect((await resolveProviderLimits(client)).limits.dailyUsd).toBe(4);
  });

  it("a huge number is accepted and effectively disables the limit", async () => {
    state.settings = { provider_limits: { dailyUsd: 999999999999 } };
    const client = fakeClient();
    const cap = await checkProviderDailySpendCap(5, client as any);
    expect(cap.capUsd).toBe(999999999999);
    expect(cap.allowed).toBe(true);
  });

  it("the plan-estimate balance follows a saved limit at once (no 60 s balance cache)", async () => {
    const client: any = fakeClient();
    state.settings = { provider_limits: { dailyUsd: 0.5 } };
    expect((await getProviderBalanceStatus(client)).todayCapUsd).toBe(0.5);
    state.settings = { provider_limits: { dailyUsd: 0.9 } };
    flushProviderLimitsCache();
    expect((await getProviderBalanceStatus(client)).todayCapUsd).toBe(0.9);
  });
});

describe("A. validation", () => {
  it("accepts Arabic-Indic digits and the Arabic decimal mark; rejects text, negatives and percent above 100", () => {
    expect(parseLimitNumber("٠٫٨٠")).toBe(0.8);
    expect(parseLimitNumber("٢،٥")).toBe(2.5);
    expect(parseLimitNumber("abc")).toBeNull();
    expect(parseLimitNumber("")).toBeNull();
    expect(validateLimitsInput({ dailyUsd: "abc" })).toMatchObject({ ok: false });
    expect(validateLimitsInput({ dailyUsd: "-1" })).toMatchObject({ ok: false });
    expect(validateLimitsInput({ warnPercent: "101" })).toMatchObject({ ok: false });
    expect(validateLimitsInput({ perJobUsd: "ما" })).toMatchObject({ ok: false });
    expect(validateLimitsInput({})).toMatchObject({ ok: false });
  });

  it("accepts a huge number, zero, and an empty ceiling (clears it)", () => {
    expect(validateLimitsInput({ dailyUsd: "999999999999" })).toEqual({ ok: true, value: { dailyUsd: 999999999999 } });
    expect(validateLimitsInput({ dailyUsd: 0 })).toEqual({ ok: true, value: { dailyUsd: 0 } });
    expect(validateLimitsInput({ perJobUsd: "", perUserDailyUsd: null })).toEqual({ ok: true, value: { perJobUsd: null, perUserDailyUsd: null } });
    expect(validateLimitsInput({ dailyUsd: 1e13 })).toMatchObject({ ok: false });
  });

  it("the spend level: warning at the threshold, reached at the limit", () => {
    const l = { dailyUsd: 0.8, warnPercent: 80 };
    expect(spendLevel(0.5, l)).toBe("ok");
    expect(spendLevel(0.64, l)).toBe("warn");
    expect(spendLevel(0.8, l)).toBe("reached");
    expect(spendLevel(0, { dailyUsd: 0, warnPercent: 80 })).toBe("reached");
  });

  it("the ceilings add this call's estimate to what is already spent", () => {
    const limits = { perJobUsd: 0.005, perUserDailyUsd: 0.01 };
    expect(evaluateSpendCeilings(limits, { jobUsd: 0.001, userTodayUsd: 0 }, 0.002)).toBeNull();
    expect(evaluateSpendCeilings(limits, { jobUsd: 0.004, userTodayUsd: 0 }, 0.002)).toBe("job");
    expect(evaluateSpendCeilings(limits, { jobUsd: 0, userTodayUsd: 0.009 }, 0.002)).toBe("user");
    expect(evaluateSpendCeilings({ perJobUsd: null, perUserDailyUsd: null }, { jobUsd: 99, userTodayUsd: 99 }, 99)).toBeNull();
  });
});

describe("A. saving: admin only, audited, immediate", () => {
  it("refuses a non-admin (the function says not_admin) with 403 and changes nothing", async () => {
    const client: any = fakeClient();
    state.rpcImpl = () => ({ data: { success: false, error: "not_admin", error_ar: "هذا الإجراء مخصص للمسؤولين فقط." }, error: null });
    const out = await saveProviderLimits({ client }, { adminId: "user_9", limits: { dailyUsd: 5 } });
    expect(out).toMatchObject({ ok: false, status: 403, reason: "not_admin" });
  });

  it("an invalid value never reaches the database", async () => {
    const client: any = fakeClient();
    const out = await saveProviderLimits({ client }, { adminId: "admin_1", limits: { dailyUsd: "abc" } });
    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(state.rpc.filter((c) => c.name === "admin_set_provider_limits_atomic")).toHaveLength(0);
  });

  it("before the migration is applied it says so in Arabic and the current constants stay", async () => {
    const client: any = fakeClient();
    state.rpcImpl = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.admin_set_provider_limits_atomic in the schema cache" } });
    const out = await saveProviderLimits({ client }, { adminId: "admin_1", limits: { dailyUsd: 5 } });
    expect(out).toMatchObject({ ok: false, status: 409, reason: "store_not_ready" });
    expect(out.messageAr).toContain("مخزن الإعدادات غير جاهز");
    expect((await resolveProviderLimits(client, { forceRefresh: true })).limits.dailyUsd).toBe(0.8);
  });

  it("a saved value is passed to the function (which writes the audit row) and takes effect at once on this instance", async () => {
    const client: any = fakeClient();
    await resolveProviderLimits(client); // warm the cache with 0.80
    state.rpcImpl = (name, args) => {
      if (name !== "admin_set_provider_limits_atomic") return undefined;
      state.settings = { provider_limits: { ...args.p_limits } };
      return { data: { success: true, limits: args.p_limits }, error: null };
    };
    const out = await saveProviderLimits({ client }, { adminId: "admin_1", limits: { dailyUsd: "١٫٥", perJobUsd: "٠٫٠٥" } });
    expect(out).toMatchObject({ ok: true, status: 200 });
    expect(state.rpc.find((c) => c.name === "admin_set_provider_limits_atomic")?.args).toEqual({ p_admin_id: "admin_1", p_limits: { dailyUsd: 1.5, perJobUsd: 0.05 } });
    expect((await resolveProviderLimits(client)).limits).toMatchObject({ dailyUsd: 1.5, perJobUsd: 0.05 });
  });

  it("the audit line shows only what changed, old to new", () => {
    expect(auditSummaryAr({ dailyUsd: 0.8 }, { dailyUsd: 2, perJobUsd: 0.05 })).toBe("الحد اليومي للمزود: 0.8 ← 2، سقف الطلب: بلا سقف ← 0.05");
  });
});

describe("A. the admin routes", () => {
  it("a non-admin gets 403 on read and on save; a signed-out visitor gets 401", async () => {
    const route = await import("../src/app/api/admin/provider-limits/route");
    state.user = { id: "u1", app_metadata: { role: "user" } };
    const get = await route.GET(new NextRequest("http://localhost/api/admin/provider-limits"));
    expect(get.status).toBe(403);
    const post = await route.POST(new NextRequest("http://localhost/api/admin/provider-limits", { method: "POST", body: JSON.stringify({ limits: { dailyUsd: 5 } }) }));
    expect(post.status).toBe(403);
    expect(state.rpc.filter((c) => c.name === "admin_set_provider_limits_atomic")).toHaveLength(0);
    state.user = null;
    expect((await route.GET(new NextRequest("http://localhost/api/admin/provider-limits"))).status).toBe(401);
  });

  it("an admin reads the state before the migration: defaults, store not ready, plain Arabic notice", async () => {
    const route = await import("../src/app/api/admin/provider-limits/route");
    const res = await route.GET(new NextRequest("http://localhost/api/admin/provider-limits"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state.limits.dailyUsd).toBe(0.8);
    expect(body.state.source).toBe("default");
    expect(body.state.storeReady).toBe(true); // the fake client has every table; the missing-table path is covered below
  });

  it("a missing audit table means the store is not ready", async () => {
    const { loadProviderLimitsState } = await import("../src/lib/server/providerLimitsAdmin");
    const client: any = fakeClient();
    const originalFrom = client.from;
    client.from = (t: string) => (t === "provider_limits_audit" ? { select: () => ({ order: () => ({ limit: async () => ({ data: null, error: { code: "42P01", message: "relation does not exist" } }) }) }) } : originalFrom(t));
    const s = await loadProviderLimitsState(client);
    expect(s.storeReady).toBe(false);
    expect(s.noticesAr[0]).toContain("مخزن الإعدادات غير جاهز");
    expect(s.limits.dailyUsd).toBe(0.8);
  });

  it("an admin save through the route works and answers in Arabic", async () => {
    const route = await import("../src/app/api/admin/provider-limits/route");
    state.rpcImpl = (name, args) => (name === "admin_set_provider_limits_atomic" ? { data: { success: true, limits: args.p_limits }, error: null } : undefined);
    const res = await route.POST(new NextRequest("http://localhost/api/admin/provider-limits", { method: "POST", body: JSON.stringify({ limits: { dailyUsd: "999999999999" } }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toContain("تم حفظ الحدود");
    expect(state.rpc.find((c) => c.name === "admin_set_provider_limits_atomic")?.args.p_limits).toEqual({ dailyUsd: 999999999999 });
  });
});

describe("A. the worker honours a changed limit and the per-job / per-user ceilings", () => {
  const JOB = jobIdForQuote("quote_limits");
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "limits-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development";
    state.jobs = [{ id: JOB, user_id: "user_1", status: "running", current_cursor: null, target_volume_max: 2, delivered_units: 0, created_at: new Date().toISOString() }];
    state.quotes = [{ id: "quote_limits", user_id: "user_1", output_formats: ["xlsx"], items: [{ capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", targetVolumeMax: 2, paginationStrategy: "cursor", params: { country: "Egypt", industry: "الكهرباء والطاقة الكهربائية", query: { location: { include: ["Egypt"] } }, pagination: { size: 2 } } }] }];
  });
  afterEach(() => {
    setProviderAdapterForTesting(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
  });

  async function oneChunk() {
    const route = await import("../src/app/api/worker/chunk/route");
    let providerCalls = 0;
    setProviderAdapterForTesting(async (input) => {
      providerCalls += 1;
      return { ok: true, httpStatus: 200, rows: [], nextCursor: "c1", costUsd: 0.001, costMicro: 1000, tregCallId: "t1" };
    });
    const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer limits-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: 0, disableSelfChain: true }) }));
    return { status: res.status, json: await res.json(), providerCalls, reserve: state.rpc.filter((c) => c.name === "reserve_provider_spend_atomic") };
  }

  it("default: the reserve call carries 0.80", async () => {
    const r = await oneChunk();
    expect(r.reserve).toHaveLength(1);
    expect(r.reserve[0].args.p_daily_cap_usd).toBe(0.8);
  });

  it("a limit saved in the admin tab is used by the next chunk, with no redeploy", async () => {
    state.settings = { provider_limits: { dailyUsd: 0.0123 } };
    const r = await oneChunk();
    expect(r.reserve[0].args.p_daily_cap_usd).toBe(0.0123);
  });

  it("a huge limit is passed through unchanged", async () => {
    state.settings = { provider_limits: { dailyUsd: 999999999999 } };
    const r = await oneChunk();
    expect(r.reserve[0].args.p_daily_cap_usd).toBe(999999999999);
  });

  it("the legacy pricing row still works when no new limits are stored", async () => {
    state.settings = { pricing: { providerDailySpendCapUsd: 1.1, jobMaxPointsCap: 600 } };
    const r = await oneChunk();
    expect(r.reserve[0].args.p_daily_cap_usd).toBe(1.1);
  });

  it("per-job ceiling: spent so far plus this page would exceed it -> no provider call, nothing charged, plain Arabic reason", async () => {
    state.settings = { provider_limits: { perJobUsd: 0.003 } };
    state.costs = [{ provider: "treg", job_id: JOB, cost_usd: 0.0025, created_at: new Date().toISOString() }];
    const r = await oneChunk();
    expect(r.providerCalls).toBe(0);
    expect(r.reserve).toHaveLength(0);
    expect(r.status).toBe(429);
    expect(r.json.released).toBe(true);
    expect(r.json.chargedCredits).toBe(0);
    expect(r.json.ceiling).toBe("job");
    expect(r.json.error).toBe(CEILING_MESSAGE_AR.job);
  });

  it("per-user daily ceiling: the user's own spend across jobs today counts", async () => {
    state.settings = { provider_limits: { perUserDailyUsd: 0.004 } };
    state.jobs.push({ id: "job_other", user_id: "user_1", status: "done", created_at: new Date().toISOString() });
    state.costs = [{ provider: "treg", job_id: "job_other", cost_usd: 0.003, created_at: new Date().toISOString() }];
    const r = await oneChunk();
    expect(r.providerCalls).toBe(0);
    expect(r.json.ceiling).toBe("user");
    expect(r.json.error).toBe(CEILING_MESSAGE_AR.user);
  });

  it("another user's spend does not count against this user", async () => {
    state.settings = { provider_limits: { perUserDailyUsd: 0.004 } };
    state.jobs.push({ id: "job_other", user_id: "someone_else", status: "done", created_at: new Date().toISOString() });
    state.costs = [{ provider: "treg", job_id: "job_other", cost_usd: 0.1, created_at: new Date().toISOString() }];
    const r = await oneChunk();
    expect(r.providerCalls).toBe(1);
    expect(r.json.ceiling).toBeUndefined();
  });

  it("no ceilings set: no extra spend queries and the chunk runs as before", async () => {
    state.costs = [{ provider: "treg", job_id: JOB, cost_usd: 99, created_at: new Date().toISOString() }];
    const r = await oneChunk();
    expect(r.providerCalls).toBe(1);
  });
});

describe("A. the warning in the admin UI", () => {
  it("shows the warning at 80% and a plain message at the limit; nothing below the threshold", () => {
    const limits = { dailyUsd: 0.8, warnPercent: 80 };
    const html = (spent: number) => renderToStaticMarkup(createElement(SpendLimitBanner, { level: spendLevel(spent, limits), percent: (spent / limits.dailyUsd) * 100, label: "مزود البيانات" }));
    expect(html(0.3)).toBe("");
    expect(html(0.64)).toContain("٨٠٪");
    expect(html(0.64)).toContain("من الحد اليومي");
    expect(html(0.8)).toContain("وصل الإنفاق اليوم إلى الحد المسموح");
    expect(html(0.8)).toContain("role=\"alert\"");
  });

  it("the admin home banner shows the provider warning and the limit-reached message", async () => {
    vi.resetModules();
    vi.doMock("../src/components/admin/AdminShell", () => ({
      useAdmin: () => ({ providers: { treg: { health: { ok: true }, tokenConfigured: true, lowBalance: false }, llm: {}, limits: { level: "warn", percent: 82, llmLevel: "reached", llmPercent: 100 } } }),
    }));
    const { ProviderAlertBanner } = await import("../src/components/admin/ProviderAlertBanner");
    const html = renderToStaticMarkup(createElement(ProviderAlertBanner));
    expect(html).toContain("٨٢٪ من الحد اليومي");
    expect(html).toContain("النموذج الذكي اليوم إلى حده اليومي");
    vi.doUnmock("../src/components/admin/AdminShell");
  });

  it("the tab text is Arabic and has no provider name, English word or emoji in the limits panel", async () => {
    const { readFileSync } = await import("node:fs");
    const panel = readFileSync("src/components/admin/ProviderLimitsPanel.tsx", "utf8");
    const texts = [...panel.matchAll(/>([^<>{}]*[؀-ۿ][^<>{}]*)</g)].map((m) => m[1]);
    expect(texts.length).toBeGreaterThan(5);
    for (const t of texts) expect(t).not.toMatch(/[A-Za-z]{3,}/);
  });
});
