import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { startReplica, withTerminator, type ReplicaDb } from "./replicaDb";

/**
 * The money-invariant suite (DT-20261118-01) on a REAL local PostgreSQL holding the PRODUCTION money code:
 * the replica schema + saved production bodies (replicaDb.ts), then the two hand-applied production bodies recorded in
 * 20261104222000, the job-groups SQL applied at GATE S, and the repo bodies of the methodology / promo / grant functions.
 * Every probe runs inside a transaction that is always rolled back, so probes and mutants never leak into each other.
 * Nothing here connects to Supabase, a provider or a model.
 */
const ROOT = path.resolve(__dirname, "..", "..");

/** The per-job point cap production runs (20261104222000:10 and :67). */
export const PRODUCTION_CAP = 25000;

export const PRODUCTION_EXTRA_FILES = [
  "supabase/migrations/20261104222000_record_production_quote_and_settle.sql",
  "docs/proposals/job-groups-one-hold/01_job_groups_one_hold.sql",
  "supabase/migrations/20261016002600_purchase_methodology_atomic.sql",
  "supabase/migrations/20261018140500_promo_codes_and_admin_grants.sql",
] as const;

/** Test-only stub: Supabase's auth.users has this column; admin_grant_credit_atomic reads it (20261018140500:118). */
export const AUTH_USERS_STUB = "ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb;";

/** The 15 atomic functions that write (or gate) money. Pinned by name, not by a count of public functions. */
export const MONEY_FUNCTIONS = [
  "reserve_credits_atomic", "create_quote_atomic", "accept_quote_atomic", "settle_job_atomic", "settle_people_job_atomic",
  "release_job_atomic", "approve_topup_atomic", "purchase_methodology_atomic", "redeem_promo_code_atomic", "admin_grant_credit_atomic",
  "accept_group_quote_atomic", "draw_next_group_part_atomic", "freeze_and_settle_group_part_atomic",
  "release_unfrozen_group_part_atomic", "close_job_group_atomic",
] as const;

export const repoText = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
export const md5 = (s: string): string => createHash("md5").update(s).digest("hex");
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export async function startMoneyReplica(): Promise<ReplicaDb> {
  const db = await startReplica();
  try {
    await db.reset({ beforeFunctions: [AUTH_USERS_STUB], extraSql: PRODUCTION_EXTRA_FILES.map((f) => withTerminator(repoText(f))) });
  } catch (error) {
    await db.stop();
    throw error;
  }
  return db;
}

/** BEGIN, run, ALWAYS roll back. */
export async function inRolledBackTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

export interface SqlFailure { code: string; constraint: string | null; column: string | null; message: string }
export type SqlResult = { ok: true; rows: any[] } | { ok: false; error: SqlFailure };

/** One statement inside a savepoint: an error is returned (not thrown) and the surrounding transaction stays usable. */
export async function trySql(c: PoolClient, text: string, params: unknown[] = []): Promise<SqlResult> {
  await c.query("SAVEPOINT ms_try");
  try {
    const r = await c.query(text, params);
    await c.query("RELEASE SAVEPOINT ms_try");
    return { ok: true, rows: r.rows };
  } catch (e: any) {
    await c.query("ROLLBACK TO SAVEPOINT ms_try");
    return { ok: false, error: { code: String(e?.code ?? ""), constraint: e?.constraint ?? null, column: e?.column ?? null, message: String(e?.message ?? e) } };
  }
}

export type RpcResult = { ok: true; r: Record<string, any> } | { ok: false; error: SqlFailure };

/** `select <callSql> as r` → the function's jsonb answer, or the SQL error. */
export async function rpc(c: PoolClient, callSql: string, params: unknown[] = []): Promise<RpcResult> {
  const res = await trySql(c, `select ${callSql} as r`, params);
  return res.ok ? { ok: true, r: res.rows[0].r } : res;
}

/** Same, but a SQL error or success:false is a thrown setup error. */
export async function must(c: PoolClient, callSql: string, params: unknown[] = []): Promise<Record<string, any>> {
  const res = await rpc(c, callSql, params);
  if (!res.ok) throw new Error(`setup ${callSql}: ${res.error.message}`);
  if (res.r && res.r.success === false) throw new Error(`setup ${callSql}: ${JSON.stringify(res.r)}`);
  return res.r;
}

export async function ledgerIds(c: PoolClient): Promise<string[]> {
  return (await c.query("select id from public.credit_ledger order by id")).rows.map((r) => r.id as string);
}

// ---------------------------------------------------------------- fixtures (all inside the caller's transaction)

export async function seedUserTx(c: PoolClient, balance: number): Promise<string> {
  const id = randomUUID();
  await c.query("insert into auth.users(id) values ($1)", [id]);
  await c.query("insert into public.profiles(id, email) values ($1, $2)", [id, `${id}@example.test`]);
  if (balance > 0) await c.query("insert into public.credit_ledger(id,user_id,delta,type,note) values ($1,$2,$3,'grant','test seed')", [`seed_${id}`, id, balance]);
  return id;
}

