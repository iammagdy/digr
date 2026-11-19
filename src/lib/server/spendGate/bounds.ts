import { CONTEXTDEV_USD_PER_CREDIT, FIRECRAWL_USD_PER_CREDIT } from "../../multiProvider/catalog";

/**
 * ROUND 61, HARD SPEND GATE (docs/proposals/spend-gate/SPEC-v2.md §3): what ONE provider call may cost AT MOST, never what it is expected to cost.
 *
 * A reservation is only a ceiling if it is an upper bound the provider itself cannot pass. Each rule below names the documented reason the bound holds;
 * an operation with no such reason has NO bound and the gate refuses it (`no_safe_bound`). Pure: no network, no secret, no database.
 *
 * Today's estimates (agent/src/gateway.ts, agent/src/webGateway.ts) are NOT bounds in four places, measured on the code at adb22f8:
 *  1. TREG: the route cap sent to TREG is max(estimate, 0.001) while the budget reserves the estimate: for an estimate under 0.001 the provider may take more than was reserved.
 *  2. Web search: `usdPerCall * (limit / 10)` reserves 1.5 blocks for limit 15; the providers bill whole blocks of ten results (2 blocks).
 *  3. Firecrawl scrape: sent with `proxy: "auto"`, which may retry through the stealth proxy (5 credits); the budget reserves 1 credit.
 *  4. Context.dev prebuilt parsers (maps, social, app stores, g2): the documentation states no credit cost for them (src/lib/agentMission/sources.ts); 1 credit is a guess.
 * The bounds below fix 1 to 3 and refuse 4.
 */

export type Bound = { ok: true; usd: number; basis: string } | { ok: false; reason: "no_safe_bound"; detail: string };

/** Micro-dollars, rounded UP (as the SQL does): a bound is never stored below what it bounds. The tiny epsilon absorbs binary noise (0.00254 x 2 = 0.0050800000000001). */
export const ceilMicroUsd = (usd: number) => Math.ceil(usd * 1_000_000 - 1e-6) / 1_000_000;
const ok = (usd: number, basis: string): Bound => ({ ok: true, usd: ceilMicroUsd(usd), basis });
const no = (detail: string): Bound => ({ ok: false, reason: "no_safe_bound", detail });

/** Context.dev, documented credits (docs.context.dev credits page, read 2026-10-28): a plain scrape 1 (2 with browser actions); people search 10 per page fast, 50 ultra; web search 1 per 10 results. */
export const CONTEXTDEV_BOUND_CREDITS = { scrape: 1, scrapeWithActions: 2, peopleSearchFast: 10, peopleSearchUltra: 50, searchPerTenResults: 1 } as const;
/** Firecrawl, documented credits: scrape 1, +4 through the stealth proxy (5), +4 for JSON extraction; search 2 per 10 results. */
export const FIRECRAWL_BOUND_CREDITS = { scrapeBasic: 1, scrapeStealth: 5, jsonExtraction: 4, searchPerTenResults: 2 } as const;
/** The largest single operation the gate accepts at all (an owner value in the grant may be lower; this is the code's own outer limit). */
export const MAX_SINGLE_OPERATION_USD = 1;

export type ProviderOp =
  | { provider: "contextdev"; op: "scrape"; browserActions?: boolean }
  | { provider: "contextdev"; op: "search"; limit: number }
  | { provider: "contextdev"; op: "people_search"; mode?: "fast" | "ultra" }
  | { provider: "contextdev"; op: "parser"; parser: string }
  | { provider: "firecrawl"; op: "scrape"; proxy?: string; json?: boolean }
  | { provider: "firecrawl"; op: "search"; limit: number; scrapesResults?: boolean }
  | { provider: "treg"; op: "call"; boundUsd: number | null; attempts?: number }
  | { provider: string; op: string };

const blocksOfTen = (limit: number) => Math.max(1, Math.ceil(Math.max(1, Math.floor(Number(limit) || 0)) / 10));

export function providerCallBound(input: ProviderOp): Bound {
  const b = boundOf(input);
  if (b.ok && !(b.usd > 0 && b.usd <= MAX_SINGLE_OPERATION_USD)) return no(`a bound of ${b.usd} USD is outside (0, ${MAX_SINGLE_OPERATION_USD}]`);
  return b;
}

type LooseOp = { provider: string; op: string; [k: string]: unknown };

