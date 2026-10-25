import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { runConversation } from "./helpers/chatSession";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { formatStructuredClarificationAnswers, validateStructuredClarificationAnswers } from "../src/functions/shared/clarification";
import {
  COMPANY_SECTOR_CHIPS, detectIndustryFromText, extractInterpretedParameters, getMissingCompanyResearchRequirements, planActivityLabelAr, planEditScopeError, scopePartsAr, valueOrEmpty,
} from "../src/lib/planParameters";
import { planScopeRows, quoteScopeGaps } from "../src/lib/quoteScopeGaps";
import { RETRY_SAME_PLAN_MESSAGE, REVIEW_PLAN_MESSAGE, customerFacingMessageText } from "../src/lib/retryMessage";
import { buildCompanyPlanEditOperations, buildPeoplePlanEditOperations } from "../src/lib/companyPlanEdits";
import { applyPlanOperations, type PlanState } from "../src/functions/shared/planManager";
import { planChangeNoteAr, previousPlanQuoteOf } from "../src/lib/planChangeNote";
import { findRecentDuplicateRequest } from "../src/lib/server/duplicateRequest";
import { jobIdForQuote } from "../src/lib/server/retryReuse";
import { METHODOLOGY_POINTS, planPdfLineAr } from "../src/lib/methodologyOffer";
import { normalizeReleaseWording } from "../src/lib/releaseWording";
import { deliveredNothing } from "../src/lib/jobs/requestStatus";
import { walletMonthStats } from "../src/lib/walletView";
import { buildPriceRows, capacityForPoints } from "../src/lib/pricingPage";
import { volumeForPointsCap } from "../src/lib/pointsCap";
import { DEFAULT_PRICING_SETTINGS } from "../src/functions/shared/quotes";

/**
 * PHASE 1 of the UI/UX audit: money and trust. The chat turns are sent in the EXACT shape the page sends: a typed message is the text itself, and a
 * card answer is `{ type: "clarification_answers", answers: [{ questionId, question, value }] }` validated and stored by the same functions
 * the /api/chat route uses (clicking «أخرى» only opens the field and sends nothing; a skip sends `skipped: true` and no value).
 */
const card = (answers: Array<{ questionId: string; question: string; value?: string; skipped?: boolean }>) =>
  formatStructuredClarificationAnswers(validateStructuredClarificationAnswers({ type: "clarification_answers", answers })!);
const IND_Q = "ما القطاع أو المجال الذي تعمل فيه الشركات المطلوبة؟";
const CTRY_Q = "ما الدولة التي تريد البحث عن الشركات فيها؟";
const TYPE_Q = "اكتب القطاع بكلماتك، مثل: الكهرباء أو الاتصالات أو التأمين.";
const turns = async (messages: string[]) => { clearBriefCacheForTesting(); return (await runConversation(messages)).responses as any[]; };

const PLACEHOLDER = /يلزم تحديد/;

describe("point 3: no plan card for an ambiguous request, and no broken field", () => {
  it("ROOT CAUSE: the leftovers of a card label were read as the sector («المجال المطلوب» became «ال المطلوب مطلوب»)", () => {
    for (const text of ["عايز ١٠ شركات المجال المطلوب: ", "المجال المطلوب", "شركات الدولة المطلوبة: مصر", "عايز ١٠ شركات", "المجال المطلوب: أخرى", "عايز ٥٠ شركة في مصر المجال المطلوب: مش عارف"]) {
      const found = detectIndustryFromText(text);
      expect(found.arabicLabel, text).toBe("يلزم تحديد النشاط");
      expect(found.englishKeywords, text).toEqual([]);
    }
  });

  it("a stranded article or «المطلوب مطلوب» is never a usable value: the plan has a gap and cannot be approved", () => {
    const item = (industry: string) => [{ capabilitySlug: "icypeas-companies-search", params: { country: "Egypt", location: "Egypt", industry }, targetVolumeMax: 5 }];
    expect(quoteScopeGaps(item("ال المطلوب مطلوب"))).toContain("industry");
    expect(quoteScopeGaps(item("المطلوب مطلوب"))).toContain("industry");
    expect(quoteScopeGaps(item("الكهرباء والطاقة الكهربائية"))).toEqual([]);
  });

  it("«مش عارف» to the sector question is no sector: the sector is asked again and no plan card appears", async () => {
    const [, second] = await turns(["عايز ٥٠ شركة في مصر", card([{ questionId: "company_industry_required", question: IND_Q, value: "مش عارف" }])]);
    expect(getMissingCompanyResearchRequirements("عايز ٥٠ شركة في مصر المجال المطلوب: مش عارف")).toContain("industry");
    expect(second.outputType).toBe("ask_clarification");
    expect(second.planQuote).toBeUndefined();
    expect(second.clarificationItems[0].id).toBe("company_industry_required");
  });

  it("a Riyadh-like word inside a sector («الرياضة») is not read as a country", () => {
    expect(planActivityLabelAr({ industry: "الرياضة" })).toBe("الرياضة");
    expect(detectIndustryFromText("المجال المطلوب: الرياضة").arabicLabel).toBe("الرياضة");
  });
});

