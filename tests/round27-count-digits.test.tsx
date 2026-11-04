import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { customerPlanView, validateAndPricePlan, type PlanLookup, type PricedPlan } from "../src/lib/agentMission/plan";
import { customerMissionView, type MissionRowForCustomer } from "../src/lib/agentMission/customerView";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { editsFromState, initialState } from "../src/components/mission/PlanEditor";
import { countInputValue, displayDigitsAr } from "../src/lib/digitsInput";

/**
 * ROUND 27, item 2: the count field showed LATIN digits (10, 12) while the rest of the site shows Arabic-Indic digits. Display only:
 * what is shown (and what the customer types) is Arabic-Indic; the field still ACCEPTS Latin, Arabic-Indic and Persian digits; the number that is sent is a normal number.
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
    columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "created_at", title_ar: "التاريخ" }],
    sample_rows: mapped.slice(0, 2), measured_by: ["call_0001", "out_0001"], relevance: { subject_ar: "لاعب كرة القدم محمد صلاح", terms: ["محمد صلاح"], text_columns: ["text"] },
    yield_from: "out_0001",
  }] } as any, lookup);
  if (!r.ok) throw new Error(r.issues.join("; "));
  return r.plan;
};
const row = (): MissionRowForCustomer => ({ id: "msn_a", status: "plan_ready", question_ar: null, plan_public: customerPlanView(plan()), reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-04T12:19:32.000Z" } as MissionRowForCustomer);

describe("the helpers", () => {
  it("display: any digit kind becomes Arabic-Indic, other characters stay", () => {
    expect(displayDigitsAr("10")).toBe("١٠");
    expect(displayDigitsAr("١٢")).toBe("١٢");
    expect(displayDigitsAr("۲۵")).toBe("٢٥");
    expect(displayDigitsAr("كل")).toBe("كل");
    expect(displayDigitsAr("5 فيديو")).toBe("٥ فيديو");
    expect(displayDigitsAr("")).toBe("");
  });
  it("parsing: Latin, Arabic-Indic and Persian digits give the same normal number", () => {
    expect(countInputValue("10")).toBe(10);
    expect(countInputValue("١٠")).toBe(10);
    expect(countInputValue("۱۰")).toBe(10);
    expect(countInputValue(" ١٢ ")).toBe(12);
    expect(countInputValue("1٠")).toBe(10);
  });
  it("parsing: no digits is null, never zero or NaN", () => {
    expect(countInputValue("")).toBeNull();
    expect(countInputValue("كل")).toBeNull();
  });
});

describe("the plan editor's count field", () => {
  const view = customerMissionView({ mission: row(), events: [] });
  it("is drawn with Arabic-Indic digits: the count and the limit line, no Latin digit in any number field", () => {
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false, editing: true }));
    const field = html.match(/<input[^>]*data-testid="agent-edit-count"[^>]*>/)?.[0] ?? "";
    expect(field).toMatch(/value="[٠-٩]+"/);
    expect(field).not.toMatch(/value="[^"]*\d/);
    for (const input of html.match(/<input[^>]*inputMode="numeric"[^>]*>/g) ?? []) expect(input).not.toMatch(/value="[^"]*[0-9]/);
  });
  it("the stored state is shown in Arabic-Indic digits and still parses to the same plain numbers", () => {
    const edit = view.edit!;
    const state = initialState(edit);
    expect(state.count).toMatch(/^[٠-٩]+$/);
    expect(editsFromState(edit, state)).toEqual({});
    for (const typed of ["25", "٢٥", "۲۵"]) expect(editsFromState(edit, { ...state, count: typed })).toEqual({ count: 25 });
  });
  it("what the customer types is shown in Arabic-Indic digits whatever the keyboard", () => {
    const src = readFileSync("src/components/mission/PlanEditor.tsx", "utf8");
    expect(src).toMatch(/data-testid="agent-edit-count"/);
    expect(src).toContain("displayDigitsAr(e.target.value)");
  });
});

describe("the free-text answer of the question card", () => {
  it("shows what is typed in Arabic-Indic digits and sends a plain number when the answer is a number", () => {
    const card = readFileSync("src/components/mission/AgentMissionCard.tsx", "utf8");
    expect(card).toContain("onReply(displayDigitsAr(e.target.value))");
    expect(card).toContain("countInputValue(");
  });
});

describe("the older plan card's limit field", () => {
  it("is a text field with numeric keyboard (a number field draws Latin digits), shown in Arabic-Indic digits, parsed from any digit kind", () => {
    const src = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
    expect(src).not.toMatch(/id=\{`pq-limit-\$\{quote\.quoteId\}`\} type="number"/);
    expect(src).toContain("value={toArabicDigits(editLimit)}");
    expect(src).toContain("countInputValue(e.target.value)");
    expect(src).toContain("displayDigitsAr(e.target.value)");
  });
});
