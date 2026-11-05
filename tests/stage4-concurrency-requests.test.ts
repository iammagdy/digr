import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addonId } from "../src/lib/agentMission/addonSettlement";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { createEditRequest, parseEditInput } from "../src/lib/agentMission/stage4/editRequest";
import { currentEditRequest } from "../src/lib/agentMission/stage4/editRequest";
import { createReviewRequest, currentReviewRequest } from "../src/lib/agentMission/stage4/reviewRequest";
import { reviewQuoteFor } from "../src/lib/agentMission/stage4/reviewPreview";
import type { FileVersion } from "../src/lib/agentMission/stage4/versions";
import { addonRows, explore, isOpenAddon, openRows, runSchedule, solo, type Maker, type Out, type Row, type SchedOpts } from "./helpers/scheduledWorld";
import { addonRowOf, objectsOf, sizedVersion } from "./helpers/reviewQuoteWorld";

/**
 * STAGE E, PART 1: THE CREATION OF REQUESTS UNDER CONCURRENCY (docs/STAGE-4-CONCURRENCY.md scenarios 1, 2, 4, 5 and 10). The REAL `createReviewRequest`, `createEditRequest`, `currentReviewRequest` and `currentEditRequest` run over one shared stateful `missions` table
 * (tests/helpers/scheduledWorld.ts): every table operation is one atomic step and EVERY order of the steps of the concurrent actors is run (a depth-first walk), with the failures the protocol has to survive. Nothing here is money: the money fake sits behind `rpc` and the tests
 * assert it is never called, no job exists and the ledger holds only the top-up. Where the protocol alone CANNOT give a guarantee, the test shows that end state on purpose and is named «DOCUMENTED UNRESOLVED RISK»; none is skipped or weakened.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const MISSION = "msn_5851abc92a1e6645a9cd";
const ME = "u-1";
const SHEET = "الورقة";
const MISSION_ROW = { id: MISSION, user_id: ME, status: "completed", plan: { stages: [] }, delivered_units: 60 };
const RENAME = parseEditInput({ kind: "rename_column", sheet: SHEET, from: "عمود 1", to: "الاسم الجديد" });
const RENAME_OTHER = parseEditInput({ kind: "rename_column", sheet: SHEET, from: "عمود 2", to: "اسم ثانٍ" });
if (!RENAME.ok || !RENAME_OTHER.ok) throw new Error("the fixture edit was refused");

let v1: FileVersion; let v2: FileVersion; let ONE: Record<string, string>; let TWO: Record<string, string>;
beforeAll(() => {
  v1 = sizedVersion(6, 3);
  const r = applyEditRequest(v1, { kind: "rename_column", sheet: SHEET, from: "عمود 3", to: "عمود ثالث" }, { createdAt: "2026-11-03T09:30:00.000Z" });
  if (!r.ok) throw new Error(r.reason);
  v2 = r.version;
  ONE = objectsOf(v1); TWO = objectsOf(v1, v2);
});
const opts = (objects: Record<string, string>, more: Partial<SchedOpts> = {}): SchedOpts => ({ objects, ...more, seed: [MISSION_ROW, ...(more.seed ?? [])] });

const review = (version: number): Maker => async (a) => createReviewRequest(a.client, { missionId: MISSION, userId: ME, version });
const edit = (version: number, which = RENAME): Maker => async (a) => createEditRequest(a.client, { missionId: MISSION, userId: ME, version, edit: which as any });
type Told = { ok: true; created: boolean; request: { id: string } } | { ok: false; status: number; error: string };
const told = (out: Out, i: number): Told => { const r = out.results[i]; if (!r.ok) throw r.error; return r.value as Told; };
const kindOf = (r: Row): string => r.plan.addon.kind;
/** Nothing of the money side moved: no rpc, no job, no ledger row but the top-up, no other table. */
const noMoney = (out: Out) => { expect(out.money.calls).toEqual([]); expect([...out.money.jobs.keys()]).toEqual([]); expect(out.money.ledger.map((l) => l.id)).toEqual(["top_1"]); expect(out.world.other).toEqual([]); };
/** A started or paid row is never cancelled by a creator. */
const noStartedCancelled = (out: Out) => { for (const r of addonRows(out.rows)) if (r.status === "cancelled") { expect(r.approved_at ?? null).toBeNull(); expect(r.job_id ?? null).toBeNull(); } };

