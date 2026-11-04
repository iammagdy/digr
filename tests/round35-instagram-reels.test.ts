import { describe, expect, it } from "vitest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { buildRequestContract } from "../src/lib/agentMission/requestContract";
import { discoverCards } from "../src/lib/agentMission/foundation/discovery/deriveCards";
import { forReels, mediaNotesAr, reelsBasisOf, reelsCandidates } from "../src/lib/agentMission/foundation/discovery/media";
import { INSTAGRAM_CARDS } from "../src/lib/agentMission/foundation/toolCards/instagram";
import { NO_SENSITIVE_ACCESS } from "../src/lib/treg/dataPolicy";
import { catalog, catalogPage, discoveryWorld } from "./helpers/discoveryWorld";

/**
 * ROUND 35, BLOCKER B: A REQUEST FOR INSTAGRAM REELS. The real mission msn_9eea13f7… («عايز ٥ ريلز من إنستجرام عن الذكاء الاصطناعي», discovery on) read the hashtag search of POSTS with only `{hashtag}` (its stored call params), no media-type input, and delivered `/p/` posts
 * (its stored sample rows) under the title «منشورات»: the word «ريلز» was parsed as nothing. Now the request carries `media: "reels"`; only a tool that PROVES the media type serves it (a reels-only capability, or the tool's own documented media-type input, sent on every call);
 * any other tool is disclosed as unproven BEFORE approval. EVIDENCE LABELS: the endpoints' inputs come from the REAL catalog snapshot; the pages are SIMULATED (built from the catalog's example shape); the real mission's stored params and rows are quoted as data.
 */
const ANYAPI_HASHTAG = "anyapi.instagram.hashtag.posts";
const SC_HASHTAG = "scrapecreators.x.v1-instagram-search-hashtag";
const SC_REELS = "scrapecreators.x.v2-instagram-reels-search";
const REQUEST = "عايز ٥ ريلز من إنستجرام عن الذكاء الاصطناعي";

describe("the request's words", () => {
  it("«٥ ريلز» is a count of five and a request for reels; the real mission's request was read as no count and no kind", () => {
    const a = buildAsk(REQUEST, null, Date.UTC(2026, 10, 4));
    expect(a.media).toBe("reels");
    expect(a.count).toBe(5);
    expect(a.platform).toBe("instagram");
    expect(a.parentKind).toBe("posts");
    for (const t of ["ريل", "ريلز", "الريلز", "ريلات", "reels", "Reel"]) expect(buildRequestContract(`هات ٣ ${t} من انستجرام عن القهوة`).media, t).toBe("reels");
  });
  it("posts, April and trillion are not reels; reels asked of another platform is not an Instagram media type", () => {
    for (const t of ["عايز ٥ منشورات من إنستجرام عن الذكاء الاصطناعي", "منشورات إنستجرام في أبريل عن القهوة", "٥ منشورات عن اقتصاد بقيمة تريليون دولار من إنستجرام"]) expect(buildRequestContract(t).media, t).toBeUndefined();
    expect(buildRequestContract("٥ ريلز من تيك توك عن القهوة").media).toBeUndefined();
    expect(buildAsk("عايز ٥ منشورات من إنستجرام عن القهوة", null, Date.UTC(2026, 10, 4)).media).toBeUndefined();
  });
});

describe("what the catalog documents (REAL snapshot)", () => {
  const cards = discoverCards(catalog, "instagram", NO_SENSITIVE_ACCESS).cards;
  const byId = (id: string) => cards.find((c) => c.endpointId === id);
  it("the hashtag search of posts that the real mission used lists a media-type input with the value «reel»; the reels search is reels by its capability; a plain posts tool proves nothing", () => {
    expect(catalog.byId.get(ANYAPI_HASHTAG)!.inputs.find((i) => i.name === "mediaType")!.enum).toEqual(["all", "reel"]);
    expect(byId(ANYAPI_HASHTAG)?.media).toEqual({ reels: { field: "mediaType", value: "reel" } });
    expect(byId(SC_HASHTAG)?.media).toEqual({ reels: { field: "media_type", value: "reels" } });
    expect(byId(SC_REELS)?.media).toEqual({ reels: "native" });
    for (const c of cards) if (c.role === "posts.account" && !/reels$/.test(catalog.byId.get(c.endpointId)!.capability ?? "")) expect(c.media, c.endpointId).toBeUndefined();
    for (const c of INSTAGRAM_CARDS) expect(reelsBasisOf(c), c.endpointId).toBe("unproven");
  });
  it("a filter tool carries its documented value on every call; a native tool is unchanged; with no tool that proves it the candidates are returned as they were", () => {
    const c = byId(ANYAPI_HASHTAG)!;
    expect(forReels(c).inputs.fixed).toEqual({ mediaType: "reel" });
    expect(c.inputs.fixed).toBeUndefined();
    expect(forReels(byId(SC_REELS)!)).toBe(byId(SC_REELS));
    const mixed = reelsCandidates([INSTAGRAM_CARDS[0], c]);
    expect(mixed.proven).toBe(true);
    expect(mixed.list.map((x) => x.endpointId)).toEqual([ANYAPI_HASHTAG]);
    expect(reelsCandidates([INSTAGRAM_CARDS[0]])).toMatchObject({ proven: false });
  });
});

