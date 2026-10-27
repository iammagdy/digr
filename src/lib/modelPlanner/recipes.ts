import { createHash } from "node:crypto";
import type { StoredModelPlan } from "./types";

/**
 * RECIPES: after a model-planned job delivers at least one row, its plan is saved as a recipe (the endpoint, the parameter TEMPLATE with each value's provenance, the field map,
 * the filters' kinds and fields, and what was measured: rows per call and the share of rows that passed), so the next similar request can skip the sample call.
 *
 *  - NO customer value is stored: a value that came from the customer's words is a slot («from: customer_text»); a literal choice (a sort order) is kept; a prior-step value is a slot.
 *  - The table is `recipes` (docs/proposals/agent-loop/01_recipes.sql, NOT APPLIED). The code works without it: no saving, the sample call every time, and it starts saving once the table exists.
 *  - A recipe is saved as `draft` (unreviewed). It carries a measurement, not a price: the price is always computed from the catalog cost and the shared pricing function.
 */
export const RECIPES_TABLE = "recipes";

export interface RecipeRecord {
  slug: string;
  endpointIds: string[];
  /** Fields known to exist in the endpoint's rows (the columns and filters of the saved field map). */
  knownFields: string[];
  measured: Array<{ rowsPerCall: number; passRate: number }>;
  /** The saved steps, so the planner can show the model what worked last time. */
  steps: unknown;
}

const structureOf = (plan: StoredModelPlan) => plan.steps.map((s) => ({
  endpointId: s.endpointId,
  params: s.params.map((p) => ({ name: p.name, source: p.source })),
  columns: s.fieldMap.columns.map((c) => [c.field, c.role ?? "", c.transform ?? ""]),
  filters: s.filters.map((f) => [f.kind, f.field]),
}));

export function recipeSlug(plan: StoredModelPlan): string {
  const base = plan.steps.map((s) => s.endpointId.replace(/[^a-z0-9]+/gi, "-").toLowerCase()).join("--").replace(/^-+|-+$/g, "").slice(0, 44);
  const hash = createHash("sha256").update(JSON.stringify(structureOf(plan))).digest("hex").slice(0, 8);
  return `auto-${base}-${hash}`.slice(0, 63).replace(/-+$/g, "");
}

/** The templates of a plan's steps: the customer's values removed. */
export function recipeStepsOf(plan: StoredModelPlan): unknown {
  return plan.steps.map((s) => ({
    endpointId: s.endpointId,
    perItem: s.perItem ?? null,
    params: Object.fromEntries(s.params.map((p) => [p.name, p.source === "literal" ? { from: "literal", value: p.value } : p.source === "prior_step" ? { from: "prior_step", field: p.fromStep?.field } : { from: "customer_text" }])),
    fieldMap: { rowsPath: s.fieldMap.rowsPath ?? null, columns: s.fieldMap.columns, pagination: s.fieldMap.pagination },
    // the filters keep their kind and field; the customer's account and the stated period are slots
    filters: s.filters.map((f) => ({ kind: f.kind, field: f.field, ...(f.kind === "date_window" ? { format: f.format ?? null } : {}) })),
  }));
}

export interface RecipeRow {
  slug: string;
  version: number;
  status: "draft" | "reviewed";
  endpoint_id: string;
  params_template: Record<string, unknown>;
  field_map: Record<string, unknown>;
  price_basis: Record<string, unknown>;
  fixture_refs: unknown[];
  catalog_snapshot_sha256: string | null;
  created_by: string;
}

export function recipeRowFromPlan(plan: StoredModelPlan, info: { deliveredUnits: number; jobId: string; snapshotSha256?: string | null }): RecipeRow {
  return {
    slug: recipeSlug(plan),
    version: 1,
    status: "draft",
    endpoint_id: plan.steps[0].endpointId,
    params_template: { steps: (recipeStepsOf(plan) as Array<{ params: unknown }>).map((s) => s.params) },
    // the WHOLE mission: every stage (its endpoint, parameter templates, field map, filters), how the stages are chained (parent, delivered or not, rows per parent) and their names
    field_map: { steps: recipeStepsOf(plan), topic: Boolean(plan.topic), ...(plan.stages ? { stages: plan.stages.map((s) => ({ parent: s.parent, deliver: s.deliver, perParent: s.perParent, titleAr: s.titleAr })) } : {}) },
    price_basis: { measured: plan.measured, firstJobDeliveredUnits: info.deliveredUnits, firstJobId: info.jobId, note: "a measurement, not a price: the price is computed from the catalog cost by the shared function" },
    fixture_refs: [],
    catalog_snapshot_sha256: info.snapshotSha256 ?? null,
    created_by: "agent",
  };
}

/** Saves the recipe of a job that delivered rows. Returns whether a row was written; false when the table is not there or the recipe already exists. Never throws. */
export async function saveRecipeAfterDelivery(client: any, plan: StoredModelPlan | undefined, info: { deliveredUnits: number; jobId: string }): Promise<boolean> {
  if (!plan || plan.v !== 1 || !Array.isArray(plan.steps) || plan.steps.length === 0 || info.deliveredUnits < 1 || typeof client?.from !== "function") return false;
  try {
    const row = recipeRowFromPlan(plan, { ...info, snapshotSha256: null }); // the worker never reads the catalog snapshot (10 MB): no hash is stored
    const existing = await client.from(RECIPES_TABLE).select("slug").eq("slug", row.slug).eq("version", 1).maybeSingle();
    if (existing?.error) return false; // the table is not applied yet
    if (existing?.data) return false; // this recipe is already saved
    const { error } = await client.from(RECIPES_TABLE).insert(row);
    return !error;
  } catch { return false; }
}

/** The saved recipe whose first endpoint is this one (the newest draft or reviewed one), or null. Never throws. */
export async function loadRecipeForEndpoint(client: any, endpointId: string): Promise<RecipeRecord | null> {
  if (typeof client?.from !== "function") return null;
  try {
    const { data, error } = await client.from(RECIPES_TABLE).select("slug,endpoint_id,field_map,price_basis,status").eq("endpoint_id", endpointId).in("status", ["draft", "reviewed"]).order("created_at", { ascending: false }).limit(1);
    if (error || !Array.isArray(data) || data.length === 0) return null;
    const row = data[0];
    const steps = (row.field_map?.steps ?? []) as Array<{ endpointId: string; fieldMap?: { columns?: Array<{ field: string }> }; filters?: Array<{ field: string }> }>;
    return {
      slug: String(row.slug),
      endpointIds: steps.map((s) => s.endpointId),
      knownFields: [...new Set(steps.flatMap((s) => [...(s.fieldMap?.columns ?? []).map((c) => c.field), ...(s.filters ?? []).map((f) => f.field)]))],
      measured: Array.isArray(row.price_basis?.measured) ? row.price_basis.measured.map((m: any) => ({ rowsPerCall: Number(m.rowsPerCall) || 1, passRate: Number(m.passRate) || 1 })) : [],
      steps,
    };
  } catch { return null; }
}

/** What the recipe measured for the step that runs this endpoint (the recipe's own step order, not the new plan's): rows per call and the share that passed. */
export function recipeMeasureFor(recipe: RecipeRecord, endpointId: string, fallbackIndex: number): { rowsPerCall: number; passRate: number } | undefined {
  const at = recipe.endpointIds.indexOf(endpointId);
  return recipe.measured[at >= 0 ? at : Math.min(fallbackIndex, Math.max(0, recipe.measured.length - 1))];
}
