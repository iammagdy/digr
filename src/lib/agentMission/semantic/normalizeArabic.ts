/**
 * PR-1.1 (Arabic semantic normalization, safe foundation): a SEMANTIC-specific normalizer, kept apart from `messageType.normalize` (the one the privacy rules read). It is deliberately NOT imported by `guardRules.ts` and nothing in the product
 * calls it yet (see `flag.ts` and docs/SEMANTIC-NORMALIZATION-V1.md): it is a pure, offline, deterministic utility for the day the parser is allowed to use it, behind the server-controlled flag `semantic_normalization_v1` (default OFF).
 *
 * TWO LAYERS, so that no meaningful distinction is erased on the way:
 *   1. `normalizeArabic(raw)`: the CONSERVATIVE text. It only removes what carries no meaning (invisible characters, diacritics, tatweel, presentation forms, elongated letters, punctuation, extra spaces) and unifies digits. It keeps every Arabic LETTER
 *      as the customer typed it (ة stays ة, ى stays ى, أ stays أ), so a topic read from it is still the customer's own word.
 *   2. `matchKey(token)`: the spelling folds used ONLY to compare a token with the vocabulary (أإآ→ا, ى→ي, ة→ه, ڤ→ف …). It is applied per token and per character, so tokens and keys stay aligned one to one.
 *
 * The ORIGINAL text is never touched, replaced or stored by this module: every function returns a new value and the caller keeps the input for display and audit. Idempotent: `normalizeArabic(normalizeArabic(x)) === normalizeArabic(x)`.
 */

/** The longest text read (the same ceiling as the existing classifier). */
export const SEMANTIC_MAX_CHARS = 2000;

/** Private-use placeholders that protect a decimal / thousands separator between two digits while the other punctuation becomes a space. */
const DOT = "";
const COMMA = "";

export interface NormalizationStep {
  id: string;
  /** What the step does and why it is safe, in one sentence. */
  why: string;
  apply: (text: string) => string;
}

export const NORMALIZATION_STEPS: readonly NormalizationStep[] = [
  { id: "limit", why: "Reads at most the first 2,000 characters (a bound, like the existing classifier).", apply: (t) => t.slice(0, SEMANTIC_MAX_CHARS) },
  // NFKC maps the Arabic presentation forms (U+FB50–FDFF, U+FE70–FEFF: what a PDF, a screenshot copy or a voice tool may paste) and full-width Latin letters and digits to the ordinary characters
  { id: "unicode_nfkc", why: "Unicode NFKC: presentation forms and full-width characters become their ordinary letters.", apply: (t) => t.normalize("NFKC") },
  { id: "invisible", why: "Removes zero-width and bidirectional control characters that a voice or paste tool leaves inside words.", apply: (t) => t.replace(/[​-‏‪-‮⁠-⁩﻿­]/g, "") },
  { id: "diacritics", why: "Removes optional Arabic diacritics (tashkeel, dagger alef, Quranic marks): they never change which word is meant in a request.", apply: (t) => t.replace(/[ً-ٰٟۖ-ۜ۟-۪ۤۧۨ-ۭ]/g, "") },
  { id: "tatweel", why: "Removes the stretching character ـ (كــومنتات → كومنتات).", apply: (t) => t.replace(/ـ/g, "") },
  {
    id: "digits",
    why: "Arabic-Indic (٠-٩) and Persian (۰-۹) digits become Western digits; the Arabic decimal and thousands separators become . and , .",
    apply: (t) => t
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/٫/g, ".")
      .replace(/٬/g, ","),
  },
  { id: "case", why: "Latin letters are compared in lower case.", apply: (t) => t.toLowerCase() },
  // a real Arabic word never repeats one letter three times; a voice transcript or a stretched typing does («كومنتااات», «تعليقاااات»). Latin runs are cut to two (a legitimate double letter stays).
  { id: "elongation", why: "A letter repeated three times or more is cut (Arabic to one, Latin to two): stretched typing and voice artifacts.", apply: (t) => t.replace(/([ء-ي])\1{2,}/g, "$1").replace(/([a-z])\1{2,}/g, "$1$1") },
  { id: "links", why: "A link is one token (its words are not read as vocabulary).", apply: (t) => t.replace(/(?:https?:\/\/|www\.)\S+/g, " url ") },
  // «بtiktok» / «٥٠شركة» (no space between a script or a digit and the next): the two sides become separate tokens
  { id: "script_boundary", why: "A space is put between an Arabic letter and a Latin letter or a digit stuck to it.", apply: (t) => t.replace(/([ء-ي])(?=[a-z0-9])/g, "$1 ").replace(/([a-z0-9])(?=[ء-ي])/g, "$1 ") },
  { id: "separators", why: "A . or , between two digits is kept (5.5, 1,000).", apply: (t) => t.replace(/(?<=\d)\.(?=\d)/g, DOT).replace(/(?<=\d),(?=\d)/g, COMMA) },
  { id: "punctuation", why: "Every character that is not a letter, a digit or a protected separator becomes a space (punctuation, quotes, brackets, emoji, symbols).", apply: (t) => t.replace(/[^\p{L}\p{N}]/gu, " ") },
  { id: "restore_separators", why: "The protected separators come back.", apply: (t) => t.replace(new RegExp(DOT, "g"), ".").replace(new RegExp(COMMA, "g"), ",") },
  { id: "whitespace", why: "One space between tokens; none at the ends.", apply: (t) => t.replace(/\s+/g, " ").trim() },
];

/** The conservative text: no meaning removed, every Arabic letter as typed. Pure and idempotent. */
export function normalizeArabic(raw: unknown): string {
  let text = String(raw ?? "");
  for (const step of NORMALIZATION_STEPS) text = step.apply(text);
  return text;
}

/** WHICH steps changed this text, in order (for audit and for tests that explain themselves). */
export function explainNormalization(raw: unknown): string[] {
  let text = String(raw ?? "");
  const changed: string[] = [];
  for (const step of NORMALIZATION_STEPS) {
    const next = step.apply(text);
    if (next !== text) changed.push(step.id);
    text = next;
  }
  return changed;
}

/** The letters folded for COMPARISON only (never for display or storage): hamza forms of alef, alef maqsura, ta marbuta, and the Persian/Arabic variants of letters Egyptians type on a phone (ڤ for V, پ for P, ک for K, ی for Y). */
export function matchKey(token: string): string {
  return token
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ڤ/g, "ف")
    .replace(/پ/g, "ب")
    .replace(/ک/g, "ك")
    .replace(/ی/g, "ي");
}

export interface SemanticText {
  /** The input exactly as received (kept for display and audit). */
  original: string;
  /** `normalizeArabic(original)`. */
  normalized: string;
  /** The conservative tokens (the customer's own letters). */
  tokens: string[];
  /** `matchKey` of each token: the same length as `tokens`, aligned one to one. */
  keys: string[];
}

export function semanticText(raw: unknown): SemanticText {
  const original = String(raw ?? "");
  const normalized = normalizeArabic(original);
  const tokens = normalized === "" ? [] : normalized.split(" ");
  return { original, normalized, tokens, keys: tokens.map(matchKey) };
}
