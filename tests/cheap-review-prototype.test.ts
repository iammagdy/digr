import { describe, expect, it } from "vitest";
import {
  AuditWindow, CHEAP_BATCH_ROWS, cheapCallCostUsd, clusterRows, normalizeForCluster, readDigitReply, similarity, strongSignal, TODAY_CALL_LEAN,
  todayCallCostUsd, TrustedPublishers,
} from "../scripts/cheapReview/prototype";

describe("the cost model reproduces the calls measured on production", () => {
  it("today's 20-row call (3,325 tokens in, 1,000 out) costs 0.00666 USD; 25 rows cost 0.0083 USD", () => {
    expect(todayCallCostUsd(20)).toBeCloseTo(0.006664, 6);
    expect(Math.abs(todayCallCostUsd(20) - 0.00666)).toBeLessThan(0.00001);
    expect(Math.abs(todayCallCostUsd(25) - 0.0083)).toBeLessThan(0.0001);
  });

  it("the same call with a lean 20-token reply per row costs 0.00426 USD (the sensitivity case)", () => {
    expect(todayCallCostUsd(20, TODAY_CALL_LEAN)).toBeCloseTo(0.004264, 6);
  });

  it("a shorter text per row lowers the cheap call: 70 tokens a row costs 0.00336 USD for 50 rows, 50 tokens a row 0.00256", () => {
    expect(cheapCallCostUsd(50, 70)).toBeCloseTo(0.00336, 6);
    expect(cheapCallCostUsd(50, 50)).toBeCloseTo(0.00256, 6);
    expect(cheapCallCostUsd(50, 110)).toBe(cheapCallCostUsd(50));
  });

  it("the cheap call of 50 rows costs about 0.0049 USD, about a third of today's cost per row, and its reply is under 10% of today's output", () => {
    expect(CHEAP_BATCH_ROWS).toBe(50);
    expect(cheapCallCostUsd(50)).toBeCloseTo(0.00496, 6);
    expect(cheapCallCostUsd(50) / 50).toBeLessThan((todayCallCostUsd(20) / 20) * 0.35);
    // output tokens per row: 1.4 (70 for 50 rows) against 50
    expect((10 + 1.2 * 50) / 50).toBeCloseTo(1.4, 6);
    expect((10 + 1.2 * 50) / 50).toBeLessThan(0.1 * (1000 / 20));
  });
});

describe("near-duplicate clustering", () => {
  it("the text compared has no retweet prefix, links, mentions, digits, tashkeel or repeated letters, and the letters are folded", () => {
    expect(normalizeForCluster("RT @user1: غلاااااء الأسعار في مصر!!! https://t.co/abc 123 #غلاء")).toBe("غلاء الاسعار في مصر غلاء");
    expect(normalizeForCluster("الأَسْعَارُ ارتفعت ٣٠٪ فى المنصورة @ahmed")).toBe("الاسعار ارتفعت في المنصوره");
    expect(normalizeForCluster("")).toBe("");
  });

  it("the same message with another link, mention, number and a stretched word is one cluster; an unrelated message is another", () => {
    const texts = [
      "غلاء الأسعار في مصر بقى لا يطاق والناس مش قادرة تعيش https://t.co/aaa",
      "RT @x: غلاااااء الأسعار في مصر بقى لا يطاق والناس مش قادرة تعيش 2026",
      "اسعار الدواجن ارتفعت اليوم في سوق طنطا بشكل كبير جدا",
      "غلاء الأسعار في مصر بقى لا يطاق والناس مش قادرة تعيش @someone",
    ];
    const { clusterOf, representatives } = clusterRows(texts);
    expect(clusterOf).toEqual([0, 0, 1, 0]);
    expect(representatives).toEqual([0, 2]);
  });

  it("a text of fewer than three words is the same only when it is equal; the threshold decides the rest", () => {
    expect(similarity(normalizeForCluster("غلاء"), normalizeForCluster("غلاء!!!"))).toBe(1);
    expect(similarity(normalizeForCluster("غلاء مصر"), normalizeForCluster("غلاء مصر جدا"))).toBe(0);
    expect(similarity("a b c d", "a b c e")).toBeCloseTo(3 / 5, 5);
    expect(clusterRows(["غلاء الاسعار في مصر اليوم جدا", "غلاء الاسعار في مصر اليوم كثيرا"], 0.85).representatives).toEqual([0, 1]);
    expect(clusterRows(["غلاء الاسعار في مصر اليوم جدا", "غلاء الاسعار في مصر اليوم كثيرا"], 0.6).representatives).toEqual([0]);
  });
});

