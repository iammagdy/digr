import type { Pool, PoolClient } from "pg";
import { exactCharge, exactReserve, mulberry32 } from "./replicaMoney";
import {
  applyMutant, CLOSE_OPERATOR_SQL, deliverTx, freezeTx, groupTx, inRolledBackTx, jobTx, must, partJobId, PRODUCTION_CAP, quoteTx,
  repoText, rpc, seedAdminTx, seedUserTx, type GroupFixture, type Mutant,
} from "./moneySuite";

/**
 * DT-20261118-01 groups 4-5: the read-only ledger reconciliation (docs/proposals/money-reconciliation/01_reconcile_ledger.sql)
 * and random money sequences checked against an exact model of the production rules, with a delete-one shrinker.
 */

// ================================================================ reconciliation

export const RECON_SQL_PATH = "docs/proposals/money-reconciliation/01_reconcile_ledger.sql";

export interface ReconRow { check: string; expected: string; actual: string; ok: string }

export async function runReconciliation(c: PoolClient): Promise<ReconRow[]> {
  return (await c.query(repoText(RECON_SQL_PATH))).rows as ReconRow[];
}

/** The 29 output labels, verbatim from the SQL, in output order. */
export const RECON_CHECKS: string[] = [
  "R01 no user balance below zero",
  "R02 ledger id prefix matches its type",
  "R03 ledger id matches its job_id",
  "R04 hold res_<job> = minus the job reserve, same user",
  "R05 release rel_<job> = the job reserve, same user",
  "R06 charge chg_<job> = charged_credits, 0 <= charged <= reserve",
  "R07 every completed job has its release",
  "R08 no failed job is charged",
  "R09 job ledger adds up (completed -charged, released 0, active -reserve)",
  "R10 at most one reserve, one release, one charge per job",
  "R11 every ledger job_id is a job or a group",
  "R12 no active hold older than 48 h",
  "R13 no failed job unreleased after 48 h",
  "R14 every accepted quote has its job",
  "R15 job reserve = its quote total (groups excepted)",
  "R16 every quote job has an accepted quote",
  "R17 approved top-up <=> one top_<id> row, same user",
  "G01 group hold res_<group> = minus hold_credits, same user",
  "G02 transfers gdr_<part> = part reserves = drawn_credits",
  "G03 closed group released exactly hold - drawn; open group none",
  "G04 group ledger adds up (closed 0, open -(hold - drawn))",
  "G05 parts charged <= hold; closed final_charged = parts charged",
  "C01 append-only triggers enabled (ledger x2, kinds, 3 group tables)",
  "C02 ledger rules validated (type, sign, unique id)",
  "C03 anon/authenticated cannot write the append-only tables",
  "I01 service_role can TRUNCATE an append-only table that has no TRUNCATE trigger",
  "I02 money functions present (of 15)",
  "I03 points held now (active job holds + open group remainders)",
  "ALL",
];

export interface ReconScenario {
  a: string; b: string; admin: string;
  settled: string; released: string; active: string; topup: string; settledQuote: string; activeQuote: string;
  closedGroup: GroupFixture; openGroup: GroupFixture;
}

