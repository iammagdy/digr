import { formatAr } from "./arabicDigits";
import { pointsDisplay } from "./recordPricing";

/** A unit price in points for the customer: Arabic-Indic digits, at most two decimals and only where there are any (٠٫١٢، ٣٫١٧، ١٢). */
export function formatPointsAr(points: number): string {
  return formatAr(Number(pointsDisplay(points)));
}
