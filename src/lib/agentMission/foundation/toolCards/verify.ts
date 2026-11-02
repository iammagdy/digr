import { mapPage } from "./mapCode";
import type { ToolCard } from "./types";

const at = (o: unknown, path: ReadonlyArray<string>): unknown => {
  let v: unknown = o;
  for (const k of path) { if (v === null || v === undefined || typeof v !== "object") return undefined; v = (v as Record<string, unknown>)[k]; }
  return v;
};

export interface CardCheck { rows: Array<Record<string, unknown>>; listed: number; issues: string[] }

/**
 * F2, A CARD IS VERIFIED ON A REAL PAGE: its mapping gives one row per listed item, every row with an id; its counter is a number on the rows when the card says it has one;
 * its next-page field is where the card says (a value, or the page says it is the last). The issues name the rule, never a value of the page.
 */
export function checkCardOnPage(card: ToolCard, page: unknown): CardCheck {
  const issues: string[] = [];
  const list = at(page, card.page.list);
  const listed = Array.isArray(list) ? list.length : -1;
  if (listed < 0) issues.push("no list at the card's path");
  const rows = mapPage(card, page);
  if (listed >= 0 && rows.length !== listed) issues.push(`${rows.length} rows mapped from ${listed} listed items`);
  if (rows.some((r) => typeof r.id !== "string" || r.id === "")) issues.push("a row without an id");
  if (card.counter && rows.length > 0 && !rows.some((r) => typeof r[card.counter!.key] === "number")) issues.push(`no row carries the counter «${card.counter.key}» as a number`);
  if (card.page.cursor && rows.length > 0) {
    const cursor = at(page, card.page.cursor);
    if (cursor === undefined) issues.push("the next-page field is missing at the card's path");
  }
  return { rows, listed, issues };
}
