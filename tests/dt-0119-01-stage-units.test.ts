import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { g1 } from "./helpers/g1World";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { approveMission, perStageSettlementReady, repriceStoredPlan, settleMission } from "../src/lib/agentMission/lifecycle";
import { estimatedGroupKeys, settlementChargeByStage, stageCountsOf, stageUnitsOf } from "../src/lib/agentMission/stageUnits";
import { chargeForDelivered } from "../src/lib/agentMission/price";
import { AGENT_JOB_POINTS_CAP } from "../src/lib/agentMission/constants";

/**
 * DT-20261119-01 (Megz D-0103, D-0107): settlement per stage for a plan whose people stage was priced by an ESTIMATE. The worlds are the real g1 world (5 companies, 10 people, phones and e-mails: hold 2,569, today's blended unit 148.918671,
 * charge at full 2,234) and the same plan with no contact steps (the minimum charge sets the price: companies 40, people 0, blended 13.333333, hold 220). The money fake runs the SAME scenarios as the replica test
 * (tests/replica-settle-by-stage.test.ts, a real PostgreSQL): the charge of every row of the tables below is what the SQL gives.
 */
let plan: any;
let noContact: any;
const estimated = (p: any) => ({ ...p, stages: p.stages.map((s: any) => (s.parent_key ? { ...s, estimated: true } : s)) });
afterAll(() => vi.unstubAllEnvs());
beforeAll(async () => {
  vi.stubEnv("JOB_MAX_POINTS_CAP", "");
  const world = (await g1({})).mission as any;
  plan = estimated(world.plan);
  const bare = { ...plan, contact_steps: [] };
  noContact = { ...bare, price: repriceStoredPlan(bare) };
}, 60_000);
const mission = (p: any) => ({ id: "m1", user_id: "u1", plan: p });

