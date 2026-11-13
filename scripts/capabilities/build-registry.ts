#!/usr/bin/env tsx
/**
 * PHASE 3, THE REGISTRY GENERATOR (offline, deterministic; audit PR-3.1). Builds data/capabilities/registry.json from what the repository already holds:
 *   - the TREG catalog snapshot (data/treg/treg_catalog_sellable.json) and the data policy (data/treg/data_policy.json, itself rebuilt by scripts/treg/build-data-policy.mjs);
 *   - the direct provider definitions (src/lib/agentMission/sources.ts), through the SAME `buildCapabilityRegistry` discovery uses;
 *   - the hand ToolCards (src/lib/agentMission/foundation/toolCards), each checked by `checkCardOnPage` on the stored real pages it lists (tests/fixtures/live/missions, anonymised real provider answers);
 *   - Diger's own measured calls (data/capabilities/reliability-snapshot.json, a read-only aggregate of mission_calls);
 *   - the reviewed production and deprecation lists (data/capabilities/*.json).
 * No network, no database, no secret, no paid call. (The obsolete scripts/update-capability-registry.ts wrote to Appwrite; it is NOT used and must not be run.)
 *
 *   npx tsx scripts/capabilities/build-registry.ts           writes data/capabilities/registry.json
 *   npx tsx scripts/capabilities/build-registry.ts --check   exits 1 when the committed file is out of date (tests/capability-registry-artifact.test.ts runs the same comparison)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { blockedEndpointReason } from "../../src/lib/treg/blockList";
import { categoryOf, policyVerdict } from "../../src/lib/treg/dataPolicy";
import { buildCapabilityRegistry } from "../../src/lib/agentMission/capabilities/registry";
import { buildRegistryArtifact, serializeArtifact, sha256, type ArtifactInputs } from "../../src/lib/agentMission/capabilities/artifact";
import type { EvidenceFacts, MeasuredCalls } from "../../src/lib/agentMission/capabilities/evidence";
import { TOOL_CARDS } from "../../src/lib/agentMission/foundation/toolCards";
import { checkCardOnPage } from "../../src/lib/agentMission/foundation/toolCards/verify";
import { PARSERS, WEB_SOURCES } from "../../src/lib/agentMission/sources";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rel = (p: string) => path.join(ROOT, p);
export const REGISTRY_PATH = rel("data/capabilities/registry.json");
const FILES = {
  catalog: "data/treg/treg_catalog_sellable.json",
  policy: "data/treg/data_policy.json",
  reliability: "data/capabilities/reliability-snapshot.json",
  production: "data/capabilities/production-eligible.json",
  deprecated: "data/capabilities/deprecated.json",
  callIndex: "tests/fixtures/live/call-index.json",
} as const;

/**
 * Capabilities a provider advertises that Diger has NOT implemented: never candidates, listed so the gap is visible (audit §4.2, §4.3, §7.1; read from the providers' documentation on 2026-11-11 by the audit, not re-fetched here).
 * The exact Context.dev parser names are as the audit lists them and must be confirmed against the provider's OpenAPI before any is implemented.
 */
const ADVERTISED_ONLY: ArtifactInputs["advertisedOnly"] = [
  { id: "contextdev.parse.reddit-post", provider: "contextdev", family: "reddit", level: "advertised", note: "Context.dev parser added 2026-10-30/31 (audit §4.3); not in sources.ts PARSERS" },
  { id: "contextdev.parse.reddit-search", provider: "contextdev", family: "reddit", level: "advertised", note: "Context.dev parser added 2026-10-30/31 (audit §4.3); not in sources.ts PARSERS" },
  { id: "contextdev.parse.reddit-subreddit", provider: "contextdev", family: "reddit", level: "advertised", note: "Context.dev parser added 2026-10-30/31 (audit §4.3); not in sources.ts PARSERS" },
  { id: "contextdev.parse.reddit-user", provider: "contextdev", family: "reddit", level: "advertised", note: "Context.dev parser added 2026-10-30/31 (audit §4.3); not in sources.ts PARSERS" },
  { id: "contextdev.parse.yelp", provider: "contextdev", family: "place_reviews", level: "advertised", note: "Context.dev parser added 2026-10-30/31 (audit §4.3); not in sources.ts PARSERS" },
  { id: "contextdev.parse.tripadvisor-reviews", provider: "contextdev", family: "place_reviews", level: "advertised", note: "Context.dev parser added 2026-10-30/31 (audit §4.3); not in sources.ts PARSERS" },
  { id: "contextdev.company.search", provider: "contextdev", family: "companies", level: "advertised", note: "Context.dev Company Search (audit §5); not implemented" },
  { id: "firecrawl.extract", provider: "firecrawl", family: "web", level: "deprecated", note: "Firecrawl /extract removed upstream 2026-12-10 (audit §4.2); listed only in the legacy chain (src/lib/multiProvider/catalog.ts)" },
];