describe("point 6: typos, the electricity option, and no dead end after a skip", () => {
  it("«كهربا» and other near spellings read as the sector; real custom sectors are left alone", () => {
    for (const typed of ["كهربا", "كهربائيه", "الكهربا"]) expect(detectIndustryFromText(typed).arabicLabel, typed).toBe("الكهرباء والطاقة الكهربائية");
    expect(detectIndustryFromText("شركات تصنيه").arabicLabel).toBe("التصنيع والإنتاج الصناعي");
    expect(detectIndustryFromText("مقاولت").arabicLabel).toBe("المقاولات والتشييد");
    expect(detectIndustryFromText("اتصلات").arabicLabel).toBe("الاتصالات");
    // not rewritten into another sector: «صناع» (makers) is four letters one edit from «صناعة» (industry)
    expect(detectIndustryFromText("صناع").arabicLabel).toBe("صناع");
    expect(detectIndustryFromText("رياضة").arabicLabel).toBe("رياضة");
  });

  it("a request with the typo goes straight to a plan, with the electricity sector (the same name in the summary and in the params)", async () => {
    const [plan] = await turns(["عايز ٥ شركات كهربا في مصر"]);
    expect(plan.outputType).toBe("propose_plan");
    expect(plan.planQuote.items[0].params.industry).toBe("الكهرباء والطاقة الكهربائية");
    expect(plan.planQuote.summaryAr).toContain("الكهرباء والطاقة الكهربائية");
  });

  it("the sector question lists an electricity option, and tapping it produces a plan", async () => {
    expect(COMPANY_SECTOR_CHIPS).toContain("كهرباء وطاقة");
    const [first, plan] = await turns(["عايز ٥٠ شركة في مصر", card([{ questionId: "company_industry_required", question: IND_Q, value: "كهرباء وطاقة" }])]);
    expect(first.clarificationItems[0].options).toContain("كهرباء وطاقة");
    expect(first.clarificationItems[0].options.at(-1)).toBe("أخرى");
    expect(plan.outputType).toBe("propose_plan");
    expect(plan.planQuote.items[0].params.industry).toBe("الكهرباء والطاقة الكهربائية");
  });

  it("ROOT CAUSE: skipping the sector ended in a sentence with no plan and no question. Now: ONE typed follow-up, then a sentence that names the next step", async () => {
    const [, , afterSkip, afterSecondSkip] = await turns([
      "عايز ٥٠ شركة",
      card([{ questionId: "company_country_required", question: CTRY_Q, value: "مصر" }]),
      card([{ questionId: "company_industry_required", question: IND_Q, skipped: true }]),
      card([{ questionId: "company_industry_required", question: TYPE_Q, skipped: true }]),
    ]);
    expect(afterSkip.outputType).toBe("ask_clarification");
    expect(afterSkip.clarificationItems[0]).toMatchObject({ id: "company_industry_required", type: "free" });
    expect(afterSkip.clarificationItems[0].options ?? []).toEqual([]);
    expect(afterSkip.planQuote).toBeUndefined();
    expect(afterSkip.contentAr).not.toContain("تحتاج الخطة هذه المعلومة");
    expect(afterSkip.contentAr).not.toMatch(/[A-Za-z]/);
    // a second skip: no plan can be priced without a sector, so the sentence says what to write and gives an example
    expect(afterSecondSkip.outputType).toBe("answer_question");
    expect(afterSecondSkip.contentAr).toContain("لا أستطيع تسعير الطلب قبل معرفة القطاع");
    expect(afterSecondSkip.contentAr).toContain("«١٠ شركات كهرباء في مصر»");
  });

  it("after the first skip, a typed answer (even with a typo) gives the plan", async () => {
    const all = await turns([
      "عايز ٥٠ شركة",
      card([{ questionId: "company_country_required", question: CTRY_Q, value: "مصر" }]),
      card([{ questionId: "company_industry_required", question: IND_Q, skipped: true }]),
      card([{ questionId: "company_industry_required", question: TYPE_Q, value: "كهربا" }]),
    ]);
    expect(all[3].outputType).toBe("propose_plan");
    expect(all[3].planQuote.items[0].params.industry).toBe("الكهرباء والطاقة الكهربائية");
  });

  it("a skipped country gets the same treatment", async () => {
    const all = await turns([
      "عايز ٥٠ شركة كهرباء",
      card([{ questionId: "company_country_required", question: CTRY_Q, skipped: true }]),
      card([{ questionId: "company_country_required", question: "اكتب اسم الدولة", skipped: true }]),
    ]);
    expect(all[1].outputType).toBe("ask_clarification");
    expect(all[1].clarificationItems[0]).toMatchObject({ id: "company_country_required", type: "free" });
    expect(all[2].contentAr).toContain("لا أستطيع تسعير الطلب قبل معرفة الدولة");
  });
});

