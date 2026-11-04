import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ADDON_RELEASED_ERROR, addonJobId, addonQuoteId } from "../src/lib/agentMission/addonSettlement";
import { ADDON_CREATE_REFUSALS_AR, type AddonRowLike } from "../src/lib/agentMission/stage4/addonRow";
import { guardApproval } from "../src/lib/agentMission/stage4/approvalGuard";
import { paidReviewVerdict } from "../src/lib/agentMission/stage4/paidReview";
import { createEditRequest, parseEditInput } from "../src/lib/agentMission/stage4/editRequest";
import { createReviewRequest, currentReviewRequest } from "../src/lib/agentMission/stage4/reviewRequest";
import { reviewQuoteFor } from "../src/lib/agentMission/stage4/reviewPreview";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { reviewPathOf } from "../agent/src/stage4/addonFiles";
import type { FileVersion } from "../src/lib/agentMission/stage4/versions";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { explore, openRows, solo, type Maker, type Row, type SchedOpts, type World } from "./helpers/scheduledWorld";
import { addonRowOf, objectsOf, sizedVersion } from "./helpers/reviewQuoteWorld";

/**
 * SAFETY FIX B (docs/STAGE-4-FINANCIAL-SAFETY.md): NO SECOND PAID REVIEW OF A VERSION WHOSE FIRST REVIEW WAS CHARGED AND NOT PUBLISHED. A review that is charged and cannot publish its report ends `failed` (`charged_not_published`). `failed` does not block, and the creation rules looked at the
 * STATUS only («a completed review is reused»), so the customer was offered, and could approve, a SECOND paid review of the same version. These tests run the REAL creation, preview and approval guard over the scheduled world (a stateful missions table, the hardened money fake behind
 * the read-only `jobs` and `credit_ledger`, a bucket of stored objects). The earlier review is judged by the AUTHORITATIVE state of its job and ledger rows and by what is in storage, never by customer-facing text. FAKE CLIENTS ONLY: no real money, provider or database.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const MISSION = "msn_5851abc92a1e6645a9cd";
const ME = "u-1";
const START = 100_000;
const MISSION_ROW = { id: MISSION, user_id: ME, status: "completed", plan: { stages: [] }, delivered_units: 60 };
let ONE: Record<string, string>; let TWO: Record<string, string>; let v1: FileVersion; let v2: FileVersion;
beforeAll(() => {
  v1 = sizedVersion(6, 3);
  const r = applyEditRequest(v1, { kind: "rename_column", sheet: "الورقة", from: "عمود 3", to: "عمود ثالث" }, { createdAt: "2026-11-03T09:30:00.000Z" });
  if (!r.ok) throw new Error(r.reason);
  v2 = r.version; ONE = objectsOf(v1); TWO = objectsOf(v1, v2);
});
const opts = (objects: Record<string, string>, more: Partial<SchedOpts> = {}): SchedOpts => ({ objects, balance: START, ...more, seed: [MISSION_ROW, ...(more.seed ?? [])] });

/** The earlier review's row: `failed`, with what the worker writes when the file was charged and could not be shown. */
const failedReview = (base: number, over: Record<string, unknown> = {}): Row => {
  const r = addonRowOf({ status: "failed", kind: "review", base });
  return { ...r, request_text: "طلب مراجعة", approved_at: "2026-11-03T09:00:00.000Z", error: "charged_not_published", charged_points: 100, delivered_units: 0, reserved_points: 100, job_id: addonJobId(addonQuoteId(r.id)), quote_id: addonQuoteId(r.id), ...over };
};
/** The money state of that review's job, written straight into the money fake (the ledger rows the real functions would have written). */
type JobKind = "charged" | "released" | "active" | "settled_free" | "none";
const money = (row: Row, kind: JobKind, hold = 100) => (w: World): void => {
  if (kind === "none") return;
  const jobId = addonJobId(addonQuoteId(row.id as string));
  const status = kind === "active" ? "running" : kind === "released" ? "failed" : "completed";
  const charged = kind === "charged" ? hold : 0;
  w.money.jobs.set(jobId, { id: jobId, user_id: ME, status, reserved_credits: hold, charged_credits: charged, unit_price: 1, delivered_units: charged, target_volume_max: hold, step: 1, lease_until: null, result_file_id: null, accumulated_cost_usd: 0, current_cursor: kind === "active" ? null : "completed", endpoint_id: "agent-review", target_volume_min: 1, error_message: null });
  w.money.ledger.push({ id: `res_${jobId}`, delta: -hold, type: "reserve", job_id: jobId, user_id: ME });
  if (kind !== "active") w.money.ledger.push({ id: `rel_${jobId}`, delta: hold, type: "release", job_id: jobId, user_id: ME });
  if (kind === "charged") w.money.ledger.push({ id: `chg_${jobId}`, delta: -charged, type: "charge", job_id: jobId, user_id: ME });
};
const review = (version: number): Maker => async (a) => createReviewRequest(a.client, { missionId: MISSION, userId: ME, version });
const noNewMoney = (out: { money: { calls: unknown[]; ledger: Array<{ type: string }> }; world: World }, before: number) => {
  expect(out.money.calls, "no money function was called").toEqual([]);
  expect(out.money.ledger.filter((l) => l.type === "reserve").length, "no new reservation").toBe(before);
  expect(out.world.other).toEqual([]);
};
const rowsOf = (out: { rows: Map<string, Row> }) => [...out.rows.values()].filter((r) => r.plan?.addon);

