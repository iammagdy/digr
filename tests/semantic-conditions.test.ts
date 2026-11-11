import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { buildRequestContract, buildRequestContractWithReport } from "../src/lib/agentMission/requestContract";
import { applyAskEdit } from "../src/lib/agentMission/stage2/askCard";
import { CLARIFY_QUESTION_AR, clarifyOf, periodAskedIn, readConditions } from "../src/lib/agentMission/semantic/conditions";
import { preModelAnswer } from "../src/lib/agentMission/guardRules";
import { runProductionPlanning, type ProductionPlanning } from "./helpers/productionPlanning";
import { M12 } from "./helpers/round14Missions";
import { SEMANTIC_NOW_MS, understand, type Understood } from "./helpers/semanticUnderstand";

/**
 * PR-1.3: DATES, COUNTRIES AND LANGUAGES in the real request contract, the Ask and the worker's own planning run (`runPlanning` over the stored live pages: no model, no provider, no network), flag `semantic_normalization_v1` OFF and ON.
 * The reference day is always handed in (the mission's creation moment) and every day is a Cairo day: nothing here reads the machine's clock or time zone.
 */
beforeAll(() => { vi.stubGlobal("fetch", () => { throw new Error("network is forbidden in the semantic conditions tests"); }); });
afterAll(() => { vi.unstubAllGlobals(); });

const ON = { semantic: true } as const;
const OFF = { semantic: false } as const;
/** Wednesday 2026-11-11 (Cairo). */
const NOW = SEMANTIC_NOW_MS;
const at = (iso: string): number => Date.parse(iso);
const period = (text: string, now: number = NOW, answer: string | null = null) => readConditions(text, answer, now).period;
const range = (from: string, to: string) => expect.objectContaining({ status: "resolved", from, to });

// ---- 1. exact day ranges ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("PR-1.3 dates: an exact range is read as written, never widened and never narrowed", () => {
  it("«من ١ لـ ١٥ أكتوبر» is 1 to 15 October, NOT the whole month (the audit's critical example)", () => {
    expect(period("من ١ لـ ١٥ أكتوبر")).toEqual(range("2026-10-01", "2026-10-15"));
    expect(period("من ١ لـ ١٥ أكتوبر ٢٠٢٦ بس")).toEqual(range("2026-10-01", "2026-10-15"));
    expect(period("من 1 الى 15 اكتوبر 2025")).toEqual(range("2025-10-01", "2025-10-15"));
    expect(period("من ١ إلى ١٥ أكتوبر")).toEqual(range("2026-10-01", "2026-10-15"));
  });
  it("«من يناير لحد مارس» is January to March, NOT January only", () => {
    expect(period("من يناير لحد مارس")).toEqual(range("2026-01-01", "2026-03-31"));
    expect(period("من يناير لحد مارس ٢٠٢٦")).toEqual(range("2026-01-01", "2026-03-31"));
    expect(period("من يناير ٢٠٢٥ لحد مارس ٢٠٢٥")).toEqual(range("2025-01-01", "2025-03-31"));
  });
  it("«from January to March» and «between January and March 2026» (English)", () => {
    expect(period("from January to March")).toEqual(range("2026-01-01", "2026-03-31"));
    expect(period("between January and March 2025")).toEqual(range("2025-01-01", "2025-03-31"));
    expect(period("from 5 October to 20 October 2026")).toEqual(range("2026-10-05", "2026-10-20"));
  });
  it("a specific day is kept as that day (a day is never widened to its month)", () => {
    expect(period("١٥ أكتوبر ٢٠٢٦")).toEqual(range("2026-10-15", "2026-10-15"));
    expect(period("في ٢٠ سبتمبر")).toEqual(range("2026-09-20", "2026-09-20"));
    expect(period("من ٢٠ أكتوبر لحد ٥ نوفمبر")).toEqual(range("2026-10-20", "2026-11-05"));
  });
  it("«من أول السنة» is the first of January of this year up to today (the day the plan states)", () => {
    expect(period("من أول السنة")).toEqual(range("2026-01-01", "2026-11-11"));
    expect(period("من اول الشهر")).toEqual(range("2026-11-01", "2026-11-11"));
  });
  it("a start with its year and no end runs to today, and the plan's sentence says both days; a bare «من ٦ أكتوبر» may be a city and is NOT read", () => {
    expect(period("من ١٥ أكتوبر ٢٠٢٦")).toEqual(range("2026-10-15", "2026-11-11"));
    expect(period("من ١٥ أكتوبر")).toEqual({ status: "none" });
    expect(period("شركات من ٦ أكتوبر").status).toBe("none");
  });
  it("a month or day that is part of a NAME is no period: «حرب أكتوبر», «ثورة ٢٥ يناير», «مدينة ٦ أكتوبر»; and the topic keeps it", () => {
    for (const t of ["عن حرب أكتوبر", "عن ثورة ٢٥ يناير", "في مدينة ٦ أكتوبر", "منشورات عن مارس", "about the March madness"]) expect(period(t).status, t).toBe("none");
    expect(buildRequestContract("هات تعليقات فيديوهات تيك توك عن حرب أكتوبر", undefined, ON).topic).toBe("حرب أكتوبر");
    expect(buildRequestContract("هات تعليقات فيديوهات تيك توك عن ثورة ٢٥ يناير", undefined, ON).topic).toBe("ثورة ٢٥ يناير");
    expect(buildAsk("هات تعليقات فيديوهات تيك توك عن حرب أكتوبر", null, NOW, {}, ON).period).toBeNull();
    expect(period("في ٢٥ يناير ٢٠٢٦")).toEqual(range("2026-01-25", "2026-01-25"));
  });
  it("a single month with a year, or the year of today, is that whole month (the existing rule, unchanged)", () => {
    expect(period("في شهر أكتوبر ٢٠٢٦")).toEqual(range("2026-10-01", "2026-10-31"));
    expect(period("في أكتوبر")).toEqual(range("2026-10-01", "2026-10-31"));
    expect(period("شهر أكتوبر")).toEqual(range("2026-10-01", "2026-10-31"));
    expect(period("خلال اكتوبر")).toEqual(range("2026-10-01", "2026-10-31"));
    expect(period("in October")).toEqual(range("2026-10-01", "2026-10-31"));
    expect(period("في نوفمبر")).toEqual(range("2026-11-01", "2026-11-30"));
  });
});