describe("the two units of a plan with an estimated people stage", () => {
  it("g1: companies 74.415, people 186.1 (the rest of the full charge 2,234 over 10 people); a plan without an estimated stage has none", () => {
    expect(stageUnitsOf(plan)).toEqual({ base: 74.415, estimated: 186.1, rows: { base: 5, estimated: 10 } });
    expect(stageUnitsOf({ ...plan, stages: plan.stages.map((s: any) => ({ ...s, estimated: undefined })) })).toBeNull();
    expect(estimatedGroupKeys(plan.stages)).toEqual(new Set(["people"]));
    // a stage below the estimated one (its parent chain reaches it) belongs to the same group; a stage beside it does not
    expect(estimatedGroupKeys([{ key: "c", parent_key: null }, { key: "p", parent_key: "c", estimated: true }, { key: "x", parent_key: "p" }, { key: "y", parent_key: "c" }] as any)).toEqual(new Set(["p", "x"]));
  });
  it("the hold and the cap are the last word, whatever the units say", () => {
    const u = stageUnitsOf(plan)!;
    expect(settlementChargeByStage({ base: 5, estimated: 10 }, u, 148.918671, 1000)).toBe(1000);
    expect(settlementChargeByStage({ base: 5, estimated: 10 }, u, 148.918671, 2569, 1500)).toBe(1500);
    expect(settlementChargeByStage({ base: 5, estimated: 10 }, u, 148.918671, 2569, 2234)).toBe(2234);
  });
  it("the table of Megz (g1/g2): today's blended charge vs the per-stage charge, every row", () => {
    const u = stageUnitsOf(plan)!;
    const today = (d: number) => chargeForDelivered(d, 148.918671);
    const rows: Array<[number, number, number, number]> = [[5, 10, 2234, 2234], [5, 0, 745, 373], [5, 4, 1341, 1117], [5, 5, 1490, 1303], [3, 0, 447, 224], [2, 0, 298, 149], [0, 0, 0, 0]];
    for (const [dc, dp, was, now] of rows) {
      expect(today(dc + dp), `today ${dc}+${dp}`).toBe(was);
      expect(settlementChargeByStage({ base: dc, estimated: dp }, u, 148.918671, 2569), `v2 ${dc}+${dp}`).toBe(now);
    }
  });
  it("the no-contact world (the minimum charge sets the price): by stage alone zero people would charge the companies 200, MORE than today's 67; the lower-of rule charges 67, and a full delivery is the full charge 200", () => {
    const u = stageUnitsOf(noContact)!;
    expect(u).toEqual({ base: 40, estimated: 0, rows: { base: 5, estimated: 10 } });
    const blended = 13.333333;
    expect(Math.ceil(5 * u.base + 0 * u.estimated)).toBe(200);
    const rows: Array<[number, number, number]> = [[5, 10, 200], [5, 0, 67], [5, 4, 120], [5, 5, 134], [3, 0, 40], [2, 0, 27], [0, 0, 0]];
    for (const [dc, dp, now] of rows) {
      expect(settlementChargeByStage({ base: dc, estimated: dp }, u, blended, 220), `${dc}+${dp}`).toBe(now);
      expect(now).toBeLessThanOrEqual(chargeForDelivered(dc + dp, blended));
    }
  });
  it("never more than today's rule, never above the hold or the cap, a full delivery is exactly the card's full charge, more delivered never costs less (random plans)", () => {
    let seed = 20261119;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (let i = 0; i < 400; i++) {
      const nc = 1 + Math.floor(rnd() * 30), per = 1 + Math.floor(rnd() * 5), np = nc * per;
      const cc = 0.00005 + rnd() * 0.02, cp = 0.00005 + rnd() * 0.03;
      const stages = [{ key: "c", parent_key: null, planned_rows: nc, measured_cost_per_row_usd: cc, deliver: true }, { key: "p", parent_key: "c", planned_rows: np, measured_cost_per_row_usd: cp, deliver: true, estimated: true }];
      const p: any = { stages, contact_steps: [], price: { settings: undefined } };
      const full = repriceStoredPlan({ ...p, price: { rule: 2, settings: undefined } } as any);
      const u = stageUnitsOf(p);
      if (full.overCap || !u) continue;
      const cap = AGENT_JOB_POINTS_CAP;
      expect(settlementChargeByStage({ base: nc, estimated: np }, u, full.unitPricePoints, full.reservePoints, cap), `full ${i}`).toBe(full.maxChargePoints);
      let last = -1;
      for (const [dc, dp] of [[0, 0], [nc, 0], [nc, Math.floor(np / 2)], [nc, np], [Math.floor(nc / 2), 0], [Math.floor(nc / 2), Math.floor(np / 2)]] as Array<[number, number]>) {
        const c = settlementChargeByStage({ base: dc, estimated: dp }, u, full.unitPricePoints, full.reservePoints, cap);
        expect(c, `blended ${i} ${dc}+${dp}`).toBeLessThanOrEqual(chargeForDelivered(dc + dp, full.unitPricePoints));
        expect(c).toBeLessThanOrEqual(full.reservePoints);
        expect(c).toBeLessThanOrEqual(full.maxChargePoints);
        if (dc === nc && dp >= 0) { expect(c).toBeGreaterThanOrEqual(last); last = c; }
      }
    }
  });
  it("the counts of the groups come from the file, are capped by the rows sold, and always add up to the rows the job records", () => {
    const u = stageUnitsOf(plan)!;
    expect(stageCountsOf(plan.stages, { companies: 5, people: 4 }, u, 9)).toEqual({ base: 5, estimated: 4, deliveredUnits: 9 });
    expect(stageCountsOf(plan.stages, { companies: 5 }, u, 5)).toEqual({ base: 5, estimated: 0, deliveredUnits: 5 });
    // over-delivery of a group (a file with more people than sold): capped, and the sum is what is settled
    expect(stageCountsOf(plan.stages, { companies: 5, people: 99 }, u, 15)).toEqual({ base: 5, estimated: 10, deliveredUnits: 15 });
    expect(stageCountsOf(plan.stages, { companies: 9, people: 0 }, u, 9)).toEqual({ base: 5, estimated: 0, deliveredUnits: 5 });
    expect(stageCountsOf(plan.stages, {}, u, 0)).toEqual({ base: 0, estimated: 0, deliveredUnits: 0 });
  });
});

