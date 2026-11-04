import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADDON_APPROVE_MESSAGES_AR, addonJobId, addonQuoteId, approveAddonOnce } from "../src/lib/agentMission/addonSettlement";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { addonRowOf, USER } from "./helpers/addonWorld";
import { recordsJob, safetyWorld, type SafetyWorld } from "./helpers/safetyWorld";

/**
 * SAFETY FIX A (docs/STAGE-4-FINANCIAL-SAFETY.md): AN APPROVAL MUST NEVER REPORT SUCCESS THAT IT CANNOT PROVE. The last step of `approveAddonOnce` records the job, the quote and the hold on the add-on row. It used to ignore the answer of that update: if it failed AFTER the hold
 * had been reserved, the customer was told «approved», the row stayed `approved` with no job id, and the worker ended it `failed` («no hold») without releasing; the hold waited for the watchdog (about 6.5 hours).
 * These tests run the REAL `approveAddonOnce` over the hardened money fake and a missions table with injected failures. A failure is injected at the one place that matters (the update that carries `job_id`), in every shape a database call can fail:
 * it never ran, it ran and the answer is an error, it threw, it ran and said «no row», it ran and the answer was lost. Every end state is checked against the money invariant. NO real money, provider, database or flag is touched.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const START = 10_000;
const world = () => { const w = safetyWorld({ balance: START }); const row = addonRowOf({}); w.missions.set(row.id, row); return { w, row }; };
const hold = (row: ReturnType<typeof addonRowOf>) => row.plan.addon.pricing.holdPoints as number;
const reserves = (w: SafetyWorld) => w.ledger.filter((r) => r.type === "reserve");
const money = (w: SafetyWorld) => w.ledger.filter((r) => r.type === "release" || r.type === "charge");
const rpcNames = (w: SafetyWorld) => w.calls.map((c) => c.name);

/** The money invariant of every end state: at most one reserve per job, never a release or a charge here, the balance never above the start nor negative. */
function sound(w: SafetyWorld, reservedExpected: number): void {
  const ids = w.ledger.map((l) => l.id);
  expect(new Set(ids).size, "no ledger id twice").toBe(ids.length);
  expect(reserves(w).length, "at most one reserve").toBeLessThanOrEqual(1);
  expect(w.balance(), "never negative").toBeGreaterThanOrEqual(0);
  expect(w.balance(), "never more than the start").toBeLessThanOrEqual(START);
  expect(START - w.balance(), "held exactly what was reserved, or nothing").toBeOneOf([0, reservedExpected]);
  expect(w.tableCalls.filter((t) => t !== "missions" && t !== "mission_events" && t !== "jobs"), "no money table is written by hand").toEqual([]);
}
const approve = (w: SafetyWorld, id: string) => approveAddonOnce(w.client, { id, actorId: USER, expectUserId: USER });
const recorded = (w: SafetyWorld, id: string) => { const r = w.missions.get(id)!; return r.status === "approved" && r.job_id === addonJobId(addonQuoteId(id)); };

