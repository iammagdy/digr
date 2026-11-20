import { DECLARED_PRICE_CORRECTIONS } from "../treg/catalog";
import { CATALOG_PRICE_REV } from "../treg/priceRev";
import type { PricedPlan } from "./plan";

/**
 * AN UNAPPROVED CARD QUOTED ON A STORED PRICE THAT WAS WRONG (DT-20261119-11 D7). A plan keeps the price it was quoted with; a card built before a catalog price correction and not yet approved would be approved at the old (too low) price. The price of every plan carries
 * the catalog price revision it was made under (`price.pricedUnder`): a plan made under an older revision (or before the revision existed) that reads a corrected endpoint is refused at approval with `plan_changed`, before anything is reserved or charged, and the
 * customer asks again for a fresh price. A regenerated card carries the current revision, so it is never refused. Jobs already approved keep their total: they never go through approval again.
 */
export function planNeedsRequote(plan: Pick<PricedPlan, "stages" | "price">): boolean {
  if ((plan.price?.pricedUnder ?? 0) >= CATALOG_PRICE_REV) return false;
  const corrected = new Set(DECLARED_PRICE_CORRECTIONS.map((c) => c.id));
  return plan.stages.some((st) => [st.endpoint_id, st.engine?.endpoint_id, ...(st.engine?.alternatives ?? []).map((a) => a.endpoint_id)].some((id) => typeof id === "string" && corrected.has(id)));
}
