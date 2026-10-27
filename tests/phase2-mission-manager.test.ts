import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { unitPricePointsFromCost } from "../src/lib/recordPricing";
import { priceMission, priceStep, pricePlan } from "../src/lib/modelPlanner/pricing";
import { countStated, stableRows, validatePlan, type StepSample, type ValidateContext } from "../src/lib/modelPlanner/validate";
import { digestFromCatalogExample } from "../src/lib/modelPlanner/digest";
import { ProposePlanSchema } from "../src/lib/modelPlanner/types";
import { runModelPlanChunk } from "../src/lib/modelPlanner/interpreter";
import { parseMissionState } from "../src/lib/modelPlanner/missionEngine";
import { MANAGER_CALL_ESTIMATE_USD, createMissionManager, managerPrompt, parseManagerReply, type ManagerDecision, type ManagerRequest, type MissionManager } from "../src/lib/modelPlanner/manager";
import { createScriptedTransport } from "../src/lib/modelPlanner/transport";
import { safeArabicSentence, safeStageTitleAr } from "../src/lib/modelPlanner/customerSafe";
import { MODEL_PLAN_PARAM, MODEL_PLAN_REQUEST_PARAM, MODEL_PLAN_SLUG } from "../src/lib/modelPlanner/constants";
import type { ProviderAdapterCallInput } from "../src/lib/server/tregAdapter";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { seedRecipeRows, seedRecipes } from "../src/lib/modelPlanner/recipeSeeds";
import { createMemoryDb } from "./helpers/memoryDb";
import { use } from "./helpers/plannerKit";

const catalog = loadTregCatalog();
const nobody = { isAdmin: false, verifiedBusiness: false };
const business = { isAdmin: false, verifiedBusiness: true };
const TODAY = new Date("2026-10-27T12:00:00Z");

/** A sample made from the catalog's own example answer (FIXTURE: marked as such, never a live answer). */
const exampleSample = (endpointId: string): StepSample => {
  const e = catalog.byId.get(endpointId)!;
  const d = digestFromCatalogExample(e as any)!;
  return { endpointId, rows: d.reading.rows as any, digest: d.digest, costUsd: 0 };
};
const ctx = (customerText: string, over: Partial<ValidateContext> = {}): ValidateContext => ({ customerText, access: business, catalog, samples: new Map(), today: TODAY, ...over });
const col = (field: string, headerAr: string, role?: string, transform?: string) => ({ field, headerAr, ...(role ? { role } : {}), ...(transform ? { transform } : {}) });

// ---------------------------------------------------------------------------------------------------------------------------------------------
// FIXTURES of the four missions, built from the catalog's example shapes (marked FIXTURE: the shapes are the catalog's, the rows are not a live answer)
const M4_TEXT = "أبغى ٥٠ شركة كهروميكانيكية في مصر وفيها الموظفين وإيميل وموبايل كل موظف";
const m4 = (over: Record<string, unknown> = {}) => ProposePlanSchema.parse({
  summaryAr: "جمع الشركات ثم موظفيها ثم بريد وجوال كل موظف",
  steps: [
    { endpointId: "icypeas.companies.search", titleAr: "جمع الشركات", volume: 50, params: [{ name: "query", value: { industry: { include: ["Electrical"] }, location: { include: ["Egypt"] } }, source: "derived", quote: "شركة كهروميكانيكية في مصر" }], fieldMap: { columns: [col("name", "اسم الشركة", "company"), col("website", "الموقع", "website"), col("url", "رابط الشركة", "url"), col("lid", "المعرف", "id")], pagination: { kind: "single" } } },
    { endpointId: "blitzapi.people.employee-finder", titleAr: "جمع الموظفين داخل كل شركة", volume: 150, perItem: 3, params: [{ name: "company_linkedin_url", source: "prior_step", fromStep: { step: 1, field: "url" } }], fieldMap: { columns: [col("full_name", "الاسم", "author_name"), col("headline", "المسمى", "job_title"), col("linkedin_url", "رابط الملف", "id"), col("first_name", "الاسم الأول"), col("last_name", "اسم العائلة")], pagination: { kind: "single" } } },
    { endpointId: "icypeas.people.email.find", titleAr: "البريد المهني", volume: 150, perItem: 1, params: [{ name: "firstname", source: "prior_step", fromStep: { step: 2, field: "first_name" } }, { name: "lastname", source: "prior_step", fromStep: { step: 2, field: "last_name" } }, { name: "domainOrCompany", source: "prior_step", fromStep: { step: 1, field: "website" } }], fieldMap: { columns: [col("item.status", "حالة البريد")], pagination: { kind: "single" } } },
    { endpointId: "tomba.people.phone.find", titleAr: "الموبايل", volume: 150, perItem: 1, params: [{ name: "linkedin", source: "prior_step", fromStep: { step: 2, field: "linkedin_url" } }], fieldMap: { columns: [col("e164_format", "الجوال", "phone")], pagination: { kind: "single" } } },
  ],
  ...over,
});

