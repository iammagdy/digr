import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { countActiveJobs, isStaleActiveJob, STALE_ACTIVE_JOB_MS } from "../src/lib/jobs/activeJobs";
import { getBusyState, setBusyStateForTesting } from "../src/lib/server/busyState";

const NOW = Date.parse("2026-11-05T20:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

// The nine historical verification fixtures of production (12 Oct): running with an expired lease, queued with no lease and an old updated_at.
const FIXTURES = [
  { status: "running", lease_until: "2026-10-12T16:26:04.460118+00:00", updated_at: "2026-10-12T16:25:04.460118+00:00" },
  { status: "queued", lease_until: null, updated_at: "2026-10-12T16:26:17.498496+00:00" },
  { status: "queued", lease_until: null, updated_at: "2026-10-12T16:26:17.609217+00:00" },
  { status: "queued", lease_until: null, updated_at: "2026-10-12T16:29:36.447825+00:00" },
  { status: "queued", lease_until: null, updated_at: "2026-10-12T16:29:36.577538+00:00" },
  { status: "queued", lease_until: null, updated_at: "2026-10-12T16:29:36.68692+00:00" },
  { status: "running", lease_until: "2026-10-12T17:05:09.467589+00:00", updated_at: "2026-10-12T17:04:09.467589+00:00" },
  { status: "queued", lease_until: null, updated_at: "2026-10-12T17:04:34.548367+00:00" },
  { status: "queued", lease_until: null, updated_at: "2026-10-12T17:04:34.664201+00:00" },
];

afterEach(() => setBusyStateForTesting(undefined));

describe("the customer's queue counts real work, not stale rows", () => {
  it("the nine real production fixtures count as zero", () => {
    expect(FIXTURES).toHaveLength(9);
    expect(countActiveJobs(FIXTURES, NOW)).toBe(0);
  });
  it("legitimate active jobs are all kept: a leased running job, a fresh queued job, a lease that ran out only minutes ago", () => {
    const rows = [
      { status: "running", lease_until: iso(NOW + 60_000), updated_at: iso(NOW - 10_000) },
      { status: "running", lease_until: iso(NOW - 5 * 60_000), updated_at: iso(NOW - 6 * 60_000) },
      { status: "queued", lease_until: null, updated_at: iso(NOW - 2 * 60_000) },
      { status: "queued", lease_until: null, updated_at: iso(NOW) },
    ];
    expect(countActiveJobs(rows, NOW)).toBe(4);
  });
  it("mixed: the fixtures are dropped, the real jobs stay (the queue length is the real one)", () => {
    const real = [
      { status: "running", lease_until: iso(NOW + 30_000), updated_at: iso(NOW - 1000) },
      { status: "queued", lease_until: null, updated_at: iso(NOW - 60_000) },
    ];
    expect(countActiveJobs([...FIXTURES, ...real], NOW)).toBe(2);
  });
  it("the boundary is the watchdog's own: exactly 30 minutes is still active, one millisecond more is stale", () => {
    expect(STALE_ACTIVE_JOB_MS).toBe(30 * 60 * 1000);
    expect(isStaleActiveJob({ status: "running", lease_until: iso(NOW - STALE_ACTIVE_JOB_MS), updated_at: null }, NOW)).toBe(false);
    expect(isStaleActiveJob({ status: "running", lease_until: iso(NOW - STALE_ACTIVE_JOB_MS - 1), updated_at: null }, NOW)).toBe(true);
    expect(isStaleActiveJob({ status: "queued", lease_until: null, updated_at: iso(NOW - STALE_ACTIVE_JOB_MS) }, NOW)).toBe(false);
    expect(isStaleActiveJob({ status: "queued", lease_until: null, updated_at: iso(NOW - STALE_ACTIVE_JOB_MS - 1) }, NOW)).toBe(true);
  });
  it("a lease decides over updated_at (a renewed lease keeps an old row active), as in the watchdog's query", () => {
    expect(isStaleActiveJob({ status: "running", lease_until: iso(NOW + 1000), updated_at: iso(NOW - 24 * 3600_000) }, NOW)).toBe(false);
    expect(isStaleActiveJob({ status: "running", lease_until: iso(NOW - 3600_000), updated_at: iso(NOW) }, NOW)).toBe(true);
  });
  it("rows without a usable time, and other statuses, never inflate or hide anything unexpectedly", () => {
    expect(countActiveJobs([{ status: "running" }, { status: "queued", lease_until: undefined, updated_at: "not a date" }], NOW)).toBe(2);
    expect(countActiveJobs([{ status: "completed", lease_until: null, updated_at: iso(NOW) }, { status: "failed" }, { status: "cancelled" }], NOW)).toBe(0);
    expect(countActiveJobs(null, NOW)).toBe(0);
    expect(countActiveJobs(undefined, NOW)).toBe(0);
  });
  it("is read only and never edits a row", () => {
    const rows = FIXTURES.map((r) => ({ ...r }));
    countActiveJobs(rows, NOW);
    expect(rows).toEqual(FIXTURES);
  });
});

describe("getBusyState uses it (busy copy shows the real queue)", () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => { (process.env as any).NODE_ENV = originalEnv; });

  function adminWith(jobs: any[], spendUsd = 0, capUsd = 0.001) {
    // daily cap exhausted (cap 0.001, spend 0.5 handled by the provider gate fake below is not needed: we read the queue through the busy message)
    return {
      from: (table: string) => ({
        select: () => ({
          in: async () => ({ data: table === "jobs" ? jobs : [], error: null }),
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }), then: (r: any) => r({ data: [], error: null }) }),
          then: (r: any) => r({ data: [], error: null }),
        }),
      }),
      rpc: async () => ({ data: null, error: null }),
    } as any;
  }

  it("source: the busy read asks for rows and counts them through countActiveJobs (not a bare count of statuses)", () => {
    const src = readFileSync("src/lib/server/busyState.ts", "utf8");
    expect(src).toContain("countActiveJobs(");
    expect(src).not.toMatch(/head:\s*true/);
  });

  it("source: the stale window is the watchdog's own 30 minutes and the same two columns", () => {
    const wd = readFileSync("src/app/api/cron/watchdog/route.ts", "utf8");
    expect(wd).toContain("30 * 60 * 1000");
    expect(wd).toContain("lease_until.lt.");
    expect(wd).toContain("and(lease_until.is.null,updated_at.lt.");
    const mod = readFileSync("src/lib/jobs/activeJobs.ts", "utf8");
    expect(mod).toContain("30 * 60 * 1000");
    expect(mod).toContain("lease_until");
    expect(mod).toContain("updated_at");
  });

  it("the real read: with production's nine fixtures and nothing else the queue is empty (queueAhead 0)", async () => {
    (process.env as any).NODE_ENV = "production";
    setBusyStateForTesting(undefined);
    const state = await getBusyState(adminWith(FIXTURES), NOW);
    expect(state.queueAhead).toBe(0);
    expect(state.position).toBe(1);
  });

  it("the real read keeps real work: two live jobs among the fixtures give queueAhead 2, position 3", async () => {
    (process.env as any).NODE_ENV = "production";
    setBusyStateForTesting(undefined);
    const real = [
      { status: "running", lease_until: iso(NOW + 30_000), updated_at: iso(NOW - 1000) },
      { status: "queued", lease_until: null, updated_at: iso(NOW - 60_000) },
    ];
    const state = await getBusyState(adminWith([...FIXTURES, ...real]), NOW);
    expect(state.queueAhead).toBe(2);
    expect(state.position).toBe(3);
  });

  it("a failed jobs read counts as no queue and never throws", async () => {
    (process.env as any).NODE_ENV = "production";
    setBusyStateForTesting(undefined);
    const admin: any = {
      from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: "boom" } }), eq: () => ({ maybeSingle: async () => ({ data: null }) }), then: (r: any) => r({ data: [], error: null }) }) }),
      rpc: async () => ({ data: null, error: null }),
    };
    const state = await getBusyState(admin, NOW);
    expect(state.queueAhead).toBe(0);
  });
});