export async function seedAdminTx(c: PoolClient): Promise<string> {
  const id = randomUUID();
  await c.query(`insert into auth.users(id, raw_app_meta_data) values ($1, '{"role":"admin"}'::jsonb)`, [id]);
  await c.query("insert into public.profiles(id, email) values ($1, $2)", [id, `${id}@example.test`]);
  return id;
}

export interface QuoteSpec { quoteId: string; unit: number; volume: number; reserve: number; items?: unknown[] }

/** create_quote_atomic with the app's argument shape (replicaMoney.ts:54-61). Returns the quote hash. */
export async function quoteTx(c: PoolClient, user: string, q: QuoteSpec): Promise<string> {
  const items = q.items ?? [{ capabilitySlug: "x-posts", endpointId: "test.endpoint", targetVolumeMin: 1, targetVolumeMax: q.volume, unitPricePoints: q.unit }];
  await must(c, "public.create_quote_atomic($1::uuid,$2,$3,$4::jsonb,$5::numeric,$6::text[],now() + interval '30 minutes','{}'::text[])",
    [user, q.quoteId, sha256(q.quoteId), JSON.stringify(items), q.reserve, ["xlsx"]]);
  return sha256(q.quoteId);
}

export async function acceptTx(c: PoolClient, user: string, quoteId: string): Promise<Record<string, any>> {
  return must(c, "public.accept_quote_atomic($1,$2::uuid,$3)", [quoteId, user, sha256(quoteId)]);
}

/** Quote + accept; returns the job id. */
export async function jobTx(c: PoolClient, user: string, q: QuoteSpec): Promise<string> {
  await quoteTx(c, user, q);
  return String((await acceptTx(c, user, q.quoteId)).job_id);
}

/** One chunk through the real claim / complete functions: delivered_units += delivered. */
export async function deliverTx(c: PoolClient, jobId: string, delivered: number, finish = true): Promise<void> {
  const job = (await c.query("select coalesce(step,0) as step, coalesce(delivered_units,0) as d from public.jobs where id = $1", [jobId])).rows[0];
  const step = Number(job.step);
  const claim = await must(c, "public.claim_job_chunk($1,$2,60)", [jobId, step]);
  if (claim.claimed !== true) throw new Error(`setup claim refused: ${JSON.stringify(claim)}`);
  await must(c, "public.complete_chunk($1,$2,$3,$4,0)", [jobId, step, finish ? "completed" : `c${step + 1}`, Number(job.d) + delivered]);
}

export interface GroupFixture { quoteId: string; gid: string; hash: string; job1: string; user: string; per: number; unit: number; parts: number }

/** The split quote of job-groups-money.local-pg.test.ts:51-57 (not accepted yet). */
export async function groupQuoteTx(c: PoolClient, user: string, quoteId: string, parts = 2, per = 10, unit = 10): Promise<GroupFixture> {
  const r = per * unit;
  const split = { v: "3", parts, partVolumes: Array(parts).fill(per), partReserves: Array(parts).fill(r), hold: r * parts, reachable: per * parts, askedOriginal: per * parts };
  const items = [{ endpointId: "ep", unitPricePoints: unit, targetVolumeMin: 1, targetVolumeMax: per, params: { split } }];
  await c.query(
    `insert into public.plans_quotes (id,user_id,status,quote_hash,items,total_reserved_credits,output_formats,expires_at,created_at)
     values ($1,$2,'quoted',$3,$4::jsonb,$5,'["xlsx"]'::jsonb,now() + interval '1 day',now())`,
    [quoteId, user, sha256(quoteId), JSON.stringify(items), r]);
  return { quoteId, gid: `grp_${md5(quoteId)}`, hash: sha256(quoteId), job1: partJobId(quoteId, 1), user, per, unit, parts };
}

export const ACCEPT_GROUP_SQL = "public.accept_group_quote_atomic($1,$2::uuid,$3,25000,'بداية')";

export async function groupTx(c: PoolClient, user: string, quoteId: string, parts = 2, per = 10, unit = 10): Promise<GroupFixture> {
  const g = await groupQuoteTx(c, user, quoteId, parts, per, unit);
  await must(c, ACCEPT_GROUP_SQL, [quoteId, user, g.hash]);
  return g;
}

/** Part 1 = the ordinary deterministic job of the quote (01:236); part k = the job of `<quote>_p<k>` (01:633-634). */
export function partJobId(quoteId: string, k: number): string {
  return k === 1 ? `job_quote_${md5(quoteId)}` : `job_quote_${md5(`${quoteId}_p${k}`)}`;
}

