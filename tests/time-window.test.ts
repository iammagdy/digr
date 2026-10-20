import { describe, it, expect } from "vitest";
import {
  KNOWN_EVENTS,
  WINDOW_OPTIONS_AR,
  WINDOW_LONG_RANGE_WARNING_AR,
  formatDateAr,
  knownEventWindow,
  parseRelativeWindow,
  parseStatedDates,
  resolveTimeWindow,
  windowQuestion,
  windowStepParams,
} from "../src/lib/timeWindow";

const TODAY = new Date(Date.UTC(2026, 9, 20)); // 2026-10-20

describe("explicit dates the customer wrote", () => {
  it("uses a clean range as written, Arabic or Western digits, Arabic month names", () => {
    expect(parseStatedDates("من ١ يناير ٢٠٢٦ إلى ٣٠ سبتمبر ٢٠٢٦", TODAY)).toEqual({ from: "2026-01-01", to: "2026-09-30" });
    expect(parseStatedDates("from 1 يناير 2026 الى 30 سبتمبر 2026", TODAY)).toEqual({ from: "2026-01-01", to: "2026-09-30" });
    expect(parseStatedDates("من 1/1/2026 لحد 30/9/2026", TODAY)).toEqual({ from: "2026-01-01", to: "2026-09-30" });
    expect(parseStatedDates("٢٠٢٦-٠١-٠١ إلى ٢٠٢٦-٠٩-٣٠", TODAY)).toEqual({ from: "2026-01-01", to: "2026-09-30" });
  });

  it("corrects 31/9 to the last valid day with a plain Arabic note, never rolling into October or widening to the year", () => {
    for (const text of ["من ١ يناير ٢٠٢٦ إلى ٣١ سبتمبر ٢٠٢٦", "من 1/1/2026 لحد 31/9/2026", "٢٠٢٦-٠١-٠١ إلى ٢٠٢٦-٠٩-٣١"]) {
      const parsed = parseStatedDates(text, TODAY) as { from: string; to: string; noteAr?: string };
      expect(parsed.from).toBe("2026-01-01");
      expect(parsed.to).toBe("2026-09-30");
      expect(parsed.noteAr).toContain("٣١");
      expect(parsed.noteAr).toContain("٣٠ سبتمبر");
      expect(parsed.noteAr).toContain("آخر يوم في الشهر");
      expect(parsed.noteAr).not.toMatch(/[0-9]|undefined|null|NaN/);
    }
  });

  it("corrects February 30 and 29 in a non-leap year", () => {
    const feb30 = parseStatedDates("من 1/2/2026 إلى 30/2/2026", TODAY) as { to: string; noteAr?: string };
    expect(feb30.to).toBe("2026-02-28");
    expect(feb30.noteAr).toContain("٢٨ فبراير");
    expect((parseStatedDates("من 1/2/2024 إلى 30/2/2024", TODAY) as { to: string }).to).toBe("2024-02-29");
  });

  it("reads month-only and 'end of month' ranges", () => {
    expect(parseStatedDates("من يناير لحد آخر سبتمبر ٢٠٢٦", TODAY)).toEqual({ from: "2026-01-01", to: "2026-09-30" });
    expect(parseStatedDates("من بداية يناير ٢٠٢٦ إلى نهاية سبتمبر ٢٠٢٦", TODAY)).toEqual({ from: "2026-01-01", to: "2026-09-30" });
  });

  it("a range that ends before it starts is a conflict, not a silent swap", () => {
    const parsed = parseStatedDates("من ١ سبتمبر ٢٠٢٦ إلى ١ يناير ٢٠٢٦", TODAY);
    expect(parsed).toHaveProperty("conflictNoteAr");
    const resolved = resolveTimeWindow("من ١ سبتمبر ٢٠٢٦ إلى ١ يناير ٢٠٢٦", { needsWindow: true, today: TODAY });
    expect(resolved.status).toBe("missing");
  });

  it("returns null when the text states no date", () => {
    expect(parseStatedDates("عايز تعليقات عن ماتش الأهلي", TODAY)).toBeNull();
  });
});

describe("relative windows", () => {
  it.each([
    ["آخر شهر", "2026-09-20"],
    ["آخر ٣ شهور", "2026-07-20"],
    ["آخر ٦ شهور", "2026-04-20"],
    ["آخر سنة", "2025-10-20"],
    ["آخر أسبوعين", "2026-10-06"],
    ["خلال شهرين", "2026-08-20"],
  ])("«%s» starts %s and ends today", (phrase, from) => {
    const window = parseRelativeWindow(phrase, TODAY)!;
    expect(window.from).toBe(from);
    expect(window.to).toBe("2026-10-20");
  });

  it("«آخر ٣ شهور» is three months and never three days", () => {
    const w = parseRelativeWindow("آخر ٣ شهور", TODAY)!;
    const days = (Date.parse(w.to) - Date.parse(w.from)) / 86400000;
    expect(days).toBeGreaterThan(80);
  });

  it("month arithmetic is clamped: one month before October 31 is September 30", () => {
    expect(parseRelativeWindow("آخر شهر", new Date(Date.UTC(2026, 9, 31)))!.from).toBe("2026-09-30");
  });

  it("the label uses Arabic digits only", () => {
    expect(parseRelativeWindow("آخر ٣ شهور", TODAY)!.labelAr).not.toMatch(/[0-9]/);
  });
});

