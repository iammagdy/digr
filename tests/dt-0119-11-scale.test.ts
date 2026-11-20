import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../agent/src/gateway";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { AGENT_JOB_POINTS_CAP } from "../src/lib/agentMission/constants";
import { executionBudgetUsd, priceMissionByCode, settlementCharge } from "../src/lib/agentMission/price";
import { expectedCost } from "../src/lib/agentMission/sourceRanking";
import { applyPriceCorrections, loadTregCatalog, parseCatalog, type TregCatalog } from "../src/lib/treg/catalog";
import { readFileSync } from "node:fs";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { fakeRecorder, NOT_ADMIN, USER_ID, tregResult } from "./helpers/agentHarness";
import { replay } from "./helpers/agentReplay";
import { ENDPOINT as TWEETS, TOPIC, PER_PAGE, pages, planning } from "./helpers/engineXScenario";

/**
 * DT-20261119-11 + Megz D-0140: real customers ask 50, 100 and 200 companies with one or two managers each, not two. Offline only (fake providers, ZERO spend). The quote and the hold scale; the D-0138 header and hold never refuse a normal call at scale;
 * the job's money covers every call; a daily limit or a timeout in the middle of the run ends in an honest partial delivery charged only for what was delivered.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const DIR = `${process.cwd()}/data/treg/`;
const fresh = (): TregCatalog => parseCatalog(JSON.parse(readFileSync(`${DIR}treg_catalog_sellable.json`, "utf8")), JSON.parse(readFileSync(`${DIR}treg_write_actions.json`, "utf8")));
const before = fresh();
const after = fresh();
applyPriceCorrections(after);
const FIND = "findymail.search.employees";
const BLITZ = "blitzapi.people.search";
const AIARK = "aiark.people.search";
const cheapest = (c: TregCatalog, capability: string): number => Math.min(...c.endpoints.filter((e) => e.capability === capability && (e.cost?.usd ?? 0) > 0).map((e) => expectedCost(e, c, undefined).usdPerItem as number).filter((v) => Number.isFinite(v) && v > 0));
const FINDER = { none: 0, email: cheapest(after, "people.email.find"), "email+phone": cheapest(after, "people.email.find") + cheapest(after, "people.phone.find") };
const perPerson = (c: TregCatalog, id: string) => expectedCost(c.byId.get(id)!, c, undefined).usdPerItem as number;
const card = (c: TregCatalog, id: string, companies: number, perCompany: number, contacts: keyof typeof FINDER) => {
  const p = priceMissionByCode([{ rows: companies, costPerRowUsd: 0.0005, deliver: true }, { rows: companies * perCompany, costPerRowUsd: perPerson(c, id) + FINDER[contacts], deliver: true }]);
  return { unit: Number(p.unitPricePoints.toFixed(4)), maxCharge: p.maxChargePoints, hold: p.reservePoints, overCap: p.overCap };
};

describe("T-S1: the quote and the hold scale with 50 / 100 / 200 companies x 1-2 managers, with and without email and phone", () => {
  const rows: string[] = [];
  for (const id of [FIND, BLITZ, AIARK]) for (const contacts of ["none", "email", "email+phone"] as const) for (const k of [1, 2]) for (const n of [50, 100, 200]) {
    it(`${id.split(".")[0]} ${contacts} ${n} companies x ${k}`, () => {
      const a = card(after, id, n, k, contacts);
      rows.push(`${id.split(".")[0]} | ${contacts} | ${n}x${k} | ${a.maxCharge} / ${a.hold}${a.overCap ? " (over the 25,000-point cap: the customer is asked to lower the count)" : ""}`);
      // the unit price is a cost per delivered row: it never GROWS with the count (the model's fixed cost is spread over more rows, so it falls a little)
      const small = card(after, id, 50, k, contacts);
      expect(a.unit).toBeLessThanOrEqual(small.unit * 1.0001);
      expect(a.unit).toBeGreaterThanOrEqual(small.unit * 0.4);
      // the charge for the whole request and the hold scale linearly with the number of delivered rows (companies + people), the hold is never below the charge
      const rowsDelivered = n * (1 + k);
      expect(a.maxCharge).toBeGreaterThanOrEqual(Math.floor(rowsDelivered * a.unit));
      expect(a.hold).toBeGreaterThanOrEqual(a.maxCharge);
      expect(a.overCap).toBe(a.hold > AGENT_JOB_POINTS_CAP);
      // never below main's price for the same card: the correction only raises a stored price
      const was = card(before, id, n, k, contacts);
      expect(a.maxCharge).toBeGreaterThanOrEqual(was.maxCharge);
      if (id === AIARK) expect(a).toEqual(was);
    });
  }
  it("the 50 / 100 / 200 table (printed for the PR)", () => { expect(rows.length).toBe(54); });
});

/** A provider that bills `price(o)` and answers 402 when the header is below it (the real behaviour of the route cap). */
const provider = (price: (o: TregCallOptions) => number) => async (o: TregCallOptions): Promise<TregCallResult> => {
  const real = price(o);
  if (!(Number(o.routeMaxCostUsd) >= real - 1e-12)) return { ok: false, httpStatus: 402, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, error: "route_max_cost", isRouteMaxCost: true, isPlatformBalanceLow: false };
  return tregResult([{ name: "A", linkedinUrl: "https://www.linkedin.com/in/a", companyWebsite: "acme.example" }], real);
};
const CLIENT = { from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({}) }), select: () => ({ eq: () => ({ gte: () => ({ lt: async () => ({ data: [], error: null }) }) }) }) }) };
function run(o: { budgetUsd: number; dailyCapUsd: number; call: (x: TregCallOptions) => Promise<TregCallResult> }) {
  const store = createMemoryStore();
  store.missions.set("m1", newMission({ id: "m1", user_id: USER_ID, request_text: "x", status: "executing", job_id: "j1" }));
  const rec = fakeRecorder({ dailyCapUsd: o.dailyCapUsd });
  const budget = createJobCallBudget({ ceilingUsd: o.budgetUsd, spentUsd: 0 });
  const call = vi.fn(o.call);
  const gateway = createGateway({ store, client: CLIENT, missionId: "m1", userId: USER_ID, jobId: "j1", phase: "execution", access: NOT_ADMIN, catalog: loadTregCatalog(), budget, recorder: rec.recorder, commit: rec.commit, call, defaultPurpose: "t", counter: { seq: 0 } });
  return { gateway, rec, budget, call };
}
const findCall = (g: ReturnType<typeof run>, i: number, count: number) => g.gateway.tregCall({ endpoint_id: FIND, params: { website: `c${i}.example`, job_titles: ["CEO"], count } });

