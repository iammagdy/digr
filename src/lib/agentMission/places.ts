import { normalizeText, termRegex } from "./relevance";

/**
 * PLACE AND COUNTRY ARE ENFORCED, in code. When the customer asks for items in a country, a city or a place («شركات مقاولات في مصر») every delivered item must carry EVIDENCE of it from a mapped field: the country, the city, the address, the
 * domain of the website (its country suffix) or the phone's international prefix. An item whose location field names ANOTHER country (a Luxembourg company in an Egypt request) or that carries no evidence at all is not delivered or charged.
 * One small table of countries and cities (Arabic and Latin spellings) serves the request's words and the items' fields alike. Pure: no I/O.
 */
export interface PlaceEntry {
  /** A stable key: «EG», or «EG:cairo» for a city. */
  key: string;
  kind: "country" | "city";
  country: string;
  /** The Arabic name the card says. */
  labelAr: string;
  /** Spellings (Arabic and Latin) that name it in a text. */
  names: string[];
}
interface Country { code: string; labelAr: string; names: string[]; tlds: string[]; phone: string; cities?: Array<{ id: string; labelAr: string; names: string[] }> }

const COUNTRIES: ReadonlyArray<Country> = [
  { code: "EG", labelAr: "مصر", names: ["مصر", "جمهورية مصر العربية", "egypt", "arab republic of egypt", "eg"], tlds: ["eg"], phone: "20", cities: [
    { id: "cairo", labelAr: "القاهرة", names: ["القاهرة", "cairo", "new cairo", "القاهرة الجديدة", "التجمع الخامس", "مدينة نصر", "nasr city", "المعادي", "maadi", "heliopolis", "مصر الجديدة"] },
    { id: "giza", labelAr: "الجيزة", names: ["الجيزة", "giza", "6 اكتوبر", "6th of october", "october city", "الشيخ زايد", "sheikh zayed", "المهندسين", "mohandessin", "الدقي", "dokki"] },
    { id: "alexandria", labelAr: "الإسكندرية", names: ["الاسكندريه", "الإسكندرية", "alexandria", "alex"] },
    { id: "mansoura", labelAr: "المنصورة", names: ["المنصوره", "المنصورة", "mansoura"] },
    { id: "tanta", labelAr: "طنطا", names: ["طنطا", "tanta"] },
    { id: "assiut", labelAr: "أسيوط", names: ["اسيوط", "أسيوط", "assiut", "asyut"] },
    { id: "luxor", labelAr: "الأقصر", names: ["الاقصر", "الأقصر", "luxor"] },
    { id: "aswan", labelAr: "أسوان", names: ["اسوان", "أسوان", "aswan"] },
    { id: "portsaid", labelAr: "بورسعيد", names: ["بورسعيد", "port said"] },
    { id: "suez", labelAr: "السويس", names: ["السويس", "suez"] },
    { id: "ismailia", labelAr: "الإسماعيلية", names: ["الاسماعيليه", "الإسماعيلية", "ismailia"] },
    { id: "hurghada", labelAr: "الغردقة", names: ["الغردقه", "الغردقة", "hurghada"] },
    { id: "sharm", labelAr: "شرم الشيخ", names: ["شرم الشيخ", "sharm el sheikh", "sharm el-sheikh"] },
    { id: "tenth", labelAr: "العاشر من رمضان", names: ["العاشر من رمضان", "10th of ramadan", "tenth of ramadan"] },
  ] },
  { code: "SA", labelAr: "السعودية", names: ["السعوديه", "السعودية", "المملكة العربية السعودية", "saudi arabia", "saudi", "ksa"], tlds: ["sa"], phone: "966", cities: [
    { id: "riyadh", labelAr: "الرياض", names: ["الرياض", "riyadh"] }, { id: "jeddah", labelAr: "جدة", names: ["جده", "جدة", "jeddah"] }, { id: "dammam", labelAr: "الدمام", names: ["الدمام", "dammam"] }, { id: "mecca", labelAr: "مكة", names: ["مكه", "مكة", "mecca", "makkah"] },
  ] },
  { code: "AE", labelAr: "الإمارات", names: ["الامارات", "الإمارات", "الامارات العربية المتحدة", "united arab emirates", "uae", "emirates"], tlds: ["ae"], phone: "971", cities: [
    { id: "dubai", labelAr: "دبي", names: ["دبي", "dubai"] }, { id: "abudhabi", labelAr: "أبوظبي", names: ["ابوظبي", "أبوظبي", "abu dhabi"] }, { id: "sharjah", labelAr: "الشارقة", names: ["الشارقه", "الشارقة", "sharjah"] },
  ] },
  { code: "KW", labelAr: "الكويت", names: ["الكويت", "kuwait"], tlds: ["kw"], phone: "965" },
  { code: "QA", labelAr: "قطر", names: ["قطر", "qatar", "الدوحة", "doha"], tlds: ["qa"], phone: "974" },
  { code: "BH", labelAr: "البحرين", names: ["البحرين", "bahrain", "المنامة", "manama"], tlds: ["bh"], phone: "973" },
  { code: "OM", labelAr: "عُمان", names: ["سلطنة عمان", "oman", "مسقط", "muscat"], tlds: ["om"], phone: "968" },
  { code: "JO", labelAr: "الأردن", names: ["الاردن", "الأردن", "jordan", "amman"], tlds: ["jo"], phone: "962" },
  { code: "LB", labelAr: "لبنان", names: ["لبنان", "lebanon", "بيروت", "beirut"], tlds: ["lb"], phone: "961" },
  { code: "SY", labelAr: "سوريا", names: ["سوريا", "سورية", "syria"], tlds: ["sy"], phone: "963" },
  { code: "IQ", labelAr: "العراق", names: ["العراق", "iraq", "بغداد", "baghdad"], tlds: ["iq"], phone: "964" },
  { code: "PS", labelAr: "فلسطين", names: ["فلسطين", "palestine"], tlds: ["ps"], phone: "970" },
  { code: "LY", labelAr: "ليبيا", names: ["ليبيا", "libya"], tlds: ["ly"], phone: "218" },
  { code: "TN", labelAr: "تونس", names: ["تونس", "tunisia"], tlds: ["tn"], phone: "216" },
  { code: "DZ", labelAr: "الجزائر", names: ["الجزائر", "algeria"], tlds: ["dz"], phone: "213" },
  { code: "MA", labelAr: "المغرب", names: ["المغرب", "morocco", "الدار البيضاء", "casablanca", "الرباط", "rabat"], tlds: ["ma"], phone: "212" },
  { code: "SD", labelAr: "السودان", names: ["السودان", "sudan"], tlds: ["sd"], phone: "249" },
  { code: "YE", labelAr: "اليمن", names: ["اليمن", "yemen"], tlds: ["ye"], phone: "967" },
  { code: "TR", labelAr: "تركيا", names: ["تركيا", "turkey", "turkiye", "اسطنبول", "إسطنبول", "istanbul", "انقرة", "أنقرة", "ankara"], tlds: ["tr"], phone: "90" },
  { code: "US", labelAr: "أمريكا", names: ["امريكا", "أمريكا", "الولايات المتحده", "الولايات المتحدة", "united states", "usa", "u.s.", "us", "new york", "نيويورك"], tlds: ["us"], phone: "1" },
  { code: "GB", labelAr: "بريطانيا", names: ["بريطانيا", "المملكة المتحدة", "united kingdom", "uk", "england", "london", "لندن"], tlds: ["uk", "gb"], phone: "44" },
  { code: "DE", labelAr: "ألمانيا", names: ["المانيا", "ألمانيا", "germany", "deutschland"], tlds: ["de"], phone: "49" },
  { code: "FR", labelAr: "فرنسا", names: ["فرنسا", "france", "paris", "باريس"], tlds: ["fr"], phone: "33" },
  { code: "LU", labelAr: "لوكسمبورغ", names: ["لوكسمبورج", "لوكسمبورغ", "luxembourg", "luxemburg"], tlds: ["lu"], phone: "352" },
  { code: "IT", labelAr: "إيطاليا", names: ["ايطاليا", "إيطاليا", "italy"], tlds: ["it"], phone: "39" },
  { code: "ES", labelAr: "إسبانيا", names: ["اسبانيا", "إسبانيا", "spain"], tlds: ["es"], phone: "34" },
  { code: "NL", labelAr: "هولندا", names: ["هولندا", "netherlands", "holland"], tlds: ["nl"], phone: "31" },
  { code: "CH", labelAr: "سويسرا", names: ["سويسرا", "switzerland"], tlds: ["ch"], phone: "41" },
  { code: "CY", labelAr: "قبرص", names: ["قبرص", "cyprus"], tlds: ["cy"], phone: "357" },
  { code: "IN", labelAr: "الهند", names: ["الهند", "india"], tlds: ["in"], phone: "91" },
  { code: "CN", labelAr: "الصين", names: ["الصين", "china"], tlds: ["cn"], phone: "86" },
  { code: "CA", labelAr: "كندا", names: ["كندا", "canada"], tlds: ["ca"], phone: "1" },
];

