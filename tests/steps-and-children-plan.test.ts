import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { childPromiseIssues, customerPlanView, validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { perParentQuantities, unservedPerParentAsks } from "../src/lib/agentMission/quantity";

/**
 * THE PLAN KEEPS WHAT THE CUSTOMER ASKED FOR PER PARENT, AND NEVER DROPS A STEP SILENTLY (live run of 2026-10-29, missions 3, 4 and 5 of the run).
 *  - «ومع كل بوست ١٠ تعليقات»: the comments' target was written «حتى ٧» by the model; it is parents x the customer's number (٥٠), set by code.
 *  - «ومن كل شركة اتنين من المديرين»: the plan had companies only and its last sentence said the managers «فلن تُضاف»; the card now says so as a step that is NOT included, with the reason, before approval.
 *  - the language and the topic are rules for the parents; a sentence that promises them for the comments is refused and the card says which items the language applies to.
 */
const calls = new Map([
  ["call_0001", { id: "call_0001", endpointId: "src.parents", ok: true, costUsd: 0.0005, rows: 20, params: { handle: "someone" } }],
  ["call_0002", { id: "call_0002", endpointId: "src.children", ok: true, costUsd: 0.0005, rows: 10, params: { post: "p1" } }],
]);
const lookupFor = (requestText: string): PlanLookup => ({ call: (id) => calls.get(id) ?? null, evidenceText: () => "m1 p1 https://x.example/p1 c1 orascom.com https://orascom.com", endpointAllowed: () => true, requestText });

const parentStage = (over: Record<string, unknown> = {}) => ({ key: "posts", title_ar: "منشورات محمد صلاح", endpoint_id: "src.parents", expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "url", title_ar: "رابط المنشور" }], sample_rows: [{ id: "p1", text: "منشور عن الدوري", url: "https://x.example/p1" }], measured_by: ["call_0001"], ...over });
const childStage = (over: Record<string, unknown> = {}) => ({ key: "comments", title_ar: "تعليقات على كل منشور", endpoint_id: "src.children", expected_rows: 7, parent_key: "posts", per_parent_rows: 3, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "الكاتب" }], sample_rows: [{ id: "c1", text: "تعليق", author: "منى" }], measured_by: ["call_0002"], ...over });

describe("the number the customer asks for PER PARENT is read by code", () => {
  it("«مع كل بوست ١٠ تعليقات», «من كل شركة اتنين من المديرين», «١٠ ردود لكل تغريدة» are per-parent numbers with their noun", () => {
    expect(perParentQuantities("هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر، ومع كل بوست ١٠ تعليقات").map((q) => [q.value, q.noun])).toEqual([[10, "تعليقات"]]);
    expect(perParentQuantities("عايز ٣ شركات مقاولات في مصر، ومن كل شركة اتنين من المديرين").map((q) => [q.value, q.noun])).toEqual([[2, "المديرين"]]);
    expect(perParentQuantities("هات آخر ٥ تغريدات من حساب محمد صلاح على إكس، ومع كل تغريدة ١٠ ردود").map((q) => [q.value, q.noun])).toEqual([[10, "ردود"]]);
    expect(perParentQuantities("هات ٣٠٠ تغريدة عن محمد صلاح")).toEqual([]);
  });

  it("a per-parent number whose noun no child stage carries is an unserved step", () => {
    const asks = perParentQuantities("عايز ٣ شركات مقاولات في مصر، ومن كل شركة اتنين من المديرين");
    expect(unservedPerParentAsks(asks, [])).toHaveLength(1);
    expect(unservedPerParentAsks(asks, ["مديرو كل شركة"])).toHaveLength(0);
    expect(unservedPerParentAsks(perParentQuantities("ومع كل بوست ١٠ تعليقات"), ["تعليقات على كل منشور"])).toHaveLength(0);
  });
});

