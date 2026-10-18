import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// search_catalog must be intercepted before chatHandler loads it.
vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { searchCatalog } from "../src/functions/shared/catalogClient";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import {
  checkUserRateLimits,
  checkMessageLength,
  checkGlobalDailySpendCap,
  DEFAULT_RATE_LIMITS,
} from "../src/functions/shared/rateLimits";
import { buildSystemPrompt, PROMPT_VERSION } from "../src/functions/shared/systemPrompt";

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
    properties: { postUrl: { type: "string" } },
    required: ["postUrl"],
  },
};

const TIKTOK_ENDPOINT: any = {
  ...FB_ENDPOINT,
  slug: "tiktok-post-comments",
  id: "treg-tiktok-post-comments-v1",
  nameAr: "استخراج تعليقات منشورات تيك توك العامة",
  nameEn: "TikTok Post Comments",
  platform: "tiktok",
};

// Minimal in-memory TablesDB mock with JSON-query parsing.
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
        } else if (pq.method === "orderDesc" && pq.attribute) {
          const a = pq.attribute;
          rows = [...rows].sort((x, y) => String(y[a] || "").localeCompare(String(x[a] || "")));
        }
      }
      const total = rows.length;
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

describe("open assistant (feat/open-assistant)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSearchCatalog.mockResolvedValue([FB_ENDPOINT, TIKTOK_ENDPOINT]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no daily limit: 50 user messages in one day are all allowed", async () => {
    const tables = makeMockTables();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 50; i++) {
      await tables.createRow({
        databaseId: "digr",
        tableId: "messages",
        data: { userId: "u1", conversationId: "c1", role: "user", content: `msg ${i}`, createdAt: twoHoursAgo },
      });
    }
    const res = await checkUserRateLimits(tables as any, "u1");
    expect(res.allowed).toBe(true);
  });

  it("burst limit triggers at the 21st message in one minute, then clears", async () => {
    const tables = makeMockTables();
    const now = new Date().toISOString();
    for (let i = 0; i < 20; i++) {
      await tables.createRow({
        databaseId: "digr",
        tableId: "messages",
        data: { userId: "u2", conversationId: "c1", role: "user", content: `m ${i}`, createdAt: now },
      });
    }
    const blocked = await checkUserRateLimits(tables as any, "u2");
    expect(blocked.allowed).toBe(false);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.reasonAr).toContain("لحظة من فضلك");

    // After the minute passes, the same account is allowed again.
    const tables2 = makeMockTables();
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    for (let i = 0; i < 20; i++) {
      await tables2.createRow({
        databaseId: "digr",
        tableId: "messages",
        data: { userId: "u2", conversationId: "c1", role: "user", content: `m ${i}`, createdAt: twoMinAgo },
      });
    }
    const cleared = await checkUserRateLimits(tables2 as any, "u2");
    expect(cleared.allowed).toBe(true);
  });

  it("burst default is 20/min via CHAT_MESSAGES_PER_MINUTE setting", () => {
    expect(DEFAULT_RATE_LIMITS.messagesPerMinute).toBe(20);
  });

  it("oversized message rejected politely", () => {
    const bad = checkMessageLength("x".repeat(4001));
    expect(bad.allowed).toBe(false);
    expect(bad.reasonAr).toContain("طويلة شوية");
    expect(bad.reasonAr).not.toContain("4000 حرف\"");
    const ok = checkMessageLength("x".repeat(4000));
    expect(ok.allowed).toBe(true);
  });

  it("4 internal model calls still count as 1 user message", async () => {
    const tables = makeMockTables();
    const now = new Date().toISOString();
    for (let i = 0; i < 4; i++) {
      await tables.createRow({
        databaseId: "digr",
        tableId: "llm_usage",
        data: { userId: "u3", conversationId: "c1", inputTokens: 5000, outputTokens: 100, costUsd: 0.01, createdAt: now },
      });
    }
    await tables.createRow({
      databaseId: "digr",
      tableId: "messages",
      data: { userId: "u3", conversationId: "c1", role: "user", content: "hi", createdAt: now },
    });
    const res = await checkUserRateLimits(tables as any, "u3");
    expect(res.allowed).toBe(true);
  });

  it("global kill-switch message is honest: no 'غدا', no limits talk", async () => {
    const tables = makeMockTables();
    await tables.createRow({
      databaseId: "digr",
      tableId: "llm_usage",
      data: { userId: "u4", costUsd: 5.0, createdAt: new Date().toISOString() },
    });
    const res = await checkGlobalDailySpendCap(tables as any, {
      ...DEFAULT_RATE_LIMITS,
      globalDailySpendCapUsd: 1.0,
    });
    expect(res.allowed).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.reasonAr).toContain("المساعد مشغول الآن");
    expect(res.reasonAr).not.toContain("غدا");
    expect(res.reasonAr).not.toContain("الحد");
    expect(res.reasonAr).not.toContain("حصة");
  });

  it("llm_usage row is linked to the assistant message id", async () => {
    const tables = makeMockTables();
    const res = await new ChatHandler(tables as any).handleUserMessage({
      userId: "u5",
      message: "هاتلي تعليقات فيسبوك عن البطالة",
      userBalance: 300,
      testScenario: "search_then_plan",
    });
    expect(res.outputType).toBe("propose_plan");
    const usage = await tables.listRows({ databaseId: "digr", tableId: "llm_usage", queries: [] });
    expect(usage.rows.length).toBeGreaterThan(0);
    const row = usage.rows[0];
    expect(row.messageId).toBeDefined();
    expect(typeof row.costUsd).toBe("number");
    // The message id points at a real stored assistant message.
    const msg = await tables.getRow({ databaseId: "digr", tableId: "messages", rowId: row.messageId });
    expect(msg.role).toBe("assistant");
  });

  it("system prompt v7: no vendor/model names, smart discovery guidance", () => {
    expect(PROMPT_VERSION).toBe("8.0.0");
    const prompt = buildSystemPrompt({ sanitizedCapabilities: [] });
    for (const vendor of ["anthropic", "claude", "haiku", "openai", "gpt-"]) {
      expect(prompt.toLowerCase()).not.toContain(vendor);
    }
    expect(prompt).toContain("Never ask the same thing twice");
    expect(prompt).toContain("SMART follow-up questions");
  });

  it("multi-platform request: smart questions first, then a two-step plan", async () => {
    const tables = makeMockTables();
    const handler = new ChatHandler(tables as any);

    const first = await handler.handleUserMessage({
      userId: "u6",
      message: "عايز اسحب 1000 تعليق من فيسبوك و1000 تعليق من تيك توك",
      userBalance: 500,
      testScenario: "multiplatform_questions",
    });
    expect(first.outputType).toBe("ask_clarification");
    expect(first.clarificationQuestions!.length).toBeGreaterThan(0);
    expect(first.clarificationQuestions!.length).toBeLessThanOrEqual(3);

    const second = await handler.handleUserMessage({
      userId: "u6",
      conversationId: first.conversationId,
      message: "منشورات كتير من حسابات مشهورة، آخر 3 شهور، ملف لكل منصة",
      userBalance: 500,
      testScenario: "multiplatform_plan",
    });
    expect(second.outputType).toBe("propose_plan");
    expect(second.planQuote).toBeDefined();
    expect(second.planQuote.items.length).toBe(2);
    expect(second.contentAr).not.toContain("يرجى تدقيق المدخلات");
    expect(second.contentAr).not.toContain("غير متوفرة");
  });
});
