import type { CatalogEndpoint, TregCatalog } from "../../../src/lib/treg/catalog";
import { endpointCostUsd, isSellable } from "../../../src/lib/treg/catalog";
import { PER_CALL_UNITS, PER_RECORD_UNITS, unitCost } from "../../../src/lib/modelPlanner/pricing";
import { blockedEndpointReason } from "../../../src/lib/treg/blockList";
import { policyVerdict, type AccountAccess } from "../../../src/lib/treg/dataPolicy";
import { PEOPLE_OF_COMPANY_CAPABILITIES } from "../../../src/lib/agentMission/childSources";
import { PHONE_CAPABILITIES } from "../../../src/lib/agentMission/peopleCheck";
import { EMAIL_FINDER_CAPABILITIES } from "../../../src/lib/agentMission/contactSampling";
import productionEligible from "../../../data/capabilities/production-eligible.json";
import { WEB_SOURCES } from "../../../src/lib/agentMission/sources";
import type { WebAvailability } from "../../../src/lib/agentMission/webAvailability";
import { PLATFORM_AR } from "../../../src/lib/agentMission/platformLabels";
import { getCircuitBreaker, type EndpointCircuitBreaker } from "../../../src/lib/treg/circuitBreaker";
import { getMultiProviderContracts, type MultiProviderContract } from "../../../src/lib/multiProvider/catalog";
import endpointMetadataOverlay from "../../../data/treg/endpoint_metadata_overlay.json";

/** The endpoints Diger has proven on stored real pages and in production (the reviewed list): ranked first and marked for the model. */
const PROVEN: ReadonlySet<string> = new Set(((productionEligible as { ids?: unknown }).ids as string[] | undefined) ?? []);
export const isProven = (id: string): boolean => PROVEN.has(id);

/**
 * THE CATALOG AS THE PLANNING MODEL READS IT (LLM-first planner, 15 Nov 2026). The model, not code, decides what the customer means and which tool serves it; code decides only what the model may SEE:
 * endpoints that are sellable, not on the block list and allowed for this account by the data policy. Nothing here reads the customer's words.
 */

/** Families that produce media rather than collect data: never offered to a data request. */
const MEDIA_GEN_PLATFORMS: ReadonlySet<string> = new Set(["image-gen", "video-gen", "voice-gen", "music-gen"]);
export const isMediaGen = (e: CatalogEndpoint): boolean =>
  MEDIA_GEN_PLATFORMS.has(e.platform) || /(^|\.)(image|video|voice|music)-gen(\.|$)/.test(capabilityOf(e));

const pollEndpointsCache = new WeakMap<TregCatalog, Set<string>>();

export function getPollEndpoints(catalog: TregCatalog): Set<string> {
  let s = pollEndpointsCache.get(catalog);
  if (!s) {
    s = new Set<string>();
    for (const e of catalog.endpoints) {
      const pollEp = (e.async_config as { poll?: { endpoint?: string } } | null | undefined)?.poll?.endpoint;
      if (pollEp) s.add(pollEp);
    }
    pollEndpointsCache.set(catalog, s);
  }
  return s;
}

export const isPollOnlyEndpoint = (e: CatalogEndpoint, catalog: TregCatalog): boolean =>
  getPollEndpoints(catalog).has(e.id) || /-task-get(-|$)/.test(e.id);

const hasSupportedUnit = (e: CatalogEndpoint): boolean => {
  const u = String(e.cost?.unit ?? "").toLowerCase();
  return PER_RECORD_UNITS.has(u) || PER_CALL_UNITS.has(u);
};

export const isDocumentedFreeEndpoint = (e: CatalogEndpoint): boolean =>
  e.cost?.type === "free" && endpointCostUsd(e) === 0 && hasSupportedUnit(e);

export const hasUsablePrice = (e: CatalogEndpoint, catalog: TregCatalog): boolean =>
  unitCost(e, catalog) !== null || isDocumentedFreeEndpoint(e);