describe("point 5: «لا، خليها ٣ شركات بس» before approval updates the plan", () => {
  it("ROOT CAUSE: «ليه» sat inside «خليها» and the message was read as a complaint about a result", async () => {
    const [first, edited] = await turns(["عايز ٥ شركات كهرباء في مصر", "لا، خليها 3 شركات بس"]);
    expect(first.planQuote.targetVolumeMax).toBe(5);
    expect(edited.contentAr).not.toContain("وصلت ملاحظتك على النتيجة");
    expect(edited.outputType).toBe("propose_plan");
    expect(edited.planQuote.targetVolumeMax).toBe(3);
    expect(edited.planQuote.quotedPoints).toBeLessThan(first.planQuote.quotedPoints);
    // the price per company did not change: only the count did
    expect(edited.planQuote.unitPricePoints).toBe(first.planQuote.unitPricePoints);
  });

  it("the other spellings of the same ask also update the plan (digits, no «لا»)", async () => {
    for (const text of ["خليها ٣ بس", "لا خليها ٣ شركات", "لا، خليها ٣"]) {
      const [, edited] = await turns(["عايز ٥ شركات كهرباء في مصر", text]);
      expect(edited.outputType, text).toBe("propose_plan");
      expect(edited.planQuote.targetVolumeMax, text).toBe(3);
    }
  });

  it("a real complaint about a result is still read as one", async () => {
    const [, feedback] = await turns(["عايز ٥ شركات كهرباء في مصر", "ليه النتيجة ناقصة"]);
    expect(feedback.contentAr).toContain("وصلت ملاحظتك على النتيجة");
  });
});

describe("point 18: the retry button", () => {
  it("the customer's chat shows one clean line for the fixed button messages, never the instruction the server reads", () => {
    expect(customerFacingMessageText(RETRY_SAME_PLAN_MESSAGE)).toBe("أعد المحاولة بنفس الخطة");
    expect(customerFacingMessageText(REVIEW_PLAN_MESSAGE)).toBe("عايز أراجع الخطة وأعدّلها");
    expect(customerFacingMessageText(RETRY_SAME_PLAN_MESSAGE)).not.toMatch(/اعرض|ولا تعتمد|التنفيذ/);
    expect(customerFacingMessageText("عايز ٥ شركات")).toBe("عايز ٥ شركات");
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("{customerFacingMessageText(m.content)}");
  });

  it("the new plan is labelled as a new offer, keeps the same price and the same topic, and asks no question again", async () => {
    for (const request of ["هات ١٠ تغريدات عن كرة السلة في ٢٠٢٥", "عايز ٥ شركات كهرباء في مصر"]) {
      const [first, retry] = await turns([request, RETRY_SAME_PLAN_MESSAGE]);
      expect(retry.outputType, request).toBe("propose_plan");
      expect(retry.clarificationItems, request).toBeUndefined();
      expect(retry.planQuote.retryOffer, request).toEqual({ reusedRows: 0 });
      expect(first.planQuote.retryOffer, request).toBeUndefined();
      expect(retry.planQuote.unitPricePoints).toBe(first.planQuote.unitPricePoints);
      expect(JSON.stringify(retry.planQuote)).not.toMatch(/أعد المحاولة|اعرض عرض|بنفس الخطة/);
    }
  });

  it("a period the customer chose is kept, a skipped period stays the labelled proposal, and no period is added when none was needed (no second question)", async () => {
    const PERIOD_Q = "ما الفترة الزمنية التي تهمّك؟";
    const chosen = await turns(["هات ١٠ تغريدات عن كرة السلة", card([{ questionId: "social_time_required", question: PERIOD_Q, value: "آخر ٣ شهور" }]), RETRY_SAME_PLAN_MESSAGE]);
    expect(chosen[1].contentAr).toContain("الفترة الزمنية: آخر ٣ شهور");
    expect(chosen[2].outputType).toBe("propose_plan");
    expect(chosen[2].contentAr).toContain("الفترة الزمنية: آخر ٣ شهور");
    expect(chosen[2].contentAr).not.toContain("لم تحدد فترة");
    const skipped = await turns(["هات ١٠ تغريدات عن كرة السلة", card([{ questionId: "social_time_required", question: PERIOD_Q, skipped: true }]), RETRY_SAME_PLAN_MESSAGE]);
    expect(skipped[2].outputType).toBe("propose_plan");
    expect(skipped[2].contentAr).toContain("لم تحدد فترة، فاقترحت آخر شهر");
    const dated = await turns(["هات ١٠ تغريدات عن كرة السلة في ٢٠٢٥", RETRY_SAME_PLAN_MESSAGE]);
    expect(dated[1].contentAr).toContain("من ١ يناير ٢٠٢٥ إلى ٣١ ديسمبر ٢٠٢٥");
    expect(dated[1].contentAr).not.toContain("آخر شهر");
  });
});

