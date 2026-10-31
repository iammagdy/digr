import { toArabicDigits } from "@/lib/arabicDigits";
import { CREDIT_VALUE_DEFAULT_E4, MAX_UNIT_CC, RATE_MAX_E4, RATE_MIN_E4, formatScaled, parseScaled, pointsToUnitCc, unitCcToPointsScaled } from "./money";

/**
 * How the owner TYPES a unit price. The stored unit never changes (integer hundredths of a US cent, `unitCc`); only the text does.
 *   dollars  «٠.٢٨» = 28 cents = 2800     (up to 4 decimals: 0.0001 dollar = one hundredth of a cent is the smallest price)
 *   points   points per item, converted with the DOCUMENT's rate and point value, rounded half up once to one hundredth of a cent
 * Nothing ever turns into 0 by itself: a price that cannot be stored exactly is an error the owner sees in red.
 */
export type PriceUnit = "usd" | "points";
export type UnitParse = { ok: true; cc: number } | { ok: false; error: string };

/** The unit shown next to a price box. */
export const UNIT_LABEL_AR: Record<PriceUnit, string> = { usd: "دولار", points: "نقطة" };

const SMALLEST = "٠.٠٠٠١ دولار";
const MAX_USD_AR = toArabicDigits(String(MAX_UNIT_CC / 10_000).replace(/\B(?=(\d{3})+(?!\d))/g, "٬"));

/** Stored price -> the text typed in dollars: 1200 -> «0.12», 45 -> «0.0045». */
export const unitUsdText = (cc: number): string => formatScaled(cc, 4);

/** The rule in one sentence, shown under the toggle. */
export const POINTS_ROUNDING_RULE_AR = "النقاط للوحدة تتحول إلى دولار بسعر الصرف وقيمة النقطة، ثم تُقرَّب لأقرب جزء من مئة من السنت (٠.٠٠٠١ دولار، والنصف لأعلى). لذلك قد يظهر السعر بالنقاط بعد الحفظ بفرق صغير جدًا؛ إجمالي البند يُقرَّب مرة واحدة كالمعتاد.";

/** A price typed in DOLLARS. */
export function parseUnitUsd(text: string): UnitParse {
  const raw = String(text ?? "");
  if (raw.trim() === "") return { ok: false, error: "اكتب سعر الوحدة بالدولار." };
  const exact = parseScaled(raw, 4);
  if (exact === null) {
    if (parseScaled(raw, 12) !== null) return { ok: false, error: `السعر فيه أكثر من ٤ منازل عشرية. أصغر سعر ممكن ${SMALLEST} (جزء من مئة من السنت).` };
    return { ok: false, error: "السعر غير مفهوم. اكتب رقمًا بالدولار، مثل ٠.١٢ (١٢ سنتًا)." };
  }
  if (exact > MAX_UNIT_CC) return { ok: false, error: `السعر أكبر من الحد المسموح (${MAX_USD_AR} دولار للوحدة).` };
  return { ok: true, cc: exact };
}

/** A price typed in POINTS PER ITEM, converted with the document's rate (EGP per USD x 10,000) and point value. */
export function parseUnitPoints(text: string, rateE4: number | null, creditValueE4: number = CREDIT_VALUE_DEFAULT_E4): UnitParse {
  const raw = String(text ?? "");
  if (raw.trim() === "") return { ok: false, error: "اكتب سعر الوحدة بالنقاط." };
  const scaled = parseScaled(raw, 2);
  if (scaled === null) {
    if (parseScaled(raw, 12) !== null) return { ok: false, error: "النقاط تقبل حتى منزلتين عشريتين فقط." };
    return { ok: false, error: "السعر غير مفهوم. اكتب عدد النقاط للوحدة، مثل ٦٠." };
  }
  if (rateE4 === null || rateE4 < RATE_MIN_E4 || rateE4 > RATE_MAX_E4) return { ok: false, error: "اكتب سعر الصرف أولًا حتى تتحول النقاط إلى دولار." };
  const cc = pointsToUnitCc(scaled, rateE4, creditValueE4);
  if (scaled > 0 && cc === 0) return { ok: false, error: `هذا السعر أصغر من أقل سعر ممكن (${SMALLEST}). ارفعه أو اكتبه بالدولار.` };
  if (cc > MAX_UNIT_CC) return { ok: false, error: `السعر أكبر من الحد المسموح (${MAX_USD_AR} دولار للوحدة).` };
  return { ok: true, cc };
}

/** A stored price as points text (two decimals, trailing zeros trimmed), or «» when there is no usable rate. */
export function unitPointsText(cc: number, rateE4: number | null, creditValueE4: number = CREDIT_VALUE_DEFAULT_E4): string {
  if (rateE4 === null || rateE4 < RATE_MIN_E4 || rateE4 > RATE_MAX_E4) return "";
  return formatScaled(unitCcToPointsScaled(cc, rateE4, creditValueE4), 2);
}
