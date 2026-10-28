import { AGENT_MAX_DELIVERED_ROWS, MAX_COLUMNS_PER_STAGE, MAX_PLAN_STAGES, MAX_SAMPLE_ROWS_PER_STAGE } from "./constants";
import { CONTACT_KINDS, requestWantsContacts, type ContactKind } from "./contacts";
import { estimateMissionMinutes, measuredCostPerRowUsd, priceMissionByCode, type MissionPriceResult } from "./price";
import { classifyRows, searchQueryOf, validateRelevanceSpec, type RelevanceSpec } from "./relevance";
import { minimumLineAr, type MissionPricingSettings } from "../missionPricing";
import { checkCustomerLabel, checkCustomerText } from "./text";
import { FIELD_LABEL_AR, uncoveredFields, usefulFieldsOfPage, type SourceField } from "./fields";

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
  /** May this endpoint be sold to this account (sellable, not blocked, data policy)? */
  endpointAllowed(endpointId: string): boolean;
  /** The customer's own words: when they ask for work e-mails or phones the plan must have a contact stage (or say honestly why not). */
  requestText?: string;
  /** Is this source one whose rows are contacts (a b2b_contact endpoint, the e-mail / phone parser)? */
  isContactSource?(endpointId: string): boolean;
  /** The markup and the minimum charge in force (the admin's settings); the defaults when absent. */
  pricingSettings?: MissionPricingSettings;
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

  for (let i = 0; i < stagesIn.length; i += 1) {
    const raw = stagesIn[i];
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
    if (parentKey !== null) {
      if (!planned.has(parentKey)) issues.push(`${label}: parent «${parentKey}» must be an EARLIER stage`);
      const per = Number(raw.per_parent_rows);
      if (!Number.isInteger(per) || per < 1) issues.push(`${label}: a stage with a parent needs per_parent_rows (a whole number, at least 1)`);
      else if (planned.has(parentKey)) {
        const ceiling = planned.get(parentKey)! * per;
        if (rowsHere > ceiling) issues.push(`${label}: expected_rows ${rowsHere} is more than its parent can give (${planned.get(parentKey)} parent rows x ${per} = ${ceiling}); lower it`);
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

    // RELEVANCE: a stage whose rows were FOUND by a text search must say what «matching» means, and the share of the sample that matches is computed here, by code, from the rows the agent cites
    let relevance: RelevanceSpec | undefined;
    let yieldShare = 1;
    let reviewShare = 0;
    let sampleExamined = 0;
    let sampleMatching = 0;
    if (raw.relevance !== undefined && raw.relevance !== null) {
      const checkedRel = validateRelevanceSpec(raw.relevance, cleanColumns.map((c) => c.key));
      if (!checkedRel.ok) issues.push(...checkedRel.issues.map((m) => `${label}: ${m}`));
      else {
        relevance = checkedRel.spec;
        const yieldId = String(raw.yield_from ?? "");
        const yieldText = yieldId ? lookup.evidenceText(yieldId) : null;
        let sampleRows: Array<Record<string, unknown>> | null = null;
        if (yieldText) { try { const parsed = JSON.parse(yieldText) as unknown; if (Array.isArray(parsed) && parsed.every(isRecord)) sampleRows = parsed as Array<Record<string, unknown>>; } catch { sampleRows = null; } }
        if (!sampleRows || sampleRows.length < 1) issues.push(`${label}: yield_from must be the id of a run_code output (out_0001 ...) that holds an ARRAY of ALL the rows of the page you measured, mapped to this stage's columns (so the code can count how many match; never only the best rows)`);
        else {
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
    } else if (foundBySearch && raw.deliver === true) {
      issues.push(`${label}: its rows were found by a text search, so it needs \`relevance\` (subject_ar, terms, context_terms, exclude_terms, text_columns) and \`yield_from\`: code keeps only the rows that are ABOUT what the customer asked and charges only for those`);
    }

    priced.push({
      key, title_ar: title.text, endpoint_id: endpointId, expected_rows: rowsHere, parent_key: parentKey,
      ...(parentKey !== null ? { per_parent_rows: Number(raw.per_parent_rows) } : {}),
      deliver: raw.deliver === true, columns: cleanColumns, sample_rows: samples.filter(isRecord).slice(0, MAX_SAMPLE_ROWS_PER_STAGE),
      measured_by: measuredBy, ...(how ? { how_ar: how.text } : {}),
      planned_rows: rowsHere, measured_cost_per_row_usd: costPerRow ?? 0, measured_from_calls: measuredBy,
      ...(measuredMsRows > 0 ? { measured_ms_per_row: Math.round(measuredMs / measuredMsRows) } : {}),
      ...(relevance ? { relevance, yield_share: yieldShare, review_share: reviewShare, sample_examined: sampleExamined, sample_matching: sampleMatching } : {}),
    });
  }

  if (!priced.some((s) => s.deliver)) issues.push("at least one stage must be delivered (deliver: true)");
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
  const delivered = priced.filter((s) => s.deliver).reduce((n, s) => n + s.planned_rows, 0);
  if (delivered > AGENT_MAX_DELIVERED_ROWS) issues.push(`the delivered rows (${delivered}) are more than the limit of ${AGENT_MAX_DELIVERED_ROWS}; lower the expected rows`);
  if (issues.length) return { ok: false, issues };

  const price = priceMissionByCode(stagePriceInputs(priced), { settings: lookup.pricingSettings });
  if (price.overCap) return { ok: false, issues: [`the mission would hold ${price.reservePoints} points, more than the job limit; lower the expected rows`] };
  return { ok: true, plan: { summary_ar: summary.text, stages: priced, price, ...(notes.length ? { notes_ar: notes } : {}), ...(assumptions.length ? { assumptions_ar: assumptions } : {}) } };
}

/** The first sentence of a text: the customer card says what will be delivered in ONE sentence. */
export function firstSentenceAr(text: string): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!؟?])(?:\s|$)/.exec(t);
  return (m ? m[1] : t).trim();
}