export const hasSupportedAsync = (e: CatalogEndpoint, catalog: TregCatalog): boolean => {
  if (!e.async_config) return true;
  const pollEp = (e.async_config as { poll?: { endpoint?: string } } | null | undefined)?.poll?.endpoint;
  const poll = pollEp ? catalog.byId.get(pollEp) : undefined;
  return Boolean(pollEp && poll && isSellable(pollEp, catalog) && hasUsablePrice(poll, catalog));
};

export const isAsyncTask = (e: CatalogEndpoint): boolean =>
  (Boolean(e.async) || Boolean(e.async_config) || /-task-(post|get)(-|$)/.test(e.id)) &&
  !(Boolean((e.async_config as any)?.poll?.endpoint));

export const usableEndpoint = (e: CatalogEndpoint, catalog: TregCatalog, access: AccountAccess | null): boolean =>
  !isMediaGen(e) &&
  !isPollOnlyEndpoint(e, catalog) &&
  hasSupportedAsync(e, catalog) &&
  isSellable(e.id, catalog) &&
  hasUsablePrice(e, catalog) &&
  !blockedEndpointReason(e.id, e.scope ?? null) &&
  policyVerdict(e.id, access).allowed;

/** The capability of an endpoint, or a name made from its id when the catalog gave none (`platform.other`). */
export const capabilityOf = (e: CatalogEndpoint): string => (e.capability && e.capability.trim() !== "" ? e.capability : `${e.platform}.other`);

/** One line per platform: the platform key and the capabilities the account may use there, with how many tools serve each. */
export function platformIndex(catalog: TregCatalog, access: AccountAccess | null): string {
  const byPlatform = new Map<string, Map<string, number>>();
  for (const e of catalog.endpoints) {
    if (!usableEndpoint(e, catalog, access)) continue;
    const caps = byPlatform.get(e.platform) ?? new Map<string, number>();
    const cap = capabilityOf(e);
    caps.set(cap, (caps.get(cap) ?? 0) + 1);
    byPlatform.set(e.platform, caps);
  }
  return [...byPlatform.entries()]
    .sort((a, b) => sizeOf(b[1]) - sizeOf(a[1]))
    .map(([p, caps]) => `${p}: ${PLATFORM_AR[p] ? `(${PLATFORM_AR[p]}) ` : ""}${[...caps.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([c, n]) => `${c.startsWith(`${p}.`) ? c.slice(p.length + 1) : c}(${n})`).join(", ")}`)
    .join("\n");
}
const sizeOf = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

/** The usable capabilities of a platform (full names). */
export function capabilitiesOf(catalog: TregCatalog, access: AccountAccess | null, platform: string): Set<string> {
  return new Set(catalog.endpoints.filter((e) => e.platform === platform && usableEndpoint(e, catalog, access)).map(capabilityOf));
}

