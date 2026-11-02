import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, type ReplayResult } from "./helpers/agentReplay";
import { X5, xQueriesSeen, xWorld, FB, YT, fbWorld, fbCommentsOf, fbRepliesTotal, runBench, ytCommentsOf, ytRepliesTotal, ytWorld } from "./helpers/benchWorld";
import { runS4 } from "./helpers/s4World";
import { REPLIES_TOOL as S11_REPLIES, postUrl, runS11, topLevelOf } from "./helpers/s11World";
import { vid } from "./helpers/g4RepliesWorld";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { isPeopleStage } from "../src/lib/agentMission/people";
import { isRepliesStage } from "../src/lib/agentMission/replies";
import { toArabicDigits } from "../src/lib/arabicDigits";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * THE FIVE BENCHMARK REQUESTS (docs/benchmarks/antigravity-10.md, items 1 to 5), each end to end with the EXACT Arabic text, asserting the consolidation's rules and that what the plan promised is what was delivered:
 * the request is built by code (new pipeline, every stage), the promise is the real counters of the chosen posts (comments and replies together), the platform's replies tool is used only for comments that have replies, the customer's file holds Arabic values only, a stage's type is its structure.
 */
type Run = ReplayResult;
const counts = (r: Run) => (r.store.events as Array<{ kind: string; counts?: Record<string, number> }>).find((e) => e.kind === "result")!.counts!;
const planOf = (r: Run) => r.plannedPlan as PricedPlan;
const callsTo = (r: Run, tool: string) => (r.call.mock.calls as Array<[{ endpointId: string; phase?: string }]>).filter((c) => c[0].endpointId === tool).length;
/** Every text cell of every sheet of the customer's file. */
async function cellsOf(r: Run): Promise<string[]> {
  const wb = await readWorkbook(r);
  const out: string[] = [];
  wb.worksheets.forEach((ws) => ws.eachRow((row) => row.eachCell((c) => { out.push(String(c.value ?? "")); })));
  return out;
}
/** The checks every benchmark shares (rules 1, 8, 9 and the promise). */
async function sharedChecks(r: Run, o: { promised: number }): Promise<void> {
  const plan = planOf(r);
  // the request was built by code and the mission ran on the new pipeline
  expect(plan.stages.every((s) => s.engine?.built_by === "code"), "every stage built by code").toBe(true);
  expect((r.store.events as Array<{ counts?: Record<string, unknown> }>).some((e) => e.counts && "pipe_new" in e.counts)).toBe(true);
  // rule 9: no stage is a people stage because of its title
  expect(plan.stages.some((s) => isPeopleStage(s))).toBe(false);
  // the promise is what was delivered: the card's total, the delivered units, the notice, the file's summary
  expect(r.mission.status).toBe("completed");
  expect(r.mission.delivered_units).toBe(o.promised);
  expect(r.notices[0].facts.delivered).toBe(o.promised);
  expect(r.notices[0].facts.planned).toBe(o.promised);
  expect(r.finalView.resultLinesAr.join(" ")).toContain(`تم تسليم ${toArabicDigits(o.promised)} من ${toArabicDigits(o.promised)}`);
  assertReplayInvariants(r, { expectDelivered: o.promised, expectStatus: "completed" });
  // rule 8: the customer's file holds Arabic values only: no true / false, no language code
  const cells = await cellsOf(r);
  expect(cells.some((c) => /^(true|false)$/i.test(c.trim())), "true/false in the file").toBe(false);
  expect(cells.some((c) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(c.trim())), "a language code in the file").toBe(false);
  // rule 8 on the plan card's sample table
  const sample = (r.planView.samples?.rows ?? []).flat();
  expect(sample.some((c) => /^(true|false)$/i.test(c.trim()))).toBe(false);
  expect(sample.some((c) => /^\d+([.,]\d+)?$/.test(c.trim()))).toBe(false);
}

