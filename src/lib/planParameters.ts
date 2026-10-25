import { industryLabelAr } from "./industryLabels";
import { countPlainAr } from "./planCounts";
import { CLARIFICATION_ANSWER_LABELS } from "./clarificationLabels";
import { stripConstraintPhrases } from "./requestConstraints";
const GREETING_WORDS = new Set([
  "ازيك",
  "ازيكوا",
  "ازيكم",
  "مرحبا",
  "مرحباً",
  "أهلاً",
  "أهلا",
  "اهلا",
  "صباح الخير",
  "مساء الخير",
  "سلام عليكم",
  "السلام عليكم",
  "هلا",
  "hello",
  "hi",
  "hey",
]);

function isGreeting(val?: string): boolean {
  if (!val) return true;
  const trimmed = val.trim().toLowerCase();
  return GREETING_WORDS.has(trimmed) || /^(ازيك|مرحبا|اهلا|أهلا|هاي|سلام|hello|hi)[\s!.؟?]*$/i.test(trimmed);
}

export interface CountryMapping {
  canonicalEnglish: string;
  arabicLabel: string;
  isDefault?: boolean;
}

export interface IndustryMapping {
  englishKeywords: string[];
  arabicLabel: string;
  exactTaxonomy?: string[];
}

const ISO_3166_ALPHA2_CODES = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(" ");
const countryNamesEn = new Intl.DisplayNames(["en"], { type: "region" });
const countryNamesAr = new Intl.DisplayNames(["ar"], { type: "region" });

function detectCountryValue(value: unknown): CountryMapping | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const named = detectCountryFromText(text);
  if (named) return named;
  if (!/^[A-Z]{2}$/i.test(text)) return null;
  const code = text.toUpperCase();
  const english = countryNamesEn.of(code);
  const arabic = countryNamesAr.of(code);
  if (!english || english.toUpperCase() === code || !arabic || arabic.toUpperCase() === code) return null;
  return { canonicalEnglish: english, arabicLabel: arabic };
}

export function isoCountryCodeFromName(countryName: string): string | undefined {
  const normalized = String(countryName || "").trim().toLowerCase();
  return ISO_3166_ALPHA2_CODES.find((code) => countryNamesEn.of(code)?.toLowerCase() === normalized);
}

export function detectCountryFromText(text: string): CountryMapping | null {
  if (!text || typeof text !== "string") return null;
  const t = text.toLowerCase().trim();

  if (t.includes("ليختنشتاين") || t.includes("liechtenstein")) {
    return { canonicalEnglish: "Liechtenstein", arabicLabel: "ليختنشتاين" };
  }
  if (t.includes("ألمانيا") || t.includes("المانيا") || t.includes("germany") || t.includes("deutschland") || t.includes("برلين") || t.includes("ميونخ")) {
    return { canonicalEnglish: "Germany", arabicLabel: "ألمانيا" };
  }
  if (t.includes("النمسا") || t.includes("austria") || t.includes("österreich") || t.includes("فيينا")) {
    return { canonicalEnglish: "Austria", arabicLabel: "النمسا" };
  }
  if (
    t.includes("السعودية") ||
    t.includes("المملكة العربية السعودية") ||
    t.includes("saudi") ||
    t.includes("ksa") ||
    // «الرياض» is the city; «الرياضة» (sports) is not it.
    /الرياض(?![ةيه])/u.test(t) ||
    t.includes("جدة") ||
    t.includes("الدمام")
  ) {
    return { canonicalEnglish: "Saudi Arabia", arabicLabel: "المملكة العربية السعودية" };
  }
  if (
    t.includes("الإمارات") ||
    t.includes("الامارات") ||
    t.includes("دبي") ||
    t.includes("أبوظبي") ||
    t.includes("ابوظبي") ||
    t.includes("uae") ||
    t.includes("emirates") ||
    t.includes("الشارقة")
  ) {
    return { canonicalEnglish: "United Arab Emirates", arabicLabel: "الإمارات العربية المتحدة" };
  }
  if (
    t.includes("مصر") ||
    t.includes("القاهرة") ||
    t.includes("الإسكندرية") ||
    t.includes("الاسكندرية") ||
    t.includes("الجيزة") ||
    t.includes("egypt") ||
    t.includes("cairo") ||
    t.includes("alexandria")
  ) {
    return { canonicalEnglish: "Egypt", arabicLabel: "مصر" };
  }
  if (t.includes("الكويت") || t.includes("kuwait")) {
    return { canonicalEnglish: "Kuwait", arabicLabel: "الكويت" };
  }
  if (t.includes("قطر") || t.includes("qatar") || t.includes("الدوحة")) {
    return { canonicalEnglish: "Qatar", arabicLabel: "قطر" };
  }
  if (t.includes("البحرين") || t.includes("bahrain") || t.includes("المنامة")) {
    return { canonicalEnglish: "Bahrain", arabicLabel: "البحرين" };
  }
  if (t.includes("عمان") || t.includes("سلطنة عمان") || t.includes("oman") || t.includes("مسقط")) {
    return { canonicalEnglish: "Oman", arabicLabel: "سلطنة عمان" };
  }
  if (t.includes("الأردن") || t.includes("الاردن") || t.includes("jordan")) {
    return { canonicalEnglish: "Jordan", arabicLabel: "الأردن" };
  }
  if (t.includes("المملكة المتحدة") || t.includes("بريطانيا") || t.includes("إنجلترا") || t.includes("uk") || t.includes("united kingdom") || t.includes("لندن")) {
    return { canonicalEnglish: "United Kingdom", arabicLabel: "المملكة المتحدة" };
  }
  if (t.includes("الولايات المتحدة") || t.includes("أمريكا") || t.includes("امريكا") || t.includes("usa") || t.includes("united states") || t.includes("نيويورك")) {
    return { canonicalEnglish: "United States", arabicLabel: "الولايات المتحدة" };
  }
  if (t.includes("فرنسا") || t.includes("france") || t.includes("باريس")) {
    return { canonicalEnglish: "France", arabicLabel: "فرنسا" };
  }
  if (t.includes("إيطاليا") || t.includes("ايطاليا") || t.includes("italy") || t.includes("روما")) {
    return { canonicalEnglish: "Italy", arabicLabel: "إيطاليا" };
  }
  if (t.includes("إسبانيا") || t.includes("اسبانيا") || t.includes("spain") || t.includes("مدريد")) {
    return { canonicalEnglish: "Spain", arabicLabel: "إسبانيا" };
  }
  if (t.includes("سويسرا") || t.includes("switzerland") || t.includes("جنيف") || t.includes("زيورخ")) {
    return { canonicalEnglish: "Switzerland", arabicLabel: "سويسرا" };
  }
  if (t.includes("هولندا") || t.includes("netherlands") || t.includes("holland") || t.includes("أمستردام")) {
    return { canonicalEnglish: "Netherlands", arabicLabel: "هولندا" };
  }
  if (t.includes("تركيا") || t.includes("turkey") || t.includes("türkiye") || t.includes("إسطنبول")) {
    return { canonicalEnglish: "Turkey", arabicLabel: "تركيا" };
  }

  // Resolve the rest of ISO country names through the runtime's standard
  // localization data, so explicit countries anywhere in the world survive
  // discovery and provider normalization without a regional allowlist.
  for (const code of ISO_3166_ALPHA2_CODES) {
    const english = countryNamesEn.of(code);
    const arabic = countryNamesAr.of(code);
    if (!english || !arabic || english === code || arabic === code) continue;
    const englishIndex = t.indexOf(english.toLowerCase());
    const before = englishIndex > 0 ? t[englishIndex - 1] : " ";
    const after = englishIndex >= 0 ? t[englishIndex + english.length] || " " : " ";
    const englishMatch = englishIndex >= 0 && !/[\\p{L}]/u.test(before) && !/[\\p{L}]/u.test(after);
    if (englishMatch || t.includes(arabic.toLowerCase())) return { canonicalEnglish: english, arabicLabel: arabic };
  }

  return null;
}

/** The label of a sector the customer wrote in English that no rule knows. */
export const CUSTOM_SECTOR_LABEL_AR = "النشاط الذي ذكرته";

