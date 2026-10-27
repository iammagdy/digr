import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";

const memory = vi.hoisted(() => ({ db: null as any }));
vi.mock("../src/lib/supabase/server", async (original) => ({ ...(await original<any>()), createAdminClient: () => memory.db }));
vi.mock("../src/lib/server/jobStallNotifier", () => ({ notifyStalledJobs: async () => 0 }));

import { GET as drive } from "../src/app/api/cron/drive/route";
import { DRIVER_LIVE_WINDOW_MS, DRIVER_STATUS_CACHE_MS, closePageLineAr, driverForcedToTab, driverModeFromTick } from "../src/lib/driverMode";
import { liveDriverMode, readDriverLastTick, recordDriverTick, resetDriverModeCache } from "../src/lib/server/driverHeartbeat";

/** The memory db plus a `jobs` table with nothing waiting (the memory db has no `or`, which the route's job query uses). */
const withNoJobs = (db: any) => {
  const chain: any = {};
  for (const m of ["select", "in", "or", "gt", "lt", "order", "limit"]) chain[m] = () => chain;
  chain.then = (resolve: any) => resolve({ data: [], error: null });
  const from = db.from.bind(db);
  db.from = (table: string) => (table === "jobs" ? chain : from(table));
  return db;
};
const call = (secret?: string) => drive(new NextRequest("https://diger.test/api/cron/drive", { headers: secret ? { authorization: `Bearer ${secret}` } : {} }));

beforeEach(() => {
  memory.db = withNoJobs(createMemoryDb());
  resetDriverModeCache();
  vi.stubEnv("CRON_SECRET", "phase1-secret");
  vi.stubEnv("LONG_JOB_DRIVER", "");
  vi.stubEnv("VERCEL_ENV", "development");
});

describe("Phase 1: the background driver proves it is alive", () => {
  it("an authorised call writes the heartbeat even when nothing is waiting", async () => {
    const response = await call("phase1-secret");
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.dispatched).toBe(0);
    const rows = memory.db.rows("driver_heartbeat");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(Math.abs(Date.now() - new Date(rows[0].last_tick_at).getTime())).toBeLessThan(5_000);
    expect(rows[0].last_dispatched).toBe(0);
  });

  it("every tick updates the same single row; an unauthorised call writes nothing", async () => {
    await call("phase1-secret");
    await call("phase1-secret");
    expect(memory.db.rows("driver_heartbeat")).toHaveLength(1);
    memory.db = withNoJobs(createMemoryDb());
    const refused = await call("wrong-secret");
    expect(refused.status).toBe(401);
    expect(await call()).toHaveProperty("status", 401);
    expect(memory.db.rows("driver_heartbeat")).toHaveLength(0);
  });

  it("a missing heartbeat table never breaks the tick (the driver then simply looks off)", async () => {
    memory.db = withNoJobs(createMemoryDb({ missing: ["driver_heartbeat"] }));
    const response = await call("phase1-secret");
    expect(response.status).toBe(200);
    expect(await liveDriverMode(memory.db)).toBe("tab");
  });
});

describe("Phase 1: driver mode is live only after a recent tick", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  it("live inside 3 minutes, off after, off when there is no tick or the time is nonsense", () => {
    expect(DRIVER_LIVE_WINDOW_MS).toBe(180_000);
    expect(driverModeFromTick(new Date(now - 60_000).toISOString(), now, {})).toBe("cron");
    expect(driverModeFromTick(new Date(now - 180_000).toISOString(), now, {})).toBe("cron");
    expect(driverModeFromTick(new Date(now - 181_000).toISOString(), now, {})).toBe("tab");
    expect(driverModeFromTick(null, now, {})).toBe("tab");
    expect(driverModeFromTick("not a date", now, {})).toBe("tab");
    expect(driverModeFromTick(new Date(now + 3_600_000).toISOString(), now, {})).toBe("tab");
  });

  it("LONG_JOB_DRIVER can only force «tab»: «cron» switches nothing on", () => {
    const fresh = new Date(now - 1_000).toISOString();
    expect(driverForcedToTab({ LONG_JOB_DRIVER: "tab" })).toBe(true);
    expect(driverForcedToTab({ LONG_JOB_DRIVER: "off" })).toBe(true);
    expect(driverForcedToTab({ LONG_JOB_DRIVER: "cron" })).toBe(false);
    expect(driverModeFromTick(fresh, now, { LONG_JOB_DRIVER: "tab" })).toBe("tab");
    expect(driverModeFromTick(fresh, now, { LONG_JOB_DRIVER: "cron" })).toBe("cron");
    expect(driverModeFromTick(null, now, { LONG_JOB_DRIVER: "cron" })).toBe("tab");
  });

  it("the server's answer is cached for at most 30 seconds, then re-read", async () => {
    expect(DRIVER_STATUS_CACHE_MS).toBeLessThanOrEqual(30_000);
    const t0 = Date.parse("2026-10-27T12:00:00Z");
    await recordDriverTick(memory.db, 1, t0 - 1_000);
    expect(await liveDriverMode(memory.db, t0, {})).toBe("cron");
    memory.db.rows("driver_heartbeat")[0].last_tick_at = new Date(t0 - 10 * 60_000).toISOString();
    expect(await liveDriverMode(memory.db, t0 + 10_000, {})).toBe("cron"); // still the cached answer
    expect(await liveDriverMode(memory.db, t0 + DRIVER_STATUS_CACHE_MS + 1, {})).toBe("tab");
    expect(await readDriverLastTick(memory.db)).toBe(new Date(t0 - 10 * 60_000).toISOString());
  });
});

describe("Phase 1: what the customer is told", () => {
  it("live: the friendly sentence; not live: the existing line, never «you can close the page»", () => {
    expect(closePageLineAr("cron")).toBe("تقدر تقفل الصفحة وتروح تشرب قهوة، هنكمّل الشغل وهنبعتلك إيميل أول ما نخلص.");
    expect(closePageLineAr("tab")).toBe("أبقِ الصفحة مفتوحة حتى تكتمل المهمة.");
    expect(closePageLineAr("tab")).not.toContain("تقفل");
  });

  it("no server caller promises from the old flag any more, and the page re-reads the live answer", () => {
    for (const file of ["src/app/api/chat/accept-quote/route.ts", "src/app/api/calculator/estimate/route.ts", "src/functions/shared/chatHandler.ts", "src/app/api/driver-status/route.ts", "src/app/api/admin/email-check/route.ts", "src/app/api/cron/drive/route.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toContain("longJobDriverMode");
    }
    const hook = readFileSync("src/hooks/useDriverMode.ts", "utf8");
    expect(hook).toContain("DRIVER_STATUS_CACHE_MS");
    expect(hook).toContain("setInterval");
  });

  it("the completion, partial and failure e-mails keep going through the existing send-email path", () => {
    const worker = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(worker).toContain('sendPlatformEmail("job-done"');
    expect(worker).toContain('sendPlatformEmail("refund"');
    expect(readFileSync("src/lib/server/sendPlatformEmail.ts", "utf8")).toContain('"job-update"');
  });
});
