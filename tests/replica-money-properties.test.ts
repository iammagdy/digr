import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HELPER_SQL } from "../scripts/proposals/buildJobCapProposal";
import { DEFINITIONS_DIR, replicaAvailable, startReplica, type ReplicaDb } from "./helpers/replicaDb";
import {
  acceptQuote, balanceOf, createQuote, deliver, exactCharge, exactReserve, hash64, ledgerOf, mulberry32, priceOf, seedUser, settle, startJob,
} from "./helpers/replicaMoney";

/**
 * Property tests of the money path against the REAL production function bodies (docs/proposals/prod-definitions/) in a real local
 * PostgreSQL. Two variants run when both exist: the production bodies (cap 600) and the proposed bodies (cap 5000,
 * docs/proposals/job-cap-5000/functions/ = option A, functions-b/ = option B with the one-line helper). Nothing here touches Supabase, a provider or a model.
 */
const PROPOSAL = path.resolve(__dirname, "..", "docs", "proposals", "job-cap-5000");
const VARIANTS = [
  { name: "production bodies, cap 600", dir: DEFINITIONS_DIR, cap: 600, volumeCeiling: 5000, before: [] as string[] },
  ...(existsSync(path.join(PROPOSAL, "functions")) ? [{ name: "proposed bodies (option A), cap 5000", dir: path.join(PROPOSAL, "functions"), cap: 5000, volumeCeiling: 100_000, before: [] as string[] }] : []),
  ...(existsSync(path.join(PROPOSAL, "functions-b")) ? [{ name: "proposed bodies (option B, helper), cap 5000", dir: path.join(PROPOSAL, "functions-b"), cap: 5000, volumeCeiling: 100_000, before: [HELPER_SQL] }] : []),
];

// unit prices as exact thousandths: fractions such as 0.12, 0.28, 3.17, 193 and awkward ones
const NAMED_PRICES = [120, 280, 3170, 193000, 82, 1, 500, 5500, 1000, 7777, 33333];

