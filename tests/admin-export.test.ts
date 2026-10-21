import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  admin: true,
  calls: [] as Array<{ table: string; op: string; args?: unknown[] }>,
  rows: [] as any[],
  error: null as null | { message: string },
}));

vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => (h.admin
    ? { ok: true, ctx: { adminId: "a1" } }
    : { ok: false, response: new Response(JSON.stringify({ error: "ممنوع" }), { status: 403 }) })),
}));
vi.mock("../src/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: any = {
        select: (...args: unknown[]) => { h.calls.push({ table, op: "select", args }); return q; },
        order: (...args: unknown[]) => { h.calls.push({ table, op: "order", args }); return q; },
        range: async (...args: unknown[]) => { h.calls.push({ table, op: "range", args }); return { data: h.error ? null : h.rows, error: h.error, count: h.rows.length }; },
        insert: () => { h.calls.push({ table, op: "insert" }); throw new Error("the export must never write"); },
        update: () => { h.calls.push({ table, op: "update" }); throw new Error("the export must never write"); },
        upsert: () => { h.calls.push({ table, op: "upsert" }); throw new Error("the export must never write"); },
        delete: () => { h.calls.push({ table, op: "delete" }); throw new Error("the export must never write"); },
      };
      return q;
    },
  }),
}));

import { GET } from "../src/app/api/admin/export/route";
import { csvCell, EXPORT_TABLES, exportFileName, rowsToCsv, stripSecrets } from "../src/lib/adminExport";

const call = (query: string) => GET(new NextRequest(`http://x/api/admin/export${query}`));

describe("the backup export is admin only and only reads", () => {
  it("a non-admin gets the refusal and nothing is read", async () => {
    h.admin = false; h.calls = [];
    const res = await call("?table=credit_ledger");
    expect(res.status).toBe(403);
    expect(h.calls).toEqual([]);
    h.admin = true;
  });

  it("only the five tables are exported; anything else is a 400 and reads nothing", async () => {
    h.calls = [];
    for (const table of ["auth.users", "provider_api_keys", "settings_private", "", "profiles; drop table x"]) {
      expect((await call(`?table=${encodeURIComponent(table)}`)).status).toBe(400);
    }
    expect(h.calls).toEqual([]);
    expect(EXPORT_TABLES.map((t) => t.id).sort()).toEqual(["credit_ledger", "jobs", "plans_quotes", "profiles", "topups"]);
  });

  it("a page is a SELECT in a stable order, at most 1000 rows, and the first page also counts the table", async () => {
    h.calls = []; h.error = null;
    h.rows = [{ id: "l1", user_id: "u1", delta: -5, type: "charge", created_at: "2026-10-21T00:00:00Z" }];
    const first = await (await call("?table=credit_ledger")).json();
    expect(first).toMatchObject({ table: "credit_ledger", offset: 0, done: true, count: 1, columns: ["id", "user_id", "delta", "type", "created_at"] });
    expect(h.calls.map((c) => c.op)).toEqual(["select", "order", "order", "range"]);
    expect(h.calls[0].args).toEqual(["*", { count: "exact" }]);
    expect(h.calls[1].args).toEqual(["created_at", { ascending: true }]);
    expect(h.calls[2].args).toEqual(["id", { ascending: true }]);
    expect(h.calls[3].args).toEqual([0, 999]);
    h.calls = [];
    const later = await (await call("?table=credit_ledger&offset=2000")).json();
    expect(later.count).toBeUndefined();
    expect(h.calls[0].args).toEqual(["*", undefined]);
    expect(h.calls[3].args).toEqual([2000, 2999]);
    expect(h.calls.some((c) => ["insert", "update", "upsert", "delete"].includes(c.op))).toBe(false);
  });

  it("a full page says there may be more; a short page says it is the last", async () => {
    h.error = null;
    h.rows = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, created_at: "2026-10-21T00:00:00Z" }));
    expect((await (await call("?table=jobs")).json()).done).toBe(false);
    h.rows = h.rows.slice(0, 999);
    expect((await (await call("?table=jobs&offset=1000")).json()).done).toBe(true);
  });

  it("a failed read is a plain Arabic error, never a raw database message", async () => {
    h.error = { message: 'relation "x" does not exist' };
    const res = await call("?table=topups");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("relation");
    h.error = null;
  });

  it("columns that look like secrets or tokens are left out and named", async () => {
    h.rows = [{ id: "u1", email: "a@b.c", access_token: "t", api_key: "k", sender_name: "x" }];
    const body = await (await call("?table=profiles")).json();
    expect(body.columns).toEqual(["id", "email", "sender_name"]);
    expect(body.omitted.sort()).toEqual(["access_token", "api_key"]);
    expect(JSON.stringify(body.rows)).not.toContain("\"t\"");
  });

  it("the route and the page contain no write call", () => {
    for (const file of ["src/app/api/admin/export/route.ts", "src/lib/adminExport.ts", "src/app/admin/export/page.tsx"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
    }
  });
});

describe("the file", () => {
  it("CSV: quoted cells, doubled quotes, objects as JSON, formulas defused, numbers untouched", () => {
    expect(csvCell('a "b"')).toBe('"a ""b"""');
    expect(csvCell({ x: 1 })).toBe('"{""x"":1}"');
    expect(csvCell("=HYPERLINK(1)")).toBe("\"'=HYPERLINK(1)\"");
    expect(csvCell(-12.5)).toBe('"-12.5"');
    expect(csvCell(null)).toBe('""');
    expect(rowsToCsv([{ a: 1, b: "x" }, { a: 2, c: "y" }])).toBe('"a","b","c"\r\n"1","x",""\r\n"2","","y"');
  });
  it("the file name carries the table and the time", () => {
    expect(exportFileName("jobs", new Date("2026-10-23T12:30:45.123Z"))).toBe("diger-jobs-2026-10-23T12-30-45.csv");
  });
  it("stripSecrets keeps everything else, untouched", () => {
    expect(stripSecrets({ id: "1", quote_hash: "abc", receipt_file_id: "f", jwt: "x" })).toEqual({ row: { id: "1", quote_hash: "abc", receipt_file_id: "f" }, omitted: ["jwt"] });
  });
});
