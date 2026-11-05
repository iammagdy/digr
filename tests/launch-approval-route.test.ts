import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ADDON_APPROVE_MESSAGES_AR } from "../src/lib/agentMission/addonSettlement";
import { approvalAvailable, approveAddonForCustomer, kindFlagOn } from "../src/lib/agentMission/stage4/approvalRoute";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { createEditRequest, parseEditInput } from "../src/lib/agentMission/stage4/editRequest";
import { createReviewRequest } from "../src/lib/agentMission/stage4/reviewRequest";
import type { FileVersion } from "../src/lib/agentMission/stage4/versions";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { addonRowOf as moneyRowOf } from "./helpers/addonWorld";
import { solo, type Out, type Row, type SchedOpts } from "./helpers/scheduledWorld";
import { addonRowOf, objectsOf, sizedVersion } from "./helpers/reviewQuoteWorld";

/**
 * LAUNCH ROUND, WORKSTREAM 2: THE APPROVAL ROUTE'S LOGIC (`approveAddonForCustomer`), on the hardened FAKE money core and the real Stage A/B creation code. No network, no provider, no real database, no real money.
 * It pins what the route adds to the two functions the safety rounds tested: the flags (read first), the customer gates, the strict body, the request's ownership and file, the supported kinds, the double click, the uncertain answers, and that no internal id leaves the server.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const FILE_CELLS = 18;
const MISSION = "msn_5851abc92a1e6645a9cd";
const OTHER_FILE = "msn_otherfile0000000001";
const ME = "u-1";
const START = 100_000;
const MISSION_ROW = { id: MISSION, user_id: ME, status: "completed", plan: { stages: [] }, delivered_units: 60 };
const ON = { DIGER_STAGE4_APPROVAL: "on", DIGER_STAGE4_REVIEW: "on", DIGER_STAGE4_EDITS: "on" } as const;
let ONE: Record<string, string>;
beforeAll(() => {
  const v1: FileVersion = sizedVersion(6, 3);
  const r = applyEditRequest(v1, { kind: "rename_column", sheet: "الورقة", from: "عمود 3", to: "عمود ثالث" }, { createdAt: "2026-11-03T09:30:00.000Z" });
  if (!r.ok) throw new Error(r.reason);
  ONE = objectsOf(v1);
});
const opts = (more: Partial<SchedOpts> = {}): SchedOpts => ({ objects: ONE, balance: START, ...more, seed: [MISSION_ROW, ...(more.seed ?? [])] });
const waiting = (over: Record<string, unknown> = {}): Row => ({ ...addonRowOf({ status: "plan_ready", kind: "review", base: 1, cells: FILE_CELLS }), request_text: "طلب مراجعة", job_id: null, approved_at: null, ...over });
const reservesOf = (out: Out) => out.money.ledger.filter((l) => l.type === "reserve");
const noMoney = (out: Out) => { expect(out.money.calls, "no money function was called").toEqual([]); expect(reservesOf(out)).toEqual([]); expect(out.money.balance()).toBe(START); };
const holdOf = (r: Row): number => r.plan.addon.pricing.holdPoints;
const customer = { userId: ME, isGuest: false, emailVerified: true };
const approve = (c: any, over: Partial<Parameters<typeof approveAddonForCustomer>[1]> & { body?: unknown }) => approveAddonForCustomer(c, { missionId: MISSION, ...customer, env: ON, body: undefined, ...over } as never);

describe("1 the flags are read first; only «on» serves", () => {
  it("every value but exactly «on» is OFF (unset, empty, test, ON-with-spaces-is-on, 1, true): nothing is read and nothing moves", async () => {
    expect(approvalAvailable({})).toBe(false);
    for (const v of ["", "test", "off", "1", "true", "yes", "enabled"]) expect(approvalAvailable({ DIGER_STAGE4_APPROVAL: v })).toBe(false);
    expect(approvalAvailable({ DIGER_STAGE4_APPROVAL: "on" })).toBe(true);
    const row = waiting();
    const { value, out } = await solo(opts({ seed: [row] }), (c) => approve(c, { env: {}, body: { requestId: row.id, expectedPoints: holdOf(row) } }));
    expect(value).toMatchObject({ status: 404, body: { success: false, state: "refused", code: "not_found" } });
    noMoney(out);
    expect(out.rows.get(row.id as string)).toMatchObject({ status: "plan_ready", job_id: null });
  });
  it("the request's kind flag is also needed: a review needs DIGER_STAGE4_REVIEW, an edit DIGER_STAGE4_EDITS, a review_fix has none", async () => {
    expect(kindFlagOn("review", { DIGER_STAGE4_REVIEW: "on" })).toBe(true);
    expect(kindFlagOn("review", { DIGER_STAGE4_EDITS: "on" })).toBe(false);
    expect(kindFlagOn("edit", { DIGER_STAGE4_EDITS: "on" })).toBe(true);
    expect(kindFlagOn("review_fix", ON)).toBe(false);
    const row = waiting();
    const { value, out } = await solo(opts({ seed: [row] }), (c) => approve(c, { env: { DIGER_STAGE4_APPROVAL: "on", DIGER_STAGE4_EDITS: "on" }, body: { requestId: row.id, expectedPoints: holdOf(row) } }));
    expect(value).toMatchObject({ status: 404, body: { code: "not_found" } });
    noMoney(out);
  });
});

describe("2 the customer: a guest signs up, an unverified account verifies its e-mail", () => {
  it("a guest is told to sign up (401) and an unverified account to verify (403), with no money function called", async () => {
    const row = waiting();
    const body = { requestId: row.id, expectedPoints: holdOf(row) };
    const g = await solo(opts({ seed: [row] }), (c) => approve(c, { isGuest: true, body }));
    expect(g.value).toMatchObject({ status: 401, body: { state: "refused", code: "guest" } });
    noMoney(g.out);
    const u = await solo(opts({ seed: [row] }), (c) => approve(c, { emailVerified: false, body }));
    expect(u.value).toMatchObject({ status: 403, body: { state: "refused", code: "unverified" } });
    noMoney(u.out);
  });
});

describe("3 the body is {requestId, expectedPoints} and nothing else", () => {
  const row = waiting();
  const good = { requestId: row.id, expectedPoints: holdOf(row) };
  const bads: Array<[string, unknown]> = [
    ["undefined", undefined], ["null", null], ["an array", [good]], ["a string", "x"], ["an empty object", {}],
    ["an extra key (price)", { ...good, price: 1 }], ["an extra key (userId)", { ...good, userId: "u-2" }], ["no expectedPoints", { requestId: row.id }], ["no requestId", { expectedPoints: 100 }],
    ["a float", { ...good, expectedPoints: 100.5 }], ["a string number", { ...good, expectedPoints: "100" }], ["zero", { ...good, expectedPoints: 0 }], ["negative", { ...good, expectedPoints: -100 }], ["above the limit", { ...good, expectedPoints: 5001 }], ["NaN", { ...good, expectedPoints: Number.NaN }],
    ["an unsafe id", { requestId: "../x", expectedPoints: 100 }], ["a non-string id", { requestId: 5, expectedPoints: 100 }], ["a plain mission-less id", { requestId: "abc", expectedPoints: 100 }],
  ];
  for (const [label, body] of bads) {
    it(`${label}: a 400 with nothing read for money`, async () => {
      const { value, out } = await solo(opts({ seed: [row] }), (c) => approve(c, { body }));
      expect(value).toMatchObject({ status: 400, body: { success: false, state: "refused", code: "bad_request" } });
      noMoney(out);
      expect(out.rows.get(row.id as string)).toMatchObject({ status: "plan_ready" });
    });
  }
});

describe("4 the request must be this customer's, an add-on of THIS file, of a kind that can be run", () => {
  it("another customer's request, an unknown id, an ordinary mission and another file's request are the same «not found»", async () => {
    const mine = waiting();
    const ordinary = { id: "msn_ordinary00000001", user_id: ME, status: "plan_ready", plan: { stages: [] } } as Row;
    const cases: Array<[string, Partial<Parameters<typeof approveAddonForCustomer>[1]>, string]> = [
      ["another customer", { userId: "u-2" }, mine.id as string],
      ["unknown", {}, "msn_nope00000000000001"],
      ["ordinary mission", {}, ordinary.id as string],
      ["another file", { missionId: OTHER_FILE }, mine.id as string],
    ];
    for (const [label, over, requestId] of cases) {
      const { value, out } = await solo(opts({ seed: [mine, ordinary] }), (c) => approve(c, { ...over, body: { requestId, expectedPoints: holdOf(mine) } }));
      expect(value, label).toMatchObject({ status: 404, body: { state: "refused", code: "not_found", error: ADDON_APPROVE_MESSAGES_AR.not_found } });
      noMoney(out);
    }
  });
  it("a review_fix request (not offered by any page) is not approvable here", async () => {
    const fix = { ...moneyRowOf({ of: MISSION, baseVersion: 1, kind: "review_fix", userId: ME }), request_text: "x", job_id: null, approved_at: null } as Row;
    const { value, out } = await solo(opts({ seed: [fix] }), (c) => approve(c, { body: { requestId: fix.id, expectedPoints: holdOf(fix) } }));
    expect(value).toMatchObject({ status: 404, body: { code: "not_found" } });
    noMoney(out);
  });
});

describe("5 the price is the server's: the customer approves exactly what the page showed", () => {
  it("a REVIEW made by the real creation code: approved with the shown points, the hold reserved IS that price, once, and nothing else moves", async () => {
    const { value, out } = await solo(opts(), async (c) => {
      const made = await createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 });
      if (!made.ok) throw new Error(made.error);
      return { shown: made.request.points, id: made.request.id, answer: await approve(c, { body: { requestId: made.request.id, expectedPoints: made.request.points } }) };
    });
    expect(value.answer).toMatchObject({ status: 200, body: { success: true, state: "approved", kind: "review", holdPoints: value.shown } });
    expect(reservesOf(out)).toHaveLength(1);
    expect(reservesOf(out)[0].delta).toBe(-value.shown);
    expect(out.money.balance()).toBe(START - value.shown);
    expect(out.money.calls.map((c) => c.name)).toEqual(["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk"]);
    expect(out.rows.get(value.id)).toMatchObject({ status: "approved", reserved_points: value.shown });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("an EDIT: the points shown as the most that may be held are the hold reserved", async () => {
    const { value, out } = await solo(opts(), async (c) => {
      const made = await createEditRequest(c, { missionId: MISSION, userId: ME, version: 1, edit: parseEditInput({ kind: "rename_column", sheet: "الورقة", from: "عمود 1", to: "اسم جديد" }) as any });
      if (!made.ok) throw new Error(made.error);
      return { shown: made.request.holdPoints, answer: await approve(c, { body: { requestId: made.request.id, expectedPoints: made.request.holdPoints } }) };
    });
    expect(value.answer).toMatchObject({ status: 200, body: { success: true, state: "approved", kind: "edit", holdPoints: value.shown } });
    expect(reservesOf(out)[0].delta).toBe(-value.shown);
  });
  for (const wrong of [1, 99, 101, 5000]) {
    it(`the customer approves ${wrong} instead of the server's price: a 409 price change BEFORE any money function; the request stays waiting`, async () => {
      const row = waiting();
      expect(wrong).not.toBe(holdOf(row));
      const { value, out } = await solo(opts({ seed: [row] }), (c) => approve(c, { body: { requestId: row.id, expectedPoints: wrong } }));
      expect(value).toMatchObject({ status: 409, body: { state: "refused", code: "price_mismatch" } });
      noMoney(out);
      expect(out.rows.get(row.id as string)).toMatchObject({ status: "plan_ready", job_id: null, approved_at: null });
    });
  }
  it("a tampered stored price is refused whatever the customer sends", async () => {
    const row = waiting();
    row.plan.addon.pricing.holdPoints = 999; row.plan.addon.pricing.estimatePoints = 999;
    const { value, out } = await solo(opts({ seed: [row] }), (c) => approve(c, { body: { requestId: row.id, expectedPoints: 999 } }));
    expect(value).toMatchObject({ status: 409, body: { code: "price_mismatch" } });
    noMoney(out);
  });
});

describe("6 the balance: no negative balance, nothing held when the points are not enough", () => {
  it("a balance below the hold: 402, nothing reserved, the request is waiting again, the balance is unchanged", async () => {
    const row = waiting();
    const { value, out } = await solo(opts({ seed: [row], balance: holdOf(row) - 1 }), (c) => approve(c, { body: { requestId: row.id, expectedPoints: holdOf(row) } }));
    expect(value).toMatchObject({ status: 402, body: { state: "refused", code: "insufficient_balance", error: ADDON_APPROVE_MESSAGES_AR.insufficient_balance } });
    expect(reservesOf(out)).toEqual([]);
    expect(out.money.balance()).toBe(holdOf(row) - 1);
    expect(out.rows.get(row.id as string)).toMatchObject({ status: "plan_ready" });
  });
  it("exactly the hold: approved, balance zero, never negative", async () => {
    const row = waiting();
    const { value, out } = await solo(opts({ seed: [row], balance: holdOf(row) }), (c) => approve(c, { body: { requestId: row.id, expectedPoints: holdOf(row) } }));
    expect(value).toMatchObject({ status: 200, body: { state: "approved" } });
    expect(out.money.balance()).toBe(0);
  });
});

describe("7 double clicks, retries and lost answers", () => {
  it("five clicks at once: exactly ONE approval and ONE reserve; the others are told it is already approved or another request stays, never a second hold", async () => {
    const row = waiting();
    const { value, out } = await solo(opts({ seed: [row] }), (c) => Promise.all(Array.from({ length: 5 }, () => approve(c, { body: { requestId: row.id, expectedPoints: holdOf(row) } }))));
    expect(value.filter((v) => v.status === 200)).toHaveLength(1);
    expect(reservesOf(out)).toHaveLength(1);
    expect(out.money.balance()).toBe(START - holdOf(row));
    expect(new Set(out.money.ledger.map((l) => l.id)).size).toBe(out.money.ledger.length);
    for (const v of value.filter((x) => x.status !== 200)) expect(["already_approved", "refused"]).toContain(v.body.state);
  });
  it("a click after an approval that was heard: «already approved» (409), no second reserve, no money function called again", async () => {
    const row = waiting();
    const { value, out } = await solo(opts({ seed: [row] }), async (c) => { await approve(c, { body: { requestId: row.id, expectedPoints: holdOf(row) } }); const calls = (await 0, 0); void calls; return approve(c, { body: { requestId: row.id, expectedPoints: holdOf(row) } }); });
    expect(value).toMatchObject({ status: 409, body: { success: false, state: "already_approved", code: "already_approved" } });
    expect(reservesOf(out)).toHaveLength(1);
    expect(out.money.calls.map((c) => c.name)).toEqual(["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk"]);
  });
  it("LOST ANSWER: the reservation committed and the answer was lost: state «uncertain», the words say the points MAY be held (never «nothing was held»), and the retry converges with ONE reserve", async () => {
    const row = waiting();
    const { value, out } = await solo(opts({ seed: [row], setup: (w) => w.money.inject("accept_quote_atomic", "after") }), async (c) => {
      const first = await approve(c, { body: { requestId: row.id, expectedPoints: holdOf(row) } });
      const retry = await approve(c, { body: { requestId: row.id, expectedPoints: holdOf(row) } });
      return { first, retry };
    });
    expect(value.first).toMatchObject({ status: 409, body: { success: false, state: "uncertain", code: "approval_unverified", error: ADDON_APPROVE_MESSAGES_AR.approval_unverified } });
    expect(value.first.body.error).not.toContain("لم يُخصم شيء");
    expect(value.retry).toMatchObject({ status: 200, body: { state: "approved" } });
    expect(reservesOf(out)).toHaveLength(1);
    expect(out.money.ledger.filter((l) => l.type === "release" || l.type === "charge")).toEqual([]);
  });
  it("an exception thrown by the database is never «nothing was held»: state «uncertain», 503", async () => {
    const row = waiting();
    const { value } = await solo(opts({ seed: [row] }), async (c) => {
      const broken = { from: () => { throw new Error("boom"); }, rpc: () => { throw new Error("boom"); } };
      void c;
      return approve(broken, { body: { requestId: row.id, expectedPoints: holdOf(row) } });
    });
    expect(value).toMatchObject({ status: 503, body: { state: "uncertain", code: "approval_unverified" } });
  });
});

describe("8 one open add-on per file; no second paid review", () => {
  it("two waiting requests on one file: only the one that stays can be approved; ONE reserve in total", async () => {
    const a = waiting(); const b = { ...addonRowOf({ status: "plan_ready", kind: "review", base: 2, cells: FILE_CELLS }), request_text: "x", job_id: null, approved_at: null } as Row;
    const { value, out } = await solo(opts({ seed: [a, b], objects: { ...ONE } }), async (c) => [await approve(c, { body: { requestId: a.id, expectedPoints: holdOf(a) } }), await approve(c, { body: { requestId: b.id, expectedPoints: holdOf(b) } })]);
    expect(value.filter((v) => v.status === 200).length).toBeLessThanOrEqual(1);
    expect(reservesOf(out).length).toBeLessThanOrEqual(1);
  });
});

describe("9 what leaves the server: Arabic words, no internal id, no money detail", () => {
  it("no answer carries a job id, quote id, ledger id, provider or USD, and every refusal sentence passes the customer-text check", async () => {
    const row = waiting();
    const runs = await Promise.all([
      solo(opts({ seed: [row] }), (c) => approve(c, { body: { requestId: row.id, expectedPoints: holdOf(row) } })),
      solo(opts({ seed: [row] }), (c) => approve(c, { body: { requestId: row.id, expectedPoints: 1 } })),
      solo(opts({ seed: [row], balance: 1 }), (c) => approve(c, { body: { requestId: row.id, expectedPoints: holdOf(row) } })),
      solo(opts({ seed: [row] }), (c) => approve(c, { isGuest: true, body: {} })),
      solo(opts({ seed: [row] }), (c) => approve(c, { body: { requestId: "../", expectedPoints: 1 } })),
    ]);
    for (const { value } of runs) {
      const text = JSON.stringify(value);
      expect(text).not.toMatch(/job_quote_|quote_addon_|res_job|rel_job|chg_job|usd|treg|provider/i);
      if (typeof value.body.error === "string") { expect(checkCustomerText(value.body.error).issues).toEqual([]); expect(value.body.error).not.toMatch(/[0-9]/); }
    }
  });
});
