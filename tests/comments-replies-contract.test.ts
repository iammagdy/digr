import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMMENT_KIND_COMMENT_AR, COMMENT_KIND_KEY, COMMENT_KIND_REPLY_AR, COMMENT_KIND_TITLE_AR, REPLY_TO_KEY, REPLY_TO_TITLE_AR, TASK_CONTRACTS,
} from "../src/lib/agentMission/taskContracts";

/**
 * REPLIES (owner decision, recorded in the HANDOFF: child items are delivered raw; researchers analyse FULL threads). A comments task delivers the top-level comments AND their replies, each reply row carrying the parent comment's id and the parent video or post's link and title,
 * a column «نوع التعليق» («تعليق» / «رد»); the file states the source's own counter next to what was delivered. Item 1 of the replies PR: the reference (audit section 1C) and the contract table.
 */
describe("the comments contract carries the replies", () => {
  it("names the kind column and its two values, and the id of the comment a reply answers", () => {
    expect(COMMENT_KIND_TITLE_AR).toBe("نوع التعليق");
    expect(COMMENT_KIND_COMMENT_AR).toBe("تعليق");
    expect(COMMENT_KIND_REPLY_AR).toBe("رد");
    expect(REPLY_TO_TITLE_AR).toBe("معرّف التعليق الأصلي");
    expect(COMMENT_KIND_KEY).toBe("comment_kind");
    expect(REPLY_TO_KEY).toBe("reply_to");
  });

  it("lists the kind and the parent comment id (code-filled), after the comment's own columns, with the parent title and link still on every row", () => {
    const item = TASK_CONTRACTS.comments.item.map((c) => c.cls);
    const child = TASK_CONTRACTS.comments.child.map((c) => c.cls);
    expect(item).toEqual(["text", "author", "date", "engagement", "comment_kind"]);
    expect(child).toEqual(["parent_title", "parent_link", "reply_to"]);
    expect(TASK_CONTRACTS.comments.item.find((c) => c.cls === "comment_kind")).toMatchObject({ title_ar: COMMENT_KIND_TITLE_AR, fill: "code" });
    expect(TASK_CONTRACTS.comments.child.find((c) => c.cls === "reply_to")).toMatchObject({ title_ar: REPLY_TO_TITLE_AR, fill: "code" });
  });

  it("the audit's reference (section 1C) says it: top-level comments AND replies, the parent comment id, the kind column, the source's own counter", () => {
    const audit = readFileSync("docs/AUDIT-2026-11.md", "utf-8");
    const start = audit.indexOf("### C. Comments on a post or video");
    const end = audit.indexOf("### D. Places");
    expect(start).toBeGreaterThan(-1);
    const section = audit.slice(start, end);
    expect(section).toContain("replies");
    expect(section).toContain("«نوع التعليق»");
    expect(section).toContain("«تعليق» / «رد»");
    expect(section).toMatch(/parent comment id/i);
    expect(section).toMatch(/source's own counter/i);
    // the older sentence that left the replies out is gone
    expect(section).not.toContain("Comment text, author, date (exact or approximate), likes, replies; **on every row**");
  });
});
