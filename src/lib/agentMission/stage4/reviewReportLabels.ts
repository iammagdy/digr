import { formatAr } from "../../arabicDigits";
import { versionTitleAr } from "./versionLabels";
import type { ReviewCode } from "./review";
import type { VersionReason } from "./versions";

/**
 * STAGE A: THE WORDS OF THE REVIEW REPORT (client-safe: no server module, no price logic; the two imports above are TYPES only). The server answers a `ReviewReportView` after it has checked the stored report against the version it reviewed; this file only turns it into Arabic.
 * It says what the score MEASURES (automated checks) and what it is NOT (proof that the research is true): a score of 100 is never described as proof. Arabic only, Arabic-Indic numerals, no provider, no price, no id, no emoji.
 * «الصفوف» is a spreadsheet word the customer-text rules forbid: the items of the file are «العناصر».
 */
export interface ReviewReportIssueView {
  code: ReviewCode;
  sheet: string;
  column: string;
  count: number;
  /** The review's own whitelisted sentence for this issue, in correct Arabic for the count (made on the server by `REVIEW_ISSUE_AR`). */
  textAr: string;
}
export interface ReviewReportView {
  /** The version that was reviewed. */
  version: number;
  reason: VersionReason;
  /** 0 to 100, as the review engine wrote it (a whole number). */
  score: number;
  /** The readable cells that were checked. */
  cells: number;
  /** The items of the file that were reviewed. */
  rowsReviewed: number;
  /** When the review was made (an ISO date). */
  reviewedAt: string;
  issues: ReviewReportIssueView[];
}

export const REPORT_HEADING_AR = "نتيجة مراجعة الملف";
export const REPORT_PICK_AR = "النسخة التي رُوجعت";
export const REPORT_ISSUES_HEADING_AR = "ما وجدته الفحوصات";
export const REPORT_LOADING_AR = "جارٍ تحميل نتيجة المراجعة…";
export const REPORT_RETRY_AR = "إعادة المحاولة";
export const REPORT_NO_ISSUES_AR = "لم تجد الفحوصات الآلية أي مشكلة.";
/** What the score is. Always shown. */
export const REPORT_SCOPE_AR = "هذه الدرجة تقيس الفحوصات الآلية فقط: الخانات الفارغة، وشكل الإيميل والهاتف والرابط والتاريخ، والتكرار. ولا تقيس صحة المعلومات ولا دقة البحث نفسه.";
/** What 100 is not. Shown whenever the score is 100. */
export const REPORT_FULL_SCORE_AR = "الدرجة ١٠٠ تعني أن الفحوصات الآلية لم تجد مشكلة، ولا تعني أن كل البيانات صحيحة.";
/** A stored report is shown again at no charge. */
export const REPORT_FREE_AR = "التقرير محفوظ، وعرضه مجاني ولن يُخصم منك شيء.";

/** What the customer is told when a report cannot be shown: plain Arabic, no code, no path, no provider. */
export const REPORT_ERRORS_AR = {
  not_found: "لم نجد تقرير مراجعة لهذه النسخة.",
  unavailable: "تعذّر تحميل نتيجة المراجعة الآن. حاول بعد قليل.",
  damaged: "تعذّر قراءة تقرير هذه المراجعة. تواصل معنا إذا تكرر ذلك.",
  unauthorized: "انتهت جلستك. سجّل الدخول ثم حاول مرة أخرى.",
  network: "تعذّر الاتصال الآن. تحقق من اتصالك وحاول بعد قليل.",
} as const;

/** The facts of the report, one line each: which version, the score out of 100, the cells checked, the items reviewed. */
export const reviewReportLinesAr = (r: ReviewReportView): string[] => [
  `${REPORT_PICK_AR}: ${versionTitleAr(r.version, r.reason)}`,
  `الدرجة: ${formatAr(r.score)} من ١٠٠`,
  `عدد الخانات التي فُحصت: ${formatAr(r.cells)}`,
  `عدد العناصر التي رُوجعت: ${formatAr(r.rowsReviewed)}`,
];

/** The picker's option: «النسخة ٣». */
export const reportVersionOptionAr = (version: number): string => `النسخة ${formatAr(version)}`;
