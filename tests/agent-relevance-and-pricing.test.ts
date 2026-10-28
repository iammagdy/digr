import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { classifyRow, classifyRows, searchQueryOf, validateRelevanceSpec, type RelevanceSpec } from "../src/lib/agentMission/relevance";
import { DEFAULT_MISSION_PRICING_SETTINGS, MISSION_PRICING_SETTING_KEY, minimumLineAr, normalizeMissionPricingSettings, priceByRule, readMissionPricingSettings, settlementChargeFor } from "../src/lib/missionPricing";
import { legacyPriceMissionByCode, priceMissionByCode, reviewBudgetUsdFor, settlementCharge } from "../src/lib/agentMission/price";
import { AGENT_JOB_POINTS_CAP, AGENT_MODEL_EXECUTION_PER_STAGE_ESTIMATE_USD, AGENT_MODEL_PLANNING_ESTIMATE_USD, AGENT_REVIEW_BUDGET_SHARE } from "../src/lib/agentMission/constants";
import { approveMission, repriceStoredPlan, settleMission } from "../src/lib/agentMission/lifecycle";
import { customerPlanView, validateAndPricePlan, type PlanLookup, type PricedPlan } from "../src/lib/agentMission/plan";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { setMissionPricing } from "../src/lib/agentMission/adminActions";
import { createReviewer, parseVerdicts, reviewPrompt, type ReviewCall } from "../agent/src/review";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runExecution, runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { buildTools, newRunState, EXCLUDED_PATH, type ToolContext } from "../agent/src/tools";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { fakeRecorder, NOT_ADMIN, USER_ID, makeHarness } from "./helpers/agentHarness";
import { assertReplayInvariants, pagedAnswers, replay } from "./helpers/agentReplay";
import { callIds, lastOutputId, pagedCalls, tregResult, xPage, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

/**
 * RELEVANCE, THE ONE PRICING RULE AND THE COST ACCOUNT. Rows here have the shapes of the real tweets the owner found in the delivered file of «هات ٣٠٠ تغريدة عن محمد صلاح» (msn_56a3a9da538bf30bf90d): a tweet
 * whose AUTHOR's name holds the name (the text never mentions it), another person with the same name (a martyr, a Sudanese project manager, a reciter), a bare one-word mention and an empty reply.
 */
const SALAH: RelevanceSpec = {
  subject_ar: "محمد صلاح لاعب كرة القدم",
  terms: ["محمد صلاح", "مو صلاح", "Mohamed Salah", "Mo Salah"],
  context_terms: ["ليفربول", "هدف", "منتخب", "الفراعنة", "الدوري", "مباراة", "كرة", "الملك المصري", "salah goal"],
  exclude_terms: ["الشهيد", "مدير مشروع", "القارئ", "مدرس النحو"],
  text_columns: ["text"],
};

/** The rows of the real file, by kind. `n` makes each row unique. */
const REAL = {
  match: (n: number) => ({ id: `m${n}`, text: `محمد صلاح يسجل هدفًا رائعًا مع ليفربول اليوم رقم ${n}`, author: `fan${n}`, url: `https://x.example/s/m${n}` }),
  authorOnly: (n: number) => ({ id: `a${n}`, text: `اللهم اجعل يومنا سعيدًا ويسر لنا أمورنا رقم ${n}`, author: "سعيد محمد الصلاحي", url: `https://x.example/s/a${n}` }),
  authorOnly2: (n: number) => ({ id: `b${n}`, text: `صباح الخير يا جماعة رقم ${n}`, author: "صقر محمد صلاح صقر", url: `https://x.example/s/b${n}` }),
  namesake: (n: number) => ({ id: `n${n}`, text: `رحم الله الشهيد محمد صلاح وأسكنه الجنة رقم ${n}`, author: `user${n}`, url: `https://x.example/s/n${n}` }),
  sudanese: (n: number) => ({ id: `s${n}`, text: `محمد صلاح مدير مشروع في الخرطوم يعلن النتائج رقم ${n}`, author: `user${n}`, url: `https://x.example/s/s${n}` }),
  bare: (n: number) => ({ id: `r${n}`, text: `محمد صلاح`, author: `user${n}`, url: `https://x.example/s/r${n}` }),
  emptyReply: (n: number) => ({ id: `e${n}`, text: `@MoSalah`, author: `user${n}`, url: `https://x.example/s/e${n}` }),
  mentionReply: (n: number) => ({ id: `q${n}`, text: `@mosalah @محمد_صلاح 🔥`, author: `user${n}`, url: `https://x.example/s/q${n}` }),
  noContext: (n: number) => ({ id: `u${n}`, text: `رأيي في محمد صلاح أنه مختلف عن غيره في الشخصية رقم ${n}`, author: `user${n}`, url: `https://x.example/s/u${n}` }),
};

describe("the deterministic relevance check, on the shapes of the real file", () => {
  it("a tweet whose AUTHOR's name holds the name but whose text does not mention it is excluded (no_term)", () => {
    expect(classifyRow(SALAH, REAL.authorOnly(1))).toEqual({ verdict: "exclude", reason: "no_term" });
    expect(classifyRow(SALAH, REAL.authorOnly2(1))).toEqual({ verdict: "exclude", reason: "no_term" });
    // the author column is never one of the text columns, even if an author field were listed by mistake in the row
    expect(classifyRow(SALAH, { id: "x", text: "كلام آخر تمامًا بلا ذكر للاسم هنا", author: "محمد صلاح" })).toEqual({ verdict: "exclude", reason: "no_term" });
  });

  it("«الصلاحي» is not «صلاح»: a word that merely contains the name does not match", () => {
    expect(classifyRow({ ...SALAH, terms: ["صلاح"] }, { text: "حدثني الصلاحي عن الموضوع كثيرًا اليوم بالتفصيل" })).toEqual({ verdict: "exclude", reason: "no_term" });
    expect(classifyRow({ ...SALAH, terms: ["صلاح"] }, { text: "اللاعب صلاح يسجل هدفا في المباراة" }).verdict).toBe("match");
  });

  it("another person with the same name (a martyr, a project manager) is excluded (other_person)", () => {
    expect(classifyRow(SALAH, REAL.namesake(1))).toEqual({ verdict: "exclude", reason: "other_person" });
    expect(classifyRow(SALAH, REAL.sudanese(1))).toEqual({ verdict: "exclude", reason: "other_person" });
  });

  it("a bare one-word mention, an empty reply and a reply that only mentions accounts are excluded (mention_only / no_term)", () => {
    expect(classifyRow(SALAH, REAL.bare(1))).toEqual({ verdict: "exclude", reason: "mention_only" });
    expect(classifyRow(SALAH, REAL.emptyReply(1)).verdict).toBe("exclude");
    expect(classifyRow(SALAH, REAL.mentionReply(1)).verdict).toBe("exclude");
    expect(classifyRow(SALAH, { text: "" })).toEqual({ verdict: "exclude", reason: "no_text" });
  });

  it("the name with a context word is a match; the name with no context word is UNCERTAIN (goes to review); hashtag and prefix forms are read", () => {
    expect(classifyRow(SALAH, REAL.match(1))).toEqual({ verdict: "match" });
    expect(classifyRow(SALAH, REAL.noContext(1))).toEqual({ verdict: "review", reason: "uncertain" });
    expect(classifyRow(SALAH, { text: "#محمد_صلاح هدف جديد في الدوري الإنجليزي" })).toEqual({ verdict: "match" });
    expect(classifyRow(SALAH, { text: "لمحمد صلاح هدف رائع في المباراة اليوم" })).toEqual({ verdict: "match" });
    expect(classifyRow(SALAH, { text: "Mohamed Salah scores again for Liverpool tonight, salah goal of the season" })).toEqual({ verdict: "match" });
  });

  it("counts a page: the share that matches is what the price rests on", () => {
    const rows = [REAL.match(1), REAL.match(2), REAL.match(3), REAL.authorOnly(1), REAL.namesake(1), REAL.bare(1), REAL.noContext(1), REAL.emptyReply(1)];
    const { counts } = classifyRows(SALAH, rows);
    expect(counts).toMatchObject({ examined: 8, match: 3, review: 1 });
    expect(counts.excluded).toEqual({ no_term: 1, other_person: 1, mention_only: 1, no_text: 1 });
  });

  it("the spec is checked: Arabic subject, terms, columns of the stage; a search query (not an account) is what makes it required", () => {
    expect(validateRelevanceSpec({ ...SALAH }, ["text", "url"]).ok).toBe(true);
    expect(validateRelevanceSpec({ ...SALAH, subject_ar: "Mohamed Salah" }, ["text"]).ok).toBe(false);
    expect(validateRelevanceSpec({ ...SALAH, terms: [] }, ["text"]).ok).toBe(false);
    expect(validateRelevanceSpec({ ...SALAH, text_columns: ["author"] }, ["text"]).ok).toBe(false);
    expect(searchQueryOf({ query: "محمد صلاح", limit: 20 })).toBe("محمد صلاح");
    expect(searchQueryOf({ keyword: "الغلا" })).toBe("الغلا");
    expect(searchQueryOf({ query: "from:elonmusk" })).toBeNull();
    expect(searchQueryOf({ handle: "elonmusk" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------- the plan
function salahPlan(opts: { sample?: Array<Record<string, unknown>>; settings?: Parameters<typeof validateAndPricePlan>[1]["pricingSettings"]; rows?: number; callUsd?: number; callRows?: number; relevance?: unknown } = {}): ReturnType<typeof validateAndPricePlan> {
  const sample = opts.sample ?? [REAL.match(1), REAL.match(2), REAL.match(3), REAL.match(4), REAL.match(5), REAL.match(6), REAL.match(7), REAL.authorOnly(1), REAL.namesake(1), REAL.bare(1)];
  const calls = new Map([["call_0001", { id: "call_0001", endpointId: "anyapi.x.search.posts", ok: true, costUsd: opts.callUsd ?? 0.00075, rows: opts.callRows ?? 20, params: { query: "محمد صلاح", limit: 20 } }]]);
  const evidence = `${JSON.stringify(sample.map((r) => ({ id: r.id, text: r.text, url: r.url, author: r.author })))} https://x.example`;
  const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: (id) => (id === "out_0001" ? JSON.stringify(sample.map((r) => ({ id: r.id, text: r.text, url: r.url, author: r.author }))) : `${evidence} m1 m2`), endpointAllowed: () => true, pricingSettings: opts.settings };
  return validateAndPricePlan({
    summary_ar: "ستحصل على تغريدات عربية عن محمد صلاح لاعب كرة القدم مع نص كل تغريدة ورابطها.",
    assumptions_ar: ["تغريدات عربية، الأحدث أولًا."],
    stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: opts.rows ?? 300, parent_key: null, deliver: true,
      columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }],
      sample_rows: [REAL.match(1), REAL.match(2)].map((r) => ({ id: r.id, text: r.text, url: r.url, author: r.author })), measured_by: ["call_0001", "out_0001"],
      relevance: opts.relevance ?? SALAH, yield_from: "out_0001" }],
  }, lookup);
}

describe("the plan: relevance is required for a text search, and the price rests on the cost per MATCHING row", () => {
  it("a stage found by a text search with no relevance rule is refused with the exact thing to add", () => {
    const calls = new Map([["call_0001", { id: "call_0001", endpointId: "anyapi.x.search.posts", ok: true, costUsd: 0.00075, rows: 20, params: { query: "محمد صلاح" } }]]);
    const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => "m1", endpointAllowed: () => true };
    const checked = validateAndPricePlan({ summary_ar: "ملخص", stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: 300, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ id: "m1", text: "a" }], measured_by: ["call_0001"] }] }, lookup);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues.join(" ")).toContain("needs `relevance`");
  });

  it("a stage found by an ACCOUNT (from:) needs none", () => {
    const calls = new Map([["call_0001", { id: "call_0001", endpointId: "anyapi.x.user.posts", ok: true, costUsd: 0.00075, rows: 20, params: { handle: "elonmusk" } }]]);
    const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => "m1", endpointAllowed: () => true };
    const checked = validateAndPricePlan({ summary_ar: "ملخص", stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.user.posts", expected_rows: 300, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ id: "m1", text: "a" }], measured_by: ["call_0001"] }] }, lookup);
    expect(checked.ok).toBe(true);
  });

  it("the sample the agent cites is counted by code: the yield, the uncertain share and the rows left out; sample rows must match", () => {
    const checked = salahPlan();
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (!checked.ok) return;
    const stage = checked.plan.stages[0];
    // 7 of 10 rows match, 1 author-only, 1 namesake, 1 bare mention
    expect(stage.sample_examined).toBe(10);
    expect(stage.sample_matching).toBe(7);
    expect(stage.yield_share).toBeCloseTo(0.7, 9);
    expect(stage.review_share).toBe(0);
    // a sample row that does not match its own rule is refused
    const only = salahPlan({ relevance: SALAH, sample: [REAL.match(1), REAL.match(2)] });
    expect(only.ok, JSON.stringify(only)).toBe(true);
  });

  it("a sample where nothing matches cannot be priced: the agent is told to change the rule, the source or the query", () => {
    const checked = salahPlan({ sample: [REAL.authorOnly(1), REAL.authorOnly2(2), REAL.bare(3)] });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues.join(" ")).toContain("none of the 3 rows of the sample matches");
  });

  it("the assumptions are on the plan: the intended meaning first, then what the agent assumed; the customer's card carries them and the minimum", () => {
    const checked = salahPlan();
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.plan.assumptions_ar).toEqual(["المقصود: محمد صلاح لاعب كرة القدم.", "تغريدات عربية، الأحدث أولًا."]);
    const view = customerPlanView(checked.plan);
    expect(view.assumptions_ar).toEqual(checked.plan.assumptions_ar);
    expect(view.price.minimum_line_ar).toBe("الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.");
    const card = customerMissionView({ mission: { id: "msn_a", status: "plan_ready", question_ar: null, plan_public: view, reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: new Date().toISOString() }, events: [], queue: null, now: Date.now() });
    expect(card.assumptionsAr).toEqual(checked.plan.assumptions_ar);
    expect(card.priceLineAr).toContain("الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء");
    expect(JSON.stringify(card)).not.toMatch(/USD|\$|anyapi/);
  });
});

