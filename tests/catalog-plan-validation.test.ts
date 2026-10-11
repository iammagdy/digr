import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// search_catalog must be intercepted before chatHandler loads it.
vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { searchCatalog } from "../src/functions/shared/catalogClient";
import {
  ChatHandler,
  buildClarificationPresentation,
  discoveryQuestionPriority,
} from "../src/functions/shared/chatHandler";
import { checkUserRateLimits } from "../src/functions/shared/rateLimits";

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

// Minimal in-memory TablesDB mock.
function makeMockTables() {
  const store = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  const parseQuery = (q: any): { method: string; attribute?: string; values?: any[] } | null => {
    if (typeof q !== "string") return null;
    try {
      const o = JSON.parse(q);
      if (o && typeof o.method === "string") return o;
    } catch {
      /* not JSON */
    }
    return null;
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
      let offset = 0;
      for (const q of queries) {
        const pq = parseQuery(q);
        if (!pq) continue;
        const vals = (pq.values || []).map(String);
        if (pq.method === "equal" && pq.attribute) {
          rows = rows.filter((r) => vals.includes(String(r[pq.attribute as string])));
        } else if (pq.method === "greaterThanEqual" && pq.attribute) {
          rows = rows.filter((r) => String(r[pq.attribute as string] || "") >= vals[0]);
        } else if (pq.method === "limit") {
          limit = parseInt(vals[0], 10);
        } else if (pq.method === "offset") {
          offset = parseInt(vals[0], 10) || 0;
        } else if (pq.method === "orderDesc" && pq.attribute) {
          const a = pq.attribute;
          rows = [...rows].sort((x, y) => String(y[a] || "").localeCompare(String(x[a] || "")));
        } else if (pq.method === "orderAsc" && pq.attribute) {
          const a = pq.attribute;
          rows = [...rows].sort((x, y) => String(x[a] || "").localeCompare(String(y[a] || "")));
        }
      }
      const total = rows.length;
      if (offset) rows = rows.slice(offset);
      if (limit !== null) rows = rows.slice(0, limit);
      return { total, rows };
    },
    async updateRow({ tableId, rowId, data }: any) {
      const prev = table(tableId).get(rowId);
      if (!prev) throw new Error("row not found");
      const doc = { ...prev, ...data };
      table(tableId).set(rowId, doc);
      return doc;
    },
  };
}

describe("catalog plan validation + rate limit + question order (fix/catalog-plan-validation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSearchCatalog.mockResolvedValue([FB_ENDPOINT]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a) plan with live-catalog Facebook endpoints is accepted and priced", async () => {
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "test_user",
      message: ARABIC_REQUEST,
      userBalance: 300,
      testScenario: "search_then_plan",
    });
    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote).toBeDefined();
    expect(res.planQuote.quotedPoints).toBeGreaterThan(0);
    expect(res.contentAr).toContain("خطة");
    expect(res.contentAr).not.toContain("يرجى تدقيق المدخلات");
    expect(res.contentAr).not.toContain("غير متوفرة");
  });

  it("(b) unknown endpoint rejected with Arabic message containing no slug", async () => {
    mockedSearchCatalog.mockResolvedValue([]);
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "test_user",
      message: ARABIC_REQUEST,
      userBalance: 300,
      testScenario: "plan_ghost_then_stall",
    });
    expect(res.contentAr).toContain("أحتاج أعدّل الخطة، لحظة");
    expect(res.contentAr).not.toContain("facebook-ghost-endpoint");
    expect(res.contentAr).not.toContain("يرجى تدقيق المدخلات");
    expect(res.clarificationItems).toBeDefined();
    expect(res.clarificationItems!.length).toBe(3);
  });

  it("(c) one user message with 4 internal model calls consumes exactly 1 rate-limit unit", async () => {
    const tables = makeMockTables();
    const today = new Date().toISOString();
    // 4 internal model calls recorded as llm_usage rows (old logic counted these).
    for (let i = 0; i < 4; i++) {
      await tables.createRow({
        databaseId: "digr",
        tableId: "llm_usage",
        data: { userId: "u1", conversationId: "c1", model: "m", inputTokens: 5000, outputTokens: 100, costUsd: 0.01, createdAt: today },
      });
    }
    // Only 1 actual user message.
    await tables.createRow({
      databaseId: "digr",
      tableId: "messages",
      data: { userId: "u1", conversationId: "c1", role: "user", content: "hello", createdAt: today },
    });
    const ok = await checkUserRateLimits(tables as any, "u1");
    expect(ok.allowed).toBe(true);

    // 199 more user messages (2h ago, so the per-minute check stays green)
    // -> 200 total -> daily limit reached.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 199; i++) {
      await tables.createRow({
        databaseId: "digr",
        tableId: "messages",
        data: { userId: "u1", conversationId: "c1", role: "user", content: `msg ${i}`, createdAt: twoHoursAgo },
      });
    }
    const blocked = await checkUserRateLimits(tables as any, "u1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.reasonAr).toContain("200 رسالة");
  });

  it("(d) discovery questions ordered: topic, posts, comments per post, date", () => {
    const out = buildClarificationPresentation(
      {
        type: "ask_clarification",
        reasonAr: "test",
        questions: [
          { question: "كم تعليقاً تحتاج لكل منشور؟" },
          { question: "ما الفترة الزمنية المستهدفة؟" },
          { question: "ما الموضوع المطلوب البحث عنه؟" },
          { question: "كم عدد المنشورات المطلوب جمعها؟" },
        ],
      } as any,
      { capabilities: [], userBalancePoints: 300, userMessage: ARABIC_REQUEST },
    );
    const texts = out.clarificationItems.map((q) => q.text);
    // Max 3 per card; comments-per-post never before number of posts.
    expect(texts.length).toBeLessThanOrEqual(3);
    expect(texts[0]).toContain("الموضوع");
    expect(texts[1]).toContain("المنشورات");
    expect(texts[2]).toContain("تعليق");
    // Topic question is open with suggestion chips from the user's request.
    expect(out.clarificationItems[0].options.length).toBeGreaterThan(0);
    expect(out.clarificationItems[0].options.join(" ")).toContain("البطالة");
  });

  it("(d2) date question defaults to the date in the user's request", () => {
    const out = buildClarificationPresentation(
      {
        type: "ask_clarification",
        reasonAr: "test",
        questions: [
          { question: "كم تعليقاً تحتاج لكل منشور؟" },
          { question: "ما الفترة الزمنية المستهدفة؟" },
          { question: "ما الموضوع المطلوب البحث عنه؟" },
        ],
      } as any,
      { capabilities: [], userBalancePoints: 300, userMessage: ARABIC_REQUEST },
    );
    const dateQ = out.clarificationItems.find((q) => discoveryQuestionPriority(q) === 4);
    expect(dateQ).toBeDefined();
    expect(dateQ!.defaultOption).toBe("آخر ٣ شهور");
    expect(dateQ!.options).toContain("آخر ٣ شهور");
  });

  it("(e) the Arabic Facebook request ends in a plan or discovery card, never a validation error", async () => {
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "test_user",
      message: ARABIC_REQUEST,
      userBalance: 300,
      testScenario: "search_then_plan",
    });
    expect(["propose_plan", "ask_clarification"]).toContain(res.outputType);
    expect(res.contentAr).not.toContain("يرجى تدقيق المدخلات");
    expect(res.contentAr).not.toContain("غير متوفرة أو معطلة في الكتالوج");
  });
});
