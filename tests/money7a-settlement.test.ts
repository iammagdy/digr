import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addonChargePoints, approveAddonOnce, settleAddon, type AddonSettleInput } from "../src/lib/agentMission/addonSettlement";
import { addonRowOf, checkAddonLedger, editPricing, fakeAddonWorld, reviewPricing, USER } from "./helpers/addonWorld";

/**
 * MONEY PR 7a, PHASE 2A: THE SETTLEMENT OF AN ADD-ON on the hardened money fake (docs/MONEY-PR-7A.md sections 2, 3 and 4). Each scenario approves an add-on (the hold), settles it through the EXISTING settleMission,
 * and ends with the ledger invariant of section 5: res = -R, rel = +R (one each), at most one chg = -C with 0 < C <= R, and the net equals -C. `fetch` is stubbed to throw.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const B = 100_000;
async function approved(kind: "review" | "review_fix" | "edit", pricing?: ReturnType<typeof editPricing>, balance = B) {
  const row = addonRowOf({ kind, pricing });
  const w = fakeAddonWorld({ balance });
  w.missions.set(row.id, row);
  const out = await approveAddonOnce(w.client, { id: row.id, actorId: USER });
  if (!out.ok) throw new Error(`approval failed: ${JSON.stringify(out)}`);
  return { w, row, jobId: out.jobId, hold: out.holdPoints };
}
const edit = (jobId: string, hold: number, over: Partial<Extract<AddonSettleInput, { realCostUsd: number }>> = {}): AddonSettleInput => ({ kind: "edit", jobId, holdPoints: hold, realCostUsd: 0.02, filled: 40, requested: 40, ...over });
const types = (w: Awaited<ReturnType<typeof approved>>["w"]) => w.ledger.map((r) => r.type);

describe("a paid review (hold = its exact price, charged when the report is stored)", () => {
  it("report stored: res -P, rel +P, chg -P; the balance is B - P after the approval and stays B - P", async () => {
    const { w, jobId, hold } = await approved("review", reviewPricing(50_000));
    expect(hold).toBe(500);
    expect(w.balance()).toBe(B - 500);
    const out = await settleAddon(w.client, { kind: "review", jobId, holdPoints: hold, reportStored: true });
    expect(out.chargePoints).toBe(500);
    expect(out.result).toMatchObject({ ok: true, kind: "settled", chargedPoints: 500, matchesExpectation: true });
    expect(types(w)).toEqual(["topup", "reserve", "release", "charge"]);
    expect(checkAddonLedger(w, jobId, { reserved: 500, charged: 500 })).toEqual([]);
    expect(w.balance()).toBe(B - 500);
    expect(w.jobs.get(jobId)).toMatchObject({ status: "completed", charged_credits: 500, unit_price: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("the report could not be made: only res and rel; the balance is back to B and the job is failed", async () => {
    const { w, jobId, hold } = await approved("review", reviewPricing(50_000));
    const out = await settleAddon(w.client, { kind: "review", jobId, holdPoints: hold, reportStored: false });
    expect(out.chargePoints).toBe(0);
    expect(out.result).toMatchObject({ ok: true, kind: "released", chargedPoints: 0, releasedPoints: 500 });
    expect(types(w)).toEqual(["topup", "reserve", "release"]);
    expect(checkAddonLedger(w, jobId, { reserved: 500, charged: "none" })).toEqual([]);
    expect(w.balance()).toBe(B);
    expect(w.jobs.get(jobId)!.status).toBe("failed");
  });
});

describe("an edit or a review fix (hold = estimate + 15% buffer, charge = real cost x markup, minimum 100)", () => {
  it("full fill: res -R, rel +R, chg -C with C = max(ceil(real x 5,500), 100) and C <= R; the balance is B - R then B - C", async () => {
    const { w, jobId, hold } = await approved("edit", editPricing(40, 0.0005));
    expect(w.balance()).toBe(B - hold);
    const out = await settleAddon(w.client, edit(jobId, hold, { realCostUsd: 0.02 }));
    const expected = Math.min(hold, Math.max(Math.ceil(0.02 * 5500), 100));
    expect(out.chargePoints).toBe(expected);
    expect(expected).toBe(110);
    expect(out.result).toMatchObject({ ok: true, kind: "settled", chargedPoints: expected, matchesExpectation: true });
    expect(checkAddonLedger(w, jobId, { reserved: hold, charged: expected })).toEqual([]);
    expect(w.balance()).toBe(B - expected);
    expect(w.jobs.get(jobId)).toMatchObject({ status: "completed", charged_credits: expected, delivered_units: expected, accumulated_cost_usd: 0.02 });
  });
  it("a review fix settles like an edit", async () => {
    const { w, jobId, hold } = await approved("review_fix", editPricing(30, 0.0004));
    const out = await settleAddon(w.client, { kind: "review_fix", jobId, holdPoints: hold, realCostUsd: 0.012, filled: 30, requested: 30 });
    expect(out.chargePoints).toBe(Math.max(Math.ceil(0.012 * 5500), 100));
    expect(checkAddonLedger(w, jobId, { reserved: hold, charged: out.chargePoints })).toEqual([]);
    expect(w.jobs.get(jobId)!.endpoint_id).toBe("agent-fix");
  });
  it("no provider cost at all (a rename, cells the customer typed): the 100-point minimum, no free path", async () => {
    const { w, jobId, hold } = await approved("edit", editPricing(1, 0));
    const out = await settleAddon(w.client, edit(jobId, hold, { realCostUsd: 0, filled: 1, requested: 1 }));
    expect(out.chargePoints).toBe(100);
    expect(checkAddonLedger(w, jobId, { reserved: hold, charged: 100 })).toEqual([]);
  });
  it("partial fill: the minimum is paid in proportion (ceil(100 x filled / requested)) and the real cost wins when larger", async () => {
    const a = await approved("edit", editPricing(40, 0.0005));
    const partial = await settleAddon(a.w.client, edit(a.jobId, a.hold, { realCostUsd: 0.001, filled: 10, requested: 40 }));
    expect(partial.chargePoints).toBe(25);
    expect(checkAddonLedger(a.w, a.jobId, { reserved: a.hold, charged: 25 })).toEqual([]);
    expect(a.w.balance()).toBe(B - 25);
    const b = await approved("edit", editPricing(40, 0.0005));
    const real = await settleAddon(b.w.client, edit(b.jobId, b.hold, { realCostUsd: 0.015, filled: 10, requested: 40 }));
    expect(real.chargePoints).toBe(83);
    expect(checkAddonLedger(b.w, b.jobId, { reserved: b.hold, charged: 83 })).toEqual([]);
  });
  it("nothing filled: only res and rel, the whole hold comes back, no charge, the job is failed (no new version is the runner's rule)", async () => {
    const { w, jobId, hold } = await approved("edit", editPricing(40, 0.0005));
    const out = await settleAddon(w.client, edit(jobId, hold, { realCostUsd: 0.004, filled: 0, requested: 40 }));
    expect(out.chargePoints).toBe(0);
    expect(out.result).toMatchObject({ ok: true, kind: "released", releasedPoints: hold });
    expect(types(w)).toEqual(["topup", "reserve", "release"]);
    expect(checkAddonLedger(w, jobId, { reserved: hold, charged: "none" })).toEqual([]);
    expect(w.balance()).toBe(B);
    expect(w.jobs.get(jobId)).toMatchObject({ status: "failed", charged_credits: 0 });
  });
  it("a provider that charged DOUBLE (or 1,000 times) its estimate: the charge is the hold, never above it", async () => {
    for (const factor of [2, 10, 1000]) {
      const { w, jobId, hold } = await approved("edit", editPricing(40, 0.0005));
      const out = await settleAddon(w.client, edit(jobId, hold, { realCostUsd: 0.02 * factor }));
      expect(out.chargePoints).toBeLessThanOrEqual(hold);
      expect(checkAddonLedger(w, jobId, { reserved: hold, charged: out.chargePoints })).toEqual([]);
      if (factor >= 10) expect(out.chargePoints).toBe(hold);
    }
  });
  it("a cost under the estimate releases the rest: R - C comes back (the customer keeps the difference)", async () => {
    const { w, jobId, hold } = await approved("edit", editPricing(400, 0.001));
    const out = await settleAddon(w.client, edit(jobId, hold, { realCostUsd: 0.2, filled: 400, requested: 400 }));
    expect(out.chargePoints).toBe(1100);
    expect(out.result).toMatchObject({ ok: true, kind: "settled", releasedPoints: hold - 1100 });
    expect(w.balance()).toBe(B - 1100);
  });
});

describe("settlement is idempotent and survives a throw between the stored work and the charge", () => {
  it("settled twice: one rel, one chg; the second call answers already settled and writes nothing; even with other numbers the first charge stands", async () => {
    const { w, jobId, hold } = await approved("edit", editPricing(40, 0.0005));
    await settleAddon(w.client, edit(jobId, hold));
    const rows = JSON.stringify(w.ledger);
    const again = await settleAddon(w.client, edit(jobId, hold, { realCostUsd: 0.5, filled: 40 }));
    expect(again.result).toMatchObject({ ok: true });
    expect(JSON.stringify(w.ledger)).toBe(rows);
    expect(checkAddonLedger(w, jobId, { reserved: hold, charged: 110 })).toEqual([]);
    const release = await settleAddon(w.client, edit(jobId, hold, { filled: 0 }));
    expect(JSON.stringify(w.ledger)).toBe(rows);
    expect(release.result.ok).toBe(false); // a completed job cannot be released: the call reports the refusal and writes nothing
  });
  it("a release run twice: one rel", async () => {
    const { w, jobId, hold } = await approved("edit", editPricing(40, 0.0005));
    await settleAddon(w.client, edit(jobId, hold, { filled: 0 }));
    const rows = JSON.stringify(w.ledger);
    const again = await settleAddon(w.client, edit(jobId, hold, { filled: 0 }));
    expect(again.result).toMatchObject({ ok: true, kind: "released" });
    expect(JSON.stringify(w.ledger)).toBe(rows);
    expect(checkAddonLedger(w, jobId, { reserved: hold, charged: "none" })).toEqual([]);
  });
  it("a throw BEFORE the charge (after the work was stored): only res_ so far; the retry writes rel_ then chg_ once", async () => {
    const { w, jobId, hold } = await approved("edit", editPricing(40, 0.0005));
    const pending = { stored: true }; // the work is stored pending before the settlement (docs section 3.0, step 2)
    w.inject("settle_job_atomic", "before");
    await expect(settleAddon(w.client, edit(jobId, hold))).rejects.toThrow("before it ran");
    expect(pending.stored).toBe(true);
    expect(types(w)).toEqual(["topup", "reserve"]);
    expect(w.balance()).toBe(B - hold);
    const retry = await settleAddon(w.client, edit(jobId, hold));
    expect(retry.result).toMatchObject({ ok: true, kind: "settled", chargedPoints: 110 });
    expect(checkAddonLedger(w, jobId, { reserved: hold, charged: 110 })).toEqual([]);
  });
  it("a throw AFTER the charge committed (the answer was lost): the retry finds it settled, writes nothing, and reports the one charge", async () => {
    const { w, jobId, hold } = await approved("edit", editPricing(40, 0.0005));
    w.inject("settle_job_atomic", "after");
    await expect(settleAddon(w.client, edit(jobId, hold))).rejects.toThrow("answer of settle_job_atomic was lost");
    expect(types(w)).toEqual(["topup", "reserve", "release", "charge"]);
    const rows = JSON.stringify(w.ledger);
    const retry = await settleAddon(w.client, edit(jobId, hold));
    expect(retry.result).toMatchObject({ ok: true });
    expect(JSON.stringify(w.ledger)).toBe(rows);
    expect(checkAddonLedger(w, jobId, { reserved: hold, charged: 110 })).toEqual([]);
  });
  it("a throw after complete_chunk committed (the job holds its delivered points): the retry still settles once", async () => {
    const { w, jobId, hold } = await approved("edit", editPricing(40, 0.0005));
    w.inject("complete_chunk", "after");
    await expect(settleAddon(w.client, edit(jobId, hold))).rejects.toThrow("complete_chunk was lost");
    expect(types(w)).toEqual(["topup", "reserve"]);
    const retry = await settleAddon(w.client, edit(jobId, hold));
    expect(retry.result).toMatchObject({ ok: true, kind: "settled", chargedPoints: 110 });
    expect(checkAddonLedger(w, jobId, { reserved: hold, charged: 110 })).toEqual([]);
  });
  it("a throw while releasing (nothing filled), then the retry: one rel", async () => {
    const { w, jobId, hold } = await approved("edit", editPricing(40, 0.0005));
    w.inject("release_job_atomic", "after");
    await expect(settleAddon(w.client, edit(jobId, hold, { filled: 0 }))).rejects.toThrow("release_job_atomic was lost");
    const retry = await settleAddon(w.client, edit(jobId, hold, { filled: 0 }));
    expect(retry.result).toMatchObject({ ok: true, kind: "released" });
    expect(checkAddonLedger(w, jobId, { reserved: hold, charged: "none" })).toEqual([]);
  });
  it("the watchdog released the stale job first: the late settlement writes no charge (res and rel only, net 0)", async () => {
    const { w, jobId, hold } = await approved("edit", editPricing(40, 0.0005));
    // the watchdog's call (src/app/api/cron/watchdog/route.ts): release_job_atomic with p_force
    await w.client.rpc("release_job_atomic", { p_job_id: jobId, p_error_message: "x", p_force: true });
    const out = await settleAddon(w.client, edit(jobId, hold));
    expect(out.result.ok).toBe(false);
    expect(types(w)).toEqual(["topup", "reserve", "release"]);
    expect(checkAddonLedger(w, jobId, { reserved: hold, charged: "none" })).toEqual([]);
    expect(w.balance()).toBe(B);
  });
  it("refuses a hold that is not a whole number of 1 or more, and a charge input that is not a number (nothing is called)", async () => {
    const { w, jobId } = await approved("edit", editPricing(40, 0.0005));
    const before = w.calls.length;
    await expect(settleAddon(w.client, edit(jobId, 0))).rejects.toThrow();
    await expect(settleAddon(w.client, edit(jobId, 200, { realCostUsd: Number.NaN }))).rejects.toThrow();
    await expect(settleAddon(w.client, edit(jobId, 200, { requested: 0 }))).rejects.toThrow();
    expect(w.calls.length).toBe(before);
  });
});

describe("the invariant holds over many random scenarios", () => {
  it("300 random add-ons (kind, size, cost, fill, retries, lost answers): the ledger of each ends balanced, never above the hold", async () => {
    let seed = 99;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 300; i++) {
      const kind = (["review", "edit", "review_fix"] as const)[Math.floor(rnd() * 3)];
      const pricing = kind === "review" ? reviewPricing(Math.floor(rnd() * 200_000)) : editPricing(1 + Math.floor(rnd() * 300), Math.round(rnd() * 2000) / 1_000_000);
      if (pricing.holdPoints > 5000) continue;
      const { w, jobId, hold } = await approved(kind, pricing);
      const requested = pricing.requested;
      const filled = rnd() < 0.2 ? 0 : Math.floor(rnd() * (requested + 1));
      const realCostUsd = rnd() < 0.2 ? 0 : Math.round(rnd() * 2_000_000) / 1_000_000;
      const input: AddonSettleInput = kind === "review" ? { kind, jobId, holdPoints: hold, reportStored: rnd() < 0.8 } : { kind, jobId, holdPoints: hold, realCostUsd, filled, requested };
      const lost = rnd();
      if (lost < 0.2) w.inject("settle_job_atomic", "before");
      else if (lost < 0.4) w.inject("settle_job_atomic", "after");
      else if (lost < 0.5) w.inject("complete_chunk", "after");
      try { await settleAddon(w.client, input); } catch { /* the runner retries */ }
      await settleAddon(w.client, input);
      await settleAddon(w.client, input);
      const charge = input.kind === "review" ? (input.reportStored ? hold : 0) : addonChargePoints({ realCostUsd, filled, requested, holdPoints: hold });
      expect(checkAddonLedger(w, jobId, { reserved: hold, charged: charge === 0 ? "none" : charge })).toEqual([]);
      expect(charge).toBeLessThanOrEqual(hold);
    }
  });
});