const SAMPLE_CELL_CHARS = 120;
const CUSTOMER_SAMPLE_ROWS = 3;

/** The part of a priced plan a customer (and the admin page's customer view) may read: Arabic titles, rows, links between stages, readable columns and sample rows, the price in points, the expected time. No endpoint, no USD, no internal id. */
export function customerPlanView(plan: PricedPlan) {
  return {
    summary_ar: firstSentenceAr(plan.summary_ar),
    ...(plan.notes_ar?.length ? { notes_ar: plan.notes_ar } : {}),
    ...(plan.assumptions_ar?.length ? { assumptions_ar: plan.assumptions_ar } : {}),
    stages: plan.stages.map((s) => {
      const columns = s.columns.filter((c) => !isInternalColumn(c));
      return {
        key: s.key, title_ar: s.title_ar, expected_rows: s.planned_rows, parent_key: s.parent_key, deliver: s.deliver, columns,
        sample_rows: s.sample_rows.slice(0, CUSTOMER_SAMPLE_ROWS).map((r) => Object.fromEntries(columns.map((c) => [c.key, String(r[c.key] ?? "").slice(0, SAMPLE_CELL_CHARS)]))),
        ...(s.how_ar ? { how_ar: s.how_ar } : {}),
        // the share of the sampled items the plan expected to match (a ratio, no money): the live tracker uses it to judge how much must be read before the target is reached
        ...(typeof s.yield_share === "number" ? { yield_share: Math.round(s.yield_share * 1000) / 1000 } : {}),
      };
    }),
    price: { unit_price_points: plan.price.unitPricePoints, reserve_points: plan.price.reservePoints, max_charge_points: plan.price.maxChargePoints, delivered_rows: plan.price.deliveredRows, ...(plan.price.rule === 2 ? { min_charge_points: plan.price.minChargePoints ?? 0, minimum_line_ar: minimumLineAr(plan.price.settings) } : {}) },
    expected_minutes: estimateMissionMinutes(plan.stages.map((s) => ({ rows: s.planned_rows, msPerRow: s.measured_ms_per_row ?? null }))),
  };
}
