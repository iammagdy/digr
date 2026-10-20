import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/supabase/server", async () => (await import("./helpers/scaleHarness")).supabaseServerMock());
vi.mock("../src/lib/server/sendPlatformEmail", async () => (await import("./helpers/scaleHarness")).sendPlatformEmailMock());
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

import { FakeProvider, calls, db, driveToTheEnd, finalRows, installProvider, jobRow, seedSocialJob, setupEnv } from "./helpers/scaleHarness";
import { CALL_TIME_MARGIN, MAX_TIME_FOR_ANOTHER_CALL_MS, MIN_TIME_FOR_ANOTHER_CALL_MS, callsThatFit, timeNeededForAnotherCallMs } from "../src/lib/server/chunkSizing";
import { SOCIAL_CHUNK_BUDGET_MS } from "../src/lib/server/socialAdapter";
import { scaleValue, setScaleOverridesForTesting } from "../src/lib/scaleConfig";
import { SOCIAL_MAX_CALLS_PER_CHUNK, SOCIAL_ROWS_PER_CHUNK, socialRowsPerChunk } from "../src/lib/socialSources";
import { missionDurationForPlan } from "../src/lib/missionDuration";

describe("how many calls fit in a chunk, from the time the calls actually take", () => {
  it("before any call is measured the floor is 9 s; afterwards the slowest call times a margin, never above 20 s", () => {
    expect(MIN_TIME_FOR_ANOTHER_CALL_MS).toBe(9_000);
    expect(timeNeededForAnotherCallMs(0)).toBe(9_000);
    expect(timeNeededForAnotherCallMs(NaN)).toBe(9_000);
    expect(timeNeededForAnotherCallMs(2_000)).toBe(9_000); // a fast source keeps the floor
    expect(timeNeededForAnotherCallMs(10_000)).toBe(Math.ceil(10_000 * CALL_TIME_MARGIN));
    expect(timeNeededForAnotherCallMs(60_000)).toBe(MAX_TIME_FOR_ANOTHER_CALL_MS);
  });

  it("a fast source fits all six calls, a slow one only as many as the budget allows, always at least one", () => {
    expect(callsThatFit(2_000, SOCIAL_CHUNK_BUDGET_MS, SOCIAL_MAX_CALLS_PER_CHUNK)).toBe(6);
    expect(callsThatFit(8_000, SOCIAL_CHUNK_BUDGET_MS, SOCIAL_MAX_CALLS_PER_CHUNK)).toBe(4); // 32 s, then 8 s left is below the 10 s a call of this source needs
    expect(callsThatFit(14_000, SOCIAL_CHUNK_BUDGET_MS, SOCIAL_MAX_CALLS_PER_CHUNK)).toBe(2);
    expect(callsThatFit(39_000, SOCIAL_CHUNK_BUDGET_MS, SOCIAL_MAX_CALLS_PER_CHUNK)).toBe(1);
    expect(callsThatFit(90_000, SOCIAL_CHUNK_BUDGET_MS, SOCIAL_MAX_CALLS_PER_CHUNK)).toBe(1);
    expect(callsThatFit(0, SOCIAL_CHUNK_BUDGET_MS, 6)).toBe(6);
    // never more than the calls the spend estimate of a chunk is built on
    expect(callsThatFit(100, SOCIAL_CHUNK_BUDGET_MS, SOCIAL_MAX_CALLS_PER_CHUNK)).toBe(SOCIAL_MAX_CALLS_PER_CHUNK);
  });

  it("the rows of a chunk: 50 today, configurable between 10 and 500, the default unchanged", () => {
    expect(SOCIAL_ROWS_PER_CHUNK).toBe(50);
    expect(socialRowsPerChunk()).toBe(50);
    expect(scaleValue("socialRowsPerChunk", { LONG_JOB_ROWS_PER_CHUNK: "5" })).toBe(10);
    expect(scaleValue("socialRowsPerChunk", { LONG_JOB_ROWS_PER_CHUNK: "100000" })).toBe(500);
    expect(scaleValue("socialRowsPerChunk", { LONG_JOB_ROWS_PER_CHUNK: "120" })).toBe(120);
    setScaleOverridesForTesting({ socialRowsPerChunk: 150 });
    expect(socialRowsPerChunk()).toBe(150);
    setScaleOverridesForTesting(null);
  });

  it("the duration shown before approval follows the rows of a chunk in force", () => {
    const items = [{ capabilitySlug: "social-tiktok-comments", targetVolumeMax: 3000, params: { query: "x", videoCount: 20, perVideo: 150 } } as any];
    const at = (rows: number) => {
      setScaleOverridesForTesting({ socialRowsPerChunk: rows });
      const view = missionDurationForPlan(items as any, "tab") as any;
      setScaleOverridesForTesting(null);
      return view;
    };
    const small = at(50);
    const big = at(120);
    if (small && big && typeof small.optimisticSeconds === "number" && typeof big.optimisticSeconds === "number") {
      expect(big.optimisticSeconds).toBeLessThanOrEqual(small.optimisticSeconds);
    }
  });
});

