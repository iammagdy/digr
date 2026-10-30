import { AGENT_MAX_DELIVERED_ROWS, MAX_COLUMNS_PER_STAGE, MAX_PLAN_STAGES, MAX_SAMPLE_ROWS_PER_STAGE } from "./constants";
import { CONTACT_KINDS, requestWantsContacts, type ContactKind } from "./contacts";
import { estimateMissionMinutes, measuredCostPerRowUsd, priceMissionByCode, type MissionPriceResult } from "./price";
import { classifyRows, searchQueryOf, validateRelevanceSpec, type RelevanceSpec } from "./relevance";
import { minimumLineAr, type MissionPricingSettings } from "../missionPricing";
import { checkCustomerLabel, checkCustomerText } from "./text";
import { FIELD_LABEL_AR, uncoveredFields, usefulFieldsOfPage, type SourceField } from "./fields";
import { neutralPeopleTitleAr, roleLineAr, roleOfNoun, type RoleKey } from "./roles";
import { bindQuantity, bindQuantityDetailed, countedQuantities, ownTitleWords, perParentAskFor, perParentAskOf, perParentQuantities, perSourceQuantities, requestedStageIndexes, sameNounStem, unservedPerParentAsks } from "./quantity";
import { itemNounOf } from "./itemNoun";
import { isTextItemStage, textKeyOf } from "./contract";
import { childCardTitleAr, childRuleLinesAr } from "./childItems";
import { platformCostNotesAr } from "./platformNotes";
import type { DateWindow } from "./dateWindow";
import { unresolvedSourcesLineAr } from "./namedSources";
import { APPROX_DATES_CARD_LINE_AR } from "./relativeDates";
import { isCompanyStage, isEntityStage, requestNamesSector, sectorEnglishWords, sectorWordsOf } from "./entities";
import { placeEntry, placeLabelsAr, placesInText } from "./places";
import { excludesGovernment } from "./government";
import { isMediaCapability, keySaysMedia, rawMediaProof, requestedMedia } from "./mediaProof";
import { assumptionLinesShown, CHILD_RAW_FILTER_KINDS, defaultLanguageOf, filterVerdict, filterLabelAr, filterLineAr, findFilterFields, isEnabled, kindsPromisedBy, parseFilters, promiseIssues, resolveFilters, type StageFilter } from "./filters";

/**
 * A mission PLAN: stages (a stage runs once per row of its parent stage), the rows each is expected to give, sample rows the agent really saw, and the calls that MEASURED the cost.
 * The agent writes this through propose_plan. `validateAndPricePlan` checks it against what was recorded and prices it by code; the agent never supplies a price.
 */
export interface PlanColumn {
  key: string;
  title_ar: string;
  /** Set on a column that holds a work e-mail or a phone: its values are verified by code before a row is saved; an unverified value is left empty. */
  kind?: ContactKind;
}

/**
 * WHAT CODE NEEDS TO RUN A STAGE WITHOUT THE MODEL (the model PLANS, code EXECUTES). Derived BY CODE at plan time from what the agent really did (never written by the agent): the source and its first-page inputs, the name of its
 * cursor input, the mapping code the agent ran on the measured page (re-run at plan time on that very page and proven to give the same rows), and, for a stage with a parent, which input takes which field of the parent row.
 * Internal: it is never part of what a customer reads (customerPlanView lists its fields one by one).
 */
export interface EngineSpec {
  endpoint_id: string;
  /** The inputs of the FIRST page, exactly as the measuring call had them (the cursor input is added by code for the next pages). */
  params: Record<string, unknown>;
  /** The endpoint's own paging input, or null when it has none (one page). */
  cursor_param: string | null;
  /** The agent's mapping code: the body of a function over `inputs`, turning ONE saved page into the stage's final rows. */
  map_code: string;
  /** The key of `inputs` the page is handed under (the id of the saved page the code was measured on). */
  map_file_id: string;
  /** A stage with a parent: the input that takes a field of the parent's row (`from` is a column key of the parent stage, or «id»). */
  parent_binding: { param: string; from: string } | null;
  /** The field of the mapped items that keys them when they carry no `id` of their own (chosen by code from the measured page: a platform id, a link, or «$content» for the fingerprint). Absent: the items carry `id`. */
  id_field?: string;
  /** The source's own date inputs, from the catalog (dateWindow.ts): when the source ends before a requested period is reached, the engine asks again with the end of the window moved back. Absent: the source has none documented. */
  window?: DateWindow;
  /** A stage whose customer named SEVERAL sources (channels, pages, accounts) read by one measuring call each: the first-page inputs that gave each named source (or several of them, when one call showed them all), the engine reads them in turn, each named source up to its own share (namedSources.ts). Absent: one query serves the stage. */
  sources?: Array<{ names: string[]; params: Record<string, unknown> }>;
  /** The endpoint lists the items of ONE source named by its own input (a channel's videos): an item that names no author belongs to the source that was asked for. */
  source_listing?: boolean;
}

export interface ProposedStage {
  key: string;
  title_ar: string;
  endpoint_id: string;
  expected_rows: number;
  parent_key: string | null;
  /** Rows taken from each parent row (required for a stage with a parent). */
  per_parent_rows?: number;
  /** Whether this stage's rows go into the customer's files (and count in the charge). */
  deliver: boolean;
  columns: PlanColumn[];
  sample_rows: Array<Record<string, unknown>>;
  /** Ids of the saved calls (and code outputs) this stage's cost and sample rows come from. */
  measured_by: string[];
  how_ar?: string;
  /** What «matching» means for this stage's rows (a person, an entity, a topic): applied by code to every row BEFORE it is saved, so a row that does not match is neither delivered nor charged. */
  relevance?: RelevanceSpec;
  /** The id of a run_code output holding ALL the rows of the measured page, mapped to this stage's columns: the code classifies them to know the share of matching rows (the yield) the price rests on. */
  yield_from?: string;
  /** Set by code when the stage can be executed without the model (see EngineSpec). Absent: the model carries the stage out, through the same item store. */
  engine?: EngineSpec;
  /** What the card promises about the stage's items (replies, language, period, account, place): each one is a check code applies to every item before it is saved (filters.ts). The model declares them; code fills their fields from the mapping. */
  filters?: StageFilter[];
  /** Only when the model proposes FEWER items than the customer asked for: one Arabic sentence, with no number, saying why (the card shows it). Without it the customer's quantity is the target. */
  target_reason_ar?: string;
  /** Set by code from the request's own noun («اتنين من المديرين»): the people of each parent are ranked by the job title the source gives, the matching ones first (roles.ts). Never a filter: the count is always completed. */
  role_preference?: { role: RoleKey };
  /** Columns the customer switched off in the plan editor (kept so they can be switched back on). */
  hidden_columns?: PlanColumn[];
  /** Set by code at plan time: the sources the customer NAMED (a channel, a page, an account) that no item of what the agent sampled belongs to. The card says so before approval; nothing is invented for them. */
  unresolved_sources?: string[];
  /** Set by code at plan time: the date columns of this stage in which the source gives only a RELATIVE time («قبل ٣ أيام»); the dates are approximate and the card says so. */
  approx_dates?: string[];
}

export interface ProposedPlan {
  summary_ar: string;
  stages: ProposedStage[];
  /** What the agent assumed where the request left a choice open, one plain Arabic line each (shown on the plan card; the customer may change them before approving). */
  assumptions_ar?: string[];
}

/** What the plan check knows about a call the mission already made (read from mission_calls; the gateway wrote it). */
export interface RecordedCall {
  id: string;
  endpointId: string;
  ok: boolean;
  /** Actual charge, USD. */
  costUsd: number;
  /** Rows counted by code from the saved page. */
  rows: number;
  /** How long the call took (ms), when known: the expected time of the mission is computed from it. */
  durationMs?: number;
  /** The call's parameters as recorded (short values): whether the stage was found by a free-text search. */
  params?: Record<string, unknown>;
}

