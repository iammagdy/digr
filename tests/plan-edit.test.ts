import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { assertReplayInvariants, readWorkbook, replay, REPLAY_USER } from "./helpers/agentReplay";
import { planning as xPlanning, pages } from "./helpers/engineXScenario";
import { customerPlanView, validateAndPricePlan, type PlanLookup, type PricedPlan } from "../src/lib/agentMission/plan";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { editPlanForCustomer, loadCustomerMission } from "../src/lib/agentMission/customerActions";
import { repriceStoredPlan } from "../src/lib/agentMission/lifecycle";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs } from "../src/lib/agentMission/plan";

/**
 * THE CUSTOMER EDITS THE PLAN ITSELF (the card's «عدّل الطلب»): the number of items, the period, the language, each exclusion, the main columns, without cancelling and retyping. The edit is applied to the stored plan by code, checked
 * again, and PRICED AGAIN BY CODE (the model never decides a price); the card shows the result for approval. Retyping the request stays beside it.
 */
const sample = (n: number, extra: Record<string, unknown> = {}) => ({ id: `s${n}`, text: `محمد صلاح يسجل هدفًا رقم ${n} مع ليفربول`, url: `https://x.example/s/${n}`, author: `fan${n}`, created_at: "2026-10-20T10:00:00Z", is_reply: "لا", ...extra });
const mapped = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => sample(n));

const xLookup = (): PlanLookup => ({
  call: (id) => (id === "call_0001" ? { id, endpointId: "anyapi.x.search.posts", ok: true, costUsd: 0.00075, rows: 20, params: { query: "محمد صلاح" } } : null),
  evidenceText: (id) => (id === "out_0001" ? JSON.stringify(mapped) : `${JSON.stringify(mapped)} https://x.example/s/1 https://x.example/s/2 s1 s2`),
  endpointAllowed: () => true, requestText: "هات ٣٠٠ تغريدة عن محمد صلاح",
});
const xPlan = (): PricedPlan => {
  const r = validateAndPricePlan({
    summary_ar: "ستحصل على ٣٠٠ تغريدة عربية عن محمد صلاح دون الردود.",
    assumptions_ar: ["المقصود: لاعب كرة القدم محمد صلاح.", "تغريدات عربية، الأحدث أولًا."],
    stages: [{
      key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: 300, parent_key: null, deliver: true,
      columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "created_at", title_ar: "التاريخ والوقت" }],
      sample_rows: mapped.slice(0, 2), measured_by: ["call_0001", "out_0001"], how_ar: "بحث بالاسم، عربي ودون الردود.",
      relevance: { subject_ar: "لاعب كرة القدم محمد صلاح", terms: ["محمد صلاح"], text_columns: ["text"], min_own_words: 0 }, yield_from: "out_0001",
      filters: [{ kind: "exclude_replies" }, { kind: "language", lang: "ar" }],
    }],
  }, xLookup());
  if (!r.ok) throw new Error(r.issues.join("; "));
  return r.plan;
};

function twoStage(): PricedPlan {
  const calls = new Map([["call_0001", { id: "call_0001", endpointId: "x.x.search-posts-all", ok: true, costUsd: 0.05, rows: 10 }], ["call_0002", { id: "call_0002", endpointId: "anyapi.instagram.post.comments", ok: true, costUsd: 0.00144, rows: 12 }]]);
  const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => "9000 9001 9000-c0 https://x.example/p/9000", endpointAllowed: () => true };
  const r = validateAndPricePlan({ summary_ar: "ستحصل على منشورات وتعليقاتها في ورقتين مرتبطتين.", stages: [
    { key: "posts", title_ar: "المنشورات", endpoint_id: "x.x.search-posts-all", expected_rows: 20, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "likes", title_ar: "الإعجابات" }], sample_rows: [{ id: "9000", text: "a", url: "https://x.example/p/9000", likes: 3 }], measured_by: ["call_0001"] },
    { key: "comments", title_ar: "التعليقات", endpoint_id: "anyapi.instagram.post.comments", expected_rows: 100, parent_key: "posts", per_parent_rows: 5, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "الكاتب" }], sample_rows: [{ id: "9000-c0", text: "x", author: "a" }], measured_by: ["call_0002"] },
  ] }, lookup);
  if (!r.ok) throw new Error(r.issues.join("; "));
  return r.plan;
}

