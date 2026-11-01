import { type MissionPricingSettings } from "../missionPricing";
import { priceMissionByCode } from "./price";
import { stagePriceInputs, type PricedPlan } from "./plan";

/**
 * THE FINAL PRICE OF THE CARD (S1 live findings fix 3, docs/S1-LIVE-FINDINGS.md section 4). The plan card is stored once, and what it shows is the FINAL price: the one pricing function over the plan's final stages, the admin minimum included. It is the same number
 * approval recomputes (`repriceStoredPlan`) and reserves, so a price or a count the customer saw cannot change by itself later. A stored price that disagrees is replaced by the final one, and the difference is returned so it can be recorded (counts only).
 * A plan stored before the one pricing rule (no `rule: 2` on its price) keeps the price it showed, as approval does. Pure.
 */
export interface PriceDrift { rowsBefore: number; rowsAfter: number; reserveBefore: number; reserveAfter: number }

/** `settings` are the pricing settings (markup, admin minimum) the worker read for this mission; the plan's own stored settings are used only when none are given. */
export function sealFinalPrice(plan: PricedPlan, settings?: MissionPricingSettings): { plan: PricedPlan; drift: PriceDrift | null } {
  if (plan.price.rule !== 2) return { plan, drift: null };
  const final = priceMissionByCode(stagePriceInputs(plan.stages, plan.contact_steps), { settings: settings ?? plan.price.settings });
  const same = final.unitPricePoints === plan.price.unitPricePoints && final.reservePoints === plan.price.reservePoints && final.deliveredRows === plan.price.deliveredRows && final.maxChargePoints === plan.price.maxChargePoints;
  if (same) return { plan, drift: null };
  return { plan: { ...plan, price: final }, drift: { rowsBefore: plan.price.deliveredRows, rowsAfter: final.deliveredRows, reserveBefore: plan.price.reservePoints, reserveAfter: final.reservePoints } };
}
