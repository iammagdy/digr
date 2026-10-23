import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDb, scratchPgTarget, type ScratchDb } from "./localPg";

/**
 * The job-cap proposal (docs/proposals/job-cap-balance/) run on a REAL scratch PostgreSQL 16 (set DIGER_TEST_PG; skipped otherwise; never Supabase):
 * every repository migration first (the baseline = what is live), then the proposal steps, at the OLD cap (policy «fixed» 600) and at a NEW cap
 * (policy «balance», floor 600, ceiling 3000), then the rollbacks. Money rules checked: the charge is ceil(delivered x unit price) and never above the
 * reserve, the ledger stays append-only, and only service_role can run any of it.
 */
const DIR = path.resolve(__dirname, "../../docs/proposals/job-cap-balance");
const file = (name: string) => readFileSync(path.join(DIR, name), "utf8");
const ADMIN = "00000000-0000-0000-0000-0000000000a1";
const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const S = "SET ROLE service_role;";
const FN = {
  quote: "public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])",
  settle: "public.settle_job_atomic(text,numeric,text)",
  people: "public.settle_people_job_atomic(text,integer,integer,integer,numeric,text)",
};

describe.skipIf(!scratchPgTarget())("job cap proposal on a real Postgres", () => {
  let db: ScratchDb;
  const def = (fn: string) => db.sql(`select md5(pg_get_functiondef('${fn}'::regprocedure))`);
  const json = (call: string) => JSON.parse(db.sql(`${S} select ${call}`));
  const balance = (user: string) => Number(db.sql(`select coalesce(sum(delta),0) from credit_ledger where user_id='${user}'`));
  const ledgerRows = () => Number(db.sql("select count(*) from credit_ledger"));
  let quoteSeq = 0;
  const quote = (user: string, points: number) => {
    quoteSeq += 1;
    return json(`public.create_quote_atomic('${user}'::uuid,'q_cap_${quoteSeq}','hash_${quoteSeq}','[{"capabilitySlug":"social-facebook-comments"}]'::jsonb,${points},ARRAY['xlsx'],now()+interval '1 hour',ARRAY[]::text[])`);
  };
  const policy = (patch: string) => json(`public.admin_set_job_cap_policy_atomic('${ADMIN}','${patch}'::jsonb)`);
  const topup = (user: string, points: number) => db.sql(`insert into credit_ledger(id,user_id,delta,type,note) values ('tp_${user}_${points}_${Math.random().toString(36).slice(2, 8)}','${user}',${points},'topup','fixture')`);
  /** A running job that has collected everything, with its reserve held (a fixture, as the worker leaves it before settlement). */
  const runningJob = (id: string, user: string, reserve: number, delivered: number, unitPrice: number) => {
    db.sql(`insert into jobs(id,user_id,status,endpoint_id,target_volume_max,reserved_credits,delivered_units,current_cursor,unit_price) values ('${id}','${user}','running','x',${delivered},${reserve},${delivered},'completed',${unitPrice})`);
    db.sql(`insert into credit_ledger(id,user_id,delta,type,job_id,note) values ('res_${id}','${user}',-${reserve},'reserve','${id}','fixture')`);
  };

  beforeAll(() => {
    db = createScratchDb();
    const users = [1, 2, 3, 4].map((n) => `('${uid(n)}','u${n}@t','{}')`).join(",");
    db.sql(`INSERT INTO auth.users (id,email,raw_app_meta_data) VALUES ('${ADMIN}','admin@t','{"role":"admin"}'),${users}`);
    db.sql("INSERT INTO public.profiles (id,email) SELECT id,email FROM auth.users ON CONFLICT DO NOTHING");
    topup(uid(1), 2500); // rich enough for 2,500
    topup(uid(2), 100); // below the floor
    topup(uid(3), 9000); // above the ceiling
  }, 180000);
  afterAll(() => db?.drop());

  const baseline = {} as Record<string, string>;

  it("BASELINE (what is live today): a quote of 601 is refused, and a settlement cuts the charge of a larger reserve at 600", () => {
    for (const [name, fn] of Object.entries(FN)) baseline[name] = def(fn);
    expect(() => quote(uid(3), 601)).toThrow(/between 0 and 600 points/);
    expect(quote(uid(3), 600).success).toBe(true);
    // a job whose reserve is 2,000 (as it would be under a higher cap) is under-charged by the old settlement: 1,800 owed, 600 charged
    runningJob("job_old_1", uid(3), 2000, 1800, 1);
    const settled = json("public.settle_job_atomic('job_old_1', 600, null)");
    expect(settled).toMatchObject({ success: true, reserved_credits: 2000, charged_credits: 600 });
  });

  it("applies steps 1 to 4 in order; with the policy «fixed» 600 nothing changes", () => {
    for (const step of ["01_job_cap_policy.sql", "02_create_quote_atomic_policy_cap.sql", "03_settle_job_atomic_no_fixed_cap.sql", "04_settle_people_job_atomic_no_fixed_cap.sql"]) db.sql(file(step));
    expect(JSON.parse(db.sql("select value from settings_private where key='job_cap_policy'"))).toEqual({ mode: "fixed", fixedCap: 600, balanceFloor: 600, balanceCeiling: 600 });
    for (const user of [uid(1), uid(2), uid(3)]) expect(Number(db.sql(`${S} select public.job_points_cap_for('${user}')`))).toBe(600);
    // the OLD cap, through the new code path
    expect(() => quote(uid(3), 601)).toThrow(/between 0 and 600 points/);
    expect(quote(uid(3), 600).success).toBe(true);
    expect(quote(uid(2), 238).success).toBe(true);
  });

  it("a settlement under the old cap is the same number as before: ceil(delivered x unit price), at most the reserve", () => {
    runningJob("job_old_2", uid(2), 238, 100, 1.75);
    expect(json("public.settle_job_atomic('job_old_2', 600, null)")).toMatchObject({ reserved_credits: 238, charged_credits: 175 });
    runningJob("job_old_3", uid(1), 100, 90, 2);
    expect(json("public.settle_job_atomic('job_old_3', 600, null)")).toMatchObject({ reserved_credits: 100, charged_credits: 100 });
  });

  describe("the policy setter", () => {
    it("is admin only, validated, audited and append-only", () => {
      expect(json(`public.admin_set_job_cap_policy_atomic('${uid(1)}','{"mode":"balance"}'::jsonb)`).error).toBe("not_admin");
      expect(json("public.admin_set_job_cap_policy_atomic(NULL,'{\"mode\":\"balance\"}'::jsonb)").error).toBe("not_admin");
      expect(policy('{"mode":"sometimes"}').error).toBe("invalid_mode");
      expect(policy('{"secret":1}').error).toBe("unknown_key");
      expect(policy('{"balanceCeiling":"3000"}').error).toBe("not_a_number");
      expect(policy('{"balanceCeiling":0}').error).toBe("too_small");
      expect(policy('{"balanceCeiling":10001}').error).toBe("too_large");
      expect(policy("{}").error).toBe("invalid_policy");
      expect(policy('{"balanceFloor":4000,"balanceCeiling":3000}').error).toBe("floor_above_ceiling");
      expect(db.sql("select count(*) from job_cap_policy_audit")).toBe("0");
      const ok = policy('{"mode":"balance","balanceFloor":600,"balanceCeiling":3000}');
      expect(ok).toMatchObject({ success: true, policy: { mode: "balance", fixedCap: 600, balanceFloor: 600, balanceCeiling: 3000 } });
      expect(db.sql("select count(*) from job_cap_policy_audit")).toBe("1");
      expect(() => db.sql("update job_cap_policy_audit set actor_id = null")).toThrow(/append-only/);
      expect(() => db.sql("delete from job_cap_policy_audit")).toThrow(/append-only/);
    });
  });

  describe("the NEW cap: the customer's available balance, between the floor (600) and the ceiling (3,000)", () => {
    it("a customer may quote up to the balance they have, not one point more", () => {
      const available = balance(uid(1)); // 2,500 topped up, minus what the earlier fixture jobs cost
      expect(available).toBeGreaterThan(2000);
      expect(Number(db.sql(`${S} select public.job_points_cap_for('${uid(1)}')`))).toBe(available);
      expect(quote(uid(1), available).success).toBe(true);
      expect(() => quote(uid(1), available + 1)).toThrow(new RegExp(`between 0 and ${available} points`));
    });

    it("a customer with a small balance keeps today's 600 (so a plan above the balance can still be quoted and topped up for)", () => {
      expect(Number(db.sql(`${S} select public.job_points_cap_for('${uid(2)}')`))).toBe(600);
      expect(quote(uid(2), 600).success).toBe(true);
      expect(() => quote(uid(2), 601)).toThrow(/between 0 and 600 points/);
    });

    it("a rich customer is held at the ceiling, never above", () => {
      expect(Number(db.sql(`${S} select public.job_points_cap_for('${uid(3)}')`))).toBe(3000);
      expect(quote(uid(3), 3000).success).toBe(true);
      expect(() => quote(uid(3), 3001)).toThrow(/between 0 and 3000 points/);
    });

    it("the cap is the balance at the moment of the quote (holds are already taken out of it)", () => {
      topup(uid(4), 1200);
      expect(Number(db.sql(`${S} select public.job_points_cap_for('${uid(4)}')`))).toBe(1200);
      db.sql(`insert into credit_ledger(id,user_id,delta,type,job_id,note) values ('res_hold_u4','${uid(4)}',-700,'reserve','job_hold_u4','fixture')`);
      expect(Number(db.sql(`${S} select public.job_points_cap_for('${uid(4)}')`))).toBe(600); // 500 left: the floor
    });

    it("a quote never moves money: no ledger row is written by the cap function or the quote writer", () => {
      const before = ledgerRows();
      db.sql(`${S} select public.job_points_cap_for('${uid(1)}')`);
      quote(uid(1), 1000);
      expect(ledgerRows()).toBe(before);
    });

    it("a missing, broken or hostile policy reads as today's fixed 600, never as «no cap»", () => {
      db.sql("update settings_private set value='{\"mode\":\"balance\",\"balanceFloor\":\"abc\",\"balanceCeiling\":1e99}'::jsonb where key='job_cap_policy'");
      expect(Number(db.sql(`${S} select public.job_points_cap_for('${uid(3)}')`))).toBeLessThanOrEqual(10000);
      db.sql("update settings_private set value='[1,2]'::jsonb where key='job_cap_policy'");
      expect(Number(db.sql(`${S} select public.job_points_cap_for('${uid(3)}')`))).toBe(600);
      db.sql("delete from settings_private where key='job_cap_policy'");
      expect(Number(db.sql(`${S} select public.job_points_cap_for('${uid(3)}')`))).toBe(600);
      db.sql("insert into settings_private(key,value) values ('job_cap_policy','{\"mode\":\"balance\",\"fixedCap\":600,\"balanceFloor\":600,\"balanceCeiling\":3000}'::jsonb)");
      expect(Number(db.sql(`${S} select public.job_points_cap_for('${uid(3)}')`))).toBe(3000);
    });

    it("settlement charges ceil(delivered x unit price), is no longer cut at 600, and is never above the reserve", () => {
      runningJob("job_new_1", uid(1), 2000, 1800, 1);
      expect(json("public.settle_job_atomic('job_new_1', 600, null)")).toMatchObject({ reserved_credits: 2000, charged_credits: 1800 });
      expect(db.sql("select delta from credit_ledger where id='chg_job_new_1'")).toBe("-1800");
      expect(db.sql("select delta from credit_ledger where id='rel_job_new_1'")).toBe("2000");
      // more delivered than the reserve covers: the charge stops at the reserve
      runningJob("job_new_2", uid(1), 1000, 1500, 1);
      expect(json("public.settle_job_atomic('job_new_2', 600, null)")).toMatchObject({ reserved_credits: 1000, charged_credits: 1000 });
      // a fraction is rounded UP, once
      runningJob("job_new_3", uid(3), 1000, 333, 2.73);
      expect(json("public.settle_job_atomic('job_new_3', 600, null)")).toMatchObject({ reserved_credits: 1000, charged_credits: Math.ceil(333 * 2.73) });
    });

    it("settling twice charges once (the ledger is idempotent by id)", () => {
      const before = ledgerRows();
      expect(json("public.settle_job_atomic('job_new_1', 600, null)")).toMatchObject({ already_settled: true, charged_credits: 1800 });
      expect(ledgerRows()).toBe(before);
    });

    it("settle_people_job_atomic: field prices, not cut at 600, never above the reserve", () => {
      const quoteId = "q_people_1";
      const jobId = `job_quote_${db.sql(`select md5('${quoteId}')`)}`;
      db.sql(`insert into plans_quotes(id,user_id,quote_hash,status,items,total_reserved_credits,expires_at) values ('${quoteId}','${uid(3)}','h','accepted','[{"params":{"requiredContactFields":["work_email","phone"]},"contactUnitPricesPoints":{"basePerson":3,"workEmail":2,"phone":1}}]'::jsonb,900,now()+interval '1 day')`);
      runningJob(jobId, uid(3), 900, 150, 1);
      const settled = json(`public.settle_people_job_atomic('${jobId}',150,100,100,600,null)`);
      // 150 x 3 + 100 x 2 + 100 x 1 = 750: above the old 600, below the reserve of 900
      expect(settled).toMatchObject({ success: true, reserved_credits: 900, charged_credits: 750 });
      expect(db.sql(`select delta from credit_ledger where id='chg_${jobId}'`)).toBe("-750");
    });
  });

  it("the ledger is still append-only after every step", () => {
    expect(() => db.sql("update credit_ledger set delta = delta where id like 'tp_%'")).toThrow(/append-only/);
    expect(() => db.sql("delete from credit_ledger where id like 'tp_%'")).toThrow(/append-only/);
  });

  it("only service_role may run any new or changed function; PUBLIC, anon and authenticated may not", () => {
    const functions = [
      "public.job_points_cap_for(uuid)",
      "public.admin_set_job_cap_policy_atomic(uuid,jsonb)",
      FN.quote,
      FN.settle,
      FN.people,
    ];
    for (const fn of functions) {
      for (const role of ["anon", "authenticated"]) expect(db.sql(`select has_function_privilege('${role}','${fn}','EXECUTE')`), `${role} ${fn}`).toBe("f");
      expect(db.sql(`select has_function_privilege('service_role','${fn}','EXECUTE')`), `service_role ${fn}`).toBe("t");
      expect(db.sql(`select count(*) from pg_proc p, aclexplode(p.proacl) a where p.oid='${fn}'::regprocedure and a.grantee = 0`), `PUBLIC ${fn}`).toBe("0");
    }
    expect(db.sql("select prosecdef from pg_proc where proname='job_points_cap_for'")).toBe("t");
    expect(db.sql("select proconfig::text from pg_proc where proname='job_points_cap_for'")).toContain("search_path=public, pg_temp");
  });

  it("ROLLBACK (steps 4, 3, 2, 1): the three functions are byte-identical to the baseline, the new objects are gone, the old cap is back", () => {
    for (const step of ["04_settle_people_job_atomic_no_fixed_cap.rollback.sql", "03_settle_job_atomic_no_fixed_cap.rollback.sql", "02_create_quote_atomic_policy_cap.rollback.sql", "01_job_cap_policy.rollback.sql"]) db.sql(file(step));
    for (const [name, fn] of Object.entries(FN)) expect(def(fn), name).toBe(baseline[name]);
    expect(db.sql("select count(*) from pg_proc where proname in ('job_points_cap_for','admin_set_job_cap_policy_atomic')")).toBe("0");
    expect(db.sql("select count(*) from settings_private where key='job_cap_policy'")).toBe("0");
    expect(db.sql("select to_regclass('public.job_cap_policy_audit') is null")).toBe("t");
    expect(() => quote(uid(3), 601)).toThrow(/between 0 and 600 points/);
    for (const fn of Object.values(FN)) expect(db.sql(`select has_function_privilege('authenticated','${fn}','EXECUTE')`)).toBe("f");
    // jobs settled under the new cap keep their ledger rows (append-only: a rollback never rewrites money history)
    expect(db.sql("select delta from credit_ledger where id='chg_job_new_1'")).toBe("-1800");
  });
});
