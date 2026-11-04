import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addonId } from "../src/lib/agentMission/addonSettlement";
import { createAddonRow, type AddonRowInsert, type AddonRowLike, type AddonRowStore } from "../src/lib/agentMission/stage4/addonRow";
import { createSupabaseAddonRowStore } from "../src/lib/agentMission/stage4/addonRowStore";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { reviewCard } from "../src/lib/agentMission/stage4/addonQuote";
import { createReviewRequest } from "../src/lib/agentMission/stage4/reviewRequest";
import type { FileVersion } from "../src/lib/agentMission/stage4/versions";
import { INDEX_CONSTRAINT, PK_CONSTRAINT, explore, openRows, solo, type Maker, type Row, type SchedOpts } from "./helpers/scheduledWorld";
import { addonRowOf, objectsOf, sizedVersion } from "./helpers/reviewQuoteWorld";

/**
 * SAFETY ROUND, PR C: THE CLASSIFICATION OF A FAILED INSERT of an add-on row. Three different things come back from the database as «23505»: the SAME request inserted twice (the primary key: `missions_pkey`), a DIFFERENT request blocked by the new one-open-add-on-per-file index
 * (`missions_one_open_addon_per_file`, prepared in supabase/migrations/*_one_open_addon_per_file.sql, NOT applied), and any other unexpected error. The messages used here are the REAL ones, captured from PostgreSQL 16 by scripts/verify/verify-one-open-addon-index.sh.
 * A database error is never success: only `{ ok: true }` creates a request. FAKE CLIENTS ONLY.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const MISSION = "msn_5851abc92a1e6645a9cd";
const ME = "u-1";
/** The text PostgreSQL 16 (and so PostgREST) answers, from the verification transcript. */
const PG_PK = { code: "23505", message: 'duplicate key value violates unique constraint "missions_pkey"', details: "Key (id)=(msn_r1aaaaaa) already exists." };
const PG_INDEX = { code: "23505", message: 'duplicate key value violates unique constraint "missions_one_open_addon_per_file"', details: "Key (((plan -> 'addon'::text) ->> 'of'::text))=(msn_fileA) already exists." };

const row = (): AddonRowInsert => addonRowOf({ status: "plan_ready", kind: "review", base: 1 }) as unknown as AddonRowInsert;
const clientWithInsert = (error: unknown) => ({ from: () => ({ insert: async () => ({ error }) }) });

describe("THE STORE classifies the insert's error", () => {
  it("no error: ok", async () => { expect(await createSupabaseAddonRowStore(clientWithInsert(null), ME).insert(row())).toEqual({ ok: true }); });
  it("the PRIMARY KEY (the same request inserted twice): duplicate, by «same_id»", async () => {
    expect(await createSupabaseAddonRowStore(clientWithInsert(PG_PK), ME).insert(row())).toEqual({ ok: false, duplicate: true, by: "same_id" });
  });
  it("the NEW INDEX (a different request of the same file is open): duplicate, by «other_open»", async () => {
    expect(await createSupabaseAddonRowStore(clientWithInsert(PG_INDEX), ME).insert(row())).toEqual({ ok: false, duplicate: true, by: "other_open" });
  });
  it("a 23505 of a constraint nobody here knows is still a duplicate (never success), by «unknown»", async () => {
    expect(await createSupabaseAddonRowStore(clientWithInsert({ code: "23505", message: 'duplicate key value violates unique constraint "some_other_idx"' }), ME).insert(row())).toEqual({ ok: false, duplicate: true, by: "unknown" });
    expect(await createSupabaseAddonRowStore(clientWithInsert({ code: "23505", message: "" }), ME).insert(row())).toEqual({ ok: false, duplicate: true, by: "unknown" });
  });
  it("the message alone (no code) is read the same way: a driver that drops the code does not turn a duplicate into success", async () => {
    expect(await createSupabaseAddonRowStore(clientWithInsert({ message: PG_INDEX.message }), ME).insert(row())).toEqual({ ok: false, duplicate: true, by: "other_open" });
    expect(await createSupabaseAddonRowStore(clientWithInsert({ message: PG_PK.message }), ME).insert(row())).toEqual({ ok: false, duplicate: true, by: "same_id" });
  });
  for (const error of [
    { code: "42501", message: "permission denied for table missions" }, { code: "23514", message: 'new row for relation "missions" violates check constraint "missions_status_check"' }, { code: "23502", message: "null value in column" },
    { code: "40001", message: "could not serialize access" }, { code: "57014", message: "canceling statement due to statement timeout" }, { code: "08006", message: "connection failure" },
    { message: "fetch failed" }, { code: "", message: "" }, "boom",
  ]) {
    it(`any other error (${typeof error === "string" ? error : `${(error as { code?: string }).code ?? "no code"}: ${(error as { message: string }).message.slice(0, 30)}`}) is NOT a duplicate and NOT success`, async () => {
      const r = await createSupabaseAddonRowStore(clientWithInsert(error), ME).insert(row());
      expect(r).toEqual({ ok: false, duplicate: false });
    });
  }
  it("a mention of the index name in an error that is not a unique violation (a missing relation) is not read as a duplicate", async () => {
    expect(await createSupabaseAddonRowStore(clientWithInsert({ code: "42P01", message: 'relation "missions_one_open_addon_per_file" does not exist' }), ME).insert(row())).toEqual({ ok: false, duplicate: false });
  });
});

