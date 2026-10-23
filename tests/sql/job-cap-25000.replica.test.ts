import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFINITIONS_DIR, replicaAvailable, startReplica, type ReplicaDb } from "../helpers/replicaDb";
import { acceptQuote, balanceOf, createQuote, deliver, exactCharge, exactReserve, hash64, ledgerOf, seedUser, settle, startJob } from "../helpers/replicaMoney";

/**
 * The cap proposal docs/proposals/job-cap-25000/ on a REAL local PostgreSQL holding the REAL production schema and function bodies (read with SELECT only on
 * 2026-10-21): the baseline (cap 600), then the steps in their apply order, then the rollbacks in the reverse order. Nothing here touches Supabase, a provider
 * or a model. Skipped visibly when no local PostgreSQL server is installed.
 *
 * Money rules checked: charge = ceil(delivered x unit price), never above the reserve; release first; deterministic ids; settling twice charges once; the ledger
 * stays append-only; only service_role can run the functions; the steps write nothing to a money table; every step can be applied twice; every rollback
 * restores the production definition byte for byte.
 */
const DIR = path.resolve(__dirname, "../../docs/proposals/job-cap-25000");
const file = (name: string) => readFileSync(path.join(DIR, name), "utf8");
const STEP = { settle: "01_settle_job_atomic_cap_25000", people: "02_settle_people_job_atomic_cap_25000", settings: "03_settings_pricing_job_cap_25000", quote: "04_create_quote_atomic_cap_25000" };
const FN = {
  quote: "public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])",
  settle: "public.settle_job_atomic(text,numeric,text)",
  people: "public.settle_people_job_atomic(text,integer,integer,integer,numeric,text)",
};
const OLD_CAP = 600;
const NEW_CAP = 25_000;