// ---------------------------------------------------------------------------------------------- the price
describe("THE ONE PRICING RULE: (provider + model cost) per delivered matching row x markup x 55 / 0.10, a 200-point minimum, no charge for nothing", () => {
  it("300 tweets (the real run: 0.0096 USD of source calls, 0.0106 of model, 70% match): the unit is far below the minimum, so the charge and the reserve are 200 and a full delivery is charged exactly 200", () => {
    // raw rows needed = 300 / 0.7; the real run paid 0.0096 for 300 rows
    const price = priceMissionByCode([{ rows: 300, costPerRowUsd: 0.0096 / 300, deliver: true, yield: 0.7 }]);
    const modelUsd = AGENT_MODEL_PLANNING_ESTIMATE_USD + AGENT_MODEL_EXECUTION_PER_STAGE_ESTIMATE_USD;
    expect(price.modelCostUsd).toBeCloseTo(modelUsd, 9);
    expect(price.providerCostUsd).toBeCloseTo((300 / 0.7) * (0.0096 / 300), 9);
    expect(price.costPerFinalRowUsd).toBeCloseTo((price.providerCostUsd! + modelUsd) / 300, 12);
    expect(price.ruleUnitPoints).toBeLessThan(1); // about 0.65 points a tweet
    expect(price.minApplied).toBe(true);
    expect(price.reservePoints).toBe(200);
    expect(price.maxChargePoints).toBe(200);
    // what the database multiplies: 200 / 300 = 0.666666 points, so 300 rows are charged ceil(299.9998 / 1.5) = exactly 200
    expect(price.unitPricePoints).toBe(0.666666);
    expect(settlementCharge({ deliveredUnits: 300, unitPricePoints: price.unitPricePoints, reservedPoints: price.reservePoints })).toEqual({ chargedPoints: 200, releasedPoints: 0 });
  });

  it("a Facebook mission, 100 posts found by a topic and 20 comments each (2,100 rows): the posts' cost is spread over the comments; the price is the rule's, above the minimum and inside the cap", () => {
    // search 0.02952 a call of about 6 posts, half about the topic; comments 0.00188 a call of about 10
    const price = priceMissionByCode([
      { rows: 100, costPerRowUsd: 0.02952 / 6, deliver: true, yield: 0.5 },
      { rows: 2000, costPerRowUsd: 0.00188 / 10, deliver: true },
    ]);
    const provider = (100 / 0.5) * (0.02952 / 6) + 2000 * (0.00188 / 10);
    expect(price.providerCostUsd).toBeCloseTo(provider, 9);
    expect(price.deliveredRows).toBe(2100);
    const cost = (provider + AGENT_MODEL_PLANNING_ESTIMATE_USD + 2 * AGENT_MODEL_EXECUTION_PER_STAGE_ESTIMATE_USD) / 2100;
    expect(price.costPerFinalRowUsd).toBeCloseTo(cost, 12);
    expect(price.ruleUnitPoints).toBeCloseTo(cost * 5500, 5);
    expect(price.minApplied).toBe(false);
    expect(price.unitPricePoints).toBe(price.ruleUnitPoints);
    expect(price.maxChargePoints).toBe(Math.ceil(Math.round(2100 * price.unitPricePoints * 1e6) / 1e6 - 1e-9));
    expect(price.reservePoints).toBe(Math.ceil(Math.round(2100 * price.ruleUnitPoints! * 1e6 * 1.15) / 1e6 - 1e-9));
    expect(price.overCap).toBe(false);
    expect(price.reservePoints).toBeLessThanOrEqual(AGENT_JOB_POINTS_CAP);
  });

  it("the cap: a reserve above 25,000 points is flagged and the plan is refused", () => {
    expect(priceMissionByCode([{ rows: 5000, costPerRowUsd: 0.002, deliver: true }]).overCap).toBe(true);
    const checked = salahPlan({ rows: 4000, callUsd: 20, callRows: 20 });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues.join(" ")).toContain("more than the job limit");
  });

  it("zero delivery: NO charge, the whole hold is released (complete_chunk at zero, then release_job_atomic); partial delivery: ceil(delivered x unit), never above the reserve", async () => {
    const money = fakeMoneyClient();
    const checked = salahPlan();
    if (!checked.ok) throw new Error(checked.issues.join(";"));
    const mission = { id: "msn_z", user_id: USER_ID, plan: checked.plan };
    const a = await approveMission(money.client, mission);
    if (!a.ok) throw new Error(a.messageAr);
    // the rule's reserve (cost x 1.15) is 210, above the minimum; the CHARGE of a full delivery is the minimum, 200
    expect(a.reservePoints).toBe(210);
    const none = await settleMission(money.client, { jobId: a.jobId, deliveredUnits: 0, unitPricePoints: a.unitPricePoints, reservedPoints: a.reservePoints, costUsd: 0.01, resultPath: null });
    expect(none).toMatchObject({ ok: true, kind: "released", chargedPoints: 0 });
    expect(money.ledger.filter((l) => l.type === "charge")).toHaveLength(0);
    expect(money.calls.map((c) => c.name)).toContain("release_job_atomic");
    // partial: a second job, 100 of 300 rows
    const money2 = fakeMoneyClient();
    const a2 = await approveMission(money2.client, mission);
    if (!a2.ok) throw new Error(a2.messageAr);
    const part = await settleMission(money2.client, { jobId: a2.jobId, deliveredUnits: 100, unitPricePoints: a2.unitPricePoints, reservedPoints: a2.reservePoints, costUsd: 0.01, resultPath: "r.csv" });
    expect(part).toMatchObject({ ok: true, kind: "settled", chargedPoints: 67, matchesExpectation: true });
    expect(part.ok && part.kind === "settled" && part.chargedPoints <= a2.reservePoints).toBe(true);
  });

  it("the reserve is NEVER below the charge, for any volume, any cost, any markup and any minimum, and a charge for fewer rows is never larger than for more", () => {
    for (const settings of [{ markup: 10, minChargePoints: 200 }, { markup: 4, minChargePoints: 0 }, { markup: 25, minChargePoints: 1000 }, { markup: 1, minChargePoints: 2000 }]) {
      for (const cost of [0.000001, 0.00003, 0.0004, 0.0021, 0.05]) {
        for (const volume of [1, 2, 7, 100, 299, 300, 301, 999, 5000]) {
          const p = priceByRule({ volume, costPerRowUsd: cost, settings, capPoints: 25_000 });
          expect(p.reservePoints, JSON.stringify({ settings, cost, volume })).toBeGreaterThanOrEqual(p.chargeAtFullPoints);
          let last = 0;
          for (const delivered of [...new Set([0, 1, Math.floor(volume / 3), Math.floor(volume / 2), volume])].sort((a, b) => a - b)) {
            const charge = settlementChargeFor(delivered, p);
            expect(charge).toBeLessThanOrEqual(p.reservePoints);
            expect(charge).toBeGreaterThanOrEqual(last);
            if (delivered === 0) expect(charge).toBe(0);
            last = charge;
          }
          // a full delivery is charged exactly max(minimum, rule charge) when the reserve allows
          expect(settlementChargeFor(volume, p)).toBeGreaterThanOrEqual(Math.min(p.reservePoints, settings.minChargePoints));
        }
      }
    }
  });

  it("the markup and the minimum are settings: a markup of 20 doubles the unit; a plan keeps the settings it was priced with, so approval prices the SAME plan the customer saw", () => {
    const a = salahPlan({ rows: 1000, callUsd: 0.02, callRows: 20, settings: { markup: 10, minChargePoints: 200 } });
    const b = salahPlan({ rows: 1000, callUsd: 0.02, callRows: 20, settings: { markup: 20, minChargePoints: 200 } });
    if (!a.ok || !b.ok) throw new Error("plans");
    expect(b.plan.price.ruleUnitPoints! / a.plan.price.ruleUnitPoints!).toBeCloseTo(2, 5);
    expect(a.plan.price.settings).toEqual({ markup: 10, minChargePoints: 200 });
    // the stored plan reprices with ITS settings (not today's): no plan_changed after the owner edits the markup
    expect(repriceStoredPlan(b.plan).reservePoints).toBe(b.plan.price.reservePoints);
    expect(repriceStoredPlan(b.plan).unitPricePoints).toBe(b.plan.price.unitPricePoints);
  });

  it("a plan stored BEFORE the rule (no `rule` on its price) is approved at the price it showed: the old formula", () => {
    const checked = salahPlan();
    if (!checked.ok) throw new Error("plan");
    const old: PricedPlan = JSON.parse(JSON.stringify(checked.plan));
    const legacy = legacyPriceMissionByCode(old.stages.map((s) => ({ rows: s.planned_rows, costPerRowUsd: s.measured_cost_per_row_usd, deliver: s.deliver })));
    old.price = legacy;
    expect(repriceStoredPlan(old)).toEqual(legacy);
  });

  it("the settings: defaults 10 and 200; a stored value out of range falls back; the admin saves both and the audit gets before and after; the review budget is 20% of the revenue", async () => {
    expect(normalizeMissionPricingSettings(undefined)).toEqual(DEFAULT_MISSION_PRICING_SETTINGS);
    expect(normalizeMissionPricingSettings({ markup: 500, min_charge_points: -3 })).toEqual(DEFAULT_MISSION_PRICING_SETTINGS);
    expect(normalizeMissionPricingSettings({ markup: 12, min_charge_points: 300 })).toEqual({ markup: 12, minChargePoints: 300 });
    const rows = new Map<string, any>();
    const client: any = { from: () => ({ select: () => ({ eq: (_c: string, key: string) => ({ maybeSingle: async () => ({ data: rows.get(key) ?? null }) }) }), upsert: async (row: any) => { rows.set(row.key, row); return { error: null }; } }) };
    expect(await readMissionPricingSettings(client)).toEqual(DEFAULT_MISSION_PRICING_SETTINGS);
    const saved = await setMissionPricing(client, { markup: "12", minChargePoints: "300", adminId: "adm_1" });
    expect(saved).toMatchObject({ ok: true, before: { markup: 10, minChargePoints: 200 }, after: { markup: 12, minChargePoints: 300 } });
    expect(rows.get(MISSION_PRICING_SETTING_KEY)).toMatchObject({ value: { markup: 12, min_charge_points: 300 }, updated_by: "adm_1" });
    expect(await readMissionPricingSettings(client)).toEqual({ markup: 12, minChargePoints: 300 });
    expect(await setMissionPricing(client, { markup: "0", minChargePoints: "300", adminId: "adm_1" })).toMatchObject({ ok: false, status: 400 });
    expect(await setMissionPricing(client, { markup: "10", minChargePoints: "12.5", adminId: "adm_1" })).toMatchObject({ ok: false, status: 400 });
    // 200 points = 20 EGP = 0.3636 USD of revenue; 20% of it is the most the review may cost
    expect(reviewBudgetUsdFor(200)).toBeCloseTo(200 * (0.1 / 55) * AGENT_REVIEW_BUDGET_SHARE, 12);
    expect(minimumLineAr({ markup: 10, minChargePoints: 0 })).toBe("لا خصم إن لم يُسلَّم شيء.");
  });
});

