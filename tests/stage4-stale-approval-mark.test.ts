import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addonJobId, addonQuoteId, approveAddonOnce } from "../src/lib/agentMission/addonSettlement";
import { STALE_APPROVAL_MARK_MS, recoverAbandonedAddon, recoverFileAddons } from "../src/lib/agentMission/addonRecovery";
import { createSupabaseAddonRowStore, cancelUnpaidAddonRow } from "../src/lib/agentMission/stage4/addonRowStore";
import { isUnpaidAddonRow, listWithRecovery } from "../src/lib/agentMission/stage4/addonRow";
import { addonRowOf, USER } from "./helpers/addonWorld";
import { safetyWorld, type SafetyWorld } from "./helpers/safetyWorld";

/**
 * AUDIT D1 (acceptance campaign, 5 Nov 2026): an approval that failed with an UNCERTAIN code (here: the quote could not be made, nothing reserved) keeps the approval mark. The request pages show only an UNMARKED waiting request,
 * so after a reload the customer had no approve button, no cancel and could not replace it. Recovery now frees the request once the mark is older than the quote's life (31 minutes) AND the ledger proves nothing was ever reserved.
 */
const FILE = "msn_5851abc92a1e6645a9cd";
const START = 10_000;
const make = () => { const w = safetyWorld({ balance: START }); const row = addonRowOf({ kind: "review", of: FILE }); w.missions.set(row.id, row); return { w, row, jobId: addonJobId(addonQuoteId(row.id)) }; };
const approve = (w: SafetyWorld, id: string) => approveAddonOnce(w.client, { id, actorId: USER, expectUserId: USER });
const at = (ms: number) => new Date(Date.now() + ms);
const ledgerRows = (w: SafetyWorld) => w.ledger.length;
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => { vi.unstubAllGlobals(); });

async function failedBeforeQuote(w: SafetyWorld, id: string) {
  w.injectError("create_quote_atomic", "before");
  expect(await approve(w, id)).toMatchObject({ ok: false, code: "quote_failed" });
  expect(w.missions.get(id)!.approved_at).toBeTruthy(); // the mark is kept (uncertain code)
}

