import { itemNounOf } from "./itemNoun";
import { placesInText } from "./places";
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
  const places = placesInText(request).flatMap((p) => p.names.flatMap((n) => normalizeText(n).split(" ")));
  const placeWords = new Set(places);
  return normalizeText(String(request ?? "").replace(/[0-9٠-٩]+/g, " ").replace(/[^\p{L}\s]/gu, " "))
    .split(/\s+/)
    .map((w) => w.replace(/^(?:و|ب|ل|ف)(?=.{4,})/, ""))
    .filter((w) => [...w].length >= 3 && !FILLER.has(w) && !NOUN_WORDS.test(w) && !placeWords.has(w.replace(/^ال/, "")) && !placeWords.has(w));
}

/** The request names a sector or a topic for its entities («شركات مقاولات»), not only the entity and a place. */
export const requestNamesSector = (request: unknown): boolean => sectorWordsOf(request).length > 0;
