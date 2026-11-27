import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyLabels, nounTable, overlayFormsOf } from "../scripts/treg/apply-item-nouns";
import { coerceItemNoun, countAr, GENERIC_ITEM_NOUN, ITEM_NOUNS } from "../src/lib/agentMission/itemNoun";

/**
 * B3 (DT-20261126-wordlist-wave4, D-0239): the unit noun of every catalog endpoint is a reviewed LABEL (data/treg/item_noun_labels.json), and the overlay is exactly what the labels say. The guards below make a regression
 * (a rule frozen into data again, an endpoint without a label, a noun outside the closed set, an overlay edited by hand) fail the build.
 */
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));
const labels = read("data/treg/item_noun_labels.json") as Record<string, [string, string]>;
const overlay = read("data/treg/endpoint_metadata_overlay.json") as Record<string, any>;
const catalog = (read("data/treg/treg_catalog_sellable.json") as { endpoints: Array<{ id: string }> }).endpoints;

describe("every catalog endpoint has exactly one reviewed label", () => {
  it("the labels cover the catalog's endpoints exactly (no endpoint without a label, no label of a removed endpoint)", () => {
    expect(Object.keys(labels).sort()).toEqual(catalog.map((e) => e.id).sort());
  });
  it("every noun is of the closed set (the nouns the code can count in correct Arabic) and every label says why", () => {
    const closed = new Set([...ITEM_NOUNS.map((n) => n.singular), GENERIC_ITEM_NOUN.singular]);
    for (const [id, [noun, basis]] of Object.entries(labels)) {
      expect(closed.has(noun), `${id}: «${noun}»`).toBe(true);
      expect(basis.trim().length, id).toBeGreaterThan(2);
    }
  });
});

describe("the overlay is exactly what the labels say", () => {
  it("every labelled endpoint carries the five forms of its noun (the table's own), and nothing else of its entry changed", () => {
    const table = nounTable();
    for (const [id, [noun]] of Object.entries(labels)) {
      expect(overlay[id], id).toBeDefined();
      expect(overlay[id].item_noun_ar, id).toEqual(overlayFormsOf(table.get(noun)!));
      expect(coerceItemNoun(overlay[id].item_noun_ar), id).not.toBeNull();
    }
    expect(Object.keys(overlay)).toHaveLength(3306);
  });
  it("the generator is a fixed point: applying the labels to the overlay changes nothing", () => {
    expect(applyLabels(overlay, labels)).toEqual(overlay);
  });
  it("counter-case: a label with a noun outside the closed set is refused", () => {
    expect(() => applyLabels({ "treg.web.search": overlay["treg.web.search"] }, { "treg.web.search": ["نتيجة", "x"] })).toThrow(/closed set/);
  });
});

describe("what the labels say about real endpoints (anchors read by a person)", () => {
  const nounOf = (id: string) => labels[id][0];
  it("places, articles, tweets, videos, products, comments", () => {
    expect(nounOf("treg.google.serp.maps")).toBe("مكان");
    expect(nounOf("anyapi.google.serp.maps")).toBe("مكان");
    expect(nounOf("treg.web.search")).toBe("مقال");
    expect(nounOf("treg.google.serp.organic")).toBe("مقال");
    expect(nounOf("treg.x.search.posts")).toBe("تغريدة");
    expect(nounOf("treg.tiktok.search.videos")).toBe("فيديو");
    expect(nounOf("scrapecreators.youtube.video.comments")).toBe("تعليق");
  });
  it("counter-cases: a vendor `x` endpoint is NOT a tweet, option lists and status plumbing are the generic noun", () => {
    expect(nounOf("tikhub.x.douyin-app-v3-fetch-hot-search-list")).not.toBe("تغريدة");
    expect(nounOf("replicate.x.openai-sora-2")).toBe("فيديو");
    expect(nounOf("companyenrich.geo.cities.search")).toBe("عنصر");
    expect(nounOf("companyenrich.companies.enrich.bulk.status")).toBe("عنصر");
  });
  it("B3 fix: conversations are «عنصر», telegram search is «منشور», spotify artist is «عنصر»", () => {
    expect(nounOf("x.x.get-chat-conversations")).toBe("عنصر");
    expect(nounOf("x.x.get-chat-conversation")).toBe("عنصر");
    expect(nounOf("tikhub.x.telegram-web-fetch-channel-search")).toBe("منشور");
    expect(nounOf("scrapecreators.x.v1-spotify-artist")).toBe("عنصر");
  });
  it("a count reads in the noun's own Arabic form", () => {
    const n = coerceItemNoun(overlay["treg.google.serp.maps"].item_noun_ar)!;
    expect(countAr(5, n)).toBe("٥ أماكن");
    expect(countAr(1, coerceItemNoun(overlay["treg.web.search"].item_noun_ar)!)).toBe("مقال واحد");
  });
  it("the old frozen rule is gone: no more than a fifth of the catalog is called a tweet (it was 48%)", () => {
    const tweets = Object.entries(labels).filter(([, [n]]) => n === "تغريدة");
    expect(tweets.length).toBeLessThan(catalog.length / 5);
  });
});