describe("1. Facebook: «هات منشورات صفحة العربية على فيسبوك عن الذكاء الاصطناعي آخر ٣ شهور، ومع كل منشور كل التعليقات وكل الردود»", () => {
  const run = () => runBench(fbWorld());
  it("replies come from the platform's replies tool, read only for the comments that have replies; the promise is the counters of the two chosen posts (comments and replies together) and it is delivered", async () => {
    expect(FB.REQUEST).toBe("هات منشورات صفحة العربية على فيسبوك عن الذكاء الاصطناعي آخر ٣ شهور، ومع كل منشور كل التعليقات وكل الردود");
    const r = await run();
    const plan = planOf(r);
    const comments = plan.stages.find((s) => s.key === "comments")!;
    const replies = plan.stages.find(isRepliesStage)!;
    // rule 6: the catalog's replies tool of the platform
    expect(replies, "a replies stage").toBeDefined();
    expect(replies.endpoint_id).toBe(FB.REPLIES);
    expect(loadTregCatalog().byId.get(replies.endpoint_id)?.platform).toBe("facebook");
    expect(plan.replies_status).toBeUndefined();
    // the customer gave a period («آخر ٣ شهور»): the posts are not chosen by engagement (rule 2: unless the customer gives a date): the source's order, the first two that have comments (post 1 has none, post 2 has one reply only)
    const posts = plan.stages.find((s) => s.key === "posts")!;
    expect(posts.chosen_most_engaged).toBeUndefined();
    expect((posts.pinned_rows ?? []).map((row) => String(row.url))).toEqual([0, 3].map((i) => `https://www.facebook.com/AlArabiya/posts/${1000 + i}`));
    // rule 1: the promise is the counters of the chosen posts (4 and 7): comments + replies = 11, never an estimate on top
    const promised = 2 + FB.COUNTERS[0] + FB.COUNTERS[3];
    expect(comments.planned_rows + replies.planned_rows).toBe(FB.COUNTERS[0] + FB.COUNTERS[3]);
    const topLevel = fbCommentsOf(0).length + fbCommentsOf(3).length;
    expect(counts(r).stage_2_rows).toBe(topLevel);
    expect(counts(r).stage_3_rows).toBe(fbRepliesTotal(0) + fbRepliesTotal(3));
    // rule 6: replies are read only for the comments whose own counter is above zero
    expect(callsTo(r, FB.REPLIES)).toBe(fbRepliesTotal(0) + fbRepliesTotal(3));
    await sharedChecks(r, { promised });
  });
});

describe("2. YouTube: «هات فيديوهات نهائي كأس السوبر المصري بين الأهلي والزمالك من القنوات الرسمية للقنوات الناقلة، ومع كل فيديو كل التعليقات وكل الردود»", () => {
  it("replies come from the platform's replies tool through each comment's own reply token, read only for comments that have replies; every promise is delivered", async () => {
    expect(YT.REQUEST).toBe("هات فيديوهات نهائي كأس السوبر المصري بين الأهلي والزمالك من القنوات الرسمية للقنوات الناقلة، ومع كل فيديو كل التعليقات وكل الردود");
    const r = await runBench(ytWorld());
    const plan = planOf(r);
    const replies = plan.stages.find(isRepliesStage)!;
    expect(replies, "a replies stage").toBeDefined();
    expect(loadTregCatalog().byId.get(replies.endpoint_id)?.platform).toBe("youtube");
    expect(plan.replies_status).toBeUndefined();
    // the videos are the official channels' (the unofficial re-upload is not chosen), their comments and the replies of the comments that have one
    const videos = plan.stages.find((s) => s.key === "videos")!;
    expect((videos.pinned_rows ?? []).every((row) => YT.CHANNELS.includes(String(row.author)))).toBe(true);
    const total = (i: number) => ytCommentsOf(i).length;
    expect(counts(r).stage_2_rows).toBe(total(0) + total(1));
    expect(counts(r).stage_3_rows).toBe(ytRepliesTotal(0) + ytRepliesTotal(1));
    expect(callsTo(r, replies.endpoint_id)).toBe(ytRepliesTotal(0) + ytRepliesTotal(1));
    const promised = 2 + total(0) + total(1) + ytRepliesTotal(0) + ytRepliesTotal(1);
    await sharedChecks(r, { promised });
  });
});

describe("3. TikTok: «هات فيديوهات تيك توك بالعربي عن الذكاء الاصطناعي، من مصر أو المنطقة العربية، ومع كل فيديو كل التعليقات وكل الردود»", () => {
  const REQUEST_3 = "هات فيديوهات تيك توك بالعربي عن الذكاء الاصطناعي، من مصر أو المنطقة العربية، ومع كل فيديو كل التعليقات وكل الردود";
  it("the country and the language come first (the tool that has a country field wins, the matching videos are chosen, then the most commented among them), the query carries the meaning «about», replies are read only for comments that have replies, and the promise (the counters) is delivered", async () => {
    const r = await runS4({ conditions: true, request: REQUEST_3, arabRegion: true });
    const plan = planOf(r);
    const videos = plan.stages.find((s) => s.key === "videos")!;
    // rule 3: the tool has a country input and it is written; the engagement order is only inside the matching results (the English global videos of the most-liked order are never chosen)
    expect(videos.endpoint_id).toBe("tikhub.tiktok.search.videos");
    expect(videos.engine?.params.region).toBe("EG");
    expect((videos.pinned_rows ?? []).map((row) => String(row.id))).toEqual([vid(0), vid(1)]);
    // the several countries are not enforced by a tool whose input takes one: the card says so
    expect(JSON.stringify(videos.engine?.gaps ?? [])).toContain("country");
    // rule 4: «عن الذكاء الاصطناعي» is about: the explainer wording is in the query
    expect(String(videos.engine?.params.keyword)).toContain("شرح");
    // rule 6: replies only for comments with a counter above zero; rule 1: comments + replies = the counters (66 + 33)
    const comments = plan.stages.find((s) => s.key === "comments")!;
    const replies = plan.stages.find(isRepliesStage)!;
    expect(comments.planned_rows + replies.planned_rows).toBe(99);
    expect(callsTo(r, "anyapi.tiktok.comment_replies")).toBe(counts(r).stage_3_rows);
    await sharedChecks(r, { promised: 2 + 99 });
  });
});

