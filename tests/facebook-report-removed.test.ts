import { describe, expect, it, vi } from "vitest";

/**
 * THE REMOVED FACEBOOK TOPIC REPORT (DT-20261126-wl4-ph1b): it was never offered to a customer (the owner had reviewed no Page), and its code is gone. These are the checks the old gate
 * test made about everything else, kept as they were: no report service exists, and a request that used to be a report candidate is planned and asked exactly as before.
 */
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { createChatDb } from "./helpers/chatSession";
import { SOCIAL_CAPABILITIES, getSocialCapability } from "../src/lib/socialSources";
import { getPublicCalculatorOptions } from "../src/lib/calculatorPricing";
import { detectSocialIntent } from "../src/lib/socialTasks";
import { SOCIAL_CONTENT_WORDS_RE } from "../src/lib/socialDiscovery";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";

const FACEBOOK_REPORT_SLUG = "facebook-topic-report";

describe("no report service exists for customers", () => {
  it("it is not a service, not in the calculator, not in the approved catalog, and the report words are not a report request", () => {
    expect(SOCIAL_CAPABILITIES.map((cap) => cap.slug)).not.toContain(FACEBOOK_REPORT_SLUG);
    expect(getSocialCapability(FACEBOOK_REPORT_SLUG)).toBeUndefined();
    expect(getPublicCalculatorOptions().map((option) => option.slug)).not.toContain(FACEBOOK_REPORT_SLUG);
    expect(APPROVED_CAPABILITY_CATALOG.map((capability) => capability.slug)).not.toContain(FACEBOOK_REPORT_SLUG);
    for (const text of ["عايز تقرير عن الترندات الصحية على فيسبوك في مصر", "تحليل ورصد منشورات فيسبوك عن الصحة في مصر", "تقرير عن الترندات الصحية على فيسبوك آخر ٣ شهور"]) {
      expect((detectSocialIntent(text) as any).report, text).toBeUndefined();
    }
    // «تقرير» alone says nothing about social content, as before
    expect(SOCIAL_CONTENT_WORDS_RE.test("تقرير عن شركة على فيسبوك")).toBe(false);
  });
});

describe("a request that would have matched the report is planned and asked as on main (checked against main's own answers)", () => {
  async function ask(message: string) {
    setProviderBalanceForTesting(50);
    const db: any = createChatDb();
    const handler = new ChatHandler(db);
    const executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); });
    (handler as any).llm.executeTurn = executeTurn;
    await db.createRow({ tableId: "conversations", rowId: "conv_gate", data: { userId: "user_gate", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    clearBriefCacheForTesting();
    vi.stubEnv("JOB_MAX_POINTS_CAP", "");
    // a request main sends to the general path asks the (fake) model, which here throws: that IS the fall-through, so it is reported, not hidden
    const r: any = await handler.handleUserMessage({ userId: "user_gate", conversationId: "conv_gate", message, userBalance: 40_000 }).catch((error: Error) => ({ outputType: "model_path", contentAr: String(error.message), modelAsked: true }));
    return r;
  }
  const REPORT_ONLY = /social_report_country_required|report_not_covered|تقرير فيسبوك الكامل|لأي دولة تريد التقرير|ملف بي دي إف منفصل للمنهجية|facebook-topic-report/;
  const cleanUp = () => { vi.unstubAllEnvs(); resetProviderBalanceCacheForTesting(); };

  it("«عايز تقرير عن الترندات الصحية على فيسبوك في مصر آخر ٣ شهور ١٠٠ منشور بـ ٢٠ تعليق لكل منشور» is planned by the keyword service exactly as on main (same item, same volume), never as a report", async () => {
    const r = await ask("عايز تقرير عن الترندات الصحية على فيسبوك في مصر آخر ٣ شهور ١٠٠ منشور بـ ٢٠ تعليق لكل منشور");
    cleanUp();
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items.map((i: any) => [i.capabilitySlug, i.targetVolumeMax])).toEqual([["social-facebook-keyword-comments", 1500]]);
    expect(JSON.stringify([r.contentAr, r.planQuote])).not.toMatch(REPORT_ONLY);
    expect(r.planQuote.outputFormats ?? r.planQuote.plan?.outputFormats ?? ["xlsx"]).not.toContain("pdf");
  });
  it("«عايز تقرير عن الترندات الصحية على فيسبوك» asks the period as before (not the country), and no report question exists", async () => {
    const r = await ask("عايز تقرير عن الترندات الصحية على فيسبوك");
    cleanUp();
    expect(r.outputType).toBe("ask_clarification");
    expect(r.clarificationItems.map((q: any) => q.id)).toEqual(["social_time_required"]);
    expect(JSON.stringify(r)).not.toMatch(REPORT_ONLY);
  });
  it("a report on an uncovered topic or country is not refused with the report's «not covered» message (there is no report), and the plain keyword request is untouched", async () => {
    for (const message of ["عايز تقرير عن سوق السيارات على فيسبوك في مصر آخر ٣ شهور", "عايز تقرير عن الترندات الصحية على فيسبوك في السعودية آخر شهر ٥٠ منشور بـ ٥ تعليقات لكل منشور", "عايز ٥٠ بوست وتعليقاتهم عن الترندات الصحية على فيسبوك في مصر"]) {
      const r = await ask(message);
      expect(JSON.stringify(r), message).not.toMatch(REPORT_ONLY);
      expect(r.planQuote?.items?.map((i: any) => i.capabilitySlug) ?? []).not.toContain(FACEBOOK_REPORT_SLUG);
    }
    cleanUp();
    const keyword = await ask("عايز ٣٠٠ منشور على فيسبوك عن الترندات الصحية مع ٥ تعليقات لكل منشور في مصر");
    cleanUp();
    expect(keyword.planQuote.items.map((i: any) => [i.capabilitySlug, i.targetVolumeMax, i.unitPricePoints])).toEqual([["social-facebook-keyword-comments", 1500, 12.925]]);
  });
});
