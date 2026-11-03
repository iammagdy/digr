import type { Ask } from "./ask";
import type { Occurrence } from "./occurrence";
import { COUNTRY_AR } from "./toolCards/mapCode";
import type { ToolCard } from "./toolCards/types";

/**
 * F4, THE POOL: the parents are CHOSEN by code among every row the parent stage read at planning (never filtered: a row that misses a condition is ranked lower, not removed),
 * in the owner's order: the named source first, then the customer's country and language, then the rows whose own text names the topic, then the most commented (or the
 * newest when the customer asked for the newest). Ties keep the source's own order. Pure.
 */
export type PoolRow = Record<string, unknown> & { id: string };

const norm = (s: string): string => s.replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase();
const ARABIC = /[؀-ۿ]/;

export interface RowFacts { named: boolean; country: boolean; language: boolean; topic: boolean; /** 2 = the caption BODY talks about the topic, 1 = the topic is only inside hashtags (the tool, not the subject), 0 = not there. Each 2 when the Ask names no topic. */ topicTier: TopicTier }
export type TopicTier = 0 | 1 | 2;

/** A hashtag: «#» and the run of non-space characters after it (`##AIبالعربي` is one token; `#ذكاء_اصطناعي` keeps its underscore). */
const HASHTAG = /#+[^\s#]*/g;
const withoutHashtags = (text: string): string => text.replace(HASHTAG, " ");

/**
 * HOW THE ITEM'S OWN TEXT RELATES TO THE TOPIC (live D1, msn_2dfcf9cc113dff442711: «عن الذكاء الاصطناعي» chose two AI-made cartoon stories whose hashtags were #ai #ذكاء_اصطناعي).
 * Tier 2: every word of the topic is in the caption BODY (the hashtags taken out). Tier 1: every word is in the caption but not all in the body, i.e. the topic is named by
 * hashtags: the video was made WITH the topic (the tool), it is not ABOUT it. Tier 0: not in the caption. When the customer asked for what is made with the topic («معمول بـ X»),
 * a hashtag match is what was asked, so it counts as tier 2. Ranking only: no tier removes an item.
 */
export function topicTierOf(text: string, ask: Pick<Ask, "topic">): TopicTier {
  const words = keyTokensOf(ask.topic.text);
  if (words.length === 0) return 2;
  const need = keyTokensNeeded(words.length);
  const all = norm(text);
  if (words.filter((w) => all.includes(w)).length < need) return 0;
  const body = norm(withoutHashtags(text));
  if (words.filter((w) => body.includes(w)).length >= need) return 2;
  return ask.topic.relation === "made_with" ? 2 : 1;
}

/**
 * THE KEY TOKENS OF A TOPIC (live round 10, msn_67cafa6747d70356d9cb: «نهائي السوبر المصري الأهلي والزمالك» marked «لا يذكر الموضوع» for «زيزو رجل نهائي السوبر أمام الزمالك» and «لحظات تتويج الأهلي بكأس السوبر المصري والفوز على الزمالك»): the words of the topic, each without «ال» and
 * without a «و» glued to it («والزمالك» is «الزمالك»). A topic of up to three words is an exact phrase of names: every word must be in the text (as before). A longer one describes an EVENT, and a title never repeats all its words, so three fifths of the key tokens are enough (4 of 5 words: 3).
 * One rule for every platform; a topic of one to three words, the only kind the TikTok and X fixtures have, is matched exactly as it was.
 */
export function keyTokensOf(topic: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of topic ? norm(topic).split(/\s+/) : []) {
    const w = (/^وال.{2,}/.test(raw) ? raw.slice(1) : raw).replace(/^ال/, "");
    if (w.length > 1 && !out.includes(w)) out.push(w);
  }
  return out;
}
export const keyTokensNeeded = (n: number): number => (n <= 3 ? n : Math.ceil((n * 3) / 5));

/** The words that only say what kind of source a name is («قناة العربية» is the page named «العربية»). */
const SOURCE_KIND_WORDS = new Set(["قناه", "صفحه", "حساب", "موقع", "جريده", "مجله"]);
const stripAl = (w: string): string => w.replace(/^ال/, "");
/**
 * IS THIS POST FROM THE NAMED PAGE (Facebook): the page is CHOSEN among the read posts by its author, never filtered. Every word of the name the customer gave (without «قناة / صفحة / حساب») is in the author's name, or the name is a Latin handle
 * that is the last part of the author's link (`AlArabiya` in `facebook.com/AlArabiya`). The author id is the page's own (the same id on every post of the page).
 */
export function pageMatchesSource(row: Record<string, unknown>, sourceText: string): boolean {
  const slug = String(row.author_url ?? "").replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop()?.toLowerCase() ?? "";
  const latin = /^[a-z0-9._-]+$/i.test(sourceText.trim().replace(/^@/, ""));
  if (latin) return slug !== "" && slug === sourceText.trim().replace(/^@/, "").toLowerCase();
  const wanted = nameWordsOf(sourceText);
  if (wanted.length === 0) return false;
  const have = nameWordsOf(String(row.author ?? ""));
  // THE PAGE IS CHOSEN BY ITS NAME, word for word (live round 10: «العربية» is inside «المملكة العربية السعودية ...» and «صباح العربية», which are not «قناة العربية»). The Latin part of a page's name («Al Arabiya») is left out of the reading.
  // A source written with no Arabic letters («Sky News») is read the old way: every word is inside the author's name.
  if (!ARABIC.test(sourceText)) { const name = norm(String(row.author ?? "")); return name !== "" && wanted.every((w) => name.includes(w)); }
  return have.length === wanted.length && have.every((w, i) => w === wanted[i]);
}
/** The words of a page's name, without the words that only say what kind of source it is, without «ال», and (for a name with an Arabic part) only its Arabic words. */
function nameWordsOf(name: string): string[] {
  const words = norm(name).split(/[\s\-–—|:،,]+/).filter((w) => w !== "" && !SOURCE_KIND_WORDS.has(w));
  const arabic = words.filter((w) => ARABIC.test(w));
  return (arabic.length > 0 ? arabic : words).map(stripAl).filter((w) => w.length > 1);
}

