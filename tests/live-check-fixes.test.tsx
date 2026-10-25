import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/hooks/useUser", () => ({ useUser: () => ({ user: null, loading: false }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/" }));

import DetailsBlanks from "../src/app/dashboard/chat/components/DetailsBlanks";
import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import ResultsCanvas from "../src/app/dashboard/chat/components/ResultsCanvas";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { formatStructuredClarificationAnswers, validateStructuredClarificationAnswers } from "../src/functions/shared/clarification";
import { generateExcelReport } from "../src/functions/shared/fileGenerators";
import { COMPANY_COLUMNS, COMPANY_SCREEN_ORDER, workbookCompanyColumns } from "../src/lib/companyColumns";
import { buildGenericCountryEditOperations, planCountryParamKeys } from "../src/lib/companyPlanEdits";
import { understandMission, understoodLineAr } from "../src/lib/consultantCopy";
import { industryLabelForCell } from "../src/lib/industryLabels";
import { completionNoticeFull } from "../src/lib/server/jobNotices";
import { estimateMission, estimateSummaryAr } from "../src/lib/missionEstimate";
import { notificationDisplay } from "../src/lib/notificationText";
import { formatPhoneDisplay } from "../src/lib/phoneDisplay";
import { countPlainAr, duplicateRecordsAr, oneMatchedAr } from "../src/lib/planCounts";
import { planExplanationLinesAr } from "../src/lib/planExplanation";
import { buildPriceRows, capacityForPoints, capacityLineAr, homePriceStrip } from "../src/lib/pricingPage";
import { normalizeReleaseWording } from "../src/lib/releaseWording";
import { summarizeActivityCounts } from "../src/lib/activityCounts";
import { topupReviewSentenceAr } from "../src/lib/topupConfig";
import { TURN_BUDGET_MS } from "../src/functions/shared/turnGuards";
import { TURN_TIMEOUT_MS, WAIT_CANCEL_AFTER_MS, WAIT_SLOW_AR, WAIT_STAGE_MS } from "../src/lib/waitProgress";
import { walletNoteForDisplay } from "../src/lib/walletText";
import { runConversation } from "./helpers/chatSession";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
/** The payload the UI sends for a card: `clarificationAnswers` with questionId, question and value («أخرى» alone sends nothing, a skip sends `skipped: true`). */
const card = (answers: Array<Record<string, unknown>>) =>
  formatStructuredClarificationAnswers(validateStructuredClarificationAnswers({ type: "clarification_answers", answers })!);
const turns = async (messages: string[]) => { clearBriefCacheForTesting(); return (await runConversation(messages)).responses as any[]; };

const COUNTRY_Q = "ما الدولة التي تريد البحث عن الشركات فيها؟";
const INDUSTRY_Q = "ما القطاع أو المجال الذي تعمل فيه الشركات المطلوبة؟";
const COUNT_Q = "كم شركة تريد في النتائج؟";

describe("live check 1: the counter and «السابق» match the real flow", () => {
  it("three consecutive company panels each hold ONE question, and none shows «سؤال ١ من ١» or «السابق»", async () => {
    const responses = await turns([
      "أريد شركات",
      card([{ questionId: "company_country_required", question: COUNTRY_Q, value: "مصر" }]),
      card([{ questionId: "company_industry_required", question: INDUSTRY_Q, value: "مقاولات" }]),
    ]);
    const panels = responses.filter((response) => response.outputType === "ask_clarification");
    expect(panels.length).toBeGreaterThanOrEqual(3);
    for (const panel of panels) {
      expect(panel.clarificationItems).toHaveLength(1);
      const markup = renderToStaticMarkup(createElement(DetailsBlanks, { questions: panel.clarificationItems, intro: panel.clarificationIntro, onComplete: () => {} }));
      expect(markup).not.toContain("سؤال ١ من ١");
      expect(markup).not.toContain('data-testid="clarification-progress"');
      expect(markup).not.toContain("السابق");
      expect(markup.match(/إجابة ومتابعة/g)?.length).toBe(1);
    }
  });

  it("a panel that really holds two questions shows the counter «سؤال ١ من ٢» and the previous button", () => {
    const questions = [
      { id: "q1", text: "ما القطاع؟", type: "single", options: ["مقاولات", "كهرباء"], allowOther: false },
      { id: "q2", text: "ما الدولة؟", type: "single", options: ["مصر", "السعودية"], allowOther: false },
    ];
    const markup = renderToStaticMarkup(createElement(DetailsBlanks, { questions, onComplete: () => {} }));
    expect(markup).toContain("سؤال ١ من ٢");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>السابق<\/button>/);
    const source = src("src/app/dashboard/chat/components/DetailsBlanks.tsx");
    expect(source).toContain("onClick={() => moveTo(step - 1)}");
  });
});

