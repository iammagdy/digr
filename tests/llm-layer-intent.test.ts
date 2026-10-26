import { afterEach, describe, expect, it, vi } from "vitest";

// The offline catalog prices the three decision-maker endpoints like the live one does (the real people branch reads them); every other endpoint is read as before.
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/functions/shared/catalogClient")>();
  const prices: Record<string, number> = { "treg.people.search": 0.015, "treg.people.email.find": 0.01, "treg.people.phone.find": 0.01 };
  return {
    ...actual,
    getEndpointDetails: vi.fn(async (endpointId: string, options?: any) => prices[endpointId]
      ? ({ catalogPriceUsd: prices[endpointId] } as any)
      : actual.getEndpointDetails(endpointId, options)),
  };
});
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import { CAPABILITY_CARDS, LEGACY_CAPABILITY_NOTES, renderCapabilityCards } from "../src/functions/shared/capabilityCards";
import { buildSystemPromptParts } from "../src/functions/shared/systemPrompt";
import { extractRequestIntent, missingInputsForIntent, peopleParamsFromIntent, unsupportedConstraintsNoteAr } from "../src/lib/requestIntent";
import { extractNumberFromText } from "../src/lib/arabicNumbers";
import { createChatDb, runConversation, withPeopleSettlement } from "./helpers/chatSession";

/**
 * LLM layer: capability cards generated against the real catalog, the structured intent of a request, and the provider
 * parameters that come out, asserted on the structured request (not on text). The five fixed requests of the QA run.
 */
const COMPANIES = "عايز شركتين كهرباء في مصر";
const PEOPLE = "٣ مديرين في شركات الطاقة في السعودية مع إيميلاتهم وأرقامهم";
const COMMENTS = "١٠ كومنتس تيك توك عن كرة السلة في مصر في ٢٠٢٥";
const TWEETS = "هات ١٠ تغريدات عن كرة السلة في ٢٠٢٥";
const STUDIES = "اجمع ١٠ دراسات عن الطاقة الشمسية في ألمانيا";
const hasArabic = (value: unknown) => /[؀-ۿ]/.test(JSON.stringify(value));

describe("1. capability cards come from the real catalog", () => {
  const bySlug = new Map((APPROVED_CAPABILITY_CATALOG as any[]).map((c) => [c.slug, c]));
  const props = (slug: string) => {
    const schema = bySlug.get(slug)?.paramsSchema;
    const parsed = typeof schema === "string" ? JSON.parse(schema) : schema || {};
    return new Set(Object.keys(parsed.properties || {}));
  };

  it("every catalog capability is covered by a card or an older-route note, and every card names a real capability", () => {
    const covered = new Set([...CAPABILITY_CARDS.map((c) => c.slug), ...Object.keys(LEGACY_CAPABILITY_NOTES)]);
    for (const cap of APPROVED_CAPABILITY_CATALOG as any[]) expect(covered.has(cap.slug), `${cap.slug} has no card`).toBe(true);
    for (const card of CAPABILITY_CARDS) expect(bySlug.has(card.slug), `${card.slug} is not in the catalog`).toBe(true);
  });

  it("every input a card names and every key of its examples exists in the capability's own schema", () => {
    for (const card of CAPABILITY_CARDS) {
      const allowed = props(card.slug);
      for (const input of card.inputs) {
        const top = input.split("=")[0].split(".")[0].trim();
        expect(allowed.has(top), `${card.slug}: input «${top}» is not in the schema`).toBe(true);
      }
      expect(card.examples.length, `${card.slug} examples`).toBeGreaterThanOrEqual(1);
      for (const example of card.examples) for (const key of Object.keys(example.params)) expect(allowed.has(key), `${card.slug}: example key «${key}»`).toBe(true);
    }
  });

  it("the main services carry two examples or more, with filters, what they return and good for / not good for", () => {
    for (const slug of ["icypeas-companies-search", "professional-people-search"]) {
      const card = CAPABILITY_CARDS.find((c) => c.slug === slug)!;
      expect(card.examples.length).toBeGreaterThanOrEqual(2);
      expect(card.filters.length).toBeGreaterThan(10);
      expect(card.returns.length).toBeGreaterThan(10);
      expect(card.goodFor.length + card.notFor.length).toBeGreaterThan(10);
    }
  });

  it("the prompt lists every capability as a card, independent of what a catalog search returned", () => {
    const a = buildSystemPromptParts({ sanitizedCapabilities: [] });
    const b = buildSystemPromptParts({ sanitizedCapabilities: (APPROVED_CAPABILITY_CATALOG as any[]).slice(0, 2) });
    expect(a.capabilityText).toBe(b.capabilityText);
    for (const cap of APPROVED_CAPABILITY_CATALOG as any[]) expect(a.capabilityText).toContain(`[${cap.slug}]`);
    // the provider-facing language rules are in the cards: English country and titles, ISO codes, no copied sentence
    expect(a.capabilityText).toContain("Egypt وليس مصر");
    expect(a.capabilityText).toContain("Director");
    expect(a.capabilityText).toContain("ولا تنسخ جملة العميل");
  });

  it("a capability seeded later that has no card is still listed (the list is never shortened)", () => {
    const text = renderCapabilityCards([{ slug: "brand-new-service", platform: "web", nameAr: "خدمة جديدة", paramsSchema: JSON.stringify({ properties: { topic: { type: "string" } } }), maxRows: 40 }]);
    expect(text).toContain("[brand-new-service] خدمة جديدة (web) مدخلات: topic حتى 40 سجل");
  });
});

