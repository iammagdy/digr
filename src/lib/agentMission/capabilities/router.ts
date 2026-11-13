import { levelRank, type MeasuredCalls, type VerificationLevel } from "./evidence";
import type { RankedCandidate, StageDiscovery } from "./discover";
import type { StageNeed } from "./need";
import type { Capability, Operation } from "./registry";

/**
 * PHASE 4, THE INTELLIGENT TOOL ROUTER (docs/intelligence/PHASES-2-4-BASELINE.md; audit §8). Trusted code chooses, for every stage, the most suitable VERIFIED capability; the model may only pick among what this returns, and never prices or
 * authorizes. Used by discovery (`discoverCapabilities`) only when `options.routing` is given, i.e. when the `registry_router` switch is on; without it discovery is exactly what it was.
 *
 * HARD FILTERS (any failure excludes the candidate, with its reason recorded):
 *   1–2. public data, privacy and the account's authorization; 4–5. the right operation and platform, an input the stage can be fed with; 8. the provider's key and daily cap (all already enforced by discovery's `hardReject`);
 *   3.   VERIFICATION: the registry level is at least the account's minimum (production accounts: production_eligible; test accounts: fixture_verified, audit §8.2), never broken or deprecated;
 *   6.   OUTPUTS: documented for every field the stage requires, or (for a stage with no dependent stage) provable on a sample; a stage that FEEDS a dependent stage must already document its outputs (task 3.3);
 *   9.   COST: a known price (not «unknown») within the safe per-call bound when one is given;
 *   10.  RUNTIME HEALTH: a source whose recent calls failed for configuration or validation reasons (`sourceHealth` «skipped») is excluded.
 *   7.   (constraints are a RANK and an honest limitation, never a reason to drop the only source: discovery states what the chosen source cannot enforce.)
 * RANK, lexicographic (no invented weights; a criterion with no evidence on one side is not used to separate):
 *   1. complete coverage of the requested constraints, then how many it covers;  2. verification evidence;  3. feeds the dependent stages;  4. reaches the requested volume;  (useful optional fields);
 *   5. Diger-measured usable yield (rows per call, only with at least MIN_MEASURED_ATTEMPTS calls);  6. cost per usable row (measured when measured, else the catalog's);  7. measured latency;  8. the id.
 * A cheaper candidate can therefore win only when coverage, evidence, chaining and volume are equal. Pure; never throws.
 */
export const MIN_MEASURED_ATTEMPTS = 3;

export type RouterReject = "below_verification" | "broken_or_deprecated" | "outputs_unproven_for_dependent" | "price_unknown" | "over_call_bound" | "runtime_unhealthy";

export interface RoutingFacts {
  /** The registry level of a capability (by id and operation); a capability with no record is «advertised». */
  levelOf: (id: string, operation: Operation) => VerificationLevel;
  /** Diger's own measured calls of an endpoint (the reliability snapshot), or null. */
  measuredOf: (id: string) => MeasuredCalls | null;
  /** The runtime health of a source (`sourceRanking.sourceHealth`): «skipped» excludes it, «demoted» ranks it after healthy ones. */
  healthOf?: (id: string) => "ok" | "demoted" | "skipped";
  /** The lowest level this account may use. */
  minLevel: VerificationLevel;
  /** The most one call may cost (USD), when the execution budget sets one. */
  maxUsdPerCall?: number;
}

export interface RoutedFields {
  level: VerificationLevel;
  /** Rows per call measured by Diger (null: fewer than MIN_MEASURED_ATTEMPTS calls). */
  measuredYield: number | null;
  /** USD per usable row: measured when measured, else the catalog's per-row price. */
  usdPerUsableRow: number | null;
  latencyMs: number | null;
  health: "ok" | "demoted" | "skipped";
  completeCoverage: boolean;
}

export function routedFieldsOf(c: Capability, facts: RoutingFacts, wantedFilters: number, covered: number): RoutedFields {
  const m = facts.measuredOf(c.id);
  const measured = m && m.attempts >= MIN_MEASURED_ATTEMPTS ? m : null;
  const measuredYield = measured ? Number((measured.rows / measured.attempts).toFixed(4)) : null;
  const usdPerUsableRow = measured && measured.rows > 0 && measured.costUsd > 0 ? measured.costUsd / measured.rows : c.usdPerRow;
  return { level: facts.levelOf(c.id, c.operation), measuredYield, usdPerUsableRow, latencyMs: measured?.p50Ms ?? null, health: facts.healthOf?.(c.id) ?? "ok", completeCoverage: covered >= wantedFilters };
}

/** The router's own hard filters (after discovery's): null when the candidate may be used. */
export function routerReject(c: Capability, stage: StageNeed, hasDependents: boolean, facts: RoutingFacts, routed: RoutedFields): RouterReject | null {
  if (routed.level === "broken" || routed.level === "deprecated") return "broken_or_deprecated";
  if (levelRank(routed.level) < levelRank(facts.minLevel)) return "below_verification";
  // a stage whose rows feed another stage must PROVE the fields the child is fed with before it is planned (a leaf stage may prove its own on a sample)
  if (hasDependents && !(c.outputsKnown && stage.requires.every((r) => c.outputs.includes(r)))) return "outputs_unproven_for_dependent";
  if (c.pricing.basis === "unknown" || c.usdPerRow === null) return "price_unknown";
  if (typeof facts.maxUsdPerCall === "number" && typeof c.pricing.usd === "number" && c.pricing.usd > facts.maxUsdPerCall) return "over_call_bound";
  if (routed.health === "skipped") return "runtime_unhealthy";
  return null;
}

