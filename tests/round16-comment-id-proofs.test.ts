import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMENT_ID_PROOFS } from "../src/lib/agentMission/foundation/alternatives";
import { cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";

/**
 * ROUND 16: THE ID PROOFS ARE RECOMPUTED FROM THE STORED PAGES. A pair of comments cards may continue each other only if the same comment has the same id in both (the only de-duplication is the exact identity). Each proof in COMMENT_ID_PROOFS names the calls of the two cards on the SAME parent;
 * here the two stored pages are mapped by the cards' own mappings and compared: the parent is the same, and every comment both pages hold has one id (never matched by text, author or time: the check below uses them only to PROVE the ids equal, not to merge anything).
 */
type IndexRow = [string, string, string, string, number, Record<string, unknown>];
const INDEX = JSON.parse(readFileSync(new URL("./fixtures/live/call-index.json", import.meta.url), "utf8")) as { missions: Record<string, IndexRow[]> };
const callOf = (mission: string, call: string): IndexRow => INDEX.missions[mission].find((c) => c[0] === call)!;
const page = (mission: string, call: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${mission}/raw/${call}.json`, import.meta.url), "utf8"));
const parentOf = (params: Record<string, unknown>): string => String(params.url ?? params.video ?? params.video_id ?? "");

describe("every id proof holds on its stored pages", () => {
  for (const p of COMMENT_ID_PROOFS) {
    it(`${p.a} and ${p.b}: the calls are those of the two cards, on the same parent, and the comments both gave have the same id`, () => {
      const a = callOf(p.mission.a, p.calls.a[0]);
      const b = callOf(p.mission.b, p.calls.b[0]);
      expect(a[2]).toBe(p.a);
      expect(b[2]).toBe(p.b);
      expect(parentOf(a[5])).toBe(parentOf(b[5]));
      const rowsA = mapPage(cardOf(p.a)!, page(p.mission.a, p.calls.a[0]));
      const rowsB = mapPage(cardOf(p.b)!, page(p.mission.b, p.calls.b[0]));
      const idsA = new Set(rowsA.map((r) => String(r.id)));
      const common = rowsB.filter((r) => idsA.has(String(r.id)));
      expect(common.length).toBeGreaterThanOrEqual(1);
      // for the pair read inside ONE anonymisation run (same salt: the same text is the same placeholder), the comment with the same text and instant has the same id, and no comment of one page has the id of a DIFFERENT text of the other
      if (p.mission.a === p.mission.b) {
        for (const r of rowsB) {
          const same = rowsA.find((x) => String(x.id) === String(r.id));
          if (same) expect([same.text, same.posted_at]).toEqual([r.text, r.posted_at]);
        }
      }
    });
  }
  it("the Instagram page of the proof really is one parent and one comment on both cards (thin evidence, said in the module: the live round is asked for more)", () => {
    const p = COMMENT_ID_PROOFS.find((x) => x.a === "anyapi.instagram.post.comments")!;
    expect(mapPage(cardOf(p.a)!, page(p.mission.a, p.calls.a[0]))).toHaveLength(1);
    expect(mapPage(cardOf(p.b)!, page(p.mission.b, p.calls.b[0]))).toHaveLength(1);
  });
  it("the YouTube pages hold several comments in common (their native ids)", () => {
    const p = COMMENT_ID_PROOFS.find((x) => x.a === "crawl4ai.youtube.video.comments")!;
    const a = new Set(mapPage(cardOf(p.a)!, page(p.mission.a, p.calls.a[0])).map((r) => String(r.id)));
    const common = mapPage(cardOf(p.b)!, page(p.mission.b, p.calls.b[0])).filter((r) => a.has(String(r.id)));
    expect(common.length).toBeGreaterThanOrEqual(2);
  });
});
