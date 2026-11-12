import type { TregCatalog } from "../../treg/catalog";
import { isPrivateCapabilityString, type Operation, type OutputClass, type InputClass } from "./registry";
import { DISCOVERY_VERSION, type CapabilityDiscovery } from "./discover";
import { linkOf } from "./need";

/**
 * THE BACKEND DECIDES (docs/UNIFIED-CAPABILITY-DISCOVERY.md).
 *   - `validateCapabilityChoice`: a capability a model (or anything else) recommends for a stage is accepted only when it is one of that stage's VALIDATED candidates. An id that is not a candidate, a private-data capability, or an
 *     unknown stage is refused, with a reason code.
 *   - `planStageIssues`: the stages of a proposed plan read only validated candidates OF THEIR OWN STAGE: a stage reading anything else (an endpoint the discovery did not validate, a private-data endpoint, another platform, or a
 *     capability validated for ANOTHER stage of the chain, e.g. a contact-page parser planned as the first stage) is refused before the plan exists.
 *   - `capabilitySelectionOf`: the record PERSISTED with the plan when it is shown with its price: every stage key with the exact capability it executes, its operation, its parent and how it is fed; the limitations said to the customer;
 *     and a digest of that scope.
 *   - `verifyApprovedScope`: at execution, the STORED approved plan is compared with its record: a stage added, a stage that now reads another capability than the one validated and approved, or any stored execution parameter changed
 *     (counts, filters, pins, pages, columns: `params_digest`) stops the execution before any provider call (the hold is released whole by the existing settlement). Only the customer's own edit before approval re-seals the parameters
 *     (`resealCapabilitySelection`, customerActions.ts); removing a stage before approval is allowed: it reduces the scope.
 * Pure; never throws.
 */
export type ChoiceRejection = "unknown_stage" | "not_a_candidate" | "private_data";

export function validateCapabilityChoice(d: CapabilityDiscovery, stageKey: string, capabilityId: string, catalog?: TregCatalog): { ok: true } | { ok: false; reason: ChoiceRejection } {
  if (catalog && isPrivateCapabilityString(catalog.byId.get(capabilityId)?.capability)) return { ok: false, reason: "private_data" };
  const stage = d.stages.find((s) => s.stage.key === stageKey);
  if (!stage) return { ok: false, reason: "unknown_stage" };
  if (!stage.eligible.some((e) => e.id === capabilityId)) return { ok: false, reason: "not_a_candidate" };
  return { ok: true };
}

export interface PlanStageLike { key: string; endpoint_id: string; parent_key?: string | null }

type DiscoveryStage = CapabilityDiscovery["stages"][number];

/**
 * THE STAGE A PLAN STAGE EXECUTES, bound strictly (review of PR #454): a plan stage binds to a discovery stage only when its capability is one of THAT stage's validated candidates AND it sits at that stage's place in the chain: a root plan
 * stage binds only to a root discovery stage, and a child plan stage only to a discovery stage whose parent is a stage its own plan parent is bound to. A capability validated for another stage (a contact-page parser planned as the
 * first stage, the employees source planned under the reviews) binds to nothing. The result maps each plan stage key to the discovery stages it can be (empty: none).
 */
function bindPlanStages(stages: ReadonlyArray<PlanStageLike>, d: CapabilityDiscovery): Map<string, DiscoveryStage[]> {
  const byKey = new Map(stages.map((st) => [String(st?.key ?? ""), st] as const));
  const out = new Map<string, DiscoveryStage[]>();
  const resolving = new Set<string>();
  const bind = (key: string): DiscoveryStage[] => {
    const known = out.get(key);
    if (known) return known;
    const st = byKey.get(key);
    if (!st || resolving.has(key)) return [];
    resolving.add(key);
    const id = String(st.endpoint_id ?? "");
    const holders = d.stages.filter((s) => s.eligible.some((e) => e.id === id));
    const parentKey = st.parent_key ? String(st.parent_key) : null;
    let bound: DiscoveryStage[];
    if (parentKey === null) bound = holders.filter((s) => s.stage.parentKey === null);
    else {
      const parentStages = new Set(bind(parentKey).map((p) => p.stage.key));
      bound = holders.filter((s) => s.stage.parentKey !== null && parentStages.has(s.stage.parentKey));
    }
    resolving.delete(key);
    out.set(key, bound);
    return bound;
  };
  for (const key of byKey.keys()) bind(key);
  return out;
}


