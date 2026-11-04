import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ROUND 27, item 1: ONE SPELLING of the loading word. Live testing showed «جاري الاعتماد…» (no tanween) beside «جارٍ الحفظ…» (with tanween). The standard form is «جارٍ».
 * The word on its own (or with a leading «و»: «وجارٍ») must never come back without its tanween in the customer-facing code. Different words that only contain the letters stay:
 * «التجاري», «الجاري» (the current), «جاريًا», «جارية».
 * Scope: src/app, src/components, src/lib (not src/functions/**, which is protected: its stored placeholder texts are reported, not edited).
 */
const BARE = /(?<![؀-ۿ])و?جاري(?![؀-ۿ])/u;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx|css)$/.test(name) ? [full] : [];
});

describe("the loading word is spelled «جارٍ» in every customer component", () => {
  for (const dir of ["src/app", "src/components", "src/lib"]) {
    it(`${dir}: no «جاري» without its tanween`, () => {
      const offenders = walk(dir).filter((file) => BARE.test(readFileSync(file, "utf8")));
      expect(offenders).toEqual([]);
    });
  }
  it("the guard itself tells the loading word from the words that merely contain it", () => {
    expect(BARE.test("جاري الاعتماد…")).toBe(true);
    expect(BARE.test("وجاري بدء التنفيذ")).toBe(true);
    expect(BARE.test("جارٍ الحفظ…")).toBe(false);
    expect(BARE.test("السجل التجاري")).toBe(false);
    expect(BARE.test("بعد انتهاء طلبك الجاري")).toBe(false);
    expect(BARE.test("طلبًا جاريًا")).toBe(false);
  });
  it("the labels the live test named", () => {
    const card = readFileSync("src/components/mission/AgentMissionCard.tsx", "utf8");
    expect(card).toContain("جارٍ الاعتماد…");
    expect(card).not.toContain("جاري الاعتماد");
    expect(readFileSync("src/components/mission/PlanEditor.tsx", "utf8")).toContain("جارٍ الحفظ…");
  });
});
