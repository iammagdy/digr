import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "../agent/src/memoryStore";
import { sealFinalPrice } from "../src/lib/agentMission/finalPrice";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs, type PricedPlan } from "../src/lib/agentMission/plan";
import { repriceStoredPlan } from "../src/lib/agentMission/lifecycle";
import { replay } from "./helpers/agentReplay";
import { pages, planning } from "./helpers/engineXScenario";

/**
 * S1 LIVE FINDINGS fix 3 (docs/S1-LIVE-FINDINGS.md section 4): the plan card must never show a price or a count that later changes by itself. The card is stored once, with the FINAL price: the one pricing function over the final stages (admin minimum included),
 * the same number approval recomputes and reserves. A stored price that disagrees with that number is replaced by it before the card exists, and the difference is recorded as an internal event (counts only).
 */
afterEach(() => { vi.unstubAllGlobals(); });

const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 1, planned_rows: 1, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0005, ...over }) as unknown as PricedPlan["stages"][number];
function planWithPrice(rows: number, staleRows: number): PricedPlan {
  const stages = [stage({ key: "posts", title_ar: "المنشورات", planned_rows: 2, expected_rows: 2 }), stage({ key: "comments", title_ar: "التعليقات", parent_key: "posts", planned_rows: rows - 2, expected_rows: rows - 2 })];
  const final = priceMissionByCode(stagePriceInputs(stages, undefined), {});
  const stale = priceMissionByCode(stagePriceInputs(stages.map((s) => ({ ...s, planned_rows: staleRows / 2, expected_rows: staleRows / 2 })), undefined), { settings: { markup: 10, minChargePoints: 50 } });
  return { summary_ar: "x", stages, price: staleRows === rows ? final : stale } as unknown as PricedPlan;
}

describe("the final price is the one pricing function over the final stages", () => {
  it("a stale price (66 items, minimum 50) is replaced by the final one (12 items, the admin minimum 200) and the drift is reported", () => {
    const plan = planWithPrice(12, 66);
    expect(plan.price.deliveredRows).toBe(66);
    const sealed = sealFinalPrice(plan);
    expect(sealed.plan.price.deliveredRows).toBe(12);
    expect(sealed.plan.price.minChargePoints).toBe(200);
    expect(sealed.plan.price.reservePoints).toBeGreaterThanOrEqual(200);
    expect(sealed.drift).toEqual({ rowsBefore: 66, rowsAfter: 12, reserveBefore: plan.price.reservePoints, reserveAfter: sealed.plan.price.reservePoints });
  });
  it("what the card stores is what approval recomputes (no `plan_changed` is possible)", () => {
    const sealed = sealFinalPrice(planWithPrice(12, 66)).plan;
    const again = repriceStoredPlan(sealed);
    expect(sealed.price.unitPricePoints).toBe(again.unitPricePoints);
    expect(sealed.price.reservePoints).toBe(again.reservePoints);
    expect(sealed.price.deliveredRows).toBe(again.deliveredRows);
  });
  it("a plan whose price is already final is returned untouched, with no drift", () => {
    const plan = planWithPrice(12, 12);
    const sealed = sealFinalPrice(plan);
    expect(sealed.drift).toBeNull();
    expect(sealed.plan.price).toEqual(plan.price);
  });
  it("a plan stored before the one pricing rule keeps the price it showed (the same rule approval uses)", () => {
    const old = { ...planWithPrice(12, 12), price: { ...planWithPrice(12, 12).price, rule: undefined } } as unknown as PricedPlan;
    expect(sealFinalPrice(old).plan.price).toBe(old.price);
  });
});

describe("the card of a mission in the redesigned mode does not change by itself between the plan and the approval", () => {
  const flags = (d: Parameters<NonNullable<Parameters<typeof replay>[0]["deps"]>>[0]) => { (d.store as MemoryStore).settings.redesign_flags = { social_posts: "on" }; return d; };
  it("two reads of the plan card, the stored price and the held reserve are the same numbers, and no sealing drift was needed", async () => {
    let second: unknown = null;
    const r = await replay({
      request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30)], deps: flags,
      beforeApproval: async ({ client, missionId }) => { const { loadCustomerMission } = await import("../src/lib/agentMission/customerActions"); second = await loadCustomerMission(client, { id: missionId, userId: (await import("./helpers/agentReplay")).REPLAY_USER }); },
    });
    const view2 = (second as { view: typeof r.planView }).view;
    expect(view2.priceLineAr).toBe(r.planView.priceLineAr);
    expect(view2.totalRowsAr).toBe(r.planView.totalRowsAr);
    const stored = r.mission.plan as unknown as PricedPlan;
    expect(Number(r.mission.reserved_points)).toBe(stored.price.reservePoints);
    expect(stored.price.reservePoints).toBe(repriceStoredPlan(stored).reservePoints);
    expect((r.store.events as Array<{ counts?: Record<string, unknown> }>).some((e) => e.counts && "price_sealed" in e.counts)).toBe(false);
  });
});
