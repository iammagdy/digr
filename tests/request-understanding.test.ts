import { describe, expect, it } from "vitest";
import { understandRequest } from "../src/lib/requestUnderstanding";

const TODAY = new Date("2026-10-21T12:00:00Z");
const u = (text: string) => understandRequest(text, { today: TODAY });

describe("the structured understanding: what, about what, where, when, how many, which fields, from where, and whether we can serve it", () => {
  it("1 news: the dollar-news request is read as news from an unnamed set of newspapers, over three months, and cannot be served", () => {
    const r = u("اسحب كل أخبار الدولار وأسعاره في السوق المصري من الجرايد الرسمية خلال آخر ٣ شهور");
    expect(r.taskType).toBe("news");
    expect(r.coverage.status).toBe("not_supported");
    expect(r.coverage.unsupported).toEqual(expect.arrayContaining(["news_articles"]));
    expect(r.region?.nameAr).toBe("مصر");
    expect(r.timeFrame?.labelAr).toContain("٣");
    expect(r.sources).toEqual({ kind: "newspapers", named: [], unnamed: true });
    expect(r.nextQuestion).toBeNull();
  });

  it("1 news: newspapers the customer named are read as named", () => {
    const r = u("أخبار الدولار من الأهرام والمصري اليوم آخر شهر");
    expect(r.sources.unnamed).toBe(false);
    expect(r.sources.named).toEqual(expect.arrayContaining(["الأهرام", "المصري اليوم"]));
  });

  it("2 prices: a series with changes is read as prices, and its fields include the change", () => {
    const r = u("أريد سعر الدولار يوميا في السوق المصري مع التغير عن اليوم السابق وأخرج الملف إكسل");
    expect(r.taskType).toBe("prices");
    expect(r.fields).toContain("التغير عن الفترة السابقة");
    expect(r.output).toBe("xlsx");
    expect(r.coverage.status).toBe("not_supported");
  });

  it("3 academic", () => {
    const r = u("اجمع ١٠ دراسات عن الطاقة الشمسية في ألمانيا");
    expect(r.taskType).toBe("studies");
    expect(r.volume).toBe(10);
    expect(r.region?.nameAr).toBe("ألمانيا");
  });

  it("4 brand monitoring over several platforms is partly served", () => {
    const r = u("ارصد علامتي على إكس وتيك توك ويوتيوب وفيسبوك");
    expect(r.coverage.status).toBe("partly");
    expect(r.parts.map((p) => p.family)).toContain("brand_monitoring");
  });

  it("5 named video comments: supported, with no question when a link is given", () => {
    const r = u("تعليقات هذا الفيديو https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(r.taskType).toBe("comments");
    expect(r.coverage.status).toBe("supported");
    expect(r.nextQuestion).toBeNull();
  });

  it("6 channels then comments", () => {
    const r = u("أعلى ١٠ فيديوهات مشاهدة من كل قناة من ٣ قنوات يوتيوب مع التعليقات");
    expect(r.coverage.supported).toContain("channel_top_videos_comments");
  });

  it("10 companies then decision makers: the fields asked for are read, and one question names only what is missing", () => {
    const r = u("٣ صناع قرار في شركات برمجيات مع البريد والهاتف");
    expect(r.taskType).toBe("people");
    expect(r.fields).toEqual(expect.arrayContaining(["البريد الإلكتروني", "الهاتف"]));
    expect(r.nextQuestion?.id).toBe("country_required");
  });

  it("a stated country, count and activity are never asked again", () => {
    const r = u("عايز ٥ شركات في مجال الكهرباء في مصر");
    expect(r.nextQuestion).toBeNull();
    expect(r.volume).toBe(5);
  });

  it("a budget instead of a count", () => {
    const r = u("٣٠٠ نقطة هي ميزانيتي لتعليقات تيك توك عن كرة القدم بحد أقصى ٣٠٠ نقطة");
    expect(r.budgetPoints).toBe(300);
  });

  it("language and file", () => {
    const r = u("تعليقات يوتيوب عن كرة القدم بالعربي في ملف csv");
    expect(r.language).toBe("ar");
    expect(r.output).toBe("csv");
  });

  it("14 vague: one question, about the topic", () => {
    const r = u("عايز بيانات");
    expect(r.taskType).toBe("unknown");
    expect(r.nextQuestion?.id).toBe("topic_required");
  });

  it("a request we cannot serve gets no question (the plain answer is given instead), and the question list is never longer than one", () => {
    for (const text of ["إعلانات المنافسين على فيسبوك", "هات الرسائل الخاصة لحساب فلان", "وظايف مفتوحة في شركات التقنية"]) expect(u(text).nextQuestion).toBeNull();
    expect(u("عايز بيانات").nextQuestion).toBeTruthy();
  });

  it("every Arabic text it produces is Arabic", () => {
    const r = u("عايز بيانات");
    expect(r.nextQuestion!.textAr).not.toMatch(/[A-Za-z]/);
  });
});