describe("T-S2: at scale the job's money covers EVERY call and the D-0138 header/hold never refuses a normal call", () => {
  for (const n of [50, 100]) for (const k of [1, 2]) it(`${n} companies x ${k} manager(s) of findymail: ${n} calls of ${(0.0198 * k).toFixed(4)} USD, the budget is the execution budget of the card's own hold`, async () => {
    const q = card(after, FIND, n, k, "email");
    // a card above the 25,000-point cap cannot be approved (the customer lowers the count; nothing is held): there is no run to simulate
    if (q.overCap) { expect(q.hold).toBeGreaterThan(AGENT_JOB_POINTS_CAP); return; }
    const g = run({ budgetUsd: executionBudgetUsd(q.hold), dailyCapUsd: 1000, call: provider(() => 0.0198 * k) });
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(await findCall(g, i, k));
    expect(out.filter((r) => !r.ok)).toHaveLength(0); // no over_budget, no daily_cap, no 402: every call of the run went out and was answered
    expect(g.call).toHaveBeenCalledTimes(n);
    expect(g.budget.spentUsd()).toBeCloseTo(n * 0.0198 * k, 6);
    expect(g.budget.spentUsd()).toBeLessThanOrEqual(executionBudgetUsd(q.hold) + 1e-9);
    expect(g.budget.leftUsd(0)!).toBeGreaterThanOrEqual(0);
    // the money held while a call runs is released: nothing stays reserved at the end
    expect(g.rec.rows.every((r) => r.committedUsd !== null)).toBe(true);
  });
  it("200 companies: the card is over the 25,000-point cap for findymail people (the customer lowers the count: nothing is held), and with blitz people it fits and every call goes out", async () => {
    expect(card(after, FIND, 200, 2, "email").overCap).toBe(true);
    const q = card(after, BLITZ, 200, 2, "email");
    expect(q.overCap).toBe(false);
    const g = run({ budgetUsd: executionBudgetUsd(q.hold), dailyCapUsd: 1000, call: provider((o) => 0.001 * Number((o.params as { max_results?: number }).max_results ?? 10)) });
    const refused = [];
    for (let i = 0; i < 200; i += 1) {
      const r = await g.gateway.tregCall({ endpoint_id: BLITZ, params: { company: { linkedin_url: [`https://www.linkedin.com/company/c${i}`] }, people: { job_title: { include: ["CEO"] } }, max_results: 2 } });
      if (!r.ok) refused.push(r);
    }
    expect(refused).toHaveLength(0);
    expect(g.budget.spentUsd()).toBeCloseTo(200 * 0.002, 6);
  });
});

