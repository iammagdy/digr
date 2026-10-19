import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { ChatHandler } from "../src/functions/shared/chatHandler";

function makeMockTables() {
  const store = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
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
    async listRows({ tableId }: any) {
      const rows = [...table(tableId).values()];
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

const REQUIRED_TIMING_KEYS = [
  "auth",
  "authMs",
  "rateLimit",
  "rateLimitMs",
  "conversation",
  "conversationMs",
  "briefSaves",
  "briefSavesMs",
  "brief",
  "briefMs",
  "history",
  "historyMs",
  "catalog",
  "catalogMs",
  "quoteRpc",
  "quoteRpcMs",
  "quote",
  "quoteMs",
  "writes",
  "writesMs",
  "awaitsCount",
  "supabaseMs",
  "llmMs",
  "totalMs",
  "tExtractMs",
  "tCatalogSearchMs",
  "tPlanLlmMs",
  "tQuoteMs",
] as const;

describe("Task 10a: Chat Stage Timings Measurement", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("stepTimings has all keys and logs tag: chat_stage_timings on early returns (greeting)", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const tables = makeMockTables();
    const handler = new ChatHandler(tables as any);

    const res = await handler.handleUserMessage({
      userId: "user_stage_1",
      message: "مرحبا",
      userBalance: 100,
      authMs: 12,
      rateLimitMs: 5,
    });

    expect(res.turnStats).toBeDefined();
    expect(res.turnStats?.stepTimings).toBeDefined();
    const timings = res.turnStats!.stepTimings as Record<string, any>;

    for (const key of REQUIRED_TIMING_KEYS) {
      expect(timings, `Missing stepTimings key: ${key}`).toHaveProperty(key);
      expect(typeof timings[key]).toBe("number");
      expect(timings[key]).toBeGreaterThanOrEqual(0);
    }

    expect(timings.authMs).toBe(12);
    expect(timings.auth).toBe(12);
    expect(timings.rateLimitMs).toBe(5);
    expect(timings.rateLimit).toBe(5);
    expect(timings.awaitsCount).toBeGreaterThan(0);

    const stageCall = infoSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.tag === "chat_stage_timings";
      } catch {
        return false;
      }
    });

    expect(stageCall).toBeDefined();
    const payload = JSON.parse(stageCall![0]);
    expect(payload.tag).toBe("chat_stage_timings");
    expect(payload.awaitsCount).toBe(timings.awaitsCount);
    for (const key of REQUIRED_TIMING_KEYS) {
      expect(payload, `Missing console.info key: ${key}`).toHaveProperty(key);
    }
  });

  it("stepTimings has all keys with 0 defaults when authMs and rateLimitMs are omitted", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const tables = makeMockTables();
    const handler = new ChatHandler(tables as any);

    const res = await handler.handleUserMessage({
      userId: "user_stage_2",
      message: "أهلا",
      userBalance: 50,
    });

    expect(res.turnStats?.stepTimings).toBeDefined();
    const timings = res.turnStats!.stepTimings as Record<string, any>;

    for (const key of REQUIRED_TIMING_KEYS) {
      expect(timings, `Missing key: ${key}`).toHaveProperty(key);
    }

    expect(timings.authMs).toBe(0);
    expect(timings.auth).toBe(0);
    expect(timings.rateLimitMs).toBe(0);
    expect(timings.rateLimit).toBe(0);
    expect(timings.awaitsCount).toBeGreaterThanOrEqual(0);

    const stageCall = infoSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.tag === "chat_stage_timings";
      } catch {
        return false;
      }
    });
    expect(stageCall).toBeDefined();
  });

  it("stepTimings contains all keys on identity queries", async () => {
    const tables = makeMockTables();
    const handler = new ChatHandler(tables as any);

    const res = await handler.handleUserMessage({
      userId: "user_stage_3",
      message: "من أنت؟",
      userBalance: 100,
      authMs: 8,
      rateLimitMs: 3,
    });

    expect(res.turnStats?.stepTimings).toBeDefined();
    const timings = res.turnStats!.stepTimings as Record<string, any>;

    for (const key of REQUIRED_TIMING_KEYS) {
      expect(timings, `Missing key: ${key}`).toHaveProperty(key);
      expect(typeof timings[key]).toBe("number");
    }
  });

  it("stepTimings contains all keys on brief accumulation requests", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const tables = makeMockTables();
    const handler = new ChatHandler(tables as any);

    const res = await handler.handleUserMessage({
      userId: "user_stage_4",
      message: "عايز بيانات من فيسبوك عن الدهب وأسعار الدهب",
      userBalance: 500,
      authMs: 15,
      rateLimitMs: 4,
    });

    expect(res.turnStats?.stepTimings).toBeDefined();
    const timings = res.turnStats!.stepTimings as Record<string, any>;

    for (const key of REQUIRED_TIMING_KEYS) {
      expect(timings, `Missing key: ${key}`).toHaveProperty(key);
      expect(typeof timings[key]).toBe("number");
      expect(timings[key]).toBeGreaterThanOrEqual(0);
    }

    const stageCall = infoSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.tag === "chat_stage_timings";
      } catch {
        return false;
      }
    });
    expect(stageCall).toBeDefined();
    const payload = JSON.parse(stageCall![0]);
    expect(payload.tag).toBe("chat_stage_timings");
    expect(payload.authMs).toBe(15);
    expect(payload.rateLimitMs).toBe(4);
    expect(payload.awaitsCount).toBeGreaterThanOrEqual(1);
  });
});
