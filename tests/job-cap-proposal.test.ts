import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDiffs, buildFiles, FUNCTIONS, HELPER_SQL, NEW_CAP, NEW_VOLUME_CEILING, OUT } from "../scripts/proposals/buildJobCapProposal";
import { DEFINITIONS_DIR, readDefinition, replicaAvailable, startReplica, type ReplicaDb } from "./helpers/replicaDb";
import { acceptQuote, balanceOf, createQuote, deliver, exactCharge, exactReserve, seedUser, settle, startJob } from "./helpers/replicaMoney";

/**
 * The SQL proposal for the 5,000-point cap (docs/proposals/job-cap-5000/): nothing is applied by this repository. These tests prove
 * (1) the committed files are exactly what the generator builds from the production definitions, (2) every function differs from
 * production in the intended lines only, (3) on a replica holding the production bodies the apply files raise the cap and the rollback
 * files restore every body byte for byte, with the grants unchanged, in both options, and (4) the apply order never opens a state in
 * which a quote can be larger than settlement allows.
 */
const EXPECTED_CHANGED_LINES: Record<string, { a: number; b: number }> = {
  settle_people_job_atomic: { a: 2, b: 2 }, settle_job_atomic: { a: 1, b: 1 }, accept_quote_atomic: { a: 1, b: 1 }, create_quote_atomic: { a: 1, b: 1 },
};
const read = (rel: string) => readFileSync(path.join(OUT, rel), "utf8");

describe("the generated proposal files", () => {
  it("every committed file is exactly what the generator builds (no drift, nothing hand-edited)", () => {
    for (const [rel, text] of Object.entries({ ...buildFiles(), ...buildDiffs() })) {
      expect(existsSync(path.join(OUT, rel)), rel).toBe(true);
      expect(read(rel), rel).toBe(text);
    }
  });

  it("each changed function differs from production in the intended lines only", () => {
    for (const fn of FUNCTIONS) {
      const prod = readDefinition(fn.file).split("\n").filter((l) => !l.startsWith("-- PRODUCTION"));
      for (const option of ["a", "b"] as const) {
        const proposed = read(option === "a" ? `functions/${fn.file}` : `functions-b/${fn.file}`).trim().split("\n");
        const base = prod.join("\n").trim().replace(/;?$/, ";").split("\n");
        expect(proposed.length, `${fn.file} ${option}`).toBe(base.length);
        const changed = proposed.filter((line, i) => line !== base[i]);
        expect(changed.length, `${fn.file} ${option}`).toBe(EXPECTED_CHANGED_LINES[fn.name][option]);
      }
    }
  });

  it("only the cap and the record ceiling are touched: no price, reserve, charge or ledger line changed", () => {
    for (const option of ["a", "b"] as const) {
      const diff = read(`diffs/option-${option}.diff`);
      const changed = diff.split("\n").filter((l) => /^[-+][^-+]/.test(l) && !l.startsWith("+++") && !l.startsWith("---"));
      const joined = changed.join("\n");
      expect(joined).not.toMatch(/CEIL|credit_ledger|unit_price|reserved_credits\b.*:=|INSERT|safetyBuffer/i);
      const touched = changed.filter((l) => l.startsWith("-")).map((l) => l.slice(1));
      for (const line of touched) expect(line, line).toMatch(/\b600\b|\b5000\b/);
    }
  });

  it("every apply and rollback file is one transaction and restores the grants (service_role only)", () => {
    for (const option of ["a", "b"]) {
      for (const fn of FUNCTIONS) {
        const idx = FUNCTIONS.indexOf(fn) + 1;
        for (const file of [`option-${option}/step${idx}_${fn.name}.sql`, `option-${option}/rollback_step${idx}_${fn.name}.sql`]) {
          const text = read(file);
          expect(text, file).toMatch(/^BEGIN;$/m);
          expect(text, file).toMatch(/^COMMIT;$/m);
          expect(text, file).toMatch(/REVOKE ALL ON FUNCTION .* FROM PUBLIC, anon, authenticated;/);
          expect(text, file).toMatch(/GRANT EXECUTE ON FUNCTION .* TO service_role;/);
          expect(text, file).not.toMatch(/GRANT .* TO (PUBLIC|anon|authenticated)/);
        }
      }
    }
    expect(read("option-b/step0_job_points_cap_helper.sql")).toContain(HELPER_SQL);
  });

  it("the apply order opens the quote gate (create_quote_atomic) last and the rollback closes it first", () => {
    expect(FUNCTIONS.map((f) => f.name)).toEqual(["settle_people_job_atomic", "settle_job_atomic", "accept_quote_atomic", "create_quote_atomic"]);
  });
});