export function drawCall(g: GroupFixture, k: number, deliveredSoFar: number): { sql: string; params: unknown[] } {
  const items = [{ endpointId: "ep", unitPricePoints: g.unit, targetVolumeMin: 1, targetVolumeMax: g.per, params: { split: { v: 3, part: k, groupId: g.gid } } }];
  return { sql: "public.draw_next_group_part_atomic($1,$2,$3::jsonb,'سطر',$4,25000)", params: [g.gid, k, JSON.stringify(items), deliveredSoFar] };
}

export function freezeCall(g: GroupFixture, k: number, jobId: string, rows: number): { sql: string; params: unknown[] } {
  const sha = "a".repeat(64);
  const keys = Array.from({ length: rows }, (_, i) => `k_${g.gid.slice(4, 12)}_${k}_${i}`);
  return { sql: "public.freeze_and_settle_group_part_atomic($1,$2,$3,$4,$5,$6,$7::text[])", params: [g.gid, k, jobId, `${g.user}/${jobId}/frozen-${sha}.json`, sha, rows, keys] };
}

export async function freezeTx(c: PoolClient, g: GroupFixture, k: number, jobId: string, rows: number): Promise<Record<string, any>> {
  const f = freezeCall(g, k, jobId, rows);
  return must(c, f.sql, f.params);
}

export const CLOSE_OPERATOR_SQL = "public.close_job_group_atomic($1,'operator',NULL,NULL,NULL,'أوقفنا')";

// ---------------------------------------------------------------- probe 1: constraints

interface ConstraintCtx { u: string; gid: string; job1: string }
interface ConstraintCase { name: string; stmt: (x: ConstraintCtx) => [string, unknown[]]; code: string; target: string[] /* constraint names, or "column:<name>" */ }

const L = (id: string, delta: number | null, type: string | null, user = "$1") =>
  `insert into public.credit_ledger(id,user_id,delta,type) values ('${id}',${user},${delta === null ? "NULL" : delta},${type === null ? "NULL" : `'${type}'`})`;

export const CONSTRAINT_CASES: ConstraintCase[] = [
  { name: "sign reserve>0", stmt: (x) => [L("pc1", 5, "reserve"), [x.u]], code: "23514", target: ["chk_ledger_delta_direction"] },
  { name: "sign charge>0", stmt: (x) => [L("pc2", 5, "charge"), [x.u]], code: "23514", target: ["chk_ledger_delta_direction"] },
  { name: "sign release<0", stmt: (x) => [L("pc3", -5, "release"), [x.u]], code: "23514", target: ["chk_ledger_delta_direction"] },
  { name: "sign topup<0", stmt: (x) => [L("pc4", -5, "topup"), [x.u]], code: "23514", target: ["chk_ledger_delta_direction"] },
  { name: "sign grant<0", stmt: (x) => [L("pc5", -5, "grant"), [x.u]], code: "23514", target: ["chk_ledger_delta_direction"] },
  { name: "sign goodwill<0", stmt: (x) => [L("pc6", -5, "goodwill"), [x.u]], code: "23514", target: ["chk_ledger_delta_direction"] },
  { name: "sign zero", stmt: (x) => [L("pc7", 0, "reserve"), [x.u]], code: "23514", target: ["chk_ledger_delta_direction"] },
  { name: "unknown type", stmt: (x) => [L("pc8", 5, "refund"), [x.u]], code: "23514", target: ["chk_ledger_delta_direction", "chk_ledger_type"] },
  { name: "ledger null user", stmt: () => [L("pc9", 5, "grant", "NULL"), []], code: "23502", target: ["column:user_id"] },
  { name: "ledger null delta", stmt: (x) => [L("pc10", null, "grant"), [x.u]], code: "23502", target: ["column:delta"] },
  { name: "ledger null type", stmt: (x) => [L("pc11", 5, null), [x.u]], code: "23502", target: ["column:type"] },
  { name: "ledger unknown user", stmt: () => [L("pc12", 5, "grant", "gen_random_uuid()"), []], code: "23503", target: ["credit_ledger_user_id_fkey"] },
  { name: "duplicate ledger id", stmt: (x) => [L("pc_ok", 5, "grant"), [x.u]], code: "23505", target: ["credit_ledger_pkey"] },
  { name: "quote status", stmt: (x) => ["insert into public.plans_quotes(id,user_id,quote_hash,status,items,total_reserved_credits,expires_at) values ('pcq1',$1,'h','paid','[]',1,now() + interval '1 hour')", [x.u]], code: "23514", target: ["chk_quotes_status"] },
  { name: "quote null total", stmt: (x) => ["insert into public.plans_quotes(id,user_id,quote_hash,status,items,total_reserved_credits,expires_at) values ('pcq2',$1,'h','quoted','[]',NULL,now() + interval '1 hour')", [x.u]], code: "23502", target: ["column:total_reserved_credits"] },
  { name: "job status", stmt: (x) => ["insert into public.jobs(id,user_id,status) values ('pcj1',$1,'done')", [x.u]], code: "23514", target: ["chk_jobs_status"] },
  { name: "job unit price", stmt: (x) => ["insert into public.jobs(id,user_id,status,unit_price) values ('pcj2',$1,'queued',0)", [x.u]], code: "23514", target: ["chk_jobs_unit_price_positive"] },
  { name: "job unknown user", stmt: () => ["insert into public.jobs(id,user_id,status) values ('pcj3',gen_random_uuid(),'queued')", []], code: "23503", target: ["jobs_user_id_fkey"] },
  { name: "topup amount", stmt: (x) => ["insert into public.topups(id,user_id,amount_egp,reference,sender_name,sender_phone,receipt_file_id) values ('pct1',$1,0,'pc_r1','n','p','f')", [x.u]], code: "23514", target: ["chk_topups_amount_positive"] },
  { name: "topup status", stmt: (x) => ["insert into public.topups(id,user_id,amount_egp,reference,sender_name,sender_phone,receipt_file_id,status) values ('pct2',$1,5,'pc_r2','n','p','f','paid')", [x.u]], code: "23514", target: ["chk_topups_status"] },
  { name: "kind value", stmt: () => ["insert into public.credit_ledger_kinds(ledger_id,kind) values ('pc_ok','gift')", []], code: "23514", target: ["credit_ledger_kinds_kind_check"] },
  { name: "kind unknown ledger id", stmt: () => ["insert into public.credit_ledger_kinds(ledger_id,kind) values ('no_such_row','admin_grant')", []], code: "23503", target: ["credit_ledger_kinds_ledger_id_fkey"] },
  { name: "group hold", stmt: (x) => ["update public.job_groups set hold_credits = 0 where id = $1", [x.gid]], code: "23514", target: ["job_groups_hold_credits_check"] },
  { name: "part job unique", stmt: (x) => ["insert into public.job_group_parts(group_id,part_index,job_id,quote_id,reserved_credits) values ($1,99,$2,'pcq_dup',1)", [x.gid, x.job1]], code: "23505", target: ["job_group_parts_job_id_key"] },
  { name: "frozen sha", stmt: (x) => ["insert into public.job_group_frozen(group_id,part_index,job_id,path,sha256,row_count,charged_credits) values ($1,98,$2,'p/x.json','xyz',1,0)", [x.gid, x.job1]], code: "23514", target: ["job_group_frozen_sha256_check"] },
  { name: "frozen rows", stmt: (x) => ["insert into public.job_group_frozen(group_id,part_index,job_id,path,sha256,row_count,charged_credits) values ($1,97,$2,'p/y.json',repeat('a',64),0,0)", [x.gid, x.job1]], code: "23514", target: ["job_group_frozen_row_count_check"] },
];

