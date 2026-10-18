/**
 * Arabic-aware topic matching for social rows (tweets, comments, posts, videos).
 * A customer says «الطاقة الشمسية» and a tweet says «طاقة شمسية»: an exact word comparison misses it. Both sides are
 * normalised and reduced to a light stem (definite article, regular plural and feminine endings), a short table of
 * irregular plurals and dialect spellings is applied, and a few English equivalents count as the same word.
 * Deterministic and offline: no model decides a match.
 */

const STOP_WORDS = new Set([
  "عايز", "عايزه", "عاوز", "عاوزه", "هات", "اجمع", "جمع", "لي", "من", "في", "عن", "علي", "مع", "خلال",
  "اخر", "الفتره", "فتره", "زمنيه", "الزمنيه", "المطلوبه", "مطلوبه", "شهر", "الشهر", "يوم", "ايام",
  "اسبوع", "سنه", "البلد", "الدوله", "مصر", "السعوديه", "المانيا", "egypt", "saudi", "germany",
  "تغريده", "تغريدات", "تويت", "تويتات", "tweet", "tweets", "بوست", "بوستات", "منشور", "منشورات", "post", "posts",
  "كومنت", "كومنتس", "تعليق", "تعليقات", "comment", "comments", "فيديو", "فيديوهات", "مقطع", "مقاطع", "video", "videos",
  "تيك", "توك", "تيكتوك", "tiktok", "يوتيوب", "youtube", "فيسبوك", "facebook", "تويتر", "اكس", "twitter", "x",
  "ترند", "تريند", "ترندنج", "trending", "الرائجه", "رائجه", "القناه", "قناه", "حساب", "مصري", "المصري", "المصريه",
]);

export function normalizeText(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[ً-ٰٟـ]/gu, "")
    .replace(/[أإآٱ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ة/gu, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Irregular plurals and common dialect spellings (already normalised), to the singular form; then stemmed like any word. */
const IRREGULAR: Record<string, string> = {
  مشاريع: "مشروع", منازل: "منزل", بيوت: "بيت", اسعار: "سعر", دول: "دوله", شركات: "شركه", سيارات: "سياره",
  لاعبين: "لاعب", لاعبون: "لاعب", دهب: "ذهب", مباريات: "مباراه", مبارايات: "مباراه", اندييه: "نادي",
};

function lightStem(token: string): string {
  let t = token.replace(/^(?:وال|بال|لل|ال)(?=.{3,})/u, "");
  t = t.replace(/(?:ات|ون|ين)$/u, (m) => (t.length - m.length >= 3 ? "" : m));
  t = t.replace(/(?:ه|ي)$/u, (m) => (t.length > 3 ? "" : m));
  return t;
}

/** Light stem: irregular plurals and dialect spellings first, then article / clitic prefixes and regular endings. */
export function stemToken(token: string): string {
  if (/^[a-z]+$/.test(token)) return token.replace(/(?:ies|s)$/u, "").replace(/ing$/u, "") || token;
  const direct = IRREGULAR[token];
  if (direct) return lightStem(direct);
  const unprefixed = token.replace(/^(?:وال|بال|لل|ال)(?=.{3,})/u, "");
  return lightStem(IRREGULAR[unprefixed] ?? unprefixed);
}

/** Words that mean the same thing as a topic stem; each key is a stem and its list holds equivalent stems. */
const EQUIVALENTS: Record<string, string[]> = {
  شمس: ["solar", "sun"], شمسي: ["solar", "sun"], طاق: ["energy", "power"], ذهب: ["gold"], gold: ["ذهب"],
  كهرب: ["electric", "electricity", "electrical"], كهربائي: ["electric", "electricity", "electrical"],
  سيار: ["car", "cars", "vehicle"], مستعمل: ["used", "secondhand"], مشروع: ["project", "business", "startup"],
  صغير: ["small", "mini"], عقار: ["property", "realestate"], كور: ["ball"],
};

export interface TopicTokens { stems: string[]; basketball: boolean }

export function topicStems(topic: string): string[] {
  return [...new Set(
    normalizeText(topic).split(/\s+/u).filter((token) => token.length > 1 && !STOP_WORDS.has(token)).map(stemToken).filter((s) => s.length > 1),
  )];
}

export function contentStems(content: string): Set<string> {
  return new Set(normalizeText(content).split(/\s+/u).filter(Boolean).map(stemToken));
}

function hasStem(content: Set<string>, stem: string): boolean {
  if (content.has(stem)) return true;
  return (EQUIVALENTS[stem] || []).some((alt) => content.has(stemToken(alt)));
}

export interface TopicMatch { matched: number; total: number }

/** How many of the topic's stems the text contains (equivalents count). */
export function matchTopic(stems: string[], content: string): TopicMatch {
  const present = contentStems(content);
  return { matched: stems.filter((stem) => hasStem(present, stem)).length, total: stems.length };
}
