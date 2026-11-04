import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { customerPlanView, validateAndPricePlan, type PlanLookup, type PricedPlan } from "../src/lib/agentMission/plan";
import { customerMissionView, type MissionRowForCustomer } from "../src/lib/agentMission/customerView";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { MethodologyOfferBody } from "../src/components/mission/MethodologyOffer";
import OpenMissionsList from "../src/components/mission/OpenMissionsList";
import Composer from "../src/app/dashboard/chat/components/Composer";
import TemplateFormCard from "../src/app/dashboard/chat/components/TemplateFormCard";
import DetailsBlanks from "../src/app/dashboard/chat/components/DetailsBlanks";
import TypingIndicator, { TYPING_LINE_FALLBACK_AR } from "../src/app/dashboard/chat/components/TypingIndicator";
import { TEMPLATE_FORMS } from "../src/lib/templateForms";

/**
 * ROUND 26, item 2: AUDIT OF EVERY CONTROL that sends, approves, edits, answers or buys, in the customer chat and on the mission card.
 * Each one says a short «جارٍ ...» while the server has not answered, and is disabled meanwhile, so it cannot be sent twice. One test per control.
 */
const mapped = [1, 2, 3, 4].map((n) => ({ id: `s${n}`, text: `محمد صلاح يسجل هدفًا رقم ${n} مع ليفربول`, url: `https://x.example/s/${n}`, author: `fan${n}`, created_at: "2026-10-20T10:00:00Z", is_reply: "لا" }));
const lookup: PlanLookup = {
  call: (id) => (id === "call_0001" ? { id, endpointId: "anyapi.x.search.posts", ok: true, costUsd: 0.00075, rows: 20, params: { query: "محمد صلاح" } } : null),
  evidenceText: (id) => (id === "out_0001" ? JSON.stringify(mapped) : `${JSON.stringify(mapped)} https://x.example/s/1 s1`),
  endpointAllowed: () => true, requestText: "هات ٣٠٠ تغريدة عن محمد صلاح بكل اللغات",
};
const plan = (): PricedPlan => {
  const r = validateAndPricePlan({ summary_ar: "ستحصل على تغريدات عن محمد صلاح مع نص كل تغريدة ورابطها.", stages: [{
    key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: 300, parent_key: null, deliver: true,
    columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "created_at", title_ar: "التاريخ والوقت" }],
    sample_rows: mapped.slice(0, 2), measured_by: ["call_0001", "out_0001"], relevance: { subject_ar: "لاعب كرة القدم محمد صلاح", terms: ["محمد صلاح"], text_columns: ["text"], min_own_words: 0 }, yield_from: "out_0001", filters: [{ kind: "exclude_replies" }],
  }] }, lookup);
  if (!r.ok) throw new Error(r.issues.join("; "));
  return r.plan;
};
const planRow = (patch: Partial<MissionRowForCustomer> = {}): MissionRowForCustomer => ({ id: "msn_a", status: "plan_ready", question_ar: null, plan_public: customerPlanView(plan()), reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-04T12:19:32.000Z", ...patch } as MissionRowForCustomer);
const planView = () => customerMissionView({ mission: planRow(), events: [] });
const questionView = () => ({ ...customerMissionView({ mission: { ...planRow({ status: "needs_input", plan_public: { question_options: ["١٠", "٥٠"] } as any }), question_ar: "تحب كام تغريدة؟" }, events: [] }), phase: "question", questionOptionsAr: ["١٠", "٥٠"] }) as any;
const limitView = () => ({ ...planView(), limit: { over: true, capPoints: 600, reservePoints: 2000, sentenceAr: "هذه الخطة أكبر من الحد.", rowsAr: null, smaller: { perPost: 5, reservePoints: 300 } } }) as any;
const card = (view: any, props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false, ...props }));
const button = (html: string, testId: string) => html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? "";
const isDisabled = (tag: string) => /disabled=""/.test(tag.split(">")[0]);

