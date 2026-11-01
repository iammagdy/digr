import { AGENT_COLLECT_MAX_PAGES, AGENT_REVIEW_RETRY_DELAY_MS } from "../../../src/lib/agentMission/constants";
import type { EngineSpec, PricedPlan } from "../../../src/lib/agentMission/plan";
import type { Gateway } from "../gateway";
import { RAW_PATH } from "../gateway";
import { rankPeopleByRole, titleFieldOf, titleTierOf } from "../../../src/lib/agentMission/roles";
import { looksLikeDateColumn, parseMoment } from "../../../src/lib/agentMission/dateCells";
import { dayOf, firstWindowEndDay, nextWindowEndDay, windowParams } from "../../../src/lib/agentMission/dateWindow";
import { isEnabled } from "../../../src/lib/agentMission/filters";
import { childCountNumber, childCountOf } from "../../../src/lib/agentMission/childCount";
import { AGENT_REPLIES_PER_COMMENT_MAX } from "../../../src/lib/agentMission/constants";
import { replyShares } from "../../../src/lib/agentMission/replies";
import { SOURCE_KEY } from "../../../src/lib/agentMission/namedSources";
import { isProviderUrl, providerContext } from "../../../src/lib/agentMission/providerHosts";
import { companyIdentityOf, confirmPersonAtCompany, isPlaceholderCompanyUrl, peopleEvidenceOf } from "../../../src/lib/agentMission/companyIdentity";
import { isPeopleStage, nameKeysOf } from "../../../src/lib/agentMission/people";
import { NOT_AT_COMPANY_MARK, drainPending, emitStageProgress, ingestRows } from "../items/ingest";
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
/** Windows one stage may walk back through (a safety net: every window ends at least a day earlier than the one before, and a source that gives nothing more ends the walk). */
export const ENGINE_MAX_WINDOWS = 200;

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
  /** The stages that run the REDESIGNED engine behaviour (S1 items 1.1, 1.3, 1.9): the type's flag is active for the account AND the stage's recipe was built by code. Absent or not listed: the engine behaves as it always did. */
  redesignStages?: ReadonlySet<string>;
  /** The pause before the one delayed review retry (default AGENT_REVIEW_RETRY_DELAY_MS); tests pass a fake that does not wait. */
  sleep?: (ms: number) => Promise<void>;
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
    await retryReviewLater(deps, stage);
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

/**
 * ONE DELAYED RETRY OF THE REVIEW, once per stage, before the mission settles: when items are still pending because the model review could not answer (a failed call, or answers that were not one 0/1 per row), wait a little
 * and ask again. Never a loop, never when the review stopped for its budget, never past the volume bought. The retry costs what the review costs (the same budget and ceiling); nothing is charged for what is not delivered.
 */
