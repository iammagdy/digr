import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { PLANNING_USUAL_TIME_AR } from "../src/lib/missionView";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * ROUND 21, item 2 (finding B): the waiting mission card's first visible text was «ولن يُخصم شيء قبل موافقتك.»: round 14 took the time out of «عادةً دقيقة أو اتنين، ولن يُخصم شيء قبل موافقتك» and left the tail, which starts with a conjunction.
 * The card must show its FIRST sentence whole.
 */
const T0 = Date.parse("2026-11-04T10:00:00Z");
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
const visible = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
const row = (status: string) => ({ id: "m1", status, question_ar: null, plan_public: null, reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-04T09:59:00Z" });
const card = (status: string) => html(createElement(AgentMissionCardBody, { view: customerMissionView({ mission: row(status) as never, events: [], queue: { ahead: 0, running: 0, workerAlive: true }, now: T0 }), isGuest: false }));

describe("the waiting and planning cards open with a whole sentence", () => {
  it("the sentence has its first clause: it does not start with a conjunction, says what is being done, and keeps the money promise", () => {
    expect(PLANNING_USUAL_TIME_AR.startsWith("و")).toBe(false);
    expect(PLANNING_USUAL_TIME_AR).toMatch(/^(نقرأ|نجهّز|نقوم)/);
    expect(PLANNING_USUAL_TIME_AR).toContain("ولن يُخصم شيء قبل موافقتك");
    expect(PLANNING_USUAL_TIME_AR).not.toMatch(/دقيقة|دقائق|ساعة|خلال|عادةً|ثانية|[0-9]/);
    expect(checkCustomerText(PLANNING_USUAL_TIME_AR, { maxChars: 400 }).issues).toEqual([]);
  });
  it.each(["queued", "planning"])("the %s card: its first visible text is that sentence, whole", (status) => {
    const markup = card(status);
    expect(markup).toContain('data-testid="agent-planning-usual"');
    const first = visible(markup);
    expect(first.startsWith(PLANNING_USUAL_TIME_AR) || first.includes(PLANNING_USUAL_TIME_AR)).toBe(true);
    expect(first.startsWith("ولن")).toBe(false);
    // no text of the card comes before the sentence except the card's own labels
    const before = first.slice(0, first.indexOf(PLANNING_USUAL_TIME_AR));
    expect(before).not.toMatch(/^\s*ولن/);
  });
});
