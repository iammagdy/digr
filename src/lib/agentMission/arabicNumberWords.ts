/**
 * ROUND 19: NUMBERS WRITTEN IN WORDS in a request («فيديو واحد», «خمس فيديوهات», «تلات منشورات», «عشرين تغريدة», «مية تعليق»), in Modern Standard and in the dialect a customer types. Pure. Digits (Arabic-Indic and Latin) are read elsewhere
 * (`digits`); this only knows the words. A word that is not a number gives null, and a number the customer wrote in words is never guessed from a longer phrase: only the words below, as a whole word.
 */
const WORDS: ReadonlyArray<[number, string]> = [
  [1, "واحد|واحدة|وحدة"],
  [2, "اتنين|إتنين|اثنين|إثنين|اثنان|اثنتين|إثنتين"],
  [3, "ثلاث|ثلاثة|تلات|تلاتة|ثلات"],
  [4, "أربع|اربع|أربعة|اربعة|اربعه"],
  [5, "خمس|خمسة|خمسه"],
  [6, "ست|ستة|سته"],
  [7, "سبع|سبعة|سبعه"],
  [8, "ثمان|ثماني|ثمانية|ثمانيه|تمن|تماني|تمانية|تمانيه|تمان"],
  [9, "تسع|تسعة|تسعه"],
  [10, "عشر|عشرة|عشره"],
  [11, "احد عشر|أحد عشر|احداشر|إحداشر|حداشر"],
  [12, "اثنا عشر|اتناشر|إتناشر"],
  [15, "خمسة عشر|خمستاشر|خمسطاشر"],
  [20, "عشرين|عشرون"],
  [30, "ثلاثين|تلاتين|ثلاثون"],
  [40, "أربعين|اربعين|أربعون"],
  [50, "خمسين|خمسون"],
  [60, "ستين|ستون"],
  [70, "سبعين|سبعون"],
  [80, "ثمانين|تمانين|ثمانون"],
  [90, "تسعين|تسعون"],
  [100, "مية|ميه|مائة|مئة|مائه|مئه"],
  [200, "ميتين|مئتين|مائتين"],
];

const MAP = new Map<string, number>();
for (const [n, alts] of WORDS) for (const w of alts.split("|")) MAP.set(w, n);

/** The regex source that matches any one number word (longest first, so «أحد عشر» is not read as «أحد»). */
export const NUMBER_WORDS_SRC = [...MAP.keys()].sort((a, b) => b.length - a.length).map((w) => w.replace(/\s+/g, "\\s+")).join("|");

/** The value of one number word (or a two-word one such as «خمسة عشر»), or null. */
export function numberOfWord(word: string): number | null {
  return MAP.get(word.replace(/\s+/g, " ").trim()) ?? null;
}

/** A number written with digits (any script already turned to Latin) or in words, as a value. */
export function numberOfToken(token: string): number | null {
  const t = token.trim();
  if (/^\d{1,7}$/.test(t)) return Number(t);
  return numberOfWord(t);
}
