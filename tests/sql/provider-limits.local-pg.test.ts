import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDb, scratchPgTarget, type ScratchDb } from "./localPg";

/** Runs the real provider-limits migration SQL on a scratch Postgres (set DIGR_TEST_PG). Skipped when none is set. */
const ADMIN = "00000000-0000-0000-0000-0000000000a1";
const PLAIN = "00000000-0000-0000-0000-000000000001";
const S = "SET ROLE service_role;";
const call = (db: ScratchDb, admin: string | null, limits: string) =>
  JSON.parse(db.sql(`${S} select public.admin_set_provider_limits_atomic(${admin ? `'${admin}'` : "NULL"}, '${limits}'::jsonb)`));

describe.skipIf(!scratchPgTarget())("provider limits store on a real Postgres", () => {
  let db: ScratchDb;
  beforeAll(() => {
    db = createScratchDb();
    db.sql(`INSERT INTO auth.users (id,email,raw_app_meta_data) VALUES ('${ADMIN}','admin@t','{"role":"admin"}'),('${PLAIN}','plain@t','{}')`);
  }, 120000);
  afterAll(() => db?.drop());

  it("a non-admin (or no admin id) cannot change the limits, even calling the function directly", () => {
    expect(call(db, PLAIN, '{"dailyUsd": 5}').error).toBe("not_admin");
    expect(call(db, null, '{"dailyUsd": 5}').error).toBe("not_admin");
    expect(db.sql("select count(*) from settings_private where key='provider_limits'")).toBe("0");
    expect(db.sql("select count(*) from provider_limits_audit")).toBe("0");
  });

  it("rejects non-numbers, negatives, unknown keys and a percent above 100", () => {
    expect(call(db, ADMIN, '{"dailyUsd": "abc"}').error).toBe("not_a_number");
    expect(call(db, ADMIN, '{"dailyUsd": -1}').error).toBe("negative");
    expect(call(db, ADMIN, '{"secret": 1}').error).toBe("unknown_key");
    expect(call(db, ADMIN, '{"warnPercent": 101}').error).toBe("percent_range");
    expect(call(db, ADMIN, '{}').error).toBe("invalid_limits");
    expect(db.sql("select count(*) from provider_limits_audit")).toBe("0");
  });

  it("an admin sets limits: stored in settings_private, audited with old and new value", () => {
    const first = call(db, ADMIN, '{"dailyUsd": 1.5, "warnPercent": 80, "perJobUsd": 0.05}');
    expect(first.success).toBe(true);
    expect(first.limits).toEqual({ dailyUsd: 1.5, warnPercent: 80, perJobUsd: 0.05 });
    const second = call(db, ADMIN, '{"dailyUsd": 2, "perJobUsd": null, "perUserDailyUsd": 0.3}');
    expect(second.limits).toEqual({ dailyUsd: 2, warnPercent: 80, perUserDailyUsd: 0.3 });
    expect(JSON.parse(db.sql("select value from settings_private where key='provider_limits'"))).toEqual({ dailyUsd: 2, warnPercent: 80, perUserDailyUsd: 0.3 });
    const audit = db.sql("select actor_id, old_value is null, (new_value->>'dailyUsd') from provider_limits_audit order by id").split("\n");
    expect(audit).toEqual([`${ADMIN}|t|1.5`, `${ADMIN}|f|2`]);
    const old = JSON.parse(db.sql("select old_value from provider_limits_audit order by id desc limit 1"));
    expect(old).toEqual({ dailyUsd: 1.5, warnPercent: 80, perJobUsd: 0.05 });
  });

  it("a huge value works", () => {
    const r = call(db, ADMIN, '{"dailyUsd": 999999999999}');
    expect(r.success).toBe(true);
    expect(Number(r.limits.dailyUsd)).toBe(999999999999);
    expect(call(db, ADMIN, '{"dailyUsd": 1e13}').error).toBe("too_large");
  });

  it("the audit table is append-only (UPDATE and DELETE are blocked)", () => {
    expect(() => db.sql("update provider_limits_audit set actor_id = null")).toThrow(/append-only/);
    expect(() => db.sql("delete from provider_limits_audit")).toThrow(/append-only/);
  });

  it("the function is service_role only, security definer, with a pinned search_path", () => {
    const row = db.sql("select prosecdef, array_to_string(proconfig, ',') from pg_proc where proname='admin_set_provider_limits_atomic'");
    expect(row).toContain("t|");
    expect(row).toContain("search_path=public, pg_temp");
    expect(db.sql("select has_function_privilege('anon','public.admin_set_provider_limits_atomic(uuid,jsonb)','execute')")).toBe("f");
    expect(db.sql("select has_function_privilege('authenticated','public.admin_set_provider_limits_atomic(uuid,jsonb)','execute')")).toBe("f");
    expect(db.sql("select has_function_privilege('service_role','public.admin_set_provider_limits_atomic(uuid,jsonb)','execute')")).toBe("t");
    expect(db.sql("select has_table_privilege('authenticated','public.provider_limits_audit','select')")).toBe("f");
  });
});
