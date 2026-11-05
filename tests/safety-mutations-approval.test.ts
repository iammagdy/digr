import { afterAll, describe, expect, it } from "vitest";
import { addonJobId, addonQuoteId, ADDON_RELEASED_SUMMARY_AR } from "../src/lib/agentMission/addonSettlement";
import { addonRowOf, USER } from "./helpers/addonWorld";
import { cleanMutants, loadMutant } from "./helpers/mutants";
import { recordsJob, safetyWorld } from "./helpers/safetyWorld";

/**
 * SAFETY ROUND, MUTATION TESTS for fixes A and C: each test removes ONE protection from a copy of the source (tests/helpers/mutants.ts) and runs the scenario that the protection exists for; the property must then BREAK. If a refactor makes the protection disappear or move,
 * the mutation no longer applies and the test fails loudly. The real code is never modified by these tests.
 */
afterAll(cleanMutants);
const SETTLEMENT = "src/lib/agentMission/addonSettlement.ts";
const STATE = "src/lib/agentMission/addonMoneyState.ts";
const RECOVERY = "src/lib/agentMission/addonRecovery.ts";
const FILE = "msn_5851abc92a1e6645a9cd";
const make = () => { const w = safetyWorld({ balance: 10_000 }); const row = addonRowOf({ kind: "review", of: FILE }); w.missions.set(row.id, row); return { w, row, jobId: addonJobId(addonQuoteId(row.id)) }; };

