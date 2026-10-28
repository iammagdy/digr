import { describe, expect, it } from "vitest";
import { PARSERS, PARSER_IDS, describeAgentSource, isAgentSourceId, searchAgentSources, usdPerRowOfParser, WEB_SOURCES } from "../src/lib/agentMission/sources";
import { checkPublicBusinessUrl, checkPublicReadUrl } from "../src/lib/multiProvider/policy";
import { isContactSource, requestWantsContacts, verifyContactValue } from "../src/lib/agentMission/contacts";
import { isMultiStageRequest, planningBudgetUsd } from "../src/lib/agentMission/budget";
import { AGENT_PLANNING_BUDGET_MULTI_STAGE_USD, AGENT_PLANNING_BUDGET_USD } from "../src/lib/agentMission/constants";

const ok = (name: keyof typeof PARSERS, url: string) => PARSERS[name].accepts(new URL(url));

describe("the documented parsers", () => {
  it("all twenty parsers of the documentation are known, each with its own source id", () => {
    expect(Object.keys(PARSERS).sort()).toEqual(["app-store", "app-store-reviews", "emails", "g2-reviews", "google-maps", "google-maps-reviews", "google-play", "google-play-reviews", "instagram-feed", "instagram-post", "instagram-profile", "links", "phone-numbers", "tiktok-comments", "tiktok-feed", "tiktok-followers", "tiktok-following", "tiktok-profile", "tiktok-user-search", "tiktok-video"]);
    for (const p of Object.values(PARSERS)) { expect(p.id).toBe(`contextdev.parse.${p.name}`); expect(PARSER_IDS[p.id]).toBe(p.name); expect(isAgentSourceId(p.id)).toBe(true); }
    expect(isAgentSourceId("x.x.search-posts-all")).toBe(false);
  });

  it("each parser accepts the URL shapes the documentation lists and refuses the others", () => {
    expect(ok("google-maps-reviews", "https://www.google.com/maps/place/Abu+Tarek/@30,31,17z/")).toBe(true);
    expect(ok("google-maps-reviews", "https://search.google.com/local/reviews?placeid=ChIJ")).toBe(true);
    expect(ok("google-maps-reviews", "https://example.com/maps")).toBe(false);
    expect(ok("instagram-feed", "https://www.instagram.com/explore/tags/running/")).toBe(true);
    expect(ok("instagram-feed", "https://www.instagram.com/popular/coffee/")).toBe(true);
    expect(ok("instagram-feed", "https://www.instagram.com/natgeo/")).toBe(false);
    expect(ok("instagram-post", "https://www.instagram.com/reel/DeckcQnA23l/")).toBe(true);
    expect(ok("instagram-profile", "https://www.instagram.com/natgeo/")).toBe(true);
    expect(ok("instagram-profile", "https://www.instagram.com/p/abc/")).toBe(false);
    expect(ok("tiktok-feed", "https://www.tiktok.com/tag/food")).toBe(true);
    expect(ok("tiktok-feed", "https://www.tiktok.com/search?q=luxor")).toBe(true);
    expect(ok("tiktok-feed", "https://www.tiktok.com/@nasa")).toBe(true);
    expect(ok("tiktok-comments", "https://www.tiktok.com/@nasa/video/7697300954667994381")).toBe(true);
    expect(ok("tiktok-comments", "https://vm.tiktok.com/ZM123/")).toBe(false);
    expect(ok("tiktok-user-search", "https://www.tiktok.com/search/user?q=snackpass")).toBe(true);
    expect(ok("tiktok-user-search", "https://www.tiktok.com/search/user")).toBe(false);
    expect(ok("google-play-reviews", "https://play.google.com/store/apps/details?id=com.spotify.music&hl=en&gl=us")).toBe(true);
    expect(ok("app-store-reviews", "https://apps.apple.com/us/app/spotify-music-and-podcasts/id324684580")).toBe(true);
    expect(ok("g2-reviews", "https://www.g2.com/products/slack/reviews")).toBe(true);
    expect(ok("g2-reviews", "https://www.g2.com/categories/crm")).toBe(false);
    expect(ok("emails", "https://acme.example/contact")).toBe(true);
  });

  it("only google-maps-reviews takes sort and limit", () => {
    expect(Object.values(PARSERS).filter((p) => p.params).map((p) => p.name)).toEqual(["google-maps-reviews"]);
  });
});

