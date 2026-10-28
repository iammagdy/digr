import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { fitStagesToTotal, deliveredTotalOf } from "../src/lib/modelPlanner/stageFit";
import type { StoredStage } from "../src/lib/modelPlanner/types";
import { checkPlanProviderCapacity, recordProviderCallSpend, resetProviderBalanceCacheForTesting, setMemoryProviderDailySpendUsdForTesting } from "../src/functions/shared/providerSpend";
import { flushProviderLimitsCache } from "../src/lib/server/providerLimits";
import { invalidateProviderStatusCache, resetLastGoodProviderBalanceForTests } from "../src/lib/server/providerStatus";
import { setRealBalanceReaderForTesting } from "../src/lib/server/realProviderBalance";
import { CAPACITY_CAUSE_REASON_AR, CAPACITY_LIMITED_REASON_AR, capacityReasonAr, volumeLimitStatementAr } from "../src/lib/jobCaps";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { ProposePlanSchema } from "../src/lib/modelPlanner/types";
import { validatePlan, type StepSample, type ValidateContext } from "../src/lib/modelPlanner/validate";
import type { RecipeRecord } from "../src/lib/modelPlanner/recipes";
import { FILES_STEP_TITLE_AR, FINAL_STEP_LABEL_AR, missionView, REVIEW_STEP_TITLE_AR, ETA_PENDING_AR, type ProgressSnap } from "../src/lib/missionView";
import { contentFromPlanQuote, proposedPlanSteps, stagesOfPlanQuote } from "../src/lib/missionPanelContent";
import { resolvePlanningPending } from "../src/lib/planningClient";

const stage = (over: Partial<StoredStage> = {}): StoredStage => ({ parent: null, deliver: true, effVolume: 20, perParent: 0, titleAr: "مرحلة", ...over });

describe("one source of truth for counts: stages fitted to a total add up to it", () => {
  it("a single stage cut by capacity says the cut number, never the asked one", () => {
    const fitted = fitStagesToTotal([stage({ effVolume: 20 })], 1);
    expect(fitted.total).toBe(1);
    expect(fitted.stages[0].effVolume).toBe(1);
    expect(deliveredTotalOf(fitted.stages)).toBe(1);
  });

  it("two stages (videos, then comments per video): the fitted stages add up to the total and a child never exceeds parent x per-parent", () => {
    const stages = [stage({ deliver: false, effVolume: 10, titleAr: "المقاطع" }), stage({ parent: 0, effVolume: 200, perParent: 20, titleAr: "التعليقات" })];
    for (const total of [1, 7, 30, 120, 200]) {
      const fitted = fitStagesToTotal(stages, total);
      expect(fitted.total, `total ${total}`).toBe(deliveredTotalOf(fitted.stages));
      expect(fitted.total).toBeLessThanOrEqual(total);
      expect(fitted.total).toBeGreaterThanOrEqual(1);
      expect(fitted.stages[1].effVolume).toBeLessThanOrEqual(fitted.stages[0].effVolume * 20);
      expect(fitted.stages[0].effVolume).toBeGreaterThanOrEqual(1);
    }
    // a total that is already satisfied changes nothing
    expect(fitStagesToTotal(stages, 500).stages.map((s) => s.effVolume)).toEqual([10, 200]);
  });

  it("a feeder never collects more than its children need after the cut", () => {
    const fitted = fitStagesToTotal([stage({ deliver: false, effVolume: 50 }), stage({ parent: 0, effVolume: 50, perParent: 1 })], 5);
    expect(fitted.stages[1].effVolume).toBe(5);
    expect(fitted.stages[0].effVolume).toBeLessThanOrEqual(5);
  });

  it("the panel before approval shows exactly the card's stages and the two final steps labelled as final", () => {
    const quote = { items: [{ params: { _modelStep: { steps: [{}, {}], stages: [stage({ deliver: false, effVolume: 3, titleAr: "المقاطع" }), stage({ parent: 0, effVolume: 6, perParent: 2, titleAr: "التعليقات" })] } } }] };
    const stages = stagesOfPlanQuote(quote)!;
    expect(stages.map((s) => s.effVolume)).toEqual([3, 6]);
    const steps = contentFromPlanQuote(quote)!.steps;
    expect(steps.map((s) => s.titleAr)).toEqual(["المقاطع", "التعليقات", REVIEW_STEP_TITLE_AR, FILES_STEP_TITLE_AR]);
    expect(steps.slice(-2).map((s) => s.detailAr)).toEqual([FINAL_STEP_LABEL_AR, FINAL_STEP_LABEL_AR]);
    expect(proposedPlanSteps(stages).every((s) => s.state === "waiting")).toBe(true);
  });

  it("the panel of a finished mission shows the delivered counts, which add up to what the job delivered", () => {
    const stages = [{ titleAr: "المقاطع", deliver: false, effVolume: 3 }, { titleAr: "التعليقات", deliver: true, effVolume: 6 }];
    const snap: ProgressSnap = { at: 1, stages: [{ c: 3, d: 0, x: 0, e: 3, q: 0, done: true }, { c: 9, d: 9, x: 0, e: 6, q: 0, done: true }], delivered: 9 };
    const view = missionView({ stages, snaps: [snap], phase: "completed", now: 10, deliveredTotal: 1 });
    expect(view.steps[1].countAr).toMatch(/١ من ٦/);
    expect(view.steps.map((s) => s.titleAr).slice(-2)).toEqual([REVIEW_STEP_TITLE_AR, FILES_STEP_TITLE_AR]);
  });

  it("the remaining-time line appears only once the stage's real speed is measured", () => {
    const stages = [{ titleAr: "التعليقات", deliver: true, effVolume: 100 }];
    const at = (t: number, c: number): ProgressSnap => ({ at: t, stages: [{ c, d: c, x: 0, e: 100, q: 0, done: false }], delivered: c });
    const first = missionView({ stages, snaps: [at(1_000, 0)], phase: "running", now: 2_000 });
    expect(first.remainingAr).toBeNull();
    expect(first.steps[0].etaAr).toBe(ETA_PENDING_AR);
    const measured = missionView({ stages, snaps: [at(1_000, 0), at(31_000, 10), at(61_000, 20)], phase: "running", now: 62_000 });
    expect(measured.remainingAr).toBeTruthy();
    expect(measured.remainingAr).not.toBe(ETA_PENDING_AR);
  });
});

