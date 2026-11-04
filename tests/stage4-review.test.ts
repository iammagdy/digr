import { describe, expect, it } from "vitest";
import { firstVersionFromCells } from "../src/lib/agentMission/stage4/versions";
import { REVIEW_CODES, REVIEW_ISSUE_AR, reviewCellsOf, reviewFile } from "../src/lib/agentMission/stage4/review";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { xWorld, tiktokWorld } from "./helpers/round11Worlds";

/**
 * STAGE 4 (docs/STAGE-4.md), THE REVIEW: a report and a score for a delivered file, column by column. It NEVER deletes or changes a row: it reads a frozen version and returns no rows.
 * Files: the files the current code builds from the stored real rows of M14 (msn_b060d3347ed7660f972e, `xWorld`) and M12 (msn_5851abc92a1e6645a9cd, `tiktokWorld`); plus a small sheet
 * with fake values and known problems.
 */
const fake = firstVersionFromCells({
  missionId: "msn_fake",
  createdAt: "2026-11-04T10:00:00.000Z",
  cells: {
    "الشركات": [
      ["اسم الشركة", "الإيميل العام للشركة", "هاتف المقر الرئيسي", "الموقع الإلكتروني", "تاريخ التأسيس", "المعرّف"],
      ["شركة مثال", "info@example.com", "+20 2 1234 5678", "https://example.com", "2015-03-01", "c1"],
      ["شركة مثال ٢", "not-an-email", "12", "example.com", "ليس تاريخًا", "c2"],
      ["شركة مثال", "info@example.com", "+20 2 1234 5678", "https://example.com", "2015-03-01", "c3"],
      ["", "غير متوفر", "غير متوفر", "", "", "c4"],
    ],
  },
});

describe("the review never deletes or changes a row", () => {
  it.each([["M14 X", xWorld], ["M12 TikTok", tiktokWorld]] as const)("%s: same rows, same content, before and after; the result holds no rows", async (_n, world) => {
    const v = firstVersionFromCells({ missionId: "m", cells: (await world()).cells, createdAt: "2026-11-04T10:00:00.000Z" });
    const before = JSON.stringify(v);
    const counts = v.sheets.map((s) => s.rows.length);
    const r = reviewFile(v);
    expect(JSON.stringify(v)).toBe(before);
    expect(v.sheets.map((s) => s.rows.length)).toEqual(counts);
    expect(JSON.stringify(r)).not.toContain('"rows":');
    expect(r.rowsReviewed).toBe(counts.reduce((a, b) => a + b, 0));
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    for (const line of r.reportAr) expect(checkCustomerText(line, { maxChars: 600 }).issues, line).toEqual([]);
    expect(JSON.stringify(reviewFile(v))).toBe(JSON.stringify(r));
  });
});

describe("the report and the score (fake sheet with known problems)", () => {
  const r = reviewFile(fake);
  it("lists each problem by column, with its count and the rows' ids", () => {
    const by = (code: string, column: string) => r.issues.find((i) => i.code === code && i.column === column);
    expect(by("invalid_email", "الإيميل العام للشركة")).toMatchObject({ count: 1, rowIds: ["c2"] });
    expect(by("invalid_phone", "هاتف المقر الرئيسي")).toMatchObject({ count: 1, rowIds: ["c2"] });
    expect(by("invalid_link", "الموقع الإلكتروني")).toMatchObject({ count: 1, rowIds: ["c2"] });
    expect(by("invalid_date", "تاريخ التأسيس")).toMatchObject({ count: 1, rowIds: ["c2"] });
    expect(by("empty_cells", "اسم الشركة")).toMatchObject({ count: 1, rowIds: ["c4"] });
    expect(by("stated_gap", "الإيميل العام للشركة")).toMatchObject({ count: 1, rowIds: ["c4"] });
    expect(r.issues.find((i) => i.code === "exact_duplicate")).toMatchObject({ count: 1, rowIds: ["c3"] });
  });
  it("a stated gap («غير متوفر») is reported, not counted against the score; the score is the share of sound cells", () => {
    expect(r.cells).toBe(reviewCellsOf(fake));
    expect(r.cells).toBe(20);
    // 20 cells: 4 invalid, 3 empty with nothing said, and the 5 cells of the exact duplicate are problems (12); the 2 stated gaps are not
    expect(r.score).toBe(40);
  });
  it("every code has one fixed Arabic sentence; the report names columns, never a provider", () => {
    for (const code of REVIEW_CODES) expect(checkCustomerText(REVIEW_ISSUE_AR[code]("الإيميل العام للشركة", 3)).issues, code).toEqual([]);
    expect(r.reportAr[0]).toBe("التقييم: ٤٠ من ١٠٠.");
  });
});