const read = (p: string) => readFileSync(rel(p), "utf8");

export function collectInputs(): ArtifactInputs {
  const catalog = loadTregCatalog();
  // capability truth, not one account's availability: a normal account's policy (a sensitive endpoint shows as not permitted), no key or cap facts
  const registry = buildCapabilityRegistry(catalog, { isAllowed: (id) => !blockedEndpointReason(id) && policyVerdict(id, { isAdmin: false, verifiedBusiness: false }).allowed, handCards: true });
  const policyOf = (id: string): EvidenceFacts["policy"] => { const c = categoryOf(id); return c === "unclassified" ? "blocked" : c; };

  // the hand cards, each checked on the stored REAL pages it lists (a page that is missing is an issue, never a pass)
  const cards = new Map<string, NonNullable<EvidenceFacts["card"]>>();
  for (const card of TOOL_CARDS) {
    const checkedPages: Array<{ ref: string; issues: string[] }> = [];
    for (const v of card.verifiedOn) {
      for (const call of v.calls) {
        const ref = `tests/fixtures/live/missions/${v.mission}/raw/${call}.json`;
        if (!existsSync(rel(ref))) { checkedPages.push({ ref, issues: ["stored page missing"] }); continue; }
        checkedPages.push({ ref, issues: checkCardOnPage(card, JSON.parse(read(ref))).issues });
      }
    }
    cards.set(card.endpointId, { status: card.status, checkedPages });
  }

  const snap = JSON.parse(read(FILES.reliability)) as { columns: string[]; rows: Array<Array<string | number | null>> };
  const measured = new Map<string, MeasuredCalls>();
  for (const r of snap.rows) {
    const [id, attempts, ok, withRows, empty, emptyPaid, failed, refused, rows, costUsd, costNull, p50Ms] = r as [string, number, number, number, number, number, number, number, number, number, number, number | null];
    measured.set(id, { attempts, ok, withRows, empty, emptyPaid, failed, refused, rows, costUsd, costNull, p50Ms });
  }
  const reviewedProduction = new Set<string>((JSON.parse(read(FILES.production)) as { ids: string[] }).ids);
  const deprecated = new Map<string, string>(Object.entries((JSON.parse(read(FILES.deprecated)) as { ids: Record<string, string> }).ids));

  const sources: Record<string, string> = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, sha256(read(f)).slice(0, 16)]));
  sources.directSources = sha256(JSON.stringify({ WEB_SOURCES, PARSERS })).slice(0, 16);
  sources.toolCards = sha256(JSON.stringify(TOOL_CARDS)).slice(0, 16);
  return { catalog, registry, policyOf, cards, measured, reviewedProduction, deprecated, advertisedOnly: ADVERTISED_ONLY, sources };
}

export function generateRegistryJson(): string {
  return serializeArtifact(buildRegistryArtifact(collectInputs()));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const json = generateRegistryJson();
  if (process.argv.includes("--check")) {
    const current = existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, "utf8") : "";
    if (current !== json) { console.error("data/capabilities/registry.json is out of date: run npx tsx scripts/capabilities/build-registry.ts"); process.exit(1); }
    console.log("data/capabilities/registry.json is up to date");
  } else {
    writeFileSync(REGISTRY_PATH, json);
    console.log(`wrote data/capabilities/registry.json (${json.length} bytes)`);
  }
}
