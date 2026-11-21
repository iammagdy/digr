import { effectiveJobPointsCap } from "../src/lib/jobPointsCap";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { affordableVersionOf } from "../src/lib/agentMission/overLimit";
import { planCompaniesByCodeIfOn } from "../src/lib/agentMission/stage3/b2bPlanning";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { NOT_ADMIN } from "./helpers/agentHarness";
import { LIVE_7539 } from "./helpers/stage3World";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveForCustomer, loadCustomerMission, smallerVersionForCustomer } from "../src/lib/agentMission/customerActions";
import { customerPlanView, stagePriceInputs, validateAndPricePlan, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import { fakeMoneyClient, withAtomicMissionApproval } from "./helpers/agentMoney";
import { createMemoryDb } from "./helpers/memoryDb";

const owner = "overcap-owner";
const id = "msn_overcapfixture";
const timestamp = "2026-11-21T06:00:00.000Z";

function companyPlan() {
  const endpointId = "treg.aiark.company.search";
  const checked = validateAndPricePlan({
    summary_ar: "ستحصل على شركات المقاولات.",
    stages: [{
      key: "companies", title_ar: "الشركات", endpoint_id: endpointId, expected_rows: 20,
      parent_key: null, deliver: true,
      columns: [{ key: "name", title_ar: "الاسم" }, { key: "created_at", title_ar: "التاريخ" }],
      sample_rows: [{ name: "شركة مثال", created_at: timestamp }], measured_by: ["call_0001"],
      filters: [{ kind: "period", days: 30 }],
    }],
  }, {
    call: () => ({ id: "call_0001", endpointId, ok: true, costUsd: 0.05, rows: 10 }),
    evidenceText: () => `شركة مثال ${timestamp}`,
    endpointAllowed: () => true,
    holdCapPoints: effectiveJobPointsCap(),
  });
  return checked;
}

function world(balance: number, brokenWallet = false, seedPlan?: PricedPlan) {
  const checked = companyPlan();
  if (!checked.ok && !seedPlan) throw new Error(checked.issues.join("; "));
  const plan = seedPlan ?? (checked.ok ? checked.plan : checked.overCapPlan!);
  const db = createMemoryDb({ missing: brokenWallet ? ["credit_ledger"] : [] });
  db.seed("missions", [{
    id, user_id: owner, status: "plan_ready", request_text: "هات ٢٠ شركة مقاولات",
    plan, plan_public: customerPlanView(plan), created_at: timestamp, updated_at: timestamp,
    reserved_points: plan.price.reservePoints, unit_price_points: plan.price.unitPricePoints,
  }]);
  db.seed("credit_ledger", [{ id: "topup_fixture", user_id: owner, delta: balance }]);
  const money = fakeMoneyClient({ balance });
  const client = { ...db, rpc: withAtomicMissionApproval(db, money).rpc };
  const read = async () => {
    const result = await loadCustomerMission(client, { id, userId: owner });
    if (!result.ok) throw new Error(result.error);
    return result.view;
  };
  const approve = (approvalVersion: unknown) => approveForCustomer(client, {
    id, userId: owner, isGuest: false, emailVerified: true, approvalVersion,
  });
  const holds = () => money.ledger.filter((entry) => entry.type === "reserve").map((entry) => -entry.delta);
  return { read, approve, holds, money, db, client };
}

describe("the owned plan's affordability and approval", () => {
  beforeEach(() => vi.stubEnv("JOB_MAX_POINTS_CAP", ""));
  afterEach(() => vi.unstubAllEnvs());

  it.each([715, 3000])("shows the original 715-point plan with a %i-point wallet", async (balance) => {
    const fixture = world(balance);
    expect(await fixture.read()).toMatchObject({
      affordability: { mode: "ready", availablePoints: balance, reservePoints: 715 },
    });
  });

  it.each([
    { balance: 199, brokenWallet: false, mode: "top_up", availablePoints: 199 },
    { balance: 3000, brokenWallet: true, mode: "unavailable", availablePoints: null },
  ])("shows $mode without offering another count", async ({ balance, brokenWallet, mode, availablePoints }) => {
    const card = await world(balance, brokenWallet).read();
    expect(card).toHaveProperty("affordability", expect.objectContaining({ mode, availablePoints }));
    expect(card).not.toHaveProperty("affordability.offer");
  });

  it("one approval of an unchanged plan holds 715 once", async () => {
    const fixture = world(3000);
    const card = await fixture.read();
    expect(await fixture.approve(card.approvalVersion)).toMatchObject({ ok: true, reservePoints: 715 });
    expect(fixture.holds()).toEqual([715]);
  });
});

describe("a cap-limited proposal is a priced preview", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([714, 715])("preserves the full 715-point price with cap %i", (cap) => {
    vi.stubEnv("JOB_MAX_POINTS_CAP", String(cap));
    const checked = companyPlan();
    if (cap === 714) {
      expect(checked).toMatchObject({ ok: false, overCapPlan: { hold_cap_preview: true, price: { reservePoints: 715 } } });
    } else {
      expect(checked).toMatchObject({ ok: true, plan: { price: { reservePoints: 715 } } });
      expect(checked).not.toHaveProperty("plan.hold_cap_preview");
    }
  });
});

