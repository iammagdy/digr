import { describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";
import { getSocialCapability, socialPlanSummaryAr, xCountryNoteAr } from "../src/lib/socialSources";
import { withXCountryTerms, withXDateOperators } from "../src/lib/xSearchWindow";

/**
 * X has no country filter, so a request that names a country is narrowed with the country's own words in the search text,
 * the date operators stay, and the plan says so in Arabic. Nothing here touches a price, a cap, a charge or SQL.
 */
const EGYPT_GROUP = "(مصر OR مصري OR مصرية OR المصري OR المصرية OR egypt OR egyptian)";
const x = () => getSocialCapability("social-x-posts")!;
const sourceBuild = (endpointId: string, request: Record<string, any>) => {
  const source = x().discover.query!.find((candidate) => candidate.endpointId === endpointId)!;
  return source.build({ limit: 50, ...request } as any) as Record<string, any>;
};

describe("the search text of an X topic search in a country", () => {
  it("adds the country's words as one group, after the topic", () => {
    expect(withXCountryTerms("كرة السلة", "EG")).toBe(`كرة السلة ${EGYPT_GROUP}`);
    expect(withXCountryTerms("  كرة السلة ", "eg")).toBe(`كرة السلة ${EGYPT_GROUP}`);
    expect(withXCountryTerms("basketball", "SA")).toBe("basketball (السعودية OR سعودي OR سعودية OR saudi)");
  });

  it("leaves the query alone with no country, an unknown one, or when the query already names the country", () => {
    expect(withXCountryTerms("كرة السلة")).toBe("كرة السلة");
    expect(withXCountryTerms("كرة السلة", "")).toBe("كرة السلة");
    expect(withXCountryTerms("كرة السلة", "ZZ")).toBe("كرة السلة");
    expect(withXCountryTerms("كرة السلة في مصر", "EG")).toBe("كرة السلة في مصر");
    expect(withXCountryTerms("Egypt basketball", "EG")).toBe("Egypt basketball");
    expect(withXCountryTerms("", "EG")).toBe("");
  });

  it("the date operators stay behind the country group, for both X sources", () => {
    const request = { query: "كرة السلة", region: "EG", dateFrom: "2026-09-21", dateTo: "2026-10-21" };
    const expected = `كرة السلة ${EGYPT_GROUP} since:2026-09-21 until:2026-10-22`;
    expect(sourceBuild("anyapi.x.search.posts", request)).toMatchObject({ query: expected, queryType: "Latest", limit: 50 });
    expect(sourceBuild("tikhub.x.twitter-web-fetch-search-timeline", request)).toMatchObject({ keyword: expected, search_type: "Latest" });
    expect(withXDateOperators(withXCountryTerms("كرة السلة", "EG"), "2026-09-21", "2026-10-21")).toBe(expected);
  });

  it("with no country the text sent is what it was before (topic plus the date operators only)", () => {
    const request = { query: "كرة السلة", dateFrom: "2026-09-21", dateTo: "2026-10-21" };
    expect(sourceBuild("anyapi.x.search.posts", request).query).toBe("كرة السلة since:2026-09-21 until:2026-10-22");
    expect(sourceBuild("tikhub.x.twitter-web-fetch-search-timeline", request).keyword).toBe("كرة السلة since:2026-09-21 until:2026-10-22");
  });

  it("an account feed has no search text to narrow and sends no country words", () => {
    const feed = x().discover.channel!.find((candidate) => candidate.endpointId === "anyapi.x.user.posts")!;
    const body = feed.build({ limit: 50, channel: "@ahly", region: "EG" } as any) as Record<string, any>;
    expect(JSON.stringify(body)).not.toMatch(/OR|egypt|مصر/i);
  });
});

describe("the plan says it, in Arabic", () => {
  const params = { query: "كرة السلة", region: "EG", dateFrom: "2026-09-21", dateTo: "2026-10-21" };
  const note = "، ولأن إكس لا يتيح تحديد الدولة يقتصر البحث على المنشورات التي تذكر مصر أو ما يُنسب إليها";

  it("the note names the country and says X has no country filter; nothing in Latin letters, no digits, no provider", () => {
    expect(xCountryNoteAr(x(), params)).toBe(note);
    expect(xCountryNoteAr(x(), params)).not.toMatch(/[A-Za-z0-9]/);
    expect(xCountryNoteAr(x(), { ...params, region: "SA" })).toContain("السعودية");
  });

  it("only for X posts with a country: no note without one, none for another platform or kind", () => {
    expect(xCountryNoteAr(x(), { query: "كرة السلة" })).toBe("");
    expect(xCountryNoteAr(x(), { ...params, region: "ZZ" })).toBe("");
    expect(xCountryNoteAr(getSocialCapability("social-tiktok-comments")!, params)).toBe("");
    expect(xCountryNoteAr(getSocialCapability("social-youtube-comments")!, params)).toBe("");
  });

  it("the plan summary of an X topic search carries the note, and the plan of one without a country does not", () => {
    const n = (value: number) => String(value);
    expect(socialPlanSummaryAr(x(), params, 100, n)).toBe(`سحب المنشورات على منصة إكس عن «كرة السلة»${note}`);
    expect(socialPlanSummaryAr(x(), { query: "كرة السلة" }, 100, n)).toBe("سحب المنشورات على منصة إكس عن «كرة السلة»");
  });

  it("through the chat: «في مصر على إكس» gives a plan whose params carry EG and whose summary carries the note; without «في مصر» neither", async () => {
    const run = async (message: string) => {
      const handler = new ChatHandler(createChatDb() as any);
      (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
      return (await handler.handleUserMessage({ userId: "u_x_country", message, userBalance: 100000 }) as any).planQuote;
    };
    const withCountry = await run("هات ١٠٠ تغريدة عن كرة السلة في مصر على إكس آخر شهر");
    expect(withCountry.items[0].params).toMatchObject({ region: "EG", query: "كرة السلة" });
    expect(withCountry.summaryAr).toContain("يقتصر البحث على المنشورات التي تذكر مصر أو ما يُنسب إليها");
    const without = await run("هات ١٠٠ تغريدة عن كرة السلة على إكس آخر شهر");
    expect(without.items[0].params.region).toBeUndefined();
    expect(without.summaryAr).not.toContain("يقتصر البحث");
    // nothing about the price changes: the same unit price and the same charge for the same number of posts
    expect(withCountry.unitPricePoints).toBe(0.11715);
    expect(withCountry.unitPricePoints).toBe(without.unitPricePoints);
    expect(withCountry.expectedPoints).toBe(without.expectedPoints);
    expect(withCountry.quotedPoints).toBe(without.quotedPoints);
  });
});