async function retryReviewLater(deps: EngineDeps, stage: Stage): Promise<void> {
  if (!stage.relevance || !deps.reviewer) return;
  const c = deps.items.counts(stage.key);
  if (c.pending === 0 || c.accepted >= stage.planned_rows) return;
  if ((await deps.reviewer.state()).stop !== "failed") return;
  if (deps.shouldStop?.() || Date.now() >= deps.deadlineMs) return;
  await (deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(AGENT_REVIEW_RETRY_DELAY_MS);
  await drainPending(deps, stage);
}

async function runStage(deps: EngineDeps, stage: Stage, spec: EngineSpec): Promise<{ reason: StopReason; aborted: string | null }> {
  const { items } = deps;
  if (stage.parent_key === null) return runRoot(deps, stage, spec);
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
  // A PARENT THE SOURCE GAVE NO CHILD FOR IS REPLACED (live, 2026-10-30: «٥ فيديوهات تيك توك ... ومن كل فيديو ١٠ تعليقات»: the plan took the five NEWEST videos, brand new, and the comment source answered 0, 0, 1, 0 and 10 comments, so 16 of 55 were delivered while the
  // search had checked 20 videos and kept 15 beyond the five). The parent stage's own spares (matches it checked and kept beyond its volume) stand in, one at a time, so the customer gets the number of parents he asked for, each with children. Only a parent with NO child is replaced
  // (nothing delivered is ever dropped), only when this stage is the only child of that stage, and a spare is read once.
  const onlyChild = deps.plan.stages.filter((x) => x.parent_key === stage.parent_key).length === 1;
  // THE REPLIES OF A COMMENT (replies.ts): a comment with no reply is never replaced by another comment (the replies are in addition to the comments the customer asked for), and each comment is read for the replies its own counter says it has, up to its share of the approved total:
  // a comment whose counter is 0 gets 0 (no paid read), the others get what they have up to the cap, and when the total is smaller than the need every comment gets an equal part first
  const isReplies = stage.replies_of !== undefined;
  const shareById = isReplies ? (() => { const shares = replyShares(parentRows.map((r) => ownChildCount(r)), stage.planned_rows, Number.isFinite(per) ? per : AGENT_REPLIES_PER_COMMENT_MAX); return new Map(parentRows.map((r, i) => [String(r.id), shares[i]] as const)); })() : null;
  const swapsLeft = { n: onlyChild && stage.per_parent_rows !== undefined && !isReplies ? Math.max(3, parentRows.length * 3) : 0 };
  // the parent's parent (the video of a comment): the replies' source takes the video's id and link beside the comment's id
  const grandKey = deps.plan.stages.find((x) => x.key === stage.parent_key)?.parent_key ?? null;
  const grandRows = new Map<string, Row>((grandKey ? items.acceptedRows(grandKey) : []).map((r) => [String(r.id), r] as const));
  for (const cap of rounds) {
    for (const first of parentRows) {
      let parent: Row = first;
      for (;;) {
        if (items.counts(stage.key).accepted >= stage.planned_rows) return { reason: "target_reached", aborted: null };
        const parentId = String(parent.id);
        const parentCap = shareById ? shareById.get(parentId) ?? 0 : cap;
        if (shareById && parentCap <= 0) break;
        // A PARENT THAT SAYS IT HAS NO CHILD IS NOT READ (audit 2026-11 gap G10, live: 9 of 108 paid comment reads returned nothing): its own count field (comments, replies, reviews) is 0, so no paid read is made. It is replaced by a spare parent the same way a parent
        // the source answered nothing for is, or skipped when none is left. A parent that gives no count at all is read as before.
        if (ownChildCount(parent) === 0) {
          const spare = swapsLeft.n > 0 ? spareParentFor(items, stage.parent_key, stage.key, parent) : null;
          if (spare) {
            swapsLeft.n -= 1;
            await items.commit([{ t: "swap", stage: stage.parent_key, out: parentId, in: spare.id }]);
            await items.mirror(stage.parent_key);
            parent = spare.row;
            continue;
          }
          break;
        }
        // THE PARENT'S OWN FIELDS, in order (the measuring call's input first, then its website, page and name when the child source takes them): the first that has a value is read; a read that FAILED or gave nothing is retried through the next one
        // the same field read as a BARE DOMAIN too when the source's input is a website («www.x.com», «x.com/home» are not found by a source that knows «x.com»): index 9, so the streams of the other bindings keep their keys
        const bindings = [{ param: spec.parent_binding.param, from: spec.parent_binding.from, domain: false, index: 0 }, ...(WEBSITE_PARAM.test(spec.parent_binding.param) ? [{ param: spec.parent_binding.param, from: spec.parent_binding.from, domain: true, index: 9 }] : []), ...(spec.parent_binding.fallbacks ?? []).map((f, i) => ({ param: f.param, from: f.from, domain: f.domain === true, index: i + 1 }))];
        const seenInputs = new Set<string>();
        // an address of a DATA PROVIDER (a record page the companies source cited) is never an input for another source, and an input that was already asked is not asked again
        const usable = bindings.map((b) => ({ b, index: b.index, value: b.index === 0 ? (parent[b.from] === undefined || parent[b.from] === null || parent[b.from] === "" ? null : parent[b.from]) : bindingValue(parent[b.from], b.domain) })).filter((x) => {
          // a PLACEHOLDER company page or website (https://linkedin.com/company/mycompany) is never the key: the source would answer for another company
          if (x.value === null || isProviderUrl(x.value, providerContext()) || isProviderUrl(parent[x.b.from], providerContext()) || isPlaceholderCompanyUrl(x.value)) return false;
          const key = `${x.b.param}=${String(x.value)}`;
          if (seenInputs.has(key)) return false;
          seenInputs.add(key);
          return true;
        });
        if (usable.length === 0) break;
        let r: { reason: StopReason; aborted: string | null } = { reason: "source_exhausted", aborted: null };
        for (const u of usable) {
          // the first read of a parent also carries the parent's other identity inputs (its link beside its id): a routed source needs them to keep its providers (spec.ts bindingAlso)
          const also = u.index === 0 ? Object.fromEntries((spec.parent_binding.also ?? []).map((a) => [a.param, bindingValue((a.grand ? grandRows.get(String(parent.parent_id ?? "")) : parent)?.[a.from], false)] as const).filter(([, v]) => v !== null && !isProviderUrl(v, providerContext()) && !isPlaceholderCompanyUrl(v))) : {};
          const params = { ...spec.params, ...also, [u.b.param]: u.value };
          const before = items.acceptedRows(stage.key).filter((x) => String(x.parent_id) === parentId).length;
          r = await runStream(deps, stage, spec, u.index === 0 ? `p:${parentId}` : `p:${parentId}:b${u.index}`, params, parentId, parentCap);
          if (r.aborted) return r;
          const gained = items.acceptedRows(stage.key).filter((x) => String(x.parent_id) === parentId).length - before;
          if (gained > 0 || !(r.reason === "failed" || r.reason === "source_exhausted" || r.reason === "no_new_items")) break;
        }
        if (r.aborted) return r;
        // a stop that ends the whole stage (the budget, the daily limit, the time, a refusal) is not «this parent has no more»
        if (r.reason === "budget" || r.reason === "daily_cap" || r.reason === "refused" || r.reason === "time_limit" || r.reason === "review_limit" || r.reason === "page_limit") return r;
        const children = items.acceptedRows(stage.key).filter((x) => String(x.parent_id) === parentId).length;
        // the source ended for this parent and gave it NO child: a spare parent takes its place and is read the same way
        if (children === 0 && (r.reason === "source_exhausted" || r.reason === "no_new_items") && swapsLeft.n > 0) {
          const spare = spareParentFor(items, stage.parent_key, stage.key, parent);
          if (spare) {
            swapsLeft.n -= 1;
            await items.commit([{ t: "swap", stage: stage.parent_key, out: parentId, in: spare.id }]);
            await items.mirror(stage.parent_key);
            parent = spare.row;
            continue;
          }
        }
        // one parent whose read failed twice is skipped (the others may well be read); three in a row end the stage with that reason
        if (r.reason === "failed") { failedInARow += 1; anyFailed = true; if (failedInARow >= 3) return r; break; }
        failedInARow = 0;
        last = r.reason;
        break;
      }
    }
  }
  // a read that failed for some parent is the recorded reason when the volume was not reached (never «the source has no more»)
  return { reason: items.counts(stage.key).accepted >= stage.planned_rows ? "target_reached" : anyFailed ? "failed" : last === "target_reached" ? "source_exhausted" : last, aborted: null };
}

/** How many pages of the source are read for each parent of a people stage that prefers the decision makers (stage.pages_per_parent, set by code at plan time and editable by the customer); 1 for every other stage and for a source that is not paged. */
export function depthPagesOf(stage: Stage, spec: EngineSpec): number {
  const n = Math.floor(Number(stage.pages_per_parent ?? 1));
  if (!Number.isFinite(n) || n <= 1) return 1;
  if (stage.parent_key === null || stage.role_preference?.role !== "manager" || !spec.cursor_param || stage.per_parent_rows === undefined) return 1;
  return n;
}

/** The rows of a parent's people read so far: accepted, and kept as beyond the approved count (their rows are stored), in the order they were read. */
function peopleOfParent(items: ItemStore, stage: Stage, parentId: string): { accepted: Row[]; spare: Array<{ id: string; row: Row }> } {
  const accepted = items.acceptedRows(stage.key).filter((r) => String(r.parent_id) === parentId);
  const spare = items.excludedItems(stage.key).filter((i) => i.reason === "target_reached" && i.row && String(i.row.parent_id) === parentId).map((i) => ({ id: i.id, row: i.row! }));
  return { accepted, spare };
}
const tierOfRow = (row: Row): number => { const f = titleFieldOf(row); return titleTierOf(f ? row[f] : "", "manager"); };

/** Decision makers (tier 0) among everything read for this parent. */
function decisionMakersSeen(items: ItemStore, stage: Stage, parentId: string): number {
  const { accepted, spare } = peopleOfParent(items, stage, parentId);
  return accepted.filter((r) => tierOfRow(r) === 0).length + spare.filter((s) => tierOfRow(s.row) === 0).length;
}

/** While a person kept beyond the approved count has a BETTER title tier than the worst person accepted for the same parent, they swap places (the store's `swap`: the delivered count of the parent does not change). */
async function upgradeDecisionMakers(deps: EngineDeps, stage: Stage, parentId: string): Promise<void> {
  for (let guard = 0; guard < 50; guard += 1) {
    const { accepted, spare } = peopleOfParent(deps.items, stage, parentId);
    if (accepted.length === 0 || spare.length === 0) return;
    const worst = accepted.map((row, i) => ({ row, i, t: tierOfRow(row) })).sort((a, b) => b.t - a.t || b.i - a.i)[0];
    const best = spare.map((s, i) => ({ s, i, t: tierOfRow(s.row) })).sort((a, b) => a.t - b.t || a.i - b.i)[0];
    if (best.t >= worst.t) return;
    await deps.items.commit([{ t: "swap", stage: stage.key, out: String(worst.row.id), in: best.s.id }]);
  }
}

/** Marks the people of a page whose current company is not the parent company: by the source's own experiences for the person, else by the company the row itself names (companyIdentity.ts). A person nothing can be judged for is not marked. */
function markPeopleNotAtCompany(deps: EngineDeps, stage: Stage, parentId: string, page: unknown, rows: Row[]): Row[] {
  if (!stage.parent_key || !isPeopleStage(stage)) return rows;
  const parentStage = deps.plan.stages.find((s) => s.key === stage.parent_key);
  const parentRow = deps.items.acceptedRows(stage.parent_key).find((r) => String(r.id) === parentId) ?? null;
  const company = companyIdentityOf(parentRow, parentStage ? nameKeysOf(parentStage.columns) : []);
  if (company.names.length === 0 && !company.domain) return rows;
  const evidence = peopleEvidenceOf(page);
  const nameKeys = nameKeysOf(stage.columns);
  // where the company is (its own city / address cells): a partial name match is accepted only in the same governorate (companyIdentity.ts)
  const companyPlace = parentRow ? Object.entries(parentRow).filter(([k, v]) => /(^|_)(location|city|place|region|governorate|address)$/i.test(k) && typeof v === "string" && v.trim() !== "").map(([, v]) => String(v).trim()).join(" ") : "";
  return rows.map((row) => (confirmPersonAtCompany(row, { nameKeys, evidence: evidence.any ? evidence : null, company, companyPlace }) === "mismatch" ? { ...row, [NOT_AT_COMPANY_MARK]: true } : row));
}

/** The numeric field of a parent row that counts its children (a video's comments, a place's reviews), when the mapping carries one: spares with more children are tried first. */
/** The answers that say «this source has nothing for this input»: not found, gone, the input was rejected. */
const PARENT_UNKNOWN_HTTP: ReadonlySet<number> = new Set([400, 404, 410, 422]);
const WEBSITE_PARAM = /^(website|domain|site|url|homepage|web|company_?(website|domain|site))$/i;
/** The parent's own count of its children (a video's comments, a place's reviews, a comment's replies), when its row carries a number for it (a numeric text counts); null when the row has none (childCount.ts, shared with the plan). */
export const ownChildCount = (row: Row): number | null => childCountOf(row);

/** The next spare parent: a match the parent stage checked and kept beyond its volume, never read for children, from the same named source as the parent it replaces (a named source's share is kept). Most children first when the rows say it, else the source's order. */
function spareParentFor(items: ItemStore, parentKey: string, childKey: string, out: Row): { id: string; row: Row } | null {
  const src = (r: Row): string => String(r[SOURCE_KEY] ?? "");
  // a spare that says it has no child is no replacement (the same rule as for the parent it takes the place of)
  const spares = items.excludedItems(parentKey).filter((i) => i.reason === "target_reached" && i.row && src(i.row) === src(out) && ownChildCount(i.row) !== 0 && !items.streamState(childKey, `p:${i.id}`));
  if (spares.length === 0) return null;
  const count = (r: Row): number => childCountNumber(r);
  const best = spares.map((i, index) => ({ i, index, n: count(i.row!) })).sort((a, b) => b.n - a.n || a.index - b.index)[0].i;
  return { id: best.id, row: { ...best.row!, id: best.row!.id ?? best.id } };
}

/** The value a parent's field gives to the child source's input: the text itself, or for a website input the bare domain («https://www.mustcc.com/» → «mustcc.com»). Null when the parent has none. */
function bindingValue(v: unknown, domain: boolean): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = String(v).trim();
  if (t === "") return null;
  return domain ? (t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0] || null) : t;
}

