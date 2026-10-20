import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock catalogClient before chatHandler loads it
vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { searchCatalog } from "../src/functions/shared/catalogClient";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";

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

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PlanQuoteCard from "../src/app/dashboard/chat/components/PlanQuoteCard";

/**
 * Live QA of 72d0a07: a count the plan chose, not the customer, read «طلبت ٥٠٠ سجل» on the plan card. This is the Facebook path of that
 * rule (the price was asked before a count; the catalog's generic plan proposes a small sample): the plan card now says the count is a
 * default and can be edited, in the plan's own word, never «طلبت».
 */
describe("Facebook: a count left open is a labelled default on the plan card", () => {
  beforeEach(() => { vi.clearAllMocks(); clearBriefCacheForTesting(); mockedSearchCatalog.mockResolvedValue([FB_ENDPOINT]); });
  afterEach(() => { vi.restoreAllMocks(); clearBriefCacheForTesting(); });
  const card = (quote: any) => renderToStaticMarkup(createElement(PlanQuoteCard, { quote, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {} } as any));

  it("«هيكلفني كام جمع بيانات من فيسبوك عن الدهب؟»: the plan carries the default and the card says it", async () => {
    const handler = new ChatHandler(makeMockTables() as any);
    const res = await handler.handleUserMessage({ userId: "user_test", message: "هيكلفني كام جمع بيانات من فيسبوك عن الدهب؟", userBalance: 5000 });
    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote.defaultCap).toEqual({ noun: "comments", units: 10, wordAr: "تعليق" });
    const html = card(res.planQuote);
    expect(html).toContain('data-testid="plan-default-volume"');
    expect(html).toContain("العدد المطلوب: ١٠ تعليق (قيمة افتراضية لأنك لم تحدد عددًا)، وتقدر تعدّله من الخطة.");
    expect(html).not.toContain("طلبت ١٠");
    expect(res.contentAr).toContain("لم تحدد عددًا، فاقترحت عينة من ١٠ تعليق");
  });

  it("a count the customer wrote is not a default", async () => {
    const handler = new ChatHandler(makeMockTables() as any);
    const res = await handler.handleUserMessage({ userId: "user_test", message: "عايز أسحب 30 comment من على الـ Facebook آخر شهر ده، بيتكلموا عن الدهب", userBalance: 5000 });
    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote.defaultCap).toBeUndefined();
    expect(card(res.planQuote)).not.toContain("قيمة افتراضية");
  });
});