describe("2. the structured intent of each request", () => {
  it("«عايز شركتين كهرباء في مصر»: companies, electricity, Egypt, two (the dual noun is a number)", () => {
    const i = extractRequestIntent(COMPANIES);
    expect(i).toMatchObject({ dataType: "companies", count: 2, country: { english: "Egypt", iso: "EG" } });
    expect(i.industry?.taxonomy).toEqual(["Electrical/Electronic Manufacturing", "Utilities"]);
    expect(i.industry?.keywordsEn).toEqual(["electrical", "electricity", "electrical engineering"]);
    expect(missingInputsForIntent(i, COMPANIES)).toEqual([]);
  });

  it("the decision-makers request: people, English title, English energy keywords, Saudi Arabia, three, email and phone", () => {
    const i = extractRequestIntent(PEOPLE);
    expect(i).toMatchObject({ dataType: "people", count: 3, roles: ["Director"], country: { english: "Saudi Arabia", iso: "SA" } });
    expect(i.industry?.keywordsEn).toEqual(["energy", "power", "utilities", "oil and gas"]);
    expect(i.contactFields.sort()).toEqual(["phone", "work_email"]);
  });

  it("TikTok comments, tweets and the studies request", () => {
    expect(extractRequestIntent(COMMENTS)).toMatchObject({ dataType: "comments", platform: "tiktok", topic: "كرة السلة", count: 10, discover: "keyword", country: { iso: "EG" }, contactFields: [], roles: [] });
    expect(extractRequestIntent(TWEETS)).toMatchObject({ dataType: "posts", platform: "x", topic: "كرة السلة", count: 10, country: null });
    expect(extractRequestIntent(STUDIES)).toMatchObject({ dataType: "studies", country: { iso: "DE" } });
  });

  it("spoken and word numbers, including the dual", () => {
    const cases: Array<[string, number]> = [
      ["عايز شركتين كهرباء في مصر", 2], ["ثلاث شركات اتصالات في مصر", 3], ["خمس شركات", 5], ["عشر شركات", 10], ["مديرين اتنين", 2],
      ["هات تغريدتين عن كرة السلة", 2], ["عايز تعليقين", 2], ["خمسين تغريدة", 50], ["مية شركة", 100], ["١٢ شركة", 12],
    ];
    for (const [text, expected] of cases) expect(extractNumberFromText(text), text).toBe(expected);
  });

  it("a size or founding-year constraint is not read as the count or as a people search, and is reported as unsupported", () => {
    const text = "عايز شركات أدوية في الأردن حجمها أكتر من ٥٠ موظف";
    const i = extractRequestIntent(text);
    expect(i.dataType).toBe("companies");
    expect(i.count).toBeNull();
    expect(i.unsupported).toEqual(["حجم الشركة أو عدد موظفيها"]);
    expect(missingInputsForIntent(i, text)).toEqual(["count"]);
    expect(unsupportedConstraintsNoteAr(i)).toContain("المصدر لا يستطيع التصفية حسب حجم الشركة");
    expect(unsupportedConstraintsNoteAr(extractRequestIntent(COMPANIES))).toBeNull();
  });

  it("missing inputs are named for ONE question: no country, no industry, no count", () => {
    expect(missingInputsForIntent(extractRequestIntent("عايز شركات كهرباء"), "عايز شركات كهرباء")).toEqual(["country", "count"]);
    expect(missingInputsForIntent(extractRequestIntent("عايز ٥ شركات في مصر"), "عايز ٥ شركات في مصر")).toContain("industry");
    expect(missingInputsForIntent(extractRequestIntent("٣ مديرين في السعودية"), "٣ مديرين في السعودية")).toContain("industry_or_company");
  });

  it("people parameters never carry the sentence, an Arabic title or Arabic keywords", () => {
    const i = extractRequestIntent(PEOPLE);
    const params = peopleParamsFromIntent(i, { q: PEOPLE, title: "مدير", country: "SA", keywords: "شركات الطاقة", company_domain: "" }, 3);
    expect(params).toEqual({ title: "Director", country: "SA", keywords: ["energy", "power", "utilities", "oil and gas"], limit: 3 });
    expect(hasArabic(params)).toBe(false);
  });
});

