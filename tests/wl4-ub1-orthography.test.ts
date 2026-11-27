import { describe, expect, it } from "vitest";
import {
  arabicCommaSemicolonToSpace, foldAlefForms, foldAlefHamzaForms, foldAlefMaqsura, foldFinalTaMarbuta, foldGroupedNumberMarks, foldTaMarbuta, looseSpellingPattern,
  removeGroupingMarks, stripArabicMarkBlock, stripBidiAndBom, stripHarakatDaggerTatweel, stripHarakatTatweel,
} from "../src/lib/arabicNormalize";

/**
 * UB1 (DT-20261126-wordlist-wave4, D-0238): every helper is the SAME character set the caller used before. The OLD expressions are frozen here (copied from a20974ec/cd33fd1e) and compared with the
 * helper on EVERY code unit of the Basic Multilingual Plane (single-character strings), on every pair drawn from the characters the sets are made of, and on 4000 seeded random strings.
 */
const OLD = {
  markBlock: (s: string) => s.replace(/[ً-ٰٟـ]/g, ""),
  harakatDaggerTatweel: (s: string) => s.replace(/[ً-ْٰـ]/g, ""),
  harakatTatweel: (s: string) => s.replace(/[ً-ْـ]/g, ""),
  bidiAndBom: (s: string) => s.replace(/[​-‏‪-‮﻿]/g, ""),
  alefForms: (s: string) => s.replace(/[أإآٱ]/g, "ا"),
  alefHamzaForms: (s: string) => s.replace(/[أإآ]/g, "ا"),
  maqsura: (s: string) => s.replace(/ى/g, "ي"),
  taMarbuta: (s: string) => s.replace(/ة/g, "ه"),
  finalTaMarbuta: (s: string) => s.replace(/ة$/g, "ه"),
  commaSemicolon: (s: string) => s.replace(/[،؛]/g, " "),
  groupingMarks: (s: string) => s.replace(/[٬,]/g, ""),
  groupedNumbers: (s: string) => s.replace(/(\d)[,٬](?=\d{3}\b)/g, "$1").replace(/(\d)٫(\d)/g, "$1.$2"),
  loosePattern: (w: string) => w.replace(/ا/g, "[اأإ]").replace(/[هة]/g, "[هة]").replace(/ي/g, "[يى]"),
};
const PAIRS: Array<[string, (s: string) => string, (s: string) => string]> = [
  ["stripArabicMarkBlock", OLD.markBlock, stripArabicMarkBlock],
  ["stripHarakatDaggerTatweel", OLD.harakatDaggerTatweel, stripHarakatDaggerTatweel],
  ["stripHarakatTatweel", OLD.harakatTatweel, stripHarakatTatweel],
  ["stripBidiAndBom", OLD.bidiAndBom, stripBidiAndBom],
  ["foldAlefForms", OLD.alefForms, foldAlefForms],
  ["foldAlefHamzaForms", OLD.alefHamzaForms, foldAlefHamzaForms],
  ["foldAlefMaqsura", OLD.maqsura, foldAlefMaqsura],
  ["foldTaMarbuta", OLD.taMarbuta, foldTaMarbuta],
  ["foldFinalTaMarbuta", OLD.finalTaMarbuta, foldFinalTaMarbuta],
  ["arabicCommaSemicolonToSpace", OLD.commaSemicolon, arabicCommaSemicolonToSpace],
  ["removeGroupingMarks", OLD.groupingMarks, removeGroupingMarks],
  ["foldGroupedNumberMarks", OLD.groupedNumbers, foldGroupedNumberMarks],
  ["looseSpellingPattern", OLD.loosePattern, looseSpellingPattern],
];
// the characters the sets are made of, plus neighbours that must NOT be touched
const POOL = ["ً", "ٌ", "ٍ", "َ", "ُ", "ِ", "ّ", "ْ", "ٓ", "ٔ", "ٟ", "٠", "٥", "٩", "٪", "٫", "٬", "٭", "ٰ", "ٱ", "ـ", "ا", "أ", "إ", "آ", "ى", "ي", "ة", "ه", "ؤ", "ئ", "،", "؛", "؟", ",", ".", ";", " ", "0", "1", "5", "9", "a", "Z", "_", "-", "​", "‌", "‍", "‎", "‏", "‪", "‮", "⁠", "⁦", "﻿", "­", "ب", "ت", "م", "س", "ل", "\n"];
const seeded = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

describe("UB1 helpers = the frozen old expressions", () => {
  for (const [name, oldFn, newFn] of PAIRS) {
    it(`${name}: every code unit of the BMP, every pair of the pool, 4000 random strings`, () => {
      for (let code = 0; code <= 0xffff; code++) {
        const s = String.fromCharCode(code);
        if (oldFn(s) !== newFn(s)) throw new Error(`${name}: differs at U+${code.toString(16).padStart(4, "0")}: old ${JSON.stringify(oldFn(s))} new ${JSON.stringify(newFn(s))}`);
      }
      for (const a of POOL) for (const b of POOL) {
        const s = a + b;
        if (oldFn(s) !== newFn(s)) throw new Error(`${name}: differs on pair ${JSON.stringify(s)}`);
      }
      const rnd = seeded(20261127);
      for (let i = 0; i < 4000; i++) {
        const len = 1 + Math.floor(rnd() * 14);
        let s = "";
        for (let k = 0; k < len; k++) s += POOL[Math.floor(rnd() * POOL.length)];
        if (oldFn(s) !== newFn(s)) throw new Error(`${name}: differs on ${JSON.stringify(s)}`);
      }
    });
  }
  it("number grouping: the cases the callers meet (digits are Latin when it runs)", () => {
    for (const s of ["1,500", "1٬500", "1,5000", "12,345,678", "1٬234٬567 شركة", "2٫5", "2٫5٫7", "1,500٫5", "a1,500b", "1,500a", "1,50", "٫5", "5٫", "1,234_", "ألف 1,000 و2٫5"]) {
      expect(foldGroupedNumberMarks(s), s).toBe(OLD.groupedNumbers(s));
    }
    expect(foldGroupedNumberMarks("1,500")).toBe("1500");
    expect(foldGroupedNumberMarks("2٫5")).toBe("2.5");
  });
  it("counter-cases: a mark that is NOT in a set stays (the sets are not widened)", () => {
    expect(stripHarakatTatweel("ٰ")).toBe("ٰ"); // the dagger alef is not in the 9-unit set
    expect(stripHarakatDaggerTatweel("ٰ")).toBe(""); // but it is in the 10-unit set
    expect(stripArabicMarkBlock("2٫5")).toBe("25"); // PRESERVED existing behaviour: the 39-unit set also removes the Arabic decimal mark (noted for UB2, not changed here)
    expect(foldAlefHamzaForms("ٱ")).toBe("ٱ"); // the alef wasla is left alone by the 3-form fold
    expect(foldAlefForms("ٱ")).toBe("ا");
    expect(foldFinalTaMarbuta("ةة")).toBe("ةه");
  });
});
