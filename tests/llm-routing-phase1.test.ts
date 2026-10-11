import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { Account, TablesDB } from "node-appwrite";
import {
  LlmClient,
  getLlmStatusSnapshot,
  setLastLlmFallbackReason,
} from "../src/functions/shared/llmClient";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { GET as getLlmStatus } from "../src/app/api/admin/llm-status/route";

describe("Phase 1: LLM Routing, Runtime Env Resolution, Error Honesty & Admin Status", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    setLastLlmFallbackReason(null);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    setLastLlmFallbackReason(null);
    vi.restoreAllMocks();
  });

  it("calls Anthropic at runtime when LLM_PROVIDER=anthropic and LLM_ENABLED=true even without LLM_LIVE=true and even if LlmClient was constructed earlier", async () => {
    // Simulate LlmClient constructed at module load before runtime env vars are populated
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_LIVE;
    const client = new LlmClient();

    // Now set runtime env vars exactly as on the Appwrite Site
    process.env.LLM_PROVIDER = "anthropic";
    process.env.LLM_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "sk-ant-mock-secret-do-not-leak-9999";
    process.env.ANTHROPIC_MODEL = "claude-haiku-5-5";

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_live_01",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_01",
            name: "actionResult",
            input: {
              type: "ask_clarification",
              questions: [
                {
                  question: "ما نطاق البحث المطلوب لتعليقات فيسبوك؟",
                  options: ["منشور محدد", "بحث بالكلمات المفتاحية"],
                },
              ],
              reasonAr: "لتجهيز خطة تعليقات فيسبوك بدقة",
            },
          },
        ],
        model: "claude-haiku-5-5",
        usage: { input_tokens: 420, output_tokens: 55 },
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await client.executeTurn({
      messages: [{ role: "user", content: "عايز تعليقات فيسبوك عن قائمة المنقولات في مصر" }],
      sanitizedCapabilities: [],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.output.type).toBe("ask_clarification");
    expect(JSON.stringify(result.output)).not.toContain("LinkedIn");
    expect(getLlmStatusSnapshot().last_fallback_reason).toBeNull();
  });

  it("never falls back to fake provider when LLM_PROVIDER=anthropic is unreachable; returns honest Arabic error and holds 0 points", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.LLM_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "sk-ant-mock-secret-9999";
    delete process.env.LLM_LIVE;

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed: ECONNREFUSED")));

    const mockTables: any = {
      createRow: vi.fn().mockResolvedValue({ $id: "row-1" }),
      getRow: vi.fn().mockResolvedValue({ totalTokens: 0 }),
      listRows: vi.fn().mockResolvedValue({ rows: [] }),
      updateRow: vi.fn().mockResolvedValue({}),
    };

    const handler = new ChatHandler(mockTables);
    const response = await handler.handleUserMessage({
      userId: "user-1",
      conversationId: "conv-1",
      message: "عايز تعليقات فيسبوك",
      userBalance: 100,
    });

    expect(response.outputType).toBe("refuse");
    expect(response.contentAr).toContain("المساعد غير متاح الآن، حاول لاحقًا");
    expect(response.contentAr).not.toContain("LinkedIn");
    expect(response.planQuote).toBeUndefined();
    expect(response.tokensUsed.costUsd).toBe(0);
    expect(getLlmStatusSnapshot().last_fallback_reason).toBe("provider_unreachable");
  });

  it("never maps Facebook requests to LinkedIn in fake fallback mode", async () => {
    process.env.LLM_PROVIDER = "fake";
    const client = new LlmClient();

    const res = await client.executeTurn({
      messages: [{ role: "user", content: "عايز تعليقات فيسبوك عن قائمة المنقولات" }],
      sanitizedCapabilities: [],
    });

    expect(res.output.type).toBe("suggest_alternative");
    if (res.output.type === "suggest_alternative") {
      expect(res.output.unsupportedService).toBe("Facebook");
      expect(res.output.explanationAr).toContain("Facebook");
      expect(res.output.explanationAr).not.toContain("LinkedIn");
    }
  });

  describe("/api/admin/llm-status endpoint", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const req = new NextRequest("http://localhost:3000/api/admin/llm-status", {
        method: "GET",
      });
      const res = await getLlmStatus(req);
      expect(res.status).toBe(401);
    });

    it("rejects authenticated non-admin users with 403", async () => {
      vi.spyOn(Account.prototype, "get").mockResolvedValue({
        $id: "user_regular",
        labels: ["user"],
      } as any);

      const req = new NextRequest("http://localhost:3000/api/admin/llm-status", {
        method: "GET",
        headers: { Authorization: "Bearer valid_user_jwt" },
      });
      const res = await getLlmStatus(req);
      expect(res.status).toBe(403);
    });

    it("returns ONLY booleans and names for admin users, never leaking key values or NEXT_PUBLIC", async () => {
      const secretKey = "sk-ant-api03-SUPER-SECRET-KEY-VALUE-DO-NOT-LEAK";
      process.env.LLM_PROVIDER = "anthropic";
      process.env.LLM_ENABLED = "true";
      process.env.ANTHROPIC_API_KEY = secretKey;
      process.env.ANTHROPIC_MODEL = "claude-haiku-5-5";
      process.env.APPWRITE_API_KEY = "server-appwrite-key";

      vi.spyOn(Account.prototype, "get").mockResolvedValue({
        $id: "admin_1",
        labels: ["admin"],
      } as any);

      vi.spyOn(TablesDB.prototype, "listRows").mockResolvedValue({
        total: 1,
        rows: [{ createdAt: "2026-10-11T09:30:00.000Z" }],
      } as any);

      const req = new NextRequest("http://localhost:3000/api/admin/llm-status", {
        method: "GET",
        headers: { Authorization: "Bearer valid_admin_jwt" },
      });

      const res = await getLlmStatus(req);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body).toEqual({
        provider: "anthropic",
        llm_enabled: true,
        key_present: true,
        model: "claude-haiku-5-5",
        last_llm_usage_timestamp: "2026-10-11T09:30:00.000Z",
        last_fallback_reason: null,
        last_fallback_detail: null,
      });

      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(secretKey);
      expect(serialized).not.toContain("sk-ant");
      expect(serialized).not.toContain("SUPER-SECRET");

      const routeSource = readFileSync("src/app/api/admin/llm-status/route.ts", "utf8");
      expect(routeSource).not.toContain("NEXT_PUBLIC");
    });
  });
});
