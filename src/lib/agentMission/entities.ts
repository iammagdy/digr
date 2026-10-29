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

const FILLER = new Set(["عايز", "عاوز", "عايزه", "اريد", "ابغي", "ابي", "هات", "هاتلي", "جيب", "جيبلي", "اعطني", "اعطيني", "ابحث", "دور", "لي", "ليا", "لى", "عن", "في", "من", "الى", "على", "علي", "مع", "كل", "كلها", "بس", "فقط", "او", "ثم", "كمان", "ممكن", "لو", "سمحت", "بالله", "عليها", "بتاعت", "بتاعة", "متخصصه", "متخصصة", "تعمل", "تشتغل", "شغاله", "شغالة", "الـ", "جوه", "جوة", "داخل", "وجوه", "وداخل", "ومع", "وكل", "لكل", "بتوع", "اللي", "الي", "التي", "التى", "التابعه", "التابعة", "اسماء", "أسماء", "اسم", "قائمة", "قايمة", "لستة", "ليستة", "عدد", "رقم", "بيانات", "معلومات", "تفاصيل"]);
const NOUN_WORDS = /^(?:ال)?(?:شرك|مطع|اماكن|مكان|اشخاص|شخص|حساب|صفح|موظف|عامل|مدير|ايميل|اميل|بريد|موبايل|تليفون|هاتف|رقم|واتس|تعليق|ردود|مراجع|تقييم|فيديو|بوست|منشور|تغريد)/;

/** The words of the request that name a SECTOR or a topic (what kind of company, restaurant, place), after taking out the numbers, the noun of the entity, the places, the contact words and the filler. Empty: the request names none. */
export function sectorWordsOf(request: unknown): string[] {
  // the sector is named in the FIRST clause of the request: what follows a per-parent clause («، ومن كل شركة اتنين من المديرين») is another step, never part of the sector
  const clause = String(request ?? "").split(/[،,]?\s+(?:و|ول)?(?:من|مع|عن)?\s*(?:كل|لكل)\s/)[0];
  const places = placesInText(clause).flatMap((p) => p.names.flatMap((n) => normalizeText(n).split(" ")));
  const placeWords = new Set(places);
  return normalizeText(clause.replace(/[0-9٠-٩]+/g, " ").replace(/[^\p{L}\s]/gu, " "))
    .split(/\s+/)
    .filter((w) => !FILLER.has(w.replace(/^و(?=.{2,})/, "")) && !isNumberWord(w) && !isNumberWord(w.replace(/^و(?=.{2,})/, "")))
    .map((w) => w.replace(/^(?:و|ب|ل|ف)(?=.{4,})/, ""))
    .filter((w) => [...w].length >= 3 && !FILLER.has(w) && !NOUN_WORDS.test(w) && !placeWords.has(w.replace(/^ال/, "")) && !placeWords.has(w));
}

/**
 * THE SECTOR IN THE LANGUAGE THE SOURCE WRITES NAMES IN. A company source names its companies in Latin letters («Orascom Construction», «The Arab Contractors»): the Arabic sector word of the request («مقاولات») never appears in them, so without these every company would
 * wait for the model check. A small table of common sectors: the Arabic stem and the English words a company of that sector carries in its name.
 */
const SECTOR_ENGLISH: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
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
