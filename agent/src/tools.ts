import { AGENT_COLLECT_MAX_PAGES, AGENT_INLINE_ROWS_MAX, SANDBOX_INLINE_RESULT_CHARS } from "../../src/lib/agentMission/constants";
import { normalizeText } from "../../src/lib/agentMission/relevance";
import type { MissionPricingSettings } from "../../src/lib/missionPricing";
import { isContactSource } from "../../src/lib/agentMission/contacts";
import { describeAgentSource, isAgentSourceId, searchAgentSources, SESSION_RESTRICTED_SOURCES } from "../../src/lib/agentMission/sources";
import { validateAndPricePlan, type PricedPlan, type RecordedCall } from "../../src/lib/agentMission/plan";
import { checkCustomerText } from "../../src/lib/agentMission/text";
import { blockedEndpointReason } from "../../src/lib/treg/blockList";
import { isSellable, type TregCatalog } from "../../src/lib/treg/catalog";
import { policyVerdict, type AccountAccess } from "../../src/lib/treg/dataPolicy";
import { digestValue } from "../../src/lib/modelPlanner/digest";
import type { Gateway } from "./gateway";
import { RAW_PATH } from "./gateway";
import type { WebGateway } from "./webGateway";
import { runInSandbox, type SandboxResult } from "./sandbox";
import type { Reviewer } from "./review";
import { ItemStore, readSnapshot, type StopReason } from "./items/itemStore";
import { drainPending, ingestRows } from "./items/ingest";
import { mirrorLegacyFiles } from "./items/mirror";
import { codeRunPath, deriveEngineSpecs, type CodeRun } from "./engine/spec";
import type { AgentStore, CallPhase, MissionRecord } from "./types";

/**
 * The tools the agent has, and the only ones: three gateway tools (catalog_search, describe_endpoint, treg_call), the sandboxed run_code, and the mission tools (report_progress,
 * ask_question, propose_plan, save_rows, finish). Each tool is a plain async function over a `ToolContext`, so the SDK server (sdkRuntime.ts) and the tests use the SAME handlers.
 * Every rule that matters is enforced here in code, not left to the prompt.
 */
export type ParamType = "string" | "number" | "boolean" | "object" | "array" | "string[]";
export interface ParamSpec { type: ParamType; description: string; optional?: boolean }
export interface ToolSpec {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  phases: CallPhase[];
  handler: (args: Record<string, any>) => Promise<Record<string, unknown>>;
}

export interface RunState {
  proposedPlan: PricedPlan | null;
  question: string | null;
  finish: { outcome: "delivered" | "cannot_serve"; summary_ar: string } | null;
  outSeq: number;
  /** Set when the run has reached an end the model must stop at (a plan, a question, finish). */
  terminal: boolean;
  /** The ids of the last catalog_search, cheapest first (by code): a source ranked below one that was not tried needs a stated reason (`why`). */
  ranking: string[] | null;
  /** The sources this run has called (or been refused a call to). */
  tried: Set<string>;
  /** The full inputs of every treg_call of this run, by call id (the call log keeps short values only): the plan's execution recipe is derived from them. */
  callParams: Map<string, Record<string, unknown>>;
  /** The code of every run_code of this run, by output id: the plan's execution recipe is derived from the mapping code the agent ran on the measured page. */
  codeRuns: Map<string, CodeRun>;
  /** How many times finish was refused because matching items were still needed and the source had more (a limit: the model is never stuck for ever). */
  finishRefusals: number;
  /** Per source stream (a collect_pages source and its inputs): whether the last read says the source has more pages. */
  moreAvailable: Map<string, boolean>;
}
export const newRunState = (outSeq = 0): RunState => ({ proposedPlan: null, question: null, finish: null, outSeq, terminal: false, ranking: null, tried: new Set(), callParams: new Map(), codeRuns: new Map(), finishRefusals: 0, moreAvailable: new Map() });
/** The most times finish is refused for the same reason in one run. */
export const FINISH_REFUSALS_MAX = 3;

export interface ToolContext {
  phase: CallPhase;
  mission: MissionRecord;
  /** The approved plan (execution phase). */
  plan: PricedPlan | null;
  store: AgentStore;
  gateway: Gateway;
  /** The page parsers, web search / scrape and people search; absent when no provider key store is wired (the tools are then not offered). */
  web?: WebGateway;
  catalog: TregCatalog;
  access: AccountAccess;
  state: RunState;
  sandbox?: (code: string, inputs: Record<string, unknown>) => Promise<SandboxResult>;
  /** The model review of uncertain rows (execution phase), within the review budget; absent: uncertain rows are not delivered. */
  review?: Reviewer;
  /** The markup and the minimum charge in force when the plan is priced. */
  pricingSettings?: MissionPricingSettings;
  /** The mission's one item store (execution phase). Opened on first use when the caller gave none. */
  items?: ItemStore;
}

