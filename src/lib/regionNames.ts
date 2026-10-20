/** The Arabic name of a region code a plan carries («EG» → «مصر»), for sentences the customer reads and for the reviewer's brief. */
const REGION_NAMES_AR: Record<string, string> = {
  EG: "مصر", SA: "السعودية", AE: "الإمارات", KW: "الكويت", QA: "قطر", BH: "البحرين", OM: "عُمان", JO: "الأردن", LB: "لبنان", IQ: "العراق",
  SY: "سوريا", YE: "اليمن", PS: "فلسطين", MA: "المغرب", DZ: "الجزائر", TN: "تونس", LY: "ليبيا", SD: "السودان",
  US: "الولايات المتحدة", GB: "المملكة المتحدة", TR: "تركيا", DE: "ألمانيا", FR: "فرنسا", ES: "إسبانيا", IT: "إيطاليا",
};

export function regionNameAr(code: unknown): string | null {
  const key = typeof code === "string" ? code.trim().toUpperCase() : "";
  return REGION_NAMES_AR[key] ?? null;
}
