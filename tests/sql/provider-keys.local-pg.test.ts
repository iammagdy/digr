import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptProviderKey } from "../../src/lib/server/providerKeyCrypto";
import { createScratchDb, scratchPgTarget, type ScratchDb } from "./localPg";

/**
 * Runs the real provider-key migration SQL on a scratch Postgres (set DIGR_TEST_PG). Skipped when none is configured.
 * It never touches Supabase and uses only made-up values that look like ciphertext, never a real key.
 */
const ADMIN = "00000000-0000-0000-0000-0000000000a1";
const PLAIN = "00000000-0000-0000-0000-000000000001";
const S = "SET ROLE service_role;";
const json = (db: ScratchDb, call: string) => JSON.parse(db.sql(`${S} select ${call}`));
const jsonAsync = async (db: ScratchDb, call: string) => JSON.parse(await db.sqlAsync(`${S} select ${call}`));

/** Same shape the application writes: v1.<nonce 16>.<ciphertext>.<tag 22>, base64url. */
const pad = (n: number) => String(n).padStart(2, "0");
const fakeCipher = (n: number) => `v1.${"A".repeat(14)}${pad(n)}.${"B".repeat(40)}${pad(n)}.${"C".repeat(20)}${pad(n)}`;
const set = (db: ScratchDb, admin: string, provider: string, n: number, last4 = "wxyz") =>
  json(db, `public.admin_set_provider_key_atomic('${admin}','${provider}','${fakeCipher(n)}','${last4}')`);

