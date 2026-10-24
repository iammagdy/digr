import { describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { buildSystemPromptParts } from "../src/functions/shared/systemPrompt";
import { CATALOG_MAP_RULES, SLICE_MAX_CHARS, catalogMapPromptText, catalogMapText, catalogSliceForMessage, catalogSliceText, detectCatalogPlatforms, isOfferQuestion, offerAnswerAr } from "../src/lib/catalogMap";
import { SERVICES_CATALOG } from "../src/lib/servicesCatalog";
import { PROVIDER_NAME_PATTERN } from "../src/lib/publicCapabilityIds";
import { createChatDb } from "./helpers/chatSession";

const LATIN = /[A-Za-z]/;
const EMOJI = /\p{Extended_Pictographic}/u;
const BANNED = /treg|tikhub|scrapecreators|icypeas|apify|serpapi|anyapi|crawl4ai|firecrawl|openai|anthropic|claude|haiku|gemini|veo|sora|kling|hailuo|seedance|flux|lyria|usd|endpoint/i;
const platform = (slug: string) => SERVICES_CATALOG.flatMap((sector) => sector.platforms).find((entry) => entry.slug === slug)!;

describe("the compact catalog map (generated from the /services data)", () => {
  const map = catalogMapText();
  it("is compact, Arabic only, and names no provider, endpoint, model or amount", () => {
    expect(map.length).toBeLessThan(2500); // under three KB of text, never the whole list of services
    expect(map).not.toMatch(LATIN);
    expect(map).not.toMatch(EMOJI);
    expect(map).not.toMatch(BANNED);
    expect(map.match(PROVIDER_NAME_PATTERN)).toBeNull();
  });

  it("lists every sector and every platform of the data, and no service name", () => {
    for (const sector of SERVICES_CATALOG) {
      expect(map).toContain(`${sector.nameAr}:`);
      for (const entry of sector.platforms) expect(map, entry.slug).toContain(entry.nameAr);
    }
    const names = SERVICES_CATALOG.flatMap((sector) => sector.platforms.flatMap((entry) => entry.services.map((service) => service.nameAr)));
    const inMap = names.filter((name) => map.includes(name) && name.length > 14);
    expect(inMap).toEqual([]); // names of services are not in the map (they arrive as a slice)
  });

  it("is in the fixed, cacheable part of the system prompt, with the rules that stop the assistant inventing a service", () => {
    const parts = buildSystemPromptParts({ sanitizedCapabilities: [], userBalancePoints: 100 });
    expect(parts.staticText).toContain(catalogMapPromptText());
    expect(parts.turnText).not.toContain(catalogMapText());
    expect(CATALOG_MAP_RULES).toContain("Never name or promise a platform, service or group that is not in the map");
    expect(CATALOG_MAP_RULES).toContain("price, plan, hold and charge come only from the server");
    expect(CATALOG_MAP_RULES).toContain("the whole hold is released if nothing is delivered");
    expect(CATALOG_MAP_RULES).toContain("People and professional contact data");
  });
});

describe("a message that names a platform gets that platform's slice, by code", () => {
  it("finds the platform by its Arabic name, its usual spellings and with the Arabic prefixes", () => {
    const slugs = (text: string) => detectCatalogPlatforms(text).map((entry) => entry.slug);
    expect(slugs("عايز تعليقات من فيسبوك")).toEqual(["facebook"]);
    expect(slugs("منشورات عن الدهب على إكس")).toEqual(["x"]);
    expect(slugs("منشورات عن الدهب على تويتر")).toEqual(["x"]);
    expect(slugs("هات ١٠ كومنتس تيك توك عن كرة السلة")).toEqual(["tiktok"]);
    expect(slugs("بالانستجرام والفيسبوك")).toEqual(["instagram", "facebook"]);
    expect(slugs("فيديوهات يوتيوب")).toEqual(["youtube"]);
    expect(slugs("بيانات من لينكد إن")).toEqual(["linkedin"]);
    expect(slugs("اسعار أمازون")).toEqual(["amazon"]);
  });

  it("whole words only: «إكسل» is not «إكس», and a request that names no platform gets no slice", () => {
    expect(detectCatalogPlatforms("حلل ملف إكسل")).toEqual([]);
    expect(detectCatalogPlatforms("عايز شركتين كهرباء في مصر")).toEqual([]);
    expect(detectCatalogPlatforms("")).toEqual([]);
    expect(catalogSliceForMessage("عايز شركتين كهرباء في مصر")).toBe("");
    expect(catalogSliceForMessage("حلل ملف إكسل")).toBe("");
  });

  it("the slice holds that platform's service names only: right platform, bounded, Arabic, no price, never the whole list", () => {
    const slice = catalogSliceForMessage("منشورات عن الدهب على إكس");
    expect(slice).toContain("خدمات منصة إكس");
    const x = platform("x");
    expect(x.services.some((service) => slice.includes(service.nameAr))).toBe(true);
    for (const other of ["tiktok", "facebook", "youtube"]) expect(platform(other).services.every((service) => !slice.includes(service.nameAr) || x.services.some((own) => own.nameAr === service.nameAr))).toBe(true);
    expect(catalogSliceText(x).length).toBeLessThanOrEqual(SLICE_MAX_CHARS + 120);
    expect(slice).not.toMatch(BANNED);
    expect(slice.replace(/\[[^\]]*\]/g, "")).not.toMatch(LATIN);
    expect(slice).not.toMatch(/نقطة|ج\.م|[0-9٠-٩]/);
    // three platforms named: at most two slices; the whole catalog is never attached
    const three = catalogSliceForMessage("إكس وتيك توك وفيسبوك ويوتيوب");
    expect(three.match(/خدمات منصة/g)?.length).toBe(2);
    const everything = SERVICES_CATALOG.flatMap((sector) => sector.platforms.flatMap((entry) => entry.services)).length;
    expect(three.split("؛").length).toBeLessThan(everything / 10);
  });

  it("every platform's slice is within the bound", () => {
    for (const entry of SERVICES_CATALOG.flatMap((sector) => sector.platforms)) expect(catalogSliceText(entry).length, entry.slug).toBeLessThanOrEqual(SLICE_MAX_CHARS + 120);
  });

  it("through the chat handler: the slice joins the model's context for a platform request the model is asked about; none for a request that names no platform", async () => {
    const run = async (message: string) => {
      const db = createChatDb();
      const handler = new ChatHandler(db as any);
      const calls: any[] = [];
      (handler as any).llm.executeTurn = vi.fn(async (options: any) => {
        calls.push(options);
        return { output: { type: "answer_question", intent: "research", answerAr: "ما الموضوع المطلوب؟", topic: "" }, inputTokens: 10, outputTokens: 5, costUsd: 0, model: "claude-haiku-5-5" };
      });
      await handler.handleUserMessage({ userId: "u_map", message, userBalance: 5000 });
      return calls;
    };
    const withPlatform = await run("عايز بيانات من إكس");
    expect(withPlatform.length).toBeGreaterThan(0);
    const systemTexts = (withPlatform[0].messages as Array<{ role: string; content: string }>).filter((entry) => entry.role === "system").map((entry) => entry.content);
    expect(systemTexts.some((text) => text.includes("خدمات منصة إكس"))).toBe(true);
    const without = await run("عايز بيانات");
    for (const call of without) expect((call.messages as Array<{ content: string }>).some((entry) => entry.content.includes("خدمات منصة"))).toBe(false);
  });
});

