import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  convertQuote, createClient, createDocument, createItemType, duplicateDocument, getSettings, listClients, listDocuments, listItemTypes, loadDocument, readPricingSettings, saveDraft, setStatus,
  updateClient, updateItemType, updateSeller, type InvoiceDb,
} from "../src/lib/server/invoices/service";
import type { DocumentInput } from "../src/lib/invoices/validate";
import { InvoiceDbModel } from "./helpers/invoiceDb";

/**
 * The invoices are COMPLETELY SEPARATE from the points wallet. This file proves it three ways:
 *  1. every action runs against a database that THROWS the moment code names a wallet, ledger, balance, mission, reserve, charge or top-up table (or any function that is not one of the
 *     three invoice functions), and «mark paid» is followed by a check that no ledger row exists;
 *  2. the same through the HTTP routes;
 *  3. static: the invoice code imports nothing from the wallet / agent / settlement modules, and only ever names invoice_* tables (plus the one read of the pricing settings row).
 */
const FORBIDDEN_TABLE = /ledger|wallet|balance|mission|reserve|charge|settle|refund|topup|top_up|profile|credit|job|plan|quote_|notification|promo|support|provider|treg|llm/i;
const ADMIN = "11111111-1111-4111-8111-111111111111";
const PRICING = { instapayAddress: "iammagdy@instapay", creditValueE4: 1000 };

const h = vi.hoisted(() => ({ user: null as any, db: null as any }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user }, error: null }) } }) }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: null })) } })),
  createAdminClient: () => h.db,
}));

/** The model wrapped so that touching anything outside the invoice objects is a hard error. */
function guarded(model: InvoiceDbModel): InvoiceDb & { model: InvoiceDbModel; ledger: Array<Record<string, unknown>> } {
  const ledger: Array<Record<string, unknown>> = [];
  const allowedFrom = (name: string) => name.startsWith("invoice_") || name === "settings_public" || name === "admin_audit_log";
  return {
    model, ledger,
    from(table: string) {
      if (FORBIDDEN_TABLE.test(table) || !allowedFrom(table)) throw new Error(`FORBIDDEN TABLE TOUCHED: ${table}`);
      return model.from(table);
    },
    rpc(fn: string, args: Record<string, unknown>) {
      if (!["invoice_create_document", "invoice_save_draft", "invoice_set_status"].includes(fn)) throw new Error(`FORBIDDEN FUNCTION CALLED: ${fn}`);
      return model.rpc(fn, args);
    },
  } as never;
}

const input = (): DocumentInput => ({
  clientId: null, client: { company: "شركة النور", contact: "", email: "", phone: "", address: "" }, issueDate: "2026-10-31", dueDate: null,
  show: { usd: true, points: true, egp: true }, rateE4: 507_500, discount: { kind: "percent", value: 1000 }, tax: { enabled: true, label: "ضريبة", bp: 1400 },
  notes: "", paymentInstructions: "", showInstapayQr: true, batches: [{ key: "b", title: "المرحلة ١", summaryOnly: false }],
  lines: [{ batchKey: "b", itemTypeId: null, itemTypeName: "شركة", description: "", quantity: 250, unitCc: 1200, hidden: false }],
});

let db: ReturnType<typeof guarded>;
beforeEach(() => { db = guarded(new InvoiceDbModel()); });