/** The mapped field whose oldest value marks the date boundary a fallback continues from: the period's field, else the stage's own date column (redesigned stages only). */
function boundaryFieldOf(stage: Stage, now: number): string | null {
  return periodOf(stage, now)?.field ?? stage.columns.find((c) => looksLikeDateColumn(c.title_ar, c.key))?.key ?? null;
}

/** The period the customer asked for, as the engine can walk it: the enabled period filter with its date field and a first day. Null when the stage has none (or only an end). */
function periodOf(stage: Stage, now: number): { field: string; sinceMs: number } | null {
  const f = (stage.filters ?? []).find((x) => x.kind === "period" && isEnabled(x) && x.field);
  if (!f?.field) return null;
  const sinceMs = f.days !== undefined ? now - f.days * 86_400_000 : f.from ? Date.parse(`${f.from}T00:00:00Z`) : NaN;
  return Number.isFinite(sinceMs) ? { field: f.field, sinceMs } : null;
}

/**
 * THE FIRST-LEVEL STAGE: one read of the source as the plan recorded it; and, when a PERIOD was asked for and the source ends before the target is reached, THE WALK BACK THROUGH DATE WINDOWS: the same source is asked again with the end of the
 * window moved back to the oldest day read (the source's own date inputs from the catalog: dateWindow.ts), until the target is reached, the first day of the period is reached, or the source gives nothing more. Items are de-duplicated by id
 * (the overlapping day is read again and ignored), the review budget and every cap (calls, pages, time) are the ones of every read.
 */