describe("mission card: each control says «جارٍ ...» and is disabled while the server answers", () => {
  it("1. a ready answer (choice)", () => {
    const html = card(questionView(), { busy: true, pendingAction: "answer", pendingText: "١٠" });
    expect(html).toContain("جارٍ الإرسال…");
    const choices = html.match(/<button[^>]*>(?:١٠|٥٠|جارٍ الإرسال…)<\/button>/g) ?? [];
    expect(choices).toHaveLength(2);
    for (const c of choices) expect(c).toMatch(/disabled=""/);
    // the tapped choice is the only one that says it is on its way; the free-text button keeps its own label
    expect(html.match(/جارٍ الإرسال…/g)).toHaveLength(1);
    expect(html).toContain("أرسل إجابتك");
  });
  it("2. the free-text answer: the field and its send button are disabled and the button says «جارٍ الإرسال…»", () => {
    const html = card(questionView(), { busy: true, pendingAction: "answer", pendingText: "ألف", reply: "ألف" });
    const input = html.match(/<input[^>]*aria-label="أو اكتب إجابتك"[^>]*\/?>/)?.[0] ?? "";
    expect(input).toMatch(/disabled=""/);
    const send = html.match(/<button[^>]*>جارٍ الإرسال…<\/button>/)?.[0] ?? "";
    expect(send).toMatch(/disabled=""/);
  });
  it("3. approve", () => {
    const b = button(card(planView(), { busy: true, pendingAction: "approve" }), "agent-approve");
    expect(b).toContain("جاري الاعتماد…");
    expect(isDisabled(b)).toBe(true);
  });
  it("4. edit the plan: save says «جارٍ الحفظ…», close and retype are disabled", () => {
    const html = card(planView(), { editing: true, busy: true, pendingAction: "edit_plan" });
    expect(button(html, "agent-edit-save")).toContain("جارٍ الحفظ…");
    expect(isDisabled(button(html, "agent-edit-save"))).toBe(true);
    expect(isDisabled(button(html, "agent-edit-close"))).toBe(true);
    expect(isDisabled(button(html, "agent-retype"))).toBe(true);
  });
  it("5. retype the request (the edit action) says «جارٍ التجهيز…»", () => {
    const html = card(planView(), { editing: true, busy: true, pendingAction: "edit" });
    expect(button(html, "agent-retype")).toContain("جارٍ التجهيز…");
    expect(isDisabled(button(html, "agent-edit"))).toBe(true);
  });
  it("6. the smaller version", () => {
    const b = button(card(limitView(), { busy: true, pendingAction: "smaller" }), "agent-smaller");
    expect(b).toMatch(/جار[يٍ] التجهيز…/);
    expect(isDisabled(b)).toBe(true);
  });
  it("7. cancel the mission says «جارٍ الإلغاء…» and is disabled", () => {
    const b = button(card(limitView(), { busy: true, pendingAction: "cancel" }), "agent-cancel");
    expect(b).toContain("جارٍ الإلغاء…");
    expect(isDisabled(b)).toBe(true);
  });
  it("8. while any one action is on its way, every other action of the card is disabled too", () => {
    const html = card(limitView(), { busy: true, pendingAction: "cancel" });
    for (const id of ["agent-smaller", "agent-edit", "agent-cancel"]) expect(isDisabled(button(html, id)), id).toBe(true);
  });
});