describe("T-S3: a provider daily limit in the middle of the run: calls go out until the day's money is used, then each is refused daily_cap; nothing is lost to the held amounts", () => {
  it("100 companies, 1 manager each, a 0.80 USD day: the first 40 calls (0.0198 each) are answered, the other 60 are refused daily_cap, and the day's total never passes 0.80", async () => {
    const g = run({ budgetUsd: 50, dailyCapUsd: 0.8, call: provider(() => 0.0198) });
    const out = [];
    for (let i = 0; i < 100; i += 1) out.push(await findCall(g, i, 1));
    const done = out.filter((r) => r.ok).length;
    expect(done).toBe(40);
    expect(out.filter((r) => !r.ok).every((r) => (r as { refused?: string }).refused === "daily_cap")).toBe(true);
    expect(g.rec.rows.reduce((n, r) => n + (r.committedUsd ?? r.reservedUsd), 0)).toBeLessThanOrEqual(0.8 + 1e-9);
    expect(g.budget.spentUsd()).toBeCloseTo(40 * 0.0198, 6);
  });
});

describe("T-S4: end to end on the money fake: a daily limit or a timeout in the middle of a 300-item run ends honestly, charged only for what was delivered", () => {
  const request = "هات ٣٠٠ تغريدة عن محمد صلاح";
  const unitOf = (m: any) => Number(m.unit_price_points);
  it("a daily limit after a few pages: a partial delivery, the charge is exactly the delivered rows at the unit price, the rest of the hold is released", async () => {
    const capped = fakeRecorder({ dailyCapUsd: 0.006 });
    const r = await replay({ request, planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30)], deps: (base) => ({ ...base, recorder: capped.recorder, commit: capped.commit }) });
    const m: any = r.mission;
    expect(m.status).toBe("completed");
    expect(m.delivered_units).toBeGreaterThan(0);
    expect(m.delivered_units).toBeLessThan(300);
    // charge = exactly what was delivered at the unit price (the card's 200-point minimum is only in the HOLD): far below the hold, and the rest of the hold comes back
    expect(m.charged_points).toBe(settlementCharge({ deliveredUnits: m.delivered_units, unitPricePoints: unitOf(m), reservedPoints: m.reserved_points }).chargedPoints);
    expect(m.charged_points).toBeLessThan(m.reserved_points);
    // the money fake books it as the database does: the hold is released whole and the delivered rows are charged: the customer ends up out of pocket by exactly the charge
    expect(r.money.ledger.find((l) => l.type === "charge")!.delta).toBe(-m.charged_points);
    expect(r.money.ledger.find((l) => l.type === "release")!.delta).toBe(m.reserved_points);
    expect(r.money.balance()).toBe(r.initialBalance - m.charged_points);
    expect(r.finalView.resultSummaryAr ?? "").toMatch(/لم يُخصم إلا مقابل ما سُلّم/);
    void TWEETS; void TOPIC; void PER_PAGE;
  }, 120_000);
  it("at the scale of a real card (100 companies, 1 manager each, findymail with e-mail) a delivery stopped at 70 of 200 rows is charged ONLY for the 70, and the rest of the hold comes back", () => {
    const q = card(after, FIND, 100, 1, "email");
    const p = priceMissionByCode([{ rows: 100, costPerRowUsd: 0.0005, deliver: true }, { rows: 100, costPerRowUsd: perPerson(after, FIND) + FINDER.email, deliver: true }]);
    const part = settlementCharge({ deliveredUnits: 70, unitPricePoints: p.unitPricePoints, reservedPoints: p.reservePoints });
    expect(part.chargedPoints).toBe(Math.ceil(70 * p.unitPricePoints));
    expect(part.chargedPoints).toBeLessThan(q.maxCharge);
    expect(part.chargedPoints + part.releasedPoints).toBe(q.hold);
    expect(part.releasedPoints).toBeGreaterThan(q.hold / 2);
  });
  it("a timeout in the middle of the run (one page): the run goes on, every item is delivered, the charge is exactly the delivered rows, and the job is NOT stopped as «budget»", async () => {
    const timeout = tregResult(null, 0, { ok: false, timedOut: true, httpStatus: 0, error: "timeout" } as never);
    const r = await replay({ request, planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30).slice(0, 5), timeout, ...pages(30).slice(5)] });
    const m: any = r.mission;
    expect(m.status).toBe("completed");
    expect(m.delivered_units).toBe(300);
    expect(m.charged_points).toBe(settlementCharge({ deliveredUnits: 300, unitPricePoints: unitOf(m), reservedPoints: m.reserved_points }).chargedPoints);
    expect(r.finalView.resultSummaryAr ?? "").not.toMatch(/ميزانية القراءة/);
  }, 120_000);
});
