import { describe, expect, it, vi } from "vitest";
import { validateAndPricePlan, type PlanLookup, type PricedPlan } from "../src/lib/agentMission/plan";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { approveMission } from "../src/lib/agentMission/lifecycle";
import { planNeedsRequote } from "../src/lib/agentMission/catalogPriceGuard";
import { sealFinalPrice } from "../src/lib/agentMission/finalPrice";
import { smallerVersionOf } from "../src/lib/agentMission/overLimit";
import { CATALOG_PRICE_REV } from "../src/lib/treg/priceRev";
import { liveFacebookPlan } from "./helpers/facebookLiveShape";

/**
 * DT-20261119-11 Gate 2, F2 (P0-2): a customer's edit, a smaller version and the final recompute REUSE the saved costs, so they carry the ORIGINAL price-evidence revision; only a price built from new evidence is stamped with the current one. An old card that is edited
 * and approved is refused with `plan_changed` before any RPC. No network.
 */
const FIND = "findymail.search.employees";
const sample = (n: number) => ({ id: `s${n}`, text: `محمد صلاح يسجل هدفًا رقم ${n} مع ليفربول`, url: `https://x.example/s/${n}`, author: `fan${n}`, created_at: "2026-10-20T10:00:00Z", is_reply: "لا" });
const mapped = [1, 2, 3, 4, 5, 6, 7, 8].map(sample);
const lookup = (): PlanLookup => ({
  call: (id) => (id === "call_0001" ? { id, endpointId: "anyapi.x.search.posts", ok: true, costUsd: 0.00075, rows: 20, params: { query: "محمد صلاح" } } : null),
  evidenceText: (id) => (id === "out_0001" ? JSON.stringify(mapped) : `${JSON.stringify(mapped)} https://x.example/s/1 https://x.example/s/2 s1 s2`),
  endpointAllowed: () => true, requestText: "هات ٣٠٠ تغريدة عن محمد صلاح",
});
const base = (): PricedPlan => {
  const r = validateAndPricePlan({
    summary_ar: "ستحصل على ٣٠٠ تغريدة عربية عن محمد صلاح دون الردود.", assumptions_ar: ["المقصود: لاعب كرة القدم محمد صلاح.", "تغريدات عربية، الأحدث أولًا."],
    stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: 300, parent_key: null, deliver: true,
      columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "created_at", title_ar: "التاريخ والوقت" }],
      sample_rows: mapped.slice(0, 2), measured_by: ["call_0001", "out_0001"], how_ar: "بحث بالاسم، عربي ودون الردود.", relevance: { subject_ar: "لاعب كرة القدم محمد صلاح", terms: ["محمد صلاح"], text_columns: ["text"], min_own_words: 0 }, yield_from: "out_0001",
      filters: [{ kind: "exclude_replies" }, { kind: "language", lang: "ar" }] }],
  }, lookup());
  if (!r.ok) throw new Error(r.issues.join("; "));
  return r.plan;
};
/** The old Findymail card: its stage reads the corrected endpoint and its price was made BEFORE the revision existed (no `pricedUnder`) at the old, too-low cost. */
const oldFindymailCard = (): PricedPlan => {
  const p = base();
  p.stages[0].endpoint_id = FIND;
  p.stages[0].measured_cost_per_row_usd = 0.00099;
  delete (p.price as { pricedUnder?: number }).pricedUnder;
  return p;
};
const noRpcClient = () => ({ rpc: vi.fn(async () => { throw new Error("a money RPC was called"); }), from: vi.fn(() => { throw new Error("the database was touched"); }) });

