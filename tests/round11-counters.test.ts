import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler, type CompiledPlanning } from "../agent/src/compiled";
import { buildMissionFiles } from "../agent/src/workbook";
import { cardMapCode, cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { repliesSizing } from "../src/lib/agentMission/foundation/compilePlan";
import { promiseLineAr } from "../src/lib/agentMission/foundation/promise";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import { reportedPlan, withPromiseCaps, withRepliesJudged } from "../src/lib/agentMission/repliesCard";
import { replayGateway } from "./helpers/replayGateway";
import { cellsOf } from "./helpers/round11Worlds";

/**
 * LIVE ROUND 11 (3 Nov 2026), item 2: Instagram `msn_97cdab58dc82fc2039ed`. The file's «عدد الردود» showed 0 on every delivered comment while 9 replies were delivered, and the card said «٠ ردًا بحسب عدّادات ٢٧ تعليقًا قرأناها».
 * The Instagram comments tools carry NO reply counter (the real pages: `replies: null` on every comment row, M15 and M16), so the right word is «غير متاح», never 0. Two defects, both reproduced here on the real M16 pages:
 *   1. `repliesSizing` is fed `Number(row.replies_count)`, and `Number(null)` is 0: every comment whose counter is absent was counted as a comment that has NO replies (27 comments «counted» with a sum of 0) - the card, the hold's estimate and the file's counter all rested on it;
 *   2. a counter the source does not give reached the file as an empty cell / 0 instead of the words «غير متاح».
 * The rule is the same on every platform: a counter a row does not carry is «غير متاح» (compiled plans only); a counter that is there (a real 0 included) is written as it is.
 */
const catalog = loadTregCatalog();
const M16 = "msn_e3e7632e2fb2d42f9c19";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
const UNAVAILABLE = "غير متاح";

async function instagramPlan(): Promise<Extract<CompiledPlanning, { kind: "plan" }>> {
  const store = createMemoryStore();
  const { gateway } = replayGateway(M16, catalog, store, "msn_r11_ig");
  const out = await planByCompiler({ mission: { id: "msn_r11_ig", request_text: fixture.missions.find((m) => m.id === M16)!.request, answer_text: null, created_at: "2026-11-03T12:07:46Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-03T12:08:46Z") });
  if (out.kind !== "plan") throw new Error(`no plan: ${out.kind}`);
  return out;
}

describe("1. a counter that is absent is never counted as 0 (the card, the hold's estimate, the line)", () => {
  it("repliesSizing: comments whose counter is null are UNKNOWN, not comments with no replies", () => {
    const s = repliesSizing({ comments: 38, known: [null, null, null], perComment: 50 });
    expect(s.countedComments).toBe(0);
    expect(s.counted).toBe(0);
  });
  it("the Instagram plan on the real M16 pages: no comment counter was read, so none is «counted» (was: ١٣ تعليقًا بمجموع ٠)", async () => {
    const p = await instagramPlan();
    const replies = p.plan.compiled!.promises.comments_replies!;
    expect(replies.type).toBe("open");
    expect(replies.counted_comments).toBe(0);
    const line = (p.plan.notes_ar ?? []).find((x) => x.startsWith("الردود"))!;
    expect(line).not.toMatch(/٠ ردًا بحسب عدّادات/);
    expect(line).toContain("لا تعرض المنصة عدد الردود على كل تعليق");
    expect(line).not.toMatch(/[0-9]/);
  });
  it("a platform that does give the counters (counted comments > 0) says what it always said", () => {
    expect(promiseLineAr({ type: "open", n: 40, counted: 22, counted_comments: 14 }, "replies", false)).toContain("٢٢ ردًا بحسب عدّادات ١٤ تعليقًا قرأناها");
  });
});

describe("2. the Instagram comments card carries no reply counter: its rows never carry one, whatever the field says", () => {
  const card = cardOf("anyapi.instagram.post.comments")!;
  const real = JSON.parse(readFileSync(new URL(`./fixtures/live/missions/msn_afe9bb0b436670e35a3c/raw/call_0003.json`, import.meta.url), "utf8"));
  it("the real page (`replies: null`) maps to a null counter", () => {
    expect(mapPage(card, real)[0].replies_count ?? null).toBeNull();
  });
  it("a page whose `replies` field is 0 or [] (what a source that does not count says) is not a counter either", () => {
    for (const filler of [0, []]) {
      const page = JSON.parse(JSON.stringify(real));
      page.output.data.comments[0].replies = filler;
      expect(mapPage(card, page)[0].replies_count ?? null, JSON.stringify(filler)).toBeNull();
    }
  });
  it("a card WITH a reply counter (TikTok's comments, YouTube's) still reads it, a real 0 included", () => {
    const tt = cardOf("anyapi.tiktok.video.comments")!;
    const code = cardMapCode(tt);
    expect(code).toContain("reply_comment_total");
  });
});

/** The thread of the live shape: 2 posts, 3 comments (no counter), one reply; plus a comment of a platform that gives its counter. */
async function fileOf(commentCounters: Array<number | null | "">): Promise<{ cells: string[][]; csv: string; head: string[] }> {
  const p = await instagramPlan();
  const plan: PricedPlan = p.plan;
  const posts = (plan.stages[0].pinned_rows as Array<Record<string, unknown>>).slice(0, 2);
  const comments = commentCounters.map((c, i) => ({ id: `c${i}`, parent_id: String(posts[0].id), text: `نص ${i}`, author: "a", posted_at: "2026-11-03T12:00:00.000Z", likes: 0, replies_count: c, language: "" }));
  const replies = [{ id: "r1", parent_id: "c1", text: "رد", author: "b", posted_at: "2026-11-03T12:10:00.000Z", likes: 0, replies_count: null, language: "" }];
  const rows: Record<string, Array<Record<string, unknown>>> = { posts, comments, comments_replies: replies };
  const judged = withRepliesJudged(reportedPlan(withPromiseCaps(plan), Object.fromEntries(plan.stages.map((s) => [s.key, rows[s.key].length]))), rows, () => true);
  const built = await buildMissionFiles(judged, rows, undefined, undefined, { repliesJudged: true });
  const sheets = await cellsOf(built.xlsx);
  const name = Object.keys(sheets).find((n) => /تعليق/.test(n))!;
  const [head, ...body] = sheets[name];
  return { cells: body, csv: built.csv, head };
}

describe("3. the file: «عدد الردود» says «غير متاح» where the source gives no counter, and the number where it does", () => {
  it("every comment of a source with no reply counter reads «غير متاح» (never 0, never an empty cell)", async () => {
    const { cells, head } = await fileOf([null, null, null]);
    const at = head.indexOf("عدد الردود");
    expect(at).toBeGreaterThanOrEqual(0);
    const kindAt = head.indexOf("نوع التعليق");
    const commentRows = cells.filter((r) => r[kindAt] === "تعليق");
    expect(commentRows).toHaveLength(3);
    for (const r of commentRows) expect(r[at]).toBe(UNAVAILABLE);
  });
  it("the same in the CSV", async () => {
    const { csv } = await fileOf([null, "", null]);
    const lines = csv.replace("﻿", "").split("\r\n");
    const at = lines[0].split(",").indexOf('"عدد الردود"');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines.slice(1).filter((l) => l.includes('"تعليق"')).every((l) => l.split(",")[at] === `"${UNAVAILABLE}"`)).toBe(true);
  });
  it("a comment that carries its counter keeps it: 3 is 3 and a real 0 is 0 (the others of the same sheet are «غير متاح»)", async () => {
    const { cells, head } = await fileOf([3, 0, null]);
    const at = head.indexOf("عدد الردود");
    const kindAt = head.indexOf("نوع التعليق");
    expect(cells.filter((r) => r[kindAt] === "تعليق").map((r) => r[at])).toEqual(["3", "0", UNAVAILABLE]);
  });
});