function boundOf(input: ProviderOp): Bound {
  if (input.provider === "contextdev") {
    const i = input as LooseOp;
    if (i.op === "scrape") return ok((i.browserActions === true ? CONTEXTDEV_BOUND_CREDITS.scrapeWithActions : CONTEXTDEV_BOUND_CREDITS.scrape) * CONTEXTDEV_USD_PER_CREDIT, "contextdev documented scrape credits");
    if (i.op === "search") {
      const limit = Number(i.limit);
      if (!(Number(limit) >= 1 && Number(limit) <= 100)) return no("a web search needs a limit between 1 and 100");
      return ok(blocksOfTen(limit) * CONTEXTDEV_BOUND_CREDITS.searchPerTenResults * CONTEXTDEV_USD_PER_CREDIT, "contextdev search, whole blocks of ten results");
    }
    if (i.op === "people_search") {
      const mode = i.mode === undefined ? "fast" : String(i.mode);
      if (mode !== "fast" && mode !== "ultra") return no(`people search mode ${String(mode)} has no documented credit cost`);
      return ok((mode === "ultra" ? CONTEXTDEV_BOUND_CREDITS.peopleSearchUltra : CONTEXTDEV_BOUND_CREDITS.peopleSearchFast) * CONTEXTDEV_USD_PER_CREDIT, `contextdev people search ${mode}, one page`);
    }
    if (i.op === "parser") return no(`the Context.dev parser ${String(i.parser)} has no documented credit cost`);
    return no(`unknown Context.dev operation ${String(i.op)}`);
  }
  if (input.provider === "firecrawl") {
    const i = input as LooseOp;
    if (i.op === "scrape") {
      const s = { proxy: typeof i.proxy === "string" ? i.proxy : undefined, json: i.json === true };
      // only an explicit basic proxy stays at 1 credit: "auto" may escalate to stealth, and an absent field is the provider's default
      const base = s.proxy === "basic" ? FIRECRAWL_BOUND_CREDITS.scrapeBasic : FIRECRAWL_BOUND_CREDITS.scrapeStealth;
      return ok((base + (s.json ? FIRECRAWL_BOUND_CREDITS.jsonExtraction : 0)) * FIRECRAWL_USD_PER_CREDIT, `firecrawl scrape, proxy ${s.proxy ?? "default"}${s.json ? " + json" : ""}`);
    }
    if (i.op === "search") {
      const s = { limit: Number(i.limit), scrapesResults: i.scrapesResults === true };
      if (s.scrapesResults) return no("a Firecrawl search that also scrapes its results is billed per result page: not bounded here");
      if (!(Number(s.limit) >= 1 && Number(s.limit) <= 100)) return no("a web search needs a limit between 1 and 100");
      return ok(blocksOfTen(s.limit) * FIRECRAWL_BOUND_CREDITS.searchPerTenResults * FIRECRAWL_USD_PER_CREDIT, "firecrawl search, whole blocks of ten results");
    }
    return no(`unknown Firecrawl operation ${String(i.op)}`);
  }
  if (input.provider === "treg") {
    // The bound IS the amount the call may cost: it is sent to TREG as `X-Treg-Route-Max-Cost` (TREG refuses above it before billing) and reserved on every ledger (DT-20261119-11): the header and the reservation are the same number.
    const cap = (input as { boundUsd: number | null }).boundUsd;
    if (cap === null || !Number.isFinite(cap) || cap <= 0) return no("a TREG call without a positive amount it may cost has no ceiling");
    // CAMPAIGN SCOPE: every attempt (the call and each key-pool hop) may be billed up to the bound, so the reservation is the bound times the attempts the call can make
    const attempts = (input as { attempts?: number }).attempts;
    if (attempts !== undefined && !(Number.isInteger(attempts) && attempts >= 1 && attempts <= 8)) return no("a TREG call's attempt count is not a whole number from 1 to 8");
    return ok(cap * (attempts ?? 1), attempts && attempts > 1 ? `treg call bound (the header sent) x ${attempts} attempts` : "treg call bound (the header sent)");
  }
  return no(`unknown provider ${String(input.provider)}`);
}

/**
 * The ESTIMATED bound of one TREG call: the catalog estimate rounded UP to the micro-dollar, floored at 0.001. It is the smallest amount a call is admitted with (DT-20261119-11 D5: it is no longer what is sent; the header is the money
 * that is really left). Kept as a pure function so the quote and the tests can name it.
 */
export function tregCallBoundUsd(estimateUsd: number): number {
  return ceilToMicroUsd(Math.max(Number(estimateUsd) || 0, 0.001));
}

/**
 * A USD amount rounded UP to the micro-dollar (DT-20261119-09, F1). TREG compares its reserve, in whole micro-USD, with `X-Treg-Route-Max-Cost`: a cap rounded DOWN (`toFixed(6)` turned aiark.people.search's price 0.0026335 into
 * 0.002633) is one micro-dollar under the price and TREG refuses the call (402 `route_max_cost`) every time. Float noise is not a fraction of a micro-dollar (0.000495 x 10 is 4950.000000000001 micro): a price that is exact to the micro stays exactly as it is.
 */
export function ceilToMicroUsd(usd: number): number {
  const micro = Number(usd) * 1_000_000;
  if (!Number.isFinite(micro)) return 0;
  const nearest = Math.round(micro);
  const whole = Math.abs(micro - nearest) < 1e-6 ? nearest : Math.ceil(micro);
  return Number((whole / 1_000_000).toFixed(6));
}
