import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateRegistryJson, collectInputs } from "../scripts/capabilities/build-registry";
import { generateReliabilityMarkdown } from "../scripts/capabilities/reliability-report";
import { buildRegistryArtifact, serializeArtifact, type RegistryArtifact } from "../src/lib/agentMission/capabilities/artifact";
import { evidenceOf, LIVE_MIN_CALLS_WITH_ROWS, type MeasuredCalls } from "../src/lib/agentMission/capabilities/evidence";
import { diffRegistries, selectableLevel } from "../src/lib/agentMission/capabilities/registryDiff";
import { reliabilityReport } from "../src/lib/agentMission/capabilities/reliability";
import { buildCapabilityRegistry, discoverCapabilities, researchNeedOf } from "../src/lib/agentMission/capabilities";
import { TOOL_CARDS } from "../src/lib/agentMission/foundation/toolCards";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { categoryOf, policyVerdict } from "../src/lib/treg/dataPolicy";

/**
 * PHASE 3, THE VERIFIED CAPABILITY REGISTRY (docs/intelligence/PHASES-2-4-BASELINE.md). Everything is read from the repository's own files; nothing is fetched.
 */
const committed = readFileSync(new URL("../data/capabilities/registry.json", import.meta.url), "utf8");
const artifact = JSON.parse(committed) as RegistryArtifact;
const reviewed = new Set<string>((JSON.parse(readFileSync(new URL("../data/capabilities/production-eligible.json", import.meta.url), "utf8")) as { ids: string[] }).ids);
const entry = (id: string, op?: string) => artifact.capabilities.find((c) => c.id === id && (!op || c.operation === op))!;
const NONE: MeasuredCalls = { attempts: 0, ok: 0, withRows: 0, empty: 0, emptyPaid: 0, failed: 0, refused: 0, rows: 0, costUsd: 0, costNull: 0, p50Ms: null };
const priced = { unit: "call", usd: 0.001, basis: "verified" as const, billedOnFailure: false };

