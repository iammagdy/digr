import { describe, expect, it } from "vitest";
import { EXCERPT_MAX_CHARS, NEWS_COLUMNS_AR, PRICE_COLUMNS_AR, canonicalLink, dedupeNews, shapeNewsRows, shapePriceSeries, shortExcerpt } from "../src/lib/newsOutput";

describe("news output: date, outlet, headline, link, short excerpt, matched keywords", () => {
  const body = "ارتفع سعر الدولار اليوم أمام الجنيه ".repeat(40);
  const items = [
    { date: "2026-10-18T09:00:00Z", outlet: "اليوم السابع", headline: "سعر الدولار اليوم في البنوك المصرية", link: "https://www.youm7.com/story/2026/10/18/1?utm_source=fb", body },
    { date: "2026-10-18", outlet: "اليوم السابع", headline: "سعر الدولار اليوم في البنوك المصرية", link: "https://youm7.com/story/2026/10/18/1/#top" },
    { date: "2026-10-19", outlet: "اليوم السابع", headline: "سعر الدولار اليوم في البنوك المصرية الآن", link: "https://www.youm7.com/story/2026/10/19/2" },
    { date: "2026-10-17", outlet: "الأهرام", headline: "البنك المركزي يثبت أسعار الفائدة", link: "https://gate.ahram.org.eg/News/1", excerpt: "قرر البنك المركزي تثبيت الفائدة." },
    { date: "2026-10-16", outlet: "الأهرام", headline: "سعر الدولار اليوم في البنوك المصرية", link: "https://gate.ahram.org.eg/News/2" },
  ];
  it("the same link is one article, however it is written; a near-identical headline in the same outlet is one story; another outlet's story stays", () => {
    expect(canonicalLink("https://www.youm7.com/story/1/?utm_source=fb#x")).toBe(canonicalLink("http://youm7.com/story/1"));
    const { kept, removed } = dedupeNews(items);
    expect(removed).toBe(2);
    expect(kept.map((i) => i.link)).toEqual([items[0].link, items[3].link, items[4].link]);
  });
  it("Arabic columns, newest first, a short excerpt (never the article), the matched keywords", () => {
    const { rows, duplicatesRemoved } = shapeNewsRows(items, ["الدولار", "الفائدة", "الذهب"]);
    expect(duplicatesRemoved).toBe(2);
    expect(Object.keys(rows[0])).toEqual([...NEWS_COLUMNS_AR]);
    expect(rows.map((r) => r.التاريخ)).toEqual(["2026-10-18", "2026-10-17", "2026-10-16"]);
    expect(rows[0]["مقتطف قصير"].length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS + 1);
    expect(rows[0]["مقتطف قصير"].length).toBeLessThan(body.length);
    expect(rows[0]["الكلمات المطابقة"]).toBe("الدولار");
    expect(rows[1]["الكلمات المطابقة"]).toBe("الفائدة");
    expect(rows.every((r) => !JSON.stringify(r).includes(body))).toBe(true);
  });
  it("a missing date says so", () => {
    expect(shapeNewsRows([{ outlet: "س", headline: "عنوان عن الدولار", link: "https://a.com/1" }], []).rows[0].التاريخ).toBe("تاريخ غير معروف");
    expect(shortExcerpt({ excerpt: "قصير" })).toBe("قصير");
  });
});

describe("price series: date, rate, source, change from the previous period", () => {
  const points = [
    { date: "2026-10-12", rate: 48.0, source: "البنك المركزي" },
    { date: "2026-10-13", rate: 48.5, source: "البنك المركزي" },
    { date: "2026-10-14", rate: 48.0, source: "البنك المركزي" },
    { date: "2026-10-19", rate: 49.2, source: "البنك المركزي" },
    { date: "2026-10-20", rate: 0, source: "البنك المركزي" },
  ];
  it("daily: the first has no previous period, then each change with its percentage", () => {
    const rows = shapePriceSeries(points, "daily");
    expect(Object.keys(rows[0])).toEqual([...PRICE_COLUMNS_AR]);
    expect(rows).toHaveLength(4);
    expect(rows[0]["التغير عن الفترة السابقة"]).toBe("لا توجد فترة سابقة");
    expect(rows[1]["التغير عن الفترة السابقة"]).toBe("+0.50 (+1.04٪)");
    expect(rows[2]["التغير عن الفترة السابقة"]).toBe("−0.50 (−1.03٪)");
  });
  it("weekly: the last rate of each week, compared with the week before", () => {
    const rows = shapePriceSeries(points, "weekly");
    expect(rows.map((r) => [r.التاريخ, r.السعر])).toEqual([["2026-10-14", 48], ["2026-10-19", 49.2]]);
    expect(rows[1]["التغير عن الفترة السابقة"]).toBe("+1.20 (+2.50٪)");
  });
  it("a point with no usable rate is dropped, never shown as zero", () => {
    expect(shapePriceSeries(points, "daily").some((r) => r.السعر === 0)).toBe(false);
  });
});
