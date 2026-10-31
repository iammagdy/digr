import { itemNounOf } from "./itemNoun";
import { placesInText } from "./places";
import { isNumberWord } from "./quantity";
import { normalizeText } from "./relevance";

export { NOT_A_COMPANY_WORDS } from "./relevance";

/**
 * THE STAGES THAT LIST ENTITIES (companies, restaurants, places, people, accounts) get two rules the tweets and posts do not: the place the card names is enforced from the items' own fields (places.ts), and the KIND of entity is checked
 * (an exhibition is not a contracting company; a sports company is not one either): an entity the rule cannot place in the requested sector goes to the model check, never straight to delivery. Pure: no I/O.
 */
const ENTITY_NOUN_KEYS = new Set(["شركه", "مطعم", "مكان", "شخص", "حساب", "صفحه"].map((n) => normalizeText(n)));

/** True when a stage's items are entities (judged from the noun of its title). */
export const isEntityStage = (stage: { title_ar: string }): boolean => ENTITY_NOUN_KEYS.has(itemNounOf(stage.title_ar).key);
/** True when a stage lists COMPANIES (the sector check). */
export const isCompanyStage = (stage: { title_ar: string }): boolean => itemNounOf(stage.title_ar).key === normalizeText("شركة");

const FILLER = new Set(["عايز", "عاوز", "عايزه", "اريد", "ابغي", "ابي", "هات", "هاتلي", "جيب", "جيبلي", "اعطني", "اعطيني", "ابحث", "دور", "لي", "ليا", "لى", "عن", "في", "من", "الى", "على", "علي", "مع", "كل", "كلها", "بس", "فقط", "او", "ثم", "كمان", "ممكن", "لو", "سمحت", "بالله", "عليها", "بتاعت", "بتاعة", "متخصصه", "متخصصة", "تعمل", "تشتغل", "شغاله", "شغالة", "الـ", "جوه", "جوة", "داخل", "وجوه", "وداخل", "ومع", "وكل", "لكل", "بتوع", "اللي", "الي", "التي", "التى", "التابعه", "التابعة", "اسماء", "أسماء", "اسم", "قائمة", "قايمة", "لستة", "ليستة", "عدد", "رقم", "بيانات", "معلومات", "تفاصيل",
  // the frame of a request, never the sector: «sector», «field», «with them», «the decision makers», «the job title»
  "قطاع", "مجال", "معاهم", "معاهن", "معاه", "صناع", "القرار", "قرار", "المسمي", "مسمي", "الوظيفي", "وظيفي", "الوظيفه", "وظيفه"]);
/** A nationality is a PLACE, never part of the sector («شركات مصرية»): the place filter and the source's own country field carry it. Compared after normalisation. */
const NATIONALITY = /^(?:ال)?(?:مصر|سعود|امارات|كويت|قطر|بحرين|عمان|اردن|لبنان|عراق|سوري|ليب|تونس|جزائر|مغرب|سودان|فلسطين|يمن)(?:ي|يه|ين|يون|يات)$/;
const NOUN_WORDS = /^(?:ال)?(?:شرك|مطع|اماكن|مكان|اشخاص|شخص|حساب|صفح|موظف|عامل|مدير|ايميل|اميل|بريد|موبايل|تليفون|هاتف|رقم|واتس|تعليق|ردود|مراجع|تقييم|فيديو|بوست|منشور|تغريد)/;

/** The words of the request that name a SECTOR or a topic (what kind of company, restaurant, place), after taking out the numbers, the noun of the entity, the places, the contact words and the filler. Empty: the request names none. */
export function sectorWordsOf(request: unknown): string[] {
  // the sector is named in the FIRST clause of the request: what follows a per-parent clause («، ومن كل شركة اتنين من المديرين») is another step, never part of the sector
  // and the people of the companies are named AFTER «ومعاهم» («ومعاهم صناع القرار: اسم المدير…»): that is the next step, never the sector
  const clause = String(request ?? "").split(/[،,]?\s+(?:و|ول)?(?:من|مع|عن)?\s*(?:كل|لكل)\s/)[0].split(/\sو?معاه\S*/)[0];
  const places = placesInText(clause).flatMap((p) => p.names.flatMap((n) => normalizeText(n).split(" ")));
  const placeWords = new Set(places);
  return normalizeText(clause.replace(/[0-9٠-٩]+/g, " ").replace(/[^\p{L}\s]/gu, " "))
    .split(/\s+/)
    .filter((w) => !FILLER.has(w.replace(/^و(?=.{2,})/, "")) && !isNumberWord(w) && !isNumberWord(w.replace(/^و(?=.{2,})/, "")))
    .map((w) => w.replace(/^(?:و|ب|ل|ف)(?=.{4,})/, ""))
    .filter((w) => [...w].length >= 3 && !FILLER.has(w) && !NATIONALITY.test(w) && !NOUN_WORDS.test(w) && !placeWords.has(w.replace(/^ال/, "")) && !placeWords.has(w));
}

/**
 * THE SECTOR IN THE LANGUAGE THE SOURCE WRITES NAMES IN. A company source names its companies in Latin letters («Orascom Construction», «The Arab Contractors»): the Arabic sector word of the request («مقاولات») never appears in them, so without these every company would
 * wait for the model check. A small table of common sectors: the Arabic stem and the English words a company of that sector carries in its name.
 */
