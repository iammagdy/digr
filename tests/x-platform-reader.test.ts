import { describe, expect, it } from "vitest";
import { namesXPlatform } from "../src/lib/xPlatform";
import { detectSocialIntent } from "../src/lib/socialTasks";
import { detectMentionedPlatforms } from "../src/functions/shared/capabilityRegistry";

/**
 * ONE reader of the platform name, used by every detector. The live request «٤٠٠ منشور … أكس» was not read as X by a reader that wanted a preposition; two readers
 * disagreed on a bare Latin «x». Every spelling below is read the same by the social task detector, the capability registry's detector and `namesXPlatform`.
 */
const X_REQUESTS = [
  // MSA
  "أرغب بجمع ٤٠٠ منشور من حساب وزارة الصحة السعودية على منصة إكس",
  "أريد منشورات حساب وزارة الصحة على منصة أكس",
  // Egyptian
  "عايز ٤٠٠ بوست من حساب وزارة الصحة السعودية على أكس",
  "عايز ٤٠٠ بوست من حساب وزارة الصحة السعودية ع اكس",
  "هات لي آخر ٥٠ تغريده من @SaudiMOH على اكس",
  // Gulf, no hamza
  "ابغى ٤٠٠ تغريده من حساب وزارة الصحه السعوديه في اكس",
  "ابي ٤٠٠ منشور اكس عن الصحة",
  // hamza variants and tatweel
  "على إكس",
  "على اكـــس",
  "على ايكس",
  "لمنصة أكس",
  "لمنصه اكس",
  // after the content word, the bare name of the live request
  "٤٠٠ منشور أكس",
  "٤٠٠ منشور اكس من وزارة الصحة",
  "تغريدات اكس عن الصحة",
  "حساب أكس لوزارة الصحة",
  // the answer to the platform question
  "منصة البحث المطلوبة: أكس",
  "منصة البحث المطلوبة: منصة X",
  "المنصة التي تقصدها: إكس",
  // set apart at the end of the request
  "٤٠٠ منشور من الصحة السعودية، اكس",
  // Latin
  "posts on X about health",
  "من X",
  "تويتر",
  "منشورات تويتر",
  "https://x.com/SaudiMOH",
  "twitter posts",
];

const NOT_X = [
  "تحويل البيانات إلى اكسل",
  "ملف اكسل",
  "ماكس ديزاين",
  "ماكسيم جوركي",
  "٥٠ شركة مقاولات في مصر",
  "50 x 20",
  "تعليقات تيك توك عن كرة القدم",
  "قهوة اكسبريس",
  "mix",
  "max",
];

describe("the X name, one reader for every detector", () => {
  it.each(X_REQUESTS)("is X: %s", (text) => {
    expect(namesXPlatform(text)).toBe(true);
    expect(detectSocialIntent(text).platform).toBe("x");
    expect(detectMentionedPlatforms(text)).toContain("x");
  });

  it.each(NOT_X)("is not X: %s", (text) => {
    expect(namesXPlatform(text)).toBe(false);
    expect(detectSocialIntent(text).platform).not.toBe("x");
    expect(detectMentionedPlatforms(text)).not.toContain("x");
  });

  it("the three readers never disagree on any of the phrasings above", () => {
    for (const text of [...X_REQUESTS, ...NOT_X]) {
      const a = namesXPlatform(text);
      expect(detectSocialIntent(text).platform === "x").toBe(a);
      expect(detectMentionedPlatforms(text).includes("x")).toBe(a);
    }
  });

  it("a capability slug that carries the letter is X for the registry (social-x-posts)", () => {
    expect(detectMentionedPlatforms("social-x-posts")).toContain("x");
  });
});
