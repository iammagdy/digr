import { afterEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/chat/route";
import {
  checkUserRateLimits,
  checkGlobalDailySpendCap,
  checkConversationTokenCap,
  RateLimitConfig,
} from "../src/functions/shared/rateLimits";
import { LlmClient } from "../src/functions/shared/llmClient";

const mockSbState = vi.hoisted(() => ({
  user: null as any,
  authError: null as any,
  tablesError: false,
}));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async (token?: string) => {
        if (token === "invalid_or_expired_jwt_token_12345") {
          return { data: { user: null }, error: new Error("invalid JWT") };
        }
        if (token === "forged_jwt") {
          return {
            data: { user: { id: "user_a", email_confirmed_at: "2026-10-12T00:00:00Z" } },
            error: null,
          };
        }
        if (token === "unverified_jwt") {
          return {
            data: { user: { id: "user_a", email_confirmed_at: null, user_metadata: { email_verified: false } } },
            error: null,
          };
        }
        return { data: { user: mockSbState.user }, error: mockSbState.authError };
      }),
    },
  })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (mockSbState.tablesError) {
        throw new Error("private missing-table details");
      }
      return {
        select: vi.fn(() => ({
          gte: vi.fn(async () => ({ data: [], error: null })),
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              gte: vi.fn(async () => ({ count: 0, error: null })),
            })),
          })),
        })),
        insert: vi.fn(async () => ({ data: null, error: null })),
      };
    }),
  })),
}));

describe("P1.5 Security & Rate Limits Suite", () => {
  afterEach(() => {
    mockSbState.user = null;
    mockSbState.authError = null;
    mockSbState.tablesError = false;
    vi.restoreAllMocks();
  });

  // ================= 1. Authentication & Identity Spoofing Tests =================

  it("should reject /api/chat request when no session or JWT is provided (401)", async () => {
    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "مرحبا" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("غير مصرح");
  });

  it("should reject /api/chat request when invalid JWT is provided (401)", async () => {
    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid_or_expired_jwt_token_12345",
      },
      body: JSON.stringify({ message: "مرحبا" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("غير مصرح");
  });

  it("should reject /api/chat request if body attempts to claim another user's ID (403)", async () => {
    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer forged_jwt",
      },
      body: JSON.stringify({
        userId: "victim_user_b",
        message: "استخرج بيانات",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("fails closed with a friendly response when llm_usage is unavailable", async () => {
    mockSbState.user = { id: "user_a", email_confirmed_at: "2026-10-12T00:00:00Z" };
    mockSbState.tablesError = true;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid_test_jwt" },
      body: JSON.stringify({ message: "مرحبا" }),
    });

    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.error).toContain("متوقف مؤقتاً");
    expect(JSON.stringify(body)).not.toContain("private missing-table details");
    expect(warning).toHaveBeenCalledWith("[llm:SPEND_CAP_STORAGE_UNAVAILABLE]");
  });

  // ================= 2. Rate Limits: Per-Minute & Per-Day =================

  it("should enforce per-minute rate limit on user messages (429)", async () => {
    const mockTables: any = {
      listRows: vi.fn().mockResolvedValueOnce({
        total: 10, // reached 10 msgs in last minute
        rows: [],
      }),
    };

    const config: RateLimitConfig = {
      messagesPerMinute: 10,
      conversationMaxTokens: 40000,
      globalDailySpendCapUsd: 1.0,
    };

    const result = await checkUserRateLimits(mockTables, "user_test_123", config);
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(429);
    expect(result.type).toBe("minute_limit");
    expect(result.reasonAr).toContain("لحظة من فضلك");
  });

  it("has no per-day limit: a high daily count alone never blocks", async () => {
    const mockTables: any = {
      listRows: vi.fn().mockResolvedValueOnce({ total: 2, rows: [] }), // minute check passes
    };

    const config: RateLimitConfig = {
      messagesPerMinute: 20,
      conversationMaxTokens: 40000,
      globalDailySpendCapUsd: 1.0,
    };

    const result = await checkUserRateLimits(mockTables, "user_test_123", config);
    expect(result.allowed).toBe(true);
  });

  // ================= 3. Budget Limits: Global Spend Cap & Context Cap =================

  it("should enforce platform global daily LLM spend cap (503)", async () => {
    const mockTables: any = {
      listRows: vi.fn().mockResolvedValueOnce({
        total: 2,
        rows: [
          { costUsd: 0.65 },
          { costUsd: 0.45 }, // Total = $1.10 USD (exceeds $1.00 cap)
        ],
      }),
    };

    const config: RateLimitConfig = {
      messagesPerMinute: 10,
      conversationMaxTokens: 40000,
      globalDailySpendCapUsd: 1.0,
    };

    const result = await checkGlobalDailySpendCap(mockTables, config);
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.type).toBe("global_spend_cap");
    expect(result.reasonAr).toContain("المساعد مشغول الآن");
    expect(result.reasonAr).not.toContain("غدا");
    expect(result.reasonAr).not.toContain("الحد");
  });

  it("should enforce conversation context token cap (40,000 tokens)", () => {
    const withinCap = checkConversationTokenCap(8000);
    expect(withinCap.allowed).toBe(true);

    const stillWithin = checkConversationTokenCap(15001);
    expect(stillWithin.allowed).toBe(true);

    const exceededCap = checkConversationTokenCap(40001);
    expect(exceededCap.allowed).toBe(false);
    expect(exceededCap.statusCode).toBe(429);
    expect(exceededCap.reasonAr).toContain("40,000 توكن");
  });

  // ================= 4. LLM Kill-Switch & Fake Provider =================

  it("should return friendly Arabic refusal when LLM_ENABLED=false", async () => {
    const prevVal = process.env.LLM_ENABLED;
    process.env.LLM_ENABLED = "false";

    try {
      const llm = new LlmClient();
      const res = await llm.executeTurn({
        messages: [{ role: "user", content: "أريد ملف تيك توك" }],
        sanitizedCapabilities: [],
      });

      expect(res.output.type).toBe("refuse");
      expect((res.output as any).reasonAr).toContain("معطلة مؤقتاً للصيانة");
      expect(res.costUsd).toBe(0);
      expect(res.inputTokens).toBe(0);
    } finally {
      process.env.LLM_ENABLED = prevVal;
    }
  });

  it("should operate deterministically with LLM_PROVIDER=fake without external calls", async () => {
    const llm = new LlmClient();
    const res = await llm.executeTurn({
      messages: [{ role: "user", content: "أريد بيانات ملف حساب تيك توك @tiktok" }],
      sanitizedCapabilities: [{ slug: "tiktok-profile" }],
    });

    expect(res.output.type).toBe("propose_plan");
    expect((res.output as any).summaryAr).toContain("تيك توك");
  });
});

describe("email verification gate on research routes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects /api/chat for an unverified account (403)", async () => {
    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer unverified_jwt" },
      body: JSON.stringify({ message: "استخرج بيانات" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("بريدك");
  });
});
