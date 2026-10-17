import { describe, it, expect } from "vitest";
import catalog from "./fixtures/treg-social-catalog.json";
import {
  SOCIAL_CAPABILITIES,
  canonicalSocialParams,
  estimateSocialChunkCostUsd,
  extractSocialRef,
  getSocialCapability,
  refFromUrl,
  resolveSocialMode,
  socialCapabilityForIntent,
  socialPlanSummaryAr,
  trendingNeedsRegion,
  validateSocialParams,
  youtubeVideoIdOf,
  SOCIAL_MAX_CALLS_PER_CHUNK,
  tiktokVideoIdOf,
  type SocialSource,
} from "../src/lib/socialSources";
import { detectSocialIntent } from "../src/lib/socialTasks";

type CatalogEntry = { method: string; params: string[]; required: string[]; costUsd: number | null; okRate: number | null; samples: number | null };
const live = catalog as Record<string, CatalogEntry>;

const allSources = (): Array<{ slug: string; where: string; source: SocialSource }> =>
  SOCIAL_CAPABILITIES.flatMap((cap) => [
    ...(cap.comments || []).map((source) => ({ slug: cap.slug, where: "comments", source })),
    ...Object.entries(cap.discover).flatMap(([mode, sources]) => (sources || []).map((source) => ({ slug: cap.slug, where: mode, source }))),
  ]);

