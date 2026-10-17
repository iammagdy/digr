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
  tokyo: "طوكيو",
  singapore: "سنغافورة",
  "hong kong": "هونغ كونغ",
  toronto: "تورونتو",
  vancouver: "فانكوفر",
  montreal: "مونتريال",
  "new york": "نيويورك",
  boston: "بوسطن",
  chicago: "شيكاغو",
  "los angeles": "لوس أنجلوس",
  seattle: "سياتل",
  austin: "أوستن",
  san_francisco: "سان فرانسيسكو",
  madrid: "مدريد",
  barcelona: "برشلونة",
  rome: "روما",
  milan: "ميلانو",
  lisbon: "لشبونة",
  brussels: "بروكسل",
  copenhagen: "كوبنهاغن",
  stockholm: "ستوكهولم",
  oslo: "أوسلو",
  helsinki: "هلسنكي",
  warsaw: "وارسو",
  prague: "براغ",
  budapest: "بودابست",
  athens: "أثينا",
  moscow: "موسكو",
  kyiv: "كييف",
  beijing: "بكين",
  shanghai: "شنغهاي",
  "new delhi": "نيودلهي",
  mumbai: "مومباي",
  bangalore: "بنغالور",
  seoul: "سيول",
  jakarta: "جاكرتا",
  bangkok: "بانكوك",
  kuala_lumpur: "كوالالمبور",
  sydney: "سيدني",
  melbourne: "ملبورن",
  sao_paulo: "ساو باولو",
  "mexico city": "مكسيكو سيتي",
  johannesburg: "جوهانسبرغ",
  cape_town: "كيب تاون",
  lagos: "لاغوس",
  nairobi: "نيروبي",
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

/** Localize a provider's standalone city value; never leak an untranslated Latin city into Arabic deliverables. */
export function localizeCityName(value?: string | null, targetCountry?: string | null): string {
  if (!value || typeof value !== "string") return "غير متاح";
  const trimmed = value.trim();
  if (!trimmed) return "غير متاح";
  if (/[\u0600-\u06FF]/u.test(trimmed)) return trimmed;
  const normalized = trimmed.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (CITY_ARABIC_MAP[normalized]) return CITY_ARABIC_MAP[normalized];
  const parsed = extractCityFromAddress(trimmed, targetCountry);
  return parsed && parsed !== "غير متاح" && /[\u0600-\u06FF]/u.test(parsed) ? parsed : "غير متاح";
}
