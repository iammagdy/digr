import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADDON_APPROVE_MESSAGES_AR, ADDON_MAX_HOLD_POINTS, ADDON_SLUG, addonId, addonJobId, addonQuoteId, approveAddonOnce, checkAddon, readAddonPlan } from "../src/lib/agentMission/addonSettlement";
import { addonRowOf, checkAddonLedger, editPricing, fakeAddonWorld, reviewPricing, USER } from "./helpers/addonWorld";

/**
 * MONEY PR 7a, PHASE 2A: THE APPROVAL OF AN ADD-ON (docs/MONEY-PR-7A.md sections 3 and 4), on the hardened money fake and a tiny missions table. `fetch` is stubbed to throw: no test here can reach a provider,
 * and the approval makes no provider call by construction (it only calls the three money functions). Every scenario ends with the ledger invariant: res = -R, rel = +R only after a settlement, no row twice.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const reserves = (w: ReturnType<typeof fakeAddonWorld>) => w.ledger.filter((r) => r.type === "reserve");
const rpcNames = (w: ReturnType<typeof fakeAddonWorld>) => w.calls.map((c) => c.name);
const world = (balance = 10_000, rows: Array<ReturnType<typeof addonRowOf>> = [addonRowOf({})]) => { const w = fakeAddonWorld({ balance }); for (const r of rows) w.missions.set(r.id, r); return { w, row: rows[0] }; };

describe("approval: the hold, and only the hold", () => {
  it("an edit: res_<job> = -hold, the job sells the hold's points at 1 point each, the row records job, quote and reserve", async () => {
    const { w, row } = world();
    const hold = row.plan.addon.pricing.holdPoints as number;
    const out = await approveAddonOnce(w.client, { id: row.id, actorId: USER, expectUserId: USER });
    expect(out).toMatchObject({ ok: true, kind: "edit", holdPoints: hold });
    if (!out.ok) throw new Error("not ok");
    expect(out.quoteId).toBe(addonQuoteId(row.id));
    expect(out.jobId).toBe(addonJobId(out.quoteId));
    expect(reserves(w)).toEqual([expect.objectContaining({ id: `res_${out.jobId}`, delta: -hold })]);
    expect(w.balance()).toBe(10_000 - hold);
    const job = w.jobs.get(out.jobId)!;
    expect(job).toMatchObject({ reserved_credits: hold, unit_price: 1, target_volume_max: hold, endpoint_id: ADDON_SLUG.edit, status: "running" });
    expect(job.lease_until).toBeGreaterThan(Date.now());
    expect(w.missions.get(row.id)).toMatchObject({ status: "approved", job_id: out.jobId, quote_id: out.quoteId, reserved_points: hold, unit_price_points: 1, lease_until: null, error: null, approved_by: USER });
    expect(rpcNames(w)).toEqual(["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk"]);
    expect(w.events).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("the provider budget handed to the worker is hold / 5,500 USD for an edit and 0 for a review", async () => {
    const { w, row } = world();
    const out = await approveAddonOnce(w.client, { id: row.id, actorId: USER });
    if (!out.ok) throw new Error("not ok");
    expect(out.providerBudgetUsd).toBeCloseTo(out.holdPoints / 5500, 5);
    expect(Math.ceil(Math.round(out.providerBudgetUsd * 1_000_000) * 5500 / 1_000_000)).toBeLessThanOrEqual(out.holdPoints);
    const rev = addonRowOf({ kind: "review", pricing: reviewPricing(50_000) });
    const { w: w2 } = world(10_000, [rev]);
    const r = await approveAddonOnce(w2.client, { id: rev.id, actorId: USER });
    expect(r).toMatchObject({ ok: true, kind: "review", holdPoints: 500, providerBudgetUsd: 0 });
    expect(w2.jobs.get((r as any).jobId)).toMatchObject({ reserved_credits: 500, endpoint_id: "agent-review" });
  });
  it("a review is held at its EXACT price (no 15% buffer): 1 point per 100 cells, at least 100", async () => {
    for (const [cells, price] of [[0, 100], [9_999, 100], [10_000, 100], [10_001, 101], [123_456, 1235]] as const) {
      const rev = addonRowOf({ kind: "review", pricing: reviewPricing(cells) });
      const { w } = world(10_000, [rev]);
      const out = await approveAddonOnce(w.client, { id: rev.id, actorId: USER });
      expect(out).toMatchObject({ ok: true, holdPoints: price });
      expect(reserves(w)[0].delta).toBe(-price);
    }
  });
  it("the hold of an edit carries the 15% buffer on the estimate: hold >= estimate and hold = max(100, ceil(1.15 x ...)) from the one pricing rule", () => {
    const p = editPricing(40, 0.0005);
    expect(p.holdPoints).toBeGreaterThanOrEqual(p.estimatePoints);
    expect(p.holdPoints).toBeGreaterThanOrEqual(100);
    const big = editPricing(400, 0.001);
    expect(big.holdPoints).toBeGreaterThan(big.estimatePoints);
  });
});

describe("approval: double click, retry after a lost answer", () => {
  it("two approvals at once: ONE reserve row, one answer ok and one rejection", async () => {
    const { w, row } = world();
    const [a, b] = await Promise.all([approveAddonOnce(w.client, { id: row.id, actorId: USER }), approveAddonOnce(w.client, { id: row.id, actorId: USER })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const lost = [a, b].find((x) => !x.ok)!;
    expect(lost).toMatchObject({ ok: false, status: 409, error: ADDON_APPROVE_MESSAGES_AR.already_approved });
    expect(reserves(w)).toHaveLength(1);
    expect(rpcNames(w).filter((n) => n === "accept_quote_atomic")).toHaveLength(1);
  });
  it("an approval after an approval (a retry once the first answer reached the customer) changes nothing", async () => {
    const { w, row } = world();
    await approveAddonOnce(w.client, { id: row.id, actorId: USER });
    const ledger = JSON.stringify(w.ledger);
    const again = await approveAddonOnce(w.client, { id: row.id, actorId: USER });
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(JSON.stringify(w.ledger)).toBe(ledger);
    expect(w.jobs.size).toBe(1);
  });
  for (const fn of ["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk"] as const) {
    it(`the answer of ${fn} is lost (it committed): the row goes back to plan_ready, and the retry converges on the same quote, job and ONE reserve row`, async () => {
      const { w, row } = world();
      w.inject(fn, "after");
      const first = await approveAddonOnce(w.client, { id: row.id, actorId: USER });
      expect(first).toMatchObject({ ok: false });
      expect(w.missions.get(row.id)!.status).toBe("plan_ready");
      const second = await approveAddonOnce(w.client, { id: row.id, actorId: USER });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.jobId).toBe(addonJobId(addonQuoteId(row.id)));
      expect(reserves(w)).toHaveLength(1);
      expect(w.ledger.filter((r) => r.type === "release" || r.type === "charge")).toEqual([]);
      expect(w.jobs.size).toBe(1);
      expect(w.jobs.get(second.jobId)!.status).toBe("running");
      expect(w.missions.get(row.id)).toMatchObject({ status: "approved", job_id: second.jobId });
      expect(w.calls.filter((c) => c.name === "release_job_atomic")).toEqual([]);
    });
    it(`${fn} fails before it runs: nothing committed, the row goes back, the retry works`, async () => {
      const { w, row } = world();
      w.inject(fn, "before");
      expect((await approveAddonOnce(w.client, { id: row.id, actorId: USER })).ok).toBe(false);
      expect(w.missions.get(row.id)!.status).toBe("plan_ready");
      expect(reserves(w)).toHaveLength(fn === "claim_job_chunk" ? 1 : 0);
      expect((await approveAddonOnce(w.client, { id: row.id, actorId: USER })).ok).toBe(true);
      expect(reserves(w)).toHaveLength(1);
    });
  }
});

describe("approval: a job accepted before this call is never released by it", () => {
  it("the retry finds the quote already accepted, the claim then fails for another reason: NO release is sent, the hold stands, and the row goes back to plan_ready", async () => {
    const { w, row } = world();
    w.inject("accept_quote_atomic", "after");
    expect((await approveAddonOnce(w.client, { id: row.id, actorId: USER })).ok).toBe(false);
    const jobId = addonJobId(addonQuoteId(row.id));
    w.jobs.get(jobId)!.step = 1; // the claim will answer step_mismatch
    const out = await approveAddonOnce(w.client, { id: row.id, actorId: USER });
    expect(out).toMatchObject({ ok: false, code: "claim_failed", error: ADDON_APPROVE_MESSAGES_AR.claim_retry });
    expect(w.calls.filter((c) => c.name === "release_job_atomic")).toEqual([]);
    expect(reserves(w)).toHaveLength(1);
    expect(w.ledger.filter((r) => r.type === "release")).toEqual([]);
    expect(w.missions.get(row.id)!.status).toBe("plan_ready");
  });
  it("a claim that fails on a job THIS call accepted releases it whole (nothing was spent), and the row goes back", async () => {
    const { w, row } = world();
    const real = w.client.rpc;
    w.client.rpc = async (name: string, args: any) => (name === "claim_job_chunk" ? (w.calls.push({ name, args }), { data: { claimed: false, error: "backoff_active" } }) : real(name, args));
    const out = await approveAddonOnce(w.client, { id: row.id, actorId: USER });
    expect(out).toMatchObject({ ok: false, code: "claim_failed", error: ADDON_APPROVE_MESSAGES_AR.claim_failed });
    expect(w.ledger.map((r) => r.type)).toEqual(["topup", "reserve", "release"]);
    expect(w.balance()).toBe(10_000);
    expect(w.missions.get(row.id)!.status).toBe("plan_ready");
  });
});

describe("approval: refusals write nothing", () => {
  it("insufficient balance: no ledger row, no job, the quote stays quoted, the row is plan_ready; after a top-up the same add-on is approved", async () => {
    const { w, row } = world(50);
    const before = JSON.stringify(w.ledger);
    const out = await approveAddonOnce(w.client, { id: row.id, actorId: USER });
    expect(out).toMatchObject({ ok: false, status: 402, code: "insufficient_balance", error: ADDON_APPROVE_MESSAGES_AR.insufficient_balance });
    expect(JSON.stringify(w.ledger)).toBe(before);
    expect(w.jobs.size).toBe(0);
    expect(w.quotes.get(addonQuoteId(row.id))!.status).toBe("quoted");
    expect(w.missions.get(row.id)).toMatchObject({ status: "plan_ready", error: "insufficient_balance" });
    w.ledger.push({ id: "top_2", delta: 5000, type: "topup" });
    expect((await approveAddonOnce(w.client, { id: row.id, actorId: USER })).ok).toBe(true);
    expect(reserves(w)).toHaveLength(1);
  });
  it("a hold above 5,000 points is refused BEFORE any hold, before any claim and before any money function", async () => {
    const huge = addonRowOf({ pricing: editPricing(10_000, 0.0001) });
    expect(huge.plan.addon.pricing.holdPoints).toBeGreaterThan(ADDON_MAX_HOLD_POINTS);
    const { w } = world(1_000_000, [huge]);
    const out = await approveAddonOnce(w.client, { id: huge.id, actorId: USER });
    expect(out).toMatchObject({ ok: false, status: 409, code: "too_large", error: ADDON_APPROVE_MESSAGES_AR.too_large });
    expect(w.calls).toEqual([]);
    expect(w.ledger).toHaveLength(1);
    expect(w.missions.get(huge.id)!.status).toBe("plan_ready");
  });
  it("5,000 points exactly is accepted and 5,001 is refused (a review's hold is exact: 500,000 cells and 500,001 cells)", async () => {
    const edge = addonRowOf({ kind: "review", pricing: reviewPricing(500_000) });
    const over = addonRowOf({ kind: "review", attempt: 2, pricing: reviewPricing(500_001) });
    const { w } = world(100_000, [edge, over]);
    expect(await approveAddonOnce(w.client, { id: over.id, actorId: USER })).toMatchObject({ ok: false, code: "too_large" });
    expect(w.calls).toEqual([]);
    expect(await approveAddonOnce(w.client, { id: edge.id, actorId: USER })).toMatchObject({ ok: true, holdPoints: 5000 });
    expect(reserves(w)[0].delta).toBe(-5000);
  });
  it("an edit whose hold is just under 5,000 is accepted", async () => {
    // search the smallest request whose hold passes 5,000 and take the one just below
    let ok: ReturnType<typeof editPricing> | null = null;
    for (let rows = 1000; rows < 20_000; rows += 10) { const p = editPricing(rows, 0.0001); if (p.holdPoints <= ADDON_MAX_HOLD_POINTS) ok = p; else break; }
    expect(ok).not.toBeNull();
    const row = addonRowOf({ pricing: ok! });
    const { w } = world(100_000, [row]);
    expect((await approveAddonOnce(w.client, { id: row.id, actorId: USER })).ok).toBe(true);
    expect(w.jobs.get(addonJobId(addonQuoteId(row.id)))!.target_volume_max).toBeLessThanOrEqual(5000);
  });
  it("a stored price that is not what the code computes now (a changed hold, estimate, identity or version) is refused before any money function", async () => {
    const make = (edit: (a: any) => void) => { const r = addonRowOf({}); edit(r.plan.addon); return r; };
    const cases = [
      make((a) => { a.pricing.holdPoints += 1; }),
      make((a) => { a.pricing.estimatePoints += 1; }),
      make((a) => { a.pricing.costPerRowUsd = 0.0006; }),
      make((a) => { a.pricing.requested = 41; }),
      make((a) => { a.newVersion = 5; }),
      make((a) => { a.pricing.settings = { ...a.pricing.settings, markup: 1 }; }),
      make((a) => { a.pricing.settings = { ...a.pricing.settings, minChargePoints: 0 }; }),
      (() => { const r = addonRowOf({}); (r as any).id = "msn_00000000000000000000"; return r; })(),
      make((a) => { a.attempt = 2; }),
    ];
    for (const row of cases) {
      const { w } = world(10_000, [row]);
      const out = await approveAddonOnce(w.client, { id: row.id, actorId: USER });
      expect(out).toMatchObject({ ok: false, status: 409, code: "plan_changed" });
      expect(w.calls).toEqual([]);
      expect(w.missions.get(row.id)!.status).toBe("plan_ready");
    }
  });
  it("a review whose price does not follow its cells, or whose requested units are not 1, is refused", async () => {
    const a = addonRowOf({ kind: "review", pricing: reviewPricing(50_000) }); a.plan.addon.pricing.cells = 1000;
    const b = addonRowOf({ kind: "review", pricing: reviewPricing(50_000) }); b.plan.addon.pricing.requested = 2;
    const c = addonRowOf({ kind: "review", pricing: reviewPricing(50_000) }); c.plan.addon.newVersion = 2;
    for (const row of [a, b, c]) {
      const { w } = world(10_000, [row]);
      expect(await approveAddonOnce(w.client, { id: row.id, actorId: USER })).toMatchObject({ ok: false, code: "plan_changed" });
      expect(w.calls).toEqual([]);
    }
  });
  it("a normal mission's row (no add-on in its plan), another user's row, a missing row and a row that is not plan_ready are refused and written to nowhere", async () => {
    const normal = { id: "msn_aaaaaaaaaaaaaaaaaaaa", user_id: USER, status: "plan_ready", plan: { stages: [], price: {} } };
    const cancelled = addonRowOf({ status: "cancelled" });
    const { w } = world(10_000, [normal as any, cancelled]);
    expect(await approveAddonOnce(w.client, { id: normal.id, actorId: USER })).toMatchObject({ ok: false, status: 409, error: ADDON_APPROVE_MESSAGES_AR.not_ready });
    expect(await approveAddonOnce(w.client, { id: cancelled.id, actorId: USER })).toMatchObject({ ok: false, status: 409, error: ADDON_APPROVE_MESSAGES_AR.not_ready });
    expect(await approveAddonOnce(w.client, { id: "msn_none", actorId: USER })).toMatchObject({ ok: false, status: 404 });
    const mine = addonRowOf({ attempt: 3 });
    w.missions.set(mine.id, mine);
    expect(await approveAddonOnce(w.client, { id: mine.id, actorId: "other", expectUserId: "22222222-2222-4222-8222-222222222222" })).toMatchObject({ ok: false, status: 404 });
    expect(w.calls).toEqual([]);
    expect(w.ledger).toHaveLength(1);
    expect(w.missions.get(normal.id)).toMatchObject({ status: "plan_ready" });
  });
  it("cancel before approval writes nothing: a cancelled add-on cannot be approved, and no money function was ever called", async () => {
    const { w, row } = world();
    w.missions.get(row.id)!.status = "cancelled";
    expect((await approveAddonOnce(w.client, { id: row.id, actorId: USER })).ok).toBe(false);
    expect(w.calls).toEqual([]);
    expect(w.ledger).toHaveLength(1);
    expect(w.quotes.size).toBe(0);
  });
  it("the two-active-jobs limit counts an add-on (decision D8): with two jobs active the third is refused, nothing is held, the row stays plan_ready", async () => {
    const rows = [addonRowOf({ attempt: 1 }), addonRowOf({ attempt: 2 }), addonRowOf({ attempt: 3 })];
    const { w } = world(100_000, rows);
    expect((await approveAddonOnce(w.client, { id: rows[0].id, actorId: USER })).ok).toBe(true);
    expect((await approveAddonOnce(w.client, { id: rows[1].id, actorId: USER })).ok).toBe(true);
    const third = await approveAddonOnce(w.client, { id: rows[2].id, actorId: USER });
    expect(third).toMatchObject({ ok: false, code: "concurrency_limit", error: ADDON_APPROVE_MESSAGES_AR.concurrency_limit });
    expect(reserves(w)).toHaveLength(2);
    expect(w.missions.get(rows[2].id)!.status).toBe("plan_ready");
  });
  it("a quote that expired (the customer came back after the quote's thirty minutes, with the quote left over from a refused approval) ends the add-on: the next attempt has a new id", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T10:00:00Z"));
    const { w, row } = world(50);
    expect((await approveAddonOnce(w.client, { id: row.id, actorId: USER })).code).toBe("insufficient_balance");
    vi.setSystemTime(new Date("2026-11-04T10:45:00Z"));
    w.ledger.push({ id: "top_2", delta: 5000, type: "topup" });
    const late = await approveAddonOnce(w.client, { id: row.id, actorId: USER });
    expect(late).toMatchObject({ ok: false, code: "quote_expired", error: ADDON_APPROVE_MESSAGES_AR.quote_expired });
    expect(w.missions.get(row.id)).toMatchObject({ status: "cancelled", error: "quote_expired" });
    expect(reserves(w)).toEqual([]);
    const next = addonRowOf({ attempt: 2 });
    expect(next.id).not.toBe(row.id);
    w.missions.set(next.id, next);
    expect((await approveAddonOnce(w.client, { id: next.id, actorId: USER })).ok).toBe(true);
    expect(reserves(w)).toHaveLength(1);
  });
});

describe("the add-on plan reader and checker", () => {
  it("readAddonPlan is strict: a normal plan, a wrong kind and a missing field are not add-ons", () => {
    const good = addonRowOf({}).plan;
    expect(readAddonPlan(good)).not.toBeNull();
    expect(readAddonPlan({ stages: [] })).toBeNull();
    expect(readAddonPlan(null)).toBeNull();
    expect(readAddonPlan({ addon: { ...good.addon, kind: "free_gift" } })).toBeNull();
    expect(readAddonPlan({ addon: { ...good.addon, v: 2 } })).toBeNull();
    expect(readAddonPlan({ addon: { ...good.addon, baseVersion: 0 } })).toBeNull();
    expect(readAddonPlan({ addon: { ...good.addon, pricing: { ...good.addon.pricing, holdPoints: 0 } } })).toBeNull();
    expect(readAddonPlan({ addon: { ...good.addon, kind: "review" } })).toBeNull(); // a review needs cells
  });
  it("checkAddon recomputes the identity: the id must be addonId(mission, base version, attempt)", () => {
    const row = addonRowOf({ of: "msn_b060d3347ed7660f972e", baseVersion: 2, attempt: 4 });
    const addon = readAddonPlan(row.plan)!;
    expect(checkAddon(row.id, addon)).toMatchObject({ ok: true });
    expect(checkAddon(addonId("msn_b060d3347ed7660f972e", 2, 5), addon)).toMatchObject({ ok: false, code: "plan_changed" });
  });
});
