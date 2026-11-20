import type { TregCatalog } from "./catalog";

export const SYNC_BOUNDS = { maxRisePct: 200, maxFallPct: 50 } as const;

export interface PriceSyncTuple { unit: string | null; usd: number | null }
export interface PriceSyncEntry {
  id: string;
  was: PriceSyncTuple;
  now?: { unit: string; usd: number };
  withdrawn?: true;
  since: string;
}
export interface PriceSyncFile { revision: number; entries: PriceSyncEntry[] }

export function priceNanos(usd: unknown): number | null {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0 || usd > 1000) return null;
  const nanos = Math.round(usd * 1e9);
  // Compare back in USD to avoid rejecting a decimal because the multiplication rounded.
  return nanos > 0 && nanos / 1e9 === usd ? nanos : null;
}

export function priceSyncTuple(cost: { unit: string | null; usd: number | null } | null): PriceSyncTuple {
  return { unit: cost?.unit ?? null, usd: cost?.usd ?? null };
}

const invalid = (detail: string): never => { throw new Error(`invalid price sync: ${detail}`); };

export function validatePriceSyncFile(data: unknown, baseline: TregCatalog, pinned: ReadonlySet<string>): PriceSyncFile {
  const file = data as PriceSyncFile | null;
  if (!file || !Number.isSafeInteger(file.revision) || file.revision < 1 || !Array.isArray(file.entries)) return invalid("invalid header");
  let previousId = "";
  for (const entry of file.entries) {
    if (!entry || typeof entry.id !== "string" || entry.id <= previousId) return invalid("entries must be sorted and unique");
    previousId = entry.id;
    const endpoint = baseline.byId.get(entry.id);
    if (!endpoint || endpoint.kind !== "direct" || pinned.has(entry.id) || baseline.writeIds.has(entry.id)) return invalid(`ineligible endpoint ${entry.id}`);
    const was = priceSyncTuple(endpoint.cost);
    if (!entry.was || was.unit !== entry.was.unit || was.usd !== entry.was.usd) return invalid(`baseline differs for ${entry.id}`);
    if (typeof entry.since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.since)) return invalid(`invalid date for ${entry.id}`);
    if (entry.withdrawn !== undefined && entry.withdrawn !== true) return invalid(`invalid withdrawal for ${entry.id}`);
    if (entry.now === undefined && entry.withdrawn === true) continue;
    if (!entry.now || !was.unit || !priceNanos(was.usd) || entry.now.unit !== was.unit || !priceNanos(entry.now.usd)) return invalid(`invalid rate for ${entry.id}`);
  }
  return file;
}

/** Validate every entry against the unmodified baseline before changing any endpoint. */
export function applyPriceSync(catalog: TregCatalog, data: unknown, pinned: ReadonlySet<string>): PriceSyncFile {
  const file = validatePriceSyncFile(data, catalog, pinned);
  const withdrawnIds = new Set<string>();
  for (const entry of file.entries) {
    const endpoint = catalog.byId.get(entry.id)!;
    if (entry.now && endpoint.cost) endpoint.cost = { ...endpoint.cost, usd: entry.now.usd };
    if (entry.withdrawn) withdrawnIds.add(entry.id);
  }
  catalog.withdrawnIds = withdrawnIds;
  return file;
}
