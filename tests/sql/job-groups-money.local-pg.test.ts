import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDb, type ScratchDb } from "./localPg";
import { GROUP_OPERATOR_CLOSE_AR, GROUP_PART_STOPPED_AR, GROUP_PART_UNFROZEN_RELEASED_AR, groupFinalLineAr, groupDrawLineAr, groupStartLineAr } from "../../src/lib/multiProvider/copy";
import { pointsAr } from "../../src/lib/pointsFormat";
import { toArabicDigits } from "../../src/lib/arabicDigits";
import { checkCustomerText } from "../../src/lib/agentMission/text";

/**
 * Money proof on a REAL scratch PostgreSQL (DIGER_PROOF=1).
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
const U1 = "00000000-0000-0000-0000-000000000001", U2 = "00000000-0000-0000-0000-000000000002";
const sha = (c: string) => c.repeat(64);

describe.skipIf(!PROOF)("BH money proof", () => {
  let db: ScratchDb; let n = 0;
  const j = (call: string) => JSON.parse(db.sql(`${S} SELECT ${call}`));
  const bal = (u: string) => Number(db.sql(`SELECT COALESCE(SUM(delta),0) FROM public.credit_ledger WHERE user_id='${u}'`));
  const ledger = (like: string) => db.sql(`SELECT id||'|'||delta||'|'||type||'|'||COALESCE(job_id,'')||'|'||COALESCE(note,'') FROM public.credit_ledger WHERE id LIKE '${like}' ORDER BY id`).split("\n").filter(Boolean);
  const cnt = () => Number(db.sql("SELECT count(*) FROM public.credit_ledger"));
  beforeAll(() => {
    db = createScratchDb(); db.sql(sql01);
    db.sql(`INSERT INTO auth.users (id,email) VALUES ('${U1}','u1@t'),('${U2}','u2@t') ON CONFLICT DO NOTHING;`);
    db.sql("INSERT INTO public.profiles (id,email) SELECT id,email FROM auth.users ON CONFLICT DO NOTHING;");
    db.sql(`INSERT INTO public.credit_ledger (id,user_id,delta,type,note) VALUES ('tp1','${U1}',100000,'topup','seed'),('tp2','${U2}',50,'topup','seed')`);
  }, 180000);
  afterAll(() => db?.drop());

  let un = 0;
  const fresh = () => { const id = `00000000-0000-0000-0000-0000000f${String(++un).padStart(4, "0")}`; db.sql(`INSERT INTO auth.users (id,email) VALUES ('${id}','f${un}@t') ON CONFLICT DO NOTHING;`); db.sql(`INSERT INTO public.profiles (id,email) VALUES ('${id}','f${un}@t') ON CONFLICT DO NOTHING;`); db.sql(`INSERT INTO public.credit_ledger (id,user_id,delta,type,note) VALUES ('tpf${un}','${id}',100000,'topup','seed')`); return id; };
  function newGroup(user: string, parts = 3, per = 10, unit = 10) {
    const qid = `bh_q_${++n}`; const gid = "grp_" + createHash("md5").update(qid).digest("hex");
    const hash = createHash("sha256").update(qid).digest("hex"); const r = per * unit;
    const split = { v: "3", parts, partVolumes: Array(parts).fill(per), partReserves: Array(parts).fill(r), hold: r * parts, reachable: per * parts, askedOriginal: per * parts };
    const items = [{ endpointId: "ep", unitPricePoints: unit, targetVolumeMin: 1, targetVolumeMax: per, params: { split } }];
    db.sql(`INSERT INTO public.plans_quotes (id,user_id,status,quote_hash,items,total_reserved_credits,output_formats,expires_at,created_at) VALUES ('${qid}','${user}','quoted','${hash}','${JSON.stringify(items)}'::jsonb,${r},'["xlsx"]'::jsonb,now()+interval '1 day',now())`);
    return { qid, gid, hash, r, hold: r * parts, per, unit, parts, u: user };
  }
  const accept = (g: ReturnType<typeof newGroup>, user = g.u) => j(`public.accept_group_quote_atomic('${g.qid}','${user}'::uuid,'${g.hash}',1000,'بداية')`);
  const item = (g: any, k: number) => JSON.stringify([{ endpointId: "ep", unitPricePoints: g.unit, targetVolumeMin: 1, targetVolumeMax: g.per, params: { split: { v: 3, part: k, groupId: g.gid } } }]);
  const draw = (g: any, k: number, z: number) => j(`public.draw_next_group_part_atomic('${g.gid}',${k},'${item(g, k)}'::jsonb,'سطر',${z},1000)`);
  const awaitFreeze = (job: string, delivered: number) => db.sql(`UPDATE public.jobs SET status='running', current_cursor='completed', delivered_units=${delivered} WHERE id='${job}'`);
  const freeze = (g: any, k: number, job: string, rows: number, c: string, uid = g.u) => {
    const keys = Array.from({ length: rows }, (_, i) => `k_${g.gid.slice(4, 8)}_${k}_${i}`);
    return j(`public.freeze_and_settle_group_part_atomic('${g.gid}',${k},'${job}','${uid}/${job}/frozen-${sha(c)}.json','${sha(c)}',${rows},ARRAY['${keys.join("','")}'])`);
  };
  const closeG = (g: any, reason: string, line: string | null, z: number | null, c: number | null, rel: string | null) =>
    j(`public.close_job_group_atomic('${g.gid}','${reason}',${line === null ? "NULL" : `'${line}'`},${z === null ? "NULL" : z},${c === null ? "NULL" : c},${rel === null ? "NULL" : `'${rel}'`})`);

  it("S1 accept: exactly one hold (res_grp), one transfer (gdr_), one part reserve (res_job); balance -hold; second call is idempotent", () => {
    const g = newGroup(U1); const b0 = bal(U1); const c0 = cnt();
    const a = accept(g); expect(a.success).toBe(true);
    expect(cnt() - c0).toBe(3);
    expect(bal(U1)).toBe(b0 - g.hold);
    expect(ledger(`%${g.gid}`)).toEqual([`res_${g.gid}|-${g.hold}.00|reserve|${g.gid}|حجز رصيد الطلب كاملًا لكل أجزائه`].map((s) => s.replace(".00", "")).map((s) => s) ?? []);
  });
  it("S1b ledger rows of an accept are exactly the three the plan lists", () => {
    const g = newGroup(U1); const a = accept(g); const job = a.job_id;
    const rows = db.sql(`SELECT id||'|'||delta||'|'||type||'|'||COALESCE(job_id,'') FROM public.credit_ledger WHERE id IN ('res_${g.gid}','gdr_${job}','res_${job}') ORDER BY id`).split("\n");
    expect(rows.length).toBe(3);
    const s = rows.join("\n"); expect(s).toContain(`res_${g.gid}|-${g.hold}`); expect(s).toContain(`gdr_${job}|${g.r}`); expect(s).toContain(`res_${job}|-${g.r}`);
    const b = bal(U1); const again = accept(g); expect(again.already_accepted).toBe(true); expect(bal(U1)).toBe(b);
    expect(Number(db.sql(`SELECT count(*) FROM public.credit_ledger WHERE job_id='${g.gid}'`))).toBe(2); // res_grp + gdr_ (job_id = group)
  });
  it("S2 insufficient balance / hash mismatch / wrong user / expired / not quoted: refused, NOTHING written", () => {
    const g = newGroup(U2); const c0 = cnt(); const rows0 = Number(db.sql("SELECT count(*) FROM public.job_groups"));
    expect(j(`public.accept_group_quote_atomic('${g.qid}','${U2}'::uuid,'${g.hash}',1000,'x')`).error).toBe("insufficient_balance");
    expect(j(`public.accept_group_quote_atomic('${g.qid}','${U2}'::uuid,'${"0".repeat(64)}',1000,'x')`).error).toBe("quote_hash_mismatch");
    expect(j(`public.accept_group_quote_atomic('${g.qid}','${U1}'::uuid,'${g.hash}',1000,'x')`).error).toBe("quote_user_mismatch");
    expect(j(`public.accept_group_quote_atomic('no_such','${U1}'::uuid,'${g.hash}',1000,'x')`).error).toBe("quote_not_found");
    expect(j(`public.accept_group_quote_atomic('${g.qid}','${U2}'::uuid,'${g.hash}',50,'x')`).error).toBe("invalid_group_plan"); // part reserve 100 > cap 50
    expect(cnt()).toBe(c0); expect(Number(db.sql("SELECT count(*) FROM public.job_groups"))).toBe(rows0);
    expect(db.sql(`SELECT status FROM public.plans_quotes WHERE id='${g.qid}'`)).toBe("quoted");
  });
  it("S3 full lifecycle with partial delivery: charge only in F5 (LEAST), failed part released once, unfrozen halt, ledger net = -charged, no double release, everything idempotent", () => {
    const g = newGroup(fresh(), 3, 10, 10); const b0 = bal(g.u);
    const a = accept(g); const j1 = a.job_id; awaitFreeze(j1, 7);
    expect(draw(g, 2, 0).error).toBe("previous_part_active");
    const f1 = freeze(g, 1, j1, 7, "a"); expect(f1.success).toBe(true); expect(Number(f1.charged_credits)).toBe(70);
    expect(bal(g.u)).toBe(b0 - g.hold + (g.r - 70)); // hold 300 - gdr100+res100 net 0 ... part1 returns 30
    const f1b = freeze(g, 1, j1, 7, "a"); expect(f1b.already_frozen).toBe(true);
    expect(freeze(g, 1, j1, 7, "b").error).toBe("freeze_conflict");
    const d2 = draw(g, 2, 7); expect(d2.success).toBe(true); const j2 = d2.job_id;
    expect(draw(g, 2, 7).already_drawn).toBe(true);
    expect(draw(g, 4, 7).error).toBe("out_of_order");
    // part 2 fails through the existing watchdog function; twice
    const c1 = cnt(); db.sql(`${S} SELECT public.release_job_atomic('${j2}','x',true)`); db.sql(`${S} SELECT public.release_job_atomic('${j2}','x',true)`);
    expect(cnt() - c1).toBe(1); // exactly one rel_<job>
    const d3 = draw(g, 3, 7); expect(d3.success).toBe(true); const j3 = d3.job_id;
    awaitFreeze(j3, 5);
    // part 3 is unfreezable: F6 releases it, halts; F5 can no longer settle it
    const r6 = j(`public.release_unfrozen_group_part_atomic('${g.gid}',3,'${j3}','${GROUP_PART_UNFROZEN_RELEASED_AR}')`);
    expect(r6.success).toBe(true); expect(r6.already_released).toBe(false);
    expect(j(`public.release_unfrozen_group_part_atomic('${g.gid}',3,'${j3}','${GROUP_PART_UNFROZEN_RELEASED_AR}')`).already_released).toBe(true);
    expect(freeze(g, 3, j3, 5, "c").error).toBe("part_not_awaiting_freeze");
    expect(db.sql(`SELECT halted_at IS NOT NULL FROM public.job_groups WHERE id='${g.gid}'`)).toBe("t");
    // close part_unfrozen with the literal totals Z 7, C 70
    const line = groupFinalLineAr({ reason: "part_unfrozen", Z: 7, X: 30, Y: 30, C: 70 });
    expect(closeG(g, "part_unfrozen", line, 99, 70, null).error).toBe("totals_mismatch");
    expect(closeG(g, "part_unfrozen", line, 7, 999, null).error).toBe("totals_mismatch");
    const cl = closeG(g, "part_unfrozen", line, 7, 70, null); expect(cl.success).toBe(true);
    expect(Number(cl.delivered_total)).toBe(7); expect(Number(cl.charged_total)).toBe(70); expect(Number(cl.released_credits)).toBe(0);
    expect(cl.final_line).toBe(line);
    const c2 = cnt(); expect(closeG(g, "part_unfrozen", line, 7, 70, null).already_closed).toBe(true); expect(cnt()).toBe(c2);
    expect(draw(g, 4, 7).error).toBe("group_closed");
    expect(bal(g.u)).toBe(b0 - 70); // net charge only
    expect(Number(db.sql(`SELECT count(*) FROM public.credit_ledger WHERE id LIKE 'chg_%' AND job_id IN ('${j1}','${j2}','${j3}')`))).toBe(1);
    expect(Number(db.sql(`SELECT count(*) FROM public.credit_ledger WHERE id LIKE 'rel_%' AND job_id IN ('${j1}','${j2}','${j3}')`))).toBe(3);
  });
  it("S4 operator close with a remainder: rel_<gid> written once with the A3 note; S7 line in noun form; totals verified; deadline_stuck releases the running part with S8", () => {
    const g = newGroup(fresh(), 3, 10, 10); const b0 = bal(g.u);
    const a = accept(g); awaitFreeze(a.job_id, 10); expect(freeze(g, 1, a.job_id, 10, "d").success).toBe(true);
    // part 2 drawn and running (not stuck): deadline_stuck refused; operator releases it
    const d2 = draw(g, 2, 10); expect(d2.success).toBe(true);
    expect(closeG(g, "deadline_stuck", "x", 10, 100, GROUP_PART_STOPPED_AR).error).toBe("part_not_stuck");
    expect(closeG(g, "all_parts_done", "x", 10, 100, null).error).toBe("part_active");
    const op = closeG(g, "operator", null, null, null, GROUP_PART_STOPPED_AR); expect(op.success).toBe(true);
    expect(op.part_released).toBe(true); expect(Number(op.delivered_total)).toBe(10); expect(Number(op.charged_total)).toBe(100);
    expect(Number(op.released_credits)).toBe(100); // 300 hold - 200 drawn
    const expected = "المسلَّم ١٠ من ٣٠ مطلوب. السبب: " + GROUP_OPERATOR_CLOSE_AR + " الخصم الإجمالي " + pointsAr(100, toArabicDigits) + "، والباقي حجز مؤقت مُحرَّر.";
    expect(op.final_line).toBe(expected);
    expect(checkCustomerText(op.final_line).issues).toEqual([]);
    const rg = ledger(`rel_${g.gid}`); expect(rg.length).toBe(1); expect(rg[0]).toContain("باقي حجز الطلب بعد آخر جزء: حجز مؤقت مُحرَّر");
    expect(bal(g.u)).toBe(b0 - 100);
    expect(db.sql(`SELECT error_message FROM public.jobs WHERE id='${d2.job_id}'`)).toBe(GROUP_PART_STOPPED_AR);
    const c = cnt(); expect(closeG(g, "operator", null, null, null, GROUP_PART_STOPPED_AR).already_closed).toBe(true); expect(cnt()).toBe(c);
  });
  it("S5 deadline_stuck really stuck: part released with S8, no charge, remainder released", () => {
    const g = newGroup(fresh(), 3, 10, 10); const b0 = bal(g.u);
    const a = accept(g); awaitFreeze(a.job_id, 10); freeze(g, 1, a.job_id, 10, "e");
    const d2 = draw(g, 2, 10);
    db.sql(`UPDATE public.job_groups SET deadline_at = now() - interval '3 hours' WHERE id='${g.gid}'`);
    const line = groupFinalLineAr({ reason: "deadline_stuck", Z: 10, X: 30, Y: 30, C: 100 });
    const cl = closeG(g, "deadline_stuck", line, 10, 100, GROUP_PART_STOPPED_AR); console.log("S5 resp", JSON.stringify(cl)); expect(cl.success).toBe(true); expect(cl.part_released).toBe(true);
    expect(bal(g.u)).toBe(b0 - 100);
    expect(db.sql(`SELECT status||'|'||charged_credits FROM public.jobs WHERE id='${d2.job_id}'`)).toBe("failed|0");
  });
  it("S6 points helper equals copy.ts pointsAr; every Arabic literal in 01 passes the banned-forms and customer-text guards", () => {
    for (const v of [0, 1, 2, 3, 10, 11, 12, 100, 1200, 25000]) expect(db.sql(`SELECT public.job_group_points_ar(${v})`)).toBe(pointsAr(v, toArabicDigits));
    const arabic = [...sql01.matchAll(/'([^']*[؀-ۿ][^']*)'/g)].map((m) => m[1]);
    expect(arabic.length).toBeGreaterThan(5);
    const banned = ["حُرِّر", "حُرّر", "يُحرَّر", "تحرير", "استرداد", "إرجاع"];
    const hits = arabic.filter((s) => banned.some((b) => s.includes(b)));
    expect(hits).toEqual([]);
    const bad = arabic.map((s) => [s, checkCustomerText(s).issues] as const).filter(([, i]) => i.length > 0);
    expect(bad).toEqual([]);
  });
  it("S7 catalog: SECURITY DEFINER + pinned search_path + service_role only; RLS on; no policies; DROP/ALTER census", () => {
    const rows = db.sql(`SELECT proname||'|'||prosecdef||'|'||COALESCE(array_to_string(proconfig,','),'')||'|'||COALESCE((SELECT string_agg(DISTINCT (SELECT rolname FROM pg_roles WHERE oid=a.grantee), ',') FROM aclexplode(proacl) a WHERE a.privilege_type='EXECUTE'),'<null acl>') FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('accept_group_quote_atomic','draw_next_group_part_atomic','close_job_group_atomic','claim_next_job_group','freeze_and_settle_group_part_atomic','release_unfrozen_group_part_atomic','job_group_points_ar') ORDER BY 1`).split("\n");
    console.log("CATALOG\n" + rows.join("\n"));
    for (const r of rows) { expect(r).toContain("|true|"); expect(r).toContain("search_path=public, pg_temp"); }
    const rls = db.sql("SELECT relname||'|'||relrowsecurity FROM pg_class WHERE relname IN ('job_groups','job_group_parts','job_group_keys','job_group_frozen') ORDER BY 1");
    console.log("RLS\n" + rls);
    expect(db.sql("SELECT count(*) FROM pg_policies WHERE tablename LIKE 'job_group%'")).toBe("0");
  });
});
