import { describe, expect, it } from "vitest";
import { assertReplayInvariants } from "./helpers/agentReplay";
import { COMMENTS_TOOL, COUNTERS, PAGE_ONE, POSTS_TOOL, REPLIES_TOOL, postUrl, runS11, topLevelOf, hasReply } from "./helpers/s11World";
import { isPeopleStage } from "../src/lib/agentMission/people";
import { isRepliesStage } from "../src/lib/agentMission/replies";
import { formatSampleCell } from "../src/lib/customerDates";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * S11, the live test of 2026-11-02 ~15:36 Cairo (docs/S1-LIVE-FINDINGS.md, S11): «هات منشورين من حساب الحدث على إنستجرام (alhadath)، مع كل التعليقات والردود.» Delivered as planned but weak: the two NEWEST posts (minutes old) with one comment in all, replies stated as «not available», the 200-point minimum for 3 items, and
 * a sample table that said «false» and showed Western digits. Causes (V from the stored plan): the stage title «التعليقات الرئيسية على المنشورين» was read as a PEOPLE stage («الرئيسية» starts with the people stem «رئيس»), so no replies stage, no complete count and no most-engaged choice
 * were made for it; and a stage that reads ONE named account's listing was never marked built by code, so a mission with it never ran the new pipeline (pinned posts were ignored).
 * Owner rules: the most-engaged default applies to the posts of an account (the most commented among its recent posts, several pages) unless the customer asks for the newest or gives a date; Instagram replies use the catalog's comment-replies tool when one exists; the customer's sample table holds Arabic values only.
 */
const run = () => runS11();
type Run = Awaited<ReturnType<typeof run>>;
const resultOf = (r: Run) => (r.store.events as Array<{ kind: string; counts?: Record<string, number> }>).find((e) => e.kind === "result")!.counts!;

describe("a stage title is not a people stage because it says «main»", () => {
  it("«التعليقات الرئيسية على المنشورين» (the live title) and the other «main» titles are not people stages", () => {
    for (const title of ["التعليقات الرئيسية على المنشورين", "التعليقات الرئيسية", "الردود الرئيسية", "المنشورات الرئيسية", "التعليقات الرئيسيين"]) expect(isPeopleStage({ parent_key: "p", title_ar: title }), title).toBe(false);
  });
  it("the people titles still are: «رئيس الشركة», «مديرو الشركات», «صناع القرار»", () => {
    for (const title of ["رئيس كل شركة", "مديرو الشركات", "صناع القرار في كل شركة", "المسؤولون عن كل شركة"]) expect(isPeopleStage({ parent_key: "p", title_ar: title }), title).toBe(true);
  });
});

describe("the customer's sample table holds Arabic values only", () => {
  it("true and false are «نعم» and «لا»", () => {
    expect(formatSampleCell("false")).toBe("لا");
    expect(formatSampleCell("true")).toBe("نعم");
    expect(formatSampleCell(false)).toBe("لا");
    expect(formatSampleCell(true)).toBe("نعم");
  });
  it("a number is written in Arabic-Indic digits, with the Arabic separators", () => {
    expect(formatSampleCell("16")).toBe("١٦");
    expect(formatSampleCell(0)).toBe("٠");
    expect(formatSampleCell("1,234")).toBe("١٬٢٣٤");
    expect(formatSampleCell("12.5")).toBe("١٢٫٥");
  });
  it("a date is written for the customer (as before); a text is left exactly as it is, and an empty cell stays empty", () => {
    expect(formatSampleCell("2026-11-02T13:35:50.000Z")).toMatch(/٢٠٢٦/);
    expect(formatSampleCell("كبير مراسلي الحدث في فلسطين 2026")).toBe("كبير مراسلي الحدث في فلسطين 2026");
    expect(formatSampleCell("")).toBe("");
    expect(formatSampleCell(null)).toBe("");
  });
});

