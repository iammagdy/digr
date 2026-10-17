import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (name: string) => readFileSync(`supabase/migrations/${name}`, "utf8");

describe("review-only money migrations", () => {
  it("defines quote creation as a service-role-only atomic function with cap and input checks", () => {
    const sql = migration("20261017180000_create_quote_atomic.sql");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.create_quote_atomic(");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = public");
    expect(sql).toContain("p_total_points > v_cap");
    expect(sql).toContain("UPDATE public.plans_quotes");
    expect(sql).toContain("INSERT INTO public.plans_quotes");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.create_quote_atomic");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.create_quote_atomic");
  });

  it("keeps top-up approval and ledger credit in one transaction with the required function grants", () => {
    const sql = migration("20261017180500_approve_topup_atomic_privileges.sql");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.approve_topup_atomic(");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("INSERT INTO public.credit_ledger");
    expect(sql).toContain("UPDATE public.topups");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.approve_topup_atomic");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.approve_topup_atomic");
  });

  it("only retires an active lease after collection has reached a persisted terminal cursor or target", () => {
    const sql = migration("20261017175500_settle_completed_jobs_with_stale_lease.sql");
    expect(sql).toContain("v_job.current_cursor = 'completed'");
    expect(sql).toContain("v_job.delivered_units, 0) >= v_job.target_volume_max");
    expect(sql).toContain("Cannot settle job % while active chunk lease is held until %");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION public.settle_job_atomic");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.settle_job_atomic");
  });
});
