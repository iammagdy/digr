import { AGENT_MAX_DELIVERED_ROWS, MAX_COLUMNS_PER_STAGE, MAX_PLAN_STAGES, MAX_SAMPLE_ROWS_PER_STAGE } from "./constants";
import { measuredCostPerRowUsd, priceMissionByCode, type MissionPriceResult } from "./price";
import { checkCustomerLabel, checkCustomerText } from "./text";

/**
 * A mission PLAN: stages (a stage runs once per row of its parent stage), the rows each is expected to give, sample rows the agent really saw, and the calls that MEASURED the cost.
 * The agent writes this through propose_plan. `validateAndPricePlan` checks it against what was recorded and prices it by code; the agent never supplies a price.
 */
export interface PlanColumn { key: string; title_ar: string }

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
}

export interface ProposedPlan {
  summary_ar: string;
  stages: ProposedStage[];
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
}

export interface PlanLookup {
  call(id: string): RecordedCall | null;
  /** Text of a saved page or code output (to prove a sample row's id and links were really seen). Null when the id is unknown. */
  evidenceText(id: string): string | null;
  /** May this endpoint be sold to this account (sellable, not blocked, data policy)? */
  endpointAllowed(endpointId: string): boolean;
}

export interface PricedStage extends ProposedStage {
  /** Rows the stage will collect at most (the agent's estimate, checked against its parent). */
  planned_rows: number;
  /** Measured cost per row of this stage, USD (internal). */
  measured_cost_per_row_usd: number;
  measured_from_calls: string[];
}

export interface PricedPlan {
  summary_ar: string;
  stages: PricedStage[];
  price: MissionPriceResult;
}

export type PlanCheck = { ok: true; plan: PricedPlan } | { ok: false; issues: string[] };

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
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
    const cleanColumns: PlanColumn[] = [];
    for (const c of columns) {
      if (!isRecord(c) || !KEY_RE.test(String(c.key ?? "")) || colKeys.has(String(c.key))) { issues.push(`${label}: every column needs a unique key (letters, digits, underscores)`); continue; }
      colKeys.add(String(c.key));
      const t = checkCustomerLabel(c.title_ar);
      if (t.issues.length) issues.push(`${label} column «${c.key}»: ${t.issues.join("; ")}`);
      cleanColumns.push({ key: String(c.key), title_ar: t.text });
    }

    const measuredBy = Array.isArray(raw.measured_by) ? raw.measured_by.map(String) : [];
    const measuredCalls: Array<{ costUsd: number; rows: number }> = [];
    let evidence = "";
    if (measuredBy.length === 0) issues.push(`${label}: measured_by must cite the calls that measured it (ids returned by treg_call)`);
    for (const id of measuredBy) {
      const call = lookup.call(id);
      const text = lookup.evidenceText(id);
      if (text) evidence += `\n${text}`;
      if (!call) { if (text === null) issues.push(`${label}: «${id}» is not a call or output of this mission`); continue; }
      if (call.endpointId !== endpointId) { issues.push(`${label}: call «${id}» measured another source than the stage uses`); continue; }
      if (!call.ok || call.rows <= 0) { issues.push(`${label}: call «${id}» returned no rows; it cannot measure the cost`); continue; }
      measuredCalls.push({ costUsd: call.costUsd, rows: call.rows });
    }
    const costPerRow = measuredCostPerRowUsd(measuredCalls);
    if (measuredCalls.length === 0 || costPerRow === null) issues.push(`${label}: no measured call with rows and a recorded charge`);
    else if (!(costPerRow > 0)) issues.push(`${label}: the measured charge is zero, so no price can be built on it; measure with a call that was charged`);

    const samples = Array.isArray(raw.sample_rows) ? raw.sample_rows : [];
    if (samples.length < 1 || samples.length > MAX_SAMPLE_ROWS_PER_STAGE) issues.push(`${label}: 1 to ${MAX_SAMPLE_ROWS_PER_STAGE} sample_rows, rows you really saw`);
    for (const s of samples) {
      if (!isRecord(s)) { issues.push(`${label}: a sample row must be an object`); continue; }
      if (evidence) issues.push(...sampleRowIssues(s, evidence, key));
    }

    priced.push({
      key, title_ar: title.text, endpoint_id: endpointId, expected_rows: rowsHere, parent_key: parentKey,
      ...(parentKey !== null ? { per_parent_rows: Number(raw.per_parent_rows) } : {}),
      deliver: raw.deliver === true, columns: cleanColumns, sample_rows: samples.filter(isRecord).slice(0, MAX_SAMPLE_ROWS_PER_STAGE),
      measured_by: measuredBy, ...(how ? { how_ar: how.text } : {}),
      planned_rows: rowsHere, measured_cost_per_row_usd: costPerRow ?? 0, measured_from_calls: measuredBy,
    });
  }

  if (!priced.some((s) => s.deliver)) issues.push("at least one stage must be delivered (deliver: true)");
  const delivered = priced.filter((s) => s.deliver).reduce((n, s) => n + s.planned_rows, 0);
  if (delivered > AGENT_MAX_DELIVERED_ROWS) issues.push(`the delivered rows (${delivered}) are more than the limit of ${AGENT_MAX_DELIVERED_ROWS}; lower the expected rows`);
  if (issues.length) return { ok: false, issues };

  const price = priceMissionByCode(priced.map((s) => ({ rows: s.planned_rows, costPerRowUsd: s.measured_cost_per_row_usd, deliver: s.deliver })));
  if (price.overCap) return { ok: false, issues: [`the mission would hold ${price.reservePoints} points, more than the job limit; lower the expected rows`] };
  return { ok: true, plan: { summary_ar: summary.text, stages: priced, price } };
}

/** The part of a priced plan a customer (and the admin page's customer view) may read: Arabic titles, rows, links between stages, sample rows, the price in points. No endpoint, no USD. */
export function customerPlanView(plan: PricedPlan) {
  return {
    summary_ar: plan.summary_ar,
    stages: plan.stages.map((s) => ({ key: s.key, title_ar: s.title_ar, expected_rows: s.planned_rows, parent_key: s.parent_key, deliver: s.deliver, columns: s.columns, sample_rows: s.sample_rows, ...(s.how_ar ? { how_ar: s.how_ar } : {}) })),
    price: { unit_price_points: plan.price.unitPricePoints, reserve_points: plan.price.reservePoints, max_charge_points: plan.price.maxChargePoints, delivered_rows: plan.price.deliveredRows },
  };
}
