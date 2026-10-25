import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: any) => createElement("a", { href, ...rest }, children) }));

import PricingPage from "../src/app/pricing/page";
import SegmentPage from "../src/app/for/[segment]/page";
import { DemoConversations, Faq, ProductLines, SampleFile, Sheets, Statements } from "../src/components/landing/Sections";
import { PriceStrip } from "../src/components/landing/Overview";
import { FAQS } from "../src/components/landing/landingFaq";
import { SEGMENTS, segmentPeopleLineAr } from "../src/lib/segments";
import { buildLandingDemos } from "../src/lib/landingDemos";
import { DEFAULT_JOB_POINTS_CAP } from "../src/lib/calculatorPricing";
import { DECISION_MAKER_UNIT_PRICES_POINTS } from "../src/functions/shared/decisionMakerPricing";
import { DEFAULT_PRICING_SETTINGS } from "../src/functions/shared/quotes";
import { decisionMakersPerRequestLineAr, peopleCountAr, recordsInOneJob } from "../src/lib/jobSizing";
import { decisionMakersPerRequest, decisionMakersPerRequestLine, estimateMission } from "../src/lib/missionEstimate";
import { understandMission } from "../src/lib/consultantCopy";

/**
 * D5: every public decision-makers example says in ONE plain sentence what one request holds, and the number is the shared sizing
 * function's (never typed by hand). D6: no visible Latin file extension on a public page, and no Latin sample channel handle.
 */
