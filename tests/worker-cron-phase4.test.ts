import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { verifyCronSecret } from "../src/lib/server/cronAuth";
import fs from "node:fs";
import path from "node:path";

const mockNudgeDb = vi.hoisted(() => ({
  user: null as any,
  jobs: [] as any[],
}));

const mockWorkerDb = vi.hoisted(() => ({
  recordedFailures: [] as any[],
  releasedJobs: [] as any[],
  settledJobs: [] as any[],
  committedCosts: [] as any[],
  artifactVersions: [] as any[],
  uploadedBodies: new Map<string, Buffer>(),
  failResultsUpload: false,
  failPartialsUpload: false,
  failArtifactVersions: false,
  failPartialsDownload: false,
  corruptPartialsData: false,
  mismatchDeliveredUnits: false,
  denyDailyCap: false,
  failReleaseJobAtomic: false,
  releaseJobAtomicError: null as any,
  completeChunkOverride: null as any,
  jobStatusOverride: null as string | null,
  step: 0,
  currentCursor: null as string | null,
  deliveredUnits: 0,
  targetVolumeMax: 20,
  unitPrice: 2,
  reservedCredits: 46,
  settled: false,
  notifications: [] as any[],
  uploads: [] as { bucket: string; path: string }[],
}));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async (token?: string) => {
        if (token === "token_user_1") {
          return { data: { user: { id: "user_owner_1" } }, error: null };
        }
        if (token === "token_user_2") {
          return { data: { user: { id: "user_intruder_2" } }, error: null };
        }
        return { data: { user: mockNudgeDb.user }, error: null };
      }),
    },
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn((col: string, val: string) => ({
          maybeSingle: vi.fn(async () => {
            const found = mockNudgeDb.jobs.find((j) => j.id === val);
            return { data: found || null, error: null };
          }),
        })),
      })),
    })),
  })),
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async (rpcName: string, args: any) => {
      if (rpcName === "claim_job_chunk") {
        return {
          data: {
            claimed: true,
            job_id: args.p_job_id,
            user_id: "user_worker_1",
            step: mockWorkerDb.step,
            current_cursor: mockWorkerDb.currentCursor ?? `cursor_${mockWorkerDb.step}`,
            delivered_units: mockWorkerDb.deliveredUnits,
            target_volume_max: mockWorkerDb.targetVolumeMax,
            target_volume_min: 1,
            endpoint_id: "tiktok-profile",
            unit_price: mockWorkerDb.unitPrice,
          },
          error: null,
        };
      }
      if (rpcName === "release_job_atomic") {
        if (mockWorkerDb.failReleaseJobAtomic) {
          return {
            data: null,
            error: mockWorkerDb.releaseJobAtomicError || {
              message: "simulated_release_job_atomic_rpc_failure",
            },
          };
        }
        mockWorkerDb.releasedJobs.push(args);
        return {
          data: {
            success: true,
            job_id: args.p_job_id,
            released_credits: mockWorkerDb.reservedCredits,
            charged_credits: 0,
          },
          error: null,
        };
      }
      if (rpcName === "reserve_provider_spend_atomic") {
        if (mockWorkerDb.denyDailyCap) {
          return { data: { allowed: false, reason: "daily_cap_exceeded" }, error: null };
        }
        return { data: { allowed: true, cost_id: 101 + mockWorkerDb.step }, error: null };
      }
      if (rpcName === "commit_provider_spend") {
        mockWorkerDb.committedCosts.push(args);
        return { data: { success: true }, error: null };
      }
      if (rpcName === "complete_chunk") {
        if (mockWorkerDb.completeChunkOverride !== null) {
          return mockWorkerDb.completeChunkOverride;
        }
        mockWorkerDb.step += 1;
        mockWorkerDb.currentCursor = args.p_new_cursor;
        mockWorkerDb.deliveredUnits = mockWorkerDb.mismatchDeliveredUnits
          ? args.p_new_delivered_units + 5
          : args.p_new_delivered_units;
        return {
          data: {
            success: true,
            delivered_units: mockWorkerDb.deliveredUnits,
          },
          error: null,
        };
      }
      if (rpcName === "settle_job_atomic") {
        mockWorkerDb.settled = true;
        const rawCharge = Math.ceil(mockWorkerDb.deliveredUnits * mockWorkerDb.unitPrice);
        const charged = Math.min(rawCharge, mockWorkerDb.reservedCredits, args.p_points_cap ?? 600);
        const released = Math.max(0, mockWorkerDb.reservedCredits - charged);
        const settleResult = {
          success: true,
          job_id: args.p_job_id,
          delivered_units: mockWorkerDb.deliveredUnits,
          charged_credits: charged,
          released_credits: released,
        };
        mockWorkerDb.settledJobs.push({ args, result: settleResult });
        return { data: settleResult, error: null };
      }
      if (rpcName === "record_chunk_failure") {
        mockWorkerDb.recordedFailures.push(args);
        return { data: { success: true, status: "retrying", attempt_count: 1 }, error: null };
      }
      return { data: null, error: null };
    }),
    storage: {
      from: vi.fn((bucket: string) => ({
        upload: vi.fn(async (storagePath: string, body: any) => {
          if (bucket === "partials" && mockWorkerDb.failPartialsUpload && storagePath.includes("step_")) {
            return { data: null, error: { message: "simulated_partials_upload_failure" } };
          }
          if (bucket === "results" && mockWorkerDb.failResultsUpload) {
            return { data: null, error: { message: "simulated_results_upload_failure" } };
          }
          mockWorkerDb.uploads.push({ bucket, path: storagePath });
          if (body) {
            const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf-8");
            mockWorkerDb.uploadedBodies.set(`${bucket}:${storagePath}`, buf);
          }
          return { data: { path: storagePath }, error: null };
        }),
        download: vi.fn(async (storagePath: string) => {
          if (bucket === "partials" && mockWorkerDb.failPartialsDownload) {
            return { data: null, error: { message: "simulated_partials_download_failure" } };
          }
          if (bucket === "partials" && mockWorkerDb.corruptPartialsData) {
            return {
              data: new Blob([new Uint8Array(Buffer.from("invalid-corrupt-json", "utf-8"))]),
              error: null,
            };
          }
          const buf = mockWorkerDb.uploadedBodies.get(`${bucket}:${storagePath}`);
          if (!buf) return { data: null, error: { message: "not_found" } };
          return {
            data: new Blob([new Uint8Array(buf)]),
            error: null,
          };
        }),
        remove: vi.fn(async (paths: string[]) => {
          for (const p of paths) {
            mockWorkerDb.uploadedBodies.delete(`${bucket}:${p}`);
          }
          return { data: paths, error: null };
        }),
      })),
    },
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn((col: string, val: string) => ({
          maybeSingle: vi.fn(async () => {
            return {
              data: {
                id: val,
                status: mockWorkerDb.jobStatusOverride || "running",
                charged_credits: 0,
                delivered_units: mockWorkerDb.deliveredUnits,
                current_cursor: mockWorkerDb.currentCursor,
                target_volume_max: mockWorkerDb.targetVolumeMax,
              },
              error: null,
            };
          }),
        })),
      })),
      insert: vi.fn(async (row: any) => {
        if (table === "notifications") {
          mockWorkerDb.notifications.push(row);
        }
        if (table === "artifact_versions") {
          if (mockWorkerDb.failArtifactVersions) {
            return { data: null, error: { message: "simulated_artifact_versions_error", code: "PGRST_ERROR" } };
          }
          mockWorkerDb.artifactVersions.push(row);
        }
        return { data: row, error: null };
      }),
      upsert: vi.fn(async (row: any) => {
        if (table === "artifact_versions") {
          if (mockWorkerDb.failArtifactVersions) {
            return { data: null, error: { message: "simulated_artifact_versions_error", code: "PGRST_ERROR" } };
          }
          mockWorkerDb.artifactVersions.push(row);
        }
        return { data: row, error: null };
      }),
    })),
  })),
}));

