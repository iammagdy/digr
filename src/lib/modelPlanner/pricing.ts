import { endpointCostUsd, type CatalogEndpoint, type TregCatalog, loadTregCatalog } from "../treg/catalog";
import { unitPricePointsFromCost } from "../recordPricing";
import { SAMPLE_ROWS_REQUESTED } from "./constants";

/**
 * The price of a model plan, by CODE ONLY: the provider's cost per DELIVERED record (USD) from the catalog and what was measured, converted by the ONE shared function
 * (`unitPricePointsFromCost`: cost x 5,500, fractional). The model never states a number: it proposes an endpoint, and the cost comes from the snapshot.
 *
 *  - A catalog unit that is a record (record, result, row, item, post, user, ad, review…) is already a price per record.
 *  - A catalog unit that is a call (call, page, step) is divided by the rows ONE call returns, MEASURED on a REAL sample call (or by a saved recipe's measured value, or by the
 *    values of the plan the customer was already shown when an edit re-prices it). NEVER from the catalog's own example: the snapshot trims every example to ONE list item, so
 *    the rows an example shows say nothing about the rows a call returns. With none of these the plan is not priced and no card is shown (the validator asks for a real sample).
 *  - A lookup of the SENSITIVE category answers one person per call: one row per call (nothing is sampled for it).
 *  - Rows that a filter drops are paid for but not delivered: the price is per DELIVERED record, so it is divided by the share of sample rows that pass the filters.
 *  - A routed endpoint's catalog price is a range (the call may be served by any sibling): the price is the HIGHEST sibling price unless a measured average exists.
 *  - Any other unit (a character, a verifier credit, an index unit…) cannot be turned into a price per record: the endpoint is not priceable and is not offered.
 */
export const PER_RECORD_UNITS: ReadonlySet<string> = new Set(["record", "result", "row", "item", "post", "user", "ad", "review", "employee", "quota_row", "target"]);
export const PER_CALL_UNITS: ReadonlySet<string> = new Set(["call", "page", "step"]);

export type CostBasis = "catalog" | "routed_worst_sibling" | "measured_average";

export interface CallCost { usd: number; unit: "record" | "call"; basis: CostBasis }

/** The cost of one catalog unit of an endpoint, and whether it is per record or per call. Null when the snapshot has no usable price or unit. */
export function unitCost(endpoint: CatalogEndpoint, catalog: TregCatalog = loadTregCatalog(), measuredAvgCallUsd?: number | null): CallCost | null {
  const unitName = String(endpoint.cost?.unit ?? "").toLowerCase();
  const kind: "record" | "call" | null = PER_RECORD_UNITS.has(unitName) ? "record" : PER_CALL_UNITS.has(unitName) ? "call" : null;
  if (!kind) return null;
  const own = endpointCostUsd(endpoint);
  if (endpoint.kind === "routed") {
    if (typeof measuredAvgCallUsd === "number" && measuredAvgCallUsd > 0) return { usd: measuredAvgCallUsd, unit: kind, basis: "measured_average" };
    const sibling = endpoint.siblings.map((id) => catalog.byId.get(id)).filter((e): e is CatalogEndpoint => Boolean(e)).map((e) => endpointCostUsd(e)).filter((v): v is number => typeof v === "number" && v > 0);
    const worst = Math.max(own ?? 0, ...sibling);
    return worst > 0 ? { usd: worst, unit: kind, basis: "routed_worst_sibling" } : null;
  }
  return own !== null && own > 0 ? { usd: own, unit: kind, basis: "catalog" } : null;
}

export interface StepMeasure {
  /** Rows one call returned (measured on a real sample, a recipe, or the approved plan being edited; 1 for a per-record catalog unit and a lookup). */
  rowsPerCall: number;
  /** The share of those rows that pass the plan's filters, 0 to 1. */
  passRate: number;
  source: "sample" | "recipe" | "catalog_unit" | "approved_plan" | "lookup" | "assumed_one_per_call";
}

export interface StepPrice {
  costPerCallUsd: number;
  costPerRecordUsd: number;
  rowsPerCall: number;
  passRate: number;
  basis: CostBasis;
  measuredFrom: StepMeasure["source"];
  /** Whether the catalog prices this step per record or per call. */
  unit: "record" | "call";
}

/** A sample that passed 0 rows of N is not a price: the caller refuses the plan (a half-row prior would make the price absurd). */
export function priceStep(cost: CallCost, measure: StepMeasure): StepPrice {
  const rows = Math.max(1, measure.rowsPerCall);
  const pass = Math.min(1, Math.max(0.01, measure.passRate));
  const costPerCall = cost.unit === "call" ? cost.usd : cost.usd * rows;
  const costPerRecord = (cost.unit === "call" ? cost.usd / rows : cost.usd) / pass;
  return { costPerCallUsd: costPerCall, costPerRecordUsd: costPerRecord, rowsPerCall: rows, passRate: pass, basis: cost.basis, measuredFrom: measure.source, unit: cost.unit };
}

/** What a call may cost for the job's budget check: the call price, or the price of the page a per-record endpoint is asked for. */
export function callEstimateUsd(cost: CallCost, pageRows: number = SAMPLE_ROWS_REQUESTED): number {
  return cost.unit === "call" ? cost.usd : cost.usd * Math.max(1, pageRows);
}