describe("«what do you offer»: answered by code, zero model tokens", () => {
  const YES = ["إيه الخدمات؟", "ايه الخدمات", "إيه الخدمات المتاحة؟", "ما هي خدماتكم؟", "ما هي الخدمات", "بتعملوا إيه؟", "بتعملوا ايه", "بتقدموا إيه؟", "عندكم إيه؟", "إيه اللي بتعملوه؟", "إيه اللي تقدروا تعملوه؟", "ماذا تقدمون؟", "ايش الخدمات", "شو خدماتكم"];
  const NO = ["عايز شركتين كهرباء في مصر", "إيه الخدمات المتاحة على تيك توك؟", "بتعملوا إيه في فيسبوك؟", "إنت مين؟", "هات ١٠ تغريدات عن كرة السلة", "الخدمات اللي طلبتها اتأخرت", "", "ازيك"];

  it("exact phrases", () => {
    for (const text of YES) expect(isOfferQuestion(text), text).toBe(true);
    for (const text of NO) expect(isOfferQuestion(text), JSON.stringify(text)).toBe(false);
  });

  it("the answer: short Arabic, by sector, decision makers first, a pointer to «خدماتنا», no number, price or markdown", () => {
    const answer = offerAnswerAr();
    const lines = answer.split("\n");
    expect(lines.length).toBeLessThan(20);
    expect(answer.length).toBeLessThan(900);
    const b2b = SERVICES_CATALOG.find((sector) => sector.platforms.some((entry) => entry.slug === "people"))!;
    expect(lines.findIndex((line) => line.includes(b2b.nameAr))).toBeGreaterThan(-1);
    expect(lines.findIndex((line) => line.includes(b2b.nameAr))).toBeLessThan(lines.findIndex((line) => line.includes("وهذه بقية القطاعات")));
    for (const sector of SERVICES_CATALOG) expect(answer).toContain(sector.nameAr);
    expect(answer).toContain("«خدماتنا»");
    expect(answer).toContain("/services");
    expect(answer).toContain("حالة تحقق");
    expect(answer).toContain("قبل أي خصم");
    const withoutLink = answer.replace(/https?:\/\/\S+/g, "");
    expect(withoutLink).not.toMatch(LATIN);
    expect(withoutLink).not.toMatch(EMOJI);
    expect(withoutLink).not.toMatch(/[0-9٠-٩]/);
    expect(withoutLink).not.toMatch(/[*_`#]/);
    expect(answer).not.toMatch(BANNED);
    expect(answer).not.toMatch(/نقطة|ج\.م|%|٪/);
  });

  it("through the chat handler: the model is never called and no token is spent", async () => {
    for (const message of ["إيه الخدمات؟", "بتعملوا إيه؟"]) {
      const db = createChatDb();
      const handler = new ChatHandler(db as any);
      const model = vi.fn(async () => { throw new Error("the model must not be called"); });
      (handler as any).llm.executeTurn = model;
      const response: any = await handler.handleUserMessage({ userId: "u_offer", message, userBalance: 5000 });
      expect(model).not.toHaveBeenCalled();
      expect(response.outputType).toBe("answer_question");
      expect(response.contentAr).toBe(offerAnswerAr());
      expect(response.tokensUsed).toEqual({ input: 0, output: 0, costUsd: 0 });
      expect(db.store.get("plans_quotes") || []).toEqual([]);
    }
  });
});
