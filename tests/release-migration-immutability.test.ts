import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const proposalMigrations = [
  "20261017150000_register_professional_people_search.sql",
  "20261017175000_cleanup_capability_registry_social.sql",
  "20261017175500_settle_completed_jobs_with_stale_lease.sql",
  "20261017180000_create_quote_atomic.sql",
  "20261017180500_approve_topup_atomic_privileges.sql",
  "20261017181000_settle_decision_maker_fields.sql",
];

describe("release_job_atomic migration immutability", () => {
  it("leaves both live release_job_atomic overloads untouched by this migration set", () => {
    for (const filename of proposalMigrations) {
      const sql = readFileSync(resolve(process.cwd(), "supabase/migrations", filename), "utf8");
      expect(sql, filename).not.toMatch(/\brelease_job_atomic\b/i);
    }
  });

  it("keeps the stale-lease proposal limited to settle_job_atomic", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261017175500_settle_completed_jobs_with_stale_lease.sql"),
      "utf8",
    );
    expect(sql.match(/CREATE OR REPLACE FUNCTION/gi)).toHaveLength(1);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.settle_job_atomic/i);
    expect(sql).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.settle_job_atomic(text, numeric, text) FROM PUBLIC, anon, authenticated;");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.settle_job_atomic(text, numeric, text) TO service_role;");
  });
});
