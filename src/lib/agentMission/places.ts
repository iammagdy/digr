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
    { id: "cairo", labelAr: "القاهرة", names: ["القاهرة", "cairo", "al qahirah", "al-qahirah", "al qahira", "el qahira", "el-qahira", "qahira", "new cairo", "القاهرة الجديدة", "التجمع الخامس", "مدينة نصر", "nasr city", "المعادي", "maadi", "heliopolis", "مصر الجديدة"] },
    { id: "giza", labelAr: "الجيزة", names: ["الجيزة", "giza", "al jizah", "al-jizah", "el giza", "6 اكتوبر", "6th of october", "october city", "الشيخ زايد", "sheikh zayed", "المهندسين", "mohandessin", "الدقي", "dokki"] },
    { id: "alexandria", labelAr: "الإسكندرية", names: ["الاسكندريه", "الإسكندرية", "alexandria", "alex", "al iskandariyah", "al-iskandariyah", "iskandariya"] },
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
  { code: "US", labelAr: "أمريكا", names: ["امريكا", "أمريكا", "الولايات المتحده", "الولايات المتحدة", "united states", "usa", "u.s.", "us", "new york", "نيويورك"], tlds: ["us"], phone: "1", cities: [
    { id: "miami", labelAr: "ميامي", names: ["ميامي", "miami"] }, { id: "seattle", labelAr: "سياتل", names: ["سياتل", "seattle"] }, { id: "houston", labelAr: "هيوستن", names: ["هيوستن", "houston"] }, { id: "chicago", labelAr: "شيكاغو", names: ["شيكاغو", "chicago"] },
    { id: "losangeles", labelAr: "لوس أنجلوس", names: ["لوس انجلوس", "لوس أنجلوس", "los angeles"] }, { id: "sanfrancisco", labelAr: "سان فرانسيسكو", names: ["سان فرانسيسكو", "san francisco"] }, { id: "boston", labelAr: "بوسطن", names: ["بوسطن", "boston"] },
    { id: "dallas", labelAr: "دالاس", names: ["دالاس", "dallas"] }, { id: "atlanta", labelAr: "أتلانتا", names: ["اتلانتا", "أتلانتا", "atlanta"] }, { id: "sandiego", labelAr: "سان دييغو", names: ["سان دييغو", "san diego"] }, { id: "lasvegas", labelAr: "لاس فيغاس", names: ["لاس فيغاس", "las vegas"] },
    { id: "denver", labelAr: "دنفر", names: ["دنفر", "denver"] }, { id: "phoenix", labelAr: "فينيكس", names: ["فينيكس", "phoenix"] }, { id: "philadelphia", labelAr: "فيلادلفيا", names: ["فيلادلفيا", "philadelphia"] },
  ] },
  { code: "GB", labelAr: "بريطانيا", names: ["بريطانيا", "المملكة المتحدة", "united kingdom", "uk", "england", "london", "لندن"], tlds: ["uk", "gb"], phone: "44", cities: [
    { id: "manchester", labelAr: "مانشستر", names: ["مانشستر", "manchester"] }, { id: "birmingham", labelAr: "برمنغهام", names: ["برمنجهام", "برمنغهام", "birmingham"] }, { id: "glasgow", labelAr: "غلاسكو", names: ["غلاسكو", "glasgow"] },
  ] },
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

/**
 * THE DISTRICTS A SOURCE WRITES AS ITS «CITY» («mokattam», «El Agouza», «Sheikh Zayed Egypt»): each belongs to a city of the table (so it is evidence of the country) and has its own Arabic name, which is what the file's city cell says.
 */
