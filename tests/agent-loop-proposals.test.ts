import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const DIR = "docs/proposals/agent-loop";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

describe("the agent-loop SQL is a PROPOSAL: marked, never applied, never touching money", () => {
  it("the files are the ones the README lists", () => {
    expect(files).toEqual([
      "00_verify_before_apply.sql", "01_recipes.rollback.sql", "01_recipes.sql", "02_exploration_calls.rollback.sql", "02_exploration_calls.sql",
      "03_unknown_keys.rollback.sql", "03_unknown_keys.sql", "04_verify_after_apply.sql", "05_sensitive_access.rollback.sql", "05_sensitive_access.sql", "06_verify_sensitive_access.sql",
    ]);
    const readme = readFileSync(`${DIR}/README.md`, "utf-8");
    for (const f of files) expect(readme, f).toContain(f.replace(".rollback", ".rollback"));
    expect(readme).toContain("NOT APPLIED");
  });

  it("every file says on its first line that it is NOT APPLIED or READ ONLY", () => {
    for (const f of files) {
      const first = readFileSync(`${DIR}/${f}`, "utf-8").split("\n")[0];
      expect(first, f).toMatch(/^-- (NOT APPLIED|READ ONLY)/);
    }
  });

  it("no file writes, alters or drops a money table, or defines or replaces a money function", () => {
    const money = /(credit_ledger|credit_ledger_kinds|\bjobs\b|\btopups\b|\bprofiles\b|plans_quotes|provider_costs|promo_codes|promo_redemptions)/i;
    const write = /\b(insert\s+into|update|delete\s+from|alter\s+table|drop\s+table|truncate|create\s+(or\s+replace\s+)?function)\b/i;
    for (const f of files) {
      const sql = readFileSync(`${DIR}/${f}`, "utf-8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      for (const statement of sql.split(";")) {
        if (write.test(statement) && money.test(statement)) throw new Error(`${f} writes a money table: ${statement.trim().slice(0, 120)}`);
      }
    }
  });

  it("the verify files only read", () => {
    for (const f of ["00_verify_before_apply.sql", "04_verify_after_apply.sql", "06_verify_sensitive_access.sql"]) {
      const sql = readFileSync(`${DIR}/${f}`, "utf-8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      expect(sql, f).not.toMatch(/\b(insert|update|delete|alter|drop|create|truncate|grant|revoke)\b/i);
    }
  });

  it("the tables are closed to anon and authenticated: row-level security on, privileges revoked, no policy", () => {
    for (const f of ["01_recipes.sql", "02_exploration_calls.sql", "03_unknown_keys.sql"]) {
      const sql = readFileSync(`${DIR}/${f}`, "utf-8");
      expect(sql, f).toMatch(/ENABLE ROW LEVEL SECURITY/);
      expect(sql, f).toMatch(/REVOKE ALL ON public\.\w+ FROM PUBLIC, anon, authenticated/);
      expect(sql, f).not.toMatch(/CREATE POLICY/i);
    }
  });

  it("a reviewed recipe is immutable and one version per slug is in force (the constraint and the trigger are in the file)", () => {
    const sql = readFileSync(`${DIR}/01_recipes.sql`, "utf-8");
    expect(sql).toContain("a reviewed recipe is immutable");
    expect(sql).toContain("recipes_one_reviewed_per_slug");
    expect(sql).toContain("recipes_review_complete");
  });
});
