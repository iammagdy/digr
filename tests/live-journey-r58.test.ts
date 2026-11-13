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

describe("the delivered file is named by its companies (live: «١٣ إيميل والتليفون عن مستحضرات تجميل» for 9 companies and 4 contact rows)", () => {
  it("the live plan: «٩ شركات …», never the total of every step", async () => {
    const { missionFileTitleAr } = await import("../src/lib/agentMission/fileNames");
    const stages = [
      { key: "companies", deliver: true, title_ar: "شركات مستحضرات التجميل في مصر", parent_key: null, expected_rows: 9 },
      { key: "contacts", deliver: true, title_ar: "الإيميل والتليفون المنشورين على موقع كل شركة", parent_key: "companies", expected_rows: 9 },
    ];
    const title = missionFileTitleAr({ plan: { stages }, requestText: "عايز ١٢ شركة مستحضرات تجميل في مصر، ومع كل شركة موقعها الرسمي، والتليفون والإيميل المنشورين ورابط مصدر المعلومات.", delivered: 13, parentDelivered: 9, date: new Date("2026-11-13T16:06:00Z") });
    expect(title).toMatch(/^٩ شركات مستحضرات تجميل - /);
    expect(title).not.toMatch(/١٣ (?:إيميل|شرك|عنصر)|إيميل|عن شركة/);
    expect(title).toContain("١٣ نوفمبر ٢٠٢٦");
  });
  it("posts with their comments keep the round-27 name", async () => {
    const { missionFileTitleAr } = await import("../src/lib/agentMission/fileNames");
    const title = missionFileTitleAr({ plan: { stages: [{ key: "videos", deliver: true, title_ar: "فيديوهات عن الذكاء الاصطناعي", parent_key: null, expected_rows: 2 }, { key: "comments", deliver: true, title_ar: "تعليقات كل فيديو", parent_key: "videos", expected_rows: 20 }] }, requestText: "هات فيديوهين عن الذكاء الاصطناعي مع التعليقات", delivered: 22, parentDelivered: 2, date: new Date("2026-11-13T16:06:00Z") });
    expect(title).toMatch(/^فيديوهان مع التعليقات/);
  });
});

describe("the shortfall reason of a detail step", () => {
  it("contacts of companies: «لم نجد لها في المصدر», never «عليها منشورات أقل»", async () => {
    const { childShortfallClauseAr } = await import("../agent/src/finalize");
    const child = itemNounOf("الإيميل والتليفون المنشورين على موقع كل شركة");
    const s = childShortfallClauseAr("شركة", "شركات", child.plural);
    expect(s).toBe("لأن بعض الشركات لم نجد لها في المصدر ما طُلب لكل شركة");
    expect(childShortfallClauseAr("فيديو", "فيديوهات", "تعليقات")).toBe("لأن بعض الفيديوهات عليها تعليقات أقل من العدد المطلوب لكل فيديو");
  });
});

describe("the notice's mission title is named by the companies", () => {
  it("live: «١٨ إيميل والتليفون عن مستحضرات تجميل» becomes «٩ شركات مستحضرات تجميل»", async () => {
    const { missionTitleAr } = await import("../src/lib/agentMission/fileNames");
    const stages = [
      { key: "companies", deliver: true, title_ar: "شركات مستحضرات التجميل في مصر", parent_key: null, expected_rows: 9 },
      { key: "contacts", deliver: true, title_ar: "الإيميل والتليفون المنشورين على موقع كل شركة", parent_key: "companies", expected_rows: 9 },
    ];
    const t = missionTitleAr({ plan: { stages }, requestText: "عايز ١٢ شركة مستحضرات تجميل في مصر، ومع كل شركة موقعها الرسمي، والتليفون والإيميل المنشورين ورابط مصدر المعلومات." });
    expect(t).toBe("٩ شركات مستحضرات تجميل");
  });
});
