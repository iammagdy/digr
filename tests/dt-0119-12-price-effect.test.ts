import { describe, expect, it } from "vitest";
import { approveMission, settleMission } from "../src/lib/agentMission/lifecycle";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { expectedCost } from "../src/lib/agentMission/sourceRanking";
import { loadTregCatalog, loadTregPriceBaseline, PINNED_PRICE_IDS } from "../src/lib/treg/catalog";
import { applyPriceSync, priceSyncTuple } from "../src/lib/treg/priceSyncFile";
import { makeHarness, POSTS_ENDPOINT, postsPage, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";

const changed = "blitzapi.companies.search";
const unchanged = "tomba.companies.search.reveal";

function plan(endpointId: string, usd: number, revision: number): PricedPlan {
  const stages = [{ key: "companies", endpoint_id: endpointId, parent_key: null, planned_rows: 50, measured_cost_per_row_usd: usd, deliver: true, columns: [] }] as PricedStage[];
  const price = priceMissionByCode([{ rows: 50, costPerRowUsd: usd, deliver: true }]);
  return { summary_ar: "شركات", stages, price: { ...price, pricedUnder: revision } };
}
const mission = (stored: PricedPlan) => ({ plan: stored, id: "msn_test", user_id: "user_test" });

describe("approval across a catalog sync", () => {
  it("refuses the old card before reserving and approves a regenerated card at the new catalog price", async () => {
    const { client, calls, ledger } = fakeMoneyClient();
    const old = plan(changed, 0.000495, 1);
    expect(await approveMission(client, mission(old))).toMatchObject({ ok: false, code: "plan_changed" });
    expect(calls).toEqual([]);
    expect(ledger.map((row) => row.type)).toEqual(["topup"]);
    const catalog = loadTregCatalog();
    const usd = expectedCost(catalog.byId.get(changed)!, catalog, undefined).usdPerItem!;
    const current = plan(changed, usd, 2);
    expect([old.price.maxChargePoints, old.price.reservePoints]).toEqual([208, 239]);
    expect([current.price.maxChargePoints, current.price.reservePoints]).toEqual([347, 399]);
    expect(await approveMission(client, mission(current))).toMatchObject({ ok: true, reservePoints: 399 });
  });

  it("still approves a revision-1 card that only uses an unchanged source", async () => {
    const { client } = fakeMoneyClient();
    const old = plan(unchanged, 0.000178, 1);
    expect(await approveMission(client, mission(old))).toMatchObject({ ok: true, reservePoints: old.price.reservePoints });
  });

  it.each([0, 30])("settles %i delivered items at the sealed rate after a real gateway refuses a withdrawn source", async (rows) => {
    const { client, jobs } = fakeMoneyClient();
    const old = plan(changed, 0.000495, 1);
    // Seed the old accepted quote through the money boundary, independently of the current approval guard.
    const quote = {
      p_quote_id: "quote_old", p_user_id: "user_test", p_quote_hash: "a".repeat(64),
      p_items: [{ unitPricePoints: old.price.unitPricePoints, targetVolumeMax: 50 }],
      p_total_points: old.price.reservePoints, p_output_formats: ["xlsx"], p_expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    await client.rpc("create_quote_atomic", quote);
    const accepted = await client.rpc("accept_quote_atomic", {
      p_quote_id: quote.p_quote_id, p_user_id: quote.p_user_id, p_expected_quote_hash: quote.p_quote_hash,
    });
    expect(accepted.data).toMatchObject({ success: true });
    const job = jobs.get(accepted.data.job_id)!;
    await client.rpc("claim_job_chunk", { p_job_id: job.id, p_expected_step: 0, p_lease_seconds: 30 });
    const catalog = loadTregPriceBaseline();
    applyPriceSync(catalog, { revision: 3, entries: [{
      id: changed, was: priceSyncTuple(catalog.byId.get(changed)!.cost),
      withdrawn: true, since: "2026-11-20",
    }] }, PINNED_PRICE_IDS);
    const w = makeHarness({ catalog, phase: "execution", budgetUsd: 0.15, responses: [tregResult(postsPage(rows), 0.03)] });
    expect(await w.gateway.tregCall({ endpoint_id: changed, params: { max_results: 50 } })).toMatchObject({ ok: false, refused: "not_sellable" });
    expect(w.call).not.toHaveBeenCalled();
    expect(w.budget.spentUsd()).toBe(0);
    let deliveredUnits = 0;
    if (rows) {
      const fallback = await w.gateway.tregCall({ endpoint_id: POSTS_ENDPOINT, params: { query: "example" } });
      if (!fallback.ok) throw new Error(JSON.stringify(fallback));
      deliveredUnits = fallback.rows_in_page;
      expect(deliveredUnits).toBe(rows);
    }
    const charge = Math.ceil(deliveredUnits * old.price.unitPricePoints);
    expect(await settleMission(client, {
      jobId: job.id, deliveredUnits, unitPricePoints: job.unit_price, reservedPoints: job.reserved_credits,
      costUsd: w.budget.spentUsd(), resultPath: rows ? "output.xlsx" : null,
    })).toMatchObject({
      ok: true, kind: rows ? "settled" : "released", chargedPoints: charge, releasedPoints: old.price.reservePoints - charge,
    });
  });
});
