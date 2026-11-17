import { toArabicDigits } from "./arabicDigits";
import { ALL_CUSTOMER_STRINGS } from "./multiProvider/copy";
import { PROVIDER_BUSY_AR, PROVIDER_GENERIC_FAILURE_AR, PROVIDER_INCOMPATIBLE_ANSWER_AR, PROVIDER_INPUT_REJECTED_AR, PROVIDER_ROUTE_COST_EXCEEDED_AR, PROVIDER_TARGET_NOT_FOUND_AR, PROVIDER_TIMEOUT_AR, PROVIDER_UNAVAILABLE_AR } from "./providerFailureText";

/** DT-20261117-06 M1 (D-0031): the ONE neutral reason when a release has no reviewed cause, and the ONE neutral cause shown for a retried chunk. Never built from an error object. */
export const RELEASE_NEUTRAL_REASON_AR = "توقفت المعالجة بسبب خلل تقني من جانبنا قبل اكتمال العدد.";
export const RETRY_CAUSE_AR = "حدث خلل تقني من جانبنا أثناء معالجة هذه الدفعة.";
/** The two reasons the worker itself throws today (literals reviewed against DIGER-TRUTH §6: Arabic, no Latin letter, no provider name, no money claim). */
export const REASON_AR = {
  collection_unverified: "تعذر التحقق من اكتمال جمع البيانات قبل التسوية.",
  provider_unavailable: "تعذر استخراج البيانات من المصدر بعد عدة محاولات.",
} as const;
export type ReasonCode = keyof typeof REASON_AR;

/** The only error class whose text may reach a customer: its code is from a closed union mapped to the reviewed constants above (`textAr` is overridden only by adapterStopError). */
export class CustomerReasonError extends Error {
  constructor(readonly code: ReasonCode, readonly textAr: string = REASON_AR[code]) {
    super(textAr);
  }
}

/** The adapter's own reviewed sentences (V-7, v8 X-1): the eight constants of providerFailureText.ts and the one text socialAdapter.ts returns for an incompatible answer (the base sentence plus one full stop, admitted unchanged). All are Arabic with no Latin letter, no provider name, no amount and no release claim. Not exported. Membership is an array lookup by string equality. If the social adapter's sentence changes, this list must change with it (guard T1). */
const REVIEWED_ADAPTER_AR: readonly string[] = [PROVIDER_ROUTE_COST_EXCEEDED_AR, PROVIDER_UNAVAILABLE_AR, PROVIDER_TARGET_NOT_FOUND_AR, PROVIDER_INPUT_REJECTED_AR, PROVIDER_BUSY_AR, PROVIDER_GENERIC_FAILURE_AR, PROVIDER_TIMEOUT_AR, PROVIDER_INCOMPATIBLE_ANSWER_AR, `${PROVIDER_INCOMPATIBLE_ANSWER_AR}.`];

/** The text tregAdapter.ts returns for the incompatible-answer stop BEFORE any release (W-1). Not exported. It is never stored or shown: it is only the key of the one exact mapping in adapterStopError. */
const ADAPTER_STOPPED_AND_RELEASED_AR = `${PROVIDER_INCOMPATIBLE_ANSWER_AR}؛ تم إيقاف الطلب: حجز مؤقت مُحرَّر.`;

/** An adapter's `errorMessageAr` is kept ONLY when it is exactly one of the reviewed copy.ts strings (DT-04's `ok:false` constants) or one of the reviewed adapter sentences above; anything else, a provider string included, becomes the constant. The one composed text of tregAdapter.ts maps to the bare base sentence (W-1: nothing is released when the adapter returns, so no release claim is kept). Exact equality only, never `includes`, no trimming. */
export function adapterStopError(messageAr: unknown): CustomerReasonError {
  if (messageAr === ADAPTER_STOPPED_AND_RELEASED_AR) return new CustomerReasonError("provider_unavailable", PROVIDER_INCOMPATIBLE_ANSWER_AR);
  return typeof messageAr === "string" && (ALL_CUSTOMER_STRINGS().includes(messageAr) || REVIEWED_ADAPTER_AR.includes(messageAr))
    ? new CustomerReasonError("provider_unavailable", messageAr)
    : new CustomerReasonError("provider_unavailable");
}

/** The cause shown for a retry: a CustomerReasonError's reviewed text, otherwise the neutral constant. It NEVER reads the text of any other error. */
export function trustedCauseAr(err: unknown): string {
  return err instanceof CustomerReasonError ? err.textAr : RETRY_CAUSE_AR;
}

/** (J): a held job that ends unsettled reads «المسلَّم ٠ من N مطلوب. السبب: …» when N is a valid positive integer, and the reason alone otherwise (no invented count). The input is trusted by construction (see the trusted-input list in the worker). */
export function releaseTextAr(reasonAr: string, target: unknown): string {
  const r = reasonAr.trim().replace(/^السبب:\s*/, "");
  if (r.startsWith("المسلَّم ")) return r;
  const n = Number(target);
  return Number.isSafeInteger(n) && n > 0 ? `المسلَّم ${toArabicDigits(0)} من ${toArabicDigits(n)} مطلوب. السبب: ${r}` : r;
}
