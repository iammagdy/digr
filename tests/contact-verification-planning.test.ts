import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { buildTools } from "../agent/src/tools";
import { planningPrompt } from "../agent/src/runMission";
import { makeHarness } from "./helpers/agentHarness";
import { contactVerificationQuestionIssue, peopleConditionedOnContactIssues } from "../src/lib/agentMission/contactQuestion";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

/**
 * THE PLANNER AND THE VERIFICATION OF E-MAILS AND PHONES. Live re-test 2026-10-31 (A1 «٥ شركات كهروميكانيكا + صناع القرار»): the customer had ALREADY asked for the people (name, title, e-mail, phone). The planner's first attempt stopped to ask
 * «وجدت الشركات المصرية في الكهروميكانيكا، لكن الإيميلات والتليفونات المتحقق منها تظهر لعدد محدود من الأشخاص. كيف تحب أن أكمل؟» (msn_1d3c…, `mission_events` kind `question`), the customer chose «الشركات مع المديرين وما يتوفر من تواصلهم»,
 * and the plan text promised the e-mail and phone «فقط إذا ظهرا كاملين وتحقق منهما النظام». The engine then removed every person without a verified contact (fixed in the commit before this one).
 *
 * Verification decides whether an e-mail or phone CELL is filled; it is never a reason to ask whether to deliver the people, and never a condition written on the person rows.
 */
const A1_REQUEST = "عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار: اسم المدير، المسمى الوظيفي، الإيميل، ورقم التليفون";
const A1_QUESTION = "وجدت الشركات المصرية في الكهروميكانيكا، لكن الإيميلات والتليفونات المتحقق منها تظهر لعدد محدود من الأشخاص. كيف تحب أن أكمل؟";
const A1_OPTIONS = ["الشركات مع المديرين وما يتوفر من تواصلهم", "فقط من لهم إيميل أو تليفون متحقق", "الشركات فقط بدون مديرين"];
const A1_ANSWER = "الشركات مع المديرين وما يتوفر من تواصلهم";

describe("the planner does not ask whether to deliver the people when the customer already asked for them", () => {
  it("the A1 question (verified contacts reach only some people) is refused by code, with what to do instead", async () => {
    const h = makeHarness({ phase: "planning", mission: { request_text: A1_REQUEST } });
    const ask = buildTools(h.ctx).find((t) => t.name === "ask_question")!;
    const r: any = await ask.handler({ question_ar: A1_QUESTION, options_ar: A1_OPTIONS });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/already asked for the people/);
    expect(JSON.stringify(r)).toMatch(/assumptions_ar/);
    expect(h.ctx.state.question).toBeNull();
  });

  it("any wording of the same question is refused (no verified e-mail, e-mail not available, phones missing)", () => {
    for (const q of [
      "الإيميلات الموثقة متاحة لبعضهم فقط، هل أكمل بمن توفر له إيميل؟",
      "بعض المديرين ليس لهم رقم تليفون متوفر، تحب أضيفهم بدون رقم؟",
      "لم يظهر بريد مهني متحقق لكل المسؤولين. أسلّم من ظهر له فقط أم الجميع؟",
    ]) expect(contactVerificationQuestionIssue(A1_REQUEST, q, ["نعم", "لا"]), q).not.toBeNull();
  });

  it("a question that is NOT about contacts is still allowed for the same request, and so is a contact question for a request that asked for no people", () => {
    expect(contactVerificationQuestionIssue(A1_REQUEST, "المقصود بالكهروميكانيكا شركات التركيبات أم شركات التصنيع؟", ["التركيبات", "التصنيع"])).toBeNull();
    expect(contactVerificationQuestionIssue("عايز إيميلات شركات التأمين", "الإيميلات المتحققة محدودة، أكمل؟", ["نعم", "لا"])).toBeNull();
  });
});

describe("a plan sentence never makes the PEOPLE conditional on a verified contact (the cells are, the persons are not)", () => {
  it("the sentences the live planner wrote are fine: they condition the CELLS", () => {
    expect(peopleConditionedOnContactIssues(["الإيميل والتليفون يُضافان فقط إذا ظهرا كاملين وتحقق منهما النظام؛ العينات أظهرتهما مخفيين."])).toEqual([]);
    expect(peopleConditionedOnContactIssues(["صناع القرار: المدير التنفيذي والمدير العام والعضو المنتدب أولًا، ثم المديرون ورؤساء الأقسام."])).toEqual([]);
    expect(peopleConditionedOnContactIssues(["ستحصل على ٥ شركات، ومع كل شركة أبرز صناع القرار فيها بالاسم والمسمى الوظيفي وصفحتهم المهنية."])).toEqual([]);
  });
  it("a sentence that delivers a person only when a verified contact exists is refused", () => {
    for (const s of [
      "نسلّم المديرين فقط إذا ظهر لهم إيميل أو تليفون تحقق منه النظام.",
      "يُضاف المسؤول فقط لمن يتوفر له إيميل موثّق.",
      "نستبعد الأشخاص الذين ليس لهم بيانات تواصل متحقق منها.",
    ]) expect(peopleConditionedOnContactIssues([s]).length, s).toBeGreaterThan(0);
  });
});

describe("the customer chose «وما يتوفر»: the plan is told to follow it", () => {
  const mission = (answer: string | null) => ({ request_text: A1_REQUEST, answer_text: answer }) as never;
  it("the planning prompt after that answer says: deliver every person found, leave the unverified cells empty, do not drop the people or condition them", () => {
    const text = planningPrompt(mission(A1_ANSWER), []);
    expect(text).toContain("Do not ask again");
    expect(text).toMatch(/deliver every person/i);
    expect(text).toMatch(/cells? (?:are|is) left empty/i);
  });
  it("another answer, or no answer, adds nothing", () => {
    expect(planningPrompt(mission("شركات التصنيع"), [])).not.toMatch(/deliver every person/i);
    expect(planningPrompt(mission(null), [])).not.toMatch(/deliver every person/i);
  });
});

describe("the system prompt teaches the cell rule, not the old row rule", () => {
  const prompt = readFileSync(new URL("../agent/prompts/system.md", import.meta.url), "utf8");
  it("a row with no verified value is no longer said to be dropped for a person", () => {
    expect(prompt).not.toMatch(/a row with no verified value is not saved/i);
  });
  // CHANGED (owner direction 2026-11-01): an unverified value is no longer emptied; verification decides the status next to a value, never whether a value or a person is delivered
  it("it says verification decides only the status beside a value, never whether a value or a person is delivered, and that no question is asked about it", () => {
    expect(prompt).toMatch(/verification decides only the STATUS/i);
    expect(prompt).toMatch(/never (?:ask|a question)[^.]*(?:verified|verification|contact)/i);
  });
});