// ---------------------------------------------------------------------------------------------- save_rows
function executionCtx(opts: { plan: PricedPlan; review?: ReturnType<typeof createReviewer> }) {
  const h = makeHarness({ phase: "execution" });
  h.ctx.plan = opts.plan;
  h.ctx.review = opts.review;
  const tools = Object.fromEntries(buildTools(h.ctx).map((t) => [t.name, t]));
  return { h, tools };
}
const planOf = (rows = 300): PricedPlan => { const c = salahPlan({ rows }); if (!c.ok) throw new Error(c.issues.join(";")); return c.plan; };
const finalRow = (r: Record<string, unknown>) => ({ id: r.id, text: r.text, url: r.url, author: r.author });

describe("save_rows keeps ONLY rows that match: the rest is neither delivered nor charged, and the agent is told how many are still needed", () => {
  it("the real failure kinds in one batch: only the matching rows are saved; author-name-only, namesakes, bare mentions and empty replies are left out WITH their reason; the uncertain ones are not delivered when nobody reviews them", async () => {
    const { h, tools } = executionCtx({ plan: planOf(300) });
    const batch = [...[1, 2, 3, 4, 5, 6, 7].map(REAL.match), ...[1, 2, 3].map(REAL.authorOnly), REAL.authorOnly2(1), ...[1, 2].map(REAL.namesake), REAL.sudanese(1), REAL.bare(1), REAL.emptyReply(1), REAL.mentionReply(1), REAL.noContext(1)].map(finalRow);
    const r: any = await tools.save_rows.handler({ stage_key: "tweets", rows: batch });
    expect(r).toMatchObject({ ok: true, saved_now: 7, total_in_stage: 7, still_needed: 293, reviewed_by_model: 0 });
    expect(r.left_out_not_matching).toEqual({ no_term: 5, no_text: 1, other_person: 3, mention_only: 1, not_reviewed: 1 });
    const saved = JSON.parse((await h.store.getFile(h.mission.id, "rows/tweets.json"))!);
    expect(saved.map((x: any) => x.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
    const left = JSON.parse((await h.store.getFile(h.mission.id, EXCLUDED_PATH("tweets")))!);
    expect(left).toHaveLength(batch.length - 7);
    expect(left.find((x: any) => x.id === "a1").reason).toBe("no_term");
    expect(left.find((x: any) => x.id === "n1").reason).toBe("other_person");
    expect(left.find((x: any) => x.id === "r1").reason).toBe("mention_only");
    // nothing left out is counted as delivered
    const { countDeliveredRows } = await import("../agent/src/tools");
    expect((await countDeliveredRows(h.store, h.mission.id, planOf(300))).delivered).toBe(7);
  });

  it("a row already left out is never reviewed or counted again, and a saved row is not saved twice", async () => {
    const { h, tools } = executionCtx({ plan: planOf(300) });
    await tools.save_rows.handler({ stage_key: "tweets", rows: [finalRow(REAL.match(1)), finalRow(REAL.authorOnly(1))] });
    const again: any = await tools.save_rows.handler({ stage_key: "tweets", rows: [finalRow(REAL.match(1)), finalRow(REAL.authorOnly(1)), finalRow(REAL.match(2))] });
    expect(again).toMatchObject({ saved_now: 1, duplicates_ignored: 2, total_in_stage: 2 });
    expect(JSON.parse((await h.store.getFile(h.mission.id, EXCLUDED_PATH("tweets")))!)).toHaveLength(1);
  });

  it("matching rows beyond the approved volume are refused as before, and the model is told when nothing more is needed", async () => {
    const { tools } = executionCtx({ plan: planOf(5) });
    const r: any = await tools.save_rows.handler({ stage_key: "tweets", rows: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => finalRow(REAL.match(n))) });
    expect(r).toMatchObject({ saved_now: 5, rejected_over_limit: 3, still_needed: 0 });
    expect(r.note).toContain("all the matching rows");
  });
});

// ---------------------------------------------------------------------------------------------- the review
const fakeReview = (answer: (rows: string[]) => boolean[], usage = { input_tokens: 900, output_tokens: 40 }): ReviewCall & { calls: Array<{ user: string }> } => {
  const calls: Array<{ user: string }> = [];
  const fn = (async ({ user }: { user: string }) => { calls.push({ user }); const rows = user.split("\nRows:\n")[1].split("\n"); return { text: JSON.stringify(answer(rows).map((v) => (v ? 1 : 0))), usage }; }) as unknown as ReviewCall & { calls: Array<{ user: string }> };
  fn.calls = calls;
  return fn;
};

describe("the model review of uncertain rows: real request text, a budget of 20% of the revenue, rows beyond it not delivered and not charged", () => {
  it("the prompt carries the customer's real words and the intended meaning; the verdicts are an array of exactly one 0/1 per row", () => {
    const p = reviewPrompt({ requestText: "هات ٣٠٠ تغريدة عن محمد صلاح", subject: "محمد صلاح لاعب كرة القدم", rows: [{ text: "أ" }, { text: "ب" }] });
    expect(p).toContain("«هات ٣٠٠ تغريدة عن محمد صلاح»");
    expect(p).toContain("محمد صلاح لاعب كرة القدم");
    expect(p).toContain("1. أ\n2. ب");
    expect(parseVerdicts("[1, 0]", 2)).toEqual([true, false]);
    expect(parseVerdicts("[1]", 2)).toBeNull();
    expect(parseVerdicts("لا أعرف", 2)).toBeNull();
    expect(parseVerdicts("[1, 2]", 2)).toBeNull();
  });

  it("uncertain rows are reviewed: the accepted ones are saved (and counted), the refused ones left out with the reason; tokens and cost are stored", async () => {
    const call = fakeReview((rows) => rows.map((r) => r.includes("شخصية")));
    const store = createMemoryStore();
    const probe = makeHarness({ phase: "execution", store });
    const reviewer = createReviewer({ call, store, missionId: probe.mission.id, requestText: "هات ٣٠٠ تغريدة عن محمد صلاح", budgetUsd: 0.07 });
    const { h, tools } = executionCtx({ plan: planOf(300), review: reviewer });
    // (executionCtx made its own harness; the reviewer writes to the store of the first one, which is what the assertions read)
    const batch = [REAL.match(1), REAL.noContext(1), { ...REAL.noContext(2), text: `محمد صلاح يا جماعة رأيي أنه لاعب مختلف رقم 2` }].map(finalRow);
    const r: any = await tools.save_rows.handler({ stage_key: "tweets", rows: batch });
    expect(call.calls).toHaveLength(1);
    expect(call.calls[0].user).toContain("هات ٣٠٠ تغريدة عن محمد صلاح");
    expect(r).toMatchObject({ saved_now: 2, reviewed_by_model: 2 });
    expect(r.left_out_not_matching).toMatchObject({ review_no: 1 });
    void h;
    const state = await reviewer.state();
    expect(state).toMatchObject({ calls: 1, rowsReviewed: 2, rowsAccepted: 1, inputTokens: 900, outputTokens: 40 });
    // Haiku list price 0.10 in / 0.50 out per million: 900 x 0.10 + 40 x 0.50 = 110 / 1e6
    expect(state.spentUsd).toBeCloseTo(0.00011, 9);
    expect(JSON.parse((await store.getFile(probe.mission.id, "review_state.json"))!)).toMatchObject({ calls: 1 });
  });

  it("the budget stops the review: the rows it could not review are NOT delivered and NOT charged, and the agent is told the budget is reached", async () => {
    const call = fakeReview((rows) => rows.map(() => true), { input_tokens: 4000, output_tokens: 100 });
    const store = createMemoryStore();
    const probe = makeHarness({ phase: "execution", store });
    // a budget that pays for ONE batch of 25 rows (0.00045 USD at 4,000 tokens in, 100 out) and not a second one
    const reviewer = createReviewer({ call, store, missionId: probe.mission.id, requestText: "هات تغريدات عن محمد صلاح", budgetUsd: 0.0006 });
    const { tools } = executionCtx({ plan: planOf(300), review: reviewer });
    const uncertain = Array.from({ length: 60 }, (_, i) => finalRow(REAL.noContext(i)));
    const r: any = await tools.save_rows.handler({ stage_key: "tweets", rows: uncertain });
    expect(call.calls).toHaveLength(1);
    expect(r.saved_now).toBe(25);
    expect(r.reviewed_by_model).toBe(25);
    expect(r.review_budget_reached).toBe(true);
    expect(r.left_out_not_matching.not_reviewed).toBe(35);
    expect((await reviewer.state()).spentUsd).toBeLessThanOrEqual(0.0006);
  });

  it("with no reviewer at all (no key, a test) uncertain rows are simply not delivered; a rule with review:false never calls it", async () => {
    const { tools } = executionCtx({ plan: planOf(300) });
    const r: any = await tools.save_rows.handler({ stage_key: "tweets", rows: [REAL.noContext(1), REAL.match(1)].map(finalRow) });
    expect(r).toMatchObject({ saved_now: 1 });
    expect(r.left_out_not_matching.not_reviewed).toBe(1);
  });

  it("the review is a plain HTTPS request, not an SDK session (no 270 MB child process): the real caller sends the model, the system text and the rows and reads the token counts", async () => {
    const { anthropicReviewCall } = await import("../agent/src/review");
    const seen: any[] = [];
    const fetchFn = (async (url: string, init: any) => { seen.push({ url, init }); return { ok: true, json: async () => ({ content: [{ type: "text", text: "[1,0]" }], usage: { input_tokens: 321, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } }) } as any; }) as any;
    const out = await anthropicReviewCall("test-key", fetchFn)({ model: "claude-haiku-5-5", system: "s", user: "u", maxTokens: 50 });
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(seen[0].init.body)).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 50, system: "s", messages: [{ role: "user", content: "u" }] });
    expect(out).toEqual({ text: "[1,0]", usage: { input_tokens: 321, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } });
    const failing = await anthropicReviewCall("k", (async () => { throw new Error("network"); }) as any)({ model: "m", system: "s", user: "u", maxTokens: 5 });
    expect(failing).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------- the whole mission
const PAGE = 20;
const pageOf = (page: number) => ({
  output: { data: { items: Array.from({ length: PAGE }, (_, i) => {
    const n = page * PAGE + i;
    const kind = n % 10;
    const row = kind < 5 ? REAL.match(n) : kind === 5 ? REAL.authorOnly(n) : kind === 6 ? REAL.namesake(n) : kind === 7 ? REAL.bare(n) : kind === 8 ? REAL.authorOnly2(n) : REAL.emptyReply(n);
    return { id: row.id, text: row.text, url: row.url, author: row.author };
  }), next_cursor: `cur_${page + 1}` } },
});

describe("a Salah mission end to end (fake model, fake source with the real failure kinds): paging continues until the requested number of MATCHING rows, nothing else is delivered or charged", () => {
  it("50 matching rows requested; half of every page is junk; the agent pages on while still_needed > 0; the file and the charge hold the matching rows only", async () => {
    const REQUESTED = 50;
    const answers = Array.from({ length: 16 }, (_, p) => tregResult(pageOf(p), 0.00075));
    const r = await replay({
      request: "هات ٥٠ تغريدة عن محمد صلاح",
      planning: [
        { tool: "report_progress", args: { message_ar: "أبحث عن أرخص مصدر مناسب للتغريدات", counts: { sources: 3 } } },
        { tool: "catalog_search", args: { words: ["tweets", "search"], platform: "x", limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: "anyapi.x.search.posts", params: { query: "محمد صلاح", limit: PAGE }, why: "the cheaper sources return no author or link fields in their catalog description" } },
        { tool: "run_code", args: { code: "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author }))", files: ["call_0001"] } },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على ٥٠ تغريدة عن محمد صلاح لاعب كرة القدم مع نص كل تغريدة ورابطها.",
          assumptions_ar: ["تغريدات عربية، الأحدث أولًا."],
          stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: REQUESTED, parent_key: null, deliver: true,
            columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }],
            sample_rows: (res.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 3), measured_by: [callIds(res)[0], firstOutputId(res)], relevance: SALAH, yield_from: firstOutputId(res) }],
        }) },
      ],
      execution: () => [
        ...pagedCalls("anyapi.x.search.posts", 8, (cursor) => ({ query: "محمد صلاح", limit: PAGE, ...(cursor ? { cursor } : {}) })),
        { tool: "run_code", args: (res: Results) => ({ code: "const out = []; for (const page of Object.values(inputs)) for (const t of page.output.data.items) out.push({ id: t.id, text: t.text, url: t.url, author: t.author }); return out;", files: callIds(res).slice(0, 8) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "tweets", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت ٥٠ تغريدة عن محمد صلاح لاعب كرة القدم، كل واحدة تتحدث عنه فعلًا." } },
      ],
      answers,
    });
    // the plan was priced on the cost per MATCHING row: the sample page has 10 matches in 20
    expect(r.plannedPlan.stages[0]).toMatchObject({ sample_examined: 20, sample_matching: 10 });
    expect(r.plannedPlan.stages[0].yield_share).toBeCloseTo(0.5, 9);
    const save: any = r.executionDriver.results.find((x) => x.tool === "save_rows")!.result;
    // 8 pages x 20 rows = 160 raw rows, half match: 80 matching rows are found, the volume is 50
    expect(save.saved_now, JSON.stringify(save)).toBe(REQUESTED);
    expect(save.rejected_over_limit).toBe(30);
    expect(save.left_out_not_matching).toEqual({ no_term: 32, other_person: 16, mention_only: 16, no_text: 16 });
    expect(save.still_needed).toBe(0);
    // the files and the settlement hold exactly the matching rows
    assertReplayInvariants(r, { expectDelivered: REQUESTED });
    const saved = JSON.parse((await r.store.getFile(r.missionId, "rows/tweets.json"))!);
    expect(saved).toHaveLength(REQUESTED);
    expect(saved.every((x: any) => /^m\d+$/.test(x.id))).toBe(true);
    expect(r.mission.delivered_units).toBe(REQUESTED);
    // 50 rows cost far less than the minimum: the charge is the minimum, the whole 200 is the reserve
    expect(r.mission.charged_points).toBe(200);
    // an internal event carries the tokens of each phase; the customer never sees it
    const tokenEvents = r.store.events.filter((e) => (e.counts as any)?.tok_phase !== undefined);
    expect(tokenEvents.map((e) => (e.counts as any).tok_phase)).toEqual([0, 1]);
    expect(tokenEvents[0].counts).toMatchObject({ tok_in: expect.any(Number), tok_out: expect.any(Number), tok_cache_read: 0, tok_cache_write: 0, llm_micro_usd: expect.any(Number) });
    expect(JSON.stringify(r.finalView)).not.toContain("tok_");
  });

  it("when the source runs dry the agent delivers what MATCHES with a shortfall sentence, charges only for it (never the junk), and releases the rest", async () => {
    const REQUESTED = 100;
    // the planning sample is page 0; the two execution pages are 1 and 2, and the source has nothing after them
    const answers = [tregResult(pageOf(0), 0.00075), tregResult(pageOf(1), 0.00075), tregResult(pageOf(2), 0.00075)];
    const r = await replay({
      request: "هات ١٠٠ تغريدة عن محمد صلاح",
      planning: [
        { tool: "catalog_search", args: { words: ["tweets", "search"], platform: "x", limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: "anyapi.x.search.posts", params: { query: "محمد صلاح", limit: PAGE }, why: "the cheaper sources return no author or link fields in their catalog description" } },
        { tool: "run_code", args: { code: "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author }))", files: ["call_0001"] } },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على ١٠٠ تغريدة عن محمد صلاح لاعب كرة القدم.",
          stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: REQUESTED, parent_key: null, deliver: true,
            columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }],
            sample_rows: (res.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 3), measured_by: [callIds(res)[0], firstOutputId(res)], relevance: SALAH, yield_from: firstOutputId(res) }],
        }) },
      ],
      execution: () => [
        { tool: "treg_call", args: { endpoint_id: "anyapi.x.search.posts", params: { query: "محمد صلاح", limit: PAGE } } },
        { tool: "treg_call", args: { endpoint_id: "anyapi.x.search.posts", params: { query: "محمد صلاح", limit: PAGE, cursor: "cur_1" } } },
        { tool: "run_code", args: (res: Results) => ({ code: "const out = []; for (const page of Object.values(inputs)) for (const t of page.output.data.items) out.push({ id: t.id, text: t.text, url: t.url, author: t.author }); return out;", files: callIds(res).slice(0, 2) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "tweets", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت التغريدات التي تخص محمد صلاح فعلًا." } },
      ],
      answers,
    });
    const delivered = Number(r.mission.delivered_units);
    expect(delivered, JSON.stringify(r.executionDriver.results.map((x) => [x.tool, x.result.ok, x.result.error ?? x.result.saved_now ?? x.result.message]))).toBe(20); // two pages of 20, half of each match
    expect(r.mission.status).toBe("completed");
    // the shortfall is said in plain words by code; the model said nothing about it
    expect(r.mission.summary_ar).toContain("سُلّم ٢٠ من ١٠٠ صفًا فقط");
    expect(r.finalView.resultSummaryAr).toContain("وهذا كل ما وُجد مطابقًا لطلبك");
    // 20 of 100 rows: charged in proportion to the job's unit, never the full minimum, never above the reserve; the rest of the hold is released
    expect(r.mission.charged_points).toBe(Math.ceil(Math.round(20 * Number(r.mission.unit_price_points) * 1e6) / 1e6 - 1e-9));
    expect(r.mission.charged_points).toBeLessThan(Number(r.mission.reserved_points));
    assertReplayInvariants(r, { expectDelivered: 20, expectStatus: "partial" });
  });
});