describe("MUTATION: fix A (the approval proves its record)", () => {
  it("without the check of the record, an approval whose record update never commits is reported OK with no job on the row (the defect, back)", async () => {
    const m = await loadMutant(SETTLEMENT, [{ from: "if (!(await recordApproval(client, input.id, record))) {", to: "if (false) {" }]);
    const { w, row } = make();
    w.failUpdates({ when: recordsJob, mode: "error_before" });
    const out = await m.module.approveAddonOnce(w.client, { id: row.id, actorId: USER, expectUserId: USER });
    expect(out.ok, "the mutant claims success").toBe(true);
    expect(w.missions.get(row.id)!.job_id ?? null, "with no job on the row").toBeNull();
  });
  it("without the READ-BACK (trusting the update), the same approval is reported OK without a recorded job", async () => {
    const m = await loadMutant(SETTLEMENT, [{ from: "if (!error && data && data.job_id === record.job_id && data.quote_id === record.quote_id && Number(data.reserved_points) === record.reserved_points) return true;", to: "if (true) return true;" }]);
    const { w, row } = make();
    w.failUpdates({ when: recordsJob, mode: "error_before" });
    const out = await m.module.approveAddonOnce(w.client, { id: row.id, actorId: USER, expectUserId: USER });
    expect(out.ok).toBe(true);
    expect(w.missions.get(row.id)!.job_id ?? null).toBeNull();
  });
  it("with an unbounded number of tries the database that stays down is asked far more than three times", async () => {
    const m = await loadMutant(SETTLEMENT, [{ from: "export const APPROVAL_RECORD_ATTEMPTS = 3;", to: "export const APPROVAL_RECORD_ATTEMPTS = 50;" }]);
    const { w, row } = make();
    w.failUpdates({ when: recordsJob, mode: "error_before" });
    await m.module.approveAddonOnce(w.client, { id: row.id, actorId: USER, expectUserId: USER });
    expect(w.writes.filter((x) => recordsJob(x.patch)).length).toBeGreaterThan(3);
  });
  it("without the uncertain sentence for a failed accept, the customer is told the CERTAIN refusal («nothing was deducted») though the hold may exist", async () => {
    const m = await loadMutant(SETTLEMENT, [{ from: 'if (accepted?.error) { await revert("approval_unverified"); return bad(409, "approval_unverified", "approval_unverified"); }', to: 'if (accepted?.error) { await revert("accept_failed"); return bad(409, "accept_failed", "accept_failed"); }' }]);
    const { w, row } = make();
    w.injectError("accept_quote_atomic", "after");
    const out = await m.module.approveAddonOnce(w.client, { id: row.id, actorId: USER, expectUserId: USER });
    expect(out.code).toBe("accept_failed");
    expect(w.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
  });
  it("without the proof of the release, a refused release is reported as «the hold came back»", async () => {
    const m = await loadMutant(SETTLEMENT, [{ from: 'if (released?.error || released?.data?.success !== true) { await revert("approval_unverified"); return bad(409, "approval_unverified", "approval_unverified"); }', to: "if (false) { return bad(409, \"approval_unverified\", \"approval_unverified\"); }" }]);
    const { w, row } = make();
    w.injectError("claim_job_chunk", "after"); // claimed, answer lost: the lease is ours, so the release is refused
    const out = await m.module.approveAddonOnce(w.client, { id: row.id, actorId: USER, expectUserId: USER });
    expect(out.code, "the mutant says the hold was returned").toBe("claim_failed");
    expect(w.ledger.filter((l) => l.type === "release")).toEqual([]);
  });
});

describe("MUTATION: fix C (recovery ends only what the database PROVES)", () => {
  const released = async (w: ReturnType<typeof make>["w"], id: string) => { w.injectError("claim_job_chunk", "before"); await (await import("../src/lib/agentMission/addonSettlement")).approveAddonOnce(w.client, { id, actorId: USER, expectUserId: USER }); };
  it("if a failed job WITHOUT its release row were read as released, a request would be ended on the status alone", async () => {
    const state = await loadMutant(STATE, [{ from: "return relOk && chg === undefined ? { kind: \"released\", holdPoints: hold } : unknown(\"inconsistent\");", to: "return { kind: \"released\", holdPoints: hold };" }]);
    const rec = await loadMutant(RECOVERY, [], { "./addonMoneyState": state.path });
    const { w, row, jobId } = make();
    await released(w, row.id);
    w.missions.get(row.id)!.status = "plan_ready"; w.missions.get(row.id)!.error = null; w.missions.get(row.id)!.summary_ar = undefined as any; w.missions.get(row.id)!.job_id = null; w.missions.get(row.id)!.charged_points = undefined as any;
    w.ledger.splice(w.ledger.findIndex((l) => l.id === `rel_${jobId}`), 1); // the release row is missing: the job says failed, the ledger does not say released
    const out = await rec.module.recoverAbandonedAddon(w.client, { id: row.id, userId: USER });
    expect(out.kind, "the mutant ends the request without proof").toBe("ended_released");
  });
  it("if a CHARGED job were treated as released, a paid request would be ended as unpaid", async () => {
    const rec = await loadMutant(RECOVERY, [{ from: 'case "charged": return { kind: "charged" };', to: 'case "charged": { await client.from(MISSION_TABLE).update({ status: "failed", error: "approval_released", charged_points: 0 }).eq("id", row.id); return { kind: "ended_released" }; }' }]);
    const { w, row, jobId } = make();
    w.failUpdates({ when: recordsJob, mode: "error_before", times: 3 });
    await (await import("../src/lib/agentMission/addonSettlement")).approveAddonOnce(w.client, { id: row.id, actorId: USER, expectUserId: USER });
    w.clearFaults();
    await (await import("../src/lib/agentMission/addonSettlement")).settleAddon(w.client, { kind: "review", jobId, holdPoints: row.plan.addon.pricing.holdPoints, reportStored: true });
    const out = await rec.module.recoverAbandonedAddon(w.client, { id: row.id, userId: USER });
    expect(out.kind).toBe("ended_released");
    expect(w.missions.get(row.id)!.status, "a charged request ended as unpaid").toBe("failed");
    expect(w.ledger.some((l) => l.type === "charge")).toBe(true);
  });
  it("without the compare-and-set pin on the row's status, concurrent recoveries end the request more than once (two events)", async () => {
    const rec = await loadMutant(RECOVERY, [{ from: 'let out = q.eq("status", row.status as string);', to: "let out = q;" }, { from: 'out = row.job_id ? out.eq("job_id", row.job_id) : out.is("job_id", null);', to: "" }, { from: 'return row.approved_at ? out.eq("approved_at", row.approved_at) : out.is("approved_at", null);', to: "return out;" }]);
    const { w, row, jobId } = make();
    w.failUpdates({ when: recordsJob, mode: "error_before", times: 3 });
    await (await import("../src/lib/agentMission/addonSettlement")).approveAddonOnce(w.client, { id: row.id, actorId: USER, expectUserId: USER });
    w.clearFaults();
    await w.client.rpc("release_job_atomic", { p_job_id: jobId, p_error_message: "x", p_force: true });
    await Promise.all([1, 2, 3].map(() => rec.module.recoverAbandonedAddon(w.client, { id: row.id, userId: USER })));
    expect(w.events.filter((e) => e.message_ar === ADDON_RELEASED_SUMMARY_AR).length, "the mutant ends it again and again").toBeGreaterThan(1);
  });
  it("without the in-flight guard, an `approved` request with a LIVE lease and no job is finished while its approval may still be running", async () => {
    const rec = await loadMutant(RECOVERY, [{ from: "return !row.job_id && !(row.lease_until && Date.parse(row.lease_until) > now.getTime());", to: "return !row.job_id;" }]);
    const { w, row } = make();
    w.failUpdates({ when: recordsJob, mode: "error_before" });
    w.failUpdates({ when: (p) => p.status === "plan_ready", mode: "error_before" });
    await (await import("../src/lib/agentMission/addonSettlement")).approveAddonOnce(w.client, { id: row.id, actorId: USER, expectUserId: USER });
    w.clearFaults();
    const out = await rec.module.recoverAbandonedAddon(w.client, { id: row.id, userId: USER });
    expect(out.kind, "the mutant touches an approval that may be in flight").toBe("active");
  });
  it("if the recovery called a money function it would show in the rpc log (this guards the guard: the real recovery calls none)", async () => {
    const rec = await loadMutant(RECOVERY, [{ from: 'case "none": return { kind: "no_reservation" };', to: 'case "none": { await client.rpc("release_job_atomic", { p_job_id: jobId, p_error_message: "x" }); return { kind: "no_reservation" }; }' }]);
    const { w, row } = make();
    w.injectError("create_quote_atomic", "before");
    await (await import("../src/lib/agentMission/addonSettlement")).approveAddonOnce(w.client, { id: row.id, actorId: USER, expectUserId: USER });
    const before = w.calls.length;
    await rec.module.recoverAbandonedAddon(w.client, { id: row.id, userId: USER });
    expect(w.calls.length, "the mutant calls a money function").toBeGreaterThan(before);
  });
});