describe("the exact request end to end", () => {
  it("the Instagram replies tool of the catalog exists, and the plan uses it: a replies stage on the comment-replies tool, not the line «الردود غير متاحة»", async () => {
    expect(loadTregCatalog().byId.get(REPLIES_TOOL)?.platform).toBe("instagram");
    const r = await run();
    const plan = r.plannedPlan as PricedPlan;
    const comments = plan.stages.find((s) => s.key === "comments")!;
    const replies = plan.stages.find(isRepliesStage)!;
    expect(isPeopleStage(comments)).toBe(false);
    expect(replies.endpoint_id).toBe(REPLIES_TOOL);
    expect(plan.replies_status).toBeUndefined();
    const text = JSON.stringify([r.planView.assumptionsAr, r.planView.notesAr]);
    expect(text).not.toContain("غير متاحة");
    expect(text).toContain("الردود");
  });
  it("the plan is sent back to read a second page of the account's posts, then chooses the MOST COMMENTED of the 24 recent posts (P16 with 6 and P06 with 4), not the two newest (P00 and P01, minutes old)", async () => {
    const r = await run();
    const proposals = r.planningDriver.results.filter((x) => x.tool === "propose_plan");
    expect(proposals[0].result.ok).toBe(false);
    expect(JSON.stringify(proposals[0].result)).toContain("next page");
    expect(proposals[proposals.length - 1].result.ok).toBe(true);
    const plan = r.plannedPlan as PricedPlan;
    const posts = plan.stages.find((s) => s.key === "posts")!;
    expect((posts.pinned_rows ?? []).map((row) => String(row.url))).toEqual([postUrl(16), postUrl(6)]);
    expect(COUNTERS[16]).toBe(6);
    expect(Math.max(...PAGE_ONE)).toBeLessThan(COUNTERS[16]);
    // the posts are not called «the newest» any more, and the card does not say so
    expect(posts.title_ar.startsWith("أحدث")).toBe(false);
    expect(JSON.stringify(r.planView.assumptionsAr)).not.toContain("الأحدث");
  });
  it("the mission runs on the new pipeline (the account's listing is built by code) and delivers the two chosen posts, their comments and their replies: 2 + 7 + 3", async () => {
    const r = await run();
    const plan = r.plannedPlan as PricedPlan;
    expect(plan.stages.every((s) => s.engine?.built_by === "code")).toBe(true);
    expect((r.store.events as Array<{ counts?: Record<string, unknown> }>).some((e) => e.counts && "pipe_new" in e.counts)).toBe(true);
    const counts = resultOf(r);
    expect(counts.stage_1_rows).toBe(2);
    expect(counts.stage_2_rows).toBe(topLevelOf(16) + topLevelOf(6));
    expect(counts.stage_3_rows).toBe([...Array(topLevelOf(16)).keys(), ...Array(topLevelOf(6)).keys()].filter((k) => hasReply(`x-c${k}`)).length);
    expect(r.mission.delivered_units).toBe(2 + 7 + 3);
    expect(r.mission.status).toBe("completed");
    // only the posts' own pages of the planning were read: the execution reads the chosen posts' comments and replies, never the listing again
    const calls = (r.call.mock.calls as Array<[{ endpointId: string; phase?: string }]>).map((c) => c[0].endpointId);
    expect(calls.filter((id) => id === POSTS_TOOL).length).toBe(2);
    expect(calls.filter((id) => id === COMMENTS_TOOL).length).toBeGreaterThanOrEqual(3);
    expect(calls.some((id) => id === REPLIES_TOOL)).toBe(true);
  });
  it("the money is the plan's unit price over the rows delivered (never an estimate)", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: 12, expectStatus: "completed" });
    expect(Number(r.mission.charged_points)).toBeGreaterThanOrEqual(200);
  });
  it("the sample table of the card holds Arabic values only: no true/false, no Western digit in a number cell", async () => {
    const r = await run();
    const cells = (r.planView.samples?.rows ?? []).flat();
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.some((c) => /^(true|false)$/i.test(c.trim()))).toBe(false);
    expect(cells.some((c) => /^\d+([.,]\d+)?$/.test(c.trim()))).toBe(false);
    expect(cells).toContain("لا");
    const stageRows = (r.planView.stages ?? []).length;
    expect(stageRows).toBeGreaterThan(0);
  });
});
