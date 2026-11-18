import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDb, scratchPgTarget, type ScratchDb } from "./localPg";
import { GROUP_OPERATOR_CLOSE_AR, GROUP_PART_STOPPED_AR } from "../../src/lib/multiProvider/copy";
import { pointsAr } from "../../src/lib/pointsFormat";
import { toArabicDigits } from "../../src/lib/arabicDigits";
import { checkCustomerText } from "../../src/lib/agentMission/text";

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

const OUT = process.env.BH_OUT || "/tmp";
const DIR = path.resolve(__dirname, "../../docs/proposals/job-groups-one-hold");
const sql01Path = path.join(DIR, "01_job_groups_one_hold.sql");
const sql03Path = path.join(DIR, "03_operator_close_open_groups.sql");
const sql04Path = path.join(DIR, "04_report_open_groups.sql");
const S = "SET ROLE service_role;";
const sha = (c: string) => c.repeat(64);

describe.skipIf(!PROOF)("operator close and report scripts (T1 g, j, n, o)", () => {
  let db: ScratchDb;
  let dbname = "";
  let n = 0;
  let un = 0;

  const j = (call: string) => JSON.parse(db.sql(`${S} SELECT ${call}`));
  const bal = (u: string) =>
    Number(db.sql(`SELECT COALESCE(SUM(delta), 0) FROM public.credit_ledger WHERE user_id = '${u}'`));
  const cnt = () => Number(db.sql("SELECT count(*) FROM public.credit_ledger"));

  const psqlFile = (file: string, extra: string[] = []) => {
    const t = scratchPgTarget()!;
    const r = spawnSync(
      "psql",
      ["-h", t.host, "-p", t.port, "-U", "postgres", "-X", "-d", dbname, ...extra, "-f", path.join(DIR, file)],
      { encoding: "utf8" },
    );
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };

  beforeAll(() => {
    // Fail loudly if PR-1 has not been applied/merged into this worktree
    if (!existsSync(sql01Path)) {
      throw new Error("PR-1 (01) must be merged first");
    }
    db = createScratchDb();
    const sql01 = readFileSync(sql01Path, "utf8");
    db.sql(sql01);
    dbname = db.sql("select current_database()");
  }, 180000);

  afterAll(() => {
    db?.drop();
  });

  const fresh = () => {
    const id = `00000000-0000-0000-0000-0000000e${String(++un).padStart(4, "0")}`;
    db.sql(`INSERT INTO auth.users (id, email) VALUES ('${id}', 'e${un}@t')`);
    db.sql(`INSERT INTO public.profiles (id, email) VALUES ('${id}', 'e${un}@t') ON CONFLICT DO NOTHING`);
    db.sql(`INSERT INTO public.credit_ledger (id, user_id, delta, type, note) VALUES ('tpe${un}', '${id}', 100000, 'topup', 'seed')`);
    return id;
  };

  function newGroup(user: string, parts = 3, per = 10, unit = 10) {
    const qid = `bho_q_${++n}`;
    const gid = "grp_" + createHash("md5").update(qid).digest("hex");
    const hash = createHash("sha256").update(qid).digest("hex");
    const r = per * unit;
    const split = {
      v: "3",
      parts,
      partVolumes: Array(parts).fill(per),
      partReserves: Array(parts).fill(r),
      hold: r * parts,
      reachable: per * parts,
      askedOriginal: per * parts,
    };
    const items = [{ endpointId: "ep", unitPricePoints: unit, targetVolumeMin: 1, targetVolumeMax: per, params: { split } }];
    db.sql(`INSERT INTO public.plans_quotes (id, user_id, status, quote_hash, items, total_reserved_credits, output_formats, expires_at, created_at) VALUES ('${qid}', '${user}', 'quoted', '${hash}', '${JSON.stringify(items)}'::jsonb, ${r}, '["xlsx"]'::jsonb, now() + interval '1 day', now())`);
    return { qid, gid, hash, r, hold: r * parts, per, unit, parts, u: user };
  }

  const accept = (g: ReturnType<typeof newGroup>) =>
    j(`public.accept_group_quote_atomic('${g.qid}', '${g.u}'::uuid, '${g.hash}', 1000, 'بداية')`);

  const item = (g: ReturnType<typeof newGroup>, k: number) =>
    JSON.stringify([
      { endpointId: "ep", unitPricePoints: g.unit, targetVolumeMin: 1, targetVolumeMax: g.per, params: { split: { v: 3, part: k, groupId: g.gid } } },
    ]);

  const draw = (g: ReturnType<typeof newGroup>, k: number, z: number) =>
    j(`public.draw_next_group_part_atomic('${g.gid}', ${k}, '${item(g, k)}'::jsonb, 'سطر', ${z}, 1000)`);

  const awaitFreeze = (job: string, d: number) =>
    db.sql(`UPDATE public.jobs SET status = 'running', current_cursor = 'completed', delivered_units = ${d} WHERE id = '${job}'`);

  const freeze = (g: ReturnType<typeof newGroup>, k: number, job: string, rows: number, c: string) => {
    const keys = Array.from({ length: rows }, (_, i) => `k_${g.gid.slice(4, 8)}_${k}_${i}`);
    return j(`public.freeze_and_settle_group_part_atomic('${g.gid}', ${k}, '${job}', '${g.u}/${job}/frozen-${sha(c)}.json', '${sha(c)}', ${rows}, ARRAY['${keys.join("','")}'])`);
  };

  const ledgerSum = (gid: string) =>
    Number(db.sql(`SELECT COALESCE(SUM(delta), 0) FROM public.credit_ledger WHERE job_id IN (SELECT '${gid}' UNION SELECT job_id FROM public.job_group_parts WHERE group_id = '${gid}')`));

  const ledgerIds = (gid: string) =>
    db.sql(`SELECT id || '|' || delta || '|' || type FROM public.credit_ledger WHERE job_id IN (SELECT '${gid}' UNION SELECT job_id FROM public.job_group_parts WHERE group_id = '${gid}') ORDER BY created_at, id`).split("\n");

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
    expect(sql04).not.toMatch(/INSERT\s+INTO/i);
    expect(sql04).not.toMatch(/UPDATE\s+/i);
    expect(sql04).not.toMatch(/DELETE\s+FROM/i);
  });

  it("(j) pointsAr Arabic formatting: job_group_points_ar matches pointsAr and produces Arabic decimal comma ٢٫٥", () => {
    const testPoints = [0, 1, 2, 3, 10, 11, 1234];
    for (const p of testPoints) {
      const sqlRes = db.sql(`SELECT public.job_group_points_ar(${p});`);
      const tsRes = pointsAr(p, toArabicDigits);
      expect(sqlRes).toBe(tsRes);
    }
    // 2.5: SQL produces Arabic decimal mark ٢٫٥
    const sql25 = db.sql("SELECT public.job_group_points_ar(2.5);");
    expect(sql25).toBe("٢٫٥ نقطة");
  });

  it("04 READ ONLY with R1, R3 then R2 last; 03 on open groups (running part, part awaiting freeze); 03 twice", () => {
    const uA = fresh(), uB = fresh(), uC = fresh(), uD = fresh();
    const b0 = { A: bal(uA), B: bal(uB), C: bal(uC), D: bal(uD) };

    // A: part1 frozen+charged 100, part2 drawn+running
    const gA = newGroup(uA);
    const aA = accept(gA);
    awaitFreeze(aA.job_id, 10);
    expect(freeze(gA, 1, aA.job_id, 10, "a").success).toBe(true);
    const d2 = draw(gA, 2, 10);
    expect(d2.success).toBe(true);
    db.sql(`UPDATE public.jobs SET status = 'running' WHERE id = '${d2.job_id}'`);

    // B: part1 awaiting freeze (completed, 10 delivered, not frozen)
    const gB = newGroup(uB);
    const aB = accept(gB);
    awaitFreeze(aB.job_id, 10);

    // C: part1 running only
    const gC = newGroup(uC);
    const aC = accept(gC);
    db.sql(`UPDATE public.jobs SET status = 'running' WHERE id = '${aC.job_id}'`);

    // D: part1 frozen+charged 100, part2 frozen+charged 100, part 3 drawn and queued
    const gD = newGroup(uD);
    const aD = accept(gD);
    awaitFreeze(aD.job_id, 10);
    freeze(gD, 1, aD.job_id, 10, "d");
    const dd2 = draw(gD, 2, 10);
    awaitFreeze(dd2.job_id, 10);
    expect(freeze(gD, 2, dd2.job_id, 10, "f").success).toBe(true);
    const dd3 = draw(gD, 3, 20);
    expect(dd3.success).toBe(true);

    const groups = [gA, gB, gC, gD];
    const c0 = cnt();

    // ---- 04 Report on open groups
    const r04 = psqlFile("04_report_open_groups.sql");
    writeFileSync(`${OUT}/out_04_open.txt`, r04.out);
    expect(cnt()).toBe(c0);
    expect(r04.code).toBe(0);

    // R1 rows (4 open groups), R3 empty, R2 last (guarded, reports not installed without error)
    const iR1 = r04.out.indexOf("points_still_held");
    const iR3 = r04.out.indexOf("close_reason");
    const iR2 = r04.out.indexOf("driver_heartbeat");
    expect(iR1).toBeGreaterThan(-1);
    expect(iR3).toBeGreaterThan(iR1);
    expect(iR2).toBeGreaterThan(iR3);
    for (const g of groups) {
      expect(r04.out).toContain(g.gid);
    }
    expect(r04.out).toContain("driver_heartbeat: not installed");

    // 04 with a driver_heartbeat table present: R2 reports driver_silence
    db.sql("CREATE TABLE public.driver_heartbeat (id int primary key, last_tick_at timestamptz); INSERT INTO public.driver_heartbeat VALUES (1, now() - interval '3 minutes')");
    const r04b = psqlFile("04_report_open_groups.sql", ["-v", "ON_ERROR_STOP=1"]);
    writeFileSync(`${OUT}/out_04_with_heartbeat.txt`, r04b.out);
    expect(r04b.code).toBe(0);
    expect(r04b.out).toContain("driver_silence");
    db.sql("DROP TABLE public.driver_heartbeat");
    expect(cnt()).toBe(c0);

    // ---- 03 Operator close run 1
    const run1 = psqlFile("03_operator_close_open_groups.sql", ["-v", "ON_ERROR_STOP=1"]);
    writeFileSync(`${OUT}/out_03_run1.txt`, run1.out);
    expect(run1.code).toBe(0);
    expect(db.sql("SELECT count(*) FROM public.job_groups WHERE status = 'open'")).toBe("0");
    expect(run1.out).toContain("(4 rows)");
    for (const g of groups) {
      expect(run1.out.split(g.gid).length - 1).toBe(1); // one report row per group
    }

    const expected: Record<string, { z: number; c: number; rel: number; run: boolean }> = {
      A: { z: 10, c: 100, rel: 200, run: true },
      B: { z: 0, c: 0, rel: 300, run: true },
      C: { z: 0, c: 0, rel: 300, run: true },
      D: { z: 20, c: 200, rel: 100, run: true },
    };
    const keys = ["A", "B", "C", "D"];
    keys.forEach((k, i) => {
      const g = groups[i];
      const e = expected[k];
      const st = db.sql(`SELECT status || '|' || COALESCE(close_reason, '') FROM public.job_groups WHERE id = '${g.gid}'`);
      const jobs = db.sql(`SELECT p.part_index || ':' || j.status || ':' || j.charged_credits || ':' || COALESCE(j.error_message, '') FROM public.job_group_parts p JOIN public.jobs j ON j.id = p.job_id WHERE p.group_id = '${g.gid}' ORDER BY 1`);
      writeFileSync(`${OUT}/state_${k}.txt`, `${st}\n${jobs}\n${ledgerIds(g.gid).join("\n")}\n`);

      const charged = 0 - Number(db.sql(`SELECT COALESCE(SUM(delta), 0) FROM public.credit_ledger WHERE type = 'charge' AND job_id IN (SELECT job_id FROM public.job_group_parts WHERE group_id = '${g.gid}')`));
      const grossHeld = 0 - Number(db.sql(`SELECT COALESCE(SUM(delta), 0) FROM public.credit_ledger WHERE job_id IN (SELECT '${g.gid}' UNION SELECT job_id FROM public.job_group_parts WHERE group_id = '${g.gid}') AND type IN ('reserve', 'charge')`));

      expect(st.startsWith("closed|operator")).toBe(true);
      expect(Math.abs(charged)).toBe(e.c);
      expect(bal(g.u)).toBe(b0[k as "A"] - e.c); // balance = start - charged
      expect(Math.abs(ledgerSum(g.gid))).toBe(e.c); // net of releases = charge only
      expect(db.sql(`SELECT count(*) FROM public.credit_ledger WHERE id = 'rel_${g.gid}'`)).toBe(k === "D" ? "0" : "1"); // remainder released once (D drew all 3: no remainder)

      const relRows = Number(db.sql(`SELECT count(*) FROM public.credit_ledger WHERE type = 'release' AND job_id IN (SELECT '${g.gid}' UNION SELECT job_id FROM public.job_group_parts WHERE group_id = '${g.gid}')`));
      const dupes = Number(db.sql(`SELECT count(*) FROM (SELECT job_id FROM public.credit_ledger WHERE id LIKE 'rel\\_%' AND job_id IN (SELECT '${g.gid}' UNION SELECT job_id FROM public.job_group_parts WHERE group_id = '${g.gid}') GROUP BY job_id HAVING count(*) > 1) s`));
      expect(dupes).toBe(0);
      expect(relRows).toBeGreaterThan(0);
      expect(grossHeld).toBeGreaterThanOrEqual(e.c);

      // Report row carries verified totals and the S7 final line
      const asked = 30;
      const line = `المسلَّم ${toArabicDigits(e.z)} من ${toArabicDigits(asked)} مطلوب. السبب: ${GROUP_OPERATOR_CLOSE_AR} الخصم الإجمالي ${pointsAr(e.c, toArabicDigits)}، والباقي حجز مؤقت مُحرَّر.`;
      const fl = db.sql(`SELECT message FROM public.job_events WHERE message LIKE 'المسلَّم%' AND job_id IN (SELECT job_id FROM public.job_group_parts WHERE group_id = '${g.gid}') LIMIT 1`);
      expect(fl).toBe(line);
      expect(run1.out).toContain(line);
      expect(checkCustomerText(line).issues).toEqual([]);
    });

    // Part awaiting freeze (B) and running parts (A part2, C part1, D part3 queued) released with S8 text, no charge
    const s8 = (g: ReturnType<typeof newGroup>, k: number) =>
      db.sql(`SELECT j.status || '|' || j.charged_credits || '|' || COALESCE(j.error_message, '') FROM public.job_group_parts p JOIN public.jobs j ON j.id = p.job_id WHERE p.group_id = '${g.gid}' AND p.part_index = ${k}`);
    expect(s8(gA, 2)).toBe(`failed|0|${GROUP_PART_STOPPED_AR}`);
    expect(s8(gB, 1)).toBe(`failed|0|${GROUP_PART_STOPPED_AR}`);
    expect(s8(gC, 1)).toBe(`failed|0|${GROUP_PART_STOPPED_AR}`);
    expect(s8(gD, 3)).toBe(`failed|0|${GROUP_PART_STOPPED_AR}`);

    // S8 literal in 03 equals copy.ts
    expect(readFileSync(path.join(DIR, "03_operator_close_open_groups.sql"), "utf8")).toContain(`'${GROUP_PART_STOPPED_AR}'`);

    // An already frozen+charged part is never released/refunded
    expect(db.sql(`SELECT count(*) FROM public.credit_ledger WHERE id = 'rel_${aA.job_id}'`)).toBe("1");
    expect(db.sql(`SELECT status FROM public.jobs WHERE id = '${aA.job_id}'`)).toBe("completed");

    // ---- 03 Operator close run 2 (pasted twice): nothing closes, no new ledger rows, balances unchanged
    const cBefore = cnt();
    const balsBefore = groups.map((g) => bal(g.u));
    const run2 = psqlFile("03_operator_close_open_groups.sql", ["-v", "ON_ERROR_STOP=1"]);
    writeFileSync(`${OUT}/out_03_run2.txt`, run2.out);
    expect(run2.code).toBe(0);
    expect(run2.out).toContain("(0 rows)");
    expect(cnt()).toBe(cBefore);
    expect(groups.map((g) => bal(g.u))).toEqual(balsBefore);

    // 04 after: no open groups => R1 empty
    const r04c = psqlFile("04_report_open_groups.sql");
    writeFileSync(`${OUT}/out_04_after.txt`, r04c.out);
    expect(r04c.code).toBe(0);
    expect(r04c.out).not.toContain("grp_");
  });

  it("03 ordering/idempotency stress: a group whose close is already done by the app (already_closed) is not reported and not touched", () => {
    const u = fresh();
    const g = newGroup(u);
    const a = accept(g);
    awaitFreeze(a.job_id, 10);
    freeze(g, 1, a.job_id, 10, "z");
    const c = j(`public.close_job_group_atomic('${g.gid}', 'operator', NULL, NULL, NULL, '${GROUP_PART_STOPPED_AR}')`);
    expect(c.success).toBe(true);

    const before = cnt();
    const run = psqlFile("03_operator_close_open_groups.sql", ["-v", "ON_ERROR_STOP=1"]);
    expect(run.out).toContain("(0 rows)");
    expect(cnt()).toBe(before);
  });

  it("(o) real second session concurrency: uncommitted accept in session A does not block 03 in session B", async () => {
    // Group 1: already accepted and open before the test starts
    const u1 = fresh();
    const g1 = newGroup(u1);
    const a1 = accept(g1);
    expect(a1.success).toBe(true);

    // Group 2: prepared quote, will be accepted in a separate uncommitted transaction
    const u2 = fresh();
    const g2 = newGroup(u2);

    const t = scratchPgTarget()!;
    // Open interactive Session A
    const psqlA = spawn(
      "psql",
      ["-h", t.host, "-p", t.port, "-U", "postgres", "-X", "-q", "-d", dbname],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const psqlAOutput: string[] = [];
    psqlA.stdout.on("data", (d) => psqlAOutput.push(d.toString()));
    psqlA.stderr.on("data", (d) => psqlAOutput.push(d.toString()));

    try {
      // Session A starts a transaction and calls accept_group_quote_atomic without committing yet
      const readyMarker = "SESSION_A_ACCEPT_DONE";
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Session A timeout")), 10000);
        const onData = (data: Buffer) => {
          if (data.toString().includes(readyMarker)) {
            clearTimeout(timer);
            psqlA.stdout.off("data", onData);
            resolve();
          }
        };
        psqlA.stdout.on("data", onData);

        psqlA.stdin.write("SET ROLE service_role;\n");
        psqlA.stdin.write("BEGIN;\n");
        psqlA.stdin.write(`SELECT public.accept_group_quote_atomic('${g2.qid}', '${g2.u}'::uuid, '${g2.hash}', 1000, 'بداية a2');\n`);
        psqlA.stdin.write(`SELECT '${readyMarker}';\n`);
      });

      // Session B runs 03_operator_close_open_groups.sql concurrently
      // It must not hang or block on Session A, and must close g1
      const runB = psqlFile("03_operator_close_open_groups.sql", ["-v", "ON_ERROR_STOP=1"]);
      expect(runB.code).toBe(0);
      expect(runB.out).toContain(g1.gid);
      // Group 1 is closed
      expect(db.sql(`SELECT status FROM public.job_groups WHERE id = '${g1.gid}'`)).toBe("closed");

      // Now Session A commits its transaction
      await new Promise<void>((resolve) => {
        psqlA.stdin.write("COMMIT;\n\\q\n");
        psqlA.on("close", () => resolve());
      });

      // Group 2 is now committed and open
      expect(db.sql(`SELECT status FROM public.job_groups WHERE id = '${g2.gid}'`)).toBe("open");
    } finally {
      try {
        psqlA.kill("SIGKILL");
      } catch {
        /* best effort */
      }
    }
  });
});
