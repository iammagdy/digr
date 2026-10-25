import { describe, expect, it } from "vitest";
import { classifyRowsByDate, DATE_BASIS_KEY, filterRowsByDateRange, summarizeRowDates, VIDEO_PUBLISHED_AT_KEY, windowDateMs } from "../src/lib/server/dateRangeFilter";
import { allRowsOutsideWindow, dateWindowPageEventAr, VIDEO_DATE_BASIS_SENTENCE_AR } from "../src/lib/server/dateWindowNotes";

const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const FROM = "2026-09-20";
const TO = "2026-10-20";

describe("one classification decides where a row stands against the window", () => {
  const rows = [
    { create_time: secs("2026-09-20T00:00:00Z") },
    { create_time: secs("2026-10-20T23:59:59Z") },
    { create_time: secs("2026-09-19T23:59:59Z") },
    { create_time: secs("2026-10-21T00:00:00Z") },
    { published_at: "2026-10-05" },
    { published_at: "2026-04-01" },
    { text: "no date at all" },
    { create_time: "not a date" },
    null,
  ];

  it("inside / outside / missing, with both ends of the window inclusive", () => {
    const { verdicts } = classifyRowsByDate(rows, FROM, TO);
    expect(verdicts).toEqual(["inside", "inside", "outside", "outside", "inside", "outside", "missing", "missing", "missing"]);
  });

  it("the filter keeps exactly the inside rows and the summary counts exactly what the filter did", () => {
    const filtered = filterRowsByDateRange(rows, FROM, TO);
    const summary = summarizeRowDates(rows, FROM, TO);
    expect(summary).toMatchObject({ inside: 3, outside: 3, missing: 3 });
    expect(filtered.rows).toHaveLength(summary.inside);
    expect(filtered.excludedCount).toBe(summary.outside + summary.missing);
    expect(summary.inside + summary.outside + summary.missing).toBe(rows.length);
  });

  it("the summary and the filter agree on any mix of dates", () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 40; round++) {
      const mixed = Array.from({ length: 25 }, () => {
        const roll = next();
        if (roll < 0.2) return { text: "undated" };
        const when = base + Math.floor(next() * 400) * 86_400_000;
        return roll < 0.6 ? { create_time: Math.floor(when / 1000) } : { published_at: new Date(when).toISOString() };
      });
      const filtered = filterRowsByDateRange(mixed, FROM, TO);
      const summary = summarizeRowDates(mixed, FROM, TO);
      expect(filtered.rows.length).toBe(summary.inside);
      expect(filtered.excludedCount).toBe(summary.outside + summary.missing);
    }
  });

  it("a window nobody can read puts every dated row outside and never inside", () => {
    const { verdicts } = classifyRowsByDate([{ published_at: "2026-10-05" }, { text: "x" }], "garbage", TO);
    expect(verdicts).toEqual(["outside", "missing"]);
  });

  it("a comment is judged by its own time; the date of a video next to it is never read", () => {
    const comment = { create_time: secs("2026-04-01T10:00:00Z"), video_create_time: secs("2026-10-05T10:00:00Z"), video_published_at: "2026-10-05" };
    expect(classifyRowsByDate([comment], FROM, TO).verdicts).toEqual(["outside"]);
    const recent = { create_time: secs("2026-10-05T10:00:00Z"), video_create_time: secs("2026-04-01T10:00:00Z") };
    expect(classifyRowsByDate([recent], FROM, TO).verdicts).toEqual(["inside"]);
  });

  it("a comment marked as judged by its video uses the video's date, inside or outside", () => {
    const insideVideo = { text: "x", [DATE_BASIS_KEY]: "video", [VIDEO_PUBLISHED_AT_KEY]: Date.parse("2026-10-05T00:00:00Z") };
    const outsideVideo = { text: "y", [DATE_BASIS_KEY]: "video", [VIDEO_PUBLISHED_AT_KEY]: Date.parse("2026-04-01T00:00:00Z") };
    expect(windowDateMs(insideVideo)).toBe(Date.parse("2026-10-05T00:00:00Z"));
    expect(classifyRowsByDate([insideVideo, outsideVideo], FROM, TO).verdicts).toEqual(["inside", "outside"]);
    expect(filterRowsByDateRange([insideVideo, outsideVideo], FROM, TO).rows).toEqual([insideVideo]);
  });
});

describe("the page line says exactly what the classification found", () => {
  const mixed = [
    ...Array.from({ length: 12 }, () => ({ create_time: secs("2026-10-05T10:00:00Z") })),
    ...Array.from({ length: 5 }, () => ({ create_time: secs("2026-04-01T10:00:00Z") })),
    ...Array.from({ length: 3 }, () => ({ text: "undated" })),
  ];

  it("a page with dates outside or missing never says all are inside, and gives the three counts", () => {
    const summary = summarizeRowDates(mixed, FROM, TO);
    const line = dateWindowPageEventAr(summary, mixed.length);
    expect(line).not.toContain("وكلها داخل");
    expect(line).toContain("تم استبعاد ٨ سجلات من هذه الصفحة بسبب التاريخ");
    expect(line).toContain("٥ خارج الفترة المطلوبة");
    expect(line).toContain("٣ بلا تاريخ نشر يمكن التحقق منه");
    expect(line).toContain("وبقي ١٢ داخلها");
    expect(line).toContain("أقدم تاريخ نشر ٢٠٢٦-٠٤-٠١ وأحدث تاريخ ٢٠٢٦-١٠-٠٥");
  });

  it("says all are inside only when every row is inside", () => {
    const inside = Array.from({ length: 7 }, () => ({ create_time: secs("2026-10-05T10:00:00Z") }));
    const line = dateWindowPageEventAr(summarizeRowDates(inside, FROM, TO), inside.length);
    expect(line).toBe("فحصنا تواريخ ٧ سجلات من هذه الصفحة وكلها داخل الفترة المطلوبة (أقدم تاريخ نشر ٢٠٢٦-١٠-٠٥ وأحدث تاريخ ٢٠٢٦-١٠-٠٥).");
  });

  it("the old-dates case: dates from April to July against a September–October window are reported as outside", () => {
    const old = [secs("2026-04-01T10:00:00Z"), secs("2026-05-20T10:00:00Z"), secs("2026-07-17T10:00:00Z")].map((create_time) => ({ create_time }));
    const summary = summarizeRowDates(old, FROM, TO);
    expect(allRowsOutsideWindow(summary, old.length)).toBe(true);
    const line = dateWindowPageEventAr(summary, old.length);
    expect(line).not.toContain("وكلها داخل");
    expect(line).toContain("٣ خارج الفترة المطلوبة");
    expect(line).toContain("أقدم تاريخ نشر ٢٠٢٦-٠٤-٠١ وأحدث تاريخ ٢٠٢٦-٠٧-١٧");
  });

  it("names the video basis when comments were judged by the date of their video", () => {
    const line = dateWindowPageEventAr(summarizeRowDates([{ create_time: secs("2026-10-05T10:00:00Z") }], FROM, TO), 1, { videoBasis: 1 });
    expect(line).toContain(VIDEO_DATE_BASIS_SENTENCE_AR);
    expect(line).toContain("(١ تعليق)");
  });
});
