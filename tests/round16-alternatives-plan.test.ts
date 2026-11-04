import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler, type CompiledPlanning } from "../agent/src/compiled";
import { ALTERNATIVE_LINE_AR, ALTERNATIVE_QUOTE_RULE_PLATFORMS, quoteCostPerRowOf } from "../src/lib/agentMission/foundation/alternatives";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { customerPlanView, stagePriceInputs } from "../src/lib/agentMission/plan";
import { NAMED_SHORTFALL_OPTIONS_AR } from "../src/lib/agentMission/foundation/namedShortfall";
import { replayGateway } from "./helpers/replayGateway";

/**
 * ROUND 16: THE COMPILED PLAN CARRIES THE ALTERNATIVES, decided before approval from the stored planning pages of real missions (no network, no paid call): Instagram (two verified comments cards with proven ids) gets one, a customer's Facebook gets none, a test account's Facebook comments-only
 * request gets the capture card, and NO planning call is made for any alternative. The quote follows decision A.
 */
const catalog = loadTregCatalog();
const replay = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
const requestOf = (id: string): string => replay.missions.find((m) => m.id === id)!.request;
const IG = "msn_e3e7632e2fb2d42f9c19";
const FB = "msn_6bb78c15d116268b0b9b";

async function plan(fixture: string, request: string, opts: { catalogOnly?: boolean; createdAt: string; answer?: string }) {
  const store = createMemoryStore();
  const target = `msn_r16_${fixture.slice(4, 10)}`;
  const { gateway, stats } = replayGateway(fixture, catalog, store, target, { cut80: { "scrapecreators.x.v1-facebook-post-comments": ["cursor"] } });
  const out: CompiledPlanning = await planByCompiler({ mission: { id: target, request_text: request, answer_text: opts.answer ?? null, created_at: opts.createdAt }, gateway: gateway as never, store, catalog, nowMs: Date.parse(opts.createdAt) + 60_000, ...(opts.catalogOnly ? { catalogOnly: true } : {}) });
  if (out.kind !== "plan") throw new Error(`no plan: ${out.kind}`);
  return { out, stats };
}
const commentsOf = (p: Awaited<ReturnType<typeof plan>>["out"]) => p.plan.stages.find((s) => s.key === "comments")!;

describe("Instagram (msn_e3e7632e2fb2d42f9c19's request, its stored planning pages)", () => {
  it("the comments stage carries the one verified alternative, with its own binding, cursor and mapping; the replies stage is unchanged", async () => {
    const { out } = await plan(IG, requestOf(IG), { createdAt: "2026-11-02T15:31:00Z" });
    const c = commentsOf(out);
    expect(c.endpoint_id).toBe("anyapi.instagram.post.comments");
    expect(c.engine!.alternatives!.map((a) => a.endpoint_id)).toEqual(["scrapecreators.instagram.post.comments"]);
    expect(c.engine!.alternatives![0]).toMatchObject({ cursor_param: "cursor", parent_binding: { param: "url", from: "link" }, map_file_id: "page" });
    const replies = out.plan.stages.find((s) => s.replies_of !== undefined)!;
    expect(replies.engine!.alternatives).toBeUndefined();
  });
  it("no planning call goes to the alternative (planning reads only what it always read)", async () => {
    const { stats } = await plan(IG, requestOf(IG), { createdAt: "2026-11-02T15:31:00Z" });
    expect([...stats.served, ...stats.unserved].map((x) => x.endpointId)).not.toContain("scrapecreators.instagram.post.comments");
  });
  it("the card says the line about the next source, in Arabic, with no provider name and no endpoint id, and the customer's view carries no endpoint id", async () => {
    const { out } = await plan(IG, requestOf(IG), { createdAt: "2026-11-02T15:31:00Z" });
    expect(out.plan.notes_ar).toContain(ALTERNATIVE_LINE_AR);
    const shown = JSON.stringify(customerPlanView(out.plan));
    expect(shown).not.toMatch(/scrapecreators|anyapi|tikhub|crawl4ai|justoneapi|endpoint/i);
    expect(shown).toContain("نحاول الإكمال من مصدر آخر للمنصة نفسها");
  });
  // CHANGED (round 17, owner): decision A is SUSPENDED. The alternative's price was never measured on real pages (one page of one comment) and a 9-item request cost 218 points on it while the alternative was never used: the quote is the MAIN card's cost, the alternative still runs after approval, the difference is ours.
  it("DECISION A SUSPENDED: the alternative costs 6.5 times the main tool per expected row, yet the quote is the MAIN tool's cost; the alternative is still planned; the 2x rule is kept behind a constant and gives its old answer when switched on", async () => {
    const { out } = await plan(IG, requestOf(IG), { createdAt: "2026-11-02T15:31:00Z" });
    const c = commentsOf(out);
    const main = cardOf("anyapi.instagram.post.comments")!;
    const alt = cardOf("scrapecreators.instagram.post.comments")!;
    expect(alt.costUsdPerPage / alt.page.observedRowsPerPage).toBeGreaterThan(2 * (main.costUsdPerPage / main.page.observedRowsPerPage));
    expect(ALTERNATIVE_QUOTE_RULE_PLATFORMS.size).toBe(0);
    expect(c.measured_cost_per_row_usd).toBeCloseTo(main.costUsdPerPage / main.page.observedRowsPerPage, 10);
    expect(c.engine!.alternatives!.map((a) => a.endpoint_id)).toEqual(["scrapecreators.instagram.post.comments"]);
    expect(out.plan.price.reservePoints).toBe(priceMissionByCode(stagePriceInputs(out.plan.stages)).reservePoints);
    // the rule itself, switched on by its parameter, is what it was
    expect(quoteCostPerRowOf(main, [{ card: alt, capture: false, entry: {} as never }], true)).toBeCloseTo(alt.costUsdPerPage / alt.page.observedRowsPerPage, 10);
    expect(quoteCostPerRowOf(main, [{ card: alt, capture: false, entry: {} as never }])).toBeCloseTo(main.costUsdPerPage / main.page.observedRowsPerPage, 10);
  });
});