describe.skipIf(!replicaAvailable()).each(VARIANTS)("money properties on the replica: $name", ({ dir, cap, volumeCeiling, before }) => {
  let db: ReplicaDb;
  beforeAll(async () => { db = await startReplica(); await db.reset({ functionsDir: dir, beforeFunctions: before }); }, 90_000);
  afterAll(async () => { await db?.stop(); });

  it("the sellable ceiling is exactly the cap: a reserve of the cap is quoted, one point more is refused", async () => {
    const user = await seedUser(db.pool, cap + 10);
    const ok = await createQuote(db.pool, user, { unit: 1, volume: cap, reserve: cap });
    expect(ok.result.success).toBe(true);
    await expect(createQuote(db.pool, user, { unit: 1, volume: cap + 1, reserve: cap + 1 })).rejects.toThrow(/quote reserve must be between 0 and/);
    await expect(createQuote(db.pool, user, { unit: 1, volume: 5, reserve: 0 })).rejects.toThrow();
  });

  it("charge = ceil(delivered x unit price), never above the reserve, net on the ledger is exactly -charge (200 random jobs)", async () => {
    const rnd = mulberry32(cap);
    let refusedByVolume = 0;
    let ran = 0;
    for (let i = 0; i < 200; i += 1) {
      const unitK = i < NAMED_PRICES.length ? NAMED_PRICES[i] : 1 + Math.floor(rnd() * 250_000);
      const maxVolume = Math.max(1, Math.min(60_000, Math.floor((cap * 1000) / (unitK * 1.15))));
      const volume = Math.max(1, Math.floor(rnd() * maxVolume));
      const reserve = exactReserve(volume, unitK);
      if (reserve > cap) continue;
      ran += 1;
      const delivered = rnd() < 0.2 ? volume : Math.floor(rnd() * (volume + 1));
      const user = await seedUser(db.pool, reserve + Math.floor(rnd() * 5000));
      const before = await balanceOf(db.pool, user);
      const started = await startJob(db.pool, user, { unit: priceOf(unitK), volume, reserve });
      if (volume > volumeCeiling) {
        // the record ceiling of accept_quote_atomic (target volume): refused before any reserve is written
        expect(started.accepted).toMatchObject({ success: false, error: "invalid_target_volume" });
        expect(await balanceOf(db.pool, user)).toBe(before);
        refusedByVolume += 1;
        continue;
      }
      expect(started.accepted.success, JSON.stringify({ unitK, volume, reserve, accepted: started.accepted })).toBe(true);
      expect(await balanceOf(db.pool, user)).toBe(before - reserve);
      await deliver(db.pool, started.jobId!, delivered, 250, delivered === volume);
      const settled = await settle(db.pool, started.jobId!, cap);
      const expected = Math.min(exactCharge(delivered, unitK), reserve, cap);
      expect(settled.success).toBe(true);
      expect(Number(settled.charged_credits), JSON.stringify({ unitK, volume, delivered, reserve })).toBe(expected);
      expect(expected).toBeLessThanOrEqual(reserve);
      const l = await ledgerOf(db.pool, started.jobId!);
      expect(l.reserve).toBe(-reserve);
      expect(l.release).toBe(reserve);
      expect(l.charge).toBe(expected > 0 ? -expected : 0);
      expect(l.net + 0).toBe(-expected + 0);
      expect(await balanceOf(db.pool, user)).toBe(before - expected + 0);
      const job = (await db.pool.query("select charged_credits::float8 as c, status from public.jobs where id=$1", [started.jobId])).rows[0];
      expect(job).toEqual({ c: expected, status: "completed" });
    }
    expect(ran).toBeGreaterThan(150);
    // with the production record ceiling, cheap per-record prices cannot reach the cap; with the raised ceiling none is refused
    if (volumeCeiling > 5000) expect(refusedByVolume).toBe(0);
    else expect(refusedByVolume).toBeGreaterThan(0);
  }, 180_000);

  it("the record ceiling of accept_quote_atomic: the ceiling itself is accepted, one record more is refused with nothing written", async () => {
    const user = await seedUser(db.pool, 50_000);
    const ok = await startJob(db.pool, user, { unit: 0.001, volume: volumeCeiling });
    expect(ok.accepted.success).toBe(true);
    const over = await startJob(db.pool, user, { unit: 0.001, volume: volumeCeiling + 1 });
    expect(over.accepted).toMatchObject({ success: false, error: "invalid_target_volume" });
    expect((await db.pool.query("select count(*)::int as n from public.credit_ledger where user_id=$1 and type='reserve'", [user])).rows[0].n).toBe(1);
  });

  it("a reserve above min(cap, balance) is never taken: the balance check refuses and writes nothing", async () => {
    const user = await seedUser(db.pool, 99);
    const started = await startJob(db.pool, user, { unit: 1, volume: 100, reserve: 100 });
    expect(started.accepted).toMatchObject({ success: false, error: "insufficient_balance" });
    const ledger = await db.pool.query("select count(*)::int as n from public.credit_ledger where user_id=$1 and type='reserve'", [user]);
    expect(ledger.rows[0].n).toBe(0);
    expect(await balanceOf(db.pool, user)).toBe(99);
    expect((await db.pool.query("select count(*)::int as n from public.jobs where user_id=$1", [user])).rows[0].n).toBe(0);
  });

  it("repeats are idempotent: accept twice, settle twice, a chunk completed twice", async () => {
    const user = await seedUser(db.pool, 1000);
    const started = await startJob(db.pool, user, { unit: 3.17, volume: 100 });
    const again = await acceptQuote(db.pool, user, started.quoteId);
    expect(again).toMatchObject({ success: true, already_accepted: true, job_id: started.jobId });
    await deliver(db.pool, started.jobId!, 60, 50, false);
    await db.pool.query("select public.complete_chunk($1,0,'cursor_1',50,0)", [started.jobId]); // step 0 again
    expect(Number((await db.pool.query("select delivered_units from public.jobs where id=$1", [started.jobId])).rows[0].delivered_units)).toBe(60);
    const first = await settle(db.pool, started.jobId!, cap);
    const second = await settle(db.pool, started.jobId!, cap);
    expect(second).toMatchObject({ already_settled: true, charged_credits: first.charged_credits });
    const l = await ledgerOf(db.pool, started.jobId!);
    expect(l.counts).toEqual({ reserve: 1, release: 1, charge: 1 });
    expect(l.net).toBe(-exactCharge(60, 3170));
  });

  it("a stop before the end settles what was delivered (partial), and zero delivered releases everything", async () => {
    const user = await seedUser(db.pool, 5000);
    const partial = await startJob(db.pool, user, { unit: 0.28, volume: 1000 });
    await deliver(db.pool, partial.jobId!, 333, 50, false);
    const settled = await settle(db.pool, partial.jobId!, cap);
    expect(Number(settled.charged_credits)).toBe(exactCharge(333, 280));
    expect((await ledgerOf(db.pool, partial.jobId!)).net).toBe(-exactCharge(333, 280));

    const none = await startJob(db.pool, user, { unit: 0.28, volume: 1000 });
    await deliver(db.pool, none.jobId!, 0, 50, false); // claimed and running with nothing delivered
    const before = await balanceOf(db.pool, user);
    const settledNone = await settle(db.pool, none.jobId!, cap);
    expect(Number(settledNone.charged_credits)).toBe(0);
    const l = await ledgerOf(db.pool, none.jobId!);
    expect(l.counts).toEqual({ reserve: 1, release: 1, charge: 0 });
    expect(l.net).toBe(0);
    expect(await balanceOf(db.pool, user)).toBe(before + none.reserve);

    const failed = await startJob(db.pool, user, { unit: 0.28, volume: 1000 });
    const rel = (await db.pool.query("select public.release_job_atomic($1,'stopped') as r", [failed.jobId])).rows[0].r;
    expect(rel).toMatchObject({ success: true, released_credits: failed.reserve });
    const again = (await db.pool.query("select public.release_job_atomic($1,'stopped') as r", [failed.jobId])).rows[0].r;
    expect(again).toMatchObject({ already_released: true });
    expect((await ledgerOf(db.pool, failed.jobId!)).net).toBe(0);
  });

  it("concurrent reserves never overdraw: 40 at once on a balance for 7", async () => {
    const reserve = Math.min(cap, 700);
    const user = await seedUser(db.pool, reserve * 7 + (reserve - 1));
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      db.pool.query("select public.reserve_credits_atomic($1::uuid,$2,$3::numeric,'t') as r", [user, `job_conc_${user}_${i}`, reserve]).then((r) => r.rows[0].r)));
    expect(results.filter((r) => r.success).length).toBe(7);
    expect(results.filter((r) => !r.success).every((r) => r.error === "insufficient_balance")).toBe(true);
    expect(await balanceOf(db.pool, user)).toBe(reserve - 1);
  });

  it("20 concurrent approvals of one quote make one job and one reserve", async () => {
    const user = await seedUser(db.pool, 3000);
    const reserve = Math.min(cap, 500);
    const created = await createQuote(db.pool, user, { unit: 1, volume: 400, reserve });
    const results = await Promise.all(Array.from({ length: 20 }, () => acceptQuote(db.pool, user, created.quoteId)));
    expect(results.every((r) => r.success)).toBe(true);
    expect(results.filter((r) => r.already_accepted === false).length).toBe(1);
    expect((await db.pool.query("select count(*)::int as n from public.credit_ledger where user_id=$1 and type='reserve'", [user])).rows[0].n).toBe(1);
    expect(await balanceOf(db.pool, user)).toBe(3000 - reserve);
  });

  it("a fractional unit price is stored and used as is (jobs.unit_price is numeric, no rounding)", async () => {
    const user = await seedUser(db.pool, 2000);
    const started = await startJob(db.pool, user, { unit: 0.12, volume: 1000 });
    const job = (await db.pool.query("select unit_price::text as p, reserved_credits::float8 as r from public.jobs where id=$1", [started.jobId])).rows[0];
    expect(job.p).toBe("0.12");
    expect(job.r).toBe(exactReserve(1000, 120));
    await deliver(db.pool, started.jobId!, 1000, 200, true);
    expect(Number((await settle(db.pool, started.jobId!, cap)).charged_credits)).toBe(120);
  });

  it("the append-only triggers still reject update, delete and truncate", async () => {
    const user = await seedUser(db.pool, 10);
    await expect(db.pool.query("update public.credit_ledger set delta = delta + 1 where user_id=$1", [user])).rejects.toThrow(/append-only/);
    await expect(db.pool.query("delete from public.credit_ledger where user_id=$1", [user])).rejects.toThrow(/append-only/);
    await expect(db.pool.query("truncate public.credit_ledger, public.credit_ledger_kinds")).rejects.toThrow(/cannot be truncated/);
  });

  it("the ledger rules still reject a wrong sign (a charge must be negative)", async () => {
    const user = await seedUser(db.pool, 10);
    await expect(db.pool.query("insert into public.credit_ledger(id,user_id,delta,type) values ('bad1',$1,5,'charge')", [user])).rejects.toThrow(/chk_ledger_delta_direction/);
    await expect(db.pool.query("insert into public.credit_ledger(id,user_id,delta,type) values ('bad2',$1,-5,'topup')", [user])).rejects.toThrow(/chk_ledger_delta_direction/);
  });

  it("the grants are unchanged: no EXECUTE for PUBLIC, anon or authenticated; service_role has it", async () => {
    const rows = (await db.pool.query(`select p.proname,
        has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth,
        has_function_privilege('service_role', p.oid, 'execute') as svc
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('create_quote_atomic','accept_quote_atomic','settle_job_atomic','settle_people_job_atomic','reserve_credits_atomic','release_job_atomic')`)).rows;
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const r of rows) expect(r, r.proname).toMatchObject({ anon: false, auth: false, svc: true });
  });

  it("a cap argument lower than the reserve silently under-charges (why the app must pass the shared constant, not a stale row)", async () => {
    const user = await seedUser(db.pool, 5000);
    const unit = 1;
    const volume = Math.min(cap, 500);
    const started = await startJob(db.pool, user, { unit, volume, reserve: Math.min(cap, 575) });
    await deliver(db.pool, started.jobId!, volume, 250, true);
    const settled = await settle(db.pool, started.jobId!, 100); // a stale 100-point argument
    expect(Number(settled.charged_credits)).toBe(100);
  });

  it("decision-maker jobs: charge = ceil(base + email + phone prices), clipped by reserve and cap", async () => {
    const user = await seedUser(db.pool, 5000);
    const quoteId = `quote_people_${user}`;
    const items = [{ capabilitySlug: "decision-makers", endpointId: "x", targetVolumeMin: 1, targetVolumeMax: 100, unitPricePoints: 5,
      params: { requiredContactFields: ["work_email", "phone"] }, contactUnitPricesPoints: { basePerson: 5, workEmail: 10, phone: 20 } }];
    const reserve = Math.min(cap, 100 * 35);
    await db.pool.query("select public.create_quote_atomic($1::uuid,$2,$3,$4::jsonb,$5::numeric,$6::text[],$7::timestamptz,'{}')",
      [user, quoteId, hash64(quoteId), JSON.stringify(items), reserve, ["xlsx"], new Date(Date.now() + 1_800_000).toISOString()]);
    const accepted = await acceptQuote(db.pool, user, quoteId);
    expect(accepted.success).toBe(true);
    await deliver(db.pool, accepted.job_id, 40, 40, true);
    const r = (await db.pool.query("select public.settle_people_job_atomic($1,40,30,20,$2::numeric,null) as r", [accepted.job_id, cap])).rows[0].r;
    expect(Number(r.charged_credits)).toBe(Math.min(40 * 5 + 30 * 10 + 20 * 20, reserve, cap));
    expect((await ledgerOf(db.pool, accepted.job_id)).net).toBe(-Number(r.charged_credits));
  });

  it("topups still convert exactly (approve_topup_atomic is unchanged by the cap)", async () => {
    const user = await seedUser(db.pool, 0);
    await db.pool.query("insert into public.settings_public(key,value) values ('pricing','{\"creditValueEgp\":0.1}') on conflict (key) do nothing");
    await db.pool.query("insert into public.topups(id,user_id,amount_egp,reference,sender_name,sender_phone,receipt_file_id) values ($1,$2,500,$3,'a','b','c')", [`tp_${user}`, user, `ref_${user}`]);
    const r = (await db.pool.query("select public.approve_topup_atomic($1,null) as r", [`tp_${user}`])).rows[0].r;
    expect(r).toMatchObject({ success: true, credits: 5000 });
    expect(await balanceOf(db.pool, user)).toBe(5000);
  });
});
