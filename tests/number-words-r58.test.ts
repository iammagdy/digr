import { describe, expect, it } from "vitest";
import { wordNumbersIn } from "../src/lib/agentMission/numberWords";
import { guardReply } from "../src/lib/agentMission/conversationModel";
import { openPlanFactsOf, planNumbersAr } from "../src/lib/agentMission/openPlanFacts";
import { publicPlanOf } from "../src/lib/agentMission/overLimit";
import { COSMETICS_PLAN } from "../evals/customer-journey/runner";

/**
 * ROUND 58 (after the merge of #473): THE REPLY GUARD READS NUMBERS WRITTEN IN WORDS. On merged main 99acb4f the real chat model answered «يعني هما ٣٢ شركة؟» with «الرقم ثلاثة وثلاثون هو مجموع العناصر» (the plan's number is 32):
 * the guard checked digits only, so a wrong number in words reached the customer. Numbers above ten in words are now held to the same allowed numbers as digits.
 */
const facts = openPlanFactsOf(publicPlanOf(JSON.parse(JSON.stringify(COSMETICS_PLAN))))!;
const allowed = { message: "يعني هما ٣٢ شركة؟", balancePoints: null, extraAr: planNumbersAr(facts), facts };

describe("numbers written in words", () => {
  it.each([
    ["الرقم ثلاثة وثلاثون هو مجموع العناصر", [33]],
    ["ثلاثمائة وخمسة وعشرين نقطة، ويُحجز ثلاثمائة وأربع وسبعون", [325, 374]],
    ["بعدد متوقع اثنتي عشرة، وعشرون شركة", [12, 20]],
    ["اثنين وثلاثين عنصرًا", [32]],
    ["ألف وخمسمائة نقطة، والحد الأدنى مائتا نقطة", [1500, 200]],
    ["مرة واحدة، وثلاث خطوات، وخطوتين، ولا أحد يضمن", []],
  ])("%s", (text, expected) => {
    expect(wordNumbersIn(text)).toEqual(expected);
  });
});

describe("the guard holds numbers in words to the plan's numbers", () => {
  it("the live reply of 99acb4f («ثلاثة وثلاثون» for 32) is refused", () => {
    const live = "لا، الخطة فيها عشرون شركة بالتحديد. الرقم ثلاثة وثلاثون هو مجموع العناصر التي تُحسب عليها التكلفة، وهو عشرون من الشركات مضافًا إليها اثنا عشر من بيانات التواصل المنشورة في مواقعها الرسمية، ولا يعني عدد الشركات.";
    const g = guardReply(live, allowed);
    expect(g.ok).toBe(false);
    expect((g as { issues: string[] }).issues).toContain("number_not_given");
  });
  it("the same reply with the plan's own numbers in words passes", () => {
    const right = "لا، الخطة فيها عشرون شركة بالتحديد. الرقم اثنان وثلاثون هو مجموع العناصر التي تُحسب عليها التكلفة، وهو عشرون من الشركات واثنا عشر من بيانات التواصل.";
    expect(guardReply(right, allowed).ok).toBe(true);
    expect(guardReply("أقصى ما يُخصم ثلاثمائة وخمسة وعشرين نقطة، والحجز ثلاثمائة وأربع وسبعون نقطة.", allowed).ok).toBe(true);
  });
  it("small numbers of ordinary speech are not checked", () => {
    expect(guardReply("الخطة على خطوتين، والشركة تظهر مرة واحدة لكل نتيجة.", allowed).ok).toBe(true);
  });
});
