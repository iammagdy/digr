import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { replicaAvailable, startReplica, type ReplicaDb } from "../helpers/replicaDb";

const sqlFile = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const migration = "supabase/migrations/20261122010000_finalize_agent_delivery_atomic.sql";
const quoteHash = "a".repeat(64);
const user = "00000000-0000-4000-8000-000000000001";
const mission = "msn_fxmoney01";
const quote = "quote_000000000000000000000001";
const job = `job_quote_${createHash("md5").update(quote).digest("hex")}`;
const worker = "worker-one";
const xlsx = "a".repeat(64);
const csv = "b".repeat(64);
const prefix = `${user}/${job}/sealed/${xlsx}`;
const candidate = { path: "settlement/candidate-fixture.xlsx", xlsx_sha: xlsx };
const binding = {
  version: 1, job_id: job, snapshot_sha: "c".repeat(64), xlsx_sha: xlsx, csv_sha: csv,
  xlsx_path: `${prefix}/result.xlsx`, csv_path: `${prefix}/result.csv`,
  physical_units: 6, billable_units: 5, counts: { people: 6 }, stage_units: null,
  cost_usd: 0.005, release_reason: null,
};
const empty = {
  ...binding, xlsx_sha: null, csv_sha: null, xlsx_path: null, csv_path: null, physical_units: 0,
  billable_units: 0, counts: {},
};