describe("live check 2: one plural rule after a number", () => {
  it("the shared helper writes «سجل واحد», «سجلين», «٥ سجلات», «١١ سجل» and the same for every unit", () => {
    expect(countPlainAr(1, "records")).toBe("سجل واحد");
    expect(countPlainAr(2, "records")).toBe("سجلين");
    expect(countPlainAr(5, "records")).toBe("٥ سجلات");
    expect(countPlainAr(10, "records")).toBe("١٠ سجلات");
    expect(countPlainAr(11, "records")).toBe("١١ سجل");
    expect(countPlainAr(5, "companies")).toBe("٥ شركات");
    expect(countPlainAr(1, "companies")).toBe("شركة واحدة");
    expect(countPlainAr(100, "companies")).toBe("١٠٠ شركة");
    expect(countPlainAr(100, "tweets")).toBe("١٠٠ تغريدة");
    expect(countPlainAr(5, "tweets")).toBe("٥ تغريدات");
    expect(oneMatchedAr("companies")).toBe("شركة واحدة مطابقة");
    expect(oneMatchedAr("records")).toBe("سجل واحد مطابق");
  });

  it("the plan of «٥ شركات مقاولات في مصر»: the understood line, the title, the cap and the explanation all say «٥ شركات / ٥ سجلات»", async () => {
    const [plan] = await turns(["ابحث لي عن ٥ شركات مقاولات في مصر في ملف إكسل"]);
    expect(plan.outputType).toBe("propose_plan");
    expect(plan.planQuote.understoodAr).toBe("فهمت أنك تريد ٥ شركات في مجال المقاولات والتشييد.");
    expect(plan.planQuote.summaryAr).toBe("استخراج بيانات ٥ سجلات من شركات المقاولات والتشييد في مصر");
    expect(plan.contentAr).toContain("الحد الأقصى: حتى ٥ سجلات");
    expect(plan.contentAr).toContain("شركة واحدة مطابقة");
    // no number from 3 to 10 is followed by a singular unit anywhere in the plan texts
    const everything = `${plan.contentAr} ${plan.planQuote.understoodAr} ${plan.planQuote.summaryAr}`;
    expect(everything).not.toMatch(/[٣-٩]\s(?:شركة|سجل|منشور|تعليق|فيديو|شخص)(?![اتًينو])/);
    expect(everything).not.toMatch(/\b١٠\s(?:شركة|سجل|منشور|تعليق|فيديو|شخص)(?![اتًينو])/);
  });

  it("a plan for ten tweets says «حتى ١٠ تغريدات», and the price strip says «١٠٠ تغريدة» (point 13)", () => {
    const lines = planExplanationLinesAr({ capabilitySlug: "social-x-posts", outputFormats: ["xlsx"], targetVolumeMax: 10, unitPricePoints: 0.6, expectedPoints: 6, quotedPoints: 7, countStated: true });
    expect(lines[0]).toContain("حتى ١٠ تغريدات");
    expect(lines[1]).toContain("تغريدة واحدة مطابقة");
    const strip = homePriceStrip();
    expect(strip[1].requestAr).toBe("١٠٠ تغريدة");
    expect(strip[0].requestAr).toBe("٥ شركات");
  });

  it("the activity lines say the plural too, and the panel still reads every count back (small counts are written in words)", () => {
    expect(summarizeActivityCounts([{ textAr: `الصفحة ١: استلمنا ${countPlainAr(5, "records")} · الجديد ٣ · قيد المراجعة ٢` }]).received).toBe(5);
    expect(summarizeActivityCounts([{ textAr: `الصفحة ١: استلمنا ${countPlainAr(1, "records")}` }]).received).toBe(1);
    expect(summarizeActivityCounts([{ textAr: `الصفحة ١: استلمنا ${countPlainAr(2, "records")}` }]).received).toBe(2);
    expect(summarizeActivityCounts([{ textAr: `الصفحة ١: استلمنا ${countPlainAr(50, "records")}` }]).received).toBe(50);
    for (const n of [1, 2, 4, 10, 15]) expect(summarizeActivityCounts([{ textAr: `تم تدقيق السجلات واستبعاد ${duplicateRecordsAr(n)}.` }]).excluded).toBe(n);
    // the old stored form is still read
    expect(summarizeActivityCounts([{ textAr: "تم تدقيق السجلات واستبعاد ٤ سجل مكرر." }]).excluded).toBe(4);
    expect(duplicateRecordsAr(3)).toBe("٣ سجلات مكررة");
  });
});

