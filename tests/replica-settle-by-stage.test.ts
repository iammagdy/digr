import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replicaAvailable, startReplica, type ReplicaDb } from "./helpers/replicaDb";
import { acceptQuote, balanceOf, deliver, hash64, ledgerOf, seedUser, settle } from "./helpers/replicaMoney";

/**
 * DT-20261119-01 (Megz D-0103, D-0107): `settle_job_by_stage_atomic` on a REAL PostgreSQL with the production function bodies (tests/replica/prod-definitions) after the 25,000-cap record
 * (20261104222000) and the new migration, exactly as the owner would apply them. The money table of the g1 world (5 companies + 10 people, hold 2,569, charge at full 2,234, companies alone 373):
 * the companies' own unit 74.415, the people's unit (2,234 - 373) / 10 = 186.1. Skipped visibly when no local PostgreSQL server is installed.
 */
const MIG = (name: string) => readFileSync(path.resolve(__dirname, "../supabase/migrations", name), "utf8");
const PRICES = { base: 74.415, estimated: 186.1 };
const ROWS = { base: 5, estimated: 10 };

describe.skipIf(!replicaAvailable())("settle_job_by_stage_atomic on the replica", () => {
  let db: ReplicaDb;
  beforeAll(async () => {
    db = await startReplica();
    await db.reset({ extraSql: [MIG("20261104222000_record_production_quote_and_settle.sql"), MIG("20261119020000_settle_job_by_stage_atomic.sql")] });
  }, 90_000);
  afterAll(async () => { await db?.stop(); });

  async function startStaged(opts: { staged?: boolean; prices?: unknown; rows?: unknown; unit?: number; hold?: number } = {}) {
    const user = await seedUser(db.pool, 10_000);
    const quoteId = `quote_${randomUUID()}`;
    const item = { capabilitySlug: "agent-mission", endpointId: "agent-mission", targetVolumeMin: 1, targetVolumeMax: 15, unitPricePoints: opts.unit ?? 148.918671,
      ...(opts.staged === false ? {} : { stageUnitsPoints: opts.prices ?? PRICES, stageRowsPlanned: opts.rows ?? ROWS }) };
    await db.pool.query("select public.create_quote_atomic($1::uuid,$2,$3,$4::jsonb,$5::numeric,$6::text[],$7::timestamptz,'{}'::text[]) as r",
      [user, quoteId, hash64(quoteId), JSON.stringify([item]), opts.hold ?? 2569, ["xlsx"], new Date(Date.now() + 30 * 60_000).toISOString()]);
    const accepted = await acceptQuote(db.pool, user, quoteId);
    expect(accepted.success).toBe(true);
    return { user, jobId: accepted.job_id as string };
  }
  const byStage = async (jobId: string, base: number, estimated: number, cap = 25_000) =>
    (await db.pool.query("select public.settle_job_by_stage_atomic($1,$2::jsonb,$3::numeric,null) as r", [jobId, JSON.stringify({ base, estimated }), cap])).rows[0].r as Record<string, any>;

  it("(a) everything delivered: the charge is the card's full charge 2,234 (what the blended unit gives too), the rest of the hold is released", async () => {
    const { user, jobId } = await startStaged();
    await deliver(db.pool, jobId, 15);
    const r = await byStage(jobId, 5, 10);
    expect(r).toMatchObject({ success: true, charged_credits: 2234, reserved_credits: 2569, base_units: 5, estimated_units: 10 });
    const l = await ledgerOf(db.pool, jobId);
    expect(l.charge).toBe(-2234); expect(l.release).toBe(2569); expect(l.net).toBe(-2234);
    expect(await balanceOf(db.pool, user)).toBe(10_000 - 2234);
  });
  it("(b) no person delivered: the companies at their own unit, 5 x 74.415 = 373 (the blended unit would charge 745); the rest is released", async () => {
    const { jobId } = await startStaged();
    await deliver(db.pool, jobId, 5);
    const r = await byStage(jobId, 5, 0);
    expect(r).toMatchObject({ charged_credits: 373, reserved_credits: 2569 });
    const l = await ledgerOf(db.pool, jobId);
    expect(l.charge).toBe(-373); expect(l.release).toBe(2569); expect(l.net).toBe(-373);
  });
  it("(c) some people: delivered people x their unit + the companies x theirs: 5 companies + 4 people = ceil(372.075 + 744.4) = 1,117 (blended: 1,341)", async () => {
    const { jobId } = await startStaged();
    await deliver(db.pool, jobId, 9);
    expect(await byStage(jobId, 5, 4)).toMatchObject({ charged_credits: 1117 });
  });
  it("fewer companies than planned are charged in proportion to the companies' unit; an exact multiple has no rounding surprise", async () => {
    const { jobId } = await startStaged();
    await deliver(db.pool, jobId, 3);
    expect(await byStage(jobId, 3, 0)).toMatchObject({ charged_credits: 224 });
  });
  it("nothing delivered at all: no charge row (the whole hold is released), as in the live function", async () => {
    const { jobId } = await startStaged();
    await deliver(db.pool, jobId, 0);
    const r = await byStage(jobId, 0, 0);
    expect(r).toMatchObject({ charged_credits: 0 });
    const l = await ledgerOf(db.pool, jobId);
    expect(l.counts.charge).toBe(0); expect(l.release).toBe(2569);
  });
  it("the charge is never above the hold nor the cap, whatever the units say", async () => {
    const { jobId } = await startStaged({ prices: { base: 500, estimated: 500 }, unit: 500 });
    await deliver(db.pool, jobId, 15);
    expect(await byStage(jobId, 5, 10)).toMatchObject({ charged_credits: 2569 });
    const second = await startStaged();
    await deliver(db.pool, second.jobId, 15);
    expect(await byStage(second.jobId, 5, 10, 1000)).toMatchObject({ charged_credits: 1000 });
  });
  it("never more than the live function charges for the same delivery (the lower of the two): a plan whose people are CHEAPER than its companies (no contacts: companies 150, people 20, blended 63.333333, hold 1,093) charges the blended 317, not the by-stage 750", async () => {
    const world = { prices: { base: 150, estimated: 20 }, unit: 63.333333, hold: 1093 };
    const none = await startStaged(world); await deliver(db.pool, none.jobId, 5);
    expect(await byStage(none.jobId, 5, 0)).toMatchObject({ charged_credits: 317 });
    const half = await startStaged(world); await deliver(db.pool, half.jobId, 10);
    expect(await byStage(half.jobId, 5, 5)).toMatchObject({ charged_credits: 634 });
    const full = await startStaged(world); await deliver(db.pool, full.jobId, 15);
    expect(await byStage(full.jobId, 5, 10)).toMatchObject({ charged_credits: 950 });
    const plain = await startStaged({ ...world, staged: false }); await deliver(db.pool, plain.jobId, 5);
    expect((await settle(db.pool, plain.jobId, 25_000)).charged_credits).toBe(317);
  });
  it("a zero price for the companies is refused (it would charge nothing for rows delivered); a zero price for the people is allowed (the minimum charge alone can set the whole price)", async () => {
    const zero = await startStaged({ prices: { base: 0, estimated: 186.1 } }); await deliver(db.pool, zero.jobId, 5);
    await expect(byStage(zero.jobId, 5, 0)).rejects.toThrow(/no per-stage unit prices/);
    expect((await ledgerOf(db.pool, zero.jobId)).counts.charge).toBe(0);
    const ok = await startStaged({ prices: { base: 74.415, estimated: 0 } }); await deliver(db.pool, ok.jobId, 15);
    expect(await byStage(ok.jobId, 5, 10)).toMatchObject({ charged_credits: 373 });
  });
  it("refuses, and writes nothing, when: the counts do not add up to the rows the job recorded; a group exceeds what was sold; a count is negative or not a number; the quote has no per-stage prices", async () => {
    const a = await startStaged(); await deliver(db.pool, a.jobId, 9);
    await expect(byStage(a.jobId, 5, 5)).rejects.toThrow(/do not match job/);
    await expect(byStage(a.jobId, 9, 0)).rejects.toThrow(/do not match job/);
    await expect(db.pool.query("select public.settle_job_by_stage_atomic($1,'{\"base\":-1,\"estimated\":10}'::jsonb,25000,null)", [a.jobId])).rejects.toThrow(/Invalid delivered units/);
    await expect(db.pool.query("select public.settle_job_by_stage_atomic($1,'{\"base\":5}'::jsonb,25000,null)", [a.jobId])).rejects.toThrow(/Invalid delivered units/);
    await expect(db.pool.query("select public.settle_job_by_stage_atomic($1,'[1,2]'::jsonb,25000,null)", [a.jobId])).rejects.toThrow(/Invalid delivered units/);
    expect((await ledgerOf(db.pool, a.jobId)).counts.charge).toBe(0);
    expect((await ledgerOf(db.pool, a.jobId)).counts.release).toBe(0);
    const plain = await startStaged({ staged: false }); await deliver(db.pool, plain.jobId, 5);
    await expect(byStage(plain.jobId, 5, 0)).rejects.toThrow(/no per-stage unit prices/);
    const bad = await startStaged({ prices: { base: "x", estimated: 1 } }); await deliver(db.pool, bad.jobId, 5);
    await expect(byStage(bad.jobId, 5, 0)).rejects.toThrow(/no per-stage unit prices/);
    const l = await ledgerOf(db.pool, plain.jobId);
    expect(l.counts.charge).toBe(0);
  });
  it("settling twice is idempotent (already_settled, one charge row, one release row); the live function still settles a job that has no per-stage prices exactly as before", async () => {
    const { jobId } = await startStaged();
    await deliver(db.pool, jobId, 5);
    await byStage(jobId, 5, 0);
    expect(await byStage(jobId, 5, 0)).toMatchObject({ already_settled: true, charged_credits: 373 });
    const l = await ledgerOf(db.pool, jobId);
    expect(l.counts.charge).toBe(1); expect(l.counts.release).toBe(1);
    const plain = await startStaged({ staged: false });
    await deliver(db.pool, plain.jobId, 5);
    expect((await settle(db.pool, plain.jobId, 25_000)).charged_credits).toBe(745);
  });
  it("only the server role can run it", async () => {
    const r = await db.pool.query("select has_function_privilege('anon','public.settle_job_by_stage_atomic(text,jsonb,numeric,text)','EXECUTE') a, has_function_privilege('authenticated','public.settle_job_by_stage_atomic(text,jsonb,numeric,text)','EXECUTE') b, has_function_privilege('public','public.settle_job_by_stage_atomic(text,jsonb,numeric,text)','EXECUTE') c, has_function_privilege('service_role','public.settle_job_by_stage_atomic(text,jsonb,numeric,text)','EXECUTE') d");
    expect(r.rows[0]).toEqual({ a: false, b: false, c: false, d: true });
  });
});
