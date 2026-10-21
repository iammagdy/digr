import { pointsAr } from "./pointsFormat";
import { toArabicDigits } from "./arabicDigits";

/**
 * Plain Arabic lines for the plan card, written by code from the priced quote: what the customer will receive, the cost
 * range, and (when no count was given) the sample size that was proposed. The model writes none of it, so it always
 * matches what will run and what will be charged.
 */
const NOUNS: Array<{ test: RegExp; one: string; many: string }> = [
  { test: /compan/i, one: "شركة", many: "شركة" },
  { test: /people|person|decision/i, one: "شخص", many: "شخص" },
  { test: /comment/i, one: "تعليق", many: "تعليق" },
  { test: /post|x-/i, one: "منشور", many: "منشور" },
  { test: /video|tiktok|youtube/i, one: "فيديو", many: "فيديو" },
  { test: /profile/i, one: "حساب", many: "حساب" },
];

export function recordNounAr(capabilitySlug: string | undefined): string {
  const slug = String(capabilitySlug || "");
  return (NOUNS.find((n) => n.test.test(slug)) ?? { one: "سجل" }).one;
}

const FORMAT_AR: Record<string, string> = { xlsx: "إكسل", csv: "سي إس في", pdf: "بي دي إف" };

export function formatsAr(formats: string[] | undefined): string {
  const names = [...new Set((formats || []).map((f) => FORMAT_AR[String(f).toLowerCase()]).filter(Boolean))];
  return names.length ? names.join(" و") : "إكسل";
}

import { formatPointsAr } from "./pointsFormat";
const n = (value: number) => toArabicDigits(Math.max(0, Math.round(value)));

export interface PlanExplanationInput {
  capabilitySlug?: string;
  outputFormats?: string[];
  targetVolumeMax: number;
  unitPricePoints: number;
  expectedPoints: number;
  quotedPoints: number;
  /** false when the customer gave no number: the plan then carries a proposed sample size */
  countStated: boolean;
}

/** Lines for a single-service plan (the card shows several services separately, so they get none of these). */
export function planExplanationLinesAr(input: PlanExplanationInput): string[] {
  const noun = recordNounAr(input.capabilitySlug);
  const lines: string[] = [];
  lines.push(`ما ستستلمه: ملف ${formatsAr(input.outputFormats)} فيه حتى ${n(input.targetVolumeMax)} ${noun} مطابق لطلبك بأعمدة عربية. ما لا نتأكد من مطابقته يُوضع في ورقة مراجعة منفصلة ولا يُحتسب عليك.`);
  lines.push(`نطاق التكلفة: من ${formatPointsAr(input.unitPricePoints)} نقطة (${noun} واحد مطابق) إلى ${pointsAr(input.expectedPoints, n)} إن سُلّم العدد كاملًا، ويُحجز ${pointsAr(input.quotedPoints, n)} مؤقتًا كحد أقصى. لا يُخصم إلا ما يُسلَّم فعلًا وتُردّ الفروق.`);
  if (!input.countStated) {
    lines.push(`لم تحدد عددًا، فاقترحت عينة من ${n(input.targetVolumeMax)} ${noun}. غيّر العدد من بطاقة الخطة قبل الموافقة إن أردت أكثر.`);
  }
  return lines;
}
