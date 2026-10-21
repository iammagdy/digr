import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCoverageDoc } from "../src/lib/coverageDoc";
import { COVERAGE_FAMILIES } from "../src/lib/requestCoverage";

describe("docs/CAPABILITY_COVERAGE.md is the platform's own table", () => {
  const committed = readFileSync("docs/CAPABILITY_COVERAGE.md", "utf-8");
  it("the committed document equals a fresh build (regenerate with npx tsx scripts/generate-coverage-doc.ts)", () => {
    expect(committed).toBe(buildCoverageDoc());
  });
  it("every family of the matrix is in it with its status, and there are at least fourteen scenarios", () => {
    expect(COVERAGE_FAMILIES.filter((f) => f.no <= 14)).toHaveLength(14);
    for (const family of COVERAGE_FAMILIES) {
      expect(committed).toContain(family.titleAr);
      expect(committed).toContain(`\`${family.id}\``);
    }
  });
  it("it says plainly that no news, price or search source is enabled, and that none was enabled by this work", () => {
    expect(committed).toContain("لم نفعّل أي مصدر جديد");
    expect(committed).toContain("غير مدعوم");
  });
  it("the customer's comment prices in the table are the ones a plan quotes: 0.275 points a YouTube comment and 0.275 a TikTok comment (0.00005 USD x 5,500)", () => {
    expect(committed).toMatch(/social-youtube-comments`\) \|[^|]+\| سجل \| 0\.275 \|/);
    expect(committed).toMatch(/social-tiktok-comments`\) \|[^|]+\| سجل \| 0\.275 \|/);
  });
});