/** The platforms the catalog serves for this account. */
export function platformsOf(catalog: TregCatalog, access: AccountAccess | null): Set<string> {
  return new Set(catalog.endpoints.filter((e) => usableEndpoint(e, catalog, access)).map((e) => e.platform));
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** How the catalog's own measurements rank an endpoint: success rate first, then how often it returned rows, then price. Higher is better. */
export function reliabilityOf(e: CatalogEndpoint): number {
  const o = e.observed ?? {};
  const ok = num(o.ok_rate) ?? 0.5;
  const hit = num(o.hit_rate) ?? 0.5;
  const samples = num(o.samples) ?? 0;
  const lastOkDays = num(o.last_ok_days);
  const stale = lastOkDays !== null && lastOkDays > 14 ? 0.5 : 1;
  return (PROVEN.has(e.id) ? 1 : 0) + (ok * 0.6 + hit * 0.4) * stale * (samples > 100 ? 1 : samples > 0 ? 0.9 : 0.8);
}

export const callUsdOf = (e: CatalogEndpoint, catalog?: TregCatalog): number => {
  if (isDocumentedFreeEndpoint(e)) return 0;
  if (catalog) {
    const c = unitCost(e, catalog);
    if (c) return c.usd;
  }
  const usd = endpointCostUsd(e);
  return usd !== null && usd > 0 ? usd : 0;
};

/** The candidates of one capability (and, when it has few, the platform's other tools), best first, at most `max`. */
/**
 * SEARCH ENGINES ARE INTERCHANGEABLE for a search the customer did not tie to one engine (live, 16 Nov 2026: «آخر ٢٠ خبر عن الذكاء الاصطناعي في السعودية» was planned on the web news tools only, whose
 * one working tool gave 5 items a call and ran dry at 15, while two Google News tools of the catalog answered 70 and 92 items for another news request the same hour). A search step on one of these
 * platforms also gets the other engines' tools of the same kind (news with news, organic results with organic results).
 */
export const SEARCH_ENGINE_PLATFORMS: ReadonlySet<string> = new Set(["web", "google", "bing", "yahoo", "duckduckgo", "yandex", "naver", "seznam", "baidu"]);
const isSearchKind = (capability: string): boolean => /(^|\.)(search|serp|news|organic|articles?)(\.|$)/.test(capability);
const kindOf = (capability: string): string => (/(^|\.)news(\.|$)/.test(capability) ? "news" : /(^|\.)(organic|search)$/.test(capability) || /serp\.organic/.test(capability) ? "organic" : capability.split(".").pop() ?? "");

/**
 * THE DIRECT WEB TOOLS (shaped from WEB_SOURCES metadata), shaped as catalog entries so the planning model reads and fills them like any other tool. Offered only when the worker
 * has their key. Their names never reach the customer: the card says «الويب» / «مواقع الأخبار», and every customer sentence passes the customer-text check.
 */
export function directWebEndpoints(available: { firecrawl?: boolean; contextdev?: boolean } | WebAvailability | null | undefined): CatalogEndpoint[] {
  if (!available) return [];
  const searchSources = WEB_SOURCES.filter((s) => s.kind === "search" && Boolean((available as Record<string, boolean>)[s.provider])).sort((a, b) => a.usdPerCall - b.usdPerCall);
  const inputs = [
    { name: "query", in: "body", type: "string", required: true, enum: null, minimum: null, maximum: null, default: null, example: "أسعار الذهب في مصر", note: "a plain search phrase in the language of the pages wanted; no operators" },
    { name: "limit", in: "body", type: "integer", required: false, enum: null, minimum: 10, maximum: 30, default: 10, example: 30, note: "results per call (10 to 30)" },
    { name: "country", in: "body", type: "string", required: false, enum: null, minimum: null, maximum: null, default: null, example: "SA", note: "two-letter country code of the results, only when the customer named a country" },
  ];
  return searchSources.map((s) => ({
    id: s.id,
    provider: s.provider,
    platform: s.platform,
    category: "SEO/AEO",
    capability: s.capability ?? "web.search",
    name: "Web search",
    method: "POST",
    path: "",
    kind: "direct",
    tier: "core",
    async: null,
    async_config: null,
    summary: s.summary,
    inputs,
    pagination: [],
    cost: { unit: "call", usd: s.usdPerCall, type: null, currency: "USD", value: null, per: null, billing_note: null, failed_or_empty_billed: null },
    observed: { ok_rate: 0.97, hit_rate: 0.95, samples: 200 },
    scope: "public",
    item_fields: { title: { type: "string", example: "" }, url: { type: "string", example: "" }, description: { type: "string", example: "" } },
    item_noun_ar: (endpointMetadataOverlay as Record<string, any>)[s.id]?.item_noun_ar,
  })) as unknown as CatalogEndpoint[];
}

let multiEndpointsCache: CatalogEndpoint[] | null = null;
export function multiProviderEndpoints(): CatalogEndpoint[] {
  if (multiEndpointsCache) return multiEndpointsCache;
  const contracts = getMultiProviderContracts();
  multiEndpointsCache = contracts.map((c) => {
    const inputs: any[] = [];
    if (c.inputs_schema && (c.inputs_schema as any).properties) {
      for (const [name, prop] of Object.entries((c.inputs_schema as any).properties)) {
        inputs.push({
          name,
          in: (prop as any).in ?? "body",
          type: (prop as any).type ?? "string",
          required: Boolean((Array.isArray((c.inputs_schema as any)?.required) && (c.inputs_schema as any).required.includes(name)) || (prop as any).required),
          enum: null,
          minimum: (prop as any).minimum ?? null,
          maximum: (prop as any).maximum ?? null,
          default: (prop as any).default ?? null,
          example: null,
          note: (prop as any).note ?? null,
        });
      }
    }
    return {
      id: c.endpoint_id,
      provider: c.provider,
      platform: c.platform,
      category: c.category ?? null,
      capability: c.capability,
      name: c.endpoint_id,
      summary: c.category ?? c.endpoint_id,
      method: "POST",
      path: "",
      kind: "direct",
      tier: "core",
      async: null,
      async_config: null,
      inputs,
      pagination: c.pagination?.page_size_param ? [c.pagination.page_size_param] : [],
      cost: {
        unit: c.cost?.unit ?? "call",
        usd: c.cost?.usd ?? 0,
        type: null,
        currency: c.cost?.currency ?? "USD",
        value: null,
        per: null,
        billing_note: null,
        failed_or_empty_billed: null,
      },
      observed: c.observed ?? { ok_rate: 0.98, hit_rate: 0.95, samples: 100 },
      scope: "public",
      cost_confidence: null,
      siblings: [],
      test_request: null,
      list_path: c.outputs_schema?.list_path ?? null,
      cursor_path: c.outputs_schema?.cursor_path ?? null,
      item_fields: (c.outputs_schema?.item_fields as Record<string, any>) ?? null,
      example_response_trimmed: c.outputs_schema?.example_response_trimmed ?? null,
      adapter_contract: c as unknown as any,
      capability_tags: c.capability_tags ?? [],
      item_noun_ar: (endpointMetadataOverlay as Record<string, any>)[c.endpoint_id]?.item_noun_ar,
    } as unknown as CatalogEndpoint;
  });
  return multiEndpointsCache;
}

export function capabilityTagsOf(e: CatalogEndpoint): string[] {
  const set = new Set<string>();
  if (e.capability) set.add(e.capability.toLowerCase().trim());
  const tags = (e as any).capability_tags ?? (e.adapter_contract as any)?.capability_tags;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (typeof t === "string" && t.trim() !== "") set.add(t.toLowerCase().trim());
    }
  }
  return Array.from(set);
}