/** The placeholders a plan card holds while a value is missing. They are asked for, never shown as a value in a field or a step. */
export const COUNTRY_REQUIRED_AR = "يلزم تحديد الدولة";
export const INDUSTRY_REQUIRED_AR = "يلزم تحديد النشاط";

/** A field value for an input box or a sentence: the placeholder becomes an empty string. */
export function valueOrEmpty(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return /يلزم تحديد/.test(text) ? "" : text;
}

/** «المجال · الدولة» for a step sentence, with every missing part left out (never the placeholder). */
export function scopePartsAr(...parts: Array<string | null | undefined>): string {
  return parts.map(valueOrEmpty).filter(Boolean).join(" · ");
}

interface MoreSector { words: Array<{ text: string; latin?: boolean }>; englishKeywords: string[]; arabicLabel: string; exactTaxonomy: string[] }
const w = (text: string) => ({ text });
const lw = (text: string) => ({ text, latin: true });
const MORE_SECTORS: MoreSector[] = [
  { words: [w("اتصالات"), w("تليكوم"), w("تلكوم"), w("شبكات المحمول"), w("telecom"), w("telecommunication")], englishKeywords: ["telecommunications", "telecom", "mobile operators"], arabicLabel: "الاتصالات", exactTaxonomy: ["Telecommunications"] },
  { words: [w("تأمين"), w("تامين"), w("insurance")], englishKeywords: ["insurance"], arabicLabel: "التأمين", exactTaxonomy: ["Insurance"] },
  { words: [w("بنوك"), w("مصارف"), w("بنك"), w("مصرفي"), w("banking"), lw("banks?")], englishKeywords: ["banking", "financial services"], arabicLabel: "البنوك والخدمات المصرفية", exactTaxonomy: ["Banking", "Financial Services"] },
  { words: [w("الخدمات المالية"), w("خدمات مالية"), w("استثمار"), w("financial services")], englishKeywords: ["financial services", "investment"], arabicLabel: "الخدمات المالية", exactTaxonomy: ["Financial Services", "Investment Banking"] },
  { words: [w("صحة"), w("صحي"), w("مستشفي"), w("رعاية طبية"), w("عيادات"), w("طبي"), w("healthcare"), w("health care"), w("hospital")], englishKeywords: ["healthcare", "hospital", "medical"], arabicLabel: "الصحة والرعاية الطبية", exactTaxonomy: ["Hospital & Health Care", "Medical Devices"] },
  { words: [w("تجزئة"), w("تجارة"), w("متاجر"), w("سوبر ماركت"), w("جملة"), w("retail"), w("wholesale")], englishKeywords: ["retail", "wholesale", "consumer goods"], arabicLabel: "التجارة والتجزئة", exactTaxonomy: ["Retail", "Wholesale", "Consumer Goods"] },
  { words: [w("زراعة"), w("زراعي"), w("مزارع"), w("agricultur"), w("farming")], englishKeywords: ["agriculture", "farming"], arabicLabel: "الزراعة", exactTaxonomy: ["Farming", "Agriculture"] },
  { words: [w("إعلام"), w("اعلام"), w("إعلان"), w("اعلان"), w("دعاية"), w("تسويق"), w("media"), w("advertising"), w("marketing")], englishKeywords: ["media", "advertising", "marketing"], arabicLabel: "الإعلام والتسويق", exactTaxonomy: ["Media Production", "Marketing & Advertising"] },
  { words: [w("محاماة"), w("قانوني"), w("مكاتب محاماه"), w("legal"), w("law firm")], englishKeywords: ["legal services", "law firm"], arabicLabel: "الخدمات القانونية", exactTaxonomy: ["Legal Services", "Law Practice"] },
  { words: [w("استشارات"), w("استشاري"), w("consulting")], englishKeywords: ["consulting", "management consulting"], arabicLabel: "الاستشارات", exactTaxonomy: ["Management Consulting"] },
  { words: [w("كيماويات"), w("كيماوي"), w("بلاستيك"), w("chemical"), w("plastics")], englishKeywords: ["chemicals", "plastics"], arabicLabel: "الكيماويات والبلاستيك", exactTaxonomy: ["Chemicals", "Plastics"] },
  { words: [w("نسيج"), w("منسوجات"), w("ملابس"), w("أزياء"), w("ازياء"), w("textile"), w("apparel"), w("fashion")], englishKeywords: ["textiles", "apparel", "fashion"], arabicLabel: "النسيج والملابس", exactTaxonomy: ["Textiles", "Apparel & Fashion"] },
  { words: [w("تعدين"), w("معادن"), w("mining"), w("metals")], englishKeywords: ["mining", "metals"], arabicLabel: "التعدين والمعادن", exactTaxonomy: ["Mining & Metals"] },
  { words: [w("توظيف"), w("موارد بشرية"), w("staffing"), w("recruiting")], englishKeywords: ["staffing", "recruiting", "human resources"], arabicLabel: "التوظيف والموارد البشرية", exactTaxonomy: ["Staffing & Recruiting", "Human Resources"] },
  { words: [w("طباعة"), w("تغليف"), w("printing"), w("packaging")], englishKeywords: ["printing", "packaging"], arabicLabel: "الطباعة والتغليف", exactTaxonomy: ["Printing", "Packaging & Containers"] },
];

/** The chip that opens the custom-answer field. As an answer it says nothing about the sector. */
const OTHER_CHIP_RE = /^(?:أخرى|اخرى|أخري|اخري|other|others)[\s.!،]*$/iu;
/** The other stored answer labels: an answer ends where the next label begins. */
const NEXT_ANSWER_LABEL = "(?:الدولة المطلوبة|المجال المطلوب|إجابة هدف التواصل|إجابة المقصود|عدد الشركات المطلوب|نطاق صناع القرار|المسميات المطلوبة|عدد صناع القرار المطلوب|موضوع البحث المطلوب|منصة البحث المطلوبة|الفترة المطلوبة|اسم الحساب المطلوب)";
const INDUSTRY_ANSWER_RE = new RegExp(`(?:^|[\\s|])المجال المطلوب:\\s*([^|\\n]+?)(?=\\s+${NEXT_ANSWER_LABEL}:|\\s*\\||\\n|$)`, "gu");

/** «اتصالات اتصالات» (the card repeats the answer) reads as «اتصالات». */
function collapseRepeatedAnswer(value: string): string {
  const words = value.trim().split(/\s+/);
  if (words.length % 2 === 0) {
    const half = words.length / 2;
    if (words.slice(0, half).join(" ") === words.slice(half).join(" ")) return words.slice(0, half).join(" ");
  }
  return value.trim();
}

/**
 * What the customer answered to the sector question, as it sits in the request text («… المجال المطلوب: اتصالات»), wherever in the text it sits
 * (the card answers are joined with a space as well as with « | »). The chip «أخرى» alone is not an answer. The last real answer wins.
 */
export function industryAnswerFromText(text: string): string | null {
  let answer: string | null = null;
  for (const match of String(text || "").matchAll(INDUSTRY_ANSWER_RE)) {
    const value = collapseRepeatedAnswer(match[1].replace(/[\u200B-\u200F\u2060\u2063]/gu, ""));
    if (value && !OTHER_CHIP_RE.test(value)) answer = value;
  }
  return answer;
}

/** True when the only thing said about the sector is the chip «أخرى»: the custom field was opened and nothing was written in it. */
export function industryAnsweredWithOtherChipOnly(text: string): boolean {
  let sawChip = false;
  for (const match of String(text || "").matchAll(INDUSTRY_ANSWER_RE)) {
    const value = collapseRepeatedAnswer(match[1].replace(/[\u200B-\u200F\u2060\u2063]/gu, ""));
    if (!value) continue;
    if (OTHER_CHIP_RE.test(value)) sawChip = true;
    else return false;
  }
  return sawChip;
}