describe("SCENARIO 1: two simultaneous review requests", () => {
  it("the SAME version twice (a double click from two tabs): one id, one row, both creators told ok, and the row they were told about is the one that stays open, in every order", async () => {
    let created = 0;
    const { runs } = await explore([review(1), review(1)], (out) => {
      const open = openRows(out.rows);
      expect(open).toHaveLength(1);
      for (const i of [0, 1]) { const t = told(out, i); expect(t.ok, `creator ${i} is told ok (the same click twice)`).toBe(true); if (t.ok) { expect(t.request.id).toBe(open[0].id); if (t.created) created += 1; } }
      expect(addonRows(out.rows)).toHaveLength(1);
      noMoney(out); noStartedCancelled(out);
    }, opts(ONE));
    expect(runs).toBeGreaterThan(50);
    expect(created, "exactly one creator per run says «created»: asserted per run below").toBeGreaterThan(0);
  }, 300_000);
  it("exactly one of the two says «created» in every order", async () => {
    await explore([review(1), review(1)], (out) => { expect([told(out, 0), told(out, 1)].filter((t) => t.ok && t.created)).toHaveLength(1); }, opts(ONE));
  }, 300_000);
  it("two DIFFERENT versions (a review of version 1 and one of version 2): at the end exactly ONE request is open, the other creator's row is cancelled, nothing started is cancelled, and no money moved, in every order", async () => {
    const { runs } = await explore([review(1), review(2)], (out) => {
      expect(openRows(out.rows)).toHaveLength(1);
      expect(addonRows(out.rows).filter((r) => r.status === "cancelled").length + 1).toBe(addonRows(out.rows).length);
      for (const i of [0, 1]) { const t = told(out, i); if (!t.ok) { expect(t).toMatchObject({ status: 409, error: "open_addon" }); } }
      noMoney(out); noStartedCancelled(out);
    }, opts(TWO));
    expect(runs).toBeGreaterThan(100);
  }, 300_000);
  it("DOCUMENTED UNRESOLVED RISK (UX, no money): a creator can be told «ready» and a moment later find its request cancelled by the other creator's repair (two tabs, the same instant). The page then shows the request that stays", async () => {
    let toldOkButCancelled = 0;
    await explore([review(1), review(2)], (out) => {
      for (const i of [0, 1]) { const t = told(out, i); if (t.ok && !openRows(out.rows).some((r) => r.id === t.request.id)) toldOkButCancelled += 1; }
    }, opts(TWO));
    expect(toldOkButCancelled, "some interleaving tells a creator ok and then cancels its request").toBeGreaterThan(0);
  }, 300_000);
});

