import { readFileSync } from "node:fs";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { createMemoryStore } from "../../agent/src/memoryStore";
import { ItemStore } from "../../agent/src/items/itemStore";
import { runEngine } from "../../agent/src/engine/run";
import { runInSandbox } from "../../agent/src/sandbox";
import { planByCompiler, type CompiledPlanning } from "../../agent/src/compiled";
import { redesignStagesOf } from "../../agent/src/redesign";
import { buildMissionFiles, layoutOf } from "../../agent/src/workbook";
import { companyMailboxesOf } from "../../agent/src/runMission";
import { missionFactsOf } from "../../agent/src/methodology";
import { RAW_PATH, type Gateway } from "../../agent/src/gateway";
import { reportedPlan, withPromiseCaps, withRepliesJudged } from "../../src/lib/agentMission/repliesCard";
import type { PricedPlan } from "../../src/lib/agentMission/plan";
import type { RedesignFlags } from "../../src/lib/agentMission/redesignFlags";
import type { Occurrence } from "../../src/lib/agentMission/foundation/occurrence";
import type { PlatformFlags } from "../../src/lib/agentMission/redesignFlagTypes";
import { replayGateway, type ReplayOptions } from "./replayGateway";

/**
 * ROUND 14: THE END-TO-END REPLAY OF A STORED LIVE MISSION, shared by the delivery contract's test and the date tests. The compiler plans from the stored PLANNING pages, the engine reads the stored EXECUTION pages (the same inputs as the live calls; no network, no paid call),
 * and the file is built exactly as the worker builds it at the end of a run (`runMission.ts`: promise caps, reported plan, replies judged, `buildMissionFiles`). Nothing here is a model: no review call is made.
 */
export const catalog = loadTregCatalog();
const TYPES_OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" } as RedesignFlags;

export interface MissionReplayInput {
  fixture: string;
  request: string;
  answer?: string | null;
  /** The mission's `created_at` (the Cairo days of the request come from it) and the planning moment. */
  createdAt: string;
  planningAt: string;
  /** The moment the engine «reads» (approximate dates are computed from it). */
  readAt: string;
  platform: "tiktok" | "x" | "facebook" | "instagram" | "youtube";
  catalogOnly?: boolean;
  edits?: { count?: number; comments?: number; replies?: number };
  occurrence?: Occurrence;
  replay?: ReplayOptions;
  /** Written in the test that needs it: the plan as the live run pinned it (the stored titles are anonymised, so a ranking made on the real words cannot be reproduced). */
  adjustPlan?: (plan: PricedPlan) => void;
  /** Written in the test that needs it: changes a stored PLANNING page after it is served (the anonymiser replaced the words the live ranking read: a post's text and author), so the compiler ranks as it did live. */
  transformPlanningPage?: (endpointId: string, page: unknown) => unknown;
}

export interface MissionReplay {
  planned: Extract<CompiledPlanning, { kind: "plan" }>;
  plan: PricedPlan;
  rowsByStage: Record<string, Array<Record<string, unknown>>>;
  built: Awaited<ReturnType<typeof buildMissionFiles>>;
  unservedPlanning: number;
  unservedExecution: number;
  unserved: Array<{ endpointId: string; params: Record<string, unknown> }>;
}

export async function replayMission(input: MissionReplayInput): Promise<MissionReplay> {
  const store = createMemoryStore();
  const target = `msn_replay_${input.fixture.slice(4, 12)}`;
  const planning = replayGateway(input.fixture, catalog, store, target, { ...input.replay });
  const transformed = input.transformPlanningPage
    ? { async tregCall(call: { endpoint_id?: unknown; params?: unknown; purpose?: unknown }) {
        const out = (await planning.gateway.tregCall(call)) as { ok?: boolean; call_id?: string };
        if (out.ok && out.call_id) { const path = `${target}/${RAW_PATH(out.call_id)}`; const body = store.files.get(path); if (typeof body === "string") store.files.set(path, JSON.stringify(input.transformPlanningPage!(String(call.endpoint_id), JSON.parse(body)))); }
        return out;
      } }
    : planning.gateway;
  const planned = await planByCompiler({
    mission: { id: target, request_text: input.request, answer_text: input.answer ?? null, created_at: input.createdAt },
    gateway: transformed as never, store, catalog, nowMs: Date.parse(input.planningAt),
    ...(input.edits ? { edits: input.edits } : {}), ...(input.occurrence ? { occurrence: input.occurrence } : {}), ...(input.catalogOnly ? { catalogOnly: true } : {}),
  });
  if (planned.kind !== "plan") throw new Error(`no plan for ${input.fixture}: ${planned.kind}${"reason" in planned ? ` ${planned.reason}` : ""}`);
  const plan = planned.plan;
  input.adjustPlan?.(plan);
  const exec = replayGateway(input.fixture, catalog, store, target, { ...input.replay, phase: "execution", firstSeq: 100 });
  const items = await ItemStore.open(store, target);
  const platformFlags: PlatformFlags = { [input.platform]: "test" } as PlatformFlags;
  await runEngine({ items, store, plan: withPromiseCaps(plan), missionId: target, gateway: exec.gateway as unknown as Gateway, sandbox: (code, inputs) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, now: () => Date.parse(input.readAt), redesignStages: redesignStagesOf(plan, TYPES_OFF, true, platformFlags) });
  // THE END OF A RUN, as runMission.ts does it
  const snap = items.snapshotOfMemory();
  let judged = withPromiseCaps(plan);
  const rowsByStage: Record<string, Array<Record<string, unknown>>> = {};
  for (const s of judged.stages) rowsByStage[s.key] = snap.acceptedRows(s.key, s.planned_rows);
  judged = reportedPlan(judged, Object.fromEntries(judged.stages.map((s) => [s.key, rowsByStage[s.key].length])));
  const hadOpen = judged.stages.some((s) => s.replies_open || s.children_open);
  if (hadOpen) judged = withRepliesJudged(judged, rowsByStage, (k) => { const st = snap.stage(k).stop; return !st || st === "source_exhausted"; });
  const built = await buildMissionFiles(judged, rowsByStage, missionFactsOf({ requestText: input.request, plan: judged, snap, reviewStop: null, deliveredAt: new Date(input.readAt) }), companyMailboxesOf(judged, snap), { ...(hadOpen ? { repliesJudged: true } : {}), approvedPlan: planned.plan, now: Date.parse(input.readAt) });
  return { planned, plan: judged, rowsByStage, built, unservedPlanning: planning.stats.unserved.length, unservedExecution: exec.stats.unserved.length, unserved: [...planning.stats.unserved, ...exec.stats.unserved] };
}

export const storedRows = (fixture: string, stage: string): Array<Record<string, unknown>> => JSON.parse(readFileSync(new URL(`../fixtures/live/missions/${fixture}/rows/${stage}.json`, import.meta.url), "utf8"));
export { layoutOf };