const DISTRICTS: ReadonlyArray<{ city: string; labelAr: string; names: string[] }> = [
  { city: "EG:cairo", labelAr: "المقطم", names: ["المقطم", "mokattam", "mokatam", "muqattam", "al mokattam"] },
  { city: "EG:giza", labelAr: "العجوزة", names: ["العجوزة", "agouza", "el agouza", "al agouza", "ajouza"] },
  { city: "EG:giza", labelAr: "الشيخ زايد", names: ["الشيخ زايد", "sheikh zayed", "sheikh zayed city", "sheikh zayed egypt", "el sheikh zayed", "elsheikh zayed", "shaikh zayed"] },
  { city: "EG:cairo", labelAr: "القاهرة الجديدة", names: ["القاهرة الجديدة", "new cairo", "new cairo city", "al qahirah al jadidah", "التجمع الخامس", "fifth settlement", "5th settlement", "tagamoa", "tagamoa el khames"] },
  { city: "EG:cairo", labelAr: "مدينة نصر", names: ["مدينة نصر", "nasr city", "madinat nasr"] },
  { city: "EG:cairo", labelAr: "المعادي", names: ["المعادي", "maadi", "el maadi"] },
  { city: "EG:cairo", labelAr: "مصر الجديدة", names: ["مصر الجديدة", "heliopolis", "masr el gedida"] },
  { city: "EG:cairo", labelAr: "الزمالك", names: ["الزمالك", "zamalek", "el zamalek"] },
  { city: "EG:giza", labelAr: "الدقي", names: ["الدقي", "dokki", "el dokki", "dokki giza"] },
  { city: "EG:giza", labelAr: "المهندسين", names: ["المهندسين", "mohandessin", "mohandiseen", "el mohandessin"] },
  { city: "EG:giza", labelAr: "مدينة ٦ أكتوبر", names: ["6 اكتوبر", "6 أكتوبر", "مدينة 6 اكتوبر", "6th of october", "6th october", "sixth of october", "october city", "6 october", "6th of october city"] },
  { city: "EG:giza", labelAr: "الهرم", names: ["الهرم", "haram", "el haram", "al haram", "pyramids"] },
  { city: "EG:cairo", labelAr: "الشروق", names: ["الشروق", "shorouk", "el shorouk", "al shorouk"] },
  { city: "EG:cairo", labelAr: "العبور", names: ["العبور", "obour", "el obour", "al obour"] },
  { city: "EG:cairo", labelAr: "الرحاب", names: ["الرحاب", "rehab", "el rehab", "al rehab"] },
  { city: "EG:cairo", labelAr: "مدينتي", names: ["مدينتي", "madinaty"] },
  { city: "EG:cairo", labelAr: "القطامية", names: ["القطامية", "katameya", "el katameya"] },
  { city: "EG:cairo", labelAr: "وسط البلد", names: ["وسط البلد", "downtown cairo", "downtown", "down town", "down town cairo", "wust el balad", "wast el balad"] },
  { city: "EG:cairo", labelAr: "زهراء المعادي", names: ["زهراء المعادي", "zahraa el maadi", "zahraa al maadi", "zahraa maadi", "zahraa elmaadi", "zahraa el-maadi"] },
  { city: "EG:cairo", labelAr: "التجمع الأول", names: ["التجمع الأول", "first new cairo", "1st new cairo", "first settlement", "1st settlement", "first new cairo city"] },
  { city: "EG:cairo", labelAr: "التجمع الثاني", names: ["التجمع الثاني", "second new cairo", "2nd new cairo", "second settlement", "2nd settlement"] },
  { city: "EG:cairo", labelAr: "التجمع الثالث", names: ["التجمع الثالث", "third new cairo", "3rd new cairo", "third settlement", "3rd settlement"] },
  { city: "EG:cairo", labelAr: "شبرا", names: ["شبرا", "shubra", "shoubra"] },
  { city: "EG:cairo", labelAr: "عين شمس", names: ["عين شمس", "ain shams"] },
  { city: "EG:cairo", labelAr: "العباسية", names: ["العباسية", "abbasiya", "abbassia", "el abbasiya"] },
  { city: "EG:giza", labelAr: "إمبابة", names: ["امبابة", "إمبابة", "imbaba", "embaba"] },
  { city: "EG:giza", labelAr: "فيصل", names: ["فيصل", "faisal", "el faisal"] },
  { city: "EG:cairo", labelAr: "جاردن سيتي", names: ["جاردن سيتي", "garden city"] },
];
for (const c of COUNTRIES) for (const city of c.cities ?? []) { const own = DISTRICTS.filter((d) => d.city === `${c.code}:${city.id}`); for (const d of own) for (const n of d.names) if (!city.names.includes(n)) city.names.push(n); }

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
export function placeVerdict(placeKeys: ReadonlyArray<string>, mapped: Record<string, unknown>, fields: ReadonlyArray<string>, options: { bySource?: boolean } = {}): PlaceVerdict {
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
    // a CITY of a wanted country is evidence of the country («Cairo», «Giza», «Sheikh Zayed» for «في مصر»); a wanted city is evidence of itself
    if (wanted.some((e) => textHas(e, text)) || ENTRIES.some((e) => e.kind === "city" && wantedWholeCountries.some((w) => w.country === e.country) && textHas(e, text))) { textPositive = true; continue; }
    // another country (not one of the wanted ones) named in the text
    if (COUNTRIES.some((c) => !wantedCountries.has(c.code) && [byKey.get(c.code)!, ...ENTRIES.filter((e) => e.kind === "city" && e.country === c.code)].some((e) => textHas(e, text)))) textNegative = true;
  }
  if (textPositive) return "pass";
  if (textNegative) return "other_place";
  if (weakPositive) return "pass";
  if (weakNegative) return "other_place";
  // THE SOURCE WAS ASKED FOR THE PLACE (its own country filter, recorded with the measuring call): the item came back under that filter, and nothing in the item says otherwise. A source that gives no country field of its own is not left with a stage that delivers 33 of 842.
  return options.bySource === true ? "pass" : "no_evidence";
}