export function candidatesFor(catalog: TregCatalog, access: AccountAccess | null, platform: string, capability: string, max = 8, options: { alsoSearch?: boolean; hasSource?: boolean; web?: ReadonlyArray<CatalogEndpoint>; circuitBreaker?: EndpointCircuitBreaker } = {}): CatalogEndpoint[] {
  const cb = options.circuitBreaker ?? getCircuitBreaker();
  const rank = (a: CatalogEndpoint, b: CatalogEndpoint): number => reliabilityOf(b) - reliabilityOf(a) || callUsdOf(a, catalog) - callUsdOf(b, catalog);
  const base = tregCandidatesFor(catalog, access, platform, capability, max, options);

  const normCap = capability.toLowerCase().trim();
  const mpEndpoints = multiProviderEndpoints().filter(
    (e) => cb.isAvailable(e.id) && capabilityTagsOf(e).some((t) => t === normCap || t.endsWith(`.${normCap}`) || normCap.endsWith(`.${t}`))
  );

  if (isSearchKind(capability)) {
    const kind = kindOf(capability);
    const others = catalog.endpoints.filter((e) => e.platform !== platform && (SEARCH_ENGINE_PLATFORMS.has(e.platform) || isSearchKind(capabilityOf(e))) && !base.includes(e) && usableEndpoint(e, catalog, access) && cb.isAvailable(e.id) && kindOf(capabilityOf(e)) === kind && isSearchKind(capabilityOf(e))).sort(rank).slice(0, 3);
    const web = [...(options.web ?? [])];
    const mpSearch = mpEndpoints.filter((e) => !base.some((b) => b.id === e.id) && !web.some((w) => w.id === e.id));
    const extra = [...others, ...mpSearch];
    return [...base.slice(0, Math.max(3, max + 2 - (extra.length + web.length))), ...extra, ...web];
  }

  // Cross-provider capability tag matching: include matching endpoints across all 3 providers
  const combined = [...base];
  for (const mp of mpEndpoints) {
    if (!combined.some((c) => c.id === mp.id)) {
      combined.push(mp);
    }
  }

  // For entity or company research, or when shortfall/alsoSearch: allow multi-provider site.map / page.read / people.search
  if (platform === "entity" || platform === "company" || options.alsoSearch || options.hasSource || combined.length === 0) {
    for (const mp of mpEndpoints) {
      if (!combined.some((c) => c.id === mp.id)) {
        combined.push(mp);
      }
    }
  }

  return combined.sort(rank).slice(0, max);
}

