import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { validateAndPricePlan, customerPlanView, type PlanLookup } from "../src/lib/agentMission/plan";
import { customerMissionView, priceExplainOf } from "../src/lib/agentMission/customerView";
import { publicPlanOf } from "../src/lib/agentMission/overLimit";
import { countAr, itemNounOfPlan } from "../src/lib/agentMission/itemNoun";
import { deliveredBreakdownAr, entityBreakdownOf, entityStagesOfPriced, entityStagesOfPublic } from "../src/lib/agentMission/entityCount";
import { openPlanFactsOf, planFactsLinesAr, planFollowUpAnswerAr, planQuestionKind } from "../src/lib/agentMission/openPlanFacts";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { REVISION_JOINER_AR } from "../src/lib/agentMission/chatTurn";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { COSMETICS_PLAN, OPEN_ID } from "../evals/customer-journey/runner";

/**
 * ROUND 58: A REQUEST FOR 32 COMPANIES IS 32 COMPANIES (owner's acceptance request: «عايز ٣٢ شركة مستحضرات تجميل في مصر، ومع كل شركة موقعها الرسمي، والتليفون والإيميل المنشورين ورابط مصدر المعلومات…»).
 *
 * 13 Nov: the plan was 20 companies + the contacts of about 12 of them = 32 priced items, and the customer read «٣٢» as 32 companies. The contacts are details of the companies: the count the customer reads is the companies' count,
 * the priced total (every delivered item of every step, the approved pricing contract, unchanged here) is called «عنصر» and said to be that, and a target below the customer's own number shows both numbers before the approval.
 */
const REQUEST_32 = "عايز ٣٢ شركة مستحضرات تجميل في مصر، ومع كل شركة موقعها الرسمي، والتليفون والإيميل المنشورين ورابط مصدر المعلومات. لو معلومة مش موجودة سيبها فاضية، ومش عايز شركات خارج المجال.";
const calls = new Map<string, any>([
  ["call_0001", { id: "call_0001", endpointId: "contextdev.parse.google-maps", ok: true, costUsd: 0.00254, rows: 20, params: { query: "cosmetics company Egypt" } }],
  ["call_0002", { id: "call_0002", endpointId: "contextdev.scrape", ok: true, costUsd: 0.00254, rows: 1, params: { url: "https://glow-eg.com/contact" } }],
]);
const lookupFor = (requestText: string): PlanLookup => ({
  call: (id) => calls.get(id) ?? null,
  evidenceText: () => "glow-eg.com#contact glow-eg.com https://glow-eg.com https://maps.google.com/?cid=1 info@glow-eg.com +20 2 1234 5678 https://glow-eg.com/contact",
  endpointAllowed: () => true, requestText, isContactSource: (id) => id === "contextdev.scrape",
  endpointsCalled: () => new Map([["contextdev.parse.google-maps", { rows: 20 }], ["contextdev.scrape", { rows: 1 }]]),
});
const companies = (rows: number, reason?: string) => ({
  key: "companies", title_ar: "شركات مستحضرات التجميل في مصر", endpoint_id: "contextdev.parse.google-maps", expected_rows: rows, parent_key: null, deliver: true, ...(reason ? { target_reason_ar: reason } : {}),
  columns: [{ key: "name", title_ar: "الاسم" }, { key: "website", title_ar: "الموقع الإلكتروني" }, { key: "link", title_ar: "رابط المصدر على خرائط جوجل" }],
  sample_rows: [{ id: "glow-eg.com", name: "Glow Cosmetics", website: "https://glow-eg.com", link: "https://maps.google.com/?cid=1" }], measured_by: ["call_0001"],
});
/** The planner's own titles for the contacts: one that names the companies made the whole plan count as «شركة» before this round. */
const contacts = (title: string) => ({
  key: "contacts", title_ar: title, endpoint_id: "contextdev.scrape", expected_rows: 12, per_parent_rows: 1, parent_key: "companies", deliver: true,
  columns: [{ key: "email", kind: "work_email", title_ar: "الإيميل المنشور" }, { key: "phone", kind: "phone", title_ar: "رقم التليفون المنشور" }, { key: "url", title_ar: "رابط صفحة التواصل المصدر" }],
  sample_rows: [{ id: "glow-eg.com#contact", parent_id: "glow-eg.com", email: "info@glow-eg.com", phone: "+20 2 1234 5678", url: "https://glow-eg.com/contact" }], measured_by: ["call_0002"],
});
const SUMMARY = "شركات مستحضرات التجميل في مصر مع بيانات التواصل المنشورة.";
const REASON = "نتائج الخرائط لمستحضرات التجميل في مصر أقل من المطلوب في العينة التي قرأناها.";
const priced = (input: unknown, request = REQUEST_32) => {
  const r = validateAndPricePlan(input, lookupFor(request));
  if (!r.ok) throw new Error(r.issues.join("\n"));
  return r.plan;
};
const cardOf = (planPublic: any) => customerMissionView({ mission: { id: OPEN_ID, status: "plan_ready", question_ar: null, plan_public: planPublic, reserved_points: planPublic.price.reserve_points, unit_price_points: planPublic.price.unit_price_points, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: new Date().toISOString() } as any, events: [], queue: null, now: Date.now() });
const htmlOf = (planPublic: any) => renderToStaticMarkup(createElement(AgentMissionCardBody, { view: cardOf(planPublic), isGuest: false }));
afterEach(() => { vi.restoreAllMocks(); });

