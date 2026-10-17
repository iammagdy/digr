import { describe, it, expect } from "vitest";
import {
  detectSocialIntent,
  extractUrls,
  getMissingSocialTaskInputs,
  hasSocialSubject,
  socialCatalogQuery,
  socialTaskQuestion,
} from "../src/lib/socialTasks";
import { getDeterministicDiscoveryQuestion } from "../src/functions/shared/chatHandler";
import { normalizeClarificationQuestions } from "../src/functions/shared/clarification";
import { mapSearchQueryToEnglish } from "../src/functions/shared/catalogClient";

const brief: any = { platforms: [], topics: [] };

describe("what a researcher wants is understood in Egyptian and standard Arabic", () => {
  const cases: Array<[string, string | null, string | null, string | null]> = [
    // text, platform, task, discover
    ["عايز كومنتس بوست على فيسبوك", "facebook", "comments", "keyword"],
    ["هات كومنتات فيديو يوتيوب", "youtube", "comments", "keyword"],
    ["كومنتس فيديو تيك توك", "tiktok", "comments", "keyword"],
    ["اسحب لي ٥٠٠ تعليق من فيديو على اليوتوب", "youtube", "comments", "keyword"],
    ["الفيديوهات الستراندنج على تيك توك", "tiktok", "trending", "trending"],
    ["فيديوهات ترند على تيك توك", "tiktok", "trending", "trending"],
    ["هات الشورتس الرائجة على يوتيوب", "youtube", "trending", "trending"],
    ["فيديوهات قناة على تيك توك", "tiktok", "channel_videos", "channel"],
    ["فيديوهات قناة @zachking على تيك توك", "tiktok", "channel_videos", "channel"],
    ["بوستات صفحة نيك على الفيس", "facebook", "page_posts", "keyword"],
    ["فيديوهات عن القهوة على تيك توك", "tiktok", "video_search", "keyword"],
    ["عايز شركات مقاولات في مصر", null, null, null],
  ];
  for (const [text, platform, task, discover] of cases) {
    it(`${text}`, () => {
      const intent = detectSocialIntent(text);
      expect(intent.platform).toBe(platform);
      expect(intent.task).toBe(task);
      expect(intent.discover).toBe(discover);
    });
  }

  it("trending videos together with their comments is one request with two stages", () => {
    const intent = detectSocialIntent("فيديوهات ترند في مصر على تيك توك مع الكومنتس بتاعتها");
    expect(intent.task).toBe("comments");
    expect(intent.discover).toBe("trending");
    expect(intent.videosWithComments).toBe(true);
  });

  it("a link names the platform and the target by itself", () => {
    const urls = extractUrls("هات كومنتات https://www.youtube.com/watch?v=dQw4w9WgXcQ و https://www.tiktok.com/@zachking/video/7231337071831321903 و https://www.facebook.com/nasa/posts/123456");
    expect(urls.map((u) => [u.platform, u.kind, u.id])).toEqual([
      ["youtube", "video", "dQw4w9WgXcQ"],
      ["tiktok", "video", "7231337071831321903"],
      ["facebook", "post", undefined],
    ]);
    const intent = detectSocialIntent("كومنتات https://youtu.be/dQw4w9WgXcQ");
    expect(intent.platform).toBe("youtube");
    expect(intent.discover).toBe("target");
    expect(intent.targetUrl?.id).toBe("dQw4w9WgXcQ");
  });

  it("the catalog is searched for the task, in English, not for the platform alone", () => {
    expect(socialCatalogQuery(detectSocialIntent("كومنتس فيديو تيك توك"))).toBe("tiktok video comments");
    expect(socialCatalogQuery(detectSocialIntent("هات كومنتات فيديو يوتيوب"))).toBe("youtube video comments");
    expect(socialCatalogQuery(detectSocialIntent("عايز كومنتس بوست على فيسبوك"))).toBe("facebook post comments");
    expect(mapSearchQueryToEnglish("عايز كومنتس بوست على فيسبوك", "facebook")).toBe("facebook post comments");
    expect(mapSearchQueryToEnglish("كومنتس فيديو تيك توك", "tiktok")).toBe("tiktok video comments");
    expect(mapSearchQueryToEnglish("الفيديوهات الستراندنج على تيك توك", "tiktok")).toBe("tiktok trending feed");
  });
});

