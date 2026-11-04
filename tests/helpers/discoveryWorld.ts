import { createMemoryStore, newMission } from "../../agent/src/memoryStore";
import { planByCompiler, type CompiledPlanning, type CompiledPlanningDeps, type WithCost } from "../../agent/src/compiled";
import { ItemStore } from "../../agent/src/items/itemStore";
import { runEngine } from "../../agent/src/engine/run";
import { runInSandbox } from "../../agent/src/sandbox";
import { RAW_PATH, type Gateway } from "../../agent/src/gateway";
import { buildMissionFiles } from "../../agent/src/workbook";
import { missionFactsOf } from "../../agent/src/methodology";
import { companyMailboxesOf } from "../../agent/src/runMission";
import { reportedPlan, withPromiseCaps, withRepliesJudged } from "../../src/lib/agentMission/repliesCard";
import { buildShapeDigest } from "../../src/lib/modelPlanner/digest";
import { loadTregCatalog, type CatalogEndpoint } from "../../src/lib/treg/catalog";
import { NO_SENSITIVE_ACCESS } from "../../src/lib/treg/dataPolicy";
import { cardsWithDiscovery, chainCheckerFor } from "../../src/lib/agentMission/foundation/discovery";
import type { PlatformFlags } from "../../src/lib/agentMission/redesignFlagTypes";
import type { PricedPlan } from "../../src/lib/agentMission/plan";

/**
 * ROUND 33, THE DISCOVERY WORLD: the real planner (`planByCompiler`), the real engine, the real item store, the real sandbox and the real workbook builder over a SCRIPTED provider.
 * EVIDENCE LABELS (kept apart on purpose):
 *  - `catalogPage(...)`: a page built from the catalog's OWN example answer of an endpoint (`example_response_trimmed`, the provider's documented shape) with the rows this test writes. It is SIMULATED evidence: it proves how our code reads that shape, never that the provider answered so.
 *  - pages read from `tests/fixtures/live/**` by the tests that use them are REAL stored provider pages (anonymised).
 * No network, no paid call: the scripted gateway is the only provider.
 */
export const catalog = loadTregCatalog();
export type Page = Record<string, unknown>;
export type Handler = (params: Record<string, unknown>, nth: number) => Page | "fail" | "refused";
export const GATEWAY_SAMPLES_PER_SOURCE = 2;

/** A page in the catalog's documented shape: the example answer's envelope with `rows` at the endpoint's list path and `next` at its cursor path (a missing `next` leaves the cursor out: the last page). */
export function catalogPage(endpointId: string, rows: Array<Record<string, unknown>>, next?: string | null): Page {
  const e = catalog.byId.get(endpointId) as CatalogEndpoint;
  const out = structuredClone(e.example_response_trimmed ?? {}) as Page;
  const put = (path: string, value: unknown) => {
    const keys = path.split(".");
    let o: Record<string, unknown> = out;
    for (const k of keys.slice(0, -1)) { if (typeof o[k] !== "object" || o[k] === null) o[k] = {}; o = o[k] as Record<string, unknown>; }
    o[keys[keys.length - 1]] = value;
  };
  put(e.list_path!, rows);
  const cursorPath = e.cursor_path ?? (e.id === "anyapi.instagram.user.posts" ? "output.data.nextCursor" : null);
  if (cursorPath) put(cursorPath, next ?? null);
  return out;
}

export interface World {
  /** The phase the next calls belong to: `deliver` switches it to «execution» (a delegate serves the stored REAL pages of each phase). */
  phase: "planning" | "execution";
  store: ReturnType<typeof createMemoryStore>;
  calls: Array<{ endpoint: string; params: Record<string, unknown>; ok: boolean }>;
  /** The calls made while the engine ran (after `deliver` switched the phase): a read at planning and the same read at execution are two phases, not one repeated call. */
  executionCalls: Array<{ endpoint: string; params: Record<string, unknown>; ok: boolean }>;
  gateway: { tregCall: (input: { endpoint_id?: unknown; params?: unknown; purpose?: unknown }) => Promise<unknown> };
  plan: (over?: Partial<CompiledPlanningDeps> & { request?: string; answer?: string | null; created?: string }) => Promise<WithCost<CompiledPlanning>>;
  endpoints: () => string[];
}

