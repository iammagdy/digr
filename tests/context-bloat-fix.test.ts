import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// search_catalog must be intercepted before chatHandler loads it.
vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { searchCatalog } from "../src/functions/shared/catalogClient";
import {
  ChatHandler,
  buildCompactCatalogSummary,
  buildCodeDiscoveryFallback,
  summarizeConversationHistory,
  estimateTokens,
  CONTEXT_TOKEN_LIMIT,
} from "../src/functions/shared/chatHandler";

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

const ARABIC_REQUEST = "هاتلي تعليقات فيسبوك عن البطالة في مصر آخر 3 شهور";
const GENERIC_FALLBACK = "أحتاج توضيحاً إضافياً لمتابعة طلبك بدقة.";

// Minimal in-memory TablesDB mock.
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
  const api = {
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
  return api;
}

describe("context-bloat fix (fix/context-bloat)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSearchCatalog.mockResolvedValue([FB_ENDPOINT]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a) after a search turn, stored history is small and has no raw catalog JSON", async () => {
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "test_user",
      message: ARABIC_REQUEST,
      userBalance: 300,
      testScenario: "search_then_plan",
    });
    expect(res.outputType).toBe("propose_plan");

    const msgs = await tables.listRows({ databaseId: "digr", tableId: "messages", queries: [] });
    const allContent = msgs.rows.map((r: any) => String(r.content || "")).join("\n");
    // No raw catalog data persisted: no endpoint ids, no JSON schema fragments,
    // no internal loop markers.
    expect(allContent).not.toContain("treg-");
    expect(allContent).not.toContain("pointsPerUnit");
    expect(allContent).not.toContain("paramsSchema");
    expect(allContent).not.toContain("نتائج بحث الكتالوج");
    // Stored history stays small (well under a few thousand tokens).
    expect(estimateTokens(allContent)).toBeLessThan(2000);
  });

  it("(b) stalling model after search yields real code-built questions, never the generic sentence", async () => {
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "test_user",
      message: ARABIC_REQUEST,
      userBalance: 300,
      testScenario: "search_then_stall",
    });
    expect(res.contentAr).not.toContain(GENERIC_FALLBACK);
    expect(res.clarificationItems).toBeDefined();
    expect(res.clarificationItems!.length).toBeGreaterThan(0);
    const texts = res.clarificationItems!.map((q: any) => q.text);
    expect(texts[0]).toContain("المنصة");
    expect(res.clarificationItems![0].options.length).toBeGreaterThan(0);
    expect(res.contentAr).not.toContain("نتائج البحث في الكتالوج المعتمد");
  });

  it("(b2) retry-once recovers: empty answer then explicit instruction leads to questions", async () => {
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "test_user",
      message: ARABIC_REQUEST,
      userBalance: 300,
      testScenario: "search_retry_then_questions",
    });
    expect(res.outputType).toBe("ask_clarification");
    expect(res.clarificationQuestions!.length).toBeGreaterThan(0);
    expect(res.contentAr).not.toContain(GENERIC_FALLBACK);
  });

  it("(c) follow-up 'طلبي واضح' produces a plan, never the limit message", async () => {
    const tables = makeMockTables();
    const handler = new ChatHandler(tables as any);
    const first = await handler.handleUserMessage({
      userId: "test_user",
      message: ARABIC_REQUEST,
      userBalance: 300,
      testScenario: "search_then_questions",
    });
    expect(first.clarificationQuestions!.length).toBeGreaterThan(0);

    const second = await handler.handleUserMessage({
      userId: "test_user",
      conversationId: first.conversationId,
      message: "طلبي واضح",
      userBalance: 300,
      testScenario: "direct_plan",
    });
    expect(second.outputType).toBe("propose_plan");
    expect(second.planQuote).toBeDefined();
    expect(second.contentAr).not.toContain("الحد الأقصى لسياق");
  });

  it("(d) long conversation is summarized, not blocked", async () => {
    const tables = makeMockTables();
    // Seed a bloated conversation: 12 prior messages + 50k accumulated tokens.
    const convId = "conv_bloated";
    await tables.createRow({
      databaseId: "digr",
      tableId: "conversations",
      rowId: convId,
      data: { userId: "test_user", title: "old", status: "active", totalTokens: 50000, costUsd: 0 },
    });
    for (let i = 0; i < 12; i++) {
      await tables.createRow({
        databaseId: "digr",
        tableId: "messages",
        data: {
          conversationId: convId,
          userId: "test_user",
          role: i % 2 === 0 ? "user" : "assistant",
          content: `رسالة قديمة رقم ${i} محتوى تجريبي لإطالة السياق `.repeat(20),
          status: "ready",
          createdAt: new Date(Date.now() - (12 - i) * 60000).toISOString(),
        },
      });
    }
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "test_user",
      conversationId: convId,
      message: "كمل بنفس الخطة",
      userBalance: 300,
      testScenario: "summary_then_plan",
    });
    // Not blocked: the model got a summarized context and produced a plan.
    expect(res.outputType).toBe("propose_plan");
    expect(res.contentAr).not.toContain("الحد الأقصى لسياق");
  });

  it("(e) measurement: token estimate of a conversation after one search turn", async () => {
    const tables = makeMockTables();
    await new ChatHandler(tables as any).handleUserMessage({
      userId: "test_user",
      message: ARABIC_REQUEST,
      userBalance: 300,
      testScenario: "search_then_plan",
    });
    const msgs = await tables.listRows({ databaseId: "digr", tableId: "messages", queries: [] });
    const allContent = msgs.rows.map((r: any) => String(r.content || "")).join("\n");
    const est = estimateTokens(allContent);
    // Document the measurement: a full search turn persists only a few hundred tokens.
    expect(est).toBeLessThan(1500);
  });

  it("(f) compact catalog summary is capped at ~2500 tokens", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...FB_ENDPOINT,
      slug: `endpoint-${i}`,
      nameAr: `أداة رقم ${i} `.repeat(10),
      paramsSchema: JSON.stringify({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
        required: ["a", "b"],
      }),
    }));
    const block = buildCompactCatalogSummary(many);
    expect(estimateTokens(block)).toBeLessThanOrEqual(2500);
    // Top-5 cap: at most 5 endpoint lines.
    expect(block.split("\n").filter((l) => /^\d+\. /.test(l)).length).toBeLessThanOrEqual(5);
    // Minimal fields only: no descriptions, no schemas.
    expect(block).not.toContain("summaryAr");
    expect(block).not.toContain("properties");
  });

  it("(g) code-built fallback always yields 3 real questions", () => {
    const fb = buildCodeDiscoveryFallback([]);
    expect(fb.items.length).toBe(3);
    expect(fb.intro).not.toContain(GENERIC_FALLBACK);
    expect(fb.items[0].options.length).toBeGreaterThan(0);
  });

  it("(h) summarizeConversationHistory keeps first + recent + plan state", () => {
    const msgs = Array.from({ length: 14 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
    }));
    const out = summarizeConversationHistory(msgs, "خطة فيسبوك — 220 نقطة");
    expect(out.length).toBeLessThan(msgs.length);
    expect(out[0].content).toBe("message 0");
    expect(out[1].role).toBe("system");
    expect(out[1].content).toContain("ملخص المحادثة");
    expect(out[1].content).toContain("الخطة الحالية");
    expect(out[out.length - 1].content).toBe("message 13");
    expect(CONTEXT_TOKEN_LIMIT).toBe(40000);
  });
});