describe("live check 3: the «فهمت أنك تريد N …» sentence follows the plan's count", () => {
  it("5 → 3 by a typed edit: the new plan's sentence says ٣ شركات (it said ٥ شركة next to a ٣-record title and price)", async () => {
    const [first, second] = await turns(["ابحث لي عن ٥ شركات مقاولات في مصر في ملف إكسل", "خليها ٣ شركات بس"]);
    expect(first.planQuote.understoodAr).toContain("٥ شركات");
    expect(second.planQuote.targetVolumeMax).toBe(3);
    expect(second.planQuote.summaryAr).toContain("٣ سجلات");
    expect(second.planQuote.understoodAr).toContain("٣ شركات");
    expect(second.planQuote.understoodAr).not.toContain("٥");
  });

  it("the card's own edit never keeps the old sentence: the edit route drops it from the replacement quote", () => {
    const route = src("src/app/api/chat/edit-plan/route.ts");
    expect(route).toContain("delete editedQuote.understoodAr;");
  });

  it("the sentence of a request names the count the customer wrote, with the right plural", () => {
    expect(understoodLineAr(understandMission("أريد ١ شركة مقاولات في مصر"))).toContain("شركة واحدة");
    expect(understoodLineAr(understandMission("أريد ١٥ شركة مقاولات في مصر"))).toContain("١٥ شركة");
  });
});

describe("live check 4: the plan editor offers a country field when the plan has a country or location parameter", () => {
  const baseQuote = (items: any[]): PlanQuoteData => ({
    quoteId: "q1", planHash: "h", status: "quoted", summaryAr: "خطة", targetVolumeMax: 10, requestedVolumeMax: 10, expectedPoints: 30, quotedPoints: 35, unitPricePoints: 3, items,
    outputFormats: ["xlsx"], expiresAt: new Date(Date.now() + 3_600_000).toISOString(), balance: 5000, currentBalance: 5000,
  } as unknown as PlanQuoteData);
  const render = (items: any[]) => renderToStaticMarkup(createElement(PlanQuoteCard, { quote: baseQuote(items), initiallyEditing: true, onSaveEdit: async () => {}, onApprove: () => {}, onRefresh: async () => {} } as never));

  it("finds the parameters a plan carries its country in", () => {
    expect(planCountryParamKeys({ location: "Egypt", keyword: "x" })).toEqual(["location"]);
    expect(planCountryParamKeys({ region: "EG", country: "Egypt" })).toEqual(["country", "region"]);
    expect(planCountryParamKeys({ query: { location: { include: ["Egypt"] } } })).toEqual(["location"]);
    expect(planCountryParamKeys({ keyword: "x" })).toEqual([]);
    expect(planCountryParamKeys(undefined)).toEqual([]);
  });

  it("a generic service with a location parameter shows the country field in the editor; one without shows none", () => {
    const withLocation = render([{ capabilitySlug: "maps-business-search", targetVolumeMax: 10, params: { query: "مصانع", location: "Egypt" } }]);
    expect(withLocation).toContain('id="pq-country-q1"');
    const without = render([{ capabilitySlug: "x-keyword-search", targetVolumeMax: 10, params: { keyword: "كرة" } }]);
    expect(without).not.toContain('id="pq-country-q1"');
  });

  it("the edit is written in the form each parameter already uses (a code field gets the ISO code, a name field the English name)", () => {
    const ops = buildGenericCountryEditOperations("maps-business-search", "السعودية", { location: "Egypt", regionCode: "EG" });
    expect(ops).toEqual([
      { action: "set_param", capabilitySlug: "maps-business-search", key: "regionCode", value: "SA" },
      { action: "set_param", capabilitySlug: "maps-business-search", key: "location", value: "Saudi Arabia" },
    ].sort((a, b) => ops.findIndex((o) => o.key === a.key) - ops.findIndex((o) => o.key === b.key)));
    expect(buildGenericCountryEditOperations("s", "بلد لا يقرأه أحد", { location: "Egypt" })).toEqual([]);
    expect(src("src/app/dashboard/chat/page.tsx")).toContain("buildGenericCountryEditOperations(slug, newCountry");
  });
});