export const EXPECTED_CONSTRAINTS = [
  "credit_ledger_pkey", "chk_ledger_type", "chk_ledger_delta_direction", "credit_ledger_user_id_fkey", "chk_quotes_status", "chk_jobs_status",
  "chk_jobs_unit_price_positive", "chk_topups_amount_positive", "chk_topups_status", "credit_ledger_kinds_kind_check",
  "credit_ledger_kinds_ledger_id_fkey", "job_groups_quote_id_key", "job_group_parts_job_id_key", "job_group_parts_quote_id_key",
  "job_group_frozen_job_id_key", "job_group_frozen_path_key",
] as const;

function matches(error: SqlFailure, code: string, target: string[]): boolean {
  if (error.code !== code) return false;
  return target.some((t) => (t.startsWith("column:") ? error.column === t.slice(7) : error.constraint === t));
}

export async function probeConstraints(c: PoolClient): Promise<string[]> {
  const v: string[] = [];
  const u = await seedUserTx(c, 1000);
  const g = await groupTx(c, u, `pc_group_${u}`);
  const ok = await trySql(c, L("pc_ok", 5, "grant"), [u]);
  if (!ok.ok) return [`setup: valid grant insert failed: ${ok.error.message}`];
  const x: ConstraintCtx = { u, gid: g.gid, job1: g.job1 };
  for (const kase of CONSTRAINT_CASES) {
    const [text, params] = kase.stmt(x);
    const r = await trySql(c, text, params);
    if (r.ok || !matches(r.error, kase.code, kase.target)) {
      v.push(`${kase.name}: expected ${kase.code}/${kase.target.join("|")}, got ${r.ok ? "ok (row accepted)" : `${r.error.code}/${r.error.constraint ?? `column:${r.error.column}`} ${r.error.message}`}`);
    }
  }
  const present = new Set((await c.query("select conname from pg_constraint where convalidated and conname = any($1)", [EXPECTED_CONSTRAINTS])).rows.map((r) => r.conname as string));
  for (const name of EXPECTED_CONSTRAINTS) if (!present.has(name)) v.push(`catalog ${name} missing`);
  const fns = new Set((await c.query("select distinct proname from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1)", [MONEY_FUNCTIONS])).rows.map((r) => r.proname as string));
  for (const name of MONEY_FUNCTIONS) if (!fns.has(name)) v.push(`catalog function ${name} missing`);
  return v;
}

