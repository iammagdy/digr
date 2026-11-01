import type { CatalogEndpoint, TregCatalog } from "../treg/catalog";
import { unitCost } from "../modelPlanner/pricing";
import { canExpress, toolProfile, type ConditionClass } from "./toolProfile";

/**
 * CHEAPEST SOURCE FIRST, BY CODE. For every stage the planner is given the candidate sources of the catalog ranked by their EXPECTED COST PER DELIVERED ITEM, computed here and nowhere else:
 *
 *   expected cost per item = (price of a call / rows a call returns) / chance that a call gives rows      (a per-record price is the price as it is)
 *
 *   - what a call really cost and how many rows it really returned are MEASURED from the recorded calls of the missions (mission_calls) where they exist, blended with the catalog's own price and a prior page size
 *     (a few measured rows must not decide alone); without a record the catalog decides, and the prior page size is the limit input's default or its maximum (never more than twenty; twenty when it names none), five for a source with no limit input;
 *   - the chance that a call gives rows is measured the same way (smoothed), else the catalog's own observed rate, else 0.8;
 *   - SOURCE HEALTH comes from the same recorded calls, in a time window and with no rule about any provider: a source whose recent calls failed because of its CONFIGURATION (not configured, refused credentials) is
 *     skipped; one whose recent calls failed on INPUT or VALIDATION (a 400, 422 or 404, a refused missing input) is demoted after one such failure and skipped after three, until a call of it gives rows again.
 *     A failure of the network, a timeout, a server error, the planning's own budget or the cost cap says nothing about the source and counts for nothing.
 *
 * Pure: no I/O. The recorded calls come in as plain rows.
 */
export const SOURCE_HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A demoted source costs this many times its expected cost in the ranking. */
export const SOURCE_DEMOTE_FACTOR = 5;
/** Input or validation failures (since the last call that gave rows, inside the window) that skip a source; fewer demote it. */
export const SOURCE_SKIP_AFTER_VALIDATION_FAILURES = 3;
/** Rows of weight the catalog's price carries against a measurement: a handful of measured rows is blended with it. */
const PRIOR_ROWS = 5;
const DEFAULT_ROWS_PER_CALL = 5;
const LIMIT_INPUTS = ["limit", "count", "page_size", "per_page", "size", "num", "max_results", "pageSize", "perPage", "maxItems", "max_items", "n"];

/** One recorded call of a mission, as the mission_calls table holds it. */
export interface RecordedCallFact {
  endpoint_id: string;
  status: string;
  refused_reason?: string | null;
  http_status?: number | null;
  rows_returned?: number | null;
  cost_usd?: number | string | null;
  created_at: string | number;
  params_digest?: Record<string, unknown> | null;
}

export type FailureKind = "config" | "validation" | "payment" | "transient" | "none";

/** What a recorded call says about its SOURCE (not about the mission): configuration, input/validation, or nothing. Generic: refusal codes, HTTP statuses and the provider's own words. */
export function classifyFailure(call: Pick<RecordedCallFact, "status" | "refused_reason" | "http_status" | "params_digest">): FailureKind {
  const reason = String(call.refused_reason ?? "");
  if (call.status === "refused") {
    if (/^source_unavailable/.test(reason) || /^needs_login/.test(reason)) return "config";
    if (/^missing_params/.test(reason)) return "validation";
    return "none"; // the mission's own limits (budget, daily cap, repeat, choose_cheapest) say nothing about the source
  }
  if (call.status !== "failed") return "none";
  const http = Number(call.http_status ?? 0);
  const text = String(call.params_digest?._failure ?? "");
  // a 402 that the key pool checked against the key's own balance (healthy) is THIS source refusing payment: it is demoted, never skipped; a bare 402 or a price cap says nothing about the source
  if (http === 402 && /^endpoint_payment_refused/.test(text)) return "payment";
  if (/route_max_cost|over_budget|budget/i.test(text) || http === 402) return "none"; // the price cap of the call, not the source
  if (http === 401 || http === 403 || /not configured|no api key|missing (api )?key|unauthori[sz]ed|forbidden|credential/i.test(text)) return "config";
  if (http === 400 || http === 404 || http === 422 || /not allowed|not a valid|invalid|is required|must be|unsupported|unknown (parameter|value)|bad request/i.test(text)) return "validation";
  return "transient"; // a timeout, a network failure, a server error
}

