import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertScratchPgTarget, createScratchDb, scratchPgTarget, type ScratchDb } from "./localPg";
import { GROUP_PART_UNFROZEN_RELEASED_AR, groupFinalLineAr } from "../../src/lib/multiProvider/copy";

/**
 * D-0063 proof tests (QA items 2-4) on a REAL scratch PostgreSQL (DIGER_PROOF=1).
 *  - rollback tests with scratch-only fault triggers (F5 settle failure, post-settle mismatch, F6 halt failure)
 *  - two-session race tests (plan T1 p/q/r): F6 vs watchdog, watchdog vs drive (F5), draw vs watchdog, draw vs draw;
 *    B is a separate backend and must be blocked BY A (pg_blocking_pids(B_pid) contains A_pid); every race asserts bWasBlocked
 *  - T1(o): g2 accepted during 03 is carried to its final close; T1(n): literal 04 values and an R3 row
 *  - S7: the exact function list, trigger list and RLS flags are asserted explicitly (no loop that an empty result can pass)
 * When DIGER_PROOF is unset the file is SKIPPED. With DIGER_PROOF=1 and no DIGER_TEST_PG it THROWS.
 * Refuses any host not on the scratch allowlist (unix socket dir or localhost/127.0.0.1/::1).
 * Optional scratch-only validation hooks: DIGER_PROD_FN_SQL (comma-separated SQL files applied after the migrations,
 * e.g. the production versions of create_quote_atomic and settle_job_atomic) and DIGER_PROOF_POST_SQL (applied after 01).
 */
const PROOF = process.env.DIGER_PROOF === "1";

if (PROOF) {
  const target = process.env.DIGR_TEST_PG || process.env.DIGER_TEST_PG;
  if (!target) {
    throw new Error("DIGER_PROOF=1 requires DIGER_TEST_PG to be set to a scratch PostgreSQL host:port");
  }
  assertScratchPgTarget(target);
}

const DIR = path.resolve(__dirname, "../../docs/proposals/job-groups-one-hold");
const sql01 = readFileSync(path.join(DIR, "01_job_groups_one_hold.sql"), "utf8");
const S = "SET ROLE service_role;";
const sha = (c: string) => c.repeat(64);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAULT = "bh_scratch_fault";

/** One interactive psql session: send() resolves with the output of that statement (after a marker is echoed). */
class Session {
  private p: ChildProcessWithoutNullStreams;
  private buf = "";
  private n = 0;
  private waiters: { mark: string; res: (s: string) => void }[] = [];
  all = "";
  constructor(dbname: string) {
    const t = scratchPgTarget()!;
    this.p = spawn("psql", ["-h", t.host, "-p", t.port, "-U", "postgres", "-X", "-q", "-At", "-d", dbname], { stdio: ["pipe", "pipe", "pipe"] });
    const on = (d: Buffer) => { this.buf += d.toString("utf8"); this.all += d.toString("utf8"); this.flush(); };
    this.p.stdout.on("data", on);
    this.p.stderr.on("data", on);
  }
  private flush() {
    for (;;) {
      const w = this.waiters[0];
      if (!w) return;
      const i = this.buf.indexOf(w.mark);
      if (i < 0) return;
      const out = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + w.mark.length);
      this.waiters.shift();
      w.res(out);
    }
  }
  send(sql: string): Promise<string> {
    const mark = `__DONE_${++this.n}__`;
    return new Promise((res) => {
      this.waiters.push({ mark, res });
      this.p.stdin.write(`${sql}\n\\echo ${mark}\n`);
    });
  }
  close() { try { this.p.stdin.write("\\q\n"); this.p.kill("SIGKILL"); } catch { /* best effort */ } }
}

