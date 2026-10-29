import { describe, expect, it } from "vitest";
import { bindQuantity, parseQuantities, parseRequestedQuantity } from "../src/lib/agentMission/quantity";

/**
 * THE CUSTOMER'S QUANTITY IS READ BY CODE from their own words (digits and number words, Arabic and Western digits, dialect forms), never from the model. These are the forms a real request uses; a number that counts
 * time, money, a year or «per video» is not the total, and a number word in ordinary speech is not a quantity.
 */
const value = (text: string): number | null => parseRequestedQuantity(text)?.value ?? null;

describe("digits", () => {
  it.each([
    ["هات ٣٠٠ تغريدة عن محمد صلاح", 300],
    ["هات 300 تغريدة عن محمد صلاح", 300],
    ["عايز ۵۰۰ تعليق", 500],
    ["هات ١٬٢٠٠ منشور", 1200],
    ["get 1,500 تغريدة", 1500],
    ["٣٠٠تغريدة", null],
    ["هات 3k تغريدة", 3000],
    ["هات ٢٫٥ ألف تغريدة", 2500],
    ["هات ٣ آلاف منشور", 3000],
    ["عايز ٥٠ شركة في القاهرة", 50],
  ])("%s -> %s", (text, expected) => expect(value(text as string)).toBe(expected));
});

describe("number words, standard and dialect", () => {
  it.each([
    ["هات تلتمية تغريدة", 300],
    ["هات تلاتمية تغريدة", 300],
    ["هات ثلاثمائة تغريدة", 300],
    ["هات ثلاثمئة تغريدة", 300],
    ["هات ثلاث مئة تغريدة", 300],
    ["هات ثلاث مائة تعليق", 300],
    ["هات ثلثمية تعليق", 300],
    ["هات خمسمية تعليق", 500],
    ["هات أربعمائة منشور", 400],
    ["هات مية تغريدة", 100],
    ["هات ميت تغريدة", 100],
    ["هات مئة تغريدة", 100],
    ["هات مية وخمسين تغريدة", 150],
    ["هات مائتين تغريدة", 200],
    ["هات ميتين تغريدة", 200],
    ["هات ألفين منشور", 2000],
    ["هات ألف تغريدة", 1000],
    ["هات ثلاثة آلاف تعليق", 3000],
    ["هات ألف ومئتين تغريدة", 1200],
    ["هات خمسين شركة", 50],
    ["هات عشرين شركة", 20],
    ["هات خمسة عشر منشور", 15],
  ])("%s -> %s", (text, expected) => expect(value(text as string)).toBe(expected));
});

describe("what is NOT the quantity", () => {
  it("a number that counts time, money, a year or a percentage is skipped", () => {
    expect(parseQuantities("هات تغريدات آخر ٣٠ يوم")).toEqual([]);
    expect(parseQuantities("خلال ٦ أشهر")).toEqual([]);
    expect(parseQuantities("بميزانية ٥٠٠ جنيه")).toEqual([]);
    expect(parseQuantities("تغريدات 2024")).toEqual([]);
    expect(value("هات ٢٠٠ تغريدة من آخر ٣٠ يوم")).toBe(200);
  });
  it("a number word in ordinary speech is not a quantity", () => {
    expect(value("واحد من اللاعبين")).toBeNull();
    expect(value("أحد الحسابات المشهورة")).toBeNull();
    expect(value("نص التغريدة")).toBeNull();
  });
  it("a number PER parent item is the share of each, not the total", () => {
    expect(value("عايز فيديوهات تيك توك عن الأقصر مع ١٠ تعليقات لكل فيديو")).toBeNull();
    expect(value("هات ٥٠٠ تعليق بحد ١٠ تعليقات لكل منشور")).toBe(500);
    expect(parseQuantities("١٠ تعليقات لكل فيديو")[0]).toMatchObject({ value: 10, perEach: true });
  });
  it("a threshold on something else is not the quantity of items: «أكثر من ٢٠٠ ألف متابع»", () => {
    expect(value("حسابات عندها أكثر من ٢٠٠ ألف متابع")).toBeNull();
    expect(value("هات ٥٠ حساب عندها أكثر من ٢٠٠ ألف متابع")).toBe(50);
    expect(bindQuantity("حسابات عندها أكثر من ٢٠٠ ألف متابع", [{ index: 0, title_ar: "الحسابات", deliver: true }])).toBeNull();
  });
  it("a noun that is not in the table still counts when a stage title names it", () => {
    expect(value("هات ٣٠ لاعب")).toBeNull();
    expect(bindQuantity("هات ٣٠ لاعب", [{ index: 0, title_ar: "اللاعبين", deliver: true }])).toEqual({ index: 0, value: 30 });
  });
  it("«عن كل» is a topic, not a per-parent share", () => {
    expect(value("هات ٣٠٠ تغريدة عن كل ما يخص صلاح")).toBe(300);
  });
});

describe("which stage the quantity counts", () => {
  const posts = { index: 0, title_ar: "المنشورات", deliver: true };
  const comments = { index: 1, title_ar: "تعليقات كل منشور", deliver: true };
  const videos = { index: 0, title_ar: "الفيديوهات", deliver: true };
  const companies = { index: 0, title_ar: "الشركات", deliver: true };
  const employees = { index: 1, title_ar: "موظفو كل شركة", deliver: true };
  it("a single delivered stage takes it", () => expect(bindQuantity("هات ٣٠٠ تغريدة", [{ index: 0, title_ar: "التغريدات", deliver: true }])).toEqual({ index: 0, value: 300 }));
  it("with several, the stage whose title names the counted noun takes it", () => {
    expect(bindQuantity("هات ٥٠٠ تعليق", [posts, comments])).toEqual({ index: 1, value: 500 });
    expect(bindQuantity("هات ١٠٠ منشور وتعليقاتهم", [posts, comments])).toEqual({ index: 0, value: 100 });
    expect(bindQuantity("هات خمسين شركة وموظفيها", [companies, employees])).toEqual({ index: 0, value: 50 });
    expect(bindQuantity("عايز ٢٠ فيديو", [videos, comments])).toEqual({ index: 0, value: 20 });
  });
  it("an intermediate stage (not delivered) never takes it", () => {
    expect(bindQuantity("هات ٣٠٠ تعليق", [{ ...posts, deliver: false }, comments])).toEqual({ index: 1, value: 300 });
  });
  it("no quantity, no binding", () => expect(bindQuantity("هات تغريدات عن محمد صلاح", [posts])).toBeNull());
});
