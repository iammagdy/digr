import { loadTregCatalog, type TregCatalog } from "../treg/catalog";
import { contactFinderKind, type ContactFinderKind } from "./contactSampling";

export type FinderKindName = ContactFinderKind;

export interface MeasuredFinderEntry {
  calls: number;
  hits: number;
  kind: FinderKindName;
}

const byCatalog = new WeakMap<TregCatalog, Record<string, MeasuredFinderEntry>>();

/**
 * WHAT THE E-MAIL AND PHONE FINDERS REALLY DO, MEASURED from the platform's call log (`observed.diger_calls` / `observed.diger_hits`
 * merged into the catalog from `data/treg/endpoint_metadata_overlay.json`): `calls` = calls made, `hits` = calls the provider billed for an answer.
 */
export function measuredFinderCallsFromCatalog(catalog: TregCatalog): Record<string, MeasuredFinderEntry> {
  const cached = byCatalog.get(catalog);
  if (cached) return cached;
  const out: Record<string, MeasuredFinderEntry> = {};
  for (const endpoint of catalog.endpoints) {
    const obs = endpoint.observed as { diger_calls?: unknown; diger_hits?: unknown } | null | undefined;
    if (
      typeof obs?.diger_calls === "number" &&
      Number.isFinite(obs.diger_calls) &&
      obs.diger_calls > 0 &&
      typeof obs?.diger_hits === "number" &&
      Number.isFinite(obs.diger_hits)
    ) {
      const kind = contactFinderKind(endpoint.capability);
      if (kind) out[endpoint.id] = { calls: obs.diger_calls, hits: obs.diger_hits, kind };
    }
  }
  byCatalog.set(catalog, out);
  return out;
}

let cachedDefaultMeasured: Readonly<Record<string, { calls: number; hits: number }>> | null = null;
function defaultMeasuredFinderCalls(): Readonly<Record<string, { calls: number; hits: number }>> {
  if (!cachedDefaultMeasured) {
    const out: Record<string, { calls: number; hits: number }> = {};
    for (const [id, m] of Object.entries(measuredFinderCallsFromCatalog(loadTregCatalog()))) {
      out[id] = { calls: m.calls, hits: m.hits };
    }
    cachedDefaultMeasured = out;
  }
  return cachedDefaultMeasured;
}

/** Lazy view of measured calls on the default catalog (no catalog read at module import time; A6). */
export const MEASURED_FINDER_CALLS: Readonly<Record<string, { calls: number; hits: number }>> = new Proxy(
  {} as Record<string, { calls: number; hits: number }>,
  {
    get: (_t, prop) => Reflect.get(defaultMeasuredFinderCalls(), prop),
    has: (_t, prop) => Reflect.has(defaultMeasuredFinderCalls(), prop),
    ownKeys: () => Reflect.ownKeys(defaultMeasuredFinderCalls()),
    getOwnPropertyDescriptor: (_t, prop) => Reflect.getOwnPropertyDescriptor(defaultMeasuredFinderCalls(), prop),
  },
);

/** The hit rate of the whole kind (every measured finder together), smoothed. */
export function pooledHitRate(kind: FinderKindName, catalog: TregCatalog = loadTregCatalog()): number {
  let calls = 0;
  let hits = 0;
  for (const m of Object.values(measuredFinderCallsFromCatalog(catalog))) {
    if (m.kind === kind) {
      calls += m.calls;
      hits += m.hits;
    }
  }
  return (hits + 0.5) / (calls + 1);
}

/**
 * THE SHARE OF PERSONS A FINDER GIVES A VALUE FOR: (hits + 0.5) / (calls + 1) from its own measured calls (never 0 and never 1: a finder asked ten times is not certain either way), else the pooled rate of its kind for a finder nobody has called yet.
 */
export function finderHitRate(endpointId: string, kind: FinderKindName, catalog: TregCatalog = loadTregCatalog()): number {
  const m = measuredFinderCallsFromCatalog(catalog)[endpointId];
  return m ? (m.hits + 0.5) / (m.calls + 1) : pooledHitRate(kind, catalog);
}