describe("the approval: the per-stage settlement must exist before anything is held (Gate 1 P1-1)", () => {
  it("answers ready ONLY on the positive «Job probe not found» (P0001)", async () => {
    const yes = fakeMoneyClient();
    expect(await perStageSettlementReady(yes.client)).toBe(true);
    expect(yes.calls).toEqual([{ name: "settle_job_by_stage_atomic", args: { p_job_id: "probe", p_units: { base: 0, estimated: 0 } } }]);
    expect(yes.ledger.length).toBe(1);
    const answers: Array<[any, boolean]> = [
      [{ error: { code: "P0001", message: "Job probe not found" } }, true],
      [{ error: { code: "PGRST202", message: "Could not find the function public.settle_job_by_stage_atomic in the schema cache" } }, false],
      [{ error: { code: "42883", message: "function public.settle_job_by_stage_atomic(text, jsonb) does not exist" } }, false],
      [{ error: { message: "fetch failed" } }, false],
      [{ error: { code: "42501", message: "permission denied for function settle_job_by_stage_atomic" } }, false],
      [{ error: { code: "P0001", message: "Quote for job probe is not accepted" } }, false],
      [{ error: { code: "57014", message: "Job probe not found" } }, false],
      [{ data: { success: true } }, false],
      [{}, false],
      [null, false],
    ];
    for (const [a, expected] of answers) expect(await perStageSettlementReady({ rpc: async () => a }), JSON.stringify(a)).toBe(expected);
    expect(await perStageSettlementReady({ rpc: async () => { throw new Error("network down"); } })).toBe(false);
  });
  it("function missing, or an outage: the approval is refused with a customer message, NO quote, NO hold, NO job (nothing moved)", async () => {
    const outage = fakeMoneyClient(); outage.inject("settle_job_by_stage_atomic", "before");
    for (const money of [fakeMoneyClient({ withoutPerStageSettlement: true }), outage]) {
      const r = await approveMission(money.client, mission(plan));
      expect(r).toMatchObject({ ok: false, code: "settle_unavailable" });
      if (!r.ok) expect(r.messageAr).toMatch(/لم يُحجز أي رصيد/);
      expect(money.calls.map((c) => c.name)).toEqual(["settle_job_by_stage_atomic"]);
      expect(money.quotes.size).toBe(0); expect(money.jobs.size).toBe(0); expect(money.ledger.length).toBe(1);
    }
  });
  it("function present: the probe runs BEFORE create_quote_atomic, the accepted quote carries both unit prices and the rows sold, the hold is the blended one as today", async () => {
    const money = fakeMoneyClient();
    const r = await approveMission(money.client, mission(plan));
    expect(r).toMatchObject({ ok: true, reservePoints: 2569, unitPricePoints: 148.918671, deliveredRows: 15 });
    expect(money.calls.map((c) => c.name).slice(0, 2)).toEqual(["settle_job_by_stage_atomic", "create_quote_atomic"]);
    const item = money.calls.find((c) => c.name === "create_quote_atomic")!.args.p_items[0];
    expect(item).toMatchObject({ stageUnitsPoints: { base: 74.415, estimated: 186.1 }, stageRowsPlanned: { base: 5, estimated: 10 }, unitPricePoints: 148.918671 });
  });
  it("a plan with an estimated stage that cannot be split is refused before any call; a plan WITHOUT an estimated stage makes no probe and its quote has no stage prices (byte-identical to today)", async () => {
    // companies that are not delivered: nothing to split (the stored price is recomputed so the refusal is the split's, not a changed price)
    const lonelyStages = plan.stages.map((s: any) => (s.parent_key ? s : { ...s, deliver: false }));
    const lonely = { ...plan, stages: lonelyStages, price: repriceStoredPlan({ ...plan, stages: lonelyStages }) };
    expect(stageUnitsOf(lonely)).toBeNull();
    const a = fakeMoneyClient();
    expect(await approveMission(a.client, mission(lonely))).toMatchObject({ ok: false, code: "settle_unavailable" });
    expect(a.calls.length).toBe(0);
    const plain = { ...plan, stages: plan.stages.map((s: any) => ({ ...s, estimated: undefined })) };
    const b = fakeMoneyClient({ withoutPerStageSettlement: true });
    expect(await approveMission(b.client, mission(plain))).toMatchObject({ ok: true });
    expect(b.calls.map((c) => c.name)).not.toContain("settle_job_by_stage_atomic");
    expect(Object.keys(b.calls.find((c) => c.name === "create_quote_atomic")!.args.p_items[0])).not.toContain("stageUnitsPoints");
  });
});

