import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook } from "./helpers/agentReplay";
import { FULL_WORLD, LIVE_WORLD, callsOf, cid, idOfParams, isReplySource, runG4, vid } from "./helpers/g4RepliesWorld";

/**
 * G4 WITH ITS REPLIES (live msn_3da66037878465ffbfd5, TikTok, «٥ فيديوهات عن منتخب مصر ومن كل فيديو ١٠ تعليقات»): the live shape. Video 7699049713550593300 showed 25 in its own comment counter and delivered ONE comment, because the comments source gives the top-level comments only and the
 * replies (the rest of the counter) were never fetched. Owner decision: child items are delivered raw and researchers analyse FULL threads, so the replies are fetched too, by the cheapest ranked reply source, and ONLY for a comment whose own reply counter is above 0.
 * The world (tests/helpers/g4RepliesWorld.ts) has the live endpoints and shapes.
 */

describe("G4 with its replies, in the live shape", () => {
  it("fetches the replies of every comment that says it has some, with the cheapest ranked reply source, and none for a comment whose reply counter is 0", async () => {
    const r = await runG4();
    const reads = callsOf(r).filter((c) => isReplySource(c.endpointId));
    expect(reads.length).toBeGreaterThan(0);
    // one source for the whole stage: the cheapest ranked one of the catalog
    expect(new Set(reads.map((c) => c.endpointId)).size).toBe(1);
    const asked = new Set(reads.map((c) => idOfParams(c.params)));
    // the five comments that have replies were asked for; the four with a counter of 0 never were
    expect([...asked].sort()).toEqual([cid(vid(0), 0), cid(vid(1), 0), cid(vid(1), 2), cid(vid(2), 0), cid(vid(4), 0)].sort());
    const zero = Object.entries(LIVE_WORLD.commentsOf).flatMap(([v, list]) => list.map((n, k) => ({ id: cid(v, k), n }))).filter((x) => x.n === 0);
    expect(zero.length).toBeGreaterThan(0);
    for (const z of zero) expect(asked.has(z.id), z.id).toBe(false);
  });

  it("delivers the top-level comments AND their replies: 5 videos, 9 comments and 33 replies (23 of the 24 counted on the live video's one comment), and charges for exactly those 47 rows", async () => {
    const r = await runG4();
    assertReplayInvariants(r, { expectDelivered: 47, expectStatus: "partial" });
    const wb = await readWorkbook(r);
    // the rows of the file (every sheet after the summary): 5 videos + 9 comments + 33 replies, however the sheets are laid out
    const rows = wb.worksheets.slice(1).reduce((n, sheet) => n + sheet.rowCount - 1, 0);
    expect(rows).toBe(47);
  });

  it("the plan has the replies as a stage of their own under the comments, priced with the plan (the price covers them)", async () => {
    const r = await runG4();
    const stage = r.plannedPlan.stages.find((s) => /replies/.test(s.key))!;
    expect(stage).toBeTruthy();
    expect(stage.parent_key).toBe("comments");
    expect(stage.deliver).toBe(true);
    expect(stage.engine?.endpoint_id).toMatch(/repl/i);
    expect(r.plannedPlan.price.deliveredRows).toBe(r.plannedPlan.stages.filter((s) => s.deliver).reduce((n, s) => n + s.planned_rows, 0));
  });

  it("the card says the number counts the comments only and the replies come in addition, in Arabic, before the customer approves", async () => {
    const r = await runG4();
    const notes = (r.planView.notesAr ?? []) as string[];
    expect(notes.some((n) => n.includes("التعليقات الأساسية") && n.includes("ردودها") && n.includes("السعر"))).toBe(true);
  });

  it("the top-level delivery is COMPLETE and the replies come in below the estimate: the mission is completed, not partial, and the notice says so", async () => {
    const r = await runG4(FULL_WORLD);
    const replies = r.plannedPlan.stages.find((s) => /replies/.test(s.key))!;
    // 5 videos + 50 comments + 50 replies (each comment says two, the source gives one): below the 100 replies the plan estimated
    assertReplayInvariants(r, { expectDelivered: 105, expectStatus: "completed" });
    expect(replies.planned_rows).toBeGreaterThan(50);
    expect(r.notices[0].kind).toBe("completed");
    expect(String(r.mission.summary_ar ?? "")).not.toMatch(/لم يكتمل|أقل مما طلبت/);
  });

  it("a top-level shortfall is told against the top-level rows, with the replies delivered added to both sides (never «٤٧ من ٥٥»)", async () => {
    const r = await runG4();
    expect(r.notices[0].kind).toBe("partial");
    const facts = r.notices[0].facts as { delivered: number; planned: number };
    expect(facts.delivered).toBe(47);
    // 55 top-level rows planned (5 videos + 50 comments) + the 33 replies delivered
    expect(facts.planned).toBe(55 + 33);
  });
});