let registryFallbackGroups: Map<string, string> | null = null;
function fallbackGroupOf(e: CatalogEndpoint): string | null {
  if (typeof (e as any).fallback_group === "string" && (e as any).fallback_group.trim() !== "") {
    return (e as any).fallback_group;
  }
  if (typeof (e as any).operation === "string" && (e as any).operation.trim() !== "") {
    return `${(e as any).operation}:${e.platform}`;
  }
  if (!registryFallbackGroups) {
    registryFallbackGroups = new Map();
    try {
      const reg = require("../../../data/capabilities/registry.json");
      if (Array.isArray(reg?.capabilities)) {
        for (const c of reg.capabilities) {
          if (c.id && c.fallback_group) {
            registryFallbackGroups.set(c.id, c.fallback_group);
          }
        }
      }
    } catch { /* if not available, empty */ }
  }
  return registryFallbackGroups.get(e.id) ?? null;
}

function tregCandidatesFor(catalog: TregCatalog, access: AccountAccess | null, platform: string, capability: string, max = 8, options: { alsoSearch?: boolean; hasSource?: boolean; circuitBreaker?: EndpointCircuitBreaker } = {}): CatalogEndpoint[] {
  const cb = options.circuitBreaker ?? getCircuitBreaker();
  const usable = catalog.endpoints.filter((e) => e.platform === platform && usableEndpoint(e, catalog, access) && cb.isAvailable(e.id));
  const exact = usable.filter((e) => capabilityOf(e) === capability);
  const rank = (a: CatalogEndpoint, b: CatalogEndpoint): number => reliabilityOf(b) - reliabilityOf(a) || callUsdOf(a, catalog) - callUsdOf(b, catalog);
  const chosen = [...exact].sort(rank).slice(0, max);
  if (chosen.length >= 3 && !options.alsoSearch && !options.hasSource) return chosen;
  // when a step has a source or alsoSearch: put all usable endpoints of the step's operation / fallback_group in front of the model
  if (options.alsoSearch || options.hasSource) {
    const group = exact.map(fallbackGroupOf).find(Boolean) ?? (exact[0] ? fallbackGroupOf(exact[0]) : null);
    const related = group
      ? usable.filter((e) => !chosen.includes(e) && fallbackGroupOf(e) === group).sort(rank)
      : usable.filter((e) => !chosen.includes(e)).sort(rank);
    return [...chosen, ...related].sort(rank).slice(0, max);
  }
  // a capability the catalog names differently (or did not name): the same platform's tools whose capability shares the last word (posts, comments, replies …)
  const last = capability.split(".").pop() ?? "";
  const near = usable.filter((e) => !chosen.includes(e) && last !== "" && capabilityOf(e).split(".").pop() === last).sort(rank);
  // the same platform's tools the catalog gave NO capability (`<platform>.other`) whose id names the items (live, 16 Nov 2026: the one Amazon reviews tool timed out three times while «amazon-get-product-top-reviews» sat unnamed)
  const stem = last.replace(/ies$/, "y").replace(/s$/, "");
  const unnamed = stem.length >= 4 ? usable.filter((e) => !chosen.includes(e) && !near.includes(e) && capabilityOf(e) === `${platform}.other` && e.id.toLowerCase().includes(stem)).sort(rank) : [];
  return [...chosen, ...near, ...unnamed].slice(0, max);
}