/** The mixed state proven on scratch (plan §A4): partial settle, release, active job, top-up, grant, purchase, closed + open group. */
export async function buildReconScenario(c: PoolClient): Promise<ReconScenario> {
  const a = await seedUserTx(c, 100000);
  const b = await seedUserTx(c, 5000);
  const admin = await seedAdminTx(c);
  const settled = await jobTx(c, a, { quoteId: "rq1", unit: 3.17, volume: 100, reserve: 365 });
  await deliverTx(c, settled, 60);
  await must(c, "public.settle_job_atomic($1,$2::numeric,null)", [settled, PRODUCTION_CAP]);
  const released = await jobTx(c, a, { quoteId: "rq2", unit: 1, volume: 10, reserve: 12 });
  await must(c, "public.release_job_atomic($1,$2)", [released, "x"]);
  const active = await jobTx(c, b, { quoteId: "rq3", unit: 1, volume: 10, reserve: 12 });
  await c.query("insert into public.topups(id,user_id,amount_egp,reference,sender_name,sender_phone,receipt_file_id) values ('rt1',$1,50,'ref_rt1','n','p','f')", [b]);
  await must(c, "public.approve_topup_atomic('rt1',null)");
  await must(c, "public.admin_grant_credit_atomic($1::uuid,$2::uuid,70,'recon grant','req_recon_001')", [admin, b]);
  await must(c, "public.purchase_methodology_atomic($1::uuid,$2,40,'recon')", [a, settled]);
  const closedGroup = await groupTx(c, a, "rgq");
  await deliverTx(c, closedGroup.job1, 7);
  await freezeTx(c, closedGroup, 1, closedGroup.job1, 7);
  await closeGroupTx(c, closedGroup);
  const openGroup = await groupTx(c, b, "rgq2");
  return { a, b, admin, settled, released, active, topup: "rt1", settledQuote: "rq1", activeQuote: "rq3", closedGroup, openGroup };
}

export async function closeGroupTx(c: PoolClient, g: GroupFixture): Promise<Record<string, any>> {
  return must(c, CLOSE_OPERATOR_SQL, [g.gid]);
}

/** One fault per hard row; each must turn ITS row ✗ (other rows may follow). */
export const RECON_FAULTS: Array<[string, (s: ReconScenario) => string]> = [
  ["R01", (s) => `insert into public.credit_ledger(id,user_id,delta,type) values ('f_r01','${s.b}',-100000,'charge')`],
  ["R02", (s) => `insert into public.credit_ledger(id,user_id,delta,type) values ('top_f_r02','${s.a}',-5,'charge')`],
  ["R03", (s) => `insert into public.credit_ledger(id,user_id,delta,type,job_id) values ('chg_meth_f','${s.a}',-1,'charge','${s.settled}')`],
  ["R04", (s) => `update public.jobs set reserved_credits = reserved_credits + 1 where id = '${s.active}'`],
  ["R05", (s) => `update public.jobs set reserved_credits = reserved_credits + 1 where id = '${s.released}'`],
  ["R06", (s) => `update public.jobs set charged_credits = reserved_credits + 1 where id = '${s.settled}'`],
  ["R07", (s) => `update public.jobs set status = 'completed' where id = '${s.active}'`],
  ["R08", (s) => `update public.jobs set status = 'failed' where id = '${s.settled}'`],
  ["R09", (s) => `insert into public.credit_ledger(id,user_id,delta,type,job_id) values ('f_r09','${s.a}',1,'grant','${s.settled}')`],
  ["R10", (s) => `insert into public.credit_ledger(id,user_id,delta,type,job_id) values ('chg_dup','${s.a}',-5,'charge','${s.settled}')`],
  ["R11", (s) => `insert into public.credit_ledger(id,user_id,delta,type,job_id) values ('f_r11','${s.a}',1,'grant','no_such_job')`],
  ["R12", (s) => `update public.jobs set updated_at = now() - interval '49 hours' where id = '${s.active}'`],
  ["R13", (s) => `update public.jobs set status = 'failed', updated_at = now() - interval '49 hours' where id = '${s.active}'`],
  ["R14", (s) => `insert into public.plans_quotes(id,user_id,quote_hash,status,items,total_reserved_credits,expires_at) values ('q_f14','${s.a}','h','accepted','[]',10,now() + interval '1 hour')`],
  ["R15", (s) => `update public.plans_quotes set total_reserved_credits = total_reserved_credits + 1 where id = '${s.settledQuote}'`],
  ["R16", (s) => `update public.plans_quotes set status = 'expired' where id = '${s.activeQuote}'`],
  ["R17", (s) => `update public.topups set status = 'rejected' where id = '${s.topup}'`],
  ["G01", (s) => `update public.job_groups set hold_credits = hold_credits + 1 where id = '${s.openGroup.gid}'`],
  ["G02", (s) => `update public.job_groups set drawn_credits = drawn_credits + 1 where id = '${s.openGroup.gid}'`],
  ["G03", (s) => `update public.job_groups set released_credits = released_credits + 1 where id = '${s.closedGroup.gid}'`],
  ["G04", (s) => `insert into public.credit_ledger(id,user_id,delta,type,job_id) values ('f_g04','${s.a}',1,'grant','${s.closedGroup.gid}')`],
  ["G05", (s) => `update public.job_groups set final_charged = final_charged + 1 where id = '${s.closedGroup.gid}'`],
  ["C01", () => "DROP TRIGGER trg_block_job_group_frozen_mutation ON public.job_group_frozen"],
  ["C02", () => "ALTER TABLE public.credit_ledger DROP CONSTRAINT chk_ledger_type"],
  ["C03", () => "GRANT INSERT ON public.credit_ledger TO anon"],
];

