import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addonId, approveAddonOnce, readAddonPlan } from "../src/lib/agentMission/addonSettlement";
import { ADDON_CREATE_REFUSALS_AR, buildAddonRow, canCreateAddon, createAddonRow, isAddonRow, nextAttempt, type AddonRequest, type AddonRowInsert, type AddonRowLike, type AddonRowStore } from "../src/lib/agentMission/stage4/addonRow";
import { editPricing, fakeAddonWorld, reviewPricing, USER } from "./helpers/addonWorld";

/**
 * MONEY PR 7a, PHASE 2A: THE ADD-ON ROW (docs/MONEY-PR-7A.md section 3.0, decisions D10 and D11). Pure rules over a memory store: one open add-on per file, an edit on the latest version only, a second review of
 * the same version is free, and a deterministic id so a double click makes ONE row. Nothing is held or charged by creating a row: the money starts at approval.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => vi.unstubAllGlobals());

const MISSION = "msn_5851abc92a1e6645a9cd";
const EDIT: AddonRequest = { kind: "edit", edit: { kind: "add_column", sheet: "الفيديوهات", titleAr: "عدد المشاهدات", rowIds: ["r1", "r2"] } };
const REVIEW: AddonRequest = { kind: "review" };
function memoryStore(initial: Array<AddonRowLike & { user_id?: string }> = []) {
  const rows = new Map<string, AddonRowLike & { user_id?: string; request_text?: string }>(initial.map((r) => [r.id, r]));
  const store: AddonRowStore = {
    listFor: async (of) => [...rows.values()].filter((r) => (r.plan as any)?.addon?.of === of),
    insert: async (row: AddonRowInsert) => { if (rows.has(row.id)) return { ok: false, duplicate: true }; rows.set(row.id, { ...row }); return { ok: true }; },
  };
  return { rows, store };
}
const create = (store: AddonRowStore, over: Partial<Parameters<typeof createAddonRow>[1]> = {}) =>
  createAddonRow(store, { userId: USER, of: MISSION, kind: "edit", baseVersion: 1, latestVersion: 1, request: EDIT, pricing: editPricing(2, 0.0005), requestText: "ضيف عمود عدد المشاهدات", ...over });

describe("creating an add-on row", () => {
  it("a priced edit on the latest version: a plan_ready row with the deterministic id, version 2 as its new version, the pricing and the request", async () => {
    const { rows, store } = memoryStore();
    const out = await create(store);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.row.id).toBe(addonId(MISSION, 1, 1));
    expect(out.row).toMatchObject({ user_id: USER, status: "plan_ready", request_text: "ضيف عمود عدد المشاهدات" });
    expect(readAddonPlan(out.row.plan)).toMatchObject({ kind: "edit", of: MISSION, baseVersion: 1, newVersion: 2, attempt: 1, request: EDIT });
    expect(rows.size).toBe(1);
    expect(isAddonRow(out.row)).toBe(true);
    expect(isAddonRow({ plan: { stages: [] } })).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("a review makes no version: its new version is null", async () => {
    const { store } = memoryStore();
    const out = await create(store, { kind: "review", request: REVIEW, pricing: reviewPricing(2500), requestText: "راجع الملف" });
    expect(out.ok && readAddonPlan(out.row.plan)).toMatchObject({ kind: "review", newVersion: null });
  });
  it("a double click makes ONE row: the second creation computes the same id, the store refuses it, and the answer is the open add-on", async () => {
    const { rows, store } = memoryStore();
    const [a, b] = await Promise.all([create(store), create(store)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const lost = [a, b].find((x) => !x.ok)!;
    expect(lost).toMatchObject({ ok: false, reason: "open_addon", existingId: addonId(MISSION, 1, 1), messageAr: ADDON_CREATE_REFUSALS_AR.open_addon });
    expect(rows.size).toBe(1);
  });
  it("one OPEN add-on per file (D10): while one is plan_ready, approved or executing, no other is made, whatever its kind", async () => {
    for (const status of ["plan_ready", "approved", "executing", "queued"]) {
      const first = buildAddonRow({ userId: USER, of: MISSION, kind: "edit", baseVersion: 1, attempt: 1, request: EDIT, pricing: editPricing(2, 0.0005), requestText: "ضيف عمود" });
      const { rows, store } = memoryStore([{ ...first, status }]);
      for (const kind of ["review", "edit"] as const) {
        const out = await create(store, { kind, request: kind === "review" ? REVIEW : EDIT, pricing: kind === "review" ? reviewPricing(100) : editPricing(2, 0.0005) });
        expect(out).toMatchObject({ ok: false, reason: "open_addon", existingId: first.id });
      }
      expect(rows.size).toBe(1);
    }
  });
  it("an ended add-on (cancelled, failed, unserved) frees the file: the next attempt has a NEW id", async () => {
    for (const status of ["cancelled", "failed", "unserved"]) {
      const first = buildAddonRow({ userId: USER, of: MISSION, kind: "edit", baseVersion: 1, attempt: 1, request: EDIT, pricing: editPricing(2, 0.0005), requestText: "ضيف عمود" });
      const { store } = memoryStore([{ ...first, status }]);
      const out = await create(store);
      expect(out.ok && out.row.id).toBe(addonId(MISSION, 1, 2));
      expect(addonId(MISSION, 1, 2)).not.toBe(first.id);
    }
  });
  it("a completed edit of version 1 is not edited again (it would fork the line); the edit goes on version 2 with its own attempt count", async () => {
    const first = buildAddonRow({ userId: USER, of: MISSION, kind: "edit", baseVersion: 1, attempt: 1, request: EDIT, pricing: editPricing(2, 0.0005), requestText: "ضيف عمود" });
    const { store } = memoryStore([{ ...first, status: "completed" }]);
    expect(await create(store, { baseVersion: 1, latestVersion: 2 })).toMatchObject({ ok: false, reason: "not_latest_version" });
    expect(await create(store, { baseVersion: 1, latestVersion: 1 })).toMatchObject({ ok: false, reason: "already_edited" });
    const next = await create(store, { baseVersion: 2, latestVersion: 2 });
    expect(next.ok && next.row.id).toBe(addonId(MISSION, 2, 1));
    expect(next.ok && readAddonPlan(next.row.plan)).toMatchObject({ baseVersion: 2, newVersion: 3 });
  });
  it("a second review of the same version is free (D11): refused with the first review's id, no row; a review of another version is a new add-on", async () => {
    const rev = buildAddonRow({ userId: USER, of: MISSION, kind: "review", baseVersion: 1, attempt: 1, request: REVIEW, pricing: reviewPricing(2500), requestText: "راجع الملف" });
    const { rows, store } = memoryStore([{ ...rev, status: "completed" }]);
    const again = await create(store, { kind: "review", request: REVIEW, pricing: reviewPricing(2500), requestText: "راجع الملف" });
    expect(again).toMatchObject({ ok: false, reason: "review_exists", existingId: rev.id, messageAr: ADDON_CREATE_REFUSALS_AR.review_exists });
    expect(rows.size).toBe(1);
    const other = await create(store, { kind: "review", baseVersion: 2, latestVersion: 2, request: REVIEW, pricing: reviewPricing(2500), requestText: "راجع الملف" });
    expect(other.ok).toBe(true);
  });
  it("a review and then an edit of the SAME version get different ids (the attempt counts every add-on of the version, not only the ended ones)", async () => {
    const rev = buildAddonRow({ userId: USER, of: MISSION, kind: "review", baseVersion: 1, attempt: 1, request: REVIEW, pricing: reviewPricing(2500), requestText: "راجع الملف" });
    const { store } = memoryStore([{ ...rev, status: "completed" }]);
    const out = await create(store);
    expect(out.ok && out.row.id).toBe(addonId(MISSION, 1, 2));
    expect(out.ok && out.row.id).not.toBe(rev.id);
    expect(nextAttempt([{ ...rev, status: "completed" }], MISSION, 1)).toBe(2);
    expect(nextAttempt([{ ...rev, status: "completed" }], MISSION, 2)).toBe(1);
    expect(nextAttempt([{ ...rev, status: "completed" }], "msn_other", 1)).toBe(1);
  });
  it("an edit or a fix is made on the latest version only; a version that does not exist is refused", () => {
    expect(canCreateAddon({ rows: [], of: MISSION, kind: "edit", baseVersion: 1, latestVersion: 2 })).toMatchObject({ ok: false, reason: "not_latest_version" });
    expect(canCreateAddon({ rows: [], of: MISSION, kind: "review_fix", baseVersion: 1, latestVersion: 2 })).toMatchObject({ ok: false, reason: "not_latest_version" });
    expect(canCreateAddon({ rows: [], of: MISSION, kind: "review", baseVersion: 1, latestVersion: 2 })).toMatchObject({ ok: true, attempt: 1 });
    expect(canCreateAddon({ rows: [], of: MISSION, kind: "review", baseVersion: 3, latestVersion: 2 })).toMatchObject({ ok: false });
  });
  it("refused with no insert: row removal, a request that is not the kind, a hold over 5,000 points, a price that is not what the code computes", async () => {
    const { rows, store } = memoryStore();
    expect(await create(store, { request: { kind: "remove_rows" } as any })).toMatchObject({ ok: false, reason: "row_removal_not_offered", messageAr: ADDON_CREATE_REFUSALS_AR.row_removal_not_offered });
    expect(await create(store, { request: REVIEW })).toMatchObject({ ok: false, reason: "bad_request" });
    expect(await create(store, { pricing: editPricing(10_000, 0.0001) })).toMatchObject({ ok: false, reason: "too_large" });
    expect(await create(store, { pricing: { ...editPricing(2, 0.0005), holdPoints: 101 } })).toMatchObject({ ok: false, reason: "plan_changed" });
    expect(rows.size).toBe(0);
  });
  it("buildAddonRow refuses words that are too short and a request that does not match its kind", () => {
    expect(() => buildAddonRow({ userId: USER, of: MISSION, kind: "edit", baseVersion: 1, attempt: 1, request: EDIT, pricing: editPricing(2, 0.0005), requestText: "ا" })).toThrow();
    expect(() => buildAddonRow({ userId: USER, of: MISSION, kind: "edit", baseVersion: 1, attempt: 1, request: REVIEW, pricing: editPricing(2, 0.0005), requestText: "ضيف عمود" })).toThrow();
  });
  it("the row it makes is the row the approval accepts (a round trip on the money world): approved, one reserve row", async () => {
    const { store, rows } = memoryStore();
    const out = await create(store);
    if (!out.ok) throw new Error("not ok");
    const w = fakeAddonWorld({ balance: 5000 });
    w.missions.set(out.row.id, { ...out.row } as any);
    const approved = await approveAddonOnce(w.client, { id: out.row.id, actorId: USER, expectUserId: USER });
    expect(approved).toMatchObject({ ok: true, kind: "edit" });
    expect(w.ledger.filter((r) => r.type === "reserve")).toHaveLength(1);
    expect(rows.size).toBe(1);
  });
});