type Routed = RankedCandidate & { routed?: RoutedFields };

/** The router's lexicographic order. */
export function routerCompare(a: Routed, b: Routed): number {
  const ra = a.routed!;
  const rb = b.routed!;
  const keys: Array<[number, number]> = [
    [Number(rb.completeCoverage), Number(ra.completeCoverage)],
    [b.filtersCovered.length, a.filtersCovered.length],
    [levelRank(rb.level), levelRank(ra.level)],
    [Number(rb.health === "ok"), Number(ra.health === "ok")],
    [Number(b.outputsVerified), Number(a.outputsVerified)],
    [Number(b.feedsChild), Number(a.feedsChild)],
    [Number(b.reachesVolume), Number(a.reachesVolume)],
    [b.preferredOutputs, a.preferredOutputs],
  ];
  for (const [x, y] of keys) if (x !== y) return x - y;
  // measured yield separates two candidates only when BOTH were measured (no invented score for the other)
  if (ra.measuredYield !== null && rb.measuredYield !== null && ra.measuredYield !== rb.measuredYield) return rb.measuredYield - ra.measuredYield;
  const pa = ra.usdPerUsableRow ?? Number.POSITIVE_INFINITY;
  const pb = rb.usdPerUsableRow ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  if (ra.latencyMs !== null && rb.latencyMs !== null && ra.latencyMs !== rb.latencyMs) return ra.latencyMs - rb.latencyMs;
  return a.id.localeCompare(b.id);
}

/**
 * SAFE ALTERNATIVES (task 4.2; audit §8.4). The next candidate of the SAME stage that may replace a failed one: it is validated for the stage (in its eligible list), at least as verified as the minimum, covers EVERY constraint the failed
 * one covered, reaches the volume when the failed one did, is fed by the same parent field, and fits the call bound. A REFUSAL (policy, authorization, daily cap, budget) is a limit, never worked around: no fallback.
 */
export type FailureKind = "timeout" | "provider_error" | "empty" | "schema_changed" | "refused_policy" | "refused_cap" | "refused_budget";

export function safeFallback(stage: StageDiscovery, failedId: string, failure: FailureKind, options: { maxUsdPerCall?: number; usdPerCallOf?: (id: string) => number | null; exclude?: ReadonlyArray<string> } = {}): { id: string | null; reason: string } {
  if (failure === "refused_policy" || failure === "refused_cap" || failure === "refused_budget") return { id: null, reason: "a refusal is a limit: no alternative is tried" };
  const failed = stage.eligible.find((e) => e.id === failedId);
  if (!failed) return { id: null, reason: "the failed capability was not validated for this stage" };
  const tried = new Set([failedId, ...(options.exclude ?? [])]);
  for (const e of stage.eligible) {
    if (tried.has(e.id)) continue;
    if (!failed.filtersCovered.every((f) => e.filtersCovered.includes(f))) continue;
    if (failed.reachesVolume && !e.reachesVolume) continue;
    if (!stage.stage.requires.every((r) => e.outputs.includes(r)) && failed.outputsVerified) continue;
    if (stage.link && !e.takes.includes(stage.link.to)) continue;
    const usd = options.usdPerCallOf?.(e.id) ?? null;
    if (typeof options.maxUsdPerCall === "number" && usd !== null && usd > options.maxUsdPerCall) continue;
    return { id: e.id, reason: `next validated candidate of ${stage.stage.key} that carries the same constraints` };
  }
  return { id: null, reason: "no validated alternative carries the same constraints within the bound: an honest partial delivery" };
}

/**
 * MULTI-STEP DEPENDENCIES (task 4.4). The parent → child operations the router accepts, and the check of every binding of a discovery: the child's selected capability must take a field the parent's selected capability DOCUMENTS, the
 * operations must be a known chain, and a parent whose outputs are unproven cannot feed a child (the child would run on an invented input).
 */
export const ALLOWED_PARENTS: Readonly<Record<Operation, ReadonlyArray<Operation | null>>> = {
  "social.parents": [null], "social.comments": ["social.parents"], "social.replies": ["social.comments"],
  "companies.discover": [null], "company.enrich": ["companies.discover"], "company.contacts": ["companies.discover", "company.enrich"], "people.discover": [null, "companies.discover"],
  "places.discover": [null], "places.reviews": ["places.discover"], "web.search": [null], "web.read": ["web.search"], "apps.discover": [null], "apps.reviews": ["apps.discover"],
};

export function chainBindingIssues(stages: ReadonlyArray<StageDiscovery>): string[] {
  const issues: string[] = [];
  for (const s of stages) {
    const parent = s.stage.parentKey ? stages.find((p) => p.stage.key === s.stage.parentKey) ?? null : null;
    if (!(ALLOWED_PARENTS[s.stage.operation] ?? []).includes(parent ? parent.stage.operation : null)) issues.push(`${s.stage.key}: ${s.stage.operation} cannot follow ${parent ? parent.stage.operation : "nothing"}`);
    if (!parent || !s.selected) continue;
    const p = parent.eligible.find((e) => e.id === parent.selected);
    const c = s.eligible.find((e) => e.id === s.selected);
    if (!p || !c) { issues.push(`${s.stage.key}: its parent ${parent.stage.key} has no selected capability`); continue; }
    if (!p.outputsVerified) issues.push(`${s.stage.key}: parent ${p.id} does not document the field that feeds it`);
    if (!s.link || !p.outputs.includes(s.link.from) || !c.takes.includes(s.link.to)) issues.push(`${s.stage.key}: ${c.id} is not fed by a documented field of ${p.id}`);
  }
  return issues;
}
