import { sampleTargetPoints } from "../src/lib/sampleFirst";
import { toArabicDigits } from "../src/lib/arabicDigits";
import { describe, expect, it } from "vitest";
import { planExplanationLinesAr, recordNounAr, formatsAr } from "../src/lib/planExplanation";
import { runConversation } from "./helpers/chatSession";

/**
 * C. Better planning: the plan card carries code-written lines (what will be delivered, the cost range, the proposed
 * sample size when no count was given), at most ONE question is asked per turn, large requests are offered the priced
 * exploration step, and each research request is read from its own message.
 */
describe("C. plan explanation lines", () => {
  const input = { capabilitySlug: "social-x-posts", outputFormats: ["xlsx"], targetVolumeMax: 10, unitPricePoints: 6, expectedPoints: 60, quotedPoints: 69, countStated: true };

  it("says what will be delivered, the cost range and that undelivered rows are not charged", () => {
    const lines = planExplanationLinesAr(input);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ملف إكسل");
    expect(lines[0]).toContain("حتى ١٠ تغريدات");
    expect(lines[0]).toContain("ورقة مراجعة منفصلة ولا يُحتسب عليك");
    expect(lines[1]).toContain("من ٦ نقطة");
    expect(lines[1]).toContain("إلى ٦٠ نقطة");
    expect(lines[1]).toContain("٦٩ نقطة");
    expect(lines[1]).toContain("لا يُخصم إلا ما يُسلَّم فعلًا");
  });

  it("proposes the sample size only when the customer gave no count", () => {
    const withoutCount = planExplanationLinesAr({ ...input, countStated: false });
    expect(withoutCount).toHaveLength(3);
    expect(withoutCount[2]).toContain("لم تحدد عددًا، فاقترحت عينة من ١٠");
    expect(withoutCount[2]).toContain("قبل الموافقة");
  });

  it("every line is Arabic only: Arabic-Indic digits, no Latin letters, no provider name, no emoji", () => {
    for (const slug of ["icypeas-companies-search", "professional-people-search", "social-tiktok-comments", "social-youtube-videos", "social-x-posts"]) {
      for (const countStated of [true, false]) {
        const text = planExplanationLinesAr({ ...input, capabilitySlug: slug, outputFormats: ["xlsx", "csv", "pdf"], countStated }).join("\n");
        expect(text).not.toMatch(/[A-Za-z]/);
        expect(text).not.toMatch(/[0-9]/);
        expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });

  it("the record noun follows the service and the formats are named in Arabic", () => {
    expect(recordNounAr("icypeas-companies-search")).toBe("شركة");
    expect(recordNounAr("professional-people-search")).toBe("شخص");
    expect(recordNounAr("social-tiktok-comments")).toBe("تعليق");
    expect(recordNounAr("social-youtube-videos")).toBe("فيديو");
    expect(recordNounAr("social-x-posts")).toBe("منشور");
    expect(formatsAr(["xlsx", "pdf"])).toBe("إكسل وبي دي إف");
    expect(formatsAr([])).toBe("إكسل");
  });
});

describe("C. in the conversation", () => {
  it("a plan for a stated count explains what is delivered and the cost range, and asks nothing", async () => {
    const { responses } = await runConversation(["هات ١٠ تغريدات عن كرة السلة في ٢٠٢٥"]);
    const r = responses[0];
    expect(r.outputType).toBe("propose_plan");
    expect(r.contentAr).toContain("ما ستستلمه:");
    expect(r.contentAr).toContain("نطاق التكلفة:");
    expect(r.contentAr).not.toContain("لم تحدد عددًا");
    expect(String(r.contentAr).match(/؟/g) ?? []).toHaveLength(0);
  });

  it("a large request is offered the priced exploration step", async () => {
    // 500 companies are 1,584 points of charge: over the 1,500 that earns a sample offer (a social request cannot reach it any more: 500 posts are 59 points)
    const { responses } = await runConversation(["عايز ٥٠٠ شركة كهرباء في مصر"]);
    const r = responses[0];
    expect(r.outputType).toBe("propose_plan");
    // «عينة أولًا»: the target is about 5% of the estimate, held between 100 and 300 points; the sample holds the most whole records whose reserve fits it
    const offer = r.planQuote.explorationOffer;
    const target = sampleTargetPoints(offer.fullEstimatePoints);
    expect(target).toBeGreaterThanOrEqual(100);
    expect(target).toBeLessThanOrEqual(300);
    expect(offer.samplePoints).toBeLessThanOrEqual(target);
    expect(offer.samplePoints + r.planQuote.unitPricePoints * 1.15 + 1).toBeGreaterThan(target);
    expect(r.contentAr).toContain("عينة أولًا");
    expect(r.contentAr).toContain(`${toArabicDigits(offer.sampleUnits)} سجل فقط بحجز ${toArabicDigits(offer.samplePoints)} نقطة`);
  });

  it("an unclear request gets at most ONE question, never a questionnaire", async () => {
    for (const text of ["عايز بيانات", "محتاج أبحث عن حاجة", "اجمع لي معلومات عن السوق"]) {
      const { responses } = await runConversation([text]);
      const r = responses[0];
      const questions = r.clarificationItems ?? r.clarificationQuestions ?? r.questions ?? [];
      expect(questions.length, text).toBeLessThanOrEqual(1);
    }
  });

  it("each research request is read from its own message first: the second request's plan never carries the first one's topic", async () => {
    const { responses } = await runConversation(["هات ١٠ تغريدات عن كرة السلة", "هات ١٠ تعليقات تيك توك عن الذهب في مصر"]);
    const second = responses[1];
    expect(second.contentAr).not.toContain("كرة السلة");
  });
});
