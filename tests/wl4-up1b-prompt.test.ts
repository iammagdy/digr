import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toolHint } from "../src/lib/agentMission/capabilities/prompt";

/**
 * UP1b, the planner's tool hints (DT-20261126-wordlist-wave4, D-0240; the planning prompt is a brain file: هجرس). The hint of each web tool is the same text as before; the provider ids come from the identity file.
 */
describe("the tool hints keep their exact text", () => {
  it("parsers, web search, web scrape and people search", () => {
    expect(toolHint("contextdev.parse.google-maps-reviews")).toBe('parse_page {parser:"google-maps-reviews", url}');
    expect(toolHint("firecrawl.search")).toBe('web_search {provider:"firecrawl", query}');
    expect(toolHint("contextdev.search")).toBe('web_search {provider:"contextdev", query}');
    expect(toolHint("firecrawl.scrape")).toBe('web_scrape {provider:"firecrawl", url}');
    expect(toolHint("contextdev.scrape")).toBe('web_scrape {provider:"contextdev", url}');
    expect(toolHint("contextdev.people.search")).toBe("people_search {query}");
  });
  it("counter-cases: a catalog id and a near miss have no hint", () => {
    expect(toolHint("anyapi.x.search.posts")).toBeNull();
    expect(toolHint("firecrawl.map")).toBeNull();
    expect(toolHint("contextdev.people")).toBeNull();
  });
  it("counter-case: no provider id is written as a string literal in the prompt file", () => {
    const text = readFileSync("src/lib/agentMission/capabilities/prompt.ts", "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(text).not.toMatch(/["'`](?:treg|firecrawl|contextdev)[.'"`]/);
  });
});
