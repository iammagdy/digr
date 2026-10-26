import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/functions/shared/catalogClient")>();
  return {
    ...actual,
    getEndpointDetails: vi.fn(async (endpointId: string) => {
      const prices: Record<string, number> = {
        "treg.people.search": 0.015,
        "treg.people.email.find": 0.01,
        "treg.people.phone.find": 0.01,
      };
      const catalogPriceUsd = prices[endpointId];
      return catalogPriceUsd ? { catalogPriceUsd } : null;
    }),
  };
});

import { createAndSaveManagedQuote } from "../src/functions/shared/planManager";
import { DEFAULT_PRICING_SETTINGS } from "../src/functions/shared/quotes";
import { setProviderBalanceForTesting, resetProviderBalanceCacheForTesting } from "../src/functions/shared/providerSpend";

function makeQuoteClient(rpc: (name: string, args: any) => Promise<any>) {
  const insertedQuotes: any[] = [];
  const client = {
    insertedQuotes,
    rpc: vi.fn(rpc),
    from: vi.fn((table: string) => {
      if (table === "messages") {
        const query: any = {
          select: () => query,
          eq: () => query,
          not: () => query,
          order: () => query,
          limit: async () => ({ data: [], error: null }),
        };
        return query;
      }
      if (table === "plans_quotes") {
        return { insert: async (row: any) => { insertedQuotes.push(row); return { data: row, error: null }; } };
      }
      return { select: () => ({ eq: async () => ({ data: null, error: null }) }) };
    }),
  };
  return client;
}

const peopleCapability: any = {
  slug: "professional-people-search",
  category: "people",
  nameAr: "بحث وإثراء بيانات المهنيين",
  nameEn: "People Search and Contact Enrichment",
  descriptionAr: "بحث مهني",
  paramsSchema: JSON.stringify({ type: "object" }),
  tregEndpointId: "treg.people.search",
  tregMethod: "POST",
  pricingUnit: "item",
  unitCostUsd: 0.015,
  maxRows: 500,
  paginationType: "none",
  enabled: true,
};

import { decisionMakerChargePoints, decisionMakerQuotePoints, DECISION_MAKER_UNIT_PRICES_POINTS } from "../src/functions/shared/decisionMakerPricing";
import { JOB_MAX_POINTS_CAP } from "../src/lib/jobPointsCap";

/**
 * Decision makers at the REAL job cap of 25,000 points (the suites lower it to 600 by the environment, so it is cleared here). At 258 points a person
 * the buffered reserve (x 1.15) reaches the cap at about 96 people: a request for more is held at the cap, never above it, for fewer people than asked.
 */
describe("decision makers at the real job cap of 25,000 points", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  beforeEach(() => {
    vi.stubEnv("JOB_MAX_POINTS_CAP", "");
    resetProviderBalanceCacheForTesting();
    setProviderBalanceForTesting(1000);
  });

  const ask = (people: number) => {
    const client = makeQuoteClient(async (name, args) => name === "settle_people_job_atomic"
      ? { data: null, error: { code: "P0001", message: `Job ${args.p_job_id} not found` } }
      : { data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    return createAndSaveManagedQuote(client as any, {
      conversationId: `offline-people-${people}`,
      userId: "offline-test-user",
      plan: {
        summaryAr: "صناع قرار في مصر",
        items: [{
          capabilitySlug: "professional-people-search",
          endpointId: "treg.people.search",
          params: { requiredContactFields: ["work_email", "phone"], country: "EG" },
          targetVolumeMin: 1,
          targetVolumeMax: people,
        }],
        outputFormats: ["xlsx"],
      },
      userBalance: 100000,
      capabilities: [peopleCapability],
      pricingSettings: DEFAULT_PRICING_SETTINGS,
    }).then((quote) => ({ quote, client }));
  };

  it("the cap constant is 25,000 and the arithmetic: 96 people reserve 28,484 buffered, so the cap clips the reserve; 96 is the most whose CHARGE (24,768) fits", () => {
    expect(JOB_MAX_POINTS_CAP).toBe(25_000);
    const prices = DECISION_MAKER_UNIT_PRICES_POINTS;
    expect(Math.ceil(96 * 258 * 1.15)).toBe(28_484);
    expect(decisionMakerQuotePoints(96, ["work_email", "phone"], prices, 0.15, 25_000)).toBe(25_000);
    expect(decisionMakerQuotePoints(3, ["work_email", "phone"], prices, 0.15, 25_000)).toBe(891);
    expect(97 * 258).toBeGreaterThan(25_000);
    expect(96 * 258).toBeLessThanOrEqual(25_000);
    // the charge of every delivered unit is capped at the reserve (and so at 25,000)
    expect(decisionMakerChargePoints({ baseUnits: 96, emailUnits: 96, phoneUnits: 96 }, prices, 25_000)).toBe(24_768);
    expect(decisionMakerChargePoints({ baseUnits: 120, emailUnits: 120, phoneUnits: 120 }, prices, 25_000)).toBe(25_000);
  });

  it("a request for 200 people is held at the cap: the reserve is never above 25,000, the plan states fewer people than asked, and the charge of a full delivery is never above the reserve", async () => {
    const { quote, client } = await ask(200);
    expect(quote.items[0].unitPricePoints).toBe(258);
    expect(quote.targetVolumeMax).toBeLessThan(200);
    expect(quote.items[0].targetVolumeMax).toBeLessThan(200);
    expect(quote.targetVolumeMax).toBe(96);
    expect(quote.quotedPoints).toBeLessThanOrEqual(25_000);
    expect(quote.quotedPoints).toBe(25_000);
    expect(client.insertedQuotes[0].total_reserved_credits).toBeLessThanOrEqual(25_000);
    expect(quote.expectedPoints).toBe(96 * 258);
    expect(quote.expectedPoints).toBeLessThanOrEqual(quote.quotedPoints);
    // everything the plan stated delivered, with both fields: the settlement charge is ceil(per-field sums), clipped by the reserve
    const n = quote.targetVolumeMax;
    const charge = decisionMakerChargePoints({ baseUnits: n, emailUnits: n, phoneUnits: n }, DECISION_MAKER_UNIT_PRICES_POINTS, 25_000);
    expect(charge).toBeLessThanOrEqual(quote.quotedPoints);
    expect(charge).toBe(n * 258);
  });

  it("a request inside the cap is not cut: 3 people hold 891, 90 people hold ceil(90 x 258 x 1.15) = 26,703 clipped to 25,000 while 80 hold 23,736 whole", async () => {
    const three = (await ask(3)).quote;
    expect([three.targetVolumeMax, three.quotedPoints, three.expectedPoints]).toEqual([3, 891, 774]);
    const eighty = (await ask(80)).quote;
    expect([eighty.targetVolumeMax, eighty.quotedPoints]).toEqual([80, Math.ceil(80 * 258 * 1.15)]);
    expect(eighty.quotedPoints).toBe(23_736);
    const ninety = (await ask(90)).quote;
    expect(ninety.targetVolumeMax).toBe(90);
    expect(ninety.quotedPoints).toBe(25_000);
    expect(ninety.quotedPoints).toBeLessThanOrEqual(25_000);
  });
});
