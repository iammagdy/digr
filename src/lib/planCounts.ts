import { toArabicDigits } from "./arabicDigits";

/**
 * The count of a plan, written ONCE. A plan of several services (posts, then their comments) has one count per service, and every place that
 * shows the size of the plan (the card's title, the scope chip, the chat summary, the edit confirmation) reads this one function, so the
 * title can never say one number while the body says another. One service keeps the plain «حتى N سجل».
 */
export interface CountedPlanItem {
  capabilitySlug?: string;
  endpointId?: string;
  slug?: string;
  targetVolumeMax?: number;
}

export type CountKind = "posts" | "comments" | "videos" | "companies" | "people" | "records";

export function countKindOfSlug(rawSlug: string | undefined | null): CountKind {
  const slug = String(rawSlug || "").toLowerCase();
  if (/comment/.test(slug)) return "comments";
  if (/compan|b2b/.test(slug)) return "companies";
  if (/people|person|decision/.test(slug)) return "people";
  if (/video|tiktok|youtube|reel/.test(slug)) return "videos";
  if (/post|x-/.test(slug)) return "posts";
  return "records";
}

const FORMS: Record<CountKind, [one: string, two: string, few: string, many: string]> = {
  posts: ["منشور واحد", "منشورين", "منشورات", "منشورًا"],
  comments: ["تعليق واحد", "تعليقين", "تعليقات", "تعليقًا"],
  videos: ["فيديو واحد", "فيديوهين", "فيديوهات", "فيديو"],
  companies: ["شركة واحدة", "شركتين", "شركات", "شركة"],
  people: ["شخص واحد", "شخصين", "أشخاص", "شخصًا"],
  records: ["سجل واحد", "سجلين", "سجلات", "سجلًا"],
};

/** «٤ منشورات»، «٤٠ تعليقًا»، «منشور واحد»: the number with its right Arabic noun. */
export function countAr(count: number, kind: CountKind): string {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const [one, two, few, many] = FORMS[kind];
  if (n === 1) return one;
  if (n === 2) return two;
  return `${toArabicDigits(n)} ${n >= 3 && n <= 10 ? few : many}`;
}

function itemSlug(item: CountedPlanItem): string {
  return String(item.capabilitySlug || item.endpointId || item.slug || "");
}

/** «٤ منشورات و٤٠ تعليقًا»: the counts of every service of the plan, in plan order (no «حتى»). */
export function planCountPartsAr(items: ReadonlyArray<CountedPlanItem> | undefined | null): string {
  const kinds = (items || []).map((item) => ({ kind: countKindOfSlug(itemSlug(item)), n: Number(item.targetVolumeMax) || 1 }));
  // the comments of the posts come last, whatever the order the plan was written in
  const ordered = [...kinds.filter((k) => k.kind !== "comments"), ...kinds.filter((k) => k.kind === "comments")];
  return ordered.map((k) => countAr(k.n, k.kind)).join(" و");
}

/**
 * The size of the plan as the customer reads it, the same string everywhere. One service: «حتى N سجل» (unchanged). Several services:
 * «حتى ٤ منشورات و٤٠ تعليقًا», each service with its own count; never one summed number that matches neither.
 */
export function planCountLineAr(items: ReadonlyArray<CountedPlanItem> | undefined | null, fallbackTotal?: number): string {
  const list = items || [];
  if (list.length > 1) return `حتى ${planCountPartsAr(list)}`;
  const only = list[0];
  const total = Number(only?.targetVolumeMax) || Number(fallbackTotal) || 1;
  // «سجل» after a number takes its right form: «سجل واحد», «سجلين», «٥ سجلات»; from eleven on it stays «سجل» («١٠٠ سجل»).
  return `حتى ${total >= 11 ? `${toArabicDigits(total)} سجل` : countAr(total, "records")}`;
}
