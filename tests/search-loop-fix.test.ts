import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// search_catalog must be intercepted before chatHandler loads it.
vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(),
}));

import { searchCatalog } from "../src/functions/shared/catalogClient";
import { ChatHandler } from "../src/functions/shared/chatHandler";

const mockedSearchCatalog = vi.mocked(searchCatalog);

const FB_ENDPOINT = {
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

// Minimal in-memory TablesDB mock: createRow/getRow/listRows/updateRow.
function makeMockTables() {
  const store = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  const parseEqual = (q: string): [string, string[]] | null => {
    const m = /^equal\("([^"]+)",\s*(\[.*\]|".*")\)$/.exec(q.trim());
    if (!m) return null;
    let vals: string[];
    try {
      const parsed = JSON.parse(m[2]);
      vals = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return null;
    }
    return [m[1], vals.map(String)];
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
  };
}

describe("search_catalog internal loop (fix/search-to-plan)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSearchCatalog.mockResolvedValue([FB_ENDPOINT] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const run = (testScenario: string) =>
    new ChatHandler(makeMockTables() as any).handleUserMessage({
      userId: "test_user",
      message: ARABIC_REQUEST,
      userBalance: 300,
      testScenario,
    });

  it("(a) search then propose_plan yields a priced plan, never a raw list", async () => {
    const res = await run("search_then_plan");
    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote).toBeDefined();
    expect(res.planQuote.quotedPoints).toBeGreaterThan(0);
    expect(res.contentAr).toContain("خطة");
    expect(res.contentAr).not.toContain("نتائج البحث في الكتالوج المعتمد");
  });

  it("(b) search then ask_questions yields discovery questions", async () => {
    const res = await run("search_then_questions");
    expect(res.outputType).toBe("ask_clarification");
    expect(res.clarificationQuestions).toBeDefined();
    expect(res.clarificationQuestions!.length).toBeGreaterThan(0);
    expect(res.contentAr).not.toContain("نتائج البحث في الكتالوج المعتمد");
  });

  it("(c) search then empty text falls back to a discovery question", async () => {
    const res = await run("search_then_empty");
    expect(res.clarificationQuestions).toBeDefined();
    expect(res.clarificationQuestions!.length).toBeGreaterThan(0);
    expect(res.contentAr).not.toContain("نتائج البحث في الكتالوج المعتمد");
  });

  it("(d) max iterations respected: 4 loop turns then discovery fallback", async () => {
    const res = await run("search_forever");
    // 1 pre-search before the LLM turn + 4 internal loop iterations
    expect(mockedSearchCatalog).toHaveBeenCalledTimes(5);
    expect(res.clarificationQuestions).toBeDefined();
    expect(res.clarificationQuestions!.length).toBeGreaterThan(0);
    expect(res.contentAr).not.toContain("نتائج البحث في الكتالوج المعتمد");
  });

  it("(e) the Arabic Facebook request never returns the raw results list", async () => {
    const res = await run("search_then_text");
    expect(res.outputType).toBe("answer_question");
    expect(res.contentAr).toContain("وجدت أدوات مناسبة في الكتالوج لطلبك.");
    expect(res.contentAr).not.toContain("نتائج البحث في الكتالوج المعتمد");
    expect(res.contentAr).not.toMatch(/• .* \(\d+ نقطة\)/);
  });
});
