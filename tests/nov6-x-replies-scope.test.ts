import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { compilePlan, parentInputs, parentEligible } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf, TOOL_CARDS } from "../src/lib/agentMission/foundation/toolCards";
import { buildRequestContract, checkPlanAgainstContract, repliesAskedIn } from "../src/lib/agentMission/requestContract";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * NOV 6 2026 FIVE-PLATFORM ACCEPTANCE CAMPAIGN, X (msn_d31f37958788a24ec46d, job_quote_0c51137a3be88d007ef2b843c514a04c, test account, 200 points charged).
 * Request: «اجمع لي منشورين عامين من إكس عن الذكاء الاصطناعي، مع ردين حقيقيين على كل منشور، والروابط وأسماء الحسابات.»
 * Production plan (read-only SELECT of missions.plan): ONE stage «tweets», query `"الذكاء الاصطناعي"` with NO `-filter:replies`, queryType «Latest», no replies stage, no «not included» line;
 * its two pinned rows were themselves replies to other accounts (`is_reply: true`, `replies_count: 0`, posted 6 and 14 seconds before the request).
 *
 * Root causes reproduced here: (1) the reply words were read by `/ردود/` only, so the dual «ردين» asked nothing (`replies: "none"`); (2) `-filter:replies` and the originals-first rank depended on that flag;
 * (3) the contract gate exempted X from the replies check (and is not on the compiled path at all), so nothing said the step was dropped.
 *
 * DATA: the two reply rows are the STORED pinned rows of that plan (fields as stored, texts shortened). The two original tweets are SYNTHETIC (made up for this test, marked `synthetic`), in the shape of the verified card's real pages.
 */
const catalog = loadTregCatalog();
const capabilityOf = (id: string) => catalog.byId.get(id)?.capability ?? null;
const AT = Date.parse("2026-11-06T18:58:24Z");
const REQUEST = "اجمع لي منشورين عامين من إكس عن الذكاء الاصطناعي، مع ردين حقيقيين على كل منشور، والروابط وأسماء الحسابات.";
const searchCard = cardOf("anyapi.x.search.posts")!;

const item = (o: { id: string; text: string; name: string; user: string; followers: number; at: string; isReply: boolean; likes: number; replies: number; views: number | null }) => ({
  id: o.id, text: o.text, authorName: o.name, authorUsername: o.user, authorFollowers: o.followers, createdUtc: o.at, url: `https://x.com/i/web/status/${o.id}`, isReply: o.isReply, lang: "ar",
  likeCount: o.likes, replyCount: o.replies, retweetCount: 0, viewCount: o.views,
});
const STORED_REPLIES = [
  item({ id: "2118780026737041638", text: "@popyou21 @drjehadalhosan @Eyaaaad اسألي الذكاء الاصطناعي ولكن اكتبي انه يبحث في منظمة الصحة العالمية", name: "ناصر", user: "naseer_ri", followers: 123, at: "2026-11-06T18:58:18.000Z", isReply: true, likes: 0, replies: 0, views: 1 }),
  item({ id: "2118779993329480040", text: "@1Terhal هههه لا تدقق. يعني إذا بدك تعمل تطبيق متل تويتر أكيد الذكاء الاصطناعي لحاله مو كافي حالياً", name: "wael", user: "waelyash", followers: 2967, at: "2026-11-06T18:58:10.000Z", isReply: true, likes: 0, replies: 0, views: null }),
];
const SYNTHETIC_ORIGINALS = [
  item({ id: "9000000000000000001", text: "synthetic: كيف يغيّر الذكاء الاصطناعي سوق العمل في المنطقة", name: "synthetic one", user: "synthetic_one", followers: 5000, at: "2026-11-06T17:00:00.000Z", isReply: false, likes: 40, replies: 6, views: 9000 }),
  item({ id: "9000000000000000002", text: "synthetic: أدوات الذكاء الاصطناعي المجانية للطلاب", name: "synthetic two", user: "synthetic_two", followers: 800, at: "2026-11-06T16:00:00.000Z", isReply: false, likes: 12, replies: 3, views: 2000 }),
];
const pageOf = (items: unknown[]) => ({ output: { data: { items, nextCursor: null } } });

const compile = (items: unknown[], options: { cards?: typeof TOOL_CARDS } = {}) => {
  const ask = buildAsk(REQUEST, null, AT);
  return compilePlan({ ask, pool: { card: searchCard, params: parentInputs(searchCard, ask), pages: [{ callId: "call_0001", page: pageOf(items) }] }, exposure: () => undefined, capabilityOf, nowMs: AT, ...(options.cards ? { cards: options.cards } : {}) });
};

describe("the Arabic request asks for replies (root cause 1)", () => {
  it("the dual «ردين» is a replies request, two for each post; the parents are original posts", () => {
    const contract = buildRequestContract(REQUEST);
    expect(contract.platform).toBe("x");
    expect(contract.replies).toBe("some");
    const ask = buildAsk(REQUEST, null, AT);
    expect(ask.count).toBe(2);
    expect(ask.topic.text).toBe("الذكاء الاصطناعي");
    expect(ask.repliesPerTweet).toBe(2);
    // the tweets are chosen by their replies counter, never the newest seconds of the stream (both stored rows were 6 and 14 seconds old, with 0 replies)
    expect(ask.order).toBe("most_commented");
  });

  it.each([
    ["مع ردين على كل تغريدة", true], ["مع ردّين", true], ["وردان", true], ["مع ٣ رد على كل منشور", true], ["ردًا واحدًا على كل تغريدة", true], ["مع الرد", true], ["مع الردود", true], ["تغريدات وردودها", true],
    ["ردود فعل الناس على القرار", false], ["رد فعل الجمهور", false], ["ورد في التقرير أن", false], ["الجو برد", false], ["عن الذكاء الاصطناعي", false],
  ])("%s → replies asked: %s", (text, asked) => {
    expect(repliesAskedIn(text)).toBe(asked);
  });
});