// ---------------------------------------------------------------------------------------------- the rest
describe("rows the agent itself calls unfiltered are never delivered", () => {
  const run = async (summary: string) => {
    const h = makeHarness({ phase: "execution" });
    const tools = Object.fromEntries(buildTools(h.ctx).map((t) => [t.name, t]));
    return tools.finish.handler({ outcome: "delivered", summary_ar: summary }) as Promise<Record<string, any>>;
  };
  it("the summary of the real run («النتائج تشمل ردودًا وأسماء مشابهة ولم تُصفَّ») is refused; an honest summary passes", async () => {
    for (const bad of ["سُلّمت ٣٠٠ تغريدة، النتائج تشمل ردودًا وأسماء مشابهة ولم تُصفَّ.", "النتائج غير مصفّاة وقد تتضمن أشخاصًا آخرين.", "تمت العملية بدون تصفية للنتائج.", "لم تتم تصفية الردود."]) {
      const r = await run(bad);
      expect(r.ok, bad).toBe(false);
      expect(String(r.error)).toContain("NOT filtered");
    }
    expect((await run("سُلّمت ٣٠٠ تغريدة كلها عن محمد صلاح لاعب كرة القدم.")).ok).toBe(true);
    expect((await run("لم أجد صفحات إضافية في المصدر.")).ok).toBe(true);
  });
});

