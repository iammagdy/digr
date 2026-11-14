#!/usr/bin/env tsx
/**
 * PHASE 6.1 / 6.2: THE READ-ONLY PROVIDER METADATA SYNC (docs/intelligence/PHASE-5-3-AND-6.md §C; audit §7.3, §7.4). Manually run, never scheduled.
 *
 * It reads ONLY public, token-free metadata (the allowlist is `isMetadataUrl` in providerDrift.ts: TREG `/meta`, `/catalog/search`, `/catalog/endpoints/{id}`; the public OpenAPI files and changelog feeds of Firecrawl and Context.dev),
 * compares it with what the repository holds, and writes a reviewable report. It never calls a provider's data or billable endpoint, never sends a credential, never reads the environment, never touches the database,
 * and never edits `data/capabilities/registry.json` or `production-eligible.json`. Discovered tools are reported, never activated; production eligibility, routing, budgets and prices are not changed by anything here.
 *
 *   npx tsx scripts/capabilities/sync-providers.ts [--out docs/capabilities/sync-<date>.md] [--date YYYY-MM-DD]
 *        [--offline <dir>]         read the answers stored in <dir> instead of the network (no request is made)
 *        [--save <dir>]            store every answer received in <dir> (to replay it offline later)
 *        [--plans <json>]          approved plans to check: [{ "ref": "...", "endpointIds": ["..."], "usdPerRow": { "<id>": 0.01 } }]
 *        [--baseline <file>]       the last known-good metadata (default data/capabilities/provider-metadata.json)
 *        [--write-baseline]        write the NEW known-good metadata to the baseline file (the only file this script may write besides --out and --save)
 *
 * A request that FAILED (time-out, 5xx, 429, unreadable answer, a refused address) is «unverified»: the last known-good metadata is kept and nothing is concluded. Only a clear «unknown endpoint» answer is evidence of a removal,
 * and a wave of them (more than a fifth of the ids asked) is treated as an outage.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify as classifyEndpoint } from "../treg/build-data-policy.mjs";
import type { RegistryArtifact } from "../../src/lib/agentMission/capabilities/artifact";
import {
  assertNoCredentials, contractFromLive, contractFromSnapshot, diffContracts, diffWebProvider, feedItems, impactOf, isMetadataUrl, newFeedItems, summarizeOpenApi, BREAKING_KINDS,
  type DriftChange, type EndpointContract, type FeedItem, type ImpactRow, type OpenApiSummary, type PlanRef, type WebDependency, type WebDrift,
} from "../../src/lib/agentMission/capabilities/providerDrift";
import { PARSERS } from "../../src/lib/agentMission/sources";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_BASELINE = path.join(ROOT, "data/capabilities/provider-metadata.json");
export const BASELINE_FILE_NAME = "provider-metadata.json";

// ------------------------------------------------------------------------------------------------ what Diger calls (checked against the adapters by tests/provider-drift-phase6.test.ts)
/** Firecrawl: `src/lib/server/multiProvider/adapters/firecrawl*.ts`. Context.dev: `adapters/contextdev.ts` and `adapters/contextdevParse.ts`. The parser names are the registry's own (`PARSERS`). */
export const USED_WEB_CALLS: ReadonlyArray<WebDependency> = [
  { provider: "firecrawl", method: "POST", path: "/v2/scrape" },
  { provider: "firecrawl", method: "POST", path: "/v2/search" },
  { provider: "firecrawl", method: "POST", path: "/v2/map" },
  { provider: "contextdev", method: "POST", path: "/v1/web/scrape" },
  { provider: "contextdev", method: "POST", path: "/v1/web/search" },
  { provider: "contextdev", method: "GET", path: "/v1/web/urls" },
  { provider: "contextdev", method: "POST", path: "/v1/people/search" },
  ...Object.values(PARSERS).map((p): WebDependency => ({ provider: "contextdev", method: "POST", path: "/v1/web/scrape", parser: p.name })),
];
/** Where Context.dev's public OpenAPI lists the prebuilt parsers (found on 14 Nov 2026; if it moves the report says «parser list not found», never «no parsers»). */
export const CONTEXTDEV_PARSER_ENUM = "/components/schemas/ScrapeParseParams/oneOf/1/properties/parser";
/** Registry capability ids that stand on each public path. A removed path breaks all of them. */
const WEB_PATH_CAPABILITIES: Record<string, (ids: ReadonlyArray<string>) => string[]> = {
  "POST /v2/scrape": () => ["firecrawl.scrape"],
  "POST /v2/search": () => ["firecrawl.search"],
  "POST /v1/web/scrape": (ids) => ["contextdev.scrape", ...ids.filter((i) => i.startsWith("contextdev.parse."))],
  "POST /v1/web/search": () => ["contextdev.search"],
  "POST /v1/people/search": () => ["contextdev.people.search"],
};

