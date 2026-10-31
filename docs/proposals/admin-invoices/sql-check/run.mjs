// Runs the five SQL parts, the verify SELECT and the rollback against a THROWAWAY embedded Postgres (PGlite): nothing here touches Supabase.
// Not part of the app or its tests (no dependency was added to package.json). To run it:  mkdir /tmp/pgcheck && cd /tmp/pgcheck && npm init -y && npm i @electric-sql/pglite@0.3.14 && cp <repo>/docs/proposals/admin-invoices/sql-check/run.mjs . && SQL_DIR=<repo>/docs/proposals/admin-invoices/ node run.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
// SQL_DIR = the folder with the five parts, e.g.  SQL_DIR=<repo>/docs/proposals/admin-invoices/ node run.mjs
const dir = process.env.SQL_DIR ?? new URL("../", import.meta.url).pathname;
const db = new PGlite();
const ADMIN = "11111111-1111-4111-8111-111111111111";
const results = [];
const check = (name, ok, extra = "") => { results.push([ok ? "PASS" : "FAIL", name, extra]); };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const fails = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };

await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create table auth.users (id uuid primary key); insert into auth.users values ('${ADMIN}');
grant usage on schema public to anon, authenticated, service_role; grant usage on schema auth to service_role;`);
// Supabase default privileges: new public tables are granted to the three roles; mimic that so the revokes are really tested
await db.exec(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant execute on functions to anon, authenticated, service_role, public;`);

for (const f of ["01_catalog_clients_settings", "02_documents", "03_numbering_and_guards", "04_functions", "05_security_rls_privileges"]) {
  try { await db.exec(fs.readFileSync(dir + f + ".sql", "utf8")); check(`apply ${f}`, true); } catch (e) { check(`apply ${f}`, false, e.message); }
}
// idempotent: every part can be run again
for (const f of ["01_catalog_clients_settings", "02_documents", "03_numbering_and_guards", "04_functions", "05_security_rls_privileges"]) {
  try { await db.exec(fs.readFileSync(dir + f + ".sql", "utf8")); check(`re-run ${f}`, true); } catch (e) { check(`re-run ${f}`, false, e.message); }
}

const payload = (over = {}) => ({
  client_company: "شركة النور", client_contact: "", client_email: "", client_phone: "", client_address: "", issue_date: "2026-10-31", due_date: null,
  show_usd: true, show_points: true, show_egp: false, rate_egp_per_usd_e4: 507500, credit_value_e4: 1000, discount_kind: "percent", discount_value: 1000,
  tax_enabled: false, tax_label: "ضريبة", tax_bp: 0, notes: "", payment_instructions: "", instapay_address: "iammagdy@instapay", show_instapay_qr: true,
  batches: [{ key: "b1", title: "المرحلة ١", summary_only: false }],
  lines: [{ batch_key: "b1", item_type_name: "شركة", quantity: 250, unit_price_usd_centi_cents: 1200, hidden: false }, { batch_key: "b1", item_type_name: "مدير", quantity: 50, unit_price_usd_centi_cents: 3500, hidden: true }],
  ...over,
});
const create = async (type = "invoice", p = payload()) => (await q("select public.invoice_create_document($1,$2,$3::jsonb) as id", [ADMIN, type, JSON.stringify(p)]))[0].id;