describe("capacity: the count is cut by a named limit, and an unreadable balance does not cut it", () => {
  const saved = { credit: process.env.PROVIDER_CREDIT_USD, cap: process.env.PROVIDER_DAILY_SPEND_CAP_USD };
  beforeEach(() => {
    delete process.env.PROVIDER_CREDIT_USD;
    process.env.PROVIDER_DAILY_SPEND_CAP_USD = "10";
    resetProviderBalanceCacheForTesting(); flushProviderLimitsCache(); resetLastGoodProviderBalanceForTests(); invalidateProviderStatusCache(); setRealBalanceReaderForTesting(null);
  });
  afterEach(() => {
    setRealBalanceReaderForTesting(null);
    for (const [k, v] of [["PROVIDER_CREDIT_USD", saved.credit], ["PROVIDER_DAILY_SPEND_CAP_USD", saved.cap]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetProviderBalanceCacheForTesting(); flushProviderLimitsCache(); resetLastGoodProviderBalanceForTests(); invalidateProviderStatusCache();
  });

  it("THE INCIDENT: 3.68 USD recorded in all, no credit configured, the live read failed -> the balance is UNKNOWN and 20 tweets stay 20 (they were cut to 1)", async () => {
    await recordProviderCallSpend(3_680_000);
    setMemoryProviderDailySpendUsdForTesting(0.2);
    setRealBalanceReaderForTesting(async () => null);
    const unitCost = 0.21 / 5500;
    const check = await checkPlanProviderCapacity(20, 20 * unitCost, null);
    expect(check.balanceSource).toBe("unknown");
    expect(check.allowed).toBe(true);
    expect(check.downscaled).toBe(false);
    expect(check.maxSafeVolume).toBe(20);
  });

  it("a configured credit that the recorded spend has passed is not a balance either (the account was recharged)", async () => {
    process.env.PROVIDER_CREDIT_USD = "1";
    await recordProviderCallSpend(3_680_000);
    setRealBalanceReaderForTesting(async () => null);
    expect((await checkPlanProviderCapacity(1, 0.01, null)).balanceSource).toBe("unknown");
  });

  it("a configured credit with room left is still the estimate, and cuts the volume to what fits", async () => {
    process.env.PROVIDER_CREDIT_USD = "5";
    await recordProviderCallSpend(3_680_000);
    setRealBalanceReaderForTesting(async () => null);
    const check = await checkPlanProviderCapacity(1000, 0.01, null);
    expect(check.balanceSource).toBe("estimate");
    expect(check.limitedBy).toBe("balance");
    expect(check.maxSafeVolume).toBe(Math.floor(((5 - 3.68) * 0.9) / 0.01));
  });

  it("the cause of the cut is named: the real balance, the day's limit or the customer's own limit", async () => {
    setRealBalanceReaderForTesting(async () => ({ usd: 0.5, at: Date.now() }));
    expect((await checkPlanProviderCapacity(1000, 0.01, null)).limitedBy).toBe("balance");
    setRealBalanceReaderForTesting(async () => ({ usd: 50, at: Date.now() }));
    setMemoryProviderDailySpendUsdForTesting(9.9);
    expect((await checkPlanProviderCapacity(1000, 0.01, null)).limitedBy).toBe("daily");
    setMemoryProviderDailySpendUsdForTesting(0);
    expect((await checkPlanProviderCapacity(1000, 0.01, null, { userRemainingUsd: 0.05 })).limitedBy).toBe("user");
  });

  it("the card says the real reason in plain Arabic (no provider, endpoint or amount), and the sentence's two numbers are the asked and the fitted count", () => {
    for (const cause of ["balance", "daily", "user"] as const) {
      const text = capacityReasonAr(cause);
      expect(text).toBe(CAPACITY_CAUSE_REASON_AR[cause]);
      expect(text).not.toMatch(/[A-Za-z]|USD|\$/);
    }
    expect(capacityReasonAr(undefined)).toBe(CAPACITY_LIMITED_REASON_AR);
    expect(new Set(["balance", "daily", "user"].map((c) => capacityReasonAr(c))).size).toBe(3);
    const statement = volumeLimitStatementAr({ askedUnits: 20, fittedUnits: 1, reason: "capacity" })!;
    expect(statement).toContain("٢٠");
    expect(statement).toContain("١");
    expect(volumeLimitStatementAr({ askedUnits: 20, fittedUnits: 20, reason: "capacity" })).toBeNull();
  });
});

describe("price stability: a reviewed recipe's measurement is the price basis, whatever page size today's sample showed", () => {
  const catalog = loadTregCatalog();
  const fixture = JSON.parse(readFileSync("tests/fixtures/replay/real-rows_anyapi.x.user.posts.json", "utf-8"));
  const xRows: Array<Record<string, unknown>> = fixture.pages[0].rows;
  const xEndpoint = catalog.byId.get("anyapi.x.user.posts")!;
  const plan = ProposePlanSchema.parse({
    summaryAr: "جمع ١٠ منشورات من حساب @elonmusk",
    steps: [{
      endpointId: "anyapi.x.user.posts", volume: 10,
      params: [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }],
      fieldMap: { columns: [{ field: "text", headerAr: "نص المنشور", role: "text" }, { field: "authorHandle", headerAr: "الحساب", role: "author_handle" }, { field: "createdUtc", headerAr: "تاريخ النشر", role: "date" }], pagination: { kind: "token", param: "cursor" } },
      filters: [{ kind: "author_equals", field: "authorHandle", value: "elonmusk", quote: "@elonmusk" }],
    }],
  });
  const sampleWithPages = (pageRows: number[]): StepSample => ({ endpointId: "anyapi.x.user.posts", rows: xRows, digest: buildShapeDigest({ rows: xRows }, xEndpoint).digest, costUsd: 0.0005, pageRows } as StepSample);
  const recipe = (status: "draft" | "reviewed"): RecipeRecord => ({ slug: "r", status, endpointIds: ["anyapi.x.user.posts"], knownFields: ["text", "authorHandle", "createdUtc"], measured: [{ rowsPerCall: 20, passRate: 1 }], steps: [] });
  const priceOf = (pageRows: number[], rec?: RecipeRecord) => {
    const ctx: ValidateContext = { customerText: "أريد ١٠ منشورات من حساب @elonmusk على منصة X", access: { isAdmin: false, verifiedBusiness: false }, catalog, samples: new Map([["anyapi.x.user.posts", sampleWithPages(pageRows)]]), today: new Date("2026-10-27T12:00:00Z"), ...(rec ? { recipes: new Map([["anyapi.x.user.posts", rec]]) } : {}) } as ValidateContext;
    const r = validatePlan(plan, ctx);
    if (!r.ok) throw new Error(`plan refused: ${r.issues.map((i) => i.code).join(",")}`);
    return { unit: r.plan.price.unitPricePoints, from: r.plan.stored.measured?.[0]?.from, rows: r.plan.steps[0].price.rowsPerCall };
  };

  it("without a reviewed recipe the price follows the sample (15 rows one day, 20 the next): the wobble the recipe removes", () => {
    const a = priceOf([15, 15]);
    const b = priceOf([20, 20]);
    expect(a.from).toBe("sample");
    expect(a.unit).not.toBe(b.unit);
  });

  it("with a REVIEWED recipe both days get the same price, taken from the recipe, and the price path is recorded as «recipe»", () => {
    const a = priceOf([15, 15], recipe("reviewed"));
    const b = priceOf([20, 20], recipe("reviewed"));
    expect(a.unit).toBe(b.unit);
    expect(a.from).toBe("recipe");
    expect(b.from).toBe("recipe");
    expect(a.rows).toBe(20);
  });

  it("a DRAFT recipe only helps the planner: the price still follows the sample", () => {
    const a = priceOf([15, 15], recipe("draft"));
    expect(a.from).toBe("sample");
  });

  it("a reviewed recipe that does not know the plan's fields does not set the price", () => {
    const narrow: RecipeRecord = { ...recipe("reviewed"), knownFields: ["text"] };
    expect(priceOf([15, 15], narrow).from).toBe("sample");
  });
});

describe("the page's planning loop: it asks for the next step until the session is done", () => {
  const first = { outputType: "planning_pending", planning: { sessionId: "session_abcdefgh" } };
  const jsonResponse = (body: unknown) => ({ json: async () => body }) as Response;

  it("a plain answer is returned as it is (no request)", async () => {
    let calls = 0;
    const plain = { outputType: "answer_question", contentAr: "x" };
    expect(await resolvePlanningPending(plain as any, { headers: {}, fetchFn: (async () => { calls += 1; return jsonResponse({}); }) as any })).toBe(plain);
    expect(calls).toBe(0);
  });

  it("steps until done, survives a step that did not arrive, and carries the final answer as if the chat route had given it", async () => {
    const answers = [{ status: "running" }, "throw", { status: "running" }, { status: "done", response: { outputType: "propose_plan", planQuote: { quoteId: "q1" } } }];
    const urls: string[] = [];
    const out = await resolvePlanningPending(first as any, {
      headers: { authorization: "Bearer t" },
      sleep: async () => undefined,
      fetchFn: (async (url: string) => { urls.push(String(url)); const a = answers.shift(); if (a === "throw") throw new Error("network"); return jsonResponse(a); }) as any,
    });
    expect(out.outputType).toBe("propose_plan");
    expect((out as any).planQuote.quoteId).toBe("q1");
    expect(urls).toEqual(Array(4).fill("/api/chat/planning/session_abcdefgh/step"));
  });

  it("a failed session and a session that never ends are reported, not looped forever", async () => {
    await expect(resolvePlanningPending(first as any, { headers: {}, sleep: async () => undefined, fetchFn: (async () => jsonResponse({ status: "failed" })) as any })).rejects.toThrow("planning_failed");
    let t = 0;
    await expect(resolvePlanningPending(first as any, { headers: {}, sleep: async () => undefined, now: () => (t += 60_000), maxMs: 120_000, fetchFn: (async () => jsonResponse({ status: "running" })) as any })).rejects.toThrow("planning_timeout");
  });
});

describe("sample calls on a per-record price never ask for all that is left of the budget", () => {
  it("asks for at most SAMPLE_BUDGET_SHARE_PER_RECORD of what is left (a 0.05 USD budget at 0.00894 USD per record asks for 2 rows, not 5)", async () => {
    const { runSampleCall, resetExplorationMemoryForTesting } = await import("../src/lib/modelPlanner/exploration");
    const { createMemoryDb } = await import("./helpers/memoryDb");
    const { stubGateway } = await import("./helpers/plannerKit");
    const { SAMPLE_BUDGET_SHARE_PER_RECORD } = await import("../src/lib/modelPlanner/constants");
    resetExplorationMemoryForTesting();
    const gateway = stubGateway({ "openmart.businesses.search": { rows: [{ name: "a" }, { name: "b" }] } }, { "openmart.businesses.search": 1000 });
    try {
      const params = [{ name: "query", value: "مقاولات", source: "customer_text" as const, quote: "مقاولات" }];
      await runSampleCall({ id: "openmart.businesses.search", params }, { customerText: "شركات مقاولات", access: { isAdmin: false, verifiedBusiness: false }, catalog: loadTregCatalog(), samples: new Map() }, { client: createMemoryDb(), requestId: "req_clamp", userId: "u1", requestCapUsd: 0.05 });
      expect(gateway.calls).toHaveLength(1);
      expect(gateway.calls[0].body.limit).toBe(Math.floor((0.05 * SAMPLE_BUDGET_SHARE_PER_RECORD + 1e-12) / 0.00894));
      expect(gateway.calls[0].body.limit).toBeLessThan(Math.floor(0.05 / 0.00894));
    } finally { gateway.restore(); }
  });
});