describe("live check 5: stored refund wording is read as «حجز مؤقت مُحرَّر» on request cards, activity lines and the wallet", () => {
  const STORED = [
    ["تم استرداد كامل الرصيد المحجوز دون أي خصم", "حجز مؤقت مُحرَّر كاملًا دون أي خصم"],
    ["تم استرداد الرصيد المحجوز", "حجز مؤقت مُحرَّر"],
    ["إرجاع الحجز", "حجز مؤقت مُحرَّر"],
    ["إرجاع الحجز المؤقت للطلب", "حجز مؤقت مُحرَّر للطلب"],
    ["تم إرجاع المبلغ المحجوز كاملة إلى رصيدك", "حجز مؤقت مُحرَّر كاملًا"],
    ["إعادة الرصيد المحجوز إلى حسابك", "حجز مؤقت مُحرَّر"],
    ["تم إرجاع كامل النقاط المحجوزة", "حجز مؤقت مُحرَّر كاملًا"],
  ] as const;
  it("every stored form reads the one wording, and a line with no refund word is untouched", () => {
    for (const [stored, shown] of STORED) expect(normalizeReleaseWording(stored), stored).toBe(shown);
    expect(normalizeReleaseWording("شحن الرصيد عبر إنستاباي")).toBe("شحن الرصيد عبر إنستاباي");
  });
  it("the wallet's line explanation and notes go through the same normalizer", () => {
    expect(walletNoteForDisplay("إرجاع الحجز")).toBe("حجز مؤقت مُحرَّر");
    expect(walletNoteForDisplay("تم استرداد كامل الرصيد المحجوز دون أي خصم")).toBe("حجز مؤقت مُحرَّر كاملًا دون أي خصم");
  });
  it("the request cards, the activity panel and the wallet read the normalizer (nothing stored is rewritten)", () => {
    expect(src("src/app/dashboard/requests/page.tsx")).toContain("normalizeReleaseWording(cleaned)");
    expect(src("src/app/dashboard/chat/components/ActivityTerminal.tsx")).toContain("normalizeReleaseWording(");
    expect(src("src/lib/walletText.ts")).toContain("normalizeReleaseWording(text)");
  });
});

