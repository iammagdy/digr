import { describe, expect, it, vi } from "vitest";
import { persistEditedQuoteMessage } from "../src/functions/shared/quoteMessagePersistence";

describe("edited quote persistence", () => {
  it("replaces the saved conversation quote so reloads show the new plan", async () => {
    const updates: Array<{ values: unknown; filters: Array<[string, unknown]> }> = [];
    const matchingMessage = {
      id: "message-1",
      quote: { quoteId: "old-quote" },
    };

    const readQuery: any = {
      select: vi.fn(() => readQuery),
      eq: vi.fn(() => readQuery),
      not: vi.fn(() => readQuery),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: [matchingMessage], error: null }),
    };
    const updateQuery: any = {
      filters: [] as Array<[string, unknown]>,
      eq: vi.fn((field: string, value: unknown) => {
        updateQuery.filters.push([field, value]);
        return updateQuery;
      }),
      then: (resolve: (value: unknown) => unknown) => {
        updates.push({ values: updateQuery.values, filters: [...updateQuery.filters] });
        return resolve({ error: null });
      },
    };
    const database = {
      from: vi.fn((table: string) => {
        expect(table).toBe("messages");
        return {
          ...readQuery,
          update: vi.fn((values: unknown) => {
            updateQuery.values = values;
            return updateQuery;
          }),
        };
      }),
    };
    const newQuote = {
      quoteId: "new-quote",
      targetVolumeMax: 50,
      quotedPoints: 173,
      items: [{ capabilitySlug: "company-search", params: { country: "Germany", industry: "FinTech" } }],
    };

    await persistEditedQuoteMessage(database as any, {
      conversationId: "conversation-1",
      userId: "user-1",
      previousQuoteId: "old-quote",
      quote: newQuote as any,
    });

    expect(updates).toEqual([{
      values: expect.objectContaining({
        quote: newQuote,
        content_ar: expect.stringContaining("50"),
      }),
      filters: expect.arrayContaining([
        ["id", "message-1"],
        ["conversation_id", "conversation-1"],
        ["user_id", "user-1"],
      ]),
    }]);
  });
});
