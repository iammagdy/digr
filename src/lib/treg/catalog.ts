import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeArabic } from "../arabicNormalize";
import { PAUSED_PROVIDERS } from "./blockList";

/**
 * The TREG catalog as DATA: a local snapshot (data/treg/treg_catalog_sellable.json, 3,276 endpoints with inputs, cost, observed stats, siblings, a test request, the
 * list and cursor paths, the item fields and a trimmed example answer) read with NO network call. Own-account endpoints, write actions and paused providers were
 * removed from the snapshot; the write actions are kept apart (data/treg/treg_write_actions.json) so they can be refused by name.
 *
 * Nothing here is wired into the chat or the worker (PR B is flag-free data and readers). The snapshot is large (10 MB): it is read lazily, once per process, and only
 * by code that asks for it. Whether the deployed function can see `data/` (file tracing) is NOT PROVEN and must be settled before any wiring.
 *
 * Field TYPES in an example can differ from a live call (anyapi.x.user.posts: the example has isReply as a boolean and createdUtc as a number; live rows carry the
 * text «True»/«False» and Unix seconds as text), and `cursor_path` is not complete (the same endpoint's cursor sits at output.data.nextCursor while the file says null):
 * `shapeReader.ts` never trusts one hint alone.
 */

export interface CatalogInput {
  name: string;
  in: string | null;
  type: string | null;
  required: boolean;
  enum: unknown[] | null;
  minimum: number | null;
  maximum: number | null;
  default: unknown;
  example: unknown;
  note: string | null;
}

export interface CatalogCost {
  unit: string | null;
  usd: number | null;
  type: string | null;
  currency: string | null;
  value: number | null;
  per: number | null;
  billing_note: string | null;
  failed_or_empty_billed: string | null;
}

export interface CatalogItemField { type: string; example: string }

export interface CatalogEndpoint {
  id: string;
  provider: string;
  platform: string;
  category: string | null;
  capability: string | null;
  name: string;
  summary: string | null;
  method: "GET" | "POST" | string;
  path: string;
  kind: "direct" | "routed" | string;
  tier: string | null;
  async: unknown;
  async_config: unknown;
  inputs: CatalogInput[];
  pagination: string[];
  cost: CatalogCost | null;
  observed: Record<string, unknown> | null;
  scope: string;
  cost_confidence: string | null;
  siblings: string[];
  test_request: Record<string, unknown> | null;
  /** The path of the result list in an answer, «root» for a bare array, «NOT FOUND» when the snapshot could not find one, null when it had no example. */
  list_path: string | null;
  cursor_path: string | null;
  item_fields: Record<string, CatalogItemField> | null;
  example_response_trimmed: unknown;
}

export interface TregCatalog {
  source: string;
  count: number;
  excluded: { own_account: number; write: number; paused: number };
  endpoints: CatalogEndpoint[];
  byId: ReadonlyMap<string, CatalogEndpoint>;
  /** The ids of the write actions (create, edit, delete, post, reply, send…): never sellable. */
  writeIds: ReadonlySet<string>;
}

/** Builds the catalog from the two parsed files. Pure (no file access), so tests can hand it a small snapshot. */
export function parseCatalog(snapshot: unknown, writeActions: unknown): TregCatalog {
  const s = snapshot as { source?: string; count?: number; excluded?: TregCatalog["excluded"]; endpoints?: CatalogEndpoint[] };
  if (!s || !Array.isArray(s.endpoints)) throw new Error("the catalog snapshot has no endpoints list");
  const byId = new Map<string, CatalogEndpoint>();
  for (const endpoint of s.endpoints) {
    if (!endpoint || typeof endpoint.id !== "string") throw new Error("a catalog endpoint has no id");
    if (byId.has(endpoint.id)) throw new Error(`duplicate catalog endpoint id ${endpoint.id}`);
    byId.set(endpoint.id, endpoint);
  }
  const writeIds = new Set<string>(Array.isArray(writeActions) ? (writeActions as Array<{ id?: string }>).map((w) => String(w?.id ?? "")).filter(Boolean) : []);
  return {
    source: String(s.source ?? ""),
    count: Number(s.count ?? byId.size),
    excluded: s.excluded ?? { own_account: 0, write: 0, paused: 0 },
    endpoints: s.endpoints,
    byId,
    writeIds,
  };
}

const cache = new Map<string, TregCatalog>();

/** Reads data/treg/ once per process (and per directory). No network. */
export function loadTregCatalog(options: { dir?: string } = {}): TregCatalog {
  const dir = options.dir ?? path.join(process.cwd(), "data", "treg");
  const hit = cache.get(dir);
  if (hit) return hit;
  const snapshot = JSON.parse(readFileSync(path.join(dir, "treg_catalog_sellable.json"), "utf-8"));
  const writes = JSON.parse(readFileSync(path.join(dir, "treg_write_actions.json"), "utf-8"));
  const catalog = parseCatalog(snapshot, writes);
  cache.set(dir, catalog);
  return catalog;
}

/** For tests: forgets what was read. */
export function clearTregCatalogCache(): void {
  cache.clear();
}

