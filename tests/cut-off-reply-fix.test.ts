import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { searchCatalog } from "../src/functions/shared/catalogClient";
import {
  ChatHandler,
  buildCodeDiscoveryFallback,
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

describe("cut-off reply fix (Task 1: render text + tool blocks, colon retry & discovery card fallback)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSearchCatalog.mockResolvedValue([FB_ENDPOINT]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1. text + tool_use blocks in one turn both rendered: contentAr has text and clarificationItems has questions", async () => {
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "user_test_1",
      message: "عايز أسحب 3000 comment من على الـ Facebook آخر شهر ده، بيتكلموا عن الدهب وأسعار الدهب",
      userBalance: 500,
      testScenario: "text_plus_tool_turn",
    });

    expect(res.contentAr).toBe("عشان أجهز لك خطة دقيقة، محتاج أعرف:");
    expect(res.outputType).toBe("ask_clarification");
    expect(res.clarificationItems).toBeDefined();
    expect(res.clarificationItems!.length).toBeGreaterThan(0);
    expect(res.clarificationQuestions).toBeDefined();
    expect(res.clarificationQuestions!.length).toBeGreaterThan(0);
  });

  it("2. reply ending with colon: retries once, and if questions return on retry, both text and questions are preserved", async () => {
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "user_test_2",
      message: "عايز أسحب 3000 comment من على الـ Facebook آخر شهر ده، بيتكلموا عن الدهب وأسعار الدهب",
      userBalance: 500,
      testScenario: "colon_cutoff_then_questions",
    });

    expect(res.contentAr).toBe("عشان أجهز لك خطة دقيقة، محتاج أعرف:");
    expect(res.outputType).toBe("ask_clarification");
    expect(res.clarificationItems).toBeDefined();
    expect(res.clarificationItems!.length).toBeGreaterThan(0);
  });

  it("3. reply ending with colon: if retry still returns colon with no tool, builds discovery card in code with required parameters", async () => {
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "user_test_3",
      message: "عايز أسحب 3000 comment من على الـ Facebook آخر شهر ده، بيتكلموا عن الدهب وأسعار الدهب",
      userBalance: 500,
      testScenario: "colon_cutoff_always",
    });

    // Content ends with colon or retains intro
    expect(res.contentAr).toContain("عشان أجهز لك خطة دقيقة، محتاج أعرف:");
    // OutputType is ask_clarification so UI renders ClarificationReply
    expect(res.outputType).toBe("ask_clarification");
    expect(res.clarificationItems).toBeDefined();
    expect(res.clarificationItems!.length).toBeGreaterThan(0);

    const questionIds = res.clarificationItems!.map((q) => q.id);
    expect(questionIds).toContain("code_topic_angle");

    // Options are non-empty
    expect(res.clarificationItems![0].options.length).toBeGreaterThan(0);
  });

  it("4. buildCodeDiscoveryFallback with colonFallback generates 3 focused parameters (topic angle, number of posts, comments per post)", () => {
    const fallback = buildCodeDiscoveryFallback(
      [],
      "عايز أسحب 3000 comment من على الـ Facebook آخر شهر ده، بيتكلموا عن الدهب وأسعار الدهب",
      true,
    );

    expect(fallback.intro).toBe("عشان أجهز لك خطة دقيقة، محتاج أعرف:");
    expect(fallback.items.length).toBe(3);
    const ids = fallback.items.map((i) => i.id);
    expect(ids).toEqual(["code_topic_angle", "code_post_count", "code_comments_per_post"]);
  });
});
