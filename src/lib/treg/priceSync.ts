import { isDeepStrictEqual } from "node:util";
import { catalogInputFields } from "../agentMission/capabilities/providerDrift";
import { unitCost } from "../modelPlanner/pricing";
import { isSellable, type CatalogEndpoint, type TregCatalog } from "./catalog";
import { applyPriceSync, priceNanos, priceSyncTuple, SYNC_BOUNDS, type PriceSyncEntry, type PriceSyncFile } from "./priceSyncFile";

export type PriceObservation =
  | { kind: "live"; endpoint: Record<string, unknown> }
  | { kind: "gone" }
  | { kind: "unverified" };

export interface PriceSyncRow {
  id: string;
  unit: string | null;
  before: number | null;
  observed: number | null;
  reason: string;
  field?: string;
  state: "applied" | "held" | "same" | "report-only" | "gone" | "restored" | "unverified";
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function location(group: string | null): string | null {
  if (group === "queryParams") return "query";
  if (group === "pathParams" || group === "params") return "path";
  return group;
}

function limitsMatch(stored: CatalogEndpoint, live: unknown): { reason: string; field?: string } | null {
  if (!record(live)) return { reason: "basis_unproven" };
  const fields = new Map<string, Record<string, unknown>>();
  for (const [group, name, spec] of catalogInputFields(live)) {
    const key = `${location(group)}:${name}`;
    const field = record(spec);
    if (!field || fields.has(key)) return { reason: "basis_unproven", field: name };
    fields.set(key, field);
  }
  for (const storedField of stored.inputs) {
    const key = `${location(storedField.in)}:${storedField.name}`;
    const field = fields.get(key);
    if (!field) return { reason: "input_missing", field: storedField.name };
    fields.delete(key);
    const expected = [storedField.minimum, storedField.maximum, storedField.default, storedField.enum];
    const observed = [field.min, field.max, field.default, field.enum];
    if (!isDeepStrictEqual(expected.map((value) => value ?? null), observed.map((value) => value ?? null))) {
      return { reason: "input_limits_changed", field: storedField.name };
    }
    // With no structured range, an opaque note may be the only record of a size rule.
    if (storedField.minimum == null && storedField.maximum == null && storedField.enum == null &&
      (storedField.note ?? null) !== (field.note ?? null)) {
      return { reason: "size_note_changed", field: storedField.name };
    }
  }
  return fields.size ? { reason: "input_added", field: fields.keys().next().value } : null;
}

function basisDifference(stored: CatalogEndpoint, live: Record<string, unknown>, cost: Record<string, unknown> | null) {
  const before = stored.cost;
  if (!before?.type || !before.unit || typeof before.per !== "number" || !Number.isFinite(before.per) || before.per <= 0 ||
    typeof cost?.type !== "string" || !cost.type || typeof cost.unit !== "string" || !cost.unit ||
    typeof cost.per !== "number" || !Number.isFinite(cost.per) || cost.per <= 0) return { reason: "basis_unproven" };
  if (before.type !== cost.type) return { reason: "billing_label_changed" };
  if (before.unit !== cost.unit || before.per !== cost.per) return { reason: "billing_unit_changed" };
  return limitsMatch(stored, live.input);
}

function routedDependents(catalog: TregCatalog): Map<string, CatalogEndpoint[]> {
  const dependents = new Map<string, CatalogEndpoint[]>();
  for (const endpoint of catalog.endpoints) {
    if (endpoint.kind !== "routed") continue;
    for (const id of endpoint.siblings) {
      const list = dependents.get(id) ?? [];
      list.push(endpoint);
      dependents.set(id, list);
    }
  }
  return dependents;
}

function changesRoutedEstimate(catalog: TregCatalog, endpoint: CatalogEndpoint, usd: number, dependents: CatalogEndpoint[]): boolean {
  const before = dependents.map((route) => unitCost(route, catalog));
  const cost = endpoint.cost!;
  endpoint.cost = { ...cost, usd };
  try {
    return dependents.some((route, index) => !isDeepStrictEqual(before[index], unitCost(route, catalog)));
  } finally {
    endpoint.cost = cost;
  }
}

/** Rebuilds the file from the effective prices while preserving its immutable anchors and prior state. */
export function buildPriceSync(baseline: TregCatalog, previous: PriceSyncFile, observations: ReadonlyMap<string, PriceObservation>, pinned: ReadonlySet<string>, date: string) {
  const endpoints = baseline.endpoints.map((endpoint) => ({ ...endpoint }));
  const catalog = { ...baseline, endpoints, byId: new Map(endpoints.map((endpoint) => [endpoint.id, endpoint])) };
  applyPriceSync(catalog, previous, pinned);
  const dependents = routedDependents(catalog);
  const entries = new Map(previous.entries.map((entry) => [entry.id, entry]));
  const rows: PriceSyncRow[] = [];

  for (const id of [...observations.keys()].sort()) {
    const observation = observations.get(id)!;
    const endpoint = catalog.byId.get(id);
    const original = baseline.byId.get(id);
    if (!endpoint || !original) throw new Error(`unknown snapshot id: ${id}`);
    const prior = entries.get(id);
    const live = observation.kind === "live" && observation.endpoint.id === id ? observation.endpoint : null;
    const cost = record(live?.cost);
    const { unit, usd: before } = priceSyncTuple(endpoint.cost);
    const observed = typeof cost?.usd === "number" && Number.isFinite(cost.usd) ? cost.usd : null;
    const writeRow = (state: PriceSyncRow["state"], reason: string, field?: string) => rows.push({ id, unit, before, observed, state, reason, field });

    if (pinned.has(id)) { writeRow("report-only", "pinned_by_review"); continue; }
    if (endpoint.kind !== "direct") { writeRow("report-only", "routed_report_only"); continue; }
    if (!isSellable(id, baseline)) { writeRow("report-only", "ineligible"); continue; }
    if (observation.kind === "gone") {
      if (!prior?.withdrawn) entries.set(id, { id, was: priceSyncTuple(original.cost), now: prior?.now, withdrawn: true, since: date });
      writeRow("gone", prior?.withdrawn ? "already_withdrawn" : "withdrawn");
      continue;
    }
    if (!live) { writeRow("unverified", "unverified"); continue; }

    const next = priceNanos(cost?.usd);
    if (next === null) { writeRow("held", "price_invalid"); continue; }
    const difference = basisDifference(original, live, cost);
    if (difference) { writeRow("held", difference.reason, difference.field); continue; }
    const old = priceNanos(before);
    if (old === null) { writeRow("held", "from_free"); continue; }
    if (next === old && !prior?.withdrawn) { writeRow("same", "same"); continue; }
    if (next * 100 > old * (100 + SYNC_BOUNDS.maxRisePct)) { writeRow("held", "rise_over_bound"); continue; }
    if (next * 100 < old * (100 - SYNC_BOUNDS.maxFallPct)) { writeRow("held", "fall_over_bound"); continue; }
    const now = { unit: unit!, usd: next / 1e9 };
    if (changesRoutedEstimate(catalog, endpoint, now.usd, dependents.get(id) ?? [])) {
      writeRow("report-only", "routed_sibling_changes_estimate");
      continue;
    }
    entries.set(id, { id, was: priceSyncTuple(original.cost), now, since: date });
    endpoint.cost = { ...endpoint.cost!, usd: now.usd };
    writeRow(prior?.withdrawn ? "restored" : "applied", prior?.withdrawn ? "restored" : "apply");
  }
  const ordered = [...entries.keys()].sort().map((id) => entries.get(id)!);
  const changed = !isDeepStrictEqual(ordered, previous.entries);
  return { rows, file: changed ? { revision: previous.revision + 1, entries: ordered } : previous };
}
