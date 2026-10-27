import { foldArabicLetters } from "./arabicNormalize";

/**
 * How a customer names the X platform. ONE reader for every detector (the social task detector, the capability registry's platform detector, the
 * check of a typed platform answer): readers that disagree made the platform question come back after «إكس» was answered, and a request written
 * «٤٠٠ منشور أكس» was not read as X at all.
 *
 * The text is folded first (`foldArabicLetters`: hamza forms, tatweel, diacritics), so «أكس / إكس / اكس / ايكس / إيكس» are one spelling, «اكـــس» too, and a
 * pattern is written once. The next letter must not continue the word, and the letter before it must not be part of another word, so «اكسل» (Excel),
 * «ماكس» and «ماكسيم» are not X.
 *
 * A bare name is X when: a word makes it a platform («منصة X»، «على اكس»، «لمنصة اكس»); it answers the platform question; it follows a word for what is
 * collected («٤٠٠ منشور اكس»، «حساب اكس»، «تغريدات اكس»); it ends the request or is set apart by a comma («… الصحة السعودية، اكس»); or it is a Latin «x» standing alone.
 */
const AR_X = "(?:ا|اي)كس"; // folded: أكس إكس اكس ايكس إيكس
const NAME = `(?:x|${AR_X})`;
/** Not inside another word: no letter or digit before it or after it. */
const WHOLE = (core: string): string => `(?<![\\p{L}\\p{N}])${core}(?![\\p{L}\\p{N}])`;

const AFTER_PLATFORM_WORD = `منصه\\s*${WHOLE(NAME)}`;
const AFTER_PREPOSITION = `(?:على|علي|في|من|لمنصه|بمنصه|عبر|ع|عن|الي|الى)\\s+${WHOLE(NAME)}`;
const AS_PLATFORM_ANSWER = `(?:منصه البحث المطلوبه|المنصه التي تقصدها)\\s*:\\s*(?:منصه\\s*)?${WHOLE(NAME)}`;
const AFTER_CONTENT_WORD = `(?:بوست(?:ات)?|منشور(?:ات)?|تغريد(?:ه|ات)|تويت(?:ات)?|حساب(?:ات)?|صفحه|بيانات|داتا|محتوي|ترند(?:ات)?|هاشتاج(?:ات)?)\\s+${WHOLE(AR_X)}`;
const ENDS_THE_REQUEST = `(?:[,،؛]\\s*)${WHOLE(AR_X)}\\s*[.!؟?]*\\s*$`;
const LATIN_X_ALONE = `(?<![\\p{L}\\p{N}@])(?<!\\p{N}\\s)x(?![\\p{L}\\p{N}])(?!\\s*\\p{N})`;
const OTHER_NAMES = `تويتر|تغريد|twitter|(?<![\\p{L}])x\\.com(?![\\p{L}])`;

/** Regex source (flags `iu`) to run on FOLDED text (`foldXText`). */
export const X_PLATFORM_FOLDED_SOURCE = [OTHER_NAMES, AFTER_PLATFORM_WORD, AFTER_PREPOSITION, AS_PLATFORM_ANSWER, AFTER_CONTENT_WORD, ENDS_THE_REQUEST, LATIN_X_ALONE].join("|");

const X_RE = new RegExp(X_PLATFORM_FOLDED_SOURCE, "iu");

/** Text as the X reader reads it. */
export const foldXText = (text: string): string => foldArabicLetters(String(text ?? "")).toLowerCase();

/** True when the text names the X platform by any spelling above. */
export function namesXPlatform(text: string): boolean {
  return X_RE.test(foldXText(text));
}

/** The shape the platform tables need: `.test(text)` on the customer's raw text. */
export const X_PLATFORM_READER: { test(text: string): boolean } = { test: namesXPlatform };