async function defs(db: ReplicaDb): Promise<Record<string, string>> {
  const rows = (await db.pool.query(`select p.oid::regprocedure::text as sig, pg_get_functiondef(p.oid) as def,
      coalesce(p.proacl::text,'') as acl from pg_proc p where p.pronamespace='public'::regnamespace order by 1`)).rows;
  return Object.fromEntries(rows.map((r: any) => [r.sig, `${r.def}\n--ACL ${r.acl}`]));
}

describe.skipIf(!replicaAvailable()).each(["a", "b"] as const)("applied to a replica of production, option %s", (option) => {
  let db: ReplicaDb;
  const stepFiles = FUNCTIONS.map((fn, i) => `option-${option}/step${i + 1}_${fn.name}.sql`);
  const rollbackFiles = FUNCTIONS.map((fn, i) => `option-${option}/rollback_step${i + 1}_${fn.name}.sql`).reverse();
  beforeAll(async () => { db = await startReplica(); }, 90_000);
  afterAll(async () => { await db?.stop(); });

  it("applying every step (in order) raises the cap; rolling back (reverse order) restores every function byte for byte", async () => {
    await db.reset({ functionsDir: DEFINITIONS_DIR });
    const before = await defs(db);
    if (option === "b") await db.exec(read("option-b/step0_job_points_cap_helper.sql"));
    for (const file of stepFiles) await db.exec(read(file));
    const during = await defs(db);
    expect(during["create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamp with time zone,text[])"]).not.toBe(
      before["create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamp with time zone,text[])"]);
    // the grants of every function are exactly what they were
    for (const [sig, text] of Object.entries(during)) {
      if (sig.startsWith("job_points_cap")) continue;
      expect(text.split("--ACL ")[1], sig).toBe(before[sig].split("--ACL ")[1]);
    }
    // a 5,000-point job is quoted, reserved and settled
    const user = await seedUser(db.pool, 6000);
    const started = await startJob(db.pool, user, { unit: 0.28, volume: 15_000 });
    expect(started.accepted.success).toBe(true);
    await deliver(db.pool, started.jobId!, 12_000, 500, true);
    expect(Number((await settle(db.pool, started.jobId!, NEW_CAP)).charged_credits)).toBe(exactCharge(12_000, 280));
    expect(NEW_VOLUME_CEILING).toBe(100_000);

    for (const file of rollbackFiles) await db.exec(read(file));
    if (option === "b") await db.exec(read("option-b/rollback_step0_job_points_cap_helper.sql"));
    const after = await defs(db);
    expect(after).toEqual(before);
    // and the 600 gate is back
    await expect(createQuote(db.pool, user, { unit: 1, volume: 700, reserve: 700 })).rejects.toThrow(/between 0 and 600 points/);
  }, 120_000);

  it("every intermediate state is safe: until the last step no quote above 600 can exist; after it settlement can charge up to 5,000", async () => {
    await db.reset({ functionsDir: DEFINITIONS_DIR });
    const user = await seedUser(db.pool, 20_000);
    if (option === "b") await db.exec(read("option-b/step0_job_points_cap_helper.sql"));
    for (let i = 0; i < stepFiles.length - 1; i += 1) {
      await db.exec(read(stepFiles[i]));
      await expect(createQuote(db.pool, user, { unit: 1, volume: 900, reserve: 900 }), `after step ${i + 1}`).rejects.toThrow(/between 0 and 600 points/);
    }
    await db.exec(read(stepFiles[stepFiles.length - 1]));
    const big = await createQuote(db.pool, user, { unit: 1, volume: 4347, reserve: exactReserve(4347, 1000) });
    expect(big.result.success).toBe(true);
    const accepted = await acceptQuote(db.pool, user, big.quoteId);
    expect(accepted).toMatchObject({ success: true, reserved_credits: 5000 });
    await deliver(db.pool, accepted.job_id, 4347, 500, true);
    expect(Number((await settle(db.pool, accepted.job_id, NEW_CAP)).charged_credits)).toBe(4347);
    expect(await balanceOf(db.pool, user)).toBe(20_000 - 4347);
    await expect(createQuote(db.pool, user, { unit: 1, volume: 5001, reserve: 5001 })).rejects.toThrow(/between 0 and 5000 points/);
  }, 120_000);
});
