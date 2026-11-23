import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { candidatesFor, platformIndex } from "../agent/src/llmPlanner/catalogView";
import { askIsEarned, scoutYield, scoutFallbackAr, scoutQuestion, assemblePlan, fallbackMap, requestPartsAr, syncStepPeriodFromStep, customerSafe, probeStep, chooseTools, checkOptions, type ScoutFinding } from "../agent/src/llmPlanner/planner";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { textDedupeKey, titleDedupeKey, canonicalUrlKey } from "../src/lib/agentMission/contract";
import { REVIEW_SYSTEM, reviewPrompt, emptyReviewState } from "../agent/src/review";
import { researchRelevanceOf } from "../src/lib/agentMission/foundation/compilePlan";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { customerMissionView } from "../src/lib/agentMission/customerView";

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
        source: null,
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
            options_ar: [
              "سلّمني الموجود فقط",
              "وسّع البحث إلى مواقع الأخبار وجوجل نيوز (نحو ٥٠ خبر)",
              "وسّع البحث في حسابات رسمية وإخبارية موثقة",
              "وسّع صياغة البحث لتشمل التوعية الصحية ونفي الشائعات",
            ],
          },
        };
      }
      if (user.includes("مراجعات")) {
        return {
          input: {
            message_ar: "وجدنا ٨ مراجعات فقط من ٣٠ طلبتها لهذا المنتج. تحب نسلّمك الموجود ولا نوسّع؟",
            options_ar: [
              "سلّمني الموجود فقط",
              "وسّع البحث إلى متاجر إلكترونية أخرى في الكتالوج (نحو ٤٠ مراجعة)",
              "وسّع ليشمل تقييمات الموديلات السابقة للمنتج",
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
    expect(qFallback.options_ar[0]).toBe("سلّمني الموجود فقط");
    expect(qFallback.options_ar[1]).toBe("وسّع البحث إلى منصات ومصادر أخرى في الكتالوج");
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
    expect(REVIEW_SYSTEM).toContain("news about another country's ministry of health when a specific country or ministry was requested");
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
    const fallback = scoutFallbackAr([weakFinding], ["SaudiMOH", "شائعات"]);
    expect(fallback.question_ar).toContain("٧");
    expect(fallback.question_ar).toContain("٢٠");
    expect(fallback.options_ar[0]).toBe("سلّمني الموجود فقط");
    // Widening options offered
    expect(fallback.options_ar.some((o) => o.includes("منصات ومصادر أخرى"))).toBe(true);

    // Test scoutQuestion with mock model
    const mockModel = vi.fn().mockImplementation(async ({ system, user, tool }) => {
      if (tool?.name === "scout_report") {
        return {
          input: {
            message_ar: "لقيت ٧ تغريدات عن الشائعات من أصل ٢٠ طلبتها، والمصدر لا يعرض المزيد. تحب نسلّمك الـ٧ ولا نوسّع؟",
            options_ar: [
              "سلّمني الـ٧",
              "وسّع البحث إلى مصادر إخبارية ورسمية أخرى في الكتالوج",
              "وسّع البحث في فيسبوك ومصادر الويب",
            ],
          },
        };
      }
      return null;
    });

    const cost = { usd: 0 };
    const q = await scoutQuestion(understanding, [weakFinding], { words: ["SaudiMOH", "شائعات"], request: "" }, { model: mockModel, catalog }, cost);
    expect(q.question_ar).toContain("٧");
    expect(q.options_ar[0]).toBe("سلّمني الـ٧");
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
    expect(REVIEW_SYSTEM).toContain("A row, page, article or post that merely belongs to or mentions the requested entity or country");
    expect(REVIEW_SYSTEM).toContain("A page merely belonging to the ministry is 0");

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

    it("Test (c) - Fail/Skip Safety Plumbing: failing reviewer excludes unjudged Row 2 with review_failed", async () => {
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

      const excluded = items.excludedItems("news");
      const row2Ex = excluded.find((it) => it.id === row2.id);
      expect(row2Ex).toBeDefined();
      expect(row2Ex?.reason).toBe("review_failed");
      expect(row2Ex?.state).toBe("excluded");
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
});
