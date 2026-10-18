import { proposeVolumePricing } from "../../src/lib/volumePricing";

/** Provider cost (USD per record) and the unit price (points) of the social services, read-only from the live registry on 2026-10-18. */
export const LIVE_SOCIAL_SERVICES = [
  { slug: "social-tiktok-comments", providerCostUsd: 0.001, currentUnitPoints: 6 },
  { slug: "social-tiktok-videos", providerCostUsd: 0.001, currentUnitPoints: 6 },
  { slug: "social-youtube-comments", providerCostUsd: 0.0009, currentUnitPoints: 9 },
  { slug: "social-youtube-videos", providerCostUsd: 0.0009, currentUnitPoints: 5 },
  { slug: "social-facebook-comments", providerCostUsd: 0.00188, currentUnitPoints: 11 },
  { slug: "social-facebook-posts", providerCostUsd: 0.002, currentUnitPoints: 11 },
];

export const proposalRowsFromLive = () => proposeVolumePricing(LIVE_SOCIAL_SERVICES);