// ---- 2/3. relative dates and spoken numbers ----------------------------------------------------------------------------------------------------------------------------------------------------
describe("PR-1.3 dates: relative periods and Egyptian spoken numbers, counted from the Cairo day of the request", () => {
  it("«آخر ٣ شهور» / «اخر تلات شهور» / «آخر 3 شهور» / «last 3 months» are the same period", () => {
    for (const t of ["آخر ٣ شهور", "اخر تلات شهور", "آخر 3 شهور", "اخر ثلاث شهور", "آخر تلاتة شهور", "last 3 months", "past 3 months"]) expect(period(t), t).toEqual(range("2026-08-11", "2026-11-11"));
  });
  it("«آخر 30 يوم» is exactly thirty days (today and the 29 before it), «آخر أسبوعين» exactly fourteen, never one day more", () => {
    expect(period("آخر 30 يوم")).toEqual(range("2026-10-13", "2026-11-11"));
    expect(period("آخر ٣٠ يوم")).toEqual(range("2026-10-13", "2026-11-11"));
    expect(period("آخر أسبوعين")).toEqual(range("2026-10-29", "2026-11-11"));
    expect(period("اخر اسبوعين")).toEqual(range("2026-10-29", "2026-11-11"));
    expect(period("آخر ٧ ايام")).toEqual(range("2026-11-05", "2026-11-11"));
    expect(period("اخر يومين")).toEqual(range("2026-11-10", "2026-11-11"));
    expect(period("اخر اسبوع")).toEqual(range("2026-11-05", "2026-11-11"));
    expect(period("last 30 days")).toEqual(range("2026-10-13", "2026-11-11"));
  });
  it("spoken numbers: خمس, ست, تمن, عشر, عشرين, تلاتين", () => {
    expect(period("اخر خمس ايام")).toEqual(range("2026-11-07", "2026-11-11"));
    expect(period("اخر ست شهور")).toEqual(range("2026-05-11", "2026-11-11"));
    expect(period("اخر عشر ايام")).toEqual(range("2026-11-02", "2026-11-11"));
    expect(period("اخر تلاتين يوم")).toEqual(range("2026-10-13", "2026-11-11"));
    expect(period("آخر سنتين")).toEqual(range("2024-11-11", "2026-11-11"));
    expect(period("آخر سنة")).toEqual(range("2025-11-11", "2026-11-11"));
  });
  it("«الشهر اللي فات» / «الشهر الماضي» is the previous CALENDAR month; «السنة اللي فاتت» the previous calendar year; «امبارح» the day before", () => {
    expect(period("الشهر اللي فات")).toEqual(range("2026-10-01", "2026-10-31"));
    expect(period("الشهر الماضي")).toEqual(range("2026-10-01", "2026-10-31"));
    expect(period("الشهر الماضى")).toEqual(range("2026-10-01", "2026-10-31"));
    expect(period("السنة اللي فاتت")).toEqual(range("2025-01-01", "2025-12-31"));
    expect(period("السنة الماضية")).toEqual(range("2025-01-01", "2025-12-31"));
    expect(period("امبارح")).toEqual(range("2026-11-10", "2026-11-10"));
    expect(period("الشهر ده")).toEqual(range("2026-11-01", "2026-11-11"));
  });
  it("numbers that are NOT a period are never read as one: counts, ranks, a year with nothing else", () => {
    for (const t of ["هات ٥٠ شركة", "اخر 5 منشورات", "عايز 20 منشور اخر اخبار", "هات 2026 منشور", "من ١٠٠ شركة", "من 5 شركات لحد 10", "اخر الاخبار"]) expect(period(t).status, t).toBe("none");
    expect(periodAskedIn("هات ٥٠ تعليق")).toBe(false);
    expect(periodAskedIn("آخر ٣ شهور")).toBe(true);
  });
});

// ---- 4. month and year boundaries -------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("PR-1.3 dates: month and year boundaries, with an explicit reference moment and Africa/Cairo", () => {
  it("a request on 5 January: «الشهر اللي فات» is December of the PREVIOUS year", () => {
    expect(period("الشهر اللي فات", at("2027-01-05T09:00:00Z"))).toEqual(range("2026-12-01", "2026-12-31"));
  });
  it("«آخر ٣ شهور» on 30 November ends on the last day that exists (28 February in a common year, 29 in a leap year)", () => {
    expect(period("آخر ٣ شهور", at("2027-05-31T09:00:00Z"))).toEqual(range("2027-02-28", "2027-05-31"));
    expect(period("آخر ٣ شهور", at("2028-05-31T09:00:00Z"))).toEqual(range("2028-02-29", "2028-05-31"));
  });
  it("a range that crosses a year is read when the years are written, or when ONE end carries the year (the other is the year before / after, by the months' order)", () => {
    expect(period("من نوفمبر ٢٠٢٥ لحد فبراير ٢٠٢٦")).toEqual(range("2025-11-01", "2026-02-28"));
    expect(period("من نوفمبر لحد فبراير ٢٠٢٦")).toEqual(range("2025-11-01", "2026-02-28"));
    expect(period("من نوفمبر ٢٠٢٥ لحد فبراير")).toEqual(range("2025-11-01", "2026-02-28"));
    expect(period("من ٢٥ ديسمبر ٢٠٢٧ لحد ٥ يناير ٢٠٢٨")).toEqual(range("2027-12-25", "2028-01-05"));
    expect(period("من يناير لحد ديسمبر ٢٠٢٧")).toEqual(range("2027-01-01", "2027-12-31"));
  });
  it("February 29 exists only in a leap year; a day that does not exist is a clarification, never a guess", () => {
    expect(period("من ١ لـ ٢٩ فبراير ٢٠٢٨")).toEqual(range("2028-02-01", "2028-02-29"));
    expect(period("من ١ لـ ٢٩ فبراير ٢٠٢٧")).toEqual({ status: "clarify", code: "period_invalid" });
    expect(period("من ٣٠ فبراير لحد ٥ مارس ٢٠٢٦")).toEqual({ status: "clarify", code: "period_invalid" });
    expect(period("من ١٥ أكتوبر ٢٠٢٦ لحد ١ أكتوبر ٢٠٢٦")).toEqual({ status: "clarify", code: "period_invalid" });
  });
  it("«امبارح» uses the CAIRO day, not the machine's: 00:30 in Cairo on 11 November is still 10 November in UTC", () => {
    expect(period("امبارح", at("2026-11-10T22:30:00Z"))).toEqual(range("2026-11-10", "2026-11-10"));
    expect(period("آخر يومين", at("2026-11-10T22:30:00Z"))).toEqual(range("2026-11-10", "2026-11-11"));
    expect(period("آخر يومين", at("2026-11-10T21:30:00Z"))).toEqual(range("2026-11-09", "2026-11-10"));
  });
});

