import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENDED_STATUSES, OPEN_STATUSES } from "../src/lib/agentMission/stage4/addonRow";
import { classifyInsertError } from "../src/lib/agentMission/stage4/addonRowStore";
import { solo, type Row } from "./helpers/scheduledWorld";
import { addonRowOf } from "./helpers/reviewQuoteWorld";

/**
 * SAFETY ROUND, PR C: THE PREPARED MIGRATION (NOT APPLIED) is held to its documented shape by tests that ALWAYS run (no database needed), and the model of the index is held to what the REAL PostgreSQL 16 did when the migration was run on a disposable local database
 * (docs/STAGE-4-ONE-OPEN-ADDON-INDEX-VERIFICATION.txt: 51 checks, produced by scripts/verify/verify-one-open-addon-index.sh). The SQL itself is verified by that script (it needs a scratch PostgreSQL: `DIGR_TEST_PG=<socket>:<port>`); no test here is skipped.
 */
const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const FILE = readdirSync(MIGRATIONS).filter((f) => f.endsWith("_one_open_addon_per_file.sql"));
const sql = (): string => readFileSync(path.join(MIGRATIONS, FILE[0]), "utf8");
/** The statements, without comments. */
const code = (): string => sql().replace(/--[^\n]*/g, "");
/** The statements without comments AND without the text of string literals (a message or a comment-on text may name a word a statement must not use). */
const statements = (): string => code().replace(/'(?:[^']|'')*'/g, "''");

describe("the migration file", () => {
  it("there is exactly one, named the way the Supabase CLI names a migration (a timestamp, then the name), and it sorts AFTER every other migration", () => {
    expect(FILE).toHaveLength(1);
    expect(FILE[0]).toMatch(/^\d{14}_one_open_addon_per_file\.sql$/);
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all[all.length - 1]).toBe(FILE[0]);
  });
  it("it creates ONE unique partial index on the key plan->addon->>of, with the key and the deny-list of the four ENDED statuses in the predicate, if not exists", () => {
    const c = code().replace(/\s+/g, " ");
    expect(c).toContain("CREATE UNIQUE INDEX IF NOT EXISTS missions_one_open_addon_per_file ON public.missions ((plan->'addon'->>'of')) WHERE (plan->'addon'->>'of') IS NOT NULL AND status NOT IN ('completed', 'failed', 'unserved', 'cancelled');");
    expect((c.match(/CREATE\s+(UNIQUE\s+)?INDEX/gi) ?? []).length).toBe(1);
    expect(c).not.toMatch(/CONCURRENTLY/i);
  });
  it("the four ended statuses are the code's: completed + ENDED_STATUSES, and together with the six open ones they are exactly the ten statuses of the table's CHECK", () => {
    const ended = ["completed", ...ENDED_STATUSES].sort();
    expect(ended).toEqual(["cancelled", "completed", "failed", "unserved"]);
    const check = readFileSync(path.join(ROOT, "docs", "proposals", "agent-worker", "01_agent_tables.sql"), "utf8").match(/status\s+text[^\n]*CHECK \(status IN \(([^)]*)\)\)/)![1].split(",").map((s) => s.trim().replace(/'/g, "")).sort();
    expect([...OPEN_STATUSES, ...ended].sort()).toEqual(check);
    for (const s of ended) expect(sql()).toContain(`'${s}'`);
    for (const s of OPEN_STATUSES) expect(code(), `the open status ${s} is never named: it is held by the deny-list`).not.toContain(`'${s}'`);
  });
  it("it only creates the index: no data statement, no table, function, policy or grant, no money table, no CONCURRENTLY", () => {
    const c = statements();
    expect(c).not.toMatch(/\b(DELETE|TRUNCATE|DROP|ALTER|GRANT|REVOKE|CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TABLE|POLICY|TRIGGER|VIEW))\b/i);
    expect(c).not.toMatch(/\bINSERT\b|\bUPDATE\b\s+\S+\s+SET/i);
    expect(c).not.toMatch(/credit_ledger|public\.jobs|topups|plans_quotes|profiles|provider_costs/);
  });
  it("it stops with an exception, and changes nothing, when: the table is missing, `plan` is not jsonb, or a file already has two open add-ons", () => {
    const c = code().replace(/\s+/g, " ");
    expect(c).toContain("to_regclass('public.missions') IS NULL");
    expect(c).toMatch(/IF v_type IS DISTINCT FROM 'jsonb' THEN RAISE EXCEPTION/);
    expect(c).toMatch(/HAVING count\(\*\) > 1/);
    expect((c.match(/RAISE EXCEPTION/g) ?? []).length).toBe(3);
    // the checks come BEFORE the index
    expect(c.indexOf("RAISE EXCEPTION")).toBeLessThan(c.indexOf("CREATE UNIQUE INDEX"));
  });
  it("its rollback is written in the file and is one DROP INDEX of that name (a comment on the index)", () => {
    expect(sql()).toContain("Rollback: DROP INDEX public.missions_one_open_addon_per_file;");
  });
  it("it says it is NOT applied, and the same statement is the one the Stage E document proposed (text equality, whitespace aside)", () => {
    expect(sql()).toMatch(/NOT APPLIED/);
    const proposal = readFileSync(path.join(ROOT, "docs", "STAGE-4-CONCURRENCY.md"), "utf8").match(/create unique index if not exists missions_one_open_addon_per_file[\s\S]*?;\n/i)![0];
    const norm = (t: string) => t.replace(/\s+/g, " ").replace(/, /g, ",").replace(/\(\(plan->'addon'->>'of'\)\)/g, "((plan->'addon'->>'of'))").toLowerCase().trim();
    const statement = code().match(/CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*?;/)![0];
    expect(norm(statement)).toBe(norm(proposal));
  });
});

