import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { classifyRowDetailed, type RelevanceSpec } from "../src/lib/agentMission/relevance";
import { classOfField, columnsCover, uncoveredFields, usefulFieldsOfPage } from "../src/lib/agentMission/fields";
import { cairoText, isDateValues, parseMoment } from "../src/lib/agentMission/dateCells";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { customerPlanView, validateAndPricePlan, type PricedPlan, type PricedStage, type PlanLookup } from "../src/lib/agentMission/plan";
import { reviewBudgetUsdFor, reviewCeilingUsdFor } from "../src/lib/agentMission/price";
import { llmCostFromUsage } from "../agent/src/llmCost";
import { MODEL_HAIKU } from "../src/lib/agentMission/constants";
import { createReviewer, type ReviewCall } from "../agent/src/review";
import { createMemoryStore } from "../agent/src/memoryStore";
import { readChecks } from "../agent/src/checks";
import { buildExcludedAdminCsv, buildMissionFiles } from "../agent/src/workbook";
import { buildTools, EXCLUDED_PATH, withStageLock } from "../agent/src/tools";
import { makeHarness, tregResult } from "./helpers/agentHarness";
import { fbCommentsPage, fbPostsPage, igHashtagPage, mapsReviewsPage, ttCommentsPage, ttVideosPage, xPage } from "./helpers/agentFakeWorld";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

/**
 * THE GENERAL RULES OF CHECKING AND FILES, proved on more than one mission type with real row shapes (X posts, Facebook posts and their comments, TikTok videos and their comments, companies and their staff, Google Maps places
 * and their reviews, Instagram posts). Nothing here is special to a platform or to a name: the same code runs for every type.
 */
const specOf = (over: Partial<RelevanceSpec> & Pick<RelevanceSpec, "subject_ar" | "terms" | "text_columns">): RelevanceSpec => ({ ...over });

// ------------------------------------------------------------------------------------------------------- the rule, by evidence
describe("A. the rule accepts by evidence and sends only the genuinely ambiguous to the model (four mission types)", () => {
  it("X posts: the full name is enough (with or without a context word); a surname alone is not; the author's name, a bare mention, a namesake are left out", () => {
    const salah = specOf({ subject_ar: "محمد صلاح لاعب كرة القدم", terms: ["محمد صلاح", "Mohamed Salah"], context_terms: ["ليفربول", "هدف", "مباراة", "كرة"], exclude_terms: ["الشهيد"], text_columns: ["text"] });
    expect(classifyRowDetailed(salah, { text: "محمد صلاح يسجل هدفًا رائعًا مع ليفربول" })).toEqual({ verdict: "match", basis: "full_name_context" });
    // the live run's «unclear but relevant» tweets: the full name, no context word of the list
    expect(classifyRowDetailed(salah, { text: "شارع محمد صلاح في طرابزون يثير إعجاب الزوار والسياح كل يوم" })).toEqual({ verdict: "match", basis: "full_name" });
    expect(classifyRowDetailed(salah, { text: "إعلان فودافون الجديد مع محمد صلاح أعجب الجميع هذا الأسبوع" })).toEqual({ verdict: "match", basis: "full_name" });
    expect(classifyRowDetailed(salah, { text: "Mohamed Salah and the Ballon d'Or race this season for sure" })).toEqual({ verdict: "match", basis: "full_name" });
    expect(classifyRowDetailed(salah, { text: "رحم الله الشهيد محمد صلاح وأسكنه الجنة" })).toEqual({ verdict: "exclude", reason: "other_person" });
    expect(classifyRowDetailed(salah, { text: "محمد صلاح" })).toEqual({ verdict: "exclude", reason: "mention_only" });
    expect(classifyRowDetailed(salah, { text: "@MoSalah" })).toEqual({ verdict: "exclude", reason: "no_text" });
    expect(classifyRowDetailed(salah, { text: "صباح الخير يا جماعة ويسر الله أموركم", author: "صقر محمد صلاح صقر" })).toEqual({ verdict: "exclude", reason: "no_term" });
    // a surname alone is a WEAK term: with no context word it goes to the model
    const surname = specOf({ subject_ar: "اللاعب صلاح", terms: ["صلاح"], context_terms: ["هدف"], text_columns: ["text"] });
    expect(classifyRowDetailed(surname, { text: "أعتقد أن صلاح لاعب مختلف عن غيره تمامًا" })).toEqual({ verdict: "review", reason: "uncertain" });
    expect(classifyRowDetailed(surname, { text: "صلاح يسجل هدفا جميلا" })).toEqual({ verdict: "match", basis: "terms_context" });
  });

  it("the plan can say the full name is itself common: then a context word is required (the strict variant)", () => {
    const common = specOf({ subject_ar: "أحمد محمد المحامي", terms: ["أحمد محمد"], context_terms: ["محامي", "قضية"], text_columns: ["text"], full_name_is_enough: false });
    expect(classifyRowDetailed(common, { text: "أحمد محمد صديقي القديم من أيام المدرسة الابتدائية" })).toEqual({ verdict: "review", reason: "uncertain" });
    expect(classifyRowDetailed(common, { text: "أحمد محمد محامي ناجح في هذه القضية الكبيرة" })).toEqual({ verdict: "match", basis: "full_name_context" });
  });

  it("Facebook posts (message + author object): a campaign's full name is enough; a lone common word is not a term", () => {
    const campaign = specOf({ subject_ar: "حملة مصر الخير", terms: ["حملة مصر الخير", "مصر الخير"], context_terms: ["تبرع", "جمعية"], text_columns: ["message"] });
    const post = (message: string) => ({ id: "fp1", message, author: "صفحة 1" });
    expect(classifyRowDetailed(campaign, post("إطلاق حملة مصر الخير لدعم الأسر الأولى بالرعاية هذا الشهر"))).toEqual({ verdict: "match", basis: "full_name" });
    expect(classifyRowDetailed(campaign, post("تبرع الآن عبر مؤسسة مصر الخير لإطعام الأسر"))).toEqual({ verdict: "match", basis: "full_name_context" });
    expect(classifyRowDetailed(campaign, post("الخير في أمتي إلى يوم القيامة كما قال الصالحون"))).toEqual({ verdict: "exclude", reason: "no_term" });
  });

  it("companies (name, description, city read together): single-word activity terms need a context word, else they are reviewed", () => {
    const electro = specOf({ subject_ar: "شركات الكهروميكانيكا في مصر", terms: ["كهروميكانيكا", "electromechanical"], context_terms: ["مصر", "القاهرة", "الإسكندرية", "egypt"], text_columns: ["name", "description", "city"], min_own_words: 0 });
    expect(classifyRowDetailed(electro, { id: "co1", name: "النيل للتركيبات الكهروميكانيكا", description: "تركيبات ومقاولات", city: "القاهرة" })).toEqual({ verdict: "match", basis: "terms_context" });
    expect(classifyRowDetailed(electro, { id: "co2", name: "Delta Electromechanical Ltd", description: "contracting", city: "London" })).toEqual({ verdict: "review", reason: "uncertain" });
    expect(classifyRowDetailed(electro, { id: "co3", name: "مطعم الشرق", description: "مأكولات", city: "القاهرة" })).toEqual({ verdict: "exclude", reason: "no_term" });
  });

  it("Google Maps places (name + address): the place's full name is enough; reviews come through their parent place, never through a text rule", () => {
    const koshary = specOf({ subject_ar: "مطعم كشري التحرير", terms: ["كشري التحرير"], text_columns: ["name", "address"], min_own_words: 0 });
    expect(classifyRowDetailed(koshary, { id: "p1", name: "كشري التحرير", address: "شارع محمد محمود، القاهرة" })).toEqual({ verdict: "match", basis: "full_name" });
    expect(classifyRowDetailed(koshary, { id: "p2", name: "مطعم النيل", address: "ميدان التحرير، القاهرة" })).toEqual({ verdict: "exclude", reason: "no_term" });
  });

  it("a rule with no context words asks for none: any term hit with words of its own is a match (basis: terms only)", () => {
    const tag = specOf({ subject_ar: "رحلات الأقصر", terms: ["الأقصر"], text_columns: ["description"] });
    expect(classifyRowDetailed(tag, { description: "رحلة جميلة إلى الأقصر في الشتاء الماضي مع العائلة" })).toEqual({ verdict: "match", basis: "terms_only" });
  });
});

