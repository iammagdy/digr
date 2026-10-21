import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; app_metadata: Record<string, any>; user_metadata: Record<string, any>; email_confirmed_at: string },
  reads: 0,
  rows: [] as any[],
}));

vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user }, error: null }) } }) }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : new Error("no session") })) } })),
  createAdminClient: () => ({
    from: () => {
      const q: any = {
        select: () => q, order: () => q,
        range: async () => { h.reads += 1; return { data: h.rows, error: null, count: h.rows.length }; },
        insert: () => { throw new Error("write"); }, update: () => { throw new Error("write"); }, upsert: () => { throw new Error("write"); }, delete: () => { throw new Error("write"); },
      };
      return q;
    },
    from_: undefined,
  }),
}));

import * as exportRoute from "../src/app/api/admin/export/route";
import { middleware } from "../src/middleware";
import { resolveAdminLayoutRedirect } from "../src/app/admin/layout";
import { isSecretColumn } from "../src/lib/adminExport";

const person = (role?: string) => ({ id: "u1", email: "a@b.c", app_metadata: role ? { role } : {}, user_metadata: {}, email_confirmed_at: "2026-10-01T00:00:00Z" });
const get = (headers: Record<string, string> = {}) => exportRoute.GET(new NextRequest("http://x/api/admin/export?table=credit_ledger", { headers }));

beforeEach(() => {
  h.user = null; h.reads = 0;
  h.rows = [{ id: "l1", user_id: "u1", delta: 5, type: "topup", created_at: "2026-10-21T00:00:00Z", access_token: "SECRET-TOKEN-VALUE", api_key: "SECRET-KEY-VALUE" }];
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock";
});

describe("the export route answers GET and nothing else", () => {
  it("only GET is exported: any other verb is a 405 from the framework, before any code runs", () => {
    const verbs = Object.keys(exportRoute).filter((name) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name));
    expect(verbs).toEqual(["GET"]);
    const source = readFileSync("src/app/api/admin/export/route.ts", "utf8");
    expect(source).not.toMatch(/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/);
  });
});

describe("GET is for administrators only", () => {
  it("no session: 401 and nothing is read", async () => {
    const res = await get({ authorization: "Bearer nobody" });
    expect(res.status).toBe(401);
    expect(h.reads).toBe(0);
    expect(await res.text()).not.toContain("credit_ledger");
  });
  it("a signed-in customer (and a user with another role): 403 and nothing is read", async () => {
    for (const role of [undefined, "user", "support"]) {
      h.user = person(role);
      const res = await get({ authorization: "Bearer customer" });
      expect(res.status, String(role)).toBe(403);
      expect(h.reads).toBe(0);
      const text = await res.text();
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("rows");
    }
  });
  it("an administrator gets the rows, and no secret or token column or value is in the answer", async () => {
    h.user = person("admin");
    const res = await get({ authorization: "Bearer admin" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(h.reads).toBe(1);
    // no secret VALUE anywhere; the columns that were left out are named (names, never values) so a short file is explainable
    for (const needle of ["SECRET-TOKEN-VALUE", "SECRET-KEY-VALUE", "service_role", "Bearer"]) expect(text, needle).not.toContain(needle);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ table: "credit_ledger", columns: ["id", "user_id", "delta", "type", "created_at"], omitted: ["access_token", "api_key"] });
    expect(JSON.stringify(body.rows)).not.toMatch(/token|key|secret/i);
  });
});

describe("the five exported tables hold no secret-looking column to begin with", () => {
  it("their definitions in the migrations contain none", () => {
    const sql = readdirSync("supabase/migrations").map((file) => readFileSync(join("supabase/migrations", file), "utf8")).join("\n");
    for (const table of ["credit_ledger", "topups", "jobs", "plans_quotes", "profiles"]) {
      const create = new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
      expect(create, table).not.toBeNull();
      const columns = [...create![1].matchAll(/^\s{2}([a-z_]+)\s/gm)].map((m) => m[1]).filter((name) => !["constraint", "primary", "foreign", "unique", "check"].includes(name));
      expect(columns.length, table).toBeGreaterThan(3);
      for (const column of columns) expect(isSecretColumn(column), `${table}.${column}`).toBe(false);
    }
  });
});

describe("a non-administrator never sees the page, the route or a link to them", () => {
  it("the middleware sends a signed-in customer away from /admin/export (a page) and answers 403 to a JSON call; a visitor is sent to the login", async () => {
    h.user = person();
    const page = await middleware(new NextRequest("http://localhost:3000/admin/export"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/dashboard/chat");
    const json = await middleware(new NextRequest("http://localhost:3000/admin/export", { headers: { accept: "application/json" } }));
    expect(json.status).toBe(403);
    h.user = null;
    const visitor = await middleware(new NextRequest("http://localhost:3000/admin/export"));
    expect(visitor.status).toBe(307);
    expect(visitor.headers.get("location")).toContain("/login");
    h.user = person("admin");
    const admin = await middleware(new NextRequest("http://localhost:3000/admin/export"));
    expect(admin.headers.get("location")).toBeNull();
  });
  it("the admin layout redirects a non-admin before any admin markup (customer to the chat, visitor to the login)", () => {
    expect(resolveAdminLayoutRedirect({ app_metadata: {} }, true)).toBe("/dashboard/chat");
    expect(resolveAdminLayoutRedirect({ app_metadata: { role: "user" } }, true)).toBe("/dashboard/chat");
    expect(resolveAdminLayoutRedirect(null, true)).toBe("/login");
    expect(resolveAdminLayoutRedirect({ app_metadata: { role: "admin" } }, true)).toBeNull();
  });
  it("no customer-facing source, sitemap, robots file or navigation mentions the export", () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.(ts|tsx|mjs|json|md)$/.test(name)) files.push(path); } };
    walk("src");
    const allowed = (file: string) => file.startsWith("src/app/admin/") || file.startsWith("src/app/api/admin/") || file.startsWith("src/components/admin/") || file === "src/lib/adminExport.ts";
    const offenders = files.filter((file) => !allowed(file) && /admin\/export|adminExport/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
    expect(readFileSync("src/app/sitemap.ts", "utf8")).not.toMatch(/\/admin|\/api/);
    expect(readFileSync("src/app/robots.ts", "utf8")).toContain("admin");
  });
});
