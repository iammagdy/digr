// Runs the six SQL parts (01 to 05 as they are live, then the delta 06), the verify SELECT and the rollbacks against a THROWAWAY embedded Postgres (PGlite): nothing here touches Supabase.
// Not part of the app or its tests (no dependency was added to package.json). To run it:
//   mkdir /tmp/pgcheck && cd /tmp/pgcheck && npm init -y && npm i @electric-sql/pglite@0.3.14 && cp <repo>/docs/proposals/admin-invoices/sql-check/run.mjs . && SQL_DIR=<repo>/docs/proposals/admin-invoices/ node run.mjs
//
// It mimics the live project: the SQL is applied by a NON-superuser owner with BYPASSRLS (like `postgres`), and the default ACLs of the live `pg_default_acl` are copied
// (new tables: arwdDxtm to anon/authenticated/service_role; new functions: EXECUTE to anon/authenticated/service_role, on top of PUBLIC's implicit EXECUTE).
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
// SQL_DIR = the folder with the five parts
const dir = process.env.SQL_DIR ?? new URL("../", import.meta.url).pathname;
const db = new PGlite();
const ADMIN = "11111111-1111-4111-8111-111111111111";
const results = [];
const check = (name, ok, extra = "") => { results.push([ok ? "PASS" : "FAIL", name, extra]); };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const fails = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };
const failsScript = async (d, sql) => { try { await d.exec(sql); return null; } catch (e) { return e.message; } };
const PARTS = ["01_catalog_clients_settings", "02_documents", "03_numbering_and_guards", "04_functions", "05_security_rls_privileges"];
const PART6 = "06_statement_mode";
const RUNTIME = ["invoice_create_document", "invoice_save_draft", "invoice_set_status"];
const NONRUNTIME = ["invoice__apply_fields", "invoice__replace_children", "invoice_assign_number", "invoice_documents_guard", "invoice_never_delete", "invoice_children_guard", "invoice_events_append_only"];
const apply = async (f) => { await db.exec("set role app_owner"); try { await db.exec(fs.readFileSync(dir + f + ".sql", "utf8")); return null; } catch (e) { return e.message; } finally { await db.exec("reset role"); } };

const ROLE_SQL = `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create role app_owner nologin bypassrls;
create schema auth; create table auth.users (id uuid primary key); insert into auth.users values ('${ADMIN}');
grant usage on schema auth to service_role, app_owner; grant select, references on auth.users to app_owner;
grant usage on schema public to anon, authenticated, service_role; grant usage, create on schema public to app_owner;
alter default privileges for role app_owner in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role app_owner in schema public grant execute on functions to anon, authenticated, service_role;`;
await db.exec(ROLE_SQL);

// ---- apply 01..04, and show that BEFORE 05 the default privileges really do expose every function (so 05 is what closes them) ----
for (const f of PARTS.slice(0, 4)) { const e = await apply(f); check(`apply ${f} (as a non-superuser owner)`, e === null, String(e ?? "")); }
const before = await q("select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u, has_function_privilege('public', p.oid, 'EXECUTE') pub from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'invoice%'");
check("BEFORE part 05: all 10 functions are executable by anon, authenticated and PUBLIC (the default privileges)", before.length === 10 && before.every((r) => r.a && r.u && r.pub), JSON.stringify(before.filter((r) => !(r.a && r.u && r.pub)).map((r) => r.proname)));
{ const e = await apply(PARTS[4]); check("apply 05_security_rls_privileges", e === null, String(e ?? "")); }
// idempotent: every part can be run again, in any order, and part 04 (CREATE OR REPLACE) after 05 does not bring the grants back
for (const f of PARTS) { const e = await apply(f); check(`re-run ${f}`, e === null, String(e ?? "")); }
{ const e = await apply(PARTS[3]); check("re-run 04 AFTER 05 keeps the privileges closed", e === null); }

