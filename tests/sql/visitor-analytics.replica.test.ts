import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replicaAvailable, startReplica, type ReplicaDb } from "../helpers/replicaDb";

/**
 * The visitor-analytics proposal docs/proposals/visitor-analytics/ on a REAL local PostgreSQL (the production schema as a base): the steps in their apply order,
 * what each role can and cannot do, the checks of the table, every step applied twice, and the rollbacks in the reverse order. Nothing here touches Supabase.
 * It also shows that the proposal changes no existing function and no money table. Skipped visibly when no local PostgreSQL server is installed.
 */
const DIR = path.resolve(__dirname, "../../docs/proposals/visitor-analytics");
const file = (name: string) => readFileSync(path.join(DIR, name), "utf8");
const STEPS = ["01_visitor_events_table.sql", "02_visitor_events_indexes.sql", "03_visitor_events_access.sql"];
const ROLLBACKS = ["03_visitor_events_access.rollback.sql", "02_visitor_events_indexes.rollback.sql", "01_visitor_events_table.rollback.sql"];
const VISITOR = "a".repeat(32);
const SESSION = "b".repeat(24);
const GOOD = `INSERT INTO public.visitor_events (visitor_id, session_id, kind, path, device_class) VALUES ('${VISITOR}', '${SESSION}', 'view', '/pricing', 'mobile')`;