describe("the price of a mission: the sum of its stages, by code", () => {
  const per = (usd: number, unit: "call" | "record", rows: number, pass = 1) => priceStep({ usd, unit, basis: "catalog" }, { rowsPerCall: rows, passRate: pass, source: "sample" });

  it("a chain of three stages: every stage's calls and cost, spread over the rows the customer receives", () => {
    const companies = per(0.01, "call", 10);        // 10 per call
    const people = per(0.002, "record", 1);         // per record
    const emails = per(0.02, "record", 1);
    const m = priceMission([
      { price: companies, volume: 50, parent: null, deliver: true },
      { price: people, volume: 150, parent: 0, perItem: 3, deliver: true },
      { price: emails, volume: 150, parent: 1, perItem: 1, deliver: true },
    ]);
    expect(m.effectiveVolumes).toEqual([50, 150, 150]);
    expect(m.calls).toEqual([5, 50, 150]);
    expect(m.totalCostUsd).toBeCloseTo(5 * 0.01 + 150 * 0.002 + 150 * 0.02, 9);
    expect(m.deliveredVolume).toBe(350);
    expect(m.costPerRecordUsd).toBeCloseTo(m.totalCostUsd / 350, 12);
    expect(m.unitPricePoints).toBe(unitPricePointsFromCost(m.costPerRecordUsd));
  });

  it("a stage run once per parent row never collects more than its parents can give; a stage that is not delivered is paid for by the delivered ones", () => {
    const list = per(0.004, "call", 10);
    const comments = per(0.001, "call", 20);
    const m = priceMission([{ price: list, volume: 20, parent: null, deliver: false }, { price: comments, volume: 500, parent: 0, perItem: 5, deliver: true }]);
    expect(m.effectiveVolumes).toEqual([20, 100]); // 20 parents x 5 rows each
    expect(m.deliveredVolume).toBe(100);
    expect(m.totalCostUsd).toBeCloseTo(2 * 0.004 + 20 * 0.001, 9);
  });

  it("a list stage that is not delivered never collects more than the next stage uses, so the customer is not charged for a longer list", () => {
    const list = per(0.004, "call", 10);
    const comments = per(0.001, "call", 20);
    const m = priceMission([{ price: list, volume: 180, parent: null, deliver: false }, { price: comments, volume: 100, parent: 0, perItem: 20, deliver: true }]);
    expect(m.effectiveVolumes).toEqual([5, 100]); // 100 comments at 20 per video need 5 videos
    expect(m.calls).toEqual([1, 5]);
    expect(m.totalCostUsd).toBeCloseTo(0.004 + 5 * 0.001, 9);
    const delivered = priceMission([{ price: list, volume: 180, parent: null, deliver: true }, { price: comments, volume: 100, parent: 0, perItem: 20, deliver: true }]);
    expect(delivered.effectiveVolumes).toEqual([180, 100]); // a list the customer receives keeps its own volume
  });

  it("the same measure gives the same price: rows per call are the smaller of two pages, rounded down to a step of five from ten rows", () => {
    expect(stableRows(18)).toBe(15);
    expect(stableRows(20)).toBe(20);
    expect(stableRows(9)).toBe(9);
    expect(stableRows(14.9)).toBe(10);
    expect(stableRows(0)).toBe(1);
  });
});

describe("a mission of up to four stages is validated, priced and stored by code (M4: companies, their employees, each employee's work e-mail and mobile)", () => {
  it("validates; stage parents, delivery, volumes and Arabic names are stored; the later per-call stage is priced from one row per call, never refused for a missing sample", () => {
    const r = validatePlan(m4(), ctx(M4_TEXT));
    expect(r.ok ? [] : r.issues.map((i) => `${i.code}: ${i.message}`)).toEqual([]);
    if (!r.ok) return;
    const { stored } = r.plan;
    expect(stored.stages!.map((s) => s.parent)).toEqual([null, 0, 1, 1]);
    expect(stored.stages!.map((s) => s.deliver)).toEqual([true, true, true, true]);
    expect(stored.stages!.map((s) => s.effVolume)).toEqual([50, 150, 150, 150]);
    expect(stored.stages!.map((s) => s.titleAr)).toEqual(["جمع الشركات", "جمع الموظفين داخل كل شركة", "البريد المهني", "الموبايل"]);
    expect(r.plan.steps[3].price.measuredFrom).toBe("assumed_one_per_call");
    const price = r.plan.price as any;
    expect(price.deliveredVolume).toBe(500);
    expect(stored.managerBudgetUsd).toBeCloseTo(Math.max(0.01, 0.05 * price.totalCostUsd * 1.15), 6);
    expect(r.plan.price.unitPricePoints).toBe(unitPricePointsFromCost(price.totalCostUsd / 500));
  });

  it("the same request is priced the same twice", () => {
    const a = validatePlan(m4(), ctx(M4_TEXT));
    const b = validatePlan(m4(), ctx(M4_TEXT));
    expect(a.ok && b.ok && a.plan.price.unitPricePoints === b.plan.price.unitPricePoints).toBe(true);
  });

  it("a step reads its parent AND the steps its parent came from (the e-mail needs the person's name and the company's site); a step that reads two unrelated branches is refused with the reason", () => {
    const forward = m4();
    forward.steps[1].params = [{ name: "company_linkedin_url", source: "prior_step", fromStep: { step: 3, field: "x" } }];
    const f = validatePlan(forward, ctx(M4_TEXT));
    expect(!f.ok && f.issues.map((i) => i.code)).toContain("bad_step_reference");
    // two roots (news and videos); the comments read the videos AND the news: not one chain
    const stray = m4();
    stray.steps[1].params = [{ name: "company_linkedin_url", value: "https://www.linkedin.com/company/x", source: "customer_text", quote: "كهروميكانيكية" }];
    stray.steps[2].params = [{ name: "firstname", source: "prior_step", fromStep: { step: 2, field: "first_name" } }, { name: "domainOrCompany", source: "prior_step", fromStep: { step: 1, field: "website" } }];
    const r = validatePlan(stray, ctx(M4_TEXT));
    expect(!r.ok && r.issues.map((i) => i.code)).toContain("branch_reference");
  });

  it("a wrong field path of an earlier step comes back with the REAL fields that step maps", () => {
    const bad = m4();
    bad.steps[1].params = [{ name: "company_linkedin_url", source: "prior_step", fromStep: { step: 1, field: "linkedin" } }];
    const r = validatePlan(bad, ctx(M4_TEXT));
    expect(r.ok).toBe(false);
    const text = !r.ok ? r.issues.map((i) => i.message).join(" ") : "";
    expect(text).toContain("name, website, url, lid");
  });

  it("five steps do not parse; the first stage of a branch still needs a real sample when it is priced per call", () => {
    const five = { ...m4(), steps: [...m4().steps, m4().steps[3]] };
    expect(ProposePlanSchema.safeParse(five).success).toBe(false);
    const news = ProposePlanSchema.parse({ summaryAr: "أخبار", steps: [{ endpointId: "anyapi.google.serp.news", volume: 10, params: [{ name: "query", value: "منتخب مصر", source: "customer_text", quote: "منتخب مصر" }], fieldMap: { columns: [col("title", "العنوان", "title")], pagination: { kind: "single" } } }] });
    const r = validatePlan(news, ctx("هات ١٠ أخبار عن منتخب مصر"));
    expect(!r.ok && r.issues.map((i) => i.code)).toEqual(["needs_real_sample"]);
  });
});

