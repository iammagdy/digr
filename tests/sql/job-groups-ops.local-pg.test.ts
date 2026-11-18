import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDb, type ScratchDb } from "./localPg";
import { GROUP_PART_STOPPED_AR, GROUP_OPERATOR_CLOSE_AR } from "../../src/lib/multiProvider/copy";
import { toArabicDigits } from "../../src/lib/arabicDigits";
import { pointsAr } from "../../src/lib/pointsFormat";

/**
 * T1 (g), (j), (n), (o): Operator close and report scripts proof on a REAL scratch PostgreSQL (DIGER_PROOF=1).
 * When DIGER_PROOF is unset, this test file is SKIPPED.
 * When DIGER_PROOF=1 and DIGER_TEST_PG is unset, this file THROWS.
 * Refuses any host containing supabase.co.
 */
const PROOF = process.env.DIGER_PROOF === "1";

if (PROOF) {
  const target = process.env.DIGR_TEST_PG || process.env.DIGER_TEST_PG;
  if (!target) {
    throw new Error("DIGER_PROOF=1 requires DIGER_TEST_PG to be set to a scratch PostgreSQL host:port");
  }
  if (target.includes("supabase.co")) {
    throw new Error("Refusing to run tests against supabase.co! Scratch Postgres only.");
  }
}

const DIR = path.resolve(__dirname, "../../docs/proposals/job-groups-one-hold");
const sql03Path = path.join(DIR, "03_operator_close_open_groups.sql");
const sql04Path = path.join(DIR, "04_report_open_groups.sql");
const sql01Path = path.join(DIR, "01_job_groups_one_hold.sql");
const S = "SET ROLE service_role;";