const clip = (s: unknown, n: number): string => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** One endpoint as the model reads it to choose and fill it: what it does, every input with its type, limits and note, how it pages, what an item carries, what one call costs. */
export function describeForModel(e: CatalogEndpoint, catalog?: TregCatalog): Record<string, unknown> {
  const cat = catalog && typeof catalog === "object" && "byId" in catalog ? catalog : undefined;
  const o = e.observed ?? {};
  const isAsync = Boolean((e.async_config as any)?.poll?.endpoint);
  return {
    id: e.id,
    capability: capabilityOf(e),
    what: clip(e.summary ?? e.name, 400),
    ...(isAsync ? { is_async: true } : {}),
    inputs: e.inputs.map((i) => ({
      name: i.name, type: i.type, required: i.required,
      ...(Array.isArray(i.enum) && i.enum.length > 0 ? { enum: i.enum.slice(0, 20) } : {}),
      ...(i.minimum !== null && i.minimum !== undefined ? { min: i.minimum } : {}),
      ...(i.maximum !== null && i.maximum !== undefined ? { max: i.maximum } : {}),
      ...(i.default !== null && i.default !== undefined ? { default: i.default } : {}),
      ...(i.example !== null && i.example !== undefined ? { example: i.example } : {}),
      ...(i.fields ? { fields: i.fields } : {}),
      ...(i.note ? { note: clip(i.note, 450) } : {}),
    })),
    paging_inputs: e.pagination ?? [],
    item_fields: e.item_fields ? Object.keys(e.item_fields).slice(0, 40) : null,
    usd_per_call: callUsdOf(e, cat),
    cost_unit: e.cost?.unit ?? null,
    ...(PROVEN.has(e.id) ? { proven_in_production: true } : {}),
    measured: { ok_rate: num(o.ok_rate), returns_rows_rate: num(o.hit_rate), p50_ms: num(o.p50_ms) },
  };
}

/**
 * WHAT THE CATALOG CAN DO FOR THE PEOPLE OF A COMPANY, from its own structure (DT-20261118-05 RCA2): the capabilities whose items are the people of a company, and whether e-mail and phone finders for a person exist. The planner is told, so a request for the staff, managers or owners
 * of companies, with their e-mails or phones, is planned as a child step of the companies and never answered «no source gives it» while the catalog has them. Nothing here reads the customer's words.
 */
/** The people-of-company capabilities this account may use (empty: the catalog cannot give the people of a company). */
export function peopleOfCompanyCapabilitiesOf(catalog: TregCatalog, access: AccountAccess | null): string[] {
  return [...new Set(catalog.endpoints.filter((e) => usableEndpoint(e, catalog, access)).map(capabilityOf).filter((c) => PEOPLE_OF_COMPANY_CAPABILITIES.has(c)))].sort();
}
export function peopleOfCompanyHint(catalog: TregCatalog, access: AccountAccess | null): string {
  const usable = catalog.endpoints.filter((e) => usableEndpoint(e, catalog, access));
  const people = peopleOfCompanyCapabilitiesOf(catalog, access);
  if (people.length === 0) return "";
  const has = (caps: ReadonlySet<string>): boolean => usable.some((e) => e.capability !== undefined && e.capability !== null && caps.has(e.capability));
  return `PEOPLE OF COMPANIES (from this catalog): the items of these capabilities are the people who work at a company: ${people.join(", ")}. When the customer asks for the people of companies (their staff, managers, owners or decision makers, in any words), plan a child step of the companies step with one of them, deliver true, and answer people_of_companies. The system then looks up each person's own e-mail${has(EMAIL_FINDER_CAPABILITIES) ? " (e-mail finders exist)" : ""} and phone${has(PHONE_CAPABILITIES) ? " (phone finders exist)" : ""} by itself: never write that these people or their e-mails or phones are unavailable while this line is here.`;
}