/* ---------------------------------------------------------------- the card */

function quote(overrides: Partial<PlanQuoteData> & { items?: any[] } = {}): PlanQuoteData {
  return {
    quoteId: "q_card",
    summaryAr: "خطة",
    items: [{ capabilitySlug: "icypeas-companies-search", params: { query: { keyword: { include: ["electrical"] }, industry: { include: ["Utilities"] }, location: { include: ["Egypt"] } }, country: "Egypt", location: "Egypt", industry: "الكهرباء والطاقة الكهربائية" }, targetVolumeMin: 1, targetVolumeMax: 5, unitPricePoints: 3.168 }],
    targetVolumeMax: 5,
    unitPricePoints: 3.168,
    expectedPoints: 16,
    quotedPoints: 19,
    isAffordable: true,
    userBalance: 5000,
    outputFormats: ["xlsx", "pdf", "csv"],
    expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
    status: "quoted",
    ...overrides,
  } as PlanQuoteData;
}
const render = (q: PlanQuoteData, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(PlanQuoteCard, { quote: q, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {}, ...props } as any));
const stepsOf = (html: string) => html.slice(html.indexOf("خطوات التنفيذ المنهجية"), html.indexOf("صيغ التسليم المعتمدة"));
const inputValues = (html: string) => [...html.matchAll(/<input[^>]*value="([^"]*)"/g)].map((m) => m[1]);

describe("point 2: the editor never holds the validation sentence, and a saved edit persists after reopening", () => {
  const noCountry = quote({ items: [{ capabilitySlug: "icypeas-companies-search", params: { industry: "الكهرباء والطاقة الكهربائية", query: { keyword: { include: ["electrical"] } } }, targetVolumeMin: 1, targetVolumeMax: 5, unitPricePoints: 3.168 }] });

  it("ROOT CAUSE: the editor started from the placeholder «يلزم تحديد الدولة» and the method step wrote it into its sentence", () => {
    const html = render(noCountry, { initiallyEditing: true });
    expect(inputValues(html).join("|")).not.toMatch(PLACEHOLDER);
    expect(stepsOf(html)).not.toMatch(PLACEHOLDER);
    expect(stepsOf(html)).toContain("الكهرباء والطاقة الكهربائية");
    // the country field is empty and asks for a value; saving it empty is refused in words
    expect(html).toMatch(/id="pq-country-q_card"[^>]*value=""/);
    expect(planEditScopeError({ country: "", industry: "الكهرباء", needsCountry: true, needsIndustry: true })).toBe("اكتب الدولة قبل حفظ التعديل.");
    expect(planEditScopeError({ country: "يلزم تحديد الدولة", industry: "الكهرباء", needsCountry: true, needsIndustry: true })).toBe("اكتب الدولة قبل حفظ التعديل.");
    expect(planEditScopeError({ country: "كوكب المريخ", industry: "الكهرباء", needsCountry: true, needsIndustry: true })).toContain("لم أتعرف على هذه الدولة");
    expect(planEditScopeError({ country: "مصر", industry: "", needsCountry: true, needsIndustry: true })).toBe("اكتب النشاط قبل حفظ التعديل.");
    expect(planEditScopeError({ country: "مصر", industry: "الكهرباء", needsCountry: true, needsIndustry: true })).toBeNull();
  });

  it("the helpers leave a missing country out of sentences and fields", () => {
    expect(valueOrEmpty("يلزم تحديد الدولة")).toBe("");
    expect(valueOrEmpty(" مصر ")).toBe("مصر");
    expect(scopePartsAr("يلزم تحديد الدولة", "الكهرباء")).toBe("الكهرباء");
    expect(scopePartsAr("مصر", "الكهرباء")).toBe("مصر · الكهرباء");
    expect(extractInterpretedParameters(noCountry.items![0].params, "").isDefaultCountry).toBe(true);
  });

  it("a company plan: the edited country is saved in every place it is read, so reopening shows it", () => {
    const plan: PlanState = { summaryAr: "خطة", items: noCountry.items as any, outputFormats: ["xlsx"] };
    const ops = buildCompanyPlanEditOperations("icypeas-companies-search", "", "مصر", "الكهرباء", { keyword: "electrical", country: "", industry: "الكهرباء والطاقة الكهربائية" });
    const saved = applyPlanOperations(plan, ops as any).items[0].params;
    expect(saved.country).toBe("Egypt");
    expect(saved.location).toBe("Egypt");
    expect(saved.query.location.include).toEqual(["Egypt"]);
    const reopened = extractInterpretedParameters(saved, "");
    expect(reopened.countryAr).toBe("مصر");
    expect(reopened.isDefaultCountry).toBe(false);
    expect(quoteScopeGaps([{ capabilitySlug: "icypeas-companies-search", params: saved, targetVolumeMax: 5 }])).toEqual([]);
  });

  it("ROOT CAUSE for decision makers: the edited country was never sent (and a «query» string was written). Now: the ISO code and the title are saved", () => {
    const people = { capabilitySlug: "professional-people-search", params: { q: "مديرين", limit: 5, country: "SA", title: "Director" }, targetVolumeMin: 1, targetVolumeMax: 5 };
    const plan: PlanState = { summaryAr: "خطة", items: [people] as any, outputFormats: ["xlsx"] };
    const ops = buildPeoplePlanEditOperations("professional-people-search", "مدير", "ألمانيا");
    const saved = applyPlanOperations(plan, ops as any).items[0].params;
    expect(saved.country).toBe("DE");
    expect(saved.title).toBe("مدير");
    expect(saved).not.toHaveProperty("query");
    expect(extractInterpretedParameters(saved, "", true).countryAr).toBe("ألمانيا");
    // the generic phrase of an untouched field is never written as a title
    expect(buildPeoplePlanEditOperations("professional-people-search", "صناع القرار والمهنيون", "ألمانيا").map((op) => op.key)).toEqual(["country"]);
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("buildPeoplePlanEditOperations(slug, cleanVal, newCountry || \"\")");
  });

  it("the card of a decision-makers plan without a country has the same empty field and no placeholder in its steps", () => {
    const people = quote({ items: [{ capabilitySlug: "professional-people-search", params: { q: "مديرين", limit: 5 }, targetVolumeMin: 1, targetVolumeMax: 5, unitPricePoints: 9 }] });
    const html = render(people, { initiallyEditing: true });
    expect(stepsOf(html)).toContain("البحث عن صناع القرار والمهنيين ضمن المصادر المتاحة.");
    expect(stepsOf(html)).not.toMatch(PLACEHOLDER);
    expect(inputValues(html).join("|")).not.toMatch(PLACEHOLDER);
  });
});