// ------------------------------------------------------------------------------------------------------- the tools
const colsOf = (keys: string[]) => keys.map((k) => ({ key: k, title_ar: k === "text" ? "نص التغريدة" : k }));
const stageOf = (over: Record<string, unknown>): PricedStage => ({ key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: 300, planned_rows: 300, parent_key: null, deliver: true, columns: colsOf(["text", "url", "author"]), sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001, ...over }) as PricedStage;
const planOfStages = (stages: PricedStage[], rows = 300): PricedPlan => ({ summary_ar: "ملخص", stages, price: { totalCostUsd: 0, deliveredRows: rows, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: 400, maxChargePoints: 300, overCap: false } } as PricedPlan);

const SALAH: RelevanceSpec = { subject_ar: "محمد صلاح لاعب كرة القدم", terms: ["محمد صلاح", "Mohamed Salah"], context_terms: ["ليفربول", "هدف", "مباراة", "كرة", "المنتخب"], exclude_terms: ["الشهيد"], text_columns: ["text"] };

/** The 400 raw rows of the live run of 2026-10-28, by KIND (the kinds the owner found in the file): 25 the rule leaves out, 40 with a context word, 335 with the full name and no context word. */
function liveRun(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 24; i += 1) rows.push({ id: `bare${i}`, text: i % 2 ? "محمد صلاح" : "@MoSalah", url: `https://x.example/s/bare${i}`, author: `u${i}` });
  rows.push({ id: "ns1", text: "رحم الله الشهيد محمد صلاح وأسكنه الجنة", url: "https://x.example/s/ns1", author: "u" });
  for (let i = 0; i < 40; i += 1) rows.push({ id: `ctx${i}`, text: `محمد صلاح يسجل هدفًا جديدًا مع ليفربول في المباراة رقم ${i}`, url: `https://x.example/s/ctx${i}`, author: `f${i}` });
  const unclear = ["شارع محمد صلاح في طرابزون يجذب الزوار", "إعلان فودافون الجديد مع محمد صلاح أعجب الناس", "جائزة عالمية جديدة وحظوظ محمد صلاح فيها", "ميسي ومحمد صلاح وهاري كين في قائمة واحدة", "محمد صلاح وصناعة الإعلانات في العالم العربي"];
  for (let i = 0; i < 335; i += 1) rows.push({ id: `unc${i}`, text: `${unclear[i % unclear.length]} رقم ${i}`, url: `https://x.example/s/unc${i}`, author: `g${i}` });
  return rows;
}

