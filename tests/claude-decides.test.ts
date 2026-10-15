import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock catalogClient before chatHandler loads it
vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { searchCatalog, getCachedCatalogEndpoints } from "../src/functions/shared/catalogClient";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting, getConversationBrief } from "../src/functions/shared/briefManager";

const mockedSearchCatalog = vi.mocked(searchCatalog);
const mockedGetCachedCatalogEndpoints = vi.mocked(getCachedCatalogEndpoints);

const FB_SEARCH_ENDPOINT: any = {
  slug: "facebook-post-search",
  id: "treg-facebook-post-search-v1",
  nameAr: "البحث في منشورات فيسبوك العامة",
  nameEn: "Facebook Public Post Search",
  platform: "facebook",
  category: "facebook",
  status: "verified",
  enabled: true,
  summaryAr: "البحث عن منشورات عامة في فيسبوك",
  billingUnit: "call",
  catalogPriceUsd: 0.03,
  pointsPerUnit: 18,
  pagination: { type: "cursor", maxLimit: 50 },
  observedSuccessRate: 0.95,
  method: "GET",
  paramsSchema: JSON.stringify({
    type: "object",
    properties: { query: { type: "string" }, maxResults: { type: "integer" } },
    required: ["query"],
  }),
};

const FB_COMMENTS_ENDPOINT: any = {
  slug: "facebook-post-comments",
  id: "treg-facebook-post-comments-v1",
  nameAr: "استخراج تعليقات منشورات فيسبوك العامة",
  nameEn: "Facebook Post Comments",
  platform: "facebook",
  category: "facebook",
  status: "verified",
  enabled: true,
  summaryAr: "جمع التعليقات العامة على منشورات فيسبوك",
  billingUnit: "page",
  catalogPriceUsd: 0.0019,
  pointsPerUnit: 11,
  pagination: { type: "cursor", maxLimit: 50 },
  observedSuccessRate: 0.9,
  method: "GET",
  paramsSchema: JSON.stringify({
    type: "object",
    properties: { postUrl: { type: "string" }, maxPages: { type: "integer" } },
    required: ["postUrl"],
  }),
};

function makeMockTables() {
  const store = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  table("capability_registry").set(FB_SEARCH_ENDPOINT.slug, { $id: FB_SEARCH_ENDPOINT.slug, ...FB_SEARCH_ENDPOINT });
  table("capability_registry").set(FB_COMMENTS_ENDPOINT.slug, { $id: FB_COMMENTS_ENDPOINT.slug, ...FB_COMMENTS_ENDPOINT });
  const parseEqual = (q: string): [string, string[]] | null => {
    const m = /^equal\("([^"]+)",\s*(\[.*\]|".*")\)$/.exec(q.trim());
    if (!m) return null;
    try {
      const parsed = JSON.parse(m[2]);
      const vals = Array.isArray(parsed) ? parsed : [parsed];
      return [m[1], vals.map(String)];
    } catch {
      return null;
    }
  };
  const parseLimit = (q: string): number | null => {
    const m = /^limit\((\d+)\)$/.exec(q.trim());
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    async createRow({ tableId, rowId, data }: any) {
      const id = rowId || `row_${Math.random().toString(36).slice(2)}`;
      const doc = { $id: id, ...data };
      table(tableId).set(id, doc);
      return doc;
    },
    async getRow({ tableId, rowId }: any) {
      const doc = table(tableId).get(rowId);
      if (!doc) throw new Error("row not found");
      return doc;
    },
    async listRows({ tableId, queries = [] }: any) {
      let rows = [...table(tableId).values()];
      let limit: number | null = null;
      for (const q of queries) {
        const eq = typeof q === "string" ? parseEqual(q) : null;
        if (eq) {
          const [attr, vals] = eq;
          rows = rows.filter((r) => vals.includes(String(r[attr])));
          continue;
        }
        const lim = typeof q === "string" ? parseLimit(q) : null;
        if (lim !== null) limit = lim;
      }
      if (limit !== null) rows = rows.slice(0, limit);
      return { total: rows.length, rows };
    },
    async updateRow({ tableId, rowId, data }: any) {
      const prev = table(tableId).get(rowId);
      if (!prev) throw new Error("row not found");
      const doc = { ...prev, ...data };
      table(tableId).set(rowId, doc);
      return doc;
    },
    __store: store,
  };
}