const URLS = {
  tregMeta: "https://treg.to/meta",
  tregSearch: "https://treg.to/catalog/search?added_within_days=8&sort=newest&limit=100",
  tregEndpoint: (id: string) => `https://treg.to/catalog/endpoints/${encodeURIComponent(id)}`,
  firecrawlSpec: "https://docs.firecrawl.dev/api-reference/v2-openapi.json",
  firecrawlFeed: "https://www.firecrawl.dev/changelog/rss.xml",
  contextdevSpec: "https://docs.context.dev/openapi.json",
  contextdevFeed: "https://docs.context.dev/changelog/rss.xml",
} as const;

// ------------------------------------------------------------------------------------------------ fetching (injectable)
/** ok:true = an HTTP answer arrived (any status); ok:false = no answer (network error, time-out, refused address). */
export type Fetched = { ok: true; status: number; text: string } | { ok: false; error: string };
export type Fetcher = (url: string) => Promise<Fetched>;

/** The live fetcher: GET only, no credentials, no redirects, public metadata addresses only (anything else is refused BEFORE a request is made). Retries a 429 or 5xx twice. */
export function createLiveFetcher(opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Fetcher {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  return async (url) => {
    if (!isMetadataUrl(url)) return { ok: false, error: "refused: not a public metadata address" };
    const headers = { Accept: "application/json, application/rss+xml, application/xml;q=0.9, text/plain;q=0.5", "User-Agent": "diger-provider-sync/1.0 (public metadata only)" };
    assertNoCredentials(headers);
    let last: Fetched = { ok: false, error: "not attempted" };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
        const text = await res.text();
        last = { ok: true, status: res.status, text };
        if (res.status !== 429 && res.status < 500) return last;
      } catch (e) {
        last = { ok: false, error: String((e as Error)?.message ?? e).slice(0, 120) };
      }
      await sleep(500 * (attempt + 1) * (attempt + 1));
    }
    return last;
  };
}

const fileNameOf = (url: string): string => { const u = new URL(url); return `${u.hostname}${u.pathname}${u.search}`.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 150) + "-" + createHash("sha256").update(url).digest("hex").slice(0, 8) + ".json"; };
/** Replays answers stored by `--save`. A url with no stored answer is «no answer» (never a removal). Makes no request. */
export function createOfflineFetcher(dir: string): Fetcher {
  return async (url) => {
    const f = path.join(dir, fileNameOf(url));
    if (!existsSync(f)) return { ok: false, error: "no stored answer" };
    try { const s = JSON.parse(readFileSync(f, "utf8")) as { status: number; text: string }; return { ok: true, status: s.status, text: s.text }; } catch { return { ok: false, error: "stored answer unreadable" }; }
  };
}
/** Wraps a fetcher so every answer received is stored in `dir` (for offline replay). */
export function savingFetcher(inner: Fetcher, dir: string): Fetcher {
  mkdirSync(dir, { recursive: true });
  return async (url) => { const r = await inner(url); if (r.ok) writeFileSync(path.join(dir, fileNameOf(url)), JSON.stringify({ url, status: r.status, text: r.text })); return r; };
}
/** Stores one answer the way `--save` does (used by tests to build offline fixtures). */
export function storedAnswer(dir: string, url: string, status: number, text: string): void { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, fileNameOf(url)), JSON.stringify({ url, status, text })); }
export const metadataUrls = URLS;

const parseJson = (t: string): any => { try { return JSON.parse(t); } catch { return undefined; } };

async function pool<T, R>(items: ReadonlyArray<T>, size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]); } }));
  return out;
}

// ------------------------------------------------------------------------------------------------ the baseline (last known-good metadata)
export type BaselineContract = EndpointContract & { policy: "public" | "b2b_contact" | "sensitive" | "blocked" };
export interface WebBaseline { summary: OpenApiSummary; changelog_latest: string | null }
export interface ProviderBaseline {
  version: 1;
  synced_at: string;
  treg: { treg_version: string | null; paused_providers: string[]; contracts: Record<string, BaselineContract> };
  web: { firecrawl: WebBaseline | null; contextdev: WebBaseline | null };
}
export const emptyBaseline = (): ProviderBaseline => ({ version: 1, synced_at: "", treg: { treg_version: null, paused_providers: [], contracts: {} }, web: { firecrawl: null, contextdev: null } });

