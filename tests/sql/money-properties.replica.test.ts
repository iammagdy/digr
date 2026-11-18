import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replicaAvailable, type ReplicaDb } from "../helpers/replicaDb";
import { MUTANTS, startMoneyReplica, type MutantId } from "../helpers/moneySuite";
import { propertySeeds, replaySequence, runSeeds } from "../helpers/moneyModel";

/**
 * Random money sequences (DT-20261118-01, group 4) on the PRODUCTION money code in a real local PostgreSQL: top-ups, admin
 * grants, quotes + approvals, deliveries, settles, releases, methodology purchases and replays over 4 users, from fixed seeds.
 * After EVERY command: each balance = SUM(delta) = the exact model and never below zero, the ledger has exactly the expected rows,
 * every job's status / charge / delivered count = the model and charge <= reserve; at the end the reconciliation shows ALL ✓.
 * Each named mutant must be caught; the failing sequence is cut to its failing step and shrunk (delete-one) for the report.
 * MONEY_PROP_SEEDS="1,2,3" replaces the fixed seeds for exploration only (never set in CI).
 */
const SEEDS = propertySeeds([11, 23, 37, 41, 53, 67, 79, 83, 97, 101]);
const PROPERTY_MUTANTS: MutantId[] = ["P1_charge_floor", "P2_charge_not_capped_by_reserve", "P3_release_one_more", "P4_no_concurrency_limit", "P5_settle_skips_release"];

describe.skipIf(!replicaAvailable())("random money sequences on the production bodies (real PostgreSQL)", () => {
  let db: ReplicaDb;
  beforeAll(async () => { db = await startMoneyReplica(); }, 180_000);
  afterAll(async () => { await db?.stop(); });

  it(`${SEEDS.length} fixed seeds x 60 commands over 4 users: every step keeps every invariant; reconciliation ALL ✓ at the end`, async () => {
    const r = await runSeeds(db.pool, { seeds: SEEDS, length: 60, users: 4 });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.runs).toBe(SEEDS.length);
    // never vacuous: every branch of the model ran at least once (accepts, both refusals, deliveries, charged settles, settle/release
    // replays and refusals, releases, purchases and their refusal, top-ups, grants, history replays)
    for (const [branch, count] of Object.entries(r.stats)) expect(count, branch).toBeGreaterThan(0);
  }, 300_000);

  it.each(PROPERTY_MUTANTS)("bites: mutant %s is caught, shrunk, and the shrunk sequence still fails", async (id) => {
    const r = await runSeeds(db.pool, { seeds: SEEDS, length: 60, users: 4, mutant: MUTANTS[id] });
    expect(r.ok, JSON.stringify(r)).toBe(false);
    if (r.ok) return;
    expect(r.shrunk.length).toBeGreaterThan(0);
    expect(r.shrunk.length).toBeLessThanOrEqual(r.original);
    const again = await replaySequence(db.pool, r.seed, r.shrunk, MUTANTS[id]);
    expect(again.ok, JSON.stringify({ shrunk: r.shrunk, message: r.message })).toBe(false);
  }, 300_000);
});
