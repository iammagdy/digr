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
export interface StagePromise {
  type: PromiseType; n: number; counter?: number;
  /** An open replies stage: the replies the comments read at planning say they have (their own counters), and how many comments those are. The rest of `n` is the estimate that sizes the hold. */
  counted?: number; counted_comments?: number;
}

/** The promise of a child stage that reads every child of the chosen parents: their counters when the parent card has one, else open. `cap`: the customer's edited number. */
export function childPromise(counters: ReadonlyArray<number | null>, cap: number | null, openMax: number): StagePromise {
  if (counters.length > 0 && counters.every((c) => c !== null && Number.isFinite(c))) {
    const counter = counters.reduce<number>((s, c) => s + (c ?? 0), 0);
    return cap !== null && cap < counter ? { type: "counter", n: Math.max(0, Math.floor(cap)), counter } : { type: "counter", n: counter, counter };
  }
  return { type: "open", n: Math.max(1, Math.floor(cap ?? openMax)) };
}

/**
 * The promise of a comments stage when the customer named a number FOR EACH parent («١٠٠ تعليق من كل فيديو»): each parent gives at most that number, and at most what its own
 * counter says it has; so the promise is the sum of min(number, counter) when every counter is known (type counter), else open with the number x the parents as its maximum.
 */
export function perParentPromise(counters: ReadonlyArray<number | null>, perParent: number, parents: number): StagePromise {
  const per = Math.max(1, Math.floor(perParent));
  if (counters.length > 0 && counters.every((c) => c !== null && Number.isFinite(c))) {
    return { type: "counter", n: counters.reduce<number>((s, c) => s + Math.min(per, Math.max(0, Math.floor(c ?? 0))), 0), counter: counters.reduce<number>((s, c) => s + (c ?? 0), 0) };
  }
  return { type: "open", n: per * Math.max(1, parents) };
}

/** The customer's sentence of a promise (Arabic, Arabic-Indic digits; no provider name, no price). `noun`: what is counted («تعليق», «رد»). */
export function promiseLineAr(p: StagePromise, what: "comments" | "replies", counterIncludesReplies: boolean, perParent: number | null = null, openPerParent: number | null = null): string {
  const n = toArabicDigits(p.n);
  if (what === "comments" && p.type === "open" && openPerParent !== null) return `التعليقات: حتى ${toArabicDigits(openPerParent)} تعليق من كل عنصر مختار، لأن المنصة لا تعرض عدد تعليقات العنصر قبل قراءته؛ أي ${n} تعليق على الأكثر، ونذكر في الملف ما سُلّم لكل عنصر.`;
  if (what === "comments" && perParent !== null) {
    const per = toArabicDigits(perParent);
    if (p.type === "counter" && p.counter !== undefined) return `التعليقات: حتى ${per} تعليق من كل عنصر مختار بحسب العدد الذي طلبته، أي ${n} تعليق على الأكثر، وعدّاد المنصة للعناصر المختارة ${toArabicDigits(p.counter)}${counterIncludesReplies ? " ويشمل الردود" : ""}.`;
    return `التعليقات: حتى ${per} تعليق من كل عنصر مختار بحسب العدد الذي طلبته، مما يعرضه المصدر.`;
  }
  if (what === "replies" && perParent !== null) return `الردود: حتى ${toArabicDigits(perParent)} من الردود على كل تعليق مختار، مما يعرضه المصدر، دون وعد بعدد قبل القراءة؛ والحد الأقصى المحسوب في الحجز ${n} ردّ.`;
  if (what === "comments") {
    if (p.type === "counter" && p.counter !== undefined && p.n < p.counter) return `التعليقات: ${n} تعليق بحسب العدد الذي اخترته، من أصل ${toArabicDigits(p.counter)} بحسب عدّاد المنصة للعناصر المختارة.`;
    if (p.type === "counter") return `التعليقات: كل تعليقات العناصر المختارة، وعددها بحسب عدّاد المنصة ${n}${counterIncludesReplies ? "، وهذا العدّاد يشمل الردود" : ""}. إن عرض المصدر أقل من العدّاد نذكر الفرق لكل عنصر.`;
    return `التعليقات: كل ما يعرضه المصدر من تعليقات على العناصر المختارة، بحد أقصى ${n} تعليق.`;
  }
  if (p.type === "open" && p.counted !== undefined && p.counted_comments !== undefined) {
    const open = Math.max(0, p.n - p.counted);
    const known = `${toArabicDigits(p.counted)} ردًا بحسب عدّادات ${toArabicDigits(p.counted_comments)} تعليقًا قرأناها`;
    return `الردود: كل ما يعرضه المصدر من ردود على كل تعليق مختار، دون حد لعدد الردود على التعليق الواحد. ${open > 0 ? `${known}، وحتى ${toArabicDigits(open)} ردًا لتعليقات لم نقرأ عدّادها بعد` : known}، ولا ندفع إلا مقابل ما سُلّم.`;
  }
  return p.type === "open" ? `الردود: كل ما يعرضه المصدر من ردود على التعليقات، بحد أقصى ${n} ردّ.` : `الردود: ${n} ردّ بحسب عدّاد المنصة.`;
}