// ---------------------------------------------------------------- probe 2: append-only

export async function probeAppendOnly(c: PoolClient): Promise<string[]> {
  const u = await seedUserTx(c, 1000);
  const admin = await seedAdminTx(c);
  await must(c, "public.admin_grant_credit_atomic($1::uuid,$2::uuid,10,'append-only probe','req_appendonly1')", [admin, u]);
  const g = await groupTx(c, u, `ao_group_${u}`);
  await deliverTx(c, g.job1, 3);
  await freezeTx(c, g, 1, g.job1, 3);
  const cases: Array<[string, string, unknown[]]> = [
    ["credit_ledger UPDATE", "update public.credit_ledger set note = note where id = $1", [`seed_${u}`]],
    ["credit_ledger DELETE", "delete from public.credit_ledger where id = $1", [`seed_${u}`]],
    ["credit_ledger_kinds UPDATE", "update public.credit_ledger_kinds set kind = kind where ledger_id = 'adm_req_appendonly1'", []],
    ["credit_ledger_kinds DELETE", "delete from public.credit_ledger_kinds where ledger_id = 'adm_req_appendonly1'", []],
    ["job_group_parts UPDATE", "update public.job_group_parts set reserved_credits = reserved_credits where group_id = $1", [g.gid]],
    ["job_group_parts DELETE", "delete from public.job_group_parts where group_id = $1", [g.gid]],
    ["job_group_keys UPDATE", "update public.job_group_keys set from_part = from_part where group_id = $1", [g.gid]],
    ["job_group_keys DELETE", "delete from public.job_group_keys where group_id = $1", [g.gid]],
    ["job_group_frozen UPDATE", "update public.job_group_frozen set row_count = row_count where group_id = $1", [g.gid]],
    ["job_group_frozen DELETE", "delete from public.job_group_frozen where group_id = $1", [g.gid]],
    // last: CASCADE because credit_ledger_kinds and promo_redemptions reference the ledger; the BEFORE TRUNCATE trigger fires first
    ["credit_ledger TRUNCATE", "truncate public.credit_ledger cascade", []],
  ];
  const v: string[] = [];
  for (const [name, text, params] of cases) {
    const r = await trySql(c, text, params);
    if (r.ok) v.push(`${name} was allowed`);
    else if (r.error.code !== "P0001" || !/append-only|cannot be truncated/.test(r.error.message)) v.push(`${name} failed for another reason: ${r.error.code} ${r.error.message}`);
  }
  return v;
}

// ---------------------------------------------------------------- probe 3: idempotency (replays write nothing)

interface IdemSetup { call: string; params: unknown[]; expectIds: string[] }
interface IdemCase { name: string; setup: (c: PoolClient) => Promise<IdemSetup>; replay: { flag: string } | { error: string } }

const PEOPLE_ITEMS = (volume: number) => [{ capabilitySlug: "decision-makers", endpointId: "x", targetVolumeMin: 1, targetVolumeMax: volume, unitPricePoints: 5,
  params: { requiredContactFields: ["work_email", "phone"] }, contactUnitPricesPoints: { basePerson: 5, workEmail: 10, phone: 20 } }];