describe("point 28: one activity name in the summary, the chip, the field and the steps", () => {
  it("they all read the same Arabic label", async () => {
    const [plan] = await turns(["عايز ٥ شركات كهربا في مصر"]);
    const q = plan.planQuote as PlanQuoteData;
    const label = planActivityLabelAr(q.items![0].params);
    expect(label).toBe("الكهرباء والطاقة الكهربائية");
    expect(q.summaryAr).toContain(label);
    const chip = planScopeRows(q.items as any).find((c) => c.label.includes("النشاط"));
    expect(chip?.value).toBe(label);
    const html = render(q, { initiallyEditing: true });
    expect(stepsOf(html)).toContain(label);
    expect(inputValues(html)).toContain(label);
    expect(stepsOf(html)).not.toMatch(PLACEHOLDER);
  });
});

describe("the edit mode of the plan card", () => {
  it("shows ONE «إلغاء» and no approve button under the open editor; the approve button is back when it is closed", () => {
    const open = render(quote(), { initiallyEditing: true });
    expect((open.match(/>إلغاء</g) || []).length).toBe(1);
    expect(open).not.toContain("إلغاء التعديل");
    expect(open).not.toContain("أوافق وابدأ البحث");
    expect(open).toContain("حفظ التعديل");
    const closed = render(quote());
    expect(closed).toContain("أوافق وابدأ البحث");
    expect(closed).toContain("تعديل الخطة");
    expect(closed).not.toContain("حفظ التعديل");
  });

  it("with a balance that does not cover the plan, the open editor still has one «إلغاء» and no second edit toggle", () => {
    const html = render(quote(), { initiallyEditing: true, available: 3 });
    expect((html.match(/>إلغاء</g) || []).length).toBe(1);
    expect(html).not.toContain("إلغاء التعديل");
    expect(html).not.toContain(">تعديل الخطة<");
  });
});

