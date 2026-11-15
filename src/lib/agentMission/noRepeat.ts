/**
 * P0 (15 Nov 2026, live msn_dae6a9b770b0560709cc): «WITHOUT REPEATING» IS NEVER LEFT TO ONE MODEL FLAG. The customer wrote «هات 400 تغريدة تانية عن نفس الموضوع ومن نفس الحساب ومن غير تكرار.»; the chat model's summary said
 * «… مع استبعاد التغريدات التي سُلّمت سابقًا» but its brief left `exclude_delivered` unset, so the card recorded no earlier delivery and nothing in the worker would have kept the earlier tweet out of the new delivery and charge.
 * Code now also reads the requirement from the customer's OWN words of this request, and from the model's own summary when it states it: either one records the conversation's earlier missions on the card. The worker
 * still verifies them (this customer's completed missions that delivered something), so a false reading can only exclude what this customer already received.
 */
const MARKS = /[ً-ٰٟـ]/g;
const norm = (t: string): string => t.replace(MARKS, "").replace(/[إأآ]/g, "ا").replace(/ى/g, "ي").replace(/\s+/g, " ").trim();

/** The customer's own words ask not to receive again what was delivered: «من غير تكرار», «بدون تكرار», «من دون ما تكرر», «غير اللي استلمته», «without duplicates». */
const CUSTOMER_NO_REPEAT = /(?:من غير|من دون|بدون|بلا|دون)\s+(?:ما\s+)?(?:ت|ي)?(?:تكرار|تكرير|تكرر|كرر)|غير\s+(?:اللي|الي|التي|الذي|اللى)\s+(?:وصل|وصلت|وصلني|وصلتني|استلمت|استلمته|استلمتها|سلم|سلمت|خدت|اخدت|اخذت)|(?:مش|ما)\s+(?:عايز|عايزه|عاوز|ابغى|ابي|اريد)\s+(?:تكرار|نفس اللي)|without\s+(?:any\s+)?(?:repeat|repetition|duplicat)|no\s+duplicates?|not?\s+(?:the\s+)?same\s+(?:ones|tweets|posts)/i;
/** The model's own summary states the exclusion of what was delivered before («مع استبعاد التغريدات التي سُلّمت سابقًا», «من غير تكرار ما سُلّم سابقًا»). */
const SUMMARY_NO_REPEAT = /(?:استبعاد|من غير تكرار|دون تكرار|بدون تكرار)[^.،؛]{0,60}سلم/;

export function asksNoRepeat(customerWords: ReadonlyArray<string>, summary: string | null | undefined): boolean {
  if (customerWords.some((w) => CUSTOMER_NO_REPEAT.test(norm(w)))) return true;
  return typeof summary === "string" && SUMMARY_NO_REPEAT.test(norm(summary));
}
