import { toArabicDigits } from "./arabicDigits";
import { decisionMakersPerRequestLine, estimateMission, type EstimateInput } from "./missionEstimate";
import { DEFAULT_PRICING_SETTINGS } from "../functions/shared/quotes";
import { DECISION_MAKER_UNIT_PRICES_POINTS } from "../functions/shared/decisionMakerPricing";
import { volumeForPointsCap } from "./pointsCap";
import { FAILURE_STATE_AR } from "./publicCopy";

/**
 * What the pricing page shows. Every number is computed from the same unit prices as the quote writer (through the public
 * estimate), never typed by hand. A capacity is the number of records the amount can RESERVE (the hold includes the buffer),
 * so it is a «حتى حوالي» figure: what is actually charged is only for the records delivered.
 */
export interface PriceRow {
  id: string;
  labelAr: string;
  unitLabelAr: string;
  unitPricePoints: number;
  input: EstimateInput;
}

const ROWS: Array<{ id: string; labelAr: string; unitLabelAr: string; input: EstimateInput }> = [
  { id: "youtube-comments", labelAr: "تعليقات يوتيوب", unitLabelAr: "تعليق", input: { kind: "comments", platform: "youtube" } },
  { id: "tiktok-comments", labelAr: "تعليقات تيك توك", unitLabelAr: "تعليق", input: { kind: "comments", platform: "tiktok" } },
  { id: "facebook-comments", labelAr: "تعليقات فيسبوك", unitLabelAr: "تعليق", input: { kind: "comments", platform: "facebook" } },
  { id: "x-posts", labelAr: "منشورات إكس", unitLabelAr: "منشور", input: { kind: "posts", platform: "x" } },
  { id: "facebook-posts", labelAr: "منشورات فيسبوك", unitLabelAr: "منشور", input: { kind: "posts", platform: "facebook" } },
  { id: "youtube-videos", labelAr: "فيديوهات يوتيوب", unitLabelAr: "فيديو", input: { kind: "videos", platform: "youtube" } },
  { id: "companies", labelAr: "شركات", unitLabelAr: "شركة", input: { kind: "companies" } },
];

export function buildPriceRows(): PriceRow[] {
  const rows: PriceRow[] = [];
  for (const row of ROWS) {
    const result = estimateMission({ ...row.input, volume: 1 });
    if (result.status === "ok") rows.push({ ...row, unitPricePoints: result.unitPricePoints });
  }
  return rows;
}

/** People are priced per person plus each contact field that was found. */
export const PEOPLE_PRICE_POINTS = DECISION_MAKER_UNIT_PRICES_POINTS;

export const CAPACITY_AMOUNTS_EGP = [50, 100, 200, 500, 1000] as const;

export function pointsForAmountEgp(amountEgp: number): number {
  const value = DEFAULT_PRICING_SETTINGS.creditValueEgp;
  return Math.max(0, Math.floor(Number(amountEgp) / value + 1e-9));
}

export interface CapacityLine {
  id: string;
  labelAr: string;
  unitLabelAr: string;
  records: number;
}

/** How many records of each kind an amount can reserve, under that amount. */
export function capacityForAmount(amountEgp: number): CapacityLine[] {
  const points = pointsForAmountEgp(amountEgp);
  const lines: CapacityLine[] = buildPriceRows().map((row) => ({ id: row.id, labelAr: row.labelAr, unitLabelAr: row.unitLabelAr, records: volumeForPointsCap(points, row.unitPricePoints, DEFAULT_PRICING_SETTINGS.safetyBuffer) }));
  const person = PEOPLE_PRICE_POINTS.basePerson + PEOPLE_PRICE_POINTS.workEmail + PEOPLE_PRICE_POINTS.phone;
  lines.push({ id: "people", labelAr: "صنّاع قرار مع البريد والهاتف", unitLabelAr: "شخص", records: volumeForPointsCap(points, person, DEFAULT_PRICING_SETTINGS.safetyBuffer) });
  return lines;
}

export function capacityLineAr(line: CapacityLine): string {
  return line.records > 0 ? `حتى حوالي ${toArabicDigits(line.records)} ${line.unitLabelAr}` : "لا يكفي لسجل واحد";
}

export const PRICING_FAQ_AR: Array<[string, string]> = [
  ["متى يُخصم الرصيد؟", "لا يُخصم شيء أثناء المحادثة أو إعداد الخطة. عند موافقتك يُحجز مبلغ مؤقت، ثم يُخصم فقط مقابل السجلات المطابقة التي وصلتك فعلًا، ويعود الباقي إلى رصيدك."],
  ["ماذا لو وصلني أقل مما طلبت؟", "تدفع مقابل ما وصلك فقط. إن لم تتوفر سجلات كافية بالمواصفات التي حددتها، يعود الفرق إلى رصيدك كاملًا."],
  ["ماذا لو تعذّر تنفيذ الطلب؟", FAILURE_STATE_AR],
  ["هل هناك حد لحجم الطلب الواحد؟", "نعم، لكل طلب حد أقصى للمبلغ المحجوز لحماية رصيدك. الأحجام الكبيرة تُقسَّم على أكثر من طلب، وتحسب لك الحاسبة عدد الطلبات المتوقع."],
  ["هل الأسعار ثابتة؟", "الأسعار المعروضة هنا هي أسعار النقاط الحالية، وتظهر في خطتك قبل أن توافق. أي رقم في هذه الصفحة تقريبي ويحسبه النظام، والرقم النهائي هو الذي يظهر في خطتك."],
];

/** The sentence under the decision-makers numbers: what one request holds, read from the shared sizing function. */
export function peoplePerRequestLineAr(dailyCapPoints?: number): string {
  return decisionMakersPerRequestLine({ dailyCapPoints });
}