describe("only the missing input is asked, one question at a time, with tappable options where it is a choice", () => {
  it("comments with no link or subject ask for the link", () => {
    for (const text of ["عايز كومنتس بوست على فيسبوك", "هات كومنتات فيديو يوتيوب", "كومنتس فيديو تيك توك"]) {
      expect(getMissingSocialTaskInputs(text), text).toEqual(["social_comment_target_required"]);
      expect(getDeterministicDiscoveryQuestion(text, brief)?.id, text).toBe("social_comment_target_required");
    }
  });

  it("comments with a link ask nothing more", () => {
    expect(getMissingSocialTaskInputs("كومنتات https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual([]);
    expect(getMissingSocialTaskInputs("عايز كومنتس بوست https://www.facebook.com/nasa/posts/123456 على فيسبوك")).toEqual([]);
  });

  it("comments with a subject (no link) are served by searching videos about it", () => {
    expect(getMissingSocialTaskInputs("هات كومنتات فيديوهات عن القهوة على تيك توك")).toEqual([]);
  });

  it("trending asks the country, with options, and never assumes one", () => {
    const q = getDeterministicDiscoveryQuestion("الفيديوهات الستراندنج على تيك توك", brief);
    expect(q?.id).toBe("social_trending_region_required");
    expect(q?.type).toBe("single");
    expect(q?.options).toEqual(["مصر", "السعودية", "الإمارات", "أخرى"]);
    expect(getMissingSocialTaskInputs("فيديوهات ترند في مصر على تيك توك")).toEqual([]);
  });

  it("does not refuse or suggest a different platform for a trending request", () => {
    const q = getDeterministicDiscoveryQuestion("ترند فيسبوك", brief);
    expect(q?.id).toBe("social_topic_required");
    expect(q?.text).toContain("ما الموضوع");
  });

  it("a channel request without a channel asks for it", () => {
    expect(getDeterministicDiscoveryQuestion("فيديوهات قناة على تيك توك", brief)?.id).toBe("social_channel_required");
    expect(getMissingSocialTaskInputs("فيديوهات قناة @zachking على تيك توك")).toEqual([]);
  });

  it("customer questions are Arabic only", () => {
    for (const id of ["social_comment_target_required", "social_trending_region_required", "social_trending_platform_required", "social_channel_required"] as const) {
      const q = socialTaskQuestion(id);
      expect(q.text).not.toMatch(/[A-Za-z]/);
      expect(q.options.join(" ")).not.toMatch(/[A-Za-z]/);
    }
  });

  it("task words, platform names and quantities are not a subject, a named thing is", () => {
    expect(hasSocialSubject("عايز كومنتس بوست على فيسبوك")).toBe(false);
    expect(hasSocialSubject("هات ١٠٠ كومنت من فيديو")).toBe(false);
    expect(hasSocialSubject("كومنتات فيديوهات عن القهوة")).toBe(true);
    expect(hasSocialSubject("كومنتات #ريفيو_موبايل")).toBe(true);
  });
});

describe("questions keep their own choices (a topic word in the text must not change what is offered)", () => {
  const caps: any[] = [
    { category: "tiktok", enabled: true, nameAr: "ملف", slug: "tiktok-profile" },
    { category: "youtube", enabled: true, nameAr: "تعليقات", slug: "social-youtube-comments" },
  ];
  const normalize = (q: any) => normalizeClarificationQuestions({ questions: [q] } as any, { capabilities: caps, userBalancePoints: 5000 })[0];

  it("the link question is free text with no chips, and the country question offers countries, not record counts", () => {
    const link = normalize(socialTaskQuestion("social_comment_target_required"));
    expect(link.type).toBe("free");
    expect(link.options).toEqual([]);
    const region = normalize(socialTaskQuestion("social_trending_region_required"));
    expect(region.options).toEqual(["مصر", "السعودية", "الإمارات", "أخرى"]);
    expect(region.defaultOption).toBeUndefined();
  });

  it("a platform clarification is one short free-text question", () => {
    const q = normalize(socialTaskQuestion("social_trending_platform_required"));
    expect(q.type).toBe("free");
    expect(q.options).toEqual([]);
    expect(q.defaultOption).toBeUndefined();
  });

  it("an account-name question is free text: it no longer shows platform chips", () => {
    const q = normalize({ id: "social_account_required", text: "ما اسم الحساب أو رابطه على المنصة؟", type: "free", options: [], allowOther: true });
    expect(q).toBeDefined();
    expect(q.options).toEqual([]);
  });

  it("a platform question from the model is still limited to enabled services", () => {
    const q = normalize({ id: "q1", text: "على أي منصة تريد البحث؟", type: "single", options: ["فيسبوك", "تيك توك"], allowOther: true });
    expect(q.options).toEqual(["تيك توك", "يوتيوب"]);
  });
});