describe("the settlement per stage on the money fake (the SQL's rules), end to end through approveMission and settleMission", () => {
  async function run(p: any, dc: number, dp: number, opts: { cap?: number } = {}) {
    const money = fakeMoneyClient({ balance: 10_000 });
    const a = await approveMission(money.client, mission(p));
    if (!a.ok) throw new Error(a.code);
    const units = stageUnitsOf(p)!;
    const s = await settleMission(money.client, { jobId: a.jobId, deliveredUnits: dc + dp, unitPricePoints: a.unitPricePoints, reservedPoints: a.reservePoints, costUsd: 0.1, resultPath: "r.xlsx", stage: { units, counts: { base: dc, estimated: dp } } });
    return { money, a, s };
  }
  it("(a) everything delivered 2,234; (b) no person 373, the rest released; (c) 5 + 4 people 1,117, 5 + 5 1,303; the customer's balance moves by exactly the charge", async () => {
    for (const [dc, dp, charged] of [[5, 10, 2234], [5, 0, 373], [5, 4, 1117], [5, 5, 1303], [3, 0, 224]] as Array<[number, number, number]>) {
      const { money, s } = await run(plan, dc, dp);
      expect(s, `${dc}+${dp}`).toMatchObject({ ok: true, kind: "settled", chargedPoints: charged, expectedChargedPoints: charged, matchesExpectation: true, releasedPoints: 2569 - charged });
      expect(money.balance()).toBe(10_000 - charged);
    }
  });
  it("the no-contact world: zero people charges the blended 67, never the by-stage 200", async () => {
    const { money, s } = await run(noContact, 5, 0);
    expect(s).toMatchObject({ ok: true, chargedPoints: 67, matchesExpectation: true });
    expect(money.balance()).toBe(10_000 - 67);
  });
  it("nothing delivered: the whole hold comes back and no per-stage function is called", async () => {
    const money = fakeMoneyClient({ balance: 10_000 });
    const a = await approveMission(money.client, mission(plan));
    if (!a.ok) throw new Error("approve");
    const s = await settleMission(money.client, { jobId: a.jobId, deliveredUnits: 0, unitPricePoints: a.unitPricePoints, reservedPoints: a.reservePoints, costUsd: 0, resultPath: null, stage: { units: stageUnitsOf(plan)!, counts: { base: 0, estimated: 0 } } });
    expect(s).toMatchObject({ ok: true, kind: "released" });
    expect(money.balance()).toBe(10_000);
    expect(money.calls.filter((c) => c.name === "settle_job_by_stage_atomic").length).toBe(1); // the approval's probe only
  });
  it("Gate 1 P1-3: a settlement that cannot run per stage is REFUSED and stays retryable: no fallback to the one-unit function, no charge, the hold stays", async () => {
    const money = fakeMoneyClient({ balance: 10_000 });
    const a = await approveMission(money.client, mission(plan));
    if (!a.ok) throw new Error("approve");
    // the database loses the function after the approval (rolled back): the next call of it fails
    money.inject("settle_job_by_stage_atomic", "before");
    const s = await settleMission(money.client, { jobId: a.jobId, deliveredUnits: 5, unitPricePoints: a.unitPricePoints, reservedPoints: a.reservePoints, costUsd: 0, resultPath: null, stage: { units: stageUnitsOf(plan)!, counts: { base: 5, estimated: 0 } } }).catch((e) => ({ ok: false, code: "threw", detail: String(e) }));
    expect(s.ok).toBe(false);
    expect(money.calls.map((c) => c.name)).not.toContain("settle_job_atomic");
    expect(money.ledger.some((r) => r.type === "charge")).toBe(false);
    expect(money.ledger.some((r) => r.type === "release")).toBe(false);
    // retry: it settles per stage
    const again = await settleMission(money.client, { jobId: a.jobId, deliveredUnits: 5, unitPricePoints: a.unitPricePoints, reservedPoints: a.reservePoints, costUsd: 0, resultPath: null, stage: { units: stageUnitsOf(plan)!, counts: { base: 5, estimated: 0 } } });
    expect(again).toMatchObject({ ok: true, chargedPoints: 373 });
  });
  it("a split that does not add up to the rows delivered is refused before anything is recorded; the database refuses a group above what was sold", async () => {
    const money = fakeMoneyClient({ balance: 10_000 });
    const a = await approveMission(money.client, mission(plan));
    if (!a.ok) throw new Error("approve");
    const before = money.calls.length;
    const s = await settleMission(money.client, { jobId: a.jobId, deliveredUnits: 9, unitPricePoints: a.unitPricePoints, reservedPoints: a.reservePoints, costUsd: 0, resultPath: null, stage: { units: stageUnitsOf(plan)!, counts: { base: 5, estimated: 3 } } });
    expect(s).toMatchObject({ ok: false, code: "stage_counts_mismatch" });
    expect(money.calls.length).toBe(before);
    const r = await money.client.rpc("complete_chunk", { p_job_id: a.jobId, p_expected_step: 0, p_new_cursor: "completed", p_new_delivered_units: 9 });
    expect(r.error).toBeUndefined();
    expect((await money.client.rpc("settle_job_by_stage_atomic", { p_job_id: a.jobId, p_units: { base: 5, estimated: 11 } })).error?.message).toMatch(/do not match/);
    expect((await money.client.rpc("settle_job_by_stage_atomic", { p_job_id: a.jobId, p_units: { base: 5 } })).error?.message).toMatch(/Invalid delivered units/);
    expect(money.ledger.some((r) => r.type === "charge")).toBe(false);
  });
  it("without a stage the settlement is the one-unit function, exactly as before", async () => {
    const plain = { ...plan, stages: plan.stages.map((s: any) => ({ ...s, estimated: undefined })) };
    const money = fakeMoneyClient({ balance: 10_000, withoutPerStageSettlement: true });
    const a = await approveMission(money.client, mission(plain));
    if (!a.ok) throw new Error("approve");
    const s = await settleMission(money.client, { jobId: a.jobId, deliveredUnits: 5, unitPricePoints: a.unitPricePoints, reservedPoints: a.reservePoints, costUsd: 0, resultPath: null });
    expect(s).toMatchObject({ ok: true, chargedPoints: 745 });
  });
});

