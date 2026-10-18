import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/functions/shared/peopleSettlementReadiness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/peopleSettlementReadiness")>()),
  requirePeopleSettlementRpc: async () => true,
}));
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/functions/shared/catalogClient")>();
  return {
    ...actual,
    getEndpointDetails: vi.fn(async (endpointId: string) => {
      const prices: Record<string, number> = { "treg.people.search": 0.015, "treg.people.email.find": 0.01, "treg.people.phone.find": 0.01 };
      return prices[endpointId] ? { catalogPriceUsd: prices[endpointId] } : null;
    }),
  };
});

import { clearBriefCacheForTesting, extractBriefFromMessage, getConversationBrief } from "../src/functions/shared/briefManager";
import {
  dropGreetingAndIdentityTurns, isGreetingOrIdentityTurn, isStandaloneResearchRequest, scopeRequestText,
} from "../src/functions/shared/requestScope";
import { runConversation } from "./helpers/chatSession";

const GREETING = "مساء الخير";
const IDENTITY = "إنت مين؟";
const PEOPLE = "٣ مديرين في شركات الطاقة في السعودية مع إيميلاتهم وأرقامهم";
const TIKTOK = "١٠ كومنتس تيك توك عن كرة السلة في مصر خلال آخر شهر";

beforeEach(() => clearBriefCacheForTesting());

describe("1. each research request is read from its own message", () => {
  it("recognises independent requests and not greetings, identity questions or fragments", () => {
    expect(isStandaloneResearchRequest(PEOPLE)).toBe(true);
    expect(isStandaloneResearchRequest(TIKTOK)).toBe(true);
    expect(isStandaloneResearchRequest("هات ١٠ تغريدات عن كرة السلة")).toBe(true);
    expect(isStandaloneResearchRequest("اجمع ١٠ دراسات عن الطاقة الشمسية في ألمانيا")).toBe(true);
    for (const fragment of [GREETING, IDENTITY, "السعودية", "١٠٠ شركة", "ابدأ", "آخر شهر", "غيّر العدد في الخطة إلى ٢٠ تعليق", '{"type":"clarification_answers","answers":[]}']) {
      expect(isStandaloneResearchRequest(fragment), fragment).toBe(false);
    }
    expect(isGreetingOrIdentityTurn(IDENTITY)).toBe(true);
  });

  it("the exact sequence: the TikTok request never sees the earlier people request, greeting or identity question", () => {
    const text = scopeRequestText([GREETING, IDENTITY, PEOPLE], TIKTOK);
    expect(text).toBe(TIKTOK);
    for (const leaked of ["مساء الخير", "إنت مين", "مديرين", "السعودية", "إيميلاتهم", "أرقامهم"]) expect(text).not.toContain(leaked);
  });

  it("the opposite order: the people request never sees the TikTok request", () => {
    const text = scopeRequestText([TIKTOK], PEOPLE);
    expect(text).toBe(PEOPLE);
    for (const leaked of ["تيك توك", "كومنتس", "كرة السلة", "مصر"]) expect(text).not.toContain(leaked);
  });

  it("a short follow-up only fills what is missing: it joins the request it answers, skipping greetings", () => {
    const text = scopeRequestText([GREETING, "عايز شركات طاقة في السعودية", IDENTITY], "١٠٠ شركة");
    expect(text).toContain("شركات طاقة في السعودية");
    expect(text).toContain("١٠٠ شركة");
    expect(text).not.toContain("مساء الخير");
    expect(text).not.toContain("إنت مين");
    // the chain stops at the nearest independent request: an older one is not pulled in
    const chained = scopeRequestText([PEOPLE, TIKTOK], "ابدأ");
    expect(chained).toContain("تيك توك");
    expect(chained).not.toContain("مديرين");
  });

  it("an independent request never overrides its own country or topic with an older one", () => {
    const text = scopeRequestText(["١٠ شركات سياحة في الإمارات"], "٥ شركات تقنية في مصر");
    expect(text).toBe("٥ شركات تقنية في مصر");
  });

  it("the brief starts clean for an independent request and never keeps greeting or identity words", () => {
    let brief = extractBriefFromMessage(GREETING);
    brief = extractBriefFromMessage(IDENTITY, brief);
    brief = extractBriefFromMessage(PEOPLE, brief);
    brief = extractBriefFromMessage(TIKTOK, brief);
    expect(brief.platforms).toEqual(["tiktok"]);
    const joined = [...brief.topics, ...(brief.keywords || [])].join(" ");
    for (const leaked of ["مساء", "الخير", "إنت", "مين", "مديرين", "السعودية", "إيميلاتهم", "الطاقة"]) expect(joined).not.toContain(leaked);
    expect(joined).toContain("كرة");
    expect(joined).not.toContain("خلال");
    expect(brief.targetVolume).toBe(10);
  });

  it("the brief of the people request does not inherit the TikTok request either", () => {
    let brief = extractBriefFromMessage(TIKTOK);
    brief = extractBriefFromMessage(PEOPLE, brief);
    expect(brief.platforms).not.toContain("tiktok");
    expect([...brief.topics, ...(brief.keywords || [])].join(" ")).not.toContain("كرة");
  });

  it("history shown to the model leaves out greeting and identity turns and their replies", () => {
    const history = [
      { role: "user", content: GREETING }, { role: "assistant", content: "أهلًا" },
      { role: "user", content: IDENTITY }, { role: "assistant", content: "أنا ديجر الذكي" },
      { role: "user", content: PEOPLE }, { role: "assistant", content: "خطة" },
    ];
    expect(dropGreetingAndIdentityTurns(history).map((m) => m.content)).toEqual([PEOPLE, "خطة"]);
  });
});