export function planStageIssues(stages: ReadonlyArray<PlanStageLike>, d: CapabilityDiscovery, catalog: TregCatalog): string[] {
  const issues: string[] = [];
  const bound = bindPlanStages(stages, d);
  for (const st of stages) {
    const id = String(st?.endpoint_id ?? "");
    if (isPrivateCapabilityString(catalog.byId.get(id)?.capability)) { issues.push(`stage ${st.key}: ${id} returns private personal data; it can never be planned`); continue; }
    if ((bound.get(String(st.key)) ?? []).length > 0) continue;
    const holders = d.stages.filter((s) => s.eligible.some((e) => e.id === id)).map((s) => s.stage.key);
    if (holders.length === 0) issues.push(`stage ${st.key}: ${id} is not one of the validated capabilities for this request; use only the ids listed under VALIDATED CAPABILITIES (code validated their inputs, outputs, availability and price)`);
    else issues.push(`stage ${st.key}: ${id} is validated only for stage ${holders.join(" / ")} of VALIDATED CAPABILITIES, which is not this stage's place in the chain (${st.parent_key ? `child of ${st.parent_key}` : "a first stage"}); plan each id only at the stage it is listed under, with that stage's parent`);
  }
  return issues;
}

export interface CapabilitySelectionStage {
  /** The plan's stage key. */
  stage_key: string;
  capability_id: string;
  operation: Operation | null;
  parent_key: string | null;
  link: { from: OutputClass; to: InputClass } | null;
  /** «discovery»: a validated candidate of the discovery; «code»: added by code after validation (a replies stage the plan check adds, a compiled path card). */
  source: "discovery" | "code";
  rank: number | null;
}

export interface CapabilitySelection {
  v: typeof DISCOVERY_VERSION;
  status: CapabilityDiscovery["status"];
  stages: CapabilitySelectionStage[];
  /** The limitation codes said to the customer before approval. */
  limitations: string[];
  digest: string;
  /** A digest of every stored execution parameter of the plan's stages (and of the replies stage kept aside): the counts, filters, pins, pages and columns the price was computed on. Recomputed only by the customer's own edits before approval
   *  (`resealCapabilitySelection`); after approval nothing may change it. */
  params_digest: string;
}