describe("9. the five requests produce the expected structured provider parameters (no model call needed)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const noModel = () => {
    const db = withPeopleSettlement(createChatDb());
    const handler = new ChatHandler(db as any);
    const calls = vi.fn(async () => { throw new Error("the model must not be called for a fully stated request"); });
    (handler as any).llm.executeTurn = calls;
    return { handler, db, calls };
  };
  const send = (handler: ChatHandler, message: string, conversationId?: string) =>
    handler.handleUserMessage({ userId: "u_intent", conversationId, message, userBalance: 5000 });

  it("«عايز شركتين كهرباء في مصر»: the company capability, two records, country in English, taxonomy and English keywords", async () => {
    const { handler, calls } = noModel();
    const r: any = await send(handler, COMPANIES);
    expect(r.outputType).toBe("propose_plan");
    expect(calls).not.toHaveBeenCalled();
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("icypeas-companies-search");
    expect(item.targetVolumeMax).toBe(2);
    expect(item.params.query.location).toEqual({ include: ["Egypt"] });
    expect(item.params.query.industry).toEqual({ include: ["Electrical/Electronic Manufacturing", "Utilities"] });
    expect(item.params.query.keyword).toEqual({ include: ["electrical", "electricity", "electrical engineering"] });
    expect(item.params.country).toBe("Egypt");
    expect(hasArabic(item.params.query)).toBe(false);
    expect(r.contentAr).toContain("ما ستستلمه:");
  });

  it("the decision-makers request: the people capability with an English title, English keywords, ISO country, three, and no copied sentence", async () => {
    // the suites run with the cap lowered to 600 (vitest.config.mts): three people cost 3 x 258 = 774, which that cap would cut to two
    vi.stubEnv("JOB_MAX_POINTS_CAP", "");
    const { handler, calls } = noModel();
    const r: any = await send(handler, PEOPLE);
    expect(r.outputType).toBe("propose_plan");
    expect(calls).not.toHaveBeenCalled();
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toMatch(/people/);
    expect(item.endpointId).toBe("treg.people.search");
    expect(item.targetVolumeMax).toBe(3);
    expect(item.params).toMatchObject({ title: "Director", country: "SA", keywords: ["energy", "power", "utilities", "oil and gas"], limit: 3 });
    expect(item.params).not.toHaveProperty("q");
    expect(hasArabic({ title: item.params.title, keywords: item.params.keywords })).toBe(false);
  });

  it("«١٠ كومنتس تيك توك عن كرة السلة في مصر»: TikTok comments, the subject as written, region EG, ten, and no period question", async () => {
    const { handler, calls } = noModel();
    const r: any = await send(handler, COMMENTS);
    expect(r.outputType).toBe("propose_plan");
    expect(calls).not.toHaveBeenCalled();
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-tiktok-comments");
    expect(item.targetVolumeMax).toBe(10);
    expect(item.params).toMatchObject({ query: "كرة السلة", region: "EG" });
    expect(JSON.stringify(item.params)).not.toMatch(/mail|phone|بريد|هاتف|إيميل/i);
  });

  it("«هات ١٠ تغريدات عن كرة السلة»: X posts, the subject, ten", async () => {
    const { handler, calls } = noModel();
    const r: any = await send(handler, TWEETS);
    expect(r.outputType).toBe("propose_plan");
    expect(calls).not.toHaveBeenCalled();
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-x-posts");
    expect(item.targetVolumeMax).toBe(10);
    expect(item.params.query).toBe("كرة السلة");
  });

  it("«اجمع ١٠ دراسات عن الطاقة الشمسية في ألمانيا»: no plan, no price, no question about social platforms, an honest answer", async () => {
    const { handler, calls } = noModel();
    const r: any = await send(handler, STUDIES);
    expect(r.outputType).toBe("answer_question");
    expect(calls).not.toHaveBeenCalled();
    expect(r.planQuote).toBeUndefined();
    expect(r.contentAr).toContain("غير متاح بعد");
    expect(r.contentAr).not.toMatch(/تيك توك أو|اختر المنصة|من أي مصدر/);
  });

  it("context hygiene in both orders: the people request and the TikTok request never carry each other's fields", async () => {
    for (const order of [[PEOPLE, COMMENTS], [COMMENTS, PEOPLE]]) {
      const { handler } = noModel();
      const first: any = await send(handler, order[0]);
      const second: any = await send(handler, order[1], first.conversationId);
      const byText = (text: string) => (order[0] === text ? first : second);
      const people = byText(PEOPLE).planQuote.items[0];
      const comments = byText(COMMENTS).planQuote.items[0];
      expect(people.params).toMatchObject({ title: "Director", country: "SA" });
      expect(comments.params).toMatchObject({ query: "كرة السلة", region: "EG" });
      expect(JSON.stringify(comments.params)).not.toMatch(/mail|phone|requiredContactFields|مدير|طاقة/i);
      expect(JSON.stringify(people.params)).not.toMatch(/تيك|كرة|سلة/);
    }
  });
});

