import { AGENT_COLLECT_MAX_PAGES } from "../../../src/lib/agentMission/constants";
import type { EngineSpec, PricedPlan } from "../../../src/lib/agentMission/plan";
import type { Gateway } from "../gateway";
import { RAW_PATH } from "../gateway";
import { rankPeopleByRole } from "../../../src/lib/agentMission/roles";
import { drainPending, emitStageProgress, ingestRows } from "../items/ingest";
import type { ItemStore, Row, StopReason } from "../items/itemStore";
import type { Reviewer } from "../review";
import type { SandboxResult } from "../sandbox";
import type { AgentStore, MissionEventInput } from "../types";

type Stage = PricedPlan["stages"][number];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Pages one stage may read in all (a safety net above the call budget, which is what normally ends a long read). */
export const ENGINE_MAX_PAGES_PER_STAGE = Math.max(AGENT_COLLECT_MAX_PAGES, 400);
/**
 * The pages one stage may read: the safety net above, or twice the items the stage is sold when that is more (a source that gives five items a page needs a thousand pages for five thousand items: a mission of that size must not stop at the net). What really ends a
 * long read is still the call budget, the time, the source's end and the pages that add nothing; this only stops a read that never ends.
 */
export const enginePageCapFor = (plannedRows: number): number => Math.max(ENGINE_MAX_PAGES_PER_STAGE, Math.max(0, Math.floor(plannedRows)) * 2);
/** Pages in a row with no new item accepted, once the review has no budget left and items are waiting: the stage stops with the review limit as its reason instead of buying pages it cannot use. */
const REVIEW_STALL_PAGES = 3;
/** Pages in a row that give no new item at all (the source repeats itself). */
const BARREN_PAGES = 2;

export interface EngineDeps {
  items: ItemStore;
  store: AgentStore;
  plan: PricedPlan;
  missionId: string;
  gateway: Gateway;
  sandbox: (code: string, inputs: Record<string, unknown>) => Promise<SandboxResult>;
  reviewer?: Reviewer;
  addEvent: (event: MissionEventInput) => Promise<void>;
  now?: () => number;
  /** Absolute time (ms) after which no new page is read. */
  deadlineMs: number;
  maxPagesPerStage?: number;
  /** Asked before every page: a reason (the worker's memory guard) stops the run so the mission can be put back in the queue with everything it saved. */
  shouldStop?: () => string | null;
  log?: (line: string) => void;
}

export interface EngineOutcome {
  /** The recorded stop reason of every stage. */
  stops: Record<string, StopReason>;
  /** Set when the run was stopped from outside (memory): nothing is settled, the mission resumes. */
  aborted: string | null;
}

const refusalStop = (code: string): StopReason => (code === "over_budget" ? "budget" : code === "daily_cap" || code === "daily_limit" ? "daily_cap" : "refused");

/**
 * THE ENGINE: carries out the approved plan with no model in the loop. For each stage, in order: read the source page after page (RESUMING from the cursor the log recorded, never restarting), map each page with the plan's
 * proven mapping code, check and store every item through the one item store (rule first; the model only for what the rule cannot decide, in batches, within the review budget), and go on until the matching items
 * the customer bought are saved or a stop reason is RECORDED: the source has no more, the call budget or the provider's daily limit refused, the time is up, the review has no budget left for what is waiting, or a page failed.
 * It cannot lose an item (the log is append-only), double count one (the store de-duplicates by id) or stop early (the only exits are the recorded reasons).
 */
export async function runEngine(deps: EngineDeps): Promise<EngineOutcome> {
  const { items, plan } = deps;
  const stops: Record<string, StopReason> = {};
  for (const stage of plan.stages) {
    const spec = stage.engine;
    if (!spec) throw new Error(`stage ${stage.key} has no engine recipe`);
    const outcome = await runStage(deps, stage, spec);
    if (outcome.aborted) return { stops, aborted: outcome.aborted };
    // items the review could not reach are asked once more at the end of the stage (a late good item is never lost)
    await drainPending(deps, stage);
    const counts = items.counts(stage.key);
    let reason = outcome.reason;
    // THE SOURCE GAVE ITEMS AND NONE WAS STORED: our own mapping or save failed. That is an internal failure, never «the source has nothing»: recorded as its own reason so the settlement releases the hold whole, tells the customer the truth and flags the admin
    const sourceRows = items.stage(stage.key).sourceRows;
    if (outcome.reason === "internal_error" || (counts.new === 0 && counts.duplicates === 0 && sourceRows > 0)) reason = "internal_error";
    else if (counts.accepted >= stage.planned_rows) reason = "target_reached";
    else if (counts.pending > 0 && deps.reviewer && (await deps.reviewer.state()).stop && (reason === "source_exhausted" || reason === "no_new_items" || reason === "review_limit")) reason = (await deps.reviewer.state()).stop === "failed" ? "failed" : "review_limit";
    stops[stage.key] = reason;
    await items.commit([{ t: "stop", stage: stage.key, reason }]);
  }
  return { stops, aborted: null };
}

