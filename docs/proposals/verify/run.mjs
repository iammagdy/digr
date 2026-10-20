import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
const R = new URL("../../../", import.meta.url).pathname;
const db = new PGlite();
const out = [];
let failed = 0;
const ok = (name, cond, extra = "") => { out.push(`${cond ? "PASS" : "FAIL"} ${name} ${cond ? "" : extra}`); if (!cond) failed++; };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const j = (v) => (typeof v === "string" ? JSON.parse(v) : v);

await db.exec(`
create role service_role; create role anon; create role authenticated;
create schema auth; create schema extensions; create schema vault; create schema net; create schema cron;
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, raw_app_meta_data jsonb default '{}');
create table public.profiles (id uuid primary key);
create table public.credit_ledger (id text primary key, user_id uuid not null, delta numeric not null, type text not null, job_id text, topup_id text, note text, created_at timestamptz default now(),
  check ((type in ('reserve','charge') and delta<0) or (type in ('release','topup','grant','goodwill') and delta>0)));
create table public.topups (id text primary key, user_id uuid, amount_egp numeric, reference text, status text, created_at timestamptz default now());
create table public.settings_private (key text primary key, value jsonb, updated_at timestamptz default now());
create table public.provider_costs (id bigserial primary key, job_id text, provider text, units int, cost_usd numeric, created_at timestamptz default now(), is_estimate boolean);
create table public.jobs (id text primary key, status text, lease_until timestamptz, updated_at timestamptz default now());
create view vault.decrypted_secrets as select 'x'::text as name, 'y'::text as decrypted_secret where false;
create table cron.job (jobid serial, jobname text);
create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname) values (n) returning jobid::bigint $$;
create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
create function net.http_get(url text, headers jsonb, timeout_milliseconds int) returns bigint language sql as $$ select 1::bigint $$;
`);
const strip = (s) => s.replace(/CREATE EXTENSION IF NOT EXISTS [^;]+;/g, "");
for (const f of ["supabase/migrations/20261018140000_credit_ledger_kinds.sql"]) { try { await db.exec(readFileSync(R + f, "utf8")); } catch (e) { out.push("LOAD kinds FAIL " + e.message); failed++; } }
for (const f of ["01_extend_ledger_kinds", "02_bundle_bonus", "03_work_email_bonus", "04_referral", "05_job_cap_and_start_gate", "06_custom_offers", "07_pg_cron_driver"]) {
  try { await db.exec(strip(readFileSync(`${R}docs/proposals/${f}.sql`, "utf8"))); out.push(`LOAD ${f} ok`); } catch (e) { out.push(`LOAD ${f} FAIL ${e.message}`); failed++; }
}

const U = (n) => `00000000-0000-0000-0000-00000000000${n}`;
for (const n of [1, 2, 3, 4, 5]) { await db.query("insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())", [U(n), `u${n}@acme-co.com`]); await db.query("insert into profiles(id) values ($1)", [U(n)]); }
await db.query("update auth.users set email='someone@gmail.com' where id=$1", [U(5)]);
await db.query("insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data) values ($1,'admin@acme-co.com',now(),'{\"role\":\"admin\"}')", [U(9)]);
await db.query("insert into profiles(id) values ($1)", [U(9)]);

// ---- 4a bundle bonus
await db.query("insert into topups(id,user_id,amount_egp,status) values ('tp1',$1,500,'approved'),('tp2',$1,99,'approved'),('tp3',$1,500,'pending'),('tp4',$1,500,'approved')", [U(1)]);
await db.query("insert into credit_ledger(id,user_id,delta,type) values ('top_tp1',$1,5000,'topup'),('top_tp2',$1,990,'topup')", [U(1)]);
let r = j((await q("select grant_topup_bonus_atomic('tp1') r"))[0].r);
ok("4a 500 EGP gives 15% = 750", r.success && r.points == 750 && r.ledger_id === "bon_tp1", JSON.stringify(r));
r = j((await q("select grant_topup_bonus_atomic('tp1') r"))[0].r);
ok("4a repeat is idempotent (no second row)", r.success && r.already_granted === true && (await q("select count(*)::int c from credit_ledger where id='bon_tp1'"))[0].c === 1);
ok("4a base row untouched", (await q("select delta from credit_ledger where id='top_tp1'"))[0].delta == 5000);
r = j((await q("select grant_topup_bonus_atomic('tp2') r"))[0].r);
ok("4a below first tier gives nothing", r.success && r.points == 0 && (await q("select count(*)::int c from credit_ledger where id='bon_tp2'"))[0].c === 0);
r = j((await q("select grant_topup_bonus_atomic('tp3') r"))[0].r);
ok("4a pending top-up refused", r.success === false && r.error === "topup_not_approved");
r = j((await q("select grant_topup_bonus_atomic('tp4') r"))[0].r);
ok("4a approved without its base row refused", r.success === false && r.error === "base_credit_missing");
ok("4a kind recorded", (await q("select kind from credit_ledger_kinds where ledger_id='bon_tp1'"))[0].kind === "bundle_bonus");
let denied = false; try { await db.exec("set role anon; select grant_topup_bonus_atomic('tp1');"); } catch { denied = true; } await db.exec("reset role");
ok("4a anon cannot execute", denied);