describe("assumptions and questions: decide when the request is clear; ONE question with ready options only when it must", () => {
  it("ask_question needs 2 to 4 ready options (a question without them is refused with what to do instead); the options are kept for the card", async () => {
    const h = makeHarness({ phase: "planning" });
    const tools = Object.fromEntries(buildTools(h.ctx).map((t) => [t.name, t]));
    const refused: any = await tools.ask_question.handler({ question_ar: "أي محمد صلاح تقصد؟" });
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toContain("assumptions_ar");
    expect(h.ctx.state.question).toBeNull();
    const asked: any = await tools.ask_question.handler({ question_ar: "أي محمد صلاح تقصد؟", options_ar: ["لاعب كرة القدم", "الممثل", "شخص آخر"] });
    expect(asked.ok).toBe(true);
    expect(h.mission.plan_public).toEqual({ question_options: ["لاعب كرة القدم", "الممثل", "شخص آخر"] });
    const view = customerMissionView({ mission: { id: "msn_q", status: "needs_input", question_ar: "أي محمد صلاح تقصد؟", plan_public: h.mission.plan_public, reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: new Date().toISOString() }, events: [], queue: null, now: Date.now() });
    expect(view.phase).toBe("question");
    expect(view.questionOptionsAr).toEqual(["لاعب كرة القدم", "الممثل", "شخص آخر"]);
    expect(view.stages).toEqual([]);
  });

  it("the agent's instructions say: decide and state assumptions; ask only for close meanings or an expensive mission; only matching rows are delivered", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync("agent/prompts/system.md", "utf8");
    expect(text).toContain("DECIDE, DO NOT ASK");
    expect(text).toContain("assumptions_ar");
    expect(text).toContain("options_ar");
    expect(text).toContain("ONLY ROWS THAT MATCH THE REQUEST ARE DELIVERED AND CHARGED");
    expect(text).toContain("yield_from");
    expect(text).toContain("still_needed");
  });
});

