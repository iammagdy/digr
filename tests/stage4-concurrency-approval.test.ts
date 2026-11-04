import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ADDON_APPROVE_MESSAGES_AR, addonId, approveAddonOnce, settleAddon } from "../src/lib/agentMission/addonSettlement";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { reconcileOpenAddons } from "../src/lib/agentMission/stage4/addonRow";
import { createSupabaseAddonRowStore } from "../src/lib/agentMission/stage4/addonRowStore";
import { cancelReviewRequest, createReviewRequest, currentReviewRequest } from "../src/lib/agentMission/stage4/reviewRequest";
import type { FileVersion } from "../src/lib/agentMission/stage4/versions";
import { checkAddonLedger, addonRowOf as moneyRowOf } from "./helpers/addonWorld";
import { addonRows, explore, openRows, runSchedule, solo, type Maker, type Out, type Row, type SchedOpts } from "./helpers/scheduledWorld";
import { objectsOf, sizedVersion } from "./helpers/reviewQuoteWorld";

/**
 * STAGE E, PART 2: THE APPROVAL UNDER CONCURRENCY AND FAILURE (docs/STAGE-4-CONCURRENCY.md scenarios 3, 6, 7, 8 and 9). The REAL `approveAddonOnce`, `settleAddon`, `cancelReviewRequest` and `createReviewRequest` run over the scheduled world of tests/helpers/scheduledWorld.ts: one stateful
 * `missions` table (compare-and-set updates) and the HARDENED MONEY FAKE behind `rpc` (the same arithmetic and rules as the live SQL; ledger ids are unique; a refused reserve writes nothing). EVERY table step and EVERY rpc is atomic and EVERY order of the steps is run.
 * FAKE CLIENTS ONLY: no database, no provider, no real money, no flag, no route is touched. Every end state is checked against the money invariant: at most one `res_`, `rel_` and `chg_` per job, a charge never above the hold, the balance never negative.
 * Where the code cannot give a guarantee the test shows that end state on purpose and is named «DOCUMENTED UNRESOLVED RISK»; none is skipped or weakened.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const MISSION = "msn_5851abc92a1e6645a9cd";
const ME = "u-1";
const START = 100_000;
const MISSION_ROW = { id: MISSION, user_id: ME, status: "completed", plan: { stages: [] }, delivered_units: 60 };
let TWO: Record<string, string>; let ONE: Record<string, string>;
beforeAll(() => {
  const v1: FileVersion = sizedVersion(6, 3);
  const r = applyEditRequest(v1, { kind: "rename_column", sheet: "الورقة", from: "عمود 3", to: "عمود ثالث" }, { createdAt: "2026-11-03T09:30:00.000Z" });
  if (!r.ok) throw new Error(r.reason);
  ONE = objectsOf(v1); TWO = objectsOf(v1, r.version);
});

/** A well-formed, priced, unpaid REVIEW request of this customer on version `base` (its plan passes `checkAddon`). */
const waiting = (base: number, over: Record<string, unknown> = {}): Row => ({ ...moneyRowOf({ of: MISSION, baseVersion: base, kind: "review", userId: ME }), request_text: "طلب مراجعة", ...over });
const opts = (objects: Record<string, string>, more: Partial<SchedOpts> = {}): SchedOpts => ({ objects, balance: START, ...more, seed: [MISSION_ROW, ...(more.seed ?? [])] });
const approve = (id: string): Maker => async (a) => approveAddonOnce(a.client, { id, actorId: ME, expectUserId: ME });
const cancel = (id: string): Maker => async (a) => cancelReviewRequest(a.client, { missionId: MISSION, userId: ME, requestId: id });
const create = (version: number): Maker => async (a) => createReviewRequest(a.client, { missionId: MISSION, userId: ME, version });
type Approved = Awaited<ReturnType<typeof approveAddonOnce>>;
const res = (out: Out, i: number): any => { const r = out.results[i]; if (!r.ok) throw r.error; return r.value; };