export interface PlanLookup {
  call(id: string): RecordedCall | null;
  /** Text of a saved page or code output (to prove a sample row's id and links were really seen). Null when the id is unknown. */
  evidenceText(id: string): string | null;
  /** The catalog capability of an endpoint («facebook.search.posts»), or null: a card that promises videos (or images) needs the proof of it unless the source's own kind IS the media. */
  endpointCapability?(endpointId: string): string | null;
  /** May this endpoint be sold to this account (sellable, not blocked, data policy)? */
  endpointAllowed(endpointId: string): boolean;
  /** The customer's own words: when they ask for work e-mails or phones the plan must have a contact stage (or say honestly why not). */
  requestText?: string;
  /** The customer's answer to the agent's one question, when it asked one: a quantity in it wins over the one in the request. */
  answerText?: string;
  /** Is this source one whose rows are contacts (a b2b_contact endpoint, the e-mail / phone parser)? */
  isContactSource?(endpointId: string): boolean;
  /** The markup and the minimum charge in force (the admin's settings); the defaults when absent. */
  pricingSettings?: MissionPricingSettings;
  /** The catalog sources that can carry out a step the request asks per parent (the people of a company), cheapest first: a plan may not call such a step «unserved» while one of them was never tried. */
  childStepSources?(noun: string): Array<{ id: string; accepts: string[] }>;
  /** The endpoints this mission has called so far and the most rows one call of each gave. */
  endpointsCalled?(): ReadonlyMap<string, { rows: number }>;
}

export interface PricedStage extends ProposedStage {
  /** Rows the stage will collect at most (the agent's estimate, checked against its parent). */
  planned_rows: number;
  /** Measured cost per row of this stage, USD (internal). */
  measured_cost_per_row_usd: number;
  measured_from_calls: string[];
  /** How long the measuring calls took per row they returned (ms), when known (internal; the expected time is computed from it). */
  measured_ms_per_row?: number;
  /** Share of the sampled rows that match the request (1 when the stage has no relevance check) and of them the share the model must review: what the price rests on (internal). */
  yield_share?: number;
  review_share?: number;
  sample_examined?: number;
  sample_matching?: number;
}

export interface PricedPlan {
  summary_ar: string;
  /** Honest sentences the customer reads next to the summary (for example: why the e-mails they asked for are not in the plan). */
  notes_ar?: string[];
  /** What the agent assumed, one plain Arabic line each (the intended meaning of the request first). */
  assumptions_ar?: string[];
  stages: PricedStage[];
  price: MissionPriceResult;
  /** THE CUSTOMER'S QUANTITY, read by code from their words (or set by them in the plan editor): the target of the stage that counts it. `target` equals `requested` unless the model proposed fewer, with a reason the card shows. */
  quantity?: PlanQuantity;
  /** A step the customer asked for that the plan does not carry out (the managers of each company): what it is and why, shown on the card BEFORE approval. The customer approves the rest or edits the request; a step is never dropped silently. */
  unserved_steps?: UnservedStep[];
}

export interface UnservedStep {
  /** The step as the customer asked for it («من كل شركة اتنين من المديرين»), built by code from the request. */
  what_ar: string;
  /** Why the plan cannot serve it (one Arabic sentence, no number): the model's, checked by code. */
  reason_ar: string;
}

export interface PlanQuantity {
  requested: number;
  stage_key: string;
  target: number;
  reason_ar?: string;
  source: "request" | "edit";
}

export type PlanCheck = { ok: true; plan: PricedPlan } | { ok: false; issues: string[] };

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_ASSUMPTIONS = 6;

/** What the price is computed from, per stage: rows, measured cost per raw row, whether it is delivered, and the share of the sample that matches (relevance). The one place the stored plan and a fresh plan are priced alike. */
export const stagePriceInputs = (stages: ReadonlyArray<PricedStage>) => stages.map((s) => ({ rows: s.planned_rows, costPerRowUsd: s.measured_cost_per_row_usd, deliver: s.deliver, yield: s.yield_share, reviewShare: s.review_share }));
/** A column that only holds an internal id (the key says so, or its Arabic title is «معرّف …»): never shown to the customer as a column, never a column of its own in the sheet. */
export function isInternalColumn(c: { key: string; title_ar: string }): boolean {
  return /^(id|uid|pk|guid|parent_id|parent)$/i.test(c.key) || /(^|_)(id|uid|pk|guid)$/i.test(c.key) || /^id_/i.test(c.key) || /معرّ?ف/.test(c.title_ar);
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every string value of a sample row that looks like an id or a link must be present in the evidence the stage cites. */
function sampleRowIssues(row: Record<string, unknown>, evidence: string, stageKey: string): string[] {
  const issues: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    const text = typeof v === "number" || typeof v === "string" ? String(v) : "";
    if (!text) continue;
    const isLink = /^https?:\/\//i.test(text);
    const isId = /(^|_)(id|uid|pk)$/i.test(k);
    if ((isLink || isId) && !evidence.includes(text)) issues.push(`stage «${stageKey}»: the sample value ${k}=${text.slice(0, 60)} is not in the saved pages the stage cites (never invent ids or links)`);
  }
  return issues;
}

/** A sentence that promises a language or a topic. */
const CHILD_FILTER_PROMISE = /عربي(?:ة|ا|ًا)?(?![\u0621-\u064A])|بالعربية|باللغة|إنجليزي|انجليزي|الإنجليزية|الانجليزية|متعلق|ذات\s+(?:ال)?صلة|تتعلق|تخص|مطابق|عن\s+(?:ال)?موضوع/;
/** A sentence that says the items are delivered as they are. */
const RAW_STATEMENT = /دون\s+(?:أي\s+)?(?:تصفية|فلترة|تصفيه)|كما\s+(?:هي|يعطيها|يعرضها|تعرضها|يقدمها|تظهر)|بلا\s+(?:تصفية|فلترة)/;

/**
 * THE ITEMS OF A CHILD STAGE ARE DELIVERED RAW, so no sentence of the card may promise a language or a topic for them. A sentence that names the child items (the words of the child stage's title) and promises a language or a topic is refused with the way to fix it:
 * say the language of the PARENTS («الفيديوهات بالعربية») in one sentence and the children in another («التعليقات كما يعطيها المصدر»).
 */