describe("the number-only reply is read strictly", () => {
  const canaries = [{ position: 2, expected: "0" as const }, { position: 5, expected: "1" as const }];

  it("a complete reply, with spaces in groups of five, gives one verdict per row", () => {
    const reading = readDigitReply("10120 01101\n1", 11, { canaries: [{ position: 2, expected: "1" }] });
    expect(reading.status).toBe("ok");
    expect(reading.verdicts.join("")).toBe("10120011011");
  });

  it("a reply with any other character, the wrong number of digits or a wrong canary is rejected whole, never partly kept", () => {
    expect(readDigitReply("1 0 1 x 1", 5)).toMatchObject({ status: "rejected", reason: "not_digits" });
    expect(readDigitReply("```101```", 3)).toMatchObject({ status: "rejected", reason: "not_digits" });
    expect(readDigitReply("", 5)).toMatchObject({ status: "rejected", reason: "empty" });
    expect(readDigitReply("1010", 6)).toMatchObject({ status: "rejected", reason: "too_short" });
    expect(readDigitReply("1010101", 6)).toMatchObject({ status: "rejected", reason: "too_long" });
    expect(readDigitReply("111011", 6, { canaries })).toMatchObject({ status: "rejected", reason: "canary_failed" });
    expect(readDigitReply("111011", 6, { canaries }).verdicts.every((verdict) => verdict === null)).toBe(true);
    expect(readDigitReply("100011", 6, { canaries }).status).toBe("ok");
  });

  it("a reply cut at the output limit keeps its verified prefix only; the rows after it have no verdict", () => {
    const reading = readDigitReply("10010", 8, { canaries, truncated: true });
    expect(reading.status).toBe("partial");
    expect(reading.verdicts).toEqual(["1", "0", "0", "1", "0", null, null, null]);
    // a canary inside the prefix that is wrong rejects the whole reply
    expect(readDigitReply("10110", 8, { canaries, truncated: true })).toMatchObject({ status: "rejected", reason: "canary_failed" });
    // a canary beyond the prefix is not checked (the rows after the cut are asked again)
    expect(readDigitReply("100", 8, { canaries, truncated: true }).status).toBe("partial");
    // a short reply that was not cut is a miscount, not a cut
    expect(readDigitReply("10010", 8, { canaries })).toMatchObject({ status: "rejected", reason: "too_short" });
  });
});

describe("trusted publishers (one job)", () => {
  it("two consecutive model matches make a publisher trusted; a no match or an uncertain verdict ends the trust; a revoked publisher starts again", () => {
    const trusted = new TrustedPublishers();
    trusted.record("@Ali", "match");
    expect(trusted.isTrusted("@ali")).toBe(false);
    trusted.record("@ALI ", "match");
    expect(trusted.isTrusted("@ali")).toBe(true);
    trusted.record("@ali", "other");
    expect(trusted.isTrusted("@ali")).toBe(false);
    trusted.record("@ali", "match"); trusted.record("@ali", "match");
    expect(trusted.isTrusted("@ali")).toBe(true);
    trusted.revoke("@ali");
    expect(trusted.isTrusted("@ali")).toBe(false);
  });

  it("a row with no publisher never makes anyone trusted, and a new job starts with nobody trusted", () => {
    const trusted = new TrustedPublishers();
    for (const publisher of [null, undefined, "", "  "]) { trusted.record(publisher, "match"); trusted.record(publisher, "match"); expect(trusted.isTrusted(publisher)).toBe(false); }
    expect(new TrustedPublishers().isTrusted("@ali")).toBe(false);
  });
});