/** THE MONEY INVARIANT, on every end state: one res_ per job at most, a rel_ only after a settlement or a release, a charge only after a settlement, a balance that never went negative. */
function ledgerSound(out: Out, expectedReserved?: number): void {
  const ids = out.money.ledger.map((l) => l.id);
  expect(new Set(ids).size, "no ledger id twice").toBe(ids.length);
  const reserves = out.money.ledger.filter((l) => l.type === "reserve");
  expect(reserves.length, "at most one reserve per job").toBe(new Set(reserves.map((r) => r.job_id)).size);
  for (const r of reserves) if (expectedReserved !== undefined) expect(r.delta).toBe(-expectedReserved);
  for (const l of out.money.ledger.filter((x) => x.type === "charge")) expect(-l.delta, "a charge is never above its reserve").toBeLessThanOrEqual(-out.money.ledger.find((r) => r.id === `res_${l.job_id}`)!.delta);
  expect(out.money.balance(), "the balance is never negative").toBeGreaterThanOrEqual(0);
  expect(out.world.other, "no other table is touched by hand").toEqual([]);
}
const heldJobs = (out: Out) => out.money.ledger.filter((l) => l.type === "reserve").length;

describe("SCENARIO 3: an approval starts while another request is being created", () => {
  const A = addonId(MISSION, 1, 1);
  const B = addonId(MISSION, 2, 1);
  const LOWER = A < B ? 1 : 2;
  const HIGHER = A < B ? 2 : 1;
  // the creator's list read ran BEFORE the waiting request was visible (a stale read); the waiting request exists from the start and is the one being approved
  const stale: SchedOpts["fault"] = () => false;
  for (const [label, waitingVersion, creatorVersion] of [["the waiting request has the LOWER id (it is the one that stays)", LOWER, HIGHER], ["the waiting request has the HIGHER id (the new request would stay, unless the approval starts first)", HIGHER, LOWER]] as const) {
    it(`${label}: in every order EXACTLY ONE request is open at the end, a started request is never cancelled, money is held ONLY if the approval won, and the new request never stays open next to a started one`, async () => {
      const row = waiting(waitingVersion);
      let won = 0; let lost = 0;
      const { runs } = await explore([create(creatorVersion), approve(row.id as string)], (out) => {
        void stale;
        expect(openRows(out.rows)).toHaveLength(1);
        const w = out.rows.get(row.id as string)!;
        const approval = res(out, 1) as Approved;
        if (approval.ok) {
          won += 1;
          expect(w.status, "a started request is never cancelled").toBe("approved");
          expect(openRows(out.rows).map((r) => r.id)).toEqual([row.id]);
          expect(heldJobs(out)).toBe(1);
          expect(out.money.balance()).toBe(START - (approval as { holdPoints: number }).holdPoints);
        } else {
          lost += 1;
          expect(w.status, "an approval that lost matched nothing: the request was cancelled before it").toBe("cancelled");
          expect(heldJobs(out), "no money moved when the approval lost").toBe(0);
          expect(out.money.balance()).toBe(START);
        }
        ledgerSound(out);
      }, opts(TWO, { seed: [row], stale: (i) => i.client === 0 && i.n === 2 }));
      expect(runs).toBeGreaterThan(50);
      expect(won, "the approval wins in some orders").toBeGreaterThan(0);
      if (waitingVersion === HIGHER) expect(lost, "and loses in some (the creator's cancel got there first)").toBeGreaterThan(0);
    }, 300_000);
  }
  it("when the approval LOSES to the creator's repair, it says «already approved» or «not ready» for a request that was in fact cancelled: DOCUMENTED UNRESOLVED RISK (UX only, no money): the sentence is wrong, the money state is right", async () => {
    const row = waiting(HIGHER);
    const sentences = new Set<string>();
    await explore([create(LOWER), approve(row.id as string)], (out) => { const a = res(out, 1) as Approved; if (!a.ok) sentences.add(a.error); }, opts(TWO, { seed: [row], stale: (i) => i.client === 0 && i.n === 2 }));
    expect([...sentences].sort()).toEqual([ADDON_APPROVE_MESSAGES_AR.already_approved, ADDON_APPROVE_MESSAGES_AR.not_ready].sort());
  }, 300_000);
});