describe("the verification script and its recorded evidence", () => {
  it("the script exists, is executable, REFUSES to run without DIGR_TEST_PG (exit 2, it reads no other connection setting), and names no production setting", () => {
    const script = path.join(ROOT, "scripts", "verify", "verify-one-open-addon-index.sh");
    expect(existsSync(script)).toBe(true);
    const r = spawnSync("bash", [script], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "test" }, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/set DIGR_TEST_PG/);
    const text = readFileSync(script, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(text).not.toMatch(/DATABASE_URL|SUPABASE_|\.env|service_role_key|POSTGRES_URL/i);
    expect(execFileSync("bash", ["-n", script], { encoding: "utf8" })).toBe("");
  });
  it("the recorded transcript is complete: 51 checks, none failed, and it covers the refusals, the allowances, the preconditions, the race, the lock, the rollback and the pre-checks", () => {
    const t = readFileSync(path.join(ROOT, "docs", "STAGE-4-ONE-OPEN-ADDON-INDEX-VERIFICATION.txt"), "utf8");
    expect(t).toMatch(/=== 51 passed, 0 failed/);
    expect(t).not.toMatch(/^FAIL/m);
    for (const needle of ["the migration raises", "existing violators", "a SECOND open add-on of the same file is refused", "REOPENING an ended row", "exactly ONE open add-on row", "CONCURRENTLY cannot run inside a transaction block", "rollback is one DROP INDEX", "check 1 (rows that would violate the index)", "200,000 rows"]) expect(t).toContain(needle);
  });
  it("the error messages used by the classification tests are the ones in the transcript", () => {
    const t = readFileSync(path.join(ROOT, "docs", "STAGE-4-ONE-OPEN-ADDON-INDEX-VERIFICATION.txt"), "utf8");
    expect(t).toContain('duplicate key value violates unique constraint "missions_one_open_addon_per_file"');
    expect(t).toContain("engine order when ONE insert violates BOTH (same id AND the file is open): UNIQUE missions_pkey");
    expect(classifyInsertError({ code: "23505", message: 'duplicate key value violates unique constraint "missions_pkey"' }).by).toBe("same_id");
  });
});

