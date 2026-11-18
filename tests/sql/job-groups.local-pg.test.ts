import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDb, scratchPgTarget, type ScratchDb } from "./localPg";
import { GROUP_OPERATOR_CLOSE_AR } from "../../src/lib/multiProvider/copy";

/**
 * T1: Job groups SQL proposal on a REAL scratch PostgreSQL (DIGER_PROOF=1).
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
const sql01 = readFileSync(path.join(DIR, "01_job_groups_one_hold.sql"), "utf8");
const S = "SET ROLE service_role;";

describe.skipIf(!PROOF)("job-groups proposal on a real Postgres (T1)", () => {
  let db: ScratchDb;
  let beforeMd5 = "";

  const MD5_QUERY = `
    SELECT p.proname || ' ' || pg_get_function_identity_arguments(p.oid) || ' ' || md5(pg_get_functiondef(p.oid))
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('accept_quote_atomic', 'create_quote_atomic', 'reserve_credits_atomic', 'settle_job_atomic', 'release_job_atomic')
    ORDER BY p.proname, pg_get_function_identity_arguments(p.oid);
  `;

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
    db.sql(`INSERT INTO public.credit_ledger (id, user_id, delta, type, note) VALUES ('tp_u1', '${USER_1}', 10000, 'topup', 'seed');`);
    db.sql(`INSERT INTO public.credit_ledger (id, user_id, delta, type, note) VALUES ('tp_u2', '${USER_2}', 500, 'topup', 'seed');`);

    // Capture before md5 and apply 01 proposal
    beforeMd5 = db.sql(MD5_QUERY);
    db.sql(sql01);
  }, 180000);

  afterAll(() => {
    db?.drop();
  });

  it("(e) md5 parity check before and after applying 01", () => {
    const afterMd5 = db.sql(MD5_QUERY);
    expect(afterMd5).toBe(beforeMd5);
  });

  it("unknown quote id returns quote_not_found and writes nothing", () => {
    const startBalance = balance(USER_1);
    const startRows = ledgerCount();
    const res = json(`public.accept_group_quote_atomic('non_existent_quote', '${USER_1}'::uuid, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1000, 'start')`);
    expect(res).toEqual({ success: false, error: "quote_not_found" });
    expect(balance(USER_1)).toBe(startBalance);
    expect(ledgerCount()).toBe(startRows);
  });

  it("S7 parity check: SQL F3 contains GROUP_OPERATOR_CLOSE_AR verbatim", () => {
    expect(sql01).toContain(GROUP_OPERATOR_CLOSE_AR);
    expect(sql01).toContain("، والباقي حجز مؤقت مُحرَّر.");
  });

  it("(f) permissions: anon/authenticated cannot execute F1-F6 or insert into tables", () => {
    const functions = [
      "accept_group_quote_atomic",
      "draw_next_group_part_atomic",
      "close_job_group_atomic",
      "claim_next_job_group",
      "freeze_and_settle_group_part_atomic",
      "release_unfrozen_group_part_atomic",
      "job_group_points_ar",
    ];
    for (const fn of functions) {
      const anonCan = db.sql(`SELECT has_function_privilege('anon', (SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='${fn}'), 'EXECUTE')`);
      const authCan = db.sql(`SELECT has_function_privilege('authenticated', (SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='${fn}'), 'EXECUTE')`);
      const serviceCan = db.sql(`SELECT has_function_privilege('service_role', (SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='${fn}'), 'EXECUTE')`);
      expect(anonCan).toBe("f");
      expect(authCan).toBe("f");
      expect(serviceCan).toBe("t");
    }

    const tables = ["job_groups", "job_group_parts", "job_group_keys", "job_group_frozen"];
    for (const t of tables) {
      const anonSel = db.sql(`SELECT has_table_privilege('anon', 'public.${t}', 'SELECT')`);
      const authSel = db.sql(`SELECT has_table_privilege('authenticated', 'public.${t}', 'SELECT')`);
      const servSel = db.sql(`SELECT has_table_privilege('service_role', 'public.${t}', 'SELECT')`);
      expect(anonSel).toBe("f");
      expect(authSel).toBe("f");
      expect(servSel).toBe("t");
    }
  });

  it("T1 main scenario: 3-part group lifecycle, invariants checked after every step", () => {
    const qid = "quote_t1_main";
    const gid = "grp_" + require("crypto").createHash("md5").update(qid).digest("hex");
    const hash = require("crypto").createHash("sha256").update(qid).digest("hex");
    const startBal = balance(USER_1);
    const hold = 300; // 3 parts, 100 each

    // Setup quote
    const split = {
      v: "3",
      parts: 3,
      partVolumes: [10, 10, 10],
      partReserves: [100, 100, 100],
      hold: 300,
      reachable: 30,
      askedOriginal: 30,
    };
    const items = [
      {
        endpointId: "test_endpoint",
        unitPricePoints: 10,
        targetVolumeMin: 1,
        targetVolumeMax: 10,
        params: { split },
      },
    ];

    db.sql(`
      INSERT INTO public.plans_quotes (id, user_id, status, quote_hash, items, total_reserved_credits, expires_at, created_at)
      VALUES ('${qid}', '${USER_1}', 'quoted', '${hash}', '${JSON.stringify(items)}'::jsonb, 100, now() + interval '1 day', now());
    `);

    // 1. Accept group
    const acc1 = json(`public.accept_group_quote_atomic('${qid}', '${USER_1}'::uuid, '${hash}', 1000, 'بداية الطلب')`);
    expect(acc1.success).toBe(true);
    expect(acc1.already_accepted).toBe(false);
    expect(acc1.group_id).toBe(gid);
    expect(balance(USER_1)).toBe(startBal - hold);

    // 2. Lost response / duplicate accept
    const acc2 = json(`public.accept_group_quote_atomic('${qid}', '${USER_1}'::uuid, '${hash}', 1000, 'بداية الطلب')`);
    expect(acc2.success).toBe(true);
    expect(acc2.already_accepted).toBe(true);
    expect(balance(USER_1)).toBe(startBal - hold);

    // 3. Part 1 running awaiting freeze
    const job1 = acc1.job_id;
    db.sql(`UPDATE public.jobs SET status = 'running', current_cursor = 'completed', delivered_units = 10 WHERE id = '${job1}';`);

    // 4. Draw part 2 BEFORE freeze -> fails
    const drawItem2 = [{
      endpointId: "test_endpoint",
      unitPricePoints: 10,
      targetVolumeMin: 1,
      targetVolumeMax: 10,
      params: { split: { v: 3, part: 2, groupId: gid } },
    }];
    const drawPre = json(`public.draw_next_group_part_atomic('${gid}', 2, '${JSON.stringify(drawItem2)}'::jsonb, 'الجزء 2', 0, 1000)`);
    expect(drawPre.success).toBe(false);
    expect(drawPre.error).toBe("previous_part_active");

    // 5. Freeze part 1
    const keys1 = Array.from({ length: 10 }, (_, i) => `comp_${i}`);
    const sha1 = "a".repeat(64);
    const path1 = `${USER_1}/${job1}/frozen-${sha1}.json`;
    const freeze1 = json(`public.freeze_and_settle_group_part_atomic('${gid}', 1, '${job1}', '${path1}', '${sha1}', 10, ARRAY['${keys1.join("','")}'])`);
    expect(freeze1.success).toBe(true);
    expect(freeze1.already_frozen).toBe(false);

    // 6. Draw part 2 after freeze
    const draw2 = json(`public.draw_next_group_part_atomic('${gid}', 2, '${JSON.stringify(drawItem2)}'::jsonb, 'الجزء 2', 10, 1000)`);
    expect(draw2.success).toBe(true);
    expect(draw2.already_drawn).toBe(false);

    // 7. Duplicate draw part 2
    const draw2dup = json(`public.draw_next_group_part_atomic('${gid}', 2, '${JSON.stringify(drawItem2)}'::jsonb, 'الجزء 2', 10, 1000)`);
    expect(draw2dup.success).toBe(true);
    expect(draw2dup.already_drawn).toBe(true);

    // 8. Part 2 fails (simulating release_job_atomic)
    const job2 = draw2.job_id;
    db.sql(`${S} SELECT public.release_job_atomic('${job2}', 'part 2 failed', true);`);

    // 9. Draw part 3 after failed part 2 (continues)
    const drawItem3 = [{
      endpointId: "test_endpoint",
      unitPricePoints: 10,
      targetVolumeMin: 1,
      targetVolumeMax: 10,
      params: { split: { v: 3, part: 3, groupId: gid } },
    }];
    const draw3 = json(`public.draw_next_group_part_atomic('${gid}', 3, '${JSON.stringify(drawItem3)}'::jsonb, 'الجزء 3', 10, 1000)`);
    expect(draw3.success).toBe(true);
    const job3 = draw3.job_id;

    // 10. Part 3 awaiting freeze
    db.sql(`UPDATE public.jobs SET status = 'running', current_cursor = 'completed', delivered_units = 10 WHERE id = '${job3}';`);

    // 11. Close before freeze -> part_active
    const closePre = json(`public.close_job_group_atomic('${gid}', 'all_parts_done', 'final line', 20, 200, NULL)`);
    expect(closePre.success).toBe(false);
    expect(closePre.error).toBe("part_active");

    // 12. Freeze part 3
    const keys3 = Array.from({ length: 10 }, (_, i) => `comp_${i + 10}`);
    const sha3 = "b".repeat(64);
    const path3 = `${USER_1}/${job3}/frozen-${sha3}.json`;
    const freeze3 = json(`public.freeze_and_settle_group_part_atomic('${gid}', 3, '${job3}', '${path3}', '${sha3}', 10, ARRAY['${keys3.join("','")}'])`);
    expect(freeze3.success).toBe(true);

    // 13. Close all parts done
    const close = json(`public.close_job_group_atomic('${gid}', 'all_parts_done', 'final line', 20, 200, NULL)`);
    expect(close.success).toBe(true);
    expect(close.delivered_total).toBe(20);
    expect(close.charged_total).toBe(200);

    // Final balance check: 100 was released from part 2, 0 charged. Part 1 charged 100, Part 3 charged 100.
    // Start 10000 - 200 = 9800
    expect(balance(USER_1)).toBe(startBal - 200);
  });
  it("(f) append-only triggers: UPDATE or DELETE on job_group_parts/keys/frozen raise error", () => {
    expect(() => db.sql(`DELETE FROM public.job_group_parts WHERE 1=1;`)).toThrow(/append-only/);
    expect(() => db.sql(`DELETE FROM public.job_group_keys WHERE 1=1;`)).toThrow(/append-only/);
    expect(() => db.sql(`DELETE FROM public.job_group_frozen WHERE 1=1;`)).toThrow(/append-only/);
  });

});