describe("1. the full chat, with the exact sequence", () => {
  const forbidden = ["مساء الخير", "إنت مين", "مديرين", "السعودية", "بريد العمل", "هاتف المكتب", "البريد المهني"];

  it("the TikTok plan has Egypt, the basketball topic and no people wording", async () => {
    const { responses } = await runConversation([GREETING, IDENTITY, PEOPLE, TIKTOK]);
    const plan = responses[3];
    expect(plan.outputType).toBe("propose_plan");
    const item = plan.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-tiktok-comments");
    expect(item.params.region).toBe("EG");
    expect(item.params.query).toBe("كرة السلة");
    expect(item.targetVolumeMax).toBe(10);
    const shown = `${plan.contentAr}\n${plan.planQuote.summaryAr}\n${JSON.stringify(plan.planQuote.items)}`;
    for (const word of forbidden) expect(shown, word).not.toContain(word);
  });

  it("persists a brief that belongs only to the latest request", async () => {
    const { db } = await runConversation([GREETING, IDENTITY, PEOPLE, TIKTOK]);
    const brief = await getConversationBrief(db as any, "conv_scope_test");
    expect(brief.platforms).toEqual(["tiktok"]);
    const joined = [...brief.topics, ...(brief.keywords || [])].join(" ");
    for (const word of ["مساء", "إنت", "مين", "مديرين", "السعودية", "إيميلاتهم"]) expect(joined, word).not.toContain(word);
  });

  it("the opposite order: the people request after TikTok carries no TikTok topic, platform or country", async () => {
    const { responses, db } = await runConversation([TIKTOK, GREETING, IDENTITY, PEOPLE]);
    const people = responses[3];
    const shown = `${people.contentAr || ""}\n${JSON.stringify(people.planQuote?.items || [])}`;
    for (const word of ["تيك توك", "كرة السلة", "كومنتس", "social-tiktok"]) expect(shown, word).not.toContain(word);
    const brief = await getConversationBrief(db as any, "conv_scope_test");
    expect(brief.platforms).not.toContain("tiktok");
    expect([...brief.topics, ...(brief.keywords || [])].join(" ")).not.toContain("كرة");
  });
});
