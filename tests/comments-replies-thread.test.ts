import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook } from "./helpers/agentReplay";
import { LIVE_WORLD, cid, link, runG4, vid } from "./helpers/g4RepliesWorld";
import { COMMENT_KIND_COMMENT_AR, COMMENT_KIND_REPLY_AR, COMMENT_KIND_TITLE_AR, REPLY_TO_TITLE_AR } from "../src/lib/agentMission/taskContracts";
import { parentCounterLinesAr } from "../agent/src/threadCounters";
import { SUMMARY_SHEET_AR } from "../src/lib/modelPlanner/missionWorkbook";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * REPLIES, item 4: THE THREAD SHEET AND THE LIMITS THAT RECONCILE. The comments and their replies are ONE table: a column «نوع التعليق» («تعليق» / «رد»), a reply's «معرّف التعليق الأصلي», the parent video's title and link on every row, a reply right under its comment. The file states the
 * source's own counter next to what was delivered, from the recorded counts and the task's nouns («عداد الفيديو ٢٥، سُلّم تعليق واحد و٢٣ ردًا»).
 */
const cell = (row: any, i: number): string => { const v = row.getCell(i).value as any; return String(v?.text ?? v ?? "").trim(); };

async function sheetOf() {
  const r = await runG4(LIVE_WORLD);
  const wb = await readWorkbook(r);
  const sheet = wb.worksheets.find((s) => /تعليقات/.test(s.name) && s.name !== SUMMARY_SHEET_AR)!;
  const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
  const at = (title: string): number => { const i = header.indexOf(title); expect(i, `${title} in ${header.join("|")}`).toBeGreaterThan(0); return i; };
  return { r, wb, sheet, header, at, rows: Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2)) };
}

