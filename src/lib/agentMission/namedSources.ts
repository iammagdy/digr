import { normalizeText } from "./relevance";

/**
 * SOURCES THE CUSTOMER NAMES (a channel, a page, an account): «من قناة العربية»، «من حساب @AlAhly»، «من صفحة الأهلي». ONE rule for every platform:
 *
 *   - an item belongs to a named source when the name the source gives for its author MATCHES the name the customer used: the same name, or every word of the customer's name is a word of the author's name («اليوم السابع» is
 *     «اليوم السابع - Youm7»; «BBC News» is «BBC News»), whatever the order, the case, the Arabic article, the words that only say what kind of source it is («قناة», «الرسمية», «official channel»), and the way a handle is written (@ and _);
 *   - the exact equality the account filter used to ask for is the same rule's first case, so a handle still matches itself;
 *   - the customer's name may list alternative spellings in one value, split by «/», «|», «،» or «;» («اليوم السابع / Youm7»): any one of them matches.
 *
 * Pure: no I/O.
 */

/** Words that only say what KIND of source it is or how official it is: they are not part of the name. Written as normalizeText gives them. */
const KIND_WORDS = new Set(["قناه", "قنوات", "channel", "channels", "official", "الرسميه", "رسميه", "رسمي", "الرسمي", "صفحه", "حساب", "page", "account", "tv", "the", "of"]);

const ALTERNATIVES = /\s*[\/|،;؛]\s*/;

/** The words of a name in one comparable form (no article «ال», no kind words, no punctuation). */
export function nameWords(name: unknown): string[] {
  const t = normalizeText(String(name ?? "")).replace(/^@/, "").replace(/[^\p{L}\p{N}\s]/gu, " ");
  return t.split(/\s+/).filter(Boolean).map((w) => (/^[؀-ۿ]/.test(w) && w.length > 3 ? w.replace(/^ال/, "") : w)).filter((w) => !KIND_WORDS.has(w) && !KIND_WORDS.has(`ال${w}`));
}

const compact = (name: unknown): string => normalizeText(String(name ?? "")).replace(/^@/, "").replace(/[^\p{L}\p{N}]/gu, "");

/** The spellings one value of a source filter stands for (the value itself, or each alternative it lists). */
export const alternativesOf = (value: string): string[] => value.split(ALTERNATIVES).map((s) => s.trim()).filter(Boolean);

/** True when the name a source gives for an item's author is the named source the customer wrote. */
export function sourceNameMatches(wanted: string, actual: unknown): boolean {
  const have = String(actual ?? "").trim();
  if (!have) return false;
  for (const alt of alternativesOf(wanted)) {
    const a = compact(alt);
    if (a && a === compact(have)) return true;
    const need = nameWords(alt);
    if (need.length === 0) continue;
    const got = new Set(nameWords(have));
    if (need.every((w) => got.has(w))) return true;
  }
  return false;
}

/** True when the author is any of the named sources. */
export const matchesAnyNamedSource = (values: ReadonlyArray<string>, actual: unknown): boolean => values.some((v) => sourceNameMatches(v, actual));

/** The named sources no item of the measured rows belongs to: the card says so before the customer approves (a source the sample never showed may give nothing). */
export function unresolvedSources(values: ReadonlyArray<string>, authors: ReadonlyArray<unknown>): string[] {
  return values.filter((v) => !authors.some((a) => sourceNameMatches(v, a)));
}

/** The sentence of the card for the named sources that could not be found in what was sampled. */
export const unresolvedSourcesLineAr = (names: ReadonlyArray<string>): string =>
  names.length === 1
    ? `لم نجد «${names[0]}» بين ما فحصناه قبل عرض الخطة، فقد لا يصلك منه شيء. يمكنك تعديل الاسم قبل الاعتماد.`
    : `لم نجد هذه المصادر بين ما فحصناه قبل عرض الخطة: ${names.map((n) => `«${n}»`).join("، ")}؛ فقد لا يصلك منها شيء. يمكنك تعديل الأسماء قبل الاعتماد.`;