describe("the policy: public social pages may be READ; logins and private hosts never", () => {
  it("checkPublicReadUrl lets social hosts through and still blocks login, account, credentials and private hosts", () => {
    for (const url of ["https://www.instagram.com/explore/tags/coffee/", "https://www.tiktok.com/@nasa/video/7697300954667994381", "https://www.facebook.com/somepage/posts/123", "https://x.com/elonmusk/status/1", "https://www.google.com/maps/place/?q=place_id:X", "https://acme.com/contact"]) expect(checkPublicReadUrl(url).ok, url).toBe(true);
    for (const url of ["https://www.instagram.com/accounts/login/", "https://acme.com/login", "https://acme.com/my-account/orders", "https://user:pw@acme.com/", "http://192.168.1.1/", "http://localhost:3000/", "https://intranet.local/", "ftp://acme.com/x", "not a url"]) expect(checkPublicReadUrl(url).ok, url).toBe(false);
  });

  it("the company-website check keeps refusing social networks: it decides whether a page is a COMPANY'S OWN site", () => {
    expect(checkPublicBusinessUrl("https://www.instagram.com/acme/").ok).toBe(false);
    expect(checkPublicBusinessUrl("https://acme.com/contact").ok).toBe(true);
  });
});

describe("one ranked list for every provider, by cost per row computed by code", () => {
  it("an Instagram request lists the Instagram parsers; X, Facebook and YouTube have no parser", () => {
    const ig = searchAgentSources({ words: ["hashtag", "posts"], platform: "instagram" });
    expect(ig.map((c) => c.id)).toContain("contextdev.parse.instagram-feed");
    expect(ig.every((c) => c.platform === "instagram")).toBe(true);
    for (const platform of ["x", "facebook", "youtube"]) expect(searchAgentSources({ words: ["posts", "search"], platform })).toEqual([]);
  });

  it("the cost per row is the documented base credit over the rows one call returns", () => {
    const reviews = PARSERS["google-maps-reviews"];
    expect(usdPerRowOfParser(reviews)).toBeCloseTo(0.00254 / 1000, 9);
    const hit = searchAgentSources({ words: ["reviews"], platform: "google_maps" }).find((c) => c.id === reviews.id)!;
    expect(hit.usd_per_row).toBeCloseTo(0.00254 / 1000, 9);
    expect(hit.rows_per_call).toBe(1000);
  });

  it("people search is a source with the documented price and says it returns no e-mail and no phone", () => {
    const d = describeAgentSource("contextdev.people.search")!;
    expect(d.summary).toContain("NO e-mail and NO phone");
    expect(d.usd_per_call).toBeCloseTo(10 * 0.00254, 9);
    expect(WEB_SOURCES.map((s) => s.id).sort()).toEqual(["contextdev.people.search", "contextdev.scrape", "contextdev.search", "firecrawl.scrape", "firecrawl.search"]);
  });
});

describe("contact fields are verified by code", () => {
  it("a work e-mail on a company domain passes; a personal mailbox, a placeholder or garbage does not", () => {
    expect(verifyContactValue("work_email", " Info@Acme-Egypt.COM ")).toBe("info@acme-egypt.com");
    expect(verifyContactValue("work_email", "mailto:sales@acme.com?subject=x")).toBe("sales@acme.com");
    for (const bad of ["someone@gmail.com", "a@outlook.com", "x@example.com", "not-an-email", "", "a@b", "logo@2x.png"]) expect(verifyContactValue("work_email", bad), bad).toBeNull();
  });
  it("a phone with 7 to 15 digits passes in normalized form; a short number or a repeated digit does not", () => {
    expect(verifyContactValue("phone", "+20 (0)2 2794 5000")).toBe("+20227945000");
    for (const bad of ["12345", "0000000000", "", "abc"]) expect(verifyContactValue("phone", bad), bad).toBeNull();
  });
  it("what a customer asks for, in Arabic and English, and what is a contact source", () => {
    expect(requestWantsContacts("وجوه كل شركة موظفين اتنين بإيميلاتهم وموبايلاتهم")).toEqual({ email: true, phone: true });
    expect(requestWantsContacts("هات ٢٠ تغريدة عن محمد صلاح")).toEqual({ email: false, phone: false });
    expect(requestWantsContacts("work emails please")).toMatchObject({ email: true });
    expect(isContactSource("contextdev.parse.emails")).toBe(true);
    expect(isContactSource("blitzapi.people.email.find")).toBe(true);
    expect(isContactSource("anyapi.x.search.posts")).toBe(false);
    expect(isContactSource("contextdev.people.search")).toBe(false);
  });
});

describe("the planning budget", () => {
  it("a multi-stage request gets 0.10 USD, every other 0.05", () => {
    expect(AGENT_PLANNING_BUDGET_MULTI_STAGE_USD).toBe(0.1);
    expect(planningBudgetUsd("هات ٢٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا")).toBe(AGENT_PLANNING_BUDGET_USD);
    expect(planningBudgetUsd("عايز ٣ شركات كهروميكانيكا في مصر، وجوه كل شركة موظفين اتنين بإيميلاتهم وموبايلاتهم")).toBe(AGENT_PLANNING_BUDGET_MULTI_STAGE_USD);
    expect(planningBudgetUsd("منشورات فيسبوك عن التضخم مع تعليقات كل منشور")).toBe(AGENT_PLANNING_BUDGET_MULTI_STAGE_USD);
    expect(isMultiStageRequest("تقييمات مطعم أبو طارق")).toBe(true);
  });
});
