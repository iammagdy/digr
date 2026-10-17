import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { ChatHandler, getDeterministicDiscoveryQuestion } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { extractNumberFromText } from "../src/lib/arabicNumbers";

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

const brief: any = { platforms: [], topics: [] };

describe("Arabic number words are read as the count and never asked again", () => {
  const cases: Array<[string, number]> = [
    ["عايز خمس شركات في مجال الكهرباء", 5],
    ["عايز عشرة شركات", 10],
    ["عايز عشرين شركة", 20],
    ["مية شركة", 100],
    ["ميتين شركة", 200],
    ["ألف سجل", 1000],
    ["عايز خمسة وعشرين شركة", 25],
    ["مئة وخمسين شركة", 150],
    ["ألف وخمسمية سجل", 1500],
    ["عايز واحد وخمسين شركة", 51],
    ["ten IT companies", 10],
    ["٥ شركات", 5],
  ];

  it.each(cases)("%s -> %i", (text, expected) => {
    expect(extractNumberFromText(text)).toBe(expected);
  });

  it("a year is not a count", () => {
    expect(extractNumberFromText("اجمع تعليقات فيسبوك في سنة 2024")).toBeUndefined();
    expect(extractNumberFromText("في سنة 2024 تعليقات")).toBeUndefined();
  });

  it.each([
    "عايز خمس شركات في مجال الكهرباء في مصر",
    "عايز عشرين شركة مقاولات في السعودية",
    "عايز ميتين شركة تقنية معلومات في الإمارات",
    "عايز ألف شركة أغذية في ألمانيا",
  ])("the discovery gate never asks for the count when the request already states it: %s", (text) => {
    const question = getDeterministicDiscoveryQuestion(text, brief);
    expect(question?.id).not.toBe("company_count_required");
  });

  it("a request without a country asks for the country only, not the count", () => {
    expect(getDeterministicDiscoveryQuestion("عايز خمس شركات في مجال الكهرباء", brief)?.id).toBe("company_country_required");
  });

  it("a request that really omits the count asks for it", () => {
    expect(getDeterministicDiscoveryQuestion("عايز شركات مقاولات في مصر", brief)?.id).toBe("company_count_required");
  });
});

describe("the stated count survives to the quote (never replaced by a default)", () => {
  beforeEach(() => clearBriefCacheForTesting());

  it.each([[5, "عايز خمس شركات مقاولات في مصر"], [20, "عايز عشرين شركة مقاولات في السعودية"]])(
    "plan for %i companies shows that volume",
    async (expected, message) => {
      const tables = makeMockTables();
      const res = await new ChatHandler(tables as any).handleUserMessage({ userId: "user_count", message, userBalance: 5000 });
      expect(res.outputType).toBe("propose_plan");
      expect(res.clarificationItems).toBeUndefined();
      expect(res.planQuote.targetVolumeMax).toBe(expected);
      expect(res.planQuote.items[0].targetVolumeMax).toBe(expected);
    },
  );

  it("country asked first, then the plan keeps the number written in words", async () => {
    const tables = makeMockTables();
    const handler = new ChatHandler(tables as any);
    const first = await handler.handleUserMessage({ userId: "user_count2", message: "عايز خمس شركات في مجال الكهرباء", userBalance: 5000 });
    expect(first.outputType).toBe("ask_clarification");
    expect(first.clarificationItems?.[0]?.id).toBe("company_country_required");

    const second = await handler.handleUserMessage({
      userId: "user_count2",
      conversationId: first.conversationId,
      message: "مصر",
      answers: { company_country_required: "مصر" },
      userBalance: 5000,
    });
    expect(second.clarificationItems?.[0]?.id).not.toBe("company_count_required");
    expect(second.outputType).toBe("propose_plan");
    expect(second.planQuote.targetVolumeMax).toBe(5);
  });
});