describe("the audit window and the fall-back to strict review", () => {
  it("the estimate is unknown below 12 audited rows, then the share of false accepts of the last 40", () => {
    const audit = new AuditWindow();
    for (let i = 0; i < 11; i += 1) audit.add(i < 5);
    expect(audit.estimate()).toBeNull();
    expect(audit.strict).toBe(false);
    audit.add(false);
    expect(audit.estimate()).toBeCloseTo(5 / 12, 5);
  });

  it("strict review starts when the false-accept share is above 15% and ends at 10% or below (not in between)", () => {
    const audit = new AuditWindow();
    for (let i = 0; i < 40; i += 1) audit.add(i % 10 === 0); // 4 of 40: 10%
    expect(audit.strict).toBe(false);
    for (let i = 0; i < 4; i += 1) audit.add(true); // 7 of 40: 17.5%
    expect(audit.estimate()!).toBeGreaterThan(0.15);
    expect(audit.strict).toBe(true);
    // clean audits push the estimate down: between 10% and 15% it stays strict, at 10% or below it ends
    let between = false;
    for (let i = 0; i < 80; i += 1) {
      audit.add(false);
      const estimate = audit.estimate()!;
      if (estimate <= 0.15 && estimate > 0.1) { between = true; expect(audit.strict).toBe(true); }
      if (estimate <= 0.1) break;
    }
    expect(between).toBe(true);
    expect(audit.estimate()!).toBeLessThanOrEqual(0.1);
    expect(audit.strict).toBe(false);
  });

  it("exactly 15% does not start strict review", () => {
    const audit = new AuditWindow(20, 12, 0.15, 0.1);
    for (let i = 0; i < 20; i += 1) audit.add(i >= 17);
    expect(audit.estimate()).toBe(0.15);
    expect(audit.strict).toBe(false);
    audit.add(true); // the window moves on: 4 of 20 is 20%
    expect(audit.strict).toBe(true);
  });
});

describe("strong-signal acceptance in code", () => {
  const prices = { query: "غلاء الأسعار", region: "EG" };

  it("tier A: a word of the topic with the country's name or demonym, a governorate or a city is accepted without a model call", () => {
    expect(strongSignal("غلاء الأسعار في مصر بقى لا يطاق", prices)).toMatchObject({ accept: true, tier: "A", signals: ["country"] });
    expect(strongSignal("الأسعار غلت أوي في طنطا النهارده", prices)).toMatchObject({ accept: true, tier: "A", signals: ["place:طنطا"] });
    expect(strongSignal("ارتفاع الاسعار في كفر الشيخ والمنوفية", prices).accept).toBe(true);
    expect(strongSignal("الغلاء المصري", prices).accept).toBe(true);
  });

  it("no topic word, or another country named, is never accepted by code", () => {
    expect(strongSignal("مصر بلد جميلة وفيها ناس طيبة", prices)).toEqual({ accept: false, tier: null, signals: [] });
    expect(strongSignal("غلاء الأسعار في السعودية ومصر", prices).accept).toBe(false);
    expect(strongSignal("غلاء الأسعار في الكويت", prices).accept).toBe(false);
    expect(strongSignal("prices are rising in Egypt but also in Saudi", { query: "prices", region: "EG" }).accept).toBe(false);
    expect(strongSignal("", prices).accept).toBe(false);
  });

  it("a topic word alone, or with a club, is not enough for a topic that is not sports; tier B needs a sports topic", () => {
    expect(strongSignal("الأسعار غالية", prices).accept).toBe(false);
    expect(strongSignal("الأسعار غالية زي تذاكر الأهلي", prices).accept).toBe(false);
    const sports = { query: "كرة القدم", region: "EG", sports: true };
    expect(strongSignal("كرة القدم مع الأهلي والزمالك", sports)).toMatchObject({ accept: true, tier: "B" });
    expect(strongSignal("كرة القدم مع الأهلي والزمالك", { ...sports, sports: false }).accept).toBe(false);
  });

  it("tier C (two dialect markers) is off unless asked for, and then still needs the topic word", () => {
    const text = "الأسعار غليت ازاي كده دلوقتي";
    expect(strongSignal(text, prices).accept).toBe(false);
    expect(strongSignal(text, { ...prices, allowDialectTier: true })).toMatchObject({ accept: true, tier: "C" });
    expect(strongSignal("ازاي كده دلوقتي", { ...prices, allowDialectTier: true }).accept).toBe(false);
    expect(strongSignal("الأسعار غليت كده", { ...prices, allowDialectTier: true }).accept).toBe(false);
  });
});