describe("createAddonRow answers each classification truthfully", () => {
  const card = reviewCard(1000);
  if (!card.ok) throw new Error("fixture card");
  const input = { userId: ME, of: MISSION, kind: "review" as const, baseVersion: 1, latestVersion: 1, request: { kind: "review" as const }, pricing: card.pricing, requestText: "طلب مراجعة" };
  const storeOf = (rows: AddonRowLike[], insert: AddonRowStore["insert"], calls: { inserts: number; cancels: string[] } = { inserts: 0, cancels: [] }): AddonRowStore => ({
    listFor: async () => rows, insert: async (r) => { calls.inserts += 1; return insert(r); }, cancelUnpaid: async (id) => { calls.cancels.push(id); return false; },
  });
  it("«same_id»: the first click's row is the answer (its own id), exactly as before", async () => {
    const out = await createAddonRow(storeOf([], async () => ({ ok: false, duplicate: true, by: "same_id" })), input);
    expect(out).toMatchObject({ ok: false, reason: "open_addon", existingId: addonId(MISSION, 1, 1) });
  });
  it("«other_open»: the database says ANOTHER request of this file is open: the answer is THAT request (read again), never this one's id; one insert, no cancel of a started row", async () => {
    const calls = { inserts: 0, cancels: [] as string[] };
    const other = { id: addonId(MISSION, 2, 1), status: "executing", plan: addonRowOf({ status: "executing", kind: "edit", base: 2 }).plan, job_id: "job_x", approved_at: "2026-11-04T10:00:00.000Z" } as AddonRowLike;
    let listed = 0;
    const store: AddonRowStore = { listFor: async () => (listed++ === 0 ? [] : [other]), insert: async () => { calls.inserts += 1; return { ok: false, duplicate: true, by: "other_open" }; }, cancelUnpaid: async (id) => { calls.cancels.push(id); return false; } };
    const out = await createAddonRow(store, input);
    expect(out).toMatchObject({ ok: false, reason: "open_addon", existingId: other.id });
    expect(calls).toEqual({ inserts: 1, cancels: [] });
  });
  it("«other_open» when the other request has ended again by the time it is read: still a refusal (open_addon, no id); asking again makes the request. It is NEVER success", async () => {
    let listed = 0;
    const store: AddonRowStore = { listFor: async () => (listed++, []), insert: async () => ({ ok: false, duplicate: true, by: "other_open" }), cancelUnpaid: async () => false };
    expect(await createAddonRow(store, input)).toMatchObject({ ok: false, reason: "open_addon" });
  });
  it("«unknown» duplicate: refused as open_addon (never success)", async () => {
    expect(await createAddonRow(storeOf([], async () => ({ ok: false, duplicate: true, by: "unknown" })), input)).toMatchObject({ ok: false, reason: "open_addon" });
  });
  it("any other failure THROWS (the callers answer 503): the request is not made and not reported", async () => {
    await expect(createAddonRow(storeOf([], async () => ({ ok: false, duplicate: false })), input)).rejects.toThrow(/could not be stored/);
  });
});

describe("through createReviewRequest on the model of the proposed index", () => {
  let v1: FileVersion; let v2: FileVersion; let TWO: Record<string, string>;
  beforeAll(() => { v1 = sizedVersion(6, 3); const r = applyEditRequest(v1, { kind: "rename_column", sheet: "الورقة", from: "عمود 3", to: "عمود ثالث" }, { createdAt: "2026-11-03T09:30:00.000Z" }); if (!r.ok) throw new Error(r.reason); v2 = r.version; TWO = objectsOf(v1, v2); });
  const MISSION_ROW = { id: MISSION, user_id: ME, status: "completed", plan: { stages: [] }, delivered_units: 60 };
  const opts = (more: Partial<SchedOpts> = {}): SchedOpts => ({ objects: TWO, ...more, seed: [MISSION_ROW, ...(more.seed ?? [])] });
  const review = (version: number): Maker => async (a) => createReviewRequest(a.client, { missionId: MISSION, userId: ME, version });

  it("a creator whose read missed an open request is stopped by the INDEX: told «you have an open request», nothing is made, nothing is held; the index error carries the index's own name", async () => {
    const open = { ...addonRowOf({ status: "plan_ready", kind: "review", base: 1 }), request_text: "طلب", job_id: null, approved_at: null } as Row;
    const { value, out } = await solo(opts({ seed: [open], uniqueOpenIndex: true, stale: (i) => i.n === 1 }), (c) => createReviewRequest(c, { missionId: MISSION, userId: ME, version: 2 }));
    expect(value).toMatchObject({ ok: false, status: 409, error: "open_addon" });
    expect(openRows(out.rows)).toHaveLength(1);
    expect(out.money.calls).toEqual([]);
  });
  it("two creators of different versions, every order, the index on: at most ONE open request at every step (maxOpen <= 1), and neither creator is told success for a row that does not exist", async () => {
    const { runs } = await explore([review(1), review(2)], (out) => {
      expect(out.world.maxOpen).toBeLessThanOrEqual(1);
      for (const i of [0, 1]) { const r = out.results[i]; if (r.ok && (r.value as { ok: boolean }).ok) expect(out.rows.has((r.value as { request: { id: string } }).request.id)).toBe(true); }
      expect(openRows(out.rows).length).toBeLessThanOrEqual(1);
    }, opts({ uniqueOpenIndex: true }));
    expect(runs).toBeGreaterThan(10);
  });
  it("the constants of the model are the real constraint names", () => { expect([PK_CONSTRAINT, INDEX_CONSTRAINT]).toEqual(["missions_pkey", "missions_one_open_addon_per_file"]); });
});