// ================================================================ property model

export type Cmd =
  | { k: "topup"; u: number; egp: number }
  | { k: "grant"; u: number; pts: number }
  | { k: "quote"; u: number; unitK: number; volume: number; under: boolean }
  | { k: "deliver"; j: number; n: number }
  | { k: "settle"; j: number }
  | { k: "release"; j: number }
  | { k: "purchase"; j: number; pts: number }
  | { k: "replay"; h: number };

const NAMED_UNITS = [120, 280, 3170, 1, 500, 5500, 7777];

/** Pure data from a fixed seed. Job / history references are resolved modulo the current list, so deleting any command keeps a valid sequence (shrinkable). */
export function genCommands(seed: number, length: number, users: number): Cmd[] {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const out: Cmd[] = [];
  for (let i = 0; i < length; i += 1) {
    const r = rnd();
    if (r < 0.25) {
      const unitK = rnd() < 0.5 ? NAMED_UNITS[int(NAMED_UNITS.length)] : 1 + int(20000);
      out.push({ k: "quote", u: int(users), unitK, volume: 1 + int(200), under: rnd() < 0.25 });
    } else if (r < 0.45) out.push({ k: "deliver", j: int(1000), n: int(60) });
    else if (r < 0.60) out.push({ k: "settle", j: int(1000) });
    else if (r < 0.68) out.push({ k: "release", j: int(1000) });
    else if (r < 0.76) out.push({ k: "topup", u: int(users), egp: 1 + int(300) });
    else if (r < 0.82) out.push({ k: "grant", u: int(users), pts: 1 + int(500) });
    else if (r < 0.88) out.push({ k: "purchase", j: int(1000), pts: rnd() < 0.2 ? 5000 + int(5000) : 1 + int(100) });
    else out.push({ k: "replay", h: int(1000) });
  }
  return out;
}

export const reserveFor = (volume: number, unitK: number, under: boolean): number => {
  const full = exactReserve(volume, unitK);
  return under ? Math.max(1, Math.floor(full / 2)) : full;
};

interface ModelJob {
  id: string; user: number; unitK: number; volume: number; reserve: number;
  delivered: number; step: number; cursorDone: boolean; status: "queued" | "running" | "completed" | "failed"; charged: number; purchased: boolean;
}
interface ReplayEntry { sql: string; params: unknown[]; flag: string }

/**
 * kind "invariant" = the database disagreed with the money model (the thing a mutant must cause); field names WHICH rule.
 * kind "error" = an exception, a SQL error where an answer was expected, or the chunk driver failing: never counts as a catch.
 */
export type FailureKind = "invariant" | "error";
export type StepFailure = { ok: false; kind: FailureKind; field: string; step: number; cmd: Cmd | null; message: string };
/** How often each branch of the model ran: the clean run asserts floors so it can never pass by doing nothing. */
export interface SequenceStats {
  topups: number; grants: number; accepted: number; refusedConcurrency: number; refusedBalance: number; deliveries: number;
  settledWithCharge: number; settleReplays: number; settleRaised: number; released: number; releaseReplays: number; releaseRaised: number;
  purchases: number; purchaseRefused: number; purchaseReplays: number; replays: number;
}
export const emptyStats = (): SequenceStats => ({ topups: 0, grants: 0, accepted: 0, refusedConcurrency: 0, refusedBalance: 0, deliveries: 0,
  settledWithCharge: 0, settleReplays: 0, settleRaised: 0, released: 0, releaseReplays: 0, releaseRaised: 0, purchases: 0, purchaseRefused: 0, purchaseReplays: 0, replays: 0 });

