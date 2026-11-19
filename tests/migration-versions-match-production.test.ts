import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * DT-20261119-02 (D-0105): the repo's migration files carry the SAME versions production recorded. Production's supabase_migrations.schema_migrations (read-only export of 2026-11-19: tests/fixtures/prod-migration-versions-2026-11-19.txt,
 * 28 rows) held 8 migrations under another version than the repo files of the same name; the Supabase check «Remote migration versions not found in local» failed on them. The 8 files were renamed (content untouched) to production's versions.
 * This test fails if a file is renamed back, or a production version loses its file. It does NOT require the opposite (a NEW migration is not in the 2026-11-19 snapshot, so adding one never fails it).
 */
const prod = readFileSync("tests/fixtures/prod-migration-versions-2026-11-19.txt", "utf8").trim().split("\n").map((l) => { const [version, name] = l.split(","); return { version, name }; });
const repo = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).map((f) => { const m = /^(\d{14})_(.+)\.sql$/.exec(f)!; return { version: m[1], name: m[2], file: f }; });

describe("the repo's migration versions match production's", () => {
  it("the snapshot is the 28 recorded migrations, and every one has a repo file with the same version AND the same name", () => {
    expect(prod).toHaveLength(28);
    for (const p of prod) expect(repo.find((r) => r.version === p.version)?.name, `version ${p.version}`).toBe(p.name);
  });
  it("no name appears under two versions in the repo (a renamed file never leaves its old copy behind)", () => {
    const names = repo.map((r) => r.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    const versions = repo.map((r) => r.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
  it("the eight files that were renamed to production's version keep their order against each other and keep their content (still the review-only definitions)", () => {
    const eight = ["fix_provider_spend_scope", "request_attempt_history", "register_professional_people_search", "cleanup_capability_registry_social", "settle_completed_jobs_with_stale_lease", "create_quote_atomic", "approve_topup_atomic_privileges", "settle_decision_maker_fields"];
    const files = eight.map((n) => repo.find((r) => r.name === n)!.file);
    expect(files.every(Boolean)).toBe(true);
    const order = ["register_professional_people_search", "cleanup_capability_registry_social", "settle_completed_jobs_with_stale_lease", "create_quote_atomic", "approve_topup_atomic_privileges", "settle_decision_maker_fields"].map((n) => repo.find((r) => r.name === n)!.version);
    expect([...order].sort()).toEqual(order);
    expect(readFileSync(`supabase/migrations/${repo.find((r) => r.name === "create_quote_atomic")!.file}`, "utf8")).toMatch(/v_cap numeric := 600;/);
  });
});
