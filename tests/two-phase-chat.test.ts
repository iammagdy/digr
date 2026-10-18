import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock catalogClient before chatHandler loads it
vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { searchCatalog } from "../src/functions/shared/catalogClient";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting, getConversationBrief } from "../src/functions/shared/briefManager";

const mockedSearchCatalog = vi.mocked(searchCatalog);

const FB_ENDPOINT: any = {
  slug: "facebook-post-comments",
  id: "treg-facebook-post-comments-v1",
  nameAr: "استخراج تعليقات منشورات فيسبوك العامة",
  nameEn: "Facebook Post Comments",
  platform: "facebook",
  summaryAr: "جمع التعليقات العامة على منشورات فيسبوك",
  billingUnit: "page",
  catalogPriceUsd: 0.0019,
  pointsPerUnit: 11,
  pagination: { type: "cursor", maxLimit: 50 },
  observedSuccessRate: 0.9,
  method: "GET",
  paramsSchema: {
    type: "object",
    properties: { postUrl: { type: "string" }, maxPages: { type: "integer" } },
    required: ["postUrl"],
  },
};

function makeMockTables() {
  const store = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
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

describe("Task 2: Two-Phase Speed Chat (Owner's Design)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBriefCacheForTesting();
    mockedSearchCatalog.mockResolvedValue([FB_ENDPOINT]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearBriefCacheForTesting();
  });

  describe("Phase 1: Greetings & Casual Questions (Zero Catalog Search, 1 Model Call)", () => {
    it("(a) greeting 'هاي' gets plain natural reply with 0 catalog searches and no tool calls", async () => {
      const tables = makeMockTables();
      const handler = new ChatHandler(tables as any);

      const res = await handler.handleUserMessage({
        userId: "user_test",
        message: "هاي",
        userBalance: 500,
      });

      expect(mockedSearchCatalog).toHaveBeenCalledTimes(0);
      expect(res.outputType).toBe("answer_question");
      expect(res.contentAr).toContain("أهلًا بك");
      // Owner decision D2: the real name is required; with no profile name Diger AI asks once.
      expect(res.contentAr).toContain("ما الاسم الذي تفضّل أن أناديك به");
      expect(res.planQuote).toBeUndefined();
      expect(res.clarificationQuestions).toBeUndefined();
    });

    it("(b) greeting 'ازيك' gets plain natural reply with 0 catalog searches", async () => {
      const tables = makeMockTables();
      const handler = new ChatHandler(tables as any);

      const res = await handler.handleUserMessage({
        userId: "user_test",
        message: "ازيك",
        userBalance: 500,
      });

      expect(mockedSearchCatalog).toHaveBeenCalledTimes(0);
      expect(res.outputType).toBe("answer_question");
      expect(res.contentAr).toContain("أهلًا بك");
      // Owner decision D2: the real name is required; with no profile name Diger AI asks once.
      expect(res.contentAr).toContain("ما الاسم الذي تفضّل أن أناديك به");
      expect(res.planQuote).toBeUndefined();
    });

    it("greeting uses the real profile name and never a hardcoded one (owner decision D2)", async () => {
      const tables = makeMockTables();
      const handler = new ChatHandler(tables as any);

      const res = await handler.handleUserMessage({
        userId: "user_named",
        message: "هاي",
        userBalance: 500,
        personaProfile: { name: "سلمى" },
      });

      expect(mockedSearchCatalog).toHaveBeenCalledTimes(0);
      expect(res.outputType).toBe("answer_question");
      expect(res.contentAr).toContain("أهلًا سلمى");
      expect(res.contentAr).not.toContain("مجدي");
      expect(res.contentAr).not.toContain("ما الاسم");
    });

    it("(c) casual identity question 'انت بتعمل ايه؟' gets plain natural reply with 0 catalog searches", async () => {
      const tables = makeMockTables();
      const handler = new ChatHandler(tables as any);

      const res = await handler.handleUserMessage({
        userId: "user_test",
        message: "انت بتعمل ايه؟",
        userBalance: 500,
      });

      expect(mockedSearchCatalog).toHaveBeenCalledTimes(0);
      expect(res.outputType).toBe("answer_question");
      expect(res.contentAr).toContain("مساعد Diger");
      expect(res.planQuote).toBeUndefined();
    });
  });

  describe("Phase 1: Understanding & Brief Accumulation (Zero Catalog Search, 1 Model Call)", () => {
    it("(d) partial request without volume triggers Phase 1 understanding with 0 catalog searches and persists brief", async () => {
      const tables = makeMockTables();
      const handler = new ChatHandler(tables as any);

      const res = await handler.handleUserMessage({
        userId: "user_test",
        message: "عايز بيانات من فيسبوك عن الدهب وأسعار الدهب",
        userBalance: 500,
      });

      // Phase 1 has NO catalog searches
      expect(mockedSearchCatalog).toHaveBeenCalledTimes(0);
      expect(res.planQuote).toBeUndefined();
      expect(["ask_clarification", "update_brief"]).toContain(res.outputType);

      // Verify persistent brief was saved
      const brief = await getConversationBrief(tables as any, res.conversationId);
      expect(brief.platforms).toContain("facebook");
      expect(brief.topics.length).toBeGreaterThan(0);
      expect(brief.targetVolume).toBeUndefined();
    });
  });

  describe("Phase 2: Deterministic Pricing & Plan", () => {
    it("(e) complete request triggers Phase 2, shows progress line, searches catalog once per platform, and returns quote", async () => {
      const tables = makeMockTables();
      const handler = new ChatHandler(tables as any);

      const liveMessage =
        "عايز أسحب 3000 comment من على الـ Facebook آخر شهر ده، بيتكلموا عن الدهب وأسعار الدهب";

      const updateSpy = vi.spyOn(tables, "updateRow");

      const res = await handler.handleUserMessage({
        userId: "user_test",
        message: liveMessage,
        userBalance: 500,
      });

      // Server-side: searched catalog ONCE for Facebook
      expect(mockedSearchCatalog).toHaveBeenCalledTimes(1);
      expect(mockedSearchCatalog).toHaveBeenCalledWith(expect.stringContaining("الدهب"), "facebook");

      // Verify plan quote was created
      expect(res.outputType).toBe("propose_plan");
      expect(res.planQuote).toBeDefined();
      expect(res.planQuote.quotedPoints).toBeGreaterThan(0);

      // Verify progress line 'أبحث وأحسب السعر...' was sent to DB during Phase 2
      const thinkingUpdate = updateSpy.mock.calls.find(
        (call: any) => call[0]?.data?.content === "أبحث وأحسب السعر...",
      );
      expect(thinkingUpdate).toBeDefined();
    });

    it("(f) user asks for price with partial brief ('هيكلفني كام') applies the small safe default volume (10, shown and editable on the plan card) and triggers Phase 2", async () => {
      const tables = makeMockTables();
      const handler = new ChatHandler(tables as any);

      const res = await handler.handleUserMessage({
        userId: "user_test",
        message: "هيكلفني كام جمع بيانات من فيسبوك عن الدهب؟",
        userBalance: 500,
      });

      // Catalog search runs once for Facebook
      expect(mockedSearchCatalog).toHaveBeenCalledTimes(1);
      expect(res.outputType).toBe("propose_plan");
      expect(res.planQuote).toBeDefined();

      const brief = await getConversationBrief(tables as any, res.conversationId);
      // A silent 500-record default would put an unrequested multi-hundred point quote in front of
      // the customer; the code default is a 10-record sample that the plan card lets them edit.
      expect(brief.targetVolume).toBe(10);
    });

    it("(g) user asks for price with completely empty brief stays in Phase 1 with 0 catalog searches", async () => {
      const tables = makeMockTables();
      const handler = new ChatHandler(tables as any);

      const res = await handler.handleUserMessage({
        userId: "user_test",
        message: "هيكلفني كام؟",
        userBalance: 500,
      });

      // No platform or topic known -> Cannot search catalog -> Phase 1
      expect(mockedSearchCatalog).toHaveBeenCalledTimes(0);
      expect(res.planQuote).toBeUndefined();
    });

    it("(h) multi-turn journey: Phase 1 accumulates brief, then follow-up with volume triggers Phase 2", async () => {
      const tables = makeMockTables();
      const handler = new ChatHandler(tables as any);

      // Turn 1: user mentions platform and topic only
      const res1 = await handler.handleUserMessage({
        userId: "user_test",
        message: "عايز أجمع تعليقات من فيسبوك عن العقارات",
        userBalance: 500,
      });

      expect(mockedSearchCatalog).toHaveBeenCalledTimes(0);
      expect(res1.planQuote).toBeUndefined();

      // Turn 2: user provides target volume in the same conversation
      const res2 = await handler.handleUserMessage({
        userId: "user_test",
        conversationId: res1.conversationId,
        message: "سحب 2000 تعليق لآخر شهر",
        userBalance: 500,
      });

      // Turn 2 brief is complete -> Phase 2 triggered!
      expect(mockedSearchCatalog).toHaveBeenCalledTimes(1);
      expect(res2.outputType).toBe("propose_plan");
      expect(res2.planQuote).toBeDefined();

      const brief = await getConversationBrief(tables as any, res1.conversationId);
      expect(brief.platforms).toContain("facebook");
      expect(brief.targetVolume).toBe(2000);
    });

    it("(i) answering clarification card with structured answers immediately transitions to propose_plan with quote and never stalls", async () => {
      const tables = makeMockTables();
      const handler = new ChatHandler(tables as any);

      // Turn 1: user mentions platform and topic only
      const res1 = await handler.handleUserMessage({
        userId: "user_test",
        message: "عايز أجمع تعليقات من فيسبوك عن العقارات",
        userBalance: 500,
      });

      expect(mockedSearchCatalog).toHaveBeenCalledTimes(0);
      expect(res1.planQuote).toBeUndefined();

      // Turn 2: user answers clarification card via answers array (e.g. sample size > 500)
      const res2 = await handler.handleUserMessage({
        userId: "user_test",
        conversationId: res1.conversationId,
        message: "تم اختيار الخيارات المناسبة",
        answers: [
          {
            questionId: "code_volume",
            question: "ما حجم البيانات المطلوب جمعها؟",
            value: "أكثر من 500 سجل",
          },
        ],
        userBalance: 500,
      });

      // Assert: transitions directly to propose_plan, creates and returns quote, does not stall!
      expect(res2.outputType).toBe("propose_plan");
      expect(res2.planQuote).toBeDefined();
      expect(res2.planQuote.quotedPoints).toBeGreaterThan(0);
      expect(res2.planQuote.quoteId).toBeDefined();

      const brief = await getConversationBrief(tables as any, res1.conversationId);
      expect(brief.platforms).toContain("facebook");
      expect(brief.targetVolume).toBeGreaterThanOrEqual(500);
    });

    it("(j) submitting clarification answers with sample_size questionId updates targetVolume and generates quote", async () => {
      const tables = makeMockTables();
      const handler = new ChatHandler(tables as any);

      // Turn 1: user mentions platform and topic
      const res1 = await handler.handleUserMessage({
        userId: "user_test",
        message: "بحث عن منشورات فيسبوك عن الاستثمار",
        userBalance: 500,
      });

      // Turn 2: user submits clarification answers with sample_size
      const res2 = await handler.handleUserMessage({
        userId: "user_test",
        conversationId: res1.conversationId,
        message: "تم تحديد العينة",
        answers: [
          {
            questionId: "sample_size",
            question: "حجم العينة المطلوب",
            value: "1000",
          },
        ],
        userBalance: 500,
      });

      expect(res2.outputType).toBe("propose_plan");
      expect(res2.planQuote).toBeDefined();
      expect(res2.planQuote.quotedPoints).toBeGreaterThan(0);

      const brief = await getConversationBrief(tables as any, res1.conversationId);
      expect(brief.targetVolume).toBe(1000);
    });
  });
});
