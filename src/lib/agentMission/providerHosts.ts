import { loadTregCatalog, type TregCatalog } from "../treg/catalog";
import { PROVIDER_FACTS } from "../multiProvider/catalog";

/**
 * NO DATA PROVIDER IN A CUSTOMER FILE (live, 2026-10-30, the contractors file): 17 «رابط الشركة» cells and 17 «المعرّف» cells of the companies sheet, and 4 + 4 of the people sheet, held links and ids of a company-data provider
 * (`platform.tracxn.com/a/d/company/<id>/<name>`): the companies source answered, for a company with no LinkedIn page, the address of the record it found, the mapping put it in the link column and used it as the row's id when the company had no website. The same
 * address was then handed to the people source as «the company's LinkedIn page» (a 404, twice, then the stage went on to read fewer companies).
 *
 * ONE rule, decided by code from the catalog (never from a list of names written by hand):
 *   - a HOST belongs to a data provider when one of its labels (not the last one) is the name of a provider or an origin the catalog sells (`provider`, the first word of an endpoint id, the origin of a routed id), or the host of a provider the platform itself uses
 *     (Firecrawl, Context.dev). A label that is also the name of a platform of the catalog (youtube, tiktok, facebook…) or is shorter than four letters is never a provider: it cannot be told from a company's own name;
 *   - a RECORD LINK (a database page of a company or a person: `/company/<long id>`) on a host that is not a platform of the catalog is a provider's page whatever its name (the catalog cannot know every aggregator a source cites);
 *   - a host that is the company's OWN website (a website field of the same row) is never a provider's, whatever its name; a platform's address (x.com, facebook.com, youtube.com, tiktok.com, linkedin.com, Google Maps) stays.
 * An address of a provider is removed from the customer's cells; an id built from one is replaced by a neutral id (a hash of it), the same one wherever the id is written, so the links between sheets still work. Pure apart from reading the catalog once.
 */
export interface ProviderContext { /** The labels of a host that make it a provider's. */ providers: ReadonlySet<string>; platforms: ReadonlySet<string>; /** The names of the providers as the catalog writes them (words of a text): never a label taken from a host only. */ names: ReadonlySet<string> }

/** Hosts a platform of the catalog is also known by (the catalog's platform names are «x», «google», «facebook»…; their addresses are not always the same word). */
const PLATFORM_HOST_ALIASES = ["twitter", "youtu", "fb", "lnkd", "wa", "whatsapp", "t", "maps", "goo", "gstatic", "googleusercontent", "ggpht", "fbcdn", "cdninstagram", "twimg", "ytimg", "licdn"];

let memo: { catalog: TregCatalog; ctx: ProviderContext } | null = null;

/** The provider names and the platform names of a catalog. */
export function providerContextOf(catalog: TregCatalog): ProviderContext {
  if (memo && memo.catalog === catalog) return memo.ctx;
  // a PLATFORM is something several providers sell data of (tiktok, instagram, x, linkedin, youtube, facebook, google…); a site only its own provider sells (crunchbase) is a data provider's
  const providersOfPlatform = new Map<string, Set<string>>();
  for (const e of catalog.endpoints) { const p = String(e.platform ?? "").toLowerCase(); if (!p) continue; if (!providersOfPlatform.has(p)) providersOfPlatform.set(p, new Set()); providersOfPlatform.get(p)!.add(String(e.provider ?? "").toLowerCase()); }
  const platforms = new Set<string>(PLATFORM_HOST_ALIASES);
  for (const [p, sellers] of providersOfPlatform) if (sellers.size >= 2) platforms.add(p);
  const names = new Set<string>();
  const hostLabels = new Set<string>();
  for (const e of catalog.endpoints) {
    const parts = String(e.id).toLowerCase().split(".");
    names.add(String(e.provider ?? "").toLowerCase());
    if (parts[0]) names.add(parts[0]);
    if (parts[1] === "x" && parts[0]) names.add(parts[0]);
  }
  for (const f of Object.values(PROVIDER_FACTS)) {
    names.add(String(f.id ?? "").toLowerCase());
    if (f.baseUrl) { const h = hostOf(f.baseUrl); if (h) for (const l of labelsOf(h)) hostLabels.add(l); }
  }
  const usable = (n: string): boolean => n.length >= 4 && /^[a-z0-9-]+$/.test(n) && !platforms.has(n);
  const nameSet = new Set([...names].filter(usable));
  const providers = new Set([...nameSet, ...[...hostLabels].filter(usable)]);
  const ctx: ProviderContext = { providers, platforms, names: nameSet };
  memo = { catalog, ctx };
  return ctx;
}

/** The context of the shipped catalog (read once per process). */
export const providerContext = (): ProviderContext => providerContextOf(loadTregCatalog());