export const IDEMPOTENCY_CASES: IdemCase[] = [
  { name: "reserve_credits_atomic", replay: { flag: "already_reserved" }, setup: async (c) => {
    const u = await seedUserTx(c, 1000);
    return { call: "public.reserve_credits_atomic($1::uuid,$2,$3::numeric,$4)", params: [u, "job_idem_res", 100, "idem"], expectIds: ["res_job_idem_res"] };
  } },
  { name: "accept_quote_atomic", replay: { flag: "already_accepted" }, setup: async (c) => {
    const u = await seedUserTx(c, 1000);
    await quoteTx(c, u, { quoteId: "q_idem_acc", unit: 1, volume: 10, reserve: 12 });
    return { call: "public.accept_quote_atomic($1,$2::uuid,$3)", params: ["q_idem_acc", u, sha256("q_idem_acc")], expectIds: [`res_${partJobId("q_idem_acc", 1)}`] };
  } },
  { name: "settle_job_atomic", replay: { flag: "already_settled" }, setup: async (c) => {
    const u = await seedUserTx(c, 1000);
    const job = await jobTx(c, u, { quoteId: "q_idem_settle", unit: 3.17, volume: 100, reserve: 365 });
    await deliverTx(c, job, 60);
    return { call: "public.settle_job_atomic($1,$2::numeric,null)", params: [job, PRODUCTION_CAP], expectIds: [`chg_${job}`, `rel_${job}`] };
  } },
  { name: "settle_people_job_atomic", replay: { flag: "already_settled" }, setup: async (c) => {
    const u = await seedUserTx(c, 5000);
    const job = await jobTx(c, u, { quoteId: "q_idem_people", unit: 5, volume: 100, reserve: 3500, items: PEOPLE_ITEMS(100) });
    await deliverTx(c, job, 40);
    return { call: "public.settle_people_job_atomic($1,40,30,20,$2::numeric,null)", params: [job, PRODUCTION_CAP], expectIds: [`chg_${job}`, `rel_${job}`] };
  } },
  { name: "release_job_atomic", replay: { flag: "already_released" }, setup: async (c) => {
    const u = await seedUserTx(c, 1000);
    const job = await jobTx(c, u, { quoteId: "q_idem_rel", unit: 1, volume: 10, reserve: 12 });
    return { call: "public.release_job_atomic($1,$2)", params: [job, "idem"], expectIds: [`rel_${job}`] };
  } },
  { name: "approve_topup_atomic", replay: { flag: "already_approved" }, setup: async (c) => {
    const u = await seedUserTx(c, 0);
    await c.query("insert into public.topups(id,user_id,amount_egp,reference,sender_name,sender_phone,receipt_file_id) values ('t_idem',$1,50,'ref_idem','n','p','f')", [u]);
    return { call: "public.approve_topup_atomic($1,null)", params: ["t_idem"], expectIds: ["top_t_idem"] };
  } },
  { name: "purchase_methodology_atomic", replay: { flag: "already_purchased" }, setup: async (c) => {
    const u = await seedUserTx(c, 1000);
    return { call: "public.purchase_methodology_atomic($1::uuid,$2,$3::numeric,$4)", params: [u, "job_idem_meth", 40, "idem"], expectIds: ["chg_meth_job_idem_meth"] };
  } },
  { name: "admin_grant_credit_atomic", replay: { flag: "already_granted" }, setup: async (c) => {
    const u = await seedUserTx(c, 0);
    const admin = await seedAdminTx(c);
    return { call: "public.admin_grant_credit_atomic($1::uuid,$2::uuid,$3::numeric,$4,$5)", params: [admin, u, 70, "idem grant", "req_idem_0001"], expectIds: ["adm_req_idem_0001"] };
  } },
  { name: "redeem_promo_code_atomic", replay: { error: "already_redeemed" }, setup: async (c) => {
    const u = await seedUserTx(c, 0);
    const admin = await seedAdminTx(c);
    await must(c, "public.admin_save_promo_code_atomic($1::uuid,'IDEM_CODE',50,10,null,null,true,'idem')", [admin]);
    return { call: "public.redeem_promo_code_atomic($1::uuid,$2)", params: [u, "IDEM_CODE"], expectIds: [`promo_IDEM_CODE_${u}`] };
  } },
  { name: "accept_group_quote_atomic", replay: { flag: "already_accepted" }, setup: async (c) => {
    const u = await seedUserTx(c, 1000);
    const g = await groupQuoteTx(c, u, "gq_idem_acc");
    return { call: ACCEPT_GROUP_SQL, params: [g.quoteId, u, g.hash], expectIds: [`res_${g.gid}`, `gdr_${g.job1}`, `res_${g.job1}`] };
  } },
  { name: "freeze_and_settle_group_part_atomic", replay: { flag: "already_frozen" }, setup: async (c) => {
    const u = await seedUserTx(c, 1000);
    const g = await groupTx(c, u, "gq_idem_frz");
    await deliverTx(c, g.job1, 7);
    const f = freezeCall(g, 1, g.job1, 7);
    return { call: f.sql, params: f.params, expectIds: [`chg_${g.job1}`, `rel_${g.job1}`] };
  } },
  { name: "draw_next_group_part_atomic", replay: { flag: "already_drawn" }, setup: async (c) => {
    const u = await seedUserTx(c, 1000);
    const g = await groupTx(c, u, "gq_idem_draw");
    await deliverTx(c, g.job1, 7);
    await freezeTx(c, g, 1, g.job1, 7);
    const d = drawCall(g, 2, 7);
    const job2 = partJobId(g.quoteId, 2);
    return { call: d.sql, params: d.params, expectIds: [`gdr_${job2}`, `res_${job2}`] };
  } },
  { name: "release_unfrozen_group_part_atomic", replay: { flag: "already_released" }, setup: async (c) => {
    const u = await seedUserTx(c, 1000);
    const g = await groupTx(c, u, "gq_idem_unf");
    await deliverTx(c, g.job1, 7);
    return { call: "public.release_unfrozen_group_part_atomic($1,1,$2,$3)", params: [g.gid, g.job1, "نص"], expectIds: [`rel_${g.job1}`] };
  } },
  { name: "close_job_group_atomic", replay: { flag: "already_closed" }, setup: async (c) => {
    const u = await seedUserTx(c, 1000);
    const g = await groupTx(c, u, "gq_idem_close");
    await deliverTx(c, g.job1, 7);
    await freezeTx(c, g, 1, g.job1, 7);
    return { call: CLOSE_OPERATOR_SQL, params: [g.gid], expectIds: [`rel_${g.gid}`] };
  } },
];