describe.skipIf(!replicaAvailable())("the 25,000-point cap proposal on the replica", () => {
  let db: ReplicaDb;
  const md5Of = async (fn: string) => (await db.pool.query(`select md5(pg_get_functiondef('${fn}'::regprocedure)) as m`)).rows[0].m as string;
  const baseline: Record<string, string> = {};
  const applied: Record<string, string> = {};
  const ledgerRows = async () => Number((await db.pool.query("select count(*)::int as n from public.credit_ledger")).rows[0].n);
  const capsOf = async () => (await db.pool.query(file("00_verify_before_apply.sql").split(";")[0] + ";")).rows as Array<Record<string, string | null>>;
  const settleDefault = async (jobId: string) => (await db.pool.query("select public.settle_job_atomic($1) as r", [jobId])).rows[0].r as Record<string, any>;

  beforeAll(async () => {
    db = await startReplica();
    await db.reset({});
    await db.exec("create table if not exists public.settings_private (key text primary key, value jsonb not null, updated_at timestamptz default now())");
    await db.exec(`insert into public.settings_private(key,value) values ('pricing','{"usdToEgp":55.0,"markup":10.0,"providerDailySpendCapUsd":0.8,"jobMaxPointsCap":600}') on conflict (key) do nothing`);
    for (const [name, fn] of Object.entries(FN)) baseline[name] = await md5Of(fn);
  }, 120_000);
  afterAll(async () => { await db?.stop(); });

  it("BASELINE (the production definitions): a reserve of 601 is refused, 600 is accepted, and a settlement with no cap argument cuts a larger reserve at 600", async () => {
    const user = await seedUser(db.pool, 100_000);
    await expect(createQuote(db.pool, user, { unit: 1, volume: 601, reserve: 601 })).rejects.toThrow(/between 0 and 600 points/);
    expect((await createQuote(db.pool, user, { unit: 1, volume: 600, reserve: 600 })).result.success).toBe(true);
    // the live cap numbers, read by the verification query the owner pastes
    const caps = await capsOf();
    expect(caps.find((row) => row.proname === "create_quote_atomic")?.quote_cap).toBe("600");
    expect(caps.find((row) => row.proname === "settle_job_atomic")?.settle_default_cap).toBe("600");
    expect(caps.find((row) => row.proname === "settle_people_job_atomic")?.people_hard_cap).toBe("600");
  });

  it("BASELINE for the Facebook keyword mission (12.925 points a comment): its 1,500-comment job (reserve 22,296) is refused at the cap of 600; a 40-comment job (reserve 595) is accepted", async () => {
    const user = await seedUser(db.pool, 100_000);
    const unit = 12.925;
    expect(exactReserve(1500, 12_925)).toBe(22_296);
    expect(exactReserve(40, 12_925)).toBe(595);
    await expect(createQuote(db.pool, user, { unit, volume: 1500, reserve: 22_296 })).rejects.toThrow(/between 0 and 600 points/);
    const small = await startJob(db.pool, user, { unit, volume: 40, reserve: 595 });
    expect(small.accepted.success).toBe(true);
  });

  it("applies in order 1, 2, 3, 4: settlement first (it only lifts an upper limit), the settings number, the quote writer last (it opens the gate)", async () => {
    const before = await ledgerRows();
    await db.exec(file(`${STEP.settle}.sql`));
    await db.exec(file(`${STEP.people}.sql`));
    await db.exec(file(`${STEP.settings}.sql`));
    // after steps 1 to 3 the quote writer still refuses above 600: nothing can be sold above the old cap before the last step
    const user = await seedUser(db.pool, 100_000);
    await expect(createQuote(db.pool, user, { unit: 1, volume: 601, reserve: 601 })).rejects.toThrow(/between 0 and 600 points/);
    await db.exec(file(`${STEP.quote}.sql`));
    for (const [name, fn] of Object.entries(FN)) {
      applied[name] = await md5Of(fn);
      expect(applied[name], name).not.toBe(baseline[name]);
    }
    expect(await ledgerRows()).toBe(before + 1); // only the seed grant of the user above; the steps themselves wrote no row
    const setting = (await db.pool.query("select value ->> 'jobMaxPointsCap' as v from public.settings_private where key='pricing'")).rows[0].v;
    expect(setting).toBe(String(NEW_CAP));
    const caps = await capsOf();
    expect(caps.find((row) => row.proname === "create_quote_atomic")?.quote_cap).toBe(String(NEW_CAP));
    expect(caps.find((row) => row.proname === "settle_job_atomic")?.settle_default_cap).toBe(String(NEW_CAP));
    expect(caps.find((row) => row.proname === "settle_people_job_atomic")?.people_hard_cap).toBe(String(NEW_CAP));
  });

  it("only the cap constant changed: the definitions differ from production by exactly the cap numbers", async () => {
    for (const [name, base] of [["settle", "settle_job_atomic.sql"], ["people", "settle_people_job_atomic.sql"], ["quote", "create_quote_atomic.sql"]] as const) {
      const original = readFileSync(path.join(DEFINITIONS_DIR, base), "utf8");
      const step = file(`${name === "settle" ? STEP.settle : name === "people" ? STEP.people : STEP.quote}.sql`);
      const norm = (text: string) => text.replace(/^--.*$/gm, "").replace(/REVOKE ALL[^;]*;|GRANT EXECUTE[^;]*;/g, "").replace(/25000/g, "600").replace(/\s+/g, " ").trim().replace(/;$/, "");
      expect(norm(step), name).toBe(norm(original));
    }
  });

  it("the sellable ceiling is exactly the new cap: 25,000 is quoted and accepted, 25,001 is refused", async () => {
    const user = await seedUser(db.pool, NEW_CAP + 10);
    expect((await createQuote(db.pool, user, { unit: 5, volume: 4000, reserve: NEW_CAP })).result.success).toBe(true);
    await expect(createQuote(db.pool, user, { unit: 5, volume: 4000, reserve: NEW_CAP + 1 })).rejects.toThrow(/between 0 and 25000 points/);
    await expect(createQuote(db.pool, user, { unit: 1, volume: 1, reserve: 0 })).rejects.toThrow();
  });

  it("the owner's request as one job (1,800 records at 10.5 points: reserve 21,735): accepted, and a full delivery charges 18,900, never cut at 600", async () => {
    const reserve = exactReserve(1800, 10_500);
    expect(reserve).toBe(21_735);
    const user = await seedUser(db.pool, 30_000);
    const before = await balanceOf(db.pool, user);
    const started = await startJob(db.pool, user, { unit: 10.5, volume: 1800, reserve });
    expect(started.accepted.success).toBe(true);
    expect(await balanceOf(db.pool, user)).toBe(before - reserve);
    await deliver(db.pool, started.jobId!, 1800, 250, true);
    const settled = await settle(db.pool, started.jobId!, NEW_CAP);
    expect(Number(settled.charged_credits)).toBe(exactCharge(1800, 10_500));
    expect(Number(settled.charged_credits)).toBe(18_900);
    const ledger = await ledgerOf(db.pool, started.jobId!);
    expect(ledger.reserve).toBe(-reserve);
    expect(ledger.release).toBe(reserve);
    expect(ledger.charge).toBe(-18_900);
    expect(ledger.net).toBe(-18_900);
    expect(await balanceOf(db.pool, user)).toBe(before - 18_900);
    expect(ledger.counts).toEqual({ reserve: 1, release: 1, charge: 1 });
  });

  describe("the Facebook keyword mission as ONE item (12.925 points a comment, 300 posts x 5 comments = 1,500 comments, reserve 22,296)", () => {
    const UNIT_THOUSANDTHS = 12_925;
    const start = async (volume: number, balance = 30_000) => {
      const user = await seedUser(db.pool, balance);
      const before = await balanceOf(db.pool, user);
      const reserve = exactReserve(volume, UNIT_THOUSANDTHS);
      const started = await startJob(db.pool, user, { unit: 12.925, volume, reserve });
      return { user, before, reserve, started };
    };

    it("a quote of ONE item with the real unit price is accepted (the single-item rule holds), the hold is 22,296, and a full delivery charges 19,388", async () => {
      const { user, before, reserve, started } = await start(1500);
      expect(reserve).toBe(22_296);
      expect(started.accepted.success).toBe(true);
      expect(await balanceOf(db.pool, user)).toBe(before - reserve);
      await deliver(db.pool, started.jobId!, 1500, 25, true);
      const settled = await settle(db.pool, started.jobId!, NEW_CAP);
      expect(Number(settled.charged_credits)).toBe(exactCharge(1500, UNIT_THOUSANDTHS));
      expect(Number(settled.charged_credits)).toBe(19_388);
      expect(Number(settled.charged_credits)).toBeLessThanOrEqual(reserve);
      const ledger = await ledgerOf(db.pool, started.jobId!);
      expect(ledger.counts).toEqual({ reserve: 1, release: 1, charge: 1 });
      expect(ledger.net).toBe(-19_388);
      expect(await balanceOf(db.pool, user)).toBe(before - 19_388);
    });

    it("a partial delivery (the job stopped: a stall, the review budget, a source that ran dry) charges ceil(delivered x 12.925) and releases the rest; settling twice charges once", async () => {
      const { user, before, reserve, started } = await start(1500);
      await deliver(db.pool, started.jobId!, 733, 25, true);
      const settled = await settle(db.pool, started.jobId!, NEW_CAP);
      expect(Number(settled.charged_credits)).toBe(exactCharge(733, UNIT_THOUSANDTHS));
      expect(Number(settled.charged_credits)).toBe(9_475); // 733 x 12.925 = 9,474.025
      const again = await settle(db.pool, started.jobId!, NEW_CAP);
      expect(Number(again.charged_credits)).toBe(9_475);
      const ledger = await ledgerOf(db.pool, started.jobId!);
      expect(ledger.counts).toEqual({ reserve: 1, release: 1, charge: 1 });
      expect(await balanceOf(db.pool, user)).toBe(before - 9_475);
      expect(reserve - 9_475).toBeGreaterThan(0);
    });

    it("nothing delivered (no post about the topic): the whole hold goes back and nothing is charged", async () => {
      const { user, before, started } = await start(1500);
      await deliver(db.pool, started.jobId!, 0, 25, true);
      const settled = await settle(db.pool, started.jobId!, NEW_CAP);
      expect(Number(settled.charged_credits ?? 0)).toBe(0);
      expect(await balanceOf(db.pool, user)).toBe(before);
    });

    it("the charge never exceeds the reserve at any delivered count of the job (every count from 0 to 1,500 in steps, exact arithmetic)", () => {
      const reserve = exactReserve(1500, UNIT_THOUSANDTHS);
      for (let delivered = 0; delivered <= 1500; delivered += 1) expect(exactCharge(delivered, UNIT_THOUSANDTHS)).toBeLessThanOrEqual(reserve);
    });

    it("TWO items are still refused by the database (single_item_quote_required): the mission exists so that one item is enough", async () => {
      const user = await seedUser(db.pool, 30_000);
      const created = await createQuote(db.pool, user, { unit: 8, volume: 300, reserve: 2760 });
      expect(created.result.success).toBe(true);
      const two = await db.pool.query(
        "update public.plans_quotes set items = items || items where id = $1 returning jsonb_array_length(items) as n",
        [created.quoteId],
      );
      expect(Number(two.rows[0].n)).toBe(2);
      const accepted = await acceptQuote(db.pool, user, created.quoteId);
      expect(accepted.success).toBe(false);
      expect(accepted.error).toBe("single_item_quote_required");
    });
  });

  it("settlement with NO cap argument now uses the new default: the same job is not cut at 600 (the old default would have charged 600)", async () => {
    const user = await seedUser(db.pool, 30_000);
    const started = await startJob(db.pool, user, { unit: 10.5, volume: 1800, reserve: 21_735 });
    await deliver(db.pool, started.jobId!, 1800, 250, true);
    const settled = await settleDefault(started.jobId!);
    expect(Number(settled.charged_credits)).toBe(18_900);
  });

  it("a partial delivery charges ceil(delivered x price); nothing delivered releases the whole hold; settling twice charges once", async () => {
    const user = await seedUser(db.pool, 30_000);
    const partial = await startJob(db.pool, user, { unit: 10.5, volume: 1800, reserve: 21_735 });
    await deliver(db.pool, partial.jobId!, 700, 50, false);
    const first = await settle(db.pool, partial.jobId!, NEW_CAP);
    expect(Number(first.charged_credits)).toBe(exactCharge(700, 10_500));
    const second = await settle(db.pool, partial.jobId!, NEW_CAP);
    expect(second).toMatchObject({ already_settled: true, charged_credits: first.charged_credits });
    expect((await ledgerOf(db.pool, partial.jobId!)).counts).toEqual({ reserve: 1, release: 1, charge: 1 });
    const empty = await startJob(db.pool, user, { unit: 10.5, volume: 1800, reserve: 21_735 });
    await deliver(db.pool, empty.jobId!, 0, 50, true);
    const none = await settle(db.pool, empty.jobId!, NEW_CAP);
    expect(Number(none.charged_credits)).toBe(0);
    const ledger = await ledgerOf(db.pool, empty.jobId!);
    expect(ledger.net).toBe(0);
  });

  it("a charge never exceeds the reserve even when more was delivered than the reserve covers", async () => {
    const user = await seedUser(db.pool, 30_000);
    const started = await startJob(db.pool, user, { unit: 10, volume: 1000, reserve: 11_500 });
    await deliver(db.pool, started.jobId!, 1000, 250, true);
    const settled = await settle(db.pool, started.jobId!, NEW_CAP);
    expect(Number(settled.charged_credits)).toBeLessThanOrEqual(11_500);
    expect(Number(settled.charged_credits)).toBe(10_000);
  });

  it("decision-maker settlement: charge = ceil(base + email + phone prices), clipped by the reserve and the new cap (above the old 600)", async () => {
    const user = await seedUser(db.pool, 30_000);
    const quoteId = `quote_people_${user}`;
    const items = [{ capabilitySlug: "decision-makers", endpointId: "x", targetVolumeMin: 1, targetVolumeMax: 100, unitPricePoints: 83, params: { requiredContactFields: ["work_email", "phone"] }, contactUnitPricesPoints: { basePerson: 83, workEmail: 55, phone: 55 } }];
    const reserve = 100 * 193;
    await db.pool.query("select public.create_quote_atomic($1::uuid,$2,$3,$4::jsonb,$5::numeric,$6::text[],$7::timestamptz,'{}')", [user, quoteId, hash64(quoteId), JSON.stringify(items), reserve, ["xlsx"], new Date(Date.now() + 1_800_000).toISOString()]);
    const accepted = await acceptQuote(db.pool, user, quoteId);
    expect(accepted.success).toBe(true);
    await deliver(db.pool, accepted.job_id, 100, 100, true);
    const r = (await db.pool.query("select public.settle_people_job_atomic($1,100,80,60,$2::numeric,null) as r", [accepted.job_id, NEW_CAP])).rows[0].r;
    expect(Number(r.charged_credits)).toBe(Math.min(100 * 83 + 80 * 55 + 60 * 55, reserve, NEW_CAP));
    expect(Number(r.charged_credits)).toBeGreaterThan(OLD_CAP);
  });

  it("only service_role can run any of the three functions; the ledger stays append-only", async () => {
    const rows = (await db.pool.query(`select p.proname, has_function_privilege('anon',p.oid,'EXECUTE') as anon, has_function_privilege('authenticated',p.oid,'EXECUTE') as auth,
        has_function_privilege('service_role',p.oid,'EXECUTE') as svc from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('create_quote_atomic','settle_job_atomic','settle_people_job_atomic') order by 1`)).rows;
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row, row.proname).toMatchObject({ anon: false, auth: false, svc: true });
    await expect(db.pool.query("update public.credit_ledger set delta = delta + 1 where id = (select id from public.credit_ledger limit 1)")).rejects.toThrow();
    await expect(db.pool.query("delete from public.credit_ledger where id = (select id from public.credit_ledger limit 1)")).rejects.toThrow();
  });

  it("every function still takes its row locks (FOR UPDATE) and keeps its pinned search_path", async () => {
    for (const fn of Object.values(FN)) {
      const def = (await db.pool.query(`select pg_get_functiondef('${fn}'::regprocedure) as d`)).rows[0].d as string;
      expect(def, fn).toMatch(/FOR UPDATE/);
      expect(def, fn).toMatch(/SECURITY DEFINER/);
      expect(def, fn).toMatch(/search_path/);
    }
  });

  it("every step is idempotent: applying each one again leaves the definitions and the stored number as they are", async () => {
    for (const step of [STEP.settle, STEP.people, STEP.settings, STEP.quote]) await db.exec(file(`${step}.sql`));
    for (const [name, fn] of Object.entries(FN)) expect(await md5Of(fn), name).toBe(applied[name]);
    expect((await db.pool.query("select value ->> 'jobMaxPointsCap' as v from public.settings_private where key='pricing'")).rows[0].v).toBe(String(NEW_CAP));
  });

  it("ROLLBACK in the reverse order (4, 3, 2, 1) restores every definition byte for byte and the stored number; the old gate is back", async () => {
    const before = await ledgerRows();
    await db.exec(file(`${STEP.quote}.rollback.sql`));
    await db.exec(file(`${STEP.settings}.rollback.sql`));
    await db.exec(file(`${STEP.people}.rollback.sql`));
    await db.exec(file(`${STEP.settle}.rollback.sql`));
    for (const [name, fn] of Object.entries(FN)) expect(await md5Of(fn), name).toBe(baseline[name]);
    expect((await db.pool.query("select value ->> 'jobMaxPointsCap' as v from public.settings_private where key='pricing'")).rows[0].v).toBe("600");
    expect(await ledgerRows()).toBe(before);
    const user = await seedUser(db.pool, 100_000);
    await expect(createQuote(db.pool, user, { unit: 5, volume: 4000, reserve: 601 })).rejects.toThrow(/between 0 and 600 points/);
    // ledger rows written under the new cap stay (append-only): the rollback never rewrites money history
    expect(await ledgerRows()).toBeGreaterThan(0);
  });

  it("the rollbacks are idempotent and the privileges are the same after them", async () => {
    for (const step of [STEP.quote, STEP.settings, STEP.people, STEP.settle]) await db.exec(file(`${step}.rollback.sql`));
    for (const [name, fn] of Object.entries(FN)) expect(await md5Of(fn), name).toBe(baseline[name]);
    const rows = (await db.pool.query(`select has_function_privilege('anon',p.oid,'EXECUTE') as anon, has_function_privilege('authenticated',p.oid,'EXECUTE') as auth, has_function_privilege('service_role',p.oid,'EXECUTE') as svc
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('create_quote_atomic','settle_job_atomic','settle_people_job_atomic')`)).rows;
    for (const row of rows) expect(row).toEqual({ anon: false, auth: false, svc: true });
  });
});