describe("F2: an edit of an old card keeps the OLD revision and approval says plan_changed before any RPC", () => {
  it("the old card itself needs a re-quote (the guard sees the corrected endpoint and no revision)", () => {
    expect(planNeedsRequote(oldFindymailCard())).toBe(true);
  });
  it.each([
    ["quantity 50 → 100", { count: 100 }],
    ["a filter changed", { stages: [{ key: "tweets", filters: [{ kind: "language", lang: "en" }] }] }],
    ["a column switched off", { stages: [{ key: "tweets", columns: ["text", "url", "author"] }] }],
  ])("%s: the edited price carries NO revision, the guard still needs a re-quote and approve = plan_changed with no RPC", async (_n, edits) => {
    const r = applyPlanEdits(oldFindymailCard(), edits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.price.pricedUnder).toBeUndefined();
    expect(planNeedsRequote(r.plan)).toBe(true);
    const client = noRpcClient();
    expect(await approveMission(client as never, { id: "m", user_id: "u", plan: r.plan })).toMatchObject({ ok: false, code: "plan_changed" });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });
  it("two edits in a row still carry the old revision", () => {
    const a = applyPlanEdits(oldFindymailCard(), { count: 100 });
    if (!a.ok) throw new Error(a.errorAr);
    const b = applyPlanEdits(a.plan, { count: 50 });
    if (!b.ok) throw new Error(b.errorAr);
    expect(b.plan.price.pricedUnder).toBeUndefined();
    expect(planNeedsRequote(b.plan)).toBe(true);
  });
  it("the final recompute of persisted costs (sealFinalPrice) carries the revision of the stored price, never the current one", () => {
    const old = oldFindymailCard();
    const stale = { ...old, price: { ...old.price, reservePoints: old.price.reservePoints + 7 } };
    const sealed = sealFinalPrice(stale);
    expect(sealed.drift).not.toBeNull();
    expect(sealed.plan.price.pricedUnder).toBeUndefined();
    const fresh = base();
    const staleFresh = { ...fresh, price: { ...fresh.price, reservePoints: fresh.price.reservePoints + 7 } };
    expect(sealFinalPrice(staleFresh).plan.price.pricedUnder).toBe(CATALOG_PRICE_REV);
  });
  it("a smaller version carries the revision of the plan it was cut from (old stays old, current stays current)", () => {
    const live = liveFacebookPlan().plan;
    const limit = 25_000;
    const fresh = smallerVersionOf(live, limit);
    expect(fresh).not.toBeNull();
    expect(fresh!.plan.price.pricedUnder).toBe(live.price.pricedUnder);
    const old = { ...live, price: { ...live.price } } as PricedPlan;
    delete (old.price as { pricedUnder?: number }).pricedUnder;
    const smaller = smallerVersionOf(old, limit);
    expect(smaller).not.toBeNull();
    expect(smaller!.plan.price.pricedUnder).toBeUndefined();
    const stamped = { ...live, price: { ...live.price, pricedUnder: CATALOG_PRICE_REV } } as PricedPlan;
    expect(smallerVersionOf(stamped, limit)!.plan.price.pricedUnder).toBe(CATALOG_PRICE_REV);
  });
});

describe("F2 counter-cases: nothing else changes", () => {
  it("an unrelated plan (no corrected endpoint) is edited and never needs a re-quote, old or new", () => {
    const p = base();
    delete (p.price as { pricedUnder?: number }).pricedUnder;
    const r = applyPlanEdits(p, { count: 100 });
    if (!r.ok) throw new Error(r.errorAr);
    expect(planNeedsRequote(r.plan)).toBe(false);
  });
  it("a freshly regenerated plan of the same mission (current revision) with the corrected endpoint is edited and stays current: no plan_changed from the guard", () => {
    const p = base();
    p.stages[0].endpoint_id = FIND;
    p.price = { ...p.price, pricedUnder: CATALOG_PRICE_REV };
    const r = applyPlanEdits(p, { count: 100 });
    if (!r.ok) throw new Error(r.errorAr);
    expect(r.plan.price.pricedUnder).toBe(CATALOG_PRICE_REV);
    expect(planNeedsRequote(r.plan)).toBe(false);
  });
  it("an already approved job is not re-quoted: the guard is only read by approval, never by settlement of a stored price", () => {
    expect(planNeedsRequote({ stages: [], price: {} as never })).toBe(false);
  });
});