describe.skipIf(!scratchPgTarget())("encrypted provider key store on a real Postgres", () => {
  let db: ScratchDb;
  beforeAll(() => {
    db = createScratchDb();
    db.sql(`INSERT INTO auth.users (id,email,raw_app_meta_data) VALUES ('${ADMIN}','admin@t','{"role":"admin"}'),('${PLAIN}','plain@t','{}')`);
  }, 120000);
  afterAll(() => db?.drop());

  it("a non-admin cannot set or roll back a key, even calling the functions directly", () => {
    expect(set(db, PLAIN, "treg", 1).error).toBe("not_admin");
    expect(json(db, `public.admin_set_provider_key_atomic(NULL,'treg','${fakeCipher(1)}','wxyz')`).error).toBe("not_admin");
    expect(json(db, `public.admin_rollback_provider_key_atomic('${PLAIN}','treg')`).error).toBe("not_admin");
    expect(db.sql("select count(*) from provider_api_keys")).toBe("0");
    expect(db.sql("select count(*) from provider_key_audit")).toBe("0");
  });

  it("refuses unknown providers, plaintext-looking values and bad last4", () => {
    expect(set(db, ADMIN, "openai", 1).error).toBe("invalid_provider");
    expect(json(db, `public.admin_set_provider_key_atomic('${ADMIN}','treg','sk-live-not-ciphertext-at-all','wxyz')`).error).toBe("invalid_ciphertext");
    expect(json(db, `public.admin_set_provider_key_atomic('${ADMIN}','treg','${fakeCipher(1)}','toolong')`).error).toBe("invalid_last4");
    expect(json(db, `public.admin_set_provider_key_atomic('${ADMIN}','treg','${fakeCipher(1)}','a b')`).error).toBe("invalid_last4");
    expect(db.sql("select count(*) from provider_api_keys")).toBe("0");
  });

  it("an admin sets a key; the next set keeps the old one as previous; the audit trail records last4 only", () => {
    expect(set(db, ADMIN, "treg", 1, "aaaa")).toMatchObject({ success: true, version: 1, last4: "aaaa" });
    expect(set(db, ADMIN, "treg", 2, "bbbb")).toMatchObject({ success: true, version: 2, last4: "bbbb" });
    const row = db.sql("select active_ciphertext, active_last4, previous_ciphertext, previous_last4, version from provider_api_keys where provider='treg'").split("|");
    expect(row).toEqual([fakeCipher(2), "bbbb", fakeCipher(1), "aaaa", "2"]);
    const audit = db.sql("select provider, action, last4, actor_id from provider_key_audit order by id");
    expect(audit.split("\n")).toEqual([`treg|set|aaaa|${ADMIN}`, `treg|set|bbbb|${ADMIN}`]);
    expect(db.sql("select count(*) from provider_key_audit where last4 is null or char_length(last4) > 4")).toBe("0");
    // another provider is independent
    expect(set(db, ADMIN, "anthropic", 3, "cccc").version).toBe(1);
  });

  it("one-step rollback swaps active and previous and is audited", () => {
    const r = json(db, `public.admin_rollback_provider_key_atomic('${ADMIN}','treg')`);
    expect(r).toMatchObject({ success: true, version: 3, last4: "aaaa" });
    expect(db.sql("select active_ciphertext, previous_ciphertext from provider_api_keys where provider='treg'").split("|")).toEqual([fakeCipher(1), fakeCipher(2)]);
    expect(db.sql("select action, last4 from provider_key_audit order by id desc limit 1")).toBe("rollback|aaaa");
    expect(json(db, `public.admin_rollback_provider_key_atomic('${ADMIN}','anthropic')`).error).toBe("no_previous_key");
  });

  it("the audit table is append-only: UPDATE and DELETE are blocked by the trigger", () => {
    expect(() => db.sql(`${S} update provider_key_audit set last4='zzzz'`)).toThrow(/append-only/);
    expect(() => db.sql(`${S} delete from provider_key_audit`)).toThrow(/append-only/);
    expect(Number(db.sql("select count(*) from provider_key_audit"))).toBeGreaterThanOrEqual(4);
  });

  it("anon and authenticated have no access to the tables or the functions", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["provider_api_keys", "provider_key_audit"]) {
        expect(db.sql(`select has_table_privilege('${role}','public.${table}','SELECT') or has_table_privilege('${role}','public.${table}','INSERT') or has_table_privilege('${role}','public.${table}','UPDATE') or has_table_privilege('${role}','public.${table}','DELETE')`)).toBe("f");
      }
      expect(db.sql(`select has_function_privilege('${role}','public.admin_set_provider_key_atomic(uuid,text,text,text)','EXECUTE') or has_function_privilege('${role}','public.admin_rollback_provider_key_atomic(uuid,text)','EXECUTE')`)).toBe("f");
      expect(() => db.sql(`SET ROLE ${role}; select * from provider_api_keys`)).toThrow(/permission denied/);
    }
  });

  it("the functions are SECURITY DEFINER with a pinned search_path and the tables have RLS on", () => {
    const rows = db.sql("select proname, prosecdef, proconfig::text from pg_proc where proname in ('admin_set_provider_key_atomic','admin_rollback_provider_key_atomic') order by proname").split("\n");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatch(/\|t\|/);
      expect(row).toMatch(/search_path=public, pg_temp/);
    }
    expect(db.sql("select relrowsecurity from pg_class where oid='public.provider_api_keys'::regclass")).toBe("t");
    expect(db.sql("select relrowsecurity from pg_class where oid='public.provider_key_audit'::regclass")).toBe("t");
  });

  it("parallel sets are serialized: versions are consecutive and every set is audited", async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => jsonAsync(db, `public.admin_set_provider_key_atomic('${ADMIN}','anthropic','${fakeCipher(10 + i)}','p${i}')`)));
    expect(db.sql("select version from provider_api_keys where provider='anthropic'")).toBe("7");
    expect(db.sql("select count(*) from provider_key_audit where provider='anthropic' and action='set'")).toBe("7");
  }, 60000);

  it("real application ciphertext (the longest accepted key) passes the function format check", () => {
    const env = { PROVIDER_KEYS_ENCRYPTION_KEY: randomBytes(32).toString("base64") } as unknown as NodeJS.ProcessEnv;
    const longest = encryptProviderKey("anthropic", "k".repeat(400), env);
    const shortest = encryptProviderKey("anthropic", "k".repeat(12), env);
    expect(longest.length).toBeLessThanOrEqual(1300);
    expect(json(db, `public.admin_set_provider_key_atomic('${ADMIN}','anthropic','${longest}','kkkk')`).success).toBe(true);
    expect(json(db, `public.admin_set_provider_key_atomic('${ADMIN}','anthropic','${shortest}','kkkk')`).success).toBe(true);
  });

  it("deleting an admin account is not blocked by the append-only audit table", () => {
    const tmp = "00000000-0000-0000-0000-0000000000b2";
    db.sql(`INSERT INTO auth.users (id,email,raw_app_meta_data) VALUES ('${tmp}','tmp-admin@t','{"role":"admin"}')`);
    expect(json(db, `public.admin_set_provider_key_atomic('${tmp}','anthropic','${fakeCipher(40)}','tmpk')`).success).toBe(true);
    db.sql("UPDATE provider_api_keys SET active_set_by = NULL WHERE active_set_by = '" + tmp + "'");
    db.sql(`DELETE FROM public.profiles WHERE id = '${tmp}'`);
    db.sql(`DELETE FROM auth.users WHERE id = '${tmp}'`);
    expect(db.sql(`select count(*) from provider_key_audit where actor_id = '${tmp}'`)).toBe("1");
  });
});