describe("3.2 / 3.6 the registry is generated, deterministic and reproducible offline", () => {
  it("the committed artifact is exactly what the generator builds from the repository's files (run `npx tsx scripts/capabilities/build-registry.ts` after a change)", () => {
    expect(generateRegistryJson()).toBe(committed);
  });
  it("two runs give the same bytes; one capability per line (a review diff shows one line per changed capability)", () => {
    const a = serializeArtifact(buildRegistryArtifact(collectInputs()));
    expect(a).toBe(generateRegistryJson());
    expect(committed.split("\n").filter((l) => l.startsWith('    {"key":')).length).toBe(artifact.counts.capabilities);
  });
  it("the generated reliability report is up to date", () => {
    expect(generateReliabilityMarkdown()).toBe(readFileSync(new URL("../docs/intelligence/RELIABILITY-REPORT.md", import.meta.url), "utf8"));
  });
  it("it records the digest of every input, and the obsolete Appwrite generator is not one of them", () => {
    expect(Object.keys(artifact.sources).sort()).toEqual(["callIndex", "catalog", "deprecated", "directSources", "policy", "production", "reliability", "toolCards"]);
    expect(readFileSync(new URL("../scripts/capabilities/build-registry.ts", import.meta.url), "utf8")).not.toMatch(/from\s+["']node-appwrite["']/);
  });
});

describe("3.1 every capability has an honest record", () => {
  it("each entry carries id, provider, access, operation, inputs, outputs, paging, filters, pricing with its basis, policy, verification, reliability, limitations, fallback group and a schema fingerprint", () => {
    for (const c of artifact.capabilities) {
      expect(["treg", "firecrawl", "contextdev"]).toContain(c.provider);
      expect(["treg_direct", "treg_routed", "direct"]).toContain(c.access);
      expect(["verified", "documented", "estimated", "unknown"]).toContain(c.pricing.basis);
      expect(["advertised", "schema_checked", "fixture_verified", "live_verified", "production_eligible", "broken", "deprecated"]).toContain(c.verification.level);
      expect(c.fallback_group).toBe(`${c.operation}:${c.platform ?? "any"}`);
      expect(c.schema_fingerprint).toMatch(/^[0-9a-f]{16}$/);
      if (c.provider === "treg") expect(c.policy).toBe(categoryOf(c.id));
    }
    // the provider differences are explicit: the same search sold through TREG and called directly are two capabilities
    expect(entry("firecrawl.web.search")).toMatchObject({ provider: "treg", sub_provider: "firecrawl", access: "treg_direct" });
    expect(entry("firecrawl.search")).toMatchObject({ provider: "firecrawl", access: "direct" });
    expect(entry("treg.web.search")).toMatchObject({ access: "treg_routed", pricing: { basis: "estimated" } });
  });

  it("NO unverified capability is production-eligible: only reviewed ids, each public, priced (verified or documented) and with fixture or live evidence", () => {
    const pe = artifact.capabilities.filter((c) => c.verification.level === "production_eligible");
    expect(pe.length).toBe(artifact.counts.production_eligible);
    expect(pe.length).toBeGreaterThan(0);
    for (const c of pe) {
      expect(reviewed.has(c.id), c.id).toBe(true);
      expect(c.policy).toBe("public");
      expect(["verified", "documented"]).toContain(c.pricing.basis);
      expect(c.verification.evidence.some((e) => e.kind === "stored_page" || e.kind === "recorded_calls")).toBe(true);
    }
    expect(artifact.capabilities.filter((c) => c.policy === "sensitive" || c.policy === "blocked").every((c) => c.verification.level !== "production_eligible")).toBe(true);
  });

  it("every hand ToolCard verified on real pages is in the registry, fixture-verified on its stored pages (one canonical registry)", () => {
    for (const card of TOOL_CARDS.filter((c) => c.status === "verified" && c.role !== "channels.search")) {
      const c = artifact.capabilities.find((x) => x.id === card.endpointId)!;
      expect(c, card.endpointId).toBeTruthy();
      expect(c.card).toBe(card.endpointId);
      expect(c.verification.evidence.filter((e) => e.kind === "stored_page").length, card.endpointId).toBeGreaterThan(0);
    }
  });

  it("schema honesty: a sub-list schema stays unknown (advertised), a documented record is schema-checked; the catalog's own success rate is never live evidence", () => {
    expect(entry("branddev.web.scrape").outputs_known).toBe(false);
    expect(entry("branddev.web.scrape").reliability.provider_observed!.ok_rate).toBeGreaterThan(0.5);
    expect(entry("branddev.web.scrape").verification.level).toBe("advertised");
    expect(entry("branddev.brand.retrieve-by-name").verification.level).toBe("advertised");
    expect(entry("limadata.web.extract").verification.level).toBe("schema_checked");
    // TREG says firecrawl.web.search succeeds 99.9% of 15,187 times; Diger never called it: it is NOT live-verified
    expect(entry("firecrawl.web.search").reliability.diger).toBeNull();
    expect(["advertised", "schema_checked"]).toContain(entry("firecrawl.web.search").verification.level);
  });

  it("Diger-measured evidence: a source that never returned a row in enough calls is BROKEN (never selectable, however cheap)", () => {
    const litescrape = entry("litescrape.google.serp.maps");
    expect(litescrape.reliability.diger).toMatchObject({ attempts: 7, withRows: 0 });
    expect(litescrape.verification.level).toBe("broken");
    expect(selectableLevel(litescrape.verification.level)).toBe(false);
    expect(entry("tomba.companies.search.reveal").verification.level).toBe("live_verified");
  });

  it("advertised-only capabilities (not implemented) and the deprecated Firecrawl /extract are listed, never as candidates", () => {
    const ids = artifact.advertised_only.map((a) => a.id);
    expect(ids).toContain("firecrawl.extract");
    expect(artifact.advertised_only.find((a) => a.id === "firecrawl.extract")!.level).toBe("deprecated");
    expect(artifact.capabilities.some((c) => ids.includes(c.id))).toBe(false);
  });
});

describe("3.1 / 3.3 the levels follow their evidence, never ahead of it", () => {
  const base = { id: "x", outputsKnown: true, privacy: "public" as const, pricing: priced };
  it("advertised → schema-checked → fixture-verified → live-verified → production-eligible, each only with its proof", () => {
    expect(evidenceOf({ ...base, outputsKnown: false }, { policy: "public" }).level).toBe("advertised");
    expect(evidenceOf(base, { policy: "public" }).level).toBe("schema_checked");
    expect(evidenceOf(base, { policy: "public", card: { status: "verified", checkedPages: [{ ref: "p", issues: [] }] } }).level).toBe("fixture_verified");
    // a card whose stored page does NOT map cleanly proves nothing
    expect(evidenceOf(base, { policy: "public", card: { status: "verified", checkedPages: [{ ref: "p", issues: ["a row without an id"] }] } }).level).toBe("schema_checked");
    expect(evidenceOf(base, { policy: "public", measured: { ...NONE, attempts: 3, withRows: LIVE_MIN_CALLS_WITH_ROWS } }).level).toBe("live_verified");
    expect(evidenceOf(base, { policy: "public", measured: { ...NONE, attempts: 10, withRows: 2 } }).level).toBe("schema_checked");
    expect(evidenceOf(base, { policy: "public", reviewedProduction: true, measured: { ...NONE, attempts: 3, withRows: 3 } }).level).toBe("production_eligible");
  });
  it("the reviewed list alone promotes nothing: no evidence, an unknown price, or a non-public policy keeps it out", () => {
    expect(evidenceOf(base, { policy: "public", reviewedProduction: true }).level).toBe("schema_checked");
    expect(evidenceOf({ ...base, pricing: { ...priced, basis: "unknown", usd: null } }, { policy: "public", reviewedProduction: true, measured: { ...NONE, attempts: 3, withRows: 3 } }).level).toBe("live_verified");
    expect(evidenceOf({ ...base, pricing: { ...priced, basis: "estimated" } }, { policy: "public", reviewedProduction: true, measured: { ...NONE, attempts: 3, withRows: 3 } }).level).toBe("live_verified");
    expect(evidenceOf(base, { policy: "b2b_contact", reviewedProduction: true, measured: { ...NONE, attempts: 3, withRows: 3 } }).level).toBe("live_verified");
  });
  it("broken and deprecated override every other fact", () => {
    expect(evidenceOf(base, { policy: "public", reviewedProduction: true, card: { status: "broken", checkedPages: [] } }).level).toBe("broken");
    expect(evidenceOf(base, { policy: "public", reviewedProduction: true, deprecated: "removed 2026-12-10", measured: { ...NONE, attempts: 9, withRows: 9 } }).level).toBe("deprecated");
  });
});

describe("3.5 registry change safety", () => {
  const clone = (): RegistryArtifact => JSON.parse(committed);
  const pe = () => artifact.capabilities.find((c) => c.verification.level === "production_eligible")!;
  it("identical artifacts: no change", () => {
    expect(diffRegistries(artifact, clone())).toMatchObject({ identical: true, violations: [] });
  });
  it("detects new, removed, price, breaking input, breaking output, deprecation and policy changes; a change on a production-eligible capability requires review", () => {
    const after = clone();
    const k = pe().key;
    const t = after.capabilities.find((c) => c.key === k)!;
    t.pricing.usd = (t.pricing.usd ?? 0) * 2;
    t.inputs_required = [...t.inputs_required, "new_required"];
    t.outputs = t.outputs.filter((o) => o !== "id");
    t.policy = "sensitive";
    const gone = after.capabilities.find((c) => c.verification.level === "schema_checked")!;
    after.capabilities = after.capabilities.filter((c) => c !== gone);
    after.capabilities.push({ ...after.capabilities[0], key: "newprov.x.tool#social.parents", id: "newprov.x.tool", verification: { level: "schema_checked", evidence: [], notes: [] } });
    const broken = after.capabilities.find((c) => c.verification.level === "live_verified")!;
    broken.verification = { level: "broken", evidence: [], notes: [] };
    const d = diffRegistries(artifact, after);
    const kinds = (key: string) => d.changes.filter((c) => c.key === key).map((c) => c.kind).sort();
    expect(kinds(k)).toEqual(["breaking_input", "breaking_output", "policy", "price"]);
    expect(d.changes.filter((c) => c.key === k).every((c) => c.reviewRequired)).toBe(true);
    expect(kinds(gone.key)).toEqual(["removed"]);
    expect(kinds("newprov.x.tool#social.parents")).toEqual(["added"]);
    expect(kinds(broken.key)).toEqual(["deprecated"]);
    // the production-eligible entry kept its level after a breaking change: a violation (re-verify before it ships)
    expect(d.violations.some((v) => v.startsWith(k))).toBe(true);
  });
  it("a NEW capability is never production-eligible on arrival, and nothing is promoted without fixture or live evidence", () => {
    const after = clone();
    after.capabilities.push({ ...pe(), key: "brandnew.tool#social.parents", id: "brandnew.tool" });
    const sc = after.capabilities.find((c) => c.verification.level === "schema_checked")!;
    const promotedKey = sc.key;
    sc.verification = { ...sc.verification, level: "production_eligible" };
    const d = diffRegistries(artifact, after);
    expect(d.violations).toContain("brandnew.tool#social.parents: a new capability is production-eligible on arrival");
    expect(d.violations).toContain(`${promotedKey}: promoted to production-eligible without fixture or live evidence`);
  });
});

describe("3.4 reliability and cost evidence (Diger's own calls; HTTP 200 is not research)", () => {
  const report = reliabilityReport(artifact, (JSON.parse(readFileSync(new URL("../data/capabilities/reliability-snapshot.json", import.meta.url), "utf8")) as { rows: string[][] }).rows.map((r) => r[0]));
  it("an empty answer that was billed is counted, and is not a usable response", () => {
    const emails = report.endpoints.find((e) => e.id === "contextdev.parse.emails")!;
    expect(emails).toMatchObject({ attempts: 23, usableResponses: 10, emptyPaid: 11 });
    expect(emails.usableShare).toBeLessThan(0.5);
  });
  it("a direct provider that was always refused for a missing key has no usable response and no cost", () => {
    const fc = report.endpoints.find((e) => e.id === "firecrawl.search")!;
    expect(fc).toMatchObject({ attempts: 0, refused: 18, usableResponses: 0, costUsd: 0 });
  });
  it("the totals are Diger's own figures, by operation", () => {
    expect(report.operations.map((o) => o.operation)).toContain("social.comments");
    expect(report.totals.attempts).toBeGreaterThan(2000);
    expect(report.totals.usableResponses).toBeLessThan(report.totals.attempts);
  });
});

describe("the hand cards in RUNTIME discovery are an explicit, recorded improvement (only with the router switch)", () => {
  const catalog = loadTregCatalog();
  const allowed = (id: string) => !blockedEndpointReason(id) && policyVerdict(id, { isAdmin: false, verifiedBusiness: false }).allowed;
  it("Facebook replies are served in production by a verified card: without the cards discovery said «partial» (unchanged with the switch off); with them, «supported»", () => {
    const need = researchNeedOf({ request: "هات منشورات فيسبوك عن السياحة مع التعليقات والردود" });
    const off = discoverCapabilities(need, buildCapabilityRegistry(catalog, { isAllowed: allowed }));
    const on = discoverCapabilities(need, buildCapabilityRegistry(catalog, { isAllowed: allowed, handCards: true }));
    expect(off.status).toBe("partial");
    expect(on.status).toBe("supported");
    expect(on.stages.find((s) => s.stage.operation === "social.replies")!.eligible.map((e) => e.id)).toContain("anyapi.facebook.comment_replies");
  });
});
