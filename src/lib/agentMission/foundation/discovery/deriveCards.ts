import { isSellable, type CatalogEndpoint, type CatalogInput, type TregCatalog } from "../../../treg/catalog";
import { blockedEndpointReason } from "../../../treg/blockList";
import { policyVerdict, type AccountAccess } from "../../../treg/dataPolicy";
import { unitCost } from "../../../modelPlanner/pricing";
import { buildShapeDigest } from "../../../modelPlanner/digest";
import { isSocialPlatform } from "../../redesignFlagTypes";
import { TOOL_CARDS, cardOf } from "../toolCards";
import type { ToolCard } from "../toolCards/types";
import { COUNTRY_INPUT_NAMES, CURSOR_INPUT_NAMES, FIELD_SYNONYMS, HASHTAG_INPUT_NAMES, PERIOD_INPUT_PAIRS, QUERY_INPUT_NAMES, SOURCE_INPUT_NAMES, ruleOfCapability, type RoleRule } from "./roleGrammar";

/**
 * ROUND 33, CATALOG DISCOVERY: A TOOL CARD DERIVED FROM THE CATALOG'S OWN METADATA. The catalog (3,276 endpoints) says, for an endpoint, its capability, its inputs, its price, how often it really answered, where its list and its cursor are and which fields an item has. Code (never a model) turns that into a
 * card the compiler can use, or into a REJECTION WITH A REASON when the metadata is not enough to map the answer without guessing. Nothing here calls a provider.
 * A derived card is always `catalog_only` (owner decision 7.4: test accounts only, inside the 0.20 USD cap), is never preferred to a hand-verified card with the same conditions, and is never created for an endpoint that already has a hand-written card.
 */
export type RejectReason =
  | "not_social" | "no_role" | "not_sellable" | "blocked" | "sensitive" | "async" | "cost_unknown" | "no_observed_evidence" | "low_success"
  | "no_list_path" | "no_item_fields" | "no_id_field" | "no_query_input" | "no_source_input" | "unsatisfied_required_input" | "has_hand_card";
export interface Rejection { endpointId: string; capability: string | null; reason: RejectReason; detail?: string }
export type Derivation = { ok: true; card: ToolCard } | { ok: false; rejection: Rejection };

/** What the catalog must say about how often the tool answered before a card is derived from it (the catalog's own counters, real calls made by the provider's whole customer base: evidence about the tool, not about this mapping). */
export const MIN_OBSERVED_SAMPLES = 100;
export const MIN_OBSERVED_OK_RATE = 0.9;

const inputOf = (e: CatalogEndpoint, names: ReadonlyArray<string>): CatalogInput | null => { for (const n of names) { const i = e.inputs.find((x) => x.name === n); if (i) return i; } return null; };
const hasInput = (e: CatalogEndpoint, name: string): boolean => e.inputs.some((i) => i.name === name);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const reject = (e: CatalogEndpoint, reason: RejectReason, detail?: string): Derivation => ({ ok: false, rejection: { endpointId: e.id, capability: e.capability, reason, ...(detail ? { detail } : {}) } });

