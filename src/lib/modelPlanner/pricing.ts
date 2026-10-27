import { endpointCostUsd, type CatalogEndpoint, type TregCatalog, loadTregCatalog } from "../treg/catalog";
import { unitPricePointsFromCost } from "../recordPricing";
import { SAMPLE_ROWS_REQUESTED } from "./constants";

/**
 * The price of a model plan, by CODE ONLY: the provider's cost per DELIVERED record (USD) from the catalog and what was measured, converted by the ONE shared function
 * (`unitPricePointsFromCost`: cost x 5,500, fractional). The model never states a number: it proposes an endpoint, and the cost comes from the snapshot.
 *
 *  - A catalog unit that is a record (record, result, row, item, post, user, ad, review…) is already a price per record.
 *  - A catalog unit that is a call (call, page, step) is divided by the rows ONE call returns, MEASURED on the sample (or by the recipe's measured value, or, only when neither
 *    exists, by the rows the catalog's own example shows). With none of these the price assumes ONE row per call: the worst case.
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
  /** Rows one call returned (measured on the sample, a recipe, or counted in the catalog's example). */
  rowsPerCall: number;
  /** The share of those rows that pass the plan's filters, 0 to 1. */
  passRate: number;
  source: "sample" | "recipe" | "catalog_example" | "assumed";
}

export interface StepPrice {
  costPerCallUsd: number;
  costPerRecordUsd: number;
  rowsPerCall: number;
  passRate: number;
  basis: CostBasis;
  measuredFrom: StepMeasure["source"];
}

/** A sample that passed 0 rows of N is not a price: the caller refuses the plan (a half-row prior would make the price absurd). */
export function priceStep(cost: CallCost, measure: StepMeasure): StepPrice {
  const rows = Math.max(1, measure.rowsPerCall);
  const pass = Math.min(1, Math.max(0.01, measure.passRate));
  const costPerCall = cost.unit === "call" ? cost.usd : cost.usd * rows;
  const costPerRecord = (cost.unit === "call" ? cost.usd / rows : cost.usd) / pass;
  return { costPerCallUsd: costPerCall, costPerRecordUsd: costPerRecord, rowsPerCall: rows, passRate: pass, basis: cost.basis, measuredFrom: measure.source };
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