describe("Gate 1 P1-2: the inventory of every route that settles a job", () => {
  const ROOT = path.resolve(__dirname, "..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const f of readdirSync(dir)) {
      if (f === "node_modules" || f === ".next" || f.startsWith(".")) continue;
      const full = path.join(dir, f);
      if (statSync(full).isDirectory()) walk(full, out); else if (/\.(ts|tsx|mjs|js)$/.test(f)) out.push(full);
    }
    return out;
  };
  const files = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "agent", "src")), ...walk(path.join(ROOT, "scripts"))];
  const rel = (f: string) => path.relative(ROOT, f);
  it("the callers of the one-unit and the per-stage settlement RPCs are exactly these (a new caller must be reasoned about, not added by accident)", () => {
    const callers = (name: string) => files.filter((f) => new RegExp(`rpc(?:\\.call)?\\([^)]*["']${name}["']`).test(readFileSync(f, "utf8").replace(/\n/g, " "))).map(rel).sort();
    expect(callers("settle_job_by_stage_atomic")).toEqual(["src/lib/agentMission/lifecycle.ts"]);
    // lifecycle.ts: the mission's settlement (the one-unit call only when there is no stage); worker/chunk: the website's own legacy pipeline (jobs it created; an agent job is closed to it by the long lease of claim_job_chunk, see lifecycle.approveMission);
    // verify script: a manual check on a scratch job
    expect(callers("settle_job_atomic")).toEqual(["scripts/verify/verify-settle-job.ts", "src/app/api/worker/chunk/route.ts", "src/lib/agentMission/lifecycle.ts"]);
  });
  it("the ordinary finalizer requires per-stage units for estimated work, and the add-on settles its own job without them", () => {
    const run = readFileSync(path.join(ROOT, "agent/src/runMission.ts"), "utf8");
    const worker = readFileSync(path.join(ROOT, "agent/src/missionSettlement.ts"), "utf8");
    const sql = readFileSync(path.join(ROOT, "supabase/migrations/20261122010000_finalize_agent_delivery_atomic.sql"), "utf8");
    expect(run).not.toMatch(/settleMission\(/);
    expect(worker).toMatch(/if \(group.size > 0 && !units\) throw new DeliveryFault\("binding_mismatch"\)/);
    expect(worker).toMatch(/stage_units: billed.counts/);
    expect(worker).toMatch(/await ensureOwned\(deps, mission.id\);\s*const result = await bounded\(\(\) => deps.client.rpc\("finalize_agent_delivery_atomic"/);
    expect(sql).toMatch(/IF v_price IS NOT NULL AND v_billed > 0 THEN\s*IF NOT COALESCE\(v_stage ->> 'base'/);
    expect(sql).toMatch(/IF v_stage IS NOT NULL THEN\s*v_result := public.settle_job_by_stage_atomic\(v_job_id,v_stage,v_cap,v_csv_path\);\s*ELSE\s*v_result := public.settle_job_atomic\(v_job_id,v_cap,v_csv_path\);/);
    expect(readFileSync(path.join(ROOT, "src/lib/agentMission/addonSettlement.ts"), "utf8")).not.toMatch(/stageUnits/);
    expect(run.match(/settleExecution\(/g)!.length).toBeGreaterThanOrEqual(3);
  });
});
