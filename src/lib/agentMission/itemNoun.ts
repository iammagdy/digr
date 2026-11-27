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
  // ROUND 36: the reels of Instagram («٥ ريلز»): the plural is the word itself, the stage of a request for reels is titled «الريلز»
  N("ريل", "ريلان", "ريلين", "ريلز", "ريلز", false, ["ريلز", "ريلس"]),
  N("بوست", "بوستان", "بوستين", "بوستات", "بوست", false),
  N("تعليق", "تعليقان", "تعليقين", "تعليقات", "تعليقًا", false),
  N("فيديو", "فيديوهان", "فيديوهين", "فيديوهات", "فيديو", false, ["مقاطع", "مقطع"]),
  N("شركة", "شركتان", "شركتين", "شركات", "شركة", true),
  N("مدير", "مديران", "مديرين", "مديرين", "مديرًا", false, ["مديرو", "مديرون", "مدراء"]),
  N("مسؤول", "مسؤولان", "مسؤولين", "مسؤولين", "مسؤولًا", false, ["مسئول", "مسئولين", "مسؤولو", "مسئولو"]),
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
export const CONTACT_ITEM_NOUN: ItemNoun = N("جهة تواصل", "جهتا تواصل", "جهتي تواصل", "جهات تواصل", "جهة تواصل", true);

/**
 * Coerces and validates an item noun object from catalog metadata or overlay.
 * Validates all required Arabic string fields and boolean feminine.
 * Normalizes key via normalizeText(singular). Does NOT call knownItemNoun (C2).
 * Returns null if any field is missing or contains Latin letters.
 */
export function coerceItemNoun(raw: unknown): ItemNoun | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const singular = typeof o.singular === "string" ? o.singular.trim() : "";
  const dual = typeof o.dual === "string" ? o.dual.trim() : "";
  const dualGen = typeof (o.dualGen ?? o.dual_gen) === "string" ? String(o.dualGen ?? o.dual_gen).trim() : "";
  const plural = typeof o.plural === "string" ? o.plural.trim() : "";
  const tamyiz = typeof o.tamyiz === "string" ? o.tamyiz.trim() : "";
  const feminine = o.feminine;

  if (typeof feminine !== "boolean") return null;
  if (!singular || !dual || !dualGen || !plural || !tamyiz) return null;

  const LATIN = /[a-zA-Z]/;
  if (LATIN.test(singular) || LATIN.test(dual) || LATIN.test(dualGen) || LATIN.test(plural) || LATIN.test(tamyiz)) {
    return null;
  }

  return {
    key: normalizeText(singular),
    singular,
    dual,
    dualGen,
    plural,
    tamyiz,
    feminine,
  };
}

/**
 * The item noun of a stage from its CATALOG METADATA (item_noun_ar overlay).
 * Body is strictly coerceItemNoun(itemNounAr) with zero capability/platform branching (C1).
 */
export function itemNounFromCapability(capability?: string | null, platform?: string | null, itemNounAr?: unknown): ItemNoun | null {
  return coerceItemNoun(itemNounAr);
}

/** The closed set of unit words the planning model may write for a step: the singular of every noun of the table above, plus «عنصر». The model chooses from it; code never reads the customer's words to choose. */
export const UNIT_NOUN_SINGULARS: ReadonlyArray<string> = [...ITEM_NOUNS.map((n) => n.singular), GENERIC_ITEM_NOUN.singular];

/** The table noun whose singular is EXACTLY this string (the model's answer or a stored one), or null. No fuzzy match: an answer outside the closed set is no answer. */
export function unitNounBySingular(word: unknown): ItemNoun | null {
  if (typeof word !== "string") return null;
  return [...ITEM_NOUNS, GENERIC_ITEM_NOUN].find((n) => n.singular === word) ?? null;
}

/** A noun in the stored shape of `item_noun_ar` (the catalog overlay's shape; `coerceItemNoun` reads it back). */
export function itemNounStored(n: ItemNoun): { singular: string; dual: string; dual_gen: string; plural: string; tamyiz: string; feminine: boolean } {
  return { singular: n.singular, dual: n.dual, dual_gen: n.dualGen, plural: n.plural, tamyiz: n.tamyiz, feminine: n.feminine };
}

/** A model-written `unit_noun_ar` that names a specific unit (anything in the closed set other than `GENERIC_ITEM_NOUN`), or null: a generic «عنصر» never outranks an older specific reading. */
export function specificModelUnitNoun(raw: unknown): ItemNoun | null {
  const n = coerceItemNoun(raw);
  return n && n.key !== GENERIC_ITEM_NOUN.key ? n : null;
}

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
    // ROUND 58 (live, msn_088c): a definite word right after a definite word is an ADJECTIVE agreeing with it («الإيميل والتليفون المنشورين»: «published», not «posts»); a definite word after an indefinite one is a noun of an idafa
    // («بيانات تواصل الشركات», «تعليقات الفيديوهات») and stays a noun
    if (i > 0 && /^(?:و?ال)/.test(normalizeText(words[i])) && /^(?:و?ال)/.test(normalizeText(words[i - 1]))) continue;
    if (i > 0 && SOURCE_NOUN_KEYS.has(n.key) && !words.slice(0, i).every((w) => LEADING_MODIFIERS.has(normalizeText(w)))) continue;
    return n;
  }
  return GENERIC_ITEM_NOUN;
}