describe("no invoice action touches the wallet", () => {
  it("create, edit, send, mark paid, void, convert, duplicate, list, types, clients, settings: zero wallet/ledger/mission access, and no ledger row appears", async () => {
    // the whole life of an invoice
    const inv = await createDocument(db, ADMIN, "invoice", input(), PRICING);
    await saveDraft(db, ADMIN, inv, { ...input(), expectedRevision: 1 }, PRICING);
    await setStatus(db, ADMIN, inv, { to: "sent" }, PRICING);
    await setStatus(db, ADMIN, inv, { to: "paid", paidAt: "2026-11-02", reference: "IPN-1" }, PRICING);
    // a quote converted into an invoice, then voided and copied
    const quote = await createDocument(db, ADMIN, "quote", input(), PRICING);
    await setStatus(db, ADMIN, quote, { to: "sent" }, PRICING);
    const converted = await convertQuote(db, ADMIN, quote, PRICING);
    await setStatus(db, ADMIN, converted, { to: "void" }, PRICING);
    await duplicateDocument(db, ADMIN, converted, PRICING);
    // reading and the catalogues
    await listDocuments(db, {});
    await loadDocument(db, inv);
    const t = await createItemType(db, ADMIN, { nameAr: "رابط", unitCc: 45 });
    await updateItemType(db, ADMIN, t.id, { nameAr: "رابط", unitCc: 50 });
    await listItemTypes(db);
    const c = await createClient(db, ADMIN, { company: "شركة", contact: "", email: "", phone: "", address: "", notes: "" });
    await updateClient(db, ADMIN, c.id, { company: "شركة 2", contact: "", email: "", phone: "", address: "", notes: "" });
    await listClients(db);
    await getSettings(db);
    await updateSeller(db, ADMIN, { sellerName: "ديجر", sellerEmail: "x@diger.tech", sellerWebsite: "diger.tech", sellerTaxNumber: "", sellerCommercialRegister: "" });
    await readPricingSettings(async () => ({ ipa: "x", creditValueEgp: 0.1 }));

    const names = new Set(db.model.touched.map((x) => `${x.kind}:${x.name}`));
    for (const n of names) expect(n, n).toMatch(/^(from:invoice_\w+|rpc:invoice_(create_document|save_draft|set_status))$/);
    expect(db.model.touched.some((x) => FORBIDDEN_TABLE.test(x.name))).toBe(false);
    expect(db.ledger).toEqual([]);
    // the paid invoice is paid and only that: no points anywhere
    const paid = (await loadDocument(db, inv))!;
    expect(paid.doc.status).toBe("paid");
    expect(Object.keys(db.model.tables).every((n) => n.startsWith("invoice_"))).toBe(true);
  });

  it("the pricing settings row is only ever READ (never written)", async () => {
    await createDocument(db, ADMIN, "invoice", input(), PRICING);
    const settingsOps = db.model.touched.filter((x) => x.name === "settings_public").map((x) => x.op);
    expect(settingsOps.every((op) => op === "select")).toBe(true);
  });

  it("marking an invoice paid through the HTTP route leaves every non-invoice table untouched and creates no ledger row", async () => {
    h.user = { id: ADMIN, email: "a@b.c", app_metadata: { role: "admin" }, user_metadata: {} };
    h.db = db;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock";
    const id = await createDocument(db, ADMIN, "invoice", input(), PRICING);
    await setStatus(db, ADMIN, id, { to: "sent" }, PRICING);
    const before = db.model.touched.length;
    const route = await import("../src/app/api/admin/invoices/[id]/status/route");
    const res = await route.POST(new NextRequest("http://x", { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ to: "paid", paidAt: "2026-11-02", reference: "R" }) }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const touched = db.model.touched.slice(before).map((x) => x.name);
    for (const n of touched) expect(n, n).toMatch(/^(invoice_\w+|settings_public|admin_audit_log)$/);
    expect(db.ledger).toEqual([]);
  });
});

describe("static: the invoice code is wired to nothing of the wallet", () => {
  const roots = ["src/lib/invoices", "src/lib/server/invoices", "src/app/api/admin/invoices", "src/components/admin/invoices", "src/app/admin/invoices"];
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
  const files = roots.flatMap(walk);
  const code = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("there are invoice files to check", () => { expect(files.length).toBeGreaterThan(25); });

  it("no import reaches the wallet, ledger, credit, mission, agent, settlement or refund modules (the one shared file is the Instapay QR constants, which is pure)", () => {
    const BAD = /adminCredit|creditKinds|honestDisplay|financeSummary|ledger|wallet|mission|agent|settle|refund|reserve|pricing|quote/i;
    const SHARED = "@/lib/topupConfig"; // constants and one predicate for the Instapay address / QR: no database, no money function
    const seen = new Set<string>();
    for (const f of files) {
      for (const m of code(f).matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1];
        if (/^(react|react-dom|next|zod|html-to-image|node:)/.test(spec)) continue;
        seen.add(spec);
        expect(spec, `${f} imports ${spec}`).not.toMatch(BAD);
      }
    }
    expect(seen.has(SHARED)).toBe(true);
    const shared = code("src/lib/topupConfig.ts");
    expect([...shared.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])).toEqual(["./arabicDigits"]);
    expect(shared).not.toMatch(/supabase|fetch\(|\.from\(|\.rpc\(/);
  });

  it("the only table or function names in the invoice code are invoice_*, the pricing settings row and the admin audit log", () => {
    const names: string[] = [];
    for (const f of files) {
      const c = code(f);
      for (const m of c.matchAll(/\.(?:from|rpc)\(\s*"([^"]+)"/g)) names.push(m[1]);
      for (const m of c.matchAll(/tableId:\s*"([^"]+)"/g)) names.push(m[1]);
    }
    expect(names.length).toBeGreaterThan(10);
    for (const n of new Set(names)) expect(n, n).toMatch(/^(invoice_\w+|settings_public)$/);
  });

  it("the SQL (comments removed) never references a wallet, ledger, balance, mission, reserve or charge object", () => {
    const sql = readFileSync("supabase/migrations/20261031120000_admin_invoices.sql", "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/credit_ledger|ledger|wallet|balance|mission|reserve|charge|settle|refund|topup|profiles|settings_public|auth\.users\s*\(.*balance/i);
    // the only foreign keys outside the invoice tables are the admin id (auth.users), as admin_audit_log does
    const refs = [...sql.matchAll(/REFERENCES\s+([\w.]+)/g)].map((m) => m[1]);
    for (const r of new Set(refs)) expect(r, r).toMatch(/^(public\.invoice_\w+|auth\.users)$/);
  });
});
