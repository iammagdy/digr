import { describe, expect, it } from "vitest";
import {
  STATUS_CACHE_TTL_MS, checkProviderKey, extractTregOrgId, fetchTregBalance, getProviderStatus, invalidateProviderStatusCache,
  isLowBalance, parseTregBalance,
} from "../src/lib/server/providerStatus";
import { fakeKey, mockProviderFetch } from "./helpers/providerKeyTestKit";

describe("real provider health checks", () => {
  it("the data provider check is an authenticated GET of the documented identity route", async () => {
    const key = fakeKey("h");
    const f = mockProviderFetch(() => ({ status: 200, body: { id: "u1" } }));
    const { health } = await checkProviderKey("treg", key, f.fn);
    expect(health).toMatchObject({ ok: true, reason: "ok", httpStatus: 200, statusClass: "2xx" });
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toMatch(/^https:\/\/treg\.to\/auth\/me$/);
    expect(f.calls[0].headers["x-treg-token"]).toBe(key);
    expect(f.calls[0].url).not.toContain("/call/"); // never the metered route
  });

  it("the model provider check is the free list-models read", async () => {
    const key = fakeKey("a");
    const f = mockProviderFetch(() => ({ status: 200, body: { data: [] } }));
    const { health } = await checkProviderKey("anthropic", key, f.fn);
    expect(health.ok).toBe(true);
    expect(f.calls[0].url).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect(f.calls[0].headers["x-api-key"]).toBe(key);
    expect(f.calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(f.calls[0].url).not.toContain("/messages");
  });

  it("classifies every outcome with a status class and a safe reason code", async () => {
    const cases: Array<[number, string, string]> = [[401, "auth_rejected", "4xx"], [403, "auth_rejected", "4xx"], [429, "rate_limited", "4xx"], [500, "server_error", "5xx"], [503, "server_error", "5xx"], [418, "unexpected", "4xx"]];
    for (const [status, reason, cls] of cases) {
      const f = mockProviderFetch(() => ({ status }));
      const { health } = await checkProviderKey("treg", fakeKey("c"), f.fn);
      expect(health).toMatchObject({ ok: false, reason, statusClass: cls, httpStatus: status });
    }
    const net = await checkProviderKey("treg", fakeKey("n"), mockProviderFetch(() => new Error("socket hang up")).fn);
    expect(net.health).toMatchObject({ ok: false, reason: "network_error", httpStatus: null, statusClass: "network" });
    const to = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    expect((await checkProviderKey("treg", fakeKey("t"), mockProviderFetch(() => to).fn)).health).toMatchObject({ reason: "timeout", statusClass: "timeout" });
  });

  it("no key means no call at all", async () => {
    const f = mockProviderFetch(() => ({ status: 200 }));
    const { health } = await checkProviderKey("treg", "", f.fn);
    expect(health).toMatchObject({ ok: false, reason: "no_key" });
    expect(f.mock).not.toHaveBeenCalled();
  });
});

describe("real balance", () => {
  it("reads integer micro-USD from the provider's own answer and derives dollars for display only", () => {
    expect(parseTregBalance({ balance_micro: 1_234_567 })).toEqual({ balanceMicro: 1_234_567, heldMicro: null });
    expect(parseTregBalance({ org: { balance_micro: "250000", held_micro: 5000 } })).toEqual({ balanceMicro: 250000, heldMicro: 5000 });
    expect(parseTregBalance({ balance_usd: 1.23 })).toBeNull(); // the display twin is never used for money
    expect(parseTregBalance({ balance_micro: 1.5 })).toBeNull();
    expect(parseTregBalance(null)).toBeNull();
    expect(parseTregBalance({ nothing: "here" })).toBeNull();
  });

  it("never invents a number: an unreadable answer is reported as unreadable", async () => {
    const f = mockProviderFetch(() => ({ status: 200, body: { ok: true } }));
    const r = await fetchTregBalance(fakeKey("b"), "42", f.fn);
    expect(r).toMatchObject({ available: false, unavailableReason: "unreadable" });
    expect(r.balanceUsd).toBeUndefined();
  });

  it("calls the documented balance route for the team and sends the token header", async () => {
    const key = fakeKey("b2");
    const f = mockProviderFetch(() => ({ status: 200, body: { balance_micro: 340_000 } }));
    const r = await fetchTregBalance(key, "42", f.fn);
    expect(r).toMatchObject({ available: true, balanceMicro: 340_000, balanceUsd: 0.34, orgId: "42" });
    expect(f.calls[0].url).toBe("https://treg.to/orgs/42/balance?limit=1");
    expect(f.calls[0].headers["x-treg-token"]).toBe(key);
  });

  it("finds the team id in the identity answer, or says it is unknown", async () => {
    expect(extractTregOrgId({ org_id: 7 })).toBe("7");
    expect(extractTregOrgId({ active_org: { id: "acme" } })).toBe("acme");
    expect(extractTregOrgId({ orgs: [{ id: 12 }] })).toBe("12");
    expect(extractTregOrgId({ org_id: "../../etc" })).toBeNull();
    expect(extractTregOrgId({})).toBeNull();
    const r = await fetchTregBalance(fakeKey("x"), null, mockProviderFetch(() => ({ status: 200 })).fn);
    expect(r).toMatchObject({ available: false, unavailableReason: "org_unknown" });
  });

  it("the model provider has no balance API and says so instead of showing a number", async () => {
    invalidateProviderStatusCache();
    const f = mockProviderFetch(() => ({ status: 200, body: { data: [] } }));
    const s = await getProviderStatus("anthropic", fakeKey("a"), { fetchFn: f.fn, forceRefresh: true });
    expect(s.balance).toMatchObject({ available: false, unavailableReason: "no_balance_api" });
    expect(f.calls).toHaveLength(1);
  });

  it("caches health and balance for 60 seconds per instance; refresh bypasses the cache", async () => {
    expect(STATUS_CACHE_TTL_MS).toBe(60_000);
    invalidateProviderStatusCache();
    let t = 5_000_000;
    const f = mockProviderFetch((url) => (url.endsWith("/auth/me") ? { status: 200, body: { org_id: 9 } } : { status: 200, body: { balance_micro: 100_000 } }));
    const opts = { fetchFn: f.fn, now: () => t };
    const a = await getProviderStatus("treg", fakeKey("c1"), opts);
    expect(a.balance).toMatchObject({ available: true, balanceUsd: 0.1 });
    expect(f.calls).toHaveLength(2);
    t += 59_000;
    await getProviderStatus("treg", fakeKey("c1"), opts);
    expect(f.calls).toHaveLength(2);
    t += 2_000;
    await getProviderStatus("treg", fakeKey("c1"), opts);
    expect(f.calls).toHaveLength(4);
    await getProviderStatus("treg", fakeKey("c1"), { ...opts, forceRefresh: true });
    expect(f.calls).toHaveLength(6);
  });

  it("a failed health check skips the balance call", async () => {
    invalidateProviderStatusCache();
    const f = mockProviderFetch(() => ({ status: 401 }));
    const s = await getProviderStatus("treg", fakeKey("bad"), { fetchFn: f.fn, forceRefresh: true });
    expect(s.health.reason).toBe("auth_rejected");
    expect(s.balance).toMatchObject({ available: false, unavailableReason: "check_failed" });
    expect(f.calls).toHaveLength(1);
  });

  it("low balance is judged against the configurable threshold (default 0.20 dollars)", () => {
    const bal = (usd: number) => ({ available: true, balanceUsd: usd, balanceMicro: usd * 1e6, checkedAt: "x" });
    expect(isLowBalance(bal(0.19), 0.2)).toBe(true);
    expect(isLowBalance(bal(0.2), 0.2)).toBe(false);
    expect(isLowBalance(bal(5), 10)).toBe(true);
    expect(isLowBalance({ available: false, checkedAt: "x" }, 0.2)).toBe(false);
  });
});