/** Requests that give every source what it needs, so a build() that returns null is a real mismatch. */
const FULL_REQUEST = {
  ref: { id: "7231337071831321903", url: "https://www.tiktok.com/@u/video/7231337071831321903" },
  query: "قهوة",
  channel: "https://www.tiktok.com/@zachking",
  region: "EG",
  limit: 20,
};
const YT_REQUEST = { ...FULL_REQUEST, ref: { id: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, channel: "UCHnyfMqiRRG1u-2MsSQLbXA" };
const FB_REQUEST = { ...FULL_REQUEST, ref: { url: "https://www.facebook.com/nasa/posts/123456" }, channel: "https://www.facebook.com/nasa" };

function requestFor(platform: string) {
  return platform === "youtube" ? YT_REQUEST : platform === "facebook" ? FB_REQUEST : FULL_REQUEST;
}

describe("every source matches the provider catalog it was read from (fixture captured 2026-10-17)", () => {
  it("each endpoint id exists in the catalog fixture", () => {
    for (const { source } of allSources()) expect(live[source.endpointId], source.endpointId).toBeDefined();
  });

  it("the HTTP method of each source is the one the catalog declares", () => {
    for (const { source } of allSources()) expect(source.method, source.endpointId).toBe(live[source.endpointId].method);
  });

  it("a source only ever sends parameters the catalog declares for that endpoint, including every required one", () => {
    for (const { slug, where, source } of allSources()) {
      const platform = getSocialCapability(slug)!.platform;
      const built = source.build(requestFor(platform));
      expect(built, `${slug}/${where}/${source.endpointId} cannot serve a full request`).not.toBeNull();
      const declared = live[source.endpointId].params;
      for (const key of Object.keys(built!)) {
        // An endpoint whose catalog page declares no parameters (a feed with none) takes none.
        expect(declared, `${source.endpointId} was sent undeclared parameter "${key}"`).toContain(key);
      }
      for (const required of live[source.endpointId].required) {
        expect(Object.keys(built!), `${source.endpointId} is missing required "${required}"`).toContain(required);
      }
    }
  });

  // Known exception, stated rather than hidden: the YouTube trending feed has a single measured source (94.3% over 285
  // calls, slow at about 9 s) and one unmeasured fallback, so it is served with a fallback and the weakness is reported.
  const MEASURED_BELOW_97 = new Set(["scrapecreators.x.v1-youtube-shorts-trending"]);

  it("the first source of every task is one the catalog measured at 97% success or better where it measured at all", () => {
    for (const cap of SOCIAL_CAPABILITIES) {
      const firsts: SocialSource[] = [cap.comments?.[0], ...Object.values(cap.discover).map((sources) => sources?.[0])].filter(Boolean) as SocialSource[];
      for (const source of firsts) {
        const entry = live[source.endpointId];
        if (entry.okRate !== null && !MEASURED_BELOW_97.has(source.endpointId)) expect(entry.okRate, `${cap.slug}: ${source.endpointId}`).toBeGreaterThanOrEqual(0.97);
      }
    }
    for (const id of MEASURED_BELOW_97) expect(live[id].okRate).toBeLessThan(0.97);
  });

  it("a source's price in code is the catalog's price", () => {
    for (const { source } of allSources()) {
      const entry = live[source.endpointId];
      if (entry.costUsd) expect(source.costUsd, source.endpointId).toBeCloseTo(entry.costUsd, 5);
    }
  });
});

describe("source parameters for real requests", () => {
  const tiktokComments = getSocialCapability("social-tiktok-comments")!;
  const youtubeComments = getSocialCapability("social-youtube-comments")!;
  const facebookComments = getSocialCapability("social-facebook-comments")!;

  it("TikTok comments need the numeric video id; a short link falls through to the source that accepts a link", () => {
    const [tikhub, crawl] = tiktokComments.comments!;
    expect(tikhub.build({ ref: { id: "7231337071831321903" }, limit: 50 })).toEqual({ aweme_id: "7231337071831321903", count: 20 });
    expect(tikhub.build({ ref: { url: "https://vm.tiktok.com/ZMabc/" }, limit: 50 })).toBeNull();
    expect(crawl.build({ ref: { url: "https://vm.tiktok.com/ZMabc/" }, limit: 50 })).toEqual({ post: "https://vm.tiktok.com/ZMabc/", limit: 50 });
  });

  it("TikTok comment paging carries the numeric cursor", () => {
    expect(tiktokComments.comments![0].build({ ref: { id: "7231337071831321903" }, limit: 10, cursor: "20" })).toMatchObject({ cursor: 20 });
  });

  it("YouTube comments accept an id or any watch link and ask for what is left to collect", () => {
    const [crawl, tikhub] = youtubeComments.comments!;
    expect(crawl.build({ ref: { url: "https://youtu.be/dQw4w9WgXcQ" }, limit: 120 })).toEqual({ video: "dQw4w9WgXcQ", limit: 120 });
    expect(crawl.build({ ref: { id: "dQw4w9WgXcQ" }, limit: 9999 })).toEqual({ video: "dQw4w9WgXcQ", limit: 500 });
    expect(tikhub.build({ ref: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, limit: 20, cursor: "tok" })).toEqual({ video_id: "dQw4w9WgXcQ", continuation_token: "tok" });
  });

  it("Facebook comments take the post link and continue from the cursor", () => {
    const [primary] = facebookComments.comments!;
    expect(primary.build({ ref: { url: "https://www.facebook.com/nasa/posts/1" }, limit: 10, cursor: "c1" })).toEqual({ url: "https://www.facebook.com/nasa/posts/1", cursor: "c1" });
    expect(primary.build({ ref: {}, limit: 10 })).toBeNull();
  });

  it("TikTok search pages by offset and moves the offset by the rows it returned", () => {
    const [source] = getSocialCapability("social-tiktok-videos")!.discover.query!;
    expect(source.build({ query: "قهوة", limit: 20 })).toEqual({ keyword: "قهوة", count: 20, offset: 0 });
    expect(source.build({ query: "قهوة", limit: 20, cursor: "40" })).toEqual({ keyword: "قهوة", count: 20, offset: 40 });
    expect(source.nextCursor!(20, { query: "قهوة", limit: 20, cursor: "40" })).toBe("60");
    expect(source.nextCursor!(0, { query: "قهوة", limit: 20 })).toBeNull();
  });

  it("a TikTok channel is addressed by handle from a handle or a profile link", () => {
    const [primary, fallback] = getSocialCapability("social-tiktok-videos")!.discover.channel!;
    expect(primary.build({ channel: "@zachking", limit: 10 })).toEqual({ handle: "zachking" });
    expect(primary.build({ channel: "https://www.tiktok.com/@zachking", limit: 10 })).toEqual({ handle: "zachking" });
    expect(fallback.build({ channel: "@zachking", limit: 10 })).toEqual({ account: "@zachking", limit: 10 });
    expect(primary.build({ channel: "not a handle!", limit: 10 })).toBeNull();
  });

  it("the TikTok trending feed needs a two-letter country and has no region-less fallback", () => {
    const sources = getSocialCapability("social-tiktok-videos")!.discover.trending!;
    expect(sources).toHaveLength(1);
    expect(sources[0].build({ region: "eg", limit: 20 })).toEqual({ region: "EG" });
    expect(sources[0].build({ region: "مصر", limit: 20 })).toBeNull();
    expect(trendingNeedsRegion(getSocialCapability("social-tiktok-videos")!)).toBe(true);
    expect(trendingNeedsRegion(getSocialCapability("social-youtube-videos")!)).toBe(false);
  });

  it("a YouTube channel is read by the source that takes a handle, then by channel id", () => {
    const [primary, fallback] = getSocialCapability("social-youtube-videos")!.discover.channel!;
    expect(primary.build({ channel: "@veritasium", limit: 50 })).toEqual({ channel: "@veritasium", limit: 30 });
    expect(fallback.build({ channel: "@veritasium", limit: 50 })).toBeNull();
    expect(fallback.build({ channel: "UCHnyfMqiRRG1u-2MsSQLbXA", limit: 50 })).toEqual({ channel_id: "UCHnyfMqiRRG1u-2MsSQLbXA" });
  });
});

describe("links and discovered rows become the video or post they stand for", () => {
  it("video ids come from ids and from every link shape", () => {
    expect(youtubeVideoIdOf({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5" })).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoIdOf({ url: "https://youtu.be/dQw4w9WgXcQ" })).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoIdOf({ url: "https://www.youtube.com/shorts/dQw4w9WgXcQ" })).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoIdOf({ id: "dQw4w9WgXcQ" })).toBe("dQw4w9WgXcQ");
    expect(tiktokVideoIdOf({ url: "https://www.tiktok.com/@u/video/7231337071831321903?lang=en" })).toBe("7231337071831321903");
    expect(tiktokVideoIdOf({ id: "123" })).toBeUndefined();
  });

  it("a link the customer gave is the reference", () => {
    expect(refFromUrl("youtube", "https://youtu.be/dQw4w9WgXcQ")).toMatchObject({ id: "dQw4w9WgXcQ" });
    expect(refFromUrl("facebook", "https://www.facebook.com/nasa/posts/1")).toEqual({ url: "https://www.facebook.com/nasa/posts/1" });
    expect(refFromUrl("tiktok", "no link here")).toBeNull();
  });

  it("TikTok rows (aggregator and flattened shapes) give the video id and link", () => {
    expect(extractSocialRef("tiktok", { aweme_id: "7231337071831321903", desc: "قهوة", share_url: "https://www.tiktok.com/@u/video/7231337071831321903" })).toEqual({
      id: "7231337071831321903",
      url: "https://www.tiktok.com/@u/video/7231337071831321903",
      title: "قهوة",
    });
    expect(extractSocialRef("tiktok", { aweme_info_aweme_id: "7231337071831321903" })).toMatchObject({ id: "7231337071831321903" });
    expect(extractSocialRef("tiktok", { id: "7231337071831321903" })).toMatchObject({ id: "7231337071831321903" });
    expect(extractSocialRef("tiktok", { nickname: "no id" })).toBeNull();
  });

  it("YouTube rows give the id and a watch link even when only the id is present", () => {
    expect(extractSocialRef("youtube", { video_id: "dQw4w9WgXcQ", title: "عنوان" })).toEqual({ id: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "عنوان" });
    expect(extractSocialRef("youtube", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })).toMatchObject({ id: "dQw4w9WgXcQ" });
  });

  it("Facebook posts are addressed by their link only", () => {
    expect(extractSocialRef("facebook", { permalink_url: "https://www.facebook.com/nasa/posts/1", message: "نص" })).toEqual({ url: "https://www.facebook.com/nasa/posts/1", title: "نص" });
    expect(extractSocialRef("facebook", { message: "no link" })).toBeNull();
  });
});

describe("a plan item says exactly one thing to collect", () => {
  it("modes: a link beats a keyword, a keyword beats a channel", () => {
    expect(resolveSocialMode({ url: "https://youtu.be/x", query: "a" })).toBe("url");
    expect(resolveSocialMode({ query: "a", channel: "b" })).toBe("query");
    expect(resolveSocialMode({ channel: "@b" })).toBe("channel");
    expect(resolveSocialMode({ trending: true })).toBe("trending");
    expect(resolveSocialMode({})).toBeNull();
  });

  it("an empty request or one the platform cannot serve is refused in Arabic", () => {
    expect(validateSocialParams("social-tiktok-comments", {})).toMatch(/رابط|كلمة|قناة/);
    expect(validateSocialParams("social-facebook-comments", { query: "x" })).toMatch(/غير متاح/);
    expect(validateSocialParams("social-tiktok-videos", { trending: true })).toMatch(/الدولة/);
    expect(validateSocialParams("social-tiktok-videos", { trending: true, region: "EG" })).toBeNull();
    expect(validateSocialParams("social-youtube-videos", { trending: true })).toBeNull();
    expect(validateSocialParams("not-social", {})).toBeNull();
  });

  it("the capability for a request is chosen from its platform, task and shape", () => {
    expect(socialCapabilityForIntent(detectSocialIntent("هات كومنتات https://youtu.be/dQw4w9WgXcQ"))?.slug).toBe("social-youtube-comments");
    expect(socialCapabilityForIntent(detectSocialIntent("فيديوهات ترند في مصر على تيك توك"))?.slug).toBe("social-tiktok-videos");
    expect(socialCapabilityForIntent(detectSocialIntent("كومنتات فيديوهات ترند في مصر على تيك توك"))?.slug).toBe("social-tiktok-comments");
    expect(socialCapabilityForIntent(detectSocialIntent("ترند فيسبوك"))).toBeUndefined();
    expect(socialCapabilityForIntent(detectSocialIntent("عايز شركات مقاولات"))).toBeUndefined();
  });

  it("parameters are rebuilt from the customer's words: link, channel, subject and country; model text is never trusted", () => {
    const comments = getSocialCapability("social-youtube-comments")!;
    const byLink = detectSocialIntent("هات كومنتات https://youtu.be/dQw4w9WgXcQ");
    expect(canonicalSocialParams(comments, byLink, "هات كومنتات https://youtu.be/dQw4w9WgXcQ", { query: "garbage", channel: "x" })).toEqual({ url: "https://youtu.be/dQw4w9WgXcQ" });

    const bySubject = detectSocialIntent("عايز ١٠٠ كومنت من فيديوهات عن القهوة على يوتيوب");
    expect(canonicalSocialParams(comments, bySubject, "عايز ١٠٠ كومنت من فيديوهات عن القهوة على يوتيوب", { query: "the whole sentence" })).toEqual({ query: "القهوة" });

    const tiktok = getSocialCapability("social-tiktok-videos")!;
    const trending = detectSocialIntent("عايز ٢٠ فيديو ترند في السعودية على تيك توك");
    expect(canonicalSocialParams(tiktok, trending, "عايز ٢٠ فيديو ترند في السعودية على تيك توك", {})).toEqual({ trending: true, region: "SA" });

    const channel = detectSocialIntent("فيديوهات قناة @zachking على تيك توك");
    expect(canonicalSocialParams(tiktok, channel, "فيديوهات قناة @zachking على تيك توك", {})).toEqual({ channel: "@zachking" });
  });

  it("only a period the customer asked for filters results, and only comments get a per-video amount", () => {
    const comments = getSocialCapability("social-tiktok-comments")!;
    const intent = detectSocialIntent("كومنتات فيديوهات ترند في مصر على تيك توك");
    expect(canonicalSocialParams(comments, intent, "x", {}, {})).not.toHaveProperty("dateFrom");
    expect(canonicalSocialParams(comments, intent, "x", { dateFrom: "2026-10-14", dateTo: "2026-10-17" }, {})).not.toHaveProperty("dateFrom");
    expect(canonicalSocialParams(comments, intent, "x", {}, { dateFrom: "2026-09-01", dateTo: "2026-09-30", perVideo: 20, videoCount: 5 })).toMatchObject({ dateFrom: "2026-09-01", perVideo: 20, videoCount: 5 });
    const videos = getSocialCapability("social-tiktok-videos")!;
    expect(canonicalSocialParams(videos, detectSocialIntent("فيديوهات ترند في مصر على تيك توك"), "x", {}, { perVideo: 20 })).not.toHaveProperty("perVideo");
  });

  it("the goal line on the plan card is Arabic, names what will be collected, and never a service", () => {
    const fmt = (n: number) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);
    const lines = [
      socialPlanSummaryAr(getSocialCapability("social-youtube-comments")!, { url: "https://youtu.be/dQw4w9WgXcQ" }, 20, fmt),
      socialPlanSummaryAr(getSocialCapability("social-youtube-comments")!, { query: "القهوة" }, 100, fmt),
      socialPlanSummaryAr(getSocialCapability("social-tiktok-comments")!, { trending: true, region: "EG" }, 30, fmt),
      socialPlanSummaryAr(getSocialCapability("social-tiktok-videos")!, { channel: "@zachking" }, 10, fmt),
      socialPlanSummaryAr(getSocialCapability("social-facebook-posts")!, { channel: "nasa" }, 10, fmt),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/[A-Za-z]/);
      expect(line).not.toMatch(/tikhub|crawl4ai|scrapecreators|anyapi|treg/i);
    }
    expect(lines[1]).toContain("«القهوة»");
    expect(lines[1]).toContain("٥٠");
    expect(lines[2]).toContain("الفيديوهات الرائجة");
  });
});

describe("one chunk's provider spend estimate covers its worst case", () => {
  it("is the dearest source times the most calls a chunk may make", () => {
    for (const cap of SOCIAL_CAPABILITIES) {
      const prices = [...(cap.comments || []), ...Object.values(cap.discover).flatMap((s) => s || [])].map((s) => s.costUsd);
      expect(estimateSocialChunkCostUsd(cap)).toBeCloseTo(Math.max(...prices) * SOCIAL_MAX_CALLS_PER_CHUNK, 6);
      expect(estimateSocialChunkCostUsd(cap)).toBeLessThan(0.05);
    }
  });
});

describe("the public calculator and the quote writer price a social service identically", async () => {
  const { computePublicCalculatorQuote, getPublicCalculatorOptions } = await import("../src/lib/calculatorPricing");
  const { APPROVED_CAPABILITY_CATALOG } = await import("../src/functions/shared/capabilityRegistry");
  const { calculateCapabilityUnitPricePoints, DEFAULT_PRICING_SETTINGS } = await import("../src/functions/shared/quotes");

  for (const cap of SOCIAL_CAPABILITIES) {
    it(`${cap.slug}: calculator unit price equals the quote writer's (customer rate when set, else cost basis)`, () => {
      const seed = APPROVED_CAPABILITY_CATALOG.find((c) => c.slug === cap.slug)!;
      const basis = seed.customerPriceUsdPerItem && seed.customerPriceUsdPerItem > 0 ? seed.customerPriceUsdPerItem : seed.unitCostUsd;
      const expected = calculateCapabilityUnitPricePoints(basis, DEFAULT_PRICING_SETTINGS);
      expect(computePublicCalculatorQuote(cap.slug, 10).unitPricePoints).toBe(expected);
    });
  }

  it("the owner's comment rates still apply: 9 points a YouTube comment, 11 a Facebook comment", () => {
    expect(computePublicCalculatorQuote("social-youtube-comments", 10).unitPricePoints).toBe(9);
    expect(computePublicCalculatorQuote("social-facebook-comments", 10).unitPricePoints).toBe(11);
  });

  it("the calculator lists the social services with Arabic names only", () => {
    const options = getPublicCalculatorOptions().filter((o) => o.slug.startsWith("social-"));
    expect(options).toHaveLength(SOCIAL_CAPABILITIES.length);
    for (const option of options) {
      expect(option.nameAr).not.toMatch(/[A-Za-z]/);
      expect(option.descriptionAr).not.toMatch(/[A-Za-z]/);
    }
  });
});
