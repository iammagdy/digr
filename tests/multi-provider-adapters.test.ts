import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { executeTregCall } from "../src/functions/shared/tregClient";
import { firecrawlAdapter } from "../src/lib/server/multiProvider/adapters/firecrawl";
import { contextDevAdapter } from "../src/lib/server/multiProvider/adapters/contextdev";
import { tregAdapter, runTregDirectoryPage } from "../src/lib/server/multiProvider/adapters/treg";
import { ADAPTERS } from "../src/lib/server/multiProvider/adapters";
import { mapHttpError } from "../src/lib/server/multiProvider/httpCall";
import { createCallRecorder, __resetCallRecorderForTests } from "../src/lib/server/multiProvider/callRecorder";
import type { AdapterContext } from "../src/lib/server/multiProvider/adapterTypes";
import { createFakeFetch, defaultFakeWorld } from "../src/lib/server/multiProvider/fakeTransport";
import { createMemoryRecorder } from "./helpers/multiProviderFakes";
import { capabilitiesOfProvider } from "../src/lib/multiProvider/catalog";

const world = defaultFakeWorld(5);
const ctx = (fetchFn: any, recorder: any): AdapterContext => ({ apiKey: "SECRET-KEY-VALUE-123456", fetchFn, recorder, jobId: "job_1" });

