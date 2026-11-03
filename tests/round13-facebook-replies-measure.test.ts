import { describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { makeHarness, tregResult } from "./helpers/agentHarness";

/**
 * ROUND 13, item 3 (3 Nov 2026): THE FACEBOOK REPLIES MEASUREMENT FOR THE LIVE ROUND. No tool is switched and no paid call is made here (every answer below is fake; fetch is stubbed to fail).
 * What the next report needs is «rows per call» for each of the two Facebook replies tools. The gateway already writes it: every call the engine makes (one page of one comment's replies) is one `mission_calls` row with `endpoint_id`, `phase`, `status`, `rows_returned` and `cost_usd`.
 * This test pins that, for both tools and for the three answers a replies tool gives (rows, a successful empty answer, a failure), so the measurement does not depend on a log that could change unnoticed.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const catalog = loadTregCatalog();
const TOOLS = ["anyapi.facebook.comment_replies", "scrapecreators.x.v1-facebook-post-comment-replies"] as const;

/** A page of the tool, with the list where the card says it is and `n` reply rows in it. */
const pageOf = (endpointId: string, n: number): Record<string, unknown> => {
  const card = cardOf(endpointId)!;
  const rows = Array.from({ length: n }, (_, i) => ({ id: `rep_${i}`, text: `رد ${i}`, author: { name: "x" } }));
  let node: unknown = rows;
  for (const key of [...card.page.list].reverse()) node = { [key]: node };
  return node as Record<string, unknown>;
};
/** The required inputs of the endpoint, from the catalog's own examples (no real comment). */
const requiredOf = (endpointId: string): Record<string, unknown> => Object.fromEntries(catalog.byId.get(endpointId)!.inputs.filter((i) => i.required).map((i) => [i.name, i.example ?? "x"]));

describe("both Facebook replies tools are test-account tools, and each call logs the rows it returned", () => {
  // CHANGED (round 14): `anyapi.facebook.comment_replies` is verified on the real pages of live round 12; the other tool was never used
  it("the verified tool is read by every account's plan, the other stays a test-account tool", () => {
    expect(cardOf("anyapi.facebook.comment_replies")!.status).toBe("verified");
    expect(cardOf("scrapecreators.x.v1-facebook-post-comment-replies")!.status).toBe("catalog_only");
  });

  for (const id of TOOLS) {
    it(`${id}: one mission_calls row per call, with rows_returned = the rows of the page (2, then 0 for a successful empty answer), the phase and the cost`, async () => {
      const h = makeHarness({ phase: "execution", budgetUsd: 0.2, responses: [tregResult(pageOf(id, 2), 0.0012), tregResult(pageOf(id, 0), 0)] });
      const a = await h.gateway.tregCall({ endpoint_id: id, params: requiredOf(id) });
      const b = await h.gateway.tregCall({ endpoint_id: id, params: requiredOf(id) });
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      const logged = await h.store.listCalls(h.mission.id);
      expect(logged.map((r) => [r.endpoint_id, r.phase, r.rows_returned])).toEqual([[id, "execution", 2], [id, "execution", 0]]);
      expect(logged[0].status).toBe("ok");
      expect(logged[1].status).toBe("empty");
      expect(logged[0].cost_usd).toBeCloseTo(0.0012, 6);
    });
  }
});
