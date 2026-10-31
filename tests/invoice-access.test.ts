import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceDbModel } from "./helpers/invoiceDb";

const h = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; app_metadata: Record<string, any>; user_metadata: Record<string, any> },
  model: null as any,
}));

vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user }, error: null }) } }) }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : new Error("no session") })) } })),
  createAdminClient: () => h.model,
}));

const ROOT = "src/app/api/admin/invoices";
const routeFiles = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? routeFiles(p) : n === "route.ts" ? [p] : []; });
const FILES = routeFiles(ROOT).sort();
const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const UUID = "33333333-3333-4333-8333-333333333333";
const person = (role?: string) => ({ id: "99999999-9999-4999-8999-999999999999", email: "a@b.c", app_metadata: role ? { role } : {}, user_metadata: {} });

async function handlers(): Promise<Array<{ file: string; verb: (typeof VERBS)[number]; fn: (req: NextRequest, ctx: any) => Promise<Response> }>> {
  const out: Array<{ file: string; verb: (typeof VERBS)[number]; fn: any }> = [];
  for (const file of FILES) {
    const mod = await import(/* @vite-ignore */ `../${file}`);
    for (const verb of VERBS) if (typeof mod[verb] === "function") out.push({ file, verb, fn: mod[verb] });
  }
  return out;
}
const request = (verb: string, headers: Record<string, string> = {}) =>
  new NextRequest("http://x/api/admin/invoices", { method: verb, headers: { "content-type": "application/json", ...headers }, ...(verb === "GET" ? {} : { body: JSON.stringify({}) }) });
const ctx = { params: Promise.resolve({ id: UUID }) };

beforeEach(() => {
  h.user = null;
  h.model = new InvoiceDbModel();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock";
});

describe("every invoice route is admin-only, on the server", () => {
  it("the routes are exactly the ones the screens use (nothing public was added)", () => {
    expect(FILES).toEqual([
      "src/app/api/admin/invoices/[id]/convert/route.ts", "src/app/api/admin/invoices/[id]/duplicate/route.ts", "src/app/api/admin/invoices/[id]/route.ts",
      "src/app/api/admin/invoices/[id]/status/route.ts", "src/app/api/admin/invoices/agent/route.ts", "src/app/api/admin/invoices/assist/route.ts", "src/app/api/admin/invoices/clients/[id]/route.ts", "src/app/api/admin/invoices/clients/route.ts",
      "src/app/api/admin/invoices/route.ts", "src/app/api/admin/invoices/settings/route.ts", "src/app/api/admin/invoices/types/[id]/route.ts", "src/app/api/admin/invoices/types/route.ts",
    ]);
  });

  it("every exported handler starts with authenticateAdmin and returns its refusal before doing anything else", () => {
    let count = 0;
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      const declared = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
      expect(declared.every((n) => (VERBS as readonly string[]).includes(n)), file).toBe(true);
      for (const name of declared) {
        const body = source.slice(source.indexOf(`function ${name}(`));
        expect(body, `${file} ${name}`).toMatch(/^function \w+\([^)]*\) \{\s*const auth = await authenticateAdmin\(req\);\s*if \(!auth\.ok\) return auth\.response;/);
        count += 1;
      }
    }
    expect(count).toBe(17); // 15 + the Claude helper (POST /assist) + the invoice agent (POST /agent)
  });

  it("no session: 401 for every handler, and the database is not touched at all", async () => {
    const all = await handlers();
    expect(all).toHaveLength(17);
    for (const { file, verb, fn } of all) {
      const res = await fn(request(verb, { authorization: "Bearer nobody" }), ctx);
      expect(res.status, `${verb} ${file}`).toBe(401);
      const text = await res.text();
      expect(text).not.toMatch(/invoice_|number|total/);
    }
    expect(h.model.touched).toEqual([]);
  });

  it("a signed-in customer (or any role that is not admin): 403 for every handler, nothing read or written", async () => {
    const all = await handlers();
    for (const role of [undefined, "user", "support", "viewer"]) {
      h.user = person(role);
      for (const { file, verb, fn } of all) {
        const res = await fn(request(verb, { authorization: "Bearer customer" }), ctx);
        expect(res.status, `${role} ${verb} ${file}`).toBe(403);
      }
    }
    expect(h.model.touched).toEqual([]);
    expect(h.model.tables.invoice_documents).toHaveLength(0);
    expect(h.model.tables.invoice_item_types).toHaveLength(4); // only the seed rows
  });
});

