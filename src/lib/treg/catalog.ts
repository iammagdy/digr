import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { normalizeArabic } from "../arabicNormalize";
import { PAUSED_PROVIDERS } from "./blockList";
import priceSync from "../../../data/treg/price_sync.json";
import { applyPriceSync } from "./priceSyncFile";
import { CATALOG_PRICE_REV } from "./priceRev";

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

export interface EndpointQuerySyntax {
  operators_supported: string[];
  operators_rejected: string[];
  notes: string | null;
}

export interface EndpointPaginationContract {
  cursor_in_param: string | null;
  cursor_out_path?: string | null;
  cursor_out_path_rest: string | null;
  cursor_out_path_mcp: string | null;
  mcp_cursor_out_path?: string | null;
  default_page_size: number | null;
  max_page_size: number | null;
  max_page_size_semantics: string | null;
  automated_paging_ready: boolean | null;
  stop_rule: string | null;
}

export interface EndpointAdapterContract {
  endpoint_id: string;
  best_for?: string | null;
  not_for?: string | null;
  query_syntax?: EndpointQuerySyntax;
  date_filter?: { supported: boolean | null; syntax: string | null; notes?: string | null } | null;
  pagination?: EndpointPaginationContract;
  results_path?: string | null;
  mcp_results_path?: string | null;
  dedupe_key?: string | null;
  row_entity_kind?: string | null;
  history_depth?: string | null;
  needs_session?: boolean;
  current_status?: "working" | "degraded" | "failing" | null;
  status_scope?: string | null;
  common_errors_and_fix?: Array<{ error: string; fix: string }>;
  billing?: {
    listed_usd_per_call?: number | null;
    actual_cost_varies?: boolean;
    settled_cost_mcp_field?: string;
    settled_cost_rest_header?: string;
    type?: string | null;
    value?: number | null;
    currency?: string | null;
    per?: number | null;
    unit?: string | null;
    source?: string | null;
    confidence?: string | null;
    note?: string | null;
    usd?: number | null;
  } | null;
  known_contract_discrepancies?: string[];
  [key: string]: unknown;
}

export interface CatalogNestedField {
  type: string;
  example?: unknown;
  note?: string;
}

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
  fields?: Record<string, CatalogNestedField>;
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
  adapter_contract?: EndpointAdapterContract | null;
}

export interface TregCatalog {
  source: string;
  count: number;
  excluded: { own_account: number; write: number; paused: number };
  endpoints: CatalogEndpoint[];
  byId: ReadonlyMap<string, CatalogEndpoint>;
  /** The ids of the write actions (create, edit, delete, post, reply, send…): never sellable. */
  writeIds: ReadonlySet<string>;
  withdrawnIds?: ReadonlySet<string>;
}

export function normalizePaginationContract(p: any): EndpointPaginationContract | undefined {
  if (!p || typeof p !== "object") return undefined;
  const cursor_out_rest = p.cursor_out_path_rest ?? p.cursor_out_path ?? null;
  const cursor_out_mcp = p.cursor_out_path_mcp ?? p.mcp_cursor_out_path ?? null;
  return {
    cursor_in_param: p.cursor_in_param ?? null,
    cursor_out_path: cursor_out_rest,
    cursor_out_path_rest: cursor_out_rest,
    cursor_out_path_mcp: cursor_out_mcp,
    mcp_cursor_out_path: cursor_out_mcp,
    default_page_size: typeof p.default_page_size === "number" ? p.default_page_size : (p.default_page_size === null ? null : 20),
    max_page_size: typeof p.max_page_size === "number" ? p.max_page_size : null,
    max_page_size_semantics: p.max_page_size_semantics ?? null,
    automated_paging_ready: typeof p.automated_paging_ready === "boolean" ? p.automated_paging_ready : null,
    stop_rule: p.stop_rule ?? null,
  };
}

export function normalizeQuerySyntax(q: any): EndpointQuerySyntax | undefined {
  if (!q || typeof q !== "object") return undefined;
  return {
    operators_supported: Array.isArray(q.operators_supported) ? q.operators_supported : [],
    operators_rejected: Array.isArray(q.operators_rejected) ? q.operators_rejected : [],
    notes: q.notes ?? null,
  };
}

