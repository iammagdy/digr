import { afterAll, describe, expect, it } from "vitest";
import { addonJobId, addonQuoteId, approveAddonOnce, readAddonPlan, settleAddon } from "../src/lib/agentMission/addonSettlement";
import { readJobMoneyState } from "../src/lib/agentMission/addonMoneyState";
import { addonRowOf, checkAddonLedger, USER } from "./helpers/addonWorld";
import { cleanMutants, loadMutant } from "./helpers/mutants";
import { safetyWorld } from "./helpers/safetyWorld";

/**
 * FINANCIAL SAFETY, LAUNCH ROUND: A PROVEN CLEAN REFUSAL MUST NOT LEAVE THE REQUEST «POSSIBLY PAID».
 * Root cause (fixed in `approveAddonOnce`, addonSettlement.ts): the claim writes `approved_at` / `approved_by`; the old `revert` restored the status but kept them,
 * so after «not enough points» every reader saw a request that «was ever put through an approval» (no button, no cancel, another request blocked, «points may be held»).
 * The fix clears the mark ONLY when the job's OWN ledger state is READ and PROVED empty, in one compare-and-set pinned to `approved` with no job.
 * Fake money, fake tables, no network, no provider, no points. Every scenario ends with the ledger invariant.
 */
afterAll(cleanMutants);
const FILE = "msn_5851abc92a1e6645a9cd";
const SETTLEMENT = "src/lib/agentMission/addonSettlement.ts";
const make = (balance: number, rows = [addonRowOf({ kind: "review", of: FILE })]) => { const w = safetyWorld({ balance }); for (const r of rows) w.missions.set(r.id, r); return { w, row: rows[0], jobId: addonJobId(addonQuoteId(rows[0].id)) }; };
const approve = (w: ReturnType<typeof safetyWorld>, id: string, mod: { approveAddonOnce: typeof approveAddonOnce } = { approveAddonOnce }) => mod.approveAddonOnce(w.client, { id, actorId: USER, expectUserId: USER });
const marked = (w: ReturnType<typeof safetyWorld>, id: string) => { const r = w.missions.get(id)!; return r.approved_at != null || r.approved_by != null; };
const nonTopup = (w: ReturnType<typeof safetyWorld>) => w.ledger.filter((l) => l.type !== "topup");
const reserves = (w: ReturnType<typeof safetyWorld>) => w.ledger.filter((l) => l.type === "reserve");
const topUp = (w: ReturnType<typeof safetyWorld>, points: number) => { w.ledger.push({ id: `top_${w.ledger.length + 1}`, delta: points, type: "topup" } as any); };
/** A client in which, at the moment the ledger is read for the proof, ANOTHER TAB moves the request on (executing, with a job): the clearing must then not touch it. */
const movedOnClient = (w: ReturnType<typeof safetyWorld>, id: string) => ({ rpc: w.client.rpc, from: (name: string) => {
  if (name !== "credit_ledger") return w.client.from(name);
  const real = w.client.from(name);
  return { select: (...a: any[]) => { const q = real.select(...a); return { eq: (k: string, v: string) => { const r = w.missions.get(id)!; r.status = "executing"; r.job_id = "job_taken_by_another_tab"; return q.eq(k, v); } }; } };
} });

