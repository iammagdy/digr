import { formatAr } from "../../arabicDigits";
import { pointsAr } from "../../pointsFormat";
import type { VersionReason } from "./versions";

/**
 * MONEY PR 7c, 2B-2 task 2 (docs/MONEY-PR-7A.md section 15): THE WORDS OF THE REVIEW-PRICE PREVIEW (client-safe: no server module, no price logic). The server answers a `ReviewQuoteView` (the version, the cells, the points, or a state);
 * this file only turns it into Arabic. The browser never computes a price: the points shown are the points the server sent. Arabic only, Arabic-Indic numerals, no provider, no USD, no emoji.
 */
export type ReviewQuoteView =
  /** A review can be offered: `points` is the exact price of `cells` readable cells (the existing card). */
  | { state: "offer"; version: number; reason: VersionReason; cells: number; points: number }
  /** This version already has a completed review: its stored report is reused, with no second charge. */
  | { state: "reuse"; version: number; reason: VersionReason }
  /** An earlier review of this version was charged and its report is not published: no price is offered (safety fix B). */
  | { state: "unresolved"; version: number; reason: VersionReason }
  /** Another add-on is open on this file: nothing can be started now. */
  | { state: "blocked"; version: number; reason: VersionReason }
  /** Too many cells for one review (above the add-on hold ceiling), or no readable cell: no price is shown. */
  | { state: "too_large" | "nothing_to_review"; version: number; reason: VersionReason; cells: number };
export interface ReviewVersionChoice { version: number; reason: VersionReason }

export const REVIEW_HEADING_AR = "مراجعة الملف";
export const REVIEW_BUTTON_AR = "مراجعة الملف";
export const REVIEW_ASKING_AR = "جارٍ حساب التكلفة…";
export const REVIEW_INTRO_AR = "اعرف تكلفة مراجعة ملفك قبل أي خطوة. هذا عرض سعر فقط، ولا يُخصم منه شيء.";
export const REVIEW_PICK_AR = "النسخة المراد مراجعتها";
const NOTHING_CHARGED_AR = "لم يُخصم من رصيدك شيء.";
/** The same sentence as the add-on rules' `open_addon` (pinned equal by a test; this file must not import the money-side module). */
const OPEN_ADDON_AR = "لديك طلب مفتوح على هذا الملف؛ أكمله أو ألغه أولًا.";
/** The same sentence as the add-on rules' `review_unresolved` (pinned equal by a test). It never says nothing was charged: an earlier review of this version WAS. */
const UNRESOLVED_AR = "سُجّل خصم لمراجعة سابقة لهذه النسخة ولم يُنشر تقريرها بعد؛ سيراجع فريقنا الأمر.";

export const REVIEW_ERRORS_AR = {
  not_found: "هذه النسخة غير متاحة للمراجعة.",
  unavailable: "تعذّر حساب تكلفة المراجعة الآن. حاول بعد قليل. لم يُخصم شيء.",
  damaged: "تعذّر قراءة هذه النسخة. تواصل معنا إذا تكرر ذلك. لم يُخصم شيء.",
  unauthorized: "انتهت جلستك. سجّل الدخول ثم حاول مرة أخرى.",
  network: "تعذّر الاتصال الآن. تحقق من اتصالك وحاول بعد قليل.",
} as const;

/** The lines the customer reads under the button: the version, the cells, the price and that nothing was charged (an offer); or the one fact that stops an offer. */
export function reviewQuoteLinesAr(q: ReviewQuoteView): string[] {
  const n = formatAr(q.version);
  switch (q.state) {
    case "offer": return [`مراجعة النسخة ${n}`, `عدد الخانات التي ستُراجع: ${formatAr(q.cells)}`, `تكلفة المراجعة: ${pointsAr(q.points)}`, NOTHING_CHARGED_AR, "هذا عرض سعر فقط؛ لم تبدأ أي مراجعة."];
    case "reuse": return [`راجعنا النسخة ${n} من قبل.`, "تقرير المراجعة محفوظ، وسنعرضه لك بلا مقابل ولن يُخصم منك شيء مرة ثانية.", NOTHING_CHARGED_AR];
    case "blocked": return [OPEN_ADDON_AR, NOTHING_CHARGED_AR];
    case "unresolved": return [UNRESOLVED_AR];
    case "too_large": return [`النسخة ${n} أكبر من أن تُراجع مرة واحدة، ولذلك لا نعرض لها سعرًا.`, NOTHING_CHARGED_AR];
    case "nothing_to_review": return [`لا توجد خانات في النسخة ${n} لتُراجع.`, NOTHING_CHARGED_AR];
  }
}