describe("the child stage's target is parents x the customer's number, whatever the model wrote", () => {
  const request = "هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر، ومع كل بوست ١٠ تعليقات";

  it("the live Facebook plan: the model wrote 7 comments and 3 per post; the plan carries 50 and 10 (the card said «حتى ٧» and one post gave all of them)", () => {
    const checked = validateAndPricePlan({ summary_ar: "بوستات عن غلاء الأسعار وتعليقات كل بوست.", stages: [parentStage(), childStage()] }, lookupFor(request));
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (!checked.ok) return;
    expect(checked.plan.stages[0].planned_rows).toBe(5);
    expect(checked.plan.stages[1]).toMatchObject({ planned_rows: 50, per_parent_rows: 10 });
    const view = customerPlanView(checked.plan);
    expect(view.stages[1].expected_rows).toBe(50);
    expect(JSON.stringify(view)).not.toMatch(/حتى ٧|"expected_rows":7/);
  });

  it("the same when the customer's number for the parents is raised by the request (the child follows parents x number)", () => {
    const checked = validateAndPricePlan({ summary_ar: "بوستات وتعليقاتها.", stages: [parentStage({ expected_rows: 8 }), childStage({ expected_rows: 12 })] }, lookupFor("هات ٨ بوستات عن غلاء الأسعار، ومع كل بوست ١٠ تعليقات"));
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (checked.ok) expect(checked.plan.stages[1].planned_rows).toBe(80);
  });

  it("when the request gives no per-parent number the model's own number stays (and the engine spreads it over the parents)", () => {
    const checked = validateAndPricePlan({ summary_ar: "بوستات وتعليقاتها.", stages: [parentStage(), childStage({ expected_rows: 20, per_parent_rows: 10 })] }, lookupFor("هات ٥ بوستات عن غلاء الأسعار مع تعليقاتها"));
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (checked.ok) expect(checked.plan.stages[1]).toMatchObject({ planned_rows: 20, per_parent_rows: 10 });
  });

  it("the customer edits the number of posts in the card: the comments follow (8 posts x 10 = 80)", () => {
    const checked = validateAndPricePlan({ summary_ar: "بوستات وتعليقاتها.", stages: [parentStage(), childStage()] }, lookupFor(request));
    if (!checked.ok) throw new Error(JSON.stringify(checked));
    const edited = applyPlanEdits(checked.plan, { count: 8 });
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(edited.plan.stages.map((s) => s.planned_rows)).toEqual([8, 80]);
  });
});

describe("a step the customer asked for is never dropped silently", () => {
  const request = "عايز ٣ شركات مقاولات في مصر، ومن كل شركة اتنين من المديرين";
  const companies = (over: Record<string, unknown> = {}) => ({ key: "companies", title_ar: "شركات المقاولات في مصر", endpoint_id: "src.parents", expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }, { key: "country", title_ar: "الدولة" }], sample_rows: [{ id: "orascom.com", name: "Orascom Construction", website: "https://orascom.com", country: "EG" }], measured_by: ["call_0001"], ...over });

  it("the live plan (companies only, the managers dropped in the last words of the summary) is refused with what to do: add the step or say it is not included and why", () => {
    const checked = validateAndPricePlan({ summary_ar: "شركات مقاولات مصرية، أما أسماء المديرين فلن تُضاف إلى الملف.", stages: [companies()] }, lookupFor(request));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    const text = checked.issues.join(" ");
    expect(text).toContain("the customer asked for a step the plan does not have");
    expect(text).toContain("المديرين لكل شركة");
    expect(text).toContain("unserved_steps");
  });

  it("with the step named as not included and a reason, the plan is accepted and the card says which step and why, BEFORE approval", () => {
    const checked = validateAndPricePlan({ summary_ar: "شركات مقاولات مصرية مع بياناتها العامة.", stages: [companies()], unserved_steps: [{ reason_ar: "المصادر المتاحة لا تعطي أسماء المديرين لكل شركة بدقة" }] }, lookupFor(request));
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (!checked.ok) return;
    expect(checked.plan.unserved_steps).toEqual([{ what_ar: "المديرين لكل شركة", reason_ar: "المصادر المتاحة لا تعطي أسماء المديرين لكل شركة بدقة" }]);
    const view = customerPlanView(checked.plan);
    expect(view.unserved_ar).toEqual(["لم تُضَف إلى الخطة خطوة «المديرين لكل شركة»: المصادر المتاحة لا تعطي أسماء المديرين لكل شركة بدقة. يمكنك اعتماد باقي الخطة كما هي، أو تعديل طلبك قبل الاعتماد."]);
    // the card: a block of its own above the assumptions, in the plan phase
    const mission = { id: "msn_1", status: "plan_ready", plan_public: view, created_at: new Date().toISOString(), request_text: request, question_ar: null, answer_text: null, summary_ar: null, files: null, charged_points: null, reserved_points: 200, delivered_units: null, job_id: null, error: null } as never;
    const card = customerMissionView({ mission, events: [], now: Date.now() });
    expect(card.unservedAr).toEqual(view.unserved_ar);
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: card, isGuest: false }));
    expect(html).toContain('data-testid="agent-unserved"');
    expect(html).toContain("خطوة لم تُضَف إلى الخطة");
    expect(html).toContain("المديرين لكل شركة");
    expect(html).toContain("اعتماد باقي الخطة");
  });

  it("a reason with a number or an English word is refused; one entry is needed for each missing step", () => {
    const withNumber = validateAndPricePlan({ summary_ar: "شركات.", stages: [companies()], unserved_steps: [{ reason_ar: "لم نجد أكثر من ٣ مديرين" }] }, lookupFor(request));
    expect(withNumber.ok).toBe(false);
    const none = validateAndPricePlan({ summary_ar: "شركات.", stages: [companies()], unserved_steps: [] }, lookupFor(request));
    expect(none.ok).toBe(false);
  });

  it("a plan that CARRIES the step (managers of each company, parent = the companies) needs no note; its target is companies x 2", () => {
    const managers = { key: "managers", title_ar: "مديرو كل شركة", endpoint_id: "src.children", expected_rows: 4, parent_key: "companies", per_parent_rows: 1, deliver: true, columns: [{ key: "name", title_ar: "الاسم" }, { key: "title", title_ar: "المسمى" }], sample_rows: [{ id: "m1", name: "أحمد", title: "مدير" }], measured_by: ["call_0002"] };
    const checked = validateAndPricePlan({ summary_ar: "شركات مقاولات ومديروها.", stages: [companies(), managers] }, lookupFor(request));
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (!checked.ok) return;
    expect(checked.plan.unserved_steps).toBeUndefined();
    expect(checked.plan.stages[1]).toMatchObject({ planned_rows: 6, per_parent_rows: 2 });
  });

  it("a per-parent number that splits the top-level stage («١٠ تغريدات لكل لاعب» of ٥٠ تغريدة) is not a missing step", () => {
    const checked = validateAndPricePlan({ summary_ar: "تغريدات اللاعبين.", stages: [parentStage({ title_ar: "التغريدات", expected_rows: 50 })] }, lookupFor("هات ٥٠ تغريدة، ١٠ تغريدات لكل لاعب"));
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
  });
});