export interface SourceStats {
  /** Calls that reached the source (ok, empty or failed). */
  attempts: number;
  /** Calls that gave at least one row. */
  withRows: number;
  /** Rows of the ok calls and what they cost (USD): the measurement of the price per row. */
  rows: number;
  costUsd: number;
  okCalls: number;
  /** The recent failures that say something about the source, oldest first. */
  bad: Array<{ at: number; kind: "config" | "validation" | "payment" }>;
  lastRowsAt: number | null;
}
export type StatsMap = Map<string, SourceStats>;

const atOf = (v: string | number): number => (typeof v === "number" ? v : Date.parse(v));

/** The measurement and the health facts of every source, from the recorded calls. */
export function statsFromCalls(calls: ReadonlyArray<RecordedCallFact>): StatsMap {
  const out: StatsMap = new Map();
  const sorted = [...calls].sort((a, b) => atOf(a.created_at) - atOf(b.created_at));
  for (const c of sorted) {
    const id = String(c.endpoint_id);
    const s = out.get(id) ?? { attempts: 0, withRows: 0, rows: 0, costUsd: 0, okCalls: 0, bad: [], lastRowsAt: null };
    const at = atOf(c.created_at);
    const kind = classifyFailure(c);
    if (kind === "config" || kind === "validation" || kind === "payment") s.bad.push({ at: Number.isFinite(at) ? at : 0, kind });
    if (c.status === "ok" || c.status === "empty" || c.status === "failed") s.attempts += 1;
    if (c.status === "ok") {
      const rows = Math.max(0, Math.floor(Number(c.rows_returned ?? 0)));
      s.okCalls += 1;
      s.rows += rows;
      s.costUsd += Math.max(0, Number(c.cost_usd ?? 0));
      if (rows > 0) { s.withRows += 1; s.lastRowsAt = Number.isFinite(at) ? at : s.lastRowsAt; }
    }
    out.set(id, s);
  }
  return out;
}

export interface SourceHealth {
  state: "ok" | "demoted" | "skipped";
  /** Why, for the admin: the kind of failure and how many since the source last gave rows. */
  reason: "config" | "validation" | "payment" | null;
  failures: number;
  /** When the source is tried again (the end of the window after its last failure), else null. */
  until: number | null;
}

export function sourceHealth(stats: SourceStats | undefined, now: number): SourceHealth {
  if (!stats) return { state: "ok", reason: null, failures: 0, until: null };
  const since = Math.max(now - SOURCE_HEALTH_WINDOW_MS, stats.lastRowsAt ?? 0);
  const recent = stats.bad.filter((b) => b.at > since);
  if (recent.length === 0) return { state: "ok", reason: null, failures: 0, until: null };
  const last = recent[recent.length - 1].at;
  const until = last + SOURCE_HEALTH_WINDOW_MS;
  if (recent.some((b) => b.kind === "config")) return { state: "skipped", reason: "config", failures: recent.length, until };
  const validation = recent.filter((b) => b.kind === "validation").length;
  if (validation >= SOURCE_SKIP_AFTER_VALIDATION_FAILURES) return { state: "skipped", reason: "validation", failures: recent.length, until };
  return { state: "demoted", reason: validation > 0 ? "validation" : "payment", failures: recent.length, until };
}

export interface ExpectedCost {
  /** Expected USD per delivered item (before the demotion). Null: the catalog has no usable price. */
  usdPerItem: number | null;
  rowsPerCall: number;
  /** Chance that a call gives rows, 0.1 to 1. */
  successRate: number;
  basis: "measured" | "catalog";
}

const numberOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The rows a call of this endpoint is expected to return when nothing was measured: the input's default or its maximum (at most twenty), else five. */
export function priorRowsPerCall(endpoint: CatalogEndpoint): number {
  const input = endpoint.inputs.find((i) => LIMIT_INPUTS.includes(i.name));
  const fromDefault = numberOf(input?.default);
  const fromMax = numberOf(input?.maximum);
  // an endpoint that takes a limit can return that many (twenty when it names no figure); one that takes none returns what its provider decides (the live Facebook search: five)
  const value = fromDefault ?? fromMax ?? (input ? 20 : DEFAULT_ROWS_PER_CALL);
  return Math.max(1, Math.min(20, Math.floor(value)));
}