/** Minimal CSV parser (psql --csv): quoted fields, doubled quotes, newlines inside quotes. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0] !== "");
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

function setup(): { db: ScratchDb; dbname: string } {
  const db = createScratchDb();
  for (const f of (process.env.DIGER_PROD_FN_SQL || "").split(",").filter(Boolean)) db.sql(readFileSync(f, "utf8"));
  db.sql(sql01);
  if (process.env.DIGER_PROOF_POST_SQL) db.sql(readFileSync(process.env.DIGER_PROOF_POST_SQL, "utf8"));
  return { db, dbname: db.sql("select current_database()") };
}

function kit(getDb: () => ScratchDb, getName: () => string) {
  const db = () => getDb();
  let n = 0, un = 0;
  const j = (call: string) => JSON.parse(db().sql(`${S} SELECT ${call}`));
  const bal = (u: string) => Number(db().sql(`SELECT COALESCE(SUM(delta),0) FROM public.credit_ledger WHERE user_id='${u}'`));
  const fresh = () => {
    const id = `00000000-0000-0000-0000-0000000d${String(++un).padStart(4, "0")}`;
    db().sql(`INSERT INTO auth.users (id,email) VALUES ('${id}','d${un}@t') ON CONFLICT DO NOTHING;`);
    db().sql(`INSERT INTO public.profiles (id,email) VALUES ('${id}','d${un}@t') ON CONFLICT DO NOTHING;`);
    db().sql(`INSERT INTO public.credit_ledger (id,user_id,delta,type,note) VALUES ('tpd${un}','${id}',100000,'topup','seed')`);
    return id;
  };
  type G = { qid: string; gid: string; hash: string; r: number; hold: number; per: number; unit: number; parts: number; u: string };
  function newGroup(user: string, parts = 3, per = 10, unit = 10): G {
    const qid = `proof_q_${++n}_${un}`; const gid = "grp_" + createHash("md5").update(qid).digest("hex");
    const hash = createHash("sha256").update(qid).digest("hex"); const r = per * unit;
    const split = { v: "3", parts, partVolumes: Array(parts).fill(per), partReserves: Array(parts).fill(r), hold: r * parts, reachable: per * parts, askedOriginal: per * parts };
    const items = [{ endpointId: "ep", unitPricePoints: unit, targetVolumeMin: 1, targetVolumeMax: per, params: { split } }];
    db().sql(`INSERT INTO public.plans_quotes (id,user_id,status,quote_hash,items,total_reserved_credits,output_formats,expires_at,created_at) VALUES ('${qid}','${user}','quoted','${hash}','${JSON.stringify(items)}'::jsonb,${r},'["xlsx"]'::jsonb,now()+interval '1 day',now())`);
    return { qid, gid, hash, r, hold: r * parts, per, unit, parts, u: user };
  }
  const acceptCall = (g: G) => `public.accept_group_quote_atomic('${g.qid}','${g.u}'::uuid,'${g.hash}',1000,'بداية')`;
  const accept = (g: G) => j(acceptCall(g));
  const item = (g: G, k: number) => JSON.stringify([{ endpointId: "ep", unitPricePoints: g.unit, targetVolumeMin: 1, targetVolumeMax: g.per, params: { split: { v: 3, part: k, groupId: g.gid } } }]);
  const drawCall = (g: G, k: number, z: number) => `public.draw_next_group_part_atomic('${g.gid}',${k},'${item(g, k)}'::jsonb,'سطر',${z},1000)`;
  const draw = (g: G, k: number, z: number) => j(drawCall(g, k, z));
  const awaitFreeze = (job: string, d: number) => db().sql(`UPDATE public.jobs SET status='running', current_cursor='completed', delivered_units=${d} WHERE id='${job}'`);
  const keysFor = (g: G, k: number, rows: number) => Array.from({ length: rows }, (_, i) => `k_${g.gid.slice(4, 8)}_${k}_${i}`);
  const freezeCall = (g: G, k: number, job: string, rows: number, c: string) =>
    `public.freeze_and_settle_group_part_atomic('${g.gid}',${k},'${job}','${g.u}/${job}/frozen-${sha(c)}.json','${sha(c)}',${rows},ARRAY['${keysFor(g, k, rows).join("','")}'])`;
  const freeze = (g: G, k: number, job: string, rows: number, c: string) => j(freezeCall(g, k, job, rows, c));
  const f6Call = (g: G, k: number, job: string) => `public.release_unfrozen_group_part_atomic('${g.gid}',${k},'${job}','${GROUP_PART_UNFROZEN_RELEASED_AR}')`;
  const closeCall = (g: G, reason: string, line: string | null, z: number | null, c: number | null, rel: string | null) =>
    `public.close_job_group_atomic('${g.gid}','${reason}',${line === null ? "NULL" : `'${line}'`},${z === null ? "NULL" : z},${c === null ? "NULL" : c},${rel === null ? "NULL" : `'${rel}'`})`;
  const jobIds = (g: G) => db().sql(`SELECT job_id FROM public.job_group_parts WHERE group_id='${g.gid}' ORDER BY part_index`).split("\n").filter(Boolean);
  const ledgerRows = (g: G, like: string) => db().sql(`SELECT id FROM public.credit_ledger WHERE user_id='${g.u}' AND id LIKE '${like}' ORDER BY id`).split("\n").filter(Boolean);
  const cnt = (g: G, like: string) => ledgerRows(g, like).length;
  const snap = (g: G) => JSON.parse(db().sql(`SELECT json_build_object(
    'ledger', (SELECT COALESCE(json_agg(id||':'||delta||':'||type ORDER BY id), '[]'::json) FROM public.credit_ledger WHERE user_id='${g.u}'),
    'balance', (SELECT COALESCE(SUM(delta),0) FROM public.credit_ledger WHERE user_id='${g.u}'),
    'parts', (SELECT COALESCE(json_agg(json_build_object('i',p.part_index,'job',p.job_id,'st',j.status,'cur',j.current_cursor,'del',j.delivered_units,'chg',j.charged_credits,'res',j.reserved_credits,'err',j.error_message) ORDER BY p.part_index), '[]'::json) FROM public.job_group_parts p JOIN public.jobs j ON j.id=p.job_id WHERE p.group_id='${g.gid}'),
    'frozen', (SELECT count(*) FROM public.job_group_frozen WHERE group_id='${g.gid}'),
    'keys', (SELECT count(*) FROM public.job_group_keys WHERE group_id='${g.gid}'),
    'group', (SELECT json_build_object('st',status,'halted',halted_at,'next',next_part,'drawn',drawn_credits,'reason',close_reason) FROM public.job_groups WHERE id='${g.gid}'),
    'events', (SELECT count(*) FROM public.job_events WHERE job_id IN (SELECT job_id FROM public.job_group_parts WHERE group_id='${g.gid}'))
  )`));
  /** Plan invariants (i)-(iv): one hold row, outstanding hold within [0, G], charges <= G, balance = start - held - charged, no stray ledger rows, no duplicate rel_/chg_. */
  function invariants(g: G, start: number) {
    const ids = [g.gid, ...jobIds(g)].map((x) => `'${x}'`).join(",");
    expect(cnt(g, `res\\_${g.gid}`)).toBe(1);
    const held = 0 - Number(db().sql(`SELECT COALESCE(SUM(delta),0) FROM public.credit_ledger WHERE type IN ('reserve','release') AND job_id IN (${ids})`));
    const charged = 0 - Number(db().sql(`SELECT COALESCE(SUM(delta),0) FROM public.credit_ledger WHERE type='charge' AND job_id IN (${ids})`));
    expect(held).toBeGreaterThanOrEqual(0); expect(held).toBeLessThanOrEqual(g.hold);
    expect(charged).toBeLessThanOrEqual(g.hold);
    expect(bal(g.u)).toBe(start - held - charged);
    for (const pre of ["rel", "chg"]) {
      expect(Number(db().sql(`SELECT count(*) FROM (SELECT job_id FROM public.credit_ledger WHERE id LIKE '${pre}\\_%' AND job_id IN (${ids}) GROUP BY job_id HAVING count(*) > 1) s`))).toBe(0);
    }
    return { held, charged };
  }
  /** true when backend bPid is blocked by backend aPid (pg_blocking_pids lists aPid): B-specific, not a database-wide lock-wait count. */
  const blockedBy = (bPid: number, aPid: number) => db().sql(`SELECT pg_blocking_pids(${bPid}) @> ARRAY[${aPid}]`) === "t";
  async function untilBlocked(bPid: number, aPid: number) {
    for (let i = 0; i < 60; i++) { if (blockedBy(bPid, aPid)) return; await sleep(100); }
    throw new Error(`session B (pid ${bPid}) was never blocked by session A (pid ${aPid})`);
  }
  const pidOf = async (s: Session) => Number((await s.send("SELECT pg_backend_pid();")).split("\n").pop());
  /**
   * Session A runs aCall inside an UNCOMMITTED transaction; session B (own backend pid) runs bCall and must WAIT for A: the helper requires
   * pg_blocking_pids(B_pid) to contain A_pid, and B's answer to still be pending, before A commits. EVERY race in this file is designed to
   * block B, so every test asserts r.bWasBlocked === true.
   */
  async function race(aCall: string, bCall: string): Promise<{ a: any; b: any; aRaw: string; bRaw: string; bWasBlocked: boolean; aPid: number; bPid: number }> {
    const A = new Session(getName()); const B = new Session(getName());
    try {
      await A.send(S); await B.send(S);
      const aPid = await pidOf(A); const bPid = await pidOf(B);
      expect(Number.isInteger(aPid) && Number.isInteger(bPid) && aPid !== bPid).toBe(true);
      await A.send("BEGIN;");
      const aRaw = await A.send(`SELECT ${aCall};`);
      const bP = B.send(`SELECT ${bCall};`);
      let pending = true; bP.then(() => { pending = false; });
      await untilBlocked(bPid, aPid); await sleep(200);
      const bWasBlocked = pending && blockedBy(bPid, aPid);
      await A.send("COMMIT;");
      const bRaw = await bP;
      expect(A.all + B.all).not.toMatch(/deadlock detected/i);
      const parse = (s: string) => { try { return JSON.parse(s.split("\n").filter((l) => l.startsWith("{")).pop() || "null"); } catch { return null; } };
      return { a: parse(aRaw), b: parse(bRaw), aRaw, bRaw, bWasBlocked, aPid, bPid };
    } finally { A.close(); B.close(); }
  }
  /** group with part 1 awaiting freeze (collected, not frozen). */
  function awaiting(d = 10) {
    const u = fresh(); const start = bal(u); const g = newGroup(u); const a = accept(g); awaitFreeze(a.job_id, d);
    return { g, start, job1: a.job_id as string };
  }
  return { j, bal, fresh, newGroup, accept, acceptCall, draw, drawCall, awaitFreeze, freeze, freezeCall, f6Call, closeCall, jobIds, cnt, ledgerRows, snap, invariants, race, awaiting, keysFor };
}

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!PROOF)("D-0063 rollback tests (scratch-only fault triggers)", () => {
  let db: ScratchDb; let dbname = "";
  const k = kit(() => db, () => dbname);
  beforeAll(() => { ({ db, dbname } = setup()); }, 180000);
  afterAll(() => db?.drop());
  const dropFault = (table: string) => db.sql(`DROP TRIGGER IF EXISTS ${FAULT} ON public.${table}; DROP FUNCTION IF EXISTS public.${FAULT}_fn();`);

  it("p1 F5: a settle failure rolls the whole freeze back (no rel_/chg_, no frozen row, no key, part still running); the retry then charges exactly once", () => {
    const { g, start, job1 } = k.awaiting(10);
    const before = k.snap(g);
    db.sql(`CREATE FUNCTION public.${FAULT}_fn() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.id = 'chg_${job1}' THEN RAISE EXCEPTION '${FAULT}_settle'; END IF; RETURN NEW; END $f$;
            CREATE TRIGGER ${FAULT} BEFORE INSERT ON public.credit_ledger FOR EACH ROW EXECUTE FUNCTION public.${FAULT}_fn();`);
    try {
      expect(() => k.freeze(g, 1, job1, 10, "a")).toThrow(new RegExp(`${FAULT}_settle`));
    } finally { dropFault("credit_ledger"); }
    expect(k.snap(g)).toEqual(before);
    expect(k.cnt(g, `chg\\_${job1}`)).toBe(0); expect(k.cnt(g, `rel\\_${job1}`)).toBe(0);
    expect(before.parts[0].st).toBe("running");
    k.invariants(g, start);
    const ok = k.freeze(g, 1, job1, 10, "a"); expect(ok.success).toBe(true); expect(ok.already_frozen).toBe(false);
    expect(k.cnt(g, `chg\\_${job1}`)).toBe(1);
    expect(k.invariants(g, start).charged).toBe(100);
    expect(k.freeze(g, 1, job1, 10, "a").already_frozen).toBe(true); // lost response: no second charge
    expect(k.cnt(g, `chg\\_${job1}`)).toBe(1);
  });

  it("p2 F5: a post-settle mismatch (delivered_units changed by the settle UPDATE) raises group_part_settle_mismatch and rolls back the ledger rows the settle already wrote", () => {
    const { g, start, job1 } = k.awaiting(10);
    const before = k.snap(g);
    db.sql(`CREATE FUNCTION public.${FAULT}_fn() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.id = '${job1}' AND NEW.status = 'completed' THEN NEW.delivered_units := NEW.delivered_units + 1; END IF; RETURN NEW; END $f$;
            CREATE TRIGGER ${FAULT} BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.${FAULT}_fn();`);
    try {
      expect(() => k.freeze(g, 1, job1, 10, "b")).toThrow(/group_part_settle_mismatch/);
    } finally { dropFault("jobs"); }
    // the settle had already inserted rel_<job> and chg_<job> in the same transaction: they are gone
    expect(k.snap(g)).toEqual(before);
    expect(k.cnt(g, `chg\\_${job1}`)).toBe(0); expect(k.cnt(g, `rel\\_${job1}`)).toBe(0);
    k.invariants(g, start);
    expect(k.freeze(g, 1, job1, 10, "b").success).toBe(true);
    expect(k.cnt(g, `chg\\_${job1}`)).toBe(1);
    expect(k.invariants(g, start).charged).toBe(100);
  });

  it("p3 F6: a failure while halting the group rolls the release back (part still running, no rel_<job>, halted_at NULL); the retry releases once and halts", () => {
    const { g, start, job1 } = k.awaiting(10);
    const before = k.snap(g);
    db.sql(`CREATE FUNCTION public.${FAULT}_fn() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.halted_at IS NOT NULL AND OLD.halted_at IS NULL THEN RAISE EXCEPTION '${FAULT}_halt'; END IF; RETURN NEW; END $f$;
            CREATE TRIGGER ${FAULT} BEFORE UPDATE ON public.job_groups FOR EACH ROW EXECUTE FUNCTION public.${FAULT}_fn();`);
    try {
      expect(() => k.j(k.f6Call(g, 1, job1))).toThrow(new RegExp(`${FAULT}_halt`));
    } finally { dropFault("job_groups"); }
    expect(k.snap(g)).toEqual(before);
    expect(k.cnt(g, `rel\\_${job1}`)).toBe(0);
    expect(before.group.halted).toBeNull(); expect(before.parts[0].st).toBe("running");
    k.invariants(g, start);
    const ok = k.j(k.f6Call(g, 1, job1)); expect(ok.success).toBe(true); expect(ok.already_released).toBe(false);
    expect(k.cnt(g, `rel\\_${job1}`)).toBe(1);
    expect(k.snap(g).group.halted).not.toBeNull();
    expect(k.draw(g, 2, 0).error).toBe("group_halted");
    expect(k.j(k.f6Call(g, 1, job1)).already_released).toBe(true);
    expect(k.cnt(g, `rel\\_${job1}`)).toBe(1);
    expect(k.invariants(g, start).charged).toBe(0);
    expect(k.bal(g.u)).toBe(start - g.r * 2); // part 1's reserve returned; 2 parts of hold still held until the group closes
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!PROOF)("D-0063 two-session races (T1 p/q/r): no deadlock, no double hold/release/charge", () => {
  let db: ScratchDb; let dbname = "";
  const k = kit(() => db, () => dbname);
  beforeAll(() => { ({ db, dbname } = setup()); }, 180000);
  afterAll(() => db?.drop());
  const WD = "watchdog: part stopped";
  const wdCall = (job: string) => `public.release_job_atomic('${job}','${WD}',true)`;

  it("r1 F6 vs watchdog, watchdog first: B (F6) waits for A's uncommitted release_job_atomic(force), then answers already_released; one rel_<job>, group halted, draw refused", async () => {
    const { g, start, job1 } = k.awaiting(10);
    const r = await k.race(wdCall(job1), k.f6Call(g, 1, job1));
    expect(r.bWasBlocked).toBe(true);
    expect(r.b.success).toBe(true); expect(r.b.already_released).toBe(true);
    expect(k.cnt(g, `rel\\_${job1}`)).toBe(1); expect(k.cnt(g, `chg\\_${job1}`)).toBe(0);
    expect(k.snap(g).group.halted).not.toBeNull();
    const c = k.snap(g).ledger;
    expect(k.draw(g, 2, 0).error).toBe("group_halted");
    expect(k.snap(g).ledger).toEqual(c);
    k.invariants(g, start);
  });

  it("r2 F6 vs watchdog, F6 first: B (release_job_atomic force) waits for A's uncommitted F6; exactly one rel_<job>, no charge, group halted", async () => {
    const { g, start, job1 } = k.awaiting(10);
    const r = await k.race(k.f6Call(g, 1, job1), wdCall(job1));
    expect(r.bWasBlocked).toBe(true);
    expect(r.a.success).toBe(true); expect(r.a.already_released).toBe(false);
    expect(k.cnt(g, `rel\\_${job1}`)).toBe(1); expect(k.cnt(g, `chg\\_${job1}`)).toBe(0);
    expect(k.snap(g).group.halted).not.toBeNull();
    expect(k.draw(g, 2, 0).error).toBe("group_halted");
    k.invariants(g, start);
  });

  it("r3 draw vs watchdog: B (draw part 2) waits on the part-1 job row held by A's uncommitted release, then answers group_halted with halted_at committed and no part-2 row", async () => {
    const { g, start, job1 } = k.awaiting(10);
    const r = await k.race(wdCall(job1), k.drawCall(g, 2, 0));
    expect(r.bWasBlocked).toBe(true);
    expect(r.b.success).toBe(false); expect(r.b.error).toBe("group_halted");
    expect(k.jobIds(g)).toEqual([job1]);
    expect(Number(db.sql(`SELECT count(*) FROM public.job_groups WHERE id='${g.gid}' AND halted_at IS NOT NULL`))).toBe(1); // read from a new session
    expect(k.cnt(g, `gdr\\_%`)).toBe(1); // only part 1's transfer
    k.invariants(g, start);
  });

  it("q1 watchdog vs drive (F5), watchdog first: B (F5 freeze) waits for A's uncommitted release, then part_not_awaiting_freeze; nothing frozen or charged", async () => {
    const { g, start, job1 } = k.awaiting(10);
    const r = await k.race(wdCall(job1), k.freezeCall(g, 1, job1, 10, "c"));
    expect(r.bWasBlocked).toBe(true);
    expect(r.b.success).toBe(false); expect(r.b.error).toBe("part_not_awaiting_freeze");
    expect(k.snap(g).frozen).toBe(0); expect(k.snap(g).keys).toBe(0);
    expect(k.cnt(g, `chg\\_${job1}`)).toBe(0); expect(k.cnt(g, `rel\\_${job1}`)).toBe(1);
    expect(k.invariants(g, start).charged).toBe(0);
  });

  it("q2 watchdog vs drive (F5), drive first: B (release_job_atomic force) waits for A's uncommitted freeze; the part stays completed and charged once, the watchdog adds no second release or refund", async () => {
    const { g, start, job1 } = k.awaiting(10);
    const r = await k.race(k.freezeCall(g, 1, job1, 10, "d"), wdCall(job1));
    expect(r.bWasBlocked).toBe(true);
    expect(r.a.success).toBe(true);
    expect(k.snap(g).parts[0].st).toBe("completed");
    expect(k.cnt(g, `chg\\_${job1}`)).toBe(1); expect(k.cnt(g, `rel\\_${job1}`)).toBe(1);
    expect(k.snap(g).frozen).toBe(1); expect(k.snap(g).keys).toBe(10);
    expect(k.invariants(g, start).charged).toBe(100);
  });

  it("q3 watchdog vs drive on a stuck part: B (close deadline_stuck) waits for A's uncommitted settle_job_atomic, then refuses part_not_frozen and writes nothing", async () => {
    const u = k.fresh(); const start = k.bal(u); const g = k.newGroup(u); const a = k.accept(g);
    db.sql(`UPDATE public.jobs SET status='running', current_cursor='completed', delivered_units=10, lease_until = now() - interval '31 minutes' WHERE id='${a.job_id}'`);
    db.sql(`UPDATE public.job_groups SET deadline_at = now() - interval '1 minute' WHERE id='${g.gid}'`);
    const r = await k.race(`public.settle_job_atomic('${a.job_id}', ${g.r}, NULL)`, k.closeCall(g, "deadline_stuck", "x", 0, 0, "y"));
    expect(r.bWasBlocked).toBe(true);
    expect(r.b.success).toBe(false); expect(r.b.error).toBe("part_not_frozen");
    expect(k.snap(g).group.st).toBe("open");
    expect(k.cnt(g, `rel\\_${g.gid}`)).toBe(0);
    expect(k.cnt(g, `chg\\_${a.job_id}`)).toBe(1); // the settle itself committed; the group did not close over it
    expect(k.snap(g).frozen).toBe(0);
    k.invariants(g, start);
  });

  it("p-draw: two concurrent draws of the SAME part: the second waits on the group lock and answers already_drawn; one transfer, one reserve, one job row", async () => {
    const { g, start, job1 } = k.awaiting(10);
    expect(k.freeze(g, 1, job1, 10, "e").success).toBe(true);
    const r = await k.race(k.drawCall(g, 2, 10), k.drawCall(g, 2, 10));
    expect(r.bWasBlocked).toBe(true);
    expect(r.a.success).toBe(true); expect(r.a.already_drawn).toBe(false);
    expect(r.b.success).toBe(true); expect(r.b.already_drawn).toBe(true);
    expect(k.jobIds(g).length).toBe(2);
    const j2 = k.jobIds(g)[1];
    expect(k.cnt(g, `gdr\\_${j2}`)).toBe(1); expect(k.cnt(g, `res\\_${j2}`)).toBe(1);
    expect(Number(db.sql(`SELECT drawn_credits FROM public.job_groups WHERE id='${g.gid}'`))).toBe(g.r * 2);
    k.invariants(g, start);
  });

  it("p-draw2: two concurrent draws of part 3 while part 2 is still active: both answer previous_part_active and nothing is written", async () => {
    const { g, start, job1 } = k.awaiting(10);
    k.freeze(g, 1, job1, 10, "f");
    const d2 = k.draw(g, 2, 10); expect(d2.success).toBe(true);
    const before = k.snap(g);
    const r = await k.race(k.drawCall(g, 3, 10), k.drawCall(g, 3, 10));
    expect(r.bWasBlocked).toBe(true); // B waits on the group lock A's (refused) draw still holds until COMMIT
    expect(r.a.success).toBe(false); expect(r.b.success).toBe(false);
    expect(r.a.error).toBe("previous_part_active");
    expect(r.b.error).toBe("previous_part_active");
    expect(k.snap(g)).toEqual(before);
    k.invariants(g, start);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!PROOF)("D-0063 T1(o) late accept during the stop, carried to the final close", () => {
  let db: ScratchDb; let dbname = "";
  const k = kit(() => db, () => dbname);
  beforeAll(() => { ({ db, dbname } = setup()); }, 180000);
  afterAll(() => db?.drop());

  it("o2: g1 closed by 03 while A's accept of g2 is uncommitted; after COMMIT g2 runs three parts, closes with the exact totals, and the final balance and ledger invariants hold", async () => {
    const t = scratchPgTarget()!;
    const u1 = k.fresh(); const s1 = k.bal(u1); const g1 = k.newGroup(u1); expect(k.accept(g1).success).toBe(true);
    const u2 = k.fresh(); const s2 = k.bal(u2); const g2 = k.newGroup(u2);
    const A = new Session(dbname);
    try {
      await A.send(S); await A.send("BEGIN;");
      const accRaw = await A.send(`SELECT ${k.acceptCall(g2)};`);
      expect(JSON.parse(accRaw.split("\n").filter((l) => l.startsWith("{")).pop()!).success).toBe(true);
      const runB = spawnSync("psql", ["-h", t.host, "-p", t.port, "-U", "postgres", "-X", "-d", dbname, "-v", "ON_ERROR_STOP=1", "-f", path.join(DIR, "03_operator_close_open_groups.sql")], { encoding: "utf8", timeout: 20000 });
      expect(runB.status).toBe(0);
      expect(runB.stdout).toContain(g1.gid); expect(runB.stdout).not.toContain(g2.gid);
      expect(db.sql(`SELECT status FROM public.job_groups WHERE id='${g1.gid}'`)).toBe("closed");
      expect(db.sql(`SELECT count(*) FROM public.job_groups WHERE id='${g2.gid}'`)).toBe("0"); // not visible while uncommitted
      await A.send("COMMIT;");
    } finally { A.close(); }
    // g1: nothing delivered, whole hold back
    expect(k.invariants(g1, s1).charged).toBe(0); expect(k.bal(u1)).toBe(s1);
    // g2 is open with exactly one hold and the whole hold taken from the balance
    expect(db.sql(`SELECT status FROM public.job_groups WHERE id='${g2.gid}'`)).toBe("open");
    expect(k.cnt(g2, `res\\_${g2.gid}`)).toBe(1);
    expect(k.bal(u2)).toBe(s2 - g2.hold);
    k.invariants(g2, s2);
    // part 1: 10 rows frozen and charged 100
    const j1 = k.jobIds(g2)[0]; k.awaitFreeze(j1, 10);
    expect(k.freeze(g2, 1, j1, 10, "1").success).toBe(true); k.invariants(g2, s2);
    // part 2: 7 of 10 rows frozen and charged 70 (30 of its reserve returned by the settle)
    const d2 = k.draw(g2, 2, 10); expect(d2.success).toBe(true); k.invariants(g2, s2);
    k.awaitFreeze(d2.job_id, 7);
    expect(k.freeze(g2, 2, d2.job_id, 7, "2").success).toBe(true); k.invariants(g2, s2);
    // part 3: 10 rows frozen and charged 100
    const d3 = k.draw(g2, 3, 17); expect(d3.success).toBe(true); k.invariants(g2, s2);
    k.awaitFreeze(d3.job_id, 10);
    expect(k.freeze(g2, 3, d3.job_id, 10, "3").success).toBe(true);
    const mid = k.invariants(g2, s2); expect(mid.charged).toBe(270);
    // final close with the exact totals Z 27 / C 270 and the exact S7 line from copy.ts
    const line = groupFinalLineAr({ reason: "all_parts_done", Z: 27, X: 30, Y: 30, C: 270 });
    expect(k.j(k.closeCall(g2, "all_parts_done", line, 26, 270, null)).error).toBe("totals_mismatch"); // wrong Z: nothing written
    expect(k.j(k.closeCall(g2, "all_parts_done", line, 27, 269, null)).error).toBe("totals_mismatch"); // wrong C: nothing written
    k.invariants(g2, s2);
    const cl = k.j(k.closeCall(g2, "all_parts_done", line, 27, 270, null));
    expect(cl.success).toBe(true); expect(Number(cl.delivered_total)).toBe(27); expect(Number(cl.charged_total)).toBe(270);
    expect(cl.final_line).toBe(line);
    expect(db.sql(`SELECT status FROM public.job_groups WHERE id='${g2.gid}'`)).toBe("closed");
    const fin = k.invariants(g2, s2);
    expect(fin.charged).toBe(270); expect(fin.held).toBe(0);               // every point not charged is back
    expect(k.bal(u2)).toBe(s2 - 270);                                      // final balance = start - sum of charges, exactly
    expect(k.cnt(g2, `chg\\_%`)).toBe(3);
    expect(k.cnt(g2, `rel\\_${g2.gid}`)).toBe(0);                          // all 3 parts were drawn: no group remainder
    expect(Number(db.sql(`SELECT count(*) FROM public.job_group_keys WHERE group_id='${g2.gid}'`))).toBe(27);
    // closing again changes nothing
    const before = k.snap(g2);
    expect(k.j(k.closeCall(g2, "all_parts_done", line, 27, 270, null)).already_closed).toBe(true);
    expect(k.snap(g2)).toEqual(before);
    // g1 and g2 together: no other user's balance was touched
    expect(k.bal(u1)).toBe(s1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!PROOF)("D-0063 T1(n) 04 report: literal points_still_held, overdue, WAIT and an R3 row", () => {
  let db: ScratchDb; let dbname = "";
  const k = kit(() => db, () => dbname);
  beforeAll(() => { ({ db, dbname } = setup()); }, 180000);
  afterAll(() => db?.drop());
  const report = (): Record<string, string>[] => {
    const t = scratchPgTarget()!;
    const r = spawnSync("psql", ["-h", t.host, "-p", t.port, "-U", "postgres", "-X", "-d", dbname, "-v", "ON_ERROR_STOP=1", "--csv", "-f", path.join(DIR, "04_report_open_groups.sql")], { encoding: "utf8", timeout: 20000 });
    expect(r.status).toBe(0); expect(r.stderr).not.toMatch(/ERROR/);
    return parseCsv(r.stdout);
  };
  const rowOf = (rows: Record<string, string>[], section: string, gid: string) => rows.filter((r) => r.section.startsWith(section) && r.group_id === gid);

  it("n2: every R1 row shows the literal held points and overdue flag; an unfrozen completed part is an R3 row; an awaiting-freeze part makes R0 say WAIT; 04 writes nothing", () => {
    const mk = () => { const u = k.fresh(); const g = k.newGroup(u); const a = k.accept(g); return { u, g, a }; };
    // A: part 1 frozen and charged 100, part 2 drawn and running: held = (300 - 200) + 100 = 200
    const A = mk(); k.awaitFreeze(A.a.job_id, 10); expect(k.freeze(A.g, 1, A.a.job_id, 10, "a").success).toBe(true);
    const a2 = k.draw(A.g, 2, 10); db.sql(`UPDATE public.jobs SET status='running' WHERE id='${a2.job_id}'`);
    // B: only part 1 queued: held = (300 - 100) + 100 = 300
    const B = mk();
    // C / D: part 1 queued, deadline 2 h 14 min and 2 h 16 min in the past: overdue false / true (threshold 2 h 15 min)
    const C = mk(); db.sql(`UPDATE public.job_groups SET deadline_at = now() - interval '2 hours 14 minutes' WHERE id='${C.g.gid}'`);
    const D = mk(); db.sql(`UPDATE public.job_groups SET deadline_at = now() - interval '2 hours 16 minutes' WHERE id='${D.g.gid}'`);
    // E: part 1 frozen, part 2 completed with 5 delivered rows and NO frozen copy (must never happen; 04 must show it): R3 row
    const E = mk(); k.awaitFreeze(E.a.job_id, 10); expect(k.freeze(E.g, 1, E.a.job_id, 10, "e").success).toBe(true);
    const e2 = k.draw(E.g, 2, 10); db.sql(`UPDATE public.jobs SET status='completed', delivered_units=5 WHERE id='${e2.job_id}'`);
    const ledgerBefore = db.sql("SELECT count(*) || ':' || COALESCE(sum(delta),0) FROM public.credit_ledger");

    const rows = report();
    const r1 = (G: { g: { gid: string } }) => { const x = rowOf(rows, "R1", G.g.gid); expect(x.length).toBe(1); return x[0]; };
    expect(Number(r1(A).points_still_held)).toBe(200); expect(r1(A).overdue).toBe("f"); expect(r1(A).part_index).toBe("2"); expect(r1(A).status).toBe("running");
    expect(Number(r1(B).points_still_held)).toBe(300); expect(r1(B).overdue).toBe("f"); expect(r1(B).part_index).toBe("1");
    expect(Number(r1(C).points_still_held)).toBe(300); expect(r1(C).overdue).toBe("f");
    expect(Number(r1(D).points_still_held)).toBe(300); expect(r1(D).overdue).toBe("t");
    expect(Number(r1(E).points_still_held)).toBe(100); expect(r1(E).status).toBe("completed");   // (300 - 200) + 0: a completed part holds nothing
    // R3: exactly one row, the unfrozen completed part of E
    const r3 = rows.filter((r) => r.section.startsWith("R3"));
    expect(r3.length).toBe(1);
    expect(r3[0].group_id).toBe(E.g.gid); expect(r3[0].part_index).toBe("2"); expect(r3[0].job_id).toBe(e2.job_id);
    expect(r3[0].detail).toBe("delivered: 5, charged: 0"); expect(r3[0].close_reason).toBe("none");
    // no part awaits a freeze: R0 says OK_TO_RUN_03, no R1 row carries a wait flag
    const r0 = rows.filter((r) => r.section.startsWith("R0"));
    expect(r0.length).toBe(1); expect(r0[0].status).toBe("OK_TO_RUN_03");
    expect(rows.filter((r) => r.section.startsWith("R1") && r.wait !== "").length).toBe(0);
    // one R2 row, not an error, when the heartbeat table is absent
    const r2 = rows.filter((r) => r.section.startsWith("R2")); expect(r2.length).toBe(1); expect(r2[0].status).toBe("not_installed");
    expect(rows.length).toBe(1 + 5 + 1 + 1); // R0 + five open groups + one R3 row + R2
    // 04 is read-only: ledger unchanged
    expect(db.sql("SELECT count(*) || ':' || COALESCE(sum(delta),0) FROM public.credit_ledger")).toBe(ledgerBefore);

    // F: part 1 awaiting freeze (running, cursor completed): WAIT
    const F = mk(); k.awaitFreeze(F.a.job_id, 10);
    const rows2 = report();
    const rf = rowOf(rows2, "R1", F.g.gid)[0];
    expect(rf.status).toBe("running"); expect(rf.current_cursor).toBe("completed"); expect(rf.wait).toBe("WAIT awaiting freeze - do not run 03");
    expect(rows2.filter((r) => r.section.startsWith("R0"))[0].status).toBe("WAIT");
    expect(rows2.filter((r) => r.section.startsWith("R1") && r.wait !== "").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!PROOF)("D-0063 S7 catalog: explicit function list, trigger list and RLS flags", () => {
  let db: ScratchDb;
  beforeAll(() => { ({ db } = setup()); }, 180000);
  afterAll(() => db?.drop());
  const NEW_FNS = [
    "accept_group_quote_atomic", "claim_next_job_group", "close_job_group_atomic", "draw_next_group_part_atomic",
    "freeze_and_settle_group_part_atomic", "job_group_points_ar", "release_unfrozen_group_part_atomic",
  ];
  const TABLES = ["job_group_frozen", "job_group_keys", "job_group_parts", "job_groups"];

  it("S7a: exactly the 7 new functions + the trigger function exist (no extra), the 7 are SECURITY DEFINER with a pinned search_path and EXECUTE for service_role only", () => {
    const all = db.sql(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ 'group' ORDER BY p.proname`).split("\n");
    expect(all).toEqual([...NEW_FNS, "block_job_group_mutation"].sort());
    const rows = db.sql(`SELECT p.proname || '|' || p.prosecdef || '|' || COALESCE(array_to_string(p.proconfig, ','), '') || '|' ||
        has_function_privilege('anon', p.oid, 'EXECUTE') || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE') || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY(ARRAY['${NEW_FNS.join("','")}']) ORDER BY p.proname`).split("\n");
    expect(rows).toEqual(NEW_FNS.map((n) => `${n}|true|search_path=public, pg_temp|false|false|true`));
    // the trigger function is not SECURITY DEFINER and cannot be called outside a trigger
    expect(db.sql(`SELECT p.prosecdef || '|' || pg_get_function_result(p.oid) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'block_job_group_mutation'`)).toBe("false|trigger");
  });

  it("S7b: exactly the 4 tables have RLS enabled, no policies, and only service_role can SELECT (nobody can write directly: every write goes through the SECURITY DEFINER functions)", () => {
    const rows = db.sql(`SELECT c.relname || '|' || c.relrowsecurity || '|' || (SELECT count(*) FROM pg_policy pol WHERE pol.polrelid = c.oid) || '|' ||
        has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') || '|' || has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') || '|' ||
        has_table_privilege('service_role', c.oid, 'SELECT') || '|' || has_table_privilege('service_role', c.oid, 'INSERT') || '|' || has_table_privilege('service_role', c.oid, 'UPDATE') || '|' || has_table_privilege('service_role', c.oid, 'DELETE')
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname ~ '^job_group' ORDER BY c.relname`).split("\n");
    expect(rows).toEqual(TABLES.map((t) => `${t}|true|0|false|false|true|false|false|false`));
  });

  it("S7c: exactly 3 append-only triggers, on job_group_parts / job_group_keys / job_group_frozen, enabled, BEFORE UPDATE OR DELETE", () => {
    const rows = db.sql(`SELECT t.tgname || '|' || c.relname || '|' || t.tgenabled::text || '|' || (t.tgtype & 2 <> 0) || '|' || (t.tgtype & 8 <> 0) || '|' || (t.tgtype & 16 <> 0)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname ~ '^job_group' ORDER BY t.tgname`).split("\n");
    expect(rows).toEqual([
      "trg_block_job_group_frozen_mutation|job_group_frozen|O|true|true|true",
      "trg_block_job_group_keys_mutation|job_group_keys|O|true|true|true",
      "trg_block_job_group_parts_mutation|job_group_parts|O|true|true|true",
    ]);
  });
});
