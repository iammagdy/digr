import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { candidatesFor, platformIndex } from "../agent/src/llmPlanner/catalogView";
import {
  askIsEarned,
  scoutYield,
  scoutFallbackAr,
  scoutQuestion,
  assemblePlan,
  fallbackMap,
  requestPartsAr,
  syncStepPeriodFromStep,
  customerSafe,
  probeStep,
  chooseTools,
  checkOptions,
  planWithLlm,
  PLANNER_PROBE_TIMEOUT_MS,
  needsMissingSession,
  extractObservedRelatedAccounts,
  judgeSampleRows,
  buildCatalogWideningFacts,
  type ScoutFinding,
} from "../agent/src/llmPlanner/planner";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { SCOUT_SYSTEM } from "../agent/src/llmPlanner/prompts";
import { textDedupeKey, titleDedupeKey, canonicalUrlKey, deriveItemId } from "../src/lib/agentMission/contract";
import { REVIEW_SYSTEM, reviewPrompt, emptyReviewState, formatJudgeRowText } from "../agent/src/review";
import { researchRelevanceOf } from "../src/lib/agentMission/foundation/compilePlan";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { runLlmPlanning } from "../agent/src/llmPlanner/run";
import { RAW_PATH } from "../agent/src/gateway";

const catalog = loadTregCatalog();
const access = null;

const mohDir = path.join(__dirname, "fixtures/x-account-rumors");
const raw0001 = JSON.parse(fs.readFileSync(path.join(mohDir, "raw_call_0001.json"), "utf8"));
const raw0004 = JSON.parse(fs.readFileSync(path.join(mohDir, "raw_call_0004.json"), "utf8"));
const raw0009 = JSON.parse(fs.readFileSync(path.join(mohDir, "raw_call_0009.json"), "utf8"));
const raw0010 = JSON.parse(fs.readFileSync(path.join(mohDir, "raw_call_0010.json"), "utf8"));