export function expectedCost(endpoint: CatalogEndpoint, catalog: TregCatalog, stats: SourceStats | undefined): ExpectedCost {
  // the catalog's price of one unit and whether the unit is a record or a call; a ROUTED endpoint (any sibling may serve the call) is priced at its dearest sibling
  const unit = unitCost(endpoint, catalog);
  const measuredCalls = stats?.okCalls ?? 0;
  const measuredRowsPerCall = stats && stats.okCalls > 0 && stats.rows > 0 ? stats.rows / stats.okCalls : null;
  const rowsPerCall = measuredRowsPerCall ?? priorRowsPerCall(endpoint);
  let usdPerItem: number | null = null;
  if (unit) {
    const prior = unit.unit === "record" ? unit.usd : unit.usd / Math.max(1, priorRowsPerCall(endpoint));
    // a measurement is blended with the catalog's price: PRIOR_ROWS rows of weight for the catalog, every measured row for the measurement
    usdPerItem = stats && stats.rows > 0 && stats.costUsd > 0 ? (stats.costUsd + prior * PRIOR_ROWS) / (stats.rows + PRIOR_ROWS) : prior;
    // a per-call price over the rows that calls really return (a source that gives fewer rows than its page size costs more per row)
    if (unit.unit === "call" && measuredRowsPerCall !== null && (stats?.costUsd ?? 0) === 0) usdPerItem = Math.max(usdPerItem, unit.usd / Math.max(1, measuredRowsPerCall));
  }
  const observed = endpoint.observed as Record<string, unknown> | null;
  const observedRate = (numberOf(observed?.ok_rate) ?? 1) * (numberOf(observed?.hit_rate) ?? 1);
  const attempts = stats?.attempts ?? 0;
  const prior = Number.isFinite(observedRate) && observedRate > 0 && observed && (observed.ok_rate !== undefined || observed.hit_rate !== undefined) ? observedRate : 0.8;
  // smoothed: the measurement counts as the attempts it rests on, the prior as two attempts
  const successRate = attempts > 0 ? ((stats?.withRows ?? 0) + prior * 2) / (attempts + 2) : prior;
  return { usdPerItem, rowsPerCall, successRate: Math.min(1, Math.max(0.1, successRate)), basis: measuredCalls > 0 ? "measured" : "catalog" };
}

export interface RankedSource {
  id: string;
  capability: string | null;
  usdPerItem: number;
  /** The figure the ranking sorts by: the expected cost per item over the chance of rows, times the demotion. */
  effectiveUsd: number;
  rowsPerCall: number;
  successRate: number;
  basis: "measured" | "catalog";
  health: SourceHealth;
}

export interface Ranking { ranked: RankedSource[]; skipped: Array<{ id: string; health: SourceHealth }> }

/** The candidates ranked by expected cost per delivered item, cheapest first; sources skipped for their health are listed apart (never offered). Ties are broken by id so the order is stable. */
export function rankEndpoints(endpoints: ReadonlyArray<CatalogEndpoint>, catalog: TregCatalog, stats: StatsMap, now: number): Ranking {
  const ranked: RankedSource[] = [];
  const skipped: Ranking["skipped"] = [];
  const seen = new Set<string>();
  for (const e of endpoints) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const s = stats.get(e.id);
    const health = sourceHealth(s, now);
    const cost = expectedCost(e, catalog, s);
    if (cost.usdPerItem === null) continue; // no usable price: not offered
    if (health.state === "skipped") { skipped.push({ id: e.id, health }); continue; }
    const effectiveUsd = (cost.usdPerItem / cost.successRate) * (health.state === "demoted" ? SOURCE_DEMOTE_FACTOR : 1);
    ranked.push({ id: e.id, capability: e.capability, usdPerItem: cost.usdPerItem, effectiveUsd, rowsPerCall: cost.rowsPerCall, successRate: cost.successRate, basis: cost.basis, health });
  }
  ranked.sort((a, b) => a.effectiveUsd - b.effectiveUsd || a.id.localeCompare(b.id));
  return { ranked, skipped };
}

/** The endpoints that do the same job as these: every endpoint of the catalog with the capability of one of them (a post search, a company search, the comments of a video). */
export function sameCapability(seeds: ReadonlyArray<CatalogEndpoint>, catalog: TregCatalog, isAllowed: (id: string) => boolean): CatalogEndpoint[] {
  const caps = new Set(seeds.map((s) => s.capability).filter((c): c is string => Boolean(c)));
  const out = new Map<string, CatalogEndpoint>();
  for (const s of seeds) out.set(s.id, s);
  for (const e of catalog.endpoints) if (e.capability && caps.has(e.capability) && isAllowed(e.id)) out.set(e.id, e);
  return [...out.values()];
}

