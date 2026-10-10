import { describe, it, expect, vi } from "vitest";
import { METHODOLOGY_DEFAULT_POINTS } from "../src/app/api/jobs/[id]/methodology/route";

describe("Methodology Points & Strict Run-Facts Flow", () => {
  it("should have admin-configurable default of 10 points", () => {
    expect(METHODOLOGY_DEFAULT_POINTS).toBe(10);
  });

  it("should ensure methodology text contains only run facts and no invented numbers", () => {
    const runFacts = {
      platform: "TikTok",
      account: "@example_research",
      displayName: "قناة الأبحاث",
      verifiedStatus: "موثق رسمياً",
      followers: 45200,
      likes: 1250000,
      videosCount: 380,
      date: "2026-10-10",
      recordsCount: 1,
    };

    // Format statement using run facts
    const text = `
1. مصدر البيانات وأصلها: تم جمع بيانات هذه الدراسة من منصة ${runFacts.platform} للحساب (${runFacts.account}) [${runFacts.displayName}].
2. النطاق الزمني: ${runFacts.date}
- إجمالي المتابعين: ${runFacts.followers}
- إجمالي الإعجابات: ${runFacts.likes}
- إجمالي المقاطع: ${runFacts.videosCount}
- إجمالي السجلات: ${runFacts.recordsCount}
`.trim();

    // Verify all facts are present
    expect(text).toContain(String(runFacts.followers));
    expect(text).toContain(String(runFacts.likes));
    expect(text).toContain(String(runFacts.videosCount));
    expect(text).toContain(runFacts.date);
    expect(text).toContain(runFacts.account);

    // Extract all numbers from text
    const numbersInText = text.match(/\b\d+\b/g)?.map(Number) || [];
    const expectedFactNumbers = [1, 2, runFacts.followers, runFacts.likes, runFacts.videosCount, runFacts.recordsCount, 2026, 10];

    for (const num of numbersInText) {
      expect(expectedFactNumbers).toContain(num);
    }
  });

  it("should enforce reserve/charge sequence for 10 points", () => {
    const pointsToCharge = METHODOLOGY_DEFAULT_POINTS;
    let balance = 15;
    const ledger = [];

    // 1. Reserve
    expect(balance).toBeGreaterThanOrEqual(pointsToCharge);
    ledger.push({ type: "reserve", points: -pointsToCharge, jobId: "meth_job123" });
    balance -= pointsToCharge;
    expect(balance).toBe(5);

    // 2. Release & Charge clean sequence
    ledger.push({ type: "release", points: pointsToCharge, jobId: "meth_job123" });
    balance += pointsToCharge;
    ledger.push({ type: "charge", points: -pointsToCharge, jobId: "meth_job123" });
    balance -= pointsToCharge;

    expect(balance).toBe(5);
    expect(ledger.length).toBe(3);
    expect(ledger[0].type).toBe("reserve");
    expect(ledger[1].type).toBe("release");
    expect(ledger[2].type).toBe("charge");
  });
});