export function normalizeAdapterContract(raw: any): EndpointAdapterContract {
  return {
    ...raw,
    endpoint_id: String(raw.endpoint_id),
    best_for: raw.best_for ?? null,
    not_for: raw.not_for ?? null,
    query_syntax: normalizeQuerySyntax(raw.query_syntax),
    date_filter: raw.date_filter ? {
      supported: typeof raw.date_filter.supported === "boolean" ? raw.date_filter.supported : null,
      syntax: raw.date_filter.syntax ?? null,
      notes: raw.date_filter.notes ?? null,
    } : null,
    pagination: normalizePaginationContract(raw.pagination),
    results_path: raw.results_path ?? null,
    mcp_results_path: raw.mcp_results_path ?? null,
    dedupe_key: raw.dedupe_key ?? null,
    row_entity_kind: raw.row_entity_kind ?? null,
    history_depth: raw.history_depth ?? null,
    needs_session: typeof raw.needs_session === "boolean" ? raw.needs_session : false,
    current_status: raw.current_status ?? null,
    status_scope: raw.status_scope ?? null,
    common_errors_and_fix: Array.isArray(raw.common_errors_and_fix) ? raw.common_errors_and_fix : [],
    billing: raw.billing ? {
      ...raw.billing,
      listed_usd_per_call: raw.billing.usd ?? raw.billing.listed_usd_per_call ?? raw.cost_per_call_usd ?? null,
      actual_cost_varies: raw.billing.actual_cost_varies ?? (raw.billing.type !== "fixed" && raw.billing.type !== "per_call"),
      settled_cost_mcp_field: raw.actual_treg_charge?.mcp_field ?? raw.billing.settled_cost_mcp_field,
      settled_cost_rest_header: raw.actual_treg_charge?.rest_header ?? raw.billing.settled_cost_rest_header,
    } : null,
    known_contract_discrepancies: Array.isArray(raw.known_contract_discrepancies) ? raw.known_contract_discrepancies : [],
  };
}

export function applyAdapterRegistry(catalog: TregCatalog, registryData: unknown): void {
  const data = registryData as { endpoints?: unknown[] } | undefined;
  if (!data || !Array.isArray(data.endpoints)) return;
  const contractMap = new Map<string, EndpointAdapterContract>();
  for (const raw of data.endpoints) {
    if (raw && typeof raw === "object" && typeof (raw as any).endpoint_id === "string") {
      contractMap.set((raw as any).endpoint_id, normalizeAdapterContract(raw));
    }
  }
  for (const endpoint of catalog.endpoints) {
    const contract = contractMap.get(endpoint.id);
    endpoint.adapter_contract = contract ?? null;
  }
}

/** Builds the catalog from the two parsed files. Pure (no file access), so tests can hand it a small snapshot. */
export function parseCatalog(snapshot: unknown, writeActions: unknown, adapterContracts?: unknown): TregCatalog {
  const s = snapshot as { source?: string; count?: number; excluded?: TregCatalog["excluded"]; endpoints?: CatalogEndpoint[] };
  if (!s || !Array.isArray(s.endpoints)) throw new Error("the catalog snapshot has no endpoints list");
  const byId = new Map<string, CatalogEndpoint>();
  for (const endpoint of s.endpoints) {
    if (!endpoint || typeof endpoint.id !== "string") throw new Error("a catalog endpoint has no id");
    if (byId.has(endpoint.id)) throw new Error(`duplicate catalog endpoint id ${endpoint.id}`);
    byId.set(endpoint.id, endpoint);
  }
  const writeIds = new Set<string>(Array.isArray(writeActions) ? (writeActions as Array<{ id?: string }>).map((w) => String(w?.id ?? "")).filter(Boolean) : []);
  const catalog: TregCatalog = {
    source: String(s.source ?? ""),
    count: Number(s.count ?? byId.size),
    excluded: s.excluded ?? { own_account: 0, write: 0, paused: 0 },
    endpoints: s.endpoints,
    byId,
    writeIds,
  };

  let contractsData = adapterContracts;
  if (contractsData === undefined) {
    const registryPath = path.join(process.cwd(), "data", "treg", "treg_research_endpoint_registry.json");
    try {
      if (existsSync(registryPath)) {
        contractsData = JSON.parse(readFileSync(registryPath, "utf-8"));
      }
    } catch {
      // ignore
    }
  }

  if (contractsData) {
    applyAdapterRegistry(catalog, contractsData);
  } else {
    for (const endpoint of catalog.endpoints) {
      if (endpoint.adapter_contract === undefined) {
        endpoint.adapter_contract = null;
      }
    }
  }

  return catalog;
}

/**
 * INPUTS THE PROVIDER ACCEPTS THAT THE ATTACHED SNAPSHOT DOES NOT LIST (round 8). The snapshot file is the owner's attached file and is pinned byte for byte (tests/treg-catalog-data.test.ts, data/treg/data_policy.json), so it is never edited; an input the gateway must keep
 * (it drops every input the catalog does not declare) is declared here, in code, once, and added to the typed catalog when it is loaded. `requireFields` of the X replies route: the provider's own answer to a page it cannot continue is to re-run with ["nextCursor"], to be served by a
 * source that can return a next-page cursor (it may cost more per request). Only the compiled plan of a TEST account sends it (toolCards/x.ts); the endpoint's catalog price is unchanged.
 */
