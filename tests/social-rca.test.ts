import { describe, it, expect } from "vitest";
import { detectSocialIntent } from "../src/lib/socialTasks";
import { understandMission, understoodLineAr } from "../src/lib/consultantCopy";
import { canonicalSocialParams, socialCapabilityForIntent } from "../src/lib/socialSources";
import { isTopicSearchRequest } from "../src/lib/server/researchRelevanceGate";
import { dedupeRows, normalizedPostText, postDedupeIdentity, socialDedupeIdentity } from "../src/lib/server/rowDedupe";
import { summarizeActivityCounts, RECEIVED_SO_FAR_LABEL } from "../src/lib/activityCounts";
import { runSocialChunk, type SocialCall, type SocialCallOutcome } from "../src/lib/server/socialAdapter";
import type { ProviderAdapterCallInput } from "../src/lib/server/tregAdapter";

const paramsFor = (text: string, hints: Parameters<typeof canonicalSocialParams>[4] = {}) => {
  const intent = detectSocialIntent(text);
  const cap = socialCapabilityForIntent(intent);
  return { intent, cap, params: cap ? canonicalSocialParams(cap, intent, text, {}, hints) : null };
};

describe("TikTok «most viral videos about a topic»: the topic is kept (the trending feed has no topic filter)", () => {
  const OWNER = "٥٠٠ تعليق من فيديوهات تيك توك الأكثر انتشارًا عن كرة السلة في مصر";

  it("the owner's sentence is a topic search for basketball in Egypt, not the region's trending feed", () => {
    const { intent, cap, params } = paramsFor(OWNER);
    expect(cap?.slug).toBe("social-tiktok-comments");
    expect(intent.discover).toBe("keyword");
    expect(params).toEqual({ region: "EG", query: "كرة السلة" });
    // so the videos are judged at video level and the reviewers are told the topic
    expect(isTopicSearchRequest(params!)).toBe(true);
  });

  it("«الأكثر مشاهدة» and «ترند» with a topic behave the same way", () => {
    expect(paramsFor("٥٠٠ تعليق من فيديوهات تيك توك الأكثر مشاهدة عن كرة السلة في مصر").params).toEqual({ region: "EG", query: "كرة السلة" });
    expect(paramsFor("ترند كرة السلة على تيك توك في مصر").params).toEqual({ region: "EG", query: "كرة السلة" });
  });

  it("trend words with no topic still ask for the trending feed", () => {
    expect(paramsFor("٥٠٠ تعليق من الفيديوهات الرائجة على تيك توك في مصر").params).toEqual({ region: "EG", trending: true });
    expect(paramsFor("الفيديوهات الرائجة على تيك توك في مصر").params).toEqual({ region: "EG", trending: true });
  });

  it("an X request for a trend is a keyword search of tweets about it", () => {
    const { cap, params } = paramsFor("٣٠٠ تغريدة عن ترند كأس العالم على إكس");
    expect(cap?.slug).toBe("social-x-posts");
    expect(params).toEqual({ query: "كأس العالم" });
  });

  it("«أحدث» is a request word, never part of the search text", () => {
    expect(paramsFor("٣٠٠ تعليق عن أحدث فيديوهات الأهلي على يوتيوب").params).toEqual({ query: "الأهلي" });
  });
});

describe("TikTok account videos then their comments: the answer is not glued to the sentence", () => {
  const TEXT = "عايز فيديوهات لحساب معين ثم تعليقاتها منصة البحث المطلوبة: تيك توك اسم الحساب المطلوب: @yallakora (يلا كورة)";

  it("the understanding names the account and no invented topic", () => {
    const u = understandMission(TEXT);
    expect(u.kind).toBe("social_channel_topic");
    expect(u.channels.named).toEqual(["@yallakora"]);
    expect(u.subject).toBeNull();
    const line = understoodLineAr(u)!;
    expect(line).toContain("قناة @yallakora");
    expect(line).not.toContain("لحساب معين");
    expect(line).not.toContain("عن «");
  });

  it("the plan carries the channel and no topic filter", () => {
    const u = understandMission(TEXT);
    const { params } = paramsFor(TEXT, { channels: u.channels.named, topic: u.subject ?? undefined });
    expect(params).toEqual({ channels: ["@yallakora"] });
  });

  it("a topic the customer really gave after «عن» is kept, without the handle", () => {
    const u = understandMission("عايز فيديوهات حساب @yallakora عن كأس العالم ثم تعليقاتها على تيك توك");
    expect(u.subject).toBe("كأس العالم");
  });

  it("why it failed: a topic of leftover words keeps no video, no topic keeps them all", async () => {
    const titles = ["ملخص مباراة الأهلي والزمالك", "أهداف الدوري المصري", "حوار مع لاعب"];
    const videos = titles.map((title, i) => ({ aweme_id: `72313370718313219${i}0`, desc: title, share_url: `https://www.tiktok.com/@yallakora/video/72313370718313219${i}0` }));
    const call: SocialCall = async (source, params): Promise<SocialCallOutcome> => {
      if (params.handle || params.account) return { ok: true, httpStatus: 200, data: { aweme_list: videos }, costMicro: 1000, tregCallId: "d" };
      return { ok: true, httpStatus: 200, data: { data: { comments: [{ cid: `${params.aweme_id}_1`, text: "تعليق حقيقي", user: { nickname: "منى" } }], cursor: 1, has_more: 0 } }, costMicro: 1000, tregCallId: "c" };
    };
    const run = (params: Record<string, any>) => runSocialChunk({
      jobId: "j", userId: "u", step: 0, endpointId: "x", capabilitySlug: "social-tiktok-comments", method: "POST", params,
      paginationStrategy: "cursor", cursor: null, pageSize: 50, remainingNeeded: 3, targetVolumeMax: 3, deliveredSoFar: 0,
    } as ProviderAdapterCallInput, { call });
    const withLeftovers = await run({ channels: ["@yallakora"], topic: "لحساب معين ثم تعليقاتها اسم @yallakora يلا كورة" });
    expect(withLeftovers.rows).toHaveLength(0);
    const withoutTopic = await run({ channels: ["@yallakora"] });
    expect(withoutTopic.rows.length).toBeGreaterThan(0);
  });
});