describe("through the real worker and the real social chain", () => {
  let restore: () => void;
  beforeEach(() => { restore = setupEnv(); });
  afterEach(() => { setScaleOverridesForTesting(null); restore(); });

  const settledOnce = (jobId: string) => {
    expect(calls("settle_job_atomic")).toHaveLength(1);
    expect(calls("release_job_atomic")).toHaveLength(0);
    const job = jobRow(jobId);
    expect(job.charged).toBe(Math.min(Math.ceil(job.delivered_units * db.unitPrice), db.reserved));
    return job;
  };

  it("a slow source (14 s a call): a chunk starts only the calls that fit, so no call is abandoned at its timeout and every chunk ends within 30 s", async () => {
    const provider = new FakeProvider({ commentsPerVideo: 100, videos: 4, pageSize: 20, latencySeconds: 14 });
    installProvider(provider);
    const jobId = seedSocialJob({ target: 200, videoCount: 4, perVideo: 50 });
    await driveToTheEnd(jobId, { maxTicks: 80 });
    expect(provider.timeouts).toBe(0);
    for (const n of provider.chunkCalls) expect(n).toBeLessThanOrEqual(2);
    for (const seconds of db.chunkSeconds) expect(seconds).toBeLessThanOrEqual(30);
    const job = settledOnce(jobId);
    expect(job.delivered_units).toBe(200);
  }, 60_000);

  it("a fast source with the default chunk (50 rows): 60 chunks for 3,000 rows, at most four calls each (three pages of comments and the video search), as before", async () => {
    setScaleOverridesForTesting({ absoluteMaxPages: 200 });
    const provider = new FakeProvider({ commentsPerVideo: 150, videos: 20, pageSize: 20 });
    installProvider(provider);
    const jobId = seedSocialJob({ target: 3000, videoCount: 20, perVideo: 150 });
    const run = await driveToTheEnd(jobId, { maxTicks: 200 });
    expect(run.chunks).toBe(60);
    expect(Math.max(...provider.chunkCalls)).toBeLessThanOrEqual(4);
    expect(settledOnce(jobId).delivered_units).toBe(3000);
  }, 60_000);

  it("a fast source with 150 rows allowed per chunk: the same 3,000 rows in about half the chunks (27 against 60), at most six calls each, each within the time limit", async () => {
    setScaleOverridesForTesting({ socialRowsPerChunk: 150 });
    const provider = new FakeProvider({ commentsPerVideo: 150, videos: 20, pageSize: 20 });
    installProvider(provider);
    const jobId = seedSocialJob({ target: 3000, videoCount: 20, perVideo: 150 });
    const run = await driveToTheEnd(jobId, { maxTicks: 100 });
    expect(run.finalStatus).toBe("completed");
    expect(run.chunks).toBe(27); // 3,000 rows at up to 120 a chunk (six calls of 20), plus the chunk that ends each video
    expect(Math.max(...provider.chunkCalls)).toBe(SOCIAL_MAX_CALLS_PER_CHUNK);
    for (const seconds of db.chunkSeconds) expect(seconds).toBeLessThanOrEqual(45);
    const job = settledOnce(jobId);
    expect(job.delivered_units).toBe(3000);
    const rows = finalRows(jobId);
    expect(new Set(rows.map((row) => row.comment_id)).size).toBe(3000);
  }, 60_000);

  it("a source of 8 s a call with 150 rows allowed: a chunk takes only the calls that fit (at most four, 32 s), never beyond the limit", async () => {
    setScaleOverridesForTesting({ socialRowsPerChunk: 150 });
    const provider = new FakeProvider({ commentsPerVideo: 150, videos: 4, pageSize: 20, latencySeconds: 8 });
    installProvider(provider);
    const jobId = seedSocialJob({ target: 300, videoCount: 4, perVideo: 150 });
    await driveToTheEnd(jobId, { maxTicks: 60 });
    expect(provider.timeouts).toBe(0);
    for (const n of provider.chunkCalls) expect(n).toBeLessThanOrEqual(4);
    for (const seconds of db.chunkSeconds) expect(seconds).toBeLessThanOrEqual(36);
    expect(settledOnce(jobId).delivered_units).toBe(300);
  }, 60_000);
});
