import { describe, expect, it } from "vitest";
import { itemNounOf } from "../src/lib/agentMission/itemNoun";
import { childRuleLinesAr } from "../src/lib/agentMission/childItems";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * ROUND 58, AUTHENTICATED PRODUCTION JOURNEY (msn_088cfef00f92a8ff1ea9, 13 Nov 2026, test account): two customer-facing wording defects seen on the live card.
 * 1. The contact step «الإيميل والتليفون المنشورين على موقع كل شركة»: «المنشورين» (published) was read as the noun «منشور» (post), and the card said «تُجمع المنشورات كما هي على كل شركة».
 * 2. After the customer changed the count in the card's editor (12 -> 10 -> 9), the headline said «٩ شركة مستحضرات تجميل…» (the digits moved, the noun did not).
 */
describe("a definite adjective after a definite noun is not a noun", () => {
  it("the live contact title is not «posts»; its rule line on the card does not say «المنشورات»", () => {
    const title = "الإيميل والتليفون المنشورين على موقع كل شركة";
    expect(itemNounOf(title).singular).not.toBe("منشور");
    const lines = childRuleLinesAr([{ key: "companies", title_ar: "شركات مستحضرات التجميل في مصر", parent_key: null, deliver: true }, { key: "contacts", title_ar: title, parent_key: "companies", deliver: true }]);
    expect(lines.join(" ")).not.toContain("المنشورات");
  });
  it.each([
    ["المنشورات عن الذكاء الاصطناعي", "منشور"],
    ["بيانات تواصل الشركات", "شركة"],
    ["تعليقات الفيديوهات", "تعليق"],
    ["أحدث الفيديوهات المنشورة", "فيديو"],
    ["التعليقات المنشورة على كل فيديو", "تعليق"],
  ])("%s -> %s (unchanged)", (title, noun) => {
    expect(itemNounOf(title).singular).toBe(noun);
  });
});

describe("a count edit restates the headline in the right form", () => {
  const calls = new Map<string, any>([["call_0001", { id: "call_0001", endpointId: "tomba.companies.search.reveal", ok: true, costUsd: 0.000178, rows: 50, params: { query: "cosmetics" } }]]);
  const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => "glow-eg.com https://glow-eg.com", endpointAllowed: () => true, requestText: "عايز ١٢ شركة مستحضرات تجميل في مصر" };
  const priced = () => {
    const r = validateAndPricePlan({ summary_ar: "١٢ شركة مستحضرات تجميل في مصر، مع موقعها الرسمي.", stages: [{ key: "companies", title_ar: "شركات مستحضرات التجميل في مصر", endpoint_id: "tomba.companies.search.reveal", expected_rows: 12, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع الإلكتروني" }], sample_rows: [{ id: "glow-eg.com", name: "Glow", website: "https://glow-eg.com" }], measured_by: ["call_0001"] }] }, lookup);
    if (!r.ok) throw new Error(r.issues.join("\n"));
    return r.plan;
  };
  it("the live sequence 12 -> 10 -> 9: «٩ شركات», never «٩ شركة»", () => {
    const ten: any = applyPlanEdits(priced(), { count: 10 });
    expect(ten.ok).toBe(true);
    expect(ten.plan.summary_ar).toMatch(/^١٠ شركات مستحضرات/);
    const nine: any = applyPlanEdits(ten.plan, { count: 9 });
    expect(nine.plan.summary_ar).toMatch(/^٩ شركات مستحضرات/);
    expect(checkCustomerText(nine.plan.summary_ar, { maxChars: 600 }).issues).toEqual([]);
  });
});