export function hostOf(url: string): string | null {
  try { const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`); return u.hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return null; }
}

/** The labels of a host without the last one (the top-level domain): «platform.tracxn.com» → platform, tracxn. */
export const labelsOf = (host: string): string[] => host.split(".").filter(Boolean).slice(0, -1);

const RECORD_LINK = /\/(?:company|companies|organi[sz]ations?|orgs?|people|person|profiles?|entit(?:y|ies)|records?)\/[0-9a-f-]{16,}/i;
/** A database page of a company or a person (a long id after the record's kind): LinkedIn's pages use a name there, not an id. */
export const looksLikeRecordLink = (url: string): boolean => RECORD_LINK.test(url);

export function isPlatformHost(host: string, ctx: ProviderContext): boolean { return labelsOf(host).some((l) => ctx.platforms.has(l)) || ctx.platforms.has(host.split(".")[0]); }

/** Is this address a data provider's (host of a provider, or a record page on a host that is no platform), unless it is the row's own website? */
export function isProviderUrl(value: unknown, ctx: ProviderContext, ownHosts: ReadonlySet<string> = new Set()): boolean {
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (!t || /\s/.test(t)) return false;
  const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? hostOf(t) : /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#].*)?$/i.test(t) ? hostOf(t) : null;
  if (!host) return false;
  const bare = host.replace(/^www\./, "");
  if (ownHosts.has(bare)) return false;
  if (labelsOf(host).some((l) => ctx.providers.has(l))) return true;
  return looksLikeRecordLink(t) && !isPlatformHost(host, ctx);
}

/** The hosts of a row's own website fields (website, site, domain, homepage). */
export function ownHostsOf(row: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(row)) {
    if (!/^(website|web|site|domain|homepage|company_?(website|domain|site))$/i.test(k) || typeof v !== "string") continue;
    const h = hostOf(v);
    if (h) out.add(h.replace(/^www\./, ""));
  }
  return out;
}

/** cyrb53, a small stable hash with no dependency: the neutral id is the same wherever the same id is written. */
function cyrb53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i += 1) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
export const neutralIdOf = (id: string): string => `id_${cyrb53(id)}`;

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]،]+/gi;
const BARE_DOMAIN_IN_TEXT = /(?<![\w@./-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'<>)\]،]*)?/gi;

/** The text with every address of a provider taken out (the address itself, not the words around it). Returns the same text when there is none. */
export function withoutProviderUrls(text: string, ctx: ProviderContext, ownHosts: ReadonlySet<string> = new Set()): string {
  if (!text) return text;
  let out = text.replace(URL_IN_TEXT, (m) => (isProviderUrl(m.replace(/[.,;:!?]+$/, ""), ctx, ownHosts) ? "" : m));
  out = out.replace(BARE_DOMAIN_IN_TEXT, (m) => (isProviderUrl(m.replace(/[.,;:!?]+$/, ""), ctx, ownHosts) ? "" : m));
  return out === text ? text : out.replace(/[ \t]{2,}/g, " ").trim();
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The words of the text that are a provider's name (whole words only, five letters or more), taken out: used for the texts WE write (the first sheet, the headings), never for what a source's rows say. */
export function withoutProviderNames(text: string, ctx: ProviderContext): string {
  if (!text) return text;
  const names = [...ctx.names].filter((n) => n.length >= 5).sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${names.map(escapeRe).join("|")})(?![A-Za-z0-9])`, "gi");
  const out = text.replace(re, "");
  return out === text ? text : out.replace(/[ \t]{2,}/g, " ").replace(/\s+([،,.])/g, "$1").trim();
}

export interface ProviderCleanReport { /** Addresses of a provider taken out of cells. */ urls: number; /** Ids built from such an address, replaced by a neutral id. */ ids: number }

/**
 * THE ROWS OF A CUSTOMER FILE, before it is written: an address of a provider is taken out of every cell; an id (or a parent id) that is, or holds, one is replaced by the same neutral id wherever it is written (a parent's id and its children's parent id stay equal).
 * Returns new rows; the input is not changed.
 */
export function cleanRowsForCustomer<R extends Record<string, unknown>>(rowsByStage: Record<string, R[]>, ctx: ProviderContext): { rowsByStage: Record<string, R[]>; report: ProviderCleanReport } {
  const report: ProviderCleanReport = { urls: 0, ids: 0 };
  const out: Record<string, R[]> = {};
  for (const [stage, rows] of Object.entries(rowsByStage)) {
    out[stage] = rows.map((row) => {
      const own = ownHostsOf(row);
      let next: Record<string, unknown> | null = null;
      const set = (k: string, v: unknown): void => { if (!next) next = { ...row }; next[k] = v; };
      for (const [k, v] of Object.entries(row)) {
        if (typeof v !== "string" || v === "") continue;
        if (k === "id" || k === "parent_id") {
          if (isProviderUrl(v, ctx, own) || withoutProviderUrls(v, ctx, own) !== v) { set(k, neutralIdOf(v)); report.ids += 1; }
          continue;
        }
        const cleaned = isProviderUrl(v, ctx, own) ? "" : withoutProviderUrls(v, ctx, own);
        if (cleaned !== v) { set(k, cleaned); report.urls += 1; }
      }
      return (next ?? row) as R;
    });
  }
  return { rowsByStage: out, report };
}