/**
 * Was the SOURCE itself asked for the place? True when a structured input of the recorded first-page call (a country, a location, a place, a region or a city filter, however deep) holds a value that names one of the places: an ISO code («EG»),
 * a name («Egypt»), a city. A free-text search phrase is not a place filter and does not count.
 */
export function placeAskedOfSource(placeKeys: ReadonlyArray<string>, params: unknown): boolean {
  const wanted = new Set(placeKeys.map((k) => byKey.get(k)).filter((e): e is PlaceEntry => Boolean(e)).map((e) => e.country));
  if (wanted.size === 0) return false;
  const geoKey = /country|location|place|region|city|geo|nation/i;
  const walk = (value: unknown, underGeoKey: boolean, depth: number): boolean => {
    if (depth > 6 || value === null || value === undefined) return false;
    if (typeof value === "string") {
      if (!underGeoKey) return false;
      const iso = isoCountryOf(value);
      if (iso && wanted.has(iso)) return true;
      return placesInText(value).some((e) => wanted.has(e.country));
    }
    if (Array.isArray(value)) return value.some((v) => walk(v, underGeoKey, depth + 1));
    if (typeof value === "object") return Object.entries(value as Record<string, unknown>).some(([k, v]) => walk(v, underGeoKey || geoKey.test(k), depth + 1));
    return false;
  };
  return walk(params, false, 0);
}

/** The words of the request that name a place, as the card says them («مصر»), for the filter's sentence. */
export const placeLabelsAr = (entries: ReadonlyArray<PlaceEntry>): string[] => [...new Set(entries.map((e) => e.labelAr))];

// ------------------------------------------------------------------------------------------------- the place cells of the file

/** The kind of place a column holds, from its key or its title: a country, a city, or a region (state, governorate); null for any other column. */
export function placeCellKind(column: { key: string; title_ar?: string }): "country" | "city" | "region" | null {
  const title = column.title_ar ?? "";
  if (/(^|_)(country|country_name|countrycode|country_code|nation)$/i.test(column.key) || /^(?:الدولة|دولة|البلد|بلد)$/.test(title.trim())) return "country";
  if (/(^|_)(city|town|locality)$/i.test(column.key) || /^(?:المدينة|مدينة)$/.test(title.trim())) return "city";
  if (/(^|_)(state|region|governorate|province)$/i.test(column.key) || /^(?:المحافظة|محافظة|المنطقة|منطقة)$/.test(title.trim())) return "region";
  return null;
}

