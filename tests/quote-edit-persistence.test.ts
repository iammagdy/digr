import { describe, expect, it, vi } from "vitest";
import { persistEditedQuoteMessage, resolveQuoteConversationId } from "../src/functions/shared/quoteMessagePersistence";

describe("edited quote persistence", () => {
  it("resolves the conversation from the saved quote message when plans_quotes has no conversation_id", async () => {
    const filters: Array<[string, unknown]> = [];
    const query: any = {
      select: vi.fn(() => query),
      eq: vi.fn((field: string, value: unknown) => { filters.push([field, value]); return query; }),
      not: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: (resolve: (value: unknown) => unknown) => resolve({
        data: [{ conversation_id: "conversation-100" }],
        error: null,
      }),
    };
    const database = { from: vi.fn(() => query) };

    await expect(resolveQuoteConversationId(database, {
      userId: "user-1",
      quoteId: "old-quote",
    })).resolves.toBe("conversation-100");
    expect(database.from).toHaveBeenCalledWith("messages");
    expect(filters).toEqual([
      ["user_id", "user-1"],
      ["quote->>quoteId", "old-quote"],
    ]);
  });

  it("supports older messages that store the quote identifier under id", async () => {
    const queries: any[] = [];
    const makeQuery = (data: unknown[]) => {
      const query: any = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        not: vi.fn(() => query),
        limit: vi.fn(() => query),
        then: (resolve: (value: unknown) => unknown) => resolve({ data, error: null }),
      };
      queries.push(query);
      return query;
    };
    const database = { from: vi.fn().mockImplementationOnce(() => makeQuery([])).mockImplementationOnce(() => makeQuery([{ conversation_id: "legacy-conversation" }])) };

    await expect(resolveQuoteConversationId(database, {
      userId: "user-1",
      quoteId: "legacy-quote",
    })).resolves.toBe("legacy-conversation");
    expect(queries).toHaveLength(2);
  });

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