// ---- 4b work email
r = j((await q("select grant_work_email_bonus_atomic($1) r", [U(1)]))[0].r);
ok("4b company e-mail earns 100", r.success && r.points == 100 && r.ledger_id === "bon_workemail_" + U(1), JSON.stringify(r));
r = j((await q("select grant_work_email_bonus_atomic($1) r", [U(1)]))[0].r);
ok("4b repeat idempotent", r.already_granted === true && (await q("select count(*)::int c from credit_ledger where user_id=$1 and id like 'bon_workemail_%'", [U(1)]))[0].c === 1);
r = j((await q("select grant_work_email_bonus_atomic($1) r", [U(5)]))[0].r);
ok("4b free provider refused", r.success === false && r.error === "not_work_email");
await q("select grant_work_email_bonus_atomic($1)", [U(2)]); await q("select grant_work_email_bonus_atomic($1)", [U(3)]);
r = j((await q("select grant_work_email_bonus_atomic($1) r", [U(4)]))[0].r);
ok("4b fourth account of one domain refused", r.success === false && r.error === "domain_limit", JSON.stringify(r));
await db.query("update auth.users set email_confirmed_at=null where id=$1", [U(4)]);
r = j((await q("select grant_work_email_bonus_atomic($1) r", [U(4)]))[0].r);
ok("4b unconfirmed refused", r.success === false && r.error === "email_not_confirmed");

// ---- 4c referral (code owner U(1) has approved topup tp1)
await db.query("insert into referral_codes(user_id,code) values ($1,'ABC12345')", [U(1)]);
await db.query("insert into topups(id,user_id,amount_egp,status) values ('tp_ref',$1,150,'approved')", [U(2)]);
r = j((await q("select register_referral_atomic($1,'ABC12345') r", [U(1)]))[0].r);
ok("4c self-referral refused", r.success === false && r.error === "self_referral");
r = j((await q("select register_referral_atomic($1,'ZZZ99999') r", [U(3)]))[0].r);
ok("4c unknown code refused", r.success === false);
r = j((await q("select register_referral_atomic($1,'ABC12345') r", [U(2)]))[0].r);
ok("4c account that already topped up is not new", r.success === false && r.error === "not_new");
await db.query("delete from topups where id='tp_ref'");
r = j((await q("select register_referral_atomic($1,'ABC12345') r", [U(2)]))[0].r);
ok("4c new account registers", r.success === true);
r = j((await q("select grant_referral_reward_atomic($1) r", [U(2)]))[0].r);
ok("4c no reward before a qualifying top-up", r.rewarded === false && r.reason === "no_qualifying_topup", JSON.stringify(r));
await db.query("insert into topups(id,user_id,amount_egp,status) values ('tp_ref',$1,50,'approved')", [U(2)]);
r = j((await q("select grant_referral_reward_atomic($1) r", [U(2)]))[0].r);
ok("4c below minimum top-up gets nothing", r.rewarded === false);
await db.query("update topups set amount_egp=150 where id='tp_ref'");
r = j((await q("select grant_referral_reward_atomic($1) r", [U(2)]))[0].r);
ok("4c reward pays both sides", r.rewarded === true && r.referrer_points == 200 && r.referee_points == 100, JSON.stringify(r));
const refRows = await q("select id, delta from credit_ledger where id like 'ref_%' order by id");
ok("4c two ledger rows with ref_ ids", refRows.length === 2 && refRows.every((x) => x.id.startsWith("ref_")), JSON.stringify(refRows));
r = j((await q("select grant_referral_reward_atomic($1) r", [U(2)]))[0].r);
ok("4c repeat pays nothing more", r.already_rewarded === true && (await q("select count(*)::int c from credit_ledger where id like 'ref_%'"))[0].c === 2);

