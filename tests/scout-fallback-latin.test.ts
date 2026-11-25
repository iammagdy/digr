import { describe, it, expect } from "vitest";
import { scoutFallbackAr, numbersWritten, type CatalogWideningOptionFact } from "../agent/src/llmPlanner/planner";
import { writtenLatinWords, foreignLatinIn } from "../src/lib/agentMission/shownWords";

describe("DT-20261125-fallback-latin-name: scoutFallbackAr Latin word suppression", () => {
  const baseFinding = (overrides: Partial<any> = {}): any => ({
    step: {
      key: "s1",
      title_ar: "تغريدات عن الشائعات",
      platform: "x",
      capability: "user_posts",
      source: { kind: "account", value: "SaudiMOH" },
      count: { total: 20 },
      ...overrides.step,
    },
    requested: 20,
    found: 0,
    exhausted: true,
    sets: 1,
    examinedCount: 80,
    stopReason: "window_crossed",
    ...overrides,
  });

  // M1
  it("M1: customer did not write handle -> question has no Latin, contains 80, contains المصدر المطلوب, contains ولم نجد نتائج متطابقة", () => {
    const finding = baseFinding({
      found: 0,
      examinedCount: 80,
      step: {
        title_ar: "تغريدات عن الشائعات",
        source: { kind: "account", value: "SaudiMOH" },
        platform: "x",
        capability: "user_posts",
      },
    });
    const said = ["عايز تغريدات وزارة الصحة السعودية عن الشائعات"];
    const res = scoutFallbackAr([finding], said);

    expect(res.question_ar).not.toMatch(/[A-Za-z]/);
    expect(res.question_ar).toContain("٨٠ تغريدة");
    expect(res.question_ar).toContain("من المصدر المطلوب");
    expect(res.question_ar).toContain("ولم نجد نتائج متطابقة");
  });

  // M2
  it("M2: source.value is Arabic and customer wrote it -> contains source.value", () => {
    const finding = baseFinding({
      found: 0,
      examinedCount: 80,
      step: {
        title_ar: "تغريدات عن الشائعات",
        source: { kind: "account", value: "وزارة الصحة السعودية" },
        platform: "x",
        capability: "user_posts",
      },
    });
    const said = ["عايز تغريدات وزارة الصحة السعودية عن الشائعات"];
    const res = scoutFallbackAr([finding], said);

    expect(res.question_ar).toContain("من وزارة الصحة السعودية");
  });

  // M3
  it("M3: source.value is Arabic name model invented (customer wrote none of its words) -> contains المصدر المطلوب", () => {
    const finding = baseFinding({
      found: 0,
      examinedCount: 80,
      step: {
        title_ar: "تغريدات عن الشائعات",
        source: { kind: "account", value: "هيئة الغذاء والدواء" },
        platform: "x",
        capability: "user_posts",
      },
    });
    const said = ["عايز تغريدات وزارة الصحة السعودية عن الشائعات"];
    const res = scoutFallbackAr([finding], said);

    expect(res.question_ar).toContain("من المصدر المطلوب");
    expect(res.question_ar).not.toContain("هيئة");
  });

  // M4
  it("M4: found = 0, examinedCount = 0, no source, title_ar has unwritten Latin -> falls back to noun plural", () => {
    const finding = baseFinding({
      found: 0,
      examinedCount: 0,
      step: {
        title_ar: "تغريدات SaudiMOH",
        source: undefined,
        platform: "x",
        capability: "user_posts",
      },
    });
    const said = ["عايز بحث في التغريدات"];
    const res = scoutFallbackAr([finding], said);

    expect(res.question_ar).not.toMatch(/[A-Za-z]/);
    expect(res.question_ar).toContain("تغريدات");
  });

  // M5
  it("M5: found = 2, examinedCount 78, title_ar has unwritten Latin -> no Latin, contains 78 and 2", () => {
    const finding = baseFinding({
      found: 2,
      requested: 20,
      examinedCount: 78,
      step: {
        title_ar: "تغريدات @SaudiMOH عن الشائعات",
        source: undefined,
        platform: "x",
        capability: "user_posts",
      },
    });
    const said = ["عايز تغريدات عن الشائعات"];
    const res = scoutFallbackAr([finding], said);

    expect(res.question_ar).not.toMatch(/[A-Za-z]/);
    expect(res.question_ar).toContain("٧٨");
    expect(res.question_ar).toContain("٢");
  });

  // M6
  it("M6: recommendation stays with wideningFacts, no price points in message", () => {
    const finding = baseFinding({
      found: 0,
      examinedCount: 80,
      step: {
        title_ar: "تغريدات عن الشائعات",
        source: { kind: "account", value: "SaudiMOH" },
        platform: "x",
        capability: "user_posts",
      },
    });
    const said = ["عايز تغريدات وزارة الصحة السعودية عن الشائعات"];
    const wideningFacts: CatalogWideningOptionFact[] = [
      {
        kind: "take_found",
        stem_ar: "سلّمني الموجود فقط",
        suffix_ar: "",
        label_ar: "سلّمني الموجود فقط",
        addable_rows: 0,
        estimate_kind: "exact",
        max_price_points: null,
        min_applied: false,
        min_charge_points: null,
      },
      {
        kind: "platform_search",
        stem_ar: "البحث في إكس بالكامل",
        suffix_ar: "",
        label_ar: "البحث في إكس بالكامل",
        addable_rows: 100,
        estimate_kind: "up_to",
        max_price_points: 200,
        min_applied: true,
        min_charge_points: 200,
      },
    ];

    const res = scoutFallbackAr([finding], said, wideningFacts);
    expect(res.question_ar).toContain("وننصحك بخيار:");
    const nums = numbersWritten(res.question_ar);
    expect(nums.has("200")).toBe(false);
    expect(res.question_ar).not.toContain("نقطة");
  });

  // M7
  it("M7: property over M1..M6: foreignLatinIn(question_ar, writtenLatinWords(said)) is [] for every case", () => {
    const cases = [
      // M1
      {
        finding: baseFinding({
          found: 0,
          examinedCount: 80,
          step: { title_ar: "تغريدات عن الشائعات", source: { kind: "account", value: "SaudiMOH" } },
        }),
        said: ["عايز تغريدات وزارة الصحة السعودية عن الشائعات"],
      },
      // M2
      {
        finding: baseFinding({
          found: 0,
          examinedCount: 80,
          step: { title_ar: "تغريدات عن الشائعات", source: { kind: "account", value: "وزارة الصحة السعودية" } },
        }),
        said: ["عايز تغريدات وزارة الصحة السعودية عن الشائعات"],
      },
      // M3
      {
        finding: baseFinding({
          found: 0,
          examinedCount: 80,
          step: { title_ar: "تغريدات عن الشائعات", source: { kind: "account", value: "هيئة الغذاء والدواء" } },
        }),
        said: ["عايز تغريدات وزارة الصحة السعودية عن الشائعات"],
      },
      // M4
      {
        finding: baseFinding({
          found: 0,
          examinedCount: 0,
          step: { title_ar: "تغريدات SaudiMOH", source: undefined },
        }),
        said: ["عايز بحث في التغريدات"],
      },
      // M5
      {
        finding: baseFinding({
          found: 2,
          examinedCount: 78,
          step: { title_ar: "تغريدات @SaudiMOH عن الشائعات", source: undefined },
        }),
        said: ["عايز تغريدات عن الشائعات"],
      },
      // M6
      {
        finding: baseFinding({
          found: 0,
          examinedCount: 80,
          step: { title_ar: "تغريدات عن الشائعات", source: { kind: "account", value: "SaudiMOH" } },
        }),
        said: ["عايز تغريدات وزارة الصحة السعودية عن الشائعات"],
        wideningFacts: [
          {
            kind: "take_found" as const,
            stem_ar: "سلّمني الموجود فقط",
            suffix_ar: "",
            label_ar: "سلّمني الموجود فقط",
            addable_rows: 0,
            estimate_kind: "exact" as const,
            max_price_points: null,
            min_applied: false,
            min_charge_points: null,
          },
          {
            kind: "platform_search" as const,
            stem_ar: "البحث في إكس بالكامل",
            suffix_ar: "",
            label_ar: "البحث في إكس بالكامل",
            addable_rows: 100,
            estimate_kind: "up_to" as const,
            max_price_points: 200,
            min_applied: true,
            min_charge_points: 200,
          },
        ],
      },
    ];

    for (const c of cases) {
      const res = scoutFallbackAr([c.finding], c.said, c.wideningFacts);
      const foreign = foreignLatinIn(res.question_ar, writtenLatinWords(c.said));
      expect(foreign).toEqual([]);
    }
  });

  // COUNTER-CASES
  it("C1: customer wrote handle -> handle is shown", () => {
    const finding = baseFinding({
      found: 0,
      examinedCount: 80,
      step: {
        title_ar: "تغريدات عن الشائعات",
        source: { kind: "account", value: "SaudiMOH" },
        platform: "x",
        capability: "user_posts",
      },
    });
    const said = ["عايز اسحب داتا عن الشائعات اتنشرت على وزارة الصحة في السعودية @SaudiMOH"];
    const res = scoutFallbackAr([finding], said);

    expect(res.question_ar).toContain("من SaudiMOH");
  });

  it("C2: customer wrote handle in lowercase -> handle shown (case-insensitive)", () => {
    const finding = baseFinding({
      found: 0,
      examinedCount: 80,
      step: {
        title_ar: "تغريدات عن الشائعات",
        source: { kind: "account", value: "SaudiMOH" },
        platform: "x",
        capability: "user_posts",
      },
    });
    const said = ["عايز داتا من @saudimoh"];
    const res = scoutFallbackAr([finding], said);

    expect(res.question_ar).toContain("من SaudiMOH");
  });

  it("C3: title_ar with Latin customer wrote -> title kept as is", () => {
    const finding = baseFinding({
      found: 0,
      examinedCount: 0,
      step: {
        title_ar: "تعليقات عن iPhone",
        source: undefined,
        platform: "x",
        capability: "user_posts",
      },
    });
    const said = ["عايز تعليقات عن iPhone"];
    const res = scoutFallbackAr([finding], said);

    expect(res.question_ar).toContain("تعليقات عن iPhone");
  });
});