describe("a proven clean refusal leaves NO approval mark and the request fully usable", () => {
  it("not enough points: refused 402, nothing held, status waiting, NO approval mark, balance untouched, and after a top-up the same request is approved with exactly one hold", async () => {
    const { w, row, jobId } = make(50);
    const out = await approve(w, row.id);
    expect(out).toMatchObject({ ok: false, status: 402, code: "insufficient_balance" });
    expect(w.missions.get(row.id)).toMatchObject({ status: "plan_ready", lease_until: null, error: "insufficient_balance" });
    expect(marked(w, row.id), "the approval mark is cleared").toBe(false);
    expect(w.missions.get(row.id)!.job_id ?? null).toBeNull();
    expect(nonTopup(w)).toEqual([]);
    expect(w.balance()).toBe(50);
    expect(await readJobMoneyState(w.client, jobId)).toEqual({ kind: "none" });
  });

  it("not enough points then enough: the retry converges: ONE reserve, stable job and ledger ids, balance never negative", async () => {
    const { w, row, jobId } = make(50);
    expect((await approve(w, row.id)).ok).toBe(false);
    topUp(w, 10_000);
    const out = await approve(w, row.id);
    expect(out).toMatchObject({ ok: true, jobId });
    expect(reserves(w)).toHaveLength(1);
    expect(reserves(w)[0].id).toBe(`res_${jobId}`);
    expect(w.balance()).toBeGreaterThanOrEqual(0);
    expect(w.ledger.filter((l) => l.id === `res_${jobId}`)).toHaveLength(1);
    expect(w.missions.get(row.id)).toMatchObject({ status: "approved", job_id: jobId });
  });

  it("the two-active-jobs limit is a clean refusal too: nothing held, no mark", async () => {
    const rows = [1, 2, 3].map((attempt) => addonRowOf({ kind: "review", of: FILE, attempt }));
    const { w } = make(100_000, rows);
    expect((await approve(w, rows[0].id)).ok).toBe(true);
    expect((await approve(w, rows[1].id)).ok).toBe(true);
    const third = await approve(w, rows[2].id);
    expect(third).toMatchObject({ ok: false, code: "concurrency_limit" });
    expect(marked(w, rows[2].id)).toBe(false);
    expect(w.missions.get(rows[2].id)!.status).toBe("plan_ready");
    expect(reserves(w)).toHaveLength(2);
  });

  it("a quote that could not be created (the database answered with an error before any reservation) is clean", async () => {
    const { w, row } = make(10_000);
    w.injectError("create_quote_atomic", "before");
    const out = await approve(w, row.id);
    expect(out).toMatchObject({ ok: false, code: "quote_failed" });
    expect(marked(w, row.id)).toBe(false);
    expect(nonTopup(w)).toEqual([]);
  });
});

describe("a real hold or an uncertain outcome is NEVER cleared on a guess", () => {
  it("a LOST ANSWER of accept (it committed, the answer is an error): the mark STAYS, the hold exists, the sentence is the uncertain one; the retry converges on ONE hold", async () => {
    const { w, row, jobId } = make(10_000);
    w.injectError("accept_quote_atomic", "after");
    const out = await approve(w, row.id);
    expect(out).toMatchObject({ ok: false, code: "approval_unverified" });
    expect(reserves(w)).toHaveLength(1);
    expect(marked(w, row.id), "uncertain: the request still counts as possibly paid").toBe(true);
    const retry = await approve(w, row.id);
    expect(retry).toMatchObject({ ok: true, jobId });
    expect(reserves(w)).toHaveLength(1);
    const hold = readAddonPlan(row.plan)!.pricing.holdPoints;
    await settleAddon(w.client, { kind: "review", jobId, holdPoints: hold, reportStored: true });
    expect(checkAddonLedger(w, jobId, { reserved: hold, charged: hold })).toEqual([]);
  });

  it("a clean-looking failure while the job's hold EXISTS (an earlier attempt's hold): the ledger says «active», so the mark STAYS", async () => {
    const { w, row, jobId } = make(10_000);
    w.injectError("accept_quote_atomic", "after"); // the first attempt's hold is real and its answer was lost
    await approve(w, row.id);
    expect(await readJobMoneyState(w.client, jobId)).toMatchObject({ kind: "active" });
    w.injectError("create_quote_atomic", "before"); // the second attempt fails «cleanly» at the quote step
    const out = await approve(w, row.id);
    expect(out).toMatchObject({ ok: false, code: "quote_failed" });
    expect(marked(w, row.id), "a real hold is never judged absent").toBe(true);
    expect(reserves(w)).toHaveLength(1);
  });

  it("a ledger that cannot be read: nothing is proved, the mark STAYS", async () => {
    const { w, row } = make(50);
    w.setLedgerDown(true);
    const out = await approve(w, row.id);
    expect(out).toMatchObject({ ok: false, code: "insufficient_balance" });
    expect(marked(w, row.id)).toBe(true);
    w.setLedgerDown(false);
  });

  it("a jobs table that cannot be read: the mark STAYS", async () => {
    const { w, row } = make(50);
    w.setJobsDown(true);
    await approve(w, row.id);
    expect(marked(w, row.id)).toBe(true);
  });

  it("the clearing update itself fails (error before, or throws): the plain revert runs, the request is waiting again, the mark STAYS", async () => {
    for (const mode of ["error_before", "throw_before"] as const) {
      const { w, row } = make(50);
      w.failUpdates({ when: (p) => p.approved_at === null, mode });
      const out = await approve(w, row.id);
      expect(out.ok).toBe(false);
      expect(w.missions.get(row.id)).toMatchObject({ status: "plan_ready" });
      expect(marked(w, row.id), mode).toBe(true);
    }
  });

  it("the clearing is pinned to «approved with no job»: a request that moved on, or that already has a job, is not touched", async () => {
    const { w, row } = make(50);
    const writesBefore = w.writes.length;
    // simulate another tab having finished the request between the refusal and the clearing
    w.failUpdates({ when: (p) => p.approved_at === null, mode: "none_matched", times: 1 });
    await approve(w, row.id);
    const clearing = w.writes.slice(writesBefore).filter((x) => x.patch.approved_at === null);
    expect(clearing).toHaveLength(1);
    expect(clearing[0].patch).toMatchObject({ status: "plan_ready", approved_at: null, approved_by: null });
  });
});

