import { describe, expect, it } from "vitest";
import {
  EGYPT_NEWS_SOURCES, NEWS_SOURCES_VERIFIED_ON, SUGGESTION_LABEL_AR, findSource, hasMachineAccess, markSuggestions, newsCandidates, newsReaderAvailable,
  newsSourceDecision, resolveSourceAnswer, sourceSetQuestion, unreadableSentenceAr,
} from "../src/lib/newsSources";
import { namedNewspapers } from "../src/lib/requestUnderstanding";

const DOLLAR_NEWS = "اسحب كل أخبار الدولار وأسعاره في السوق المصري من الجرايد الرسمية خلال آخر ٣ شهور";

describe("the curated list of Egyptian newspapers", () => {
  it("every row is real data: a domain, an Arabic name, how a program can read it, and the date it was measured", () => {
    expect(EGYPT_NEWS_SOURCES.length).toBeGreaterThanOrEqual(10);
    for (const source of EGYPT_NEWS_SOURCES) {
      expect(source.domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      expect(source.nameAr).toMatch(/[؀-ۿ]/);
      expect(source.verifiedOn).toBe(NEWS_SOURCES_VERIFIED_ON);
      for (const address of [source.access.sitemap, source.access.feed, source.access.search]) if (address) expect(address).toMatch(/^(?:https:\/\/|\/)/);
    }
    expect(new Set(EGYPT_NEWS_SOURCES.map((s) => s.id)).size).toBe(EGYPT_NEWS_SOURCES.length);
  });
  it("the official (state) newspapers are marked, and one of them has no readable access at all", () => {
    expect(EGYPT_NEWS_SOURCES.filter((s) => s.official).map((s) => s.id).sort()).toEqual(["ahram", "akhbarelyom", "gomhuria"]);
    expect(hasMachineAccess(findSource("أخبار اليوم")!)).toBe(false);
    expect(hasMachineAccess(findSource("اليوم السابع")!)).toBe(true);
  });
});

describe("a set of sources the customer did not name: the ONE pick question with real candidates", () => {
  it("the dollar-news request: «الجرايد الرسمية» gives the official newspapers, numbered, with room for his own list", () => {
    const candidates = newsCandidates(DOLLAR_NEWS);
    expect(candidates.map((c) => c.id).sort()).toEqual(["ahram", "akhbarelyom", "gomhuria"]);
    const question = sourceSetQuestion(candidates);
    expect(question.textAr.split("\n")[0]).toBe("تقصد هذه المصادر (١، ٢، ٣) أم لديك مصادر معينة؟");
    expect(question.textAr).toContain("١) ");
    expect(question.allowOther).toBe(true);
    expect(question.options).toContain("لدي مصادر أخرى سأكتبها");
    expect(question.textAr).not.toMatch(/[A-Za-z]/);
  });

  it("an unspecific request gets four candidates, the most readable first", () => {
    const candidates = newsCandidates("أخبار الدولار من الجرايد");
    expect(candidates).toHaveLength(4);
    expect(question4(candidates)).toContain("(١، ٢، ٣، ٤)");
    expect(candidates.every(hasMachineAccess)).toBe(true);
  });
  const question4 = (c: ReturnType<typeof newsCandidates>) => sourceSetQuestion(c).textAr.split("\n")[0];

  it("with a reader enabled, the request asks the question; the customer's numbers pick from the list", () => {
    const decision = newsSourceDecision(DOLLAR_NEWS, { readerAvailable: true });
    expect(decision.kind).toBe("ask");
    const candidates = newsCandidates(DOLLAR_NEWS);
    expect(resolveSourceAnswer("١، ٢", candidates).chosen.map((s) => s.id)).toEqual([candidates[0].id, candidates[1].id]);
    expect(resolveSourceAnswer("كلها", candidates).chosen).toHaveLength(3);
    expect(resolveSourceAnswer("٢", candidates).chosen).toHaveLength(1);
  });

  it("the customer's own list: names and addresses are matched to the verified list; an unknown name is never guessed", () => {
    const answer = resolveSourceAnswer("اليوم السابع وصدى البلد وجريدة الفجر الجديدة", []);
    expect(answer.chosen.map((s) => s.id)).toEqual(["youm7", "elbalad"]);
    expect(answer.unverified).toEqual(["جريدة الفجر الجديدة"]);
    expect(resolveSourceAnswer("www.masrawy.com", []).chosen.map((s) => s.id)).toEqual(["masrawy"]);
    expect(namedNewspapers("من الأهرام والمصري اليوم")).toEqual(expect.arrayContaining(["الأهرام", "المصري اليوم"]));
  });

  it("a plan is ready for the readable ones, and every unreadable or unverified one says why", () => {
    const decision = newsSourceDecision(DOLLAR_NEWS, { readerAvailable: true, answer: "الأهرام وأخبار اليوم وجريدة مجهولة" });
    expect(decision.kind).toBe("ready");
    if (decision.kind !== "ready") return;
    expect(decision.sources.map((s) => s.id)).toEqual(["ahram"]);
    expect(decision.notesAr.join(" ")).toContain("لا نستطيع قراءة «أخبار اليوم» الآن");
    expect(decision.notesAr.join(" ")).toContain("ليس في قائمة المصادر الموثقة");
  });

  it("a newspaper with no readable access gets an honest sentence, and nothing readable means no plan", () => {
    const sentence = unreadableSentenceAr(findSource("أخبار اليوم")!, true)!;
    expect(sentence).toContain("لا يوفّر بحثًا أو خريطة موقع أو خلاصة");
    expect(sentence).toContain("فلن نُسعِّره");
    const decision = newsSourceDecision(DOLLAR_NEWS, { readerAvailable: true, answer: "أخبار اليوم" });
    expect(decision.kind).toBe("none_readable");
  });

  it("with no service that reads web pages (today), the decision is «unavailable», and the sentence says reading newspapers is not enabled", () => {
    expect(newsSourceDecision(DOLLAR_NEWS, { readerAvailable: false }).kind).toBe("unavailable");
    expect(unreadableSentenceAr(findSource("اليوم السابع")!, false)).toContain("غير مفعّلة بعد");
    expect(newsReaderAvailable([{ slug: "social-x-posts", platform: "x" }, { slug: "icypeas-companies-search", platform: "companies" }])).toBe(false);
    expect(newsReaderAvailable([{ slug: "web-article-extract", platform: "web" }])).toBe(true);
  });

  it("a name the model suggests is marked «اقتراح» and checked against the list", () => {
    const marked = markSuggestions(["الأهرام", "جريدة وهمية"]);
    expect(marked.every((m) => m.label === SUGGESTION_LABEL_AR)).toBe(true);
    expect(marked[0].verified?.id).toBe("ahram");
    expect(marked[1].verified).toBeNull();
  });
});
