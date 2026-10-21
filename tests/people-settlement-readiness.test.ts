import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { hasPeopleSettlementRpc, PEOPLE_SETTLEMENT_UNAVAILABLE_AR } from "../src/functions/shared/peopleSettlementReadiness";

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

describe("decision-maker settlement readiness", () => {
  beforeEach(() => {
    resetProviderBalanceCacheForTesting();
    setProviderBalanceForTesting(10);
  });

  it("treats the exact missing-function response as unavailable and probes without a real job", async () => {
    const client = {
      rpc: vi.fn(async (_name: string, args: any) => ({
        data: null,
        error: { code: "PGRST202", message: "Could not find the function" },
      })),
    };
    expect(await hasPeopleSettlementRpc(client)).toBe(false);
    expect(client.rpc).toHaveBeenCalledWith("settle_people_job_atomic", expect.objectContaining({
      p_base_units: 0,
      p_email_units: 0,
      p_phone_units: 0,
    }));
    expect(client.rpc.mock.calls[0][1].p_job_id).toMatch(/^__diger_people_settlement_probe_/);
  });

  it("builds the live quote item paths from an offline catalog fixture when settlement exists", async () => {
    const client = makeQuoteClient(async (name, args) => name === "settle_people_job_atomic"
      ? { data: null, error: { code: "P0001", message: `Job ${args.p_job_id} not found` } }
      : { data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const quote = await createAndSaveManagedQuote(client as any, {
      conversationId: "offline-people-conversation",
      userId: "offline-test-user",
      plan: {
        summaryAr: "بحث عن صناع القرار",
        items: [{
          capabilitySlug: "professional-people-search",
          endpointId: "treg.people.search",
          params: { requiredContactFields: ["work_email", "phone"], country: "Egypt", title: "مدير" },
          targetVolumeMin: 1,
          targetVolumeMax: 1,
        }],
        outputFormats: ["xlsx"],
      },
      userBalance: 1000,
      capabilities: [peopleCapability],
      pricingSettings: DEFAULT_PRICING_SETTINGS,
    });

    const item = quote.items[0] as any;
    expect(item.params.requiredContactFields).toEqual(["work_email", "phone"]);
    expect(item.contactUnitPricesPoints).toEqual({ basePerson: 83, workEmail: 55, phone: 55 });
    expect(client.insertedQuotes[0].items[0]).toEqual(item);
    if (process.env.PRINT_DECISION_MAKER_FIXTURE === "1") {
      console.log("OFFLINE_DECISION_MAKER_QUOTE_ITEM=" + JSON.stringify(item));
    }
  });

  it("prices three people at 579 points and holds 666 (the 5,000-point cap does not clip it)", async () => {
    const client = makeQuoteClient(async (name, args) => name === "settle_people_job_atomic"
      ? { data: null, error: { code: "P0001", message: `Job ${args.p_job_id} not found` } }
      : { data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const quote = await createAndSaveManagedQuote(client as any, {
      conversationId: "offline-three-people",
      userId: "offline-test-user",
      plan: {
        summaryAr: "ثلاثة صناع قرار في مصر",
        items: [{
          capabilitySlug: "professional-people-search",
          endpointId: "treg.people.search",
          params: { requiredContactFields: ["work_email", "phone"], country: "EG" },
          targetVolumeMin: 3,
          targetVolumeMax: 3,
        }],
        outputFormats: ["xlsx"],
      },
      userBalance: 1000,
      capabilities: [peopleCapability],
      pricingSettings: DEFAULT_PRICING_SETTINGS,
    });
    expect((quote.items[0] as any).contactUnitPricesPoints).toEqual({ basePerson: 83, workEmail: 55, phone: 55 });
    expect(quote.items[0].unitPricePoints).toBe(193);
    expect(quote.expectedPoints).toBe(579);
    expect(quote.targetVolumeMax).toBe(3);
    // 579 x 1.15 = 665.85 -> 666 held; the 5,000-point cap does not clip it (it clipped to 600 before)
    expect(quote.quotedPoints).toBe(666);
    expect(quote.pointsCapConstrained).toBe(false);
    expect(client.insertedQuotes[0].total_reserved_credits).toBe(666);
  });

  it("26 people are 5,018 points of charge: the plan is cut to 25 people (4,825 points) and only the buffered reserve is capped at 5,000", async () => {
    const client = makeQuoteClient(async (name, args) => name === "settle_people_job_atomic"
      ? { data: null, error: { code: "P0001", message: `Job ${args.p_job_id} not found` } }
      : { data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const quote = await createAndSaveManagedQuote(client as any, {
      conversationId: "offline-twenty-six-people",
      userId: "offline-test-user",
      plan: {
        summaryAr: "ثلاثة صناع قرار في مصر",
        items: [{
          capabilitySlug: "professional-people-search",
          endpointId: "treg.people.search",
          params: { requiredContactFields: ["work_email", "phone"], country: "EG" },
          targetVolumeMin: 26,
          targetVolumeMax: 26,
        }],
        outputFormats: ["xlsx"],
      },
      userBalance: 10000,
      capabilities: [peopleCapability],
      pricingSettings: DEFAULT_PRICING_SETTINGS,
    });
    expect((quote.items[0] as any).contactUnitPricesPoints).toEqual({ basePerson: 83, workEmail: 55, phone: 55 });
    expect(quote.items[0].unitPricePoints).toBe(193);
    // the charge is cut to the cap first (floor(5000 / 193) = 25 people = 4,825), then only the buffered reserve is clipped to the cap
    expect(quote.expectedPoints).toBe(4825);
    expect(quote.targetVolumeMax).toBe(25);
    expect(quote.quotedPoints).toBe(5000);
    expect(quote.pointsCapConstrained).toBe(true);
    expect(client.insertedQuotes[0].total_reserved_credits).toBe(5000);
  });

  it("refuses to create a decision-maker quote before field settlement is installed", async () => {
    const client = makeQuoteClient(async () => ({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    }));
    await expect(createAndSaveManagedQuote(client as any, {
      conversationId: "offline-unavailable-conversation",
      userId: "offline-test-user",
      plan: {
        summaryAr: "بحث عن صناع القرار",
        items: [{
          capabilitySlug: "professional-people-search",
          endpointId: "treg.people.search",
          params: { requiredContactFields: ["work_email", "phone"] },
          targetVolumeMin: 1,
          targetVolumeMax: 1,
        }],
        outputFormats: ["xlsx"],
      },
      userBalance: 1000,
      capabilities: [peopleCapability],
      pricingSettings: DEFAULT_PRICING_SETTINGS,
    })).rejects.toThrow(PEOPLE_SETTLEMENT_UNAVAILABLE_AR);
    expect(client.insertedQuotes).toHaveLength(0);
  });
});