/** The noun of what the customer RECEIVES: the noun of the delivered stages when they all name the same thing («التغريدات»), else «عنصر» (posts together with their comments are items). */
export function itemNounOfPlan(plan: { stages?: ReadonlyArray<{ title_ar?: unknown; titleAr?: unknown; deliver?: boolean; parent_key?: unknown; capability?: unknown; platform?: unknown; item_noun_ar?: unknown; itemNounAr?: unknown; unit_noun_ar?: unknown }> } | null | undefined): ItemNoun {
  const stages = Array.isArray(plan?.stages) ? plan!.stages! : [];
  const delivered = stages.filter((s) => s?.deliver !== false);
  // ROUND 58: a delivered step that hangs on another delivered step DESCRIBES its items («بيانات تواصل الشركات» of «شركات مستحضرات التجميل»): its rows are details of those companies, never more companies. The sum of the two is
  // counted as «عنصر», never in the parent's noun (live risk: 20 companies + 12 contact rows told as «٣٢ شركة» on the card, in the notice and in the file)
  const deliveredKeys = new Set(delivered.map((s) => String((s as { key?: unknown })?.key ?? "")).filter(Boolean));
  if (delivered.some((s) => typeof s?.parent_key === "string" && s.parent_key !== "" && deliveredKeys.has(s.parent_key))) return GENERIC_ITEM_NOUN;
  const nouns = (delivered.length > 0 ? delivered : stages.slice(0, 1)).map((s) => {
    const fromStage = specificModelUnitNoun(s?.unit_noun_ar) ?? coerceItemNoun(s?.item_noun_ar ?? (s as any)?.itemNounAr);
    if (fromStage) return fromStage;
    const byTitle = itemNounOf(String(s?.title_ar ?? s?.titleAr ?? ""));
    return byTitle;
  });
  return nouns.length > 0 && nouns.every((n) => n.key === nouns[0].key) ? nouns[0] : GENERIC_ITEM_NOUN;
}

/** «تغريدة واحدة»، «تغريدتان»، «٥ تغريدات»، «٣٠٠ تغريدة»: a count with its noun, in the right form. `subject: true` keeps the dual in the nominative («تغريدتان»); otherwise it is «تغريدتين» (after a preposition). */
export function countAr(n: number, noun: ItemNoun, options: { subject?: boolean } = {}): string {
  const c = Math.max(0, Math.floor(Number(n) || 0));
  if (c === 1) return `${noun.singular} ${noun.feminine ? "واحدة" : "واحد"}`;
  if (c === 2) return options.subject ? noun.dual : noun.dualGen;
  if (c >= 3 && c <= 10) return `${formatAr(c)} ${noun.plural}`;
  // 100 AND ABOVE follow the last two digits (live, 16 Nov 2026: the card read «١٠٠ تقييمًا»; Arabic says «١٠٠ تقييم», «١٠٣ تقييمات», «١١٥ تقييمًا»)
  if (c >= 100) { const tail = c % 100; return `${formatAr(c)} ${tail <= 2 ? noun.singular : tail <= 10 ? noun.plural : noun.tamyiz}`; }
  return `${formatAr(c)} ${noun.tamyiz}`;
}

/**
 * «٢٥٠ من ٣٠٠ تغريدة» — what was delivered of what was requested, one wording everywhere. Up to ten delivered the count carries its own noun («٣ تغريدات من ٣٠٠ تغريدة»); from eleven the noun is said once, after the requested count.
 */
export function deliveredOfAr(delivered: number, requested: number, noun: ItemNoun): string {
  const d = Math.max(0, Math.floor(Number(delivered) || 0));
  const r = Math.max(0, Math.floor(Number(requested) || 0));
  if (r <= 0) return countAr(d, noun);
  // MORE THAN THE PROMISED NUMBER (round 14: the replies a source gives beyond the ones the plan counted): the number promised stays the number, and the line says why the delivery is above it
  if (d > r) return `${formatAr(d)} ${noun.plural} (أكثر من ${countAr(r, noun)} المحسوبة في الخطة، لأن المصدر أعطى ردودًا زيادة)`;
  return d >= 1 && d <= 10 ? `${countAr(d, noun)} من ${countAr(r, noun)}` : `${formatAr(d)} من ${countAr(r, noun)}`;
}
