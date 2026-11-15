import type { CatalogEndpoint, TregCatalog } from "../../../src/lib/treg/catalog";
import { isSellable } from "../../../src/lib/treg/catalog";
import { blockedEndpointReason } from "../../../src/lib/treg/blockList";
import { policyVerdict, type AccountAccess } from "../../../src/lib/treg/dataPolicy";
import productionEligible from "../../../data/capabilities/production-eligible.json";

/** The endpoints Diger has proven on stored real pages and in production (the reviewed list): ranked first and marked for the model. */
const PROVEN: ReadonlySet<string> = new Set(((productionEligible as { ids?: unknown }).ids as string[] | undefined) ?? []);
export const isProven = (id: string): boolean => PROVEN.has(id);

/**
 * THE CATALOG AS THE PLANNING MODEL READS IT (LLM-first planner, 15 Nov 2026). The model, not code, decides what the customer means and which tool serves it; code decides only what the model may SEE:
 * endpoints that are sellable, not on the block list and allowed for this account by the data policy. Nothing here reads the customer's words.
 */

/** Families that produce media rather than collect data: never offered to a data request. */
const NOT_DATA_FAMILIES: ReadonlySet<string> = new Set(["image-gen", "video-gen", "voice-gen", "ai-search", "creators"]);

export const usableEndpoint = (e: CatalogEndpoint, catalog: TregCatalog, access: AccountAccess | null): boolean =>
  !NOT_DATA_FAMILIES.has(e.platform) && isSellable(e.id, catalog) && !blockedEndpointReason(e.id, e.scope ?? null) && policyVerdict(e.id, access).allowed;

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
    .map(([p, caps]) => `${p}: ${[...caps.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([c, n]) => `${c.startsWith(`${p}.`) ? c.slice(p.length + 1) : c}(${n})`).join(", ")}`)
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

export const callUsdOf = (e: CatalogEndpoint): number => Math.max(0, Number(e.cost?.usd ?? 0)) || 0.01;

/** The candidates of one capability (and, when it has few, the platform's other tools), best first, at most `max`. */
export function candidatesFor(catalog: TregCatalog, access: AccountAccess | null, platform: string, capability: string, max = 8): CatalogEndpoint[] {
  const usable = catalog.endpoints.filter((e) => e.platform === platform && usableEndpoint(e, catalog, access));
  const exact = usable.filter((e) => capabilityOf(e) === capability);
  const rank = (a: CatalogEndpoint, b: CatalogEndpoint): number => reliabilityOf(b) - reliabilityOf(a) || callUsdOf(a) - callUsdOf(b);
  const chosen = [...exact].sort(rank).slice(0, max);
  if (chosen.length >= 3) return chosen;
  // a capability the catalog names differently (or did not name): the same platform's tools whose capability shares the last word (posts, comments, replies …)
  const last = capability.split(".").pop() ?? "";
  const near = usable.filter((e) => !chosen.includes(e) && last !== "" && capabilityOf(e).split(".").pop() === last).sort(rank);
  return [...chosen, ...near].slice(0, max);
}

const clip = (s: unknown, n: number): string => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** One endpoint as the model reads it to choose and fill it: what it does, every input with its type, limits and note, how it pages, what an item carries, what one call costs. */
export function describeForModel(e: CatalogEndpoint): Record<string, unknown> {
  const o = e.observed ?? {};
  return {
    id: e.id,
    capability: capabilityOf(e),
    what: clip(e.summary ?? e.name, 400),
    inputs: e.inputs.map((i) => ({
      name: i.name, type: i.type, required: i.required,
      ...(Array.isArray(i.enum) && i.enum.length > 0 ? { enum: i.enum.slice(0, 20) } : {}),
      ...(i.minimum !== null && i.minimum !== undefined ? { min: i.minimum } : {}),
      ...(i.maximum !== null && i.maximum !== undefined ? { max: i.maximum } : {}),
      ...(i.default !== null && i.default !== undefined ? { default: i.default } : {}),
      ...(i.example !== null && i.example !== undefined ? { example: i.example } : {}),
      ...(i.note ? { note: clip(i.note, 450) } : {}),
    })),
    paging_inputs: e.pagination ?? [],
    item_fields: e.item_fields ? Object.keys(e.item_fields).slice(0, 40) : null,
    usd_per_call: callUsdOf(e),
    ...(PROVEN.has(e.id) ? { proven_in_production: true } : {}),
    measured: { ok_rate: num(o.ok_rate), returns_rows_rate: num(o.hit_rate), p50_ms: num(o.p50_ms) },
  };
}