// ---- 5. a year that cannot be inferred is asked --------------------------------------------------------------------------------------------------------------------------------------------------
describe("PR-1.3 dates: a year that cannot safely be inferred is a question, not a guess", () => {
  it("a month or a range with no year that lies wholly in the future, and a crossing with no year, are clarifications", () => {
    expect(period("في ديسمبر")).toEqual({ status: "clarify", code: "period_year" });
    expect(period("من ديسمبر لحد يناير")).toEqual({ status: "clarify", code: "period_crossing" });
    expect(period("من نوفمبر لحد فبراير")).toEqual({ status: "clarify", code: "period_crossing" });
    expect(period("من ١٥ ديسمبر لحد ٢٠ ديسمبر")).toEqual({ status: "clarify", code: "period_year" });
    expect(period("من مارس لحد مايو", at("2026-02-10T09:00:00Z"))).toEqual({ status: "clarify", code: "period_year" });
    // a range that STARTS in the past is the current year's, even if it ends later this year
    expect(period("من يناير لحد مارس", at("2026-02-10T09:00:00Z"))).toEqual(range("2026-01-01", "2026-03-31"));
  });
  it("two different periods in one request are a clarification, never the last or the first of them", () => {
    expect(period("آخر ٣ شهور و من ١ لـ ١٥ أكتوبر")).toEqual({ status: "clarify", code: "period_several" });
    expect(period("آخر ٣ شهور آخر ٣ شهور").status).toBe("resolved");
  });
  it("the customer's answer decides: a year answers «أي سنة؟», a full range answers a crossing, and each question is the product's own Arabic sentence", () => {
    expect(readConditions("في ديسمبر", "٢٠٢٥", NOW).period).toEqual(range("2025-12-01", "2025-12-31"));
    expect(readConditions("من ١٥ ديسمبر لحد ٢٠ ديسمبر", "2025", NOW).period).toEqual(range("2025-12-15", "2025-12-20"));
    expect(readConditions("من نوفمبر لحد فبراير", "من نوفمبر ٢٠٢٥ إلى فبراير ٢٠٢٦", NOW).period).toEqual(range("2025-11-01", "2026-02-28"));
    expect(readConditions("من نوفمبر لحد فبراير", "٢٠٢٦", NOW).period).toEqual({ status: "clarify", code: "period_crossing" });
    expect(clarifyOf(readConditions("في ديسمبر", null, NOW))).toEqual([{ code: "period_year", field: "period" }]);
    for (const q of Object.values(CLARIFY_QUESTION_AR)) expect(q).toMatch(/[؀-ۿ]/);
  });
});

// ---- 6/7. countries -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("PR-1.3 countries: spelling variants, topic versus geographic target, never an invented filter", () => {
  const country = (t: string, a: string | null = null) => readConditions(t, a, NOW).country;
  it("«في مصر», «فمصر», «بمصر», «من مصر», «in Egypt» are Egypt", () => {
    for (const t of ["في مصر", "فمصر", "بمصر", "من مصر", "في  مصر", "in Egypt", "from Egypt", "within Egypt"]) expect(country(t), t).toEqual({ status: "resolved", code: "EG" });
  });
  it("Saudi Arabia with ه/ة, fused ف/ب and the long name; the Emirates with and without the hamza", () => {
    for (const t of ["في السعودية", "من السعوديه", "فالسعودية", "بالسعوديه", "في المملكة العربية السعودية", "in Saudi Arabia"]) expect(country(t), t).toEqual({ status: "resolved", code: "SA" });
    for (const t of ["في الامارات", "في الإمارات", "فالامارات", "in United Arab Emirates"]) expect(country(t), t).toEqual({ status: "resolved", code: "AE" });
  });
  it("«عن مصر» is a TOPIC and filters nothing; a country name with no locative word filters nothing; a nationality word is not a country", () => {
    for (const t of ["عن مصر", "اخبار مصر", "السعوديه", "منشورات مصرية", "عن الاقتصاد المصري", "about Egypt", "Egypt"]) expect(country(t).status, t).toBe("none");
  });
  it("a city is never read as its country («في مصر الجديدة» is a district of Cairo, «في القاهرة» a city)", () => {
    for (const t of ["في مصر الجديدة", "في القاهرة", "in Cairo", "في دبي"]) expect(country(t).status, t).toBe("none");
  });
  it("two countries are a clarification, never the first of them; «أي دولة» is no filter; a bare country answers the question", () => {
    expect(country("في مصر والسعودية")).toEqual({ status: "many", codes: ["EG", "SA"] });
    expect(country("من مصر ومن السعودية")).toEqual({ status: "many", codes: ["EG", "SA"] });
    expect(clarifyOf(readConditions("في مصر والسعودية", null, NOW))).toEqual([{ code: "country_many", field: "country" }]);
    expect(country("في مصر والسعودية", "مصر")).toEqual({ status: "resolved", code: "EG" });
    expect(country("في مصر والسعودية", "في السعودية")).toEqual({ status: "resolved", code: "SA" });
    expect(country("من أي دولة").status).toBe("any");
  });
  it("words that merely contain a place or look like a place are not countries: «من الأزمة», «from us», «في العمل»", () => {
    for (const t of ["عن الخروج من الازمة", "from us", "في العمل", "in india times", "من ايه"]) expect(country(t).status, t).toBe(t === "in india times" ? "resolved" : "none");
  });
});

