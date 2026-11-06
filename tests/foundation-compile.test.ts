import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { carriedBy, chooseCard, compilePlan, parentInputs, stageShapeOf } from "../src/lib/agentMission/foundation/compilePlan";
import { childPromise, PROMISE_TYPES } from "../src/lib/agentMission/foundation/promise";
import { cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { storedCalls } from "./helpers/replayGateway";

/**
 * F3 and F5 on the stored missions (docs/FOUNDATION-PLAN.md PR 2a acceptance 4 and 5): the stage shape from the Ask alone, the tool chosen by the conditions it carries, the
 * inputs written by code, the exposure check, and the typed promise (never an estimate). Pages are the stored, anonymised real pages.
 */
const catalog = loadTregCatalog();
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string; stages: Array<{ key: string; planned: number; endpoint_id: string; parent_key: string | null }> }> };
const request = (id: string) => fixture.missions.find((m) => m.id === id)!.request;
const page = (mission: string, call: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${mission}/raw/${call}.json`, import.meta.url), "utf8"));
const capabilityOf = (id: string) => catalog.byId.get(id)?.capability ?? null;
const AT = Date.parse("2026-11-02T12:00:00Z");

describe("acceptance 4: M20 (the lost stages) is compiled with videos, comments and replies from the Ask alone", () => {
  it("the shape is read from the customer's words, with no model: parents, comments, replies", () => {
    const ask = buildAsk(request("msn_adcfafabcdebc27ff803"), null, AT);
    expect(stageShapeOf(ask)).toEqual(["parents", "comments", "replies"]);
    // the stored plan had ONE stage (videos): the comments and the replies were dropped by the model after the question
    expect(fixture.missions.find((m) => m.id === "msn_adcfafabcdebc27ff803")!.stages.map((s) => s.key)).toEqual(["videos"]);
  });
  it("every stored request's shape follows its words: comments and replies when asked, X tweets with a replies step", () => {
    for (const m of fixture.missions) {
      const shape = stageShapeOf(buildAsk(m.request, null, AT));
      if (/تغريدة/.test(m.request)) expect(shape).toEqual(["parents", "replies"]);
      else expect(shape).toEqual(["parents", "comments", "replies"]);
    }
  });
  it("PR 3 gave YouTube its cards (tests/platform-youtube.test.ts); a request the Ask cannot place on a platform is still built by nothing rather than by a model recipe", () => {
    const ask = buildAsk(request("msn_adcfafabcdebc27ff803"), null, AT);
    expect(chooseCard(ask, "parents")!.endpointId).toBe("tikhub.x.youtube-web-search-channel");
    const none = buildAsk("هات لي بيانات عن الذكاء الاصطناعي", null, AT);
    expect(none.platform).toBeNull();
    expect(chooseCard(none, "parents")).toBeNull();
    const r = compilePlan({ ask: none, pool: { card: cardOf("tikhub.tiktok.search.videos")!, params: {}, pages: [] }, exposure: () => undefined, capabilityOf });
    expect(r).toEqual({ ok: false, reason: "no_platform_card" });
  });
});

describe("F3: the tool is the one that carries the most of the Ask (D7), its inputs written by code", () => {
  const tt = buildAsk(request("msn_5851abc92a1e6645a9cd"), null, AT);
  it("TikTok: the search that takes the topic, the country and the order wins over the cheaper ones that cannot", () => {
    expect(chooseCard(tt, "parents")!.endpointId).toBe("tikhub.tiktok.search.videos");
    expect(carriedBy(cardOf("tikhub.tiktok.search.videos")!, tt).carried).toEqual(["topic", "country", "order"]);
    expect(carriedBy(cardOf("anyapi.tiktok.search.videos")!, tt).carried).toEqual(["topic", "order"]);
    expect(carriedBy(cardOf("crawl4ai.tiktok.search.videos")!, tt).carried).toEqual(["topic"]);
    expect(chooseCard(tt, "comments")!.endpointId).toBe("anyapi.tiktok.video.comments");
    expect(chooseCard(tt, "replies")!.endpointId).toBe("anyapi.tiktok.comment_replies");
  });
  it("the inputs are the customer's own topic words, the country, the most-engaged order and the page size: exactly the stored M12 call that found the delivered videos", () => {
    expect(parentInputs(cardOf("tikhub.tiktok.search.videos")!, tt)).toEqual(storedCalls("msn_5851abc92a1e6645a9cd").find((c) => c[0] === "call_0007")![5]);
  });
  it("X: the query carries the words in quotes, the language and the Cairo period; with the replies asked the tweets are the most engaged (NOV 6 2026: «Latest» gave tweets seconds old, with no reply)", () => {
    const x = buildAsk(request("msn_b060d3347ed7660f972e"), null, AT);
    // the request says «مع الردود», so the tweets asked for are ORIGINALS (live D5: 10 of 20 were replies): the query ends with -filter:replies
    expect(parentInputs(chooseCard(x, "parents")!, x)).toEqual({ query: "\"العاصمة الإدارية\" lang:ar since:2026-09-30_21:00:00_UTC until:2026-10-31_22:00:00_UTC -filter:replies", queryType: "Top", limit: 20 });
    expect(chooseCard(x, "comments")).toBeNull();
    // the X replies card is verified since live round 8, so every account is offered it
    expect(chooseCard(x, "replies")!.endpointId).toBe("anyapi.x.post.comments");
  });
});

describe("decision 7.3, the exposure check: a parent with no readable comment is replaced before the card", () => {
  const ask = buildAsk(request("msn_5851abc92a1e6645a9cd"), null, AT);
  const card = cardOf("tikhub.tiktok.search.videos")!;
  const pool = { card, params: parentInputs(card, ask), pages: [{ callId: "call_0007", page: page("msn_5851abc92a1e6645a9cd", "call_0007") }] };
  const comments = page("msn_5851abc92a1e6645a9cd", "call_0008");
  const empty = { output: { data: { comments: [], nextCursor: null }, found: true } };
  it("the first ranked video answers with no comment: it is replaced by the next one, and the card is built on the two that have comments", () => {
    const r = compilePlan({ ask, pool, exposure: (id) => ({ callId: `x_${id}`, page: id === "7663879872137252114" ? empty : comments, failed: false }), capabilityOf });
    if (!r.ok) throw new Error(r.reason);
    expect(r.chosen).toEqual(["7690257663250205974", "7683623292564933910"]);
    expect(r.plan.stages.find((s) => s.key === "comments")!.parent_pins).toEqual(r.chosen);
  });
  it("no video has a readable comment: nothing is compiled (the card would promise what the source does not show)", () => {
    expect(compilePlan({ ask, pool, exposure: () => ({ callId: "x", page: empty, failed: false }), capabilityOf })).toEqual({ ok: false, reason: "no_parent_with_children" });
  });
});

describe("acceptance 5: M6, M9 and M13 (their stored promises were estimates: 280, 300 and 318 replies) have no promise of type estimate", () => {
  const CASES: Array<{ id: string; call: string; endpoint: string; storedReplies: number }> = [
    { id: "msn_48f6c7c80eb7068f2a38", call: "call_0002", endpoint: "tikhub.tiktok.search.videos", storedReplies: 280 },
    { id: "msn_c796a6ff13d79f7a973d", call: "call_0001", endpoint: "crawl4ai.tiktok.search.videos", storedReplies: 300 },
    { id: "msn_f22426e67810c2ce852e", call: "call_0002", endpoint: "tikhub.tiktok.search.videos", storedReplies: 318 },
  ];
  for (const c of CASES) {
    it(`${c.id}: compiled on its own stored search page, every stage's promise is exact, counter or open`, () => {
      expect(storedCalls(c.id).find((x) => x[0] === c.call)![2]).toBe(c.endpoint);
      const stored = fixture.missions.find((m) => m.id === c.id)!;
      expect(stored.stages.find((s) => s.parent_key === "comments")?.planned).toBe(c.storedReplies);
      const ask = buildAsk(stored.request, null, AT);
      const card = cardOf(c.endpoint)!;
      // the exposure pages of these parents were never read live (no stored page): each parent is unchecked, never invented
      const r = compilePlan({ ask, pool: { card, params: {}, pages: [{ callId: c.call, page: page(c.id, c.call) }] }, exposure: () => ({ callId: null, page: null, failed: true }), capabilityOf });
      if (!r.ok) throw new Error(r.reason);
      const types = Object.values(r.promises).map((p) => p.type);
      expect(types.every((t) => PROMISE_TYPES.includes(t))).toBe(true);
      expect(r.promises.videos.type).toBe("exact");
      expect(r.promises.comments.type).toBe("counter");
      expect(r.promises.comments.n).toBe(r.chosen.reduce((s, id) => s + Number(mapPage(card, page(c.id, c.call)).find((x) => x.id === id)!.comments), 0));
      expect(r.promises.comments_replies.type).toBe("open");
      expect(r.plan.stages.find((s) => s.key === "comments_replies")!.replies_open).toBe(true);
      for (const line of [r.plan.summary_ar, ...(r.plan.notes_ar ?? [])]) expect(checkCustomerText(line, { maxChars: 400 }).issues, line).toEqual([]);
    });
  }
  it("a promise has three types only, and an edited number never raises the counter", () => {
    expect(PROMISE_TYPES).toEqual(["exact", "counter", "open"]);
    expect(childPromise([10, 5], null, 3)).toEqual({ type: "counter", n: 15, counter: 15 });
    expect(childPromise([10, 5], 8, 3)).toEqual({ type: "counter", n: 8, counter: 15 });
    expect(childPromise([10, 5], 40, 3)).toEqual({ type: "counter", n: 15, counter: 15 });
    expect(childPromise([10, null], null, 3)).toEqual({ type: "open", n: 3 });
  });
});

describe("F6 inside the compiler: a stage is built by a verified card, by code, never handed to a model", () => {
  it("X replies (verified since live round 8): the step IS included for every account, and every stage is built by code; the customer text of the plan is clean", () => {
    const ask = buildAsk(request("msn_b060d3347ed7660f972e"), null, AT);
    const card = chooseCard(ask, "parents")!;
    const r = compilePlan({ ask, pool: { card, params: parentInputs(card, ask), pages: [{ callId: "call_0003", page: page("msn_b060d3347ed7660f972e", "call_0003") }] }, exposure: () => undefined, capabilityOf });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.unserved_steps).toBeUndefined();
    expect(r.plan.stages.map((s) => s.key)).toEqual(["tweets", "replies"]);
    expect(r.plan.stages.every((s) => s.engine?.built_by === "code")).toBe(true);
    for (const line of [r.plan.summary_ar, ...(r.plan.notes_ar ?? [])]) expect(checkCustomerText(line, { maxChars: 400 }).issues, line).toEqual([]);
  });
});
