/**
 * STAGE 2: the fixed Arabic words of the Stage 2 screens, in a file with NO imports so a browser component can read them without pulling server code into the page. Every one is checked by
 * `checkCustomerText` / `checkCustomerLabel` in tests/stage2-ask-card-ui.test.tsx.
 */
export const ASK_EDIT_RECEIVED_AR = "وصل تعديلك، ونجهّز الخطة من جديد.";
/** Owner decision 3 (docs/STAGE-2.md section 10): an edit that needs a new read is allowed, with this line. */
export const ASK_EDIT_NEW_READ_AR = "سنقرأ النتائج من جديد بعد هذا التعديل.";
export const ASK_CARD_EDIT_AR = "تعديل";
export const ASK_CARD_SAVE_AR = "حفظ";
export const ASK_CARD_CANCEL_AR = "إلغاء";
export const ASK_CARD_NO_PERIOD_AR = "بدون فترة";
export const ASK_CARD_FROM_AR = "من";
export const ASK_CARD_TO_AR = "إلى";
export const ASK_CARD_CLEAR_AR = "بدون";
/** A typed value the card's own check refuses before it is sent (the server checks again). */
export const ASK_CARD_BAD_NUMBER_AR = "اكتب رقمًا صحيحًا داخل الحدود المعروضة.";
