import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { compilePlan, parentEligible, parentInputs, topicGated } from "../src/lib/agentMission/foundation/compilePlan";
import { topicTierOf } from "../src/lib/agentMission/foundation/pool";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { discoverCards } from "../src/lib/agentMission/foundation/discovery/deriveCards";
import { NO_SENSITIVE_ACCESS } from "../src/lib/treg/dataPolicy";
import { buildRequestContract, optionalPartsOf } from "../src/lib/agentMission/requestContract";
import { topicRelationAr } from "../src/lib/agentMission/foundation/topicChoice";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * NOV 6 2026 FIVE-PLATFORM ACCEPTANCE CAMPAIGN: TOPIC RELEVANCE (test account; read-only SELECTs of the missions' stored plans).
 *  - Facebook msn_60fd71cf5e4d1c9fc5f2 (job_quote_7125022b542d8c612366926f2c5c2098, 215 charged): «… عن الذكاء الاصطناعي (منشورات فيديو لو متاح)، مع تعليقين …». Stored: topic and search keyword
 *    «الذكاء الاصطناعي (منشورات فيديو لو متاح)», a question «كم تعليقًا تريد من كل فيديو؟» (the request asked posts), 12 posts read, «منها يتحدث نصه عن …: ١», and a chosen post marked «لا يذكر الموضوع».
 *  - Instagram msn_34dcf09434697a62995c (job_quote_23f61141a3992490106b91a818e3a74d, 100 charged): «… عن الذكاء الاصطناعي (ريلز لو متاح) …». Stored: keyword «الذكاء الاصطناعي (ريلز لو متاح)», 4 reels read, 0 «about», and
 *    both chosen reels marked «لا يذكر الموضوع»: a dental clinic advertisement (#dentist #advertising) and an AI-made reel tagged #ai #aigenerated.
 * DATA: the reel and post rows below are the STORED pinned rows of those plans (texts as stored, shortened). Rows named `synthetic` are made up for this test.
 */
const catalog = loadTregCatalog();
const capabilityOf = (id: string) => catalog.byId.get(id)?.capability ?? null;
const AT = Date.parse("2026-11-06T18:19:13Z");
const FB = "اجمع لي منشورين عامين من فيسبوك عن الذكاء الاصطناعي (منشورات فيديو لو متاح)، مع تعليقين حقيقيين على كل منشور، والروابط وأسماء الصفحات.";
const IG = "اجمع لي منشورين عامين من إنستجرام عن الذكاء الاصطناعي (ريلز لو متاح)، مع تعليقين حقيقيين على كل منشور، والروابط وأسماء الحسابات.";

const DENTAL_AD = "من إعلانتنا لعيادة B Smile علاج و حشو العصب 3D animation ♥\n#animation #dentist #3d #virałreels #fyp #advertising #AD #marketing #viral #dental #beesocial #endod";
const AI_TAGGED = "شكلي كدا هبقي جامد في المجال دة !! \n#ai #aigenerated #aiart #aivideo #generativeai #aihorror #midjourney #runwayml #sora #elevenlabs #aianimation #aifilmmaking";
const FB_ABOUT = "🚨 عاجل: الذكاء الاصطناعي بقى يقدر يعملك 30 فيديو شورتس في يوم واحد، كأن عندك فريق مونتاج كامل شغّال معاك.";
const FB_JOKE = "حتى الذكاء الاصطناعي طلع #يكذب\nأرسلت له صورتي قال #يزينك👌\n\n#كيفكم✨";

describe("optional wording is a preference, never the topic, the keyword or the kind", () => {
  it("the two stored requests: the topic is «الذكاء الاصطناعي», the preference is kept apart, the Facebook request is POSTS", () => {
    expect(optionalPartsOf(FB)).toEqual({ required: expect.not.stringContaining("لو متاح"), preferences: ["منشورات فيديو لو متاح"] });
    const fb = buildAsk(FB, null, AT);
    expect(fb.topic.text).toBe("الذكاء الاصطناعي");
    expect(fb.parentKind).toBe("posts");
    expect(fb.preferences).toEqual(["منشورات فيديو لو متاح"]);
    // the dual «تعليقين … على كل منشور» is 2 per post: no «كم تعليقًا تريد من كل فيديو؟» question
    expect(fb.commentsPerParent).toBe(2);
    expect(fb.commentsBare).toBeNull();
    const ig = buildAsk(IG, null, AT);
    expect(ig.topic.text).toBe("الذكاء الاصطناعي");
    expect(ig.preferences).toEqual(["ريلز لو متاح"]);
    // reels stay the PREFERRED media (the tool that proves reels is used when there is one), as before
    expect(ig.media).toBe("reels");
  });

  it("the search keyword is the topic alone (stored: «الذكاء الاصطناعي (منشورات فيديو لو متاح)»)", () => {
    const fb = buildAsk(FB, null, AT);
    expect(parentInputs(cardOf("justoneapi.x.facebook-search-post-v1")!, fb)).toEqual({ keyword: "الذكاء الاصطناعي" });
  });

  it.each([
    ["عن القهوة (ويفضل فيديو إن أمكن)", "القهوة"],
    ["عن القهوة، ويفضل فيديو لو متاح، مع التعليقات", "القهوة"],
    ["عن القهوة (if available, videos)", "القهوة"],
    ["عن كرة القدم (مباريات الدوري)", "كرة القدم (مباريات الدوري)"],
  ])("%s → topic %s (a parenthesis with no availability condition is the customer's words and is kept)", (tail, topic) => {
    expect(buildRequestContract(`هات منشورين من فيسبوك ${tail}`).topic).toBe(topic);
  });
});

describe("relevance: substantive, tag-only and unrelated are told apart by the item's own text; nothing is invented", () => {
  const ask = buildAsk(IG, null, AT);
  it("the dental advertisement and the reel tagged only in English are UNRELATED to «الذكاء الاصطناعي» (no translation, no synonym is guessed)", () => {
    expect(topicTierOf(DENTAL_AD, ask)).toBe(0);
    expect(topicTierOf(AI_TAGGED, ask)).toBe(0);
    expect(topicTierOf("ريل جديد #الذكاء_الاصطناعي", ask)).toBe(1);
    expect(topicRelationAr(1)).toBe("يذكر الموضوع في الوسوم فقط");
    expect(topicTierOf(FB_ABOUT, ask)).toBe(2);
  });
  it("THE FACEBOOK «joke» post names the topic in its own body text, so code reads it as «يتحدث نصه عن الموضوع»; whether it is a serious post is not judged by code (stated, not hidden)", () => {
    expect(topicTierOf(FB_JOKE, ask)).toBe(2);
    // with the stored, contaminated topic every word of «(منشورات فيديو لو متاح)» was required: the same post read «لا يذكر الموضوع» (the stored mark)
    expect(topicTierOf(FB_JOKE, { topic: { text: "الذكاء الاصطناعي (منشورات فيديو لو متاح)", relation: "about" } })).toBe(0);
  });
  it("the gate: a keyword search on Facebook or Instagram with no named source; a named source keeps the earlier mark-only rule", () => {
    expect(topicGated(buildAsk(IG, null, AT))).toBe(true);
    expect(topicGated(buildAsk(FB, null, AT))).toBe(true);
    expect(topicGated(buildAsk("هات منشورين من صفحة الجزيرة على فيسبوك عن الذكاء الاصطناعي", null, AT))).toBe(false);
    expect(topicGated(buildAsk("هات تغريدتين على إكس عن الذكاء الاصطناعي", null, AT))).toBe(false);
    expect(parentEligible({ text: DENTAL_AD }, buildAsk(IG, null, AT))).toBe(false);
    expect(parentEligible({ text: DENTAL_AD }, buildAsk(IG, null, AT), { allowUnrelated: true })).toBe(true);
  });
});

describe("Instagram: the stored reels are never chosen for «عن الذكاء الاصطناعي»", () => {
  const reelsCard = discoverCards(catalog, "instagram", NO_SENSITIVE_ACCESS).cards.find((c) => c.endpointId === "scrapecreators.x.v2-instagram-reels-search")!;
  const reel = (id: string, shortcode: string, caption: string, views: number) => ({ id, __typename: "XDTGraphVideo", shortcode, url: `https://www.instagram.com/reel/${shortcode}/`, caption, product_type: "clips", video_view_count: views });
  const STORED = [reel("3980534811939030016", "Dc9s1JZs8QA", AI_TAGGED, 2159), reel("3889833501646056429", "DX7dvXlBuvt", DENTAL_AD, 1)];
  const SYNTHETIC_ABOUT = reel("9100000000000000001", "SYNTH01", "synthetic: كيف يغيّر الذكاء الاصطناعي صناعة الأفلام القصيرة", 500);
  const compileIg = (items: unknown[], allowUnrelated = false) => {
    const ask = buildAsk(IG, null, AT);
    const page = { reels: items, success: true };
    return compilePlan({ ask, pool: { card: reelsCard, params: parentInputs(reelsCard, ask), pages: [{ callId: "call_0001", page }] }, exposure: () => ({ callId: null, page: null, failed: true }), capabilityOf, catalogOnly: true, cards: discoverCards(catalog, "instagram", NO_SENSITIVE_ACCESS).cards, reelsProven: true, nowMs: AT, ...(allowUnrelated ? { allowUnrelated: true } : {}) });
  };

  it("the derived reels card reads the stored rows", () => {
    expect(reelsCard).toBeDefined();
  });

  it("the stored pool alone (no reel names the topic): nothing is planned, nothing priced; the customer is asked (go on marked / change / cancel)", () => {
    const r = compileIg(STORED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r).toMatchObject({ reason: "no_relevant_rows", read: 2, tagOnly: 0 });
  });

  it("with one reel about the topic: ONE reel is planned, the card says 1 of 2, how many unrelated were left out, and how the preference was treated", () => {
    const r = compileIg([...STORED, SYNTHETIC_ABOUT]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.chosen).toEqual(["9100000000000000001"]);
    expect(r.plan.stages[0].planned_rows).toBe(1);
    const notes = r.plan.notes_ar!.join(" ");
    expect(notes).toContain("وجدنا في ما قرأناه ١ فقط تناسب طلبك من ٢");
    expect(notes).toContain("تركنا ٢ مما قرأناه لأن نصه لا يذكر الموضوع، ولا يدخل في السعر");
    expect(notes).toContain("«ريلز لو متاح»");
    expect(r.plan.summary_ar).toContain("«الذكاء الاصطناعي»");
    expect(r.plan.summary_ar).not.toContain("لو متاح");
    for (const line of [r.plan.summary_ar, ...(r.plan.notes_ar ?? [])]) expect(checkCustomerText(line).issues).toEqual([]);
  });

  it("the customer's explicit «go on with what was found» lets the stored reels be planned, each marked «لا يذكر الموضوع»", () => {
    const r = compileIg(STORED, true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.chosen).toHaveLength(2);
    for (const row of r.plan.stages[0].pinned_rows as Array<Record<string, unknown>>) expect(row.topic_relation).toBe("لا يذكر الموضوع");
  });
});

describe("Facebook: an unrelated search result is not a parent", () => {
  const card = cardOf("justoneapi.x.facebook-search-post-v1")!;
  const post = (id: string, message: string, comments: number) => ({ post_id: id, message, author: { name: "page", id: `a${id}`, url: `https://www.facebook.com/p${id}` }, timestamp: 1_793_000_000, url: `https://www.facebook.com/p/${id}`, comments_count: comments, reactions_count: 1, reshare_count: 0 });
  it("a synthetic unrelated post with MORE comments is left out; the stored about-the-topic post is chosen", () => {
    const ask = buildAsk(FB, null, AT);
    const page = { data: { results: [post("9200000000000001", "synthetic: عرض خاص على الأحذية الرياضية", 500), post("1168324279060979", FB_ABOUT, 107)], cursor: null } };
    const r = compilePlan({ ask, pool: { card, params: parentInputs(card, ask), pages: [{ callId: "call_0001", page }] }, exposure: () => ({ callId: null, page: null, failed: true }), capabilityOf, nowMs: AT });
    if (!r.ok) throw new Error(r.reason);
    expect(r.chosen).toEqual(["1168324279060979"]);
    expect(r.plan.stages[0].engine!.params).toEqual({ keyword: "الذكاء الاصطناعي" });
  });
});