describe("M1, M2 and M3 as plans (FIXTURES built from the catalog's example shapes)", () => {
  it("M1: news, videos of the official channel, and the comments of each video: two roots and a step per video; all three delivered", () => {
    const text = "هات ١٠ أخبار عن منتخب مصر في كأس العالم ٢٠٢٦ و١٠ فيديوهات من قناة @FIFA الرسمية عن مصر ومعاها تعليقات كل فيديو";
    const plan = ProposePlanSchema.parse({
      summaryAr: "أخبار المنتخب وفيديوهات القناة الرسمية وتعليقاتها",
      steps: [
        { endpointId: "anyapi.google.serp.news", titleAr: "جمع الأخبار", volume: 10, params: [{ name: "query", value: "منتخب مصر في كأس العالم ٢٠٢٦", source: "customer_text", quote: "منتخب مصر في كأس العالم ٢٠٢٦" }], fieldMap: { columns: [col("title", "العنوان", "title"), col("url", "الرابط", "url")], pagination: { kind: "single" } } },
        { endpointId: "crawl4ai.youtube.channel.videos", titleAr: "فيديوهات القناة الرسمية", volume: 10, params: [{ name: "channel", value: "@FIFA", source: "customer_text", quote: "@FIFA" }], fieldMap: { columns: [col("video_id", "المعرف", "id"), col("title", "العنوان", "title"), col("url", "الرابط", "url")], pagination: { kind: "single" } } },
        { endpointId: "tikhub.youtube.video.comments", titleAr: "تعليقات كل فيديو", volume: 100, perItem: 10, params: [{ name: "video_id", source: "prior_step", fromStep: { step: 2, field: "video_id" } }], fieldMap: { columns: [col("content", "التعليق", "text"), col("like_count", "الإعجابات", "likes", "number")], pagination: { kind: "single" } } },
      ],
    });
    const samples = new Map([["anyapi.google.serp.news", exampleSample("anyapi.google.serp.news")], ["crawl4ai.youtube.channel.videos", exampleSample("crawl4ai.youtube.channel.videos")], ["tikhub.youtube.video.comments", exampleSample("tikhub.youtube.video.comments")]]);
    const r = validatePlan(plan, ctx(text, { samples }));
    expect(r.ok ? [] : r.issues.map((i) => `${i.code}: ${i.message}`)).toEqual([]);
    if (!r.ok) return;
    expect(r.plan.stored.stages!.map((s) => s.parent)).toEqual([null, null, 1]);
    expect(r.plan.stored.delivers).toEqual([true, true, true]);
    expect(r.plan.stored.stages![2].effVolume).toBe(10); // one comment per parent from this fixture's one-row example: never more than the parents give
  });

  it("M3: a topic and a date boundary from the customer's words is one stage with a stated window", () => {
    const text = "هات ٥٠ بوست على X عن محمد صلاح بعد انتقاله إلى تركيا من ١ يوليو ٢٠٢٦ إلى ٢٧ أكتوبر ٢٠٢٦";
    const plan = ProposePlanSchema.parse({
      summaryAr: "منشورات عن محمد صلاح", topic: "محمد صلاح",
      steps: [{ endpointId: "anyapi.x.search.posts", volume: 50, params: [{ name: "query", value: "محمد صلاح", source: "customer_text", quote: "محمد صلاح" }], fieldMap: { columns: [col("text", "نص التغريدة", "text"), col("createdUtc", "تاريخ النشر", "date", "unix_s_to_iso")], pagination: { kind: "token", param: "cursor" } }, filters: [{ kind: "date_window", field: "createdUtc", from: "2026-07-01", to: "2026-10-27", quote: "من ١ يوليو ٢٠٢٦ إلى ٢٧ أكتوبر ٢٠٢٦", format: "unix_s" }] }],
    });
    const sample = exampleSample("anyapi.x.search.posts");
    const r = validatePlan(plan, ctx(text, { samples: new Map([["anyapi.x.search.posts", { ...sample, rows: sample.rows.map((row: any) => ({ ...row, createdUtc: String(Math.floor(Date.parse("2026-08-15T00:00:00Z") / 1000)) })) }]]) }));
    expect(r.ok ? [] : r.issues.map((i) => `${i.code}: ${i.message}`)).toEqual([]);
    if (!r.ok) return;
    expect(r.plan.stored.stages).toHaveLength(1);
    expect(r.plan.stored.stages![0].titleAr).toBe("المرحلة ١");
  });

  it("M2: posts and videos about a trend, each with its link and its comments: the list stage is delivered too", () => {
    const text = "هات ٣٠ فيديو تيك توك عن الزواج والطلاق في مصر آخر ٣ شهور ومعاها لينكاتها وتعليقاتها";
    const plan = ProposePlanSchema.parse({
      summaryAr: "فيديوهات عن الزواج والطلاق وتعليقاتها", topic: "الزواج والطلاق في مصر",
      steps: [
        { endpointId: "anyapi.tiktok.search.videos", titleAr: "جمع الفيديوهات", volume: 30, deliver: true, params: [{ name: "query", value: "الزواج والطلاق في مصر", source: "customer_text", quote: "الزواج والطلاق في مصر" }], fieldMap: { columns: [col("id", "المعرف", "id"), col("caption", "الوصف", "title")], pagination: { kind: "token", param: "cursor" } } },
        { endpointId: "tikhub.tiktok.video.comments", titleAr: "تعليقات كل فيديو", volume: 300, perItem: 10, deliver: true, params: [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "id" } }], fieldMap: { columns: [col("text", "نص التعليق", "text")], pagination: { kind: "single" } } },
      ],
    });
    const samples = new Map([["anyapi.tiktok.search.videos", exampleSample("anyapi.tiktok.search.videos")], ["tikhub.tiktok.video.comments", exampleSample("tikhub.tiktok.video.comments")]]);
    const r = validatePlan(plan, ctx(text, { samples }));
    expect(r.ok ? [] : r.issues.map((i) => `${i.code}: ${i.message}`)).toEqual([]);
    if (!r.ok) return;
    expect(r.plan.stored.delivers).toEqual([true, true]);
  });
});

