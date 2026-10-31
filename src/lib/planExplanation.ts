import { pointsAr, unitPriceLabelAr } from "./pointsFormat";
import { toArabicDigits } from "./arabicDigits";
import { countKindOfSlug, countPlainAr, oneMatchedAr, type CountKind } from "./planCounts";

/**
 * Plain Arabic lines for the plan card, written by code from the priced quote: what the customer will receive, the cost
 * range, and (when no count was given) the sample size that was proposed. The model writes none of it, so it always
 * matches what will run and what will be charged.
 */
const NOUNS: Array<{ test: RegExp; one: string; many: string }> = [
  // the Facebook topic report counts delivered COMMENTS (its slug names neither «comment» nor «post» first)
  { test: /^facebook-topic-report$/, one: "تعليق", many: "تعليق" },
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

const FORMAT_AR: Record<string, string> = { xlsx: "إكسل", pdf: "بي دي إف" };

export function formatsAr(formats: string[] | undefined): string {
  // the CSV is never named to a customer (it is kept for settlement, never offered)
  const names = [...new Set((formats || []).filter((f) => String(f).toLowerCase() !== "csv").map((f) => FORMAT_AR[String(f).toLowerCase()]).filter(Boolean))];
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
  // The profile and report services count their own unit; every other service counts by the kind of its slug, with the right plural.
  const kind: CountKind = input.capabilitySlug === "facebook-topic-report" ? "comments" : countKindOfSlug(input.capabilitySlug);
  const lines: string[] = [];
  if (input.capabilitySlug === "facebook-topic-report") {
    // The report: a workbook of data and a separate methodology file; comments are never judged, only the empty, repeated and link-only ones are left out (and not charged).
    lines.push(`ما ستستلمه: ملف إكسل للبيانات (موجز إحصائي ومنشورات وتعليقات وورقة لكل محور) وملف بي دي إف منفصل للمنهجية والتحليل، فيهما حتى ${countPlainAr(input.targetVolumeMax, "comments")} على منشورات الفترة التي حددتها. لا تُنتقى التعليقات؛ يُحذف منها الفارغ والمكرر وما كان رابطًا فقط، ولا يُحتسب عليك.`);
  } else {
    lines.push(`ما ستستلمه: ملف ${formatsAr(input.outputFormats)} فيه النتائج المطابقة لطلبك، حتى ${countPlainAr(input.targetVolumeMax, kind)}، بأعمدة عربية. ما لا نتأكد من مطابقته يُوضع في ورقة مراجعة منفصلة ولا يُحتسب عليك.`);
  }
  lines.push(`نطاق التكلفة: من ${formatPointsAr(input.unitPricePoints)} نقطة (${oneMatchedAr(kind)}) إلى ${pointsAr(input.expectedPoints, n)} إن سُلّم العدد كاملًا، ويُحجز ${pointsAr(input.quotedPoints, n)} مؤقتًا كحد أقصى. لا يُخصم إلا ما يُسلَّم فعلًا، والباقي حجز مؤقت مُحرَّر.`);
  if (!input.countStated) {
    lines.push(`لم تحدد عددًا، فاقترحت عينة من ${countPlainAr(input.targetVolumeMax, kind)}. غيّر العدد من بطاقة الخطة قبل الموافقة إن أردت أكثر.`);
  }
  return lines;
}

/**
 * The price of ONE record, said on every plan (one service or several), from the unit prices of the priced quote: the model writes none of it.
 * The charge is always what was delivered and matched, at this price, never above the hold.
 */
export function unitPriceLineAr(
  items: Array<{ capabilitySlug?: string; unitPricePoints?: number }>,
  quoteUnitPricePoints: number,
  serviceLabelAr: (slug?: string) => string,
): string | null {
  const priced = (items.length > 0 ? items : [{}]).map((item: { capabilitySlug?: string; unitPricePoints?: number }) => ({
    slug: item.capabilitySlug,
    unit: Number(item.unitPricePoints) > 0 ? Number(item.unitPricePoints) : Number(quoteUnitPricePoints),
  })).filter((entry) => Number.isFinite(entry.unit) && entry.unit > 0);
  if (priced.length === 0) return null;
  const tail = "ويُحتسب ما يُسلَّم ويطابق طلبك فقط.";
  if (priced.length === 1) return `سعر السجل: ${unitPriceLabelAr(priced[0].unit, recordNounAr(priced[0].slug))}، ${tail}`;
  return `سعر السجل: ${priced.map((entry) => `${serviceLabelAr(entry.slug)}: ${unitPriceLabelAr(entry.unit, recordNounAr(entry.slug))}`).join("، ")}، ${tail}`;
}

export interface PriceVsHoldInput {
  targetVolumeMax: number;
  /** Price of one record (one service) or 0 when the plan has several services. */
  unitPricePoints?: number;
  /** The estimate: ceil(volume x unit price), no buffer. */
  expectedPoints: number;
  /** The hold: ceil(volume x unit price x 1.15). */
  quotedPoints: number;
  bufferPercent?: number;
  /** True for a plan of several services: the formula is per service, so the line gives the two totals only. */
  severalServices?: boolean;
}

/**
 * The estimate and the hold, said apart and in this order: the PRICE (what is charged for what is delivered, at most) and the HOLD (the same
 * with the buffer of 15% added to the hold only, released again unless it is charged). 5 companies at 3.168 points: price ceil(5 x 3.168) = 16,
 * hold ceil(5 x 3.168 x 1.15) = 19. Both numbers come from the quote; nothing here computes a price.
 */
export function priceVsHoldLineAr(input: PriceVsHoldInput): string {
  const buffer = toArabicDigits(Math.round(input.bufferPercent ?? 15));
  const unit = Number(input.unitPricePoints) || 0;
  const formula = !input.severalServices && unit > 0 ? ` (${n(input.targetVolumeMax)} × ${formatPointsAr(unit)} نقطة، ويُقرَّب لأعلى)` : "";
  return `السعر التقديري ${pointsAr(input.expectedPoints, toArabicDigits)}${formula}، ويُخصم منه فقط ما يُسلَّم فعلًا. والحجز المؤقت ${pointsAr(input.quotedPoints, toArabicDigits)} هو هذا السعر مع احتياطي ${buffer}٪ على الحجز وحده، ولا يُخصم الاحتياطي.`;
}