describe("point 4: one sentence says why the price or the title differs from the earlier plan", () => {
  const companies = { unitPricePoints: 3.168, items: [{ capabilitySlug: "icypeas-companies-search", params: { industry: "الكهرباء والطاقة الكهربائية" } }] };
  const people = { unitPricePoints: 9, items: [{ capabilitySlug: "professional-people-search", params: { industry: "الكهرباء والطاقة الكهربائية", requiredContactFields: ["work_email", "phone"] } }] };

  it("a different kind of data, added contact fields, a different activity, and nothing when only the count changed", () => {
    expect(planChangeNoteAr(companies, people)).toBe("تغيّر السعر والعنوان عن الخطة السابقة لأن طلبك الآن صناع القرار والمسؤولين بدل الشركات والأعمال، ولكل نوع سعره.");
    const withFields = { unitPricePoints: 5, items: [{ capabilitySlug: "icypeas-companies-search", params: { industry: "الكهرباء والطاقة الكهربائية", requiredContactFields: ["work_email"] } }] };
    expect(planChangeNoteAr(companies, withFields)).toBe("تغيّر سعر السجل عن الخطة السابقة لأنك أضفت بيانات تواصل (البريد المهني)، ويُحتسب كل حقل مطلوب عند إرجاعه فقط.");
    const telecom = { unitPricePoints: 3.168, items: [{ capabilitySlug: "icypeas-companies-search", params: { industry: "الاتصالات" } }] };
    expect(planChangeNoteAr(companies, telecom)).toBe("تغيّر عنوان الخطة عن الخطة السابقة لأن النشاط اختلف (من الكهرباء والطاقة الكهربائية إلى الاتصالات).");
    expect(planChangeNoteAr(companies, { ...companies, items: [{ ...companies.items[0], targetVolumeMax: 3 }] } as any)).toBeNull();
    expect(planChangeNoteAr(null, companies)).toBeNull();
    expect(planChangeNoteAr(companies, { unitPricePoints: 3.2, items: companies.items })).toBe("تغيّر سعر السجل عن الخطة السابقة لأن تفاصيل طلبك تغيّرت.");
  });

  it("the previous plan is the newest quote of the conversation", () => {
    expect(previousPlanQuoteOf([{ role: "assistant", quote: companies }, { role: "user" }, { role: "assistant", quote: people }])?.unitPricePoints).toBe(9);
    expect(previousPlanQuoteOf([{ role: "user" }])).toBeNull();
  });

  it("the card shows the sentence before the approve button, and only while the plan can still be approved", () => {
    const note = "تغيّر سعر السجل عن الخطة السابقة لأن تفاصيل طلبك تغيّرت.";
    const html = render(quote({ changeNoteAr: note }));
    expect(html).toContain(note);
    expect(html.indexOf(note)).toBeLessThan(html.indexOf("أوافق وابدأ البحث"));
    expect(render(quote({ changeNoteAr: note }), { locked: true })).not.toContain(note);
  });
});

describe("point 7: «عندك نفس الطلب ده» before approving an identical plan", () => {
  const NOW = Date.parse("2026-10-24T12:00:00Z");
  function fakeClient(rows: { quotes: any[]; jobs: any[]; messages: any[] }) {
    const chain = (table: string) => {
      const api: any = { filters: [] as Array<(r: any) => boolean> };
      for (const name of ["select", "order", "limit", "gte"]) api[name] = (col?: any, val?: any) => { if (name === "gte") api.filters.push((r: any) => String(r[col]) >= String(val)); return api; };
      api.eq = (col: string, val: any) => { api.filters.push((r: any) => r[col] === val); return api; };
      api.in = (col: string, vals: any[]) => { api.filters.push((r: any) => vals.includes(r[col])); return api; };
      api.contains = (_col: string, val: any) => { api.filters.push((r: any) => r.quote?.quoteId === val.quoteId); return api; };
      const run = () => ({ data: (rows as any)[table].filter((r: any) => api.filters.every((f: any) => f(r))), error: null });
      api.maybeSingle = async () => ({ data: run().data[0] ?? null, error: null });
      api.then = (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject);
      return api;
    };
    return { from: (table: string) => chain(table === "plans_quotes" ? "quotes" : table) };
  }
  const base = { quotes: [{ id: "q_old", user_id: "u1", quote_hash: "hash1", status: "accepted", created_at: "2026-10-20T10:00:00Z" }], messages: [{ user_id: "u1", conversation_id: "conv_old", quote: { quoteId: "q_old" } }] };
  const doneJob = { id: jobIdForQuote("q_old"), user_id: "u1", status: "completed", delivered_units: 5, updated_at: "2026-10-20T10:30:00Z" };

  it("finds the same plan that delivered records, with the conversation to open", async () => {
    const found = await findRecentDuplicateRequest(fakeClient({ ...base, jobs: [doneJob] }), { userId: "u1", planHash: "hash1", excludeQuoteId: "q_new", now: NOW });
    expect(found).toEqual({ jobId: jobIdForQuote("q_old"), conversationId: "conv_old", deliveredUnits: 5, completedAt: "2026-10-20T10:30:00Z" });
  });

  it("ignores a plan that was not identical, a request that delivered nothing, one that did not finish, one too old, and another customer's", async () => {
    const find = (jobs: any[], extra: Record<string, unknown> = {}, quotes = base.quotes) => findRecentDuplicateRequest(fakeClient({ ...base, quotes, jobs }), { userId: "u1", planHash: "hash1", excludeQuoteId: "q_new", now: NOW, ...extra });
    expect(await find([doneJob], { planHash: "other" })).toBeNull();
    expect(await find([{ ...doneJob, delivered_units: 0 }])).toBeNull();
    expect(await find([{ ...doneJob, status: "running" }])).toBeNull();
    expect(await find([{ ...doneJob, status: "failed" }])).toBeNull();
    expect(await find([doneJob], {}, [{ ...base.quotes[0], created_at: "2026-08-01T10:00:00Z" }])).toBeNull();
    expect(await find([doneJob], { userId: "u2" })).toBeNull();
    expect(await find([doneJob], { excludeQuoteId: "q_old" })).toBeNull();
    expect(await findRecentDuplicateRequest({ from: () => { throw new Error("db down"); } }, { userId: "u1", planHash: "hash1" })).toBeNull();
  });

  it("the card warns with the sentence and a button that opens the old result, and approving stays possible", () => {
    const opened: unknown[] = [];
    const html = render(quote({ duplicateOf: { jobId: "job_old", conversationId: "conv_old", deliveredUnits: 5, completedAt: null } }), { onOpenPrevious: (p: unknown) => opened.push(p) });
    expect(html).toContain("عندك نفس الطلب ده.");
    expect(html).toContain("افتح النتيجة القديمة");
    expect(html.indexOf("عندك نفس الطلب ده.")).toBeLessThan(html.indexOf("أوافق وابدأ البحث"));
    expect(html).toContain("أوافق وابدأ البحث");
    expect(render(quote())).not.toContain("عندك نفس الطلب ده");
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("handleOpenConversation(previousConversationId, jobId)");
    const handler = readFileSync("src/functions/shared/chatHandler.ts", "utf8");
    expect(handler).toContain("findRecentDuplicateRequest(sb, { userId, planHash: managedQuote.planHash, excludeQuoteId: managedQuote.quoteId })");
  });
});

