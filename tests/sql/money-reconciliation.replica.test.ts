import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replicaAvailable, type ReplicaDb } from "../helpers/replicaDb";
import { applyMutant, inRolledBackTx, MUTANTS, startMoneyReplica } from "../helpers/moneySuite";
import { buildReconScenario, closeGroupTx, RECON_CHECKS, RECON_FAULTS, RECON_SQL_PATH, runReconciliation } from "../helpers/moneyModel";

/**
 * The read-only ledger reconciliation Megz pastes into the Supabase SQL Editor (DT-20261118-01, group 5), run here on the
 * PRODUCTION money code in a real local PostgreSQL: every hard row holds on a clean mixed state, and one injected fault per
 * row turns that row ✗. The file itself must stay one read-only SELECT.
 */
const ROOT = path.resolve(__dirname, "..", "..");

function stripCommentsAndLiterals(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/'(?:[^']|'')*'/g, "''");
}

it("the reconciliation file is one read-only SELECT", () => {
  const text = readFileSync(path.join(ROOT, RECON_SQL_PATH), "utf8");
  expect(text.split("\n")[0]).toBe("-- 01_reconcile_ledger.sql — money reconciliation (DT-20261118-01). READ ONLY.");
  const code = stripCommentsAndLiterals(text);
  expect(code.trim().endsWith(";")).toBe(true);
  expect(code.split(";").filter((s) => s.trim()).length).toBe(1);
  expect(code).not.toMatch(/\b(insert|update|delete|truncate|create|alter|drop|grant|revoke|copy|call|do|perform|lock|vacuum|refresh|begin|commit|rollback|set|execute)\b/i);
});

describe.skipIf(!replicaAvailable())("reconciliation on the production bodies (real PostgreSQL)", () => {
  let db: ReplicaDb;
  beforeAll(async () => { db = await startMoneyReplica(); }, 180_000);
  afterAll(async () => { await db?.stop(); });

  it("a clean mixed state: every hard row ✓ and ALL ✓, run in a READ ONLY transaction", async () => {
    const rows = await inRolledBackTx(db.pool, async (c) => {
      await buildReconScenario(c);
      await c.query("SET LOCAL transaction_read_only = on");
      return runReconciliation(c);
    });
    expect(rows.map((r) => r.check)).toEqual(RECON_CHECKS);
    expect(rows.filter((r) => r.ok === "✗")).toEqual([]);
    expect(rows.find((r) => r.check.startsWith("I02 "))?.actual).toBe("15");
    expect(rows.at(-1)).toMatchObject({ check: "ALL", ok: "✓" });
  }, 120_000);

  it.each(RECON_FAULTS)("bites: the fault for %s turns that row ✗ and ALL ✗", async (prefix, fault) => {
    const rows = await inRolledBackTx(db.pool, async (c) => {
      const s = await buildReconScenario(c);
      await c.query(fault(s));
      return runReconciliation(c);
    });
    expect(rows.find((r) => r.check.startsWith(`${prefix} `))?.ok, JSON.stringify(rows.filter((r) => r.ok === "✗"))).toBe("✗");
    expect(rows.at(-1)?.ok).toBe("✗");
  }, 120_000);

  it("bites: mutant R1_group_remainder_whole_hold (close releases the whole hold) is caught by G03 and G04", async () => {
    const rows = await inRolledBackTx(db.pool, async (c) => {
      await applyMutant(c, MUTANTS.R1_group_remainder_whole_hold);
      const s = await buildReconScenario(c);
      await closeGroupTx(c, s.openGroup);
      return runReconciliation(c);
    });
    for (const p of ["G03", "G04"]) expect(rows.find((r) => r.check.startsWith(`${p} `))?.ok).toBe("✗");
  }, 120_000);

  it("a file mutant stays inside its rolled-back transaction (the source's own BEGIN;/COMMIT; are stripped)", async () => {
    const bodyMd5 = "select md5(prosrc) as h from pg_proc where proname = 'close_job_group_atomic' and pronamespace = 'public'::regnamespace";
    const jobsCount = "select count(*)::int as n from public.jobs";
    const before = (await db.pool.query(bodyMd5)).rows[0].h;
    const jobsBefore = (await db.pool.query(jobsCount)).rows[0].n;
    const inside = await inRolledBackTx(db.pool, async (c) => {
      await applyMutant(c, MUTANTS.R1_group_remainder_whole_hold);
      await buildReconScenario(c);
      return (await c.query(bodyMd5)).rows[0].h;
    });
    expect(inside).not.toBe(before);
    expect((await db.pool.query(bodyMd5)).rows[0].h).toBe(before);
    expect((await db.pool.query(jobsCount)).rows[0].n).toBe(jobsBefore);
  }, 120_000);
});
