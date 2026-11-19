import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CATALOG_PRICE_REV, DECLARED_PRICE_CORRECTIONS, applyPriceCorrections, parseCatalog, loadTregCatalog, type PriceCorrection, type TregCatalog } from "../src/lib/treg/catalog";
import { tregCallBoundOf } from "../agent/src/gateway";
import { expectedCost } from "../src/lib/agentMission/sourceRanking";
import { peopleEstimateOf } from "../src/lib/agentMission/peopleEstimate";
import { peopleSourcesForCompanies } from "../src/lib/agentMission/childSources";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { priceStep, unitCost } from "../src/lib/modelPlanner/pricing";
import { approveMission } from "../src/lib/agentMission/lifecycle";
import { planNeedsRequote } from "../src/lib/agentMission/catalogPriceGuard";
import { classifyNoCardEnd, noCardSentenceAr, INTERNAL_PLANNING_AR, SOURCES_FAILED_AR } from "../src/lib/agentMission/refusal";
import { B2B_CARDS } from "../src/lib/agentMission/stage3/b2bCards";

const DIR = `${process.cwd()}/data/treg/`;
/** A FRESH parse of the pinned snapshot: no shared cache, no shared objects (D8). */
const fresh = (): TregCatalog => parseCatalog(JSON.parse(readFileSync(`${DIR}treg_catalog_sellable.json`, "utf8")), JSON.parse(readFileSync(`${DIR}treg_write_actions.json`, "utf8")));
const FIND = "findymail.search.employees";
const BLITZ = ["blitzapi.people.employee-finder", "blitzapi.people.search", "blitzapi.people.waterfall-icp"];
const CONTROLS = ["aiark.people.search", "aviato.people.search", "aviato.people.search.simple", "tomba.companies.search.reveal", "icypeas.people.search"];

describe("T7 (D8): the declared correction layer checks the WHOLE old tuple and fails loudly on a surprise", () => {
  it("stale snapshot (the pinned one): every entry is applied; a second application to the corrected object is a no-op (already correct)", () => {
    const c = fresh();
    expect(applyPriceCorrections(c).map((r) => r.state)).toEqual(DECLARED_PRICE_CORRECTIONS.map(() => "applied"));
    expect(applyPriceCorrections(c).map((r) => r.state)).toEqual(DECLARED_PRICE_CORRECTIONS.map(() => "already_correct"));
  });
  it("unexpected drift in ANY field of the tuple (unit, price, the size input's default / minimum / maximum) throws and names the endpoint; a missing endpoint throws", () => {
    const drift = (mutate: (c: TregCatalog) => void) => { const c = fresh(); mutate(c); return () => applyPriceCorrections(c); };
    expect(drift((c) => { (c.byId.get(FIND) as any).cost = { ...(c.byId.get(FIND) as any).cost, unit: "page" }; })).toThrow(/findymail\.search\.employees/);
    expect(drift((c) => { (c.byId.get(FIND) as any).cost = { ...(c.byId.get(FIND) as any).cost, usd: 0.03 }; })).toThrow(/findymail/);
    expect(drift((c) => { (c.byId.get(FIND) as any).inputs = (c.byId.get(FIND) as any).inputs.map((i: any) => (i.name === "count" ? { ...i, maximum: 5 } : i)); })).toThrow(/findymail/);
    expect(drift((c) => { (c.byId.get(FIND) as any).inputs = (c.byId.get(FIND) as any).inputs.map((i: any) => (i.name === "count" ? { ...i, default: 2 } : i)); })).toThrow(/findymail/);
    expect(drift((c) => { (c.byId.get(BLITZ[1]) as any).cost = { ...(c.byId.get(BLITZ[1]) as any).cost, usd: 0.0007 }; })).toThrow(/blitzapi\.people\.search/);
    expect(() => applyPriceCorrections(fresh(), [{ ...DECLARED_PRICE_CORRECTIONS[0], id: "no.such.endpoint" } as PriceCorrection])).toThrow(/not in the snapshot/);
  });
  it("a refreshed snapshot that already holds the corrected tuple is left alone (no throw)", () => {
    const c = fresh();
    applyPriceCorrections(c);
    expect(() => applyPriceCorrections(c)).not.toThrow();
  });
  it("the pinned snapshot bytes are untouched and the real loader applies every entry exactly once", () => {
    const real = loadTregCatalog();
    expect(real.byId.get(FIND)!.cost).toMatchObject({ unit: "result", usd: 0.0198 });
    expect(real.byId.get(FIND)!.inputs.find((i) => i.name === "count")).toMatchObject({ default: 1, minimum: 1, maximum: 3 });
    for (const id of BLITZ) expect(real.byId.get(id)!.cost?.usd).toBe(0.001);
    expect(CATALOG_PRICE_REV).toBe(1);
  });
  it("T8 parity: the stage3 card copy of the blitz employee-finder price equals the catalog", () => {
    const card = B2B_CARDS.find((c) => c.endpointId === "blitzapi.people.employee-finder")!;
    expect(card.costUsd).toBe(loadTregCatalog().byId.get("blitzapi.people.employee-finder")!.cost!.usd);
  });
});