describe("Facebook (msn_6bb78c15d116268b0b9b's stored planning pages)", () => {
  const COMMENTS_ONLY = "هات منشورات عن الذكاء الاصطناعي من صفحة قناة العربية على فيسبوك آخر ٣ شهور، منشورين، مع كل التعليقات.";
  // CHANGED (round 20): the second Facebook comments card is verified (first real pages of msn_934781c56a01a96825af, ids proven equal), so it is an alternative on EVERY account, with no capture cap
  it("a customer account: the verified second comments card is the one alternative (a proven route, no page cap), and the card says it before approval", async () => {
    const { out } = await plan(FB, COMMENTS_ONLY, { createdAt: "2026-11-02T15:36:00Z", answer: NAMED_SHORTFALL_OPTIONS_AR.fill });
    const c = commentsOf(out);
    expect(c.engine!.alternatives!.map((a) => a.endpoint_id)).toEqual(["anyapi.facebook.post_comments"]);
    expect(c.max_pages ?? null).toBeNull();
    expect(out.plan.notes_ar ?? []).toContain(ALTERNATIVE_LINE_AR);
  });
  it("a TEST account, comments only: the same one alternative, no longer a capture, so the stage's page cap is not the 0.20 USD cap of decision 7.4, and the quote is not raised (the alternative is not 2x dearer per row)", async () => {
    const { out } = await plan(FB, COMMENTS_ONLY, { createdAt: "2026-11-02T15:36:00Z", catalogOnly: true, answer: NAMED_SHORTFALL_OPTIONS_AR.fill });
    const c = commentsOf(out);
    expect(c.endpoint_id).toBe("scrapecreators.x.v1-facebook-post-comments");
    expect(c.engine!.alternatives!.map((a) => a.endpoint_id)).toEqual(["anyapi.facebook.post_comments"]);
    expect(c.max_pages ?? null).toBeNull();
    const main = cardOf("scrapecreators.x.v1-facebook-post-comments")!;
    expect(c.measured_cost_per_row_usd).toBeCloseTo(main.costUsdPerPage / main.page.observedRowsPerPage, 10);
  });
  it("a test account with replies planned: the capture card cannot feed the replies step, so no alternative", async () => {
    const { out } = await plan(FB, requestOf(FB), { createdAt: "2026-11-02T15:36:00Z", catalogOnly: true, answer: NAMED_SHORTFALL_OPTIONS_AR.fill });
    expect(commentsOf(out).engine!.alternatives).toBeUndefined();
  });
});
