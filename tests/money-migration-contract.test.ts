import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(`supabase/migrations/${name}`, "utf8").toLowerCase();

describe("money migration security contracts", () => {
  it.each([
    ["20261017180000_create_quote_atomic.sql", "create_quote_atomic", "for update"],
    ["20261017180500_approve_topup_atomic_privileges.sql", "approve_topup_atomic", "for update"],
    ["20261017180500_approve_topup_atomic_privileges.sql", "reject_topup_atomic", "for update"],
    ["20261017181000_settle_decision_maker_fields.sql", "settle_people_job_atomic", "for update"],
  ])("keeps %s as a locked service-role-only definer function", (file, functionName, lockClause) => {
    const sql = read(file);
    const start = sql.indexOf(`create or replace function public.${functionName}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = sql.slice(start, sql.indexOf("$$;", start) + 3);
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = public");
    expect(body).toContain(lockClause);
    expect(sql).toContain(`revoke all on function public.${functionName}`);
    expect(sql).toContain(`grant execute on function public.${functionName}`);
    expect(sql).toContain("to service_role");
  });

  it("bounds quote reserves and treats replayed inserts idempotently", () => {
    const sql = read("20261017180000_create_quote_atomic.sql");
    expect(sql).toContain("p_total_points > v_cap");
    expect(sql).toContain("quote idempotency conflict");
    expect(sql).toContain("already_created");
  });

  it("derives decision-maker charges from the accepted quote and delivered field counts", () => {
    const sql = read("20261017181000_settle_decision_maker_fields.sql");
    expect(sql).toContain("contactunitpricespoints");
    expect(sql).toContain("p_base_units*v_base_price + p_email_units*v_email_price + p_phone_units*v_phone_price");
    expect(sql).toContain("least(v_raw_charge, v_job.reserved_credits");
    expect(sql).toContain("600");
  });
});