describe("concurrency, retries and the rest of the money guarantees still hold", () => {
  it("two simultaneous approvals of one request: one claims, one is «already approved»; ONE reserve; never negative", async () => {
    const { w, row, jobId } = make(10_000);
    const [a, b] = await Promise.all([approve(w, row.id), approve(w, row.id)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(reserves(w)).toHaveLength(1);
    expect(w.ledger.filter((l) => l.id === `res_${jobId}`)).toHaveLength(1);
    expect(w.balance()).toBeGreaterThanOrEqual(0);
  });

  it("two simultaneous approvals with too little balance: nobody holds anything, no mark, balance unchanged, never negative", async () => {
    const { w, row } = make(50);
    await Promise.all([approve(w, row.id), approve(w, row.id), approve(w, row.id)]);
    expect(nonTopup(w)).toEqual([]);
    expect(w.balance()).toBe(50);
    expect(marked(w, row.id)).toBe(false);
    expect(w.missions.get(row.id)!.status).toBe("plan_ready");
  });

  it("refused, then approved, then settled: release FIRST, charge never above the reservation, stable ids, no second charge on a repeated settlement, balance = start - charge", async () => {
    const { w, row, jobId } = make(50);
    expect((await approve(w, row.id)).ok).toBe(false);
    topUp(w, 10_000);
    const start = w.balance();
    const approved = await approve(w, row.id);
    if (!approved.ok) throw new Error("not approved");
    const hold = approved.holdPoints;
    const first = await settleAddon(w.client, { kind: "review", jobId, holdPoints: hold, reportStored: true });
    const again = await settleAddon(w.client, { kind: "review", jobId, holdPoints: hold, reportStored: true });
    expect(first.chargePoints).toBeLessThanOrEqual(hold);
    expect(again.chargePoints).toBe(first.chargePoints);
    const order = w.ledger.filter((l) => l.job_id === jobId).map((l) => l.id);
    expect(order).toEqual([`res_${jobId}`, `rel_${jobId}`, `chg_${jobId}`]);
    expect(w.ledger.filter((l) => l.job_id === jobId && l.type === "charge")).toHaveLength(1);
    expect(w.balance()).toBe(start - first.chargePoints);
    expect(checkAddonLedger(w, jobId, { reserved: hold, charged: first.chargePoints })).toEqual([]);
  });
});

describe("MUTATION: each protection removed from a COPY of the source (tests/helpers/mutants.ts; the real file is never edited) must break a guarantee", () => {
  const CLEAR_LINE = 'if (state.kind === "none") {';
  it("without the ledger PROOF (clear whatever the state), a real hold's mark is cleared on a guess", async () => {
    const m = await loadMutant(SETTLEMENT, [{ from: CLEAR_LINE, to: 'if (true) {' }]);
    const { w, row } = make(10_000);
    w.injectError("accept_quote_atomic", "after");
    await approve(w, row.id, m.module);
    w.injectError("create_quote_atomic", "before");
    await approve(w, row.id, m.module);
    expect(reserves(w)).toHaveLength(1);
    expect(marked(w, row.id), "the mutant cleared the mark of a request that HAS a hold").toBe(false);
  });
  it("without the compare-and-set pinned to «approved with no job», a late clearing pulls a request that ANOTHER TAB already moved on back to waiting", async () => {
    const real = make(50);
    await approveAddonOnce(movedOnClient(real.w, real.row.id) as any, { id: real.row.id, actorId: USER, expectUserId: USER });
    expect(real.w.missions.get(real.row.id)!.status, "the real code leaves the moved-on request alone").toBe("executing");
    const m = await loadMutant(SETTLEMENT, [{ from: '.eq("id", input.id).eq("status", "approved").is("job_id", null).select("id");\n        if (!cleared?.error) return;', to: '.eq("id", input.id).select("id");\n        if (!cleared?.error) return;' }]);
    const bad = make(50);
    await m.module.approveAddonOnce(movedOnClient(bad.w, bad.row.id) as any, { id: bad.row.id, actorId: USER, expectUserId: USER });
    expect(bad.w.missions.get(bad.row.id)!.status, "the mutant pulled it back").toBe("plan_ready");
  });
  it("without clearing, the defect is back: a refused approval leaves the mark (request possibly paid)", async () => {
    const m = await loadMutant(SETTLEMENT, [{ from: "approved_at: null, approved_by: null }", to: "}" }]);
    const { w, row } = make(50);
    await approve(w, row.id, m.module);
    expect(marked(w, row.id), "the mutant keeps the mark").toBe(true);
  });
  it("clearing after a LOST ANSWER of accept (call the clean path for it) would cancel an uncertain hold's mark", async () => {
    const m = await loadMutant(SETTLEMENT, [{ from: 'if (accepted?.error) { await revert("approval_unverified");', to: 'if (accepted?.error) { await revertAfterCleanRefusal("approval_unverified");' }]);
    const { w, row } = make(10_000);
    w.injectError("accept_quote_atomic", "after");
    // with the hold committed the ledger says «active», so even the mutant keeps the mark: the PROOF is the second line of defence
    await approve(w, row.id, m.module);
    expect(marked(w, row.id)).toBe(true);
    // and when the answer is lost BEFORE the commit the state is «none»: the mutant clears (a guess that happens to be right here) while the real code keeps the mark: it never cleans a lost answer
    const { w: w2, row: row2 } = make(10_000);
    w2.injectError("accept_quote_atomic", "before");
    await approve(w2, row2.id, m.module);
    expect(marked(w2, row2.id), "the mutant cleans a lost answer").toBe(false);
    const { w: w3, row: row3 } = make(10_000);
    w3.injectError("accept_quote_atomic", "before");
    await approve(w3, row3.id);
    expect(marked(w3, row3.id), "the real code keeps a lost answer uncertain").toBe(true);
  });
  it("without the fallback to the plain revert, a failed clearing leaves the request stuck in «approved»", async () => {
    const m = await loadMutant(SETTLEMENT, [{ from: "    } catch { /* not proved: the plain revert below keeps the mark */ }\n    await revert(error);", to: "    } catch { /* not proved */ }" }]);
    const { w, row } = make(50);
    w.failUpdates({ when: (p) => p.approved_at === null, mode: "error_before" });
    await approve(w, row.id, m.module);
    expect(w.missions.get(row.id)!.status, "the mutant never returned the request to waiting").toBe("approved");
  });
});