const ENTRIES: PlaceEntry[] = COUNTRIES.flatMap((c) => [
  { key: c.code, kind: "country" as const, country: c.code, labelAr: c.labelAr, names: c.names },
  ...(c.cities ?? []).map((city) => ({ key: `${c.code}:${city.id}`, kind: "city" as const, country: c.code, labelAr: city.labelAr, names: city.names })),
]);
const byKey = new Map(ENTRIES.map((e) => [e.key, e]));
const countryOf = new Map(COUNTRIES.map((c) => [c.code, c]));
export const placeEntry = (key: string): PlaceEntry | null => byKey.get(key) ?? null;

const regexCache = new Map<string, RegExp[]>();
function regexesOf(entry: PlaceEntry): RegExp[] {
  let list = regexCache.get(entry.key);
  if (!list) {
    // a two-letter code («eg», «us», «uk») names a place only in capitals and standing alone: it is matched on the raw text
    list = entry.names.filter((n) => normalizeText(n).length >= 3).map((n) => termRegex(n, "u")).filter((r): r is RegExp => r !== null);
    regexCache.set(entry.key, list);
  }
  return list;
}

/** The countries and cities a text names (the request's words), most specific first; none when it names none. */
export function placesInText(text: unknown): PlaceEntry[] {
  const t = normalizeText(String(text ?? ""));
  if (!t) return [];
  const found = ENTRIES.filter((e) => regexesOf(e).some((r) => r.test(t)));
  // a city already says its country: the country alone is kept only when the text names no city of it
  const cities = new Set(found.filter((e) => e.kind === "city").map((e) => e.country));
  return found.filter((e) => e.kind === "city" || !cities.has(e.country));
}

