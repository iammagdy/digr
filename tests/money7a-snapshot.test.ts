import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ERROR_REQUEUES_MAX } from "../src/lib/agentMission/constants";
import { editCard } from "../src/lib/agentMission/stage4/addonQuote";
import type { AddonRequest } from "../src/lib/agentMission/stage4/addonRow";
import { applyEditCore } from "../src/lib/agentMission/stage4/editCore";
import { reviewCellsOf } from "../src/lib/agentMission/stage4/review";
import { versionPathOf, type FileVersion } from "../src/lib/agentMission/stage4/versions";
import { runAddon, runAddonSafely } from "../agent/src/stage4/runAddon";
import { checkAddonLedger, reviewPricing } from "./helpers/addonWorld";
import { COMMENTS_SHEET, LOOKUP_COST_USD, LOOKUP_ENDPOINT, M12, addonRunWorld } from "./helpers/addonRunWorld";

/**
 * MONEY PR 7a, PHASE 2B-1 SAFETY FIX 1: THE CHARGE MUST MATCH THE STORED VERSION (docs/MONEY-PR-7A.md section 13.6). The work is frozen when its pending version is stored: a retry that finds a pending version builds its settlement
 * snapshot (filled, real cost) FROM THAT OBJECT and from the add-on's recorded calls, never from a newer re-read, and makes no provider call for it. Before the fix a run cut between «pending stored» and «outcome stored» resumed the
 * re-read, collected more values, and wrote an outcome that described MORE values than the version it would publish (putNewStrict said created:false and nobody looked).
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

type World = Awaited<ReturnType<typeof addonRunWorld>>;
const TOOL = { endpointId: LOOKUP_ENDPOINT, params: {}, bind: { param: "uniqueId", from: "صاحب التعليق" }, valueField: "user.nickname" };
const BALANCE = 100_000;
const spent = (w: World) => w.providerRows.reduce((n, r) => n + (r.committedUsd ?? 0), 0);
const chargeBy = (real: number, filled: number, requested: number, hold: number) => Math.min(hold, Math.max(Math.ceil(Math.round(real * 1_000_000) * 5500 / 1_000_000 - 1e-9), Math.ceil((100 * filled) / requested)));
const types = (w: World) => w.money.ledger.map((r) => r.type);

async function commentsEdit(w: World) {
  const rowIds = w.idsOf(COMMENTS_SHEET);
  const card = editCard({ kind: "edit", units: rowIds.length, tools: [{ catalogPerRowUsd: LOOKUP_COST_USD }] });
  if (!card.ok) throw new Error("no card");
  const request: AddonRequest = { kind: "edit", edit: { kind: "add_column", sheet: COMMENTS_SHEET, titleAr: "اسم القناة", rowIds, reread: { tools: [TOOL] } } };
  return w.createApproved({ kind: "edit", request, pricing: card.pricing });
}
type Approved = Awaited<ReturnType<typeof commentsEdit>>;

/** The provider's daily cap, switched on after `n` allowed calls and lifted later: the run before the cut stops with n values, the run after it has all the answers it wants. */
function dailyCapAfter(w: World, n: number) {
  const inner = w.deps.recorder;
  const gate = { on: true, allowed: 0 };
  w.deps.recorder = { ...inner, reserve: async (a) => { if (gate.on && gate.allowed >= n) return { allowed: false, costId: null, reason: "cap" }; const r = await inner.reserve(a); if (r.allowed) gate.allowed += 1; return r; }, commit: inner.commit.bind(inner) } as typeof inner;
  return gate;
}
/** Makes one create-only write throw (the worker's death at that point) and lets it be restored. */
function dieAt(w: World, match: (path: string) => boolean) {
  const put = w.store.putNewStrict.bind(w.store);
  const hold = { on: true };
  w.store.putNewStrict = async (m, p, c, t) => { if (hold.on && match(p)) throw new Error("the worker died"); return put(m, p, c, t); };
  return { restore: () => { hold.on = false; } };
}
const bytes = async (w: World, rel: string) => (await w.store.getFileBytes(M12, rel))!;
const pendingOf = (a: Approved) => `addons/${a.id}/v0002.json`;
const outcomeOf = (a: Approved) => `addons/${a.id}/outcome.json`;
const realValues = (v: FileVersion): number => { const s = v.sheets.find((x) => x.nameAr === COMMENTS_SHEET)!; const at = s.headers.indexOf("اسم القناة"); return s.rows.filter((r) => /^قناة /.test(r.cells[at])).length; };

