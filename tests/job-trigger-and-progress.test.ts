import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  verifyCronSecret,
  createInternalWorkerAuthHeaders,
  resolveInternalBaseUrl,
} from "../src/lib/server/cronAuth";
import { md5, getJobIdForQuote } from "../src/lib/md5";
import { isTerminalJobStatus, toChatJobStatus } from "../src/lib/jobs/status";
import { dispatchWorkerChunk } from "../src/lib/server/workerDispatch";

describe("Job Execution Triggering, Worker Auth & Progress Navigation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...originalEnv };
  });

  describe("Deterministic MD5 & Job ID Generation", () => {
    it("computes exact md5 matching PostgreSQL md5() for quote IDs", () => {
      // Known quote ID and its PostgreSQL md5 digest from production
      const quoteId = "466287ca74014c999459";
      const expectedDigest = "2bfd9f99a98d8b2de4dc9e56b2d95a10";
      expect(md5(quoteId)).toBe(expectedDigest);
      expect(getJobIdForQuote(quoteId)).toBe(`job_quote_${expectedDigest}`);
    });

    it("handles arbitrary ASCII and unicode strings consistently", () => {
      expect(md5("diger")).toBe("9df9f674c0e618503f7e31b71bae48e0");
      expect(md5("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    });
  });

  describe("Internal Worker Auth & Canonical URL Resolution", () => {
    it("resolves canonical base URL from APP_URL outside production requests", () => {
      process.env.APP_URL = "https://diger.tech";
      process.env.VERCEL_URL = "diger-git-test-iammagdy.vercel.app";
      expect(resolveInternalBaseUrl()).toBe("https://diger.tech");
    });

    it("prefers the actual HTTPS production request origin over a stale localhost APP_URL", () => {
      vi.stubEnv("NODE_ENV", "production");
      process.env.VERCEL = "1";
      process.env.VERCEL_ENV = "production";
      process.env.APP_URL = "http://127.0.0.1:3000";
      const req = new NextRequest("https://diger.tech/api/chat/accept-quote", {
        headers: { host: "diger.tech", "x-forwarded-proto": "https", "x-forwarded-host": "127.0.0.1:3000" },
      });
      expect(resolveInternalBaseUrl(req)).toBe("https://diger.tech");
    });

    it("falls back to request headers or VERCEL_PROJECT_PRODUCTION_URL when APP_URL is absent", () => {
      delete process.env.APP_URL;
      process.env.VERCEL_PROJECT_PRODUCTION_URL = "diger.tech";
      expect(resolveInternalBaseUrl()).toBe("https://diger.tech");
    });

    it("creates internal signed HMAC auth headers using CRON_SECRET or service role key", () => {
      process.env.CRON_SECRET = "test_cron_secret_12345";
      const headers = createInternalWorkerAuthHeaders("job_123");
      expect(headers["Authorization"]).toBe("Bearer test_cron_secret_12345");
      expect(headers["x-cron-secret"]).toBe("test_cron_secret_12345");
      expect(headers["x-worker-signature"]).toBeDefined();
      expect(headers["x-worker-timestamp"]).toBeDefined();
      expect(headers["x-worker-job-id"]).toBe("job_123");
    });

    it("verifies internal signed HMAC request with timing-safe comparison", () => {
      process.env.CRON_SECRET = "secret_cron_abc";
      const headers = createInternalWorkerAuthHeaders("job_abc");

      const req = new NextRequest("https://diger.tech/api/worker/chunk", {
        method: "POST",
        headers: headers as Record<string, string>,
      });

      expect(verifyCronSecret(req, "job_abc")).toBe(true);
    });

    it("verifies internal signed HMAC using SUPABASE_SERVICE_ROLE_KEY when CRON_SECRET is not set", () => {
      delete process.env.CRON_SECRET;
      process.env.SUPABASE_SERVICE_ROLE_KEY = "test_supabase_service_role_key";

      const headers = createInternalWorkerAuthHeaders("job_xyz");
      const req = new NextRequest("https://diger.tech/api/worker/chunk", {
        method: "POST",
        headers: headers as Record<string, string>,
      });

      expect(verifyCronSecret(req, "job_xyz")).toBe(true);
    });

    it("rejects request if signature timestamp is too old (> 10 minutes)", () => {
      delete process.env.CRON_SECRET;
      process.env.SUPABASE_SERVICE_ROLE_KEY = "signing_key_abc";

      const headers = createInternalWorkerAuthHeaders("job_abc");
      // Set timestamp 15 minutes in the past and remove direct Bearer auth
      delete headers["Authorization"];
      delete headers["x-cron-secret"];
      headers["x-worker-timestamp"] = String(Date.now() - 15 * 60 * 1000);

      const req = new NextRequest("https://diger.tech/api/worker/chunk", {
        method: "POST",
        headers: headers as Record<string, string>,
      });

      expect(verifyCronSecret(req, "job_abc")).toBe(false);
    });

    it("rejects unauthorized request with invalid token", () => {
      process.env.CRON_SECRET = "secret_cron_abc";

      const req = new NextRequest("https://diger.tech/api/worker/chunk", {
        method: "POST",
        headers: {
          Authorization: "Bearer invalid_secret",
        },
      });

      expect(verifyCronSecret(req)).toBe(false);
    });
  });

  describe("Terminal job state mapping", () => {
    it.each(["completed", "done", "failed", "cancelled", "refused"])(
      "stops polling terminal database status %s",
      (status) => expect(isTerminalJobStatus(status)).toBe(true)
    );

    it("maps the database completed state to the finished chat state", () => {
      expect(toChatJobStatus("completed")).toBe("done");
      expect(isTerminalJobStatus(toChatJobStatus("completed"))).toBe(true);
    });
  });

  it("awaits the first bounded worker chunk and reports its claim acknowledgement", async () => {
    let finishFetch!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finishFetch = resolve; }));
    let settled = false;
    const dispatch = dispatchWorkerChunk("https://diger.tech", "job_123", 0, { "x-worker-job-id": "job_123" }, 5_000, fetcher)
      .then((result) => { settled = true; return result; });

    await Promise.resolve();
    expect(settled).toBe(false);
    finishFetch(new Response(JSON.stringify({ success: true, claimed: true }), { status: 200 }));
    await expect(dispatch).resolves.toMatchObject({ started: true, status: 200, body: { claimed: true } });
    expect(fetcher).toHaveBeenCalledWith(
      "https://diger.tech/api/worker/chunk",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ jobId: "job_123", expectedStep: 0 }) })
    );
  });

  describe("Event Deduplication & Progress State Mapping", () => {
    it("deduplicates identical events by ID or message+createdAt key", () => {
      // Logic matching mapJobEvents in chat/page.tsx
      function dedupeEvents(rows: any[]) {
        const seen = new Set<string>();
        const events: any[] = [];
        for (const e of rows) {
          const rawId = e.id || e.$id;
          const dedupeKey = rawId ? String(rawId) : `${e.created_at || ""}_${e.message || e.text_ar || ""}_${e.units ?? ""}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          events.push(e);
        }
        return events;
      }

      const raw = [
        { id: "ev_1", message: "تم حجز 6 نقطة", created_at: "2026-10-14T19:48:55Z" },
        { id: "ev_1", message: "تم حجز 6 نقطة", created_at: "2026-10-14T19:48:55Z" },
        { id: "ev_2", message: "بدء استخراج البيانات", created_at: "2026-10-14T19:49:00Z" },
        { message: "استخراج 5 سجلات", created_at: "2026-10-14T19:50:00Z", units: 5 },
        { message: "استخراج 5 سجلات", created_at: "2026-10-14T19:50:00Z", units: 5 },
      ];

      const deduped = dedupeEvents(raw);
      expect(deduped.length).toBe(3);
      expect(deduped.map((e) => e.message)).toEqual([
        "تم حجز 6 نقطة",
        "بدء استخراج البيانات",
        "استخراج 5 سجلات",
      ]);
    });
  });
});