export type SequenceResult = { ok: true; stats: SequenceStats } | StepFailure;

const SEED_BALANCE = 2000;

/** Runs one sequence inside a savepoint (always rolled back) and checks the model after every command, then the reconciliation. */
export async function runSequence(c: PoolClient, seed: number, cmds: Cmd[], users = 4): Promise<SequenceResult> {
  await c.query("SAVEPOINT ms_seq");
  try {
    return await runSequenceBody(c, seed, cmds, users);
  } catch (e: any) {
    return { ok: false, kind: "error", field: "runner", step: -1, cmd: null, message: `runner error: ${String(e?.message ?? e)}` };
  } finally {
    await c.query("ROLLBACK TO SAVEPOINT ms_seq");
    await c.query("RELEASE SAVEPOINT ms_seq");
  }
}

async function runSequenceBody(c: PoolClient, seed: number, cmds: Cmd[], userCount: number): Promise<SequenceResult> {
  const admin = await seedAdminTx(c);
  const users: Array<{ id: string; balance: number }> = [];
  for (let i = 0; i < userCount; i += 1) users.push({ id: await seedUserTx(c, SEED_BALANCE), balance: SEED_BALANCE });
  const baseRows = Number((await c.query("select count(*)::int as n from public.credit_ledger")).rows[0].n);
  let rows = 0;
  const jobs: ModelJob[] = [];
  const history: ReplayEntry[] = [];
  const stats = emptyStats();

  for (let i = 0; i < cmds.length; i += 1) {
    const cmd = cmds[i];
    const fail = (field: string, message: string, kind: FailureKind = "invariant"): StepFailure => ({ ok: false, kind, field, step: i, cmd, message });
    // an answer check: a SQL error where an answer was expected is an "error", a wrong answer is an "invariant" on `field`
    const failOn = (field: string, r: { ok: boolean }, message: string): StepFailure => (r.ok ? fail(field, message) : fail(`${field}_sql_error`, message, "error"));
    const job = "j" in cmd && jobs.length > 0 ? jobs[cmd.j % jobs.length] : null;

    try {
      switch (cmd.k) {
        case "topup": {
          const u = users[cmd.u % users.length];
          const id = `t_${seed}_${i}`;
          await c.query("insert into public.topups(id,user_id,amount_egp,reference,sender_name,sender_phone,receipt_file_id) values ($1,$2,$3,$4,'n','p','f')", [id, u.id, cmd.egp, `ref_${seed}_${i}`]);
          const r = await rpc(c, "public.approve_topup_atomic($1,null)", [id]);
          if (!r.ok || r.r.success !== true || r.r.already_approved !== false || Number(r.r.credits) !== cmd.egp * 10) return failOn("topup_answer", r, `topup answer ${JSON.stringify(r.ok ? r.r : r.error.message)}`);
          u.balance += cmd.egp * 10; rows += 1; stats.topups += 1;
          history.push({ sql: "public.approve_topup_atomic($1,null)", params: [id], flag: "already_approved" });
          break;
        }
        case "grant": {
          const u = users[cmd.u % users.length];
          const params = [admin, u.id, cmd.pts, "property grant", `req_${seed}_${i}`];
          const sql = "public.admin_grant_credit_atomic($1::uuid,$2::uuid,$3::numeric,$4,$5)";
          const r = await rpc(c, sql, params);
          if (!r.ok || r.r.success !== true || r.r.already_granted !== false) return failOn("grant_answer", r, `grant answer ${JSON.stringify(r.ok ? r.r : r.error.message)}`);
          u.balance += cmd.pts; rows += 1; stats.grants += 1;
          history.push({ sql, params, flag: "already_granted" });
          break;
        }
        case "quote": {
          const ui = cmd.u % users.length;
          const u = users[ui];
          const quoteId = `q_${seed}_${i}`;
          const reserve = reserveFor(cmd.volume, cmd.unitK, cmd.under);
          await quoteTx(c, u.id, { quoteId, unit: cmd.unitK / 1000, volume: cmd.volume, reserve });
          const sql = "public.accept_quote_atomic($1,$2::uuid,$3)";
          const params = [quoteId, u.id, (await c.query("select quote_hash from public.plans_quotes where id = $1", [quoteId])).rows[0].quote_hash];
          const r = await rpc(c, sql, params);
          const active = jobs.filter((j) => j.user === ui && (j.status === "queued" || j.status === "running")).length;
          if (active >= 2) {
            if (!r.ok || r.r.success !== false || r.r.error !== "concurrency_limit") return failOn("concurrency_limit", r, `accept expected concurrency_limit, got ${JSON.stringify(r.ok ? r.r : r.error.message)}`);
            stats.refusedConcurrency += 1;
          } else if (u.balance < reserve) {
            if (!r.ok || r.r.success !== false || r.r.error !== "insufficient_balance") return failOn("balance_refusal", r, `accept expected insufficient_balance, got ${JSON.stringify(r.ok ? r.r : r.error.message)}`);
            stats.refusedBalance += 1;
          } else {
            if (!r.ok || r.r.success !== true || r.r.already_accepted !== false || Number(r.r.reserved_credits) !== reserve || r.r.job_id !== partJobId(quoteId, 1)) {
              return failOn("accept_answer", r, `accept expected success reserve ${reserve}, got ${JSON.stringify(r.ok ? r.r : r.error.message)}`);
            }
            u.balance -= reserve; rows += 1; stats.accepted += 1;
            jobs.push({ id: String(r.r.job_id), user: ui, unitK: cmd.unitK, volume: cmd.volume, reserve, delivered: 0, step: 0, cursorDone: false, status: "queued", charged: 0, purchased: false });
            history.push({ sql, params, flag: "already_accepted" });
          }
          break;
        }
        case "deliver": {
          if (!job || (job.status !== "queued" && job.status !== "running") || job.cursorDone) break;
          const n = Math.min(cmd.n, job.volume - job.delivered);
          if (n === 0) break;
          const claim = await rpc(c, "public.claim_job_chunk($1,$2,60)", [job.id, job.step]);
          if (!claim.ok || claim.r.claimed !== true) return fail("claim", `claim refused ${JSON.stringify(claim.ok ? claim.r : claim.error.message)}`, "error");
          const total = job.delivered + n;
          const done = await rpc(c, "public.complete_chunk($1,$2,$3,$4,0)", [job.id, job.step, total === job.volume ? "completed" : `c${job.step + 1}`, total]);
          if (!done.ok || done.r.success !== true) return fail("complete_chunk", `complete_chunk ${JSON.stringify(done.ok ? done.r : done.error.message)}`, "error");
          job.delivered = total; job.step += 1; job.status = "running"; job.cursorDone = total === job.volume;
          stats.deliveries += 1;
          break;
        }
        case "settle": {
          if (!job) break;
          const sql = "public.settle_job_atomic($1,$2::numeric,null)";
          const params = [job.id, PRODUCTION_CAP];
          const r = await rpc(c, sql, params);
          if (job.status === "running") {
            const charged = Math.min(exactCharge(job.delivered, job.unitK), job.reserve, PRODUCTION_CAP);
            if (!r.ok || r.r.success !== true || r.r.already_settled !== false || Number(r.r.charged_credits) !== charged) return failOn(r.ok && Number(r.r.charged_credits) > job.reserve ? "reserve_cap" : "charge", r, `settle expected charge ${charged}, got ${JSON.stringify(r.ok ? r.r : r.error.message)}`);
            users[job.user].balance += job.reserve - charged; rows += charged > 0 ? 2 : 1;
            job.status = "completed"; job.charged = charged; if (charged > 0) stats.settledWithCharge += 1;
            history.push({ sql, params, flag: "already_settled" });
          } else if (job.status === "completed") {
            if (!r.ok || r.r.already_settled !== true || Number(r.r.charged_credits) !== job.charged) return failOn("settle_replay", r, `settle replay ${JSON.stringify(r.ok ? r.r : r.error.message)}`);
            stats.settleReplays += 1;
          } else if (r.ok) return fail("settle_must_raise", `settle of a ${job.status} job must raise, got ${JSON.stringify(r.r)}`);
          else stats.settleRaised += 1;
          break;
        }
        case "release": {
          if (!job) break;
          const sql = "public.release_job_atomic($1,$2)";
          const params = [job.id, "property"];
          const r = await rpc(c, sql, params);
          if (job.status === "queued" || job.status === "running") {
            if (!r.ok || r.r.success !== true || r.r.already_released !== false) return failOn("release_answer", r, `release answer ${JSON.stringify(r.ok ? r.r : r.error.message)}`);
            users[job.user].balance += job.reserve; rows += 1; job.status = "failed"; stats.released += 1;
            history.push({ sql, params, flag: "already_released" });
          } else if (job.status === "failed") {
            if (!r.ok || r.r.already_released !== true) return failOn("release_replay", r, `release replay ${JSON.stringify(r.ok ? r.r : r.error.message)}`);
            stats.releaseReplays += 1;
          } else if (r.ok) return fail("release_must_raise", `release of a completed job must raise, got ${JSON.stringify(r.r)}`);
          else stats.releaseRaised += 1;
          break;
        }
        case "purchase": {
          if (!job) break;
          const u = users[job.user];
          const sql = "public.purchase_methodology_atomic($1::uuid,$2,$3::numeric,$4)";
          const params = [u.id, job.id, cmd.pts, "property"];
          const r = await rpc(c, sql, params);
          if (job.purchased) {
            if (!r.ok || r.r.already_purchased !== true) return failOn("purchase_replay", r, `purchase replay ${JSON.stringify(r.ok ? r.r : r.error.message)}`);
            stats.purchaseReplays += 1;
          } else if (u.balance < cmd.pts) {
            if (!r.ok || r.r.success !== false || r.r.error !== "insufficient_balance") return failOn("purchase_refusal", r, `purchase expected insufficient_balance, got ${JSON.stringify(r.ok ? r.r : r.error.message)}`);
            stats.purchaseRefused += 1;
          } else {
            if (!r.ok || r.r.success !== true || r.r.already_purchased !== false) return failOn("purchase_answer", r, `purchase answer ${JSON.stringify(r.ok ? r.r : r.error.message)}`);
            u.balance -= cmd.pts; rows += 1; job.purchased = true; stats.purchases += 1;
            history.push({ sql, params, flag: "already_purchased" });
          }
          break;
        }
        case "replay": {
          if (history.length === 0) break;
          const h = history[cmd.h % history.length];
          const r = await rpc(c, h.sql, h.params);
          if (!r.ok || r.r[h.flag] !== true) return failOn("replay_flag", r, `replay of ${h.sql} expected ${h.flag}, got ${JSON.stringify(r.ok ? r.r : r.error.message)}`);
          stats.replays += 1;
          break;
        }
      }
    } catch (e: any) {
      return fail("exception", `error: ${String(e?.message ?? e)}`, "error");
    }

    // invariants after every command
    const bal = new Map((await c.query("select user_id::text as u, sum(delta)::numeric as b from public.credit_ledger where user_id = any($1::uuid[]) group by user_id", [users.map((u) => u.id)])).rows.map((r) => [r.u as string, Number(r.b)]));
    for (const u of users) {
      const got = bal.get(u.id) ?? 0;
      if (got !== u.balance) return fail("balance_after_" + cmd.k, `balance ${got} != model ${u.balance}`);
      if (got < 0) return fail("balance_below_zero", `balance ${got} below zero`);
    }
    const count = Number((await c.query("select count(*)::int as n from public.credit_ledger")).rows[0].n);
    if (count !== baseRows + rows) return fail("ledger_rows", `ledger rows ${count - baseRows} != model ${rows}`);
    if (jobs.length > 0) {
      const db = new Map((await c.query("select id, status, coalesce(charged_credits,0)::numeric as ch, coalesce(delivered_units,0) as d, reserved_credits::numeric as r from public.jobs where id = any($1)", [jobs.map((j) => j.id)])).rows.map((r) => [r.id as string, r]));
      for (const j of jobs) {
        const row = db.get(j.id);
        if (!row) return fail("job_state", `job ${j.id} missing`);
        if (row.status !== j.status || Number(row.ch) !== j.charged || Number(row.d) !== j.delivered) {
          return fail("job_state", `job ${j.id} is ${row.status}/${row.ch}/${row.d}, model ${j.status}/${j.charged}/${j.delivered}`);
        }
        if (Number(row.ch) > Number(row.r)) return fail("job_charge_above_reserve", `job ${j.id} charged ${row.ch} above reserve ${row.r}`);
      }
    }
  }

  const recon = await runReconciliation(c);
  const bad = recon.filter((r) => r.ok === "✗");
  if (bad.length > 0) return { ok: false, kind: "invariant", field: "reconciliation", step: cmds.length, cmd: null, message: `reconciliation: ${bad.map((r) => `${r.check} -> ${r.actual}`).join(" | ")}` };
  return { ok: true, stats };
}

