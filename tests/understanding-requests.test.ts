import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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

  it("puts the full structured capability guide in each model prompt independently of catalog search results", () => {
    const prompt = buildSystemPrompt({ sanitizedCapabilities: [] });
    expect(prompt).toContain("FULL DIGER PLATFORM GUIDE");
    // The services are structured capability cards now: each names its inputs and carries request-to-parameter examples.
    expect(prompt).toContain("كومنتس تيك توك");
    expect(prompt).toContain("social-x-posts");
    expect(prompt).toContain("query=الموضوع");
    // Studies, papers and news from websites are NOT a service; the prompt says so instead of advertising one.
    expect(prompt).not.toContain("بحث موضوعي ومواد إخبارية وأكاديمية");
    expect(prompt).toContain("غير متاح بعد");
    expect(prompt).toContain("اعتبر كل خدمة مدرجة ضمن قدرات ديجر");
    expect(prompt).not.toMatch(/firecrawl|context\.dev|treg\.people\.search/i);
    // 10 services: the one that never had an executable capability (studies, papers, news) was removed on purpose.
    expect(buildPlatformGuideServices().length).toBeGreaterThanOrEqual(10);
    expect(PLATFORM_GUIDE.futureSources.every((source) => source.statusAr === "قريباً")).toBe(true);
  });
});
