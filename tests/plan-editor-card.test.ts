import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { customerPlanView, validateAndPricePlan, type PlanLookup, type PricedPlan } from "../src/lib/agentMission/plan";
import { customerMissionView, type MissionRowForCustomer } from "../src/lib/agentMission/customerView";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { editsFromState, initialState } from "../src/components/mission/PlanEditor";
import { INTERNAL_FAILURE_AR } from "../agent/src/runMission";

const mapped = [1, 2, 3, 4].map((n) => ({ id: `s${n}`, text: `محمد صلاح يسجل هدفًا رقم ${n} مع ليفربول`, url: `https://x.example/s/${n}`, author: `fan${n}`, created_at: "2026-10-20T10:00:00Z", is_reply: "لا" }));
const lookup: PlanLookup = {
  call: (id) => (id === "call_0001" ? { id, endpointId: "anyapi.x.search.posts", ok: true, costUsd: 0.00075, rows: 20, params: { query: "محمد صلاح" } } : null),
  evidenceText: (id) => (id === "out_0001" ? JSON.stringify(mapped) : `${JSON.stringify(mapped)} https://x.example/s/1 s1`),
  endpointAllowed: () => true, requestText: "هات ٣٠٠ تغريدة عن محمد صلاح",
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
const row = (patch: Partial<MissionRowForCustomer> = {}): MissionRowForCustomer => ({ id: "msn_a", status: "plan_ready", question_ar: null, plan_public: customerPlanView(plan()), reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: new Date().toISOString(), ...patch });
const html = (view: ReturnType<typeof customerMissionView>, props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false, ...props }));

describe("«عدّل الطلب» opens the plan editor; retyping stays beside it", () => {
  it("the plan card has the button; the editor is closed until it is pressed", () => {
    const view = customerMissionView({ mission: row(), events: [] });
    expect(view.phase).toBe("plan");
    expect(view.edit).not.toBeNull();
    const closed = html(view);
    expect(closed).toContain('data-testid="agent-edit"');
    expect(closed).toContain("عدّل الطلب");
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("agent-plan-editor");
  });

  it("open: the number, each exclusion with its switch, the main columns (the locked ones disabled), save, close and «اكتب الطلب من جديد»", () => {
    const view = customerMissionView({ mission: row(), events: [] });
    const open = html(view, { editing: true });
    expect(open).toContain('data-testid="agent-plan-editor"');
    expect(open).toContain('data-testid="agent-edit-count"');
    expect(open).toContain('value="300"');
    expect(open).toContain("استبعاد الردود");
    expect(open).toContain("اللغة");
    expect(open).toContain("الفترة الزمنية");
    expect(open).toContain("أعمدة الملف");
    expect(open).toContain("نص التغريدة");
    expect(open).toContain('data-testid="agent-edit-save"');
    expect(open).toContain('data-testid="agent-retype"');
    expect(open).toContain("اكتب الطلب من جديد");
    // the text column is locked (a check reads it)
    expect(open).toContain('<input type="checkbox" disabled="" checked=""/>نص التغريدة');
    expect(open).toContain('<input type="checkbox" checked=""/>الحساب');
    expect(open).toContain('aria-expanded="true"');
    // the save button waits for a change
    expect(open).toMatch(/data-testid="agent-edit-save"/);
  });

  it("an older plan with no editor data falls back to the old behaviour (cancel and retype), never a broken button", () => {
    const pp: any = { ...customerPlanView(plan()) };
    delete pp.edit;
    const view = customerMissionView({ mission: row({ plan_public: pp }), events: [] });
    expect(view.edit).toBeNull();
    expect(html(view, { editing: true })).not.toContain("agent-plan-editor");
    expect(html(view)).toContain("عدّل الطلب");
  });

  it("the editor sends only what changed", () => {
    const edit = customerPlanView(plan()).edit;
    const state = initialState(edit);
    expect(editsFromState(edit, state)).toEqual({});
    const changed = JSON.parse(JSON.stringify(state));
    changed.count = "١٢٠";
    changed.stages.tweets.columns.author = false;
    changed.stages.tweets.filters.language.enabled = true;
    changed.stages.tweets.filters.period.enabled = true;
    changed.stages.tweets.filters.period.days = "٧";
    expect(editsFromState(edit, changed)).toEqual({
      count: 120,
      stages: [{ key: "tweets", columns: ["text", "url", "created_at"], filters: [{ kind: "language", enabled: true, lang: "ar" }, { kind: "period", enabled: true, days: 7 }] }],
    });
  });
});

describe("THE END IS SAID, ONCE, HONESTLY, ON THE CARD", () => {
  const base = { delivered_units: 0, charged_points: 0, reserved_points: 235 };
  it("an internal failure: our fault, the hold released, no «nothing found»", () => {
    const view = customerMissionView({ mission: row({ ...base, status: "failed", summary_ar: INTERNAL_FAILURE_AR }), events: [] });
    expect(view.phase).toBe("failed");
    expect(view.endLineAr).toBe(INTERNAL_FAILURE_AR);
    const out = html(view);
    expect(out).toContain('data-testid="agent-end-line"');
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain("خلل من جانبنا");
    expect(out).toContain("حجز مؤقت مُحرَّر");
    expect(out).not.toContain("لم نجد");
  });
  it("unserved says what the run recorded; cancelled says nothing was charged; open missions have no end line", () => {
    const unserved = customerMissionView({ mission: row({ ...base, status: "unserved", summary_ar: "لم يُسلَّم أي شيء، ولم يُخصم منك شيء." }), events: [] });
    expect(unserved.endLineAr).toBe("لم يُسلَّم أي شيء، ولم يُخصم منك شيء.");
    expect(html(unserved)).toContain('data-testid="agent-end-line"');
    expect(customerMissionView({ mission: row({ status: "cancelled" }), events: [] }).endLineAr).toBe("أُلغيت هذه المهمة ولم يُخصم شيء.");
    expect(customerMissionView({ mission: row({ status: "executing" }), events: [] }).endLineAr).toBeNull();
    expect(customerMissionView({ mission: row(), events: [] }).endLineAr).toBeNull();
  });
  it("a delivery below the request is «partial» with the request in the sentence", () => {
    const withQuantity: any = { ...customerPlanView(plan()), quantity: { requested: 300, target: 120, stage_key: "tweets" } };
    withQuantity.stages[0].expected_rows = 120;
    const view = customerMissionView({ mission: row({ status: "completed", plan_public: withQuantity, delivered_units: 120, charged_points: 200, reserved_points: 200 }), events: [] });
    expect(view.requestedRows).toBe(300);
    expect(view.phase).toBe("partial");
    expect(view.resultLinesAr[0]).toBe("تم تسليم ١٢٠ من ٣٠٠ تغريدة.");
    expect(view.endLineAr).toBe("تم تسليم ١٢٠ من ٣٠٠ تغريدة.");
  });
});
