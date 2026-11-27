import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_CARDS, cardsFor } from "../src/lib/agentMission/foundation/toolCards";
import { catalogOrderOf } from "../src/lib/agentMission/foundation/toolCards/catalogOrder";
import { COMMENT_ID_PROOFS } from "../src/lib/agentMission/foundation/alternatives";
import { rankedCards } from "../src/lib/agentMission/foundation/compilePlan";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";

const EXTRA_REQUESTS = [
  "عايز ٥٠ بوست من فيسبوك عن الدوري المصري في مصر آخر ٣ شهور", "هات تعليقات من انستجرام عن العاصمة الإدارية", "عايز تعليقات يوتيوب عن الذكاء الاصطناعي بالعربي",
  "عايز ١٠٠ تغريدة عن الاقتصاد من تويتر آخر شهر بالانجليزي", "ترند تيك توك في السعودية ١٠ فيديوهات مع ٢٠ تعليق لكل فيديو وردود", "تعليقات فيديوهات تيك توك عن كرة القدم الأكثر تعليقًا",
  "منشورات فيسبوك الأحدث عن الكهرباء", "هات ريلز من انستجرام عن السفر",
];

/**
 * UP1 (DT-20261126-wordlist-wave4, D-0228, D-0232 K3). The tool cards are data (data/treg/tool_cards.json): no endpoint id is written in code. These tests prove that the cards are exactly what the catalog says, and that the
 * rule that orders sibling cards when nothing else decides is the catalog's own (tier, reliability, price) and nothing hand-set.
 */
const catalogEndpoints = new Map<string, any>((JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data/treg/treg_catalog_sellable.json"), "utf8")).endpoints as any[]).map((e) => [e.id, e]));

describe("every card is a fact of the catalog (the table is generated from the catalog here, not written by hand)", () => {
  it("25 cards, one per endpoint id, each id in the catalog on the same platform", () => {
    expect(TOOL_CARDS).toHaveLength(25);
    expect(new Set(TOOL_CARDS.map((c) => c.endpointId)).size).toBe(25);
    for (const c of TOOL_CARDS) {
      const e = catalogEndpoints.get(c.endpointId);
      expect(e, `${c.endpointId} is not in the catalog`).toBeTruthy();
      expect(e.platform, c.endpointId).toBe(c.platform);
    }
  });
  it("the price of a page on every card is the catalog's price, and the copied catalog facts (tier, reliability, price) are the catalog's", () => {
    for (const c of TOOL_CARDS) {
      const e = catalogEndpoints.get(c.endpointId);
      expect(c.costUsdPerPage, c.endpointId).toBe(e.cost.usd);
      expect(c.catalog, c.endpointId).toEqual({ tier: e.tier, okRate: typeof e.observed?.ok_rate === "number" ? e.observed.ok_rate : null, usd: e.cost.usd });
    }
  });
  it("a verified card carries the stored real pages it was verified on", () => {
    for (const c of TOOL_CARDS.filter((x) => x.status === "verified")) expect(c.verifiedOn.flatMap((v) => v.calls).length, c.endpointId).toBeGreaterThan(0);
  });
  it("the comment-id proofs name cards that exist, in pairs of one platform", () => {
    for (const p of COMMENT_ID_PROOFS) {
      const a = TOOL_CARDS.find((c) => c.endpointId === p.a);
      const b = TOOL_CARDS.find((c) => c.endpointId === p.b);
      expect(a && b, `${p.a} / ${p.b}`).toBeTruthy();
      expect(a!.platform).toBe(b!.platform);
    }
  });
  it("counter-case: a card whose endpoint is not in the catalog is caught (the check above is not vacuous)", () => {
    expect(catalogEndpoints.get("no.such.endpoint")).toBeUndefined();
  });
});

describe("the order among sibling cards when the ranking ties (K3: tier, then reliability, then price, then the id)", () => {
  const card = (id: string, catalog: { tier: "core" | "extended"; okRate: number | null; usd: number } | undefined) => ({ ...TOOL_CARDS[0], endpointId: id, ...(catalog ? { catalog } : { catalog: undefined }) });
  it("core before extended, whatever the price", () => {
    expect(catalogOrderOf(card("a", { tier: "extended", okRate: 1, usd: 0.0001 }), card("b", { tier: "core", okRate: 0.5, usd: 0.5 }))).toBeGreaterThan(0);
  });
  it("same tier: the higher observed reliability first, whatever the price", () => {
    expect(catalogOrderOf(card("a", { tier: "core", okRate: 0.9468, usd: 0.0005 }), card("b", { tier: "core", okRate: 0.9999, usd: 0.001 }))).toBeGreaterThan(0);
  });
  it("same tier and reliability: the cheaper call first; then the endpoint id (a total order)", () => {
    expect(catalogOrderOf(card("a", { tier: "core", okRate: 0.99, usd: 0.002 }), card("b", { tier: "core", okRate: 0.99, usd: 0.001 }))).toBeGreaterThan(0);
    expect(catalogOrderOf(card("a", { tier: "core", okRate: 0.99, usd: 0.001 }), card("b", { tier: "core", okRate: 0.99, usd: 0.001 }))).toBeLessThan(0);
  });
  it("counter-case: two cards with no catalog copy keep their given order (a derived card is never reordered)", () => {
    expect(catalogOrderOf(card("b", undefined), card("a", undefined))).toBe(0);
  });
  it("the real TikTok search siblings (all core): the most reliable comes first in a pure tie", () => {
    const tied = cardsFor("tiktok", "videos.search").map((c) => ({ ...c, costUsdPerPage: 0.001, counter: null }));
    expect(tied.length).toBe(3);
    const sorted = [...tied].sort(catalogOrderOf).map((c) => c.endpointId);
    expect(sorted[0]).toBe("tikhub.tiktok.search.videos");
  });
  it("PARITY: for every stored mission request and variants of it (country, language, order, no topic), the ranked cards of every role are exactly what cd33fd1e produced (golden generated from the code before this change)", () => {
    const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/wl4-up1-ranking-golden.json"), "utf8")) as Record<string, Record<string, string[]>>;
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/live/replay-missions.json"), "utf8")) as { missions: Array<{ request: string }> };
    const AT = Date.parse("2026-11-02T12:00:00Z");
    const requests = [...new Set([...fixture.missions.map((m) => m.request), ...EXTRA_REQUESTS])];
    let compared = 0;
    for (const text of requests) {
      const base: any = buildAsk(text, null, AT);
      const variants: Record<string, any> = {
        asked: base,
        withCountry: { ...base, country: "EG" },
        withLanguage: { ...base, language: "ar" },
        newest: { ...base, order: "newest" },
        noTopic: { ...base, topic: { text: null, relation: base.topic?.relation ?? "all", alternatives: [] } },
      };
      for (const [name, ask] of Object.entries(variants)) {
        for (const role of ["parents", "comments", "replies"] as const) for (const catalogOnly of [false, true]) {
          const got = rankedCards(ask, role, { catalogOnly }).map((c) => c.endpointId);
          expect(got, `${text} | ${name} | ${role} | ${catalogOnly}`).toEqual(golden[`${text}||${name}`][`${role}|${catalogOnly ? "catalogOnly" : "customer"}`]);
          compared += 1;
        }
      }
    }
    expect(Object.keys(golden)).toHaveLength(requests.length * 5);
    expect(compared).toBe(requests.length * 5 * 6);
  });
});
