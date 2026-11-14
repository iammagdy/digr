import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classify } from "../scripts/treg/build-data-policy.mjs";
import type { ArtifactEntry, RegistryArtifact } from "../src/lib/agentMission/capabilities/artifact";
import {
  assertNoCredentials, BREAKING_KINDS, contractFingerprint, contractFromLive, contractFromSnapshot, diffContracts, diffWebProvider, feedItems, impactOf, isMetadataUrl, newFeedItems, safeReplacement, summarizeOpenApi,
  type EndpointContract, type DriftOptions,
} from "../src/lib/agentMission/capabilities/providerDrift";
import { PARSERS } from "../src/lib/agentMission/sources";
import {
  createLiveFetcher, createOfflineFetcher, CONTEXTDEV_PARSER_ENUM, main, metadataUrls, renderReport, runProviderSync, storedAnswer, USED_WEB_CALLS, BASELINE_FILE_NAME,
  type Fetcher, type ProviderBaseline, type SyncInput,
} from "../scripts/capabilities/sync-providers";

/**
 * PHASE 6.1 / 6.2 (docs/intelligence/PHASE-5-3-AND-6.md §C): PROVIDER UPDATE INTELLIGENCE. Offline only: no request is made by any test (the live fetcher is tested with a spy, the sync with stored answers).
 */
afterEach(() => { vi.unstubAllGlobals(); });

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(path.join(ROOT, p))).digest("hex");
const registry = JSON.parse(read("data/capabilities/registry.json")) as RegistryArtifact;
const snapshot = (JSON.parse(read("data/treg/treg_catalog_sellable.json")) as { endpoints: Array<Record<string, any>> }).endpoints;
const writeIds = new Set((JSON.parse(read("data/treg/treg_write_actions.json")) as Array<{ id: string }>).map((w) => w.id));
const baseline = JSON.parse(read("data/capabilities/provider-metadata.json")) as ProviderBaseline;
const fx = (n: string) => read(`tests/fixtures/provider-drift/${n}`);
const snapshotById = new Map(snapshot.map((e) => [String(e.id), e] as const));
const tregIds = [...new Set(registry.capabilities.filter((c) => c.provider === "treg").map((c) => c.id))].sort();

// ------------------------------------------------------------------------------------------------ helpers
const c = (over: Partial<EndpointContract> & { id: string }): EndpointContract => ({ provider: over.id.split(".")[0], capability: "companies.search", inputs: [["q", true, "string"]], costUsd: 0.01, costType: "per_call", listPath: "results", cursorPath: "next", itemFields: ["id", "name"], status: null, supersededBy: null, blocked: false, ...over });
const mapOf = (...xs: EndpointContract[]) => new Map(xs.map((x) => [x.id, x] as const));
const opts = (o: Partial<DriftOptions> = {}): DriftOptions => ({ complete: true, ...o });
const kinds = (xs: ReadonlyArray<{ kind: string }>) => xs.map((x) => x.kind);

/** A live TREG answer for a stored contract (the shape of `/catalog/endpoints/{id}`), enriched with the snapshot's own descriptive fields so the data-policy rules see what they saw before. */
function toLive(x: EndpointContract, paused: ReadonlySet<string>): { endpoint: Record<string, any> } {
  const raw = snapshotById.get(x.id) ?? {};
  return { endpoint: {
    id: x.id, provider: x.provider, capability: x.capability, platform: raw.platform, name: raw.name, summary: raw.summary, scope: raw.scope,
    input: { body: Object.fromEntries(x.inputs.map(([n, r, t]) => [n, { type: t, required: r }])) },
    ...(x.costUsd === null && !x.costType ? {} : { cost: { ...(x.costUsd === null ? {} : { usd: x.costUsd }), ...(x.costType ? { type: x.costType } : {}) } }),
    status: x.status, superseded_by: x.supersededBy, platform_blocked: x.blocked && !paused.has(x.provider) ? (x.blockedBy ?? "blocked") : null,
  } };
}
const noPolicy = (b: ProviderBaseline) => Object.fromEntries(Object.entries(b.treg.contracts).map(([id, { policy: _p, ...rest }]) => [id, rest as EndpointContract]));

interface World { answers: Map<string, { status: number; text: string } | "fail">; fetcher: Fetcher; calls: string[] }
/** The live world exactly as the committed baseline says it is (nothing changed), served from memory. */
function world(): World {
  const paused = new Set(baseline.treg.paused_providers);
  const answers: World["answers"] = new Map();
  const json = (v: unknown) => ({ status: 200, text: JSON.stringify(v) });
  answers.set(metadataUrls.tregMeta, json({ treg_version: baseline.treg.treg_version, paused_providers: Object.fromEntries([...paused].map((p) => [p, { display_name: p }])) }));
  answers.set(metadataUrls.tregSearch, json({ query: "", count: 0, total: 0, results: [] }));
  for (const [id, contract] of Object.entries(noPolicy(baseline))) answers.set(metadataUrls.tregEndpoint(id), json(toLive(contract, paused)));
  answers.set(metadataUrls.firecrawlSpec, { status: 200, text: fx("firecrawl-openapi.min.json") });
  answers.set(metadataUrls.contextdevSpec, { status: 200, text: fx("contextdev-openapi.min.json") });
  answers.set(metadataUrls.firecrawlFeed, { status: 200, text: fx("firecrawl-changelog.rss.xml") });
  answers.set(metadataUrls.contextdevFeed, { status: 200, text: fx("contextdev-changelog.rss.xml") });
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => { calls.push(url); const a = answers.get(url); if (a === undefined || a === "fail") return { ok: false, error: "network down" }; return { ok: true, status: a.status, text: a.text }; };
  return { answers, fetcher, calls };
}
const run = (w: World, over: Partial<SyncInput> = {}) => runProviderSync({ registry, snapshot, writeIds, baseline, fetchText: w.fetcher, date: "2026-11-14", ...over });
const liveOf = (w: World, id: string) => JSON.parse((w.answers.get(metadataUrls.tregEndpoint(id)) as { text: string }).text) as { endpoint: Record<string, any> };
const setLive = (w: World, id: string, edit: (e: Record<string, any>) => void) => { const j = liveOf(w, id); edit(j.endpoint); w.answers.set(metadataUrls.tregEndpoint(id), { status: 200, text: JSON.stringify(j) }); };
/** A registry id of TREG that is not blocked and has the given verification level (a stable pick: the first one by id). */
const pick = (level?: string, not: ReadonlySet<string> = new Set(), priced = false) => tregIds.find((id) => !baseline.treg.contracts[id].blocked && !not.has(id) && (!priced || (baseline.treg.contracts[id].costUsd ?? 0) > 0) && (!level || registry.capabilities.find((e) => e.id === id)!.verification.level === level))!;

