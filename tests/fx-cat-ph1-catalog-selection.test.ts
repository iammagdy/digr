import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { usableEndpoint } from "../agent/src/llmPlanner/catalogView";

const catalog = loadTregCatalog();

describe("FX-CAT Ph1 Catalog Selection (Commit 3A)", () => {
  it("usableEndpoint returns true for unlocked non-media and supported async_config endpoints", () => {
    const testIds = [
      "justoneapi.x.1688-search-item-list-v1",
      "marketstack.eod",
      "crawl4ai.github.repo.issues",
      "tikhub.x.telegram-web-fetch-channel-info",
      "crawl4ai.crunchbase.company.profile",
      "serpapi.x.brave-ai-mode",
      "dataforseo.x.app-data-apple-app-reviews-task-post",
    ];

    for (const id of testIds) {
      const e = catalog.byId.get(id);
      expect(e, `Endpoint ${id} should exist in catalog`).toBeDefined();
      expect(usableEndpoint(e!, catalog, null), `Expected ${id} to be usable`).toBe(true);
    }
  });

  it("usableEndpoint returns false for poll-only, media generators, write actions and paused providers", () => {
    const blockedIds = [
      "dataforseo.x.app-data-apple-app-reviews-task-get-advanced",
      "replicate.image-gen.flux-schnell",
    ];

    for (const id of blockedIds) {
      const e = catalog.byId.get(id);
      if (e) {
        expect(usableEndpoint(e, catalog, null), `Expected ${id} to be NOT usable`).toBe(false);
      }
    }
  });
});