describe("adapters: interface, error mapping, cost recording", () => {
  it("each provider has its own adapter with a capability list from the registry", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual(["contextdev", "firecrawl", "treg"]);
    for (const [id, adapter] of Object.entries(ADAPTERS)) {
      expect(adapter.id).toBe(id);
      expect(adapter.capabilities()).toEqual(capabilitiesOfProvider(id as any));
      expect(adapter.capabilities().length).toBeGreaterThan(0);
    }
    expect(tregAdapter.supports("discover.companies")).toBe(true);
    expect(firecrawlAdapter.supports("page.read")).toBe(true);
    expect(firecrawlAdapter.supports("agent.run")).toBe(false);
    expect(contextDevAdapter.supports("people.enrich")).toBe(false);
  });

  it("maps status codes and provider error codes to the router's error codes", () => {
    const cases: Array<[number, any, string]> = [
      [401, null, "auth_rejected"], [403, null, "auth_rejected"], [402, null, "insufficient_credits"], [402, { error_code: "USAGE_EXCEEDED" }, "insufficient_credits"],
      [408, null, "timeout"], [429, null, "rate_limited"], [404, null, "not_found"], [400, null, "bad_request"], [422, null, "bad_request"], [500, null, "server_error"], [503, null, "server_error"],
      [200, { error_code: "WEBSITE_BLOCKED" }, "blocked_site"], [500, { error_code: "WEBSITE_NOT_FOUND" }, "not_found"], [500, { error_code: "REQUEST_TIMEOUT" }, "timeout"],
    ];
    for (const [status, body, code] of cases) expect(mapHttpError(status, body), `${status} ${JSON.stringify(body)}`).toBe(code);
  });

  it("sends the key only as a bearer header, never in the URL or body, to the documented endpoints", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const f = createFakeFetch(world);
    const spy = async (url: string, init?: RequestInit) => { calls.push({ url, init }); return f(url, init); };
    const { recorder } = createMemoryRecorder();
    await firecrawlAdapter.run("discover.web_search", { query: "q", limit: 10 }, ctx(spy, recorder));
    await firecrawlAdapter.run("page.read", { url: "https://www.fakeco1.net/" }, ctx(spy, recorder));
    await contextDevAdapter.run("discover.web_search", { query: "q", limit: 10 }, ctx(spy, recorder));
    await contextDevAdapter.run("page.read", { url: "https://www.fakeco1.net/" }, ctx(spy, recorder));
    await contextDevAdapter.run("site.map", { url: "https://www.fakeco1.net/" }, ctx(spy, recorder));
    expect(calls.map((c) => `${c.init.method} ${c.url.split("?")[0]}`)).toEqual([
      "POST https://api.firecrawl.dev/v2/search", "POST https://api.firecrawl.dev/v2/scrape",
      "POST https://api.context.dev/v1/web/search", "POST https://api.context.dev/v1/web/scrape", "GET https://api.context.dev/v1/web/urls",
    ]);
    for (const c of calls) {
      expect(c.init.headers.Authorization).toBe("Bearer SECRET-KEY-VALUE-123456");
      expect(c.url).not.toContain("SECRET");
      expect(String(c.init.body ?? "")).not.toContain("SECRET");
    }
    // the page read keeps footers and headers (contact details live there)
    expect(JSON.parse(calls[1].init.body)).toMatchObject({ onlyMainContent: false });
  });

  it("every call is recorded with its provider, capability, status and units; a failed call is recorded with cost 0", async () => {
    const { recorder, rows } = createMemoryRecorder();
    const ok = await firecrawlAdapter.run("page.read", { url: "https://www.fakeco1.net/" }, ctx(createFakeFetch(world), recorder));
    expect(ok).toMatchObject({ ok: true, status: "success", units: 1, credits: 1, costUsd: 0.005 });
    const failed = await contextDevAdapter.run("discover.web_search", { query: "q", limit: 10 }, ctx(createFakeFetch(world, { failProvider: { contextdev: 500 } }), recorder));
    expect(failed).toMatchObject({ ok: false, status: "failed", costUsd: 0, errorCode: "server_error", retryable: true });
    const empty = await firecrawlAdapter.run("discover.web_search", { query: "q", limit: 10 }, ctx(createFakeFetch(world, { emptyProvider: { firecrawl: true } }), recorder));
    expect(empty).toMatchObject({ ok: true, status: "empty", units: 0, costUsd: 0 });
    expect(rows.map((r) => `${r.provider}|${r.capabilityId}|${r.status}|${r.estimate}`)).toEqual([
      "firecrawl|firecrawl.scrape|success|false", "contextdev|contextdev.search|failed|false", "firecrawl|firecrawl.search|empty|false",
    ]);
    expect(rows[0].costUsd).toBe(0.005);
    expect(rows[1].costUsd).toBe(0);
  });

  it("a search is charged what the provider reports (credits used x the price of a credit), or what the documented price implies", async () => {
    const { recorder, rows } = createMemoryRecorder();
    const fc = await firecrawlAdapter.run("discover.web_search", { query: "q", limit: 25 }, ctx(createFakeFetch(world), recorder));
    expect(fc.units).toBe(5); // only 5 companies in the fake world
    expect(fc.credits).toBe(2);
    expect(fc.costUsd).toBeCloseTo(0.01, 9);
    const cx = await contextDevAdapter.run("discover.web_search", { query: "q", limit: 25 }, ctx(createFakeFetch(world), recorder));
    expect(cx.credits).toBe(1);
    expect(cx.costUsd).toBeCloseTo(0.00254, 9);
    expect(rows.length).toBe(2);
  });

  it("a call the provider's daily cap has no room for is NOT sent and writes nothing", async () => {
    const { recorder, rows } = createMemoryRecorder({ firecrawl: 0 });
    const f = createFakeFetch(world);
    const res = await firecrawlAdapter.run("page.read", { url: "https://www.fakeco1.net/" }, ctx(f, recorder));
    expect(res).toMatchObject({ ok: false, errorCode: "cap_reached", retryable: true });
    expect(f.log).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it("Firecrawl: HTTP 200 with a page that did not load is a FAILED call; a blocked site is not retryable on another provider", async () => {
    const { recorder } = createMemoryRecorder();
    const blockedWorld = defaultFakeWorld(2).map((c) => ({ ...c, blocked: true }));
    const fc = await firecrawlAdapter.run("page.read", { url: "https://www.fakeco1.net/" }, ctx(createFakeFetch(blockedWorld), recorder));
    expect(fc).toMatchObject({ ok: false, status: "failed", errorCode: "blocked_site", retryable: false });
    const cx = await contextDevAdapter.run("page.read", { url: "https://www.fakeco1.net/" }, ctx(createFakeFetch(blockedWorld), recorder));
    expect(cx).toMatchObject({ ok: false, errorCode: "blocked_site", retryable: false });
    // Context.dev reports the credits an error used; they are what is recorded
    expect(cx.credits).toBe(1);
  });

  it("a network failure and a timeout are recorded as failed and are retryable", async () => {
    const { recorder, rows } = createMemoryRecorder();
    const boom = async () => { throw Object.assign(new Error("x"), { name: "TypeError" }); };
    const slow = async () => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); };
    expect(await firecrawlAdapter.run("page.read", { url: "https://a.net/" }, ctx(boom, recorder))).toMatchObject({ ok: false, errorCode: "network", retryable: true, costUsd: 0 });
    expect(await contextDevAdapter.run("page.read", { url: "https://a.net/" }, ctx(slow, recorder))).toMatchObject({ ok: false, errorCode: "timeout", retryable: true });
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
  });

  it("TREG's directory page is recorded as provider treg whatever happens", async () => {
    const { recorder, rows } = createMemoryRecorder();
    const input: any = { jobId: "j", userId: "u", step: 0, endpointId: "icypeas.companies.search", capabilitySlug: "icypeas-companies-search", method: "POST", params: {}, paginationStrategy: "cursor", cursor: null, pageSize: 10, remainingNeeded: 5, targetVolumeMax: 5, deliveredSoFar: 0 };
    const okPage = await runTregDirectoryPage({ tregFn: async () => ({ ok: true, httpStatus: 200, rows: [{ company_name: "A" }], nextCursor: "n", costUsd: 0.00576, costMicro: 5760, tregCallId: "t" }), input, ctx: { recorder, jobId: "j" } });
    const emptyPage = await runTregDirectoryPage({ tregFn: async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0.00576, costMicro: 5760, tregCallId: "t" }), input, ctx: { recorder, jobId: "j" } });
    const failPage = await runTregDirectoryPage({ tregFn: async () => ({ ok: false, httpStatus: 429, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "", errorCode: "rate_limit" }), input, ctx: { recorder, jobId: "j" } });
    expect([okPage.status, emptyPage.status, failPage.status]).toEqual(["success", "empty", "failed"]);
    expect(failPage).toMatchObject({ errorCode: "rate_limited", retryable: true });
    expect(rows.map((r) => `${r.provider}|${r.status}|${r.units}`)).toEqual(["treg|success|1", "treg|empty|0", "treg|failed|0"]);
    await expect(tregAdapter.run("page.read" as any, {} as any, ctx(fetch, recorder))).rejects.toThrow();
  });
});

