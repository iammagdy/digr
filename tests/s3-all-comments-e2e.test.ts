import { describe, expect, it } from "vitest";
import type { MemoryStore } from "../agent/src/memoryStore";
import { REPLAY_USER } from "./helpers/agentReplay";
import { runG4, vid, type World } from "./helpers/g4RepliesWorld";
import { isRepliesStage } from "../src/lib/agentMission/replies";

/**
 * S3, THE OWNER'S RULE FOR SOCIAL REQUESTS IN THE NEW PIPELINE: «all comments» means every comment and every reply that exists on the chosen videos; the AI never filters, judges or excludes; it understands the request, builds the tool call and formats the file. The live
 * mission msn_a6dacebce7e7b7432aa1 (2026-11-02 09:25 Cairo, this exact request) ran the OLD pipeline (`pipe_new = 0`) because its comments stage had no recipe the engine could prove (the model's mapping did not cover the page): the model carried the mission out, the old topic rules
 * excluded two videos («استُبعد ٢ لأنه لا يخص طلبك»), the plan had no replies stage and promised the model's own 800 comments.
 */
const REQUEST = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود.";
// the listing: video 1 has 120 comments and video 2 has 60 (180); every tenth comment has one reply (12 + 6 = 18). TikTok's own counter counts comments AND replies: 132 and 66 (198 in all). The other videos are further down
const thread = (n: number) => Array.from({ length: n }, (_, k) => (k % 10 === 0 ? 1 : 0));
const WORLD: World = { ownCounter: [132, 66, 33, 20, 10, 8, 6, 4], commentsOf: { [vid(0)]: thread(120), [vid(1)]: thread(60), [vid(2)]: thread(30) }, given: (_c, counted) => counted };
const flagsOn = (d: never) => { const store = (d as { store: MemoryStore }).store; store.settings.redesign_flags = { social_posts: "test", social_account: "test", social_comments: "test" }; store.userEmails.set(REPLAY_USER, "iam.magdy+1@outlook.com"); return d; };
// what the live plan was: 2 videos, the model's own 800 comments, a mapping of the comments page that no recipe can be proven from
const run = () => runG4(WORLD, { request: REQUEST, videosPlanned: 2, commentsPlanned: 800, perParent: 400, offTopicCaptions: true, partialCommentsMapping: true, deps: flagsOn as never });

describe("the owner's request, end to end, in the new pipeline", () => {
  it("the mission runs the new pipeline: pipe_new = 1, every stage built by code", async () => {
    const r = await run();
    const ev = (r.store as MemoryStore).events.filter((e) => e.counts && "pipe_new" in (e.counts as object)).map((e) => (e.counts as { pipe_new: number }).pipe_new);
    expect(ev).toEqual([1]);
    expect(r.plannedPlan.stages.map((s) => s.engine?.built_by)).toEqual(["code", "code", "code"]);
  });
  it("the request says «والردود»: the replies stage is in the plan", async () => {
    const r = await run();
    expect(r.plannedPlan.stages.some(isRepliesStage)).toBe(true);
  });
  it("«all comments and replies» is the real counters of the chosen videos (132 + 66 = 198: 180 comments and 18 replies), never the model's 800", async () => {
    const r = await run();
    const comments = r.plannedPlan.stages.find((s) => s.key === "comments")!;
    const replies = r.plannedPlan.stages.find(isRepliesStage)!;
    expect(comments.planned_rows).toBe(180);
    expect(comments.planned_rows).not.toBe(800);
    expect(comments.planned_rows + replies.planned_rows).toBe(132 + 66);
    expect(comments.parent_pins).toEqual([vid(0), vid(1)]);
  });
  it("nothing is excluded for relevance: the two videos (their captions do not carry the topic words) and all 180 comments are delivered", async () => {
    const r = await run();
    const counts = (r.store as MemoryStore).events.flatMap((e) => (e.counts ? [e.counts as Record<string, number>] : []));
    const relevance = counts.flatMap((c) => Object.entries(c)).filter(([k, v]) => /^chk_ex_/.test(k) && Number(v) > 0);
    expect(relevance).toEqual([]);
    const result = (r.store as MemoryStore).events.find((e) => e.kind === "result")!.counts as Record<string, number>;
    expect(result.stage_1_rows).toBe(2);
    expect(result.stage_2_rows).toBe(180);
    expect(String(r.mission.summary_ar ?? "")).not.toContain("لا يخص طلبك");
  });
  it("every reply that exists is delivered (12 + 6 = 18), and what is promised is what is delivered", async () => {
    const r = await run();
    const result = (r.store as MemoryStore).events.find((e) => e.kind === "result")!.counts as Record<string, number>;
    expect(result.stage_3_rows).toBe(18);
    const planned = r.plannedPlan.stages.reduce((n, s) => n + s.planned_rows, 0);
    expect(result.delivered).toBe(planned);
  });
});
