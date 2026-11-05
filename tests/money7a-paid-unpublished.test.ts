import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ERROR_REQUEUES_MAX } from "../src/lib/agentMission/constants";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { editCard } from "../src/lib/agentMission/stage4/addonQuote";
import type { AddonRequest } from "../src/lib/agentMission/stage4/addonRow";
import { versionPathOf } from "../src/lib/agentMission/stage4/versions";
import { ADDON_DONE_AR } from "../agent/src/stage4/addonText";
import { ADDON_PAID_PARKS_MAX, runAddon, runAddonSafely } from "../agent/src/stage4/runAddon";
import { checkAddonLedger } from "./helpers/addonWorld";
import { COMMENTS_SHEET, LOOKUP_COST_USD, LOOKUP_ENDPOINT, M12, addonRunWorld } from "./helpers/addonRunWorld";

/**
 * MONEY PR 7a, PHASE 2B-1 FINAL REVIEW, RISK 2: CHARGED, BUT THE FILE CANNOT BE PUBLISHED BECAUSE STORAGE KEEPS FAILING (docs/MONEY-PR-7A.md section 13.7). Once the points are charged the file is OWED: the row must never end «failed»
 * for good while the pending bytes are safe in the folder, the charge must never be repeated or released, and when storage comes back a later run publishes the very bytes that were charged for. A run that cannot publish is retried
 * with a growing wait (the row goes back to «approved» with its lease in the future, so the claim leaves it alone until then) and the administrator is told; only a paid file that can NEVER be published (its pending bytes are gone) ends
 * «failed», with a note for the administrator to refund by hand.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

type World = Awaited<ReturnType<typeof addonRunWorld>>;
const TOOL = { endpointId: LOOKUP_ENDPOINT, params: {}, bind: { param: "uniqueId", from: "صاحب التعليق" }, valueField: "user.nickname" };
const BALANCE = 100_000;
const types = (w: World) => w.money.ledger.map((r) => r.type);
const adminNotes = (w: World, id: string) => w.store.events.filter((e) => e.mission_id === id && (e.counts as Record<string, number> | undefined)?.adm_flag === 1);
const said = (w: World, id: string) => w.store.events.filter((e) => e.mission_id === id).map((e) => e.message_ar);

async function commentsEdit(w: World) {
  const rowIds = w.idsOf(COMMENTS_SHEET);
  const card = editCard({ kind: "edit", units: rowIds.length, tools: [{ catalogPerRowUsd: LOOKUP_COST_USD }] });
  if (!card.ok) throw new Error("no card");
  const request: AddonRequest = { kind: "edit", edit: { kind: "add_column", sheet: COMMENTS_SHEET, titleAr: "اسم القناة", rowIds, reread: { tools: [TOOL] } } };
  return w.createApproved({ kind: "edit", request, pricing: card.pricing });
}
type Approved = Awaited<ReturnType<typeof commentsEdit>>;
const pendingOf = (a: Approved) => `addons/${a.id}/v0002.json`;

/** Storage that refuses to PUBLISH a version (any write under versions/), as an outage would; `restore()` brings it back. */
function publishOutage(w: World) {
  const put = w.store.putNewStrict.bind(w.store);
  const state = { down: true, attempts: 0 };
  w.store.putNewStrict = async (m, p, c, t) => { if (state.down && p.startsWith("versions/")) { state.attempts += 1; throw new Error("upload: storage is unavailable"); } return put(m, p, c, t); };
  return state;
}
/** One more try of the worker loop: the next claim, and the run (never throws). Returns false when the claim leaves the row alone. */
async function nextTry(w: World, a: Approved): Promise<boolean> {
  const claimed = await w.store.claimMission("worker-n", 120);
  if (!claimed) return false;
  expect(claimed.id).toBe(a.id);
  await runAddonSafely(w.deps, claimed);
  return true;
}

