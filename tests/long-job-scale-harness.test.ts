import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/supabase/server", async () => (await import("./helpers/scaleHarness")).supabaseServerMock());
vi.mock("../src/lib/server/sendPlatformEmail", async () => (await import("./helpers/scaleHarness")).sendPlatformEmailMock());
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

import { FakeProvider, advance, calls, db, driveToTheEnd, finalRows, installProvider, jobRow, seedSocialJob, setupEnv, type FakeFailure } from "./helpers/scaleHarness";
import { chunkMarksFromEvents, computeJobProgress } from "../src/lib/jobProgress";
import { setScaleOverridesForTesting, scaleValue, effectiveSocialMaxRows, SCALE_SPECS } from "../src/lib/scaleConfig";
import { ABSOLUTE_MAX_PAGES, LARGE_JOB_PAGE_ALLOWANCE, maxPagesForJob } from "../src/lib/server/providerCallCaps";
import { SOCIAL_ROWS_PER_CHUNK, getSocialCapability } from "../src/lib/socialSources";

let restore: () => void;
beforeEach(() => { restore = setupEnv(); });
afterEach(() => { setScaleOverridesForTesting(null); restore(); });

const settledOnce = (jobId: string) => {
  expect(calls("settle_job_atomic")).toHaveLength(1);
  expect(calls("release_job_atomic")).toHaveLength(0);
  const job = jobRow(jobId);
  expect(job.status).toBe("completed");
  // charge = ceil(delivered unique matching units x unit price), never above the reserve
  expect(job.charged).toBe(Math.min(Math.ceil(job.delivered_units * db.unitPrice), db.reserved));
  expect(job.charged).toBeLessThanOrEqual(db.reserved);
  return job;
};