const FILE_ID = /^(call|out)_\d{4,6}$/;
/** The phrases of a summary that admit the rows were not filtered (normalised Arabic: no diacritics, ta marbuta as ha). */
const UNFILTERED_ADMISSION = {
  test: (text: string): boolean => {
    const ar = "[\\u0621-\\u064A]";
    const patterns = [
      new RegExp(`(?:لم|لا)\\s+[تي]?(?:صف|فلتر)(?:ي|ت|ا|وا)?(?!${ar})`),
      /(?:لم|لا)\s+(?:تتم|يتم|تجر|يجر)\s+(?:ال)?(?:تصفيه|فلتره)/,
      new RegExp(`غير\\s+م?(?:صف|فلتر)(?:ي|ه|ات|اه|ا)?(?!${ar})`),
      /(?:بدون|دون)\s+(?:ال)?(?:تصفيه|فلتره|فلتر)/,
      /(?:قد\s+)?(?:تشمل|تتضمن|تحتوي|تضم)\s+(?:علي\s+)?(?:بعض\s+)?(?:ردود|اسماء\s+مشابهه|اشخاص\s+اخر)/,
    ];
    return patterns.some((r) => r.test(text));
  },
};
const pathOfFile = (id: string) => (id.startsWith("call_") ? `raw/${id}.json` : `out/${id}.json`);
const ROWS_PATH = (stageKey: string) => `rows/${stageKey}.json`;
/** The rows of a stage that did not match the request (never delivered, never charged): kept with the reason for the review sheet of the files. */
export const EXCLUDED_PATH = (stageKey: string) => `excluded/${stageKey}.json`;
const outId = (n: number) => `out_${String(n).padStart(4, "0")}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const err = (error: string, extra: Record<string, unknown> = {}) => ({ ok: false, error, ...extra });

function previewOf(value: unknown): unknown {
  if (Array.isArray(value)) return { type: "array", length: value.length, first_items: value.slice(0, 5).map((v) => digestValue(v)) };
  if (isObject(value)) return { type: "object", keys: Object.keys(value).slice(0, 30), sample: digestValue(value) };
  return value;
}

/**
 * Unique final rows of the delivered stages that were saved (each already linked to a real parent row by the check), never above the approved volume. Read FRESH from the item store (the log is listed and every segment read), never
 * from a copy in memory or from an object that may have been overwritten. A mission an older worker started (rows in `rows/<stage>.json`, no log) is read from that file.
 */
export async function countDeliveredRows(store: AgentStore, missionId: string, plan: PricedPlan): Promise<{ delivered: number; perStage: Record<string, number> }> {
  const snap = await readSnapshot(store, missionId);
  const perStage: Record<string, number> = {};
  let delivered = 0;
  for (const stage of plan.stages) {
    let n = snap.counts(stage.key).accepted;
    if (snap.stage(stage.key).items.size === 0) {
      const raw = await store.getFile(missionId, ROWS_PATH(stage.key));
      try { n = raw ? (JSON.parse(raw) as unknown[]).length : 0; } catch { n = 0; }
    }
    perStage[stage.key] = n;
    if (stage.deliver) delivered += n;
  }
  return { delivered: Math.min(delivered, plan.price.deliveredRows), perStage };
}

/** CHEAPEST SUITABLE SOURCE FIRST, in code: a source that ranks below one the last catalog_search listed above it (cheaper per row) and that was not tried needs a stated reason, kept in the call log for the admin. */
export function cheapestFirstMessage(state: RunState, id: string, why: unknown): string | null {
  const ranking = state.ranking;
  if (!ranking) return null;
  const at = ranking.indexOf(id);
  if (at <= 0) return null;
  if (String(why ?? "").trim().length >= 8) return null;
  const untried = ranking.slice(0, at).filter((x) => !state.tried.has(x));
  return untried.length > 0 ? `a cheaper source of the last catalog_search has not been tried (${untried.slice(0, 3).join(", ")}): sample it first, or pass \`why\` (at least 8 characters) saying why it is unsuitable` : null;
}

/** The sources of the last catalog_search that have not been tried yet, cheapest first: what a failed sample moves on to. */
export const untriedSources = (state: RunState, except: string, n = 3): string[] => (state.ranking ?? []).filter((x) => x !== except && !state.tried.has(x)).slice(0, n);

const valueAt = (value: unknown, path: string | null | undefined): unknown => {
  if (!path || path === "root") return value;
  let cur: any = value;
  for (const part of path.split(".")) { if (cur === null || cur === undefined) return undefined; cur = cur[part]; }
  return cur;
};
const ROW_KEY_FIELDS = ["id", "post_id", "comment_id", "review_id", "place_id", "shortcode", "video_id", "personID", "url"];
const rowKeyOf = (row: unknown): string => {
  if (row && typeof row === "object") for (const k of ROW_KEY_FIELDS) { const v = (row as Record<string, unknown>)[k]; if (typeof v === "string" || typeof v === "number") return `${k}:${v}`; }
  return JSON.stringify(row);
};

/**
 * THE POSITION OF A SOURCE READ (collect_pages) IS IN THE ITEM STORE'S LOG, never in an object that is overwritten: the cursor after the last page, the pages read and whether the source ended are page records of the pseudo stage
 * «_collect» (one per collect_pages call, create-only). A later call, in this run or after a restart, resumes from the newest record; an overwritten state object could be served stale and restart a source already paid for.
 */
const COLLECT_STAGE = "_collect";
interface CollectStream { cursor: string | null; ended: boolean; pages: number; seen: string[] }
/** A stable short key of the endpoint, the first-page inputs and the cursor input: the same source asked the same way is the same stream. */
function collectStreamKey(endpointId: string, params: Record<string, unknown>, cursorParam: string): string {
  const text = JSON.stringify([endpointId, cursorParam, Object.keys(params).filter((k) => k !== cursorParam).sort().map((k) => [k, params[k]])]);
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(7, "0");
}

const stageLocks = new Map<string, Promise<void>>();
export async function withStageLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = stageLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = before.then(() => mine);
  stageLocks.set(key, tail);
  await before;
  try { return await fn(); } finally { release(); if (stageLocks.get(key) === tail) stageLocks.delete(key); }
}

