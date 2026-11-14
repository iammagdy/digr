import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDb, scratchPgTarget, type ScratchDb } from "./localPg";

/**
 * SPEND SAFETY MILESTONE: the campaign scope SQL (003_campaign_scope.sql) on a REAL scratch PostgreSQL 16 (set DIGER_TEST_PG; skipped otherwise; NEVER Supabase).
 * Order: every repository migration, Supabase's default privileges emulated, a fixture `public.missions` (the agent tables are not in the repo's migrations), 001, then 003.
 * Customer money (the money functions and the ledger) is hashed before and after. Concurrency uses separate psql connections.
 */
const DIR = path.resolve(__dirname, "../../docs/proposals/spend-gate/sql");
const file = (name: string) => readFileSync(path.join(DIR, name), "utf8");
const S = "SET ROLE service_role;";
const MONEY = ["accept_quote_atomic", "settle_job_atomic", "release_job_atomic", "create_quote_atomic", "settle_people_job_atomic", "reserve_provider_spend_atomic"];
const TEST = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe.skipIf(!scratchPgTarget())("campaign scope SQL on a real Postgres", () => {
  let db: ScratchDb;
  const j = (sql: string) => JSON.parse(db.sql(sql));
  const sr = (sql: string) => j(`${S} select ${sql}`);
  const reserve = (key: string, usd: number, mission: string | null, kind = "provider", ttl = 60) =>
    sr(`public.spend_reserve('${key}','${kind}','contextdev.scrape',${usd},${mission === null ? "null" : `'${mission}'`},${ttl})`);
  const settle = (id: string, actual: number | null) => sr(`public.spend_settle('${id}'::uuid,${actual === null ? "null" : actual})`);
  const enroll = (mission: string) => sr(`public.spend_enroll_mission('${mission}')`);
  const issue = (id: string, ceiling: number, o: { account?: string; perOp?: number; perMission?: number; kinds?: string; opens?: string; closes?: string; max?: number } = {}) =>
    j(`select spend_gate.issue_campaign_grant('${id}','${o.account ?? TEST}'::uuid,${ceiling},${o.perOp ?? 0.1},${o.perMission ?? ceiling},'${o.kinds ?? "{provider,model}"}',${o.opens ?? "now() - interval '1 minute'"},${o.closes ?? "now() + interval '24 hours'"},${o.max ?? 2},'owner','campaign test')`);
  const money = () => db.sql(`select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (${MONEY.map((m) => `'${m}'`).join(",")})`)
    + "|" + db.sql("select count(*)||':'||coalesce(sum(delta),0) from credit_ledger");
  const bodies = () => db.sql("select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('spend_reserve','spend_status')");
  let moneyBefore = "";
  let bodies001 = "";

  beforeAll(() => {
    db = createScratchDb();
    db.sql("ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES GRANT ALL ON SEQUENCES TO anon, authenticated, service_role");
    db.sql("create table if not exists public.missions (id text primary key, user_id uuid not null)");
    db.sql("alter table public.missions enable row level security");
    db.sql(`insert into public.missions(id,user_id) values ('msn_test1','${TEST}'),('msn_test2','${TEST}'),('msn_test3','${TEST}'),('msn_other1','${OTHER}')`);
    db.sql("insert into credit_ledger(id,user_id,delta,type,note) select 'camp_fixture', id, 100, 'topup', 'fixture' from auth.users limit 1");
    moneyBefore = money();
    db.sql(file("001_spend_gate.sql"));
    bodies001 = bodies();
    db.sql(file("003_campaign_scope.sql"));
  }, 240000);
  afterAll(() => db?.drop());

  it("applies; 002 and 004 return all true; NO grant exists and nothing can be reserved or enrolled", () => {
    for (const f of ["002_verify.sql", "004_verify_campaign.sql"]) {
      const rows = db.sql(file(f)).split("\n");
      expect(rows.length).toBeGreaterThanOrEqual(11);
      expect(rows.filter((r) => !r.endsWith("|t"))).toEqual([]);
    }
    expect(db.sql("select count(*) from spend_gate.grants")).toBe("0");
    expect(reserve("k0", 0.001, "msn_test1")).toEqual({ ok: false, reason: "no_grant" });
    expect(enroll("msn_test1")).toEqual({ ok: false, reason: "no_grant" });
  });

  it("I/J/K: SERVICE ROLE CANNOT ISSUE A CAMPAIGN GRANT, ENROLL BY WRITING, OR READ spend_gate; anon and authenticated cannot enroll or reserve", () => {
    expect(() => db.sql(`${S} select spend_gate.issue_campaign_grant('x','${TEST}'::uuid,0.3,0.1,0.3,'{provider}',now(),now()+interval '1 hour',1,'me','me')`)).toThrow(/permission denied/);
    expect(() => db.sql(`${S} insert into spend_gate.enrollments(grant_id,mission_id) values ('x','msn_test1')`)).toThrow(/permission denied/);
    expect(() => db.sql(`${S} select spend_gate.mission_owner('msn_test1')`)).toThrow(/permission denied/);
    expect(() => db.sql(`${S} update spend_gate.grants set ceiling_usd = 50`)).toThrow(/permission denied/);
    for (const role of ["anon", "authenticated"]) {
      expect(() => db.sql(`SET ROLE ${role}; select public.spend_enroll_mission('msn_test1')`)).toThrow(/permission denied/);
      expect(() => db.sql(`SET ROLE ${role}; select public.spend_reserve('k','provider','x',0.001,'msn_test1',60)`)).toThrow(/permission denied/);
    }
  });

  it("the owner's issue is refused above 0.30, for chat/eval kinds, a window over 72 hours, or more than 5 enrolled missions", () => {
    expect(() => issue("g_big", 0.31)).toThrow(/cumulative ceiling/);
    expect(() => issue("g_chat", 0.1, { kinds: "{provider,chat}" })).toThrow();
    expect(() => issue("g_eval", 0.1, { kinds: "{eval}" })).toThrow();
    expect(() => issue("g_long", 0.1, { closes: "now() + interval '73 hours'" })).toThrow();
    expect(() => issue("g_many", 0.1, { max: 6 })).toThrow();
    expect(() => db.sql(`select spend_gate.issue_campaign_grant('g_noacct',null,0.1,0.1,0.1,'{provider}',now(),now()+interval '1 hour',1,'o','r')`)).toThrow(/one account/);
    expect(db.sql("select count(*) from spend_gate.grants")).toBe("0");
  });

  it("I/J: enrollment is decided by the DATABASE's record of the mission's owner: the test account's mission is enrolled; another account's, an unknown one and a full campaign are refused", () => {
    expect(issue("camp_a", 0.2, { perOp: 0.1, perMission: 0.15, max: 2 })).toMatchObject({ ok: true, grant_id: "camp_a", campaign_used_before_usd: 0 });
    expect(enroll("msn_other1")).toEqual({ ok: false, reason: "wrong_account" });
    expect(enroll("msn_nobody")).toEqual({ ok: false, reason: "unknown_mission" });
    expect(enroll("msn_test1")).toMatchObject({ ok: true, grant_id: "camp_a", replay: false });
    expect(enroll("msn_test1")).toMatchObject({ ok: true, replay: true });
    expect(enroll("msn_test2")).toMatchObject({ ok: true, replay: false });
    expect(enroll("msn_test3")).toEqual({ ok: false, reason: "campaign_full" });
    expect(db.sql("select count(*) from spend_gate.enrollments")).toBe("2");
    expect(sr("public.spend_status()")).toMatchObject({ campaign: true, account_id: TEST, enrolled: 2, max_missions: 2, ceiling_usd: 0.2 });
  });

  it("J: a different customer's mission, an unenrolled mission of the test account, and a call with NO mission cannot reserve against the grant", () => {
    expect(reserve("o1", 0.001, "msn_other1")).toEqual({ ok: false, reason: "mission_not_enrolled" });
    expect(reserve("o2", 0.001, "msn_test3")).toEqual({ ok: false, reason: "mission_not_enrolled" });
    expect(reserve("o3", 0.001, null)).toEqual({ ok: false, reason: "mission_not_enrolled" });
    expect(db.sql("select count(*) from spend_gate.reservations")).toBe("0");
  });

  it("A/B/N: a call under the remaining budget is reserved and settled; one over it is refused BEFORE it is sent; provider and model share the same budget", () => {
    const a = reserve("a1", 0.05, "msn_test1", "provider");
    expect(a).toMatchObject({ ok: true });
    expect(settle(a.reservation_id, 0.02)).toMatchObject({ ok: true, counted_usd: 0.02 });
    const m = reserve("m1", 0.1, "msn_test1", "model");
    expect(m).toMatchObject({ ok: true });
    expect(sr("public.spend_status()")).toMatchObject({ spent_usd: 0.02, reserved_usd: 0.1 });
    // 0.02 spent + 0.1 held + 0.1 more would pass 0.2
    expect(reserve("m2", 0.1, "msn_test2", "model")).toEqual({ ok: false, reason: "over_ceiling" });
    expect(reserve("m3", 0.2, "msn_test2", "model")).toEqual({ ok: false, reason: "over_op_max" });
    expect(reserve("c1", 0.01, "msn_test1", "chat")).toEqual({ ok: false, reason: "kind_not_covered" });
    expect(settle(m.reservation_id, 0.04)).toMatchObject({ ok: true, counted_usd: 0.04 });
  });

  it("D/E/F: a retry of a reserve call never double-reserves; a timed-out call keeps its reservation; an unknown charge counts the whole bound; a duplicate settle counts once", () => {
    const r = reserve("d1", 0.03, "msn_test2");
    expect(reserve("d1", 0.03, "msn_test2")).toMatchObject({ ok: true, reservation_id: r.reservation_id, replay: true });
    expect(reserve("d1", 0.04, "msn_test2")).toEqual({ ok: false, reason: "key_conflict" });
    const before = sr("public.spend_status()");
    expect(before.reserved_usd).toBe(0.03);
    // unknown charge: the whole bound is spent, nothing is released
    expect(settle(r.reservation_id, null)).toMatchObject({ ok: true, counted_usd: 0.03 });
    expect(settle(r.reservation_id, 0)).toMatchObject({ ok: true, replay: true, counted_usd: 0.03 });
    const after = sr("public.spend_status()");
    expect(after.spent_usd).toBeCloseTo(before.spent_usd + 0.03, 6);
    expect(after.reserved_usd).toBe(0);
    // a held reservation whose time passed expires AS SPENT, never released, and is counted again nowhere
    const t = reserve("e1", 0.02, "msn_test2", "provider", 5);
    db.sql("update spend_gate.reservations set expires_at = now() - interval '1 second' where key = 'e1'");
    const next = reserve("e2", 0.001, "msn_test2");
    expect(next).toMatchObject({ ok: true });
    expect(settle(t.reservation_id, 0)).toMatchObject({ ok: true, replay: true, counted_usd: 0.02 });
    expect(sr("public.spend_status()").spent_usd).toBeCloseTo(0.02 + 0.04 + 0.03 + 0.02, 6);
  });

  it("an overrun is counted as the bound, recorded apart, and TRIPS the campaign grant; a tripped grant never reopens", () => {
    const r = reserve("t1", 0.01, "msn_test1");
    expect(settle(r.reservation_id, 0.03)).toMatchObject({ ok: true, counted_usd: 0.01, overrun_usd: 0.02 });
    expect(sr("public.spend_status()")).toMatchObject({ state: "tripped" });
    expect(reserve("t2", 0.001, "msn_test1")).toEqual({ ok: false, reason: "grant_tripped" });
    expect(enroll("msn_test1")).toEqual({ ok: false, reason: "grant_tripped" });
    expect(() => db.sql("update spend_gate.grants set state = 'open' where id = 'camp_a'")).toThrow(/never reopens/);
  });

  it("H/L: terms are IMMUTABLE after issue (ceiling, account, window, kinds, mission limit); spent never goes down", () => {
    for (const set of ["ceiling_usd = 0.3", `account_id = '${OTHER}'`, "closes_at = closes_at + interval '1 hour'", "max_missions = 5", "kinds = '{provider}'", "id = 'renamed'"]) {
      expect(() => db.sql(`update spend_gate.grants set ${set} where id = 'camp_a'`)).toThrow(/never change/);
    }
    expect(() => db.sql("update spend_gate.grants set spent_usd = 0 where id = 'camp_a'")).toThrow(/never go down/);
  });

  it("ONE CUMULATIVE CEILING: revoking or tripping a grant gives nothing back; the next campaign grant can only use what is left of 0.30", () => {
    const used = sr("public.spend_status()");
    const exposure = used.spent_usd + used.reserved_usd + used.overrun_usd;
    // the overrun (0.02) is real money: it counts in the campaign's exposure with the rest
    expect(exposure).toBeCloseTo(0.02 + 0.04 + 0.03 + 0.02 + 0.01 + 0.02 + 0.001, 6);
    // the owner may not issue while a tripped grant... a tripped grant is not open, so a new one is possible only inside the remainder
    const left = Math.round((0.3 - exposure) * 1e6) / 1e6;
    expect(() => issue("camp_b", Math.round((left + 0.01) * 1e6) / 1e6)).toThrow(/cumulative ceiling/);
    expect(issue("camp_b", 0.05, { max: 1 })).toMatchObject({ ok: true });
    expect(db.sql("select sum(spent_usd + reserved_usd + overrun_usd)::numeric(12,6) <= 0.30 from spend_gate.grants where account_id is not null")).toBe("t");
  });

  it("a reservation still HELD when its grant is revoked counts in the campaign's exposure: nothing is handed back by a revoke", () => {
    db.sql("select spend_gate.revoke_grant('camp_b','test')");
    const before = db.sql("select (sum(spent_usd + reserved_usd + overrun_usd))::numeric(12,6) from spend_gate.grants where account_id is not null");
    issue("camp_h", 0.05, { max: 1, perOp: 0.05 });
    expect(enroll("msn_test1")).toMatchObject({ ok: true });
    expect(reserve("held1", 0.02, "msn_test1")).toMatchObject({ ok: true });
    db.sql("select spend_gate.revoke_grant('camp_h','test')");
    const exposure = Number(before) + 0.02;
    const left = Math.round((0.3 - exposure) * 1e6) / 1e6;
    expect(() => issue("camp_h2", Math.round((left + 0.001) * 1e6) / 1e6)).toThrow(/cumulative ceiling/);
    expect(issue("camp_h3", left, { max: 1 })).toMatchObject({ ok: true });
    db.sql("select spend_gate.revoke_grant('camp_h3','test')");
  });

  it("H: an expired grant refuses new reservations and enrollments (the window is the database's clock)", () => {
    db.sql("select spend_gate.revoke_grant('camp_b','test')");
    db.sql(`select spend_gate.issue_campaign_grant('camp_exp','${TEST}'::uuid,0.0001,0.0001,0.0001,'{provider}',now() - interval '2 hours',now() - interval '1 hour',1,'o','expired')`);
    expect(reserve("x1", 0.0001, "msn_test1")).toEqual({ ok: false, reason: "grant_expired" });
    expect(enroll("msn_test1")).toEqual({ ok: false, reason: "grant_expired" });
    db.sql("select spend_gate.revoke_grant('camp_exp','test')");
    db.sql(`select spend_gate.issue_campaign_grant('camp_future','${TEST}'::uuid,0.0001,0.0001,0.0001,'{provider}',now() + interval '1 hour',now() + interval '2 hours',1,'o','not yet open')`);
    expect(reserve("x2", 0.0001, "msn_test1")).toEqual({ ok: false, reason: "grant_not_open" });
    db.sql("select spend_gate.revoke_grant('camp_future','test')");
    expect(reserve("x3", 0.0001, "msn_test1")).toEqual({ ok: false, reason: "grant_revoked" });
  });

  it("M/O: the money functions and the credit ledger are byte-for-byte what they were before the gate", () => {
    expect(money()).toBe(moneyBefore);
  });

  it("the rollback refuses while a campaign grant exists, and otherwise restores 001's functions exactly", () => {
    expect(() => db.sql(file("003_campaign_scope.rollback.sql"))).toThrow(/campaign grant exists/);
    db.sql("delete from spend_gate.reservations; delete from spend_gate.enrollments; delete from spend_gate.events; delete from spend_gate.grants");
    db.sql(file("003_campaign_scope.rollback.sql"));
    expect(bodies()).toBe(bodies001);
    expect(db.sql("select count(*) from information_schema.columns where table_schema='spend_gate' and table_name='grants' and column_name in ('account_id','max_missions')")).toBe("0");
    // and it can be applied again
    db.sql(file("003_campaign_scope.sql"));
    expect(db.sql(file("004_verify_campaign.sql")).split("\n").filter((r) => !r.endsWith("|t"))).toEqual([]);
    expect(money()).toBe(moneyBefore);
  });

  it("C: 2 workers x 40 parallel reservations of an enrolled mission never take reserved + spent past the campaign's ceiling", async () => {
    issue("camp_c", 0.1, { perOp: 0.01, perMission: 0.1, max: 1 });
    expect(enroll("msn_test1")).toMatchObject({ ok: true });
    const tasks = Array.from({ length: 80 }, (_, i) => db.sqlAsync(`${S} select public.spend_reserve('p${i}','${i % 2 ? "model" : "provider"}','x',0.005,'msn_test1',60)`).then((s) => JSON.parse(s)));
    const results = await Promise.all(tasks);
    const ok = results.filter((r) => r.ok);
    expect(ok.length).toBe(20);
    expect(results.filter((r) => !r.ok).every((r) => r.reason === "over_ceiling" || r.reason === "over_mission_ceiling")).toBe(true);
    expect(Number(db.sql("select reserved_usd + spent_usd from spend_gate.grants where id = 'camp_c'"))).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it("G: a worker restart cannot reset campaign spending: it lives in the database, and the same grant keeps counting", () => {
    const before = sr("public.spend_status()");
    // a new connection (a restarted worker) sees the same totals; nothing it can call lowers them
    const again = sr("public.spend_status()");
    expect(again).toEqual(before);
    expect(() => db.sql(`${S} update spend_gate.grants set reserved_usd = 0, spent_usd = 0`)).toThrow(/permission denied/);
    expect(again.campaign_used_usd).toBeGreaterThanOrEqual(again.reserved_usd + again.spent_usd);
  });
});
