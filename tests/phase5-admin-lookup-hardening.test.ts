import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { ADMIN_LOOKUP_DAILY_CAP_USD, ADMIN_LOOKUP_PURPOSE, lookupCandidates, lookupPlan, lookupReserveUsd, runAdminLookup, runLookupAttempt } from "../src/lib/server/adminLookup";
import { runSensitiveCall } from "../src/lib/server/sensitiveAccess";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { policyRuleOf } from "../src/lib/treg/dataPolicy";
import type { TregCallOptions } from "../src/functions/shared/tregClient";

/**
 * PHASE 5: ADMIN REVERSE LOOKUP READINESS. The answers below are SIMULATED (labelled): no provider is called. They prove the cap, the audit and the history rules, not a provider's data.
 *
 *   - the $2 daily cap holds across concurrent requests and processes: it is read from the audit log only, and each call RESERVES its route cap in the log before it is made;
 *   - an unknown charge (a cut or unreachable call) counts at its reservation, never 0;
 *   - the audit fails closed: no row, no readable sum, no call;
 *   - the browser fallback history keeps no identity field.
 */
const catalog = loadTregCatalog();
const person = { data: { person: { full_name: "Sara Ahmed", company: "Acme Co", job_title: "Head of Sales", linkedin_url: "https://www.linkedin.com/in/sara-ahmed", country: "Egypt" } } };
const EMAIL = "sara@acme.com";
const FIRST = lookupCandidates("email", catalog, policyRuleOf)[0];
const NOW = new Date("2026-11-14T10:00:00Z");

const ok = (data: unknown, micro: number) => ({ ok: true, httpStatus: 200, tregCallId: "c", costMicro: micro, latencyMs: 1, data, isRouteMaxCost: false, isPlatformBalanceLow: false }) as any;
const seedSpent = (db: MemoryDb, usd: number) => db.seed("sensitive_lookup_audit", [{ id: "seed", account_id: "adm-1", is_admin: true, purpose: ADMIN_LOOKUP_PURPOSE, endpoint_id: "x.y.z", endpoint_category: "reverse_lookup", masked_value: "***", job_id: "adminlookup_seed", cost_usd: usd, outcome: "called", created_at: "2026-11-14T08:00:00.000Z" }]);
const daySum = (db: MemoryDb) => db.rows("sensitive_lookup_audit").filter((r) => r.purpose === ADMIN_LOOKUP_PURPOSE && String(r.created_at).startsWith("2026-11-14")).reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);

