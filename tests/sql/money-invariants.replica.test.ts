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

const BITES: Array<[MutantId, ProbeName, string]> = [
  ["C1_drop_sign_check", "constraints", "sign"],
  ["C2_drop_type_check", "constraints", "catalog chk_ledger_type"],
  ["C3_user_nullable", "constraints", "ledger null user"],
  ["C4_drop_ledger_pk", "constraints", "duplicate ledger id"],
  ["C5_drop_part_job_unique", "constraints", "part job unique"],
  ["C6_drop_quote_status", "constraints", "quote status"],
  ["C7_drop_ledger_user_fk", "constraints", "ledger unknown user"],
  ["A1_drop_ledger_row_trigger", "appendOnly", "credit_ledger UPDATE"],
  ["A2_drop_ledger_truncate_trigger", "appendOnly", "credit_ledger TRUNCATE"],
  ["A3_drop_kinds_trigger", "appendOnly", "credit_ledger_kinds UPDATE"],
  ["A4_drop_parts_trigger", "appendOnly", "job_group_parts UPDATE"],
  ["A5_drop_keys_trigger", "appendOnly", "job_group_keys UPDATE"],
  ["A6_drop_frozen_trigger", "appendOnly", "job_group_frozen UPDATE"],
  ["I1_reserve_replay", "idempotency", "reserve_credits_atomic"],
  ["I2_settle_replay", "idempotency", "settle_job_atomic"],
  ["I3_topup_replay", "idempotency", "approve_topup_atomic"],
  ["I4_methodology_replay", "idempotency", "purchase_methodology_atomic"],
  ["I5_grant_random_id", "idempotency", "admin_grant_credit_atomic"],
];

describe.skipIf(!replicaAvailable())("money invariants on the production bodies (real PostgreSQL)", () => {
  let db: ReplicaDb;
  beforeAll(async () => { db = await startMoneyReplica(); }, 180_000);
  afterAll(async () => { await db?.stop(); });

  it.each(Object.keys(PROBES) as ProbeName[])("%s: production holds (no violation)", async (name) => {
    expect(await inRolledBackTx(db.pool, (c) => PROBES[name](c))).toEqual([]);
  }, 300_000);

  it.each(BITES)("bites: mutant %s is caught by %s", async (id, probe, mustMention) => {
    const violations = await inRolledBackTx(db.pool, async (c) => {
      await applyMutant(c, MUTANTS[id]);
      return PROBES[probe](c);
    });
    expect(violations.some((line) => line.includes(mustMention)), JSON.stringify(violations)).toBe(true);
  }, 300_000);
});