async function runRoot(deps: EngineDeps, stage: Stage, spec: EngineSpec): Promise<{ reason: StopReason; aborted: string | null }> {
  const r = await runRootPrimary(deps, stage, spec);
  return deps.redesignStages?.has(stage.key) ? continueAcrossTools(deps, stage, spec, r) : r;
}

/** Why a read of one tool may be continued on the next one: it failed twice, it ran dry before the count, or it only repeated itself. */
const CONTINUE_ON: ReadonlySet<StopReason> = new Set<StopReason>(["failed", "source_exhausted", "no_new_items"]);
/** The first day a read goes back to when the customer gave no period. */
const EARLIEST_DAY = "2000-01-01";

/**
 * FETCH TO THE COUNT ACROSS TOOLS (S1 item 1.9, owner decisions D7 and D15). When the tool of the recipe could not give the approved count, the next tool of `spec.alternatives` continues: by the remaining count (the stage's own accepted count), by the date boundary
 * (a tool with date inputs is asked for the days up to the oldest day read so far) and by the stored ids (the item store drops an id it already holds). A cursor never crosses providers; near-duplicates the id check cannot catch are kept. Everything stays inside the
 * budget: when the reserve refuses before the count is reached the stage ends with `need_new_plan` and says so, never with a silently lower count.
 */
