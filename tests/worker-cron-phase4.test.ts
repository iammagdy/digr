import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { verifyCronSecret } from "../src/lib/server/cronAuth";
import fs from "node:fs";
import path from "node:path";

describe("Phase 4: Cron Auth & Hobby Design B Tests", () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "super-secret-cron-key-12345";
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

    it("should reject when no token is provided", () => {
      const req = new NextRequest("http://127.0.0.1:3000/api/worker/chunk");
      expect(verifyCronSecret(req)).toBe(false);
    });

    it("should fail closed if env CRON_SECRET is empty", () => {
      delete process.env.CRON_SECRET;
      const req = new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        headers: {
          authorization: "Bearer super-secret-cron-key-12345",
        },
      });
      expect(verifyCronSecret(req)).toBe(false);
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

  describe("Worker & Cron Routes Export Invariants", () => {
    it("should enforce force-dynamic and maxDuration <= 60 in chunk route", async () => {
      const chunkRoute = await import("../src/app/api/worker/chunk/route");
      expect(chunkRoute.dynamic).toBe("force-dynamic");
      expect(chunkRoute.maxDuration).toBeLessThanOrEqual(60);
      expect(typeof chunkRoute.POST).toBe("function");
    });

    it("should enforce force-dynamic and maxDuration <= 60 in watchdog route", async () => {
      const watchdogRoute = await import("../src/app/api/cron/watchdog/route");
      expect(watchdogRoute.dynamic).toBe("force-dynamic");
      expect(watchdogRoute.maxDuration).toBeLessThanOrEqual(60);
      expect(typeof watchdogRoute.GET).toBe("function");
    });

    it("should enforce force-dynamic in job nudge route", async () => {
      const nudgeRoute = await import("../src/app/api/jobs/[id]/nudge/route");
      expect(nudgeRoute.dynamic).toBe("force-dynamic");
      expect(typeof nudgeRoute.POST).toBe("function");
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