describe("FIX A: the final update of the approval fails AFTER the hold was reserved", () => {
  for (const mode of ["error_before", "error_after", "throw_before", "throw_after", "none_matched"] as const) {
    it(`the update that records the job fails for good (${mode}): the approval does NOT report success, the row is not left «approved» without a job, ONE reserve exists, nothing is released or charged`, async () => {
      const { w, row } = world();
      w.failUpdates({ when: recordsJob, mode });
      const out = await approve(w, row.id);
      expect(out.ok, "no success without a recorded job").toBe(false);
      if (out.ok) return;
      expect(out.code).toBe("record_unverified");
      expect(out.error).toBe(ADDON_APPROVE_MESSAGES_AR.record_unverified);
      const r = w.missions.get(row.id)!;
      expect(r.status === "approved" && !r.job_id, "never left approved with no job id (the worker would end it without releasing)").toBe(false);
      expect(r.status).toBe("plan_ready");
      expect(r.approved_at, "the approval mark stays: the page must not say nothing was held").toBeTruthy();
      expect(reserves(w)).toHaveLength(1);
      expect(money(w)).toEqual([]);
      expect(w.calls.filter((c) => c.name === "release_job_atomic")).toEqual([]);
      expect(rpcNames(w)).toEqual(["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk"]);
      sound(w, hold(row));
    });
  }
  it("the update is retried a bounded number of times (three), never in a loop: a database that stays down is asked exactly three times", async () => {
    const { w, row } = world();
    w.failUpdates({ when: recordsJob, mode: "error_before" });
    await approve(w, row.id);
    expect(w.writes.filter((x) => recordsJob(x.patch))).toHaveLength(3);
  });
  for (const mode of ["error_before", "throw_before", "none_matched"] as const) {
    it(`a transient failure of the record update (${mode}, once): the retry inside the same approval records it and the approval succeeds with ONE reserve`, async () => {
      const { w, row } = world();
      w.failUpdates({ when: recordsJob, mode, times: 1 });
      const out = await approve(w, row.id);
      expect(out.ok).toBe(true);
      expect(recorded(w, row.id)).toBe(true);
      expect(w.missions.get(row.id)).toMatchObject({ reserved_points: hold(row), quote_id: addonQuoteId(row.id), unit_price_points: 1 });
      expect(reserves(w)).toHaveLength(1);
      expect(rpcNames(w)).toEqual(["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk"]);
      sound(w, hold(row));
    });
  }
  for (const mode of ["error_after", "throw_after", "lost_ok_answer"] as const) {
    it(`the update COMMITTED but its answer was lost (${mode}): the read-back finds the job on the row, so the approval is reported ok once, with the job that is really recorded`, async () => {
      const { w, row } = world();
      w.failUpdates({ when: recordsJob, mode, times: 1 });
      const out = await approve(w, row.id);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.jobId).toBe(w.missions.get(row.id)!.job_id);
      expect(recorded(w, row.id)).toBe(true);
      expect(w.events, "the customer's «approved» event is written once").toHaveLength(1);
      expect(reserves(w)).toHaveLength(1);
      sound(w, hold(row));
    });
  }
  it("the READ-BACK itself fails and the update's answer was an error: the approval is NOT reported ok (it cannot be proved), the row goes back to waiting, the hold stays for the retry", async () => {
    const { w, row } = world();
    w.failUpdates({ when: recordsJob, mode: "error_after" });
    w.failSelects({ when: (c) => c.includes("job_id") && c.includes("quote_id") });
    const out = await approve(w, row.id);
    expect(out).toMatchObject({ ok: false, code: "record_unverified" });
    expect(w.missions.get(row.id)!.status).toBe("plan_ready");
    expect(reserves(w)).toHaveLength(1);
    sound(w, hold(row));
  });
  it("an update that answers «no row changed» while the row holds ANOTHER job id is not a success either", async () => {
    const { w, row } = world();
    w.failUpdates({ when: recordsJob, mode: "none_matched" });
    w.failUpdates({ when: (p) => p.status === "plan_ready", mode: "error_before" }); // the revert fails too
    const out = await approve(w, row.id);
    expect(out.ok).toBe(false);
    expect(w.missions.get(row.id)!.job_id ?? null).toBeNull();
  });
  it("the customer's sentence for an unverifiable approval is Arabic only, says the points MAY be held, never says nothing was held, never says approved", () => {
    const s = ADDON_APPROVE_MESSAGES_AR.record_unverified;
    expect(checkCustomerText(s).issues).toEqual([]);
    expect(s).toMatch(/قد تكون نقاطك حُجزت/);
    expect(s).not.toMatch(/لم يُحجز|لم يُخصم شيء|عاد الحجز|اعتُمد الطلب وحُجزت/);
    expect(s).toMatch(/لن يُحجز شيء مرتين/);
  });
});

