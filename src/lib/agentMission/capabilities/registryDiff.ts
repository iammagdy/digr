import { levelRank } from "./evidence";
import type { ArtifactEntry, RegistryArtifact } from "./artifact";

/**
 * PHASE 3, REGISTRY CHANGE SAFETY (task 3.5; audit §7.3). Compares two registry artifacts (the committed one and a newly generated one) and classifies every change, so a catalog or provider update is REVIEWED before it can matter:
 *   added / removed            a capability appeared or disappeared;
 *   price                      its USD figure or its pricing basis changed;
 *   breaking_input             a required input was added, or an input class it takes was lost;
 *   breaking_output            an output class was lost, or its record fields became unknown, or its schema fingerprint changed;
 *   deprecated                 it became deprecated or broken;
 *   policy                     its data-policy category or privacy changed;
 *   level                      its verification level changed (up or down).
 * Rules (code, not a model):
 *   - a change on a capability that WAS production-eligible is `review_required`: it needs explicit, reviewed evidence before it ships;
 *   - a NEW capability is never production-eligible on arrival (it can only become so by being added to the reviewed list in a PR);
 *   - a capability that became broken or deprecated is flagged so the router stops selecting it, however cheap.
 * Pure; never throws.
 */
export type ChangeKind = "added" | "removed" | "price" | "breaking_input" | "breaking_output" | "deprecated" | "policy" | "level";

export interface RegistryChange {
  key: string;
  kind: ChangeKind;
  detail: string;
  /** The capability was production-eligible before: the change needs reviewed evidence. */
  reviewRequired: boolean;
}

export interface RegistryDiff {
  changes: RegistryChange[];
  /** True when nothing changed. */
  identical: boolean;
  /** Violations of the rules above (a PR with any of them must not merge). */
  violations: string[];
}

const lost = <T,>(before: ReadonlyArray<T>, after: ReadonlyArray<T>): T[] => before.filter((x) => !after.includes(x));

export function diffRegistries(before: RegistryArtifact, after: RegistryArtifact): RegistryDiff {
  const a = new Map(before.capabilities.map((c) => [c.key, c] as const));
  const b = new Map(after.capabilities.map((c) => [c.key, c] as const));
  const changes: RegistryChange[] = [];
  const violations: string[] = [];
  const wasEligible = (c: ArtifactEntry | undefined) => c?.verification.level === "production_eligible";
  for (const [key, n] of b) {
    const o = a.get(key);
    if (!o) {
      changes.push({ key, kind: "added", detail: `${n.operation} (${n.verification.level})`, reviewRequired: false });
      if (n.verification.level === "production_eligible") violations.push(`${key}: a new capability is production-eligible on arrival`);
      continue;
    }
    const review = wasEligible(o);
    const push = (kind: ChangeKind, detail: string) => changes.push({ key, kind, detail, reviewRequired: review });
    if (o.pricing.usd !== n.pricing.usd || o.pricing.basis !== n.pricing.basis || o.pricing.unit !== n.pricing.unit) push("price", `${o.pricing.usd ?? "?"} ${o.pricing.basis}/${o.pricing.unit} → ${n.pricing.usd ?? "?"} ${n.pricing.basis}/${n.pricing.unit}`);
    const newRequired = lost(n.inputs_required, o.inputs_required);
    const lostTakes = lost(o.takes, n.takes);
    if (newRequired.length > 0 || lostTakes.length > 0) push("breaking_input", [newRequired.length ? `new required: ${newRequired.join(",")}` : "", lostTakes.length ? `no longer takes: ${lostTakes.join(",")}` : ""].filter(Boolean).join("; "));
    const lostOutputs = lost(o.outputs, n.outputs);
    if (lostOutputs.length > 0 || (o.outputs_known && !n.outputs_known)) push("breaking_output", [lostOutputs.length ? `lost outputs: ${lostOutputs.join(",")}` : "", o.outputs_known && !n.outputs_known ? "record fields became unknown" : ""].filter(Boolean).join("; "));
    else if (o.schema_fingerprint !== n.schema_fingerprint) push("breaking_output", "schema fingerprint changed (inputs, fields, list or cursor path)");
    if ((n.verification.level === "deprecated" || n.verification.level === "broken") && o.verification.level !== n.verification.level) push("deprecated", `${o.verification.level} → ${n.verification.level}`);
    else if (o.verification.level !== n.verification.level) push("level", `${o.verification.level} → ${n.verification.level}`);
    if (o.policy !== n.policy || o.privacy !== n.privacy) push("policy", `${o.policy}/${o.privacy} → ${n.policy}/${n.privacy}`);
    // a production-eligible capability that keeps its level while its schema broke: the evidence no longer covers it
    if (review && n.verification.level === "production_eligible" && changes.some((c) => c.key === key && (c.kind === "breaking_input" || c.kind === "breaking_output" || c.kind === "policy"))) violations.push(`${key}: production-eligible after a breaking or policy change; re-verify before it ships`);
    if (o.verification.level !== "production_eligible" && n.verification.level === "production_eligible" && levelRank(o.verification.level) < levelRank("fixture_verified")) violations.push(`${key}: promoted to production-eligible without fixture or live evidence`);
  }
  for (const [key, o] of a) if (!b.has(key)) changes.push({ key, kind: "removed", detail: `${o.operation} (${o.verification.level})`, reviewRequired: wasEligible(o) });
  changes.sort((x, y) => x.key.localeCompare(y.key) || x.kind.localeCompare(y.kind));
  return { changes, identical: changes.length === 0, violations };
}

/** Whether the router may select a capability at this level (broken and deprecated never, whatever their price). */
export const selectableLevel = (level: ArtifactEntry["verification"]["level"]): boolean => levelRank(level) >= 0;
