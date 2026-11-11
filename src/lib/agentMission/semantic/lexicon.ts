import { matchKey, normalizeArabic } from "./normalizeArabic";

/**
 * PR-1.1: the CONTROLLED vocabulary. Small and reviewed on purpose: every entry is a word a customer was heard to use for one of the five platforms, the four kinds of requested content, or the Egyptian way of asking. Nothing here is learned, guessed
 * or fuzzy: a form is either in this list (after the spelling folds of `normalizeArabic` / `matchKey`) or it is not.
 *
 * What the vocabulary DOES NOT contain, on purpose:
 *   - WhatsApp, Telegram or any messenger, and «رسايل»/«messages»: a messenger is a TOPIC word here, never a source, so no semantic reading can turn «رسايل عن تطبيق واتساب» into a request to read a conversation (the privacy rules of `guardRules.ts` stay the only judge of that).
 *   - a bare «x» / «اكس» as a platform: it is the platform only with a platform cue in front of it (see `interpret.ts`); alone it stays ambiguous.
 *   - «رد» alone (it also means «a reply to a person», «a reaction»): replies are the forms below only.
 */
export type LexiconCategory = "platform" | "content" | "ask";
export type PlatformId = "tiktok" | "instagram" | "facebook" | "youtube" | "x";
export type ContentId = "posts" | "videos" | "comments" | "replies" | "tweets";
export type AskId = "want" | "get" | "collect" | "extract";

export interface LexiconEntry {
  id: string;
  category: LexiconCategory;
  /** Every spelling, spaced and joined, Arabic and Latin. They are compared after `normalizeArabic` and `matchKey`. */
  forms: readonly string[];
  /** A platform the entry itself names (a platform entry), or the one a content word implies («tweets» → x). */
  implies?: PlatformId;
}

export const LEXICON: readonly LexiconEntry[] = [
  // ---- A. platforms ----
  { id: "tiktok", category: "platform", forms: ["تيك توك", "تيكتوك", "تك توك", "تكتوك", "تيك تك", "تيك طوك", "تيكتك", "tiktok", "tik tok", "tiktock", "tik toc", "tick tok", "tiktoks"] },
  { id: "instagram", category: "platform", forms: ["انستجرام", "انستاجرام", "انستغرام", "انستقرام", "انستجرم", "انسطجرام", "انستا", "انستجرامات", "instagram", "insta", "insta gram", "instgram", "instagrm"] },
  { id: "facebook", category: "platform", forms: ["فيسبوك", "فيس بوك", "فيسبك", "فايسبوك", "فيسبووك", "فيس", "facebook", "face book", "fb", "facebok", "fecebook"] },
  { id: "youtube", category: "platform", forms: ["يوتيوب", "يوتوب", "يوتيب", "يو تيوب", "يوتيوبات", "youtube", "you tube", "youtub", "utube"] },
  { id: "x", category: "platform", forms: ["تويتر", "twitter", "x com", "اكس دوت كوم"] },
  // the bare letter is a separate, AMBIGUOUS entry: `interpret.ts` decides (with cues) whether it is the platform, a name, or undecided
  { id: "x_bare", category: "platform", forms: ["x", "اكس", "اكس تويتر", "x twitter", "twitter x"] },

  // ---- B. requested content ----
  { id: "posts", category: "content", forms: ["منشورات", "منشور", "بوستات", "بوست", "بوستس", "posts", "post", "بوستاات"] },
  { id: "videos", category: "content", forms: ["فيديوهات", "فيديو", "فديوهات", "فيديوات", "فيديوز", "videos", "video", "vids", "ريلز", "ريل", "reels", "reel", "clips", "clip", "كليبات"] },
  { id: "comments", category: "content", forms: ["تعليقات", "تعليق", "كومنتات", "كومنت", "كومنتس", "كومينتس", "كومنتز", "كومينت", "كمنتات", "كمنت", "comments", "comment", "commets", "comnts", "cmnts"] },
  { id: "replies", category: "content", forms: ["ردود", "ردين", "ريبلاي", "ريبلايز", "ريبلايات", "ريبلاى", "ريبلاي", "replies", "reply", "repls"] },
  { id: "tweets", category: "content", forms: ["تغريدات", "تغريده", "تويتات", "تويته", "تويت", "tweets", "tweet", "تويتة"], implies: "x" },

  // ---- C. common Egyptian ways of asking ----
  { id: "want", category: "ask", forms: ["عايز", "عاوز", "عايزه", "عاوزه", "عايزين", "عاوزين", "محتاج", "محتاجه", "محتاجين", "نفسي", "عايز اشوف", "i want", "want", "need", "i need"] },
  { id: "get", category: "ask", forms: ["هات", "هاتلي", "هات لي", "هاتلنا", "جيب", "جيبلي", "جيب لي", "give me", "get me", "get"] },
  { id: "collect", category: "ask", forms: ["اجمع", "اجمعلي", "اجمع لي", "جمعلي", "جمع لي", "collect", "gather"] },
  { id: "extract", category: "ask", forms: ["طلعلي", "طلع لي", "اطلعلي", "اطلع لي", "اسحب", "اسحبلي", "اسحب لي", "استخرج", "استخرجلي", "استخرج لي", "extract", "scrape", "pull"] },
];

