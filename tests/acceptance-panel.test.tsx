import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

vi.mock("../src/components/admin/AdminShell", () => ({ useAdmin: () => ({ toast: () => undefined }) }));
import { AcceptancePanelView, acceptanceReportOf, type State } from "../src/components/admin/AcceptancePanel";
import AgentPage from "../src/app/admin/agent/page";
import { ACCEPTANCE_FLAG_KEYS, L4_FLAG_KEYS, PRODUCTION_BUDGET_GUARANTEE } from "../src/lib/agentMission/acceptance/campaign";
import { SCENARIOS } from "../src/lib/agentMission/acceptance/scenarios";

/** The acceptance panel of the agent console (checked by static render: no DOM test library is installed). Offline: no fetch is made by a static render. */
const TEST_ID = "b0d08be8-db61-4860-841e-fa963045557e";
const flags = (on: string[] = [], everyone: string[] = []) => ACCEPTANCE_FLAG_KEYS.map((key) => ({ key, set: on.includes(key) || everyone.includes(key), onForTestAccount: on.includes(key) || everyone.includes(key), onForOthers: everyone.includes(key), scopedToTestAccountOnly: !everyone.includes(key) }));
const base = (over: Partial<State> = {}): State => ({
  account: { id: TEST_ID }, campaign: null, flags: flags(), isolated: true, budget: { ...PRODUCTION_BUDGET_GUARANTEE, reasons: [...PRODUCTION_BUDGET_GUARANTEE.reasons] }, ceilingUsd: 0.3, minutes: { min: 10, max: 180 },
  keys: [...ACCEPTANCE_FLAG_KEYS], l4Keys: [...L4_FLAG_KEYS], scenarios: SCENARIOS.map((s) => ({ id: s.id, titleAr: s.titleAr, ceilingUsd: s.ceilingUsd, route: s.route, intelligence: s.intelligence, checksAr: s.checksAr })),
  spend: { since: "2026-11-14T10:00:00Z", totalUsd: 0.0123, missions: [{ id: "msn_a", status: "completed", created_at: "2026-11-14T10:05:00Z", planning_llm_usd: 0.01, execution_llm_usd: 0, planning_treg_usd: 0.0023, execution_treg_usd: 0, reserved_points: 100, charged_points: 40 }] },
  ...over,
});
const render = (state: State | null) => renderToStaticMarkup(createElement(AcceptancePanelView, { state, chosen: null, minutes: 60, busy: false, onChoose: () => undefined, onMinutes: () => undefined, onAction: () => undefined, onReport: () => undefined }));
const button = (html: string, id: string) => new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? "";
const disabled = (html: string, id: string) => { const b = button(html, id); expect(b, id).not.toBe(""); return /\sdisabled=""/.test(b); };
const ENFORCEABLE = { enforceable: true, ceilingUsd: 0.3, reasons: [] };