export function deriveCard(e: CatalogEndpoint, catalog: TregCatalog, access: AccountAccess): Derivation {
  if (!isSocialPlatform(e.platform)) return reject(e, "not_social");
  const rule: RoleRule | null = ruleOfCapability(e.capability);
  if (!rule) return reject(e, "no_role");
  if (cardOf(e.id, TOOL_CARDS)) return reject(e, "has_hand_card");
  if (!isSellable(e.id, catalog)) return reject(e, "not_sellable");
  if (blockedEndpointReason(e.id, e.scope)) return reject(e, "blocked");
  if (!policyVerdict(e.id, access).allowed) return reject(e, "sensitive");
  if (e.async) return reject(e, "async");
  // THE PRICE: one successful call has a catalog price (a record-priced or unpriced endpoint is never derived: its page cost cannot be bounded from the catalog alone)
  const cost = unitCost(e, catalog);
  if (!cost || cost.unit !== "call") return reject(e, "cost_unknown", cost ? `unit ${cost.unit}` : undefined);
  const samples = num((e.observed as Record<string, unknown> | null)?.samples);
  const okRate = num((e.observed as Record<string, unknown> | null)?.ok_rate);
  const hitRate = num((e.observed as Record<string, unknown> | null)?.hit_rate);
  if (samples === null || samples < MIN_OBSERVED_SAMPLES) return reject(e, "no_observed_evidence");
  if (okRate === null || okRate < MIN_OBSERVED_OK_RATE) return reject(e, "low_success", String(okRate));
  // THE ANSWER'S SHAPE: the list path and the item's fields must be in the catalog. «NOT FOUND» or null is a refusal to guess (a mapping written from nothing would deliver empty or wrong columns)
  if (!e.list_path || e.list_path === "NOT FOUND") return reject(e, "no_list_path");
  if (!e.item_fields || Object.keys(e.item_fields).length === 0) return reject(e, "no_item_fields");
  const fields = e.item_fields;
  const pick = (key: string): string | null => FIELD_SYNONYMS[key]?.find((k) => Object.prototype.hasOwnProperty.call(fields, k)) ?? null;
  const idKey = pick("id");
  if (!idKey) return reject(e, "no_id_field");

  // THE INPUTS: the keyword (a search) or the source (a listing), the cursor, the period, the country. Every other REQUIRED input must have a default (nothing is invented for it)
  const queryInput = rule.takes === "keyword" ? inputOf(e, QUERY_INPUT_NAMES) : null;
  if (rule.takes === "keyword" && !queryInput) return reject(e, "no_query_input");
  const sourceInput = rule.takes === "source" ? inputOf(e, SOURCE_INPUT_NAMES[rule.source!]) : null;
  if (rule.takes === "source" && !sourceInput) return reject(e, "no_source_input");
  // THE PAGING INPUT: what the catalog lists as the endpoint's pagination, when it reaches the NEXT answer: a cursor or token by name, or a page number whose next value the catalog's own `cursor_path` gives (scrapecreators: pagination «page», answer field `next_page`). A SIZE input («limit», «count») only sizes one answer:
  // crawl4ai lists «limit» as its pagination, which is no way to the next page. Else a cursor-like input by name.
  const SIZE_NAMES = new Set(["limit", "count", "size", "page_size", "per_page", "num", "max_results", "n"]);
  const isCursorName = (n: string): boolean => CURSOR_INPUT_NAMES.includes(n) || /cursor|continuation|page_?token|next_?page/i.test(n);
  const cursorName = (e.pagination ?? []).find((p) => hasInput(e, p) && !SIZE_NAMES.has(p) && (isCursorName(p) || Boolean(e.cursor_path))) ?? CURSOR_INPUT_NAMES.find((n) => hasInput(e, n)) ?? null;
  const periodPair = PERIOD_INPUT_PAIRS.find(([a, b]) => hasInput(e, a) && hasInput(e, b)) ?? null;
  const countryInput = inputOf(e, COUNTRY_INPUT_NAMES);
  // a search for videos is asked for videos only when the catalog says that input takes «video» (YouTube's general search also returns channels and playlists)
  const typeInput = rule.role === "videos.search" ? e.inputs.find((i) => (i.name === "type" || i.name === "search_type") && (Array.isArray(i.enum) ? i.enum.includes("video") : /(?:^|[|,\s])video(?:$|[|,\s])/.test(String(i.note ?? "")))) : undefined;
  const taken = new Set<string>([queryInput?.name, sourceInput?.name, cursorName, periodPair?.[0], periodPair?.[1], countryInput?.name, typeInput?.name].filter((x): x is string => typeof x === "string"));
  const unsatisfied = e.inputs.find((i) => i.required && !taken.has(i.name) && (i.default === null || i.default === undefined));
  if (unsatisfied) return reject(e, "unsatisfied_required_input", unsatisfied.name);

  // THE CURSOR'S PLACE: the catalog's `cursor_path`; when it is null, the place the shape reader finds in the catalog's own example answer (anyapi's listing keeps it at output.data.nextCursor while the file says null); else the paging is UNKNOWN (one page, said so)
  let cursorPath: string[] | null = e.cursor_path ? e.cursor_path.split(".") : null;
  let rowsInExample = 0;
  try {
    const read = buildShapeDigest(e.example_response_trimmed, e);
    if (!cursorPath && read.digest.nextCursorPath && cursorName) cursorPath = read.digest.nextCursorPath.split(".");
    rowsInExample = read.digest.rowsInSample;
  } catch { /* the example could not be read: the page size stays 1 (the pessimistic price) */ }
  const paging: "declared" | "unknown" = cursorName !== null && cursorPath !== null ? "declared" : "unknown";

  // THE MAPPING: only keys the catalog lists, by the synonyms table; a key the catalog does not list is simply not a column (the file says «غير متاح»), never a guess
  const map: Record<string, string[]> = { id: [idKey] };
  for (const key of ["text", "author", "posted_at", "published", "link", "likes", "comments", "shares", "views", "channel_id"]) { const k = pick(key); if (k) map[key] = [k]; }
  // a counter the catalog types as a STRING is written as a number only when the catalog's own example of it is digits («489»); «14,943,780 views» is kept as the source wrote it (a number read out of it would be a guess)
  const numeric = Object.entries(map).filter(([key, p]) => ["likes", "comments", "shares", "views"].includes(key) && fields[p[0]]?.type === "string" && /^\d+$/.test(String(fields[p[0]]?.example ?? ""))).map(([key]) => key);
  // the link keeps its query string when the catalog's own example of the link has one (YouTube: `watch?v=ID`: without it the link opens no video)
  const keepLinkQuery = map.link !== undefined && /[?]/.test(String(fields[map.link[0]]?.example ?? ""));
  const counter = map.comments && fields[map.comments[0]]?.type === "number" ? { key: "comments", counts: "comments" as const } : null;
  const cannot: NonNullable<ToolCard["cannot"]> = [
    ...(rule.takes === "keyword" ? [] : (["topic"] as const)),
    ...(periodPair ? [] : (["period"] as const)),
    ...(countryInput ? [] : (["country"] as const)),
    "language", "order",
  ];
  const hashtag = queryInput ? HASHTAG_INPUT_NAMES.includes(queryInput.name) : false;
  const card: ToolCard = {
    endpointId: e.id,
    platform: e.platform as ToolCard["platform"],
    role: rule.role,
    status: "catalog_only",
    inputs: {
      ...(queryInput ? { query: { field: queryInput.name, ...(queryInput.required ? { required: true as const } : {}), ...(hashtag ? { format: "hashtag" as const } : {}) } } : {}),
      ...(periodPair ? { period: { from: periodPair[0], to: periodPair[1] } } : {}),
      ...(sourceInput ? { source: { param: sourceInput.name, kind: rule.source! } } : {}),
      ...(countryInput ? { country: { field: countryInput.name } } : {}),
      cursor: cursorName,
      ...(typeInput ? { fixed: { [typeInput.name]: "video" } } : {}),
    },
    page: { list: e.list_path === "root" ? [] : e.list_path.split("."), cursor: cursorPath, observedRowsPerPage: Math.max(1, rowsInExample) },
    mapping: { kind: "fields", fields: map, ...(numeric.length > 0 ? { numeric } : {}), ...(keepLinkQuery ? { keepLinkQuery: true as const } : {}) },
    counter,
    costUsdPerPage: cost.usd,
    verifiedOn: [],
    cannot,
    derived: { from: "catalog", observed: { samples, okRate, hitRate }, paging },
  };
  return { ok: true, card };
}

export interface Discovered { cards: ToolCard[]; rejected: Rejection[] }
const cache = new WeakMap<TregCatalog, Map<string, Discovered>>();

/** Every card the catalog supports for a platform, and every endpoint of the platform's roles that it does not (with the reason). Cached per catalog; a different account access is a different key (sensitivity is decided per account). */
export function discoverCards(catalog: TregCatalog, platform: string, access: AccountAccess): Discovered {
  const key = `${platform}|${access.isAdmin ? 1 : 0}${access.verifiedBusiness ? 1 : 0}`;
  let per = cache.get(catalog);
  if (!per) { per = new Map(); cache.set(catalog, per); }
  const hit = per.get(key);
  if (hit) return hit;
  const out: Discovered = { cards: [], rejected: [] };
  for (const e of catalog.endpoints) {
    if (e.platform !== platform || !ruleOfCapability(e.capability)) continue;
    const d = deriveCard(e, catalog, access);
    if (d.ok) out.cards.push(d.card); else out.rejected.push(d.rejection);
  }
  per.set(key, out);
  return out;
}
