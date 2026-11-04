import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ADDON_APPROVE_MESSAGES_AR, addonId, approveAddonOnce } from "../src/lib/agentMission/addonSettlement";
import { guardApproval } from "../src/lib/agentMission/stage4/approvalGuard";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { createEditRequest, parseEditInput } from "../src/lib/agentMission/stage4/editRequest";
import { fileWorkflowFor } from "../src/lib/agentMission/stage4/fileWorkflow";
import { createReviewRequest } from "../src/lib/agentMission/stage4/reviewRequest";
import type { FileVersion } from "../src/lib/agentMission/stage4/versions";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { addonRowOf as moneyRowOf } from "./helpers/addonWorld";
import { solo, type Out, type Row, type SchedOpts, type World } from "./helpers/scheduledWorld";
import { addonRowOf, objectsOf, sizedVersion } from "./helpers/reviewQuoteWorld";

/**
 * SAFETY ROUND, SECTION 6 OF THE BRIEF: THE APPROVAL CONTRACT, checked with the REAL functions and NO route. The planned approval route (docs/STAGE-4-APPROVAL-BOUNDARY.md; BLOCKED FOR OWNER APPROVAL, not built) must authenticate the customer, verify ownership, verify the selected
 * PUBLISHED version, recalculate the price on the server, match the price the customer approved, check that no other add-on is active, reconcile competing requests, refuse an unresolved paid review, use the existing money functions, survive double clicks and lost answers, and never
 * reserve before the explicit approval. `reference()` below is the composition such a route would run (guard, then the approval function): it lives in this TEST FILE ONLY, no production file calls both, and every assertion runs on the hardened money fake. NO real money, provider, database or flag.
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
const waiting = (base: number, over: Record<string, unknown> = {}): Row => ({ ...addonRowOf({ status: "plan_ready", kind: "review", base }), request_text: "طلب مراجعة", job_id: null, approved_at: null, ...over });

/** What the planned route would run, in this test only: the guard first (everything that needs no money), then the approval function. */
const reference = async (c: any, input: { id: string; userId?: string; expectedPoints?: number }) => {
  const guard = await guardApproval(c, { id: input.id, userId: input.userId ?? ME, ...(input.expectedPoints !== undefined ? { expectedPoints: input.expectedPoints } : {}) });
  if (!guard.ok) return { refused: guard } as const;
  return { approved: await approveAddonOnce(c, { id: input.id, actorId: input.userId ?? ME, expectUserId: input.userId ?? ME }) } as const;
};
const reservesOf = (out: Out) => out.money.ledger.filter((l) => l.type === "reserve");
const noMoney = (out: Out) => { expect(out.money.calls, "no money function was called").toEqual([]); expect(reservesOf(out)).toEqual([]); expect(out.money.balance()).toBe(START); expect(out.world.other).toEqual([]); };
const holdOf = (r: Row): number => r.plan.addon.pricing.holdPoints;
const chargedFirst = (row: Row) => (w: World): void => {
  const jobId = `job_quote_${require("node:crypto").createHash("md5").update(`quote_addon_${row.id}`).digest("hex")}`;
  w.money.jobs.set(jobId, { id: jobId, user_id: ME, status: "completed", reserved_credits: 100, charged_credits: 100, unit_price: 1, delivered_units: 100, target_volume_max: 100, step: 1, lease_until: null, result_file_id: null, accumulated_cost_usd: 0, current_cursor: "completed", endpoint_id: "agent-review", target_volume_min: 1, error_message: null });
  w.money.ledger.push({ id: `res_${jobId}`, delta: -100, type: "reserve", job_id: jobId, user_id: ME }, { id: `rel_${jobId}`, delta: 100, type: "release", job_id: jobId, user_id: ME }, { id: `chg_${jobId}`, delta: -100, type: "charge", job_id: jobId, user_id: ME });
};

