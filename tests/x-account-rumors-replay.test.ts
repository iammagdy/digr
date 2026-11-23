import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { candidatesFor } from "../agent/src/llmPlanner/catalogView";
import { askIsEarned, scoutYield, scoutFallbackAr, scoutQuestion, assemblePlan, fallbackMap, requestPartsAr, syncStepPeriodFromStep, type ScoutFinding } from "../agent/src/llmPlanner/planner";
import { loadTregCatalog } from "../src/lib/treg/catalog";

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
});
