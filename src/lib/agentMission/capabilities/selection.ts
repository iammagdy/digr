import type { TregCatalog } from "../../treg/catalog";
import { isPrivateCapabilityString, type Operation, type OutputClass, type InputClass } from "./registry";
import { DISCOVERY_VERSION, type CapabilityDiscovery } from "./discover";
import { linkOf } from "./need";

/**
 * THE BACKEND DECIDES (docs/UNIFIED-CAPABILITY-DISCOVERY.md).
 *   - `validateCapabilityChoice`: a capability a model (or anything else) recommends for a stage is accepted only when it is one of that stage's VALIDATED candidates. An id that is not a candidate, a private-data capability, or an
 *     unknown stage is refused, with a reason code.
 *   - `planStageIssues`: the stages of a proposed plan read only validated candidates; a stage reading anything else (an endpoint the discovery did not validate, a private-data endpoint, another platform) is refused before the plan exists.
 *   - `capabilitySelectionOf`: the record PERSISTED with the plan when it is shown with its price: every stage key with the exact capability it executes, its operation, its parent and how it is fed; the limitations said to the customer;
 *     and a digest of that scope.
 *   - `verifyApprovedScope`: at execution, the STORED approved plan is compared with its record: a stage added, or a stage that now reads another capability than the one validated and approved, stops the execution before any provider
 *     call (the hold is released whole by the existing settlement). Removing a stage before approval (a customer's edit) is allowed: it reduces the scope.
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

/** The discovery stage a plan stage's endpoint is a validated candidate of (preferring the stage of the same parent relation), or null. */
function bindStage(d: CapabilityDiscovery, endpointId: string, hasParent: boolean): CapabilityDiscovery["stages"][number] | null {
  const matching = d.stages.filter((s) => s.eligible.some((e) => e.id === endpointId));
  return matching.find((s) => (s.stage.parentKey !== null) === hasParent) ?? matching[0] ?? null;
}

export interface PlanStageLike { key: string; endpoint_id: string; parent_key?: string | null }

export function planStageIssues(stages: ReadonlyArray<PlanStageLike>, d: CapabilityDiscovery, catalog: TregCatalog): string[] {
  const issues: string[] = [];
  for (const st of stages) {
    const id = String(st?.endpoint_id ?? "");
    if (isPrivateCapabilityString(catalog.byId.get(id)?.capability)) { issues.push(`stage ${st.key}: ${id} returns private personal data; it can never be planned`); continue; }
    if (!bindStage(d, id, Boolean(st.parent_key))) issues.push(`stage ${st.key}: ${id} is not one of the validated capabilities for this request; use only the ids listed under VALIDATED CAPABILITIES (code validated their inputs, outputs, availability and price)`);
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
}

/** A small deterministic hash (FNV-1a, 32 bits) of a string: enough to see that the stored scope changed; not a security boundary (the plan is written by the service role only). */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
const scopeText = (stages: ReadonlyArray<Pick<CapabilitySelectionStage, "stage_key" | "capability_id" | "parent_key">>): string => JSON.stringify([...stages].map((s) => [s.stage_key, s.capability_id, s.parent_key ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

export interface PlanLike { stages: ReadonlyArray<PlanStageLike>; replies_off?: PlanStageLike | null; capability_selection?: CapabilitySelection }

/** The record kept with the plan (see the header). Every stage of the plan (and the replies stage kept aside when the customer switched replies off) is in it. */
export function capabilitySelectionOf(plan: PlanLike, d: CapabilityDiscovery): CapabilitySelection {
  const all = [...plan.stages, ...(plan.replies_off ? [plan.replies_off] : [])];
  const boundOf = new Map(all.map((st) => { const bound = bindStage(d, st.endpoint_id, Boolean(st.parent_key)); return [st.key, { bound, cand: bound?.eligible.find((e) => e.id === st.endpoint_id) ?? null }] as const; }));
  const stages: CapabilitySelectionStage[] = all.map((st) => {
    const { bound, cand } = boundOf.get(st.key)!;
    // how THIS stage is fed by the plan's OWN parent stage (the fields that parent's capability gives and this one takes)
    const parent = st.parent_key ? boundOf.get(st.parent_key)?.cand ?? null : null;
    const link = cand && parent && bound ? linkOf(parent.outputs, cand.takes.filter((t) => bound.stage.accepts.includes(t))) : null;
    return { stage_key: st.key, capability_id: st.endpoint_id, operation: bound?.stage.operation ?? null, parent_key: st.parent_key ?? null, link, source: bound ? "discovery" : "code", rank: cand?.rank ?? null };
  });
  return { v: DISCOVERY_VERSION, status: d.status, stages, limitations: [...new Set(d.limitations.filter((l) => l.textAr).map((l) => `${l.code}${l.filter ? `:${l.filter}` : ""}`))], digest: fnv(scopeText(stages)) };
}

export type ScopeVerdict = { ok: true; checked: boolean } | { ok: false; issues: string[] };

/** The stored approved plan still executes exactly the validated capabilities of its record. A plan with no record (made with the switch off) is not checked. */
export function verifyApprovedScope(plan: PlanLike, catalog?: TregCatalog): ScopeVerdict {
  const rec = plan.capability_selection;
  if (!rec) return { ok: true, checked: false };
  const issues: string[] = [];
  if (rec.v !== DISCOVERY_VERSION || !Array.isArray(rec.stages)) return { ok: false, issues: ["selection_record_unreadable"] };
  if (fnv(scopeText(rec.stages)) !== rec.digest) issues.push("selection_record_altered");
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