/** What a row meets of the Ask (each fact true when the Ask does not ask it). `bySource`: the pool was read FROM the named source (an account listing, a channel's own videos), so every row is the source's by construction. */
export function factsOf(row: Record<string, unknown>, ask: Ask, bySource = false): RowFacts {
  const text = String(row.text ?? "");
  const handle = (v: unknown): string => norm(String(v ?? "").replace(/^@/, ""));
  const named = ask.source.kind !== "named" || ask.source.text === null || bySource || [row.username, row.author].some((v) => handle(v) !== "" && handle(v) === handle(ask.source.text)) || (ask.platform === "facebook" && pageMatchesSource(row, ask.source.text));
  const wantCountry = ask.country === null ? null : [ask.country, COUNTRY_AR[ask.country]].filter(Boolean).map((x) => norm(String(x)));
  const country = wantCountry === null || (typeof row.country === "string" && wantCountry.includes(norm(row.country)));
  const lang = typeof row.language === "string" && row.language !== "" ? row.language.toLowerCase() : null;
  const language = ask.language === null || (lang !== null ? lang.startsWith(ask.language) : ask.language === "ar" ? ARABIC.test(text) : !ARABIC.test(text));
  const topicTier = topicTierOf(text, ask);
  return { named, country, language, topic: topicTier > 0, topicTier };
}

const counterOf = (row: Record<string, unknown>, card: ToolCard): number | null => {
  if (!card.counter) return null;
  const n = Number(row[card.counter.key]);
  return Number.isFinite(n) ? n : null;
};
const timeOf = (row: Record<string, unknown>): number => { const t = Date.parse(String(row.posted_at ?? "")); return Number.isFinite(t) ? t : 0; };

/** The rows of the same occurrence of a recurring event: published within this long before the newest row that talks about the topic. */
const OCCURRENCE_WINDOW_MS = 300 * 86_400_000;

/**
 * Every distinct row of the pool, ranked in the owner's order. `occurrence` (decision 7, a recurring event): «latest» ranks, among the rows that talk about the topic, those of the newest occurrence (published within 300 days of the newest such row) first; «all» and a year change nothing here
 * (a year is the Ask's period). Ranking only: no row is removed.
 */
export function rankPool(rows: ReadonlyArray<Record<string, unknown>>, ask: Ask, card: ToolCard, options: { occurrence?: Occurrence | null } = {}): PoolRow[] {
  const seen = new Set<string>();
  const unique: Array<{ row: PoolRow; at: number }> = [];
  rows.forEach((r, at) => {
    const id = String(r.id ?? "");
    if (id === "" || seen.has(id)) return;
    seen.add(id);
    unique.push({ row: { ...r, id } as PoolRow, at });
  });
  const latest = options.occurrence?.kind === "latest"
    ? unique.reduce((m, x) => (factsOf(x.row, ask, Boolean(card.inputs.source)).topicTier === 2 && timeOf(x.row) > m ? timeOf(x.row) : m), 0)
    : 0;
  const key = (x: { row: PoolRow }): number[] => {
    const f = factsOf(x.row, ask, Boolean(card.inputs.source));
    const order = ask.order === "newest" ? timeOf(x.row) : counterOf(x.row, card) ?? -1;
    // PARENTS OF A REPLIES STAGE ARE ORIGINALS (live D5): when the customer asked for the replies too, a tweet that is itself a reply to someone ranks below every original (ranking only: it is still in the pool and keeps its mark)
    const original = ask.replies !== "none" && x.row.is_reply === true ? 0 : 1;
    const band = latest > 0 && timeOf(x.row) >= latest - OCCURRENCE_WINDOW_MS ? 1 : 0;
    // outside the latest occurrence the newer comes first (the next-latest occurrence before the oldest), then the owner's counter
    return [f.named ? 1 : 0, original, (f.country ? 1 : 0) + (f.language ? 1 : 0), f.topicTier, ...(latest > 0 ? [band, band === 1 ? 0 : timeOf(x.row)] : []), order];
  };
  return unique
    .map((x) => ({ ...x, k: key(x) }))
    .sort((a, b) => { for (let i = 0; i < a.k.length; i += 1) if (a.k[i] !== b.k[i]) return b.k[i] - a.k[i]; return a.at - b.at; })
    .map((x) => x.row);
}

/**
 * A ROW THE PLAN CAN CHOOSE AS «ABOUT THE TOPIC» (live round 7): its own text is about the topic AND it meets the named source, the country and the language the customer asked, because the owner's order ranks those before the topic (the only video about the topic on the
 * real round-7 page was Saudi, for a customer who asked for Egypt: it can never be chosen over an Egyptian video, so it is not an answer). Ranking facts only; nothing is removed.
 */
export function isAboutAndEligible(row: Record<string, unknown>, ask: Ask): boolean {
  const f = factsOf(row, ask);
  return f.topicTier === 2 && f.named && f.country && f.language;
}