describe("1-3 authentication, ownership, the selected PUBLISHED version", () => {
  it("another customer's request, an unknown id and a row that is not an add-on are refused as «not found» (one answer), with no money function called", async () => {
    const row = waiting(1);
    const ordinary = { id: "msn_ordinary00000001", user_id: ME, status: "plan_ready", plan: { stages: [] } };
    for (const [id, userId] of [[row.id, "u-2"], ["msn_nope00000000000001", ME], [ordinary.id, ME]] as const) {
      const { value, out } = await solo(opts(ONE, { seed: [row, ordinary as Row] }), (c) => reference(c, { id: id as string, userId }));
      expect(value).toMatchObject({ refused: { ok: false, status: 404, reason: "not_found" } });
      noMoney(out);
    }
  });
  it("a request whose base version is NOT published in storage (gone, or never there) is refused as «the version changed»: nothing is reserved against a file that cannot be read", async () => {
    const row = waiting(1);
    const { value, out } = await solo(opts({}, { seed: [row] }), (c) => reference(c, { id: row.id as string }));
    expect(value).toMatchObject({ refused: { ok: false, reason: "version_changed" } });
    noMoney(out);
  });
  it("an EDIT whose base version is no longer the latest is refused as «the version changed» (an edit goes on the latest version only)", async () => {
    const edit = { ...addonRowOf({ status: "plan_ready", kind: "edit", base: 1 }), request_text: "تعديل", job_id: null, approved_at: null };
    const { value, out } = await solo(opts(TWO, { seed: [edit] }), (c) => reference(c, { id: edit.id as string }));
    expect(value).toMatchObject({ refused: { ok: false, reason: "version_changed" } });
    noMoney(out);
  });
  it("a REVIEW whose stored cell count is not what the stored file holds is refused: the price is recalculated from the published version on the server", async () => {
    const bigger = { ...moneyRowOf({ of: MISSION, baseVersion: 1, kind: "review", userId: ME }), request_text: "طلب", job_id: null, approved_at: null } as Row; // priced for 2,500 cells, the file has 18
    const { value, out } = await solo(opts(ONE, { seed: [bigger] }), (c) => reference(c, { id: bigger.id as string }));
    expect(value).toMatchObject({ refused: { ok: false, reason: "version_changed" } });
    noMoney(out);
  });
});

describe("4-5 the price is recalculated on the server and must match what the customer approved", () => {
  it("a request made by the real creation code, approved with the points the page showed: the hold reserved IS that price, once", async () => {
    const { value, out } = await solo(opts(ONE), async (c) => {
      const made = await createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 });
      if (!made.ok) throw new Error(made.error);
      return { shown: made.request.points, answer: await reference(c, { id: made.request.id, expectedPoints: made.request.points }) };
    });
    expect(value.answer).toMatchObject({ approved: { ok: true, holdPoints: value.shown } });
    expect(reservesOf(out)).toHaveLength(1);
    expect(reservesOf(out)[0].delta).toBe(-value.shown);
    expect(out.money.balance()).toBe(START - value.shown);
  });
  it("an EDIT: the points the page showed as the most that may be held are the hold reserved", async () => {
    const { value, out } = await solo(opts(ONE), async (c) => {
      const made = await createEditRequest(c, { missionId: MISSION, userId: ME, version: 1, edit: parseEditInput({ kind: "rename_column", sheet: "الورقة", from: "عمود 1", to: "اسم جديد" }) as any });
      if (!made.ok) throw new Error(made.error);
      return { shown: made.request.holdPoints, answer: await reference(c, { id: made.request.id, expectedPoints: made.request.holdPoints }) };
    });
    expect(value.answer).toMatchObject({ approved: { ok: true, holdPoints: value.shown } });
    expect(reservesOf(out)[0].delta).toBe(-value.shown);
  });
  for (const wrong of [-1, 0, 1, 99, 101, 1.5, Number.NaN, "100" as unknown as number]) {
    it(`the customer approves a price that is not the server's (${String(wrong)}): refused as a price change BEFORE any money function, the row stays waiting`, async () => {
      const row = waiting(1);
      const hold = holdOf(row);
      expect(wrong).not.toBe(hold);
      const { value, out } = await solo(opts(ONE, { seed: [row] }), (c) => reference(c, { id: row.id as string, expectedPoints: wrong }));
      expect(value).toMatchObject({ refused: { ok: false, status: 409, reason: "price_mismatch", messageAr: ADDON_APPROVE_MESSAGES_AR.plan_changed } });
      expect(out.rows.get(row.id as string)).toMatchObject({ status: "plan_ready", job_id: null, approved_at: null });
      noMoney(out);
    });
  }
  it("a stored price that is not what the code computes (tampered plan) is refused before any money function, whatever the customer approved", async () => {
    const row = waiting(1);
    row.plan.addon.pricing.holdPoints = 999; row.plan.addon.pricing.estimatePoints = 999;
    const { value, out } = await solo(opts(ONE, { seed: [row] }), (c) => reference(c, { id: row.id as string, expectedPoints: 999 }));
    expect(value).toMatchObject({ refused: { ok: false, reason: "price_mismatch" } });
    noMoney(out);
  });
  it("the sentences of the new refusals pass the customer-text check and say nothing was held", () => {
    expect(checkCustomerText(ADDON_APPROVE_MESSAGES_AR.plan_changed).issues).toEqual([]);
    expect(ADDON_APPROVE_MESSAGES_AR.plan_changed).toContain("لم يُحجز");
  });
});