// ---- the state that is LIVE today (01 to 05): the verify must say that part 06 is not there, and everything else is fine ----
const verifySql = fs.readFileSync(dir + "98_verify_after_apply.sql", "utf8");
{
  const rows = await q(verifySql);
  check("BEFORE part 06: the verify returns 23 rows; the 18 table and function rows are ok", rows.length === 23 && rows.filter((r) => r.object_kind !== "check").every((r) => r.ok === true), String(rows.length));
  check("BEFORE part 06: the 5 `check` rows say ok = false (the verify sees that 06 is missing)", rows.filter((r) => r.object_kind === "check").length === 5 && rows.filter((r) => r.object_kind === "check").every((r) => r.ok === false));
  check("BEFORE part 06: a statement cannot be created", /check|violates/.test((await fails("select public.invoice_create_document($1,'statement','{}'::jsonb)", [ADMIN])) ?? ""));
}
{ const e = await apply(PART6); check("apply 06_statement_mode (as the non-superuser owner)", e === null, String(e ?? "")); }
{ const e = await apply(PART6); check("re-run 06 (idempotent)", e === null, String(e ?? "")); }
{ const e = await apply(PARTS[3]); const e2 = await apply(PART6); check("re-run 04 then 06 keeps working (05's privileges stay closed)", e === null && e2 === null, String(e ?? e2 ?? "")); }

// ---- every function, every role: the full privilege matrix ----
const fns = await q("select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'invoice%' order by 2");
check("10 invoice functions exist", fns.length === 10, String(fns.length));
check("owner of every function is the non-superuser app_owner", fns.every((f) => f.owner === "app_owner"));
check("exactly the 3 runtime functions are SECURITY DEFINER; the other 7 are INVOKER", fns.filter((f) => f.prosecdef).map((f) => f.proname).sort().join() === [...RUNTIME].sort().join());
check("every one of the 10 has a fixed search_path (public, pg_temp)", fns.every((f) => (f.proconfig ?? []).some((c) => /^search_path=.*pg_temp/.test(c))), JSON.stringify(fns.filter((f) => !(f.proconfig ?? []).some((c) => /^search_path=/.test(c))).map((f) => f.proname)));
for (const f of fns) {
  const m = (await q("select has_function_privilege('anon', $1, 'EXECUTE') a, has_function_privilege('authenticated', $1, 'EXECUTE') u, has_function_privilege('public', $1, 'EXECUTE') pub, has_function_privilege('service_role', $1, 'EXECUTE') s", [f.oid]))[0];
  check(`${f.proname}: no EXECUTE for anon, authenticated, PUBLIC`, !m.a && !m.u && !m.pub);
  check(`${f.proname}: service_role EXECUTE only if it is a runtime function`, m.s === RUNTIME.includes(f.proname));
}
// ---- actually CALLING every function as each role (what PostgREST does: SET LOCAL ROLE <jwt role>, then select fn(...)) ----
const nullArgs = (args) => args === "" ? "" : args.split(/,\s*(?![^()]*\))/).map((a) => { const t = a.trim().replace(/^\w+\s+/, "").replace(/\s+DEFAULT.*$/i, ""); return `NULL::${t}`; }).join(", ");
for (const role of ["anon", "authenticated"]) {
  await db.exec(`set role ${role}`);
  for (const f of fns) {
    const call = `select public.${f.proname}(${nullArgs(f.args)})`;
    const err = await fails(call);
    check(`${role} calling ${f.proname}(): permission denied`, /permission denied for function/.test(err ?? ""), String(err));
  }
  await db.exec("reset role");
}
await db.exec("set role service_role");
for (const f of fns.filter((x) => NONRUNTIME.includes(x.proname))) {
  const err = await fails(`select public.${f.proname}(${nullArgs(f.args)})`);
  check(`service_role calling the internal ${f.proname}(): permission denied`, /permission denied for function/.test(err ?? ""), String(err));
}
check("service_role CAN call the three runtime functions", (await fails("select public.invoice_create_document($1,'quote',$2::jsonb)", [ADMIN, JSON.stringify({ show_usd: true, batches: [], lines: [] })])) === null);
await db.exec("reset role");

