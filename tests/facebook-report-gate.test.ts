import { describe, expect, it, vi } from "vitest";

/**
 * THE GATE: the Facebook topic report is offered, planned and priced to customers only when the owner has reviewed at least one usable Page (`ownerReviewed: true` on a
 * registry entry whose status is `ok`; all are false when this was written). With the gate off the capability does not exist for the rest of the platform and every request
 * behaves exactly as before the report was added. Turning it on is one line in the registry.
 *
 * This file forces the gate OFF for the chat tests (whatever the registry holds later); the report's own tests (facebook-report-chat, -worker) force it ON. The last block reads the
 * shipped registry and checks that the gate is exactly «some entry is reviewed and usable», whichever way it stands.
 */
vi.mock("../src/lib/facebookReport/registry", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/facebookReport/registry")>()), FACEBOOK_REPORT_ENABLED: false }));

import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { createChatDb } from "./helpers/chatSession";
import { SOCIAL_CAPABILITIES, getSocialCapability } from "../src/lib/socialSources";
import { getPublicCalculatorOptions } from "../src/lib/calculatorPricing";
import { detectSocialIntent, REPORT_WORDS_RE } from "../src/lib/socialTasks";
import { SOCIAL_CONTENT_WORDS_RE } from "../src/lib/socialDiscovery";
import { FACEBOOK_PAGE_REGISTRY, reportEnabledFor, type FacebookPageEntry } from "../src/lib/facebookReport/registry";
import * as realRegistry from "../src/lib/facebookReport/registry";
import { FACEBOOK_REPORT_SLUG } from "../src/lib/facebookReport/constants";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";

const entry = (over: Partial<FacebookPageEntry> = {}): FacebookPageEntry => ({ ...FACEBOOK_PAGE_REGISTRY[0], ownerReviewed: false, status: "ok", ...over });

describe("the gate itself: at least one reviewed, usable Page", () => {
  it("no reviewed Page: off; one reviewed and usable Page: on; a reviewed Page that is not usable does not count", () => {
    expect(reportEnabledFor([])).toBe(false);
    expect(reportEnabledFor([entry(), entry({ id: "b" })])).toBe(false);
    expect(reportEnabledFor([entry(), entry({ id: "b", ownerReviewed: true })])).toBe(true);
    expect(reportEnabledFor([entry({ ownerReviewed: true, status: "invalid" })])).toBe(false);
    expect(reportEnabledFor([entry({ ownerReviewed: true, status: "not_public" })])).toBe(false);
  });
  it("the shipped registry decides the flag, and turning it on is one line: setting ownerReviewed on one usable Page", () => {
    // (the module is mocked above, so the real flag is read through the real function over the real data)
    expect(typeof realRegistry.FACEBOOK_REPORT_ENABLED).toBe("boolean");
    const shippedGate = reportEnabledFor(FACEBOOK_PAGE_REGISTRY);
    expect(shippedGate).toBe(FACEBOOK_PAGE_REGISTRY.some((page) => page.ownerReviewed === true && page.status === "ok"));
    const flipped = FACEBOOK_PAGE_REGISTRY.map((page, i) => (i === 0 ? { ...page, ownerReviewed: true } : page));
    expect(reportEnabledFor(flipped)).toBe(true);
    expect(flipped.filter((page, i) => page.ownerReviewed !== FACEBOOK_PAGE_REGISTRY[i].ownerReviewed)).toHaveLength(FACEBOOK_PAGE_REGISTRY[0].ownerReviewed ? 0 : 1);
  });
});

describe("gate off: the capability does not exist for customers", () => {
  it("it is not a service, not in the calculator, not in the approved catalog, and the report words are not a report request", () => {
    expect(SOCIAL_CAPABILITIES.map((cap) => cap.slug)).not.toContain(FACEBOOK_REPORT_SLUG);
    expect(getSocialCapability(FACEBOOK_REPORT_SLUG)).toBeUndefined();
    expect(getPublicCalculatorOptions().map((option) => option.slug)).not.toContain(FACEBOOK_REPORT_SLUG);
    expect(APPROVED_CAPABILITY_CATALOG.map((capability) => capability.slug)).not.toContain(FACEBOOK_REPORT_SLUG);
    for (const text of ["عايز تقرير عن الترندات الصحية على فيسبوك في مصر", "تحليل ورصد منشورات فيسبوك عن الصحة في مصر", "تقرير عن الترندات الصحية على فيسبوك آخر ٣ شهور"]) {
      expect(detectSocialIntent(text).report, text).toBeUndefined();
    }
    // «تقرير» alone says nothing about social content, as before
    expect(REPORT_WORDS_RE.test("تقرير")).toBe(true);
    expect(SOCIAL_CONTENT_WORDS_RE.test("تقرير عن شركة على فيسبوك")).toBe(false);
  });
});

describe("gate off: a request that would match the report falls through to today's behaviour (checked against main's own answers)", () => {
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