/** A small deterministic hash (FNV-1a, 32 bits) of a string: enough to see that the stored scope changed; not a security boundary (the plan is written by the service role only). */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
const scopeText = (stages: ReadonlyArray<Pick<CapabilitySelectionStage, "stage_key" | "capability_id" | "parent_key">>): string => JSON.stringify([...stages].map((s) => [s.stage_key, s.capability_id, s.parent_key ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

/** A canonical JSON of a value: object keys sorted, undefined members left out, exactly as the stored jsonb gives it back (jsonb reorders keys and drops undefined), so a plan read back from the database digests the same as the plan written. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined || typeof v === "function" ? "null" : canonical(v))).join(",")}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec).sort().filter((k) => rec[k] !== undefined && typeof rec[k] !== "function").map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`).join(",")}}`;
}

export interface PlanLike { stages: ReadonlyArray<PlanStageLike>; replies_off?: PlanStageLike | null; capability_selection?: CapabilitySelection }

/** The digest of the plan's stored execution parameters (every field of every stage and of the replies stage kept aside). */
export function planParamsDigest(plan: PlanLike): string {
  return fnv(canonical({ stages: plan.stages, replies_off: plan.replies_off ?? null }));
}

/** The customer's own edit of a plan that is still waiting for approval (count, period, language, exclusions, columns, the smaller version) changes its parameters by code: the record follows them. The capabilities stay what they were. */
export function resealCapabilitySelection<P extends PlanLike>(plan: P): P {
  if (!plan.capability_selection) return plan;
  return { ...plan, capability_selection: { ...plan.capability_selection, params_digest: planParamsDigest(plan) } };
}

/** The record kept with the plan (see the header). Every stage of the plan (and the replies stage kept aside when the customer switched replies off) is in it. */
export function capabilitySelectionOf(plan: PlanLike, d: CapabilityDiscovery, options: { limitationsShown?: boolean } = {}): CapabilitySelection {
  const all = [...plan.stages, ...(plan.replies_off ? [plan.replies_off] : [])];
  const binding = bindPlanStages(all, d);
  const boundOf = new Map(all.map((st) => { const bound = binding.get(st.key)?.[0] ?? null; return [st.key, { bound, cand: bound?.eligible.find((e) => e.id === st.endpoint_id) ?? null }] as const; }));
  const stages: CapabilitySelectionStage[] = all.map((st) => {
    const { bound, cand } = boundOf.get(st.key)!;
    // how THIS stage is fed by the plan's OWN parent stage (the fields that parent's capability gives and this one takes)
    const parent = st.parent_key ? boundOf.get(st.parent_key)?.cand ?? null : null;
    const link = cand && parent && bound ? linkOf(parent.outputs, cand.takes.filter((t) => bound.stage.accepts.includes(t))) : null;
    return { stage_key: st.key, capability_id: st.endpoint_id, operation: bound?.stage.operation ?? null, parent_key: st.parent_key ?? null, link, source: bound ? "discovery" : "code", rank: cand?.rank ?? null };
  });
  // only the limitations the customer was actually told before approval are recorded as said (the compiled social path says its own)
  const limitations = options.limitationsShown === false ? [] : [...new Set(d.limitations.filter((l) => l.textAr).map((l) => `${l.code}${l.filter ? `:${l.filter}` : ""}`))];
  return { v: DISCOVERY_VERSION, status: d.status, stages, limitations, digest: fnv(scopeText(stages)), params_digest: planParamsDigest(plan) };
}

export type ScopeVerdict = { ok: true; checked: boolean } | { ok: false; issues: string[] };

/**
 * THE SERVER'S OWN MARK THAT A PLAN WAS MADE THROUGH CAPABILITY DISCOVERY (docs/LLM-FIRST-OBJECTIVES.md): written by the worker, create-only, in the mission's private folder when the plan with its record is shown (`required`, with the record's
 * digest), and again with no digest when a later planning of the same mission made a plan without a record. Neither the customer nor the site can write it. With it, a stored plan whose record was REMOVED, or REPLACED by another record,
 * is refused; without it (every plan made before discovery existed, or with the switch off) the plan is exactly as compatible as before.
 */
export interface ScopeAnchor { required: boolean; digest: string | null }
export const SCOPE_ANCHOR_FOLDER = "capability_scope";

/** The anchor written by the worker as a file body. */
export const scopeAnchorBody = (digest: string | null): string => JSON.stringify({ v: DISCOVERY_VERSION, digest });
/** The anchor read back from its file body (an unreadable body still REQUIRES a record: the server wrote it, so the plan was made through discovery). */
export function scopeAnchorOf(body: string | null): ScopeAnchor {
  if (body === null) return { required: false, digest: null };
  try {
    const o = JSON.parse(body) as { v?: unknown; digest?: unknown };
    if (o && o.v === DISCOVERY_VERSION && o.digest === null) return { required: false, digest: null };
    if (o && o.v === DISCOVERY_VERSION && typeof o.digest === "string" && /^[0-9a-f]{8}$/.test(o.digest)) return { required: true, digest: o.digest };
  } catch { /* unreadable */ }
  return { required: true, digest: null };
}

/** The stored approved plan still executes exactly the validated capabilities of its record. A plan with no record is not checked, UNLESS the server's anchor says it was made through capability discovery (then it is refused). */
export function verifyApprovedScope(plan: PlanLike, catalog?: TregCatalog, anchor: ScopeAnchor = { required: false, digest: null }): ScopeVerdict {
  const rec = plan.capability_selection;
  if (!rec) return anchor.required ? { ok: false, issues: ["selection_record_missing"] } : { ok: true, checked: false };
  if (anchor.required && anchor.digest !== null && rec.digest !== anchor.digest) return { ok: false, issues: ["selection_record_replaced"] };
  const issues: string[] = [];
  if (rec.v !== DISCOVERY_VERSION || !Array.isArray(rec.stages)) return { ok: false, issues: ["selection_record_unreadable"] };
  if (fnv(scopeText(rec.stages)) !== rec.digest) issues.push("selection_record_altered");
  if (typeof rec.params_digest !== "string" || rec.params_digest !== planParamsDigest(plan)) issues.push("approved_parameters_changed");
  const approved = new Map(rec.stages.map((s) => [s.stage_key, s]));
  for (const st of [...plan.stages, ...(plan.replies_off ? [plan.replies_off] : [])]) {
    const a = approved.get(st.key);
    if (!a) { issues.push(`stage_added:${st.key}`); continue; }
    if (a.capability_id !== st.endpoint_id) issues.push(`capability_changed:${st.key}`);
    if ((a.parent_key ?? null) !== (st.parent_key ?? null)) issues.push(`parent_changed:${st.key}`);
    if (catalog && isPrivateCapabilityString(catalog.byId.get(st.endpoint_id)?.capability)) issues.push(`private_data:${st.key}`);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, checked: true };
}