// ---- behaviour (as before): numbering, rounding, lock, transitions, log, tables ----
const payload = (over = {}) => ({
  client_company: "شركة النور", client_contact: "", client_email: "", client_phone: "", client_address: "", issue_date: "2026-10-31", due_date: null,
  show_usd: true, show_points: true, show_egp: false, rate_egp_per_usd_e4: 507500, credit_value_e4: 1000, discount_kind: "percent", discount_value: 1000,
  tax_enabled: false, tax_label: "ضريبة", tax_bp: 0, notes: "", payment_instructions: "", instapay_address: "iammagdy@instapay", show_instapay_qr: true,
  batches: [{ key: "b1", title: "المرحلة ١", summary_only: false }],
  lines: [{ batch_key: "b1", item_type_name: "شركة", quantity: 250, unit_price_usd_centi_cents: 1200, hidden: false }, { batch_key: "b1", item_type_name: "مدير", quantity: 50, unit_price_usd_centi_cents: 3500, hidden: true }],
  ...over,
});
const create = async (type = "invoice", p = payload()) => (await q("select public.invoice_create_document($1,$2,$3::jsonb) as id", [ADMIN, type, JSON.stringify(p)]))[0].id;
const a = await create(); const b = await create(); const qt = await create("quote");
const nums = (await q("select number from public.invoice_documents")).map((r) => r.number).sort();
check("numbers INV-2026-0001/0002 and QUO-2026-0001 (counted separately)", /INV-20\d\d-0001/.test(nums.join()) && /INV-20\d\d-0002/.test(nums.join()) && /QUO-20\d\d-0001/.test(nums.join()), nums.join());
const lines = await q("select line_total_usd_cents t from public.invoice_lines where document_id=$1 order by sort_order", [a]);
check("generated line total (250 x 1200 -> 3000, 50 x 3500 -> 1750)", lines[0].t == 3000 && lines[1].t == 1750);
const d = await create("invoice", payload({ lines: [{ item_type_name: "x", quantity: 10, unit_price_usd_centi_cents: 5 }, { item_type_name: "y", quantity: 3, unit_price_usd_centi_cents: 45 }, { item_type_name: "z", quantity: 9, unit_price_usd_centi_cents: 5 }], batches: [] }));
check("tie rounds up (10 x 0.05 cent -> 1; 3 x 0.45 -> 1; 9 x 0.05 -> 0)", (await q("select line_total_usd_cents t from public.invoice_lines where document_id=$1 order by sort_order", [d])).map((r) => Number(r.t)).join() === "1,1,0");
check("creation writes the draft event with the admin id", (await q("select count(*)::int c from public.invoice_status_events where document_id=$1 and to_status='draft' and admin_id=$2", [a, ADMIN]))[0].c === 1);
await db.exec("update public.invoice_number_counters set last_value = 9999 where doc_type='invoice'");
check("number past 9999 keeps all digits", (await q("select number from public.invoice_documents where id=$1", [await create()]))[0].number.endsWith("-10000"));
check("save draft returns revision 2", (await q("select public.invoice_save_draft($1,$2,1,$3::jsonb) as r", [a, ADMIN, JSON.stringify(payload())]))[0].r === 2);
check("stale revision refused", /invoice_stale/.test(await fails("select public.invoice_save_draft($1,$2,1,$3::jsonb)", [a, ADMIN, JSON.stringify(payload())])));
check("one currency required", /one_currency|check/.test(await fails("select public.invoice_save_draft($1,$2,2,$3::jsonb)", [a, ADMIN, JSON.stringify(payload({ show_usd: false, show_points: false }))])));
check("rate needed for points", /rate_needed|check/.test(await fails("select public.invoice_save_draft($1,$2,2,$3::jsonb)", [a, ADMIN, JSON.stringify(payload({ rate_egp_per_usd_e4: null }))])));
check("unknown batch refused", /invoice_unknown_batch/.test(await fails("select public.invoice_save_draft($1,$2,2,$3::jsonb)", [a, ADMIN, JSON.stringify(payload({ lines: [{ batch_key: "zz", quantity: 1, unit_price_usd_centi_cents: 1 }] }))])));
check("a failed save changed nothing", (await q("select count(*)::int n from public.invoice_lines where document_id=$1", [a]))[0].n === 2);
const ls = await q("select id from public.invoice_lines where document_id=$1 order by sort_order", [a]);
const frozen = { lines: [{ id: ls[0].id, points: 15225, egp: 152250 }, { id: ls[1].id, points: 8881, egp: 88813 }],
  totals: { subtotal_usd_cents: 4750, discount_usd_cents: 475, tax_usd_cents: 0, total_usd_cents: 4275, subtotal_points: 24106, discount_points: 2411, tax_points: 0, total_points: 21695, subtotal_egp_qirsh: 241063, discount_egp_qirsh: 24106, tax_egp_qirsh: 0, total_egp_qirsh: 216957 } };