/** The id of the ASK a form belongs to is the entry id; the platform / content ids are the typed ids above. */
export interface CompiledPhrase {
  entry: LexiconEntry;
  keys: readonly string[];
}

const compile = (): ReadonlyMap<string, readonly CompiledPhrase[]> => {
  const index = new Map<string, CompiledPhrase[]>();
  for (const entry of LEXICON) {
    for (const form of entry.forms) {
      const text = normalizeArabic(form);
      if (text === "") continue;
      const keys = text.split(" ").map(matchKey);
      const list = index.get(keys[0]) ?? [];
      if (!list.some((p) => p.entry === entry && p.keys.join(" ") === keys.join(" "))) list.push({ entry, keys });
      index.set(keys[0], list);
    }
  }
  for (const list of index.values()) list.sort((a, b) => b.keys.length - a.keys.length);
  return index;
};

export const COMPILED_LEXICON: ReadonlyMap<string, readonly CompiledPhrase[]> = compile();

// ---- clitics ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Arabic attaches one-letter words and the article to the next word («فتيكتوك», «عالتيك توك», «بالتعليقات», «للفيديوهات»). The spellings of a token with such a front removed, the token itself first. Only Arabic-script tokens are cut, and never
 * down to fewer than two letters. Used for platform and content words only (a verb is matched as typed).
 */
export function cliticVariants(key: string): string[] {
  const out = [key];
  if (!/^[\u0621-\u064A]+$/.test(key)) return out;
  // the longest front first; «للتعليقات» is ل + ال + تعليقات (the article's alef is dropped after لـ), so «لل» is one front
  for (const p of ["لل", "وال", "فال", "بال", "كال", "عال", "ال", "و", "ف", "ب", "ل", "ك", "ع"]) {
    if (key.startsWith(p) && key.length - p.length >= 2) out.push(key.slice(p.length));
  }
  return [...new Set(out)];
}

/** The pronoun endings an Arabic content noun takes («كومنتاتهم», «بوستاته»): tried for content words only, and only when the stem is a vocabulary word. */
export function suffixVariants(key: string): string[] {
  if (!/^[\u0621-\u064A]+$/.test(key)) return [];
  const out: string[] = [];
  for (const s of ["ها", "هم", "كم", "نا", "ه", "ك"]) {
    if (key.endsWith(s) && key.length - s.length >= 3) out.push(key.slice(0, key.length - s.length));
  }
  return out;
}

export interface TermMatch {
  entry: LexiconEntry;
  /** Token positions [start, end) in the tokens of the text. */
  start: number;
  end: number;
  /** How the first token matched: as typed, after a clitic was removed, or after a pronoun ending was removed (content words only). */
  via: "exact" | "clitic" | "suffix";
}

const rest = (keys: readonly string[], i: number, phrase: CompiledPhrase): boolean => {
  if (i + phrase.keys.length > keys.length) return false;
  for (let k = 1; k < phrase.keys.length; k++) if (keys[i + k] !== phrase.keys[k]) return false;
  return true;
};

/** Finds the vocabulary terms in a list of match keys: whole tokens only (never a substring of a word), the longest phrase first, an exact spelling before a clitic one, no overlap. */
export function findTerms(keys: readonly string[]): TermMatch[] {
  const found: TermMatch[] = [];
  let i = 0;
  while (i < keys.length) {
    let best: TermMatch | null = null;
    const consider = (entry: LexiconEntry, len: number, via: TermMatch["via"]) => {
      const better = !best || len > best.end - best.start || (len === best.end - best.start && via === "exact" && best.via !== "exact");
      if (better) best = { entry, start: i, end: i + len, via };
    };
    for (const head of cliticVariants(keys[i])) {
      const via: TermMatch["via"] = head === keys[i] ? "exact" : "clitic";
      for (const phrase of COMPILED_LEXICON.get(head) ?? []) {
        if (via === "clitic" && phrase.entry.category === "ask") continue; // a verb is matched as typed
        if (rest(keys, i, phrase)) consider(phrase.entry, phrase.keys.length, via);
      }
      for (const stem of suffixVariants(head)) {
        for (const phrase of COMPILED_LEXICON.get(stem) ?? []) {
          if (phrase.entry.category === "content" && phrase.keys.length === 1) consider(phrase.entry, 1, "suffix");
        }
      }
    }
    if (best) { const b: TermMatch = best; found.push(b); i = b.end; } else i += 1;
  }
  return found;
}
