import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../src/lib/supabase/server", async () => (await import("./helpers/scaleHarness")).supabaseServerMock());
vi.mock("../src/lib/server/sendPlatformEmail", async () => (await import("./helpers/scaleHarness")).sendPlatformEmailMock());
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

import { FakeProvider, advance, calls, db, driveToTheEnd, finalRows, installProvider, jobRow, seedSocialJob, setupEnv } from "./helpers/scaleHarness";
import { setScaleOverridesForTesting } from "../src/lib/scaleConfig";
import { cursorKey, emptyRunningSet, extendRunningSet, loadRunningSet, rebuildRunningSet, runningSetKey, saveRunningSet } from "../src/lib/server/jobRunningSet";
import { dedupeIdentityFor } from "../src/lib/server/rowDedupe";

const identityOf = dedupeIdentityFor("social");

describe("the running set: pure behaviour", () => {
  const rows = (ids: string[]) => ids.map((id) => ({ comment_id: id }));

  it("extends chunk by chunk exactly like rebuilding from the chunks' own records", async () => {
    const chunks = [
      { cursor: "c1", rows: rows(["a", "b"]), uncertainRows: rows(["u1"]), batchUnits: 2 },
      { cursor: "c2", rows: rows(["c"]), uncertainRows: [], batchUnits: 1 },
      { cursor: "c3", rows: [], uncertainRows: [], batchUnits: 0 },
    ];
    let running = emptyRunningSet();
    chunks.forEach((chunk, step) => { running = extendRunningSet(running, step, chunk, identityOf); });
    const rebuilt = await rebuildRunningSet(chunks.length, identityOf, async (step) => chunks[step]);
    expect(rebuilt).toEqual(running);
    expect(running.batchUnits).toEqual([2, 1, 0]);
    expect(new Set(running.identities).size).toBe(running.identities.length);
    expect(running.identities.length).toBe(4); // a, b, c and the row sent to review
    expect(running.cursors).toEqual(["c1", "c2", "c3"]);
  });

  it("an unreadable chunk adds nothing and its row count stays unknown (never an empty page)", async () => {
    const state = await rebuildRunningSet(3, identityOf, async (step) => (step === 1 ? null : { cursor: `c${step}`, rows: rows([`r${step}`]), batchUnits: 1 }));
    expect(state.batchUnits).toEqual([1, null, 1]);
    expect(state.identities).toHaveLength(2);
    // a readable chunk with no list of rows is unknown too, not zero
    expect(extendRunningSet(emptyRunningSet(), 0, { cursor: "x" }, identityOf).batchUnits).toEqual([null]);
  });

  it("a long cursor is kept as a short hash, a short one as it is, and the same cursor always gives the same key", () => {
    const long = JSON.stringify({ ph: "c", refs: Array.from({ length: 80 }, (_, i) => ({ id: `${i}`.repeat(10) })) });
    expect(long.length).toBeGreaterThan(64);
    expect(cursorKey(long)).toMatch(/^h:[0-9a-f]{20}$/);
    expect(cursorKey(long)).toBe(cursorKey(long));
    expect(cursorKey(long + "x")).not.toBe(cursorKey(long));
    expect(cursorKey("42")).toBe("42");
  });

  it("only a snapshot of the right chunk, with the right shape, is trusted", async () => {
    const files = new Map<string, string>();
    const bucket: any = {
      upload: async (path: string, body: Buffer) => { files.set(path, body.toString()); return { error: null }; },
      download: async (path: string) => (files.has(path) ? { data: new Blob([files.get(path)!]), error: null } : { data: null, error: { message: "nf" } }),
    };
    const state = extendRunningSet(emptyRunningSet(), 0, { cursor: "c", rows: rows(["a"]), batchUnits: 1 }, identityOf);
    expect(await saveRunningSet(bucket, "job1", state)).toBe(true);
    expect(await loadRunningSet(bucket, "job1", 0)).toEqual(state);
    expect(await loadRunningSet(bucket, "job1", 1)).toBeNull(); // not written yet
    files.set(runningSetKey("job1", 2), JSON.stringify({ ...state, step: 1 })); // a file of another chunk
    expect(await loadRunningSet(bucket, "job1", 2)).toBeNull();
    files.set(runningSetKey("job1", 3), "{not json");
    expect(await loadRunningSet(bucket, "job1", 3)).toBeNull();
    files.set(runningSetKey("job1", 4), JSON.stringify({ step: 4, identities: [1], cursors: [], batchUnits: [] }));
    expect(await loadRunningSet(bucket, "job1", 4)).toBeNull();
    expect(await loadRunningSet(bucket, "job1", -1)).toEqual(emptyRunningSet());
    expect(await saveRunningSet({ upload: async () => { throw new Error("down"); } } as any, "job1", state)).toBe(false);
    expect(await saveRunningSet(undefined, "job1", state)).toBe(false);
  });
});