// ---- 8/9/10. languages ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("PR-1.3 languages: the language of the collected content, of the report and of the chat are three different things", () => {
  const lang = (t: string, a: string | null = null) => readConditions(t, a, NOW).language;
  it("an explicit content language: «بالعربي», «بالعربية», «باللغة العربية», «بالانجليزي», «بالإنجليزي», «in English», «Arabic comments», «English posts»", () => {
    for (const t of ["بالعربي", "بالعربية", "باللغة العربية", "باللغه العربيه", "عربي فقط", "Arabic comments", "تعليقات عربية", "in Arabic", "تعليقات بالعربي"]) expect(lang(t).content, t).toBe("ar");
    for (const t of ["بالانجليزي", "بالإنجليزي", "باللغة الإنجليزية", "in English", "English posts", "تعليقات انجليزية", "انجليزي فقط"]) expect(lang(t).content, t).toBe("en");
  });
  it("«عربي» alone, «الشركات العربية», «الوطن العربي» name nothing: no language is set (the request's own language is never a filter)", () => {
    for (const t of ["عربي", "الشركات العربية", "الوطن العربي", "هات تعليقات عن السياحة", "get comments about tourism", "هات منشورات عن مطعم عربي كبير"]) expect(lang(t).content, t).toBe("none");
  });
  it("a REPORT language is not a filter of the data: «التقرير بالإنجليزي», «ملخص بالانجليزي», «english report»", () => {
    for (const t of ["التقرير بالإنجليزي", "ملخص بالانجليزي", "عايز التحليل بالانجليزي", "english report", "report in English"]) { expect(lang(t).content, t).toBe("none"); expect(lang(t).report, t).toBe("en"); }
    expect(lang("التقرير بالعربي").report).toBe("ar");
  });
  it("a CHAT language is not a filter: «رد علي بالعربي», «كلمني بالانجليزي»", () => {
    for (const t of ["رد علي بالعربي", "كلمني بالانجليزي", "جاوبني بالعربي"]) { expect(lang(t).content, t).toBe("none"); expect(lang(t).report, t).toBeNull(); expect(lang(t).found, t).toBe(true); }
  });
  it("the three at once: Arabic content with an English report, and Arabic comments with English posts (both languages: nothing is filtered out)", () => {
    expect(lang("تعليقات بالعربي والتقرير بالانجليزي")).toEqual({ content: "ar", report: "en", found: true });
    expect(lang("تعليقات عربية ومنشورات English").content).toBe("both");
    expect(lang("اي لغة").content).toBe("any");
  });
  it("a language the product cannot filter by is a clarification, never silently Arabic; an answer settles it", () => {
    expect(lang("بالفرنسي").content).toBe("unsupported");
    expect(lang("french comments").content).toBe("unsupported");
    expect(clarifyOf(readConditions("بالفرنسي", null, NOW))).toEqual([{ code: "language_unsupported", field: "language" }]);
    expect(lang("بالفرنسي", "بالعربي").content).toBe("ar");
    expect(lang("بالفرنسي", "أي لغة").content).toBe("any");
  });
  it("mixed Arabic/English requests keep every condition: «هات تعليقات tiktok about tourism in Egypt last 3 months English»", () => {
    const r = readConditions("هات تعليقات tiktok about tourism in Egypt last 3 months English comments", null, NOW);
    expect(r.country).toEqual({ status: "resolved", code: "EG" });
    expect(r.period).toEqual(range("2026-08-11", "2026-11-11"));
    expect(r.language.content).toBe("en");
  });
});

// ---- 11. the contract and the Ask, OFF and ON --------------------------------------------------------------------------------------------------------------------------------------------
interface Case { id: string; group: string; text: string; answer?: string; expected: Partial<Record<keyof Understood, unknown>>; known_gap?: { ref: string; observed: Partial<Record<keyof Understood, unknown>> }; closed_gap?: { ref: string } }
const baselineCases = (JSON.parse(readFileSync(new URL("./fixtures/semantic-paraphrases.json", import.meta.url), "utf8")) as { cases: Case[] }).cases;
const TOPIC = "هات تعليقات فيديوهات تيك توك عن السياحة";

