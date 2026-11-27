import { OWN_SOURCE_LABELS } from "./platformLabels";
import { normalizeText } from "./relevance";

/** What a customer reads in place of the name of a source they did not write. */
export const SOURCE_LABEL_FALLBACK_AR = "المصدر";

/**
 * WHAT THE CUSTOMER WROTE DECIDES WHAT A SOURCE OR A FOREIGN WORD MAY BE SHOWN (DT-20261118-09, BUG HUNTER RCA3 S1 and S2). A line of the card that holds a Latin word (live: «ceo») or the name of a source the customer never
 * wrote («خرائط جوجل») is not shown; a word the customer wrote themselves is always allowed. No list of providers or words: Latin LETTERS, and the labels of the code's own platform table, compared with the customer's words.
 * Pure: no I/O.
 */
export const LATIN_WORDS = /[A-Za-z]{2,}/g;

/** The Latin words of a text, lower case. */
export const latinWordsOf = (text: unknown): string[] => (String(text ?? "").match(LATIN_WORDS) ?? []).map((w) => w.toLowerCase());

/** The Latin words the customer wrote in any of their texts, lower case. */
export const writtenLatinWords = (texts: ReadonlyArray<string>): Set<string> => new Set(texts.flatMap((t) => latinWordsOf(t)));

/** The Latin words of a text the customer did NOT write. */
export const foreignLatinIn = (text: unknown, written: ReadonlySet<string>): string[] => latinWordsOf(text).filter((w) => !written.has(w));

/** An Arabic word without the one-letter words and the article that join it to the word before («بالإكس», «لخرائط»), kept when too little would be left. */
const bare = (t: string): string => { const m = /^(?:[وف]?(?:بال|كال|لل|ال|[لبك]))/.exec(t); return m && t.length - m[0].length >= 3 ? t.slice(m[0].length) : t; };
const tokensOf = (text: string): string[] => normalizeText(text).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

/** Did the customer write this label? True when a word of the label (3 letters or more, as the Arabic writes it, with or without the article) stands among the customer's words. */
export function labelWrittenBy(label: string, said: ReadonlyArray<string>): boolean {
  const written = new Set(said.flatMap((t) => tokensOf(t)).flatMap((t) => [t, bare(t)]));
  return tokensOf(label).filter((t) => t.length >= 3).some((t) => written.has(t) || written.has(bare(t)));
}
