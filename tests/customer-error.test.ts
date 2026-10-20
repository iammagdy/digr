import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ChatRequestError, TEMPORARY_FAILURE_AR, TEMPORARY_FAILURE_NO_CHARGE_AR,
  customerFacingFailure, failureCode, isCustomerSafeArabic, readChatResponse, startFailureMessageAr,
} from "../src/lib/customerError";
import { DeadlineExceededError, withDeadline } from "../src/functions/shared/deadline";
import { reasonCodeToCustomerMessage, toSafeReasonCode } from "../src/functions/shared/chatErrors";

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("a failed request never shows English or technical text", () => {
  it("«Failed to fetch» (a dropped connection) becomes the Arabic temporary-failure sentence with a safe code", () => {
    const err = new TypeError("Failed to fetch");
    const failure = customerFacingFailure(err, { noCharge: true });
    expect(failure.text).toBe("حصل تعثر مؤقت، لم يُخصم أي رصيد، جرّب مرة أخرى.");
    expect(failure.text).toBe(TEMPORARY_FAILURE_NO_CHARGE_AR);
    expect(failure.code).toBe("network");
    expect(failure.text).not.toMatch(/[A-Za-z]/);
  });

  it("every browser and platform failure shape is covered: timeout, unreadable body, 5xx, Safari/Firefox wording", () => {
    const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    expect(customerFacingFailure(abort, { noCharge: true })).toEqual({ text: TEMPORARY_FAILURE_NO_CHARGE_AR, code: "client_timeout" });
    for (const message of ["Load failed", "NetworkError when attempting to fetch resource.", "Network request failed"]) {
      expect(customerFacingFailure(new TypeError(message), { noCharge: true }).text).toBe(TEMPORARY_FAILURE_NO_CHARGE_AR);
    }
    expect(customerFacingFailure(new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"), { noCharge: true })).toEqual({ text: TEMPORARY_FAILURE_NO_CHARGE_AR, code: "bad_response" });
    expect(customerFacingFailure(new ChatRequestError("حدث خطأ أثناء معالجة المحادثة. يرجى المحاولة مرة أخرى.", 500, "internal_error"), { noCharge: true }).text).toBe(TEMPORARY_FAILURE_NO_CHARGE_AR);
    expect(customerFacingFailure(new ChatRequestError("", 504, "deadline_exceeded"), { noCharge: true })).toEqual({ text: TEMPORARY_FAILURE_NO_CHARGE_AR, code: "server:deadline_exceeded" });
    expect(customerFacingFailure(new Error("Cannot read properties of undefined (reading 'x')"), { noCharge: true }).text).toBe(TEMPORARY_FAILURE_NO_CHARGE_AR);
  });

  it("a message the server wrote for the customer (a 4xx in clean Arabic) passes through; English, ids and placeholders never do", () => {
    const wait = "تم تجاوز الحد الأقصى المؤقت للطلبات. يرجى الانتظار دقيقة والمحاولة مجدداً.";
    expect(customerFacingFailure(new ChatRequestError(wait, 429, "rate_limit_exceeded"), { noCharge: true }).text).toBe(wait);
    expect(customerFacingFailure(new ChatRequestError("Unauthorized", 401), { noCharge: true }).text).toBe(TEMPORARY_FAILURE_NO_CHARGE_AR);
    expect(customerFacingFailure(new ChatRequestError("فشل job_quote_abc123", 400), { noCharge: true }).text).toBe(TEMPORARY_FAILURE_NO_CHARGE_AR);
    expect(customerFacingFailure(new ChatRequestError("حدث خطأ undefined", 400), { noCharge: true }).text).toBe(TEMPORARY_FAILURE_NO_CHARGE_AR);
    expect(isCustomerSafeArabic("جرّب مرة أخرى")).toBe(true);
    expect(isCustomerSafeArabic("Failed to fetch")).toBe(false);
    expect(isCustomerSafeArabic("")).toBe(false);
    expect(isCustomerSafeArabic(undefined)).toBe(false);
  });

  it("the fallback used by actions that may touch the balance never promises «لم يُخصم»", () => {
    const failure = customerFacingFailure(new TypeError("Failed to fetch"));
    expect(failure.text).toBe(TEMPORARY_FAILURE_AR);
    expect(failure.text).not.toContain("لم يُخصم");
    // A failed start no longer blames the balance: only the server's own insufficient-balance sentence does (next line).
    expect(startFailureMessageAr(new TypeError("Failed to fetch"))).toBe("حصل تعثر مؤقت أثناء بدء الطلب. افتح «طلباتي» لتعرف إن كان قد بدأ؛ ولا يُخصم رصيد إلا مقابل ما يُسلَّم.");
    expect(startFailureMessageAr(new TypeError("Failed to fetch"))).not.toContain("رصيدك في المحفظة");
    expect(startFailureMessageAr(new ChatRequestError("الرصيد غير كافٍ لبدء هذه المهمة.", 402))).toBe("تعذر بدء الاستخراج: الرصيد غير كافٍ لبدء هذه المهمة.");
  });

  it("the code is safe to log: it never carries the message text", () => {
    expect(failureCode(new ChatRequestError("نص عربي", 400))).toBe("client_400");
    expect(failureCode(new ChatRequestError("x", 500))).toBe("server_500");
    expect(failureCode(new ChatRequestError("x", 500, "llm failed!"))).toBe("server:llm_failed_");
    expect(failureCode("string error")).toBe("unknown");
    expect(failureCode(null)).toBe("unknown");
  });

  it("readChatResponse: a platform error page (not JSON) is a coded failure, and a failed JSON keeps status and reason", async () => {
    await expect(readChatResponse(new Response("<html>An error occurred</html>", { status: 504 }))).rejects.toMatchObject({ status: 504, reason: "bad_response" });
    await expect(readChatResponse(jsonResponse({ success: false, error: "تعذر", reason: "catalog_unavailable" }, 500))).rejects.toMatchObject({ status: 500, reason: "catalog_unavailable" });
    await expect(readChatResponse(jsonResponse({ success: true, contentAr: "تمام" }))).resolves.toMatchObject({ contentAr: "تمام" });
    await expect(readChatResponse(jsonResponse({ success: false }, 200))).rejects.toBeInstanceOf(ChatRequestError);
  });
});

describe("the server answers before the platform kills the function", () => {
  it("rejects with a coded 504 error at the deadline, even though the work is still running", async () => {
    vi.useFakeTimers();
    try {
      let finish: (value: string) => void = () => undefined;
      const work = new Promise<string>((resolve) => { finish = resolve; });
      const raced = withDeadline(work, 50_000, "chat_handler");
      const assertion = expect(raced).rejects.toBeInstanceOf(DeadlineExceededError);
      await vi.advanceTimersByTimeAsync(50_000);
      await assertion;
      finish("late");
      await expect(raced).rejects.toMatchObject({ reasonCode: "deadline_exceeded", statusCode: 504 });
    } finally { vi.useRealTimers(); }
  });

  it("returns the work's value when it finishes first, and a late failure is not an unhandled rejection", async () => {
    await expect(withDeadline(Promise.resolve(7), 1_000, "x")).resolves.toBe(7);
    vi.useFakeTimers();
    try {
      let fail: (error: Error) => void = () => undefined;
      const work = new Promise<string>((_, reject) => { fail = reject; });
      const raced = withDeadline(work, 100, "x");
      const assertion = expect(raced).rejects.toBeInstanceOf(DeadlineExceededError);
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      fail(new Error("late failure"));
      await vi.advanceTimersByTimeAsync(10);
    } finally { vi.useRealTimers(); }
  });

  it("the deadline is a known reason code with the same Arabic sentence, and the route uses it below the platform limit", () => {
    const err = new DeadlineExceededError("chat_handler", 50_000);
    expect(toSafeReasonCode(err, "chat_handler")).toBe("deadline_exceeded");
    expect(reasonCodeToCustomerMessage("deadline_exceeded")).toBe(TEMPORARY_FAILURE_NO_CHARGE_AR);
    const route = readFileSync("src/app/api/chat/route.ts", "utf8");
    expect(route).toContain("const CHAT_DEADLINE_MS = 50_000");
    expect(route).toMatch(/withDeadline\(chatHandler\.handleUserMessage\(/);
    expect(route).toContain("export const maxDuration = 60");
  });
});

describe("the chat page never prints an error message of its own", () => {
  const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
  it("every catch site goes through the customer-safe helper and keeps its retry button", () => {
    expect(page).not.toMatch(/content: (err|error)\??\.message/);
    expect(page).not.toContain("`تعذر بدء الاستخراج: ${err.message}`");
    expect(page).toContain("readChatResponse(res)");
    expect(page).toContain("errorRetryPrompt: textToSend");
    expect(page).toContain("retryClarification: { assistantMessageId, answers }");
    expect(page).toContain("logClientFailure(\"send\", failure.code)");
    expect(page).toContain("logClientFailure(\"answers\", failure.code)");
  });
});