export function childPromiseIssues(sentences: ReadonlyArray<{ where: string; text: string }>, childTitles: ReadonlyArray<string>): string[] {
  if (childTitles.length === 0) return [];
  const childWords = childTitles.flatMap((t) => ownTitleWords(t));
  const issues: string[] = [];
  for (const s of sentences) {
    if (RAW_STATEMENT.test(s.text) || !CHILD_FILTER_PROMISE.test(s.text)) continue;
    const words = s.text.split(/[\s،,.؛:()«»"'؟?!]+/).filter(Boolean);
    if (words.some((w) => childWords.some((c) => sameNounStem(c, w) || sameNounStem(c, w.replace(/^و(?=.{3,})/, ""))))) issues.push(`${s.where}: it promises a language or a topic for the child items (${childTitles.join("، ")}); the child items are delivered exactly as the source gives them, with no language or topic rule. Say the language or the topic of the PARENTS only, in its own sentence, and say of the children only that they come as the source gives them`);
  }
  return issues;
}

/**
 * THE DELIVERED STAGES, THE HEADLINE AND THE TOTAL AGREE (checked on the finished plan, by code, never left to the model):
 *  (1) a stage whose items the customer asked for (`requested`: the counted noun and every per-parent noun of the request) is never an intermediate stage: the plan loop delivers it, this refuses a plan where one slipped through;
 *  (2) the headline sentence the card shows states a count only when that count is in the file: a number equal to the target of an intermediate stage (and of no delivered one) promises items the file does not hold.
 * The card's «المجموع في ملفك» is the sum of the delivered stages' targets (`stagesView`), which is what the price is built on, so with (1) and (2) the three say the same.
 */
export function deliveryConsistencyIssues(stages: ReadonlyArray<Pick<PricedStage, "key" | "title_ar" | "planned_rows" | "deliver">>, summaryAr: string, requested: ReadonlySet<number>): string[] {
  const issues: string[] = [];
  stages.forEach((s, i) => { if (requested.has(i) && !s.deliver) issues.push(`stage «${s.key}» (${s.title_ar}) is an intermediate stage, but the customer asked for its items: they must be delivered in their own sheet (deliver: true)`); });
  const deliveredCounts = new Set(stages.filter((s) => s.deliver).map((s) => s.planned_rows));
  const titles = stages.map((s) => s.title_ar);
  for (const q of countedQuantities(firstSentenceAr(summaryAr), titles)) {
    const hidden = stages.find((s) => !s.deliver && s.planned_rows === q.value);
    if (hidden && !deliveredCounts.has(q.value)) issues.push(`summary_ar promises ${q.value} items of «${hidden.title_ar}», which is an intermediate stage and is not in the customer's file: deliver that stage or leave the count out of the sentence`);
  }
  return issues;
}

export function validateAndPricePlan(input: unknown, lookup: PlanLookup): PlanCheck {
  const issues: string[] = [];
  if (!isRecord(input)) return { ok: false, issues: ["the plan must be an object"] };
  const stagesIn = Array.isArray(input.stages) ? input.stages : [];
  if (stagesIn.length < 1 || stagesIn.length > MAX_PLAN_STAGES) return { ok: false, issues: [`a plan has 1 to ${MAX_PLAN_STAGES} stages`] };
  const summary = checkCustomerText(input.summary_ar, { maxChars: 600 });
  if (summary.issues.length) issues.push(`summary_ar: ${summary.issues.join("; ")}`);

  const keys = new Set<string>();
  const planned = new Map<string, number>();
  const priced: PricedStage[] = [];

  // THE CUSTOMER'S QUANTITY is read by code from their words (the answer to the agent's question wins over the request): it is the target of the stage that counts it
  const refs = stagesIn.map((st, index) => ({ index, title_ar: isRecord(st) ? String(st.title_ar ?? "") : "", deliver: isRecord(st) && st.deliver === true }));
  const quantityText = lookup.answerText && bindQuantity(lookup.answerText, refs) ? lookup.answerText : lookup.requestText ?? "";
  const bound0 = quantityText ? bindQuantityDetailed(quantityText, refs) : null;
  // «٥ فيديوهات من كل قناة» with three named channels: no total in the words, a count PER NAMED SOURCE; the stage that counts that noun has its sources' count x that number as its target (read by code from the stage's own account filter)
  const accountValuesOf = (st: unknown): number => (isRecord(st) && Array.isArray(st.filters) ? st.filters.filter((f) => isRecord(f) && f.kind === "account" && f.enabled !== false && Array.isArray(f.values)).reduce((n, f) => Math.max(n, (f as { values: unknown[] }).values.length), 0) : 0);
  const perSourceAsk = quantityText && !bound0 ? perSourceQuantities(quantityText)[0] : undefined;
  const perSourceStage = perSourceAsk ? stagesIn.findIndex((st, index) => isRecord(st) && (st.parent_key === null || st.parent_key === undefined || st.parent_key === "") && accountValuesOf(st) > 0 && ownTitleWords(String(st.title_ar ?? "")).some((w) => sameNounStem(w, perSourceAsk.noun!)) && index >= 0) : -1;
  const bound = bound0 ?? (perSourceAsk && perSourceStage >= 0 ? { index: perSourceStage, value: perSourceAsk.value * accountValuesOf(stagesIn[perSourceStage]), named: true } : null);
  let quantity: PlanQuantity | undefined;
  // what the request asks PER PARENT item (the steps that hang on another step): read by code, never by the model
  const perParentAsks = perParentQuantities(`${lookup.requestText ?? ""} ${lookup.answerText ?? ""}`);
  // THE STAGES WHOSE ITEMS THE CUSTOMER ASKED FOR (the counted noun and every per-parent noun) ARE DELIVERED, whatever the model marked: only items nobody asked for may be an intermediate stage (checked again below, on the finished plan)
  const stageRefs = stagesIn.map((st, index) => ({ index, title_ar: isRecord(st) ? String(st.title_ar ?? "") : "", parent_key: isRecord(st) && st.parent_key !== null && st.parent_key !== undefined && st.parent_key !== "" ? String(st.parent_key) : null }));
  const requestedStages = new Set<number>([...requestedStageIndexes(quantityText, stageRefs), ...requestedStageIndexes(`${lookup.requestText ?? ""} ${lookup.answerText ?? ""}`, stageRefs)]);
  /** How much the quantity changed the rows of a stage: the stages that hang on it follow in proportion. */
  const rowScale = new Map<string, number>();

  for (let i = 0; i < stagesIn.length; i += 1) {
    const given = stagesIn[i];
    // THE ITEMS THE CUSTOMER ASKED FOR ARE DELIVERED: «هات ٥ فيديوهات ... ومن كل فيديو ١٠ تعليقات» asks for the videos AND the comments, «ومن كل شركة اتنين من المديرين» for the people; a stage the model kept as an intermediate one is delivered by code
    const raw = isRecord(given) && (requestedStages.has(i) || (bound?.named && bound.index === i)) && given.deliver !== true ? { ...given, deliver: true } : given;
    if (!isRecord(raw)) { issues.push(`stage ${i + 1} is not an object`); continue; }
    const key = String(raw.key ?? "");
    const label = `stage «${key || i + 1}»`;
    if (!KEY_RE.test(key)) { issues.push(`${label}: key must be letters, digits and underscores`); continue; }
    if (keys.has(key)) { issues.push(`${label}: duplicate key`); continue; }
    keys.add(key);

    const title = checkCustomerLabel(raw.title_ar);
    if (title.issues.length) issues.push(`${label} title_ar: ${title.issues.join("; ")}`);
    const how = raw.how_ar === undefined ? null : checkCustomerText(raw.how_ar, { maxChars: 300 });
    if (how && how.issues.length) issues.push(`${label} how_ar: ${how.issues.join("; ")}`);

    const endpointId = String(raw.endpoint_id ?? "");
    if (!lookup.endpointAllowed(endpointId)) issues.push(`${label}: the endpoint is not available for this account`);

    const expected = Number(raw.expected_rows);
    if (!Number.isInteger(expected) || expected < 1) issues.push(`${label}: expected_rows must be a whole number of at least 1`);

    const parentKey = raw.parent_key === null || raw.parent_key === undefined || raw.parent_key === "" ? null : String(raw.parent_key);
    let rowsHere = Number.isInteger(expected) ? expected : 0;
    const reasonIn = raw.target_reason_ar === undefined || raw.target_reason_ar === null ? null : checkCustomerText(raw.target_reason_ar, { maxChars: 200 });
    // the quantity: the target IS what the customer asked for; fewer only with a reason the card shows (a sentence with no number: the card states the numbers itself)
    if (bound && bound.index === i && rowsHere >= 1) {
      const requested = bound.value;
      const reasonIssues = reasonIn ? [...reasonIn.issues, ...(/[0-9٠-٩]/.test(reasonIn.text) ? ["no number in the reason: the card states the numbers itself"] : [])] : [];
      if (rowsHere < requested && reasonIn && reasonIssues.length === 0) quantity = { requested, stage_key: key, target: rowsHere, reason_ar: reasonIn.text, source: "request" };
      else {
        if (rowsHere < requested && reasonIn) issues.push(`${label} target_reason_ar: ${reasonIssues.join("; ")}`);
        if (rowsHere !== requested) rowScale.set(key, requested / rowsHere);
        rowsHere = requested;
        quantity = { requested, stage_key: key, target: requested, source: "request" };
      }
    } else if (reasonIn && reasonIn.issues.length) issues.push(`${label} target_reason_ar: ${reasonIn.issues.join("; ")}`);
    const isChild = parentKey !== null;
    let perHere = Number(raw.per_parent_rows);
    // THE CUSTOMER'S NUMBER PER PARENT («مع كل بوست ١٠ تعليقات») is the stage's per-parent number whatever the model wrote, and the stage's target is parents x that number: every parent is read up to it. The model cannot lower it (the card would promise less
    // than was asked); what the source really gives is told at the end, per parent, from the data.
    const askedPerParent = isChild ? perParentAskFor(perParentAsks, title.text, stagesIn.filter((x) => isRecord(x) && x.parent_key !== null && x.parent_key !== undefined && x.parent_key !== "").length) : null;
    // THE ROLE THE CUSTOMER NAMED among the people of each parent («اتنين من المديرين»): code ranks them by the job title the source gives
    const askedOf = isChild ? perParentAskOf(perParentAsks, title.text, stagesIn.filter((x) => isRecord(x) && x.parent_key !== null && x.parent_key !== undefined && x.parent_key !== "").length) : null;
    const roleOf = askedOf ? roleOfNoun(askedOf.of ?? askedOf.noun) : null;
    if (parentKey !== null) {
      if (!planned.has(parentKey)) issues.push(`${label}: parent «${parentKey}» must be an EARLIER stage`);

      const per = askedPerParent ?? Number(raw.per_parent_rows);
      perHere = per;
      if (!Number.isInteger(per) || per < 1) issues.push(`${label}: a stage with a parent needs per_parent_rows (a whole number, at least 1)`);
      else if (planned.has(parentKey)) {
        const ceiling = planned.get(parentKey)! * per;
        if (askedPerParent !== null && quantity?.stage_key !== key) rowsHere = ceiling;
        // a stage that hangs on a parent whose rows the quantity changed follows it in proportion (never above what the parent can give)
        const ratio = rowScale.get(parentKey);
        if (ratio !== undefined && rowsHere >= 1 && quantity?.stage_key !== key && askedPerParent === null) { const scaled = Math.max(1, Math.min(ceiling, Math.round(rowsHere * ratio))); rowScale.set(key, scaled / rowsHere); rowsHere = scaled; }
        if (rowsHere > ceiling) issues.push(`${label}: ${quantity?.stage_key === key ? "the customer asked for" : "expected_rows is"} ${rowsHere}, more than its parent can give (${planned.get(parentKey)} parent rows x ${per} = ${ceiling}); ${quantity?.stage_key === key ? "raise the parent stage's expected_rows or per_parent_rows, or give target_reason_ar (one sentence, no number) when the source cannot give that many" : "lower it"}`);
      }
    }
    planned.set(key, rowsHere);

    const columns = Array.isArray(raw.columns) ? raw.columns : [];
    if (columns.length < 1 || columns.length > MAX_COLUMNS_PER_STAGE) issues.push(`${label}: 1 to ${MAX_COLUMNS_PER_STAGE} columns`);
    const colKeys = new Set<string>();
    const colTitles = new Set<string>();
    const cleanColumns: PlanColumn[] = [];
    for (const c of columns) {
      if (!isRecord(c) || !KEY_RE.test(String(c.key ?? "")) || colKeys.has(String(c.key))) { issues.push(`${label}: every column needs a unique key (letters, digits, underscores)`); continue; }
      colKeys.add(String(c.key));
      const t = checkCustomerLabel(c.title_ar);
      if (t.issues.length) issues.push(`${label} column «${c.key}»: ${t.issues.join("; ")}`);
      // every row already carries its own id and its parent's id: a column that only repeats an id, or a second column with the same title, is dropped (the sheet is for people to read)
      if (isInternalColumn({ key: String(c.key), title_ar: t.text }) || colTitles.has(t.text)) continue;
      colTitles.add(t.text);
      const kind = CONTACT_KINDS.includes(c.kind as ContactKind) ? (c.kind as ContactKind) : undefined;
      cleanColumns.push({ key: String(c.key), title_ar: t.text, ...(kind ? { kind } : {}) });
    }
    if (cleanColumns.length === 0 && issues.length === 0) issues.push(`${label}: give at least one readable column (an id is not one; every row already carries its own id)`);

    const measuredBy = Array.isArray(raw.measured_by) ? raw.measured_by.map(String) : [];
    const measuredCalls: Array<{ costUsd: number; rows: number }> = [];
    let foundBySearch = false;
    let measuredMs = 0;
    let measuredMsRows = 0;
    let evidence = "";
    if (measuredBy.length === 0) issues.push(`${label}: measured_by must cite the calls that measured it (ids returned by treg_call)`);
    const sourceFields: SourceField[] = [];
    for (const id of measuredBy) {
      const call = lookup.call(id);
      const text = lookup.evidenceText(id);
      if (text) evidence += `\n${text}`;
      if (text && id.startsWith("call_")) for (const f of usefulFieldsOfPage(text)) if (!sourceFields.some((x) => x.cls === f.cls)) sourceFields.push(f);
      if (!call) { if (text === null) issues.push(`${label}: «${id}» is not a call or output of this mission`); continue; }
      if (call.endpointId !== endpointId) { issues.push(`${label}: call «${id}» measured another source than the stage uses`); continue; }
      if (!call.ok || call.rows <= 0) { issues.push(`${label}: call «${id}» returned no rows; it cannot measure the cost`); continue; }
      measuredCalls.push({ costUsd: call.costUsd, rows: call.rows });
      if (searchQueryOf(call.params) !== null) foundBySearch = true;
      if (typeof call.durationMs === "number" && call.durationMs > 0) { measuredMs += call.durationMs; measuredMsRows += call.rows; }
    }
    const costPerRow = measuredCostPerRowUsd(measuredCalls);
    if (measuredCalls.length === 0 || costPerRow === null) issues.push(`${label}: no measured call with rows and a recorded charge`);
    else if (!(costPerRow > 0)) issues.push(`${label}: the measured charge is zero, so no price can be built on it; measure with a call that was charged`);

    // EVERY USEFUL FIELD THE SOURCE GIVES stays in the file: a date, an author, a link, the counts (likes, replies, shares, views) that the saved page carries must each have a column (the agent maps them in its code)
    if (raw.deliver === true) {
      const missing = uncoveredFields(sourceFields, cleanColumns);
      if (missing.length > 0) issues.push(`${label}: the source gives fields the customer would want in the file that no column holds: ${missing.map((f) => `${FIELD_LABEL_AR[f.cls]} (${f.path})`).join(", ")}. Add a column for each (map it in your run_code and give it an Arabic title like «${FIELD_LABEL_AR[missing[0].cls]}»): the file keeps every useful field of the source`);
    }
    if (lookup.isContactSource?.(endpointId) && !cleanColumns.some((c) => c.kind !== undefined)) issues.push(`${label}: a contact stage must mark its e-mail / phone columns with kind "work_email" or "phone" (their values are verified by code; an unverified value is left empty and a row with none is not delivered or charged)`);
    const samples = Array.isArray(raw.sample_rows) ? raw.sample_rows : [];
    if (samples.length < 1 || samples.length > MAX_SAMPLE_ROWS_PER_STAGE) issues.push(`${label}: 1 to ${MAX_SAMPLE_ROWS_PER_STAGE} sample_rows, rows you really saw`);
    for (const s of samples) {
      if (!isRecord(s)) { issues.push(`${label}: a sample row must be an object`); continue; }
      if (evidence) issues.push(...sampleRowIssues(s, evidence, key));
    }

    // THE ENTITY STAGES (companies, restaurants, places, people, accounts): the place the card names is enforced from the items' fields, and a COMPANY stage whose request names a sector needs a relevance rule that checks the kind of entity
    const entityStage = raw.deliver === true && !isChild && isEntityStage({ title_ar: title.text });
    const companyStage = entityStage && isCompanyStage({ title_ar: title.text });
    const requestWords = `${lookup.requestText ?? ""} ${lookup.answerText ?? ""}`;

    // RELEVANCE: a stage whose rows were FOUND by a text search must say what «matching» means, and the share of the sample that matches is computed here, by code, from the rows the agent cites
    let relevance: RelevanceSpec | undefined;
    let yieldRows: Array<Record<string, unknown>> | null = null;
    let yieldShare = 1;
    let reviewShare = 0;
    let sampleExamined = 0;
    let sampleMatching = 0;
    // THE ITEMS OF A CHILD STAGE ARE RAW (childItems.ts): the topic rule is the PARENT's; a relevance rule given on a child stage is not applied and does not touch its price
    if (raw.relevance !== undefined && raw.relevance !== null && !isChild) {
      const checkedRel = validateRelevanceSpec(raw.relevance, cleanColumns.map((c) => c.key));
      if (!checkedRel.ok) issues.push(...checkedRel.issues.map((m) => `${label}: ${m}`));
      else {
        relevance = companyStage ? { ...checkedRel.spec, entity: true } : checkedRel.spec;
        const yieldId = String(raw.yield_from ?? "");
        const yieldText = yieldId ? lookup.evidenceText(yieldId) : null;
        let sampleRows: Array<Record<string, unknown>> | null = null;
        if (yieldText) { try { const parsed = JSON.parse(yieldText) as unknown; if (Array.isArray(parsed) && parsed.every(isRecord)) sampleRows = parsed as Array<Record<string, unknown>>; } catch { sampleRows = null; } }
        if (!sampleRows || sampleRows.length < 1) issues.push(`${label}: yield_from must be the id of a run_code output (out_0001 ...) that holds an ARRAY of ALL the rows of the page you measured, mapped to this stage's columns (so the code can count how many match; never only the best rows)`);
        else {
          yieldRows = sampleRows;
          const { counts } = classifyRows(relevance, sampleRows);
          sampleExamined = counts.examined;
          sampleMatching = counts.match;
          if (counts.match + counts.review === 0) issues.push(`${label}: none of the ${counts.examined} rows of the sample matches your relevance rule (${Object.entries(counts.excluded).map(([k, v]) => `${k}: ${v}`).join(", ")}); fix the rule, sample another source or another query, or finish with cannot_serve`);
          // the price rests on the cost per MATCHING row: matching rows count fully, uncertain ones (reviewed by the model, about half pass) count half
          yieldShare = Math.min(1, Math.max(0.02, (counts.match + 0.5 * counts.review) / counts.examined));
          reviewShare = counts.review / counts.examined;
          const bad = samples.filter(isRecord).filter((r) => classifyRows(relevance!, [r]).counts.match !== 1);
          if (bad.length) issues.push(`${label}: ${bad.length} of your sample_rows do not match your own relevance rule; show only rows that match`);
        }
      }
    } else if (companyStage && requestNamesSector(requestWords) && cleanColumns.length > 0) {
      // THE KIND OF COMPANY IS CHECKED EVEN WHEN THE MODEL GAVE NO RULE (the customer asked for a sector, and a source that lists companies by country returns exhibitions and other trades too): code builds the rule from the request's own words, over the
      // name and description columns; a company it cannot place in the sector, or that looks like an event or a publication, goes to the model check, never straight to delivery
      const words = sectorWordsOf(requestWords).slice(0, 4);
      const named = cleanColumns.filter((c) => /name|title|desc|about|industry|sector|summary|text|company/i.test(c.key)).map((c) => c.key).slice(0, 3);
      relevance = { subject_ar: `شركات ${words.slice(0, 3).join(" ")}`, terms: [...new Set(words.flatMap((w) => [w, w.replace(/ات$/, "ة"), ...sectorEnglishWords(w)]))].slice(0, 14), text_columns: named.length > 0 ? named : [cleanColumns[0].key], min_own_words: 0, review: true, entity: true };
    } else if (foundBySearch && raw.deliver === true && !isChild) {
      issues.push(`${label}: its rows were found by a text search, so it needs \`relevance\` (subject_ar, terms, context_terms, exclude_terms, text_columns) and \`yield_from\`: code keeps only the rows that are ABOUT what the customer asked and charges only for those`);
    }

    // WHAT THE CARD PROMISES ABOUT THE ITEMS is a filter in code: its fields are found by code from what the mapping gives (the measured rows, the columns, the relevance text columns); a filter nothing can enforce is refused
    const declared = parseFilters(raw.filters, label);
    issues.push(...declared.issues);
    // a language or a place filter given on a child stage is not applied (the items are delivered as the source gives them)
    if (isChild) declared.filters = declared.filters.filter((f) => !CHILD_RAW_FILTER_KINDS.includes(f.kind));
    const mappedKeys = [...new Set([...(yieldRows ?? []).flatMap((r) => Object.keys(r)), ...samples.filter(isRecord).flatMap((r) => Object.keys(r))])];
    const fields = findFilterFields({ mappedKeys, columnKeys: cleanColumns.map((c) => c.key), textColumns: relevance?.text_columns, columnTitles: Object.fromEntries(cleanColumns.map((c) => [c.key, c.title_ar])) });
    // THE ONE LANGUAGE RULE: the request's language is the default language of the items of every text stage (tweets, posts, comments, reviews); a language filter the plan already switched on is the plan's own choice
    const requestLang = raw.deliver === true && !isChild && isTextItemStage({ title_ar: title.text }) && (fields.lang || fields.text) ? defaultLanguageOf(lookup.requestText, lookup.answerText) : null;
    const declaredWithLanguage = requestLang && !declared.filters.some((f) => f.kind === "language" && isEnabled(f))
      ? [...declared.filters.filter((f) => f.kind !== "language"), { kind: "language" as const, lang: requestLang }]
      : declared.filters;
    // GOVERNMENT BODIES: a request (or a card sentence) that leaves them out is a filter of the stage, applied from the website's suffix and the name (government.ts); never only a promise
    const wantsNoGovernment = entityStage && excludesGovernment(`${lookup.requestText ?? ""} ${lookup.answerText ?? ""}`);
    const declaredFull = wantsNoGovernment && !declaredWithLanguage.some((f) => f.kind === "exclude_government" && isEnabled(f))
      ? [...declaredWithLanguage.filter((f) => f.kind !== "exclude_government"), { kind: "exclude_government" as const }]
      : declaredWithLanguage;
    // A CARD NEVER PROMISES A KIND OF ITEM THE SAMPLES DID NOT PROVE: the request counts videos (or images) and this stage lists the posts of a platform by a source whose own kind is not the media: the proof is a filter of the stage (mediaProof.ts), found by code
    const askedMedia = !isChild && parentKey === null && lookup.endpointCapability ? requestedMedia(requestWords) : null;
    const mediaStage = askedMedia !== null && !isMediaCapability(lookup.endpointCapability?.(endpointId), askedMedia) && (askedMedia === "video" ? /فيديو|ريل|مقطع|reel|video/i : /صور|image|photo/i).test(`${title.text} ${requestWords.slice(0, 400)}`) && (stagesIn.filter((x) => isRecord(x) && (x.parent_key === null || x.parent_key === undefined || x.parent_key === "")).length === 1 || (askedMedia === "video" ? /فيديو|ريل|مقطع/.test(title.text) : /صور/.test(title.text)));
    // the proof is in the MAPPED items (a video / reel field, a video address: the filter enforces it on every item) or the mapping itself kept only the items the measured page proves (its code dropped the rest): both are proof; neither is refused with the guidance
    let mediaKeepsOnlyProven = false;
    if (mediaStage && !fields.mediaFields[askedMedia!].some((k) => keySaysMedia(askedMedia!, k))) {
      const pages = measuredBy.map((id) => lookup.evidenceText(id));
      const raw = rawMediaProof(askedMedia!, pages);
      const mappedCount = (yieldRows ?? samples.filter(isRecord)).length;
      mediaKeepsOnlyProven = raw.proven > 0 && mappedCount > 0 && mappedCount <= raw.proven;
    }
    const declaredMedia = mediaStage && !mediaKeepsOnlyProven && !declaredFull.some((f) => f.kind === "media" && isEnabled(f))
      ? [...declaredFull.filter((f) => f.kind !== "media"), { kind: "media" as const, media: askedMedia! }]
      : declaredFull;
    const resolvedAll = resolveFilters(declaredMedia, fields, label);
    issues.push(...resolvedAll.issues);
    const resolvedBase = { ...resolvedAll, filters: isChild ? resolvedAll.filters.filter((f) => !CHILD_RAW_FILTER_KINDS.includes(f.kind)) : resolvedAll.filters };
    // PLACE AND COUNTRY ARE ENFORCED: a place filter reads evidence from the mapped fields (country, city, address, website domain, phone prefix); an entity stage whose request names a place gets the filter from the request itself, and with no field that can carry
    // the evidence the plan is refused (the card must never promise a place no code can check)
    const askedPlaces = entityStage ? placesInText(requestWords) : [];
    const placeFilters = resolvedBase.filters.filter((f) => f.kind === "place" && isEnabled(f));
    let filtersOut = resolvedBase.filters;
    if (askedPlaces.length > 0 || placeFilters.length > 0) {
      const named = askedPlaces.length > 0 ? askedPlaces : placeFilters.flatMap((f) => placesInText((f.values ?? []).join(" ")));
      const keys = [...new Set(named.map((e) => e.key))].filter((k) => placeEntry(k));
      if (keys.length > 0) {
        if (fields.placeFields.length === 0) issues.push(`${label}: the card promises items in ${placeLabelsAr(named).join(", ")}, so every item must carry evidence of it from a mapped field (country, city, address, website domain or phone number); the mapping gives none. Map such a field in your run_code on every row, or finish with cannot_serve if the source has none`);
        else {
          const existing = filtersOut.find((f) => f.kind === "place");
          const placeFilter: StageFilter = { ...(existing ?? { kind: "place" as const }), kind: "place", field: existing?.field ?? fields.place ?? fields.placeFields[0], fields: fields.placeFields, places: keys, values: askedPlaces.length > 0 ? placeLabelsAr(named) : existing?.values ?? placeLabelsAr(named) };
          delete placeFilter.enabled;
          filtersOut = [...filtersOut.filter((f) => f.kind !== "place"), placeFilter];
        }
      }
    }
    const resolved = { ...resolvedBase, filters: filtersOut };
    // THE PRICE RESTS ON THE ITEMS THAT PASS THE PLACE TOO: the place the card promises takes its share of the measured page away (a source that lists companies of every country), and the cost per DELIVERED item rises with it
    const pricedFilters = resolved.filters.filter((f) => isEnabled(f) && (f.kind === "place" || f.kind === "media"));
    if (relevance && yieldRows && yieldRows.length > 0 && pricedFilters.length > 0) {
      const textKey = textKeyOf({ relevance, columns: cleanColumns, filters: pricedFilters }, Object.keys(yieldRows[0] ?? {}));
      const passing = yieldRows.filter((r) => filterVerdict(pricedFilters, r, { textKey, now: 0 }) === null);
      if (passing.length === 0) {
        const mediaF = pricedFilters.find((f) => f.kind === "media");
        const placeOnly = pricedFilters.filter((f) => f.kind === "place");
        // THE SAMPLE PROVES NO VIDEO (live: the card promised videos from a post search whose sampled posts carried none that the mapping could show): said before the card, so the customer is never asked to approve what no sample showed
        if (mediaF && placeOnly.length === 0) issues.push(`${label}: the card promises ${mediaF.media === "image" ? "images" : "videos"} but none of the ${yieldRows.length} items of your measured page proves one (no mapped ${mediaF.media === "image" ? "image or photo" : "video or reel"} field holds a value, no address is a ${mediaF.media === "image" ? "photo" : "video"} address, no type says so). Do NOT promise it. Sample a source whose items ARE ${mediaF.media === "image" ? "images" : "videos"} (a video search, a page's reels, a post's detail), another query, or ask the customer (ask_question) whether posts without ${mediaF.media === "image" ? "an image" : "a video"} are fine; if the catalog has no source that can prove it, finish with cannot_serve and say so`);
        else issues.push(`${label}: none of the ${yieldRows.length} items of your measured page carries evidence of ${placeOnly.flatMap((f) => f.values ?? []).join("، ")}${mediaF ? " together with the media the card promises" : ""} in a mapped field; map the country, city, address, website or phone field of every item, or sample a source that gives one`);
      }
      const after = classifyRows(relevance, passing).counts;
      sampleMatching = after.match;
      yieldShare = Math.min(1, Math.max(0.02, (after.match + 0.5 * after.review) / yieldRows.length));
      reviewShare = after.review / yieldRows.length;
    }

    priced.push({
      key, title_ar: title.text, endpoint_id: endpointId, expected_rows: rowsHere, parent_key: parentKey,
      ...(parentKey !== null ? { per_parent_rows: perHere } : {}),
      ...(roleOf ? { role_preference: { role: roleOf.key } } : {}),
      deliver: raw.deliver === true, columns: cleanColumns, sample_rows: samples.filter(isRecord).slice(0, MAX_SAMPLE_ROWS_PER_STAGE),
      measured_by: measuredBy, ...(how ? { how_ar: how.text } : {}),
      planned_rows: rowsHere, measured_cost_per_row_usd: costPerRow ?? 0, measured_from_calls: measuredBy,
      ...(measuredMsRows > 0 ? { measured_ms_per_row: Math.round(measuredMs / measuredMsRows) } : {}),
      ...(relevance ? { relevance, yield_share: yieldShare, review_share: reviewShare, sample_examined: sampleExamined, sample_matching: sampleMatching, ...(typeof raw.yield_from === "string" && raw.yield_from ? { yield_from: raw.yield_from } : {}) } : {}),
      ...(resolved.filters.length ? { filters: resolved.filters } : {}),
    });
  }

  if (!priced.some((s) => s.deliver)) issues.push("at least one stage must be delivered (deliver: true)");
  // A STEP THE CUSTOMER ASKED FOR THAT THE PLAN DOES NOT HAVE is never dropped silently («ومن كل شركة اتنين من المديرين» with a plan of companies only): the plan carries it as a stage, or says which step it leaves out and why, and the card shows that
  // BEFORE the customer approves. A per-parent number whose noun is the noun of a top-level stage is a split of that stage's total («١٠ تغريدات لكل لاعب»), not a step of its own.
  const topTitles = priced.filter((s) => s.parent_key === null).map((s) => s.title_ar);
  const stepAsks = perParentAsks.filter((q) => !topTitles.some((t) => ownTitleWords(t).some((w) => sameNounStem(w, q.noun!))));
  const missingAsks = unservedPerParentAsks(stepAsks, priced.filter((s) => s.parent_key !== null).map((s) => s.title_ar));
  const unserved: UnservedStep[] = [];
  if (missingAsks.length > 0) {
    const given = Array.isArray(input.unserved_steps) ? input.unserved_steps : [];
    const parentNoun = itemNounOf(topTitles[0] ?? "").singular;
    missingAsks.forEach((q, i) => {
      const what = `${q.noun} لكل ${parentNoun}`;
      const g = isRecord(given[i]) ? given[i] : null;
      const reason = g && g.reason_ar !== undefined ? checkCustomerText(g.reason_ar, { maxChars: 200 }) : null;
      // A STEP THE CATALOG CAN SERVE IS NOT «UNSERVED»: the model's «no source gives it» is accepted only after it really tried the sources the catalog has for that step and none gave rows (live: the managers of a company were declared unserved
      // while four people sources take a company's website)
      const serving = lookup.childStepSources?.(q.noun!) ?? [];
      if (reason && serving.length > 0) {
        const called = lookup.endpointsCalled?.() ?? new Map<string, { rows: number }>();
        const tried = serving.filter((s) => called.has(s.id));
        const works = tried.some((s) => (called.get(s.id)?.rows ?? 0) > 0);
        if (works || tried.length < Math.min(2, serving.length)) {
          issues.push(`the step «${what}» CAN be served: the catalog has ${serving.slice(0, 4).map((s) => `${s.id} (takes the company's ${s.accepts.join(" / ")})`).join(", ")}. Sample one of them with a company of your first sample (its website, link or name as that source's input), add the stage (parent_key = the companies' stage, per_parent_rows ${q.value}) and drop unserved_steps for it. If the companies' source gives none of those fields, choose a companies source that gives the website. unserved_steps for this step is accepted only after at least two of these sources were really tried and gave no rows`);
          return;
        }
      }
      if (!reason) issues.push(`the customer asked for a step the plan does not have: «${what}» (${q.value} per ${parentNoun}). Add a stage for it (parent_key = the stage of the ${parentNoun}, per_parent_rows ${q.value}) after sampling a source that gives it, or, when no source can, pass unserved_steps: [{reason_ar}] (one Arabic sentence, no number, saying honestly why this step is not in the plan; one entry per missing step, in the request's order). The customer is shown the missing step BEFORE approving; it is never dropped silently${serving.length ? `. The catalog HAS sources for this step: ${serving.slice(0, 4).map((x) => x.id).join(", ")}; sample one with a company of your first sample and add the stage` : ""}`);
      else if (reason.issues.length || /[0-9٠-٩]/.test(reason.text)) issues.push(`unserved_steps[${i}].reason_ar: ${[...reason.issues, ...(/[0-9٠-٩]/.test(reason.text) ? ["no number in the reason"] : [])].join("; ")}`);
      else unserved.push({ what_ar: what, reason_ar: reason.text });
    });
  }
  // the customer asked for work e-mails or phones: the plan needs a contact stage (a contact source, or a column of verified contact values), or one honest sentence saying why it cannot
  const notes: string[] = [];
  const wants = requestWantsContacts(lookup.requestText);
  if ((wants.email || wants.phone) && lookup.isContactSource) {
    const hasContactStage = priced.some((s) => lookup.isContactSource!(s.endpoint_id) || s.columns.some((c) => c.kind !== undefined));
    const note = input.contacts_note_ar === undefined ? null : checkCustomerText(input.contacts_note_ar, { maxChars: 300 });
    if (note && note.issues.length) issues.push(`contacts_note_ar: ${note.issues.join("; ")}`);
    else if (!hasContactStage && !note) issues.push(`the customer asked for ${wants.email ? "work e-mails" : ""}${wants.email && wants.phone ? " and " : ""}${wants.phone ? "phones" : ""}: add a CONTACT STAGE per person or company (a contact source of the catalog or the page parsers; mark its e-mail / phone columns with kind "work_email" / "phone"), sample it, and deliver verified values only; if no source can give them, pass contacts_note_ar (ONE Arabic sentence saying honestly why they are not in the plan)`);
    else if (note && !hasContactStage) notes.push(note.text);
  }
  // what the agent assumed (plain Arabic, one line each); the intended meaning of a subject-based stage is always the first line
  const assumptions: string[] = [];
  if (input.assumptions_ar !== undefined) {
    if (!Array.isArray(input.assumptions_ar) || input.assumptions_ar.length > MAX_ASSUMPTIONS) issues.push(`assumptions_ar: at most ${MAX_ASSUMPTIONS} short Arabic lines`);
    else for (const a of input.assumptions_ar) { const c = checkCustomerText(a, { maxChars: 160 }); if (c.issues.length) issues.push(`assumptions_ar: ${c.issues.join("; ")}`); else assumptions.push(c.text); }
  }
  for (const st of priced) if (st.relevance && !assumptions.some((a) => a.includes(st.relevance!.subject_ar))) assumptions.unshift(`المقصود: ${st.relevance.subject_ar}.`);
  // the other meanings of the name that the plan excludes by rule (a namesake, a title) are said on the card, one line per stage
  for (const st of priced) {
    const others = (st.relevance?.competing_meanings ?? []).map((c) => c.meaning_ar);
    if (others.length > 0) assumptions.push(`لا يُحتسب ما يخص: ${others.join("، ")}.`.slice(0, 160));
  }

  // THE CARD DOES NOT PROMISE WHAT NO CODE CHECKS, AND STATES ONE NUMBER: a sentence of the model that promises replies out, a language, a period, an account or a place needs the filter that enforces it; a count it states is the plan's target
  const sentences = [{ where: "summary_ar", text: summary.text }, ...priced.filter((st) => st.how_ar).map((st) => ({ where: `stage «${st.key}» how_ar`, text: st.how_ar! })), ...assumptions.map((a) => ({ where: "assumptions_ar", text: a }))];
  issues.push(...promiseIssues(sentences, priced.map((st) => ({ key: st.key, filters: st.filters, hasRelevance: Boolean(st.relevance) }))));
  issues.push(...childPromiseIssues(sentences, priced.filter((st) => st.parent_key !== null).map((st) => st.title_ar)));
  const targets = new Set<number>(priced.flatMap((st) => [st.planned_rows, ...(st.per_parent_rows ? [st.per_parent_rows] : [])]));
  const titles = priced.map((st) => st.title_ar);
  for (const sentence of sentences) for (const q of countedQuantities(sentence.text, titles)) if (!targets.has(q.value)) issues.push(`${sentence.where}: it states the number ${q.value}, which is not a target of the plan (${[...targets].join(", ")}); the card states the counts itself: write the sentence without a count, or with the plan's own`);
  const delivered = priced.filter((s) => s.deliver).reduce((n, s) => n + s.planned_rows, 0);
  issues.push(...deliveryConsistencyIssues(priced, summary.text, requestedStages));
  if (delivered > AGENT_MAX_DELIVERED_ROWS) issues.push(`the delivered rows (${delivered}) are more than the limit of ${AGENT_MAX_DELIVERED_ROWS}; lower the expected rows`);
  if (issues.length) return { ok: false, issues };

  const price = priceMissionByCode(stagePriceInputs(priced), { settings: lookup.pricingSettings });
  if (price.overCap) return { ok: false, issues: [`the mission would hold ${price.reservePoints} points, more than the job limit; lower the expected rows`] };
  // THE TITLE OF A PEOPLE STAGE THAT ONLY RANKS BY ROLE does not promise the role (roles.ts); done last, so the checks above still read the noun the model wrote
  for (const st of priced) if (st.role_preference && st.parent_key !== null) st.title_ar = neutralPeopleTitleAr(st.title_ar, st.role_preference.role, itemNounOf(priced.find((p) => p.key === st.parent_key)?.title_ar ?? "").singular);
  return { ok: true, plan: { summary_ar: summary.text, stages: priced, price, ...(notes.length ? { notes_ar: notes } : {}), ...(assumptions.length ? { assumptions_ar: assumptions } : {}), ...(quantity ? { quantity } : {}), ...(unserved.length ? { unserved_steps: unserved } : {}) } };
}

/** The first sentence of a text: the customer card says what will be delivered in ONE sentence. */
export function firstSentenceAr(text: string): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!؟?])(?:\s|$)/.exec(t);
  return (m ? m[1] : t).trim();
}

const SAMPLE_CELL_CHARS = 120;
const CUSTOMER_SAMPLE_ROWS = 3;

/** The columns a customer may not switch off in the plan editor: the ones a check reads (the relevance text, the field of an enabled filter) and the contact columns, which are the point of a contact stage. */
export function lockedColumnKeys(stage: Pick<PricedStage, "columns" | "relevance" | "filters" | "title_ar">): Set<string> {
  const locked = new Set<string>(stage.relevance?.text_columns ?? []);
  // the text of a post or a comment is what two items are compared by (the same text twice is one item): it stays in the file
  if (isTextItemStage(stage)) { const t = textKeyOf(stage); if (t) locked.add(t); }
  for (const f of stage.filters ?? []) if (isEnabled(f) && f.field) locked.add(f.field);
  for (const c of stage.columns) if (c.kind !== undefined) locked.add(c.key);
  return locked;
}

/** What the plan editor of the card draws: the target of the stage the customer's quantity counts, the columns (on or off, locked ones marked) and the filters (their switch, language, period) of every stage. Nothing internal. */
export interface PlanEditorView {
  max_rows: number;
  target_stage_key: string | null;
  stages: Array<{
    key: string;
    title_ar: string;
    target: number;
    columns: Array<{ key: string; title_ar: string; on: boolean; locked: boolean }>;
    filters: Array<{ kind: StageFilter["kind"]; label_ar: string; enabled: boolean; line_ar: string; lang?: "ar" | "en"; days?: number }>;
  }>;
}

/** What the customer asked for, in all: the plan's target, plus what the model's lower target left out (only when it proposed fewer, with a reason). Equal to the target in every other plan. Messages say «N من هذا العدد»; the charge is settled against the TARGET. */
export const requestedRowsOf = (plan: Pick<PricedPlan, "stages" | "quantity">): number => plan.stages.filter((s) => s.deliver).reduce((n, s) => n + s.planned_rows, 0) + (plan.quantity ? Math.max(0, plan.quantity.requested - plan.quantity.target) : 0);

/** The stage the quantity counts (the one whose target the customer may change): the quantity's own, else the first delivered stage. */
export function targetStageKey(plan: Pick<PricedPlan, "stages" | "quantity">): string | null {
  return plan.quantity?.stage_key ?? plan.stages.find((s) => s.deliver)?.key ?? null;
}

export function planEditorView(plan: PricedPlan): PlanEditorView {
  return {
    max_rows: AGENT_MAX_DELIVERED_ROWS,
    target_stage_key: targetStageKey(plan),
    stages: plan.stages.map((s) => {
      const locked = lockedColumnKeys(s);
      return {
        key: s.key, title_ar: s.title_ar, target: s.planned_rows,
        columns: [...s.columns.filter((c) => !isInternalColumn(c)).map((c) => ({ key: c.key, title_ar: c.title_ar, on: true, locked: locked.has(c.key) })), ...(s.hidden_columns ?? []).map((c) => ({ key: c.key, title_ar: c.title_ar, on: false, locked: false }))],
        filters: (s.filters ?? []).map((f) => ({ kind: f.kind, label_ar: filterLabelAr(f), enabled: isEnabled(f), line_ar: filterLineAr({ ...f, enabled: true }), ...(f.lang ? { lang: f.lang } : {}), ...(f.days !== undefined ? { days: f.days } : {}) })),
      };
    }),
  };
}

const LANGUAGE_NAME_AR = { ar: "اللغة العربية فقط", en: "اللغة الإنجليزية فقط" } as const;
const withArticle = (word: string): string => (word.startsWith("ال") ? word : `ال${word}`);

/** The sentence about a step the customer asked for and the plan leaves out, built here from the step and the reason, shown on the card before approval. */
export const unservedStepLineAr = (u: UnservedStep): string => `لم تُضَف إلى الخطة خطوة «${u.what_ar}»: ${u.reason_ar.replace(/[.،\s]+$/, "")}. يمكنك اعتماد باقي الخطة كما هي، أو تعديل طلبك قبل الاعتماد.`;

/**
 * THE ASSUMPTION LINES OF THE CARD. The language and the topic are rules for choosing the PARENTS and the top-level items; the items of a child stage (comments, replies, reviews, employees) are delivered as the source gives them. So in a plan with a child stage a line
 * about the language is never stated for the whole plan: the model's own line about it is replaced by one built here that names the items it applies to («اللغة العربية فقط تُطبَّق على التغريدات وحدها، أما الردود فتُسلَّم كما هي»).
 */
export function assumptionLinesOf(plan: Pick<PricedPlan, "stages" | "assumptions_ar">): string[] {
  const filters = plan.stages.flatMap((s) => s.filters ?? []);
  const childOf = (s: { key: string }) => plan.stages.find((c) => c.parent_key === s.key && c.deliver) ?? plan.stages.find((c) => c.parent_key === s.key);
  if (!plan.stages.some((s) => s.parent_key !== null)) return assumptionLinesShown(plan.assumptions_ar ?? [], filters);
  const kept = (plan.assumptions_ar ?? []).filter((line) => !kindsPromisedBy(line).includes("language"));
  const base = assumptionLinesShown(kept, filters.filter((f) => f.kind !== "language"));
  const scoped: string[] = [];
  for (const s of plan.stages) {
    const language = (s.filters ?? []).find((f) => f.kind === "language" && isEnabled(f));
    if (!language) continue;
    const name = LANGUAGE_NAME_AR[language.lang === "en" ? "en" : "ar"];
    const child = childOf(s);
    scoped.push(child ? `${name} تُطبَّق على ${withArticle(itemNounOf(s.title_ar).plural)} وحدها، أما ${withArticle(itemNounOf(child.title_ar).plural)} فتُسلَّم كما هي.` : filterLineAr(language));
  }
  return [...base, ...scoped];
}

/** One line per delivered people stage that prefers a role: what is preferred and that fewer matching people may come (roles.ts). */
export function roleLinesAr(stages: ReadonlyArray<Pick<PricedStage, "key" | "title_ar" | "parent_key" | "deliver" | "role_preference">>): string[] {
  const lines: string[] = [];
  for (const s of stages) {
    if (!s.deliver || !s.role_preference || s.parent_key === null) continue;
    const parent = stages.find((p) => p.key === s.parent_key);
    lines.push(roleLineAr(s.role_preference.role, parent ? itemNounOf(parent.title_ar).singular : "عنصر"));
  }
  return [...new Set(lines)];
}

/** The filters whose verdict an example row can show: what the card promises about WHICH items (a period, a source, replies, reposts, a language). Place and government need evidence the example may not carry. */
const EXAMPLE_FILTER_KINDS: ReadonlyArray<StageFilter["kind"]> = ["period", "account", "exclude_replies", "exclude_reposts", "language"];

/**
 * THE EXAMPLES OF THE CARD OBEY THE CARD'S OWN FILTERS: an example row that the plan's enabled filters would leave out (a tweet from 2018 under «من اليوم فقط», a reply under «دون الردود», a video of another channel under «من القنوات التي سمّيتها») is
 * not shown; a filter whose field the example row does not carry cannot judge it and is skipped.
 */
export function sampleRowPasses(stage: Pick<PricedStage, "filters" | "parent_key" | "columns" | "relevance">, row: Record<string, unknown>, now: number): boolean {
  const active = (stage.filters ?? []).filter((f) => isEnabled(f) && EXAMPLE_FILTER_KINDS.includes(f.kind) && !(stage.parent_key !== null && CHILD_RAW_FILTER_KINDS.includes(f.kind)) && (f.field === undefined || row[f.field] !== undefined));
  return active.length === 0 || filterVerdict(active, row, { textKey: textKeyOf(stage, Object.keys(row)), now }) === null;
}

/** The part of a priced plan a customer (and the admin page's customer view) may read: Arabic titles, rows, links between stages, readable columns and sample rows, the price in points, the expected time. No endpoint, no USD, no internal id. */
export function customerPlanView(plan: PricedPlan, options: { now?: number } = {}) {
  const now = options.now ?? Date.now();
  // what the card promises about the items is backed by the filters that are switched ON: a line of the model that promises one is shown only while its filter is on, and a filter that is on gets its own sentence, built by code
  const assumptions = assumptionLinesOf(plan);
  // fewer than the customer asked for: the reason the card shows next to the one target number
  const notes = [...(plan.notes_ar ?? []), ...(plan.quantity?.reason_ar ? [plan.quantity.reason_ar] : []), ...childRuleLinesAr(plan.stages), ...roleLinesAr(plan.stages), ...platformCostNotesAr(plan.stages), ...plan.stages.filter((s) => (s.unresolved_sources ?? []).length > 0 && (s.filters ?? []).some((f) => f.kind === "account" && isEnabled(f))).map((s) => unresolvedSourcesLineAr(s.unresolved_sources!)), ...(plan.stages.some((s) => (s.approx_dates ?? []).length > 0) ? [APPROX_DATES_CARD_LINE_AR] : [])];
  return {
    summary_ar: firstSentenceAr(plan.summary_ar),
    ...(notes.length ? { notes_ar: notes } : {}),
    ...(assumptions.length ? { assumptions_ar: assumptions } : {}),
    ...(plan.quantity ? { quantity: { requested: plan.quantity.requested, target: plan.quantity.target, stage_key: plan.quantity.stage_key } } : {}),
    ...(plan.unserved_steps && plan.unserved_steps.length > 0 ? { unserved_ar: plan.unserved_steps.map(unservedStepLineAr) } : {}),
    stages: plan.stages.map((s) => {
      const columns = s.columns.filter((c) => !isInternalColumn(c));
      return {
        key: s.key, title_ar: childCardTitleAr(s, plan.stages), expected_rows: s.planned_rows, parent_key: s.parent_key, deliver: s.deliver, columns,
        sample_rows: s.sample_rows.filter((r) => sampleRowPasses(s, r, now)).slice(0, CUSTOMER_SAMPLE_ROWS).map((r) => Object.fromEntries(columns.map((c) => [c.key, String(r[c.key] ?? "").slice(0, SAMPLE_CELL_CHARS)]))),
        ...(s.how_ar ? { how_ar: s.how_ar } : {}),
        // the share of the sampled items the plan expected to match (a ratio, no money): the live tracker uses it to judge how much must be read before the target is reached
        ...(typeof s.yield_share === "number" ? { yield_share: Math.round(s.yield_share * 1000) / 1000 } : {}),
      };
    }),
    price: { unit_price_points: plan.price.unitPricePoints, reserve_points: plan.price.reservePoints, max_charge_points: plan.price.maxChargePoints, delivered_rows: plan.price.deliveredRows, ...(plan.price.rule === 2 ? { min_charge_points: plan.price.minChargePoints ?? 0, minimum_line_ar: minimumLineAr(plan.price.settings) } : {}) },
    expected_minutes: estimateMissionMinutes(plan.stages.map((s) => ({ rows: s.planned_rows, msPerRow: s.measured_ms_per_row ?? null }))),
    edit: planEditorView(plan),
  };
}
