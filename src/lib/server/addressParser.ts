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

/** Lowercase, underscores/hyphens/punctuation to single spaces; keeps accented Latin letters (münchen). */
function normalizeCityKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\u00c0-\u024f\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Longest names first so "New Cairo" wins over "Cairo" and "Kuwait City" over "Kuwait". */
const CITY_ENTRIES = Object.entries(CITY_ARABIC_MAP)
  .map(([key, arabic]) => {
    const normalized = normalizeCityKey(key);
    return { key: normalized, arabic, pattern: new RegExp(`(?<![a-z0-9\\u00c0-\\u024f])${escapeRegExp(normalized)}(?![a-z0-9\\u00c0-\\u024f])`) };
  })
  .sort((left, right) => right.key.length - left.key.length);

const ARABIC_CITY_ENTRIES = [...new Set(Object.values(CITY_ARABIC_MAP))].sort((left, right) => right.length - left.length);

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

  // Check if the address already names an Arabic city. "سلطنة عمان" is the country Oman, not the city Amman.
  const withoutOmanCountry = trimmed.replace(/سلطنة\s+عُ?مان/g, " ");
  for (const arabicName of ARABIC_CITY_ENTRIES) {
    if (withoutOmanCountry.includes(arabicName)) {
      return arabicName;
    }
  }

  // Tokenize by comma
  const parts = trimmed.split(/[,،]+/).map((p) => p.trim()).filter(Boolean);

  // Check individual parts for known cities (whole names only, longest first)
  for (const part of parts) {
    const cleanPart = normalizeCityKey(part);
    const exact = CITY_ENTRIES.find((entry) => entry.key === cleanPart);
    if (exact) return exact.arabic;
    const contained = CITY_ENTRIES.find((entry) => entry.pattern.test(cleanPart));
    if (contained) return contained.arabic;
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
  const exact = CITY_ENTRIES.find((entry) => entry.key === normalizeCityKey(trimmed));
  if (exact) return exact.arabic;
  const parsed = extractCityFromAddress(trimmed, targetCountry);
  return parsed && parsed !== "غير متاح" && /[\u0600-\u06FF]/u.test(parsed) ? parsed : "غير متاح";
}

/** City from a free-text address, as an Arabic name only ("غير متاح" when the city is not a known one). */
export function localizeCityFromAddress(rawAddress?: string | null, targetCountry?: string | null): string {
  const city = extractCityFromAddress(rawAddress, targetCountry);
  return /[\u0600-\u06FF]/u.test(city) ? city : "غير متاح";
}

/** Countries, regions and street words with a fixed Arabic form; anything not here is never guessed. */
const ADDRESS_WORDS_AR: Record<string, string> = {
  egypt: "مصر", "saudi arabia": "المملكة العربية السعودية", saudi: "السعودية", ksa: "السعودية",
  "united arab emirates": "الإمارات العربية المتحدة", uae: "الإمارات", qatar: "قطر", kuwait: "الكويت",
  bahrain: "البحرين", oman: "عُمان", jordan: "الأردن", germany: "ألمانيا", austria: "النمسا",
  switzerland: "سويسرا", liechtenstein: "ليختنشتاين", "united kingdom": "المملكة المتحدة", uk: "المملكة المتحدة",
  "united states": "الولايات المتحدة", usa: "الولايات المتحدة", france: "فرنسا", italy: "إيطاليا", spain: "إسبانيا",
  "cairo governorate": "محافظة القاهرة", "giza governorate": "محافظة الجيزة", "alexandria governorate": "محافظة الإسكندرية",
  "makkah province": "منطقة مكة المكرمة", "riyadh province": "منطقة الرياض", "eastern province": "المنطقة الشرقية",
  street: "شارع", st: "شارع", road: "طريق", rd: "طريق", avenue: "جادة", ave: "جادة", district: "حي",
  governorate: "محافظة", province: "منطقة", city: "مدينة", tower: "برج", building: "مبنى", floor: "الطابق",
  "po box": "ص.ب", "p o box": "ص.ب", highway: "طريق سريع", square: "ميدان", plaza: "ساحة", zone: "منطقة",
};

const ADDRESS_WORD_ENTRIES = Object.entries(ADDRESS_WORDS_AR)
  .map(([key, arabic]) => ({ key: normalizeCityKey(key), arabic }))
  .sort((left, right) => right.key.length - left.key.length);

function translateAddressToken(token: string): string | null {
  const key = normalizeCityKey(token);
  if (!key) return "";
  if (/^\d+[a-z]?$/.test(key)) return token.trim();
  const city = CITY_ENTRIES.find((entry) => entry.key === key);
  if (city) return city.arabic;
  const word = ADDRESS_WORD_ENTRIES.find((entry) => entry.key === key);
  return word ? word.arabic : null;
}

export const ADDRESS_NOT_TRANSLATED_AR = "عنوان غير مترجم — كما ورد في المصدر:";

/**
 * Arabic form of a company address. An Arabic address is kept as is. A Latin one is translated part by part
 * (comma-separated) ONLY when every word of every part is in a fixed map (city, country, street words, numbers);
 * otherwise the original is kept behind a plain Arabic marker so no English text looks like a finished Arabic cell.
 */
export function localizeAddressAr(rawAddress?: string | null): string {
  const raw = typeof rawAddress === "string" ? rawAddress.trim() : "";
  if (!raw || raw === "غير متاح") return "غير متاح";
  if (!/[A-Za-z\u00c0-\u024f]/.test(raw)) return raw;
  if (/[\u0600-\u06FF]/u.test(raw)) return raw;
  const parts = raw.split(/[,،]+/).map((part) => part.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const whole = translateAddressToken(part);
    if (whole !== null) { out.push(whole); continue; }
    // «Tahrir Street 12»: every word must be known; a street NAME is a proper noun we do not invent.
    const words = part.split(/\s+/);
    const translated = words.map((word) => translateAddressToken(word));
    if (translated.some((value) => value === null)) return `${ADDRESS_NOT_TRANSLATED_AR} ${raw}`;
    out.push(translated.join(" "));
  }
  return out.join("، ");
}