describe("SCENARIO 3 (continued): approval next to TWO open requests, the end state the outage of scenario 5 leaves", () => {
  const two = () => [waiting(1), waiting(2)];
  it("DOCUMENTED UNRESOLVED RISK (MONEY): `approveAddonOnce` does NOT check «no other add-on is open»: with two open requests on one file, BOTH approvals succeed, TWO holds are reserved and TWO started add-ons run on the same file. The ledger of each job is sound; the one-open-per-file rule is broken", async () => {
    const [r1, r2] = two();
    let both = 0;
    await explore([approve(r1.id as string), approve(r2.id as string)], (out) => {
      const a = [res(out, 0), res(out, 1)] as Approved[];
      if (a.every((x) => x.ok)) both += 1;
      expect(openRows(out.rows).length, "two started rows: not repaired, not refusable").toBe(2);
      for (const x of a) expect(x.ok).toBe(true);
      expect(heldJobs(out)).toBe(2);
      ledgerSound(out);
    }, opts(TWO, { seed: [r1, r2] }));
    expect(both).toBeGreaterThan(0);
  }, 300_000);
  it("THE GUARD AN APPROVAL ROUTE MUST ADD (modelled here in the test, no production code): run `reconcileOpenAddons` BEFORE the claim and refuse unless this request is the one that stays. With it, AT MOST ONE of two approvals succeeds in every order, and the other request is cancelled unpaid", async () => {
    const [r1, r2] = two();
    const guarded = (id: string): Maker => async (a) => {
      const { keeper } = await reconcileOpenAddons(createSupabaseAddonRowStore(a.client, ME), MISSION);
      if (!keeper || keeper.id !== id) return { ok: false as const, refused: true };
      return approveAddonOnce(a.client, { id, actorId: ME, expectUserId: ME });
    };
    let oneWon = 0;
    const { runs } = await explore([guarded(r1.id as string), guarded(r2.id as string)], (out) => {
      const ok = [res(out, 0), res(out, 1)].filter((x) => x.ok);
      expect(ok.length).toBeLessThanOrEqual(1);
      expect(heldJobs(out)).toBe(ok.length);
      expect(openRows(out.rows).length).toBeLessThanOrEqual(1);
      if (ok.length === 1) { oneWon += 1; expect(openRows(out.rows).map((r) => r.id)).toEqual([[r1.id, r2.id].sort()[0]]); }
      ledgerSound(out);
    }, opts(TWO, { seed: [r1, r2] }));
    expect(runs).toBeGreaterThan(100);
    expect(oneWon).toBeGreaterThan(0);
  }, 300_000);
  it("the guard has a residual window of its own: a creator that inserts a SECOND request after the guard's read is still repaired by its own reconcile, and a started request outranks it (scenario 3 above), so the guard plus the creator protocol leaves one open request when every store call works", async () => {
    const r1 = waiting(1);
    const guarded = (id: string): Maker => async (a) => {
      const { keeper } = await reconcileOpenAddons(createSupabaseAddonRowStore(a.client, ME), MISSION);
      return keeper && keeper.id === id ? approveAddonOnce(a.client, { id, actorId: ME, expectUserId: ME }) : { ok: false as const };
    };
    await explore([guarded(r1.id as string), create(2)], (out) => { expect(openRows(out.rows).length).toBeLessThanOrEqual(1); ledgerSound(out); }, opts(TWO, { seed: [r1], stale: (i) => i.client === 1 && i.n === 2 }));
  }, 300_000);
});

