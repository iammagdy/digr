/**
 * ARABIC LETTERS BY CODE POINT (DT-20261126-wordlist-wave4, UD-a, D-0232). Pure orthography: which code points are marks, which letters fold into which, which blocks are Arabic script, which affixes a word may carry.
 * Nothing here reads a customer's words for their MEANING; every function compares code points and none uses a regular expression with an Arabic letter in it. Each one replaces a regular expression
 * that lived in a server file, and `tests/wl4-ud-arabic-units.test.ts` proves it equal to that expression over every code point (and over every short string for the affix rules).
 */

/** Tatweel and the marks of the Arabic block, NARROW set: U+0640, U+064B..U+065F, U+0670 (topicMatch, negativeListEngine, relevanceEvidence). */
export const isMarkOrTatweel = (cp: number): boolean => cp === 0x640 || (cp >= 0x64b && cp <= 0x65f) || cp === 0x670;
/** The WIDE set of commentQuality: U+0640 and the whole range U+064B..U+0670, which also holds U+0660..U+066F (the Arabic-Indic digits are removed with the marks: kept as it was). */
export const isMarkOrTatweelWide = (cp: number): boolean => cp === 0x640 || (cp >= 0x64b && cp <= 0x670);
/** The Arabic block, U+0600..U+06FF. */
export const isArabicBlock = (cp: number): boolean => cp >= 0x600 && cp <= 0x6ff;
/** Arabic script: the block, its supplement U+0750..U+077F and the presentation forms U+FB50..U+FDFF, U+FE70..U+FEFF. */
export const isArabicScript = (cp: number): boolean => isArabicBlock(cp) || (cp >= 0x750 && cp <= 0x77f) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff);

/** The text without the code points the predicate accepts. */
export function removeCodePoints(text: string, drop: (cp: number) => boolean): string {
  let out = "";
  for (const ch of text) if (!drop(ch.codePointAt(0)!)) out += ch;
  return out;
}

/** How many code points of the text the predicate accepts. */
export function countCodePoints(text: string, accept: (cp: number) => boolean): number {
  let n = 0;
  for (const ch of text) if (accept(ch.codePointAt(0)!)) n += 1;
  return n;
}

/** Every code point that has an entry in the table replaced by the entry's code point, in ONE pass (no entry maps to another entry's key). */
export function mapCodePoints(text: string, table: Readonly<Record<number, number>>): string {
  let out = "";
  for (const ch of text) {
    const to = table[ch.codePointAt(0)!];
    out += to === undefined ? ch : String.fromCodePoint(to);
  }
  return out;
}

const ALEF = 0x627;
const HAMZA_ALEFS = [0x623, 0x625, 0x622] as const; // alef with hamza above, hamza below, madda
const ALEF_WASLA = 0x671;
const ALEF_MAKSURA = 0x649;
const YA = 0x64a;
const TA_MARBUTA = 0x629;
const HA = 0x647;
const WAW = 0x648;
const WAW_HAMZA = 0x624;
const YA_HAMZA = 0x626;

const table = (entries: ReadonlyArray<readonly [number, number]>): Readonly<Record<number, number>> => Object.fromEntries(entries);
/** alef with hamza or madda to bare alef; alef maksura to ya; ta marbuta to ha (commentQuality's generic-comment text). */
export const FOLD_GENERIC: Readonly<Record<number, number>> = table([...HAMZA_ALEFS.map((c) => [c, ALEF] as const), [ALEF_MAKSURA, YA], [TA_MARBUTA, HA]]);
/** The same plus alef wasla (topicMatch's normalizeText). */
export const FOLD_TOPIC: Readonly<Record<number, number>> = table([...HAMZA_ALEFS.map((c) => [c, ALEF] as const), [ALEF_WASLA, ALEF], [ALEF_MAKSURA, YA], [TA_MARBUTA, HA]]);
/** The same plus waw with hamza to waw and ya with hamza to ya (the exclusion engine's company-name text). */
export const FOLD_EXCLUSION: Readonly<Record<number, number>> = table([...HAMZA_ALEFS.map((c) => [c, ALEF] as const), [ALEF_WASLA, ALEF], [TA_MARBUTA, HA], [ALEF_MAKSURA, YA], [WAW_HAMZA, WAW], [YA_HAMZA, YA]]);

/** The text split on every run of Latin commas and Arabic commas (U+002C, U+060C); same result as `split(/[,<arabic comma>]+/)`: a leading or trailing run leaves an empty part. */
export function splitOnCommas(text: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inRun = false;
  for (const ch of text) {
    if (ch === "," || ch === "،") {
      if (!inRun) { parts.push(cur); cur = ""; inRun = true; }
    } else {
      cur += ch;
      inRun = false;
    }
  }
  parts.push(cur);
  return parts;
}