export function buildTools(ctx: ToolContext): ToolSpec[] {
  const { store, mission, gateway, state } = ctx;
  const runSandbox = ctx.sandbox ?? ((code: string, inputs: Record<string, unknown>) => runInSandbox(code, inputs));

  const loadFileIds = async (ids: string[]): Promise<{ ok: true; inputs: Record<string, unknown> } | { ok: false; error: string }> => {
    const inputs: Record<string, unknown> = {};
    for (const id of ids) {
      if (!FILE_ID.test(id)) return { ok: false, error: `«${id}» is not a file id of this mission (call_0001, out_0001 ...)` };
      const text = await store.getFile(mission.id, pathOfFile(id));
      if (text === null) return { ok: false, error: `«${id}» does not exist in this mission` };
      try { inputs[id] = JSON.parse(text); } catch { return { ok: false, error: `«${id}» is not valid JSON` }; }
    }
    return { ok: true, inputs };
  };

  /** The mission's one item store, opened on first use (a mission an older worker started is imported from its `rows/` files once). */
  let itemsOpening: Promise<ItemStore> | null = null;
  const getItems = (): Promise<ItemStore> => {
    if (ctx.items) return Promise.resolve(ctx.items);
    itemsOpening ??= ItemStore.open(store, mission.id, { legacyStages: (ctx.plan?.stages ?? []).map((s) => s.key) }).then((i) => (ctx.items = i));
    return itemsOpening;
  };
  /** The seen raw rows of the collect streams of THIS run (a later call returns only new rows); the position itself is in the log. */
  const collectSeen = new Map<string, Set<string>>();

  /**
   * THE CHECK AND SAVE OF ROWS OF ONE STAGE, for the model's save_rows and for finish: the same ingest the engine uses (de-duplicate, check by rule, review only the ambiguous within the budget, one atomic segment in the item store).
   * The older files (`rows/`, `excluded/`, `checks.json`) are rewritten from the store afterwards for the admin page and the older readers.
   */
  const checkAndSaveRows = async (stage: PricedPlan["stages"][number], incoming: unknown[]): Promise<Record<string, unknown>> => {
    const plan = ctx.plan!;
    const items = await getItems();
    const result = await ingestRows({ items, plan, reviewer: ctx.review, addEvent: (e) => store.addEvent(mission.id, e) }, stage, incoming);
    await mirrorLegacyFiles(items, store, plan, [stage.key]);
    const { counts: _counts, newlyAccepted: _n, ...visible } = result;
    return visible;
  };

  const tools: ToolSpec[] = [
    {
      name: "catalog_search",
      description: "Search the catalog of data sources by platform and English words (translate the customer's words). Returns candidates sorted by cost per record, cheapest first, with their required inputs. Use the ids exactly as returned.",
      phases: ["planning", "execution"],
      params: {
        words: { type: "string[]", description: "English keywords, e.g. [\"tweets\", \"search\"]" },
        platform: { type: "string", description: "Platform filter, e.g. \"x\" or \"youtube\"", optional: true },
        limit: { type: "number", description: "At most this many candidates (1 to 10)", optional: true },
      },
      handler: async (a) => {
        const words = Array.isArray(a.words) ? a.words.map(String) : [];
        const limit = Math.max(1, Math.min(10, Math.floor(Number(a.limit) || 8)));
        const found = gateway.catalogSearch({ words, platform: a.platform ? String(a.platform) : undefined, limit: 10 });
        // the web sources (page parsers, web search / scrape, people search) are candidates too: ONE list for every provider, ordered by cost per row computed by code
        const web = ctx.web ? searchAgentSources({ words, platform: a.platform ? String(a.platform) : undefined }) : [];
        const merged: Array<Record<string, any>> = [
          ...found.hits.map((h: any) => ({ ...h, usd_per_row: h.costPerRecordUsd ?? null })),
          ...web.map((c) => ({ id: c.id, name: c.id, platform: c.platform, capability: c.kind, summary: c.summary.slice(0, 140), price: `about ${c.usd_per_call.toFixed(5)} USD a call, up to ${c.rows_per_call} rows`, costPerRecordUsd: Number(c.usd_per_row.toFixed(7)), usd_per_row: c.usd_per_row, requiredInputs: [], inputs: [c.inputs] })),
        ].sort((x, y) => (x.usd_per_row ?? Number.POSITIVE_INFINITY) - (y.usd_per_row ?? Number.POSITIVE_INFINITY) || String(x.id).localeCompare(String(y.id)));
        const top: Array<Record<string, any>> = merged.slice(0, limit).map(({ usd_per_row: _u, ...h }, i) => ({ ...h, rank: i + 1, ...(SESSION_RESTRICTED_SOURCES[String(h.id)] ? { limit_note: SESSION_RESTRICTED_SOURCES[String(h.id)].message } : {}) }));
        state.ranking = top.map((h) => String(h.id));
        return { ok: true, restrictedTop: found.restrictedTop, hidden: found.hidden, hits: top, note: "ranked cheapest first by cost per row; use the cheapest source that really fits, and give `why` when you choose a dearer one" };
      },
    },
    {
      name: "describe_endpoint",
      description: "The full description of one catalog endpoint: inputs (required, limits, enums), how its answer is paged, its fields, a trimmed example and how it is priced. Read it before calling an endpoint.",
      phases: ["planning", "execution"],
      params: { id: { type: "string", description: "Endpoint id exactly as catalog_search returned it" } },
      handler: async (a) => {
        const id = String(a.id ?? "");
        if (ctx.web && isAgentSourceId(id)) { const d = describeAgentSource(id); if (d) return { ok: true, endpoint: d }; }
        return gateway.describeEndpoint({ id });
      },
    },
    {
      name: "treg_call",
      description: "Make ONE real call to a catalog endpoint. The full answer is saved (its call id is returned) and you get a shape digest and the first rows only. Code refuses calls that are blocked, sensitive, over the mission's budget or over the provider's daily limit; a refused call costs nothing. Process the saved page with run_code.",
      phases: ["planning", "execution"],
      params: {
        endpoint_id: { type: "string", description: "Endpoint id exactly as catalog_search returned it" },
        params: { type: "object", description: "The endpoint's inputs as an object, e.g. {\"query\": \"...\", \"limit\": 20}. Page with the cursor input the description names." },
        purpose: { type: "string", description: "Only for a personal-data lookup: why the customer needs it", optional: true },
        why: { type: "string", description: "Only when this source is dearer than one the last catalog_search ranked above it: why that cheaper source was unsuitable (kept in the admin's trace)", optional: true },
      },
      handler: async (a) => {
        const id = String(a.endpoint_id ?? "").trim();
        const refusal = cheapestFirstMessage(state, id, a.why);
        if (refusal) return { ok: false, refused: "choose_cheapest", message: refusal };
        const result = await gateway.tregCall({ endpoint_id: a.endpoint_id, params: a.params, purpose: a.purpose, why: a.why });
        // the full inputs of this call, kept for the plan's execution recipe (the call log keeps short values only)
        if (isObject(a.params) && typeof result.call_id === "string") state.callParams.set(result.call_id, { ...a.params });
        if (!("refused" in result) || result.refused === "needs_login") state.tried.add(id);
        // A SAMPLE THAT FAILS IS NOT THE END OF EXPLORATION: a failed call, an empty page or a source that refuses this search says which sources of the ranking are still untried, so the next one is sampled (within the budget)
        const unsuitable = ("failed" in result && result.failed === true) || ("refused" in result && result.refused === "needs_login") || (result.ok === true && result.rows_in_page === 0);
        return unsuitable ? { ...result, next_sources: untriedSources(state, id), next_step: "this sample did not give rows; sample the next untried source of the ranking (pass `why` only if you skip one), and stop only when the budget refuses or no suitable source is left" } : { ...result };
      },
    },
    ...(ctx.web ? webTools(ctx) : []),
    {
      name: "collect_pages",
      description: "Page through a catalog endpoint IN CODE, many pages in ONE call: it makes the endpoint's calls one after another (each one passes every check of treg_call: budget, daily limit, recording), follows the cursor the answers return, joins and de-duplicates the rows, and stops at the target, at the end of the source, at a refusal, or after max_pages. The joined raw rows are saved as an output file (output_id) for run_code and save_rows. Use it for missions of hundreds of rows instead of calling treg_call page by page.",
      phases: ["execution"],
      params: {
        endpoint_id: { type: "string", description: "Endpoint id exactly as catalog_search returned it" },
        params: { type: "object", description: "The inputs of the FIRST page (the cursor input is added by code for the next pages)" },
        target_rows: { type: "number", description: "Stop when this many unique rows are collected (at most the approved volume of the stage)" },
        cursor_param: { type: "string", description: "The name of the endpoint's cursor input; default: its own paging input", optional: true },
        max_pages: { type: "number", description: `At most this many pages (default and maximum ${AGENT_COLLECT_MAX_PAGES})`, optional: true },
        why: { type: "string", description: "Only when this source is dearer than one ranked above it: why", optional: true },
      },
      handler: async (a) => {
        const id = String(a.endpoint_id ?? "").trim();
        const endpoint = ctx.catalog.byId.get(id);
        if (!endpoint) return err("this endpoint is not in the catalog; use an id exactly as catalog_search returned it");
        const refusal = cheapestFirstMessage(state, id, a.why);
        if (refusal) return { ok: false, refused: "choose_cheapest", message: refusal };
        const cursorParam = String(a.cursor_param || (endpoint.pagination ?? []).find((p) => !/^(limit|count|page_size|per_page|size|num|max_results|n)$/i.test(p)) || "");
        if (!cursorParam) return err("this endpoint has no cursor input; call treg_call once, or give cursor_param");
        const target = Math.max(1, Math.min(5000, Math.floor(Number(a.target_rows) || 0)));
        if (!Number.isFinite(target) || !(Number(a.target_rows) > 0)) return err("target_rows is required (a whole number of rows)");
        const maxPages = Math.max(1, Math.min(AGENT_COLLECT_MAX_PAGES, Math.floor(Number(a.max_pages) || AGENT_COLLECT_MAX_PAGES)));
        const first = isObject(a.params) ? { ...a.params } : {};
        // RESUME, NOT RESTART: a call with the same endpoint and the same inputs continues from where the last one stopped (its cursor) and skips the rows it already returned. Starting from the first page again re-bought the same
        // pages (the live run of 2026-10-28 paid for 60 pages to get 25 of new rows) and made the live count look frozen.
        const streamKey = collectStreamKey(id, first, cursorParam);
        const items = await getItems();
        const st = items.streamState(COLLECT_STAGE, streamKey);
        const prior: CollectStream | null = st ? { cursor: st.cursor, ended: st.ended, pages: st.pages, seen: [...st.seen] } : null;
        if (prior?.ended) return { ok: false, exhausted: true, error: `this source has no more pages for these inputs: it ended after ${prior.pages} pages, and the ${prior.seen.length} unique rows it gave were returned by earlier calls. Change the inputs (another search wording, another source) or finish with what is saved.` };
        const merged: unknown[] = [];
        const seen = new Set<string>(prior?.seen ?? collectSeen.get(streamKey) ?? []);
        const pagesBefore = prior?.pages ?? 0;
        const callIds: string[] = [];
        let cursor: string | null = prior?.cursor ?? null;
        let usedCursor: string | null = cursor;
        let nextCursor: string | null = cursor;
        let stopped = "max_pages";
        let pages = 0;
        let barren = 0;
        let lastFirstRows: unknown[] = [];
        while (pages < maxPages) {
          usedCursor = cursor;
          const result = await gateway.tregCall({ endpoint_id: id, params: cursor ? { ...first, [cursorParam]: cursor } : first, why: a.why });
          if (!result.ok) { stopped = "refused" in result ? `refused:${result.refused}` : "failed"; break; }
          state.tried.add(id);
          pages += 1;
          callIds.push(result.call_id);
          const raw = await store.getFile(mission.id, RAW_PATH(result.call_id));
          let list: unknown[] = [];
          try { const v = valueAt(raw ? JSON.parse(raw) : null, (result.shape as { list_path?: string | null } | null)?.list_path); list = Array.isArray(v) ? v : []; } catch { list = []; }
          if (pages === 1) lastFirstRows = list.slice(0, 3).map((r) => digestValue(r));
          let added = 0;
          for (const row of list) { const k = rowKeyOf(row); if (seen.has(k)) continue; seen.add(k); merged.push(row); added += 1; }
          nextCursor = result.next_cursor;
          // the counts are CUMULATIVE over every call of this source (pages read, unique rows found): they only grow; a different source starts again from page 1, and the panel adds the earlier peak when the numbers fall
          await store.addEvent(mission.id, { kind: "progress", message_ar: "يجمع الوكيل الصفحات من المصدر صفحة بعد صفحة", counts: { pages: pagesBefore + pages, rows: seen.size, planned: target } });
          if (merged.length >= target) { stopped = "target_reached"; break; }
          cursor = result.next_cursor;
          if (!cursor || list.length === 0 || result.has_more === false) { stopped = "source_ended"; break; }
          barren = added === 0 ? barren + 1 : 0;
          if (barren >= 2) { stopped = "no_new_rows"; break; }
        }
        // what the next call resumes from: after the last page processed, or (rows beyond the target are cut from the output) from the last page again, so no row is skipped
        const cut = merged.length > Math.max(target, 1);
        if (pages > 0) {
          const keptKeys = cut ? new Set([...(prior?.seen ?? []), ...merged.slice(0, Math.max(target, 1)).map(rowKeyOf)]) : seen;
          collectSeen.set(streamKey, keptKeys);
          // the position goes into the log as ONE create-only record (never an overwritten object): the cursor after the last page processed, the pages, the rows' keys new to this stream, and whether the source ended
          const priorSeen = new Set(prior?.seen ?? []);
          const newKeys = [...keptKeys].filter((k) => !priorSeen.has(k));
          try { await items.exclusive(() => items.commit([{ t: "page", stage: COLLECT_STAGE, stream: streamKey, call_id: callIds[callIds.length - 1] ?? null, cursor_in: usedCursor, cursor_next: cut ? usedCursor : nextCursor, has_more: null, ended: stopped === "source_ended" && !cut, rows_in_page: merged.length, pages: pages - (cut ? 1 : 0), keys: newKeys }])); } catch { /* resuming is an economy, never a requirement */ }
        }
        state.moreAvailable.set(streamKey, stopped === "max_pages" || stopped === "target_reached" || (cut && stopped === "source_ended"));
        if (merged.length === 0) return { ok: false, error: `no rows were collected (${stopped})`, pages, call_ids: callIds.slice(0, 5) };
        const output = merged.slice(0, Math.max(target, 1));
        state.outSeq += 1;
        const outputId = outId(state.outSeq);
        await store.putFile(mission.id, `out/${outputId}.json`, JSON.stringify(output), "application/json");
        return { ok: true, output_id: outputId, pages, unique_rows: merged.length, saved_rows: output.length, pages_in_all: pagesBefore + pages, unique_in_all: seen.size, ...(prior ? { resumed_from_page: pagesBefore + 1 } : {}), stopped_because: stopped, call_ids: callIds.slice(0, 3).concat(callIds.length > 3 ? [`… ${callIds.length} pages in all`] : []), first_rows: lastFirstRows, note: "output_id holds the joined RAW rows: map them to final rows with run_code (files: [output_id]) and save_rows" };
      },
    },
    {
      name: "run_code",
      description: "Run JavaScript in an isolated sandbox on files of THIS mission (saved pages call_0001..., earlier outputs out_0001...). No network, no environment, no secrets, a time limit and a memory limit. Your code is the body of a function: the files arrive as the object `inputs` (inputs.call_0001 is the parsed page) and you `return` a JSON-serialisable value (rows, counts, ids). The returned value is saved as a new output file (id returned) that you can pass to later run_code calls or to save_rows.",
      phases: ["planning", "execution"],
      params: {
        code: { type: "string", description: "Function body. Example: const rows = inputs.call_0001.data.items; return rows.map(r => ({id: String(r.id), text: r.text}));" },
        files: { type: "string[]", description: "Ids of the files to load into `inputs`, e.g. [\"call_0001\"]" },
      },
      handler: async (a) => {
        const code = String(a.code ?? "");
        if (!code.trim()) return err("code is empty");
        const files = Array.isArray(a.files) ? a.files.map(String) : [];
        if (files.length > 60) return err("at most 60 files per run");
        const loaded = await loadFileIds(files);
        if (!loaded.ok) return err(loaded.error);
        const result = await runSandbox(code, loaded.inputs);
        if (!result.ok) return err(result.error, { logs: result.logs.slice(0, 20) });
        if (result.resultJson === null) return { ok: true, output_id: null, note: "the code returned nothing (return a value)", logs: result.logs.slice(0, 20) };
        state.outSeq += 1;
        const id = outId(state.outSeq);
        await store.putFile(mission.id, `out/${id}.json`, result.resultJson, "application/json");
        // the code that made this output, kept for the plan's execution recipe (create-only: a new path, never overwritten)
        state.codeRuns.set(id, { code, files });
        try { await store.putNew(mission.id, codeRunPath(id), JSON.stringify({ code, files }), "application/json"); } catch { /* the copy in memory serves this run */ }
        const value = JSON.parse(result.resultJson) as unknown;
        const inline = result.resultJson.length <= SANDBOX_INLINE_RESULT_CHARS;
        return { ok: true, output_id: id, size_chars: result.resultJson.length, ...(inline ? { result: value } : { preview: previewOf(value), note: "the result is large: only a preview is shown; the whole output is saved under output_id" }), logs: result.logs.slice(0, 20) };
      },
    },
    {
      name: "report_progress",
      description: "Tell the customer's live panel what you are doing: ONE short line in Arabic (Arabic-Indic digits, no provider names, no endpoint ids, no dollar amounts) and optional counts. Call it at every real step.",
      phases: ["planning", "execution"],
      params: {
        message_ar: { type: "string", description: "One Arabic line" },
        counts: { type: "object", description: "Optional numbers, e.g. {\"pages\": 3, \"rows\": 120}", optional: true },
      },
      handler: async (a) => {
        const checked = checkCustomerText(a.message_ar, { maxChars: 240 });
        if (checked.issues.length) return err(`rephrase the line: ${checked.issues.join("; ")}`);
        const counts: Record<string, number> = {};
        if (isObject(a.counts)) for (const [k, v] of Object.entries(a.counts).slice(0, 10)) if (typeof v === "number" && Number.isFinite(v)) counts[k.slice(0, 40)] = v;
        await store.addEvent(mission.id, { kind: "progress", message_ar: checked.text, counts });
        return { ok: true };
      },
    },
    {
      name: "ask_question",
      description: "When something ESSENTIAL to the mission is missing and cannot be found in the catalog or the data, ask the customer ONE question in Arabic and stop. Use it at most once, and only in the planning phase.",
      phases: ["planning"],
      params: {
        question_ar: { type: "string", description: "One Arabic question" },
        options_ar: { type: "string[]", description: "2 to 4 READY ANSWERS the customer taps (short Arabic phrases, each one a complete answer, e.g. «لاعب كرة القدم»). Required: a question without options is refused.", optional: true },
      },
      handler: async (a) => {
        if (state.question !== null) return err("you already asked your one question");
        const checked = checkCustomerText(a.question_ar, { maxChars: 300 });
        if (checked.issues.length) return err(`rephrase the question: ${checked.issues.join("; ")}`);
        const options: string[] = [];
        for (const o of Array.isArray(a.options_ar) ? a.options_ar : []) {
          const c = checkCustomerText(o, { maxChars: 60 });
          if (c.issues.length) return err(`options_ar: ${c.issues.join("; ")}`);
          if (!options.includes(c.text)) options.push(c.text);
        }
        if (options.length < 2 || options.length > 4) return err("ask the question with 2 to 4 ready answers in options_ar (the customer taps one); if the request has one clearly dominant meaning, do not ask: decide, and state the assumption in assumptions_ar of the plan");
        state.question = checked.text;
        state.terminal = true;
        await store.updateMission(mission.id, { plan_public: { question_options: options } as any });
        await store.addEvent(mission.id, { kind: "question", message_ar: checked.text });
        return { ok: true, note: "the question was shown to the customer; stop now" };
      },
    },
    {
      name: "propose_plan",
      description: "Propose the plan: 1 to 4 stages (a stage runs once per row of its parent stage), the rows each is expected to give, the columns of each stage's rows (Arabic titles, readable ones only: names, texts, links, numbers; never an id column, every row already carries its own id and its parent's id), 1 to 3 sample rows you really saw, and the ids of the saved calls that measured each stage (measured_by). You never state a price: the site computes it from the measured charges. Rejected plans come back with the exact issues to fix.",
      phases: ["planning"],
      params: {
        summary_ar: { type: "string", description: "ONE Arabic sentence: what the customer will get (the customer card shows only this sentence)" },
        assumptions_ar: { type: "string[]", description: "Up to 6 short Arabic lines: every choice you made where the request left it open (which meaning of a name, the language, newest first, how many replies...), e.g. «محمد صلاح لاعب كرة القدم، تغريدات عربية، الأحدث أولًا». The customer reads them on the plan card and may change them before approving.", optional: true },
        contacts_note_ar: { type: "string", description: "Only when the customer asked for work e-mails or phones and NO contact stage is in the plan: ONE Arabic sentence saying honestly why", optional: true },
        stages: { type: "array", description: "[{key, title_ar, endpoint_id, expected_rows, parent_key|null, per_parent_rows (if parent), deliver, columns:[{key,title_ar}], sample_rows:[{...}], measured_by:[call ids], how_ar?, relevance?:{subject_ar, terms:[...], context_terms?:[...], exclude_terms?:[...], text_columns:[column keys], min_own_words?}, yield_from?: out id}]. A stage whose rows were FOUND BY A TEXT SEARCH (a person, entity or topic) REQUIRES relevance and yield_from." },
      },
      handler: async (a) => {
        const stagesIn: any[] = Array.isArray(a.stages) ? a.stages : [];
        const ids = new Set<string>();
        for (const s of stagesIn) {
          if (s && Array.isArray(s.measured_by)) for (const id of s.measured_by) ids.add(String(id));
          if (s && typeof s.yield_from === "string") ids.add(s.yield_from);
        }
        const calls = await store.listCalls(mission.id);
        const evidence = new Map<string, string | null>();
        for (const id of ids) evidence.set(id, FILE_ID.test(id) ? await store.getFile(mission.id, pathOfFile(id)) : null);
        const lookup = {
          call: (id: string): RecordedCall | null => {
            const row = calls.find((c) => c.id === `${mission.id}:${id}`);
            return row ? { id, endpointId: row.endpoint_id, ok: row.status === "ok", costUsd: Number(row.cost_usd) || 0, rows: Number(row.rows_returned) || 0, durationMs: Number(row.duration_ms) || undefined, params: row.params_digest } : null;
          },
          evidenceText: (id: string) => evidence.get(id) ?? null,
          endpointAllowed: (endpointId: string) => (Boolean(ctx.web) && isAgentSourceId(endpointId)) || (isSellable(endpointId, ctx.catalog) && !blockedEndpointReason(endpointId) && policyVerdict(endpointId, ctx.access).allowed),
          requestText: `${mission.request_text} ${mission.answer_text ?? ""}`,
          isContactSource,
          pricingSettings: ctx.pricingSettings,
        };
        const checked = validateAndPricePlan({ summary_ar: a.summary_ar, stages: stagesIn, ...(a.contacts_note_ar !== undefined ? { contacts_note_ar: a.contacts_note_ar } : {}), ...(a.assumptions_ar !== undefined ? { assumptions_ar: a.assumptions_ar } : {}) }, lookup);
        if (!checked.ok) return err("the plan was not accepted; fix these and propose again", { issues: checked.issues.slice(0, 12) });
        // THE MODEL PLANS, CODE EXECUTES: what code needs to carry each stage out without the model is derived from what the agent really did and proven on the measured page (a stage that cannot be proven has no recipe)
        try {
          const specs = await deriveEngineSpecs(checked.plan, { store, missionId: mission.id, catalog: ctx.catalog, calls, codeRuns: state.codeRuns, callParams: state.callParams, sandbox: runSandbox });
          for (const st of checked.plan.stages) { const spec = specs.get(st.key); if (spec) st.engine = spec; }
        } catch { /* a plan without recipes is carried out by the model, through the same item store */ }
        state.proposedPlan = checked.plan;
        state.terminal = true;
        await store.updateMission(mission.id, { plan: checked.plan as any });
        return { ok: true, note: "the plan was recorded; the site computes the price and shows it to the customer. Stop now." };
      },
    },
    {
      name: "save_rows",
      description: "Save FINAL rows of one stage of the approved plan. Each row needs a stable `id` and, for a stage with a parent, the `parent_id` of a row of the parent stage that is ALREADY saved (save parents first). Give rows from a run_code output (from_output) or inline (at most 200). Duplicates (same id) are ignored; rows beyond the stage's approved volume are refused.",
      phases: ["execution"],
      params: {
        stage_key: { type: "string", description: "The key of the stage in the approved plan" },
        from_output: { type: "string", description: "An output id from run_code holding an array of rows", optional: true },
        rows: { type: "array", description: "Rows inline (small sets only)", optional: true },
      },
      handler: async (a) => {
        const plan = ctx.plan;
        if (!plan) return err("there is no approved plan");
        const stage = plan.stages.find((s) => s.key === String(a.stage_key ?? ""));
        if (!stage) return err(`unknown stage; the stages are: ${plan.stages.map((s) => s.key).join(", ")}`);
        let incoming: unknown[];
        if (a.from_output) {
          const id = String(a.from_output);
          if (!/^out_\d{4,6}$/.test(id)) return err("from_output must be an output id returned by run_code");
          const text = await store.getFile(mission.id, `out/${id}.json`);
          if (text === null) return err(`«${id}» does not exist in this mission`);
          const parsed = JSON.parse(text) as unknown;
          if (!Array.isArray(parsed)) return err("the output is not an array of rows");
          incoming = parsed;
        } else if (Array.isArray(a.rows)) {
          if (a.rows.length > AGENT_INLINE_ROWS_MAX) return err(`at most ${AGENT_INLINE_ROWS_MAX} rows inline; put larger sets in a run_code output and use from_output`);
          incoming = a.rows;
        } else return err("give from_output or rows");

        return checkAndSaveRows(stage, incoming);
      },
    },
    {
      name: "finish",
      description: "End the mission. outcome \"delivered\": everything you could save is saved (execution phase). outcome \"cannot_serve\": the sources cannot serve this honestly. summary_ar is what the customer reads: Arabic, Arabic-Indic digits, honest about what was and was not delivered, no provider names or technical ids.",
      phases: ["planning", "execution"],
      params: {
        outcome: { type: "string", description: "\"delivered\" or \"cannot_serve\"" },
        summary_ar: { type: "string", description: "The Arabic summary" },
      },
      handler: async (a) => {
        const outcome = String(a.outcome ?? "");
        if (outcome !== "delivered" && outcome !== "cannot_serve") return err("outcome must be \"delivered\" or \"cannot_serve\"");
        if (ctx.phase === "planning" && outcome !== "cannot_serve") return err("while planning, finish only to say the mission cannot be served; otherwise call propose_plan");
        const checked = checkCustomerText(a.summary_ar, { maxChars: 800 });
        if (checked.issues.length) return err(`rephrase the summary: ${checked.issues.join("; ")}`);
        // rows the agent itself calls unfiltered are never delivered: it must filter them (the stage's relevance rule does it in save_rows) or say honestly that it cannot serve
        if (outcome === "delivered" && UNFILTERED_ADMISSION.test(normalizeText(checked.text))) return err("your summary says the rows are NOT filtered or may include other people / replies. Rows that do not match the request are never delivered or charged: save only rows that match (the stage's relevance rule filters them in save_rows) and rewrite the summary, or finish with outcome \"cannot_serve\"");
        // rows that were waiting for a review (the budget or a failed call delayed them) are asked once more before the mission ends: a good row is never lost only because it was late
        if (outcome === "delivered" && ctx.plan && ctx.review) {
          const items = await getItems();
          for (const st of ctx.plan.stages) {
            if (!st.relevance) continue;
            await drainPending({ items, plan: ctx.plan, reviewer: ctx.review, addEvent: (e) => store.addEvent(mission.id, e) }, st);
            await mirrorLegacyFiles(items, store, ctx.plan, [st.key]);
          }
        }
        // NO EARLY STOP: while matching items are still needed and a source says it has more pages, finish is refused (a limited number of times, so the model is never stuck): the model cannot end a mission short of what was bought
        if (outcome === "delivered" && ctx.plan) {
          const items = await getItems();
          const short = ctx.plan.stages.filter((st) => st.deliver && items.counts(st.key).accepted < st.planned_rows);
          const more = [...state.moreAvailable.values()].some(Boolean);
          if (short.length > 0 && more && state.finishRefusals < FINISH_REFUSALS_MAX) {
            state.finishRefusals += 1;
            return err(`do not finish yet: ${short.map((st) => `stage «${st.key}» still needs ${st.planned_rows - items.counts(st.key).accepted} matching items`).join("; ")}, and the source has more pages. Collect the next pages (collect_pages with the same inputs resumes), run_code, save_rows; finish only when still_needed is 0, the source ends, or a call is refused`);
          }
          if (short.length > 0 && more) for (const st of short) await items.exclusive(() => items.commit([{ t: "stop", stage: st.key, reason: "model_stopped" as StopReason }]));
        }
        state.finish = { outcome, summary_ar: checked.text };
        state.terminal = true;
        return { ok: true, note: "recorded; stop now" };
      },
    },
  ];
  return tools.filter((t) => t.phases.includes(ctx.phase));
}