async function continueAcrossTools(deps: EngineDeps, stage: Stage, spec: EngineSpec, first: { reason: StopReason; aborted: string | null }): Promise<{ reason: StopReason; aborted: string | null }> {
  const { items } = deps;
  const now = (deps.now ?? Date.now)();
  const period = periodOf(stage, now);
  let r = first;
  for (let i = 0; i < (spec.alternatives ?? []).length; i += 1) {
    if (r.aborted) return r;
    if (items.counts(stage.key).accepted >= stage.planned_rows) return { reason: "target_reached", aborted: null };
    if (!CONTINUE_ON.has(r.reason)) break;
    const alt = spec.alternatives![i];
    const oldest = items.streamKeys(stage.key).map((k) => items.streamState(stage.key, k)?.oldest ?? null).filter((x): x is number => x !== null);
    const params = alt.window && oldest.length > 0 ? windowParams(alt.window, alt.params, period ? dayOf(period.sinceMs) : EARLIEST_DAY, dayOf(Math.min(...oldest))) : { ...alt.params };
    const { alternatives: _a, sources: _s, id_field: _i, window: _w, ...rest } = spec;
    const altSpec: EngineSpec = { ...rest, endpoint_id: alt.endpoint_id, params, cursor_param: alt.cursor_param, map_code: alt.map_code, map_file_id: alt.map_file_id, ...(alt.id_field !== undefined ? { id_field: alt.id_field } : {}), ...(alt.window ? { window: alt.window } : {}) };
    r = await runStream(deps, stage, altSpec, `alt:${i}`, params, null, Number.POSITIVE_INFINITY, boundaryFieldOf(stage, now));
  }
  if (r.aborted) return r;
  if (items.counts(stage.key).accepted >= stage.planned_rows) return { reason: "target_reached", aborted: null };
  return r.reason === "budget" ? { reason: "need_new_plan", aborted: null } : r;
}