describe("live check 6: the company Excel follows the screen through ONE column definition", () => {
  const FULL = { company_name: "شركة الفرع", industry: "Construction", website: "https://acme.test", linkedin_url: "https://www.linkedin.com/company/acme", city: "القاهرة", address: "شارع ١", phone: "+20 100 123 4567", work_email: "a@acme.test", description: "شركة مقاولات", headcount: "50", founded_year: "2010", phone_verification_status: "متحقق", work_email_verification_status: "valid", id: "rec_9" };
  async function sheetOf(rows: Array<Record<string, unknown>>) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await generateExcelReport({ title: "شركات", country: "مصر", entityType: "companies", rows } as any)) as any);
    const sheet = workbook.getWorksheet("بيانات الشركات")!;
    return { workbook, sheet, headers: (sheet.getRow(1).values as unknown[]).slice(1).map((v) => String(v)) };
  }
  it("rows with a description, a headcount and a founding year: the workbook has the shared columns in the shared order, no id and no status", async () => {
    const { headers, sheet } = await sheetOf([FULL]);
    expect(headers).toEqual(["اسم الشركة", "مجال النشاط", "الموقع الإلكتروني", "صفحة لينكد إن", "المدينة", "العنوان", "الهاتف التجاري", "البريد المهني", "الوصف التعريفي", "حجم العمالة", "سنة التأسيس"]);
    expect(headers).toEqual(workbookCompanyColumns([FULL]).map((column) => column.titleAr));
    expect(headers).not.toContain("معرّف السجل");
    expect(headers.some((header) => /^حالة تحقق/.test(header))).toBe(false);
    // the headcount and the year read in Arabic-Indic digits, like the screen
    expect(sheet.getRow(2).getCell(headers.indexOf("حجم العمالة") + 1).value).toBe("٥٠");
    expect(sheet.getRow(2).getCell(headers.indexOf("سنة التأسيس") + 1).value).toBe("٢٠١٠");
    expect(sheet.getRow(2).getCell(headers.indexOf("الوصف التعريفي") + 1).value).toBe("شركة مقاولات");
  });
  it("a column that would be empty in every row is never written: no description, headcount or year means no such columns", async () => {
    const { headers } = await sheetOf([{ company_name: "أ", industry: "Construction", city: "القاهرة", phone: "+20 100 123 4567" }, { company_name: "ب" }]);
    expect(headers).toEqual(["اسم الشركة", "مجال النشاط", "الموقع الإلكتروني", "صفحة لينكد إن", "المدينة", "العنوان", "الهاتف التجاري", "البريد المهني"]);
    expect(headers).toContain("العنوان"); // the address stays whatever the rows hold
  });
  it("a row from the multi-source search (a description, never a headcount or a year) gets the description column only", async () => {
    const { headers } = await sheetOf([{ company_name: "ج", description: "نبذة من صفحة الشركة", website: "https://c.test" }]);
    expect(headers).toContain("الوصف التعريفي");
    expect(headers).not.toContain("حجم العمالة");
    expect(headers).not.toContain("سنة التأسيس");
  });
  it("the screen and the workbook share the list: every workbook column has its screen counterpart, in the same order", () => {
    const workbookKeys = COMPANY_COLUMNS.filter((column) => !column.screenOnly).map((column) => column.key);
    expect(COMPANY_SCREEN_ORDER.filter((key) => workbookKeys.includes(key))).toEqual(workbookKeys);
    expect(COMPANY_COLUMNS.filter((column) => column.optional).map((column) => column.key)).toEqual(["description", "headcount", "founded_year"]);
    expect(COMPANY_COLUMNS.filter((column) => column.screenOnly).map((column) => column.key)).toEqual(["phone_verification_status", "work_email_verification_status"]);
    const html = renderToStaticMarkup(createElement(ResultsCanvas, { records: [FULL] as any, jobStatus: "done" } as any));
    const screen = Array.from(html.matchAll(/<th\b[^>]*>([^<]+)<\/th>/g)).map((match) => match[1]);
    const workbookTitles = workbookCompanyColumns([FULL]).map((column) => column.titleAr);
    expect(screen.filter((title) => workbookTitles.includes(title))).toEqual(workbookTitles);
  });
  it("the branch sheet is linked by the company's name (the workbook has no record id)", async () => {
    const { workbook } = await sheetOf([{ company_name: "نورث", branches: [{ name: "فرع برلين", city: "Berlin", address: "Musterstrasse 1" }] }]);
    const branches = workbook.getWorksheet("فروع الشركات")!;
    expect((branches.getRow(1).values as unknown[]).slice(1)).toEqual(["اسم الشركة", "اسم الفرع", "المدينة", "العنوان"]);
    expect(branches.getRow(2).getCell(1).value).toBe("نورث");
  });
});