describe("PR-1.3 in the real contract and Ask: OFF is today's parser exactly, ON reads what the words say", () => {
  const ask = (text: string, options: { semantic?: boolean }, now = NOW) => buildAsk(text, null, now, {}, options);
  const rangeOf = (a: ReturnType<typeof buildAsk>) => (a.period ? { from: a.period.from, to: a.period.to } : null);

  it("OFF: the new fields do not exist at all, whatever the words (the Ask carries no clarification and no report language)", () => {
    for (const t of [`${TOPIC} من نوفمبر لحد فبراير`, `${TOPIC} بالفرنسي`, `${TOPIC} في مصر والسعودية`, `${TOPIC} والتقرير بالانجليزي`]) {
      const a = ask(t, OFF);
      expect(a.clarify, t).toBeUndefined();
      expect(a.reportLanguage, t).toBeUndefined();
      expect(buildRequestContractWithReport(t, undefined, OFF).report).toEqual({ filled: [], tightened: [], cleared: [], corrected: [], disagreements: [] });
    }
  });
  it("ON: exact ranges reach the Ask as Cairo days (and their instants); OFF read the same words as the whole month or as nothing", () => {
    expect(rangeOf(ask(`${TOPIC} من ١ لـ ١٥ أكتوبر ٢٠٢٦ بس`, OFF))).toEqual({ from: "2026-10-01", to: "2026-10-31" }); // the silent widening of today
    expect(rangeOf(ask(`${TOPIC} من ١ لـ ١٥ أكتوبر ٢٠٢٦ بس`, ON))).toEqual({ from: "2026-10-01", to: "2026-10-15" });
    expect(rangeOf(ask(`${TOPIC} من يناير لحد مارس ٢٠٢٦`, OFF))).toEqual({ from: "2026-01-01", to: "2026-01-31" }); // the silent narrowing of today
    expect(rangeOf(ask(`${TOPIC} من يناير لحد مارس ٢٠٢٦`, ON))).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(rangeOf(ask(`${TOPIC} اخر تلات شهور`, OFF))).toBeNull();
    expect(rangeOf(ask(`${TOPIC} اخر تلات شهور`, ON))).toEqual({ from: "2026-08-11", to: "2026-11-11" });
    const a = ask(`${TOPIC} من ١ لـ ١٥ أكتوبر ٢٠٢٦`, ON);
    expect(a.period!.startMs).toBeLessThan(a.period!.endExclusiveMs);
    expect(a.period!.endExclusiveMs - a.period!.startMs).toBe(15 * 86_400_000); // 15 Cairo days (no summer-time change in October)
  });
  it("ON: the period is counted from the mission's creation moment (the explicit reference), never from the machine's clock", () => {
    const t = `${TOPIC} آخر أسبوعين`;
    expect(rangeOf(ask(t, ON, at("2026-11-11T09:00:00Z")))).toEqual({ from: "2026-10-29", to: "2026-11-11" });
    expect(rangeOf(ask(t, ON, at("2027-03-01T09:00:00Z")))).toEqual({ from: "2027-02-16", to: "2027-03-01" });
  });
  it("ON: the topic keeps its words and loses only the condition: «السياحة الشهر اللي فات» → «السياحة», «السياحة بالفرنسي» → «السياحة»", () => {
    for (const t of ["الشهر اللي فات", "آخر ٣ شهور", "بالفرنسي", "من ١ لـ ١٥ أكتوبر"]) {
      expect(buildRequestContract(`${TOPIC} ${t}`, undefined, ON).topic, t).toBe("السياحة");
    }
    expect(buildRequestContract(`${TOPIC} الشهر اللي فات`, undefined, OFF).topic).toBe("السياحة الشهر اللي فات");
    expect(buildRequestContract("هات منشورات تيك توك عن الشهر اللي فات في الاقتصاد", undefined, ON).topic).not.toBeNull();
  });
  it("ON: the contract says a period / a country / a language was asked wherever the words ask it (OFF missed «اخر», «فمصر», the long country name)", () => {
    expect(buildRequestContract(`${TOPIC} اخر تلات شهور`, undefined, OFF).period).toBe(false);
    expect(buildRequestContract(`${TOPIC} اخر تلات شهور`, undefined, ON).period).toBe(true);
    expect(buildRequestContract(`${TOPIC} من يناير لحد مارس`, undefined, ON).period).toBe(true);
    expect(buildRequestContract(`${TOPIC} فمصر`, undefined, OFF).country).toBe(false);
    expect(buildRequestContract(`${TOPIC} فمصر`, undefined, ON).country).toBe(true);
    expect(buildRequestContract(`${TOPIC} في المملكة العربية السعودية`, undefined, ON).country).toBe(true);
    expect(buildRequestContract(`${TOPIC} باللغه العربيه`, undefined, OFF).language).toBe(false);
    expect(buildRequestContract(`${TOPIC} باللغه العربيه`, undefined, ON).language).toBe(true);
    // a request with none of them says none of them
    expect(buildRequestContract(TOPIC, undefined, ON)).toMatchObject({ period: false, country: false, language: false });
  });
  it("ON: a country is the Ask's only when the words use a locative with a country; the topic «عن مصر» keeps its place as the topic", () => {
    expect(ask("هات تعليقات فيديوهات تيك توك عن مصر", ON).country).toBeNull();
    expect(ask("هات تعليقات فيديوهات تيك توك عن مصر", ON).topic.text).toBe("مصر");
    expect(ask(`${TOPIC} في مصر`, ON)).toMatchObject({ country: "EG", topic: { text: "السياحة" } });
    expect(ask(`${TOPIC} فمصر`, ON)).toMatchObject({ country: "EG", topic: { text: "السياحة" } });
    expect(ask(`${TOPIC} بالسعوديه`, ON).country).toBe("SA");
  });
  it("ON: the report language is not the data's language; an unsupported language and two countries are clarifications on the Ask, not values", () => {
    expect(ask(`${TOPIC} والتقرير بالانجليزي`, OFF).language).toBe("en"); // today: a report language silently filters the DATA to English
    const on = ask(`${TOPIC} والتقرير بالانجليزي`, ON);
    expect(on.language).toBeNull();
    expect(on.reportLanguage).toBe("en");
    expect(ask(`${TOPIC} بالفرنسي`, OFF).language).toBe("ar"); // today: French is silently Arabic
    const fr = ask(`${TOPIC} بالفرنسي`, ON);
    expect(fr.language).toBeNull();
    expect(fr.clarify).toEqual([{ code: "language_unsupported", field: "language" }]);
    const two = ask(`${TOPIC} في مصر والسعودية`, ON);
    expect(two.country).toBeNull();
    expect(two.clarify).toEqual([{ code: "country_many", field: "country" }]);
  });
  it("ON: the customer's answer to the question joins the request: a year, a country, a language", () => {
    expect(buildAsk(`${TOPIC} في ديسمبر`, null, NOW, {}, ON).clarify).toEqual([{ code: "period_year", field: "period" }]);
    const answered = buildAsk(`${TOPIC} في ديسمبر`, "٢٠٢٥", NOW, {}, ON);
    expect(answered.clarify).toBeUndefined();
    expect(rangeOf(answered)).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(buildAsk(`${TOPIC} في مصر والسعودية`, "السعودية", NOW, {}, ON)).toMatchObject({ country: "SA" });
    expect(buildAsk(`${TOPIC} بالفرنسي`, "بالعربي", NOW, {}, ON)).toMatchObject({ language: "ar" });
  });
  it("the card's own edit of a field answers its clarification (an edit that clears the field too)", () => {
    const base = buildAsk(`${TOPIC} في مصر والسعودية بالفرنسي من نوفمبر لحد فبراير`, null, NOW, {}, ON);
    expect(base.clarify?.map((c) => c.field).sort()).toEqual(["country", "language", "period"]);
    let a = applyAskEdit(base, { field: "country", value: "EG" } as never, { nowMs: NOW });
    expect(a.ok && a.ask.clarify?.map((c) => c.field).sort()).toEqual(["language", "period"]);
    a = applyAskEdit(a.ok ? a.ask : base, { field: "language", value: "any" } as never, { nowMs: NOW });
    a = applyAskEdit(a.ok ? a.ask : base, { field: "period", value: { from: "2025-11-01", to: "2026-02-28" } } as never, { nowMs: NOW });
    expect(a.ok && a.ask.clarify).toBeUndefined();
  });
});