function executionOf(stages: PricedStage[], opts: { review?: ReturnType<typeof createReviewer>; rows?: number } = {}) {
  const h = makeHarness({ phase: "execution" });
  h.ctx.plan = planOfStages(stages, opts.rows ?? 300);
  h.ctx.review = opts.review;
  return { h, tools: Object.fromEntries(buildTools(h.ctx).map((t) => [t.name, t])) };
}
const fakeReview = (answer: (rows: string[]) => boolean[], usage = { input_tokens: 2100, output_tokens: 110 }): ReviewCall & { calls: number } => {
  const fn = (async ({ user }: { user: string }) => { fn.calls += 1; return { text: JSON.stringify(answer(user.split("\nRows:\n")[1].split("\n")).map((v) => (v ? 1 : 0))), usage }; }) as unknown as ReviewCall & { calls: number };
  fn.calls = 0;
  return fn;
};

describe("A. replay of the live run: many unclear-but-relevant items and a small review budget", () => {
  it("clearly relevant items are accepted BY RULE and none is thrown away: 300 saved, the model is not even asked, and the report says how each item was decided", async () => {
    const call = fakeReview((rows) => rows.map(() => true));
    const store = createMemoryStore();
    const probe = makeHarness({ phase: "execution", store });
    // a review budget that pays for ONE batch only (the live run's budget was 0.0884 and it still ended: here it is smaller still)
    const reviewer = createReviewer({ call, store, missionId: probe.mission.id, requestText: "هات ٣٠٠ تغريدة عن محمد صلاح", budgetUsd: 0.0005 });
    const { h, tools } = executionOf([stageOf({ relevance: SALAH })], { review: reviewer });
    const all = liveRun();
    const first: any = await tools.save_rows.handler({ stage_key: "tweets", rows: all.slice(0, 200) });
    const second: any = await tools.save_rows.handler({ stage_key: "tweets", rows: all.slice(200) });
    expect(first.saved_now + second.saved_now).toBe(300);
    expect(second.still_needed).toBe(0);
    expect(call.calls).toBe(0);
    expect(first.reviewed_by_model + second.reviewed_by_model).toBe(0);
    const checks = (await readChecks(h.store, h.mission.id)).tweets;
    // by rule: the 40 with a context word and the full-name ones that fill the rest; by model: none; excluded: the 25 the rule leaves out, per reason
    expect(checks.accepted_by_rule).toBe(300);
    expect(checks.accepted_by_model).toBe(0);
    expect(checks.accepted_by_rule_basis.full_name_context! + checks.accepted_by_rule_basis.full_name!).toBe(300);
    expect(checks.accepted_by_rule_basis.full_name!).toBeGreaterThan(200);
    expect(checks.excluded).toEqual({ mention_only: 12, no_text: 12, other_person: 1 });
    expect(checks.examined).toBeGreaterThanOrEqual(300);
    const saved = JSON.parse((await h.store.getFile(h.mission.id, "rows/tweets.json"))!);
    expect(saved).toHaveLength(300);
    // the delivered rows contain the unclear-but-relevant tweets (the Trabzon street, the advert, the prize race), not only the context ones
    expect(saved.some((r: any) => String(r.text).includes("طرابزون"))).toBe(true);
    expect(saved.some((r: any) => String(r.text).includes("جائزة عالمية"))).toBe(true);
    // nothing left out is a good row: every excluded item is one of the 25 the rule has a reason for
    const left = JSON.parse((await h.store.getFile(h.mission.id, EXCLUDED_PATH("tweets")))!);
    expect(left).toHaveLength(25);
    expect(new Set(left.map((x: any) => x.reason))).toEqual(new Set(["mention_only", "no_text", "other_person"]));
  });

  it("the STRICT variant (the full name is itself common): the budget never throws good rows away: the usual budget ends, the review goes on up to the ceiling, the rows it did not reach stay pending, and nothing is silently lost", async () => {
    const call = fakeReview((rows) => rows.map(() => true), { input_tokens: 4000, output_tokens: 100 });
    const store = createMemoryStore();
    const probe = makeHarness({ phase: "execution", store });
    // the usual budget pays for one batch (0.00045 USD at 4,000 in / 100 out); the ceiling for three
    const reviewer = createReviewer({ call, store, missionId: probe.mission.id, requestText: "هات ٣٠٠ تغريدة عن محمد صلاح", budgetUsd: 0.0006, ceilingUsd: 0.0012 });
    const { h, tools } = executionOf([stageOf({ relevance: { ...SALAH, full_name_is_enough: false } })], { review: reviewer });
    const unclear = liveRun().filter((r) => String(r.id).startsWith("unc")).slice(0, 150);
    const r1: any = await tools.save_rows.handler({ stage_key: "tweets", rows: unclear });
    // the usual budget pays for one batch of 25; the ceiling for the next ones (3 batches = 75 rows reviewed); the other 75 stay pending, NONE is excluded for the budget
    expect(call.calls).toBe(3);
    expect(r1.reviewed_by_model).toBe(75);
    expect(r1.saved_now).toBe(75);
    expect(r1.review_budget_reached).toBe(true);
    expect(r1.pending_for_review).toBe(75);
    expect(r1.left_out_not_matching.not_reviewed).toBeUndefined();
    expect((await reviewer.state()).extended).toBe(true);
    const left = JSON.parse((await h.store.getFile(h.mission.id, EXCLUDED_PATH("tweets")))!);
    expect(left.filter((x: any) => x.reason === "not_reviewed")).toHaveLength(75);
    // the report: accepted by model 75, pending is not an exclusion
    const checks = (await readChecks(h.store, h.mission.id)).tweets;
    expect(checks).toMatchObject({ accepted_by_rule: 0, accepted_by_model: 75, excluded: {} });
  });

  it("pending items come back: when the model could not be reached the rows stay pending (not excluded, reason: failed call), and the next save asks again and delivers them", async () => {
    let down = true;
    const call = (async ({ user }: { user: string }) => {
      if (down) return null;
      return { text: JSON.stringify(user.split("\nRows:\n")[1].split("\n").map(() => 1)), usage: { input_tokens: 900, output_tokens: 40 } };
    }) as ReviewCall;
    const store = createMemoryStore();
    const probe = makeHarness({ phase: "execution", store });
    const reviewer = createReviewer({ call, store, missionId: probe.mission.id, requestText: "طلب", budgetUsd: 0.05 });
    const { h, tools } = executionOf([stageOf({ relevance: { ...SALAH, full_name_is_enough: false } })], { review: reviewer });
    const rows = liveRun().filter((r) => String(r.id).startsWith("unc")).slice(0, 30);
    const r1: any = await tools.save_rows.handler({ stage_key: "tweets", rows });
    expect(r1).toMatchObject({ saved_now: 0, review_failed: true, pending_for_review: 30 });
    expect(r1.left_out_not_matching).toEqual({});
    const left1 = JSON.parse((await h.store.getFile(h.mission.id, EXCLUDED_PATH("tweets")))!);
    expect(left1.every((x: any) => x.reason === "review_failed")).toBe(true);
    expect((await reviewer.state()).failedCalls).toBe(2); // the call and its one retry
    down = false;
    // the next save (even with no new rows) asks again: the 30 pending rows are reviewed and saved
    const r2: any = await tools.save_rows.handler({ stage_key: "tweets", rows: [] });
    expect(r2).toMatchObject({ saved_now: 30, pending_for_review: 0 });
    expect(JSON.parse((await h.store.getFile(h.mission.id, "rows/tweets.json"))!)).toHaveLength(30);
  });

  it("an answer that is not one 0/1 per row is asked once more; two bad answers leave the rows pending, not excluded", async () => {
    let n = 0;
    const call = (async ({ user }: { user: string }) => {
      n += 1;
      const rows = user.split("\nRows:\n")[1].split("\n");
      return { text: n === 1 ? "[1]" : JSON.stringify(rows.map(() => 1)), usage: { input_tokens: 500, output_tokens: 30 } };
    }) as ReviewCall;
    const store = createMemoryStore();
    const probe = makeHarness({ phase: "execution", store });
    const reviewer = createReviewer({ call, store, missionId: probe.mission.id, requestText: "طلب", budgetUsd: 0.05 });
    const { tools } = executionOf([stageOf({ relevance: { ...SALAH, full_name_is_enough: false } })], { review: reviewer });
    const r: any = await tools.save_rows.handler({ stage_key: "tweets", rows: liveRun().filter((x) => String(x.id).startsWith("unc")).slice(0, 10) });
    expect(r).toMatchObject({ saved_now: 10, reviewed_by_model: 10 });
    expect((await reviewer.state()).failedCalls).toBe(1);
  });

  it("finish asks the pending rows once more (within the ceiling) before the mission ends", async () => {
    const call = fakeReview((rows) => rows.map(() => true), { input_tokens: 4000, output_tokens: 100 });
    const store = createMemoryStore();
    const probe = makeHarness({ phase: "execution", store });
    const reviewer = createReviewer({ call, store, missionId: probe.mission.id, requestText: "طلب", budgetUsd: 0.0006 });
    const { h, tools } = executionOf([stageOf({ relevance: { ...SALAH, full_name_is_enough: false } })], { review: reviewer });
    await tools.save_rows.handler({ stage_key: "tweets", rows: liveRun().filter((x) => String(x.id).startsWith("unc")).slice(0, 60) });
    expect((await reviewer.state()).stop).toBe("budget");
    // the budget is what it is: the finish asks again, the budget still refuses, and the rows stay pending (no loss, an honest shortfall)
    const done: any = await tools.finish.handler({ outcome: "delivered", summary_ar: "سُلّمت التغريدات التي تخص محمد صلاح." });
    expect(done.ok).toBe(true);
    expect(JSON.parse((await h.store.getFile(h.mission.id, "rows/tweets.json"))!)).toHaveLength(25);
    expect(JSON.parse((await h.store.getFile(h.mission.id, EXCLUDED_PATH("tweets")))!).filter((x: any) => x.reason === "not_reviewed")).toHaveLength(35);
  });
});

