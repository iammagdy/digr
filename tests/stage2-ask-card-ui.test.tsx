import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AskCard, askEditFromDraft } from "../src/components/mission/AskCard";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { askCardView } from "../src/lib/agentMission/stage2/askCard";
import * as TEXT from "../src/lib/agentMission/stage2/cardText";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";

/**
 * STAGE 2 S4 (docs/STAGE-2.md): THE «فهمنا طلبك» CARD UI. Its edit builder (pure), its markup, and the mission card showing it only when the server sent it (DIGER_STAGE2_ASK_CARD on for the
 * viewer) and only on the page that asked for the Stage 2 surfaces (the requests page). The request words are the stored request of M12 (msn_5851abc92a1e6645a9cd, replay-missions.json).
 */
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
const M12 = fixture.missions.find((m) => m.id === "msn_5851abc92a1e6645a9cd")!.request;
const view = askCardView(buildAsk(M12, null, Date.parse("2026-11-02T12:00:00Z")));
const field = (k: string) => view.fields.find((f) => f.key === k)!;

describe("the edit a draft makes (pure)", () => {
  it("a whole number inside the field's limits, Arabic-Indic digits too; outside the limits or not a number: nothing is sent", () => {
    expect(askEditFromDraft(field("count"), { text: "٣" })).toEqual({ field: "count", value: 3 });
    expect(askEditFromDraft(field("count"), { text: " 12 " })).toEqual({ field: "count", value: 12 });
    expect(askEditFromDraft(field("count"), { text: "0" })).toBeNull();
    expect(askEditFromDraft(field("count"), { text: "5001" })).toBeNull();
    expect(askEditFromDraft(field("count"), { text: "2.5" })).toBeNull();
    expect(askEditFromDraft(field("budget"), { text: "25000" })).toEqual({ field: "budget", value: 25_000 });
    expect(askEditFromDraft(field("budget"), { text: "25001" })).toBeNull();
  });
  it("a choice of the list («أي ...» clears the field); a value that is not in the list sends nothing", () => {
    expect(askEditFromDraft(field("order"), { choice: "newest" })).toEqual({ field: "order", value: "newest" });
    expect(askEditFromDraft(field("country"), { choice: "any" })).toEqual({ field: "country", value: null });
    expect(askEditFromDraft(field("language"), { choice: "en" })).toEqual({ field: "language", value: "en" });
    expect(askEditFromDraft(field("order"), { choice: "random" })).toBeNull();
  });
  it("a period of two days, or none; a short text; an empty source clears it; the platform never", () => {
    expect(askEditFromDraft(field("period"), { from: "2026-10-01", to: "2026-10-31" })).toEqual({ field: "period", value: { from: "2026-10-01", to: "2026-10-31" } });
    expect(askEditFromDraft(field("period"), { from: "2026-10-01" })).toBeNull();
    expect(askEditFromDraft(field("period"), { clear: true })).toEqual({ field: "period", value: null });
    expect(askEditFromDraft(field("topic"), { text: "  الروبوتات  " })).toEqual({ field: "topic", value: "الروبوتات" });
    expect(askEditFromDraft(field("topic"), { text: " " })).toBeNull();
    expect(askEditFromDraft(field("source"), { text: "" })).toEqual({ field: "source", value: null });
    expect(askEditFromDraft(field("platform"), { choice: "x" })).toBeNull();
  });
});