describe("an administrator, through the routes", () => {
  const json = async (res: Response) => ({ status: res.status, body: await res.json() });
  const call = async (mod: string, verb: string, body?: unknown, params?: Record<string, string>) => {
    const m = await import(/* @vite-ignore */ `../${ROOT}/${mod}`);
    const req = new NextRequest("http://x/api/admin/invoices", { method: verb, headers: { "content-type": "application/json", authorization: "Bearer admin" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return json(await m[verb](req, { params: Promise.resolve(params ?? {}) }));
  };
  const payload = (over: Record<string, unknown> = {}) => ({
    docType: "invoice", clientId: null, client: { company: "شركة النور", contact: "", email: "", phone: "", address: "" }, issueDate: "2026-10-31", dueDate: null,
    show: { usd: true, points: true, egp: false }, rateE4: 507500, discount: { kind: "percent", value: 1000 }, tax: { enabled: false, label: "ضريبة", bp: 0 },
    notes: "", paymentInstructions: "", showInstapayQr: true, batches: [], lines: [{ batchKey: null, itemTypeId: null, itemTypeName: "شركة", description: "", quantity: 250, unitCc: 1200, hidden: false }], ...over,
  });

  it("create, save, send, locked, pay: Arabic messages and no database detail in any answer", async () => {
    h.user = person("admin");
    const created = await call("route.ts", "POST", payload());
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const one = await call("[id]/route.ts", "GET", undefined, { id });
    expect(one.status).toBe(200);
    expect(one.body.doc).toMatchObject({ status: "draft", number: "INV-2026-0001", revision: 1 });
    expect(one.body.seller).toMatchObject({ name: "ديجر", website: "diger.tech" });

    expect((await call("[id]/route.ts", "PUT", { ...payload(), expectedRevision: 1 }, { id })).body).toEqual({ revision: 2 });
    expect((await call("[id]/status/route.ts", "POST", { to: "sent", expectedRevision: 2 }, { id })).status).toBe(200);

    const locked = await call("[id]/route.ts", "PUT", { ...payload(), expectedRevision: 4 }, { id });
    expect(locked.status).toBe(409);
    expect(locked.body.error).toMatch(/مقفلة/);
    expect(JSON.stringify(locked.body)).not.toMatch(/invoice_documents|rpc|SQL|permission/i);

    const noDate = await call("[id]/status/route.ts", "POST", { to: "paid" }, { id });
    expect(noDate.status).toBe(400);
    expect((await call("[id]/status/route.ts", "POST", { to: "paid", paidAt: "2026-11-05", reference: "R-1" }, { id })).status).toBe(200);
    expect((await call("[id]/route.ts", "GET", undefined, { id })).body.doc).toMatchObject({ status: "paid", paidAt: "2026-11-05" });
    // the action was audited in the admin audit log (not in the wallet)
    expect(h.model.touched.some((t: any) => t.name === "admin_audit_log")).toBe(true);
  });

  it("bad input is a 400 with one Arabic sentence; an unknown id is a 404; a malformed id never reaches the database", async () => {
    h.user = person("admin");
    const bad = await call("route.ts", "POST", payload({ show: { usd: false, points: false, egp: false } }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/عملة/);
    expect((await call("route.ts", "POST", { ...payload(), docType: "receipt" })).status).toBe(400);
    expect((await call("route.ts", "POST", payload({ rateE4: 12.5 }))).status).toBe(400); // a float rate is refused
    expect((await call("route.ts", "POST", payload({ lines: [{ batchKey: null, itemTypeId: null, itemTypeName: "", description: "", quantity: 1.5, unitCc: 1, hidden: false }] }))).status).toBe(400);
    expect((await call("[id]/route.ts", "GET", undefined, { id: UUID })).status).toBe(404);
    const before = h.model.touched.length;
    expect((await call("[id]/route.ts", "GET", undefined, { id: "not-a-uuid" })).status).toBe(404);
    expect(h.model.touched.length).toBe(before);
  });

  it("types, clients and settings work; free text loses emoji and hidden direction marks on the way in", async () => {
    h.user = person("admin");
    const t = await call("types/route.ts", "POST", { nameAr: "رابط حساب \u{1F600}", unitCc: 45 });
    expect(t.status).toBe(201);
    expect(t.body.type).toMatchObject({ nameAr: "رابط حساب", unitCc: 45 });
    expect((await call("types/[id]/route.ts", "PATCH", { nameAr: "رابط حساب", unitCc: 90 }, { id: t.body.type.id })).body.type.unitCc).toBe(90);
    expect((await call("types/route.ts", "GET")).body.types.length).toBe(5);
    const c = await call("clients/route.ts", "POST", { company: "شركة‮ النور", contact: "", email: "", phone: "", address: "", notes: "" });
    expect(c.body.client.company).toBe("شركة النور");
    expect((await call("clients/route.ts", "GET")).body.clients).toHaveLength(1);
    const s = await call("settings/route.ts", "GET");
    expect(s.body).toMatchObject({ instapayAddress: "iammagdy@instapay", creditValueE4: 1000, seller: { website: "diger.tech" } });
    expect(s.body.defaultPaymentInstructions).toContain("iammagdy@instapay");
    expect((await call("settings/route.ts", "PUT", { sellerName: "ديجر", sellerEmail: "x@diger.tech", sellerWebsite: "diger.tech", sellerTaxNumber: "", sellerCommercialRegister: "" })).status).toBe(200);
  });
});

describe("the SQL: RLS on, nothing for customers, writes only through the functions", () => {
  const sql = readFileSync("supabase/migrations/20261031120000_admin_invoices.sql", "utf8");
  const dir = "docs/proposals/admin-invoices";
  const parts = readdirSync(dir).filter((n) => /^0[1-5]_.*\.sql$/.test(n) && !n.includes("rollback")).sort();
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((m) => m[1]);

  it("the five parts are the migration (one file, same SQL, same order)", () => {
    expect(parts).toHaveLength(5);
    let at = 0;
    for (const p of parts) {
      const text = readFileSync(join(dir, p), "utf8");
      const idx = sql.indexOf(text, at);
      expect(idx, p).toBeGreaterThanOrEqual(at);
      at = idx + text.length;
    }
  });

  it("part 06 (statement mode) is its own migration, identical to the proposal file, and only changes constraints and three functions", () => {
    const delta = readFileSync("supabase/migrations/20261031150000_admin_invoices_statement.sql", "utf8");
    expect(delta).toContain(readFileSync(join(dir, "06_statement_mode.sql"), "utf8"));
    const code = delta.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/CREATE TABLE|DROP TABLE|DROP FUNCTION|TRUNCATE|CREATE POLICY|credit_ledger|wallet|balance|mission|reserve|charge/i); // (INSERT / UPDATE / DELETE appear only inside the replaced function bodies, which write only invoice_* tables)
    expect([...code.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]).sort()).toEqual(["invoice__replace_children", "invoice_assign_number", "invoice_set_status"]);
    expect(code).not.toMatch(/GRANT[^;]*TO[^;]*\b(anon|authenticated|PUBLIC)\b/i);
    expect(code).toContain("REVOKE ALL ON FUNCTION public.invoice_set_status(uuid, uuid, text, integer, jsonb, date, text, text) FROM PUBLIC, anon, authenticated, service_role;");
    expect(code).toContain("doc_type <> 'statement'");
    expect(code).toContain("v_doc.doc_type <> 'invoice'");
    expect(code).not.toMatch(/\b(real|double precision|numeric|decimal|money|float\d?)\b/i);
  });

  it("eight tables, each with RLS enabled, all privileges revoked from PUBLIC / anon / authenticated, and NO policy at all", () => {
    expect([...tables].sort()).toEqual(["invoice_batches", "invoice_clients", "invoice_documents", "invoice_item_types", "invoice_lines", "invoice_number_counters", "invoice_settings", "invoice_status_events"]);
    for (const t of tables) expect(sql, t).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
    const revoke = /REVOKE ALL ON TABLE ([\s\S]*?) FROM PUBLIC, anon, authenticated, service_role;/.exec(sql)?.[1] ?? "";
    for (const t of tables) expect(revoke, t).toContain(`public.${t}`);
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"); // statements only: the comments explain the rules in words
    expect(statements).not.toMatch(/CREATE POLICY/i);
    expect(statements).not.toMatch(/GRANT[^;]*TO[^;]*\b(anon|authenticated|PUBLIC)\b/i);
  });

  it("service_role can read every table but write directly only the three plain tables; documents, lines, batches, counters and the log are written by functions", () => {
    const grants = [...sql.matchAll(/GRANT ([A-Z, ]+) ON TABLE ([\s\S]*?) TO service_role;/g)].map((m) => ({ priv: m[1], on: m[2] }));
    const writable = grants.filter((g) => /INSERT|UPDATE|DELETE/.test(g.priv)).flatMap((g) => [...g.on.matchAll(/public\.(\w+)/g)].map((m) => m[1])).sort();
    expect(writable).toEqual(["invoice_clients", "invoice_item_types", "invoice_settings"]);
    expect(grants.some((g) => /DELETE|TRUNCATE/.test(g.priv))).toBe(false);
  });

  it("every function is revoked from customers and the three runtime functions are SECURITY DEFINER with a fixed search_path", () => {
    const funcs = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    expect(funcs.length).toBe(10);
    // every one of the 10 is revoked from PUBLIC, anon, authenticated AND service_role (the project's default privileges grant EXECUTE to all of them)
    for (const f of funcs) expect(sql, f).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\) FROM PUBLIC, anon, authenticated, service_role;`));
    const runtime = ["invoice_create_document", "invoice_save_draft", "invoice_set_status"];
    // only the three runtime functions are granted back, and only to service_role
    const grants = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION public\.(\w+)\([^)]*\) TO (\w+);/g)].map((m) => `${m[1]}->${m[2]}`).sort();
    expect(grants).toEqual(runtime.map((f) => `${f}->service_role`).sort());
    for (const f of runtime) {
      const body = sql.slice(sql.indexOf(`FUNCTION public.${f}(`));
      expect(body.slice(0, 1200), f).toMatch(/SECURITY DEFINER SET search_path TO 'public', 'pg_temp'/);
    }
    // the seven others are SECURITY INVOKER (the default) and still have a fixed search_path
    for (const f of funcs.filter((n) => !runtime.includes(n))) {
      const head = sql.slice(sql.indexOf(`FUNCTION public.${f}(`)).split("AS $$")[0];
      expect(head, f).not.toMatch(/SECURITY DEFINER/);
      expect(head, f).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    }
  });

  it("the guards exist: numbering, lock, transitions, never delete, append-only log", () => {
    for (const needle of [
      "invoice_documents_number BEFORE INSERT", "invoice_documents_guard_t BEFORE UPDATE", "invoice_documents_no_delete BEFORE DELETE", "invoice_documents_no_truncate BEFORE TRUNCATE",
      "invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE", "invoice_batches_guard BEFORE INSERT OR UPDATE OR DELETE", "invoice_events_no_change BEFORE UPDATE OR DELETE", "invoice_events_no_truncate BEFORE TRUNCATE",
      "(('draft', 'sent'), ('draft', 'void'), ('sent', 'paid'), ('sent', 'void'))", "RAISE EXCEPTION 'invoice_locked'", "RAISE EXCEPTION 'invoice_events_append_only'",
      "(((quantity * unit_price_usd_centi_cents) + 50) / 100)",
    ]) expect(sql.replace(/\s+/g, " "), needle).toContain(needle);
  });

  it("no money column is a float, numeric or money type", () => {
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\b(real|double precision|numeric|decimal|money|float\d?)\b/i);
  });

  it("the verify SELECT lists every table AND every function and checks EXECUTE for anon, authenticated and PUBLIC on each function", () => {
    const verify = readFileSync(join(dir, "98_verify_after_apply.sql"), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const role of ["anon", "authenticated", "public", "service_role"]) expect(verify, role).toContain(`has_function_privilege('${role}', f.oid, 'EXECUTE')`);
    for (const role of ["anon", "authenticated", "public"]) expect(verify, role).toContain(`has_table_privilege('${role}', c.oid,`);
    expect(verify).toContain("f.prosecdef");
    expect(verify).toContain("f.proconfig");
    expect(verify).toMatch(/UNION ALL/); // ONE result set
    expect(verify).toContain("'check'"); // the five part-06 checks are in the same result set
    expect(verify).toContain("AS ok");
  });

  it("the verify file is ONE read-only SELECT", () => {
    const verify = readFileSync(join(dir, "98_verify_after_apply.sql"), "utf8");
    const code = verify.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code.startsWith("SELECT")).toBe(true);
    expect(code.match(/;/g)).toHaveLength(1);
    expect(code.replace(/'[^']*'/g, "''")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|GRANT|REVOKE|TRUNCATE)\b/i); // words inside string literals are privilege names, not statements
  });
});
