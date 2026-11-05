import { vi } from "vitest";
import { approveAddonOnce } from "../../src/lib/agentMission/addonSettlement";
import { buildAddonRow, type AddonRequest } from "../../src/lib/agentMission/stage4/addonRow";
import { firstVersionFromCells, versionPathOf, type FileVersion } from "../../src/lib/agentMission/stage4/versions";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import type { TregCallOptions, TregCallResult } from "../../src/functions/shared/tregClient";
import { createMemoryStore, newMission, type MemoryStore } from "../../agent/src/memoryStore";
import type { RunnerDeps } from "../../agent/src/runMission";
import type { MissionRecord } from "../../agent/src/types";
import { fakeRecorder, NOT_ADMIN, tregResult } from "./agentHarness";
import { fakeAddonWorld, USER, type MissionRow } from "./addonWorld";
import { tiktokWorld, xWorld } from "./round11Worlds";

/**
 * THE WORLD OF THE ADD-ON RUNNER TESTS (Phase 2B-1): a DELIVERED mission rebuilt from the stored real files of M12 (TikTok) or M14 (X) with its version 1 in a memory store, the hardened money fake, a fake recorder with a daily cap,
 * and a fake provider. Nothing here can reach a provider: `fetch` is stubbed to throw by the tests, the TREG answers are fake, no model is configured.
 */
export const M12 = "msn_5851abc92a1e6645a9cd";
export const M14 = "msn_b060d3347ed7660f972e";
export const COMMENTS_SHEET = "التعليقات";
export const VIDEOS_SHEET = "الفيديوهات";
export const LOOKUP_ENDPOINT = "tikhub.x.tiktok-web-fetch-user-live-detail";
export const LOOKUP_COST_USD = 0.001;

export type Answers = (o: TregCallOptions) => TregCallResult;
/** The fake lookup: every account has a nickname «قناة <handle>» and costs what the catalog says. */
export const nicknameAnswer = (costUsd = LOOKUP_COST_USD): Answers => (o) => tregResult({ data: { user: { nickname: `قناة ${String((o.params as Record<string, unknown>).uniqueId)}` } } }, costUsd);

export async function addonRunWorld(options: { world?: "m12" | "m14"; balance?: number; dailyCapUsd?: number; answers?: Answers; version?: FileVersion } = {}) {
  const w = options.world === "m14" ? await xWorld() : await tiktokWorld();
  const mission = options.world === "m14" ? M14 : M12;
  const v1 = options.version ?? firstVersionFromCells({ missionId: mission, cells: w.cells, createdAt: "2026-11-04T09:00:00.000Z" });
  const store = createMemoryStore();
  await store.putNew(v1.missionId, versionPathOf(1), JSON.stringify(v1), "application/json");
  store.missions.set(v1.missionId, newMission({ id: v1.missionId, user_id: USER, status: "completed", request_text: "طلب سابق" }));
  const money = fakeAddonWorld({ balance: options.balance ?? 100_000, missions: store.missions });
  const { recorder, rows: providerRows, commit } = fakeRecorder({ dailyCapUsd: options.dailyCapUsd });
  const answers = options.answers ?? nicknameAnswer();
  const call = vi.fn(async (o: TregCallOptions) => answers(o));
  const log = vi.fn();
  const deps: RunnerDeps = {
    store, client: money.client, catalog: loadTregCatalog(), recorder, commit, call: call as unknown as RunnerDeps["call"], token: "test-token", log,
    driver: { run: async () => { throw new Error("no model is configured in these tests"); } } as unknown as RunnerDeps["driver"],
    models: { planning: "none", execution: "none" }, resolveAccess: async () => NOT_ADMIN,
  };
  const idsOf = (sheet: string): string[] => v1.sheets.find((s) => s.nameAr === sheet)!.rows.map((r) => r.id);

  /** Creates the add-on row (plan_ready), approves it through the REAL approval (the hold), and claims it like the worker does. */
  async function createApproved(input: { kind: "review" | "review_fix" | "edit"; request: AddonRequest; pricing: Parameters<typeof buildAddonRow>[0]["pricing"]; baseVersion?: number; attempt?: number; requestText?: string }) {
    const row = buildAddonRow({ userId: USER, of: v1.missionId, kind: input.kind, baseVersion: input.baseVersion ?? 1, attempt: input.attempt ?? 1, request: input.request, pricing: input.pricing, requestText: input.requestText ?? "ضيف عمودًا لملفي" });
    store.missions.set(row.id, newMission({ ...(row as unknown as Partial<MissionRecord>), id: row.id, user_id: USER }));
    const approved = await approveAddonOnce(money.client, { id: row.id, actorId: USER, expectUserId: USER });
    if (!approved.ok) throw new Error(`approval failed: ${JSON.stringify(approved)}`);
    const claimed = await store.claimMission("worker-1", 120);
    if (!claimed || claimed.id !== row.id) throw new Error("the add-on was not claimed");
    return { row: store.missions.get(row.id) as MissionRecord, id: row.id, jobId: approved.jobId, hold: approved.holdPoints, budgetUsd: approved.providerBudgetUsd };
  }
  /** The worker's death: the row is left `executing` with its lease ended, so the next claim takes it again (agent_claim_mission's rule). */
  const expireLease = (id: string) => { const m = store.missions.get(id)!; m.lease_until = new Date(Date.now() - 1000).toISOString(); };
  const reclaim = async (): Promise<MissionRecord> => { const m = await store.claimMission("worker-2", 120); if (!m) throw new Error("nothing to claim"); return m; };
  const versionFiles = () => [...store.files.keys()].filter((k) => k.startsWith(`${v1.missionId}/versions/`)).sort();
  const reviewFiles = () => [...store.files.keys()].filter((k) => k.startsWith(`${v1.missionId}/reviews/`)).sort();
  return { w, v1, store: store as MemoryStore, money, deps, call, log, providerRows, createApproved, expireLease, reclaim, versionFiles, reviewFiles, idsOf, mission: v1.missionId, rowOf: (id: string) => store.missions.get(id) as MissionRecord & MissionRow };
}