const minus = (a: string[], b: string[]) => { const s = new Set(b); return a.filter((x) => !s.has(x)).sort(); };

export async function probeIdempotency(c: PoolClient): Promise<string[]> {
  const v: string[] = [];
  for (const kase of IDEMPOTENCY_CASES) {
    await c.query("SAVEPOINT ms_case");
    try {
      const s = await kase.setup(c);
      const before = await ledgerIds(c);
      const r1 = await rpc(c, s.call, s.params);
      const mid = await ledgerIds(c);
      const wrote = minus(mid, before);
      if (!r1.ok || r1.r?.success !== true || JSON.stringify(wrote) !== JSON.stringify([...s.expectIds].sort())) {
        v.push(`${kase.name}: first call wrote [${wrote.join(", ")}] expected [${[...s.expectIds].sort().join(", ")}] (${JSON.stringify(r1.ok ? r1.r : r1.error.message)})`);
      }
      const r2 = await rpc(c, s.call, s.params);
      const after = await ledgerIds(c);
      const again = minus(after, mid);
      if (again.length > 0 || after.length !== mid.length) v.push(`${kase.name}: replay wrote [${again.join(", ")}] (rows ${mid.length} -> ${after.length})`);
      if ("flag" in kase.replay) {
        const value = r2.ok ? r2.r?.[kase.replay.flag] : `error ${r2.error.message}`;
        if (!(r2.ok && value === true)) v.push(`${kase.name}: replay flag ${kase.replay.flag} = ${JSON.stringify(value)}`);
      } else if (!(r2.ok && r2.r?.success === false && r2.r?.error === kase.replay.error)) {
        v.push(`${kase.name}: replay expected error ${kase.replay.error}, got ${JSON.stringify(r2.ok ? r2.r : r2.error.message)}`);
      }
      await c.query("RELEASE SAVEPOINT ms_case");
    } catch (e: any) {
      await c.query("ROLLBACK TO SAVEPOINT ms_case");
      v.push(`${kase.name}: setup failed: ${String(e?.message ?? e)}`);
    }
  }
  return v;
}

// ---------------------------------------------------------------- mutants: each test must catch its named mutant

export type MutantId =
  | "C1_drop_sign_check" | "C2_drop_type_check" | "C3_user_nullable" | "C4_drop_ledger_pk" | "C5_drop_part_job_unique" | "C6_drop_quote_status" | "C7_drop_ledger_user_fk"
  | "A1_drop_ledger_row_trigger" | "A2_drop_ledger_truncate_trigger" | "A3_drop_kinds_trigger" | "A4_drop_parts_trigger" | "A5_drop_keys_trigger" | "A6_drop_frozen_trigger"
  | "I1_reserve_replay" | "I2_settle_replay" | "I3_topup_replay" | "I4_methodology_replay" | "I5_grant_random_id"
  | "P1_charge_floor" | "P2_charge_not_capped_by_reserve" | "P3_release_one_more" | "P4_no_concurrency_limit" | "P5_settle_skips_release"
  | "R1_group_remainder_whole_hold";

export type Mutant = { id: MutantId; file: string; find: string; replace: string } | { id: MutantId; sql: string };

/** Replaces the anchor; refuses unless it occurs exactly once (a mutant can never silently become a no-op). */
export function mutateOnce(source: string, find: string, replace: string, id: string): string {
  const n = source.split(find).length - 1;
  if (n !== 1) throw new Error(`mutant ${id}: anchor found ${n} times`);
  return source.replace(find, () => replace);
}

/** A source file without its own transaction control: its BEGIN;/COMMIT; would end the caller's rolled-back transaction (Gate 1 P1). */
export function withoutTransactionControl(text: string): string {
  return text.replace(/^BEGIN;[ \t]*$/m, "").replace(/^COMMIT;[ \t]*$/m, "");
}

export function mutantSql(m: Mutant): string {
  if ("sql" in m) return m.sql;
  return withTerminator(mutateOnce(withoutTransactionControl(repoText(m.file)), m.find, m.replace, m.id));
}

export async function applyMutant(c: PoolClient, m: Mutant): Promise<void> {
  await c.query(mutantSql(m));
}

const SETTLE_FILE = "supabase/migrations/20261104222000_record_production_quote_and_settle.sql";
const sqlMutant = (id: MutantId, sql: string): Mutant => ({ id, sql });
const fileMutant = (id: MutantId, file: string, find: string, replace: string): Mutant => ({ id, file, find, replace });

