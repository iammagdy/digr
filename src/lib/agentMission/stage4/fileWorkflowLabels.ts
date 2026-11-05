import { formatAr } from "../../arabicDigits";
import { pointsAr } from "../../pointsFormat";

/**
 * STAGE C: THE WORDS OF THE FILE'S WORKFLOW STATUS (client-safe: no server module, no price logic). The server answers, for each request on the file, which PHASE it is in (decided there from the row and from what is VERIFIED published in storage); this file only turns it into Arabic.
 * The rules the words keep, each pinned by a test: «لم يُحجز أو يُخصم شيء» is said ONLY where nothing can have been held (a request still waiting with no approval attempt, or cancelled before one); a request whose approval may have moved money never says it; a payment line («سُجّل خصم») appears
 * only with a recorded charge; and success («اكتمل وسُلِّم») appears only for a request whose output is verified published. Arabic only, Arabic-Indic numerals, points (never a provider cost), no id, no emoji.
 */
export type AddonPhase =
  | "waiting_approval" | "approval_unverified" | "processing" | "delivered" | "charged_delivery_pending" | "failed_no_charge" | "cancelled" | "ended_unverified" | "delivery_pending";
export type WorkflowKind = "review" | "review_fix" | "edit";
export interface WorkflowItemView {
  kind: WorkflowKind;
  /** The version the request was made on. */
  version: number;
  /** The version an edit or a fix creates; null for a review. */
  newVersion: number | null;
  phase: AddonPhase;
  /** `processing` only: whether the hold is KNOWN (the request has a job). */
  held?: boolean;
  /** `delivered` and `charged_delivery_pending` only: the recorded charge in points. */
  chargedPoints?: number;
}
export interface FileWorkflowView { items: WorkflowItemView[] }

export const FILE_WORKFLOW_HEADING_AR = "حالة طلباتك على هذا الملف";
export const FILE_WORKFLOW_LOADING_AR = "جارٍ تحميل حالة الطلبات…";
export const FILE_WORKFLOW_RETRY_AR = "إعادة المحاولة";
export const FILE_WORKFLOW_NONE_AR = "لم تطلب مراجعة أو تعديلًا على هذا الملف بعد. تظهر لك التكلفة قبل أي خطوة، ولا يُخصم شيء قبل أن تعتمد.";
export const FILE_WORKFLOW_ERRORS_AR = {
  unavailable: "تعذّر تحميل حالة الطلبات الآن. حاول بعد قليل.",
  network: "تعذّر الاتصال الآن. تحقق من اتصالك وحاول بعد قليل.",
} as const;

const LABEL_AR: Readonly<Record<AddonPhase, string>> = {
  waiting_approval: "بانتظار اعتمادك",
  approval_unverified: "نتحقق من حالة الاعتماد",
  processing: "اعتُمد الطلب ويجري تنفيذه",
  delivered: "اكتمل وسُلِّم",
  charged_delivery_pending: "خُصم الطلب والتسليم لم يكتمل",
  failed_no_charge: "لم يكتمل الطلب",
  cancelled: "أُلغي الطلب",
  ended_unverified: "أُغلق الطلب",
  delivery_pending: "اكتمل التنفيذ ولم يُؤكَّد النشر",
};
export const workflowPhaseLabelAr = (phase: AddonPhase): string => LABEL_AR[phase];

const KIND_AR: Readonly<Record<WorkflowKind, string>> = { review: "مراجعة الملف", review_fix: "تصحيح بعد المراجعة", edit: "تعديل الملف" };
export const workflowItemTitleAr = (i: WorkflowItemView): string => `${KIND_AR[i.kind]} — النسخة ${formatAr(i.version)}`;

const chargeLine = (points: number | undefined): string | null => (points && points > 0 ? `سُجّل خصم ${pointsAr(points)} لهذا الطلب.` : null);

/** What the customer reads under a request's status: only what is known for that phase. */
export function workflowItemLinesAr(i: WorkflowItemView): string[] {
  switch (i.phase) {
    case "waiting_approval": return ["الطلب جاهز ولم يُحجز أو يُخصم شيء.", "لن يبدأ التنفيذ قبل أن تعتمد."];
    case "approval_unverified": return ["بدأت محاولة لاعتماد هذا الطلب ولم تكتمل. قد تكون نقاطك قد حُجزت مؤقتًا، ونتحقق من ذلك الآن.", "لن نعرض لك تأكيدًا قبل أن نتأكد."];
    case "processing": return [i.held === true ? "حُجزت نقاط الطلب مؤقتًا، ولن يُخصم إلا ما يُنجز." : "قد تكون نقاط الطلب حُجزت مؤقتًا، ولن يُخصم إلا ما يُنجز.", "لم يُنشر الناتج بعد، وسيظهر هنا عند اكتماله."];
    case "delivered": {
      const where = i.kind === "review" || i.newVersion === null ? "نتيجة المراجعة منشورة، وتجدها في قسم «نتيجة مراجعة الملف»." : `النسخة ${formatAr(i.newVersion)} منشورة وجاهزة للتنزيل من قائمة نسخ الملف.`;
      const charge = chargeLine(i.chargedPoints);
      return charge ? [where, charge] : [where];
    }
    case "charged_delivery_pending": return [chargeLine(i.chargedPoints) ?? "سُجّل أن هذا الطلب خُصم.", "لكن الناتج لم يُنشر بعد. نحاول إكماله، وسيراجع فريقنا الطلب إن لم يكتمل.", "لا تعتبر الطلب مكتملًا حتى يظهر ناتجه هنا."];
    case "failed_no_charge": return ["لم يُسجَّل أي خصم لهذا الطلب.", "يمكنك تقديم طلب جديد."];
    case "cancelled": return ["أُلغي الطلب قبل اعتماده. لم يُحجز أو يُخصم شيء."];
    case "ended_unverified": return ["أُغلق هذا الطلب بعد محاولة اعتماد. نتحقق من حالة نقاطك، ولن نؤكد شيئًا قبل أن نتأكد."];
    case "delivery_pending": return ["لم نجد الناتج منشورًا بعد، ولن نعرضه لك كمكتمل حتى يُنشر."];
  }
}