// ---- 13. the 98-scenario baseline ----------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("PR-1.3 measured on the 98-scenario baseline through the real contract and Ask (the same measure as PR-1.2)", () => {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const run = (c: Case, options: { semantic?: boolean }) => understand(c.text, c.answer ?? null, NOW, options);
  const outcome = (c: Case): "fixed" | "partial" | "unchanged" | "changed_still_wrong" | "regression" | "ok" => {
    const off = run(c, OFF);
    const on = run(c, ON);
    const keys = Object.keys(c.expected) as Array<keyof Understood>;
    const rightOff = keys.filter((k) => same(off[k], c.expected[k]));
    const rightOn = keys.filter((k) => same(on[k], c.expected[k]));
    if (!c.known_gap) return rightOn.length === keys.length ? "ok" : "regression";
    if (rightOn.length === keys.length) return "fixed";
    if (rightOn.length > rightOff.length) return "partial";
    return same(on, off) ? "unchanged" : "changed_still_wrong";
  };
  /** The 23 fixed by PR-1.2: every one must still be fixed. */
  const FIXED_BY_PR_1_2 = ["sa-01", "sa-02", "sa-03", "sa-08", "sb-09", "pl-04", "pl-05", "pl-07", "pl-11", "pl-14", "pl-16", "pl-17", "pl-22", "pl-24", "pl-25", "cm-02", "cm-05", "cm-06", "cm-09", "ct-07", "rt-04", "rt-05", "mt-09"];
  /** Fixed by this PR (14): the L4 dates, countries and languages, plus the period leaking into the topic (L5). */
  const FIXED_BY_PR_1_3 = ["dt-02", "dt-04", "dt-07", "dt-08", "dt-09", "dt-10", "dt-11", "ct-04", "ct-05", "ct-10", "pl-21", "pl-23", "sb-01", "sb-02"];
  const PARTIAL = ["sa-04", "sa-06", "pl-15"];

  it("OFF: the known gaps are all still gaps, exactly as PR #446 pinned them (62 originally; PR-1.4 closed the 7 pre-filter ones in the chat path, 55 remain)", () => {
    expect(baselineCases).toHaveLength(98);
    expect(baselineCases.filter((c) => c.known_gap)).toHaveLength(55);
    expect(baselineCases.filter((c) => c.closed_gap).map((c) => c.id)).toEqual(["pf-01", "pf-02", "pf-03", "pf-04", "pf-05", "pf-08", "pf-09"]);
    for (const c of baselineCases.filter((x) => x.known_gap)) for (const [k, v] of Object.entries(c.known_gap!.observed)) expect(run(c, OFF)[k as keyof Understood], `${c.id}.${k}`).toEqual(v);
  });
  it("ON: 37 of the 55 remaining gaps are fixed (the 23 of PR-1.2, still fixed, and the 14 of PR-1.3), 3 improve partly, 15 are untouched, and NONE regresses or changes wrongly (PR-1.4 closed pf-02 and six more in the chat path)", () => {
    const gaps = baselineCases.filter((c) => c.known_gap);
    const by = (k: string) => gaps.filter((c) => outcome(c) === k).map((c) => c.id);
    expect(by("fixed")).toEqual([...FIXED_BY_PR_1_2, ...FIXED_BY_PR_1_3].sort((a, b) => baselineCases.findIndex((c) => c.id === a) - baselineCases.findIndex((c) => c.id === b)));
    for (const id of FIXED_BY_PR_1_2) expect(outcome(baselineCases.find((c) => c.id === id)!), id).toBe("fixed");
    expect(by("partial")).toEqual(PARTIAL);
    expect(by("changed_still_wrong")).toEqual([]); // pf-02 (the placeholder pre-filter, W1) was the only one: PR-1.4 fixed it in the chat path
    expect(by("unchanged")).toHaveLength(55 - 37 - 3);
    expect(baselineCases.filter((c) => !c.known_gap && outcome(c) === "regression").map((c) => c.id)).toEqual([]);
  });
  it("every date, country and language scenario of the baseline (the 36 not-gap ones included) holds with the flag ON: the controls dt-01, dt-03, ct-01, ct-03, ct-08 stay right", () => {
    for (const c of baselineCases.filter((x) => /^(dt|ct)-/.test(x.id) || ["sb-01", "sb-02", "pl-21", "pl-23"].includes(x.id))) expect(outcome(c) === "fixed" || outcome(c) === "ok" || outcome(c) === "partial", c.id).toBe(true);
    for (const id of ["dt-01", "dt-03", "ct-01", "ct-03", "ct-08"]) expect(outcome(baselineCases.find((c) => c.id === id)!), id).toBe("ok");
  });
  it("pl-21 («هات تعليقات tiktok about tourism in Egypt»): the discrepancy is closed: the topic keeps «tourism», the country is Egypt, comments are asked, the platform is TikTok", () => {
    const c = baselineCases.find((x) => x.id === "pl-21")!;
    expect(run(c, OFF)).toMatchObject({ country: null, country_present: false });
    expect(run(c, ON)).toMatchObject({ platform: "tiktok", comments: "some", country: "EG", country_present: true, topic: "tourism", route: "compiled" });
  });
  it("the pre-filters, the privacy guard and the message type of every scenario are the same ON and OFF (the reading is not in front of them)", () => {
    for (const c of baselineCases) { expect(run(c, ON).prefilter, c.id).toBe(run(c, OFF).prefilter); expect(run(c, ON).message_type, c.id).toBe(run(c, OFF).message_type); }
  });
  it("ordinary customers: with the flag OFF (the production setting) the number of cases changed for them is ZERO", () => {
    let changed = 0;
    for (const c of baselineCases) if (!same(run(c, OFF), understand(c.text, c.answer ?? null))) changed += 1;
    expect(changed).toBe(0);
  });
  it("a scenario the old parser read RIGHT is never changed by the new reader (a field the parser filled and the reader leaves alone stays equal)", () => {
    for (const c of baselineCases.filter((x) => !x.known_gap)) {
      const off = run(c, OFF);
      const on = run(c, ON);
      for (const k of ["period", "country", "language"] as const) expect(on[k], `${c.id}.${k}`).toEqual(off[k]);
    }
  });
});