export type PropertyResult = { ok: true; runs: number; stats: SequenceStats } | { ok: false; kind: FailureKind; field: string; seed: number; original: number; shrunk: Cmd[]; step: number; message: string };

/** Greedy delete-one shrinking of an INVARIANT failure (cut to the failing step first); a candidate counts only if it fails with the SAME kind and field. */
async function shrink(c: PoolClient, seed: number, cmds: Cmd[], first: StepFailure, users: number): Promise<{ kind: FailureKind; field: string; shrunk: Cmd[]; step: number; message: string }> {
  let cur = first.step >= 0 && first.step < cmds.length ? cmds.slice(0, first.step + 1) : cmds;
  let last: StepFailure = first;
  let budget = 300;
  let changed = true;
  while (changed && budget > 0) {
    changed = false;
    for (let i = 0; i < cur.length && budget > 0; i += 1) {
      const cand = cur.filter((_, k) => k !== i);
      budget -= 1;
      const r = await runSequence(c, seed, cand, users);
      if (!r.ok && r.kind === first.kind && r.field === first.field) {
        cur = r.step >= 0 && r.step < cand.length ? cand.slice(0, r.step + 1) : cand;
        last = r; changed = true; i -= 1;
      }
    }
  }
  return { kind: last.kind, field: last.field, shrunk: cur, step: last.step, message: last.message };
}

