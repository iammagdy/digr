/**
 * Address & City Parser for Company Research Deliverables.
 * Extracts clean city names from unstructured provider addresses
 * and provides Arabic localization for common MENA and European cities.
 */

const CITY_ARABIC_MAP: Record<string, string> = {
  // Egypt
  cairo: "القاهرة",
  giza: "الجيزة",
  alexandria: "الإسكندرية",
  mansoura: "المنصورة",
  tanta: "طنطا",
  zagazig: "الزقازيق",
  ismailia: "الإسماعيلية",
  suez: "السويس",
  port_said: "بورسعيد",
  aswan: "أسوان",
  luxor: "الأقصر",
  hurghada: "الغردقة",
  sharm_el_sheikh: "شرم الشيخ",
  "6th of october": "السادس من أكتوبر",
  "new cairo": "القاهرة الجديدة",
  sheikh_zayed: "الشيخ زايد",
  nasr_city: "مدينة نصر",
  heliopolis: "مصر الجديدة",
  maadi: "المعادي",

  // Saudi Arabia
  riyadh: "الرياض",
  jeddah: "جدة",
  makkah: "مكة المكرمة",
  mecca: "مكة المكرمة",
  madinah: "المدينة المنورة",
  medina: "المدينة المنورة",
  dammam: "الدمام",
  khobar: "الخبر",
  dhahran: "الظهران",
  jubail: "الجبيل",
  al_ahsa: "الأحساء",
  hofuf: "الهفوف",
  taif: "الطائف",
  tabuk: "تبوك",
  buraidah: "بريدة",
  khamis_mushait: "خميس مشيط",
  abha: "أبها",
  yanbu: "ينبع",
  najran: "نجران",
  jazan: "جازان",
  hail: "حائل",

  // UAE
  dubai: "دبي",
  "abu dhabi": "أبوظبي",
  sharjah: "الشارقة",
  ajman: "عجمان",
  "ras al khaimah": "رأس الخيمة",
  fujairah: "الفجيرة",
  "umm al quwain": "أم القيوين",
  "al ain": "العين",

  // Qatar & Kuwait & Bahrain & Oman & Jordan
  doha: "الدوحة",
  kuwait: "مدينة الكويت",
  "kuwait city": "مدينة الكويت",
  manama: "المنامة",
  muscat: "مسقط",
  amman: "عمان",

  // Europe & Global
  vaduz: "فادوتس",
  balzers: "بالزرس",
  schaan: "شان",
  triesen: "تريزن",
  vienna: "فيينا",
  wien: "فيينا",
  graz: "غراتس",
  salzburg: "سالزبورغ",
  innsbruck: "إنسبروك",
  berlin: "برلين",
  munich: "ميونخ",
  münchen: "ميونخ",
  frankfurt: "فرانكفورت",
  hamburg: "هامبورغ",
  paris: "باريس",
  london: "لندن",
  zurich: "زيورخ",
  geneva: "جنيف",
  amsterdam: "أمستردام",
};

const COUNTRIES_AND_REGIONS = new Set([
  "egypt", "saudi arabia", "saudi", "ksa", "united arab emirates", "uae",
  "qatar", "kuwait", "bahrain", "oman", "jordan", "liechtenstein",
  "austria", "germany", "switzerland", "united kingdom", "uk", "united states", "usa",
  "makkah", "makkah province", "riyadh province", "eastern province", "centeral",
  "cairo governorate", "giza governorate", "alexandria governorate",
  "governorate", "province", "district", "state", "region",
]);

/**
 * Extracts and localizes the city from a raw company location/address string.
 */
export function extractCityFromAddress(rawLocation?: string | null, targetCountry?: string | null): string {
  if (!rawLocation || typeof rawLocation !== "string") {
    return "غير متاح";
  }

  const trimmed = rawLocation.trim();
  if (!trimmed) {
    return "غير متاح";
  }

  // Check if address already contains an Arabic city
  for (const [enKey, arName] of Object.entries(CITY_ARABIC_MAP)) {
    if (trimmed.includes(arName)) {
      return arName;
    }
  }

  // Tokenize by comma
  const parts = trimmed.split(/[,،]+/).map((p) => p.trim()).filter(Boolean);

  // Check individual parts for known cities
  for (const part of parts) {
    const cleanPart = part.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
    if (CITY_ARABIC_MAP[cleanPart]) {
      return CITY_ARABIC_MAP[cleanPart];
    }
    // Substring match
    for (const [enKey, arName] of Object.entries(CITY_ARABIC_MAP)) {
      if (cleanPart.includes(enKey)) {
        return arName;
      }
    }
  }

  // If no known city was matched, filter out countries and regions
  const candidateParts = parts.filter((p) => {
    const pLower = p.toLowerCase().trim();
    return !COUNTRIES_AND_REGIONS.has(pLower) && !/^\d+$/.test(pLower);
  });

  if (candidateParts.length > 0) {
    // Pick the most specific geographic part (often the second or first non-street part)
    const bestPart = candidateParts[candidateParts.length > 1 ? 1 : 0];
    // Clean street/road prefixes if present
    const cleanCity = bestPart
      .replace(/^(road|street|st|rd|ave|avenue|district|حي|شارع|طريق)\s+/i, "")
      .replace(/\s+\d+$/, "")
      .trim();
    if (cleanCity.length > 0) {
      return cleanCity;
    }
  }

  return "غير متاح";
}