async function cutAfterPending(w: World, a: Approved, cap: number) {
  const gate = dailyCapAfter(w, cap);
  const death = dieAt(w, (p) => p.endsWith("outcome.json"));
  await expect(runAddon(w.deps, a.row)).rejects.toThrow("the worker died");
  return { gate, death };
}

describe("TEST 1: a partial pending version (20 of 60 real values) and a crash before the outcome", () => {
  it("the retry keeps the frozen 20: no new call, the published version is the pending bytes, the charge is for 20 values and their cost", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const v1bytes = await bytes(w, versionPathOf(1));
    const { gate, death } = await cutAfterPending(w, a, 20);
    // the state the crash left: 20 calls paid, a pending version with 20 real values, NO outcome, nothing published, the hold only
    expect(w.call).toHaveBeenCalledTimes(20);
    expect(await w.store.getFile(M12, outcomeOf(a))).toBeNull();
    const frozen = await bytes(w, pendingOf(a));
    expect(realValues(JSON.parse(frozen.toString("utf8")))).toBe(20);
    expect(types(w)).toEqual(["topup", "reserve"]);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);

    // the provider now has all the answers anyone wants, and the cap is lifted
    gate.on = false;
    death.restore();
    w.expireLease(a.id);
    await runAddonSafely(w.deps, await w.reclaim());

    expect(w.call).toHaveBeenCalledTimes(20);
    expect((await bytes(w, pendingOf(a))).equals(frozen)).toBe(true);
    expect((await bytes(w, versionPathOf(2))).equals(frozen)).toBe(true);
    expect((await bytes(w, versionPathOf(1))).equals(v1bytes)).toBe(true);
    const outcome = JSON.parse((await w.store.getFile(M12, outcomeOf(a)))!);
    expect(outcome).toMatchObject({ filled: 20, requested: 60, pending: pendingOf(a), publishAt: "versions/v0002.json" });
    expect(outcome.realCostUsd).toBeCloseTo(20 * LOOKUP_COST_USD, 9);
    const C = chargeBy(spent(w), 20, 60, a.hold);
    expect(C).toBe(110);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: C })).toEqual([]);
    expect(w.money.balance()).toBe(BALANCE - C);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", delivered_units: 20, charged_points: C });
  });
});

