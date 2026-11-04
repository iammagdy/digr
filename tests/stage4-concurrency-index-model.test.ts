import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addonId } from "../src/lib/agentMission/addonSettlement";
import { buildAddonRow, ENDED_STATUSES, OPEN_STATUSES } from "../src/lib/agentMission/stage4/addonRow";
import { createSupabaseAddonRowStore } from "../src/lib/agentMission/stage4/addonRowStore";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { createEditRequest, parseEditInput } from "../src/lib/agentMission/stage4/editRequest";
import { createReviewRequest } from "../src/lib/agentMission/stage4/reviewRequest";
import { addonRows, explore, INDEX_CONSTRAINT, isOpenAddon, openRows, PK_CONSTRAINT, runSchedule, solo, type Maker, type Out, type Row, type SchedOpts } from "./helpers/scheduledWorld";
import { objectsOf, sizedVersion } from "./helpers/reviewQuoteWorld";
import { reviewPricing } from "./helpers/addonWorld";

/**
 * STAGE E, PART 3: A MODEL OF THE PROPOSED PARTIAL UNIQUE INDEX (docs/MONEY-PR-7A.md section 17.5, reviewed in docs/STAGE-4-CONCURRENCY.md). NOTHING IS APPLIED: no migration was written, nothing under supabase/ changed, no database was touched. The scheduled world of
 * tests/helpers/scheduledWorld.ts can enforce the index's semantics (`uniqueOpenIndex`): one OPEN add-on row per `plan->'addon'->>'of'`, a violation is code 23505 naming the index. The REAL creators then run over it in every order, to prove WHAT THE INDEX WOULD GUARANTEE and WHAT THE INSERT PATH
 * WOULD NEED. A disposable local Postgres was NOT available in this environment (no postgres binaries; docker has no daemon), so the index itself was not run on a real engine: this is a model, and the docs say so.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => vi.unstubAllGlobals());

const MISSION = "msn_5851abc92a1e6645a9cd";
const ME = "u-1";
const SHEET = "الورقة";
const MISSION_ROW = { id: MISSION, user_id: ME, status: "completed", plan: { stages: [] }, delivered_units: 60 };
const RENAME = parseEditInput({ kind: "rename_column", sheet: SHEET, from: "عمود 1", to: "الاسم الجديد" });
if (!RENAME.ok) throw new Error("fixture");
let TWO: Record<string, string>; let ONE: Record<string, string>;
beforeAll(() => {
  const v1 = sizedVersion(6, 3);
  const r = applyEditRequest(v1, { kind: "rename_column", sheet: SHEET, from: "عمود 3", to: "عمود ثالث" }, { createdAt: "2026-11-03T09:30:00.000Z" });
  if (!r.ok) throw new Error(r.reason);
  ONE = objectsOf(v1); TWO = objectsOf(v1, r.version);
});
const opts = (objects: Record<string, string>, more: Partial<SchedOpts> = {}): SchedOpts => ({ objects, uniqueOpenIndex: true, ...more, seed: [MISSION_ROW, ...(more.seed ?? [])] });
const review = (version: number): Maker => async (a) => createReviewRequest(a.client, { missionId: MISSION, userId: ME, version });
const edit = (version: number): Maker => async (a) => createEditRequest(a.client, { missionId: MISSION, userId: ME, version, edit: RENAME as any });
type Told = { ok: true; created: boolean; request: { id: string } } | { ok: false; status: number; error: string };
const told = (out: Out, i: number): Told => { const r = out.results[i]; if (!r.ok) throw r.error; return r.value as Told; };
const reviewRow = (base: number, status = "plan_ready", over: Record<string, unknown> = {}): Row => ({ ...buildAddonRow({ userId: ME, of: MISSION, kind: "review", baseVersion: base, attempt: 1, request: { kind: "review" }, pricing: reviewPricing(1000), requestText: "طلب مراجعة الملف" }), status, job_id: null, approved_at: null, ...over });

describe("WHAT THE INDEX GUARANTEES: two open requests on one file can NEVER exist, at ANY step, in ANY order, with ANY failure", () => {
  it("the end state that scenario 5 shows without the index (the creator goes dark after its insert) cannot occur: at no step are two requests open; the creator whose insert is refused is told «open request»", async () => {
    let refused = 0;
    const { runs } = await explore([review(1), review(2)], (out) => {
      expect(out.world.maxOpen, "never two open at any step").toBeLessThanOrEqual(1);
      expect(openRows(out.rows).length).toBeLessThanOrEqual(1);
      for (const i of [0, 1]) { const t = told(out, i); if (!t.ok && t.status === 409) { refused += 1; expect(t.error).toBe("open_addon"); } }
      expect(out.money.calls).toEqual([]);
    }, opts(TWO, { fault: (i) => i.client === 1 && i.inserted }));
    expect(runs).toBeGreaterThan(50);
    expect(refused, "the refused creator is told in some orders").toBeGreaterThan(0);
  }, 300_000);
  it("the same without any failure, for review/review, review/edit and edit/edit: never two open at any step; exactly one stays", async () => {
    for (const [a, b, objects] of [[review(1), review(2), TWO], [review(1), edit(2), TWO], [review(1), edit(1), ONE], [edit(1), edit(1), ONE]] as const) {
      await explore([a, b], (out) => {
        expect(out.world.maxOpen).toBeLessThanOrEqual(1);
        expect(openRows(out.rows)).toHaveLength(1);
      }, opts(objects));
    }
  }, 300_000);
  it("the creation protocol no longer ever CANCELS a request another creator was told is ready: the loser's insert is simply refused (the «told ready, then cancelled» risk of scenario 1 disappears)", async () => {
    let toldOkButGone = 0;
    await explore([review(1), review(2)], (out) => {
      for (const i of [0, 1]) { const t = told(out, i); if (t.ok && !openRows(out.rows).some((r) => r.id === t.request.id)) toldOkButGone += 1; }
      for (const r of addonRows(out.rows)) expect(r.status, "nobody was cancelled by a repair").not.toBe("cancelled");
    }, opts(TWO));
    expect(toldOkButGone).toBe(0);
  }, 300_000);
  it("three creators (a review of v1, a review of v2, an edit of v2), 400 seeded random orders, with and without a blackout: never two open at any step", async () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let k = 0; k < 400; k += 1) {
      const out = await runSchedule([review(1), review(2), edit(2)], Array.from({ length: 80 }, rnd), opts(TWO, k % 2 ? { fault: (i) => i.client === 2 && i.inserted } : {}));
      expect(out.world.maxOpen, `run ${k}`).toBeLessThanOrEqual(1);
    }
  }, 300_000);
  it("an approval can then never meet two open requests: with only one open row per file, the unguarded `approveAddonOnce` of scenario 3 can start at most one add-on", async () => {
    const approved = new Set<string>();
    await explore([review(1), review(2)], (out) => { for (const r of openRows(out.rows)) approved.add(r.id); expect(openRows(out.rows).length).toBeLessThanOrEqual(1); }, opts(TWO, { fault: (i) => i.client === 1 && i.inserted }));
    expect(approved.size).toBeGreaterThan(0);
  }, 300_000);
});

describe("WHAT THE INSERT PATH NEEDS: the primary key and the index are BOTH 23505", () => {
  const solid = (over: Partial<SchedOpts> = {}) => opts(TWO, over);
  const insertOf = (base: number, kind: "review" = "review") => buildAddonRow({ userId: ME, of: MISSION, kind, baseVersion: base, attempt: 1, request: { kind: "review" }, pricing: reviewPricing(1000), requestText: "طلب مراجعة الملف" });
  /** What a better `AddonRowStore.insert` would say: which of the two constraints refused. PostgREST puts the constraint's name in `message` («duplicate key value violates unique constraint "<name>"»). */
  const classify = (error: { code?: string; message?: string } | null): "ok" | "same_id" | "other_open" | "failed" => {
    if (!error) return "ok";
    if (String(error.code) !== "23505") return "failed";
    const m = String(error.message);
    return m.includes(`"${PK_CONSTRAINT}"`) ? "same_id" : m.includes(`"${INDEX_CONSTRAINT}"`) ? "other_open" : "failed";
  };
  it("TODAY'S store reports BOTH as `duplicate: true` and cannot tell them apart; the raw errors DO differ by constraint name, so the information is there to be used", async () => {
    const { value } = await solo(solid(), async (client) => {
      const store = createSupabaseAddonRowStore(client, ME);
      const first = await store.insert(insertOf(1));
      const samePk = await store.insert(insertOf(1));
      const otherOpen = await store.insert(insertOf(2));
      const raw = async (row: unknown) => (await client.from("missions").insert(row)).error;
      return { first, samePk, otherOpen, rawPk: await raw(insertOf(1)), rawIndex: await raw(insertOf(2)) };
    });
    expect(value.first).toEqual({ ok: true });
    expect(value.samePk).toEqual({ ok: false, duplicate: true });
    expect(value.otherOpen).toEqual({ ok: false, duplicate: true });
    expect([classify(value.rawPk), classify(value.rawIndex)]).toEqual(["same_id", "other_open"]);
    expect(value.rawPk.code).toBe("23505"); expect(value.rawIndex.code).toBe("23505");
  });
  it("WHEN BOTH APPLY (the same click twice) the engine reports the FIRST unique index it checks; which one that is depends on index order, so the code must not assume it: on this model the primary key is checked first", async () => {
    const { value } = await solo(solid(), async (client) => { await client.from("missions").insert(insertOf(1)); return (await client.from("missions").insert(insertOf(1))).error; });
    expect(classify(value)).toBe("same_id");
  });
  it("TODAY'S createAddonRow already gives the right customer-facing answer for a violation of the index: `open_addon` (it names its own id, which does not exist, so the caller finds no waiting request for it); the caller's «same click» branch finds the keeper only when ids coincide", async () => {
    const { value } = await solo(solid({ seed: [reviewRow(2)] }), (client) => createReviewRequest(client, { missionId: MISSION, userId: ME, version: 1 }));
    expect(value).toMatchObject({ ok: false, status: 409, error: "open_addon" });
  });
  it("THE CHANGE, specified (NOT made): `AddonRowStore.insert` returns `{ ok: false, duplicate: true, by: \"same_id\" | \"other_open\" }` from the constraint name; `createAddonRow` then (a) `same_id`: as today (the first click's row is the answer, existingId = row.id); (b) `other_open`: RE-LIST the file's open add-ons and refuse with `open_addon` and the id of the one that stays (the lowest-id rule is no longer needed to decide who stays: the database decided), so the page always names a request that exists, even if the engine's index order flips; (c) any other failure: throw. Modelled here as a test-local wrapper", async () => {
    // a store that classifies, over the model
    const classified = (client: any) => {
      const base = createSupabaseAddonRowStore(client, ME);
      return { ...base, async insert(row: any) { const { error } = await client.from("missions").insert(row); const c = classify(error); return c === "ok" ? { ok: true as const } : c === "failed" ? { ok: false as const, duplicate: false, by: c } : { ok: false as const, duplicate: true, by: c }; } };
    };
    const { value } = await solo(solid({ seed: [reviewRow(2)] }), async (client) => {
      const store = classified(client);
      const attempt = await store.insert(insertOf(1));
      // (b): the refused creator re-lists and names the one that stays
      const open = (await store.listFor(MISSION)).filter((r) => (OPEN_STATUSES as ReadonlyArray<string>).includes(r.status));
      return { attempt, keeper: open.map((r) => r.id) };
    });
    expect(value.attempt).toMatchObject({ ok: false, duplicate: true, by: "other_open" });
    expect(value.keeper).toEqual([addonId(MISSION, 2, 1)]);
  });
  it("the double click on a model whose index is checked FIRST would still be answered correctly by (b): the keeper IS the first click's row, so the second click is shown it (`created: false`) instead of an error", async () => {
    const { value } = await solo(solid(), async (client) => {
      const first = await createReviewRequest(client, { missionId: MISSION, userId: ME, version: 1 });
      const store = createSupabaseAddonRowStore(client, ME);
      const keeper = (await store.listFor(MISSION)).find((r) => r.id === addonId(MISSION, 1, 1))!;
      return { first, keeperIsFirstClicksRow: Boolean(keeper) && keeper.status === "plan_ready" };
    });
    expect(value.first).toMatchObject({ ok: true, created: true });
    expect(value.keeperIsFirstClicksRow).toBe(true);
  });
});