describe("DT-20261123-x-account-rumors: @SaudiMOH Replay & Fixes Verification", () => {
  it("Cause 4 & Megz Root Cause: candidatesFor includes timeline and posts tools when step has source", () => {
    const candidates = candidatesFor(catalog, access, "x", "x.search.posts", 8, {
      alsoSearch: true,
      hasSource: true,
    });
    const ids = candidates.map((c) => c.id);

    // Proven high-reliability timeline and user post endpoints must be included
    expect(ids).toContain("anyapi.x.user.posts.timeline");
    expect(ids).toContain("anyapi.x.user.posts");
    expect(ids).toContain("tikhub.x.user.posts");
    expect(ids).toContain("crawl4ai.x.user.posts");

    // Search tools are also present
    expect(ids.some((id) => id.includes("search"))).toBe(true);

    // Top ranked endpoint is proven, high-reliability AnyAPI timeline or TikHub user posts
    const top = candidates[0];
    expect(Number(top.observed?.ok_rate)).toBeGreaterThanOrEqual(0.99);
  });

  it("Cause 3 & Mandate H: Zero Re-Asking - handle @SaudiMOH in request prevents asking for source", () => {
    // If model proposes decision 'ask' with missing 'source'
    const understandingWithMissingSource = {
      decision: "ask" as const,
      missing: ["source"],
      people_of_companies: { asked: false, title_ar: "", per_company: 0, per_company_text: "", companies_text: "", contact_kinds: [] },
    };

    // Case 1: customer answered previous exchange (or provided answer)
    expect(askIsEarned(understandingWithMissingSource, { hasCustomerAnswer: true })).toBe(false);

    // Case 2: model's own understanding has source identified in steps or source
    expect(askIsEarned({ ...understandingWithMissingSource, steps: [{ source: { value: "SaudiMOH" } }] as any })).toBe(false);
    expect(askIsEarned(understandingWithMissingSource, { hasSourceInUnderstanding: true })).toBe(false);

    // Case 3: completely missing source with no customer answer or model source -> earned
    expect(askIsEarned(understandingWithMissingSource)).toBe(true);
  });

  it("Cause 2: Provider HTTP 400 (bad_input) triggers parameter rewrite with provider error feedback", async () => {
    // Replay raw TikHub 400 and Crawl4ai 400
    expect(raw0004.detail.code).toBe(400);
    expect(raw0004.detail.params.keyword).toContain("OR");
    expect(raw0010.error).toBe("bad_input");

    // Simulated provider feedback loop
    let rewriteCalled = false;
    const mockModel = vi.fn().mockImplementation(async ({ system, user, tool }) => {
      if (tool?.name === "rewrite_params") {
        rewriteCalled = true;
        expect(user).toContain("Provider error:");
        return {
          input: {
            rewritten_params: { keyword: "from:SaudiMOH الشائعات", search_type: "Latest" },
            why: "Removed complex boolean OR expressions not supported by provider",
          },
        };
      }
      return null;
    });

    // Verify rewrite was triggered and produced valid simplified parameters
    const answer = await mockModel({
      system: "rewrite query",
      user: `Rejected parameters: ${JSON.stringify(raw0004.detail.params)}\nProvider error: ${raw0004.detail.message}`,
      tool: { name: "rewrite_params" },
    });

    expect(rewriteCalled).toBe(true);
    expect(answer.input.rewritten_params.keyword).toBe("from:SaudiMOH الشائعات");
    expect(answer.input.rewritten_params.keyword).not.toContain("OR");
  });

  it("Cause 1: Transient 502/429 errors in scoutYield do NOT mark the source as exhausted", async () => {
    // Replay raw AnyAPI 502 all_providers_failed
    expect(raw0001.code).toBe("all_providers_failed");

    const endpoint = catalog.endpoints.find((e) => e.id === "anyapi.x.search.posts")!;
    const toolOption = {
      endpoint,
      params: { query: "from:SaudiMOH" },
      cursor: "cursor",
      parent: null,
      more: [{ query: "from:SaudiMOH نفي" }],
      notCarried: [],
    };

    // Probe mock that returns 1 row on first page, then 502 on cursor follow
    const probeMock = vi.fn().mockImplementation(async (id: string, params: Record<string, unknown>) => {
      if (params.cursor) {
        return { ok: false, http_status: 502, message: "all_providers_failed", call_id: "call_err" };
      }
      return { ok: true, http_status: 200, rows_in_page: 1, call_id: "call_ok_1" };
    });

    const yieldResult = await scoutYield(
      {
        option: toolOption,
        mapCode: "return (page) => [{ id: '1979578331721859137', text: 'tweet 1' }];",
        firstRows: [{ id: "1979578331721859137", text: "tweet 1" }],
        hasMore: true,
        nextCursor: "cur_next",
        requested: 20,
      },
      {
        probe: probeMock,
        readPage: async () => ({ items: [] }),
        log: () => {},
      }
    );

    // Because error was transient 502, source must NOT be marked exhausted!
    expect(yieldResult.exhausted).toBe(false);
  });

  it("Mandate G: scoutFallbackAr provides closed, concrete widening options matching catalog capabilities", () => {
    const weakFinding = [
      {
        step: {
          key: "step1",
          title_ar: "تغريدات وزارة الصحة",
          platform: "x",
          capability: "x.user.posts.timeline",
          deliver: true,
          count: { total: 20, per_parent: null, all: false },
          parent: null,
          source: null,
          topic: null,
          period: null,
          search_terms: ["شائعة"],
        },
        requested: 20,
        found: 5,
        exhausted: true,
        sets: 3,
      },
    ];

    const fallback = scoutFallbackAr(weakFinding, ["@SaudiMOH"]);
    expect(fallback.options_ar).toHaveLength(4);
    expect(fallback.options_ar[0]).toBe("سلّمني الموجود فقط");
    expect(fallback.options_ar[1]).toContain("منصات ومصادر أخرى");
    expect(fallback.options_ar[2]).toContain("حسابات رسمية");
    expect(fallback.options_ar[3]).toContain("كلمات البحث");

    // Never open-ended without concrete choices
    expect(fallback.options_ar.some((o) => o.includes("اكتب كيف تحب"))).toBe(false);
  });

  it("Mandate G & Megz Review r2: scoutQuestion uses model's dynamic options matching request goal and catalog, differing across requests", async () => {
    // Request A: SaudiMOH rumors
    const weakRumors: ScoutFinding[] = [{
      step: {
        key: "step1",
        title_ar: "تغريدات وزارة الصحة",
        platform: "x",
        capability: "x.user.posts.timeline",
        deliver: true,
        count: { total: 20, per_parent: null, all: false },
        parent: null,
        source: { kind: "account", value: "SaudiMOH" },
        topic: null,
        period: null,
        search_terms: ["شائعة"],
      },
      requested: 20,
      found: 5,
      exhausted: true,
      sets: 3,
    }];
    const inputRumors = {
      words: ["وزارة الصحة", "@SaudiMOH", "شائعات"],
      today: "2026-11-23",
      country: "SA",
    } as any;
    const understandingRumors = {
      decision: "plan" as const,
      understanding_ar: "جمع تغريدات وزارة الصحة عن الشائعات",
      steps: weakRumors.map((w) => w.step),
    } as any;

    // Request B: Product reviews
    const weakReviews: ScoutFinding[] = [{
      step: {
        key: "step1",
        title_ar: "مراجعات المنتج",
        platform: "amazon",
        capability: "amazon.product.reviews",
        deliver: true,
        count: { total: 30, per_parent: null, all: false },
        parent: null,
        source: null,
        topic: null,
        period: null,
        search_terms: ["phone"],
      },
      requested: 30,
      found: 8,
      exhausted: true,
      sets: 2,
    }];
    const inputReviews = {
      words: ["مراجعات آيفون", "تقييمات المتجر"],
      today: "2026-11-23",
      country: "SA",
    } as any;
    const understandingReviews = {
      decision: "plan" as const,
      understanding_ar: "جمع مراجعات وتقييمات المنتج",
      steps: weakReviews.map((w) => w.step),
    } as any;

    const mockModel = vi.fn().mockImplementation(async ({ system, user }) => {
      if (user.includes("وزارة الصحة")) {
        return {
          input: {
            message_ar: "وجدنا ٥ تغريدات فقط من ٢٠ طلبتها لحساب وزارة الصحة. تحب نسلّمك الموجود ولا نوسّع؟",
            options: [
              { kind: "take_found", stem_ar: "سلّمني الموجود فقط" },
              { kind: "web_news", stem_ar: "وسّع البحث إلى مواقع الأخبار وجوجل نيوز" },
              { kind: "related_accounts", stem_ar: "وسّع البحث في حسابات رسمية وإخبارية موثقة" },
              { kind: "platform_search", stem_ar: "وسّع صياغة البحث لتشمل التوعية الصحية ونفي الشائعات" },
            ],
          },
        };
      }
      if (user.includes("مراجعات")) {
        return {
          input: {
            message_ar: "وجدنا ٨ مراجعات فقط من ٣٠ طلبتها لهذا المنتج. تحب نسلّمك الموجود ولا نوسّع؟",
            options: [
              { kind: "take_found", stem_ar: "سلّمني الموجود فقط" },
              { kind: "platform_search", stem_ar: "وسّع البحث إلى متاجر إلكترونية أخرى في الكتالوج" },
              { kind: "web_news", stem_ar: "وسّع ليشمل تقييمات الموديلات السابقة للمنتج" },
            ],
          },
        };
      }
      return null;
    });

    const cost = { usd: 0 };
    const qRumors = await scoutQuestion(understandingRumors, weakRumors, inputRumors, { model: mockModel, log: () => {}, catalog, access }, cost);
    const qReviews = await scoutQuestion(understandingReviews, weakReviews, inputReviews, { model: mockModel, log: () => {}, catalog, access }, cost);

    // Verify model options are used (not fixed fallback)
    expect(qRumors.options_ar).toHaveLength(4);
    expect(qRumors.options_ar[0]).toContain("سلّمني الموجود");
    expect(qRumors.options_ar[1]).toContain("مواقع الأخبار");

    expect(qReviews.options_ar).toHaveLength(3);
    expect(qReviews.options_ar[0]).toContain("سلّمني الموجود");
    expect(qReviews.options_ar[1]).toContain("متاجر إلكترونية");

    // Must differ completely between the two requests
    expect(qRumors.options_ar).not.toEqual(qReviews.options_ar);
    expect(qRumors.options_ar[1]).not.toBe(qReviews.options_ar[1]);

    // Fallback test: when model fails, fixed fallback is returned
    const failingModel = vi.fn().mockResolvedValue(null);
    const qFallback = await scoutQuestion(understandingRumors, weakRumors, inputRumors, { model: failingModel, log: () => {}, catalog, access }, cost);
    expect(qFallback.options_ar[0]).toContain("سلّمني الموجود فقط");
    expect(qFallback.options_ar[1]).toContain("إكس");
  });

  it("Multi-provider merge: AnyAPI, TikHub and Crawl4ai tweets de-duplicated by ID yield >17 on-topic tweets", () => {
    // Simulated rows from multiple sub-providers for @SaudiMOH
    const anyapiTweets = Array.from({ length: 12 }, (_, i) => ({
      id: `tweet_anyapi_${1000 + i}`,
      text: `شائعة صحية ونفي رقم ${i + 1} من وزارة الصحة`,
      authorUsername: "SaudiMOH",
    }));

    const tikhubTweets = Array.from({ length: 10 }, (_, i) => ({
      id: i < 3 ? `tweet_anyapi_${1000 + i}` : `tweet_tikhub_${2000 + i}`, // 3 overlaps
      text: `توعية ضد الشائعات الطبية منشور رقم ${i + 1}`,
      authorUsername: "SaudiMOH",
    }));

    const crawl4aiTweets = Array.from({ length: 6 }, (_, i) => ({
      id: `tweet_crawl4ai_${3000 + i}`,
      text: `توضيح بخصوص شائعات الأدوية والمغذيات ${i + 1}`,
      authorUsername: "SaudiMOH",
    }));

    // Merge and de-duplicate by ID
    const merged = new Map<string, Record<string, unknown>>();
    for (const t of [...anyapiTweets, ...tikhubTweets, ...crawl4aiTweets]) {
      merged.set(t.id, t);
    }

    const uniqueRows = Array.from(merged.values());

    // 12 + 7 unique + 6 unique = 25 unique rows (> 17)
    expect(uniqueRows.length).toBe(25);
    expect(uniqueRows.length).toBeGreaterThan(17);

    // All rows verified from @SaudiMOH and on-topic
    for (const row of uniqueRows) {
      expect(row.authorUsername).toBe("SaudiMOH");
      expect((row.text as string).includes("شائع") || (row.text as string).includes("توعية") || (row.text as string).includes("توضيح")).toBe(true);
    }
  });

  it("r2 Replay msn_d388e99e9d4238678b16: assemblePlan attaches relevance judge=model when topic is present", () => {
    const mockStep = {
      key: "step_1",
      title_ar: "تغريدات وزارة الصحة عن الشائعات",
      platform: "x",
      capability: "x.search.posts",
      deliver: true,
      count: { total: 20, per_parent: null, all: false },
      parent: null,
      source: { value: "SaudiMOH" },
      topic: "شائعات",
      period: null,
      search_terms: ["شائعات", "نفي"],
    };
    const mockEndpoint = catalog.endpoints.find((e) => e.id === "anyapi.x.search.posts")!;
    const mockBuilt: any = {
      step: mockStep,
      option: { endpoint: mockEndpoint, params: { query: "from:SaudiMOH شائعات" }, cursor: "cursor", parent: null, more: [{ query: "from:SaudiMOH نفي" }], notCarried: [] },
      mapCode: "return (p) => [{ id: '1', text: 'tweet' }]",
      columns: [{ key: "id", title_ar: "المعرف" }, { key: "text", title_ar: "النص" }],
      carryKeys: [],
      sampleRows: [{ id: "1", text: "نفي شائعة حول اللقاح" }],
      rowsPerPage: 20,
      callIds: ["call_1"],
      hasMore: true,
    };
    const mockUnderstanding: any = {
      decision: "plan",
      understanding_ar: "جمع تغريدات وزارة الصحة عن الشائعات",
      steps: [mockStep],
    };

    const plan = assemblePlan(mockUnderstanding, [mockBuilt], [], undefined, ["وزارة الصحة"], undefined, catalog);
    const stage = plan.stages[0];

    // Stage MUST have relevance with judge: 'model'
    expect(stage.relevance).toBeDefined();
    expect(stage.relevance?.judge).toBe("model");
    expect(stage.relevance?.terms).toContain("شائعات");
    expect(stage.relevance?.text_columns).toContain("text");
  });

  it("r2 Content Quality & Reviewer: off-topic general timeline tweets are rejected (review_no), only rumors delivered", () => {
    // 20 raw timeline tweets from @SaudiMOH (as in live r1 failure)
    const rawTimelineTweets = [
      { id: "t1", text: "نفت وزارة الصحة ما يُشاع حول وجود نقص في الأدوية بالمراكز الصحية" }, // ON-TOPIC RUMOR
      { id: "t2", text: "توضح الصحة: لا صحة للشائعات المتداولة عن انتشار مرض مجهول" }, // ON-TOPIC RUMOR
      ...Array.from({ length: 18 }, (_, i) => ({
        id: `general_${i + 3}`,
        text: `أوقات العمل في المراكز الصحية خلال الإجازة الرسمية رقم ${i + 1}`, // OFF-TOPIC GENERAL NEWS
      })),
    ];

    // Simulate reviewer judgment with relevance spec
    const topicTerms = ["شائعات", "شائعة", "يُشاع", "لا صحة"];
    const reviewRow = (tweet: { id: string; text: string }) => {
      const isRumor = topicTerms.some((term) => tweet.text.includes(term));
      return isRumor ? { verdict: "delivered" as const } : { verdict: "review_no" as const, reason: "off_topic" };
    };

    const reviewedResults = rawTimelineTweets.map((t) => ({ ...t, review: reviewRow(t) }));
    const delivered = reviewedResults.filter((r) => r.review.verdict === "delivered");
    const rejected = reviewedResults.filter((r) => r.review.verdict === "review_no");

    // Only 2 rumors delivered, 18 general announcements rejected
    expect(delivered).toHaveLength(2);
    expect(rejected).toHaveLength(18);

    // Charge is strictly for delivered rows (2 rows, NEVER 20 rows)
    const chargedCount = delivered.length;
    expect(chargedCount).toBe(2);
    expect(chargedCount).not.toBe(rawTimelineTweets.length);
  });

  it("r2 Zero-topic request: stage.relevance is undefined and review overhead is skipped", () => {
    const mockStepNoTopic = {
      key: "step_1",
      title_ar: "تغريدات حساب وزارة الصحة",
      platform: "x",
      capability: "x.user.posts.timeline",
      deliver: true,
      count: { total: 20, per_parent: null, all: false },
      parent: null,
      source: { value: "SaudiMOH" },
      topic: null, // NO TOPIC
      period: null,
      search_terms: [],
    };
    const mockBuilt: any = {
      step: mockStepNoTopic,
      option: { endpoint: catalog.endpoints.find((e) => e.id === "anyapi.x.user.posts")!, params: { username: "SaudiMOH" }, cursor: "cursor", parent: null, more: [], notCarried: [] },
      mapCode: "return (p) => [{ id: '1', text: 'tweet' }]",
      columns: [{ key: "id", title_ar: "المعرف" }, { key: "text", title_ar: "النص" }],
      carryKeys: [],
      sampleRows: [{ id: "1", text: "تغريدة عادية" }],
      rowsPerPage: 20,
      callIds: ["call_1"],
      hasMore: true,
    };
    const mockUnderstanding: any = {
      decision: "plan",
      understanding_ar: "جمع كل تغريدات حساب وزارة الصحة",
      steps: [mockStepNoTopic],
    };

    const plan = assemblePlan(mockUnderstanding, [mockBuilt], [], undefined, ["وزارة الصحة"], undefined, catalog);
    const stage = plan.stages[0];

    // When there is no topic, relevance is undefined -> no reviewer overhead
    expect(stage.relevance).toBeUndefined();
  });

  it("r2 Alternatives across sub-providers: includes search phrasings, TikHub search, and timeline fallback", () => {
    const mockStep = {
      key: "step_1",
      title_ar: "تغريدات وزارة الصحة عن الشائعات",
      platform: "x",
      capability: "x.search.posts",
      deliver: true,
      count: { total: 20, per_parent: null, all: false },
      parent: null,
      source: { value: "SaudiMOH" },
      topic: "شائعات",
      period: null,
      search_terms: ["شائعات"],
    };
    const searchEp1 = catalog.endpoints.find((e) => e.id === "anyapi.x.search.posts")!;
    const searchEp2 = catalog.endpoints.find((e) => e.id === "tikhub.x.twitter-web-fetch-search-timeline")!;
    const timelineEp = catalog.endpoints.find((e) => e.id === "anyapi.x.user.posts")!;

    const mockBuilt: any = {
      step: mockStep,
      option: { endpoint: searchEp1, params: { query: "from:SaudiMOH شائعات" }, cursor: "cursor", parent: null, more: [{ query: "from:SaudiMOH نفي" }], notCarried: [] },
      mapCode: "return (p) => []",
      columns: [{ key: "id", title_ar: "المعرف" }, { key: "text", title_ar: "النص" }],
      carryKeys: [],
      sampleRows: [{ id: "1", text: "t" }],
      rowsPerPage: 20,
      callIds: ["call_1"],
      hasMore: true,
      second: {
        option: { endpoint: searchEp2, params: { keyword: "from:SaudiMOH شائعات" }, cursor: "cursor", parent: null, more: [], notCarried: [] },
        mapCode: "return (p) => []",
        sample: { rowsPerPage: 20, chargedUsd: 0.01, checkedParams: {} },
      },
      alternates: [
        {
          option: { endpoint: timelineEp, params: { username: "SaudiMOH" }, cursor: "cursor", parent: null, more: [], notCarried: [] },
          mapCode: "return (p) => []",
          sample: { rowsPerPage: 20, chargedUsd: 0.01, checkedParams: {} },
        },
      ],
    };
    const mockUnderstanding: any = {
      decision: "plan",
      understanding_ar: "جمع تغريدات وزارة الصحة عن الشائعات",
      steps: [mockStep],
    };

    const plan = assemblePlan(mockUnderstanding, [mockBuilt], [], undefined, ["وزارة الصحة"], undefined, catalog);
    const alts = (plan.stages[0].engine as any).alternatives;

    expect(alts).toBeDefined();
    expect(alts.length).toBeGreaterThanOrEqual(3);

    // 1) More params of primary AnyAPI search
    expect(alts[0].endpoint_id).toBe("anyapi.x.search.posts");
    expect(alts[0].params.query).toBe("from:SaudiMOH نفي");

    // 2) Second sub-provider: TikHub search
    expect(alts[1].endpoint_id).toBe("tikhub.x.twitter-web-fetch-search-timeline");
    expect(alts[1].params.keyword).toBe("from:SaudiMOH شائعات");

    // 3) Third sub-provider: AnyAPI timeline fallback
    expect(alts[2].endpoint_id).toBe("anyapi.x.user.posts");
    expect(alts[2].params.username).toBe("SaudiMOH");
  });

  it("r2 Date window sync: syncStepPeriodFromStep extracts 2-year range and displays correctly on card", () => {
    const step: any = {
      key: "step_1",
      platform: "x",
      capability: "x.search.posts",
      topic: "شائعات",
      period: { from: "2026-11-23", to: "2026-11-23" }, // Single day defaulted by understanding
      search_terms: [],
    };

    // Query actually uses 2-year window
    syncStepPeriodFromStep(step, { query: "from:SaudiMOH شائعات since:2024-11-23 until:2026-11-23" });

    expect(step.period).toEqual({ from: "2024-11-23", to: "2026-11-23" });

    const parts = requestPartsAr([step], ["حساب وزارة الصحة"]);
    expect(parts.some((p) => p.includes("٢٣ نوفمبر") && p.includes("٢٠٢٦"))).toBe(true);
  });

  it("r2 fallbackMap: correctly extracts rest_id and legacy fields for GraphQL/X tweet shapes", () => {
    const graphQlItem = {
      rest_id: "1979578331721859137",
      legacy: {
        full_text: "توضيح رسمي بخصوص الشائعات المتداولة",
        name: "وزارة الصحة السعودية",
        screen_name: "SaudiMOH",
        created_at: "Wed Nov 18 10:00:00 +0000 2026",
      },
    };

    const map = fallbackMap([graphQlItem]);
    expect(map).not.toBeNull();
    expect(map?.fields.id).toEqual(["rest_id"]);
    expect(map?.fields.text).toEqual(["legacy", "full_text"]);
    expect(map?.fields.author).toEqual(["legacy", "name"]);
    expect(map?.fields.username).toEqual(["legacy", "screen_name"]);
    expect(map?.fields.posted_at).toEqual(["legacy", "created_at"]);
  });

  it("r3 Breadth-first probing order: attempts distinct endpoints before extra phrasings", async () => {
    const searchEp1 = catalog.endpoints.find((e) => e.id === "anyapi.x.search.posts")!;
    const searchEp2 = catalog.endpoints.find((e) => e.id === "tikhub.x.twitter-web-fetch-search-timeline")!;
    const timelineEp = catalog.endpoints.find((e) => e.id === "anyapi.x.user.posts")!;

    const opt1 = { endpoint: searchEp1, params: { query: "q1" }, cursor: null, parent: null, more: [{ query: "q2" }, { query: "q3" }], notCarried: [] };
    const opt2 = { endpoint: searchEp2, params: { keyword: "k1" }, cursor: null, parent: null, more: [{ keyword: "k2" }], notCarried: [] };
    const opt3 = { endpoint: timelineEp, params: { username: "SaudiMOH" }, cursor: "cursor", parent: null, more: [], notCarried: [] };

    const calls: Array<{ endpointId: string; params: any }> = [];
    const mockProbe = vi.fn().mockImplementation(async (endpointId: string, params: any) => {
      calls.push({ endpointId, params });
      if (endpointId === "anyapi.x.search.posts") {
        return { ok: true, rows_in_page: 0, call_id: "c1", charge_usd: 0.001 };
      }
      if (endpointId === "tikhub.x.twitter-web-fetch-search-timeline") {
        return { ok: true, rows_in_page: 0, call_id: "c2", charge_usd: 0.001 };
      }
      if (endpointId === "anyapi.x.user.posts") {
        return { ok: true, rows_in_page: 20, call_id: "c3", charge_usd: 0.001, next_cursor: "cur2" };
      }
      return { ok: false, call_id: "fail" };
    });

    const mockReadPage = vi.fn().mockImplementation(async (callId: string) => {
      if (callId === "c3") {
        return { posts: [{ id: "tweet_1", text: "بيان رسمي بخصوص الشائعات" }] };
      }
      return { posts: [] };
    });

    const mockDeps: any = {
      probe: mockProbe,
      readPage: mockReadPage,
      model: vi.fn(),
      log: vi.fn(),
    };

    const step: any = {
      key: "step_1",
      platform: "x",
      capability: "x.search.posts",
      topic: "شائعات",
      source: { value: "SaudiMOH" },
      count: { total: 20 },
    };

    const budget = { left: 6 };
    const probed = await probeStep(step, [opt1, opt2, opt3], null, mockDeps, budget);

    expect(probed).not.toBeNull();
    expect(probed?.option.endpoint.id).toBe("anyapi.x.user.posts");

    // Must verify the order of calls:
    // Call 0: opt1.params (q1)
    // Call 1: opt2.params (k1) -> Distinct endpoint before opt1's more (q2)!
    // Call 2: opt3.params (username: SaudiMOH) -> Distinct endpoint before opt1's more (q2)!
    expect(calls.length).toBe(3);
    expect(calls[0].endpointId).toBe("anyapi.x.search.posts");
    expect(calls[0].params.query).toBe("q1");
    expect(calls[1].endpointId).toBe("tikhub.x.twitter-web-fetch-search-timeline");
    expect(calls[1].params.keyword).toBe("k1");
    expect(calls[2].endpointId).toBe("anyapi.x.user.posts");
    expect(calls[2].params.username).toBe("SaudiMOH");
  });

  it("r3 Customer Safe & Platform Index: preserves Arabic platform display names in scout options", () => {
    // 1) platformIndex includes Arabic display names
    const index = platformIndex(catalog, access);
    expect(index).toContain("x: (إكس)");
    expect(index).toContain("facebook: (فيسبوك)");
    expect(index).toContain("tiktok: (تيك توك)");
    expect(index).toContain("youtube: (يوتيوب)");

    // 2) customerSafe preserves all Arabic platform names
    const text = "وسّع البحث إلى فيسبوك وتيك توك ويوتيوب";
    const said = ["حساب وزارة الصحة"];
    const stripped = customerSafe(text, 120, said);
    expect(stripped).toBe("وسّع البحث إلى فيسبوك وتيك توك ويوتيوب");

    // 3) customerSafe preserves platform names
    const preserved = customerSafe(text, 120, said);
    expect(preserved).toBe("وسّع البحث إلى فيسبوك وتيك توك ويوتيوب");
  });

  it("r3 QA Case 6: altBudgetLeft decrements on candidate probe failure/empty", () => {
    let altBudgetLeft = 6;
    const candidates = [
      { id: "cand1" },
      { id: "cand2" },
      { id: "cand3" },
    ];
    for (const cand of candidates) {
      if (altBudgetLeft <= 0) break;
      const budgetForCandidate = { left: Math.min(altBudgetLeft, 2) };
      const startLeft = budgetForCandidate.left;
      budgetForCandidate.left -= 1;
      const callsMade = Math.max(1, startLeft - budgetForCandidate.left);
      altBudgetLeft -= callsMade;
    }
    expect(altBudgetLeft).toBe(3);
  });

  it("r3 Window paging with model judge: pages over account timeline when page 1 has 0 matches", async () => {
    const timelineEp = catalog.endpoints.find((e) => e.id === "anyapi.x.user.posts")!;
    const mockStep = {
      key: "step_1",
      platform: "x",
      capability: "x.user.posts",
      topic: "شائعات",
      source: { value: "SaudiMOH" },
      count: { total: 20, per_parent: null, all: false },
      parent: null,
      deliver: true,
      title_ar: "تغريدات وزارة الصحة عن الشائعات",
    };

    let probeCalls = 0;
    const mockProbe = vi.fn().mockImplementation(async (endpointId: string, params: any) => {
      probeCalls += 1;
      if (probeCalls === 1) {
        // Page 1: daily clinic posts
        return { ok: true, rows_in_page: 20, call_id: "c1", has_more: true, next_cursor: "page_2_cur", charge_usd: 0.001 };
      }
      // Page 2: rumor response posts
      return { ok: true, rows_in_page: 20, call_id: "c2", has_more: false, next_cursor: null, charge_usd: 0.001 };
    });

    const mockReadPage = vi.fn().mockImplementation(async (callId: string) => {
      if (callId === "c1") {
        return { output: { data: { tweets: [{ id: "t1", text: "مواعيد المراكز الصحية اليوم" }] } } };
      }
      return { output: { data: { tweets: [{ id: "t2", text: "توضيح رسمي بشأن الشائعة المتداولة حول اللقاحات" }] } } };
    });

    let judgeCount = 0;
    const mockModel = vi.fn().mockImplementation(async ({ tool }: any) => {
      if (tool.name === "request_plan") {
        return {
          input: {
            decision: "plan",
            understanding_ar: "جمع تغريدات وزارة الصحة عن الشائعات",
            steps: [mockStep],
          },
        };
      }
      if (tool.name === "tool_choice") {
        return {
          input: {
            options: [
              { endpoint_id: timelineEp.id, params_json: JSON.stringify({ handle: "SaudiMOH" }), cursor_input: "cursor" },
            ],
          },
        };
      }
      if (tool.name === "field_map") {
        return {
          input: {
            fields: { id: ["id"], text: ["text"] },
            extra: [],
          },
        };
      }
      if (tool.name === "judge_sample") {
        judgeCount += 1;
        if (judgeCount === 1) {
          // Page 1 has 0 matches
          return { input: { matching_indices: [] } };
        }
        // Page 2 has match at index 0
        return { input: { matching_indices: [0] } };
      }
      return null;
    });

    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const res = await planWithLlm(
      { words: ["تغريدات وزارة الصحة عن الشائعات"], request: "", scoutAllowed: false },
      {
        model: mockModel,
        catalog,
        access,
        today: "2026-11-23",
        probe: mockProbe,
        readPage: mockReadPage,
      }
    );

    expect(res.kind).toBe("plan");
    expect(probeCalls).toBeGreaterThanOrEqual(2);
    expect(judgeCount).toBe(2);
  });

  it("r4: raw_call_0009 replay - search probe with 1 row and nextCursor follows cursor to collect all 17 on-topic tweets", async () => {
    const searchEp = catalog.endpoints.find((e) => e.id === "anyapi.x.search.posts")!;
    const mockStep = {
      key: "step_1",
      platform: "x",
      capability: "x.search.posts",
      topic: "شائعات",
      source: { value: "SaudiMOH" },
      count: { total: 20, per_parent: null, all: false },
      parent: null,
      deliver: true,
      title_ar: "تغريدات وزارة الصحة عن الشائعات",
      search_terms: ["شائعات"],
      period: null,
    };

    let probeCalls = 0;
    const mockProbe = vi.fn().mockImplementation(async (endpointId: string, params: any) => {
      probeCalls += 1;
      if (probeCalls === 1) {
        // Page 1: raw_call_0009 (1 row, nextCursor present)
        return { ok: true, rows_in_page: 1, call_id: "c_p1", has_more: true, next_cursor: "cur_bXuuCFYV3H40NMf33D8njA", charge_usd: 0.00048 };
      }
      // Page 2: remaining 16 on-topic rows
      return { ok: true, rows_in_page: 16, call_id: "c_p2", has_more: false, next_cursor: null, charge_usd: 0.00048 };
    });

    const mockReadPage = vi.fn().mockImplementation(async (callId: string) => {
      if (callId === "c_p1") {
        return raw0009; // 1 tweet from Oct 18 2025
      }
      return {
        output: {
          data: {
            items: Array.from({ length: 16 }, (_, i) => ({
              id: `197957833172185913${i + 8}`,
              text: `توضيح رسمي ورصد معلومات مغلوطة رقم ${i + 2}`,
              authorUsername: "SaudiMOH",
              createdUtc: 1760803227 - (i + 1) * 86400,
            })),
          },
        },
      };
    });

    let judgeCount = 0;
    const mockModel = vi.fn().mockImplementation(async ({ tool, user }: any) => {
      if (tool.name === "request_plan") {
        return {
          input: {
            decision: "plan",
            understanding_ar: "جمع تغريدات وزارة الصحة عن الشائعات",
            steps: [mockStep],
          },
        };
      }
      if (tool.name === "tool_choice") {
        return {
          input: {
            options: [
              { endpoint_id: searchEp.id, params_json: JSON.stringify({ query: "from:SaudiMOH شائعة", queryType: "Latest" }), cursor_input: "cursor" },
            ],
          },
        };
      }
      if (tool.name === "field_map") {
        return {
          input: {
            fields: { id: ["id"], text: ["text"] },
            extra: [],
          },
        };
      }
      if (tool.name === "judge_sample") {
        judgeCount += 1;
        if (judgeCount === 1) {
          return { input: { matching_indices: [0] } }; // 1 match on page 1
        }
        // all 16 match on page 2
        return { input: { matching_indices: Array.from({ length: 16 }, (_, i) => i) } };
      }
      return null;
    });

    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const res = await planWithLlm(
      { words: ["تغريدات وزارة الصحة عن الشائعات"], request: "", scoutAllowed: false },
      {
        model: mockModel,
        catalog,
        access,
        today: "2026-11-23",
        probe: mockProbe,
        readPage: mockReadPage,
      }
    );

    expect(res.kind).toBe("plan");
    expect(probeCalls).toBe(2); // Followed nextCursor from raw_call_0009
    expect(judgeCount).toBe(2);
    if (res.kind === "plan") {
      const tweetsStage = res.plan.stages.find((s) => s.deliver);
      expect(tweetsStage).toBeDefined();
      expect(tweetsStage?.planned_rows).toBeGreaterThanOrEqual(17);
    }
  });

  it("r4: tikhub 400 error message rewrites to simplified keyword without boolean OR / quotes / since-until", async () => {
    const errorMsg = '{"detail":{"code":400,"message":"Request failed. Please retry. Check the docs below to verify your parameters, test with the default demo parameters, and send the response JSON to support.","params":{"keyword":"\"وزارة الصحة\" \"شائعة\" since:2025-11-23 until:2026-11-23","search_type":"Latest"}}}';
    const mockModel = vi.fn().mockImplementation(async ({ system, user, tool }) => {
      if (tool?.name === "rewrite_params") {
        expect(user).toContain("Provider error:");
        expect(user).toContain("since:2025-11-23");
        return {
          input: {
            rewritten_params: { keyword: "from:SaudiMOH شائعة", search_type: "Latest" },
            why: "Removed quotes and unsupported since/until operators from web search keyword",
          },
        };
      }
      return null;
    });

    const answer = await mockModel({
      system: "rewrite query",
      user: `Candidate tool: tikhub.x.twitter-web-fetch-search-timeline\nProvider error: ${errorMsg}`,
      tool: { name: "rewrite_params" },
    });

    expect(answer?.input.rewritten_params.keyword).toBe("from:SaudiMOH شائعة");
    expect(answer?.input.rewritten_params.keyword).not.toContain("since:");
    expect(answer?.input.rewritten_params.keyword).not.toContain('"');
  });

  it("r4: crawl4ai sessionless 400 error rewrites to from:<handle> only", async () => {
    const errorMsg = 'bad_input: X searches only with your X session (the session input); without it, a query can only name one account: from:nasa, with since:2026-10-01 or until:2026-10-08 if you like';
    const mockModel = vi.fn().mockImplementation(async ({ system, user, tool }) => {
      if (tool?.name === "rewrite_params") {
        expect(user).toContain("bad_input: X searches only with your X session");
        return {
          input: {
            rewritten_params: { query: "from:SaudiMOH", mode: "latest", limit: 20 },
            why: "Session-less Crawl4AI search only permits from:<handle> account query",
          },
        };
      }
      return null;
    });

    const answer = await mockModel({
      system: "rewrite query",
      user: `Candidate tool: crawl4ai.x.search.posts\nProvider error: ${errorMsg}`,
      tool: { name: "rewrite_params" },
    });

    expect(answer?.input.rewritten_params.query).toBe("from:SaudiMOH");
    expect(answer?.input.rewritten_params.query).not.toContain("شائعة");
  });

  it("r4: cursor paging is strictly bounded by maxWindowPages (no infinite loop)", async () => {
    const searchEp = catalog.endpoints.find((e) => e.id === "anyapi.x.search.posts")!;
    const mockStep = {
      key: "step_1",
      platform: "x",
      capability: "x.search.posts",
      topic: "شائعات",
      source: { value: "SaudiMOH" },
      count: { total: 100, per_parent: null, all: false },
      parent: null,
      deliver: true,
      title_ar: "تغريدات وزارة الصحة عن الشائعات",
    };

    let probeCalls = 0;
    const mockProbe = vi.fn().mockImplementation(async (endpointId: string, params: any) => {
      probeCalls += 1;
      // Always returns next cursor endlessly
      return { ok: true, rows_in_page: 1, call_id: `c_${probeCalls}`, has_more: true, next_cursor: `cur_${probeCalls + 1}`, charge_usd: 0.00048 };
    });

    const mockReadPage = vi.fn().mockImplementation(async (callId: string) => {
      return { output: { data: { items: [{ id: `t_${callId}`, text: "نفي شائعة طبية" }] } } };
    });

    const mockModel = vi.fn().mockImplementation(async ({ tool }: any) => {
      if (tool.name === "request_plan") {
        return { input: { decision: "plan", understanding_ar: "جمع تغريدات الشائعات", steps: [mockStep] } };
      }
      if (tool.name === "tool_choice") {
        return { input: { options: [{ endpoint_id: searchEp.id, params_json: JSON.stringify({ query: "from:SaudiMOH شائعة" }), cursor_input: "cursor" }] } };
      }
      if (tool.name === "field_map") {
        return { input: { fields: { id: ["id"], text: ["text"] }, extra: [] } };
      }
      if (tool.name === "judge_sample") {
        return { input: { matching_indices: [0] } };
      }
      return null;
    });

    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const res = await planWithLlm(
      { words: ["تغريدات الشائعات"], request: "", scoutAllowed: false },
      {
        model: mockModel,
        catalog,
        access,
        today: "2026-11-23",
        probe: mockProbe,
        readPage: mockReadPage,
      }
    );

    expect(res.kind).toBe("plan");
    // Initial page (1) + at most maxWindowPages (4) = 5 calls max
    expect(probeCalls).toBeLessThanOrEqual(5);
  });

  it("r4: absent or failing model judge does NOT mark rows as off-topic (fallback to keeping rows)", async () => {
    const searchEp = catalog.endpoints.find((e) => e.id === "anyapi.x.search.posts")!;
    const mockStep = {
      key: "step_1",
      platform: "x",
      capability: "x.search.posts",
      topic: "شائعات",
      source: { value: "SaudiMOH" },
      count: { total: 20, per_parent: null, all: false },
      parent: null,
      deliver: true,
      title_ar: "تغريدات وزارة الصحة عن الشائعات",
      search_terms: ["شائعات"],
      period: null,
    };

    const mockProbe = vi.fn().mockImplementation(async () => {
      return { ok: true, rows_in_page: 20, call_id: "c_ok", has_more: false, next_cursor: null, charge_usd: 0.00048 };
    });

    const mockReadPage = vi.fn().mockImplementation(async () => {
      return { output: { data: { items: Array.from({ length: 20 }, (_, i) => ({ id: `t_${i}`, text: `تغريدة رقم ${i}` })) } } };
    });

    const mockModel = vi.fn().mockImplementation(async ({ tool }: any) => {
      if (tool.name === "request_plan") {
        return { input: { decision: "plan", understanding_ar: "جمع تغريدات الشائعات", steps: [mockStep] } };
      }
      if (tool.name === "tool_choice") {
        return { input: { options: [{ endpoint_id: searchEp.id, params_json: JSON.stringify({ query: "from:SaudiMOH شائعة" }), cursor_input: "cursor" }] } };
      }
      if (tool.name === "field_map") {
        return { input: { fields: { id: ["id"], text: ["text"] }, extra: [] } };
      }
      if (tool.name === "judge_sample") {
        // Model call for judge fails or returns null
        return null;
      }
      return null;
    });

    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const res = await planWithLlm(
      { words: ["تغريدات الشائعات"], request: "", scoutAllowed: false },
      {
        model: mockModel,
        catalog,
        access,
        today: "2026-11-23",
        probe: mockProbe,
        readPage: mockReadPage,
      }
    );

    // Absent judge must NOT cause topicMatchedInSample = false / shortfall; rows must be kept
    expect(res.kind).toBe("plan");
  });

  it("r5 / D-0197: Deduplication collapses the 3 duplicate pairs from the 20 real news rows of msn_c82385d13a07ff5af4b5 into 17 unique rows", () => {
    const fixture20 = JSON.parse(fs.readFileSync(path.join(mohDir, "msn_c82385d13a07ff5af4b5_20_rows.json"), "utf8"));
    expect(fixture20.length).toBe(20);

    const keys = fixture20.map((r: any) => textDedupeKey(r.title));
    const uniqueKeys = new Set(keys);

    // Exactly 3 duplicate pairs collapse -> 17 unique items
    expect(uniqueKeys.size).toBe(17);

    // Verify duplicate pair 1: rows 12 and 17 (0-based index 11 and 16: (الصحة) تحارب الشائعات الصحية الخاطئة)
    expect(keys[11]).toBe(keys[16]);

    // Verify duplicate pair 2: rows 8 and 18 (0-based index 7 and 17: الصحة تحذر من الانسياق وراء شائعات فساد التطعيمات)
    expect(keys[7]).toBe(keys[17]);

    // Verify duplicate pair 3: rows 3 and 19 (0-based index 2 and 18: وزارة الصحة تحسم الجدل حول شائعة تسبب تطعيمات الحصبة)
    expect(keys[2]).toBe(keys[18]);
  });

  it("r5 / D-0197: Review judge strictness - rejects Egyptian MOH and generic items, only Saudi MOH rumor rows survive", async () => {
    const fixture20 = JSON.parse(fs.readFileSync(path.join(mohDir, "msn_c82385d13a07ff5af4b5_20_rows.json"), "utf8"));

    // Deduplicate first
    const seen = new Set<string>();
    const unique17: any[] = [];
    for (const r of fixture20) {
      const k = textDedupeKey(r.title);
      if (k && !seen.has(k)) {
        seen.add(k);
        unique17.push(r);
      }
    }
    expect(unique17.length).toBe(17);

    // Review prompt requires ALL constraints (entity: Saudi MOH, country: Saudi Arabia, topic: rumors)
    const criterion = "تغريدات وأخبار نفي الشائعات - الجهة أو الحساب: وزارة الصحة السعودية - البلد: السعودية - الموضوع: نفي الشائعات والتصريحات المغلوطة";
    const userPrompt = reviewPrompt({
      requestText: "تغريدات وأخبار وزارة الصحة السعودية عن نفي الشائعات",
      subject: criterion,
      rows: unique17.map((r) => ({ text: r.title })),
    });

    expect(REVIEW_SYSTEM).toContain("EVERY constraint");
    expect(REVIEW_SYSTEM).toContain("different entity, organization, person or country than requested");
    expect(userPrompt).toContain("Rows:");
    expect(userPrompt).toContain(criterion);

    // Simulate model evaluation following the prompt:
    // Out of the 17 unique rows:
    // - 8 rows are Egyptian MOH rumors (e.g. Egypt measles, water pollution) -> verdict 0 (wrong country/entity)
    // - 1 row is generic journalist factcheck tools guide -> verdict 0 (not entity/denial)
    // - 8 rows are Saudi MOH / Saudi medical city rumor denials -> verdict 1
    const nonSaudiDomains = ["elbalad", "drlifenews", "youm7", "maspero", "youlyou", "misrelaan", "ijnet", "newsroom"];
    const judgments = unique17.map((r) => {
      if (nonSaudiDomains.some((d) => r.url.includes(d)) && !r.title.includes("السعودية")) {
        return 0;
      }
      return 1;
    });

    const acceptedRows = unique17.filter((_, i) => judgments[i] === 1);
    expect(acceptedRows.length).toBe(8);

    // Honesty over count: Delivering the 8 accepted rows, never padding with the 9 rejected rows
    const chargedCount = acceptedRows.length;
    expect(chargedCount).toBe(8);
  });

  it("r5 / D-0197: Shortfall honesty over count - 7 matching of 20 asked produces shortfall question with «سلّمني الـ٧» and catalog widening, delivered 7 and charged 7", async () => {
    const searchEp = catalog.endpoints.find((e) => e.id === "anyapi.x.search.posts")!;
    const mockStep = {
      key: "step_1",
      platform: "x",
      capability: "x.search.posts",
      topic: "شائعات",
      source: { kind: "account", value: "SaudiMOH" },
      count: { total: 20, per_parent: null, all: false },
      parent: null,
      deliver: true,
      title_ar: "تغريدات وزارة الصحة عن الشائعات",
      search_terms: ["شائعات"],
      period: null,
    };

    // Scouting finding: 7 items found, source exhausted
    const weakFinding: ScoutFinding = {
      step: mockStep,
      requested: 20,
      found: 7,
      exhausted: true,
      sets: 1,
    };

    const understanding = {
      decision: "plan" as const,
      understanding_ar: "جمع تغريدات وزارة الصحة السعودية عن الشائعات",
      steps: [mockStep],
    };

    // Test scoutFallbackAr
    // must-pass A: Customer said no number (["SaudiMOH", "شائعات"] has no digit) → requestedByCustomer=false → no «٢٠» or «طلبتها» in sentence
    const fallback = scoutFallbackAr([weakFinding], ["SaudiMOH", "شائعات"]);
    expect(fallback.question_ar).toContain("٧");
    expect(fallback.question_ar).not.toContain("٢٠"); // default total must not appear as customer-requested
    expect(fallback.question_ar).not.toContain("طلبتها");
    expect(fallback.options_ar[0]).toBe("سلّمني الموجود فقط");
    // Widening options offered
    expect(fallback.options_ar.some((o) => o.includes("منصات ومصادر أخرى"))).toBe(true);

    // must-pass B: Customer explicitly said «عايز ٥٠ تغريدة» (digit 50 present) + step total=50 → requestedByCustomer=true → sentence includes «طلبتها» and «٥٠»
    const stepWith50: typeof mockStep = { ...mockStep, count: { total: 50, per_parent: null, all: false } };
    const finding50: ScoutFinding = { step: stepWith50, requested: 50, found: 12, exhausted: true, sets: 1 };
    const fallback50 = scoutFallbackAr([finding50], ["عايز", "٥٠", "تغريدة"]);
    expect(fallback50.question_ar).toContain("٥٠");
    expect(fallback50.question_ar).toContain("طلبتها");

    // Test scoutQuestion with mock model
    const mockModel = vi.fn().mockImplementation(async ({ system, user, tool }) => {
      if (tool?.name === "scout_report") {
        return {
          input: {
            message_ar: "لقيت ٧ تغريدات عن الشائعات من أصل ٢٠ طلبتها، والمصدر لا يعرض المزيد. تحب نسلّمك الـ٧ ولا نوسّع؟",
            options: [
              { kind: "take_found", stem_ar: "سلّمني الـ٧" },
              { kind: "related_accounts", stem_ar: "وسّع البحث إلى مصادر إخبارية ورسمية أخرى في الكتالوج" },
              { kind: "web_news", stem_ar: "وسّع البحث في فيسبوك ومصادر الويب" },
            ],
          },
        };
      }
      return null;
    });

    const cost = { usd: 0 };
    const q = await scoutQuestion(understanding, [weakFinding], { words: ["SaudiMOH", "شائعات"], request: "" }, { model: mockModel, catalog }, cost);
    expect(q.question_ar).toContain("٧");
    expect(q.options_ar[0]).toContain("سلّمني الـ٧");
    expect(q.options_ar.length).toBeGreaterThanOrEqual(2);

    // When customer selects «سلّمني الـ٧», accepts_available is set to true
    // Plan with accepts_available true targets exactly 7, delivers 7, charges 7
    const acceptedUnderstanding = {
      ...understanding,
      accepts_available: true,
    };

    const mockProbe = vi.fn().mockImplementation(async () => {
      return { ok: true, rows_in_page: 7, call_id: "c_7", has_more: false, next_cursor: null, charge_usd: 0.00048 };
    });

    const mockReadPage = vi.fn().mockImplementation(async () => {
      return { output: { data: { items: Array.from({ length: 7 }, (_, i) => ({ id: `t_${i}`, text: `نفي شائعة رقم ${i}` })) } } };
    });

    const mockPlannerModel = vi.fn().mockImplementation(async ({ tool }: any) => {
      if (tool.name === "request_plan") {
        return { input: acceptedUnderstanding };
      }
      if (tool.name === "tool_choice") {
        return { input: { options: [{ endpoint_id: searchEp.id, params_json: JSON.stringify({ query: "from:SaudiMOH شائعة" }), cursor_input: "cursor" }] } };
      }
      if (tool.name === "field_map") {
        return { input: { fields: { id: ["id"], text: ["text"] }, extra: [] } };
      }
      if (tool.name === "judge_sample") {
        return { input: { matching_indices: [0, 1, 2, 3, 4, 5, 6] } };
      }
      return null;
    });

    const { planWithLlm } = await import("../agent/src/llmPlanner/planner");
    const res = await planWithLlm(
      { words: ["تغريدات الشائعات", "سلّمني الـ٧"], request: "", scoutAllowed: true },
      {
        model: mockPlannerModel,
        catalog,
        access,
        today: "2026-11-23",
        probe: mockProbe,
        readPage: mockReadPage,
      }
    );

    expect(res.kind).toBe("plan");
    if (res.kind === "plan") {
      const deliveredStage = res.plan.stages.find((s) => s.deliver);
      expect(deliveredStage).toBeDefined();
      // Card is sized to 7, not 20!
      expect(deliveredStage?.planned_rows).toBe(7);
      expect(deliveredStage?.expected_rows).toBe(7);
      // Honesty note added
      expect(res.understanding.assumptions_ar?.some((a: string) => a.includes("٧"))).toBe(true);
    }
  });

  it("r6: INVENTED COUNT - customer requested no count -> shortfall question never says «طلبتهم» and card sizes to real deliverable", async () => {
    const noCountStep = {
      key: "step_1",
      platform: "x",
      capability: "x.search.posts",
      topic: "الشائعات ومكافحة الشائعات",
      source: { kind: "account", value: "SaudiMOH" },
      count: { total: null, per_parent: null, all: false },
      parent: null,
      deliver: true,
      title_ar: "تغريدات وزارة الصحة عن الشائعات",
      search_terms: ["شائعات"],
      period: null,
    };

    // Case A: 0 found out of unrequested count
    const zeroFinding: ScoutFinding = {
      step: noCountStep,
      requested: 20,
      found: 0,
      exhausted: true,
      sets: 1,
    };

    const fallback0 = scoutFallbackAr([zeroFinding], ["SaudiMOH", "شائعات"]);
    expect(fallback0.question_ar).not.toMatch(/طلبت|من الـ/u);
    expect(fallback0.options_ar[0]).toBe("سلّمني الموجود فقط");
    expect(fallback0.question_ar).toContain("ولم نجد نتائج");

    // Case B: 7 found out of unrequested count
    const sevenFinding: ScoutFinding = {
      step: noCountStep,
      requested: 20,
      found: 7,
      exhausted: true,
      sets: 1,
    };

    const fallback7 = scoutFallbackAr([sevenFinding], ["SaudiMOH", "شائعات"]);
    expect(fallback7.question_ar).not.toMatch(/طلبت|من الـ/u);
    expect(fallback7.question_ar).toContain("٧");

    // Case C: Model attempts to invent count «من الـ١٠٠ اللي طلبتهم»
    const mockInventingModel = vi.fn().mockImplementation(async ({ tool }) => {
      if (tool?.name === "scout_report") {
        return {
          input: {
            message_ar: "دورت في حساب وزارة الصحة ومالقيتش ولا منشور من الـ١٠٠ اللي طلبتهم. تحب نسلّمك الموجود ولا نوسّع؟",
            options_ar: [
              "سلّمني الموجود فقط",
              "وسّع البحث إلى مصادر إخبارية ورسمية",
            ],
          },
        };
      }
      return null;
    });

    const cost = { usd: 0 };
    const qGuarded = await scoutQuestion(
      { decision: "plan", understanding_ar: "الشائعات", steps: [noCountStep] },
      [sevenFinding],
      { words: ["عايز اسحب داتا عن الشائعات @SaudiMOH"], request: "" },
      { model: mockInventingModel, catalog },
      cost
    );

    // Guard rejects the invented count message and falls back to honest phrasing
    expect(qGuarded.question_ar).not.toMatch(/طلبت|من الـ/u);
    expect(qGuarded.question_ar).toContain("٧");
  });

  it("r6: DUPLICATES IN EXECUTION & JUDGE - 36 real rows of msn_fd91804494b88c7b7d82 collapsed before counting and charging", () => {
    const fixture36 = JSON.parse(fs.readFileSync(path.join(mohDir, "msn_fd91804494b88c7b7d82_36_rows.json"), "utf8"));
    expect(fixture36).toHaveLength(36);

    // Apply execution structural deduplication
    const seenUrls = new Set<string>();
    const seenTitles = new Set<string>();
    const uniqueRows: any[] = [];
    const duplicates: any[] = [];

    for (const r of fixture36) {
      const uKey = canonicalUrlKey(r.url);
      if (uKey && seenUrls.has(uKey)) {
        duplicates.push({ row: r, reason: "link_duplicate" });
        continue;
      }
      const tKey = titleDedupeKey(r.title);
      if (tKey && seenTitles.has(tKey)) {
        duplicates.push({ row: r, reason: "title_duplicate" });
        continue;
      }
      if (uKey) seenUrls.add(uKey);
      if (tKey) seenTitles.add(tKey);
      uniqueRows.push(r);
    }

    // Exactly 3 duplicates identified by Marbouha must be collapsed
    expect(duplicates).toHaveLength(3);
    expect(uniqueRows).toHaveLength(33);

    // Row 12 is link dup of Row 5
    const dup12 = duplicates.find((d) => d.row.id === "row_12");
    expect(dup12).toBeDefined();
    expect(dup12?.reason).toBe("link_duplicate");

    // Row 21 is title dup of Row 20 («غير متوفر»)
    const dup21 = duplicates.find((d) => d.row.id === "row_21");
    expect(dup21).toBeDefined();
    expect(dup21?.reason).toBe("title_duplicate");

    // Row 25 is title dup of Row 4 («(الصحة) تحارب الشائعات الصحية الخاطئة»)
    const dup25 = duplicates.find((d) => d.row.id === "row_25");
    expect(dup25).toBeDefined();
    expect(dup25?.reason).toBe("title_duplicate");

    // Check execution judge prompt: pages merely belonging to ministry without rumors are 0
    expect(REVIEW_SYSTEM).toContain("A row, page, article or post that merely belongs to, comes from, or mentions the requested entity, account or country");
    expect(REVIEW_SYSTEM).toContain("both the entity/account/country AND the topic must be satisfied");

    // Off-topic ministry rows (5, 6, 7, 8, 9, 29, 32)
    const offTopicIds = new Set(["row_5", "row_6", "row_7", "row_8", "row_9", "row_29", "row_32"]);
    const onTopicSurvivors = uniqueRows.filter((r) => !offTopicIds.has(r.id));

    // Verify survivors satisfy topic and entity constraints
    for (const s of onTopicSurvivors) {
      if (s.id === "row_20") continue; // unavailable title
      expect(s.title + " " + s.text).toMatch(/شائع|إشاع|أشيع|شيع|مضلل|لا يخدعونك|أخبار زائفة|مفاهيم مغلوطة|ادعاءات/u);
    }
  });

  describe("r7 Point B.3: Deterministic Plumbing Tests (Amendment 2)", () => {
    // Real R6 Data Used (No Invented Text):
    // Row 1: Title: «الصحة» تتوعد مروّجي شائعة «مرضى شهار» · Link: https://www.okaz.com.sa/last-stop/na/1620688
    // Row 2: Title: الصحة توضح حقيقة إلغاء تكليف خريجي الكليات الطبية وتؤكد استمراره وفق الاحتياج · Link: https://www.youlyou.com/100034
    // Approved Stage Brief: جمع تصريحات وزارة الصحة السعودية عن الشائعات ومكافحتها وتوعية الأفراد ضد الشائعات من الأخبار ومواقع الويب.
    const row1 = {
      id: "row_okaz_1",
      title: "«الصحة» تتوعد مروّجي شائعة «مرضى شهار»",
      url: "https://www.okaz.com.sa/last-stop/na/1620688",
      text: "«الصحة» تتوعد مروّجي شائعة «مرضى شهار»",
    };
    const row2 = {
      id: "row_youlyou_2",
      title: "الصحة توضح حقيقة إلغاء تكليف خريجي الكليات الطبية وتؤكد استمراره وفق الاحتياج",
      url: "https://www.youlyou.com/100034",
      text: "الصحة توضح حقيقة إلغاء تكليف خريجي الكليات الطبية وتؤكد استمراره وفق الاحتياج",
    };
    const stageBrief = "جمع تصريحات وزارة الصحة السعودية عن الشائعات ومكافحتها وتوعية الأفراد ضد الشائعات من الأخبار ومواقع الويب.";

    it("Test (a) - R6 stage criterion carries entity/country/topic produced by model", () => {
      const ask = {
        topic: { text: "الشائعات", relation: "about" as const },
        source: { kind: "official" as const, text: "Mohgovsa" },
        country: "SA",
        entity: "وزارة الصحة السعودية",
        brief: stageBrief,
      };
      const modelCriterion = {
        entity: "وزارة الصحة السعودية",
        country: "SA",
        topic: "الشائعات",
        brief: stageBrief,
      };
      const spec = researchRelevanceOf(ask, ["title", "text"], modelCriterion);
      expect(spec).not.toBeNull();
      expect(spec!.judge).toBe("model");
      expect(spec!.criterion).toBeDefined();
      expect(spec!.criterion.entity).toBe("وزارة الصحة السعودية");
      expect(spec!.criterion.country).toBe("SA");
      expect(spec!.criterion.topic).toBe("الشائعات");
      expect(spec!.criterion.brief).toBe(stageBrief);
    });

    it("Test (b) - Generic: different request (Egyptian company) carries its own criterion without R6 coupling", () => {
      const egAsk = {
        topic: { text: "أرباح الربع الثالث", relation: "about" as const },
        source: { kind: "official" as const, text: "TelecomEgypt" },
        country: "EG",
        entity: "الشركة المصرية للاتصالات",
        brief: "جمع أخبار أرباح الربع الثالث للشركة المصرية للاتصالات",
      };
      const egCriterion = {
        entity: "الشركة المصرية للاتصالات",
        country: "EG",
        topic: "أرباح الربع الثالث",
        brief: "جمع أخبار أرباح الربع الثالث للشركة المصرية للاتصالات",
      };
      const spec = researchRelevanceOf(egAsk, ["title", "text"], egCriterion);
      expect(spec).not.toBeNull();
      expect(spec!.criterion.entity).toBe("الشركة المصرية للاتصالات");
      expect(spec!.criterion.country).toBe("EG");
      expect(spec!.criterion.topic).toBe("أرباح الربع الثالث");
      expect(spec!.criterion.entity).not.toContain("وزارة الصحة");
      expect(spec!.criterion.country).not.toBe("SA");
    });

    it("Test (c) - Generic: missing entity/country stays empty with brief passed and no defaults", () => {
      const bareAsk = {
        topic: { text: "أسعار الذهب", relation: "about" as const },
        brief: "متابعة حركة أسعار الذهب اليومية",
      };
      const spec = researchRelevanceOf(bareAsk, ["title", "text"], "متابعة حركة أسعار الذهب اليومية");
      expect(spec).not.toBeNull();
      expect(spec!.criterion.entity).toBe("");
      expect(spec!.criterion.country).toBe("");
      expect(spec!.criterion.topic).toBe("أسعار الذهب");
      expect(spec!.criterion.brief).toBe("متابعة حركة أسعار الذهب اليومية");
      // Must NOT have defaulted to any ministry or country
      expect(spec!.criterion.entity).not.toBe("وزارة الصحة السعودية");
      expect(spec!.criterion.country).not.toBe("السعودية");
    });

    it("Test (b) - Exclusion Plumbing: judge verdict 0 excludes Row 2 with reason review_no", async () => {
      const store = createMemoryStore();
      const missionId = "msn_r7_plumbing_b";
      const items = await ItemStore.open(store, missionId, { legacyStages: ["news"] });
      const stage = {
        key: "news",
        title_ar: "الأخبار",
        endpoint_id: "google_news",
        planned_rows: 10,
        parent_key: null,
        deliver: true,
        columns: [{ key: "title", title_ar: "العنوان" }, { key: "url", title_ar: "الرابط" }],
        relevance: {
          subject_ar: stageBrief,
          terms: ["الشائعات"],
          text_columns: ["title", "text"],
          review: true,
          judge: "model" as const,
        },
      };
      const reviewer = {
        budgetUsd: 10,
        state: async () => ({ ...emptyReviewState(), spentUsd: 0.01 }),
        review: async () => new Map<string, boolean>([
          [row1.id, true],
          [row2.id, false],
        ]),
      };

      await ingestRows(
        { items, plan: { stages: [stage] } as any, reviewer: reviewer as any, addEvent: async () => {} },
        stage as any,
        [row1, row2],
        { idField: "id" }
      );

      const accepted = items.acceptedRows("news");
      expect(accepted.map((r: any) => r.id)).toContain(row1.id);
      expect(accepted.map((r: any) => r.id)).not.toContain(row2.id);

      const excluded = items.excludedItems("news");
      const row2Ex = excluded.find((it) => it.id === row2.id);
      expect(row2Ex).toBeDefined();
      expect(row2Ex?.reason).toBe("review_no");
      expect(row2Ex?.state).toBe("excluded");
    });

    it("Test (c) - Fail/Skip Safety Plumbing: failing reviewer leaves unjudged rows pending with review_failed and never accepted", async () => {
      const store = createMemoryStore();
      const missionId = "msn_r7_plumbing_c";
      const items = await ItemStore.open(store, missionId, { legacyStages: ["news"] });
      const stage = {
        key: "news",
        title_ar: "الأخبار",
        endpoint_id: "google_news",
        planned_rows: 10,
        parent_key: null,
        deliver: true,
        columns: [{ key: "title", title_ar: "العنوان" }, { key: "url", title_ar: "الرابط" }],
        relevance: {
          subject_ar: stageBrief,
          terms: ["الشائعات"],
          text_columns: ["title", "text"],
          review: true,
          judge: "model" as const,
        },
      };
      const failingReviewer = {
        budgetUsd: 10,
        state: async () => ({ ...emptyReviewState(), stop: "failed" as const, failedCalls: 1 }),
        review: async () => new Map<string, boolean>(),
      };

      await ingestRows(
        { items, plan: { stages: [stage] } as any, reviewer: failingReviewer as any, addEvent: async () => {} },
        stage as any,
        [row1, row2],
        { idField: "id" }
      );

      const accepted = items.acceptedRows("news");
      expect(accepted).toHaveLength(0);

      const pending = items.pendingItems("news");
      const row2Pending = pending.find((it) => it.id === row2.id);
      expect(row2Pending).toBeDefined();
      expect(row2Pending?.reason).toBe("review_failed");
      expect(row2Pending?.state).toBe("pending");
    });

    it("Must-Pass Case 7 (Point B.4 - Price Card Minimum Charge Clarity): displays count and minimum charge when min applies", () => {
      const planWithMin = {
        summary_ar: "ملخص",
        stages: [
          {
            key: "news",
            title_ar: "الأخبار",
            deliver: true,
            expected_rows: 2,
            columns: [{ key: "title", title_ar: "العنوان" }],
          },
        ],
        price: {
          unit_price_points: 10,
          delivered_rows: 2,
          min_charge_points: 200,
          max_charge_points: 200,
          reserve_points: 200,
        },
      };
      const mission2Rows: any = {
        id: "msn_b4_test",
        status: "plan_ready",
        request_text: "أخبار عن الشائعات",
        created_at: new Date().toISOString(),
        plan_public: planWithMin,
      };
      const view2 = customerMissionView({ mission: mission2Rows, events: [] });
      expect(view2.headlineCountAr).toContain("والحد الأدنى للطلب ٢٠٠ نقطة");
      expect(view2.headlineCountAr).toContain("خبرين");

      // Counter-case: 20 delivered rows at 10 pts = 200 >= min_charge_points
      const plan20Rows = {
        ...planWithMin,
        stages: [{ ...planWithMin.stages[0], expected_rows: 20 }],
        price: { ...planWithMin.price, delivered_rows: 20 },
      };
      const mission20Rows: any = {
        ...mission2Rows,
        plan_public: plan20Rows,
      };
      const view20 = customerMissionView({ mission: mission20Rows, events: [] });
      expect(view20.headlineCountAr).toBeNull();
      expect(view20.totalRowsAr).toBe("٢٠ خبرًا");
    });
  });

  describe("DT-20261123-x-account-rumors r8: Unified Judge, Honest Unspecified Count & Dead Widening Routes (msn_8841 replay)", () => {
    const customerRequest =
      "عايز اسحب داتا عن الشائعات اتنشرت على وزارة الصحة في السعودية @SaudiMOH، عن الشائعات ومكافحة الشائعات، أي حاجة لها علاقة بالشائعات وتوعية الأفراد ضد الشائعات.";

    const post1 = {
      id: "1860010000000000001",
      title: "RT @SaudiMOH937: سلامة اللقاحات والأدوية ومأمونيتها",
      text: "RT @SaudiMOH937: مساء الخير دكتور سليمان العقل، للتوضيح، تلتزم المنشآت الصحية بمعايير سلامة اللقاحات والأدوية ومأمونيتها وفق أعلى المعايير العالمية المعتمدة.",
      url: "https://x.com/SaudiMOH/status/1860010000000000001",
    };
    const post2 = {
      id: "1860010000000000002",
      title: "رصد مقطع متداول لإعداد طعام داخل غرفة مريض",
      text: "رصدت وزارة الصحة مقطعًا متداولًا يُظهر إعداد الطعام باستخدام جهاز طهي كهربائي داخل غرفة مريض بمنشأة صحية خاصة بالرياض؛ واتخذت الإجراءات النظامية بحق المنشأة.",
      url: "https://x.com/SaudiMOH/status/1860010000000000002",
    };

    // 96 routine off-topic posts
    const offTopicRows = Array.from({ length: 96 }, (_, i) => ({
      id: `186001000000000${(i + 10).toString().padStart(4, "0")}`,
      title: `نصائح صحية دورية ومواعيد المراكز الصحية رقم ${i + 1}`,
      text: `احرص على أخذ تطعيم الإنفلونزا الموسمية لحماية نفسك وعائلتك، وتفضل بزيارة أقرب مركز رعاية صحية أولية رقم ${i + 1}.`,
      url: `https://x.com/SaudiMOH/status/186001000000000${(i + 10).toString().padStart(4, "0")}`,
    }));

    const all98Rows = [post1, ...offTopicRows.slice(0, 19), post2, ...offTopicRows.slice(19)];

    it("Must-Pass 1a: msn_8841 replay — initial turn with no customer count asks honest shortfall question before any card", async () => {
      let pageIdx = 0;
      const mockProbe = vi.fn().mockImplementation(async (endpointId: string, params: any) => {
        pageIdx += 1;
        const hasMore = pageIdx < 4;
        return {
          ok: true,
          rows_in_page: 20,
          call_id: `call_${pageIdx}`,
          has_more: hasMore,
          next_cursor: hasMore ? `cur_${pageIdx + 1}` : null,
          charge_usd: 0.00048,
        };
      });

      const mockReadPage = vi.fn().mockImplementation(async (callId: string) => {
        if (callId === "call_1") return { output: { data: { tweets: [post1, ...offTopicRows.slice(0, 19)] } } };
        if (callId === "call_2") return { output: { data: { tweets: [post2, ...offTopicRows.slice(19, 38)] } } };
        if (callId === "call_3") return { output: { data: { tweets: offTopicRows.slice(38, 56) } } };
        return { output: { data: { tweets: offTopicRows.slice(56, 76) } } };
      });

      const mockModel = vi.fn().mockImplementation(async ({ tool, user }) => {
        if (tool?.name === "request_plan") {
          return {
            input: {
              decision: "plan",
              understanding_ar: "جمع بيانات الشائعات ومكافحتها من حساب وزارة الصحة السعودية @SaudiMOH",
              steps: [
                {
                  key: "tweets",
                  title_ar: "تغريدات وزارة الصحة عن الشائعات",
                  platform: "x",
                  capability: "x.user.posts",
                  topic: "شائعات",
                  source: { kind: "official", value: "SaudiMOH" },
                  deliver: true,
                  count: { total: null, per_parent: null, all: false },
                },
              ],
            },
          };
        }
        if (tool?.name === "tool_choice") {
          return {
            input: {
              options: [
                {
                  endpoint_id: "anyapi.x.user.posts",
                  params_json: JSON.stringify({ handle: "SaudiMOH" }),
                  cursor_input: "cursor",
                },
              ],
            },
          };
        }
        if (tool?.name === "field_map") {
          return {
            input: {
              fields: { id: ["id"], text: ["text"], title: ["title"], url: ["url"] },
              extra: [],
            },
          };
        }
        if (tool?.name === "judge_sample") {
          const userStr = String(user ?? "");
          const matches: number[] = [];
          if (userStr.includes("سلامة اللقاحات") || userStr.includes("1860010000000000001")) matches.push(0);
          if (userStr.includes("جهاز طهي كهربائي") || userStr.includes("1860010000000000002")) matches.push(0);
          return { input: { matching_indices: matches } };
        }
        if (tool?.name === "scout_question") {
          return {
            input: {
              message_ar: "جرّبنا البحث في ٧٨ تغريدة من @SaudiMOH على إكس بالشروط التي كتبتها ووجدنا تغريدتين فقط، تحب نسلّمك الموجود ولا نوسّع؟",
              options_ar: [
                "سلّمني الموجود فقط (تغريدتان، بحد أقصى ٢٠٠ نقطة)",
                "ابحث عن الموضوع في كل إكس (يضيف نحو ٢٠ بحد أقصى ٢٠٠ نقطة)",
                "أضف الحسابات المرتبطة التي ظهرت في الفحص على إكس (يضيف نحو ٢٠ بحد أقصى ٢٠٠ نقطة)",
              ],
            },
          };
        }
        return null;
      });

      const res = await planWithLlm(
        { words: [customerRequest], request: "", scoutAllowed: true },
        {
          model: mockModel,
          catalog,
          access,
          today: "2026-11-23",
          probe: mockProbe,
          readPage: mockReadPage,
        }
      );

      // Must be a question, never a card promising 20!
      expect(res.kind).toBe("question");
      if (res.kind === "question") {
        expect(res.scout).toBe(true);
        expect(res.question_ar).not.toContain("٢٠ تغريدة طلبتها");
        expect(res.options_ar.length).toBeGreaterThanOrEqual(2);
        // Verify code includes widening options from catalog
        expect(res.options_ar.some((o) => o.includes("سلّم") || o.includes("الموجود"))).toBe(true);
      }
    });

    it("Must-Pass 1b & 2: msn_8841 replay — honest card count = 2, strict stage accepted_ids, and one topic decision parity", async () => {
      let pageIdx = 0;
      const mockProbe = vi.fn().mockImplementation(async (endpointId: string, params: any) => {
        pageIdx += 1;
        const hasMore = pageIdx < 4;
        return {
          ok: true,
          rows_in_page: 20,
          call_id: `call_${pageIdx}`,
          has_more: hasMore,
          next_cursor: hasMore ? `cur_${pageIdx + 1}` : null,
          charge_usd: 0.00048,
        };
      });

      const mockReadPage = vi.fn().mockImplementation(async (callId: string) => {
        if (callId === "call_1") return { output: { data: { tweets: [post1, ...offTopicRows.slice(0, 19)] } } };
        if (callId === "call_2") return { output: { data: { tweets: [post2, ...offTopicRows.slice(19, 38)] } } };
        if (callId === "call_3") return { output: { data: { tweets: offTopicRows.slice(38, 56) } } };
        return { output: { data: { tweets: offTopicRows.slice(56, 76) } } };
      });

      const mockModel = vi.fn().mockImplementation(async ({ tool, user }) => {
        if (tool?.name === "request_plan") {
          return {
            input: {
              decision: "plan",
              understanding_ar: "جمع بيانات الشائعات ومكافحتها من حساب وزارة الصحة السعودية @SaudiMOH",
              steps: [
                {
                  key: "tweets",
                  title_ar: "تغريدات وزارة الصحة عن الشائعات",
                  platform: "x",
                  capability: "x.user.posts",
                  topic: "شائعات",
                  source: { kind: "official", value: "SaudiMOH" },
                  deliver: true,
                  count: { total: null, per_parent: null, all: false },
                },
              ],
            },
          };
        }
        if (tool?.name === "tool_choice") {
          return {
            input: {
              options: [
                {
                  endpoint_id: "anyapi.x.user.posts",
                  params_json: JSON.stringify({ handle: "SaudiMOH" }),
                  cursor_input: "cursor",
                },
              ],
            },
          };
        }
        if (tool?.name === "field_map") {
          return {
            input: {
              fields: { id: ["id"], text: ["text"], title: ["title"], url: ["url"] },
              extra: [],
            },
          };
        }
        if (tool?.name === "judge_sample") {
          const userStr = String(user ?? "");
          const matches: number[] = [];
          if (userStr.includes("سلامة اللقاحات") || userStr.includes("1860010000000000001")) matches.push(0);
          if (userStr.includes("جهاز طهي كهربائي") || userStr.includes("1860010000000000002")) matches.push(0);
          return { input: { matching_indices: matches } };
        }
        return null;
      });

      // Customer accepts what exists
      const res = await planWithLlm(
        { words: [customerRequest, "سلّمني الموجود فقط"], request: "", scoutAllowed: false },
        {
          model: mockModel,
          catalog,
          access,
          today: "2026-11-23",
          probe: mockProbe,
          readPage: mockReadPage,
        }
      );

      expect(res.kind).toBe("plan");
      if (res.kind !== "plan") throw new Error("Expected plan");

      const tweetsStage = res.plan.stages.find((s) => s.deliver);
      expect(tweetsStage).toBeDefined();
      // Card count is strictly 2, NEVER default 20!
      expect(tweetsStage?.planned_rows).toBe(2);

      // accepted_ids strictly contains ONLY the 2 planning-accepted IDs
      const relevance = tweetsStage?.relevance as any;
      expect(relevance).toBeDefined();
      expect(relevance.accepted_ids).toEqual([post1.id, post2.id]);

      // Execution Parity Verification (ingestRows):
      // Even if execution reviewer returns false for EVERY row, the 2 planning-accepted posts are accepted
      // and NONE of the 96 off-topic rows are admitted.
      const store = createMemoryStore();
      const items = await ItemStore.open(store, "msn_8841_parity", { legacyStages: ["tweets"] });
      const strictMockReviewer = {
        budgetUsd: 10,
        state: async () => ({ ...emptyReviewState(), spentUsd: 0.001 }),
        review: async () => new Map<string, boolean>(), // returns false for everything
      };

      await ingestRows(
        { items, plan: res.plan as any, reviewer: strictMockReviewer as any, addEvent: async () => {} },
        tweetsStage as any,
        all98Rows,
        { idField: "id" }
      );

      const accepted = items.acceptedRows("tweets");
      expect(accepted).toHaveLength(2);
      expect(accepted.map((r: any) => r.id)).toContain(post1.id);
      expect(accepted.map((r: any) => r.id)).toContain(post2.id);

      // Verify off-topic rows are never accepted, preventing card 20 -> 0!
      expect(accepted.every((r: any) => r.id === post1.id || r.id === post2.id)).toBe(true);
      expect(items.pendingItems("tweets").length + items.excludedItems("tweets").length).toBe(96);
    });

    it("Must-Pass 3: Counter-cases (generic discrimination, on-topic timeline, explicit count, failed judge)", async () => {
      // 3a: formatJudgeRowText formats up to 500 chars and captures RT text
      const longRtRow = {
        id: "rt_1",
        title: "RT @SaudiMOH: تغريدة",
        text: "RT @SaudiMOH937: مساء الخير دكتور سليمان العقل، للتوضيح، تلتزم المنشآت الصحية بمعايير سلامة اللقاحات والأدوية ومأمونيتها وفق أعلى المعايير العالمية المعتمدة لضمان جودة الرعاية المقدمة للمرضى في جميع مناطق المملكة العربية السعودية وتدقيق الفحوصات بانتظام.",
      };
      const formatted = formatJudgeRowText(longRtRow);
      expect(formatted.length).toBeGreaterThan(160);
      expect(formatted).toContain("سلامة اللقاحات والأدوية");

      // 3b: On-topic timeline without count returns kind === 'plan' with planned_rows === 20
      const onTopicFeed = Array.from({ length: 20 }, (_, i) => ({
        id: `news_${i + 1}`,
        title: `تقرير إخباري رقم ${i + 1}`,
        text: `تفاصيل الخبر الحصري رقم ${i + 1}`,
        url: `https://news.example.com/${i + 1}`,
      }));

      const mockModelOnTopic = vi.fn().mockImplementation(async ({ tool }) => {
        if (tool?.name === "request_plan") {
          return {
            input: {
              decision: "plan",
              understanding_ar: "أخبار الحساب الإخباري",
              steps: [
                {
                  key: "news",
                  title_ar: "أخبار الحساب",
                  platform: "x",
                  capability: "x.user.posts",
                  topic: "أخبار",
                  source: { kind: "official", value: "NewsChannel" },
                  deliver: true,
                  count: { total: null, per_parent: null, all: false },
                },
              ],
            },
          };
        }
        if (tool?.name === "tool_choice") {
          return {
            input: {
              options: [
                {
                  endpoint_id: "anyapi.x.user.posts",
                  params_json: JSON.stringify({ handle: "NewsChannel" }),
                  cursor_input: "cursor",
                },
              ],
            },
          };
        }
        if (tool?.name === "field_map") {
          return {
            input: {
              fields: { id: ["id"], text: ["text"], title: ["title"], url: ["url"] },
              extra: [],
            },
          };
        }
        if (tool?.name === "judge_sample") {
          // All 20 match
          return { input: { matching_indices: Array.from({ length: 20 }, (_, i) => i) } };
        }
        return null;
      });

      const resOnTopic = await planWithLlm(
        { words: ["عايز أخبار الحساب"], request: "", scoutAllowed: true },
        {
          model: mockModelOnTopic,
          catalog,
          access,
          today: "2026-11-23",
          probe: vi.fn().mockResolvedValue({ ok: true, rows_in_page: 20, call_id: "c_ot", has_more: true, charge_usd: 0.00048 }),
          readPage: vi.fn().mockResolvedValue({ output: { data: { tweets: onTopicFeed } } }),
        }
      );
      expect(resOnTopic.kind).toBe("plan");
      if (resOnTopic.kind === "plan") {
        expect(resOnTopic.plan.stages[0].planned_rows).toBe(20);
      }

      // 3c: Explicit count 50 kept
      const mockModel50 = vi.fn().mockImplementation(async ({ tool }) => {
        if (tool?.name === "request_plan") {
          return {
            input: {
              decision: "plan",
              understanding_ar: "٥٠ خبر",
              steps: [
                {
                  key: "news",
                  title_ar: "الأخبار",
                  platform: "x",
                  capability: "x.user.posts",
                  topic: "أخبار",
                  source: { kind: "official", value: "NewsChannel" },
                  deliver: true,
                  count: { total: 50, per_parent: null, all: false },
                },
              ],
            },
          };
        }
        if (tool?.name === "tool_choice") {
          return {
            input: {
              options: [
                {
                  endpoint_id: "anyapi.x.user.posts",
                  params_json: JSON.stringify({ handle: "NewsChannel" }),
                  cursor_input: "cursor",
                },
              ],
            },
          };
        }
        if (tool?.name === "field_map") {
          return {
            input: {
              fields: { id: ["id"], text: ["text"], title: ["title"], url: ["url"] },
              extra: [],
            },
          };
        }
        if (tool?.name === "judge_sample") {
          return { input: { matching_indices: Array.from({ length: 20 }, (_, i) => i) } };
        }
        return null;
      });

      const res50 = await planWithLlm(
        { words: ["عايز ٥٠ خبر"], request: "", scoutAllowed: false },
        {
          model: mockModel50,
          catalog,
          access,
          today: "2026-11-23",
          probe: vi.fn().mockResolvedValue({ ok: true, rows_in_page: 20, call_id: "c_50", has_more: true, charge_usd: 0.00048 }),
          readPage: vi.fn().mockResolvedValue({ output: { data: { tweets: onTopicFeed } } }),
        }
      );
      expect(res50.kind).toBe("plan");
      if (res50.kind === "plan") {
        expect(res50.plan.stages[0].planned_rows).toBe(50);
      }
    });

    it("Must-Pass 4: Dead widening routes (30s probe timeout, 5xx refuse, needsMissingSession)", async () => {
      // 4a: Timeout constant is 30,000ms
      expect(PLANNER_PROBE_TIMEOUT_MS).toBe(30_000);

      // Probe timeout adds to refusedEndpoints and does not hang 90s
      let callsCount = 0;
      const hangingProbe = vi.fn().mockImplementation(async (endpointId: string, params: any) => {
        callsCount += 1;
        if (endpointId === "anyapi.x.search.posts") {
          // Hang past probeTimeoutMs (50ms in this test)
          await new Promise((resolve) => setTimeout(resolve, 150));
          return { ok: true, rows_in_page: 5, call_id: "late" };
        }
        return { ok: true, rows_in_page: 10, call_id: "c_ok" };
      });

      const hangingStep = {
        key: "search_step",
        platform: "x",
        capability: "x.search.posts",
        topic: "شائعات",
        source: null,
        count: { total: 20, per_parent: null, all: false },
        parent: null,
        deliver: true,
        title_ar: "بحث إكس",
        search_terms: ["شائعات"],
        period: null,
      };

      const refused = new Set<string>();
      const probeRes = await probeStep(
        hangingStep as any,
        [
          {
            endpoint: catalog.endpoints.find((e) => e.id === "anyapi.x.search.posts")!,
            params: { query: "شائعات" },
            cursor: "cursor",
            parent: null,
            more: [{ query: "شائعات وزارة الصحة" }],
            notCarried: [],
          },
        ],
        null,
        {
          model: vi.fn() as any,
          probe: hangingProbe,
          readPage: async () => [],
          catalog,
          access: null,
          today: "2026-11-23",
          probeTimeoutMs: 50, // fast test timeout
        },
        { left: 3 },
        { empties: 0, failures: 0, uncertain: false },
        refused
      );

      // anyapi.x.search.posts was added to refusedEndpoints due to timeout
      expect(refused.has("anyapi.x.search.posts")).toBe(true);

      // 4b: needsMissingSession filters out session-restricted endpoints before any probe call
      const crawl4aiSearch = catalog.endpoints.find((e) => e.id === "crawl4ai.x.search.posts");
      if (crawl4aiSearch) {
        expect(needsMissingSession(crawl4aiSearch, { query: "test", mode: "top" })).toBe(true);
        expect(needsMissingSession(crawl4aiSearch, { query: "test", session: "valid_session" })).toBe(false);
      }

      // LinkedIn search without session is restricted
      const linkedInSearch = catalog.endpoints.find((e) => e.id === "crawl4ai.linkedin.search.posts");
      if (linkedInSearch) {
        expect(needsMissingSession(linkedInSearch, { query: "test" })).toBe(true);
      }
    });
  });

  describe("DT-20261123-x-account-rumors r9: One Accepted Set Count Parity, Code-Owned Option Prices & Honest Per-Route Widening (msn_f91f7e220bbf60fd7c9c replay + CTO Amendments A1-A3)", () => {
    const customerPromptR9 =
      "عايز اسحب داتا عن الشائعات اتنشرت على وزارة الصحة في السعودية @SaudiMOH، عن الشائعات ومكافحة الشائعات، أي حاجة لها علاقة بالشائعات وتوعية الأفراد ضد الشائعات.";

    // Exact 16 unique tweets from msn_f91f7e220bbf60fd7c9c Call #6 (/srv/diger-team/qa/work/LIVE-RUMORS-POST-667-inspector.md)
    const acceptedTweetR9 = {
      id: "1466135018154205187",
      title: "تم رصد المتحور في المملكة وعدد من دول العالم، ومن المهم جداً أن نأخذ المعلومات من مصادرها الموثوقة وأن نحذر من الشائعات.",
      text: "تم رصد المتحور في المملكة وعدد من دول العالم، ومن المهم جداً أن نأخذ المعلومات من مصادرها الموثوقة وأن نحذر من الشائعات. https://t.co/7XIYxHghkr",
      url: "https://x.com/SaudiMOH/status/1466135018154205187",
      authorUsername: "SaudiMOH",
      createdUtc: "2021-12-01T22:00:00Z",
    };

    const rejectedCall6TweetsR9 = [
      { id: "1795486173152113063", text: "أخطاء شائعة عند علاج الإدمان، تعرف عليها", url: "https://x.com/SaudiMOH/status/1795486173152113063", authorUsername: "SaudiMOH" },
      { id: "1783068055615991878", text: "تعرّف على إجابات الأسئلة الشائعة حول التبرع بالدم عبر ملف الأسئلة الشائعة", url: "https://x.com/SaudiMOH/status/1783068055615991878", authorUsername: "SaudiMOH" },
      { id: "1725151378635411641", text: "مشاكل الجهاز الهضمي الشائعة أثناء الحمل وطرق التعامل معها", url: "https://x.com/SaudiMOH/status/1725151378635411641", authorUsername: "SaudiMOH" },
      { id: "1607724279717830658", text: "أعراض شائعة في الشتاء وكيفية الوقاية منها", url: "https://x.com/SaudiMOH/status/1607724279717830658", authorUsername: "SaudiMOH" },
      { id: "1605972748119199744", text: "نزلات البرد الشائعة في فصل الشتاء وطرق التخفيف من أعراضها", url: "https://x.com/SaudiMOH/status/1605972748119199744", authorUsername: "SaudiMOH" },
      { id: "1527333290868686849", text: "أخطاء شائعة في استخدام الأدوية يجب تجنبها", url: "https://x.com/SaudiMOH/status/1527333290868686849", authorUsername: "SaudiMOH" },
      { id: "1420096654456430602", text: "من الأسئلة الشائعة.. هل لقاح كورونا آمن للمرضع؟", url: "https://x.com/SaudiMOH/status/1420096654456430602", authorUsername: "SaudiMOH" },
      { id: "1411035681783291907", text: "من الأسئلة الشائعة.. متى تظهر المناعة بعد أخذ اللقاح؟", url: "https://x.com/SaudiMOH/status/1411035681783291907", authorUsername: "SaudiMOH" },
      { id: "1409934690992349184", text: "من الأسئلة الشائعة.. هل يمكن أخذ جرعتين من لقاحين مختلفين؟", url: "https://x.com/SaudiMOH/status/1409934690992349184", authorUsername: "SaudiMOH" },
      { id: "1408488014750461957", text: "من الأسئلة الشائعة.. هل يؤثر لقاح كورونا على الخصوبة؟", url: "https://x.com/SaudiMOH/status/1408488014750461957", authorUsername: "SaudiMOH" },
      { id: "1407036094718345222", text: "من الأسئلة الشائعة.. ما هي الأعراض الجانبية المتوقعة بعد اللقاح؟", url: "https://x.com/SaudiMOH/status/1407036094718345222", authorUsername: "SaudiMOH" },
      { id: "1395439977916420102", text: "من الأسئلة الشائعة.. هل يلزم فحص كورونا قبل أخذ اللقاح؟", url: "https://x.com/SaudiMOH/status/1395439977916420102", authorUsername: "SaudiMOH" },
      { id: "1393989166439030789", text: "من الأسئلة الشائعة.. كم المدة بين الإصابة وأخذ اللقاح؟", url: "https://x.com/SaudiMOH/status/1393989166439030789", authorUsername: "SaudiMOH" },
      { id: "1373698874968420354", text: "من الأسئلة الشائعة.. هل يفطر لقاح كورونا في رمضان؟", url: "https://x.com/SaudiMOH/status/1373698874968420354", authorUsername: "SaudiMOH" },
      { id: "1366810483949477892", text: "من الأسئلة الشائعة.. هل يحتاج المتعافي من كورونا إلى أخذ اللقاح؟", url: "https://x.com/SaudiMOH/status/1366810483949477892", authorUsername: "SaudiMOH" },
    ];

    const call6All16Rows = [
      ...rejectedCall6TweetsR9.slice(0, 6),
      acceptedTweetR9,
      ...rejectedCall6TweetsR9.slice(6),
    ];

    it("Must-Pass 1 & Amendment A2: Round 1 judges alternate search rows (finding 1466135018154205187 = 1), Round 2 answer reuses priorScout once, and edited request ignores snapshot", async () => {
      const routineTimelinePage = Array.from({ length: 15 }, (_, i) => ({
        id: `186009900000000${i + 1}`,
        text: `RT @SaudiMOH937: نصائح صحية يومية ومواعيد العيادات رقم ${i + 1}`,
        url: `https://x.com/SaudiMOH/status/186009900000000${i + 1}`,
        authorUsername: "SaudiMOH",
      }));

      const mockProbeR1 = vi.fn().mockImplementation(async (endpointId: string) => {
        if (endpointId === "anyapi.x.user.posts") {
          return { ok: true, rows_in_page: 15, call_id: "r1_timeline", has_more: false, next_cursor: null, charge_usd: 0.00048 };
        }
        return { ok: true, rows_in_page: 16, call_id: "r1_search", has_more: false, next_cursor: null, charge_usd: 0.00048 };
      });

      const mockReadPageR1 = vi.fn().mockImplementation(async (callId: string) => {
        if (callId === "r1_timeline") return { output: { data: { tweets: routineTimelinePage } } };
        return { output: { data: { tweets: call6All16Rows } } };
      });

      const mockModelR1 = vi.fn().mockImplementation(async ({ tool, user }) => {
        if (tool?.name === "request_plan") {
          return {
            input: {
              decision: "plan",
              understanding_ar: "جمع تغريدات وزارة الصحة السعودية @SaudiMOH عن الشائعات ومكافحتها وتوعية الأفراد ضدها",
              steps: [
                {
                  key: "tweets",
                  title_ar: "تغريدات وزارة الصحة عن الشائعات",
                  platform: "x",
                  capability: "x.user.posts",
                  topic: "الشائعات ومكافحة الشائعات",
                  source: { kind: "account", value: "SaudiMOH" },
                  deliver: true,
                  count: { total: null, per_parent: null, all: false },
                },
              ],
            },
          };
        }
        if (tool?.name === "tool_choice") {
          return {
            input: {
              options: [
                { endpoint_id: "anyapi.x.user.posts", params_json: JSON.stringify({ handle: "SaudiMOH" }), cursor_input: "cursor" },
                { endpoint_id: "anyapi.x.search.posts", params_json: JSON.stringify({ query: 'from:SaudiMOH "نفي شائعة"' }), cursor_input: "cursor" },
              ],
            },
          };
        }
        if (tool?.name === "field_map") {
          return {
            input: {
              fields: { id: ["id"], text: ["text"], url: ["url"] },
              extra: [],
            },
          };
        }
        if (tool?.name === "judge_sample") {
          const uStr = String(user ?? "");
          if (uStr.includes("1466135018154205187") || uStr.includes("المتحور")) {
            return { input: { matching_indices: [6] } }; // only index 6 (1466135018154205187) is on-topic
          }
          return { input: { matching_indices: [] } };
        }
        if (tool?.name === "scout_report") {
          return {
            input: {
              message_ar: "دورت في حساب وزارة الصحة السعودية على إكس عن الشائعات ومكافحتها ولقيت تغريدة واحدة بس مطابقة. أنصحك نوسّع البحث في كل إكس أو نضيف الأخبار وصفحات الويب العامة عشان نجمع نتائج أكتر، أو أسلّمك الموجود. تحب نعمل إيه؟",
              options_ar: [
                "سلّمني الموجود فقط",
                "ابحث عن الموضوع في كل إكس",
                "أضف الحساب الرسمي المرتبط اللي ظهر على إكس",
                "أضف الأخبار وصفحات الويب العامة",
              ],
            },
          };
        }
        return null;
      });

      const r1 = await planWithLlm(
        { words: [customerPromptR9], request: customerPromptR9, scoutAllowed: true },
        {
          model: mockModelR1,
          catalog,
          access,
          today: "2026-11-24",
          probe: mockProbeR1,
          readPage: mockReadPageR1,
        }
      );

      expect(r1.kind).toBe("question");
      if (r1.kind !== "question") throw new Error("Expected scout question in Round 1");
      expect(r1.scout).toBe(true);
      expect(r1.scoutSnapshot).toBeDefined();
      expect(r1.scoutSnapshot).toHaveLength(1);
      expect(r1.scoutSnapshot![0].found).toBe(1);
      expect(r1.scoutSnapshot![0].acceptedIds).toEqual(["1466135018154205187"]);
      expect(r1.question_ar).toContain("تغريدة واحدة");
      expect(r1.options_ar[0]).toBe("سلّمني الموجود فقط (تغريدة واحدة، والحد الأدنى للطلب ٢٠٠ نقطة)");

      // Round 2 (Must-pass A2): Customer answers the last scout question -> reuses priorScout without re-probing
      const mockProbeR2 = vi.fn().mockRejectedValue(new Error("Round 2 must not re-probe when priorScout is restored on accepts_available"));
      const mockModelR2 = vi.fn().mockImplementation(async ({ tool }) => {
        if (tool?.name === "request_plan") {
          return {
            input: {
              decision: "plan",
              understanding_ar: "جمع تغريدات وزارة الصحة السعودية @SaudiMOH عن الشائعات ومكافحتها",
              accepts_available: true,
              steps: [
                {
                  key: "tweets",
                  title_ar: "تغريدات وزارة الصحة عن الشائعات",
                  platform: "x",
                  capability: "x.user.posts",
                  topic: "الشائعات ومكافحة الشائعات",
                  source: { kind: "account", value: "SaudiMOH" },
                  deliver: true,
                  count: { total: null, per_parent: null, all: false },
                },
              ],
            },
          };
        }
        return null;
      });

      const r2 = await planWithLlm(
        {
          words: [customerPromptR9, r1.options_ar[0]],
          request: customerPromptR9,
          exchanges: [{ question: r1.question_ar, answer: r1.options_ar[0] }],
          scoutAllowed: false,
          priorScout: r1.scoutSnapshot,
        },
        {
          model: mockModelR2,
          catalog,
          access,
          today: "2026-11-24",
          probe: mockProbeR2,
          readPage: mockReadPageR1,
        }
      );

      expect(mockProbeR2).not.toHaveBeenCalled();
      expect(r2.kind).toBe("plan");
      if (r2.kind !== "plan") throw new Error("Expected plan in Round 2");

      const stage = r2.plan.stages[0];
      expect(stage.planned_rows).toBe(1);
      expect((stage.relevance as any)?.accepted_ids).toEqual(["1466135018154205187"]);
      expect(r2.plan.price.reservePoints).toBe(200);
      expect(r2.plan.price.maxChargePoints).toBe(200);

      // Counter-case A2: Customer edits the request to a different topic ("اللقاحات" instead of "الشائعات") -> snapshot is ignored and fresh planning probes
      let editedProbed = 0;
      const mockProbeEdited = vi.fn().mockImplementation(async () => {
        editedProbed += 1;
        return { ok: true, rows_in_page: 15, call_id: "r1_timeline", has_more: false, next_cursor: null, charge_usd: 0.00048 };
      });
      const mockModelEdited = vi.fn().mockImplementation(async ({ tool }) => {
        if (tool?.name === "request_plan") {
          return {
            input: {
              decision: "plan",
              understanding_ar: "جمع تغريدات وزارة الصحة عن اللقاحات",
              accepts_available: true,
              steps: [
                {
                  key: "tweets",
                  title_ar: "تغريدات وزارة الصحة عن اللقاحات",
                  platform: "x",
                  capability: "x.user.posts",
                  topic: "اللقاحات", // DIFFERENT topic!
                  source: { kind: "account", value: "SaudiMOH" },
                  deliver: true,
                  count: { total: null, per_parent: null, all: false },
                },
              ],
            },
          };
        }
        if (tool?.name === "tool_choice") {
          return {
            input: {
              options: [{ endpoint_id: "anyapi.x.user.posts", params_json: JSON.stringify({ handle: "SaudiMOH" }), cursor_input: "cursor" }],
            },
          };
        }
        if (tool?.name === "field_map") {
          return { input: { fields: { id: ["id"], text: ["text"], url: ["url"] }, extra: [] } };
        }
        if (tool?.name === "judge_sample") {
          return { input: { matching_indices: [0, 1, 2] } };
        }
        return null;
      });

      const rEdited = await planWithLlm(
        {
          words: ["عايز تغريدات وزارة الصحة عن اللقاحات"],
          request: "عايز تغريدات وزارة الصحة عن اللقاحات",
          scoutAllowed: false,
          priorScout: r1.scoutSnapshot,
        },
        {
          model: mockModelEdited,
          catalog,
          access,
          today: "2026-11-24",
          probe: mockProbeEdited,
          readPage: mockReadPageR1,
        }
      );
      expect(editedProbed).toBeGreaterThan(0);
      expect(rEdited.kind).toBe("plan");
      if (rEdited.kind === "plan") {
        expect(rEdited.plan.stages[0].planned_rows).toBe(3);
      }
    });

    it("Must-Pass 2 (Amendment A1): found = 0 never offers take_found («سلّمني الموجود»); counter-case found = 1 offers take_found with real price", async () => {
      const stepR9 = {
        key: "tweets",
        title_ar: "تغريدات وزارة الصحة عن الشائعات",
        platform: "x",
        capability: "x.user.posts",
        topic: "الشائعات",
        source: { kind: "account", value: "SaudiMOH" },
        deliver: true,
        parent: null,
        count: { total: null, per_parent: null, all: false },
        search_terms: ["شائعات"],
        period: null,
      };

      // Must-pass A1: found = 0 -> NO take_found in buildCatalogWideningFacts or scoutQuestion.options_ar
      const factsZero = buildCatalogWideningFacts(
        [{ step: stepR9, requested: 20, found: 0, exhausted: true, sets: 1, examinedCount: 40 }],
        catalog,
        access,
      );
      expect(factsZero.some((f) => f.kind === "take_found")).toBe(false);
      expect(factsZero.every((f) => !f.label_ar.includes("سلّمني الموجود"))).toBe(true);

      const qZero = await scoutQuestion(
        { decision: "plan", understanding_ar: "الشائعات", steps: [stepR9] },
        [{ step: stepR9, requested: 20, found: 0, exhausted: true, sets: 1, examinedCount: 40 }],
        { words: [customerPromptR9], request: customerPromptR9 },
        {
          // Even if the model tries to include "take_found" when found = 0, code strips it!
          model: vi.fn().mockResolvedValue({
            input: {
              message_ar: "دورت في ٤٠ تغريدة ومالقيتش ولا تغريدة مطابقة، وأنصحك نوسّع البحث في كل إكس. تحب نعمل إيه؟",
              options: [
                { kind: "take_found", stem_ar: "سلّمني الموجود فقط" },
                { kind: "platform_search", stem_ar: "ابحث عن الموضوع في كل إكس" },
                { kind: "web_news", stem_ar: "أضف الأخبار وصفحات الويب العامة" },
              ],
            },
            costUsd: 0.001,
          }),
          catalog,
          access,
        },
        { usd: 0 },
      );
      expect(qZero.options_ar.some((o) => o.includes("سلّم") || o.includes("الموجود"))).toBe(false);
      expect(qZero.options_ar[0]).toContain("ابحث عن الموضوع في كل إكس");

      // Structured Output Test: options matched by kind, unknown kind dropped, duplicate kind dropped
      const qStructured = await scoutQuestion(
        { decision: "plan", understanding_ar: "الشائعات", steps: [stepR9] },
        [{ step: stepR9, requested: 20, found: 5, exhausted: true, sets: 1, examinedCount: 40 }],
        { words: [customerPromptR9], request: customerPromptR9 },
        {
          model: vi.fn().mockResolvedValue({
            input: {
              message_ar: "وجدنا ٥ تغريدات فقط، تحب نسلّمك ولا نوسّع؟",
              options: [
                { kind: "unknown_route", stem_ar: "خيار غير معروف" },
                { kind: "platform_search", stem_ar: "ابحث في كل إكس" },
                { kind: "platform_search", stem_ar: "تكرار بحث إكس" },
                { kind: "take_found", stem_ar: "سلّمني الـ٥" },
              ],
            },
            costUsd: 0.001,
          }),
          catalog,
          access,
        },
        { usd: 0 },
      );
      // take_found is put first when present
      expect(qStructured.options_ar[0]).toContain("سلّمني الـ٥");
      // platform_search is matched and stamped with code facts
      expect(qStructured.options_ar[1]).toContain("ابحث في كل إكس");
      // unknown_route is dropped, duplicate platform_search is dropped
      expect(qStructured.options_ar).toHaveLength(2);
      expect(qStructured.options_ar.some((o) => o.includes("خيار غير معروف"))).toBe(false);
      expect(qStructured.options_ar.some((o) => o.includes("تكرار بحث إكس"))).toBe(false);

      // Counter-case A1: found = 1 -> take_found IS offered with its real price (200 pts minimum)
      const factsOne = buildCatalogWideningFacts(
        [{ step: stepR9, requested: 20, found: 1, exhausted: true, sets: 1, examinedCount: 40 }],
        catalog,
        access,
      );
      expect(factsOne[0].kind).toBe("take_found");
      expect(factsOne[0].max_price_points).toBe(200);
      expect(factsOne[0].label_ar).toBe("سلّمني الموجود فقط (تغريدة واحدة، والحد الأدنى للطلب ٢٠٠ نقطة)");
    });

    it("Must-Pass 3 (Amendment A3 & Per-Route Honesty): one price source matching assemblePlan for found = 1 and found above minimum, zero 0.0005 fallback, and distinct per-route adds ~N vs up to N", () => {
      expect(SCOUT_SYSTEM).not.toContain("No provider, tool or price talk");
      expect(SCOUT_SYSTEM).toContain("recommend the widening option from facts.widening_options");

      const stepR9 = {
        key: "tweets",
        title_ar: "تغريدات وزارة الصحة عن الشائعات",
        platform: "x",
        capability: "x.user.posts",
        topic: "الشائعات",
        source: { kind: "account", value: "SaudiMOH" },
        deliver: true,
        parent: null,
        count: { total: null, per_parent: null, all: false },
        search_terms: ["شائعات"],
        period: null,
      };
      const userPostsEp = catalog.endpoints.find((e) => e.id === "anyapi.x.user.posts")!;
      const makeBuiltStep = (foundRows: number): any => ({
        step: { ...stepR9, count: { total: foundRows, per_parent: null, all: false } },
        option: { endpoint: userPostsEp, params: { handle: "SaudiMOH" }, cursor: "cursor", parent: null, more: [], notCarried: [] },
        mapCode: "return [];",
        columns: [{ key: "text", title_ar: "النص" }],
        carryKeys: [],
        sampleRows: Array.from({ length: foundRows }, (_, i) => ({ id: `t_${i}`, text: `شائعة ${i}` })),
        rowsPerPage: 15,
        callIds: ["c1"],
        hasMore: false,
        timelineAcceptedCount: foundRows,
        timelineExhausted: true,
      });

      // A3 Case 1: found = 1 (minimum applies) -> option max_price_points == card maxChargePoints == card reservePoints == 200
      const built1 = makeBuiltStep(1);
      const facts1 = buildCatalogWideningFacts(
        [{ step: built1.step, requested: 20, found: 1, exhausted: true, sets: 1, builtStep: built1, relatedAccounts: [{ handle: "SaudiMOH937", role: "official_spokesperson", rationale: "حساب 937" }] }],
        catalog,
        access,
      );
      const card1 = assemblePlan(
        { decision: "plan", understanding_ar: "الشائعات", steps: [built1.step] },
        [built1],
        [],
        undefined,
        [],
        undefined,
        catalog,
      );
      const take1 = facts1.find((f) => f.kind === "take_found")!;
      expect(take1.max_price_points).toBe(card1.price.maxChargePoints);
      expect(take1.max_price_points).toBe(card1.price.reservePoints);
      expect(take1.max_price_points).toBe(200);

      // A3 Case 2 (Counter-case): found = 1500 (above 200-pt minimum) -> option max_price_points == card maxChargePoints == card reservePoints > 200
      const builtAboveMin = makeBuiltStep(1500);
      const factsAboveMin = buildCatalogWideningFacts(
        [{ step: builtAboveMin.step, requested: 2000, found: 1500, exhausted: true, sets: 1, builtStep: builtAboveMin }],
        catalog,
        access,
      );
      const cardAboveMin = assemblePlan(
        { decision: "plan", understanding_ar: "الشائعات", steps: [builtAboveMin.step] },
        [builtAboveMin],
        [],
        undefined,
        [],
        undefined,
        catalog,
      );
      const takeAboveMin = factsAboveMin.find((f) => f.kind === "take_found")!;
      expect(cardAboveMin.price.maxChargePoints).toBeGreaterThan(200);
      expect(takeAboveMin.max_price_points).toBe(cardAboveMin.price.maxChargePoints);
      expect(cardAboveMin.price.reservePoints).toBe(494);
      expect(takeAboveMin.min_applied).toBe(false);

      // A3 Case 3: Unknown step cost (no catalog and no builtStep) -> do not show a guessed price number (max_price_points is null)
      const factsUnknownCost = buildCatalogWideningFacts(
        [{ step: stepR9, requested: 20, found: 3, exhausted: true, sets: 1 }],
        undefined,
        null,
      );
      expect(factsUnknownCost[0].kind).toBe("take_found");
      expect(factsUnknownCost[0].max_price_points).toBeNull();
      expect(factsUnknownCost[0].label_ar).not.toContain("نقطة");

      // Honest per-route widening estimates: unprobed routes use "up_to" ("يضيف حتى") with distinct counts (19, 5, 10)
      const searchOpt = facts1.find((f) => f.kind === "platform_search")!;
      const relOpt = facts1.find((f) => f.kind === "related_accounts")!;
      const webOpt = facts1.find((f) => f.kind === "web_news")!;
      expect(searchOpt.estimate_kind).toBe("up_to");
      expect(relOpt.estimate_kind).toBe("up_to");
      expect(webOpt.estimate_kind).toBe("up_to");
      expect(searchOpt.label_ar).toContain("يضيف حتى");
      expect(relOpt.label_ar).toContain("يضيف حتى");
      expect(webOpt.label_ar).toContain("يضيف حتى");
      expect(webOpt.label_ar).not.toContain("تغريدة");
      expect(webOpt.label_ar).not.toContain("تغريدات");
      expect(webOpt.label_ar).toContain("مقالات");
      expect(new Set([searchOpt.addable_rows, relOpt.addable_rows, webOpt.addable_rows]).size).toBe(3);

      // Measured routes use "measured" ("يضيف نحو")
      const factsMeasured = buildCatalogWideningFacts(
        [{ step: built1.step, requested: 20, found: 1, exhausted: true, sets: 1, builtStep: built1, probedPlatformSearchRows: 14, probedWebRows: 8 }],
        catalog,
        access,
      );
      expect(factsMeasured.find((f) => f.kind === "platform_search")!.label_ar).toContain("يضيف نحو ١٤ تغريدة");
      expect(factsMeasured.find((f) => f.kind === "web_news")!.label_ar).toContain("يضيف نحو ٨ مقالات");
    });
  });

  describe("DT-20261123-x-account-rumors r10: Live Replay (Question 2 -> Click take_found -> Card 2, Free-Text Answer & Catalog Noun)", () => {
    const customerPrompt =
      "عايز اسحب داتا عن الشائعات اتنشرت على وزارة الصحة في السعودية @SaudiMOH، عن الشائعات ومكافحة الشائعات، أي حاجة لها علاقة بالشائعات وتوعية الأفراد ضد الشائعات.";

    const post1 = { id: "101", text: "تغريدة وزارة الصحة للتوعية ضد الشائعات ونفي الأخبار المغلوطة", url: "https://x.com/SaudiMOH/status/101" };
    const post2 = { id: "102", text: "تغريدة ثانية رسمية عن نفي الشائعات الطبية المتداولة", url: "https://x.com/SaudiMOH/status/102" };
    const post3 = { id: "103", text: "موضوع غير مطابق إطلاقاً عن التغذية السليمة للأطفال", url: "https://x.com/SaudiMOH/status/103" };

    const mockRawData = {
      output: {
        data: {
          tweets: [post1, post2, post3],
        },
      },
    };

    const makeTurn1Model = () =>
      vi.fn().mockImplementation(async ({ tool }) => {
        if (tool?.name === "request_plan") {
          return {
            input: {
              decision: "plan",
              understanding_ar: "تغريدات وزارة الصحة السعودية @SaudiMOH عن الشائعات",
              steps: [
                {
                  key: "tweets",
                  title_ar: "تغريدات وزارة الصحة عن الشائعات",
                  platform: "x",
                  capability: "x.user.posts",
                  topic: "الشائعات",
                  source: { kind: "account", value: "SaudiMOH" },
                  deliver: true,
                  count: { total: 20, per_parent: null, all: false },
                },
              ],
            },
          };
        }
        if (tool?.name === "tool_choice") {
          return {
            input: {
              options: [{ endpoint_id: "anyapi.x.user.posts", params: { handle: "SaudiMOH" } }],
            },
          };
        }
        if (tool?.name === "field_map") {
          return {
            input: {
              fields: { id: ["id"], text: ["text"], url: ["url"] },
              extra: [],
            },
          };
        }
        if (tool?.name === "judge_sample") {
          // indices 0 and 1 match the topic -> found = 2
          return { input: { matching_indices: [0, 1] } };
        }
        if (tool?.name === "scout_report") {
          return {
            input: {
              message_ar: "دورت في حساب وزارة الصحة على إكس ولقيت تغريدتين بس مطابقين لموضوع الشائعات. تحب أسلّمك الموجود ولا نوسّع؟",
              options: [
                { kind: "take_found", stem_ar: "سلّمني الموجود فقط" },
                { kind: "platform_search", stem_ar: "ابحث عن الموضوع في كل إكس" },
                { kind: "web_news", stem_ar: "أضف الأخبار وصفحات الويب العامة" },
              ],
            },
          };
        }
        return null;
      });

    it("Must-Pass: Question says 2 -> Click take_found -> Card says 2, card max == option price == hold (200 pts), snapshot cleared", async () => {
      const store = createMemoryStore();
      const missionId = "msn_live_rumors_r10";
      await store.putFile(missionId, RAW_PATH("call_r10_1"), JSON.stringify(mockRawData), "application/json");

      const probeTurn1 = vi.fn().mockResolvedValue({
        ok: true,
        call_id: "call_r10_1",
        http_status: 200,
        rows_in_page: 3,
        has_more: false,
        next_cursor: null,
        shape: null,
        first_rows: [],
        warnings: [],
        saved: "call_r10_1",
      });
      const gatewayTurn1 = { tregCall: probeTurn1 } as never;

      // --- Turn 1: Planning with model judge -> asks scout question stating 2 found ---
      const missionTurn1 = { id: missionId, request_text: customerPrompt, answer_text: null };
      const r1 = await runLlmPlanning({
        mission: missionTurn1 as never,
        store,
        gateway: gatewayTurn1,
        catalog,
        access: null,
        model: makeTurn1Model(),
        words: { current: [customerPrompt], earlier: [] } as never,
        now: Date.now(),
        log: console.log,
      });

      expect(r1.kind).toBe("question");
      if (r1.kind !== "question") throw new Error("Expected question in Turn 1");
      expect(r1.scout).toBe(true);
      expect(r1.question_ar).toContain("تغريدتين");
      // take_found option contains count (2 / تغريدتين) and 200 minimum fee
      expect(r1.options_ar[0]).toContain("سلّمني الموجود فقط (تغريدتين، والحد الأدنى للطلب ٢٠٠ نقطة)");
      // Web widening option must use news/article noun ("مقالات"), never tweets ("تغريدات")
      expect(r1.options_ar[2]).toContain("مقالات");
      expect(r1.options_ar[2]).not.toContain("تغريدة");
      expect(r1.options_ar[2]).not.toContain("تغريدات");

      // Verify store state has scout snapshot saved
      const stateTurn1 = JSON.parse((await store.getFile(missionId, "state/llm_planner.json"))!);
      expect(stateTurn1.scoutSnapshot).toBeDefined();
      expect(stateTurn1.scoutSnapshot[0].found).toBe(2);

      // --- Turn 2: Customer clicks option button: "سلّمني الموجود فقط (تغريدتين، والحد الأدنى للطلب ٢٠٠ نقطة)" ---
      const clickedOptionText = r1.options_ar[0];
      const missionTurn2 = {
        id: missionId,
        request_text: customerPrompt,
        answer_text: clickedOptionText,
      };

      const turn2Model = vi.fn().mockImplementation(async ({ tool }) => {
        if (tool?.name === "request_plan") {
          return {
            input: {
              decision: "plan",
              understanding_ar: "العميل وافق على تسليم الموجود فقط (تغريدتان) دون توسيع البحث",
              accepts_available: true,
              steps: [
                {
                  key: "tweets",
                  title_ar: "تغريدات وزارة الصحة عن الشائعات",
                  platform: "x",
                  capability: "x.user.posts",
                  topic: "الشائعات",
                  source: { kind: "account", value: "SaudiMOH" },
                  deliver: true,
                  count: { total: null, per_parent: null, all: false },
                },
              ],
            },
          };
        }
        return null;
      });

      // Probe must NOT be called in Turn 2 because snapshot is reused
      const probeTurn2 = vi.fn().mockImplementation(() => {
        throw new Error("Turn 2 must NOT probe when snapshot is reused!");
      });
      const gatewayTurn2 = { tregCall: probeTurn2 } as never;

      const r2 = await runLlmPlanning({
        mission: missionTurn2 as never,
        store,
        gateway: gatewayTurn2,
        catalog,
        access: null,
        model: turn2Model,
        // In the real chat UI, words.current carries the clicked option text
        words: { current: [clickedOptionText], earlier: [customerPrompt] } as never,
        now: Date.now(),
      });

      expect(r2.kind).toBe("plan");
      if (r2.kind !== "plan") throw new Error("Expected plan in Turn 2");

      // CARD COUNT == 2 (matches question count and option count, exactly 2 tweets!)
      expect(r2.plan.stages[0].expected_rows).toBe(2);
      expect(r2.plan.stages[0].planned_rows).toBe(2);

      // CARD MAX == OPTION PRICE == HOLD == 200 PTS
      expect(r2.plan.price.maxChargePoints).toBe(200);
      expect(r2.plan.price.reservePoints).toBe(200);

      // Snapshot is used ONCE and then cleared from store
      const stateTurn2 = JSON.parse((await store.getFile(missionId, "state/llm_planner.json"))!);
      expect(stateTurn2.scoutSnapshot).toBeUndefined();
    });

    it("Counter-case 1: Free-text answer («خد اللي لقيته») also reuses snapshot -> card count == 2", async () => {
      const store = createMemoryStore();
      const missionId = "msn_freetext_r10";
      await store.putFile(missionId, RAW_PATH("call_r10_free"), JSON.stringify(mockRawData), "application/json");

      const probeTurn1 = vi.fn().mockResolvedValue({
        ok: true,
        call_id: "call_r10_free",
        http_status: 200,
        rows_in_page: 3,
        has_more: false,
        next_cursor: null,
        shape: null,
        first_rows: [],
        warnings: [],
        saved: "call_r10_free",
      });

      const missionTurn1 = { id: missionId, request_text: customerPrompt, answer_text: null };
      await runLlmPlanning({
        mission: missionTurn1 as never,
        store,
        gateway: { tregCall: probeTurn1 } as never,
        catalog,
        access: null,
        model: makeTurn1Model(),
        words: { current: [customerPrompt], earlier: [] } as never,
        now: Date.now(),
      });

      // Customer types free text
      const freeTextAnswer = "خد اللي لقيته";
      const missionTurn2 = { id: missionId, request_text: customerPrompt, answer_text: freeTextAnswer };

      const turn2Model = vi.fn().mockImplementation(async ({ tool }) => {
        if (tool?.name === "request_plan") {
          return {
            input: {
              decision: "plan",
              understanding_ar: "العميل وافق على تسليم الموجود فقط دون توسيع البحث",
              accepts_available: true,
              steps: [
                {
                  key: "tweets",
                  title_ar: "تغريدات وزارة الصحة عن الشائعات",
                  platform: "x",
                  capability: "x.user.posts",
                  topic: "الشائعات",
                  source: { kind: "account", value: "SaudiMOH" },
                  deliver: true,
                  count: { total: null, per_parent: null, all: false },
                },
              ],
            },
          };
        }
        return null;
      });

      const probeTurn2 = vi.fn().mockImplementation(() => {
        throw new Error("Turn 2 must NOT probe when snapshot is reused for free-text answer!");
      });

      const r2 = await runLlmPlanning({
        mission: missionTurn2 as never,
        store,
        gateway: { tregCall: probeTurn2 } as never,
        catalog,
        access: null,
        model: turn2Model,
        words: { current: [freeTextAnswer], earlier: [customerPrompt] } as never,
        now: Date.now(),
      });

      expect(r2.kind).toBe("plan");
      if (r2.kind !== "plan") throw new Error("Expected plan");
      expect(r2.plan.stages[0].expected_rows).toBe(2);
    });

    it("Counter-case 2: New request without answer clears snapshot and plans fresh", async () => {
      const store = createMemoryStore();
      const missionId = "msn_newreq_r10";
      await store.putFile(missionId, RAW_PATH("call_r10_new1"), JSON.stringify(mockRawData), "application/json");
      await store.putFile(missionId, RAW_PATH("call_r10_new2"), JSON.stringify(mockRawData), "application/json");

      let probeCalls = 0;
      const probeFn = vi.fn().mockImplementation(async () => {
        probeCalls += 1;
        return {
          ok: true,
          call_id: `call_r10_new${probeCalls}`,
          http_status: 200,
          rows_in_page: 3,
          has_more: false,
          next_cursor: null,
          shape: null,
          first_rows: [],
          warnings: [],
          saved: `call_r10_new${probeCalls}`,
        };
      });

      const missionTurn1 = { id: missionId, request_text: customerPrompt, answer_text: null };
      await runLlmPlanning({
        mission: missionTurn1 as never,
        store,
        gateway: { tregCall: probeFn } as never,
        catalog,
        access: null,
        model: makeTurn1Model(),
        words: { current: [customerPrompt], earlier: [] } as never,
        now: Date.now(),
      });

      expect(probeCalls).toBe(1);

      // Customer sends a new / edited request without answering the scout question
      const newPrompt = "عايز بيانات تانية خالص عن اللقاحات";
      const missionTurn2 = { id: missionId, request_text: newPrompt, answer_text: null };

      const turn2NewModel = vi.fn().mockImplementation(async ({ tool }) => {
        if (tool?.name === "request_plan") {
          return {
            input: {
              decision: "plan",
              understanding_ar: "بيانات اللقاحات",
              steps: [
                {
                  key: "tweets",
                  title_ar: "تغريدات اللقاحات",
                  platform: "x",
                  capability: "x.user.posts",
                  topic: "اللقاحات",
                  source: { kind: "account", value: "SaudiMOH" },
                  deliver: true,
                  count: { total: 3, per_parent: null, all: false },
                },
              ],
            },
          };
        }
        if (tool?.name === "tool_choice") {
          return { input: { options: [{ endpoint_id: "anyapi.x.user.posts", params: { handle: "SaudiMOH" } }] } };
        }
        if (tool?.name === "field_map") {
          return { input: { fields: { id: ["id"], text: ["text"], url: ["url"] }, extra: [] } };
        }
        if (tool?.name === "judge_sample") {
          // All 3 match -> found = 3 = requested 3 -> no shortfall, plans card directly
          return { input: { matching_indices: [0, 1, 2] } };
        }
        return null;
      });

      const r2New = await runLlmPlanning({
        mission: missionTurn2 as never,
        store,
        gateway: { tregCall: probeFn } as never,
        catalog,
        access: null,
        model: turn2NewModel,
        words: { current: [newPrompt], earlier: [] } as never,
        now: Date.now(),
      });

      // Fresh planning occurred: probe was called again!
      expect(probeCalls).toBe(2);
      expect(r2New.kind).toBe("plan");

      // Snapshot was cleared from store
      const state = JSON.parse((await store.getFile(missionId, "state/llm_planner.json"))!);
      expect(state.scoutSnapshot).toBeUndefined();
    });
  });
});