describe("TEST 2: the same cut, several restarts at the pending / outcome boundary", () => {
  it("one reserve, one release, one charge; the pending bytes and the outcome never change; no spending after the freeze", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const { gate, death } = await cutAfterPending(w, a, 20);
    const frozen = await bytes(w, pendingOf(a));
    gate.on = false;
    for (let i = 0; i < 3; i += 1) {
      w.expireLease(a.id);
      await expect(runAddon(w.deps, await w.reclaim())).rejects.toThrow("the worker died");
      expect((await bytes(w, pendingOf(a))).equals(frozen)).toBe(true);
      expect(w.call).toHaveBeenCalledTimes(20);
      expect(types(w)).toEqual(["topup", "reserve"]);
      expect(await w.store.getFile(M12, outcomeOf(a))).toBeNull();
    }
    death.restore();
    w.expireLease(a.id);
    await runAddonSafely(w.deps, await w.reclaim());
    const outcome = await w.store.getFile(M12, outcomeOf(a));
    // a later run changes nothing at all
    w.expireLease(a.id);
    await runAddonSafely(w.deps, w.rowOf(a.id));
    expect(await w.store.getFile(M12, outcomeOf(a))).toBe(outcome);
    expect(types(w)).toEqual(["topup", "reserve", "release", "charge"]);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: 110 })).toEqual([]);
    expect(w.call).toHaveBeenCalledTimes(20);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`, `${M12}/versions/v0002.json`]);
    expect((await bytes(w, versionPathOf(2))).equals(frozen)).toBe(true);
  });
});

describe("TEST 3: a complete pending version (all 60 real values)", () => {
  it("a cut before the outcome and a retry: all 60 published, the charge is the one a straight run makes", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const death = dieAt(w, (p) => p.endsWith("outcome.json"));
    await expect(runAddon(w.deps, a.row)).rejects.toThrow("the worker died");
    expect(w.call).toHaveBeenCalledTimes(60);
    death.restore();
    w.expireLease(a.id);
    await runAddonSafely(w.deps, await w.reclaim());
    expect(w.call).toHaveBeenCalledTimes(60);
    expect(realValues(JSON.parse((await bytes(w, versionPathOf(2))).toString("utf8")))).toBe(60);
    expect(JSON.parse((await w.store.getFile(M12, outcomeOf(a)))!)).toMatchObject({ filled: 60, requested: 60 });
    const C = chargeBy(spent(w), 60, 60, a.hold);
    expect(C).toBe(330);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: C })).toEqual([]);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", delivered_units: 60, charged_points: C });
  });
});

describe("TEST 7: a settled job whose publication was cut (a partial frozen version)", () => {
  it("the retry publishes only the original bytes: no new call, no second charge, no release, the outcome is unchanged", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const gate = dailyCapAfter(w, 20);
    const death = dieAt(w, (p) => p.startsWith("versions/"));
    await expect(runAddon(w.deps, a.row)).rejects.toThrow("the worker died");
    expect(types(w)).toEqual(["topup", "reserve", "release", "charge"]);
    const ledger = JSON.stringify(w.money.ledger);
    const outcome = await w.store.getFile(M12, outcomeOf(a));
    const frozen = await bytes(w, pendingOf(a));
    gate.on = false;
    death.restore();
    w.expireLease(a.id);
    await runAddonSafely(w.deps, await w.reclaim());
    expect(JSON.stringify(w.money.ledger)).toBe(ledger);
    expect(await w.store.getFile(M12, outcomeOf(a))).toBe(outcome);
    expect((await bytes(w, versionPathOf(2))).equals(frozen)).toBe(true);
    expect(w.call).toHaveBeenCalledTimes(20);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", delivered_units: 20, charged_points: 110 });
  });
});

describe("a pending version that cannot be tied to this add-on is never charged for and never published", () => {
  const goodPending = (w: World): FileVersion => {
    const out = applyEditCore(w.v1, { kind: "add_column", sheet: COMMENTS_SHEET, titleAr: "اسم القناة", values: { [w.idsOf(COMMENTS_SHEET)[0]]: "قناة أ" } }, { createdAt: "2026-11-04T10:00:00.000Z" });
    if (!out.ok) throw new Error("no version");
    return out.version;
  };
  const cases: Array<[string, (v: FileVersion, w: World) => string]> = [
    ["not JSON at all", () => "{ this is not json"],
    ["a version of another number", (v) => JSON.stringify({ ...v, version: 5 })],
    ["a version whose parent is not the base", (v) => JSON.stringify({ ...v, parent: 7 })],
    ["a version of another mission", (v) => JSON.stringify({ ...v, missionId: "msn_other" })],
    ["a version with no real value in it", (_v, w) => { const out = applyEditCore(w.v1, { kind: "add_column", sheet: COMMENTS_SHEET, titleAr: "اسم القناة", values: {} }, { createdAt: "2026-11-04T10:00:00.000Z" }); if (!out.ok) throw new Error("no version"); return JSON.stringify(out.version); }],
  ];
  for (const [label, make] of cases) {
    it(label, async () => {
      const w = await addonRunWorld({ balance: BALANCE });
      const a = await commentsEdit(w);
      const text = make(goodPending(w), w);
      await w.store.putNew(M12, pendingOf(a), text, "application/json");
      await expect(runAddon(w.deps, a.row)).rejects.toThrow();
      // nothing invented, nothing spent, nothing charged, nothing published; the evidence stays
      expect(await w.store.getFile(M12, outcomeOf(a))).toBeNull();
      expect(types(w)).toEqual(["topup", "reserve"]);
      expect(w.call).not.toHaveBeenCalled();
      expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
      expect(await w.store.getFile(M12, pendingOf(a))).toBe(text);
      // the safe recovery: after the requeues are used up the hold is released whole, with no charge
      for (let i = 0; i <= AGENT_ERROR_REQUEUES_MAX; i += 1) { w.expireLease(a.id); const again = await w.store.claimMission("worker-2", 120); if (again) await runAddonSafely(w.deps, again); }
      expect(types(w)).toEqual(["topup", "reserve", "release"]);
      expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "failed", charged_credits: 0 });
      expect(w.rowOf(a.id).status).toBe("failed");
      expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
    });
  }
});

describe("TEST 6: a storage failure while the worker checks the published path is not an empty path", () => {
  it("the check before the spend: the failure stops the run; nothing is spent, held only, nothing overwritten", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const get = w.store.getFile.bind(w.store);
    w.store.getFile = async (m, p) => { if (p === versionPathOf(2)) throw new Error("download: storage is unavailable"); return get(m, p); };
    await expect(runAddon(w.deps, a.row)).rejects.toThrow("storage is unavailable");
    expect(w.call).not.toHaveBeenCalled();
    expect(types(w)).toEqual(["topup", "reserve"]);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
    w.store.getFile = get;
    w.expireLease(a.id);
    await runAddonSafely(w.deps, await w.reclaim());
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: 330 })).toEqual([]);
  });
  it("the check between the stored work and the charge: the failure stops the run before the settlement", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const get = w.store.getFileBytes.bind(w.store);
    w.store.getFileBytes = async (m, p) => { if (p === versionPathOf(2)) throw new Error("download: storage is unavailable"); return get(m, p); };
    await expect(runAddon(w.deps, a.row)).rejects.toThrow("storage is unavailable");
    expect(types(w)).toEqual(["topup", "reserve"]);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
    w.store.getFileBytes = get;
    w.expireLease(a.id);
    await runAddonSafely(w.deps, await w.reclaim());
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: 330 })).toEqual([]);
    expect(w.call).toHaveBeenCalledTimes(60);
  });
  it("reading the outcome or the base version fails: the run stops, nothing is taken for «not there»", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const get = w.store.getFile.bind(w.store);
    w.store.getFile = async (m, p) => { if (p === outcomeOf(a) || p === versionPathOf(1)) throw new Error("download: rate limited"); return get(m, p); };
    await expect(runAddon(w.deps, a.row)).rejects.toThrow("rate limited");
    expect(w.call).not.toHaveBeenCalled();
    expect(types(w)).toEqual(["topup", "reserve"]);
  });
  it("a paid review: a failing check of the published report is not «no report yet» (no charge on that assumption)", async () => {
    const w = await addonRunWorld({ balance: 10_000 });
    const a = await w.createApproved({ kind: "review", request: { kind: "review" }, pricing: reviewPricing(reviewCellsOf(w.v1)), requestText: "راجع الملف" });
    const get = w.store.getFile.bind(w.store);
    w.store.getFile = async (m, p) => { if (p.startsWith("reviews/")) throw new Error("download: storage is unavailable"); return get(m, p); };
    await expect(runAddon(w.deps, a.row)).rejects.toThrow("storage is unavailable");
    expect(types(w)).toEqual(["topup", "reserve"]);
    expect(w.reviewFiles()).toEqual([]);
  });
});