describe("THE INDEX'S SEMANTICS on the model: what holds the slot and what frees it", () => {
  const insert = (client: any, row: Row) => client.from("missions").insert(row);
  it("the six OPEN statuses hold the slot, exactly the statuses of OPEN_STATUSES; the four others free it; the two lists together are every status the table allows", async () => {
    const ALL = ["queued", "planning", "needs_input", "plan_ready", "approved", "executing", "completed", "failed", "unserved", "cancelled"];
    expect([...OPEN_STATUSES, ...ENDED_STATUSES, "completed"].sort()).toEqual([...ALL].sort());
    for (const status of ALL) {
      const { value } = await solo(opts(TWO, { seed: [reviewRow(1, status)] }), async (client) => (await insert(client, reviewRow(2))).error);
      const open = (OPEN_STATUSES as ReadonlyArray<string>).includes(status);
      expect([status, open ? "refused" : "accepted"]).toEqual([status, value ? "refused" : "accepted"]);
      if (value) expect(value.message).toContain(INDEX_CONSTRAINT);
    }
  });
  it("a STARTED request (approved, executing) and a request with an approval mark but back to `plan_ready` keep the slot: no new request while money may be held", async () => {
    for (const row of [reviewRow(1, "approved", { approved_at: "2026-11-04T10:00:00Z", job_id: "job_x" }), reviewRow(1, "executing", { job_id: "job_x" }), reviewRow(1, "plan_ready", { approved_at: "2026-11-04T10:00:00Z" })]) {
      const { value } = await solo(opts(TWO, { seed: [row] }), async (client) => (await insert(client, reviewRow(2))).error);
      expect(classify2(value)).toBe("other_open");
    }
  });
  it("a request that ENDS frees the slot at once (cancel, complete), so the next request is made with the next attempt number", async () => {
    const { value, out } = await solo(opts(ONE), async (client) => {
      const a = await createReviewRequest(client, { missionId: MISSION, userId: ME, version: 1 });
      await client.from("missions").update({ status: "cancelled" }).eq("id", addonId(MISSION, 1, 1));
      const b = await createReviewRequest(client, { missionId: MISSION, userId: ME, version: 1 });
      return { a, b };
    });
    expect(value.a).toMatchObject({ ok: true, created: true });
    expect(value.b).toMatchObject({ ok: true, created: true });
    expect(out.rows.get(addonId(MISSION, 1, 2))!.status).toBe("plan_ready");
    expect(out.world.maxOpen).toBe(1);
  });
  it("the failed-approval REVERT (`approved` -> `plan_ready`) never violates it: open to open; and an UPDATE that would REOPEN an ended row while another is open IS refused (a worker requeue of a failed row cannot create a second open one)", async () => {
    const { value } = await solo(opts(TWO, { seed: [reviewRow(1, "approved", { approved_at: "2026-11-04T10:00:00Z", job_id: "j" }), reviewRow(2, "cancelled")] }), async (client) => {
      const revert = await client.from("missions").update({ status: "plan_ready" }).eq("id", addonId(MISSION, 1, 1));
      const reopen = await client.from("missions").update({ status: "plan_ready" }).eq("id", addonId(MISSION, 2, 1));
      return { revert: revert.error, reopen: reopen.error };
    });
    expect(value.revert).toBeNull();
    expect(value.reopen?.message).toContain(INDEX_CONSTRAINT);
  });
  it("ordinary missions are never constrained: rows with no `addon` key, any number, any status, even with an `of`-like key elsewhere", async () => {
    const ord = (id: string, status: string) => ({ id, user_id: ME, status, plan: { stages: [], of: MISSION }, request_text: "بحث" });
    const { value } = await solo(opts(ONE), async (client) => { const errs = []; for (const [i, s] of ["queued", "plan_ready", "executing", "queued"].entries()) errs.push((await insert(client, ord(`msn_ord${i}aaaaaaaaaaaaaaaa`, s))).error); return errs; });
    expect(value).toEqual([null, null, null, null]);
  });
  it("two different delivered files are independent (the key is the file's own id)", async () => {
    const other = "msn_bbbbbbbbbbbbbbbbbbbb";
    const row = { ...reviewRow(1), id: addonId(other, 1, 1), plan: { addon: { ...(reviewRow(1).plan as any).addon, of: other } } };
    const { value } = await solo(opts(ONE, { seed: [reviewRow(1)] }), async (client) => (await insert(client, row)).error);
    expect(value).toBeNull();
  });
  it("a row with no `of` string is not constrained (NULLs are distinct in a unique index), which is why the migration's key must be checked to be present on every add-on row first", async () => {
    const noOf = (id: string) => ({ id, user_id: ME, status: "plan_ready", plan: { addon: { v: 1, kind: "review" } }, request_text: "طلب" });
    // the model treats a row with no `of` as not an add-on row at all (addonOf is null): the same as the index, whose key is NULL
    const { value } = await solo(opts(ONE), async (client) => [(await insert(client, noOf("msn_n1aaaaaaaaaaaaaaaa"))).error, (await insert(client, noOf("msn_n2aaaaaaaaaaaaaaaa"))).error]);
    expect(value).toEqual([null, null]);
  });
});