function pricedBasket(count: number): PricedPlan {
  const checked = companyPlan();
  if (!checked.ok) throw new Error(checked.issues.join("; "));
  const root = { ...checked.plan.stages[0], planned_rows: count, expected_rows: count, measured_cost_per_row_usd: 0.018 };
  const people: PricedStage = { ...root,
    key: "people", title_ar: "المسؤولون", parent_key: root.key, per_parent_rows: 1,
    role_preference: { role: "manager" }, measured_cost_per_row_usd: 0.01643,
  };
  const stages = [root, people];
  const contact_steps: NonNullable<PricedPlan["contact_steps"]> = [
    { stage_key: people.key, kind: "email", column_key: "email", status_key: "email_status", per_person_usd: 0.004, finders: [] },
    { stage_key: people.key, kind: "phone", column_key: "phone", status_key: "phone_status", per_person_usd: 0.006, finders: [] },
  ];
  return {
    ...checked.plan, stages, contact_steps,
    quantity: { source: "request", target: count, requested: count, stage_key: root.key },
    price: priceMissionByCode(stagePriceInputs(stages, contact_steps)),
  };
}

describe("the 2,668-point wallet and the 2,980-point original request", () => {
  beforeEach(() => vi.stubEnv("JOB_MAX_POINTS_CAP", ""));
  afterEach(() => vi.unstubAllEnvs());

  it("offers only eight, refuses a forged offer and holds the prepared price only on a fresh click", async () => {
    const original = pricedBasket(10);
    expect(original.price).toMatchObject({ maxChargePoints: 2591, reservePoints: 2980 });
    expect(original.price.modelCostUsd).toBeCloseTo(0.026);
    expect(pricedBasket(9).price.reservePoints).toBe(2698);
    const fixture = world(2668, false, original);
    const preview = await fixture.read();
    expect(preview.affordability).toMatchObject({
      mode: "offer", limitedBy: "wallet", offer: { kind: "count", count: 8, reservePoints: 2417 },
    });
    const markup = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: preview, isGuest: false, authoritative: true }));
    expect(markup).toContain('data-testid="agent-smaller"');
    expect(markup).toContain("/dashboard/topup");
    expect(markup).not.toContain('data-testid="agent-approve"');
    expect(preview).not.toHaveProperty("plan");
    const offer = preview.affordability?.offer;
    if (!offer) throw new Error("expected a smaller offer");
    const selection = { id, userId: owner, approvalVersion: preview.approvalVersion, offer };
    expect(await smallerVersionForCustomer(fixture.client, { ...selection, offer: { ...offer, count: 9 } }))
      .toMatchObject({ ok: false, status: 409, code: "affordability_changed" });
    expect(fixture.db.rows("missions")[0].plan).toEqual(original);
    expect(await smallerVersionForCustomer(fixture.client, selection)).toMatchObject({ ok: true });
    const saved = fixture.db.rows("missions")[0].plan as PricedPlan;
    expect(saved.stages.map((stage) => stage.planned_rows)).toEqual([8, 8]);
    expect(saved.contact_steps).toEqual(original.contact_steps);
    expect(fixture.holds()).toEqual([]);
    expect(fixture.money.quotes.size).toBe(0);
    expect(fixture.money.jobs.size).toBe(0);
    expect(await fixture.approve(preview.approvalVersion)).toMatchObject({ ok: false, status: 409, code: "stale_plan" });
    const ready = await fixture.read();
    expect(ready.affordability).toMatchObject({ mode: "ready", reservePoints: 2417 });
    expect(await fixture.approve(ready.approvalVersion)).toMatchObject({ ok: true, reservePoints: 2417 });
    expect(fixture.holds()).toEqual([2417]);
  });

  it("offers the same 8+8 basket when the cap is stricter than the wallet", () => {
    expect(affordableVersionOf(pricedBasket(10), 2668)).toMatchObject({ count: 8, plan: { price: { reservePoints: 2417 } } });
  });
});

