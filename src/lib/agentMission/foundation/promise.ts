import { toArabicDigits } from "../../arabicDigits";

/**
 * F5, THE TYPED PROMISE: every stage's number has exactly one type, set by the compiler, and one fixed sentence.
 *  - `exact(n)`: the customer's own count (2 videos, 20 tweets);
 *  - `counter(n)`: the sum of the platform counters of the chosen, checked parents (capped by the customer's edited number when there is one);
 *  - `open`: no counter can give the number before approval; `n` is only the reserve's maximum (the charge never goes above the reserve), never a promise.
 * An estimate (a sample's mean, a model's number) is never a promise: there is no fourth type. Pure.
 */
export type PromiseType = "exact" | "counter" | "open";
export const PROMISE_TYPES: ReadonlyArray<PromiseType> = ["exact", "counter", "open"];
export interface StagePromise { type: PromiseType; n: number; counter?: number }

/** The promise of a child stage that reads every child of the chosen parents: their counters when the parent card has one, else open. `cap`: the customer's edited number. */
export function childPromise(counters: ReadonlyArray<number | null>, cap: number | null, openMax: number): StagePromise {
  if (counters.length > 0 && counters.every((c) => c !== null && Number.isFinite(c))) {
    const counter = counters.reduce<number>((s, c) => s + (c ?? 0), 0);
    return cap !== null && cap < counter ? { type: "counter", n: Math.max(0, Math.floor(cap)), counter } : { type: "counter", n: counter, counter };
  }
  return { type: "open", n: Math.max(1, Math.floor(cap ?? openMax)) };
}

/** The customer's sentence of a promise (Arabic, Arabic-Indic digits; no provider name, no price). `noun`: what is counted («تعليق», «رد»). */
export function promiseLineAr(p: StagePromise, what: "comments" | "replies", counterIncludesReplies: boolean): string {
  const n = toArabicDigits(p.n);
  if (what === "comments") {
    if (p.type === "counter" && p.counter !== undefined && p.n < p.counter) return `التعليقات: ${n} تعليق بحسب العدد الذي اخترته، من أصل ${toArabicDigits(p.counter)} بحسب عدّاد المنصة للعناصر المختارة.`;
    if (p.type === "counter") return `التعليقات: كل تعليقات العناصر المختارة، وعددها بحسب عدّاد المنصة ${n}${counterIncludesReplies ? "، وهذا العدّاد يشمل الردود" : ""}. إن عرض المصدر أقل من العدّاد نذكر الفرق لكل عنصر.`;
    return `التعليقات: كل ما يعرضه المصدر من تعليقات على العناصر المختارة، بحد أقصى ${n} تعليق.`;
  }
  return p.type === "open" ? `الردود: كل ما يعرضه المصدر من ردود على التعليقات، بحد أقصى ${n} ردّ.` : `الردود: ${n} ردّ بحسب عدّاد المنصة.`;
}
