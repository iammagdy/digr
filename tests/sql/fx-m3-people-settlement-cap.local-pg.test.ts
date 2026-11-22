import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replicaAvailable, startReplica, type ReplicaDb } from "../helpers/replicaDb";
import { balanceOf, ledgerOf, seedUser } from "../helpers/replicaMoney";

const migration = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
const original = "20261017184147_settle_decision_maker_fields";
const reviewed = "20261122020000_record_people_settlement_cap";
const ordinary = "public.settle_job_atomic(text,numeric,text)";
const staged = "public.settle_job_by_stage_atomic(text,jsonb,numeric,text)";
const people = "public.settle_people_job_atomic(text,integer,integer,integer,numeric,text)";

describe.skipIf(!replicaAvailable())("M10 legacy people settlement migration in the PostgreSQL replica", () => {
  let db: ReplicaDb;
  beforeAll(async () => {
    db = await startReplica();
    await db.reset({});
    await db.exec(migration("20261119020000_settle_job_by_stage_atomic"));
  }, 120_000);
  afterAll(async () => { await db?.stop(); });

  async function prove(count: number, hold: number, charge: number, cap?: number | null) {
    const user = await seedUser(db.pool, 40_000);
    const quote = `people-${user}`;
    const id = `job_quote_${createHash("md5").update(quote).digest("hex")}`;
    const items = [{ params: { requiredContactFields: ["work_email", "phone"] }, contactUnitPricesPoints: { basePerson: 83, workEmail: 120, phone: 55 } }];
    // Seed the accepted state directly so an oversized synthetic reserve also exercises the settlement hard clamp.
    await db.pool.query("insert into public.plans_quotes(id,user_id,quote_hash,status,items,total_reserved_credits,expires_at) values($1,$2,$1,'accepted',$3::jsonb,$4,now()+interval '1 hour')", [quote, user, JSON.stringify(items), hold]);
    await db.pool.query("insert into public.jobs(id,user_id,status,reserved_credits,delivered_units,current_cursor) values($1,$2,'running',$3,$4,'completed')", [id, user, hold, count]);
    await db.pool.query("insert into public.credit_ledger(id,user_id,job_id,type,delta) values($1,$2,$3,'reserve',$4)", [`res_${id}`, user, id, -hold]);
    expect(await balanceOf(db.pool, user)).toBe(40_000 - hold);
    const settle = async () => (await db.pool.query(
      cap === undefined ? "select public.settle_people_job_atomic($1,$2,$2,$2) as receipt" : "select public.settle_people_job_atomic($1,$2,$2,$2,$3::numeric) as receipt",
      cap === undefined ? [id, count] : [id, count, cap],
    )).rows[0].receipt;
    const results = await Promise.all([settle(), settle()]);
    expect(results.map((r) => r.already_settled).sort()).toEqual([false, true]);
    expect(results.map((r) => [r.success, r.charged_credits, r.delivered_units])).toEqual([[true, charge, count], [true, charge, count]]);
    const ledger = await ledgerOf(db.pool, id);
    expect(ledger.rows).toEqual(expect.arrayContaining([
      { id: `res_${id}`, type: "reserve", delta: -hold },
      { id: `rel_${id}`, type: "release", delta: hold },
      { id: `chg_${id}`, type: "charge", delta: -charge },
    ]));
    expect(ledger.counts).toEqual({ reserve: 1, release: 1, charge: 1 });
    expect(ledger.release + ledger.charge).toBe(hold - charge);
    expect(await balanceOf(db.pool, user)).toBe(40_000 - charge);
  }

  it("lifts the legacy cap while preserving the other settlement definitions, role grants and idempotency", async () => {
    const definitions = async () => (await db.pool.query("select pg_get_functiondef($1::regprocedure) as ordinary, pg_get_functiondef($2::regprocedure) as staged", [ordinary, staged])).rows[0];
    const handlers = await definitions();
    await db.exec(migration(original));
    await prove(3, 1000, 600);
    const sql = migration(reviewed);
    expect(createHash("sha256").update(sql).digest("hex")).toBe("7f54e288e4bfcf5f95e4553d160897692f7c6c3f88fd4100cdd5239306c0a0f7");
    await db.exec(sql);
    await prove(3, 1000, 774);
    await prove(3, 1000, 700, 700);
    await prove(3, 700, 700);
    for (const cap of [undefined, null, 28000]) await prove(100, 27000, 25000, cap);
    expect(await definitions()).toEqual(handlers);
    const grants = (await db.pool.query(`select has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
      exists(select from aclexplode(p.proacl) acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public
      from pg_proc p where p.oid = $1::regprocedure`, [people])).rows[0];
    expect(grants).toEqual({ anon: false, authenticated: false, service: true, public: false });
  });
});
