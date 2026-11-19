import { describe, expect, it } from "vitest";
import { buildTools } from "../agent/src/tools";
import { makeHarness } from "./helpers/agentHarness";

/**
 * DT-20261119-03 R2 (old agent path): once the planner has understood the request (the people of the companies), or has run at all, `ask_question` is refused outright: the word-pattern guard of A1/F1 can never list every excuse.
 * The three live questions and the A1 shape are all refused; without any planner understanding the tool is exactly what it was.
 */
const REQUEST = "عايز شركتين مقاولات في جدة ومن كل شركة ٣ مديرين بأرقامهم";
const LIVE3 = { question_ar: "وجدنا شركتي مقاولات في جدة، لكن المصدر الذي يعطي أسماء المديرين يرجع أيضًا تواريخ انتهاء مناصب لبعض الأشخاص، ولا يمكن عرضها في الملف بشكل متسق. كيف تحب نكمل؟", options_ar: ["الشركات فقط", "الشركات والمديرين مع التواريخ", "المديرين من غير أرقام"] };
const LIVE1 = { question_ar: "الأرقام الشخصية للمسؤولين ممكن تكون بيانات حساسة. تحب نجيب إيه بالظبط؟", options_ar: ["أسماء المسؤولين والمسمى وأرقام العمل المعلنة", "أرقام الشركة المعلنة على موقعها فقط", "الأرقام الشخصية للمسؤولين نفسهم"] };
const A1 = { question_ar: "الأرقام المتاحة تظهر لعدد محدود من الأشخاص، كيف تحب نكمل؟", options_ar: ["الشركات فقط", "ما يتوفر من تواصلهم"] };
const UNDERSTOOD = { noun_ar: "الأشخاص", parent_ar: "الشركات", per_parent: 3, contact_kinds: ["phone" as const] };
const ask = async (setup: (ctx: any) => void, q: { question_ar: string; options_ar: string[] }) => {
  const h = makeHarness({ phase: "planning", mission: { request_text: REQUEST } });
  setup(h.ctx);
  const r: any = await buildTools(h.ctx).find((t) => t.name === "ask_question")!.handler(q);
  return { r, state: h.ctx.state };
};

describe("R2: no question once the planner understood the request or ran", () => {
  it.each([["live 3 (end dates)", LIVE3], ["live 1 (sensitivity)", LIVE1], ["A1 (limited contacts)", A1]])("%s is refused with the planner's understanding; nothing is stored as the customer's question", async (_n, q) => {
    const { r, state } = await ask((c) => { c.understoodPeople = UNDERSTOOD; }, q);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already understood/);
    expect(r.error).toMatch(/column/);
    expect(state.question).toBeNull();
    expect(state.terminal).toBe(false);
  });
  it("also when the planner only RAN (it could not be read, or kept asking): `plannerRan` refuses the same question", async () => {
    const { r, state } = await ask((c) => { c.plannerRan = true; }, LIVE3);
    expect(r.ok).toBe(false);
    expect(state.question).toBeNull();
  });
  it("the control: no planner at all (flag off, spend gate): the same questions are accepted exactly as today", async () => {
    for (const q of [LIVE3, LIVE1]) {
      const { r, state } = await ask(() => undefined, q);
      expect(r.ok).toBe(true);
      expect(state.question).toBe(q.question_ar);
    }
  });
});