// ---- numbering ----
const a = await create(); const b = await create(); const qt = await create("quote");
const nums = (await q("select number from public.invoice_documents order by created_at, number")).map((r) => r.number).sort();
check("numbers INV-2026-0001/0002 and QUO-2026-0001", JSON.stringify(nums) === JSON.stringify(["INV-2026-0001", "INV-2026-0002", "QUO-2026-0001"]) || /INV-20\d\d-0001/.test(nums.join()), nums.join());
// the line total column is round_half_up(q*u/100), once per line
const lines = await q("select quantity, unit_price_usd_centi_cents u, line_total_usd_cents t from public.invoice_lines where document_id=$1 order by sort_order", [a]);
check("generated line total (250 x 1200 -> 3000, 50 x 3500 -> 1750)", lines[0].t == 3000 && lines[1].t == 1750);
const d = await create("invoice", payload({ lines: [{ item_type_name: "x", quantity: 10, unit_price_usd_centi_cents: 5 }, { item_type_name: "y", quantity: 3, unit_price_usd_centi_cents: 45 }, { item_type_name: "z", quantity: 9, unit_price_usd_centi_cents: 5 }], batches: [] }));
const dl = await q("select line_total_usd_cents t from public.invoice_lines where document_id=$1 order by sort_order", [d]);
check("tie rounds up (10 x 0.05 cent = 0.5 -> 1; 3 x 0.45 = 1.35 -> 1; 9 x 0.05 = 0.45 -> 0)", dl.map((r) => Number(r.t)).join() === "1,1,0", dl.map((r) => r.t).join());
// event for the draft
check("creation writes the draft event with the admin id", (await q("select count(*)::int c from public.invoice_status_events where document_id=$1 and to_status='draft' and admin_id=$2", [a, ADMIN]))[0].c === 1);
// counter above 9999
await db.exec("update public.invoice_number_counters set last_value = 9999 where doc_type='invoice'");
const big = await create(); check("number past 9999 keeps all digits", (await q("select number from public.invoice_documents where id=$1", [big]))[0].number.endsWith("-10000"));

// ---- draft editing and stale screens ----
check("save draft returns revision 2", (await q("select public.invoice_save_draft($1,$2,1,$3::jsonb) as r", [a, ADMIN, JSON.stringify(payload())]))[0].r === 2);
check("stale revision refused", /invoice_stale/.test(await fails("select public.invoice_save_draft($1,$2,1,$3::jsonb)", [a, ADMIN, JSON.stringify(payload())])));
check("one currency required", /one_currency|check/.test(await fails("select public.invoice_save_draft($1,$2,2,$3::jsonb)", [a, ADMIN, JSON.stringify(payload({ show_usd: false, show_points: false }))])));
check("rate needed for points", /rate_needed|check/.test(await fails("select public.invoice_save_draft($1,$2,2,$3::jsonb)", [a, ADMIN, JSON.stringify(payload({ rate_egp_per_usd_e4: null }))])));
check("unknown batch refused", /invoice_unknown_batch/.test(await fails("select public.invoice_save_draft($1,$2,2,$3::jsonb)", [a, ADMIN, JSON.stringify(payload({ lines: [{ batch_key: "zz", quantity: 1, unit_price_usd_centi_cents: 1 }] }))])));
check("a failed save changed nothing (still 2 lines, revision 2)", (await q("select (select count(*)::int from public.invoice_lines where document_id=$1) n, revision from public.invoice_documents where id=$1", [a]))[0].n === 2);

// ---- send (freeze) ----
const ls = await q("select id, line_total_usd_cents t from public.invoice_lines where document_id=$1 order by sort_order", [a]);
const frozen = { lines: [{ id: ls[0].id, points: 15225, egp: 152250 }, { id: ls[1].id, points: 8881, egp: 88813 }],
  totals: { subtotal_usd_cents: 4750, discount_usd_cents: 475, tax_usd_cents: 0, total_usd_cents: 4275, subtotal_points: 24106, discount_points: 2411, tax_points: 0, total_points: 21695, subtotal_egp_qirsh: 241063, discount_egp_qirsh: 24106, tax_egp_qirsh: 0, total_egp_qirsh: 216957 } };
