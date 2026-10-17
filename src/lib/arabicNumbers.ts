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

/**
 * Extracts an explicit number from an Arabic or English request text.
 * Checks for numeric digits first, then compounds and word numbers.
 */
export function extractNumberFromText(text: string): number | undefined {
  if (!text || typeof text !== "string") return undefined;

  const normalized = normalizeEasternArabicDigits(text).toLowerCase().trim();

  // 1. Look for explicit digits with context: e.g. "5 شركات", "30 شركة", "حجم 50", "عايز 10"
  // Exclude current years (2024..2027) unless specifically asked with entity count
  const digitMatchWithEntity = normalized.match(
    /(?:عايز|عاوز|اريد|أريد|محتاج|استخرج|اجمع|هات|حجم|عدد|بحد أقصى|بحد اقصى|حتى|need|want)?\s*(\d+)\s*(?:شركة|شركات|مؤسسة|مؤسسات|فيديو|فيديوهات|مقطع|مقاطع|بوست|بوستات|منشور|منشورات|تعليق|تعليقات|سجل|سجلات|عينة|عينات|companies|company|posts|comments|records)?/i
  );

  if (digitMatchWithEntity && digitMatchWithEntity[1]) {
    const val = parseInt(digitMatchWithEntity[1], 10);
    // If it's a plausible sample size (1..100000) and not a standalone year
    if (val > 0 && val <= 100000) {
      const isYear = val >= 1900 && val <= 2099;
      const hasCountContext = /(?:شركة|شركات|مؤسسة|فيديو|بوست|منشور|تعليق|سجل|عينة|companies|posts|comments|records|حجم|عدد|استخرج)/i.test(digitMatchWithEntity[0]);
      if (!isYear || hasCountContext) {
        return val;
      }
    }
  }

  // 2. Check for teens phrases (e.g. "خمسة عشر", "أحد عشر")
  for (const [phrase, val] of Object.entries(TEENS)) {
    const regex = new RegExp(`(?:^|[^\\p{L}\\p{N}])${phrase}(?:$|[^\\p{L}\\p{N}])`, "iu");
    if (regex.test(normalized)) {
      return val;
    }
  }

  // 3. Check for compound numbers: [hundreds] [و] [ones] [و] [tens]
  // e.g. "خمسة وعشرين" -> 25, "مية وخمسين" -> 150, "ألف وخمسمية" -> 1500
  const compoundMatch = normalized.match(
    /(?:^|[^\p{L}\p{N}])(?:(ألفين|الفين|ألف|الف)\s*(?:و\s*)?)?(?:(مية|ميه|مائة|مئة|ميتين|خمسمية|خمسمائة|تلاتمية|أربعمية|ستمية|سبعمية|تمنمية|تسعمية)\s*(?:و\s*)?)?(?:([^\s]+)\s+و\s+([^\s]+)|([^\s]+))(?:\s+(?:شركة|شركات|مؤسسة|فيديو|بوست|منشور|تعليق|سجل|عينة))?(?:$|[^\p{L}\p{N}])/iu
  );

  // 4. Try matching specific Arabic phrases
  // Check compound "X و عشرين/ثلاثين/أربعين/خمسين..."
  const andTensMatch = normalized.match(/([^\s]+)\s+و\s*(عشرين|عشرون|تلاتين|ثلاثين|أربعين|اربعين|خمسين|ستين|سبعين|ثمانين|تمانين|تسعين)/iu);
  if (andTensMatch) {
    const oneWord = andTensMatch[1].trim();
    const tenWord = andTensMatch[2].trim();
    const oneVal = ONES[oneWord];
    const tenVal = TENS[tenWord];
    if (oneVal !== undefined && tenVal !== undefined) {
      return oneVal + tenVal;
    }
  }

  // Check thousands
  for (const [word, val] of Object.entries(THOUSANDS)) {
    const regex = new RegExp(`(?:^|[^\\p{L}\\p{N}])${word}(?:$|[^\\p{L}\\p{N}])`, "iu");
    if (regex.test(normalized)) {
      return val;
    }
  }

  // Check hundreds
  for (const [word, val] of Object.entries(HUNDREDS)) {
    const regex = new RegExp(`(?:^|[^\\p{L}\\p{N}])${word}(?:$|[^\\p{L}\\p{N}])`, "iu");
    if (regex.test(normalized)) {
      return val;
    }
  }

  // Check tens
  for (const [word, val] of Object.entries(TENS)) {
    const regex = new RegExp(`(?:^|[^\\p{L}\\p{N}])${word}(?:$|[^\\p{L}\\p{N}])`, "iu");
    if (regex.test(normalized)) {
      return val;
    }
  }

  // Check ones (e.g. "خمس شركات", "عشر شركات", "6 companies")
  for (const [word, val] of Object.entries(ONES)) {
    // Only match if followed or preceded by context words like عايز/شركة/شركات/فيديو/منشور/تعليق or start/end
    const regex = new RegExp(`(?:^|[^\\p{L}\\p{N}])${word}(?:\\s+(?:شركة|شركات|مؤسسة|مؤسسات|فيديو|فيديوهات|بوست|منشور|تعليق|سجل|عينة|companies|company|posts|comments|records)|$|[^\\p{L}\\p{N}])`, "iu");
    if (regex.test(normalized)) {
      return val;
    }
  }

  return undefined;
}
