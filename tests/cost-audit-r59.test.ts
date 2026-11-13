import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createJobCallBudget, jobCallCeilingUsd } from "../src/lib/server/callBudget";
import { executionBudgetUsd } from "../src/lib/agentMission/price";
import { AGENT_EXECUTION_CONTINUE_ROUNDS, AGENT_EXECUTION_LLM_BUDGET_FLOOR_USD, AGENT_EXECUTION_LLM_BUDGET_SHARE } from "../src/lib/agentMission/constants";
import { holdValueUsd } from "../src/lib/server/callBudget";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createWebGateway } from "../agent/src/webGateway";
import { fakeRecorder, USER_ID } from "./helpers/agentHarness";
import { emailsOf, fakeContextDev } from "./helpers/fakeContextDev";

/**
 * ROUND 59: WHY msn_088c's execution cost four times its plan's provider estimate, measured from its OWN recorded calls (tests/fixtures/msn-088c-calls.json, read from mission_calls)
 * and from the budget code as it is. No provider and no model is called. The proposal that follows from it is docs/proposals/execution-spend-gate.md (not applied).
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const USD_PER_PAGE = 0.00254;
const fixture = JSON.parse(readFileSync(new URL("./fixtures/msn-088c-calls.json", import.meta.url), "utf8")) as {
  mission: { reserved_points: number; execution_treg_usd: number; planning_treg_usd: number; plan_provider_cost_usd: number; contact_rows_planned: number; execution_llm_usd: number };
  delivered_company_sites: string[];
  calls: Array<{ phase: "planning" | "execution"; endpoint_id: string; status: "ok" | "empty" | "failed"; url: string | null; cost_usd: number; estimate_usd: number }>;
};
const exec = fixture.calls.filter((c) => c.phase === "execution");
const sum = (xs: ReadonlyArray<{ cost_usd: number }>) => Number(xs.reduce((n, c) => n + c.cost_usd, 0).toFixed(6));
/** One page, whatever the parser: lower-case host without «www.», the path without its last slash. */
const pageKey = (url: string) => { const u = new URL(url); return `${u.host.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`; };
const siteOf = (url: string) => new URL(url).host.toLowerCase().replace(/^www\./, "");

describe("round 59 cost audit: the recorded calls of msn_088c", () => {
  it("the fixture is the record: execution $0.09398 over 40 calls, planning $0.010516; it matches the mission row", () => {
    expect(exec).toHaveLength(40);
    expect(sum(exec)).toBeCloseTo(fixture.mission.execution_treg_usd, 6);
    expect(sum(fixture.calls.filter((c) => c.phase === "planning"))).toBeCloseTo(fixture.mission.planning_treg_usd, 6);
  });

  it("ZERO-RESULT CALLS ARE PAID: 16 empty parses cost $0.04064 (the provider bills the page it fetched, found or not); the 3 failed calls cost nothing", () => {
    const empty = exec.filter((c) => c.status === "empty");
    expect(empty).toHaveLength(16);
    expect(sum(empty)).toBeCloseTo(0.04064, 6);
    expect(empty.every((c) => c.cost_usd === USD_PER_PAGE)).toBe(true);
    const failed = exec.filter((c) => c.status === "failed");
    expect(failed).toHaveLength(3);
    expect(sum(failed)).toBe(0);
  });

  it("NO CALL WAS REPEATED WITH THE SAME INPUT, but the SAME PAGE was bought up to three times by different parsers: 37 paid reads of 13 pages, 24 of them ($0.06096) re-reads", () => {
    const sameInput = new Set(exec.map((c) => `${c.endpoint_id} ${c.url}`));
    expect(sameInput.size).toBe(exec.length);
    const paid = exec.filter((c) => c.cost_usd > 0);
    expect(paid).toHaveLength(37);
    const pages = new Set(paid.map((c) => pageKey(c.url!)));
    expect(pages.size).toBe(13);
    const rereads = paid.length - pages.size;
    expect(rereads).toBe(24);
    expect(Number((rereads * USD_PER_PAGE).toFixed(6))).toBe(0.06096);
    // the worst page: the home page and the contact page of one company, read by emails, phone-numbers, links, then a plain scrape
    const perPage = new Map<string, number>();
    for (const c of paid) perPage.set(pageKey(c.url!), (perPage.get(pageKey(c.url!)) ?? 0) + 1);
    expect(Math.max(...perPage.values())).toBe(3);
  });

  it("5 paid calls ($0.0127) read a company that is NOT in the delivered file (first-cosmetics.com): its contacts could never be delivered", () => {
    const delivered = new Set(fixture.delivered_company_sites);
    const orphan = exec.filter((c) => c.cost_usd > 0 && !delivered.has(siteOf(c.url!)));
    expect([...new Set(orphan.map((c) => siteOf(c.url!)))]).toEqual(["first-cosmetics.com"]);
    expect(orphan).toHaveLength(5);
    expect(sum(orphan)).toBeCloseTo(0.0127, 6);
  });

  it("THE ESTIMATE was one page per planned contact row (9 x $0.00254 = $0.02286); execution read 37 paid pages for 9 companies: 4.1 times the estimate", () => {
    expect(Number((fixture.mission.contact_rows_planned * USD_PER_PAGE).toFixed(5))).toBe(0.02286);
    expect(fixture.mission.plan_provider_cost_usd).toBeCloseTo(0.0229, 4);
    expect(sum(exec) / fixture.mission.plan_provider_cost_usd).toBeGreaterThan(4);
    expect(sum(exec) / fixture.mission.plan_provider_cost_usd).toBeLessThan(4.2);
  });

  it("ONE READ PER PAGE (a scrape, the e-mails and phones taken from its text by code) would have cost $0.03302 for the same 13 pages, and $0.02794 for the 11 pages of delivered companies", () => {
    const paid = exec.filter((c) => c.cost_usd > 0);
    const pages = new Set(paid.map((c) => pageKey(c.url!)));
    expect(Number((pages.size * USD_PER_PAGE).toFixed(5))).toBe(0.03302);
    const delivered = new Set(fixture.delivered_company_sites);
    const deliveredPages = [...pages].filter((p) => delivered.has(p.split("/")[0]));
    expect(deliveredPages).toHaveLength(11);
    expect(Number((deliveredPages.length * USD_PER_PAGE).toFixed(5))).toBe(0.02794);
  });
});

