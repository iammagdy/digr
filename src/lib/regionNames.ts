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

/** Words that show a text is about a country: its Arabic name, its English name and its demonym. Raw spellings, compared after normalisation. */
const REGION_EVIDENCE: Record<string, string[]> = {
  EG: ["مصر", "مصري", "مصرية", "المصري", "المصرية", "egypt", "egyptian"],
  SA: ["السعودية", "سعودي", "سعودية", "saudi"],
  AE: ["الإمارات", "اماراتي", "إماراتي", "emirates", "uae"],
  MA: ["المغرب", "مغربي", "مغربية", "morocco", "moroccan"],
  DZ: ["الجزائر", "جزائري", "algeria"],
  TN: ["تونس", "تونسي", "tunisia"],
  IQ: ["العراق", "عراقي", "iraq"],
  JO: ["الأردن", "اردني", "أردني", "jordan"],
  LB: ["لبنان", "لبناني", "lebanon"],
  KW: ["الكويت", "كويتي", "kuwait"],
  QA: ["قطر", "قطري", "qatar"],
};

export function regionEvidenceWords(code: unknown): string[] {
  const key = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (REGION_EVIDENCE[key]) return REGION_EVIDENCE[key];
  const name = regionNameAr(key);
  return name ? [name] : [];
}