describe("SCENARIO 7: repeated approval clicks", () => {
  it("two clicks at the same time, in every order: exactly ONE approval succeeds, ONE reserve, one set of money calls, and the other click is told the request is already approved; the balance moved by the hold once", async () => {
    const row = waiting(1);
    const { runs } = await explore([approve(row.id as string), approve(row.id as string)], (out) => {
      const results = [res(out, 0), res(out, 1)] as Approved[];
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const ok = results.find((r) => r.ok) as Extract<Approved, { ok: true }>;
      const no = results.find((r) => !r.ok) as Extract<Approved, { ok: false }>;
      expect(no.status).toBe(409);
      expect(no.error).toBe(ADDON_APPROVE_MESSAGES_AR.already_approved);
      expect(out.money.calls.map((c) => c.name)).toEqual(["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk"]);
      expect(heldJobs(out)).toBe(1);
      expect(out.money.balance()).toBe(START - ok.holdPoints);
      expect(out.rows.get(row.id as string)).toMatchObject({ status: "approved", job_id: ok.jobId });
      expect(out.world.events).toHaveLength(1);
      ledgerSound(out, ok.holdPoints);
    }, opts(ONE, { seed: [row] }));
    expect(runs, "the second click stops after one or two steps, so the complete set of orders is small").toBeGreaterThan(30);
  }, 600_000);
  it("five clicks at once, 300 seeded random orders: still exactly one approval and one reserve", async () => {
    const row = waiting(1);
    let seed = 20261104;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let k = 0; k < 300; k += 1) {
      const out = await runSchedule(Array.from({ length: 5 }, () => approve(row.id as string)), Array.from({ length: 80 }, rnd), opts(ONE, { seed: [row] }));
      const results = out.results.map((r) => { if (!r.ok) throw r.error; return r.value as Approved; });
      expect(results.filter((r) => r.ok), `run ${k}`).toHaveLength(1);
      expect(heldJobs(out)).toBe(1);
      ledgerSound(out);
    }
  }, 600_000);
  it("a click after the approval finished is refused with no money call at all", async () => {
    const row = waiting(1);
    const { value, out } = await solo(opts(ONE, { seed: [row] }), async (c) => { await approveAddonOnce(c, { id: row.id as string, actorId: ME, expectUserId: ME }); return approveAddonOnce(c, { id: row.id as string, actorId: ME, expectUserId: ME }); });
    expect(value).toMatchObject({ ok: false, status: 409, error: ADDON_APPROVE_MESSAGES_AR.already_approved });
    expect(out.money.calls.map((c) => c.name)).toEqual(["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk"]);
    expect(heldJobs(out)).toBe(1);
  });
  it("another customer's click on the request is refused as «not found» before anything is claimed", async () => {
    const row = waiting(1);
    const { value, out } = await solo(opts(ONE, { seed: [row] }), (c) => approveAddonOnce(c, { id: row.id as string, actorId: "u-2", expectUserId: "u-2" }));
    expect(value).toMatchObject({ ok: false, status: 404 });
    expect(out.money.calls).toEqual([]);
    expect(out.rows.get(row.id as string)!.status).toBe("plan_ready");
  });
});

