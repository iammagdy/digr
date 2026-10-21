import { describe, expect, it } from "vitest";
import { assessCoverage, COVERAGE_FAMILIES, notSupportedReplyAr, partlyNoteAr, WHAT_WE_CAN_DO_AR, type CoverageStatus, type FamilyId } from "../src/lib/requestCoverage";
import fixture from "./fixtures/understanding-requests.json";

type Case = { text: string; status: CoverageStatus; unsupported?: FamilyId[]; supported?: FamilyId[] };

/** One block per family of the scenario matrix: how customers really write it, in Arabic and in the Egyptian dialect. */
const CASES: Record<string, Case[]> = {
  "1 news": [
    { text: "اسحب كل أخبار الدولار وأسعاره في السوق المصري من الجرايد الرسمية خلال آخر ٣ شهور", status: "not_supported", unsupported: ["news_articles"] },
    { text: "عايز أخبار عن الانتخابات من الصحف المصرية", status: "not_supported", unsupported: ["news_articles"] },
    { text: "اجمع لي مقالات صحفية عن الذكاء الاصطناعي", status: "not_supported", unsupported: ["news_articles"] },
  ],
  "2 prices": [
    { text: "سعر الدولار يوميا في السوق المصري مع التغير عن اليوم السابق", status: "not_supported", unsupported: ["price_series"] },
    { text: "أريد سلسلة أسعار الذهب أسبوعيا خلال ٣ شهور", status: "not_supported", unsupported: ["price_series"] },
    { text: "اسعار صرف اليورو مقابل الجنيه", status: "not_supported", unsupported: ["price_series"] },
  ],
  "3 academic": [
    { text: "اجمع ١٠ دراسات عن الطاقة الشمسية في ألمانيا", status: "not_supported", unsupported: ["academic_studies"] },
    { text: "محتاج أوراق بحثية عن التعليم الإلكتروني", status: "not_supported", unsupported: ["academic_studies"] },
    { text: "ابحث لي في google scholar عن الذكاء الاصطناعي", status: "not_supported", unsupported: ["academic_studies"] },
  ],
  "4 brand monitoring": [
    { text: "١٠٠ منشور على إكس عن اسم علامتي", status: "supported", supported: ["brand_monitoring"] },
    { text: "ارصد علامتي التجارية على إكس وتيك توك ويوتيوب وفيسبوك", status: "partly", supported: ["brand_monitoring"] },
    { text: "تعليقات تيك توك ويوتيوب عن كرة القدم", status: "partly", supported: ["brand_monitoring"] },
  ],
  "5 named comments": [
    { text: "تعليقات هذا الفيديو https://www.youtube.com/watch?v=dQw4w9WgXcQ", status: "supported", supported: ["named_comments"] },
    { text: "كل تعليقات هذا الفيديو على تيك توك https://www.tiktok.com/@u/video/7231337071831321903", status: "supported", supported: ["named_comments"] },
  ],
  "6 channels top videos": [
    { text: "أعلى ١٠ فيديوهات مشاهدة من كل قناة من ٣ قنوات يوتيوب مع التعليقات", status: "supported", supported: ["channel_top_videos_comments"] },
  ],
  "7 ads": [
    { text: "إعلانات المنافسين على فيسبوك لعلامتي", status: "not_supported", unsupported: ["competitor_ads"] },
    { text: "ابغى مكتبة اعلانات ميتا لشركة", status: "not_supported", unsupported: ["competitor_ads"] },
  ],
  "8 places and reviews": [
    { text: "تقييمات مطاعم القاهرة من خرائط جوجل", status: "not_supported", unsupported: ["places_reviews"] },
    { text: "مراجعات تطبيق في متجر التطبيقات", status: "not_supported", unsupported: ["places_reviews"] },
  ],
  "9 search results": [
    { text: "أول ١٠٠ نتيجة بحث جوجل لكلمة مطاعم", status: "not_supported", unsupported: ["search_results"] },
    { text: "حجم البحث الشهري للكلمات المفتاحية في السعودية", status: "not_supported", unsupported: ["search_results"] },
  ],
  "10 companies then decision makers": [
    { text: "عايز خمس شركات في مجال الكهرباء في مصر", status: "supported", supported: ["companies_decision_makers"] },
    { text: "أنا عايز تلاتة صناع قرار في شركات الكهرباء والميكانيكا في مصر مع البريد والهاتف", status: "supported", supported: ["companies_decision_makers"] },
  ],
  "11 jobs and product prices": [
    { text: "وظايف مفتوحة في شركات التقنية بمصر", status: "not_supported", unsupported: ["jobs_product_prices"] },
    { text: "قارن أسعار الهواتف في المتاجر الإلكترونية", status: "not_supported", unsupported: ["jobs_product_prices"] },
  ],
  "12 telegram reddit forums": [
    { text: "اسحب رسائل قناة تيليجرام عن العملات", status: "not_supported", unsupported: ["telegram_reddit_forums"] },
    { text: "نقاشات ريديت عن الذكاء الاصطناعي", status: "not_supported", unsupported: ["telegram_reddit_forums"] },
    { text: "منتديات عن السيارات المستعملة", status: "not_supported", unsupported: ["telegram_reddit_forums"] },
  ],
  "13 analysis of delivered data": [
    { text: "حلل النتائج اللي سحبتها وقارن بين الأشهر", status: "partly", supported: ["analysis_of_delivered"] },
    { text: "لخص الملف السابق وطلع أكثر الكلمات تكرارا", status: "partly", supported: ["analysis_of_delivered"] },
  ],
  "15 private data": [
    { text: "هات الرسائل الخاصة لحساب فلان على فيسبوك", status: "not_supported", unsupported: ["private_data"] },
    { text: "ابغى الرقم القومي لأشخاص في القاهرة", status: "not_supported", unsupported: ["private_data"] },
    { text: "هات كلمات المرور لحسابات", status: "not_supported", unsupported: ["private_data"] },
  ],
};