describe("FIX B: the exact scenario: a review was CHARGED, its report was NOT published, the request ended `failed`", () => {
  it("a second review of the SAME version is refused, no row is made, and nothing is reserved: the customer is not offered a second paid review", async () => {
    const first = failedReview(1);
    const { value, out } = await solo(opts(ONE, { seed: [first], setup: money(first, "charged") }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(value).toMatchObject({ ok: false, status: 409, error: "review_unresolved" });
    expect(rowsOf(out)).toHaveLength(1);
    expect(out.rows.get(first.id as string)).toEqual(JSON.parse(JSON.stringify(first)));
    noNewMoney(out, 1);
  });
  it("the first review's stored EVIDENCE is untouched: its row, its job, its three ledger rows and the customer's balance (charged once)", async () => {
    const first = failedReview(1);
    const { out } = await solo(opts(ONE, { seed: [first], setup: money(first, "charged") }), async (c) => { await createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }); await reviewQuoteFor(c, { missionId: MISSION, userId: ME, version: 1 }); await currentReviewRequest(c, { missionId: MISSION, userId: ME }); });
    expect(out.rows.get(first.id as string)).toMatchObject({ status: "failed", error: "charged_not_published", charged_points: 100 });
    expect(out.money.ledger.map((l) => l.type).sort()).toEqual(["charge", "release", "reserve", "topup"]);
    expect(out.money.balance()).toBe(START - 100);
  });
  it("the PREVIEW does not offer a price: it says the earlier review is unresolved, in an Arabic sentence that never says nothing was charged", async () => {
    const first = failedReview(1);
    const { value } = await solo(opts(ONE, { seed: [first], setup: money(first, "charged") }), (c) => reviewQuoteFor(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(value).toMatchObject({ ok: true, quote: { state: "unresolved", version: 1 } });
    expect(JSON.stringify(value)).not.toMatch(/points|cells/);
    const s = ADDON_CREATE_REFUSALS_AR.review_unresolved;
    expect(checkCustomerText(s).issues).toEqual([]);
    expect(s).toMatch(/خصم/);
    expect(s).not.toMatch(/لم يُخصم|لم يُحجز|استرداد|سنرد|ردّ/);
  });
  it("the judgement uses the MONEY STATE, not the row's words: a failed review whose row says charged_points 0 but whose job is CHARGED still blocks", async () => {
    const first = failedReview(1, { error: null, charged_points: 0 });
    const { value } = await solo(opts(ONE, { seed: [first], setup: money(first, "charged") }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(value).toMatchObject({ ok: false, error: "review_unresolved" });
  });
  it("…and a row with NO recorded charge (charged_points null: the worker could not tell) whose job is charged blocks too", async () => {
    const first = failedReview(1, { charged_points: null, job_id: null, quote_id: null });
    const { value } = await solo(opts(ONE, { seed: [first], setup: money(first, "charged") }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(value).toMatchObject({ ok: false, error: "review_unresolved" });
  });
  it("a job that still HOLDS the points (running) under a failed row, or a state that cannot be read, blocks: it is never read as free", async () => {
    const held = failedReview(1, { error: "the add-on has no plan or no hold", charged_points: null });
    const a = await solo(opts(ONE, { seed: [held], setup: money(held, "active") }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(a.value).toMatchObject({ ok: false, error: "review_unresolved" });
    const odd = failedReview(1, { charged_points: null });
    const b = await solo(opts(ONE, { seed: [odd], setup: (w) => { money(odd, "charged")(w); w.money.ledger.splice(w.money.ledger.findIndex((l) => l.type === "release"), 1); } }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(b.value).toMatchObject({ ok: false, error: "review_unresolved" });
  });
});

describe("FIX B: what stays allowed", () => {
  it("a failed review with NO charge (the hold was released: job failed with its release row) does not block: a new review is made, with the next attempt number", async () => {
    const first = failedReview(1, { error: ADDON_RELEASED_ERROR, charged_points: 0 });
    const { value, out } = await solo(opts(ONE, { seed: [first], setup: money(first, "released") }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(value).toMatchObject({ ok: true, created: true });
    expect(rowsOf(out)).toHaveLength(2);
  });
  it("a failed review that never had a job (nothing was ever reserved) does not block", async () => {
    const first = failedReview(1, { error: null, charged_points: null, job_id: null, quote_id: null, approved_at: null });
    const { value } = await solo(opts(ONE, { seed: [first], setup: money(first, "none") }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(value).toMatchObject({ ok: true, created: true });
  });
  it("a settled job with no charge (a whole release) does not block", async () => {
    const first = failedReview(1, { error: null, charged_points: 0 });
    const { value } = await solo(opts(ONE, { seed: [first], setup: money(first, "settled_free") }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(value).toMatchObject({ ok: true, created: true });
  });
  it("a DIFFERENT published version is reviewed normally even when version 1's review is charged and unpublished", async () => {
    const first = failedReview(1);
    const { value, out } = await solo(opts(TWO, { seed: [first], setup: money(first, "charged") }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 2 }));
    expect(value).toMatchObject({ ok: true, created: true });
    expect(openRows(out.rows)).toHaveLength(1);
  });
  it("a COMPLETED review of the version is still reused for free (the existing rule)", async () => {
    const done = { ...addonRowOf({ status: "completed", kind: "review", base: 1 }), charged_points: 100, job_id: "job_x", approved_at: "2026-11-03T09:00:00.000Z" };
    const { value } = await solo(opts(ONE, { seed: [done] }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(value).toMatchObject({ ok: false, error: "review_exists" });
  });
  it("an edit of the version is not blocked by its unresolved review (it makes a new version; only a second paid REVIEW of this version is refused)", async () => {
    const first = failedReview(1);
    const { value } = await solo(opts(ONE, { seed: [first], setup: money(first, "charged") }), (c) => createEditRequest(c, { missionId: MISSION, userId: ME, version: 1, edit: parseEditInput({ kind: "rename_column", sheet: "الورقة", from: "عمود 1", to: "اسم جديد" }) as any }));
    expect(value).toMatchObject({ ok: true, created: true });
  });
});

describe("FIX B: the PUBLISHED report decides: it is shown free, the second review is never needed", () => {
  it("the first review was charged and the report IS in storage (an administrator published it, or the retry did): the second review is refused as «reviewed already, free», not as unresolved", async () => {
    const first = failedReview(1);
    const objects = { ...ONE, [`${MISSION}/${reviewPathOf(1)}`]: JSON.stringify({ addonId: first.id }) };
    const { value } = await solo(opts(objects, { seed: [first], setup: money(first, "charged") }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(value).toMatchObject({ ok: false, error: "review_exists" });
    const q = await solo(opts(objects, { seed: [first], setup: money(first, "charged") }), (c) => reviewQuoteFor(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(q.value).toMatchObject({ ok: true, quote: { state: "reuse" } });
  });
  it("storage DOWN while the earlier charged review is judged: the creation FAILS (503), it never decides on a guess; once storage is back the same call is refused as unresolved, and nothing was ever made", async () => {
    const first = failedReview(1);
    const failing = (c: any) => ({ ...c, storage: { from: (b: string) => { const f = c.storage.from(b); return new Proxy(f, { get: (t, k) => (k === "list" ? async (p: string, ...r: unknown[]) => (String(p).endsWith("/reviews") ? { data: null, error: { message: "storage is down" } } : t.list(p, ...r)) : t[k]) }); } } });
    const down = await solo(opts(ONE, { seed: [first], setup: money(first, "charged") }), (c) => createReviewRequest(failing(c), { missionId: MISSION, userId: ME, version: 1 }));
    expect(down.value).toMatchObject({ ok: false, status: 503, error: "unavailable" });
    expect(rowsOf(down.out)).toHaveLength(1);
    const back = await solo(opts(ONE, { seed: [first], setup: money(first, "charged") }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(back.value).toMatchObject({ ok: false, error: "review_unresolved" });
  });
  it("a DATABASE error while the earlier review's money state is read blocks as «unverified» (503 is also acceptable: what is never allowed is a created row)", async () => {
    const first = failedReview(1);
    const { value, out } = await solo(opts(ONE, { seed: [first], setup: (w) => { money(first, "charged")(w); w.money.jobs.clear(); } }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(value.ok).toBe(false);
    expect(rowsOf(out)).toHaveLength(1);
  });
});

describe("FIX B: concurrent creation and repeated approval", () => {
  it("two creators of the same version at the same moment, every order: NO row is ever made while the earlier review is charged and unresolved", async () => {
    const first = failedReview(1);
    const { runs } = await explore([review(1), review(1)], (out) => {
      for (const i of [0, 1]) { const r = out.results[i]; expect(r.ok && (r.value as any).ok === false && (r.value as any).error === "review_unresolved").toBe(true); }
      expect(rowsOf(out)).toHaveLength(1);
      expect(out.money.calls).toEqual([]);
    }, opts(ONE, { seed: [first], setup: money(first, "charged") }));
    expect(runs).toBeGreaterThan(1);
  });
  it("a review of version 1 and a review of version 2 at the same moment: version 1 is refused in every order and at most one request is open at the end", async () => {
    const first = failedReview(1);
    await explore([review(1), review(2)], (out) => {
      const a = out.results[0];
      expect(a.ok && (a.value as any).ok, "version 1 is never created").toBe(false);
      expect(["review_unresolved", "open_addon"], "refused as unresolved, or as «another request is open» when the version 2 request got in first").toContain(a.ok ? (a.value as any).error : "threw");
      expect(rowsOf(out).filter((r) => r.plan.addon.baseVersion === 1 && r.status === "plan_ready")).toEqual([]);
      expect(openRows(out.rows).length).toBeLessThanOrEqual(1);
      expect(openRows(out.rows).every((r) => r.plan.addon.baseVersion === 2)).toBe(true);
    }, opts(TWO, { seed: [first], setup: money(first, "charged") }));
  });
  it("THE APPROVAL GUARD: a second review request of the same version that already exists (made while the first was open, in an outage) is REFUSED at approval; nothing is reserved; asking again is refused again", async () => {
    const first = failedReview(1);
    const second = { ...addonRowOf({ status: "plan_ready", kind: "review", base: 1, attempt: 2 }), request_text: "طلب مراجعة", job_id: null, approved_at: null };
    const { value, out } = await solo(opts(ONE, { seed: [first, second], setup: money(first, "charged") }), async (c) => ({ once: await guardApproval(c, { id: second.id, userId: ME }), again: await guardApproval(c, { id: second.id, userId: ME }) }));
    expect(value.once).toMatchObject({ ok: false, status: 409, reason: "review_unresolved" });
    expect(value.again).toEqual(value.once);
    noNewMoney(out, 1);
    expect(out.rows.get(second.id as string)!.status, "the guard does not end the request: that is the customer's or an administrator's decision").toBe("plan_ready");
  });
  it("THE APPROVAL GUARD lets a clean request through, refuses another customer's, a missing one, a started one, and a request next to another open one", async () => {
    const row = { ...addonRowOf({ status: "plan_ready", kind: "review", base: 1 }), request_text: "طلب مراجعة", job_id: null, approved_at: null };
    const ok = await solo(opts(ONE, { seed: [row] }), (c) => guardApproval(c, { id: row.id, userId: ME }));
    expect(ok.value).toEqual({ ok: true });
    expect((await solo(opts(ONE, { seed: [row] }), (c) => guardApproval(c, { id: row.id, userId: "u-2" }))).value).toMatchObject({ ok: false, reason: "not_found" });
    expect((await solo(opts(ONE, { seed: [row] }), (c) => guardApproval(c, { id: "msn_nope", userId: ME }))).value).toMatchObject({ ok: false, reason: "not_found" });
    expect((await solo(opts(ONE, { seed: [{ ...row, status: "executing" }] }), (c) => guardApproval(c, { id: row.id, userId: ME }))).value).toMatchObject({ ok: false, reason: "not_ready" });
    const other = { ...addonRowOf({ status: "plan_ready", kind: "review", base: 2 }), request_text: "طلب مراجعة", job_id: null, approved_at: null };
    const both = await solo(opts(TWO, { seed: [row, other] }), (c) => Promise.all([guardApproval(c, { id: row.id, userId: ME }), guardApproval(c, { id: other.id, userId: ME })]));
    expect(both.value.filter((r) => r.ok)).toHaveLength(1);
  });
  it("THE APPROVAL GUARD refuses a request whose earlier review of the same version was completed (free reuse) and one whose report is already published", async () => {
    const done = { ...addonRowOf({ status: "completed", kind: "review", base: 1 }), job_id: "job_x", approved_at: "2026-11-03T09:00:00.000Z" };
    const second = { ...addonRowOf({ status: "plan_ready", kind: "review", base: 1, attempt: 2 }), request_text: "طلب مراجعة", job_id: null, approved_at: null };
    const a = await solo(opts(ONE, { seed: [done, second] }), (c) => guardApproval(c, { id: second.id, userId: ME }));
    expect(a.value).toMatchObject({ ok: false, reason: "review_exists" });
    const published = { ...ONE, [`${MISSION}/${reviewPathOf(1)}`]: JSON.stringify({}) };
    const row = { ...addonRowOf({ status: "plan_ready", kind: "review", base: 1 }), request_text: "طلب مراجعة", job_id: null, approved_at: null };
    const b = await solo(opts(published, { seed: [row] }), (c) => guardApproval(c, { id: row.id, userId: ME }));
    expect(b.value).toMatchObject({ ok: false, reason: "review_exists" });
  });
});

describe("FIX B: the verdict function itself", () => {
  const rows = (...r: Row[]): AddonRowLike[] => r as unknown as AddonRowLike[];
  it("no earlier failed or unserved review of the version: clear, and NOTHING is read (no storage, no money table)", async () => {
    const client = { from: () => { throw new Error("must not read"); }, storage: { from: () => { throw new Error("must not read"); } } };
    expect(await paidReviewVerdict(client, { missionId: MISSION, baseVersion: 1, rows: rows(addonRowOf({ status: "cancelled", kind: "review", base: 1 }) as Row, addonRowOf({ status: "failed", kind: "edit", base: 1 }) as Row, addonRowOf({ status: "failed", kind: "review", base: 2 }) as Row) })).toEqual({ kind: "clear" });
  });
});

describe("FIX B: the approval guard next to a STARTED request", () => {
  it("a waiting request next to a started one is refused («another request is open»); the repair cancels the waiting one unpaid; nothing is reserved", async () => {
    const started = { ...addonRowOf({ status: "approved", kind: "review", base: 1 }), request_text: "طلب", job_id: "job_started", approved_at: "2026-11-03T09:00:00.000Z" };
    const waiting = { ...addonRowOf({ status: "plan_ready", kind: "review", base: 2 }), request_text: "طلب", job_id: null, approved_at: null };
    const { value, out } = await solo(opts(TWO, { seed: [started, waiting] }), (c) => guardApproval(c, { id: waiting.id, userId: ME }));
    expect(value).toMatchObject({ ok: false, status: 409, reason: "open_addon" });
    expect(out.rows.get(started.id as string)!.status).toBe("approved");
    expect(out.rows.get(waiting.id as string)!.status).toBe("cancelled");
    noNewMoney(out, 0);
  });
});