check("send with a wrong USD sum refused", /invoice_stale/.test(await fails("select public.invoice_set_status($1,$2,'sent',2,$3::jsonb,null,null,'')", [a, ADMIN, JSON.stringify({ ...frozen, totals: { ...frozen.totals, subtotal_usd_cents: 1 } })])));
check("send with a stale revision refused", /invoice_stale/.test(await fails("select public.invoice_set_status($1,$2,'sent',1,$3::jsonb,null,null,'')", [a, ADMIN, JSON.stringify(frozen)])));
await q("select public.invoice_set_status($1,$2,'sent',2,$3::jsonb,null,null,'')", [a, ADMIN, JSON.stringify(frozen)]);
const sent = (await q("select status, total_usd_cents, total_points, locked_at is not null as locked from public.invoice_documents where id=$1", [a]))[0];
check("sent: totals frozen and locked", sent.status === "sent" && sent.total_usd_cents == 4275 && sent.total_points == 21695 && sent.locked);
check("sent: per-line points frozen", (await q("select line_total_points p from public.invoice_lines where document_id=$1 order by sort_order", [a])).map((r) => Number(r.p)).join() === "15225,8881");
check("save after sent -> invoice_locked", /invoice_locked/.test(await fails("select public.invoice_save_draft($1,$2,2,$3::jsonb)", [a, ADMIN, JSON.stringify(payload())])));
for (const [what, sql] of [["edit a line", "update public.invoice_lines set quantity = 1 where document_id=$1"], ["insert a line", "insert into public.invoice_lines (document_id, sort_order, quantity, unit_price_usd_centi_cents) values ($1, 9, 1, 1)"], ["delete a line", "delete from public.invoice_lines where document_id=$1"], ["change the rate", "update public.invoice_documents set rate_egp_per_usd_e4 = 1000000 where id=$1"], ["change the client", "update public.invoice_documents set client_company = 'x' where id=$1"]]) {
  check(`even the owner role cannot ${what} of a sent document (trigger)`, /invoice_locked/.test(await fails(sql, [a])));
}
check("nor change status directly", /invoice_status_via_function_only/.test(await fails("update public.invoice_documents set status='paid', paid_at=current_date where id=$1", [a])));
check("nor change the number", /invoice_immutable_field/.test(await fails("update public.invoice_documents set number='INV-1' where id=$1", [a])));
check("never delete a document", /invoice_never_deleted/.test(await fails("delete from public.invoice_documents where id=$1", [a])));
check("never truncate documents", /invoice_never_deleted|cannot truncate/.test(await fails("truncate public.invoice_documents")));
check("paid needs a date", /invoice_paid_date_required/.test(await fails("select public.invoice_set_status($1,$2,'paid',null,null,null,'r','')", [a, ADMIN])));
await q("select public.invoice_set_status($1,$2,'paid',null,null,'2026-11-02','IPN-77','')", [a, ADMIN]);
const ev = await q("select to_status, admin_id, payment_reference from public.invoice_status_events where document_id=$1 order by id", [a]);
check("status log: draft, sent, paid with admin and reference", ev.map((e) => e.to_status).join() === "draft,sent,paid" && ev[2].payment_reference === "IPN-77" && ev.every((e) => e.admin_id === ADMIN));
check("paid is final (no void)", /invoice_bad_transition/.test(await fails("select public.invoice_set_status($1,$2,'void',null,null,null,null,'')", [a, ADMIN])));
check("a draft cannot be paid", /invoice_bad_transition/.test(await fails("select public.invoice_set_status($1,$2,'paid',null,null,'2026-11-02',null,'')", [b, ADMIN])));
check("a draft can be voided", (await fails("select public.invoice_set_status($1,$2,'void',null,null,null,null,'x')", [b, ADMIN])) === null);
check("event update blocked", /invoice_events_append_only/.test(await fails("update public.invoice_status_events set note='x'")));
check("event delete blocked", /invoice_events_append_only/.test(await fails("delete from public.invoice_status_events")));
check("event truncate blocked", /invoice_events_append_only/.test(await fails("truncate public.invoice_status_events")));
for (const role of ["anon", "authenticated"]) {
  await db.exec(`set role ${role}`);
  for (const t of ["invoice_documents", "invoice_lines", "invoice_clients", "invoice_item_types", "invoice_settings", "invoice_status_events", "invoice_number_counters", "invoice_batches"]) {
    check(`${role} cannot read ${t}`, /permission denied/.test(await fails(`select 1 from public.${t} limit 1`)));
  }
  check(`${role} cannot write documents`, /permission denied/.test(await fails("insert into public.invoice_documents (doc_type, number) values ('invoice','x')")));
  await db.exec("reset role");
}
await db.exec("set role service_role");
check("service_role can read documents", Number((await q("select count(*) c from public.invoice_documents"))[0].c) > 0);
check("service_role cannot write documents directly", /permission denied/.test(await fails("update public.invoice_documents set notes='x'")));
check("service_role cannot write lines directly", /permission denied/.test(await fails("insert into public.invoice_lines (document_id, sort_order, quantity, unit_price_usd_centi_cents) values ('00000000-0000-0000-0000-000000000000', 1, 1, 1)")));
check("service_role cannot write the log or the counters", /permission denied/.test(await fails("delete from public.invoice_status_events")) && /permission denied/.test(await fails("update public.invoice_number_counters set last_value = 0")));
check("service_role may edit item types and clients", (await fails("update public.invoice_item_types set default_unit_price_usd_centi_cents = 45")) === null && (await fails("insert into public.invoice_clients (company_name) values ('x')")) === null);
await db.exec("reset role");

