import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { usableSearchProvider, WebAvailability } from "../src/lib/agentMission/webAvailability";
import { PARSERS, WEB_SOURCES } from "../src/lib/agentMission/sources";

describe("N17 Vendor and Hardcoded Provider Cleanup", () => {
  const root = path.resolve(__dirname, "..");

  it("agent/prompts/system.md contains no hardcoded provider names or parser lists", () => {
    const sysPrompt = fs.readFileSync(path.join(root, "agent/prompts/system.md"), "utf8");
    expect(sysPrompt).not.toMatch(/firecrawl/i);
    expect(sysPrompt).not.toMatch(/context\.dev/i);
    expect(sysPrompt).not.toMatch(/There is no X, Facebook or YouTube parser/i);
    expect(sysPrompt).not.toMatch(/Instagram posts and comments, TikTok search/i);
  });

  it("src/lib/agentMission/webAvailability.ts contains no hardcoded firecrawl/contextdev literals", () => {
    const src = fs.readFileSync(path.join(root, "src/lib/agentMission/webAvailability.ts"), "utf8");
    expect(src).not.toMatch(/"firecrawl"/);
    expect(src).not.toMatch(/"contextdev"/);
  });

  it("src/lib/agentMission/sources.ts contains no hardcoded keywords arrays or provider string literals", () => {
    const src = fs.readFileSync(path.join(root, "src/lib/agentMission/sources.ts"), "utf8");
    expect(src).not.toMatch(/keywords:\s*\[/);
    expect(src).not.toMatch(/"contextdev\./);
    expect(src).not.toMatch(/"firecrawl\./);
  });

  it("usableSearchProvider selects cheapest available search provider dynamically", () => {
    // Both available -> cheapest (e.g. contextdev at 0.005 vs firecrawl at 0.01)
    const both: WebAvailability = { firecrawl: true, contextdev: true } as any;
    expect(usableSearchProvider(undefined, both)).toBe("contextdev");

    // Only firecrawl available -> firecrawl
    const fireOnly: WebAvailability = { firecrawl: true, contextdev: false } as any;
    expect(usableSearchProvider(undefined, fireOnly)).toBe("firecrawl");

    // Neither -> null
    const none: WebAvailability = { firecrawl: false, contextdev: false } as any;
    expect(usableSearchProvider(undefined, none)).toBeNull();
  });
});
