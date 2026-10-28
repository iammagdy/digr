import { describe, expect, it } from "vitest";
import { unitPricePointsFromCost } from "../src/lib/recordPricing";
import { AGENT_JOB_POINTS_CAP, AGENT_PLANNING_BUDGET_USD } from "../src/lib/agentMission/constants";
import { chargeForDelivered, executionBudgetUsd, legacyPriceMissionByCode, measuredCostPerRowUsd, priceMissionByCode, reservePointsFor, settlementCharge } from "../src/lib/agentMission/price";
import { AGENT_MODEL_EXECUTION_PER_STAGE_ESTIMATE_USD, AGENT_MODEL_PLANNING_ESTIMATE_USD } from "../src/lib/agentMission/constants";
import { approveMission, repriceStoredPlan, settleMission } from "../src/lib/agentMission/lifecycle";
import { validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { pricedTwoStagePlan } from "./helpers/agentPlan";

describe("the price of a mission is computed by code", () => {
  it("unit price = cost per final row x 5,500; reserve = ceil(volume x unit x 1.15); charge = ceil(delivered x unit)", () => {
    // the formula of plans stored before the one pricing rule (provider cost alone): kept as legacyPriceMissionByCode, so a plan the customer was shown is approved at the price it showed
    const p = legacyPriceMissionByCode([{ rows: 100, costPerRowUsd: 0.0002, deliver: true }]);
    expect(p.costPerFinalRowUsd).toBeCloseTo(0.0002, 10);
    expect(p.unitPricePoints).toBe(unitPricePointsFromCost(0.0002)); // 1.1 points
    expect(p.unitPricePoints).toBeCloseTo(1.1, 6);
    expect(p.reservePoints).toBe(Math.ceil(100 * 1.1 * 1.15)); // 127
    expect(p.maxChargePoints).toBe(110); // exactly 110 (JavaScript's 100 x 1.1 is 110.00000000000001: the code does not use floats)
    expect(p.overCap).toBe(false);
  });

  it("a two-stage mission spreads the whole cost over the delivered rows only", () => {
    // 20 posts at 0.005 each (not delivered), 200 comments at 0.0003 each (delivered)
    const p = legacyPriceMissionByCode([{ rows: 20, costPerRowUsd: 0.005, deliver: false }, { rows: 200, costPerRowUsd: 0.0003, deliver: true }]);
    expect(p.totalCostUsd).toBeCloseTo(20 * 0.005 + 200 * 0.0003, 10);
    expect(p.deliveredRows).toBe(200);
    expect(p.costPerFinalRowUsd).toBeCloseTo((0.1 + 0.06) / 200, 10);
  });

  it("flags a reserve above the 25,000 point cap", () => {
    const p = priceMissionByCode([{ rows: 5000, costPerRowUsd: 0.002, deliver: true }]);
    expect(p.reservePoints).toBeGreaterThan(AGENT_JOB_POINTS_CAP);
    expect(p.overCap).toBe(true);
  });

  it("measures cost per row from the recorded charges and rows of the calls, not from any number the model gives", () => {
    expect(measuredCostPerRowUsd([{ costUsd: 0.01, rows: 20 }, { costUsd: 0.02, rows: 20 }])).toBeCloseTo(0.03 / 40, 10);
    expect(measuredCostPerRowUsd([{ costUsd: 0.01, rows: 0 }])).toBeNull();
  });

  it("exact integer arithmetic: no float drift ever lets a charge pass a reserve", () => {
    for (const unit of [0.11715, 1.1, 0.000001, 2.75, 13.333333, 0.999999]) {
      for (const volume of [1, 7, 100, 999, 5000]) {
        const reserve = reservePointsFor(volume, unit);
        for (const delivered of [0, 1, Math.floor(volume / 2), volume]) {
          const charge = chargeForDelivered(delivered, unit);
          expect(settlementCharge({ deliveredUnits: delivered, unitPricePoints: unit, reservedPoints: reserve }).chargedPoints).toBeLessThanOrEqual(reserve);
          expect(charge).toBe(Math.ceil(Math.round(delivered * unit * 1e6) / 1e6 - 1e-12) || 0);
        }
      }
    }
  });

  it("settlement never charges above the reserve nor above the cap", () => {
    expect(settlementCharge({ deliveredUnits: 1000, unitPricePoints: 2, reservedPoints: 1500 })).toEqual({ chargedPoints: 1500, releasedPoints: 0 });
    expect(settlementCharge({ deliveredUnits: 10, unitPricePoints: 1.1, reservedPoints: 100 })).toEqual({ chargedPoints: 11, releasedPoints: 89 });
    expect(settlementCharge({ deliveredUnits: 0, unitPricePoints: 1.1, reservedPoints: 100 })).toEqual({ chargedPoints: 0, releasedPoints: 100 });
  });

  it("the budgets: planning 0.05 USD; execution 40% of the reserve's value with a 0.005 floor", () => {
    expect(AGENT_PLANNING_BUDGET_USD).toBe(0.05);
    // 1,375 points = 1,375 x 0.1 EGP / 55 = 2.5 USD; 40% = 1 USD
    expect(executionBudgetUsd(1375)).toBeCloseTo(1, 9);
    expect(executionBudgetUsd(1)).toBe(0.005);
    expect(executionBudgetUsd(0)).toBe(0.005);
  });
});

describe("approve and settle go through the existing money functions only", () => {
  const mission = () => ({ id: "msn_a1", user_id: "00000000-0000-0000-0000-0000000000aa", plan: pricedTwoStagePlan() });

  it("approve: quote -> accept (reserve) -> claim the job; the reserve is the code-computed one", async () => {
    const money = fakeMoneyClient();
    const m = mission();
    const r = await approveMission(money.client, m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const price = repriceStoredPlan(m.plan);
    expect(r.reservePoints).toBe(price.reservePoints);
    expect(money.calls.map((c) => c.name)).toEqual(["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk"]);
    const reserved = money.ledger.find((l) => l.type === "reserve")!;
    expect(reserved.delta).toBe(-price.reservePoints);
    // the job is leased to the agent so the website's old driver never runs a chunk of it
    expect(money.jobs.get(r.jobId)!.lease_until).toBeGreaterThan(Date.now());
    expect(money.quotes.get(r.quoteId)!.items[0]).toMatchObject({ capabilitySlug: "agent-mission", unitPricePoints: price.unitPricePoints });
  });

  it("approve refuses a plan whose stored price no longer matches the code's own computation", async () => {
    const money = fakeMoneyClient();
    const m = mission();
    m.plan.price.reservePoints -= 5;
    expect(await approveMission(money.client, m)).toMatchObject({ ok: false, code: "plan_changed" });
    expect(money.calls).toHaveLength(0);
    expect(money.ledger).toHaveLength(1); // only the opening top-up
  });

  it("approve reports an insufficient balance and holds nothing", async () => {
    const money = fakeMoneyClient({ balance: 5 });
    const r = await approveMission(money.client, mission());
    expect(r).toMatchObject({ ok: false, code: "insufficient_balance" });
    expect(money.ledger.filter((l) => l.type === "reserve")).toHaveLength(0);
  });

  it("settle: charge = ceil(delivered unique final rows x unit price), never above the reserve; the rest is released", async () => {
    const money = fakeMoneyClient();
    const m = mission();
    const a = await approveMission(money.client, m);
    if (!a.ok) throw new Error("approve failed");
    const delivered = 137; // fewer than the 220 planned
    const s = await settleMission(money.client, { jobId: a.jobId, deliveredUnits: delivered, unitPricePoints: a.unitPricePoints, reservedPoints: a.reservePoints, costUsd: 0.3, resultPath: "u/j/result.csv" });
    expect(s.ok).toBe(true);
    if (!s.ok || s.kind !== "settled") throw new Error("expected settled");
    const expected = Math.ceil(Math.round(delivered * a.unitPricePoints * 1e6) / 1e6 - 1e-9);
    expect(s.chargedPoints).toBe(expected);
    expect(s.matchesExpectation).toBe(true);
    expect(s.chargedPoints).toBeLessThanOrEqual(a.reservePoints);
    // the ledger nets to: balance = opening - charge (the hold was released, only the charge remains)
    expect(money.balance()).toBe(100_000 - expected);
    expect(money.calls.map((c) => c.name)).toEqual(["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk", "complete_chunk", "settle_job_atomic"]);
  });

  it("settle with the whole planned volume charges at most the reserve", async () => {
    const money = fakeMoneyClient();
    const a = await approveMission(money.client, mission());
    if (!a.ok) throw new Error("approve failed");
    const s = await settleMission(money.client, { jobId: a.jobId, deliveredUnits: a.deliveredRows, unitPricePoints: a.unitPricePoints, reservedPoints: a.reservePoints, costUsd: 0.4, resultPath: null });
    if (!s.ok || s.kind !== "settled") throw new Error("expected settled");
    expect(s.chargedPoints).toBeLessThanOrEqual(a.reservePoints);
    expect(s.chargedPoints).toBe(chargeForDelivered(a.deliveredRows, a.unitPricePoints));
  });

  it("settle with nothing delivered releases the whole hold and charges nothing", async () => {
    const money = fakeMoneyClient();
    const a = await approveMission(money.client, mission());
    if (!a.ok) throw new Error("approve failed");
    const s = await settleMission(money.client, { jobId: a.jobId, deliveredUnits: 0, unitPricePoints: a.unitPricePoints, reservedPoints: a.reservePoints, costUsd: 0, resultPath: null });
    expect(s).toMatchObject({ ok: true, kind: "released", chargedPoints: 0, releasedPoints: a.reservePoints });
    expect(money.balance()).toBe(100_000);
    // the lease the approval took is cleared first (the real release function refuses while a lease is held), then the hold is released
    expect(money.calls.map((c) => c.name).slice(-2)).toEqual(["complete_chunk", "release_job_atomic"]);
    expect(money.calls.map((c) => c.name)).not.toContain("settle_job_atomic");
  });

  it("no money table is ever written by hand (the fake client throws on any from())", async () => {
    const money = fakeMoneyClient();
    const a = await approveMission(money.client, mission());
    if (!a.ok) throw new Error("approve failed");
    await settleMission(money.client, { jobId: a.jobId, deliveredUnits: 10, unitPricePoints: a.unitPricePoints, reservedPoints: a.reservePoints, costUsd: 0.01, resultPath: null });
    expect(money.calls.every((c) => ["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk", "complete_chunk", "settle_job_atomic", "release_job_atomic"].includes(c.name))).toBe(true);
  });
});

describe("a plan is priced from recorded calls and the model's own numbers are ignored", () => {
  it("ignores any price, cost or unit price the model puts in the plan", () => {
    const plan = pricedTwoStagePlan();
    const calls = new Map([["call_0001", { id: "call_0001", endpointId: "x.x.search-posts-all", ok: true, costUsd: 0.05, rows: 10 }]]);
    const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => "9000", endpointAllowed: () => true };
    const checked = validateAndPricePlan({
      summary_ar: "ملخص", price: 1, unit_price_points: 0.0001, reserve_points: 1,
      stages: [{ key: "posts", title_ar: "المنشورات", endpoint_id: "x.x.search-posts-all", expected_rows: 20, parent_key: null, deliver: true, cost_per_row_usd: 0, price: 0, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ id: "9000", text: "a" }], measured_by: ["call_0001"] }],
    }, lookup);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    // cost per row is the MEASURED 0.05 / 10 rows = 0.005, so the unit price is 27.5 points, whatever the model wrote
    expect(checked.plan.stages[0].measured_cost_per_row_usd).toBeCloseTo(0.005, 10);
    // (the old line said 27.5: provider cost alone) the one rule adds the estimated model cost, one planning and one execution stage, over the 20 delivered rows
    expect(checked.plan.price.unitPricePoints).toBeCloseTo(((20 * 0.005 + AGENT_MODEL_PLANNING_ESTIMATE_USD + AGENT_MODEL_EXECUTION_PER_STAGE_ESTIMATE_USD) / 20) * 5500, 6);
    expect(plan.price.unitPricePoints).toBeGreaterThan(0);
  });

  it("refuses a plan with no measured call, with a call of another endpoint, with a charge of zero or with unknown calls", () => {
    const calls = new Map([
      ["call_0001", { id: "call_0001", endpointId: "x.x.search-posts-all", ok: true, costUsd: 0, rows: 10 }],
      ["call_0002", { id: "call_0002", endpointId: "other.endpoint", ok: true, costUsd: 0.1, rows: 10 }],
    ]);
    const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => "", endpointAllowed: () => true };
    const base = { key: "posts", title_ar: "المنشورات", endpoint_id: "x.x.search-posts-all", expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ text: "a" }] };
    const check = (measured_by: string[]) => validateAndPricePlan({ summary_ar: "ملخص", stages: [{ ...base, measured_by }] }, lookup);
    expect(check([])).toMatchObject({ ok: false });
    expect(check(["call_0002"])).toMatchObject({ ok: false });
    expect(check(["call_0001"])).toMatchObject({ ok: false }); // charged zero: no price can be built on it
    expect(check(["call_9999"])).toMatchObject({ ok: false });
  });

  it("a child stage cannot expect more rows than its parent can give", () => {
    const calls = new Map([
      ["call_0001", { id: "call_0001", endpointId: "p.e", ok: true, costUsd: 0.01, rows: 10 }],
      ["call_0002", { id: "call_0002", endpointId: "c.e", ok: true, costUsd: 0.01, rows: 10 }],
    ]);
    const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => "", endpointAllowed: () => true };
    const col = [{ key: "text", title_ar: "النص" }];
    const r = validateAndPricePlan({ summary_ar: "ملخص", stages: [
      { key: "a", title_ar: "الأول", endpoint_id: "p.e", expected_rows: 5, parent_key: null, deliver: false, columns: col, sample_rows: [{ text: "x" }], measured_by: ["call_0001"] },
      { key: "b", title_ar: "الثاني", endpoint_id: "c.e", expected_rows: 51, parent_key: "a", per_parent_rows: 10, deliver: true, columns: col, sample_rows: [{ text: "x" }], measured_by: ["call_0002"] },
    ] }, lookup);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.issues.join(" ")).toMatch(/more than its parent can give/);
  });

  it("a sample row whose id or link is not in the pages the stage cites is refused (never invent ids or links)", () => {
    const calls = new Map([["call_0001", { id: "call_0001", endpointId: "p.e", ok: true, costUsd: 0.01, rows: 10 }]]);
    const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => '{"id":"111","url":"https://real.example/1"}', endpointAllowed: () => true };
    const mk = (row: Record<string, unknown>) => validateAndPricePlan({ summary_ar: "ملخص", stages: [{ key: "a", title_ar: "الأول", endpoint_id: "p.e", expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [row], measured_by: ["call_0001"] }] }, lookup);
    expect(mk({ id: "111", url: "https://real.example/1", text: "x" }).ok).toBe(true);
    expect(mk({ id: "222", text: "x" }).ok).toBe(false);
    expect(mk({ id: "111", url: "https://made-up.example/9", text: "x" }).ok).toBe(false);
  });

  it("customer text rules: Arabic only, no English, no dollars, no internal ids", () => {
    const calls = new Map([["call_0001", { id: "call_0001", endpointId: "p.e", ok: true, costUsd: 0.01, rows: 10 }]]);
    const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => "", endpointAllowed: () => true };
    const mk = (title: string, summary = "ملخص") => validateAndPricePlan({ summary_ar: summary, stages: [{ key: "a", title_ar: title, endpoint_id: "p.e", expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ text: "x" }], measured_by: ["call_0001"] }] }, lookup);
    expect(mk("Tweets").ok).toBe(false);
    expect(mk("منشورات من x.x.search-posts-all").ok).toBe(false);
    expect(mk("المنشورات", "التكلفة 5 دولار").ok).toBe(false);
    expect(mk("المنشورات").ok).toBe(true);
  });
});
