import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replicaAvailable, type ReplicaDb } from "../helpers/replicaDb";
import {
  applyMutant, inRolledBackTx, MUTANTS, probeAppendOnly, probeConstraints, probeIdempotency, startMoneyReplica, type MutantId,
} from "../helpers/moneySuite";

/**
 * Money invariants (DIGER-TRUTH §5) on the PRODUCTION money code in a real local PostgreSQL (DT-20261118-01, groups 1-3):
 * constraints, the append-only ledger, and the replay keys of every atomic money function. Every probe must hold on
 * production, and must CATCH each named mutant (a one-line bug in a money function or a dropped rule).
 * Skipped only where no PostgreSQL server exists; on CI that is a failure, never a silent skip.
 */
it.runIf(process.env.CI === "true")("CI has a local PostgreSQL, so the money suite runs instead of skipping", () => {
  expect(replicaAvailable(), "money suite needs /usr/lib/postgresql/<v>/bin/initdb on the CI runner (ubuntu-24.04 ships PostgreSQL 16)").toBe(true);
});

const PROBES = { constraints: probeConstraints, appendOnly: probeAppendOnly, idempotency: probeIdempotency } as const;
type ProbeName = keyof typeof PROBES;

// Each mutant names the EXACT violation(s) it must cause; a setup failure never counts as a catch (QA PR-2 r1).
const BITES: Array<[MutantId, ProbeName, string[]]> = [
  ["C1_drop_sign_check", "constraints", ["sign reserve>0: expected 23514", "sign charge>0: expected 23514"]],
  ["C2_drop_type_check", "constraints", ["catalog chk_ledger_type missing"]],
  ["C3_user_nullable", "constraints", ["ledger null user: expected 23502"]],
  ["C4_drop_ledger_pk", "constraints", ["duplicate ledger id: expected 23505", "catalog credit_ledger_pkey missing"]],
  ["C5_drop_part_job_unique", "constraints", ["part job unique: expected 23505"]],
  ["C6_drop_quote_status", "constraints", ["quote status: expected 23514"]],
  ["C7_drop_ledger_user_fk", "constraints", ["ledger unknown user: expected 23503"]],
  ["A1_drop_ledger_row_trigger", "appendOnly", ["credit_ledger UPDATE was allowed", "credit_ledger DELETE was allowed"]],
  ["A2_drop_ledger_truncate_trigger", "appendOnly", ["credit_ledger TRUNCATE was allowed"]],
  ["A3_drop_kinds_trigger", "appendOnly", ["credit_ledger_kinds UPDATE was allowed", "credit_ledger_kinds DELETE was allowed"]],
  ["A4_drop_parts_trigger", "appendOnly", ["job_group_parts UPDATE was allowed", "job_group_parts DELETE was allowed"]],
  ["A5_drop_keys_trigger", "appendOnly", ["job_group_keys UPDATE was allowed", "job_group_keys DELETE was allowed"]],
  ["A6_drop_frozen_trigger", "appendOnly", ["job_group_frozen UPDATE was allowed", "job_group_frozen DELETE was allowed"]],
  ["I1_reserve_replay", "idempotency", ["reserve_credits_atomic: replay flag already_reserved = false"]],
  ["I2_settle_replay", "idempotency", ["settle_job_atomic: replay flag already_settled = \"error "]],
  ["I3_topup_replay", "idempotency", ["approve_topup_atomic: replay flag already_approved = undefined"]],
  ["I4_methodology_replay", "idempotency", ["purchase_methodology_atomic: replay flag already_purchased = false"]],
  ["I5_grant_random_id", "idempotency", ["admin_grant_credit_atomic: first call wrote [adm_req_idem_0001_", "admin_grant_credit_atomic: replay wrote [adm_req_idem_0001_"]],
];

describe.skipIf(!replicaAvailable())("money invariants on the production bodies (real PostgreSQL)", () => {
  let db: ReplicaDb;
  beforeAll(async () => { db = await startMoneyReplica(); }, 180_000);
  afterAll(async () => { await db?.stop(); });

  it.each(Object.keys(PROBES) as ProbeName[])("%s: production holds (no violation)", async (name) => {
    expect(await inRolledBackTx(db.pool, (c) => PROBES[name](c))).toEqual([]);
  }, 300_000);

  it.each(BITES)("bites: mutant %s is caught by %s", async (id, probe, mustContain) => {
    const violations = await inRolledBackTx(db.pool, async (c) => {
      await applyMutant(c, MUTANTS[id]);
      return PROBES[probe](c);
    });
    expect(violations.filter((line) => /setup/.test(line)), "the probe's own setup must succeed under the mutant").toEqual([]);
    for (const text of mustContain) expect(violations.some((line) => line.includes(text)), `${text} | ${JSON.stringify(violations)}`).toBe(true);
  }, 300_000);
});