describe("live check 7: company table values", () => {
  it("the phone formatter never drops or adds a digit: a shorter number is shorter in the SOURCE", () => {
    // the same digits in, the same digits out; only the written separators and the bracketed trunk zero «(0)» go
    for (const raw of ["+2025087419", "+20 2 5087419", "+20 25087419", "+20 (0)2 5087419", "+20225087419", "+20 22 508 7419", "+201001234567", "+20 100 123 4567"]) {
      const expected = raw.replace(/\(\s*0\s*\)/g, "").replace(/\D/g, "");
      expect(formatPhoneDisplay(raw).replace(/\D/g, ""), raw).toBe(expected);
    }
    // the number of the live check has 10 digits in the source; a 9-digit national number after +20 is a 7-digit local line
    expect(formatPhoneDisplay("+20 2 5087419")).toBe("+2025087419");
    expect(formatPhoneDisplay("+2025087419").replace(/\D/g, "")).toHaveLength(10);
  });
  it("the screen shows the headcount and the founding year in Arabic-Indic digits", () => {
    const html = renderToStaticMarkup(createElement(ResultsCanvas, { records: [{ company_name: "أ", headcount: "50", founded_year: "2010", description: "نبذة" }] as any, jobStatus: "done" } as any));
    const cells = text(html);
    expect(cells).toContain("٥٠");
    expect(cells).toContain("٢٠١٠");
    expect(html).not.toMatch(/<td[^>]*>\s*(?:50|2010)\s*<\/td>/);
  });
  it("the source's «Utilities» is explained as what it covers, so «المرافق» is not read as the facilities of a building", () => {
    expect(industryLabelForCell("Utilities")).toBe("المرافق العامة (كهرباء ومياه وغاز)");
    expect(industryLabelForCell("utilities")).toContain("كهرباء");
  });
});

describe("live check 8: the skip transition never hangs behind disabled inputs", () => {
  it("the skips of the questions the code asks make no model call at all (turnStats.modelCalls is 0)", async () => {
    const flows: string[][] = [
      ["أريد ٥ شركات مقاولات", card([{ questionId: "company_country_required", question: COUNTRY_Q, skipped: true }])],
      ["أريد ٥ شركات في مصر", card([{ questionId: "company_industry_required", question: INDUSTRY_Q, skipped: true }])],
      ["هات ١٠ تغريدات عن كرة السلة", card([{ questionId: "social_time_required", question: "ما الفترة الزمنية المطلوبة؟", skipped: true }])],
    ];
    for (const flow of flows) {
      const responses = await turns(flow);
      const last = responses[responses.length - 1];
      expect(last.turnStats.modelCalls).toBe(0);
      expect(last.turnStats.latencyMs).toBeLessThan(5_000);
    }
  });
  it("the page gives up before the route's own limit, keeps saying the work goes on, and offers «إيقاف الانتظار» from 15 s", () => {
    expect(TURN_TIMEOUT_MS).toBeGreaterThan(TURN_BUDGET_MS);
    expect(TURN_TIMEOUT_MS).toBeLessThan(60_000);
    expect(WAIT_CANCEL_AFTER_MS).toBeLessThan(WAIT_STAGE_MS.slow);
    expect(WAIT_SLOW_AR).toContain("إعادة المحاولة");
    expect(WAIT_SLOW_AR).not.toContain("رصيد");
    const page = src("src/app/dashboard/chat/page.tsx");
    expect(page.match(/setTimeout\(\(\) => controller\.abort\(\), TURN_TIMEOUT_MS\)/g)?.length).toBe(2);
    expect(page.match(/turnAbort\.current = controller;/g)?.length).toBe(2);
    expect(page).toContain('data-testid="stop-waiting"');
    expect(page).toContain("onClick={() => turnAbort.current?.abort()}");
    expect(page).toContain("retryClarification: { assistantMessageId, answers }");
    expect(page).toContain("errorRetryPrompt: textToSend");
  });
});

