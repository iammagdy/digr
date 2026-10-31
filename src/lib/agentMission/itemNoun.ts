import { formatAr } from "../arabicDigits";
import { normalizeText } from "./relevance";

/**
 * THE NOUN OF THE ITEMS OF A MISSION, in correct Arabic, for every customer text (the card, the panel, the notification, the e-mail, the file name, the summary sheet): «٣٠٠ تغريدة»، «تغريدة واحدة»، «تغريدتان»، «٥ تغريدات».
 * One table of nouns (singular, dual, plural, the form after eleven and more, the gender) and one counting function, so no text counts a thing in the wrong form or calls it «صف» or «سجل». The noun is read from the title of the
 * delivered stage (the agent already names it in everyday Arabic: «التغريدات»، «تعليقات كل منشور»); a noun the table does not know is called «عنصر».
 */
export interface ItemNoun {
  key: string;
  singular: string;
  /** The dual as a subject («تغريدتان») and after a preposition or a number («تغريدتين»). */
  dual: string;
  dualGen: string;
  plural: string;
  /** After eleven and more («١١ تغريدة»، «١١ منشورًا»). */
  tamyiz: string;
  feminine: boolean;
  /** Other spellings of the same noun that may open a stage title («موظفو»، «موظفون»). */
  aliases?: string[];
}

const N = (singular: string, dual: string, dualGen: string, plural: string, tamyiz: string, feminine: boolean, aliases: string[] = []): ItemNoun => ({ key: normalizeText(singular), singular, dual, dualGen, plural, tamyiz, feminine, aliases });

export const ITEM_NOUNS: ReadonlyArray<ItemNoun> = [
  N("تغريدة", "تغريدتان", "تغريدتين", "تغريدات", "تغريدة", true),
  N("منشور", "منشوران", "منشورين", "منشورات", "منشورًا", false),
  // the word customers write for a post («٥ بوستات»): without it a title that starts with it was counted by the next known noun, the page the posts come from
  N("بوست", "بوستان", "بوستين", "بوستات", "بوست", false),
  N("تعليق", "تعليقان", "تعليقين", "تعليقات", "تعليقًا", false),
  N("فيديو", "فيديوهان", "فيديوهين", "فيديوهات", "فيديو", false, ["مقاطع", "مقطع"]),
  N("شركة", "شركتان", "شركتين", "شركات", "شركة", true),
  N("موظف", "موظفان", "موظفين", "موظفين", "موظفًا", false, ["موظفو", "موظفون"]),
  N("تقييم", "تقييمان", "تقييمين", "تقييمات", "تقييمًا", false),
  N("مراجعة", "مراجعتان", "مراجعتين", "مراجعات", "مراجعة", true),
  N("مكان", "مكانان", "مكانين", "أماكن", "مكانًا", false),
  N("مطعم", "مطعمان", "مطعمين", "مطاعم", "مطعمًا", false),
  N("حساب", "حسابان", "حسابين", "حسابات", "حسابًا", false),
  N("صورة", "صورتان", "صورتين", "صور", "صورة", true),
  N("وظيفة", "وظيفتان", "وظيفتين", "وظائف", "وظيفة", true),
  N("منتج", "منتجان", "منتجين", "منتجات", "منتجًا", false),
  N("إعلان", "إعلانان", "إعلانين", "إعلانات", "إعلانًا", false),
  N("صفحة", "صفحتان", "صفحتين", "صفحات", "صفحة", true),
  N("قناة", "قناتان", "قناتين", "قنوات", "قناة", true),
  N("خبر", "خبران", "خبرين", "أخبار", "خبرًا", false),
  N("مقال", "مقالان", "مقالين", "مقالات", "مقالًا", false),
  N("رسالة", "رسالتان", "رسالتين", "رسائل", "رسالة", true),
  N("شخص", "شخصان", "شخصين", "أشخاص", "شخصًا", false),
  N("رد", "ردان", "ردين", "ردود", "ردًا", false),
];
export const GENERIC_ITEM_NOUN: ItemNoun = N("عنصر", "عنصران", "عنصرين", "عناصر", "عنصرًا", false);

const KNOWN = new Map<string, ItemNoun>();
for (const n of ITEM_NOUNS) for (const form of [n.singular, n.dual, n.dualGen, n.plural, n.tamyiz, ...(n.aliases ?? [])]) KNOWN.set(normalizeText(form), n);

/** A word as the table writes it: no leading definite article, no diacritics, one form of alef and ta marbuta. */
const bare = (word: string): string => normalizeText(word).replace(/^(?:لل|ال)(?=.{2,})/, "");