describe("the configuration of the ceilings: the defaults are today's numbers", () => {
  it("every ceiling defaults to what the platform runs on, and every value is clamped", () => {
    const empty = {} as Record<string, string | undefined>;
    expect(scaleValue("absoluteMaxPages", empty)).toBe(300);
    expect(scaleValue("largeJobPageAllowance", empty)).toBe(6);
    expect(scaleValue("maxPerVideo", empty)).toBe(500);
    expect(scaleValue("maxVideosPerJob", empty)).toBe(20);
    expect(scaleValue("socialMaxRows", empty)).toBe(0);
    expect(ABSOLUTE_MAX_PAGES).toBe(300);
    expect(LARGE_JOB_PAGE_ALLOWANCE).toBe(6);
    expect(scaleValue("absoluteMaxPages", { LONG_JOB_MAX_PAGES: "100000" })).toBe(SCALE_SPECS.absoluteMaxPages.max);
    expect(scaleValue("absoluteMaxPages", { LONG_JOB_MAX_PAGES: "0" })).toBe(1);
    expect(scaleValue("absoluteMaxPages", { LONG_JOB_MAX_PAGES: "abc" })).toBe(300);
    expect(scaleValue("absoluteMaxPages", { LONG_JOB_MAX_PAGES: "120" })).toBe(120);
  });

  it("the social row ceiling is raised only for the services that can serve it, and never lowered", () => {
    const env = { LONG_JOB_SOCIAL_MAX_ROWS: "20000" };
    expect(effectiveSocialMaxRows(1000, "comments", env)).toBe(20000);
    expect(effectiveSocialMaxRows(500, "posts", env)).toBe(20000);
    expect(effectiveSocialMaxRows(200, "videos", env)).toBe(200);
    expect(effectiveSocialMaxRows(60, "posts", env)).toBe(60); // source-limited
    expect(effectiveSocialMaxRows(1000, "comments", { LONG_JOB_SOCIAL_MAX_ROWS: "10" })).toBe(1000);
    expect(effectiveSocialMaxRows(1000, "comments", {})).toBe(1000);
    // with nothing set, the services keep their documented ceilings
    // the ceilings are what the 600-point cap holds: 1,897 comments, 4,453 X posts
    expect(getSocialCapability("social-tiktok-comments")!.maxRows).toBe(2000);
    expect(getSocialCapability("social-youtube-comments")!.maxRows).toBe(2000);
    expect(getSocialCapability("social-x-posts")!.maxRows).toBe(4500);
    expect(getSocialCapability("social-facebook-posts")!.maxRows).toBe(60);
    expect(getSocialCapability("social-youtube-videos")?.maxRows ?? 48).toBe(48);
  });

  it("the test override moves the page ceiling and is ignored in production", () => {
    expect(maxPagesForJob(5000, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(300);
    setScaleOverridesForTesting({ absoluteMaxPages: 30 });
    expect(maxPagesForJob(5000, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(30);
    setScaleOverridesForTesting({ absoluteMaxPages: 400 });
    expect(maxPagesForJob(5000, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(400); // ceil(5000/50) x allowance 6 = 600, held at the new ceiling of 400
    expect(scaleValue("absoluteMaxPages", { NODE_ENV: "production" })).toBe(300);
  });

  it("the page ceiling times the rows of a chunk is the real size limit of a feed job today (300 x 50 = 15,000; it was 30 x 50 = 1,500)", () => {
    expect(maxPagesForJob(50_000, SOCIAL_ROWS_PER_CHUNK, "feed") * SOCIAL_ROWS_PER_CHUNK).toBe(15000);
    // a full 600-point job fits: 4,453 X posts need 90 pages (540 with the slack of 6, so the ceiling of 300 binds), 1,897 comments 38 pages (228)
    expect(maxPagesForJob(4453, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(300);
    expect(maxPagesForJob(1897, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(228);
  });
});

describe("a job through the real worker, the real social chain and a fake provider", () => {
  it("collects the records chunk by chunk with the page closed, delivers each record once, settles once", async () => {
    const provider = new FakeProvider({ commentsPerVideo: 100, videos: 3, pageSize: 20, duplicateEvery: 2, overlap: 5 });
    installProvider(provider);
    const jobId = seedSocialJob({ target: 120, videoCount: 3, perVideo: 50 });
    const run = await driveToTheEnd(jobId);
    expect(run.finalStatus).toBe("completed");
    expect(run.chunks).toBe(3);
    const rows = finalRows(jobId);
    expect(rows).toHaveLength(120);
    expect(new Set(rows.map((row) => row.comment_id)).size).toBe(120); // the repeated records at page edges were dropped
    expect(jobRow(jobId).delivered_units).toBe(120);
    settledOnce(jobId);
  });

  it("every chunk ends inside the time limit even when the source is slow (a chunk stops starting calls in time)", async () => {
    const provider = new FakeProvider({ commentsPerVideo: 200, videos: 4, pageSize: 20, latencySeconds: 12 });
    installProvider(provider);
    const jobId = seedSocialJob({ target: 200, videoCount: 4, perVideo: 50 });
    await driveToTheEnd(jobId);
    expect(db.chunkSeconds.length).toBeGreaterThan(1);
    for (const seconds of db.chunkSeconds) expect(seconds).toBeLessThanOrEqual(45);
    settledOnce(jobId);
  });

  it("repeated records and a repeated page across chunks are neither delivered nor billed twice", async () => {
    const provider = new FakeProvider({ commentsPerVideo: 120, videos: 2, pageSize: 20, duplicateEvery: 1, overlap: 10 });
    installProvider(provider);
    const jobId = seedSocialJob({ target: 200, videoCount: 2, perVideo: 100 });
    await driveToTheEnd(jobId);
    const rows = finalRows(jobId);
    expect(new Set(rows.map((row) => row.comment_id)).size).toBe(rows.length);
    expect(rows.length).toBe(jobRow(jobId).delivered_units);
    expect(rows.length).toBeLessThanOrEqual(200);
    settledOnce(jobId);
  });

  it("the progress line is built from the real chunk times of the run, in plain Arabic", async () => {
    const provider = new FakeProvider({ commentsPerVideo: 400, videos: 4, pageSize: 20 });
    installProvider(provider);
    const jobId = seedSocialJob({ target: 400, videoCount: 4, perVideo: 100 });
    let seen = 0;
    await driveToTheEnd(jobId, { beforeTick: () => { seen += 1; } });
    expect(seen).toBeGreaterThan(4);
    // replay the page events up to the middle of the job: the line shows how much is done and a labelled remaining time
    const pages = db.events.filter((event) => String(event.message).startsWith("الصفحة"));
    const marks = chunkMarksFromEvents(pages.slice(0, 5));
    const progress = computeJobProgress({ delivered: 250, target: 400, marks });
    expect(progress.lineAr).toContain("تم ٢٥٠ من ٤٠٠");
    for (const text of [progress.lineAr, progress.remainingAr ?? ""]) {
      expect(text).not.toMatch(/[A-Za-z0-9]|undefined|null|NaN/);
    }
    settledOnce(jobId);
  });
});

describe("what the ceilings do to a big job today, and what raising them does", () => {
  const big = () => new FakeProvider({ commentsPerVideo: 150, videos: 20, pageSize: 20 });

  it("a page ceiling of 30 (the previous default) stops a 3,000-record job at what it has (1,500), settled once for the delivered rows only", async () => {
    setScaleOverridesForTesting({ absoluteMaxPages: 30 });
    installProvider(big());
    const jobId = seedSocialJob({ target: 3000, videoCount: 20, perVideo: 150 });
    const run = await driveToTheEnd(jobId, { maxTicks: 120 });
    expect(run.finalStatus).toBe("completed");
    expect(run.chunks).toBe(30);
    const job = settledOnce(jobId);
    expect(job.delivered_units).toBe(1500);
    expect(finalRows(jobId)).toHaveLength(1500);
    expect(job.delivered_units).toBeLessThan(3000);
  });

  it("DEFAULT ceilings: the same 3,000-record job reaches its full 3,000 through 60 chunks", async () => {
    installProvider(big());
    const jobId = seedSocialJob({ target: 3000, videoCount: 20, perVideo: 150 });
    const run = await driveToTheEnd(jobId, { maxTicks: 200 });
    expect(run.finalStatus).toBe("completed");
    expect(run.chunks).toBe(60);
    expect(settledOnce(jobId).delivered_units).toBe(3000);
  }, 60_000);

  it("RAISED page ceiling (test config only): the same job reaches its full 3,000 through 60 chunks", async () => {
    setScaleOverridesForTesting({ absoluteMaxPages: 200 });
    installProvider(big());
    const jobId = seedSocialJob({ target: 3000, videoCount: 20, perVideo: 150 });
    const run = await driveToTheEnd(jobId, { maxTicks: 200 });
    expect(run.finalStatus).toBe("completed");
    expect(run.chunks).toBe(60);
    const job = settledOnce(jobId);
    expect(job.delivered_units).toBe(3000);
    const rows = finalRows(jobId);
    expect(new Set(rows.map((row) => row.comment_id)).size).toBe(3000);
    for (const seconds of db.chunkSeconds) expect(seconds).toBeLessThanOrEqual(45);
  }, 60_000);
});

describe("a source that fails or a budget that closes mid-job: partial settlement through the existing path", () => {
  const failures: Array<[string, FakeFailure]> = [["429", { kind: "429" }], ["402", { kind: "402" }], ["503", { kind: "503" }], ["timeout", { kind: "timeout" }]];
  for (const [label, failure] of failures) {
    it(`${label} after the first chunks: what was delivered is settled once, nothing is released, no further charge`, async () => {
      const provider = new FakeProvider({ commentsPerVideo: 200, videos: 4, pageSize: 20, failFrom: { call: 7, failure } });
      installProvider(provider);
      const jobId = seedSocialJob({ target: 400, videoCount: 4, perVideo: 100 });
      const run = await driveToTheEnd(jobId, { maxTicks: 40 });
      expect(run.finalStatus).toBe("completed");
      const job = settledOnce(jobId);
      expect(job.delivered_units).toBeGreaterThan(0);
      expect(job.delivered_units).toBeLessThan(400);
      const rows = finalRows(jobId);
      expect(rows).toHaveLength(job.delivered_units);
      expect(new Set(rows.map((row) => row.comment_id)).size).toBe(rows.length);
    });
  }

  it("the source fails from the very first call: the whole reserve is released, nothing is charged, and the job is left alone", async () => {
    installProvider(new FakeProvider({ commentsPerVideo: 100, videos: 2, failFrom: { call: 1, failure: { kind: "503" } } }));
    const jobId = seedSocialJob({ target: 100, videoCount: 2, perVideo: 50 });
    const run = await driveToTheEnd(jobId, { maxTicks: 10 });
    expect(run.finalStatus).toBe("failed");
    expect(calls("release_job_atomic").length).toBeGreaterThanOrEqual(1);
    expect(calls("settle_job_atomic")).toHaveLength(0);
    expect(jobRow(jobId).charged).toBe(0);
  });

  it("the daily provider budget closes mid-job: no further call, the delivered rows are settled once", async () => {
    const provider = new FakeProvider({ commentsPerVideo: 200, videos: 4, pageSize: 20 });
    installProvider(provider);
    const jobId = seedSocialJob({ target: 400, videoCount: 4, perVideo: 100 });
    await driveToTheEnd(jobId, { beforeTick: (i) => { if (i === 3) db.spendAllowed = false; }, maxTicks: 30 });
    const callsWhenClosed = provider.callCount;
    const job = settledOnce(jobId);
    expect(job.delivered_units).toBeGreaterThan(0);
    expect(job.delivered_units).toBeLessThan(400);
    expect(provider.callCount).toBe(callsWhenClosed);
  });

  it("an instance that dies holding the lease is waited out, then resumed: no record twice, charged once", async () => {
    installProvider(new FakeProvider({ commentsPerVideo: 100, videos: 3, pageSize: 20 }));
    const jobId = seedSocialJob({ target: 150, videoCount: 3, perVideo: 50 });
    const admin = (await import("../src/lib/supabase/server")).createAdminClient();
    const run = await driveToTheEnd(jobId, {
      beforeTick: async (i) => {
        if (i === 1) await admin.rpc("claim_job_chunk", { p_job_id: jobId, p_expected_step: jobRow(jobId).step, p_lease_seconds: 60 }); // takes the lease and dies
      },
    });
    expect(run.finalStatus).toBe("completed");
    expect(db.claimsRefused).toContain("lease_held");
    const rows = finalRows(jobId);
    expect(new Set(rows.map((row) => row.comment_id)).size).toBe(rows.length);
    expect(rows).toHaveLength(150);
    settledOnce(jobId);
  });
});