/**
 * May this endpoint be sold and called? Only an endpoint that is IN the sellable snapshot, is not a write action and is not an own-account endpoint. An id the
 * catalog does not know is not sellable (a model made it up, or it is an own-account or paused endpoint that was removed from the snapshot).
 */
export function isSellable(id: string, catalog: TregCatalog = loadTregCatalog()): boolean {
  const key = String(id ?? "").trim();
  if (!key || catalog.writeIds.has(key)) return false;
  const endpoint = catalog.byId.get(key);
  if (!endpoint) return false;
  if (String(endpoint.scope ?? "").toLowerCase() === "own_account") return false;
  const provider = String(endpoint.provider ?? "").toLowerCase();
  return !PAUSED_PROVIDERS.includes(provider) && !PAUSED_PROVIDERS.includes(key.split(".")[0].toLowerCase()); // paused providers (apollo, datagma) are blocked by name, as in the hard block list
}

/** The full catalog entry of a SELLABLE endpoint (inputs, cost, observed stats, siblings, test request, paths, example), or null. */
export function describeEndpoint(id: string, catalog: TregCatalog = loadTregCatalog()): CatalogEndpoint | null {
  return isSellable(id, catalog) ? catalog.byId.get(String(id).trim()) ?? null : null;
}

export interface CatalogHit {
  id: string;
  name: string;
  platform: string;
  category: string | null;
  capability: string | null;
  summary: string | null;
  method: string;
  score: number;
  costUsd: number | null;
  costUnit: string | null;
  kind: string;
  requiredInputs: string[];
  observedOkRate: number | null;
  observedSamples: number | null;
}

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

function tokens(text: string | null | undefined): string[] {
  return normalizeArabic(String(text ?? "")).split(WORD_SPLIT).filter(Boolean);
}

function scoreWord(word: string, e: CatalogEndpoint): number {
  let score = 0;
  const hit = (list: string[]) => list.includes(word) || (word.length >= 4 && list.some((t) => t.startsWith(word) || (t.length >= 4 && word.startsWith(t))));
  if (tokens(e.platform).includes(word)) score += 5;
  if (hit(tokens(e.capability))) score += 4;
  if (hit(tokens(e.name))) score += 3;
  if (hit(tokens(e.id))) score += 2;
  if (hit(tokens(e.category))) score += 1;
  if (hit(tokens(e.summary))) score += 1;
  return score;
}

function okRateOf(e: CatalogEndpoint): number | null {
  const v = (e.observed as { ok_rate?: unknown } | null)?.ok_rate;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function samplesOf(e: CatalogEndpoint): number | null {
  const v = (e.observed as { samples?: unknown } | null)?.samples;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Looks an endpoint up by platform and words (English words as the catalog writes them; the caller translates Arabic). Only SELLABLE endpoints are returned. Ranking: the words
 * found in the platform, capability, name, id, category and summary (in that order of weight), then core tier, then the observed success rate. A platform filter keeps
 * the endpoints of that platform only (case and Arabic-insensitive).
 */
export function catalogSearch(
  query: { platform?: string | null; words?: string[]; limit?: number },
  catalog: TregCatalog = loadTregCatalog(),
): CatalogHit[] {
  const platform = query.platform ? normalizeArabic(query.platform) : null;
  const words = (query.words ?? []).flatMap((w) => tokens(w));
  const limit = Math.max(1, Math.min(50, Math.floor(query.limit ?? 10)));
  const hits: Array<CatalogHit & { tierBonus: number }> = [];
  for (const e of catalog.endpoints) {
    if (!isSellable(e.id, catalog)) continue;
    if (platform && normalizeArabic(e.platform) !== platform) continue;
    let score = 0;
    for (const word of words) score += scoreWord(word, e);
    if (words.length > 0 && score === 0) continue;
    hits.push({
      id: e.id, name: e.name, platform: e.platform, category: e.category, capability: e.capability, summary: e.summary, method: e.method, score,
      costUsd: e.cost?.usd ?? null, costUnit: e.cost?.unit ?? null, kind: e.kind,
      requiredInputs: e.inputs.filter((i) => i.required).map((i) => i.name),
      observedOkRate: okRateOf(e), observedSamples: samplesOf(e),
      tierBonus: e.tier === "core" ? 1 : 0,
    });
  }
  // equal relevance: the core tier, then the observed success rate, then the CHEAPER call (a price of 0 is a routed wrapper whose price is a range: it is not «cheap»), then the id
  const price = (h: CatalogHit) => (h.costUsd !== null && h.costUsd > 0 ? h.costUsd : Number.POSITIVE_INFINITY);
  hits.sort((a, b) => b.score - a.score || b.tierBonus - a.tierBonus || (b.observedOkRate ?? 0) - (a.observedOkRate ?? 0) || price(a) - price(b) || a.id.localeCompare(b.id));
  return hits.slice(0, limit).map(({ tierBonus: _t, ...hit }) => hit);
}

/** The catalog price of one call or unit in USD; null when the snapshot has no price. A routed endpoint's price is a range the snapshot cannot state (cost 0 with a note). */
export function endpointCostUsd(e: CatalogEndpoint): number | null {
  const usd = e.cost?.usd;
  return typeof usd === "number" && Number.isFinite(usd) ? usd : null;
}