// ---- 14. the worker's own planning run ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe("PR-1.3 in the worker's own planning run (runPlanning over the stored live pages): the plan, its stated conditions and its execution parameters", () => {
  const TT = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم";
  const base = { fixture: M12, answer: NO_ABOUT_OPTIONS_AR.useAsIs, createdAt: "2026-11-02T11:35:00Z", platform: "tiktok" as const, planningAt: "2026-11-02T11:36:00Z" };
  const plan = (request: string, settings?: Record<string, unknown>, answer?: string, runState?: Record<string, unknown>): Promise<ProductionPlanning> => runProductionPlanning({ ...base, ...(answer !== undefined ? { answer } : {}), request, ...(settings ? { settings } : {}), ...(runState ? { runState } : {}) });
  /** The run note after the worker asked the clarification question once (the answer is then read by the worker and kept with the choices). */
  const ASKED = { pending: "conditions", questionsAsked: 1 };
  const params = (p: ProductionPlanning) => (p.plan?.stages ?? []).map((s) => ({ key: s.key, endpoint: s.endpoint_id, rows: s.planned_rows, params: s.engine?.params ?? null, parent: s.parent_key }));
  const FLAG_ON = { semantic_normalization_v1: true };
  const summary = (p: ProductionPlanning): string => String((p.plan as { summary_ar?: string } | null)?.summary_ar ?? "");
  const notes = (p: ProductionPlanning): string[] => ((p.plan as { notes_ar?: string[] } | null)?.notes_ar ?? []);
  let original: ProductionPlanning;
  beforeAll(async () => { original = await plan(TT); }, 120_000);

  it("«فمصر»: OFF the country is dropped and the provider is asked WITHOUT it (no stored page answers: the run fails); ON it is the same plan, the same provider inputs (region EG) and the same price as «من مصر»", async () => {
    const spelled = TT.replace("من مصر", "فمصر");
    expect((await plan(spelled)).status).toBe("failed");
    const on = await plan(spelled, FLAG_ON);
    expect(on.status).toBe("plan_ready");
    expect(params(on)).toEqual(params(original));
    expect(params(on)[0].params).toMatchObject({ region: "EG" });
    expect(summary(on)).toBe(summary(original));
    expect(on.mission.reserved_points).toEqual(original.mission.reserved_points);
    expect(on.mission.unit_price_points).toEqual(original.mission.unit_price_points);
    expect(on.providerCalls.map((c) => [c.endpointId, c.params])).toEqual(original.providerCalls.map((c) => [c.endpointId, c.params]));
  }, 120_000);

  it("«باللغة العربية» / «بالعربية»: the same plan as «بالعربي», ON and OFF (the existing language reading is kept)", async () => {
    for (const settings of [undefined, FLAG_ON]) {
      const r = await plan(TT.replace("بالعربي", "باللغة العربية"), settings);
      expect(params(r)).toEqual(params(original));
      expect(summary(r)).toBe(summary(original));
    }
  }, 120_000);

  it("«آخر تلات شهور»: OFF the period is dropped silently; ON it is the SAME plan as «آخر ٣ شهور» (the stated period, the same provider inputs and the same price)", async () => {
    const spoken = TT.replace("من مصر", "من مصر آخر تلات شهور");
    const digits = TT.replace("من مصر", "من مصر آخر ٣ شهور");
    const off = await plan(spoken);
    expect(summary(off)).not.toMatch(/بين/);
    const on = await plan(spoken, FLAG_ON);
    const reference = await plan(digits);
    expect(summary(on)).toContain("بين ٢٠٢٦-٠٨-٠٢ و٢٠٢٦-١١-٠٢");
    expect(summary(on)).toBe(summary(reference));
    expect(params(on)).toEqual(params(reference));
    expect(on.mission.reserved_points).toEqual(reference.mission.reserved_points);
    expect(on.mission.unit_price_points).toEqual(reference.mission.unit_price_points);
  }, 120_000);

  it("«من ١ لـ ١٥ أكتوبر ٢٠٢٦» and «من يناير لحد مارس ٢٠٢٦»: OFF the plan states the WIDENED month and the NARROWED month; ON it states the range the customer wrote", async () => {
    const a = TT.replace("من مصر", "من مصر من ١ لـ ١٥ أكتوبر ٢٠٢٦");
    const b = TT.replace("من مصر", "من مصر من يناير لحد مارس ٢٠٢٦");
    expect(summary(await plan(a))).toContain("بين ٢٠٢٦-١٠-٠١ و٢٠٢٦-١٠-٣١");
    expect(summary(await plan(a, FLAG_ON))).toContain("بين ٢٠٢٦-١٠-٠١ و٢٠٢٦-١٠-١٥");
    expect(summary(await plan(b))).toContain("بين ٢٠٢٦-٠١-٠١ و٢٠٢٦-٠١-٣١");
    expect(summary(await plan(b, FLAG_ON))).toContain("بين ٢٠٢٦-٠١-٠١ و٢٠٢٦-٠٣-٣١");
    // the stored plan carries the period as a filter of its stage and in its compiled conditions (the execution never re-reads the words)
    const stored = await plan(a, FLAG_ON);
    expect(stored.plan?.compiled?.conditions).toMatchObject({ period: true });
    expect(JSON.stringify(stored.plan?.stages ?? [])).toContain("2026-10-15");
  }, 120_000);

  it("a year that cannot be inferred is asked BEFORE any plan, price or reservation; the customer's year then plans it; OFF plans the guessed year without asking", async () => {
    const dec = TT.replace("من مصر", "من مصر في ديسمبر");
    const off = await plan(dec);
    expect(summary(off)).toContain("بين ٢٠٢٦-١٢-٠١ و٢٠٢٦-١٢-٣١"); // today's silent guess: a month that has not happened yet
    const asked = await plan(dec, FLAG_ON, "");
    expect(asked.status).toBe("needs_input");
    expect(asked.question).toBe(CLARIFY_QUESTION_AR.period_year);
    expect(asked.plan).toBeNull();
    expect(asked.mission.reserved_points ?? null).toBeNull();
    // the year is taken from the answer (the worker keeps it with the choices): the clarification is NOT asked again; the mission goes on to its next question, if it has one
    const answered = await plan(dec, FLAG_ON, "٢٠٢٥", ASKED);
    expect(answered.question).not.toBe(CLARIFY_QUESTION_AR.period_year);
    const planned = await plan(dec, FLAG_ON, NO_ABOUT_OPTIONS_AR.useAsIs, { choices: { conditionsAnswer: "٢٠٢٥" }, questionsAsked: 2 });
    expect(summary(planned)).toContain("بين ٢٠٢٥-١٢-٠١ و٢٠٢٥-١٢-٣١");
    expect(planned.mission.reserved_points).toEqual(off.mission.reserved_points); // a different period, the same provider inputs and the same price
    const crossing = await plan(TT.replace("من مصر", "من مصر من نوفمبر لحد فبراير"), FLAG_ON, "");
    expect(crossing.status).toBe("needs_input");
    expect(crossing.question).toBe(CLARIFY_QUESTION_AR.period_crossing);
  }, 120_000);

  it("two countries and an unsupported language are asked before any plan (OFF: the plan silently keeps the first country, or silently filters French as Arabic)", async () => {
    const two = TT.replace("من مصر", "من مصر ومن السعودية");
    expect((await plan(two)).status).toBe("plan_ready");
    expect(params(await plan(two))[0].params).toMatchObject({ region: "EG" });
    const askedCountry = await plan(two, FLAG_ON, "");
    expect(askedCountry.status).toBe("needs_input");
    expect(askedCountry.question).toBe(CLARIFY_QUESTION_AR.country_many);
    expect(askedCountry.plan).toBeNull();
    const fr = TT.replace("بالعربي", "بالفرنسي");
    expect(summary(await plan(fr))).toContain("بالعربية");
    const askedLanguage = await plan(fr, FLAG_ON, "");
    expect(askedLanguage.status).toBe("needs_input");
    expect(askedLanguage.question).toBe(CLARIFY_QUESTION_AR.language_unsupported);
    // answered with one country / one language, the plan is the ordinary one
    expect((await plan(two, FLAG_ON, "السعودية", ASKED)).question).not.toBe(CLARIFY_QUESTION_AR.country_many);
    // the provider is asked with the ONE country the customer chose (no stored page answers Saudi Arabia, so the run itself cannot plan: the inputs are the evidence)
    const sa = await plan(two, FLAG_ON, NO_ABOUT_OPTIONS_AR.useAsIs, { choices: { conditionsAnswer: "السعودية" }, questionsAsked: 2 });
    expect(sa.providerCalls[0].params).toMatchObject({ region: "SA" });
    expect(summary(await plan(fr, FLAG_ON, NO_ABOUT_OPTIONS_AR.useAsIs, { choices: { conditionsAnswer: "بالعربي" }, questionsAsked: 2 }))).toBe(summary(original));
  }, 120_000);

  it("the customer's answer is KEPT: a later question's answer replaces the mission's answer text, and the period, the country and the language still hold", async () => {
    const dec = TT.replace("من مصر", "من مصر في ديسمبر");
    // the answer text is now the answer of ANOTHER question (the topic one); the year typed earlier is in the run note's choices
    const later = await plan(dec, FLAG_ON, NO_ABOUT_OPTIONS_AR.useAsIs, { choices: { conditionsAnswer: "٢٠٢٥" }, questionsAsked: 2 });
    expect(summary(later)).toContain("بين ٢٠٢٥-١٢-٠١ و٢٠٢٥-١٢-٣١");
    // without the kept answer the same request is asked again (nothing is guessed)
    const lost = await plan(dec, FLAG_ON, NO_ABOUT_OPTIONS_AR.useAsIs, { questionsAsked: 2 });
    expect(lost.status).toBe("needs_input");
    expect(lost.question).toBe(CLARIFY_QUESTION_AR.period_year);
    // after three questions the request ends honestly instead of a fourth
    const spent = await plan(dec, FLAG_ON, NO_ABOUT_OPTIONS_AR.useAsIs, { questionsAsked: 3 });
    expect(spent.status).not.toBe("plan_ready");
    expect(spent.plan).toBeNull();
    expect(spent.mission.reserved_points ?? null).toBeNull();
  }, 120_000);

  it("a REPORT language is not a filter of the data: OFF the English report filters the DATA to English; ON no language filter, and the plan SAYS the report stays Arabic", async () => {
    const report = TT.replace("بالعربي", "والتقرير بالانجليزي");
    const off = await plan(report);
    expect(notes(off).join(" ")).toMatch(/اللغة: اخترنا/);
    const on = await plan(report, FLAG_ON);
    expect(summary(on)).not.toMatch(/بالعربية|بالإنجليزية/);
    expect(notes(on).join(" ")).not.toMatch(/اللغة: اخترنا/);
    expect(notes(on).join(" ")).toMatch(/لغة التقرير/);
    expect(on.mission.reserved_points).toEqual(off.mission.reserved_points);
  }, 120_000);

  it("a request that names none of the three is planned identically ON and OFF", async () => {
    const plain = TT.replace("بالعربي ", "").replace("من مصر", "من مصر");
    const off = await plan(plain);
    const on = await plan(plain, FLAG_ON);
    expect(params(on)).toEqual(params(off));
    expect(summary(on)).toBe(summary(off));
  }, 120_000);

  it("no new stage, no new charge: the plan ON has no stage OFF's equivalent lacks, and nothing is reserved while a question is open", async () => {
    const spoken = TT.replace("من مصر", "من مصر آخر تلات شهور");
    const on = await plan(spoken, FLAG_ON);
    expect(params(on).map((s) => s.endpoint)).toEqual(params(original).map((s) => s.endpoint));
    const asked = await plan(TT.replace("من مصر", "من مصر في ديسمبر"), FLAG_ON, "");
    expect(asked.mission.reserved_points ?? null).toBeNull();
    expect(asked.mission.unit_price_points ?? null).toBeNull();
  }, 120_000);
});

