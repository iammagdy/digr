import { describe, expect, it, vi } from "vitest";
import { hasSocialSubject, socialLocationText, socialSubjectText } from "../src/lib/socialTasks";
import { canonicalSocialParams, getSocialCapability } from "../src/lib/socialSources";
import { detectSocialIntent } from "../src/lib/socialTasks";
import { isPeopleSearchRequest } from "../src/lib/planParameters";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";

/**
 * The subject of a topic search keeps its entities: «مباراة مصر والمغرب» is searched as a whole. A country becomes a country
 * filter only when the customer says it as a location («في مصر», «من مصر», «داخل مصر», «بمصر»).
 */
describe("the subject keeps the entities of the topic", () => {
  it.each([
    ["عايز ٥٠٠ بوست على إكس عن ماتش مصر والمغرب آخر شهر", "ماتش مصر والمغرب"],
    ["عايز ٥٠٠ بوست على إكس عن مباراة مصر والمغرب", "مباراة مصر والمغرب"],
    ["عايز ١٠٠ فيديو على يوتيوب عن مباراة الأهلي والزمالك", "مباراة الأهلي والزمالك"],
    ["عايز تغريدات عن أزمة السعودية وإيران", "أزمة السعودية وإيران"],
    ["هات ١٠٠ تغريدة عن مصر على إكس", "مصر"],
  ])("%s → «%s», no location", (text, subject) => {
    expect(socialSubjectText(text)).toBe(subject);
    expect(socialLocationText(text)).toBe("");
  });

  it.each([
    ["عايز ١٠٠ كومنت تيك توك عن كرة السلة في مصر", "كرة السلة", "مصر"],
    ["عايز ٥٠ بوست على إكس من مصر عن الغلاء", "الغلاء", "مصر"],
    ["عايز بوستات إكس داخل السعودية عن القهوة", "القهوة", "السعودية"],
    ["عايز تغريدات عن القهوة بمصر", "القهوة", "بمصر"],
    ["عايز تغريدات عن القهوة في مصر والسعودية", "القهوة", "مصر والسعودية"],
  ])("%s → subject «%s», location «%s»", (text, subject, location) => {
    expect(socialSubjectText(text)).toBe(subject);
    expect(socialLocationText(text)).toBe(location);
  });

  it("a topic that is only a country is a subject, and a location alone is not", () => {
    expect(hasSocialSubject("هات تغريدات عن مصر على إكس")).toBe(true);
    expect(hasSocialSubject("هات تغريدات على إكس في مصر")).toBe(false);
  });

  it("a hashtag still wins and the old behaviour for ordinary topics is unchanged", () => {
    expect(socialSubjectText("عايز بوستات عن #الصحة_النفسية في مصر")).toBe("الصحة النفسية");
    expect(socialSubjectText("هات ١٠ تغريدات عن كرة السلة")).toBe("كرة السلة");
  });
});

describe("the provider-bound parameters", () => {
  const x = getSocialCapability("social-x-posts")!;
  const tiktok = getSocialCapability("social-tiktok-comments")!;
  const params = (cap: typeof x, text: string) => canonicalSocialParams(cap, detectSocialIntent(text), text, {}, {});

  it("the whole phrase is the search query and no country filter appears for entities (X)", () => {
    const p = params(x, "عايز ٥٠٠ بوست على إكس عن ماتش مصر والمغرب آخر شهر");
    expect(p.query).toBe("ماتش مصر والمغرب");
    expect(p).not.toHaveProperty("region");
  });

  it("a stated location still sets the country filter and stays out of the query (X, TikTok)", () => {
    expect(params(x, "عايز ٥٠ بوست على إكس من مصر عن الغلاء")).toMatchObject({ query: "الغلاء", region: "EG" });
    expect(params(tiktok, "عايز ١٠٠ كومنت تيك توك عن كرة السلة في مصر")).toMatchObject({ query: "كرة السلة", region: "EG" });
  });

  it("TikTok and YouTube searches keep the whole phrase", () => {
    expect(params(tiktok, "عايز ١٠٠ كومنت تيك توك عن مباراة مصر والمغرب").query).toBe("مباراة مصر والمغرب");
    expect(params(getSocialCapability("social-youtube-comments")!, "عايز ٥٠ تعليق من فيديوهات يوتيوب عن مباراة مصر والمغرب").query).toBe("مباراة مصر والمغرب");
  });
});

describe("a team name is not a role", () => {
  it("«الزمالك» does not make a people search; a real owner request still does", () => {
    expect(isPeopleSearchRequest("عايز ١٠٠ فيديو على يوتيوب عن مباراة الأهلي والزمالك")).toBe(false);
    expect(isPeopleSearchRequest("عايز ٥٠ مالك شركة مقاولات في مصر")).toBe(true);
    expect(isPeopleSearchRequest("عايز أصحاب ومالكي الشركات في مصر")).toBe(true);
    expect(isPeopleSearchRequest("عايز المالك والمدير في مصر")).toBe(true);
  });
});

describe("through the chat handler (model stubbed to throw)", () => {
  const run = async (message: string) => {
    const handler = new ChatHandler(createChatDb() as any);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
    return handler.handleUserMessage({ userId: "u_entities", message, userBalance: 100000 }) as Promise<any>;
  };

  it("a match between two countries is planned with the full phrase and no country chip", async () => {
    const reply = await run("عايز ٥٠٠ بوست على إكس عن ماتش مصر والمغرب آخر شهر");
    expect(reply.outputType).toBe("propose_plan");
    const item = reply.planQuote.items[0];
    expect(item.params.query).toBe("ماتش مصر والمغرب");
    expect(item.params).not.toHaveProperty("region");
    expect(reply.contentAr).toContain("«ماتش مصر والمغرب»");
  });

  it("two clubs are a topic, not an owner search", async () => {
    const reply = await run("عايز ١٠٠ فيديو على يوتيوب عن مباراة الأهلي والزمالك آخر شهر");
    expect(reply.outputType).toBe("propose_plan");
    expect(reply.planQuote.items[0].capabilitySlug).toBe("social-youtube-videos");
    expect(reply.planQuote.items[0].params.query).toBe("مباراة الأهلي والزمالك");
  });

  it("a location is still a location", async () => {
    const reply = await run("عايز ١٠٠ كومنت تيك توك عن كرة السلة في مصر آخر شهر");
    expect(reply.planQuote.items[0].params).toMatchObject({ query: "كرة السلة", region: "EG" });
  });
});
