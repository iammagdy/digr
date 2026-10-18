/**
 * Utility for parsing and normalizing Arabic and English number words into integer values.
 * Supports:
 * - Eastern Arabic digits (٠-٩)
 * - Individual words: خمس، عشرة، مية، ألف...
 * - Compound words: خمسة وعشرين، مية وخمسين، ألفين وخمسمية...
 * - English number words: five, six, ten, thirty...
 */

export const DIGIT_MAP: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

export function normalizeEasternArabicDigits(text: string): string {
  if (!text) return "";
  return text.replace(/[٠-٩]/g, (d) => DIGIT_MAP[d] ?? d);
}

const ONES: Record<string, number> = {
  واحد: 1,
  واحده: 1,
  واحدة: 1,
  اتنين: 2,
  اثنين: 2,
  اثنان: 2,
  تلاتة: 3,
  تلاته: 3,
  ثلاثة: 3,
  ثلاثه: 3,
  تلات: 3,
  ثلاث: 3,
  أربعة: 4,
  اربعه: 4,
  أربعه: 4,
  اربعة: 4,
  أربع: 4,
  اربع: 4,
  خمسة: 5,
  خمسه: 5,
  خمس: 5,
  ستة: 6,
  سته: 6,
  ست: 6,
  سبعة: 7,
  سبعه: 7,
  سبع: 7,
  ثمانية: 8,
  ثمانيه: 8,
  تمانية: 8,
  تمانيه: 8,
  تمنية: 8,
  تمنيه: 8,
  ثمان: 8,
  تمان: 8,
  تسعة: 9,
  تسعه: 9,
  تسع: 9,
  عشرة: 10,
  عشره: 10,
  عشر: 10,
  // English ones
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const TEENS: Record<string, number> = {
  حداشر: 11,
  "أحد عشر": 11,
  "احد عشر": 11,
  اتناشر: 12,
  "اثنا عشر": 12,
  "اثني عشر": 12,
  "إثنا عشر": 12,
  تلاتاشر: 13,
  "ثلاثة عشر": 13,
  اربعتاشر: 14,
  أربعتاشر: 14,
  "أربعة عشر": 14,
  "اربعة عشر": 14,
  خمسطاشر: 15,
  "خمسة عشر": 15,
  ستاشر: 16,
  "ستة عشر": 16,
  سبعتاشر: 17,
  "سبعة عشر": 17,
  تمنتاشر: 18,
  "ثمانية عشر": 18,
  تسعتاشر: 19,
  "تسعة عشر": 19,
  // English
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  عشرين: 20,
  عشرون: 20,
  تلاتين: 30,
  ثلاثين: 30,
  ثلاثون: 30,
  أربعين: 40,
  اربعين: 40,
  أربعون: 40,
  اربعون: 40,
  خمسين: 50,
  خمسون: 50,
  ستين: 60,
  ستون: 60,
  سبعين: 70,
  سبعون: 70,
  ثمانين: 80,
  تمانين: 80,
  ثمانون: 80,
  تسعين: 90,
  تسعون: 90,
  // English
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const HUNDREDS: Record<string, number> = {
  مية: 100,
  ميه: 100,
  مئة: 100,
  مائة: 100,
  ميتين: 200,
  مئتين: 200,
  مائتان: 200,
  تلاتمية: 300,
  ثلاثمائة: 300,
  "ثلاث مئة": 300,
  "ثلاث مائة": 300,
  أربعمية: 400,
  اربعمية: 400,
  أربعمائة: 400,
  اربعمائة: 400,
  خمسمية: 500,
  خمسمائة: 500,
  "خمس مئة": 500,
  "خمس مائة": 500,
  ستمية: 600,
  ستمائة: 600,
  سبعمية: 700,
  سبعمائة: 700,
  تمنمية: 800,
  ثمانمائة: 800,
  تسعمية: 900,
  تسعمائة: 900,
  hundred: 100,
};

const THOUSANDS: Record<string, number> = {
  ألف: 1000,
  الف: 1000,
  ألفين: 2000,
  الفين: 2000,
  "تلات آلاف": 3000,
  "ثلاثة آلاف": 3000,
  "خمس آلاف": 5000,
  "خمسة آلاف": 5000,
  "عشر آلاف": 10000,
  "عشرة آلاف": 10000,
  thousand: 1000,
};

type NumberKind = "one" | "teen" | "ten" | "hundred" | "thousand";

/** Spelling-insensitive form: no diacritics, one alef, one yaa, no final taa marbuta. */
function normalizeNumberWord(word: string): string {
  return word
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة$/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

const NUMBER_PHRASES: Array<{ words: string[]; value: number; kind: NumberKind }> = (() => {
  const phrases = new Map<string, { value: number; kind: NumberKind }>();
  const add = (table: Record<string, number>, kind: NumberKind) => {
    for (const [phrase, value] of Object.entries(table)) phrases.set(normalizeNumberWord(phrase), { value, kind });
  };
  add(ONES, "one");
  add(TEENS, "teen");
  add(TENS, "ten");
  add(HUNDREDS, "hundred");
  add(THOUSANDS, "thousand");
  // Longest phrases first so "خمسة عشر" is read as 15, not 5 followed by 10.
  return [...phrases.entries()]
    .map(([phrase, info]) => ({ words: phrase.split(" "), ...info }))
    .sort((left, right) => right.words.length - left.words.length);
})();

/**
 * Reads the first number written in words: simple (خمس، عشرة، مية، ألف), joined
 * with "و" (خمسة وعشرين، مية وخمسين، ألف وخمسمية) or in English (five, ten).
 * Returns undefined when the text contains no number word.
 */
function extractNumberFromWords(text: string): number | undefined {
  // Split a leading conjunction off each word ("وخمسين" -> "و خمسين") without touching words that merely start with و.
  const tokens = text
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((token) => {
      const normalized = normalizeNumberWord(token);
      const isNumberWordItself = NUMBER_PHRASES.some((phrase) => phrase.words[0] === normalized);
      if (!isNumberWordItself && normalized.startsWith("و") && normalized.length > 2) {
        const rest = normalized.slice(1);
        if (NUMBER_PHRASES.some((phrase) => phrase.words[0] === rest)) return ["و", rest];
      }
      return [normalized];
    });

  const matchAt = (index: number) => {
    for (const phrase of NUMBER_PHRASES) {
      if (phrase.words.every((word, offset) => tokens[index + offset] === word)) return phrase;
    }
    return null;
  };

  for (let start = 0; start < tokens.length; start++) {
    const first = matchAt(start);
    if (!first) continue;
    let total = 0;
    let chunk = 0;
    let index = start;
    let phrase: ReturnType<typeof matchAt> = first;
    while (phrase) {
      if (phrase.kind === "thousand") total += phrase.value;
      else chunk += phrase.value;
      index += phrase.words.length;
      if (tokens[index] === "و" && matchAt(index + 1)) index += 1;
      phrase = matchAt(index);
    }
    return total + chunk;
  }
  return undefined;
}

/**
 * Extracts an explicit number from an Arabic or English request text.
 * Digits are read first (with a year guard), then number words.
 */
export function extractNumberFromText(text: string): number | undefined {
  if (!text || typeof text !== "string") return undefined;

  const normalized = normalizeEasternArabicDigits(text).toLowerCase().trim();

  // 1. Explicit digits with context: "5 شركات", "30 شركة", "حجم 50", "عايز 10".
  const digitMatchWithEntity = normalized.match(
    /(?:عايز|عاوز|اريد|أريد|محتاج|استخرج|اجمع|هات|حجم|عدد|بحد أقصى|بحد اقصى|حتى|need|want)?\s*(\d+)\s*(?:شركة|شركات|مؤسسة|مؤسسات|فيديو|فيديوهات|مقطع|مقاطع|بوست|بوستات|منشور|منشورات|تعليق|تعليقات|سجل|سجلات|عينة|عينات|companies|company|posts|comments|records)?/i
  );

  if (digitMatchWithEntity && digitMatchWithEntity[1]) {
    const val = parseInt(digitMatchWithEntity[1], 10);
    if (val > 0 && val <= 100000) {
      const isYear = val >= 1900 && val <= 2099;
      const hasCountContext = /(?:شركة|شركات|مؤسسة|فيديو|بوست|منشور|تعليق|سجل|عينة|companies|posts|comments|records|حجم|عدد|استخرج)/i.test(digitMatchWithEntity[0]);
      // "في سنة 2024 تعليقات" names a year, not 2024 comments.
      const before = normalized.slice(0, digitMatchWithEntity.index! + digitMatchWithEntity[0].indexOf(digitMatchWithEntity[1]));
      const namesYear = isYear && /(?:سنة|سنه|عام|لعام|year|during|in)\s*$/i.test(before);
      if (!namesYear && (!isYear || hasCountContext)) {
        return val;
      }
    }
  }

  // 2. Number words, including compounds ("مية وخمسين" is 150, "ألف وخمسمية" is 1500).
  return extractNumberFromWords(normalized);
}