describe("the count is the customer's", () => {
  const tiktok = (volume: number) => ProposePlanSchema.parse({
    summaryAr: "تعليقات", steps: [{ endpointId: "anyapi.tiktok.search.videos", volume, params: [{ name: "query", value: "كرة السلة", source: "customer_text", quote: "كرة السلة" }], fieldMap: { columns: [col("id", "المعرف", "id")], pagination: { kind: "token", param: "cursor" } } }],
  });
  const samples = new Map([["anyapi.tiktok.search.videos", exampleSample("anyapi.tiktok.search.videos")]]);

  it("no number, or «كل» (all), is not a count: the plan is not made, ONE question is asked", () => {
    for (const text of ["هات فيديوهات تيك توك عن كرة السلة", "هات كل فيديوهات تيك توك عن كرة السلة"]) {
      const r = validatePlan(tiktok(30), ctx(text, { samples }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.issues.map((i) => i.code)).toEqual(["volume_not_stated"]);
      expect(!r.ok && r.issues[0].message).toContain("ONE short Arabic question");
    }
  });

  it("digits (Arabic-Indic too) and numbers written in words are counts", () => {
    expect(countStated("هات ٣٠ فيديو")).toBe(true);
    expect(countStated("هات 30 فيديو")).toBe(true);
    expect(countStated("هات خمسين فيديو")).toBe(true);
    expect(countStated("هات مية فيديو")).toBe(true);
    expect(countStated("هات كل الفيديوهات")).toBe(false);
    const ok = validatePlan(tiktok(30), ctx("هات ٣٠ فيديو تيك توك عن كرة السلة", { samples }));
    expect(ok.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// THE MISSION ENGINE
const facts = (over: Record<string, unknown> = {}) => ({ method: "POST", scope: "any_account", limitName: "limit", limitMax: 100, listPath: "rows", cursorPath: null, itemFields: null, callEstimateUsd: 0.0005, ...over });
const alt = (over: Record<string, unknown> = {}) => ({ endpointId: "alt.companies.search", method: "POST", scope: "any_account", params: [{ name: "q", value: "x", source: "literal" }], listPath: "companies", cursorPath: null, itemFields: null, limitName: "limit", limitMax: 100, callEstimateUsd: 0.0005, ...over });
const mission = (over: Record<string, unknown> = {}, companyFacts: Record<string, unknown> = {}) => ({
  v: 1, managerBudgetUsd: 0.05, delivers: [true, true, true, true],
  measured: [{ rowsPerCall: 4, passRate: 1, costPerCallUsd: 0.0005 }, { rowsPerCall: 3, passRate: 1, costPerCallUsd: 0.0005 }, { rowsPerCall: 1, passRate: 1, costPerCallUsd: 0.0005 }, { rowsPerCall: 1, passRate: 1, costPerCallUsd: 0.0005 }],
  stages: [
    { parent: null, deliver: true, effVolume: 6, perParent: 0, titleAr: "جمع الشركات" },
    { parent: 0, deliver: true, effVolume: 12, perParent: 2, titleAr: "جمع الموظفين" },
    { parent: 1, deliver: true, effVolume: 12, perParent: 1, titleAr: "البريد المهني" },
    { parent: 1, deliver: true, effVolume: 12, perParent: 1, titleAr: "الموبايل" },
  ],
  steps: [
    { endpointId: "icypeas.companies.search", volume: 6, params: [{ name: "query", value: "x", source: "literal" }], fieldMap: { columns: [col("name", "اسم الشركة", "company"), col("website", "الموقع", "website"), col("lid", "المعرف", "id")], pagination: { kind: "token", param: "cursor" } }, filters: [], facts: facts({ listPath: "companies", ...companyFacts }) },
    { endpointId: "blitzapi.people.employee-finder", volume: 12, perItem: 2, params: [{ name: "company_linkedin_url", source: "prior_step", fromStep: { step: 1, field: "lid" } }], fieldMap: { columns: [col("full_name", "الاسم", "author_name"), col("pid", "المعرف", "id")], pagination: { kind: "single" } }, filters: [], facts: facts({ listPath: "results" }) },
    { endpointId: "icypeas.people.email.find", volume: 12, perItem: 1, params: [{ name: "firstname", source: "prior_step", fromStep: { step: 2, field: "first" } }, { name: "domainOrCompany", source: "prior_step", fromStep: { step: 1, field: "website" } }], fieldMap: { columns: [col("email", "البريد", "email")], pagination: { kind: "single" } }, filters: [], facts: facts({ listPath: "emails" }) },
    { endpointId: "tomba.people.phone.find", volume: 12, perItem: 1, params: [{ name: "linkedin", source: "prior_step", fromStep: { step: 2, field: "linkedin" } }], fieldMap: { columns: [col("phone", "الجوال", "phone")], pagination: { kind: "single" } }, filters: [], facts: facts({ listPath: "phones" }) },
  ],
  ...over,
});
const REQUEST = "أبغى ٦ شركات كهروميكانيكية في مصر وفيها الموظفين وإيميل وموبايل كل موظف";
const input = (plan: any, over: Partial<ProviderAdapterCallInput> = {}): ProviderAdapterCallInput => ({
  jobId: "job_m", userId: "u1", step: 0, endpointId: plan.steps[0].endpointId, capabilitySlug: MODEL_PLAN_SLUG, method: "POST", params: { [MODEL_PLAN_PARAM]: plan, [MODEL_PLAN_REQUEST_PARAM]: REQUEST }, paginationStrategy: "cursor",
  cursor: null, pageSize: 10, remainingNeeded: 42, targetVolumeMax: 42, deliveredSoFar: 0, ...over,
});
const ok = (data: any, costMicro = 500): TregCallResult => ({ ok: true, httpStatus: 200, tregCallId: "c", costMicro, latencyMs: 1, data, isRouteMaxCost: false, isPlatformBalanceLow: false });
const bad = (httpStatus = 500): TregCallResult => ({ ok: false, httpStatus, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, error: `http_${httpStatus}`, isRouteMaxCost: false, isPlatformBalanceLow: false });

/** The sources of the fixture world: 8 companies in two pages, 3 people per company, an e-mail from the person's first name AND the company's site, a mobile per person. */
const world = (log: TregCallOptions[] = []) => async (o: TregCallOptions): Promise<TregCallResult> => {
  log.push(o);
  const p = o.params as Record<string, any>;
  if (o.endpointId === "icypeas.companies.search") {
    const page = p.cursor === "P2" ? 2 : 1;
    return ok({ companies: [1, 2, 3, 4].map((n) => { const i = (page - 1) * 4 + n; return { name: `شركة ${i}`, website: `c${i}.com`, lid: `L${i}` }; }), ...(page === 1 ? { cursor: "P2" } : {}) });
  }
  if (o.endpointId === "alt.companies.search") return ok({ companies: [1, 2, 3, 4].map((i) => ({ name: `بديلة ${i}`, website: `a${i}.com`, lid: `A${i}` })) });
  if (o.endpointId === "blitzapi.people.employee-finder") return ok({ results: [1, 2, 3].map((n) => ({ full_name: `موظف ${p.company_linkedin_url}-${n}`, pid: `${p.company_linkedin_url}-p${n}`, first: `F${n}`, linkedin: `li/${p.company_linkedin_url}-${n}` })) });
  if (o.endpointId === "icypeas.people.email.find") return ok({ emails: [{ email: `${p.firstname}@${p.domainOrCompany}` }] });
  if (o.endpointId === "tomba.people.phone.find") return ok({ phones: [{ phone: `+20${String(p.linkedin).length}` }] });
  return bad(404);
};

async function runAll(plan: any, deps: Record<string, unknown> = {}, over: Partial<ProviderAdapterCallInput> = {}) {
  const rows: any[] = [];
  const usage: any[] = [];
  const notes: any[] = [];
  const calls: TregCallOptions[] = [];
  let cursor: string | null = null;
  let remaining = over.remainingNeeded ?? 42;
  let last: any = null;
  for (let chunk = 0; chunk < 40; chunk += 1) {
    last = await runModelPlanChunk(input(plan, { ...over, cursor, remainingNeeded: remaining }), { call: world(calls), ...deps });
    if (!last.ok) break;
    rows.push(...last.rows);
    usage.push(...(last.reviewModelUsage ?? []));
    notes.push(...(last.missionNotes ?? []));
    remaining -= last.rows.length;
    cursor = last.nextCursor;
    if (!cursor) break;
  }
  return { rows, usage, notes, calls, last, cursor };
}

const scripted = (fn: (req: ManagerRequest) => ManagerDecision, costUsd = 0.002): MissionManager & { requests: ManagerRequest[] } => {
  const requests: ManagerRequest[] = [];
  return { requests, decide: vi.fn(async (req: ManagerRequest) => { requests.push(req); return { decision: fn(req), usage: { inputTokens: 300, outputTokens: 30, costUsd, model: "recorded", latencyMs: 1, reason: `mission_manager_${req.kind}` } }; }) as any };
};

beforeEach(() => { process.env.TREG_TOKEN = "t"; vi.spyOn(console, "warn").mockImplementation(() => undefined); vi.spyOn(console, "info").mockImplementation(() => undefined); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("the mission engine runs a chain of four stages and every row keeps its parent id", () => {
  it("companies, then 2 employees per company, then an e-mail and a mobile per employee: the counts, the parent ids and the grandparent's site in each e-mail", async () => {
    const r = await runAll(mission());
    const by = (n: number) => r.rows.filter((x) => x.mission_stage === n);
    expect([1, 2, 3, 4].map((n) => by(n).length)).toEqual([6, 12, 12, 12]);
    const companyIds = new Set(by(1).map((x) => x.source_id));
    expect(companyIds.size).toBe(6);
    for (const e of by(2)) expect(companyIds.has(e.mission_parent_id)).toBe(true);
    const employeeIds = new Set(by(2).map((x) => x.source_id));
    expect(employeeIds.size).toBe(12);
    for (const row of [...by(3), ...by(4)]) expect(employeeIds.has(row.mission_parent_id)).toBe(true);
    // the e-mail is built from the employee's first name (the parent) and the COMPANY's site (the grandparent)
    for (const row of by(3)) expect(row.work_email).toMatch(/^F[123]@c[1-6]\.com$/);
    expect(by(1).every((x) => x.mission_parent_id === "")).toBe(true);
    expect(r.cursor).toBeNull();
    // no stage went past its volume: 2 pages of companies, 6 parents for the employees, one call per employee for the e-mail and for the mobile
    const count = (id: string) => r.calls.filter((c) => c.endpointId === id).length;
    expect(count("icypeas.companies.search")).toBe(2);
    expect(count("blitzapi.people.employee-finder")).toBe(6);
    expect(count("icypeas.people.email.find")).toBe(12);
    expect(count("tomba.people.phone.find")).toBe(12);
  });

  it("a chunk makes at most the allowed provider calls, and the state between chunks is a small cursor", async () => {
    const calls: TregCallOptions[] = [];
    const first = await runModelPlanChunk(input(mission()), { call: world(calls) });
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(first.providerCallCount).toBe(calls.length);
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor!.length).toBeLessThan(6000);
    expect(parseMissionState(first.nextCursor, 4).stages).toHaveLength(4);
  });

  it("a stage that is not delivered feeds the next one without adding rows or ids to the files", async () => {
    const plan = mission();
    plan.stages[0].deliver = false;
    plan.delivers = [false, true, true, true];
    const r = await runAll(plan, {}, { remainingNeeded: 36 });
    expect(r.rows.filter((x) => x.mission_stage === 1)).toHaveLength(0);
    expect(r.rows.filter((x) => x.mission_stage === 2)).toHaveLength(12);
  });

  it("a plan approved before Phase 2 (no stages) keeps running on the first interpreter, untouched", async () => {
    const legacy = { v: 1, measured: [{ rowsPerCall: 10, passRate: 1, costPerCallUsd: 0.0005 }], steps: [{ endpointId: "icypeas.companies.search", volume: 3, params: [{ name: "query", value: "x", source: "literal" }], fieldMap: { columns: [col("name", "اسم الشركة", "company")], pagination: { kind: "single" } }, filters: [], facts: facts({ listPath: "companies" }) }] };
    const out = await runModelPlanChunk(input(legacy, { remainingNeeded: 3, targetVolumeMax: 3 }), { call: world() });
    expect(out.ok).toBe(true);
    expect(out.rows[0]).not.toHaveProperty("mission_stage");
    expect(out.nextCursor === null || JSON.parse(out.nextCursor).v === 1).toBe(true);
  });

  it("a refused call ends the mission with what was delivered; with nothing delivered the whole reserve returns", async () => {
    const blocked = async () => ({ ...bad(402), budgetStopped: true } as TregCallResult);
    const none = await runModelPlanChunk(input(mission()), { call: blocked });
    expect(none.ok).toBe(false);
    expect(none.errorMessageAr).toContain("حجز مؤقت مُحرَّر");
  });
});

describe("M1, M2 and M3 run end to end on the engine (FIXTURE sources: zero provider calls)", () => {
  const stage = (parent: number | null, deliver: boolean, effVolume: number, perParent: number, titleAr: string) => ({ parent, deliver, effVolume, perParent, titleAr });
  const step = (endpointId: string, volume: number, params: any[], columns: any[], listPath: string, extra: Record<string, unknown> = {}) => ({ endpointId, volume, params, fieldMap: { columns, pagination: { kind: "single" } }, filters: [], facts: facts({ listPath }), ...extra });
  const world2 = (log: TregCallOptions[]) => async (o: TregCallOptions): Promise<TregCallResult> => {
    log.push(o);
    const p = o.params as Record<string, any>;
    if (o.endpointId === "anyapi.google.serp.news") return ok({ items: [1, 2, 3, 4].map((i) => ({ title: `خبر ${i}`, url: `https://n.example/${i}` })) });
    if (o.endpointId === "crawl4ai.youtube.channel.videos") return ok({ rows: [1, 2, 3].map((i) => ({ video_id: `V${i}`, title: `فيديو ${i} عن مصر`, url: `https://y.example/${i}` })) });
    if (o.endpointId === "tikhub.youtube.video.comments") return ok({ comments: [1, 2, 3, 4].map((i) => ({ content: `تعليق ${i} على ${p.video_id}`, like_count: i })) });
    if (o.endpointId === "anyapi.x.search.posts") return ok({ rows: [1, 2, 3].map((i) => ({ text: `منشور ${i} عن صلاح`, createdUtc: 1790000000 + i })) });
    return bad(404);
  };
  const run = async (plan: any, target: number) => {
    const rows: any[] = [];
    const calls: TregCallOptions[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const out: any = await runModelPlanChunk(input(plan, { cursor, remainingNeeded: target - rows.length, targetVolumeMax: target }), { call: world2(calls) });
      rows.push(...out.rows);
      cursor = out.nextCursor;
      if (!cursor) break;
    }
    return { rows, calls };
  };

  it("M1: news and the official channel's videos are two ROOTS; the comments run once per video and only they carry a parent id", async () => {
    const plan = {
      v: 1, managerBudgetUsd: 0.05, measured: [{ rowsPerCall: 4, passRate: 1, costPerCallUsd: 0.001 }, { rowsPerCall: 3, passRate: 1, costPerCallUsd: 0.001 }, { rowsPerCall: 4, passRate: 1, costPerCallUsd: 0.001 }],
      stages: [stage(null, true, 4, 0, "جمع الأخبار"), stage(null, true, 3, 0, "فيديوهات القناة الرسمية"), stage(1, true, 6, 2, "تعليقات كل فيديو")],
      steps: [
        step("anyapi.google.serp.news", 4, [{ name: "query", value: "x", source: "literal" }], [col("title", "العنوان", "title"), col("url", "الرابط", "url")], "items"),
        step("crawl4ai.youtube.channel.videos", 3, [{ name: "channel", value: "@FIFA", source: "literal" }], [col("video_id", "المعرف", "id"), col("title", "العنوان", "title"), col("url", "الرابط", "url")], "rows"),
        step("tikhub.youtube.video.comments", 6, [{ name: "video_id", source: "prior_step", fromStep: { step: 2, field: "video_id" } }], [col("content", "التعليق", "text"), col("like_count", "الإعجابات", "likes")], "comments", { perItem: 2 }),
      ],
    };
    const r = await run(plan, 13);
    const by = (n: number) => r.rows.filter((x) => x.mission_stage === n);
    expect([1, 2, 3].map((n) => by(n).length)).toEqual([4, 3, 6]);
    expect(by(1).every((x) => x.mission_parent_id === "")).toBe(true);
    expect(by(2).every((x) => x.mission_parent_id === "")).toBe(true);
    const videoIds = new Set(by(2).map((x) => x.source_id));
    expect(by(3).every((x) => videoIds.has(x.mission_parent_id))).toBe(true);
    expect(r.calls.filter((c) => c.endpointId === "tikhub.youtube.video.comments")).toHaveLength(3);
  });

  it("M2: the list of videos is delivered too (with its links) and each comment points to its video", async () => {
    const plan = {
      v: 1, managerBudgetUsd: 0.05, measured: [{ rowsPerCall: 3, passRate: 1, costPerCallUsd: 0.001 }, { rowsPerCall: 4, passRate: 1, costPerCallUsd: 0.001 }],
      stages: [stage(null, true, 3, 0, "جمع الفيديوهات"), stage(0, true, 8, 4, "تعليقات كل فيديو")],
      steps: [
        step("crawl4ai.youtube.channel.videos", 3, [{ name: "channel", value: "x", source: "literal" }], [col("video_id", "المعرف", "id"), col("url", "الرابط", "url")], "rows"),
        step("tikhub.youtube.video.comments", 8, [{ name: "video_id", source: "prior_step", fromStep: { step: 1, field: "video_id" } }], [col("content", "التعليق", "text")], "comments", { perItem: 4 }),
      ],
    };
    const r = await run(plan, 11);
    const videos = r.rows.filter((x) => x.mission_stage === 1);
    const comments = r.rows.filter((x) => x.mission_stage === 2);
    expect([videos.length, comments.length]).toEqual([3, 8]);
    expect(videos.every((x) => /^https:\/\/y\.example\//.test(String(x.url)))).toBe(true);
    const ids = new Set(videos.map((x) => x.source_id));
    expect(comments.every((x) => ids.has(x.mission_parent_id))).toBe(true);
  });

  it("M3: one stage with a stated window: the rows carry no mission keys, so a single-stage mission is delivered as before", async () => {
    const plan = {
      v: 1, managerBudgetUsd: 0.02, measured: [{ rowsPerCall: 3, passRate: 1, costPerCallUsd: 0.001 }],
      stages: [stage(null, true, 3, 0, "المرحلة ١")],
      steps: [step("anyapi.x.search.posts", 3, [{ name: "query", value: "محمد صلاح", source: "literal" }], [col("text", "نص التغريدة", "text"), col("createdUtc", "تاريخ النشر", "date", "unix_s_to_iso")], "rows")],
    };
    const r = await run(plan, 3);
    expect(r.rows).toHaveLength(3);
    expect(r.rows.every((x) => !("mission_stage" in x))).toBe(true);
  });
});

describe("the model manages the mission at its decision points, inside a budget", () => {
  it("it is asked at the first page of every stage, when a stage hands rows to the next, and once at the end", async () => {
    const m = scripted(() => ({ action: "continue" }));
    const r = await runAll(mission(), { manager: m });
    const kinds = m.requests.map((q) => q.kind);
    expect(kinds.filter((k) => k === "first_page")).toHaveLength(4);
    expect(kinds).toContain("transition");
    expect(kinds.filter((k) => k === "final")).toHaveLength(1);
    expect(kinds[kinds.length - 1]).toBe("final");
    expect(r.usage.every((u) => /^mission_manager_/.test(u.reason))).toBe(true);
    expect(r.rows).toHaveLength(42);
    // never on every page: far fewer asks than provider calls
    expect(m.requests.length).toBeLessThan(r.calls.length);
    // what it is shown holds no provider, endpoint or price
    for (const q of m.requests) expect(managerPrompt(q)).not.toMatch(/icypeas|blitzapi|tomba|USD|\$|dollar/i);
  });

  it("its spend is capped by code: with room for one call it is asked once, and the mission still completes as approved", async () => {
    const m = scripted(() => ({ action: "continue" }), 0.002);
    const plan = mission({ managerBudgetUsd: 0.004 });
    expect(0.002 + MANAGER_CALL_ESTIMATE_USD).toBeGreaterThan(0.004);
    const r = await runAll(plan, { manager: m });
    expect(m.requests).toHaveLength(1);
    expect(r.rows).toHaveLength(42);
    const spent = r.usage.reduce((s, u) => s + u.costUsd, 0);
    expect(spent).toBeLessThanOrEqual(0.004 + 1e-9);
  });

  it("with no budget at all it is never asked", async () => {
    const m = scripted(() => ({ action: "stop", reasonAr: "لا" }));
    const r = await runAll(mission({ managerBudgetUsd: 0 }), { manager: m });
    expect(m.requests).toHaveLength(0);
    expect(r.rows).toHaveLength(42);
  });

  it("a manager that throws, or answers nothing readable, changes nothing", async () => {
    const throwing: MissionManager = { decide: async () => { throw new Error("boom"); } };
    const a = await runAll(mission(), { manager: throwing });
    expect(a.rows).toHaveLength(42);
    const silent = createMissionManager(createScriptedTransport([[{ type: "text", text: "no tool call" }]]));
    const b = await runAll(mission(), { manager: silent });
    expect(b.rows).toHaveLength(42);
  });

  it("at a stage transition it picks which listed rows the next stage runs for: only those are expanded", async () => {
    const m = scripted((req) => (req.kind === "transition" && req.fromStage === 1 ? { action: "expand", keep: [1, 3] } : { action: "continue" }));
    const calls: TregCallOptions[] = [];
    const first = await runModelPlanChunk(input(mission()), { call: world(calls), manager: m });
    // the first page listed L1..L4: only L2 and L4 were kept for the employees
    const asked = calls.filter((c) => c.endpointId === "blitzapi.people.employee-finder").map((c) => (c.params as any).company_linkedin_url);
    expect(asked.every((x) => x === "L2" || x === "L4")).toBe(true);
    expect(first.rows.filter((x) => x.mission_stage === 2).every((x) => x.mission_parent_id === "L2" || x.mission_parent_id === "L4")).toBe(true);
  });

  it("a bad first page: the manager switches to the source the approved plan already carries; the first page's rows are neither delivered nor charged", async () => {
    const plan = mission({}, { alternates: [alt()] });
    const m = scripted((req) => (req.kind === "first_page" && req.stageNumber === 1 ? { action: "switch", alternate: 1, reasonAr: "المصدر الأول لا يطابق طلبك فبدّلناه." } : { action: "continue" }));
    const r = await runAll(plan, { manager: m });
    const companies = r.rows.filter((x) => x.mission_stage === 1);
    expect(companies.length).toBeGreaterThan(0);
    expect(companies.every((x) => String(x.company_name).startsWith("بديلة"))).toBe(true);
    expect(r.calls.some((c) => c.endpointId === "alt.companies.search")).toBe(true);
    expect(r.notes.some((n) => n.kind === "source_replaced" && /^[؀-ۿ\s.،]+$/.test(n.textAr))).toBe(true);
    // an alternative that is not offered cannot be chosen
    const req: ManagerRequest = { kind: "bad_page", request: "x", stageNumber: 1, stageCount: 1, stageTitlesAr: ["أ"], reason: "empty", seen: 0, kept: 0, sampleRows: [], alternatives: 1 };
    expect(parseManagerReply(req, [use("decide", { action: "switch", alternate: 2 })])).toEqual({ action: "continue" });
    expect(parseManagerReply(req, [use("decide", { action: "switch", alternate: 1, reasonAr: "تبديل" })])).toEqual({ action: "switch", alternate: 1, reasonAr: "تبديل" });
  });

  it("the manager stops a stage whose rows are unsuitable: with nothing delivered the answer is an honest Arabic reason and the reserve returns", async () => {
    const m = scripted((req) => (req.kind === "first_page" && req.stageNumber === 1 ? { action: "stop", reasonAr: "الشركات التي وجدناها ليست كهروميكانيكية." } : { action: "continue" }));
    const out = await runModelPlanChunk(input(mission()), { call: world(), manager: m });
    expect(out.ok).toBe(false);
    expect(out.errorMessageAr).toContain("الشركات التي وجدناها ليست كهروميكانيكية");
    expect(out.errorMessageAr).toContain("حجز مؤقت مُحرَّر");
    expect(out.rows).toEqual([]);
  });

  it("the final review leaves one safe Arabic line for the customer's summary; an unsafe one (Latin words, a price) is dropped", async () => {
    const safe = scripted((req) => (req.kind === "final" ? { action: "final", ok: true, noteAr: "جمعنا الشركات وموظفيها وبيانات التواصل كما طلبت." } : { action: "continue" }));
    const a = await runAll(mission(), { manager: safe });
    expect(a.notes.find((n) => n.kind === "final_ok")?.textAr).toBe("جمعنا الشركات وموظفيها وبيانات التواصل كما طلبت.");
    const unsafe = scripted((req) => (req.kind === "final" ? { action: "final", ok: true, noteAr: "Done via tikhub for 5 USD" } : { action: "continue" }));
    const b = await runAll(mission(), { manager: unsafe });
    expect(b.notes.some((n) => n.kind === "final_ok" || n.kind === "final_gap")).toBe(false);
  });

  it("the real manager sends one tool call per decision on the planning model's transport and reports its real usage; its answer is parsed by code", async () => {
    const transport = createScriptedTransport([[use("decide", { keep: [0, 2, 99] })]]);
    const manager = createMissionManager(transport);
    const req: ManagerRequest = { kind: "transition", request: REQUEST, fromStage: 1, toStage: 2, stageTitlesAr: ["الشركات", "الموظفون"], rows: [0, 1, 2].map((index) => ({ index, row: { company_name: `شركة ${index}` } })) };
    const out = await manager.decide(req);
    expect(out.decision).toEqual({ action: "expand", keep: [0, 2] }); // an index that was not listed is dropped
    expect(out.usage).toMatchObject({ reason: "mission_manager_transition", model: "recorded" });
    expect(out.usage!.costUsd).toBeGreaterThan(0);
    expect(transport.requests[0].tools).toHaveLength(1);
    const failing = createMissionManager({ model: "m", send: async () => { throw new Error("planner_http_529"); } });
    const f = await failing.decide(req);
    expect(f.decision).toEqual({ action: "continue" });
    expect(f.usage?.failure).toContain("529");
  });
});

describe("customer text made by the model is made safe by code", () => {
  it("Arabic only, Arabic-Indic digits, no Latin word, no address, no money; a stage name falls back to a plain one", () => {
    expect(safeArabicSentence("جمعنا 50 شركة")).toBe("جمعنا ٥٠ شركة");
    expect(safeArabicSentence("used tikhub")).toBeNull();
    expect(safeArabicSentence("السعر 5 دولار")).toBeNull();
    expect(safeArabicSentence("**جمعنا** 😀 الشركات")).toBe("جمعنا الشركات");
    expect(safeStageTitleAr("Companies", 0, "company")).toBe("جمع الشركات");
    expect(safeStageTitleAr("", 1, "person")).toBe("جمع الأشخاص");
    expect(safeStageTitleAr(undefined, 2, null)).toBe("المرحلة ٣");
    expect(safeStageTitleAr("جمع الفيديوهات", 0, null)).toBe("جمع الفيديوهات");
  });
});

describe("reviewed recipes for the services proven on the old path", () => {
  it("seven services plus the two-step ones are seeded as reviewed recipes with no customer value in them", () => {
    const rows = seedRecipeRows();
    const endpoints = rows.map((r) => r.row.endpoint_id);
    for (const id of ["anyapi.x.user.posts", "anyapi.x.search.posts", "tikhub.tiktok.video.comments", "scrapecreators.x.v1-facebook-post-comments", "justoneapi.x.facebook-search-post-v1", "icypeas.companies.search", "icypeas.people.search"]) expect(endpoints).toContain(id);
    for (const { row } of rows) {
      expect(row.status).toBe("reviewed");
      expect(row.created_by).toBe("seed");
      expect(JSON.stringify(row)).not.toMatch(/elonmusk|@/);
    }
    expect(new Set(rows.map((r) => r.row.slug)).size).toBe(rows.length);
  });

  it("the button inserts the missing ones once, never changes a saved one, and says so when the table is not applied", async () => {
    const db = createMemoryDb();
    const first = await seedRecipes(db);
    expect(first.inserted).toBe(seedRecipeRows().length);
    expect(db.rows("recipes")).toHaveLength(seedRecipeRows().length);
    const again = await seedRecipes(db);
    expect(again).toMatchObject({ inserted: 0, present: seedRecipeRows().length });
    const missing = await seedRecipes(createMemoryDb({ missing: ["recipes"] }));
    expect(missing.tableApplied).toBe(false);
    expect(missing.inserted).toBe(0);
  });
});