describe("live check 9: the wallet estimate is what the balance DELIVERS (no 15% reserve)", () => {
  it("10,020 points is 3,162 companies: 3,163 would cost 10,021", () => {
    const company = buildPriceRows().find((row) => row.id === "companies")!;
    expect(company.unitPricePoints).toBe(3.168);
    const line = capacityForPoints(10_020).find((entry) => entry.id === "companies")!;
    expect(line.records).toBe(3162);
    expect(Math.ceil(3162 * 3.168)).toBeLessThanOrEqual(10_020);
    expect(Math.ceil(3163 * 3.168)).toBeGreaterThan(10_020);
    expect(10_020 / 3.168).toBeCloseTo(3162.88, 1);
    expect(capacityLineAr(line)).toBe("حتى حوالي ٣١٦٢ شركة");
  });
  it("every line (companies, posts, comments, videos, people) uses the same basis", () => {
    for (const points of [1_000, 10_020, 123_456]) {
      for (const line of capacityForPoints(points)) {
        const unit = line.id === "people" ? 0 : buildPriceRows().find((row) => row.id === line.id)!.unitPricePoints;
        if (!unit) continue;
        expect(Math.ceil(line.records * unit), `${line.id} ${points}`).toBeLessThanOrEqual(points);
        expect(Math.ceil((line.records + 1) * unit), `${line.id} ${points}`).toBeGreaterThan(points);
      }
    }
  });
  it("a small capacity takes its right plural", () => {
    expect(capacityLineAr({ id: "companies", labelAr: "شركات", unitLabelAr: "شركة", records: 5 })).toBe("حتى حوالي ٥ شركات");
    expect(capacityLineAr({ id: "companies", labelAr: "شركات", unitLabelAr: "شركة", records: 1 })).toBe("حتى حوالي شركة واحدة");
  });
  it("the wallet and the pricing page say what the numbers are, and neither calls the estimate a reserve", () => {
    expect(src("src/app/dashboard/topup/page.tsx")).toContain("الأرقام تقدير بسعر السجل المُسلَّم نفسه، دون احتياطي الحجز");
    expect(src("src/app/pricing/page.tsx")).toContain("عدد السجلات التي يغطيها المبلغ بسعر السجل المُسلَّم، دون احتياطي الحجز");
  });
});

describe("live check 10: a notification never says its title twice", () => {
  it("the partial notice's body starts with the facts, not with the title", () => {
    const notice = completionNoticeFull({ requested: 100, delivered: 40, chargedPoints: 360, refundedPoints: 540 } as never);
    expect(notice.title).toBe("اكتمل طلبك جزئيًا");
    expect(notice.body.startsWith(notice.title)).toBe(false);
    expect(notice.body).toContain("تم تسليم ٤٠ من ١٠٠ سجلاً");
    expect(`${notice.title} ${notice.body}`.match(/اكتمل طلبك جزئيًا/g)?.length).toBe(1);
    expect(notice.email?.lead.startsWith("اكتمل طلبك جزئيًا")).toBe(false);
  });
  it("an old stored notice whose body repeats the title is shown once", () => {
    const shown = notificationDisplay("اكتمل طلبك جزئيًا", "اكتمل طلبك جزئيًا: تم تسليم ٤٠ من ١٠٠ سجلاً، لأن المصدر لم يتوفر فيه عدد أكبر يطابق طلبك.");
    expect(shown.title).toBe("اكتمل طلبك جزئيًا");
    expect(shown.body.startsWith("تم تسليم ٤٠ من ١٠٠ سجلاً")).toBe(true);
    expect(`${shown.title} ${shown.body}`.match(/اكتمل طلبك جزئيًا/g)?.length).toBe(1);
    expect(notificationDisplay("عنوان", "نص مختلف").body).toBe("نص مختلف");
  });
});

