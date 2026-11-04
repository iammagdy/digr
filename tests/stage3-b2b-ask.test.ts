import { describe, expect, it } from "vitest";
import { buildB2BAsk, b2bConditionLabelAr } from "../src/lib/agentMission/stage3/b2bAsk";
import { STAGE3_FLAGS, stage3Enabled, stage3FlagMode } from "../src/lib/agentMission/stage3/flags";
import { checkCustomerLabel } from "../src/lib/agentMission/text";

/**
 * STAGE 3 (docs/STAGE-3.md): the Ask of a companies / decision-makers request, built by code from the customer's words (no model), in a NEW type beside the social Ask. The live request of
 * msn_7539ea17512cf58aa0e7 (its words are in tests/limits-live-7539.test.ts) is the first case.
 */
describe("flags: every Stage 3 flag is OFF when it is not set", () => {
  it("only «on» and «test» turn one on", () => {
    for (const name of STAGE3_FLAGS) {
      expect(stage3FlagMode(name, {})).toBe("off");
      expect(stage3FlagMode(name, { [name]: "yes" })).toBe("off");
      expect(stage3Enabled(name, true, {})).toBe(false);
      expect(stage3Enabled(name, true, { [name]: "test" })).toBe(true);
      expect(stage3Enabled(name, false, { [name]: "test" })).toBe(false);
      expect(stage3Enabled(name, false, { [name]: "on" })).toBe(true);
    }
    expect([...STAGE3_FLAGS].sort()).toEqual(["DIGER_STAGE3_COMPANIES", "DIGER_STAGE3_EMAIL_NOTICE", "DIGER_STAGE3_QUEUE"]);
  });
});

describe("the B2B Ask, by code", () => {
  it("LIVE msn_7539ea17512cf58aa0e7: «عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار»", () => {
    const a = buildB2BAsk("عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار")!;
    expect(a.kind).toBe("companies_people");
    expect(a.companies).toBe(5);
    expect(a.country).toBe("EG");
    expect(a.sector).toEqual(["الكهروميكانيكا"]);
    expect(a.roles).toBe("decision_makers");
    expect(a.peoplePerCompany).toBeNull();
    // the owner's columns: the company's general e-mail and HQ phone always; a decision maker's e-mail and mobile
    expect(a.fields).toEqual({ companyEmail: true, hqPhone: true, personEmail: true, personMobile: true });
    expect(a.conditions).toEqual([]);
  });
  it("companies only, with conditions no word of the request can be lost: size and founding year become conditions", () => {
    const a = buildB2BAsk("هات ٢٠ شركة برمجيات في الإمارات عدد موظفيها أكثر من ٥٠ وتأسست بعد ٢٠١٥")!;
    expect(a.kind).toBe("companies");
    expect(a.companies).toBe(20);
    expect(a.country).toBe("AE");
    expect(a.conditions).toEqual([{ kind: "size_min", value: 50 }, { kind: "founded_after", value: 2015 }]);
    expect(a.fields.personEmail).toBe(false);
    expect(a.conditions.map(b2bConditionLabelAr)).toEqual(["عدد الموظفين أكثر من ٥٠", "تأسست بعد ٢٠١٥"]);
    for (const c of a.conditions) expect(checkCustomerLabel(b2bConditionLabelAr(c)).issues).toEqual([]);
  });
  it("people per company, a dual count, a size below, a founding year before", () => {
    const a = buildB2BAsk("عايز شركتين طاقة في السعودية أقل من ٢٠٠ موظف تأسست قبل ٢٠٠٠، و٣ مديرين من كل شركة")!;
    expect([a.kind, a.companies, a.peoplePerCompany, a.country]).toEqual(["companies_people", 2, 3, "SA"]);
    expect(a.conditions).toEqual([{ kind: "size_max", value: 200 }, { kind: "founded_before", value: 2000 }]);
  });
  it("no count: null (the question card asks it), and a budget in points is read", () => {
    const a = buildB2BAsk("هات شركات مقاولات في مصر مع صناع القرار بميزانية ٣٠٠٠ نقطة")!;
    expect(a.companies).toBeNull();
    expect(a.budget).toBe(3000);
  });
  it("decision makers with no companies named: a people request", () => {
    const a = buildB2BAsk("هات ١٥ مدير تسويق في مصر مع الإيميل والموبايل")!;
    expect([a.kind, a.people, a.companies]).toEqual(["people", 15, null]);
  });
  it("a social request is not a B2B request", () => {
    expect(buildB2BAsk("هات فيديوهين تيك توك عن الذكاء الاصطناعي")).toBeNull();
    expect(buildB2BAsk("")).toBeNull();
  });
});