describe("6-7 no other add-on active, competing requests reconciled, unresolved paid reviews refused", () => {
  it("two waiting requests on one file: only the one that stays may start; the other is cancelled UNPAID and refused; ONE reserve in total", async () => {
    const a = waiting(1); const b = waiting(2);
    const { value, out } = await solo(opts(TWO, { seed: [a, b] }), async (c) => [await reference(c, { id: a.id as string }), await reference(c, { id: b.id as string })]);
    const approved = value.filter((v) => "approved" in v && v.approved?.ok);
    expect(approved).toHaveLength(1);
    expect(reservesOf(out)).toHaveLength(1);
    const loser = value.find((v) => "refused" in v)!;
    expect(loser).toMatchObject({ refused: { ok: false } });
    expect([...out.rows.values()].filter((r) => r.plan?.addon && r.status === "cancelled")).toHaveLength(1);
  });
  it("a request next to a STARTED one is refused and the started one is untouched", async () => {
    const started = { ...addonRowOf({ status: "executing", kind: "review", base: 1 }), request_text: "طلب", job_id: "job_started", approved_at: "2026-11-04T09:00:00.000Z" };
    const next = waiting(2);
    const { value, out } = await solo(opts(TWO, { seed: [started, next] }), (c) => reference(c, { id: next.id as string }));
    expect(value).toMatchObject({ refused: { ok: false, reason: "open_addon" } });
    expect(out.rows.get(started.id as string)!.status).toBe("executing");
    noMoney(out);
  });
  it("an earlier review of the version that was CHARGED and not published: a second request for it is refused, with no money function called (the contract's «refuse unresolved paid reviews»)", async () => {
    const first = { ...addonRowOf({ status: "failed", kind: "review", base: 1 }), request_text: "طلب", job_id: "job_x", approved_at: "2026-11-03T09:00:00.000Z", error: "charged_not_published", charged_points: 100 };
    const second = waiting(1, { id: addonId(MISSION, 1, 2), plan: { addon: { ...(waiting(1).plan as any).addon, attempt: 2 } } });
    const { value, out } = await solo(opts(ONE, { seed: [first, second], setup: chargedFirst(first) }), (c) => reference(c, { id: second.id as string }));
    expect(value).toMatchObject({ refused: { ok: false, reason: "review_unresolved" } });
    expect(out.money.calls).toEqual([]);
    expect(reservesOf(out)).toHaveLength(1); // the first review's own reserve, nothing new
  });
});

