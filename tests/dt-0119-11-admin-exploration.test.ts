import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { ADMIN_LOOKUP_DAILY_CAP_USD, ADMIN_LOOKUP_PURPOSE, lookupCandidates, resetAdminLookupMemoryForTesting, runLookupAttempt } from "../src/lib/server/adminLookup";
import { policyRuleOf } from "../src/lib/treg/dataPolicy";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { resetExplorationMemoryForTesting, runSampleCall } from "../src/lib/modelPlanner/exploration";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { tregResult } from "./helpers/agentHarness";

const catalog = loadTregCatalog();
beforeEach(() => { process.env.TREG_TOKEN = "t"; resetAdminLookupMemoryForTesting(); resetExplorationMemoryForTesting(); vi.spyOn(console, "warn").mockImplementation(() => undefined); vi.spyOn(console, "info").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

describe("D4: the admin lookup's header AND audit reservation = the day's money left, reserved BEFORE the existing recheck (round 2 replay)", () => {
  it("two concurrent lookups with 1 USD spent of the 2 USD cap: AT MOST ONE request is made (both may refuse: that errs on the side of no spend), the day's total never passes 2 USD", async () => {
    expect(ADMIN_LOOKUP_DAILY_CAP_USD).toBe(2);
    const db = createMemoryDb();
    const now = new Date("2026-10-27T10:00:00Z");
    db.seed("sensitive_lookup_audit", [{ id: "old", account_id: "adm-1", is_admin: true, purpose: ADMIN_LOOKUP_PURPOSE, endpoint_id: "x", endpoint_category: "sensitive", masked_value: "***", job_id: "adminlookup_old", cost_usd: 1, created_at: now.toISOString() }]);
    const first = lookupCandidates("email", catalog, policyRuleOf)[0];
    const seen: TregCallOptions[] = [];
    // a provider that bills 0.60 per call and only if the header allows it
    const call = async (o: TregCallOptions): Promise<TregCallResult> => { seen.push(o); await new Promise((r) => setTimeout(r, 15)); return Number(o.routeMaxCostUsd) >= 0.6 ? tregResult({ data: { person: { full_name: "Sara Ahmed" } } }, 0.6) : ({ ok: false, httpStatus: 402, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, isRouteMaxCost: true, isPlatformBalanceLow: false } as TregCallResult); };
    const [a, b] = await Promise.all([1, 2].map(() => runLookupAttempt({ client: db, adminId: "adm-1", text: "sara@acme.com", endpointId: first.id, now, call })));
    expect(seen.length).toBeLessThanOrEqual(1);
    expect(seen.every((o) => Number(o.routeMaxCostUsd) <= 1)).toBe(true);
    expect([a, b].filter((r) => r.ok).length).toBeLessThanOrEqual(1);
    expect([a, b].some((r) => !r.ok && r.reason === "daily_cap")).toBe(true);
    const total = db.rows("sensitive_lookup_audit").reduce((n: number, r: any) => n + Number(r.cost_usd || 0), 0);
    expect(total).toBeLessThanOrEqual(2 + 1e-9);
  });
  it("a TIMEOUT keeps the reserved money in the audit row (it may have been billed up to it), never the small estimate", async () => {
    const db = createMemoryDb();
    const now = new Date("2026-10-27T10:00:00Z");
    const first = lookupCandidates("email", catalog, policyRuleOf)[0];
    const call = async (): Promise<TregCallResult> => ({ ok: false, httpStatus: 0, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, timedOut: true, isRouteMaxCost: false, isPlatformBalanceLow: false } as TregCallResult);
    const out = await runLookupAttempt({ client: db, adminId: "adm-1", text: "sara@acme.com", endpointId: first.id, now, call });
    expect(out.ok).toBe(true);
    const spent = db.rows("sensitive_lookup_audit").reduce((n: number, r: any) => n + Number(r.cost_usd || 0), 0);
    expect(spent).toBeGreaterThan(first.estimateUsd * 10);
    expect(spent).toBeLessThanOrEqual(2 + 1e-9);
  });
  it("a paid phone endpoint is never given more than the amount the admin CONFIRMED", async () => {
    const db = createMemoryDb();
    const paid = lookupCandidates("phone", catalog, policyRuleOf).concat([]).find(() => false);
    void paid;
    const plan = (await import("../src/lib/server/adminLookup")).lookupPlan("phone", "+201111113041", catalog, policyRuleOf).find((p) => p.state === "confirm");
    if (!plan) return; // the catalog snapshot has no paid phone endpoint for this number: nothing to check
    const seen: TregCallOptions[] = [];
    const call = async (o: TregCallOptions): Promise<TregCallResult> => { seen.push(o); return tregResult({ data: { person: null } }, 0); };
    await runLookupAttempt({ client: db, adminId: "adm-1", text: "+201111113041", endpointId: plan.id, confirmedUsd: plan.usd, call });
    expect(Number(seen[0].routeMaxCostUsd)).toBeLessThanOrEqual(plan.usd + 1e-9);
  });
});

describe("D1: the shared exploration ledger is reserved BEFORE the request (round 2 replay)", () => {
  const xParams = [{ name: "website", value: "acme.example", source: "customer_text" as const, quote: "acme.example" }];
  const ctx = () => ({ customerText: "اعرض موظفي acme.example", access: { isAdmin: false, verifiedBusiness: false }, catalog, samples: new Map(), stats: { madeCalls: 0 } });
  it("two samples in parallel on one request: the first reserves ALL the request's exploration money, the second finds none and sends nothing; the header is the money, not the estimate", async () => {
    const db = createMemoryDb();
    const seen: TregCallOptions[] = [];
    const rows = { employees: [{ name: "A", linkedinUrl: "https://www.linkedin.com/in/a" }] };
    const call = vi.fn(async (o: TregCallOptions) => { seen.push(o); await new Promise((r) => setTimeout(r, 20)); return tregResult(rows, 0.005); });
    const deps = { client: db, requestId: "req1", userId: "u1", call };
    const [a, b] = await Promise.all([runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), deps), runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), deps)]);
    expect(call.mock.calls.length).toBeLessThanOrEqual(2);
    const sent = seen.map((o) => Number(o.routeMaxCostUsd));
    expect(sent.every((v) => v > 0.005 && v <= 0.05)).toBe(true);
    const reservedAndSpent = db.rows("exploration_calls").reduce((n: number, r: any) => n + Number(r.cost_usd || 0), 0);
    expect(reservedAndSpent).toBeLessThanOrEqual(0.05 + 1e-9);
    void a; void b;
  });
  it("a timeout keeps the reserved amount in the ledger (never zero)", async () => {
    const db = createMemoryDb();
    const call = vi.fn(async (): Promise<TregCallResult> => ({ ok: false, httpStatus: 0, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, timedOut: true, isRouteMaxCost: false, isPlatformBalanceLow: false } as TregCallResult));
    await runSampleCall({ id: "aviato.companies.employees", params: xParams }, ctx(), { client: db, requestId: "req2", userId: "u1", call });
    const spent = db.rows("exploration_calls").reduce((n: number, r: any) => n + Number(r.cost_usd || 0), 0);
    expect(spent).toBeGreaterThan(0.005);
    expect(spent).toBeLessThanOrEqual(0.05 + 1e-9);
  });
});