describe("SCENARIO 2: a review request and an edit request racing", () => {
  it("SAME base version (the id collides: the primary key decides): exactly ONE request is made and exactly one creator is told ok; the other is told «open request», never ok, in every order", async () => {
    const kinds = new Set<string>();
    const { runs } = await explore([review(1), edit(1)], (out) => {
      const open = openRows(out.rows);
      expect(open).toHaveLength(1);
      expect(addonRows(out.rows)).toHaveLength(1);
      const [a, b] = [told(out, 0), told(out, 1)];
      expect([a, b].filter((t) => t.ok)).toHaveLength(1);
      const loser = a.ok ? b : a;
      expect(loser).toMatchObject({ ok: false, status: 409, error: "open_addon" });
      const winner = (a.ok ? a : b) as Extract<Told, { ok: true }>;
      expect(winner.request.id).toBe(open[0].id);
      kinds.add(kindOf(open[0]));
      noMoney(out); noStartedCancelled(out);
    }, opts(ONE));
    expect(runs).toBeGreaterThan(50);
    expect([...kinds].sort(), "either kind can win; the other is refused").toEqual(["edit", "review"]);
  }, 300_000);
  it("DIFFERENT base versions (a review of version 1 and an edit of the latest, version 2): exactly ONE request stays open in every order, and no money moves", async () => {
    const { runs } = await explore([review(1), edit(2)], (out) => {
      expect(openRows(out.rows)).toHaveLength(1);
      for (const i of [0, 1]) { const t = told(out, i); if (!t.ok) expect(t).toMatchObject({ status: 409, error: "open_addon" }); }
      noMoney(out); noStartedCancelled(out);
    }, opts(TWO));
    expect(runs).toBeGreaterThan(100);
  }, 300_000);
  it("an edit of version 1 racing an edit of version 2 (version 1 is no longer the latest): the old one is always refused as «not the latest», the new one is made, in every order", async () => {
    await explore([edit(1), edit(2, RENAME_OTHER)], (out) => {
      // the old one is refused as «not the latest», or as «open request» when the new one was already made: never made
      const old = told(out, 0);
      expect(old).toMatchObject({ ok: false, status: 409 });
      expect(["not_latest_version", "open_addon"]).toContain((old as { error: string }).error);
      expect(told(out, 1)).toMatchObject({ ok: true, created: true });
      expect(openRows(out.rows)).toHaveLength(1);
      noMoney(out);
    }, opts(TWO));
  }, 300_000);
  it("the SAME edit twice: one request; both told ok; exactly one «created». A DIFFERENT edit on the same base: one request, the other refused (the primary key and the canonical comparison of the stored edit)", async () => {
    await explore([edit(1), edit(1)], (out) => {
      expect(openRows(out.rows)).toHaveLength(1);
      expect([told(out, 0), told(out, 1)].every((t) => t.ok)).toBe(true);
      expect([told(out, 0), told(out, 1)].filter((t) => t.ok && t.created)).toHaveLength(1);
    }, opts(ONE));
    await explore([edit(1), edit(1, RENAME_OTHER)], (out) => {
      expect(openRows(out.rows)).toHaveLength(1);
      expect([told(out, 0), told(out, 1)].filter((t) => t.ok)).toHaveLength(1);
      expect([told(out, 0), told(out, 1)].find((t) => !t.ok)).toMatchObject({ status: 409, error: "open_addon" });
    }, opts(ONE));
  }, 300_000);
  it("the edit path's refusal never invents a request: a review request that is waiting blocks the edit and the edit page shows none; and the reverse (the review page shows none of the edit)", async () => {
    const a = await solo(opts(ONE), async (c) => { await createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }); return { edit: await createEditRequest(c, { missionId: MISSION, userId: ME, version: 1, edit: RENAME as any }), seen: await currentEditRequest(c, { missionId: MISSION, userId: ME }) }; });
    expect(a.value.edit).toMatchObject({ ok: false, status: 409, error: "open_addon" });
    expect(a.value.seen).toEqual({ ok: true, request: null });
    const b = await solo(opts(ONE), async (c) => { await createEditRequest(c, { missionId: MISSION, userId: ME, version: 1, edit: RENAME as any }); return { review: await createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }), seen: await currentReviewRequest(c, { missionId: MISSION, userId: ME }) }; });
    expect(b.value.review).toMatchObject({ ok: false, status: 409, error: "open_addon" });
    expect(b.value.seen).toEqual({ ok: true, request: null });
  });
});

describe("SCENARIO 4: a read fails right after the insert", () => {
  /** every `select` of the second actor AFTER its own insert fails (the post-insert read), writes still work */
  const readFailsAfterInsert: SchedOpts["fault"] = (i) => i.client === 1 && i.op === "select" && i.inserted;
  for (const [label, a, b, objects] of [["review v1 / review v2", review(1), review(2), "TWO"], ["review v1 / edit v2", review(1), edit(2), "TWO"], ["edit v1 / review v1 (same id)", edit(1), review(1), "ONE"]] as const) {
    it(`${label}: the creator whose read failed withdraws its own unpaid row and reports a failure; at most ONE request is open in every order; no money`, async () => {
      let failures = 0;
      const { runs } = await explore([a, b], (out) => {
        expect(openRows(out.rows).length).toBeLessThanOrEqual(1);
        const t = told(out, 1);
        if (!t.ok && t.status === 503) { failures += 1; expect(t.error).toBe("unavailable"); }
        // the row of the failed creator, if it was inserted, is never left open next to another
        noMoney(out); noStartedCancelled(out);
      }, opts(objects === "TWO" ? TWO : ONE, { fault: readFailsAfterInsert }));
      expect(runs).toBeGreaterThan(20);
      expect(failures, "the failure is reported to the customer in some orders").toBeGreaterThan(0);
    }, 300_000);
  }
  it("a read that fails BEFORE the insert (the creator never wrote anything): nothing is made by it, and the other creator's request stays", async () => {
    await explore([review(1), review(2)], (out) => {
      expect(openRows(out.rows)).toHaveLength(1);
      expect(told(out, 1)).toMatchObject({ ok: false, status: 503 });
      expect(addonRows(out.rows).filter((r) => r.status !== "cancelled")).toHaveLength(1);
    }, opts(TWO, { fault: (i) => i.client === 1 && i.op === "select" && i.n === 2 }));
  }, 300_000);
});