export interface PlanPrice {
  /** Provider cost of one DELIVERED record of the whole plan, USD. */
  costPerRecordUsd: number;
  /** The shared unit price in points (fractional, six decimals). */
  unitPricePoints: number;
  steps: StepPrice[];
}

/**
 * One step: its own price. Two steps (a listing step and a step run once per listed item): per delivered record, the listing's share is its cost per listed item
 * divided by the records each listed item delivers, added to the second step's own price.
 */
export function pricePlan(steps: StepPrice[], childRecordsPerItem?: number): PlanPrice {
  if (steps.length === 0) throw new Error("a plan has at least one step");
  let costPerRecord = steps[steps.length - 1].costPerRecordUsd;
  if (steps.length === 2) {
    const listing = steps[0];
    const perItem = Math.max(1, childRecordsPerItem ?? steps[1].rowsPerCall * steps[1].passRate);
    const costPerListedItem = listing.costPerCallUsd / Math.max(1, listing.rowsPerCall * listing.passRate);
    costPerRecord += costPerListedItem / perItem;
  }
  return { costPerRecordUsd: costPerRecord, unitPricePoints: unitPricePointsFromCost(costPerRecord), steps };
}

export interface MissionStageInput {
  price: StepPrice;
  /** The rows this stage should deliver (or, for a stage that is not delivered, the rows the next stages need from it). */
  volume: number;
  /** The earlier stage (0-based index) this stage runs once per row of; null for a root. */
  parent: number | null;
  /** Rows taken from each parent's call (the first page), when set. */
  perItem?: number;
  /** Whether the rows of this stage go into the customer's files (and so count in the charge). */
  deliver: boolean;
}

export interface MissionPrice extends PlanPrice {
  /** The rows each stage will really collect: a stage run once per parent row never collects more than its parents can give. */
  effectiveVolumes: number[];
  /** Calls each stage needs. */
  calls: number[];
  /** Provider cost of the whole mission at the effective volumes, USD. */
  totalCostUsd: number;
  /** The rows the customer is charged for at most (the delivered stages together). */
  deliveredVolume: number;
}

/**
 * The price of a MISSION of up to four stages, by code: the sum of what each stage costs for the rows it collects, spread over the rows the customer receives.
 * A root stage collects its own volume page by page; a stage run once per parent row takes the first page of each parent's call (at most `perItem` rows, never more than a call
 * returns), so it never collects more than (its parents' rows x rows per parent). The unit price is the cost per DELIVERED row of the whole mission, converted by the shared function.
 */
export function priceMission(stages: MissionStageInput[]): MissionPrice {
  if (stages.length === 0) throw new Error("a mission has at least one stage");
  const perParent = stages.map((s) => rowsPerParentOf(s));
  const effective: number[] = [];
  // top down: a stage run once per parent row never collects more than (its parent's rows x rows per parent)
  const topDown = (resetRoots: boolean) => stages.forEach((s, i) => { if (s.parent !== null) effective[i] = Math.max(1, Math.min(Math.floor(s.volume), Math.floor(effective[s.parent] * perParent[i]))); else if (resetRoots) effective[i] = Math.max(1, Math.floor(s.volume)); });
  topDown(true);
  // bottom up: a stage whose rows are NOT delivered only feeds the next ones, so it collects no more than they need (the customer is never charged for a longer list than the next stage uses)
  for (let i = stages.length - 1; i >= 0; i -= 1) {
    const kids = stages.map((k, j) => (k.parent === i ? j : -1)).filter((j) => j >= 0);
    if (!stages[i].deliver && kids.length > 0) effective[i] = Math.max(1, Math.min(effective[i], Math.max(...kids.map((j) => Math.ceil(effective[j] / perParent[j])))));
  }
  topDown(false);
  const calls: number[] = [];
  let total = 0;
  stages.forEach((s, i) => {
    const rowsPerCall = stages[i].parent === null ? Math.max(1, s.price.rowsPerCall * s.price.passRate) : perParent[i];
    calls.push(Math.ceil(effective[i] / rowsPerCall));
    // a per-record price is paid for the rows collected (and the share the filters drop); a per-call price for the calls made
    total += s.price.unit === "record" ? effective[i] * s.price.costPerRecordUsd : calls[i] * s.price.costPerCallUsd;
  });
  const deliveredVolume = Math.max(1, stages.reduce((n, s, i) => n + (s.deliver ? effective[i] : 0), 0));
  const costPerRecord = total / deliveredVolume;
  return { costPerRecordUsd: costPerRecord, unitPricePoints: unitPricePointsFromCost(costPerRecord), steps: stages.map((s) => s.price), effectiveVolumes: effective, calls, totalCostUsd: total, deliveredVolume };
}

/** Rows one parent row gives its stage: a per-call endpoint returns at most what a call returns (the measured rows), a per-record one exactly what is asked (`perItem`, else one). 0 for a root: it pages by itself. */
export function rowsPerParentOf(s: Pick<MissionStageInput, "price" | "parent" | "perItem">): number {
  if (s.parent === null) return Math.max(1, s.price.rowsPerCall * s.price.passRate);
  if (s.price.unit === "record") return Math.max(1, Math.floor(s.perItem ?? 1));
  return Math.max(1, Math.min(s.perItem ?? Number.POSITIVE_INFINITY, s.price.rowsPerCall * s.price.passRate));
}
