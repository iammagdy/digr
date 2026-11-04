import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { reviewCellsOf } from "../src/lib/agentMission/stage4/review";
import { firstVersionFromCells, versionPathOf, type FileVersion } from "../src/lib/agentMission/stage4/versions";
import { runAddonSafely } from "../agent/src/stage4/runAddon";
import { ADDON_DONE_AR } from "../agent/src/stage4/addonText";
import { checkAddonLedger, reviewPricing } from "./helpers/addonWorld";
import { M12, M14, addonRunWorld } from "./helpers/addonRunWorld";

/**
 * MONEY PR 7a, PHASE 2B-1: THE PAID REVIEW ON THE WORKER (docs/MONEY-PR-7A.md sections 3.1 and 4), end to end on the stored real worlds of M12 and M14: the approval holds the exact price P, the worker reviews the base version (no provider
 * call, no model), stores the report PENDING, settles (res -P, rel +P, chg -P) and only then publishes reviews/r0001.json, once. The base version is never touched and no version is written.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => vi.unstubAllGlobals());
const events = (w: Awaited<ReturnType<typeof addonRunWorld>>, id: string) => w.store.events.filter((e) => e.mission_id === id).map((e) => e.message_ar);

for (const [label, world, mission] of [["M12 (TikTok)", "m12", M12], ["M14 (X)", "m14", M14]] as const) {
  describe(`a paid review of ${label}`, () => {
    it("res -P, rel +P, chg -P; the balance is B - P; the report is published once; the base version and its digest are unchanged; no version is written; no provider call", async () => {
      const w = await addonRunWorld({ world, balance: 10_000 });
      const cells = reviewCellsOf(w.v1);
      const pricing = reviewPricing(cells);
      const P = pricing.holdPoints;
      const a = await w.createApproved({ kind: "review", request: { kind: "review" }, pricing, requestText: "راجع الملف" });
      expect(a.hold).toBe(P);
      expect(w.money.balance()).toBe(10_000 - P);
      const stored = await w.store.getFile(mission, versionPathOf(1));
      await runAddonSafely(w.deps, a.row);
      expect(checkAddonLedger(w.money, a.jobId, { reserved: P, charged: P })).toEqual([]);
      expect(w.money.ledger.map((r) => r.type)).toEqual(["topup", "reserve", "release", "charge"]);
      expect(w.money.balance()).toBe(10_000 - P);
      expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "completed", charged_credits: P });
      expect(w.call).not.toHaveBeenCalled();
      expect(w.providerRows).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      // the base version is the same object, the same digest; the only version object is still v0001
      expect(await w.store.getFile(mission, versionPathOf(1))).toBe(stored);
      expect(JSON.parse(stored!).digest).toBe(w.v1.digest);
      expect(w.versionFiles()).toEqual([`${mission}/versions/v0001.json`]);
      // the report: pending first, published once, the same bytes
      expect(w.reviewFiles()).toEqual([`${mission}/reviews/r0001.json`]);
      const pending = await w.store.getFileBytes(mission, `addons/${a.id}/review.json`);
      const published = await w.store.getFileBytes(mission, "reviews/r0001.json");
      expect(published!.equals(pending!)).toBe(true);
      const report = JSON.parse(published!.toString("utf8"));
      expect(report).toMatchObject({ v: 1, addonId: a.id, missionId: mission, version: 1, baseDigest: w.v1.digest, cells });
      expect(report.score).toBeGreaterThanOrEqual(0);
      expect(report.score).toBeLessThanOrEqual(100);
      expect(Array.isArray(report.reportAr)).toBe(true);
      // the add-on row ends completed, with what was charged, and the customer is told in Arabic
      expect(w.rowOf(a.id)).toMatchObject({ status: "completed", charged_points: P, delivered_units: 1, worker_id: null, lease_until: null });
      const said = events(w, a.id);
      expect(said).toContain(ADDON_DONE_AR.reviewDone(P));
      for (const s of said) expect(checkCustomerText(s).issues).toEqual([]);
    });
  });
}

describe("the price of a bigger review", () => {
  it("1 point per 100 cells: a file of 50,000 cells is held, then charged, 500 points", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => Array.from({ length: 10 }, (_, j) => (j === 9 ? `r${i + 1}` : `v${i}_${j}`)));
    const big: FileVersion = firstVersionFromCells({ missionId: M12, cells: { "ورقة": [[...Array.from({ length: 9 }, (_, j) => `عمود ${j}`), "المعرّف"], ...rows] }, createdAt: "2026-11-04T09:00:00.000Z" });
    const w = await addonRunWorld({ balance: 10_000, version: big });
    const cells = reviewCellsOf(big);
    expect(cells).toBe(45_000);
    const pricing = reviewPricing(cells);
    expect(pricing.holdPoints).toBe(450);
    const a = await w.createApproved({ kind: "review", request: { kind: "review" }, pricing });
    await runAddonSafely(w.deps, a.row);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: 450, charged: 450 })).toEqual([]);
    expect(w.money.balance()).toBe(10_000 - 450);
  });
});

describe("a review that cannot be made, and a second review of the same version", () => {
  it("the base version is missing: the whole hold comes back, no charge, no report, the customer is told", async () => {
    const w = await addonRunWorld({ balance: 5000 });
    const pricing = reviewPricing(reviewCellsOf(w.v1));
    const a = await w.createApproved({ kind: "review", request: { kind: "review" }, pricing });
    w.store.files.delete(`${M12}/${versionPathOf(1)}`);
    await runAddonSafely(w.deps, a.row);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: pricing.holdPoints, charged: "none" })).toEqual([]);
    expect(w.money.balance()).toBe(5000);
    expect(w.reviewFiles()).toEqual([]);
    expect(w.rowOf(a.id)).toMatchObject({ status: "unserved", charged_points: 0 });
    expect(events(w, a.id)).toContain(ADDON_DONE_AR.reviewFailed);
  });
  it("the cells of the version are not the cells the review was priced on: released, no charge", async () => {
    const w = await addonRunWorld({ balance: 5000 });
    const a = await w.createApproved({ kind: "review", request: { kind: "review" }, pricing: reviewPricing(reviewCellsOf(w.v1) + 500_000) });
    await runAddonSafely(w.deps, a.row);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: "none" })).toEqual([]);
    expect(w.reviewFiles()).toEqual([]);
  });
  it("a second review of the same version never charges again: the first report stands, the second add-on is released whole", async () => {
    const w = await addonRunWorld({ balance: 5000 });
    const pricing = reviewPricing(reviewCellsOf(w.v1));
    const first = await w.createApproved({ kind: "review", request: { kind: "review" }, pricing });
    await runAddonSafely(w.deps, first.row);
    const report = await w.store.getFile(M12, "reviews/r0001.json");
    const second = await w.createApproved({ kind: "review", request: { kind: "review" }, pricing, attempt: 2 });
    await runAddonSafely(w.deps, second.row);
    expect(checkAddonLedger(w.money, first.jobId, { reserved: pricing.holdPoints, charged: pricing.holdPoints })).toEqual([]);
    expect(checkAddonLedger(w.money, second.jobId, { reserved: pricing.holdPoints, charged: "none" })).toEqual([]);
    expect(w.money.balance()).toBe(5000 - pricing.holdPoints);
    expect(await w.store.getFile(M12, "reviews/r0001.json")).toBe(report);
    expect(w.reviewFiles()).toEqual([`${M12}/reviews/r0001.json`]);
    expect(w.rowOf(second.id)).toMatchObject({ status: "unserved", charged_points: 0 });
    expect(events(w, second.id)).toContain(ADDON_DONE_AR.reviewExists);
  });
  it("running a finished add-on again changes nothing (a stale copy of the row is read fresh)", async () => {
    const w = await addonRunWorld({ balance: 5000 });
    const a = await w.createApproved({ kind: "review", request: { kind: "review" }, pricing: reviewPricing(reviewCellsOf(w.v1)) });
    await runAddonSafely(w.deps, a.row);
    const ledger = JSON.stringify(w.money.ledger);
    const files = [...w.store.files.keys()].length;
    await runAddonSafely(w.deps, { ...a.row, status: "executing" });
    expect(JSON.stringify(w.money.ledger)).toBe(ledger);
    expect([...w.store.files.keys()].length).toBe(files);
  });
});