/** The web tools: ONE gateway tool for the page parsers (parser name + URL), and the web search, page scrape and people search of the providers. Same rules as treg_call, in the gateway. */
function webTools(ctx: ToolContext): ToolSpec[] {
  const { state } = ctx;
  const web = ctx.web!;
  const guard = (id: string, why: unknown) => { const m = cheapestFirstMessage(state, id, why); return m ? { ok: false, refused: "choose_cheapest", message: m } : null; };
  const done = (id: string, result: Record<string, any>) => { if (!("refused" in result)) state.tried.add(id); return result; };
  const why: ParamSpec = { type: "string", description: "Only when this source is dearer than one the last catalog_search ranked above it: why that cheaper source was unsuitable (kept in the admin's trace)", optional: true };
  return [
    {
      name: "parse_page",
      description: "Read ONE public page with a pre-built parser and get its ROWS (no crawling, one parser per call). Parsers: google-maps (businesses of a search or a place), google-maps-reviews (reviews of a place, up to 1,000; optional sort and limit), google-play and google-play-reviews (up to 200), app-store and app-store-reviews (up to 500), instagram-profile, instagram-post (top comments), instagram-feed (hashtag, keyword or location URL), tiktok-profile, tiktok-video, tiktok-feed (profile, hashtag or search URL), tiktok-comments (the first 20 only: use the catalog's comment sources for more), tiktok-followers, tiktok-following, tiktok-user-search (top 10), g2-reviews (25), emails, phone-numbers and links (of the ONE page you give: open the company's own site, then its contact page via links). There is no X, Facebook or YouTube parser: those stay on the catalog. Public pages only, read only. The full answer is saved as { rows, data }; you get a shape digest and the first rows.",
      phases: ["planning", "execution"],
      params: {
        parser: { type: "string", description: "The parser name, e.g. \"instagram-feed\"" },
        url: { type: "string", description: "The public page in the shape that parser accepts (see describe_endpoint of contextdev.parse.<parser>)" },
        sort: { type: "string", description: "google-maps-reviews only: newest, oldest, relevant, highest or lowest", optional: true },
        limit: { type: "number", description: "google-maps-reviews only: 1 to 1000 reviews (default 100)", optional: true },
        why,
      },
      handler: async (a) => {
        const name = String(a.parser ?? "").trim();
        const id = `contextdev.parse.${name}`;
        return guard(id, a.why) ?? done(id, await web.parsePage({ parser: a.parser, url: a.url, sort: a.sort, limit: a.limit, why: a.why }) as Record<string, any>);
      },
    },
    {
      name: "web_search",
      description: "Search the public web (Firecrawl or Context.dev): the title, address and description of up to 30 results. Use it to find a company's website or a place's page; then read the page with parse_page or web_scrape.",
      phases: ["planning", "execution"],
      params: {
        provider: { type: "string", description: "\"contextdev\" (cheaper) or \"firecrawl\"" },
        query: { type: "string", description: "The search words" },
        limit: { type: "number", description: "10, 20 or 30 results", optional: true },
        country: { type: "string", description: "Two-letter country code", optional: true },
        why,
      },
      handler: async (a) => {
        const id = `${a.provider === "firecrawl" ? "firecrawl" : "contextdev"}.search`;
        return guard(id, a.why) ?? done(id, await web.webSearch({ provider: a.provider, query: a.query, limit: a.limit, country: a.country, why: a.why }) as Record<string, any>);
      },
    },
    {
      name: "web_scrape",
      description: "Read ONE public page as text with its links (Firecrawl or Context.dev). The full text and links are saved; process them with run_code. For the e-mails or phones of a page prefer parse_page with the emails / phone-numbers parser.",
      phases: ["planning", "execution"],
      params: { provider: { type: "string", description: "\"contextdev\" (cheaper) or \"firecrawl\"" }, url: { type: "string", description: "A public page" }, why },
      handler: async (a) => {
        const id = `${a.provider === "firecrawl" ? "firecrawl" : "contextdev"}.scrape`;
        return guard(id, a.why) ?? done(id, await web.webScrape({ provider: a.provider, url: a.url, why: a.why }) as Record<string, any>);
      },
    },
    {
      name: "people_search",
      description: "Find professionals from a plain-language description (Context.dev people search): name, role, company, location and public profile links, 10 per page. It returns NO e-mail and NO phone: use a contact source for those. Page with the next_cursor it returns.",
      phases: ["planning", "execution"],
      params: { query: { type: "string", description: "For example \"VPs of sales at solar companies in California\" (up to 500 characters)" }, country: { type: "string", description: "Two-letter country code", optional: true }, cursor: { type: "string", description: "The next_cursor of the previous page", optional: true }, why },
      handler: async (a) => guard("contextdev.people.search", a.why) ?? done("contextdev.people.search", await web.peopleSearch({ query: a.query, country: a.country, cursor: a.cursor, why: a.why }) as Record<string, any>),
    },
  ];
}

export const TOOL_NAMES = ["catalog_search", "describe_endpoint", "treg_call", "parse_page", "web_search", "web_scrape", "people_search", "collect_pages", "run_code", "report_progress", "ask_question", "propose_plan", "save_rows", "finish"] as const;
