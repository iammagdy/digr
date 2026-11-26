import path from "node:path";
import { describe, expect, it } from "vitest";
import { AllowIndex, loadTregCatalogIds, scanSourceCode } from "./designGuardsScanner";

/**
 * K4 (D-0232): inside PROSE (a string literal that contains whitespace) a provider token of 3 characters or fewer is an ordinary word,
 * not a provider id. The rule is generic (length + whitespace); it has no word list. Everything that is an id still fails.
 */
describe("design guard: short provider tokens inside prose", () => {
  const catalog = loadTregCatalogIds(path.resolve(__dirname, "../data/treg"));
  const providerHits = (code: string) =>
    scanSourceCode("fake/prose.ts", code, catalog, new AllowIndex()).filter((v) => v.rule === "treg_token").map((v) => v.detail);

  it("the test words are real catalog tokens (so the cases below mean something)", () => {
    expect(catalog.providers.has("you")).toBe(true);
    expect(catalog.providers.has("x")).toBe(true);
    expect(catalog.providers.has("crawl4ai")).toBe(true);
    expect(catalog.endpoints.has("apify.google.serp.maps")).toBe(true);
  });

  it("MUST FAIL: «you» and «x» as whole literals", () => {
    expect(providerHits('const a = "you";')).toEqual(['Hardcoded provider ID: "you"']);
    expect(providerHits('const b = "x";')).toEqual(['Hardcoded provider ID: "x"']);
  });

  it("MUST FAIL: an endpoint id compared with ===", () => {
    const hits = providerHits('if (endpointId === "apify.google.serp.maps") run();');
    expect(hits.some((d) => d.includes("apify.google.serp.maps"))).toBe(true);
  });

  it("MUST FAIL: a provider id as an object key", () => {
    expect(providerHits('const o = { "crawl4ai": 1 };')).toEqual(['Hardcoded provider ID: "crawl4ai"']);
  });

  it("MUST FAIL: prose that names a provider of 4 characters or more", () => {
    expect(providerHits('const t = "Use crawl4ai to read the page for you";')).toEqual(['Hardcoded provider ID: "crawl4ai"']);
  });

  it("MUST PASS: prompt prose with «you» (and «x» as a letter) and nothing else", () => {
    expect(providerHits('const p = "Tell me what you need, and I will answer you in Arabic";')).toEqual([]);
    expect(providerHits('const q = "Point x is on the left";')).toEqual([]);
    expect(providerHits("const r = `Dear user, can you send the file`;")).toEqual([]);
  });

  it("COUNTER: a short token with NO whitespace in a longer literal is still an id", () => {
    expect(providerHits('const s = "you.com";')).toEqual(['Hardcoded provider ID: "you"']);
  });
});