describe("SCENARIO 5: the database is gone completely right after the insert", () => {
  const blackout: SchedOpts["fault"] = (i) => i.client === 1 && i.inserted;
  it("DOCUMENTED UNRESOLVED RISK (money-adjacent): the creator can neither read nor write after its insert, so TWO open requests CAN remain on one file until the next reader repairs them; the protocol alone is not a constraint", async () => {
    let two = 0;
    let max = 0;
    await explore([review(1), review(2)], (out) => {
      const n = openRows(out.rows).length;
      max = Math.max(max, n);
      if (n === 2) two += 1;
      expect(n).toBeLessThanOrEqual(2);
      noMoney(out); noStartedCancelled(out);
    }, opts(TWO, { fault: blackout }));
    expect(max, "the end state with two open requests exists").toBe(2);
    expect(two).toBeGreaterThan(0);
  }, 300_000);
  it("the same with an EDIT as the creator that goes dark (review v1 / edit v2): two open requests of different kinds can remain", async () => {
    let max = 0;
    await explore([review(1), edit(2)], (out) => { max = Math.max(max, openRows(out.rows).length); }, opts(TWO, { fault: blackout }));
    expect(max).toBe(2);
  }, 300_000);
  it("the NEXT reader repairs every such end state (the customer's page, a creator before it refuses): exactly one stays, the lowest id, nothing started is cancelled, and the repair writes one cancel only", async () => {
    let repaired = 0;
    await explore([review(1), review(2)], async (out) => {
      if (openRows(out.rows).length !== 2) return;
      const seed = [...out.rows.values()].filter((r) => r.id !== MISSION);
      const fixed = await solo(opts(TWO, { seed }), async (c) => ({ review: await currentReviewRequest(c, { missionId: MISSION, userId: ME }), edit: await currentEditRequest(c, { missionId: MISSION, userId: ME }) }));
      const open = openRows(fixed.out.rows);
      expect(open).toHaveLength(1);
      expect(open[0].id).toBe([addonId(MISSION, 1, 1), addonId(MISSION, 2, 1)].sort()[0]);
      expect(fixed.value.review).toMatchObject({ ok: true, request: { id: open[0].id } });
      expect(fixed.value.edit).toEqual({ ok: true, request: null });
      repaired += 1;
    }, opts(TWO, { fault: blackout }));
    expect(repaired).toBeGreaterThan(0);
  }, 300_000);
  it("a creator that finds two open requests repairs them BEFORE it refuses and is told which one stays", async () => {
    const two = [addonRowOf({ status: "plan_ready", kind: "review", base: 1 }), addonRowOf({ status: "plan_ready", kind: "review", base: 2 })];
    const { value, out } = await solo(opts(TWO, { seed: two }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 2 }));
    const stays = [addonId(MISSION, 1, 1), addonId(MISSION, 2, 1)].sort()[0];
    expect(openRows(out.rows).map((r) => r.id)).toEqual([stays]);
    // when the request that stays is the very version asked for, that request is the answer (created: false); otherwise the creator is refused
    expect(value).toMatchObject(stays === addonId(MISSION, 2, 1) ? { ok: true, created: false, request: { id: stays } } : { ok: false, status: 409, error: "open_addon" });
    // the same creator asking for version 1 gets the mirror answer
    const other = await solo(opts(TWO, { seed: two }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(other.value).toMatchObject(stays === addonId(MISSION, 1, 1) ? { ok: true, created: false, request: { id: stays } } : { ok: false, status: 409, error: "open_addon" });
  });
});

describe("SCENARIO 10: a review that already exists is reused, never paid for twice", () => {
  const completedReview = (base = 1, over: Record<string, unknown> = {}): Row => ({ ...addonRowOf({ status: "completed", kind: "review", base }), request_text: "طلب مراجعة", ...over });
  it("a completed review of the version: a new review request is refused as «reviewed already» (free), the price preview says «reuse», and NO row is made, even with two creators at once", async () => {
    const seed = [completedReview(1)];
    await explore([review(1), review(1)], (out) => {
      for (const i of [0, 1]) expect(told(out, i)).toMatchObject({ ok: false, status: 409, error: "review_exists" });
      expect(addonRows(out.rows)).toHaveLength(1);
      expect(openRows(out.rows)).toEqual([]);
      noMoney(out);
    }, opts(ONE, { seed }));
    const q = await solo(opts(ONE, { seed }), (c) => reviewQuoteFor(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(q.value).toMatchObject({ ok: true, quote: { state: "reuse", version: 1 } });
  }, 300_000);
  it("a completed review does not block an EDIT of the same version; after the edit the NEW version can be reviewed, and the old version stays «reuse»", async () => {
    const seed = [completedReview(1)];
    const e = await solo(opts(ONE, { seed }), (c) => createEditRequest(c, { missionId: MISSION, userId: ME, version: 1, edit: RENAME as any }));
    expect(e.value).toMatchObject({ ok: true, created: true });
    const doneEdit = { ...addonRowOf({ status: "completed", kind: "edit", base: 1, attempt: 2 }), request_text: "طلب تعديل" };
    const next = await solo(opts(TWO, { seed: [completedReview(1), doneEdit] }), async (c) => ({ v2: await createReviewRequest(c, { missionId: MISSION, userId: ME, version: 2 }), v1: await createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }) }));
    expect(next.value.v2).toMatchObject({ ok: true, created: true });
    expect(next.value.v1).toMatchObject({ ok: false, status: 409 });
  });
  it("an unfinished review (not completed) is NOT a stored report: while it is open nothing new is made, and a cancelled or failed one with no money does not block", async () => {
    const open = await solo(opts(ONE, { seed: [{ ...addonRowOf({ status: "executing", kind: "review", base: 1 }), request_text: "طلب مراجعة" }] }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(open.value).toMatchObject({ ok: false, error: "open_addon" });
    for (const status of ["cancelled", "failed", "unserved"]) {
      const again = await solo(opts(ONE, { seed: [{ ...addonRowOf({ status, kind: "review", base: 1 }), request_text: "طلب مراجعة" }] }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
      expect(again.value, status).toMatchObject({ ok: true, created: true });
      expect(again.out.rows.get(addonId(MISSION, 1, 2)), "the next attempt number: a new id").toBeTruthy();
    }
  });
  it("DOCUMENTED UNRESOLVED RISK (money): a review that was CHARGED but could not be published ends `failed` (error `charged_not_published`, a job and a charge exist); `failed` does not block, so the customer can be offered, and can approve, a SECOND paid review of the same version. The rule is not in canCreateAddon (it sees the status only)", async () => {
    const chargedUnpublished = { ...addonRowOf({ status: "failed", kind: "review", base: 1 }), request_text: "طلب مراجعة", job_id: "job_quote_x", error: "charged_not_published", charged_points: 100 };
    const second = await solo(opts(ONE, { seed: [chargedUnpublished] }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 1 }));
    expect(second.value, "a second paid request IS offered").toMatchObject({ ok: true, created: true });
    expect(openRows(second.out.rows)).toHaveLength(1);
  });
  it("reading a request never creates one: the preview and the pages are read-only (no insert, no update) and make no row", async () => {
    const seed = [completedReview(1)];
    const r = await solo(opts(ONE, { seed }), async (c) => { await reviewQuoteFor(c, { missionId: MISSION, userId: ME, version: 1 }); await currentReviewRequest(c, { missionId: MISSION, userId: ME }); await currentEditRequest(c, { missionId: MISSION, userId: ME }); return null; });
    expect([...r.out.rows.values()].map((x) => x.id).sort()).toEqual([MISSION, addonId(MISSION, 1, 1)].sort());
    noMoney(r.out);
  });
});

describe("the walk is real: it covers many orders and every end state is checked", () => {
  it("the explorer reaches both outcomes of the double click (each creator can be the one that made the row)", async () => {
    const winners = new Set<number>();
    await explore([review(1), review(1)], (out) => { winners.add([told(out, 0), told(out, 1)].findIndex((t) => t.ok && t.created)); }, opts(ONE));
    expect([...winners].sort()).toEqual([0, 1]);
  }, 300_000);
  it("a single run with the default choices finishes (the scheduler is not stuck)", async () => {
    const out = await runSchedule([review(1), edit(1)], [], opts(ONE));
    expect(out.results.every((r) => r.ok)).toBe(true);
    expect([...out.rows.values()].filter(isOpenAddon)).toHaveLength(1);
  });
});