describe("fix/claude-decides: Claude decides, keyword inference & question pruning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBriefCacheForTesting();
    mockedSearchCatalog.mockResolvedValue([FB_SEARCH_ENDPOINT, FB_COMMENTS_ENDPOINT]);
    mockedGetCachedCatalogEndpoints.mockReturnValue([FB_SEARCH_ENDPOINT, FB_COMMENTS_ENDPOINT]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a) complete Arabic wedding message produces plan immediately with 0 questions, inferred keywords & volume calc", async () => {
    const tables = makeMockTables();
    await tables.createRow({
      tableId: "capability_registry",
      rowId: "facebook-hashtag-search",
      data: { ...FB_SEARCH_ENDPOINT, status: "verified", enabled: true },
    });
    await tables.createRow({
      tableId: "capability_registry",
      rowId: "facebook-post-comments",
      data: { ...FB_COMMENTS_ENDPOINT, status: "verified", enabled: true },
    });
    const weddingMessage =
      "أريد خطة لجمع المنشورات العامة والتعليقات على فيسبوك حول قائمة المنقولات وتكاليف الزواج في مصر خلال الفترة من 1 يناير 2026 إلى 30 سبتمبر 2026 بحد أقصى 10 منشورات و50 تعليقاً لكل منشور.";

    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "user_wedding_1",
      message: weddingMessage,
      userBalance: 500,
    });

    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote).toBeDefined();
    expect(res.planQuote!.quotedPoints).toBeGreaterThan(0);
    expect(res.clarificationItems).toBeUndefined();
    expect(res.clarificationQuestions).toBeUndefined();

    // No internal sentences or unneeded intro
    expect(res.contentAr).not.toContain("أحتاج أعدّل الخطة، لحظة");
    expect(res.contentAr).not.toContain("عشان أجهز لك خطة دقيقة، محتاج أعرف:");

    // Brief extraction checks
    const brief = await getConversationBrief(tables as any, res.conversationId);
    expect(brief.platforms).toContain("facebook");
    expect(brief.postCount).toBe(10);
    expect(brief.commentsPerPost).toBe(50);
    expect(brief.targetVolume).toBe(500); // 10 * 50
    expect(brief.keywords).toBeDefined();
    expect(brief.keywords!.length).toBeGreaterThanOrEqual(3);
    expect(
      brief.keywords!.some((k) => k.includes("قائمة المنقولات") || k.includes("المهر") || k.includes("الشبكة")),
    ).toBe(true);
  });

  it("(b) vague platform message ('عايز بيانات فيسبوك') asks at most 1 question (the topic), NEVER the platform", async () => {
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "user_vague_1",
      message: "عايز بيانات فيسبوك",
      userBalance: 500,
    });

    expect(res.outputType).toBe("ask_clarification");
    expect(res.clarificationItems).toBeDefined();
    expect(res.clarificationItems!.length).toBeLessThanOrEqual(1);

    // It must NOT ask for platform because facebook was identified
    const questionText = res.clarificationItems![0]?.text || "";
    expect(questionText).not.toContain("ما المنصة");
    expect(res.clarificationItems![0]?.id).not.toBe("code_platform");

    // Brief should contain platform
    const brief = await getConversationBrief(tables as any, res.conversationId);
    expect(brief.platforms).toContain("facebook");
  });

  it("(c) naming TikTok without topic asks at most 1 question (the topic), NEVER the platform", async () => {
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "user_tiktok_1",
      message: "عايز بيانات تيك توك",
      userBalance: 500,
    });

    expect(res.outputType).toBe("ask_clarification");
    expect(res.clarificationItems).toBeDefined();
    expect(res.clarificationItems!.length).toBeLessThanOrEqual(1);

    const questionText = res.clarificationItems![0]?.text || "";
    expect(questionText).not.toContain("ما المنصة");
    expect(res.clarificationItems![0]?.id).not.toBe("code_platform");

    const brief = await getConversationBrief(tables as any, res.conversationId);
    expect(brief.platforms).toContain("tiktok");
  });

  it("(d) submitting card answers updates brief and immediately triggers Phase 2 plan", async () => {
    const tables = makeMockTables();
    // Turn 1: vague request
    const turn1 = await new ChatHandler(tables as any).handleUserMessage({
      userId: "user_turn_flow",
      message: "عايز بيانات فيسبوك",
      userBalance: 500,
    });

    expect(turn1.outputType).toBe("ask_clarification");

    // Turn 2: answers submitted via card
    const turn2 = await new ChatHandler(tables as any).handleUserMessage({
      userId: "user_turn_flow",
      conversationId: turn1.conversationId,
      message: "أسعار الذهب والفضة في السوق المصري",
      answers: {
        code_topic: "أسعار الذهب والفضة في مصر",
      },
      userBalance: 500,
    });

    expect(turn2.outputType).toBe("propose_plan");
    expect(turn2.planQuote).toBeDefined();
    expect(turn2.clarificationItems).toBeUndefined();

    const brief = await getConversationBrief(tables as any, turn1.conversationId);
    expect(brief.platforms).toContain("facebook");
    expect(brief.topics.some((t) => t.includes("الذهب") || t.includes("أسعار"))).toBe(true);
  });

  it("(e) step timings are logged and returned in turnStats", async () => {
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "user_timing_test",
      message:
        "أريد خطة لجمع المنشورات العامة والتعليقات على فيسبوك حول قائمة المنقولات وتكاليف الزواج في مصر خلال الفترة من 1 يناير 2026 إلى 30 سبتمبر 2026 بحد أقصى 10 منشورات و50 تعليقاً لكل منشور.",
      userBalance: 500,
    });

    expect(res.turnStats).toBeDefined();
    expect(res.turnStats?.stepTimings).toBeDefined();
    expect(typeof res.turnStats?.stepTimings?.tExtractMs).toBe("number");
    expect(typeof res.turnStats?.stepTimings?.tCatalogSearchMs).toBe("number");
    expect(typeof res.turnStats?.stepTimings?.tPlanLlmMs).toBe("number");
    expect(typeof res.turnStats?.stepTimings?.tQuoteMs).toBe("number");
    expect(res.turnStats?.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
