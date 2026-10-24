import { describe, expect, it } from "vitest";
import { pageChannelOfItem, socialFilterStepAr, socialSearchStepAr } from "../src/lib/planMethodSteps";
import { readFileSync } from "node:fs";

/**
 * The methodology steps of a social plan card. Evidence (the owner's live check): a page-posts plan said «البحث عن المحتوى المنشور حول الرابط», which reads the
 * link as a topic. A page plan now says the posts are read from the page the customer gave; a topic plan keeps its wording.
 */
const LINK = "https://www.facebook.com/youm7";
describe("the search step of a social plan", () => {
  it("a page plan says the posts are read from the given page, never a topic search, and never prints the link", () => {
    const text = socialSearchStepAr({ isVideoPlan: false, trending: false, displayIndustry: LINK, countryAr: "مصر", pageChannel: LINK });
    expect(text).toBe("قراءة المنشورات مباشرة من الصفحة التي حددتها على المنصة، ضمن الفترة المطلوبة.");
    expect(text).not.toContain("حول");
    expect(text).not.toContain(LINK);
    expect(text).not.toMatch(/[A-Za-z]/);
  });
  it("a video page plan names the videos", () => {
    expect(socialSearchStepAr({ isVideoPlan: true, trending: false, displayIndustry: "x", countryAr: "مصر", pageChannel: "youm7" })).toContain("قراءة الفيديوهات مباشرة من الصفحة");
  });
  it("a topic plan keeps its wording (posts or videos about the topic)", () => {
    expect(socialSearchStepAr({ isVideoPlan: false, trending: false, displayIndustry: "الترندات الصحية", countryAr: "مصر", pageChannel: null }))
      .toBe("البحث عن المحتوى المنشور حول «الترندات الصحية» على المنصة المحددة.");
    expect(socialSearchStepAr({ isVideoPlan: true, trending: false, displayIndustry: "الدوري", countryAr: "مصر", pageChannel: null }))
      .toBe("البحث عن الفيديوهات المنشور حول «الدوري» على المنصة المحددة.");
  });
  it("a trending plan keeps its wording", () => {
    expect(socialSearchStepAr({ isVideoPlan: true, trending: true, displayIndustry: "الترند", countryAr: "مصر", pageChannel: null }))
      .toBe("البحث عن الترند على المنصة المحددة ضمن النطاق مصر.");
  });
  it("the filter step of a page plan does not filter by a topic it does not have", () => {
    expect(socialFilterStepAr({ pageChannel: LINK, displayIndustry: LINK })).not.toContain("صلتها بموضوع");
    expect(socialFilterStepAr({ pageChannel: null, displayIndustry: "الدهب" })).toBe("فرز النتائج حسب صلتها بموضوع «الدهب» والفترة الزمنية المطلوبة.");
  });
  it("the page of a plan is read from its channel (posts plan) or its first channel (comments plan), for Facebook only", () => {
    expect(pageChannelOfItem({ capabilitySlug: "social-facebook-posts", params: { channel: "youm7" } })).toBe("youm7");
    expect(pageChannelOfItem({ capabilitySlug: "social-facebook-comments", params: { channels: [LINK] } })).toBe(LINK);
    expect(pageChannelOfItem({ capabilitySlug: "social-facebook-keyword-comments", params: { query: "الترندات الصحية" } })).toBeNull();
    expect(pageChannelOfItem({ capabilitySlug: "social-youtube-comments", params: { channels: ["@قناة"] } })).toBeNull();
    expect(pageChannelOfItem(undefined)).toBeNull();
  });
  it("the card uses these sentences (the page is read from the plan item)", () => {
    const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
    expect(card).toContain("socialSearchStepAr({");
    expect(card).toContain("socialFilterStepAr({");
    expect(card).toContain("pageChannelOfItem(primaryItem)");
  });
});