describe("charged, then publishing fails again and again, then storage returns", () => {
  it("the charge is made once and never released; the pending bytes are kept; the customer is never told it succeeded; the file is published later, once", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const outage = publishOutage(w);

    await runAddonSafely(w.deps, a.row);
    // charged, not published; the ledger is complete and final
    expect(types(w)).toEqual(["topup", "reserve", "release", "charge"]);
    const ledger = JSON.stringify(w.money.ledger);
    const pending = await w.store.getFileBytes(M12, pendingOf(a));
    expect(pending).not.toBeNull();

    // the retries: each waits (the claim leaves the row alone until its lease ends), each fails, and passes the old retry limit
    for (let i = 0; i < AGENT_ERROR_REQUEUES_MAX + 3; i += 1) {
      expect(w.rowOf(a.id).status).toBe("approved");
      expect(await w.store.claimMission("worker-n", 120)).toBeNull();
      w.expireLease(a.id);
      expect(await nextTry(w, a)).toBe(true);
      expect(JSON.stringify(w.money.ledger)).toBe(ledger);
    }
    expect(outage.attempts).toBeGreaterThanOrEqual(AGENT_ERROR_REQUEUES_MAX + 4);
    // still not abandoned, never shown as done, the hold never released, the bytes unchanged, nothing published
    expect(w.rowOf(a.id).status).toBe("approved");
    expect(w.rowOf(a.id).status).not.toBe("failed");
    expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "completed", charged_credits: 330 });
    expect((await w.store.getFileBytes(M12, pendingOf(a)))!.equals(pending!)).toBe(true);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
    const told = said(w, a.id);
    expect(told).not.toContain(ADDON_DONE_AR.versionDone(2, 330));
    expect(told).not.toContain(ADDON_DONE_AR.chargedNotShown);
    expect(told).toContain(ADDON_DONE_AR.paidPublishing);
    for (const s of told) expect(checkCustomerText(s).issues).toEqual([]);
    // the administrator is told that a charged file is waiting
    expect(adminNotes(w, a.id).length).toBeGreaterThanOrEqual(1);

    // storage comes back: the next try publishes the same bytes, once; nothing else changes
    outage.down = false;
    w.expireLease(a.id);
    expect(await nextTry(w, a)).toBe(true);
    expect(JSON.stringify(w.money.ledger)).toBe(ledger);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: a.hold, charged: 330 })).toEqual([]);
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`, `${M12}/versions/v0002.json`]);
    expect((await w.store.getFileBytes(M12, versionPathOf(2)))!.equals(pending!)).toBe(true);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", delivered_units: 60, charged_points: 330 });
    expect(told.length).toBeLessThan(said(w, a.id).length);
    expect(said(w, a.id).filter((s) => s === ADDON_DONE_AR.versionDone(2, 330))).toHaveLength(1);
    expect(w.call).toHaveBeenCalledTimes(60);
    expect(w.money.balance()).toBe(BALANCE - 330);
  });

  it("the storage read of the pending bytes failing is the same: the file is owed, the row waits", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    // the outage starts after the charge: the check before publishing cannot read the folder
    const get = w.store.getFileBytes.bind(w.store);
    let down = false;
    w.store.getFileBytes = async (m, p) => { if (down && p.startsWith("versions/")) throw new Error("download: rate limited"); return get(m, p); };
    const put = w.store.putNewStrict.bind(w.store);
    w.store.putNewStrict = async (m, p, c, t) => { if (p.startsWith("versions/")) { down = true; throw new Error("upload: storage is unavailable"); } return put(m, p, c, t); };
    await runAddonSafely(w.deps, a.row);
    for (let i = 0; i < AGENT_ERROR_REQUEUES_MAX + 2; i += 1) { w.expireLease(a.id); await nextTry(w, a); }
    expect(w.rowOf(a.id).status).toBe("approved");
    expect(types(w)).toEqual(["topup", "reserve", "release", "charge"]);
    w.store.putNewStrict = put;
    w.store.getFileBytes = get;
    w.expireLease(a.id);
    await nextTry(w, a);
    expect(w.rowOf(a.id)).toMatchObject({ status: "completed", charged_points: 330 });
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`, `${M12}/versions/v0002.json`]);
    expect(types(w)).toEqual(["topup", "reserve", "release", "charge"]);
  });
});

describe("a charged file that can NEVER be published (its pending bytes are gone)", () => {
  it("after the paid retries are used up the row ends «failed» with the sentence for the customer and a note for the administrator; the charge stays, nothing is released", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const outage = publishOutage(w);
    await runAddonSafely(w.deps, a.row);
    expect(types(w)).toEqual(["topup", "reserve", "release", "charge"]);
    // the pending object is lost
    w.store.files.delete(`${M12}/${pendingOf(a)}`);
    for (let i = 0; i < ADDON_PAID_PARKS_MAX + 2; i += 1) { w.expireLease(a.id); if (!(await nextTry(w, a))) break; }
    expect(w.rowOf(a.id).status).toBe("failed");
    expect(w.rowOf(a.id).error).toBe("charged_not_published");
    expect(said(w, a.id)).toContain(ADDON_DONE_AR.chargedNotShown);
    expect(adminNotes(w, a.id).length).toBeGreaterThanOrEqual(2);
    expect(types(w)).toEqual(["topup", "reserve", "release", "charge"]);
    expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "completed", charged_credits: 330 });
    expect(w.versionFiles()).toEqual([`${M12}/versions/v0001.json`]);
    void outage;
  });
});

describe("the retry is only a retry of the PUBLISH: an unpaid add-on is unchanged (storage failing before the charge still releases whole after the limit)", () => {
  it("no charge was made, so the old rule stands: requeued, then the whole hold comes back", async () => {
    const w = await addonRunWorld({ balance: BALANCE });
    const a = await commentsEdit(w);
    const get = w.store.getFile.bind(w.store);
    w.store.getFile = async (m, p) => { if (p === versionPathOf(2)) throw new Error("download: storage is unavailable"); return get(m, p); };
    await runAddonSafely(w.deps, a.row);
    for (let i = 0; i < AGENT_ERROR_REQUEUES_MAX + 1; i += 1) { w.expireLease(a.id); await nextTry(w, a); }
    expect(types(w)).toEqual(["topup", "reserve", "release"]);
    expect(w.rowOf(a.id).status).toBe("failed");
    expect(w.money.jobs.get(a.jobId)).toMatchObject({ status: "failed", charged_credits: 0 });
    void runAddon;
  });
});