describe("X posts: the same text under different ids and links is one post", () => {
  const tweet = (id: string, text: string, extra: Record<string, any> = {}) => ({ tweet_id: id, text, url: `https://x.com/u/status/${id}`, ...extra });

  it("normalises links, marks, spacing and Arabic letter variants", () => {
    const a = normalizedPostText("اللهم صلِّ على محمد!! https://t.co/abc123");
    const b = normalizedPostText("اللّهم  صل على محمّد https://t.co/zzz999 😊");
    expect(a).toBe(b);
    expect(normalizedPostText("كأس العالم ٢٠٢٦")).not.toBe(normalizedPostText("كأس العالم ٢٠٢٧"));
  });

  it("identical text with other ids and urls has one identity; different text does not", () => {
    const text = "منتخب مصر يفوز على المغرب في كأس العالم";
    expect(postDedupeIdentity(tweet("1", text))).toBe(postDedupeIdentity(tweet("2", `${text} https://t.co/x`, { url: "https://x.com/other/status/2" })));
    expect(postDedupeIdentity(tweet("1", text))).not.toBe(postDedupeIdentity(tweet("3", `${text} مرة أخرى`)));
  });

  it("a post with too little text keeps the source's own id", () => {
    expect(postDedupeIdentity(tweet("7", "تمام"))).toBe("id:7");
    expect(postDedupeIdentity(tweet("8", "تمام"))).toBe("id:8");
  });

  it("the old identity is unchanged for comments and other rows", () => {
    expect(socialDedupeIdentity(tweet("9", "منتخب مصر يفوز على المغرب في كأس العالم"))).toBe("id:9");
  });

  it("dedupeRows keeps the first occurrence across pages", () => {
    const text = "الأهلي بطل الدوري المصري هذا الموسم";
    const seen = new Set<string>();
    const first = dedupeRows([tweet("1", text), tweet("2", "منشور مختلف تماما عن الموضوع")], postDedupeIdentity, seen);
    const second = dedupeRows([tweet("3", text), tweet("4", "منشور ثالث مختلف عن الاثنين")], postDedupeIdentity, seen);
    expect(first.duplicates).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(second.rows.map((row) => row.tweet_id)).toEqual(["4"]);
  });
});

describe("activity panel counters", () => {
  const ev = (textAr: string) => ({ textAr });

  it("the newest running total wins when the panel holds only the last few events of a long job", () => {
    const lines = [
      ev(`الصفحة ٢٣: استلمنا ٥٠ سجل · ${RECEIVED_SO_FAR_LABEL} ١١٥٠ · الجديد ٤٠ · الإجمالي ٢٠٠`),
      ev(`الصفحة ٢٤: استلمنا ٤٥ سجل · ${RECEIVED_SO_FAR_LABEL} ١١٩٥ · الجديد ١٤ · الإجمالي ٢١٤`),
    ];
    expect(summarizeActivityCounts(lines).received).toBe(1195);
  });

  it("a job from before the total was written is summed as it always was", () => {
    expect(summarizeActivityCounts([ev("الصفحة ١: استلمنا ٥٠ سجل · الجديد ٤٠"), ev("الصفحة ٢: استلمنا ٣٠ سجل · الجديد ٢٠")]).received).toBe(80);
  });

  it("nothing received yet is a dash, not a zero", () => {
    expect(summarizeActivityCounts([ev("تم قبول الطلب")]).received).toBeNull();
  });
});
