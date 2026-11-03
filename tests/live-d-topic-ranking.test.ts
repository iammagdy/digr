import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { compilePlan, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { rankPool, topicTierOf } from "../src/lib/agentMission/foundation/pool";
import { cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { loadTregCatalog } from "../src/lib/treg/catalog";

/**
 * LIVE FINDING D1 (3 Nov 2026, msn_2dfcf9cc113dff442711): «فيديوهين عن الذكاء الاصطناعي»: both chosen videos were AI-generated cartoon stories whose caption names the topic ONLY in its hashtags
 * (#ai #ذكاء_اصطناعي next to #كرتون). The pool ranking counted any occurrence of the topic words anywhere in the caption, so a hashtag-only caption tied with a caption that is ABOUT the topic,
 * and the most commented of them won. The owner's rule: in the «the item's own text talks about the topic» tier, a match only inside hashtags ranks below a match in the caption body (the
 * hashtags then name the TOOL the video was made with, not its subject). Ranking only: nothing is removed from the pool.
 *
 * WHAT IS REAL AND WHAT IS NOT. The anonymiser (tests/fixtures/live/anonymise.py) replaces every caption with a placeholder, so no real caption is, or may be, in this public repo. The page below
 * is the REAL anonymised first page of the SAME search (M12, tikhub.tiktok.search.videos, 10 rows: the structure, the ids, the counters, the countries and the languages are real: 7692547380482346263
 * is one of the two videos of the live mission); only the `desc` of each row is replaced by a made-up caption that has the STRUCTURE the owner quoted: a story sentence followed by a hashtag list.
 */
const catalog = loadTregCatalog();
void catalog;
const AT = Date.parse("2026-11-03T07:11:32Z");
const REQUEST = "عايز فيديوهين من تيك توك من مصر بالعربي عن الذكاء الاصطناعي، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم";
const card = cardOf("tikhub.tiktok.search.videos")!;
const real = JSON.parse(readFileSync(new URL("./fixtures/live/missions/msn_5851abc92a1e6645a9cd/raw/call_0007.json", import.meta.url), "utf8")) as { data: { search_item_list: Array<{ aweme_info: Record<string, unknown> }> } };

/** The real page with the made-up captions (by video id); a video with no caption given keeps its placeholder. */
function pageWith(captions: Record<string, string>): unknown {
  const copy = JSON.parse(JSON.stringify(real)) as typeof real;
  for (const it of copy.data.search_item_list) { const c = captions[String(it.aweme_info.aweme_id)]; if (c !== undefined) it.aweme_info.desc = c; }
  return copy;
}
const ids = real.data.search_item_list.map((x) => String(x.aweme_info.aweme_id));
const counterOf = (id: string): number => Number((real.data.search_item_list.find((x) => String(x.aweme_info.aweme_id) === id)!.aweme_info.statistics as { comment_count: number }).comment_count);
const egArabic = ids.filter((id) => { const a = real.data.search_item_list.find((x) => String(x.aweme_info.aweme_id) === id)!.aweme_info; return a.region === "EG" && a.desc_language === "ar"; });

describe("D1: the topic only in the hashtags ranks below the topic in the caption body", () => {
  it("the real page has Egyptian Arabic videos with different counters to rank (the structure the test stands on)", () => {
    expect(ids).toHaveLength(10);
    expect(egArabic.length).toBeGreaterThanOrEqual(3);
    expect(new Set(egArabic.map(counterOf)).size).toBe(egArabic.length);
  });

  it("topicTierOf: 2 = the words are in the caption body, 1 = only inside hashtags (the tool), 0 = not there", () => {
    const ask = buildAsk(REQUEST, null, AT);
    expect(ask.topic).toEqual({ text: "الذكاء الاصطناعي", relation: "about" });
    expect(topicTierOf("كيف يغير الذكاء الاصطناعي سوق العمل؟ #تقنية", ask)).toBe(2);
    expect(topicTierOf("فراوله كان بيبكي فلوس واهله بيستغلوه الجزء الاول #ai #كرتون #ذكاء_اصطناعي", ask)).toBe(1);
    expect(topicTierOf("شوف القط الشاطر بيعمل ايه #ترند ##AIبالعربي #ذكاء_اصطناعي #قصص", ask)).toBe(1);
    expect(topicTierOf("ماتش الاهلي النهارده #كورة", ask)).toBe(0);
    // a caption that is ONLY hashtags and the topic is in a hashtag: tier 1, never "about"
    expect(topicTierOf("#ذكاء_اصطناعي", ask)).toBe(1);
  });

  it("the owner's order inside the topic tier: a body match beats a hashtag-only match even when the hashtag-only video has far more comments", () => {
    const [a, b, c, d] = egArabic;
    const ask = buildAsk(REQUEST, null, AT);
    const sorted = [...egArabic].sort((x, y) => counterOf(y) - counterOf(x));
    // the MOST commented video is hashtag-only (as live: 286 and 221 comments), the least commented one is about the topic in its body
    const mostCommented = sorted[0];
    const leastCommented = sorted[sorted.length - 1];
    const captions: Record<string, string> = {};
    for (const id of egArabic) captions[id] = "قصة بطاطس وطماطم بالكرتون #ai #كرتون #ذكاء_اصطناعي";
    captions[leastCommented] = "شرح مبسط عن الذكاء الاصطناعي وازاي بيشتغل #تقنية";
    void [a, b, c, d];
    const rows = mapPage(card, pageWith(captions));
    const ranked = rankPool(rows, ask, card).map((r) => r.id);
    expect(ranked[0]).toBe(leastCommented);
    expect(ranked.indexOf(mostCommented)).toBeGreaterThan(ranked.indexOf(leastCommented));
    // the hashtag-only videos come next, still by the most commented
    const hashtagOnly = egArabic.filter((id) => id !== leastCommented).sort((x, y) => counterOf(y) - counterOf(x));
    expect(ranked.slice(1, 1 + hashtagOnly.length)).toEqual(hashtagOnly);
    // nothing is dropped: every distinct row of the pool is still ranked
    expect(ranked).toHaveLength(rows.length);
  });

  it("when the customer asked for what is MADE WITH the topic («معمول بالذكاء الاصطناعي»), the hashtag match is what they want and ranks as the body match (the counter decides)", () => {
    const ask = buildAsk("عايز فيديوهين من تيك توك من مصر بالعربي معمول بالذكاء الاصطناعي، أكتر فيديوهات عليها تعليقات", null, AT);
    expect(ask.topic.relation).toBe("made_with");
    expect(topicTierOf("قصة بطاطس وطماطم بالكرتون #ai #كرتون #ذكاء_اصطناعي", ask)).toBe(2);
    expect(topicTierOf("شرح عن الذكاء الاصطناعي #تقنية", ask)).toBe(2);
  });

  it("a caption with no hashtag at all, the topic in the body, is unchanged (tier 2): the rule only separates hashtags from the body", () => {
    expect(topicTierOf("الذكاء الاصطناعي", buildAsk(REQUEST, null, AT))).toBe(2);
  });
});

describe("D1: the plan card says so before approval when no video of the pool is about the topic", () => {
  const ask = buildAsk(REQUEST, null, AT);
  const compile = (captions: Record<string, string>) => {
    const pool = { card, params: parentInputs(card, ask), pages: [{ callId: "call_0007", page: pageWith(captions) }] };
    return compilePlan({ ask, pool, exposure: () => ({ callId: null, page: null, failed: true }), capabilityOf: () => null });
  };
  const allHashtagOnly = Object.fromEntries(ids.map((id) => [id, "قصة كرتونية قصيرة #ai #كرتون #ذكاء_اصطناعي"]));

  it("every caption names the topic only in hashtags: the card says the topic is the tool, not the subject, and that the chosen videos are not about it", () => {
    const r = compile(allHashtagOnly);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const notes = (r.plan.notes_ar ?? []).join("\n");
    expect(notes).toMatch(/لم نجد في ما قرأناه فيديو يتحدث نصه عن «الذكاء الاصطناعي»/);
    expect(notes).toMatch(/الوسوم/);
    expect(notes).toMatch(/أداة/);
    // ranking, never a drop: two videos are still chosen
    expect(r.chosen).toHaveLength(2);
  });

  it("one video is about the topic in its body: it is chosen first and the card does not claim the pool had none", () => {
    const lastEg = [...egArabic].sort((x, y) => counterOf(x) - counterOf(y))[0];
    const r = compile({ ...allHashtagOnly, [lastEg]: "ايه هو الذكاء الاصطناعي وازاي بيغير حياتنا #تقنية" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chosen[0]).toBe(lastEg);
    const notes = (r.plan.notes_ar ?? []).join("\n");
    expect(notes).not.toMatch(/لم نجد في ما قرأناه فيديو يتحدث نصه عن/);
    // the second chosen video is below «about»: said, with its number, on the card
    expect(notes).toMatch(/١ من العناصر المختارة يذكر الموضوع في الوسوم فقط/);
  });

  it("the customer's words are all about the topic in the body: no topic note at all", () => {
    const r = compile(Object.fromEntries(ids.map((id) => [id, "كل ما تريد معرفته عن الذكاء الاصطناعي #تقنية"])));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.plan.notes_ar ?? []).join("\n")).not.toMatch(/الوسوم/);
  });
});