describe("the plan of a 32-company request (the validator; no price rule is changed)", () => {
  it("20 companies proposed with no reason: the companies step IS 32; the contacts follow it", () => {
    const plan = priced({ summary_ar: SUMMARY, stages: [companies(20), contacts("بيانات تواصل الشركات")] });
    expect(plan.quantity).toMatchObject({ requested: 32, target: 32, stage_key: "companies" });
    expect(plan.stages.find((s) => s.key === "companies")!.planned_rows).toBe(32);
  });
  it("20 companies with a reason: the plan keeps the customer's 32 next to the target 20", () => {
    const plan = priced({ summary_ar: SUMMARY, stages: [companies(20, REASON), contacts("بيانات تواصل الشركات")] });
    expect(plan.quantity).toMatchObject({ requested: 32, target: 20 });
    expect(plan.stages.map((s) => s.planned_rows)).toEqual([20, 12]);
  });
  it("a REVISED request counts by its latest change, never by the first number of the request it revises", () => {
    const revised = `عايز ٢٠ شركة مستحضرات تجميل في مصر مع الإيميل والتليفون المنشورين ورابط المصدر ${REVISION_JOINER_AR} لا، عايز ٣٢ شركة مش ٢٠`;
    const plan = priced({ summary_ar: SUMMARY, stages: [companies(20), contacts("بيانات تواصل الشركات")] }, revised);
    expect(plan.quantity).toMatchObject({ requested: 32, target: 32 });
  });
});

