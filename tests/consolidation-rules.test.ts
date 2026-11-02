import { describe, expect, it } from "vitest";
import { loadTregCatalog, type CatalogEndpoint } from "../src/lib/treg/catalog";
import { isPeopleStage } from "../src/lib/agentMission/people";
import { isCompanyStage } from "../src/lib/agentMission/entities";
import { replySourcesFor, buildReplyMapCode, replyColumnKeysOf } from "../src/lib/agentMission/replies";
import { toolProfile } from "../src/lib/agentMission/toolProfile";
import { buildToolInput } from "../src/lib/agentMission/toolInput";
import { topicDiscussionClass, topicMeaningFromModel, topicMeaningOf, topicQueryOf } from "../src/lib/agentMission/topicMeaning";
import { formatSampleValueAr } from "../src/lib/customerDates";
import { childCountOf } from "../src/lib/agentMission/childCount";
import { completeCountEstimate, splitPromise } from "../src/lib/agentMission/completeCount";
import { SOCIAL_PLATFORMS, capabilitiesOf, REQUEST_TYPES } from "./helpers/ruleMatrix";

/**
 * THE CONSOLIDATION (docs/S1-LIVE-FINDINGS.md, «Consolidation»): the nine rules the live tests taught, applied to EVERY social request type (search posts, account posts, comments, replies) on EVERY platform (TikTok, Instagram, Facebook, YouTube, X), not only where the bug was seen.
 * The platforms and their tools are the catalog's own (198 social endpoints): each test below runs the real code over the catalog's tools of that platform and request type, so a platform with no tool for a type says so from the catalog, and a rule that holds only for the first platform it was fixed on fails here.
 */
const catalog = loadTregCatalog();
const allow = () => true;

