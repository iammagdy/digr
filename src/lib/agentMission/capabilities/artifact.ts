import { createHash } from "node:crypto";
import type { CatalogEndpoint, TregCatalog } from "../../treg/catalog";
import { BROKEN_MIN_ATTEMPTS, evidenceOf, levelRank, LIVE_MIN_CALLS_WITH_ROWS, LIVE_MIN_SHARE, type CapabilityEvidence, type EvidenceFacts, type MeasuredCalls, type VerificationLevel } from "./evidence";
import type { Capability, CapabilityRegistry, Operation } from "./registry";

/**
 * PHASE 3, THE REVIEWABLE REGISTRY ARTIFACT (`data/capabilities/registry.json`; audit §7.2, PR-3.1). The SAME registry discovery uses (`buildCapabilityRegistry`), written out with its evidence, pricing provenance, reliability and
 * fingerprints so a PR shows exactly what changed. Deterministic: sorted, no clock, no network; the same inputs give the same bytes. Customer surfaces never read it (provider names and prices stay internal).
 *
 * It describes CAPABILITY TRUTH, not an account's availability: built with a normal account's data policy and no key or cap facts. A capability's runtime availability (keys, caps, health) is decided at planning time, as before.
 */
export const ARTIFACT_VERSION = 1 as const;

export interface ArtifactInputs {
  catalog: TregCatalog;
  /** The registry built from `catalog` for the artifact (normal account, no availability facts). */
  registry: CapabilityRegistry;
  /** The data policy category of a TREG endpoint. */
  policyOf: (endpointId: string) => "public" | "b2b_contact" | "sensitive" | "blocked";
  /** Hand ToolCards and the result of checking each on its stored real pages. */
  cards: ReadonlyMap<string, NonNullable<EvidenceFacts["card"]>>;
  /** Diger's own measured calls per endpoint id (the reliability snapshot). */
  measured: ReadonlyMap<string, MeasuredCalls>;
  /** The reviewed production list. */
  reviewedProduction: ReadonlySet<string>;
  /** The reviewed deprecation list (id → reason). */
  deprecated: ReadonlyMap<string, string>;
  /** Capabilities a provider advertises that Diger has NOT implemented (never a candidate): listed so the gap is visible. */
  advertisedOnly: ReadonlyArray<{ id: string; provider: string; family: string; level: "advertised" | "deprecated"; note: string }>;
  /** Digests of every input file, recorded in the artifact. */
  sources: Record<string, string>;
}

export interface ArtifactEntry {
  key: string;
  id: string;
  operation: Operation;
  provider: Capability["provider"];
  sub_provider: string;
  access: Capability["access"];
  platform: string | null;
  inputs_required: string[];
  takes: Capability["takes"];
  outputs: Capability["outputs"];
  outputs_known: boolean;
  list_path: string | null;
  pagination: boolean;
  max_rows_per_call: number;
  filters: Capability["filters"];
  pricing: Capability["pricing"];
  usd_per_row: number | null;
  policy: EvidenceFacts["policy"];
  privacy: Capability["privacy"];
  verification: CapabilityEvidence;
  reliability: { diger: MeasuredCalls | null; provider_observed: { ok_rate: number | null; samples: number | null; p50_ms: number | null } | null };
  limitations: string[];
  fallback_group: string;
  card: string | null;
  schema_fingerprint: string;
}