async function runStage(deps: EngineDeps, stage: Stage, spec: EngineSpec): Promise<{ reason: StopReason; aborted: string | null }> {
  const { items } = deps;
  if (stage.parent_key === null) return runStream(deps, stage, spec, "root", { ...spec.params }, null, Number.POSITIVE_INFINITY);
  const parentRows = items.acceptedRows(stage.parent_key);
  if (parentRows.length === 0 || !spec.parent_binding) return { reason: "no_parents", aborted: null };
  let last: StopReason = "source_exhausted";
  let failedInARow = 0;
  let anyFailed = false;
  // EVERY PARENT IS READ, each up to its own share, in the source's order. The share is the customer's number per parent. When the stage's total is lower than parents x that number (the model's own, smaller target) the share is an equal part of the total:
  // the first parent never takes all of it while the others have children. There is no second round: a page's rows beyond a parent's share are kept out, and reading the next page of that parent would skip them (a child list is delivered in the source's order).
  const per = stage.per_parent_rows ?? Number.POSITIVE_INFINITY;
  const fair = Math.max(1, Math.ceil(stage.planned_rows / parentRows.length));
  const rounds = [Math.min(per, fair)];
  for (const cap of rounds) {
    for (const parent of parentRows) {
      if (items.counts(stage.key).accepted >= stage.planned_rows) return { reason: "target_reached", aborted: null };
      const parentId = String(parent.id);
      const bound = parent[spec.parent_binding.from];
      if (bound === undefined || bound === null || bound === "") continue;
      const params = { ...spec.params, [spec.parent_binding.param]: bound };
      const r = await runStream(deps, stage, spec, `p:${parentId}`, params, parentId, cap);
      if (r.aborted) return r;
      // a stop that ends the whole stage (the budget, the daily limit, the time, a refusal) is not «this parent has no more»
      if (r.reason === "budget" || r.reason === "daily_cap" || r.reason === "refused" || r.reason === "time_limit" || r.reason === "review_limit" || r.reason === "page_limit") return r;
      // one parent whose read failed twice is skipped (the others may well be read); three in a row end the stage with that reason
      if (r.reason === "failed") { failedInARow += 1; anyFailed = true; if (failedInARow >= 3) return r; continue; }
      failedInARow = 0;
      last = r.reason;
    }
  }
  // a read that failed for some parent is the recorded reason when the volume was not reached (never «the source has no more»)
  return { reason: items.counts(stage.key).accepted >= stage.planned_rows ? "target_reached" : anyFailed ? "failed" : last === "target_reached" ? "source_exhausted" : last, aborted: null };
}