describe("the acceptance panel", () => {
  it("PRODUCTION today: says in Arabic why the ceiling is not enforceable; switching on and creating missions are disabled; restoring has nothing to do", () => {
    const html = render(base());
    expect(html).toContain('data-testid="acceptance-budget-blocked"');
    expect(html).toContain("غير قابل للتطبيق بعد");
    expect(html).toContain("طلبات النموذج لا يُحجز حدّها الأقصى");
    expect(html).toContain("حدود المزودين يومية ومشتركة");
    expect(html).toContain("بوابة الإنفاق غير مطبّقة");
    expect(disabled(html, "acceptance-start")).toBe(true);
    expect(disabled(html, "acceptance-create-L3")).toBe(true);
    expect(disabled(html, "acceptance-create-L4")).toBe(true);
    expect(disabled(html, "acceptance-restore")).toBe(true);
    expect(disabled(html, "acceptance-report")).toBe(false);
  });

  it("with an enforceable ceiling and no campaign: switching on and L3 are enabled, L4 is not (it needs the campaign)", () => {
    const html = render(base({ budget: ENFORCEABLE }));
    expect(html).toContain('data-testid="acceptance-budget-ok"');
    expect(disabled(html, "acceptance-start")).toBe(false);
    expect(disabled(html, "acceptance-create-L3")).toBe(false);
    expect(disabled(html, "acceptance-create-L4")).toBe(true);
  });

  it("during a live campaign: L4 is enabled, L3 is not (it runs flags-off), a second start is disabled, restore is enabled, each switch says until when", () => {
    const html = render(base({ budget: ENFORCEABLE, flags: flags([...L4_FLAG_KEYS]), campaign: { keys: [...L4_FLAG_KEYS], started_at: "2026-11-14T10:00:00Z", expires_at: "2026-11-14T11:00:00Z", expired: false, started_by: "adm" } }));
    expect(disabled(html, "acceptance-create-L4")).toBe(false);
    expect(disabled(html, "acceptance-create-L3")).toBe(true);
    expect(disabled(html, "acceptance-start")).toBe(true);
    expect(disabled(html, "acceptance-restore")).toBe(false);
    expect(html).toContain("مفعّل لحساب الاختبار حتى");
  });

  it("an expired campaign: L4 is disabled, restore stays enabled (it removes the leftovers)", () => {
    const html = render(base({ budget: ENFORCEABLE, flags: ACCEPTANCE_FLAG_KEYS.map((key) => ({ key, set: L4_FLAG_KEYS.includes(key), onForTestAccount: false, onForOthers: false, scopedToTestAccountOnly: true })), campaign: { keys: [...L4_FLAG_KEYS], started_at: "2026-11-14T10:00:00Z", expires_at: "2026-11-14T10:10:00Z", expired: true, started_by: "adm" } }));
    expect(disabled(html, "acceptance-create-L4")).toBe(true);
    expect(disabled(html, "acceptance-restore")).toBe(false);
    expect(html).toContain("مضبوط ومنتهي");
  });

  it("a switch on for EVERYONE is an alert; the isolation line says so", () => {
    const html = render(base({ isolated: false, flags: flags([], ["registry_router"]) }));
    expect(html).toMatch(/data-testid="acceptance-isolation"[^>]*role="alert"|role="alert"[^>]*data-testid="acceptance-isolation"/);
    expect(html).toContain("مفعّل لغير حساب الاختبار");
  });

  it("PRIVACY: L1/L2 take no identifier here (no text, e-mail or phone box); they point to the reverse-lookup screen; nothing with an @ is shown", () => {
    const html = render(base());
    expect(html).not.toMatch(/type="(email|tel|text)"/);
    expect(html).not.toMatch(/<textarea/);
    expect(html.match(/href="\/admin\/reverse-lookup"/g)).toHaveLength(2);
    expect(html).not.toContain("@");
    expect(button(html, "acceptance-create-L1")).toBe("");
    expect(button(html, "acceptance-create-L2")).toBe("");
  });

  it("spend: the total against the ceiling and each mission's own spend; an unreadable spend says so (never a zero)", () => {
    expect(render(base())).toContain("إنفاق مهام حساب الاختبار");
    expect(render(base({ spend: null }))).toContain("تعذّر قراءة الإنفاق");
  });

  it("loading: nothing is offered before the state arrives", () => {
    const html = render(null);
    expect(html).toContain("جارٍ التحميل");
    expect(html).not.toContain("acceptance-start");
  });

  it("the report: the state as read, the test account id only, no e-mail of anybody", () => {
    const report = acceptanceReportOf(base(), "2026-11-14T12:00:00.000Z");
    expect(report).toMatchObject({ kind: "diger_acceptance_report", generated_at: "2026-11-14T12:00:00.000Z", account_id: TEST_ID, isolated: true, ceiling_usd: 0.3 });
    expect(report.budget.enforceable).toBe(false);
    expect(report.scenarios.map((s) => s.id)).toEqual(["L1", "L2", "L3", "L4"]);
    expect(JSON.stringify(report)).not.toContain("@");
  });

  it("the agent console renders the panel (loading until its own request answers); the panel calls only /api/admin/acceptance", () => {
    expect(renderToStaticMarkup(createElement(AgentPage as any))).toContain('data-testid="acceptance-panel"');
    const src = readFileSync("src/components/admin/AcceptancePanel.tsx", "utf8");
    expect([...src.matchAll(/adminFetch[^(]*\("([^"]+)"/g)].map((m) => m[1])).toEqual(["/api/admin/acceptance", "/api/admin/acceptance"]);
    expect(src).not.toMatch(/localStorage|sessionStorage/);
  });
});