describe("the parents are ORIGINAL posts (root cause 2)", () => {
  it("the search asks the source for originals only, whatever the replies flag", () => {
    const ask = buildAsk(REQUEST, null, AT);
    expect(parentInputs(searchCard, ask)).toEqual({ query: "\"الذكاء الاصطناعي\" -filter:replies", queryType: "Top", limit: 20 });
    const noReplies = buildAsk("هات تغريدتين على إكس عن الذكاء الاصطناعي", null, AT);
    expect(String(parentInputs(searchCard, noReplies).query)).toMatch(/-filter:replies$/);
  });

  it("a tweet the source marks as a reply is never a parent", () => {
    expect(parentEligible({ is_reply: true }, { platform: "x" })).toBe(false);
    expect(parentEligible({ is_reply: false }, { platform: "x" })).toBe(true);
    expect(parentEligible({ is_reply: true }, { platform: "tiktok" })).toBe(true);
  });

  it("THE FAILURE SHAPE: the stored replies come first in the page; the plan chooses only the originals, never bills a reply as a post, and says what it left out", () => {
    const r = compile([...STORED_REPLIES, ...SYNTHETIC_ORIGINALS]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.chosen).toEqual(["9000000000000000001", "9000000000000000002"]);
    expect(r.chosen).not.toContain("2118780026737041638");
    expect(r.chosen).not.toContain("2118779993329480040");
    const tweets = r.plan.stages[0];
    expect((tweets.pinned_rows ?? []).every((row) => (row as Record<string, unknown>).is_reply !== true)).toBe(true);
    expect(r.plan.notes_ar!.join(" ")).toContain("لم نختر أي تغريدة هي نفسها ردّ على حساب آخر؛ تركنا ٢");
  });

  it("a page of replies ONLY: no plan is made from them (nothing priced, nothing held), never «two posts»", () => {
    const r = compile(STORED_REPLIES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_rows");
  });

  it("one original and the two replies: ONE post is planned and the card says one of two (partial, truthful)", () => {
    const r = compile([...STORED_REPLIES, SYNTHETIC_ORIGINALS[0]]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.chosen).toEqual(["9000000000000000001"]);
    expect(r.plan.stages[0].planned_rows).toBe(1);
    expect(r.plan.notes_ar!.join(" ")).toContain("وجدنا في ما قرأناه ١ فقط تناسب طلبك من ٢");
  });
});

describe("the replies step is CARRIED with the customer's number, or SAID before approval (root cause 3)", () => {
  it("the plan has the tweets AND their replies, two for each tweet, bound to the real tweet links", () => {
    const r = compile([...STORED_REPLIES, ...SYNTHETIC_ORIGINALS]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.stages.map((s) => s.key)).toEqual(["tweets", "replies"]);
    const replies = r.plan.stages[1];
    expect(replies.parent_key).toBe("tweets");
    expect(replies.replies_of).toBe("tweets");
    expect(replies.per_parent_rows).toBe(2);
    expect(replies.engine!.parent_binding).toEqual({ param: "url", from: "link" });
    expect((replies as unknown as Record<string, unknown>).replies_uncapped).toBeUndefined();
    // the two counters (6 and 3) cut at 2 each: 4 replies at most, in the hold
    expect(replies.planned_rows).toBe(4);
    expect(r.plan.unserved_steps).toBeUndefined();
    expect(r.plan.summary_ar).toContain("ردود");
    expect(r.plan.notes_ar!.join(" ")).toContain("الردود: حتى ٢ من الردود على كل تغريدة مختارة");
    for (const line of [r.plan.summary_ar, ...(r.plan.notes_ar ?? [])]) expect(checkCustomerText(line).issues).toEqual([]);
  });

  it("NO reply card on the platform: the step is NOT included, said on the card, and not in the price", () => {
    const r = compile([...STORED_REPLIES, ...SYNTHETIC_ORIGINALS], { cards: TOOL_CARDS.filter((c) => c.role !== "tweet.replies") });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.stages.map((s) => s.key)).toEqual(["tweets"]);
    expect(r.plan.unserved_steps?.map((u) => u.what_ar)).toEqual(["الردود"]);
    expect(r.plan.summary_ar).not.toContain("ردود");
    expect(r.plan.price.deliveredRows).toBe(2);
  });

  it("the contract check no longer exempts X from a requested replies step", () => {
    const contract = buildRequestContract(REQUEST);
    const top = { key: "tweets", parent_key: null, deliver: true, planned_rows: 2, endpoint_id: "anyapi.x.search.posts" };
    const verdict = checkPlanAgainstContract(contract, { stages: [top] } as never);
    expect(verdict.missingStages).toEqual(["replies"]);
    const stated = checkPlanAgainstContract(contract, { stages: [top], unserved_steps: [{ what_ar: "الردود", reason_ar: "x" }] } as never);
    expect(stated.items.find((i) => i.what === "replies")?.status).toBe("stated");
  });
});