export function discoveryWorld(request: string, handlers: Record<string, Handler>, options: { discovery?: boolean; platform?: "youtube" | "instagram"; missionId?: string; /** The store the pages are saved in (a delegate gateway must write into the same one). */ store?: ReturnType<typeof createMemoryStore>; /** An endpoint with no handler is served by the delegate of the current phase (the stored REAL pages of a live mission, through the replay gateway), else it is a call nobody scripted. */ delegates?: Partial<Record<"planning" | "execution", { tregCall: (input: { endpoint_id?: unknown; params?: unknown; purpose?: unknown }) => Promise<unknown> }>> } = {}): World {
  const store = options.store ?? createMemoryStore();
  const missionId = options.missionId ?? "msn_r33_1";
  store.missions.set(missionId, newMission({ id: missionId, user_id: "u", request_text: request, status: "planning", created_at: "2026-11-04T18:00:00Z" }));
  const calls: World["calls"] = [];
  const executionCalls: World["executionCalls"] = [];
  const record = (c: World["calls"][number]): void => { calls.push(c); if (world.phase === "execution") executionCalls.push(c); };
  const counts: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let seq = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown; purpose?: unknown }) {
      const endpoint = String(input.endpoint_id);
      const params = (input.params ?? {}) as Record<string, unknown>;
      const handler = handlers[endpoint];
      const delegate = world.phase === "planning" ? options.delegates?.planning : options.delegates?.execution;
      if (!handler && delegate) { const out = (await delegate.tregCall(input)) as { ok?: boolean }; record({ endpoint, params, ok: out.ok === true }); return out; }
      // the gateway's own cap: at most two reads of one source (the first page and its next page) while planning
      const key = endpoint;
      bySource[key] = (bySource[key] ?? 0) + 1;
      if (bySource[key] > GATEWAY_SAMPLES_PER_SOURCE + 6) { record({ endpoint, params, ok: false }); return { ok: false as const, call_id: "x", refused: "repeat_sample", message: "cap" }; }
      counts[endpoint] = (counts[endpoint] ?? 0) + 1;
      if (!handler) { record({ endpoint, params, ok: false }); return { ok: false as const, call_id: "x", failed: true, http_status: 404, message: "no handler: a call nobody scripted" }; }
      const out = handler(params, counts[endpoint]);
      if (out === "refused") { record({ endpoint, params, ok: false }); return { ok: false as const, call_id: "x", refused: "over_budget", message: "over budget" }; }
      if (out === "fail") { record({ endpoint, params, ok: false }); return { ok: false as const, call_id: "x", failed: true, http_status: 500, message: "boom" }; }
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      await store.putFile(missionId, RAW_PATH(callId), JSON.stringify(out), "application/json");
      const e = catalog.byId.get(endpoint);
      const reading = e ? buildShapeDigest(out, e as never).reading : null;
      record({ endpoint, params, ok: true });
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: reading?.rows.length ?? 0, has_more: reading?.hasMore ?? null, next_cursor: reading?.nextCursor ?? null, shape: null, first_rows: [], warnings: [], saved: "" };
    },
  };
  const platform = options.platform;
  const discovered = options.discovery && platform ? cardsWithDiscovery(catalog, platform, NO_SENSITIVE_ACCESS) : null;
  const world: World = {
    phase: "planning",
    store, calls, executionCalls, gateway,
    endpoints: () => calls.map((c) => c.endpoint),
    plan: (over = {}) => planByCompiler({
      mission: { id: missionId, request_text: over.request ?? request, answer_text: over.answer ?? null, created_at: over.created ?? "2026-11-04T18:00:00Z" },
      gateway: gateway as never, store, catalog, nowMs: Date.parse("2026-11-04T18:00:20Z"), catalogOnly: true,
      ...(discovered ? { cards: discovered.cards, chainIssues: chainCheckerFor(catalog, NO_SENSITIVE_ACCESS) } : {}),
      ...over,
    } as CompiledPlanningDeps),
  };
  return world;
}

/** Runs an approved plan through the real engine over the same scripted provider, then builds the Excel and the CSV exactly as the worker does at the end of a run. */
export async function deliver(world: World, plan: PricedPlan, request: string, platform: keyof PlatformFlags & string) {
  world.phase = "execution";
  const target = world.store.missions.keys().next().value as string;
  const items = await ItemStore.open(world.store, target);
  const approved = withPromiseCaps(plan);
  const gw = world.gateway as unknown as Gateway;
  const outcome = await runEngine({ items, store: world.store, plan: approved, missionId: target, gateway: gw, sandbox: (code, inputs) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, now: () => Date.parse("2026-11-04T18:10:00Z"), redesignStages: new Set(approved.stages.map((s) => s.key)) });
  const snap = items.snapshotOfMemory();
  let judged = approved;
  const rowsByStage: Record<string, Array<Record<string, unknown>>> = {};
  for (const s of judged.stages) rowsByStage[s.key] = snap.acceptedRows(s.key, s.planned_rows);
  judged = reportedPlan(judged, Object.fromEntries(judged.stages.map((s) => [s.key, rowsByStage[s.key].length])));
  const hadOpen = judged.stages.some((s) => s.replies_open || s.children_open);
  if (hadOpen) judged = withRepliesJudged(judged, rowsByStage, (k) => { const st = snap.stage(k).stop; return !st || st === "source_exhausted"; });
  const built = await buildMissionFiles(judged, rowsByStage, missionFactsOf({ requestText: request, plan: judged, snap, reviewStop: null, deliveredAt: new Date("2026-11-04T18:10:00Z") }), companyMailboxesOf(judged, snap), { ...(hadOpen ? { repliesJudged: true } : {}), approvedPlan: plan, now: Date.parse("2026-11-04T18:10:00Z") });
  void platform;
  return { outcome, plan: judged, rowsByStage, built, snap };
}