const SECTOR_ENGLISH: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  // electromechanical works: the compound forms only (a bare «mechanical» or «electrical» is another trade); a company source writes them in English
  ["كهروميكانيك", ["electromechanical", "electro-mechanical", "mechanical and electrical", "mechanical & electrical", "electrical and mechanical", "electrical & mechanical"]],
  ["كهرومكانيك", ["electromechanical", "electro-mechanical", "mechanical and electrical", "mechanical & electrical"]],
  ["ميكانيك", ["mechanical", "mechanics"]],
  ["هندس", ["engineering", "engineers", "consultants"]],
  ["كيماو", ["chemical", "chemicals", "petrochemical", "petrochemicals"]],
  ["نسيج", ["textile", "textiles", "fabrics", "spinning"]],
  ["ملابس", ["garments", "apparel", "clothing", "fashion"]],
  ["سيار", ["automotive", "motors", "cars", "auto"]],
  ["اتصالات", ["telecom", "telecommunications", "networks"]],
  ["زراع", ["agriculture", "agri", "agro", "farms"]],
  ["ميا", ["water", "desalination", "pumps"]],
  ["تعبئ", ["packaging", "packing"]],
  ["تصنيع", ["manufacturing", "industries", "industrial"]],
  ["مصاعد", ["elevators", "lifts", "elevator"]],
  ["مضخ", ["pumps", "pumping"]],
  ["كابل", ["cables", "cable", "wires"]],
  ["مولد", ["generators", "generator", "power systems"]],
  ["مقاول", ["construction", "contracting", "contractors", "contractor", "builders", "engineering"]],
  ["بناء", ["construction", "building", "builders"]],
  ["عقار", ["real estate", "properties", "property", "developments", "development", "realty"]],
  ["تطوير", ["development", "developments", "developers"]],
  ["ادوي", ["pharma", "pharmaceuticals", "pharmaceutical", "medicine"]],
  ["صيدل", ["pharma", "pharmacy", "pharmaceuticals"]],
  ["برمج", ["software", "technologies", "technology", "systems", "tech"]],
  ["تكنولوج", ["technology", "technologies", "tech"]],
  ["سياح", ["tours", "travel", "tourism"]],
  ["سفر", ["travel", "tours"]],
  ["اغذي", ["foods", "food"]],
  ["غذائ", ["foods", "food"]],
  ["نقل", ["transport", "logistics", "shipping"]],
  ["شحن", ["shipping", "logistics", "freight"]],
  ["تعليم", ["education", "academy", "school", "training"]],
  ["تسويق", ["marketing", "media", "advertising", "digital"]],
  ["اعلان", ["advertising", "marketing", "media"]],
  ["بنك", ["bank", "banking"]],
  ["تامين", ["insurance"]],
  ["طاقه", ["energy", "power", "solar"]],
  ["بترول", ["petroleum", "oil", "gas", "energy"]],
  ["كهرباء", ["electric", "electrical", "power"]],
  ["حديد", ["steel", "iron", "metals"]],
  ["اسمنت", ["cement"]],
  ["اثاث", ["furniture"]],
  ["مستشف", ["hospital", "healthcare", "medical"]],
  ["طبي", ["medical", "healthcare", "clinic"]],
];

/** The English words a company of the Arabic sector word carries in its name (none for a word the table does not know). */
export function sectorEnglishWords(arabicWord: string): string[] {
  const w = normalizeText(arabicWord).replace(/^ال/, "");
  return [...new Set(SECTOR_ENGLISH.filter(([stem]) => w.startsWith(stem)).flatMap(([, words]) => words))];
}

/** The request names a sector or a topic for its entities («شركات مقاولات»), not only the entity and a place. */
export const requestNamesSector = (request: unknown): boolean => sectorWordsOf(request).length > 0;


/** The spellings of an Arabic sector word the rule should also know: «كهروميكانيكا» also as the adjective «كهروميكانيكية»; a plural «ات» also as the singular «ة». */
function arabicVariants(word: string): string[] {
  const w = normalizeText(word).replace(/^ال/, "");
  const out = [w];
  if (/ا$/.test(w) && w.length >= 5) out.push(`${w.slice(0, -1)}يه`);
  if (/ات$/.test(w)) out.push(w.replace(/ات$/, "ه"));
  return out;
}
const MAX_COMPANY_RULE_TERMS = 12;
/**
 * THE TERMS OF A COMPANY STAGE'S RULE, built by code from the request's sector in Arabic AND English (live, 2026-10-31: the rule held a nationality, «قطاع» and «معاهم» and no English word, while the source names its companies in English, so every row
 * waited for the model). The model's own terms stay (its spellings of the sector), minus the request's frame words (a nationality is a place, «sector», «with them», the people clause); the sector words of the request are added with their Arabic
 * variants and the English words a company of that sector carries in its name. Never more than the rule allows; the model's terms are returned unchanged when nothing could be built from them.
 */
export function companyRuleTerms(modelTerms: readonly string[], request: unknown): string[] {
  const key = (t: string) => normalizeText(t).replace(/^ال(?=.{3,})/, "");
  const isFrame = (t: string): boolean => {
    if (/\s/.test(t.trim())) return false;
    const w = normalizeText(t).replace(/^و(?=.{2,})/, "");
    return FILLER.has(w) || NATIONALITY.test(w) || NOUN_WORDS.test(w);
  };
  const kept = modelTerms.filter((t) => !isFrame(t));
  const sector = sectorWordsOf(request).map((w) => w.replace(/^ال(?=.{3,})/, ""));
  const arabic = sector.flatMap(arabicVariants);
  const english = [...sector, ...kept].flatMap(sectorEnglishWords);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...kept.slice(0, 5), ...arabic, ...english, ...kept.slice(5)]) {
    const k = key(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.length > 0 ? out.slice(0, MAX_COMPANY_RULE_TERMS) : [...modelTerms];
}