// ------------------------------------------------------------------------------------------------ the sync
export interface SyncInput {
  registry: RegistryArtifact;
  /** The pinned TREG snapshot's endpoints (data/treg/treg_catalog_sellable.json `endpoints`). */
  snapshot: ReadonlyArray<Record<string, any>>;
  writeIds: ReadonlySet<string>;
  baseline: ProviderBaseline | null;
  fetchText: Fetcher;
  /** The report's date (YYYY-MM-DD): passed in, never read from a clock. */
  date: string;
  plans?: ReadonlyArray<PlanRef>;
  concurrency?: number;
}

export interface WebReport { provider: "firecrawl" | "contextdev"; fetched: boolean; version: string | null; server: string | null; pathCount: number; drifts: WebDrift[]; feedFetched: boolean; feed: Array<FeedItem & { breaking: boolean }>; summary: OpenApiSummary | null; latest: string | null }
export interface SyncReport {
  date: string;
  treg: { version: string | null; metaFetched: boolean; pausedProviders: string[]; checked: number; live: number; gone: string[]; failed: Array<{ id: string; why: string }>; massNotFound: boolean; searchTotal: number | null; searchCount: number; searchComplete: boolean; comparedWith: "baseline" | "pinned snapshot" };
  rows: ImpactRow[];
  added: Array<{ id: string; capability: string; usd: number | null; policy: string }>;
  web: WebReport[];
  webRows: ImpactRow[];
  baselineNext: ProviderBaseline;
}

const policyOfRaw = (raw: Record<string, any>, writeIds: ReadonlySet<string>): BaselineContract["policy"] => (classifyEndpoint(raw, { writeIds }).category as BaselineContract["policy"]);