describe("methodology purchase", () => {
  it("9. confirm and cancel while the purchase is on its way: «جارٍ التجهيز…» and both disabled", () => {
    const html = renderToStaticMarkup(createElement(MethodologyOfferBody, { purchased: false, step: "busy" }));
    expect(button(html, "methodology-offer-confirm")).toContain("جارٍ التجهيز…");
    expect(isDisabled(button(html, "methodology-offer-confirm"))).toBe(true);
    expect(isDisabled(button(html, "methodology-offer-cancel"))).toBe(true);
  });
  it("10. the download of a bought methodology", () => {
    const html = renderToStaticMarkup(createElement(MethodologyOfferBody, { purchased: true, step: "busy" }));
    expect(button(html, "methodology-offer-download")).toContain("جارٍ التجهيز…");
    expect(isDisabled(button(html, "methodology-offer-download"))).toBe(true);
  });
  it("11. the chat's own methodology confirmation", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toMatch(/disabled=\{methodologyPurchasing\} onClick=\{\(\) => void confirmGenerateMethodology\(\)\}[^>]*>\{methodologyPurchasing \? "جارٍ التج/);
  });
});

describe("the chat's own controls", () => {
  it("12. composer", () => {
    expect(renderToStaticMarkup(createElement(Composer, { value: "نص", onChange: () => {}, onSend: () => {}, disabled: true }))).toContain("جارٍ الإرسال…");
  });
  it("13. templates", () => {
    const html = renderToStaticMarkup(createElement(TemplateFormCard, { form: TEMPLATE_FORMS[0], onSend: () => {}, onClose: () => {}, disabled: true }));
    expect(button(html, "template-form-send")).toContain("جارٍ الإرسال…");
    expect(isDisabled(button(html, "template-form-send"))).toBe(true);
  });
  it("14. the clarification answers", () => {
    const questions = [{ id: "q", text: "ما القطاع؟", type: "single", options: ["مقاولات"], allowOther: false }];
    const html = renderToStaticMarkup(createElement(DetailsBlanks, { questions: questions as any, disabled: true, onComplete: () => {} }));
    expect(html).toContain("جارٍ الإرسال…");
  });
  it("15. the retry of a failed message and the resend of the clarification answers", () => {
    const source = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(source).toMatch(/disabled=\{loading\}[^>]*>\s*\{loading \? "جارٍ الإرسال…" : "إعادة المحاولة الآن"\}/);
    expect(source).toMatch(/disabled=\{loading\}[^>]*>\s*\{loading \? "جارٍ الإرسال…" : "إعادة إرسال الإجابات الآن"\}/);
  });
  it("16. the plan card of the chat: the «smaller plan», «sample first» and «refresh the price» buttons wait for the server (a label and disabled), like «أوافق»", () => {
    const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
    expect(card).toMatch(/data-testid="edit-plan-downscaled-btn"[\s\S]{0,400}disabled=\{quote\.isDependent \|\| sending\}/);
    expect(card).toMatch(/\{sending \? "جارٍ الإرسال…" : /);
    expect(card).toMatch(/data-testid="explore-first-btn"[\s\S]{0,300}disabled=\{isStarting \|\| quote\.isDependent \|\| exploring \|\| sending\}/);
    expect(card).toContain('"جارٍ التجهيز…"');
    expect(card).toContain("جارٍ التحديث…");
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toMatch(/sending=\{loading\}/);
  });
  it("17. the open-missions list: the cancel of a waiting request says «جارٍ الإلغاء…» while it is on its way", () => {
    const item = { id: "msn_1", status: "plan_ready", stateAr: "تنتظر اعتمادك", requestText: "طلب", createdAt: "2026-11-04T12:00:00.000Z", cancellable: true, conversationId: null } as any;
    const html = renderToStaticMarkup(createElement(OpenMissionsList, { items: [item], busyId: "msn_1", error: "", onCancel: () => {}, defaultOpen: true }));
    expect(html).toContain("جارٍ الإلغاء…");
    expect(html).toMatch(/disabled=""[^>]*>جارٍ الإلغاء…/);
  });
});

describe("the chat typing indicator", () => {
  it("18. it shows animated dots and the status line of the waiting reply, as a status", () => {
    const html = renderToStaticMarkup(createElement(TypingIndicator, { textAr: "يكتب الرد..." }));
    expect(html).toContain('data-testid="typing-indicator"');
    expect(html).toContain('role="status"');
    expect(html).toContain("يكتب الرد...");
    expect((html.match(/run-dot/g) ?? []).length).toBe(3);
  });
  it("19. with no status text it says a default Arabic line", () => {
    expect(renderToStaticMarkup(createElement(TypingIndicator, {}))).toContain(TYPING_LINE_FALLBACK_AR);
  });
  it("20. the chat shows it from the moment a message is sent until the reply (or the mission card) is in the conversation", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain('import TypingIndicator from "./components/TypingIndicator";');
    expect(page).toMatch(/\{loading && \([\s\S]{0,200}<TypingIndicator textAr=\{loadingStatusText\} \/>/);
  });
});