beforeEach(() => { process.env.TREG_TOKEN = "t"; vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

describe("Phase 5: the $2 daily cap is a HARD cap (audit log only, reserve before call)", () => {
  it("each attempt writes its pending audit row WITH its reservation (the route cap) before the call: a call in flight already counts", async () => {
    const db = createMemoryDb();
    let seenDuringCall: any = null;
    const call = async (_o: TregCallOptions) => { seenDuringCall = { ...db.rows("sensitive_lookup_audit")[0] }; return ok(person, 20_000); };
    const out = await runLookupAttempt({ client: db, adminId: "adm-1", text: EMAIL, endpointId: FIRST.id, call, now: NOW });
    expect(out.ok).toBe(true);
    expect(seenDuringCall).toMatchObject({ outcome: "pending", cost_usd: lookupReserveUsd(FIRST.estimateUsd), purpose: ADMIN_LOOKUP_PURPOSE });
    expect(db.rows("sensitive_lookup_audit")[0]).toMatchObject({ outcome: "called", cost_usd: 0.02 });
    expect(lookupReserveUsd(0)).toBe(0.001);
  });

  it("CONCURRENT requests cannot pass the cap: 12 attempts race with room for 3 reservations; at most 3 are called and the day's sum stays within $2", async () => {
    const db = createMemoryDb();
    const reserve = lookupReserveUsd(FIRST.estimateUsd);
    seedSpent(db, Number((ADMIN_LOOKUP_DAILY_CAP_USD - 3 * reserve).toFixed(6)));
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // every call waits until all requests are in flight, then is billed its full reservation
    const call = async (o: TregCallOptions) => { calls.push(o.endpointId); await gate; return ok(person, Math.round(reserve * 1_000_000)); };
    const runs = Array.from({ length: 12 }, () => runLookupAttempt({ client: db, adminId: "adm-1", text: EMAIL, endpointId: FIRST.id, call, now: NOW }));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const outs = await Promise.all(runs);
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(outs.filter((o) => o.ok).length).toBe(calls.length);
    expect(outs.filter((o) => !o.ok).every((o) => !o.ok && o.reason === "daily_cap")).toBe(true);
    expect(daySum(db)).toBeLessThanOrEqual(ADMIN_LOOKUP_DAILY_CAP_USD + 1e-9);
  });

  it("a SECOND PROCESS (fresh memory, same database) sees the first one's spend: no process-local state can reopen the cap", async () => {
    const db = createMemoryDb();
    seedSpent(db, ADMIN_LOOKUP_DAILY_CAP_USD);
    const calls: string[] = [];
    vi.resetModules();
    const fresh = await import("../src/lib/server/adminLookup");
    const out = await fresh.runLookupAttempt({ client: db, adminId: "adm-1", text: EMAIL, endpointId: FIRST.id, call: async (o) => { calls.push(o.endpointId); return ok(person, 1); }, now: NOW });
    expect(out).toMatchObject({ ok: false, reason: "daily_cap" });
    expect(calls).toHaveLength(0);
    expect(readFileSync("src/lib/server/adminLookup.ts", "utf-8")).not.toMatch(/MEMORY\.day/);
  });

  it("the cap is checked against the call's MOST (its route cap), not only its estimate", async () => {
    const db = createMemoryDb();
    seedSpent(db, Number((ADMIN_LOOKUP_DAILY_CAP_USD - 0.0005).toFixed(6)));
    const calls: string[] = [];
    // a free phone endpoint estimates 0 but may be charged up to its 0.001 route cap: with 0.0005 left it is not called
    const out = await runLookupAttempt({ client: db, adminId: "adm-1", text: "+201001234567", endpointId: "getleadsio.people.phone.lookup", call: async (o) => { calls.push(o.endpointId); return ok(person, 0); }, now: NOW });
    expect(out).toMatchObject({ ok: false, reason: "daily_cap" });
    expect(calls).toHaveLength(0);
    // refused by the first check (the route cap against the day's sum), before any audit row is written
    expect(db.rows("sensitive_lookup_audit")).toHaveLength(1);
  });
});

describe("Phase 5: unknown charges count, never 0", () => {
  it.each([
    ["a timeout", { ok: false, httpStatus: 503, tregCallId: "", costMicro: 0, latencyMs: 15000, data: null, error: "network_failure", timedOut: true, isRouteMaxCost: false, isPlatformBalanceLow: false }],
    ["an unreachable source", { ok: false, httpStatus: 503, tregCallId: "", costMicro: 0, latencyMs: 5, data: null, error: "network_failure", isRouteMaxCost: false, isPlatformBalanceLow: false }],
  ])("%s keeps the reservation in the audit row and in the day's spend", async (_label, answer) => {
    const db = createMemoryDb();
    const reserve = lookupReserveUsd(FIRST.estimateUsd);
    const out = await runLookupAttempt({ client: db, adminId: "adm-1", text: EMAIL, endpointId: FIRST.id, call: async () => answer as any, now: NOW });
    expect(out.ok && out.attempt).toMatchObject({ outcome: "failed", costUsd: reserve });
    expect(db.rows("sensitive_lookup_audit")[0]).toMatchObject({ outcome: "failed", cost_usd: reserve });
  });

  it("a call that THROWS keeps its reservation too", async () => {
    const db = createMemoryDb();
    await expect(runLookupAttempt({ client: db, adminId: "adm-1", text: EMAIL, endpointId: FIRST.id, call: async () => { throw new Error("socket hang up"); }, now: NOW })).rejects.toThrow();
    expect(db.rows("sensitive_lookup_audit")[0]).toMatchObject({ outcome: "failed", cost_usd: lookupReserveUsd(FIRST.estimateUsd) });
  });

  it("an answered call with a reported cost records that cost (a refused HTTP answer at its own reported 0)", async () => {
    const db = createMemoryDb();
    const out = await runLookupAttempt({ client: db, adminId: "adm-1", text: EMAIL, endpointId: FIRST.id, call: async () => ({ ok: false, httpStatus: 404, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, isRouteMaxCost: false, isPlatformBalanceLow: false }) as any, now: NOW });
    expect(out.ok && out.attempt).toMatchObject({ outcome: "failed", costUsd: 0 });
  });

  it("a completion that cannot be written leaves the PENDING row at its reservation (counted), never at 0", async () => {
    const db = createMemoryDb();
    const wrapped: any = { ...db, from: (t: string) => { const b = db.from(t); return { ...b, update: () => ({ eq: async () => { throw new Error("lost"); } }), select: b.select, insert: b.insert }; } };
    await runLookupAttempt({ client: wrapped, adminId: "adm-1", text: EMAIL, endpointId: FIRST.id, call: async () => ok(person, 20_000), now: NOW });
    expect(db.rows("sensitive_lookup_audit")[0]).toMatchObject({ outcome: "pending", cost_usd: lookupReserveUsd(FIRST.estimateUsd) });
  });
});

describe("Phase 5: the audit fails closed", () => {
  it("no readable day's spend: refused before anything (attempt and whole lookup)", async () => {
    const db = createMemoryDb({ missing: ["sensitive_lookup_audit"] });
    const calls: string[] = [];
    const call = async (o: TregCallOptions) => { calls.push(o.endpointId); return ok(person, 1); };
    expect(await runLookupAttempt({ client: db, adminId: "adm-1", text: EMAIL, endpointId: FIRST.id, call, now: NOW })).toMatchObject({ ok: false, reason: "audit_unavailable" });
    expect(await runAdminLookup({ client: db, adminId: "adm-1", text: EMAIL, call, now: NOW })).toMatchObject({ ok: false, reason: "audit_unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("the day's sum cannot be read while writes still work: refused BEFORE any audit row is written", async () => {
    const db = createMemoryDb();
    const wrapped: any = { ...db, from: (t: string) => { const b = db.from(t); return { ...b, insert: b.insert, update: b.update, select: () => { throw new Error("read lost"); } }; } };
    const calls: string[] = [];
    const out = await runLookupAttempt({ client: wrapped, adminId: "adm-1", text: EMAIL, endpointId: FIRST.id, call: async (o) => { calls.push(o.endpointId); return ok(person, 1); }, now: NOW });
    expect(out).toMatchObject({ ok: false, reason: "audit_unavailable" });
    expect(calls).toHaveLength(0);
    expect(db.rows("sensitive_lookup_audit")).toHaveLength(0);
  });

  it("the sum is readable but the audit ROW cannot be written: refused, no call (the admin is no exception here)", async () => {
    const db = createMemoryDb();
    const wrapped: any = { ...db, from: (t: string) => { const b = db.from(t); return { ...b, select: b.select, insert: async () => ({ data: null, error: { message: "insert denied" } }) }; } };
    const calls: string[] = [];
    const out = await runLookupAttempt({ client: wrapped, adminId: "adm-1", text: EMAIL, endpointId: FIRST.id, call: async (o) => { calls.push(o.endpointId); return ok(person, 1); }, now: NOW });
    expect(out).toMatchObject({ ok: false, reason: "audit_unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("the row was written but the re-read fails: the row is marked refused_audit at 0 and nothing is called", async () => {
    const db = createMemoryDb();
    let selects = 0;
    const wrapped: any = { ...db, from: (t: string) => { const b = db.from(t); return { ...b, insert: b.insert, update: b.update, select: (...a: any[]) => { selects += 1; if (selects >= 2) throw new Error("read lost"); return b.select(...a); } }; } };
    const calls: string[] = [];
    const out = await runLookupAttempt({ client: wrapped, adminId: "adm-1", text: EMAIL, endpointId: FIRST.id, call: async (o) => { calls.push(o.endpointId); return ok(person, 1); }, now: NOW });
    expect(out).toMatchObject({ ok: false, reason: "audit_unavailable" });
    expect(calls).toHaveLength(0);
    expect(db.rows("sensitive_lookup_audit")[0]).toMatchObject({ outcome: "refused_audit", cost_usd: 0 });
  });

  it("the general sensitive path is unchanged: without requireAudit an admin call still goes ahead with a log line (worker and planner paths)", async () => {
    const db = createMemoryDb({ missing: ["sensitive_lookup_audit"] });
    const invoke = vi.fn(async () => ({ result: 1, costUsd: 0.01, ok: true }));
    const out = await runSensitiveCall({ client: db, account: { userId: "adm-1", access: { isAdmin: true, verifiedBusiness: false } }, endpointId: FIRST.id, params: { email: EMAIL }, call: invoke });
    expect(out).toMatchObject({ ok: true, auditWritten: false });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("no attempt bypasses authentication: the route authenticates the admin before every action, and the audited path is the only one that sets sensitive access", () => {
    const route = readFileSync("src/app/api/admin/reverse-lookup/route.ts", "utf-8");
    const handlers = route.split(/export async function (?:GET|POST)/).slice(1);
    expect(handlers).toHaveLength(2);
    for (const h of handlers) expect(h.indexOf("authenticateAdmin(req)")).toBeGreaterThan(-1);
    for (const h of handlers) expect(h.indexOf("if (!auth.ok) return auth.response;")).toBeLessThan(h.indexOf("createAdminClient()"));
  });
});

describe("Phase 5: ambiguous identity and provider failures (simulated answers)", () => {
  it("a list of several different people is NOT merged into one identity: the first row is read, its source kept, nothing from the others is mixed in", async () => {
    const db = createMemoryDb();
    const ambiguous = { data: [{ full_name: "Sara Ahmed", company: "Acme Co" }, { full_name: "Sara Ahmad", company: "Other LLC", job_title: "CFO" }] };
    const out = await runLookupAttempt({ client: db, adminId: "adm-1", text: EMAIL, endpointId: FIRST.id, call: async () => ok(ambiguous, 20_000), now: NOW });
    expect(out.ok && out.fields).toEqual({ name: { value: "Sara Ahmed", source: FIRST.id }, company: { value: "Acme Co", source: FIRST.id } });
    expect(JSON.stringify(out)).not.toContain("Other LLC");
    expect(JSON.stringify(out)).not.toContain("CFO");
  });

  it("an empty answer is no match, never an invented one; a failing source moves to the next candidate", async () => {
    const db = createMemoryDb();
    const ids = lookupPlan("email", EMAIL, catalog).filter((p) => p.state === "auto").map((p) => p.id);
    const answers: Record<string, any> = { [ids[0]]: { ok: false, httpStatus: 500, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, isRouteMaxCost: false, isPlatformBalanceLow: false }, [ids[1]]: ok({ data: { person: null } }, 0) };
    const calls: string[] = [];
    const out = await runAdminLookup({ client: db, adminId: "adm-1", text: EMAIL, now: NOW, call: async (o) => { calls.push(o.endpointId); return answers[o.endpointId] ?? ok({ data: {} }, 0); } });
    expect(calls.slice(0, 2)).toEqual(ids.slice(0, 2));
    expect(out.ok && out.attempts.slice(0, 2).map((a) => a.outcome)).toEqual(["failed", "no_data"]);
    expect(out.ok ? Object.keys(out.fields) : []).toEqual([]);
  });
});

describe("Phase 5: the browser fallback history keeps no identity", () => {
  it("the page strips the fields before anything is written to localStorage and migrates the earlier key", () => {
    const page = readFileSync("src/app/admin/reverse-lookup/page.tsx", "utf-8");
    expect(page).toContain("reverseLookupHistory.v2");
    expect(page).toContain("removeItem(LEGACY_HISTORY_KEY)");
    expect(page).toMatch(/const withoutFields = [^\n]*fields: \{\}/);
    expect(page).toMatch(/setItem\(HISTORY_KEY, JSON\.stringify\(withoutFields\(rows\)/);
    // every write of the history goes through withoutFields
    const writes = page.match(/localStorage\.setItem\([^)]*/g) ?? [];
    expect(writes.length).toBe(2);
    for (const w of writes) expect(w).toMatch(/HISTORY_KEY, JSON\.stringify\((withoutFields|merged)/);
    expect(page).toContain("lookup-fields-not-kept");
  });
});
