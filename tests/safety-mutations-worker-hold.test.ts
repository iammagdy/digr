import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADDON_RELEASED_ERROR } from "../src/lib/agentMission/addonSettlement";
import { HOLD_WAITS_MAX } from "../agent/src/stage4/unrecordedHold";
import { cleanMutants, loadMutant, type Mutation } from "./helpers/mutants";
import { holdRaceWorld, recordsJob, type HoldRaceWorld } from "./helpers/holdRaceWorld";

/**
 * SAFETY FIX E, MUTATION TESTS: each test removes ONE protection of the worker's resolver (agent/src/stage4/unrecordedHold.ts) from a copy of the source, runs the REAL worker runner over that copy, and the property the protection exists for must BREAK. A refactor that moves a guard
 * makes the mutation not apply and the test fails loudly (tests/helpers/mutants.ts). The real code is never modified by these tests.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => vi.unstubAllGlobals());
afterAll(cleanMutants);
const HOLD = "agent/src/stage4/unrecordedHold.ts";
const RUN = "agent/src/stage4/runAddon.ts";
const START = 100_000;

async function mutant(edits: ReadonlyArray<Mutation>) {
  const hold = await loadMutant(HOLD, edits);
  const run = await loadMutant(RUN, [], { "./unrecordedHold": hold.path });
  return { runAddonSafely: run.module.runAddonSafely as (deps: HoldRaceWorld["deps"], row: unknown) => Promise<void>, resolve: hold.module.resolveUnrecordedHold as (deps: HoldRaceWorld["deps"], row: unknown) => Promise<string> };
}
async function unrecorded(w: HoldRaceWorld, id: string) {
  w.money.failUpdates({ when: recordsJob, mode: "error_before" });
  w.money.failUpdates({ when: (p) => p.status === "plan_ready", mode: "error_before" });
  await w.approve(id);
  w.money.clearFaults();
}
const over = (w: HoldRaceWorld): HoldRaceWorld["deps"] & { now: () => Date } => ({ ...w.deps, now: () => new Date(Date.now() + 2 * 3600_000) });
async function turn(m: Awaited<ReturnType<typeof mutant>>, w: HoldRaceWorld, id: string, deps: HoldRaceWorld["deps"] & { now?: () => Date } = w.deps) {
  w.expireLease(id);
  const claimed = await w.claim("worker-1");
  if (claimed) await m.runAddonSafely(deps, claimed);
  return claimed;
}

describe("MUTATION: the worker's resolver of an unrecorded hold", () => {
  it("without reading the job's money state the worker cannot find the hold: the paid request is not completed and its hold is left held (the defect, back)", async () => {
    const m = await mutant([{ from: "const state = await readJobMoneyState(client, jobId);", to: "const state: import(\"../../../src/lib/agentMission/addonMoneyState\").JobMoneyState = { kind: \"none\" };" }]);
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    await turn(m, w, a.id, over(w));
    expect(w.rowOf(a.id).status).not.toBe("completed");
    expect(w.money.jobs.get(a.jobId)!.status).toBe("running");
    expect(w.money.balance()).toBe(START - a.hold);
  });

  it("without the close of a PROVED release, the request is left `executing` after the points came back", async () => {
    const m = await mutant([{ from: "if (await write({ ...releasedRowPatch(jobId, quoteId, state.holdPoints) })) {", to: "if (false) {" }]);
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    await w.money.client.rpc("release_job_atomic", { p_job_id: a.jobId, p_error_message: "x", p_force: true });
    await turn(m, w, a.id);
    expect(w.rowOf(a.id).error).not.toBe(ADDON_RELEASED_ERROR);
    expect(w.rowOf(a.id).status).toBe("executing");
  });

  it("if an UNPROVEN state were read as «released», a request whose points are still held would be ended `failed` with the customer told they came back", async () => {
    const m = await mutant([{ from: "const state = await readJobMoneyState(client, jobId);", to: "const state0 = await readJobMoneyState(client, jobId);\n  const state: import(\"../../../src/lib/agentMission/addonMoneyState\").JobMoneyState = state0.kind === \"unknown\" ? { kind: \"released\", holdPoints: 100 } : state0;" }]);
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    w.money.ledger.splice(w.money.ledger.findIndex((r) => r.id === `res_${a.jobId}`), 1);
    await turn(m, w, a.id);
    expect(w.rowOf(a.id)).toMatchObject({ status: "failed", error: ADDON_RELEASED_ERROR });
    expect(w.money.jobs.get(a.jobId)!.status).toBe("running"); // the job still runs: the claim of «released» was false
  });

  it("without the comparison with the code's own price, a hold of another size is adopted and the run goes on over it", async () => {
    const m = await mutant([{ from: "if (!priced || priced.hold !== state.holdPoints) {\n        log(\"hold_mismatch\", state);", to: "if (false) {\n        log(\"hold_mismatch\", state);" }]);
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    w.money.jobs.get(a.jobId)!.reserved_credits = a.hold + 7;
    w.money.ledger.find((r) => r.id === `res_${a.jobId}`)!.delta = -(a.hold + 7);
    await turn(m, w, a.id);
    expect(w.rowOf(a.id).job_id).toBe(a.jobId); // adopted: the row now says a hold the code never priced
    expect(w.rowOf(a.id).status).not.toBe("plan_ready");
  });

  it("without the ownership check, a worker whose claim was taken over writes on the new owner's row", async () => {
    const m = await mutant([{ from: "if (!row || row.status !== \"executing\" || row.worker_id !== snapshot.worker_id) return \"handled\";", to: "if (!row || row.status !== \"executing\") return \"handled\";" }]);
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    w.expireLease(a.id);
    const old = { ...(await w.claim("worker-1"))! };
    w.expireLease(a.id);
    await w.claim("worker-2");
    const before = JSON.stringify(w.rowOf(a.id));
    await m.resolve(w.deps, old);
    expect(JSON.stringify(w.rowOf(a.id))).not.toBe(before);
  });

  it("without the bound on the waits, a database that cannot be read keeps the request waiting for ever (it is never handed back)", async () => {
    const m = await mutant([{ from: "if (mayWait && waits < HOLD_WAITS_MAX) {", to: "if (mayWait) {" }]);
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    w.money.setLedgerDown(true);
    const turns = HOLD_WAITS_MAX + 6;
    for (let i = 0; i < turns; i += 1) await turn(m, w, a.id);
    expect(w.rowOf(a.id).status).toBe("approved");
    expect(w.money.ledgerReads.length).toBeGreaterThan(HOLD_WAITS_MAX + 1);
  });

  it("without the wait for an approval that may still be running, the worker hands the request back under it and the approval's record is refused", async () => {
    const m = await mutant([{ from: "if (mayWait && waits < HOLD_WAITS_MAX) {", to: "if (false) {" }]);
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    const orig = w.money.client.rpc;
    let ran = false;
    w.money.client.rpc = async (name: string, args: any) => {
      if (name === "accept_quote_atomic" && !ran) { ran = true; await turn(m, w, a.id); }
      return orig(name, args);
    };
    const out = await w.approve(a.id);
    expect(out.ok).toBe(false); // the approval's own record found the row moved on
    expect(w.rowOf(a.id).status).toBe("plan_ready");
  });

  it("a worker that does not require the job to be RUNNING adopts a job nobody claimed and goes on to run it", async () => {
    const m = await mutant([{ from: "if (state.status !== \"running\") return waitOrHandBack(state, HOLD_ERRORS.unclaimed, inFlight);", to: "" }]);
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    w.money.inject("claim_job_chunk", "before");
    w.money.failUpdates({ when: (p) => p.status === "plan_ready", mode: "error_before" });
    await w.approve(a.id);
    w.money.clearFaults();
    const calls = w.rpcNames().length;
    await turn(m, w, a.id, over(w));
    expect(w.rpcNames().length).toBeGreaterThan(calls); // the worker called money functions on an unclaimed job
  });

  it("a CHARGED file whose row lost its job id must be adopted and published; ending it as «released, no charge» would hide a charge", async () => {
    const m = await mutant([{ from: "return (await record(priced.hold)) ? \"verified\" : waitOrHandBack(state, HOLD_ERRORS.unknown, true);\n    }\n    case \"settled_free\"", to: "await write({ ...releasedRowPatch(jobId, quoteId, state.holdPoints) });\n      return \"handled\";\n    }\n    case \"settled_free\"" }]);
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    const put = w.store.putNewStrict.bind(w.store);
    const down = { down: true };
    w.store.putNewStrict = async (mm, p, c, t) => { if (down.down && p.startsWith("reviews/")) throw new Error("storage down"); return put(mm, p, c, t); };
    await turn(m, w, a.id);
    expect(w.ledgerCount("charge", a.jobId)).toBe(1);
    down.down = false;
    Object.assign(w.rowOf(a.id), { job_id: null, quote_id: null, reserved_points: null, status: "approved", worker_id: null });
    await turn(m, w, a.id);
    expect(w.rowOf(a.id)).toMatchObject({ status: "failed", charged_points: 0 }); // «no charge» said of a charged job
    expect([...w.store.files.keys()].some((k) => k.endsWith("reviews/r0001.json"))).toBe(false); // and the owed file is never published
  });

  it("a resolver that called a money function would show in the rpc log (here: a second release of an already released job)", async () => {
    const m = await mutant([{ from: "if (await write({ ...releasedRowPatch(jobId, quoteId, state.holdPoints) })) {", to: "await client.rpc(\"release_job_atomic\", { p_job_id: jobId, p_error_message: \"x\" });\n      if (await write({ ...releasedRowPatch(jobId, quoteId, state.holdPoints) })) {" }]);
    const w = await holdRaceWorld({ balance: START });
    const a = w.createRow("review");
    await unrecorded(w, a.id);
    await w.money.client.rpc("release_job_atomic", { p_job_id: a.jobId, p_error_message: "x", p_force: true });
    await turn(m, w, a.id);
    expect(w.countRpc("release_job_atomic", a.jobId)).toBe(2);
  });
});