/** The candidates of the same capability as `id` that rank clearly cheaper than it (by `factor`) and are neither skipped for health: what the planner must sample first or give a reason to skip. */
export function cheaperAlternatives(id: string, catalog: TregCatalog, stats: StatsMap, now: number, isAllowed: (id: string) => boolean, options: { factor?: number; max?: number } = {}): Array<RankedSource & { cheaperBy: number }> {
  const e = catalog.byId.get(id);
  if (!e || !e.capability) return [];
  const group = sameCapability([e], catalog, isAllowed);
  const { ranked } = rankEndpoints(group, catalog, stats, now);
  const mine = ranked.find((r) => r.id === id);
  // the chosen source may itself be skipped for health (then it is not in `ranked`): it is compared with its own expected cost
  const mineCost = mine?.effectiveUsd ?? (() => { const c = expectedCost(e, catalog, stats.get(id)); return c.usdPerItem === null ? null : c.usdPerItem / c.successRate; })();
  if (mineCost === null) return [];
  const factor = options.factor ?? 1.5;
  return ranked.filter((r) => r.id !== id && r.effectiveUsd * factor <= mineCost).slice(0, options.max ?? 3).map((r) => ({ ...r, cheaperBy: r.effectiveUsd > 0 ? mineCost / r.effectiveUsd : Number.POSITIVE_INFINITY }));
}

/** A source this many times dearer than one that answered EMPTY for a single input is not bought before that cheaper source is asked once more with another item (one empty answer says little about a source). */
export const EMPTY_ONCE_FACTOR = 5;

/** The words the planner may give for skipping a cheaper source: recorded with the call. */
export const SKIP_REASONS = ["wrong_data", "missing_input", "too_few_rows", "known_failing", "other"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

// ---------------------------------------------------------------------------------------------------- coverage first, then price (S1 item 1.5)

/** Which of the wanted conditions this endpoint's own inputs can express, and which not (toolProfile.ts). */
export function coverageOf(endpoint: CatalogEndpoint, wanted: ReadonlyArray<ConditionClass>): { covered: ConditionClass[]; missing: ConditionClass[] } {
  const profile = toolProfile(endpoint);
  const covered = wanted.filter((c) => canExpress(profile, c));
  return { covered, missing: wanted.filter((c) => !covered.includes(c)) };
}

export interface CoverageRankedSource extends RankedSource { covered: ConditionClass[]; missing: ConditionClass[] }
export interface CoverageRanking { ranked: CoverageRankedSource[]; skipped: Ranking["skipped"]; /** Wanted conditions that NO candidate can express (the count is never a gap: the delivery cap is code). */ gaps: ConditionClass[] }

/**
 * THE CANDIDATES RANKED BY CONDITION COVERAGE, THEN PRICE (owner decision D7: first look for another tool that can express the condition). The tools that can express more of the wanted conditions come first; among equals the usual expected
 * cost per delivered item decides (rankEndpoints). A condition no candidate can express is returned as a gap, and the ranking then falls back to price for it. The page size does not count toward coverage. Pure.
 */
export function rankByCoverage(endpoints: ReadonlyArray<CatalogEndpoint>, catalog: TregCatalog, stats: StatsMap, now: number, wanted: ReadonlyArray<ConditionClass>, options: { /** The rows the request needs: above what one call returns, an endpoint with no cursor ranks below a pageable one (item 1.8). */ rows?: number } = {}): CoverageRanking {
  const base = rankEndpoints(endpoints, catalog, stats, now);
  const scored = base.ranked.map((r) => ({ ...r, ...coverageOf(catalog.byId.get(r.id)!, wanted) }));
  const score = (r: { covered: ConditionClass[] }): number => r.covered.filter((c) => c !== "count").length;
  const stuck = (r: CoverageRankedSource): number => (options.rows !== undefined && options.rows > r.rowsPerCall && toolProfile(catalog.byId.get(r.id)!).cursor === null ? 1 : 0);
  scored.sort((a, b) => score(b) - score(a) || stuck(a) - stuck(b) || a.effectiveUsd - b.effectiveUsd || a.id.localeCompare(b.id));
  const gaps = wanted.filter((c) => c !== "count" && scored.length > 0 && scored.every((r) => !r.covered.includes(c)));
  return { ranked: scored, skipped: base.skipped, gaps };
}