describe("4. Instagram: «هات منشورات حساب @alhadath على إنستجرام، ومع كل منشور كل التعليقات وكل الردود»", () => {
  const REQUEST_4 = "هات منشورات حساب @alhadath على إنستجرام، ومع كل منشور كل التعليقات وكل الردود";
  it("the posts are the most commented of the account's recent posts (two pages read), the catalog's comment-replies tool reads the replies of the comments that have one, and the promise is delivered", async () => {
    const r = await runS11({ request: REQUEST_4 });
    const plan = planOf(r);
    const posts = plan.stages.find((s) => s.key === "posts")!;
    expect(posts.chosen_most_engaged).toBe(true);
    expect((posts.pinned_rows ?? []).map((row) => String(row.url))).toEqual([postUrl(16), postUrl(6)]);
    expect(posts.title_ar.startsWith("أحدث")).toBe(false);
    const replies = plan.stages.find(isRepliesStage)!;
    expect(replies.endpoint_id).toBe(S11_REPLIES);
    expect(plan.replies_status).toBeUndefined();
    const delivered = 2 + topLevelOf(16) + topLevelOf(6) + counts(r).stage_3_rows;
    // rule 6: this comments tool gives no reply counter, so (counters do not exist) every comment is read once for its replies: one call a comment, priced in the plan; with counters only the comments that have replies are read (the TikTok, Facebook and YouTube tests)
    expect(callsTo(r, S11_REPLIES)).toBe(topLevelOf(16) + topLevelOf(6));
    await sharedChecks(r, { promised: delivered });
  });
});

describe("5. X: «هات ٢٠ تغريدة فيها «العاصمة الإدارية» بالعربي في أكتوبر ٢٠٢٦، مع الردود»", () => {
  it("the query carries the Cairo-day boundaries of October in UTC with the right offset, the replies are kept and marked (not excluded), the tweet of 2026-11-01 00:14 Cairo is never asked for, and 20 of 20 are delivered", async () => {
    expect(X5.REQUEST).toBe("هات ٢٠ تغريدة فيها «العاصمة الإدارية» بالعربي في أكتوبر ٢٠٢٦، مع الردود");
    const r = await runBench(xWorld());
    const plan = planOf(r);
    const stage = plan.stages[0];
    const stored = String(stage.engine?.params.query);
    // rule 5: Cairo-day boundaries (Egypt's summer time ended 2026-10-29), once each, the model's own day-only operators replaced
    expect(stored.match(/since:2026-09-30_21:00:00_UTC/g)?.length).toBe(1);
    expect(stored.match(/until:2026-10-31_22:00:00_UTC/g)?.length).toBe(1);
    expect(stored).not.toMatch(/until:2026-10-31(\s|$)/);
    expect(stored).toContain("lang:ar");
    expect(stored).toContain('"العاصمة الإدارية"');
    expect(stage.engine?.params.queryType).toBe("Latest");
    for (const q of xQueriesSeen.slice(1)) { expect(q).toContain("until:2026-10-31_22:00:00_UTC"); }
    // «مع الردود»: replies are NOT excluded; the rows that are replies are delivered and marked
    expect((stage.filters ?? []).some((f) => f.kind === "exclude_replies" && f.enabled !== false)).toBe(false);
    const cells = await cellsOf(r);
    expect(cells).toContain("رد");
    expect(cells).toContain("أصلي");
    // 20 of 20, none outside October in Cairo
    expect(counts(r).stage_1_rows).toBe(20);
    expect(cells.some((c) => /status\/1999999/.test(c))).toBe(false);
    await sharedChecks(r, { promised: 20 });
  });
});
