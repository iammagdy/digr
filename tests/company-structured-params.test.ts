import { describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { normalizeIcypeasCompanyParams } from "../src/lib/server/tregAdapter";
import { createChatDb } from "./helpers/chatSession";

/**
 * The company request that reaches the source is the structured query the planner produced, not a rebuild from the
 * customer's sentence. Offline evidence for «عايز شركتين كهرباء في مصر».
 */
describe("company search sends the planner's structured query", () => {
  it("«عايز شركتين كهرباء في مصر»: plan parameters, then the exact request built from them", async () => {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("no model call expected"); });
    const r: any = await handler.handleUserMessage({ userId: "u_struct", message: "عايز شركتين كهرباء في مصر", userBalance: 5000 });
    expect(r.outputType).toBe("propose_plan");
    const item = r.planQuote.items[0];
    expect(item.targetVolumeMax).toBe(2);

    const request = normalizeIcypeasCompanyParams(item.params, 6, null);
    expect(request).toEqual({
      query: {
        location: { include: ["Egypt"] },
        industry: { include: ["Electrical/Electronic Manufacturing", "Utilities"] },
        keyword: { include: ["electrical", "electricity", "electrical engineering"] },
      },
      pagination: { size: 6 },
    });
  });

  it("a structured query is sent as written: the model's own country and keywords win over the sentence text", () => {
    const request = normalizeIcypeasCompanyParams({
      query: { location: { include: ["Germany"] }, keyword: { include: ["solar", "photovoltaic"] } },
      // the sentence text names another country and activity; it must not override the structured query
      note: "شركات أغذية في مصر",
    }, 5, "tok_1");
    expect(request).toEqual({
      query: { location: { include: ["Germany"] }, keyword: { include: ["solar", "photovoltaic"] } },
      pagination: { size: 5, token: "tok_1" },
    });
  });

  it("a taxonomy with the broad label «Utilities» is sent together with the keywords (the source combines them with AND)", () => {
    const request = normalizeIcypeasCompanyParams({
      query: { location: { include: ["Egypt"] }, industry: { include: ["Utilities"] }, keyword: { include: ["electrical"] } },
    }, 6);
    expect(request.query).toEqual({ location: { include: ["Egypt"] }, industry: { include: ["Utilities"] }, keyword: { include: ["electrical"] } });
  });

  it("an Arabic or unknown country in the structured query is not trusted: the text is read the old way", () => {
    const request = normalizeIcypeasCompanyParams({
      query: { location: { include: ["مصر"] } },
      country: "Egypt",
      industry: "كهرباء",
    }, 6);
    expect(request.query.location).toEqual({ include: ["Egypt"] });
    expect(request.query.industry).toEqual({ include: ["Electrical/Electronic Manufacturing", "Utilities"] });
  });

  it("with a structured country and no activity, the activity is read from the text", () => {
    const request = normalizeIcypeasCompanyParams({ query: { location: { include: ["Egypt"] } }, industry: "كهرباء" }, 6);
    expect(request.query).toEqual({
      location: { include: ["Egypt"] },
      industry: { include: ["Electrical/Electronic Manufacturing", "Utilities"] },
      keyword: { include: ["electrical", "electricity", "electrical engineering"] },
    });
  });
});