export async function runProviderSync(input: SyncInput): Promise<SyncReport> {
  const { registry, snapshot, writeIds, fetchText, date } = input;
  const baseline = input.baseline ?? null;
  const tregIds = [...new Set(registry.capabilities.filter((c) => c.provider === "treg").map((c) => c.id))].sort();
  const registryIds = registry.capabilities.map((c) => c.id);
  const snapshotById = new Map(snapshot.map((e) => [String(e.id), e] as const));

  // ---- TREG: version and paused providers
  const meta = await fetchText(URLS.tregMeta);
  const metaJson = meta.ok && meta.status === 200 ? parseJson(meta.text) : undefined;
  const metaFetched = Boolean(metaJson && typeof metaJson === "object");
  const pausedNow: string[] = metaFetched && metaJson.paused_providers && typeof metaJson.paused_providers === "object" ? Object.keys(metaJson.paused_providers).map((k) => k.toLowerCase()).sort() : [];
  // a failed /meta keeps the last known paused list (never «nothing is paused»)
  const paused = new Set(metaFetched ? pausedNow : (baseline?.treg.paused_providers ?? []));

  // ---- the «before» side: the last known-good contracts, or (first run) the pinned snapshot's
  const comparedWith: "baseline" | "pinned snapshot" = baseline && Object.keys(baseline.treg.contracts).length > 0 ? "baseline" : "pinned snapshot";
  const before = new Map<string, EndpointContract>();
  const policyBefore = new Map<string, BaselineContract["policy"]>();
  for (const id of tregIds) {
    const b = baseline?.treg.contracts[id];
    if (comparedWith === "baseline" && b) { const { policy, ...c } = b; before.set(id, c); policyBefore.set(id, policy); continue; }
    const raw = snapshotById.get(id);
    if (raw) { before.set(id, contractFromSnapshot(raw, new Set(baseline?.treg.paused_providers ?? []))); policyBefore.set(id, policyOfRaw(raw, writeIds)); }
  }

  // ---- the live side, one public GET per id the registry uses
  type Outcome = { id: string } & ({ kind: "live"; contract: EndpointContract; raw: Record<string, any> } | { kind: "gone" } | { kind: "failed"; why: string });
  const outcomes = await pool(tregIds, input.concurrency ?? 5, async (id): Promise<Outcome> => {
    const r = await fetchText(URLS.tregEndpoint(id));
    if (!r.ok) return { id, kind: "failed", why: r.error };
    const j = parseJson(r.text);
    if (r.status === 200) {
      const c = j && typeof j === "object" ? contractFromLive(j, paused) : null;
      if (!c) return { id, kind: "failed", why: "answer unreadable" };
      if (c.id !== id) return { id, kind: "failed", why: `answer is for another id (${c.id})` };
      return { id, kind: "live", contract: c, raw: j.endpoint };
    }
    if (r.status === 404 && typeof j?.detail?.error === "string" && /^unknown endpoint\b/i.test(j.detail.error)) return { id, kind: "gone" };
    return { id, kind: "failed", why: `HTTP ${r.status}` };
  });
  let gone = outcomes.filter((o) => o.kind === "gone").map((o) => o.id);
  // a wave of «unknown endpoint» is an outage or a catalog reset, never a mass removal
  const massNotFound = gone.length > Math.max(5, Math.floor(tregIds.length * 0.2));
  const failed: Array<{ id: string; why: string }> = outcomes.filter((o): o is Outcome & { kind: "failed" } => o.kind === "failed").map((o) => ({ id: o.id, why: o.why }));
  if (massNotFound) { for (const id of gone) failed.push({ id, why: "mass «unknown endpoint»: treated as an outage, not a removal" }); gone = []; }
  const after = new Map<string, EndpointContract>();
  const rawAfter = new Map<string, Record<string, any>>();
  for (const o of outcomes) if (o.kind === "live") { after.set(o.id, o.contract); rawAfter.set(o.id, o.raw); }

  // ---- what TREG says was added lately (reported, never selectable)
  const search = await fetchText(URLS.tregSearch);
  const searchJson = search.ok && search.status === 200 ? parseJson(search.text) : undefined;
  const results: Array<Record<string, any>> = Array.isArray(searchJson?.results) ? searchJson.results : [];
  const searchTotal = typeof searchJson?.total === "number" ? searchJson.total : null;
  const known = new Set<string>([...snapshotById.keys(), ...registryIds, ...Object.keys(baseline?.treg.contracts ?? {})]);
  const addedRaw = new Map<string, Record<string, any>>();
  for (const r of results) {
    const c = r && typeof r.id === "string" && !known.has(r.id) ? contractFromLive({ endpoint: r }, paused) : null;
    if (c) { after.set(c.id, c); rawAfter.set(c.id, r); addedRaw.set(c.id, r); }
  }

  const changes = diffContracts(before, after, {
    complete: true, failed: new Set(failed.map((f) => f.id)), checked: new Set(tregIds), outputs: false,
    policyOf: (c, side) => (side === "before" ? (policyBefore.get(c.id) ?? "public") : policyOfRaw(rawAfter.get(c.id) ?? { id: c.id, provider: c.provider, capability: c.capability }, writeIds)),
  });
  const rows = impactOf(changes, registry, input.plans ?? []);
  const added = changes.filter((c) => c.kind === "added").map((c) => { const raw = addedRaw.get(c.id) ?? {}; return { id: c.id, capability: String(raw.capability ?? ""), usd: typeof raw.cost?.usd === "number" ? raw.cost.usd : null, policy: policyOfRaw(raw.id ? raw : { id: c.id }, writeIds) }; });

  // ---- Firecrawl and Context.dev: public OpenAPI and changelog
  const web: WebReport[] = [];
  const webChanges: DriftChange[] = [];
  const weekAgo = new Date(Date.parse(`${date}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
  for (const [provider, specUrl, feedUrl] of [["firecrawl", URLS.firecrawlSpec, URLS.firecrawlFeed], ["contextdev", URLS.contextdevSpec, URLS.contextdevFeed]] as const) {
    const base = baseline?.web[provider] ?? null;
    const spec = await fetchText(specUrl);
    const summary = spec.ok && spec.status === 200 ? summarizeOpenApi(parseJson(spec.text)) : null;
    const pointer = provider === "contextdev" ? CONTEXTDEV_PARSER_ENUM : undefined;
    // the baseline keeps only the enum Diger depends on
    const drifts = diffWebProvider(provider, base?.summary ?? null, summary, USED_WEB_CALLS, pointer);
    const feed = await fetchText(feedUrl);
    const feedOk = feed.ok && feed.status === 200;
    const items = feedOk ? feedItems(feed.text) : [];
    const baseLatest = base?.changelog_latest ?? null;
    const fresh = newFeedItems(baseLatest, items).filter((i) => baseLatest !== null || (i.date ?? "") >= weekAgo);
    web.push({ provider, fetched: summary !== null, version: summary?.version ?? null, server: summary?.server ?? null, pathCount: summary?.paths.length ?? 0, drifts, feedFetched: feedOk, feed: fresh, summary, latest: items.find((i) => i.date)?.date ?? baseLatest });
    for (const d of drifts) {
      if (!d.breaking) continue;
      const key = d.detail.split(" ")[0] === "parser" ? "" : d.detail.split(" is called")[0];
      const parser = /^parser (\S+) is called/.exec(d.detail)?.[1];
      const ids = parser ? [`contextdev.parse.${parser}`] : d.kind === "server_changed" ? registryIds.filter((i) => i.startsWith(`${provider}.`)) : (WEB_PATH_CAPABILITIES[key]?.(registryIds) ?? []);
      for (const id of [...new Set(ids)].filter((i) => registryIds.includes(i))) webChanges.push({ id, kind: "removed", detail: `${provider} public API: ${d.detail}` });
    }
  }
  const webRows = impactOf(webChanges, registry, input.plans ?? []);

  // ---- the new known-good metadata: verified data only (a failed or removed id keeps its last known-good entry)
  const next = emptyBaseline();
  next.synced_at = date;
  next.treg.treg_version = metaFetched ? String(metaJson.treg_version ?? "") || null : (baseline?.treg.treg_version ?? null);
  next.treg.paused_providers = [...paused].sort();
  for (const id of tregIds) {
    const live = after.get(id);
    const raw = rawAfter.get(id);
    if (live && raw) next.treg.contracts[id] = { ...live, policy: policyOfRaw(raw, writeIds) };
    else { const was = before.get(id); if (was) next.treg.contracts[id] = { ...was, policy: policyBefore.get(id) ?? "public" }; }
  }
  const pinKeep = (summary: OpenApiSummary | null, pointer?: string): OpenApiSummary | null => summary && { ...summary, enums: pointer && summary.enums[pointer] ? { [pointer]: summary.enums[pointer] } : {} };
  for (const w of web) {
    const was = baseline?.web[w.provider] ?? null;
    next.web[w.provider] = w.fetched ? { summary: pinKeep(w.summary, w.provider === "contextdev" ? CONTEXTDEV_PARSER_ENUM : undefined)!, changelog_latest: w.latest } : was;
  }
  return { date, treg: { version: next.treg.treg_version, metaFetched, pausedProviders: [...paused].sort(), checked: tregIds.length, live: [...outcomes].filter((o) => o.kind === "live").length, gone, failed: failed.sort((a, b) => a.id.localeCompare(b.id)), massNotFound, searchTotal, searchCount: results.length, searchComplete: searchTotal !== null && results.length >= searchTotal, comparedWith }, rows, added, web, webRows, baselineNext: next };
}

// ------------------------------------------------------------------------------------------------ the report
const cell = (s: unknown): string => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const kindCounts = (rows: ReadonlyArray<ImpactRow>): Record<string, number> => { const c: Record<string, number> = {}; for (const r of rows) c[r.change.kind] = (c[r.change.kind] ?? 0) + 1; return Object.fromEntries(Object.entries(c).sort(([a], [b]) => a.localeCompare(b))); };

export function renderReport(r: SyncReport): string {
  const L: string[] = [];
  const breaking = [...r.rows, ...r.webRows].filter((x) => BREAKING_KINDS.has(x.change.kind));
  const other = r.rows.filter((x) => !BREAKING_KINDS.has(x.change.kind) && x.change.kind !== "added" && x.change.kind !== "unverified");
  L.push(`# Provider metadata sync, ${r.date}`, "", "Read-only. Public metadata only: no credential, no billable endpoint, no provider data call, no database, no switch. Nothing below was activated, promoted, re-priced or re-routed; every proposal needs a reviewed PR.", "");
  L.push("## Summary", "", "| | |", "|---|---|");
  L.push(`| TREG version | ${cell(r.treg.version ?? "unknown (the /meta request failed)")} |`);
  L.push(`| TREG paused providers | ${cell(r.treg.pausedProviders.join(", ") || "none")} |`);
  L.push(`| Compared with | ${r.treg.comparedWith} |`);
  L.push(`| Registry TREG ids asked | ${r.treg.checked}: ${r.treg.live} answered, ${r.treg.gone.length} «unknown endpoint», ${r.treg.failed.length} unverified |`);
  L.push(`| TREG additions in the last 8 days | ${r.added.length} listed of ${r.treg.searchTotal ?? "?"}${r.treg.searchComplete ? "" : " (the listing is partial or failed)"} |`);
  L.push(`| Breaking changes on capabilities Diger uses | ${breaking.length} |`);
  L.push(`| Other changes (price, additive, unknown) | ${other.length}: ${JSON.stringify(kindCounts(other))} |`);
  for (const w of r.web) L.push(`| ${w.provider} public API | ${w.fetched ? `version ${cell(w.version)}, ${w.pathCount} operations, ${w.drifts.filter((d) => d.breaking).length} breaking` : "NOT FETCHED: unverified, baseline kept"} |`);
  if (r.treg.massNotFound) L.push("", "> **Warning:** a wave of «unknown endpoint» answers was received. It was treated as an outage; no removal was concluded.");
  L.push("");

  const prod = [...r.rows, ...r.webRows].filter((x) => x.change.kind !== "added" && x.capabilities.some((c) => c.productionEligible));
  L.push("## Changes on production-eligible capabilities (review these first)", "");
  if (prod.length === 0) L.push("None.", "");
  else { L.push("| Id | Kind | Detail |", "|---|---|---|"); for (const x of prod) L.push(`| \`${cell(x.change.id)}\` | ${x.change.kind}${BREAKING_KINDS.has(x.change.kind) ? " (**breaking**)" : ""} | ${cell(x.change.detail)} |`); L.push("", "Nothing was changed for them: a price or input change is shown here for a reviewed PR to accept, re-verify or replace.", ""); }

  L.push("## Breaking changes and what they touch", "");
  if (breaking.length === 0) L.push("None.", "");
  else {
    L.push("| Id | Change | Capabilities (level) | Plans | Review | Safe replacement |", "|---|---|---|---|---|---|");
    for (const x of breaking) {
      const rep = x.replacement ? (x.replacement.id ? `\`${x.replacement.id}\`` : `**none**: ${x.replacement.reason}`) : "n/a (not a registry capability)";
      L.push(`| \`${cell(x.change.id)}\` | ${x.change.kind}: ${cell(x.change.detail)} | ${cell(x.capabilities.map((c) => `${c.key} (${c.level})`).join("; ") || "not in the registry")} | ${cell(x.plans.join(", ") || "none checked")} | ${x.reviewRequired ? "**required**" : "no"} | ${rep} |`);
    }
    L.push("", "A replacement shown is a PROPOSAL for a reviewed PR (same operation and platform, at least as verified, same constraints, inputs and outputs, a known price within the approved one). **none** means the limitation is reported and nothing is substituted.", "");
    const rejected = breaking.filter((x) => x.replacement && x.replacement.rejected.length > 0);
    if (rejected.length > 0) { L.push("Candidates rejected:", ""); for (const x of rejected) L.push(`- \`${cell(x.change.id)}\`: ${x.replacement!.rejected.map((c) => `\`${cell(c.id)}\` (${cell(c.why)})`).join(", ")}`); L.push(""); }
  }

  L.push("## Other changes", "");
  if (other.length === 0) L.push("None.", "");
  else { L.push("| Id | Kind | Detail |", "|---|---|---|"); for (const x of other) L.push(`| \`${cell(x.change.id)}\` | ${x.change.kind} | ${cell(x.change.detail)} |`); L.push(""); }

  L.push("## New on TREG (never selectable until a reviewed PR adds them with evidence)", "");
  if (r.added.length === 0) L.push("None listed.", "");
  else { L.push("| Id | Capability | USD | Data policy |", "|---|---|---|---|"); for (const a of [...r.added].sort((p, q) => p.id.localeCompare(q.id))) L.push(`| \`${cell(a.id)}\` | ${cell(a.capability)} | ${a.usd ?? "?"} | ${cell(a.policy)} |`); L.push(""); }

  L.push("## Unverified (a failed request is never a removal; the last known-good metadata is kept)", "");
  if (r.treg.failed.length === 0 && r.web.every((w) => w.fetched && w.feedFetched)) L.push("None.", "");
  else {
    for (const w of r.web) { if (!w.fetched) L.push(`- ${w.provider}: public OpenAPI not fetched or unreadable`); if (!w.feedFetched) L.push(`- ${w.provider}: changelog feed not fetched`); }
    for (const f of r.treg.failed) L.push(`- \`${cell(f.id)}\`: ${cell(f.why)}`);
    L.push("");
  }

  for (const w of r.web) {
    L.push(`## ${w.provider}: public API and changelog`, "");
    if (w.drifts.length === 0) L.push("No difference from the baseline in the operations, version or parser list Diger depends on.", "");
    else { L.push("| Kind | Breaking | Detail |", "|---|---|---|"); for (const d of w.drifts) L.push(`| ${d.kind} | ${d.breaking ? "**yes**" : "no"} | ${cell(d.detail)} |`); L.push(""); }
    if (w.feed.length > 0) { L.push("New changelog items:", ""); for (const i of w.feed) L.push(`- ${i.date ?? "?"}: ${cell(i.title)}${i.summary && i.summary !== i.title ? `: ${cell(i.summary)}` : ""}${i.breaking ? ` **(mentions a removal, deprecation or breaking change, read it: «${cell(i.note)}»)**` : ""}`); L.push(""); }
  }
  L.push("## What this report did not do", "", "- No provider data or billable endpoint was called; no credential was sent or read.", "- No registry entry, production-eligible list, price, budget, route or customer-facing text was changed.", "- A capability's output contract (list path, cursor, record fields) is not stated by TREG's public answers, so it is compared only against stored real pages by `tests/capability-registry-artifact.test.ts` and the card checks, never guessed here.", "");
  return L.join("\n");
}

// ------------------------------------------------------------------------------------------------ the command line
function arg(name: string, argv: string[]): string | undefined { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

export async function main(argv: string[], fetchOverride?: Fetcher): Promise<number> {
  const date = arg("--date", argv) ?? new Date().toISOString().slice(0, 10);
  const offline = arg("--offline", argv);
  const save = arg("--save", argv);
  const baselinePath = path.resolve(arg("--baseline", argv) ?? DEFAULT_BASELINE);
  const out = arg("--out", argv);
  if (path.basename(baselinePath) !== BASELINE_FILE_NAME) { console.error(`the baseline file must be named ${BASELINE_FILE_NAME}`); return 2; }
  let fetchText: Fetcher = fetchOverride ?? (offline ? createOfflineFetcher(path.resolve(offline)) : createLiveFetcher());
  if (save && !offline) fetchText = savingFetcher(fetchText, path.resolve(save));
  const registry = JSON.parse(readFileSync(path.join(ROOT, "data/capabilities/registry.json"), "utf8")) as RegistryArtifact;
  const snap = JSON.parse(readFileSync(path.join(ROOT, "data/treg/treg_catalog_sellable.json"), "utf8")) as { endpoints: Array<Record<string, any>> };
  const writes = JSON.parse(readFileSync(path.join(ROOT, "data/treg/treg_write_actions.json"), "utf8")) as Array<{ id: string }>;
  const baseline = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, "utf8")) as ProviderBaseline) : null;
  const plansPath = arg("--plans", argv);
  const plans: PlanRef[] = plansPath ? (JSON.parse(readFileSync(path.resolve(plansPath), "utf8")) as Array<{ ref: string; endpointIds: string[]; usdPerRow?: Record<string, number> }>).map((p) => ({ ref: p.ref, endpointIds: p.endpointIds, usdPerRowOf: (id: string) => (typeof p.usdPerRow?.[id] === "number" ? p.usdPerRow[id] : null) })) : [];
  const report = await runProviderSync({ registry, snapshot: snap.endpoints, writeIds: new Set(writes.map((w) => w.id)), baseline, fetchText, date, plans });
  const markdown = renderReport(report);
  if (out) { mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); writeFileSync(path.resolve(out), markdown); console.log(`wrote ${out}`); } else console.log(markdown);
  if (argv.includes("--write-baseline")) { writeFileSync(baselinePath, JSON.stringify(report.baselineNext, null, 1) + "\n"); console.log(`wrote ${path.relative(ROOT, baselinePath)}`); }
  const breaking = [...report.rows, ...report.webRows].filter((x) => BREAKING_KINDS.has(x.change.kind)).length;
  console.log(`checked ${report.treg.checked} TREG ids (${report.treg.live} answered, ${report.treg.gone.length} unknown, ${report.treg.failed.length} unverified); breaking changes: ${breaking}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(String((e as Error)?.message ?? e)); process.exit(1); });
}
