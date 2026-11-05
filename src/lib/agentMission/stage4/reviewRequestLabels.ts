import { formatAr } from "../../arabicDigits";
import { pointsAr } from "../../pointsFormat";

/**
 * MONEY PR 7d, 2B-2 task 3 (docs/MONEY-PR-7A.md section 16): THE WORDS OF THE REVIEW REQUEST (client-safe: no server module, no price logic). The server answers a `ReviewRequestView` (the id, the version, the cells and the points it computed);
 * this file only turns it into Arabic. The browser never computes a price. Arabic only, Arabic-Indic numerals, no provider, no USD, no emoji.
 */
/** A review request that WAITS for approval: stored `plan_ready`, nothing held, nothing charged. */
export interface ReviewRequestView { id: string; version: number; cells: number; points: number; status: "plan_ready" }

export const REVIEW_PREPARE_BUTTON_AR = "تجهيز طلب المراجعة";
export const REVIEW_PREPARING_AR = "جارٍ تجهيز الطلب…";
export const REVIEW_CANCEL_BUTTON_AR = "إلغاء الطلب";
export const REVIEW_CANCELLING_AR = "جارٍ إلغاء الطلب…";
export const REVIEW_READY_AR = "طلب المراجعة جاهز.";
export const REVIEW_NOT_HELD_AR = "لم يُحجز أو يُخصم من رصيدك شيء.";
export const REVIEW_NEXT_STEP_AR = "يمكنك اعتماده في الخطوة التالية.";
export const REVIEW_CANCELLED_AR = "أُلغي طلب المراجعة. لم يُحجز أو يُخصم من رصيدك شيء.";

/** What the customer is told when a request cannot be made or cancelled: plain Arabic, no code, no id, no path, no provider. */
export const REVIEW_REQUEST_ERRORS_AR = {
  /** The same sentence as the add-on rules' `open_addon` (pinned equal by a test; this file must not import the money-side module). */
  open_addon: "لديك طلب مفتوح على هذا الملف؛ أكمله أو ألغه أولًا.",
  review_exists: "راجعنا هذه النسخة من قبل؛ سنعرض تقريرها بلا مقابل ولن يُخصم منك شيء مرة ثانية.",
  /** The same sentence as the add-on rules' `review_unresolved` (pinned equal by a test). It never says nothing was charged: an earlier review of this version WAS. */
  review_unresolved: "سُجّل خصم لمراجعة سابقة لهذه النسخة ولم يُنشر تقريرها بعد؛ سيراجع فريقنا الأمر.",
  too_large: "هذه النسخة أكبر من أن تُراجع مرة واحدة. لم يُحجز أو يُخصم شيء.",
  nothing_to_review: "لا توجد خانات في هذه النسخة لتُراجع. لم يُحجز أو يُخصم شيء.",
  changed: "تغيّرت حالة الطلب قبل أن نلغيه. حدّث الصفحة وحاول مرة أخرى.",
  not_found: "لم نجد هذه النسخة أو هذا الطلب.",
  unavailable: "تعذّر تجهيز الطلب الآن. حاول بعد قليل. لم يُحجز أو يُخصم شيء.",
  damaged: "تعذّر قراءة هذه النسخة. تواصل معنا إذا تكرر ذلك. لم يُحجز أو يُخصم شيء.",
  unauthorized: "انتهت جلستك. سجّل الدخول ثم حاول مرة أخرى.",
  network: "تعذّر الاتصال الآن. تحقق من اتصالك وحاول بعد قليل.",
} as const;

/** The lines of a waiting request: ready, which version, how many cells, the price, then that nothing was held or charged and what comes next. */
export const reviewRequestLinesAr = (r: ReviewRequestView): string[] => [
  REVIEW_READY_AR,
  `مراجعة النسخة ${formatAr(r.version)}`,
  `عدد الخانات التي ستُراجع: ${formatAr(r.cells)}`,
  `تكلفة المراجعة: ${pointsAr(r.points)}`,
  REVIEW_NOT_HELD_AR,
  REVIEW_NEXT_STEP_AR,
];