describe.skipIf(!replicaAvailable())("the visitor analytics proposal on a real PostgreSQL", () => {
  let db: ReplicaDb;
  const asRole = async (role: string, sql: string) => {
    const client = await db.pool.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      return await client.query(sql);
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
  };
  const functionsDigest = async () => (await db.pool.query("select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.oid::regprocedure::text)) as m from pg_proc p where p.pronamespace = 'public'::regnamespace")).rows[0].m as string;
  const ledgerCount = async () => Number((await db.pool.query("select count(*)::int as n from public.credit_ledger")).rows[0].n);
  const statements = (name: string) => file(name).split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);

  let functionsBefore = "";
  let ledgerBefore = 0;

  beforeAll(async () => {
    db = await startReplica();
    await db.reset({});
    // as on Supabase: the API roles can use the schema, so what stops them is the table's own privileges and RLS
    await db.exec("GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; ALTER ROLE service_role BYPASSRLS");
    functionsBefore = await functionsDigest();
    ledgerBefore = await ledgerCount();
  }, 120_000);
  afterAll(async () => { await db?.stop(); });

  it("BEFORE: the table does not exist (the verification query of step 0 returns no row)", async () => {
    const [exists] = statements("00_verify_before_apply.sql");
    expect((await db.pool.query(`${exists};`)).rows).toHaveLength(0);
  });

  it("the steps apply in order, and each one can be applied twice", async () => {
    for (const step of STEPS) await db.exec(file(step));
    for (const step of STEPS) await db.exec(file(step));
    expect(Number((await db.pool.query("select count(*)::int as n from information_schema.tables where table_schema='public' and table_name='visitor_events'")).rows[0].n)).toBe(1);
  });

  it("the columns hold no address, no agent, no query, no body, no e-mail and no token; the user id is the only link to an account", async () => {
    const columns = (await db.pool.query("select column_name from information_schema.columns where table_schema='public' and table_name='visitor_events' order by ordinal_position")).rows.map((row) => row.column_name);
    expect(columns).toEqual(["id", "visitor_id", "session_id", "kind", "path", "referrer_host", "country", "device_class", "started_at", "duration_seconds", "user_id"]);
    for (const forbidden of ["ip", "ip_address", "user_agent", "ua", "query", "body", "email", "token", "fingerprint", "referrer"]) expect(columns).not.toContain(forbidden);
  });

  it("RLS is on with NO policy; anon, authenticated and PUBLIC have no privilege; service_role can read, insert and delete (the checks of the verify file)", async () => {
    const [, rls, privileges] = statements("04_verify_after_apply.sql");
    const rlsRow = (await db.pool.query(`${rls};`)).rows[0];
    expect(rlsRow).toMatchObject({ rls_enabled: true });
    expect(Number(rlsRow.policies)).toBe(0);
    expect((await db.pool.query(`${privileges};`)).rows[0]).toEqual({ anon_any: false, authenticated_any: false, public_any: false, service_role_select: true, service_role_insert: true, service_role_delete: true });
    for (const role of ["anon", "authenticated"]) {
      await expect(asRole(role, "select * from public.visitor_events")).rejects.toThrow(/permission denied/);
      await expect(asRole(role, GOOD)).rejects.toThrow(/permission denied/);
      await expect(asRole(role, "delete from public.visitor_events")).rejects.toThrow(/permission denied/);
    }
  });

  it("service_role writes a valid row; the checks refuse a query string, a bad id, an unknown kind, a long path, a lower-case country and a negative time", async () => {
    await asRole("service_role", GOOD);
    await asRole("service_role", `INSERT INTO public.visitor_events (visitor_id, session_id, kind, path, device_class, country, referrer_host, duration_seconds, user_id) VALUES ('${VISITOR}', '${SESSION}', 'leave', '/pricing', 'desktop', 'EG', 'google.com', 42, NULL)`);
    const bad = (extra: string) => `INSERT INTO public.visitor_events (visitor_id, session_id, kind, path, device_class${extra.split("|")[0]}) VALUES ('${VISITOR}', '${SESSION}', 'view', '/x', 'mobile'${extra.split("|")[1] ?? ""})`;
    const refused = [
      `INSERT INTO public.visitor_events (visitor_id, session_id, kind, path, device_class) VALUES ('${VISITOR}', '${SESSION}', 'view', '/pricing?plan=a', 'mobile')`,
      `INSERT INTO public.visitor_events (visitor_id, session_id, kind, path, device_class) VALUES ('not-hex', '${SESSION}', 'view', '/x', 'mobile')`,
      `INSERT INTO public.visitor_events (visitor_id, session_id, kind, path, device_class) VALUES ('${VISITOR}', '${SESSION}', 'click', '/x', 'mobile')`,
      `INSERT INTO public.visitor_events (visitor_id, session_id, kind, path, device_class) VALUES ('${VISITOR}', '${SESSION}', 'view', '/${"a".repeat(130)}', 'mobile')`,
      `INSERT INTO public.visitor_events (visitor_id, session_id, kind, path, device_class) VALUES ('${VISITOR}', '${SESSION}', 'view', 'pricing', 'mobile')`,
      `INSERT INTO public.visitor_events (visitor_id, session_id, kind, path, device_class) VALUES ('${VISITOR}', '${SESSION}', 'view', '/x', 'watch')`,
      bad(", country|, 'eg'"),
      bad(", duration_seconds|, -1"),
    ];
    for (const sql of refused) await expect(asRole("service_role", sql), sql.slice(0, 90)).rejects.toThrow(/violates check constraint/);
    expect(Number((await db.pool.query("select count(*)::int as n from public.visitor_events")).rows[0].n)).toBe(2);
  });

  it("the indexes of step 2 exist; the verify file lists them", async () => {
    const names = (await db.pool.query("select indexname from pg_indexes where schemaname='public' and tablename='visitor_events' order by indexname")).rows.map((row) => row.indexname);
    expect(names).toEqual(["visitor_events_kind_started_at_idx", "visitor_events_pkey", "visitor_events_session_idx", "visitor_events_started_at_idx", "visitor_events_user_idx", "visitor_events_visitor_idx"]);
  });

  it("the proposal changes NO existing function and NO money table", async () => {
    expect(await functionsDigest()).toBe(functionsBefore);
    expect(await ledgerCount()).toBe(ledgerBefore);
  });

  it("the rollbacks in the reverse order remove the indexes, the access and the table; the steps can then be applied again", async () => {
    for (const rollback of ROLLBACKS) await db.exec(file(rollback));
    expect(Number((await db.pool.query("select count(*)::int as n from information_schema.tables where table_schema='public' and table_name='visitor_events'")).rows[0].n)).toBe(0);
    expect(await functionsDigest()).toBe(functionsBefore);
    for (const step of STEPS) await db.exec(file(step));
    expect((await asRole("service_role", GOOD)).rowCount).toBe(1);
    // the access rollback alone never opens the table to anon or authenticated
    await db.exec(file(ROLLBACKS[0]));
    for (const role of ["anon", "authenticated"]) await expect(asRole(role, "select * from public.visitor_events")).rejects.toThrow(/permission denied/);
  });
});
