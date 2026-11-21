import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDb, scratchPgTarget, type ScratchDb } from "./localPg";

const proof = process.env.DIGER_PROOF === "1";
const stamp = "2026-11-21T00:00:00.123456Z";
const plan = { filters: { period: 30 } };
const reserve = 215;
const signature = "public.accept_mission_quote_atomic(text,uuid,uuid,jsonb,timestamptz,text,text,jsonb,numeric,text[],timestamptz,integer)";

if (proof && !scratchPgTarget()) throw new Error("DIGER_PROOF=1 requires the local scratch PostgreSQL target");

describe.skipIf(!proof)("NEW-ISSUES #13 scratch PostgreSQL mission approval", () => {
  let db: ScratchDb;
  let seq = 0;
  let primitiveDefinitions: string;
  const definitions = `SELECT string_agg(pg_get_functiondef(p.oid), '' ORDER BY p.oid) FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND proname IN
    ('create_quote_atomic','accept_quote_atomic','reserve_credits_atomic','claim_job_chunk','settle_job_atomic','release_job_atomic')`;

  beforeAll(() => {
    db = createScratchDb();
    db.sql(readFileSync("docs/proposals/agent-worker/01_agent_tables.sql", "utf8"));
    primitiveDefinitions = db.sql(definitions);
    const migration = "supabase/migrations/20261121010000_accept_mission_quote_atomic.sql";
    if (existsSync(migration)) db.sql(readFileSync(migration, "utf8"));
  }, 120_000);

  afterAll(() => db?.drop());

  function seed(balance = 1_000) {
    const suffix = String(++seq).padStart(12, "0");
    const owner = `00000000-0000-0000-0000-${suffix}`;
    const mission = `msn_${suffix}`;
    db.sql(`INSERT INTO auth.users (id,email) VALUES ('${owner}','u${suffix}@t');
      INSERT INTO public.profiles (id,email) SELECT id,email FROM auth.users WHERE id='${owner}' ON CONFLICT DO NOTHING;
      INSERT INTO public.missions (id,user_id,request_text,status,plan,updated_at)
      VALUES ('${mission}','${owner}','synthetic request','plan_ready','${JSON.stringify(plan)}','${stamp}');`);
    if (balance) db.sql(`INSERT INTO public.credit_ledger (id,user_id,delta,type,note) VALUES ('seed_${suffix}','${owner}',${balance},'topup','seed');`);
    const candidate = (attempt: number) => `quote_${suffix}${String(attempt).padStart(12, "0")}`;
    const hash = "a".repeat(64);
    const items = JSON.stringify([{ missionId: mission, capabilitySlug: "agent-mission", endpointId: "agent-mission", unitPricePoints: 10, targetVolumeMin: 1, targetVolumeMax: 20 }]);
    const call = (attempt: number, expectedPlan = plan, updatedAt = stamp, user = owner) =>
      `SELECT public.accept_mission_quote_atomic('${mission}','${user}','${user}',
       '${JSON.stringify(expectedPlan)}','${updatedAt}','${candidate(attempt)}','${hash}','${items}',${reserve},ARRAY['xlsx'],now()+interval '1 hour',21600)`;
    const run = (...args: Parameters<typeof call>) => JSON.parse(db.sql(`SET ROLE service_role; ${call(...args)}`));
    const money = () => JSON.parse(db.sql(`SELECT json_build_object(
      'quotes',(SELECT count(*) FROM public.plans_quotes WHERE user_id='${owner}'),
      'jobs',(SELECT count(*) FROM public.jobs WHERE user_id='${owner}'),
      'reserves',(SELECT coalesce(json_agg(-delta),'[]') FROM public.credit_ledger WHERE user_id='${owner}' AND type='reserve'),
      'other',(SELECT count(*) FROM public.credit_ledger WHERE user_id='${owner}' AND type NOT IN ('reserve','topup')))`));
    const row = () => JSON.parse(db.sql(`SELECT row_to_json(m) FROM public.missions m WHERE id='${mission}'`));
    return { owner, mission, candidate, hash, items, call, run, money, row };
  }

  const empty = { quotes: 0, jobs: 0, reserves: [], other: 0 };
  const one = { quotes: 1, jobs: 1, reserves: [reserve], other: 0 };

  it("adds one service-only entry point without changing the money functions", () => {
    const privileges = db.sql(`SELECT concat_ws(',', has_function_privilege('anon','${signature}','EXECUTE'),
      has_function_privilege('authenticated','${signature}','EXECUTE'),
      has_function_privilege('service_role','${signature}','EXECUTE'))`);
    expect(privileges).toBe("f,f,t");
    expect(db.sql(definitions)).toBe(primitiveDefinitions);
  });

  it("keeps one attached hold when the committed response is dropped and a new quote ID is tried", () => {
    const f = seed();
    f.run(1);
    const linked = f.row();
    expect(linked).toMatchObject({ status: "approved", quote_id: f.candidate(1), reserved_points: reserve, lease_until: null });
    expect(f.run(2)).toEqual({ success: false, error: "already_approved" });
    expect(f.row().job_id).toBe(linked.job_id);
    expect(db.sql(`SELECT status || ':' || (lease_until IS NOT NULL)::text FROM public.jobs WHERE id='${linked.job_id}'`)).toBe("running:true");
    expect(f.money()).toEqual(one);
  });

  it("serializes two concurrent approvals against one mission", async () => {
    const f = seed();
    const results = await Promise.all([1, 2].map(async (attempt) => JSON.parse(await db.sqlAsync(`SET ROLE service_role; ${f.call(attempt)}`))));
    expect(results.filter((r) => r.success)).toEqual([expect.objectContaining({ job_id: f.row().job_id, quote_id: f.row().quote_id, reserved_credits: reserve })]);
    expect(results.filter((r) => !r.success)).toEqual([{ success: false, error: "already_approved" }]);
    expect(f.money()).toEqual(one);
  });

  it.each(["content", "timestamp"] as const)("keeps the committed %s edit and rejects the earlier snapshot", async (changed) => {
    const f = seed();
    const newPlan = changed === "content" ? { filters: { period: 7 } } : plan;
    const newStamp = changed === "timestamp" ? "2026-11-21T00:00:00.123457Z" : stamp;
    await db.sqlAsync(`BEGIN; UPDATE public.missions SET plan='${JSON.stringify(newPlan)}', updated_at='${newStamp}' WHERE id='${f.mission}'; COMMIT;`);
    expect(f.run(1)).toEqual({ success: false, error: "stale_plan" });
    expect(f.row()).toMatchObject({ status: "plan_ready", plan: newPlan, job_id: null, quote_id: null, approved_at: null });
    expect(f.money()).toEqual(empty);
    expect(f.run(2, newPlan, newStamp)).toMatchObject({ success: true, reserved_credits: reserve });
    expect(f.money()).toEqual(one);
  });

  it("rolls back the lease, job, quote and hold when the link fails before commit", () => {
    const f = seed();
    db.sql(`CREATE FUNCTION public.test_fail_mission_link() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RAISE EXCEPTION ''synthetic link failure''; END';
      CREATE TRIGGER test_fail_mission_link BEFORE UPDATE OF job_id ON public.missions
      FOR EACH ROW EXECUTE FUNCTION public.test_fail_mission_link();`);
    try {
      expect(() => f.run(1)).toThrow(/synthetic link failure/);
      expect(f.row()).toMatchObject({ status: "plan_ready", job_id: null, quote_id: null, approved_at: null });
      expect(f.money()).toEqual(empty);
    } finally {
      db.sql("DROP TRIGGER test_fail_mission_link ON public.missions");
    }
    expect(f.run(2)).toMatchObject({ success: true, reserved_credits: reserve });
    expect(f.money()).toEqual(one);
  });

  it("leaves the ledger and draft quote set unchanged for a different owner or an empty wallet", () => {
    const f = seed(0);
    const other = seed();
    expect(f.run(1, plan, stamp, other.owner)).toMatchObject({ success: false });
    expect(f.run(1)).toEqual({ success: false, error: "insufficient_balance" });
    expect(f.row()).toMatchObject({ status: "plan_ready", job_id: null });
    expect(f.money()).toEqual(empty);
    expect(other.money()).toEqual(empty);
  });

  it("leaves an accepted unlinked legacy quote alone", () => {
    const f = seed();
    db.sql(`SET ROLE service_role; SELECT public.create_quote_atomic('${f.owner}','${f.candidate(1)}','${f.hash}','${f.items}',${reserve},ARRAY['xlsx'],now()+interval '1 hour');
      SELECT public.accept_quote_atomic('${f.candidate(1)}','${f.owner}','${f.hash}');`);
    expect(f.money()).toEqual(one);
    expect(f.run(2)).toEqual({ success: false, error: "approval_pending" });
    expect(f.row()).toMatchObject({ status: "plan_ready", job_id: null, quote_id: null });
    expect(f.money()).toEqual(one);
  });
});
