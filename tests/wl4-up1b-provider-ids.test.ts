import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCapabilityRegistry, type CapabilityProvider } from "../src/lib/agentMission/capabilities/registry";
import { DATA_PROVIDER_IDS } from "../src/lib/multiProvider/types";
import { loadTregCatalog } from "../src/lib/treg/catalog";

/**
 * UP1b (DT-20261126-wordlist-wave4, D-0240): the capability registry, its artifact reader and the web-source types take the platform's OWN provider ids from the identity file (`multiProvider/types.ts`: PROVIDER_*), not from literals.
 * Nothing the registry says changes: the web tools keep their ids, their provider and their operation (the committed registry artifact, tests/phase3-registry.test.ts, proves the whole output is byte-identical).
 */
describe("provider ids come from the identity file; the registry says the same as before", () => {
  const registry = buildCapabilityRegistry(loadTregCatalog(), { isAllowed: () => true, webKeys: { firecrawl: true, contextdev: true }, dailyCapUsd: { firecrawl: 1, contextdev: 1 }, handCards: true });
  const byId = (id: string) => registry.all.find((c) => c.id === id);
  it("the five web tools keep their exact ids, providers and operations", () => {
    expect(byId("firecrawl.search")).toMatchObject({ provider: "firecrawl", operation: "web.search" });
    expect(byId("contextdev.search")).toMatchObject({ provider: "contextdev", operation: "web.search" });
    expect(byId("firecrawl.scrape")).toMatchObject({ provider: "firecrawl", operation: "web.read" });
    expect(byId("contextdev.scrape")).toMatchObject({ provider: "contextdev", operation: "web.read" });
    expect(byId("contextdev.people.search")).toMatchObject({ provider: "contextdev", operation: "people.discover" });
  });
  it("catalog and hand-card capabilities are still the TREG provider; the parsers still the Context.dev one", () => {
    expect(registry.all.filter((c) => c.provider === "treg").length).toBeGreaterThan(100);
    expect(registry.all.filter((c) => c.provider === "contextdev" && c.id.startsWith("contextdev.parse.")).length).toBeGreaterThan(0);
  });
  it("the provider type is the identity file's (a compile-time check: this assignment fails typecheck otherwise)", () => {
    const all: CapabilityProvider[] = [...DATA_PROVIDER_IDS];
    expect(all).toEqual(["treg", "firecrawl", "contextdev"]);
  });
  it("counter-case: no provider id is written as a string literal in the three files (the identity file is the only speller)", () => {
    for (const file of ["src/lib/agentMission/capabilities/registry.ts", "src/lib/agentMission/capabilities/artifact.ts", "src/lib/agentMission/sources.ts"]) {
      const text = readFileSync(file, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(text, file).not.toMatch(/["'](?:treg|firecrawl|contextdev)["']/);
    }
  });
});
