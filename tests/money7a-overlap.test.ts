import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editCard } from "../src/lib/agentMission/stage4/addonQuote";
import type { AddonRequest } from "../src/lib/agentMission/stage4/addonRow";
import { versionPathOf } from "../src/lib/agentMission/stage4/versions";
import { ADDON_DONE_AR } from "../agent/src/stage4/addonText";
import { runAddon } from "../agent/src/stage4/runAddon";
import type { CallRow } from "../agent/src/types";
import { checkAddonLedger } from "./helpers/addonWorld";
import { COMMENTS_SHEET, LOOKUP_COST_USD, LOOKUP_ENDPOINT, M12, addonRunWorld } from "./helpers/addonRunWorld";

/**
 * MONEY PR 7a, PHASE 2B-1 FINAL REVIEW, RISK 1: TWO WORKERS ON THE SAME ADD-ON AFTER A LEASE ENDS (docs/MONEY-PR-7A.md section 13.7). Worker 1 is slow, its lease ends, worker 2 reclaims the row, and for a while both run. The tests
 * interleave them deterministically (a worker is held inside a provider call or just before a write, then released) and check the money: one reserve, one release, at most one charge, one published version, a charge tied to the
 * published file, never above the hold, and no provider spending the second worker could have avoided.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

type World = Awaited<ReturnType<typeof addonRunWorld>>;
const TOOL = { endpointId: LOOKUP_ENDPOINT, params: {}, bind: { param: "uniqueId", from: "صاحب التعليق" }, valueField: "user.nickname" };
const BALANCE = 100_000;
const types = (w: World) => w.money.ledger.map((r) => r.type);
const said = (w: World, id: string) => w.store.events.filter((e) => e.mission_id === id).map((e) => e.message_ar);
const chargeBy = (real: number, filled: number, requested: number, hold: number) => Math.min(hold, Math.max(Math.ceil(Math.round(real * 1_000_000) * 5500 / 1_000_000 - 1e-9), Math.ceil((100 * filled) / requested)));
const bytes = async (w: World, rel: string) => (await w.store.getFileBytes(M12, rel))!;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const realValues = (text: string): number => { const v = JSON.parse(text); const s = v.sheets.find((x: { nameAr: string }) => x.nameAr === COMMENTS_SHEET); const at = s.headers.indexOf("اسم القناة"); return s.rows.filter((r: { cells: string[] }) => /^قناة /.test(r.cells[at])).length; };

async function commentsEdit(w: World) {
  const rowIds = w.idsOf(COMMENTS_SHEET);
  const card = editCard({ kind: "edit", units: rowIds.length, tools: [{ catalogPerRowUsd: LOOKUP_COST_USD }] });
  if (!card.ok) throw new Error("no card");
  const request: AddonRequest = { kind: "edit", edit: { kind: "add_column", sheet: COMMENTS_SHEET, titleAr: "اسم القناة", rowIds, reread: { tools: [TOOL] } } };
  return w.createApproved({ kind: "edit", request, pricing: card.pricing });
}
type Approved = Awaited<ReturnType<typeof commentsEdit>>;

/** A worker's own view of the deps: its own provider call, so the test can hold THAT worker inside its Nth call. */
function workerDeps(w: World, holdAtCall?: number) {
  const entered = deferred();
  const gate = deferred();
  let n = 0;
  const call = async (o: Parameters<World["deps"]["call"]>[0]) => { n += 1; if (n === holdAtCall) { entered.resolve(); await gate.promise; } return w.call(o); };
  return { deps: { ...w.deps, call: call as unknown as World["deps"]["call"] }, entered: entered.promise, release: gate.resolve };
}
/** The provider's daily cap on THIS deps' recorder: `n` allowed calls, then refused until `gate.on = false`. */
function dailyCapAfter(deps: World["deps"], n: number) {
  const inner = deps.recorder;
  const gate = { on: true, allowed: 0 };
  deps.recorder = { ...inner, reserve: async (a: Parameters<typeof inner.reserve>[0]) => { if (gate.on && gate.allowed >= n) return { allowed: false, costId: null, reason: "cap" as const }; const r = await inner.reserve(a); if (r.allowed) gate.allowed += 1; return r; }, commit: inner.commit.bind(inner) } as typeof inner;
  return gate;
}
/** Holds whoever writes the OUTCOME first, just before the write. */
function holdFirstOutcome(w: World) {
  const put = w.store.putNewStrict.bind(w.store);
  const reached = deferred();
  const gate = deferred();
  let first = true;
  w.store.putNewStrict = async (m, p, c, t) => { if (p.endsWith("outcome.json") && first) { first = false; reached.resolve(); await gate.promise; } return put(m, p, c, t); };
  return { reached: reached.promise, release: gate.resolve };
}
const pendingOf = (a: Approved) => `addons/${a.id}/v0002.json`;
const outcomeOf = (a: Approved) => `addons/${a.id}/outcome.json`;

