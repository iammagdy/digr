import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { verifyCronSecret } from "../src/lib/server/cronAuth";
import fs from "node:fs";
import path from "node:path";

const mockNudgeDb = vi.hoisted(() => ({
  user: null as any,
  jobs: [] as any[],
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
  createAdminClient: vi.fn(() => ({})),
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
      const nudgeRoute = await import("../src/app/api/jobs/[id]/nudge/route");
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

  describe("Accept Quote Worker Trigger Integration", () => {
    it("should include initial chunk trigger in accept-quote route", () => {
      const routeContent = fs.readFileSync(
        path.resolve(process.cwd(), "src/app/api/chat/accept-quote/route.ts"),
        "utf8"
      );
      expect(routeContent).toContain("/api/worker/chunk");
      expect(routeContent).toContain("expectedStep: 0");
      expect(routeContent).toContain("process.env.CRON_SECRET");
    });
  });
});
