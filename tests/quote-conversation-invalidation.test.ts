import { createAndSaveManagedQuote, PlanState } from "../src/functions/shared/planManager";
import { Capability } from "../src/functions/shared/capabilityRegistry";
import { describe, expect, it, vi } from "vitest";

describe("Supabase quote invalidation scope", () => {
  it("invalidates quotes only within the conversation being edited", async () => {
    const messageFilters: Array<[string, unknown]> = [];
    const quoteFilters: Array<[string, unknown]> = [];
    const invalidatedIds: string[][] = [];
    const inserted: any[] = [];
    const messageQuery: any = {
      select: vi.fn(() => messageQuery),
      eq: vi.fn((field: string, value: unknown) => {
        messageFilters.push([field, value]);
        return messageQuery;
      }),
      not: vi.fn(() => messageQuery),
      order: vi.fn(() => messageQuery),
      limit: vi.fn(async () => ({ data: [{ quote: { quoteId: "quote-current-conversation" } }], error: null })),
    };
    const quoteUpdate: any = {
      eq: vi.fn((field: string, value: unknown) => {
        quoteFilters.push([field, value]);
        return quoteUpdate;
      }),
      in: vi.fn((field: string, ids: string[]) => {
        expect(field).toBe("id");
        invalidatedIds.push(ids);
        return quoteUpdate;
      }),
      then: (resolve: (value: { error: null }) => unknown) => resolve({ error: null }),
    };
    const supabase = {
      from: vi.fn((table: string) => table === "messages"
        ? messageQuery
        : {
            update: vi.fn(() => quoteUpdate),
            insert: vi.fn(async (row: any) => {
              inserted.push(row);
              return { data: row, error: null };
            }),
          }),
    };
    const capability: Capability = {
      slug: "company-search",
      category: "company",
      nameAr: "بحث الشركات",
      nameEn: "Company Search",
      descriptionAr: "بحث الشركات",
      paramsSchema: "{}",
      tregEndpointId: "company.search",
      tregMethod: "GET",
      pricingUnit: "item",
      unitCostUsd: 0.001,
      maxRows: 1000,
      paginationType: "none",
      enabled: true,
    };
    const plan: PlanState = {
      summaryAr: "بحث شركات",
      items: [{ capabilitySlug: capability.slug, params: {}, targetVolumeMin: 1, targetVolumeMax: 10 }],
      outputFormats: ["xlsx"],
    };

    await createAndSaveManagedQuote(supabase as any, {
      conversationId: "conversation-current",
      userId: "user-current",
      plan,
      userBalance: 500,
      capabilities: [capability],
    });

    expect(messageFilters).toEqual(expect.arrayContaining([
      ["user_id", "user-current"],
      ["conversation_id", "conversation-current"],
    ]));
    expect(invalidatedIds).toEqual([["quote-current-conversation"]]);
    expect(quoteFilters).toEqual(expect.arrayContaining([
      ["user_id", "user-current"],
      ["status", "quoted"],
    ]));
    expect(inserted[0]).toMatchObject({
      user_id: "user-current",
      status: "quoted",
    });
  });
});