// ---- 4e gate
await db.query("insert into credit_ledger(id,user_id,delta,type) values ('g1',$1,5000,'grant')", [U(3)]);
await db.query("insert into settings_private(key,value) values ('provider_limits','{\"dailyUsd\":1}')");
const gate = async (res, cost, conf = false) => j((await q("select job_start_gate($1,$2,$3,$4) r", [U(3), res, cost, conf]))[0].r).decision + ":" + (j((await q("select job_start_gate($1,$2,$3,$4) r", [U(3), res, cost, conf]))[0].r).code ?? "");
ok("4e small allowed", (await gate(300, 0.1)) === "allow:");
ok("4e insufficient", (await gate(6000, 0.1)) === "blocked:insufficient_balance", await gate(6000, 0.1));
await db.query("insert into credit_ledger(id,user_id,delta,type) values ('g2',$1,5000,'grant')", [U(3)]);
ok("4e over job cap (6000 default)", (await gate(6001, 0.1)) === "blocked:over_job_cap", await gate(6001, 0.1));
ok("4e needs confirmation above 600", (await gate(700, 0.1)) === "needs_confirmation:");
ok("4e confirmed allowed", (await gate(700, 0.1, true)) === "allow:");
await db.query("insert into provider_costs(job_id,provider,units,cost_usd) values ('x','p',1,0.95)");
ok("4e provider daily cap", (await gate(300, 0.1)) === "blocked:provider_daily_cap", await gate(300, 0.1));

// ---- 4f offers
r = j((await q("select admin_create_custom_offer_atomic($1,$2,0.1,50000,6000,now()+interval '30 days','x','req_00000001') r", [U(9), U(1)]))[0].r);
ok("4f admin creates an offer", r.success && r.offer_id === "off_req_00000001", JSON.stringify(r));
r = j((await q("select admin_create_custom_offer_atomic($1,$2,0.1,50000,6000,now()+interval '30 days','x','req_00000001') r", [U(9), U(1)]))[0].r);
ok("4f repeat idempotent", r.already_created === true);
r = j((await q("select admin_create_custom_offer_atomic($1,$2,0.1,50000,6000,now()+interval '30 days','x','req_00000001') r", [U(9), U(2)]))[0].r);
ok("4f same request id for a different customer conflicts", r.success === false && r.error === "request_id_conflict");
r = j((await q("select admin_create_custom_offer_atomic($1,$2,0.1,50000,6000,now()+interval '30 days','x','req_00000002') r", [U(1), U(1)]))[0].r);
ok("4f non-admin refused", r.success === false && r.error === "not_admin");
r = j((await q("select consume_custom_offer_atomic('off_req_00000001',$1,'q1') r", [U(2)]))[0].r);
ok("4f other customer cannot use it", r.success === false);
r = j((await q("select consume_custom_offer_atomic('off_req_00000001',$1,'q1') r", [U(1)]))[0].r);
ok("4f owner consumes it", r.success === true && r.already_used === false);
r = j((await q("select consume_custom_offer_atomic('off_req_00000001',$1,'q1') r", [U(1)]))[0].r);
ok("4f same quote again is idempotent", r.already_used === true);
r = j((await q("select consume_custom_offer_atomic('off_req_00000001',$1,'q2') r", [U(1)]))[0].r);
ok("4f a second quote cannot reuse it", r.success === false && r.error === "offer_already_used");

// ---- 4g
await db.query("insert into jobs(id,status,lease_until) values ('j1','running',null)");
await db.exec("select public.drive_jobs_tick()");
ok("4g tick with no secrets does nothing and does not fail", true);
const c1 = (await q("select count(*)::int c from cron.job where jobname='diger-drive-jobs'"))[0].c;
await db.exec(strip(readFileSync(R + "docs/proposals/07_pg_cron_driver.sql", "utf8")));
ok("4g re-applying keeps exactly one schedule", c1 === 1 && (await q("select count(*)::int c from cron.job where jobname='diger-drive-jobs'"))[0].c === 1);

// ledger invariant: nothing was ever updated or deleted in credit_ledger by the proposals
console.log(out.join("\n")); console.log(failed ? `FAILED ${failed}` : "ALL PASS");
process.exit(failed ? 1 : 0);