describe("20 companies + 12 contact rows are never «٣٢ شركة»", () => {
  for (const title of ["بيانات تواصل الشركات", "إيميلات الشركات وتليفوناتها", "بيانات التواصل المنشورة في الموقع الرسمي لكل شركة"]) {
    it(`contacts titled «${title}»`, () => {
      const plan = priced({ summary_ar: SUMMARY, stages: [companies(20, REASON), contacts(title)] });
      // the plan's noun (the notice, the wallet, the file's first sentence): the priced total is items, never companies
      expect(countAr(32, itemNounOfPlan(plan))).toBe("٣٢ عنصرًا");
      const pub = publicPlanOf(plan);
      const v = cardOf(pub);
      expect(v.headlineCountAr).toBe("٢٠ شركة");
      expect(v.totalRowsAr).toBe("٣٢ عنصرًا");
      const html = htmlOf(pub);
      // «٣٢ شركة» only in the sentence that says the customer asked for 32 and the plan targets 20; no step counts the contacts as companies
      expect(html.replace("طلبتَ ٣٢ شركة", "")).not.toContain("٣٢ شركة");
      expect(html).not.toContain("١٢ شركة");
      expect(html).toContain("المجموع في ملفك: ٣٢ عنصرًا");
      expect(html).toContain("طلبتَ ٣٢ شركة، وهذه الخطة تستهدف ٢٠ فقط");
      expect(html).toContain("وعدد الشركات فيها ٢٠ فقط، لا ٣٢");
      for (const line of [...v.countLinesAr, ...v.priceExplainAr]) expect(checkCustomerText(line, { maxChars: 400 }).issues, line).toEqual([]);
    });
  }
  it("the 13 Nov plan itself: «هتستلم ٢٠ شركة», the contacts of about 12 of them, and the priced total said as items", () => {
    const pub = publicPlanOf(JSON.parse(JSON.stringify(COSMETICS_PLAN)));
    const v = cardOf(pub);
    expect(v.headlineCountAr).toBe("٢٠ شركة");
    expect(v.countLinesAr).toEqual(["ستستلم ٢٠ شركة، ومعها «بيانات التواصل المنشورة في الموقع الرسمي لكل شركة» لحوالي ١٢ منها؛ وهذا عدد مستهدف وليس مضمونًا، وما لا يُنشر في المصدر يبقى فارغًا."]);
    expect(priceExplainOf(pub)[0]).toContain("والمجموع ٣٢ عنصرًا محسوبًا في السعر، وعدد الشركات فيها ٢٠ فقط، لا ٣٢");
  });
  it("a plan that targets what was asked has no target line; a single-step plan keeps today's count", () => {
    const full = publicPlanOf(priced({ summary_ar: SUMMARY, stages: [companies(20), contacts("بيانات تواصل الشركات")] }));
    expect(cardOf(full).headlineCountAr).toBe("٣٢ شركة");
    expect(cardOf(full).countLinesAr.join(" ")).not.toContain("طلبتَ");
    expect(entityBreakdownOf(entityStagesOfPublic({ stages: [{ key: "a", title_ar: "شركات", expected_rows: 5, parent_key: null }] }))).toBeNull();
  });
  it("the file's first sentence counts the companies delivered, then each detail step", () => {
    const plan = priced({ summary_ar: SUMMARY, stages: [companies(20, REASON), contacts("بيانات تواصل الشركات")] });
    expect(deliveredBreakdownAr(entityStagesOfPriced(plan.stages), { companies: 19, contacts: 11 })).toBe("منها ١٩ شركة، و١١ من «بيانات تواصل الشركات».");
  });
  it("an edit of the count rewrites a stale headline in companies, never in the priced total", () => {
    const plan = priced({ summary_ar: "٣٢ شركة مستحضرات تجميل في مصر مع بيانات التواصل المنشورة.", stages: [companies(20), contacts("بيانات تواصل الشركات")] });
    const r: any = applyPlanEdits(plan, { count: 10 });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.plan.stages.find((s: any) => s.key === "companies").planned_rows).toBe(10);
    // the headline's number moves with the companies (its wording of the number is the editor's, unchanged); it is never the priced total
    expect(r.plan.summary_ar).toMatch(/^(?:١٠ شرك|تجمع لك ١٠ شركات)/);
    expect(r.plan.summary_ar).not.toMatch(/عنصر|٣٢/);
  });
});

describe("the chat's facts say the company count and never misleading savings", () => {
  const pub = publicPlanOf(JSON.parse(JSON.stringify(COSMETICS_PLAN)));
  const facts = openPlanFactsOf(pub)!;
  it("the prompt names 20 companies and forbids 32 companies; hiding a column is not a saving", () => {
    const lines = planFactsLinesAr(facts).join("\n");
    expect(lines).toContain("عدد الشركات في الخطة ٢٠ فقط");
    expect(lines).toContain("لا تقل أبدًا إن الخطة فيها ٣٢ من الشركات");
    expect(lines).toContain("إخفاء عمود أو حذفه فلا يغيّر السعر");
    expect(lines).toContain("لا تَعِد بشيء لا تذكره هذه الحقائق");
  });
  it("«يعني ٣٢ شركة؟» answered from the plan: 20 companies, 32 is the priced total; and the short target when there is one", () => {
    expect(planQuestionKind("يعني ٣٢ شركة؟")).toBe("count");
    expect(planQuestionKind("هتجيب كام شركة؟")).toBe("count");
    expect(planQuestionKind("قلل عدد الشركات لـ١٠")).not.toBe("count");
    const a = planFollowUpAnswerAr("count", facts)!;
    expect(a).toContain("٢٠ شركة بس");
    expect(a).toContain("مش عدد الشركات");
    const short = openPlanFactsOf(publicPlanOf(priced({ summary_ar: SUMMARY, stages: [companies(20, REASON), contacts("بيانات تواصل الشركات")] })))!;
    expect(planFollowUpAnswerAr("count", short)).toContain("انت طلبت ٣٢ شركة، والخطة دي بتستهدف ٢٠ بس");
    for (const t of [a, planFollowUpAnswerAr("count", short)!]) expect(checkCustomerText(t, { maxChars: 600 }).issues, t).toEqual([]);
  });
  it("the cost answer: a column is not a saving, and dropping the contacts step drops the contacts", () => {
    const a = planFollowUpAnswerAr("cost", facts)!;
    expect(a).toContain("شيل عمود أو إخفاؤه ما بيغيّرش السعر");
    expect(a).toContain("مش هتوصلك البيانات اللي بتجمعها الخطوة دي");
    expect(checkCustomerText(a, { maxChars: 600 }).issues).toEqual([]);
  });
  it("the card's plan view is unchanged for the planner (customerPlanView keeps quantity for the card)", () => {
    const plan = priced({ summary_ar: SUMMARY, stages: [companies(20, REASON), contacts("بيانات تواصل الشركات")] });
    expect(customerPlanView(plan).quantity).toEqual({ requested: 32, target: 20, stage_key: "companies" });
  });
});