const reel = (i: number) => ({ id: `39000000000000${String(i).padStart(5, "0")}`, shortcode: `Rl${i}`, url: `https://www.instagram.com/reel/Rl${i}/`, caption: `ريل عن الذكاء الاصطناعي ${i}`, video_view_count: i, video_play_count: i * 10, product_type: "clips", taken_at_timestamp: 1_790_000_000 + i, owner: { username: `u${i}` } });
const anyapiPost = (i: number) => ({ id: `39000000000000${String(i).padStart(5, "0")}`, shortcode: `Rl${i}`, url: `https://www.instagram.com/reel/Rl${i}/`, caption: `ريل عن الذكاء الاصطناعي ${i}`, username: `u${i}`, likes: i, comments: i, createdUtc: 1_790_000_000 + i, type: "XDTGraphVideo" });

describe("the plan of a request for reels (discovery on, SIMULATED pages)", () => {
  it("the media-type input is SENT, the plan says how the type is served, and its summary says reels only because the type is proven", async () => {
    const w = discoveryWorld(REQUEST, {
      [ANYAPI_HASHTAG]: () => catalogPage(ANYAPI_HASHTAG, Array.from({ length: 10 }, (_, i) => anyapiPost(i + 1)), "c2"),
      [SC_HASHTAG]: () => catalogPage(SC_HASHTAG, Array.from({ length: 10 }, (_, i) => reel(i + 1)), null),
      [SC_REELS]: () => catalogPage(SC_REELS, Array.from({ length: 10 }, (_, i) => reel(i + 1)), null),
    }, { discovery: true, platform: "instagram" });
    const r = await w.plan();
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const media = r.plan.compiled!.media!;
    expect(media.asked).toBe("reels");
    expect(["native", "filter"]).toContain(media.basis);
    // what was really called: either a reels-only tool, or a hashtag tool WITH its documented media-type value (never the bare hashtag call of the real mission)
    const first = w.calls[0];
    if (media.basis === "filter") expect(first.params).toMatchObject({ [media.filter!.field]: media.filter!.value });
    else expect(first.endpoint).toBe(SC_REELS);
    for (const c of w.calls) expect([ANYAPI_HASHTAG, SC_HASHTAG, SC_REELS]).toContain(c.endpoint);
    expect(r.plan.compiled!.discovery!.media).toEqual(media);
    expect(r.plan.summary_ar).toBe("٥ ريلز من إنستجرام عن «الذكاء الاصطناعي».");
    expect((r.plan.notes_ar ?? []).join("\n")).toContain("طلبت ريلز");
    expect((r.plan.notes_ar ?? []).join("\n")).not.toMatch(/anyapi|scrapecreators|tikhub|endpoint|USD/i);
    expect(r.ask.count).toBe(5);
  });
  it("the same request for plain POSTS is unchanged: no media mark, no media-type input sent, the summary says posts", async () => {
    const w = discoveryWorld("عايز ٥ منشورات من إنستجرام عن الذكاء الاصطناعي", { [ANYAPI_HASHTAG]: () => catalogPage(ANYAPI_HASHTAG, Array.from({ length: 10 }, (_, i) => anyapiPost(i + 1)), "c2"), [SC_HASHTAG]: () => catalogPage(SC_HASHTAG, Array.from({ length: 10 }, (_, i) => reel(i + 1)), null), [SC_REELS]: () => catalogPage(SC_REELS, Array.from({ length: 10 }, (_, i) => reel(i + 1)), null) }, { discovery: true, platform: "instagram" });
    const r = await w.plan();
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(r.plan.compiled!.media).toBeUndefined();
    expect(r.plan.summary_ar).toBe("٥ منشورات من إنستجرام عن «الذكاء الاصطناعي».");
    for (const c of w.calls) expect(Object.keys(c.params)).not.toContain("mediaType");
  });
});

describe("a customer (discovery off): the verified account listing cannot prove reels, and the plan says so", () => {
  it("a named account with reels asked: basis unproven, the disclosure is in the plan, the summary does not say reels, nothing is removed", async () => {
    const item = (i: number) => ({ pk: `39000000000000${i}`, code: `Ac${i}`, caption: { text: `منشور ${i}` }, user: { username: "natgeo" }, taken_at: 1_790_000_000 + i, like_count: i, comment_count: i, play_count: i * 3 });
    const w = discoveryWorld("عايز ٥ ريلز من حساب @natgeo على إنستجرام", { "scrapecreators.instagram.user.posts": () => ({ items: Array.from({ length: 12 }, (_, i) => item(i + 1)), next_max_id: null, more_available: false }) }, { discovery: false, platform: "instagram" });
    const r = await w.plan();
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(r.plan.compiled!.media).toEqual({ asked: "reels", basis: "unproven" });
    expect(r.plan.summary_ar).not.toContain("ريلز");
    expect(r.plan.summary_ar).toContain("منشور");
    expect((r.plan.notes_ar ?? []).join("\n")).toContain("لا يثبت نوع المحتوى");
    expect(r.plan.compiled!.discovery).toBeUndefined();
  });
  it("the three sentences never name a provider or a tool", () => {
    for (const basis of ["native", "filter", "unproven"] as const) expect(mediaNotesAr({ asked: "reels", basis }).join(" ")).not.toMatch(/anyapi|scrapecreators|tikhub|justoneapi|endpoint|\$|USD/i);
  });
});