describe.skipIf(!replicaAvailable())("FX-M1 delivery journal and finalization in PostgreSQL", () => {
  let db: ReplicaDb;
  const extras = () => [
    "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;",
    sqlFile("docs/proposals/agent-worker/01_agent_tables.sql"),
    sqlFile("docs/proposals/agent-worker/02_agent_claim_function.sql"),
    sqlFile("supabase/migrations/20261119020000_settle_job_by_stage_atomic.sql"),
    sqlFile(migration),
  ];

  beforeAll(async () => { db = await startReplica(); });
  afterAll(async () => { await db?.stop(); });

  beforeEach(async () => {
    await db.reset({ extraSql: extras() });
    await db.pool.query("INSERT INTO auth.users (id) VALUES ($1)", [user]);
    await db.pool.query("INSERT INTO profiles (id) VALUES ($1)", [user]);
    await db.pool.query("INSERT INTO credit_ledger (id, user_id, type, delta) VALUES ('grant_fixture', $1, 'grant', 2000)", [user]);
    await db.pool.query(`INSERT INTO plans_quotes (id,user_id,quote_hash,status,items,total_reserved_credits,expires_at)
      VALUES ($1,$2,$4,'quoted',$3,1067,now()+interval '1 hour')`, [
      quote, user, JSON.stringify([{ missionId: mission, endpointId: "agent-mission", capabilitySlug: "agent-mission",
        unitPricePoints: 154.62, targetVolumeMin: 1, targetVolumeMax: 12 }]), quoteHash,
    ]);
    const { rows } = await db.pool.query("SELECT accept_quote_atomic($1,$2,$3) AS answer", [quote, user, quoteHash]);
    expect(rows[0].answer, JSON.stringify(rows[0].answer)).toMatchObject({ success: true, job_id: job });
    await db.pool.query("SELECT claim_job_chunk($1,0,21600)", [job]);
    await db.pool.query(`INSERT INTO missions (id,user_id,status,request_text,plan,job_id,quote_id,reserved_points,unit_price_points,approved_at,worker_id,lease_until)
      VALUES ($1,$2,'executing','طلب تجريبي','{}',$3,$4,1067,154.62,now(),$5,now()+interval '120 seconds')`, [mission, user, job, quote, worker]);
  });

  async function journal(operation: string, trial: string | null = null, value: unknown = null, who = worker, client?: PoolClient) {
    const { rows } = await (client ?? db.pool).query("SELECT claim_agent_delivery_attempt_atomic($1,$2,$3,$4,$5) AS answer", [mission, who, operation, trial, value]);
    return rows[0].answer;
  }

  async function finalize(trial: string, value: unknown, mode = "deliver", who = worker, client?: PoolClient) {
    const { rows } = await (client ?? db.pool).query("SELECT finalize_agent_delivery_atomic($1,$2,$3,$4,$5) AS answer", [mission, who, value, mode, trial]);
    return rows[0].answer;
  }

  async function ledger() {
    const { rows } = await db.pool.query("SELECT type,delta::text FROM credit_ledger WHERE job_id=$1 ORDER BY type", [job]);
    return rows;
  }

  async function verifyTrial(value = binding) {
    await journal("begin");
    const trial = randomUUID();
    expect(await journal("claim", trial)).toMatchObject({ kind: "attempt", mode: "verify", trial_id: trial });
    const entry = value.physical_units === 0 ? { empty: true } : candidate;
    expect(await journal("bind_candidate", trial, entry)).toMatchObject({ kind: "bound" });
    expect(await journal("bind_snapshot", trial, value)).toMatchObject({ kind: "bound" });
    return trial;
  }

  async function dueBy(seconds: number) {
    await db.pool.query(`UPDATE agent_delivery_attempts SET started_at=started_at-$2*interval '1 second',
      next_at=next_at-$2*interval '1 second', last_attempt_at=last_attempt_at-$2*interval '1 second' WHERE job_id=$1`, [job, seconds]);
    await db.pool.query("UPDATE missions SET lease_until=now()-interval '1 second' WHERE id=$1", [mission]);
  }

  it("settles through real SQL, replays the identical artifact and rejects a different one", async () => {
    const trial = await verifyTrial();
    const done = await finalize(trial, binding);
    expect(done).toMatchObject({ success: true, kind: "settled", charged_credits: 774, refunded_credits: 293 });
    expect(done.receipt).toMatchObject({ ...binding, charged_credits: 774 });
    expect(await finalize(trial, binding)).toMatchObject({ replayed: true, receipt: done.receipt });
    expect(await finalize(trial, { ...binding, physical_units: 5 })).toMatchObject({ success: false });
    expect(await ledger()).toEqual([{ type: "charge", delta: "-774" }, { type: "release", delta: "1067" }, { type: "reserve", delta: "-1067" }]);
    const { rows } = await db.pool.query("SELECT delivered_units,result_file_id FROM jobs WHERE id=$1", [job]);
    expect(rows).toEqual([{ delivered_units: 5, result_file_id: binding.csv_path }]);
  });

  it("commits zero charge and releases the full hold on a verified empty result", async () => {
    const trial = await verifyTrial(empty as unknown as typeof binding);
    expect(await finalize(trial, empty)).toMatchObject({ success: true, kind: "released", charged_credits: 0, refunded_credits: 1067 });
    expect(await ledger()).toEqual([{ type: "release", delta: "1067" }, { type: "reserve", delta: "-1067" }]);
  });

  it("consumes durable storage retry slots and releases once after takeover", async () => {
    const started = (await journal("begin")).progress.started_at;
    const original = randomUUID();
    const first = await journal("claim", original);
    expect(await journal("claim", original)).toEqual(first);
    expect(await journal("bind_candidate", original, candidate)).toMatchObject({ kind: "bound" });
    const fault = await journal("unreadable", original, { code: "candidate_missing" });
    expect(await journal("claim", randomUUID())).toMatchObject({ kind: "wait", next_at: fault.next_at });
    expect(await journal("park")).toMatchObject({ kind: "parked", next_at: fault.next_at });
    expect((await db.pool.query("SELECT (agent_claim_mission('worker-two',120)).id AS id")).rows.every((row) => !row.id)).toBe(true);
    await dueBy(16);
    expect((await db.pool.query("SELECT (agent_claim_mission('worker-two',120)).id AS id")).rows[0].id).toBe(mission);
    let trial = randomUUID();
    const second = await journal("claim", trial, null, "worker-two");
    expect(second).toMatchObject({ kind: "attempt", mode: "verify", progress: { candidate } });
    expect(new Date(second.progress.started_at).getTime()).toBe(new Date(started).getTime() - 16000);
    expect(await journal("bind_candidate", trial, { ...candidate, path: "settlement/replacement.xlsx" }, "worker-two")).toMatchObject({ kind: "error" });
    await journal("unreadable", trial, { code: "storage_unavailable" }, "worker-two");
    for (const delay of [45, 90]) {
      await dueBy(delay);
      await db.pool.query("SELECT agent_claim_mission('worker-two',120)");
      trial = randomUUID();
      expect(await journal("claim", trial, null, "worker-two")).toMatchObject({ kind: "attempt", mode: "verify" });
      await journal("unreadable", trial, { code: "storage_unavailable" }, "worker-two");
    }
    await dueBy(15);
    await db.pool.query("SELECT agent_claim_mission('worker-two',120)");
    const release = randomUUID();
    expect(await journal("claim", release, null, "worker-two")).toMatchObject({ mode: "release_unsettled" });
    expect(await finalize(release, binding, "deliver", "worker-two")).toMatchObject({ success: false });
    expect(await finalize(original, binding)).toMatchObject({ success: false });
    const done = await finalize(release, null, "release_unsettled", "worker-two");
    expect(done).toMatchObject({ success: true, kind: "released", charged_credits: 0, refunded_credits: 1067, receipt: { snapshot_sha: null, xlsx_path: null } });
    expect(await finalize(release, null, "release_unsettled", "worker-two")).toMatchObject({ replayed: true, receipt: done.receipt });
    expect(await ledger()).toEqual([{ type: "release", delta: "1067" }, { type: "reserve", delta: "-1067" }]);
  });

  it("rolls back the chunk and all ledger writes if the database rejects the debit", async () => {
    const trial = await verifyTrial();
    await db.pool.query(`CREATE FUNCTION reject_fixture_charge() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type = 'charge' THEN RAISE EXCEPTION 'fixture debit refused'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_fixture_charge BEFORE INSERT ON credit_ledger FOR EACH ROW EXECUTE FUNCTION reject_fixture_charge();`);
    await expect(finalize(trial, binding)).rejects.toThrow(/fixture debit refused|Unconfirmed delivery settlement/);
    const { rows } = await db.pool.query("SELECT status,step,delivered_units,result_file_id FROM jobs WHERE id=$1", [job]);
    expect(rows).toEqual([{ status: "running", step: 0, delivered_units: 0, result_file_id: null }]);
    expect(await ledger()).toEqual([{ type: "reserve", delta: "-1067" }]);
    expect((await journal("status")).kind).toBe("progress");
    await db.pool.query("DROP TRIGGER reject_fixture_charge ON credit_ledger; DROP FUNCTION reject_fixture_charge()");
    expect(await finalize(trial, binding)).toMatchObject({ success: true, charged_credits: 774 });
  });

  it.each(["advanced", "watchdog", "bad reserve", "existing debit"] as const)("handles a legacy %s without another debit", async (state) => {
    expect(await journal("status", null, null, "another-worker")).toMatchObject({ kind: "error", error: "unowned_or_unlinked" });
    if (state === "watchdog") await db.pool.query("SELECT release_job_atomic($1,'fixture watchdog',true)", [job]);
    else if (state === "advanced") await db.pool.query("SELECT complete_chunk($1,0,'completed',5,0)", [job]);
    else if (state === "bad reserve") {
      await db.pool.query("UPDATE jobs SET reserved_credits=1068,step=1 WHERE id=$1", [job]);
      await db.pool.query("UPDATE missions SET reserved_points=1068 WHERE id=$1", [mission]);
      await db.pool.query("UPDATE plans_quotes SET total_reserved_credits=1068 WHERE id=$1", [quote]);
    } else {
      const trial = await verifyTrial();
      await db.pool.query("SELECT complete_chunk($1,0,'completed',5,0)", [job]);
      await db.pool.query("SELECT settle_job_atomic($1,25000,NULL)", [job]);
      const before = await ledger();
      expect(await journal("status")).toMatchObject({ kind: "error", error: "unbound_money" });
      expect(await finalize(trial, null, "release_unsettled")).toMatchObject({ success: false, error: "unbound_money" });
      expect(await ledger()).toEqual(before);
      return;
    }
    expect(await journal("status")).toMatchObject({ kind: "legacy_mismatch" });
    await journal("begin");
    const release = randomUUID();
    expect(await journal("claim", release)).toMatchObject({ mode: "release_unsettled" });
    const done = await finalize(release, null, "release_unsettled");
    if (state === "bad reserve") {
      expect(done).toMatchObject({ success: false, error: "unbound_money" });
      expect(await ledger()).toEqual([{ type: "reserve", delta: "-1067" }]);
    } else {
      expect(done).toMatchObject({ success: true, receipt: { charged_credits: 0, refunded_credits: 1067, xlsx_path: null } });
      expect(await ledger()).toEqual([{ type: "release", delta: "1067" }, { type: "reserve", delta: "-1067" }]);
    }
  });

  it("ordinary roles cannot execute the money RPCs or access the journal", async () => {
    const { rows } = await db.pool.query(`SELECT
      has_function_privilege('anon','claim_agent_delivery_attempt_atomic(text,text,text,uuid,jsonb)','EXECUTE') AS anon_claim,
      has_function_privilege('authenticated','finalize_agent_delivery_atomic(text,text,jsonb,text,uuid)','EXECUTE') AS customer_finalize,
      has_function_privilege('service_role','finalize_agent_delivery_atomic(text,text,jsonb,text,uuid)','EXECUTE') AS worker_finalize,
      has_table_privilege('service_role','agent_delivery_receipts','SELECT') AS worker_receipt,
      has_table_privilege('service_role','agent_delivery_receipts','INSERT') AS worker_insert,
      has_table_privilege('authenticated','agent_delivery_receipts','SELECT') AS customer_receipt`);
    expect(rows).toEqual([{ anon_claim: false, customer_finalize: false, worker_finalize: true, worker_receipt: true, worker_insert: false, customer_receipt: false }]);
  });

  it("an acknowledged or lost settlement wins over a new owner's snapshotless recovery", async () => {
    const trial = await verifyTrial();
    const first = await db.pool.connect();
    const second = await db.pool.connect();
    try {
      await first.query("BEGIN");
      const done = await finalize(trial, binding, "deliver", worker, first);
      await first.query("UPDATE missions SET worker_id='worker-two' WHERE id=$1", [mission]);
      const recovering = finalize(randomUUID(), null, "release_unsettled", "worker-two", second);
      await first.query("COMMIT");
      expect(await recovering).toMatchObject({ success: true, replayed: true, receipt: done.receipt });
      expect((await ledger()).map((row) => row.type)).toEqual(["charge", "release", "reserve"]);
    } finally {
      await first.query("ROLLBACK");
      first.release();
      second.release();
    }
  });
});