export interface RegistryArtifact {
  _about: string;
  version: typeof ARTIFACT_VERSION;
  catalog_source: string;
  sources: Record<string, string>;
  counts: { capabilities: number; by_level: Record<string, number>; by_provider: Record<string, number>; by_operation: Record<string, number>; usable_now: number; production_eligible: number };
  thresholds: { live_min_calls_with_rows: number; live_min_share: number; broken_min_attempts: number };
  capabilities: ArtifactEntry[];
  advertised_only: ArtifactInputs["advertisedOnly"];
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A fingerprint of what a capability TAKES and GIVES (inputs, their required-ness, record fields, list and cursor paths): a breaking schema change changes it. */
export function schemaFingerprintOf(e: CatalogEndpoint | null, c: Capability): string {
  const shape = e
    ? {
        inputs: [...e.inputs].map((i) => [i.name, Boolean(i.required), String(i.type ?? "")]).sort(),
        pagination: [...(e.pagination ?? [])].sort(),
        fields: Object.keys(e.item_fields ?? {}).sort(),
        list: String((e as { list_path?: unknown }).list_path ?? ""),
        cursor: String((e as { cursor_path?: unknown }).cursor_path ?? ""),
      }
    : { takes: [...c.takes].sort(), outputs: [...c.outputs].sort(), pagination: c.pagination, maxRows: c.maxRowsPerCall };
  return sha256(JSON.stringify(shape)).slice(0, 16);
}

const round = (n: number | null): number | null => (n === null || !Number.isFinite(n) ? null : Number(n.toPrecision(6)));

export function buildRegistryArtifact(inp: ArtifactInputs): RegistryArtifact {
  const entries: ArtifactEntry[] = [];
  for (const c of inp.registry.all) {
    const e = c.provider === "treg" ? inp.catalog.byId.get(c.id) ?? null : null;
    const policy = c.provider === "treg" ? inp.policyOf(c.id) : "public";
    const card = inp.cards.get(c.id) ?? null;
    const measured = inp.measured.get(c.id) ?? null;
    const verification = evidenceOf(c, { card, measured, reviewedProduction: inp.reviewedProduction.has(c.id), deprecated: inp.deprecated.get(c.id) ?? null, policy });
    const observed = (e as { observed?: { ok_rate?: unknown; samples?: unknown; p50_ms?: unknown } | null } | null)?.observed ?? null;
    entries.push({
      key: `${c.id}#${c.operation}`,
      id: c.id,
      operation: c.operation,
      provider: c.provider,
      sub_provider: e ? String(e.provider ?? c.id.split(".")[0]) : c.provider,
      access: c.access,
      platform: c.platform,
      inputs_required: e ? e.inputs.filter((i) => i.required).map((i) => i.name).sort() : [],
      takes: [...c.takes].sort(),
      outputs: [...c.outputs].sort(),
      outputs_known: c.outputsKnown,
      list_path: e ? ((e as { list_path?: string | null }).list_path ?? null) : null,
      pagination: c.pagination,
      max_rows_per_call: c.maxRowsPerCall,
      filters: c.filters,
      pricing: { ...c.pricing, usd: round(c.pricing.usd) },
      usd_per_row: round(c.usdPerRow),
      policy,
      privacy: c.privacy,
      verification,
      reliability: {
        diger: measured,
        // the PROVIDER's own statistic (TREG's catalog): a weak prior only, never proof of Diger's execution quality
        provider_observed: observed ? { ok_rate: typeof observed.ok_rate === "number" ? observed.ok_rate : null, samples: typeof observed.samples === "number" ? observed.samples : null, p50_ms: typeof observed.p50_ms === "number" ? observed.p50_ms : null } : null,
      },
      limitations: [c.limits, c.outputsKnown ? null : "record fields unknown: proven on a sample before a dependent stage relies on them", c.pricing.basis === "unknown" ? "price unknown" : null].filter((x): x is string => typeof x === "string" && x !== ""),
      fallback_group: `${c.operation}:${c.platform ?? "any"}`,
      card: card ? c.id : null,
      schema_fingerprint: schemaFingerprintOf(e, c),
    });
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  const count = (f: (e: ArtifactEntry) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const e of entries) out[f(e)] = (out[f(e)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  const usable = (e: ArtifactEntry) => e.policy === "public" && e.privacy === "public" && levelRank(e.verification.level) >= 0;
  return {
    _about: "GENERATED by scripts/capabilities/build-registry.ts (npm run capabilities:registry); do not edit by hand. The capability registry discovery uses, with its evidence (docs/intelligence/PHASES-2-4-ACCEPTANCE.md). Internal only: never shown to a customer.",
    version: ARTIFACT_VERSION,
    catalog_source: String((inp.catalog as unknown as { source?: unknown }).source ?? ""),
    sources: Object.fromEntries(Object.entries(inp.sources).sort(([a], [b]) => a.localeCompare(b))),
    counts: {
      capabilities: entries.length,
      by_level: count((e) => e.verification.level),
      by_provider: count((e) => e.provider),
      by_operation: count((e) => e.operation),
      usable_now: entries.filter(usable).length,
      production_eligible: entries.filter((e) => e.verification.level === "production_eligible").length,
    },
    thresholds: { live_min_calls_with_rows: LIVE_MIN_CALLS_WITH_ROWS, live_min_share: LIVE_MIN_SHARE, broken_min_attempts: BROKEN_MIN_ATTEMPTS },
    capabilities: entries,
    advertised_only: [...inp.advertisedOnly].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** The artifact as committed: one capability per line, so a review diff shows one line per changed capability. */
export function serializeArtifact(a: RegistryArtifact): string {
  const { capabilities, advertised_only, ...head } = a;
  const headJson = JSON.stringify(head, null, 2);
  const lines = capabilities.map((c) => `    ${JSON.stringify(c)}`).join(",\n");
  const adv = advertised_only.map((c) => `    ${JSON.stringify(c)}`).join(",\n");
  return `${headJson.slice(0, -2)},\n  "capabilities": [\n${lines}\n  ],\n  "advertised_only": [\n${adv}\n  ]\n}\n`;
}

/** The level of each capability key, for the router and the diff. */
export function levelsOf(a: RegistryArtifact): Map<string, VerificationLevel> {
  return new Map(a.capabilities.map((c) => [c.key, c.verification.level]));
}