describe("the model path is canonicalised too", () => {
  it("a model plan that copies the sentence and writes an Arabic title is rebuilt from the intent before pricing", async () => {
    const db = withPeopleSettlement(createChatDb());
    const handler = new ChatHandler(db as any);
    handler.deterministicPlanning = false;
    (handler as any).llm.executeTurn = vi.fn(async () => ({
      output: {
        type: "propose_plan", summaryAr: "خطة", outputFormats: ["xlsx"],
        capabilities: [{ stepId: "step_1", capabilitySlug: "professional-people-search", endpointId: "treg.people.search", targetVolumeMin: 1, targetVolumeMax: 3, paginationStrategy: "none", params: { q: PEOPLE, title: "مدير", country: "SA", keywords: "شركات الطاقة", company_domain: "" } }],
      },
      inputTokens: 500, outputTokens: 80, costUsd: 0.0006, model: "claude-haiku-5-5", promptVersion: "t",
    }));
    const r: any = await handler.handleUserMessage({ userId: "u_model", message: PEOPLE, userBalance: 5000 });
    expect(r.outputType).toBe("propose_plan");
    const params = r.planQuote.items[0].params;
    expect(params).toMatchObject({ title: "Director", country: "SA", keywords: ["energy", "power", "utilities", "oil and gas"], limit: 3 });
    expect(params).not.toHaveProperty("q");
    expect(params).not.toHaveProperty("company_domain");
  });
});
