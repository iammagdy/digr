import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../agent/src/gateway";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { fakeRecorder, NOT_ADMIN, USER_ID } from "./helpers/agentHarness";
import { tregResult } from "./helpers/agentFakeWorld";

/**
 * DT-20261119-11 Gate 2, F4 (P0-4): the contact-finder QUARTER cap (0.25 of the planning budget) is reserved atomically against the contact holds that are in flight, not only checked against estimates. A known charge, an unknown charge and two racing samples can never
 * take more than the quarter. No network.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const catalog: any = loadTregCatalog();
const PLANNING_USD = 0.2;
const QUARTER = 0.05;
const CLIENT: any = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }), select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }) };
const requiredParams = (id: string): Record<string, unknown> => Object.fromEntries(catalog.byId.get(id).inputs.filter((i: any) => i.required).map((i: any) => [i.name, i.type === "number" || i.type === "integer" ? 5 : "acme.example"]));

function world(call: (o: TregCallOptions) => Promise<TregCallResult>) {
  const store = createMemoryStore();
  const mission = newMission({ id: "msn_g2c", user_id: USER_ID, request_text: "x", status: "planning" });
  store.missions.set(mission.id, mission);
  const rec = fakeRecorder({});
  const fn = vi.fn(call);
  const budget = createJobCallBudget({ ceilingUsd: PLANNING_USD, spentUsd: 0 });
  const gateway = createGateway({ store, client: CLIENT, missionId: mission.id, userId: USER_ID, jobId: null, phase: "planning", access: NOT_ADMIN, catalog, budget, recorder: rec.recorder, commit: rec.commit, call: fn as any, defaultPurpose: "x", counter: { seq: 0 }, stageBudget: { stages: 2, budgetUsd: PLANNING_USD } } as any);
  const ask = (id: string) => gateway.tregCall({ endpoint_id: id, params: { ...requiredParams(id), email: "k@acme.example", domain: "acme.example", linkedin: "https://www.linkedin.example/in/k" }, why: "contact sample" });
  /** The cheapest ranked finder of a kind: the refusal of a dearer one names it. */
  const cheapest = async (probe: string) => String(((await ask(probe)) as any).message).match(/first: (\S+)/)![1];
  return { gateway, fn, rec, budget, ask, cheapest, store };
}
const timeout = async (): Promise<TregCallResult> => ({ ok: false, httpStatus: 0, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, error: "timeout", timedOut: true, isRouteMaxCost: false, isPlatformBalanceLow: false });
const headerOf = (w: ReturnType<typeof world>, n = 0) => Number((w.fn.mock.calls[n][0] as TregCallOptions).routeMaxCostUsd);

describe("F4: the contact-finder quarter cap is reserved, not only estimated", () => {
  it("a KNOWN charge: the header of the cheapest e-mail finder is within the quarter, and the planning still has money for the other stages", async () => {
    const w = world(async () => tregResult({ results: [{ email: "x@acme.example" }] }, 0.001));
    const id = await w.cheapest("anyapi.linkedin.email.work.find");
    expect((await w.ask(id)).ok).toBe(true);
    expect(headerOf(w)).toBeLessThanOrEqual(QUARTER + 1e-9);
    expect(w.rec.rows[0].reservedUsd).toBeLessThanOrEqual(QUARTER + 1e-9);
    expect(w.budget.spentUsd()).toBeCloseTo(0.001, 6);
  });
  it("an UNKNOWN charge (a timeout) keeps at most the quarter; companies and people samples still run afterwards", async () => {
    let n = 0;
    const w = world(async (o) => (n++ === 0 ? timeout() : tregResult({ results: [{ name: "A" }] }, 0.001)));
    const id = await w.cheapest("anyapi.linkedin.email.work.find");
    await w.ask(id);
    expect(headerOf(w)).toBeLessThanOrEqual(QUARTER + 1e-9);
    expect(w.budget.spentUsd()).toBeLessThanOrEqual(QUARTER + 1e-9);
    expect(w.rec.rows[0].committedUsd!).toBeLessThanOrEqual(QUARTER + 1e-9);
    // a company search and a people search still go out and succeed with the planning money that is left
    const company = await w.gateway.tregCall({ endpoint_id: "aiark.companies.search", params: { ...requiredParams("aiark.companies.search") }, why: "companies" });
    expect(company).not.toMatchObject({ refused: expect.stringMatching(/over_budget|stage_reserved/) });
    expect(w.fn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it("two racing samples of the SAME kind: only one is sent (one sample per kind holds while it is in flight), the quarter is never passed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = world(async () => { await gate; return tregResult({ results: [{ email: "x@acme.example" }] }, 0.001); });
    const id = await w.cheapest("anyapi.linkedin.email.work.find");
    const a = w.ask(id);
    await new Promise((r) => setTimeout(r, 10));
    const b = await w.ask(id);
    expect(b).toMatchObject({ ok: false, refused: "contact_sample" });
    release();
    expect((await a).ok).toBe(true);
    expect(w.fn).toHaveBeenCalledTimes(1);
  });
  it("two racing samples of DIFFERENT kinds (e-mail and phone): the headers together, and the amounts held together, never pass the quarter", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = world(async () => { await gate; return tregResult({ results: [{ email: "x@acme.example", phone: "+201001234567" }] }, 0.001); });
    const email = await w.cheapest("anyapi.linkedin.email.work.find");
    const phone = await w.cheapest("quickenrich.people.phone.find");
    const a = w.ask(email);
    const b = w.ask(phone);
    await new Promise((r) => setTimeout(r, 20));
    const sent = w.fn.mock.calls.map((c) => Number((c[0] as TregCallOptions).routeMaxCostUsd));
    expect(sent.reduce((n, x) => n + x, 0)).toBeLessThanOrEqual(QUARTER + 1e-9);
    expect(w.rec.rows.reduce((n, r) => n + r.reservedUsd, 0)).toBeLessThanOrEqual(QUARTER + 1e-9);
    release();
    await Promise.all([a, b]);
  });
  it("the hold is given back once: after a refused finder (no daily room) the contact allowance is whole again", async () => {
    const store = createMemoryStore();
    const mission = newMission({ id: "msn_g2c2", user_id: USER_ID, request_text: "x", status: "planning" });
    store.missions.set(mission.id, mission);
    const rec = fakeRecorder({ dailyCapUsd: 0 });
    const budget = createJobCallBudget({ ceilingUsd: PLANNING_USD, spentUsd: 0 });
    const call = vi.fn(async () => tregResult({ results: [] }, 0));
    const gateway = createGateway({ store, client: CLIENT, missionId: mission.id, userId: USER_ID, jobId: null, phase: "planning", access: NOT_ADMIN, catalog, budget, recorder: rec.recorder, commit: rec.commit, call: call as any, defaultPurpose: "x", counter: { seq: 0 }, stageBudget: { stages: 2, budgetUsd: PLANNING_USD } } as any);
    const ask = (id: string) => gateway.tregCall({ endpoint_id: id, params: { ...requiredParams(id), email: "k@acme.example", domain: "acme.example" }, why: "x" });
    const id = String(((await ask("anyapi.linkedin.email.work.find")) as any).message).match(/first: (\S+)/)![1];
    expect(await ask(id)).toMatchObject({ ok: false, refused: "daily_cap" });
    expect(call).not.toHaveBeenCalled();
    expect(budget.leftUsd()).toBe(PLANNING_USD); // nothing stays held on the job
    // the contact allowance and the kind are free again: the same finder is admitted (and refused only by the daily cap)
    expect(await ask(id)).toMatchObject({ ok: false, refused: "daily_cap" });
  });
});