describe("SCENARIO 6 and 8: a failed approval whose money state is unknown, and the retry after a partly completed reservation", () => {
  const FAULTS = [
    ["create_quote_atomic", "before", "nothing was committed"],
    ["create_quote_atomic", "after", "the quote exists, the answer was lost"],
    ["accept_quote_atomic", "before", "nothing was reserved"],
    ["accept_quote_atomic", "after", "the HOLD WAS RESERVED, the answer was lost"],
    ["claim_job_chunk", "before", "reserved, the job was not claimed"],
    ["claim_job_chunk", "after", "reserved and claimed, the answer was lost"],
  ] as const;
  for (const [fn, when, what] of FAULTS) {
    it(`${fn} fails ${when} (${what}): the row goes back to «waiting»; ONE retry converges on the same quote, job and ledger rows; the settlement then charges once, never above the hold; no second reserve at any point`, async () => {
      const row = waiting(1);
      const { value, out } = await solo(opts(ONE, { seed: [row], setup: (w) => w.money.inject(fn, when) }), async (c, w) => {
        const first = await approveAddonOnce(c, { id: row.id as string, actorId: ME, expectUserId: ME });
        const mid = { row: { ...w.rows.get(row.id as string)! }, reserves: w.money.ledger.filter((l) => l.type === "reserve").length, balance: w.money.balance() };
        const retry = await approveAddonOnce(c, { id: row.id as string, actorId: ME, expectUserId: ME });
        return { first, mid, retry };
      });
      expect(value.first).toMatchObject({ ok: false, status: 409 });
      expect(value.mid.row.status).toBe("plan_ready");
      expect(value.mid.row.approved_at, "the row says an approval was attempted").toBeTruthy();
      // what the first failure left in the ledger depends on where it failed: held (the answer lost after the reserve) or nothing
      const held = fn === "accept_quote_atomic" ? when === "after" : fn === "claim_job_chunk";
      expect(value.mid.reserves).toBe(held ? 1 : 0);
      expect(value.retry).toMatchObject({ ok: true });
      const ok = value.retry as Extract<Approved, { ok: true }>;
      expect(heldJobs(out), "exactly one reserve after the retry").toBe(1);
      expect(out.money.balance()).toBe(START - ok.holdPoints);
      expect(out.rows.get(row.id as string)).toMatchObject({ status: "approved", job_id: ok.jobId });
      // settle (the worker's step): the report was stored, so the review is charged its exact hold
      const settled = await settleAddon(out.world.money.client, { kind: "review", jobId: ok.jobId, holdPoints: ok.holdPoints, reportStored: true });
      expect(settled.chargePoints).toBe(ok.holdPoints);
      expect(checkAddonLedger(out.money, ok.jobId, { reserved: ok.holdPoints, charged: ok.holdPoints })).toEqual([]);
      expect(out.money.balance()).toBe(START - ok.holdPoints);
      ledgerSound(out, ok.holdPoints);
    });
  }
  it("a refused reserve writes NOTHING (insufficient balance): the balance never goes negative; the row goes back to «waiting» but is marked as approved-once, so the customer CANNOT cancel it though no money moved: DOCUMENTED UNRESOLVED RISK (UX only, no money)", async () => {
    const row = waiting(1);
    const { value, out } = await solo(opts(ONE, { seed: [row], balance: 5 }), async (c) => {
      const first = await approveAddonOnce(c, { id: row.id as string, actorId: ME, expectUserId: ME });
      const cancelled = await cancelReviewRequest(c, { missionId: MISSION, userId: ME, requestId: row.id as string });
      const seen = await currentReviewRequest(c, { missionId: MISSION, userId: ME });
      return { first, cancelled, seen };
    });
    expect(value.first).toMatchObject({ ok: false, status: 402, error: ADDON_APPROVE_MESSAGES_AR.insufficient_balance });
    expect(heldJobs(out)).toBe(0);
    expect(out.money.balance()).toBe(5);
    expect(value.cancelled, "cancel is refused for a row that was ever claimed").toMatchObject({ ok: false, status: 409, error: "changed" });
    expect(value.seen, "and the page no longer shows it as «nothing held»").toEqual({ ok: true, request: null });
    expect(openRows(out.rows)).toHaveLength(1);
    ledgerSound(out);
  });
  it("after the customer tops up, the retry of that same request succeeds and reserves once", async () => {
    const row = waiting(1);
    const { value, out } = await solo(opts(ONE, { seed: [row], balance: 5 }), async (c, w) => {
      await approveAddonOnce(c, { id: row.id as string, actorId: ME, expectUserId: ME });
      w.money.ledger.push({ id: "top_2", delta: 50_000, type: "topup" });
      return approveAddonOnce(c, { id: row.id as string, actorId: ME, expectUserId: ME });
    });
    expect(value).toMatchObject({ ok: true });
    expect(heldJobs(out)).toBe(1);
    ledgerSound(out);
  });
  it("an answer lost AFTER the reserve leaves the request «waiting» with the hold in the ledger and NO job id on the row; until the retry, the page does not show it, cancel is refused and a new request is blocked", async () => {
    const row = waiting(1);
    const { value, out } = await solo(opts(ONE, { seed: [row], setup: (w) => w.money.inject("accept_quote_atomic", "after") }), async (c) => {
      const first = await approveAddonOnce(c, { id: row.id as string, actorId: ME, expectUserId: ME });
      return { first, seen: await currentReviewRequest(c, { missionId: MISSION, userId: ME }), cancel: await cancelReviewRequest(c, { missionId: MISSION, userId: ME, requestId: row.id as string }), again: await createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }) };
    });
    expect(value.first).toMatchObject({ ok: false });
    expect(value.seen).toEqual({ ok: true, request: null });
    expect(value.cancel).toMatchObject({ ok: false, error: "changed" });
    expect(value.again).toMatchObject({ ok: false, error: "open_addon" });
    expect(out.rows.get(row.id as string)!.job_id ?? null).toBeNull();
    expect(heldJobs(out)).toBe(1);
  });
  it("DOCUMENTED UNRESOLVED RISK (UX, no money loss): if the retry never comes, the watchdog releases the abandoned job (rel_ +hold, no charge: the ledger nets to zero); but the REQUEST stays «waiting» with an approval mark, so it can be neither cancelled nor approved again (the quote is accepted, its job failed: «claim_retry» for ever) and it blocks every new request on the file. A recovery rule is needed in the approval wiring (owner decision)", async () => {
    const row = waiting(1);
    const { value, out } = await solo(opts(ONE, { seed: [row], setup: (w) => w.money.inject("accept_quote_atomic", "after") }), async (c, w) => {
      await approveAddonOnce(c, { id: row.id as string, actorId: ME, expectUserId: ME });
      const jobId = [...w.money.jobs.keys()][0];
      // what the watchdog does to a job nobody claimed: release_job_atomic with force (src/app/api/cron/watchdog/route.ts)
      const released = await w.money.client.rpc("release_job_atomic", { p_job_id: jobId, p_error_message: "x", p_force: true });
      const again = await approveAddonOnce(c, { id: row.id as string, actorId: ME, expectUserId: ME });
      return { jobId, released, again, cancel: await cancelReviewRequest(c, { missionId: MISSION, userId: ME, requestId: row.id as string }), blocked: await createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }) };
    });
    expect(value.released.data).toMatchObject({ success: true });
    expect(checkAddonLedger(out.money, value.jobId, { reserved: -out.money.ledger.find((l) => l.id === `res_${value.jobId}`)!.delta, charged: "none" })).toEqual([]);
    expect(out.money.balance(), "the customer got everything back").toBe(START);
    expect(value.again).toMatchObject({ ok: false, status: 409, error: ADDON_APPROVE_MESSAGES_AR.claim_retry });
    expect(value.cancel).toMatchObject({ ok: false, error: "changed" });
    expect(value.blocked).toMatchObject({ ok: false, error: "open_addon" });
    expect(out.rows.get(row.id as string)).toMatchObject({ status: "plan_ready" });
    expect(openRows(out.rows)).toHaveLength(1);
  });
  it("DOCUMENTED UNRESOLVED RISK (MONEY HELD, bounded): `approveAddonOnce` does not look at the error of its LAST update (the one that records the job on the row). If that update fails after the hold, the customer is told «approved», the row is `approved` with NO job id, and the worker ends it «failed» without releasing: the hold stays until the watchdog's lease rule frees it (the job lease is 6 hours, the watchdog waits 30 minutes more)", async () => {
    const row = waiting(1);
    const { value, out } = await solo(opts(ONE, { seed: [row], fault: (i) => i.op === "update" && i.n === 2 }), (c) => approveAddonOnce(c, { id: row.id as string, actorId: ME, expectUserId: ME }));
    expect(value).toMatchObject({ ok: true });
    expect(out.rows.get(row.id as string)).toMatchObject({ status: "approved" });
    expect(out.rows.get(row.id as string)!.job_id ?? null, "no job id was recorded").toBeNull();
    expect(heldJobs(out), "yet the hold is in the ledger").toBe(1);
    const job = [...out.money.jobs.values()][0];
    expect(job.lease_until! - Date.now(), "the job lease is about six hours").toBeGreaterThan(5.9 * 3600_000);
    ledgerSound(out);
  });
  it("a quote that expired before the retry ENDS the request with no money moved: the row is cancelled (error quote_expired), the ledger is untouched, and the customer can ask again and gets the NEXT attempt number (a new id)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T10:00:00Z"));
    const row = waiting(1);
    const { value, out } = await solo(opts(ONE, { seed: [row], balance: 5 }), async (c, w) => {
      const first = await approveAddonOnce(c, { id: row.id as string, actorId: ME, expectUserId: ME });
      w.money.ledger.push({ id: "top_2", delta: 50_000, type: "topup" });
      vi.setSystemTime(new Date("2026-11-04T10:31:00Z"));
      const retry = await approveAddonOnce(c, { id: row.id as string, actorId: ME, expectUserId: ME, now: new Date() });
      const next = await createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 });
      return { first, retry, next };
    });
    expect(value.first).toMatchObject({ ok: false, status: 402 });
    expect(value.retry).toMatchObject({ ok: false, status: 409, error: ADDON_APPROVE_MESSAGES_AR.quote_expired });
    expect(out.rows.get(row.id as string)).toMatchObject({ status: "cancelled", error: "quote_expired" });
    expect(heldJobs(out)).toBe(0);
    expect(out.money.balance()).toBe(5 + 50_000);
    expect(value.next).toMatchObject({ ok: true, created: true });
    expect(out.rows.get(addonId(MISSION, 1, 2))).toBeTruthy();
    ledgerSound(out);
  });
  it("a worker's settlement retried after a lost answer charges ONCE: `settleAddon` twice leaves one rel_ and one chg_", async () => {
    const row = waiting(1);
    const { value, out } = await solo(opts(ONE, { seed: [row] }), async (c, w) => {
      const a = await approveAddonOnce(c, { id: row.id as string, actorId: ME, expectUserId: ME });
      if (!a.ok) throw new Error("approval refused");
      w.money.inject("settle_job_atomic", "after");
      let first: unknown = null;
      try { await settleAddon(w.money.client, { kind: "review", jobId: a.jobId, holdPoints: a.holdPoints, reportStored: true }); } catch (e) { first = e; }
      const second = await settleAddon(w.money.client, { kind: "review", jobId: a.jobId, holdPoints: a.holdPoints, reportStored: true });
      return { a, first, second };
    });
    expect(value.first, "the first answer was lost").toBeTruthy();
    expect(value.second.chargePoints).toBe(value.a.holdPoints);
    expect(checkAddonLedger(out.money, value.a.jobId, { reserved: value.a.holdPoints, charged: value.a.holdPoints })).toEqual([]);
    ledgerSound(out);
  });
});