describe("point 10: the wallet estimate uses the real unit prices", () => {
  it("ROOT CAUSE: the wallet card divided the balance by invented prices (12, 45, 85 points for 100, 500, 1000 records), unrelated to the real company price", () => {
    const wallet = readFileSync("src/app/dashboard/topup/page.tsx", "utf8");
    expect(wallet).not.toContain("ILLUSTRATIVE_SEARCH_PRICES");
    expect(readFileSync("src/lib/pricing.ts", "utf8")).not.toContain("ILLUSTRATIVE_SEARCH_PRICES");
    expect(wallet).toContain("capacityForPoints(available)");
  });

  it("the companies line is exactly what the shared pricing function says the balance DELIVERS (the real unit price, no 15% reserve)", () => {
    const company = buildPriceRows().find((row) => row.id === "companies")!;
    expect(company.unitPricePoints).toBe(3.168);
    const line = capacityForPoints(1000).find((entry) => entry.id === "companies")!;
    expect(line.records).toBe(volumeForPointsCap(1000, company.unitPricePoints, 0));
    expect(line.records).toBeLessThanOrEqual(1000 / 3.168); // the 15% buffer is on the reserve only, never in this estimate
    expect(capacityForPoints(0).every((entry) => entry.records === 0)).toBe(true);
  });
});

describe("point 11: the monthly released total and the ledger lines are explained, and no «٠» flashes", () => {
  it("the month figure is the net (hold lifted minus the charge); the gross is what the ledger lines show", () => {
    const rows = [
      { id: "res_1", type: "reserve", delta: -100, jobId: "j1", createdAt: "2026-10-10T10:00:00Z" },
      { id: "rel_1", type: "release", delta: 100, jobId: "j1", createdAt: "2026-10-10T11:00:00Z" },
      { id: "chg_1", type: "charge", delta: -30, jobId: "j1", createdAt: "2026-10-10T11:00:01Z" },
    ];
    const stats = walletMonthStats(rows as any[], new Date("2026-10-24T12:00:00Z"));
    expect(stats.releasedGross).toBe(100);
    expect(stats.releasedHold).toBe(70);
    expect(stats.charged).toBe(30);
  });

  it("the wallet explains the two figures in one visible sentence and shows a skeleton until the ledger has loaded", () => {
    const wallet = readFileSync("src/app/dashboard/topup/page.tsx", "utf8");
    expect(wallet).toContain('data-testid="wallet-released-explainer"');
    expect(wallet).toContain("يظهر الحجز المُحرَّر كاملًا قبل الخصم");
    expect(wallet).toContain("const monthReady = ledgerLoaded;");
    expect(wallet).toContain("{monthReady ? <p className=\"m-0 text-xl font-bold text-wallet-amber\">{formatAr(stats.releasedHold)}</p>");
    expect(wallet).toContain("<Skeleton className=\"h-7 w-16 !bg-none bg-white/10\" />");
    expect(wallet).toContain("useState<number | null>(null)");
  });
});

