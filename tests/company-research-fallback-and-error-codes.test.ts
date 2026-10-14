import { describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import {
  toSafeReasonCode,
  reasonCodeToCustomerMessage,
} from "../src/functions/shared/chatErrors";
import { sanitizeCustomerErrorMessage } from "../src/functions/shared/catalogClient";

describe("Company Research Graceful Fallback & Error Code Mapping", () => {
  const makeMockDb = () => ({
    getRow: vi.fn().mockResolvedValue(null),
    createRow: vi.fn().mockResolvedValue({ $id: "msg-test-123" }),
    listRows: vi.fn().mockResolvedValue({ rows: [] }),
    updateRow: vi.fn().mockResolvedValue({}),
  });

  describe("1. Direct Company Research Request Handling", () => {
    it("handles Egyptian contractor company research request honestly without crashing or stalling", async () => {
      const mockDb = makeMockDb();
      const handler = new ChatHandler(mockDb as any);

      const startTime = Date.now();
      const res = await handler.handleUserMessage({
        userId: "test-user-1",
        conversationId: "conv-company-1",
        message: "عايز 5 شركات مقاولات في مصر في ملف Excel",
        userBalance: 100,
      });
      const durationMs = Date.now() - startTime;

      // 1. Must respond with suggest_alternative
      expect(res.outputType).toBe("suggest_alternative");

      // 2. Must explain that direct company/commercial registry search in Egypt is not supported
      expect(res.contentAr).toContain("غير مدعوم حالياً بشكل مباشر");
      expect(res.contentAr).toContain("السجل التجاري");

      // 3. Must suggest verified platforms (Facebook, LinkedIn, X, etc.)
      expect(res.contentAr).toContain("فيسبوك (Facebook)");
      expect(res.contentAr).toContain("لينكد إن (LinkedIn)");
      expect(res.contentAr).toContain("منصة X (تويتر)");

      // 4. Must provide actionable alternative prompts tailored to the topic
      expect(res.contentAr).toContain("بحث منشورات وصفحات");
      expect(res.contentAr).toContain("استخراج بيانات صفحات");

      // 5. Zero financial commitment
      expect(res.planQuote).toBeUndefined();
      expect(res.revisionQuote).toBeUndefined();

      // 6. Must not make unnecessary LLM turns or catalog network loops
      expect(res.turnStats?.modelCalls).toBe(0);
      expect(res.turnStats?.catalogSearches).toBe(0);

      // 7. Fast turnaround (no 25-second stall)
      expect(durationMs).toBeLessThan(500);

      // 8. DB message updated with ready status
      expect(mockDb.updateRow).toHaveBeenCalledWith(
        expect.objectContaining({
          rowId: expect.any(String),
          data: expect.objectContaining({
            status: "ready",
          }),
        })
      );
    });

    it("allows company research when an approved social platform like LinkedIn is explicitly specified", async () => {
      const mockDb = makeMockDb();
      const handler = new ChatHandler(mockDb as any);

      const res = await handler.handleUserMessage({
        userId: "test-user-1",
        conversationId: "conv-company-linkedin",
        message: "عايز شركات مقاولات على لينكد إن",
        userBalance: 100,
      });

      // Does not refuse as direct company research; proceeds with LinkedIn
      expect(res.outputType).not.toBe("refuse");
      expect(res.contentAr).not.toContain("غير مدعوم حالياً بشكل مباشر");
    });

    it("allows company research when Facebook is explicitly specified", async () => {
      const mockDb = makeMockDb();
      const handler = new ChatHandler(mockDb as any);

      const res = await handler.handleUserMessage({
        userId: "test-user-1",
        conversationId: "conv-company-facebook",
        message: "عايز صفحات شركات المقاولات على فيسبوك",
        userBalance: 100,
      });

      expect(res.outputType).not.toBe("refuse");
      expect(res.contentAr).not.toContain("غير مدعوم حالياً بشكل مباشر");
    });
  });

  describe("2. Safe Reason Code Extraction (toSafeReasonCode)", () => {
    it("maps quote saving / unit price errors to plan_build_failed", () => {
      const err = new Error("سعر الوحدة غير صالح للخدمة المطلوبة.");
      expect(toSafeReasonCode(err, "quote_save")).toBe("plan_build_failed");
    });

    it("maps missing catalog capability errors to plan_build_failed", () => {
      const err = new Error("الخدمة المطلوبة غير معتمدة أو غير موجودة في الكتالوج.");
      expect(toSafeReasonCode(err, "quote_save")).toBe("plan_build_failed");
    });

    it("maps network timeouts to timeout", () => {
      const err = new Error("fetch failed: AbortError: The operation was aborted due to timeout");
      expect(toSafeReasonCode(err, "llm_turn")).toBe("timeout");
    });

    it("maps rate limits to rate_limit_exceeded", () => {
      const err = new Error("Rate limit exceeded: 429 Too Many Requests");
      expect(toSafeReasonCode(err)).toBe("rate_limit_exceeded");
    });

    it("maps catalog search errors to catalog_unavailable", () => {
      const err = new Error("TREG API returned 503 Service Unavailable");
      expect(toSafeReasonCode(err, "catalog_search")).toBe("catalog_unavailable");
    });

    it("maps LLM turn failures to llm_failed", () => {
      const err = new Error("Anthropic API connection error");
      expect(toSafeReasonCode(err, "llm_turn")).toBe("llm_failed");
    });

    it("maps database errors to database_unavailable", () => {
      const err = new Error("Failed to connect to Supabase postgres database");
      expect(toSafeReasonCode(err, "capabilities_load")).toBe("database_unavailable");
    });

    it("preserves explicit reasonCode if present on error", () => {
      const err = Object.assign(new Error("Custom failure"), {
        reasonCode: "capability_not_found",
      });
      expect(toSafeReasonCode(err)).toBe("capability_not_found");
    });

    it("sanitizes code strings to valid identifiers under 64 chars", () => {
      const err = Object.assign(new Error("Sanitize me"), {
        code: "INVALID_INPUT_@#_1234567890_VERY_LONG_STRING_THAT_NEEDS_TRUNCATION_AT_SIXTY_FOUR_CHARACTERS",
      });
      const code = toSafeReasonCode(err);
      expect(code.length).toBeLessThanOrEqual(64);
      expect(/^[a-zA-Z0-9_:-]+$/.test(code)).toBe(true);
    });
  });

  describe("3. Customer Error Message Mapping (reasonCodeToCustomerMessage)", () => {
    it("returns specific Arabic messages without generic opaque error for known reasons", () => {
      const planMsg = reasonCodeToCustomerMessage("plan_build_failed");
      expect(planMsg).toContain("تعذر إعداد خطة تسعير دقيقة للطلب");
      expect(planMsg).toContain("فيسبوك، لينكد إن، إكس");
      expect(planMsg).not.toContain("حدث خطأ أثناء معالجة المحادثة. يرجى المحاولة مرة أخرى.");

      const timeoutMsg = reasonCodeToCustomerMessage("timeout");
      expect(timeoutMsg).toContain("استغرقت معالجة الطلب وقتاً أطول من المتوقع");

      const catalogMsg = reasonCodeToCustomerMessage("catalog_unavailable");
      expect(catalogMsg).toContain("تعذر الاتصال بفهرس الخدمات حالياً");

      const llmMsg = reasonCodeToCustomerMessage("llm_failed");
      expect(llmMsg).toContain("واجه المساعد الذكي صعوبة في صياغة الرد");

      const rateMsg = reasonCodeToCustomerMessage("rate_limit_exceeded");
      expect(rateMsg).toContain("تم تجاوز الحد الأقصى المؤقت");
    });

    it("never leaks provider names or technical tokens in error messages", () => {
      const reasons = [
        "capability_not_found",
        "plan_build_failed",
        "catalog_unavailable",
        "llm_failed",
        "timeout",
        "rate_limit_exceeded",
        "database_unavailable",
        "internal_error",
      ];

      const forbiddenSubstrings = [
        "treg",
        "anthropic",
        "claude",
        "supabase",
        "appwrite",
        "crustdata",
        "apiKey",
        "token",
        "secret",
        "SELECT",
        "undefined",
        "null",
      ];

      for (const r of reasons) {
        const msg = reasonCodeToCustomerMessage(r, "raw TREG error from crustdata.companies.search");
        for (const f of forbiddenSubstrings) {
          expect(msg.toLowerCase()).not.toContain(f.toLowerCase());
        }
      }
    });
  });
});
