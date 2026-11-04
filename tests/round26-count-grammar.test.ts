import { describe, expect, it } from "vitest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { summaryAr } from "../src/lib/agentMission/foundation/compilePlan";

/**
 * ROUND 26, item 5: the count in every card line takes the Arabic plural rules (1, 2, 3 to 10, 11 and above) with the noun of the platform.
 * Live: the headline said «١٠ تغريدة من إكس»; it must say «١٠ تغريدات من إكس». Each platform's noun is tested at 1, 2, 3, 10, 11 and 100.
 */
const NOW = Date.UTC(2026, 10, 4);
const base = buildAsk("عايز داتا عن الذكاء الاصطناعي", "", NOW);

function askOn(platform: "x" | "tiktok" | "instagram" | "facebook" | "youtube") {
  return { ...base, platform };
}

describe("ROUND 26 item 5: the count and its noun agree (X)", () => {
  it("1 → «تغريدة واحدة»", () => { expect(summaryAr(askOn("x"), 1, [])).toMatch(/^تغريدة واحدة من إكس/); });
  it("2 → «تغريدتان»", () => { expect(summaryAr(askOn("x"), 2, [])).toMatch(/^تغريدتان من إكس/); });
  it("3 → «٣ تغريدات»", () => { expect(summaryAr(askOn("x"), 3, [])).toMatch(/^٣ تغريدات من إكس/); });
  it("10 → «١٠ تغريدات» (the live headline)", () => { expect(summaryAr(askOn("x"), 10, [])).toMatch(/^١٠ تغريدات من إكس/); });
  it("11 → «١١ تغريدة»", () => { expect(summaryAr(askOn("x"), 11, [])).toMatch(/^١١ تغريدة من إكس/); });
  it("100 → «١٠٠ تغريدة»", () => { expect(summaryAr(askOn("x"), 100, [])).toMatch(/^١٠٠ تغريدة من إكس/); });
});

describe("ROUND 26 item 5: the other platforms", () => {
  it("TikTok and YouTube use «فيديو»", () => {
    for (const p of ["tiktok", "youtube"] as const) {
      expect(summaryAr(askOn(p), 1, [])).toMatch(/^فيديو واحد/);
      expect(summaryAr(askOn(p), 2, [])).toMatch(/^فيديوهان/);
      expect(summaryAr(askOn(p), 3, [])).toMatch(/^٣ فيديوهات/);
      expect(summaryAr(askOn(p), 10, [])).toMatch(/^١٠ فيديوهات/);
      expect(summaryAr(askOn(p), 11, [])).toMatch(/^١١ فيديو /);
      expect(summaryAr(askOn(p), 100, [])).toMatch(/^١٠٠ فيديو /);
    }
  });
  it("Instagram and Facebook use «منشور»", () => {
    for (const p of ["instagram", "facebook"] as const) {
      expect(summaryAr(askOn(p), 1, [])).toMatch(/^منشور واحد/);
      expect(summaryAr(askOn(p), 2, [])).toMatch(/^منشوران/);
      expect(summaryAr(askOn(p), 3, [])).toMatch(/^٣ منشورات/);
      expect(summaryAr(askOn(p), 10, [])).toMatch(/^١٠ منشورات/);
      expect(summaryAr(askOn(p), 11, [])).toMatch(/^١١ منشورًا /);
      expect(summaryAr(askOn(p), 100, [])).toMatch(/^١٠٠ منشورًا /);
    }
  });
  it("from 3 to 10 the count is never followed by the bare singular", () => {
    for (const p of ["x", "tiktok", "instagram", "facebook", "youtube"] as const) {
      for (const n of [3, 10]) expect(summaryAr(askOn(p), n, [])).not.toMatch(/^[٠-٩]+ (تغريدة|فيديو|منشور) /u);
    }
  });
});
