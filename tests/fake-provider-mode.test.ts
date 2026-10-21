import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/supabase/server", async () => (await import("./helpers/scaleHarness")).supabaseServerMock());
vi.mock("../src/lib/server/sendPlatformEmail", async () => (await import("./helpers/scaleHarness")).sendPlatformEmailMock());
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

import { calls, db, driveToTheEnd, finalRows, jobRow, seedSocialJob, setupEnv } from "./helpers/scaleHarness";
import { PRODUCTION_DATABASE_REF, fakeProviderActive, fakeProviderOffReason } from "../src/lib/server/fakeProviderMode";
import { setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";

const TEST_URL = "https://abcdefghijklmnop.supabase.co";

describe("the fake provider is on only for the pressure test: a preview deployment, the flag, and not the live database", () => {
  const on = { PRESSURE_FAKE_PROVIDER: "on", VERCEL_ENV: "preview", NEXT_PUBLIC_SUPABASE_URL: TEST_URL };
  it("every missing or wrong part switches it off", () => {
    expect(fakeProviderActive(on)).toBe(true);
    expect(fakeProviderActive({})).toBe(false);
    expect(fakeProviderActive({ ...on, PRESSURE_FAKE_PROVIDER: "true" })).toBe(false);
    expect(fakeProviderActive({ ...on, PRESSURE_FAKE_PROVIDER: "ON" })).toBe(false);
    expect(fakeProviderActive({ ...on, VERCEL_ENV: "production" })).toBe(false);
    expect(fakeProviderActive({ ...on, VERCEL_ENV: "development" })).toBe(false);
    expect(fakeProviderActive({ ...on, VERCEL_ENV: undefined })).toBe(false);
    expect(fakeProviderActive({ ...on, NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_DATABASE_REF}.supabase.co` })).toBe(false);
    expect(fakeProviderOffReason({ ...on, VERCEL_ENV: "production" })).toBe("not_a_preview_deployment");
    expect(fakeProviderOffReason({ ...on, NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_DATABASE_REF}.supabase.co` })).toBe("production_database");
    expect(fakeProviderOffReason(on)).toBeNull();
  });
});

describe("a job on a preview deployment with the flag runs through the REAL worker on the fake source, and settles once", () => {
  let restore: () => void;
  const saved = { ...process.env };
  beforeEach(() => {
    restore = setupEnv();
    setProviderAdapterForTesting(null);
    (process.env as any).NODE_ENV = "production";
    delete process.env.ENABLE_MOCK_PROVIDER;
    process.env.VERCEL_ENV = "preview";
    process.env.PRESSURE_FAKE_PROVIDER = "on";
    process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_URL;
    process.env.FAKE_PROVIDER_LATENCY_MS = "0";
  });
  afterEach(() => { restore(); setProviderAdapterForTesting(null); process.env = { ...saved }; });

  it("collects, delivers each record once, settles once and never charges above the reserve", async () => {
    const jobId = seedSocialJob({ target: 60, videoCount: 2, perVideo: 30 });
    const run = await driveToTheEnd(jobId);
    expect(run.finalStatus).toBe("completed");
    expect(jobRow(jobId).delivered_units).toBeGreaterThan(0);
    expect(calls("settle_job_atomic")).toHaveLength(1);
    expect(calls("release_job_atomic")).toHaveLength(0);
    const job = jobRow(jobId);
    expect(job.charged).toBe(Math.min(Math.ceil(job.delivered_units * db.unitPrice), db.reserved));
    const ids = finalRows(jobId).map((row: any) => row.comment_id ?? row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("without the flag, or against the live database, the worker refuses the mock and nothing is delivered from a fake source", async () => {
    for (const change of [{ PRESSURE_FAKE_PROVIDER: "" }, { NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_DATABASE_REF}.supabase.co` }, { VERCEL_ENV: "production" }]) {
      Object.assign(process.env, change);
      setProviderAdapterForTesting(null);
      const jobId = seedSocialJob({ target: 30, videoCount: 1, perVideo: 30, quoteId: `quote_${Math.random().toString(36).slice(2, 8)}` });
      const run = await driveToTheEnd(jobId, { maxTicks: 6 });
      expect(jobRow(jobId)?.delivered_units ?? 0, JSON.stringify(change)).toBe(0);
      expect(run.finalStatus, JSON.stringify(change)).not.toBe("completed");
      process.env.PRESSURE_FAKE_PROVIDER = "on";
      process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_URL;
      process.env.VERCEL_ENV = "preview";
    }
  });
});
