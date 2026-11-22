import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { planWithLlm, type PlannerModel } from "../agent/src/llmPlanner/planner";
import { acceptOf } from "../agent/src/llmPlanner/run";
import { usableEndpoint } from "../agent/src/llmPlanner/catalogView";
import { callTregWithAsync } from "../agent/src/asyncTreg";
import { RAW_PATH, type GatewayCallResult } from "../agent/src/gateway";

const catalog = loadTregCatalog();

function scriptedModel(answers: Record<string, unknown[]>): PlannerModel {
  return async ({ tool }) => {
    const name = tool?.name ?? "none";
    const next = (answers[name] ?? []).shift();
    if (next === undefined) return null;
    return { input: next as any, costUsd: 0.001 };
  };
}

describe("FX-CAT Ph1 Phase 5: Must-Pass Suite (6+ Non-325 Catalog Endpoints)", () => {
  it("1. 1688 wholesale products: plans justoneapi.x.1688-search-item-list-v1", async () => {
    const reqText = "عايز ٢٠ منتج جملة لإكسسوارات الموبايل من 1688";
    const understood = {
      decision: "plan",
      understanding_ar: "منتجات جملة لإكسسوارات الموبايل من 1688",
      assumptions_ar: [],
      steps: [
        {
          key: "products",
          title_ar: "المنتجات",
          platform: "1688",
          capability: "1688.search.items",
          parent: null,
          deliver: true,
          count: { total: 20, per_parent: null, all: false },
          source: null,
          topic: "إكسسوارات الموبايل",
          search_terms: ["mobile accessories"],
          period: null,
        },
      ],
    };
    const choice = {
      options: [
        {
          endpoint_id: "justoneapi.x.1688-search-item-list-v1",
          params: { keyword: "mobile accessories" },
          cursor_input: null,
          parent_input: null,
          more_params: [],
        },
      ],
    };
    const map = {
      fields: { id: ["offerId"], title: ["subject"], price: ["price"] },
      extra: [],
    };
    const pageData = {
      code: 0,
      data: {
        data: {
          OFFER: {
            items: [{ offerId: "12345", subject: "Phone Case", price: "5.5" }],
          },
        },
      },
    };

    const model = scriptedModel({
      request_plan: [understood],
      tool_choice: [choice],
      field_map: [map],
    });

    const r = await planWithLlm(
      { words: [reqText], request: reqText, scoutAllowed: false },
      {
        model,
        catalog,
        access: null,
        probe: async (endpointId, params) =>
          ({
            ok: true,
            call_id: "call_1688",
            http_status: 200,
            rows_in_page: 1,
            first_rows: [{ offerId: "12345" }],
            shape: { rows_in_page: 1, list_path: "data.data.OFFER.items" },
            saved: "call_1688",
          } as any),
        readPage: async () => pageData,
        today: "2026-11-22",
        accept: acceptOf(catalog, null),
      }
    );

    expect(r.kind).toBe("plan");
    if (r.kind === "plan") {
      expect(r.plan.stages[0].endpoint_id).toBe("justoneapi.x.1688-search-item-list-v1");
      expect(r.plan.stages[0].engine?.params).toEqual({ keyword: "mobile accessories" });
    }
  });

  it("2. stocks daily OHLCV prices: plans marketstack.eod", async () => {
    const reqText = "هات أسعار إغلاق سهم AAPL آخر شهر من الأسهم";
    const understood = {
      decision: "plan",
      understanding_ar: "أسعار إغلاق سهم أبل لآخر شهر",
      assumptions_ar: [],
      steps: [
        {
          key: "prices",
          title_ar: "الأسعار",
          platform: "stocks",
          capability: "stocks.eod.history",
          parent: null,
          deliver: true,
          count: { total: 30, per_parent: null, all: false },
          source: null,
          topic: "AAPL",
          search_terms: ["AAPL"],
          period: { from: "2026-10-22", to: "2026-11-22" },
        },
      ],
    };
    const choice = {
      options: [
        {
          endpoint_id: "marketstack.eod",
          params: { symbols: "AAPL", date_from: "2026-10-22", date_to: "2026-11-22" },
          cursor_input: "offset",
          parent_input: null,
          more_params: [],
        },
      ],
    };
    const map = {
      fields: { id: ["date"], symbol: ["symbol"], close: ["close"], volume: ["volume"] },
      extra: [],
    };
    const pageData = {
      pagination: { limit: 100, offset: 0, count: 30, total: 30 },
      data: [{ symbol: "AAPL", close: 220.5, volume: 50000000, date: "2026-11-21T00:00:00+0000" }],
    };

    const model = scriptedModel({
      request_plan: [understood],
      tool_choice: [choice],
      field_map: [map],
    });

    const r = await planWithLlm(
      { words: [reqText], request: reqText, scoutAllowed: false },
      {
        model,
        catalog,
        access: null,
        probe: async () =>
          ({
            ok: true,
            call_id: "call_stocks",
            http_status: 200,
            rows_in_page: 1,
            first_rows: [{ symbol: "AAPL" }],
            shape: { rows_in_page: 1, list_path: "data" },
            saved: "call_stocks",
          } as any),
        readPage: async () => pageData,
        today: "2026-11-22",
        accept: acceptOf(catalog, null),
      }
    );

    expect(r.kind).toBe("plan");
    if (r.kind === "plan") {
      expect(r.plan.stages[0].endpoint_id).toBe("marketstack.eod");
      expect(r.plan.stages[0].engine?.params).toEqual({
        symbols: "AAPL",
        date_from: "2026-10-22",
        date_to: "2026-11-22",
      });
    }
  });

  it("3. github repository issues: plans crawl4ai.github.repo.issues", async () => {
    const reqText = "عايز أحدث ٢٠ مشكلة مفتوحة في مستودع vercel/next.js على جيت هب";
    const understood = {
      decision: "plan",
      understanding_ar: "مشاكل مفتوحة في مستودع vercel/next.js على جيت هب",
      assumptions_ar: [],
      steps: [
        {
          key: "issues",
          title_ar: "المشاكل",
          platform: "github",
          capability: "github.repo.issues",
          parent: null,
          deliver: true,
          count: { total: 20, per_parent: null, all: false },
          source: null,
          topic: "vercel/next.js",
          search_terms: ["vercel/next.js"],
          period: null,
        },
      ],
    };
    const choice = {
      options: [
        {
          endpoint_id: "crawl4ai.github.repo.issues",
          params: { repo: "vercel/next.js", state: "open" },
          cursor_input: "page",
          parent_input: null,
          more_params: [],
        },
      ],
    };
    const map = {
      fields: { id: ["id"], title: ["title"], state: ["state"] },
      extra: [],
    };
    const pageData = {
      issues: [{ id: "issue_1", title: "Bug in router", state: "open" }],
    };

    const model = scriptedModel({
      request_plan: [understood],
      tool_choice: [choice],
      field_map: [map],
    });

    const r = await planWithLlm(
      { words: [reqText], request: reqText, scoutAllowed: false },
      {
        model,
        catalog,
        access: null,
        probe: async () =>
          ({
            ok: true,
            call_id: "call_github",
            http_status: 200,
            rows_in_page: 1,
            first_rows: [{ id: "issue_1" }],
            shape: { rows_in_page: 1, list_path: "issues" },
            saved: "call_github",
          } as any),
        readPage: async () => pageData,
        today: "2026-11-22",
        accept: acceptOf(catalog, null),
      }
    );

    expect(r.kind).toBe("plan");
    if (r.kind === "plan") {
      expect(r.plan.stages[0].endpoint_id).toBe("crawl4ai.github.repo.issues");
      expect(r.plan.stages[0].engine?.params).toEqual({ repo: "vercel/next.js", state: "open" });
    }
  });

  it("4. telegram channel info: plans tikhub.x.telegram-web-fetch-channel-info with shapeReader inference", async () => {
    const reqText = "هات بيانات قناة تليجرام durov";
    const understood = {
      decision: "plan",
      understanding_ar: "بيانات قناة تليجرام durov",
      assumptions_ar: [],
      steps: [
        {
          key: "channel",
          title_ar: "القناة",
          platform: "telegram",
          capability: "telegram.channel.info",
          parent: null,
          deliver: true,
          count: { total: 1, per_parent: null, all: false },
          source: null,
          topic: "durov",
          search_terms: ["durov"],
          period: null,
        },
      ],
    };
    const choice = {
      options: [
        {
          endpoint_id: "tikhub.x.telegram-web-fetch-channel-info",
          params: { channel: "durov" },
          cursor_input: null,
          parent_input: null,
          more_params: [],
        },
      ],
    };
    const map = {
      fields: { id: ["username"], title: ["title"], subscribers: ["subscribers"] },
      extra: [],
    };
    const pageData = {
      ok: true,
      channel_info: { username: "durov", title: "Durov", subscribers: 1200000, description: "Official channel" },
    };

    const model = scriptedModel({
      request_plan: [understood],
      tool_choice: [choice],
      field_map: [map],
    });

    const r = await planWithLlm(
      { words: [reqText], request: reqText, scoutAllowed: false },
      {
        model,
        catalog,
        access: null,
        probe: async () =>
          ({
            ok: true,
            call_id: "call_telegram",
            http_status: 200,
            rows_in_page: 1,
            first_rows: [{ username: "durov" }],
            shape: { rows_in_page: 1, list_path: "channel_info" },
            saved: "call_telegram",
          } as any),
        readPage: async () => pageData,
        today: "2026-11-22",
        accept: acceptOf(catalog, null),
      }
    );

    console.log("TELEGRAM RESULT:", JSON.stringify(r));

    expect(r.kind).toBe("plan");
    if (r.kind === "plan") {
      expect(r.plan.stages[0].endpoint_id).toBe("tikhub.x.telegram-web-fetch-channel-info");
      expect(r.plan.stages[0].engine?.params).toEqual({ channel: "durov" });
    }
  });

  it("5. crunchbase company profile: plans crawl4ai.crunchbase.company.profile", async () => {
    const reqText = "عايز ملف شركة Anthropic على كرانش بيس";
    const understood = {
      decision: "plan",
      understanding_ar: "ملف شركة Anthropic على كرانش بيس",
      assumptions_ar: [],
      steps: [
        {
          key: "company",
          title_ar: "الشركة",
          platform: "crunchbase",
          capability: "crunchbase.company.profile",
          parent: null,
          deliver: true,
          count: { total: 1, per_parent: null, all: false },
          source: null,
          topic: "Anthropic",
          search_terms: ["Anthropic"],
          period: null,
        },
      ],
    };
    const choice = {
      options: [
        {
          endpoint_id: "crawl4ai.crunchbase.company.profile",
          params: { company: "anthropic" },
          cursor_input: null,
          parent_input: null,
          more_params: [],
        },
      ],
    };
    const map = {
      fields: { id: ["company_name"], description: ["description"], valuation: ["valuation"] },
      extra: [],
    };
    const pageData = {
      company: { company_name: "Anthropic", description: "AI safety and research", valuation: 18000000000 },
    };

    const model = scriptedModel({
      request_plan: [understood],
      tool_choice: [choice],
      field_map: [map],
    });

    const r = await planWithLlm(
      { words: [reqText], request: reqText, scoutAllowed: false },
      {
        model,
        catalog,
        access: null,
        probe: async () =>
          ({
            ok: true,
            call_id: "call_crunchbase",
            http_status: 200,
            rows_in_page: 1,
            first_rows: [{ company_name: "Anthropic" }],
            shape: { rows_in_page: 1, list_path: "company" },
            saved: "call_crunchbase",
          } as any),
        readPage: async () => pageData,
        today: "2026-11-22",
        accept: acceptOf(catalog, null),
      }
    );

    expect(r.kind).toBe("plan");
    if (r.kind === "plan") {
      expect(r.plan.stages[0].endpoint_id).toBe("crawl4ai.crunchbase.company.profile");
      expect(r.plan.stages[0].engine?.params).toEqual({ company: "anthropic" });
    }
  });

  it("6. ai-search LLM answer: plans serpapi.x.brave-ai-mode", async () => {
    const reqText = "عايز إجابة بحث الذكاء الاصطناعي Brave عن أفضل أدوات التحليل";
    const understood = {
      decision: "plan",
      understanding_ar: "إجابة بحث الذكاء الاصطناعي Brave عن أفضل أدوات التحليل",
      assumptions_ar: [],
      steps: [
        {
          key: "answer",
          title_ar: "الإجابة",
          platform: "ai-search",
          capability: "ai-search.brave.answer",
          parent: null,
          deliver: true,
          count: { total: 1, per_parent: null, all: false },
          source: null,
          topic: "أفضل أدوات التحليل",
          search_terms: ["أفضل أدوات التحليل"],
          period: null,
        },
      ],
    };
    const choice = {
      options: [
        {
          endpoint_id: "serpapi.x.brave-ai-mode",
          params: { engine: "brave_ai_mode", q: "أفضل أدوات التحليل" },
          cursor_input: null,
          parent_input: null,
          more_params: [],
        },
      ],
    };
    const map = {
      fields: { id: ["position"], text: ["text"] },
      extra: [],
    };
    const pageData = {
      text_blocks: [{ position: 1, text: "Analysis tools summary..." }],
    };

    const model = scriptedModel({
      request_plan: [understood],
      tool_choice: [choice],
      field_map: [map],
    });

    const r = await planWithLlm(
      { words: [reqText], request: reqText, scoutAllowed: false },
      {
        model,
        catalog,
        access: null,
        probe: async () =>
          ({
            ok: true,
            call_id: "call_aisearch",
            http_status: 200,
            rows_in_page: 1,
            first_rows: [{ position: 1 }],
            shape: { rows_in_page: 1, list_path: "text_blocks" },
            saved: "call_aisearch",
          } as any),
        readPage: async () => pageData,
        today: "2026-11-22",
        accept: acceptOf(catalog, null),
      }
    );

    expect(r.kind).toBe("plan");
    if (r.kind === "plan") {
      expect(r.plan.stages[0].endpoint_id).toBe("serpapi.x.brave-ai-mode");
      expect(r.plan.stages[0].engine?.params).toEqual({
        engine: "brave_ai_mode",
        q: "أفضل أدوات التحليل",
      });
    }
  });

  it("7. dataforseo async App Store reviews (async_config submit + poll): plans dataforseo.x.app-data-apple-app-reviews-task-post", async () => {
    const reqText = "عايز مراجعات تطبيق من متجر أبل";
    const understood = {
      decision: "plan",
      understanding_ar: "مراجعات تطبيق من متجر أبل",
      assumptions_ar: [],
      steps: [
        {
          key: "reviews",
          title_ar: "المراجعات",
          platform: "app-store",
          capability: "app-store.reviews",
          parent: null,
          deliver: true,
          count: { total: 10, per_parent: null, all: false },
          source: null,
          topic: "com.test",
          search_terms: ["com.test"],
          period: null,
        },
      ],
    };
    const choice = {
      options: [
        {
          endpoint_id: "dataforseo.x.app-data-apple-app-reviews-task-post",
          params: { app_id: "com.test" },
          cursor_input: null,
          parent_input: null,
          more_params: [],
        },
      ],
    };
    const map = {
      fields: { id: ["id"], rating: ["rating"], text: ["text"] },
      extra: [],
    };

    const files = new Map<string, string>();
    const store = {
      async getFile(_mid: string, path: string) {
        return files.get(path) ?? null;
      },
      async putFile(_mid: string, path: string, content: string) {
        files.set(path, content);
      },
    } as any;

    let callSeq = 0;
    const callFn = async (endpointId: string, _params: Record<string, unknown>): Promise<GatewayCallResult> => {
      callSeq++;
      const callId = `call_${String(callSeq).padStart(4, "0")}`;
      if (endpointId === "dataforseo.x.app-data-apple-app-reviews-task-post") {
        files.set(RAW_PATH(callId), JSON.stringify({ tasks: [{ id: "task_e2e" }] }));
        return { ok: true, call_id: callId, http_status: 200, rows_in_page: 0 } as GatewayCallResult;
      }
      files.set(
        RAW_PATH(callId),
        JSON.stringify({
          tasks: [{ status_code: 20000, result: [{ items: [{ id: "rev_1", rating: 5, text: "Top" }] }] }],
        })
      );
      return { ok: true, call_id: callId, http_status: 200, rows_in_page: 0 } as GatewayCallResult;
    };

    const model = scriptedModel({
      request_plan: [understood],
      tool_choice: [choice],
      field_map: [map],
    });

    const r = await planWithLlm(
      { words: [reqText], request: reqText, scoutAllowed: false },
      {
        model,
        catalog,
        access: null,
        probe: async (endpointId, params) =>
          callTregWithAsync(
            { catalog, store, missionId: "m_e2e_async", sleep: async () => {} },
            callFn,
            endpointId,
            params
          ),
        readPage: async (callId) => {
          const raw = files.get(RAW_PATH(callId));
          return raw ? JSON.parse(raw) : null;
        },
        today: "2026-11-22",
        accept: acceptOf(catalog, null),
      }
    );

    expect(r.kind).toBe("plan");
    if (r.kind === "plan") {
      expect(r.plan.stages[0].endpoint_id).toBe("dataforseo.x.app-data-apple-app-reviews-task-post");
      expect(r.plan.stages[0].engine?.params).toEqual({ app_id: "com.test" });
    }
  });
});