describe("T8 (D8): estimates and customer quotes recomputed from the REAL correction on one of two independent parses", () => {
  const before = fresh();
  const after = fresh();
  applyPriceCorrections(after);
  it("findymail estimate: 0.0198 x min(count, 3) (unset = 1); blitz 0.001 x max_results; controls identical", () => {
    const bound = (c: TregCatalog, id: string, p: Record<string, unknown>) => tregCallBoundOf(id, p, c)!;
    for (const [count, want] of [[undefined, 0.0198], [1, 0.0198], [2, 0.0396], [3, 0.0594], [5, 0.0594], [10, 0.0594]] as Array<[number | undefined, number]>) expect(bound(after, FIND, count === undefined ? {} : { count })).toBeCloseTo(want, 9);
    expect(bound(before, FIND, { count: 3 })).toBeCloseTo(0.0198, 9);
    for (const [n, want] of [[1, 0.001], [2, 0.002], [10, 0.01]] as Array<[number, number]>) for (const id of BLITZ) expect(bound(after, id, { max_results: n })).toBeCloseTo(want, 9);
    for (const id of CONTROLS) expect(bound(after, id, {})).toBe(bound(before, id, {}));
  });
  it("findymail is priced PER PERSON: 0.0198 whatever the sample size (the call-unit division by sample rows no longer applies); a call-unit endpoint WITHOUT per-result still divides", () => {
    for (const rows of [1, 3, 20]) expect(priceStep(unitCost(after.byId.get(FIND)!, after)!, { rowsPerCall: rows, passRate: 1, source: "sample" }).costPerRecordUsd).toBeCloseTo(0.0198, 9);
    expect(priceStep(unitCost(before.byId.get(FIND)!, before)!, { rowsPerCall: 3, passRate: 1, source: "sample" }).costPerRecordUsd).toBeCloseTo(0.0066, 9);
    const control = after.byId.get("aviato.people.search")!;
    expect(priceStep(unitCost(control, after)!, { rowsPerCall: 5, passRate: 1, source: "sample" }).costPerRecordUsd).toBeCloseTo(0.0025 / 5, 9);
  });
  it("the customer's quote (default markup and minimum), before -> after, for (a) 2 companies + 1 manager each and (b) 5 companies + 2 each; companies-only unchanged", () => {
    const card = (c: TregCatalog, id: string, companies: number, people: number) => {
      const per = expectedCost(c.byId.get(id)!, c, undefined).usdPerItem as number;
      const p = priceMissionByCode([{ rows: companies, costPerRowUsd: 0.0005, deliver: true }, { rows: people, costPerRowUsd: per, deliver: true }]);
      return [p.maxChargePoints, p.reservePoints];
    };
    const only = (rows: number) => { const p = priceMissionByCode([{ rows, costPerRowUsd: 0.0005, deliver: true }]); return [p.maxChargePoints, p.reservePoints]; };
    expect(only(2)).toEqual([200, 200]);
    expect(only(5)).toEqual([200, 200]);
    expect(card(before, FIND, 2, 2)).toEqual([200, 200]);
    expect(card(after, FIND, 2, 2)).toEqual([367, 422]);
    expect(card(before, FIND, 5, 10)).toEqual([212, 243]);
    expect(card(after, FIND, 5, 10)).toEqual([1246, 1433]);
    expect(card(before, BLITZ[1], 2, 2)).toEqual([200, 200]);
    expect(card(after, BLITZ[1], 2, 2)).toEqual([200, 200]);
    expect(card(before, BLITZ[1], 5, 10)).toEqual([200, 212]);
    expect(card(after, BLITZ[1], 5, 10)).toEqual([212, 244]);
    for (const id of CONTROLS.slice(0, 3)) expect(card(after, id, 5, 10)).toEqual(card(before, id, 5, 10));
  });
  it("the estimated people stage: the dearest of the top 3 sources is blitz at 0.001 (was 0.000495); findymail leaves the table (its price per person is now real)", () => {
    const est = (c: TregCatalog) => peopleEstimateOf(peopleSourcesForCompanies(c, () => true, Date.parse("2026-11-19T12:00:00Z")), new Set());
    expect(est(before)!.costPerPersonUsd).toBeCloseTo(0.000495198, 8);
    expect(est(after)!.costPerPersonUsd).toBeCloseTo(0.0010001, 7);
    expect(est(after)!.endpointIds).not.toContain(FIND);
    expect(est(before)!.endpointIds).toContain(FIND);
  });
  it("only the four corrected endpoints differ between the two catalogs (price, unit and limits)", () => {
    const ids = before.endpoints.filter((e) => JSON.stringify([e.cost, e.inputs]) !== JSON.stringify([after.byId.get(e.id)!.cost, after.byId.get(e.id)!.inputs])).map((e) => e.id).sort();
    expect(ids).toEqual([FIND, ...BLITZ].sort());
  });
});