const person = DECISION_MAKER_UNIT_PRICES_POINTS.basePerson + DECISION_MAKER_UNIT_PRICES_POINTS.workEmail + DECISION_MAKER_UNIT_PRICES_POINTS.phone;
const SIZING_NUMBER = recordsInOneJob({ unitPricePoints: person, capPoints: DEFAULT_JOB_POINTS_CAP, safetyBuffer: DEFAULT_PRICING_SETTINGS.safetyBuffer, chargeCapped: true });
const SENTENCE = `الطلب الواحد يتسع حتى ${peopleCountAr(SIZING_NUMBER)}؛ ويمكنك تقديم أكثر من طلب.`;
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("D5: the sentence and its number", () => {
  it("is built from the shared sizing function: three decision makers today, in the owner's own wording", () => {
    expect(SIZING_NUMBER).toBe(3);
    expect(decisionMakersPerRequest()).toBe(SIZING_NUMBER);
    expect(decisionMakersPerRequestLine()).toBe(SENTENCE);
    expect(SENTENCE).toBe("الطلب الواحد يتسع حتى ٣ صناع قرار؛ ويمكنك تقديم أكثر من طلب.");
  });

  it("follows the sizing function when the limit moves (the live daily limit lowers it), and never states a zero as a promise", () => {
    expect(decisionMakersPerRequest({ dailyCapPoints: 400 })).toBe(Math.floor(400 / person));
    expect(decisionMakersPerRequestLine({ dailyCapPoints: 400 })).toBe("الطلب الواحد يتسع حتى صانعي قرار؛ ويمكنك تقديم أكثر من طلب.");
    expect(decisionMakersPerRequestLine({ dailyCapPoints: 200 })).toBe("الطلب الواحد يتسع حتى صانع قرار واحد؛ ويمكنك تقديم أكثر من طلب.");
    expect(decisionMakersPerRequestLine({ dailyCapPoints: 100 })).not.toContain("يتسع حتى");
    expect(decisionMakersPerRequestLineAr(0)).not.toMatch(/[0-9]/);
    // fewer contact fields cost less per person, so one request holds more people
    expect(decisionMakersPerRequest({ contactFields: ["work_email"] })).toBeGreaterThan(SIZING_NUMBER);
  });

  it("people in correct Arabic", () => {
    expect([1, 2, 3, 10, 11].map(peopleCountAr)).toEqual(["صانع قرار واحد", "صانعي قرار", "٣ صناع قرار", "١٠ صناع قرار", "١١ صانع قرار"]);
  });

  it("the public estimate's own one-job size is the same number", () => {
    const result = estimateMission({ kind: "people", volume: 10 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(decisionMakersPerRequestLineAr(result.maxVolumeInOneJob)).toBe(SENTENCE);
  });

  it("the pages do not type the number by hand", () => {
    for (const file of ["src/app/pricing/page.tsx", "src/app/for/[segment]/page.tsx", "src/app/calculator/page.tsx", "src/components/calculator/MissionEstimator.tsx", "src/lib/segments.ts", "src/lib/pricingPage.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/يتسع حتى\s*[٠-٩0-9]/);
      expect(source, file).not.toMatch(/[٠-٩0-9]\s*صنّ?اع\s*قرار/);
    }
  });
});

describe("D5: where it appears", () => {
  const pricing = renderToStaticMarkup(createElement(PricingPage));

  it("the pricing page states it under the capacity table and under the price table", () => {
    expect((pricing.match(/data-testid="people-per-request-capacity"/g) || []).length).toBe(1);
    expect((pricing.match(/data-testid="people-per-request-price"/g) || []).length).toBe(1);
    expect(textOf(pricing).split(SENTENCE).length - 1).toBe(2);
    expect(textOf(pricing)).not.toMatch(/[0-9]/);
  });

  it("the sales segment (which speaks of decision makers) states it; the others do not", async () => {
    for (const segment of SEGMENTS) {
      const html = renderToStaticMarkup(await SegmentPage({ params: Promise.resolve({ segment: segment.slug }) }));
      const expected = segmentPeopleLineAr(segment);
      if (segment.slug === "sales-teams") {
        expect(expected).toBe(SENTENCE);
        expect(html).toContain('data-testid="people-per-request"');
        expect(textOf(html)).toContain(SENTENCE);
      } else {
        expect(expected).toBeNull();
        expect(html).not.toContain('data-testid="people-per-request"');
      }
    }
  });

  it("the calculator: the estimate form and the per-service list both read the sizing function", () => {
    const estimator = readFileSync("src/components/calculator/MissionEstimator.tsx", "utf8");
    expect(estimator).toContain("decisionMakersPerRequestLineAr(result.maxVolumeInOneJob)");
    const page = readFileSync("src/app/calculator/page.tsx", "utf8");
    expect(page).toContain("decisionMakersPerRequestLineAr(recordsInOneJob(");
    expect(page).toContain('breakdown.capabilitySlug === "professional-people-search"');
  });
});

describe("D6: no Latin file extension and no Latin sample handle on a public page", () => {
  it("the landing sections show Arabic file names only", () => {
    const sections = [Statements, Sheets, SampleFile, ProductLines, DemoConversations, PriceStrip].map((component) => textOf(renderToStaticMarkup(createElement(component as any)))).concat(textOf(renderToStaticMarkup(createElement(Faq, { items: FAQS }))));
    for (const text of sections) {
      expect(text).not.toMatch(/\.(?:csv|pdf|xlsx|xls|docx?)\b/i);
      expect(text).not.toMatch(/\b(?:csv|xlsx|pdf)\b/i);
    }
    const sheets = textOf(renderToStaticMarkup(createElement(Sheets)));
    expect(sheets).toContain("ثلاثة ملفات");
  });

  it("the pricing and segment pages show none either", async () => {
    const pages = [textOf(renderToStaticMarkup(createElement(PricingPage)))];
    for (const segment of SEGMENTS) pages.push(textOf(renderToStaticMarkup(await SegmentPage({ params: Promise.resolve({ segment: segment.slug }) }))));
    for (const text of pages) {
      expect(text).not.toMatch(/\.(?:csv|pdf|xlsx)\b/i);
      expect(text).not.toMatch(/@\s*AlArabiya|AlArabiya/i);
    }
  });

  it("the data that feeds those pages has no sample handle: the demo channel is an Arabic name, still read as the channel", () => {
    for (const file of ["src/lib/landingDemos.ts", "src/lib/segments.ts", "src/components/landing/data.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/AlArabiya/i);
      expect(source, file).not.toMatch(/ext:\s*"\./);
    }
    const youtubeDemo = buildLandingDemos().find((demo) => demo.id === "youtube-comments")!;
    expect(youtubeDemo.requestAr).toContain("قناة العربية");
    expect(youtubeDemo.requestAr).not.toMatch(/[A-Za-z@]/);
    expect(youtubeDemo.understoodAr).toContain("قناة العربية");
    for (const segment of SEGMENTS) expect(segment.exampleRequestAr).not.toMatch(/@[A-Za-z]/);
    const agency = SEGMENTS.find((segment) => segment.slug === "marketing-agencies")!;
    expect(understandMission(agency.exampleRequestAr).channels.named).toEqual(["العربية"]);
  });
});
