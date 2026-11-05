import { describe, expect, it } from "vitest";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { REREAD_MAX_TOOLS, cellText, isRealValue, readRecipe, valueAtPath } from "../src/lib/agentMission/stage4/reread";
import { STATED_GAP, reviewFile } from "../src/lib/agentMission/stage4/review";
import { firstVersionFromCells } from "../src/lib/agentMission/stage4/versions";

/**
 * MONEY PR 7a, PHASE 2B-1: THE SMALL ADDITIVE PIECES THE ADD-ON RUNNER NEEDS (docs/MONEY-PR-7A.md section 13): the re-read recipe's strict reader and what counts as a value (decision D4), the review with the WHOLE list of an issue's rows
 * (a fix must never use the report's first 20 ids), and a review-fix reason on an edit. Each is additive: every existing call behaves as before.
 */
const tool = (over: Record<string, unknown> = {}) => ({ endpointId: "tikhub.x.tiktok-web-fetch-user-live-detail", params: { region: "EG" }, bind: { param: "uniqueId", from: "اسم المستخدم" }, valueField: "user.nickname", ...over });

describe("the re-read recipe reader is strict", () => {
  it("a well-formed recipe is read; anything else is null (nothing is guessed)", () => {
    expect(readRecipe({ tools: [tool()] })).toEqual({ tools: [tool()] });
    for (const bad of [null, undefined, "x", [], {}, { tools: [] }, { tools: "x" }, { tools: [tool({ endpointId: "" })] }, { tools: [tool({ params: null })] }, { tools: [tool({ bind: { param: "a" } })] }, { tools: [tool({ valueField: " " })] }, { tools: [null] }]) expect(readRecipe(bad)).toBeNull();
    expect(readRecipe({ tools: Array.from({ length: REREAD_MAX_TOOLS + 1 }, () => tool()) })).toBeNull();
    expect(readRecipe({ tools: Array.from({ length: REREAD_MAX_TOOLS }, () => tool()) })).not.toBeNull();
  });
});

describe("a value is a REAL value only (decision D4)", () => {
  it("a stated gap, an empty text, nothing, a list and an object are not values; a text and a finite number are", () => {
    for (const gap of ["", "  ", "غير متوفر", "غير متاح", "غير متاح من المصدر", "لم يكتمل البحث", "غير محدد", " لم يكتمل البحث "]) expect(isRealValue(gap)).toBe(false);
    for (const no of [null, undefined, [], {}, ["x"], true, Number.NaN, Number.POSITIVE_INFINITY]) expect(isRealValue(no)).toBe(false);
    for (const yes of ["قناة س", " 12 ", 0, 7, 3.5, "https://example.com/a"]) expect(isRealValue(yes)).toBe(true);
    expect(cellText(" سارة ")).toBe("سارة");
    expect(cellText(7)).toBe("7");
    expect(STATED_GAP.test("غير متوفر")).toBe(true);
  });
  it("a value is read by key or by dotted path", () => {
    const row = { user: { nickname: "قناة س", stats: { n: 3 } }, id: "9", list: [1] };
    expect(valueAtPath(row, "id")).toBe("9");
    expect(valueAtPath(row, "user.nickname")).toBe("قناة س");
    expect(valueAtPath(row, "user.stats.n")).toBe(3);
    expect(valueAtPath(row, "user.nope")).toBeUndefined();
    expect(valueAtPath(row, "id.x")).toBeUndefined();
    expect(valueAtPath(null, "a")).toBeUndefined();
  });
});

const sheetOf = (n: number) => ({ "ورقة": [["الاسم", "الإيميل", "المعرّف"], ...Array.from({ length: n }, (_, i) => ["س", "", `r${i + 1}`])] });
const v1 = (n: number) => firstVersionFromCells({ missionId: "msn_a", cells: sheetOf(n), createdAt: "2026-11-04T10:00:00Z" });

describe("the review can give the WHOLE row list of an issue", () => {
  it("by default an issue keeps the first 20 ids (unchanged); with keepRowIds it keeps them all", () => {
    const v = v1(30);
    const short = reviewFile(v).issues.find((i) => i.code === "empty_cells" && i.column === "الإيميل")!;
    expect(short.count).toBe(30);
    expect(short.rowIds).toHaveLength(20);
    const full = reviewFile(v, { keepRowIds: Number.POSITIVE_INFINITY }).issues.find((i) => i.code === "empty_cells" && i.column === "الإيميل")!;
    expect(full.count).toBe(30);
    expect(full.rowIds).toEqual(Array.from({ length: 30 }, (_, i) => `r${i + 1}`));
  });
  it("the result is otherwise identical: score, cells, counts and report", () => {
    const v = v1(30);
    const a = reviewFile(v), b = reviewFile(v, { keepRowIds: Number.POSITIVE_INFINITY });
    expect({ ...b, issues: b.issues.map((i) => ({ ...i, rowIds: i.rowIds.slice(0, 20) })) }).toEqual(a);
  });
});

describe("an edit can carry the reason of a review fix", () => {
  const set = { kind: "set_cells" as const, sheet: "ورقة", cells: [{ rowId: "r1", column: "الإيميل", value: "a@b.co" }] };
  it("the default reason is «edit» (unchanged); «review_fix» is made when asked", () => {
    const base = v1(2);
    const plain = applyEditRequest(base, set, { createdAt: "2026-11-04T11:00:00Z" });
    const fix = applyEditRequest(base, set, { createdAt: "2026-11-04T11:00:00Z", reason: "review_fix" });
    expect(plain.ok && plain.version.reason).toBe("edit");
    expect(fix.ok && fix.version.reason).toBe("review_fix");
    expect(fix.ok && plain.ok && fix.version.digest === plain.version.digest).toBe(true);
    expect(fix.ok && fix.version.parent).toBe(1);
  });
});
