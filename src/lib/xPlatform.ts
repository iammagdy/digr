/**
 * How a customer names the X platform. ONE pattern for every reader (the social task detector, the capability registry's platform detector, the
 * check of a typed platform answer): two readers that disagree made the platform question come back after «إكس» was answered, because one of
 * them saw the platform and the other did not.
 *
 * The Arabic spellings of the letter's name are «إكس», «اكس» and «أكس». The next letter must not continue the word, so «اكسل» (Excel) and «ماكس» are not X.
 */
const X_NAME = "(?:x|إكس|اكس|أكس)(?![\\p{L}])";
/** A bare name is X only after a word that makes it a platform («على إكس», «لمنصة أكس»), or as the answer to the platform question. */
const X_AFTER_PREPOSITION = `(?:على|علي|في|من|لمنصة|بمنصة|عبر)\\s+(?:إكس|اكس|أكس)(?![\\p{L}])`;
const X_AFTER_PLATFORM_WORD = `منصة\\s*${X_NAME}`;
const X_AS_PLATFORM_ANSWER = `(?:منصة البحث المطلوبة|المنصة التي تقصدها)\\s*:\\s*(?:منصة\\s*)?${X_NAME}`;

/** Regex source (flags `iu`) of the names that mean X without another word beside them. */
export const X_PLATFORM_NAME_SOURCE = `تويتر|تغريد|twitter|${X_AFTER_PLATFORM_WORD}|${X_AFTER_PREPOSITION}|${X_AS_PLATFORM_ANSWER}|\\bx\\.com\\b`;

/** True when the text names the X platform by any spelling above. */
export function namesXPlatform(text: string): boolean {
  return new RegExp(X_PLATFORM_NAME_SOURCE, "iu").test(text || "");
}