describe("FIX A: the retry after an unverifiable approval converges on the same quote, job and reserve", () => {
  it("record fails for good, then the database works: the SECOND approval records the same job; still ONE reserve; no release, no charge, no second quote or job", async () => {
    const { w, row } = world();
    w.failUpdates({ when: recordsJob, mode: "error_before" });
    expect((await approve(w, row.id)).ok).toBe(false);
    w.clearFaults();
    const second = await approve(w, row.id);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.jobId).toBe(addonJobId(addonQuoteId(row.id)));
    expect(recorded(w, row.id)).toBe(true);
    expect(reserves(w)).toHaveLength(1);
    expect(w.jobs.size).toBe(1);
    expect(w.quotes.size).toBe(1);
    expect(money(w)).toEqual([]);
    expect(w.calls.filter((c) => c.name === "release_job_atomic")).toEqual([]);
    sound(w, hold(row));
  });
  it("five clicks while the record update keeps failing: ONE reserve, at most one click is answered ok, and none is answered ok without a recorded job", async () => {
    const { w, row } = world();
    w.failUpdates({ when: recordsJob, mode: "error_before" });
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => approve(w, row.id)));
    expect(reserves(w)).toHaveLength(1);
    expect(answers.filter((a) => a.ok)).toHaveLength(0);
    expect(w.missions.get(row.id)!.job_id ?? null).toBeNull();
    sound(w, hold(row));
  });
  it("five clicks and a healthy database: exactly one approval, one reserve", async () => {
    const { w, row } = world();
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => approve(w, row.id)));
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(reserves(w)).toHaveLength(1);
    expect(recorded(w, row.id)).toBe(true);
  });
  it("a click after a verified approval changes nothing (the ordinary path is unchanged)", async () => {
    const { w, row } = world();
    expect((await approve(w, row.id)).ok).toBe(true);
    const ledger = JSON.stringify(w.ledger);
    expect(await approve(w, row.id)).toMatchObject({ ok: false, status: 409, error: ADDON_APPROVE_MESSAGES_AR.already_approved });
    expect(JSON.stringify(w.ledger)).toBe(ledger);
  });
});

describe("FIX A: the customer is never told «nothing was reserved» when the reservation outcome is uncertain", () => {
  for (const when of ["before", "after"] as const) {
    it(`accept_quote_atomic fails (${when}): the reservation MAY exist, so the sentence says «may be held», and a retry converges with ONE reserve`, async () => {
      const { w, row } = world();
      w.inject("accept_quote_atomic", when);
      const out = await approve(w, row.id);
      expect(out).toMatchObject({ ok: false, code: "approval_unverified", error: ADDON_APPROVE_MESSAGES_AR.approval_unverified });
      expect(ADDON_APPROVE_MESSAGES_AR.approval_unverified).toMatch(/قد تكون نقاطك حُجزت/);
      expect(ADDON_APPROVE_MESSAGES_AR.approval_unverified).not.toMatch(/لم يُحجز|لم يُخصم شيء|عاد الحجز/);
      expect(w.missions.get(row.id)!.status).toBe("plan_ready");
      expect((await approve(w, row.id)).ok).toBe(true);
      expect(reserves(w)).toHaveLength(1);
      sound(w, hold(row));
    });
  }
  it("a definite refusal (insufficient balance) still says nothing was deducted: it is certain", async () => {
    const w = safetyWorld({ balance: 5 });
    const row = addonRowOf({});
    w.missions.set(row.id, row);
    const out = await approve(w, row.id);
    expect(out).toMatchObject({ ok: false, status: 402, code: "insufficient_balance", error: ADDON_APPROVE_MESSAGES_AR.insufficient_balance });
    expect(reserves(w)).toHaveLength(0);
  });
  it("create_quote_atomic fails: no money can have moved (a quote reserves nothing), so «nothing held» is still the sentence", async () => {
    const { w, row } = world();
    w.inject("create_quote_atomic", "before");
    expect(await approve(w, row.id)).toMatchObject({ ok: false, code: "quote_failed", error: ADDON_APPROVE_MESSAGES_AR.quote_failed });
    expect(reserves(w)).toHaveLength(0);
  });
  it("claim_job_chunk fails AND the release that follows fails too: the hold may still exist, so the sentence is the uncertain one, never «the hold was returned in full»", async () => {
    const { w, row } = world();
    w.inject("claim_job_chunk", "before");
    w.inject("release_job_atomic", "before");
    const out = await approve(w, row.id);
    expect(out).toMatchObject({ ok: false, code: "approval_unverified" });
    expect(reserves(w)).toHaveLength(1);
    expect(w.ledger.filter((l) => l.type === "release")).toEqual([]);
    expect(w.missions.get(row.id)!.status).toBe("plan_ready");
  });
  it("claim_job_chunk fails and the release SUCCEEDS: the hold really came back, so «returned in full» is true and the ledger shows the release", async () => {
    const { w, row } = world();
    w.inject("claim_job_chunk", "before");
    const out = await approve(w, row.id);
    expect(out).toMatchObject({ ok: false, error: ADDON_APPROVE_MESSAGES_AR.claim_failed, code: "claim_failed" });
    expect(w.ledger.filter((l) => l.type === "release")).toHaveLength(1);
    expect(w.balance()).toBe(START);
  });
});
