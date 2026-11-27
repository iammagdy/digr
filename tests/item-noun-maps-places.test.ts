import { describe, expect, it } from "vitest";
import endpointMetadataOverlay from "../data/treg/endpoint_metadata_overlay.json";
import catalog from "../data/treg/treg_catalog_sellable.json";
import { coerceItemNoun, countAr } from "../src/lib/agentMission/itemNoun";

/**
 * THE UNIT OF A GOOGLE MAPS RESULT (live finding msn_afe30906c359e8466bc2, 2026-11-27: one Maps stage of companies said «هتستلم ٥ مقالات»). The overlay (DT-20261125-wordlist-wave2 P3) froze the old code's rule
 * «every serp endpoint is an article» into data. The 14 endpoints whose catalog capability is `google.serp.maps` or `google.serp.local` return PLACES (their own catalog summaries say so), so their noun is «مكان».
 * Data only: no code reads a word. The other overlay nouns are re-derived from each endpoint's own catalog metadata in a separate, reviewed step (B3).
 */
const overlay = endpointMetadataOverlay as Record<string, any>;
const endpoints = (catalog as any).endpoints as Array<{ id: string; capability?: string }>;
const mapsAndLocal = endpoints.filter((e) => e.capability === "google.serp.maps" || e.capability === "google.serp.local").map((e) => e.id);

describe("the 14 Google Maps / local endpoints count places", () => {
  it("exactly 14 endpoints, all «مكان» with the five forms valid, and a count reads «أماكن»", () => {
    expect(mapsAndLocal).toHaveLength(14);
    for (const id of mapsAndLocal) {
      const n = coerceItemNoun(overlay[id]?.item_noun_ar);
      expect(n, id).not.toBeNull();
      expect(n!.singular, id).toBe("مكان");
      expect(n!.plural, id).toBe("أماكن");
    }
    expect(countAr(5, coerceItemNoun(overlay["anyapi.google.serp.maps"].item_noun_ar)!)).toBe("٥ أماكن");
  });
  it("counter-case: a real article endpoint (web search, organic search) keeps its noun", () => {
    expect(overlay["treg.web.search"].item_noun_ar.singular).toBe("مقال");
    expect(overlay["treg.google.serp.organic"].item_noun_ar.singular).toBe("مقال");
  });
  it("the rest of the overlay is untouched: same 3306 keys, the noun counts changed only by these 14", () => {
    const counts: Record<string, number> = {};
    for (const v of Object.values(overlay)) counts[v.item_noun_ar.singular] = (counts[v.item_noun_ar.singular] ?? 0) + 1;
    expect(Object.keys(overlay)).toHaveLength(3306);
    expect(counts["مقال"]).toBe(340 - 14);
    expect(counts["مكان"]).toBe(3 + 14);
    expect(counts["تغريدة"]).toBe(1572);
  });
});