// ---- 15. privacy and the flag ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("PR-1.3 privacy and the flag: the guard is independent, the conditions reader is behind the same flag, and a customer's words cannot switch it", () => {
  const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  it("the privacy rules, the chat, mission creation and the message type do not import or read the conditions reader", () => {
    for (const f of ["src/lib/agentMission/guardRules.ts", "src/lib/agentMission/chatTurn.ts", "src/lib/agentMission/customerActions.ts", "src/lib/agentMission/messageType.ts"]) {
      expect(read(f), f).not.toMatch(/semantic\/conditions|semantic\/|readConditions|semantic_normalization_v1/);
    }
  });
  it("a refused private-data request is refused with the flag OFF and with dates, a country and a language added to it (the reading can never override a refusal)", () => {
    for (const t of ["اقرألي رسايل الواتساب بتاعتي", "اقرأ محادثات تليجرام في مصر آخر ٣ شهور بالعربي"]) {
      const refused = preModelAnswer(t);
      expect(refused, t).not.toBeNull();
      expect(preModelAnswer(`${t} من ١ لـ ١٥ أكتوبر في السعودية بالانجليزي`), t).not.toBeNull();
    }
  });
  it("OFF is byte for byte: no condition is read, whatever the request says (the contract of every baseline scenario is the plain contract)", () => {
    for (const c of baselineCases) expect(buildRequestContract(c.text, c.answer ?? undefined, OFF), c.id).toEqual(buildRequestContract(c.text, c.answer ?? undefined));
  });
  it("the customer's words cannot switch the feature: a request that says «semantic_normalization_v1» or «semantic» is read as written with the flag OFF", () => {
    const t = `${TOPIC} semantic_normalization_v1 on semantic true اخر تلات شهور`;
    expect(understand(t, null, NOW, OFF).period).toBeNull();
    expect(understand(t, null, NOW).period).toBeNull();
  });
  it("the reader holds no clock, no network and no setting: the same inputs always give the same reading, and the reference moment decides every relative day", () => {
    const src = read("src/lib/agentMission/semantic/conditions.ts");
    expect(src).not.toMatch(/Date\.now\(|new Date\(\)|process\.env|fetch\(|from "node:|require\(/);
    expect(readConditions("آخر ٣ شهور", null, NOW)).toEqual(readConditions("آخر ٣ شهور", null, NOW));
    expect(readConditions("آخر ٣ شهور", null, at("2027-01-31T09:00:00Z")).period).toEqual(range("2026-10-31", "2027-01-31"));
  });
});