export const DECLARED_EXTRA_INPUTS: Readonly<Record<string, ReadonlyArray<CatalogInput>>> = {
  "anyapi.x.post.comments": [
    { name: "requireFields", in: "body", type: "array", required: false, enum: null, minimum: null, maximum: null, default: null, example: ["nextCursor"], note: "Response fields the serving source must be able to return; [\"nextCursor\"] asks for a source that can return a next-page cursor (it may cost more per request). Set by the compiled plan of a test account only." },
  ],
};

/**
 * Nested object-field schemas omitted by the pinned catalog snapshot (D-0086):
 *  - Source of truth: data/treg/treg_catalog_sellable.json (describe pass 2026-10-27) marks `company` as `type: "object"`
 *    ("use a LinkedIn company URL to target a specific employer") without nested key types, and the file is SHA-256-pinned
 *    (tests/treg-catalog-data.test.ts) so it is never edited.
 *  - `company.fields.linkedin_url` (`array[string]`) comes from the provider's API validation contract / live upstream 422
 *    error (`company.linkedin_url: Expected an array, got a string`). Declared here as pure catalog metadata alongside
 *    DECLARED_EXTRA_INPUTS so toolDescribeEndpoint and validateInputShape remain 100% endpoint- and provider-agnostic.
 */
export const DECLARED_INPUT_SHAPES: Readonly<Record<string, Readonly<Record<string, { example?: unknown; fields?: Record<string, CatalogNestedField> }>>>> = {
  "blitzapi.people.search": {
    company: {
      example: { linkedin_url: ["https://www.linkedin.com/company/example"] },
      fields: {
        linkedin_url: { type: "array[string]", example: ["https://www.linkedin.com/company/example"] },
      },
    },
  },
};

function declareExtraInputs(catalog: TregCatalog): void {
  for (const [id, inputs] of Object.entries(DECLARED_EXTRA_INPUTS)) {
    const endpoint = catalog.byId.get(id);
    if (!endpoint) continue;
    for (const input of inputs) if (!endpoint.inputs.some((i) => i.name === input.name)) endpoint.inputs = [...endpoint.inputs, { ...input }].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  for (const [id, shapes] of Object.entries(DECLARED_INPUT_SHAPES)) {
    const endpoint = catalog.byId.get(id);
    if (!endpoint) continue;
    endpoint.inputs = endpoint.inputs.map((inp) => {
      const patch = shapes[inp.name];
      if (!patch) return inp;
      return {
        ...inp,
        ...(inp.example === null && patch.example !== undefined ? { example: patch.example } : {}),
        ...(patch.fields ? { fields: { ...(inp.fields ?? {}), ...patch.fields } } : {}),
      };
    });
  }
}

/**
 * STORED PRICES AND LIMITS THAT THE PINNED SNAPSHOT HAS WRONG (DT-20261119-11, D-0135/D-0137; DT-20261119-12 reuses this layer for the other stale prices). The snapshot is pinned byte for byte and never edited, so a corrected
 * value is declared here and applied when the catalog is loaded, to ONE endpoint object that every reader shares (the gateway's estimate, the price of a plan, the planner's ranking and what the model is told).
 * Each entry names the WHOLE tuple it expects (`was`: unit, price and the size input's default / minimum / maximum) and the tuple it sets (`now`). A snapshot that already holds `now` is left alone; one that holds anything else, or lacks the endpoint, THROWS
 * (a refreshed snapshot with a surprise must never leave a stale rate silently in force: a human decides, and the test of this layer fails first).
 */
export interface PriceTuple {
  unit: string | null;
  usd: number | null;
  /** The size input of the endpoint (by name): its default, minimum and maximum. */
  input?: { name: string; default: unknown; minimum: unknown; maximum: unknown };
}
export interface PriceCorrection { id: string; why: string; was: PriceTuple; now: PriceTuple }
export { CATALOG_PRICE_REV } from "./priceRev";
export const DECLARED_PRICE_CORRECTIONS: ReadonlyArray<PriceCorrection> = [
  { id: "findymail.search.employees", why: "TREG's live page: billed PER PERSON (1 credit per contact), `count` default 1, maximum 3; the snapshot says a per-call unit and no limits (D-0135)",
    was: { unit: "call", usd: 0.0198, input: { name: "count", default: null, minimum: null, maximum: null } }, now: { unit: "result", usd: 0.0198, input: { name: "count", default: 1, minimum: 1, maximum: 3 } } },
  ...["blitzapi.people.employee-finder", "blitzapi.people.search", "blitzapi.people.waterfall-icp"].map((id): PriceCorrection => ({ id, why: "TREG's live page and the 2026-11-14 provider sync: 0.001 USD per record (D-0135)", was: { unit: "record", usd: 0.000495 }, now: { unit: "record", usd: 0.001 } })),
];

const sameValue = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);
function tupleOf(e: CatalogEndpoint, input: PriceTuple["input"]): PriceTuple {
  const i = input ? e.inputs.find((x) => x.name === input.name) : undefined;
  return { unit: e.cost?.unit ?? null, usd: e.cost?.usd ?? null, ...(input ? { input: { name: input.name, default: i?.default ?? null, minimum: i?.minimum ?? null, maximum: i?.maximum ?? null } } : {}) };
}
const tuplesEqual = (a: PriceTuple, b: PriceTuple): boolean => sameValue(a.unit, b.unit) && sameValue(a.usd, b.usd) && (!b.input || (!!a.input && sameValue(a.input.default, b.input.default) && sameValue(a.input.minimum, b.input.minimum) && sameValue(a.input.maximum, b.input.maximum)));