describe("worker 1 is slow inside a provider call; worker 2 reclaims and FINISHES; worker 1 wakes up", () => {
  it("one reserve, one release, one charge, one version; worker 1 stops (at most the call it was in) and changes nothing", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const v1bytes = await bytes(w, versionPathOf(1));
    const w1 = workerDeps(w, 21);
    // worker 1 finishes 20 units, then is held inside its 21st call
    const run1 = runAddon(w1.deps, a.row);
    await w1.entered;
    expect(w.call).toHaveBeenCalledTimes(20);
    // its lease ends; worker 2 takes the row and runs it to the end
    w.expireLease(a.id);
    const claimed = await w.reclaim();
    expect(claimed.worker_id).toBe("worker-2");
    await runAddon(w.deps, claimed);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", charged_points: 330 });
    const ledger = JSON.stringify(w.money.ledger);
    const callsByWorker2 = w.call.mock.calls.length;
    // worker 1 wakes up inside its call
    w1.release();
    await run1;

    // worker 1 spent nothing more than the one call it was inside (it stops at the next unit instead of paying again for 40 units)
    expect(w.call.mock.calls.length).toBeLessThanOrEqual(callsByWorker2 + 1);
    expect(JSON.stringify(w.money.ledger)).toBe(ledger);
    expect(types(w)).toEqual(["topup", "reserve", "release", "charge"]);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: 330 })).toEqual([]);
    expect(w.money.balance()).toBe(BALANCE - 330);
    // one published version, from the pending bytes, v1 untouched
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`, `${M12}/versions/v0002.json`]);
    expect((await bytes(w, versionPathOf(2))).equals(await bytes(w, pendingOf(a)))).toBe(true);
    expect((await bytes(w, versionPathOf(1))).equals(v1bytes)).toBe(true);
    // the customer was told once
    expect(said(w, a.id).filter((s) => s === ADDON_DONE_AR.versionDone(2, 330))).toHaveLength(1);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", delivered_units: 60, charged_points: 330 });
  });
});

describe("worker 2 freezes a PARTIAL version and is held before its outcome; worker 1 (started earlier) wakes up with all the answers it wants", () => {
  it("the charge is for the 20 values of the frozen version and their cost: worker 1's later calls are not charged for", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const w1 = workerDeps(w, 1);
    const run1 = runAddon(w1.deps, a.row);
    await w1.entered;
    w.expireLease(a.id);
    const claimed = await w.reclaim();
    // worker 2: the provider's daily cap stops it after 20 calls; it stores its version and is held just before the outcome
    dailyCapAfter(w.deps, 20);
    const held = holdFirstOutcome(w);
    const run2 = runAddon(w.deps, claimed);
    await held.reached;
    const frozen = await bytes(w, pendingOf(a));
    expect(realValues(frozen.toString("utf8"))).toBe(20);
    // worker 1 wakes up (no cap for it) and runs on while worker 2 is held
    w1.release();
    await run1;
    held.release();
    await run2;

    const spent = w.providerRows.reduce((n, r) => n + (r.committedUsd ?? 0), 0);
    // whatever worker 1 did, the version that is published is worker 2's frozen one and the charge is for IT: 20 values, the cost of 20 calls
    expect((await bytes(w, versionPathOf(2))).equals(frozen)).toBe(true);
    expect(JSON.parse((await w.store.getFile(M12, outcomeOf(a)))!)).toMatchObject({ filled: 20 });
    expect(types(w)).toEqual(["topup", "reserve", "release", "charge"]);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: chargeBy(20 * LOOKUP_COST_USD, 20, 60, a.hold) })).toEqual([]);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", delivered_units: 20, charged_points: 110 });
    // and worker 1 did not pay again for what worker 2 had read: at most the call it was inside
    expect(w.call.mock.calls.length).toBeLessThanOrEqual(21);
    expect(spent).toBeLessThanOrEqual(21 * LOOKUP_COST_USD + 1e-9);
  });
});

describe("a call recorded for the add-on AFTER its version was frozen (a straggler) is not part of the frozen work", () => {
  it("the retry's outcome carries the cost of the frozen snapshot, not the later call", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const gate = dailyCapAfter(w.deps, 20);
    const put = w.store.putNewStrict.bind(w.store);
    w.store.putNewStrict = async (m, p, c, t) => { if (p.endsWith("outcome.json")) throw new Error("the worker died"); return put(m, p, c, t); };
    await expect(runAddon(w.deps, a.row)).rejects.toThrow("the worker died");
    const frozen = await bytes(w, pendingOf(a));
    expect(realValues(frozen.toString("utf8"))).toBe(20);
    // a call of a worker that was still running is recorded after the freeze (an expensive one)
    const straggler: CallRow = { id: "call_9999", mission_id: a.id, phase: "execution", endpoint_id: LOOKUP_ENDPOINT, params_digest: {}, status: "ok", refused_reason: null, http_status: 200, rows_returned: 1, cost_usd: 0.05, estimate_usd: 0.001, provider_cost_id: null, storage_path: null, duration_ms: 1 };
    w.store.calls.push(straggler);
    w.store.putNewStrict = put;
    gate.on = false;
    w.expireLease(a.id);
    await runAddon(w.deps, await w.reclaim());
    const outcome = JSON.parse((await w.store.getFile(M12, outcomeOf(a)))!);
    expect(outcome.filled).toBe(20);
    expect(outcome.realCostUsd).toBeCloseTo(20 * LOOKUP_COST_USD, 9);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: 110 })).toEqual([]);
    expect((await bytes(w, versionPathOf(2))).equals(frozen)).toBe(true);
    expect(w.call).toHaveBeenCalledTimes(20);
  });
});

describe("a worker that lost the row stops BEFORE it stores anything (it was inside its last provider call)", () => {
  it("worker 1 is held just before it would freeze its version; worker 2 finishes; worker 1 writes nothing and the row is told once", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const put = w.store.putNewStrict.bind(w.store);
    const reached = deferred();
    const gate = deferred();
    let held = false;
    w.store.putNewStrict = async (m, p, c, t) => { if (!held && p.startsWith(`addons/${a.id}/`) && !p.includes("/rows/") && !p.endsWith("outcome.json")) { held = true; reached.resolve(); await gate.promise; } return put(m, p, c, t); };
    const run1 = runAddon(w.deps, a.row);
    await reached.promise;
    expect(w.call).toHaveBeenCalledTimes(60);
    w.expireLease(a.id);
    await runAddon(w.deps, await w.reclaim());
    const ledger = JSON.stringify(w.money.ledger);
    const files = [...w.store.files.keys()].sort();
    const events = said(w, a.id).length;
    gate.resolve();
    await run1;
    expect(JSON.stringify(w.money.ledger)).toBe(ledger);
    expect([...w.store.files.keys()].sort()).toEqual(files);
    expect(said(w, a.id)).toHaveLength(events);
    expect(w.call).toHaveBeenCalledTimes(60);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: 330 })).toEqual([]);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", charged_points: 330 });
  });
});
