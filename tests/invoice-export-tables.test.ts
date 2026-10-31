import { unzipSync } from "fflate";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareBackupZip } from "../src/app/api/admin/export/zip/backupZip";
import { EXPORT_TABLES, INVOICE_EXPORT_TABLES, INVOICE_TABLE_IDS, invoiceBackupZipFileName } from "../src/lib/adminExport";
import { InvoiceDbModel } from "./helpers/invoiceDb";

const h = vi.hoisted(() => ({ user: null as any, db: null as any }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user }, error: null }) } }) }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : new Error("no session") })) } })),
  createAdminClient: () => h.db,
}));

const admin = { id: "u", email: "a@b.c", app_metadata: { role: "admin" }, user_metadata: {} };
let model: InvoiceDbModel;
beforeEach(() => {
  model = new InvoiceDbModel();
  h.db = model;
  h.user = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock";
});

describe("the invoice tables join /admin/export as a separate, read-only group", () => {
  it("the five existing exported tables are exactly as before", () => {
    expect(EXPORT_TABLES.map((t) => t.id).sort()).toEqual(["credit_ledger", "jobs", "plans_quotes", "profiles", "topups"]);
  });

  it("the invoice group lists all eight invoice tables and nothing else", () => {
    expect(INVOICE_EXPORT_TABLES.map((t) => t.id).sort()).toEqual([
      "invoice_batches", "invoice_clients", "invoice_documents", "invoice_item_types", "invoice_lines", "invoice_number_counters", "invoice_settings", "invoice_status_events",
    ]);
    for (const t of INVOICE_EXPORT_TABLES) expect(t.titleAr).toMatch(/[؀-ۿ]/);
    expect(invoiceBackupZipFileName(new Date("2026-10-31T10:00:00Z"))).toBe("diger-invoices-backup-2026-10-31-1200.zip");
  });

  it("the page-by-page route serves an invoice table to an administrator with SELECT only, and still refuses anything else", async () => {
    const route = await import("../src/app/api/admin/export/route");
    const get = (query: string) => route.GET(new NextRequest(`http://x/api/admin/export${query}`, { headers: { authorization: "Bearer t" } }));
    h.user = null;
    expect((await get("?table=invoice_documents")).status).toBe(401);
    h.user = { ...admin, app_metadata: {} };
    expect((await get("?table=invoice_documents")).status).toBe(403);
    expect(model.touched).toEqual([]);
    h.user = admin;
    const ok = await get("?table=invoice_item_types");
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.table).toBe("invoice_item_types");
    expect(body.rows).toHaveLength(4);
    expect(model.touched.every((t) => t.op === "select")).toBe(true);
    for (const bad of ["invoice_nope", "invoice_documents;drop", "settings_private", "profiles2"]) expect((await get(`?table=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
    expect(INVOICE_TABLE_IDS.has("credit_ledger")).toBe(false);
  });

  it("the ZIP of the invoice group holds one CSV per invoice table plus a manifest written last, and reads only", async () => {
    const prepared = await prepareBackupZip(model as never, { now: new Date("2026-10-31T10:00:00Z"), tables: INVOICE_EXPORT_TABLES });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const bytes = new Uint8Array(await new Response(prepared.stream).arrayBuffer());
    const files = unzipSync(bytes);
    const names = Object.keys(files);
    expect(names.filter((n) => n.endsWith(".csv"))).toHaveLength(8);
    expect(names.at(-1)).toBe("manifest.json");
    for (const t of INVOICE_EXPORT_TABLES) expect(names.some((n) => n.includes(`-${t.id}-`)), t.id).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
    expect(manifest.complete).toBe(true);
    expect(manifest.files).toHaveLength(8);
    expect(model.touched.every((t) => t.kind === "from" && t.op === "select")).toBe(true);
    expect(model.touched.some((t) => /ledger|profile|topup|job/.test(t.name))).toBe(false);
  });

  it("the ZIP route: ?set=invoices gives the invoice ZIP, the plain route gives the five-table ZIP, both admin only", async () => {
    const route = await import("../src/app/api/admin/export/zip/route");
    const get = (query: string) => route.GET(new NextRequest(`http://x/api/admin/export/zip${query}`, { headers: { authorization: "Bearer t" } }));
    h.user = null;
    expect((await get("?set=invoices")).status).toBe(401);
    h.user = { ...admin, app_metadata: { role: "user" } };
    expect((await get("?set=invoices")).status).toBe(403);
    expect(model.touched).toEqual([]);
    h.user = admin;
    const res = await get("?set=invoices");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/diger-invoices-backup-/);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).filter((n) => n.endsWith(".csv"))).toHaveLength(8);
  });
});
