import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MissionInspector, NO_CARD_REASON_AR, noCardReasonAr } from "../src/components/admin/MissionInspector";
import { buildInspection } from "../src/lib/server/adminMissionInspector";

/**
 * DT-20261118-06 PR 2: the inspector page (the test environment is node: no DOM library, so the component is rendered to static markup from a fixture built by the API's own builder). It proves what the team sees (sections, failed calls first,
 * the no-card reason in Arabic, the estimated stage marked, redacted text only), that nothing on the page can change anything (no form, no input, only the filter chips), and that the page is right-to-left safe (logical classes only).
 */
const at = (n: number) => new Date(Date.parse("2026-11-19T09:00:00Z") + n * 1000).toISOString();
const call = (n: number, over: Record<string, unknown> = {}) => ({ id: `msn_x:call_${n}`, phase: "planning", endpoint_id: "company.search", status: "ok", http_status: 200, rows_returned: 5, cost_usd: 0.0005, duration_ms: 300, params_digest: { query: "x" }, created_at: at(n), ...over });
const fixture = () => buildInspection({
  now: new Date("2026-11-19T10:00:00Z"), callTotal: 4,
  mission: { id: "msn_abcd1234", status: "failed", created_at: at(0), updated_at: at(60), request_text: "عايز شركتين مقاولات ومسؤوليهم", error: "admin: planning_failed class=internal reason=people_sources_failed detail=Invalid API key", summary_ar: "لم نجد ما طلبته.", delivered_units: 0, charged_points: 0, reserved_points: 0, planning_llm_usd: 0.0123, files: [{ kind: "xlsx", name: "نتائج.xlsx", path: "p/secret.xlsx" }],
    plan: { price: { deliveredRows: 15 }, stages: [{ key: "companies", title_ar: "شركات المقاولات", endpoint_id: "company.search", parent_key: null, deliver: true, planned_rows: 5 }, { key: "people", title_ar: "الأشخاص", endpoint_id: "people.finder", parent_key: "companies", deliver: true, planned_rows: 10, estimated: true }] } },
  calls: [call(1), call(2, { endpoint_id: "people.finder", status: "failed", http_status: 401, rows_returned: null, params_digest: { _failure: "Invalid API key" } }), call(3, { status: "empty", rows_returned: 0 }), call(4, { endpoint_id: "people.finder", status: "refused", refused_reason: "budget", http_status: null, rows_returned: null })],
  events: [{ id: 1, kind: "call", message_ar: "قياس داخلي: فهم النموذج للطلب: شركتان ومعهما أشخاصهما.", counts: { llm_planner: 1 }, created_at: at(1) }, { id: 2, kind: "result", message_ar: "انتهت.", counts: {}, created_at: at(9) }],
});
const html = () => renderToStaticMarkup(createElement(MissionInspector, { data: fixture() }));

describe("what the team sees", () => {
  it("the sections: the mission, the planner's decision with the no-card reason in Arabic, the stages, the calls, the per-source totals, the events", () => {
    const h = html();
    for (const t of ["المهمة", "قرار المخطط", "المراحل", "الاستدعاءات", "الإجمالي لكل مصدر", "الأحداث"]) expect(h).toContain(t);
    expect(h).toContain("عايز شركتين مقاولات ومسؤوليهم");
    expect(h).toContain("لماذا لا يوجد كارت: مصدر الأشخاص فشل في العينة");
    expect(h).toContain("شركتان ومعهما أشخاصهما.");
    expect(h).toContain("سعر تقديري"); // the estimated people stage is marked
    expect(h).toContain("فشلت"); // its state: both calls failed or were refused
    expect(h).toContain(" · داخلي"); // the internal event is labelled
    expect(h).toContain("نتائج.xlsx");
    expect(h).not.toContain("secret.xlsx"); // names only, no path
  });
  it("the calls table lists the failed and refused calls first, then by time", () => {
    const rows = [...html().matchAll(/<td class="[^"]*"><span dir="ltr"[^>]*>(company\.search|people\.finder)<\/span><span class="ms-1 text-mut">تخطيط/g)].map((m) => m[1]);
    // calls by time: 1 ok (company), 2 failed (people), 3 empty (company), 4 refused (people): failed and refused come first
    expect(rows).toEqual(["people.finder", "people.finder", "company.search", "company.search"]);
  });
  it("every no-card reason the worker writes has an Arabic sentence; an unknown one shows its code", () => {
    for (const reason of Object.keys(NO_CARD_REASON_AR)) expect(noCardReasonAr({ cls: "internal", reason })).toBe(NO_CARD_REASON_AR[reason]);
    expect(noCardReasonAr({ cls: "internal", reason: "plan_invalid_after_3" })).toMatch(/غير صالحة/);
    expect(noCardReasonAr({ cls: "x", reason: "brand_new_reason" })).toContain("brand_new_reason");
  });
  it("shows text the API redacted and nothing else: no e-mail-shaped or token-shaped string reaches the markup of a redacted fixture", () => {
    const h = renderToStaticMarkup(createElement(MissionInspector, { data: buildInspection({ now: new Date(), callTotal: 0, mission: { id: "msn_abcd1234", status: "failed", request_text: "كلّم a@b.co على +20 100 123 4567", plan: null }, calls: [], events: [] }) }));
    expect(h).not.toMatch(/a@b\.co|123 4567/);
  });
});

describe("read only, right to left", () => {
  it("no form, no input, no textarea, no select; the only buttons are the four filter chips (role tab)", () => {
    const h = html();
    expect(h).not.toMatch(/<(form|input|textarea|select)\b/);
    const buttons = [...h.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    expect(buttons.length).toBe(4);
    for (const b of buttons) expect(b).toContain('role="tab"');
    expect(h).not.toMatch(/اعتماد|إلغاء|حذف|إرسال|عدّل/);
  });
  it("logical classes only in the page, the component and the link: no left/right/ml/mr/pl/pr/text-left/text-right", () => {
    const root = path.resolve(__dirname, "..");
    for (const f of ["src/components/admin/MissionInspector.tsx", "src/app/admin/missions/[id]/page.tsx"]) {
      const src = readFileSync(path.join(root, f), "utf8");
      expect(src, f).not.toMatch(/className="[^"]*(?:^|[\s"])(?:ml|mr|pl|pr|left|right)-|text-(?:left|right)\b/);
      expect(src, f).not.toMatch(/\b(?:ml|mr|pl|pr)-\d/);
    }
    expect(html()).not.toMatch(/\b(?:ml|mr|pl|pr)-\d|text-(?:left|right)\b/);
    expect(html()).toContain('dir="rtl"');
  });
  it("the page reads with GET only, audits the first read only (`?first=1`), and has no POST", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/app/admin/missions/[id]/page.tsx"), "utf8");
    expect(src).not.toMatch(/method:|POST|PUT|DELETE|body:/);
    expect(src.match(/\?first=1/g)?.length).toBe(1);
    expect(src).toMatch(/const first = !opened\.current;/);
    expect(src).toMatch(/adminDetailDelayMs\(status\.current\)/);
  });
  it("the agent console links to the inspector for a research mission, and the audit screen has a colour for the «inspect» action", () => {
    const root = path.resolve(__dirname, "..");
    expect(readFileSync(path.join(root, "src/app/admin/agent/page.tsx"), "utf8")).toMatch(/href=\{`\/admin\/missions\/\$\{m\.id\}`\}/);
    expect(readFileSync(path.join(root, "src/app/admin/audit/page.tsx"), "utf8")).toMatch(/inspect: "var\(--info\)"/);
  });
});