describe("a stale approval mark with nothing reserved is freed so the customer can approve or cancel the SAME request", () => {
  it("the window is longer than a quote's life (30 minutes) with a margin", () => { expect(STALE_APPROVAL_MARK_MS).toBe(35 * 60_000); });

  it("a FRESH mark is left alone (an approval may be in flight): no_reservation, mark kept, no write", async () => {
    const { w, row } = make();
    await failedBeforeQuote(w, row.id);
    const writes = w.writes.length;
    expect(await recoverAbandonedAddon(w.client, { id: row.id, userId: USER, now: at(60_000) })).toEqual({ kind: "no_reservation" });
    expect(w.missions.get(row.id)!.approved_at).toBeTruthy();
    expect(w.writes.length).toBe(writes);
  });

  it("an OLD mark with nothing reserved: mark_cleared; the request is unpaid and waiting again, can be approved (one hold) and the money tables were not written by the recovery", async () => {
    const { w, row, jobId } = make();
    await failedBeforeQuote(w, row.id);
    const before = ledgerRows(w);
    expect(await recoverAbandonedAddon(w.client, { id: row.id, userId: USER, now: at(STALE_APPROVAL_MARK_MS + 60_000) })).toEqual({ kind: "mark_cleared" });
    const after = w.missions.get(row.id)!;
    expect(after).toMatchObject({ status: "plan_ready", approved_at: null, job_id: null });
    expect(isUnpaidAddonRow(after as any)).toBe(true);
    expect(ledgerRows(w)).toBe(before); // recovery moves no money
    expect(w.jobs.has(jobId)).toBe(false);
    // the same request is approved: exactly one hold
    expect((await approve(w, row.id)).ok).toBe(true);
    expect(w.ledger.filter((l) => l.type === "reserve").length).toBe(1);
  });

  it("BEFORE the recovery the marked request cannot be cancelled; AFTER it, it can (the cancel needs an unmarked row)", async () => {
    const { w, row } = make();
    await failedBeforeQuote(w, row.id);
    expect(await cancelUnpaidAddonRow(w.client as any, { id: row.id, userId: USER })).toBe(false);
    await recoverAbandonedAddon(w.client, { id: row.id, userId: USER, now: at(STALE_APPROVAL_MARK_MS + 60_000) });
    expect(await cancelUnpaidAddonRow(w.client as any, { id: row.id, userId: USER })).toBe(true);
    expect(w.missions.get(row.id)!.status).toBe("cancelled");
    expect(w.ledger.filter((l) => l.type === "reserve").length).toBe(0);
  });

  it("an OLD mark but a reservation EXISTS (held): never cleared (the money state decides); the hold is not touched", async () => {
    const { w, row } = make();
    w.inject("claim_job_chunk", "before");
    expect((await approve(w, row.id)).ok).toBe(false); // accept committed, claim never ran: queued + reserved
    const reserves = w.ledger.filter((l) => l.type === "reserve").length;
    expect(reserves).toBe(1);
    const out = await recoverAbandonedAddon(w.client, { id: row.id, userId: USER, now: at(STALE_APPROVAL_MARK_MS + 60_000) });
    expect(out.kind).not.toBe("mark_cleared");
    expect(w.missions.get(row.id)!.approved_at).toBeTruthy();
    expect(w.ledger.filter((l) => l.type === "reserve").length).toBe(1);
  });

  it("an unreadable ledger or jobs table never frees the mark (the answer «none» is not assumed from an error)", async () => {
    const { w, row } = make();
    await failedBeforeQuote(w, row.id);
    w.setLedgerDown(true);
    const out = await recoverAbandonedAddon(w.client, { id: row.id, userId: USER, now: at(STALE_APPROVAL_MARK_MS + 60_000) });
    expect(out).toEqual({ kind: "unresolved", why: "read_failed" });
    expect(w.missions.get(row.id)!.approved_at).toBeTruthy();
  });

  it("another customer's recovery call and a request already running are not touched", async () => {
    const { w, row } = make();
    await failedBeforeQuote(w, row.id);
    expect(await recoverAbandonedAddon(w.client, { id: row.id, userId: "someone-else", now: at(STALE_APPROVAL_MARK_MS + 60_000) })).toEqual({ kind: "not_applicable" });
    expect(w.missions.get(row.id)!.approved_at).toBeTruthy();
  });

  it("the file-level entry point (what the page's list calls) frees it too, once, and a second call finds it unpaid", async () => {
    const { w, row } = make();
    await failedBeforeQuote(w, row.id);
    const now = at(STALE_APPROVAL_MARK_MS + 60_000);
    expect(await recoverFileAddons(w.client, { missionId: FILE, userId: USER, now })).toEqual([{ kind: "mark_cleared" }]);
    expect(await recoverFileAddons(w.client, { missionId: FILE, userId: USER, now })).toEqual([]);
  });

  it("REVIEW FINDING 1: the page's own list (listWithRecovery, used by the review and edit cards and the create/approve guards) hands back the FREED row in the SAME call, not only after the next reload", async () => {
    const { w, row } = make();
    await failedBeforeQuote(w, row.id);
    w.missions.get(row.id)!.approved_at = new Date(Date.now() - 40 * 60_000).toISOString(); // a 40-minute-old mark
    const store = createSupabaseAddonRowStore(w.client as any, USER);
    const rows = await listWithRecovery(store, FILE);
    const mine = rows.find((r) => r.id === row.id)!;
    expect(mine.approved_at ?? null).toBeNull();
    expect(isUnpaidAddonRow(mine as any)).toBe(true);
  });
  it("a FRESH mark is not freed by the list (the same call returns the marked row)", async () => {
    const { w, row } = make();
    await failedBeforeQuote(w, row.id);
    const rows = await listWithRecovery(createSupabaseAddonRowStore(w.client as any, USER), FILE);
    expect(rows.find((r) => r.id === row.id)!.approved_at).toBeTruthy();
  });
});
