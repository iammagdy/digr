import { describe, expect, it } from "vitest";
import type { MemoryStore } from "../agent/src/memoryStore";
import { readWorkbook } from "./helpers/agentReplay";
import { FIXTURE, runS6 } from "./helpers/s6World";

/**
 * S6, the live test of 2026-11-02 ~12:23 Cairo (docs/S1-LIVE-FINDINGS.md, S6): the counters were 329 and 163 (492 = the promise); 237 comments and replies were delivered (194 and 43 rows); the comments sheet had no language column; the completion text said «بعض الفيديوهات عليها ردود أقل...» with no number.
 * The world is built from the stored facts of that mission (tests/fixtures/live/msn_6066498b-live.json: rows per call, the cursor chain, the duplicates), not an invented world.
 *  1. A tool that ends before the promised count is not the end: the stage continues with the next tools until the promised count or until every tool has ended.
 *  2. When the source truly ends early, the completion text says so with the real numbers.
 *  3. The comments sheet has the comment language, in Arabic, whatever the text column is called («comments» in the live plan).
 */
const run = (o = {}) => runS6(o);
const resultOf = (r: Awaited<ReturnType<typeof run>>) => (r.store as MemoryStore).events.find((e) => e.kind === "result")!.counts as Record<string, number>;
const callsOf = (r: Awaited<ReturnType<typeof run>>) => (r.call.mock.calls as Array<[{ endpointId: string; params: Record<string, unknown> }]>).map((c) => c[0]);

describe("the stored facts of the live mission", () => {
  it("video 1: 8 calls of 19, 20, 20, 20, 20, 20, 20 and 7 rows, the cursor chain 20 ... 140, 7 repeated ids: 139 unique comments; video 2: 11", () => {
    expect(FIXTURE.videos[0].commentCalls.rowsPerCall.reduce((a, b) => a + b, 0)).toBe(146);
    expect(FIXTURE.videos[0].commentCalls.savedComments).toBe(139);
    expect(FIXTURE.videos[1].commentCalls.savedComments).toBe(11);
    expect(FIXTURE.videos.map((v) => v.counter)).toEqual([329, 163]);
  });
});

describe("1. keep reading until the promised count or the real source end", () => {
  it("the first tool ends at 139 of 329: the next tool gives 100 more comments for each video: they are read and delivered, not dropped at the first tool's end", async () => {
    const r = await run({ extraFromNextTool: 100 });
    const tikhub = callsOf(r).filter((c) => c.endpointId === "tikhub.tiktok.video.comments");
    expect(tikhub.length).toBe(9);
    expect(callsOf(r).some((c) => c.endpointId === "crawl4ai.tiktok.video.comments" && c.params.post !== undefined)).toBe(true);
    const result = resultOf(r);
    expect(result.stage_2_rows).toBe(139 + 100 + 11 + 100);
  });
  it("every tool ends where the live source ended (139 and 11): everything the source has is delivered, the promised count is not reached, and the replies of every comment that has some are read (87)", async () => {
    const r = await run({ extraFromNextTool: 0 });
    const result = resultOf(r);
    expect(result.stage_2_rows).toBe(150);
    expect(result.stage_3_rows).toBe(87);
  });
});

describe("2. when the source truly ends early the text says so, with the real numbers", () => {
  it("the completion text names the numbers: 237 of the promised 492 comments and replies, and that the platform's counter includes items the source does not give", async () => {
    const r = await run({ extraFromNextTool: 0 });
    const text = String(r.mission.summary_ar ?? "");
    expect(text).toContain("٢٣٧");
    expect(text).toContain("٤٩٢");
    expect(text).toContain("المصدر");
    expect(text).not.toMatch(/ردود أقل من العدد المطلوب لكل/);
    expect(r.notices[0].kind).toBe("partial");
  });
  it("a delivery that reaches the promise says nothing of a shortfall", async () => {
    // the next tool gives the missing 177 + 131 comments (the promise is the counters: 329 + 163 = 492 comments and replies)
    const r = await run({ extraFromNextTool: 140 });
    const text = String(r.mission.summary_ar ?? "");
    expect(text).not.toContain("٢٣٧");
  });
});

describe("3. the comments sheet has the comment language, in Arabic", () => {
  it("the column «لغة التعليق» with Arabic labels, and the comment text (a column called «comments») is in the sheet", async () => {
    const r = await run({ extraFromNextTool: 0 });
    const wb = await readWorkbook(r);
    const sheet = wb.worksheets.find((s) => /تعليق/.test(s.name) && !/فيديو/.test(s.name)) ?? wb.worksheets[1];
    const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
    const lang = header.indexOf("لغة التعليق");
    expect(lang).toBeGreaterThan(0);
    const labels = new Set<string>();
    sheet.eachRow((row, n) => { if (n > 1) labels.add(String(row.getCell(lang).value ?? "")); });
    expect([...labels].every((v) => ["العربية", "لغة أخرى", "غير محددة"].includes(v))).toBe(true);
    expect(labels.has("العربية")).toBe(true);
  });
});
