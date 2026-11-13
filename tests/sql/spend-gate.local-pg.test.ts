import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDb, scratchPgTarget, type ScratchDb } from "./localPg";

/**
 * ROUND 61: the spend gate SQL (docs/proposals/spend-gate/sql/) on a REAL scratch PostgreSQL 16 (set DIGER_TEST_PG; skipped otherwise; NEVER Supabase):
 * every repository migration first (what is live), Supabase's default privileges emulated (new objects granted to anon/authenticated/service_role),
 * then 001_spend_gate.sql. Concurrency uses separate psql connections. Customer money is hashed before and after.
 */
const DIR = path.resolve(__dirname, "../../docs/proposals/spend-gate/sql");
const file = (name: string) => readFileSync(path.join(DIR, name), "utf8");
const S = "SET ROLE service_role;";
const MONEY = ["accept_quote_atomic", "settle_job_atomic", "release_job_atomic", "create_quote_atomic", "settle_people_job_atomic", "reserve_provider_spend_atomic"];

describe.skipIf(!scratchPgTarget())("spend gate SQL on a real Postgres", () => {
  let db: ScratchDb;
  const j = (sql: string) => JSON.parse(db.sql(sql));
  const sr = (sql: string) => j(`${S} select ${sql}`);
  const reserve = (key: string, usd: number, mission: string | null = "msn_a", kind = "provider", ttl = 60) =>
    sr(`public.spend_reserve('${key}','${kind}','contextdev.scrape',${usd},${mission === null ? "null" : `'${mission}'`},${ttl})`);
  const settle = (id: string, actual: number | null) => sr(`public.spend_settle('${id}'::uuid,${actual === null ? "null" : actual})`);
  const grant = () => j("select row_to_json(g) from spend_gate.grants g where state='open' or true order by issued_at desc limit 1");
  const issue = (id: string, ceiling: number, perOp = 0.05, perMission = ceiling, kinds = "{provider,model}", opens = "now() - interval '1 minute'", closes = "now() + interval '1 day'") =>
    j(`select spend_gate.issue_grant('${id}',${ceiling},${perOp},${perMission},'${kinds}',${opens},${closes},'owner','round 61 test')`);
  const money = () => db.sql(`select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (${MONEY.map((m) => `'${m}'`).join(",")})`)
    + "|" + db.sql("select count(*)||':'||coalesce(sum(delta),0) from credit_ledger");
  let moneyBefore = "";

  beforeAll(() => {
    db = createScratchDb();
    // Supabase's default privileges: objects the owner creates are granted to the API roles unless revoked
    db.sql("ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES GRANT ALL ON SEQUENCES TO anon, authenticated, service_role");
    db.sql("insert into credit_ledger(id,user_id,delta,type,note) select 'r61_fixture', id, 100, 'topup', 'fixture' from auth.users limit 1");
    moneyBefore = money();
    db.sql(file("001_spend_gate.sql"));
  }, 240000);
  afterAll(() => db?.drop());

  it("applies; the verification script returns all ok; NO grant exists and nothing can be reserved (fail closed)", () => {
    const rows = db.sql(file("002_verify.sql")).split("\n");
    expect(rows.length).toBeGreaterThanOrEqual(14);
    expect(rows.filter((r) => !r.endsWith("|t"))).toEqual([]);
    expect(db.sql("select count(*) from spend_gate.grants")).toBe("0");
    expect(reserve("k0", 0.001)).toEqual({ ok: false, reason: "no_grant" });
  });

  it("SERVICE ROLE CANNOT AUTHORIZE ITSELF: no read or write of spend_gate, no issue, no revoke, no raise through any public function", () => {
    expect(() => db.sql(`${S} select count(*) from spend_gate.grants`)).toThrow(/permission denied/);
    expect(() => db.sql(`${S} insert into spend_gate.grants(id,ceiling_usd,per_op_max_usd,per_mission_max_usd,kinds,opens_at,closes_at,issued_by,reason) values ('x1',50,1,50,'{provider}',now(),now()+interval '1 day','me','me')`)).toThrow(/permission denied/);
    expect(() => db.sql(`${S} select spend_gate.issue_grant('x2',50,1,50,'{provider}',now(),now()+interval '1 day','me','me')`)).toThrow(/permission denied/);
    expect(() => db.sql(`${S} select spend_gate.revoke_grant('x2','me')`)).toThrow(/permission denied/);
    for (const role of ["anon", "authenticated"]) {
      expect(() => db.sql(`SET ROLE ${role}; select public.spend_reserve('k','provider','x',0.001,null,60)`)).toThrow(/permission denied/);
      expect(() => db.sql(`SET ROLE ${role}; select public.spend_status()`)).toThrow(/permission denied/);
    }
    expect(db.sql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'spend_%' and p.proname not in ('spend_reserve','spend_settle','spend_stop','spend_status')")).toBe("0");
  });

  it("the owner issues ONE open grant; a second open grant is refused; a grant longer than 31 days or with a per-mission maximum above the ceiling is refused", () => {
    expect(issue("g_r61", 0.25, 0.05, 0.2)).toEqual({ ok: true, grant_id: "g_r61" });
    expect(() => issue("g_two", 0.1)).toThrow(/one open grant/);
    expect(() => db.sql("select spend_gate.issue_grant('g_long',1,0.1,1,'{provider}',now(),now()+interval '40 days','owner','x')")).toThrow();
    expect(sr("public.spend_status()")).toMatchObject({ grant_id: "g_r61", state: "open", ceiling_usd: 0.25 });
  });

  it("CONCURRENCY: 2 workers x 40 parallel reservations on separate connections never take reserved + spent past the ceiling", async () => {
    const tasks = Array.from({ length: 80 }, (_, i) => db.sqlAsync(`${S} select public.spend_reserve('c${i}','provider','contextdev.scrape',0.01,'msn_w${i % 2}',60)`).then((s) => JSON.parse(s)));
    const results = await Promise.all(tasks);
    const ok = results.filter((r) => r.ok);
    // 0.2 per mission, 0.25 overall: 20 + 5
    expect(ok.length).toBe(25);
    const reasons = new Set(results.filter((r) => !r.ok).map((r) => r.reason));
    expect([...reasons].every((r) => r === "over_ceiling" || r === "over_mission_ceiling")).toBe(true);
    const g = grant();
    expect(Number(g.reserved_usd) + Number(g.spent_usd)).toBeLessThanOrEqual(0.25 + 1e-9);
    // settle them all (half known at 0.004, half unknown) so the next tests start from a known state
    for (const [i, r] of ok.entries()) settle(r.reservation_id, i % 2 === 0 ? 0.004 : null);
    const after = grant();
    expect(Number(after.reserved_usd)).toBe(0);
    expect(Number(after.spent_usd)).toBeCloseTo(13 * 0.004 + 12 * 0.01, 6);
  });

  it("IDEMPOTENT: a replayed key returns the same reservation; another amount under the same key is refused; settle twice counts once", () => {
    db.sql("select spend_gate.revoke_grant('g_r61','next test')");
    issue("g_idem", 0.5);
    const a = reserve("same-key", 0.02);
    const b = reserve("same-key", 0.02);
    expect(a.ok && b.ok && a.reservation_id === b.reservation_id && b.replay).toBe(true);
    expect(reserve("same-key", 0.03)).toEqual({ ok: false, reason: "key_conflict" });
    expect(settle(a.reservation_id, 0.005)).toMatchObject({ ok: true, counted_usd: 0.005, replay: false });
    expect(settle(a.reservation_id, 0.019)).toMatchObject({ ok: true, counted_usd: 0.005, replay: true });
    expect(grant()).toMatchObject({ id: "g_idem", reserved_usd: 0, spent_usd: 0.005 });
  });

  it("OVERRUN: the bound counts, the excess is recorded, the grant TRIPS and refuses; service_role cannot reopen it", () => {
    const a = reserve("ov1", 0.01);
    expect(settle(a.reservation_id, 0.0137)).toMatchObject({ ok: true, counted_usd: 0.01, overrun_usd: 0.0037 });
    expect(grant()).toMatchObject({ id: "g_idem", state: "tripped", overrun_usd: 0.0037 });
    expect(reserve("ov2", 0.001)).toEqual({ ok: false, reason: "grant_tripped" });
    expect(() => db.sql(`${S} update spend_gate.grants set state='open'`)).toThrow(/permission denied/);
    expect(db.sql("select count(*) from spend_gate.events where kind='tripped_overrun'")).toBe("1");
  });

  it("EXPIRY: a reservation held past its time (a killed worker) is SPENT, never released, without any scheduled job", () => {
    issue("g_exp", 0.5);
    const a = reserve("ex1", 0.03, "msn_e", "provider", 5);
    db.sql(`update spend_gate.reservations set expires_at = now() - interval '1 second' where id = '${a.reservation_id}'`); // the clock moved on
    expect(reserve("ex2", 0.001, "msn_e").ok).toBe(true);
    expect(db.sql(`select state from spend_gate.reservations where id='${a.reservation_id}'`)).toBe("expired");
    expect(settle(a.reservation_id, 0)).toMatchObject({ ok: true, state: "expired", counted_usd: 0.03, replay: true });
    expect(Number(grant().spent_usd)).toBeCloseTo(0.03, 6);
  });

  it("PER MISSION: one mission cannot hold or spend more than the grant's per-mission maximum; another mission still can", () => {
    db.sql("select spend_gate.revoke_grant('g_exp','next')");
    issue("g_pm", 0.5, 0.05, 0.03);
    expect(reserve("pm1", 0.02, "msn_p").ok).toBe(true);
    expect(reserve("pm2", 0.02, "msn_p")).toEqual({ ok: false, reason: "over_mission_ceiling" });
    expect(reserve("pm3", 0.02, "msn_q").ok).toBe(true);
  });

  it("window, kinds, per-operation maximum, kill switch, bad input", () => {
    db.sql("select spend_gate.revoke_grant('g_pm','next')");
    expect(reserve("w0", 0.001)).toEqual({ ok: false, reason: "grant_revoked" });
    issue("g_future", 0.5, 0.05, 0.5, "{provider}", "now() + interval '1 hour'", "now() + interval '2 hours'");
    expect(reserve("w1", 0.001)).toEqual({ ok: false, reason: "grant_not_open" });
    db.sql("select spend_gate.revoke_grant('g_future','next')");
    issue("g_now", 0.5, 0.05, 0.5, "{provider}");
    expect(reserve("w2", 0.001, null, "chat")).toEqual({ ok: false, reason: "kind_not_covered" });
    expect(reserve("w3", 0.06)).toEqual({ ok: false, reason: "over_op_max" });
    expect(reserve("w4", 0)).toEqual({ ok: false, reason: "bad_input" });
    expect(reserve("w5", 0.001, null, "provider", 3600)).toEqual({ ok: false, reason: "bad_input" });
    expect(sr("public.spend_stop('test')")).toEqual({ ok: true, stopped: true });
    expect(reserve("w6", 0.001)).toEqual({ ok: false, reason: "grant_tripped" });
  });

  it("CUSTOMER MONEY UNTOUCHED: the money function bodies and the ledger are identical before and after", () => {
    expect(money()).toBe(moneyBefore);
  });

  it("ROLLBACK refuses while a reservation is held, then drops everything; money unchanged", () => {
    db.sql("select spend_gate.revoke_grant('g_now','x')");
    issue("g_rb", 0.5);
    expect(reserve("rb1", 0.001).ok).toBe(true);
    expect(() => db.sql(file("001_spend_gate.rollback.sql"))).toThrow(/held reservations exist/);
    db.sql(`SET spend_gate.force_rollback = 'on'; ${file("001_spend_gate.rollback.sql")}`);
    expect(db.sql("select count(*) from pg_namespace where nspname='spend_gate'")).toBe("0");
    expect(db.sql("select count(*) from pg_roles where rolname='spend_gate_owner'")).toBe("0");
    expect(db.sql("select count(*) from pg_proc where proname like 'spend\\_%'")).toBe("0");
    expect(money()).toBe(moneyBefore);
  });
});
