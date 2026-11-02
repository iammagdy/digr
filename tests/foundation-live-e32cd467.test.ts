import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { runInSandbox } from "../agent/src/sandbox";
import { redesignStagesOf } from "../agent/src/redesign";
import type { Gateway } from "../agent/src/gateway";
import { planByCompiler, type CompiledPlanning } from "../agent/src/compiled";
import { withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { openRepliesMax } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { AGENT_JOB_POINTS_CAP, AGENT_MAX_DELIVERED_ROWS, AGENT_REPLIES_PER_COMMENT_MAX } from "../src/lib/agentMission/constants";
import type { RedesignFlags } from "../src/lib/agentMission/redesignFlags";
import { replayGateway } from "./helpers/replayGateway";

/**
 * THE FIRST LIVE RUN AFTER PR #348: msn_e32cd467fe6bbdfa943e (test account, 2026-11-02 23:58 Cairo; TikTok's own flag = test). The compiled card promised the WHOLE
 * platform counter of comments (20,541) although the customer asked for «١٠٠ تعليق من كل فيديو», and sized the replies from that whole counter (192,572), so the hold was
 * 1,109,375 points for an account holding 7,967.
 *
 * The data: (1) its stored plan record and call log (`tests/fixtures/live/plans/msn_e32cd467fe6bbdfa943e.json`, read by SELECT with no personal field and passed through
 * `tests/fixtures/live/anonymise.py`; its raw pages are in storage, which this session cannot read: they are NOT here and nothing was made up in their place); (2) the real,
 * anonymised pages of the SAME search (M12, 10 hours earlier: the same tool, keyword, region and order; the replay gateway serves a page only for the same inputs).
 */
const LIVE = JSON.parse(readFileSync(new URL("./fixtures/live/plans/msn_e32cd467fe6bbdfa943e.json", import.meta.url), "utf8")) as {
  price: { overCap: boolean; deliveredRows: number; reservePoints: number };
  calls: Array<[string, string, string, string, number]>;
  compiled: { promises: Record<string, { n: number; type: string; counter?: number }> };
  stages: Array<{ planned_rows: number; per_parent_rows: number | null; pinned_rows?: Array<{ id: string; comments: number; country: string; language: string }>; spare_rows?: Array<{ id: string; comments: number }>; sample_replies_count?: number[] }>;
};
// the customer's words, exactly (missions.request_text), and the moment of the request
const REQUEST = "عايز فيديوهين من تيك توك من مصر بالعربي عن الذكاء الاصطناعي، أكتر فيديوهات عليها تعليقات، و١٠٠ تعليق من كل فيديو مع ردودهم";
const CREATED = "2026-11-02T21:58:06Z";
const M12 = "msn_5851abc92a1e6645a9cd";
const catalog = loadTregCatalog();
const TYPES_TEST = { social_posts: "test", social_account: "test", social_comments: "test", companies: "off", people: "off", places: "off" } as RedesignFlags;
const page = (call: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M12}/raw/${call}.json`, import.meta.url), "utf8"));

describe("live msn_e32cd467: the stored record shows where the number was lost", () => {
  it("the stored plan promised every comment of the two videos by their counters (20,541) with no number per video, and 192,572 replies sized from that counter", () => {
    const [videos, comments, replies] = LIVE.stages;
    const counters = videos.pinned_rows!.map((r) => r.comments);
    expect(counters).toEqual([15434, 5107]);
    expect(comments.planned_rows).toBe(20541);
    expect(comments.per_parent_rows).toBeNull();
    expect(LIVE.compiled.promises.comments).toEqual({ n: 20541, type: "counter", counter: 20541 });
    // the replies' maximum = ceil(comments promised x the mean replies counter of the exposure pages); two exposure pages of 20 comments each (the call log): 375 / 40
    expect(LIVE.calls.map((c) => c[4])).toEqual([20, 20, 20]);
    expect(replies.planned_rows).toBe(Math.ceil(20541 * (375 / 40)));
    expect(LIVE.compiled.promises.comments_replies).toEqual({ n: 192572, type: "open" });
    expect(LIVE.price.deliveredRows).toBe(2 + 20541 + 192572);
    expect(LIVE.price.overCap).toBe(true);
    expect(LIVE.price.reservePoints).toBe(1109375);
  });

  it("the two chosen videos meet the country and the language, and were ranked by the counter after them (the spares had fewer comments)", () => {
    const [videos] = LIVE.stages;
    for (const r of videos.pinned_rows!) expect([r.country, r.language]).toEqual(["مصر", "ar"]);
    const spares = videos.spare_rows!.map((r) => r.comments);
    expect(Math.min(...videos.pinned_rows!.map((r) => r.comments))).toBeGreaterThan(Math.max(...spares));
  });

  it("with its own numbers, the new bound: 100 comments from each of the two videos, and the replies' maximum bounded by those 200 comments", () => {
    const [videos] = LIVE.stages;
    const comments = videos.pinned_rows!.reduce((s, r) => s + Math.min(100, r.comments), 0);
    expect(comments).toBe(200);
    const max = openRepliesMax(comments, LIVE.stages[1].sample_replies_count!, AGENT_REPLIES_PER_COMMENT_MAX);
    expect(max).toBeLessThanOrEqual(comments * AGENT_REPLIES_PER_COMMENT_MAX);
    expect(max).toBe(Math.ceil(200 * ((20 + 33 + 24) / 3)));
    expect(max).toBeLessThan(192572 / 30);
  });
});

describe("F1: the Ask keeps the customer's number per parent", () => {
  it("«و١٠٠ تعليق من كل فيديو مع ردودهم»: 100 comments per video; replies asked, with no number", () => {
    const ask = buildAsk(REQUEST, null, Date.parse(CREATED));
    expect(ask.count).toBe(2);
    expect(ask.commentsPerParent).toBe(100);
    expect(ask.repliesPerComment).toBeNull();
    expect(ask.replies).toBe("some");
    expect([ask.country, ask.language, ask.order, ask.topic.text]).toEqual(["EG", "ar", "most_commented", "الذكاء الاصطناعي"]);
  });
  it("the other ways a number per parent is written, and none when no number is per parent", () => {
    const at = Date.parse(CREATED);
    expect(buildAsk("هات ٣ فيديوهات تيك توك عن الطبخ و٥٠ تعليق لكل فيديو", null, at).commentsPerParent).toBe(50);
    expect(buildAsk("عايز فيديوهين تيك توك عن الطبخ، أول 20 تعليق على كل فيديو و٣ ردود على كل تعليق", null, at)).toMatchObject({ commentsPerParent: 20, repliesPerComment: 3 });
    expect(buildAsk("هات فيديوهين تيك توك عن الطبخ مع كل التعليقات والردود", null, at)).toMatchObject({ commentsPerParent: null, repliesPerComment: null });
    expect(buildAsk("هات فيديوهين تيك توك عن الطبخ و٣٠٠ تعليق", null, at).commentsPerParent).toBeNull();
  });
});

describe("F3/F5: compiled from real pages of the same search, the comments and the replies follow the customer's number", () => {
  let planned: CompiledPlanning;
  let served: string[];
  let delivered: { videos: string[]; comments: Array<Record<string, unknown>>; replies: Array<Record<string, unknown>> };
  beforeAll(async () => {
    const store = createMemoryStore();
    const target = "msn_replay_e32cd467";
    const planning = replayGateway(M12, catalog, store, target);
    planned = await planByCompiler({ mission: { id: target, request_text: REQUEST, answer_text: null, created_at: CREATED }, gateway: planning.gateway, store, catalog, nowMs: Date.parse(CREATED) + 5_000 });
    served = planning.stats.served.map((s) => s.storedCall);
    if (planned.kind !== "plan") return;
    const exec = replayGateway(M12, catalog, store, target, { firstSeq: 100 });
    const items = await ItemStore.open(store, target);
    await runEngine({ items, store, plan: withPromiseCaps(planned.plan), missionId: target, gateway: exec.gateway as unknown as Gateway, sandbox: (code, inputs) => runInSandbox(code, inputs), addEvent: async () => undefined, deadlineMs: Date.now() + 3_600_000, sleep: async () => undefined, redesignStages: redesignStagesOf(planned.plan, TYPES_TEST, true, { tiktok: "test" }) });
    delivered = { videos: items.acceptedRows("videos").map((r) => String(r.id)), comments: items.acceptedRows("comments"), replies: items.acceptedRows("comments_replies") };
  }, 120_000);

  it("the same search inputs as the live plan, served from the stored pages", () => {
    expect(planned.kind).toBe("plan");
    expect(served).toEqual(["call_0007", "call_0008", "call_0019"]);
    if (planned.kind !== "plan") return;
    expect(planned.plan.stages[0].engine!.params).toEqual({ keyword: "الذكاء الاصطناعي", region: "EG", sort_type: 1, count: 20 });
  });

  it("comments: at most 100 top-level comments from each chosen video; the promise is the customer's 100 a video, bounded by each video's counter", () => {
    if (planned.kind !== "plan") throw new Error("no plan");
    const card = cardOf("tikhub.tiktok.search.videos")!;
    const counters = planned.result.chosen.map((id) => Number(mapPage(card, page("call_0007")).find((r) => r.id === id)!.comments));
    const comments = planned.plan.stages.find((s) => s.key === "comments")!;
    expect(comments.per_parent_rows).toBe(100);
    expect(comments.all_children).toBeUndefined();
    const n = counters.reduce((s, c) => s + Math.min(100, c), 0);
    expect(comments.planned_rows).toBe(n);
    expect(planned.result.promises.comments).toEqual({ type: "counter", n, counter: counters.reduce((s, c) => s + c, 0) });
  });

  it("replies: open (no counter promises them), and the maximum the hold is sized by is bounded by the comments actually chosen, never by a whole-video counter", () => {
    if (planned.kind !== "plan") throw new Error("no plan");
    const comments = planned.result.promises.comments.n;
    const p = planned.result.promises.comments_replies;
    expect(p.type).toBe("open");
    const exposureCounters = ["call_0008", "call_0019"].flatMap((c) => mapPage(cardOf("anyapi.tiktok.video.comments")!, page(c)).map((r) => Number(r.replies_count)));
    expect(p.n).toBe(openRepliesMax(comments, exposureCounters, AGENT_REPLIES_PER_COMMENT_MAX));
    expect(p.n).toBeLessThanOrEqual(comments * AGENT_REPLIES_PER_COMMENT_MAX);
    expect(planned.plan.stages.find((s) => s.key === "comments_replies")!.planned_rows).toBe(p.n);
  });

  it("the plan can be approved by the existing money rules: rows within the mission limit, the hold within the job cap", () => {
    if (planned.kind !== "plan") throw new Error("no plan");
    expect(planned.plan.price.deliveredRows).toBeLessThanOrEqual(AGENT_MAX_DELIVERED_ROWS);
    expect(planned.plan.price.overCap).toBe(false);
    expect(planned.plan.price.reservePoints).toBeLessThanOrEqual(AGENT_JOB_POINTS_CAP);
  });

  it("the customer reads the number per video, in Arabic, with no provider, no price in dollars", () => {
    if (planned.kind !== "plan") throw new Error("no plan");
    const lines = [planned.plan.summary_ar, ...(planned.plan.notes_ar ?? [])];
    expect(lines.some((l) => l.includes("١٠٠ تعليق من كل"))).toBe(true);
    for (const line of lines) expect(checkCustomerText(line, { maxChars: 400 }).issues, line).toEqual([]);
  });

  it("the engine on the stored pages: two videos, at most 100 comments from each, and replies read only for the delivered comments", () => {
    if (planned.kind !== "plan") throw new Error("no plan");
    expect(delivered.videos).toHaveLength(2);
    for (const v of delivered.videos) expect(delivered.comments.filter((c) => c.parent_id === v).length).toBeLessThanOrEqual(100);
    expect(delivered.comments.length).toBeGreaterThan(0);
    const ids = new Set(delivered.comments.map((c) => String(c.id)));
    for (const r of delivered.replies) expect(ids.has(String(r.parent_id))).toBe(true);
  });
});
