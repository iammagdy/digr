import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { ChatHandler, getDeterministicDiscoveryQuestion } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { CONTACT_BILLING_NOTE_AR, CONTACT_EXPECTATION_AR } from "../src/lib/contactExpectation";
import { PEOPLE_ROLE_PATTERN } from "../src/lib/planParameters";

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

describe("decision makers are normal B2B work (owner decision D3)", () => {
  beforeEach(() => clearBriefCacheForTesting());

  it("the generic phrase already names who is wanted, so the roles question is not asked", () => {
    for (const text of ["5 شركات كهروميكانيكية في مصر مع صناع القرار وإيميلاتهم وأرقامهم", "٥ مدراء تنفيذيين لشركات برمجيات في السعودية", "five decision makers at solar companies in Germany"]) {
      expect(PEOPLE_ROLE_PATTERN.test(text), text).toBe(true);
      expect(getDeterministicDiscoveryQuestion(text, brief)?.id, text).not.toBe("people_roles_required");
    }
  });

  it("without a country the only question is the country", () => {
    expect(getDeterministicDiscoveryQuestion("5 شركات كهروميكانيكية مع صناع القرار وإيميلاتهم وأرقامهم", brief)?.id).toBe("people_country_required");
  });

  it("the plan card is created (never a refusal) and states which contact fields are expected and what is billed", async () => {
    const res = await new ChatHandler(makeMockTables() as any).handleUserMessage({
      userId: "user_dm",
      message: "5 شركات كهروميكانيكية في مصر مع صناع القرار وإيميلاتهم وأرقامهم",
      userBalance: 5000,
    });

    expect(res.outputType).toBe("propose_plan");
    expect(res.outputType).not.toBe("refuse");
    expect(res.contentAr).toContain(CONTACT_EXPECTATION_AR);
    expect(res.contentAr).toContain(CONTACT_BILLING_NOTE_AR);
    expect(res.contentAr).toContain("البريد المهني يُعرض إذا كان متاحاً ومؤكداً في المصادر المتاحة");
    expect(res.contentAr).not.toMatch(/لا أستطيع|غير متاحة حالياً/);
    expect(res.planQuote.items[0].capabilitySlug).toBe("professional-people-search");
    expect(res.planQuote.items[0].targetVolumeMax).toBe(5);
    expect(res.planQuote.items[0].params.country).toBe("EG");
    expect(res.planQuote.methodologyNotes).toContain(CONTACT_EXPECTATION_AR);
    // Customer text never names a provider, an endpoint, a currency in dollars or an English word.
    expect(res.contentAr).not.toMatch(/[A-Za-z]/);
    expect(res.contentAr).not.toMatch(/treg|icypeas|usd|\$/i);
  });

  it("the price is per delivered person record: quoted points equal records x unit price plus the 15% hold only", async () => {
    const res = await new ChatHandler(makeMockTables() as any).handleUserMessage({
      userId: "user_dm2",
      message: "5 شركات كهروميكانيكية في مصر مع صناع القرار وإيميلاتهم وأرقامهم",
      userBalance: 5000,
    });
    const q = res.planQuote;
    expect(q.expectedPoints).toBe(q.unitPricePoints * 5);
    expect(q.quotedPoints).toBe(Math.ceil(q.expectedPoints * 1.15));
  });
});