describe("8-10 double clicks, lost answers, consent before any reservation", () => {
  it("five clicks at once: exactly ONE approval, ONE reserve, the others refused; the ledger is sound", async () => {
    const row = waiting(1);
    const { value, out } = await solo(opts(ONE, { seed: [row] }), (c) => Promise.all([1, 2, 3, 4, 5].map(() => reference(c, { id: row.id as string, expectedPoints: holdOf(row) }))));
    expect(value.filter((v) => "approved" in v && v.approved?.ok)).toHaveLength(1);
    expect(reservesOf(out)).toHaveLength(1);
    expect(out.money.balance()).toBe(START - holdOf(row));
    expect(new Set(out.money.ledger.map((l) => l.id)).size).toBe(out.money.ledger.length);
  });
  it("a click after an approval that was heard is refused (not_ready), nothing more is reserved", async () => {
    const row = waiting(1);
    const { value, out } = await solo(opts(ONE, { seed: [row] }), async (c) => { await reference(c, { id: row.id as string }); return reference(c, { id: row.id as string }); });
    expect(value).toMatchObject({ refused: { ok: false, reason: "not_ready" } });
    expect(reservesOf(out)).toHaveLength(1);
  });
  it("LOST ANSWER: the reservation committed and the answer was lost: the customer is told the points MAY be held, the page's own workflow status does not say «nothing was held», and a retry converges with ONE reserve", async () => {
    const row = waiting(1);
    const { value, out } = await solo(opts(ONE, { seed: [row], setup: (w) => w.money.inject("accept_quote_atomic", "after") }), async (c) => {
      const first = await reference(c, { id: row.id as string });
      const workflow = await fileWorkflowFor(c, { missionId: MISSION, userId: ME });
      const retry = await reference(c, { id: row.id as string });
      return { first, workflow, retry };
    });
    expect(value.first).toMatchObject({ approved: { ok: false, code: "approval_unverified", error: ADDON_APPROVE_MESSAGES_AR.approval_unverified } });
    expect(value.workflow).toMatchObject({ ok: true, workflow: { items: [expect.objectContaining({ phase: "approval_unverified" })] } });
    expect(value.retry).toMatchObject({ approved: { ok: true } });
    expect(reservesOf(out)).toHaveLength(1);
    expect(out.money.ledger.filter((l) => l.type === "release" || l.type === "charge")).toEqual([]);
  });
  it("CONSENT: until the explicit approval nothing moves: creating requests, reading the page, the price preview and the guard itself call no money function and leave only the top-up in the ledger", async () => {
    const { out } = await solo(opts(ONE), async (c) => {
      const made = await createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 });
      if (!made.ok) throw new Error(made.error);
      await fileWorkflowFor(c, { missionId: MISSION, userId: ME });
      await guardApproval(c, { id: made.request.id, userId: ME, expectedPoints: made.request.points });
      await guardApproval(c, { id: made.request.id, userId: ME, expectedPoints: made.request.points });
    });
    expect(out.money.calls).toEqual([]);
    expect(out.money.ledger.map((l) => l.id)).toEqual(["top_1"]);
    expect([...out.money.jobs.keys()]).toEqual([]);
    expect(out.world.other).toEqual([]);
  });
  it("only the three EXISTING money functions are called, in order, and no provider is reached", async () => {
    const row = waiting(1);
    const { out } = await solo(opts(ONE, { seed: [row] }), (c) => reference(c, { id: row.id as string, expectedPoints: holdOf(row) }));
    expect(out.money.calls.map((c) => c.name)).toEqual(["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("the guard answers every refusal with an Arabic sentence that passes the customer-text check", async () => {
    const row = waiting(1);
    const answers = await Promise.all([
      solo(opts(ONE, { seed: [row] }), (c) => guardApproval(c, { id: row.id as string, userId: ME, expectedPoints: 1 })),
      solo(opts({}, { seed: [row] }), (c) => guardApproval(c, { id: row.id as string, userId: ME })),
      solo(opts(ONE, { seed: [row] }), (c) => guardApproval(c, { id: "msn_nope00000000000001", userId: ME })),
    ]);
    for (const a of answers) { const v = a.value as { ok: boolean; messageAr?: string }; expect(v.ok).toBe(false); expect(checkCustomerText(v.messageAr ?? "").issues).toEqual([]); expect(v.messageAr).not.toMatch(/[0-9]/); }
  });
});