describe("round 59 cost audit: the budget did NOT fail open; its ceiling was far above the owner's authorization", () => {
  it("the execution ceiling of a 310-point hold is $0.2255 (40% of the hold's value): the $0.094 spent was inside it", () => {
    expect(executionBudgetUsd(fixture.mission.reserved_points)).toBeCloseTo(310 / 1375, 6);
    expect(fixture.mission.execution_treg_usd).toBeLessThan(executionBudgetUsd(fixture.mission.reserved_points));
    // the owner's remaining API authorization at approval time was $0.20 - $0.0735 of evaluations = $0.1265: the mission's own ceiling alone exceeded it. No code knows that authorization.
    expect(executionBudgetUsd(fixture.mission.reserved_points)).toBeGreaterThan(0.2 - 0.0735);
  });

  it("the call budget refuses BEFORE a call that would pass the ceiling, counts calls in flight (concurrency), and counts an unknown cost at its estimate (fails closed)", () => {
    const b = createJobCallBudget({ ceilingUsd: 0.01, spentUsd: 0 });
    expect(b.reserve(0.004)).toBe(true);
    expect(b.reserve(0.004)).toBe(true);
    // two calls in flight: a third would pass 0.01 although nothing is settled yet
    expect(b.reserve(0.004)).toBe(false);
    b.settle(0.004, 0); // a failed call: costs nothing
    b.settle(0.004, null); // an unknown cost: the estimate stays counted
    expect(b.spentUsd()).toBeCloseTo(0.004, 9);
    expect(b.reserve(0.006)).toBe(true);
    expect(b.reserve(0.000001)).toBe(false);
    expect(b.stopped()).toBe(true);
  });

  it("a hold with no value or a broken number still gets a ceiling (the floor), never «no ceiling»", () => {
    expect(executionBudgetUsd(0)).toBeCloseTo(0.005, 9);
    expect(executionBudgetUsd(Number.NaN)).toBeCloseTo(0.005, 9);
    expect(jobCallCeilingUsd({ perJobUsd: null, reservePoints: 310 })).toBeCloseTo((310 / 1375), 6);
  });

  it("GAP (documented, not changed): the model's execution budget is given to EACH round, so one mission's model spend may reach (rounds + 1) x the floor", () => {
    const perRound = Math.max(AGENT_EXECUTION_LLM_BUDGET_FLOOR_USD, holdValueUsd(310) * AGENT_EXECUTION_LLM_BUDGET_SHARE);
    expect(perRound).toBe(0.1);
    expect(AGENT_EXECUTION_CONTINUE_ROUNDS).toBe(2);
    expect((AGENT_EXECUTION_CONTINUE_ROUNDS + 1) * perRound).toBeCloseTo(0.3, 9);
    expect(fixture.mission.execution_llm_usd).toBeLessThan(perRound);
  });
});

describe("round 59 cost audit: what the gateway does with an empty page and with the same page read again WITHOUT the round-60 page rules (planning, or the kill switch)", () => {
  function setup(budget = 0.2) {
    const store = createMemoryStore();
    const mission = newMission({ id: "msn_cost0001", user_id: USER_ID, status: "executing" });
    store.missions.set(mission.id, mission);
    const rec = fakeRecorder({});
    const world = fakeContextDev({ parse: (parser: string) => (parser === "emails" ? { data: emailsOf([]), credits: 1 } : { data: { phoneNumbers: [], links: [] }, credits: 1 }) });
    const b = createJobCallBudget({ ceilingUsd: budget, spentUsd: 0 });
    const web = createWebGateway({ store, missionId: mission.id, jobId: "job_x", phase: "execution", budget: b, recorder: rec.recorder, providerKey: async () => "ctx-key-for-test", fetchFn: world.fetchFn as any, counter: { seq: 0 } });
    return { store, rec, b, web };
  }

  it("an EMPTY parse is recorded as «empty» at the full credit the provider reports", async () => {
    const t = setup();
    const r: any = await t.web.parsePage({ parser: "emails", url: "https://kaline.com" });
    expect(r.ok).toBe(true);
    expect(t.store.calls[0]).toMatchObject({ endpoint_id: "contextdev.parse.emails", status: "empty", rows_returned: 0 });
    expect(Number(t.store.calls[0].cost_usd)).toBeCloseTo(USD_PER_PAGE, 9);
    expect(t.b.spentUsd()).toBeCloseTo(USD_PER_PAGE, 9);
  });

  it("the same page read by a second parser is bought again (the root cause of msn_088c's re-reads); the budget still stops the call that would pass the ceiling", async () => {
    const t = setup(USD_PER_PAGE * 2 + 1e-7);
    await t.web.parsePage({ parser: "emails", url: "https://kaline.com" });
    await t.web.parsePage({ parser: "phone-numbers", url: "https://kaline.com" });
    expect(t.store.calls.filter((c) => Number(c.cost_usd) > 0)).toHaveLength(2);
    const third: any = await t.web.parsePage({ parser: "links", url: "https://kaline.com" });
    expect(third.refused).toBe("over_budget");
    expect(t.rec.rows).toHaveLength(2);
  });
});