// ---------------------------------------------------------------------------------------------------- rule 9
describe("rule 9: a stage's type comes from its structure (the catalog capability of its tool), never from the words of its title", () => {
  // the titles that changed a stage's type in live tests or could: «main» (the S11 bug: «الرئيسية» starts with the stem of «رئيس» = chief), people, managers, companies
  const TRAPS = ["التعليقات الرئيسية", "الردود الرئيسية", "المنشورات الرئيسية", "رئيس كل شركة", "مديرو الشركات", "موظفو الصفحة", "صناع القرار", "شركات الإعلام", "الأشخاص المعلقون", "مسؤولو الحساب"];
  for (const platform of SOCIAL_PLATFORMS) {
    for (const type of REQUEST_TYPES) {
      const tools = capabilitiesOf(catalog, platform, type);
      if (tools.length === 0) continue;
      it(`${platform} / ${type}: the capability ${tools[0].capability} is not a people stage and not a company stage under any trap title`, () => {
        for (const title of TRAPS) {
          const stage = { parent_key: "p", title_ar: title, capability: tools[0].capability };
          expect(isPeopleStage(stage), `${tools[0].capability}: ${title}`).toBe(false);
          expect(isCompanyStage({ title_ar: title, capability: tools[0].capability }), `${tools[0].capability}: ${title}`).toBe(false);
        }
      });
    }
  }
  it("a stage on a people capability is a people stage whatever its title says; a stage with no stored capability keeps the title rule (old plans)", () => {
    expect(isPeopleStage({ parent_key: "p", title_ar: "زملاء", capability: "companies.employees" })).toBe(true);
    expect(isPeopleStage({ parent_key: "p", title_ar: "مديرو الشركات" })).toBe(true);
    expect(isPeopleStage({ parent_key: "p", title_ar: "التعليقات الرئيسية" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------- rule 6
describe("rule 6: the replies tool of the platform's catalog is used when one exists, fed by what the comment's row gives", () => {
  const COMMENTS: Record<string, string> = { tiktok: "tikhub.tiktok.video.comments", instagram: "anyapi.instagram.post.comments", facebook: "scrapecreators.x.v1-facebook-post-comments", youtube: "scrapecreators.youtube.video.comments" };
  for (const [platform, commentsTool] of Object.entries(COMMENTS)) {
    it(`${platform}: a replies source is found for ${commentsTool}`, () => {
      expect(catalog.byId.get(commentsTool)?.platform, commentsTool).toBe(platform);
      const sources = replySourcesFor(commentsTool, catalog, { isAllowed: allow, videoIdAvailable: true, urlAvailable: true });
      expect(sources.length, `no replies source for ${platform}`).toBeGreaterThan(0);
    });
  }
  it("facebook: the replies tool takes the comment's feedback_id and expansion_token, and the comments mapping carries both from the page (the catalog's comment items have both fields)", () => {
    const comments = catalog.byId.get("scrapecreators.x.v1-facebook-post-comments")!;
    expect(Object.keys(comments.item_fields ?? {})).toEqual(expect.arrayContaining(["feedback_id", "expansion_token"]));
    const source = replySourcesFor("scrapecreators.x.v1-facebook-post-comments", catalog, { isAllowed: allow, videoIdAvailable: true, urlAvailable: true }).find((s) => s.id === "scrapecreators.x.v1-facebook-post-comment-replies")!;
    expect(source).toBeDefined();
    expect(source.rowTokens.map((t) => t.param).sort()).toEqual(["expansion_token", "feedback_id"]);
    const code = buildReplyMapCode(replyColumnKeysOf([{ key: "text" }, { key: "replies_count" }]), source.rowTokens);
    const run = (page: unknown) => new Function("inputs", code)({ page }) as Array<Record<string, unknown>>;
    const rows = run({ comments: [{ id: "c1", text: "نص", created_at: "2026-10-01T10:00:00.000Z", reply_count: 2, feedback_id: "fb1", expansion_token: "ex1", author: { name: "س" } }] });
    expect(rows[0]).toMatchObject({ id: "c1", replies_count: 2, feedback_id: "fb1", expansion_token: "ex1" });
  });
  it("youtube: the ranked replies tools take the comment's id (no token needed); the tools that take the comment's own reply token are read as row tokens, and the mapping reads the nested counters (engagement.replies, engagement.likes) and publishedTime", () => {
    const sources = replySourcesFor("scrapecreators.youtube.video.comments", catalog, { isAllowed: allow, videoIdAvailable: true, urlAvailable: true });
    expect(sources.every((s) => s.id.includes("youtube"))).toBe(true);
    const tokens = [{ param: "continuationToken", key: "replies_token" }];
    const code = buildReplyMapCode(replyColumnKeysOf([{ key: "text" }, { key: "likes" }, { key: "posted_at" }, { key: "replies_count" }]), tokens);
    const run = (page: unknown) => new Function("inputs", code)({ page }) as Array<Record<string, unknown>>;
    const rows = run({ comments: [{ id: "y1", content: "رائع", publishedTime: "2025-07-28T11:54:31.516Z", author: { name: "@قناة" }, engagement: { likes: 7, replies: 3 }, repliesContinuationToken: "tok1" }, { id: "y2", content: "بدون ردود", publishedTime: "2025-07-28T11:55:31.516Z", engagement: { likes: 1, replies: 0 } }] });
    expect(rows[0]).toMatchObject({ id: "y1", text: "رائع", likes: 7, replies_count: 3, replies_token: "tok1", posted_at: "2025-07-28T11:54:31.516Z" });
    expect(rows[1]).toMatchObject({ id: "y2", replies_count: 0 });
  });
  it("x: the catalog has no comment-replies capability; replies to a post ARE its comments (x.post.comments), so a tweet's replies need no second stage (catalog evidence)", () => {
    expect(catalog.endpoints.some((e) => e.platform === "x" && /comment\.replies$/.test(e.capability ?? ""))).toBe(false);
    expect(catalog.endpoints.some((e) => e.platform === "x" && e.capability === "x.post.comments" && e.kind === "direct")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------- rule 5
describe("rule 5: a date field is written with the customer's Cairo days, and an input that only looks like a date is not one", () => {
  const profileOf = (id: string) => toolProfile(catalog.byId.get(id) as CatalogEndpoint);
  it("a pagination cursor named «after» / «before» (Instagram's posts of an account) is not a date input", () => {
    for (const id of ["tikhub.x.instagram-v3-get-user-posts", "tikhub.x.instagram-v3-get-user-reels", "tikhub.x.instagram-v3-get-location-posts", "tikhub.x.instagram-v3-get-recommended-reels"]) {
      const p = profileOf(id);
      expect(p.date?.from ?? null, `${id} from`).toBeNull();
      expect(p.date?.to ?? null, `${id} to`).toBeNull();
    }
  });
  it("an Instagram account listing with a period says «no date field» (a gap the card states) and writes no date", () => {
    const e = catalog.byId.get("tikhub.x.instagram-v3-get-user-posts")!;
    const r = buildToolInput(e, { period: { from: "2026-10-01", to: "2026-10-31" }, nowMs: Date.parse("2026-11-02T13:00:00Z") }, { username: "alhadath" });
    expect(r.gaps).toContainEqual({ cls: "date", reason: "no_field" });
    expect(r.params).toEqual({ username: "alhadath" });
  });
  it("facebook search posts (day format): the Cairo days that COVER the range; youtube (RFC 3339 from): the Cairo first moment in UTC; x official: both ends in UTC", () => {
    const now = Date.parse("2026-11-02T13:00:00Z");
    const fb = buildToolInput(catalog.byId.get("justoneapi.x.facebook-search-post-v1")!, { period: { from: "2026-10-01", to: "2026-10-31" }, nowMs: now }, { keyword: "x" });
    expect(fb.params).toMatchObject({ startDate: "2026-09-30", endDate: "2026-10-31" });
    const yt = buildToolInput(catalog.byId.get("youtube.youtube.search.videos")!, { period: { from: "2026-10-01", to: "2026-10-31" }, nowMs: now }, { part: "snippet", q: "x" });
    expect(String(yt.params.publishedAfter)).toBe("2026-09-30T21:00:00Z");
    const x = buildToolInput(catalog.byId.get("x.x.search-posts-all")!, { period: { from: "2026-10-01", to: "2026-10-31" }, nowMs: now }, { query: "x" });
    expect(x.params).toMatchObject({ start_time: "2026-09-30T21:00:00Z", end_time: "2026-10-31T21:59:59Z" });
  });
});

// ---------------------------------------------------------------------------------------------------- rule 4
describe("rule 4: the topic's meaning (about / made with / ambiguous) is the model's understanding, for ANY topic", () => {
  const request = "هات فيديوهين تيك توك عن فوتوشوب";
  it("the model's reading of «عن فوتوشوب» (about) builds the query from its own words, for a topic that is not in any fixed list", () => {
    const m = topicMeaningFromModel({ relation: "about", topic_ar: "فوتوشوب", search_query: "شرح فوتوشوب للمبتدئين", made_with_markers_ar: ["تصميمات بفوتوشوب", "#معمول_بفوتوشوب"] }, request);
    expect(m).toMatchObject({ kind: "about", topic: "فوتوشوب" });
    expect(topicQueryOf(m!)).toBe("شرح فوتوشوب للمبتدئين");
  });
  it("a topic the model names that is NOT in the customer's words is refused (the code never takes an invented topic)", () => {
    expect(topicMeaningFromModel({ relation: "about", topic_ar: "إلكترونيات", search_query: "شرح إلكترونيات" }, request)).toBeNull();
  });
  it("a query that does not carry the topic is refused; a relation that is not one of the four is refused", () => {
    expect(topicMeaningFromModel({ relation: "about", topic_ar: "فوتوشوب", search_query: "أخبار عاجلة" }, request)).toBeNull();
    expect(topicMeaningFromModel({ relation: "whatever", topic_ar: "فوتوشوب", search_query: "فوتوشوب" }, request)).toBeNull();
  });
  it("videos whose own text talks about the topic come before videos where it is only a made-with marker the model named; hashtags alone are neutral", () => {
    const m = topicMeaningFromModel({ relation: "about", topic_ar: "فوتوشوب", search_query: "شرح فوتوشوب", made_with_markers_ar: ["تصميمات بفوتوشوب", "معمول بفوتوشوب"] }, request)!;
    expect(topicDiscussionClass("شرح أدوات فوتوشوب للمبتدئين", m)).toBe(2);
    expect(topicDiscussionClass("تصميمات بفوتوشوب جديدة #فوتوشوب", m)).toBe(0);
    expect(topicDiscussionClass("مقطع جميل #فوتوشوب", m)).toBe(1);
    const made = topicMeaningFromModel({ relation: "made_with", topic_ar: "فوتوشوب", search_query: "تصميمات بفوتوشوب", made_with_markers_ar: ["تصميمات بفوتوشوب"] }, "هات فيديوهين تيك توك معمولة بفوتوشوب")!;
    expect(topicDiscussionClass("تصميمات بفوتوشوب جديدة", made)).toBe(2);
    expect(topicDiscussionClass("شرح أدوات فوتوشوب", made)).toBe(1);
  });
  it("an ambiguous reading is kept as ambiguous (the plan is then turned into the question card); with no model reading the old word list still reads the AI family", () => {
    expect(topicMeaningFromModel({ relation: "ambiguous", topic_ar: "فوتوشوب" }, "هات فيديوهين تيك توك فوتوشوب")).toMatchObject({ kind: "ambiguous", topic: "فوتوشوب" });
    expect(topicMeaningOf("هات فيديوهين تيك توك عن الذكاء الاصطناعي").kind).toBe("about");
  });
});

// ---------------------------------------------------------------------------------------------------- rule 8
describe("rule 8: customer-facing values are Arabic only", () => {
  it("true/false, numbers and language codes in a code-built plan's sample table are Arabic words and Arabic-Indic digits", () => {
    expect(formatSampleValueAr("true")).toBe("نعم");
    expect(formatSampleValueAr("16")).toBe("١٦");
    expect(formatSampleValueAr("ar", { column: "language" })).toBe("العربية");
    expect(formatSampleValueAr("en", { column: "language" })).toBe("لغة أخرى");
    expect(formatSampleValueAr("xx", { column: "language" })).toBe("غير محددة");
    expect(formatSampleValueAr("ar")).toBe("ar");
  });
});

// ---------------------------------------------------------------------------------------------------- rules 2, 3, 4 and 5, platform by platform over the catalog's own tools
const NOW = Date.parse("2026-11-02T13:00:00Z");
const READING: ReadonlyArray<"search" | "account"> = ["search", "account"];
describe("the listing tools of every platform take the customer's conditions through their own fields", () => {
  for (const platform of SOCIAL_PLATFORMS) {
    for (const type of READING) {
      const tools = capabilitiesOf(catalog, platform, type);
      if (tools.length === 0) continue;
      it(`rule 2: ${platform} / ${type}: the engaged default writes the tool's most-liked order when it has one (${tools.filter((e) => toolProfile(e).sort?.options?.some((o) => o.kind === "liked")).length} of ${tools.length} tools), and never fails on a tool that has none`, () => {
        for (const e of tools) {
          const r = buildToolInput(e, { sort: "engaged", nowMs: NOW }, {});
          expect(r.ok, e.id).toBe(true);
          const liked = toolProfile(e).sort?.options?.find((o) => o.kind === "liked");
          if (liked) expect(r.params[toolProfile(e).sort!.field], e.id).toBe(liked.value);
          else expect(r.written, e.id).not.toContain("sort");
        }
      });
      it(`rule 3: ${platform} / ${type}: the customer's country and language are written into the tool's own field when it has one, and are a stated gap when it has none (never dropped silently)`, () => {
        for (const e of tools) {
          const pr = toolProfile(e);
          const r = buildToolInput(e, { country: ["EG"], language: "ar", nowMs: NOW }, pr.query ? { [pr.query.field]: "x" } : {});
          expect(r.written.includes("country") || r.gaps.some((g) => g.cls === "country"), `${e.id} country`).toBe(true);
          // a field that only places the request (a proxy region) is written AND stated as a gap; a tool with no field states the gap; a field that filters states none
          if (pr.country && !pr.country.enforces) expect(r.gaps, `${e.id} country`).toContainEqual({ cls: "country", reason: "not_enforced" });
          else if (!pr.country) expect(r.gaps, `${e.id} country`).toContainEqual({ cls: "country", reason: "no_field" });
          else expect(r.gaps.some((g) => g.cls === "country"), `${e.id} country`).toBe(false);
          expect(r.written.includes("language") || r.gaps.some((g) => g.cls === "language"), `${e.id} language`).toBe(true);
        }
      });
    }
    const searchTools = capabilitiesOf(catalog, platform, "search");
    if (searchTools.length > 0) {
      it(`rule 4: ${platform} / search: the model's query (the meaning of the topic) is written into the query field of every search tool that has one`, () => {
        for (const e of searchTools) {
          const field = toolProfile(e).query?.field;
          if (!field) continue;
          const r = buildToolInput(e, { topicQuery: "شرح فوتوشوب", nowMs: NOW }, { [field]: "فوتوشوب" });
          expect(r.params[field], e.id).toContain("شرح فوتوشوب");
        }
      });
    }
    for (const type of READING) {
      const dated = capabilitiesOf(catalog, platform, type).filter((e) => { const pr = toolProfile(e); return pr.queryOperators || ((pr.date?.from || pr.date?.to) && pr.date.format !== "unknown"); });
      if (dated.length === 0) continue;
      it(`rule 5: ${platform} / ${type}: ${dated.length} date-capable tools get the customer's Cairo days (October 2026: the first moment 2026-09-30 21:00 UTC, the last 2026-10-31 21:59:59 UTC; Egypt's summer time ended 2026-10-29)`, () => {
        for (const e of dated) {
          const pr = toolProfile(e);
          const base: Record<string, unknown> = pr.queryOperators && pr.query ? { [pr.query.field]: "x" } : {};
          const r = buildToolInput(e, { period: { from: "2026-10-01", to: "2026-10-31" }, nowMs: NOW }, base);
          expect(r.written, e.id).toContain("date");
          if (pr.queryOperators && pr.query) { expect(String(r.params[pr.query.field]), e.id).toContain("since:2026-09-30_21:00:00_UTC"); continue; }
          const from = r.params[pr.date!.from ?? ""];
          if (pr.date!.format === "iso") expect(from, e.id).toBe("2026-09-30T21:00:00Z");
          else if (pr.date!.format === "unix") expect(from, e.id).toBe(Date.parse("2026-09-30T21:00:00Z") / 1000);
          else expect(from, e.id).toBe("2026-09-30");
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------- rule 1 on a platform no benchmark reads comments for
describe("rule 1: the promise is the real counters, never an estimate on top", () => {
  it("rule 1: x / comments: the replies to the chosen tweets are promised as the tweets' own reply counters (the catalog's replyCount), the tweets chosen by the highest counters, comments + replies = their sum", () => {
    expect(Object.keys(catalog.byId.get("anyapi.x.search.posts")!.item_fields ?? {})).toContain("replyCount");
    const candidates = [12, 7, 0, 30].map((n, i) => ({ id: `t${i}`, counter: childCountOf({ replyCount: n }) }));
    const sorted = [...candidates].sort((a, b) => (b.counter ?? -1) - (a.counter ?? -1));
    const e = completeCountEstimate(sorted, { parents: 2, perParent: Number.POSITIVE_INFINITY, requested: null, pageCap: null, fallback: 1 });
    expect(e.chosen.map((c) => c.id)).toEqual(["t3", "t0"]);
    expect(e.total).toBe(42);
    const split = splitPromise(e.total, []);
    expect(split.comments + split.replies).toBe(42);
  });
});