describe("the number of items", () => {
  it("is the target of the stage the customer's quantity counts; the price is computed AGAIN by the same function; the sentences that state it follow", () => {
    const plan = xPlan();
    const before = JSON.stringify(plan);
    const r = applyPlanEdits(plan, { count: 100 });
    expect(JSON.stringify(plan)).toBe(before);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.stages[0]).toMatchObject({ planned_rows: 100, expected_rows: 100 });
    expect(r.plan.quantity).toEqual({ requested: 100, stage_key: "tweets", target: 100, source: "edit" });
    expect(r.plan.price).toEqual(priceMissionByCode(stagePriceInputs(r.plan.stages), { settings: plan.price.settings }));
    expect(r.plan.price.deliveredRows).toBe(100);
    expect(repriceStoredPlan(r.plan).reservePoints).toBe(r.plan.price.reservePoints);
    // the headline said ٣٠٠: it says ١٠٠ now
    expect(r.plan.summary_ar).toContain("١٠٠ تغريدة");
    expect(r.plan.summary_ar).not.toContain("٣٠٠");
    expect(customerPlanView(r.plan).stages[0].expected_rows).toBe(100);
  });

  it("a stage that hangs on it follows in proportion; a parent that cannot give that many grows", () => {
    const plan = twoStage();
    const up = applyPlanEdits(plan, { count: 400 });
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    // 400 comments need 80 posts of five comments each: the target stage is the first delivered stage (the posts) in a plan with no quantity
    expect(up.plan.stages[0].planned_rows).toBe(400);
    expect(up.plan.stages[1].planned_rows).toBe(Math.min(400 * 5, Math.round(100 * (400 / 20))));
  });

  it("refused: not a whole number, below one, above the limit (with an Arabic sentence)", () => {
    for (const count of [0, -3, 1.5, 6000, "abc"]) {
      const r = applyPlanEdits(xPlan(), { count });
      expect(r.ok, String(count)).toBe(false);
      if (!r.ok) expect(r.errorAr).toMatch(/العدد/);
    }
    expect(applyPlanEdits(xPlan(), { count: 5000 }).ok).toBe(true);
  });
});

