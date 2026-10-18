import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = [
  "supabase/migrations/20261018140000_credit_ledger_kinds.sql",
  "supabase/migrations/20261018140500_promo_codes_and_admin_grants.sql",
  "supabase/migrations/20261018141000_support_messages.sql",
];
const sql = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, "utf8")]));
const all = Object.values(sql).join("\n");

describe("the batch migrations keep the money rules", () => {
  const fns = [...all.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)/g)].map((m) => ({ name: m[1], args: m[2] }));

  it("defines the three approved credit functions and the append-only guard, nothing else that writes credit", () => {
    expect(fns.map((f) => f.name).sort()).toEqual([
      "admin_grant_credit_atomic", "admin_save_promo_code_atomic", "block_credit_kind_mutation", "redeem_promo_code_atomic",
    ]);
  });

  it("every function that writes credit is SECURITY DEFINER with a pinned search_path, revoked from everyone and granted to service_role only", () => {
    for (const name of ["redeem_promo_code_atomic", "admin_grant_credit_atomic", "admin_save_promo_code_atomic"]) {
      const body = all.slice(all.indexOf(`FUNCTION public.${name}(`));
      const header = body.slice(0, body.indexOf("AS $$"));
      expect(header, name).toContain("SECURITY DEFINER");
      expect(header, name).toContain("SET search_path TO 'public', 'pg_temp'");
      expect(all, name).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`));
      expect(all, name).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role;`));
    }
    expect(all).not.toMatch(/GRANT\s+(?:EXECUTE|SELECT|INSERT|UPDATE|ALL)[^;]*TO\s+(?:anon|authenticated|PUBLIC)\b/i);
  });

  it("the ledger is only ever inserted into: no update, delete, truncate or schema change on it", () => {
    expect(all).not.toMatch(/UPDATE\s+public\.credit_ledger\b/i);
    expect(all).not.toMatch(/DELETE\s+FROM\s+public\.credit_ledger\b/i);
    expect(all).not.toMatch(/TRUNCATE/i);
    expect(all).not.toMatch(/ALTER\s+TABLE\s+public\.credit_ledger\b/i);
    expect(all).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(all.match(/INSERT INTO public\.credit_ledger \(/g)!.length).toBe(2); // promo redemption and admin grant
  });

  it("credit rows use the existing allowed type and deterministic ids", () => {
    expect(all).toContain("'promo_' || v_code || '_' || p_user_id::text");
    expect(all).toContain("'adm_' || p_request_id");
    expect(sql[FILES[1]].match(/, 'grant', /g)!.length).toBe(2); // both credit inserts use the allowed type; the view only reads it
  });

  it("the admin role is checked inside the functions from the auth record, and promo redemption locks the code row", () => {
    expect(all.match(/raw_app_meta_data ->> 'role'/g)!.length).toBe(2);
    expect(all).toContain("FROM public.promo_codes WHERE code = v_code FOR UPDATE");
    expect(all).toContain("pg_advisory_xact_lock");
  });

  it("customer-facing reasons returned by the functions are Arabic", () => {
    for (const reason of all.matchAll(/'error_ar', '([^']+)'/g)) expect(reason[1]).toMatch(/[؀-ۿ]/);
  });

  it("the new tables are closed to customers (RLS on, nothing granted to anon or authenticated)", () => {
    for (const table of ["credit_ledger_kinds", "promo_codes", "promo_redemptions", "support_messages"]) {
      expect(all).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
    }
    expect(all).toContain("REVOKE ALL ON TABLE public.credit_ledger_kinds FROM PUBLIC, anon, authenticated;");
    expect(all).toContain("REVOKE ALL ON TABLE public.promo_codes, public.promo_redemptions FROM PUBLIC, anon, authenticated;");
    expect(all).toContain("REVOKE ALL ON TABLE public.support_messages FROM PUBLIC, anon, authenticated;");
    expect(all).toContain("REVOKE ALL ON TABLE public.credit_ledger_typed FROM PUBLIC, anon, authenticated;");
  });

  it("the apply guide lists every file in order with a verification and a rollback, and says nothing was applied", () => {
    const guide = readFileSync("docs/APPLY_MIGRATIONS_2.md", "utf8");
    let last = -1;
    for (const file of FILES) {
      const at = guide.indexOf(file.split("/").pop()!);
      expect(at, file).toBeGreaterThan(last);
      last = at;
    }
    expect((guide.match(/Verify:/g) || []).length).toBeGreaterThanOrEqual(3);
    expect((guide.match(/Rollback/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(guide).toContain("none of these files was applied by the author");
  });
});
