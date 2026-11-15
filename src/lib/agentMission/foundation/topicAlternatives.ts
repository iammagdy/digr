import { countryOfValue } from "../places";

/**
 * P0 (15 Nov 2026, msn_84d0f3738c87d5ed3aee, msn_7758164aa2b4a840fda5, msn_47c4016d9099f63c2bb5): A TOPIC THAT LISTS ALTERNATIVE MEANINGS IS SEVERAL SEARCH CONCEPTS, NOT ONE PHRASE.
 * «عن الشائعات أو التصدي للشائعات أو جهود الوزارة في مكافحة الشائعات» was read as the single topic «الشائعات أو التصدي للشائعات أو جهود الوزارة» (cut at «في», the boundary of a place). The X search then quoted it as ONE exact phrase,
 * the literal word «أو» included, and no tweet of the account contains that sentence; two paid reads returned 0 rows and the request ended «no match».
 * ONE LANGUAGE RULE, for every topic and every platform (no topic word list): the customer's disjunction words («أو», «او», «or», a slash between words) separate alternatives. The last alternative keeps the words the customer
 * wrote after «في» (the request parser stops a topic there for a place: «عن السياحة في مصر»), unless those words name a country (then the country stays the country condition, as before). A topic with no disjunction is untouched.
 * Pure: no I/O, no model.
 */
const DISJUNCTION = /\s+(?:أو|او|or)\s+|(?<=[^\s\d٠-٩۰-۹])\s*\/\s*(?=[^\s\d٠-٩۰-۹])/i;
const HAS_DISJUNCTION = /(?:^|\s)(?:أو|او|or)(?:\s|$)|[^\s\d٠-٩۰-۹]\s*\/\s*[^\s\d٠-٩۰-۹]/i;
/** Where the words after «في» end (the request parser's own boundaries, «في» itself excluded): a period, the platform, a count, punctuation. */
const AFTER_FI = /^\s+في\s+(.+?)(?=\s+(?:من|على|آخر|اخر|بالعربي|بالعربية|مع|بين|منذ|خلال|عبر)(?:\s|$)|[،,.؛;؟?]|$)/;
const MAX_ALTERNATIVES = 5;

const clean = (s: string): string => s.replace(/\s+/g, " ").replace(/^[«"“]+|[»"”]+$/g, "").trim();

/** The topic extended with the words the customer wrote after «في» when the topic lists alternatives (a country there is not taken). `text` is the customer's whole request. */
export function extendedAlternativeTopicOf(topic: string | null, text: string): string | null {
  if (!topic || !HAS_DISJUNCTION.test(topic)) return topic;
  const at = text.indexOf(topic);
  if (at < 0) return topic;
  const m = AFTER_FI.exec(text.slice(at + topic.length));
  if (!m) return topic;
  const tail = clean(m[1]);
  if (tail === "" || tail.split(/\s+/).some((w) => countryOfValue(w) !== null)) return topic;
  return `${topic} في ${tail}`;
}

/** The alternatives of a topic: two or more distinct concepts the customer separated by «أو» / «or» / «/», in their order; [] when the topic lists no alternatives. */
export function topicAlternativesOf(topic: string | null | undefined): string[] {
  const t = clean(String(topic ?? ""));
  if (t === "" || !HAS_DISJUNCTION.test(t)) return [];
  const out: string[] = [];
  for (const part of t.split(DISJUNCTION).map(clean)) if (part !== "" && !out.includes(part)) out.push(part);
  return out.length >= 2 ? out.slice(0, MAX_ALTERNATIVES) : [];
}

/** The alternatives as the customer reads them: «الشائعات» أو «التصدي للشائعات». */
export const alternativesAr = (alternatives: ReadonlyArray<string>): string => alternatives.map((a) => `«${a}»`).join(" أو ");