describe("point 12: each plan card says whether the PDF is included or costs ١٠ نقاط", () => {
  it("states it with the very price the results panel shows", () => {
    expect(METHODOLOGY_POINTS).toBe(10);
    const withPdf = render(quote({ outputFormats: ["xlsx", "pdf"] }));
    expect(withPdf).toContain('data-testid="plan-pdf-line"');
    expect(withPdf).toContain("ملف بي دي إف مشمول في سعر هذه الخطة بلا رسوم إضافية");
    expect(withPdf).toContain("مقابل ١٠ نقاط");
    const without = render(quote({ outputFormats: ["xlsx"] }));
    expect(without).toContain("هذه الخطة بلا ملف بي دي إف");
    expect(without).toContain("مقابل ١٠ نقاط");
    expect(planPdfLineAr(["pdf"])).not.toMatch(/[A-Za-z0-9]/);
    const canvas = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");
    expect(canvas).toContain("formatNumber(METHODOLOGY_POINTS)");
  });
});

describe("point 13: no «استرداد» wording on the request cards", () => {
  it("every stored variant is read as «حجز مؤقت مُحرَّر»", () => {
    for (const stored of [
      "تعذر بدء الطلب. تم إرجاع النقاط المحجوزة إلى رصيدك.",
      "الخدمة غير متاحة حالياً. تم إرجاع النقاط المحجوزة إلى رصيدك.",
      "تم إلغاء الطلب تلقائياً لتأخر التنفيذ وتم إرجاع كامل نقاطك المحجوزة لرصيدك.",
      "تعذر بدء التنفيذ خلال دقيقة. تم إلغاء الطلب وإرجاع كامل النقاط المحجوزة.",
      "تعذر بدء البحث بعد عدة محاولات. أُعيدت النقاط المحجوزة إلى رصيدك.",
      "انتهى البحث وأُعيد الرصيد المحجوز.",
      "رفض المصدر تفاصيل الطلب. تم إرجاع النقاط المحجوزة كاملة؛ راجع إعدادات البحث.",
    ]) {
      const shown = normalizeReleaseWording(stored);
      expect(shown, stored).toContain("حجز مؤقت مُحرَّر");
      expect(shown, stored).not.toMatch(/إرجاع|استرداد|استرجاع|أُعيد|أعيد|رجعت/);
    }
    expect(normalizeReleaseWording("نص عادي")).toBe("نص عادي");
  });

  it("the request card builds its note from that wording, never from «أُعيد … إلى رصيدك»", () => {
    const page = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(page).not.toContain("أُعيد ${refund}");
    expect(page).not.toMatch(/cleaned\.includes\("(?:إرجاع|استرداد)"\)/);
    expect(page).toContain("normalizeReleaseWording(cleaned)");
    const activity = readFileSync("src/app/dashboard/chat/components/ActivityTerminal.tsx", "utf8");
    expect(activity).toContain("normalizeReleaseWording(sanitizeActivityError(errorAr))");
  });
});

describe("point 14: zero delivered records show zero files", () => {
  it("a finished request with a known zero shows none; an unknown count is never read as zero; a running one is not finished", () => {
    expect(deliveredNothing({ kind: "done", delivered: 0, deliveredKnown: true })).toBe(true);
    expect(deliveredNothing({ kind: "partial", delivered: 0, deliveredKnown: true })).toBe(true);
    expect(deliveredNothing({ kind: "done", delivered: 0, deliveredKnown: false })).toBe(false);
    expect(deliveredNothing({ kind: "done", delivered: 3, deliveredKnown: true })).toBe(false);
    expect(deliveredNothing({ kind: "running", delivered: 0, deliveredKnown: true })).toBe(false);
  });

  it("the request card and the results panel both offer no file for it", () => {
    const page = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(page).toContain("const availableFormats = nothingDelivered ? [] :");
    expect(page).toContain("لم يصل أي سجل، لذلك لا توجد ملفات بيانات لهذا الطلب، ولم يُخصم منك أي رصيد.");
    const canvas = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");
    expect(canvas).toContain('jobStatus === "done" && (records.length > 0 || rowsCollected !== undefined)');
  });
});

describe("the stale «تُرك هذا الاختيار» line", () => {
  it("is not listed once a plan exists", () => {
    const blanks = readFileSync("src/app/dashboard/chat/components/DetailsBlanks.tsx", "utf8");
    expect(blanks).toContain("!(planExists && completedAnswers!.find((entry) => entry.questionId === q.id)?.skipped)");
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("planExists={messages.slice(");
  });
});