describe("the worker reads one running record per chunk, not every earlier chunk", () => {
  let restore: () => void;
  // these scenarios are about the running records, written for 50-row chunks: the chunk size is set explicitly (the platform default is now 100)
  beforeEach(() => { restore = setupEnv(); setScaleOverridesForTesting({ absoluteMaxPages: 200, socialRowsPerChunk: 50 }); });
  afterEach(() => { setScaleOverridesForTesting(null); restore(); });

  const settledOnce = (jobId: string) => {
    expect(calls("settle_job_atomic")).toHaveLength(1);
    expect(calls("release_job_atomic")).toHaveLength(0);
    const job = jobRow(jobId);
    expect(job.charged).toBe(Math.min(Math.ceil(job.delivered_units * db.unitPrice), db.reserved));
    return job;
  };

  it("a 60-chunk job downloads about one file per chunk to de-duplicate (before: 1,770), and delivers the same 3,000 unique rows", async () => {
    installProvider(new FakeProvider({ commentsPerVideo: 150, videos: 20, pageSize: 20, duplicateEvery: 3, overlap: 4 }));
    const jobId = seedSocialJob({ target: 3000, videoCount: 20, perVideo: 150 });
    const run = await driveToTheEnd(jobId, { maxTicks: 200 });
    expect(run.finalStatus).toBe("completed");
    expect(run.chunks).toBe(60);
    const job = settledOnce(jobId);
    expect(job.delivered_units).toBe(3000);
    const rows = finalRows(jobId);
    expect(rows).toHaveLength(3000);
    expect(new Set(rows.map((row) => row.comment_id)).size).toBe(3000);
    const dedupeReads = db.downloads.filter((d) => /seen_\d+\.json$/.test(d.path));
    const stepReads = db.downloads.filter((d) => /step_\d+\.json$/.test(d.path));
    expect(dedupeReads).toHaveLength(59); // chunk n reads seen_(n-1): one read per chunk after the first
    expect(stepReads).toHaveLength(60); // only the final assembly reads the chunks' files, once each
    const bytes = db.downloads.reduce((sum, d) => sum + d.bytes, 0);
    expect(bytes).toBeLessThan(6_000_000); // before: 33,000,000
  }, 60_000);

  it("the snapshots do not pile up: at most two exist while the job runs, none after it", async () => {
    installProvider(new FakeProvider({ commentsPerVideo: 100, videos: 4, pageSize: 20 }));
    const jobId = seedSocialJob({ target: 300, videoCount: 4, perVideo: 100 });
    let most = 0;
    await driveToTheEnd(jobId, { beforeTick: () => { most = Math.max(most, [...db.partials.keys()].filter((k) => /seen_\d+\.json$/.test(k)).length); } });
    expect(most).toBeLessThanOrEqual(2);
    expect([...db.partials.keys()].filter((k) => /seen_\d+\.json$/.test(k))).toHaveLength(0);
    settledOnce(jobId);
  });

  it("a lost or damaged running record is rebuilt from the chunks' files: exactly the rows of an untouched run, no duplicates, no failure", async () => {
    const run = async (tamper: boolean) => {
      db.jobs = []; db.rpcCalls = []; db.events = []; db.downloads = []; db.partials.clear(); db.results.clear(); db.claimsRefused = [];
      installProvider(new FakeProvider({ commentsPerVideo: 100, videos: 4, pageSize: 20, duplicateEvery: 2, overlap: 3 }));
      const jobId = seedSocialJob({ target: 300, videoCount: 4, perVideo: 100 });
      await driveToTheEnd(jobId, {
        beforeTick: (i) => {
          if (!tamper) return;
          if (i === 3) for (const key of [...db.partials.keys()]) if (/seen_\d+\.json$/.test(key)) db.partials.delete(key); // lost
          if (i === 5) for (const key of [...db.partials.keys()]) if (/seen_\d+\.json$/.test(key)) db.partials.set(key, Buffer.from("{damaged")); // damaged
        },
      });
      const job = settledOnce(jobId);
      return { delivered: job.delivered_units as number, ids: finalRows(jobId).map((row) => String(row.comment_id)), rebuildReads: db.downloads.filter((d) => /step_\d+\.json$/.test(d.path)).length };
    };
    const untouched = await run(false);
    const tampered = await run(true);
    expect(new Set(tampered.ids).size).toBe(tampered.ids.length);
    expect(tampered.ids).toEqual(untouched.ids);
    expect(tampered.delivered).toBe(untouched.delivered);
    expect(tampered.delivered).toBe(tampered.ids.length);
    expect(tampered.rebuildReads).toBeGreaterThan(untouched.rebuildReads); // the rebuild path read the chunks' own files
  });

  it("a job that started before the running record existed (chunk files only) finishes the same way", async () => {
    installProvider(new FakeProvider({ commentsPerVideo: 100, videos: 3, pageSize: 20 }));
    const jobId = seedSocialJob({ target: 200, videoCount: 3, perVideo: 100 });
    await driveToTheEnd(jobId, { beforeTick: () => { for (const key of [...db.partials.keys()]) if (/seen_\d+\.json$/.test(key)) db.partials.delete(key); } });
    const job = settledOnce(jobId);
    expect(job.delivered_units).toBe(200);
    expect(new Set(finalRows(jobId).map((row) => row.comment_id)).size).toBe(200);
  });

  it("a chunk that died after storing its files and before being recorded re-runs against the same earlier record: its own rows are not taken for duplicates", async () => {
    installProvider(new FakeProvider({ commentsPerVideo: 100, videos: 3, pageSize: 20 }));
    const jobId = seedSocialJob({ target: 300, videoCount: 4, perVideo: 100 });
    let before: { job: any; seen?: [string, Buffer] } | null = null;
    let rewound = false;
    await driveToTheEnd(jobId, {
      beforeTick: (i) => {
        if (i === 2) {
          const job = jobRow(jobId);
          const seenKey = [...db.partials.keys()].find((k) => /seen_\d+\.json$/.test(k));
          before = { job: { ...job }, seen: seenKey ? [seenKey, db.partials.get(seenKey)!] : undefined };
        }
        if (i === 3 && before && !rewound) {
          // chunk 3 ran and stored step_3 and seen_3, but complete_chunk never took effect: put the record back as it was
          rewound = true;
          Object.assign(jobRow(jobId), before.job);
          if (before.seen) db.partials.set(before.seen[0], before.seen[1]);
        }
      },
    });
    expect(rewound).toBe(true);
    const job = settledOnce(jobId);
    expect(job.delivered_units).toBe(300);
    const rows = finalRows(jobId);
    expect(rows).toHaveLength(300);
    expect(new Set(rows.map((row) => row.comment_id)).size).toBe(300);
  });

  it("the stop rule for pages that find nothing still sees the earlier pages: three empty pages in a row stop the job", async () => {
    installProvider(new FakeProvider({ commentsPerVideo: 40, videos: 2, pageSize: 20 }));
    const jobId = seedSocialJob({ target: 500, videoCount: 2, perVideo: 40 });
    await driveToTheEnd(jobId, { maxTicks: 50 });
    const job = jobRow(jobId);
    expect(job.status).toBe("completed");
    expect(job.delivered_units).toBe(80); // all the source holds; the job ended instead of paging forever
    settledOnce(jobId);
  });

  it("the per-page time estimate reads the newest page lines, so it follows the recent pace after many pages", async () => {
    installProvider(new FakeProvider({ commentsPerVideo: 150, videos: 20, pageSize: 20, latencySeconds: 2 }));
    const jobId = seedSocialJob({ target: 3000, videoCount: 20, perVideo: 150 });
    await driveToTheEnd(jobId, { maxTicks: 200 });
    const source = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(source).toContain("PAGE_EVENTS_FOR_ETA");
    expect(source).toContain('.order("created_at", { ascending: false })\n            .limit(PAGE_EVENTS_FOR_ETA)');
    expect(db.events.filter((event) => String(event.message).startsWith("الصفحة")).length).toBeGreaterThan(50);
    advance(1);
  }, 60_000);
});