/** The Arabic name of a place when the whole value IS a known place («al qahirah» → «القاهرة», «EG» → «مصر», «Cairo Governorate» → «القاهرة»); null otherwise (a street address, a place the table does not know). */
export function exactPlaceLabelAr(value: unknown, kind: "country" | "city" | "region"): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 60) return null;
  if (kind === "country") { const iso = isoCountryOf(raw); if (iso) return countryOf.get(iso)!.labelAr; }
  const full = normalizeText(raw).replace(/\s+/g, " ").trim();
  const n = full.replace(/\b(?:governorate|city|province|state|region)\b/g, " ").replace(/(?:محافظه|مدينه|منطقه)\s/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return null;
  const wantKind = kind === "country" ? "country" : "city";
  // a district's own name may contain the generic word («Nasr City», «Sheikh Zayed City»): the whole text is tried first, then without the generic words and without a country word after the city
  const variants = (kind === "country" ? [n] : [full, withoutCountryWord(full), n, withoutCountryWord(n)]).filter((x, i, a) => x && a.indexOf(x) === i);
  // the district's own Arabic name first («mokattam» → «المقطم»), then the city's
  for (const v of variants) {
    const district = kind === "country" ? undefined : DISTRICTS.find((d) => d.names.some((name) => normalizeText(name) === v));
    if (district) return district.labelAr;
    const hit = ENTRIES.find((e) => e.kind === wantKind && e.names.some((name) => normalizeText(name) === v));
    if (hit) return hit.labelAr;
  }
  return null;
}

/** A source writes the country after the city («Sheikh Zayed Egypt», «القاهرة مصر», «Cairo, EG»): the country word is not part of the city. */
const withoutCountryWord = (normalized: string): string => normalized.replace(/\b(?:egypt|eg|ksa|uae)\b/g, " ").replace(/(?:^|\s)(?:مصر|السعوديه|الامارات)(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();

/** WORDS THAT ARE NOT A PLACE: a source's cut or empty city value («Of», «the», «n/a», «-»). Never shown as a city. */
const NOT_A_PLACE = new Set(["of", "the", "in", "at", "and", "for", "to", "el", "al", "de", "la", "n/a", "na", "none", "null", "unknown", "undefined", "nan", "tbd", "other", "others"]);
/** True when a place cell holds nothing a reader could take for a place: a stop word, a fragment of one or two letters, only digits or marks. */
export function isPlaceFragment(value: unknown): boolean {
  const t = String(value ?? "").trim();
  if (!t) return false;
  const letters = t.replace(/[^\p{L}]/gu, "");
  if (letters.length === 0) return true;
  const n = normalizeText(t).replace(/[^\p{L}\p{N}/\s]/gu, "").trim();
  return NOT_A_PLACE.has(n) || (letters.length <= 2 && /^[A-Za-z]+$/.test(letters));
}

/** Said in the file where the source did not say the city (never an empty cell when the card promised the place). */
export const PLACE_NOT_STATED_AR = "غير مذكورة في المصدر";

/**
 * THE PLACE CELLS OF A ROW, in Arabic. A country or city the source writes in Latin letters («al qahirah», «EG») is written in Arabic when the table knows it. When the card promised the place (`promised`) no place cell stays empty: the country
 * cell takes the country the item's own evidence proves, the city cell the city another field of the item names, else «غير مذكورة في المصدر». Mutates the row. Pure.
 */
export function placeCellsAr(row: Record<string, unknown>, columns: ReadonlyArray<{ key: string; title_ar?: string }>, mapped: Record<string, unknown>, promised: { places: ReadonlyArray<string>; fields: ReadonlyArray<string> } | null): void {
  for (const col of columns) {
    const kind = placeCellKind(col);
    if (!kind) continue;
    const value = String(row[col.key] ?? "").trim();
    if (value) {
      const label = exactPlaceLabelAr(value, kind);
      if (label) { row[col.key] = label; continue; }
      // a fragment («Of») is not a place: the cell says the source did not state it (no invented city)
      if (isPlaceFragment(value)) { row[col.key] = PLACE_NOT_STATED_AR; continue; }
      continue;
    }
    if (!promised) continue;
    if (kind === "country") {
      const countries = [...new Set(promised.places.map((k) => byKey.get(k)?.country).filter((c): c is string => Boolean(c)))];
      const proven = countries.find((c) => placeVerdict([c], mapped, promised.fields) === "pass") ?? (countries.length === 1 ? countries[0] : null);
      row[col.key] = proven ? countryOf.get(proven)!.labelAr : PLACE_NOT_STATED_AR;
      continue;
    }
    let city: string | null = null;
    for (const f of promised.fields) {
      if (!PLACE_TEXT_KEY.test(f) || f === col.key) continue;
      const found = placesInText(mapped[f]).find((e) => e.kind === "city");
      if (found) { city = found.labelAr; break; }
    }
    row[col.key] = city ?? PLACE_NOT_STATED_AR;
  }
}
