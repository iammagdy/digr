import { detectCountryFromText, isoCountryCodeFromName } from "../planParameters";
import { detectSocialIntent, socialLocationText, socialSubjectText, stripReportWords } from "../socialTasks";
import { regionNameAr } from "../regionNames";
import { reportCoverage } from "./registry";
import { resolveTimeWindow } from "../timeWindow";

/**
 * What the assistant asks, before a plan, when the request is a Facebook topic REPORT. The report needs a country (a Page is used only if its country matches the request) and
 * a period that the customer states: the period is never defaulted behind their back. Everything else (posts, comments per post) goes through the existing social discovery card.
 */
export const REPORT_COUNTRY_QUESTION_ID = "social_report_country_required";
export const REPORT_NOT_COVERED_ID = "report_not_covered";

export const isFacebookReportRequest = (text: string): boolean => detectSocialIntent(text).report === true;

/** The country code a request names as a LOCATION («في مصر»), or null. */
export function reportRegionOf(text: string): string | null {
  const country = detectCountryFromText(socialLocationText(text));
  return (country ? isoCountryCodeFromName(country.canonicalEnglish) : undefined) ?? null;
}

/** The topic of a report request: the subject words with the report words, the platform, the counts and the period taken out. */
export function reportTopicOf(text: string): string {
  return stripReportWords(socialSubjectText(text)).trim();
}

export const REPORT_COUNTRY_QUESTION_AR = "لأي دولة تريد التقرير؟ أغطّي حاليًا مصر، ولا أستخدم إلا صفحات الدولة التي تحددها.";
export const REPORT_COUNTRY_SKIPPED_AR = "أحتاج أن أعرف الدولة لأجهز لك التقرير. اكتبها في رسالتك، مثل «في مصر»، وسأكمل من حيث توقفنا.";

export function reportNotCoveredAr(regionAr: string | null, topic: string): string {
  return `تقرير فيسبوك الكامل متاح حاليًا لموضوعات الصحة في مصر فقط${regionAr || topic ? `، ولم أجد لدينا صفحات موثّقة تخص «${topic || "موضوعك"}»${regionAr ? ` في ${regionAr}` : ""}` : ""}. تقدر تطلب تعليقات منشورات فيسبوك عن موضوعك بلا كلمة «تقرير»، أو تغيّر الموضوع أو الدولة.`;
}

/**
 * The question or the plain message a report request needs BEFORE its plan, or null when country and coverage are settled. The period has its own question (asked by the existing
 * time-window rule, which treats a report like a feed search and never proposes a period unasked).
 */
export function reportGate(text: string, options: { countrySkipped?: boolean } = {}): any | null {
  const region = reportRegionOf(text);
  if (!region) {
    if (options.countrySkipped) return { plain: true, id: `skipped_${REPORT_COUNTRY_QUESTION_ID}`, text: REPORT_COUNTRY_SKIPPED_AR };
    return { id: REPORT_COUNTRY_QUESTION_ID, text: REPORT_COUNTRY_QUESTION_AR, question: REPORT_COUNTRY_QUESTION_AR, type: "single", options: ["مصر"], allowOther: true };
  }
  const topic = reportTopicOf(text);
  if (!reportCoverage({ country: region, topic }).covered) return { plain: true, id: REPORT_NOT_COVERED_ID, text: reportNotCoveredAr(regionNameAr(region), topic) };
  return null;
}

/** True when the report's period is not stated by the customer (dates, a relative period, a known event): the question is asked once. */
export const reportNeedsPeriod = (text: string): boolean => resolveTimeWindow(text, { needsWindow: true }).status === "missing";
