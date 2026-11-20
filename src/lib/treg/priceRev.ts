/**
 * The revision of the declared catalog price corrections (catalog.ts DECLARED_PRICE_CORRECTIONS). It lives alone because the price of a plan carries it (agentMission/price.ts) and that module must stay free of the catalog's file access.
 * Bump it when a correction is added or changed: a plan priced under an older revision that uses a corrected endpoint is re-quoted at approval (agentMission/lifecycle.ts).
 */
export const CATALOG_PRICE_REV = 1;
