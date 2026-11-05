import { toArabicDigits } from "../../../src/lib/arabicDigits";
import { pointsAr } from "../../../src/lib/pointsFormat";

/**
 * MONEY PR 7a, PHASE 2B-1: THE CUSTOMER'S WORDS FOR HOW AN ADD-ON ENDED (docs/MONEY-PR-7A.md sections 2 and 4). Arabic only, Arabic-Indic numerals, no provider, no endpoint, no USD; every sentence says what happened to the
 * customer's points. They go to the add-on row's events (the screens of 2B-2 read them); a test runs every one through checkCustomerText. The numbers come from the settlement, never from a model.
 */
export const ADDON_DONE_AR = {
  /** An edit or a fix published: the new version number and what was charged. */
  versionDone: (version: number, charged: number) => `أُنشئت النسخة ${toArabicDigits(version)} من ملفك. خُصم ${pointsAr(charged)}، وعاد باقي الحجز إلى رصيدك.`,
  /** An edit that stopped before it finished: what was found was added, the rest says it was not searched. */
  versionPartial: (version: number, charged: number) => `توقّف التعديل قبل أن يكتمل، فأضفنا ما وجدناه فقط في النسخة ${toArabicDigits(version)}. خُصم ${pointsAr(charged)} مقابل ما اكتمل، وعاد باقي الحجز إلى رصيدك.`,
  dailyCap: "بلغت عمليات البحث حدّها لهذا اليوم، فتوقّف التعديل قبل أن يكتمل.",
  nothingFound: "لم نجد قيمًا جديدة لهذا التعديل، فلم نُنشئ نسخة جديدة. عاد الحجز كاملًا إلى رصيدك ولم يُخصم شيء.",
  reviewDone: (charged: number) => `اكتملت مراجعة الملف وتقريرها جاهز. خُصم ${pointsAr(charged)}.`,
  reviewFailed: "تعذّرت مراجعة هذه النسخة، فعاد الحجز كاملًا إلى رصيدك ولم يُخصم شيء.",
  reviewExists: "سبقت مراجعة هذه النسخة وتقريرها محفوظ بلا مقابل. عاد الحجز كاملًا إلى رصيدك ولم يُخصم شيء.",
  versionExists: "أُنشئت نسخة أحدث من ملفك قبل انتهاء هذا الطلب، فلم نُنشئ نسخة جديدة. عاد الحجز كاملًا إلى رصيدك ولم يُخصم شيء.",
  releasedEarlier: "أُعيد حجز هذا الطلب كاملًا إلى رصيدك لأنه لم يكتمل. لم يُخصم شيء.",
  planMismatch: "تعذّر تنفيذ هذا الطلب كما اعتُمد، فعاد الحجز كاملًا إلى رصيدك ولم يُخصم شيء.",
  chargedNotShown: "تعذّر إظهار نتيجة هذا الطلب، وأُبلغ فريقنا بالأمر ليراجعه.",
  paidPublishing: "اكتمل تنفيذ طلبك وخُصمت نقاطه، وجارٍ حفظ الملف. ستظهر النسخة الجديدة في قائمة نسخ ملفك تلقائيًا فور اكتمال الحفظ.",
  requeued: "تأجّل طلبك قليلًا وسيُستأنف تلقائيًا من حيث وصل.",
  stuck: "تعذّر إكمال هذا الطلب، فعاد الحجز كاملًا إلى رصيدك ولم يُخصم شيء.",
} as const;