describe("A. the review's cost basis, from the real tokens of the live run (the root cause with numbers)", () => {
  it("11 calls, 23,266 input and 1,192 output tokens cost 0.0029 USD at the Haiku list price, 3.3% of the 0.0884 USD budget: the budget did NOT run out, and the old 0.80 / 4.00 table would not have exhausted it either (26%)", () => {
    const usage = { input_tokens: 23_266, output_tokens: 1_192 };
    const list = llmCostFromUsage(MODEL_HAIKU, usage);
    expect(list).toBeCloseTo(0.0029, 4);
    const budget = reviewBudgetUsdFor(243);
    expect(budget).toBeCloseTo(0.0884, 4);
    expect(list / budget).toBeLessThan(0.04);
    const oldTable = (usage.input_tokens * 0.8 + usage.output_tokens * 4) / 1e6;
    expect(oldTable / budget).toBeLessThan(0.3);
    // per call: 11 calls of about 2,115 input tokens = 25 rows each; at the budget a mission of this price could review thousands of rows
    expect(usage.input_tokens / 11).toBeCloseTo(2115, 0);
    expect(Math.floor(budget / (list / 11)) * 25).toBeGreaterThan(5000);
    // the ceiling (40% of the reserve's value) is above the usual budget
    expect(reviewCeilingUsdFor(279)).toBeGreaterThan(reviewBudgetUsdFor(243));
  });
});

