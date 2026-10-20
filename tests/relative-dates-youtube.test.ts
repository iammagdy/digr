import { afterEach, describe, expect, it } from "vitest";
import { parseRelativeDateMs, setRelativeDateClockForTesting } from "../src/lib/server/relativeDate";
import { classifyRowsByDate, countApproximateDates, rowDateMs, sampleUndatedFields, summarizeRowDates } from "../src/lib/server/dateRangeFilter";
import { APPROXIMATE_DATES_SENTENCE_AR, dateWindowPageEventAr } from "../src/lib/server/dateWindowNotes";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (ms: number | null) => (ms === null ? null : Math.round(((NOW - ms) / DAY) * 10) / 10);

afterEach(() => setRelativeDateClockForTesting(null));

describe("«منذ …» and «… ago» are read as coarse but real dates", () => {
  it("English forms, at the middle of the period they name", () => {
    expect(daysAgo(parseRelativeDateMs("3 weeks ago", NOW))).toBe(24.5);
    expect(daysAgo(parseRelativeDateMs("a month ago", NOW))).toBe(45);
    expect(daysAgo(parseRelativeDateMs("1 year ago", NOW))).toBe(547.5);
    expect(daysAgo(parseRelativeDateMs("2 days ago", NOW))).toBe(2.5);
    expect(daysAgo(parseRelativeDateMs("Streamed 5 hours ago", NOW))).toBe(0.2);
    expect(daysAgo(parseRelativeDateMs("yesterday", NOW))).toBe(1.5);
    expect(parseRelativeDateMs("just now", NOW)).toBe(NOW);
  });

  it("Arabic forms with Arabic-Indic digits, duals and singulars", () => {
    expect(daysAgo(parseRelativeDateMs("منذ ٣ أسابيع", NOW))).toBe(24.5);
    expect(daysAgo(parseRelativeDateMs("قبل أسبوعين", NOW))).toBe(17.5);
    expect(daysAgo(parseRelativeDateMs("منذ شهر", NOW))).toBe(45);
    expect(daysAgo(parseRelativeDateMs("منذ شهرين", NOW))).toBe(75);
    expect(daysAgo(parseRelativeDateMs("منذ ١٠ أيام", NOW))).toBe(10.5);
    expect(daysAgo(parseRelativeDateMs("منذ يومين", NOW))).toBe(2.5);
    expect(daysAgo(parseRelativeDateMs("منذ ٥ دقائق", NOW))).toBeLessThan(0.01);
    expect(daysAgo(parseRelativeDateMs("منذ سنة", NOW))).toBe(547.5);
    expect(daysAgo(parseRelativeDateMs("أمس", NOW))).toBe(1.5);
  });

  it("anything else is not a date", () => {
    for (const text of ["", "ممتاز", "3 weeks", "ago", "منذ", "2026", "long ago", "x".repeat(80), null, undefined, 5]) expect(parseRelativeDateMs(text as any, NOW), String(text)).toBeNull();
  });
});

describe("rows dated only by such a text are placed against the window", () => {
  const FROM = "2026-09-20";
  const TO = "2026-10-20";
  it("inside, outside, and the field names sources use", () => {
    setRelativeDateClockForTesting(() => NOW);
    const rows = [
      { text: "a", published_time_text: "3 weeks ago" },
      { text: "b", publishedTimeText: "منذ أسبوعين" },
      { text: "c", time: "4 months ago" },
      { text: "d", published: "منذ ٣ أشهر" },
      { text: "e", published: "2026-10-01T10:00:00Z" },
      { text: "f" },
    ];
    expect(classifyRowsByDate(rows, FROM, TO).verdicts).toEqual(["inside", "inside", "outside", "outside", "inside", "missing"]);
    expect(rowDateMs({ text: "x", published_time_text: "3 weeks ago" })).toBe(NOW - 24.5 * DAY);
  });

  it("an exact date always wins over a relative text, and the approximate ones are counted", () => {
    setRelativeDateClockForTesting(() => NOW);
    const rows = [{ create_time: Math.floor(Date.parse("2026-10-05T00:00:00Z") / 1000), time: "4 months ago" }, { time: "2 weeks ago" }, { time: "3 days ago" }, { text: "none" }];
    expect(classifyRowsByDate(rows, FROM, TO).verdicts).toEqual(["inside", "inside", "inside", "missing"]);
    expect(countApproximateDates(rows)).toBe(2);
    expect(summarizeRowDates(rows, FROM, TO)).toMatchObject({ inside: 3, missing: 1 });
  });

  it("the page line says that some dates are approximate", () => {
    const summary = { missing: 0, outside: 0, inside: 5, oldest: "2026-10-01", newest: "2026-10-18", sampleDates: [] };
    const line = dateWindowPageEventAr(summary, 5, { approximate: 5 });
    expect(line).toContain(APPROXIMATE_DATES_SENTENCE_AR);
    expect(line).toContain("(٥ سجل)");
    expect(dateWindowPageEventAr(summary, 5)).not.toContain("تقريبية");
  });

  it("undated rows leave a sample of their date-like fields (names and short values, never the text)", () => {
    setRelativeDateClockForTesting(() => NOW);
    const rows = [
      { text: "نص تعليق طويل لا يظهر", published_label: "Sep 28", likes: 3, comment_age: "unknown" },
      { text: "تعليق", time: "3 weeks ago" },
      { text: "تعليق ثان", posted_on: { y: 2026 } },
      { text: "ثالث" },
    ];
    const sample = sampleUndatedFields(rows);
    expect(sample).toEqual([{ published_label: "Sep 28", comment_age: "unknown" }, { posted_on: "(object)" }, {}]);
    expect(JSON.stringify(sample)).not.toContain("نص تعليق");
  });
});