async function runRootPrimary(deps: EngineDeps, stage: Stage, spec: EngineSpec): Promise<{ reason: StopReason; aborted: string | null }> {
  const { items } = deps;
  if (spec.sources && spec.sources.length > 0) return runSources(deps, stage, spec, spec.sources);
  const now = (deps.now ?? Date.now)();
  const period = spec.window ? periodOf(stage, now) : null;
  let r = await runStream(deps, stage, spec, "root", { ...spec.params }, null, Number.POSITIVE_INFINITY, period?.field ?? (deps.redesignStages?.has(stage.key) ? boundaryFieldOf(stage, now) : null));
  if (!spec.window || !period) return r;
  const sinceDay = dayOf(period.sinceMs);
  let lastEnd = firstWindowEndDay(spec.window, spec.params, now);
  // windows read before a restart are continued in the order they were started
  for (const key of items.streamKeys(stage.key).filter((k) => k.startsWith("w:"))) {
    if (r.aborted || r.reason === "target_reached") return r;
    lastEnd = key.slice(2);
    r = await runStream(deps, stage, spec, key, windowParams(spec.window, spec.params, sinceDay, lastEnd), null, Number.POSITIVE_INFINITY, period.field);
  }
  for (let n = 0; n < ENGINE_MAX_WINDOWS; n += 1) {
    if (r.aborted) return r;
    if (items.counts(stage.key).accepted >= stage.planned_rows) return { reason: "target_reached", aborted: null };
    // only a source that has nothing more to give is walked back; a budget, a refusal, the time or a failure ends the stage as it always did
    if (r.reason !== "source_exhausted" && r.reason !== "no_new_items") return r;
    const oldest = items.streamKeys(stage.key).map((k) => items.streamState(stage.key, k)?.oldest ?? null).filter((x): x is number => x !== null);
    const end = nextWindowEndDay({ oldestMs: oldest.length > 0 ? Math.min(...oldest) : null, lastEndDay: lastEnd, sinceDay });
    if (!end) return r;
    lastEnd = end;
    r = await runStream(deps, stage, spec, `w:${end}`, windowParams(spec.window, spec.params, sinceDay, end), null, Number.POSITIVE_INFINITY, period.field);
    // a window that reaches back to the first day of the period and gives NOTHING says the source has nothing older: the walk ends (never a call for every remaining day)
    if ((items.streamState(stage.key, `w:${end}`)?.rows ?? 0) === 0) return { reason: "source_exhausted", aborted: r.aborted };
  }
  return r;
}

/** What a stage with several NAMED SOURCES reads from each: the named source's fields, every named value and the share of each. */
interface SourceShare { fields: string[]; values: string[]; perValue: number }