const textHas = (entry: PlaceEntry, text: string): boolean => regexesOf(entry).some((r) => r.test(text));
const URL_HOST = /^(?:https?:\/\/)?(?:www\.)?([^\/\s?#:]+)/i;
const hostTld = (value: string): string | null => { const m = URL_HOST.exec(value.trim()); const host = m?.[1]?.toLowerCase() ?? ""; return host.includes(".") ? host.slice(host.lastIndexOf(".") + 1) : null; };
const phoneDigits = (value: string): string | null => {
  const raw = normalizeText(value).replace(/[\s().-]/g, "");
  const m = /^(?:\+|00)(\d{6,15})/.exec(raw);
  return m ? m[1] : null;
};

/** The mapped fields that carry a PLACE, by what they are: a location text (country, city, address), a website (its country suffix), a phone (its prefix). */
export const PLACE_TEXT_KEY = /(^|_)(place|location|city|country|country_name|address|region|governorate|state|headquarters|hq|headquarter|locality)$/i;
export const PLACE_SITE_KEY = /(^|_)(website|domain|site|url|link|company_url|web)$/i;
export const PLACE_PHONE_KEY = /(^|_)(phone|tel|telephone|mobile|phone_number)$/i;
export const isPlaceEvidenceKey = (k: string): boolean => PLACE_TEXT_KEY.test(k) || PLACE_SITE_KEY.test(k) || PLACE_PHONE_KEY.test(k);

/** A COUNTRY FIELD often holds the ISO code and nothing else («EG», «EGY»): a company source that was asked for Egypt answers `country: "EG"`. The code names the country; it is read only in a field that is a country field (a «state» of «CA» is not Canada). */
const ISO3: Record<string, string> = { EG: "EGY", SA: "SAU", AE: "ARE", KW: "KWT", QA: "QAT", BH: "BHR", OM: "OMN", JO: "JOR", LB: "LBN", SY: "SYR", IQ: "IRQ", PS: "PSE", LY: "LBY", TN: "TUN", DZ: "DZA", MA: "MAR", SD: "SDN", YE: "YEM", TR: "TUR", US: "USA", GB: "GBR", DE: "DEU", FR: "FRA", LU: "LUX", IT: "ITA", ES: "ESP", NL: "NLD", CH: "CHE", CY: "CYP", IN: "IND", CN: "CHN", CA: "CAN" };
const COUNTRY_FIELD_KEY = /(^|_)(country|country_code|country_name|nation|countrycode)$/i;
const isoCountryOf = (value: string): string | null => {
  const t = value.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(t)) return countryOf.has(t) ? t : null;
  if (/^[A-Z]{3}$/.test(t)) return Object.keys(ISO3).find((c) => ISO3[c] === t) ?? null;
  return null;
};

export type PlaceVerdict = "pass" | "other_place" | "no_evidence";

/**
 * Does this mapped item carry evidence of one of the named places? A location text that names the place passes; one that names ANOTHER country fails (a Luxembourg company in an Egypt request) unless it also names the place; a website's
 * country suffix or an international phone prefix passes only when no location text says otherwise; no evidence at all fails.
 */
export function placeVerdict(placeKeys: ReadonlyArray<string>, mapped: Record<string, unknown>, fields: ReadonlyArray<string>): PlaceVerdict {
  const wanted = placeKeys.map((k) => byKey.get(k)).filter((e): e is PlaceEntry => Boolean(e));
  if (wanted.length === 0) return "no_evidence";
  const wantedCountries = new Set(wanted.map((e) => e.country));
  // a website's country suffix and a phone's prefix say the COUNTRY: they are evidence of a country the customer named, never of a city
  const wantedWholeCountries = wanted.filter((e) => e.kind === "country");
  let textPositive = false;
  let textNegative = false;
  let weakPositive = false;
  let weakNegative = false;
  for (const field of fields) {
    const value = mapped[field];
    if (value === null || value === undefined || typeof value === "object") continue;
    const raw = String(value);
    if (!raw.trim()) continue;
    if (PLACE_PHONE_KEY.test(field)) {
      const digits = phoneDigits(raw);
      if (digits) { const own = wantedWholeCountries.some((e) => digits.startsWith(countryOf.get(e.country)!.phone)); if (own) weakPositive = true; else if (COUNTRIES.some((c) => !wantedCountries.has(c.code) && digits.startsWith(c.phone))) weakNegative = true; }
      continue;
    }
    if (PLACE_SITE_KEY.test(field) && !PLACE_TEXT_KEY.test(field)) {
      const tld = hostTld(raw);
      if (tld) { if (wantedWholeCountries.some((e) => countryOf.get(e.country)!.tlds.includes(tld))) weakPositive = true; else if (COUNTRIES.some((c) => !wantedCountries.has(c.code) && c.tlds.includes(tld))) weakNegative = true; }
      continue;
    }
    const iso = COUNTRY_FIELD_KEY.test(field) ? isoCountryOf(raw) : null;
    if (iso) { if (wantedWholeCountries.some((e) => e.country === iso)) textPositive = true; else if (!wantedCountries.has(iso)) textNegative = true; continue; }
    const text = normalizeText(raw);
    if (wanted.some((e) => textHas(e, text))) { textPositive = true; continue; }
    // another country (not one of the wanted ones) named in the text
    if (COUNTRIES.some((c) => !wantedCountries.has(c.code) && [byKey.get(c.code)!, ...ENTRIES.filter((e) => e.kind === "city" && e.country === c.code)].some((e) => textHas(e, text)))) textNegative = true;
  }
  if (textPositive) return "pass";
  if (textNegative) return "other_place";
  if (weakPositive) return "pass";
  return weakNegative ? "other_place" : "no_evidence";
}

/** The words of the request that name a place, as the card says them («مصر»), for the filter's sentence. */
export const placeLabelsAr = (entries: ReadonlyArray<PlaceEntry>): string[] => [...new Set(entries.map((e) => e.labelAr))];