describe("the MODEL of the index (tests/helpers/scheduledWorld.ts) behaves as the REAL PostgreSQL did (the cases of the transcript)", () => {
  const MISSION = "msn_5851abc92a1e6645a9cd";
  const ME = "u-1";
  const base = (id: string, status: string, of = MISSION, extra: Record<string, unknown> = {}): Row => ({ ...addonRowOf({ status, kind: "review", base: 1, of }), id, request_text: "request text", job_id: null, approved_at: null, ...extra });
  const insert = (rows: Row[], row: Row) => solo({ objects: {}, uniqueOpenIndex: true, seed: rows }, async (c) => (await c.from("missions").insert(row)).error).then((r) => r.value as { code: string; message: string } | null);
  const by = (e: { code: string; message: string } | null) => (e ? (classifyInsertError(e).by ?? "other") : "ok");

  it("a second open add-on of a file is refused as «other_open»; a started status holds the slot too", async () => {
    expect(by(await insert([base("msn_r1aaaaaa", "queued")], base("msn_r2aaaaaa", "plan_ready")))).toBe("other_open");
    for (const s of ["approved", "executing", "needs_input", "planning"]) expect(by(await insert([base("msn_r1aaaaaa", "queued")], base(`msn_h${s.slice(0, 3)}aaaaaa`, s))), s).toBe("other_open");
  });
  it("a different file is independent; an ended row never holds the slot; the same id is the primary key's", async () => {
    expect(by(await insert([base("msn_r1aaaaaa", "queued")], base("msn_r3aaaaaa", "queued", "msn_fileB")))).toBe("ok");
    for (const s of ["completed", "failed", "unserved", "cancelled"]) expect(by(await insert([base("msn_r1aaaaaa", "queued")], base(`msn_e${s.slice(0, 3)}aaaaaa`, s))), s).toBe("ok");
    expect(by(await insert([base("msn_r1aaaaaa", "queued")], base("msn_r1aaaaaa", "completed", "msn_fileC")))).toBe("same_id");
  });
  it("the real engine reported the PRIMARY KEY when one insert violated both (same id AND the file open); the model does too", async () => {
    expect(by(await insert([base("msn_r1aaaaaa", "queued")], base("msn_r1aaaaaa", "queued")))).toBe("same_id");
  });
  it("after the open row ends a new open add-on of the file is allowed; REOPENING an ended row while another is open is refused; open-to-open updates are never refused", async () => {
    const run = (fn: (c: any) => Promise<unknown>, seed: Row[]) => solo({ objects: {}, uniqueOpenIndex: true, seed }, fn).then((r) => r.value as { error: { message: string } | null });
    const ended = base("msn_r1aaaaaa", "cancelled"); const open = base("msn_r4aaaaaa", "queued");
    const reopen = await run(async (c) => c.from("missions").update({ status: "queued" }).eq("id", "msn_r1aaaaaa"), [ended, open]);
    expect(reopen.error?.message ?? "").toContain("missions_one_open_addon_per_file");
    const step = await run(async (c) => c.from("missions").update({ status: "approved" }).eq("id", "msn_r4aaaaaa"), [ended, open]);
    expect(step.error).toBeNull();
    const exec = await run(async (c) => c.from("missions").update({ status: "executing" }).eq("id", "msn_r4aaaaaa"), [ended, base("msn_r4aaaaaa", "approved")]);
    expect(exec.error).toBeNull();
  });
  it("ordinary research missions (no add-on key) and rows with no valid add-on key are unlimited, as in the real engine", async () => {
    const ordinary = (id: string): Row => ({ id, user_id: ME, request_text: "request text", status: "queued", plan: { stages: [] }, job_id: null, approved_at: null });
    expect(by(await insert([ordinary("msn_ord00001"), ordinary("msn_ord00002")], ordinary("msn_ord00003")))).toBe("ok");
    const noKey = (id: string, plan: unknown): Row => ({ id, user_id: ME, request_text: "request text", status: "queued", plan, job_id: null, approved_at: null });
    for (const plan of [{ addon: null }, { addon: "text" }, { addon: [] }, { addon: {} }, { addon: { of: null } }]) expect(by(await insert([noKey("msn_mal00001", plan)], noKey("msn_mal00002", plan))), JSON.stringify(plan)).toBe("ok");
  });
});