describe("one writer per stage: two saves at once never erase each other (the live run saved 300 and delivered 250)", () => {
  it("two parallel save_rows calls, one of them slow (a review), keep every row of both", async () => {
    const slow = (async ({ user }: { user: string }) => { await new Promise((r) => setTimeout(r, 30)); return { text: JSON.stringify(user.split("\nRows:\n")[1].split("\n").map(() => 1)), usage: { input_tokens: 500, output_tokens: 30 } }; }) as ReviewCall;
    const store = createMemoryStore();
    const probe = makeHarness({ phase: "execution", store });
    const reviewer = createReviewer({ call: slow, store, missionId: probe.mission.id, requestText: "طلب", budgetUsd: 0.05 });
    const { h, tools } = executionOf([stageOf({ relevance: { ...SALAH, full_name_is_enough: false } })], { review: reviewer });
    const unclear = liveRun().filter((x) => String(x.id).startsWith("unc"));
    const withContext = liveRun().filter((x) => String(x.id).startsWith("ctx"));
    const results = await Promise.all([
      tools.save_rows.handler({ stage_key: "tweets", rows: unclear.slice(0, 20) }),
      tools.save_rows.handler({ stage_key: "tweets", rows: withContext.slice(0, 20) }),
      tools.save_rows.handler({ stage_key: "tweets", rows: [] }),
    ]);
    expect(results.every((r: any) => r.ok)).toBe(true);
    const saved = JSON.parse((await h.store.getFile(h.mission.id, "rows/tweets.json"))!);
    expect(saved).toHaveLength(40);
    expect(new Set(saved.map((r: any) => r.id)).size).toBe(40);
  });

  it("the lock runs the calls of one key in order and lets other keys go side by side", async () => {
    const order: string[] = [];
    await Promise.all([
      withStageLock("m:a", async () => { order.push("a1-start"); await new Promise((r) => setTimeout(r, 20)); order.push("a1-end"); }),
      withStageLock("m:a", async () => { order.push("a2"); }),
      withStageLock("m:b", async () => { order.push("b"); }),
    ]);
    expect(order.indexOf("a1-end")).toBeLessThan(order.indexOf("a2"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a1-end"));
  });
});

// ------------------------------------------------------------------------------------------------------- collect resume
describe("collect_pages resumes a source instead of buying its first pages again", () => {
  const ENDPOINT = "anyapi.x.search.posts";
  const pages = (n: number, per = 20) => Array.from({ length: n }, (_, i) => tregResult(xPage("موضوع", i * per, per, i + 1 < n ? `cur_${(i + 1) * per}` : null), 0.00075));

  it("the second call with the same inputs continues from the stored cursor and returns only new rows; counts are cumulative; an ended source says so for free", async () => {
    const h = makeHarness({ phase: "execution", budgetUsd: 0.05, responses: pages(10) });
    const tools = Object.fromEntries(buildTools(h.ctx).map((t) => [t.name, t]));
    const a: any = await tools.collect_pages.handler({ endpoint_id: ENDPOINT, params: { query: "موضوع", limit: 20 }, target_rows: 100 });
    expect(a).toMatchObject({ ok: true, pages: 5, unique_rows: 100, pages_in_all: 5 });
    const b: any = await tools.collect_pages.handler({ endpoint_id: ENDPOINT, params: { query: "موضوع", limit: 20 }, target_rows: 100 });
    expect(b).toMatchObject({ ok: true, pages: 5, unique_rows: 100, pages_in_all: 10, unique_in_all: 200, resumed_from_page: 6, stopped_because: "target_reached" });
    // the second call carried the cursor of the first call's last answer, never the first page again
    expect(h.call.mock.calls[5][0].params.cursor).toBe("cur_100");
    expect(h.call).toHaveBeenCalledTimes(10);
    const outB = JSON.parse((await h.store.getFile(h.mission.id, `out/${b.output_id}.json`))!);
    expect(outB[0].id).toBe("18000100");
    // the counts the panel reads only grow: pages 1..5 then 6..10, rows 20..100 then 120..200
    const events = h.store.events.filter((e) => e.counts?.pages).map((e) => e.counts as Record<string, number>);
    expect(events.map((c) => c.pages)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(events.map((c) => c.rows)).toEqual([20, 40, 60, 80, 100, 120, 140, 160, 180, 200]);
  });

  it("a source that ended is not asked again", async () => {
    const h = makeHarness({ phase: "execution", budgetUsd: 0.05, responses: pages(2) });
    const tools = Object.fromEntries(buildTools(h.ctx).map((t) => [t.name, t]));
    const a: any = await tools.collect_pages.handler({ endpoint_id: ENDPOINT, params: { query: "موضوع", limit: 20 }, target_rows: 500 });
    expect(a).toMatchObject({ ok: true, stopped_because: "source_ended", unique_in_all: 40 });
    const again: any = await tools.collect_pages.handler({ endpoint_id: ENDPOINT, params: { query: "موضوع", limit: 20 }, target_rows: 500 });
    expect(again).toMatchObject({ ok: false, exhausted: true });
    expect(h.call).toHaveBeenCalledTimes(2);
  });

  it("different inputs are a different source: they start from the first page", async () => {
    const h = makeHarness({ phase: "execution", budgetUsd: 0.05, responses: [...pages(2), ...pages(2)] });
    const tools = Object.fromEntries(buildTools(h.ctx).map((t) => [t.name, t]));
    await tools.collect_pages.handler({ endpoint_id: ENDPOINT, params: { query: "موضوع", limit: 20 }, target_rows: 40 });
    const other: any = await tools.collect_pages.handler({ endpoint_id: ENDPOINT, params: { query: "موضوع آخر", limit: 20 }, target_rows: 40 });
    expect(other).toMatchObject({ ok: true, pages: 2 });
    expect(other.resumed_from_page).toBeUndefined();
    expect(h.call.mock.calls[2][0].params.cursor).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------------- useful fields
describe("B. every useful field of the source keeps a column (X, Facebook, TikTok, Maps, Instagram)", () => {
  const fieldsOf = (page: unknown) => usefulFieldsOfPage(JSON.stringify(page)).map((f) => f.cls).sort();

  it("the fields are found by the SHAPE of the values, for every source type", () => {
    expect(fieldsOf(xPage("موضوع", 0, 3, null))).toEqual(["author", "date", "link"].filter((c) => c !== "author").sort());
    expect(fieldsOf(fbPostsPage("موضوع", 0, 3, null))).toEqual(["author", "comment", "date", "like", "link"].sort());
    expect(fieldsOf(ttVideosPage("موضوع", 3))).toEqual(["author", "comment", "date", "like", "link", "share", "view"].filter((c) => c !== "author").sort());
    expect(fieldsOf(igHashtagPage("قهوة", 0, 3, null))).toEqual(["comment", "date", "like"].sort());
    expect(fieldsOf(mapsReviewsPage(0, 3, null))).toEqual(["author", "date", "like", "rating"].sort());
    expect(fieldsOf(fbCommentsPage("p1", 3))).toEqual(["date"]);
    expect(fieldsOf(ttCommentsPage("v1", 3))).toEqual(["date", "like"].sort());
  });

  it("images, avatars, durations and ids are not fields the customer asks for", () => {
    expect(classOfField("user.profile_image_url", "https://x.example/a.png")).toBeNull();
    expect(classOfField("duration", 3600)).toBeNull();
    expect(classOfField("id", "18000000")).toBeNull();
    expect(classOfField("permalink", "https://x.example/s/1")).toBe("link");
    expect(classOfField("created_at", "2026-10-20T10:00:00Z")).toBe("date");
    expect(classOfField("createTime", 1785202291)).toBe("date");
    expect(classOfField("stats.diggCount", 12)).toBe("like");
  });

  it("a column covers a field by its Arabic title or its key", () => {
    const cols = [{ key: "text", title_ar: "نص التغريدة" }, { key: "when", title_ar: "التاريخ والوقت" }, { key: "likes", title_ar: "إعجابات" }, { key: "n", title_ar: "عدد الردود" }];
    expect(columnsCover("date", cols)).toBe(true);
    expect(columnsCover("like", cols)).toBe(true);
    expect(columnsCover("reply", cols)).toBe(true);
    expect(columnsCover("view", cols)).toBe(false);
    expect(uncoveredFields([{ cls: "view", path: "stats.views" }, { cls: "date", path: "created_at" }], cols)).toEqual([{ cls: "view", path: "stats.views" }]);
  });

  const lookupFor = (page: unknown, endpointId: string): PlanLookup => {
    const text = JSON.stringify(page);
    return { call: (id) => (id === "call_0001" ? { id, endpointId, ok: true, costUsd: 0.00075, rows: 20, params: { id: "x" } } : null), evidenceText: (id) => (id === "call_0001" ? text : null), endpointAllowed: () => true };
  };
  const proposal = (endpointId: string, columns: Array<{ key: string; title_ar: string }>, sample: Record<string, unknown>) => ({ summary_ar: "ملخص", stages: [{ key: "s", title_ar: "العناصر", endpoint_id: endpointId, expected_rows: 20, parent_key: null, deliver: true, columns, sample_rows: [sample], measured_by: ["call_0001"] }] });

  it.each([
    ["Facebook posts", "justoneapi.x.facebook-search-post-v1", fbPostsPage("موضوع", 0, 20, null), [{ key: "text", title_ar: "نص المنشور" }, { key: "url", title_ar: "رابط المنشور" }], ["التاريخ والوقت", "التعليقات", "الإعجابات", "الكاتب"]],
    ["TikTok videos", "crawl4ai.tiktok.search.videos", ttVideosPage("موضوع", 20), [{ key: "text", title_ar: "وصف الفيديو" }, { key: "url", title_ar: "رابط الفيديو" }], ["الإعجابات", "المشاركات", "المشاهدات", "التاريخ والوقت", "التعليقات"]],
    ["Google Maps reviews", "litescrape.google.maps.reviews", mapsReviewsPage(0, 20, null), [{ key: "text", title_ar: "نص التقييم" }, { key: "rating", title_ar: "الدرجة" }], ["الكاتب", "التاريخ والوقت", "الإعجابات"]],
    ["X posts", "anyapi.x.search.posts", xPage("موضوع", 0, 20, null), [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }], ["التاريخ والوقت"]],
  ])("%s: a plan that leaves a useful field out is refused naming it; the same plan with the columns is accepted", (_name, endpoint, page, baseColumns, needed) => {
    const bad = validateAndPricePlan(proposal(endpoint, baseColumns, { text: "عينة" }), lookupFor(page, endpoint));
    expect(bad.ok).toBe(false);
    if (!bad.ok) { const text = bad.issues.join(" "); for (const n of needed) expect(text).toContain(n); }
    const good = validateAndPricePlan(proposal(endpoint, [...baseColumns, ...needed.map((n, i) => ({ key: `f${i}`, title_ar: n }))], { text: "عينة" }), lookupFor(page, endpoint));
    expect(good.ok, good.ok ? "" : good.issues.join(" | ")).toBe(true);
  });
});

describe("B. dates in the files are readable, in Cairo time, and sort as dates", () => {
  it("moments are read from ISO, long English dates and epoch seconds or milliseconds; texts that only look like numbers are left alone", () => {
    expect(cairoText(parseMoment("2026-10-28T20:06:00Z")!)).toBe("2026-10-28 23:06");
    expect(cairoText(parseMoment("Wed Oct 28 20:06:00 +0000 2026")!)).toBe("2026-10-28 23:06");
    expect(cairoText(parseMoment(1793217960)!)).toBe("2026-10-28 23:06");
    expect(cairoText(parseMoment(1793217960000)!)).toBe("2026-10-28 23:06");
    expect(parseMoment("محمد صلاح")).toBeNull();
    expect(parseMoment(12)).toBeNull();
    expect(isDateValues("التاريخ والوقت", "date", ["2026-10-28T20:06:00Z", ""])).toBe(true);
    expect(isDateValues("نص", "text", ["2026-10-28T20:06:00Z"])).toBe(false);
    expect(isDateValues("التاريخ", "date", ["ليس تاريخًا"])).toBe(false);
  });

  const colsFor = (cols: Array<[string, string]>) => cols.map(([key, title_ar]) => ({ key, title_ar }));
  const load = async (xlsx: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as unknown as ArrayBuffer); return wb; };

  it.each([
    ["X posts", "tweets", "التغريدات", [["text", "نص التغريدة"], ["created", "التاريخ والوقت"], ["author", "الحساب"]] as Array<[string, string]>, { id: "1", text: "محمد صلاح", created: "2026-10-28T20:06:00Z", author: "a" }],
    ["Facebook posts", "posts", "المنشورات", [["text", "نص المنشور"], ["timestamp", "تاريخ النشر"], ["comments_count", "عدد التعليقات"]] as Array<[string, string]>, { id: "1", text: "منشور", timestamp: 1793217960, comments_count: "41" }],
    ["TikTok comments", "comments", "التعليقات", [["text", "نص التعليق"], ["created_at", "وقت التعليق"], ["likes", "الإعجابات"]] as Array<[string, string]>, { id: "1", text: "تعليق", created_at: "Wed Oct 28 20:06:00 +0000 2026", likes: "3" }],
    ["Maps reviews", "reviews", "التقييمات", [["text", "نص التقييم"], ["iso_date", "التاريخ"], ["rating", "الدرجة"]] as Array<[string, string]>, { id: "1", text: "ممتاز", iso_date: "2026-10-28T20:06:00Z", rating: "5" }],
  ])("%s: the date column is a real spreadsheet date shown as year-month-day hour:minute in Cairo time; the CSV has the same moment as plain text; ids last", async (_n, key, title, cols, row) => {
    const plan = planOfStages([stageOf({ key, title_ar: title, columns: colsFor(cols) })], 1);
    const built = await buildMissionFiles(plan, { [key]: [row] });
    const wb = await load(built.xlsx);
    const sheet = wb.getWorksheet(title)!;
    const dateCol = cols.findIndex(([k]) => /created|timestamp|date/.test(k)) + 1;
    const cell = sheet.getRow(2).getCell(dateCol);
    expect(cell.value instanceof Date).toBe(true);
    expect(cell.numFmt).toBe("yyyy-mm-dd hh:mm");
    expect((cell.value as Date).toISOString()).toBe("2026-10-28T23:06:00.000Z");
    expect(built.csv).toContain("2026-10-28 23:06");
    expect((sheet.getRow(1).values as unknown[]).slice(1).pop()).toBe("المعرّف");
  });
});

// ------------------------------------------------------------------------------------------------------- B. files hold only delivered items
describe("B. customer files hold only delivered, charged items; the excluded ones are for the admin (four types)", () => {
  it.each([
    ["X posts", "tweets", "التغريدات", "نص التغريدة"],
    ["Facebook posts", "posts", "المنشورات", "نص المنشور"],
    ["companies", "companies", "الشركات", "اسم الشركة"],
    ["Maps places", "places", "الأماكن", "اسم المكان"],
  ])("%s: no excluded text anywhere in the workbook or the CSV; the admin CSV has it with the reason", async (_n, key, title, col) => {
    const plan = planOfStages([stageOf({ key, title_ar: title, columns: [{ key: "text", title_ar: col }] })], 2);
    const delivered = [{ id: "d1", text: "عنصر مُسلَّم أول" }, { id: "d2", text: "عنصر مُسلَّم ثانٍ" }];
    const excluded = [{ id: "x1", reason: "no_term" as const, row: { id: "x1", text: "عنصر مستبعد سري" } }, { id: "x2", reason: "review_no" as const, row: { id: "x2", text: "عنصر آخر مستبعد" } }];
    const built = await buildMissionFiles(plan, { [key]: delivered });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.xlsx as unknown as ArrayBuffer);
    const cells: string[] = [];
    wb.eachSheet((s) => s.eachRow((r) => r.eachCell((c) => cells.push(String((c.value as any)?.text ?? c.value ?? "")))));
    expect(cells.join("|")).not.toContain("مستبعد");
    expect(built.csv).not.toContain("مستبعد");
    expect(wb.worksheets.map((w) => w.name)).toEqual(["ملخص المهمة", title]);
    const admin = buildExcludedAdminCsv(plan, { [key]: excluded })!;
    expect(admin).toContain("عنصر مستبعد سري");
    expect(admin).toContain("رُفض عند المراجعة");
  });
});

describe("B. the plan card's description of the file is built from the plan's real columns", () => {
  const columns = [{ key: "when", title_ar: "التاريخ والوقت" }, { key: "text", title_ar: "نص التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "likes", title_ar: "الإعجابات" }];
  const mission = (plan: any) => ({ id: "msn_1", status: "plan_ready", question_ar: null, plan_public: plan, reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-10-28T20:00:00Z" });

  it("the line lists exactly the readable columns of the delivered stage, in the sheet's order, and the sheet's header agrees", async () => {
    const stage = stageOf({ columns: [...columns, { key: "id", title_ar: "المعرّف" }] });
    const plan = planOfStages([stage], 20);
    const view = customerMissionView({ mission: mission(customerPlanView(plan)), events: [] });
    expect(view.fileContentsAr).toBe("يضم الملف: التاريخ والوقت، نص التغريدة، الحساب، رابط التغريدة، الإعجابات.");
    const built = await buildMissionFiles(plan, { tweets: [{ id: "1", when: "2026-10-28T20:06:00Z", text: "ن", author: "a", url: "https://x.example/1", likes: "3" }] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.xlsx as unknown as ArrayBuffer);
    const header = (wb.getWorksheet("التغريدات")!.getRow(1).values as unknown[]).slice(1).slice(0, -1);
    expect(`يضم الملف: ${header.join("، ")}.`).toBe(view.fileContentsAr);
    // and the card shows it
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false }));
    expect(html).toContain("يضم الملف: التاريخ والوقت، نص التغريدة، الحساب، رابط التغريدة، الإعجابات.");
  });
});

describe("A. the same save path serves other mission types: companies with weak terms, and posts with their comments", () => {
  it("companies: a single-word activity term with a context word is accepted by rule, without one it goes to the model (yes/no), and a company that does not match is left out; the report counts each", async () => {
    const spec: RelevanceSpec = { subject_ar: "شركات الكهروميكانيكا في مصر", terms: ["كهروميكانيكا"], context_terms: ["مصر", "القاهرة"], text_columns: ["name", "description"], min_own_words: 0 };
    const call = fakeReview((rows) => rows.map((r) => r.includes("Alpha")));
    const store = createMemoryStore();
    const probe = makeHarness({ phase: "execution", store });
    const reviewer = createReviewer({ call, store, missionId: probe.mission.id, requestText: "عايز شركات كهروميكانيكا في مصر", budgetUsd: 0.05 });
    const stage = stageOf({ key: "companies", title_ar: "الشركات", endpoint_id: "aiark.companies.search", expected_rows: 10, planned_rows: 10, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "description", title_ar: "الوصف" }], relevance: spec });
    const { h, tools } = executionOf([stage], { review: reviewer, rows: 10 });
    const r: any = await tools.save_rows.handler({ stage_key: "companies", rows: [
      { id: "c1", name: "النيل للكهروميكانيكا", description: "مقاولات في القاهرة" },
      { id: "c2", name: "دلتا كهروميكانيكا", description: "تركيبات في مصر" },
      { id: "c3", name: "Alpha كهروميكانيكا", description: "contracting abroad" },
      { id: "c4", name: "Beta كهروميكانيكا", description: "trading abroad" },
      { id: "c5", name: "مطعم الشرق", description: "مأكولات" },
    ] });
    expect(r).toMatchObject({ saved_now: 3, reviewed_by_model: 2, still_needed: 7 });
    expect(r.left_out_not_matching).toEqual({ no_term: 1, review_no: 1 });
    const checks = (await readChecks(h.store, h.mission.id)).companies;
    expect(checks).toMatchObject({ examined: 5, accepted_by_rule: 2, accepted_by_model: 1, excluded: { no_term: 1, review_no: 1 } });
    expect(checks.accepted_by_rule_basis).toEqual({ terms_context: 2 });
  });

  it("Facebook posts and their comments: comments have no text rule (they belong to a post that matched), but each must point at a saved post; a comment of an unknown post is refused", async () => {
    const campaign: RelevanceSpec = { subject_ar: "حملة مصر الخير", terms: ["حملة مصر الخير"], text_columns: ["message"] };
    const posts = stageOf({ key: "posts", title_ar: "المنشورات", endpoint_id: "justoneapi.x.facebook-search-post-v1", expected_rows: 5, planned_rows: 5, columns: [{ key: "message", title_ar: "نص المنشور" }], relevance: campaign });
    const comments = stageOf({ key: "comments", title_ar: "تعليقات كل منشور", endpoint_id: "anyapi.facebook.post_comments", expected_rows: 10, planned_rows: 10, parent_key: "posts", per_parent_rows: 2, columns: [{ key: "text", title_ar: "نص التعليق" }] });
    const { h, tools } = executionOf([posts, comments], { rows: 15 });
    const p: any = await tools.save_rows.handler({ stage_key: "posts", rows: [{ id: "fp1", message: "إطلاق حملة مصر الخير لدعم الأسر هذا الشهر" }, { id: "fp2", message: "الخير في أمتي إلى يوم القيامة بإذن الله" }] });
    expect(p).toMatchObject({ saved_now: 1, left_out_not_matching: { no_term: 1 } });
    const c: any = await tools.save_rows.handler({ stage_key: "comments", rows: [{ id: "fp1-c0", parent_id: "fp1", text: "جزاكم الله خيرا" }, { id: "fp2-c0", parent_id: "fp2", text: "تعليق على منشور غير محفوظ" }] });
    expect(c).toMatchObject({ saved_now: 1, rejected_unknown_parent: 1 });
    // a stage with no relevance rule reports no check counts
    expect((await readChecks(h.store, h.mission.id)).comments).toBeUndefined();
  });
});
