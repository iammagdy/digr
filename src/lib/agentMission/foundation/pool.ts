import type { Ask } from "./ask";
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
  const words = ask.topic.text ? norm(ask.topic.text).split(/\s+/).map((w) => w.replace(/^ال/, "")).filter((w) => w.length > 1) : [];
  if (words.length === 0) return 2;
  const all = norm(text);
  if (!words.every((w) => all.includes(w))) return 0;
  const body = norm(withoutHashtags(text));
  if (words.every((w) => body.includes(w))) return 2;
  return ask.topic.relation === "made_with" ? 2 : 1;
}

/** What a row meets of the Ask (each fact true when the Ask does not ask it). */
export function factsOf(row: Record<string, unknown>, ask: Ask): RowFacts {
  const text = String(row.text ?? "");
  const handle = (v: unknown): string => norm(String(v ?? "").replace(/^@/, ""));
  const named = ask.source.kind !== "named" || ask.source.text === null || [row.username, row.author].some((v) => handle(v) !== "" && handle(v) === handle(ask.source.text));
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

/** Every distinct row of the pool, ranked in the owner's order. */
export function rankPool(rows: ReadonlyArray<Record<string, unknown>>, ask: Ask, card: ToolCard): PoolRow[] {
  const seen = new Set<string>();
  const unique: Array<{ row: PoolRow; at: number }> = [];
  rows.forEach((r, at) => {
    const id = String(r.id ?? "");
    if (id === "" || seen.has(id)) return;
    seen.add(id);
    unique.push({ row: { ...r, id } as PoolRow, at });
  });
  const key = (x: { row: PoolRow }): number[] => {
    const f = factsOf(x.row, ask);
    const order = ask.order === "newest" ? timeOf(x.row) : counterOf(x.row, card) ?? -1;
    // PARENTS OF A REPLIES STAGE ARE ORIGINALS (live D5): when the customer asked for the replies too, a tweet that is itself a reply to someone ranks below every original (ranking only: it is still in the pool and keeps its mark)
    const original = ask.replies !== "none" && x.row.is_reply === true ? 0 : 1;
    return [f.named ? 1 : 0, original, (f.country ? 1 : 0) + (f.language ? 1 : 0), f.topicTier, order];
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