describe("FX-CAT Ph1 Phase 5: Mandatory Counter-Cases", () => {
  it("1. companies + managers hands over to B2B special pipeline (acceptOf returns false)", () => {
    const accept = acceptOf(catalog, null);
    const b2bUnderstanding = {
      decision: "plan",
      understanding_ar: "شركات برمجة في دبي مع مديريها",
      assumptions_ar: [],
      steps: [
        {
          key: "companies",
          title_ar: "الشركات",
          platform: "companies",
          capability: "companies.search",
          parent: null,
          deliver: true,
          count: { total: 10, per_parent: null, all: false },
          source: null,
          topic: "software in dubai",
          search_terms: ["software dubai"],
          period: null,
        },
        {
          key: "people",
          title_ar: "المديرون",
          platform: "people",
          capability: "people.search",
          parent: "companies",
          deliver: true,
          count: { total: null, per_parent: 3, all: false },
          source: null,
          topic: "managers",
          search_terms: ["manager"],
          period: null,
        },
      ],
      people_of_companies: { asked: true },
    };

    expect(accept(b2bUnderstanding as any)).toBe(false);
  });

  it("2. social comments child step with parent binding preserves parent-child planning", async () => {
    const reqText = "عايز ٢٠ منشور على فيسبوك عن السياحة مع ٥ تعليقات لكل منشور";
    const understood = {
      decision: "plan",
      understanding_ar: "منشورات فيسبوك عن السياحة مع تعليقاتها",
      assumptions_ar: [],
      steps: [
        {
          key: "posts",
          title_ar: "المنشورات",
          platform: "facebook",
          capability: "facebook.search.posts",
          parent: null,
          deliver: true,
          count: { total: 20, per_parent: null, all: false },
          source: null,
          topic: "السياحة",
          search_terms: ["السياحة"],
          period: null,
        },
        {
          key: "comments",
          title_ar: "التعليقات",
          platform: "facebook",
          capability: "facebook.post.comments",
          parent: "posts",
          deliver: true,
          count: { total: null, per_parent: 5, all: false },
          source: null,
          topic: null,
          search_terms: [],
          period: null,
        },
      ],
    };
    const choicePosts = {
      options: [
        {
          endpoint_id: "justoneapi.x.facebook-search-post-v1",
          params: { keyword: "السياحة" },
          cursor_input: "cursor",
          parent_input: null,
          more_params: [],
        },
      ],
    };
    const choiceComments = {
      options: [
        {
          endpoint_id: "justoneapi.x.facebook-get-post-comments-v1",
          params: {},
          cursor_input: "cursor",
          parent_input: { param: "postId", from_field: "id" },
          more_params: [],
        },
      ],
    };
    const mapPosts = {
      fields: { id: ["id"], text: ["text"] },
      extra: [],
    };
    const mapComments = {
      fields: { id: ["id"], text: ["text"], author: ["author"] },
      extra: [],
    };

    const model = scriptedModel({
      request_plan: [understood],
      tool_choice: [choicePosts, choiceComments],
      field_map: [mapPosts, mapComments],
    });

    const r = await planWithLlm(
      { words: [reqText], request: reqText, scoutAllowed: false },
      {
        model,
        catalog,
        access: null,
        probe: async (endpointId) =>
          ({
            ok: true,
            call_id: `call_${endpointId}`,
            http_status: 200,
            rows_in_page: 1,
            first_rows: [{ id: endpointId.includes("comment") ? "c1" : "p1" }],
            shape: { rows_in_page: 1, list_path: "items" },
            saved: `call_${endpointId}`,
          } as any),
        readPage: async (callId) => ({
          items: callId.includes("comment")
            ? [{ id: "c1", text: "nice", author: "user1" }]
            : [{ id: "p1", text: "sample" }],
        }),
        today: "2026-11-22",
        accept: acceptOf(catalog, null),
      }
    );

    expect(r.kind).toBe("plan");
    if (r.kind === "plan") {
      expect(r.plan.stages).toHaveLength(2);
      expect(r.plan.stages[1].parent_key).toBe("posts");
      expect(r.plan.stages[1].engine?.parent_binding).toEqual({ param: "postId", from: "id" });
    }
  });

  it("3. security / policy blocks unchanged: write actions, own_account, and paused providers blocked", () => {
    // Write action
    expect(usableEndpoint({ id: "treg.x.write", platform: "x", capability: "x.post", scope: null, method: "POST" } as any, catalog, null)).toBe(false);
    // Own account
    expect(usableEndpoint({ id: "treg.x.own", platform: "x", capability: "x.read", scope: "own_account", method: "GET" } as any, catalog, null)).toBe(false);
    // Paused provider (apollo)
    expect(usableEndpoint({ id: "apollo.people.search", platform: "people", capability: "people.search", scope: null, method: "POST" } as any, catalog, null)).toBe(false);
    // Paused provider (datagma)
    expect(usableEndpoint({ id: "datagma.people.search", platform: "people", capability: "people.search", scope: null, method: "POST" } as any, catalog, null)).toBe(false);
  });
});
