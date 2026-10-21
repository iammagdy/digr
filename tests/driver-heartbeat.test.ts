import { beforeEach, describe, expect, it } from "vitest";
import { DRIVER_FRESH_MS, closePageLineAr, effectiveDriverMode } from "../src/lib/driverMode";
import { currentDriverMode, driverStatus, readDriverTickAt, recordDriverTick, resetDriverTickCacheForTesting } from "../src/lib/server/driverTick";

const NOW = Date.parse("2026-10-21T12:00:00Z");

function fakeAdmin(initial: string | null, opts: { failRead?: boolean; failWrite?: boolean } = {}) {
  let row: any = initial ? { key: "driver_tick", value: { at: initial } } : null;
  const calls = { reads: 0, writes: 0 };
  return {
    calls,
    get row() { return row; },
    from(table: string) {
      expect(table).toBe("settings_private");
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => { calls.reads++; if (opts.failRead) throw new Error("down"); return { data: row, error: null }; } }) }),
        upsert: async (value: any) => { calls.writes++; if (opts.failWrite) return { error: { message: "no" } }; row = value; return { error: null }; },
      };
    },
  };
}

beforeEach(() => resetDriverTickCacheForTesting());

describe("effectiveDriverMode: «cron» only with the flag AND a tick in the last three minutes", () => {
  it("truth table", () => {
    expect(effectiveDriverMode("tab", NOW, NOW)).toBe("tab");
    expect(effectiveDriverMode("cron", null, NOW)).toBe("tab");
    expect(effectiveDriverMode("cron", undefined, NOW)).toBe("tab");
    expect(effectiveDriverMode("cron", NaN, NOW)).toBe("tab");
    expect(effectiveDriverMode("cron", NOW, NOW)).toBe("cron");
    expect(effectiveDriverMode("cron", NOW - DRIVER_FRESH_MS, NOW)).toBe("cron");
    expect(effectiveDriverMode("cron", NOW - DRIVER_FRESH_MS - 1, NOW)).toBe("tab");
    expect(effectiveDriverMode("cron", NOW + 5000, NOW)).toBe("tab");
  });
  it("the three-minute window is exactly 180 seconds", () => {
    expect(DRIVER_FRESH_MS).toBe(180_000);
  });
});

describe("driver heartbeat storage", () => {
  it("recordDriverTick writes the time of the call and a following read sees it", async () => {
    const admin = fakeAdmin(null);
    expect(await recordDriverTick(admin, NOW)).toBe(true);
    expect(admin.row.key).toBe("driver_tick");
    expect(admin.row.value.at).toBe(new Date(NOW).toISOString());
    expect(await readDriverTickAt(admin, NOW + 1000)).toBe(NOW);
  });

  it("a failed write reports false and never throws", async () => {
    expect(await recordDriverTick(fakeAdmin(null, { failWrite: true }), NOW)).toBe(false);
  });

  it("a read failure or a bad value means no tick (never «cron»)", async () => {
    expect(await readDriverTickAt(fakeAdmin("2026-10-21T11:59:00Z", { failRead: true }), NOW)).toBeNull();
    resetDriverTickCacheForTesting();
    expect(await readDriverTickAt(fakeAdmin("not a date"), NOW)).toBeNull();
  });

  it("reads are cached for a short time (one row, not one query per request)", async () => {
    const admin = fakeAdmin(new Date(NOW - 10_000).toISOString());
    await readDriverTickAt(admin, NOW);
    await readDriverTickAt(admin, NOW + 5000);
    expect(admin.calls.reads).toBe(1);
    await readDriverTickAt(admin, NOW + 25_000);
    expect(admin.calls.reads).toBe(2);
  });
});

describe("the mode the customer is told about", () => {
  const cron = { LONG_JOB_DRIVER: "cron" };

  it("flag on and a fresh tick: cron, and the plan may say the page can be closed", async () => {
    const admin = fakeAdmin(new Date(NOW - 60_000).toISOString());
    const mode = await currentDriverMode(admin, cron, NOW);
    expect(mode).toBe("cron");
    expect(closePageLineAr(mode)).toContain("تقدر تقفل الصفحة");
  });

  it("flag on but the tick is stale: tab, the page must stay open", async () => {
    const mode = await currentDriverMode(fakeAdmin(new Date(NOW - 4 * 60_000).toISOString()), cron, NOW);
    expect(mode).toBe("tab");
    expect(closePageLineAr(mode)).not.toContain("تقدر تقفل الصفحة");
  });

  it("flag on but no tick ever: tab", async () => {
    expect(await currentDriverMode(fakeAdmin(null), cron, NOW)).toBe("tab");
  });

  it("flag off with a fresh tick: tab, and the table is not even read", async () => {
    const admin = fakeAdmin(new Date(NOW).toISOString());
    expect(await currentDriverMode(admin, {}, NOW)).toBe("tab");
    expect(admin.calls.reads).toBe(0);
  });

  it("driverStatus reports the configured flag, the effective mode and the age", async () => {
    const status = await driverStatus(fakeAdmin(new Date(NOW - 42_000).toISOString()), cron, NOW);
    expect(status).toMatchObject({ configured: "cron", mode: "cron", ageSeconds: 42 });
    resetDriverTickCacheForTesting();
    const stale = await driverStatus(fakeAdmin(null), cron, NOW);
    expect(stale).toMatchObject({ configured: "cron", mode: "tab", lastTickAt: null, ageSeconds: null });
  });
});

describe("routes", () => {
  it("the drive route records a tick, and /api/driver-status reads «tab» when the tick is stale", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    let row: any = null;
    const admin = {
      from: (table: string) => {
        if (table === "settings_private") return {
          upsert: async (v: any) => { row = v; return { error: null }; },
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        };
        const q: any = { select: () => q, in: () => q, or: () => q, gt: () => q, lt: () => q, order: () => q, limit: async () => ({ data: [], error: null }) };
        return q;
      },
    };
    vi.doMock("../src/lib/supabase/server", () => ({ createAdminClient: () => admin }));
    vi.doMock("../src/lib/server/jobStallNotifier", () => ({ notifyStalledJobs: async () => 0 }));
    process.env.CRON_SECRET = "test-secret-value-1234567890";
    const { GET: drive } = await import("../src/app/api/cron/drive/route");
    const res = await drive(new Request("https://diger.test/api/cron/drive", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }) as any);
    expect(res.status).toBe(200);
    expect(row?.key).toBe("driver_tick");

    process.env.LONG_JOB_DRIVER = "cron";
    resetDriverTickCacheForTesting();
    const { GET: status } = await import("../src/app/api/driver-status/route");
    expect((await (await status()).json()).mode).toBe("cron");
    row = { key: "driver_tick", value: { at: new Date(Date.now() - 10 * 60_000).toISOString() } };
    const mod = await import("../src/lib/server/driverTick");
    mod.resetDriverTickCacheForTesting();
    expect((await (await status()).json()).mode).toBe("tab");
    delete process.env.LONG_JOB_DRIVER;
    vi.doUnmock("../src/lib/supabase/server");
    vi.doUnmock("../src/lib/server/jobStallNotifier");
  });
});
