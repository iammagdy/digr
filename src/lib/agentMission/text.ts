import { toArabicDigits } from "../arabicDigits";

/**
 * What the customer reads is Arabic only, with Arabic-Indic digits, and never a provider name, an endpoint id, a dollar amount or an internal id. The agent's instructions say so
 * (agent/prompts/system.md); this is the same rule IN CODE, applied to every line the agent writes for the customer (progress lines, the plan, the question, the summary), so a
 * model that slips is told to rephrase instead of the line being stored.
 */
const LATIN_WORD = /[A-Za-z]{2,}/;
const USD_WORDS = /\$|USD|دولار|دولارات|دولارا/i;
const INTERNAL_ID = /\b(?:msn|call|out|job|quote|res|chg|rel|exp|stg)_[A-Za-z0-9]+/i;

export interface CustomerTextCheck {
  /** The text with every ASCII digit turned into an Arabic-Indic digit. */
  text: string;
  /** Empty when the text may be shown. */
  issues: string[];
}

export function checkCustomerText(raw: unknown, options: { maxChars?: number } = {}): CustomerTextCheck {
  const source = String(raw ?? "").replace(/\s+/g, " ").trim();
  const text = toArabicDigits(source);
  const issues: string[] = [];
  if (!source) issues.push("the text is empty");
  if (source.length > (options.maxChars ?? 400)) issues.push(`the text is longer than ${options.maxChars ?? 400} characters`);
  if (!/[؀-ۿ]/.test(source)) issues.push("the text must be Arabic");
  if (LATIN_WORD.test(source)) issues.push("no Latin words: provider names, endpoint ids and English are never shown to the customer");
  if (USD_WORDS.test(source)) issues.push("no dollar amounts: the customer sees points only");
  if (INTERNAL_ID.test(source)) issues.push("no internal ids");
  return { text, issues };
}

/** Same, for a value that must never carry a price or a technical id but may be short (a stage title, a column title). */
export const checkCustomerLabel = (raw: unknown): CustomerTextCheck => checkCustomerText(raw, { maxChars: 80 });
