import { describe, expect, it } from "vitest";
import { impersonalAr } from "../src/lib/agentMission/roles";
import { isSingularPerParentCitation } from "../src/lib/agentMission/numberWords";
import { UNDERSTAND_SYSTEM } from "../agent/src/llmPlanner/prompts";
import { withCheckedCompaniesCount, withCheckedPerCompany } from "../agent/src/llmPlanner/planner";

describe("FX-01B: Planner Replay & Prompt Faithfulness", () => {
  it("impersonalAr removes spoken third-person phrasing cleanly", () => {
    expect(impersonalAr("العميل عايز ٣ شركات عقارات في القاهرة")).toBe("المطلوب: ٣ شركات عقارات في القاهرة");
    expect(impersonalAr("العميل عاوز ٥ مطاعم")).toBe("المطلوب: ٥ مطاعم");
    expect(impersonalAr("العميل محتاج قائمة")).toBe("المطلوب: قائمة");
    expect(impersonalAr("المستخدم محتاج تفاصيل")).toBe("المطلوب: تفاصيل");
    expect(impersonalAr("الطالب يريد جمع بيانات")).toBe("المطلوب: جمع بيانات");
    expect(impersonalAr("الباحث يطلب معلومات")).toBe("المطلوب: معلومات");
    expect(impersonalAr("قائمة بشركات التسويق")).toBe("قائمة بشركات التسويق");
  });

  it("isSingularPerParentCitation handles prepositions before distributive", () => {
    const msg1 = "مدير من كل شركة من ٣ شركات تسويق في القاهرة";
    expect(isSingularPerParentCitation(msg1, "مدير من كل شركة")).toBe(true);

    const msg2 = "عايز 3 شركات عقارات في القاهرة ومدير كل شركة بالإيميل والتليفون";
    expect(isSingularPerParentCitation(msg2, "مدير كل شركة")).toBe(true);

    const msg3 = "٣ مديرين من كل شركة من ٥ شركات";
    expect(isSingularPerParentCitation(msg3, "٣ مديرين من كل شركة")).toBe(false);

    const msg4 = "عايز موظفين من كل شركة";
    expect(isSingularPerParentCitation(msg4, "موظفين من كل شركة")).toBe(false);
  });

  it("withCheckedPerCompany keeps per_company = 1 for singular distributive role", () => {
    const rawUnderstand = {
      decision: "plan" as const,
      understanding_ar: "شركات تسويق في القاهرة.",
      steps: [
        {
          key: "companies",
          title_ar: "شركات التسويق في القاهرة",
          deliver: true,
          count: { total: 3, all: false },
        },
      ],
      accepts_available: false,
      people_of_companies: {
        asked: true,
        title_ar: "مدير كل شركة",
        per_company: 1,
        per_company_text: "مدير من كل شركة",
        companies_text: "٣ شركات",
        contact_kinds: ["email", "phone"],
      },
    };

    const checked = withCheckedPerCompany(rawUnderstand, ["مدير من كل شركة من ٣ شركات تسويق في القاهرة"]);
    expect(checked.people_of_companies.per_company).toBe(1);

    const checkedCompanies = withCheckedCompaniesCount(rawUnderstand, ["مدير من كل شركة من ٣ شركات تسويق في القاهرة"]);
    expect(checkedCompanies.companies_count).toBe(3);
  });

  it("withCheckedPerCompany preserves per_company = 3 for explicit multi-role count", () => {
    const rawUnderstand = {
      decision: "plan" as const,
      understanding_ar: "شركات مقاولات.",
      steps: [
        {
          key: "companies",
          title_ar: "شركات المقاولات",
          deliver: true,
          count: { total: 5, all: false },
        },
      ],
      accepts_available: false,
      people_of_companies: {
        asked: true,
        title_ar: "مديرون",
        per_company: 3,
        per_company_text: "٣ مديرين من كل شركة",
        companies_text: "٥ شركات",
        contact_kinds: [],
      },
    };

    const checked = withCheckedPerCompany(rawUnderstand, ["٣ مديرين من كل شركة من ٥ شركات"]);
    expect(checked.people_of_companies.per_company).toBe(3);

    const checkedCompanies = withCheckedCompaniesCount(rawUnderstand, ["٣ مديرين من كل شركة من ٥ شركات"]);
    expect(checkedCompanies.companies_count).toBe(5);
  });

  it("UNDERSTAND_SYSTEM contains singular role and multi-role instructions", () => {
    expect(UNDERSTAND_SYSTEM).toContain("«مدير من كل شركة» or «مدير كل شركة»");
    expect(UNDERSTAND_SYSTEM).toContain("per_company = 1");
    expect(UNDERSTAND_SYSTEM).toContain("٣ مديرين من كل شركة من ٥ شركات");
  });
});