describe("THE PRE-MIGRATION CHECK, modelled: the index cannot be built over a table that already has two open requests on one file", () => {
  /** The read-only query the migration needs first (text in docs/STAGE-4-CONCURRENCY.md), as a function over rows. */
  const violations = (rows: Row[]): Array<{ of: string; ids: string[] }> => {
    const per = new Map<string, string[]>();
    for (const r of rows.filter(isOpenAddon)) { const of = String((r.plan as any).addon.of); per.set(of, [...(per.get(of) ?? []), r.id]); }
    return [...per].filter(([, ids]) => ids.length > 1).map(([of, ids]) => ({ of, ids: ids.sort() }));
  };
  it("every end state of scenario 5 (the creator goes dark) is a VIOLATION the check finds; after the existing repair (the next reader) the check is clean, so the repair must run before the index is built", async () => {
    const dark: Row[][] = [];
    await explore([review(1), review(2)], (out) => { if (openRows(out.rows).length === 2) dark.push([...out.rows.values()].filter((r) => r.id !== MISSION).map((r) => JSON.parse(JSON.stringify(r)))); }, { ...opts(TWO, { fault: (i) => i.client === 1 && i.inserted }), uniqueOpenIndex: false });
    expect(dark.length).toBeGreaterThan(0);
    for (const rows of dark) {
      expect(violations(rows)).toHaveLength(1);
      const fixed = await solo({ ...opts(TWO, { seed: rows }), uniqueOpenIndex: false }, (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 2 }));
      expect(violations([...fixed.out.rows.values()])).toEqual([]);
    }
  }, 300_000);
  it("a clean table (at most one open request per file) is not a violation, whatever its history of ended requests", () => {
    expect(violations([reviewRow(1, "completed"), reviewRow(2, "cancelled", { id: addonId(MISSION, 2, 1) }), { ...reviewRow(1, "plan_ready"), id: addonId(MISSION, 1, 2) }])).toEqual([]);
  });
});

/** helper for the status tests */
function classify2(error: { code?: string; message?: string } | null | undefined): string {
  if (!error) return "ok";
  return String(error.message).includes(`"${INDEX_CONSTRAINT}"`) ? "other_open" : String(error.message).includes(`"${PK_CONSTRAINT}"`) ? "same_id" : "failed";
}
