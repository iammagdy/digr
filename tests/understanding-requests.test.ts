import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyBeforeGuide, classifyUnderstandingRequest } from "../src/functions/shared/understandingRequests";
import { buildPlatformGuideServices, PLATFORM_GUIDE } from "../src/functions/shared/platformGuide";
import { buildSystemPrompt } from "../src/functions/shared/systemPrompt";

type Case = { id: string; category: string; request: string; expectedCapability: string; expectedMissingInputs: string[] };
const requests = JSON.parse(readFileSync("tests/fixtures/understanding-requests.json", "utf8")) as Case[];

describe("structured platform guide and offline request set", () => {
  it("covers 40 diverse Egyptian Arabic requests with capability and missing-input expectations", () => {
    expect(requests).toHaveLength(40);
    expect(new Set(requests.map((request) => request.category)).size).toBeGreaterThanOrEqual(10);
    expect(requests.every((request) => request.expectedCapability && Array.isArray(request.expectedMissingInputs))).toBe(true);
  });

  it("classifies every fixture and its missing inputs using the structured guide", () => {
    const failures = requests.flatMap((request) => {
      const actual = classifyUnderstandingRequest(request.request);
      return actual.capability === request.expectedCapability &&
        JSON.stringify([...actual.missingInputs].sort()) === JSON.stringify([...request.expectedMissingInputs].sort())
        ? [] : [{ id: request.id, expected: request.expectedCapability, actual: actual.capability, missing: actual.missingInputs }];
    });
    expect(failures).toEqual([]);
  });

  it("the baseline proxy records earlier routing gaps on the same requests", () => {
    const baselineFailures = requests.filter((request) => {
      const actual = classifyBeforeGuide(request.request);
      return actual.capability !== request.expectedCapability ||
        JSON.stringify([...actual.missingInputs].sort()) !== JSON.stringify([...request.expectedMissingInputs].sort());
    });
    expect(baselineFailures.length).toBeGreaterThan(0);
  });

  it("keeps the exact decision-maker request and variants on the people capability", () => {
    for (const text of [
      "أنا عايز تلاتة صناع قرار في شركات الكهرباء والميكانيكا في مصر.",
      "محتاج ٥ مديرين في شركات الطاقة في السعودية",
      "هات decision makers في software companies في Germany",
    ]) {
      expect(classifyUnderstandingRequest(text).capability).toBe("decision_makers");
    }
  });

  it("puts the full structured capability guide in each model prompt independently of catalog search results", () => {
    const prompt = buildSystemPrompt({ sanitizedCapabilities: [] });
    expect(prompt).toContain("FULL DIGER PLATFORM GUIDE");
    expect(prompt).toContain("كومنتس على فيديو تيك توك");
    expect(prompt).toContain("بحث موضوعي ومواد إخبارية وأكاديمية");
    expect(prompt).toContain("social-x-posts");
    expect(prompt).toContain("topic_or_account_handle");
    expect(prompt).toContain("اعتبر كل خدمة مدرجة ضمن قدرات ديجر");
    expect(prompt).not.toMatch(/firecrawl|context\.dev|treg\.people\.search/i);
    expect(buildPlatformGuideServices().length).toBeGreaterThan(10);
    expect(PLATFORM_GUIDE.futureSources.every((source) => source.statusAr === "قريباً")).toBe(true);
  });
});