describe("the reply guard refuses what the plan's facts do not say (the real model's replies of 13 Nov, baseline of round 58)", () => {
  const facts = openPlanFactsOf(publicPlanOf(JSON.parse(JSON.stringify(COSMETICS_PLAN))))!;
  it.each([
    ["أيوه، السعر بيقل لأن الخطة بتحسب على عدد العناصر المسلّمة وليس على عدد الأعمدة، فحذف العمودين وحدهم ما بيغيّرش السعر.", "claim:column_saving"],
    ["في الخطة الحالية لا يوجد تصفية للتكرار. إن أردت، أستطيع تجهيز خطة معدّلة تنص على حذف التكرار قبل التسليم.", "claim:dedupe"],
    ["لا أستطيع أن أضمن ذلك. ولكل عنصر خانة للتحقق، وسيظهر في الملف ما وُجد.", "claim:unstated_capability"],
    ["ولو قلّلت العدد إلى ما يناسب حاجتك، ترتفع الجودة لأن كل عنصر سيكون أدق.", "claim:unstated_capability"],
    ["الخطة فيها ٣٢ شركة من خرائط جوجل.", "claim:priced_total_as_entities"],
    ["هنضمن إن كل الشركات يكون ليها إيميل.", "claim:guarantee"],
  ])("%s", async (reply, issue) => {
    const { guardReply } = await import("../src/lib/agentMission/conversationModel");
    const g = guardReply(reply, { message: "x", balancePoints: null, extraAr: ["٣٢", "٢٠"], facts });
    expect(g.ok).toBe(false);
    expect((g as { issues: string[] }).issues).toContain(issue);
  });
  it.each([
    "لا، الخطة فيها ٢٠ شركة مش ٣٢ شركة، والـ٣٢ هو مجموع العناصر المحسوبة في السعر.",
    "شيل عمود أو إخفاؤه ما بيغيّرش السعر، لأن السعر بيتحسب على كل عنصر بيتسلّم.",
    "في الخطة الحالية لا يوجد تصفية للتكرار، فقد تظهر الشركة مرتين.",
    "لا نضمن إن كل الشركات يبقى ليها إيميل وتليفون.",
    "مش هنقدر نضمن إن كل الشركات يبقى ليها إيميل وتليفون.",
    "الخطة مش فيها ٣٢ شركة، فيها ٢٠ شركة.",
    "انت طلبت ٣٢ شركة، والخطة دي فيها ٢٠ بس.",
  ])("an honest reply passes: %s", async (reply) => {
    const { guardReply } = await import("../src/lib/agentMission/conversationModel");
    expect(guardReply(reply, { message: "x", balancePoints: null, extraAr: ["٣٢", "٢٠"], facts }).ok).toBe(true);
  });
  it("no open plan: nothing is checked against plan facts", async () => {
    const { guardReply } = await import("../src/lib/agentMission/conversationModel");
    expect(guardReply("بنشيل التكرار من التعليقات.", { message: "x", balancePoints: null, facts: null }).ok).toBe(true);
  });
  it("«تتكرر؟» answered by code from the plan when the model is unavailable: no de-duplication promised", () => {
    expect(planQuestionKind("هل ممكن الشركة تتكرر مرتين في الملف؟")).toBe("duplicates");
    const a = planFollowUpAnswerAr("duplicates", facts)!;
    expect(a).toContain("مش بتنص على حذف الشركات المكررة");
    expect(checkCustomerText(a, { maxChars: 600 }).issues).toEqual([]);
  });
});