describe("the language and the topic belong to the parents: no promise for the children, and the card says which items the language applies to", () => {
  it("a sentence that names the comments and promises Arabic or relevance is refused; one that says they come as the source gives them, and one about the parents' language, are fine", () => {
    const titles = ["تعليقات على كل منشور"];
    expect(childPromiseIssues([{ where: "assumptions_ar", text: "التعليقات باللغة العربية فقط." }], titles)).toHaveLength(1);
    expect(childPromiseIssues([{ where: "assumptions_ar", text: "التعليقات متعلقة بالموضوع نفسه." }], titles)).toHaveLength(1);
    expect(childPromiseIssues([{ where: "summary_ar", text: "المنشورات والتعليقات بالعربية." }], titles)).toHaveLength(1);
    expect(childPromiseIssues([{ where: "assumptions_ar", text: "التعليقات تُجمع كما يعرضها المصدر، دون تصفية للمحتوى أو للغة." }], titles)).toEqual([]);
    expect(childPromiseIssues([{ where: "assumptions_ar", text: "المنشورات بالعربية فقط." }], titles)).toEqual([]);
    expect(childPromiseIssues([{ where: "assumptions_ar", text: "التعليقات بالعربية" }], [])).toEqual([]);
  });

  it("the plan check refuses such a sentence with the way to fix it", () => {
    const checked = validateAndPricePlan({ summary_ar: "منشورات وتعليقاتها.", assumptions_ar: ["المنشورات والتعليقات بالعربية فقط."], stages: [parentStage({ filters: [{ kind: "language", lang: "ar" }] }), childStage()] }, lookupFor("هات ٥ منشورات ومع كل منشور ٣ تعليقات"));
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues.join(" ")).toContain("delivered exactly as the source gives them");
  });

  it("the card states the parents' language as one sentence that names the parents and the children: «اللغة العربية فقط تُطبَّق على المنشورات وحدها، أما التعليقات فتُسلَّم كما هي»", () => {
    const checked = validateAndPricePlan({ summary_ar: "منشورات وتعليقاتها.", assumptions_ar: ["المقصود: منشورات عن الدوري."], stages: [parentStage({ title_ar: "المنشورات", filters: [{ kind: "language", lang: "ar" }] }), childStage()] }, lookupFor("هات ٥ منشورات ومع كل منشور ٣ تعليقات"));
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (!checked.ok) return;
    const lines = customerPlanView(checked.plan).assumptions_ar ?? [];
    expect(lines).toContain("اللغة العربية فقط تُطبَّق على المنشورات وحدها، أما التعليقات فتُسلَّم كما هي.");
    // never the bare promise that the live X card showed beside replies that were delivered raw
    expect(lines).not.toContain("باللغة العربية فقط.");
    expect(customerPlanView(checked.plan).notes_ar).toContain("تُجمع التعليقات كما هي على كل منشور، دون تصفية.");
  });

  it("a plan with no child stage keeps the plain sentence (nothing to scope)", () => {
    const checked = validateAndPricePlan({ summary_ar: "منشورات.", stages: [parentStage({ title_ar: "المنشورات", filters: [{ kind: "language", lang: "ar" }] })] }, lookupFor("هات ٥ منشورات"));
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (checked.ok) expect(customerPlanView(checked.plan).assumptions_ar).toContain("باللغة العربية فقط.");
  });
});