/**
 * A STAGE WHOSE CUSTOMER NAMED SEVERAL SOURCES («٥ فيديوهات من كل قناة» for three channels): each named source is read in turn with the inputs that gave it in the measuring calls, each up to its own share of the stage's volume; an item beyond a source's share is kept,
 * never delivered, so one prolific channel never takes the places of the others. A source that gives nothing, or fails, does not stop the next one; a stop that ends the whole stage (the budget, the daily limit, the time, a refusal) does.
 */
async function runSources(deps: EngineDeps, stage: Stage, spec: EngineSpec, sources: NonNullable<EngineSpec["sources"]>): Promise<{ reason: StopReason; aborted: string | null }> {
  const { items } = deps;
  const account = (stage.filters ?? []).find((f) => f.kind === "account" && isEnabled(f) && (f.values ?? []).length > 0);
  const values = account?.values ?? sources.flatMap((s) => s.names);
  const fields = [account?.field, ...(account?.fields ?? [])].filter((k): k is string => typeof k === "string");
  const share: SourceShare = { fields, values, perValue: Math.max(1, Math.ceil(stage.planned_rows / Math.max(1, values.length))) };
  const period = periodOf(stage, (deps.now ?? Date.now)());
  let last: StopReason = "source_exhausted";
  let anyFailed = false;
  for (let i = 0; i < sources.length; i += 1) {
    if (items.counts(stage.key).accepted >= stage.planned_rows) return { reason: "target_reached", aborted: null };
    const r = await runStream(deps, stage, spec, `s:${i}`, { ...sources[i].params }, null, Number.POSITIVE_INFINITY, period?.field ?? null, { ...share, names: sources[i].names, listing: spec.source_listing === true });
    if (r.aborted) return r;
    if (r.reason === "budget" || r.reason === "daily_cap" || r.reason === "refused" || r.reason === "time_limit" || r.reason === "review_limit" || r.reason === "page_limit") return r;
    if (r.reason === "failed") { anyFailed = true; continue; }
    last = r.reason;
  }
  return { reason: items.counts(stage.key).accepted >= stage.planned_rows ? "target_reached" : anyFailed ? "failed" : last === "target_reached" ? "source_exhausted" : last, aborted: null };
}

/** The items of a stage that belong to the given named sources. */
const acceptedOfSources = (items: ItemStore, stageKey: string, names: ReadonlyArray<string>): number => items.acceptedRows(stageKey).filter((r) => typeof r[SOURCE_KEY] === "string" && names.includes(String(r[SOURCE_KEY]))).length;

/** The oldest moment among mapped rows, read from the period's date field (null when none has one). */
function oldestMomentOf(rows: ReadonlyArray<Record<string, unknown>>, field: string): number | null {
  let oldest: number | null = null;
  for (const r of rows) { const t = parseMoment(r[field])?.getTime(); if (t !== undefined && (oldest === null || t < oldest)) oldest = t; }
  return oldest;
}