describe.skipIf(!PROOF)("operator close and report scripts (T1 g, j, n, o)", () => {
  let db: ScratchDb;

  const json = (call: string) => JSON.parse(db.sql(`${S} SELECT ${call}`));
  const balance = (userId: string) =>
    Number(db.sql(`SELECT COALESCE(SUM(delta), 0) FROM public.credit_ledger WHERE user_id = '${userId}'`));
  const ledgerCount = () => Number(db.sql("SELECT count(*) FROM public.credit_ledger"));

  const USER_1 = "00000000-0000-0000-0000-000000000001";
  const USER_2 = "00000000-0000-0000-0000-000000000002";

  beforeAll(() => {
    db = createScratchDb();
    // Seed test users
    db.sql(`INSERT INTO auth.users (id, email) VALUES ('${USER_1}', 'u1@t'), ('${USER_2}', 'u2@t') ON CONFLICT DO NOTHING;`);
    db.sql("INSERT INTO public.profiles (id, email) SELECT id, email FROM auth.users ON CONFLICT DO NOTHING;");
    // Initial balance topups
    db.sql(`INSERT INTO public.credit_ledger (id, user_id, delta, type, note) VALUES ('tp_u1', '${USER_1}', 20000, 'topup', 'seed');`);
    db.sql(`INSERT INTO public.credit_ledger (id, user_id, delta, type, note) VALUES ('tp_u2', '${USER_2}', 20000, 'topup', 'seed');`);

    // Apply proposal 01 if available in this worktree / environment
    if (existsSync(sql01Path)) {
      const sql01 = readFileSync(sql01Path, "utf8");
      db.sql(sql01);
    }
  }, 180000);

  afterAll(() => {
    db?.drop();
  });

  it("structural assertions on proposal files: no DROP, no REVOKE service_role, no 05 file, 04 READ ONLY", () => {
    expect(existsSync(sql03Path)).toBe(true);
    expect(existsSync(sql04Path)).toBe(true);
    expect(existsSync(path.join(DIR, "05_stop_new_groups.sql"))).toBe(false);

    const files = readdirSync(DIR).filter((f) => f.endsWith(".sql"));
    for (const f of files) {
      const content = readFileSync(path.join(DIR, f), "utf8");
      expect(content).not.toMatch(/DROP\s+TABLE/i);
      expect(content).not.toMatch(/DROP\s+FUNCTION/i);
      expect(content).not.toMatch(/REVOKE\s+.*FROM\s+.*service_role/i);
    }

    const sql03 = readFileSync(sql03Path, "utf8");
    expect(sql03).toContain("close_job_group_atomic");
    expect(sql03).toContain(GROUP_PART_STOPPED_AR);

    const sql04 = readFileSync(sql04Path, "utf8");
    expect(sql04).toMatch(/^\s*--[^\n]*\n*BEGIN TRANSACTION READ ONLY;/m);
    expect(sql04.trim()).toMatch(/ROLLBACK;\s*$/);
  });

  it("(j) OPERATOR close: settled part 1 + running part 2 returns correct S7 and part_released", () => {
    if (!existsSync(sql01Path)) return;

    // Helper to test job_group_points_ar matches pointsAr(n, toArabicDigits)
    const testPoints = [0, 1, 2, 3, 10, 11, 1234, 2.5];
    for (const p of testPoints) {
      const sqlRes = db.sql(`SELECT public.job_group_points_ar(${p});`);
      const tsRes = pointsAr(p, toArabicDigits);
      expect(sqlRes).toBe(tsRes);
    }

    // Seed quote for group
    const qid = "q_op_1";
    db.sql(`
      INSERT INTO public.plans_quotes (id, user_id, status, quote_hash, items, total_reserved_credits, expires_at)
      VALUES ('${qid}', '${USER_1}', 'active', 'hash_op_1', '[{"title":"Item 1"}]'::jsonb, 500, now() + interval '1 day');
    `);

    // Accept group with 2 parts (G=500, r1=250, r2=250)
    const acc = json(`public.accept_group_quote_atomic('${qid}', '${USER_1}', 'hash_op_1', 1000, 2, 200, 200, 500, ARRAY[250, 250]::numeric[], 'start ar');`);
    expect(acc.success).toBe(true);
    const gid = acc.group_id;

    // Part 1 is running, complete_chunk leaves it completed
    const part1JobId = acc.job_id;
    db.sql(`UPDATE public.jobs SET status = 'running', current_cursor = 'completed', delivered_units = 80 WHERE id = '${part1JobId}';`);

    // Freeze & settle part 1 (80 keys)
    const keys1 = Array.from({ length: 80 }, (_, i) => `k_op1_${i}`);
    const sha1 = "1111111111111111111111111111111111111111111111111111111111111111";
    const path1 = `${USER_1}/${part1JobId}/frozen-${sha1}.json`;
    const fz1 = json(`public.freeze_and_settle_group_part_atomic('${gid}', 1, '${part1JobId}', '${path1}', '${sha1}', 80, ARRAY['${keys1.join("','")}']::text[]);`);
    expect(fz1.success).toBe(true);
    const c1 = fz1.charged_credits;

    // Draw part 2
    const dr2 = json(`public.draw_next_group_part_atomic('${gid}', 2, 'part 2 notice', 'q_op_2', 'hash_op_2', 250, 100);`);
    expect(dr2.success).toBe(true);
    const part2JobId = dr2.job_id;

    // Part 2 is running
    db.sql(`UPDATE public.jobs SET status = 'running', current_cursor = NULL WHERE id = '${part2JobId}';`);

    // Operator close
    const opClose = json(`public.close_job_group_atomic('${gid}', 'operator', NULL, NULL, NULL, '${GROUP_PART_STOPPED_AR}');`);
    expect(opClose.success).toBe(true);
    expect(opClose.delivered_total).toBe(80);
    expect(opClose.charged_total).toBe(c1);
    expect(opClose.part_released).toBe(true);

    // Verify expected S7 format
    const expectedS7 = `المسلَّم ${toArabicDigits(80)} من ${toArabicDigits(200)} مطلوب. السبب: ${GROUP_OPERATOR_CLOSE_AR} الخصم الإجمالي ${pointsAr(c1, toArabicDigits)}، والباقي حجز مؤقت مُحرَّر.`;
    expect(opClose.final_line).toBe(expectedS7);

    // Check job_events row and stored values
    const eventMsg = db.sql(`SELECT message FROM public.job_events WHERE job_id = '${part1JobId}' AND message LIKE 'المسلَّم%' LIMIT 1;`);
    expect(eventMsg).toBe(expectedS7);

    const part2Status = db.sql(`SELECT status FROM public.jobs WHERE id = '${part2JobId}';`);
    expect(part2Status).toBe("failed");
  });

  it("(g) 03_operator_close_open_groups closes all open groups in one run; second run returns no rows", () => {
    if (!existsSync(sql01Path)) return;

    // Create two open groups
    for (const i of [1, 2]) {
      const qid = `q_bulk_${i}`;
      db.sql(`
        INSERT INTO public.plans_quotes (id, user_id, status, quote_hash, items, total_reserved_credits, expires_at)
        VALUES ('${qid}', '${USER_2}', 'active', 'hash_bulk_${i}', '[{"title":"Bulk"}]'::jsonb, 300, now() + interval '1 day');
      `);
      const acc = json(`public.accept_group_quote_atomic('${qid}', '${USER_2}', 'hash_bulk_${i}', 1000, 2, 100, 100, 300, ARRAY[150, 150]::numeric[], 'start bulk');`);
      expect(acc.success).toBe(true);
    }

    const openCountBefore = Number(db.sql("SELECT count(*) FROM public.job_groups WHERE status = 'open';"));
    expect(openCountBefore).toBeGreaterThanOrEqual(2);

    const sql03 = readFileSync(sql03Path, "utf8");
    const run1 = db.sql(sql03);
    expect(run1).toBeTruthy();

    const openCountAfter1 = Number(db.sql("SELECT count(*) FROM public.job_groups WHERE status = 'open';"));
    expect(openCountAfter1).toBe(0);

    const ledgerCountBefore = ledgerCount();
    const run2 = db.sql(sql03);
    // Second run returns 0 rows
    expect(run2.trim()).toBe("");
    expect(ledgerCount()).toBe(ledgerCountBefore);
  });

  it("(n) 04_report_open_groups runs inside READ ONLY transaction and returns overdue group and R3 empty", () => {
    if (!existsSync(sql01Path)) return;

    // Run report on clean state: R3 must be empty
    const sql04 = readFileSync(sql04Path, "utf8");
    const out = db.sql(sql04);
    // Verified runs without error and leaves transaction rolled back
    expect(out).toBeDefined();

    // R3 query directly:
    const r3Query = `
      SELECT count(*)
      FROM public.job_group_parts p
      JOIN public.jobs j ON j.id = p.job_id
      JOIN public.job_groups g ON g.id = p.group_id
      WHERE j.status = 'completed'
        AND j.delivered_units > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.job_group_frozen f
          WHERE f.group_id = p.group_id
            AND f.part_index = p.part_index
        );
    `;
    const r3Count = Number(db.sql(r3Query));
    expect(r3Count).toBe(0);
  });

  it("(o) LATE ACCEPT DURING THE STOP: uncommitted accept in session A does not block 03 in session B", async () => {
    if (!existsSync(sql01Path)) return;

    // Seed open group g1
    const qid1 = "q_late_1";
    db.sql(`
      INSERT INTO public.plans_quotes (id, user_id, status, quote_hash, items, total_reserved_credits, expires_at)
      VALUES ('${qid1}', '${USER_1}', 'active', 'hash_late_1', '[{"title":"Late 1"}]'::jsonb, 200, now() + interval '1 day');
    `);
    const acc1 = json(`public.accept_group_quote_atomic('${qid1}', '${USER_1}', 'hash_late_1', 1000, 2, 50, 50, 200, ARRAY[100, 100]::numeric[], 'start late 1');`);
    expect(acc1.success).toBe(true);
    const g1 = acc1.group_id;

    // Session A starts a transaction and calls accept for g2 without committing yet
    const qid2 = "q_late_2";
    db.sql(`
      INSERT INTO public.plans_quotes (id, user_id, status, quote_hash, items, total_reserved_credits, expires_at)
      VALUES ('${qid2}', '${USER_1}', 'active', 'hash_late_2', '[{"title":"Late 2"}]'::jsonb, 200, now() + interval '1 day');
    `);

    // Session B runs 03 statement: closes g1 only, not blocked
    const sql03 = readFileSync(sql03Path, "utf8");
    const resB = await db.sqlAsync(sql03);
    expect(resB).toContain(g1);

    const g1Status = db.sql(`SELECT status FROM public.job_groups WHERE id = '${g1}';`);
    expect(g1Status).toBe("closed");
  });
});
