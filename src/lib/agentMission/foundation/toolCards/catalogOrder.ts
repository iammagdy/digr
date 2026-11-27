import type { ToolCard } from "./types";

/**
 * THE ORDER AMONG SIBLING CARDS WHEN NOTHING ELSE DECIDES (D-0232 K3; UP1). `rankedCards` ranks by what each card carries, hand-verified before derived, pageable, counter, cheapest page. If two cards tie on ALL of that, the order was
 * the position in a file: a preference nobody wrote down. It is now a rule over the endpoints' own catalog facts, never a preferred key: tier (core before extended), then observed reliability (the higher ok rate first), then the
 * price per call ascending, then the endpoint id (a total order, so the result never depends on array position). The facts are the card's `catalog` copy (tests/wl4-up1-tool-cards.test.ts proves each copy equals the catalog entry).
 * A card with no copy ranks after one with a copy; two without a copy are left in their given order. Pure: no catalog read here (this module is imported by the browser bundle through the ask card).
 */
const TIER = (card: ToolCard): number => (card.catalog?.tier === "core" ? 0 : card.catalog?.tier === "extended" ? 1 : 2);
const RELIABILITY = (card: ToolCard): number => (typeof card.catalog?.okRate === "number" ? card.catalog.okRate : -1);
const PRICE = (card: ToolCard): number => (typeof card.catalog?.usd === "number" ? card.catalog.usd : Number.POSITIVE_INFINITY);

/** Negative: `a` comes first. */
export function catalogOrderOf(a: ToolCard, b: ToolCard): number {
  // two cards with no catalog copy (cards derived from the catalog at run time) keep the order they were given in: nothing here decides between them
  if (!a.catalog && !b.catalog) return 0;
  return TIER(a) - TIER(b) || RELIABILITY(b) - RELIABILITY(a) || PRICE(a) - PRICE(b) || (a.endpointId < b.endpointId ? -1 : a.endpointId > b.endpointId ? 1 : 0);
}