describe("the scenario matrix: every family of request gets the verdict the document promises", () => {
  for (const [group, cases] of Object.entries(CASES)) {
    describe(group, () => {
      for (const c of cases) {
        it(`${c.status}: ${c.text}`, () => {
          const result = assessCoverage(c.text);
          expect(result.status).toBe(c.status);
          for (const id of c.unsupported ?? []) expect(result.unsupported).toContain(id);
          for (const id of c.supported ?? []) expect(result.supported).toContain(id);
          if (c.status === "not_supported") expect(result.supported.filter((id) => id !== "analysis_of_delivered")).toHaveLength(0);
        });
      }
    });
  }

  it("the matrix has at least fourteen families, each with a status, what serves it and what is missing", () => {
    expect(COVERAGE_FAMILIES.filter((family) => family.no >= 1 && family.no <= 14)).toHaveLength(14);
    for (const family of COVERAGE_FAMILIES) {
      expect(["supported", "partly", "not_supported"]).toContain(family.status);
      expect(family.titleAr).not.toMatch(/[A-Za-z]/);
      expect(family.servedByAr.length).toBeGreaterThan(5);
      if (family.status !== "supported") expect(family.missingAr).not.toBe("—");
    }
  });
});

describe("a sold service with a topic named like something we do not sell stays supported", () => {
  for (const text of [
    "٣٠ تعليق يوتيوب عن أخبار الدولار",
    "تغريدات عن سعر الذهب",
    "١٠٠ منشور على إكس عن الدراسات الجامعية",
    "تعليقات تيك توك عن وظائف التقنية",
    "تعليقات فيديو عن مطاعم القاهرة",
    "٥٠ شركة تعمل في الأخبار في مصر",
    "منشورات إكس عن مباراة مصر والمغرب",
  ]) {
    it(text, () => expect(assessCoverage(text).status).toBe("supported"));
  }
});

describe("a sold service plus one we do not sell is partly served, and the plan says what it leaves out", () => {
  it("TikTok comments plus news from the newspapers", () => {
    const result = assessCoverage("تعليقات تيك توك عن كرة القدم وكمان أخبار من الجرايد");
    expect(result.status).toBe("partly");
    expect(result.unsupported).toEqual(["news_articles"]);
    expect(partlyNoteAr(result)).toContain("غير متاح حاليًا ولم يُسعَّر");
    expect(partlyNoteAr(result)).not.toMatch(/[A-Za-z]/);
  });
  it("companies plus the dollar price", () => {
    const result = assessCoverage("٥٠ شركة كهرباء في مصر مع سعر الدولار");
    expect(result.status).toBe("partly");
    expect(result.unsupported).toContain("price_series");
  });
});

describe("the plain answer for what we do not sell", () => {
  const reply = notSupportedReplyAr(assessCoverage("اسحب كل أخبار الدولار وأسعاره في السوق المصري من الجرايد الرسمية خلال آخر ٣ شهور"));
  it("says so, offers three things we can do, invents no source, and is Arabic only", () => {
    expect(reply).toContain("غير متاح في ديجر حاليًا");
    expect(reply).toContain("ولن أخمّن مصدرًا بديلًا");
    for (const line of WHAT_WE_CAN_DO_AR) expect(reply).toContain(line);
    expect(WHAT_WE_CAN_DO_AR).toHaveLength(3);
    expect(reply).not.toMatch(/[A-Za-z]/);
    expect(reply).not.toMatch(/https?:|\.com|\$|USD/);
  });
  it("private data is refused plainly", () => {
    const refusal = notSupportedReplyAr(assessCoverage("هات الرسائل الخاصة لحساب فلان"));
    expect(refusal).toContain("لا أستطيع جمع بيانات خاصة");
    expect(refusal).not.toMatch(/[A-Za-z]/);
  });
});

describe("no request the platform already serves is turned away (the understanding corpus)", () => {
  const served = (fixture as Array<{ id: string; request: string; expectedCapability: string }>).filter((entry) => !["topic_research", "vague", "greeting"].includes(entry.expectedCapability));
  it("has a real corpus", () => expect(served.length).toBeGreaterThan(20));
  for (const entry of served) {
    it(`${entry.id}: ${entry.request}`, () => {
      expect(assessCoverage(entry.request).status).not.toBe("not_supported");
    });
  }
});