describe("approval crosses the same owner, wallet and cap boundaries", () => {
  beforeEach(() => vi.stubEnv("JOB_MAX_POINTS_CAP", ""));
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a wallet whose ledger changes between pages", async () => {
    const fixture = world(3000);
    fixture.db.tables.set("credit_ledger", Array.from({ length: 1001 }, (_, index) => ({
      id: index + 1, user_id: owner, delta: index === 0 ? 3000 : 0,
    })));
    fixture.client.from = (table) => {
      const builder = fixture.db.from(table);
      if (table !== "credit_ledger") return builder;
      const originalRange = builder.range;
      const count = fixture.db.rows(table).length;
      builder.range = (start: number, end: number) => {
        if (start === 1000 && count === 1001) fixture.db.rows(table).push({ id: 1002, user_id: owner, delta: -800 });
        return originalRange(start, end);
      };
      return builder;
    };
    expect((await fixture.read()).affordability).toMatchObject({ mode: "unavailable", availablePoints: null });
    expect(fixture.holds()).toEqual([]);
  });

  it("the atomic balance check catches a debit after the card read", async () => {
    const fixture = world(715);
    const card = await fixture.read();
    fixture.money.ledger.push({ id: "other_hold_fixture", delta: -50, type: "reserve" });
    const response = await fixture.approve(card.approvalVersion);
    expect(response).toMatchObject({ ok: false, status: 402, code: "affordability_changed" });
    expect(fixture.money.quotes.size).toBe(0);
    expect(fixture.money.jobs.size).toBe(0);
    expect(fixture.holds()).toEqual([50]);
  });

  it("the Stage 3 flag-on dispatcher locks the same verified basket under a smaller cap", () => {
    const input = { requestText: LIVE_7539, isTestAccount: false, catalog: loadTregCatalog(),
      access: NOT_ADMIN, stats: new Map(), now: Date.parse(timestamp) };
    const off = planCompaniesByCodeIfOn({ ...input, env: { DIGER_STAGE3_COMPANIES: "" } });
    expect(off).toBeNull();
    const initial = planCompaniesByCodeIfOn({ ...input, env: { DIGER_STAGE3_COMPANIES: "on" } });
    if (!initial?.ok) throw new Error("expected a valid code-built plan");
    const originalReserve = initial.plan.price.reservePoints;
    const locked = planCompaniesByCodeIfOn({ ...input, env: { DIGER_STAGE3_COMPANIES: "on", JOB_MAX_POINTS_CAP: String(originalReserve - 1) } });
    expect(locked).toMatchObject({ ok: true, plan: { hold_cap_preview: true, price: { reservePoints: originalReserve } } });
    expect(locked?.ok ? locked.plan.stages : null).toEqual(initial.plan.stages);
  });
});