/** One stream of pages (a whole source, or one parent's children): resumes from the log, stops on a recorded reason. */
async function runStream(deps: EngineDeps, stage: Stage, spec: EngineSpec, streamKey: string, params: Record<string, unknown>, parentId: string | null, perParentCap: number, periodField: string | null = null, source: (SourceShare & { names: string[]; listing?: boolean }) | null = null): Promise<{ reason: StopReason; aborted: string | null }> {
  const { items, store, gateway } = deps;
  const now = deps.now ?? Date.now;
  // a stage read in DEPTH (up to N pages for each parent) may read parents x N pages
  const depthPages = parentId !== null ? depthPagesOf(stage, spec) : 1;
  const maxPages = Math.max(deps.maxPagesPerStage ?? enginePageCapFor(stage.planned_rows), depthPages > 1 && stage.parent_key ? items.acceptedRows(stage.parent_key).length * depthPages : 0);
  let stallStreak = 0;
  let failures = 0;
  for (;;) {
    const counts = items.counts(stage.key);
    // (the last parent of a stage read in depth may fill the stage's total with its first page: its later pages are still read for a better title, and swap the page-1 people out; the per-parent check below ends it)
    if (counts.accepted >= stage.planned_rows && !(parentId !== null && depthPages > 1)) return { reason: "target_reached", aborted: null };
    const state = items.streamState(stage.key, streamKey);
    if (state?.ended) return { reason: "source_exhausted", aborted: null };
    if (state && state.barren >= BARREN_PAGES) return { reason: "no_new_items", aborted: null };
    if (parentId !== null && items.acceptedRows(stage.key).filter((r) => String(r.parent_id) === parentId).length >= perParentCap) {
      // DEPTH (people of a company): the page that filled the count may hold lower titles while a decision maker is on the next page; reading goes on until enough decision makers were SEEN for this company, the pages of the depth were read, or the source ended
      const depth = depthPagesOf(stage, spec);
      if (depth <= 1 || (state?.pages ?? 0) >= depth || decisionMakersSeen(items, stage, parentId) >= perParentCap) return { reason: "target_reached", aborted: null };
    }
    // a named source whose share is full is not read further
    if (source && acceptedOfSources(items, stage.key, source.names) >= source.perValue * source.names.length) return { reason: "target_reached", aborted: null };
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
      // A PARENT THE SOURCE DOES NOT KNOW (live: aviato.companies.employees answered 404 «Not Found» for 14 of 23 companies, each asked twice by the same input, and three such companies in a row ended the stage with 20 companies never asked): a client error
      // of a lookup for ONE parent is the source's answer for that parent («no such company»), not a failure of the source. It is not asked again with the same input, and it is not counted against the stage; the parent's next input is tried.
      if (parentId !== null && "http_status" in result && PARENT_UNKNOWN_HTTP.has(Number(result.http_status))) return { reason: "source_exhausted", aborted: null };
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
    // THE PEOPLE OF A COMPANY MUST WORK THERE NOW: the source's own experiences for each person are read from the raw page; a person none of whose current jobs names the parent company is marked, and ingest keeps them out (not delivered, not counted, not charged)
    const confirmed = parentId !== null ? markPeopleNotAtCompany(deps, stage, parentId, page, rows.filter(isObject)) : rows.filter(isObject);
    const ranked = parentId !== null && stage.role_preference ? rankPeopleByRole(confirmed, stage.role_preference.role).rows : confirmed;
    const incoming: Row[] = ranked.map((r) => (parentId !== null ? { ...r, parent_id: parentId } : r));
    const nextCursor = pageMode ? (result.rows_in_page > 0 ? String((cursor !== null ? Number(cursor) : Number(params.page)) + 1) : null) : result.next_cursor ?? null;
    const ended = pageMode ? result.rows_in_page === 0 : !nextCursor || result.rows_in_page === 0 || result.has_more === false || !spec.cursor_param;
    const before = items.counts(stage.key).accepted;
    // a parent's share (per_parent_rows) is a cap on what this page may add for it
    const have = parentId !== null ? items.acceptedRows(stage.key).filter((r) => String(r.parent_id) === parentId).length : 0;
    const oldestMs = periodField !== null ? oldestMomentOf(incoming, periodField) : null;
    await ingestRows(deps, stage, incoming, { silent: true, idField: spec.id_field ?? null, ...(parentId !== null && Number.isFinite(perParentCap) ? { acceptCap: Math.max(0, perParentCap - have) } : {}), ...(source ? { sourceQuota: { fields: source.fields, values: source.values, perValue: source.perValue, ...(source.listing && source.names.length === 1 ? { defaultSource: source.names[0] } : {}) } } : {}), page: { stream: streamKey, call_id: result.call_id, cursor_in: cursor, cursor_next: nextCursor, has_more: result.has_more, ended, rows_in_page: result.rows_in_page, ...(oldestMs !== null ? { oldest_ms: oldestMs } : {}) } });
    // a decision maker read on this page takes the place of a lower title accepted from an earlier page of the same company
    if (parentId !== null && depthPages > 1) await upgradeDecisionMakers(deps, stage, parentId);
    await emitStageProgress(deps, stage, { collecting: true });
    // the review had nothing left to give while items still wait: pages that add nothing are not bought for ever
    const after = items.counts(stage.key);
    if (after.accepted === before && after.pending > 0 && deps.reviewer && (await deps.reviewer.state()).stop) stallStreak += 1; else stallStreak = 0;
    if (stallStreak >= REVIEW_STALL_PAGES) return { reason: "review_limit", aborted: null };
  }
}
