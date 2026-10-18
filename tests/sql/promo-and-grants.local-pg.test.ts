import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDb, scratchPgTarget, type ScratchDb } from "./localPg";

/**
 * Runs the real migration SQL on a scratch Postgres (set DIGR_TEST_PG). Skipped when none is configured.
 * It never touches Supabase.
 */
const ADMIN = "00000000-0000-0000-0000-0000000000a1";
const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const S = "SET ROLE service_role;";
const json = (db: ScratchDb, call: string) => JSON.parse(db.sql(`${S} select ${call}`));
const jsonAsync = async (db: ScratchDb, call: string) => JSON.parse(await db.sqlAsync(`${S} select ${call}`));

describe.skipIf(!scratchPgTarget())("promo codes, admin grants and credit kinds on a real Postgres", () => {
  let db: ScratchDb;
  beforeAll(() => {
    db = createScratchDb();
    const users = Array.from({ length: 80 }, (_, i) => `('${uid(100 + i)}','u${i}@t','{}')`).join(",");
    db.sql(`INSERT INTO auth.users (id,email,raw_app_meta_data) VALUES ('${ADMIN}','admin@t','{"role":"admin"}'),('${uid(1)}','plain@t','{}'),${users}`);
    db.sql("INSERT INTO public.profiles (id,email) SELECT id,email FROM auth.users ON CONFLICT DO NOTHING");
  }, 120000);
  afterAll(() => db?.drop());

  const balance = (user: string) => Number(db.sql(`select coalesce(sum(delta),0) from credit_ledger where user_id='${user}'`));
  const save = (code: string, points = 500, max = 10, extra = "null,null,true") =>
    json(db, `public.admin_save_promo_code_atomic('${ADMIN}','${code}',${points},${max},${extra},'note')`);

  it("a non-admin cannot create a code or grant credit, even calling the functions directly", () => {
    expect(json(db, `public.admin_save_promo_code_atomic('${uid(1)}','HACK',999,5,null,null,true,'x')`).error).toBe("not_admin");
    expect(json(db, `public.admin_grant_credit_atomic('${uid(1)}','${uid(1)}',999,'self grant','req-selfgrant1')`).error).toBe("not_admin");
    expect(json(db, `public.admin_grant_credit_atomic(NULL,'${uid(1)}',999,'self grant','req-selfgrant2')`).error).toBe("not_admin");
    expect(balance(uid(1))).toBe(0);
    expect(db.sql("select count(*) from promo_codes where code='HACK'")).toBe("0");
  });

  it("one account cannot redeem one code twice: the repeat is refused and credits nothing", () => {
    expect(save("ONCE", 500, 10).success).toBe(true);
    const first = json(db, `public.redeem_promo_code_atomic('${uid(101)}','once')`);
    expect(first).toMatchObject({ success: true, points: 500, balance: 500 });
    const again = json(db, `public.redeem_promo_code_atomic('${uid(101)}','ONCE')`);
    expect(again).toMatchObject({ success: false, error: "already_redeemed", balance: 500 });
    expect(again.error_ar).toMatch(/من قبل/);
    expect(balance(uid(101))).toBe(500);
  });

  it("parallel redemptions by many accounts never exceed max_redemptions", async () => {
    expect(save("RACE7", 100, 7).success).toBe(true);
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => jsonAsync(db, `public.redeem_promo_code_atomic('${uid(110 + i)}','RACE7')`)),
    );
    const ok = results.filter((r) => r.success);
    expect(ok).toHaveLength(7);
    expect(results.filter((r) => r.error === "code_exhausted")).toHaveLength(18);
    expect(db.sql("select count(*) from promo_redemptions where code='RACE7'")).toBe("7");
    expect(db.sql("select count(*) from credit_ledger where id like 'promo_RACE7_%'")).toBe("7");
    expect(db.sql("select coalesce(sum(delta),0) from credit_ledger where id like 'promo_RACE7_%'")).toBe("700");
  }, 60000);

  it("parallel redemptions of one code by one account credit exactly once", async () => {
    expect(save("SOLO", 40, 50).success).toBe(true);
    const results = await Promise.all(Array.from({ length: 8 }, () => jsonAsync(db, `public.redeem_promo_code_atomic('${uid(140)}','SOLO')`)));
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(balance(uid(140))).toBe(40);
  }, 60000);

  it("refuses inactive, not-yet-started, expired and unknown codes with an Arabic reason", () => {
    expect(save("OFFCODE", 10, 5, "null,null,false").success).toBe(true);
    expect(save("FUTURE", 10, 5, "now() + interval '1 day',null,true").success).toBe(true);
    expect(save("PAST", 10, 5, "now() - interval '2 days',now() - interval '1 day',true").success).toBe(true);
    const cases: Array<[string, string]> = [["OFFCODE", "code_inactive"], ["FUTURE", "code_not_started"], ["PAST", "code_expired"], ["MISSING", "code_not_found"], ["x", "invalid_code"]];
    for (const [code, error] of cases) {
      const r = json(db, `public.redeem_promo_code_atomic('${uid(141)}','${code}')`);
      expect(r.success).toBe(false);
      expect(r.error).toBe(error);
      expect(r.error_ar).toMatch(/[؀-ۿ]/);
    }
    expect(balance(uid(141))).toBe(0);
  });

  it("admin credit is idempotent by request id, positive only, and a reused id for another user is refused", async () => {
    const call = (user: string, pts: number, req: string) =>
      `public.admin_grant_credit_atomic('${ADMIN}','${user}',${pts},'gift for a tester','${req}')`;
    const results = await Promise.all(Array.from({ length: 6 }, () => jsonAsync(db, call(uid(142), 25, "req-parallel-1"))));
    expect(results.every((r) => r.success)).toBe(true);
    expect(results.filter((r) => r.already_granted === false)).toHaveLength(1);
    expect(balance(uid(142))).toBe(25);
    expect(json(db, call(uid(142), -5, "req-negative-1")).error).toBe("invalid_amount");
    expect(json(db, call(uid(142), 0, "req-zero-0001")).error).toBe("invalid_amount");
    expect(json(db, call(uid(142), 1.5, "req-fraction1")).error).toBe("invalid_amount");
    expect(json(db, call(uid(143), 25, "req-parallel-1")).error).toBe("request_id_conflict");
    expect(json(db, `public.admin_grant_credit_atomic('${ADMIN}','${uid(142)}',5,'ab','req-shortnote')`).error).toBe("invalid_note");
    expect(balance(uid(143))).toBe(0);
  }, 60000);

  it("a cap cannot be lowered below the redemptions already made", () => {
    expect(json(db, `public.admin_save_promo_code_atomic('${ADMIN}','RACE7',100,3,null,null,true,'n')`).error).toBe("max_below_used");
  });

  it("every row has a kind; legacy top-ups stay real income; balance is still SUM(delta)", () => {
    db.sql(`INSERT INTO credit_ledger (id,user_id,delta,type,topup_id,note) VALUES ('top_legacy1','${uid(150)}',300,'topup','legacy1','old'),('grt_legacy1','${uid(150)}',100,'grant',null,'old manual')`);
    db.sql(`INSERT INTO credit_ledger (id,user_id,delta,type,job_id) VALUES ('res_job_x','${uid(150)}',-50,'reserve','job_x'),('chg_job_x','${uid(150)}',-30,'charge','job_x'),('rel_job_x','${uid(150)}',50,'release','job_x')`);
    const kinds = db.sql(`${S} select id||'='||kind from credit_ledger_typed where user_id='${uid(150)}' order by id`);
    expect(kinds.split("\n")).toEqual(expect.arrayContaining([
      "top_legacy1=topup_instapay", "grt_legacy1=admin_grant", "res_job_x=reserve", "chg_job_x=charge", "rel_job_x=release",
    ]));
    expect(db.sql(`${S} select kind from credit_ledger_typed where id='promo_ONCE_${uid(101)}'`).split("\n").pop()).toBe("promo_code");
    expect(db.sql(`${S} select kind from credit_ledger_typed where id='adm_req-parallel-1'`).split("\n").pop()).toBe("admin_grant");
    expect(balance(uid(150))).toBe(370);
    expect(db.sql(`${S} select sum(delta) from credit_ledger_typed`).split("\n").pop()).toBe(db.sql("select sum(delta) from credit_ledger"));
    expect(db.sql(`${S} select count(*) from credit_ledger_typed`).split("\n").pop()).toBe(db.sql("select count(*) from credit_ledger"));
    expect(db.sql(`select actor_id from credit_ledger_kinds where ledger_id='adm_req-parallel-1'`)).toBe(ADMIN);
  });

  it("the ledger and the kind records stay append-only", () => {
    expect(() => db.sql("UPDATE credit_ledger SET delta = 1")).toThrow();
    expect(() => db.sql("DELETE FROM credit_ledger_kinds")).toThrow();
    expect(() => db.sql("UPDATE credit_ledger_kinds SET kind='promo_code'")).toThrow();
  });

  it("the new functions are service_role only, security definer, with a pinned search_path", () => {
    const rows = db.sql(`select p.proname||'|'||p.prosecdef::text||'|'||has_function_privilege('anon',p.oid,'EXECUTE')::text||'|'||has_function_privilege('authenticated',p.oid,'EXECUTE')::text||'|'||has_function_privilege('service_role',p.oid,'EXECUTE')::text||'|'||coalesce(array_to_string(p.proconfig,','),'') from pg_proc p where p.proname in ('redeem_promo_code_atomic','admin_grant_credit_atomic','admin_save_promo_code_atomic') order by 1`).split("\n");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const [, definer, anon, authenticated, service, config] = row.split("|");
      expect([definer, anon, authenticated, service]).toEqual(["true", "false", "false", "true"]);
      expect(config).toContain("search_path=public, pg_temp");
    }
  });

  it("customers cannot read or write promo tables, kinds or the typed view directly", () => {
    for (const table of ["promo_codes", "promo_redemptions", "credit_ledger_kinds", "credit_ledger_typed", "support_messages"]) {
      expect(db.sql(`select has_table_privilege('authenticated','public.${table}','SELECT')::text||has_table_privilege('anon','public.${table}','SELECT')::text`)).toBe("falsefalse");
    }
  });
});
