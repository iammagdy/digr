import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailFailureReason, sendPlatformEmail } from "../src/lib/server/sendPlatformEmail";

describe("12. platform emails: verified sender, RESEND_API_KEY, idempotent, never blocking", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service_key_for_tests";
  });
  afterEach(() => vi.restoreAllMocks());

  it("the sender is on the verified diger.tech domain and the key comes from RESEND_API_KEY", () => {
    const fn = readFileSync("supabase/functions/send-email/index.ts", "utf8");
    expect(fn).toContain('const FROM = "Diger <noreply@diger.tech>"');
    expect(fn).toContain('Deno.env.get("RESEND_API_KEY")');
    expect(fn).toContain("buildResendHeaders(resendKey, input.idempotencyKey)");
    expect(readFileSync("supabase/functions/send-email/resendHeaders.ts", "utf8")).toContain('"Idempotency-Key"');
  });

  it("job-finished and top-up-approved emails carry a deterministic idempotency key, so a retry sends once", () => {
    const worker = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    const approve = readFileSync("src/app/api/admin/topups/approve/route.ts", "utf8");
    expect(worker).toContain("`job-done:${jobId}`");
    expect(approve).toContain("`topup-approved:${topupId}`");
  });

  it("the job-finished email is sent after settlement and inside its own try/catch, so it can never block it", () => {
    const worker = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    const settle = worker.indexOf('"settle_job_atomic"');
    const email = worker.indexOf('sendPlatformEmail("job-done"');
    expect(settle).toBeGreaterThan(-1);
    expect(email).toBeGreaterThan(settle);
    const block = worker.slice(worker.lastIndexOf("try {", email), worker.indexOf('console.error("[email:job-done_failed]"', email));
    expect(block).toContain("getRecipient");
    expect(worker.slice(email, email + 900)).toContain("catch (emailErr)");
    const approve = readFileSync("src/app/api/admin/topups/approve/route.ts", "utf8");
    const approvedAt = approve.indexOf("approve_topup_atomic");
    expect(approve.indexOf('sendPlatformEmail("topup-approved"')).toBeGreaterThan(approvedAt);
    expect(approve).toContain('console.error("[email:topup-approved_failed]"');
  });

  it("a send that fails never throws and reports a fixed safe reason code", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: Array<[() => Response | Promise<never>, string]> = [
      [() => new Response(JSON.stringify({ ok: false, error: "resend_not_configured" }), { status: 500 }), "resend_not_configured"],
      [() => new Response(JSON.stringify({ ok: false, error: "resend_rejected", status: 422 }), { status: 502 }), "resend_rejected"],
      [() => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 }), "unauthorized"],
      [() => new Response("<html>gateway</html>", { status: 503 }), "function_unavailable"],
      [() => Promise.reject(Object.assign(new Error("secret host details"), { name: "TimeoutError" })), "timeout"],
      [() => Promise.reject(new Error("ECONNRESET to https://secret")), "network_error"],
    ];
    for (const [response, reason] of cases) {
      vi.spyOn(globalThis, "fetch").mockImplementationOnce((async () => response()) as any);
      const result = await sendPlatformEmail("job-done", "customer@example.com", { Name: "x" }, "job-done:job_1");
      expect(result).toEqual({ ok: false, reason });
    }
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("reason=resend_not_configured");
    expect(logged).not.toContain("customer@example.com");
    expect(logged).not.toContain("service_key_for_tests");
    expect(logged).not.toContain("secret");
  });

  it("success reports ok and sends the idempotency key to the function", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true, id: "m1" }), { status: 200 }));
    const result = await sendPlatformEmail("topup-approved", "customer@example.com", { Name: "x" }, "topup-approved:t1");
    expect(result).toEqual({ ok: true });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body);
    expect(body.idempotencyKey).toBe("topup-approved:t1");
  });

  it("unknown function errors map to a fixed code, never to raw text", () => {
    expect(emailFailureReason(500, "something with a key sk_live_123")).toBe("function_unavailable");
    expect(emailFailureReason(401, undefined)).toBe("unauthorized");
    expect(emailFailureReason(502, "resend_rejected")).toBe("resend_rejected");
  });
});