export function propertySeeds(defaults: number[]): number[] {
  const env = process.env.MONEY_PROP_SEEDS;
  return env ? env.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n)) : defaults;
}

export async function runSeeds(pool: Pool, opts: { seeds: number[]; length: number; users: number; mutant?: Mutant }): Promise<PropertyResult> {
  const total = emptyStats();
  for (const seed of opts.seeds) {
    const failure = await inRolledBackTx(pool, async (c) => {
      if (opts.mutant) await applyMutant(c, opts.mutant);
      const cmds = genCommands(seed, opts.length, opts.users);
      const r = await runSequence(c, seed, cmds, opts.users);
      if (r.ok) {
        for (const key of Object.keys(total) as Array<keyof SequenceStats>) total[key] += r.stats[key];
        return null;
      }
      // an error is reported as is (never shrunk, never a catch): the caller's kind/field assertions fail on it
      const s = r.kind === "error"
        ? { kind: r.kind, field: r.field, shrunk: r.step >= 0 ? cmds.slice(0, r.step + 1) : cmds, step: r.step, message: r.message }
        : await shrink(c, seed, cmds, r, opts.users);
      return { ok: false as const, seed, original: cmds.length, ...s };
    });
    if (failure) return failure;
  }
  return { ok: true, runs: opts.seeds.length, stats: total };
}

export async function replaySequence(pool: Pool, seed: number, cmds: Cmd[], mutant?: Mutant, users = 4): Promise<SequenceResult> {
  return inRolledBackTx(pool, async (c) => {
    if (mutant) await applyMutant(c, mutant);
    return runSequence(c, seed, cmds, users);
  });
}