describe("the thread sheet: comments and replies in one table", () => {
  it("has no sheet of its own for the replies; the sheet holds the 9 comments and the 33 replies, and the count the customer is charged for is the rows of the file", async () => {
    const { r, wb, rows } = await sheetOf();
    expect(wb.worksheets.some((s) => /ردود/.test(s.name))).toBe(false);
    expect(rows).toHaveLength(42);
    assertReplayInvariants(r, { expectDelivered: 47, expectStatus: "partial" });
    // the number in the store, the file and the memory agree: no internal flag was raised
    expect(String(r.mission.error ?? "")).not.toMatch(/file_differs|memory_differs/);
  });

  it("says what each row is in «نوع التعليق», and names the comment a reply answers in «معرّف التعليق الأصلي» (empty on a comment)", async () => {
    const { rows, at } = await sheetOf();
    const kind = at(COMMENT_KIND_TITLE_AR);
    const replyTo = at(REPLY_TO_TITLE_AR);
    const kinds = rows.map((row) => cell(row, kind));
    expect(kinds.filter((k) => k === COMMENT_KIND_COMMENT_AR)).toHaveLength(9);
    expect(kinds.filter((k) => k === COMMENT_KIND_REPLY_AR)).toHaveLength(33);
    for (const row of rows) { if (cell(row, kind) === COMMENT_KIND_COMMENT_AR) expect(cell(row, replyTo)).toBe(""); }
    const commentIds = new Set(rows.filter((row) => cell(row, kind) === COMMENT_KIND_COMMENT_AR).map((row) => cell(row, at("المعرّف"))));
    for (const row of rows) if (cell(row, kind) === COMMENT_KIND_REPLY_AR) expect(commentIds.has(cell(row, replyTo)), cell(row, replyTo)).toBe(true);
  });

  it("puts every reply right under its comment (the source's order), and the parent video's link and title on EVERY row, replies included", async () => {
    const { rows, at } = await sheetOf();
    const kind = at(COMMENT_KIND_TITLE_AR);
    const replyTo = at(REPLY_TO_TITLE_AR);
    const idCol = at("المعرّف");
    const videoLink = at("رابط الفيديو");
    const videoText = at("وصف الفيديو");
    let currentComment = "";
    for (const row of rows) {
      expect(cell(row, videoLink)).toMatch(/^https:\/\/www\.tiktok\.com\//);
      expect(cell(row, videoText)).not.toBe("");
      if (cell(row, kind) === COMMENT_KIND_COMMENT_AR) currentComment = cell(row, idCol);
      else expect(cell(row, replyTo), cell(row, idCol)).toBe(currentComment);
    }
    // the one comment of the live video with its 23 replies: the video's link on all 24 rows
    const ofLive = rows.filter((row) => cell(row, videoLink) === link(0));
    expect(ofLive).toHaveLength(24);
    expect(cell(ofLive[0], idCol)).toBe(cid(vid(0), 0));
  });

  it("the first sheet's row of the replies stage points to the thread sheet, with its own count", async () => {
    const { wb, sheet } = await sheetOf();
    const summary = wb.getWorksheet(SUMMARY_SHEET_AR)!;
    const line = Array.from({ length: summary.rowCount }, (_, i) => summary.getRow(i + 1)).map((row) => Array.from({ length: 5 }, (_, c) => cell(row, c + 1)))
      .find((cells) => /ردود/.test(cells[0]))!;
    expect(line).toBeTruthy();
    expect(line[1]).toBe(sheet.name);
    expect(Number(line[2])).toBe(33);
  });
});

describe("the source's own counter next to what was delivered", () => {
  it("the live video: one comment and 23 replies against a counter of 25 (a difference of 1 the source did not give)", () => {
    const lines = parentCounterLinesAr({
      parentNoun: "فيديو",
      parents: [{ id: "p0", counter: 25 }],
      commentParentIds: ["p0"],
      replyParentCommentIds: Array.from({ length: 23 }, () => "c0"),
      commentToParent: new Map([["c0", "p0"]]),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].counterLine).toBe("عداد الفيديو ٢٥، سُلّم تعليق واحد و٢٣ ردًا");
    expect(lines[0].limitLine).toContain("عداد الفيديو ٢٥، سُلّم تعليق واحد و٢٣ ردًا");
    expect(lines[0].limitLine).toContain("لم يعطِه المصدر");
    for (const l of [lines[0].counterLine, lines[0].limitLine]) { expect(checkCustomerText(l, { maxChars: 400 }).issues).toEqual([]); expect(l).not.toMatch(/[0-9]/); }
  });

  it("a parent whose delivery covers its counter has a counter line and no limit; a parent with no counter has no line at all", () => {
    const lines = parentCounterLinesAr({
      parentNoun: "فيديو",
      parents: [{ id: "p1", counter: 4 }, { id: "p2", counter: null }],
      commentParentIds: ["p1", "p1", "p2"],
      replyParentCommentIds: ["c1", "c1"],
      commentToParent: new Map([["c1", "p1"]]),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].counterLine).toBe("عداد الفيديو ٤، سُلّم تعليقان وردان");
    expect(lines[0].limitLine).toBeNull();
  });
});

describe("the live replay says it in the file", () => {
  it("«حدود هذا التسليم» carries the reconciliation of the live video (counter 25: 1 comment and 23 replies), and the file lists every video's counter against what it delivered", async () => {
    const { wb } = await sheetOf();
    const summary = wb.getWorksheet(SUMMARY_SHEET_AR)!;
    const texts = Array.from({ length: summary.rowCount }, (_, i) => summary.getRow(i + 1)).map((row) => `${cell(row, 1)} ${cell(row, 2)}`);
    const all = texts.join("\n");
    expect(all).toContain("عداد الفيديو ٢٥، سُلّم تعليق واحد و٢٣ ردًا");
    expect(all).toContain("عدّاد المصدر وما سُلّم");
  });
});

describe("the planner is told what the replies need", () => {
  it("the prompt says the replies are code's and asks the comment's reply counter under the key replies_count", () => {
    const prompt = readFileSync("agent/prompts/system.md", "utf-8");
    expect(prompt).toContain("THE REPLIES OF THE COMMENTS ARE CODE'S");
    expect(prompt).toMatch(/map it on EVERY comment row under the key `replies_count`/);
  });
});