/** True when the string is not empty and every code point is an ASCII digit or an Arabic-Indic digit (U+0660..U+0669). */
export function isAllDigits(text: string): boolean {
  if (text === "") return false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (!((cp >= 0x30 && cp <= 0x39) || (cp >= 0x660 && cp <= 0x669))) return false;
  }
  return true;
}

/** Three code points follow `rest`'s start and none of them is a line terminator: what `(?=.{3,})` asks. */
function hasThreePlainCodePoints(rest: string): boolean {
  let n = 0;
  for (const ch of rest) {
    if (ch === "\n" || ch === "\r" || ch === " " || ch === " ") return false;
    n += 1;
    if (n === 3) return true;
  }
  return false;
}

// Affixes as code points (escapes, written once here): the definite article «ال», with the clitics wa/ba/ka/fa/lam before it.
const AL = "ال";
const LAM_AL = "لل";
const WA_AL = "وال";
const BA_AL = "بال";
const KA_AL = "كال";
const FA_AL = "فال";

/** topicMatch: the article with a wa/ba/lam clitic is cut off when at least three plain code points remain; the alternatives are tried in this order (wa+al, ba+al, lam+lam, al). */
export function stripTopicArticle(token: string): string {
  for (const p of [WA_AL, BA_AL, LAM_AL, AL]) if (token.startsWith(p) && hasThreePlainCodePoints(token.slice(p.length))) return token.slice(p.length);
  return token;
}

/** topicMatch: «ات», «ون», «ين» at the end are cut when at least three letters remain. */
export function stripTopicPluralEnding(t: string): string {
  for (const e of ["ات", "ون", "ين"]) if (t.endsWith(e)) return t.length - e.length >= 3 ? t.slice(0, -2) : t;
  return t;
}

/** topicMatch: a final ha or ya is cut when the word is longer than three letters. */
export function stripTopicFinalHaYa(t: string): string {
  return (t.endsWith("ه") || t.endsWith("ي")) && t.length > 3 ? t.slice(0, -1) : t;
}

/** relevanceEvidence: the article with a wa/ba/ka/fa/lam clitic is cut off the front (no length rule); alternatives in this order. */
export function stripEvidenceArticle(token: string): string {
  for (const p of [WA_AL, BA_AL, KA_AL, FA_AL, LAM_AL, AL]) if (token.startsWith(p)) return token.slice(p.length);
  return token;
}

/** relevanceEvidence: one clitic letter (wa, ba, lam, fa) is cut off the front. */
export function stripEvidenceClitic(token: string): string {
  return token.length > 0 && "وبلف".includes(token[0]) ? token.slice(1) : token;
}

/** relevanceEvidence: the agent-noun prefix mim or ta is cut off the front. */
export function stripEvidenceAgentPrefix(token: string): string {
  return token.length > 0 && "مت".includes(token[0]) ? token.slice(1) : token;
}

/** relevanceEvidence: a token of four or more characters that starts with wa reads as «and» plus a word. */
export function startsWithConjunctionWord(token: string): boolean {
  return token.charCodeAt(0) === 0x648 && hasThreePlainCodePoints(token.slice(1));
}

/** The endings relevanceEvidence cuts, longest rule first as the list was written (two letters, then one). */
export const EVIDENCE_ENDINGS: ReadonlyArray<string> = ["ات", "ون", "ين", "ان", "يه", "ها", "ه", "ي"];

/** stageCall: a stem that starts with lam, ba, wa or fa (to, with, and, so). */
export function startsWithOneLetterPrefix(stem: string): boolean {
  return stem.length > 0 && "لبوف".includes([...stem][0]);
}

/** negativeListEngine: a word without its leading definite article (when it has one). */
export function stripLeadingArticle(word: string): string {
  return word.startsWith(AL) ? word.slice(AL.length) : word;
}

const isAsciiWordCp = (cp: number): boolean => (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f;

/** socialRows: a provider key reduced to its lower-case ASCII letters, digits and Arabic-block letters (the text must be lower-cased by the caller). */
export function squashKey(lowerKey: string): string {
  return removeCodePoints(lowerKey, (cp) => !((cp >= 0x30 && cp <= 0x39) || (cp >= 0x61 && cp <= 0x7a) || isArabicBlock(cp)));
}

/** socialRows: 2 to 60 code points, each an ASCII letter, digit, underscore, dot, hyphen or Arabic-block letter. */
export function isSocialHandle(text: string): boolean {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (!(isAsciiWordCp(cp) || cp === 0x2e || cp === 0x2d || isArabicBlock(cp))) return false;
    n += 1;
    if (n > 60) return false;
  }
  return n >= 2;
}
