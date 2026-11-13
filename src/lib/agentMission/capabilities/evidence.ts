import type { Capability, PricingBasis } from "./registry";

/**
 * PHASE 3, THE EVIDENCE OF A CAPABILITY (docs/intelligence/PHASES-2-4-BASELINE.md; audit §7.2). What Diger can PROVE a capability does, kept apart from what a provider advertises. Pure: the facts come in as data (the generator
 * `scripts/capabilities/build-registry.ts` reads them from the repository's own files); nothing here reads a file, the network or a clock.
 *
 * The levels, lowest to highest (a capability is at the highest one whose rule it meets; `broken` and `deprecated` override everything):
 *   advertised          the catalog or the provider's documentation lists it; nothing more is known;
 *   schema_checked      its record fields are DOCUMENTED (not a wrapper, not a sub-list): code can check a stage's required fields against them;
 *   fixture_verified    a hand ToolCard maps a STORED REAL provider page of it with no issue (`toolCards/verify.ts` `checkCardOnPage`), so the fields are proven on real data;
 *   live_verified       Diger's own recorded calls (`mission_calls`, aggregated in `data/capabilities/reliability-snapshot.json`) returned rows at least LIVE_MIN_CALLS_WITH_ROWS times, with a success share of at least LIVE_MIN_SHARE;
 *   production_eligible all of: on the REVIEWED list (`data/capabilities/production-eligible.json`, changed only in a reviewed PR), public data, a verified or documented price, fixture or live evidence, and not broken. Never automatic.
 *   broken              a hand card marked broken, or Diger's own calls reached it at least BROKEN_MIN_ATTEMPTS times and NEVER got a row (measured);
 *   deprecated          on the reviewed deprecation list (the provider announced its removal).
 * A promotion never happens without its evidence: a missing fact keeps the lower level.
 */
export const VERIFICATION_LEVELS = ["advertised", "schema_checked", "fixture_verified", "live_verified", "production_eligible"] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number] | "broken" | "deprecated";

/** Suggested thresholds (audit §8.2: «to be tuned with data»), stated as constants so a change is a reviewed one. */
export const LIVE_MIN_CALLS_WITH_ROWS = 2;
export const LIVE_MIN_SHARE = 0.5;
export const BROKEN_MIN_ATTEMPTS = 3;

/** Diger's own measurement of one endpoint (one row of the reliability snapshot). */
export interface MeasuredCalls {
  attempts: number;
  ok: number;
  withRows: number;
  empty: number;
  emptyPaid: number;
  failed: number;
  refused: number;
  /** Rows the provider RETURNED (not validated, not delivered). */
  rows: number;
  costUsd: number;
  costNull: number;
  p50Ms: number | null;
}

export interface EvidenceRef {
  kind: "stored_page" | "recorded_calls" | "provider_doc" | "reviewed_list" | "card_status";
  ref: string;
}

export interface EvidenceFacts {
  /** The hand ToolCard of this endpoint, when one exists. */
  card?: { status: "verified" | "catalog_only" | "broken"; checkedPages: Array<{ ref: string; issues: string[] }> } | null;
  measured?: MeasuredCalls | null;
  /** On the reviewed production list. */
  reviewedProduction?: boolean;
  /** On the reviewed deprecation list, with the reason. */
  deprecated?: string | null;
  /** The data policy's category of the endpoint (TREG), or «public» for a direct source the registry maps. */
  policy: "public" | "b2b_contact" | "sensitive" | "blocked";
}

export interface CapabilityEvidence {
  level: VerificationLevel;
  evidence: EvidenceRef[];
  /** Why the level is not higher (for the reviewer), or why it is broken / deprecated. */
  notes: string[];
}

const PRICED: ReadonlySet<PricingBasis> = new Set<PricingBasis>(["verified", "documented"]);

export function liveVerified(m: MeasuredCalls | null | undefined): boolean {
  return Boolean(m && m.withRows >= LIVE_MIN_CALLS_WITH_ROWS && m.attempts > 0 && m.withRows / m.attempts >= LIVE_MIN_SHARE);
}
export function measuredBroken(m: MeasuredCalls | null | undefined): boolean {
  return Boolean(m && m.attempts >= BROKEN_MIN_ATTEMPTS && m.withRows === 0);
}

/** The level of one capability from its facts. Pure; never throws. */
export function evidenceOf(c: Pick<Capability, "id" | "outputsKnown" | "privacy" | "pricing">, facts: EvidenceFacts): CapabilityEvidence {
  const evidence: EvidenceRef[] = [];
  const notes: string[] = [];
  if (facts.deprecated) return { level: "deprecated", evidence: [{ kind: "provider_doc", ref: facts.deprecated }], notes: [`deprecated: ${facts.deprecated}`] };
  if (facts.card?.status === "broken") return { level: "broken", evidence: [{ kind: "card_status", ref: "hand card marked broken" }], notes: ["the hand card is marked broken"] };
  const m = facts.measured ?? null;
  if (measuredBroken(m)) return { level: "broken", evidence: [{ kind: "recorded_calls", ref: `${m!.attempts} attempts, 0 with rows` }], notes: ["Diger's own calls never returned a row"] };

  let level: VerificationLevel = "advertised";
  if (c.outputsKnown) level = "schema_checked";
  else notes.push("record fields not documented: proven only on a sample");
  const cleanPages = (facts.card?.checkedPages ?? []).filter((p) => p.issues.length === 0);
  if (facts.card?.status === "verified" && cleanPages.length > 0) {
    level = "fixture_verified";
    for (const p of cleanPages) evidence.push({ kind: "stored_page", ref: p.ref });
  } else if ((facts.card?.checkedPages ?? []).length > 0) notes.push("a stored page did not map cleanly");
  if (m && m.attempts > 0) evidence.push({ kind: "recorded_calls", ref: `${m.withRows}/${m.attempts} calls with rows, ${m.rows} rows returned` });
  if (liveVerified(m)) level = "live_verified";
  else if (m && m.attempts > 0) notes.push(`live evidence below the threshold (${m.withRows}/${m.attempts} with rows)`);

  if (facts.reviewedProduction) {
    evidence.push({ kind: "reviewed_list", ref: "data/capabilities/production-eligible.json" });
    const blockers: string[] = [];
    if (facts.policy !== "public" || c.privacy !== "public") blockers.push(`policy ${facts.policy}`);
    if (!PRICED.has(c.pricing.basis)) blockers.push(`price ${c.pricing.basis}`);
    if (level !== "fixture_verified" && level !== "live_verified") blockers.push("no fixture or live evidence");
    if (blockers.length === 0) level = "production_eligible";
    else notes.push(`on the reviewed list but NOT eligible: ${blockers.join(", ")}`);
  }
  return { level, evidence, notes };
}

/** The order of the levels for comparison (broken and deprecated are below everything). */
export function levelRank(level: VerificationLevel): number {
  if (level === "broken" || level === "deprecated") return -1;
  return VERIFICATION_LEVELS.indexOf(level);
}
