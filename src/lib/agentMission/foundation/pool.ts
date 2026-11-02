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

export interface RowFacts { named: boolean; country: boolean; language: boolean; topic: boolean }

/** What a row meets of the Ask (each fact true when the Ask does not ask it). */
export function factsOf(row: Record<string, unknown>, ask: Ask): RowFacts {
  const text = String(row.text ?? "");
  const handle = (v: unknown): string => norm(String(v ?? "").replace(/^@/, ""));
  const named = ask.source.kind !== "named" || ask.source.text === null || [row.username, row.author].some((v) => handle(v) !== "" && handle(v) === handle(ask.source.text));
  const wantCountry = ask.country === null ? null : [ask.country, COUNTRY_AR[ask.country]].filter(Boolean).map((x) => norm(String(x)));
  const country = wantCountry === null || (typeof row.country === "string" && wantCountry.includes(norm(row.country)));
  const lang = typeof row.language === "string" && row.language !== "" ? row.language.toLowerCase() : null;
  const language = ask.language === null || (lang !== null ? lang.startsWith(ask.language) : ask.language === "ar" ? ARABIC.test(text) : !ARABIC.test(text));
  const words = ask.topic.text ? norm(ask.topic.text).split(/\s+/).map((w) => w.replace(/^ال/, "")).filter((w) => w.length > 1) : [];
  const topic = words.length === 0 || words.every((w) => norm(text).includes(w));
  return { named, country, language, topic };
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
    return [f.named ? 1 : 0, (f.country ? 1 : 0) + (f.language ? 1 : 0), f.topic ? 1 : 0, order];
  };
  return unique
    .map((x) => ({ ...x, k: key(x) }))
    .sort((a, b) => { for (let i = 0; i < a.k.length; i += 1) if (a.k[i] !== b.k[i]) return b.k[i] - a.k[i]; return a.at - b.at; })
    .map((x) => x.row);
}