describe("Phase 4: Cron Auth & Hobby Design B Tests", () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "super-secret-cron-key-12345";
    mockNudgeDb.user = null;
    mockNudgeDb.jobs = [
      {
        id: "job_owned_by_user_1",
        user_id: "user_owner_1",
        status: "queued",
        step: 0,
        lease_until: null,
        next_attempt_at: null,
      },
    ];
  });

  afterAll(() => {
    process.env.CRON_SECRET = originalCronSecret;
  });

  describe("cronAuth (Timing-Safe Authentication)", () => {
    it("should accept valid secret via Bearer Authorization header", () => {
      const req = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        headers: {
          authorization: "Bearer super-secret-cron-key-12345",
        },
      });
      expect(verifyCronSecret(req)).toBe(true);
    });

    it("should accept valid secret via x-cron-secret header", () => {
      const req = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        headers: {
          "x-cron-secret": "super-secret-cron-key-12345",
        },
      });
      expect(verifyCronSecret(req)).toBe(true);
    });

    it("should reject invalid secret token", () => {
      const req = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        headers: {
          authorization: "Bearer wrong-secret-key",
        },
      });
      expect(verifyCronSecret(req)).toBe(false);
    });

    it("should reject different length secret token without timing leak", () => {
      const req = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        headers: {
          authorization: "Bearer short",
        },
      });
      expect(verifyCronSecret(req)).toBe(false);
    });

    it("should reject when no token is provided (missing header)", () => {
      const req = new NextRequest("http://127.0.0.1:3000/api/worker/chunk");
      expect(verifyCronSecret(req)).toBe(false);
    });

    it("should fail closed if env CRON_SECRET is unset", () => {
      delete process.env.CRON_SECRET;
      const req = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        headers: {
          authorization: "Bearer super-secret-cron-key-12345",
        },
      });
      expect(verifyCronSecret(req)).toBe(false);
    });

    it("should fail closed if env CRON_SECRET is an empty string (no empty-string match)", () => {
      process.env.CRON_SECRET = "";
      const req = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        headers: {
          authorization: "Bearer ",
        },
      });
      expect(verifyCronSecret(req)).toBe(false);

      const req2 = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        headers: {
          "x-cron-secret": "",
        },
      });
      expect(verifyCronSecret(req2)).toBe(false);
    });
  });

  describe("vercel.json Configuration (Hobby Constraints)", () => {
    it("should have valid vercel.json respecting Hobby single-daily cron limit", () => {
      const vercelJsonPath = path.resolve(process.cwd(), "vercel.json");
      expect(fs.existsSync(vercelJsonPath)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(vercelJsonPath, "utf8"));
      expect(Array.isArray(parsed.crons)).toBe(true);
      // Hobby allows at most 1 cron schedule per day
      expect(parsed.crons.length).toBe(1);
      expect(parsed.crons[0].path).toBe("/api/cron/watchdog");
      expect(parsed.crons[0].schedule).toBe("0 0 * * *"); // strictly once daily

      // Verify maxDuration <= 60s (Hobby limit)
      if (parsed.functions) {
        for (const [fnPath, config] of Object.entries(parsed.functions)) {
          expect((config as any).maxDuration).toBeLessThanOrEqual(60);
        }
      }
    });
  });

  describe("Worker & Cron Routes Export Invariants & Auth Enforcement", () => {
    it("should enforce 401 when worker chunk is called without valid CRON_SECRET", async () => {
      const chunkRoute = await import("../src/app/api/worker/chunk/route");
      expect(chunkRoute.dynamic).toBe("force-dynamic");
      expect(chunkRoute.maxDuration).toBeLessThanOrEqual(60);

      const req = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        method: "POST",
        headers: { authorization: "Bearer invalid_secret" },
      });
      const res = await chunkRoute.POST(req);
      expect(res.status).toBe(401);
    });

    it("should enforce 401 when watchdog is called without valid CRON_SECRET", async () => {
      const watchdogRoute = await import("../src/app/api/cron/watchdog/route");
      expect(watchdogRoute.dynamic).toBe("force-dynamic");
      expect(watchdogRoute.maxDuration).toBeLessThanOrEqual(60);

      const req = new NextRequest("http://127.0.0.1:3000/api/cron/watchdog", {
        method: "GET",
        headers: { authorization: "Bearer invalid_secret" },
      });
      const res = await watchdogRoute.GET(req);
      expect(res.status).toBe(401);
    });

    it("should enforce nudge authorization: rejects unauthenticated caller with 401", async () => {
      const nudgeRoute = await import("../src/app/api/jobs/[id]/nudge/route");
      const req = new NextRequest("http://127.0.0.1:3000/api/jobs/job_owned_by_user_1/nudge", {
        method: "POST",
      });
      const res = await nudgeRoute.POST(req, {
        params: Promise.resolve({ id: "job_owned_by_user_1" }),
      });
      expect(res.status).toBe(401);
    });

    it("should enforce nudge authorization: rejects another user's job with 403", async () => {
      const nudgeRoute = await import("../src/app/api/jobs/[id]/nudge/route");
      const req = new NextRequest("http://127.0.0.1:3000/api/jobs/job_owned_by_user_1/nudge", {
        method: "POST",
        headers: { authorization: "Bearer token_user_2" }, // user_intruder_2
      });
      const res = await nudgeRoute.POST(req, {
        params: Promise.resolve({ id: "job_owned_by_user_1" }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain("لا يمكنك تنشيط مهمة لا تملكها");
    });

    it("should enforce nudge rate limiting: rapid successive calls return 429", async () => {
      const originalVercelEnv = process.env.VERCEL_ENV;
      process.env.VERCEL_ENV = "development";
      const nudgeRoute = await import("../src/app/api/jobs/[id]/nudge/route");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true, claimed: true }), { status: 200 })
      );
      const req1 = new NextRequest("http://127.0.0.1:3000/api/jobs/job_owned_by_user_1/nudge", {
        method: "POST",
        headers: { authorization: "Bearer token_user_1" },
      });
      const res1 = await nudgeRoute.POST(req1, {
        params: Promise.resolve({ id: "job_owned_by_user_1" }),
      });
      expect(res1.status).toBe(200);

      // Rapid immediate second call on the same job
      const req2 = new NextRequest("http://127.0.0.1:3000/api/jobs/job_owned_by_user_1/nudge", {
        method: "POST",
        headers: { authorization: "Bearer token_user_1" },
      });
      const res2 = await nudgeRoute.POST(req2, {
        params: Promise.resolve({ id: "job_owned_by_user_1" }),
      });
      expect(res2.status).toBe(429);
      const json2 = await res2.json();
      expect(json2.error).toContain("تم تنشيط المهمة مؤخراً");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
      if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = originalVercelEnv;
    });

    it("atomically releases a queued zero-attempt reservation after 60 seconds", async () => {
      mockWorkerDb.releasedJobs = [];
      mockNudgeDb.jobs = [{
        id: "job_zero_attempt_timeout",
        user_id: "user_owner_1",
        status: "queued",
        step: 0,
        attempt_count: 0,
        created_at: new Date(Date.now() - 61_000).toISOString(),
        lease_until: null,
        next_attempt_at: null,
      }];
      const nudgeRoute = await import("../src/app/api/jobs/[id]/nudge/route");
      const req = new NextRequest("https://diger.tech/api/jobs/job_zero_attempt_timeout/nudge", {
        method: "POST",
        headers: { authorization: "Bearer token_user_1" },
      });
      const res = await nudgeRoute.POST(req, {
        params: Promise.resolve({ id: "job_zero_attempt_timeout" }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ released: true, status: "failed" });
      expect(mockWorkerDb.releasedJobs).toEqual([{
        p_job_id: "job_zero_attempt_timeout",
        p_error_message: "تعذر بدء التنفيذ خلال دقيقة. تم إلغاء الطلب وإرجاع كامل النقاط المحجوزة.",
      }]);
    });
  });

  describe("Security Guarantee: Service Role Key Never Reaches Client Code", () => {
    it("proves client-side files never import or reference SUPABASE_SERVICE_ROLE_KEY", () => {
      const clientFiles = [
        "src/lib/supabase/client.ts",
        "src/hooks/useUser.tsx",
        "src/hooks/useBalance.tsx",
        "src/hooks/useNotifications.ts",
        "src/hooks/useCreditValue.ts",
      ];
      for (const f of clientFiles) {
        const content = fs.readFileSync(path.resolve(process.cwd(), f), "utf8");
        expect(content).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      }
    });
  });

  describe("Mock Provider Production Injection Guard & Route Execution", () => {
    it("strictly rejects fake provider injection when NODE_ENV is production OR ENABLE_MOCK_PROVIDER is not true with 403", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableMock = process.env.ENABLE_MOCK_PROVIDER;
      try {
        (process.env as any).NODE_ENV = "production";
        process.env.ENABLE_MOCK_PROVIDER = "true";
        const workerRoute = await import("../src/app/api/worker/chunk/route");
        const req = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
          method: "POST",
          headers: {
            authorization: "Bearer super-secret-cron-key-12345",
            "x-mock-provider": "true",
          },
          body: JSON.stringify({ jobId: "job_test_123", mockProvider: true }),
        });

        const res = await workerRoute.POST(req);
        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.error).toContain("حقن المزود الوهمي محظور في بيئة الإنتاج");

        // Also reject when NODE_ENV !== production if ENABLE_MOCK_PROVIDER !== "true"
        (process.env as any).NODE_ENV = "test";
        delete process.env.ENABLE_MOCK_PROVIDER;
        const reqNoFlag = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
          method: "POST",
          headers: {
            authorization: "Bearer super-secret-cron-key-12345",
            "x-mock-provider": "true",
          },
          body: JSON.stringify({ jobId: "job_test_123", mockProvider: true }),
        });
        const resNoFlag = await workerRoute.POST(reqNoFlag);
        expect(resNoFlag.status).toBe(403);
      } finally {
        (process.env as any).NODE_ENV = originalNodeEnv;
        process.env.ENABLE_MOCK_PROVIDER = originalEnableMock;
      }
    });

    it("successfully runs a 2-chunk job through the POST /api/worker/chunk route handler to settlement", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableMock = process.env.ENABLE_MOCK_PROVIDER;
      const originalVercelEnv = process.env.VERCEL_ENV;
      try {
        (process.env as any).NODE_ENV = "test";
        process.env.VERCEL_ENV = "development";
        process.env.ENABLE_MOCK_PROVIDER = "true";

        mockWorkerDb.step = 0;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.targetVolumeMax = 20;
        mockWorkerDb.settled = false;
        mockWorkerDb.notifications = [];
        mockWorkerDb.uploads = [];

        const workerRoute = await import("../src/app/api/worker/chunk/route");

        // Chunk 1 execution (step 0 -> processes 10 units, remaining 10)
        const reqChunk1 = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
          method: "POST",
          headers: {
            authorization: "Bearer super-secret-cron-key-12345",
            "x-mock-provider": "true",
          },
          body: JSON.stringify({ jobId: "job_multi_chunk_1", expectedStep: 0, mockProvider: true }),
        });

        const res1 = await workerRoute.POST(reqChunk1);
        expect(res1.status).toBe(200);
        const json1 = await res1.json();
        expect(json1.success).toBe(true);
        expect(json1.done).toBe(false);
        expect(json1.step).toBe(1);
        expect(json1.deliveredUnits).toBe(10);

        // Chunk 2 execution (step 1 -> processes remaining 10 units -> completes & settles)
        const reqChunk2 = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
          method: "POST",
          headers: {
            authorization: "Bearer super-secret-cron-key-12345",
            "x-mock-provider": "true",
          },
          body: JSON.stringify({ jobId: "job_multi_chunk_1", expectedStep: 1, mockProvider: true }),
        });

        const res2 = await workerRoute.POST(reqChunk2);
        expect(res2.status).toBe(200);
        const json2 = await res2.json();
        expect(json2.success).toBe(true);
        expect(json2.done).toBe(true);
        expect(json2.deliveredUnits).toBe(20);
        expect(json2.settle?.success).toBe(true);

        expect(mockWorkerDb.settled).toBe(true);
        expect(mockWorkerDb.notifications.length).toBe(1);
        expect(mockWorkerDb.notifications[0].title).toContain("اكتمل طلب استخراج البيانات بنجاح");
      } finally {
        (process.env as any).NODE_ENV = originalNodeEnv;
        process.env.ENABLE_MOCK_PROVIDER = originalEnableMock;
        if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = originalVercelEnv;
      }
    });

    it("records chunk failure and returns 500 when simulateProviderError is requested", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableMock = process.env.ENABLE_MOCK_PROVIDER;
      try {
        (process.env as any).NODE_ENV = "test";
        process.env.ENABLE_MOCK_PROVIDER = "true";
        mockWorkerDb.recordedFailures = [];
        mockWorkerDb.deliveredUnits = 0;

        const workerRoute = await import("../src/app/api/worker/chunk/route");
        const reqErr = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
          method: "POST",
          headers: {
            authorization: "Bearer super-secret-cron-key-12345",
            "x-mock-provider": "true",
          },
          body: JSON.stringify({
            jobId: "job_fail_test",
            expectedStep: 0,
            mockProvider: true,
            simulateProviderError: true,
          }),
        });

        const resErr = await workerRoute.POST(reqErr);
        expect(resErr.status).toBe(500);
        const jsonErr = await resErr.json();
        expect(jsonErr.success).toBe(false);
        expect(mockWorkerDb.recordedFailures.length).toBeGreaterThan(0);
        expect(mockWorkerDb.recordedFailures[0].p_job_id).toBe("job_fail_test");
      } finally {
        (process.env as any).NODE_ENV = originalNodeEnv;
        process.env.ENABLE_MOCK_PROVIDER = originalEnableMock;
      }
    });

    it("A1 Safety Guard: non-mock path never advances delivered_units or settles; releases job via release_job_atomic with zero charge", async () => {
      mockWorkerDb.step = 0;
      mockWorkerDb.deliveredUnits = 0;
      mockWorkerDb.settled = false;
      mockWorkerDb.releasedJobs = [];

      const workerRoute = await import("../src/app/api/worker/chunk/route");
      const reqNonMock = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        method: "POST",
        headers: {
          authorization: "Bearer super-secret-cron-key-12345",
        },
        body: JSON.stringify({
          jobId: "job_non_mock_safety_1",
          expectedStep: 0,
        }),
      });

      const res = await workerRoute.POST(reqNonMock);
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.released).toBe(true);
      expect(json.chargedCredits).toBe(0);
      expect(json.deliveredUnits).toBe(0);
      expect(json.error).toContain("استرداد كامل الرصيد المحجوز دون أي خصم");
      expect(mockWorkerDb.deliveredUnits).toBe(0);
      expect(mockWorkerDb.settled).toBe(false);
      expect(mockWorkerDb.releasedJobs).toHaveLength(1);
      expect(mockWorkerDb.releasedJobs[0]).toEqual({
        p_job_id: "job_non_mock_safety_1",
        p_error_message: expect.stringContaining("استرداد كامل الرصيد المحجوز دون أي خصم"),
        p_force: true,
      });
    });

    it("A3: handles a short last page and emits only the default Excel file in the result manifest", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableMock = process.env.ENABLE_MOCK_PROVIDER;
      const { setProviderAdapterForTesting } = await import("../src/lib/server/tregAdapter");
      try {
        (process.env as any).NODE_ENV = "test";
        process.env.ENABLE_MOCK_PROVIDER = "true";

        mockWorkerDb.step = 0;
        mockWorkerDb.currentCursor = null;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.targetVolumeMax = 15;
        mockWorkerDb.unitPrice = 1.5; // 13 * 1.5 = 19.5 -> ceil = 20
        mockWorkerDb.reservedCredits = 26;
        mockWorkerDb.settled = false;
        mockWorkerDb.settledJobs = [];
        mockWorkerDb.releasedJobs = [];
        mockWorkerDb.committedCosts = [];
        mockWorkerDb.artifactVersions = [];
        mockWorkerDb.notifications = [];
        mockWorkerDb.uploads = [];
        mockWorkerDb.uploadedBodies.clear();
        mockWorkerDb.failResultsUpload = false;
        mockWorkerDb.failPartialsUpload = false;
        mockWorkerDb.denyDailyCap = false;

        // Injected adapter: Page 1 returns 10 rows (with embedded newline in signature), Page 2 returns 3 rows (short last page, nextCursor: null)
        setProviderAdapterForTesting(async (input) => {
          if (input.step === 0) {
            const rows = Array.from({ length: 10 }, (_, i) => ({
              id: `row_p1_${i + 1}`,
              uniqueId: `creator_${i + 1}`,
              nickname: `صانع محتوى ${i + 1}`,
              signature: `سطر أول ${i + 1}\nسطر ثانٍ داخل الخلية`,
              followerCount: 1000 + i,
            }));
            return {
              ok: true,
              httpStatus: 200,
              rows,
              nextCursor: "cursor_page_2",
              costUsd: 0.002,
              costMicro: 2000,
              tregCallId: "treg_call_p1",
            };
          }
          const rows = Array.from({ length: 3 }, (_, i) => ({
            id: `row_p2_${i + 1}`,
            uniqueId: `creator_${11 + i}`,
            nickname: `صانع محتوى ${11 + i}`,
            signature: `وصف مختصر ${11 + i}`,
            followerCount: 2000 + i,
          }));
          return {
            ok: true,
            httpStatus: 200,
            rows,
            nextCursor: null, // Short last page (3 < 5 remaining)
            costUsd: 0.001,
            costMicro: 1000,
            tregCallId: "treg_call_p2",
          };
        });

        const workerRoute = await import("../src/app/api/worker/chunk/route");

        // Step 0 (Page 1 -> 10 rows)
        const resStep0 = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({
              jobId: "job_short_last_page",
              expectedStep: 0,
              disableSelfChain: true,
            }),
          })
        );
        expect(resStep0.status).toBe(200);
        const jsonStep0 = await resStep0.json();
        expect(jsonStep0.success).toBe(true);
        expect(jsonStep0.done).toBe(false);
        expect(jsonStep0.deliveredUnits).toBe(10);
        expect(jsonStep0.cursor).toBe("cursor_page_2");

        // Step 1 (Short last page -> 3 rows -> total 13 < targetMax 15 -> finishes & settles)
        const resStep1 = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({
              jobId: "job_short_last_page",
              expectedStep: 1,
              disableSelfChain: true,
            }),
          })
        );
        expect(resStep1.status).toBe(200);
        const jsonStep1 = await resStep1.json();
        expect(jsonStep1.success).toBe(true);
        expect(jsonStep1.done).toBe(true);
        expect(jsonStep1.deliveredUnits).toBe(13);

        // Verify charge = ceil(13 * 1.5) = 20, released = 26 - 20 = 6
        expect(jsonStep1.settle?.charged_credits).toBe(20);
        expect(jsonStep1.settle?.released_credits).toBe(6);

        const xlsxPath = "user_worker_1/job_short_last_page/result.xlsx";
        expect(mockWorkerDb.uploadedBodies.get(`results:${xlsxPath}`)).toBeDefined();
        expect(mockWorkerDb.uploadedBodies.has("results:user_worker_1/job_short_last_page/result.csv")).toBe(false);
        expect(mockWorkerDb.uploadedBodies.has("results:user_worker_1/job_short_last_page/result.pdf")).toBe(false);
        expect(jsonStep1.resultFiles).toEqual({ xlsx: xlsxPath, pdf: null, csv: null });

        // Verify artifact_versions row columns
        expect(mockWorkerDb.artifactVersions).toHaveLength(1);
        expect(Object.keys(mockWorkerDb.artifactVersions[0]).sort()).toEqual(
          [
            "created_at",
            "file_id_csv",
            "file_id_pdf",
            "file_id_xlsx",
            "id",
            "job_id",
            "user_id",
            "version_number",
          ].sort()
        );
        expect(mockWorkerDb.artifactVersions[0].file_id_xlsx).toBe(xlsxPath);
        expect(mockWorkerDb.artifactVersions[0].file_id_csv).toBeNull();
        expect(mockWorkerDb.artifactVersions[0].file_id_pdf).toBeNull();

        // Verify notifications row uses exact schema columns (id, user_id, title, body, read, link, created_at)
        expect(mockWorkerDb.notifications).toHaveLength(1);
        expect(Object.keys(mockWorkerDb.notifications[0]).sort()).toEqual(
          ["body", "created_at", "id", "link", "read", "title", "user_id"].sort()
        );
        expect(mockWorkerDb.notifications[0]).not.toHaveProperty("type");
        expect(mockWorkerDb.notifications[0]).not.toHaveProperty("message");

        // Also verify charge is strictly capped at reserve when ceil(delivered * unitPrice) > reservedCredits
        mockWorkerDb.step = 0;
        mockWorkerDb.currentCursor = null;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.targetVolumeMax = 10;
        mockWorkerDb.unitPrice = 3; // 10 * 3 = 30
        mockWorkerDb.reservedCredits = 25; // reserve is 25 (< 30)
        mockWorkerDb.settledJobs = [];

        setProviderAdapterForTesting(async () => ({
          ok: true,
          httpStatus: 200,
          rows: Array.from({ length: 10 }, (_, i) => ({ id: `r_${i}`, uniqueId: `u_${i}` })),
          nextCursor: null,
          costUsd: 0.001,
          costMicro: 1000,
          tregCallId: "treg_cap_check",
        }));

        const resCap = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({
              jobId: "job_reserve_cap_check",
              expectedStep: 0,
              disableSelfChain: true,
            }),
          })
        );
        const jsonCap = await resCap.json();
        expect(jsonCap.success).toBe(true);
        expect(jsonCap.settle?.charged_credits).toBe(25); // Capped at reserve (25), never 30
        expect(jsonCap.settle?.released_credits).toBe(0);
      } finally {
        setProviderAdapterForTesting(null);
        (process.env as any).NODE_ENV = originalNodeEnv;
        process.env.ENABLE_MOCK_PROVIDER = originalEnableMock;
      }
    });

    it("A3: empty provider result releases full reserve with zero charge and never settles", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableMock = process.env.ENABLE_MOCK_PROVIDER;
      const { setProviderAdapterForTesting } = await import("../src/lib/server/tregAdapter");
      try {
        (process.env as any).NODE_ENV = "test";
        process.env.ENABLE_MOCK_PROVIDER = "true";

        mockWorkerDb.step = 0;
        mockWorkerDb.currentCursor = null;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.targetVolumeMax = 10;
        mockWorkerDb.settled = false;
        mockWorkerDb.releasedJobs = [];

        setProviderAdapterForTesting(async () => ({
          ok: true,
          httpStatus: 200,
          rows: [],
          nextCursor: null,
          costUsd: 0.001,
          costMicro: 1000,
          tregCallId: "treg_empty",
        }));

        const workerRoute = await import("../src/app/api/worker/chunk/route");
        const res = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({ jobId: "job_empty_result", expectedStep: 0 }),
          })
        );

        expect(res.status).toBe(422);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.released).toBe(true);
        expect(json.chargedCredits).toBe(0);
        expect(json.deliveredUnits).toBe(0);
        expect(mockWorkerDb.settled).toBe(false);
        expect(mockWorkerDb.releasedJobs).toHaveLength(1);
        expect(mockWorkerDb.releasedJobs[0]).toEqual({
          p_job_id: "job_empty_result",
          p_error_message: expect.stringContaining("استرداد كامل الرصيد المحجوز دون أي خصم"),
          p_force: true,
        });
      } finally {
        setProviderAdapterForTesting(null);
        (process.env as any).NODE_ENV = originalNodeEnv;
        process.env.ENABLE_MOCK_PROVIDER = originalEnableMock;
      }
    });

    it("A3: provider error mid-run (chunk 0 succeeds, chunk 1 fails) settles the rows already collected and never releases", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableMock = process.env.ENABLE_MOCK_PROVIDER;
      const { setProviderAdapterForTesting } = await import("../src/lib/server/tregAdapter");
      try {
        (process.env as any).NODE_ENV = "test";
        process.env.ENABLE_MOCK_PROVIDER = "true";

        mockWorkerDb.step = 0;
        mockWorkerDb.currentCursor = null;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.targetVolumeMax = 10;
        mockWorkerDb.settled = false;
        mockWorkerDb.recordedFailures = [];
        mockWorkerDb.releasedJobs = [];

        setProviderAdapterForTesting(async (input) => {
          if (input.step === 0) {
            return {
              ok: true,
              httpStatus: 200,
              rows: Array.from({ length: 5 }, (_, i) => ({ id: `m_${i}`, uniqueId: `u_${i}` })),
              nextCursor: "cursor_step_1",
              costUsd: 0.001,
              costMicro: 1000,
              tregCallId: "treg_mid_ok",
            };
          }
          return {
            ok: false,
            httpStatus: 502,
            rows: [],
            nextCursor: null,
            costUsd: 0.001,
            costMicro: 1000,
            tregCallId: "treg_mid_err",
            errorCode: "provider_502",
            errorMessageAr: "تعذر استخراج البيانات من المصدر في الدفعة الثانية.",
          };
        });

        const workerRoute = await import("../src/app/api/worker/chunk/route");

        // Chunk 0 succeeds
        const res0 = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({
              jobId: "job_midrun_fail",
              expectedStep: 0,
              disableSelfChain: true,
            }),
          })
        );
        expect(res0.status).toBe(200);

        // Chunk 1 fails mid-run AFTER chunk 0 delivered 5 rows -> the collection ends and the 5 rows are settled and charged
        const res1 = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({
              jobId: "job_midrun_fail",
              expectedStep: 1,
              disableSelfChain: true,
            }),
          })
        );
        expect(res1.status).toBe(200);
        const json1 = await res1.json();
        expect(json1.success).toBe(true);
        expect(json1.done).toBe(true);
        expect(json1.deliveredUnits).toBe(5);
        expect(mockWorkerDb.settled).toBe(true);
        const settledNow = mockWorkerDb.settledJobs.filter((entry: any) => entry.args.p_job_id === "job_midrun_fail");
        expect(settledNow).toHaveLength(1);
        // charge = ceil(5 delivered x unit price), never above the reserve
        expect(settledNow[0].result.charged_credits).toBe(Math.min(Math.ceil(5 * mockWorkerDb.unitPrice), mockWorkerDb.reservedCredits));
        expect(mockWorkerDb.recordedFailures).toHaveLength(0);
        expect(mockWorkerDb.releasedJobs).toHaveLength(0);
      } finally {
        setProviderAdapterForTesting(null);
        (process.env as any).NODE_ENV = originalNodeEnv;
        process.env.ENABLE_MOCK_PROVIDER = originalEnableMock;
      }
    });

    it("A3: daily-cap denial releases full reserve with zero charge and never calls provider or settles", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableMock = process.env.ENABLE_MOCK_PROVIDER;
      const { setProviderAdapterForTesting } = await import("../src/lib/server/tregAdapter");
      let adapterCalled = false;
      try {
        (process.env as any).NODE_ENV = "test";
        process.env.ENABLE_MOCK_PROVIDER = "true";

        mockWorkerDb.step = 0;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.denyDailyCap = true;
        mockWorkerDb.settled = false;
        mockWorkerDb.recordedFailures = [];
        mockWorkerDb.releasedJobs = [];

        setProviderAdapterForTesting(async () => {
          adapterCalled = true;
          return {
            ok: true,
            httpStatus: 200,
            rows: [{ id: "1" }],
            nextCursor: null,
            costUsd: 0.001,
            costMicro: 1000,
            tregCallId: "should_not_run",
          };
        });

        const workerRoute = await import("../src/app/api/worker/chunk/route");
        const res = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({ jobId: "job_cap_denied", expectedStep: 0 }),
          })
        );

        expect(res.status).toBe(429);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.capExceeded).toBe(true);
        expect(json.released).toBe(true);
        expect(json.chargedCredits).toBe(0);
        expect(adapterCalled).toBe(false);
        expect(mockWorkerDb.settled).toBe(false);
        expect(mockWorkerDb.releasedJobs).toHaveLength(1);
        expect(mockWorkerDb.releasedJobs[0].p_force).toBe(true);
      } finally {
        mockWorkerDb.denyDailyCap = false;
        setProviderAdapterForTesting(null);
        (process.env as any).NODE_ENV = originalNodeEnv;
        process.env.ENABLE_MOCK_PROVIDER = originalEnableMock;
      }
    });

    it("A3: storage write failures (partials upload or results upload) fail the chunk, release with zero charge, and never settle", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableMock = process.env.ENABLE_MOCK_PROVIDER;
      const { setProviderAdapterForTesting } = await import("../src/lib/server/tregAdapter");
      try {
        (process.env as any).NODE_ENV = "test";
        process.env.ENABLE_MOCK_PROVIDER = "true";

        setProviderAdapterForTesting(async () => ({
          ok: true,
          httpStatus: 200,
          rows: [{ id: "row_1", uniqueId: "u_1" }],
          nextCursor: null,
          costUsd: 0.001,
          costMicro: 1000,
          tregCallId: "treg_storage_test",
        }));

        const workerRoute = await import("../src/app/api/worker/chunk/route");

        // 1. Partials upload failure -> fails chunk before complete_chunk, releases with zero charge
        mockWorkerDb.step = 0;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.targetVolumeMax = 1;
        mockWorkerDb.failPartialsUpload = true;
        mockWorkerDb.failResultsUpload = false;
        mockWorkerDb.settled = false;
        mockWorkerDb.releasedJobs = [];

        const resPartialsFail = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({ jobId: "job_partials_fail", expectedStep: 0 }),
          })
        );
        expect(resPartialsFail.status).toBe(500);
        const jsonPartialsFail = await resPartialsFail.json();
        expect(jsonPartialsFail.released).toBe(true);
        expect(jsonPartialsFail.chargedCredits).toBe(0);
        expect(mockWorkerDb.settled).toBe(false);
        expect(mockWorkerDb.deliveredUnits).toBe(0); // complete_chunk was never reached

        // 2. Results upload failure -> does not settle, releases with zero charge
        mockWorkerDb.step = 0;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.targetVolumeMax = 1;
        mockWorkerDb.failPartialsUpload = false;
        mockWorkerDb.failResultsUpload = true;
        mockWorkerDb.settled = false;
        mockWorkerDb.releasedJobs = [];

        const resResultsFail = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({ jobId: "job_results_fail", expectedStep: 0 }),
          })
        );
        expect(resResultsFail.status).toBe(500);
        const jsonResultsFail = await resResultsFail.json();
        expect(jsonResultsFail.released).toBe(true);
        expect(jsonResultsFail.chargedCredits).toBe(0);
        expect(mockWorkerDb.settled).toBe(false);
        expect(mockWorkerDb.releasedJobs).toHaveLength(1);
        expect(mockWorkerDb.releasedJobs[0].p_job_id).toBe("job_results_fail");
        expect(mockWorkerDb.releasedJobs[0].p_force).toBe(true);
      } finally {
        mockWorkerDb.failPartialsUpload = false;
        mockWorkerDb.failResultsUpload = false;
        setProviderAdapterForTesting(null);
        (process.env as any).NODE_ENV = originalNodeEnv;
        process.env.ENABLE_MOCK_PROVIDER = originalEnableMock;
      }
    });

    it("integrity: artifact_versions write failure releases full reserve with zero charge and never settles", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableMock = process.env.ENABLE_MOCK_PROVIDER;
      const { setProviderAdapterForTesting } = await import("../src/lib/server/tregAdapter");
      const workerRoute = await import("../src/app/api/worker/chunk/route");
      try {
        (process.env as any).NODE_ENV = "test";
        process.env.ENABLE_MOCK_PROVIDER = "true";

        setProviderAdapterForTesting(async () => ({
          ok: true,
          httpStatus: 200,
          rows: [{ id: "av_row_1", uniqueId: "u_av_1" }],
          nextCursor: null,
          costUsd: 0.001,
          costMicro: 1000,
          tregCallId: "treg_av_test",
        }));

        mockWorkerDb.step = 0;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.targetVolumeMax = 1;
        mockWorkerDb.failPartialsUpload = false;
        mockWorkerDb.failResultsUpload = false;
        mockWorkerDb.failArtifactVersions = true;
        mockWorkerDb.settled = false;
        mockWorkerDb.releasedJobs = [];

        const res = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({ jobId: "job_av_fail", expectedStep: 0 }),
          })
        );

        expect(res.status).toBe(500);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.released).toBe(true);
        expect(json.chargedCredits).toBe(0);
        expect(json.deliveredUnits).toBe(0);
        expect(json.error).toContain("تعذر تسجيل نسخة المستندات النهائية");
        expect(mockWorkerDb.settled).toBe(false);
        expect(mockWorkerDb.releasedJobs).toHaveLength(1);
        expect(mockWorkerDb.releasedJobs[0].p_job_id).toBe("job_av_fail");
        expect(mockWorkerDb.releasedJobs[0].p_force).toBe(true);
      } finally {
        mockWorkerDb.failArtifactVersions = false;
        setProviderAdapterForTesting(null);
        (process.env as any).NODE_ENV = originalNodeEnv;
        process.env.ENABLE_MOCK_PROVIDER = originalEnableMock;
      }
    });

    it("integrity: missing or corrupted partial data releases full reserve with zero charge and never settles", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableMock = process.env.ENABLE_MOCK_PROVIDER;
      const { setProviderAdapterForTesting, clearInMemoryPartialStepFallbackForTesting } = await import("../src/lib/server/tregAdapter");
      const workerRoute = await import("../src/app/api/worker/chunk/route");
      try {
        (process.env as any).NODE_ENV = "test";
        process.env.ENABLE_MOCK_PROVIDER = "true";

        setProviderAdapterForTesting(async () => ({
          ok: true,
          httpStatus: 200,
          rows: [{ id: "corrupt_row_1", uniqueId: "u_corrupt_1" }],
          nextCursor: null,
          costUsd: 0.001,
          costMicro: 1000,
          tregCallId: "treg_corrupt_test",
        }));

        // 1. Missing step file (download fails and not in fallback)
        clearInMemoryPartialStepFallbackForTesting();
        mockWorkerDb.step = 0;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.targetVolumeMax = 1;
        mockWorkerDb.failPartialsDownload = true;
        mockWorkerDb.corruptPartialsData = false;
        mockWorkerDb.settled = false;
        mockWorkerDb.releasedJobs = [];

        const resMissing = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({ jobId: "job_missing_step", expectedStep: 0 }),
          })
        );

        expect(resMissing.status).toBe(500);
        const jsonMissing = await resMissing.json();
        expect(jsonMissing.released).toBe(true);
        expect(jsonMissing.chargedCredits).toBe(0);
        expect(jsonMissing.deliveredUnits).toBe(0);
        expect(jsonMissing.error).toContain("تعذر قراءة بيانات الدفعة المرحلية");
        expect(mockWorkerDb.settled).toBe(false);
        expect(mockWorkerDb.releasedJobs).toHaveLength(1);
        expect(mockWorkerDb.releasedJobs[0].p_force).toBe(true);

        // 2. Corrupted step file (download returns non-JSON or invalid rows)
        clearInMemoryPartialStepFallbackForTesting();
        mockWorkerDb.step = 0;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.targetVolumeMax = 1;
        mockWorkerDb.failPartialsDownload = false;
        mockWorkerDb.corruptPartialsData = true;
        mockWorkerDb.settled = false;
        mockWorkerDb.releasedJobs = [];

        const resCorrupt = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({ jobId: "job_corrupt_step", expectedStep: 0 }),
          })
        );

        expect(resCorrupt.status).toBe(500);
        const jsonCorrupt = await resCorrupt.json();
        expect(jsonCorrupt.released).toBe(true);
        expect(jsonCorrupt.chargedCredits).toBe(0);
        expect(jsonCorrupt.deliveredUnits).toBe(0);
        expect(jsonCorrupt.error).toContain("تعذر قراءة بيانات الدفعة المرحلية");
        expect(mockWorkerDb.settled).toBe(false);
        expect(mockWorkerDb.releasedJobs).toHaveLength(1);
        expect(mockWorkerDb.releasedJobs[0].p_force).toBe(true);
      } finally {
        mockWorkerDb.failPartialsDownload = false;
        mockWorkerDb.corruptPartialsData = false;
        clearInMemoryPartialStepFallbackForTesting();
        setProviderAdapterForTesting(null);
        (process.env as any).NODE_ENV = originalNodeEnv;
        process.env.ENABLE_MOCK_PROVIDER = originalEnableMock;
      }
    });

    it("integrity: delivered units row count mismatch releases full reserve with zero charge and never settles", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableMock = process.env.ENABLE_MOCK_PROVIDER;
      const { setProviderAdapterForTesting, clearInMemoryPartialStepFallbackForTesting } = await import("../src/lib/server/tregAdapter");
      const workerRoute = await import("../src/app/api/worker/chunk/route");
      try {
        (process.env as any).NODE_ENV = "test";
        process.env.ENABLE_MOCK_PROVIDER = "true";

        setProviderAdapterForTesting(async () => ({
          ok: true,
          httpStatus: 200,
          rows: [{ id: "mismatch_row_1", uniqueId: "u_mismatch_1" }],
          nextCursor: null,
          costUsd: 0.001,
          costMicro: 1000,
          tregCallId: "treg_mismatch_test",
        }));

        clearInMemoryPartialStepFallbackForTesting();
        mockWorkerDb.step = 0;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.targetVolumeMax = 1;
        mockWorkerDb.mismatchDeliveredUnits = true; // injects +5 mismatch in complete_chunk
        mockWorkerDb.settled = false;
        mockWorkerDb.releasedJobs = [];

        const res = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({ jobId: "job_mismatch_count", expectedStep: 0 }),
          })
        );

        expect(res.status).toBe(500);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.released).toBe(true);
        expect(json.chargedCredits).toBe(0);
        expect(json.deliveredUnits).toBe(0);
        expect(json.error).toContain("عدم تطابق في عدد السجلات المجمعة");
        expect(mockWorkerDb.settled).toBe(false);
        expect(mockWorkerDb.releasedJobs).toHaveLength(1);
        expect(mockWorkerDb.releasedJobs[0].p_job_id).toBe("job_mismatch_count");
        expect(mockWorkerDb.releasedJobs[0].p_force).toBe(true);
      } finally {
        mockWorkerDb.mismatchDeliveredUnits = false;
        clearInMemoryPartialStepFallbackForTesting();
        setProviderAdapterForTesting(null);
        (process.env as any).NODE_ENV = originalNodeEnv;
        process.env.ENABLE_MOCK_PROVIDER = originalEnableMock;
      }
    });

    it("integrity: release_job_atomic failure returns released: false with safe Arabic error and zero charge", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableMock = process.env.ENABLE_MOCK_PROVIDER;
      const { setProviderAdapterForTesting, clearInMemoryPartialStepFallbackForTesting } =
        await import("../src/lib/server/tregAdapter");
      const workerRoute = await import("../src/app/api/worker/chunk/route");
      try {
        (process.env as any).NODE_ENV = "test";
        process.env.ENABLE_MOCK_PROVIDER = "true";

        setProviderAdapterForTesting(async () => ({
          ok: true,
          httpStatus: 200,
          rows: [{ id: "rel_fail_row", uniqueId: "u_rel_fail" }],
          nextCursor: null,
          costUsd: 0.001,
          costMicro: 1000,
          tregCallId: "treg_rel_fail_test",
        }));

        clearInMemoryPartialStepFallbackForTesting();
        mockWorkerDb.step = 0;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.targetVolumeMax = 1;
        mockWorkerDb.failResultsUpload = true; // causes failure branch
        mockWorkerDb.failReleaseJobAtomic = true; // release RPC fails!
        mockWorkerDb.releaseJobAtomicError = { message: "release_database_timeout" };
        mockWorkerDb.settled = false;
        mockWorkerDb.releasedJobs = [];

        const res = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({ jobId: "job_release_rpc_failed", expectedStep: 0 }),
          })
        );

        expect(res.status).toBe(500);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.released).toBe(false);
        expect(json.chargedCredits).toBe(0);
        expect(json.deliveredUnits).toBe(0);
        expect(json.error).toBe("تعذر تحرير الرصيد المحجوز للمهمة.");
        expect(json.diagnostic).toBe("release_database_timeout");
        expect(mockWorkerDb.settled).toBe(false);
      } finally {
        mockWorkerDb.failResultsUpload = false;
        mockWorkerDb.failReleaseJobAtomic = false;
        mockWorkerDb.releaseJobAtomicError = null;
        clearInMemoryPartialStepFallbackForTesting();
        setProviderAdapterForTesting(null);
        (process.env as any).NODE_ENV = originalNodeEnv;
        process.env.ENABLE_MOCK_PROVIDER = originalEnableMock;
      }
    });

    it("integrity: complete_chunk missing or malformed delivered_units response aborts execution with zero charge", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableMock = process.env.ENABLE_MOCK_PROVIDER;
      const { setProviderAdapterForTesting, clearInMemoryPartialStepFallbackForTesting } =
        await import("../src/lib/server/tregAdapter");
      const workerRoute = await import("../src/app/api/worker/chunk/route");
      try {
        (process.env as any).NODE_ENV = "test";
        process.env.ENABLE_MOCK_PROVIDER = "true";

        setProviderAdapterForTesting(async () => ({
          ok: true,
          httpStatus: 200,
          rows: [{ id: "comp_malformed_1", uniqueId: "u_comp_1" }],
          nextCursor: null,
          costUsd: 0.001,
          costMicro: 1000,
          tregCallId: "treg_comp_malformed_test",
        }));

        clearInMemoryPartialStepFallbackForTesting();
        mockWorkerDb.step = 0;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.targetVolumeMax = 1;
        mockWorkerDb.settled = false;
        mockWorkerDb.releasedJobs = [];
        // complete_chunk returns missing delivered_units
        mockWorkerDb.completeChunkOverride = {
          data: { success: true }, // missing delivered_units!
          error: null,
        };

        const res = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({ jobId: "job_comp_missing_units", expectedStep: 0 }),
          })
        );

        expect(res.status).toBe(500);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.chargedCredits).toBe(0);
        expect(mockWorkerDb.settled).toBe(false); // NEVER settled without verified delivered_units

        // When complete_chunk returns database error
        mockWorkerDb.completeChunkOverride = {
          data: null,
          error: { message: "complete_chunk_db_constraint_violation" },
        };
        const resErr = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({ jobId: "job_comp_db_err", expectedStep: 0 }),
          })
        );
        expect(resErr.status).toBe(500);
        const jsonErr = await resErr.json();
        expect(jsonErr.success).toBe(false);
        expect(jsonErr.chargedCredits).toBe(0);
        expect(mockWorkerDb.settled).toBe(false);
      } finally {
        mockWorkerDb.completeChunkOverride = null;
        clearInMemoryPartialStepFallbackForTesting();
        setProviderAdapterForTesting(null);
        (process.env as any).NODE_ENV = originalNodeEnv;
        process.env.ENABLE_MOCK_PROVIDER = originalEnableMock;
      }
    });

    it("integrity: safely handles complete_chunk already_completed without duplicate settlement", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableMock = process.env.ENABLE_MOCK_PROVIDER;
      const { setProviderAdapterForTesting, clearInMemoryPartialStepFallbackForTesting } =
        await import("../src/lib/server/tregAdapter");
      const workerRoute = await import("../src/app/api/worker/chunk/route");
      try {
        (process.env as any).NODE_ENV = "test";
        process.env.ENABLE_MOCK_PROVIDER = "true";

        // Case A: intermediate step returns already_completed
        setProviderAdapterForTesting(async () => ({
          ok: true,
          httpStatus: 200,
          rows: [{ id: "row_idempotent", uniqueId: "u_idemp" }],
          nextCursor: "next_cursor_page_2",
          costUsd: 0.001,
          costMicro: 1000,
          tregCallId: "treg_idemp_test",
        }));

        clearInMemoryPartialStepFallbackForTesting();
        mockWorkerDb.step = 0;
        mockWorkerDb.deliveredUnits = 0;
        mockWorkerDb.targetVolumeMax = 10;
        mockWorkerDb.settled = false;
        mockWorkerDb.completeChunkOverride = {
          data: {
            success: true,
            already_completed: true,
            current_step: 1,
            delivered_units: 5,
          },
          error: null,
        };

        const resInter = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({ jobId: "job_already_comp_inter", expectedStep: 0 }),
          })
        );

        expect(resInter.status).toBe(200);
        const jsonInter = await resInter.json();
        expect(jsonInter.success).toBe(true);
        expect(jsonInter.done).toBe(false);
        expect(jsonInter.alreadyCompleted).toBe(true);
        expect(jsonInter.deliveredUnits).toBe(5);
        expect(mockWorkerDb.settled).toBe(false);

        // Case B: terminal step returns already_completed and job status in DB is completed
        setProviderAdapterForTesting(async () => ({
          ok: true,
          httpStatus: 200,
          rows: [{ id: "row_idemp_done", uniqueId: "u_idemp_done" }],
          nextCursor: null,
          costUsd: 0.001,
          costMicro: 1000,
          tregCallId: "treg_idemp_done_test",
        }));

        mockWorkerDb.jobStatusOverride = "completed";
        mockWorkerDb.deliveredUnits = 10;
        mockWorkerDb.completeChunkOverride = {
          data: {
            success: true,
            already_completed: true,
            current_step: 2,
            delivered_units: 10,
          },
          error: null,
        };

        const resTerm = await workerRoute.POST(
          new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
            method: "POST",
            headers: { authorization: "Bearer super-secret-cron-key-12345" },
            body: JSON.stringify({ jobId: "job_already_comp_term", expectedStep: 1 }),
          })
        );

        expect(resTerm.status).toBe(200);
        const jsonTerm = await resTerm.json();
        expect(jsonTerm.success).toBe(true);
        expect(jsonTerm.done).toBe(true);
        expect(jsonTerm.alreadySettled).toBe(true);
        expect(jsonTerm.deliveredUnits).toBe(10);
      } finally {
        mockWorkerDb.completeChunkOverride = null;
        mockWorkerDb.jobStatusOverride = null;
        clearInMemoryPartialStepFallbackForTesting();
        setProviderAdapterForTesting(null);
        (process.env as any).NODE_ENV = originalNodeEnv;
        process.env.ENABLE_MOCK_PROVIDER = originalEnableMock;
      }
    });
  });
});
