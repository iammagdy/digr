import { afterEach, describe, expect, it, vi } from "vitest";
import { sendPlatformEmail } from "../src/lib/server/sendPlatformEmail";
import { buildResendHeaders } from "../supabase/functions/send-email/resendHeaders";

describe("transactional Resend mail adapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("forwards a stable job/top-up idempotency key and Arabic receipt fields without blocking", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only-key");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await sendPlatformEmail("topup-approved", "customer@example.test", {
      Name: "باحث", ConfirmedAmountEgp: "١٠٠", Credits: "١٠٠٠", Balance: "١٢٠٠", Reference: "REF-١",
    }, "topup-approved:top_123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ idempotencyKey: "topup-approved:top_123", template: "topup-approved" });
    expect(JSON.parse(String(request.body)).vars).toMatchObject({ ConfirmedAmountEgp: "١٠٠", Credits: "١٠٠٠", Balance: "١٢٠٠" });
    expect(buildResendHeaders("test-only-key", "topup-approved:top_123")["Idempotency-Key"]).toBe("topup-approved:top_123");

    const failedSend = vi.fn().mockRejectedValue(new Error("network failure"));
    vi.stubGlobal("fetch", failedSend);
    await expect(sendPlatformEmail("job-done", "customer@example.test", { JobTitle: "بحث الشركات" }, "job-done:job_456")).resolves.toBeUndefined();
  });
});