/** One stream of pages (a whole source, or one parent's children): resumes from the log, stops on a recorded reason. */
async function runStream(deps: EngineDeps, stage: Stage, spec: EngineSpec, streamKey: string, params: Record<string, unknown>, parentId: string | null, perParentCap: number): Promise<{ reason: StopReason; aborted: string | null }> {
  const { items, store, gateway } = deps;
  const now = deps.now ?? Date.now;
  const maxPages = deps.maxPagesPerStage ?? enginePageCapFor(stage.planned_rows);
  let stallStreak = 0;
  let failures = 0;
  for (;;) {
    const counts = items.counts(stage.key);
    if (counts.accepted >= stage.planned_rows) return { reason: "target_reached", aborted: null };
    const state = items.streamState(stage.key, streamKey);
    if (state?.ended) return { reason: "source_exhausted", aborted: null };
    if (state && state.barren >= BARREN_PAGES) return { reason: "no_new_items", aborted: null };
    if (parentId !== null && items.acceptedRows(stage.key).filter((r) => String(r.parent_id) === parentId).length >= perParentCap) return { reason: "target_reached", aborted: null };
    if (counts.pages >= maxPages) return { reason: "page_limit", aborted: null };
    if (now() >= deps.deadlineMs) return { reason: "time_limit", aborted: null };
    const outside = deps.shouldStop?.() ?? null;
    if (outside) return { reason: "failed", aborted: outside };

    // a source paged by a PAGE NUMBER (a numeric `page` input the measuring call gave) is read page by page: the next number, until a page comes back empty (or repeats itself, which the barren-page rule ends)
    const pageMode = spec.cursor_param === "page" && Number.isFinite(Number(params.page));
    const cursor = state?.cursor ?? null;
    const callParams = cursor && spec.cursor_param ? { ...params, [spec.cursor_param]: pageMode ? Number(cursor) : cursor } : params;
    const result = await gateway.tregCall({ endpoint_id: spec.endpoint_id, params: callParams });
    if (!result.ok) {
      if ("refused" in result) return { reason: refusalStop(result.refused), aborted: null };
      // a page that failed is asked once more; a second failure ends the stream with that reason (what was saved stays saved)
      failures += 1;
      if (failures >= 2) return { reason: "failed", aborted: null };
      continue;
    }
    failures = 0;
    const raw = await store.getFile(deps.missionId, RAW_PATH(result.call_id));
    let page: unknown = null;
    try { page = raw === null ? null : JSON.parse(raw); } catch { page = null; }
    if (page === null) return { reason: "failed", aborted: null };
    const mapped = await deps.sandbox(spec.map_code, { [spec.map_file_id]: page });
    // the mapping is OURS: a mapping that fails on a page the source gave is our failure (an internal one while nothing has been stored yet), never «the source failed»
    const mapFailed = (): { reason: StopReason; aborted: null } => ({ reason: items.counts(stage.key).new === 0 ? "internal_error" : "failed", aborted: null });
    if (!mapped.ok || mapped.resultJson === null) { deps.log?.(`engine_map_failed ${deps.missionId} ${mapped.ok ? "no result" : mapped.error.slice(0, 80)}`); return mapFailed(); }
    let rows: unknown;
    try { rows = JSON.parse(mapped.resultJson); } catch { rows = null; }
    if (!Array.isArray(rows)) return mapFailed();
    // THE ROLE THE CUSTOMER NAMED among the people of a parent: the people whose job title names it come first (roles.ts), so the parent's share is taken from the top; the page's order is kept inside each group, and a page with no title field is untouched
    const ranked = parentId !== null && stage.role_preference ? rankPeopleByRole(rows.filter(isObject), stage.role_preference.role).rows : rows.filter(isObject);
    const incoming: Row[] = ranked.map((r) => (parentId !== null ? { ...r, parent_id: parentId } : r));
    const nextCursor = pageMode ? (result.rows_in_page > 0 ? String((cursor !== null ? Number(cursor) : Number(params.page)) + 1) : null) : result.next_cursor ?? null;
    const ended = pageMode ? result.rows_in_page === 0 : !nextCursor || result.rows_in_page === 0 || result.has_more === false || !spec.cursor_param;
    const before = items.counts(stage.key).accepted;
    // a parent's share (per_parent_rows) is a cap on what this page may add for it
    const have = parentId !== null ? items.acceptedRows(stage.key).filter((r) => String(r.parent_id) === parentId).length : 0;
    await ingestRows(deps, stage, incoming, { silent: true, idField: spec.id_field ?? null, ...(parentId !== null && Number.isFinite(perParentCap) ? { acceptCap: Math.max(0, perParentCap - have) } : {}), page: { stream: streamKey, call_id: result.call_id, cursor_in: cursor, cursor_next: nextCursor, has_more: result.has_more, ended, rows_in_page: result.rows_in_page } });
    await emitStageProgress(deps, stage, { collecting: true });
    // the review had nothing left to give while items still wait: pages that add nothing are not bought for ever
    const after = items.counts(stage.key);
    if (after.accepted === before && after.pending > 0 && deps.reviewer && (await deps.reviewer.state()).stop) stallStreak += 1; else stallStreak = 0;
    if (stallStreak >= REVIEW_STALL_PAGES) return { reason: "review_limit", aborted: null };
  }
}
