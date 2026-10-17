import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { NAME_PROMPT_AR, extractCustomerName } from "../src/lib/customerName";
import { lastAssistantAskedForName } from "../src/lib/server/customerNameStore";

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

describe("customer name (owner decision D2)", () => {
  beforeEach(() => clearBriefCacheForTesting());

  it("an explicit statement always counts", () => {
    expect(extractCustomerName("اسمي سلمى", false)).toBe("سلمى");
    expect(extractCustomerName("أنا اسمي كريم حسن.", false)).toBe("كريم حسن");
    expect(extractCustomerName("my name is Omar", false)).toBe("Omar");
  });

  it("a bare reply counts only right after the name question", () => {
    expect(extractCustomerName("سلمى", false)).toBeNull();
    expect(extractCustomerName("سلمى", true)).toBe("سلمى");
    expect(extractCustomerName("كريم حسن علي", true)).toBe("كريم حسن علي");
  });

  it("greetings, requests, digits and long text are never taken as a name", () => {
    for (const text of ["هاي", "مرحبا", "عايز خمس شركات", "ابحث عن شركات", "٥ شركات", "12345", "نعم", "لا", "اسم طويل جدا جدا جدا جدا", "https://x.com/a"]) {
      expect(extractCustomerName(text, true), text).toBeNull();
    }
    expect(extractCustomerName("x".repeat(100), true)).toBeNull();
  });

  it("the greeting uses the real account name, then the balance, and never a hardcoded name", async () => {
    const res = await new ChatHandler(makeMockTables() as any).handleUserMessage({
      userId: "u_name", message: "هاي", userBalance: 250, personaProfile: { name: "سلمى" },
    });
    expect(res.contentAr).toBe("أهلًا سلمى، رصيدك المتاح ٢٥٠ نقطة. كيف أساعدك اليوم؟");
    expect(res.contentAr).not.toContain("مجدي");
    expect(res.tokensUsed.costUsd).toBe(0);
  });

  it("the account name wins over the top-up sender name", async () => {
    const res = await new ChatHandler(makeMockTables() as any).handleUserMessage({
      userId: "u_name2", message: "هاي", userBalance: 0, personaProfile: { name: "سلمى", full_name: "سلمى أحمد" },
    });
    expect(res.contentAr).toContain("أهلًا سلمى،");
  });

  it("without a name Diger AI asks once, politely, and never invents one", async () => {
    const res = await new ChatHandler(makeMockTables() as any).handleUserMessage({ userId: "u_noname", message: "هاي", userBalance: 100 });
    expect(res.contentAr).toBe(`أهلًا بك، ${NAME_PROMPT_AR}`);
    expect(res.contentAr).not.toContain("مجدي");
  });

  it("the reply that gives the name is acknowledged with the balance and costs no model turn", async () => {
    const res = await new ChatHandler(makeMockTables() as any).handleUserMessage({
      userId: "u_named", message: "سلمى", userBalance: 100, capturedName: "سلمى",
    });
    expect(res.contentAr).toBe("تشرفنا يا سلمى. رصيدك المتاح ١٠٠ نقطة. كيف أساعدك اليوم؟");
    expect(res.outputType).toBe("answer_question");
    expect(res.turnStats?.modelCalls).toBe(0);
  });

  it("the route knows the previous assistant message asked for the name", async () => {
    const client = (content: string | null) => ({
      from: () => {
        const api: any = { select: () => api, eq: () => api, order: () => api, limit: async () => ({ data: content === null ? [] : [{ content_ar: content }] }) };
        return api;
      },
    });
    expect(await lastAssistantAskedForName(client(`أهلًا بك، ${NAME_PROMPT_AR}`), "u", "c")).toBe(true);
    expect(await lastAssistantAskedForName(client("أهلًا سلمى، كيف أساعدك؟"), "u", "c")).toBe(false);
    expect(await lastAssistantAskedForName(client(null), "u", "c")).toBe(false);
    expect(await lastAssistantAskedForName(null, "u", "c")).toBe(false);
  });
});

import { readFileSync } from "node:fs";
describe("welcome screen name (static checks)", () => {
  const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
  const empty = readFileSync("src/app/dashboard/chat/components/EmptyChat.tsx", "utf8");

  it("uses only the real profile name, never the e-mail prefix", () => {
    expect(page).toContain("user?.user_metadata?.name || user?.user_metadata?.full_name");
    expect(page).not.toMatch(/const firstName = \(user\?\.name/);
  });

  it("does not leave a stray comma when the name is unknown", () => {
    expect(empty).toContain('"أهلًا بك، بماذا نبدأ؟"');
  });
});
