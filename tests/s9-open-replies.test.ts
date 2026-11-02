import { describe, expect, it } from "vitest";
import { readWorkbook, REPLAY_USER, assertReplayInvariants } from "./helpers/agentReplay";
import { runS4, LIVE9_COUNTERS } from "./helpers/s4World";
import { editPlanForCustomer, loadCustomerMission } from "../src/lib/agentMission/customerActions";
import { isRepliesStage } from "../src/lib/agentMission/replies";
import { withRepliesJudged } from "../src/lib/agentMission/repliesCard";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * S9, the live test of 2026-11-02 ~14:19 Cairo (docs/S1-LIVE-FINDINGS.md, S9): the request was edited to 150 comments per video; the data was right (2 videos about AI, Egypt, Arabic; 300 of 300 comments; the reply counters of those 300 comments sum to 40 and 40 replies were delivered), but the plan kept an
 * ESTIMATE of the replies (318) as if it were a promise, so the customer notice said «تم تسليم ٣٤٢ من ٦٢٠» while the file summary said «٣٤٢ من ٣٤٢».
 * Owner rule: when the comments per video are fewer than the video's counter, no reply NUMBER is promised from an estimate: the plan says «كل الردود على التعليقات المختارة» and prices the estimate only as a maximum; after the delivery the replies are judged against the reply counters of the
 * DELIVERED comments, and the notice, the card and the file summary show the same numbers.
 * The world is the live mission's numbers: counters 400 and 380 (far above 150), 150 comments per video in the source, 20 comments per video with one reply (counters sum 40), 40 replies in the source.
 */
const ALL_REPLIES_AR = "كل الردود على التعليقات المختارة";
const edit150 = async ({ client, missionId }: { client: never; missionId: string }, out: { card?: Awaited<ReturnType<typeof loadCustomerMission>> }) => {
  const r = await editPlanForCustomer(client, { id: missionId, userId: REPLAY_USER, edits: { stages: [{ key: "comments", per_parent: 150 }] } });
  if (!r.ok) throw new Error(`the edit was refused: ${JSON.stringify(r)}`);
  out.card = await loadCustomerMission(client, { id: missionId, userId: REPLAY_USER });
};
const world = async () => {
  const out: { card?: Awaited<ReturnType<typeof loadCustomerMission>> } = {};
  const r = await runS4({ live9: true, beforeApproval: (ctx) => edit150(ctx as never, out) });
  return { r, out };
};

describe("the plan after the edit: replies are «all the replies of the chosen comments», with no number from an estimate", () => {
  it("the replies stage is open: the card says «كل الردود على التعليقات المختارة», names no reply count, and the estimate stays in the price as a maximum", async () => {
    const { r, out } = await world();
    const stored = r.mission.plan as unknown as PricedPlan;
    const replies = stored.stages.find(isRepliesStage)!;
    const comments = stored.stages.find((s) => s.key === "comments")!;
    expect(comments.planned_rows).toBe(300);
    expect(replies.replies_open).toBe(true);
    // the estimate is still what the price is made from (a maximum), never zero
    expect(replies.planned_rows).toBeGreaterThan(0);
    expect(stored.price.deliveredRows).toBe(2 + 300 + replies.planned_rows);
    const view = (out.card as { view: { stages: Array<{ titleAr: string; rowsAr: string }>; notesAr: string[]; totalRowsAr: string } }).view;
    const line = view.stages.find((s) => s.titleAr.startsWith("ردود"))!;
    expect(line.rowsAr).toBe(ALL_REPLIES_AR);
    const text = JSON.stringify(view.notesAr);
    expect(text).toContain(ALL_REPLIES_AR);
    expect(text).not.toContain(String(replies.planned_rows));
    // the total the card shows is the videos and the comments: no reply estimate is in it
    expect(view.totalRowsAr).not.toContain(String(2 + 300 + replies.planned_rows));
  });
});

describe("the live numbers: 300 comments, reply counters 40, 40 replies delivered → «تم تسليم ٣٤٢ من ٣٤٢» in the notice, the card and the file summary", () => {
  it("one number everywhere", async () => {
    const { r } = await world();
    expect(r.mission.status).toBe("completed");
    expect(r.mission.delivered_units).toBe(342);
    const final = r.finalView.resultLinesAr.join(" ");
    expect(final).toContain("تم تسليم ٣٤٢ من ٣٤٢");
    expect(final).not.toContain("٦٢٠");
    expect(r.finalView.phase).toBe("done");
    // the notice
    expect(r.notices[0].kind).toBe("completed");
    expect(r.notices[0].facts.delivered).toBe(342);
    expect(r.notices[0].facts.planned).toBe(342);
    // the file summary
    const wb = await readWorkbook(r);
    const summary = wb.worksheets[0];
    const texts: string[] = [];
    summary.eachRow((row) => row.eachCell((c) => { if (typeof c.value === "string") texts.push(c.value); }));
    expect(texts.some((t) => t.includes("تم تسليم ٣٤٢ من ٣٤٢"))).toBe(true);
    expect(texts.some((t) => t.includes("٦٢٠"))).toBe(false);
    // the replies row of the file summary says the real number too (not the estimate)
    expect(summary.getRow(4).values).toBeDefined();
  });
  it("the money is untouched: the charge is the rows delivered at the plan's unit price, never an estimate", async () => {
    const { r } = await world();
    assertReplayInvariants(r, { expectDelivered: 342, expectStatus: "completed" });
    const unit = Number(r.mission.unit_price_points);
    expect(Number(r.mission.charged_points)).toBe(Math.ceil(342 * unit - 1e-9));
  });
  it("the world is the live one: the counters of the chosen videos are far above 150", () => {
    expect(LIVE9_COUNTERS.slice(0, 2).every((n) => n > 150)).toBe(true);
  });
});

describe("after the delivery the replies are judged against the reply counters of the DELIVERED comments", () => {
  const stage = (o: Record<string, unknown>) => ({ expected_rows: 0, deliver: true, columns: [], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.0001, measured_from_calls: [], parent_key: null, endpoint_id: "x", ...o });
  const plan = { stages: [stage({ key: "comments", title_ar: "تعليقات", planned_rows: 300 }), stage({ key: "replies", title_ar: "ردود تعليقات", planned_rows: 318, replies_of: "comments", replies_open: true, per_parent_rows: 10 })] } as unknown as PricedPlan;
  const comments = (counters: number[]) => counters.map((n, i) => ({ id: `c${i}`, replies_count: n }));
  it("the counters of the delivered comments are the promise (40), the estimate (318) is dropped, and the stage is no longer open", () => {
    const judged = withRepliesJudged(plan, { comments: comments([...Array(40).fill(1), ...Array(260).fill(0)]), replies: Array(40).fill({}) as never });
    const r = judged.stages.find(isRepliesStage)!;
    expect(r.planned_rows).toBe(40);
    expect(r.replies_open).toBeUndefined();
  });
  it("a comment's counter above the replies read per comment counts only up to that number", () => {
    const judged = withRepliesJudged(plan, { comments: comments([25, 3]), replies: [] as never });
    expect(judged.stages.find(isRepliesStage)!.planned_rows).toBe(13);
  });
  it("a plan with no open replies is returned as it is", () => {
    const closed = { stages: plan.stages.map((s) => ({ ...s, replies_open: undefined })) } as unknown as PricedPlan;
    expect(withRepliesJudged(closed, { comments: comments([5]), replies: [] as never })).toBe(closed);
  });
});