export function detectIndustryFromText(text: string): IndustryMapping {
  // The sector the customer answered with wins over everything else said in the conversation, and is read on its own (the words of the
  // question around it are not part of the sector).
  const answered = industryAnswerFromText(text);
  const lowered = (answered ?? text ?? "").toLowerCase().trim();
  // The sector words are written without the definite article («تطوير عقاري»); the customer's text and the plan's own Arabic
  // label carry it («التطوير العقاري»). Both spellings are searched, so a label is always read back as the sector it names.
  const withoutArticle = lowered.replace(/(^|[\s،,.:؛()«»"'])(?:وال|بال|لل|ال)(?=[\u0621-\u064A])/g, "$1");
  const t = withoutArticle === lowered ? lowered : `${lowered} ${withoutArticle}`;

  const hasLatinWord = (word: string) => new RegExp(`(?<![a-z0-9])${word}(?![a-z0-9])`).test(t);

  // The two-sector chips of the sector question, read as both sectors.
  if (/بنوك\s*و\s*تأمين|بنوك\s*و\s*تامين|مصارف\s*و\s*تأمين|banking\s*(?:and|&)\s*insurance/.test(t)) {
    return { englishKeywords: ["banking", "insurance", "financial services"], arabicLabel: "البنوك والتأمين", exactTaxonomy: ["Banking", "Insurance", "Financial Services"] };
  }
  if (/مقاولات\s*و\s*عقارات|مقاولات\s*وتطوير\s*عقاري|construction\s*(?:and|&)\s*real\s*estate/.test(t)) {
    return { englishKeywords: ["construction", "contracting", "real estate"], arabicLabel: "المقاولات والعقارات", exactTaxonomy: ["Construction", "Real Estate"] };
  }

  if (
    t.includes("fintech") || t.includes("financial technology") ||
    t.includes("التقنية المالية") || t.includes("التكنولوجيا المالية") ||
    t.includes("تقنية مالية") || t.includes("تكنولوجيا مالية") ||
    t.includes("مدفوعات") || t.includes("فينتك") || t.includes("فنتك")
  ) {
    return {
      englishKeywords: ["fintech", "financial technology"],
      arabicLabel: "FinTech",
      // Financial services only: adding IT services here pulls every software house into a fintech search.
      exactTaxonomy: ["Financial Services", "Banking"],
    };
  }

  if (t.includes("صواريخ") || t.includes("صاروخ") || t.includes("rocket") || t.includes("aerospace") || t.includes("فضاء")) {
    return {
      englishKeywords: ["aerospace", "rocket"],
      arabicLabel: "صناعة الصواريخ والفضاء",
      exactTaxonomy: ["Aviation & Aerospace", "Defense & Space"],
    };
  }
  if (t.includes("طاقة شمسية") || t.includes("شمسية") || t.includes("solar") || t.includes("طاقة متجددة") || t.includes("renewable")) {
    return {
      englishKeywords: ["solar", "solar energy", "renewable energy"],
      arabicLabel: "الطاقة الشمسية والمتجددة",
      exactTaxonomy: ["Renewables & Environment"],
    };
  }
  if (t.includes("كهروميكانيك") || t.includes("electromechanical") || hasLatinWord("mep")) {
    return {
      englishKeywords: ["electromechanical", "MEP contracting", "electrical contracting"],
      arabicLabel: "المقاولات الكهروميكانيكية",
      exactTaxonomy: ["Construction", "Mechanical or Industrial Engineering", "Electrical/Electronic Manufacturing"],
    };
  }
  // «كهربا» (the everyday spelling) is the stem of «كهرباء» and «كهربائية», so one test reads all three.
  if (t.includes("كهربا") || t.includes("كهربه") || t.includes("electrical") || t.includes("electricity")) {
    return {
      englishKeywords: ["electrical", "electricity", "electrical engineering"],
      arabicLabel: "الكهرباء والطاقة الكهربائية",
      exactTaxonomy: ["Electrical/Electronic Manufacturing", "Utilities"],
    };
  }
  if (t.includes("الطاقة") || t.includes("طاقة") || hasLatinWord("energy") || t.includes("بترول") || t.includes("نفط") || t.includes("oil and gas") || t.includes("oil & gas")) {
    // General energy (after the more specific solar and electricity cases above).
    return {
      englishKeywords: ["energy", "power", "utilities", "oil and gas"],
      arabicLabel: "الطاقة",
      exactTaxonomy: ["Oil & Energy", "Utilities", "Renewables & Environment"],
    };
  }
  if (t.includes("أغذية") || t.includes("اغذية") || t.includes("طعام") || t.includes("مطاعم") || t.includes("أطعمة") || t.includes("food") || t.includes("beverage")) {
    return {
      englishKeywords: ["food", "beverages", "restaurants"],
      arabicLabel: "الأغذية والمطاعم",
      exactTaxonomy: ["Food & Beverages", "Food Production", "Restaurants"],
    };
  }
  if (
    t.includes("تقنية") ||
    t.includes("تكنولوجيا") ||
    t.includes("معلومات") ||
    t.includes("برمجيات") ||
    t.includes("برمجة") ||
    t.includes("software") ||
    t.includes("information technology") ||
    t.includes("it services") ||
    // Whole Latin words only: a bare substring test matched "united", "italy", "technical" and "electricity".
    hasLatinWord("tech") ||
    hasLatinWord("it")
  ) {
    return {
      englishKeywords: ["information technology", "software", "technology"],
      arabicLabel: "تقنية المعلومات والبرمجيات",
      exactTaxonomy: ["Information Technology & Services", "Computer Software", "Internet"],
    };
  }
  if (
    t.includes("مقاولات") ||
    t.includes("تشييد") ||
    t.includes("بناء") ||
    t.includes("construction") ||
    t.includes("contracting")
  ) {
    return {
      englishKeywords: ["construction", "contracting"],
      arabicLabel: "المقاولات والتشييد",
      // Building Materials is a supplier category and pulls unrelated manufacturers into a contractor search.
      exactTaxonomy: ["Construction"],
    };
  }
  if (t.includes("أثاث") || t.includes("اثاث") || t.includes("موبيليا") || t.includes("furniture") || t.includes("woodworking")) {
    return {
      englishKeywords: ["furniture", "woodworking"],
      arabicLabel: "صناعة الأثاث",
      exactTaxonomy: ["Furniture"],
    };
  }
  if (t.includes("عقارات") || t.includes("تطوير عقاري") || t.includes("real estate")) {
    return {
      englishKeywords: ["real estate"],
      arabicLabel: "التطوير العقاري",
      exactTaxonomy: ["Real Estate"],
    };
  }
  if (t.includes("أدوية") || t.includes("ادوية") || t.includes("صيدلة") || t.includes("pharma")) {
    return {
      englishKeywords: ["pharmaceuticals", "healthcare"],
      arabicLabel: "الأدوية والرعاية الصحية",
      exactTaxonomy: ["Pharmaceuticals", "Hospital & Health Care"],
    };
  }
  if (t.includes("سيارات") || t.includes("automotive") || t.includes("vehicles")) {
    return {
      englishKeywords: ["automotive", "vehicles"],
      arabicLabel: "السيارات والمركبات",
      exactTaxonomy: ["Automotive"],
    };
  }
  if (t.includes("تعليم") || t.includes("مدارس") || t.includes("education")) {
    return {
      englishKeywords: ["education"],
      arabicLabel: "التعليم",
      exactTaxonomy: ["Education Management", "Primary/Secondary Education"],
    };
  }
  if (t.includes("سياحة") || t.includes("فنادق") || t.includes("tourism") || t.includes("hospitality")) {
    return {
      englishKeywords: ["tourism", "hospitality"],
      arabicLabel: "السياحة والضيافة",
      exactTaxonomy: ["Hospitality", "Leisure, Travel & Tourism"],
    };
  }
  if (t.includes("شحن") || t.includes("لوجستيات") || t.includes("logistics") || t.includes("freight")) {
    return {
      englishKeywords: ["logistics", "freight"],
      arabicLabel: "الشحن والخدمات اللوجستية",
      exactTaxonomy: ["Transportation/Trucking/Railroad", "Logistics & Supply Chain"],
    };
  }
  if (t.includes("صيد الحيتان") || t.includes("حيتان") || t.includes("whale hunting") || t.includes("whaling")) {
    return {
      englishKeywords: ["whale hunting", "whaling"],
      arabicLabel: "صيد الحيتان",
    };
  }
  if (t.includes("مصانع") || t.includes("تصنيع") || t.includes("صناعة") || t.includes("manufacturing") || t.includes("factory")) {
    return {
      englishKeywords: ["manufacturing", "factory"],
      arabicLabel: "التصنيع والإنتاج الصناعي",
      exactTaxonomy: ["Electrical/Electronic Manufacturing", "Machinery", "Mechanical or Industrial Engineering"],
    };
  }

  // More sectors, by the words customers use (Arabic and English). The taxonomy is the source's own English names; the label is Arabic.
  for (const sector of MORE_SECTORS) {
    if (sector.words.some((word) => (word.latin ? hasLatinWord(word.text) : t.includes(word.text)))) {
      return { englishKeywords: sector.englishKeywords, arabicLabel: sector.arabicLabel, exactTaxonomy: sector.exactTaxonomy };
    }
  }

  const cleaned = residualSectorText(lowered);

  if (cleaned.length > 0) {
    // A typo of a sector word («كهربا», «تصنيه», «مقاولت») is read as that sector: one edit away from a word the rules know.
    // Only a short residue is repaired (a sector is a word or two); a long sentence is never matched word by word against the sector words.
    const corrected = cleaned.split(" ").length <= 3 ? fuzzySectorCorrection(cleaned) : null;
    if (corrected && corrected !== cleaned) return detectIndustryFromText(corrected);
    // A sector written in English that no rule knows is searched by its words, but its label is Arabic: the customer never reads an English sector name.
    return { englishKeywords: [cleaned], arabicLabel: /[؀-ۿ]/u.test(cleaned) ? cleaned : CUSTOM_SECTOR_LABEL_AR };
  }

  return { englishKeywords: [], arabicLabel: INDUSTRY_REQUIRED_AR };
}

/** The words that name a country in the rules above (cities included): they say WHERE, so they are never part of the sector. */
const COUNTRY_ALIAS_WORDS = [
  "ليختنشتاين", "liechtenstein", "ألمانيا", "المانيا", "germany", "deutschland", "برلين", "ميونخ", "النمسا", "austria", "österreich", "فيينا",
  "المملكة العربية السعودية", "السعودية", "saudi arabia", "saudi", "ksa", "الرياض", "جدة", "الدمام", "الإمارات", "الامارات", "دبي", "أبوظبي", "ابوظبي", "united arab emirates", "uae", "emirates", "الشارقة",
  "مصر", "القاهرة", "الإسكندرية", "الاسكندرية", "الجيزة", "egypt", "cairo", "alexandria", "الكويت", "kuwait", "قطر", "qatar", "الدوحة", "البحرين", "bahrain", "المنامة",
  "سلطنة عمان", "oman", "مسقط", "الأردن", "الاردن", "jordan", "المملكة المتحدة", "بريطانيا", "إنجلترا", "united kingdom", "لندن", "الولايات المتحدة", "أمريكا", "امريكا", "united states", "نيويورك",
  "فرنسا", "france", "باريس", "إيطاليا", "ايطاليا", "italy", "روما", "إسبانيا", "اسبانيا", "spain", "مدريد", "سويسرا", "switzerland", "جنيف", "زيورخ", "هولندا", "netherlands", "holland", "أمستردام", "تركيا", "turkey", "türkiye", "إسطنبول",
].sort((a, b) => b.length - a.length);

const COUNTRY_ALIAS_REGEXES = COUNTRY_ALIAS_WORDS.map(
  (alias) => new RegExp(`(?<![\\p{L}])[وبلف]?${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "giu"),
);

/** The words of a stored card label («الدولة المطلوبة», «المجال المطلوب»…) and the filler around them: never a sector. */
const LABEL_PHRASES = Object.values(CLARIFICATION_ANSWER_LABELS).sort((a, b) => b.length - a.length);
const LABEL_NOISE_WORDS = /(?<![\p{L}\p{N}])(?:المطلوب[ةه]?|مطلوب[ةه]?|الدولة|دولة|المجال|القطاع|النشاط|العدد|عدد|الحد|الأقصى|الاقصى|أخرى|اخرى|أخري|اخري|other|others)(?![\p{L}\p{N}])/giu;
/** «مش عارف», «أي حاجة», «مش مهم»: a reply that says nothing about the sector, so it is no sector. */
const NON_ANSWER_WORDS = /(?<![\p{L}\p{N}])(?:مش|عارف[ةه]?|معرفش|لا|اعرف|أعرف|اي|أي|اى|أى|حاجه|حاجة|شيء|شئ|مهم|يهم|فارق[ةه]?|مفيش|تمام)(?![\p{L}\p{N}])/giu;

/**
 * What is left of a request once the count, the places, the card labels and the filler are taken away: the customer's own words for the sector,
 * or nothing. «عايز ١٠ شركات المجال المطلوب:» leaves nothing (it used to leave «ال المطلوب مطلوب», a broken field shown as the sector), and
 * «شركات كهربا في مصر» leaves «كهربا» (it used to leave «كهربا مصر»).
 */
function residualSectorText(lowered: string): string {
  let text = lowered;
  for (const phrase of LABEL_PHRASES) text = text.split(phrase).join(" ");
  // Whole words only (with the one-letter prefixes «في/ب/ل/و»): «الرياض» is a city, «الرياضة» is a sector.
  for (const alias of COUNTRY_ALIAS_REGEXES) text = text.replace(alias, " ");
  const country = detectCountryFromText(text);
  if (country) text = text.split(country.arabicLabel.toLowerCase()).join(" ").split(country.canonicalEnglish.toLowerCase()).join(" ");
  const cleaned = text
    .replace(/[^\w\s\u0600-\u06FF]/g, " ")
    .replace(/[٠-٩0-9]/g, " ")
    .replace(/\b(عايز|عاوز|محتاج|اريد|أريد|شركات|شركة|مؤسسات|مؤسسة|مجال|نشاط|ملف|في|داخل|بـ|in|companies|company|need|want|find)\b/gi, "")
    .replace(/عايز|عاوز|محتاج|اريد|أريد|شركات|شركة|مؤسسات|مؤسسة|مجال|نشاط|خطة|استخراج|ملف|في|داخل|بـ/gi, " ")
    .replace(LABEL_NOISE_WORDS, " ")
    .replace(NON_ANSWER_WORDS, " ")
    .replace(/(?<![\p{L}\p{N}])ال(?![\p{L}\p{N}])/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // The same word twice in a row («رياضة رياضة», the card repeats an answer) is one word.
  return cleaned.split(" ").filter((word, index, all) => index === 0 || word !== all[index - 1]).join(" ");
}

/** The sector words the rules read (the spellings the rules test for), used to repair a typo. */
const FUZZY_SECTOR_WORDS = [
  "كهرباء", "كهروميكانيك", "طاقة", "بترول", "أغذية", "مطاعم", "تقنية", "تكنولوجيا", "برمجيات", "برمجة", "مقاولات", "تشييد", "عقارات", "أثاث", "أدوية", "صيدلة",
  "سيارات", "تعليم", "مدارس", "سياحة", "فنادق", "لوجستيات", "تصنيع", "مصانع", "صناعة", "اتصالات", "تأمين", "بنوك", "مصارف", "استثمار", "عيادات", "تجزئة", "تجارة",
  "متاجر", "زراعة", "مزارع", "إعلام", "إعلان", "تسويق", "محاماة", "استشارات", "كيماويات", "بلاستيك", "منسوجات", "ملابس", "أزياء", "تعدين", "معادن", "توظيف", "طباعة", "تغليف", "صحة",
];

/** One spelling per letter family: hamza forms, ي/ى, ة/ه, and the hamza itself dropped («كهرباء» = «كهربا»). */
function foldArabicSpelling(word: string): string {
  return word
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/[ئ]/g, "ي")
    .replace(/ء/g, "");
}

/** Edit distance, stopping early once it is above `limit`. */
function editDistanceWithin(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row.push(value);
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length];
}

/**
 * The text with each word that is one edit away from a sector word replaced by that word, or null when no word is. Words shorter than four
 * letters are left alone, and so is a word two or more edits away, so a real custom sector («رياضة») is never rewritten into another one.
 */
function fuzzySectorCorrection(text: string): string | null {
  const folded = FUZZY_SECTOR_WORDS.map((word) => ({ word, key: foldArabicSpelling(word) }));
  let changed = false;
  const words = text.split(" ").map((token) => {
    if (!/^[؀-ۿ]{4,}$/u.test(token)) return token;
    const key = foldArabicSpelling(token.replace(/^(?:وال|بال|لل|ال)(?=[؀-ۿ]{4})/u, ""));
    if (key.length < 4) return token;
    // A four-letter word one edit away is too often another word («صناع» is makers, not «صناعة» industry): it must match after folding.
    const limit = key.length >= 8 ? 2 : key.length >= 5 ? 1 : 0;
    // The nearest word wins; among equals, the one that shares the longest beginning with the typed word («تصنيه» is «تصنيع», not «تقنية»).
    let best: { word: string; distance: number; prefix: number } | null = null;
    for (const entry of folded) {
      const distance = editDistanceWithin(key, entry.key, limit);
      if (distance > limit) continue;
      let prefix = 0;
      while (prefix < key.length && prefix < entry.key.length && key[prefix] === entry.key[prefix]) prefix++;
      if (!best || distance < best.distance || (distance === best.distance && prefix > best.prefix)) best = { word: entry.word, distance, prefix };
    }
    if (!best) return token;
    changed = true;
    return best.word;
  });
  return changed ? words.join(" ") : null;
}

/**
 * THE activity name of a plan, in Arabic: the plan summary, the chip, the editor field and the method steps all read it from here, so one request
 * never shows two names for the same sector. The stored Arabic label wins, then the source's taxonomy, then the keywords. Empty when there is none.
 */
export function planActivityLabelAr(params: Record<string, any> | undefined | null): string {
  const p = params || {};
  const query = p.query && typeof p.query === "object" ? p.query : {};
  const first = (value: any): string | undefined => (typeof value === "string" ? value : Array.isArray(value?.include) && typeof value.include[0] === "string" ? value.include[0] : undefined);
  for (const candidate of [p.industry, first(query.industry), first(query.keyword), p.keyword, p.search, typeof p.query === "string" ? p.query : undefined]) {
    if (typeof candidate !== "string" || !candidate.trim() || /يلزم تحديد/.test(candidate)) continue;
    const label = detectIndustryFromText(candidate).arabicLabel;
    if (label !== INDUSTRY_REQUIRED_AR) return industryDisplayLabelAr(label);
  }
  return "";
}

/**
 * The goal line of a plan after an edit. A missing country or activity is left out of the sentence («… في يلزم تحديد الدولة» used to be saved as
 * the summary), and the count is written with Arabic-Indic digits like every other customer text.
 */
export function editedPlanSummaryAr(item: { capabilitySlug?: string; params?: Record<string, any>; targetVolumeMax?: number } | undefined, summaryAr: string | undefined, toDigits: (value: number | string) => string): string {
  const people = String(item?.capabilitySlug || "").toLowerCase().includes("people");
  const interpreted = extractInterpretedParameters(item?.params, summaryAr, people);
  const activity = people ? interpreted.industryAr : planActivityLabelAr(item?.params) || valueOrEmpty(industryDisplayLabelAr(interpreted.industryAr));
  const country = valueOrEmpty(interpreted.countryAr);
  const volume = countPlainAr(Number(item?.targetVolumeMax) || 50, "records");
  void toDigits;
  return `خطة حصر حتى ${volume}${activity ? `: ${activity}` : ""}${country ? ` في ${country}` : ""}`;
}

/**
 * What stops a plan edit from being saved: a country that no rule reads (it used to be dropped without a word, so the edit looked saved and
 * was not) and an empty required field. Null when the edit can be saved.
 */
export function planEditScopeError(input: { country: string; industry: string; needsCountry: boolean; needsIndustry: boolean }): string | null {
  const country = valueOrEmpty(input.country);
  if (input.needsCountry && !country) return "اكتب الدولة قبل حفظ التعديل.";
  if (country && !detectCountryFromText(country) && !/^[A-Za-z]{2}$/.test(country)) return "لم أتعرف على هذه الدولة. اكتبها باسمها، مثل: مصر أو السعودية أو ألمانيا.";
  if (input.needsIndustry && !valueOrEmpty(input.industry)) return "اكتب النشاط قبل حفظ التعديل.";
  return null;
}

/** Customer-facing industry label for recognized English taxonomy names. */
export function industryDisplayLabelAr(label: string): string {
  const value = String(label ?? "");
  if (value.trim().toLowerCase() === "fintech") return "التقنية المالية";
  // An English sector name never reaches the customer: a known taxonomy name is read as its Arabic name, any other English label as a neutral Arabic phrase.
  if (value.trim() && !/[؀-ۿ]/u.test(value) && /[A-Za-z]/.test(value)) return industryLabelAr(value) ?? CUSTOM_SECTOR_LABEL_AR;
  return value;
}

/** Pull the searchable subject out of a generated social/video task title. */
export function socialContentTopicFromTitle(title: string, countryLabel?: string): string {
  let topic = String(title || "")
    .replace(/^(?:اجمع|جمع|استخرج|هات|أظهر|ابحث\s+عن)\s+(?:[٠-٩0-9]+\s+)?/u, "")
    .replace(/^(?:فيديوهات?|مقاطع?|منشورات?|محتوى)\s*/u, "")
    .replace(/^(?:تريند|ترند|رائجة|شائعة)\s*/u, "")
    .replace(/\s+(?:على|في|من)\s+(?:تيك\s*توك|tiktok|يوتيوب|youtube|انستغرام|إنستغرام|instagram|فيسبوك|facebook|تويتر|twitter|reddit).*$/iu, "")
    .replace(/^(?:تيك\s*توك|tiktok|يوتيوب|youtube|انستغرام|إنستغرام|instagram|فيسبوك|facebook|تويتر|twitter|reddit)\s+/iu, "")
    .trim();

  if (countryLabel && topic && !topic.toLocaleLowerCase().includes(countryLabel.toLocaleLowerCase())) {
    topic = `${topic} في ${countryLabel}`;
  }
  return topic;
}

/** TikTok's source search matches English terms much more reliably than Arabic. */
export function socialSearchQueryFromTitle(title: string, countryLabel?: string): string {
  const topic = socialContentTopicFromTitle(title, countryLabel);
  if (!topic) return "";

  const translations: Array<[RegExp, string]> = [
    [/كرة\s*القدم|كورة\s*القدم|كوره\s*القدم|كرة\s*قدم/u, "football"],
    [/كرة\s*السلة|باسكت/u, "basketball"],
    [/كرة\s*الطائرة/u, "volleyball"],
    [/رياضة|رياضي/u, "sports"],
    [/طبخ|وصفات|مطبخ/u, "cooking recipes"],
    [/ذكاء\s*اصطناعي|ذكاء\s*صناعي|الذكاء\s*الاصطناعي/u, "artificial intelligence"],
    [/سيارات|عربيات/u, "cars"],
    [/موضة|أزياء|ازياء/u, "fashion"],
    [/موسيقى|اغاني|أغاني/u, "music"],
    [/ألعاب|العاب|جيمينج|قيمنج/u, "gaming"],
    [/سياحة|سفر|رحلات/u, "travel"],
    [/تعليم|دراسة|دراسه/u, "education"],
    [/تقنية|تكنولوجيا|برمجة|برمجه/u, "technology"],
    [/أخبار|اخبار/u, "news"],
  ];
  const matched = translations.find(([pattern]) => pattern.test(topic));
  if (!matched) return topic;

  const countryEnglish: Record<string, string> = {
    "مصر": "Egypt",
    "المملكة العربية السعودية": "Saudi Arabia",
    "الإمارات العربية المتحدة": "United Arab Emirates",
    "المملكة المتحدة": "United Kingdom",
    "الولايات المتحدة": "United States",
    "ألمانيا": "Germany",
    "فرنسا": "France",
    "الكويت": "Kuwait",
    "قطر": "Qatar",
    "الأردن": "Jordan",
    "البحرين": "Bahrain",
    "سلطنة عمان": "Oman",
  };
  const englishCountry = countryLabel ? countryEnglish[countryLabel] : undefined;
  return [matched[1], englishCountry].filter(Boolean).join(" ");
}

export function isCompanyRowMatchingLocation(row: Record<string, any>, expectedCountryCanonical?: string | null): boolean {
  if (!expectedCountryCanonical) return true;
  const targetLower = expectedCountryCanonical.toLowerCase().trim();
  const rowLoc = String(row.location || row.address || row.country || row.city || "").toLowerCase();
  const rowWeb = String(row.website || row.linkedin_url || "").toLowerCase();
  const rowDesc = String(row.description || "").toLowerCase();

  if (targetLower.includes("liechtenstein")) {
    return (
      rowLoc.includes("liechtenstein") ||
      rowLoc.includes("balzers") ||
      rowLoc.includes("vaduz") ||
      rowLoc.includes("schaan") ||
      rowWeb.includes(".li") ||
      rowDesc.includes("liechtenstein")
    );
  }
  if (targetLower.includes("saudi")) {
    return (
      rowLoc.includes("saudi") ||
      rowLoc.includes("riyadh") ||
      rowLoc.includes("jeddah") ||
      rowLoc.includes("dammam") ||
      rowLoc.includes("khobar") ||
      rowWeb.includes(".sa") ||
      rowLoc.includes("السعودية") ||
      rowLoc.includes("المملكة العربية السعودية")
    );
  }
  if (targetLower.includes("emirates") || targetLower.includes("uae")) {
    return (
      rowLoc.includes("emirates") ||
      rowLoc.includes("uae") ||
      rowLoc.includes("dubai") ||
      rowLoc.includes("abu dhabi") ||
      rowLoc.includes("sharjah") ||
      rowWeb.includes(".ae") ||
      rowLoc.includes("الإمارات") ||
      rowLoc.includes("الامارات") ||
      rowLoc.includes("دبي")
    );
  }
  if (targetLower.includes("germany")) {
    return (
      rowLoc.includes("germany") ||
      rowLoc.includes("deutschland") ||
      rowLoc.includes("berlin") ||
      rowLoc.includes("munich") ||
      rowLoc.includes("münchen") ||
      rowLoc.includes("essen") ||
      rowLoc.includes("frankfurt") ||
      rowLoc.includes("hamburg") ||
      rowWeb.includes(".de") ||
      rowLoc.includes("ألمانيا")
    );
  }
  if (targetLower.includes("egypt")) {
    return (
      rowLoc.includes("egypt") ||
      rowLoc.includes("cairo") ||
      rowLoc.includes("giza") ||
      rowLoc.includes("alexandria") ||
      rowWeb.includes(".eg") ||
      rowLoc.includes("مصر") ||
      rowLoc.includes("القاهرة") ||
      rowLoc.includes("الجيزة")
    );
  }
  if (targetLower.includes("austria")) {
    return (
      rowLoc.includes("austria") ||
      rowLoc.includes("österreich") ||
      rowLoc.includes("vienna") ||
      rowLoc.includes("wien") ||
      rowWeb.includes(".at") ||
      rowLoc.includes("النمسا")
    );
  }

  return rowLoc.includes(targetLower) || rowDesc.includes(targetLower);
}

export function isCompanyRowMatchingConstraints(
  row: Record<string, any>,
  expectedCountry?: string | null,
  expectedIndustryAr?: string | null
): boolean {
  if (expectedCountry && !isCompanyRowMatchingLocation(row, expectedCountry)) {
    return false;
  }

  if (expectedIndustryAr) {
    const rowInd = String(row.industry || "").toLowerCase();
    const rowDesc = String(row.description || "").toLowerCase();
    const rowName = String(row.company_name || row.name || "").toLowerCase();
    const rowText = `${rowInd} ${rowDesc} ${rowName}`;

    if (expectedIndustryAr.includes("صواريخ") || expectedIndustryAr.includes("فضاء")) {
      const match =
        rowText.includes("aerospace") ||
        rowText.includes("rocket") ||
        rowText.includes("space") ||
        rowText.includes("defense") ||
        rowText.includes("aviation") ||
        rowText.includes("machinery") ||
        rowText.includes("precision") ||
        rowText.includes("coating");
      if (!match) return false;
    } else if (expectedIndustryAr.includes("مقاولات") || expectedIndustryAr.includes("تشييد") || expectedIndustryAr.includes("بناء")) {
      const match =
        rowText.includes("construction") ||
        rowText.includes("contract") ||
        rowText.includes("contracting") ||
        rowText.includes("building") ||
        rowText.includes("civil engineering") ||
        rowText.includes("infrastructure") ||
        rowText.includes("architecture") ||
        rowText.includes("مقاولات") ||
        rowText.includes("بناء") ||
        rowText.includes("تشييد") ||
        rowText.includes("خرسانة");
      const isPureUnrelated =
        rowInd.includes("real estate") && !rowText.includes("contract") && !rowText.includes("construction");
      if (!match || isPureUnrelated) return false;
    } else if (expectedIndustryAr.includes("طاقة شمسية") || expectedIndustryAr.includes("شمسية")) {
      const match =
        rowText.includes("solar") ||
        rowText.includes("renewable") ||
        rowText.includes("photovoltaic") ||
        rowText.includes("energy") ||
        rowText.includes("طاقة شمسية");
      if (!match) return false;
    } else if (expectedIndustryAr.includes("أغذية") || expectedIndustryAr.includes("طعام")) {
      const match =
        rowText.includes("food") ||
        rowText.includes("beverage") ||
        rowText.includes("restaurant") ||
        rowText.includes("catering") ||
        rowText.includes("nutrition") ||
        rowText.includes("أغذية") ||
        rowText.includes("طعام");
      if (!match) return false;
    } else if (expectedIndustryAr.includes("تقنية") || expectedIndustryAr.includes("برمجيات")) {
      const match =
        rowText.includes("software") ||
        rowText.includes("technology") ||
        rowText.includes("it services") ||
        rowText.includes("information") ||
        rowText.includes("media") ||
        rowText.includes("tech") ||
        rowText.includes("برمجيات") ||
        rowText.includes("تقنية");
      if (!match) return false;
    }
  }

  return true;
}

/**
 * Extracts interpreted parameters (country, industry, volume) for customer display.
 * When no country or industry is specified, marks it as required instead of
 * inserting a geographic or industry default into the customer-facing plan.
 */
export function extractInterpretedParameters(
  params: Record<string, any> | undefined | null,
  summaryAr?: string,
  isPeopleSearch = false
): { countryAr: string; countryCanonical: string; industryAr: string; isDefaultCountry: boolean } {
  const query = params?.query && typeof params.query === "object" ? params.query : {};
  const firstIncluded = (value: any): string | undefined =>
    typeof value === "string"
      ? value
      : Array.isArray(value?.include) && typeof value.include[0] === "string"
        ? value.include[0]
        : undefined;
  const queryCountry = firstIncluded(query.location) || firstIncluded(query.country);
  // Explicit industry fields must win over free-text keywords left over from
  // the original plan after an edit.
  const queryIndustry = isPeopleSearch
    ? ""
    : params?.industry || firstIncluded(query.keyword) || firstIncluded(query.industry);
  const explicitIndustry = (typeof params?.industry === "string" && params.industry.trim())
    ? detectIndustryFromText(params.industry)
    : null;
  const fullText = [
    params?.industry,
    params?.search,
    typeof params?.query === "string" ? params?.query : (params?.query ? JSON.stringify(params.query) : ""),
    params?.keyword,
    params?.topic,
    params?.location,
    params?.country,
    queryCountry,
    queryIndustry,
  ]
    .filter((v) => typeof v === "string" && v.trim().length > 0)
    .join(" ");

  const explicitCountry =
    detectCountryValue(queryCountry) ||
    detectCountryValue(params?.country) ||
    detectCountryValue(params?.region) ||
    detectCountryValue(params?.location) ||
    detectCountryFromText(fullText);

  const industry = isPeopleSearch
    ? { arabicLabel: "صناع القرار والمهنيون", canonicalEnglish: "", englishKeywords: [] }
    : explicitIndustry || detectIndustryFromText(queryIndustry || fullText);

  if (explicitCountry) {
    return {
      countryAr: explicitCountry.arabicLabel,
      countryCanonical: explicitCountry.canonicalEnglish,
      industryAr: industry.arabicLabel,
      isDefaultCountry: false,
    };
  }

  return {
    countryAr: COUNTRY_REQUIRED_AR,
    countryCanonical: "",
    industryAr: industry.arabicLabel,
    isDefaultCountry: true,
  };
}

/** Return the required company-search fields the user has not supplied. */
export type CompanyResearchRequirement = "country" | "industry" | "outreach_details";

export function getMissingCompanyResearchRequirements(text: string): CompanyResearchRequirement[] {
  const country = detectCountryFromText(text || "");
  let industryText = (text || "").toLowerCase();
  if (country) {
    industryText = industryText
      .replace(new RegExp(country.canonicalEnglish.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ")
      .replace(new RegExp(country.arabicLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  }
  industryText = industryText
    // Quantities often arrive in Arabic-Indic digits or Arabic words. Leaving
    // them in the residual text can make "١٠٠ شركة" look like an industry.
    .replace(/[0-9٠-٩۰-۹]+/g, " ")
    .replace(/(?<![\p{L}\p{N}])(?:واحد|واحدة|واحده|اتنين|اثنين|اثنان|تلاتة|تلاته|ثلاثة|ثلاثه|ثلاث|أربعة|اربعة|أربعه|اربعه|خمسة|خمسه|خمس|ستة|سته|سبعة|سبعه|ثمانية|تمانية|تسعة|تسعه|عشرة|عشر|حداشر|اتناشر|تلتاشر|اربعتاشر|خمستاشر|ستاشر|سبعتاشر|تمنتاشر|تسعتاشر|عشرين|عشرون|تلاتين|ثلاثين|أربعين|اربعين|خمسين|ستين|سبعين|تمانين|ثمانين|تسعين|مية|ميه|مائة|مئة|ميتين|ألفين|الفين|ألف|الف|مليون|مليونين)(?![\p{L}\p{N}])/giu, " ")
    .replace(/للتواصل التجاري|التواصل التجاري|تواصل تجاري|للتواصل|التواصل|تواصل|التجاري|تجاري|commercial outreach|business development|outreach|commercial/gi, " ")
    .replace(/عايز|اريد|أريد|قائمة|تضم|شركات|شركة|مؤسسات|مؤسسة|بيانات|سجلات|سجل|قطاع|نشاط|بحث|ابحث|عن|في|من|مطلوب|القطاع|الشركات/gi, " ")
    .replace(/\b(?:companies|company|business|find|need|want|search|for|in|of|the|up|to|records?|list)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const industry = detectIndustryFromText(industryText);
  const asksForGenericOutreach = /التواصل|تواصل|outreach|business development|commercial/i.test(text || "");
  const givesOutreachDetails = /إجابة هدف التواصل:\s*\S+|شركة محددة بهذا الاسم|اسم الشركة|اسم الشركات|موقع الشركة|الموقع الإلكتروني|website|بريد العمل|البريد المهني|work email|business email|الهاتف|رقم الهاتف|linkedin|لينكد.?إن|مورد|موردون|مشتري|شراكة|شركاء|توريد|مبيعات|بيع|شراء|عملاء محتملون|بحث سوقي|supplier|buyer|partnership|sales lead|market research/i.test(text || "");
  // Unknown residue (for example, an organization name plus a sales purpose)
  // is not an industry. Accept a custom industry only when it is supplied as
  // the answer to the industry field or explicitly introduced as a sector.
  // The answer is read wherever it sits in the text (the card answers are joined with a space as well as with « | »; before this it was only
  // found at the start or after « | », so every sector outside the known taxonomy was asked for again, for ever). The chip «أخرى» alone is no answer.
  // An answer that names no sector («مش عارف») is not one: the sector is asked for again.
  const industryAnswer = industryAnswerFromText(text || "");
  const hasExplicitIndustryAnswer = industryAnswer !== null && detectIndustryFromText(industryAnswer).arabicLabel !== INDUSTRY_REQUIRED_AR;
  const hasExplicitIndustryPhrase = /(?:في\s+(?:مجال|قطاع|نشاط)|\b(?:industry|sector)\s*:)\s*[\p{L}\p{N}]/iu.test(text || "");
  const hasRecognizedIndustry = Boolean(industry.exactTaxonomy?.length) || industry.arabicLabel === "صيد الحيتان";
  return [
    ...(!country ? ["country" as const] : []),
    ...(!hasExplicitIndustryAnswer && !hasExplicitIndustryPhrase && !hasRecognizedIndustry
      ? ["industry" as const]
      : []),
    ...(asksForGenericOutreach && !givesOutreachDetails ? ["outreach_details" as const] : []),
  ];
}

/** Ask for the unresolved company-search scope in one natural turn. */
export function getCompanyRequirementQuestions(missing: CompanyResearchRequirement[]): string[] {
  const questions: string[] = [];
  if (missing.includes("country")) questions.push("ما الدولة التي تريد البحث عن الشركات فيها؟");
  if (missing.includes("industry")) questions.push("ما القطاع أو المجال الذي تعمل فيه الشركات المطلوبة؟");
  if (missing.includes("outreach_details")) {
    questions.push("ما المقصود بالتواصل التجاري تحديداً، وما بيانات الشركات التي تحتاجها؟");
  }
  return questions;
}

/** Pull out a likely named organization when a request mixes a company name
 * with an unclear verb such as "include/add". This is a cue to ask what the
 * user means; it is never treated as a verified company or industry. */
export function getAmbiguousCompanyReference(text: string): string | null {
  const match = (text || "").match(
    /(?<![\p{L}\p{N}])(?:شركة|مؤسسة)(?![\p{L}\p{N}])\s+([\p{L}\p{N}][\p{L}\p{N}\s&'’.-]{1,48}?)(?=\s+(?:في|ضمن|للتواصل|وتضم|مع|أو|إلى|للقائمة)|[،.!؟]|$)/iu,
  );
  const candidate = match?.[1]?.replace(/\s+/g, " ").trim();
  if (!candidate) return null;
  if (/[0-9٠-٩]/u.test(candidate) || /(?:أريد|اريد|أضم|اضم|أضيف|اضيف|قائمة|تضم|شركة|شركات|مؤسسة|مؤسسات|ابحث|بحث|حتى|سجل)/iu.test(candidate)) return null;
  // The loose phrase matcher can otherwise backtrack and treat a location or
  // relative clause ("شركة في ألمانيا تعمل...") as the supposed company name.
  // Only ask the named-company disambiguation when the candidate starts like
  // an actual name, not a preposition or ordinary sentence continuation.
  if (/^(?:في|ضمن|من|إلى|الى|على|ب|تعمل|يعمل|تقدم|يقدم|تضم|يشمل|تعمل\s+في|تعمل\s+ضمن|in|within|from|to|for|that|which|operating|based)(?:\s|$)/iu.test(candidate)) return null;
  if (/^(?:للتواصل|للتعامل|للتسويق|للبيع|للشراء|للاستيراد|للتصدير)(?:\s|$)/iu.test(candidate)) return null;
  if (/^(?:تقنية|تكنولوجيا|أغذية|مطاعم|تصنيع|مقاولات|برمجيات|شركات|مؤسسات)$/iu.test(candidate)) return null;
  return candidate;
}

/**
 * The sector chips of the company question: the common sectors, each one a phrase the sector rules read back as that sector (so tapping one
 * always produces a plan). «أخرى» is added last and opens the custom-answer field.
 */
export const COMPANY_SECTOR_CHIPS = ["تقنية وبرمجيات", "اتصالات", "التقنية المالية", "بنوك وتأمين", "تصنيع", "مقاولات وعقارات", "كهرباء وطاقة", "أغذية ومطاعم", "صحة وأدوية", "تجارة وتجزئة", "نقل وشحن"];
const COMPANY_SECTOR_CHIPS_OUTREACH = ["تقنية وبرمجيات", "اتصالات", "التقنية المالية", "بنوك وتأمين", "كهرباء وطاقة", "أغذية ومطاعم", "صحة وأدوية", "تجارة وتجزئة", "نقل وشحن"];

/** Compact, adaptive answer chips for the company-search details UI. The final
 * chip always opens the custom-answer field, so suggestions never constrain
 * what the customer can ask for. */
export function getCompanyRequirementItems(
  missing: CompanyResearchRequirement[],
  requestText = "",
): Array<{ id: string; text: string; question: string; type: "single" | "free"; options: string[]; allowOther: true }> {
  const items: Array<{ id: string; text: string; question: string; type: "single" | "free"; options: string[]; allowOther: true }> = [];
  const hasResolvedAsCompanyList = /قائمة\s+(?:من\s+)?شركات?\s+للتواصل\s+التجاري|قائمة\s+الشركات\s+للتواصل\s+التجاري|\b(?:company list|list of companies)\b/i.test(requestText);
  const ambiguousNamedEntity = hasResolvedAsCompanyList ? null : getAmbiguousCompanyReference(requestText);
  if (ambiguousNamedEntity && missing.includes("outreach_details")) {
    const text = `هل تقصد شركة محددة باسم «${ambiguousNamedEntity.slice(0, 36)}» أم قائمة شركات للتواصل التجاري؟`;
    items.push({
      id: "company_outreach_required",
      text,
      question: text,
      type: "single",
      options: ["شركة محددة بهذا الاسم", "قائمة شركات للتواصل التجاري", "أخرى"],
      allowOther: true,
    });
  }
  if (missing.includes("country")) {
    const text = "ما الدولة التي تريد البحث عن الشركات فيها؟";
    items.push({ id: "company_country_required", text, question: text, type: "single", options: ["مصر", "السعودية", "الإمارات", "أخرى"], allowOther: true });
  }
  if (missing.includes("industry")) {
    const text = ambiguousNamedEntity
      ? `ما القطاع أو مجال «${ambiguousNamedEntity.slice(0, 36)}»، أو ما المجال المطلوب للشركات التي تبحث عنها؟`
      : "ما القطاع أو المجال الذي تعمل فيه الشركات المطلوبة؟";
    if (industryAnsweredWithOtherChipOnly(requestText)) {
      // «أخرى» was chosen but nothing was written: ask once, in the customer's own words, with no chips to loop on.
      const freeText = "اكتب القطاع الذي تريده بكلماتك، مثل: الاتصالات أو التأمين أو الطباعة.";
      items.push({ id: "company_industry_required", text: freeText, question: freeText, type: "free", options: [], allowOther: true });
    } else {
      const lower = requestText.toLowerCase();
      const options = /تواصل|outreach|تجاري|business/i.test(lower)
        ? [...COMPANY_SECTOR_CHIPS_OUTREACH, "أخرى"]
        : [...COMPANY_SECTOR_CHIPS, "أخرى"];
      items.push({ id: "company_industry_required", text, question: text, type: "single", options, allowOther: true });
    }
  }
  if (missing.includes("outreach_details") && !ambiguousNamedEntity) {
    const text = "ما المقصود بالتواصل التجاري تحديداً، وما بيانات الشركات التي تحتاجها؟";
    const options = ["عملاء محتملون / مبيعات", "موردون أو شركاء", "بحث سوقي", "أخرى"];
    items.push({ id: "company_outreach_required", text, question: text, type: "single", options, allowOther: true });
  }
  return items;
}

/**
 * Decision-maker roles in a request: a specific title (CEO, مدير, مؤسس ...) or the generic phrase
 * itself (صناع القرار, decision makers, executives), which already names who is wanted.
 */
export const PEOPLE_ROLE_PATTERN = /\b(?:ceos?|ctos?|cfos?|coos?|founders?|co-?founders?|owners?|directors?|managers?|presidents?|heads? of|vps?|executives?|decision[\s-]*makers?|c-?level)\b|الرئيس التنفيذي|الرؤساء التنفيذيين|مدير(?:ين)?|مدراء|مؤسس(?:ين)?|(?<![\p{L}])[وبلفك]?(?:ال)?مالك(?:ي|ين)?(?![\p{L}])|أصحاب الشركات|رئيس مجلس الإدارة|مسؤول(?:ين)?|صناع\s+(?:ال)?قرار|صانعي\s+(?:ال)?قرار|أصحاب القرار|المديرين التنفيذيين|مسؤولين تنفيذيين/iu;

export function isPeopleSearchRequest(text: string): boolean {
  // «شركات حجمها أكثر من ٥٠ موظف» is a company filter, not a request for employees.
  const normalized = stripConstraintPhrases(text || "").toLowerCase();
  const explicitPeopleIntent = PEOPLE_ROLE_PATTERN.test(normalized) || /decision[\s-]*makers?|executives?|people search|\bpeople\b|job titles?|contacts?\b|employees?|individuals?|صناع\s+(?:ال)?قرار|صانعي\s+(?:ال)?قرار|صناع الأعمال|المديرين التنفيذيين|مسؤولين تنفيذيين|المسمى الوظيفي|جهات الاتصال|بيانات الأشخاص|أشخاص|شخص|موظفين|موظف/.test(normalized);
  if (explicitPeopleIntent) return true;

  // A work email can be a company field. Do not reinterpret an explicit
  // company list as a people search solely because it asks for business email.
  const explicitCompanyIntent = /\bcompanies?\b|\bbusinesses\b|شركة|شركات|مؤسسة|مؤسسات|مصنع|مصانع/.test(normalized);
  if (explicitCompanyIntent) return false;

  return /work emails?|professional emails?|بريد العمل|البريد المهني/.test(normalized);
}

/** Contact fields a people-search delivery must include when the request names them. */
export function requiredProfessionalContactFields(text: string): string[] {
  const normalized = (text || "").toLowerCase();
  const fields: string[] = [];
  if (/\b(?:work|professional|business)?\s*e-?mails?\b|\bemail\b|البريد(?: الإلكتروني| الالكتروني| المهني)?|إيميلات|ايميلات|إيميل|ايميل/.test(normalized)) {
    fields.push("work_email");
  }
  if (/\b(?:phone|telephone|mobile)(?:\s+numbers?)?\b|رقم(?: الهاتف| التليفون| الموبايل)|الهاتف|التليفون|الموبايل|\b(?:rkm|rakm|raqm|rkmo|raqmo)\b/.test(normalized)) {
    fields.push("phone");
  }
  if (fields.length > 0) return fields;
  return isPeopleSearchRequest(normalized) ? ["work_email", "phone"] : [];
}

/**
 * Extracts a human-readable display string from capability/plan parameters.
 */
export function extractParamDisplayString(
  params: Record<string, any> | undefined | null,
  summaryAr?: string,
  isPeopleSearch = false
): string {
  if (!params || typeof params !== "object") return "";
  // Provider query keywords may contain the customer's full natural-language prompt.
  // Never echo that raw English prompt into a customer-facing people-search card.
  if (isPeopleSearch) return "صناع القرار والمهنيون";

  const candidates: string[] = [];

  if (typeof params.search === "string" && params.search.trim()) candidates.push(params.search.trim());
  if (typeof params.username === "string" && params.username.trim()) candidates.push(params.username.trim());
  if (typeof params.keyword === "string" && params.keyword.trim()) candidates.push(params.keyword.trim());
  if (typeof params.topic === "string" && params.topic.trim()) candidates.push(params.topic.trim());
  if (typeof params.url === "string" && params.url.trim()) candidates.push(params.url.trim());
  if (typeof params.postUrl === "string" && params.postUrl.trim()) candidates.push(params.postUrl.trim());

  if (typeof params.query === "string" && params.query.trim()) candidates.push(params.query.trim());
  if (params.query && typeof params.query === "object") {
    if (
      Array.isArray(params.query.keyword?.include) &&
      typeof params.query.keyword.include[0] === "string" &&
      params.query.keyword.include[0].trim()
    ) {
      candidates.push(params.query.keyword.include[0].trim());
    }
    if (typeof params.query.keyword === "string" && params.query.keyword.trim()) {
      candidates.push(params.query.keyword.trim());
    }
    if (typeof params.query.search === "string" && params.query.search.trim()) {
      candidates.push(params.query.search.trim());
    }
  }

  if (params.topic && typeof params.topic === "object") {
    if (typeof params.topic.topic === "string" && params.topic.topic.trim()) {
      candidates.push(params.topic.topic.trim());
    }
    if (typeof params.topic.name === "string" && params.topic.name.trim()) {
      candidates.push(params.topic.name.trim());
    }
  }

  for (const [key, val] of Object.entries(params)) {
    if (typeof val === "string" && val.trim() && key !== "dateFrom" && key !== "dateTo" && key !== "pagination") {
      candidates.push(val.trim());
    }
  }

  for (const cand of candidates) {
    if (!isGreeting(cand)) {
      return cand;
    }
  }

  if (summaryAr && typeof summaryAr === "string") {
    const match = summaryAr.match(/(?:عن|لـ|في|حول|بشأن)\s+([^\n.]+)/);
    if (match?.[1] && match[1].trim() && !isGreeting(match[1])) {
      return match[1].trim();
    }
  }

  return candidates.find((c) => Boolean(c.trim())) || "";
}