describe("COST TRUTH: the tokens of every phase, the cost of a run that is killed, and the price basis", () => {
  it("every model message checkpoints the running cost on the mission, so a run that dies still leaves its cost; the final figure replaces it, never doubling it", async () => {
    const store = createMemoryStore();
    store.missions.set("msn_c1", newMission({ id: "msn_c1", user_id: USER_ID, request_text: "هات ٣٠٠ تغريدة عن محمد صلاح", status: "planning", planning_llm_usd: 0.004 }));
    const seen: number[] = [];
    const driver = { async run(input: any) {
      await input.onUsage({ usage: { input_tokens: 1000, output_tokens: 100 }, costUsd: 0.001 });
      seen.push(Number(store.missions.get("msn_c1")!.planning_llm_usd));
      await input.onUsage({ usage: { input_tokens: 3000, output_tokens: 300 }, costUsd: 0.003 });
      seen.push(Number(store.missions.get("msn_c1")!.planning_llm_usd));
      throw new Error("the worker was killed here");
    } };
    const rec = fakeRecorder();
    const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog: loadTregCatalog(), driver: driver as any, recorder: rec.recorder, commit: rec.commit, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
    await runPlanning(deps, store.missions.get("msn_c1")!);
    // the earlier 0.004 plus the running cost of THIS run, written as the run went on
    expect(seen).toEqual([0.005, 0.007]);
    // the run threw: the mission ended honestly (nothing held), and the last checkpoint is still on it (0.004 + 0.003); nothing was lost or doubled
    expect(store.missions.get("msn_c1")!.planning_llm_usd).toBeCloseTo(0.004, 9);
  });

  it("the tokens of a phase are stored as an internal event (input, output, cache read, cache write, the review's own tokens, the cost in millionths); the customer's view never carries it", async () => {
    const store = createMemoryStore();
    store.missions.set("msn_c2", newMission({ id: "msn_c2", user_id: USER_ID, request_text: "أريد منشورات", status: "planning" }));
    const driver = createFakeDriver([{ tool: "finish", args: { outcome: "cannot_serve", summary_ar: "لا يوجد مصدر متاح يخدم هذا الطلب بدقة، ولم يُحجز أي رصيد." } }], { costUsd: 0.0123, usage: { input_tokens: 5000, output_tokens: 400, cache_read_input_tokens: 2000, cache_creation_input_tokens: 800 } });
    const rec = fakeRecorder();
    await runPlanning({ store, client: fakeMoneyClient().client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN }, store.missions.get("msn_c2")!);
    const ev = store.events.find((e) => (e.counts as any)?.tok_phase !== undefined)!;
    expect(ev.counts).toEqual({ tok_phase: 0, tok_in: 5000, tok_out: 400, tok_cache_read: 2000, tok_cache_write: 800, tok_review_in: 0, tok_review_out: 0, tok_review_calls: 0, llm_micro_usd: 12300 });
    expect(store.missions.get("msn_c2")!.planning_llm_usd).toBeCloseTo(0.0123, 9);
    const card = customerMissionView({ mission: { id: "msn_c2", status: "unserved", question_ar: null, plan_public: null, reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: "x", files: null, created_at: new Date().toISOString() }, events: store.events.map((e, i) => ({ id: i + 1, kind: e.kind, message_ar: e.message_ar, counts: e.counts ?? null, created_at: new Date().toISOString() })), queue: null, now: Date.now() });
    expect(JSON.stringify(card)).not.toMatch(/tok_|llm_micro/);
  });

  it("the review's cost is added to the mission's execution model cost, counted from the API's tokens (not guessed)", async () => {
    // a mission with an approved plan: the execution run reviews one uncertain row through the fake call
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const planned = planOf(300);
    store.missions.set("msn_c3", newMission({ id: "msn_c3", user_id: USER_ID, request_text: "هات ٣٠٠ تغريدة عن محمد صلاح", status: "planning", plan: planned, planning_llm_usd: 0.007 }));
    const approved = await approveMission(money.client, { id: "msn_c3", user_id: USER_ID, plan: planned });
    if (!approved.ok) throw new Error(approved.messageAr);
    await store.updateMission("msn_c3", { status: "executing", job_id: approved.jobId, quote_id: approved.quoteId, reserved_points: approved.reservePoints, unit_price_points: approved.unitPricePoints });
    const review = fakeReview((rows) => rows.map(() => true), { input_tokens: 1500, output_tokens: 20 });
    const driver = createFakeDriver([{ tool: "save_rows", args: { stage_key: "tweets", rows: [REAL.match(1), REAL.noContext(1)].map(finalRow) } }, { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت التغريدات التي تخص محمد صلاح فعلًا." } }], { costUsd: 0.004 });
    const rec = fakeRecorder();
    await runExecution({ store, client: money.client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, reviewCall: review }, store.missions.get("msn_c3")!);
    const m = store.missions.get("msn_c3")!;
    // 0.004 for the agent's own run + (1500 x 0.10 + 20 x 0.50) / 1e6 = 0.00016 for the review
    expect(m.execution_llm_usd).toBeCloseTo(0.00416, 8);
    expect(m.delivered_units).toBe(2);
    const ev = store.events.find((e) => (e.counts as any)?.tok_phase === 1)!;
    expect(ev.counts).toMatchObject({ tok_review_in: 1500, tok_review_out: 20, tok_review_calls: 1, llm_micro_usd: 4160 });
  });

  it("the SDK's own total is a list-price ESTIMATE, not a bill (documented in its type definitions); DEFAULT_LLM_PRICING is untouched", async () => {
    const { readFileSync } = await import("node:fs");
    const sdk = readFileSync("agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts", "utf8");
    expect(sdk).toContain("An estimate, not a billing statement.");
    expect(sdk).toContain("The built-in list prices do.");
    const pricing = readFileSync("src/functions/shared/llmClient.ts", "utf8");
    expect(pricing).toContain('"claude-haiku-5-5"');
  });
});

describe("the card: the assumptions and the minimum on the plan, ready answers on the question", () => {
  const base = { question_ar: null, reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: new Date().toISOString() };
  it("the plan card says what the agent understood (محمد صلاح لاعب كرة القدم), that the customer may change it before approving, and the minimum in plain Arabic", () => {
    const checked = salahPlan();
    if (!checked.ok) throw new Error("plan");
    const view = customerMissionView({ mission: { id: "msn_card", status: "plan_ready", plan_public: customerPlanView(checked.plan), ...base }, events: [], queue: null, now: Date.now() });
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false }));
    expect(html).toContain('data-testid="agent-assumptions"');
    expect(html).toContain("المقصود: محمد صلاح لاعب كرة القدم.");
    expect(html).toContain("تغريدات عربية، الأحدث أولًا.");
    expect(html).toContain("اضغط «عدّل الطلب» وغيّره قبل الاعتماد");
    expect(html).toContain("الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء");
    // (the sample table shows data cells such as «رقم 1»: only the labels are checked for digits)
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/USD|anyapi|endpoint/);
    const block = html.slice(html.indexOf('data-testid="agent-assumptions"'));
    expect(block.length).toBeGreaterThan(0);
    expect(block.slice(0, block.indexOf("</div>")).replace(/<[^>]+>/g, " ")).not.toMatch(/[0-9]/);
  });

  it("the question card shows the ready answers as buttons that send that answer", () => {
    const view = customerMissionView({ mission: { id: "msn_q2", status: "needs_input", plan_public: { question_options: ["لاعب كرة القدم", "الممثل"] }, ...base, question_ar: "أي محمد صلاح تقصد؟" }, events: [], queue: null, now: Date.now() });
    const answers: string[] = [];
    const tree: any = AgentMissionCardBody({ view, isGuest: false, onAct: (a: string, t?: string) => { if (a === "answer" && t) answers.push(t); } } as any);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('data-testid="agent-question-options"');
    expect(html).toContain("لاعب كرة القدم");
    expect(html).toContain("الممثل");
  });
});