describe("the card's markup", () => {
  const html = renderToStaticMarkup(createElement(AskCard, { view }));
  it("the title, every field's label and value, an «تعديل» button on each editable field and none on the platform", () => {
    expect(html).toContain("فهمنا طلبك");
    for (const f of view.fields) expect(html).toContain(f.labelAr);
    expect(html).toContain("«الذكاء الاصطناعي»");
    expect(html).not.toContain('data-testid="ask-edit-platform"');
    for (const f of view.fields.filter((x) => x.editable)) expect(html).toContain(`data-testid="ask-edit-${f.key}"`);
    expect(html).toContain('dir="rtl"');
  });
  it("an edit that needs a new read says so in the editor (owner decision 3); a number edit does not", () => {
    const topic = renderToStaticMarkup(createElement(AskCard, { view, initialEditing: "topic" }));
    expect(topic).toContain(TEXT.ASK_EDIT_NEW_READ_AR);
    const count = renderToStaticMarkup(createElement(AskCard, { view, initialEditing: "count" }));
    expect(count).not.toContain(TEXT.ASK_EDIT_NEW_READ_AR);
    expect(count).toContain('inputMode="numeric"');
  });
  it("the period editor has two days and «بدون فترة»; a choice editor has its options", () => {
    const period = renderToStaticMarkup(createElement(AskCard, { view, initialEditing: "period" }));
    expect(period.match(/type="date"/g)).toHaveLength(2);
    expect(period).toContain(TEXT.ASK_CARD_NO_PERIOD_AR);
    const order = renderToStaticMarkup(createElement(AskCard, { view, initialEditing: "order" }));
    expect(order).toContain("الأحدث");
  });
  it("the server's refusal sentence is shown as an alert", () => {
    const err = renderToStaticMarkup(createElement(AskCard, { view, errorAr: "الرقم خارج الحدود المسموح بها لهذا الجزء من الطلب." }));
    expect(err).toContain('role="alert"');
  });
  it("every fixed word of the Stage 2 screens passes the customer-text rules", () => {
    for (const [k, t] of Object.entries(TEXT)) expect(checkCustomerText(t).issues, k).toEqual([]);
    for (const t of [TEXT.ASK_CARD_EDIT_AR, TEXT.ASK_CARD_SAVE_AR, TEXT.ASK_CARD_CANCEL_AR, TEXT.ASK_CARD_NO_PERIOD_AR]) expect(checkCustomerLabel(t).issues).toEqual([]);
  });
});

describe("the mission card shows it only when the server sent it", () => {
  const plan = customerMissionView({
    mission: { id: "m", status: "plan_ready", question_ar: null, reserved_points: 300, unit_price_points: 4.5, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-03T15:39:39Z",
      plan_public: { summary_ar: "فيديوهان من تيك توك.", assumptions_ar: [], notes_ar: [], stages: [{ key: "videos", title_ar: "الفيديوهات", endpoint_id: "e", expected_rows: 2, planned_rows: 2, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [] }], price: { max_charge_points: 250, reserve_points: 300 } } } as never,
    events: [], queue: { ahead: 0, running: 0, workerAlive: true }, now: Date.parse("2026-11-03T15:42:00Z"),
  });
  it("no askCard (the flag off: today): the card is exactly as before, with no «فهمنا طلبك»", () => {
    const today = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: plan, isGuest: false }));
    expect(today).not.toContain("ask-card");
    expect(renderToStaticMarkup(createElement(AgentMissionCardBody, { view: plan, isGuest: false, askCard: null }))).toBe(today);
  });
  it("with askCard, on a plan: the «فهمنا طلبك» card is in the mission card", () => {
    expect(renderToStaticMarkup(createElement(AgentMissionCardBody, { view: plan, isGuest: false, askCard: view }))).toContain('data-testid="ask-card"');
  });
  it("only the requests page asks for the Stage 2 surfaces; the chat page file is not touched", () => {
    expect(readFileSync("src/app/dashboard/requests/[id]/page.tsx", "utf8")).toContain("<AgentMissionCard missionId={missionId} stage2 />");
    expect(readFileSync("src/app/dashboard/chat/page.tsx", "utf8")).not.toContain("stage2");
  });
  it("the mission route sends askCard only while the plan waits and only when the flag is on for the viewer", () => {
    const route = readFileSync("src/app/api/missions/[id]/route.ts", "utf8");
    expect(route).toContain('const askCard = r.status === "plan_ready" && (await stage2FlagForMission(client, "DIGER_STAGE2_ASK_CARD", id)) ? await askCardForCustomer(client, { id, userId: auth.viewer.userId }) : null;');
  });
});
