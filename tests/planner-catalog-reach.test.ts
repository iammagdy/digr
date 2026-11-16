import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { candidatesFor, isAsyncTask, platformIndex } from "../agent/src/llmPlanner/catalogView";

/**
 * LIVE, 16 Nov 2026 (eval on the real planner + «١٠٠ ريفيو لسماعة Sony من أمازون» on diger.tech): the only Amazon reviews tool timed out three times while two other Amazon review tools sat in the catalog with no capability name,
 * and a TripAdvisor request got an ASYNC TASK tool (submit, then poll another endpoint) as its only option, which answers with a task id and never items.
 */
const catalog = loadTregCatalog();

describe("what the planner may choose from the catalog", () => {
  it("never an async task tool", () => {
    for (const [p, c] of [["tripadvisor", "tripadvisor.business.reviews"], ["google", "google.maps.reviews"], ["app-store", "app-store.reviews"], ["trustpilot", "trustpilot.business.reviews"]] as const) {
      for (const e of candidatesFor(catalog, null, p, c, 8)) expect(isAsyncTask(e)).toBe(false);
    }
    expect(catalog.endpoints.filter(isAsyncTask).length).toBeGreaterThan(100);
  });
  it("a capability with one tool also offers the platform's unnamed tools whose id names the items", () => {
    const ids = candidatesFor(catalog, null, "amazon", "amazon.product.reviews", 8).map((e) => e.id);
    expect(ids[0]).toBe("crawl4ai.amazon.product.reviews");
    expect(ids).toContain("justoneapi.x.amazon-get-product-top-reviews-v1");
  });
  it("the planner's index spans far more than social media", () => {
    const index = platformIndex(catalog, null);
    for (const p of ["google", "amazon", "app-store", "google-play", "tripadvisor", "trustpilot", "yelp", "imdb", "github", "crypto", "stocks", "web", "linkedin", "reddit", "telegram"]) expect(index).toMatch(new RegExp(`^${p}: `, "m"));
  });
});