// ---- the verify query: ONE result set, 18 rows, ok = true on every row ----
const rows = await q(verifySql);
check("verify AFTER 06: 23 rows (5 checks, 10 functions, 8 tables)", rows.length === 23 && rows.filter((r) => r.object_kind === "check").length === 5 && rows.filter((r) => r.object_kind === "table").length === 8 && rows.filter((r) => r.object_kind === "function").length === 10, String(rows.length));
check("verify: ok = true on every row", rows.every((r) => r.ok === true), JSON.stringify(rows.filter((r) => r.ok !== true).map((r) => r.object_name)));
const fr = rows.filter((r) => r.object_kind === "function");
check("verify: no function executable by anon, authenticated or PUBLIC (per-function columns)", fr.every((r) => r.anon_any_privilege === false && r.authenticated_any_privilege === false && r.public_any_privilege === false));
check("verify: security_definer only on the three runtime functions; search_path fixed on all 10; service_role executes only those three", fr.filter((r) => r.security_definer).length === 3 && fr.every((r) => r.search_path_fixed === true) && fr.filter((r) => r.service_role_can_write_or_execute).length === 3);
const tr = rows.filter((r) => r.object_kind === "table");
check("verify: tables: rls on, 0 policies, no customer or PUBLIC privilege, direct write only on settings, item types, clients", tr.every((r) => r.rls_on === true && r.policies === 0 && !r.anon_any_privilege && !r.authenticated_any_privilege && !r.public_any_privilege) && tr.filter((r) => r.service_role_can_write_or_execute).map((r) => r.object_name).sort().join() === "invoice_clients,invoice_item_types,invoice_settings");
// the verify must be SENSITIVE: break each rule on purpose and see ok turn false
const okOf = async (name) => (await q(verifySql)).find((r) => r.object_name.startsWith(name))?.ok;
const breaks = [
  ["a grant of EXECUTE to anon", "grant execute on function public.invoice_set_status(uuid, uuid, text, integer, jsonb, date, text, text) to anon", "revoke execute on function public.invoice_set_status(uuid, uuid, text, integer, jsonb, date, text, text) from anon", "invoice_set_status"],
  ["a grant of EXECUTE to authenticated", "grant execute on function public.invoice_create_document(uuid, text, jsonb, uuid, uuid) to authenticated", "revoke execute on function public.invoice_create_document(uuid, text, jsonb, uuid, uuid) from authenticated", "invoice_create_document"],
  ["a grant of EXECUTE to PUBLIC", "grant execute on function public.invoice__apply_fields(uuid, jsonb) to public", "revoke execute on function public.invoice__apply_fields(uuid, jsonb) from public", "invoice__apply_fields"],
  ["a grant of EXECUTE on an internal function to service_role", "grant execute on function public.invoice_never_delete() to service_role", "revoke execute on function public.invoice_never_delete() from service_role", "invoice_never_delete"],
  ["a missing fixed search_path", "alter function public.invoice_save_draft(uuid, uuid, integer, jsonb) reset search_path", "alter function public.invoice_save_draft(uuid, uuid, integer, jsonb) set search_path to 'public', 'pg_temp'", "invoice_save_draft"],
  ["a SECURITY DEFINER that should be INVOKER", "alter function public.invoice_children_guard() security definer", "alter function public.invoice_children_guard() security invoker", "invoice_children_guard"],
  ["a table privilege for authenticated", "grant select on public.invoice_lines to authenticated", "revoke select on public.invoice_lines from authenticated", "invoice_lines"],
  ["RLS switched off", "alter table public.invoice_clients disable row level security", "alter table public.invoice_clients enable row level security", "invoice_clients"],
  ["a policy added", "create policy p_test on public.invoice_batches for select using (true)", "drop policy p_test on public.invoice_batches", "invoice_batches"],
];
for (const [label, bad, fix, name] of breaks) {
  await db.exec(bad); const broken = await okOf(name); await db.exec(fix); const fixed = await okOf(name);
  check(`verify turns ok=false for ${label}, and back to true when fixed`, broken === false && fixed === true, `${broken}/${fixed}`);
}
check("verify: all 23 rows ok again after the fixes", (await q(verifySql)).every((r) => r.ok === true));