describe("SCENARIO 9: a cancellation racing an approval", () => {
  it("in every order EITHER the request is cancelled and NO money moved, OR it is approved with ONE reserve and the cancel is refused; never «cancelled» with money held, never approved after a cancel", async () => {
    const row = waiting(1);
    let cancelled = 0; let approved = 0;
    const { runs } = await explore([approve(row.id as string), cancel(row.id as string)], (out) => {
      const a = res(out, 0) as Approved;
      const c = res(out, 1) as { ok: boolean; status?: number; error?: string };
      const r = out.rows.get(row.id as string)!;
      if (r.status === "cancelled") {
        cancelled += 1;
        expect(c.ok).toBe(true);
        expect(a.ok).toBe(false);
        expect(heldJobs(out), "cancelled means nothing is held").toBe(0);
        expect(out.money.balance()).toBe(START);
        expect(out.money.calls).toEqual([]);
      } else {
        approved += 1;
        expect(r.status).toBe("approved");
        expect(a.ok).toBe(true);
        expect(c).toMatchObject({ ok: false, status: 409, error: "changed" });
        expect(heldJobs(out)).toBe(1);
      }
      ledgerSound(out);
    }, opts(ONE, { seed: [row] }));
    expect(runs).toBeGreaterThan(5);
    expect(cancelled).toBeGreaterThan(0);
    expect(approved).toBeGreaterThan(0);
  }, 300_000);
  it("the same when the approval is going to FAIL at the reserve: the claim sets the approval mark first, so the cancel can never win after the claim; either the cancel won before it (nothing held) or the row is back to «waiting» with the mark (nothing held, cancel refused)", async () => {
    const row = waiting(1);
    const endings = new Set<string>();
    await explore([approve(row.id as string), cancel(row.id as string)], (out) => {
      const r = out.rows.get(row.id as string)!;
      endings.add(`${r.status}/${r.approved_at ? "marked" : "unmarked"}`);
      expect(heldJobs(out)).toBe(0);
      expect(out.money.balance()).toBe(START);
      if (r.status === "cancelled") expect(r.approved_at ?? null, "a cancel never lands on a claimed row").toBeNull();
      ledgerSound(out);
    }, opts(ONE, { seed: [row], setup: (w) => w.money.inject("accept_quote_atomic", "before") }));
    expect([...endings].sort()).toEqual(["cancelled/unmarked", "plan_ready/marked"]);
  }, 300_000);
  it("a cancel that arrives while the money functions are running (the row is already `approved`) is refused and changes nothing", async () => {
    const row = waiting(1);
    await explore([approve(row.id as string), cancel(row.id as string)], (out) => {
      const r = out.rows.get(row.id as string)!;
      if (r.status !== "cancelled") expect((res(out, 1) as { error?: string }).error).toBe("changed");
    }, opts(ONE, { seed: [row] }));
  }, 300_000);
  it("DOCUMENTED UNRESOLVED RISK (UX only): a creator whose id collides with a request the customer just CANCELLED (a stale read before the cancel) is told «you have an open request» though none is open; asking again makes the next attempt and succeeds", async () => {
    const cancelledRow = waiting(1, { status: "cancelled" });
    // the creator's list read is stale: it still believes nothing exists, so it computes attempt 1 again, the id of the cancelled row
    const { value, out } = await solo(opts(ONE, { seed: [cancelledRow], stale: (i) => i.n === 2 && i.op === "select" }), async (c) => {
      const first = await createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 });
      return { first };
    });
    expect(value.first).toMatchObject({ ok: false, status: 409, error: "open_addon" });
    expect(openRows(out.rows)).toEqual([]);
    const again = await solo(opts(ONE, { seed: [cancelledRow] }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(again.value).toMatchObject({ ok: true, created: true });
    expect(addonRows(again.out.rows)).toHaveLength(2);
  });
});