describe("the exclusions, the language and the period", () => {
  it("switching an exclusion OFF takes its promise off the card: the model's own line, the headline and the stage's explanation", () => {
    const plan = xPlan();
    const before = customerPlanView(plan);
    expect(before.assumptions_ar).toContain("دون الردود.");
    expect(before.summary_ar).toContain("دون الردود");
    const r = applyPlanEdits(plan, { stages: [{ key: "tweets", filters: [{ kind: "exclude_replies", enabled: false }, { kind: "language", enabled: false }] }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = customerPlanView(r.plan);
    expect(after.assumptions_ar).toEqual(["المقصود: لاعب كرة القدم محمد صلاح."]);
    expect(after.summary_ar).not.toContain("دون الردود");
    expect(after.summary_ar).not.toContain("عربية");
    expect(r.plan.stages[0].how_ar).toBeUndefined();
    expect(r.plan.stages[0].filters!.filter((f) => f.enabled === false).map((f) => f.kind).sort()).toEqual(["exclude_replies", "exclude_reposts", "language", "period"]);
  });

  it("switching an exclusion ON puts a sentence BUILT BY CODE on the card; the language and the period (days) are the customer's to set", () => {
    const r = applyPlanEdits(xPlan(), { stages: [{ key: "tweets", filters: [{ kind: "period", enabled: true, days: 7 }, { kind: "exclude_reposts", enabled: true }, { kind: "language", lang: "en" }] }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const view = customerPlanView(r.plan);
    expect(view.assumptions_ar).toContain("آخر ٧ أيام.");
    expect(view.assumptions_ar).toContain("دون إعادة النشر.");
    expect(view.assumptions_ar).toContain("باللغة الإنجليزية فقط.");
    const f = r.plan.stages[0].filters!;
    expect(f.find((x) => x.kind === "period")).toMatchObject({ days: 7, field: "created_at" });
    expect(f.find((x) => x.kind === "language")).toMatchObject({ lang: "en" });
    // the editor draws the same state
    const row = (k: string) => view.edit.stages[0].filters.find((x) => x.kind === k)!;
    expect(row("period")).toMatchObject({ enabled: true, days: 7 });
    expect(row("exclude_reposts").enabled).toBe(true);
  });

  it("what the mapping cannot enforce is not offered, and bad values are refused", () => {
    const plan = xPlan();
    expect(plan.stages[0].filters!.some((f) => f.kind === "account" || f.kind === "place")).toBe(false);
    expect(applyPlanEdits(plan, { stages: [{ key: "tweets", filters: [{ kind: "account", enabled: true }] }] }).ok).toBe(false);
    expect(applyPlanEdits(plan, { stages: [{ key: "tweets", filters: [{ kind: "language", lang: "fr" as never }] }] }).ok).toBe(false);
    expect(applyPlanEdits(plan, { stages: [{ key: "tweets", filters: [{ kind: "period", days: 0 }] }] }).ok).toBe(false);
    expect(applyPlanEdits(plan, { stages: [{ key: "tweets", filters: [{ kind: "language", days: 5 }] }] }).ok).toBe(false);
    expect(applyPlanEdits(plan, { stages: [{ key: "nope", filters: [] }] }).ok).toBe(false);
    expect(applyPlanEdits(plan, "x").ok).toBe(false);
  });

  it("the price rests on the cost per MATCHING item: with the measured page at hand, a switched-on filter that rejects half of it raises the unit price", () => {
    const plan = xPlan();
    const replies = mapped.map((r, i) => ({ ...r, is_reply: i % 2 === 0 ? "نعم" : "لا" }));
    const off = applyPlanEdits(plan, { stages: [{ key: "tweets", filters: [{ kind: "exclude_replies", enabled: false }] }] }, { yieldRows: () => replies });
    const on = applyPlanEdits(plan, { count: 300 }, { yieldRows: () => replies });
    expect(off.ok && on.ok).toBe(true);
    if (!off.ok || !on.ok) return;
    expect(off.plan.stages[0].yield_share).toBe(1);
    expect(on.plan.stages[0].yield_share).toBeCloseTo(0.5, 5);
    expect(on.plan.price.ruleUnitPoints!).toBeGreaterThan(off.plan.price.ruleUnitPoints!);
  });
});

describe("the main columns", () => {
  it("an optional column can be switched off and back on; a column a check reads cannot; at least one column stays", () => {
    const plan = xPlan();
    const off = applyPlanEdits(plan, { stages: [{ key: "tweets", columns: ["text", "url", "created_at"] }] });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.plan.stages[0].columns.map((c) => c.key)).toEqual(["text", "url", "created_at"]);
    expect(off.plan.stages[0].hidden_columns?.map((c) => c.key)).toEqual(["author"]);
    const view = customerPlanView(off.plan);
    expect(view.stages[0].columns.map((c) => c.key)).toEqual(["text", "url", "created_at"]);
    expect(view.edit.stages[0].columns.find((c) => c.key === "author")).toMatchObject({ on: false, locked: false });
    expect(view.edit.stages[0].columns.find((c) => c.key === "text")).toMatchObject({ on: true, locked: true });
    // back on
    const back = applyPlanEdits(off.plan, { stages: [{ key: "tweets", columns: ["text", "url", "author", "created_at"] }] });
    expect(back.ok && back.plan.stages[0].columns.map((c) => c.key)).toEqual(["text", "url", "created_at", "author"].sort((a, b) => ["text", "url", "created_at", "author"].indexOf(a) - ["text", "url", "created_at", "author"].indexOf(b)));
    expect(back.ok && back.plan.stages[0].hidden_columns).toBeUndefined();
    // the text of a post is what two posts are compared by: it stays
    expect(applyPlanEdits(plan, { stages: [{ key: "tweets", columns: ["url", "author"] }] }).ok).toBe(false);
    expect(applyPlanEdits(plan, { stages: [{ key: "tweets", columns: [] }] }).ok).toBe(false);
    expect(applyPlanEdits(plan, { stages: [{ key: "tweets", columns: ["text", "nope"] }] }).ok).toBe(false);
    // a locked column also stays while a filter reads it (the date of an enabled period filter)
    const withPeriod = applyPlanEdits(plan, { stages: [{ key: "tweets", filters: [{ kind: "period", enabled: true, days: 30 }] }] });
    expect(withPeriod.ok).toBe(true);
    if (withPeriod.ok) expect(applyPlanEdits(withPeriod.plan, { stages: [{ key: "tweets", columns: ["text", "url", "author"] }] }).ok).toBe(false);
  });
});

describe("THE EDIT ON THE STORED MISSION: no cancel, no retype; priced again; approved at the new price; the file follows the edit", () => {
  const dbWith = (plan: PricedPlan, patch: Record<string, unknown> = {}) => {
    const db = createMemoryDb();
    db.seed("missions", [{ id: "msn_edit1", user_id: REPLAY_USER, status: "plan_ready", request_text: "هات ٣٠٠ تغريدة عن محمد صلاح", plan, plan_public: customerPlanView(plan), reserved_points: plan.price.reservePoints, unit_price_points: plan.price.unitPricePoints, created_at: new Date().toISOString(), ...patch }]);
    db.seed("mission_events", []);
    const client: any = { from: (t: string) => db.from(t), storage: { from: () => ({ download: async () => ({ data: null, error: { message: "none" } }) }) } };
    return { db, client };
  };

  it("stores the edited plan with its own card view and its new price; the mission stays «plan_ready»; a plan event is written", async () => {
    const plan = xPlan();
    const { db, client } = dbWith(plan);
    const r = await editPlanForCustomer(client, { id: "msn_edit1", userId: REPLAY_USER, edits: { count: 120, stages: [{ key: "tweets", filters: [{ kind: "exclude_reposts", enabled: true }] }] } });
    expect(r.ok).toBe(true);
    const row = db.rows("missions")[0];
    expect(row.status).toBe("plan_ready");
    expect((row.plan as PricedPlan).stages[0].planned_rows).toBe(120);
    expect((row.plan_public as any).stages[0].expected_rows).toBe(120);
    expect(row.reserved_points).toBe((row.plan as PricedPlan).price.reservePoints);
    expect(row.unit_price_points).toBe((row.plan as PricedPlan).price.unitPricePoints);
    expect(repriceStoredPlan(row.plan as PricedPlan).reservePoints).toBe(row.reserved_points);
    const ev = db.rows("mission_events").find((e) => e.kind === "plan")!;
    expect(ev.message_ar).not.toMatch(/[0-9]/);
    expect(ev.counts.rows).toBe(120);
    // the card, as the customer reads it now
    const load = await loadCustomerMission(client, { id: "msn_edit1", userId: REPLAY_USER });
    expect(load.ok && load.view.stages[0].rows).toBe(120);
    expect(load.ok && load.view.edit?.stages[0].filters.find((f) => f.kind === "exclude_reposts")?.enabled).toBe(true);
  });

  it("refused: somebody else's mission (not found), a mission already approved, a bad edit (nothing changes)", async () => {
    const plan = xPlan();
    const other = dbWith(plan);
    expect(await editPlanForCustomer(other.client, { id: "msn_edit1", userId: "someone-else", edits: { count: 10 } })).toMatchObject({ ok: false, status: 404 });
    const approved = dbWith(plan, { status: "approved" });
    expect(await editPlanForCustomer(approved.client, { id: "msn_edit1", userId: REPLAY_USER, edits: { count: 10 } })).toMatchObject({ ok: false, status: 409 });
    expect((approved.db.rows("missions")[0].plan as PricedPlan).stages[0].planned_rows).toBe(300);
    const bad = dbWith(plan);
    expect(await editPlanForCustomer(bad.client, { id: "msn_edit1", userId: REPLAY_USER, edits: { count: 0 } })).toMatchObject({ ok: false, status: 400 });
    expect((bad.db.rows("missions")[0].plan as PricedPlan).stages[0].planned_rows).toBe(300);
  });

  it("the whole path: plan, EDIT (count, a filter on, a column off), approve at the new price, execute: the file has the edited count and columns, the charge follows the new unit; the mission was never cancelled", async () => {
    let edited: PricedPlan | null = null;
    const r = await replay({
      request: "هات ٣٠٠ تغريدة عن محمد صلاح",
      planning: xPlanning(), execution: () => [], answers: [pages(1)[0], ...pages(30)],
      beforeApproval: async ({ client, missionId }) => {
        const res = await editPlanForCustomer(client, { id: missionId, userId: REPLAY_USER, edits: { count: 100, stages: [{ key: "tweets", columns: ["text", "url", "date"], filters: [{ kind: "language", enabled: true }] }] } });
        expect(res.ok).toBe(true);
        const card = await loadCustomerMission(client, { id: missionId, userId: REPLAY_USER });
        expect(card.ok && card.view.phase).toBe("plan");
        expect(card.ok && card.view.stages[0].rows).toBe(100);
        edited = (await (client.from("missions").select("plan").eq("id", missionId).maybeSingle())).data.plan;
      },
    });
    expect(edited).not.toBeNull();
    // approved at the edited plan's price (the existing money functions: the reserve is the NEW one)
    expect(r.plannedPlan.stages[0].planned_rows).toBe(100);
    assertReplayInvariants(r, { expectDelivered: 100 });
    expect(r.mission.reserved_points).toBe(r.plannedPlan.price.reservePoints);
    expect(r.money.ledger.find((l) => l.type === "reserve")!.delta).toBe(-r.plannedPlan.price.reservePoints);
    expect(r.store.events.some((e) => /ألغي|أُلغيت/.test(e.message_ar))).toBe(false);
    expect(r.mission.status).toBe("completed");
    // the file: 100 tweets, the columns the customer kept (no account column)
    const sheet = (await readWorkbook(r)).getWorksheet("التغريدات")!;
    expect(sheet.rowCount - 1).toBe(100);
    expect((sheet.getRow(1).values as unknown[]).slice(1, 4)).toEqual(["نص التغريدة", "رابط التغريدة", "التاريخ والوقت"]);
    expect((sheet.getRow(1).values as unknown[]).includes("الحساب")).toBe(false);
    // the card, the tracker and the file say the edited target
    expect(r.finalView.steps[0]).toMatchObject({ countAr: "١٠٠ من ١٠٠ تغريدة" });
    expect(r.finalView.resultLinesAr[0]).toBe("تم تسليم ١٠٠ من ١٠٠ تغريدة.");
  });
});