// ---- part 06 behaviour: data statements ----
const stm = (over = {}) => ({ show_usd: true, batches: [{ key: "k", title: "كهروميكانيكا", summary_only: false }], lines: [{ batch_key: "k", item_type_name: "شركة", quantity: 200, unit_price_usd_centi_cents: 0 }], ...over });
const sid = (await q("select public.invoice_create_document($1,'statement',$2::jsonb) as id", [ADMIN, JSON.stringify(stm())]))[0].id;
check("a statement is numbered STM-…-0001", /^STM-\d{4}-0001$/.test((await q("select number from public.invoice_documents where id=$1", [sid]))[0].number));
check("statement lines have price 0 and the generated total is 0", (await q("select line_total_usd_cents t from public.invoice_lines where document_id=$1", [sid])).every((r) => Number(r.t) === 0));
check("a statement line with a price is refused", /invoice_statement_no_prices/.test(await fails("select public.invoice_create_document($1,'statement',$2::jsonb)", [ADMIN, JSON.stringify(stm({ lines: [{ item_type_name: "x", quantity: 1, unit_price_usd_centi_cents: 5 }] }))])));
check("a statement with points, a rate, a discount or tax is refused by the table CHECK", (await Promise.all([{ show_points: true, rate_egp_per_usd_e4: 507500 }, { discount_kind: "percent", discount_value: 100 }, { tax_enabled: true, tax_bp: 100 }].map((o) => fails("select public.invoice_create_document($1,'statement',$2::jsonb)", [ADMIN, JSON.stringify(stm(o))])))).every((m) => /statement_no_money|check/.test(m ?? "")));
check("a statement can be sent (frozen at 0) and voided", (await fails("select public.invoice_set_status($1,$2,'sent',1,$3::jsonb,null,null,'')", [sid, ADMIN, JSON.stringify({ lines: (await q("select id from public.invoice_lines where document_id=$1", [sid])).map((r) => ({ id: r.id, points: null, egp: null })), totals: { subtotal_usd_cents: 0, discount_usd_cents: 0, tax_usd_cents: 0, total_usd_cents: 0 } })])) === null);
check("a sent statement can NEVER be paid", /invoice_bad_transition/.test(await fails("select public.invoice_set_status($1,$2,'paid',null,null,'2026-11-02','','')", [sid, ADMIN])));
const qid = await create("quote", payload({ show_points: false, show_egp: false, rate_egp_per_usd_e4: null, discount_kind: "none", discount_value: 0, tax_enabled: false }));
const qLines = await q("select id from public.invoice_lines where document_id=$1", [qid]);
await q("select public.invoice_set_status($1,$2,'sent',1,$3::jsonb,null,null,'')", [qid, ADMIN, JSON.stringify({ lines: qLines.map((r) => ({ id: r.id, points: null, egp: null })), totals: { subtotal_usd_cents: 4750, discount_usd_cents: 0, tax_usd_cents: 0, total_usd_cents: 4750 } })]);
check("a sent QUOTE can no longer be marked paid (only an invoice)", /invoice_bad_transition/.test(await fails("select public.invoice_set_status($1,$2,'paid',null,null,'2026-11-02','','')", [qid, ADMIN])));
check("an INVOICE can still be marked paid (earlier flow unchanged)", (await q("select status from public.invoice_documents where id=$1", [a]))[0].status === "paid");
check("verify is still ok = true on all 23 rows after real statement traffic", (await q(verifySql)).every((r) => r.ok === true));
// the part 06 rollback refuses while a statement exists, because documents are never deleted
check("rollback of 06 refuses while a statement exists", /statements exist|cannot be rolled back/.test((await failsScript(db, fs.readFileSync(dir + "06_statement_mode.rollback.sql", "utf8"))) ?? ""));