/** Applies the corrections to a catalog object. Returns what happened per entry; throws on a missing endpoint or an unexpected tuple. Pure apart from the catalog it is given (tests pass a fresh parse). */
export function applyPriceCorrections(catalog: TregCatalog, corrections: ReadonlyArray<PriceCorrection> = DECLARED_PRICE_CORRECTIONS): Array<{ id: string; state: "applied" | "already_correct" }> {
  const out: Array<{ id: string; state: "applied" | "already_correct" }> = [];
  for (const c of corrections) {
    const e = catalog.byId.get(c.id);
    if (!e) throw new Error(`catalog price correction for ${c.id}: the endpoint is not in the snapshot`);
    const have = tupleOf(e, c.was.input);
    if (tuplesEqual(have, c.now) && !tuplesEqual(have, c.was)) { out.push({ id: c.id, state: "already_correct" }); continue; }
    if (!tuplesEqual(have, c.was)) throw new Error(`catalog price correction for ${c.id}: the snapshot holds ${JSON.stringify(have)}, expected ${JSON.stringify(c.was)} (or the corrected ${JSON.stringify(c.now)}): decide before the next load`);
    if (e.cost) e.cost = { ...e.cost, unit: c.now.unit, usd: c.now.usd };
    if (c.now.input) {
      const name = c.now.input.name;
      e.inputs = e.inputs.map((i) => (i.name === name ? { ...i, default: c.now.input!.default, minimum: c.now.input!.minimum as number | null, maximum: c.now.input!.maximum as number | null } : i));
    }
    out.push({ id: c.id, state: "applied" });
  }
  return out;
}

export const PINNED_PRICE_IDS: ReadonlySet<string> = new Set(DECLARED_PRICE_CORRECTIONS.map((entry) => entry.id));
export const SYNCED_PRICE_IDS: ReadonlySet<string> = new Set(priceSync.entries.map((entry: { id: string }) => entry.id));

const cache = new Map<string, TregCatalog>();
const defaultDir = () => path.join(process.cwd(), "data", "treg");

/** The immutable input to the runtime overlay and to each weekly rebuild. */
export function loadTregPriceBaseline(options: { dir?: string } = {}): TregCatalog {
  const dir = options.dir ?? defaultDir();
  const snapshot = JSON.parse(readFileSync(path.join(dir, "treg_catalog_sellable.json"), "utf-8"));
  const writes = JSON.parse(readFileSync(path.join(dir, "treg_write_actions.json"), "utf-8"));
  let adapterContracts: unknown = undefined;
  const regPath = path.join(dir, "treg_research_endpoint_registry.json");
  try {
    if (existsSync(regPath)) {
      adapterContracts = JSON.parse(readFileSync(regPath, "utf-8"));
    }
  } catch {
    // fallback
  }
  const catalog = parseCatalog(snapshot, writes, adapterContracts);
  declareExtraInputs(catalog);
  applyPriceCorrections(catalog);
  return catalog;
}

/** Loads the bundled overlay. The CLI supplies an explicit file to check proposed bytes cold. */
export function loadTregCatalog(options: { dir?: string; syncFile?: string } = {}): TregCatalog {
  const { dir = defaultDir(), syncFile } = options;
  const hit = syncFile === undefined ? cache.get(dir) : undefined;
  if (hit) return hit;
  const catalog = loadTregPriceBaseline({ dir });
  const overlay: unknown = syncFile === undefined ? priceSync : JSON.parse(readFileSync(syncFile, "utf-8"));
  const file = applyPriceSync(catalog, overlay, PINNED_PRICE_IDS);
  if (syncFile === undefined && file.revision !== CATALOG_PRICE_REV) throw new Error("catalog price revision disagrees with the price sync file");
  if (syncFile === undefined) cache.set(dir, catalog);
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
  if (!key || catalog.writeIds.has(key) || catalog.withdrawnIds?.has(key)) return false;
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