/** The known noun a word is a form of, or null. */
export function knownItemNoun(word: string): ItemNoun | null {
  const w = bare(word);
  return KNOWN.get(w) ?? KNOWN.get(`ال${w}`) ?? null;
}

/** Nouns that name WHERE the items come from (the page, the account, the channel), never the items themselves in a title like «بوستات صفحة طلبات مصر». */
const SOURCE_NOUN_KEYS: ReadonlySet<string> = new Set(["صفحة", "حساب", "قناة"].map((n) => normalizeText(n)));
/** Words that may stand in front of a noun without being a noun («أحدث صفحات فيسبوك», «أفضل قنوات يوتيوب»): the noun after them is still the first noun of the title. */
const LEADING_MODIFIERS: ReadonlySet<string> = new Set(["أحدث", "أفضل", "أهم", "أشهر", "أكبر", "أقدم", "أول", "آخر", "بعض", "كل", "جميع", "أكثر"].map((n) => normalizeText(n)));

/**
 * The noun of a stage title or a short phrase: its first words that name a known noun («التغريدات التي تذكر محمد صلاح» → تغريدة; «تعليقات كل منشور» → تعليق); «عنصر» when none does.
 * A noun that names the SOURCE of the items (a page, an account, a channel) is the unit only when it opens the title or follows a plain modifier: after a word the table does not know it is the source («ريلز صفحة فلان»), and the unit is then the honest «عنصر» (live: «بوستات صفحة طلبات مصر» was counted «٥ صفحات»).
 */
export function itemNounOf(text: string | null | undefined): ItemNoun {
  const words = String(text ?? "").replace(/[«»"،,.:؛]/g, " ").split(/\s+/).filter(Boolean).slice(0, 3);
  for (let i = 0; i < words.length; i += 1) {
    const n = knownItemNoun(words[i]);
    if (!n) continue;
    if (i > 0 && SOURCE_NOUN_KEYS.has(n.key) && !words.slice(0, i).every((w) => LEADING_MODIFIERS.has(normalizeText(w)))) continue;
    return n;
  }
  return GENERIC_ITEM_NOUN;
}

/** The noun of what the customer RECEIVES: the noun of the delivered stages when they all name the same thing («التغريدات»), else «عنصر» (posts together with their comments are items). */
export function itemNounOfPlan(plan: { stages?: ReadonlyArray<{ title_ar?: unknown; titleAr?: unknown; deliver?: boolean }> } | null | undefined): ItemNoun {
  const stages = Array.isArray(plan?.stages) ? plan!.stages! : [];
  const delivered = stages.filter((s) => s?.deliver !== false);
  const nouns = (delivered.length > 0 ? delivered : stages.slice(0, 1)).map((s) => itemNounOf(String(s?.title_ar ?? s?.titleAr ?? "")));
  return nouns.length > 0 && nouns.every((n) => n.key === nouns[0].key) ? nouns[0] : GENERIC_ITEM_NOUN;
}

/** «تغريدة واحدة»، «تغريدتان»، «٥ تغريدات»، «٣٠٠ تغريدة»: a count with its noun, in the right form. `subject: true` keeps the dual in the nominative («تغريدتان»); otherwise it is «تغريدتين» (after a preposition). */
export function countAr(n: number, noun: ItemNoun, options: { subject?: boolean } = {}): string {
  const c = Math.max(0, Math.floor(Number(n) || 0));
  if (c === 1) return `${noun.singular} ${noun.feminine ? "واحدة" : "واحد"}`;
  if (c === 2) return options.subject ? noun.dual : noun.dualGen;
  if (c >= 3 && c <= 10) return `${formatAr(c)} ${noun.plural}`;
  return `${formatAr(c)} ${noun.tamyiz}`;
}

/**
 * «٢٥٠ من ٣٠٠ تغريدة» — what was delivered of what was requested, one wording everywhere. Up to ten delivered the count carries its own noun («٣ تغريدات من ٣٠٠ تغريدة»); from eleven the noun is said once, after the requested count.
 */
export function deliveredOfAr(delivered: number, requested: number, noun: ItemNoun): string {
  const d = Math.max(0, Math.floor(Number(delivered) || 0));
  const r = Math.max(0, Math.floor(Number(requested) || 0));
  if (r <= 0) return countAr(d, noun);
  return d >= 1 && d <= 10 ? `${countAr(d, noun)} من ${countAr(r, noun)}` : `${formatAr(d)} من ${countAr(r, noun)}`;
}