describe("the call recorder uses ONLY the approved SQL functions", () => {
  beforeEach(() => __resetCallRecorderForTests());
  const stub = (impl: (name: string, args: any) => any) => {
    const calls: Array<{ name: string; args: any }> = [];
    return { calls, client: { rpc: async (name: string, args: any) => { calls.push({ name, args }); return impl(name, args); }, from: () => { throw new Error("no direct table access is allowed"); } } };
  };

  it("reserves against the PROVIDER's own cap and commits with the metadata function once it exists", async () => {
    const { client, calls } = stub((name) => name === "reserve_provider_spend_atomic" ? { data: { allowed: true, cost_id: 7 }, error: null } : { data: { success: true }, error: null });
    const rec = createCallRecorder(client, { capFor: async (p) => (p === "firecrawl" ? 0.5 : 0.8) });
    const r = await rec.reserve({ provider: "firecrawl", capabilityId: "firecrawl.scrape", estimatedUsd: 0.005, jobId: "job_1" });
    expect(r).toEqual({ allowed: true, costId: 7 });
    await rec.commit(7, { provider: "firecrawl", capabilityId: "firecrawl.scrape", status: "success", units: 1, costUsd: 0.005, durationMs: 420, jobId: "job_1" });
    expect(calls[0]).toEqual({ name: "reserve_provider_spend_atomic", args: { p_job_id: "job_1", p_provider: "firecrawl", p_estimated_cost_usd: 0.005, p_daily_cap_usd: 0.5 } });
    expect(calls[1]).toEqual({ name: "commit_provider_spend_v2", args: { p_cost_id: 7, p_actual_cost_usd: 0.005, p_units: 1, p_capability: "firecrawl.scrape", p_status: "success", p_duration_ms: 420 } });
  });

  it("before the proposal is applied it commits with the existing function, and stops asking for the missing one", async () => {
    const { client, calls } = stub((name) => name === "commit_provider_spend_v2" ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.commit_provider_spend_v2" } } : { data: { success: true }, error: null });
    const rec = createCallRecorder(client, { capFor: async () => 1 });
    const record = { provider: "contextdev" as const, capabilityId: "contextdev.scrape", status: "failed" as const, units: 0, costUsd: 0, durationMs: 10, jobId: "job_1" };
    await rec.commit(3, record);
    await rec.commit(4, record);
    expect(calls.map((c) => c.name)).toEqual(["commit_provider_spend_v2", "commit_provider_spend", "commit_provider_spend"]);
    expect(calls[1].args).toEqual({ p_cost_id: 3, p_actual_cost_usd: 0, p_units: 0 });
  });

  it("a provider with no cap set (0) spends nothing: no reserve call at all; an over-cap or failing reserve says no", async () => {
    const { client, calls } = stub(() => ({ data: { allowed: false }, error: null }));
    expect(await createCallRecorder(client, { capFor: async () => 0 }).reserve({ provider: "firecrawl", capabilityId: "x", estimatedUsd: 0.01, jobId: null })).toMatchObject({ allowed: false, reason: "cap" });
    expect(calls).toHaveLength(0);
    expect(await createCallRecorder(client, { capFor: async () => 1 }).reserve({ provider: "firecrawl", capabilityId: "x", estimatedUsd: 0.01, jobId: null })).toMatchObject({ allowed: false, reason: "cap" });
    const err = stub(() => ({ data: null, error: { code: "XX000", message: "boom" } }));
    expect(await createCallRecorder(err.client, { capFor: async () => 1 }).reserve({ provider: "contextdev", capabilityId: "x", estimatedUsd: 0.01, jobId: null })).toMatchObject({ allowed: false, reason: "error" });
  });
});

describe("T-T TREG cost: the real client, the predicate, the wrappers", () => {
  const baseTregOptions = (extra: Record<string, any> = {}) => ({
    token: "test-token",
    endpointId: "tomba.companies.emails.list",
    method: "POST" as const,
    params: { domain: "example.com" },
    userId: "u1",
    jobId: "j1",
    stepId: "s0",
    page: 1,
    ...extra,
  });

  const stubResponse = (status: number, headers: Record<string, string> = {}, body: any = { ok: true }) => {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };

  it("T-T 1a client result shape (asserts exact result shape across headers and errors)", async () => {
    try {
      // 1. Valid header 8900
      vi.stubGlobal("fetch", vi.fn(async () => stubResponse(200, { "x-treg-cost-micro": "8900" })));
      const res1 = await executeTregCall(baseTregOptions());
      expect(res1).toMatchObject({
        ok: true,
        httpStatus: 200,
        costMicro: 8900,
        isRouteMaxCost: false,
      });
      expect(res1.costIsEstimate).toBeUndefined();
      expect(res1.costUnreported).toBeUndefined();
      expect(res1.costHeaderInvalid).toBeUndefined();
      expect(res1.originalCostMicro).toBeUndefined();
      expect(res1.timedOut).toBeUndefined();

      // 2. Valid header 0
      vi.stubGlobal("fetch", vi.fn(async () => stubResponse(200, { "x-treg-cost-micro": "0" })));
      const res2 = await executeTregCall(baseTregOptions());
      expect(res2).toMatchObject({
        ok: true,
        httpStatus: 200,
        costMicro: 0,
        isRouteMaxCost: false,
      });
      expect(res2.costIsEstimate).toBeUndefined();
      expect(res2.costUnreported).toBeUndefined();
      expect(res2.costHeaderInvalid).toBeUndefined();

      // 3. Header absent + callEstimateUsd wired (⇒ costIsEstimate, costMicro 8900)
      vi.stubGlobal("fetch", vi.fn(async () => stubResponse(200, {})));
      const res3 = await executeTregCall(baseTregOptions({ callEstimateUsd: "0.0089" }));
      expect(res3).toMatchObject({
        ok: true,
        httpStatus: 200,
        costIsEstimate: true,
        costMicro: 8900,
      });
      expect(res3.costUnreported).toBeUndefined();
      expect(res3.costHeaderInvalid).toBeUndefined();

      // 4. Header absent + no estimate (⇒ costUnreported)
      vi.stubGlobal("fetch", vi.fn(async () => stubResponse(200, {})));
      const res4 = await executeTregCall(baseTregOptions());
      expect(res4).toMatchObject({
        ok: true,
        httpStatus: 200,
        costUnreported: true,
        costMicro: 0,
      });
      expect(res4.costIsEstimate).toBeUndefined();
      expect(res4.costHeaderInvalid).toBeUndefined();

      // 5. Header "abc", "", "12x", "-5", "1e3" (⇒ costHeaderInvalid)
      for (const h of ["abc", "", "12x", "-5", "1e3"]) {
        vi.stubGlobal("fetch", vi.fn(async () => stubResponse(200, { "x-treg-cost-micro": h })));
        const res5 = await executeTregCall(baseTregOptions());
        expect(res5.costHeaderInvalid).toBe(true);
      }

      // 6. _treg.charged_micro in the body
      vi.stubGlobal("fetch", vi.fn(async () => stubResponse(200, {}, { _treg: { charged_micro: 5760 } })));
      const res6 = await executeTregCall(baseTregOptions());
      expect(res6).toMatchObject({
        ok: true,
        httpStatus: 200,
        costMicro: 5760,
        chargedMicroReported: 5760,
      });
      expect(res6.costUnreported).toBeUndefined();

      // 7. 402 route_max_cost with and without a header
      vi.stubGlobal("fetch", vi.fn(async () => stubResponse(402, { "x-treg-cost-micro": "100" }, { error: "route_max_cost" })));
      const res7a = await executeTregCall(baseTregOptions());
      expect(res7a).toMatchObject({
        ok: false,
        httpStatus: 402,
        isRouteMaxCost: true,
        costMicro: 100,
      });
      vi.stubGlobal("fetch", vi.fn(async () => stubResponse(402, {}, { error: "route_max_cost" })));
      const res7b = await executeTregCall(baseTregOptions());
      expect(res7b).toMatchObject({
        ok: false,
        httpStatus: 402,
        isRouteMaxCost: true,
        costMicro: 0,
        costUnreported: true,
      });

      // 8. 409 with and without a header
      vi.stubGlobal("fetch", vi.fn(async () => stubResponse(409, { "x-treg-cost-micro": "500" })));
      const res8a = await executeTregCall(baseTregOptions());
      expect(res8a).toMatchObject({
        ok: false,
        httpStatus: 409,
        costMicro: 500,
      });
      vi.stubGlobal("fetch", vi.fn(async () => stubResponse(409, {})));
      const res8b = await executeTregCall(baseTregOptions());
      expect(res8b).toMatchObject({
        ok: false,
        httpStatus: 409,
        costMicro: 0,
        costUnreported: true,
      });

      // 9. 429
      vi.stubGlobal("fetch", vi.fn(async () => stubResponse(429, { "x-treg-cost-micro": "0" })));
      const res9 = await executeTregCall(baseTregOptions());
      expect(res9).toMatchObject({
        ok: false,
        httpStatus: 429,
        costMicro: 0,
      });

      // 10. 503
      vi.stubGlobal("fetch", vi.fn(async () => stubResponse(503, { "x-treg-cost-micro": "2000" })));
      const res10 = await executeTregCall(baseTregOptions());
      expect(res10).toMatchObject({
        ok: false,
        httpStatus: 503,
        costMicro: 2000,
      });

      // Replay originalCostMicro check
      vi.stubGlobal("fetch", vi.fn(async () => stubResponse(200, { "x-treg-cost-micro": "0", "x-treg-original-cost-micro": "8900" })));
      const resReplay = await executeTregCall(baseTregOptions());
      expect(resReplay).toMatchObject({
        costMicro: 0,
        originalCostMicro: 8900,
      });

      // 11. Stub throwing TimeoutError, AbortError, generic error
      const timeoutErr = new Error("timeout");
      timeoutErr.name = "TimeoutError";
      vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutErr; }));
      const resTimeout = await executeTregCall(baseTregOptions());
      expect(resTimeout).toMatchObject({
        ok: false,
        httpStatus: 503,
        error: "network_failure",
        timedOut: true,
        costMicro: 0,
      });

      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";
      vi.stubGlobal("fetch", vi.fn(async () => { throw abortErr; }));
      const resAbort = await executeTregCall(baseTregOptions());
      expect(resAbort).toMatchObject({
        ok: false,
        httpStatus: 503,
        error: "network_failure",
        timedOut: true,
        costMicro: 0,
      });

      const genericErr = new Error("generic error");
      vi.stubGlobal("fetch", vi.fn(async () => { throw genericErr; }));
      const resGeneric = await executeTregCall(baseTregOptions());
      expect(resGeneric).toMatchObject({
        ok: false,
        httpStatus: 503,
        error: "network_failure",
        timedOut: false,
        costMicro: 0,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
