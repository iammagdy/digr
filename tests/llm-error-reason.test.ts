import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  LlmClient,
  getLlmStatusSnapshot,
  setLastLlmFallbackReason,
} from "../src/functions/shared/llmClient";
import { GET as getLlmStatus } from "../src/app/api/admin/llm-status/route";
import { POST as postChat } from "../src/app/api/chat/route";

const mockSbAuth = vi.hoisted(() => ({
  user: {
    id: "admin_test",
    email: "admin@diger.tech",
    email_confirmed_at: "2026-10-12T00:00:00Z",
    app_metadata: { role: "admin" },
  } as any,
  spendCapExceeded: false,
}));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: mockSbAuth.user },
        error: null,
      })),
    },
  })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({ data: null, error: null })),
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        })),
        order: vi.fn(() => ({
          limit: vi.fn(async () => ({ data: [], error: null })),
        })),
        gte: vi.fn(async () => {
          if ((table === "provider_costs" || table === "llm_usage") && mockSbAuth.spendCapExceeded) {
            return { data: [{ cost_usd: 5.0, costUsd: 5.0, at: new Date().toISOString(), created_at: new Date().toISOString() }], error: null };
          }
          return { data: [], error: null };
        }),
      })),
    })),
  })),
}));

describe("LLM Error Reason Codes & Browser-Accessible Admin Status", () => {
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

  it("records short reason codes (missing_key, http_401, http_404_model, http_429, timeout) in server log and llm-status without leaking any part of the key", async () => {
    const secretKey = "sk-ant-api03-ULTRA-SECRET-VALUE-778899";
    process.env.LLM_PROVIDER = "anthropic";
    process.env.LLM_ENABLED = "true";
    process.env.ANTHROPIC_MODEL = "claude-haiku-5-5";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new LlmClient();

    // 1. missing_key
    delete process.env.ANTHROPIC_API_KEY;
    await client.executeTurn({
      messages: [{ role: "user", content: "مرحبا" }],
      sanitizedCapabilities: [],
    });
    expect(getLlmStatusSnapshot().last_fallback_reason).toBe("missing_key");

    // Set secret key for HTTP status tests
    process.env.ANTHROPIC_API_KEY = secretKey;

    // 2. http_401
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }),
      }),
    );
    await client.executeTurn({
      messages: [{ role: "user", content: "مرحبا" }],
      sanitizedCapabilities: [],
    });
    expect(getLlmStatusSnapshot().last_fallback_reason).toBe("http_401");

    // 3. http_404_model
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: { type: "not_found_error", message: "model: claude-haiku-5-5" } }),
      }),
    );
    await client.executeTurn({
      messages: [{ role: "user", content: "مرحبا" }],
      sanitizedCapabilities: [],
    });
    expect(getLlmStatusSnapshot().last_fallback_reason).toBe("http_404_model");

    // 4. http_429
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } }),
      }),
    );
    await client.executeTurn({
      messages: [{ role: "user", content: "مرحبا" }],
      sanitizedCapabilities: [],
    });
    expect(getLlmStatusSnapshot().last_fallback_reason).toBe("http_429");

    // 5. timeout
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr));
    await client.executeTurn({
      messages: [{ role: "user", content: "مرحبا" }],
      sanitizedCapabilities: [],
    });
    expect(getLlmStatusSnapshot().last_fallback_reason).toBe("timeout");

    const allLoggedText = JSON.stringify(warnSpy.mock.calls);
    expect(allLoggedText).toContain("reason=missing_key");
    expect(allLoggedText).toContain("reason=http_401");
    expect(allLoggedText).toContain("reason=http_404_model");
    expect(allLoggedText).toContain("reason=http_429");
    expect(allLoggedText).toContain("reason=timeout");
    expect(allLoggedText).not.toContain(secretKey);
    expect(allLoggedText).not.toContain("ULTRA-SECRET");
    expect(allLoggedText).not.toContain("sk-ant");
  });

  it("records spend_cap when daily spend cap blocks a chat request", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.LLM_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "sk-ant-mock-secret";
    process.env.LLM_DAILY_SPEND_CAP_USD = "0.01";
    mockSbAuth.spendCapExceeded = true;

    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_jwt",
      },
      body: JSON.stringify({ message: "مرحبا" }),
    });

    const res = await postChat(req);
    expect(res.status).toBe(503);
    expect(getLlmStatusSnapshot().last_fallback_reason).toBe("spend_cap");
  });

  it("allows logged-in admin to open /api/admin/llm-status from the browser via cookie, fallback-cookies header, or HTML bootstrap", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.LLM_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret-never-leak";
    process.env.ANTHROPIC_MODEL = "claude-haiku-5-5";
    setLastLlmFallbackReason("http_404_model");
    mockSbAuth.user = { id: "admin_browser", email: "admin@diger.tech", app_metadata: { role: "admin" } };

    // 1. Authenticated via admin session / Bearer
    const cookieReq = new NextRequest("http://localhost:3000/api/admin/llm-status", {
      method: "GET",
      headers: {
        Authorization: "Bearer valid_admin_jwt",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    const cookieRes = await getLlmStatus(cookieReq);
    expect(cookieRes.status).toBe(200);
    const cookieBody = await cookieRes.json();
    expect(cookieBody.last_fallback_reason).toBe("http_404_model");
    expect(JSON.stringify(cookieBody)).not.toContain("sk-ant-secret-never-leak");

    // 2. Authenticated via X-Fallback-Cookies header (from browser localStorage.cookieFallback)
    const fallbackReq = new NextRequest("http://localhost:3000/api/admin/llm-status?format=json", {
      method: "GET",
      headers: {
        "x-fallback-cookies": JSON.stringify({
          a_session_6ac947090008606ef482: "valid_appwrite_session_token",
        }),
      },
    });
    const fallbackRes = await getLlmStatus(fallbackReq);
    expect(fallbackRes.status).toBe(200);
    const fallbackBody = await fallbackRes.json();
    expect(fallbackBody.last_fallback_reason).toBe("http_404_model");

    // 3. Direct browser navigation (Accept: text/html) before cookie sync serves HTML bootstrap
    const htmlNavReq = new NextRequest("http://localhost:3000/api/admin/llm-status", {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
      },
    });
    const htmlNavRes = await getLlmStatus(htmlNavReq);
    expect(htmlNavRes.status).toBe(200);
    expect(htmlNavRes.headers.get("content-type")).toContain("text/html");
    const htmlText = await htmlNavRes.text();
    expect(htmlText).toContain("/api/admin/llm-status?format=json");
  });
});
