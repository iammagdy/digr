/**
 * Illustrative price points for the wallet's «رصيدك يكفي تقريبًا لـ» card.
 * The authoritative price is always the server quote for a specific plan; this table
 * only lets the wallet express a balance in "about how many searches" terms.
 */
export const ILLUSTRATIVE_SEARCH_PRICES: ReadonlyArray<{ records: number; points: number; label: string }> = [
  { records: 100, points: 12, label: "بحث بحجم ١٠٠ سجل" },
  { records: 500, points: 45, label: "بحث بحجم ٥٠٠ سجل" },
  { records: 1000, points: 85, label: "بحث بحجم ١٬٠٠٠ سجل" },
];

/** Top-up presets in EGP (points = amount / creditValueEgp). */
export const TOPUP_PRESETS_EGP = [50, 100, 250, 500] as const;