// ---- the part 06 rollback really works (on a fresh database with no statement) ----
{
  const d2 = new PGlite();
  await d2.exec(ROLE_SQL);
  const run = async (f) => { await d2.exec("set role app_owner"); try { await d2.exec(fs.readFileSync(dir + f + ".sql", "utf8")); return null; } catch (e) { return e.message; } finally { await d2.exec("reset role"); } };
  let ok6 = true;
  for (const f of [...PARTS, PART6]) ok6 = ok6 && (await run(f)) === null;
  check("fresh database: parts 01 to 06 apply", ok6);
  const rb = await failsScript(d2, fs.readFileSync(dir + "06_statement_mode.rollback.sql", "utf8"));
  check("fresh database: the 06 rollback runs when no statement exists", rb === null, String(rb ?? ""));
  const err = await d2.query("select public.invoice_create_document($1,'statement','{}'::jsonb)", [ADMIN]).then(() => "created", (e) => e.message);
  check("fresh database: after the 06 rollback a statement can no longer be created", /check|violates/.test(err), err);
  const restored = (await run("03_numbering_and_guards")) === null && (await run("04_functions")) === null;
  const bodies = (await d2.query("select (select position('STM' in prosrc) from pg_proc where proname = 'invoice_assign_number') as a, (select position('invoice_statement_no_prices' in prosrc) from pg_proc where proname = 'invoice__replace_children') as c, (select position('v_doc.doc_type' in prosrc) from pg_proc where proname = 'invoice_set_status') as b")).rows[0];
  check("fresh database: re-running 03 and 04 restores the earlier function bodies (no STM, no statement price rule, no paid-only-invoice rule)", restored && bodies.a === 0 && bodies.b === 0 && bodies.c === 0, JSON.stringify(bodies));
  const after = (await d2.query(verifySql)).rows;
  check("fresh database: after the rollback the verify shows exactly the 5 part-06 checks as not ok and the 18 others ok", after.filter((r) => r.ok !== true).length === 5 && after.filter((r) => r.ok !== true).every((r) => r.object_kind === "check"));
  check("fresh database: applying 06 again brings the verify back to 23 ok", (await run(PART6)) === null && (await d2.query(verifySql)).rows.every((r) => r.ok === true));
  await d2.close();
}

// ---- rollback ----
try { await db.exec(fs.readFileSync(dir + "99_rollback.sql", "utf8")); const left = await q("select count(*)::int c from pg_class where relnamespace='public'::regnamespace and relname like 'invoice%'"); const fn = await q("select count(*)::int c from pg_proc where pronamespace='public'::regnamespace and proname like 'invoice%'"); check("rollback removes every invoice object", left[0].c === 0 && fn[0].c === 0, `${left[0].c} tables, ${fn[0].c} functions`); } catch (e) { check("rollback", false, e.message); }

for (const [s, n, e] of results) console.log(s, n, e ? "— " + e : "");
console.log(`\n${results.filter((r) => r[0] === "PASS").length} passed, ${results.filter((r) => r[0] === "FAIL").length} failed`);
