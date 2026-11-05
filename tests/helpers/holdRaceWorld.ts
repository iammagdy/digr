import { vi } from "vitest";
import { addonJobId, addonQuoteId, approveAddonOnce } from "../../src/lib/agentMission/addonSettlement";
import { buildAddonRow, type AddonRequest } from "../../src/lib/agentMission/stage4/addonRow";
import { editCard } from "../../src/lib/agentMission/stage4/addonQuote";
import { reviewCellsOf } from "../../src/lib/agentMission/stage4/review";
import { firstVersionFromCells, versionPathOf, type FileVersion } from "../../src/lib/agentMission/stage4/versions";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import type { TregCallOptions, TregCallResult } from "../../src/functions/shared/tregClient";
import { createMemoryStore, newMission, type MemoryStore } from "../../agent/src/memoryStore";
import type { RunnerDeps } from "../../agent/src/runMission";
import type { MissionRecord } from "../../agent/src/types";
import { fakeRecorder, NOT_ADMIN } from "./agentHarness";
import { USER, reviewPricing } from "./addonWorld";
import { recordsJob, safetyWorld } from "./safetyWorld";
import { tiktokWorld } from "./round11Worlds";
import { nicknameAnswer, COMMENTS_SHEET, LOOKUP_COST_USD, LOOKUP_ENDPOINT, M12 } from "./addonRunWorld";

/**
 * THE WORLD OF THE «WORKER ARRIVES BEFORE THE APPROVAL IS RECORDED» TESTS. It is the add-on runner's world (a delivered mission of stored real files, a memory store, a fake recorder, a fake provider: `fetch` is stubbed to throw by the tests, no model is configured)
 * with the FAULT-INJECTING money world of the safety round behind the worker's client (`jobs` with `reserved_credits`, a read-only `credit_ledger`, faults on the `missions` table), so the worker's money-state reader sees what the real database shows.
 * Rows are made by the REAL approval: a fault on the one update that records `job_id` leaves a hold that is reserved and a row that does not say so, exactly as in production. Nothing here reaches a database, a provider, a payment or the network.
 */
export { COMMENTS_SHEET, LOOKUP_COST_USD, LOOKUP_ENDPOINT, M12, recordsJob, USER };
const TOOL = { endpointId: LOOKUP_ENDPOINT, params: {}, bind: { param: "uniqueId", from: "صاحب التعليق" }, valueField: "user.nickname" };

export async function holdRaceWorld(options: { balance?: number; answers?: (o: TregCallOptions) => TregCallResult } = {}) {
  const tw = await tiktokWorld();
  const v1: FileVersion = firstVersionFromCells({ missionId: M12, cells: tw.cells, createdAt: "2026-11-04T09:00:00.000Z" });
  const store = createMemoryStore();
  await store.putNew(v1.missionId, versionPathOf(1), JSON.stringify(v1), "application/json");
  store.missions.set(v1.missionId, newMission({ id: v1.missionId, user_id: USER, status: "completed", request_text: "طلب سابق" }));
  const money = safetyWorld({ balance: options.balance ?? 100_000, missions: store.missions });
  const { recorder, rows: providerRows, commit } = fakeRecorder({});
  const answers = options.answers ?? nicknameAnswer();
  const call = vi.fn(async (o: TregCallOptions) => answers(o));
  const log = vi.fn();
  const deps: RunnerDeps = {
    store, client: money.client, catalog: loadTregCatalog(), recorder, commit, call: call as unknown as RunnerDeps["call"], token: "test-token", log,
    driver: { run: async () => { throw new Error("no model is configured in these tests"); } } as unknown as RunnerDeps["driver"],
    models: { planning: "none", execution: "none" }, resolveAccess: async () => NOT_ADMIN,
  };
  const rowIds = v1.sheets.find((s) => s.nameAr === COMMENTS_SHEET)!.rows.map((r) => r.id);

  /** The plan_ready row of a paid review (no provider call) or an edit (provider calls), shared with the money world, not approved yet. */
  function createRow(kind: "review" | "edit", attempt = 1) {
    let request: AddonRequest;
    let pricing;
    if (kind === "review") { request = { kind: "review" }; pricing = reviewPricing(reviewCellsOf(v1)); }
    else {
      request = { kind: "edit", edit: { kind: "add_column", sheet: COMMENTS_SHEET, titleAr: "اسم القناة", rowIds, reread: { tools: [TOOL] } } };
      const card = editCard({ kind: "edit", units: rowIds.length, tools: [{ catalogPerRowUsd: LOOKUP_COST_USD }] });
      if (!card.ok) throw new Error("no card");
      pricing = card.pricing;
    }
    const row = buildAddonRow({ userId: USER, of: M12, kind, baseVersion: 1, attempt, request, pricing, requestText: kind === "review" ? "راجع الملف" : "ضيف عمودًا لملفي" });
    store.missions.set(row.id, newMission({ ...(row as unknown as Partial<MissionRecord>), id: row.id, user_id: USER }));
    return { id: row.id, jobId: addonJobId(addonQuoteId(row.id)), hold: pricing.holdPoints };
  }
  const approve = (id: string) => approveAddonOnce(money.client, { id, actorId: USER, expectUserId: USER });
  const rowOf = (id: string) => store.missions.get(id) as MissionRecord & Record<string, any>;
  const expireLease = (id: string) => { rowOf(id).lease_until = new Date(Date.now() - 1000).toISOString(); };
  /** The next claim of the worker loop (the real claim rule of the memory store: an `approved` row with no live lease). */
  const claim = async (worker = "worker-1"): Promise<MissionRecord | null> => store.claimMission(worker, 120);
  const events = (id: string) => store.events.filter((e) => e.mission_id === id);
  const said = (id: string) => events(id).map((e) => e.message_ar);
  /** The rpc names the money world was asked, in order (the approval's and the settlement's). */
  const rpcNames = () => money.calls.map((c) => c.name);
  const countRpc = (name: string, jobId?: string) => money.calls.filter((c) => c.name === name && (jobId === undefined || c.args?.p_job_id === jobId)).length;
  const ledgerCount = (type: string, jobId: string) => money.ledger.filter((r) => r.type === type && r.job_id === jobId).length;
  return { tw, v1, store: store as MemoryStore, money, deps, call, log, providerRows, rowIds, createRow, approve, rowOf, expireLease, claim, events, said, rpcNames, countRpc, ledgerCount, mission: M12 };
}
export type HoldRaceWorld = Awaited<ReturnType<typeof holdRaceWorld>>;
