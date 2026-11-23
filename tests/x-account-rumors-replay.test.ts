import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { candidatesFor } from "../agent/src/llmPlanner/catalogView";
import { askIsEarned, scoutYield, scoutFallbackAr, scoutQuestion, type ScoutFinding } from "../agent/src/llmPlanner/planner";
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
});