describe("live check 11: the header balance is read again from the final ledger state", () => {
  it("a finished job refreshes the shared balance at once, once more after the settlement, and after the results load", () => {
    const page = src("src/app/dashboard/chat/page.tsx");
    expect(page).toContain("const { balance: userBalance, refresh: loadBalance } = useBalance();");
    expect(page).toContain("balanceSettledFor.current.add(jId);");
    expect(page).toContain("setTimeout(() => { void loadBalance(); }, 3000);");
    expect(page).toMatch(/await loadJobResults\(jId\);\s*void loadBalance\(\);/);
    // the header reads the same provider the chat refreshes
    expect(src("src/components/app/AppShell.tsx")).toContain("const { balance, refresh: refreshBalance } = useBalance();");
  });
});

describe("live check 12: a range reads low to high, in points and in pounds", () => {
  const parse = (summary: string) => {
    const pounds = /\(حوالي ([٠-٩٫]+)(?: إلى ([٠-٩٫]+))? ج\.م\)/.exec(summary)!;
    const num = (value: string) => Number(value.replace(/٫/g, ".").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))));
    return { low: num(pounds[1]), high: pounds[2] ? num(pounds[2]) : num(pounds[1]) };
  };
  it("every size from 1 to 60 and the large ones give an ascending pounds range with one decimal, and never «٠ ج.م» for a priced request", () => {
    for (const volume of [...Array.from({ length: 60 }, (_, index) => index + 1), 100, 500, 1000, 100000]) {
      const result = estimateMission({ kind: "companies", volume });
      if (result.status !== "ok") continue;
      const summary = estimateSummaryAr(result);
      const { low, high } = parse(summary);
      expect(low, `${volume}: ${summary}`).toBeLessThanOrEqual(high);
      expect(low, summary).toBeGreaterThan(0);
    }
  });
  it("a result whose reserve is below its expected price still reads low to high", () => {
    const result: any = { status: "ok", expectedPoints: 316_800, reservePoints: 25_000, expectedEgp: 31_680, reserveEgp: 2_500 };
    const summary = estimateSummaryAr(result);
    expect(summary).toContain("من حوالي ٢٥٠٠٠ إلى ٣١٦٨٠٠ نقطة");
    expect(summary).toContain("حوالي ٢٥٠٠ إلى ٣١٦٨٠ ج.م");
  });
  it("the pounds keep the exact tenth (a point is a tenth of a pound)", () => {
    expect(estimateSummaryAr(estimateMission({ kind: "companies", volume: 5 }) as any)).toBe("من حوالي ١٦ إلى ١٩ نقطة (حوالي ١٫٦ إلى ١٫٩ ج.م)");
  });
});

describe("live check 14: the top-up review time stays configurable and honest", () => {
  it("with no configured time the sentence states none; a configured time is stated as written", () => {
    expect(topupReviewSentenceAr(null)).toBe("يراجع فريق الإدارة صورة الإيصال يدويًا، وتُضاف النقاط إلى محفظتك فور الاعتماد وتصلك رسالة بذلك.");
    expect(topupReviewSentenceAr("خلال ساعتين في أيام العمل")).toContain("ومدة المراجعة المتوقعة خلال ساعتين في أيام العمل");
    expect(src("src/app/dashboard/topup/page.tsx")).toContain("reviewTimeAr");
    expect(src("src/lib/topupConfig.ts")).toContain("export const TOPUP_REVIEW_TIME_AR: string | null = null;");
  });
});

describe("live check 15: delivered data is untouched", () => {
  it("the column title «صفحة لينكد إن» stays, and a delivered English name or description is not translated or changed", async () => {
    expect(COMPANY_COLUMNS.find((column) => column.key === "linkedin_url")!.titleAr).toBe("صفحة لينكد إن");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await generateExcelReport({ title: "x", country: "مصر", entityType: "companies", rows: [{ company_name: "Northstar Power Ltd", description: "Leading power company" }] } as any)) as any);
    const sheet = workbook.getWorksheet("بيانات الشركات")!;
    const headers = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
    expect(sheet.getRow(2).getCell(headers.indexOf("اسم الشركة") + 1).value).toBe("Northstar Power Ltd");
    expect(sheet.getRow(2).getCell(headers.indexOf("الوصف التعريفي") + 1).value).toBe("Leading power company");
  });
});
