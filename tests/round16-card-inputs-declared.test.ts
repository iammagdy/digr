import { describe, expect, it } from "vitest";
import { DECLARED_EXTRA_INPUTS, loadTregCatalog } from "../src/lib/treg/catalog";
import { TOOL_CARDS, type ToolCard } from "../src/lib/agentMission/foundation/toolCards";

/**
 * ROUND 16, PART 5: A STATIC CONTRACT BETWEEN THE TOOL CARDS AND THE CATALOG. The gateway drops every input the catalog does not declare (agent/src/gateway.ts: `known` = the endpoint's inputs and its paging inputs), so a card that writes an input the catalog does not declare is
 * silently stripped: the call goes out without it and the customer's condition is lost. Every input any card SENDS (its query, period days, source, country, order, page size, cursor, ids, parent identity inputs, and the fixed inputs it sends on every call) must be declared in the
 * pinned catalog snapshot or in DECLARED_EXTRA_INPUTS (the code declaration of an input the snapshot does not list). gateway.ts is not touched.
 */
const catalog = loadTregCatalog();

export function inputsSentBy(card: ToolCard): string[] {
  const i = card.inputs;
  return [
    i.query?.field, i.period?.from, i.period?.to, i.source?.param, i.ids?.param, i.country?.field, i.order?.field, i.pageSize?.field, i.cursor ?? undefined, i.parent?.param,
    ...(i.parent?.also ?? []).map((a) => a.param), ...Object.keys(i.fixed ?? {}),
  ].filter((x): x is string => typeof x === "string" && x !== "");
}

describe("every input a tool card sends is declared in the catalog (snapshot or DECLARED_EXTRA_INPUTS)", () => {
  it("there are cards to check, on every platform", () => {
    expect(TOOL_CARDS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(TOOL_CARDS.map((c) => c.platform))).toEqual(new Set(["tiktok", "x", "facebook", "instagram", "youtube"]));
  });
  for (const card of TOOL_CARDS) {
    it(`${card.endpointId} (${card.role}, ${card.status}): its endpoint is in the catalog and nothing it sends would be stripped`, () => {
      const endpoint = catalog.byId.get(card.endpointId);
      expect(endpoint, `${card.endpointId} is not in the catalog`).toBeTruthy();
      const declaredByCode = new Set((DECLARED_EXTRA_INPUTS[card.endpointId] ?? []).map((x) => x.name));
      const known = new Set([...endpoint!.inputs.map((x) => x.name), ...(endpoint!.pagination ?? [])]);
      const stripped = inputsSentBy(card).filter((name) => !known.has(name) && !declaredByCode.has(name));
      expect(stripped, `${card.endpointId}: inputs the gateway would drop`).toEqual([]);
    });
  }
  it("a code-declared input exists only where a card sends it (no dead declaration)", () => {
    for (const [endpointId, inputs] of Object.entries(DECLARED_EXTRA_INPUTS)) {
      const cards = TOOL_CARDS.filter((c) => c.endpointId === endpointId);
      expect(cards.length, endpointId).toBeGreaterThan(0);
      for (const input of inputs) expect(cards.some((c) => inputsSentBy(c).includes(input.name)), `${endpointId}.${input.name}`).toBe(true);
    }
  });
  it("the check itself catches a stripped input: a card sending an input the catalog does not declare is reported (SYNTHETIC)", () => {
    const real = TOOL_CARDS.find((c) => c.endpointId === "tikhub.youtube.video.comments")!;
    const bad: ToolCard = { ...real, inputs: { ...real.inputs, fixed: { ...(real.inputs.fixed ?? {}), not_a_declared_input: 1 } } };
    const endpoint = catalog.byId.get(bad.endpointId)!;
    const known = new Set([...endpoint.inputs.map((x) => x.name), ...(endpoint.pagination ?? [])]);
    expect(inputsSentBy(bad).filter((n) => !known.has(n))).toEqual(["not_a_declared_input"]);
  });
});