describe("D7: an unapproved card quoted before the correction is refused at approval BEFORE anything is reserved or charged", () => {
  const stage = (endpoint: string) => ({ key: "people", endpoint_id: endpoint, planned_rows: 2, deliver: true, measured_cost_per_row_usd: 0.00099, columns: [], title_ar: "x", parent_key: null }) as never;
  const oldPlan = (endpoint: string, pricedUnder?: number) => ({ stages: [stage(endpoint)], price: { rule: 2, settings: { markup: 10, minChargePoints: 200 }, unitPricePoints: 1, reservePoints: 1, deliveredRows: 2, ...(pricedUnder === undefined ? {} : { pricedUnder }) } }) as never;
  it("planNeedsRequote: no stamp + a corrected endpoint -> true; the current stamp -> false (a regenerated card is never refused); an unrelated endpoint -> false", () => {
    expect(planNeedsRequote(oldPlan(FIND))).toBe(true);
    expect(planNeedsRequote(oldPlan("blitzapi.people.search", 0))).toBe(true);
    expect(planNeedsRequote(oldPlan(FIND, CATALOG_PRICE_REV))).toBe(false);
    expect(planNeedsRequote(oldPlan("aiark.people.search"))).toBe(false);
  });
  it("a plan priced now carries the current revision", () => {
    expect(priceMissionByCode([{ rows: 2, costPerRowUsd: 0.01, deliver: true }]).pricedUnder).toBe(CATALOG_PRICE_REV);
  });
  it("approveMission answers plan_changed and touches the ledger NOT AT ALL (no quote, no reserve, no charge); the customer text is customerActions.ts's, verbatim", async () => {
    const rpc = vi.fn();
    const client = { rpc, from: vi.fn() };
    const out = await approveMission(client, { id: "m1", user_id: "u1", plan: oldPlan(FIND) });
    expect(out).toMatchObject({ ok: false, code: "plan_changed" });
    expect(rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
    expect(readFileSync(`${process.cwd()}/src/lib/agentMission/customerActions.ts`, "utf8")).toContain("plan_changed: \"تغيّر سعر الخطة؛ اطلب المهمة من جديد ليُحسب لك سعر محدّث.\"");
  });
});

describe("D6: a planning that ended because every source failed never tells the customer «a limit on our side»", () => {
  const failed = (id: string) => ({ phase: "planning" as const, status: "failed" as const, endpoint_id: id, refused_reason: null, rows_returned: 0 });
  it("every planning call failed (the 402s of findymail and blitz): the typed admin reason stays sources_failed, the customer sentence is the neutral source-failure text", () => {
    const verdict = classifyNoCardEnd({ claim: null, endedWithoutAnswer: false, calls: [failed(FIND), failed(BLITZ[0]), failed(BLITZ[1])] } as never);
    expect(verdict).toEqual({ cls: "internal", reason: "sources_failed" });
    const sentence = noCardSentenceAr(verdict);
    expect(sentence).toBe(SOURCES_FAILED_AR);
    expect(sentence).not.toContain("حد من جانبنا");
    expect(sentence).not.toMatch(/route_max_cost|TREG|findymail|blitz|\d/i);
  });
  it("the real internal causes keep their own wording (an own limit, a plan that stayed invalid)", () => {
    expect(noCardSentenceAr({ cls: "internal", reason: "planning_over_budget" })).toBe(INTERNAL_PLANNING_AR);
    expect(noCardSentenceAr({ cls: "internal", reason: "plan_invalid_after_12_rejections" })).toBe(INTERNAL_PLANNING_AR);
  });
});
