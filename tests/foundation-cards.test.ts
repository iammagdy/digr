import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_CARDS, cardOf, cardsFor, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { checkCardOnPage } from "../src/lib/agentMission/foundation/toolCards/verify";
import { loadTregCatalog } from "../src/lib/treg/catalog";

/**
 * F2: every TikTok and X tool card is VERIFIED on the stored real pages it lists (anonymised, tests/fixtures/live/missions). The call index
 * (tests/fixtures/live/call-index.json, from mission_calls) says which endpoint answered each page: a card is never checked on a page of another tool.
 */
const page = (mission: string, call: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${mission}/raw/${call}.json`, import.meta.url), "utf8"));
const index = JSON.parse(readFileSync(new URL("./fixtures/live/call-index.json", import.meta.url), "utf8")) as { missions: Record<string, Array<[string, string, string, string, number, Record<string, unknown>]>> };
const endpointOfCall = (mission: string, call: string): string | null => index.missions[mission]?.find((c) => c[0] === call)?.[2] ?? null;
const rowsOfCall = (mission: string, call: string): number | null => index.missions[mission]?.find((c) => c[0] === call)?.[4] ?? null;
const rows = (mission: string, stage: string): Array<Record<string, unknown>> => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${mission}/rows/${stage}.json`, import.meta.url), "utf8"));
const catalog = loadTregCatalog();

describe("F2: the tool cards are data, and each is verified on real stored pages", () => {
  it("PR 2a carries TikTok and X cards only; every one is verified on at least one real page, (the X replies card was the one catalog_only card until live round 8, 3 Nov 2026: verified on the pages of msn_50e3b83c44e7ebd7f577)", () => {
    expect(new Set(TOOL_CARDS.map((c) => c.platform))).toEqual(new Set(["tiktok", "x"]));
    expect(TOOL_CARDS.filter((c) => c.status !== "verified").map((c) => [c.endpointId, c.status])).toEqual([]);
    for (const c of TOOL_CARDS) {
      expect(["verified", "catalog_only"]).toContain(c.status);
      // a verified card was seen on real pages; a catalog_only one has none (that is what the word means)
      if (c.status === "verified") expect(c.verifiedOn.flatMap((v) => v.calls).length).toBeGreaterThan(0);
      else expect(c.verifiedOn).toEqual([]);
      // the card's tool exists in the catalog, with the inputs the card writes
      const e = catalog.byId.get(c.endpointId);
      expect(e, c.endpointId).toBeTruthy();
      const names = new Set([...(e!.inputs ?? []).map((i) => i.name), ...(e!.pagination ?? [])]);
      for (const f of [c.inputs.query?.field, c.inputs.country?.field, c.inputs.order?.field, c.inputs.pageSize?.field, c.inputs.cursor, c.inputs.parent?.param, ...(c.inputs.parent?.also ?? []).map((a) => a.param)].filter((x): x is string => typeof x === "string")) expect(names.has(f), `${c.endpointId} input ${f}`).toBe(true);
      // the price is the catalog's
      expect(c.costUsdPerPage).toBe(Number((e as unknown as { cost: { usd: number } }).cost.usd));
    }
  });

  for (const card of TOOL_CARDS) {
    for (const v of card.verifiedOn) {
      for (const call of v.calls) {
        it(`${card.endpointId} maps ${v.mission}/${call}: one row per item, each with an id, its counter and its next-page field`, () => {
          expect(endpointOfCall(v.mission, call)).toBe(card.endpointId);
          const check = checkCardOnPage(card, page(v.mission, call));
          expect(check.issues).toEqual([]);
          // the call log's own row count for the page
          expect(check.rows.length).toBe(rowsOfCall(v.mission, call));
        });
      }
    }
  }

  it("a card is never checked on another tool's page: the TikHub card does not map an AnyAPI page", () => {
    const check = checkCardOnPage(cardOf("tikhub.tiktok.search.videos")!, page("msn_5851abc92a1e6645a9cd", "call_0002"));
    expect(check.issues).toContain("no list at the card's path");
  });

  it("the cards' mappings give the delivered ids of M12 (the stored rows): videos, comments, replies", () => {
    const m = "msn_5851abc92a1e6645a9cd";
    const videos = mapPage(cardOf("tikhub.tiktok.search.videos")!, page(m, "call_0007"));
    for (const v of rows(m, "videos")) {
      const mine = videos.find((r) => r.id === v.id)!;
      expect(mine).toBeTruthy();
      expect([mine.link, mine.comments, mine.likes, mine.posted_at, mine.country]).toEqual([v.link, v.comments, v.likes, v.posted_at, v.country]);
    }
    const comments = cardOf("anyapi.tiktok.video.comments")!;
    const ids = new Set<string>();
    for (let n = 8; n <= 29; n += 1) for (const r of mapPage(comments, page(m, `call_${String(n).padStart(4, "0")}`))) ids.add(String(r.id));
    for (const c of rows(m, "comments")) expect(ids.has(String(c.id))).toBe(true);
    const replies = cardOf("anyapi.tiktok.comment_replies")!;
    const rids = new Set<string>();
    for (let n = 30; n <= 96; n += 1) for (const r of mapPage(replies, page(m, `call_${String(n).padStart(4, "0")}`))) rids.add(String(r.id));
    for (const r of rows(m, "comments_replies")) expect(rids.has(String(r.id))).toBe(true);
  });

  it("M14: the X card maps the page the stored delivery came from to the same 20 tweets, in order", () => {
    const m = "msn_b060d3347ed7660f972e";
    const mapped = mapPage(cardOf("anyapi.x.search.posts")!, page(m, "call_0003"));
    expect(mapped.map((r) => r.id)).toEqual(rows(m, "tweets").map((r) => r.id));
  });

  it("the compiler sees only verified cards of the platform and role it asks for", () => {
    expect(cardsFor("tiktok", "videos.search").map((c) => c.endpointId)).toEqual(["tikhub.tiktok.search.videos", "anyapi.tiktok.search.videos", "crawl4ai.tiktok.search.videos"]);
    expect(cardsFor("x", "comment.replies")).toEqual([]);
    expect(cardsFor("facebook", "videos.search")).toEqual([]);
  });
});
