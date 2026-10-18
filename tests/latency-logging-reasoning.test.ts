import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { searchCatalog } from "../src/functions/shared/catalogClient";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { getLlmStatusSnapshot } from "../src/functions/shared/llmClient";

const mockedSearchCatalog = vi.mocked(searchCatalog);

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

describe("Task 3: Latency & Call Logging + Reasoning Effort Status", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("Server-Side Call & Latency Logging", () => {
    it("(a) logs modelCalls, catalogSearches, and latencyMs on console per chat message (greeting: zero model calls)", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const tables = makeMockTables();
      const handler = new ChatHandler(tables as any);

      const res = await handler.handleUserMessage({
        userId: "test_user",
        message: "هاي",
        userBalance: 500,
      });

      expect(res.turnStats).toBeDefined();
      // Greetings are answered by server code with no model turn (owner decision D2 / speed).
      expect(res.turnStats?.modelCalls).toBe(0);
      expect(res.turnStats?.catalogSearches).toBe(0);
      expect(res.turnStats?.latencyMs).toBeGreaterThanOrEqual(0);

      const matchingLog = logSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("[chat:turn]"),
      );
      expect(matchingLog).toBeDefined();
      expect(matchingLog![0]).toContain("modelCalls=0");
      expect(matchingLog![0]).toContain("catalogSearches=0");
      expect(matchingLog![0]).toContain("latencyMs=");
    });
  });

  describe("Reasoning Effort Resolution & Status", () => {
    it("(b) defaults to 'low' and shows 'not applied (model does not support it)' for Anthropic", () => {
      process.env.LLM_PROVIDER = "anthropic";
      delete process.env.LLM_REASONING_EFFORT;

      const snapshot = getLlmStatusSnapshot();
      expect(snapshot.provider).toBe("anthropic");
      expect(snapshot.reasoning_effort).toBe("low");
      expect(snapshot.reasoning_effort_status).toBe("not applied (model does not support it)");
    });

    it("(c) reflects custom effort ('medium') and 'not applied (model does not support it)' for Anthropic", () => {
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_REASONING_EFFORT = "medium";

      const snapshot = getLlmStatusSnapshot();
      expect(snapshot.reasoning_effort).toBe("medium");
      expect(snapshot.reasoning_effort_status).toBe("not applied (model does not support it)");
    });

    it("(d) shows 'applied' when provider is OpenAI", () => {
      process.env.LLM_PROVIDER = "openai";
      process.env.LLM_REASONING_EFFORT = "medium";

      const snapshot = getLlmStatusSnapshot();
      expect(snapshot.provider).toBe("openai");
      expect(snapshot.reasoning_effort).toBe("medium");
      expect(snapshot.reasoning_effort_status).toBe("applied");
    });
  });
});
