import { describe, expect, it } from "vitest";
import { countAr, knownItemNoun } from "../src/lib/agentMission/itemNoun";
import { nounCountAr } from "../src/lib/agentMission/stage2/arabicCount";

/** STAGE 2 S11 (docs/STAGE-2.md): a number with its noun in the Stage 2 sentences, by the last two digits from 100 up; the shared `countAr` is not changed. */
const comment = knownItemNoun("تعليق")!;
const video = knownItemNoun("فيديو")!;

describe("nounCountAr", () => {
  it("below 100 it is the shared countAr, unchanged", () => {
    for (const n of [0, 1, 2, 3, 10, 11, 40, 99]) expect(nounCountAr(n, comment)).toBe(countAr(n, comment));
  });
  it("from 100 up, the last two digits decide: 0 to 2 the singular, 3 to 10 the plural, 11 to 99 the accusative", () => {
    expect(nounCountAr(100, comment)).toBe("١٠٠ تعليق");
    expect(nounCountAr(101, comment)).toBe("١٠١ تعليق");
    expect(nounCountAr(1000, comment)).toBe("١٬٠٠٠ تعليق");
    expect(nounCountAr(103, comment)).toBe("١٠٣ تعليقات");
    expect(nounCountAr(110, comment)).toBe("١١٠ تعليقات");
    expect(nounCountAr(111, comment)).toBe("١١١ تعليقًا");
    expect(nounCountAr(250, video)).toBe("٢٥٠ فيديو");
  });
  it("the shared function still says what it said (no other surface changes)", () => {
    expect(countAr(100, comment)).toBe("١٠٠ تعليقًا");
  });
});
