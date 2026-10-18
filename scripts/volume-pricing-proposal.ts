/**
 * Prints the proposed volume-pricing tiers with their arithmetic, from the provider costs and prices read from the live
 * registry (read-only SELECT on 2026-10-18). Makes no call and changes nothing. Run: npx tsx scripts/volume-pricing-proposal.ts
 */
import { LIVE_SOCIAL_SERVICES, proposalRowsFromLive } from "../tests/fixtures/liveSocialCosts";
import { VOLUME_PRICING_MARKUP_FLOOR, VOLUME_PRICING_TIERS } from "../src/lib/volumePricing";

console.log(`floor: never below provider cost x ${VOLUME_PRICING_MARKUP_FLOOR}; tiers: ${VOLUME_PRICING_TIERS.map((t) => `${t.minUnits}+ records at x${t.markup}`).join(", ")}; today: x10`);
for (const row of proposalRowsFromLive()) {
  const cost = row.costPoints;
  console.log(`${row.slug}: cost ${row.providerCostUsd} USD = ${cost} points/record; today ${row.currentUnitPoints} points; floor ${row.floorPoints}`);
  for (const t of row.tiers) console.log(`   ${t.minUnits}+ records: ceil(${cost} x ${t.markup}) = ${Math.ceil(cost * t.markup)} -> pays ${t.unitPoints} points (${t.discountPercent}% less than today)`);
}
console.log(`(${LIVE_SOCIAL_SERVICES.length} services)`);
