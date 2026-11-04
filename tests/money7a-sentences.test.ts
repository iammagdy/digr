import { describe, expect, it } from "vitest";
import { ADDON_APPROVE_MESSAGES_AR, ADDON_SUMMARY_AR } from "../src/lib/agentMission/addonSettlement";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";
import { ADDON_QUOTE_AR } from "../src/lib/agentMission/stage4/addonQuote";
import { ADDON_CREATE_REFUSALS_AR } from "../src/lib/agentMission/stage4/addonRow";
import { holdLineAr, quoteLineAr } from "../src/lib/agentMission/stage4/quotes";

/**
 * MONEY PR 7a, PHASE 2A: EVERY CUSTOMER SENTENCE THE ADD-ON CODE ADDS passes the project's customer-text check: Arabic only, Arabic-Indic numerals, no emoji, no provider, no endpoint id, no USD, no model vendor.
 */
const text = (s: string) => checkCustomerText(s);
describe("the add-on's customer sentences", () => {
  const sentences: Array<[string, string]> = [
    ...Object.entries(ADDON_APPROVE_MESSAGES_AR).map(([k, v]): [string, string] => [`approve.${k}`, v]),
    ...Object.entries(ADDON_QUOTE_AR).map(([k, v]): [string, string] => [`quote.${k}`, v]),
    ...Object.entries(ADDON_CREATE_REFUSALS_AR).map(([k, v]): [string, string] => [`create.${k}`, v]),
    ["hold.small", holdLineAr(100, 100)], ["hold.one", holdLineAr(1, 2)], ["hold.mid", holdLineAr(1234, 1500)], ["hold.big", holdLineAr(4321, 5000)],
    ["review.line", quoteLineAr("review", 500)], ["edit.line", quoteLineAr("edit", 100)],
  ];
  for (const [name, s] of sentences) it(`${name} passes checkCustomerText`, () => {
    expect(text(s).issues).toEqual([]);
    expect(s).not.toMatch(/[0-9]/);
    expect(s).not.toMatch(/\p{Extended_Pictographic}/u); // checkCustomerText does not catch an emoji: this does
    expect(s).not.toMatch(/USD|\$|دولار|apify|treg|openai|anthropic|claude|gemini/i);
  });
  for (const [k, v] of Object.entries(ADDON_SUMMARY_AR)) it(`the list line ${k} passes checkCustomerLabel`, () => { expect(checkCustomerLabel(v).issues).toEqual([]); });
  it("the hold line says the estimate, that it will not pass the hold, and that only the real cost is charged", () => {
    expect(holdLineAr(110, 209)).toBe("يُقدَّر التعديل بنحو ١١٠ نقطة، ولن يتجاوز ٢٠٩ نقطة؛ يُخصم ما كلّفه فعلًا فقط.");
  });
  it("the sentences say what happened to the customer's points (nothing held / nothing charged / returned)", () => {
    expect(ADDON_APPROVE_MESSAGES_AR.insufficient_balance).toContain("لم يُخصم شيء");
    expect(ADDON_APPROVE_MESSAGES_AR.claim_failed).toContain("عاد الحجز");
    expect(ADDON_QUOTE_AR.no_quote).toContain("لم يُحجز ولم يُخصم شيء");
  });
});
