import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/supabase/server", async () => (await import("./helpers/scaleHarness")).supabaseServerMock());
vi.mock("../src/lib/server/sendPlatformEmail", async () => (await import("./helpers/scaleHarness")).sendPlatformEmailMock());
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

import { FakeProvider, advance, callWorker, db, installProvider, jobRow, seedSocialJob, setupEnv } from "./helpers/scaleHarness";
import { recordSamples, type CpuSample } from "./helpers/cpuMeter";

let restore: () => void;
beforeEach(() => { restore = setupEnv(); });
afterEach(() => restore());

const cpuMs = (usage: NodeJS.CpuUsage) => (usage.user + usage.system) / 1000;

/** Drives one job to the end, one worker call at a time, measuring the CPU of every call. */
async function missionCpu(target: number, formats: string[]) {
  installProvider(new FakeProvider({ commentsPerVideo: 100, videos: 3, pageSize: 20, duplicateEvery: 0, overlap: 0 }));
  const jobId = seedSocialJob({ target, videoCount: 2, perVideo: Math.ceil(target / 2), outputFormats: formats });
  const perCall: number[] = [];
  for (let i = 0; i < 60; i += 1) {
    const job = jobRow(jobId);
    if (!job || !["queued", "running"].includes(job.status)) break;
    const before = process.cpuUsage();
    await callWorker(jobId);
    perCall.push(cpuMs(process.cpuUsage(before)));
    advance(60_000);
  }
  return { perCall, status: jobRow(jobId)?.status, delivered: jobRow(jobId)?.delivered_units ?? 0 };
}

describe("raw CPU of a whole mission through the real worker (milliseconds on this machine)", () => {
  it("a 100-row mission with a CSV, with Excel, with Excel and PDF: calls, CPU per call, the last call (files and settlement) apart", async () => {
    const out: CpuSample[] = [];
    const extra: Record<string, unknown> = {};
    for (const [name, formats] of [["mission_csv", ["csv"]], ["mission_xlsx", ["xlsx"]], ["mission_xlsx_pdf", ["xlsx", "pdf"]]] as Array<[string, string[]]>) {
      // one warm-up mission so module loading is not charged to the first measured one
      if (name === "mission_csv") { await missionCpu(100, formats); db.jobs.length = 0; db.quotes.length = 0; }
      const run = await missionCpu(100, formats);
      expect(run.status, name).toBe("completed");
      expect(run.delivered, name).toBeGreaterThan(0);
      const total = run.perCall.reduce((a, b) => a + b, 0);
      const last = run.perCall[run.perCall.length - 1];
      const sorted = [...run.perCall].sort((a, b) => a - b);
      out.push({ name, runs: run.perCall.length, medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] * 1000) / 1000, p90Ms: Math.round(sorted[sorted.length - 1] * 1000) / 1000, meanMs: Math.round((total / run.perCall.length) * 1000) / 1000 });
      extra[name] = { calls: run.perCall.length, totalMs: Math.round(total * 100) / 100, lastCallMs: Math.round(last * 100) / 100, firstCallMs: Math.round(run.perCall[0] * 100) / 100 };
      restore(); restore = setupEnv();
    }
    recordSamples(process.env.CPU_OUT, out, extra);
    console.log(JSON.stringify(extra));
  }, 180_000);
});