// ------------------------------------------------------------------------------------------------ 1. public metadata only
describe("the sync reads public metadata only", () => {
  it("accepts exactly the documented, token-free addresses", () => {
    for (const u of [
      "https://treg.to/meta", "https://treg.to/openapi.json", "https://treg.to/catalog/search?added_within_days=8&sort=newest&limit=100", "https://treg.to/catalog/search?q=email", "https://treg.to/catalog/endpoints/aiark.companies.search",
      "https://docs.firecrawl.dev/api-reference/v2-openapi.json", "https://www.firecrawl.dev/changelog/rss.xml", "https://docs.context.dev/openapi.json", "https://docs.context.dev/changelog/rss.xml",
    ]) expect(isMetadataUrl(u), u).toBe(true);
  });
  it("refuses every data or billable path, every API host, other schemes, hosts that only look alike, and credentials in the address", () => {
    for (const u of [
      "https://treg.to/call", "https://treg.to/aiark.companies.search", "https://treg.to/api/anything", "https://api.treg.to/meta", "https://treg.to.evil.example/meta", "https://evil.example/treg.to/meta",
      "https://api.firecrawl.dev/v2/scrape", "https://api.firecrawl.dev/v2/team/credit-usage", "https://docs.firecrawl.dev/api-reference/endpoint/scrape", "https://api.context.dev/v1/web/scrape", "https://api.context.dev/v1/org/usage",
      "http://treg.to/meta", "ftp://treg.to/meta", "https://user:pass@treg.to/meta", "https://treg.to:8443/meta", "https://treg.to/meta#x", "https://treg.to/catalog/endpoints/a/b", "https://treg.to/catalog/endpoints/..%2Fcall", "not a url", "",
    ]) expect(isMetadataUrl(u), u).toBe(false);
    // a credential never rides in a query string
    expect(isMetadataUrl("https://treg.to/meta?token=abc")).toBe(false);
    expect(isMetadataUrl("https://treg.to/catalog/endpoints/aiark.companies.search?api_key=abc")).toBe(false);
    expect(isMetadataUrl("https://treg.to/catalog/search?q=x&token=abc")).toBe(false);
    expect(isMetadataUrl("https://docs.context.dev/openapi.json?key=abc")).toBe(false);
  });
  it("a request never carries a credential header", () => {
    for (const h of ["Authorization", "authorization", "Cookie", "X-API-Key", "x-treg-token", "Proxy-Authorization"]) expect(() => assertNoCredentials({ [h]: "x" }), h).toThrow(/no credentials/);
    expect(() => assertNoCredentials({ Accept: "application/json", "User-Agent": "x" })).not.toThrow();
  });
  it("the live fetcher refuses a billable address BEFORE any request, and sends only a generic client name with no credential", async () => {
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const live = createLiveFetcher({ sleep: async () => undefined });
    for (const u of ["https://treg.to/call", "https://api.firecrawl.dev/v2/scrape", "https://api.context.dev/v1/web/scrape", "https://treg.to/meta?token=x"]) expect(await live(u)).toMatchObject({ ok: false });
    expect(spy).not.toHaveBeenCalled();
    expect(await live("https://treg.to/meta")).toMatchObject({ ok: true, status: 200 });
    expect(spy).toHaveBeenCalledTimes(1);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.body).toBeUndefined();
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual(["Accept", "User-Agent"]);
    expect(String((init.headers as Record<string, string>)["User-Agent"])).toMatch(/^diger-provider-sync\/1\.0 \(public metadata only\)$/);
  });
  it("a network error or a 5xx is «no answer / retried», never a conclusion; a 429 is retried", async () => {
    const sleeps: number[] = [];
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { n += 1; if (n === 1) throw new Error("boom"); if (n === 2) return new Response("busy", { status: 429 }); return new Response("{}", { status: 200 }); }));
    expect(await createLiveFetcher({ sleep: async (ms) => { sleeps.push(ms); } })("https://treg.to/meta")).toMatchObject({ ok: true, status: 200 });
    expect(sleeps.length).toBe(2);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect(await createLiveFetcher({ sleep: async () => undefined })("https://treg.to/meta")).toEqual({ ok: false, error: "down" });
  });
  it("no source of the sync reads the environment, a database or a secret, and none can write a protected data file", () => {
    for (const f of ["scripts/capabilities/sync-providers.ts", "src/lib/agentMission/capabilities/providerDrift.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/process\.env/);
      expect(src, f).not.toMatch(/supabase|createClient|service_role|api[_-]?key\b.*=|Bearer /i);
    }
    expect(read("src/lib/agentMission/capabilities/providerDrift.ts")).not.toMatch(/\bfetch\s*\(|writeFile|readFile|node:fs/);
    const script = read("scripts/capabilities/sync-providers.ts");
    // every write goes to the report (--out), the replay folder (--save) or the baseline file: none of the protected data files is ever named in a write
    const writes = script.split("\n").filter((l) => /writeFileSync\(/.test(l));
    expect(writes.length).toBeGreaterThan(0);
    for (const l of writes) expect(l).not.toMatch(/registry\.json|production-eligible|deprecated\.json|reliability-snapshot|data_policy|treg_catalog|agent_settings/);
  });
});

// ------------------------------------------------------------------------------------------------ 2. deterministic comparison with the baseline
describe("the deterministic comparison", () => {
  it("identical contracts: no change", () => {
    const a = c({ id: "p.a" });
    expect(diffContracts(mapOf(a), mapOf({ ...a }), opts())).toEqual([]);
  });
  it("an ADDED endpoint is reported, with the words «never selectable»", () => {
    const out = diffContracts(mapOf(c({ id: "p.a" })), mapOf(c({ id: "p.a" }), c({ id: "p.new", capability: "x.y" })), opts());
    expect(out).toEqual([expect.objectContaining({ id: "p.new", kind: "added" })]);
    expect(out[0].detail).toMatch(/never selectable/);
  });
  it("a REMOVED endpoint needs COMPLETE evidence; a partial listing or a failed fetch is «unverified», never removed", () => {
    const before = mapOf(c({ id: "p.a" }), c({ id: "p.b" }));
    expect(kinds(diffContracts(before, mapOf(c({ id: "p.a" })), opts({ complete: true })))).toEqual(["removed"]);
    expect(kinds(diffContracts(before, mapOf(c({ id: "p.a" })), opts({ complete: false })))).toEqual(["unverified"]);
    const failed = diffContracts(before, mapOf(c({ id: "p.a" })), opts({ complete: true, failed: new Set(["p.b"]) }));
    expect(failed).toEqual([expect.objectContaining({ id: "p.b", kind: "unverified" })]);
    expect(failed[0].detail).toMatch(/not treated as removed/);
  });
  it("only the ids that were asked for can be concluded about", () => {
    const before = mapOf(c({ id: "p.a" }), c({ id: "p.b" }));
    expect(diffContracts(before, mapOf(), opts({ checked: new Set(["p.a"]) })).map((x) => x.id)).toEqual(["p.a"]);
  });
  it("a RENAME (a removed id and a new id with the same capability and contract) is told apart from a removal and an addition", () => {
    const out = diffContracts(mapOf(c({ id: "p.old" })), mapOf(c({ id: "p.new" })), opts());
    expect(out).toEqual([expect.objectContaining({ id: "p.old", kind: "renamed", to: "p.new" })]);
    // a different capability, provider or inputs is NOT a rename
    expect(kinds(diffContracts(mapOf(c({ id: "p.old" })), mapOf(c({ id: "p.new", capability: "other" })), opts())).sort()).toEqual(["added", "removed"]);
    expect(kinds(diffContracts(mapOf(c({ id: "p.old" })), mapOf(c({ id: "q.new" })), opts())).sort()).toEqual(["added", "removed"]);
    expect(kinds(diffContracts(mapOf(c({ id: "p.old" })), mapOf(c({ id: "p.new", inputs: [["zzz", true, "string"]] })), opts())).sort()).toEqual(["added", "removed"]);
    // one new id renames only one removed id
    const two = diffContracts(mapOf(c({ id: "p.a" }), c({ id: "p.b" })), mapOf(c({ id: "p.c" })), opts());
    expect(kinds(two).sort()).toEqual(["removed", "renamed"]);
    // outputs are not compared (a live answer does not state them): the rename is judged on the inputs alone
    expect(kinds(diffContracts(mapOf(c({ id: "p.old", itemFields: ["a"] })), mapOf(c({ id: "p.new", itemFields: null, listPath: null })), opts({ outputs: false })))).toEqual(["renamed"]);
    expect(kinds(diffContracts(mapOf(c({ id: "p.old", itemFields: ["a"] })), mapOf(c({ id: "p.new", itemFields: null, listPath: null })), opts({ outputs: true }))).sort()).toEqual(["added", "removed"]);
  });
  it("INPUT changes: a new required input, an input that became required, a removed input and a retyped input are breaking; a new optional input is additive; a widened type is additive", () => {
    const base = c({ id: "p.a", inputs: [["q", true, "string"], ["n", false, "integer"]] });
    const d = (inputs: EndpointContract["inputs"]) => diffContracts(mapOf(base), mapOf({ ...base, inputs }), opts());
    expect(d([["q", true, "string"], ["n", false, "integer"], ["must", true, "string"]])).toEqual([expect.objectContaining({ kind: "input_breaking", detail: "new required input must" })]);
    expect(d([["q", true, "string"], ["n", true, "integer"]])).toEqual([expect.objectContaining({ kind: "input_breaking", detail: "input n became required" })]);
    expect(d([["n", false, "integer"]])).toEqual([expect.objectContaining({ kind: "input_breaking", detail: "input q removed" })]);
    expect(d([["q", true, "integer"], ["n", false, "integer"]])).toEqual([expect.objectContaining({ kind: "input_breaking", detail: expect.stringContaining("type string → integer") })]);
    expect(d([["q", true, "string"], ["n", false, "integer"], ["extra", false, "string"]])).toEqual([expect.objectContaining({ kind: "input_additive", detail: "new optional input extra" })]);
    expect(d([["q", true, "string|object"], ["n", false, "integer"]])).toEqual([expect.objectContaining({ kind: "input_additive", detail: expect.stringContaining("widened") })]);
    expect(d([["q", true, "boolean|object"], ["n", false, "integer"]])[0].kind).toBe("input_breaking");
    expect(d([["q", true, "unknown"], ["n", false, "integer"]]).map((x) => x.kind)).toEqual(["suspicious"]);
  });
  it("SCHEMA FINGERPRINT: it changes with any input, list path, cursor path or record field, and not with the id, price or status", () => {
    const a = c({ id: "p.a" });
    const fp = contractFingerprint(a);
    expect(contractFingerprint({ ...a, id: "p.z", costUsd: 9, status: "x", provider: "q" })).toBe(fp);
    for (const ch of [{ inputs: [["q", false, "string"]] as EndpointContract["inputs"] }, { listPath: "data" }, { cursorPath: "after" }, { itemFields: ["id"] }, { itemFields: null }]) expect(contractFingerprint({ ...a, ...ch }), JSON.stringify(ch)).not.toBe(fp);
    // without outputs only the inputs count
    expect(contractFingerprint({ ...a, listPath: "data" }, { outputs: false })).toBe(contractFingerprint(a, { outputs: false }));
  });
  it("OUTPUT changes (two snapshots): a changed list or cursor path, a lost path and lost record fields are breaking; fields no longer stated are «unknown»; nothing is guessed when the live answer states no output", () => {
    const a = c({ id: "p.a" });
    const d = (over: Partial<EndpointContract>, o: Partial<DriftOptions> = {}) => diffContracts(mapOf(a), mapOf({ ...a, ...over }), opts(o));
    expect(d({ listPath: "data" })).toEqual([expect.objectContaining({ kind: "output_breaking", detail: "list path results → data" })]);
    expect(d({ listPath: null })[0].detail).toMatch(/no longer found/);
    expect(d({ cursorPath: "after" })[0].detail).toMatch(/cursor path next → after/);
    expect(d({ itemFields: ["id"] })[0].detail).toMatch(/lost record fields name/);
    expect(d({ itemFields: null })).toEqual([expect.objectContaining({ kind: "output_unknown" })]);
    expect(d({ listPath: "data", cursorPath: "x", itemFields: null }, { outputs: false })).toEqual([]);
  });
  it("PRICE: a changed figure (with its percentage), a changed billing label (said without guessing), and a price that became unknown are all reported", () => {
    const a = c({ id: "p.a", costUsd: 0.01, costType: "per_success" });
    const d = (over: Partial<EndpointContract>) => diffContracts(mapOf(a), mapOf({ ...a, ...over }), opts());
    expect(d({ costUsd: 0.02 })).toEqual([expect.objectContaining({ kind: "price_changed", detail: "0.01 per_success → 0.02 per_success (+100%)" })]);
    expect(d({ costUsd: 0.005 })[0].detail).toMatch(/\(-50%\)/);
    expect(d({ costType: "per_call" })[0].detail).toMatch(/billing label changed: the live answer does not say whether failed or empty calls are billed/);
    expect(diffContracts(mapOf({ ...a, costType: "per_call" }), mapOf({ ...a, costType: "per_success" }), opts())[0].detail).toMatch(/billing label changed/);
    expect(d({ costUsd: 0.02 })[0].detail).not.toMatch(/billing label/);
    expect(d({ costUsd: null })).toEqual([expect.objectContaining({ kind: "price_unknown" })]);
    expect(d({ costUsd: -1 }).map((x) => x.kind).sort()).toEqual(["price_changed", "suspicious"]);
  });
  it("RENAME / DEPRECATION the provider announces: a deprecated or sunset status and a superseded_by are reported with the replacement it names", () => {
    const a = c({ id: "p.a" });
    expect(diffContracts(mapOf(a), mapOf({ ...a, status: "deprecated" }), opts())).toEqual([expect.objectContaining({ kind: "deprecated" })]);
    const sup = diffContracts(mapOf(a), mapOf({ ...a, status: "deprecated", supersededBy: "p.b" }), opts());
    expect(sup).toEqual([expect.objectContaining({ kind: "deprecated", to: "p.b", detail: "deprecated → p.b" })]);
    // an unchanged status is not news
    expect(diffContracts(mapOf({ ...a, status: "deprecated" }), mapOf({ ...a, status: "deprecated" }), opts())).toEqual([]);
    expect(diffContracts(mapOf(a), mapOf({ ...a, status: "beta" }), opts())).toEqual([]);
  });
  it("POLICY: a capability that turns blocked or paused, turns private, or moves to a stricter data-policy category is breaking", () => {
    const a = c({ id: "p.a" });
    expect(diffContracts(mapOf(a), mapOf({ ...a, blocked: true, blockedBy: "connect your own key" }), opts())).toEqual([expect.objectContaining({ kind: "policy_breaking", detail: expect.stringContaining("connect your own key") })]);
    expect(diffContracts(mapOf(c({ id: "p.a", capability: "people.search" })), mapOf(c({ id: "p.a", capability: "people.personal.email" })), opts({ policyOf: () => "public" })).map((x) => x.kind)).toContain("policy_breaking");
    const rank = diffContracts(mapOf(a), mapOf({ ...a }), opts({ policyOf: (_c, side) => (side === "before" ? "public" : "sensitive") }));
    expect(rank).toEqual([expect.objectContaining({ kind: "policy_breaking", detail: "policy public → sensitive" })]);
    expect(diffContracts(mapOf(a), mapOf({ ...a }), opts({ policyOf: (_c, side) => (side === "before" ? "sensitive" : "public") }))).toEqual([]);
  });
  it("breaking kinds are exactly removal, rename, input, output, deprecation and policy", () => {
    expect([...BREAKING_KINDS].sort()).toEqual(["deprecated", "input_breaking", "output_breaking", "policy_breaking", "removed", "renamed"]);
  });
  it("the live answer of TREG and the pinned snapshot read to the same contract for the same endpoint", () => {
    const raw = snapshotById.get("aiark.companies.search")!;
    const fromSnap = contractFromSnapshot(raw);
    expect(fromSnap.id).toBe("aiark.companies.search");
    expect(fromSnap.inputs.length).toBeGreaterThan(0);
    expect(contractFromLive({ endpoint: { id: "x.y", input: { queryParams: { a: { type: "string", required: true } }, body: { b: { type: "array[string]" } } }, cost: { usd: 0.1, type: "per_call" } } })?.inputs).toEqual([["a", true, "string"], ["b", false, "array"]]);
    expect(contractFromLive({})).toBeNull();
    expect(contractFromLive({ endpoint: { input: {} } })).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ 3. impact and safe fallback
const entry = (over: Partial<ArtifactEntry> & { id: string }): ArtifactEntry => ({
  key: `${over.id}#op`, operation: "companies.discover", provider: "treg", sub_provider: "x", access: "treg_direct", platform: null, inputs_required: ["q"], takes: ["keyword"] as any, outputs: ["name", "website"] as any, outputs_known: true, list_path: "results",
  pagination: true, max_rows_per_call: 10, filters: { date: false, country: true, language: false }, pricing: { unit: "row", usd: 0.01, basis: "verified" } as any, usd_per_row: 0.01, policy: "public", privacy: "public",
  verification: { level: "live_verified", evidence: [], notes: [] } as any, reliability: { diger: null, provider_observed: null }, limitations: [], fallback_group: "g1", card: null, schema_fingerprint: "f", ...over,
});
const lvl = (level: string) => ({ level, evidence: [], notes: [] }) as any;
const reg = (...caps: ArtifactEntry[]): RegistryArtifact => ({ _about: "t", version: 1, catalog_source: "t", sources: {}, counts: {} as any, thresholds: {} as any, capabilities: caps, advertised_only: [] });

describe("safe fallback (the only replacement the rules allow)", () => {
  const broken = entry({ id: "p.broken", verification: lvl("production_eligible"), usd_per_row: 0.01 });
  it("proposes a candidate that is at least as verified, public, carries the same constraints, inputs and outputs, and costs no more per row", () => {
    const good = entry({ id: "p.good", verification: lvl("production_eligible"), usd_per_row: 0.008 });
    const v = safeReplacement(broken, reg(broken, good), { minLevel: "schema_checked" });
    expect(v.id).toBe("p.good");
    expect(v.rejected).toEqual([]);
  });
  it.each<[string, Partial<ArtifactEntry>, RegExp]>([
    ["a lower verification tier than a production-eligible capability", { verification: lvl("live_verified") }, /below the tier a replacement needs/],
    ["a broken candidate", { verification: lvl("broken") }, /^level broken$/],
    ["a deprecated candidate", { verification: lvl("deprecated") }, /^level deprecated$/],
    ["a sensitive policy", { policy: "sensitive" }, /policy sensitive/],
    ["a blocked policy", { policy: "blocked" }, /policy blocked/],
    ["private personal data", { privacy: "private_personal" }, /policy/],
    ["a policy stricter than the approved public source", { policy: "b2b_contact" }, /stricter data/],
    ["a missing constraint (the country filter)", { filters: { date: false, country: false, language: false } }, /every constraint/],
    ["a different input class", { takes: ["url"] as any }, /same inputs/],
    ["a missing output", { outputs: ["name"] as any }, /every output/],
    ["outputs that are not documented", { outputs_known: false }, /every output/],
    ["an unknown price", { usd_per_row: null }, /price unknown/],
    ["an unknown price basis", { pricing: { unit: "row", usd: null, basis: "unknown" } as any }, /price unknown/],
    ["a higher price per row", { usd_per_row: 0.02 }, /costs more/],
  ])("refuses %s", (_name, over, why) => {
    const cand = entry({ id: "p.cand", verification: lvl("production_eligible"), ...over });
    const v = safeReplacement(broken, reg(broken, cand), { minLevel: "schema_checked" });
    expect(v.id).toBeNull();
    expect(v.rejected).toEqual([{ id: "p.cand", why: expect.stringMatching(why) }]);
  });
  it("a capability of work contacts (b2b) is never «replaced» by a sensitive or blocked one, and may be replaced by another b2b one", () => {
    const b2b = entry({ id: "p.b2b", policy: "b2b_contact", verification: lvl("production_eligible") });
    for (const policy of ["sensitive", "blocked"] as const) {
      const cand = entry({ id: "p.cand", policy, verification: lvl("production_eligible") });
      expect(safeReplacement(b2b, reg(b2b, cand), { minLevel: "schema_checked" })).toMatchObject({ id: null, rejected: [{ id: "p.cand", why: `policy ${policy}/public` }] });
    }
    expect(safeReplacement(b2b, reg(b2b, entry({ id: "p.ok", policy: "b2b_contact", verification: lvl("production_eligible") })), { minLevel: "schema_checked" }).id).toBe("p.ok");
  });
  it("refuses a candidate that itself changed in the same sync, and one from another fallback group", () => {
    const cand = entry({ id: "p.cand", verification: lvl("production_eligible") });
    expect(safeReplacement(broken, reg(broken, cand), { minLevel: "schema_checked", drifting: new Set(["p.cand"]) }).rejected[0].why).toMatch(/itself changed/);
    expect(safeReplacement(broken, reg(broken, { ...cand, fallback_group: "other" }), { minLevel: "schema_checked" })).toMatchObject({ id: null, rejected: [] });
  });
  it("an approved price is never increased: the plan's own price per row is the ceiling", () => {
    const cand = entry({ id: "p.cand", verification: lvl("production_eligible"), usd_per_row: 0.009 });
    expect(safeReplacement(broken, reg(broken, cand), { minLevel: "schema_checked", maxUsdPerRow: 0.01 }).id).toBe("p.cand");
    expect(safeReplacement(broken, reg(broken, cand), { minLevel: "schema_checked", maxUsdPerRow: 0.005 })).toMatchObject({ id: null });
  });
  it("a capability that is not production-eligible may be replaced by one that is at least as verified (never below its own tier or the minimum)", () => {
    const weak = entry({ id: "p.weak", verification: lvl("schema_checked") });
    const same = entry({ id: "p.same", verification: lvl("schema_checked") });
    const lower = entry({ id: "p.lower", verification: lvl("advertised") });
    // p.lower sorts first and is refused for its tier; p.same is then proposed
    expect(safeReplacement(weak, reg(weak, same, lower), { minLevel: "schema_checked" })).toMatchObject({ id: "p.same", rejected: [{ id: "p.lower", why: expect.stringMatching(/below/) }] });
    expect(safeReplacement(weak, reg(weak, lower), { minLevel: "schema_checked" }).rejected[0].why).toMatch(/below/);
  });
  it("HONEST when none exists: the verdict says so and substitutes nothing", () => {
    const v = safeReplacement(broken, reg(broken), { minLevel: "schema_checked" });
    expect(v).toEqual({ id: null, reason: expect.stringMatching(/^no safe replacement: the limitation is reported; nothing is substituted$/), rejected: [] });
  });
  it("candidates are tried in a fixed order, so the same registry always gives the same answer", () => {
    const a = entry({ id: "p.a", verification: lvl("production_eligible") });
    const b = entry({ id: "p.b", verification: lvl("production_eligible") });
    expect(safeReplacement(broken, reg(broken, b, a), { minLevel: "schema_checked" }).id).toBe("p.a");
    expect(safeReplacement(broken, reg(broken, a, b), { minLevel: "schema_checked" }).id).toBe("p.a");
  });
});

describe("impact on the capabilities and the approved plans", () => {
  const prod = entry({ id: "p.prod", verification: lvl("production_eligible"), usd_per_row: 0.01 });
  const other = entry({ id: "p.other", verification: lvl("live_verified") });
  const alt = entry({ id: "p.alt", verification: lvl("production_eligible"), usd_per_row: 0.012 });
  it("joins a change with the capabilities that call the endpoint, the plans that use it, and the review it needs", () => {
    const rows = impactOf([{ id: "p.prod", kind: "removed", detail: "gone" }, { id: "p.other", kind: "price_changed", detail: "x" }, { id: "p.unknown", kind: "removed", detail: "gone" }], reg(prod, other, alt), [{ ref: "plan-7", endpointIds: ["p.prod"] }, { ref: "plan-1", endpointIds: ["p.prod", "p.other"] }]);
    const byId = Object.fromEntries(rows.map((r) => [r.change.id, r]));
    expect(byId["p.prod"].capabilities).toEqual([{ key: "p.prod#op", level: "production_eligible", productionEligible: true }]);
    expect(byId["p.prod"].plans).toEqual(["plan-1", "plan-7"]);
    expect(byId["p.prod"].reviewRequired).toBe(true);
    expect(byId["p.other"].reviewRequired).toBe(false);
    expect(byId["p.other"].replacement).toBeNull();
    // an id that is not a registry capability: reported, no replacement is invented
    expect(byId["p.unknown"]).toMatchObject({ capabilities: [], replacement: null, reviewRequired: false });
  });
  it("the plan's approved price per row caps the replacement", () => {
    const withPlan = (usd: number) => impactOf([{ id: "p.prod", kind: "removed", detail: "gone" }], reg(prod, alt), [{ ref: "plan-1", endpointIds: ["p.prod"], usdPerRowOf: () => usd }])[0].replacement;
    expect(withPlan(0.02)).toMatchObject({ id: "p.alt" });
    expect(withPlan(0.011)).toMatchObject({ id: null, rejected: [{ id: "p.alt", why: expect.stringMatching(/costs more/) }] });
  });
  it("a non-breaking change gets no replacement; a breaking one on a plan requires review even when not production-eligible", () => {
    const r1 = impactOf([{ id: "p.other", kind: "price_changed", detail: "x" }], reg(other), [{ ref: "p1", endpointIds: ["p.other"] }])[0];
    expect(r1).toMatchObject({ replacement: null, reviewRequired: false });
    const r2 = impactOf([{ id: "p.other", kind: "input_breaking", detail: "x" }], reg(other), [{ ref: "p1", endpointIds: ["p.other"] }])[0];
    expect(r2.reviewRequired).toBe(true);
    expect(r2.replacement).toMatchObject({ id: null });
  });
  it("a capability that broke is never proposed as the replacement of another capability that broke in the same sync", () => {
    const a = entry({ id: "p.a", verification: lvl("production_eligible") });
    const b = entry({ id: "p.b", verification: lvl("production_eligible") });
    const rows = impactOf([{ id: "p.a", kind: "removed", detail: "" }, { id: "p.b", kind: "removed", detail: "" }], reg(a, b));
    expect(rows.map((r) => r.replacement!.id)).toEqual([null, null]);
    expect(rows[0].replacement!.rejected).toEqual([{ id: "p.b", why: "itself changed in this sync" }]);
  });
});

// ------------------------------------------------------------------------------------------------ 4. the whole sync on stored answers
describe("the committed baseline and the pinned data", () => {
  it("the baseline covers exactly the registry's TREG ids and states its sources", () => {
    expect(baseline.version).toBe(1);
    expect(Object.keys(baseline.treg.contracts).sort()).toEqual(tregIds);
    expect(baseline.treg.treg_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(baseline.web.firecrawl?.summary.paths.length).toBeGreaterThan(20);
    expect(baseline.web.contextdev?.summary.enums[CONTEXTDEV_PARSER_ENUM].length).toBeGreaterThan(10);
  });
  it("every parser and path Diger calls is in the provider's public API as the baseline recorded it", () => {
    const parsers = baseline.web.contextdev!.summary.enums[CONTEXTDEV_PARSER_ENUM];
    for (const p of Object.values(PARSERS)) expect(parsers, `parser ${p.name}`).toContain(p.name);
    const drifts = [
      ...diffWebProvider("firecrawl", baseline.web.firecrawl!.summary, baseline.web.firecrawl!.summary, USED_WEB_CALLS),
      ...diffWebProvider("contextdev", baseline.web.contextdev!.summary, baseline.web.contextdev!.summary, USED_WEB_CALLS, CONTEXTDEV_PARSER_ENUM),
    ];
    expect(drifts.filter((d) => d.breaking)).toEqual([]);
  });
  it("the list of calls the sync watches matches the adapters that make them", () => {
    const fc = ["firecrawl.ts"].flatMap((f) => (existsSync(path.join(ROOT, "src/lib/server/multiProvider/adapters", f)) ? [read(`src/lib/server/multiProvider/adapters/${f}`)] : [])).join("\n");
    const cx = read("src/lib/server/multiProvider/adapters/contextdev.ts") + read("src/lib/server/multiProvider/adapters/contextdevParse.ts");
    for (const frag of ["/web/scrape", "/web/urls", "/people/search"]) expect(cx, frag).toContain(frag);
    expect(cx).toMatch(/\/web\/search|search/);
    expect(fc.length + read("src/lib/multiProvider/catalog.ts").length).toBeGreaterThan(0);
    expect(read("src/lib/multiProvider/catalog.ts")).toContain("https://api.firecrawl.dev/v2");
    expect(read("src/lib/multiProvider/catalog.ts")).toContain("https://api.context.dev/v1");
    expect(USED_WEB_CALLS.filter((u) => !u.parser).map((u) => `${u.provider} ${u.method} ${u.path}`).sort()).toEqual([
      "contextdev GET /v1/web/urls", "contextdev POST /v1/people/search", "contextdev POST /v1/web/scrape", "contextdev POST /v1/web/search", "firecrawl POST /v2/map", "firecrawl POST /v2/scrape", "firecrawl POST /v2/search",
    ]);
  });
});

describe("the sync on stored answers", () => {
  it("nothing changed: a sync against the baseline it came from reports nothing, and asks only for public metadata", async () => {
    const w = world();
    const r = await run(w);
    expect(r.rows).toEqual([]);
    expect(r.webRows).toEqual([]);
    expect(r.web.map((x) => x.drifts)).toEqual([[], []]);
    expect(r.treg).toMatchObject({ comparedWith: "baseline", checked: tregIds.length, live: tregIds.length, gone: [], failed: [], massNotFound: false, metaFetched: true });
    expect(w.calls.length).toBe(tregIds.length + 6);
    for (const u of w.calls) expect(isMetadataUrl(u), u).toBe(true);
    expect(new Set(w.calls).size).toBe(w.calls.length);
    expect(r.baselineNext.treg.contracts).toEqual(baseline.treg.contracts);
  });
  it("is deterministic: the same answers give the same report, byte for byte, and never read the clock", async () => {
    const a = renderReport(await run(world()));
    const b = renderReport(await run(world()));
    expect(a).toBe(b);
    expect(a).toContain("# Provider metadata sync, 2026-11-14");
  });
  it("does not change what it was given (registry, snapshot, baseline)", async () => {
    const before = JSON.stringify([registry, baseline]);
    const w = world();
    setLive(w, pick(), (e) => { e.cost = { usd: 5, type: "per_call" }; });
    await run(w);
    expect(JSON.stringify([registry, baseline])).toBe(before);
  });

  it("REMOVAL: a clear «unknown endpoint» answer is a removal, reported with its capabilities and a replacement verdict; the last known-good contract is kept", async () => {
    const id = pick("production_eligible");
    const w = world();
    w.answers.set(metadataUrls.tregEndpoint(id), { status: 404, text: JSON.stringify({ detail: { error: `unknown endpoint '${id}'`, did_you_mean: [] } }) });
    const r = await run(w);
    const row = r.rows.find((x) => x.change.id === id)!;
    expect(row.change.kind).toBe("removed");
    expect(row.capabilities[0]).toMatchObject({ level: "production_eligible", productionEligible: true });
    expect(row.reviewRequired).toBe(true);
    expect(row.replacement).not.toBeNull();
    expect(r.treg.gone).toEqual([id]);
    expect(r.baselineNext.treg.contracts[id]).toEqual(baseline.treg.contracts[id]);
    const md = renderReport(r);
    expect(md).toContain(`\`${id}\``);
    expect(md).toMatch(/\*\*required\*\*/);
  });
  it("RENAME: the removed id and a new id with the same contract are one rename, and the new id is never selectable", async () => {
    const id = pick("production_eligible");
    const w = world();
    w.answers.set(metadataUrls.tregEndpoint(id), { status: 404, text: JSON.stringify({ detail: { error: `unknown endpoint '${id}'` } }) });
    const twin = { ...liveOf(w, pick("production_eligible", new Set([id]))).endpoint };
    // the new id carries the removed endpoint's own contract
    const old = toLive(baseline.treg.contracts[id], new Set(baseline.treg.paused_providers)).endpoint;
    const renamed = { ...old, id: `${id}.v2` };
    expect(twin.id).not.toBe(id);
    w.answers.set(metadataUrls.tregSearch, { status: 200, text: JSON.stringify({ total: 1, count: 1, results: [renamed] }) });
    const r = await run(w);
    const row = r.rows.find((x) => x.change.id === id)!;
    expect(row.change).toMatchObject({ kind: "renamed", to: `${id}.v2` });
    expect(r.rows.some((x) => x.change.id === `${id}.v2`)).toBe(false);
    expect(registry.capabilities.some((x) => x.id === `${id}.v2`)).toBe(false);
  });
  it("A FAILED REQUEST IS NEVER A REMOVAL: a 500, a 429, a network error, an unreadable answer and an HTML 404 are «unverified», and the last known-good metadata is kept", async () => {
    const ids = tregIds.slice(0, 5);
    const w = world();
    w.answers.set(metadataUrls.tregEndpoint(ids[0]), { status: 500, text: "oops" });
    w.answers.set(metadataUrls.tregEndpoint(ids[1]), { status: 429, text: "slow down" });
    w.answers.set(metadataUrls.tregEndpoint(ids[2]), "fail");
    w.answers.set(metadataUrls.tregEndpoint(ids[3]), { status: 200, text: "<html>maintenance</html>" });
    w.answers.set(metadataUrls.tregEndpoint(ids[4]), { status: 404, text: "<html>Not Found</html>" });
    const r = await run(w);
    expect(r.treg.failed.map((f) => f.id).sort()).toEqual([...ids].sort());
    expect(r.treg.gone).toEqual([]);
    expect(r.rows.filter((x) => ids.includes(x.change.id)).map((x) => x.change.kind)).toEqual(Array(5).fill("unverified"));
    expect(r.rows.some((x) => BREAKING_KINDS.has(x.change.kind))).toBe(false);
    for (const id of ids) expect(r.baselineNext.treg.contracts[id]).toEqual(baseline.treg.contracts[id]);
    expect(renderReport(r)).toMatch(/Unverified \(a failed request is never a removal/);
  });
  it("a 404 that is not TREG's «unknown endpoint» answer is not a removal either", async () => {
    const id = tregIds[3];
    const w = world();
    w.answers.set(metadataUrls.tregEndpoint(id), { status: 404, text: JSON.stringify({ detail: "Not Found" }) });
    const r = await run(w);
    expect(r.treg.gone).toEqual([]);
    expect(r.treg.failed).toEqual([{ id, why: "HTTP 404" }]);
  });
  it("a wave of «unknown endpoint» (an outage or a catalog reset) is treated as an outage, never as a mass removal", async () => {
    const w = world();
    for (const id of tregIds.slice(0, 150)) w.answers.set(metadataUrls.tregEndpoint(id), { status: 404, text: JSON.stringify({ detail: { error: `unknown endpoint '${id}'` } }) });
    const r = await run(w);
    expect(r.treg.massNotFound).toBe(true);
    expect(r.treg.gone).toEqual([]);
    expect(r.treg.failed.length).toBe(150);
    expect(r.rows.some((x) => x.change.kind === "removed")).toBe(false);
    expect(renderReport(r)).toMatch(/treated as an outage; no removal was concluded/);
  });
  it("a few removals below the wave threshold are still reported", async () => {
    const w = world();
    const gone = tregIds.slice(10, 13);
    for (const id of gone) w.answers.set(metadataUrls.tregEndpoint(id), { status: 404, text: JSON.stringify({ detail: { error: `unknown endpoint '${id}'` } }) });
    const r = await run(w);
    expect(r.treg.gone.sort()).toEqual([...gone].sort());
    expect(r.rows.filter((x) => x.change.kind === "removed").length).toBe(3);
  });
  it("an answer for another id is unreadable, not a change", async () => {
    const [a, b] = tregIds;
    const w = world();
    w.answers.set(metadataUrls.tregEndpoint(a), w.answers.get(metadataUrls.tregEndpoint(b))!);
    const r = await run(w);
    expect(r.treg.failed).toEqual([{ id: a, why: expect.stringMatching(/another id/) }]);
  });
  it("with no stored answer at all (offline folder empty) everything is unverified and the baseline is returned unchanged", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sync-empty-"));
    const r = await run(world(), { fetchText: createOfflineFetcher(dir) });
    expect(r.treg.live).toBe(0);
    expect(r.treg.failed.length).toBe(tregIds.length);
    expect(r.treg.gone).toEqual([]);
    expect(r.rows.every((x) => x.change.kind === "unverified")).toBe(true);
    expect(r.web.every((x) => !x.fetched)).toBe(true);
    expect(r.web.flatMap((x) => x.drifts).every((d) => d.kind === "unverified" && !d.breaking)).toBe(true);
    expect(r.webRows).toEqual([]);
    expect(r.baselineNext.treg).toEqual({ ...baseline.treg });
    expect(r.baselineNext.web).toEqual(baseline.web);
  });
  it("a failed /meta keeps the last known paused providers and version (never «nothing is paused»)", async () => {
    const w = world();
    w.answers.set(metadataUrls.tregMeta, { status: 503, text: "down" });
    const r = await run(w);
    expect(r.treg.metaFetched).toBe(false);
    expect(r.treg.pausedProviders).toEqual([...baseline.treg.paused_providers].sort());
    expect(r.baselineNext.treg.treg_version).toBe(baseline.treg.treg_version);
    expect(r.rows).toEqual([]);
  });
  it("BREAKING SCHEMA: a new required input on a production-eligible capability is reported, with the plan that uses it and its fallback", async () => {
    const id = pick("production_eligible");
    const w = world();
    setLive(w, id, (e) => { e.input.body.mandatory_new = { type: "string", required: true }; });
    const r = await run(w, { plans: [{ ref: "plan-A", endpointIds: [id], usdPerRowOf: () => 1 }] });
    const row = r.rows.find((x) => x.change.id === id)!;
    expect(row.change).toMatchObject({ kind: "input_breaking", detail: "new required input mandatory_new" });
    expect(row.plans).toEqual(["plan-A"]);
    expect(row.reviewRequired).toBe(true);
    expect(row.replacement).not.toBeNull();
    const md = renderReport(r);
    expect(md).toContain("Changes on production-eligible capabilities");
    expect(md).toContain("plan-A");
  });
  it("PRICE METADATA: a doubled price, a price that vanished and a changed billing label are reported with their percentages, and change nothing", async () => {
    const a = pick(undefined, new Set(), true);
    const b = pick(undefined, new Set([a]), true);
    const d = tregIds.find((x) => baseline.treg.contracts[x].costType === "per_success" && (baseline.treg.contracts[x].costUsd ?? 0) > 0 && !baseline.treg.contracts[x].blocked && x !== a && x !== b)!;
    const w = world();
    setLive(w, a, (e) => { e.cost = { usd: (baseline.treg.contracts[a].costUsd ?? 0.01) * 2, type: baseline.treg.contracts[a].costType }; });
    setLive(w, b, (e) => { delete e.cost; });
    setLive(w, d, (e) => { e.cost = { usd: baseline.treg.contracts[d].costUsd, type: "per_call" }; });
    const r = await run(w);
    const by = (id: string) => r.rows.find((x) => x.change.id === id)!.change;
    expect(by(a)).toMatchObject({ kind: "price_changed", detail: expect.stringContaining("(+100%)") });
    expect(by(b).kind).toBe("price_unknown");
    expect(by(d).detail).toMatch(/billing label changed/);
    expect(r.rows.some((x) => BREAKING_KINDS.has(x.change.kind))).toBe(false);
  });
  it("DEPRECATION and RENAME announced by TREG: status and superseded_by are reported with the id it names", async () => {
    const id = pick("production_eligible");
    const w = world();
    setLive(w, id, (e) => { e.status = "deprecated"; e.superseded_by = "someone.new.endpoint"; });
    const r = await run(w);
    expect(r.rows.find((x) => x.change.id === id)!.change).toMatchObject({ kind: "deprecated", to: "someone.new.endpoint" });
  });
  it("POLICY: a provider that TREG now pauses, and an endpoint it no longer offers on its platform key, are breaking, with TREG's own reason", async () => {
    const id = pick("production_eligible");
    const provider = baseline.treg.contracts[id].provider;
    const w = world();
    w.answers.set(metadataUrls.tregMeta, { status: 200, text: JSON.stringify({ treg_version: "0.31.0", paused_providers: { ...Object.fromEntries(baseline.treg.paused_providers.map((p) => [p, {}])), [provider]: { message: "paused" } } }) });
    const r = await run(w);
    const mine = r.rows.filter((x) => x.change.id.startsWith(`${provider}.`) && x.change.kind === "policy_breaking");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.find((x) => x.change.id === id)!.change.detail).toMatch(/no longer available through TREG's platform key/);
    expect(r.baselineNext.treg.treg_version).toBe("0.31.0");
    const w2 = world();
    const other = pick(undefined, new Set([id]));
    setLive(w2, other, (e) => { e.platform_blocked = "Connect your own key for this tool."; });
    const r2 = await run(w2);
    expect(r2.rows.find((x) => x.change.id === other)!.change.detail).toContain("Connect your own key for this tool.");
  });
  it("ADDITIONS: a new TREG endpoint is listed with its data-policy category, never enters the registry and never changes the baseline's contracts", async () => {
    const w = world();
    const live = (id: string, capability: string, extra: Record<string, any> = {}) => ({ id, provider: id.split(".")[0], capability, name: capability, summary: capability, scope: "any_account", input: { body: { q: { type: "string", required: true } } }, cost: { usd: 0.002, type: "per_call" }, ...extra });
    w.answers.set(metadataUrls.tregSearch, { status: 200, text: JSON.stringify({ total: 3, count: 3, results: [live("newco.companies.search", "companies.search"), live("newco.people.email.find", "people.email.find"), live("newco.people.reverse.email", "people.reverse.email")] }) });
    const r = await run(w);
    expect(r.added.map((a) => `${a.id}:${a.policy}`).sort()).toEqual(["newco.companies.search:public", "newco.people.email.find:b2b_contact", "newco.people.reverse.email:sensitive"]);
    expect(r.treg.searchComplete).toBe(true);
    expect(Object.keys(r.baselineNext.treg.contracts)).not.toContain("newco.companies.search");
    expect(registry.capabilities.some((x) => x.id.startsWith("newco."))).toBe(false);
    expect(renderReport(r)).toContain("never selectable until a reviewed PR adds them with evidence");
    // a partial listing is said to be partial
    w.answers.set(metadataUrls.tregSearch, { status: 200, text: JSON.stringify({ total: 188, count: 1, results: [live("newco.a.b", "a.b")] }) });
    expect((await run(w)).treg.searchComplete).toBe(false);
    w.answers.set(metadataUrls.tregSearch, "fail");
    const failed = await run(w);
    expect(failed.added).toEqual([]);
    expect(renderReport(failed)).toMatch(/partial or failed/);
  });
  it("an endpoint the PINNED SNAPSHOT already holds (but the registry does not use) is not «added» either", async () => {
    const used = new Set(tregIds);
    const raw = snapshot.find((e) => !used.has(String(e.id)) && !baseline.treg.contracts[String(e.id)])!;
    const w = world();
    w.answers.set(metadataUrls.tregSearch, { status: 200, text: JSON.stringify({ total: 1, count: 1, results: [{ ...raw, cost: raw.cost, input: { body: { q: { type: "string", required: false } } } }] }) });
    const r = await run(w);
    expect(r.added).toEqual([]);
    expect(r.rows).toEqual([]);
  });
  it("an endpoint the registry already knows is not «added», even when the search lists it", async () => {
    const id = pick();
    const w = world();
    w.answers.set(metadataUrls.tregSearch, { status: 200, text: JSON.stringify({ total: 1, count: 1, results: [toLive(baseline.treg.contracts[id], new Set()).endpoint] }) });
    expect((await run(w)).added).toEqual([]);
  });

  // ---- 6.1 / 6.2 for the web providers
  const withoutPath = (fixtureName: string, p: string) => { const j = JSON.parse(fx(fixtureName)); delete j.paths[p]; return JSON.stringify(j); };
  it("FIRECRAWL: a removed /scrape path is breaking for the capability that stands on it, with an honest fallback verdict; an unrelated removed path is not", async () => {
    const w = world();
    w.answers.set(metadataUrls.firecrawlSpec, { status: 200, text: withoutPath("firecrawl-openapi.min.json", "/scrape") });
    const r = await run(w);
    const fc = r.web.find((x) => x.provider === "firecrawl")!;
    expect(fc.drifts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "path_removed", breaking: true, detail: expect.stringContaining("POST /v2/scrape") })]));
    const row = r.webRows.find((x) => x.change.id === "firecrawl.scrape")!;
    expect(row.change.kind).toBe("removed");
    expect(row.capabilities.length).toBe(1);
    expect(row.replacement).not.toBeNull();
    if (row.replacement!.id === null) expect(row.replacement!.reason).toMatch(/^no safe replacement/);
    else expect(registry.capabilities.find((x) => x.id === row.replacement!.id)!.fallback_group).toBe(row.capabilities[0] && registry.capabilities.find((x) => x.id === "firecrawl.scrape")!.fallback_group);
    const quiet = world();
    quiet.answers.set(metadataUrls.firecrawlSpec, { status: 200, text: withoutPath("firecrawl-openapi.min.json", "/team/queue-status") });
    const q = await run(quiet);
    expect(q.web.find((x) => x.provider === "firecrawl")!.drifts.every((d) => !d.breaking)).toBe(true);
    expect(q.webRows).toEqual([]);
  });
  it("CONTEXT.DEV: a removed /web/scrape breaks the scrape capability AND every prebuilt parser that rides on it; a removed parser breaks only that parser", async () => {
    const w = world();
    w.answers.set(metadataUrls.contextdevSpec, { status: 200, text: withoutPath("contextdev-openapi.min.json", "/web/scrape") });
    const r = await run(w);
    const ids = r.webRows.map((x) => x.change.id).sort();
    expect(ids).toContain("contextdev.scrape");
    expect(ids.filter((i) => i.startsWith("contextdev.parse.")).length).toBe(registry.capabilities.filter((e) => e.id.startsWith("contextdev.parse.")).map((e) => e.id).filter((v, i, a) => a.indexOf(v) === i).length);
    const w2 = world();
    const spec = JSON.parse(fx("contextdev-openapi.min.json"));
    const parsers: string[] = spec.components.schemas.ScrapeParseParams.oneOf[1].properties.parser.enum;
    spec.components.schemas.ScrapeParseParams.oneOf[1].properties.parser.enum = parsers.filter((p) => p !== "google-maps");
    w2.answers.set(metadataUrls.contextdevSpec, { status: 200, text: JSON.stringify(spec) });
    const r2 = await run(w2);
    expect(r2.web.find((x) => x.provider === "contextdev")!.drifts).toEqual([expect.objectContaining({ kind: "parser_removed", breaking: true, detail: expect.stringContaining("parser google-maps") })]);
    expect(r2.webRows.map((x) => x.change.id)).toEqual(["contextdev.parse.google-maps"]);
    const w3 = world();
    w3.answers.set(metadataUrls.contextdevSpec, { status: 200, text: withoutPath("contextdev-openapi.min.json", "/people/search") });
    expect((await run(w3)).webRows.map((x) => x.change.id)).toEqual(["contextdev.people.search"]);
  });
  it("a parser the provider ADDS is reported as «offered, not implemented»; a changed version is reported; neither activates anything", async () => {
    const w = world();
    const spec = JSON.parse(fx("contextdev-openapi.min.json"));
    spec.components.schemas.ScrapeParseParams.oneOf[1].properties.parser.enum.push("brand-new-parser");
    spec.info.version = "1.1.0";
    w.answers.set(metadataUrls.contextdevSpec, { status: 200, text: JSON.stringify(spec) });
    const r = await run(w);
    const d = r.web.find((x) => x.provider === "contextdev")!.drifts;
    expect(d.map((x) => x.kind).sort()).toEqual(["parser_added", "version_changed"]);
    expect(d.every((x) => !x.breaking)).toBe(true);
    expect(d.find((x) => x.kind === "parser_added")!.detail).toMatch(/not implemented in Diger/);
    expect(r.webRows).toEqual([]);
  });
  it("a public OpenAPI that cannot be fetched or read is «unverified», never a removal, and the baseline is kept", async () => {
    for (const bad of ["fail", { status: 500, text: "x" }, { status: 200, text: "<html>" }, { status: 200, text: "{\"paths\": 3}" }] as const) {
      const w = world();
      w.answers.set(metadataUrls.firecrawlSpec, bad as any);
      const r = await run(w);
      const fc = r.web.find((x) => x.provider === "firecrawl")!;
      expect(fc.fetched).toBe(false);
      expect(fc.drifts).toEqual([expect.objectContaining({ kind: "unverified", breaking: false })]);
      expect(r.webRows).toEqual([]);
      expect(r.baselineNext.web.firecrawl).toEqual(baseline.web.firecrawl);
      expect(renderReport(r)).toMatch(/NOT FETCHED: unverified, baseline kept/);
    }
  });
  it("a moved parser list is «not found», never «no parsers»", () => {
    const summary = summarizeOpenApi({ info: { version: "1" }, servers: [{ url: "https://api.context.dev/v1" }], paths: { "/web/scrape": { post: {} } } })!;
    const d = diffWebProvider("contextdev", null, summary, USED_WEB_CALLS, CONTEXTDEV_PARSER_ENUM);
    expect(d.filter((x) => x.kind === "unverified")).toEqual([expect.objectContaining({ breaking: false, detail: expect.stringContaining("not found") })]);
    expect(d.some((x) => x.kind === "parser_removed" || x.kind === "parser_added")).toBe(false);
  });
  it("CHANGELOGS: items newer than the baseline are listed, and one that announces a removal is marked for a human to read", async () => {
    const w = world();
    const old = { ...baseline, web: { ...baseline.web, firecrawl: { ...baseline.web.firecrawl!, changelog_latest: "2026-11-01" }, contextdev: { ...baseline.web.contextdev!, changelog_latest: "2026-11-01" } } };
    const r = await run(w, { baseline: old });
    const fc = r.web.find((x) => x.provider === "firecrawl")!;
    expect(fc.feed.map((i) => i.date)).toEqual(["2026-11-12", "2026-11-11", "2026-11-09"]);
    expect(fc.feed.filter((i) => i.breaking).map((i) => i.title)).toEqual(["The /extract endpoint is being retired"]);
    expect(fc.feed.find((i) => i.breaking)!.note).toMatch(/removed on December 10, 2026/);
    expect(fc.feed.find((i) => i.title.startsWith("AI/ML"))!.title).toBe("AI/ML Research Index in ChatGPT & Claude");
    const cx = r.web.find((x) => x.provider === "contextdev")!;
    expect(cx.feed.map((i) => i.summary)).toEqual(["Zero data retention for People Search", "Yelp parsers renamed"]);
    expect(cx.feed.find((i) => i.breaking)!.note).toMatch(/renamed to yelp-businesses/);
    expect(renderReport(r)).toMatch(/mentions a removal, deprecation or breaking change, read it/);
  });
  it("a feed that cannot be read is an empty list, never an error; the first sync (no baseline date) lists only the last 30 days", async () => {
    expect(feedItems("not xml at all")).toEqual([]);
    expect(feedItems("")).toEqual([]);
    const w = world();
    const first = await run(w, { baseline: { ...baseline, web: { firecrawl: { ...baseline.web.firecrawl!, changelog_latest: null }, contextdev: baseline.web.contextdev } } });
    expect(first.web.find((x) => x.provider === "firecrawl")!.feed.map((i) => i.date)).toEqual(["2026-11-12", "2026-11-11", "2026-11-09"]);
    expect(newFeedItems(null, [{ title: "x", date: "2026-01-01", link: null, summary: "", note: "" }]).length).toBe(1);
    expect(newFeedItems("2026-01-01", [{ title: "x", date: "2026-01-01", link: null, summary: "", note: "" }])).toEqual([]);
    expect(newFeedItems("2026-01-01", [{ title: "x", date: null, link: null, summary: "", note: "" }])).toEqual([]);
  });
  it("«remove» alone is not a breaking announcement; a retirement, deprecation or rename is", () => {
    const mk = (body: string) => feedItems(`<rss><channel><item><title>T</title><pubDate>Mon, 09 Nov 2026 09:00:00 GMT</pubDate><description>${body}</description></item></channel></rss>`)[0];
    expect(mk("Search, Answers, and News remove blocked results instead.").note).toBe("");
    expect(mk("Zero data retention for brand retrieval.").note).toBe("");
    for (const t of ["The endpoint will be removed on 2026-12-10.", "This is deprecated.", "It has been renamed to x.", "No longer supported after March.", "A breaking change to the cursor.", "This is the end of life for v1."]) expect(mk(t).note, t).not.toBe("");
  });
  it("the sync's own request list never includes a billable address (every url asked is in the public allowlist)", async () => {
    const w = world();
    await run(w);
    expect(w.calls.filter((u) => !isMetadataUrl(u))).toEqual([]);
    expect(w.calls.filter((u) => /\/call\b|api\.firecrawl|api\.context|\/v2\/scrape|\/web\/scrape/.test(u))).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ 5. the command: files it may write, files it must not touch
describe("the command", () => {
  const PROTECTED = ["data/capabilities/registry.json", "data/capabilities/production-eligible.json", "data/capabilities/deprecated.json", "data/capabilities/reliability-snapshot.json", "data/capabilities/provider-metadata.json", "data/treg/treg_catalog_sellable.json", "data/treg/data_policy.json"];
  function storedWorld(dir: string): number {
    const w = world();
    let n = 0;
    for (const [url, a] of w.answers) { if (a !== "fail") { storedAnswer(dir, url, a.status, a.text); n += 1; } }
    return n;
  }
  it("replays stored answers, writes only the report and the baseline it is told to, and leaves every protected data file byte for byte as it was", async () => {
    const before = Object.fromEntries(PROTECTED.map((f) => [f, sha(f)]));
    const dir = mkdtempSync(path.join(os.tmpdir(), "sync-run-"));
    const answers = path.join(dir, "answers");
    expect(storedWorld(answers)).toBe(tregIds.length + 6);
    const out = path.join(dir, "report.md");
    const bl = path.join(dir, BASELINE_FILE_NAME);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // first run: no baseline file, so the pinned snapshot is the «before»
    expect(await main(["--date", "2026-11-14", "--offline", answers, "--out", out, "--baseline", bl, "--write-baseline"])).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    const written = JSON.parse(readFileSync(bl, "utf8")) as ProviderBaseline;
    expect(Object.keys(written.treg.contracts).sort()).toEqual(tregIds);
    expect(readFileSync(out, "utf8")).toMatch(/Compared with \| pinned snapshot/);
    // second run against the baseline it just wrote: nothing to report
    const out2 = path.join(dir, "report2.md");
    expect(await main(["--date", "2026-11-14", "--offline", answers, "--out", out2, "--baseline", bl])).toBe(0);
    const second = readFileSync(out2, "utf8");
    expect(second).toMatch(/Compared with \| baseline/);
    expect(second).toMatch(/Breaking changes on capabilities Diger uses \| 0 \|/);
    expect(readdirSync(dir).sort()).toEqual(["answers", "report.md", "report2.md", BASELINE_FILE_NAME].sort());
    for (const f of PROTECTED) expect(sha(f), f).toBe(before[f]);
    log.mockRestore();
  });
  it("refuses a baseline file that is not named provider-metadata.json (it can never be pointed at registry.json)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sync-bad-"));
    expect(await main(["--offline", dir, "--baseline", path.join(ROOT, "data/capabilities/registry.json"), "--write-baseline"])).toBe(2);
    expect(await main(["--offline", dir, "--baseline", path.join(ROOT, "data/capabilities/production-eligible.json"), "--write-baseline"])).toBe(2);
    err.mockRestore();
  });
  it("--save stores what a live run receives, so it can be replayed offline without a second request", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sync-save-"));
    const w = world();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const saved = path.join(dir, "saved");
    expect(await main(["--date", "2026-11-14", "--save", saved, "--out", path.join(dir, "r.md"), "--baseline", path.join(dir, BASELINE_FILE_NAME)], w.fetcher)).toBe(0);
    expect(readdirSync(saved).length).toBe(tregIds.length + 6);
    const replay = await runProviderSync({ registry, snapshot, writeIds, baseline, fetchText: createOfflineFetcher(saved), date: "2026-11-14" });
    expect(replay.treg.live).toBe(tregIds.length);
    expect(replay.rows).toEqual([]);
    log.mockRestore();
  });
  it("the committed report states what it did not do, and the sync changed no protected status: nothing is production-eligible or routed by it", () => {
    const md = read("docs/capabilities/sync-2026-11-14.md");
    expect(md).toContain("# Provider metadata sync, 2026-11-14");
    expect(md).toContain("What this report did not do");
    expect(md).toContain("No registry entry, production-eligible list, price, budget, route or customer-facing text was changed.");
    expect(md).toContain("Nothing below was activated, promoted, re-priced or re-routed");
    expect(md.replace("Nothing below was activated, promoted, re-priced or re-routed", "")).not.toMatch(/\bwas activated\b|\bwas promoted\b|\bhas been (?:activated|promoted)\b/);
    expect(registry.counts.production_eligible).toBe(20);
    expect((JSON.parse(read("data/capabilities/production-eligible.json")) as { ids: string[] }).ids.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------------------------------------ 6. the data policy still classifies what the sync classifies
describe("the data-policy rules the sync uses", () => {
  it("the same classifier that built data_policy.json decides «now sensitive» for a live endpoint", () => {
    expect(classify({ id: "x.people.reverse.email", provider: "x", capability: "people.reverse.email", name: "", summary: "" }, { writeIds }).category).toBe("sensitive");
    expect(classify({ id: "x.companies.search", provider: "x", capability: "companies.search", name: "", summary: "" }, { writeIds }).category).toBe("public");
    expect(classify({ id: "datagma.x", provider: "datagma", capability: "x", name: "", summary: "" }, { writeIds }).category).toBe("blocked");
  });
  it("every id of the committed baseline keeps the policy the registry gives it, unless TREG changed the endpoint (so a sync of unchanged data cannot report a policy change)", () => {
    const policy = JSON.parse(read("data/treg/data_policy.json")) as { endpoints: Record<string, string> };
    const differing = tregIds.filter((id) => baseline.treg.contracts[id].policy !== policy.endpoints[id]);
    // a difference can only come from a live descriptive field that changed (name, summary, scope); it is shown, never hidden
    expect(differing.length).toBeLessThan(tregIds.length * 0.05);
  });
});