export const MUTANTS: Record<MutantId, Mutant> = {
  C1_drop_sign_check: sqlMutant("C1_drop_sign_check", "ALTER TABLE public.credit_ledger DROP CONSTRAINT chk_ledger_delta_direction;"),
  C2_drop_type_check: sqlMutant("C2_drop_type_check", "ALTER TABLE public.credit_ledger DROP CONSTRAINT chk_ledger_type;"),
  C3_user_nullable: sqlMutant("C3_user_nullable", "ALTER TABLE public.credit_ledger ALTER COLUMN user_id DROP NOT NULL;"),
  C4_drop_ledger_pk: sqlMutant("C4_drop_ledger_pk", "ALTER TABLE public.credit_ledger DROP CONSTRAINT credit_ledger_pkey CASCADE;"),
  C5_drop_part_job_unique: sqlMutant("C5_drop_part_job_unique", "ALTER TABLE public.job_group_parts DROP CONSTRAINT job_group_parts_job_id_key;"),
  C6_drop_quote_status: sqlMutant("C6_drop_quote_status", "ALTER TABLE public.plans_quotes DROP CONSTRAINT chk_quotes_status;"),
  C7_drop_ledger_user_fk: sqlMutant("C7_drop_ledger_user_fk", "ALTER TABLE public.credit_ledger DROP CONSTRAINT credit_ledger_user_id_fkey;"),
  A1_drop_ledger_row_trigger: sqlMutant("A1_drop_ledger_row_trigger", "DROP TRIGGER trg_block_ledger_mutation ON public.credit_ledger;"),
  A2_drop_ledger_truncate_trigger: sqlMutant("A2_drop_ledger_truncate_trigger", "DROP TRIGGER trg_block_ledger_truncate ON public.credit_ledger;"),
  A3_drop_kinds_trigger: sqlMutant("A3_drop_kinds_trigger", "DROP TRIGGER trg_block_credit_kind_mutation ON public.credit_ledger_kinds;"),
  A4_drop_parts_trigger: sqlMutant("A4_drop_parts_trigger", "DROP TRIGGER trg_block_job_group_parts_mutation ON public.job_group_parts;"),
  A5_drop_keys_trigger: sqlMutant("A5_drop_keys_trigger", "DROP TRIGGER trg_block_job_group_keys_mutation ON public.job_group_keys;"),
  A6_drop_frozen_trigger: sqlMutant("A6_drop_frozen_trigger", "DROP TRIGGER trg_block_job_group_frozen_mutation ON public.job_group_frozen;"),
  I1_reserve_replay: fileMutant("I1_reserve_replay", "tests/replica/prod-definitions/reserve_credits_atomic.sql",
    "IF EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = v_res_id) THEN", "IF false THEN"),
  I2_settle_replay: fileMutant("I2_settle_replay", SETTLE_FILE, "IF v_job.status = 'completed' THEN", "IF false THEN"),
  I3_topup_replay: fileMutant("I3_topup_replay", "tests/replica/prod-definitions/approve_topup_atomic.sql", "IF v_topup.status = 'approved' THEN", "IF false THEN"),
  I4_methodology_replay: fileMutant("I4_methodology_replay", "supabase/migrations/20261016002600_purchase_methodology_atomic.sql",
    "IF EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = v_chg_id) THEN", "IF false THEN"),
  I5_grant_random_id: fileMutant("I5_grant_random_id", "supabase/migrations/20261018140500_promo_codes_and_admin_grants.sql",
    "v_ledger_id := 'adm_' || p_request_id;", "v_ledger_id := 'adm_' || p_request_id || '_' || md5(clock_timestamp()::text);"),
  P1_charge_floor: fileMutant("P1_charge_floor", SETTLE_FILE,
    "v_raw_charge := CEIL(COALESCE(v_job.delivered_units, 0) * v_job.unit_price);", "v_raw_charge := FLOOR(COALESCE(v_job.delivered_units, 0) * v_job.unit_price);"),
  P2_charge_not_capped_by_reserve: fileMutant("P2_charge_not_capped_by_reserve", SETTLE_FILE,
    "v_final_charge := LEAST(v_raw_charge, v_job.reserved_credits, p_points_cap);", "v_final_charge := LEAST(v_raw_charge, p_points_cap);"),
  P3_release_one_more: fileMutant("P3_release_one_more", "tests/replica/prod-definitions/release_job_atomic.sql",
    "('rel_' || p_job_id, v_job.user_id, v_job.reserved_credits, 'release',", "('rel_' || p_job_id, v_job.user_id, v_job.reserved_credits + 1, 'release',"),
  P4_no_concurrency_limit: fileMutant("P4_no_concurrency_limit", "tests/replica/prod-definitions/accept_quote_atomic.sql", "IF v_active_jobs >= 2 THEN", "IF v_active_jobs >= 1000 THEN"),
  P5_settle_skips_release: fileMutant("P5_settle_skips_release", SETTLE_FILE, "IF NOT v_rel_exists THEN", "IF false THEN"),
  R1_group_remainder_whole_hold: fileMutant("R1_group_remainder_whole_hold", "docs/proposals/job-groups-one-hold/01_job_groups_one_hold.sql",
    "v_rem := v_group.hold_credits - v_group.drawn_credits;", "v_rem := v_group.hold_credits;"),
};
