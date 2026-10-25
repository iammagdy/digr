import { describe, expect, it } from "vitest";
import { pointsAr } from "../src/lib/pointsFormat";
import { toArabicDigits } from "../src/lib/arabicDigits";
import { settlementEventAr } from "../src/lib/releaseWording";
import { formatNumber } from "../src/lib/honestDisplay";
import { readFileSync } from "node:fs";

/** The Arabic word for a count of points: 1 «نقطة واحدة», 2 «نقطتان», 3 to 10 «نقاط», 11 and more «نقطة». Digits Arabic-Indic. */
describe("the plural of points", () => {
  it("1 and 2 are written as words, 3 to 10 take «نقاط», everything else «نقطة»", () => {
    expect(pointsAr(1)).toBe("نقطة واحدة");
    expect(pointsAr(2)).toBe("نقطتان");
    for (const [value, digits] of [[3, "٣"], [4, "٤"], [5, "٥"], [9, "٩"], [10, "١٠"]] as Array<[number, string]>) expect(pointsAr(value), String(value)).toBe(`${digits} نقاط`);
    for (const [value, digits] of [[11, "١١"], [12, "١٢"], [100, "١٠٠"], [131, "١٣١"]] as Array<[number, string]>) expect(pointsAr(value), String(value)).toBe(`${digits} نقطة`);
    expect(pointsAr(0)).toBe("٠ نقطة");
  });

  it("the digits are always Arabic-Indic, with the grouping mark by default and without it when the place writes its numbers that way", () => {
    expect(pointsAr(1234)).toBe("١٬٢٣٤ نقطة");
    expect(pointsAr(1234, toArabicDigits)).toBe("١٢٣٤ نقطة");
    expect(pointsAr(4, toArabicDigits)).toBe("٤ نقاط");
    expect(pointsAr(7, formatNumber)).toBe(`${formatNumber(7)} نقاط`);
    for (const value of [0, 1, 2, 3, 10, 11, 25, 600, 1234]) expect(pointsAr(value), String(value)).not.toMatch(/[0-9]/);
  });

  it("a figure with decimals keeps «نقطة» after it (prices)", () => {
    expect(pointsAr(0.11715)).toBe("٠٫١٢ نقطة");
    expect(pointsAr(3.4485)).toBe("٣٫٤٥ نقطة");
    expect(pointsAr(2.5, toArabicDigits)).toBe(`${toArabicDigits(2.5)} نقطة`); // a place that writes its own numbers keeps its way
  });

  it("a bad value is written as zero, never as «NaN» or «undefined»", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number]) expect(pointsAr(value)).toBe("٠ نقطة");
  });
});

describe("the places that tell the customer what was charged", () => {
  it("the worker's completion line and its failure line use the helper (charge 4, release 131: «٤ نقاط» and «١٣١ نقطة»)", () => {
    const worker = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(worker).toContain("settlementEventAr({ reservedPoints: chargedPts + refundedPts, chargedPoints: chargedPts }, toArabicDigits)");
    expect(worker).toContain("(حُرّر الحجز المؤقت ${pointsAr(Math.round(releasedCredits), toArabicDigits)}، ولم يُخصم شيء)");
    expect(settlementEventAr({ reservedPoints: 135, chargedPoints: 4 }, toArabicDigits)).toBe("حُرّر الحجز المؤقت كاملًا (١٣٥ نقطة)، ثم خُصم ثمن ما سُلّم فقط (٤ نقاط)، فيبقى في رصيدك ١٣١ نقطة من هذا الحجز.");
  });

  it("the run card and the job notices use it too", () => {
    expect(readFileSync("src/app/dashboard/chat/components/RunSections.tsx", "utf8")).toContain("تم خصم {pointsAr(charged)}.");
    const notices = readFileSync("src/lib/server/jobNotices.ts", "utf8");
    expect(notices).toContain("pointsAr(facts.chargedPoints, arCount)");
    expect(notices).toContain("pointsAr(facts.refundedPoints, arCount)");
  });
});