describe("known events", () => {
  it("the 2026 World Cup gets its published dates and a one-line reason", () => {
    const w = knownEventWindow("كل فيديوهات منتخب مصر في كأس العالم ٢٠٢٦", TODAY)!;
    expect(w.from).toBe("2026-06-11");
    expect(w.to).toBe("2026-07-19");
    expect(w.reasonAr).toContain("كأس العالم ٢٠٢٦");
    expect(w.reasonAr).toContain("١١ يونيو ٢٠٢٦");
    expect(w.reasonAr).toContain("١٩ يوليو ٢٠٢٦");
    expect(w.reasonAr).toContain("تقدر تعدّلها");
    expect(w.reasonAr.split(/[.؟!]/).filter(Boolean)).toHaveLength(1);
    expect(w.reasonAr).not.toMatch(/[0-9]/);
  });

  it("recognises spelling variants and ignores unrelated mentions of the year", () => {
    expect(knownEventWindow("تعليقات مونديال 2026", TODAY)).not.toBeNull();
    expect(knownEventWindow("world cup 2026 posts", TODAY)).not.toBeNull();
    expect(knownEventWindow("عايز بوستات عن الأهلي في 2026", TODAY)).toBeNull();
    expect(knownEventWindow("كأس العالم للأندية", TODAY)).toBeNull();
  });

  it("every known event has a valid, ordered range", () => {
    for (const event of KNOWN_EVENTS) {
      expect(event.from <= event.to).toBe(true);
      expect(event.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("resolveTimeWindow: never a silent default", () => {
  const feed = { needsWindow: true, today: TODAY };

  it("directories need no window", () => {
    expect(resolveTimeWindow("عايز ١٠ شركات مقاولات في مصر", { needsWindow: false, today: TODAY })).toEqual({ status: "not_needed" });
  });

  it("stated dates win and carry the correction note", () => {
    const w = resolveTimeWindow("بوستات فيسبوك عن الجواز من ١ يناير ٢٠٢٦ إلى ٣١ سبتمبر ٢٠٢٦", feed);
    expect(w).toMatchObject({ status: "resolved", source: "stated", dateFrom: "2026-01-01", dateTo: "2026-09-30" });
    expect((w as any).noteAr).toContain("٣٠ سبتمبر");
  });

  it("a relative phrase is a relative window", () => {
    expect(resolveTimeWindow("تعليقات عن الغلاء آخر ٣ شهور", feed)).toMatchObject({ status: "resolved", source: "relative", dateFrom: "2026-07-20", dateTo: "2026-10-20" });
  });

  it("a known event is a proposal with a reason", () => {
    const w = resolveTimeWindow("كل فيديوهات القناة الرسمية عن منتخب مصر في كأس العالم ٢٠٢٦", feed);
    expect(w).toMatchObject({ status: "resolved", source: "event", dateFrom: "2026-06-11", dateTo: "2026-07-19" });
    expect((w as any).reasonAr).toBeTruthy();
    expect(windowStepParams(w)).toEqual({ dateFrom: "2026-06-11", dateTo: "2026-07-19", windowSource: "event" });
  });

  it("a year alone with a preposition is that year", () => {
    expect(resolveTimeWindow("بوستات عن الأسعار في 2025", feed)).toMatchObject({ status: "resolved", dateFrom: "2025-01-01", dateTo: "2025-12-31" });
  });

  it("no time frame: ONE question with the four options and the plain warning, and no dates", () => {
    const w = resolveTimeWindow("عايز تعليقات عن ماتش الأهلي والزمالك على إكس", feed);
    expect(w.status).toBe("missing");
    const question = (w as any).question;
    expect(question.options).toEqual(["آخر شهر", "آخر ٣ شهور", "آخر ٦ شهور", "آخر سنة"]);
    expect(question.warningAr).toBe(WINDOW_LONG_RANGE_WARNING_AR);
    expect(question.warningAr).toContain("سقف");
    expect(windowStepParams(w)).toEqual({});
  });

  it("the question options each resolve to the window they name", () => {
    for (const option of WINDOW_OPTIONS_AR) {
      const w = resolveTimeWindow(option, feed);
      expect(w.status).toBe("resolved");
      expect((w as any).source).toBe("relative");
    }
    const months = WINDOW_OPTIONS_AR.map((o) => {
      const w = resolveTimeWindow(o, feed) as any;
      return Math.round((Date.parse(w.dateTo) - Date.parse(w.dateFrom)) / 86400000 / 30);
    });
    expect(months).toEqual([1, 3, 6, 12]);
  });

  it("a ranking request with no window is a visible open scope, not a date filter", () => {
    const w = resolveTimeWindow("أعلى ١٠ فيديوهات مشاهدة لكل قناة", { ...feed, rankingRequest: true });
    expect(w).toMatchObject({ status: "resolved", source: "open_scope", labelAr: "كل الفترة المتاحة" });
    expect(windowStepParams(w)).toEqual({});
  });

  it("customer-visible copy is Arabic only with Arabic digits", () => {
    const q = windowQuestion();
    for (const text of [q.text, q.warningAr, ...q.options, formatDateAr("2026-09-30")]) {
      expect(text).not.toMatch(/[A-Za-z0-9]|undefined|null|NaN/);
    }
  });
});