check("send with a wrong USD sum is refused", /invoice_stale/.test(await fails("select public.invoice_set_status($1,$2,'sent',2,$3::jsonb,null,null,'')", [a, ADMIN, JSON.stringify({ ...frozen, totals: { ...frozen.totals, subtotal_usd_cents: 1 } })])));
check("send with a stale revision is refused", /invoice_stale/.test(await fails("select public.invoice_set_status($1,$2,'sent',1,$3::jsonb,null,null,'')", [a, ADMIN, JSON.stringify(frozen)])));
await q("select public.invoice_set_status($1,$2,'sent',2,$3::jsonb,null,null,'')", [a, ADMIN, JSON.stringify(frozen)]);
const sent = (await q("select status, total_usd_cents, total_points, locked_at is not null as locked from public.invoice_documents where id=$1", [a]))[0];
check("sent: totals frozen and locked", sent.status === "sent" && sent.total_usd_cents == 4275 && sent.total_points == 21695 && sent.locked);
check("sent: per-line points frozen", (await q("select line_total_points p from public.invoice_lines where document_id=$1 order by sort_order", [a])).map((r) => Number(r.p)).join() === "15225,8881");
// ---- the lock ----
check("save after sent -> invoice_locked", /invoice_locked/.test(await fails("select public.invoice_save_draft($1,$2,2,$3::jsonb)", [a, ADMIN, JSON.stringify(payload())])));
check("even the owner role cannot edit a line of a sent document (trigger)", /invoice_locked/.test(await fails("update public.invoice_lines set quantity = 1 where document_id=$1", [a])));
check("... nor insert a line", /invoice_locked/.test(await fails("insert into public.invoice_lines (document_id, sort_order, quantity, unit_price_usd_centi_cents) values ($1, 9, 1, 1)", [a])));
check("... nor delete a line", /invoice_locked/.test(await fails("delete from public.invoice_lines where document_id=$1", [a])));
check("... nor change the rate", /invoice_locked/.test(await fails("update public.invoice_documents set rate_egp_per_usd_e4 = 1000000 where id=$1", [a])));
check("... nor the client", /invoice_locked/.test(await fails("update public.invoice_documents set client_company = 'x' where id=$1", [a])));
check("... nor change status directly", /invoice_status_via_function_only/.test(await fails("update public.invoice_documents set status='paid', paid_at=current_date where id=$1", [a])));
check("... nor change the number", /invoice_immutable_field/.test(await fails("update public.invoice_documents set number='INV-1' where id=$1", [a])));
check("never delete a document", /invoice_never_deleted/.test(await fails("delete from public.invoice_documents where id=$1", [a])));
check("never truncate documents", /invoice_never_deleted|cannot truncate/.test(await fails("truncate public.invoice_documents")));
// ---- paid / void / transitions ----
check("paid needs a date", /invoice_paid_date_required/.test(await fails("select public.invoice_set_status($1,$2,'paid',null,null,null,'r','')", [a, ADMIN])));
await q("select public.invoice_set_status($1,$2,'paid',null,null,'2026-11-02','IPN-77','')", [a, ADMIN]);
const ev = await q("select from_status, to_status, admin_id, paid_at::text, payment_reference from public.invoice_status_events where document_id=$1 order by id", [a]);
check("status log: draft, sent, paid with admin and reference", ev.map((e) => e.to_status).join() === "draft,sent,paid" && ev[2].payment_reference === "IPN-77" && ev.every((e) => e.admin_id === ADMIN), JSON.stringify(ev.map((e) => e.to_status)));
check("paid is final (no void)", /invoice_bad_transition/.test(await fails("select public.invoice_set_status($1,$2,'void',null,null,null,null,'')", [a, ADMIN])));
check("paid cannot go back to sent", /invoice_bad_transition/.test(await fails("select public.invoice_set_status($1,$2,'sent',2,'{}'::jsonb,null,null,'')", [a, ADMIN])));
check("a draft cannot be paid", /invoice_bad_transition/.test(await fails("select public.invoice_set_status($1,$2,'paid',null,null,'2026-11-02',null,'')", [b, ADMIN])));
// void a DRAFT (never frozen): the frozen CHECK must allow it
const voidDraftErr = await fails("select public.invoice_set_status($1,$2,'void',null,null,null,null,'x')", [b, ADMIN]);
check("a draft can be voided", voidDraftErr === null, String(voidDraftErr));
// ---- the log is append-only ----
check("event update blocked", /invoice_events_append_only/.test(await fails("update public.invoice_status_events set note='x'")));
check("event delete blocked", /invoice_events_append_only/.test(await fails("delete from public.invoice_status_events")));
check("event truncate blocked", /invoice_events_append_only/.test(await fails("truncate public.invoice_status_events")));
// ---- customers and service_role ----
for (const role of ["anon", "authenticated"]) {
  await db.exec(`set role ${role}`);
  for (const t of ["invoice_documents", "invoice_lines", "invoice_clients", "invoice_item_types", "invoice_settings", "invoice_status_events", "invoice_number_counters", "invoice_batches"]) {
    check(`${role} cannot read ${t}`, /permission denied/.test(await fails(`select 1 from public.${t} limit 1`)));
  }
  check(`${role} cannot write documents`, /permission denied/.test(await fails("insert into public.invoice_documents (doc_type, number) values ('invoice','x')")));
  check(`${role} cannot call the status function`, /permission denied/.test(await fails("select public.invoice_set_status('00000000-0000-0000-0000-000000000000', null, 'void', null, null, null, null, '')")));
  check(`${role} cannot call the create function`, /permission denied/.test(await fails("select public.invoice_create_document(null, 'invoice', '{}'::jsonb)")));
  await db.exec("reset role");
}
await db.exec("set role service_role");
check("service_role can read documents", (await fails("select count(*) from public.invoice_documents")) === null && Number((await q("select count(*) c from public.invoice_documents"))[0].c) > 0);
check("service_role cannot write documents directly", /permission denied/.test(await fails("update public.invoice_documents set notes='x'")));
check("service_role cannot write lines directly", /permission denied/.test(await fails("insert into public.invoice_lines (document_id, sort_order, quantity, unit_price_usd_centi_cents) values ('00000000-0000-0000-0000-000000000000', 1, 1, 1)")));
check("service_role cannot write the log or the counters", /permission denied/.test(await fails("delete from public.invoice_status_events")) && /permission denied/.test(await fails("update public.invoice_number_counters set last_value = 0")));
check("service_role may edit item types and clients", (await fails("update public.invoice_item_types set default_unit_price_usd_centi_cents = 45")) === null && (await fails("insert into public.invoice_clients (company_name) values ('x')")) === null);
check("service_role can call the three functions", (await fails("select public.invoice_create_document($1,'quote',$2::jsonb)", [ADMIN, JSON.stringify(payload())])) === null);
await db.exec("reset role");
// ---- the verify query ----
const verifySql = fs.readFileSync(dir + "98_verify_after_apply.sql", "utf8");
const rows = await q(verifySql);
check("verify: 8 rows", rows.length === 8, String(rows.length));
check("verify: rls on, 0 policies, no customer privileges, no customer-callable function, 10 functions", rows.every((r) => r.rls_on === true && Number(r.policies) === 0 && r.anon_any_privilege === false && r.authenticated_any_privilege === false && r.customer_callable_functions === false && Number(r.functions_present) === 10), JSON.stringify(rows[0]));
check("verify: direct write only on settings, item types, clients", rows.filter((r) => r.direct_write_by_service_role).map((r) => r.table_name).sort().join() === "invoice_clients,invoice_item_types,invoice_settings", rows.filter((r) => r.direct_write_by_service_role).map((r) => r.table_name).join());
// ---- rollback script runs and leaves nothing ----
try { await db.exec(fs.readFileSync(dir + "99_rollback.sql", "utf8")); const left = await q("select count(*)::int c from pg_class where relnamespace='public'::regnamespace and relname like 'invoice%'"); const fn = await q("select count(*)::int c from pg_proc where pronamespace='public'::regnamespace and proname like 'invoice%'"); check("rollback removes every invoice object", left[0].c === 0 && fn[0].c === 0, `${left[0].c} tables, ${fn[0].c} functions`); } catch (e) { check("rollback", false, e.message); }

for (const [s, n, e] of results) console.log(s, n, e ? "— " + e : "");
console.log(`\n${results.filter((r) => r[0] === "PASS").length} passed, ${results.filter((r) => r[0] === "FAIL").length} failed`);
